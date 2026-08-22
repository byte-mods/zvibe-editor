import { Scene } from "babylonjs";
import { PlatformPlayerRuntime, platformPlayerRuntimeBackend } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { getBuildProfilePlatformPlayerPlan } from "./export";

interface IPlatformPlayerController {
	profileId: string;
	configurationRevision: number;
	runtime: PlatformPlayerRuntime;
}

const controllers = new WeakMap<Scene, IPlatformPlayerController>();

function controllerFor(scene: Scene): IPlatformPlayerController {
	const controller = controllers.get(scene);
	if (!controller) {
		throw new Error("Platform player runtime is not prepared. Call prepare_platform_player_runtime first.");
	}
	return controller;
}

function requireRuntimeRevision(controller: IPlatformPlayerController, expectedRevision: unknown): void {
	const current = controller.runtime.snapshot().revision;
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current) {
		throw new Error(`Platform player runtime changed. Inspect it again and use expectedRuntimeRevision ${current}.`);
	}
}

/** Returns the bounded portable feature/native-adapter boundary for Unity 6.5 platform-player parity. */
export function getPlatformPlayerCapabilities(): any {
	return {
		model: platformPlayerRuntimeBackend,
		buildProfiles: { target: "electron", linuxPlatforms: ["desktop", "embedded"], lto: ["thin", "full"] },
		linuxIme: { desktop: ["disabled", "ibus", "fcitx5"], embedded: ["disabled", "ibus"], environmentAppliedBeforeElectronReady: true },
		macosFramePacing: {
			useDisplayLinkDefault: false,
			maximumQueuedFrames: { minimum: 1, maximum: 3, default: 2 },
			portableBackend: "chromium-request-animation-frame",
			nativeAdapter: "optional-zvibe-metal-display-link",
		},
		limits: { maximumCompositionEvents: 64, maximumCompositionTextLength: 1_024, maximumFrameSamples: 240 },
		limitations: [
			"LTO applies only to project native dependencies rebuilt by Electron packaging, not prebuilt Electron/Chromium or Unity IL2CPP binaries.",
			"IBUS/FCITX5 daemons and Embedded Linux board SDK/sysroot/compositor integration are external host requirements.",
			"Without a native host adapter, macOS evidence is Chromium requestAnimationFrame timing and does not claim CAMetalDisplayLink API identity.",
		],
	};
}

/** Prepares one transient runtime from an exact persisted Electron Build Profile. */
export function preparePlatformPlayerRuntime(scene: Scene, data: any, _options: IMCPActionOptions): any {
	const descriptor = getBuildProfilePlatformPlayerPlan(scene, data);
	if (!Number.isSafeInteger(data.expectedBuildRevision) || data.expectedBuildRevision !== descriptor.configurationRevision) {
		throw new Error(`Build Profiles changed. Inspect them again and use expectedBuildRevision ${descriptor.configurationRevision}.`);
	}
	controllers.get(scene)?.runtime.dispose();
	const nativeAdapter = (globalThis as any).zvibeMetalDisplayLink;
	const runtime = new PlatformPlayerRuntime(descriptor.plan.settings, {
		host: descriptor.plan.platform,
		imeTarget: typeof document === "undefined" ? null : document,
		nativeDisplayLinkAvailable: nativeAdapter?.available === true,
	});
	runtime.start();
	const controller = { profileId: descriptor.profileId, configurationRevision: descriptor.configurationRevision, runtime };
	controllers.set(scene, controller);
	return { prepared: true, profileId: controller.profileId, configurationRevision: controller.configurationRevision, runtime: runtime.snapshot() };
}

/** Reads the active transient composition/frame-pacing evidence without starting work. */
export function getPlatformPlayerRuntime(scene: Scene): any {
	const controller = controllers.get(scene);
	return controller
		? { prepared: true, profileId: controller.profileId, configurationRevision: controller.configurationRevision, runtime: controller.runtime.snapshot() }
		: { prepared: false, profileId: null, configurationRevision: null, runtime: null };
}

/** Injects an explicitly labelled bounded IME composition sequence for editor validation. */
export function simulatePlatformPlayerIme(scene: Scene, data: any): any {
	const controller = controllerFor(scene);
	requireRuntimeRevision(controller, data.expectedRuntimeRevision);
	for (const event of data.events) {
		controller.runtime.recordComposition(event.type, event.text, "editor-simulation");
	}
	return { simulated: true, runtime: controller.runtime.snapshot() };
}

/** Captures real requestAnimationFrame timestamps from the current Electron renderer. */
export async function samplePlatformPlayerFramePacing(scene: Scene, data: any): Promise<any> {
	const controller = controllerFor(scene);
	requireRuntimeRevision(controller, data.expectedRuntimeRevision);
	await controller.runtime.sampleFramePacing(data.sampleCount);
	return { sampled: true, runtime: controller.runtime.snapshot() };
}

/** Clears only transient composition and frame samples under an exact runtime lease. */
export function resetPlatformPlayerRuntime(scene: Scene, data: any): any {
	if (data.confirm !== true) {
		throw new Error("Resetting platform player evidence requires confirm=true.");
	}
	const controller = controllerFor(scene);
	requireRuntimeRevision(controller, data.expectedRuntimeRevision);
	return { reset: true, runtime: controller.runtime.reset() };
}

/** Releases DOM listeners and frame requests when the MCP/editor lifecycle ends. */
export function shutdownPlatformPlayerRuntime(scene: Scene): void {
	controllers.get(scene)?.runtime.dispose();
	controllers.delete(scene);
}
