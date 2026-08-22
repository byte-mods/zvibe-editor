import { Component, MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Observer, Scene } from "babylonjs";
import { toast } from "sonner";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";

import {
	editAnimationWindowKeys,
	getAnimationRuntimeDebug,
	getAnimationWindow,
	listAnimationEvents,
	recordAnimationWindowProperties,
	setAnimationEvents,
	sampleAnimationCurve,
	setAnimationRuntimeDebug,
	setAnimationWindowTangentModes,
	stepAnimationRuntimeDebug,
} from "../../../mcp/animations/animations";
import { IInspectorPropertyChangedEvent, onInspectorPropertyChangedObservable } from "../../../tools/property";

import { Editor } from "../../main";

interface IAnimationWindowSelection {
	trackIndex: number;
	frame: number;
	component?: number;
}

interface IAnimationWindowBoxSelection {
	startX: number;
	startY: number;
	x: number;
	y: number;
	append: boolean;
}

interface IAnimationWindowCurveDrag {
	selection: IAnimationWindowSelection[];
	startClientX: number;
	startClientY: number;
	frameSpan: number;
	valueSpan: number;
	svg: SVGSVGElement;
	frameDelta: number;
	valueDelta: number;
}

export interface IEditorAnimationWindowPanelProps {
	editor: Editor;
	requestedGroupName: string | null;
	onGroupChange: (name: string) => void;
}

export interface IEditorAnimationWindowPanelState {
	groupName: string;
	view: "dopesheet" | "curves";
	activeTrackIndex: number;
	selected: IAnimationWindowSelection[];
	from: number;
	to: number;
	currentFrame: number;
	frameDelta: number;
	valueDelta: number;
	frameScale: number;
	pivotFrame: number;
	revision: number;
	boxSelection: IAnimationWindowBoxSelection | null;
	curveDrag: IAnimationWindowCurveDrag | null;
	recording: boolean;
	lastRecorded: string | null;
	tangent: number;
	inTangent: number;
	outTangent: number;
	inWeight: number;
	outWeight: number;
	runtime: any | null;
	runtimeBreakpointId: string;
	runtimeBreakpointFrame: number;
	eventEditingIndex: number | null;
	eventFrame: number;
	eventAction: "log" | "setEnabled" | "playAnimationGroup" | "stopAnimationGroup" | "scriptMethod";
	eventTargetNodeId: string;
	eventTargetNodeName: string;
	eventAnimationGroupName: string;
	eventEnabled: boolean;
	eventLoop: boolean;
	eventParameter: string;
	eventOnlyOnce: boolean;
	eventMethodName: string;
	eventScriptKey: string;
	eventArgumentsJson: string;
	eventMissingMethodPolicy: "error" | "warning" | "ignore";
}

const rowHeight = 34;
const curveColors = ["#ef4444", "#22c55e", "#3b82f6", "#f59e0b"];

function selectionIdentity(selection: IAnimationWindowSelection): string {
	return `${selection.trackIndex}:${selection.frame}:${selection.component ?? "*"}`;
}

function shortText(value: string, maximum = 34): string {
	return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

export function resolveAnimationWindowGroupName(scene: Scene, requestedGroupName: string | null): string {
	return requestedGroupName && scene.getAnimationGroupByName(requestedGroupName) ? requestedGroupName : (scene.animationGroups[0]?.name ?? "");
}

/**
 * Clip-centric Unity-style Animation Window with a multi-track Dope Sheet and
 * component-aware Curve view. All mutations use the same leased MCP actions.
 */
export class EditorAnimationWindowPanel extends Component<IEditorAnimationWindowPanelProps, IEditorAnimationWindowPanelState> {
	private _inspectorPropertyObserver: Observer<IInspectorPropertyChangedEvent> | null = null;
	private _runtimeTimer: ReturnType<typeof setInterval> | null = null;

	public constructor(props: IEditorAnimationWindowPanelProps) {
		super(props);
		const scene = props.editor.layout.preview.scene;
		const groupName = resolveAnimationWindowGroupName(scene, props.requestedGroupName);
		const window = groupName ? getAnimationWindow(scene, { name: groupName }) : null;
		const runtime = groupName ? getAnimationRuntimeDebug(scene, { name: groupName, trackLimit: 32, historyLimit: 32, eventLimit: 16 }) : null;
		this.state = {
			groupName,
			view: "dopesheet",
			activeTrackIndex: 0,
			selected: [],
			from: window?.from ?? 0,
			to: Math.max(window?.to ?? 60, (window?.from ?? 0) + 1),
			currentFrame: window?.from ?? 0,
			frameDelta: 1,
			valueDelta: 0.1,
			frameScale: 1,
			pivotFrame: window?.from ?? 0,
			revision: 0,
			boxSelection: null,
			curveDrag: null,
			recording: false,
			lastRecorded: null,
			tangent: 0,
			inTangent: 0,
			outTangent: 0,
			inWeight: 1 / 3,
			outWeight: 1 / 3,
			runtime,
			runtimeBreakpointId: "breakpoint-1",
			runtimeBreakpointFrame: window?.from ?? 0,
			eventEditingIndex: null,
			eventFrame: window?.from ?? 0,
			eventAction: "scriptMethod",
			eventTargetNodeId: "",
			eventTargetNodeName: "",
			eventAnimationGroupName: "",
			eventEnabled: true,
			eventLoop: true,
			eventParameter: "",
			eventOnlyOnce: false,
			eventMethodName: "",
			eventScriptKey: "",
			eventArgumentsJson: "[]",
			eventMissingMethodPolicy: "error",
		};
	}

	public componentDidMount(): void {
		const resolvedGroupName = resolveAnimationWindowGroupName(this.props.editor.layout.preview.scene, this.props.requestedGroupName);
		if (this.props.requestedGroupName && resolvedGroupName !== this.props.requestedGroupName) {
			this.props.onGroupChange(resolvedGroupName);
		}
		this._inspectorPropertyObserver = onInspectorPropertyChangedObservable.add((event) => this._recordInspectorProperty(event));
		this._runtimeTimer = setInterval(() => this._refreshRuntime(), 250);
	}

	public componentDidUpdate(previousProps: IEditorAnimationWindowPanelProps): void {
		if (this.props.requestedGroupName && this.props.requestedGroupName !== previousProps.requestedGroupName && this.props.requestedGroupName !== this.state.groupName) {
			this._selectGroup(this.props.requestedGroupName);
		}
	}

	public componentWillUnmount(): void {
		onInspectorPropertyChangedObservable.remove(this._inspectorPropertyObserver);
		this._inspectorPropertyObserver = null;
		if (this._runtimeTimer) {
			clearInterval(this._runtimeTimer);
			this._runtimeTimer = null;
		}
		window.removeEventListener("mousemove", this._moveCurveDrag);
		window.removeEventListener("mouseup", this._endCurveDrag);
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const groups = scene.animationGroups;
		const groupName = groups.some((group) => group.name === this.state.groupName) ? this.state.groupName : (groups[0]?.name ?? "");
		if (!groupName) {
			return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Create or import an AnimationGroup to use the Animation Window.</div>;
		}
		const model = getAnimationWindow(scene, { name: groupName });
		const activeTrack = model.tracks.find((track: any) => track.index === this.state.activeTrackIndex) ?? model.tracks[0];
		const from = Math.min(this.state.from, this.state.to - 0.001);
		const to = Math.max(this.state.to, from + 0.001);
		const selectedGroup = scene.getAnimationGroupByName(groupName);
		const unityMetadata = selectedGroup?.metadata?.babylonEditorUnityAnimationClip;
		const unityRuntime = selectedGroup?.metadata?.babylonEditorUnityAnimationRuntimeEvidence;
		return (
			<div className="flex h-full min-h-0 flex-col bg-background">
				<div className="flex flex-wrap items-center gap-2 border-b border-input bg-input p-2">
					<select
						className="h-8 min-w-48 rounded border border-border bg-background px-2 text-xs"
						value={groupName}
						onChange={(event) => this._selectGroup(event.target.value)}
					>
						{groups.map((group) => (
							<option key={group.uniqueId} value={group.name}>
								{group.name}
							</option>
						))}
					</select>
					<div className="flex rounded border border-border">
						<Button size="sm" variant={this.state.view === "dopesheet" ? "default" : "ghost"} onClick={() => this.setState({ view: "dopesheet" })}>
							Dope Sheet
						</Button>
						<Button size="sm" variant={this.state.view === "curves" ? "default" : "ghost"} onClick={() => this.setState({ view: "curves" })}>
							Curves
						</Button>
					</div>
					<Button size="sm" variant="outline" onClick={() => this._play(scene, groupName)}>
						Play
					</Button>
					<Button size="sm" variant="outline" onClick={() => scene.getAnimationGroupByName(groupName)?.stop()}>
						Stop
					</Button>
					<Button
						size="sm"
						variant={this.state.recording ? "destructive" : "outline"}
						onClick={() => this.setState({ recording: !this.state.recording, lastRecorded: null })}
						title="Record supported Inspector property changes at the current frame"
					>
						{this.state.recording ? "● Recording" : "● Record"}
					</Button>
					<label className="flex items-center gap-1 text-xs">
						Frame
						<Input
							className="h-8 w-20 text-xs"
							type="number"
							value={String(this.state.currentFrame)}
							onChange={(event) => this._scrub(scene, groupName, Number(event.target.value))}
						/>
					</label>
					<label className="flex items-center gap-1 text-xs">
						From
						<Input className="h-8 w-20 text-xs" type="number" value={String(from)} onChange={(event) => this.setState({ from: Number(event.target.value) })} />
					</label>
					<label className="flex items-center gap-1 text-xs">
						To
						<Input className="h-8 w-20 text-xs" type="number" value={String(to)} onChange={(event) => this.setState({ to: Number(event.target.value) })} />
					</label>
					<Button size="sm" variant="outline" onClick={() => this._fit(model)}>
						Frame All
					</Button>
					<div className={`ml-auto text-xs ${this.state.recording ? "text-red-400" : "text-muted-foreground"}`}>
						{this.state.recording && this.state.lastRecorded ? `${this.state.lastRecorded} · ` : ""}
						{model.trackCount} tracks · {model.keyCount} keys · {this.state.selected.length} selected · {model.durationSeconds.toFixed(2)}s
					</div>
				</div>
				{unityMetadata && (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-input bg-secondary/30 px-3 py-2 text-xs">
						<span className="font-semibold">Unity Clip Runtime</span>
						<span>{unityMetadata.activeStateCurveCount ?? 0} active-state</span>
						<span>{unityMetadata.compressedRotationCurveCount ?? 0} packed rotation</span>
						<span>
							{unityRuntime?.boundObjectReferenceCurveCount ?? 0}/{unityMetadata.objectReferenceCurves?.length ?? 0} object-reference bound
						</span>
						{unityRuntime?.unresolvedObjectReferenceCurveIds?.length > 0 && (
							<span className="text-amber-300">Unresolved: {unityRuntime.unresolvedObjectReferenceCurveIds.join(", ")}</span>
						)}
						{unityRuntime?.lastError && <span className="text-red-400">{unityRuntime.lastError}</span>}
					</div>
				)}
				{this._renderRuntimeDebugger(scene, groupName)}
				{this._renderAnimationEvents(scene, groupName)}

				<div className="flex min-h-0 flex-1 flex-col">
					{this.state.view === "dopesheet" ? this._renderDopeSheet(model, from, to) : this._renderCurves(model, activeTrack, from, to)}
					{this._renderSelectionTools(model)}
				</div>
			</div>
		);
	}

	private _renderAnimationEvents(scene: Scene, groupName: string): ReactNode {
		const snapshot = listAnimationEvents(scene, { name: groupName });
		const events = snapshot.groups[0]?.events ?? [];
		const action = this.state.eventAction;
		return (
			<details className="border-b border-input bg-muted/10">
				<summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
					Animation Events · {events.length} callback{events.length === 1 ? "" : "s"} · revision {snapshot.targetRevision}
				</summary>
				<div className="space-y-3 border-t border-input p-3 text-xs">
					<div className="grid grid-cols-1 gap-2 md:grid-cols-4 xl:grid-cols-8">
						<label className="space-y-1">
							<span className="text-muted-foreground">Frame</span>
							<Input
								className="h-8 text-xs"
								type="number"
								step="any"
								value={String(this.state.eventFrame)}
								onChange={(event) => this.setState({ eventFrame: Number(event.target.value) })}
							/>
						</label>
						<label className="space-y-1 md:col-span-2">
							<span className="text-muted-foreground">Action</span>
							<select
								className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
								value={action}
								onChange={(event) => this.setState({ eventAction: event.target.value as IEditorAnimationWindowPanelState["eventAction"] })}
							>
								<option value="scriptMethod">Script Method</option>
								<option value="log">Log</option>
								<option value="setEnabled">Set Enabled</option>
								<option value="playAnimationGroup">Play Animation Group</option>
								<option value="stopAnimationGroup">Stop Animation Group</option>
							</select>
						</label>
						<label className="space-y-1 md:col-span-2">
							<span className="text-muted-foreground">Parameter / note</span>
							<Input
								className="h-8 text-xs"
								value={this.state.eventParameter}
								onChange={(event) => this.setState({ eventParameter: event.target.value })}
								placeholder="Optional"
							/>
						</label>
						<label className="flex items-end gap-2 pb-2">
							<input type="checkbox" checked={this.state.eventOnlyOnce} onChange={(event) => this.setState({ eventOnlyOnce: event.target.checked })} />
							Only once
						</label>
					</div>
					{action === "scriptMethod" && (
						<div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-5">
							<label className="space-y-1">
								<span className="text-muted-foreground">Method name</span>
								<Input
									className="h-8 text-xs"
									value={this.state.eventMethodName}
									onChange={(event) => this.setState({ eventMethodName: event.target.value })}
									placeholder="onAnimationEvent"
								/>
							</label>
							<label className="space-y-1">
								<span className="text-muted-foreground">Target node id</span>
								<Input
									className="h-8 text-xs"
									value={this.state.eventTargetNodeId}
									onChange={(event) => this.setState({ eventTargetNodeId: event.target.value })}
									placeholder="First animated target (or scene)"
								/>
							</label>
							<label className="space-y-1">
								<span className="text-muted-foreground">Target node name</span>
								<Input
									className="h-8 text-xs"
									value={this.state.eventTargetNodeName}
									onChange={(event) => this.setState({ eventTargetNodeName: event.target.value })}
									placeholder="Optional alternative"
								/>
							</label>
							<label className="space-y-1">
								<span className="text-muted-foreground">Script key filter</span>
								<Input
									className="h-8 text-xs"
									value={this.state.eventScriptKey}
									onChange={(event) => this.setState({ eventScriptKey: event.target.value })}
									placeholder="Optional"
								/>
							</label>
							<label className="space-y-1">
								<span className="text-muted-foreground">Missing method</span>
								<select
									className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
									value={this.state.eventMissingMethodPolicy}
									onChange={(event) =>
										this.setState({ eventMissingMethodPolicy: event.target.value as IEditorAnimationWindowPanelState["eventMissingMethodPolicy"] })
									}
								>
									<option value="error">Error</option>
									<option value="warning">Warning</option>
									<option value="ignore">Ignore</option>
								</select>
							</label>
							<label className="space-y-1 xl:col-span-5">
								<span className="text-muted-foreground">Arguments (JSON array, maximum 16)</span>
								<textarea
									className="min-h-16 w-full rounded border border-border bg-background p-2 font-mono text-xs"
									value={this.state.eventArgumentsJson}
									onChange={(event) => this.setState({ eventArgumentsJson: event.target.value })}
								/>
							</label>
						</div>
					)}
					{action === "setEnabled" && (
						<div className="flex flex-wrap items-end gap-2">
							<label className="min-w-64 flex-1 space-y-1">
								<span className="text-muted-foreground">Target node id</span>
								<Input
									className="h-8 text-xs"
									value={this.state.eventTargetNodeId}
									onChange={(event) => this.setState({ eventTargetNodeId: event.target.value })}
								/>
							</label>
							<label className="min-w-64 flex-1 space-y-1">
								<span className="text-muted-foreground">Target node name</span>
								<Input
									className="h-8 text-xs"
									value={this.state.eventTargetNodeName}
									onChange={(event) => this.setState({ eventTargetNodeName: event.target.value })}
									placeholder="Optional alternative"
								/>
							</label>
							<label className="flex h-8 items-center gap-2">
								<input type="checkbox" checked={this.state.eventEnabled} onChange={(event) => this.setState({ eventEnabled: event.target.checked })} /> Enabled
							</label>
						</div>
					)}
					{(action === "playAnimationGroup" || action === "stopAnimationGroup") && (
						<div className="flex flex-wrap items-end gap-2">
							<label className="min-w-64 flex-1 space-y-1">
								<span className="text-muted-foreground">Animation Group</span>
								<select
									className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
									value={this.state.eventAnimationGroupName}
									onChange={(event) => this.setState({ eventAnimationGroupName: event.target.value })}
								>
									<option value="">Select a group</option>
									{scene.animationGroups.map((group) => (
										<option key={group.uniqueId} value={group.name}>
											{group.name}
										</option>
									))}
								</select>
							</label>
							{action === "playAnimationGroup" && (
								<label className="flex h-8 items-center gap-2">
									<input type="checkbox" checked={this.state.eventLoop} onChange={(event) => this.setState({ eventLoop: event.target.checked })} /> Loop
								</label>
							)}
						</div>
					)}
					<div className="flex flex-wrap gap-2">
						<Button size="sm" onClick={() => this._commitAnimationEvent(scene, groupName)}>
							{this.state.eventEditingIndex === null ? "Add Event" : "Update Event"}
						</Button>
						<Button size="sm" variant="outline" onClick={() => this._resetAnimationEventDraft(this.state.currentFrame)}>
							Clear
						</Button>
						<span className="self-center text-muted-foreground">Callbacks are persisted into the scene and use the same dispatcher in preview and exported games.</span>
					</div>
					<div className="max-h-44 space-y-1 overflow-auto">
						{events.length === 0 && <div className="rounded border border-dashed border-input p-2 text-muted-foreground">No authored Animation Events.</div>}
						{events.map((event: any, index: number) => (
							<div key={`${index}:${event.frame}:${event.action}`} className="flex items-center gap-2 rounded border border-input px-2 py-1">
								<span className="w-20 shrink-0 font-mono">f{event.frame}</span>
								<span className="min-w-0 flex-1 truncate" title={JSON.stringify(event)}>
									{event.action}
									{event.methodName ? ` · ${event.methodName}` : ""}
									{event.missingMethodPolicy ? ` · missing=${event.missingMethodPolicy}` : ""}
								</span>
								<Button size="sm" variant="ghost" onClick={() => this._loadAnimationEvent(event, index)}>
									Edit
								</Button>
								<Button size="sm" variant="ghost" onClick={() => this._removeAnimationEvent(scene, groupName, index)}>
									Remove
								</Button>
							</div>
						))}
					</div>
				</div>
			</details>
		);
	}

	private _renderRuntimeDebugger(scene: Scene, groupName: string): ReactNode {
		const runtime = this.state.runtime?.name === groupName ? this.state.runtime : null;
		if (!runtime) {
			return <div className="border-b border-input px-3 py-2 text-xs text-muted-foreground">Runtime Debugger · waiting for live snapshot…</div>;
		}
		const paused = runtime.status === "paused";
		const started = runtime.isStarted;
		return (
			<details className="border-b border-input bg-muted/10" open>
				<summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
					Runtime Debugger · {runtime.status} · frame {runtime.currentFrame === null ? "—" : Number(runtime.currentFrame).toFixed(3)} · loops {runtime.loopCount} · trace{" "}
					{runtime.historyEvidence.retainedCount}
				</summary>
				<div className="grid max-h-56 grid-cols-1 gap-3 overflow-auto border-t border-input p-3 text-xs lg:grid-cols-3">
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="outline" disabled={!started} onClick={() => this._setRuntimePaused(scene, groupName, !paused)}>
								{paused ? "Resume" : "Pause"}
							</Button>
							<Button size="sm" variant="outline" disabled={!paused} onClick={() => this._stepRuntime(scene, groupName, 1)}>
								Step +1
							</Button>
							<Button size="sm" variant="outline" disabled={!paused} onClick={() => this._stepRuntime(scene, groupName, -1)}>
								Step −1
							</Button>
							<Button size="sm" variant="ghost" onClick={() => this._clearRuntimeHistory(scene, groupName)}>
								Clear Trace
							</Button>
						</div>
						<div className="grid grid-cols-2 gap-1 text-muted-foreground">
							<span>Range</span>
							<span>
								{runtime.from} … {runtime.to}
							</span>
							<span>Normalized</span>
							<span>{runtime.normalizedFrame === null ? "—" : Number(runtime.normalizedFrame).toFixed(4)}</span>
							<span>Speed / weight</span>
							<span>
								{runtime.speedRatio} / {runtime.weight}
							</span>
							<span>Runtime</span>
							<span>{Number(runtime.runtimeSeconds).toFixed(3)}s</span>
							<span>Lease</span>
							<span className="font-mono" title={runtime.fingerprint}>
								{runtime.fingerprint.slice(0, 12)}…
							</span>
						</div>
					</div>
					<div className="space-y-2">
						<div className="font-medium">Frame breakpoints</div>
						<div className="flex gap-1">
							<Input
								className="h-8 min-w-24 text-xs"
								value={this.state.runtimeBreakpointId}
								onChange={(event) => this.setState({ runtimeBreakpointId: event.target.value })}
								placeholder="Breakpoint id"
							/>
							<Input
								className="h-8 w-24 text-xs"
								type="number"
								step="any"
								value={String(this.state.runtimeBreakpointFrame)}
								onChange={(event) => this.setState({ runtimeBreakpointFrame: Number(event.target.value) })}
							/>
							<Button size="sm" variant="outline" onClick={() => this._upsertRuntimeBreakpoint(scene, groupName)}>
								Add
							</Button>
						</div>
						<div className="space-y-1">
							{runtime.breakpoints.length === 0 && <div className="text-muted-foreground">No runtime breakpoints.</div>}
							{runtime.breakpoints.map((breakpoint: any) => (
								<div key={breakpoint.id} className="flex items-center justify-between rounded border border-input px-2 py-1">
									<span>
										{breakpoint.enabled ? "●" : "○"} {breakpoint.id} @ {breakpoint.frame}
									</span>
									<Button size="sm" variant="ghost" onClick={() => this._removeRuntimeBreakpoint(scene, groupName, breakpoint.id)}>
										Remove
									</Button>
								</div>
							))}
						</div>
					</div>
					<div className="space-y-2">
						<div className="font-medium">Live evidence</div>
						<div className="max-h-24 space-y-1 overflow-auto font-mono text-[10px]">
							{runtime.history.length === 0 && <div className="font-sans text-xs text-muted-foreground">No runtime trace yet.</div>}
							{runtime.history
								.slice()
								.reverse()
								.slice(0, 8)
								.map((entry: any) => (
									<div key={entry.sequence} className={entry.kind === "frameBreakpoint" ? "text-amber-400" : "text-muted-foreground"}>
										#{entry.sequence} {entry.kind} · f{entry.frame ?? "—"} · loop {entry.loopCount}
									</div>
								))}
						</div>
						<div className="max-h-20 space-y-1 overflow-auto text-[10px] text-muted-foreground">
							{runtime.tracks.slice(0, 4).map((track: any) => (
								<div key={track.index} title={`${track.targetName ?? track.targetId} · ${track.property}`}>
									{shortText(track.property, 20)} · current {track.currentValue?.map((value: number) => value.toFixed(3)).join(", ") ?? "—"} · Δ{" "}
									{track.maximumComponentDivergence === null ? "—" : Number(track.maximumComponentDivergence).toExponential(2)}
								</div>
							))}
							<div>
								Events {runtime.recentEventEvidence.returnedCount}/{runtime.recentEventEvidence.retainedMatchingCount} · tracks {runtime.trackPage.count}/
								{runtime.trackPage.total}
							</div>
						</div>
					</div>
				</div>
			</details>
		);
	}

	private _renderDopeSheet(model: any, from: number, to: number): ReactNode {
		const width = Math.max(900, (to - from) * 18);
		const height = Math.max(120, model.tracks.length * rowHeight + 32);
		const frameX = (frame: number): number => ((frame - from) / (to - from)) * width;
		const selected = new Set(this.state.selected.map(selectionIdentity));
		const box = this.state.boxSelection;
		const ticks = this._ticks(from, to, width);
		return (
			<div className="flex min-h-0 flex-1 overflow-auto border-b border-input">
				<div className="sticky left-0 z-10 w-[248px] shrink-0 border-r border-input bg-background">
					<div className="h-8 border-b border-input px-2 py-2 text-xs font-medium">Animated properties</div>
					{model.tracks.map((track: any) => (
						<button
							key={track.index}
							className={`block h-[34px] w-full border-b border-input px-2 text-left text-xs ${this.state.activeTrackIndex === track.index ? "bg-secondary" : ""}`}
							onClick={() => this.setState({ activeTrackIndex: track.index })}
							title={`${track.targetName ?? track.targetId ?? "Target"} · ${track.property}`}
						>
							<div className="truncate font-medium">{shortText(track.property)}</div>
							<div className="truncate text-[10px] text-muted-foreground">{shortText(track.targetName ?? track.targetId ?? "Unknown target")}</div>
						</button>
					))}
				</div>
				<svg
					className="block shrink-0 select-none"
					width={width}
					height={height}
					viewBox={`0 0 ${width} ${height}`}
					onMouseDown={(event) => this._beginBoxSelection(event, width, height)}
					onMouseMove={(event) => this._moveBoxSelection(event, width, height)}
					onMouseUp={() => this._endBoxSelection(model, from, to, width)}
					onMouseLeave={() => this._endBoxSelection(model, from, to, width)}
				>
					<rect x="0" y="0" width={width} height={height} className="fill-background" />
					{ticks.map((tick) => (
						<g key={tick.frame}>
							<line x1={tick.x} y1="0" x2={tick.x} y2={height} className="stroke-border" strokeWidth={tick.major ? 1 : 0.5} />
							{tick.major && (
								<text x={tick.x + 3} y="19" className="fill-muted-foreground text-[10px]">
									{tick.frame}
								</text>
							)}
						</g>
					))}
					{model.tracks.map((track: any, row: number) => (
						<g key={track.index}>
							<rect x="0" y={32 + row * rowHeight} width={width} height={rowHeight} className={row % 2 ? "fill-muted/20" : "fill-background"} />
							<line x1="0" y1={32 + (row + 1) * rowHeight} x2={width} y2={32 + (row + 1) * rowHeight} className="stroke-border" />
							{track.keys.map((key: any) => {
								const identity = selectionIdentity({ trackIndex: track.index, frame: key.frame });
								const x = frameX(key.frame);
								const y = 32 + row * rowHeight + rowHeight / 2;
								return (
									<rect
										key={key.frame}
										x={x - 5}
										y={y - 5}
										width="10"
										height="10"
										transform={`rotate(45 ${x} ${y})`}
										className={
											selected.has(identity)
												? "cursor-pointer fill-primary stroke-primary-foreground"
												: "cursor-pointer fill-muted-foreground stroke-background"
										}
										strokeWidth="1"
										onMouseDown={(event) => {
											event.stopPropagation();
											this._selectKey({ trackIndex: track.index, frame: key.frame }, event.shiftKey || event.metaKey || event.ctrlKey);
										}}
									/>
								);
							})}
						</g>
					))}
					{model.events.map((event: any, index: number) => {
						const x = frameX(event.frame);
						return (
							<g key={`${event.frame}:${index}`}>
								<path d={`M ${x - 5} 2 L ${x + 5} 2 L ${x} 11 z`} className="fill-amber-400" />
								<title>{`${event.action} at frame ${event.frame}`}</title>
							</g>
						);
					})}
					<line x1={frameX(this.state.currentFrame)} y1="0" x2={frameX(this.state.currentFrame)} y2={height} className="stroke-red-500" strokeWidth="1.5" />
					{box && (
						<rect
							x={Math.min(box.startX, box.x)}
							y={Math.min(box.startY, box.y)}
							width={Math.abs(box.x - box.startX)}
							height={Math.abs(box.y - box.startY)}
							className="fill-primary/15 stroke-primary"
							strokeDasharray="4 3"
						/>
					)}
				</svg>
			</div>
		);
	}

	private _renderCurves(model: any, activeTrack: any, from: number, to: number): ReactNode {
		if (!activeTrack) {
			return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">This clip contains no tracks.</div>;
		}
		const components = activeTrack.componentLabels.map((label: string, component: number) => ({ label, component }));
		const sampledCurves = new Map<number, any[]>(
			components.map(({ component }) => [
				component,
				sampleAnimationCurve(this.props.editor.layout.preview.scene, {
					name: model.name,
					trackIndex: activeTrack.index,
					component,
					from,
					to,
					samples: 96,
				}).samples,
			])
		);
		const values = [...activeTrack.keys.flatMap((key: any) => key.values), ...[...sampledCurves.values()].flatMap((samples) => samples.map((sample) => sample.value))];
		let minimum = Math.min(...values, 0);
		let maximum = Math.max(...values, 1);
		if (minimum === maximum) {
			minimum -= 0.5;
			maximum += 0.5;
		}
		const valueSpan = maximum - minimum;
		const width = 1000;
		const height = 430;
		const x = (frame: number): number => 48 + ((frame - from) / (to - from)) * (width - 72);
		const y = (value: number): number => 18 + ((maximum - value) / valueSpan) * (height - 58);
		const selected = new Set(this.state.selected.map(selectionIdentity));
		const drag = this.state.curveDrag;
		return (
			<div className="flex min-h-0 flex-1">
				<div className="w-[248px] shrink-0 overflow-auto border-r border-input">
					<div className="border-b border-input p-2 text-xs font-medium">Tracks</div>
					{model.tracks.map((track: any) => (
						<button
							key={track.index}
							className={`block w-full border-b border-input p-2 text-left text-xs ${activeTrack.index === track.index ? "bg-secondary" : ""}`}
							onClick={() => this.setState({ activeTrackIndex: track.index, selected: [] })}
						>
							<div className="truncate font-medium">{track.property}</div>
							<div className="truncate text-[10px] text-muted-foreground">{track.targetName ?? track.targetId}</div>
						</button>
					))}
				</div>
				<div className="min-w-0 flex-1 overflow-auto p-2">
					<div className="mb-2 flex gap-3 text-xs">
						{components.map(({ label, component }: any) => (
							<span key={component} style={{ color: curveColors[component] }}>
								● {label}
							</span>
						))}
						<span className="ml-auto text-muted-foreground">
							{minimum.toFixed(3)} … {maximum.toFixed(3)}
						</span>
					</div>
					<svg
						className="block min-w-[62rem] rounded border border-input bg-muted/10"
						viewBox={`0 0 ${width} ${height}`}
						role="img"
						aria-label={`${model.name} curve editor`}
					>
						{this._ticks(from, to, width - 72).map((tick) => (
							<g key={tick.frame}>
								<line x1={48 + tick.x} y1="0" x2={48 + tick.x} y2={height - 30} className="stroke-border" strokeWidth={tick.major ? 1 : 0.5} />
								{tick.major && (
									<text x={48 + tick.x + 2} y={height - 10} className="fill-muted-foreground text-[10px]">
										{tick.frame}
									</text>
								)}
							</g>
						))}
						{[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
							const value = maximum - valueSpan * ratio;
							return (
								<g key={ratio}>
									<line x1="48" y1={y(value)} x2={width - 24} y2={y(value)} className="stroke-border" strokeWidth="0.5" />
									<text x="4" y={y(value) + 4} className="fill-muted-foreground text-[10px]">
										{value.toFixed(2)}
									</text>
								</g>
							);
						})}
						{components.map(({ component }: any) => {
							const samples = sampledCurves.get(component)!;
							return (
								<g key={component}>
									<polyline
										points={samples.map((sample: any) => `${x(sample.frame)},${y(sample.value)}`).join(" ")}
										fill="none"
										stroke={curveColors[component]}
										strokeWidth="2"
									/>
									{activeTrack.keys.map((key: any) => {
										const reference = { trackIndex: activeTrack.index, frame: key.frame, component };
										const identity = selectionIdentity(reference);
										const dragged = !!drag && drag.selection.some((candidate) => selectionIdentity(candidate) === identity);
										const cx = x(key.frame + (dragged ? drag!.frameDelta : 0));
										const cy = y((key.values[component] ?? 0) + (dragged ? drag!.valueDelta : 0));
										return (
											<circle
												key={key.frame}
												cx={cx}
												cy={cy}
												r={selected.has(identity) ? 5 : 3.5}
												fill={curveColors[component]}
												className="cursor-move stroke-background"
												strokeWidth="1"
												onMouseDown={(event) => this._beginCurveDrag(event, reference, to - from, valueSpan, selected)}
											/>
										);
									})}
								</g>
							);
						})}
						<line x1={x(this.state.currentFrame)} y1="0" x2={x(this.state.currentFrame)} y2={height - 30} className="stroke-red-500" strokeWidth="1.5" />
					</svg>
				</div>
			</div>
		);
	}

	private _renderSelectionTools(model: any): ReactNode {
		const disabled = !this.state.selected.length;
		return (
			<div className="flex flex-wrap items-center gap-2 border-t border-input bg-input p-2 text-xs">
				<span className="font-medium">Selected keys</span>
				<label className="flex items-center gap-1">
					Δ Frame
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						step="any"
						value={String(this.state.frameDelta)}
						onChange={(event) => this.setState({ frameDelta: Number(event.target.value) })}
					/>
				</label>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._edit(model, { operation: "move", frameDelta: this.state.frameDelta })}>
					Move
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={disabled || this.state.frameDelta === 0}
					onClick={() => this._edit(model, { operation: "duplicate", frameDelta: this.state.frameDelta })}
				>
					Duplicate
				</Button>
				<label className="flex items-center gap-1">
					Scale
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						min="0.001"
						step="0.1"
						value={String(this.state.frameScale)}
						onChange={(event) => this.setState({ frameScale: Number(event.target.value) })}
					/>
				</label>
				<label className="flex items-center gap-1">
					Pivot
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						value={String(this.state.pivotFrame)}
						onChange={(event) => this.setState({ pivotFrame: Number(event.target.value) })}
					/>
				</label>
				<Button
					size="sm"
					variant="outline"
					disabled={disabled}
					onClick={() => this._edit(model, { operation: "scale", frameScale: this.state.frameScale, pivotFrame: this.state.pivotFrame })}
				>
					Scale Time
				</Button>
				<label className="flex items-center gap-1">
					Δ Value
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						step="any"
						value={String(this.state.valueDelta)}
						onChange={(event) => this.setState({ valueDelta: Number(event.target.value) })}
					/>
				</label>
				<Button
					size="sm"
					variant="outline"
					disabled={disabled || this.state.selected.some((selection) => selection.component === undefined)}
					onClick={() => this._edit(model, { operation: "offsetValue", valueDelta: this.state.valueDelta })}
				>
					Offset Value
				</Button>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._edit(model, { operation: "setInterpolation", interpolation: "linear" })}>
					Linear
				</Button>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._edit(model, { operation: "setInterpolation", interpolation: "step" })}>
					Step
				</Button>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._setTangentMode(model, "auto")}>
					Auto
				</Button>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._setTangentMode(model, "clampedAuto")}>
					Clamped Auto
				</Button>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._setTangentMode(model, "linear")}>
					Linear Tangents
				</Button>
				<label className="flex items-center gap-1">
					Tangent
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						step="any"
						value={String(this.state.tangent)}
						onChange={(event) => this.setState({ tangent: Number(event.target.value) })}
					/>
				</label>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._setTangentMode(model, "freeSmooth")}>
					Free Smooth
				</Button>
				<label className="flex items-center gap-1">
					In
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						step="any"
						value={String(this.state.inTangent)}
						onChange={(event) => this.setState({ inTangent: Number(event.target.value) })}
					/>
				</label>
				<label className="flex items-center gap-1">
					Out
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						step="any"
						value={String(this.state.outTangent)}
						onChange={(event) => this.setState({ outTangent: Number(event.target.value) })}
					/>
				</label>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._setTangentMode(model, "broken")}>
					Broken
				</Button>
				<label className="flex items-center gap-1">
					In W
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						min="0.01"
						max="1"
						step="0.01"
						value={String(this.state.inWeight)}
						onChange={(event) => this.setState({ inWeight: Number(event.target.value) })}
					/>
				</label>
				<label className="flex items-center gap-1">
					Out W
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						min="0.01"
						max="1"
						step="0.01"
						value={String(this.state.outWeight)}
						onChange={(event) => this.setState({ outWeight: Number(event.target.value) })}
					/>
				</label>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._setTangentMode(model, "weighted")}>
					Weighted
				</Button>
				<Button size="sm" variant="destructive" disabled={disabled} onClick={() => this._edit(model, { operation: "delete" })}>
					Delete
				</Button>
				<Button size="sm" variant="ghost" disabled={disabled} onClick={() => this.setState({ selected: [] })}>
					Clear
				</Button>
			</div>
		);
	}

	private _animationEventDraft(): Record<string, unknown> {
		const base = {
			frame: this.state.eventFrame,
			action: this.state.eventAction,
			...(this.state.eventParameter.trim() ? { parameter: this.state.eventParameter.trim() } : {}),
			...(this.state.eventOnlyOnce ? { onlyOnce: true } : {}),
		};
		if (this.state.eventAction === "setEnabled") {
			return {
				...base,
				...(this.state.eventTargetNodeId.trim() ? { nodeId: this.state.eventTargetNodeId.trim() } : {}),
				...(this.state.eventTargetNodeName.trim() ? { nodeName: this.state.eventTargetNodeName.trim() } : {}),
				enabled: this.state.eventEnabled,
			};
		}
		if (this.state.eventAction === "playAnimationGroup") {
			return { ...base, animationGroupName: this.state.eventAnimationGroupName, loop: this.state.eventLoop };
		}
		if (this.state.eventAction === "stopAnimationGroup") {
			return { ...base, animationGroupName: this.state.eventAnimationGroupName };
		}
		if (this.state.eventAction === "scriptMethod") {
			const args: unknown = JSON.parse(this.state.eventArgumentsJson);
			if (!Array.isArray(args)) {
				throw new Error("Animation Event arguments must be a JSON array.");
			}
			return {
				...base,
				...(this.state.eventTargetNodeId.trim() ? { nodeId: this.state.eventTargetNodeId.trim() } : {}),
				...(this.state.eventTargetNodeName.trim() ? { nodeName: this.state.eventTargetNodeName.trim() } : {}),
				methodName: this.state.eventMethodName.trim(),
				...(this.state.eventScriptKey.trim() ? { scriptKey: this.state.eventScriptKey.trim() } : {}),
				arguments: args,
				missingMethodPolicy: this.state.eventMissingMethodPolicy,
			};
		}
		return base;
	}

	private _commitAnimationEvent(scene: Scene, groupName: string): void {
		try {
			const snapshot = listAnimationEvents(scene, { name: groupName });
			const events = structuredClone(snapshot.groups[0]?.events ?? []);
			const draft = this._animationEventDraft();
			if (this.state.eventEditingIndex === null) {
				events.push(draft);
			} else if (events[this.state.eventEditingIndex]) {
				events[this.state.eventEditingIndex] = draft;
			} else {
				throw new Error("The edited Animation Event no longer exists. Refresh and retry.");
			}
			setAnimationEvents(scene, { name: groupName, expectedRevision: snapshot.targetRevision, events }, { editor: this.props.editor });
			this._resetAnimationEventDraft(this.state.currentFrame);
			this.setState({ revision: this.state.revision + 1 });
			toast.success(this.state.eventEditingIndex === null ? "Animation Event added." : "Animation Event updated.");
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _removeAnimationEvent(scene: Scene, groupName: string, index: number): void {
		try {
			const snapshot = listAnimationEvents(scene, { name: groupName });
			const events = structuredClone(snapshot.groups[0]?.events ?? []);
			if (!events[index]) {
				throw new Error("The selected Animation Event no longer exists. Refresh and retry.");
			}
			events.splice(index, 1);
			setAnimationEvents(scene, { name: groupName, expectedRevision: snapshot.targetRevision, events }, { editor: this.props.editor });
			this._resetAnimationEventDraft(this.state.currentFrame);
			this.setState({ revision: this.state.revision + 1 });
			toast.success("Animation Event removed.");
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _loadAnimationEvent(event: any, index: number): void {
		this.setState({
			eventEditingIndex: index,
			eventFrame: event.frame,
			eventAction: event.action,
			eventTargetNodeId: event.nodeId ?? "",
			eventTargetNodeName: event.nodeName ?? "",
			eventAnimationGroupName: event.animationGroupName ?? "",
			eventEnabled: event.enabled ?? true,
			eventLoop: event.loop ?? true,
			eventParameter: event.parameter ?? "",
			eventOnlyOnce: event.onlyOnce ?? false,
			eventMethodName: event.methodName ?? "",
			eventScriptKey: event.scriptKey ?? "",
			eventArgumentsJson: JSON.stringify(event.arguments ?? [], null, 2),
			eventMissingMethodPolicy: event.missingMethodPolicy ?? "error",
		});
	}

	private _resetAnimationEventDraft(frame: number): void {
		this.setState({
			eventEditingIndex: null,
			eventFrame: frame,
			eventAction: "scriptMethod",
			eventTargetNodeId: "",
			eventTargetNodeName: "",
			eventAnimationGroupName: "",
			eventEnabled: true,
			eventLoop: true,
			eventParameter: "",
			eventOnlyOnce: false,
			eventMethodName: "",
			eventScriptKey: "",
			eventArgumentsJson: "[]",
			eventMissingMethodPolicy: "error",
		});
	}

	private _ticks(from: number, to: number, width: number): Array<{ frame: number; x: number; major: boolean }> {
		const span = to - from;
		const rough = Math.max(1, span / Math.max(4, Math.floor(width / 120)));
		const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
		const normalized = rough / magnitude;
		const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
		const first = Math.ceil(from / step) * step;
		const ticks: Array<{ frame: number; x: number; major: boolean }> = [];
		for (let frame = first, index = 0; frame <= to && ticks.length < 200; frame += step / 5, index++) {
			ticks.push({ frame: Number(frame.toFixed(6)), x: ((frame - from) / span) * width, major: index % 5 === 0 });
		}
		return ticks;
	}

	private _refreshRuntime(): void {
		const scene = this.props.editor.layout.preview.scene;
		const groupName = this.state.groupName;
		if (!groupName || !scene.getAnimationGroupByName(groupName)) {
			if (this.state.runtime) {
				this.setState({ runtime: null });
			}
			return;
		}
		try {
			const runtime = getAnimationRuntimeDebug(scene, { name: groupName, trackLimit: 32, historyLimit: 32, eventLimit: 16 });
			this.setState({ runtime, currentFrame: runtime.currentFrame ?? this.state.currentFrame });
		} catch {
			this.setState({ runtime: null });
		}
	}

	private _setRuntimePaused(scene: Scene, groupName: string, paused: boolean): void {
		try {
			const current = getAnimationRuntimeDebug(scene, { name: groupName, trackLimit: 32, historyLimit: 32, eventLimit: 16 });
			const runtime = setAnimationRuntimeDebug(
				scene,
				{ name: groupName, expectedFingerprint: current.fingerprint, paused, trackLimit: 32, historyLimit: 32, eventLimit: 16 },
				{ editor: this.props.editor }
			);
			this.setState({ runtime, currentFrame: runtime.currentFrame ?? this.state.currentFrame });
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _stepRuntime(scene: Scene, groupName: string, frameDelta: number): void {
		try {
			const current = getAnimationRuntimeDebug(scene, { name: groupName, trackLimit: 32, historyLimit: 32, eventLimit: 16 });
			const runtime = stepAnimationRuntimeDebug(
				scene,
				{ name: groupName, expectedFingerprint: current.fingerprint, frameDelta, steps: 1, trackLimit: 32, historyLimit: 32, eventLimit: 16 },
				{ editor: this.props.editor }
			);
			this.setState({ runtime, currentFrame: runtime.currentFrame });
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _clearRuntimeHistory(scene: Scene, groupName: string): void {
		try {
			const current = getAnimationRuntimeDebug(scene, { name: groupName, trackLimit: 32, historyLimit: 32, eventLimit: 16 });
			const runtime = setAnimationRuntimeDebug(
				scene,
				{ name: groupName, expectedFingerprint: current.fingerprint, clearHistory: true, trackLimit: 32, historyLimit: 32, eventLimit: 16 },
				{ editor: this.props.editor }
			);
			this.setState({ runtime });
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _upsertRuntimeBreakpoint(scene: Scene, groupName: string): void {
		try {
			const current = getAnimationRuntimeDebug(scene, { name: groupName, trackLimit: 32, historyLimit: 32, eventLimit: 16 });
			const breakpoint = { id: this.state.runtimeBreakpointId.trim(), frame: this.state.runtimeBreakpointFrame, enabled: true };
			const breakpoints = [...current.breakpoints.filter((candidate: any) => candidate.id !== breakpoint.id), breakpoint];
			const runtime = setAnimationRuntimeDebug(
				scene,
				{ name: groupName, expectedFingerprint: current.fingerprint, breakpoints, trackLimit: 32, historyLimit: 32, eventLimit: 16 },
				{ editor: this.props.editor }
			);
			this.setState({ runtime });
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _removeRuntimeBreakpoint(scene: Scene, groupName: string, id: string): void {
		try {
			const current = getAnimationRuntimeDebug(scene, { name: groupName, trackLimit: 32, historyLimit: 32, eventLimit: 16 });
			const runtime = setAnimationRuntimeDebug(
				scene,
				{
					name: groupName,
					expectedFingerprint: current.fingerprint,
					breakpoints: current.breakpoints.filter((candidate: any) => candidate.id !== id),
					trackLimit: 32,
					historyLimit: 32,
					eventLimit: 16,
				},
				{ editor: this.props.editor }
			);
			this.setState({ runtime });
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _selectGroup(name: string): void {
		const scene = this.props.editor.layout.preview.scene;
		const model = getAnimationWindow(scene, { name });
		const runtime = getAnimationRuntimeDebug(scene, { name, trackLimit: 32, historyLimit: 32, eventLimit: 16 });
		this.props.onGroupChange(name);
		this.setState({
			groupName: name,
			activeTrackIndex: model.tracks[0]?.index ?? 0,
			selected: [],
			from: model.from,
			to: Math.max(model.to, model.from + 1),
			currentFrame: model.from,
			pivotFrame: model.from,
			recording: false,
			lastRecorded: null,
			runtime,
			runtimeBreakpointFrame: model.from,
			eventEditingIndex: null,
			eventFrame: model.from,
			eventAction: "scriptMethod",
			eventTargetNodeId: "",
			eventTargetNodeName: "",
			eventAnimationGroupName: "",
			eventEnabled: true,
			eventLoop: true,
			eventParameter: "",
			eventOnlyOnce: false,
			eventMethodName: "",
			eventScriptKey: "",
			eventArgumentsJson: "[]",
			eventMissingMethodPolicy: "error",
		});
	}

	private _recordInspectorProperty(event: IInspectorPropertyChangedEvent): void {
		if (!this.state.recording || !this.state.groupName) {
			return;
		}
		try {
			const scene = this.props.editor.layout.preview.scene;
			const model = getAnimationWindow(scene, { name: this.state.groupName });
			const targetTracks = model.tracks.filter(
				(track: any) => this.state.groupName && scene.getAnimationGroupByName(this.state.groupName)?.targetedAnimations[track.index]?.target === event.object
			);
			const exact = targetTracks.find((track: any) => track.property === event.property);
			const parent = targetTracks
				.filter((track: any) => event.property.startsWith(`${track.property}.`))
				.sort((left: any, right: any) => right.property.length - left.property.length)[0];
			const property = exact?.property ?? parent?.property ?? event.property;
			const targetTrack = exact ?? parent ?? targetTracks[0];
			const nodeId = !targetTrack && event.object?.id && scene.getNodeById(event.object.id) === event.object ? event.object.id : undefined;
			if (!targetTrack && !nodeId) {
				throw new Error("Recording a new property track requires the edited Inspector object to be a scene node.");
			}
			const result = recordAnimationWindowProperties(
				scene,
				{
					name: model.name,
					expectedFingerprint: model.fingerprint,
					frame: this.state.currentFrame,
					entries: [{ ...(targetTrack ? { targetTrackIndex: targetTrack.index } : { nodeId }), property }],
				},
				{ editor: this.props.editor }
			);
			const recorded = result.recorded[0];
			this.setState({
				activeTrackIndex: recorded.trackIndex,
				lastRecorded: `Recorded ${recorded.property} @ ${recorded.frame}`,
				revision: this.state.revision + 1,
				from: Math.min(this.state.from, result.window.from),
				to: Math.max(this.state.to, result.window.to, result.window.from + 1),
			});
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _selectKey(selection: IAnimationWindowSelection, append: boolean): void {
		const identity = selectionIdentity(selection);
		if (!append) {
			this.setState({ selected: [selection], activeTrackIndex: selection.trackIndex, pivotFrame: selection.frame });
			return;
		}
		const exists = this.state.selected.some((candidate) => selectionIdentity(candidate) === identity);
		this.setState({
			selected: exists ? this.state.selected.filter((candidate) => selectionIdentity(candidate) !== identity) : [...this.state.selected, selection],
			activeTrackIndex: selection.trackIndex,
			pivotFrame: selection.frame,
		});
	}

	private _fit(model: any): void {
		this.setState({ from: model.from, to: Math.max(model.to, model.from + 1), currentFrame: model.from });
	}

	private _play(scene: Scene, name: string): void {
		const group = scene.getAnimationGroupByName(name);
		if (!group) {
			return;
		}
		group.play(true);
		this._refreshRuntime();
	}

	private _scrub(scene: Scene, name: string, frame: number): void {
		if (!Number.isFinite(frame)) {
			return;
		}
		const group = scene.getAnimationGroupByName(name);
		if (!group) {
			return;
		}
		group.start(false, 1, group.from, group.to);
		group.goToFrame(frame);
		group.pause();
		this.setState({ currentFrame: frame });
	}

	private _edit(model: any, patch: Record<string, unknown>, selection = this.state.selected): void {
		try {
			const result = editAnimationWindowKeys(
				this.props.editor.layout.preview.scene,
				{ name: model.name, expectedFingerprint: model.fingerprint, selection, ...patch },
				{ editor: this.props.editor }
			);
			const next = result.window;
			this.setState({
				selected: [],
				revision: this.state.revision + 1,
				from: Math.min(this.state.from, next.from),
				to: Math.max(this.state.to, next.to, next.from + 1),
			});
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setTangentMode(model: any, mode: "auto" | "clampedAuto" | "linear" | "freeSmooth" | "broken" | "weighted"): void {
		try {
			const manual =
				mode === "freeSmooth"
					? { tangent: this.state.tangent }
					: mode === "broken"
						? { inTangent: this.state.inTangent, outTangent: this.state.outTangent }
						: mode === "weighted"
							? { inTangent: this.state.inTangent, outTangent: this.state.outTangent, inWeight: this.state.inWeight, outWeight: this.state.outWeight }
							: {};
			const result = setAnimationWindowTangentModes(
				this.props.editor.layout.preview.scene,
				{ name: model.name, expectedFingerprint: model.fingerprint, selection: this.state.selected, mode, ...manual },
				{ editor: this.props.editor }
			);
			this.setState({ revision: this.state.revision + 1 });
			toast.success(`${mode} applied to ${result.changedComponentCount} curve component${result.changedComponentCount === 1 ? "" : "s"}.`);
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _beginBoxSelection(event: ReactMouseEvent<SVGSVGElement>, width: number, height: number): void {
		if (event.button !== 0 || (event.target !== event.currentTarget && (event.target as Element).tagName !== "rect")) {
			return;
		}
		const position = this._svgPointer(event, event.currentTarget, width, height);
		this.setState({ boxSelection: { startX: position[0], startY: position[1], x: position[0], y: position[1], append: event.shiftKey || event.metaKey || event.ctrlKey } });
	}

	private _moveBoxSelection(event: ReactMouseEvent<SVGSVGElement>, width: number, height: number): void {
		if (!this.state.boxSelection) {
			return;
		}
		const position = this._svgPointer(event, event.currentTarget, width, height);
		this.setState({ boxSelection: { ...this.state.boxSelection, x: position[0], y: position[1] } });
	}

	private _endBoxSelection(model: any, from: number, to: number, width: number): void {
		const box = this.state.boxSelection;
		if (!box) {
			return;
		}
		this.setState({ boxSelection: null });
		const minimumX = Math.min(box.startX, box.x);
		const maximumX = Math.max(box.startX, box.x);
		const minimumY = Math.min(box.startY, box.y);
		const maximumY = Math.max(box.startY, box.y);
		if (maximumX - minimumX < 3 && maximumY - minimumY < 3) {
			if (!box.append) {
				this.setState({ selected: [] });
			}
			return;
		}
		const selections: IAnimationWindowSelection[] = [];
		for (const [row, track] of model.tracks.entries()) {
			const y = 32 + row * rowHeight + rowHeight / 2;
			if (y < minimumY || y > maximumY) {
				continue;
			}
			for (const key of track.keys) {
				const x = ((key.frame - from) / (to - from)) * width;
				if (x >= minimumX && x <= maximumX) {
					selections.push({ trackIndex: track.index, frame: key.frame });
				}
			}
		}
		const combined = box.append ? [...this.state.selected, ...selections] : selections;
		this.setState({ selected: [...new Map(combined.map((selection) => [selectionIdentity(selection), selection])).values()] });
	}

	private _beginCurveDrag(
		event: ReactMouseEvent<SVGCircleElement>,
		reference: IAnimationWindowSelection,
		frameSpan: number,
		valueSpan: number,
		selectedIdentities: Set<string>
	): void {
		event.preventDefault();
		event.stopPropagation();
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) {
			return;
		}
		const append = event.shiftKey || event.metaKey || event.ctrlKey;
		const identity = selectionIdentity(reference);
		let selection = this.state.selected;
		if (!selectedIdentities.has(identity)) {
			selection = append ? [...selection, reference] : [reference];
			this.setState({ selected: selection, activeTrackIndex: reference.trackIndex, pivotFrame: reference.frame });
		}
		this.setState({
			curveDrag: {
				selection,
				startClientX: event.clientX,
				startClientY: event.clientY,
				frameSpan,
				valueSpan,
				svg,
				frameDelta: 0,
				valueDelta: 0,
			},
		});
		window.addEventListener("mousemove", this._moveCurveDrag);
		window.addEventListener("mouseup", this._endCurveDrag, { once: true });
	}

	private _moveCurveDrag = (event: MouseEvent): void => {
		const drag = this.state.curveDrag;
		if (!drag) {
			return;
		}
		const bounds = drag.svg.getBoundingClientRect();
		if (!bounds.width || !bounds.height) {
			return;
		}
		this.setState({
			curveDrag: {
				...drag,
				frameDelta: Math.round(((event.clientX - drag.startClientX) / bounds.width) * drag.frameSpan),
				valueDelta: -((event.clientY - drag.startClientY) / bounds.height) * drag.valueSpan,
			},
		});
	};

	private _endCurveDrag = (): void => {
		window.removeEventListener("mousemove", this._moveCurveDrag);
		const drag = this.state.curveDrag;
		if (!drag) {
			return;
		}
		this.setState({ curveDrag: null });
		if (drag.frameDelta === 0 && Math.abs(drag.valueDelta) < 0.0000001) {
			return;
		}
		const model = getAnimationWindow(this.props.editor.layout.preview.scene, { name: this.state.groupName });
		this._edit(model, { operation: "move", frameDelta: drag.frameDelta, valueDelta: drag.valueDelta }, drag.selection);
	};

	private _svgPointer(event: ReactMouseEvent<SVGSVGElement>, svg: SVGSVGElement, width: number, height: number): [number, number] {
		const bounds = svg.getBoundingClientRect();
		return [(event.clientX - bounds.left) * (width / bounds.width), (event.clientY - bounds.top) * (height / bounds.height)];
	}
}
