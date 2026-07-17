import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

type ILightState = {
	nodeId: string;
	nodeName: string;
	enabled: boolean;
	intensity: number;
	diffuse: number[];
	specular: number[];
	position?: number[];
	direction?: number[];
	range?: number;
	angle?: number;
	exponent?: number;
};
type IScenario = { id: string; name: string; lights: ILightState[] };

function apply(light: any, state: ILightState, weight = 1, source = snapshot(light)): void {
	light.setEnabled(weight < 1 ? source.enabled || state.enabled : state.enabled);
	light.intensity = source.intensity + (state.intensity - source.intensity) * weight;
	light.diffuse.copyFrom(Color3.Lerp(Color3.FromArray(source.diffuse), Color3.FromArray(state.diffuse), weight));
	light.specular.copyFrom(Color3.Lerp(Color3.FromArray(source.specular), Color3.FromArray(state.specular), weight));
	if (state.position && light.position)
		light.position.copyFrom(Vector3.Lerp(Vector3.FromArray(source.position ?? light.position.asArray()), Vector3.FromArray(state.position), weight));
	if (state.direction && light.direction)
		light.direction.copyFrom(Vector3.Lerp(Vector3.FromArray(source.direction ?? light.direction.asArray()), Vector3.FromArray(state.direction), weight));
	for (const property of ["range", "angle", "exponent"] as const)
		if (state[property] !== undefined && typeof light[property] === "number") light[property] = source[property]! + (state[property]! - source[property]!) * weight;
}

function snapshot(light: any): ILightState {
	return {
		nodeId: light.id,
		nodeName: light.name,
		enabled: light.isEnabled(),
		intensity: light.intensity,
		diffuse: light.diffuse.asArray(),
		specular: light.specular.asArray(),
		position: light.position?.asArray(),
		direction: light.direction?.asArray(),
		range: light.range,
		angle: light.angle,
		exponent: light.exponent,
	};
}

/** Runtime controller for applying or cross-fading persisted realtime lighting scenarios. */
export class LightingScenarioController {
	private _observer: any = null;

	public constructor(
		private _scene: Scene,
		private _scenarios: IScenario[]
	) {}

	public apply(idOrName: string): boolean {
		const scenario = this._find(idOrName);
		if (!scenario) return false;
		for (const state of scenario.lights) {
			const light = this._scene.lights.find((candidate) => candidate.id === state.nodeId || candidate.name === state.nodeName) as any;
			if (light) apply(light, state);
		}
		return true;
	}

	public blendTo(idOrName: string, durationMs: number): boolean {
		const scenario = this._find(idOrName);
		if (!scenario || !Number.isFinite(durationMs) || durationMs < 0) return false;
		this._observer?.remove();
		if (durationMs === 0) return this.apply(idOrName);
		const startedAt = Date.now();
		const starts = new Map<string, ILightState>();
		for (const target of scenario.lights) {
			const light = this._scene.lights.find((candidate) => candidate.id === target.nodeId || candidate.name === target.nodeName) as any;
			if (light) starts.set(target.nodeId, snapshot(light));
		}
		this._observer = this._scene.onBeforeRenderObservable.add(() => {
			const weight = Math.min(1, (Date.now() - startedAt) / durationMs);
			for (const target of scenario.lights) {
				const light = this._scene.lights.find((candidate) => candidate.id === target.nodeId || candidate.name === target.nodeName) as any;
				const start = starts.get(target.nodeId);
				if (light && start) apply(light, target, weight, start);
			}
			if (weight === 1) {
				this._observer?.remove();
				this._observer = null;
			}
		});
		return true;
	}

	private _find(idOrName: string): IScenario | undefined {
		return this._scenarios.find((scenario) => scenario.id === idOrName || scenario.name === idOrName);
	}
}

declare module "@babylonjs/core/scene" {
	interface Scene {
		lightingScenarios?: LightingScenarioController;
	}
}

/** Creates the exported-game lighting-scenario controller when scenarios are saved in scene metadata. */
export function configureLightingScenarios(scene: Scene): void {
	const scenarios = scene.metadata?.babylonEditorLightingScenarios as IScenario[] | undefined;
	if (scenarios?.length) scene.lightingScenarios = new LightingScenarioController(scene, scenarios);
}
