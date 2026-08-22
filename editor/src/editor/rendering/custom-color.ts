import { Camera, Color3, Effect, PostProcess } from "babylonjs";

import { Editor } from "../main";

export interface ICustomColorPostProcessConfiguration {
	tint: number[];
	tintStrength: number;
	saturation: number;
	contrast: number;
	brightness: number;
}

let customColorPostProcess: PostProcess | null = null;

/** Defines the custom color-pass configuration for each camera. */
export const customColorPostProcessCameraConfigurations = new Map<Camera, ICustomColorPostProcessConfiguration | null>();

const defaultConfiguration = (): ICustomColorPostProcessConfiguration => ({ tint: [1, 1, 1], tintStrength: 0, saturation: 1, contrast: 1, brightness: 0 });

function registerShader(): void {
	Effect.ShadersStore.customColorPassFragmentShader ??= `
		precision highp float;
		varying vec2 vUV;
		uniform sampler2D textureSampler;
		uniform vec3 tint;
		uniform float tintStrength;
		uniform float saturation;
		uniform float contrast;
		uniform float brightness;
		void main(void) {
			vec4 color = texture2D(textureSampler, vUV);
			float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
			color.rgb = mix(vec3(luminance), color.rgb, saturation);
			color.rgb = (color.rgb - 0.5) * contrast + 0.5 + brightness;
			color.rgb = mix(color.rgb, color.rgb * tint, tintStrength);
			gl_FragColor = color;
		}
	`;
}

/** Returns the live custom color post-process, if enabled for the active camera. */
export function getCustomColorPostProcess(): PostProcess | null {
	return customColorPostProcess;
}

export function disposeCustomColorPostProcess(): void {
	customColorPostProcess?.dispose();
	customColorPostProcess = null;
}

export function createCustomColorPostProcess(editor: Editor): PostProcess {
	registerShader();
	const configuration = defaultConfiguration();
	const camera = editor.layout.preview.scene.activeCamera!;
	customColorPostProcess = new PostProcess("CustomColorPostProcess", "customColorPass", ["tint", "tintStrength", "saturation", "contrast", "brightness"], null, 1, camera);
	(customColorPostProcess as any)._babylonEditorConfiguration = configuration;
	customColorPostProcess.onApply = (effect) => applyConfiguration(effect, configuration);
	return customColorPostProcess;
}

function applyConfiguration(effect: Effect, configuration: ICustomColorPostProcessConfiguration): void {
	effect.setColor3("tint", Color3.FromArray(configuration.tint));
	effect.setFloat("tintStrength", configuration.tintStrength);
	effect.setFloat("saturation", configuration.saturation);
	effect.setFloat("contrast", configuration.contrast);
	effect.setFloat("brightness", configuration.brightness);
}

export function serializeCustomColorPostProcess(): ICustomColorPostProcessConfiguration | null {
	if (!customColorPostProcess) {
		return null;
	}
	return structuredClone((customColorPostProcess as any)._babylonEditorConfiguration as ICustomColorPostProcessConfiguration);
}

export function parseCustomColorPostProcess(editor: Editor, data: Partial<ICustomColorPostProcessConfiguration>): PostProcess {
	const postProcess = getCustomColorPostProcess() ?? createCustomColorPostProcess(editor);
	const configuration = { ...defaultConfiguration(), ...data, tint: Array.isArray(data.tint) && data.tint.length === 3 ? data.tint : defaultConfiguration().tint };
	(postProcess as any)._babylonEditorConfiguration = configuration;
	postProcess.onApply = (effect) => applyConfiguration(effect, configuration);
	return postProcess;
}
