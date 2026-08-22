import { Component, ReactNode } from "react";

import { IoPlay, IoStop, IoRefresh } from "react-icons/io5";

import { toast } from "sonner";

import {
	GPUParticleSystem,
	ParticleSystem,
	IParticleEmitterType,
	BoxParticleEmitter,
	ConeParticleEmitter,
	ConeDirectedParticleEmitter,
	CylinderParticleEmitter,
	CylinderDirectedParticleEmitter,
	SphereParticleEmitter,
	SphereDirectedParticleEmitter,
	PointParticleEmitter,
	HemisphericParticleEmitter,
	MeshParticleEmitter,
	Observer,
} from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { getPowerOfTwoSizesUntil } from "../../../../tools/maths/scalar";
import { isGPUParticleSystem } from "../../../../tools/guards/particles";
import { onParticleSystemModifiedObservable } from "../../../../tools/observables";
import { createGpuParticleSystemRandomTexture } from "../../../../tools/particles/texture";

import { validateParticleSystem } from "../../../../mcp/particles/particles";
import { getParticleEvents, setParticleEvents, triggerParticleEvent } from "../../../../mcp/particles/events";
import { getParticleCollisionPlanes, getParticleCollisionSpheres, setParticleCollisionPlanes, setParticleCollisionSpheres } from "../../../../mcp/particles/collisions";
import { getGpuParticleInteractions, setGpuParticleInteractions } from "../../../../mcp/particles/gpu-interactions";
import { getGpuParticleCollisionEvents, setGpuParticleCollisionEvents } from "../../../../mcp/particles/gpu-collision-events";
import { getParticleTextureVectorFields, setParticleTextureVectorFields } from "../../../../mcp/particles/texture-vector-fields";

import { EditorInspectorColorField } from "../fields/color";
import { EditorInspectorBlockField } from "../fields/block";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorVectorField } from "../fields/vector";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorSectionField } from "../fields/section";
import { EditorInspectorTextureField } from "../fields/texture";
import { EditorInspectorListField, IEditorInspectorListFieldItem } from "../fields/list";

import { IEditorInspectorImplementationProps } from "../inspector";

export interface IEditorGPUParticleSystemInspectorState {
	started: boolean;
}

export class EditorGPUParticleSystemInspector extends Component<IEditorInspectorImplementationProps<GPUParticleSystem>, IEditorGPUParticleSystemInspectorState> {
	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: unknown): boolean {
		return isGPUParticleSystem(object);
	}

	protected _randomTextureSize: number = 1024;
	protected _sizes: IEditorInspectorListFieldItem[] = getPowerOfTwoSizesUntil(this.props.editor.layout.preview.engine.getCaps().maxTextureSize, 256).map(
		(s) =>
			({
				value: s,
				text: `${s}px`,
			}) as IEditorInspectorListFieldItem
	);

	private _stoppedObserver: Observer<ParticleSystem> | null = null;
	private _runtimeRefreshInterval: ReturnType<typeof setInterval> | null = null;

	public constructor(props: IEditorInspectorImplementationProps<GPUParticleSystem>) {
		super(props);

		this.state = {
			started: props.object.isStarted() && !props.object.isStopped(),
		};
	}

	public componentDidMount(): void {
		this._stoppedObserver = this.props.object.onStoppedObservable.add(() => {
			this.setState({
				started: false,
			});
		});
		this._runtimeRefreshInterval = setInterval(() => this.forceUpdate(), 500);
	}

	public componentWillUnmount(): void {
		if (this._stoppedObserver) {
			this.props.object.onStoppedObservable.remove(this._stoppedObserver);
			this._stoppedObserver = null;
		}
		if (this._runtimeRefreshInterval) {
			clearInterval(this._runtimeRefreshInterval);
			this._runtimeRefreshInterval = null;
		}
	}

	public render(): ReactNode {
		return (
			<>
				<EditorInspectorSectionField title="Common">
					<div className="flex justify-between items-center px-2 py-2">
						<div className="w-1/2">Type</div>

						<div className="text-white/50">{this.props.object.getClassName()}</div>
					</div>

					<EditorInspectorStringField
						label="Name"
						object={this.props.object}
						property="name"
						onChange={() => onParticleSystemModifiedObservable.notifyObservers(this.props.object)}
					/>
					<EditorInspectorSwitchField object={this.props.object} property="preventAutoStart" label="Prevent Auto Start" />
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Actions">
					<div className="flex justify-center items-center gap-2">
						<Button
							onClick={() => this._handleStartOrStop()}
							className={`
                                w-10 h-10 bg-muted/50 !rounded-lg p-0.5
                                ${this.state.started ? "!bg-red-500/35" : "hover:!bg-green-500/35"}
                                transition-all duration-300 ease-in-out
                            `}
						>
							{this.state.started ? <IoStop className="w-6 h-6" strokeWidth={1} color="red" /> : <IoPlay className="w-6 h-6" strokeWidth={1} color="green" />}
						</Button>

						<Button onClick={() => this.props.object.reset()} className="w-10 h-10 bg-muted/50 !rounded-lg p-0.5">
							<IoRefresh className="w-6 h-6" strokeWidth={1} color="red" />
						</Button>

						<Button variant="secondary" onClick={() => this._validateParticleSystem()}>
							Validate
						</Button>
					</div>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="VFX Events" tooltip="Named gameplay-triggered bursts. These work for both CPU and GPU particles and export with the scene.">
					{this._getParticleEventsInspector()}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Native GPU Collision Events"
					tooltip="Reserve bounded secondary-particle slots that spawn from plane/sphere collisions entirely on the native WebGL2 or WebGPU backend, with no particle readback."
				>
					{this._getGpuParticleCollisionEventsInspector()}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Native GPU Particle Interactions"
					tooltip="Bounded particle collision runs without CPU readback: WebGPU directly reads the prior particle storage buffer, while WebGL2 rasterizes a GPU-only 3D occupancy field and samples a 3x3x3 voxel neighborhood."
				>
					{this._getGpuParticleInteractionsInspector()}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Native GPU 3D Vector Fields"
					tooltip="Portable image or depth-stack XYZ grids are packed into one native 3D texture and sampled directly by WebGPU compute or WebGL2 transform feedback, without particle or texture readback."
				>
					{this._getGpuTextureVectorFieldsInspector()}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Native GPU Collision Spheres"
					tooltip="Up to eight collision spheres execute directly in the Babylon WebGL2 transform-feedback or WebGPU compute particle-update shader, without CPU particle readback."
				>
					{this._getCollisionSpheresInspector()}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Native GPU Collision Planes"
					tooltip="Up to eight collision planes execute directly in the Babylon WebGL2 transform-feedback or WebGPU compute particle-update shader, without CPU particle readback."
				>
					{this._getCollisionPlanesInspector()}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Transforms">
					<EditorInspectorVectorField object={this.props.object} property="worldOffset" label="Offset" />
					<EditorInspectorVectorField object={this.props.object} property="gravity" label="Gravity" />
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Textures">
					<EditorInspectorTextureField hideLevel hideSize object={this.props.object} property="particleTexture" title="Base Texture" />

					<EditorInspectorListField
						object={this.props.object}
						property="blendMode"
						label="Blend Mode"
						items={[
							{ text: "Add", value: ParticleSystem.BLENDMODE_ADD },
							{ text: "Multiply", value: ParticleSystem.BLENDMODE_MULTIPLY },
							{ text: "Multiply Add", value: ParticleSystem.BLENDMODE_MULTIPLYADD },
							{ text: "One-one", value: ParticleSystem.BLENDMODE_ONEONE },
							{ text: "Standard", value: ParticleSystem.BLENDMODE_STANDARD },
						]}
					/>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Emission">
					{this._getCapacityInspector()}
					{this._getRandomTextureSizeInspector()}

					<EditorInspectorNumberField object={this.props.object} property="emitRate" label="Rate" />
					<EditorInspectorNumberField object={this.props.object} property="targetStopDuration" label="Stop Duration" min={0} step={0.01} />

					<EditorInspectorBlockField>
						<div className="px-2">Emit Power</div>
						<div className="flex items-center">
							<EditorInspectorNumberField grayLabel object={this.props.object} property="minEmitPower" label="Min" min={0} />
							<EditorInspectorNumberField grayLabel object={this.props.object} property="maxEmitPower" label="Max" min={0} />
						</div>
					</EditorInspectorBlockField>

					<EditorInspectorBlockField>
						<div className="px-2">Lifetime</div>
						<div className="flex items-center">
							<EditorInspectorNumberField grayLabel object={this.props.object} property="minLifeTime" label="Min" min={0} />
							<EditorInspectorNumberField grayLabel object={this.props.object} property="maxLifeTime" label="Max" min={0} />
						</div>
					</EditorInspectorBlockField>

					<EditorInspectorBlockField>
						<div className="px-2">Angular Speed</div>
						<div className="flex items-center">
							<EditorInspectorNumberField grayLabel asDegrees object={this.props.object} property="minAngularSpeed" label="Min" step={0.1} />
							<EditorInspectorNumberField grayLabel asDegrees object={this.props.object} property="maxAngularSpeed" label="Max" step={0.1} />
						</div>
					</EditorInspectorBlockField>

					<EditorInspectorBlockField>
						<div className="px-2">Size</div>
						<div className="flex items-center">
							<EditorInspectorNumberField grayLabel object={this.props.object} property="minSize" label="Min" min={0} />
							<EditorInspectorNumberField grayLabel object={this.props.object} property="maxSize" label="Max" min={0} />
						</div>
					</EditorInspectorBlockField>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Colors">
					<EditorInspectorColorField object={this.props.object} property="color1" label="Color 1" />
					<EditorInspectorColorField object={this.props.object} property="color2" label="Color 2" />
					<EditorInspectorColorField object={this.props.object} property="colorDead" label="Dead" />
				</EditorInspectorSectionField>

				{this._getEmitterTypeInspector()}

				<EditorInspectorSectionField title="Animation Sheet">
					<EditorInspectorSwitchField
						object={this.props.object}
						property="isAnimationSheetEnabled"
						label="Is Animation Sheet Enabled"
						onChange={() => this.forceUpdate()}
					/>

					{this.props.object.isAnimationSheetEnabled && (
						<>
							<EditorInspectorNumberField object={this.props.object} property="startSpriteCellID" label="Start Cell Id" min={0} />
							<EditorInspectorNumberField object={this.props.object} property="endSpriteCellID" label="End Cell Id" min={0} />
							<EditorInspectorNumberField object={this.props.object} property="spriteCellChangeSpeed" label="Cell Change Speed" min={0} />
							<EditorInspectorNumberField object={this.props.object} property="spriteCellWidth" label="Cell Width" min={0} />
							<EditorInspectorNumberField object={this.props.object} property="spriteCellHeight" label="Cell Height" min={0} />
							<EditorInspectorSwitchField object={this.props.object} property="spriteRandomStartCell" label="Random Start Cell" />
						</>
					)}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Misc">
					<EditorInspectorSwitchField object={this.props.object} property="useLogarithmicDepth" label="Use Logarithmic Depth" />
				</EditorInspectorSectionField>
			</>
		);
	}

	private _validateParticleSystem(): void {
		const scene = this.props.object.getScene();
		if (!scene) {
			toast.error("Particle system is not attached to a scene.");
			return;
		}
		const result = validateParticleSystem(scene, { particleSystemId: this.props.object.id });
		if (result.valid) {
			toast.success(`Particle system valid${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : ""}.`);
		} else {
			toast.error(result.errors.join("\n"));
		}
	}

	private _handleStartOrStop(): void {
		if (this.state.started) {
			this.props.object.stop();
			this.setState({
				started: false,
			});
		} else {
			this.props.object.start();

			this.setState({
				started: true,
			});
		}
	}

	private _getParticleEventsInspector(): ReactNode {
		const events = getParticleEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).events as Array<{ name: string; count: number }>;
		return (
			<div className="space-y-2">
				<div className="flex gap-2">
					<Button
						variant="secondary"
						className="flex-1"
						disabled={events.length >= 32}
						onClick={() => this._setParticleEvents([...events, { name: `Burst ${events.length + 1}`, count: 10 }])}
					>
						Add Burst
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!events.length} onClick={() => this._setParticleEvents([])}>
						Clear ({events.length})
					</Button>
				</div>
				{events.map((event, index) => (
					<div key={index} className="grid grid-cols-[minmax(0,1fr)_5rem_auto_auto] items-center gap-1">
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={event.name}
							aria-label={`GPU particle event ${index + 1} name`}
							onBlur={(input) => this._setParticleEvent(index, { name: input.target.value })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={event}
							property="count"
							label=""
							min={1}
							step={1}
							onFinishChange={(count) => this._setParticleEvent(index, { count })}
						/>
						<Button size="sm" variant="secondary" onClick={() => this._triggerParticleEvent(event.name)}>
							Fire
						</Button>
						<Button size="sm" variant="ghost" onClick={() => this._setParticleEvents(events.filter((_event, candidate) => candidate !== index))}>
							×
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _setParticleEvent(index: number, update: any): void {
		const events = getParticleEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).events;
		if (!update.name?.trim() && update.name !== undefined) {
			return;
		}
		events[index] = { ...events[index], ...update };
		this._setParticleEvents(events);
	}

	private _setParticleEvents(events: any[]): void {
		setParticleEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, events }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _triggerParticleEvent(name: string): void {
		const result = triggerParticleEvent(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, eventName: name }, { editor: this.props.editor });
		toast.success(`Fired ${name}: ${result.totalCount} particles.`);
	}

	private _getGpuParticleCollisionEventsInspector(): ReactNode {
		const result = getGpuParticleCollisionEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id });
		const configuration = result.configuration;
		const runtime = result.runtime;
		return (
			<div className="space-y-2">
				<div className={`px-2 text-xs ${runtime.supported ? "text-muted-foreground" : "text-amber-400"}`}>
					{runtime.backend} · {runtime.executionModel}
				</div>
				{runtime.unsupportedReason && <div className="px-2 text-xs text-amber-400">{runtime.unsupportedReason}</div>}
				<EditorInspectorSwitchField
					noUndoRedo
					object={configuration}
					property="enabled"
					label="Enabled"
					onChange={(enabled) => this._setGpuParticleCollisionEvents({ enabled })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="maximumSourceParticles"
					label="Source Particles"
					min={1}
					max={2048}
					step={1}
					onFinishChange={(maximumSourceParticles) => this._setGpuParticleCollisionEvents({ maximumSourceParticles })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="spawnCount"
					label="Spawn Per Collision"
					min={1}
					max={4}
					step={1}
					onFinishChange={(spawnCount) => this._setGpuParticleCollisionEvents({ spawnCount })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="lifetime"
					label="Event Lifetime"
					min={0.001}
					max={3600}
					onFinishChange={(lifetime) => this._setGpuParticleCollisionEvents({ lifetime })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="speed"
					label="Event Speed"
					min={0}
					max={100000}
					onFinishChange={(speed) => this._setGpuParticleCollisionEvents({ speed })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="size"
					label="Event Size"
					min={0.0001}
					max={100000}
					onFinishChange={(size) => this._setGpuParticleCollisionEvents({ size })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="inheritVelocity"
					label="Inherit Velocity"
					min={0}
					max={1}
					step={0.05}
					onFinishChange={(inheritVelocity) => this._setGpuParticleCollisionEvents({ inheritVelocity })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="spread"
					label="Spread"
					min={0}
					max={1}
					step={0.05}
					onFinishChange={(spread) => this._setGpuParticleCollisionEvents({ spread })}
				/>
				<input
					className="mx-2 h-8 w-[calc(100%-1rem)] rounded-md border border-input bg-background px-2 text-xs"
					defaultValue={configuration.color.join(", ")}
					aria-label="GPU collision event RGBA color"
					onBlur={(event) => this._setGpuParticleCollisionEventColor(event.target.value)}
				/>
				<div className="px-2 text-xs text-muted-foreground">
					Compiled: {runtime.lastCompiledWithEvents ? "yes" : "no"} · native dispatches: {runtime.nativeDispatchCount} · reserved: {runtime.reservedOutputParticles} ·
					capacity: {runtime.requiredParticleCapacity} · event texture:{" "}
					{runtime.eventTextureReady ? runtime.eventTextureSize.join("×") : runtime.backend === "webgpu-compute" ? "storage buffer" : "n/a"} · captures:{" "}
					{runtime.eventCaptureCount} · readback: none
				</div>
			</div>
		);
	}

	private _setGpuParticleCollisionEventColor(value: string): void {
		const color = value.split(",").map((part) => Number(part.trim()));
		if (color.length !== 4 || color.some((component) => !Number.isFinite(component) || component < 0 || component > 1)) {
			toast.error("Collision-event color requires four comma-separated values from 0 to 1.");
			return;
		}
		this._setGpuParticleCollisionEvents({ color });
	}

	private _setGpuParticleCollisionEvents(update: Record<string, unknown>): void {
		try {
			setGpuParticleCollisionEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to update native GPU collision events.");
		}
	}

	private _getCollisionSpheresInspector(): ReactNode {
		const result = getParticleCollisionSpheres(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id });
		const spheres = result.spheres as Array<{ center: number[]; radius: number; restitution: number }>;
		return (
			<div className="space-y-2">
				<div className="px-2 text-xs text-muted-foreground">
					{result.runtime.backend} · {result.runtime.executionModel}
				</div>
				<div className="flex gap-2">
					<Button
						variant="secondary"
						className="flex-1"
						disabled={spheres.length >= 8}
						onClick={() => this._setCollisionSpheres([...spheres, { center: [0, 0, 0], radius: 50, restitution: 0.5 }])}
					>
						Add Origin Sphere
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!spheres.length} onClick={() => this._setCollisionSpheres([])}>
						Clear ({spheres.length})
					</Button>
				</div>
				{spheres.map((sphere, index) => (
					<div key={index} className="grid grid-cols-[minmax(0,1fr)_4rem_3.5rem_auto] items-center gap-1">
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={sphere.center.join(", ")}
							aria-label={`GPU particle collision sphere ${index + 1} center`}
							onBlur={(event) => this._setCollisionSphereVector(index, event.target.value)}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={sphere}
							property="radius"
							label=""
							min={0.0001}
							onFinishChange={(radius) => this._setCollisionSphere(index, { radius })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={sphere}
							property="restitution"
							label=""
							min={0}
							max={1}
							step={0.1}
							onFinishChange={(restitution) => this._setCollisionSphere(index, { restitution })}
						/>
						<Button size="sm" variant="ghost" onClick={() => this._setCollisionSpheres(spheres.filter((_sphere, candidate) => candidate !== index))}>
							×
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _getGpuParticleInteractionsInspector(): ReactNode {
		const result = getGpuParticleInteractions(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id });
		const configuration = result.configuration;
		const runtime = result.runtime;
		return (
			<div className="space-y-2">
				<div className={`px-2 text-xs ${runtime.supported ? "text-muted-foreground" : "text-amber-400"}`}>
					{runtime.backend} · {runtime.executionModel}
				</div>
				{runtime.unsupportedReason && <div className="px-2 text-xs text-amber-400">{runtime.unsupportedReason}</div>}
				<EditorInspectorSwitchField
					noUndoRedo
					object={configuration}
					property="enabled"
					label="Enabled"
					onChange={(enabled) => this._setGpuParticleInteractions({ enabled })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="radius"
					label="Radius (cm)"
					min={0.0001}
					max={100000}
					onFinishChange={(radius) => this._setGpuParticleInteractions({ radius })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="restitution"
					label="Restitution"
					min={0}
					max={1}
					step={0.05}
					onFinishChange={(restitution) => this._setGpuParticleInteractions({ restitution })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="separationStrength"
					label="Separation"
					min={0}
					max={1}
					step={0.05}
					onFinishChange={(separationStrength) => this._setGpuParticleInteractions({ separationStrength })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="maximumParticles"
					label="Maximum Particles"
					min={2}
					max={4096}
					step={1}
					onFinishChange={(maximumParticles) =>
						this._setGpuParticleInteractions({ maximumParticles, maximumNeighbors: Math.min(configuration.maximumNeighbors, maximumParticles - 1) })
					}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="maximumNeighbors"
					label="Maximum Neighbors"
					min={1}
					max={Math.min(64, configuration.maximumParticles - 1)}
					step={1}
					onFinishChange={(maximumNeighbors) => this._setGpuParticleInteractions({ maximumNeighbors })}
				/>
				<div className="grid grid-cols-2 gap-1 px-2">
					<input
						className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
						defaultValue={configuration.boundsMin.join(", ")}
						aria-label="GPU particle occupancy bounds minimum"
						onBlur={(event) => this._setGpuParticleInteractionBounds("boundsMin", event.target.value)}
					/>
					<input
						className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
						defaultValue={configuration.boundsMax.join(", ")}
						aria-label="GPU particle occupancy bounds maximum"
						onBlur={(event) => this._setGpuParticleInteractionBounds("boundsMax", event.target.value)}
					/>
				</div>
				<EditorInspectorNumberField
					noUndoRedo
					object={configuration}
					property="gridResolution"
					label="WebGL Grid"
					min={4}
					max={64}
					step={1}
					onFinishChange={(gridResolution) => this._setGpuParticleInteractions({ gridResolution })}
				/>
				<div className="px-2 text-xs text-muted-foreground">
					Compiled: {runtime.lastCompiledWithInteractions ? "yes" : "no"} · native dispatches: {runtime.nativeDispatchCount} · active limit: {runtime.activeParticleLimit}{" "}
					· pair tests: {runtime.pairTestUpperBound} · occupancy:{" "}
					{runtime.occupancyFieldReady ? `${runtime.occupancyGridResolution}³ / ${runtime.occupancyTextureSize.join("×")}` : "n/a"} · samples:{" "}
					{runtime.occupancySampleUpperBound}
				</div>
			</div>
		);
	}

	private _setGpuParticleInteractionBounds(property: "boundsMin" | "boundsMax", value: string): void {
		const vector = value.split(",").map((part) => Number(part.trim()));
		if (vector.length !== 3 || vector.some((coordinate) => !Number.isFinite(coordinate))) {
			toast.error("Occupancy bounds require three comma-separated finite numbers.");
			return;
		}
		this._setGpuParticleInteractions({ [property]: vector });
	}

	private _setGpuParticleInteractions(update: Record<string, unknown>): void {
		try {
			setGpuParticleInteractions(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to update native GPU particle interactions.");
		}
	}

	private _getGpuTextureVectorFieldsInspector(): ReactNode {
		const result = getParticleTextureVectorFields(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id });
		const fields = result.fields as Array<{
			min: number[];
			max: number[];
			strength: number;
			width: number;
			height: number;
			depth?: number;
			vectors: number[];
			sourcePath: string;
			enabled?: boolean;
		}>;
		const runtime = result.runtime;
		return (
			<div className="space-y-2">
				<div className={`px-2 text-xs ${runtime.supported ? "text-muted-foreground" : "text-amber-400"}`}>
					{runtime.backend} · {runtime.executionModel}
				</div>
				{runtime.unsupportedReason && <div className="px-2 text-xs text-amber-400">{runtime.unsupportedReason}</div>}
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" disabled={fields.length >= 8} onClick={() => this._addGpuTextureVectorField(fields)}>
						Add Constant Field
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!fields.length} onClick={() => this._setGpuTextureVectorFields([])}>
						Clear ({fields.length})
					</Button>
				</div>
				{fields.map((field, index) => {
					const enabled = { value: field.enabled !== false };
					return (
						<div key={index} className="space-y-1 rounded-md border border-border/50 p-2">
							<div className="flex items-center gap-1">
								<div className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={field.sourcePath}>
									{field.sourcePath || `Embedded field ${index + 1}`} · {field.width}×{field.height}×{field.depth ?? 1}
								</div>
								<Button size="sm" variant="ghost" onClick={() => this._setGpuTextureVectorFields(fields.filter((_field, candidate) => candidate !== index))}>
									×
								</Button>
							</div>
							<EditorInspectorSwitchField
								noUndoRedo
								object={enabled}
								property="value"
								label="Enabled"
								onChange={(value) => this._setGpuTextureVectorField(index, { enabled: value })}
							/>
							<EditorInspectorNumberField
								noUndoRedo
								object={field}
								property="strength"
								label="Strength"
								onFinishChange={(strength) => this._setGpuTextureVectorField(index, { strength })}
							/>
							<div className="grid grid-cols-2 gap-1">
								<input
									className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
									defaultValue={field.min.join(", ")}
									aria-label={`GPU texture vector field ${index + 1} bounds minimum`}
									onBlur={(event) => this._setGpuTextureVectorFieldBounds(index, "min", event.target.value)}
								/>
								<input
									className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
									defaultValue={field.max.join(", ")}
									aria-label={`GPU texture vector field ${index + 1} bounds maximum`}
									onBlur={(event) => this._setGpuTextureVectorFieldBounds(index, "max", event.target.value)}
								/>
							</div>
						</div>
					);
				})}
				<div className="px-2 text-xs text-muted-foreground">
					Compiled: {runtime.lastCompiledWithVectorFields ? "yes" : "no"} · native dispatches: {runtime.nativeDispatchCount} · fields: {runtime.fieldCount} · atlas:{" "}
					{runtime.atlasReady ? runtime.atlasDimensions.join("×") : "n/a"} · voxels: {runtime.atlasVoxelCount} · samples: {runtime.sampleUpperBound} · readback: none
				</div>
				<div className="px-2 text-[11px] text-muted-foreground">Use create_particle_texture_vector_field to import one RGB image or an ordered 3D slice stack.</div>
			</div>
		);
	}

	private _addGpuTextureVectorField(fields: any[]): void {
		this._setGpuTextureVectorFields([
			...fields,
			{
				min: [-50, -50, -50],
				max: [50, 50, 50],
				strength: 10,
				width: 1,
				height: 1,
				depth: 1,
				vectors: [1, 0, 0],
				sourcePath: "generated://constant-x",
				enabled: true,
			},
		]);
	}

	private _setGpuTextureVectorFieldBounds(index: number, property: "min" | "max", value: string): void {
		const vector = value.split(",").map((part) => Number(part.trim()));
		if (vector.length !== 3 || vector.some((coordinate) => !Number.isFinite(coordinate))) {
			toast.error("Vector-field bounds require three comma-separated finite numbers.");
			return;
		}
		this._setGpuTextureVectorField(index, { [property]: vector });
	}

	private _setGpuTextureVectorField(index: number, update: Record<string, unknown>): void {
		const fields = getParticleTextureVectorFields(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).fields;
		fields[index] = { ...fields[index], ...update };
		this._setGpuTextureVectorFields(fields);
	}

	private _setGpuTextureVectorFields(fields: any[]): void {
		try {
			setParticleTextureVectorFields(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, fields }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to update native GPU texture vector fields.");
		}
	}

	private _getCollisionPlanesInspector(): ReactNode {
		const result = getParticleCollisionPlanes(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id });
		const planes = result.planes as Array<{ position: number[]; normal: number[]; restitution: number }>;
		return (
			<div className="space-y-2">
				<div className="px-2 text-xs text-muted-foreground">
					{result.runtime.backend} · {result.runtime.executionModel}
				</div>
				<div className="flex gap-2">
					<Button
						variant="secondary"
						className="flex-1"
						disabled={planes.length >= 8}
						onClick={() => this._setCollisionPlanes([...planes, { position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }])}
					>
						Add Ground Plane
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!planes.length} onClick={() => this._setCollisionPlanes([])}>
						Clear ({planes.length})
					</Button>
				</div>
				{planes.map((plane, index) => (
					<div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem_auto] items-center gap-1">
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={plane.position.join(", ")}
							aria-label={`GPU particle collision plane ${index + 1} position`}
							onBlur={(event) => this._setCollisionPlaneVector(index, "position", event.target.value)}
						/>
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={plane.normal.join(", ")}
							aria-label={`GPU particle collision plane ${index + 1} normal`}
							onBlur={(event) => this._setCollisionPlaneVector(index, "normal", event.target.value)}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={plane}
							property="restitution"
							label=""
							min={0}
							max={1}
							step={0.1}
							onFinishChange={(restitution) => this._setCollisionPlane(index, { restitution })}
						/>
						<Button size="sm" variant="ghost" onClick={() => this._setCollisionPlanes(planes.filter((_plane, candidate) => candidate !== index))}>
							×
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _setCollisionSphereVector(index: number, value: string): void {
		const center = value.split(",").map((part) => Number(part.trim()));
		if (center.length !== 3 || center.some((coordinate) => !Number.isFinite(coordinate))) {
			return;
		}
		this._setCollisionSphere(index, { center });
	}

	private _setCollisionSphere(index: number, update: any): void {
		const spheres = getParticleCollisionSpheres(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).spheres;
		spheres[index] = { ...spheres[index], ...update };
		this._setCollisionSpheres(spheres);
	}

	private _setCollisionSpheres(spheres: any[]): void {
		setParticleCollisionSpheres(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, spheres }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setCollisionPlaneVector(index: number, property: "position" | "normal", value: string): void {
		const vector = value.split(",").map((part) => Number(part.trim()));
		if (vector.length !== 3 || vector.some((coordinate) => !Number.isFinite(coordinate))) {
			return;
		}
		this._setCollisionPlane(index, { [property]: vector });
	}

	private _setCollisionPlane(index: number, update: any): void {
		const planes = getParticleCollisionPlanes(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).planes;
		planes[index] = { ...planes[index], ...update };
		this._setCollisionPlanes(planes);
	}

	private _setCollisionPlanes(planes: any[]): void {
		setParticleCollisionPlanes(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, planes }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _getCapacityInspector(): ReactNode {
		const o = {
			capacity: this.props.object.getCapacity(),
		};

		const onCapacityChanged = (value: number) => {
			this.props.object["_capacity"] = value >> 0;
			this.props.object.reset();
			this.props.object["_reset"]();
		};

		return (
			<EditorInspectorNumberField
				noUndoRedo
				object={o}
				property="capacity"
				label="Capacity"
				min={1}
				max={1_000_000}
				step={100}
				onFinishChange={(value) => {
					value = value >> 0;
					const oldValue = this.props.object.getCapacity();

					if (value === oldValue) {
						return;
					}

					registerUndoRedo({
						executeRedo: true,
						undo: () => onCapacityChanged(oldValue),
						redo: () => onCapacityChanged(value),
					});
				}}
			/>
		);
	}

	private _getRandomTextureSizeInspector(): ReactNode {
		this._randomTextureSize = this.props.object._randomTexture.getSize().width ?? 1024;

		const onRandomTextureSizeChanged = (value: number) => {
			const texture1 = createGpuParticleSystemRandomTexture(value, this.props.editor.layout.preview.scene);
			const texture2 = createGpuParticleSystemRandomTexture(value, this.props.editor.layout.preview.scene);

			texture1.name = this.props.object._randomTexture.name;
			texture2.name = this.props.object._randomTexture2.name;

			this.props.object._randomTexture.dispose();
			this.props.object._randomTexture2.dispose();

			this.props.object._randomTexture = texture1;
			this.props.object._randomTexture2 = texture2;
		};

		return (
			<EditorInspectorListField object={this} property="_randomTextureSize" label="Random Texture Size" onChange={(v) => onRandomTextureSizeChanged(v)} items={this._sizes} />
		);
	}

	private _getEmitterTypeInspector(): ReactNode {
		const o = {
			particleEmitterType: this.props.object.particleEmitterType.getClassName(),
		};

		const emitter = this.props.object.particleEmitterType;

		return (
			<EditorInspectorSectionField title="Emitter">
				<EditorInspectorListField
					noUndoRedo
					object={o}
					property="particleEmitterType"
					label="Type"
					items={[
						{ text: "Box", value: "BoxParticleEmitter" },
						{ text: "Cone", value: "ConeParticleEmitter" },
						{ text: "Cone Directed", value: "ConeDirectedParticleEmitter" },
						{ text: "Cylinder", value: "CylinderParticleEmitter" },
						{ text: "Cylinder Directed", value: "CylinderDirectedParticleEmitter" },
						{ text: "Sphere", value: "SphereParticleEmitter" },
						{ text: "Sphere Directed", value: "SphereDirectedParticleEmitter" },
						{ text: "Point", value: "PointParticleEmitter" },
						{ text: "Hemispheric", value: "HemisphericParticleEmitter" },
					]}
					onChange={(value) => {
						let emitterType: IParticleEmitterType | null = null;

						switch (value) {
							case "BoxParticleEmitter":
								emitterType = new BoxParticleEmitter();
								break;
							case "ConeParticleEmitter":
								emitterType = new ConeParticleEmitter();
								break;
							case "ConeDirectedParticleEmitter":
								emitterType = new ConeDirectedParticleEmitter();
								break;
							case "CylinderParticleEmitter":
								emitterType = new CylinderParticleEmitter();
								break;
							case "CylinderDirectedParticleEmitter":
								emitterType = new CylinderDirectedParticleEmitter();
								break;
							case "SphereParticleEmitter":
								emitterType = new SphereParticleEmitter();
								break;
							case "SphereDirectedParticleEmitter":
								emitterType = new SphereDirectedParticleEmitter();
								break;
							case "PointParticleEmitter":
								emitterType = new PointParticleEmitter();
								break;
							case "HemisphericParticleEmitter":
								emitterType = new HemisphericParticleEmitter();
								break;
							case "MeshParticleEmitter":
								emitterType = new MeshParticleEmitter();
								break;
						}

						if (emitterType) {
							const currentEmitter = this.props.object.particleEmitterType;
							registerUndoRedo({
								executeRedo: true,
								undo: () => (this.props.object.particleEmitterType = currentEmitter),
								redo: () => (this.props.object.particleEmitterType = emitterType),
							});

							this.forceUpdate();
						}
					}}
				/>

				{emitter.getClassName() === "BoxParticleEmitter" && (
					<>
						<EditorInspectorBlockField>
							<div className="px-2">Direction</div>
							<EditorInspectorVectorField grayLabel object={emitter} property="direction1" label="Min" />
							<EditorInspectorVectorField grayLabel object={emitter} property="direction2" label="Max" />
						</EditorInspectorBlockField>

						<EditorInspectorBlockField>
							<div className="px-2">Emit Box</div>
							<EditorInspectorVectorField grayLabel object={emitter} property="minEmitBox" label="Min" />
							<EditorInspectorVectorField grayLabel object={emitter} property="maxEmitBox" label="Max" />
						</EditorInspectorBlockField>
					</>
				)}

				{(emitter.getClassName() === "ConeParticleEmitter" || emitter.getClassName() === "ConeDirectedParticleEmitter") && (
					<>
						<EditorInspectorNumberField object={emitter} property="radius" label="Radius" />
						<EditorInspectorNumberField object={emitter} property="angle" label="Angle" />

						<EditorInspectorNumberField object={emitter} property="radiusRange" label="Radius Range" />
						<EditorInspectorNumberField object={emitter} property="heightRange" label="Height Range" />

						<EditorInspectorSwitchField object={emitter} property="emitFromSpawnPointOnly" label="Emit From Spawn Point Only" />

						{emitter.getClassName() === "ConeDirectedParticleEmitter" && (
							<>
								<EditorInspectorBlockField>
									<div className="px-2">Direction</div>
									<EditorInspectorVectorField grayLabel object={emitter} property="direction1" label="Min" />
									<EditorInspectorVectorField grayLabel object={emitter} property="direction2" label="Max" />
								</EditorInspectorBlockField>
							</>
						)}
					</>
				)}

				{(emitter.getClassName() === "CylinderParticleEmitter" || emitter.getClassName() === "CylinderDirectedParticleEmitter") && (
					<>
						<EditorInspectorNumberField object={emitter} property="radius" label="Radius" />
						<EditorInspectorNumberField object={emitter} property="height" label="Height" />

						<EditorInspectorNumberField object={emitter} property="radiusRange" label="Radius Range" />
						<EditorInspectorNumberField object={emitter} property="directionRandomizer" label="Direction Randomizer" />

						{emitter.getClassName() === "CylinderDirectedParticleEmitter" && (
							<>
								<EditorInspectorBlockField>
									<div className="px-2">Direction</div>
									<EditorInspectorVectorField grayLabel object={emitter} property="direction1" label="Min" />
									<EditorInspectorVectorField grayLabel object={emitter} property="direction2" label="Max" />
								</EditorInspectorBlockField>
							</>
						)}
					</>
				)}

				{(emitter.getClassName() === "SphereParticleEmitter" || emitter.getClassName() === "SphereDirectedParticleEmitter") && (
					<>
						<EditorInspectorNumberField object={emitter} property="radius" label="Radius" />
						<EditorInspectorNumberField object={emitter} property="radiusRange" label="Radius Range" />
						<EditorInspectorNumberField object={emitter} property="directionRandomizer" label="Direction Randomizer" />

						{emitter.getClassName() === "SphereDirectedParticleEmitter" && (
							<>
								<EditorInspectorBlockField>
									<div className="px-2">Direction</div>
									<EditorInspectorVectorField grayLabel object={emitter} property="direction1" label="Min" />
									<EditorInspectorVectorField grayLabel object={emitter} property="direction2" label="Max" />
								</EditorInspectorBlockField>
							</>
						)}
					</>
				)}

				{emitter.getClassName() === "PointParticleEmitter" && (
					<>
						<EditorInspectorBlockField>
							<div className="px-2">Direction</div>
							<EditorInspectorVectorField grayLabel object={emitter} property="direction1" label="Min" />
							<EditorInspectorVectorField grayLabel object={emitter} property="direction2" label="Max" />
						</EditorInspectorBlockField>
					</>
				)}

				{emitter.getClassName() === "HemisphericParticleEmitter" && (
					<>
						<EditorInspectorNumberField object={emitter} property="radius" label="Radius" />
						<EditorInspectorNumberField object={emitter} property="radiusRange" label="Radius Range" />
						<EditorInspectorNumberField object={emitter} property="directionRandomizer" label="Direction Randomizer" />
					</>
				)}
			</EditorInspectorSectionField>
		);
	}
}
