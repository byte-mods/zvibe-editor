import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NullEngine, Scene, TransformNode } from "@babylonjs/core";

import { connectDeviceLab, getDeviceLabClient } from "../../src/loading/device-lab";
import { beginPortableProfilerMarker } from "../../src/profiling/profiling";

class FakeWebSocket {
	public static readonly OPEN = 1;
	public static instances: FakeWebSocket[] = [];

	public readyState = 0;
	public sent: any[] = [];
	private _listeners = new Map<string, Array<(event: any) => void>>();

	public constructor(public readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	public addEventListener(type: string, listener: (event: any) => void): void {
		this._listeners.set(type, [...(this._listeners.get(type) ?? []), listener]);
	}

	public send(text: string): void {
		this.sent.push(JSON.parse(text));
	}

	public close(): void {
		this.readyState = 3;
		this.emit("close", {});
	}

	public emit(type: string, event: any): void {
		for (const listener of this._listeners.get(type) ?? []) {
			listener(event);
		}
	}

	public open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.emit("open", {});
	}

	public message(value: any): void {
		this.emit("message", { data: JSON.stringify(value) });
	}
}

describe("loading/device lab", () => {
	let scene: Scene;
	let originalWebSocket: typeof globalThis.WebSocket | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeWebSocket.instances = [];
		originalWebSocket = globalThis.WebSocket;
		(globalThis as any).WebSocket = FakeWebSocket;
		scene = new Scene(new NullEngine());
	});

	afterEach(() => {
		scene.dispose();
		(globalThis as any).WebSocket = originalWebSocket;
		vi.useRealTimers();
	});

	test("validates explicit pairing configuration", () => {
		expect(() => connectDeviceLab(scene, { url: "https://example.test", pairingToken: "x".repeat(43) })).toThrow("ws:// or wss://");
		expect(() => connectDeviceLab(scene, { url: "ws://127.0.0.1:9000", pairingToken: "short" })).toThrow("32-128");
		expect(() => connectDeviceLab(scene, { url: "ws://127.0.0.1:9000", pairingToken: "x".repeat(43), metricsIntervalMs: 10 })).toThrow("100 to 10000");
	});

	test("sends identity, bounded logs and metrics, handles commands, and restores on dispose", async () => {
		const originalWarn = console.warn;
		const client = connectDeviceLab(scene, { url: "ws://127.0.0.1:9000/lab", pairingToken: "a".repeat(43), name: "Runtime QA", metricsIntervalMs: 100 });
		const socket = FakeWebSocket.instances[0];
		expect(socket.url).not.toContain("token=<redacted>");
		expect(socket.url).toContain(`token=${"a".repeat(43)}`);
		socket.open();
		expect(socket.sent[0]).toMatchObject({ protocol: "zvibe-device-lab", version: 1, type: "hello", identity: { name: "Runtime QA" } });
		expect(socket.sent[0].capabilities).toEqual(["logs", "metrics", "screenshot", "pointer-input", "portable-tests", "portable-profiler"]);

		console.warn("device warning", { code: 9 });
		expect(socket.sent.at(-1)).toMatchObject({ type: "logs", entries: [expect.objectContaining({ level: "warn", arguments: ["device warning", { code: 9 }] })] });
		await vi.advanceTimersByTimeAsync(100);
		expect(socket.sent.some((message) => message.type === "metrics" && typeof message.sample.frameRate === "number")).toBe(true);

		socket.message({ protocol: "zvibe-device-lab", version: 1, type: "command", requestId: "shot-1", command: "screenshot" });
		await Promise.resolve();
		expect(socket.sent.at(-1)).toMatchObject({ type: "response", requestId: "shot-1", ok: false });

		const subject = new TransformNode("Remote Subject", scene);
		socket.message({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "command",
			requestId: "tests-1",
			command: "run-tests",
			runToken: "remote-tests-1",
			state: {
				version: 2,
				revision: 0,
				settings: { defaultTimeoutMs: 1000, playPreparationTimeoutMs: 1000, maximumRetainedRuns: 5 },
				suites: [
					{
						id: "remote-suite",
						name: "Remote suite",
						enabled: true,
						mode: "play",
						categories: [],
						beforeEach: [],
						afterEach: [],
						tests: [
							{
								id: "remote-case",
								name: "Remote case",
								enabled: true,
								kind: "scene",
								categories: [],
								repeat: 1,
								setup: [],
								steps: [],
								teardown: [],
								assertions: [{ type: "node-exists", nodeId: subject.id, exists: true }],
							},
						],
					},
				],
				runs: [],
			},
		});
		for (let index = 0; index < 20 && !socket.sent.some((message) => message.requestId === "tests-1"); index++) await Promise.resolve();
		expect(socket.sent.find((message) => message.requestId === "tests-1")).toMatchObject({
			type: "response",
			ok: true,
			result: { target: "connected-player", status: "passed", summary: { total: 1, passed: 1 } },
		});
		socket.message({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "command",
			requestId: "profile-start-1",
			command: "start-profiler",
			runToken: "remote-profile-1",
			options: { name: "Remote profile", maximumFrames: 1, maximumDurationMs: 10_000, modules: ["cpu", "rendering", "memory", "scripts"] },
		});
		for (let index = 0; index < 20 && !socket.sent.some((message) => message.requestId === "profile-start-1"); index++) await Promise.resolve();
		expect(socket.sent.find((message) => message.requestId === "profile-start-1")).toMatchObject({ type: "response", ok: true, result: { status: "recording" } });
		socket.message({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "command",
			requestId: "profile-memory-1",
			command: "capture-profiler-snapshot",
			runToken: "remote-profile-1",
			name: "Remote memory",
		});
		for (let index = 0; index < 20 && !socket.sent.some((message) => message.requestId === "profile-memory-1"); index++) await Promise.resolve();
		expect(socket.sent.find((message) => message.requestId === "profile-memory-1")).toMatchObject({
			type: "response",
			ok: true,
			result: { name: "Remote memory", captureId: "remote-profile-1" },
		});
		for (let index = 0; index < 6_000; index++) {
			beginPortableProfilerMarker(scene, `${index}-${"界".repeat(230)}`, "User").end();
		}
		scene.onAfterRenderObservable.notifyObservers(scene);
		socket.message({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "command",
			requestId: "profile-data-1",
			command: "get-profiler-data",
			runToken: "remote-profile-1",
			kind: "description",
		});
		for (let index = 0; index < 20 && !socket.sent.some((message) => message.requestId === "profile-data-1"); index++) await Promise.resolve();
		expect(socket.sent.find((message) => message.requestId === "profile-data-1")).toMatchObject({
			type: "response",
			ok: true,
			result: {
				description: { target: "connected-player", status: "completed", memorySnapshots: [], summary: { markers: [] } },
				totals: { frames: 1, markers: 6_000, memorySnapshots: 1 },
			},
		});
		expect(client.status()).toMatchObject({ connected: true, commandsHandled: 5, logsSent: 1, metricsSent: 1 });
		expect(client.status().url).toContain("token=<redacted>");
		expect(getDeviceLabClient(scene)).toBe(client);
		const retainedTokens = ["remote-profile-1"];
		for (let index = 1; index < 8; index++) {
			const runToken = `remote-retained-${index}`;
			retainedTokens.push(runToken);
			socket.message({
				protocol: "zvibe-device-lab",
				version: 1,
				type: "command",
				requestId: `profile-retained-${index}`,
				command: "start-profiler",
				runToken,
				options: { name: `Retained ${index}`, maximumFrames: 1, maximumDurationMs: 10_000, modules: ["cpu"] },
			});
			for (let wait = 0; wait < 20 && !socket.sent.some((message) => message.requestId === `profile-retained-${index}`); wait++) await Promise.resolve();
			scene.onAfterRenderObservable.notifyObservers(scene);
		}
		socket.message({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "command",
			requestId: "profile-over-limit",
			command: "start-profiler",
			runToken: "remote-over-limit",
			options: { name: "Over limit", maximumFrames: 1, maximumDurationMs: 10_000, modules: ["cpu"] },
		});
		for (let wait = 0; wait < 20 && !socket.sent.some((message) => message.requestId === "profile-over-limit"); wait++) await Promise.resolve();
		expect(socket.sent.find((message) => message.requestId === "profile-over-limit")).toMatchObject({ ok: false, error: expect.stringContaining("eight-session") });
		for (const [index, runToken] of retainedTokens.entries()) {
			socket.message({
				protocol: "zvibe-device-lab",
				version: 1,
				type: "command",
				requestId: `profile-release-${index}`,
				command: "release-profiler",
				runToken,
			});
			for (let wait = 0; wait < 20 && !socket.sent.some((message) => message.requestId === `profile-release-${index}`); wait++) await Promise.resolve();
			expect(socket.sent.find((message) => message.requestId === `profile-release-${index}`)).toMatchObject({ ok: true, result: { released: true, runToken } });
		}
		socket.message({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "command",
			requestId: "profile-release-idempotent",
			command: "release-profiler",
			runToken: retainedTokens[0],
		});
		for (let wait = 0; wait < 20 && !socket.sent.some((message) => message.requestId === "profile-release-idempotent"); wait++) await Promise.resolve();
		expect(socket.sent.find((message) => message.requestId === "profile-release-idempotent")).toMatchObject({ ok: true, result: { released: true } });

		socket.message({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "command",
			requestId: "profile-start-disconnect",
			command: "start-profiler",
			runToken: "remote-profile-disconnect",
			options: { name: "Disconnect profile", maximumFrames: 10, maximumDurationMs: 10_000, modules: ["cpu"] },
		});
		for (let index = 0; index < 20 && !socket.sent.some((message) => message.requestId === "profile-start-disconnect"); index++) await Promise.resolve();
		socket.close();
		await vi.advanceTimersByTimeAsync(500);
		const reconnected = FakeWebSocket.instances.at(-1)!;
		reconnected.open();
		reconnected.message({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "command",
			requestId: "profile-status-disconnect",
			command: "profiler-status",
			runToken: "remote-profile-disconnect",
		});
		for (let index = 0; index < 20 && !reconnected.sent.some((message) => message.requestId === "profile-status-disconnect"); index++) await Promise.resolve();
		expect(reconnected.sent.find((message) => message.requestId === "profile-status-disconnect")).toMatchObject({
			type: "response",
			ok: false,
			error: expect.stringContaining("not found"),
		});
		const postDisconnectTokens: string[] = [];
		for (let index = 0; index < 8; index++) {
			const runToken = `post-disconnect-${index}`;
			postDisconnectTokens.push(runToken);
			reconnected.message({
				protocol: "zvibe-device-lab",
				version: 1,
				type: "command",
				requestId: `post-disconnect-start-${index}`,
				command: "start-profiler",
				runToken,
				options: { name: `Post disconnect ${index}`, maximumFrames: 1, maximumDurationMs: 10_000, modules: ["cpu"] },
			});
			for (let wait = 0; wait < 20 && !reconnected.sent.some((message) => message.requestId === `post-disconnect-start-${index}`); wait++) await Promise.resolve();
			expect(reconnected.sent.find((message) => message.requestId === `post-disconnect-start-${index}`)).toMatchObject({ ok: true });
			scene.onAfterRenderObservable.notifyObservers(scene);
		}
		for (const [index, runToken] of postDisconnectTokens.entries()) {
			reconnected.message({
				protocol: "zvibe-device-lab",
				version: 1,
				type: "command",
				requestId: `post-disconnect-release-${index}`,
				command: "release-profiler",
				runToken,
			});
			for (let wait = 0; wait < 20 && !reconnected.sent.some((message) => message.requestId === `post-disconnect-release-${index}`); wait++) await Promise.resolve();
		}

		scene.dispose();
		expect(client.status().connected).toBe(false);
		expect(getDeviceLabClient(scene)).toBeNull();
		expect(console.warn).toBe(originalWarn);
	});
});
