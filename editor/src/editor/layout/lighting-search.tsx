import { Component, ReactNode } from "react";

import {
	deleteLightingSearchQuery,
	getLightingSearchLightmapPreview,
	ILightingSearchItem,
	inspectLightingSearch,
	LightingSearchPipeline,
	LightingSearchProvider,
	queryLightingSearch,
	saveLightingSearchQuery,
	setLightingSearchProperties,
} from "../../mcp/lights/lighting-search";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { Editor } from "../main";

interface IEditorLightingSearchProps {
	editor: Editor;
}

interface IEditorLightingSearchState {
	inspection: any | null;
	queryId: string | null;
	provider: LightingSearchProvider;
	pipeline: LightingSearchPipeline;
	search: string;
	result: any | null;
	selectedIds: string[];
	queryName: string;
	batchProperty: string;
	batchValue: string;
	preview: any | null;
	exposureEV: number;
	busy: boolean;
	error: string | null;
}

const providerLabels: Record<LightingSearchProvider, string> = {
	lights: "Lights",
	"mesh-renderers": "Mesh Renderers",
	lightmaps: "Lightmaps",
	"reflection-probes": "Reflection Probes",
	"probe-volumes": "Probe Volumes",
	materials: "Materials",
	"lighting-settings": "Lighting Settings",
};

const pipelineLabels: Record<LightingSearchPipeline, string> = {
	all: "All pipelines",
	"native-forward": "Native Forward",
	"clustered-forward": "Clustered Forward",
	"portable-deferred": "Portable Deferred",
	"baked-gi": "Baked GI",
};

export class EditorLightingSearch extends Component<IEditorLightingSearchProps, IEditorLightingSearchState> {
	private _sceneProbeTimer: ReturnType<typeof setInterval> | null = null;
	private _observedScene: object | null = null;

	public constructor(props: IEditorLightingSearchProps) {
		super(props);
		this.state = {
			inspection: null,
			queryId: "lights-all",
			provider: "lights",
			pipeline: "all",
			search: "",
			result: null,
			selectedIds: [],
			queryName: "",
			batchProperty: "",
			batchValue: "",
			preview: null,
			exposureEV: 0,
			busy: false,
			error: null,
		};
	}

	public componentDidMount(): void {
		this._syncScene();
		this._sceneProbeTimer = setInterval(() => this._syncScene(), 250);
	}

	public componentWillUnmount(): void {
		if (this._sceneProbeTimer) {
			clearInterval(this._sceneProbeTimer);
		}
		this._sceneProbeTimer = null;
		this._observedScene = null;
	}

	public render(): ReactNode {
		const rows = (this.state.result?.items ?? []) as ILightingSearchItem[];
		const columns = this._columns(rows);
		const selectedRows = rows.filter((row) => this.state.selectedIds.includes(row.id));
		const editable = selectedRows.length
			? selectedRows.reduce((values, row) => values.filter((value) => row.editableProperties.includes(value)), [...selectedRows[0].editableProperties])
			: [];
		const customQuery = this.state.inspection?.state?.customQueries?.find((query: any) => query.id === this.state.queryId);
		return (
			<div
				className="flex h-full min-h-0 bg-background text-foreground"
				data-testid="lighting-search-workspace"
				data-provider={this.state.result?.query?.provider ?? this.state.provider}
			>
				<aside className="flex w-60 shrink-0 flex-col border-r border-border" data-testid="lighting-search-query-tree">
					<div className="border-b border-border p-2 text-xs font-semibold">Lighting Queries</div>
					<div className="min-h-0 flex-1 overflow-auto p-1">
						{(this.state.inspection?.queryTree ?? []).map((node: any) => (
							<button
								key={node.id}
								type="button"
								disabled={node.kind === "folder"}
								className={`block w-full rounded px-2 py-1 text-left text-xs ${node.kind === "folder" ? "mt-2 font-semibold text-muted-foreground" : this.state.queryId === node.id ? "bg-secondary" : "hover:bg-input"}`}
								style={{ paddingLeft: node.parentId ? 20 : 8 }}
								onClick={() => void this._selectQuery(node)}
							>
								{node.name}
								{!node.builtIn && <span className="ml-1 text-[9px] text-sky-400">PROJECT</span>}
							</button>
						))}
					</div>
					<div className="grid gap-1 border-t border-border p-2">
						<Input
							className="h-7 text-xs"
							placeholder="Saved query name"
							value={this.state.queryName}
							onChange={(event) => this.setState({ queryName: event.currentTarget.value })}
						/>
						<div className="flex gap-1">
							<Button size="sm" className="h-7 flex-1" disabled={this.state.busy || !this.state.queryName.trim()} onClick={() => void this._saveQuery(customQuery)}>
								{customQuery ? "Update" : "Save query"}
							</Button>
							<Button size="sm" variant="outline" className="h-7" disabled={this.state.busy || !customQuery} onClick={() => void this._deleteQuery(customQuery)}>
								Delete
							</Button>
						</div>
					</div>
				</aside>
				<main className="flex min-w-0 flex-1 flex-col">
					<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2">
						<select
							className="h-8 rounded border border-border bg-background px-2 text-xs"
							value={this.state.provider}
							onChange={(event) =>
								this.setState(
									{ provider: event.currentTarget.value as LightingSearchProvider, queryId: null, selectedIds: [], preview: null },
									() => void this._runQuery()
								)
							}
						>
							{Object.entries(providerLabels).map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
						<select
							className="h-8 rounded border border-border bg-background px-2 text-xs"
							data-testid="lighting-search-pipeline-selector"
							value={this.state.pipeline}
							onChange={(event) => this.setState({ pipeline: event.currentTarget.value as LightingSearchPipeline, selectedIds: [] }, () => void this._runQuery())}
						>
							{Object.entries(pipelineLabels).map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
						<Input
							className="h-8 min-w-48 flex-1 text-xs"
							placeholder="Search names, types, and lighting properties"
							value={this.state.search}
							onChange={(event) => this.setState({ search: event.currentTarget.value })}
							onKeyDown={(event) => event.key === "Enter" && void this._runQuery()}
						/>
						<Button size="sm" className="h-8" disabled={this.state.busy} onClick={() => void this._runQuery()}>
							Search
						</Button>
						<Button size="sm" variant="outline" className="h-8" disabled={this.state.busy} onClick={() => void this.refresh()}>
							Refresh
						</Button>
						<span className="text-[10px] text-muted-foreground">
							{this.state.result ? `${this.state.result.total} result${this.state.result.total === 1 ? "" : "s"}` : "Loading"}
						</span>
					</div>
					{this.state.error && <div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{this.state.error}</div>}
					<div className="min-h-0 flex-1 overflow-auto" data-testid="lighting-search-table">
						<table className="min-w-full border-collapse text-xs">
							<thead className="sticky top-0 z-10 bg-background">
								<tr>
									<th className="w-8 border-b border-r border-border p-1">
										<input
											type="checkbox"
											checked={Boolean(rows.length) && rows.every((row) => this.state.selectedIds.includes(row.id))}
											onChange={(event) => this.setState({ selectedIds: event.currentTarget.checked ? rows.map((row) => row.id) : [] })}
										/>
									</th>
									{columns.map((column) => (
										<th key={column} className="whitespace-nowrap border-b border-r border-border px-2 py-1 text-left font-medium">
											{this._label(column)}
										</th>
									))}
									{this.state.result?.query?.provider === "lightmaps" && <th className="border-b border-border px-2 py-1 text-left">Preview</th>}
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr key={row.id} className={this.state.selectedIds.includes(row.id) ? "bg-secondary/50" : "hover:bg-input/50"}>
										<td className="border-b border-r border-border p-1 text-center">
											<input type="checkbox" checked={this.state.selectedIds.includes(row.id)} onChange={() => this._toggleSelected(row.id)} />
										</td>
										{columns.map((column) => (
											<td key={column} className="max-w-72 border-b border-r border-border px-2 py-1">
												{this._cell(row, column)}
											</td>
										))}
										{row.provider === "lightmaps" && (
											<td className="border-b border-border px-2 py-1">
												<Button size="sm" variant="outline" className="h-6" onClick={() => void this._preview(row)}>
													Open
												</Button>
											</td>
										)}
									</tr>
								))}
							</tbody>
						</table>
						{!rows.length && !this.state.busy && <div className="p-6 text-center text-muted-foreground">No lighting data matches the current query.</div>}
					</div>
					<div className="flex flex-wrap items-center gap-2 border-t border-border p-2 text-xs" data-testid="lighting-search-batch-edit">
						<span>{selectedRows.length} selected</span>
						<select
							className="h-7 rounded border border-border bg-background px-2"
							value={this.state.batchProperty}
							onChange={(event) => this.setState({ batchProperty: event.currentTarget.value })}
						>
							<option value="">Common editable property</option>
							{editable.map((property) => (
								<option key={property} value={property}>
									{this._label(property)}
								</option>
							))}
						</select>
						<Input
							className="h-7 min-w-40 flex-1 font-mono text-xs"
							placeholder="JSON value, for example true, 2, or [1,0.8,0.6]"
							value={this.state.batchValue}
							onChange={(event) => this.setState({ batchValue: event.currentTarget.value })}
						/>
						<Button
							size="sm"
							className="h-7"
							disabled={!selectedRows.length || !this.state.batchProperty || !this.state.batchValue || this.state.busy}
							onClick={() => void this._applyBatch(selectedRows)}
						>
							Apply to selected
						</Button>
					</div>
					{this.state.preview && (
						<section className="grid max-h-[46%] min-h-48 grid-cols-[minmax(240px,1fr)_280px] border-t border-border" data-testid="lighting-search-lightmap-preview">
							<div className="flex min-h-0 items-center justify-center overflow-auto bg-black/60 p-3">
								<img
									src={this.state.preview.previewUrl}
									className="max-h-full max-w-full object-contain"
									style={{ filter: `brightness(${this.state.preview.exposureMultiplier})` }}
								/>
							</div>
							<div className="overflow-auto p-3 text-xs">
								<div className="font-semibold">{this.state.preview.item.name}</div>
								<div className="mt-1 font-mono text-[10px] text-muted-foreground">{this.state.preview.projectRelativePath}</div>
								<label className="mt-3 grid gap-1">
									<span>Exposure: {this.state.exposureEV.toFixed(1)} EV</span>
									<input
										type="range"
										min={-16}
										max={16}
										step={0.25}
										value={this.state.exposureEV}
										onChange={(event) => void this._setExposure(Number(event.currentTarget.value))}
									/>
								</label>
								<div className="mt-3 grid grid-cols-2 gap-1 text-muted-foreground">
									<span>Dimensions</span>
									<span>
										{this.state.preview.item.properties.width} × {this.state.preview.item.properties.height}
									</span>
									<span>Format</span>
									<span>{this.state.preview.item.properties.format}</span>
									<span>Compression</span>
									<span>{this.state.preview.item.properties.compression}</span>
									<span>Bytes</span>
									<span>{Number(this.state.preview.bytes).toLocaleString()}</span>
									<span>SHA-256</span>
									<span className="truncate font-mono text-[9px]" title={this.state.preview.sha256}>
										{this.state.preview.sha256}
									</span>
								</div>
							</div>
						</section>
					)}
				</main>
			</div>
		);
	}

	public async refresh(): Promise<void> {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene || this.state.busy) {
			return;
		}
		try {
			const inspection = inspectLightingSearch(scene);
			this.setState({ inspection, error: null }, () => void this._runQuery());
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private _syncScene(): void {
		const scene = this.props.editor.layout.preview?.scene ?? null;
		if (scene !== this._observedScene) {
			this._observedScene = scene;
			if (scene) {
				void this.refresh();
			}
		}
	}

	public showPreview(preview: any): void {
		this.setState({ preview, exposureEV: preview.exposureEV ?? 0, error: null });
	}

	private async _runQuery(): Promise<void> {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			const result = queryLightingSearch(
				scene,
				this.state.queryId
					? { queryId: this.state.queryId, search: this.state.search, pipeline: this.state.pipeline, limit: 100 }
					: { provider: this.state.provider, search: this.state.search, pipeline: this.state.pipeline, limit: 100 },
				{ editor: this.props.editor }
			) as any;
			this.setState({
				result,
				provider: result.query.provider,
				selectedIds: this.state.selectedIds.filter((id) => result.items.some((item: any) => item.id === id)),
				busy: false,
			});
		} catch (error) {
			this.setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _selectQuery(node: any): Promise<void> {
		if (node.kind !== "query") {
			return;
		}
		this.setState(
			{ queryId: node.id, provider: node.provider, pipeline: node.pipeline, search: node.search, queryName: node.builtIn ? "" : node.name, selectedIds: [], preview: null },
			() => void this._runQuery()
		);
	}

	private async _saveQuery(current: any): Promise<void> {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene || !this.state.inspection || !this.state.result) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			const result = saveLightingSearchQuery(
				scene,
				{
					expectedRevision: this.state.inspection.state.revision,
					expectedFingerprint: this.state.inspection.fingerprint,
					id: current?.id,
					expectedQueryRevision: current?.revision,
					query: {
						name: this.state.queryName,
						parentId: this._providerFolder(this.state.result.query.provider),
						provider: this.state.result.query.provider,
						search: this.state.search,
						pipeline: this.state.pipeline,
						filters: this.state.result.query.filters,
						columns: this.state.result.columns,
					},
				},
				{ editor: this.props.editor }
			) as any;
			const inspection = inspectLightingSearch(scene);
			this.setState({ inspection, queryId: result.query.id, queryName: result.query.name, busy: false }, () => void this._runQuery());
		} catch (error) {
			this.setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _deleteQuery(current: any): Promise<void> {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene || !current || !this.state.inspection) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			deleteLightingSearchQuery(
				scene,
				{
					expectedRevision: this.state.inspection.state.revision,
					expectedFingerprint: this.state.inspection.fingerprint,
					id: current.id,
					expectedQueryRevision: current.revision,
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			const inspection = inspectLightingSearch(scene);
			this.setState(
				{ inspection, queryId: "lights-all", provider: "lights", pipeline: "all", search: "", queryName: "", selectedIds: [], busy: false },
				() => void this._runQuery()
			);
		} catch (error) {
			this.setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private _cell(row: ILightingSearchItem, column: string): ReactNode {
		const value = column === "name" ? row.name : column === "type" ? row.type : row.properties[column];
		if (!row.editableProperties.includes(column) || value === null || value === undefined) {
			return <span title={typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}>{this._display(value)}</span>;
		}
		if (typeof value === "boolean") {
			return <input type="checkbox" checked={value} onChange={(event) => void this._applyCell(row, column, event.currentTarget.checked)} />;
		}
		const serialized = typeof value === "object" ? JSON.stringify(value) : String(value);
		return (
			<input
				key={`${row.fingerprint}:${column}`}
				className="h-6 w-full min-w-20 rounded border border-transparent bg-transparent px-1 hover:border-border focus:border-border focus:bg-background"
				defaultValue={serialized}
				onBlur={(event) => {
					if (event.currentTarget.value === serialized) {
						return;
					}
					try {
						void this._applyCell(
							row,
							column,
							typeof value === "number" || typeof value === "object" ? JSON.parse(event.currentTarget.value) : event.currentTarget.value
						);
					} catch {
						this.setState({ error: `${this._label(column)} requires valid JSON compatible with its current value.` });
					}
				}}
			/>
		);
	}

	private async _applyCell(row: ILightingSearchItem, property: string, value: unknown): Promise<void> {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			setLightingSearchProperties(
				scene,
				{ operations: [{ provider: row.provider, id: row.id, expectedFingerprint: row.fingerprint, properties: { [property]: value } }] },
				{ editor: this.props.editor }
			);
			this.setState({ busy: false }, () => void this._runQuery());
		} catch (error) {
			this.setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _applyBatch(rows: ILightingSearchItem[]): Promise<void> {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene) {
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(this.state.batchValue);
		} catch {
			this.setState({ error: "Batch value must be valid JSON." });
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			setLightingSearchProperties(
				scene,
				{
					operations: rows.map((row) => ({
						provider: row.provider,
						id: row.id,
						expectedFingerprint: row.fingerprint,
						properties: { [this.state.batchProperty]: value },
					})),
				},
				{ editor: this.props.editor }
			);
			this.setState({ busy: false, batchValue: "" }, () => void this._runQuery());
		} catch (error) {
			this.setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _preview(row: ILightingSearchItem): Promise<void> {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			const preview = await getLightingSearchLightmapPreview(scene, { id: row.id, expectedFingerprint: row.fingerprint, exposureEV: this.state.exposureEV });
			this.setState({ preview, busy: false });
		} catch (error) {
			this.setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _setExposure(exposureEV: number): Promise<void> {
		const preview = this.state.preview;
		if (!preview) {
			return;
		}
		this.setState({ exposureEV, preview: { ...preview, exposureEV, exposureMultiplier: 2 ** exposureEV } });
	}

	private _toggleSelected(id: string): void {
		this.setState({ selectedIds: this.state.selectedIds.includes(id) ? this.state.selectedIds.filter((entry) => entry !== id) : [...this.state.selectedIds, id] });
	}

	private _columns(rows: ILightingSearchItem[]): string[] {
		const requested = (this.state.result?.columns ?? []) as string[];
		const fallback = rows[0] ? ["name", "type", ...Object.keys(rows[0].properties).slice(0, 6)] : ["name", "type"];
		return [...new Set((requested.length ? requested : fallback).filter((column) => column === "name" || column === "type" || rows.some((row) => column in row.properties)))];
	}

	private _display(value: unknown): string {
		if (value === null || value === undefined) {
			return "—";
		}
		if (typeof value === "boolean") {
			return value ? "Yes" : "No";
		}
		if (typeof value === "number") {
			return Number.isInteger(value) ? String(value) : Number(value.toFixed(4)).toString();
		}
		if (typeof value === "object") {
			return JSON.stringify(value);
		}
		return String(value);
	}

	private _label(value: string): string {
		return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
	}

	private _providerFolder(provider: LightingSearchProvider): string | null {
		return provider === "lights"
			? "lights"
			: provider === "mesh-renderers"
				? "renderers"
				: provider === "lightmaps"
					? "lightmaps"
					: provider === "reflection-probes" || provider === "probe-volumes"
						? "probes"
						: provider === "materials"
							? "materials"
							: "settings";
	}
}
