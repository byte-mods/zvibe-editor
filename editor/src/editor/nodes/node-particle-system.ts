import { Scene, Mesh, NodeParticleSystemSet, ParticleSystemSet, Tools, Matrix, Vector3, Quaternion, Tags, GetClass, Node } from "babylonjs";
import {
	disposeVfxBatchReleaseController,
	getVfxBatchReleaseEvidence,
	handleVfxBatchHostEnabledChanged,
	IVfxBatchReleaseEvidence,
	refreshVfxBatchReleaseEvidence,
	registerVfxBatchReleaseController,
	setVfxBatchReleasePolicy,
} from "babylonjs-editor-tools";

import { UniqueNumber } from "../../tools/tools";
import { setParticleSystemVisibleInGraph } from "../../tools/particles/metadata";
import { isParticleSystem, isGPUParticleSystem } from "../../tools/guards/particles";

export class NodeParticleSystemSetMesh extends Mesh {
	private _releaseVfxBatchOnDisable = false;

	/**
	 * Defines the reference to the associated Particle System Set created from the node particle system set.
	 */
	public particleSystemSet: ParticleSystemSet | null = null;
	/**
	 * Defines the reference to the associated Node Particle System Set.
	 */
	public nodeParticleSystemSet: NodeParticleSystemSet | null = null;

	/**
	 * Constructor.
	 * @param name defines the name of mesh.
	 * @param scene defines the scene the mesh belongs to.
	 */
	public constructor(name: string, scene: Scene, parent?: Node | null, source?: Mesh, doNotCloneChildren?: boolean, clonePhysicsImpostor?: boolean) {
		super(name, scene, parent, source, doNotCloneChildren, clonePhysicsImpostor);

		// Set scale to 100 as default unit size is centimeters and particles are in meters
		this.scaling.setAll(100);

		registerVfxBatchReleaseController(
			this,
			{
				isHostEnabled: () => this.isEnabled(false),
				isHostDisposed: () => this.isDisposed(),
				hasRebuildSource: () => this.nodeParticleSystemSet !== null,
				getBatch: () => this.particleSystemSet,
				detachBatch: () => {
					const batch = this.particleSystemSet;
					this.particleSystemSet = null;
					return batch;
				},
				buildBatch: () => this._buildParticleSystemSet(this.nodeParticleSystemSet!),
				publishBatch: (batch) => this._publishParticleSystemSet(batch),
				disposeBatch: (batch) => this._disposeParticleSystemSet(batch),
			},
			this._releaseVfxBatchOnDisable
		);
		this.onEnabledStateChangedObservable.add(() => void handleVfxBatchHostEnabledChanged(this));
	}

	/** Whether disabling this VFX node releases its live particle-system batch. */
	public get releaseVfxBatchOnDisable(): boolean {
		return this._releaseVfxBatchOnDisable;
	}

	/** Returns exact runtime evidence for the disable-time VFX batch lifecycle. */
	public getVfxBatchReleaseEvidence(): IVfxBatchReleaseEvidence {
		return getVfxBatchReleaseEvidence(this);
	}

	/** Changes the disable-time release policy and completes any required release or rebuild. */
	public async setReleaseVfxBatchOnDisable(enabled: boolean): Promise<IVfxBatchReleaseEvidence> {
		this._releaseVfxBatchOnDisable = enabled;
		return setVfxBatchReleasePolicy(this, enabled);
	}

	public async buildNodeParticleSystemSet(data: any): Promise<void> {
		const nextNodeParticleSystemSet = NodeParticleSystemSet.Parse(data);
		nextNodeParticleSystemSet.id = data.id;
		nextNodeParticleSystemSet.uniqueId = data.uniqueId;

		let particleSystemSet: ParticleSystemSet;
		try {
			particleSystemSet = await this._buildParticleSystemSet(nextNodeParticleSystemSet);
		} catch (error) {
			nextNodeParticleSystemSet.dispose();
			throw error;
		}

		const previousParticleSystemSet = this.particleSystemSet;
		const previousNodeParticleSystemSet = this.nodeParticleSystemSet;
		try {
			this._publishParticleSystemSet(particleSystemSet);
		} catch (error) {
			this._disposeParticleSystemSet(particleSystemSet);
			nextNodeParticleSystemSet.dispose();
			throw error;
		}

		this.particleSystemSet = particleSystemSet;
		this.nodeParticleSystemSet = nextNodeParticleSystemSet;
		if (previousParticleSystemSet && previousParticleSystemSet !== particleSystemSet) {
			this._disposeParticleSystemSet(previousParticleSystemSet);
		}
		previousNodeParticleSystemSet?.dispose();
		refreshVfxBatchReleaseEvidence(this);
		await handleVfxBatchHostEnabledChanged(this);
	}

	/**
	 * Releases resources associated with this scene link.
	 */
	public dispose(): void {
		disposeVfxBatchReleaseController(this);
		if (this.particleSystemSet) {
			this._disposeParticleSystemSet(this.particleSystemSet);
			this.particleSystemSet = null;
		}
		this.nodeParticleSystemSet?.dispose();
		this.nodeParticleSystemSet = null;
		super.dispose(false, true);
	}

	/**
	 * Gets the current object class name.
	 * @return the class name
	 */
	public getClassName(): string {
		return "NodeParticleSystemSetMesh";
	}

	public clone(name?: string, newParent?: Node | null, doNotCloneChildren?: boolean, clonePhysicsImpostor?: boolean): NodeParticleSystemSetMesh {
		const clone = new NodeParticleSystemSetMesh(name ?? this.name, this.getScene(), newParent, this, doNotCloneChildren, clonePhysicsImpostor);

		if (this.nodeParticleSystemSet) {
			void clone
				.buildNodeParticleSystemSet({
					...this.nodeParticleSystemSet.serialize(),
					id: this.nodeParticleSystemSet.id,
					uniqueId: this.nodeParticleSystemSet.uniqueId,
				})
				.catch((error: unknown) => Tools.Error(`Unable to clone Node Particle System "${this.name}": ${error instanceof Error ? error.message : String(error)}`));
		}
		void clone.setReleaseVfxBatchOnDisable(this.releaseVfxBatchOnDisable);

		return clone;
	}

	public serialize(serializationObject: any = {}): any {
		super.serialize(serializationObject);

		serializationObject.isNodeParticleSystemMesh = true;
		serializationObject.releaseVfxBatchOnDisable = this.releaseVfxBatchOnDisable;
		serializationObject.nodeParticleSystemSet = this.nodeParticleSystemSet
			? {
					...this.nodeParticleSystemSet.serialize(),
					id: this.nodeParticleSystemSet.id,
					uniqueId: this.nodeParticleSystemSet.uniqueId,
				}
			: undefined;

		return serializationObject;
	}

	public static override Parse(parsedMesh: any, scene: Scene, _rootUrl: string): NodeParticleSystemSetMesh {
		const mesh = new NodeParticleSystemSetMesh(parsedMesh.name, scene);

		if (parsedMesh.nodeParticleSystemSet) {
			void mesh
				.buildNodeParticleSystemSet(parsedMesh.nodeParticleSystemSet)
				.catch((error: unknown) => Tools.Error(`Unable to parse Node Particle System "${parsedMesh.name}": ${error instanceof Error ? error.message : String(error)}`));
		}
		void mesh.setReleaseVfxBatchOnDisable(parsedMesh.releaseVfxBatchOnDisable === true);

		mesh.id = parsedMesh.id;
		mesh._waitingParsedUniqueId = parsedMesh.uniqueId;

		if (Tags) {
			Tags.AddTagsTo(mesh, parsedMesh.tags);
		}

		mesh.position = Vector3.FromArray(parsedMesh.position);

		if (parsedMesh.metadata !== undefined) {
			mesh.metadata = parsedMesh.metadata;
		}

		if (parsedMesh.rotationQuaternion) {
			mesh.rotationQuaternion = Quaternion.FromArray(parsedMesh.rotationQuaternion);
		} else if (parsedMesh.rotation) {
			mesh.rotation = Vector3.FromArray(parsedMesh.rotation);
		}

		mesh.scaling = Vector3.FromArray(parsedMesh.scaling);

		if (parsedMesh.localMatrix) {
			mesh.setPreTransformMatrix(Matrix.FromArray(parsedMesh.localMatrix));
		} else if (parsedMesh.pivotMatrix) {
			mesh.setPivotMatrix(Matrix.FromArray(parsedMesh.pivotMatrix));
		}

		mesh.setEnabled(parsedMesh.isEnabled);
		mesh.isVisible = parsedMesh.isVisible;

		if (parsedMesh.billboardMode !== undefined) {
			mesh.billboardMode = parsedMesh.billboardMode;
		}

		mesh._shouldGenerateFlatShading = parsedMesh.useFlatShading;

		// freezeWorldMatrix
		if (parsedMesh.freezeWorldMatrix) {
			mesh._waitingData.freezeWorldMatrix = parsedMesh.freezeWorldMatrix;
		}

		// Parent
		if (parsedMesh.parentId !== undefined) {
			mesh._waitingParentId = parsedMesh.parentId;
		}

		if (parsedMesh.parentInstanceIndex !== undefined) {
			mesh._waitingParentInstanceIndex = parsedMesh.parentInstanceIndex;
		}

		// Animations
		if (parsedMesh.animations) {
			for (let animationIndex = 0; animationIndex < parsedMesh.animations.length; animationIndex++) {
				const parsedAnimation = parsedMesh.animations[animationIndex];
				const internalClass = GetClass("BABYLON.Animation");
				if (internalClass) {
					mesh.animations.push(internalClass.Parse(parsedAnimation));
				}
			}
			Node.ParseAnimationRanges(mesh, parsedMesh, scene);
		}

		if (parsedMesh.autoAnimate) {
			scene.beginAnimation(mesh, parsedMesh.autoAnimateFrom, parsedMesh.autoAnimateTo, parsedMesh.autoAnimateLoop, parsedMesh.autoAnimateSpeed || 1.0);
		}

		// Layer Mask
		if (parsedMesh.layerMask && !isNaN(parsedMesh.layerMask)) {
			mesh.layerMask = Math.abs(parseInt(parsedMesh.layerMask));
		} else {
			mesh.layerMask = 0x0fffffff;
		}

		return mesh;
	}

	private async _buildParticleSystemSet(graph: NodeParticleSystemSet): Promise<ParticleSystemSet> {
		const particleSystemSet = await graph.buildAsync(this._scene, false);
		particleSystemSet.emitterNode = this;
		particleSystemSet["_emitterNodeIsOwned"] = false;
		particleSystemSet.systems.forEach((particleSystem) => {
			particleSystem.id = Tools.RandomId();
			particleSystem.uniqueId = UniqueNumber.Get();
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
			if (isParticleSystem(particleSystem) || isGPUParticleSystem(particleSystem)) {
				setParticleSystemVisibleInGraph(particleSystem, false);
			}
		});
		return particleSystemSet;
	}

	private _publishParticleSystemSet(batch: ParticleSystemSet): void {
		batch.emitterNode = this;
		batch["_emitterNodeIsOwned"] = false;
		batch.start();
		this.particleSystemSet = batch;
	}

	private _disposeParticleSystemSet(batch: ParticleSystemSet): void {
		batch.emitterNode = null;
		batch.dispose();
	}
}
