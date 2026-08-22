import { Component, ReactNode } from "react";

import { Scene } from "babylonjs";

import { getConsoleServerConfiguration, setConsoleServerConfiguration } from "../../mcp/server/configuration";
import { IConsoleServerConfiguration } from "../../mcp/server/model";
import {
	executeConsoleServerWorkflowPlan,
	generateServerDeploymentArtifacts,
	listConsoleProviders,
	listConsoleServerJobs,
	listServerInstances,
	planConsoleServerWorkflow,
	stopServerInstance,
	validateConsoleServerTarget,
} from "../../mcp/server/workflow";
import { listBuildProfiles } from "../../mcp/project/export";
import { generatePlatformScaffold, getPlatformScaffold } from "../../mcp/project/platforms";
import { showConfirm } from "../../ui/dialog";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";

import { Editor } from "../main";

interface IEditorConsoleServerProps {
	editor: Editor;
}

interface IEditorConsoleServerState {
	busy: boolean;
	error: string | null;
	validation: any | null;
	providers: any[];
	providerErrors: any[];
	operation: "build" | "validate" | "container-build" | "deploy" | "scale" | "restart" | "stop" | "logs" | "profile" | "certify";
	durationSeconds: number;
	pendingPlan: any | null;
}

function Panel(props: { title: string; children: ReactNode }): ReactNode {
	return (
		<section className="rounded border border-border bg-background/60 p-3">
			<div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</div>
			<div className="flex flex-col gap-2">{props.children}</div>
		</section>
	);
}

function TextField(props: { label: string; value: string; placeholder?: string; onCommit(value: string): void }): ReactNode {
	return (
		<label className="grid grid-cols-[minmax(150px,1fr)_minmax(180px,2fr)] items-center gap-2 text-xs">
			<span>{props.label}</span>
			<Input
				key={props.value}
				className="h-8 font-mono text-[11px]"
				defaultValue={props.value}
				placeholder={props.placeholder}
				onBlur={(event) => event.currentTarget.value !== props.value && props.onCommit(event.currentTarget.value)}
			/>
		</label>
	);
}

function NumberField(props: { label: string; value: number; minimum: number; maximum: number; onCommit(value: number): void }): ReactNode {
	return (
		<label className="grid grid-cols-[minmax(150px,1fr)_minmax(100px,180px)] items-center gap-2 text-xs">
			<span>{props.label}</span>
			<Input
				key={props.value}
				type="number"
				min={props.minimum}
				max={props.maximum}
				className="h-8"
				defaultValue={props.value}
				onBlur={(event) => {
					const value = Number(event.currentTarget.value);
					if (Number.isFinite(value) && value !== props.value) {
						props.onCommit(value);
					}
				}}
			/>
		</label>
	);
}

function SelectField(props: { label: string; value: string; options: Array<{ value: string; label: string }>; onCommit(value: string): void }): ReactNode {
	return (
		<label className="grid grid-cols-[minmax(150px,1fr)_minmax(140px,180px)] items-center gap-2 text-xs">
			<span>{props.label}</span>
			<select className="h-8 rounded border border-border bg-input px-2" value={props.value} onChange={(event) => props.onCommit(event.currentTarget.value)}>
				{props.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}

/** Production dedicated-server, container/Kubernetes fleet, and licensed console-provider workspace. */
export class EditorConsoleServer extends Component<IEditorConsoleServerProps, IEditorConsoleServerState> {
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;

	public constructor(props: IEditorConsoleServerProps) {
		super(props);
		this.state = { busy: false, error: null, validation: null, providers: [], providerErrors: [], operation: "validate", durationSeconds: 30, pendingPlan: null };
	}

	public componentDidMount(): void {
		void this._refreshExternal();
		this._refreshTimer = setInterval(() => this.forceUpdate(), 750);
	}

	public componentWillUnmount(): void {
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		this._refreshTimer = null;
	}

	public render(): ReactNode {
		const scene = this._scene();
		if (!scene) {
			return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Open a scene to configure Console &amp; Server.</div>;
		}
		let configuration: IConsoleServerConfiguration;
		try {
			configuration = getConsoleServerConfiguration(scene);
		} catch (error) {
			return <div className="p-3 text-sm text-destructive">{this._error(error)}</div>;
		}
		const jobs = listConsoleServerJobs(scene, { limit: 12 }) as any;
		const instances = listServerInstances(scene, { limit: 12 }) as any;
		const profiles = listBuildProfiles(scene).profiles.filter((profile) => profile.target === "headless");
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2">
					<span className="text-xs font-semibold">Console &amp; Server · revision {configuration.revision}</span>
					<span className={`text-xs ${this.state.validation?.valid ? "text-emerald-400" : "text-amber-400"}`}>
						{this.state.validation ? (this.state.validation.valid ? "Target ready" : `${this.state.validation.errors.length} blocking issues`) : "Not validated"}
					</span>
					<span className="ml-auto text-[10px] text-muted-foreground">
						NullEngine · authoritative WebSocket · Docker/Podman · Kubernetes · licensed provider manifests
					</span>
				</div>
				{this.state.error && <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="min-h-0 flex-1 overflow-auto p-3">
					<div className="grid gap-3 2xl:grid-cols-2">
						<div className="flex min-w-0 flex-col gap-3">
							{this._renderHeadless(scene, configuration, profiles)}
							{this._renderDeployment(scene, configuration)}
						</div>
						<div className="flex min-w-0 flex-col gap-3">
							{this._renderReadiness(scene, configuration)}
							{this._renderWorkflow(scene, configuration, jobs, instances)}
						</div>
					</div>
				</div>
			</div>
		);
	}

	private _scene(): Scene | null {
		return this.props.editor.layout.preview?.scene ?? null;
	}

	private _renderHeadless(scene: Scene, configuration: IConsoleServerConfiguration, profiles: any[]): ReactNode {
		const value = configuration.headless;
		return (
			<Panel title="Production Headless Runtime">
				<SelectField
					label="Headless Build Profile"
					value={value.buildProfileId ?? ""}
					options={[
						{ value: "", label: "First enabled Headless" },
						...profiles.map((profile) => ({ value: profile.id, label: `${profile.name}${profile.enabled ? "" : " (disabled)"}` })),
					]}
					onCommit={(buildProfileId) => this._patch(scene, configuration, "headless", { buildProfileId: buildProfileId || null })}
				/>
				<TextField
					label="Initial scene path"
					value={value.initialScenePath ?? ""}
					placeholder="First enabled Build Settings scene"
					onCommit={(initialScenePath) => this._patch(scene, configuration, "headless", { initialScenePath: initialScenePath || null })}
				/>
				<TextField label="Public host" value={value.publicHost} onCommit={(publicHost) => this._patch(scene, configuration, "headless", { publicHost })} />
				<div className="grid gap-2 lg:grid-cols-2">
					<NumberField label="Port" value={value.port} minimum={1_024} maximum={65_535} onCommit={(port) => this._patch(scene, configuration, "headless", { port })} />
					<NumberField
						label="Tick rate"
						value={value.tickRate}
						minimum={1}
						maximum={240}
						onCommit={(tickRate) => this._patch(scene, configuration, "headless", { tickRate })}
					/>
					<NumberField
						label="Catch-up steps"
						value={value.maximumCatchUpSteps}
						minimum={1}
						maximum={16}
						onCommit={(maximumCatchUpSteps) => this._patch(scene, configuration, "headless", { maximumCatchUpSteps })}
					/>
					<NumberField
						label="Maximum players"
						value={value.maximumPlayers}
						minimum={1}
						maximum={256}
						onCommit={(maximumPlayers) => this._patch(scene, configuration, "headless", { maximumPlayers })}
					/>
				</div>
				<TextField
					label="Join-code environment"
					value={value.joinCodeEnvironment}
					onCommit={(joinCodeEnvironment) => this._patch(scene, configuration, "headless", { joinCodeEnvironment })}
				/>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" disabled={this.state.busy} onClick={() => void this._generateScaffold(scene, configuration)}>
						Generate / Update Headless Scaffold
					</Button>
					<span className="self-center text-[10px] text-muted-foreground">Exports the authored scene into a deterministic NullEngine fixed-tick authority runtime.</span>
				</div>
			</Panel>
		);
	}

	private _renderDeployment(scene: Scene, configuration: IConsoleServerConfiguration): ReactNode {
		const container = configuration.container;
		const deployment = configuration.deployment;
		return (
			<Panel title="Container, Fleet & Licensed Console Provider">
				<SelectField
					label="Deployment provider"
					value={deployment.provider}
					options={[
						{ value: "local", label: "Local process" },
						{ value: "container", label: "Docker / Podman" },
						{ value: "kubernetes", label: "Kubernetes" },
						{ value: "console", label: "Licensed console provider" },
					]}
					onCommit={(provider) => this._patch(scene, configuration, "deployment", { provider })}
				/>
				<SelectField
					label="Container engine"
					value={container.engine}
					options={[
						{ value: "docker", label: "Docker" },
						{ value: "podman", label: "Podman" },
					]}
					onCommit={(engine) => this._patch(scene, configuration, "container", { engine })}
				/>
				<TextField label="Container image" value={container.image} onCommit={(image) => this._patch(scene, configuration, "container", { image })} />
				<TextField
					label="Dockerfile path"
					value={container.dockerfilePath}
					onCommit={(dockerfilePath) => this._patch(scene, configuration, "container", { dockerfilePath })}
				/>
				<TextField
					label="Registry credential env"
					value={container.registryCredentialEnvironment ?? ""}
					onCommit={(registryCredentialEnvironment) =>
						this._patch(scene, configuration, "container", { registryCredentialEnvironment: registryCredentialEnvironment || null })
					}
				/>
				<NumberField
					label="Fleet replicas"
					value={deployment.replicas}
					minimum={0}
					maximum={256}
					onCommit={(replicas) => this._patch(scene, configuration, "deployment", { replicas })}
				/>
				<TextField label="Kubernetes namespace" value={deployment.namespace} onCommit={(namespace) => this._patch(scene, configuration, "deployment", { namespace })} />
				<TextField
					label="Kubernetes context"
					value={deployment.kubeContext ?? ""}
					onCommit={(kubeContext) => this._patch(scene, configuration, "deployment", { kubeContext: kubeContext || null })}
				/>
				<SelectField
					label="Console provider"
					value={deployment.consoleProviderId ?? ""}
					options={[{ value: "", label: "None" }, ...this.state.providers.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.vendor}` }))]}
					onCommit={(consoleProviderId) => this._patch(scene, configuration, "deployment", { consoleProviderId: consoleProviderId || null })}
				/>
				{this.state.providerErrors.map((entry) => (
					<div key={entry.path} className="text-[10px] text-destructive">
						{entry.path}: {entry.error}
					</div>
				))}
				<div className="text-[10px] text-muted-foreground">
					Console SDK binaries, devkits, credentials, platform approval, and certification remain separately licensed vendor dependencies.
				</div>
			</Panel>
		);
	}

	private _renderReadiness(scene: Scene, configuration: IConsoleServerConfiguration): ReactNode {
		const validation = this.state.validation;
		return (
			<Panel title="Readiness & Deployment Artifacts">
				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="secondary" disabled={this.state.busy} onClick={() => void this._validate(scene)}>
						Validate Exact Target
					</Button>
					<Button size="sm" disabled={this.state.busy} onClick={() => void this._generateArtifacts(scene, configuration)}>
						Generate Kubernetes / Environment Files
					</Button>
				</div>
				{validation && (
					<div className="rounded bg-input p-2 font-mono text-[10px]">
						<div>Profile: {validation.profile?.name ?? "missing"}</div>
						<div>Scene: {validation.initialScene ?? "missing"}</div>
						<div>
							Scaffold: r{validation.scaffold.revision} · {validation.scaffold.integrity ? "verified" : "not ready"}
						</div>
						<div>
							Deploy artifacts: r{validation.artifacts.revision} · {validation.artifacts.integrity ? "verified" : "not ready"}
						</div>
						<div>
							Commands:{" "}
							{Object.entries(validation.commands)
								.map(([name, present]) => `${name}:${present ? "yes" : "no"}`)
								.join(" · ")}
						</div>
					</div>
				)}
				{validation?.errors.map((message: string) => (
					<div key={message} className="text-[10px] text-destructive">
						{message}
					</div>
				))}
				{validation?.warnings.map((message: string) => (
					<div key={message} className="text-[10px] text-amber-400">
						{message}
					</div>
				))}
			</Panel>
		);
	}

	private _renderWorkflow(scene: Scene, configuration: IConsoleServerConfiguration, jobs: any, instances: any): ReactNode {
		return (
			<Panel title="Exact Planned Workflows & Instances">
				<div className="flex flex-wrap items-end gap-2">
					<SelectField
						label="Operation"
						value={this.state.operation}
						options={["build", "validate", "container-build", "deploy", "scale", "restart", "stop", "logs", "profile", "certify"].map((value) => ({
							value,
							label: value,
						}))}
						onCommit={(operation) => this.setState({ operation: operation as IEditorConsoleServerState["operation"], pendingPlan: null })}
					/>
					{this.state.operation === "profile" && (
						<NumberField
							label="Duration seconds"
							value={this.state.durationSeconds}
							minimum={1}
							maximum={3_600}
							onCommit={(durationSeconds) => this.setState({ durationSeconds })}
						/>
					)}
					<Button size="sm" variant="secondary" disabled={this.state.busy} onClick={() => void this._plan(scene, configuration)}>
						Plan
					</Button>
					<Button size="sm" disabled={this.state.busy || !this.state.pendingPlan} onClick={() => void this._execute(scene)}>
						Confirm &amp; Execute
					</Button>
				</div>
				{this.state.pendingPlan && (
					<div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 font-mono text-[10px]">
						{this.state.pendingPlan.operation} · {this.state.pendingPlan.provider} · expires {this.state.pendingPlan.expiresAt}
					</div>
				)}
				<div className="text-[10px] font-semibold text-muted-foreground">Recent jobs</div>
				{jobs.jobs.length === 0 ? (
					<div className="text-[10px] text-muted-foreground">No jobs yet.</div>
				) : (
					jobs.jobs.map((job: any) => (
						<div key={job.id} className="rounded bg-input p-2 font-mono text-[10px]">
							<span className={job.status === "succeeded" ? "text-emerald-400" : job.status === "failed" ? "text-destructive" : "text-amber-400"}>{job.status}</span>{" "}
							· {job.operation} · {job.provider}
							<pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">{job.outputTail || "(no output)"}</pre>
						</div>
					))
				)}
				<div className="text-[10px] font-semibold text-muted-foreground">Retained instances</div>
				{instances.instances.length === 0 ? (
					<div className="text-[10px] text-muted-foreground">No instances yet.</div>
				) : (
					instances.instances.map((instance: any) => (
						<div key={instance.id} className="flex items-center gap-2 rounded bg-input p-2 font-mono text-[10px]">
							<span>
								{instance.state} · {instance.provider} · {instance.endpoint ?? "provider-managed"}
							</span>
							{instance.provider === "local" && instance.state === "running" && (
								<Button size="sm" variant="destructive" className="ml-auto h-6" onClick={() => void this._stopLocal(scene, instance.id)}>
									Stop
								</Button>
							)}
						</div>
					))
				)}
				<div className="text-[10px] text-muted-foreground">
					All native/provider effects are fixed-command, no-shell, exact-state, single-use, confirmation-gated, and retain bounded redacted evidence.
				</div>
			</Panel>
		);
	}

	private _patch(
		scene: Scene,
		configuration: IConsoleServerConfiguration,
		block: keyof Omit<IConsoleServerConfiguration, "version" | "revision">,
		changes: Record<string, unknown>
	): void {
		try {
			setConsoleServerConfiguration(scene, { expectedRevision: configuration.revision, changes: { [block]: changes } }, { editor: this.props.editor });
			this.setState({ error: null, validation: null, pendingPlan: null });
		} catch (error) {
			this.setState({ error: this._error(error) });
		}
	}

	private async _refreshExternal(): Promise<void> {
		const scene = this._scene();
		if (!scene) {
			return;
		}
		try {
			const result = (await listConsoleProviders(scene, {}, { editor: this.props.editor })) as any;
			this.setState({ providers: result.providers, providerErrors: result.errors });
		} catch (error) {
			this.setState({ error: this._error(error) });
		}
	}

	private async _generateScaffold(scene: Scene, configuration: IConsoleServerConfiguration): Promise<void> {
		await this._busy(async () => {
			const current = (await getPlatformScaffold(scene, { target: "headless" }, { editor: this.props.editor })) as any;
			if (
				current.exists &&
				!current.integrity &&
				!(await showConfirm("Replace modified Headless scaffold?", "Editor-owned generated files changed. User-owned server-game.mjs remains preserved."))
			) {
				return;
			}
			await generatePlatformScaffold(
				scene,
				{
					target: "headless",
					expectedRevision: current.revision,
					settings: {
						host: configuration.headless.publicHost,
						port: configuration.headless.port,
						tickRate: configuration.headless.tickRate,
						maximumCatchUpSteps: configuration.headless.maximumCatchUpSteps,
					},
					...(current.exists && !current.integrity ? { overwrite: true, confirm: true } : {}),
				},
				{ editor: this.props.editor }
			);
			await this._validate(scene);
		});
	}

	private async _generateArtifacts(scene: Scene, configuration: IConsoleServerConfiguration): Promise<void> {
		await this._busy(async () => {
			const scaffold = (await getPlatformScaffold(scene, { target: "headless" }, { editor: this.props.editor })) as any;
			const validation = (await validateConsoleServerTarget(scene, {}, { editor: this.props.editor })) as any;
			const current = validation.artifacts;
			const overwrite = current.exists && !current.integrity;
			if (overwrite && !(await showConfirm("Replace modified deployment artifacts?", "Only hash-owned files under .zvibe/server will be replaced."))) {
				return;
			}
			await generateServerDeploymentArtifacts(
				scene,
				{
					expectedRevision: current.revision,
					expectedConfigurationRevision: configuration.revision,
					expectedScaffoldRevision: scaffold.revision,
					...(overwrite ? { overwrite: true, confirm: true } : {}),
				},
				{ editor: this.props.editor }
			);
			await this._validate(scene);
		});
	}

	private async _validate(scene: Scene): Promise<void> {
		const validation = await validateConsoleServerTarget(scene, {}, { editor: this.props.editor });
		this.setState({ validation, error: null });
	}

	private async _plan(scene: Scene, configuration: IConsoleServerConfiguration): Promise<void> {
		await this._busy(async () => {
			const validation = (await validateConsoleServerTarget(scene, {}, { editor: this.props.editor })) as any;
			const plan = await planConsoleServerWorkflow(
				scene,
				{
					operation: this.state.operation,
					expectedConfigurationRevision: configuration.revision,
					expectedScaffoldRevision: validation.scaffold.revision,
					expectedArtifactsRevision: validation.artifacts.revision,
					...(this.state.operation === "profile" ? { durationSeconds: this.state.durationSeconds } : {}),
				},
				{ editor: this.props.editor }
			);
			this.setState({ validation, pendingPlan: plan });
		});
	}

	private async _execute(scene: Scene): Promise<void> {
		const plan = this.state.pendingPlan;
		if (
			!plan ||
			!(await showConfirm(`Execute ${plan.operation}?`, `This ${plan.provider} workflow may change external build, deployment, fleet, device, or certification state.`))
		) {
			return;
		}
		await this._busy(async () => {
			await executeConsoleServerWorkflowPlan(scene, { planId: plan.id, confirm: true }, { editor: this.props.editor });
			this.setState({ pendingPlan: null });
		});
	}

	private async _stopLocal(scene: Scene, instanceId: string): Promise<void> {
		if (!(await showConfirm("Stop local dedicated server?", "The editor-launched process will receive a graceful termination signal."))) {
			return;
		}
		await this._busy(async () => void (await stopServerInstance(scene, { instanceId, confirm: true })));
	}

	private async _busy(action: () => Promise<void>): Promise<void> {
		if (this.state.busy) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			await action();
		} catch (error) {
			this.setState({ error: this._error(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private _error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
