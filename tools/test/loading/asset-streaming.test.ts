import { afterEach, describe, expect, test, vi } from "vitest";

import { AssetStreamingRuntime, getAssetStreamingBuildPlan, normalizeAssetStreamingSettings, rewriteAssetUrlForStreaming } from "../../src/loading/asset-streaming";

function settings(overrides: Record<string, unknown> = {}): unknown {
	return { windows: { enableDirectStorage: true, maximumConcurrentReads: 1, requestTimeoutMs: 10_000, ...overrides } };
}

function bytesStream(...chunks: number[][]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
			controller.close();
		},
	});
}

async function consume(stream: ReadableStream<Uint8Array>): Promise<number[]> {
	const result: number[] = [];
	for await (const chunk of stream) result.push(...chunk);
	return result;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("asset streaming settings and runtime", () => {
	test("keeps Direct Storage disabled by default and rejects unknown settings", () => {
		expect(normalizeAssetStreamingSettings({})).toMatchObject({
			version: 1,
			windows: { enableDirectStorage: false, maximumConcurrentReads: 8, maximumQueuedRequests: 4_096, chunkSizeBytes: 262_144 },
		});
		expect(() => normalizeAssetStreamingSettings({ windows: { enabled: true } })).toThrow("unsupported fields: enabled");
	});

	test("enables only the Windows portable fallback and preserves the native boundary", () => {
		expect(getAssetStreamingBuildPlan(settings(), "win32")).toMatchObject({
			requested: true,
			enabled: true,
			backend: "electron-asynchronous-file-streams",
			directStorage: { nativeAdapterAvailable: false, nativeBackendUsed: false, portableFallbackUsed: true },
		});
		expect(getAssetStreamingBuildPlan(settings(), "darwin")).toMatchObject({
			requested: true,
			enabled: false,
			backend: "disabled",
			warnings: [expect.stringContaining("Windows")],
		});
	});

	test("rewrites only packaged file URLs below the document root", () => {
		const plan = getAssetStreamingBuildPlan(settings(), "win32");
		expect(rewriteAssetUrlForStreaming("./scene/level.babylon?quality=high", "file:///game/dist/index.html", plan)).toBe(
			"zvibe-asset://local/scene/level.babylon?quality=high"
		);
		expect(rewriteAssetUrlForStreaming("../package.json", "file:///game/dist/index.html", plan)).toBe("../package.json");
		expect(rewriteAssetUrlForStreaming("https://cdn.example.test/level.bin", "file:///game/dist/index.html", plan)).toBe("https://cdn.example.test/level.bin");
	});

	test("holds concurrency slots until consumption and starts queued requests by priority", async () => {
		const runtime = new AssetStreamingRuntime(settings(), "win32");
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
		const starts: string[] = [];
		const opener = async (request: Readonly<{ key: string }>) => {
			starts.push(request.key);
			if (request.key === "first") await firstGate;
			return { stream: bytesStream([request.key.length]), sizeBytes: 1 };
		};
		const first = runtime.enqueue({ key: "first", url: "first", priority: "low" }, opener);
		const background = runtime.enqueue({ key: "background", url: "background", priority: "background" }, opener);
		const critical = runtime.enqueue({ key: "critical", url: "critical", priority: "critical" }, opener);
		expect(starts).toEqual(["first"]);
		releaseFirst?.();
		expect(await consume((await first.response).stream)).toEqual([5]);
		expect(await consume((await critical.response).stream)).toEqual([8]);
		expect(await consume((await background.response).stream)).toEqual([10]);
		expect(starts).toEqual(["first", "critical", "background"]);
		expect(runtime.snapshot().totals).toMatchObject({ queued: 3, started: 3, completed: 3, bytesRead: 3, chunkCount: 3 });
		runtime.dispose();
	});

	test("cancels queued work without disturbing the active stream", async () => {
		const runtime = new AssetStreamingRuntime(settings(), "win32");
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const opener = async (request: Readonly<{ key: string }>) => {
			if (request.key === "active") await gate;
			return { stream: bytesStream([1]), sizeBytes: 1 };
		};
		const active = runtime.enqueue({ key: "active", url: "active" }, opener);
		const queued = runtime.enqueue({ key: "queued", url: "queued" }, opener);
		expect(runtime.cancel(queued.requestId).totals.cancelled).toBe(1);
		await expect(queued.response).rejects.toThrow("cancelled explicitly");
		release?.();
		expect(await consume((await active.response).stream)).toEqual([1]);
		runtime.dispose();
	});

	test("cancels active work through AbortSignal and rejects queue overflow synchronously", async () => {
		const runtime = new AssetStreamingRuntime(settings({ maximumQueuedRequests: 1 }), "win32");
		const controller = new AbortController();
		const active = runtime.enqueue(
			{ key: "active", url: "active", signal: controller.signal },
			async (_request, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				})
		);
		const activeExpectation = expect(active.response).rejects.toThrow("cancelled by its caller");
		const queued = runtime.enqueue({ key: "queued", url: "queued" }, async () => ({ stream: bytesStream([1]), sizeBytes: 1 }));
		expect(() => runtime.enqueue({ key: "overflow", url: "overflow" }, async () => ({ stream: bytesStream([1]), sizeBytes: 1 }))).toThrow("queue is full");
		controller.abort();
		await activeExpectation;
		expect(await consume((await queued.response).stream)).toEqual([1]);
		expect(runtime.snapshot().totals).toMatchObject({ cancelled: 1, completed: 1 });
		runtime.dispose();
	});

	test("times out an opener and rejects a source that exceeds its declared bytes", async () => {
		vi.useFakeTimers();
		const runtime = new AssetStreamingRuntime(settings({ requestTimeoutMs: 1_000 }), "win32");
		const timed = runtime.enqueue({ key: "slow", url: "slow" }, async () => new Promise(() => undefined));
		const timedExpectation = expect(timed.response).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(1_001);
		await timedExpectation;
		expect(runtime.snapshot().totals.timedOut).toBe(1);
		runtime.dispose();

		vi.useRealTimers();
		const bounded = new AssetStreamingRuntime(settings(), "win32");
		const overflowing = bounded.enqueue({ key: "overflow", url: "overflow" }, async () => ({ stream: bytesStream([1, 2]), sizeBytes: 1 }));
		await expect(consume((await overflowing.response).stream)).rejects.toThrow("more bytes");
		expect(bounded.snapshot().totals.failed).toBe(1);
		bounded.dispose();
	});
});
