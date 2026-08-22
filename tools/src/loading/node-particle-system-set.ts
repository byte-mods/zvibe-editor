import { Scene } from "@babylonjs/core/scene";
import { AssetContainer } from "@babylonjs/core/assetContainer";
import { AddParser } from "@babylonjs/core/Loading/Plugins/babylonFileParser.function";
import { NodeParticleSystemSet } from "@babylonjs/core/Particles/Node/nodeParticleSystemSet";
import { ParticleSystemSet } from "@babylonjs/core/Particles/particleSystemSet";
import { Tools } from "@babylonjs/core/Misc/tools";

import { isParticleSystem } from "../tools/guards";
import { NodeParticleSystemMesh } from "../tools/particle";
import { disposeVfxBatchReleaseController, handleVfxBatchHostEnabledChanged, refreshVfxBatchReleaseEvidence, registerVfxBatchReleaseController } from "./vfx-batch-release";

let registered = false;

export function registerNodeParticleSystemSetParser() {
	if (registered) {
		return;
	}

	registered = true;

	AddParser("NodeParticleSystemSetEditorPlugin", (parsedData: any, scene: Scene, container: AssetContainer, rootUrl: string) => {
		parsedData.meshes?.forEach((mesh: any) => {
			if (!mesh.isNodeParticleSystemMesh) {
				return;
			}

			const instance = container.meshes?.find((m) => m.id === mesh.id) as NodeParticleSystemMesh;
			if (!instance) {
				return;
			}

			mesh.nodeParticleSystemSet.blocks?.forEach((block: any) => {
				if (block.url) {
					block.url = `${rootUrl}${block.url}`;
				}
			});

			instance.nodeParticleSystemSet = NodeParticleSystemSet.Parse(mesh.nodeParticleSystemSet);
			instance.nodeParticleSystemSet.id = mesh.nodeParticleSystemSet.id;
			instance.nodeParticleSystemSet.uniqueId = mesh.uniqueId;
			instance.releaseVfxBatchOnDisable = mesh.releaseVfxBatchOnDisable === true;

			const disposeBatch = (batch: ParticleSystemSet): void => {
				batch.emitterNode = null;
				batch.dispose();
			};
			const buildBatch = async (): Promise<ParticleSystemSet> => {
				const graph = instance.nodeParticleSystemSet;
				if (!graph) {
					throw new Error(`Node Particle System "${instance.name}" has no rebuild source.`);
				}
				const batch = await graph.buildAsync(scene, false);
				batch.emitterNode = instance;
				batch["_emitterNodeIsOwned"] = false;
				batch.systems.forEach((particleSystem) => {
					if (isParticleSystem(particleSystem)) {
						const sizeCreationProcess = particleSystem._sizeCreation.process;
						if (sizeCreationProcess) {
							particleSystem._sizeCreation.process = (particle, system) => {
								sizeCreationProcess(particle, system);
								particle.scale.x *= 100;
								particle.scale.y *= 100;
							};
						}
					}
				});
				return batch;
			};
			const publishBatch = (batch: ParticleSystemSet): void => {
				batch.emitterNode = instance;
				batch["_emitterNodeIsOwned"] = false;
				batch.start();
				instance.particleSystemSet = batch;
			};
			registerVfxBatchReleaseController(
				instance,
				{
					isHostEnabled: () => instance.isEnabled(false),
					isHostDisposed: () => instance.isDisposed(),
					hasRebuildSource: () => instance.nodeParticleSystemSet !== null,
					getBatch: () => instance.particleSystemSet ?? null,
					detachBatch: () => {
						const batch = instance.particleSystemSet ?? null;
						instance.particleSystemSet = null;
						return batch;
					},
					buildBatch,
					publishBatch,
					disposeBatch,
				},
				instance.releaseVfxBatchOnDisable
			);
			instance.onEnabledStateChangedObservable.add(() => void handleVfxBatchHostEnabledChanged(instance));
			instance.onDisposeObservable.addOnce(() => disposeVfxBatchReleaseController(instance));

			scene.addPendingData(mesh.id);
			if (instance.releaseVfxBatchOnDisable && !instance.isEnabled(false)) {
				scene.removePendingData(mesh.id);
				void handleVfxBatchHostEnabledChanged(instance);
			} else {
				void buildBatch()
					.then((particleSystemSet) => {
						publishBatch(particleSystemSet);
						refreshVfxBatchReleaseEvidence(instance);
					})
					.catch((error: unknown) => Tools.Error(`Unable to build Node Particle System "${instance.name}": ${error instanceof Error ? error.message : String(error)}`))
					.finally(() => scene.removePendingData(mesh.id));
			}
		});
	});
}
