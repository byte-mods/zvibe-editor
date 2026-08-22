import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NullEngine, Scene } from "babylonjs";
import WebSocket from "ws";

import {
	captureRemoteDeviceScreenshot,
	captureRemoteDeviceProfilerSnapshot,
	clearRemoteDeviceData,
	disconnectRemoteDevice,
	getDeviceLabStatus,
	getDeviceToolingCapabilities,
	getRemoteDeviceLogs,
	getRemoteDeviceMetrics,
	getRemoteDeviceProfilerData,
	getRemoteDeviceProfilerStatus,
	listRemoteDevices,
	releaseRemoteDeviceProfiler,
	reserveRemoteDeviceProfiler,
	sendRemoteDeviceInput,
	shutdownDeviceLab,
	startDeviceLab,
	startRemoteDeviceProfiler,
	stopDeviceLab,
	stopRemoteDeviceProfiler,
} from "../../src/mcp/device/device-lab";
import { getEditorCapabilities, getProfilerState, startProfilerCapture, stopProfilerCapture } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for Device Lab state.");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("mcp/device lab", () => {
	let scene: Scene;
	const forceUpdate = (): void => undefined;
	const profilerForceUpdate = vi.fn();
	const options = {
		editor: {
			state: { projectPath: "/tmp/project.bjseditor", enableExperimentalFeatures: false },
			layout: { inspector: { forceUpdate }, profiler: { forceUpdate: profilerForceUpdate } },
		},
	} as any;

	beforeEach(() => {
		profilerForceUpdate.mockClear();
		scene = new Scene(new NullEngine());
	});

	afterEach(async () => {
		await shutdownDeviceLab();
		scene.dispose();
	});

	test("publishes honest boundaries and every editor endpoint", () => {
		expect(getDeviceToolingCapabilities()).toMatchObject({
			version: 1,
			simulator: { simulatedClasses: ["Application", "Screen", "SystemInfo"] },
			remotePlayer: { transport: "authenticated-outbound-websocket-v1", capabilities: expect.arrayContaining(["paged portable profiler captures"]) },
		});
		expect(getEditorCapabilities(scene, {}, options).features).toMatchObject({ remoteDeviceLab: true, remoteDeviceLogs: true, remoteDeviceMetrics: true });
		for (const endpoint of [
			"get_device_tooling_capabilities",
			"list_device_simulator_profiles",
			"set_device_simulator_profile",
			"delete_device_simulator_profile",
			"activate_device_simulator_profile",
			"start_device_lab",
			"stop_device_lab",
			"get_device_lab_status",
			"list_remote_devices",
			"get_remote_device_logs",
			"get_remote_device_metrics",
			"capture_remote_device_screenshot",
			"send_remote_device_input",
			"disconnect_remote_device",
			"clear_remote_device_data",
			"get_profiler_capabilities",
			"get_profiler_state",
			"get_profiler_run_status",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
	});

	test("authenticates one player and relays bounded evidence and acknowledged commands", async () => {
		const started = await startDeviceLab(scene, { endpoint: "start_device_lab", port: 0, pairingMinutes: 1 }, options);
		expect(started).toMatchObject({ listening: true, security: { loopbackOnly: true, tokenPersisted: false, tls: false } });
		expect(started.pairing.pairingToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
		expect(getDeviceLabStatus()).toMatchObject({ state: "listening", pairingTokenAvailable: true, connectionCount: 0 });
		await waitFor(() => profilerForceUpdate.mock.calls.length > 0);
		profilerForceUpdate.mockClear();

		const rejected = new WebSocket(`${started.pairing.wsUrl}?token=${"x".repeat(43)}`);
		await once(rejected, "open");
		const [rejectedCode] = (await once(rejected, "close")) as [number, Buffer];
		expect(rejectedCode).toBe(4401);

		const player = new WebSocket(`${started.pairing.wsUrl}?token=${started.pairing.pairingToken}`);
		await once(player, "open");
		player.send(
			JSON.stringify({
				protocol: "zvibe-device-lab",
				version: 1,
				type: "hello",
				identity: { deviceId: "qa-device-1", name: "QA Phone", platform: "test" },
				capabilities: ["logs", "metrics", "screenshot", "pointer-input", "portable-profiler"],
			})
		);
		await once(player, "message");
		await waitFor(() => listRemoteDevices().devices.length === 1);
		await waitFor(() => profilerForceUpdate.mock.calls.length > 0);
		const connectionId = listRemoteDevices().devices[0].connectionId;

		player.send(
			JSON.stringify({
				protocol: "zvibe-device-lab",
				version: 1,
				type: "logs",
				entries: [{ capturedAt: new Date().toISOString(), level: "warn", arguments: ["remote warning", { code: 7 }] }],
			})
		);
		player.send(JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "metrics", sample: { frameRate: 58, frameTimeMs: 17.2, drawCalls: 42 } }));
		await waitFor(() => listRemoteDevices().devices[0]?.metricCount === 1);
		expect(getRemoteDeviceLogs(scene, { connectionId, levels: ["warn"], query: "warning" })).toMatchObject({ total: 1, entries: [expect.objectContaining({ level: "warn" })] });
		expect(getRemoteDeviceMetrics(scene, { connectionId })).toMatchObject({ total: 1, summary: { frameRate: { min: 58, max: 58, average: 58 } } });

		let terminalProfilerStatus = false;
		let invalidProfilerStatus = false;
		let invalidProfilerTimestamp = false;
		let reversedProfilerTimestamps = false;
		player.on("message", (bytes) => {
			const message = JSON.parse(bytes.toString());
			if (message.type !== "command") {
				return;
			}
			const result =
				message.command === "screenshot"
					? { dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 1, height: 1 }
					: message.command === "start-profiler"
						? { runToken: message.runToken, status: "recording" }
						: message.command === "profiler-status"
							? {
									runToken: message.runToken,
									status: terminalProfilerStatus ? "completed" : "recording",
									startedAt: invalidProfilerTimestamp ? "not-a-date" : reversedProfilerTimestamps ? "2026-01-02T00:00:00.000Z" : new Date().toISOString(),
									finishedAt: terminalProfilerStatus ? (reversedProfilerTimestamps ? "2026-01-01T00:00:00.000Z" : new Date().toISOString()) : null,
									failure: null,
									frameCount: 1,
									markerCount: 0,
									assetEventCount: 0,
									summary: {
										frames: terminalProfilerStatus ? 1 : 0,
										durationMs: 16,
										metrics: {
											"cpu.frameTimeMs": invalidProfilerStatus
												? { minimum: 17, maximum: 16, average: 18, median: 16, p95: 15, latest: 20, samples: 2 }
												: { minimum: 16, maximum: 16, average: 16, median: 16, p95: 16, latest: 16, samples: 1 },
										},
										markers: [],
										assetRequests: 0,
										assetTransferBytes: null,
									},
								}
							: message.command === "capture-profiler-snapshot"
								? {
										id: "memory-1",
										name: message.name,
										capturedAt: new Date().toISOString(),
										captureId: message.runToken,
										frameIndex: 0,
										metrics: {
											usedHeapBytes: null,
											totalHeapBytes: null,
											heapLimitBytes: null,
											estimatedGeometryBytes: 0,
											estimatedTextureBytes: 0,
											estimatedSceneBytes: 0,
											sceneObjectCount: 0,
											gcEvents: null,
											gcDurationMs: null,
										},
										counts: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`count${index}`, index])),
										limitations: Array.from({ length: 40 }, (_, index) => `Limitation ${index}`),
									}
								: message.command === "get-profiler-data"
									? { description: { id: message.runToken, status: "completed" }, totals: { frames: 1, markers: 0, assetEvents: 0 } }
									: message.command === "stop-profiler"
										? { runToken: message.runToken, status: "completed", frameCount: 1 }
										: message.command === "release-profiler"
											? { runToken: message.runToken, released: true }
											: { action: message.action, x: message.x, y: message.y };
			player.send(JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "response", requestId: message.requestId, ok: true, result }));
		});
		expect(await captureRemoteDeviceScreenshot(scene, { connectionId, timeoutMs: 1_000 })).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
		expect(await sendRemoteDeviceInput(scene, { connectionId, action: "down", x: 0.25, y: 0.75, timeoutMs: 1_000, confirm: true })).toMatchObject({
			sent: true,
			acknowledged: true,
			result: { action: "down", x: 0.25, y: 0.75 },
		});
		expect(
			await startRemoteDeviceProfiler(scene, {
				connectionId,
				runToken: "remote-profile-1",
				options: { name: "Remote", maximumFrames: 1, maximumDurationMs: 1_000 },
				confirm: true,
			})
		).toMatchObject({ status: "recording" });
		const releaseProfilerReservation = reserveRemoteDeviceProfiler(connectionId, "remote-profile-1");
		expect(() => disconnectRemoteDevice(scene, { connectionId, confirm: true })).toThrow("Stop or cancel");
		await expect(stopDeviceLab(scene, { confirm: true })).rejects.toThrow("profiler capture");
		const snapshot = await captureRemoteDeviceProfilerSnapshot(scene, { connectionId, runToken: "remote-profile-1", name: "Remote memory", confirm: true });
		expect(snapshot).toMatchObject({
			name: "Remote memory",
		});
		expect(Object.keys(snapshot.counts)).toHaveLength(40);
		expect(snapshot.limitations).toHaveLength(40);
		expect(await getRemoteDeviceProfilerStatus(scene, { connectionId, runToken: "remote-profile-1" })).toMatchObject({
			status: "recording",
			frameCount: 1,
			summary: { frames: 0 },
		});
		terminalProfilerStatus = true;
		expect(await getRemoteDeviceProfilerStatus(scene, { connectionId, runToken: "remote-profile-1" })).toMatchObject({
			status: "completed",
			frameCount: 1,
			summary: { metrics: { "cpu.frameTimeMs": { average: 16, samples: 1 } } },
		});
		invalidProfilerStatus = true;
		await expect(getRemoteDeviceProfilerStatus(scene, { connectionId, runToken: "remote-profile-1" })).rejects.toThrow("invalid profiler status evidence");
		invalidProfilerStatus = false;
		invalidProfilerTimestamp = true;
		await expect(getRemoteDeviceProfilerStatus(scene, { connectionId, runToken: "remote-profile-1" })).rejects.toThrow("invalid profiler status evidence");
		invalidProfilerTimestamp = false;
		reversedProfilerTimestamps = true;
		await expect(getRemoteDeviceProfilerStatus(scene, { connectionId, runToken: "remote-profile-1" })).rejects.toThrow("invalid profiler status evidence");
		reversedProfilerTimestamps = false;
		expect(await stopRemoteDeviceProfiler(scene, { connectionId, runToken: "remote-profile-1", confirm: true })).toMatchObject({ status: "completed" });
		expect(await getRemoteDeviceProfilerData(scene, { connectionId, runToken: "remote-profile-1", kind: "description" })).toMatchObject({ totals: { frames: 1 } });
		expect(await releaseRemoteDeviceProfiler(scene, { connectionId, runToken: "remote-profile-1", confirm: true })).toMatchObject({ released: true });
		releaseProfilerReservation();
		expect(() => clearRemoteDeviceData(scene, { connectionId })).toThrow("confirm=true");
		expect(clearRemoteDeviceData(scene, { connectionId, confirm: true })).toMatchObject({ removed: { logs: 1, metrics: 1, screenshot: true } });
		expect(disconnectRemoteDevice(scene, { connectionId, confirm: true })).toMatchObject({ disconnected: true });
		await once(player, "close");
		expect(await stopDeviceLab(scene, { confirm: true })).toMatchObject({ stopped: true, state: "stopped", pairingTokenAvailable: false });
	});

	test("requires confirmation for network exposure, input, disconnection, and stop", async () => {
		await expect(startDeviceLab(scene, { host: "0.0.0.0", advertisedHost: "192.0.2.1" }, options)).rejects.toThrow("confirm=true");
		const started = await startDeviceLab(scene, {}, options);
		await expect(stopDeviceLab(scene, {})).rejects.toThrow("confirm=true");
		expect(started.pairing.queryParameters).toHaveProperty("zvibePairingToken");
		expect(getDeviceLabStatus().pairingToken).toBeUndefined();
	});

	test.each(["disconnect", "scene-dispose"] as const)("releases an active connected profiler reservation on %s", async (mode) => {
		const started = await startDeviceLab(scene, { endpoint: "start_device_lab", port: 0, pairingMinutes: 1 }, options);
		const player = new WebSocket(`${started.pairing.wsUrl}?token=${started.pairing.pairingToken}`);
		await once(player, "open");
		player.send(
			JSON.stringify({
				protocol: "zvibe-device-lab",
				version: 1,
				type: "hello",
				identity: { deviceId: `cleanup-${mode}`, name: "Cleanup Player", platform: "test" },
				capabilities: ["portable-profiler"],
			})
		);
		await once(player, "message");
		await waitFor(() => listRemoteDevices().devices.length === 1);
		const connectionId = listRemoteDevices().devices[0].connectionId;
		player.on("message", (bytes) => {
			const message = JSON.parse(bytes.toString());
			if (message.type !== "command") {
				return;
			}
			const result = message.command === "start-profiler" ? { runToken: message.runToken, status: "recording" } : { runToken: message.runToken, released: true };
			player.send(JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "response", requestId: message.requestId, ok: true, result }));
		});
		const initial = getProfilerState(scene);
		await startProfilerCapture(
			scene,
			{
				expectedRevision: initial.revision,
				id: `cleanup-${mode}`,
				name: "Cleanup",
				target: "connected-player",
				connectionId,
				maximumFrames: 1,
				maximumDurationMs: 1_000,
				confirm: true,
			},
			options
		);
		expect(getDeviceLabStatus().profilerReservationCount).toBe(1);
		if (mode === "disconnect") {
			player.close();
			await once(player, "close");
		} else {
			scene.dispose();
		}
		await waitFor(() => getDeviceLabStatus().profilerReservationCount === 0 && getProfilerState(scene).active === null);
		await expect(stopDeviceLab(scene, { confirm: true })).resolves.toMatchObject({ stopped: true });
	});

	test("keeps distinct scene captures owner-isolated when display ids would sanitize identically", async () => {
		const secondEngine = new NullEngine();
		const secondScene = new Scene(secondEngine);
		const started = await startDeviceLab(scene, { endpoint: "start_device_lab", port: 0, pairingMinutes: 1 }, options);
		const player = new WebSocket(`${started.pairing.wsUrl}?token=${started.pairing.pairingToken}`);
		const commands: any[] = [];
		try {
			await once(player, "open");
			player.send(
				JSON.stringify({
					protocol: "zvibe-device-lab",
					version: 1,
					type: "hello",
					identity: { deviceId: "ownership-player", name: "Ownership Player", platform: "test" },
					capabilities: ["portable-profiler"],
				})
			);
			await once(player, "message");
			await waitFor(() => listRemoteDevices().devices.length === 1);
			const connectionId = listRemoteDevices().devices[0].connectionId;
			player.on("message", (bytes) => {
				const message = JSON.parse(bytes.toString());
				if (message.type !== "command") {
					return;
				}
				commands.push(message);
				const result =
					message.command === "start-profiler"
						? { runToken: message.runToken, status: "recording" }
						: message.command === "cancel-profiler"
							? { runToken: message.runToken, status: "canceled", frameCount: 0 }
							: { runToken: message.runToken, released: true };
				player.send(JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "response", requestId: message.requestId, ok: true, result }));
			});

			const first = await startProfilerCapture(
				scene,
				{
					expectedRevision: getProfilerState(scene).revision,
					id: "é",
					name: "First",
					target: "connected-player",
					connectionId,
					maximumFrames: 1,
					maximumDurationMs: 1_000,
					confirm: true,
				},
				options
			);
			const second = await startProfilerCapture(
				secondScene,
				{
					expectedRevision: getProfilerState(secondScene).revision,
					id: "ø",
					name: "Second",
					target: "connected-player",
					connectionId,
					maximumFrames: 1,
					maximumDurationMs: 1_000,
					confirm: true,
				},
				options
			);
			const startTokens = commands.filter((command) => command.command === "start-profiler").map((command) => command.runToken);
			expect(new Set(startTokens).size).toBe(2);
			expect(commands.filter((command) => command.command === "cancel-profiler")).toHaveLength(0);
			expect(getDeviceLabStatus().profilerReservationCount).toBe(2);
			expect(getProfilerState(scene).active?.id).toBe(first.active.id);
			expect(getProfilerState(secondScene).active?.id).toBe(second.active.id);

			await stopProfilerCapture(scene, { expectedRevision: first.revision, id: first.active.id, cancel: true, confirm: true }, options);
			await stopProfilerCapture(secondScene, { expectedRevision: second.revision, id: second.active.id, cancel: true, confirm: true }, options);
			expect(commands.filter((command) => command.command === "cancel-profiler")).toHaveLength(2);
			expect(getDeviceLabStatus().profilerReservationCount).toBe(0);
		} finally {
			player.close();
			if (player.readyState !== WebSocket.CLOSED) {
				await once(player, "close");
			}
			await waitFor(() => getDeviceLabStatus().profilerReservationCount === 0);
			secondScene.dispose();
			secondEngine.dispose();
		}
	});
});
