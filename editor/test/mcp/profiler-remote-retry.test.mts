import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NullEngine, Scene } from "babylonjs";
import { beginPortableProfilerMarker, startPortableProfilerCapture } from "babylonjs-editor-tools";

const remote = vi.hoisted(() => ({
	runToken: "",
	options: null as any,
	capture: null as any,
	failNextFramePage: true,
	requests: [] as string[],
	releaseReservation: vi.fn(),
	reserve: vi.fn(),
	start: vi.fn(),
	stop: vi.fn(),
	release: vi.fn(),
	getData: vi.fn(),
}));

vi.mock("../../src/mcp/device/device-lab", () => ({
	captureRemoteDeviceProfilerSnapshot: vi.fn(),
	getRemoteDeviceProfilerStatus: vi.fn(),
	reserveRemoteDeviceProfiler: remote.reserve,
	startRemoteDeviceProfiler: remote.start,
	stopRemoteDeviceProfiler: remote.stop,
	releaseRemoteDeviceProfiler: remote.release,
	getRemoteDeviceProfilerData: remote.getData,
}));

import { getProfilerState, startProfilerCapture, stopProfilerCapture } from "../../src/mcp/profiling/runner";

describe("mcp/connected profiler retry", () => {
	let engine: NullEngine;
	let scene: Scene;
	let fixtureEngine: NullEngine;
	let fixtureScene: Scene;
	const forceUpdate = vi.fn();
	const options = { editor: { layout: { profiler: { forceUpdate }, inspector: { forceUpdate } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		fixtureEngine = new NullEngine();
		fixtureScene = new Scene(fixtureEngine);
		remote.runToken = "";
		remote.options = null;
		remote.capture = null;
		remote.failNextFramePage = true;
		remote.requests.length = 0;
		remote.releaseReservation.mockReset();
		remote.reserve.mockReset().mockImplementation(() => remote.releaseReservation);
		remote.start.mockReset().mockImplementation(async (_scene: Scene, data: any) => {
			remote.runToken = data.runToken;
			remote.options = data.options;
			return { runToken: data.runToken, status: "recording" };
		});
		remote.stop.mockReset().mockImplementation(async (_scene: Scene, data: any) => ({ runToken: data.runToken, status: "completed", frameCount: 1 }));
		remote.release.mockReset().mockImplementation(async (_scene: Scene, data: any) => ({ runToken: data.runToken, released: true }));
		remote.getData.mockReset().mockImplementation(async (_scene: Scene, data: any) => {
			remote.requests.push(data.kind);
			const capture = remote.capture;
			if (data.kind === "description") {
				const { frames, markers, assetEvents, ...description } = capture;
				return {
					description: { ...description, summary: { ...description.summary, markers: [] } },
					totals: { frames: frames.length, markers: markers.length, assetEvents: assetEvents.length, memorySnapshots: description.memorySnapshots.length },
				};
			}
			if (data.kind === "frames" && remote.failNextFramePage) {
				remote.failNextFramePage = false;
				throw new Error("transient frame page failure");
			}
			const entries =
				data.kind === "frames" ? capture.frames : data.kind === "markers" ? capture.markers : data.kind === "asset-events" ? capture.assetEvents : capture.memorySnapshots;
			return { total: entries.length, offset: data.offset, limit: data.limit, entries: entries.slice(data.offset, data.offset + data.limit) };
		});
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
		fixtureScene.dispose();
		fixtureEngine.dispose();
	});

	test("does not leave orphan paging chains after a failed evidence kind", async () => {
		const initial = getProfilerState(scene);
		const started = await startProfilerCapture(
			scene,
			{
				expectedRevision: initial.revision,
				id: "remote-retry",
				name: "Remote retry",
				target: "connected-player",
				connectionId: "device-1",
				modules: ["cpu", "scripts"],
				maximumFrames: 1,
				maximumDurationMs: 1_000,
				confirm: true,
			},
			options
		);
		const fixture = startPortableProfilerCapture(fixtureScene, remote.options);
		for (let index = 0; index < 400; index++) {
			beginPortableProfilerMarker(fixtureScene, `Marker ${index}`, "User").end();
		}
		fixtureScene.onAfterRenderObservable.notifyObservers(fixtureScene);
		remote.capture = fixture.capture;

		await expect(stopProfilerCapture(scene, { expectedRevision: started.revision, id: started.active.id, confirm: true }, options)).rejects.toThrow(
			"transient frame page failure"
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(remote.requests.filter((kind) => kind === "markers")).toHaveLength(0);

		await expect(stopProfilerCapture(scene, { expectedRevision: started.revision, id: started.active.id, confirm: true }, options)).resolves.toMatchObject({
			active: null,
			capture: { id: "remote-retry", markerCount: 400 },
		});
		expect(remote.requests.filter((kind) => kind === "markers")).toHaveLength(2);
		expect(remote.stop).toHaveBeenCalledTimes(1);
		expect(remote.release).toHaveBeenCalledTimes(1);
		expect(remote.releaseReservation).toHaveBeenCalledTimes(1);
	});
});
