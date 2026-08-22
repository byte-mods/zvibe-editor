import { Component, ReactNode } from "react";

import { AbstractMesh, Camera, Observer, Scene } from "babylonjs";

import {
	bakeOcclusionCullingAction,
	cancelOcclusionCullingBake,
	clearOcclusionCullingBake,
	createOcclusionCullingArea,
	deleteOcclusionCullingArea,
	getOcclusionCulling,
	getOcclusionCullingChangedObservable,
	inspectOcclusionCullingBake,
	resetOcclusionCulling,
	setCameraOcclusionCulling,
	setOcclusionCullingMesh,
	setOcclusionCullingSettings,
	setOcclusionCullingVisualization,
	updateOcclusionCullingArea,
} from "../../mcp/rendering/occlusion-culling";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/shadcn/ui/tabs";
import { Editor } from "../main";

interface IEditorOcclusionCullingProps {
	editor: Editor;
}

interface ISettingsDraft {
	smallestOccluder: string;
	smallestHole: string;
	backfaceThreshold: string;
	cellSize: string;
	viewSamples: string;
	targetSamples: string;
	maximumCells: string;
	maximumRayTests: string;
	maximumRelationships: string;
}

interface IEditorOcclusionCullingState {
	tab: "object" | "bake" | "visualization";
	snapshot: any | null;
	plan: any | null;
	settingsDraft: ISettingsDraft | null;
	settingsDraftRevision: number;
	selectedAreaId: string | null;
	areaName: string;
	areaCenter: string;
	areaSize: string;
	areaIsViewVolume: boolean;
	areaEnabled: boolean;
	busy: boolean;
	error: string | null;
}

const settingLabels: Record<keyof ISettingsDraft, string> = {
	smallestOccluder: "Smallest Occluder",
	smallestHole: "Smallest Hole",
	backfaceThreshold: "Backface Threshold (%)",
	cellSize: "Cell Size",
	viewSamples: "View Samples",
	targetSamples: "Target Samples",
	maximumCells: "Maximum Cells",
	maximumRayTests: "Maximum Ray Tests",
	maximumRelationships: "Maximum Relationships",
};

const integerSettings = new Set<keyof ISettingsDraft>(["viewSamples", "targetSamples", "maximumCells", "maximumRayTests", "maximumRelationships"]);

function settingsDraft(settings: Record<keyof ISettingsDraft, number>): ISettingsDraft {
	return Object.fromEntries(Object.keys(settingLabels).map((key) => [key, String(settings[key as keyof ISettingsDraft])])) as unknown as ISettingsDraft;
}

function tupleText(value: readonly number[]): string {
	return value.join(", ");
}

function parseTuple(value: string, label: string, positive: boolean): [number, number, number] {
	const components = value.split(",").map((component) => Number(component.trim()));
	if (components.length !== 3 || components.some((component) => !Number.isFinite(component)) || (positive && components.some((component) => component <= 0))) {
		throw new Error(`${label} must contain exactly three ${positive ? "positive " : ""}numbers separated by commas.`);
	}
	return components as [number, number, number];
}

export class EditorOcclusionCulling extends Component<IEditorOcclusionCullingProps, IEditorOcclusionCullingState> {
	private _scene: Scene | null = null;
	private _observer: Observer<void> | null = null;
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;
	private _mounted = false;

	public state: IEditorOcclusionCullingState = {
		tab: "object",
		snapshot: null,
		plan: null,
		settingsDraft: null,
		settingsDraftRevision: -1,
		selectedAreaId: null,
		areaName: "New Occlusion Area",
		areaCenter: "0, 0, 0",
		areaSize: "1000, 1000, 1000",
		areaIsViewVolume: true,
		areaEnabled: true,
		busy: false,
		error: null,
	};

	public componentDidMount(): void {
		this._mounted = true;
		this._refreshTimer = setInterval(() => this._refresh(), 500);
		this._refresh();
	}

	public componentWillUnmount(): void {
		this._mounted = false;
		this._observer?.remove();
		this._observer = null;
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		this._refreshTimer = null;
	}

	public render(): ReactNode {
		const snapshot = this.state.snapshot;
		const configuration = snapshot?.configuration;
		const selected = this.props.editor.layout.inspector?.state.editedObject;
		const selectedMesh = selected instanceof AbstractMesh ? snapshot?.meshes?.items.find((item: any) => item.id === selected.id) : null;
		const selectedCamera = selected instanceof Camera ? snapshot?.cameras?.items.find((item: any) => item.id === selected.id) : null;
		const job = snapshot?.job;
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-occlusion-culling-workspace data-occlusion-culling-status={job?.status ?? "idle"}>
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2 text-xs">
					<label className="flex items-center gap-2 font-semibold">
						<input
							data-occlusion-enabled
							type="checkbox"
							checked={configuration?.enabled ?? true}
							disabled={!configuration || this.state.busy || job?.status === "running"}
							onChange={(event) => void this._setGlobalEnabled(event.currentTarget.checked)}
						/>
						Occlusion Culling
					</label>
					<span className="text-muted-foreground">
						{configuration ? `revision ${configuration.revision} · bake revision ${configuration.bakeRevision}` : "Waiting for scene"}
					</span>
					<span className="ml-auto text-muted-foreground">Static PVS bake + Babylon hardware queries</span>
				</div>
				{this.state.error && (
					<div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" data-occlusion-error>
						{this.state.error}
					</div>
				)}
				<Tabs
					value={this.state.tab}
					onValueChange={(value) => this.setState({ tab: value as IEditorOcclusionCullingState["tab"] })}
					className="flex min-h-0 flex-1 flex-col"
				>
					<TabsList className="m-2 mb-0 grid w-[420px] max-w-[calc(100%-1rem)] grid-cols-3">
						<TabsTrigger value="object" data-occlusion-tab="object">
							Object
						</TabsTrigger>
						<TabsTrigger value="bake" data-occlusion-tab="bake">
							Bake
						</TabsTrigger>
						<TabsTrigger value="visualization" data-occlusion-tab="visualization">
							Visualization
						</TabsTrigger>
					</TabsList>
					<TabsContent value="object" className="min-h-0 flex-1 overflow-auto p-3">
						{this._renderObject(selected, selectedMesh, selectedCamera, Boolean(job?.status === "running"))}
					</TabsContent>
					<TabsContent value="bake" className="min-h-0 flex-1 overflow-auto p-3">
						{this._renderBake(Boolean(job?.status === "running"))}
					</TabsContent>
					<TabsContent value="visualization" className="min-h-0 flex-1 overflow-auto p-3">
						{this._renderVisualization()}
					</TabsContent>
				</Tabs>
			</div>
		);
	}

	private _renderObject(selected: unknown, selectedMesh: any | null, selectedCamera: any | null, bakeRunning: boolean): ReactNode {
		const disabled = this.state.busy || bakeRunning;
		if (selectedMesh) {
			const value = selectedMesh.settings;
			return (
				<div className="grid max-w-3xl gap-3 text-xs" data-occlusion-object-type="mesh" data-occlusion-object-id={selectedMesh.id}>
					<div>
						<div className="text-base font-semibold">{selectedMesh.name}</div>
						<div className="text-muted-foreground">
							{selectedMesh.className} · object revision {value.revision}
						</div>
					</div>
					<section className="grid gap-2 rounded border border-border p-3">
						<label className="flex items-center gap-2">
							<input
								data-occlusion-static-occluder
								type="checkbox"
								checked={value.staticOccluder}
								disabled={disabled}
								onChange={(event) => void this._setMesh({ staticOccluder: event.currentTarget.checked })}
							/>
							Static Occluder
						</label>
						<label className="flex items-center gap-2">
							<input
								data-occlusion-static-occludee
								type="checkbox"
								checked={value.staticOccludee}
								disabled={disabled}
								onChange={(event) => void this._setMesh({ staticOccludee: event.currentTarget.checked })}
							/>
							Static Occludee
						</label>
						<label className="flex items-center gap-2">
							<input
								data-occlusion-dynamic
								type="checkbox"
								checked={value.dynamicOcclusion}
								disabled={disabled}
								onChange={(event) => void this._setMesh({ dynamicOcclusion: event.currentTarget.checked })}
							/>
							Dynamic Occlusion Query
						</label>
						<div className="grid grid-cols-2 gap-2">
							<label className="grid gap-1">
								<span className="text-muted-foreground">Query Mode</span>
								<select
									className="h-8 rounded border border-border bg-background px-2"
									value={value.queryMode}
									disabled={disabled}
									onChange={(event) => void this._setMesh({ queryMode: event.currentTarget.value })}
								>
									<option value="optimistic">Optimistic</option>
									<option value="strict">Strict</option>
								</select>
							</label>
							<label className="grid gap-1">
								<span className="text-muted-foreground">Retry Count</span>
								<Input
									data-occlusion-query-retries
									type="number"
									min={0}
									max={1000}
									value={value.queryRetryCount}
									disabled={disabled}
									onChange={(event) => void this._setMesh({ queryRetryCount: Number(event.currentTarget.value) })}
								/>
							</label>
						</div>
						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={value.forceRenderingWhenOccluded}
								disabled={disabled}
								onChange={(event) => void this._setMesh({ forceRenderingWhenOccluded: event.currentTarget.checked })}
							/>
							Force Rendering While Query Is Occluded
						</label>
					</section>
					<p className="text-muted-foreground">
						Static Occluders must be enabled opaque triangle meshes. Dynamic meshes can be hardware-query occludees but never contribute to the static bake.
					</p>
				</div>
			);
		}
		if (selectedCamera) {
			return (
				<div className="grid max-w-3xl gap-3 text-xs" data-occlusion-object-type="camera" data-occlusion-object-id={selectedCamera.id}>
					<div>
						<div className="text-base font-semibold">{selectedCamera.name}</div>
						<div className="text-muted-foreground">
							{selectedCamera.className} · object revision {selectedCamera.settings.revision}
						</div>
					</div>
					<label className="flex items-center gap-2 rounded border border-border p-3">
						<input
							data-occlusion-camera-enabled
							type="checkbox"
							checked={selectedCamera.settings.enabled}
							disabled={disabled}
							onChange={(event) => void this._setCamera(event.currentTarget.checked)}
						/>
						Use baked Occlusion Culling for this camera
					</label>
				</div>
			);
		}
		return (
			<div className="grid place-items-center p-8 text-center text-xs text-muted-foreground" data-occlusion-object-type="none">
				<div>
					<div className="mb-1 font-semibold text-foreground">Select a mesh or camera</div>
					{selected ? "The selected object does not expose Occlusion Culling authoring." : "Choose an object in the Graph to author its occlusion role."}
				</div>
			</div>
		);
	}

	private _renderBake(bakeRunning: boolean): ReactNode {
		const snapshot = this.state.snapshot;
		const configuration = snapshot?.configuration;
		const draft = this.state.settingsDraft;
		const selectedArea = configuration?.areas.find((area: any) => area.id === this.state.selectedAreaId) ?? null;
		const job = snapshot?.job;
		if (!configuration || !draft) {
			return <div className="text-xs text-muted-foreground">Waiting for a loaded scene.</div>;
		}
		return (
			<div className="grid gap-3 text-xs" data-occlusion-bake>
				<div className="grid gap-3 xl:grid-cols-2">
					<section className="grid gap-2 rounded border border-border p-3">
						<div className="font-semibold">Bake Settings</div>
						<div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
							{(Object.keys(settingLabels) as (keyof ISettingsDraft)[]).map((key) => (
								<label key={key} className="grid gap-1">
									<span className="text-muted-foreground">{settingLabels[key]}</span>
									<Input
										data-occlusion-setting={key}
										type="number"
										value={draft[key]}
										disabled={bakeRunning}
										onChange={(event) => this.setState({ settingsDraft: { ...draft, [key]: event.currentTarget.value } })}
									/>
								</label>
							))}
						</div>
						<Button data-occlusion-apply-settings size="sm" className="w-fit" disabled={this.state.busy || bakeRunning} onClick={() => void this._applySettings()}>
							Apply Settings
						</Button>
					</section>
					<section className="grid gap-2 rounded border border-border p-3">
						<div className="flex items-center justify-between">
							<span className="font-semibold">Occlusion Areas / View Volumes</span>
							<Button size="sm" variant="outline" disabled={bakeRunning} onClick={() => this._newArea()}>
								New
							</Button>
						</div>
						<div className="max-h-32 overflow-auto rounded border border-border">
							{configuration.areas.map((area: any) => (
								<button
									type="button"
									key={area.id}
									data-occlusion-area={area.id}
									className={`block w-full border-b border-border px-2 py-1 text-left ${area.id === selectedArea?.id ? "bg-secondary" : "hover:bg-input"}`}
									onClick={() => this._selectArea(area)}
								>
									{area.name} · rev {area.revision}
									{area.isViewVolume ? " · View Volume" : ""}
									{!area.enabled ? " · Disabled" : ""}
								</button>
							))}
							{!configuration.areas.length && <div className="p-2 text-muted-foreground">No area: the bake will derive one conservative scene volume.</div>}
						</div>
						<label className="grid gap-1">
							<span className="text-muted-foreground">Name</span>
							<Input
								data-occlusion-area-name
								value={this.state.areaName}
								disabled={bakeRunning}
								onChange={(event) => this.setState({ areaName: event.currentTarget.value })}
							/>
						</label>
						<div className="grid grid-cols-2 gap-2">
							<label className="grid gap-1">
								<span className="text-muted-foreground">Center (x, y, z)</span>
								<Input
									data-occlusion-area-center
									value={this.state.areaCenter}
									disabled={bakeRunning}
									onChange={(event) => this.setState({ areaCenter: event.currentTarget.value })}
								/>
							</label>
							<label className="grid gap-1">
								<span className="text-muted-foreground">Size (x, y, z)</span>
								<Input
									data-occlusion-area-size
									value={this.state.areaSize}
									disabled={bakeRunning}
									onChange={(event) => this.setState({ areaSize: event.currentTarget.value })}
								/>
							</label>
						</div>
						<div className="flex flex-wrap gap-4">
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={this.state.areaIsViewVolume}
									disabled={bakeRunning}
									onChange={(event) => this.setState({ areaIsViewVolume: event.currentTarget.checked })}
								/>
								View Volume
							</label>
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={this.state.areaEnabled}
									disabled={bakeRunning}
									onChange={(event) => this.setState({ areaEnabled: event.currentTarget.checked })}
								/>
								Enabled
							</label>
						</div>
						<div className="flex gap-2">
							<Button
								data-occlusion-save-area
								size="sm"
								disabled={this.state.busy || bakeRunning || !this.state.areaName.trim()}
								onClick={() => void this._saveArea()}
							>
								{selectedArea ? "Update Area" : "Create Area"}
							</Button>
							<Button
								data-occlusion-delete-area
								size="sm"
								variant="destructive"
								disabled={this.state.busy || bakeRunning || !selectedArea}
								onClick={() => void this._deleteArea()}
							>
								Delete
							</Button>
						</div>
					</section>
				</div>
				<section className="grid gap-2 rounded border border-border p-3">
					<div className="flex flex-wrap items-center gap-2">
						<Button data-occlusion-inspect-bake size="sm" variant="outline" disabled={this.state.busy || bakeRunning} onClick={() => void this._inspectBake()}>
							Inspect Bake
						</Button>
						<Button data-occlusion-start-bake size="sm" disabled={this.state.busy || bakeRunning} onClick={() => void this._bake()}>
							Bake
						</Button>
						<Button data-occlusion-cancel-bake size="sm" variant="outline" disabled={!bakeRunning} onClick={() => void this._cancelBake()}>
							Cancel
						</Button>
						<Button
							data-occlusion-clear-bake
							size="sm"
							variant="destructive"
							disabled={this.state.busy || bakeRunning || !configuration.bake}
							onClick={() => void this._clearBake()}
						>
							Clear Bake
						</Button>
						<Button data-occlusion-reset size="sm" variant="destructive" disabled={this.state.busy || bakeRunning} onClick={() => void this._reset()}>
							Reset All
						</Button>
					</div>
					{this.state.plan && (
						<div data-occlusion-plan className="rounded bg-input p-2">
							{this.state.plan.cells.length} cells · {this.state.plan.occluderMeshIds.length} occluders · {this.state.plan.occludeeMeshIds.length} occludees · up to{" "}
							{this.state.plan.estimatedRayTests} rays · source {this.state.plan.sourceFingerprint.slice(0, 12)}…
						</div>
					)}
					{job && (
						<div data-occlusion-job={job.id} className="rounded bg-input p-2">
							{job.status} · {job.progress.completedCells}/{job.progress.totalCells} cells · {job.progress.rayTests} rays · {job.progress.message}
							{job.error ? ` · ${job.error}` : ""}
						</div>
					)}
					{configuration.bake && (
						<div data-occlusion-bake-fingerprint={configuration.bake.bakeFingerprint} className="grid gap-1 rounded bg-emerald-500/10 p-2 text-emerald-200">
							<div>
								{configuration.bake.statistics.cellCount} cells · {configuration.bake.statistics.occludedRelationships} occluded relationships ·{" "}
								{configuration.bake.statistics.rayTests} rays
							</div>
							<div className="break-all font-mono text-[10px]">{configuration.bake.bakeFingerprint}</div>
							{snapshot.bakeStatus.stale && <div className="text-amber-400">Bake is stale and runtime will fail open.</div>}
						</div>
					)}
				</section>
			</div>
		);
	}

	private _renderVisualization(): ReactNode {
		const snapshot = this.state.snapshot;
		const visualization = snapshot?.visualization;
		const bake = snapshot?.configuration?.bake;
		const selected = bake?.cells.find((cell: any) => cell.id === visualization?.selectedCellId) ?? null;
		if (!snapshot || !visualization) {
			return <div className="text-xs text-muted-foreground">Waiting for a loaded scene.</div>;
		}
		return (
			<div className="grid gap-3 text-xs" data-occlusion-visualization>
				<section className="flex flex-wrap gap-4 rounded border border-border p-3">
					<label className="flex items-center gap-2">
						<input
							data-occlusion-visualization-enabled
							type="checkbox"
							checked={visualization.enabled}
							onChange={(event) => void this._setVisualization({ enabled: event.currentTarget.checked })}
						/>
						Enable Scene Visualization
					</label>
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={visualization.showCells} onChange={(event) => void this._setVisualization({ showCells: event.currentTarget.checked })} />
						Cells
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={visualization.showVisible}
							onChange={(event) => void this._setVisualization({ showVisible: event.currentTarget.checked })}
						/>
						Visible Sets
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={visualization.showOccluded}
							onChange={(event) => void this._setVisualization({ showOccluded: event.currentTarget.checked })}
						/>
						Occluded Sets
					</label>
					<span className="ml-auto text-muted-foreground">{visualization.lineCount} debug lines</span>
				</section>
				<div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(240px,35%)_1fr]">
					<section className="max-h-[420px] overflow-auto rounded border border-border">
						{bake?.cells.map((cell: any) => (
							<button
								type="button"
								key={cell.id}
								data-occlusion-cell={cell.id}
								className={`block w-full border-b border-border p-2 text-left ${cell.id === selected?.id ? "bg-secondary" : "hover:bg-input"}`}
								onClick={() => void this._setVisualization({ selectedCellId: cell.id })}
							>
								<div className="font-mono">{cell.id}</div>
								<div className={cell.valid ? "text-muted-foreground" : "text-destructive"}>
									{cell.valid ? "valid" : "invalid/fail-open"} · {cell.visibleMeshIds.length} visible · {cell.occludedMeshIds.length} occluded
								</div>
							</button>
						))}
						{!bake && <div className="p-3 text-muted-foreground">Bake Occlusion Culling data to inspect cells and PVS relationships.</div>}
					</section>
					<section className="grid content-start gap-3 rounded border border-border p-3">
						{selected ? (
							<>
								<div className="font-semibold">Selected Cell</div>
								<div className="font-mono">{selected.id}</div>
								<div>
									Area {selected.areaId} · backfaces {selected.backfacePercent.toFixed(2)}% · {selected.rayTests} rays
								</div>
								<div>
									<span className="font-semibold text-emerald-300">Visible:</span> {selected.visibleMeshIds.join(", ") || "none"}
								</div>
								<div>
									<span className="font-semibold text-red-300">Occluded:</span> {selected.occludedMeshIds.join(", ") || "none"}
								</div>
							</>
						) : (
							<div className="text-muted-foreground">Select a baked cell to inspect its exact visible and occluded mesh sets.</div>
						)}
						<div className="mt-2 border-t border-border pt-3 font-semibold">Runtime Cameras</div>
						{snapshot.runtime.cameras.map((runtime: any) => (
							<div key={`${runtime.configurationIndex}:${runtime.cameraId}`} data-occlusion-runtime-camera={runtime.cameraId} className="rounded bg-input p-2">
								<div>
									{runtime.cameraName} · {runtime.activeCellId && !runtime.staleReason ? "applied" : "fail-open"}
								</div>
								<div className="text-muted-foreground">
									cell {runtime.activeCellId ?? "outside bake"} · {runtime.bakedCulledMeshIds.length} culled
									{runtime.staleReason ? ` · ${runtime.staleReason}` : ""}
								</div>
							</div>
						))}
						{!snapshot.runtime.cameras.length && <div className="text-muted-foreground">Render a configured camera to collect per-camera evidence.</div>}
					</section>
				</div>
			</div>
		);
	}

	private _currentScene(): Scene | null {
		return this.props.editor.layout.preview?.scene ?? null;
	}

	private _attach(scene: Scene): void {
		if (scene === this._scene) {
			return;
		}
		this._observer?.remove();
		this._observer = null;
		this._scene = scene;
		this._observer = getOcclusionCullingChangedObservable(scene).add(() => this._refresh());
	}

	private _refresh(): void {
		const scene = this._currentScene();
		if (!scene || !this._mounted) {
			return;
		}
		this._attach(scene);
		try {
			const selected = this.props.editor.layout.inspector?.state.editedObject;
			const selectedMeshIndex = selected instanceof AbstractMesh ? scene.meshes.indexOf(selected) : -1;
			const selectedCameraIndex = selected instanceof Camera ? scene.cameras.indexOf(selected) : -1;
			const snapshot = getOcclusionCulling(scene, {
				offset: Math.max(0, selectedMeshIndex),
				limit: selectedMeshIndex >= 0 ? 1 : 100,
				cameraOffset: Math.max(0, selectedCameraIndex),
				cameraLimit: selectedCameraIndex >= 0 ? 1 : 100,
			});
			const next: Partial<IEditorOcclusionCullingState> = { snapshot };
			if (!this.state.settingsDraft || this.state.settingsDraftRevision !== snapshot.configuration.revision) {
				next.settingsDraft = settingsDraft(snapshot.configuration.settings);
				next.settingsDraftRevision = snapshot.configuration.revision;
			}
			if (this.state.selectedAreaId && !snapshot.configuration.areas.some((area: any) => area.id === this.state.selectedAreaId)) {
				next.selectedAreaId = null;
			}
			this.setState(next as Pick<IEditorOcclusionCullingState, keyof IEditorOcclusionCullingState>);
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _run(action: (scene: Scene) => unknown | Promise<unknown>): Promise<void> {
		const scene = this._currentScene();
		if (!scene) {
			this.setState({ error: "No editor scene is loaded." });
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			await action(scene);
			this._refresh();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (this._mounted) {
				this.setState({ busy: false });
			}
		}
	}

	private async _setGlobalEnabled(enabled: boolean): Promise<void> {
		await this._run((scene) => {
			const current = getOcclusionCulling(scene);
			return setOcclusionCullingSettings(scene, { expectedRevision: current.configuration.revision, enabled }, { editor: this.props.editor });
		});
	}

	private async _setMesh(settings: Record<string, unknown>): Promise<void> {
		await this._run((scene) => {
			const selected = this.props.editor.layout.inspector?.state.editedObject;
			if (!(selected instanceof AbstractMesh)) {
				throw new Error("Select a mesh before editing its Occlusion Culling role.");
			}
			const selectedIndex = scene.meshes.indexOf(selected);
			if (selectedIndex < 0) {
				throw new Error(`Selected mesh "${selected.id}" is not attached to the current scene.`);
			}
			const current = getOcclusionCulling(scene, { offset: selectedIndex, limit: 1 });
			const mesh = current.meshes.items.find((item: any) => item.id === selected.id);
			if (!mesh) {
				throw new Error(`Selected mesh "${selected.id}" could not be read from its bounded authoring page.`);
			}
			return setOcclusionCullingMesh(
				scene,
				{ meshId: selected.id, expectedRevision: current.configuration.revision, expectedObjectRevision: mesh.settings.revision, settings },
				{ editor: this.props.editor }
			);
		});
	}

	private async _setCamera(enabled: boolean): Promise<void> {
		await this._run((scene) => {
			const selected = this.props.editor.layout.inspector?.state.editedObject;
			if (!(selected instanceof Camera)) {
				throw new Error("Select a camera before editing Occlusion Culling.");
			}
			const selectedIndex = scene.cameras.indexOf(selected);
			if (selectedIndex < 0) {
				throw new Error(`Selected camera "${selected.id}" is not attached to the current scene.`);
			}
			const current = getOcclusionCulling(scene, { cameraOffset: selectedIndex, cameraLimit: 1 });
			const camera = current.cameras.items.find((item: any) => item.id === selected.id);
			if (!camera) {
				throw new Error(`Selected camera "${selected.id}" could not be read from its bounded authoring page.`);
			}
			return setCameraOcclusionCulling(
				scene,
				{ cameraId: selected.id, expectedRevision: current.configuration.revision, expectedObjectRevision: camera.settings.revision, enabled },
				{ editor: this.props.editor }
			);
		});
	}

	private async _applySettings(): Promise<void> {
		await this._run((scene) => {
			if (!this.state.settingsDraft) {
				throw new Error("Occlusion Culling settings are not loaded.");
			}
			const current = getOcclusionCulling(scene);
			const values = Object.fromEntries(
				(Object.keys(settingLabels) as (keyof ISettingsDraft)[]).map((key) => {
					const value = Number(this.state.settingsDraft![key]);
					if (!Number.isFinite(value) || (integerSettings.has(key) && !Number.isSafeInteger(value))) {
						throw new Error(`${settingLabels[key]} must be ${integerSettings.has(key) ? "an integer" : "a finite number"}.`);
					}
					return [key, value];
				})
			);
			return setOcclusionCullingSettings(scene, { expectedRevision: current.configuration.revision, settings: values }, { editor: this.props.editor });
		});
	}

	private _newArea(): void {
		this.setState({ selectedAreaId: null, areaName: "New Occlusion Area", areaCenter: "0, 0, 0", areaSize: "1000, 1000, 1000", areaIsViewVolume: true, areaEnabled: true });
	}

	private _selectArea(area: any): void {
		this.setState({
			selectedAreaId: area.id,
			areaName: area.name,
			areaCenter: tupleText(area.center),
			areaSize: tupleText(area.size),
			areaIsViewVolume: area.isViewVolume,
			areaEnabled: area.enabled,
		});
	}

	private async _saveArea(): Promise<void> {
		await this._run((scene) => {
			const current = getOcclusionCulling(scene);
			const center = parseTuple(this.state.areaCenter, "Occlusion Area center", false);
			const size = parseTuple(this.state.areaSize, "Occlusion Area size", true);
			const area = current.configuration.areas.find((candidate: any) => candidate.id === this.state.selectedAreaId);
			if (area) {
				return updateOcclusionCullingArea(
					scene,
					{
						areaId: area.id,
						expectedRevision: current.configuration.revision,
						expectedObjectRevision: area.revision,
						patch: { name: this.state.areaName, center, size, isViewVolume: this.state.areaIsViewVolume, enabled: this.state.areaEnabled },
					},
					{ editor: this.props.editor }
				);
			}
			const created = createOcclusionCullingArea(
				scene,
				{
					expectedRevision: current.configuration.revision,
					name: this.state.areaName,
					center,
					size,
					isViewVolume: this.state.areaIsViewVolume,
					enabled: this.state.areaEnabled,
				},
				{ editor: this.props.editor }
			);
			this.setState({ selectedAreaId: created.area.id });
			return created;
		});
	}

	private async _deleteArea(): Promise<void> {
		await this._run((scene) => {
			const current = getOcclusionCulling(scene);
			const area = current.configuration.areas.find((candidate: any) => candidate.id === this.state.selectedAreaId);
			if (!area) {
				throw new Error("Select an Occlusion Area to delete.");
			}
			const result = deleteOcclusionCullingArea(
				scene,
				{ areaId: area.id, expectedRevision: current.configuration.revision, expectedObjectRevision: area.revision, confirm: true },
				{ editor: this.props.editor }
			);
			this._newArea();
			return result;
		});
	}

	private async _inspectBake(): Promise<void> {
		await this._run(async (scene) => {
			const current = getOcclusionCulling(scene);
			const plan = await inspectOcclusionCullingBake(scene, { expectedRevision: current.configuration.revision });
			this.setState({ plan });
		});
	}

	private async _bake(): Promise<void> {
		await this._run(async (scene) => {
			const current = getOcclusionCulling(scene);
			const plan = await inspectOcclusionCullingBake(scene, { expectedRevision: current.configuration.revision });
			this.setState({ plan });
			return bakeOcclusionCullingAction(
				scene,
				{ expectedRevision: current.configuration.revision, expectedSourceFingerprint: plan.sourceFingerprint },
				{ editor: this.props.editor }
			);
		});
	}

	private async _cancelBake(): Promise<void> {
		const scene = this._currentScene();
		if (!scene) {
			return;
		}
		try {
			const current = getOcclusionCulling(scene);
			if (!current.job) {
				throw new Error("No Occlusion Culling bake is running.");
			}
			cancelOcclusionCullingBake(scene, { id: current.job.id, expectedJobRevision: current.job.revision });
			this._refresh();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _clearBake(): Promise<void> {
		await this._run((scene) => {
			const current = getOcclusionCulling(scene);
			if (!current.configuration.bake) {
				throw new Error("No Occlusion Culling bake data exists.");
			}
			return clearOcclusionCullingBake(
				scene,
				{ expectedRevision: current.configuration.revision, expectedBakeFingerprint: current.configuration.bake.bakeFingerprint, confirm: true },
				{ editor: this.props.editor }
			);
		});
	}

	private async _setVisualization(patch: Record<string, unknown>): Promise<void> {
		await this._run((scene) => setOcclusionCullingVisualization(scene, patch));
	}

	private async _reset(): Promise<void> {
		await this._run((scene) => {
			const current = getOcclusionCulling(scene);
			const result = resetOcclusionCulling(scene, { expectedRevision: current.configuration.revision, confirm: true }, { editor: this.props.editor });
			this._newArea();
			this.setState({ plan: null });
			return result;
		});
	}
}
