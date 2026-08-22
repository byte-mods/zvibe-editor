import { ipcRenderer } from "electron";
import { dirname, join } from "path/posix";
import { readFile } from "fs-extra";

import { Component, ReactNode } from "react";
import { toast } from "sonner";
import { TbPlayerPause, TbPlayerPlay, TbPlayerStop, TbDeviceFloppy, TbTrash, TbWaveSine } from "react-icons/tb";
import { FaRedo, FaUndo } from "react-icons/fa";

import { SoundState } from "@babylonjs/core/AudioV2/soundState";
import { AudioEngineV2 } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import { CreateAudioEngineAsync } from "@babylonjs/core/AudioV2/webAudio/webAudioEngine";
import {
	createScriptableAudioSoundAsync,
	decodeScriptableAudioClip,
	getScriptableAudioPlaybackState,
	IScriptableAudioGeneratorEdge,
	IScriptableAudioGeneratorGraph,
	IScriptableAudioGeneratorNode,
	IScriptableAudioGeneratorTypeSummary,
	listScriptableAudioGeneratorTypes,
	ScriptableAudioSound,
	validateScriptableAudioGeneratorGraph,
} from "babylonjs-editor-tools";

import { IScriptableAudioAssetSnapshot, readScriptableAudioAsset, writeScriptableAudioAsset } from "../../../mcp/assets/scriptable-audio-assets";
import { projectConfiguration } from "../../../project/configuration";
import { ToolbarComponent } from "../../../ui/toolbar";
import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { Toaster } from "../../../ui/shadcn/ui/sonner";

import {
	addAudioGeneratorNode,
	AudioGeneratorDocumentHistory,
	connectAudioGeneratorNodes,
	IAudioGeneratorHistoryState,
	removeAudioGeneratorEdge,
	removeAudioGeneratorNode,
	updateAudioGeneratorEdge,
	updateAudioGeneratorNode,
} from "./model";

export interface IAudioGeneratorEditorWindowProps {
	filePath: string;
	projectPath: string;
}

interface IAudioGeneratorEditorWindowState extends IAudioGeneratorHistoryState {
	loading: boolean;
	saving: boolean;
	selectedNodeId: string | null;
	selectedEdgeId: string | null;
	connectionSourceId: string;
	connectionTargetId: string;
	playing: boolean;
	currentTime: number;
	loop: boolean;
	playbackRate: number;
	playbackState: ReturnType<typeof getScriptableAudioPlaybackState>;
	asset: IScriptableAudioAssetSnapshot | null;
	error: string | null;
}

const emptyGraph = {
	version: 1,
	revision: 1,
	name: "Loading Audio Generator",
	sampleRate: 48_000,
	channels: 2,
	durationSeconds: 1,
	streaming: false,
	seed: 1,
	outputNodeId: "output",
	nodes: [{ id: "output", name: "Output", type: "output", position: [420, 120], enabled: true, data: {} }],
	edges: [],
} as IScriptableAudioGeneratorGraph;

function numberValue(value: string, label: string): number {
	const result = Number(value);
	if (!Number.isFinite(result)) {
		throw new Error(`${label} must be a finite number.`);
	}
	return result;
}

function fieldClass(): string {
	return "h-8 bg-background border-border text-xs";
}

export default class AudioGeneratorEditorWindow extends Component<IAudioGeneratorEditorWindowProps, IAudioGeneratorEditorWindowState> {
	private _history = new AudioGeneratorDocumentHistory(emptyGraph);
	private _generatorTypes: IScriptableAudioGeneratorTypeSummary[] = [];
	private _sound: ScriptableAudioSound | null = null;
	private _audioEngine: AudioEngineV2 | null = null;
	private _positionTimer: ReturnType<typeof setInterval> | null = null;
	private _keyDown: ((event: KeyboardEvent) => void) | null = null;
	private _graphElement: HTMLElement | null = null;

	public constructor(props: IAudioGeneratorEditorWindowProps) {
		super(props);
		this.state = {
			...this._history.state,
			loading: true,
			saving: false,
			selectedNodeId: null,
			selectedEdgeId: null,
			connectionSourceId: "",
			connectionTargetId: "output",
			playing: false,
			currentTime: 0,
			loop: false,
			playbackRate: 1,
			playbackState: null,
			asset: null,
			error: null,
		};
	}

	public render(): ReactNode {
		const validation = validateScriptableAudioGeneratorGraph(this.state.graph);
		const selectedNode = this.state.graph.nodes.find((node) => node.id === this.state.selectedNodeId) ?? null;
		const selectedEdge = this.state.graph.edges.find((edge) => edge.id === this.state.selectedEdgeId) ?? null;
		return (
			<div className="flex flex-col w-screen h-screen bg-background text-foreground">
				<ToolbarComponent>
					<div className="flex items-center gap-1 px-2">
						<Button size="sm" variant="ghost" disabled={!this.state.canUndo} onClick={() => this._publish(this._history.undo())} title="Undo (Cmd/Ctrl+Z)">
							<FaUndo />
						</Button>
						<Button size="sm" variant="ghost" disabled={!this.state.canRedo} onClick={() => this._publish(this._history.redo())} title="Redo (Cmd/Ctrl+Shift+Z)">
							<FaRedo />
						</Button>
						<Button size="sm" variant="ghost" disabled={!this.state.dirty || this.state.saving || !validation.valid} onClick={() => void this._save()}>
							<TbDeviceFloppy className="mr-1" /> Save
						</Button>
						<Button size="sm" variant="ghost" disabled={!validation.valid} onClick={() => void this._togglePreview()}>
							{this.state.playing ? <TbPlayerPause className="mr-1" /> : <TbPlayerPlay className="mr-1" />} {this.state.playing ? "Pause" : "Play"}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => this._stopPreview()}>
							<TbPlayerStop className="mr-1" /> Stop
						</Button>
					</div>
					<div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 font-semibold">
						<TbWaveSine className="text-cyan-400" /> {this.state.graph.name} {this.state.dirty ? "•" : ""}
					</div>
				</ToolbarComponent>

				{this.state.loading ? (
					<div className="flex flex-1 items-center justify-center">Loading Audio Generator…</div>
				) : (
					<div className="grid min-h-0 flex-1 grid-cols-[220px_1fr_320px]">
						{this._renderPalette()}
						{this._renderGraph()}
						{this._renderInspector(selectedNode, selectedEdge, validation.errors)}
					</div>
				)}
				<Toaster />
			</div>
		);
	}

	public async componentDidMount(): Promise<void> {
		projectConfiguration.path = this.props.projectPath;
		try {
			const asset = await readScriptableAudioAsset(this.props.filePath);
			this._history = new AudioGeneratorDocumentHistory(asset.graph);
			this._generatorTypes = listScriptableAudioGeneratorTypes();
			if (!this._generatorTypes.some((type) => !type.builtIn)) {
				this._generatorTypes.push({
					id: "project.generator",
					displayName: "Project Generator",
					description: "Custom project TypeScript generator; edit its registered id, dataVersion, and parameters in Node Data.",
					dataVersion: 1,
					builtIn: false,
					supportsSeeking: false,
					defaultData: {},
				});
			}
			this.setState({ ...this._history.state, asset, loading: false, connectionTargetId: asset.graph.outputNodeId, error: null });
		} catch (error) {
			this.setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
		}
		ipcRenderer.on("save", () => void this._save());
		ipcRenderer.on("editor:close-window", () => this.close());
		window.addEventListener(
			"keydown",
			(this._keyDown = (event) => {
				if (!(event.metaKey || event.ctrlKey)) {
					return;
				}
				if (event.key.toLowerCase() === "s") {
					event.preventDefault();
					void this._save();
				} else if (event.key.toLowerCase() === "z") {
					event.preventDefault();
					this._publish(event.shiftKey ? this._history.redo() : this._history.undo());
				}
			})
		);
	}

	public componentWillUnmount(): void {
		if (this._keyDown) {
			window.removeEventListener("keydown", this._keyDown);
		}
		this._stopPreview();
		this._audioEngine?.dispose();
	}

	public close(): void {
		ipcRenderer.send("window:close");
	}

	private _renderPalette(): ReactNode {
		return (
			<aside className="min-h-0 overflow-y-auto border-r border-border bg-card p-3">
				<div className="mb-3 text-xs font-semibold uppercase text-muted-foreground">Generator Nodes</div>
				<div className="space-y-2">
					{this._generatorTypes
						.filter((type) => type.id !== "output")
						.map((summary) => (
							<Button
								key={summary.id}
								className="h-auto w-full justify-start whitespace-normal py-2 text-left"
								variant="outline"
								onClick={() =>
									this._try(() => {
										const type = summary.builtIn ? (summary.id as IScriptableAudioGeneratorNode["type"]) : "custom";
										this._publish(addAudioGeneratorNode(this._history, type, [100 + this.state.graph.nodes.length * 25, 100], summary));
									})
								}
							>
								<div>
									<div>{summary.displayName}</div>
									<div className="text-[10px] font-normal text-muted-foreground">{summary.description}</div>
								</div>
							</Button>
						))}
				</div>
			</aside>
		);
	}

	private _renderGraph(): ReactNode {
		const width = Math.max(800, ...this.state.graph.nodes.map((node) => node.position[0] + 260));
		const height = Math.max(600, ...this.state.graph.nodes.map((node) => node.position[1] + 180));
		return (
			<main
				ref={(element) => (this._graphElement = element)}
				className="relative min-h-0 overflow-auto bg-[radial-gradient(circle_at_1px_1px,hsl(var(--border))_1px,transparent_0)] bg-[size:22px_22px]"
			>
				<svg className="pointer-events-none absolute left-0 top-0" width={width} height={height}>
					{this.state.graph.edges.map((edge) => {
						const source = this.state.graph.nodes.find((node) => node.id === edge.sourceNodeId)!;
						const target = this.state.graph.nodes.find((node) => node.id === edge.targetNodeId)!;
						return (
							<path
								key={edge.id}
								d={`M ${source.position[0] + 190} ${source.position[1] + 42} C ${source.position[0] + 270} ${source.position[1] + 42}, ${target.position[0] - 80} ${target.position[1] + 42}, ${target.position[0]} ${target.position[1] + 42}`}
								fill="none"
								stroke={edge.id === this.state.selectedEdgeId ? "#22d3ee" : "#64748b"}
								strokeWidth={edge.id === this.state.selectedEdgeId ? 4 : 2}
							/>
						);
					})}
				</svg>
				<div className="relative" style={{ width, height }}>
					{this.state.graph.nodes.map((node) => (
						<button
							key={node.id}
							type="button"
							draggable
							className={`absolute w-[190px] rounded-md border bg-card text-left shadow-md ${node.id === this.state.selectedNodeId ? "border-cyan-400 ring-2 ring-cyan-400/30" : "border-border"}`}
							style={{ left: node.position[0], top: node.position[1] }}
							onClick={() => this.setState({ selectedNodeId: node.id, selectedEdgeId: null })}
							onDragEnd={(event) => {
								if (!this._graphElement || event.clientX === 0 || event.clientY === 0) {
									return;
								}
								const bounds = this._graphElement.getBoundingClientRect();
								const x = Math.max(0, Math.round(event.clientX - bounds.left + this._graphElement.scrollLeft - 95));
								const y = Math.max(0, Math.round(event.clientY - bounds.top + this._graphElement.scrollTop - 42));
								this._try(() => this._publish(updateAudioGeneratorNode(this._history, node.id, (target) => (target.position = [x, y]))));
							}}
						>
							<div className="flex items-center justify-between rounded-t-md bg-secondary px-3 py-2 text-xs font-semibold">
								<span>{node.name}</span>
								<span className="font-mono text-[9px] text-muted-foreground">{node.type}</span>
							</div>
							<div className="px-3 py-2 text-[10px] text-muted-foreground">
								{node.id}
								<br />
								{node.enabled ? "Enabled" : "Disabled"}
							</div>
						</button>
					))}
					{this.state.graph.edges.map((edge) => {
						const source = this.state.graph.nodes.find((node) => node.id === edge.sourceNodeId)!;
						const target = this.state.graph.nodes.find((node) => node.id === edge.targetNodeId)!;
						return (
							<button
								key={`hit-${edge.id}`}
								type="button"
								className="absolute h-6 w-6 rounded-full border border-slate-500 bg-slate-700 text-[9px] text-white"
								style={{ left: (source.position[0] + target.position[0]) / 2 + 85, top: (source.position[1] + target.position[1]) / 2 + 30 }}
								onClick={() => this.setState({ selectedEdgeId: edge.id, selectedNodeId: null })}
							>
								{edge.order}
							</button>
						);
					})}
				</div>
			</main>
		);
	}

	private _renderInspector(node: IScriptableAudioGeneratorNode | null, edge: IScriptableAudioGeneratorEdge | null, errors: string[]): ReactNode {
		return (
			<aside className="min-h-0 overflow-y-auto border-l border-border bg-card p-3 text-xs">
				<div className="mb-3 text-xs font-semibold uppercase text-muted-foreground">Graph Settings</div>
				{this._textField("Name", this.state.graph.name, (value) => this._commitGraph((graph) => (graph.name = value)))}
				{this._numberField("Sample Rate", this.state.graph.sampleRate, (value) => this._commitGraph((graph) => (graph.sampleRate = value)))}
				{this._numberField("Channels", this.state.graph.channels, (value) => this._commitGraph((graph) => (graph.channels = value)))}
				{this._numberField("Duration (s)", this.state.graph.durationSeconds, (value) => this._commitGraph((graph) => (graph.durationSeconds = value)))}
				<label className="mb-3 flex items-center gap-2">
					<input type="checkbox" checked={this.state.graph.streaming} onChange={(event) => this._commitGraph((graph) => (graph.streaming = event.target.checked))} />{" "}
					Streaming AudioWorklet
				</label>

				<div className="my-3 border-t border-border" />
				<div className="mb-2 font-semibold">Connect Nodes</div>
				<select
					className={`${fieldClass()} mb-2 w-full`}
					value={this.state.connectionSourceId}
					onChange={(event) => this.setState({ connectionSourceId: event.target.value })}
				>
					<option value="">Source…</option>
					{this.state.graph.nodes
						.filter((candidate) => candidate.type !== "output")
						.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
				</select>
				<select
					className={`${fieldClass()} mb-2 w-full`}
					value={this.state.connectionTargetId}
					onChange={(event) => this.setState({ connectionTargetId: event.target.value })}
				>
					{this.state.graph.nodes
						.filter((candidate) => !["audioClip", "oscillator", "noise"].includes(candidate.type))
						.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
				</select>
				<Button
					className="mb-3 w-full"
					variant="outline"
					onClick={() => this._try(() => this._publish(connectAudioGeneratorNodes(this._history, this.state.connectionSourceId, this.state.connectionTargetId)))}
				>
					Connect
				</Button>

				{node && this._renderNodeInspector(node)}
				{edge && this._renderEdgeInspector(edge)}

				<div className="my-3 border-t border-border" />
				<div className="mb-2 font-semibold">Preview</div>
				<input
					className="w-full"
					type="range"
					min={0}
					max={this.state.graph.durationSeconds}
					step={0.001}
					value={Math.min(this.state.currentTime, this.state.graph.durationSeconds)}
					onChange={(event) => this._seekPreview(Number(event.target.value))}
				/>
				<div className="mb-2 flex justify-between font-mono text-[10px]">
					<span>{this.state.currentTime.toFixed(3)}s</span>
					<span>{this.state.graph.durationSeconds.toFixed(3)}s</span>
				</div>
				<label className="mb-2 flex items-center gap-2">
					<input type="checkbox" checked={this.state.loop} onChange={(event) => this._setLoop(event.target.checked)} /> Loop
				</label>
				{this._numberField("Playback Rate", this.state.playbackRate, (value) => this._setPlaybackRate(value), 0.01)}

				<div className="my-3 border-t border-border" />
				<div className="mb-2 font-semibold">Diagnostics</div>
				{errors.length > 0 ? (
					errors.map((error) => (
						<div key={error} className="mb-1 rounded bg-red-950/50 p-2 text-red-300">
							{error}
						</div>
					))
				) : (
					<div className="text-emerald-400">Graph valid</div>
				)}
				{this.state.error && <div className="mt-2 rounded bg-red-950/50 p-2 text-red-300">{this.state.error}</div>}
				{this.state.asset?.dependencies.map((dependency) => (
					<div key={dependency.path} className="mt-1 font-mono text-[10px]">
						{dependency.status}: {dependency.path}
					</div>
				))}
				{this.state.playbackState && (
					<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[9px]">{JSON.stringify(this.state.playbackState, null, 2)}</pre>
				)}
			</aside>
		);
	}

	private _renderNodeInspector(node: IScriptableAudioGeneratorNode): ReactNode {
		return (
			<div className="mb-3 rounded border border-border p-2">
				<div className="mb-2 flex items-center justify-between font-semibold">
					<span>Node: {node.id}</span>
					{node.id !== this.state.graph.outputNodeId && (
						<Button size="sm" variant="ghost" onClick={() => this._try(() => this._publish(removeAudioGeneratorNode(this._history, node.id)))}>
							<TbTrash />
						</Button>
					)}
				</div>
				{this._textField("Display Name", node.name, (value) =>
					this._try(() => this._publish(updateAudioGeneratorNode(this._history, node.id, (target) => (target.name = value))))
				)}
				<label className="mb-2 flex items-center gap-2">
					<input
						type="checkbox"
						checked={node.enabled}
						onChange={(event) => this._try(() => this._publish(updateAudioGeneratorNode(this._history, node.id, (target) => (target.enabled = event.target.checked))))}
					/>{" "}
					Enabled
				</label>
				<div className="grid grid-cols-2 gap-2">
					{this._numberField("X", node.position[0], (value) =>
						this._try(() => this._publish(updateAudioGeneratorNode(this._history, node.id, (target) => (target.position[0] = value))))
					)}
					{this._numberField("Y", node.position[1], (value) =>
						this._try(() => this._publish(updateAudioGeneratorNode(this._history, node.id, (target) => (target.position[1] = value))))
					)}
				</div>
				<label className="mb-1 block text-muted-foreground">Node Data (JSON)</label>
				<textarea
					className="h-36 w-full rounded border border-border bg-background p-2 font-mono text-[10px]"
					defaultValue={JSON.stringify(node.data, null, 2)}
					key={`${node.id}:${JSON.stringify(node.data)}`}
					onBlur={(event) => this._try(() => this._publish(updateAudioGeneratorNode(this._history, node.id, (target) => (target.data = JSON.parse(event.target.value)))))}
				/>
			</div>
		);
	}

	private _renderEdgeInspector(edge: IScriptableAudioGeneratorEdge): ReactNode {
		return (
			<div className="mb-3 rounded border border-border p-2">
				<div className="mb-2 flex items-center justify-between font-semibold">
					<span>Connection: {edge.id}</span>
					<Button size="sm" variant="ghost" onClick={() => this._try(() => this._publish(removeAudioGeneratorEdge(this._history, edge.id)))}>
						<TbTrash />
					</Button>
				</div>
				<div className="mb-2 font-mono text-[10px]">
					{edge.sourceNodeId} → {edge.targetNodeId}
				</div>
				{this._numberField("Order", edge.order, (value) =>
					this._try(() => this._publish(updateAudioGeneratorEdge(this._history, edge.id, (target) => (target.order = value))))
				)}
				{this._numberField("Gain", edge.gain, (value) =>
					this._try(() => this._publish(updateAudioGeneratorEdge(this._history, edge.id, (target) => (target.gain = value))))
				)}
				{edge.durationSeconds !== undefined &&
					this._numberField("Duration", edge.durationSeconds, (value) =>
						this._try(() => this._publish(updateAudioGeneratorEdge(this._history, edge.id, (target) => (target.durationSeconds = value))))
					)}
			</div>
		);
	}

	private _textField(label: string, value: string, change: (value: string) => void): ReactNode {
		return (
			<label className="mb-2 block text-muted-foreground">
				{label}
				<Input className={fieldClass()} value={value} onChange={(event) => change(event.target.value)} />
			</label>
		);
	}

	private _numberField(label: string, value: number, change: (value: number) => void, step = 1): ReactNode {
		return (
			<label className="mb-2 block text-muted-foreground">
				{label}
				<Input className={fieldClass()} type="number" step={step} value={value} onChange={(event) => this._try(() => change(numberValue(event.target.value, label)))} />
			</label>
		);
	}

	private _publish(state: IAudioGeneratorHistoryState): void {
		this._stopPreview();
		this.setState({ ...state, error: null });
	}

	private _commitGraph(mutation: (graph: IScriptableAudioGeneratorGraph) => void): void {
		this._try(() => this._publish(this._history.commit(mutation)));
	}

	private _try(action: () => void): void {
		try {
			action();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setState({ error: message });
			toast.error(message);
		}
	}

	private async _save(): Promise<void> {
		if (!this.state.asset || this.state.saving || !this.state.dirty) {
			return;
		}
		try {
			this.setState({ saving: true });
			const asset = await writeScriptableAudioAsset(this.state.asset.path, this.state.graph, this.state.asset.fingerprint);
			this.setState({ ...this._history.reset(asset.graph), asset, saving: false, error: null });
			ipcRenderer.send("editor:asset-updated", "audio-generator", asset.graph);
			toast.success("Audio Generator saved");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setState({ saving: false, error: message });
			toast.error(message);
		}
	}

	private async _prepareSound(): Promise<ScriptableAudioSound> {
		this._sound?.dispose();
		if (!this._audioEngine) {
			this._audioEngine = await CreateAudioEngineAsync({ disableDefaultUI: true });
		}
		const context = (this._audioEngine as AudioEngineV2 & { _audioContext: AudioContext })._audioContext;
		const root = dirname(this.props.projectPath);
		this._sound = await createScriptableAudioSoundAsync(this.state.graph.name, this.state.graph, {
			engine: this._audioEngine,
			loadAudioClip: async (path) => {
				const bytes = await readFile(join(root, path));
				return decodeScriptableAudioClip(context, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
			},
		});
		this._sound.loop = this.state.loop;
		this._sound.playbackRate = this.state.playbackRate;
		return this._sound;
	}

	private async _togglePreview(): Promise<void> {
		try {
			if (this.state.playing) {
				this._sound?.pause();
				this.setState({ playing: false });
				return;
			}
			const sound = this._sound ?? (await this._prepareSound());
			if (sound.state === SoundState.Paused) {
				sound.resume();
			} else {
				sound.play({ loop: this.state.loop, startOffset: this.state.currentTime });
			}
			this.setState({ playing: true, error: null });
			this._startPositionTimer();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setState({ playing: false, error: message });
			toast.error(message);
		}
	}

	private _startPositionTimer(): void {
		if (this._positionTimer) {
			return;
		}
		this._positionTimer = setInterval(() => {
			if (!this._sound) {
				return;
			}
			const playbackState = getScriptableAudioPlaybackState(this._sound);
			const playing = this._sound.state === SoundState.Started || this._sound.state === SoundState.Starting;
			this.setState({ currentTime: this._sound.currentTime, playbackState, playing });
		}, 100);
	}

	private _stopPreview(): void {
		this._sound?.stop();
		this._sound?.dispose();
		this._sound = null;
		if (this._positionTimer) {
			clearInterval(this._positionTimer);
			this._positionTimer = null;
		}
		if (this.state.playing || this.state.currentTime !== 0 || this.state.playbackState) {
			this.setState({ playing: false, currentTime: 0, playbackState: null });
		}
	}

	private _seekPreview(seconds: number): void {
		if (this._sound && "seek" in this._sound) {
			this._sound.seek(seconds);
		} else {
			this._sound?.stop();
			this._sound?.play({ loop: this.state.loop, startOffset: seconds });
		}
		this.setState({ currentTime: seconds });
	}

	private _setLoop(loop: boolean): void {
		if (this._sound) {
			this._sound.loop = loop;
		}
		this.setState({ loop });
	}

	private _setPlaybackRate(playbackRate: number): void {
		if (playbackRate < 0.01 || playbackRate > 4) {
			throw new Error("Playback Rate must be from 0.01 through 4.");
		}
		if (this._sound) {
			this._sound.playbackRate = playbackRate;
		}
		this.setState({ playbackRate });
	}
}
