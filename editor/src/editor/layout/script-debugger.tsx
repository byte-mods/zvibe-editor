import { Component, ReactNode } from "react";

import type { IScriptSimulationControl, IScriptSourceBreakpointInput, IScriptSourceCoverageSnapshot, IScriptSourceDebuggerSnapshot } from "babylonjs-editor-tools";
import type { Observer } from "babylonjs";

import { deleteCustomScriptTemplate, getCustomScriptTemplate, listCustomScriptTemplates, listScriptTemplates, setCustomScriptTemplate } from "../../mcp/scripts/scripts";
import { IProjectConfiguration, onProjectConfigurationChangedObservable, projectConfiguration } from "../../project/configuration";
import { showConfirm } from "../../ui/dialog";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { Textarea } from "../../ui/shadcn/ui/textarea";

import { Editor } from "../main";

interface IEditorScriptDebuggerProps {
	editor: Editor;
}

interface IEditorScriptDebuggerState {
	view: "debugger" | "coverage" | "templates";
	snapshot: IScriptSourceDebuggerSnapshot | null;
	coverage: IScriptSourceCoverageSnapshot | null;
	simulation: IScriptSimulationControl | null;
	breakpointPath: string;
	breakpointLine: number;
	breakpointHitCondition: number;
	customTemplates: any[];
	selectedTemplateId: string | null;
	templateId: string;
	templateDescription: string;
	templateContent: string;
	templateFingerprint: string | null;
	busy: boolean;
	error: string | null;
}

export class EditorScriptDebugger extends Component<IEditorScriptDebuggerProps, IEditorScriptDebuggerState> {
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;
	private _refreshPending = false;
	private _projectConfigurationObserver: Observer<IProjectConfiguration> | null = null;

	public constructor(props: IEditorScriptDebuggerProps) {
		super(props);
		this.state = {
			view: "debugger",
			snapshot: null,
			coverage: null,
			simulation: null,
			breakpointPath: "src/",
			breakpointLine: 1,
			breakpointHitCondition: 1,
			customTemplates: [],
			selectedTemplateId: null,
			templateId: "",
			templateDescription: "",
			templateContent: "export default class MyScriptComponent {\n\tpublic onStart(): void {}\n\tpublic onUpdate(): void {}\n}\n",
			templateFingerprint: null,
			busy: false,
			error: null,
		};
	}

	public componentDidMount(): void {
		this._refreshTimer = setInterval(() => void this._refreshDebugger(), 250);
		if (projectConfiguration.path) {
			void this._refreshTemplates();
		}
		this._projectConfigurationObserver = onProjectConfigurationChangedObservable.add((configuration) => {
			if (configuration.path) {
				void this._refreshTemplates();
			}
		});
	}

	public componentWillUnmount(): void {
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		this._refreshTimer = null;
		this._projectConfigurationObserver?.remove();
		this._projectConfigurationObserver = null;
	}

	public render(): ReactNode {
		const play = this.props.editor.layout.preview?.play;
		const debugging = play?.scriptSourceDebuggingEnabled ?? false;
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2">
					<Button size="sm" disabled={this.state.busy} onClick={() => void this._toggleDebugging(debugging)}>
						{debugging ? "Disable Debug Play" : "Start Debug Play"}
					</Button>
					<Button size="sm" variant="outline" disabled={!debugging || this.state.busy || !this.state.simulation} onClick={() => this._togglePause()}>
						{this.state.simulation?.paused ? "Resume Scripts" : "Pause Scripts"}
					</Button>
					<Button size="sm" variant="outline" disabled={!debugging || this.state.busy || !this.state.simulation?.paused} onClick={() => this._step()}>
						Step 1/60
					</Button>
					<Button size="sm" variant="outline" disabled={!debugging || this.state.busy || !this.state.snapshot} onClick={() => this._toggleCoverage()}>
						Coverage {this.state.snapshot?.coverageEnabled ? "On" : "Off"}
					</Button>
					<Button size="sm" variant="ghost" disabled={!debugging || this.state.busy || !this.state.snapshot?.traceCount} onClick={() => this._clearTrace()}>
						Clear Hits
					</Button>
					<span className={`ml-auto text-xs ${this.state.snapshot?.currentHit ? "text-amber-400" : "text-muted-foreground"}`}>
						{!debugging
							? "Debug Play is off"
							: this.state.snapshot?.currentHit
								? `Paused after ${this.state.snapshot.currentHit.point.path}:${this.state.snapshot.currentHit.point.line}`
								: "Safe-boundary debugger ready"}
					</span>
				</div>
				<div className="flex gap-1 border-b border-border p-1">
					{(["debugger", "coverage", "templates"] as const).map((view) => (
						<Button key={view} size="sm" variant={this.state.view === view ? "secondary" : "ghost"} className="h-7 capitalize" onClick={() => this.setState({ view })}>
							{view}
						</Button>
					))}
					<span className="ml-auto self-center pr-2 text-[10px] text-muted-foreground">
						Breakpoints pause subsequent script lifecycle delivery; the current synchronous callback completes.
					</span>
				</div>
				{this.state.error && <div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
					{this.state.view === "debugger" ? this._renderDebugger() : this.state.view === "coverage" ? this._renderCoverage() : this._renderTemplates()}
				</div>
			</div>
		);
	}

	private _renderDebugger(): ReactNode {
		const snapshot = this.state.snapshot;
		if (!snapshot) {
			return <div className="text-muted-foreground">Start Debug Play to compile project TypeScript with runtime-only source probes.</div>;
		}
		return (
			<div className="grid gap-3 lg:grid-cols-[minmax(300px,0.9fr)_minmax(360px,1.1fr)]">
				<section className="rounded border border-border p-3">
					<div className="mb-2 font-semibold">Breakpoints</div>
					<div className="flex flex-wrap gap-2">
						<Input
							className="min-w-56 flex-1"
							value={this.state.breakpointPath}
							onChange={(event) => this.setState({ breakpointPath: event.currentTarget.value })}
							placeholder="src/player.ts"
						/>
						<Input
							className="w-20"
							type="number"
							min={1}
							value={this.state.breakpointLine}
							onChange={(event) => this.setState({ breakpointLine: Number(event.currentTarget.value) })}
						/>
						<Input
							className="w-20"
							type="number"
							min={1}
							value={this.state.breakpointHitCondition}
							title="Pause from this hit onward"
							onChange={(event) => this.setState({ breakpointHitCondition: Number(event.currentTarget.value) })}
						/>
						<Button size="sm" onClick={() => this._addBreakpoint()} disabled={this.state.busy || !this.state.breakpointPath.trim()}>
							Add
						</Button>
					</div>
					<div className="mt-3 grid gap-1">
						{snapshot.breakpoints.map((breakpoint) => (
							<div key={breakpoint.id} className="flex items-center gap-2 rounded bg-muted/30 p-2">
								<span className="min-w-0 flex-1 truncate">
									{breakpoint.path}:{breakpoint.line} → {breakpoint.resolvedLine ?? "unresolved"}:{breakpoint.resolvedColumn ?? "—"} · hits {breakpoint.hits}/
									{breakpoint.hitCondition}
								</span>
								<Button size="sm" variant="ghost" className="h-6" onClick={() => this._removeBreakpoint(breakpoint.id)}>
									Remove
								</Button>
							</div>
						))}
						{!snapshot.breakpoints.length && <div className="text-muted-foreground">No runtime breakpoints.</div>}
					</div>
				</section>
				<section className="rounded border border-border p-3">
					<div className="font-semibold">Current hit and retained trace</div>
					{snapshot.currentHit ? (
						<div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2">
							<div>
								{snapshot.currentHit.point.path}:{snapshot.currentHit.point.line}:{snapshot.currentHit.point.column} · {snapshot.currentHit.lifecycle ?? "callback"}{" "}
								· {snapshot.currentHit.scriptKey ?? "unbound"}
							</div>
							<pre className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 text-[10px]">{JSON.stringify(snapshot.currentHit.fields, null, 2)}</pre>
						</div>
					) : (
						<div className="mt-2 text-muted-foreground">No breakpoint has fired.</div>
					)}
					<div className="mt-3 grid gap-1">
						{[...snapshot.trace].reverse().map((hit) => (
							<div key={hit.sequence} className="rounded bg-muted/30 p-2">
								#{hit.sequence} {hit.point.path}:{hit.point.line} · {hit.scriptKey ?? "unbound"}
							</div>
						))}
					</div>
				</section>
			</div>
		);
	}

	private _renderCoverage(): ReactNode {
		const coverage = this.state.coverage;
		if (!coverage) {
			return <div className="text-muted-foreground">Start Debug Play and enable Coverage to collect source hits.</div>;
		}
		const summary = coverage.summary;
		return (
			<div className="grid gap-3">
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
					{(["files", "lines", "statements", "functions", "branches"] as const).map((key) => (
						<div key={key} className="rounded border border-border p-3">
							<div className="capitalize text-muted-foreground">{key}</div>
							<div className="text-lg font-semibold">{summary[key].percent}%</div>
							<div className="text-[10px] text-muted-foreground">
								{summary[key].covered}/{summary[key].total}
							</div>
						</div>
					))}
				</div>
				{coverage.files.map((file) => (
					<div key={file.path} className="rounded border border-border p-3">
						<div className="font-semibold">{file.path}</div>
						<div className="mt-1 text-muted-foreground">
							lines {file.lines.percent}% · statements {file.statements.percent}% · functions {file.functions.percent}% · branches {file.branches.percent}%
						</div>
						{file.uncoveredLineCount > 0 && <div className="mt-1 text-amber-400">Uncovered lines: {file.uncoveredLines.join(", ")}</div>}
					</div>
				))}
			</div>
		);
	}

	private _renderTemplates(): ReactNode {
		const builtIns = listScriptTemplates().templates as any[];
		return (
			<div className="grid min-h-full gap-3 lg:grid-cols-[260px_minmax(400px,1fr)]">
				<aside className="rounded border border-border p-2">
					<div className="flex items-center justify-between">
						<span className="font-semibold">Project templates</span>
						<Button size="sm" variant="outline" className="h-7" onClick={() => this._newTemplate()}>
							New
						</Button>
					</div>
					<div className="mt-2 grid gap-1">
						{this.state.customTemplates.map((template) => (
							<button
								key={template.id}
								className={`rounded p-2 text-left ${this.state.selectedTemplateId === template.id ? "bg-secondary" : "hover:bg-muted/40"}`}
								onClick={() => void this._selectTemplate(template.id)}
							>
								<div className="font-medium">{template.id}</div>
								<div className="truncate text-[10px] text-muted-foreground">{template.description || "No description"}</div>
							</button>
						))}
						{!this.state.customTemplates.length && <div className="p-2 text-muted-foreground">No project templates.</div>}
					</div>
					<div className="mt-4 border-t border-border pt-2 font-semibold">Built-in templates</div>
					{builtIns.map((template) => (
						<div key={template.id} className="mt-1 rounded bg-muted/20 p-2">
							<div>{template.id}</div>
							<div className="text-[10px] text-muted-foreground">{template.description}</div>
						</div>
					))}
				</aside>
				<section className="flex min-h-0 flex-col gap-2 rounded border border-border p-3">
					<div className="flex gap-2">
						<Input
							value={this.state.templateId}
							disabled={Boolean(this.state.selectedTemplateId)}
							placeholder="template-id"
							onChange={(event) => this.setState({ templateId: event.currentTarget.value })}
						/>
						<Input
							value={this.state.templateDescription}
							placeholder="Description"
							onChange={(event) => this.setState({ templateDescription: event.currentTarget.value })}
						/>
					</div>
					<Textarea
						className="min-h-64 flex-1 resize-none font-mono text-[11px]"
						value={this.state.templateContent}
						onChange={(event) => this.setState({ templateContent: event.currentTarget.value })}
					/>
					<div className="flex items-center gap-2">
						<Button
							size="sm"
							disabled={this.state.busy || !this.state.templateId.trim() || !this.state.templateContent.trim()}
							onClick={() => void this._saveTemplate()}
						>
							{this.state.selectedTemplateId ? "Replace inspected template" : "Create template"}
						</Button>
						<Button size="sm" variant="destructive" disabled={this.state.busy || !this.state.selectedTemplateId} onClick={() => void this._deleteTemplate()}>
							Delete
						</Button>
						{this.state.templateFingerprint && (
							<span className="ml-auto font-mono text-[10px] text-muted-foreground">fingerprint {this.state.templateFingerprint.slice(0, 12)}…</span>
						)}
					</div>
				</section>
			</div>
		);
	}

	private _run(action: () => void | Promise<void>): void {
		this.setState({ busy: true, error: null });
		void Promise.resolve()
			.then(action)
			.then(() => this.setState({ busy: false }))
			.catch((error) => this.setState({ busy: false, error: error instanceof Error ? error.message : String(error) }));
	}

	private async _refreshDebugger(): Promise<void> {
		if (this._refreshPending) {
			return;
		}
		const play = this.props.editor.layout.preview?.play;
		if (!play?.scriptSourceDebuggingEnabled) {
			if (this.state.snapshot || this.state.coverage || this.state.simulation) {
				this.setState({ snapshot: null, coverage: null, simulation: null });
			}
			return;
		}
		if (!play.scene || !play.canPlayScene) {
			return;
		}
		this._refreshPending = true;
		try {
			const snapshot = play.getScriptSourceDebuggerSnapshot(0, 100);
			const coverage = snapshot.coverageEnabled ? play.getScriptSourceCoverage({ limit: 500 }) : null;
			this.setState({ snapshot, coverage, simulation: play.getScriptSimulationControl(), error: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this._refreshPending = false;
		}
	}

	private _toggleDebugging(enabled: boolean): void {
		this._run(async () => {
			const snapshot = await this.props.editor.layout.preview.play.setScriptSourceDebuggingEnabled(!enabled);
			this.setState({ snapshot, coverage: null, simulation: snapshot ? this.props.editor.layout.preview.play.getScriptSimulationControl() : null });
		});
	}

	private _togglePause(): void {
		this._run(() => {
			const simulation = this.props.editor.layout.preview.play.setScriptSimulationPaused(!this.state.simulation?.paused);
			this.setState({ simulation });
		});
	}

	private _step(): void {
		this._run(() => {
			this.props.editor.layout.preview.play.stepPausedScriptSimulation(1 / 60);
			this.setState({ simulation: this.props.editor.layout.preview.play.getScriptSimulationControl() });
		});
	}

	private _toggleCoverage(): void {
		this._run(() => {
			const snapshot = this.props.editor.layout.preview.play.setScriptSourceCoverage(!this.state.snapshot?.coverageEnabled, false);
			this.setState({ snapshot, coverage: snapshot.coverageEnabled ? this.props.editor.layout.preview.play.getScriptSourceCoverage({ limit: 500 }) : null });
		});
	}

	private _clearTrace(): void {
		this._run(() => this.setState({ snapshot: this.props.editor.layout.preview.play.clearScriptSourceDebuggerTrace() }));
	}

	private _breakpointInputs(): IScriptSourceBreakpointInput[] {
		return (this.state.snapshot?.breakpoints ?? []).map((breakpoint) => ({
			id: breakpoint.id,
			path: breakpoint.path,
			line: breakpoint.line,
			column: breakpoint.column ?? undefined,
			enabled: breakpoint.enabled,
			hitCondition: breakpoint.hitCondition,
		}));
	}

	private _addBreakpoint(): void {
		this._run(() => {
			const next = [
				...this._breakpointInputs(),
				{
					id: `ui-${Date.now()}`,
					path: this.state.breakpointPath.trim(),
					line: this.state.breakpointLine,
					hitCondition: this.state.breakpointHitCondition,
				},
			];
			this.setState({ snapshot: this.props.editor.layout.preview.play.setScriptSourceBreakpoints(next) });
		});
	}

	private _removeBreakpoint(id: string): void {
		this._run(() => this.setState({ snapshot: this.props.editor.layout.preview.play.setScriptSourceBreakpoints(this._breakpointInputs().filter((entry) => entry.id !== id)) }));
	}

	private async _refreshTemplates(): Promise<void> {
		try {
			this.setState({ customTemplates: (await listCustomScriptTemplates()).templates, error: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private _newTemplate(): void {
		this.setState({
			selectedTemplateId: null,
			templateId: "",
			templateDescription: "",
			templateContent: "export default class MyScriptComponent {\n\tpublic onStart(): void {}\n\tpublic onUpdate(): void {}\n}\n",
			templateFingerprint: null,
			error: null,
		});
	}

	private async _selectTemplate(id: string): Promise<void> {
		try {
			const template = await getCustomScriptTemplate(this.props.editor.layout.preview.scene, { id });
			this.setState({
				selectedTemplateId: id,
				templateId: id,
				templateDescription: template.description,
				templateContent: template.content,
				templateFingerprint: template.fingerprint,
				error: null,
			});
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _saveTemplate(): Promise<void> {
		this._run(async () => {
			const result = await setCustomScriptTemplate(this.props.editor.layout.preview.scene, {
				id: this.state.templateId,
				description: this.state.templateDescription,
				content: this.state.templateContent,
				expectedFingerprint: this.state.selectedTemplateId ? this.state.templateFingerprint : undefined,
			});
			await this._refreshTemplates();
			await this._selectTemplate(result.id);
		});
	}

	private async _deleteTemplate(): Promise<void> {
		if (!this.state.selectedTemplateId || !this.state.templateFingerprint) {
			return;
		}
		if (!(await showConfirm("Delete Script Template?", `Permanently delete project template "${this.state.selectedTemplateId}"?`, { confirmText: "Delete" }))) {
			return;
		}
		this._run(async () => {
			await deleteCustomScriptTemplate(this.props.editor.layout.preview.scene, {
				id: this.state.selectedTemplateId,
				expectedFingerprint: this.state.templateFingerprint,
				confirm: true,
			});
			this._newTemplate();
			await this._refreshTemplates();
		});
	}
}
