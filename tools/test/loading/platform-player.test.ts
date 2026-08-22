import { afterEach, describe, expect, test, vi } from "vitest";

import { getLinuxImeEnvironment, getPlatformPlayerBuildPlan, normalizePlatformPlayerSettings, PlatformPlayerRuntime } from "../../src/loading/platform-player";

function fakeFrames(timestamps: number[]): (callback: FrameRequestCallback) => number {
	let index = 0;
	return (callback): number => {
		const handle = index + 1;
		const timestamp = timestamps[index++];
		queueMicrotask(() => callback(timestamp));
		return handle;
	};
}

afterEach(() => {
	delete (globalThis as any).zvibeMetalDisplayLink;
	vi.restoreAllMocks();
});

describe("loading/platform-player", () => {
	test("normalizes stable version-1 defaults", () => {
		expect(normalizePlatformPlayerSettings()).toEqual({
			version: 1,
			linux: { variant: "desktop", lto: "thin", ime: "ibus" },
			macos: { useDisplayLink: false, maximumQueuedFrames: 2 },
		});
	});

	test("strictly rejects unknown fields, invalid queue depth, and desktop-only FCITX5 on Embedded Linux", () => {
		expect(() => normalizePlatformPlayerSettings({ unexpected: true })).toThrow("unsupported fields");
		expect(() => normalizePlatformPlayerSettings({ macos: { maximumQueuedFrames: 4 } })).toThrow("integer from 1 through 3");
		expect(() => normalizePlatformPlayerSettings({ linux: { variant: "embedded", ime: "fcitx5" } })).toThrow("desktop-only");
	});

	test("creates honest Thin and Full LTO plans only for project-native Linux dependencies", () => {
		const thin = getPlatformPlayerBuildPlan({}, "linux");
		expect(thin).toMatchObject({
			lto: { enabled: true, mode: "thin", compilerFlags: ["-flto=thin"], linkerFlags: ["-flto=thin"], scope: "project-native-dependencies" },
			ime: { enabled: true, mode: "ibus" },
		});
		const full = getPlatformPlayerBuildPlan({ linux: { lto: "full", ime: "disabled" } }, "linux");
		expect(full).toMatchObject({ lto: { mode: "full", compilerFlags: ["-flto=full"] }, ime: { enabled: false, environment: {} } });
		expect(getPlatformPlayerBuildPlan({}, "win32")).toMatchObject({ lto: { enabled: false, scope: "not-applicable" }, ime: { enabled: false } });
	});

	test("maps Linux IME policies to the environment installed before Electron readiness", () => {
		expect(getLinuxImeEnvironment({ linux: { ime: "ibus" } })).toEqual({ GTK_IM_MODULE: "ibus", QT_IM_MODULE: "ibus", XMODIFIERS: "@im=ibus", SDL_IM_MODULE: "ibus" });
		expect(getLinuxImeEnvironment({ linux: { ime: "fcitx5" } })).toEqual({
			GTK_IM_MODULE: "fcitx",
			QT_IM_MODULE: "fcitx",
			XMODIFIERS: "@im=fcitx",
			SDL_IM_MODULE: "fcitx",
		});
	});

	test("captures native composition lifecycle, bounds history, and preserves configuration warnings across evidence reset", () => {
		const target = new EventTarget();
		const runtime = new PlatformPlayerRuntime({ macos: { useDisplayLink: true } }, { host: "darwin", imeTarget: target, requestAnimationFrame: null });
		const started = runtime.start();
		expect(started).toMatchObject({ revision: 2, configured: true, warnings: [expect.stringContaining("unavailable")] });
		for (let index = 0; index < 66; index++) {
			const event = new Event(index === 0 ? "compositionstart" : index === 65 ? "compositionend" : "compositionupdate");
			Object.defineProperty(event, "data", { value: `text-${index}` });
			target.dispatchEvent(event);
		}
		const snapshot = runtime.snapshot();
		expect(snapshot.compositionEvents).toHaveLength(64);
		expect(snapshot.compositionEvents[0]).toMatchObject({ sequence: 3, source: "native-event", text: "text-2" });
		expect(runtime.reset()).toMatchObject({ compositionEvents: [], framePacing: null, warnings: [expect.stringContaining("unavailable")] });
		runtime.dispose();
	});

	test("measures deterministic Chromium requestAnimationFrame statistics without claiming native queue enforcement", async () => {
		const runtime = new PlatformPlayerRuntime(
			{ macos: { useDisplayLink: true, maximumQueuedFrames: 1 } },
			{ host: "darwin", imeTarget: null, requestAnimationFrame: fakeFrames([0, 16, 33, 50]), cancelAnimationFrame: vi.fn(), nativeDisplayLinkAvailable: false }
		);
		runtime.start();
		const snapshot = await runtime.sampleFramePacing(3);
		expect(snapshot.framePacing).toMatchObject({
			sampleCount: 3,
			minimumDeltaMs: 16,
			maximumDeltaMs: 17,
			averageDeltaMs: 16.667,
			p95DeltaMs: 17,
			backend: "chromium-request-animation-frame",
			requestedDisplayLink: true,
			nativeDisplayLinkAvailable: false,
			maximumQueuedFrames: 1,
			queueDepthApplied: false,
		});
		runtime.dispose();
	});

	test("recognizes an injected native Metal adapter and labels queue-depth evidence as applied", async () => {
		(globalThis as any).zvibeMetalDisplayLink = { available: true };
		const plan = getPlatformPlayerBuildPlan({ macos: { useDisplayLink: true, maximumQueuedFrames: 3 } }, "darwin");
		expect(plan.framePacing).toMatchObject({ requestedDisplayLink: true, nativeAdapterRequired: true, queueDepthEnforcement: "native-adapter-required" });
		const runtime = new PlatformPlayerRuntime(
			{ macos: { useDisplayLink: true, maximumQueuedFrames: 3 } },
			{ host: "darwin", imeTarget: null, requestAnimationFrame: fakeFrames([0, 8, 16]), cancelAnimationFrame: vi.fn() }
		);
		runtime.start();
		expect((await runtime.sampleFramePacing(2)).framePacing).toMatchObject({ backend: "native-metal-display-link", queueDepthApplied: true });
		runtime.dispose();
	});

	test("rejects and cancels an active frame sample when disposed", async () => {
		const cancel = vi.fn();
		const runtime = new PlatformPlayerRuntime({}, { imeTarget: null, requestAnimationFrame: () => 42, cancelAnimationFrame: cancel });
		runtime.start();
		const pending = runtime.sampleFramePacing(2);
		runtime.dispose();
		await expect(pending).rejects.toThrow("disposed while frame-pacing sampling was active");
		expect(cancel).toHaveBeenCalledWith(42);
	});
});
