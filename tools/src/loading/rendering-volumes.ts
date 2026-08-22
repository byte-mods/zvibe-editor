import { Scene } from "@babylonjs/core/scene";

import { blendRenderingConfiguration, getRenderingVolumeContributions } from "./rendering-volume-blend";

import { applyRenderingConfigurationForCamera } from "../rendering/tools";
import { vlsPostProcessCameraConfigurations } from "../rendering/vls";
import { ssrRenderingPipelineCameraConfigurations } from "../rendering/ssr";
import { taaRenderingPipelineCameraConfigurations } from "../rendering/taa";
import { ssaoRenderingPipelineCameraConfigurations } from "../rendering/ssao";
import { motionBlurPostProcessCameraConfigurations } from "../rendering/motion-blur";
import { defaultPipelineCameraConfigurations } from "../rendering/default-pipeline";
import { customColorPostProcessCameraConfigurations } from "../rendering/custom-color";

type IProfile = { id: string; configurations: Record<string, any> };
type IVolume = { id: string; profileId: string; center: number[]; size: number[]; priority: number; blendDistance?: number; weight?: number; enabled: boolean };
const postProcessTypes = ["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"] as const;

function normalizeConfigurations(configurations: Record<string, any>): Record<string, any> {
	return Object.fromEntries(postProcessTypes.map((type) => [type, structuredClone(configurations[type] ?? null)]));
}

function applyProfile(camera: any, profile: IProfile, rootUrl: string): void {
	const configurations = profile.configurations;
	ssaoRenderingPipelineCameraConfigurations.set(camera, configurations.ssao ?? null);
	vlsPostProcessCameraConfigurations.set(camera, configurations.vls ?? null);
	ssrRenderingPipelineCameraConfigurations.set(camera, configurations.ssr ?? null);
	motionBlurPostProcessCameraConfigurations.set(camera, configurations.motionBlur ?? null);
	defaultPipelineCameraConfigurations.set(camera, configurations.default ?? null);
	taaRenderingPipelineCameraConfigurations.set(camera, configurations.taa ?? null);
	customColorPostProcessCameraConfigurations.set(camera, configurations.customColor ?? null);
	applyRenderingConfigurationForCamera(camera, rootUrl);
}

/** Restores priority-ordered camera rendering volumes in generated games. */
export function configureRenderingVolumes(scene: Scene, rootUrl: string): void {
	const profiles = scene.metadata?.babylonEditorRenderingProfiles as IProfile[] | undefined;
	const volumes = scene.metadata?.babylonEditorRenderingVolumes as IVolume[] | undefined;
	if (!profiles?.length || !volumes?.length) {
		return;
	}
	const states = new WeakMap<object, { signature: string; baseline: IProfile }>();
	scene.onBeforeRenderObservable.add(() => {
		const camera: any = scene.activeCamera;
		if (!camera?.position) {
			return;
		}
		const position = camera.getAbsolutePosition?.() ?? camera.globalPosition ?? camera.position;
		const contributions = getRenderingVolumeContributions(
			volumes.filter((volume) => volume.enabled),
			position.asArray()
		).filter((entry) => profiles.some((profile) => profile.id === entry.volume.profileId));
		const state = states.get(camera);
		if (!contributions.length) {
			if (state) {
				applyProfile(camera, state.baseline, rootUrl);
			}
			states.delete(camera);
			return;
		}
		const baseline: IProfile =
			state?.baseline ??
			({
				id: "baseline",
				configurations: {
					ssao: ssaoRenderingPipelineCameraConfigurations.get(camera) ?? null,
					vls: vlsPostProcessCameraConfigurations.get(camera) ?? null,
					ssr: ssrRenderingPipelineCameraConfigurations.get(camera) ?? null,
					motionBlur: motionBlurPostProcessCameraConfigurations.get(camera) ?? null,
					default: defaultPipelineCameraConfigurations.get(camera) ?? null,
					taa: taaRenderingPipelineCameraConfigurations.get(camera) ?? null,
					customColor: customColorPostProcessCameraConfigurations.get(camera) ?? null,
				},
			} as IProfile);
		const configurations = contributions.reduce((current, contribution) => {
			const profile = profiles.find((candidate) => candidate.id === contribution.volume.profileId)!;
			return blendRenderingConfiguration(current, normalizeConfigurations(profile.configurations), contribution.blendFactor);
		}, baseline.configurations);
		const signature = JSON.stringify(configurations);
		if (state?.signature === signature) {
			return;
		}
		applyProfile(camera, { id: "blended-volume", configurations }, rootUrl);
		states.set(camera, { signature, baseline });
	});
}
