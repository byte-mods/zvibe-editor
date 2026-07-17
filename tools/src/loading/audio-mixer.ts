import { Scene } from "@babylonjs/core/scene";

type IBus = { id: string; name: string; gain: number; muted?: boolean; solo?: boolean; soundNodeIds: string[] };
type ISnapshot = { id: string; name: string; gains: Record<string, number>; mutes?: Record<string, boolean>; solos?: Record<string, boolean> };

/** Applies exported mixer-bus gains to loaded SoundNodes and exposes snapshot recall. */
export class AudioMixer {
	public constructor(
		private _scene: Scene,
		private _buses: IBus[],
		private _snapshots: ISnapshot[]
	) {}

	public applySnapshot(idOrName: string): boolean {
		const snapshot = this._snapshots.find((value) => value.id === idOrName || value.name === idOrName);
		if (!snapshot) return false;
		this._buses.forEach((bus) => {
			if (snapshot.gains[bus.id] !== undefined) bus.gain = snapshot.gains[bus.id];
			if (snapshot.mutes?.[bus.id] !== undefined) bus.muted = snapshot.mutes[bus.id];
			if (snapshot.solos?.[bus.id] !== undefined) bus.solo = snapshot.solos[bus.id];
		});
		this.apply();
		return true;
	}

	public apply(): void {
		const hasSolo = this._buses.some((bus) => bus.solo === true);
		for (const bus of this._buses)
			for (const id of bus.soundNodeIds) {
				const node: any = this._scene.getNodeById(id);
				if (!node || typeof node.volume !== "number") continue;
				node.metadata ??= {};
				const base = node.metadata.babylonEditorAudioBusBaseVolume ?? node.volume;
				node.metadata.babylonEditorAudioBusBaseVolume = base;
				node.volume = base * (bus.muted || (hasSolo && bus.solo !== true) ? 0 : bus.gain);
			}
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		audioMixer?: AudioMixer;
	}
}

export function configureAudioMixer(scene: Scene): void {
	const buses = scene.metadata?.babylonEditorAudioBuses as IBus[] | undefined;
	if (!buses) return;
	scene.audioMixer = new AudioMixer(scene, buses, scene.metadata?.babylonEditorAudioMixerSnapshots ?? []);
	scene.onBeforeRenderObservable.addOnce(() => scene.audioMixer?.apply());
}
