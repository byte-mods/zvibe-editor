import { Component, ReactNode } from "react";

import { IoPlay, IoStop, IoRefresh } from "react-icons/io5";

import { toast } from "sonner";

import {
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
import { isParticleSystem } from "../../../../tools/guards/particles";
import { onParticleSystemModifiedObservable } from "../../../../tools/observables";

import { getParticleAttractors, setParticleAttractors, validateParticleSystem } from "../../../../mcp/particles/particles";
import { getParticleCollisionPlanes, getParticleCollisionSpheres, setParticleCollisionPlanes, setParticleCollisionSpheres } from "../../../../mcp/particles/collisions";
import { getParticleVectorFields, setParticleVectorFields } from "../../../../mcp/particles/vector-fields";
import { getParticleEvents, setParticleEvents, triggerParticleEvent } from "../../../../mcp/particles/events";
import { getParticleProximityEvents, setParticleProximityEvents } from "../../../../mcp/particles/proximity-events";

import { EditorInspectorListField } from "../fields/list";
import { EditorInspectorColorField } from "../fields/color";
import { EditorInspectorBlockField } from "../fields/block";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorVectorField } from "../fields/vector";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorSectionField } from "../fields/section";
import { EditorInspectorTextureField } from "../fields/texture";

import { IEditorInspectorImplementationProps } from "../inspector";

import { ParticleSystemGradientInspector } from "./property-gradient";

export interface IEditorParticleSystemInspectorState {
	started: boolean;
}

export class EditorParticleSystemInspector extends Component<IEditorInspectorImplementationProps<ParticleSystem>, IEditorParticleSystemInspectorState> {
	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: unknown): boolean {
		return isParticleSystem(object);
	}

	private _stoppedObserver: Observer<ParticleSystem> | null = null;

	public constructor(props: IEditorInspectorImplementationProps<ParticleSystem>) {
		super(props);

		this.state = {
			started: props.object.isAlive(),
		};
	}

	public componentDidMount(): void {
		this._stoppedObserver = this.props.object.onStoppedObservable.add(() => {
			this.setState({
				started: false,
			});
		});
	}

	public componentWillUnmount(): void {
		if (this._stoppedObserver) {
			this.props.object.onStoppedObservable.remove(this._stoppedObserver);
			this._stoppedObserver = null;
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

				<EditorInspectorSectionField
					title="VFX Force Fields"
					tooltip="Native particle attractors. Positive strength pulls particles in; negative strength repels them. These use the same persisted configuration as the VFX MCP tools."
				>
					{this._getAttractorsInspector()}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="VFX Events" tooltip="Named gameplay-triggered bursts. These work for both CPU and GPU particles and export with the scene.">
					{this._getParticleEventsInspector()}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="VFX Proximity Bursts"
					tooltip="CPU-only particle-to-particle bursts. When a source particle is within the configured radius of a target-system particle, the target emits the configured count. These export with the scene."
				>
					{this._isCpuParticleSystem() ? (
						this._getParticleProximityEventsInspector()
					) : (
						<div className="px-2 text-xs text-muted-foreground">Proximity bursts are currently available for CPU particle systems only.</div>
					)}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="VFX Vector Fields"
					tooltip="CPU-only bounded directional fields. A field adds its direction × strength inside its local world-space min/max box and exports with the scene."
				>
					{this._isCpuParticleSystem() ? (
						this._getVectorFieldsInspector()
					) : (
						<div className="px-2 text-xs text-muted-foreground">Vector fields are currently available for CPU particle systems only.</div>
					)}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Particle Collision Spheres"
					tooltip="CPU particle collision volumes. Particles inside a sphere are projected to its surface and reflected using the configured restitution."
				>
					{this._isCpuParticleSystem() ? (
						this._getCollisionSpheresInspector()
					) : (
						<div className="px-2 text-xs text-muted-foreground">Collision spheres are currently available for CPU particle systems only.</div>
					)}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Particle Collision Planes"
					tooltip="CPU particle collision planes. Particles crossing the plane's normal side are projected back and reflected using the configured restitution."
				>
					{this._isCpuParticleSystem() ? (
						this._getCollisionPlanesInspector()
					) : (
						<div className="px-2 text-xs text-muted-foreground">Collision planes are currently available for CPU particle systems only.</div>
					)}
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

				<EditorInspectorSectionField title="Transforms">
					<EditorInspectorVectorField object={this.props.object} property="worldOffset" label="Offset" />
					<EditorInspectorVectorField object={this.props.object} property="gravity" label="Gravity" />

					<EditorInspectorSwitchField object={this.props.object} property="isLocal" label="Is Local" onChange={() => this.forceUpdate()} />
					<EditorInspectorSwitchField object={this.props.object} property="isBillboardBased" label="Is Billboard Based" onChange={() => this.forceUpdate()} />

					{this.props.object.isBillboardBased && (
						<EditorInspectorListField
							object={this.props.object}
							property="billboardMode"
							label="Billboard Mode"
							items={[
								{ text: "All", value: ParticleSystem.BILLBOARDMODE_ALL },
								{ text: "Y", value: ParticleSystem.BILLBOARDMODE_Y },
								{ text: "Stretched", value: ParticleSystem.BILLBOARDMODE_STRETCHED },
								{ text: "Stretched Local", value: ParticleSystem.BILLBOARDMODE_STRETCHED_LOCAL },
							]}
						/>
					)}
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

					<ParticleSystemGradientInspector
						title="Angular Speed"
						label="Use Angular Speed Gradients"
						particleSystem={this.props.object}
						getGradients={() => this.props.object.getAngularSpeedGradients()}
						createGradient={() => this.props.object.addAngularSpeedGradient(0, this.props.object.minAngularSpeed, this.props.object.maxAngularSpeed)}
						addGradient={(gradient, value1, value2) => this.props.object.addAngularSpeedGradient(gradient, value1, value2)}
						removeGradient={(gradient) => this.props.object.removeAngularSpeedGradient(gradient)}
						onUpdate={() => this.forceUpdate()}
					>
						<div className="flex items-center">
							<EditorInspectorNumberField grayLabel asDegrees object={this.props.object} property="minAngularSpeed" label="Min" step={0.1} />
							<EditorInspectorNumberField grayLabel asDegrees object={this.props.object} property="maxAngularSpeed" label="Max" step={0.1} />
						</div>
					</ParticleSystemGradientInspector>

					<ParticleSystemGradientInspector
						title="Size"
						label="Use Size Gradients"
						particleSystem={this.props.object}
						getGradients={() => this.props.object.getSizeGradients()}
						createGradient={() => this.props.object.addSizeGradient(0, this.props.object.minSize, this.props.object.maxSize)}
						addGradient={(gradient, value1, value2) => this.props.object.addSizeGradient(gradient, value1, value2)}
						removeGradient={(gradient) => this.props.object.removeSizeGradient(gradient)}
						onUpdate={() => this.forceUpdate()}
					>
						<div className="flex items-center">
							<EditorInspectorNumberField grayLabel object={this.props.object} property="minSize" label="Min" min={0} />
							<EditorInspectorNumberField grayLabel object={this.props.object} property="maxSize" label="Max" min={0} />
						</div>
					</ParticleSystemGradientInspector>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Colors">
					<ParticleSystemGradientInspector
						title=""
						label="Use Color Gradients"
						particleSystem={this.props.object}
						getGradients={() => this.props.object.getColorGradients()}
						createGradient={() => this.props.object.addColorGradient(0, this.props.object.color1.clone(), this.props.object.color2.clone())}
						addGradient={(gradient, value1, value2) => this.props.object.addColorGradient(gradient, value1, value2)}
						removeGradient={(gradient) => this.props.object.removeColorGradient(gradient)}
						onUpdate={() => this.forceUpdate()}
					>
						<EditorInspectorColorField object={this.props.object} property="color1" label="Color 1" />
						<EditorInspectorColorField object={this.props.object} property="color2" label="Color 2" />
						<EditorInspectorColorField object={this.props.object} property="colorDead" label="Dead" />
					</ParticleSystemGradientInspector>
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
		if (result.valid) toast.success(`Particle system valid${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : ""}.`);
		else toast.error(result.errors.join("\n"));
	}

	private _getAttractorsInspector(): ReactNode {
		const attractors = getParticleAttractors(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).attractors as Array<{
			position: number[];
			strength: number;
		}>;
		return (
			<div className="space-y-2">
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" disabled={attractors.length >= 16} onClick={() => this._addAttractor()}>
						Add Origin Attractor
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!attractors.length} onClick={() => this._clearAttractors()}>
						Clear ({attractors.length})
					</Button>
				</div>
				{attractors.map((attractor, index) => (
					<div key={index} className="grid grid-cols-[minmax(0,1fr)_5rem_auto] items-center gap-1">
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={attractor.position.join(", ")}
							aria-label={`Particle force field ${index + 1} position`}
							onBlur={(event) => this._setAttractorPosition(index, event.target.value)}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={attractor}
							property="strength"
							label=""
							step={0.1}
							onFinishChange={(value) => this._setAttractorStrength(index, value)}
						/>
						<Button size="sm" variant="ghost" onClick={() => this._removeAttractor(index)}>
							×
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _getParticleEventsInspector(): ReactNode {
		const events = getParticleEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).events as Array<{
			name: string;
			count: number;
			enabled?: boolean;
		}>;
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
							aria-label={`Particle event ${index + 1} name`}
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
		if (!update.name?.trim() && update.name !== undefined) return;
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

	private _getParticleProximityEventsInspector(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const events = getParticleProximityEvents(scene, { particleSystemId: this.props.object.id }).events as Array<{
			targetParticleSystemId: string;
			radius: number;
			count: number;
			cooldownMs?: number;
		}>;
		const targets = scene.particleSystems.filter((system) => system.id !== this.props.object.id);
		return (
			<div className="space-y-2">
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" disabled={events.length >= 8 || !targets.length} onClick={() => this._addParticleProximityEvent()}>
						Add Proximity Burst
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!events.length} onClick={() => this._setParticleProximityEvents([])}>
						Clear ({events.length})
					</Button>
				</div>
				{!targets.length && <div className="px-2 text-xs text-muted-foreground">Add another particle system to use it as the burst target.</div>}
				{events.map((event, index) => (
					<div key={index} className="grid grid-cols-[minmax(0,1fr)_4rem_3.5rem_4rem_auto] items-center gap-1">
						<select
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							value={event.targetParticleSystemId}
							aria-label={`Particle proximity burst ${index + 1} target`}
							onChange={(input) => this._setParticleProximityEvent(index, { targetParticleSystemId: input.target.value })}
						>
							{targets.map((target) => (
								<option key={target.id} value={target.id}>
									{target.name}
								</option>
							))}
						</select>
						<EditorInspectorNumberField
							noUndoRedo
							object={event}
							property="radius"
							label=""
							min={0.0001}
							step={0.1}
							onFinishChange={(radius) => this._setParticleProximityEvent(index, { radius })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={event}
							property="count"
							label=""
							min={1}
							step={1}
							onFinishChange={(count) => this._setParticleProximityEvent(index, { count })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={event}
							property="cooldownMs"
							label=""
							min={0}
							max={60000}
							step={10}
							onFinishChange={(cooldownMs) => this._setParticleProximityEvent(index, { cooldownMs })}
						/>
						<Button size="sm" variant="ghost" onClick={() => this._setParticleProximityEvents(events.filter((_event, candidate) => candidate !== index))}>
							×
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _addParticleProximityEvent(): void {
		const target = this.props.editor.layout.preview.scene.particleSystems.find((system) => system.id !== this.props.object.id);
		if (!target) return;
		const events = getParticleProximityEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).events;
		this._setParticleProximityEvents([...events, { targetParticleSystemId: target.id, radius: 1, count: 10, cooldownMs: 100 }]);
	}

	private _setParticleProximityEvent(index: number, update: any): void {
		const events = getParticleProximityEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).events;
		events[index] = { ...events[index], ...update };
		this._setParticleProximityEvents(events);
	}

	private _setParticleProximityEvents(events: any[]): void {
		setParticleProximityEvents(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, events }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _addAttractor(): void {
		const scene = this.props.editor.layout.preview.scene;
		const attractors = getParticleAttractors(scene, { particleSystemId: this.props.object.id }).attractors;
		setParticleAttractors(scene, { particleSystemId: this.props.object.id, attractors: [...attractors, { position: [0, 0, 0], strength: 1 }] }, { editor: this.props.editor });
	}

	private _clearAttractors(): void {
		setParticleAttractors(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, attractors: [] }, { editor: this.props.editor });
	}

	private _setAttractorPosition(index: number, value: string): void {
		const position = value.split(",").map((part) => Number(part.trim()));
		if (position.length !== 3 || position.some((coordinate) => !Number.isFinite(coordinate))) return;
		this._setAttractor(index, { position });
	}

	private _setAttractorStrength(index: number, strength: number): void {
		if (!Number.isFinite(strength)) return;
		this._setAttractor(index, { strength });
	}

	private _removeAttractor(index: number): void {
		const scene = this.props.editor.layout.preview.scene;
		const attractors = getParticleAttractors(scene, { particleSystemId: this.props.object.id }).attractors;
		setParticleAttractors(
			scene,
			{ particleSystemId: this.props.object.id, attractors: attractors.filter((_: unknown, candidate: number) => candidate !== index) },
			{ editor: this.props.editor }
		);
	}

	private _setAttractor(index: number, update: any): void {
		const scene = this.props.editor.layout.preview.scene;
		const attractors = getParticleAttractors(scene, { particleSystemId: this.props.object.id }).attractors;
		attractors[index] = { ...attractors[index], ...update };
		setParticleAttractors(scene, { particleSystemId: this.props.object.id, attractors }, { editor: this.props.editor });
	}

	private _isCpuParticleSystem(): boolean {
		return this.props.object.getClassName() !== "GPUParticleSystem";
	}

	private _getVectorFieldsInspector(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const fields = getParticleVectorFields(scene, { particleSystemId: this.props.object.id }).fields as Array<{
			min: number[];
			max: number[];
			direction: number[];
			strength: number;
			enabled?: boolean;
		}>;
		return (
			<div className="space-y-2">
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" disabled={fields.length >= 8} onClick={() => this._addVectorField()}>
						Add Wind Box
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!fields.length} onClick={() => this._setVectorFields([])}>
						Clear ({fields.length})
					</Button>
				</div>
				{fields.map((field, index) => (
					<div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_4rem_auto] items-center gap-1">
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={field.min.join(", ")}
							aria-label={`Vector field ${index + 1} minimum`}
							onBlur={(event) => this._setVectorFieldVector(index, "min", event.target.value)}
						/>
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={field.max.join(", ")}
							aria-label={`Vector field ${index + 1} maximum`}
							onBlur={(event) => this._setVectorFieldVector(index, "max", event.target.value)}
						/>
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={field.direction.join(", ")}
							aria-label={`Vector field ${index + 1} direction`}
							onBlur={(event) => this._setVectorFieldVector(index, "direction", event.target.value)}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={field}
							property="strength"
							label=""
							step={0.1}
							onFinishChange={(value) => this._setVectorField(index, { strength: value })}
						/>
						<Button size="sm" variant="ghost" onClick={() => this._removeVectorField(index)}>
							×
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _addVectorField(): void {
		const fields = getParticleVectorFields(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).fields;
		this._setVectorFields([...fields, { min: [-50, -50, -50], max: [50, 50, 50], direction: [1, 0, 0], strength: 10 }]);
	}

	private _removeVectorField(index: number): void {
		const fields = getParticleVectorFields(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).fields;
		this._setVectorFields(fields.filter((_field: unknown, candidate: number) => candidate !== index));
	}

	private _setVectorFieldVector(index: number, property: "min" | "max" | "direction", value: string): void {
		const vector = value.split(",").map((part) => Number(part.trim()));
		if (vector.length !== 3 || vector.some((coordinate) => !Number.isFinite(coordinate))) return;
		this._setVectorField(index, { [property]: vector });
	}

	private _setVectorField(index: number, update: any): void {
		const fields = getParticleVectorFields(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).fields;
		fields[index] = { ...fields[index], ...update };
		this._setVectorFields(fields);
	}

	private _setVectorFields(fields: any[]): void {
		setParticleVectorFields(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, fields }, { editor: this.props.editor });
	}

	private _getCollisionSpheresInspector(): ReactNode {
		const spheres = getParticleCollisionSpheres(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).spheres as Array<{
			center: number[];
			radius: number;
			restitution: number;
		}>;
		return (
			<div className="space-y-2">
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" disabled={spheres.length >= 8} onClick={() => this._addCollisionSphere()}>
						Add Origin Sphere
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!spheres.length} onClick={() => this._clearCollisionSpheres()}>
						Clear ({spheres.length})
					</Button>
				</div>
				{spheres.map((sphere, index) => (
					<div key={index} className="grid grid-cols-[minmax(0,1fr)_4rem_3.5rem_auto] items-center gap-1">
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={sphere.center.join(", ")}
							aria-label={`Particle collision sphere ${index + 1} center`}
							onBlur={(event) => this._setCollisionSphereVector(index, event.target.value)}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={sphere}
							property="radius"
							label=""
							min={0.0001}
							onFinishChange={(value) => this._setCollisionSphereNumber(index, "radius", value)}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={sphere}
							property="restitution"
							label=""
							min={0}
							max={1}
							step={0.1}
							onFinishChange={(value) => this._setCollisionSphereNumber(index, "restitution", value)}
						/>
						<Button size="sm" variant="ghost" onClick={() => this._removeCollisionSphere(index)}>
							×
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _getCollisionPlanesInspector(): ReactNode {
		const planes = getParticleCollisionPlanes(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id }).planes as Array<{
			position: number[];
			normal: number[];
			restitution: number;
		}>;
		return (
			<div className="space-y-2">
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" disabled={planes.length >= 8} onClick={() => this._addCollisionPlane()}>
						Add Ground Plane
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!planes.length} onClick={() => this._clearCollisionPlanes()}>
						Clear ({planes.length})
					</Button>
				</div>
				{planes.map((plane, index) => (
					<div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem_auto] items-center gap-1">
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={plane.position.join(", ")}
							aria-label={`Particle collision plane ${index + 1} position`}
							onBlur={(event) => this._setCollisionPlaneVector(index, "position", event.target.value)}
						/>
						<input
							className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
							defaultValue={plane.normal.join(", ")}
							aria-label={`Particle collision plane ${index + 1} normal`}
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
							onFinishChange={(value) => this._setCollisionPlaneRestitution(index, value)}
						/>
						<Button size="sm" variant="ghost" onClick={() => this._removeCollisionPlane(index)}>
							×
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _addCollisionPlane(): void {
		const scene = this.props.editor.layout.preview.scene;
		const planes = getParticleCollisionPlanes(scene, { particleSystemId: this.props.object.id }).planes;
		setParticleCollisionPlanes(
			scene,
			{ particleSystemId: this.props.object.id, planes: [...planes, { position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }] },
			{ editor: this.props.editor }
		);
	}

	private _clearCollisionPlanes(): void {
		setParticleCollisionPlanes(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, planes: [] }, { editor: this.props.editor });
	}

	private _setCollisionPlaneVector(index: number, property: "position" | "normal", value: string): void {
		const vector = value.split(",").map((part) => Number(part.trim()));
		if (vector.length !== 3 || vector.some((coordinate) => !Number.isFinite(coordinate)) || (property === "normal" && !vector.some((coordinate) => coordinate !== 0))) return;
		this._setCollisionPlane(index, { [property]: vector });
	}

	private _setCollisionPlaneRestitution(index: number, restitution: number): void {
		if (!Number.isFinite(restitution) || restitution < 0 || restitution > 1) return;
		this._setCollisionPlane(index, { restitution });
	}

	private _removeCollisionPlane(index: number): void {
		const scene = this.props.editor.layout.preview.scene;
		const planes = getParticleCollisionPlanes(scene, { particleSystemId: this.props.object.id }).planes;
		setParticleCollisionPlanes(
			scene,
			{ particleSystemId: this.props.object.id, planes: planes.filter((_: unknown, candidate: number) => candidate !== index) },
			{ editor: this.props.editor }
		);
	}

	private _setCollisionPlane(index: number, update: any): void {
		const scene = this.props.editor.layout.preview.scene;
		const planes = getParticleCollisionPlanes(scene, { particleSystemId: this.props.object.id }).planes;
		planes[index] = { ...planes[index], ...update };
		setParticleCollisionPlanes(scene, { particleSystemId: this.props.object.id, planes }, { editor: this.props.editor });
	}

	private _addCollisionSphere(): void {
		const scene = this.props.editor.layout.preview.scene;
		const spheres = getParticleCollisionSpheres(scene, { particleSystemId: this.props.object.id }).spheres;
		setParticleCollisionSpheres(
			scene,
			{ particleSystemId: this.props.object.id, spheres: [...spheres, { center: [0, 0, 0], radius: 1, restitution: 0.5 }] },
			{ editor: this.props.editor }
		);
	}

	private _clearCollisionSpheres(): void {
		setParticleCollisionSpheres(this.props.editor.layout.preview.scene, { particleSystemId: this.props.object.id, spheres: [] }, { editor: this.props.editor });
	}

	private _setCollisionSphereVector(index: number, value: string): void {
		const center = value.split(",").map((part) => Number(part.trim()));
		if (center.length !== 3 || center.some((coordinate) => !Number.isFinite(coordinate))) return;
		this._setCollisionSphere(index, { center });
	}

	private _setCollisionSphereNumber(index: number, property: "radius" | "restitution", value: number): void {
		if (!Number.isFinite(value) || (property === "radius" && value <= 0) || (property === "restitution" && (value < 0 || value > 1))) return;
		this._setCollisionSphere(index, { [property]: value });
	}

	private _removeCollisionSphere(index: number): void {
		const scene = this.props.editor.layout.preview.scene;
		const spheres = getParticleCollisionSpheres(scene, { particleSystemId: this.props.object.id }).spheres;
		setParticleCollisionSpheres(
			scene,
			{ particleSystemId: this.props.object.id, spheres: spheres.filter((_: unknown, candidate: number) => candidate !== index) },
			{ editor: this.props.editor }
		);
	}

	private _setCollisionSphere(index: number, update: any): void {
		const scene = this.props.editor.layout.preview.scene;
		const spheres = getParticleCollisionSpheres(scene, { particleSystemId: this.props.object.id }).spheres;
		spheres[index] = { ...spheres[index], ...update };
		setParticleCollisionSpheres(scene, { particleSystemId: this.props.object.id, spheres }, { editor: this.props.editor });
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
				max={10_000}
				step={10}
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
