import { Component, ReactNode } from "react";

import { Observer, Scene } from "babylonjs";
import { GenerativeAssetModality, generativeMaterialMapRoles, IGenerativeAssetProviderManifest, normalizeGenerativeAssetRequest } from "babylonjs-editor-tools";

import {
	cancelGenerativeAssetJob,
	deleteGenerativeAssetJob,
	deleteGenerativeAssetProviderAction,
	getGenerativeAssetPreview,
	getGenerativeAssetsChangedObservable,
	IGenerativeAssetJobSnapshot,
	inspectGenerativeAssetPublicationAction,
	listGenerativeAssetJobs,
	listGenerativeAssetProvidersAction,
	publishGenerativeAssetCandidateAction,
	retryGenerativeAssetJob,
	setGenerativeAssetProviderAction,
	startGenerativeAssetJob,
} from "../../mcp/ai/generative-assets";
import { IGenerativeAssetProviderDescriptor, IGenerativeAssetProviderInventory } from "../../mcp/ai/generative-providers";
import { IGenerativeAssetPublicationPlan } from "../../mcp/ai/generative-publication";
import { IProjectConfiguration, onProjectConfigurationChangedObservable } from "../../project/configuration";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/shadcn/ui/tabs";
import { Editor } from "../main";

interface IEditorGenerativeAssetsProps {
	editor: Editor;
}

interface IGenerativePreview {
	available: boolean;
	jobId: string;
	candidateId: string;
	mediaType?: string;
	sha256?: string;
	sizeBytes?: number;
	dataBase64?: string;
	reason?: string;
}

interface IEditorGenerativeAssetsState {
	tab: "generate" | "providers" | "results";
	inventory: IGenerativeAssetProviderInventory | null;
	jobs: IGenerativeAssetJobSnapshot[];
	selectedProviderId: string | null;
	selectedJobId: string | null;
	selectedCandidateId: string | null;
	providerJson: string;
	modality: GenerativeAssetModality;
	prompt: string;
	negativePrompt: string;
	style: string;
	seed: string;
	count: number;
	referencesJson: string;
	parametersJson: string;
	width: number;
	height: number;
	transparent: boolean;
	removeBackground: boolean;
	pixelsPerUnit: number;
	spritesheet: boolean;
	sheetColumns: number;
	sheetRows: number;
	sheetFramesPerSecond: number;
	materialResolution: number;
	tileable: boolean;
	materialMaps: string[];
	animationDurationSeconds: number;
	animationFramesPerSecond: number;
	animationLoop: boolean;
	animationRig: "none" | "generic" | "humanoid" | "sprite";
	audioDurationSeconds: number;
	audioSampleRate: number;
	audioChannels: 1 | 2;
	audioLoop: boolean;
	destinationDirectory: string;
	baseName: string;
	overwrite: boolean;
	plan: IGenerativeAssetPublicationPlan | null;
	preview: IGenerativePreview | null;
	result: unknown | null;
	busy: boolean;
	error: string | null;
}

const emptyProviderManifest: IGenerativeAssetProviderManifest = {
	version: 1,
	id: "my-generator",
	name: "My Generator",
	vendor: "Local",
	classification: "generative-ai",
	modalities: ["image"],
	hostPlatforms: [],
	maximumOutputBytes: 268_435_456,
	maximumDurationSeconds: 300,
	transport: {
		kind: "executable",
		executable: "my-generator",
		args: ["--request", "$" + "{REQUEST}", "--output", "$" + "{OUTPUT}"],
		credentialEnvironments: [],
	},
};

function manifestJson(provider: IGenerativeAssetProviderDescriptor | null): string {
	const value: IGenerativeAssetProviderManifest = provider
		? {
				version: provider.version,
				id: provider.id,
				name: provider.name,
				vendor: provider.vendor,
				classification: provider.classification,
				modalities: provider.modalities,
				hostPlatforms: provider.hostPlatforms,
				maximumOutputBytes: provider.maximumOutputBytes,
				maximumDurationSeconds: provider.maximumDurationSeconds,
				transport: provider.transport,
			}
		: emptyProviderManifest;
	return JSON.stringify(value, null, "\t");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class EditorGenerativeAssets extends Component<IEditorGenerativeAssetsProps, IEditorGenerativeAssetsState> {
	private _observer: Observer<void> | null = null;
	private _projectObserver: Observer<IProjectConfiguration> | null = null;
	private _mounted = false;
	private _refreshRevision = 0;

	public state: IEditorGenerativeAssetsState = {
		tab: "generate",
		inventory: null,
		jobs: [],
		selectedProviderId: null,
		selectedJobId: null,
		selectedCandidateId: null,
		providerJson: manifestJson(null),
		modality: "image",
		prompt: "",
		negativePrompt: "",
		style: "",
		seed: "",
		count: 1,
		referencesJson: "[]",
		parametersJson: "{}",
		width: 1024,
		height: 1024,
		transparent: false,
		removeBackground: true,
		pixelsPerUnit: 100,
		spritesheet: false,
		sheetColumns: 4,
		sheetRows: 4,
		sheetFramesPerSecond: 12,
		materialResolution: 1024,
		tileable: true,
		materialMaps: ["base-color", "normal", "metallic", "roughness", "ambient-occlusion", "height"],
		animationDurationSeconds: 2,
		animationFramesPerSecond: 30,
		animationLoop: true,
		animationRig: "generic",
		audioDurationSeconds: 5,
		audioSampleRate: 48_000,
		audioChannels: 2,
		audioLoop: false,
		destinationDirectory: "assets/generated",
		baseName: "generated-asset",
		overwrite: false,
		plan: null,
		preview: null,
		result: null,
		busy: false,
		error: null,
	};

	public componentDidMount(): void {
		this._mounted = true;
		this._observer = getGenerativeAssetsChangedObservable(this.props.editor).add(() => void this._refresh());
		this._projectObserver = onProjectConfigurationChangedObservable.add((configuration) => {
			if (configuration.path) {
				void this._refresh();
			}
		});
		void this._refresh();
	}

	public componentWillUnmount(): void {
		this._mounted = false;
		this._refreshRevision++;
		this._observer?.remove();
		this._observer = null;
		this._projectObserver?.remove();
		this._projectObserver = null;
	}

	public render(): ReactNode {
		const provider = this._selectedProvider();
		const job = this._selectedJob();
		const candidate = this._selectedCandidate();
		const active = job ? ["queued", "running", "canceling"].includes(job.status) : false;
		return (
			<div
				className="flex h-full min-h-0 flex-col bg-background text-foreground"
				data-generative-assets-workspace
				data-generative-assets-state={this.state.busy ? "busy" : this.state.error ? "error" : "ready"}
			>
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2 text-xs">
					<span className="font-semibold">Generative Assets</span>
					<span className="text-muted-foreground">Image · Sprite · PBR Material · Animation · Audio</span>
					<span className="ml-auto text-muted-foreground">
						{this.state.inventory ? `${this.state.inventory.providers.length} provider(s) · ${this.state.jobs.length} retained job(s)` : "Loading project providers"}
					</span>
					<Button data-generative-refresh size="sm" variant="outline" disabled={this.state.busy} onClick={() => void this._refresh()}>
						Refresh
					</Button>
				</div>
				{this.state.error && (
					<div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" data-generative-error>
						{this.state.error}
					</div>
				)}
				<Tabs
					value={this.state.tab}
					onValueChange={(value) => this.setState({ tab: value as IEditorGenerativeAssetsState["tab"] })}
					className="flex min-h-0 flex-1 flex-col"
				>
					<TabsList className="m-2 mb-0 grid w-[460px] max-w-[calc(100%-1rem)] grid-cols-3">
						<TabsTrigger data-generative-tab="generate" value="generate">
							Generate
						</TabsTrigger>
						<TabsTrigger data-generative-tab="providers" value="providers">
							Providers
						</TabsTrigger>
						<TabsTrigger data-generative-tab="results" value="results">
							Results & Publish
						</TabsTrigger>
					</TabsList>
					<TabsContent value="generate" className="min-h-0 flex-1 overflow-auto p-3">
						{this._renderGenerate(provider)}
					</TabsContent>
					<TabsContent value="providers" className="min-h-0 flex-1 overflow-auto p-3">
						{this._renderProviders(provider)}
					</TabsContent>
					<TabsContent value="results" className="min-h-0 flex-1 overflow-auto p-3">
						{this._renderResults(job, candidate, active)}
					</TabsContent>
				</Tabs>
			</div>
		);
	}

	private _renderGenerate(provider: IGenerativeAssetProviderDescriptor | null): ReactNode {
		const availableProviders = this.state.inventory?.providers.filter((entry) => entry.available) ?? [];
		return (
			<div className="grid max-w-5xl gap-3 text-xs" data-generative-request-editor>
				<section className="grid gap-2 rounded border border-border p-3">
					<div className="font-semibold">Provider and prompt</div>
					<div className="grid grid-cols-2 gap-2">
						<label className="grid gap-1">
							Available provider
							<select
								data-generative-provider-select
								className="h-9 rounded border border-border bg-input px-2"
								value={provider?.id ?? ""}
								onChange={(event) => this.setState({ selectedProviderId: event.currentTarget.value || null })}
							>
								<option value="">Select a provider</option>
								{availableProviders.map((entry) => (
									<option key={entry.id} value={entry.id}>
										{entry.name} ({entry.classification})
									</option>
								))}
							</select>
						</label>
						<label className="grid gap-1">
							Modality
							<select
								data-generative-modality
								className="h-9 rounded border border-border bg-input px-2"
								value={this.state.modality}
								onChange={(event) => this.setState({ modality: event.currentTarget.value as GenerativeAssetModality })}
							>
								{(["image", "sprite", "material", "animation", "audio"] as GenerativeAssetModality[]).map((entry) => (
									<option key={entry}>{entry}</option>
								))}
							</select>
						</label>
					</div>
					<label className="grid gap-1">
						Prompt
						<textarea
							data-generative-prompt
							className="min-h-24 rounded border border-border bg-input p-2"
							maxLength={8192}
							value={this.state.prompt}
							onChange={(event) => this.setState({ prompt: event.currentTarget.value })}
						/>
					</label>
					<div className="grid grid-cols-2 gap-2">
						<label className="grid gap-1">
							Negative prompt
							<Input
								data-generative-negative-prompt
								value={this.state.negativePrompt}
								onChange={(event) => this.setState({ negativePrompt: event.currentTarget.value })}
							/>
						</label>
						<label className="grid gap-1">
							Style
							<Input data-generative-style value={this.state.style} onChange={(event) => this.setState({ style: event.currentTarget.value })} />
						</label>
					</div>
					<div className="grid grid-cols-2 gap-2">
						{this._number("Seed (blank = random)", "seed", this.state.seed, 0, 4_294_967_295, (value) => this.setState({ seed: value }))}
						{this._number("Candidate count", "count", this.state.count, 1, 4, (value) => this.setState({ count: Number(value) }))}
					</div>
				</section>
				{this._renderModalityOptions()}
				<section className="grid gap-2 rounded border border-border p-3">
					<div className="font-semibold">References and provider parameters</div>
					<div className="grid grid-cols-2 gap-2">
						<label className="grid gap-1">
							Project-contained references JSON
							<textarea
								data-generative-references
								className="min-h-28 rounded border border-border bg-input p-2 font-mono"
								value={this.state.referencesJson}
								onChange={(event) => this.setState({ referencesJson: event.currentTarget.value })}
							/>
						</label>
						<label className="grid gap-1">
							Closed scalar parameters JSON
							<textarea
								data-generative-parameters
								className="min-h-28 rounded border border-border bg-input p-2 font-mono"
								value={this.state.parametersJson}
								onChange={(event) => this.setState({ parametersJson: event.currentTarget.value })}
							/>
						</label>
					</div>
					<Button data-generative-start disabled={this.state.busy || !provider?.available || !this.state.prompt.trim()} onClick={() => void this._start()}>
						Generate Asset
					</Button>
					<div className="text-muted-foreground">
						Starting executes the configured project provider or remote endpoint. Credentials are read only from named environment variables.
					</div>
				</section>
			</div>
		);
	}

	private _renderModalityOptions(): ReactNode {
		const modality = this.state.modality;
		return (
			<section className="grid gap-2 rounded border border-border p-3" data-generative-options={modality}>
				<div className="font-semibold">{modality[0].toUpperCase() + modality.slice(1)} options</div>
				{(modality === "image" || modality === "sprite") && (
					<div className="grid grid-cols-2 gap-2">
						{this._number("Width", "width", this.state.width, 64, 4096, (value) => this.setState({ width: Number(value) }))}
						{this._number("Height", "height", this.state.height, 64, 4096, (value) => this.setState({ height: Number(value) }))}
						{this._check("Transparent", "transparent", this.state.transparent, (value) => this.setState({ transparent: value }))}
					</div>
				)}
				{modality === "sprite" && (
					<div className="grid grid-cols-3 gap-2">
						{this._check("Remove background", "remove-background", this.state.removeBackground, (value) => this.setState({ removeBackground: value }))}
						{this._number("Pixels per unit", "pixels-per-unit", this.state.pixelsPerUnit, 0.001, 1_000_000, (value) => this.setState({ pixelsPerUnit: Number(value) }))}
						{this._check("Sprite sheet", "spritesheet", this.state.spritesheet, (value) => this.setState({ spritesheet: value }))}
						{this.state.spritesheet &&
							this._number("Columns", "sheet-columns", this.state.sheetColumns, 1, 16, (value) => this.setState({ sheetColumns: Number(value) }))}
						{this.state.spritesheet && this._number("Rows", "sheet-rows", this.state.sheetRows, 1, 16, (value) => this.setState({ sheetRows: Number(value) }))}
						{this.state.spritesheet &&
							this._number("Sheet FPS", "sheet-fps", this.state.sheetFramesPerSecond, 1, 120, (value) => this.setState({ sheetFramesPerSecond: Number(value) }))}
					</div>
				)}
				{modality === "material" && (
					<div className="grid gap-2">
						<div className="grid grid-cols-2 gap-2">
							{this._number("Resolution", "material-resolution", this.state.materialResolution, 64, 4096, (value) =>
								this.setState({ materialResolution: Number(value) })
							)}
							{this._check("Tileable", "material-tileable", this.state.tileable, (value) => this.setState({ tileable: value }))}
						</div>
						<div className="flex flex-wrap gap-3" data-generative-material-maps>
							{generativeMaterialMapRoles.map((role) =>
								this._check(role, `material-map-${role}`, this.state.materialMaps.includes(role), (checked) =>
									this.setState((state) => ({ materialMaps: checked ? [...state.materialMaps, role] : state.materialMaps.filter((entry) => entry !== role) }))
								)
							)}
						</div>
					</div>
				)}
				{modality === "animation" && (
					<div className="grid grid-cols-2 gap-2">
						{this._number("Duration (seconds)", "animation-duration", this.state.animationDurationSeconds, 0.1, 300, (value) =>
							this.setState({ animationDurationSeconds: Number(value) })
						)}
						{this._number("Frames per second", "animation-fps", this.state.animationFramesPerSecond, 1, 240, (value) =>
							this.setState({ animationFramesPerSecond: Number(value) })
						)}
						{this._check("Loop", "animation-loop", this.state.animationLoop, (value) => this.setState({ animationLoop: value }))}
						<label className="grid gap-1">
							Rig
							<select
								data-generative-animation-rig
								className="h-9 rounded border border-border bg-input px-2"
								value={this.state.animationRig}
								onChange={(event) => this.setState({ animationRig: event.currentTarget.value as IEditorGenerativeAssetsState["animationRig"] })}
							>
								{["none", "generic", "humanoid", "sprite"].map((entry) => (
									<option key={entry}>{entry}</option>
								))}
							</select>
						</label>
					</div>
				)}
				{modality === "audio" && (
					<div className="grid grid-cols-2 gap-2">
						{this._number("Duration (seconds)", "audio-duration", this.state.audioDurationSeconds, 0.1, 600, (value) =>
							this.setState({ audioDurationSeconds: Number(value) })
						)}
						{this._number("Sample rate", "audio-sample-rate", this.state.audioSampleRate, 8000, 192000, (value) => this.setState({ audioSampleRate: Number(value) }))}
						<label className="grid gap-1">
							Channels
							<select
								data-generative-audio-channels
								className="h-9 rounded border border-border bg-input px-2"
								value={this.state.audioChannels}
								onChange={(event) => this.setState({ audioChannels: Number(event.currentTarget.value) as 1 | 2 })}
							>
								<option value={1}>Mono</option>
								<option value={2}>Stereo</option>
							</select>
						</label>
						{this._check("Loop", "audio-loop", this.state.audioLoop, (value) => this.setState({ audioLoop: value }))}
					</div>
				)}
			</section>
		);
	}

	private _renderProviders(provider: IGenerativeAssetProviderDescriptor | null): ReactNode {
		const inventory = this.state.inventory;
		return (
			<div className="grid min-h-full grid-cols-[minmax(220px,28%)_1fr] gap-3 text-xs" data-generative-provider-workspace>
				<section className="rounded border border-border p-2">
					<div className="mb-2 flex items-center justify-between">
						<span className="font-semibold">Project providers</span>
						<Button
							data-generative-provider-new
							size="sm"
							variant="outline"
							onClick={() => this.setState({ selectedProviderId: null, providerJson: manifestJson(null) })}
						>
							New
						</Button>
					</div>
					{!inventory?.providers.length && <div className="text-muted-foreground">No providers configured in .zvibe/generative-providers.</div>}
					{inventory?.providers.map((entry) => (
						<button
							key={entry.id}
							data-generative-provider={entry.id}
							className={`mb-2 w-full rounded border p-2 text-left ${provider?.id === entry.id ? "border-primary bg-secondary" : "border-border"}`}
							onClick={() => this.setState({ selectedProviderId: entry.id, providerJson: manifestJson(entry), result: entry, error: null })}
						>
							<div className="font-semibold">{entry.name}</div>
							<div>
								{entry.vendor} · {entry.classification} · {entry.transport.kind}
							</div>
							<div className={entry.available ? "text-emerald-400" : "text-amber-400"}>{entry.available ? "Available" : "Unavailable"}</div>
						</button>
					))}
					{inventory?.errors.map((entry) => (
						<div key={`${entry.path}:${entry.error}`} className="mb-2 text-destructive">
							{entry.path}: {entry.error}
						</div>
					))}
				</section>
				<section className="grid min-h-0 gap-2 rounded border border-border p-3">
					<div className="font-semibold">Closed provider manifest</div>
					<textarea
						data-generative-provider-json
						className="min-h-96 rounded border border-border bg-input p-2 font-mono"
						value={this.state.providerJson}
						onChange={(event) => this.setState({ providerJson: event.currentTarget.value })}
					/>
					<div className="flex gap-2">
						<Button data-generative-provider-save disabled={this.state.busy || !inventory} onClick={() => void this._saveProvider()}>
							{provider ? "Replace Provider" : "Create Provider"}
						</Button>
						<Button
							data-generative-provider-delete
							variant="destructive"
							disabled={this.state.busy || !provider || !inventory}
							onClick={() => void this._deleteProvider()}
						>
							Delete Provider
						</Button>
					</div>
					<div className="text-muted-foreground">Credential values are never accepted here. Configure only environment-variable names.</div>
				</section>
			</div>
		);
	}

	private _renderResults(job: IGenerativeAssetJobSnapshot | null, candidate: IGenerativeAssetJobSnapshot["candidates"][number] | null, active: boolean): ReactNode {
		return (
			<div className="grid min-h-full grid-cols-[minmax(250px,30%)_1fr] gap-3 text-xs" data-generative-results-workspace>
				<section className="overflow-auto rounded border border-border p-2">
					<div className="mb-2 font-semibold">Retained jobs ({this.state.jobs.length}/64)</div>
					{!this.state.jobs.length && <div className="text-muted-foreground">No retained generation jobs.</div>}
					{this.state.jobs.map((entry) => (
						<button
							key={entry.id}
							data-generative-job={entry.id}
							data-generative-job-status={entry.status}
							className={`mb-2 w-full rounded border p-2 text-left ${job?.id === entry.id ? "border-primary bg-secondary" : "border-border"}`}
							onClick={() => this._selectJob(entry)}
						>
							<div className="flex justify-between gap-2 font-semibold">
								<span>{entry.request.modality}</span>
								<span>{entry.status}</span>
							</div>
							<div className="truncate">{entry.request.prompt}</div>
							<div className="text-muted-foreground">
								{entry.provider.name} · rev {entry.revision} · attempt {entry.attempt}
							</div>
						</button>
					))}
				</section>
				<section className="min-h-0 overflow-auto rounded border border-border p-3">
					{!job && <div className="text-muted-foreground">Select a retained job to inspect its exact evidence.</div>}
					{job && (
						<div className="grid gap-3" data-generative-selected-job={job.id}>
							<div>
								<div className="text-base font-semibold">{job.request.prompt}</div>
								<div className="text-muted-foreground">
									{job.id} · {job.status} · revision {job.revision} · {job.outputBytes} output bytes
								</div>
								<div>
									{job.progress.phase}: {job.progress.message}
								</div>
								{job.error && <div className="text-destructive">{job.error}</div>}
							</div>
							<div className="flex flex-wrap gap-2">
								<Button data-generative-cancel size="sm" variant="destructive" disabled={this.state.busy || !active} onClick={() => void this._cancel()}>
									Cancel
								</Button>
								<Button data-generative-retry size="sm" variant="outline" disabled={this.state.busy || active} onClick={() => void this._retry()}>
									Retry
								</Button>
								<Button data-generative-delete size="sm" variant="destructive" disabled={this.state.busy || active} onClick={() => void this._deleteJob()}>
									Delete Staging
								</Button>
							</div>
							{job.candidates.length > 0 && (
								<section className="grid gap-2 rounded border border-border p-3">
									<div className="font-semibold">Validated candidates</div>
									<div className="flex flex-wrap gap-2">
										{job.candidates.map((entry) => (
											<Button
												key={entry.id}
												data-generative-candidate={entry.id}
												size="sm"
												variant={candidate?.id === entry.id ? "default" : "outline"}
												onClick={() => this.setState({ selectedCandidateId: entry.id, preview: null, plan: null, result: entry })}
											>
												{entry.id}
											</Button>
										))}
									</div>
									{candidate && (
										<div data-generative-candidate-detail={candidate.id}>
											<div>
												{candidate.artifacts.length} artifact(s) · model {candidate.reportedModel ?? "unreported"} · seed{" "}
												{candidate.reportedSeed ?? "unreported"}
											</div>
											{candidate.artifacts.map((artifact) => (
												<div key={artifact.path} className="break-all font-mono">
													{artifact.role}: {artifact.path} · {artifact.mediaType} · {artifact.sizeBytes} bytes
												</div>
											))}
											<Button
												data-generative-preview
												className="mt-2"
												size="sm"
												variant="outline"
												disabled={this.state.busy}
												onClick={() => void this._preview()}
											>
												Load Bounded Preview
											</Button>
										</div>
									)}
								</section>
							)}
							{this._renderPreview()}
							{job.status === "succeeded" && candidate && this._renderPublication(job)}
							{job.publications.length > 0 && (
								<section className="grid gap-2 rounded border border-border p-3" data-generative-publication-history>
									<div className="font-semibold">Publication history</div>
									{job.publications.map((entry) => (
										<div key={entry.id} className="rounded border border-border p-2">
											<div>
												{entry.id} · revision {entry.revision} · {entry.files.length} file(s)
											</div>
											<div className="text-muted-foreground">
												{entry.destinationDirectory}/{entry.baseName} · {entry.publishedAt}
											</div>
										</div>
									))}
								</section>
							)}
						</div>
					)}
					{this.state.result !== null && (
						<pre data-generative-result className="mt-3 max-h-96 overflow-auto rounded border border-border bg-input p-3 text-[11px]">
							{JSON.stringify(this.state.result, null, 2)}
						</pre>
					)}
				</section>
			</div>
		);
	}

	private _renderPreview(): ReactNode {
		const preview = this.state.preview;
		if (!preview) {
			return null;
		}
		if (!preview.available || !preview.dataBase64 || !preview.mediaType) {
			return (
				<section className="rounded border border-border p-3 text-muted-foreground" data-generative-preview-result="unavailable">
					{preview.reason ?? "No preview is available."}
				</section>
			);
		}
		const source = `data:${preview.mediaType};base64,${preview.dataBase64}`;
		return (
			<section className="grid gap-2 rounded border border-border p-3" data-generative-preview-result={preview.mediaType}>
				<div className="font-semibold">
					Verified preview · {preview.sizeBytes} bytes · SHA-256 {preview.sha256?.slice(0, 16)}…
				</div>
				{preview.mediaType.startsWith("image/") ? <img className="max-h-96 max-w-full object-contain" alt="Generated candidate preview" src={source} /> : null}
				{preview.mediaType.startsWith("audio/") ? <audio controls src={source} /> : null}
				{preview.mediaType.startsWith("video/") ? <video className="max-h-96 max-w-full" controls src={source} /> : null}
			</section>
		);
	}

	private _renderPublication(job: IGenerativeAssetJobSnapshot): ReactNode {
		return (
			<section className="grid gap-2 rounded border border-border p-3" data-generative-publication>
				<div className="font-semibold">Publish through normal asset importers</div>
				<div className="grid grid-cols-2 gap-2">
					<label className="grid gap-1">
						Destination directory
						<Input
							data-generative-destination
							value={this.state.destinationDirectory}
							onChange={(event) => this.setState({ destinationDirectory: event.currentTarget.value, plan: null })}
						/>
					</label>
					<label className="grid gap-1">
						Base name
						<Input data-generative-base-name value={this.state.baseName} onChange={(event) => this.setState({ baseName: event.currentTarget.value, plan: null })} />
					</label>
				</div>
				{this._check("Replace exact existing destinations", "overwrite", this.state.overwrite, (value) => this.setState({ overwrite: value, plan: null }))}
				<div className="flex gap-2">
					<Button data-generative-inspect-publication size="sm" variant="outline" disabled={this.state.busy} onClick={() => void this._inspectPublication()}>
						Inspect Publication
					</Button>
					<Button
						data-generative-publish
						size="sm"
						disabled={this.state.busy || !this.state.plan || this.state.plan.jobRevision !== job.revision}
						onClick={() => void this._publish()}
					>
						Publish Exact Plan
					</Button>
				</div>
				{this.state.plan && (
					<div data-generative-publication-plan>
						<div>
							{this.state.plan.files.length} file(s) · {this.state.plan.classification} · fingerprint {this.state.plan.planFingerprint.slice(0, 16)}…
						</div>
						{this.state.plan.files.map((file) => (
							<div key={file.path} className="break-all font-mono">
								{file.action}: {file.path} · {file.role} · {file.importerKind}
							</div>
						))}
						{this.state.plan.warnings.map((warning) => (
							<div key={warning} className="text-amber-400">
								{warning}
							</div>
						))}
					</div>
				)}
			</section>
		);
	}

	private _number(label: string, key: string, value: number | string, min: number, max: number, change: (value: string) => void): ReactNode {
		return (
			<label className="grid gap-1">
				{label}
				<Input data-generative-number={key} type="number" min={min} max={max} value={value} onChange={(event) => change(event.currentTarget.value)} />
			</label>
		);
	}

	private _check(label: string, key: string, checked: boolean, change: (value: boolean) => void): ReactNode {
		return (
			<label className="flex items-center gap-2">
				<input data-generative-check={key} type="checkbox" checked={checked} onChange={(event) => change(event.currentTarget.checked)} />
				{label}
			</label>
		);
	}

	private _scene(): Scene {
		return this.props.editor.layout.preview.scene;
	}

	private _options(): { editor: Editor } {
		return { editor: this.props.editor };
	}

	private _selectedProvider(): IGenerativeAssetProviderDescriptor | null {
		return this.state.inventory?.providers.find((entry) => entry.id === this.state.selectedProviderId) ?? null;
	}

	private _selectedJob(): IGenerativeAssetJobSnapshot | null {
		return this.state.jobs.find((entry) => entry.id === this.state.selectedJobId) ?? null;
	}

	private _selectedCandidate(): IGenerativeAssetJobSnapshot["candidates"][number] | null {
		return this._selectedJob()?.candidates.find((entry) => entry.id === this.state.selectedCandidateId) ?? null;
	}

	private async _refresh(): Promise<void> {
		const revision = ++this._refreshRevision;
		try {
			const [inventory, jobsResult] = await Promise.all([
				listGenerativeAssetProvidersAction(this._scene(), {}, this._options()) as Promise<IGenerativeAssetProviderInventory>,
				listGenerativeAssetJobs(this._scene(), { offset: 0, limit: 100 }, this._options()) as Promise<{ jobs: IGenerativeAssetJobSnapshot[] }>,
			]);
			if (!this._mounted || revision !== this._refreshRevision) {
				return;
			}
			this.setState((state) => {
				const selectedProviderId = inventory.providers.some((entry) => entry.id === state.selectedProviderId)
					? state.selectedProviderId
					: (inventory.providers.find((entry) => entry.available)?.id ?? inventory.providers[0]?.id ?? null);
				const selectedJobId = jobsResult.jobs.some((entry) => entry.id === state.selectedJobId) ? state.selectedJobId : (jobsResult.jobs[0]?.id ?? null);
				const selectedJob = jobsResult.jobs.find((entry) => entry.id === selectedJobId);
				const selectedCandidateId = selectedJob?.candidates.some((entry) => entry.id === state.selectedCandidateId)
					? state.selectedCandidateId
					: (selectedJob?.candidates[0]?.id ?? null);
				return { inventory, jobs: jobsResult.jobs, selectedProviderId, selectedJobId, selectedCandidateId, error: null };
			});
		} catch (error) {
			if (this._mounted && revision === this._refreshRevision) {
				this.setState({ error: errorText(error) });
			}
		}
	}

	private async _perform(operation: () => Promise<unknown>, onSuccess?: (result: any) => void): Promise<void> {
		if (this.state.busy) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			const result = await operation();
			if (!this._mounted) {
				return;
			}
			onSuccess?.(result);
			this.setState({ busy: false, result });
			await this._refresh();
		} catch (error) {
			if (this._mounted) {
				this.setState({ busy: false, error: errorText(error) });
			}
		}
	}

	private _request(): unknown {
		const modality = this.state.modality;
		const options =
			modality === "image"
				? { width: this.state.width, height: this.state.height, transparent: this.state.transparent }
				: modality === "sprite"
					? {
							width: this.state.width,
							height: this.state.height,
							transparent: this.state.transparent,
							removeBackground: this.state.removeBackground,
							pixelsPerUnit: this.state.pixelsPerUnit,
							spritesheet: this.state.spritesheet
								? { columns: this.state.sheetColumns, rows: this.state.sheetRows, framesPerSecond: this.state.sheetFramesPerSecond }
								: null,
						}
					: modality === "material"
						? { resolution: this.state.materialResolution, tileable: this.state.tileable, maps: this.state.materialMaps }
						: modality === "animation"
							? {
									durationSeconds: this.state.animationDurationSeconds,
									framesPerSecond: this.state.animationFramesPerSecond,
									loop: this.state.animationLoop,
									rig: this.state.animationRig,
								}
							: {
									durationSeconds: this.state.audioDurationSeconds,
									sampleRate: this.state.audioSampleRate,
									channels: this.state.audioChannels,
									loop: this.state.audioLoop,
								};
		return normalizeGenerativeAssetRequest({
			version: 1,
			modality,
			prompt: this.state.prompt,
			negativePrompt: this.state.negativePrompt || null,
			style: this.state.style || null,
			seed: this.state.seed === "" ? null : Number(this.state.seed),
			count: this.state.count,
			references: JSON.parse(this.state.referencesJson),
			parameters: JSON.parse(this.state.parametersJson),
			options,
		});
	}

	private async _start(): Promise<void> {
		const provider = this._selectedProvider();
		if (!provider) {
			return;
		}
		await this._perform(
			() =>
				startGenerativeAssetJob(
					this._scene(),
					{ providerId: provider.id, expectedProviderFingerprint: provider.fingerprint, request: this._request(), confirm: true },
					this._options()
				),
			(result: IGenerativeAssetJobSnapshot) => this.setState({ selectedJobId: result.id, selectedCandidateId: null, tab: "results", preview: null, plan: null })
		);
	}

	private async _saveProvider(): Promise<void> {
		const inventory = this.state.inventory;
		if (!inventory) {
			return;
		}
		await this._perform(
			async () => {
				const manifest = JSON.parse(this.state.providerJson);
				const existing = inventory.providers.find((entry) => entry.id === manifest.id);
				return setGenerativeAssetProviderAction(
					this._scene(),
					{
						expectedInventoryFingerprint: inventory.inventoryFingerprint,
						...(existing ? { expectedProviderFingerprint: existing.fingerprint } : {}),
						provider: manifest,
					},
					this._options()
				);
			},
			(result) => this.setState({ selectedProviderId: result.provider.id, providerJson: manifestJson(result.provider) })
		);
	}

	private async _deleteProvider(): Promise<void> {
		const inventory = this.state.inventory;
		const provider = this._selectedProvider();
		if (!inventory || !provider) {
			return;
		}
		await this._perform(
			() =>
				deleteGenerativeAssetProviderAction(
					this._scene(),
					{
						id: provider.id,
						expectedInventoryFingerprint: inventory.inventoryFingerprint,
						expectedProviderFingerprint: provider.fingerprint,
						confirm: true,
					},
					this._options()
				),
			() => this.setState({ selectedProviderId: null, providerJson: manifestJson(null) })
		);
	}

	private _selectJob(job: IGenerativeAssetJobSnapshot): void {
		this.setState({ selectedJobId: job.id, selectedCandidateId: job.candidates[0]?.id ?? null, preview: null, plan: null, result: job, error: null });
	}

	private async _cancel(): Promise<void> {
		const job = this._selectedJob();
		if (job) {
			await this._perform(() => cancelGenerativeAssetJob(this._scene(), { jobId: job.id, expectedRevision: job.revision, confirm: true }, this._options()));
		}
	}

	private async _retry(): Promise<void> {
		const job = this._selectedJob();
		const provider = job ? this.state.inventory?.providers.find((entry) => entry.id === job.provider.id) : null;
		if (job && provider) {
			await this._perform(
				() =>
					retryGenerativeAssetJob(
						this._scene(),
						{ jobId: job.id, expectedRevision: job.revision, expectedProviderFingerprint: provider.fingerprint, confirm: true },
						this._options()
					),
				(result: IGenerativeAssetJobSnapshot) => this.setState({ selectedJobId: result.id, selectedCandidateId: null, preview: null, plan: null })
			);
		}
	}

	private async _deleteJob(): Promise<void> {
		const job = this._selectedJob();
		if (job) {
			await this._perform(
				() => deleteGenerativeAssetJob(this._scene(), { jobId: job.id, expectedRevision: job.revision, confirm: true }, this._options()),
				() => this.setState({ selectedJobId: null, selectedCandidateId: null, preview: null, plan: null })
			);
		}
	}

	private async _preview(): Promise<void> {
		const job = this._selectedJob();
		const candidate = this._selectedCandidate();
		if (!job?.resultFingerprint || !candidate) {
			return;
		}
		await this._perform(
			() =>
				getGenerativeAssetPreview(
					this._scene(),
					{ jobId: job.id, expectedResultFingerprint: job.resultFingerprint, candidateId: candidate.id, maximumBytes: 8 * 1024 * 1024 },
					this._options()
				),
			(result: IGenerativePreview) => this.setState({ preview: result })
		);
	}

	private _publicationData(): Record<string, unknown> | null {
		const job = this._selectedJob();
		const candidate = this._selectedCandidate();
		if (!job?.resultFingerprint || !candidate) {
			return null;
		}
		return {
			jobId: job.id,
			expectedRevision: job.revision,
			expectedResultFingerprint: job.resultFingerprint,
			candidateId: candidate.id,
			destinationDirectory: this.state.destinationDirectory,
			baseName: this.state.baseName,
			overwrite: this.state.overwrite,
		};
	}

	private async _inspectPublication(): Promise<void> {
		const data = this._publicationData();
		if (data) {
			await this._perform(
				() => inspectGenerativeAssetPublicationAction(this._scene(), data, this._options()),
				(result: IGenerativeAssetPublicationPlan) => this.setState({ plan: result })
			);
		}
	}

	private async _publish(): Promise<void> {
		const data = this._publicationData();
		const plan = this.state.plan;
		if (data && plan) {
			await this._perform(
				() => publishGenerativeAssetCandidateAction(this._scene(), { ...data, expectedPlanFingerprint: plan.planFingerprint, confirm: true }, this._options()),
				() => this.setState({ plan: null, preview: null })
			);
		}
	}
}
