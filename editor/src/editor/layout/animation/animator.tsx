import { Component, MouseEvent, ReactNode } from "react";

import { Scene, Tools } from "babylonjs";
import { getAnimatorBlendTreeAnimationGroups } from "babylonjs-editor-tools";
import { toast } from "sonner";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import {
	ANIMATOR_ANY_STATE,
	ANIMATOR_EXIT_STATE,
	createAnimatorController,
	deleteAnimatorController,
	deleteAnimatorSubgraph,
	getAnimatorCompiledGraph,
	getAnimatorHumanoidMuscleTraceForController,
	getAnimatorRuntimeDebug,
	listAnimatorControllers,
	setAnimatorController,
	setAnimatorEntryTransitions,
	setAnimatorEntryState,
	setAnimatorLayer,
	setAnimatorLayerState,
	setAnimatorSynchronizedLayerOverrides,
	setAnimatorBlendTree,
	setAnimatorParameter,
	setAnimatorParameterDefinition,
	resetAnimatorTrigger,
	setAnimatorRootMotion,
	setAnimatorHumanoidMuscleTrace,
	setAnimatorRuntimeDebug,
	setAnimatorTrigger,
	stepAnimatorRuntimeDebug,
	setAnimatorStateAvatarMask,
	setAnimatorStateBehaviours,
	setAnimatorStateMask,
	setAnimatorStateGraphPosition,
	setAnimatorState,
	setAnimatorSubgraph,
	setAnimatorSubStateMachine,
} from "../../../mcp/animator/animator";

import { Editor } from "../../main";

interface IAnimatorBlendTreeChild {
	animationGroup?: string;
	blendTree?: IAnimatorBlendTree;
	threshold?: number;
	position?: [number, number];
	directParameter?: string;
	timeScale?: number;
	cycleOffset?: number;
	mirror?: boolean;
}

interface IAnimatorBlendTree {
	parameter?: string;
	parameterX?: string;
	parameterY?: string;
	blendMode?: "cartesian" | "directional" | "freeformDirectional" | "direct";
	normalizeWeights?: boolean;
	children: IAnimatorBlendTreeChild[];
}

interface IAnimatorState {
	name: string;
	animationGroup?: string;
	loop?: boolean;
	speed?: number;
	cycleOffset?: number;
	mirror?: boolean;
	speedParameter?: string | null;
	mirrorParameter?: string | null;
	cycleOffsetParameter?: string | null;
	timeParameter?: string | null;
	tag?: string;
	footIK?: boolean;
	writeDefaultValues?: boolean;
	unitySource?: {
		fileId: string;
		serializedVersion: number | null;
		footIKField: "m_IKOnFeet" | "m_FootIK" | null;
		speedParameter: string | null;
		mirrorParameter: string | null;
		cycleOffsetParameter: string | null;
		timeParameter: string | null;
	};
	behaviours?: { id: string; scriptKey: string; enabled?: boolean }[];
	maskTargetNames?: string[];
	avatarMaskId?: string;
	graphPosition?: [number, number];
	blendTree?: IAnimatorBlendTree;
}

interface IAnimatorTransition {
	from: string;
	to: string;
	conditions?: IAnimatorTransitionCondition[];
	exitTime?: number;
	duration?: number;
	durationMode?: "seconds" | "normalized";
	offset?: number;
	interruptionSource?: "none" | "source" | "destination" | "sourceThenDestination" | "destinationThenSource";
	orderedInterruption?: boolean;
	canTransitionToSelf?: boolean;
}

interface IAnimatorTransitionCondition {
	parameter: string;
	equals?: string | number | boolean;
	notEquals?: string | number | boolean;
	greaterThan?: number;
	lessThan?: number;
}

interface IAnimatorEntryTransition {
	to: string;
	conditions?: IAnimatorTransitionCondition[];
}

interface IAnimatorController {
	id: string;
	name: string;
	targetNodeId?: string;
	humanoidAvatarId?: string;
	parameters: Record<string, string | number | boolean>;
	parameterTypes?: Record<string, "float" | "int" | "bool" | "trigger" | "string">;
	baseIKPass?: boolean;
	states: IAnimatorState[];
	transitions: IAnimatorTransition[];
	entryTransitions?: IAnimatorEntryTransition[];
	subgraphs?: IAnimatorSubgraph[];
	subStateMachines?: IAnimatorSubStateMachine[];
	entryState?: string;
	activeState?: string;
	layers?: IAnimatorLayer[];
	rootMotion?: { enabled: boolean; sourceNodeId: string; targetNodeId: string; applyPosition?: boolean; applyRotationY?: boolean };
}

interface IAnimatorLayer {
	name: string;
	ikPass?: boolean;
	weight?: number;
	maskTargetNames?: string[];
	avatarMaskId?: string;
	blendingMode?: "override" | "additive";
	referencePose?: { normalizedTime: number };
	synchronizedLayer?: "$base" | string;
	synchronizedTiming?: boolean;
	synchronizedStateMap?: Record<string, string>;
	synchronizedMotionOverrides?: Record<string, Pick<IAnimatorState, "animationGroup" | "blendTree">>;
	synchronizedBehaviourOverrides?: Record<string, NonNullable<IAnimatorState["behaviours"]>>;
	states: IAnimatorState[];
	transitions: IAnimatorTransition[];
	entryTransitions?: IAnimatorEntryTransition[];
	subStateMachines?: IAnimatorSubStateMachine[];
	entryState?: string;
	activeState?: string;
}

interface IAnimatorSubStateMachine {
	name: string;
	subgraphId: string;
	graphPosition?: [number, number];
}

interface IAnimatorSubgraph {
	id: string;
	name: string;
	states: IAnimatorState[];
	transitions: IAnimatorTransition[];
	entryTransitions?: IAnimatorEntryTransition[];
	subStateMachines?: IAnimatorSubStateMachine[];
	entryState?: string;
}

const ANIMATOR_ENTRY_NODE = "$entry";

export interface IEditorAnimatorPanelProps {
	editor: Editor;
	requestedControllerId?: string | null;
	requestedDebugEnabled?: boolean;
}

export interface IEditorAnimatorPanelState {
	selectedControllerId: string | null;
	newParameterName: string;
	newParameterType: "float" | "int" | "bool" | "trigger";
	graphDrag: { controllerId: string; state: string; startPointer: [number, number]; startPosition: [number, number]; position: [number, number] } | null;
	debugEnabled: boolean;
	debugRevision: number;
	debugBreakpointLayer: string;
	debugBreakpointFrom: string;
	debugBreakpointTo: string;
	muscleRoleFilter: string;
}

/**
 * A state-machine editor for persisted animator controllers. It intentionally uses
 * the MCP action implementations so UI and agent authoring validate the same model.
 */
export class EditorAnimatorPanel extends Component<IEditorAnimatorPanelProps, IEditorAnimatorPanelState> {
	private _debugInterval: ReturnType<typeof setInterval> | null = null;

	public constructor(props: IEditorAnimatorPanelProps) {
		super(props);
		this.state = {
			selectedControllerId: props.requestedControllerId ?? null,
			newParameterName: "",
			newParameterType: "bool",
			graphDrag: null,
			debugEnabled: props.requestedDebugEnabled === true,
			debugRevision: 0,
			debugBreakpointLayer: "$base",
			debugBreakpointFrom: "",
			debugBreakpointTo: "",
			muscleRoleFilter: "",
		};
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const controllers = this._getControllers(scene);
		const controller = controllers.find((candidate) => candidate.id === this.state.selectedControllerId) ?? controllers[0] ?? null;

		return (
			<div className="flex flex-col gap-3 p-3 h-full overflow-auto">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="font-semibold">Animator Controller</div>
						<div className="text-xs text-muted-foreground">State machines use the scene Animation Groups as clips.</div>
					</div>
					<Button size="sm" disabled={!scene.animationGroups.length} onClick={() => this._createController(scene)}>
						Create Controller
					</Button>
				</div>

				{!scene.animationGroups.length && <div className="text-sm text-muted-foreground">Import or create an Animation Group before creating an Animator controller.</div>}
				{controllers.length > 0 && (
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={controller?.id ?? ""}
						onChange={(event) => this.setState({ selectedControllerId: event.target.value })}
					>
						{controllers.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
					</select>
				)}

				{controller ? (
					this._renderController(scene, controller)
				) : (
					<div className="flex items-center justify-center flex-1 text-muted-foreground">No Animator controller in this scene.</div>
				)}
			</div>
		);
	}

	public componentDidMount(): void {
		this._debugInterval = setInterval(() => {
			if (this.state.debugEnabled) {
				this.setState((state) => ({ debugRevision: state.debugRevision + 1 }));
			}
		}, 250);
	}

	public componentDidUpdate(previousProps: IEditorAnimatorPanelProps): void {
		if (previousProps.requestedControllerId !== this.props.requestedControllerId || previousProps.requestedDebugEnabled !== this.props.requestedDebugEnabled) {
			this.setState({
				selectedControllerId: this.props.requestedControllerId ?? this.state.selectedControllerId,
				debugEnabled: this.props.requestedDebugEnabled ?? this.state.debugEnabled,
			});
		}
	}

	public componentWillUnmount(): void {
		if (this._debugInterval) {
			clearInterval(this._debugInterval);
		}
	}

	private _renderController(scene: Scene, controller: IAnimatorController): ReactNode {
		const targetNodes = scene.getNodes().filter((node: any) => node.position);
		const humanoidAvatars = ((scene.metadata?.babylonEditorHumanoidAvatars as Array<{ id: string; name: string; animationType: string }> | undefined) ?? []).filter(
			(avatar) => avatar.animationType === "humanoid"
		);
		return (
			<>
				<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
					<Input value={controller.name} onChange={(event) => this._update(scene, controller, { name: event.target.value })} aria-label="Animator controller name" />
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={controller.targetNodeId ?? ""}
						onChange={(event) => this._update(scene, controller, { targetNodeId: event.target.value })}
						aria-label="Animator target node"
					>
						<option value="" disabled>
							Select behaviour target node
						</option>
						{targetNodes.map((node) => (
							<option key={node.id} value={node.id}>
								{node.name}
							</option>
						))}
					</select>
					<Button variant="destructive" size="sm" onClick={() => this._delete(scene, controller)}>
						Delete
					</Button>
				</div>
				<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded border border-input p-2">
					<div>
						<div className="text-sm font-medium">Humanoid Avatar</div>
						<div className="text-xs text-muted-foreground">Controller-bound source for Unity-style live muscle tracing.</div>
					</div>
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={controller.humanoidAvatarId ?? ""}
						onChange={(event) => this._setHumanoidAvatar(scene, controller, event.target.value || null)}
						aria-label="Animator Humanoid Avatar"
					>
						<option value="">None — muscle tracing disabled</option>
						{humanoidAvatars.map((avatar) => (
							<option key={avatar.id} value={avatar.id}>
								{avatar.name}
							</option>
						))}
					</select>
				</div>
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" checked={controller.baseIKPass === true} onChange={(event) => this._update(scene, controller, { baseIKPass: event.target.checked })} />
					Base Layer IK Pass
					<span className="text-xs text-muted-foreground">Calls onAnimatorIK after base animation sampling.</span>
				</label>

				{this._renderStateMachineGraph(scene, controller)}
				{this._renderReusableSubgraphs(scene, controller)}
				{this._renderRuntimeDebugger(scene, controller)}
				{this._renderRootMotion(scene, controller)}

				<section className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
					<div>
						<div className="font-medium">Entry State</div>
						<div className="text-xs text-muted-foreground">The green Entry node starts here whenever this controller is loaded or restarted.</div>
					</div>
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={controller.entryState ?? controller.states[0].name}
						onChange={(event) => this._setEntryState(scene, controller, event.target.value)}
					>
						{this._machineNodes(controller).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
					</select>
					<Button size="sm" variant="secondary" onClick={() => this._setEntryState(scene, controller, controller.entryState ?? controller.states[0].name, true)}>
						Restart
					</Button>
				</section>

				{this._renderEntryTransitions(scene, controller, controller)}

				{this._renderSubStateMachines(scene, controller, controller.subStateMachines ?? [])}

				<section className="space-y-2">
					<div className="flex items-center justify-between">
						<div className="font-medium">States</div>
						<Button size="sm" variant="secondary" onClick={() => this._addState(scene, controller)}>
							Add State
						</Button>
						<Button size="sm" variant="secondary" disabled={scene.animationGroups.length < 2} onClick={() => this._addBlendTree(scene, controller)}>
							Add Blend Tree
						</Button>
					</div>
					<div className="grid gap-2">{controller.states.map((state) => this._renderState(scene, controller, state))}</div>
				</section>

				<section className="space-y-2">
					<div className="flex items-center justify-between">
						<div>
							<div className="font-medium">Layers</div>
							<div className="text-xs text-muted-foreground">Weighted layers run independently beside the base state machine.</div>
						</div>
						<Button size="sm" variant="secondary" onClick={() => this._addLayer(scene, controller)}>
							Add Layer
						</Button>
					</div>
					<div className="grid gap-2">
						{(controller.layers ?? []).map((layer) => this._renderLayer(scene, controller, layer))}
						{!(controller.layers ?? []).length && <div className="text-xs text-muted-foreground">No layers. Add one for upper-body or other masked animation.</div>}
					</div>
				</section>

				<section className="space-y-2">
					<div className="flex items-center justify-between">
						<div className="font-medium">Transitions</div>
						<Button size="sm" variant="secondary" onClick={() => this._addTransition(scene, controller)}>
							Add Transition
						</Button>
					</div>
					<div className="grid gap-2">
						{controller.transitions.map((transition, index) => this._renderTransition(scene, controller, transition, index))}
						{!controller.transitions.length && <div className="text-xs text-muted-foreground">No transitions. Add one to define state flow.</div>}
					</div>
				</section>

				<section className="space-y-2">
					<div className="font-medium">Parameters</div>
					<div className="grid grid-cols-[minmax(0,1fr)_8rem_auto] gap-2">
						<Input placeholder="Parameter name" value={this.state.newParameterName} onChange={(event) => this.setState({ newParameterName: event.target.value })} />
						<select
							className="h-9 rounded-md border border-input bg-background px-3 text-sm"
							value={this.state.newParameterType}
							onChange={(event) => this.setState({ newParameterType: event.target.value as IEditorAnimatorPanelState["newParameterType"] })}
						>
							<option value="float">Float</option>
							<option value="int">Int</option>
							<option value="bool">Bool</option>
							<option value="trigger">Trigger</option>
						</select>
						<Button size="sm" variant="secondary" onClick={() => this._addParameter(scene, controller)}>
							Add
						</Button>
					</div>
					{Object.entries(controller.parameters).map(([name, value]) => {
						const type = controller.parameterTypes?.[name] ?? (typeof value === "boolean" ? "bool" : typeof value === "number" ? "float" : "string");
						return (
							<div key={name} className="grid grid-cols-[minmax(7rem,1fr)_8rem_minmax(8rem,1fr)_auto] items-center gap-2 rounded border border-input p-2">
								<div className="truncate text-sm">{name}</div>
								<select
									className="h-8 rounded-md border border-input bg-background px-2 text-xs"
									value={type}
									onChange={(event) =>
										this._setParameterDefinition(scene, controller, name, event.target.value as "float" | "int" | "bool" | "trigger" | "string")
									}
								>
									<option value="float">Float</option>
									<option value="int">Int</option>
									<option value="bool">Bool</option>
									<option value="trigger">Trigger</option>
									<option value="string">String (legacy)</option>
								</select>
								{type === "trigger" ? (
									<div className="flex items-center gap-2">
										<Button size="sm" variant="secondary" onClick={() => this._fireTrigger(scene, controller, name)}>
											Fire
										</Button>
										<Button size="sm" variant="ghost" onClick={() => this._resetTrigger(scene, controller, name)}>
											Reset
										</Button>
										<span className={value === true ? "text-amber-500 text-xs" : "text-muted-foreground text-xs"}>{value === true ? "armed" : "idle"}</span>
									</div>
								) : type === "bool" ? (
									<select
										className="h-8 rounded-md border border-input bg-background px-2 text-xs"
										value={String(value)}
										onChange={(event) => this._setParameter(scene, controller, name, event.target.value)}
									>
										<option value="false">False</option>
										<option value="true">True</option>
									</select>
								) : (
									<Input
										type={type === "float" || type === "int" ? "number" : "text"}
										step={type === "int" ? 1 : "any"}
										value={String(value)}
										onChange={(event) => this._setParameter(scene, controller, name, event.target.value)}
										aria-label={`${name} value`}
									/>
								)}
								<Button size="sm" variant="ghost" onClick={() => this._removeParameter(scene, controller, name)}>
									Remove
								</Button>
							</div>
						);
					})}
				</section>
			</>
		);
	}

	private _renderRuntimeDebugger(scene: Scene, controller: IAnimatorController): ReactNode {
		const snapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id, includeAllClips: true });
		const muscleTrace = getAnimatorHumanoidMuscleTraceForController(scene, { controllerId: controller.id, limit: 8 });
		const runtimeDebugger = snapshot.debugger;
		const baseProgress = Math.max(0, Math.min(1, snapshot.base.loopProgress ?? 0));
		return (
			<section className="space-y-2 rounded border border-input p-3" data-debug-revision={this.state.debugRevision}>
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="font-medium">Runtime Debugger</div>
						<div className="text-xs text-muted-foreground">Live state, normalized time, transitions, parameters, clip weights, layers, and root motion.</div>
					</div>
					<div className="flex gap-2">
						<Button size="sm" variant={this.state.debugEnabled ? "default" : "secondary"} onClick={() => this.setState({ debugEnabled: !this.state.debugEnabled })}>
							{this.state.debugEnabled ? "Polling · 4 Hz" : "Polling off"}
						</Button>
						<Button
							size="sm"
							variant={runtimeDebugger.paused ? "default" : "secondary"}
							onClick={() => this._setRuntimeDebugPaused(scene, controller, !runtimeDebugger.paused)}
						>
							{runtimeDebugger.paused ? "Resume Runtime" : "Pause Runtime"}
						</Button>
						<Button size="sm" variant="secondary" disabled={!runtimeDebugger.paused} onClick={() => this._stepRuntimeDebug(scene, controller)}>
							Step 1/60s
						</Button>
						<Button size="sm" variant="secondary" onClick={() => this.setState((state) => ({ debugRevision: state.debugRevision + 1 }))}>
							Refresh
						</Button>
					</div>
				</div>

				<div className="grid gap-2 md:grid-cols-4">
					<div className="rounded bg-secondary p-2">
						<div className="text-[10px] uppercase text-muted-foreground">Base State</div>
						<div className="text-sm font-medium">{snapshot.base.activeState ?? "Exited"}</div>
					</div>
					<div className="rounded bg-secondary p-2">
						<div className="text-[10px] uppercase text-muted-foreground">Entry</div>
						<div className="text-sm font-medium">{snapshot.base.entryState}</div>
					</div>
					<div className="rounded bg-secondary p-2">
						<div className="text-[10px] uppercase text-muted-foreground">Normalized Time</div>
						<div className="text-sm font-medium">{Number(snapshot.base.normalizedTime).toFixed(3)}</div>
					</div>
					<div className="rounded bg-secondary p-2">
						<div className="text-[10px] uppercase text-muted-foreground">Frame Delta</div>
						<div className="text-sm font-medium">{Number(snapshot.engineDeltaTimeMs).toFixed(2)} ms</div>
					</div>
				</div>

				<div className="h-2 overflow-hidden rounded bg-secondary">
					<div className="h-full bg-primary transition-[width]" style={{ width: `${baseProgress * 100}%` }} />
				</div>

				<div className="space-y-2 rounded border border-input p-2 text-xs">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">Transition Breakpoints</span>
						<select
							className="h-8 rounded border border-border bg-background px-2"
							value={this.state.debugBreakpointLayer}
							onChange={(event) => this.setState({ debugBreakpointLayer: event.target.value })}
							aria-label="Animator breakpoint layer"
						>
							<option value="$base">Base</option>
							{(controller.layers ?? []).map((layer) => (
								<option key={layer.name} value={layer.name}>
									{layer.name}
								</option>
							))}
						</select>
						<Input
							className="h-8 w-36"
							placeholder="From (optional)"
							value={this.state.debugBreakpointFrom}
							onChange={(event) => this.setState({ debugBreakpointFrom: event.target.value })}
							aria-label="Animator breakpoint source state"
						/>
						<Input
							className="h-8 w-36"
							placeholder="To (optional)"
							value={this.state.debugBreakpointTo}
							onChange={(event) => this.setState({ debugBreakpointTo: event.target.value })}
							aria-label="Animator breakpoint destination state"
						/>
						<Button size="sm" variant="secondary" onClick={() => this._addRuntimeDebugBreakpoint(scene, controller)}>
							Add Breakpoint
						</Button>
						<Button size="sm" variant="ghost" disabled={!runtimeDebugger.historyCount} onClick={() => this._clearRuntimeDebugHistory(scene, controller)}>
							Clear History
						</Button>
					</div>
					<div className="flex flex-wrap gap-2">
						{runtimeDebugger.breakpoints.map((breakpoint: any) => (
							<button
								key={breakpoint.id}
								className="rounded bg-secondary px-2 py-1 text-left hover:bg-destructive/20"
								onClick={() => this._removeRuntimeDebugBreakpoint(scene, controller, breakpoint.id)}
								title="Remove transition breakpoint"
							>
								{breakpoint.layer}: {breakpoint.from ?? "*"} → {breakpoint.to ?? "*"}
							</button>
						))}
						{!runtimeDebugger.breakpoints.length && <span className="text-muted-foreground">No breakpoints.</span>}
					</div>
					<div className="space-y-1">
						<div className="font-medium">
							Transition History ({runtimeDebugger.historyCount}
							{runtimeDebugger.droppedHistoryCount ? ` + ${runtimeDebugger.droppedHistoryCount} dropped` : ""})
						</div>
						{runtimeDebugger.history
							.slice(-16)
							.reverse()
							.map((entry: any) => (
								<div key={entry.sequence} className={`rounded px-2 py-1 ${entry.hitBreakpointIds.length ? "bg-amber-500/20" : "bg-secondary"}`}>
									#{entry.sequence} · {entry.layer} · {entry.from} → {entry.to} · {entry.runtimeSeconds.toFixed(3)}s{entry.interrupted ? " · interrupted" : ""}
									{entry.hitBreakpointIds.length ? ` · hit ${entry.hitBreakpointIds.join(", ")}` : ""}
								</div>
							))}
						{!runtimeDebugger.history.length && <div className="text-muted-foreground">No transitions captured yet.</div>}
					</div>
				</div>

				{snapshot.base.transition && (
					<div className="rounded border border-input p-2 text-xs">
						<span className="font-medium">
							{snapshot.base.transition.from} → {snapshot.base.transition.to}
						</span>
						<span className="ml-2 text-muted-foreground">
							{(snapshot.base.transition.progress * 100).toFixed(1)}% · weights {snapshot.base.transition.fromWeight.toFixed(3)} /{" "}
							{snapshot.base.transition.toWeight.toFixed(3)}
						</span>
						<div className="mt-1 text-muted-foreground">
							{snapshot.base.transition.interrupted ? "Interrupted" : "Active"} · source {snapshot.base.transition.interruptionSource} ·{" "}
							{snapshot.base.transition.orderedInterruption ? "ordered" : "unordered"} · offset {Number(snapshot.base.transition.offset).toFixed(3)}
						</div>
					</div>
				)}

				<div className="grid gap-2 md:grid-cols-2">
					<div className="space-y-1">
						<div className="text-xs font-medium text-muted-foreground">Parameters</div>
						{snapshot.parameters.map((parameter: any) => (
							<div key={parameter.name} className="flex justify-between rounded bg-secondary px-2 py-1 text-xs">
								<span>{parameter.name}</span>
								<span className="font-mono">
									{String(parameter.value)} <span className="text-muted-foreground">({parameter.type})</span>
								</span>
							</div>
						))}
						{!snapshot.parameters.length && <div className="text-xs text-muted-foreground">No parameters.</div>}
					</div>
					<div className="space-y-1">
						<div className="text-xs font-medium text-muted-foreground">Base Clip Weights</div>
						{snapshot.base.clips.map((clip: any, index: number) => (
							<div key={`${clip.state}-${clip.name}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 rounded bg-secondary px-2 py-1 text-xs">
								<span className="truncate">
									{clip.state} · {clip.name}
								</span>
								<span>{clip.found ? Number(clip.weight).toFixed(3) : "missing"}</span>
								<span className={clip.playing ? "text-emerald-500" : "text-muted-foreground"}>{clip.playing ? "playing" : clip.paused ? "paused" : "stopped"}</span>
							</div>
						))}
						{!snapshot.base.clips.length && <div className="text-xs text-muted-foreground">No active or transition clips.</div>}
					</div>
				</div>

				{snapshot.layers.map((layer: any) => (
					<div key={layer.name} className="space-y-1 rounded border border-input p-2 text-xs">
						<div className="flex items-center justify-between">
							<span className="font-medium">{layer.name}</span>
							<span className="text-muted-foreground">
								{layer.activeState ?? "Exited"} · layer weight {Number(layer.weight).toFixed(3)} · time {Number(layer.normalizedTime).toFixed(3)}
							</span>
						</div>
						{layer.transition && (
							<div className="text-muted-foreground">
								{layer.transition.from} → {layer.transition.to} · {(layer.transition.progress * 100).toFixed(1)}% ·{" "}
								{layer.transition.interrupted ? "interrupted" : "active"} · source {layer.transition.interruptionSource} · offset{" "}
								{Number(layer.transition.offset).toFixed(3)}
							</div>
						)}
						<div className="flex flex-wrap gap-2">
							{layer.clips.map((clip: any, index: number) => (
								<span key={`${clip.state}-${clip.name}-${index}`} className="rounded bg-secondary px-2 py-1">
									{clip.name}: {clip.found ? Number(clip.weight).toFixed(3) : "missing"}
								</span>
							))}
						</div>
					</div>
				))}

				{snapshot.rootMotion && (
					<div className="text-xs text-muted-foreground">
						Root motion: {snapshot.rootMotion.enabled ? "enabled" : "disabled"} · source {snapshot.rootMotion.sourceFound ? "found" : "missing"} · target{" "}
						{snapshot.rootMotion.targetFound ? "found" : "missing"} · {snapshot.rootMotion.sampled ? "sampled" : "awaiting sample"}
					</div>
				)}
				<div className="text-xs text-muted-foreground">
					State behaviours: enter {snapshot.stateBehaviours.enterCalls} · update {snapshot.stateBehaviours.updateCalls} · exit {snapshot.stateBehaviours.exitCalls} ·
					errors {snapshot.stateBehaviours.errorCount} · missing target/script {snapshot.stateBehaviours.missingTargets}/{snapshot.stateBehaviours.missingScripts}
					{snapshot.stateBehaviours.lastError ? ` · last error: ${snapshot.stateBehaviours.lastError.message}` : ""}
				</div>
				<div className="text-xs text-muted-foreground">
					IK Pass: {snapshot.ikPasses.layers.filter((layer: any) => layer.enabled).length} enabled layer(s) ·{" "}
					{snapshot.ikPasses.layers.reduce((sum: number, layer: any) => sum + layer.invocations, 0)} invocations ·{" "}
					{snapshot.ikPasses.layers.reduce((sum: number, layer: any) => sum + layer.callbackCalls, 0)} callbacks ·{" "}
					{snapshot.ikPasses.layers.reduce((sum: number, layer: any) => sum + layer.errorCount, 0)} errors
				</div>
				{this._renderHumanoidMuscleTrace(scene, controller, muscleTrace)}
			</section>
		);
	}

	private _renderHumanoidMuscleTrace(scene: Scene, controller: IAnimatorController, trace: any): ReactNode {
		const roles = trace.current?.muscles.map((muscle: any) => ({ role: muscle.role, label: muscle.label })) ?? [];
		const currentMuscles = (trace.current?.muscles ?? []).filter((muscle: any) => !this.state.muscleRoleFilter || muscle.role === this.state.muscleRoleFilter);
		return (
			<div className="space-y-2 rounded border border-input p-2 text-xs">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<div className="font-medium">Humanoid Muscle Trace</div>
						<div className="text-muted-foreground">Post Animator/behaviour/IK, before muscle-limit clamping · newest-first 256-sample buffer.</div>
					</div>
					<div className="flex items-center gap-2">
						<select
							className="h-8 rounded border border-border bg-background px-2"
							value={this.state.muscleRoleFilter}
							onChange={(event) => this.setState({ muscleRoleFilter: event.target.value })}
							aria-label="Humanoid muscle role filter"
						>
							<option value="">All mapped muscles</option>
							{roles.map((role: any) => (
								<option key={role.role} value={role.role}>
									{role.label}
								</option>
							))}
						</select>
						<Button size="sm" variant="ghost" disabled={!trace.history.total} onClick={() => this._clearHumanoidMuscleTrace(scene, controller)}>
							Clear Trace
						</Button>
					</div>
				</div>
				{trace.enabled ? (
					<>
						<div className="grid gap-2 md:grid-cols-4">
							<div className="rounded bg-secondary px-2 py-1">Avatar: {trace.avatarName ?? trace.avatarId}</div>
							<div className="rounded bg-secondary px-2 py-1">Mapped: {trace.current?.mappedMuscleCount ?? 0}</div>
							<div className="rounded bg-secondary px-2 py-1">Active: {trace.current?.activeMuscleCount ?? 0}</div>
							<div className={`rounded px-2 py-1 ${trace.latest?.limitViolationCount ? "bg-destructive/20" : "bg-secondary"}`}>
								Violations: {trace.latest?.limitViolationCount ?? 0}
							</div>
						</div>
						<div className="grid gap-1">
							{currentMuscles.slice(0, 16).map((muscle: any) => (
								<div
									key={muscle.role}
									className={`grid grid-cols-[minmax(8rem,1fr)_auto_auto] gap-2 rounded px-2 py-1 ${muscle.withinLimits ? "bg-secondary" : "bg-destructive/20"}`}
								>
									<span>{muscle.label}</span>
									<span className="font-mono">n [{muscle.normalized.map((value: number) => Number(value).toFixed(3)).join(", ")}]</span>
									<span className="font-mono">° [{muscle.degrees.map((value: number) => Number(value).toFixed(1)).join(", ")}]</span>
								</div>
							))}
							{currentMuscles.length > 16 && (
								<div className="text-muted-foreground">Showing 16 of {currentMuscles.length}; choose a role to inspect it directly.</div>
							)}
						</div>
						<div className="space-y-1">
							<div className="font-medium">
								Samples ({trace.history.total}
								{trace.droppedSampleCount ? ` + ${trace.droppedSampleCount} dropped` : ""})
							</div>
							{trace.history.items.map((sample: any) => (
								<div key={sample.sequence} className={`rounded px-2 py-1 ${sample.limitViolationCount ? "bg-destructive/20" : "bg-secondary"}`}>
									#{sample.sequence} · {sample.runtimeSeconds.toFixed(3)}s · {sample.baseState ?? "Exited"} · max |n|{" "}
									{sample.maximumAbsoluteNormalized.toFixed(3)} · max Δ {sample.maximumAbsoluteDeltaNormalized.toFixed(3)} · {sample.limitViolationCount}{" "}
									violation(s)
								</div>
							))}
							{!trace.history.total && <div className="text-muted-foreground">Awaiting the first running or stepped Animator sample.</div>}
						</div>
						{trace.lastError && <div className="text-destructive">Trace error: {trace.lastError}</div>}
					</>
				) : (
					<div className="text-muted-foreground">Assign a Humanoid Avatar above to enable controller-integrated tracing.</div>
				)}
			</div>
		);
	}

	private _setHumanoidAvatar(scene: Scene, controller: IAnimatorController, humanoidAvatarId: string | null): void {
		try {
			const current = getAnimatorHumanoidMuscleTraceForController(scene, { controllerId: controller.id, limit: 1 });
			setAnimatorHumanoidMuscleTrace(scene, { controllerId: controller.id, expectedFingerprint: current.fingerprint, humanoidAvatarId }, { editor: this.props.editor });
			this.setState((state) => ({ debugEnabled: true, debugRevision: state.debugRevision + 1 }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _clearHumanoidMuscleTrace(scene: Scene, controller: IAnimatorController): void {
		try {
			const current = getAnimatorHumanoidMuscleTraceForController(scene, { controllerId: controller.id, limit: 1 });
			setAnimatorHumanoidMuscleTrace(scene, { controllerId: controller.id, expectedFingerprint: current.fingerprint, clearHistory: true }, { editor: this.props.editor });
			this.setState((state) => ({ debugRevision: state.debugRevision + 1 }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _setRuntimeDebugPaused(scene: Scene, controller: IAnimatorController, paused: boolean): void {
		try {
			const snapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
			setAnimatorRuntimeDebug(scene, { controllerId: controller.id, expectedFingerprint: snapshot.debugger.fingerprint, paused }, { editor: this.props.editor });
			this.setState((state) => ({ debugEnabled: true, debugRevision: state.debugRevision + 1 }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _stepRuntimeDebug(scene: Scene, controller: IAnimatorController): void {
		try {
			const snapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
			stepAnimatorRuntimeDebug(
				scene,
				{ controllerId: controller.id, expectedFingerprint: snapshot.debugger.fingerprint, deltaSeconds: 1 / 60, steps: 1 },
				{ editor: this.props.editor }
			);
			this.setState((state) => ({ debugRevision: state.debugRevision + 1 }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _addRuntimeDebugBreakpoint(scene: Scene, controller: IAnimatorController): void {
		const from = this.state.debugBreakpointFrom.trim();
		const to = this.state.debugBreakpointTo.trim();
		if (!from && !to) {
			toast.error("Enter a source state, destination state, or both.");
			return;
		}
		try {
			const snapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
			setAnimatorRuntimeDebug(
				scene,
				{
					controllerId: controller.id,
					expectedFingerprint: snapshot.debugger.fingerprint,
					breakpoints: [
						...snapshot.debugger.breakpoints,
						{
							id: Tools.RandomId(),
							layer: this.state.debugBreakpointLayer,
							...(from ? { from } : {}),
							...(to ? { to } : {}),
							enabled: true,
						},
					],
				},
				{ editor: this.props.editor }
			);
			this.setState((state) => ({ debugBreakpointFrom: "", debugBreakpointTo: "", debugRevision: state.debugRevision + 1 }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _removeRuntimeDebugBreakpoint(scene: Scene, controller: IAnimatorController, id: string): void {
		try {
			const snapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
			setAnimatorRuntimeDebug(
				scene,
				{
					controllerId: controller.id,
					expectedFingerprint: snapshot.debugger.fingerprint,
					breakpoints: snapshot.debugger.breakpoints.filter((breakpoint: any) => breakpoint.id !== id),
				},
				{ editor: this.props.editor }
			);
			this.setState((state) => ({ debugRevision: state.debugRevision + 1 }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _clearRuntimeDebugHistory(scene: Scene, controller: IAnimatorController): void {
		try {
			const snapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
			setAnimatorRuntimeDebug(scene, { controllerId: controller.id, expectedFingerprint: snapshot.debugger.fingerprint, clearHistory: true }, { editor: this.props.editor });
			this.setState((state) => ({ debugRevision: state.debugRevision + 1 }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _renderRootMotion(scene: Scene, controller: IAnimatorController): ReactNode {
		const nodes = scene.getNodes().filter((node: any) => node.position);
		const rootMotion = controller.rootMotion;
		return (
			<section className="space-y-2">
				<div>
					<div className="font-medium">Root Motion</div>
					<div className="text-xs text-muted-foreground">Extract an animated source transform onto a separate character target.</div>
				</div>
				{!rootMotion ? (
					<Button
						size="sm"
						variant="secondary"
						disabled={nodes.length < 2}
						onClick={() => this._setRootMotion(scene, controller, { enabled: true, sourceNodeId: nodes[0]?.id, targetNodeId: nodes[1]?.id })}
					>
						Enable Root Motion
					</Button>
				) : (
					<>
						<div className="grid grid-cols-2 gap-2">
							<select
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={rootMotion.sourceNodeId}
								onChange={(event) => this._setRootMotion(scene, controller, { sourceNodeId: event.target.value })}
							>
								{nodes.map((node) => (
									<option key={node.id} value={node.id}>
										{node.name || node.id}
									</option>
								))}
							</select>
							<select
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={rootMotion.targetNodeId}
								onChange={(event) => this._setRootMotion(scene, controller, { targetNodeId: event.target.value })}
							>
								{nodes.map((node) => (
									<option key={node.id} value={node.id}>
										{node.name || node.id}
									</option>
								))}
							</select>
						</div>
						<div className="flex gap-3 text-sm">
							<label>
								<input
									type="checkbox"
									checked={rootMotion.applyPosition !== false}
									onChange={(event) => this._setRootMotion(scene, controller, { applyPosition: event.target.checked })}
								/>{" "}
								position
							</label>
							<label>
								<input
									type="checkbox"
									checked={rootMotion.applyRotationY === true}
									onChange={(event) => this._setRootMotion(scene, controller, { applyRotationY: event.target.checked })}
								/>{" "}
								Y rotation
							</label>
							<Button size="sm" variant="ghost" onClick={() => this._setRootMotion(scene, controller, { enabled: false })}>
								Disable
							</Button>
						</div>
					</>
				)}
			</section>
		);
	}

	private _setRootMotion(scene: Scene, controller: IAnimatorController, update: any): void {
		try {
			setAnimatorRootMotion(scene, { controllerId: controller.id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	/**
	 * Draws the persisted base-layer state machine as a directly interactive graph.
	 * The property editors below remain the authoritative detailed transition editor;
	 * selecting a node here plays that persisted state through the same controller path.
	 */
	private _renderStateMachineGraph(scene: Scene, controller: IAnimatorController): ReactNode {
		const states = controller.states;
		const instances = controller.subStateMachines ?? [];
		const graphNodeCount = states.length + instances.length;
		const columns = Math.max(1, Math.ceil(Math.sqrt(graphNodeCount)));
		const rows = Math.max(1, Math.ceil(graphNodeCount / columns));
		const nodeWidth = 154;
		const nodeHeight = 58;
		const gapX = 72;
		const gapY = 46;
		const padding = 34;
		const specialColumnWidth = 198;
		const automaticWidth = padding * 2 + specialColumnWidth + columns * nodeWidth + (columns - 1) * gapX;
		const automaticHeight = Math.max(padding * 2 + rows * nodeHeight + (rows - 1) * gapY, 330);
		const positions = new Map<string, { x: number; y: number }>(
			states.map((state, index) => [
				state.name,
				this.state.graphDrag?.controllerId === controller.id && this.state.graphDrag.state === state.name
					? { x: this.state.graphDrag.position[0], y: this.state.graphDrag.position[1] }
					: state.graphPosition
						? { x: state.graphPosition[0], y: state.graphPosition[1] }
						: { x: padding + specialColumnWidth + (index % columns) * (nodeWidth + gapX), y: padding + Math.floor(index / columns) * (nodeHeight + gapY) },
			])
		);
		instances.forEach((instance, instanceIndex) => {
			const index = states.length + instanceIndex;
			positions.set(
				instance.name,
				instance.graphPosition
					? { x: instance.graphPosition[0], y: instance.graphPosition[1] }
					: { x: padding + specialColumnWidth + (index % columns) * (nodeWidth + gapX), y: padding + Math.floor(index / columns) * (nodeHeight + gapY) }
			);
		});
		positions.set(ANIMATOR_ENTRY_NODE, { x: padding, y: padding });
		positions.set(ANIMATOR_ANY_STATE, { x: padding, y: padding + 104 });
		positions.set(ANIMATOR_EXIT_STATE, { x: padding, y: padding + 208 });
		const width = Math.max(automaticWidth, ...[...positions.values()].map((position) => position.x + nodeWidth + padding));
		const height = Math.max(automaticHeight, ...[...positions.values()].map((position) => position.y + nodeHeight + padding));
		const markerId = `animator-arrow-${controller.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
		const graphTransitions: IAnimatorTransition[] = [
			...(controller.entryTransitions ?? []).map((transition) => ({ from: ANIMATOR_ENTRY_NODE, ...transition })),
			{ from: ANIMATOR_ENTRY_NODE, to: controller.entryState ?? controller.states[0].name },
			...controller.transitions,
		];

		return (
			<section className="space-y-2">
				<div>
					<div className="font-medium">State Machine Graph</div>
					<div className="text-xs text-muted-foreground">
						Drag a state to position it, or use its X/Y fields below. Click a state to play it; lines are persisted transitions.
					</div>
				</div>
				<div className="overflow-auto rounded border border-input bg-background p-2">
					<svg
						className="block min-w-[42rem]"
						viewBox={`0 0 ${width} ${height}`}
						role="img"
						aria-label={`${controller.name} state machine graph`}
						onMouseMove={(event) => this._moveGraphDrag(event, width, height)}
						onMouseUp={() => this._endGraphDrag(scene, controller)}
						onMouseLeave={() => this._endGraphDrag(scene, controller)}
					>
						<defs>
							<marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
								<path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground" />
							</marker>
						</defs>
						{graphTransitions.map((transition, index) => {
							const from = positions.get(transition.from);
							const to = positions.get(transition.to);
							if (!from || !to) {
								return null;
							}
							const x1 = from.x + nodeWidth / 2;
							const y1 = from.y + nodeHeight / 2;
							const x2 = to.x + nodeWidth / 2;
							const y2 = to.y + nodeHeight / 2;
							const conditions = transition.conditions?.length ?? 0;
							return (
								<g key={`${transition.from}-${transition.to}-${index}`}>
									<line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-muted-foreground" strokeWidth="2" markerEnd={`url(#${markerId})`} />
									{conditions > 0 && (
										<text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
											{conditions} condition{conditions === 1 ? "" : "s"}
										</text>
									)}
								</g>
							);
						})}
						{[
							{ id: ANIMATOR_ENTRY_NODE, label: "Entry", className: "fill-emerald-600 stroke-emerald-400", clickable: true },
							{ id: ANIMATOR_ANY_STATE, label: "Any State", className: "fill-amber-600 stroke-amber-400", clickable: false },
							{ id: ANIMATOR_EXIT_STATE, label: "Exit", className: "fill-rose-700 stroke-rose-400", clickable: false },
						].map((node) => {
							const position = positions.get(node.id)!;
							return (
								<g
									key={node.id}
									className={node.clickable ? "cursor-pointer" : undefined}
									onClick={node.clickable ? () => this._setEntryState(scene, controller, controller.entryState ?? controller.states[0].name, true) : undefined}
								>
									<rect
										x={position.x}
										y={position.y}
										width={nodeWidth}
										height={nodeHeight}
										rx={node.id === ANIMATOR_EXIT_STATE ? nodeHeight / 2 : "6"}
										className={node.className}
										strokeWidth="1.5"
									/>
									<text x={position.x + nodeWidth / 2} y={position.y + 34} textAnchor="middle" className="fill-white text-xs font-medium">
										{node.label}
									</text>
								</g>
							);
						})}
						{states.map((state) => {
							const position = positions.get(state.name)!;
							const active = controller.activeState === state.name;
							return (
								<g
									key={state.name}
									className="cursor-grab active:cursor-grabbing"
									onMouseDown={(event) => this._beginGraphDrag(event, controller, state, position, width, height)}
									onClick={() => this._play(scene, controller, state.name)}
								>
									<title>{`${state.name}${state.blendTree ? " (Blend Tree)" : state.animationGroup ? ` · ${state.animationGroup}` : ""}`}</title>
									<rect
										x={position.x}
										y={position.y}
										width={nodeWidth}
										height={nodeHeight}
										rx="6"
										className={active ? "fill-primary stroke-primary" : "fill-secondary stroke-border"}
										strokeWidth="1.5"
									/>
									<text
										x={position.x + nodeWidth / 2}
										y={position.y + 25}
										textAnchor="middle"
										className={active ? "fill-primary-foreground text-xs font-medium" : "fill-foreground text-xs font-medium"}
									>
										{state.name}
									</text>
									<text
										x={position.x + nodeWidth / 2}
										y={position.y + 43}
										textAnchor="middle"
										className={active ? "fill-primary-foreground text-[10px]" : "fill-muted-foreground text-[10px]"}
									>
										{state.blendTree ? "Blend Tree" : (state.animationGroup ?? "No clip")}
									</text>
								</g>
							);
						})}
						{instances.map((instance) => {
							const position = positions.get(instance.name)!;
							const active = controller.activeState === instance.name || controller.activeState?.startsWith(`${instance.name}/`) === true;
							const subgraph = controller.subgraphs?.find((candidate) => candidate.id === instance.subgraphId);
							return (
								<g key={instance.name} className="cursor-pointer" onClick={() => this._play(scene, controller, instance.name)}>
									<title>{`${instance.name} · ${subgraph?.name ?? "Missing reusable subgraph"}`}</title>
									<rect
										x={position.x}
										y={position.y}
										width={nodeWidth}
										height={nodeHeight}
										rx="6"
										className={active ? "fill-violet-600 stroke-violet-300" : "fill-violet-950 stroke-violet-500"}
										strokeWidth="1.5"
									/>
									<text x={position.x + nodeWidth / 2} y={position.y + 25} textAnchor="middle" className="fill-white text-xs font-medium">
										{instance.name}
									</text>
									<text x={position.x + nodeWidth / 2} y={position.y + 43} textAnchor="middle" className="fill-violet-100 text-[10px]">
										{subgraph?.name ?? "Missing subgraph"}
									</text>
								</g>
							);
						})}
					</svg>
				</div>
			</section>
		);
	}

	private _machineNodes(machine: { states: IAnimatorState[]; subStateMachines?: IAnimatorSubStateMachine[] }): string[] {
		return [...machine.states.map((state) => state.name), ...(machine.subStateMachines ?? []).map((instance) => instance.name)];
	}

	private _renderEntryTransitions(
		scene: Scene,
		controller: IAnimatorController,
		machine: { states: IAnimatorState[]; subStateMachines?: IAnimatorSubStateMachine[]; entryTransitions?: IAnimatorEntryTransition[] },
		owner: { layer?: string; subgraphId?: string; disabled?: boolean } = {}
	): ReactNode {
		const transitions = machine.entryTransitions ?? [];
		const parameterNames = Object.keys(controller.parameters);
		const nodes = this._machineNodes(machine);
		const replace = (replacement: IAnimatorEntryTransition[]): void => this._setEntryTransitions(scene, controller, replacement, owner);
		return (
			<div className="space-y-2 rounded border border-emerald-600/40 bg-emerald-950/10 p-2">
				<div className="flex items-center justify-between gap-2">
					<div>
						<div className="text-xs font-medium text-emerald-500">Conditional Entry Transitions</div>
						<div className="text-[11px] text-muted-foreground">Evaluated from top to bottom before the default Entry destination.</div>
					</div>
					<Button
						size="sm"
						variant="secondary"
						disabled={owner.disabled === true || !parameterNames.length || transitions.length >= 64 || !nodes.length}
						onClick={() => {
							const parameter = parameterNames[0];
							replace([...transitions, { to: nodes[0], conditions: [this._newEntryCondition(controller, parameter)] }]);
						}}
					>
						Add Route
					</Button>
				</div>
				{owner.disabled === true && <div className="text-xs text-muted-foreground">Entry routing is inherited from the synchronized source layer.</div>}
				{owner.disabled !== true && !parameterNames.length && (
					<div className="text-xs text-muted-foreground">Add an Animator parameter before creating a conditional route.</div>
				)}
				{owner.disabled !== true &&
					transitions.map((transition, transitionIndex) => (
						<div key={`${transition.to}-${transitionIndex}`} className="space-y-2 rounded border border-input/60 p-2">
							<div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2">
								<Button
									size="sm"
									variant="ghost"
									disabled={transitionIndex === 0}
									onClick={() => {
										const reordered = [...transitions];
										[reordered[transitionIndex - 1], reordered[transitionIndex]] = [reordered[transitionIndex], reordered[transitionIndex - 1]];
										replace(reordered);
									}}
								>
									↑
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={transitionIndex === transitions.length - 1}
									onClick={() => {
										const reordered = [...transitions];
										[reordered[transitionIndex], reordered[transitionIndex + 1]] = [reordered[transitionIndex + 1], reordered[transitionIndex]];
										replace(reordered);
									}}
								>
									↓
								</Button>
								<select
									className="h-8 rounded-md border border-input bg-background px-2 text-xs"
									value={transition.to}
									onChange={(event) =>
										replace(transitions.map((candidate, index) => (index === transitionIndex ? { ...candidate, to: event.target.value } : candidate)))
									}
									aria-label={`Conditional Entry route ${transitionIndex + 1} destination`}
								>
									{nodes.map((node) => (
										<option key={node} value={node}>
											Entry → {node}
										</option>
									))}
								</select>
								<Button size="sm" variant="ghost" onClick={() => replace(transitions.filter((_, index) => index !== transitionIndex))}>
									Remove
								</Button>
							</div>
							<div className="flex items-center justify-between text-xs text-muted-foreground">
								<span>Conditions ({transition.conditions?.length ?? 0}; all must match)</span>
								<Button
									size="sm"
									variant="secondary"
									disabled={(transition.conditions?.length ?? 0) >= 16}
									onClick={() => {
										const parameter = parameterNames[0];
										replace(
											transitions.map((candidate, index) =>
												index === transitionIndex
													? {
															...candidate,
															conditions: [...(candidate.conditions ?? []), this._newEntryCondition(controller, parameter)],
														}
													: candidate
											)
										);
									}}
								>
									Add Condition
								</Button>
							</div>
							{(transition.conditions ?? []).map((condition, conditionIndex) => {
								const operator =
									condition.equals !== undefined
										? "equals"
										: condition.notEquals !== undefined
											? "notEquals"
											: condition.greaterThan !== undefined
												? "greaterThan"
												: "lessThan";
								const value = condition.equals ?? condition.notEquals ?? condition.greaterThan ?? condition.lessThan ?? "";
								const replaceCondition = (replacement: IAnimatorTransitionCondition | null): void =>
									replace(
										transitions.map((candidate, index) =>
											index === transitionIndex
												? {
														...candidate,
														conditions: replacement
															? (candidate.conditions ?? []).map((current, currentIndex) => (currentIndex === conditionIndex ? replacement : current))
															: (candidate.conditions ?? []).filter((_, currentIndex) => currentIndex !== conditionIndex),
													}
												: candidate
										)
									);
								return (
									<div key={`${condition.parameter}-${conditionIndex}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2">
										<select
											className="h-8 rounded-md border border-input bg-background px-2 text-xs"
											value={condition.parameter}
											onChange={(event) => replaceCondition(this._newEntryCondition(controller, event.target.value, operator))}
										>
											{parameterNames.map((name) => (
												<option key={name} value={name}>
													{name}
												</option>
											))}
										</select>
										<select
											className="h-8 rounded-md border border-input bg-background px-2 text-xs"
											value={operator}
											onChange={(event) => replaceCondition(this._newEntryCondition(controller, condition.parameter, event.target.value))}
										>
											<option value="equals">Equals</option>
											<option value="notEquals" disabled={controller.parameterTypes?.[condition.parameter] === "trigger"}>
												Not Equals
											</option>
											<option value="greaterThan" disabled={typeof controller.parameters[condition.parameter] !== "number"}>
												Greater Than
											</option>
											<option value="lessThan" disabled={typeof controller.parameters[condition.parameter] !== "number"}>
												Less Than
											</option>
										</select>
										<Input
											className="h-8 text-xs"
											disabled={controller.parameterTypes?.[condition.parameter] === "trigger"}
											value={String(value)}
											onChange={(event) =>
												replaceCondition(
													this._newCondition(
														condition.parameter,
														operator,
														this._parseConditionValue(controller.parameters[condition.parameter], event.target.value, operator)
													)
												)
											}
											aria-label={`Entry ${condition.parameter} condition value`}
										/>
										<Button size="sm" variant="ghost" disabled={(transition.conditions?.length ?? 0) <= 1} onClick={() => replaceCondition(null)}>
											Remove
										</Button>
									</div>
								);
							})}
						</div>
					))}
				{owner.disabled !== true && !transitions.length && parameterNames.length > 0 && (
					<div className="text-xs text-muted-foreground">No conditional routes. Entry always uses the default destination.</div>
				)}
			</div>
		);
	}

	private _renderReusableSubgraphs(scene: Scene, controller: IAnimatorController): ReactNode {
		const subgraphs = controller.subgraphs ?? [];
		return (
			<section className="space-y-2">
				<div className="flex items-center justify-between gap-2">
					<div>
						<div className="font-medium">Reusable Controller Subgraphs</div>
						<div className="text-xs text-muted-foreground">
							Author a nested state machine once, then instantiate it in the base machine, layers, or other subgraphs.
						</div>
					</div>
					<Button size="sm" variant="secondary" onClick={() => this._addSubgraph(scene, controller)}>
						Add Subgraph
					</Button>
				</div>
				{subgraphs.map((subgraph) => (
					<div key={subgraph.id} className="space-y-3 rounded border border-violet-500/50 bg-violet-950/10 p-3">
						<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
							<Input
								value={subgraph.name}
								onChange={(event) => this._setSubgraph(scene, controller, subgraph, { name: event.target.value })}
								aria-label="Reusable subgraph name"
							/>
							<select
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={subgraph.entryState ?? subgraph.states[0].name}
								onChange={(event) => this._setSubgraph(scene, controller, subgraph, { entryState: event.target.value })}
								aria-label={`${subgraph.name} entry state`}
							>
								{this._machineNodes(subgraph).map((node) => (
									<option key={node} value={node}>
										Entry → {node}
									</option>
								))}
							</select>
							<Button size="sm" variant="destructive" onClick={() => this._deleteSubgraph(scene, controller, subgraph)}>
								Delete
							</Button>
						</div>
						{this._renderEntryTransitions(scene, controller, subgraph, { subgraphId: subgraph.id })}

						<div className="space-y-2">
							<div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
								<span>Direct States</span>
								<Button size="sm" variant="secondary" onClick={() => this._addSubgraphState(scene, controller, subgraph)}>
									Add State
								</Button>
							</div>
							{subgraph.states.map((state) => (
								<div key={state.name} className="space-y-2 rounded border border-input/50 p-2">
									<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
										<Input
											value={state.name}
											onChange={(event) => this._replaceSubgraphState(scene, controller, subgraph, state.name, { ...state, name: event.target.value })}
											aria-label={`${subgraph.name} state name`}
										/>
										{state.blendTree ? (
											this._renderNestedBlendTree(scene, controller, state.blendTree, (blendTree) =>
												this._replaceSubgraphState(scene, controller, subgraph, state.name, { ...state, animationGroup: undefined, blendTree })
											)
										) : (
											<select
												className="h-9 rounded-md border border-input bg-background px-3 text-sm"
												value={state.animationGroup ?? ""}
												onChange={(event) =>
													this._replaceSubgraphState(scene, controller, subgraph, state.name, { ...state, animationGroup: event.target.value })
												}
											>
												{scene.animationGroups.map((group) => (
													<option key={group.uniqueId} value={group.name}>
														{group.name}
													</option>
												))}
											</select>
										)}
										<Button
											size="sm"
											variant="ghost"
											disabled={subgraph.states.length === 1}
											onClick={() => this._removeSubgraphState(scene, controller, subgraph, state.name)}
										>
											Remove
										</Button>
									</div>
									{this._renderStatePlayback(controller, state, (replacement) =>
										this._replaceSubgraphState(scene, controller, subgraph, state.name, replacement)
									)}
									{this._renderStateBehaviours(scene, controller, state, { subgraphId: subgraph.id })}
								</div>
							))}
						</div>

						{this._renderSubStateMachines(scene, controller, subgraph.subStateMachines ?? [], undefined, subgraph.id)}

						<div className="space-y-2">
							<div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
								<span>Subgraph Transitions</span>
								<Button size="sm" variant="secondary" onClick={() => this._addSubgraphTransition(scene, controller, subgraph)}>
									Add Transition
								</Button>
							</div>
							{subgraph.transitions.map((transition, index) => this._renderSubgraphTransition(scene, controller, subgraph, transition, index))}
							{!subgraph.transitions.length && <div className="text-xs text-muted-foreground">No internal transitions.</div>}
						</div>
					</div>
				))}
				{!subgraphs.length && <div className="text-xs text-muted-foreground">No reusable subgraphs.</div>}
			</section>
		);
	}

	private _renderSubStateMachines(scene: Scene, controller: IAnimatorController, instances: IAnimatorSubStateMachine[], layer?: string, parentSubgraphId?: string): ReactNode {
		const subgraphs = (controller.subgraphs ?? []).filter((subgraph) => subgraph.id !== parentSubgraphId);
		const owner = parentSubgraphId ? controller.subgraphs?.find((candidate) => candidate.id === parentSubgraphId)?.name : layer ? `Layer ${layer}` : "Base Machine";
		return (
			<div className="space-y-2">
				<div className="flex items-center justify-between gap-2">
					<div>
						<div className="text-xs font-medium text-muted-foreground">Sub-State Machines</div>
						<div className="text-[11px] text-muted-foreground">{owner}: instances enter the selected reusable subgraph through its Entry node.</div>
					</div>
					<Button
						size="sm"
						variant="secondary"
						disabled={!subgraphs.length}
						onClick={() => this._addSubStateMachine(scene, controller, instances, layer, parentSubgraphId)}
					>
						Add Instance
					</Button>
				</div>
				{instances.map((instance) => {
					const position = instance.graphPosition ?? [0, 0];
					return (
						<div key={instance.name} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5rem_5rem_auto] items-center gap-2">
							<Input
								value={instance.name}
								onChange={(event) => this._setSubStateMachine(scene, controller, instance, { name: event.target.value }, layer, parentSubgraphId)}
								aria-label="Sub-state-machine instance name"
							/>
							<select
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={instance.subgraphId}
								onChange={(event) => this._setSubStateMachine(scene, controller, instance, { subgraphId: event.target.value }, layer, parentSubgraphId)}
								aria-label={`${instance.name} reusable subgraph`}
							>
								{subgraphs.map((subgraph) => (
									<option key={subgraph.id} value={subgraph.id}>
										{subgraph.name}
									</option>
								))}
							</select>
							<Input
								type="number"
								value={String(position[0])}
								onChange={(event) =>
									this._setSubStateMachine(scene, controller, instance, { graphPosition: [Number(event.target.value), position[1]] }, layer, parentSubgraphId)
								}
								aria-label={`${instance.name} graph x position`}
							/>
							<Input
								type="number"
								value={String(position[1])}
								onChange={(event) =>
									this._setSubStateMachine(scene, controller, instance, { graphPosition: [position[0], Number(event.target.value)] }, layer, parentSubgraphId)
								}
								aria-label={`${instance.name} graph y position`}
							/>
							<Button size="sm" variant="ghost" onClick={() => this._removeSubStateMachine(scene, controller, instance, layer, parentSubgraphId)}>
								Remove
							</Button>
						</div>
					);
				})}
				{!instances.length && <div className="text-xs text-muted-foreground">No nested state-machine instances.</div>}
			</div>
		);
	}

	private _renderSubgraphTransition(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph, transition: IAnimatorTransition, index: number): ReactNode {
		const conditions = transition.conditions ?? [];
		return (
			<div key={`${transition.from}-${transition.to}-${index}`} className="space-y-2 rounded border border-input p-2">
				<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={transition.from}
						onChange={(event) => this._replaceSubgraphTransition(scene, controller, subgraph, index, { ...transition, from: event.target.value })}
					>
						<option value={ANIMATOR_ANY_STATE}>Any State</option>
						{this._machineNodes(subgraph).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
					</select>
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={transition.to}
						onChange={(event) =>
							this._replaceSubgraphTransition(scene, controller, subgraph, index, {
								...transition,
								to: event.target.value,
								...(event.target.value === ANIMATOR_EXIT_STATE ? { offset: undefined } : {}),
							})
						}
					>
						{this._machineNodes(subgraph).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
						<option value={ANIMATOR_EXIT_STATE}>Exit</option>
					</select>
					<Button size="sm" variant="ghost" onClick={() => this._removeSubgraphTransition(scene, controller, subgraph, index)}>
						Remove
					</Button>
				</div>
				<div className="grid gap-2 md:grid-cols-2">
					<label className="text-xs text-muted-foreground">
						Exit Time (0–1)
						<Input
							type="number"
							min={0}
							max={1}
							step={0.01}
							value={transition.exitTime ?? ""}
							onChange={(event) =>
								this._replaceSubgraphTransition(scene, controller, subgraph, index, {
									...transition,
									...(event.target.value === "" ? { exitTime: undefined } : { exitTime: Number(event.target.value) }),
								})
							}
						/>
					</label>
					<label className="text-xs text-muted-foreground">
						Blend Duration
						<Input
							type="number"
							min={0}
							step={0.01}
							value={transition.duration ?? ""}
							onChange={(event) =>
								this._replaceSubgraphTransition(scene, controller, subgraph, index, {
									...transition,
									...(event.target.value === "" ? { duration: undefined } : { duration: Number(event.target.value) }),
								})
							}
						/>
						<select
							className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
							value={transition.durationMode ?? "seconds"}
							onChange={(event) =>
								this._replaceSubgraphTransition(scene, controller, subgraph, index, { ...transition, durationMode: event.target.value as "seconds" | "normalized" })
							}
						>
							<option value="seconds">Seconds</option>
							<option value="normalized">Normalized Source Time</option>
						</select>
					</label>
				</div>
				{this._renderTransitionInterruptionControls(transition, (replacement) => this._replaceSubgraphTransition(scene, controller, subgraph, index, replacement))}
				<div className="flex items-center justify-between">
					<div className="text-xs font-medium text-muted-foreground">Conditions ({conditions.length}; all must match)</div>
					<Button
						size="sm"
						variant="secondary"
						disabled={!Object.keys(controller.parameters).length}
						onClick={() => this._addSubgraphCondition(scene, controller, subgraph, index)}
					>
						Add Condition
					</Button>
				</div>
				{conditions.map((condition, conditionIndex) => this._renderSubgraphCondition(scene, controller, subgraph, index, condition, conditionIndex))}
				{!conditions.length && <div className="text-xs text-muted-foreground">Unconditional transition.</div>}
			</div>
		);
	}

	private _renderSubgraphCondition(
		scene: Scene,
		controller: IAnimatorController,
		subgraph: IAnimatorSubgraph,
		transitionIndex: number,
		condition: IAnimatorTransitionCondition,
		conditionIndex: number
	): ReactNode {
		const operator =
			condition.equals !== undefined ? "equals" : condition.notEquals !== undefined ? "notEquals" : condition.greaterThan !== undefined ? "greaterThan" : "lessThan";
		const value = condition.equals ?? condition.notEquals ?? condition.greaterThan ?? condition.lessThan ?? "";
		return (
			<div key={`${condition.parameter}-${conditionIndex}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2">
				<select
					className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					value={condition.parameter}
					onChange={(event) =>
						this._replaceSubgraphCondition(
							scene,
							controller,
							subgraph,
							transitionIndex,
							conditionIndex,
							this._newCondition(event.target.value, operator, controller.parameters[event.target.value])
						)
					}
				>
					{Object.keys(controller.parameters).map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
				<select
					className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					value={operator}
					onChange={(event) =>
						this._replaceSubgraphCondition(
							scene,
							controller,
							subgraph,
							transitionIndex,
							conditionIndex,
							this._newCondition(condition.parameter, event.target.value, controller.parameters[condition.parameter])
						)
					}
				>
					<option value="equals">Equals</option>
					<option value="notEquals">Not Equals</option>
					<option value="greaterThan" disabled={typeof controller.parameters[condition.parameter] !== "number"}>
						Greater Than
					</option>
					<option value="lessThan" disabled={typeof controller.parameters[condition.parameter] !== "number"}>
						Less Than
					</option>
				</select>
				<Input
					className="h-8 text-xs"
					value={String(value)}
					onChange={(event) =>
						this._replaceSubgraphCondition(
							scene,
							controller,
							subgraph,
							transitionIndex,
							conditionIndex,
							this._newCondition(condition.parameter, operator, this._parseConditionValue(controller.parameters[condition.parameter], event.target.value, operator))
						)
					}
					aria-label={`${subgraph.name} ${condition.parameter} condition value`}
				/>
				<Button size="sm" variant="ghost" onClick={() => this._removeSubgraphCondition(scene, controller, subgraph, transitionIndex, conditionIndex)}>
					Remove
				</Button>
			</div>
		);
	}

	private _renderState(scene: Scene, controller: IAnimatorController, state: IAnimatorState): ReactNode {
		if (state.blendTree) {
			const isDirect = state.blendTree.blendMode === "direct";
			const is2D = !isDirect && !!state.blendTree.parameterX;
			const numericParameters = Object.entries(controller.parameters)
				.filter(([, value]) => typeof value === "number")
				.map(([name]) => name);
			return (
				<div key={state.name} className="space-y-2 rounded border border-input p-2">
					<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 items-center">
						<Input
							value={state.name}
							onChange={(event) => this._replaceState(scene, controller, state.name, { ...state, name: event.target.value })}
							aria-label="Blend tree state name"
						/>
						<Button size="sm" variant={controller.activeState === state.name ? "default" : "secondary"} onClick={() => this._play(scene, controller, state.name)}>
							Play
						</Button>
						<Button size="sm" variant="ghost" disabled={controller.states.length === 1} onClick={() => this._removeState(scene, controller, state.name)}>
							Remove
						</Button>
					</div>
					<div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 items-center text-sm">
						<span>Mode</span>
						<select
							className="h-9 rounded-md border border-input bg-background px-3 text-sm"
							value={isDirect ? "direct" : is2D ? "2d" : "1d"}
							onChange={(event) => this._setBlendTreeMode(scene, controller, state, event.target.value as "1d" | "2d" | "direct")}
						>
							<option value="1d">1D</option>
							<option value="2d">2D Cartesian</option>
							<option value="direct">Direct</option>
						</select>
					</div>
					{isDirect ? (
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={state.blendTree.normalizeWeights ?? false}
								onChange={(event) =>
									this._replaceState(scene, controller, state.name, { ...state, blendTree: { ...state.blendTree!, normalizeWeights: event.target.checked } })
								}
							/>
							Normalize Blend Values
						</label>
					) : is2D ? (
						<div className="grid grid-cols-3 gap-2 text-sm">
							<Input
								value={state.blendTree.parameterX ?? ""}
								onChange={(event) =>
									this._replaceState(scene, controller, state.name, { ...state, blendTree: { ...state.blendTree!, parameterX: event.target.value } })
								}
								aria-label="Blend X parameter"
							/>
							<Input
								value={state.blendTree.parameterY ?? ""}
								onChange={(event) =>
									this._replaceState(scene, controller, state.name, { ...state, blendTree: { ...state.blendTree!, parameterY: event.target.value } })
								}
								aria-label="Blend Y parameter"
							/>
							<select
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={state.blendTree.blendMode ?? "cartesian"}
								onChange={(event) =>
									this._replaceState(scene, controller, state.name, {
										...state,
										blendTree: { ...state.blendTree!, blendMode: event.target.value as "cartesian" | "directional" | "freeformDirectional" },
									})
								}
								aria-label="2D blend mode"
							>
								<option value="cartesian">Cartesian</option>
								<option value="directional">Directional</option>
								<option value="freeformDirectional">Freeform Directional</option>
							</select>
						</div>
					) : (
						<div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 items-center text-sm">
							<span>Blend Parameter</span>
							<Input
								value={state.blendTree.parameter ?? ""}
								onChange={(event) =>
									this._replaceState(scene, controller, state.name, { ...state, blendTree: { ...state.blendTree!, parameter: event.target.value } })
								}
								aria-label="Blend parameter"
							/>
						</div>
					)}
					{this._renderStateMask(scene, controller, state)}
					{this._renderStatePlayback(controller, state, (replacement) => this._replaceState(scene, controller, state.name, replacement))}
					{this._renderStateBehaviours(scene, controller, state)}
					{this._renderGraphPosition(scene, controller, state)}
					<div className="flex items-center justify-between gap-2">
						<div className="text-xs font-medium text-muted-foreground">Children</div>
						<Button
							size="sm"
							variant="secondary"
							disabled={!scene.animationGroups.length || state.blendTree.children.length >= 64}
							onClick={() => this._addBlendTreeChild(scene, controller, state)}
						>
							Add Child
						</Button>
					</div>
					{state.blendTree.children.map((child, index) => (
						<div
							key={`${child.animationGroup ?? "nested"}-${index}`}
							className={
								is2D ? "grid grid-cols-[minmax(0,1fr)_5rem_5rem_auto_auto] gap-2 items-start" : "grid grid-cols-[minmax(0,1fr)_7rem_auto_auto] gap-2 items-start"
							}
						>
							{child.blendTree ? (
								this._renderNestedBlendTree(scene, controller, child.blendTree, (blendTree) =>
									this._replaceBlendTreeChild(scene, controller, state, index, { ...child, blendTree, animationGroup: undefined })
								)
							) : (
								<select
									className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
									value={child.animationGroup}
									onChange={(event) =>
										this._replaceBlendTreeChild(scene, controller, state, index, { ...child, animationGroup: event.target.value, blendTree: undefined })
									}
								>
									{scene.animationGroups.map((group) => (
										<option key={group.uniqueId} value={group.name}>
											{group.name}
										</option>
									))}
								</select>
							)}
							{isDirect ? (
								<select
									className="h-8 rounded-md border border-input bg-background px-2 text-xs"
									value={child.directParameter ?? ""}
									onChange={(event) => this._replaceBlendTreeChild(scene, controller, state, index, { ...child, directParameter: event.target.value })}
									aria-label={`${child.animationGroup ?? "Nested tree"} direct blend parameter`}
								>
									{numericParameters.map((name) => (
										<option key={name} value={name}>
											{name}
										</option>
									))}
								</select>
							) : is2D ? (
								<>
									<Input
										type="number"
										step="any"
										value={String(child.position?.[0] ?? 0)}
										onChange={(event) =>
											this._replaceBlendTreeChild(scene, controller, state, index, {
												...child,
												position: [Number(event.target.value), child.position?.[1] ?? 0],
											})
										}
										aria-label={`${child.animationGroup ?? "Nested tree"} blend X position`}
									/>
									<Input
										type="number"
										step="any"
										value={String(child.position?.[1] ?? 0)}
										onChange={(event) =>
											this._replaceBlendTreeChild(scene, controller, state, index, {
												...child,
												position: [child.position?.[0] ?? 0, Number(event.target.value)],
											})
										}
										aria-label={`${child.animationGroup ?? "Nested tree"} blend Y position`}
									/>
								</>
							) : (
								<Input
									type="number"
									step="any"
									value={String(child.threshold ?? 0)}
									onChange={(event) => this._replaceBlendTreeChild(scene, controller, state, index, { ...child, threshold: Number(event.target.value) })}
									aria-label={`${child.animationGroup ?? "Nested tree"} blend threshold`}
								/>
							)}
							<Button size="sm" variant="secondary" onClick={() => this._toggleNestedBlendTreeChild(scene, controller, state, index)}>
								{child.blendTree ? "Use Clip" : "Nest"}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={state.blendTree!.children.length <= 2}
								onClick={() => this._removeBlendTreeChild(scene, controller, state, index)}
							>
								Remove
							</Button>
							<div className="col-span-full">
								{this._renderBlendTreeChildModifiers(child, (replacement) => this._replaceBlendTreeChild(scene, controller, state, index, replacement))}
							</div>
						</div>
					))}
				</div>
			);
		}
		return (
			<div key={state.name} className="space-y-2 rounded border border-input p-2">
				<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-2 items-center">
					<Input
						value={state.name}
						onChange={(event) => this._replaceState(scene, controller, state.name, { ...state, name: event.target.value })}
						aria-label="State name"
					/>
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={state.animationGroup ?? ""}
						onChange={(event) => this._replaceState(scene, controller, state.name, { ...state, animationGroup: event.target.value })}
					>
						{scene.animationGroups.map((group) => (
							<option key={group.uniqueId} value={group.name}>
								{group.name}
							</option>
						))}
					</select>
					<Button size="sm" variant={controller.activeState === state.name ? "default" : "secondary"} onClick={() => this._play(scene, controller, state.name)}>
						Play
					</Button>
					<Button size="sm" variant="ghost" disabled={controller.states.length === 1} onClick={() => this._removeState(scene, controller, state.name)}>
						Remove
					</Button>
				</div>
				{this._renderStateMask(scene, controller, state)}
				{this._renderStatePlayback(controller, state, (replacement) => this._replaceState(scene, controller, state.name, replacement))}
				{this._renderStateBehaviours(scene, controller, state)}
				{this._renderGraphPosition(scene, controller, state)}
			</div>
		);
	}

	private _renderStatePlayback(controller: IAnimatorController, state: IAnimatorState, onChange: (replacement: IAnimatorState) => void): ReactNode {
		const source = state.unitySource;
		const runtimeBindings = {
			Speed: state.speedParameter === undefined ? source?.speedParameter : state.speedParameter,
			Mirror: state.mirrorParameter === undefined ? source?.mirrorParameter : state.mirrorParameter,
			"Cycle Offset": state.cycleOffsetParameter === undefined ? source?.cycleOffsetParameter : state.cycleOffsetParameter,
			Time: state.timeParameter === undefined ? source?.timeParameter : state.timeParameter,
		};
		const floatParameters = Object.keys(controller.parameters).filter(
			(name) => (controller.parameterTypes?.[name] ?? (typeof controller.parameters[name] === "number" ? "float" : "string")) === "float"
		);
		const boolParameters = Object.keys(controller.parameters).filter(
			(name) => (controller.parameterTypes?.[name] ?? (typeof controller.parameters[name] === "boolean" ? "bool" : "string")) === "bool"
		);
		const bindings = source
			? (
					[
						["Speed", source.speedParameter],
						["Mirror", source.mirrorParameter],
						["Cycle Offset", source.cycleOffsetParameter],
						["Time", source.timeParameter],
					] as Array<[string, string | null]>
				).filter((entry): entry is [keyof typeof runtimeBindings, string] => !!entry[1])
			: [];
		return (
			<div className="space-y-2 rounded border border-input/40 p-2 text-xs">
				<div className="font-medium text-muted-foreground">State Playback</div>
				<div className="grid grid-cols-2 gap-2 md:grid-cols-4">
					<label className="space-y-1">
						<span className="text-muted-foreground">Speed</span>
						<Input
							type="number"
							step="any"
							value={String(state.speed ?? 1)}
							onChange={(event) => onChange({ ...state, speed: Number(event.target.value) })}
							aria-label={`${state.name} playback speed`}
						/>
					</label>
					<label className="space-y-1">
						<span className="text-muted-foreground">Cycle Offset</span>
						<Input
							type="number"
							min={0}
							max={1}
							step="0.01"
							value={String(state.cycleOffset ?? 0)}
							onChange={(event) => onChange({ ...state, cycleOffset: Number(event.target.value) || undefined })}
							aria-label={`${state.name} cycle offset`}
						/>
					</label>
					<label className="flex items-end gap-2 pb-2">
						<input type="checkbox" checked={state.loop ?? true} onChange={(event) => onChange({ ...state, loop: event.target.checked })} />
						Loop
					</label>
					<label className="flex items-end gap-2 pb-2">
						<input type="checkbox" checked={state.mirror ?? false} onChange={(event) => onChange({ ...state, mirror: event.target.checked || undefined })} />
						Mirror
					</label>
					<label className="flex items-end gap-2 pb-2">
						<input type="checkbox" checked={state.footIK ?? false} onChange={(event) => onChange({ ...state, footIK: event.target.checked || undefined })} />
						Foot IK
					</label>
					<label className="flex items-end gap-2 pb-2">
						<input
							type="checkbox"
							checked={state.writeDefaultValues ?? false}
							onChange={(event) => onChange({ ...state, writeDefaultValues: event.target.checked || undefined })}
						/>
						Write Defaults
					</label>
				</div>
				<div className="grid grid-cols-2 gap-2 md:grid-cols-4">
					{(
						[
							["Speed Parameter", "speedParameter", floatParameters],
							["Mirror Parameter", "mirrorParameter", boolParameters],
							["Cycle Parameter", "cycleOffsetParameter", floatParameters],
							["Time Parameter", "timeParameter", floatParameters],
						] as Array<[string, "speedParameter" | "mirrorParameter" | "cycleOffsetParameter" | "timeParameter", string[]]>
					).map(([label, field, choices]) => (
						<label className="space-y-1" key={field}>
							<span className="text-muted-foreground">{label}</span>
							<select
								className="h-8 w-full rounded border border-input bg-background px-2"
								value={state[field] ?? ""}
								onChange={(event) => onChange({ ...state, [field]: event.target.value || null })}
								aria-label={`${state.name} ${label.toLowerCase()}`}
							>
								<option value="">None</option>
								{choices.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
						</label>
					))}
				</div>
				<label className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
					<span className="text-muted-foreground">Tag</span>
					<Input
						value={state.tag ?? ""}
						maxLength={256}
						onChange={(event) => onChange({ ...state, tag: event.target.value || undefined })}
						aria-label={`${state.name} tag`}
					/>
				</label>
				{source && (
					<div className="rounded bg-muted/40 p-2 text-muted-foreground">
						Unity state fileID {source.fileId} · serializedVersion {source.serializedVersion ?? "unversioned"}
						{source.footIKField && ` · Foot IK field ${source.footIKField}`}
						{state.footIK !== undefined && ` · Foot IK ${state.footIK ? "on" : "off"} (bounded ground-contact runtime)`}
						{state.writeDefaultValues !== undefined && ` · Write Defaults ${state.writeDefaultValues ? "on" : "off"} (bounded controller-default runtime)`}
						{bindings.map(([label, parameter]) => (
							<div key={label} className="text-amber-300">
								{label} parameter “{parameter}” preserved
								{runtimeBindings[label] === parameter
									? " and executed at runtime."
									: runtimeBindings[label]
										? `; runtime uses “${runtimeBindings[label]}”.`
										: "; runtime binding is disabled."}
							</div>
						))}
					</div>
				)}
			</div>
		);
	}

	private _renderGraphPosition(scene: Scene, controller: IAnimatorController, state: IAnimatorState): ReactNode {
		const position = state.graphPosition ?? [0, 0];
		return (
			<div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-xs">
				<span className="text-muted-foreground">Graph position</span>
				<Input
					className="h-7 text-xs"
					type="number"
					value={String(position[0])}
					aria-label={`${state.name} graph x position`}
					onChange={(event) => this._setGraphPosition(scene, controller, state, 0, event.target.value)}
				/>
				<Input
					className="h-7 text-xs"
					type="number"
					value={String(position[1])}
					aria-label={`${state.name} graph y position`}
					onChange={(event) => this._setGraphPosition(scene, controller, state, 1, event.target.value)}
				/>
			</div>
		);
	}

	private _renderStateBehaviours(scene: Scene, controller: IAnimatorController, state: IAnimatorState, owner: { layer?: string; subgraphId?: string } = {}): ReactNode {
		const target = controller.targetNodeId ? (scene.getNodeById(controller.targetNodeId) as any) : null;
		const attachedScriptKeys = [...new Set<string>((target?.metadata?.scripts ?? []).map((script: any) => script.key))].sort((left, right) => left.localeCompare(right));
		const behaviours = state.behaviours ?? [];
		const setBehaviours = (replacement: NonNullable<IAnimatorState["behaviours"]>): void => {
			setAnimatorStateBehaviours(
				scene,
				{ controllerId: controller.id, state: state.name, layer: owner.layer, subgraphId: owner.subgraphId, behaviours: replacement },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		};
		return (
			<div className="space-y-1 rounded border border-input/70 p-2 text-xs">
				<div className="flex items-center justify-between gap-2">
					<div>
						<div className="font-medium">State Behaviours</div>
						<div className="text-muted-foreground">Calls onAnimatorStateEnter, onAnimatorStateUpdate, and onAnimatorStateExit on attached target scripts.</div>
					</div>
					<Button
						size="sm"
						variant="secondary"
						disabled={!controller.targetNodeId || !attachedScriptKeys.length || behaviours.length >= 16}
						onClick={() => setBehaviours([...behaviours, { id: Tools.RandomId(), scriptKey: attachedScriptKeys[0], enabled: true }])}
					>
						Add Behaviour
					</Button>
				</div>
				{behaviours.map((behaviour, index) => {
					const scriptKeys = [...new Set([...attachedScriptKeys, behaviour.scriptKey])];
					return (
						<div key={behaviour.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
							<input
								type="checkbox"
								checked={behaviour.enabled !== false}
								onChange={(event) =>
									setBehaviours(
										behaviours.map((candidate, candidateIndex) => (candidateIndex === index ? { ...candidate, enabled: event.target.checked } : candidate))
									)
								}
								aria-label={`${state.name} ${behaviour.scriptKey} behaviour enabled`}
							/>
							<select
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={behaviour.scriptKey}
								onChange={(event) =>
									setBehaviours(
										behaviours.map((candidate, candidateIndex) => (candidateIndex === index ? { ...candidate, scriptKey: event.target.value } : candidate))
									)
								}
							>
								{scriptKeys.map((scriptKey) => (
									<option key={scriptKey} value={scriptKey}>
										{scriptKey}
									</option>
								))}
							</select>
							<Button size="sm" variant="ghost" onClick={() => setBehaviours(behaviours.filter((_, candidateIndex) => candidateIndex !== index))}>
								Remove
							</Button>
						</div>
					);
				})}
				{!controller.targetNodeId && <div className="text-muted-foreground">Select a target node above before binding behaviours.</div>}
				{!!controller.targetNodeId && !attachedScriptKeys.length && <div className="text-muted-foreground">Attach a project script to the target node first.</div>}
			</div>
		);
	}

	private _renderSynchronizedBehaviours(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, sourceStateName: string): ReactNode {
		const target = controller.targetNodeId ? (scene.getNodeById(controller.targetNodeId) as any) : null;
		const attachedScriptKeys = [...new Set<string>((target?.metadata?.scripts ?? []).map((script: any) => script.key))].sort((left, right) => left.localeCompare(right));
		const hasOverride = Object.prototype.hasOwnProperty.call(layer.synchronizedBehaviourOverrides ?? {}, sourceStateName);
		const behaviours = layer.synchronizedBehaviourOverrides?.[sourceStateName] ?? [];
		const setBehaviours = (replacement: NonNullable<IAnimatorState["behaviours"]> | null): void => {
			const behaviourOverrides = { ...(layer.synchronizedBehaviourOverrides ?? {}) };
			if (replacement === null) {
				delete behaviourOverrides[sourceStateName];
			} else {
				behaviourOverrides[sourceStateName] = replacement;
			}
			this._setSynchronizedOverrides(scene, controller, layer, layer.synchronizedMotionOverrides ?? {}, behaviourOverrides);
		};
		return (
			<div className="space-y-1 rounded border border-input/40 p-2 text-xs">
				<div className="flex items-center justify-between gap-2">
					<span className="text-muted-foreground">Behaviour Override</span>
					<div className="flex gap-1">
						{hasOverride && (
							<Button size="sm" variant="ghost" onClick={() => setBehaviours(null)}>
								Use Mapped Behaviours
							</Button>
						)}
						<Button
							size="sm"
							variant="secondary"
							disabled={!controller.targetNodeId || !attachedScriptKeys.length || behaviours.length >= 16}
							onClick={() => setBehaviours([...behaviours, { id: Tools.RandomId(), scriptKey: attachedScriptKeys[0], enabled: true }])}
						>
							Add Behaviour
						</Button>
					</div>
				</div>
				{hasOverride && !behaviours.length && <div className="text-muted-foreground">Callbacks explicitly cleared for this source state.</div>}
				{!hasOverride && <div className="text-muted-foreground">Using behaviours from the mapped target state.</div>}
				{behaviours.map((behaviour, index) => (
					<div key={behaviour.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
						<input
							type="checkbox"
							checked={behaviour.enabled !== false}
							onChange={(event) =>
								setBehaviours(
									behaviours.map((candidate, candidateIndex) => (candidateIndex === index ? { ...candidate, enabled: event.target.checked } : candidate))
								)
							}
						/>
						<select
							className="h-8 rounded-md border border-input bg-background px-2 text-xs"
							value={behaviour.scriptKey}
							onChange={(event) =>
								setBehaviours(
									behaviours.map((candidate, candidateIndex) => (candidateIndex === index ? { ...candidate, scriptKey: event.target.value } : candidate))
								)
							}
						>
							{[...new Set([...attachedScriptKeys, behaviour.scriptKey])].map((scriptKey) => (
								<option key={scriptKey} value={scriptKey}>
									{scriptKey}
								</option>
							))}
						</select>
						<Button size="sm" variant="ghost" onClick={() => setBehaviours(behaviours.filter((_, candidateIndex) => candidateIndex !== index))}>
							Remove
						</Button>
					</div>
				))}
			</div>
		);
	}

	private _renderBlendTreeChildModifiers(child: IAnimatorBlendTreeChild, onChange: (replacement: IAnimatorBlendTreeChild) => void): ReactNode {
		return (
			<div className="grid grid-cols-[auto_6rem_auto_6rem_auto] items-center gap-1 text-[11px] text-muted-foreground">
				<span>Time Scale</span>
				<Input
					type="number"
					step="any"
					value={String(child.timeScale ?? 1)}
					onChange={(event) => {
						const value = Number(event.target.value);
						if (Number.isFinite(value) && value !== 0) {
							onChange({ ...child, timeScale: value === 1 ? undefined : value });
						}
					}}
					aria-label={`${child.animationGroup ?? "Nested tree"} time scale`}
				/>
				<span>Cycle Offset</span>
				<Input
					type="number"
					min={0}
					max={1}
					step={0.01}
					value={String(child.cycleOffset ?? 0)}
					onChange={(event) => {
						const value = Math.min(1, Math.max(0, Number(event.target.value)));
						if (Number.isFinite(value)) {
							onChange({ ...child, cycleOffset: value === 0 ? undefined : value });
						}
					}}
					aria-label={`${child.animationGroup ?? "Nested tree"} cycle offset`}
				/>
				<label className="flex items-center gap-1 whitespace-nowrap">
					<input type="checkbox" checked={child.mirror ?? false} onChange={(event) => onChange({ ...child, mirror: event.target.checked || undefined })} />
					Mirror
				</label>
			</div>
		);
	}

	private _renderNestedBlendTree(scene: Scene, controller: IAnimatorController, tree: IAnimatorBlendTree, onChange: (tree: IAnimatorBlendTree) => void): ReactNode {
		const isDirect = tree.blendMode === "direct";
		const is2D = !isDirect && !!tree.parameterX;
		const numericParameters = Object.entries(controller.parameters)
			.filter(([, value]) => typeof value === "number")
			.map(([name]) => name);
		const replaceChild = (index: number, replacement: IAnimatorBlendTreeChild): void =>
			onChange({ ...tree, children: tree.children.map((child, childIndex) => (childIndex === index ? replacement : child)) });
		const toggleChild = (index: number): void => {
			const child = tree.children[index];
			const location = isDirect ? { directParameter: child.directParameter } : is2D ? { position: child.position } : { threshold: child.threshold };
			const modifiers = { timeScale: child.timeScale, cycleOffset: child.cycleOffset, mirror: child.mirror };
			if (child.blendTree) {
				replaceChild(index, {
					...location,
					...modifiers,
					animationGroup: getAnimatorBlendTreeAnimationGroups(child.blendTree)[0] ?? scene.animationGroups[0]?.name,
				});
				return;
			}
			const alternate = scene.animationGroups.find((group) => group.name !== child.animationGroup)?.name;
			if (!child.animationGroup || !alternate) {
				return;
			}
			replaceChild(index, {
				...location,
				...modifiers,
				blendTree: {
					parameter: numericParameters[0] ?? "blend",
					children: [
						{ animationGroup: child.animationGroup, threshold: 0 },
						{ animationGroup: alternate, threshold: 1 },
					],
				},
			});
		};
		return (
			<div className="space-y-1 rounded border border-input/50 p-2 text-xs">
				<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
					<span className="font-medium">Nested Blend Tree</span>
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={isDirect ? "direct" : is2D ? "2d" : "1d"}
						onChange={(event) => {
							const mode = event.target.value as "1d" | "2d" | "direct";
							const children = tree.children.map((child, index) =>
								mode === "direct"
									? {
											...child,
											threshold: undefined,
											position: undefined,
											directParameter: child.directParameter ?? numericParameters[index] ?? numericParameters[0] ?? "blend",
										}
									: mode === "2d"
										? { ...child, threshold: undefined, directParameter: undefined, position: child.position ?? [index, 0] }
										: { ...child, position: undefined, directParameter: undefined, threshold: child.threshold ?? index }
							);
							onChange(
								mode === "direct"
									? { blendMode: "direct", normalizeWeights: false, children }
									: mode === "2d"
										? {
												parameterX: numericParameters[0] ?? "blendX",
												parameterY: numericParameters[1] ?? numericParameters[0] ?? "blendY",
												blendMode: "cartesian",
												children,
											}
										: { parameter: numericParameters[0] ?? "blend", children }
							);
						}}
					>
						<option value="1d">1D</option>
						<option value="2d">2D</option>
						<option value="direct">Direct</option>
					</select>
				</div>
				{isDirect ? (
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={tree.normalizeWeights ?? false} onChange={(event) => onChange({ ...tree, normalizeWeights: event.target.checked })} />
						Normalize Blend Values
					</label>
				) : (
					<div className={is2D ? "grid grid-cols-2 gap-1" : "grid grid-cols-1 gap-1"}>
						{(is2D ? [tree.parameterX, tree.parameterY] : [tree.parameter]).map((parameter, index) => (
							<select
								key={index}
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={parameter ?? ""}
								onChange={(event) =>
									onChange(is2D ? { ...tree, [index === 0 ? "parameterX" : "parameterY"]: event.target.value } : { ...tree, parameter: event.target.value })
								}
							>
								{numericParameters.map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
						))}
					</div>
				)}
				{tree.children.map((child, index) => (
					<div key={`${child.animationGroup ?? "nested"}-${index}`} className="space-y-1 rounded border border-input/30 p-1">
						<div className="grid grid-cols-[minmax(0,1fr)_5rem_auto_auto] items-center gap-1">
							{child.blendTree ? (
								<span className="truncate">Nested tree</span>
							) : (
								<select
									className="h-8 rounded-md border border-input bg-background px-2 text-xs"
									value={child.animationGroup ?? ""}
									onChange={(event) => replaceChild(index, { ...child, animationGroup: event.target.value, blendTree: undefined })}
								>
									{scene.animationGroups.map((group) => (
										<option key={group.uniqueId} value={group.name}>
											{group.name}
										</option>
									))}
								</select>
							)}
							{isDirect ? (
								<select
									className="h-8 rounded-md border border-input bg-background px-2 text-xs"
									value={child.directParameter ?? ""}
									onChange={(event) => replaceChild(index, { ...child, directParameter: event.target.value })}
								>
									{numericParameters.map((name) => (
										<option key={name} value={name}>
											{name}
										</option>
									))}
								</select>
							) : (
								<Input
									type="number"
									step="any"
									value={String(is2D ? (child.position?.[0] ?? 0) : (child.threshold ?? 0))}
									onChange={(event) =>
										replaceChild(
											index,
											is2D
												? { ...child, position: [Number(event.target.value), child.position?.[1] ?? 0] }
												: { ...child, threshold: Number(event.target.value) }
										)
									}
								/>
							)}
							<Button size="sm" variant="secondary" onClick={() => toggleChild(index)}>
								{child.blendTree ? "Use Clip" : "Nest"}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={tree.children.length <= 2}
								onClick={() => onChange({ ...tree, children: tree.children.filter((_, childIndex) => childIndex !== index) })}
							>
								Remove
							</Button>
						</div>
						{is2D && (
							<Input
								type="number"
								step="any"
								value={String(child.position?.[1] ?? 0)}
								onChange={(event) => replaceChild(index, { ...child, position: [child.position?.[0] ?? 0, Number(event.target.value)] })}
							/>
						)}
						{this._renderBlendTreeChildModifiers(child, (replacement) => replaceChild(index, replacement))}
						{child.blendTree && this._renderNestedBlendTree(scene, controller, child.blendTree, (blendTree) => replaceChild(index, { ...child, blendTree }))}
					</div>
				))}
				<Button
					size="sm"
					variant="secondary"
					disabled={tree.children.length >= 64}
					onClick={() => {
						const used = new Set(getAnimatorBlendTreeAnimationGroups(tree));
						const group = scene.animationGroups.find((candidate) => !used.has(candidate.name)) ?? scene.animationGroups[0];
						if (group) {
							onChange({
								...tree,
								children: [
									...tree.children,
									isDirect
										? { animationGroup: group.name, directParameter: numericParameters[0] ?? "blend" }
										: is2D
											? { animationGroup: group.name, position: [tree.children.length, 0] }
											: { animationGroup: group.name, threshold: tree.children.length },
								],
							});
						}
					}}
				>
					Add Nested Child
				</Button>
			</div>
		);
	}

	private _beginGraphDrag(
		event: MouseEvent<SVGGElement>,
		controller: IAnimatorController,
		state: IAnimatorState,
		position: { x: number; y: number },
		width: number,
		height: number
	): void {
		event.preventDefault();
		event.stopPropagation();
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) {
			return;
		}
		this.setState({
			graphDrag: {
				controllerId: controller.id,
				state: state.name,
				startPointer: this._getGraphPointer(event, svg, width, height),
				startPosition: [position.x, position.y],
				position: [position.x, position.y],
			},
		});
	}

	private _moveGraphDrag(event: MouseEvent<SVGSVGElement>, width: number, height: number): void {
		const drag = this.state.graphDrag;
		if (!drag) {
			return;
		}
		const pointer = this._getGraphPointer(event, event.currentTarget, width, height);
		this.setState({
			graphDrag: {
				...drag,
				position: [Math.max(0, drag.startPosition[0] + pointer[0] - drag.startPointer[0]), Math.max(0, drag.startPosition[1] + pointer[1] - drag.startPointer[1])],
			},
		});
	}

	private _endGraphDrag(scene: Scene, controller: IAnimatorController): void {
		const drag = this.state.graphDrag;
		if (!drag || drag.controllerId !== controller.id) {
			return;
		}
		this.setState({ graphDrag: null });
		setAnimatorStateGraphPosition(scene, { controllerId: controller.id, state: drag.state, position: drag.position }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _getGraphPointer(event: MouseEvent<SVGElement>, svg: SVGSVGElement, width: number, height: number): [number, number] {
		const bounds = svg.getBoundingClientRect();
		return [(event.clientX - bounds.left) * (width / bounds.width), (event.clientY - bounds.top) * (height / bounds.height)];
	}

	private _renderLayer(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer): ReactNode {
		const activeState = layer.activeState ?? layer.states[0].name;
		const activeSelection = activeState.split("/")[0];
		const layerIndex = (controller.layers ?? []).findIndex((candidate) => candidate.name === layer.name);
		const earlierLayers = (controller.layers ?? []).slice(0, Math.max(0, layerIndex));
		const synchronized = !!layer.synchronizedLayer;
		const sourceGraph = synchronized
			? getAnimatorCompiledGraph(scene, {
					controllerId: controller.id,
					...(layer.synchronizedLayer === "$base" ? {} : { layer: layer.synchronizedLayer }),
				})
			: null;
		const targetGraph = synchronized ? getAnimatorCompiledGraph(scene, { controllerId: controller.id, layer: layer.name }) : null;
		const sourceStates = (sourceGraph?.states ?? []) as { name: string; sourceStateName: string }[];
		const targetStates = (targetGraph?.states ?? []) as { name: string; sourceStateName: string }[];
		return (
			<div key={layer.name} className="space-y-2 rounded border border-input p-2">
				<div className="grid grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)_auto_auto] gap-2 items-center">
					<Input
						value={layer.name}
						onChange={(event) => this._replaceLayer(scene, controller, layer.name, { ...layer, name: event.target.value })}
						aria-label="Animator layer name"
					/>
					<Input
						type="number"
						min="0"
						max="1"
						step="0.1"
						value={String(layer.weight ?? 1)}
						onChange={(event) => {
							const weight = Number(event.target.value);
							if (Number.isFinite(weight) && weight >= 0 && weight <= 1) {
								this._replaceLayer(scene, controller, layer.name, { ...layer, weight });
							}
						}}
						aria-label={`${layer.name} weight`}
					/>
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={activeSelection}
						disabled={synchronized}
						onChange={(event) => this._playLayer(scene, controller, layer.name, event.target.value)}
					>
						{this._machineNodes(layer).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
					</select>
					<Button size="sm" variant="secondary" disabled={synchronized} onClick={() => this._playLayer(scene, controller, layer.name, activeSelection)}>
						Play
					</Button>
					<Button size="sm" variant="ghost" onClick={() => this._removeLayer(scene, controller, layer.name)}>
						Remove
					</Button>
				</div>
				<div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-xs">
					<span className="text-muted-foreground">Blending</span>
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={layer.blendingMode ?? "override"}
						onChange={(event) => this._replaceLayer(scene, controller, layer.name, { ...layer, blendingMode: event.target.value as "override" | "additive" })}
					>
						<option value="override">Override</option>
						<option value="additive">Additive</option>
					</select>
					<span className="text-muted-foreground">Reference Pose</span>
					<Input
						type="number"
						min="0"
						max="1"
						step="0.01"
						disabled={(layer.blendingMode ?? "override") !== "additive"}
						value={String(layer.referencePose?.normalizedTime ?? 0)}
						onChange={(event) => {
							const normalizedTime = Number(event.target.value);
							if (Number.isFinite(normalizedTime) && normalizedTime >= 0 && normalizedTime <= 1) {
								this._replaceLayer(scene, controller, layer.name, { ...layer, referencePose: { normalizedTime } });
							}
						}}
						aria-label={`${layer.name} additive reference pose normalized time`}
					/>
				</div>
				<div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-2 text-xs">
					<span className="text-muted-foreground">Sync Source</span>
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={layer.synchronizedLayer ?? ""}
						onChange={(event) => this._setLayerSynchronization(scene, controller, layer, event.target.value || null)}
					>
						<option value="">Independent</option>
						<option value="$base">Base Layer</option>
						{earlierLayers.map((candidate) => (
							<option key={candidate.name} value={candidate.name}>
								{candidate.name}
							</option>
						))}
					</select>
					<span className="text-muted-foreground">Affects Timing</span>
					<input
						type="checkbox"
						checked={layer.synchronizedTiming === true}
						disabled={!synchronized}
						onChange={(event) => this._replaceLayer(scene, controller, layer.name, { ...layer, synchronizedTiming: event.target.checked })}
						aria-label={`${layer.name} synchronized layer affects timing`}
					/>
					<span className="text-muted-foreground" title="Call onAnimatorIK on target-node scripts after this layer samples animation.">
						IK Pass
					</span>
					<input
						type="checkbox"
						checked={layer.ikPass === true}
						onChange={(event) => this._replaceLayer(scene, controller, layer.name, { ...layer, ikPass: event.target.checked })}
						aria-label={`${layer.name} IK Pass`}
					/>
				</div>
				{synchronized && (
					<div className="space-y-1 rounded border border-input/60 p-2">
						<div className="text-xs text-muted-foreground">
							This layer inherits state changes from {layer.synchronizedLayer === "$base" ? "the Base Layer" : layer.synchronizedLayer}. Map each compiled source
							state to a clip state in this layer.
						</div>
						{sourceStates.map((sourceState, sourceIndex) => {
							const mapped =
								layer.synchronizedStateMap?.[sourceState.name] ??
								targetStates.find((candidate) => candidate.name === sourceState.name)?.name ??
								targetStates.find((candidate) => candidate.sourceStateName === sourceState.sourceStateName)?.name ??
								targetStates[sourceIndex]?.name ??
								targetStates[0]?.name ??
								"";
							const motionOverride = layer.synchronizedMotionOverrides?.[sourceState.name];
							return (
								<div key={sourceState.name} className="space-y-1 rounded border border-input/30 p-2">
									<div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-xs">
										<span className="truncate" title={sourceState.name}>
											{sourceState.name}
										</span>
										<span className="text-muted-foreground">→</span>
										<select
											className="h-8 rounded-md border border-input bg-background px-2 text-xs"
											value={mapped}
											onChange={(event) =>
												this._replaceLayer(scene, controller, layer.name, {
													...layer,
													synchronizedStateMap: { ...(layer.synchronizedStateMap ?? {}), [sourceState.name]: event.target.value },
												})
											}
										>
											{targetStates.map((targetState) => (
												<option key={targetState.name} value={targetState.name}>
													{targetState.name}
												</option>
											))}
										</select>
										{motionOverride?.blendTree ? (
											<div className="space-y-1">
												{this._renderNestedBlendTree(scene, controller, motionOverride.blendTree, (blendTree) => {
													const motionOverrides = { ...(layer.synchronizedMotionOverrides ?? {}), [sourceState.name]: { blendTree } };
													this._setSynchronizedOverrides(scene, controller, layer, motionOverrides, layer.synchronizedBehaviourOverrides ?? {});
												})}
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														const motionOverrides = { ...(layer.synchronizedMotionOverrides ?? {}) };
														delete motionOverrides[sourceState.name];
														this._setSynchronizedOverrides(scene, controller, layer, motionOverrides, layer.synchronizedBehaviourOverrides ?? {});
													}}
												>
													Use mapped state motion
												</Button>
											</div>
										) : (
											<select
												className="h-8 rounded-md border border-input bg-background px-2 text-xs"
												value={motionOverride?.animationGroup ?? ""}
												onChange={(event) => {
													const motionOverrides = { ...(layer.synchronizedMotionOverrides ?? {}) };
													if (event.target.value) {
														motionOverrides[sourceState.name] = { animationGroup: event.target.value };
													} else {
														delete motionOverrides[sourceState.name];
													}
													this._setSynchronizedOverrides(scene, controller, layer, motionOverrides, layer.synchronizedBehaviourOverrides ?? {});
												}}
											>
												<option value="">Use mapped state motion</option>
												{scene.animationGroups.map((group) => (
													<option key={group.uniqueId} value={group.name}>
														Override: {group.name}
													</option>
												))}
											</select>
										)}
									</div>
									{this._renderSynchronizedBehaviours(scene, controller, layer, sourceState.name)}
								</div>
							);
						})}
					</div>
				)}
				<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs">
					<span className="text-muted-foreground">Entry State</span>
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={layer.entryState ?? layer.states[0].name}
						disabled={synchronized}
						onChange={(event) => this._setEntryState(scene, controller, event.target.value, false, layer.name)}
					>
						{this._machineNodes(layer).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
					</select>
					<Button
						size="sm"
						variant="secondary"
						disabled={synchronized}
						onClick={() => this._setEntryState(scene, controller, layer.entryState ?? layer.states[0].name, true, layer.name)}
					>
						Restart
					</Button>
				</div>
				{this._renderEntryTransitions(scene, controller, layer, { layer: layer.name, disabled: synchronized })}
				<div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
					<span>Layer States</span>
					<Button size="sm" variant="secondary" onClick={() => this._addLayerState(scene, controller, layer)}>
						Add State
					</Button>
				</div>
				{layer.states.map((state) => (
					<div key={state.name} className="space-y-2 rounded border border-input/50 p-2">
						<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-center">
							<Input
								value={state.name}
								onChange={(event) => this._replaceLayerState(scene, controller, layer, state.name, { ...state, name: event.target.value })}
								aria-label={`${layer.name} state name`}
							/>
							{state.blendTree ? (
								this._renderNestedBlendTree(scene, controller, state.blendTree, (blendTree) =>
									this._replaceLayerState(scene, controller, layer, state.name, { ...state, animationGroup: undefined, blendTree })
								)
							) : (
								<select
									className="h-9 rounded-md border border-input bg-background px-3 text-sm"
									value={state.animationGroup ?? ""}
									onChange={(event) => this._replaceLayerState(scene, controller, layer, state.name, { ...state, animationGroup: event.target.value })}
								>
									{scene.animationGroups.map((group) => (
										<option key={group.uniqueId} value={group.name}>
											{group.name}
										</option>
									))}
								</select>
							)}
							<Button size="sm" variant="ghost" disabled={layer.states.length === 1} onClick={() => this._removeLayerState(scene, controller, layer, state.name)}>
								Remove
							</Button>
						</div>
						{this._renderStatePlayback(controller, state, (replacement) => this._replaceLayerState(scene, controller, layer, state.name, replacement))}
						{this._renderStateBehaviours(scene, controller, state, { layer: layer.name })}
					</div>
				))}
				{this._renderSubStateMachines(scene, controller, layer.subStateMachines ?? [], layer.name)}
				{this._renderLayerMask(scene, controller, layer)}
				<div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
					<span>{synchronized ? "Transitions inherited from sync source" : "Layer Transitions"}</span>
					<Button size="sm" variant="secondary" disabled={synchronized} onClick={() => this._addLayerTransition(scene, controller, layer)}>
						Add Transition
					</Button>
				</div>
				{!synchronized && layer.transitions.map((transition, index) => this._renderLayerTransition(scene, controller, layer, transition, index))}
				{!synchronized && !layer.transitions.length && <div className="text-xs text-muted-foreground">No layer transitions.</div>}
			</div>
		);
	}

	private _renderLayerMask(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer): ReactNode {
		const targetNames = [...new Set(layer.states.flatMap((state) => this._getStateTargetNames(scene, state)))];
		const mask = layer.maskTargetNames ?? [];
		const avatarMasks = this._getAvatarMasks(scene);
		return (
			<div className="space-y-1">
				<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs">
					<span className="text-muted-foreground">Avatar Mask</span>
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={layer.avatarMaskId ?? ""}
						onChange={(event) => this._setLayerAvatarMask(scene, controller, layer, event.target.value || null)}
					>
						<option value="">None / Generic targets only</option>
						{avatarMasks.map((candidate: any) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
					</select>
				</div>
				{!targetNames.length && <div className="text-xs text-muted-foreground">This layer has no named animation targets for a generic mask.</div>}
				<div className="flex items-center justify-between gap-2">
					<div className="text-xs font-medium text-muted-foreground">Layer Mask (include targets)</div>
					<select
						className="h-7 max-w-44 rounded-md border border-input bg-background px-2 text-xs"
						value=""
						onChange={(event) => {
							if (event.target.value) {
								this._setLayerMask(scene, controller, layer, [...mask, event.target.value]);
							}
						}}
					>
						<option value="">Add target…</option>
						{targetNames
							.filter((name) => !mask.includes(name))
							.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
					</select>
				</div>
				{mask.length ? (
					<div className="flex flex-wrap gap-1">
						{mask.map((name) => (
							<Button
								key={name}
								size="sm"
								variant="secondary"
								className="h-6 px-2 text-xs"
								onClick={() =>
									this._setLayerMask(
										scene,
										controller,
										layer,
										mask.filter((candidate) => candidate !== name)
									)
								}
							>
								{name} ×
							</Button>
						))}
					</div>
				) : (
					<div className="text-xs text-muted-foreground">No layer mask: every layer target plays unless a state mask overrides it.</div>
				)}
			</div>
		);
	}

	private _renderLayerTransition(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, transition: IAnimatorTransition, index: number): ReactNode {
		const conditions = transition.conditions ?? [];
		return (
			<div key={`${transition.from}-${transition.to}-${index}`} className="space-y-2 rounded border border-input p-2">
				<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-center">
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={transition.from}
						onChange={(event) => this._replaceLayerTransition(scene, controller, layer, index, { ...transition, from: event.target.value })}
					>
						{this._machineNodes(layer).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
						<option value={ANIMATOR_ANY_STATE}>Any State</option>
					</select>
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={transition.to}
						onChange={(event) =>
							this._replaceLayerTransition(scene, controller, layer, index, {
								...transition,
								to: event.target.value,
								...(event.target.value === ANIMATOR_EXIT_STATE ? { offset: undefined } : {}),
							})
						}
					>
						{this._machineNodes(layer).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
						<option value={ANIMATOR_EXIT_STATE}>Exit</option>
					</select>
					<Button size="sm" variant="ghost" onClick={() => this._removeLayerTransition(scene, controller, layer, index)}>
						Remove
					</Button>
				</div>
				<label className="text-xs text-muted-foreground">
					Exit Time (0–1)
					<Input
						type="number"
						min={0}
						max={1}
						step={0.01}
						value={transition.exitTime ?? ""}
						onChange={(event) => {
							const value = event.target.value;
							this._replaceLayerTransition(scene, controller, layer, index, {
								...transition,
								...(value === "" ? { exitTime: undefined } : { exitTime: Number(value) }),
							});
						}}
						aria-label={`${transition.from} to ${transition.to} exit time`}
					/>
				</label>
				<label className="text-xs text-muted-foreground">
					Blend Duration
					<Input
						type="number"
						min={0}
						step={0.01}
						value={transition.duration ?? ""}
						onChange={(event) => {
							const value = event.target.value;
							this._replaceLayerTransition(scene, controller, layer, index, {
								...transition,
								...(value === "" ? { duration: undefined } : { duration: Number(value) }),
							});
						}}
						aria-label={`${transition.from} to ${transition.to} blend seconds`}
					/>
					<select
						className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
						value={transition.durationMode ?? "seconds"}
						onChange={(event) =>
							this._replaceLayerTransition(scene, controller, layer, index, { ...transition, durationMode: event.target.value as "seconds" | "normalized" })
						}
					>
						<option value="seconds">Seconds</option>
						<option value="normalized">Normalized Source Time</option>
					</select>
				</label>
				{this._renderTransitionInterruptionControls(transition, (replacement) => this._replaceLayerTransition(scene, controller, layer, index, replacement))}
				<div className="flex items-center justify-between">
					<div className="text-xs font-medium text-muted-foreground">Conditions ({conditions.length}; all must match)</div>
					<Button
						size="sm"
						variant="secondary"
						disabled={!Object.keys(controller.parameters).length}
						onClick={() => this._addLayerCondition(scene, controller, layer, index)}
					>
						Add Condition
					</Button>
				</div>
				{conditions.map((condition, conditionIndex) => this._renderLayerCondition(scene, controller, layer, index, condition, conditionIndex))}
				{!conditions.length && <div className="text-xs text-muted-foreground">Unconditional transition.</div>}
			</div>
		);
	}

	private _renderLayerCondition(
		scene: Scene,
		controller: IAnimatorController,
		layer: IAnimatorLayer,
		transitionIndex: number,
		condition: IAnimatorTransitionCondition,
		conditionIndex: number
	): ReactNode {
		const operator =
			condition.equals !== undefined ? "equals" : condition.notEquals !== undefined ? "notEquals" : condition.greaterThan !== undefined ? "greaterThan" : "lessThan";
		const value = condition.equals ?? condition.notEquals ?? condition.greaterThan ?? condition.lessThan ?? "";
		return (
			<div key={`${condition.parameter}-${conditionIndex}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-2 items-center">
				<select
					className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					value={condition.parameter}
					onChange={(event) =>
						this._replaceLayerCondition(
							scene,
							controller,
							layer,
							transitionIndex,
							conditionIndex,
							this._newCondition(event.target.value, operator, controller.parameters[event.target.value])
						)
					}
				>
					{Object.keys(controller.parameters).map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
				<select
					className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					value={operator}
					onChange={(event) =>
						this._replaceLayerCondition(
							scene,
							controller,
							layer,
							transitionIndex,
							conditionIndex,
							this._newCondition(condition.parameter, event.target.value, controller.parameters[condition.parameter])
						)
					}
				>
					<option value="equals">Equals</option>
					<option value="notEquals">Not Equals</option>
					<option value="greaterThan" disabled={typeof controller.parameters[condition.parameter] !== "number"}>
						Greater Than
					</option>
					<option value="lessThan" disabled={typeof controller.parameters[condition.parameter] !== "number"}>
						Less Than
					</option>
				</select>
				<Input
					className="h-8 text-xs"
					value={String(value)}
					onChange={(event) =>
						this._replaceLayerCondition(
							scene,
							controller,
							layer,
							transitionIndex,
							conditionIndex,
							this._newCondition(condition.parameter, operator, this._parseConditionValue(controller.parameters[condition.parameter], event.target.value, operator))
						)
					}
					aria-label={`${layer.name} ${condition.parameter} condition value`}
				/>
				<Button size="sm" variant="ghost" onClick={() => this._removeLayerCondition(scene, controller, layer, transitionIndex, conditionIndex)}>
					Remove
				</Button>
			</div>
		);
	}

	private _renderStateMask(scene: Scene, controller: IAnimatorController, state: IAnimatorState): ReactNode {
		const targetNames = this._getStateTargetNames(scene, state);
		const mask = state.maskTargetNames ?? [];
		const avatarMasks = this._getAvatarMasks(scene);
		return (
			<div className="space-y-1">
				<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs">
					<span className="text-muted-foreground">Avatar Mask</span>
					<select
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
						value={state.avatarMaskId ?? ""}
						onChange={(event) => this._setStateAvatarMask(scene, controller, state, event.target.value || null)}
					>
						<option value="">None / Generic targets only</option>
						{avatarMasks.map((candidate: any) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
					</select>
				</div>
				{!targetNames.length && <div className="text-xs text-muted-foreground">This state has no named animation targets for a generic mask.</div>}
				<div className="flex items-center justify-between gap-2">
					<div className="text-xs font-medium text-muted-foreground">Animation Mask (include targets)</div>
					<select
						className="h-7 max-w-44 rounded-md border border-input bg-background px-2 text-xs"
						value=""
						onChange={(event) => {
							if (event.target.value) {
								this._setStateMask(scene, controller, state, [...mask, event.target.value]);
							}
						}}
					>
						<option value="">Add target…</option>
						{targetNames
							.filter((name) => !mask.includes(name))
							.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
					</select>
				</div>
				{mask.length ? (
					<div className="flex flex-wrap gap-1">
						{mask.map((name) => (
							<Button
								key={name}
								size="sm"
								variant="secondary"
								className="h-6 px-2 text-xs"
								onClick={() =>
									this._setStateMask(
										scene,
										controller,
										state,
										mask.filter((candidate) => candidate !== name)
									)
								}
							>
								{name} ×
							</Button>
						))}
					</div>
				) : (
					<div className="text-xs text-muted-foreground">No mask: all animation targets play.</div>
				)}
			</div>
		);
	}

	private _renderTransition(scene: Scene, controller: IAnimatorController, transition: IAnimatorTransition, index: number): ReactNode {
		const conditions = transition.conditions ?? [];
		return (
			<div key={`${transition.from}-${transition.to}-${index}`} className="space-y-2 rounded border border-input p-2">
				<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-center">
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={transition.from}
						onChange={(event) => this._replaceTransition(scene, controller, index, { ...transition, from: event.target.value })}
					>
						<option value={ANIMATOR_ANY_STATE}>Any State</option>
						{this._machineNodes(controller).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
					</select>
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={transition.to}
						onChange={(event) =>
							this._replaceTransition(scene, controller, index, {
								...transition,
								to: event.target.value,
								...(event.target.value === ANIMATOR_EXIT_STATE ? { offset: undefined } : {}),
							})
						}
					>
						{this._machineNodes(controller).map((node) => (
							<option key={node} value={node}>
								{node}
							</option>
						))}
						<option value={ANIMATOR_EXIT_STATE}>Exit</option>
					</select>
					<Button size="sm" variant="ghost" onClick={() => this._removeTransition(scene, controller, index)}>
						Remove
					</Button>
				</div>
				<label className="text-xs text-muted-foreground">
					Exit Time (0–1)
					<Input
						type="number"
						min={0}
						max={1}
						step={0.01}
						value={transition.exitTime ?? ""}
						onChange={(event) => {
							const value = event.target.value;
							this._replaceTransition(scene, controller, index, { ...transition, ...(value === "" ? { exitTime: undefined } : { exitTime: Number(value) }) });
						}}
						aria-label={`${transition.from} to ${transition.to} exit time`}
					/>
				</label>
				<label className="text-xs text-muted-foreground">
					Blend Duration
					<Input
						type="number"
						min={0}
						step={0.01}
						value={transition.duration ?? ""}
						onChange={(event) => {
							const value = event.target.value;
							this._replaceTransition(scene, controller, index, { ...transition, ...(value === "" ? { duration: undefined } : { duration: Number(value) }) });
						}}
						aria-label={`${transition.from} to ${transition.to} blend seconds`}
					/>
					<select
						className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
						value={transition.durationMode ?? "seconds"}
						onChange={(event) => this._replaceTransition(scene, controller, index, { ...transition, durationMode: event.target.value as "seconds" | "normalized" })}
					>
						<option value="seconds">Seconds</option>
						<option value="normalized">Normalized Source Time</option>
					</select>
				</label>
				{this._renderTransitionInterruptionControls(transition, (replacement) => this._replaceTransition(scene, controller, index, replacement))}
				<div className="flex items-center justify-between">
					<div className="text-xs font-medium text-muted-foreground">Conditions ({conditions.length}; all must match)</div>
					<Button size="sm" variant="secondary" disabled={!Object.keys(controller.parameters).length} onClick={() => this._addCondition(scene, controller, index)}>
						Add Condition
					</Button>
				</div>
				{conditions.map((condition, conditionIndex) => this._renderCondition(scene, controller, index, condition, conditionIndex))}
				{!conditions.length && <div className="text-xs text-muted-foreground">Unconditional transition.</div>}
			</div>
		);
	}

	private _renderTransitionInterruptionControls(transition: IAnimatorTransition, replace: (replacement: IAnimatorTransition) => void): ReactNode {
		const interruptionSource = transition.interruptionSource ?? "none";
		return (
			<div className="grid gap-2 md:grid-cols-2">
				<label className="text-xs text-muted-foreground">
					Destination Offset (0–1)
					<Input
						type="number"
						min={0}
						max={1}
						step={0.01}
						disabled={transition.to === ANIMATOR_EXIT_STATE}
						value={transition.offset ?? ""}
						onChange={(event) => {
							const value = event.target.value;
							replace({ ...transition, ...(value === "" ? { offset: undefined } : { offset: Number(value) }) });
						}}
						aria-label={`${transition.from} to ${transition.to} destination offset`}
					/>
				</label>
				<label className="text-xs text-muted-foreground">
					Interruption Source
					<select
						className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
						value={interruptionSource}
						onChange={(event) =>
							replace({
								...transition,
								interruptionSource: event.target.value as IAnimatorTransition["interruptionSource"],
							})
						}
						aria-label={`${transition.from} to ${transition.to} interruption source`}
					>
						<option value="none">None</option>
						<option value="source">Source</option>
						<option value="destination">Destination</option>
						<option value="sourceThenDestination">Source, then Destination</option>
						<option value="destinationThenSource">Destination, then Source</option>
					</select>
				</label>
				<label className="flex items-center gap-2 rounded border border-input px-2 py-2 text-xs">
					<input
						type="checkbox"
						checked={transition.orderedInterruption === true}
						disabled={interruptionSource === "none"}
						onChange={(event) => replace({ ...transition, orderedInterruption: event.target.checked })}
					/>
					Ordered Interruption
				</label>
				<label className="flex items-center gap-2 rounded border border-input px-2 py-2 text-xs">
					<input
						type="checkbox"
						checked={transition.canTransitionToSelf === true}
						onChange={(event) => replace({ ...transition, canTransitionToSelf: event.target.checked })}
					/>
					Can Transition To Self
				</label>
			</div>
		);
	}

	private _renderCondition(scene: Scene, controller: IAnimatorController, transitionIndex: number, condition: IAnimatorTransitionCondition, conditionIndex: number): ReactNode {
		const operator =
			condition.equals !== undefined ? "equals" : condition.notEquals !== undefined ? "notEquals" : condition.greaterThan !== undefined ? "greaterThan" : "lessThan";
		const value = condition.equals ?? condition.notEquals ?? condition.greaterThan ?? condition.lessThan ?? "";
		return (
			<div key={`${condition.parameter}-${conditionIndex}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-2 items-center">
				<select
					className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					value={condition.parameter}
					onChange={(event) =>
						this._replaceCondition(
							scene,
							controller,
							transitionIndex,
							conditionIndex,
							this._newCondition(event.target.value, operator, controller.parameters[event.target.value])
						)
					}
				>
					{Object.keys(controller.parameters).map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
				<select
					className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					value={operator}
					onChange={(event) =>
						this._replaceCondition(
							scene,
							controller,
							transitionIndex,
							conditionIndex,
							this._newCondition(condition.parameter, event.target.value, controller.parameters[condition.parameter])
						)
					}
				>
					<option value="equals">Equals</option>
					<option value="notEquals">Not Equals</option>
					<option value="greaterThan" disabled={typeof controller.parameters[condition.parameter] !== "number"}>
						Greater Than
					</option>
					<option value="lessThan" disabled={typeof controller.parameters[condition.parameter] !== "number"}>
						Less Than
					</option>
				</select>
				<Input
					className="h-8 text-xs"
					value={String(value)}
					onChange={(event) =>
						this._replaceCondition(
							scene,
							controller,
							transitionIndex,
							conditionIndex,
							this._newCondition(condition.parameter, operator, this._parseConditionValue(controller.parameters[condition.parameter], event.target.value, operator))
						)
					}
					aria-label={`${condition.parameter} condition value`}
				/>
				<Button size="sm" variant="ghost" onClick={() => this._removeCondition(scene, controller, transitionIndex, conditionIndex)}>
					Remove
				</Button>
			</div>
		);
	}

	private _getControllers(scene: Scene): IAnimatorController[] {
		return listAnimatorControllers(scene).controllers as IAnimatorController[];
	}

	private _createController(scene: Scene): void {
		const group = scene.animationGroups[0];
		const number = this._getControllers(scene).length + 1;
		const controller = createAnimatorController(
			scene,
			{ name: `Animator Controller ${number}`, states: [{ name: "State 1", animationGroup: group.name }], transitions: [], entryState: "State 1" },
			{ editor: this.props.editor }
		) as IAnimatorController;
		this.setState({ selectedControllerId: controller.id });
	}

	private _update(scene: Scene, controller: IAnimatorController, update: Partial<IAnimatorController>): void {
		setAnimatorController(scene, { controllerId: controller.id, ...update }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setSubgraph(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph, update: Partial<IAnimatorSubgraph>): void {
		setAnimatorSubgraph(scene, { controllerId: controller.id, subgraphId: subgraph.id, ...update }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _addSubgraph(scene: Scene, controller: IAnimatorController): void {
		const number = (controller.subgraphs?.length ?? 0) + 1;
		setAnimatorSubgraph(
			scene,
			{
				controllerId: controller.id,
				name: `Reusable Subgraph ${number}`,
				states: [{ name: "State 1", animationGroup: scene.animationGroups[0].name }],
				transitions: [],
				entryState: "State 1",
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _deleteSubgraph(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph): void {
		deleteAnimatorSubgraph(scene, { controllerId: controller.id, subgraphId: subgraph.id, cascade: true }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _addSubgraphState(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph): void {
		const number = subgraph.states.length + 1;
		this._setSubgraph(scene, controller, subgraph, {
			states: [...subgraph.states, { name: `State ${number}`, animationGroup: scene.animationGroups[0].name }],
		});
	}

	private _replaceSubgraphState(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph, name: string, replacement: IAnimatorState): void {
		this._setSubgraph(scene, controller, subgraph, {
			states: subgraph.states.map((state) => (state.name === name ? replacement : state)),
			transitions: subgraph.transitions.map((transition) => ({
				...transition,
				from: transition.from === name ? replacement.name : transition.from,
				to: transition.to === name ? replacement.name : transition.to,
			})),
			entryTransitions: (subgraph.entryTransitions ?? []).map((transition) => ({ ...transition, to: transition.to === name ? replacement.name : transition.to })),
			entryState: subgraph.entryState === name ? replacement.name : subgraph.entryState,
		});
	}

	private _removeSubgraphState(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph, name: string): void {
		const states = subgraph.states.filter((state) => state.name !== name);
		this._setSubgraph(scene, controller, subgraph, {
			states,
			transitions: subgraph.transitions.filter((transition) => transition.from !== name && transition.to !== name),
			entryTransitions: (subgraph.entryTransitions ?? []).filter((transition) => transition.to !== name),
			entryState: subgraph.entryState === name ? states[0].name : subgraph.entryState,
		});
	}

	private _addSubgraphTransition(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph): void {
		const nodes = this._machineNodes(subgraph);
		this._setSubgraph(scene, controller, subgraph, {
			transitions: [...subgraph.transitions, { from: nodes[0], to: nodes[1] ?? ANIMATOR_EXIT_STATE }],
		});
	}

	private _replaceSubgraphTransition(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph, index: number, replacement: IAnimatorTransition): void {
		this._setSubgraph(scene, controller, subgraph, {
			transitions: subgraph.transitions.map((transition, transitionIndex) => (transitionIndex === index ? replacement : transition)),
		});
	}

	private _removeSubgraphTransition(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph, index: number): void {
		this._setSubgraph(scene, controller, subgraph, {
			transitions: subgraph.transitions.filter((_, transitionIndex) => transitionIndex !== index),
		});
	}

	private _addSubgraphCondition(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph, transitionIndex: number): void {
		const parameter = Object.keys(controller.parameters)[0];
		const transition = subgraph.transitions[transitionIndex];
		this._replaceSubgraphTransition(scene, controller, subgraph, transitionIndex, {
			...transition,
			conditions: [...(transition.conditions ?? []), this._newCondition(parameter, "equals", controller.parameters[parameter])],
		});
	}

	private _replaceSubgraphCondition(
		scene: Scene,
		controller: IAnimatorController,
		subgraph: IAnimatorSubgraph,
		transitionIndex: number,
		conditionIndex: number,
		replacement: IAnimatorTransitionCondition
	): void {
		const transition = subgraph.transitions[transitionIndex];
		this._replaceSubgraphTransition(scene, controller, subgraph, transitionIndex, {
			...transition,
			conditions: (transition.conditions ?? []).map((condition, currentIndex) => (currentIndex === conditionIndex ? replacement : condition)),
		});
	}

	private _removeSubgraphCondition(scene: Scene, controller: IAnimatorController, subgraph: IAnimatorSubgraph, transitionIndex: number, conditionIndex: number): void {
		const transition = subgraph.transitions[transitionIndex];
		this._replaceSubgraphTransition(scene, controller, subgraph, transitionIndex, {
			...transition,
			conditions: (transition.conditions ?? []).filter((_, currentIndex) => currentIndex !== conditionIndex),
		});
	}

	private _setSubStateMachine(
		scene: Scene,
		controller: IAnimatorController,
		instance: IAnimatorSubStateMachine,
		update: Partial<IAnimatorSubStateMachine>,
		layer?: string,
		parentSubgraphId?: string
	): void {
		setAnimatorSubStateMachine(
			scene,
			{
				controllerId: controller.id,
				...(layer ? { layer } : {}),
				...(parentSubgraphId ? { parentSubgraphId } : {}),
				existingName: instance.name,
				name: update.name ?? instance.name,
				subgraphId: update.subgraphId ?? instance.subgraphId,
				graphPosition: update.graphPosition ?? instance.graphPosition,
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _addSubStateMachine(scene: Scene, controller: IAnimatorController, instances: IAnimatorSubStateMachine[], layer?: string, parentSubgraphId?: string): void {
		const subgraph = controller.subgraphs?.find((candidate) => candidate.id !== parentSubgraphId);
		if (!subgraph) {
			return;
		}
		let number = instances.length + 1;
		let name = `Sub-State Machine ${number}`;
		const names = new Set(instances.map((instance) => instance.name));
		while (names.has(name)) {
			number++;
			name = `Sub-State Machine ${number}`;
		}
		setAnimatorSubStateMachine(
			scene,
			{
				controllerId: controller.id,
				...(layer ? { layer } : {}),
				...(parentSubgraphId ? { parentSubgraphId } : {}),
				name,
				subgraphId: subgraph.id,
				graphPosition: [0, 0],
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _removeSubStateMachine(scene: Scene, controller: IAnimatorController, instance: IAnimatorSubStateMachine, layer?: string, parentSubgraphId?: string): void {
		setAnimatorSubStateMachine(
			scene,
			{
				controllerId: controller.id,
				...(layer ? { layer } : {}),
				...(parentSubgraphId ? { parentSubgraphId } : {}),
				existingName: instance.name,
				remove: true,
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _delete(scene: Scene, controller: IAnimatorController): void {
		deleteAnimatorController(scene, { controllerId: controller.id }, { editor: this.props.editor });
		this.setState({ selectedControllerId: null });
	}

	private _addState(scene: Scene, controller: IAnimatorController): void {
		const number = controller.states.length + 1;
		this._update(scene, controller, { states: [...controller.states, { name: `State ${number}`, animationGroup: scene.animationGroups[0].name }] });
	}

	private _addLayer(scene: Scene, controller: IAnimatorController): void {
		const layers = controller.layers ?? [];
		const name = `Layer ${layers.length + 1}`;
		this._update(scene, controller, {
			layers: [
				...layers,
				{
					name,
					weight: 1,
					blendingMode: "override",
					referencePose: { normalizedTime: 0 },
					synchronizedMotionOverrides: {},
					synchronizedBehaviourOverrides: {},
					ikPass: false,
					states: [{ name: "State 1", animationGroup: scene.animationGroups[0].name }],
					transitions: [],
					entryState: "State 1",
					activeState: "State 1",
				},
			],
		});
	}

	private _replaceLayer(scene: Scene, controller: IAnimatorController, name: string, replacement: IAnimatorLayer): void {
		setAnimatorLayer(scene, { controllerId: controller.id, layer: name, ...replacement }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setSynchronizedOverrides(
		scene: Scene,
		controller: IAnimatorController,
		layer: IAnimatorLayer,
		motionOverrides: NonNullable<IAnimatorLayer["synchronizedMotionOverrides"]>,
		behaviourOverrides: NonNullable<IAnimatorLayer["synchronizedBehaviourOverrides"]>
	): void {
		setAnimatorSynchronizedLayerOverrides(scene, { controllerId: controller.id, layer: layer.name, motionOverrides, behaviourOverrides }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setLayerSynchronization(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, sourceLayer: string | null): void {
		if (!sourceLayer) {
			setAnimatorLayer(
				scene,
				{
					controllerId: controller.id,
					layer: layer.name,
					synchronizedLayer: null,
					synchronizedStateMap: {},
					synchronizedMotionOverrides: {},
					synchronizedBehaviourOverrides: {},
					synchronizedTiming: false,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
			return;
		}
		const sourceGraph = getAnimatorCompiledGraph(scene, {
			controllerId: controller.id,
			...(sourceLayer === "$base" ? {} : { layer: sourceLayer }),
		});
		const targetGraph = getAnimatorCompiledGraph(scene, { controllerId: controller.id, layer: layer.name });
		const targetStates = targetGraph.states as { name: string; sourceStateName: string }[];
		const synchronizedStateMap = Object.fromEntries(
			(sourceGraph.states as { name: string; sourceStateName: string }[]).map((sourceState, index) => [
				sourceState.name,
				targetStates.find((candidate) => candidate.name === sourceState.name)?.name ??
					targetStates.find((candidate) => candidate.sourceStateName === sourceState.sourceStateName)?.name ??
					targetStates[index]?.name ??
					targetStates[0].name,
			])
		);
		setAnimatorLayer(
			scene,
			{
				controllerId: controller.id,
				layer: layer.name,
				synchronizedLayer: sourceLayer,
				synchronizedTiming: false,
				synchronizedStateMap,
				synchronizedMotionOverrides: {},
				synchronizedBehaviourOverrides: {},
				transitions: [],
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _addLayerState(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer): void {
		const number = layer.states.length + 1;
		setAnimatorLayer(
			scene,
			{ controllerId: controller.id, layer: layer.name, states: [...layer.states, { name: `State ${number}`, animationGroup: scene.animationGroups[0].name }] },
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _replaceLayerState(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, name: string, replacement: IAnimatorState): void {
		const states = layer.states.map((state) => (state.name === name ? replacement : state));
		const transitions = layer.transitions.map((transition) => ({
			...transition,
			from: transition.from === name ? replacement.name : transition.from,
			to: transition.to === name ? replacement.name : transition.to,
		}));
		setAnimatorLayer(
			scene,
			{
				controllerId: controller.id,
				layer: layer.name,
				states,
				transitions,
				entryTransitions: (layer.entryTransitions ?? []).map((transition) => ({ ...transition, to: transition.to === name ? replacement.name : transition.to })),
				entryState: layer.entryState === name ? replacement.name : layer.entryState,
				activeState: layer.activeState === name ? replacement.name : layer.activeState,
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _removeLayerState(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, name: string): void {
		const states = layer.states.filter((state) => state.name !== name);
		const transitions = layer.transitions.filter((transition) => transition.from !== name && transition.to !== name);
		setAnimatorLayer(
			scene,
			{
				controllerId: controller.id,
				layer: layer.name,
				states,
				transitions,
				entryTransitions: (layer.entryTransitions ?? []).filter((transition) => transition.to !== name),
				entryState: layer.entryState === name ? states[0].name : layer.entryState,
				activeState: layer.activeState === name ? states[0].name : layer.activeState,
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _addLayerTransition(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer): void {
		const nodes = this._machineNodes(layer);
		setAnimatorLayer(
			scene,
			{
				controllerId: controller.id,
				layer: layer.name,
				transitions: [...layer.transitions, { from: nodes[0], to: nodes[1] ?? ANIMATOR_EXIT_STATE }],
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _replaceLayerTransition(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, index: number, replacement: IAnimatorTransition): void {
		setAnimatorLayer(
			scene,
			{
				controllerId: controller.id,
				layer: layer.name,
				transitions: layer.transitions.map((transition, transitionIndex) => (transitionIndex === index ? replacement : transition)),
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _removeLayerTransition(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, index: number): void {
		setAnimatorLayer(
			scene,
			{ controllerId: controller.id, layer: layer.name, transitions: layer.transitions.filter((_, transitionIndex) => transitionIndex !== index) },
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _addLayerCondition(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, transitionIndex: number): void {
		const parameter = Object.keys(controller.parameters)[0];
		const transition = layer.transitions[transitionIndex];
		this._replaceLayerTransition(scene, controller, layer, transitionIndex, {
			...transition,
			conditions: [...(transition.conditions ?? []), this._newCondition(parameter, "equals", controller.parameters[parameter])],
		});
	}

	private _replaceLayerCondition(
		scene: Scene,
		controller: IAnimatorController,
		layer: IAnimatorLayer,
		transitionIndex: number,
		conditionIndex: number,
		replacement: IAnimatorTransitionCondition
	): void {
		const transition = layer.transitions[transitionIndex];
		this._replaceLayerTransition(scene, controller, layer, transitionIndex, {
			...transition,
			conditions: (transition.conditions ?? []).map((condition, currentIndex) => (currentIndex === conditionIndex ? replacement : condition)),
		});
	}

	private _removeLayerCondition(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, transitionIndex: number, conditionIndex: number): void {
		const transition = layer.transitions[transitionIndex];
		this._replaceLayerTransition(scene, controller, layer, transitionIndex, {
			...transition,
			conditions: (transition.conditions ?? []).filter((_, currentIndex) => currentIndex !== conditionIndex),
		});
	}

	private _removeLayer(scene: Scene, controller: IAnimatorController, name: string): void {
		this._update(scene, controller, {
			layers: (controller.layers ?? [])
				.filter((layer) => layer.name !== name)
				.map((layer) =>
					layer.synchronizedLayer === name
						? {
								...layer,
								synchronizedLayer: undefined,
								synchronizedTiming: undefined,
								synchronizedStateMap: undefined,
								synchronizedMotionOverrides: undefined,
								synchronizedBehaviourOverrides: undefined,
							}
						: layer
				),
		});
	}

	private _playLayer(scene: Scene, controller: IAnimatorController, layer: string, state: string): void {
		setAnimatorLayerState(scene, { controllerId: controller.id, layer, state }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _addBlendTree(scene: Scene, controller: IAnimatorController): void {
		const parameter = Object.entries(controller.parameters).find(([, value]) => typeof value === "number")?.[0] ?? "blend";
		const parameters = typeof controller.parameters[parameter] === "number" ? controller.parameters : { ...controller.parameters, [parameter]: 0 };
		const number = controller.states.length + 1;
		this._update(scene, controller, {
			parameters,
			states: [
				...controller.states,
				{
					name: `Blend Tree ${number}`,
					blendTree: {
						parameter,
						children: [
							{ animationGroup: scene.animationGroups[0].name, threshold: 0 },
							{ animationGroup: scene.animationGroups[1].name, threshold: 1 },
						],
					},
				},
			],
		});
	}

	private _replaceState(scene: Scene, controller: IAnimatorController, name: string, replacement: IAnimatorState): void {
		const states = controller.states.map((state) => (state.name === name ? replacement : state));
		const transitions = controller.transitions.map((transition) => ({
			...transition,
			from: transition.from === name ? replacement.name : transition.from,
			to: transition.to === name ? replacement.name : transition.to,
		}));
		this._update(scene, controller, {
			states,
			transitions,
			entryTransitions: (controller.entryTransitions ?? []).map((transition) => ({ ...transition, to: transition.to === name ? replacement.name : transition.to })),
			entryState: controller.entryState === name ? replacement.name : controller.entryState,
			activeState: controller.activeState === name ? replacement.name : controller.activeState,
		});
	}

	private _replaceBlendTreeChild(scene: Scene, controller: IAnimatorController, state: IAnimatorState, index: number, replacement: IAnimatorBlendTreeChild): void {
		const children = state.blendTree!.children.map((child, childIndex) => (childIndex === index ? replacement : child));
		setAnimatorBlendTree(scene, { controllerId: controller.id, state: state.name, children }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _toggleNestedBlendTreeChild(scene: Scene, controller: IAnimatorController, state: IAnimatorState, index: number): void {
		const child = state.blendTree!.children[index];
		const location =
			state.blendTree!.blendMode === "direct"
				? { directParameter: child.directParameter }
				: state.blendTree!.parameterX
					? { position: child.position }
					: { threshold: child.threshold };
		const modifiers = { timeScale: child.timeScale, cycleOffset: child.cycleOffset, mirror: child.mirror };
		if (child.blendTree) {
			this._replaceBlendTreeChild(scene, controller, state, index, {
				...location,
				...modifiers,
				animationGroup: getAnimatorBlendTreeAnimationGroups(child.blendTree)[0] ?? scene.animationGroups[0].name,
			});
			return;
		}
		const alternate = scene.animationGroups.find((group) => group.name !== child.animationGroup)?.name;
		if (!child.animationGroup || !alternate) {
			return;
		}
		const parameter = Object.entries(controller.parameters).find(([, value]) => typeof value === "number")?.[0] ?? "blend";
		this._replaceBlendTreeChild(scene, controller, state, index, {
			...location,
			...modifiers,
			blendTree: {
				parameter,
				children: [
					{ animationGroup: child.animationGroup, threshold: 0 },
					{ animationGroup: alternate, threshold: 1 },
				],
			},
		});
	}

	private _setBlendTreeMode(scene: Scene, controller: IAnimatorController, state: IAnimatorState, mode: "1d" | "2d" | "direct"): void {
		const numeric = Object.entries(controller.parameters)
			.filter(([, value]) => typeof value === "number")
			.map(([name]) => name);
		const parameterX = numeric[0] ?? "blendX";
		const parameterY = numeric[1] ?? "blendY";
		const directParameters = state.blendTree!.children.map((child, index) => child.directParameter ?? numeric[index] ?? `${state.name} Weight ${index + 1}`);
		const parameters = {
			...controller.parameters,
			...(mode !== "direct" && typeof controller.parameters[parameterX] !== "number" ? { [parameterX]: 0 } : {}),
			...(mode === "2d" && typeof controller.parameters[parameterY] !== "number" ? { [parameterY]: 0 } : {}),
			...Object.fromEntries(mode === "direct" ? directParameters.filter((name) => typeof controller.parameters[name] !== "number").map((name) => [name, 0]) : []),
		};
		const children = state.blendTree!.children.map((child, index) =>
			mode === "direct"
				? {
						...(child.animationGroup ? { animationGroup: child.animationGroup } : { blendTree: child.blendTree }),
						directParameter: directParameters[index],
						timeScale: child.timeScale,
						cycleOffset: child.cycleOffset,
						mirror: child.mirror,
					}
				: mode === "2d"
					? {
							...(child.animationGroup ? { animationGroup: child.animationGroup } : { blendTree: child.blendTree }),
							position: child.position ?? [index, 0],
							timeScale: child.timeScale,
							cycleOffset: child.cycleOffset,
							mirror: child.mirror,
						}
					: {
							...(child.animationGroup ? { animationGroup: child.animationGroup } : { blendTree: child.blendTree }),
							threshold: child.threshold ?? index,
							timeScale: child.timeScale,
							cycleOffset: child.cycleOffset,
							mirror: child.mirror,
						}
		);
		this._update(scene, controller, {
			parameters,
			states: controller.states.map((candidate) =>
				candidate.name === state.name
					? {
							...candidate,
							blendTree:
								mode === "direct"
									? { blendMode: "direct", normalizeWeights: false, children }
									: mode === "2d"
										? { parameterX, parameterY, blendMode: "cartesian", children }
										: { parameter: parameterX, children },
						}
					: candidate
			),
		});
	}

	private _getStateTargetNames(scene: Scene, state: IAnimatorState): string[] {
		const groups = state.blendTree ? getAnimatorBlendTreeAnimationGroups(state.blendTree) : state.animationGroup ? [state.animationGroup] : [];
		return [
			...new Set(
				groups.flatMap(
					(groupName) =>
						scene
							.getAnimationGroupByName(groupName)
							?.targetedAnimations.map((targeted) => targeted.target?.name)
							.filter(Boolean) ?? []
				)
			),
		];
	}

	private _setStateMask(scene: Scene, controller: IAnimatorController, state: IAnimatorState, targetNames: string[]): void {
		setAnimatorStateMask(scene, { controllerId: controller.id, state: state.name, targetNames }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _getAvatarMasks(scene: Scene): any[] {
		return Array.isArray(scene.metadata?.babylonEditorHumanoidAvatarMasks) ? scene.metadata.babylonEditorHumanoidAvatarMasks : [];
	}

	private _setStateAvatarMask(scene: Scene, controller: IAnimatorController, state: IAnimatorState, avatarMaskId: string | null): void {
		setAnimatorStateAvatarMask(scene, { controllerId: controller.id, state: state.name, avatarMaskId }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setGraphPosition(scene: Scene, controller: IAnimatorController, state: IAnimatorState, axis: 0 | 1, value: string): void {
		const coordinate = Number(value);
		if (!Number.isFinite(coordinate)) {
			return;
		}
		const position: [number, number] = [...(state.graphPosition ?? [0, 0])] as [number, number];
		position[axis] = coordinate;
		setAnimatorStateGraphPosition(scene, { controllerId: controller.id, state: state.name, position }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setLayerMask(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, maskTargetNames: string[]): void {
		setAnimatorLayer(scene, { controllerId: controller.id, layer: layer.name, maskTargetNames }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setLayerAvatarMask(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, avatarMaskId: string | null): void {
		setAnimatorLayer(scene, { controllerId: controller.id, layer: layer.name, avatarMaskId }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _addBlendTreeChild(scene: Scene, controller: IAnimatorController, state: IAnimatorState): void {
		const tree = state.blendTree!;
		const usedGroups = new Set(getAnimatorBlendTreeAnimationGroups(tree));
		const group = scene.animationGroups.find((candidate) => !usedGroups.has(candidate.name)) ?? scene.animationGroups[0];
		if (!group) {
			return;
		}
		const is2D = !!tree.parameterX;
		const isDirect = tree.blendMode === "direct";
		const threshold = Math.max(...tree.children.map((child) => child.threshold ?? 0)) + 1;
		const position: [number, number] = [tree.children.length, 0];
		const directParameter = Object.entries(controller.parameters).find(([, value]) => typeof value === "number")?.[0] ?? "blend";
		setAnimatorBlendTree(
			scene,
			{
				controllerId: controller.id,
				state: state.name,
				children: [
					...tree.children,
					isDirect ? { animationGroup: group.name, directParameter } : is2D ? { animationGroup: group.name, position } : { animationGroup: group.name, threshold },
				],
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _removeBlendTreeChild(scene: Scene, controller: IAnimatorController, state: IAnimatorState, index: number): void {
		const children = state.blendTree!.children.filter((_, childIndex) => childIndex !== index);
		setAnimatorBlendTree(scene, { controllerId: controller.id, state: state.name, children }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _removeState(scene: Scene, controller: IAnimatorController, name: string): void {
		const states = controller.states.filter((state) => state.name !== name);
		const transitions = controller.transitions.filter((transition) => transition.from !== name && transition.to !== name);
		this._update(scene, controller, {
			states,
			transitions,
			entryTransitions: (controller.entryTransitions ?? []).filter((transition) => transition.to !== name),
			entryState: controller.entryState === name ? states[0].name : controller.entryState,
			activeState: controller.activeState === name ? states[0].name : controller.activeState,
		});
	}

	private _play(scene: Scene, controller: IAnimatorController, name: string): void {
		setAnimatorState(scene, { controllerId: controller.id, state: name }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setEntryState(scene: Scene, controller: IAnimatorController, state: string, play = false, layer?: string): void {
		setAnimatorEntryState(scene, { controllerId: controller.id, state, play, ...(layer ? { layer } : {}) }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setEntryTransitions(
		scene: Scene,
		controller: IAnimatorController,
		entryTransitions: IAnimatorEntryTransition[],
		owner: { layer?: string; subgraphId?: string }
	): void {
		setAnimatorEntryTransitions(
			scene,
			{ controllerId: controller.id, entryTransitions, ...(owner.layer ? { layer: owner.layer } : {}), ...(owner.subgraphId ? { subgraphId: owner.subgraphId } : {}) },
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _addTransition(scene: Scene, controller: IAnimatorController): void {
		const nodes = this._machineNodes(controller);
		this._update(scene, controller, {
			transitions: [...controller.transitions, { from: nodes[0], to: nodes[1] ?? ANIMATOR_EXIT_STATE }],
		});
	}

	private _replaceTransition(scene: Scene, controller: IAnimatorController, index: number, replacement: IAnimatorTransition): void {
		this._update(scene, controller, { transitions: controller.transitions.map((transition, currentIndex) => (currentIndex === index ? replacement : transition)) });
	}

	private _removeTransition(scene: Scene, controller: IAnimatorController, index: number): void {
		this._update(scene, controller, { transitions: controller.transitions.filter((_, currentIndex) => currentIndex !== index) });
	}

	private _addCondition(scene: Scene, controller: IAnimatorController, transitionIndex: number): void {
		const parameter = Object.keys(controller.parameters)[0];
		const transition = controller.transitions[transitionIndex];
		this._replaceTransition(scene, controller, transitionIndex, {
			...transition,
			conditions: [...(transition.conditions ?? []), this._newCondition(parameter, "equals", controller.parameters[parameter])],
		});
	}

	private _replaceCondition(scene: Scene, controller: IAnimatorController, transitionIndex: number, conditionIndex: number, replacement: IAnimatorTransitionCondition): void {
		const transition = controller.transitions[transitionIndex];
		this._replaceTransition(scene, controller, transitionIndex, {
			...transition,
			conditions: (transition.conditions ?? []).map((condition, currentIndex) => (currentIndex === conditionIndex ? replacement : condition)),
		});
	}

	private _removeCondition(scene: Scene, controller: IAnimatorController, transitionIndex: number, conditionIndex: number): void {
		const transition = controller.transitions[transitionIndex];
		this._replaceTransition(scene, controller, transitionIndex, {
			...transition,
			conditions: (transition.conditions ?? []).filter((_, currentIndex) => currentIndex !== conditionIndex),
		});
	}

	private _newCondition(parameter: string, operator: string, value: string | number | boolean): IAnimatorTransitionCondition {
		if (operator === "notEquals") {
			return { parameter, notEquals: value };
		}
		if (operator === "greaterThan") {
			return { parameter, greaterThan: typeof value === "number" ? value : 0 };
		}
		if (operator === "lessThan") {
			return { parameter, lessThan: typeof value === "number" ? value : 0 };
		}
		return { parameter, equals: value };
	}

	private _newEntryCondition(controller: IAnimatorController, parameter: string, operator = "equals"): IAnimatorTransitionCondition {
		const trigger = controller.parameterTypes?.[parameter] === "trigger";
		return this._newCondition(parameter, trigger ? "equals" : operator, trigger ? true : controller.parameters[parameter]);
	}

	private _parseConditionValue(previous: string | number | boolean, value: string, operator: string): string | number | boolean {
		if (operator !== "equals" && operator !== "notEquals") {
			return Number(value) || 0;
		}
		if (typeof previous === "boolean") {
			return value.toLowerCase() === "true";
		}
		if (typeof previous === "number") {
			return Number(value) || 0;
		}
		return value;
	}

	private _addParameter(scene: Scene, controller: IAnimatorController): void {
		const name = this.state.newParameterName.trim();
		if (!name || controller.parameters[name] !== undefined) {
			return;
		}
		setAnimatorParameterDefinition(scene, { controllerId: controller.id, parameter: name, type: this.state.newParameterType }, { editor: this.props.editor });
		this.setState({ newParameterName: "" });
		this.forceUpdate();
	}

	private _setParameter(scene: Scene, controller: IAnimatorController, name: string, value: string): void {
		const type =
			controller.parameterTypes?.[name] ?? (typeof controller.parameters[name] === "boolean" ? "bool" : typeof controller.parameters[name] === "number" ? "float" : "string");
		const parsed = type === "bool" ? value.toLowerCase() === "true" : type === "float" || type === "int" ? Number(value) : value;
		if (typeof parsed === "number" && !Number.isFinite(parsed)) {
			return;
		}
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: name, value: parsed }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setParameterDefinition(scene: Scene, controller: IAnimatorController, parameter: string, type: "float" | "int" | "bool" | "trigger" | "string"): void {
		setAnimatorParameterDefinition(scene, { controllerId: controller.id, parameter, type }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _fireTrigger(scene: Scene, controller: IAnimatorController, parameter: string): void {
		setAnimatorTrigger(scene, { controllerId: controller.id, parameter }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _resetTrigger(scene: Scene, controller: IAnimatorController, parameter: string): void {
		resetAnimatorTrigger(scene, { controllerId: controller.id, parameter }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _removeParameter(scene: Scene, controller: IAnimatorController, name: string): void {
		const parameters = { ...controller.parameters };
		delete parameters[name];
		const parameterTypes = { ...(controller.parameterTypes ?? {}) };
		delete parameterTypes[name];
		const transitions = controller.transitions.map((transition) => ({
			...transition,
			conditions: transition.conditions?.filter((condition) => condition.parameter !== name),
		}));
		const layers = (controller.layers ?? []).map((layer) => ({
			...layer,
			entryTransitions: (layer.entryTransitions ?? [])
				.map((transition) => ({ ...transition, conditions: transition.conditions?.filter((condition) => condition.parameter !== name) }))
				.filter((transition) => transition.conditions?.length),
			transitions: layer.transitions.map((transition) => ({
				...transition,
				conditions: transition.conditions?.filter((condition) => condition.parameter !== name),
			})),
		}));
		const entryTransitions = (controller.entryTransitions ?? [])
			.map((transition) => ({ ...transition, conditions: transition.conditions?.filter((condition) => condition.parameter !== name) }))
			.filter((transition) => transition.conditions?.length);
		const subgraphs = (controller.subgraphs ?? []).map((subgraph) => ({
			...subgraph,
			entryTransitions: (subgraph.entryTransitions ?? [])
				.map((transition) => ({ ...transition, conditions: transition.conditions?.filter((condition) => condition.parameter !== name) }))
				.filter((transition) => transition.conditions?.length),
			transitions: subgraph.transitions.map((transition) => ({
				...transition,
				conditions: transition.conditions?.filter((condition) => condition.parameter !== name),
			})),
		}));
		this._update(scene, controller, { parameters, parameterTypes, transitions, entryTransitions, layers, subgraphs });
	}
}
