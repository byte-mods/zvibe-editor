import { Component, ReactNode } from "react";

import { Observer, Scene } from "babylonjs";
import { IMlTrainingConfiguration, normalizeMlTrainingSettings } from "babylonjs-editor-tools";

import {
	cancelMlTrainingJob,
	clearMlTrainingDataset,
	deleteMlTrainingJob,
	deleteMlTrainingProvider,
	getMlTrainingChangedObservable,
	getMlTrainingConfiguration,
	IMlTrainingJobSnapshot,
	IMlTrainingProviderDescriptor,
	inspectMlTrainingCheckpointPublication,
	listMlTrainingEpisodes,
	listMlTrainingJobs,
	listMlTrainingProviders,
	publishMlTrainingCheckpoint,
	recordMlTrainingEpisode,
	retryMlTrainingJob,
	setMlTrainingConfiguration,
	setMlTrainingProvider,
	startMlTrainingJob,
} from "../../mcp/ai/ml-training";
import { IProjectConfiguration, onProjectConfigurationChangedObservable } from "../../project/configuration";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/shadcn/ui/tabs";
import { Editor } from "../main";

interface IEditorMlTrainingProps {
	editor: Editor;
}

interface IEditorMlTrainingState {
	tab: "authoring" | "dataset" | "trainers" | "results";
	configuration: IMlTrainingConfiguration | null;
	configurationJson: string;
	providers: IMlTrainingProviderDescriptor[];
	providerJson: string;
	jobs: IMlTrainingJobSnapshot[];
	selectedBehaviorId: string | null;
	selectedProviderId: string | null;
	selectedJobId: string | null;
	episodeJson: string;
	settingsJson: string;
	dataset: any | null;
	publicationPath: string;
	overwrite: boolean;
	plan: any | null;
	result: unknown | null;
	busy: boolean;
	error: string | null;
}

const defaultConfiguration = {
	enabled: true,
	timeScale: 1,
	behaviors: [
		{
			id: "agent-behavior",
			name: "Agent Behavior",
			agentNodeIds: [],
			behaviorGraphId: null,
			observations: [{ name: "observations", size: 8, stacking: 1, normalization: null }],
			actions: { continuousSize: 2, discreteBranches: [] },
			decisionPeriod: 1,
			maxEpisodeSteps: 5000,
			inferenceModelPath: null,
		},
	],
	curriculum: [],
};

const defaultProvider = {
	version: 1,
	id: "python-ml-trainer",
	name: "Python ML Trainer",
	algorithms: ["ppo", "sac", "imitation"],
	executable: "python3",
	args: ["trainer.py"],
	credentialEnvironments: [],
	maximumDurationSeconds: 3600,
};

function pretty(value: unknown): string {
	return JSON.stringify(value, null, "\t");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class EditorMlTraining extends Component<IEditorMlTrainingProps, IEditorMlTrainingState> {
	private _observer: Observer<void> | null = null;
	private _projectObserver: Observer<IProjectConfiguration> | null = null;
	private _mounted = false;
	private _refreshRevision = 0;

	public state: IEditorMlTrainingState = {
		tab: "authoring",
		configuration: null,
		configurationJson: pretty(defaultConfiguration),
		providers: [],
		providerJson: pretty(defaultProvider),
		jobs: [],
		selectedBehaviorId: null,
		selectedProviderId: null,
		selectedJobId: null,
		episodeJson: pretty({
			id: "episode-1",
			behaviorId: "agent-behavior",
			agentId: "agent-1",
			lessonId: null,
			parameters: {},
			steps: [{ observations: [0, 0, 0, 0, 0, 0, 0, 0], continuousActions: [0, 0], discreteActions: [], reward: 0, done: true, interrupted: false }],
		}),
		settingsJson: pretty(normalizeMlTrainingSettings({ algorithm: "behavior-cloning", epochs: 20 })),
		dataset: null,
		publicationPath: "assets/models/trained-policy.onnx",
		overwrite: false,
		plan: null,
		result: null,
		busy: false,
		error: null,
	};

	public componentDidMount(): void {
		this._mounted = true;
		this._observer = getMlTrainingChangedObservable(this.props.editor).add(() => void this._refresh());
		this._projectObserver = onProjectConfigurationChangedObservable.add((configuration) => configuration.path && void this._refresh());
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
		const behavior = this.state.configuration?.behaviors.find((entry) => entry.id === this.state.selectedBehaviorId) ?? null;
		const provider = this.state.providers.find((entry) => entry.id === this.state.selectedProviderId) ?? null;
		const job = this.state.jobs.find((entry) => entry.id === this.state.selectedJobId) ?? null;
		const active = job ? ["queued", "running", "canceling"].includes(job.status) : false;
		return (
			<div
				className="flex h-full min-h-0 flex-col bg-background text-foreground"
				data-ml-training-workspace
				data-ml-training-state={this.state.busy ? "busy" : this.state.error ? "error" : "ready"}
			>
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2 text-xs">
					<span className="font-semibold">ML Training</span>
					<span className="text-muted-foreground">Agents · Observations · Actions · Rewards · Curriculum · Trainers · ONNX</span>
					<span className="ml-auto text-muted-foreground">
						{this.state.configuration
							? `${this.state.configuration.behaviors.length} behavior(s) · ${this.state.jobs.length} job(s)`
							: "Loading project training state"}
					</span>
					<Button data-ml-training-refresh size="sm" variant="outline" disabled={this.state.busy} onClick={() => void this._refresh()}>
						Refresh
					</Button>
				</div>
				{this.state.error && (
					<div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" data-ml-training-error>
						{this.state.error}
					</div>
				)}
				<Tabs value={this.state.tab} onValueChange={(tab) => this.setState({ tab: tab as IEditorMlTrainingState["tab"] })} className="flex min-h-0 flex-1 flex-col">
					<TabsList className="m-2 mb-0 grid w-[620px] max-w-[calc(100%-1rem)] grid-cols-4">
						<TabsTrigger data-ml-training-tab="authoring" value="authoring">
							Agent Authoring
						</TabsTrigger>
						<TabsTrigger data-ml-training-tab="dataset" value="dataset">
							Demonstrations
						</TabsTrigger>
						<TabsTrigger data-ml-training-tab="trainers" value="trainers">
							Trainers
						</TabsTrigger>
						<TabsTrigger data-ml-training-tab="results" value="results">
							Jobs & Checkpoints
						</TabsTrigger>
					</TabsList>
					<TabsContent value="authoring" className="min-h-0 flex-1 overflow-auto p-3">
						<div className="grid gap-3 xl:grid-cols-[minmax(440px,1.2fr)_minmax(320px,0.8fr)]">
							<section className="grid gap-2 rounded border border-border p-3" data-ml-training-authoring>
								<div className="font-semibold">Scene Agent Configuration</div>
								<div className="text-xs text-muted-foreground">
									Author exact agent-node links, optional Behavior Graph links, observation/action spaces, decision cadence, episode limits, inference models, and
									curriculum.
								</div>
								<textarea
									data-ml-training-configuration-json
									className="min-h-[420px] w-full rounded border border-border bg-input p-2 font-mono text-xs"
									value={this.state.configurationJson}
									onChange={(event) => this.setState({ configurationJson: event.currentTarget.value })}
								/>
								<Button
									data-ml-training-apply-configuration
									disabled={this.state.busy || !this.state.configuration}
									onClick={() => void this._applyConfiguration()}
								>
									Apply Exact Configuration
								</Button>
							</section>
							<section className="grid content-start gap-2 rounded border border-border p-3" data-ml-training-behavior-summary>
								<div className="font-semibold">Behavior & Curriculum Summary</div>
								{this.state.configuration?.behaviors.map((entry) => (
									<button
										key={entry.id}
										data-ml-training-behavior={entry.id}
										className={`rounded border p-2 text-left text-xs ${entry.id === behavior?.id ? "border-primary bg-primary/10" : "border-border"}`}
										onClick={() => this.setState({ selectedBehaviorId: entry.id, dataset: null, plan: null })}
									>
										<div className="font-semibold">{entry.name}</div>
										<div>
											{entry.observations.reduce((total, value) => total + value.size * value.stacking, 0)} observations · {entry.actions.continuousSize}{" "}
											continuous · {entry.actions.discreteBranches.length} discrete branches
										</div>
										<div className="text-muted-foreground">
											{entry.agentNodeIds.length} agent node(s) · decision every {entry.decisionPeriod} step(s) · max {entry.maxEpisodeSteps}
										</div>
									</button>
								))}
								{!this.state.configuration?.behaviors.length && <div className="text-xs text-muted-foreground">No ML behaviors are authored.</div>}
								<div className="mt-2 font-semibold">Curriculum</div>
								{this.state.configuration?.curriculum.map((lesson) => (
									<div key={lesson.id} className="rounded border border-border p-2 text-xs" data-ml-training-curriculum={lesson.id}>
										{lesson.name} · reward threshold {lesson.minimumMeanReward ?? "start"} · {Object.keys(lesson.parameters).length} parameter(s)
									</div>
								))}
							</section>
						</div>
					</TabsContent>
					<TabsContent value="dataset" className="min-h-0 flex-1 overflow-auto p-3">
						<div className="grid gap-3 xl:grid-cols-2">
							<section className="grid gap-2 rounded border border-border p-3" data-ml-training-episode-recorder>
								<div className="font-semibold">Record Demonstration Episode</div>
								<select
									data-ml-training-dataset-behavior
									className="rounded border border-border bg-input p-2 text-xs"
									value={behavior?.id ?? ""}
									onChange={(event) => this.setState({ selectedBehaviorId: event.currentTarget.value, dataset: null })}
								>
									{this.state.configuration?.behaviors.map((entry) => (
										<option key={entry.id} value={entry.id}>
											{entry.name}
										</option>
									))}
								</select>
								<textarea
									data-ml-training-episode-json
									className="min-h-[360px] rounded border border-border bg-input p-2 font-mono text-xs"
									value={this.state.episodeJson}
									onChange={(event) => this.setState({ episodeJson: event.currentTarget.value })}
								/>
								<div className="flex flex-wrap gap-2">
									<Button data-ml-training-record-episode disabled={this.state.busy || !behavior} onClick={() => void this._recordEpisode()}>
										Record Episode
									</Button>
									<Button data-ml-training-refresh-dataset variant="outline" disabled={this.state.busy || !behavior} onClick={() => void this._refreshDataset()}>
										Inspect Dataset
									</Button>
									<Button
										data-ml-training-clear-dataset
										variant="destructive"
										disabled={this.state.busy || !this.state.dataset?.total}
										onClick={() => void this._clearDataset()}
									>
										Clear Dataset
									</Button>
								</div>
							</section>
							<section className="grid content-start gap-2 rounded border border-border p-3" data-ml-training-dataset-summary>
								<div className="font-semibold">Retained Dataset</div>
								<div className="text-xs">
									{this.state.dataset
										? `${this.state.dataset.total} episode(s) · ${this.state.dataset.totalSteps} step(s)`
										: "Inspect the selected behavior dataset."}
								</div>
								{this.state.dataset?.datasetFingerprint && (
									<div className="break-all font-mono text-[10px] text-muted-foreground">SHA-256 {this.state.dataset.datasetFingerprint}</div>
								)}
								{this.state.dataset?.episodes?.map((episode: any) => (
									<div key={episode.id} className="rounded border border-border p-2 text-xs" data-ml-training-episode={episode.id}>
										<div className="font-semibold">{episode.id}</div>
										<div>
											{episode.steps} step(s) · reward {episode.reward} · agent {episode.agentId}
										</div>
									</div>
								))}
							</section>
						</div>
					</TabsContent>
					<TabsContent value="trainers" className="min-h-0 flex-1 overflow-auto p-3">
						<div className="grid gap-3 xl:grid-cols-2">
							<section className="grid content-start gap-2 rounded border border-border p-3" data-ml-training-providers>
								<div className="font-semibold">Trainer Providers</div>
								{this.state.providers.map((entry) => (
									<button
										key={entry.id}
										data-ml-training-provider={entry.id}
										className={`rounded border p-2 text-left text-xs ${entry.id === provider?.id ? "border-primary bg-primary/10" : "border-border"}`}
										onClick={() => this._selectProvider(entry)}
									>
										<div className="font-semibold">{entry.name}</div>
										<div>
											{entry.algorithms.join(", ")} · {entry.available ? "available" : "unavailable"} · {entry.builtIn ? "built-in" : "executable"}
										</div>
										{entry.warnings.map((warning) => (
											<div key={warning} className="text-amber-400">
												{warning}
											</div>
										))}
									</button>
								))}
								<textarea
									data-ml-training-provider-json
									className="min-h-[280px] rounded border border-border bg-input p-2 font-mono text-xs"
									value={this.state.providerJson}
									onChange={(event) => this.setState({ providerJson: event.currentTarget.value })}
								/>
								<div className="flex gap-2">
									<Button data-ml-training-save-provider disabled={this.state.busy} onClick={() => void this._saveProvider()}>
										Save Provider
									</Button>
									<Button
										data-ml-training-delete-provider
										variant="destructive"
										disabled={this.state.busy || !provider || provider.builtIn}
										onClick={() => void this._deleteProvider()}
									>
										Delete Provider
									</Button>
								</div>
							</section>
							<section className="grid content-start gap-2 rounded border border-border p-3" data-ml-training-start>
								<div className="font-semibold">Start Training</div>
								<label className="grid gap-1 text-xs">
									Behavior
									<select
										data-ml-training-start-behavior
										className="rounded border border-border bg-input p-2"
										value={behavior?.id ?? ""}
										onChange={(event) => this.setState({ selectedBehaviorId: event.currentTarget.value, dataset: null })}
									>
										{this.state.configuration?.behaviors.map((entry) => (
											<option key={entry.id} value={entry.id}>
												{entry.name}
											</option>
										))}
									</select>
								</label>
								<label className="grid gap-1 text-xs">
									Trainer
									<select
										data-ml-training-start-provider
										className="rounded border border-border bg-input p-2"
										value={provider?.id ?? ""}
										onChange={(event) => this.setState({ selectedProviderId: event.currentTarget.value })}
									>
										{this.state.providers.map((entry) => (
											<option key={entry.id} value={entry.id}>
												{entry.name}
											</option>
										))}
									</select>
								</label>
								<textarea
									data-ml-training-settings-json
									className="min-h-[320px] rounded border border-border bg-input p-2 font-mono text-xs"
									value={this.state.settingsJson}
									onChange={(event) => this.setState({ settingsJson: event.currentTarget.value })}
								/>
								<Button data-ml-training-start-job disabled={this.state.busy || !behavior || !provider?.available} onClick={() => void this._startJob()}>
									Train Exact Dataset
								</Button>
							</section>
						</div>
					</TabsContent>
					<TabsContent value="results" className="min-h-0 flex-1 overflow-auto p-3">
						<div className="grid gap-3 xl:grid-cols-[minmax(320px,0.7fr)_minmax(500px,1.3fr)]">
							<section className="grid content-start gap-2 rounded border border-border p-3" data-ml-training-job-list>
								<div className="font-semibold">Training Jobs</div>
								{this.state.jobs.map((entry) => (
									<button
										key={entry.id}
										data-ml-training-job={entry.id}
										className={`rounded border p-2 text-left text-xs ${entry.id === job?.id ? "border-primary bg-primary/10" : "border-border"}`}
										onClick={() => this.setState({ selectedJobId: entry.id, plan: null })}
									>
										<div className="font-semibold">
											{entry.behavior.name} · {entry.status}
										</div>
										<div>
											{entry.settings.algorithm} · {entry.datasetSteps} step(s) · attempt {entry.attempt}
										</div>
										<div className="text-muted-foreground">{entry.progress.message}</div>
									</button>
								))}
								{!this.state.jobs.length && <div className="text-xs text-muted-foreground">No retained training jobs.</div>}
							</section>
							<section className="grid content-start gap-2 rounded border border-border p-3" data-ml-training-job-detail>
								<div className="font-semibold">Checkpoint & Metrics</div>
								{job ? (
									<>
										<div className="text-xs">
											{job.id} · revision {job.revision} · {job.status}
										</div>
										{job.error && <div className="text-xs text-destructive">{job.error}</div>}
										{job.execution.diagnostics && <pre className="max-h-32 overflow-auto rounded bg-input p-2 text-[10px]">{job.execution.diagnostics}</pre>}
										{job.result && (
											<div className="grid grid-cols-2 gap-2 text-xs">
												<div>ONNX {job.result.modelBytes} bytes</div>
												<div>
													{job.result.inputSize} → {job.result.outputSize}
												</div>
												<div>{job.result.metrics.length} metrics</div>
												<div>loss {job.result.metrics.at(-1)?.loss ?? "n/a"}</div>
											</div>
										)}
										<div className="flex flex-wrap gap-2">
											<Button data-ml-training-cancel-job variant="outline" disabled={this.state.busy || !active} onClick={() => void this._cancelJob()}>
												Cancel
											</Button>
											<Button data-ml-training-retry-job variant="outline" disabled={this.state.busy || active} onClick={() => void this._retryJob()}>
												Retry
											</Button>
											<Button data-ml-training-delete-job variant="destructive" disabled={this.state.busy || active} onClick={() => void this._deleteJob()}>
												Delete Staging
											</Button>
										</div>
										<label className="grid gap-1 text-xs">
											Project ONNX path
											<Input
												data-ml-training-publication-path
												value={this.state.publicationPath}
												onChange={(event) => this.setState({ publicationPath: event.currentTarget.value, plan: null })}
											/>
										</label>
										<label className="flex items-center gap-2 text-xs">
											<input
												data-ml-training-overwrite
												type="checkbox"
												checked={this.state.overwrite}
												onChange={(event) => this.setState({ overwrite: event.currentTarget.checked, plan: null })}
											/>
											Overwrite exact destination
										</label>
										<div className="flex gap-2">
											<Button
												data-ml-training-inspect-publication
												variant="outline"
												disabled={this.state.busy || job.status !== "succeeded"}
												onClick={() => void this._inspectPublication()}
											>
												Inspect Publication
											</Button>
											<Button data-ml-training-publish disabled={this.state.busy || !this.state.plan} onClick={() => void this._publish()}>
												Publish to Runtime AI
											</Button>
										</div>
										{this.state.plan && (
											<pre className="max-h-56 overflow-auto rounded bg-input p-2 text-[10px]" data-ml-training-publication-plan>
												{pretty(this.state.plan)}
											</pre>
										)}
									</>
								) : (
									<div className="text-xs text-muted-foreground">Select a training job.</div>
								)}
							</section>
						</div>
					</TabsContent>
				</Tabs>
			</div>
		);
	}

	private _scene(): Scene {
		return this.props.editor.layout.preview.scene;
	}

	private _options(): { editor: Editor } {
		return { editor: this.props.editor };
	}

	private async _refresh(): Promise<void> {
		const revision = ++this._refreshRevision;
		try {
			const configResult = getMlTrainingConfiguration(this._scene()) as { configuration: IMlTrainingConfiguration };
			const [providerResult, jobResult] = await Promise.all([
				listMlTrainingProviders(this._scene(), {}, this._options()) as Promise<{ providers: IMlTrainingProviderDescriptor[] }>,
				listMlTrainingJobs(this._scene(), { offset: 0, limit: 100 }, this._options()) as Promise<{ jobs: IMlTrainingJobSnapshot[] }>,
			]);
			if (!this._mounted || revision !== this._refreshRevision) {
				return;
			}
			this.setState((state) => ({
				configuration: configResult.configuration,
				configurationJson: state.configuration ? state.configurationJson : pretty({ ...configResult.configuration, version: undefined, revision: undefined }),
				providers: providerResult.providers,
				jobs: jobResult.jobs,
				selectedBehaviorId: configResult.configuration.behaviors.some((entry) => entry.id === state.selectedBehaviorId)
					? state.selectedBehaviorId
					: (configResult.configuration.behaviors[0]?.id ?? null),
				selectedProviderId: providerResult.providers.some((entry) => entry.id === state.selectedProviderId)
					? state.selectedProviderId
					: (providerResult.providers.find((entry) => entry.available)?.id ?? null),
				selectedJobId: jobResult.jobs.some((entry) => entry.id === state.selectedJobId) ? state.selectedJobId : (jobResult.jobs[0]?.id ?? null),
				error: null,
			}));
		} catch (error) {
			if (this._mounted && revision === this._refreshRevision) {
				this.setState({ error: errorText(error) });
			}
		}
	}

	private async _perform(operation: () => Promise<unknown> | unknown, success?: (result: any) => void): Promise<void> {
		if (this.state.busy) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			const result = await operation();
			if (!this._mounted) {
				return;
			}
			success?.(result);
			this.setState({ busy: false, result });
			await this._refresh();
		} catch (error) {
			if (this._mounted) {
				this.setState({ busy: false, error: errorText(error) });
			}
		}
	}

	private async _applyConfiguration(): Promise<void> {
		const current = this.state.configuration;
		if (!current) {
			return;
		}
		await this._perform(
			() => setMlTrainingConfiguration(this._scene(), { expectedRevision: current.revision, configuration: JSON.parse(this.state.configurationJson) }, this._options()),
			(result) => this.setState({ configurationJson: pretty({ ...result.configuration, version: undefined, revision: undefined }), dataset: null, plan: null })
		);
	}

	private async _refreshDataset(): Promise<any | null> {
		if (!this.state.selectedBehaviorId) {
			return null;
		}
		let result: any | null = null;
		await this._perform(
			async () => (result = await listMlTrainingEpisodes(this._scene(), { behaviorId: this.state.selectedBehaviorId, offset: 0, limit: 100 }, this._options())),
			(value) => this.setState({ dataset: value })
		);
		return result;
	}

	private async _recordEpisode(): Promise<void> {
		if (!this.state.configuration) {
			return;
		}
		await this._perform(
			() =>
				recordMlTrainingEpisode(
					this._scene(),
					{ expectedConfigurationRevision: this.state.configuration!.revision, episode: JSON.parse(this.state.episodeJson) },
					this._options()
				),
			() => this.setState({ dataset: null })
		);
	}

	private async _clearDataset(): Promise<void> {
		if (!this.state.selectedBehaviorId || !this.state.dataset?.datasetFingerprint) {
			return;
		}
		await this._perform(
			() =>
				clearMlTrainingDataset(
					this._scene(),
					{ behaviorId: this.state.selectedBehaviorId, expectedDatasetFingerprint: this.state.dataset.datasetFingerprint, confirm: true },
					this._options()
				),
			() => this.setState({ dataset: null })
		);
	}

	private _selectProvider(provider: IMlTrainingProviderDescriptor): void {
		this.setState({ selectedProviderId: provider.id, providerJson: provider.manifest ? pretty(provider.manifest) : pretty(defaultProvider) });
	}

	private async _saveProvider(): Promise<void> {
		const manifest = JSON.parse(this.state.providerJson);
		const existing = this.state.providers.find((entry) => entry.id === manifest.id);
		await this._perform(
			() =>
				setMlTrainingProvider(
					this._scene(),
					{ provider: manifest, ...(existing && !existing.builtIn ? { expectedFingerprint: existing.fingerprint } : {}) },
					this._options()
				),
			(result) => this.setState({ selectedProviderId: result.provider.id, providerJson: pretty(result.provider.manifest) })
		);
	}

	private async _deleteProvider(): Promise<void> {
		const provider = this.state.providers.find((entry) => entry.id === this.state.selectedProviderId);
		if (!provider || provider.builtIn) {
			return;
		}
		await this._perform(
			() => deleteMlTrainingProvider(this._scene(), { id: provider.id, expectedFingerprint: provider.fingerprint, confirm: true }, this._options()),
			() => this.setState({ selectedProviderId: null, providerJson: pretty(defaultProvider) })
		);
	}

	private async _startJob(): Promise<void> {
		const configuration = this.state.configuration;
		const behaviorId = this.state.selectedBehaviorId;
		const provider = this.state.providers.find((entry) => entry.id === this.state.selectedProviderId);
		if (!configuration || !behaviorId || !provider) {
			return;
		}
		await this._perform(
			async () => {
				const dataset = this.state.dataset ?? (await listMlTrainingEpisodes(this._scene(), { behaviorId, offset: 0, limit: 100 }, this._options()));
				if (!dataset?.datasetFingerprint) {
					throw new Error("The selected behavior has no retained training dataset.");
				}
				return startMlTrainingJob(
					this._scene(),
					{
						behaviorId,
						expectedConfigurationRevision: configuration.revision,
						providerId: provider.id,
						expectedProviderFingerprint: provider.fingerprint,
						expectedDatasetFingerprint: dataset.datasetFingerprint,
						settings: JSON.parse(this.state.settingsJson),
						confirm: true,
					},
					this._options()
				);
			},
			(result: IMlTrainingJobSnapshot) => this.setState({ selectedJobId: result.id, tab: "results", plan: null })
		);
	}

	private async _cancelJob(): Promise<void> {
		const job = this.state.jobs.find((entry) => entry.id === this.state.selectedJobId);
		if (job) {
			await this._perform(() => cancelMlTrainingJob(this._scene(), { jobId: job.id, expectedRevision: job.revision, confirm: true }, this._options()));
		}
	}

	private async _retryJob(): Promise<void> {
		const job = this.state.jobs.find((entry) => entry.id === this.state.selectedJobId);
		const provider = job ? this.state.providers.find((entry) => entry.id === job.provider.id) : null;
		const config = this.state.configuration;
		const dataset = this.state.dataset ?? (job ? await listMlTrainingEpisodes(this._scene(), { behaviorId: job.behavior.id, offset: 0, limit: 1 }, this._options()) : null);
		if (!job || !provider || !config || !dataset) {
			return;
		}
		await this._perform(
			() =>
				retryMlTrainingJob(
					this._scene(),
					{
						jobId: job.id,
						expectedRevision: job.revision,
						expectedConfigurationRevision: config.revision,
						expectedProviderFingerprint: provider.fingerprint,
						expectedDatasetFingerprint: dataset.datasetFingerprint,
						confirm: true,
					},
					this._options()
				),
			(result: IMlTrainingJobSnapshot) => this.setState({ selectedJobId: result.id, plan: null })
		);
	}

	private async _deleteJob(): Promise<void> {
		const job = this.state.jobs.find((entry) => entry.id === this.state.selectedJobId);
		if (job) {
			await this._perform(
				() => deleteMlTrainingJob(this._scene(), { jobId: job.id, expectedRevision: job.revision, confirm: true }, this._options()),
				() => this.setState({ selectedJobId: null, plan: null })
			);
		}
	}

	private _publicationData(): Record<string, unknown> | null {
		const job = this.state.jobs.find((entry) => entry.id === this.state.selectedJobId);
		if (!job?.resultFingerprint) {
			return null;
		}
		return {
			jobId: job.id,
			expectedRevision: job.revision,
			expectedResultFingerprint: job.resultFingerprint,
			path: this.state.publicationPath,
			overwrite: this.state.overwrite,
		};
	}

	private async _inspectPublication(): Promise<void> {
		const data = this._publicationData();
		if (data) {
			await this._perform(
				() => inspectMlTrainingCheckpointPublication(this._scene(), data, this._options()),
				(plan) => this.setState({ plan })
			);
		}
	}

	private async _publish(): Promise<void> {
		const data = this._publicationData();
		if (data && this.state.plan) {
			await this._perform(
				() => publishMlTrainingCheckpoint(this._scene(), { ...data, expectedPlanFingerprint: this.state.plan.planFingerprint, confirm: true }, this._options()),
				() => this.setState({ plan: null })
			);
		}
	}
}
