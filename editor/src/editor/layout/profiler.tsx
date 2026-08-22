import { Component, MouseEvent, ReactNode } from "react";

import { IPortableProfiler2DAtlas, IPortableProfilerFrame, IPortableProfilerMarkerSummary, PortableProfilerModule } from "babylonjs-editor-tools";

import { showConfirm } from "../../ui/dialog";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { listRemoteDevices } from "../../mcp/device/device-lab";
import {
	captureProfilerSnapshot,
	clearProfilerData,
	compareProfilerSnapshots,
	deleteProfilerCapture,
	deleteProfilerSnapshot,
	exportProfilerCapture,
	getProfilerCapture,
	getProfiler2DState,
	getProfilerRunStatus,
	getProfilerState,
	importProfilerCapture,
	startProfilerCapture,
	stopProfilerCapture,
} from "../../mcp/profiling/runner";

import { Editor } from "../main";

interface IEditorProfilerProps {
	editor: Editor;
}

interface IEditorProfilerState {
	name: string;
	target: "editor-edit" | "editor-play" | "connected-player";
	connectionId: string;
	modules: PortableProfilerModule[];
	maximumFrames: number;
	maximumDurationMs: number;
	selectedCaptureId: string | null;
	selectedFrame: number;
	frameOffset: number;
	markerOffset: number;
	assetOffset: number;
	view: "timeline" | "hierarchy" | "inverted-hierarchy" | "raw-hierarchy" | "memory" | "assets" | "2d-atlas";
	search: string;
	snapshotName: string;
	baselineSnapshotId: string;
	currentSnapshotId: string;
	importPath: string;
	busy: boolean;
	error: string | null;
}

const modules: PortableProfilerModule[] = ["cpu", "gpu", "rendering", "memory", "assets", "scripts", "physics", "audio", "2d"];

function duration(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} ms` : "unavailable";
}

function bytes(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "unavailable";
	}
	if (Math.abs(value) < 1_024) {
		return `${value.toFixed(0)} B`;
	}
	if (Math.abs(value) < 1_048_576) {
		return `${(value / 1_024).toFixed(1)} KiB`;
	}
	return `${(value / 1_048_576).toFixed(2)} MiB`;
}

function ProfilerTimeline(props: { frames: IPortableProfilerFrame[]; selected: number; onSelect(index: number): void }): ReactNode {
	if (!props.frames.length) {
		return <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">No sampled frames.</div>;
	}
	const width = 960;
	const height = 150;
	const values = props.frames.flatMap((frame) => [frame.cpu?.frameTimeMs ?? 0, frame.gpuFrameTimeMs ?? 0]);
	const maximum = Math.max(16.67, ...values);
	const points = (selector: (frame: IPortableProfilerFrame) => number | null): string =>
		props.frames
			.map((frame, index) => {
				const value = selector(frame);
				return value === null
					? null
					: `${props.frames.length === 1 ? 0 : (index / (props.frames.length - 1)) * width},${height - (Math.min(maximum, value) / maximum) * height}`;
			})
			.filter((value): value is string => Boolean(value))
			.join(" ");
	const selected = Math.max(0, Math.min(props.frames.length - 1, props.selected));
	const selectedX = props.frames.length === 1 ? 0 : (selected / (props.frames.length - 1)) * width;
	const choose = (event: MouseEvent<SVGSVGElement>): void => {
		const bounds = event.currentTarget.getBoundingClientRect();
		const index = Math.round(((event.clientX - bounds.left) / Math.max(1, bounds.width)) * (props.frames.length - 1));
		props.onSelect(Math.max(0, Math.min(props.frames.length - 1, index)));
	};
	return (
		<div className="rounded border border-border bg-background p-2">
			<svg className="h-36 w-full cursor-crosshair" viewBox={`0 0 ${width} ${height}`} onClick={choose} aria-label="Profiler CPU and GPU frame timeline">
				{[16.67, 33.33, 50]
					.filter((line) => line < maximum)
					.map((line) => (
						<line
							key={line}
							x1="0"
							x2={width}
							y1={height - (line / maximum) * height}
							y2={height - (line / maximum) * height}
							stroke="currentColor"
							strokeOpacity="0.12"
						/>
					))}
				<polyline points={points((frame) => frame.cpu?.frameTimeMs ?? null)} fill="none" stroke="#38bdf8" strokeWidth="2" vectorEffect="non-scaling-stroke" />
				<polyline points={points((frame) => frame.gpuFrameTimeMs)} fill="none" stroke="#f59e0b" strokeWidth="2" vectorEffect="non-scaling-stroke" />
				<line x1={selectedX} x2={selectedX} y1="0" y2={height} stroke="#f8fafc" strokeWidth="1" vectorEffect="non-scaling-stroke" />
			</svg>
			<div className="flex justify-between text-[10px] text-muted-foreground">
				<span className="text-sky-400">CPU frame</span>
				<span className="text-amber-400">GPU timestamp</span>
				<span>
					0–{maximum.toFixed(2)} ms · {props.frames.length} displayed frames
				</span>
			</div>
		</div>
	);
}

export class EditorProfiler extends Component<IEditorProfilerProps, IEditorProfilerState> {
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;
	private _refreshActiveCapture = false;
	private _refreshPending = false;
	private _mounted = false;
	private _operationPending = false;
	private _captureQueryCache: { scene: object; key: string; result: any } | null = null;
	private _observedScene: object | null = null;

	public constructor(props: IEditorProfilerProps) {
		super(props);
		this.state = {
			name: "Gameplay Capture",
			target: "editor-play",
			connectionId: "",
			modules: [...modules],
			maximumFrames: 600,
			maximumDurationMs: 60_000,
			selectedCaptureId: null,
			selectedFrame: 0,
			frameOffset: 0,
			markerOffset: 0,
			assetOffset: 0,
			view: "timeline",
			search: "",
			snapshotName: "Memory Snapshot",
			baselineSnapshotId: "",
			currentSnapshotId: "",
			importPath: ".bjseditor/profiler/capture.json",
			busy: false,
			error: null,
		};
	}

	public componentDidMount(): void {
		this._mounted = true;
		this._refreshTimer = setInterval(() => {
			const scene = this.props.editor.layout.preview?.scene ?? null;
			if (scene !== this._observedScene) {
				this._observedScene = scene;
				this.forceUpdate();
				return;
			}
			void this._refreshActiveRun();
		}, 250);
	}

	public componentWillUnmount(): void {
		this._mounted = false;
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		this._refreshActiveCapture = false;
		this._refreshPending = false;
		this._observedScene = null;
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene) {
			return <div className="flex h-full items-center justify-center text-muted-foreground">Open a scene to profile it.</div>;
		}
		const state = getProfilerState(scene);
		this._refreshActiveCapture =
			this.state.view === "2d-atlas" || Boolean(state.active && (state.active.target !== "connected-player" || ["preparing", "recording"].includes(state.active.status)));
		const devices = listRemoteDevices().devices as any[];
		const selectedId =
			this.state.selectedCaptureId && state.captures.some((capture: any) => capture.id === this.state.selectedCaptureId)
				? this.state.selectedCaptureId
				: state.captures[0]?.id;
		const query = selectedId
			? {
					id: selectedId,
					view: this._markerView(),
					search: this.state.search,
					frameOffset: this.state.frameOffset,
					frameLimit: 1_000,
					markerOffset: this.state.markerOffset,
					markerLimit: 2_000,
					assetOffset: this.state.assetOffset,
					assetLimit: 2_000,
				}
			: null;
		const queryKey = query ? JSON.stringify({ revision: state.revision, ...query }) : "";
		const selected = query
			? this._captureQueryCache?.scene === scene && this._captureQueryCache.key === queryKey
				? this._captureQueryCache.result
				: getProfilerCapture(scene, query)
			: null;
		if (query && (!this._captureQueryCache || this._captureQueryCache.scene !== scene || this._captureQueryCache.key !== queryKey)) {
			this._captureQueryCache = { scene, key: queryKey, result: selected };
		}
		const frame = selected?.frames.entries[Math.max(0, Math.min(selected.frames.entries.length - 1, this.state.selectedFrame))] as IPortableProfilerFrame | undefined;
		const collectableRemote = state.active?.target === "connected-player" && ["completed", "canceled", "failed", "retrieving"].includes(state.active.status);
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2">
					<Input className="w-48" value={this.state.name} aria-label="Profiler capture name" onChange={(event) => this.setState({ name: event.currentTarget.value })} />
					<select
						className="h-9 rounded border border-border bg-background px-2 text-xs"
						value={this.state.target}
						onChange={(event) => this.setState({ target: event.currentTarget.value as IEditorProfilerState["target"] })}
					>
						<option value="editor-edit">Edit mode</option>
						<option value="editor-play">Play mode</option>
						<option value="connected-player">Connected player</option>
					</select>
					{this.state.target === "connected-player" && (
						<select
							className="h-9 max-w-52 rounded border border-border bg-background px-2 text-xs"
							value={this.state.connectionId}
							onChange={(event) => this.setState({ connectionId: event.currentTarget.value })}
						>
							<option value="">Select paired player</option>
							{devices.map((device) => (
								<option key={device.connectionId} value={device.connectionId}>
									{device.identity.name}
								</option>
							))}
						</select>
					)}
					<label className="flex items-center gap-1 text-xs">
						Frames{" "}
						<Input
							className="w-24"
							type="number"
							min={1}
							max={36_000}
							value={this.state.maximumFrames}
							onChange={(event) => this.setState({ maximumFrames: Number(event.currentTarget.value) })}
						/>
					</label>
					<label className="flex items-center gap-1 text-xs">
						Duration{" "}
						<Input
							className="w-28"
							type="number"
							min={100}
							max={3_600_000}
							value={this.state.maximumDurationMs}
							onChange={(event) => this.setState({ maximumDurationMs: Number(event.currentTarget.value) })}
						/>
					</label>
					{state.active ? (
						<>
							<Button size="sm" disabled={this.state.busy || state.active.status === "preparing"} onClick={() => void this._stop(false)}>
								{collectableRemote ? "Collect" : "Stop"}
							</Button>
							<Button size="sm" variant="destructive" disabled={this.state.busy} onClick={() => void this._stop(true)}>
								Cancel
							</Button>
							<span className="text-xs text-sky-400">
								{state.active.status} · {state.active.target}
							</span>
						</>
					) : (
						<Button
							size="sm"
							disabled={
								this.state.busy || !this.state.name.trim() || !this.state.modules.length || (this.state.target === "connected-player" && !this.state.connectionId)
							}
							onClick={() => void this._start()}
						>
							Record
						</Button>
					)}
					<div className="ml-auto flex flex-wrap gap-2 text-[11px]">
						{modules.map((module) => (
							<label key={module} className="flex items-center gap-1 capitalize">
								<input type="checkbox" checked={this.state.modules.includes(module)} disabled={Boolean(state.active)} onChange={() => this._toggleModule(module)} />
								{module}
							</label>
						))}
					</div>
				</div>
				{this.state.error && <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)]">
					<aside className="min-h-0 overflow-auto border-r border-border p-2">
						<div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Captures</div>
						{state.captures.map((capture: any) => (
							<button
								key={capture.id}
								className={`mb-1 w-full rounded p-2 text-left text-xs ${selectedId === capture.id ? "bg-secondary" : "hover:bg-input"}`}
								onClick={() => this.setState({ selectedCaptureId: capture.id, selectedFrame: 0, frameOffset: 0, markerOffset: 0, assetOffset: 0 })}
							>
								<div className="truncate font-medium">{capture.name}</div>
								<div className="text-muted-foreground">
									{capture.target} · {capture.frameCount} frames
								</div>
								<div className="text-muted-foreground">
									CPU {duration(capture.summary.metrics["cpu.frameTimeMs"]?.average)} · GPU {duration(capture.summary.metrics.gpuFrameTimeMs?.average)}
								</div>
							</button>
						))}
						{!state.captures.length && <div className="text-xs text-muted-foreground">No retained captures.</div>}
					</aside>
					<main className="flex min-h-0 min-w-0 flex-col">
						<div className="flex flex-wrap items-center gap-1 border-b border-border p-2">
							{(["timeline", "hierarchy", "inverted-hierarchy", "raw-hierarchy", "memory", "assets", "2d-atlas"] as const).map((view) => (
								<Button
									key={view}
									size="sm"
									variant={this.state.view === view ? "secondary" : "ghost"}
									onClick={() => this.setState({ view, markerOffset: 0, assetOffset: 0 })}
								>
									{view.replaceAll("-", " ")}
								</Button>
							))}
							<Input
								className="ml-auto w-48"
								placeholder="Filter markers/assets"
								value={this.state.search}
								onChange={(event) => this.setState({ search: event.currentTarget.value, markerOffset: 0, assetOffset: 0 })}
							/>
							<Input
								className="w-64"
								aria-label="Profiler JSON import path"
								placeholder=".bjseditor/profiler/capture.json"
								value={this.state.importPath}
								onChange={(event) => this.setState({ importPath: event.currentTarget.value })}
							/>
							<Button size="sm" variant="outline" disabled={this.state.busy || !this.state.importPath.trim()} onClick={() => void this._import()}>
								Import JSON
							</Button>
							<Button size="sm" variant="outline" disabled={!selectedId || this.state.busy} onClick={() => void this._export(selectedId)}>
								Export JSON
							</Button>
							<Button size="sm" variant="ghost" disabled={!selectedId || this.state.busy} onClick={() => void this._delete(selectedId)}>
								Delete
							</Button>
							<Button
								size="sm"
								variant="destructive"
								disabled={this.state.busy || Boolean(state.active) || (!state.captures.length && !state.memorySnapshots.length)}
								onClick={() => void this._clearAll()}
							>
								Clear All
							</Button>
						</div>
						<div className="min-h-0 flex-1 overflow-auto p-3">{this._renderSelected(selected, frame, state)}</div>
					</main>
				</div>
			</div>
		);
	}

	private _markerView(): "timeline" | "hierarchy" | "inverted-hierarchy" | "raw-hierarchy" {
		return ["hierarchy", "inverted-hierarchy", "raw-hierarchy"].includes(this.state.view) ? (this.state.view as any) : "timeline";
	}

	private _renderEvidencePager(page: any, label: string, kind: "markers" | "assets"): ReactNode {
		const pageSize = 2_000;
		const move = (offset: number): void => {
			if (kind === "markers") {
				this.setState({ markerOffset: offset });
			} else {
				this.setState({ assetOffset: offset });
			}
		};
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<span>
					{label} {page.total ? page.offset + 1 : 0}–{Math.min(page.total, page.offset + page.entries.length)} of {page.total}
				</span>
				<Button size="sm" variant="ghost" disabled={page.offset === 0} onClick={() => move(Math.max(0, page.offset - pageSize))}>
					Previous 2,000
				</Button>
				<Button size="sm" variant="ghost" disabled={page.offset + page.entries.length >= page.total} onClick={() => move(page.offset + page.entries.length)}>
					Next 2,000
				</Button>
			</div>
		);
	}

	private _renderSelected(result: any, frame: IPortableProfilerFrame | undefined, state: any): ReactNode {
		if (this.state.view === "2d-atlas") {
			return this._render2D(frame);
		}
		if (this.state.view === "memory") {
			return this._renderMemory(state, frame);
		}
		if (!result) {
			return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Record or select a capture.</div>;
		}
		if (this.state.view === "assets") {
			return (
				<div className="space-y-2 text-xs">
					{this._renderEvidencePager(result.assetEvents, "Asset events", "assets")}
					<div>
						{result.assetEvents.total} resource timing events · transfer {bytes(result.capture.summary.assetTransferBytes)}
					</div>
					{result.assetEvents.entries.map((entry: any) => (
						<div key={entry.id} className="grid grid-cols-[minmax(0,1fr)_100px_100px_90px] gap-2 rounded bg-input p-2">
							<span className="truncate" title={entry.name}>
								{entry.name}
							</span>
							<span>{entry.initiatorType}</span>
							<span>{duration(entry.durationMs)}</span>
							<span>{bytes(entry.transferBytes)}</span>
						</div>
					))}
					{!result.assetEvents.entries.length && (
						<div className="text-muted-foreground">No matching Resource Timing events. Cross-origin policies can hide byte counts.</div>
					)}
				</div>
			);
		}
		if (this.state.view === "hierarchy" || this.state.view === "inverted-hierarchy") {
			return (
				<div className="space-y-1 text-xs">
					{this._renderEvidencePager(result.markers, "Marker rows", "markers")}
					<div className="grid grid-cols-[minmax(0,1fr)_90px_90px_90px_70px] gap-2 px-2 text-muted-foreground">
						<span>Marker</span>
						<span>Total</span>
						<span>Self</span>
						<span>Average</span>
						<span>Calls</span>
					</div>
					{(result.markers.entries as IPortableProfilerMarkerSummary[]).map((marker) => (
						<div key={marker.key} className="grid grid-cols-[minmax(0,1fr)_90px_90px_90px_70px] gap-2 rounded bg-input p-2">
							<span className="truncate" style={{ paddingLeft: marker.depth * 12 }}>
								{marker.category} · {marker.name}
							</span>
							<span>{duration(marker.totalMs)}</span>
							<span>{duration(marker.selfMs)}</span>
							<span>{duration(marker.averageMs)}</span>
							<span>{marker.calls}</span>
						</div>
					))}
				</div>
			);
		}
		if (this.state.view === "raw-hierarchy") {
			return (
				<div className="space-y-1 text-xs">
					{this._renderEvidencePager(result.markers, "Markers", "markers")}
					{result.markers.entries.map((marker: any) => (
						<div key={marker.id} className="grid grid-cols-[80px_minmax(0,1fr)_100px_80px] gap-2 rounded bg-input p-2">
							<span>F{marker.frameIndex}</span>
							<span className="truncate" style={{ paddingLeft: marker.depth * 12 }}>
								{marker.category} · {marker.name}
							</span>
							<span>{duration(marker.durationMs)}</span>
							<span className={marker.error ? "text-destructive" : "text-muted-foreground"}>{marker.error ? "error" : "ok"}</span>
						</div>
					))}
				</div>
			);
		}
		return (
			<div className="space-y-3">
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<span>
						Frames {result.frames.total ? result.frames.offset + 1 : 0}–{Math.min(result.frames.total, result.frames.offset + result.frames.entries.length)} of{" "}
						{result.frames.total}
					</span>
					<Button
						size="sm"
						variant="ghost"
						disabled={result.frames.offset === 0}
						onClick={() => this.setState({ frameOffset: Math.max(0, result.frames.offset - 1_000), selectedFrame: 0 })}
					>
						Previous 1,000
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={result.frames.offset + result.frames.entries.length >= result.frames.total}
						onClick={() => this.setState({ frameOffset: result.frames.offset + result.frames.entries.length, selectedFrame: 0 })}
					>
						Next 1,000
					</Button>
				</div>
				<ProfilerTimeline frames={result.frames.entries} selected={this.state.selectedFrame} onSelect={(selectedFrame) => this.setState({ selectedFrame })} />
				{frame && (
					<div className="grid grid-cols-2 gap-3 text-xs lg:grid-cols-4">
						<div className="rounded bg-input p-3">
							<div className="font-medium text-sky-400">CPU</div>
							<div>Frame {duration(frame.cpu?.frameTimeMs)}</div>
							<div>Render {duration(frame.cpu?.renderTimeMs)}</div>
							<div>
								Scripts {duration(frame.cpu?.scriptTimeMs)} / {frame.cpu?.scriptCalls ?? 0} calls
							</div>
							<div>Physics {duration(frame.cpu?.physicsTimeMs)}</div>
						</div>
						<div className="rounded bg-input p-3">
							<div className="font-medium text-amber-400">GPU / Rendering</div>
							<div>GPU {duration(frame.gpuFrameTimeMs)}</div>
							<div>{frame.rendering?.drawCalls ?? 0} draw calls</div>
							<div>{frame.rendering?.triangles ?? 0} triangles</div>
							<div>{frame.rendering?.activeMeshes ?? 0} active meshes</div>
						</div>
						<div className="rounded bg-input p-3">
							<div className="font-medium text-emerald-400">Memory</div>
							<div>JS heap {bytes(frame.memory?.usedHeapBytes)}</div>
							<div>Geometry {bytes(frame.memory?.estimatedGeometryBytes)}</div>
							<div>Textures {bytes(frame.memory?.estimatedTextureBytes)}</div>
							<div>{frame.memory?.sceneObjectCount ?? 0} objects</div>
						</div>
						<div className="rounded bg-input p-3">
							<div className="font-medium text-violet-400">Loading / Audio</div>
							<div>{frame.assets?.completedRequests ?? 0} requests</div>
							<div>{bytes(frame.assets?.transferBytes)} transferred</div>
							<div>
								{frame.audio?.playingSoundCount ?? 0}/{frame.audio?.soundCount ?? 0} sounds playing
							</div>
						</div>
					</div>
				)}
				<div className="rounded border border-border p-2 text-xs text-muted-foreground">
					{result.capture.limitations.map((value: string) => (
						<div key={value}>• {value}</div>
					))}
				</div>
			</div>
		);
	}

	private _render2D(frame: IPortableProfilerFrame | undefined): ReactNode {
		const result = getProfiler2DState(this.props.editor.layout.preview.scene);
		if (!result.available) {
			return <div className="rounded border border-border p-3 text-xs text-muted-foreground">{result.limitations.join(" ")}</div>;
		}
		const snapshot = result.snapshot;
		const metrics = snapshot.metrics;
		const captured = frame?.twoD;
		return (
			<div className="space-y-3 text-xs" data-profiler-view="2d-atlas">
				<div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
					<div className="rounded bg-input p-3">
						<div className="font-medium text-emerald-400">Atlas owners</div>
						<div>{metrics.atlasOwners} live</div>
						<div className="text-muted-foreground">
							{metrics.spriteManagers} managers · {metrics.spriteMaps} maps
						</div>
					</div>
					<div className="rounded bg-input p-3">
						<div className="font-medium text-sky-400">Texture allocation</div>
						<div>{bytes(metrics.estimatedTextureBytes)}</div>
						<div className="text-muted-foreground">{metrics.uniqueTextures} unique textures</div>
					</div>
					<div className="rounded bg-input p-3">
						<div className="font-medium text-violet-400">Regions</div>
						<div>
							{metrics.usedRegions}/{metrics.definedRegions} used
						</div>
						<div className="text-muted-foreground">
							{metrics.definedRegionPixels ? ((metrics.usedRegionPixels / metrics.definedRegionPixels) * 100).toFixed(1) : "0.0"}% occupied
						</div>
					</div>
					<div className="rounded bg-input p-3">
						<div className="font-medium text-amber-400">Sprite usage</div>
						<div>
							{metrics.visibleSpriteCount}/{metrics.spriteCount} visible
						</div>
						<div className="text-muted-foreground">{metrics.tileCount} map tiles</div>
					</div>
					<div className="rounded bg-input p-3">
						<div className="font-medium text-rose-400">Estimated draws</div>
						<div>{metrics.estimatedDrawCalls}</div>
						<div className="text-muted-foreground">owner-level estimate</div>
					</div>
				</div>
				{captured && (
					<div className="rounded border border-border p-2 text-muted-foreground">
						Selected captured frame: {captured.usedRegions}/{captured.definedRegions} regions · {bytes(captured.estimatedTextureBytes)} · {captured.estimatedDrawCalls}{" "}
						estimated draws
					</div>
				)}
				<div className="grid gap-3 xl:grid-cols-2">{snapshot.atlases.map((atlas: IPortableProfiler2DAtlas) => this._render2DAtlas(atlas))}</div>
				{!snapshot.atlases.length && (
					<div className="flex h-40 items-center justify-center rounded border border-dashed border-border text-muted-foreground">
						No SpriteManager or SpriteMap atlas owner is active.
					</div>
				)}
				<div className="rounded border border-border p-2 text-muted-foreground">
					{snapshot.limitations.map((limitation: string) => (
						<div key={limitation}>• {limitation}</div>
					))}
				</div>
			</div>
		);
	}

	private _render2DAtlas(atlas: IPortableProfiler2DAtlas): ReactNode {
		const width = Math.max(1, atlas.textureWidth);
		const height = Math.max(1, atlas.textureHeight);
		return (
			<div key={atlas.id} className="space-y-2 rounded border border-border bg-background p-3">
				<div className="flex items-start gap-2">
					<div className="min-w-0 flex-1">
						<div className="truncate font-medium">{atlas.name}</div>
						<div className="truncate text-muted-foreground">
							{atlas.kind} · {atlas.textureName ?? "texture unavailable"}
						</div>
					</div>
					<div className="text-right text-muted-foreground">
						<div>
							{atlas.textureWidth}×{atlas.textureHeight}
						</div>
						<div>{bytes(atlas.estimatedTextureBytes)}</div>
					</div>
				</div>
				<div className="h-2 overflow-hidden rounded bg-muted" title={`${atlas.occupancyPercent.toFixed(1)}% atlas-region occupancy`}>
					<div className="h-full bg-emerald-500" style={{ width: `${atlas.occupancyPercent}%` }} />
				</div>
				<svg
					className="h-56 w-full rounded bg-black/50"
					viewBox={`0 0 ${width} ${height}`}
					preserveAspectRatio="xMidYMid meet"
					aria-label={`${atlas.name} texture atlas usage`}
				>
					<rect x="0" y="0" width={width} height={height} fill="#111827" />
					{atlas.regions.map((region) => (
						<rect
							key={region.id}
							x={region.x}
							y={region.y}
							width={region.width}
							height={region.height}
							fill={region.used ? "#10b981" : "#475569"}
							fillOpacity={region.used ? 0.75 : 0.28}
							stroke={region.used ? "#a7f3d0" : "#94a3b8"}
							strokeWidth={Math.max(0.5, Math.min(width, height) / 512)}
						>
							<title>
								{region.name} · {region.usageCount} uses · {region.width}×{region.height}
								{region.rotated ? " · rotated" : ""}
							</title>
						</rect>
					))}
				</svg>
				<div className="flex flex-wrap gap-x-3 text-muted-foreground">
					<span>
						{atlas.usedRegionCount}/{atlas.regionCount} regions used
					</span>
					<span>
						{atlas.visibleSpriteCount}/{atlas.spriteCount} sprites visible
					</span>
					<span>{atlas.tileCount} tiles</span>
					<span>{atlas.estimatedDrawCalls} estimated draws</span>
				</div>
				{atlas.warnings.map((warning) => (
					<div key={warning} className="text-amber-400">
						• {warning}
					</div>
				))}
			</div>
		);
	}

	private _renderMemory(state: any, frame: IPortableProfilerFrame | undefined): ReactNode {
		let comparison: any = null;
		if (this.state.baselineSnapshotId && this.state.currentSnapshotId) {
			try {
				comparison = compareProfilerSnapshots(this.props.editor.layout.preview.scene, {
					baseline: this.state.baselineSnapshotId,
					current: this.state.currentSnapshotId,
				}).comparison;
			} catch {
				comparison = null;
			}
		}
		return (
			<div className="space-y-3 text-xs">
				<div className="flex flex-wrap items-center gap-2">
					<Input className="w-52" value={this.state.snapshotName} onChange={(event) => this.setState({ snapshotName: event.currentTarget.value })} />
					<Button
						size="sm"
						disabled={this.state.busy || !this.state.snapshotName.trim() || (state.active?.target === "connected-player" && state.active.status !== "recording")}
						onClick={() => void this._snapshot(state.revision)}
					>
						Capture Snapshot
					</Button>
					<span className="text-muted-foreground">
						Selected frame heap {bytes(frame?.memory?.usedHeapBytes)} · scene estimate {bytes(frame?.memory?.estimatedSceneBytes)}
					</span>
				</div>
				<div className="grid grid-cols-2 gap-2">
					<select
						className="h-9 rounded border border-border bg-background px-2"
						value={this.state.baselineSnapshotId}
						onChange={(event) => this.setState({ baselineSnapshotId: event.currentTarget.value })}
					>
						<option value="">Baseline snapshot</option>
						{state.memorySnapshots.map((snapshot: any) => (
							<option key={snapshot.id} value={snapshot.id}>
								{snapshot.name}
							</option>
						))}
					</select>
					<select
						className="h-9 rounded border border-border bg-background px-2"
						value={this.state.currentSnapshotId}
						onChange={(event) => this.setState({ currentSnapshotId: event.currentTarget.value })}
					>
						<option value="">Current snapshot</option>
						{state.memorySnapshots.map((snapshot: any) => (
							<option key={snapshot.id} value={snapshot.id}>
								{snapshot.name}
							</option>
						))}
					</select>
				</div>
				{comparison && (
					<div className="rounded bg-input p-3">
						<div className="mb-2 font-medium">
							{comparison.baseline.name} → {comparison.current.name}
						</div>
						<div className="grid grid-cols-2 gap-1 lg:grid-cols-4">
							{Object.entries(comparison.metricDelta).map(([key, value]) => (
								<div key={key}>
									{key}: {key.toLowerCase().includes("bytes") ? bytes(value) : String(value ?? "unavailable")}
								</div>
							))}
						</div>
						<div className="mt-2 text-muted-foreground">Potential growth is evidence for investigation, not automatic proof of a leak.</div>
					</div>
				)}
				<div className="grid gap-2 lg:grid-cols-2">
					{state.memorySnapshots.map((snapshot: any) => (
						<div key={snapshot.id} className="rounded bg-input p-3">
							<div className="flex items-center gap-2">
								<div className="min-w-0 flex-1 truncate font-medium">{snapshot.name}</div>
								<Button size="sm" variant="ghost" disabled={this.state.busy} onClick={() => void this._deleteSnapshot(snapshot.id)}>
									Delete
								</Button>
							</div>
							<div>{snapshot.capturedAt}</div>
							<div>
								Heap {bytes(snapshot.metrics.usedHeapBytes)} · scene {bytes(snapshot.metrics.estimatedSceneBytes)}
							</div>
							<div>
								{snapshot.metrics.sceneObjectCount} objects · {snapshot.counts.meshes ?? 0} meshes · {snapshot.counts.textures ?? 0} textures
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	private _toggleModule(module: PortableProfilerModule): void {
		this.setState({ modules: this.state.modules.includes(module) ? this.state.modules.filter((candidate) => candidate !== module) : [...this.state.modules, module] });
	}

	/** Polls connected targets so remote auto-stop becomes a Collect state without rescanning retained capture evidence. */
	private async _refreshActiveRun(): Promise<void> {
		if (!this._refreshActiveCapture || this._refreshPending || this._operationPending) {
			return;
		}
		const scene = this.props.editor.layout.preview?.scene;
		const active = scene ? getProfilerState(scene).active : null;
		if (!scene) {
			return;
		}
		if (!active) {
			if (this.state.view === "2d-atlas") {
				this.forceUpdate();
			}
			return;
		}
		if (active.target !== "connected-player") {
			this.forceUpdate();
			return;
		}
		this._refreshPending = true;
		try {
			await getProfilerRunStatus(scene);
			if (this._mounted && !this._operationPending && getProfilerState(scene).active?.id === active.id) {
				this.forceUpdate();
			}
		} catch (error) {
			if (this._mounted && !this._operationPending && getProfilerState(scene).active?.id === active.id) {
				this.setState({ error: error instanceof Error ? error.message : String(error) });
			}
		} finally {
			this._refreshPending = false;
		}
	}

	private async _start(): Promise<void> {
		const scene = this.props.editor.layout.preview.scene;
		const state = getProfilerState(scene);
		this._operationPending = true;
		this.setState({ busy: true, error: null });
		try {
			await startProfilerCapture(
				scene,
				{
					expectedRevision: state.revision,
					name: this.state.name,
					target: this.state.target,
					connectionId: this.state.connectionId || undefined,
					modules: this.state.modules,
					maximumFrames: this.state.maximumFrames,
					maximumDurationMs: this.state.maximumDurationMs,
					confirm: this.state.target === "connected-player",
				},
				{ editor: this.props.editor }
			);
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this._operationPending = false;
			this.setState({ busy: false });
		}
	}

	private async _stop(cancel: boolean): Promise<void> {
		const scene = this.props.editor.layout.preview.scene;
		const state = getProfilerState(scene);
		this._operationPending = true;
		this.setState({ busy: true, error: null });
		try {
			await stopProfilerCapture(scene, { expectedRevision: state.revision, id: state.active?.id, cancel, confirm: true }, { editor: this.props.editor });
			this.setState({ selectedCaptureId: state.active?.id ?? null, selectedFrame: 0, frameOffset: 0, markerOffset: 0, assetOffset: 0 });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this._operationPending = false;
			this.setState({ busy: false });
		}
	}

	private async _snapshot(revision: number): Promise<void> {
		this._operationPending = true;
		this.setState({ busy: true, error: null });
		try {
			const profiler = getProfilerState(this.props.editor.layout.preview.scene);
			const result = await captureProfilerSnapshot(
				this.props.editor.layout.preview.scene,
				{ expectedRevision: revision, name: this.state.snapshotName, confirm: profiler.active?.target === "connected-player" },
				{ editor: this.props.editor }
			);
			this.setState({ currentSnapshotId: result.snapshot.id, error: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this._operationPending = false;
			this.setState({ busy: false });
		}
	}

	private async _export(id: string): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			await exportProfilerCapture(this.props.editor.layout.preview.scene, { id, confirm: true });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _import(): Promise<void> {
		const scene = this.props.editor.layout.preview.scene;
		this.setState({ busy: true, error: null });
		try {
			const state = getProfilerState(scene);
			const result = await importProfilerCapture(
				scene,
				{ expectedRevision: state.revision, path: this.state.importPath.trim(), confirm: true },
				{ editor: this.props.editor }
			);
			this.setState({ selectedCaptureId: result.id, selectedFrame: 0, frameOffset: 0, markerOffset: 0, assetOffset: 0 });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _delete(id: string): Promise<void> {
		if (!(await showConfirm("Delete Profiler Capture?", "Permanently remove this capture and its recorded evidence?", { confirmText: "Delete" }))) {
			return;
		}
		const scene = this.props.editor.layout.preview.scene;
		const state = getProfilerState(scene);
		try {
			deleteProfilerCapture(scene, { expectedRevision: state.revision, id, confirm: true }, { editor: this.props.editor });
			this.setState({ selectedCaptureId: null, selectedFrame: 0, frameOffset: 0, markerOffset: 0, assetOffset: 0, error: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _deleteSnapshot(id: string): Promise<void> {
		if (!(await showConfirm("Delete Profiler Memory Snapshot?", "Permanently remove this retained memory snapshot?", { confirmText: "Delete" }))) {
			return;
		}
		const scene = this.props.editor.layout.preview.scene;
		const state = getProfilerState(scene);
		try {
			deleteProfilerSnapshot(scene, { expectedRevision: state.revision, id, confirm: true }, { editor: this.props.editor });
			this.setState({
				baselineSnapshotId: this.state.baselineSnapshotId === id ? "" : this.state.baselineSnapshotId,
				currentSnapshotId: this.state.currentSnapshotId === id ? "" : this.state.currentSnapshotId,
				error: null,
			});
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _clearAll(): Promise<void> {
		if (!(await showConfirm("Clear All Profiler Evidence?", "Permanently remove every retained capture and memory snapshot?", { confirmText: "Clear All" }))) {
			return;
		}
		const scene = this.props.editor.layout.preview.scene;
		const state = getProfilerState(scene);
		try {
			clearProfilerData(scene, { expectedRevision: state.revision, confirm: true }, { editor: this.props.editor });
			this._captureQueryCache = null;
			this.setState({
				selectedCaptureId: null,
				baselineSnapshotId: "",
				currentSnapshotId: "",
				selectedFrame: 0,
				frameOffset: 0,
				markerOffset: 0,
				assetOffset: 0,
				error: null,
			});
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}
}
