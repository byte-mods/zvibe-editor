import { Component, ReactNode } from "react";

import type { Observer } from "babylonjs";

import {
	applyProjectAuditorFix,
	cancelProjectAudit,
	getProjectAuditorState,
	IProjectAuditIssue,
	IProjectAuditSettings,
	listProjectAuditIssues,
	onProjectAuditorChangedObservable,
	ProjectAuditCategory,
	startProjectAudit,
} from "../../mcp/project/auditor";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { Editor } from "../main";

interface IEditorProjectAuditorProps {
	editor: Editor;
}

interface IEditorProjectAuditorState {
	snapshot: any | null;
	issues: IProjectAuditIssue[];
	category: ProjectAuditCategory | "all";
	obsoleteTargetVersion: string;
	atlasAllocationWasteThresholdPercent: number;
	atlasUnusedRegionThresholdPercent: number;
	busy: boolean;
	error: string | null;
}

const categories: ProjectAuditCategory[] = ["serialization", "obsolete-api", "particle-texture-readability", "atlas-waste"];

export class EditorProjectAuditor extends Component<IEditorProjectAuditorProps, IEditorProjectAuditorState> {
	private _observer: Observer<{ scene: any; revision: number; jobId: string | null }> | null = null;
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;
	private _refreshPending = false;

	public constructor(props: IEditorProjectAuditorProps) {
		super(props);
		this.state = {
			snapshot: null,
			issues: [],
			category: "all",
			obsoleteTargetVersion: "2.0.0",
			atlasAllocationWasteThresholdPercent: 35,
			atlasUnusedRegionThresholdPercent: 50,
			busy: false,
			error: null,
		};
	}

	public componentDidMount(): void {
		this._observer = onProjectAuditorChangedObservable.add(({ scene }) => {
			if (scene === this.props.editor.layout.preview?.scene) {
				void this._refresh();
			}
		});
		this._refreshTimer = setInterval(() => void this._refresh(), 500);
		void this._refresh();
	}

	public componentWillUnmount(): void {
		this._observer?.remove();
		this._observer = null;
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		this._refreshTimer = null;
	}

	public render(): ReactNode {
		const active = this.state.snapshot?.active;
		const latest = active ?? this.state.snapshot?.recentJobs?.[0] ?? null;
		return (
			<div
				className="flex h-full min-h-0 flex-col bg-background text-foreground"
				data-project-auditor-status={latest?.status ?? "idle"}
				data-project-auditor-job={latest?.id ?? ""}
			>
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2">
					<Button size="sm" disabled={this.state.busy || Boolean(active)} onClick={() => void this._run()}>
						Run Project Audit
					</Button>
					<Button size="sm" variant="outline" disabled={this.state.busy || !active} onClick={() => void this._cancel()}>
						Cancel
					</Button>
					<span className="text-xs text-muted-foreground">
						{latest ? `${latest.status} · ${latest.phase} · ${latest.progress.completed}/${latest.progress.total}` : "Ready for asynchronous analysis"}
					</span>
					{latest?.summary && (
						<span className="ml-auto text-xs">
							{latest.summary.errors} errors · {latest.summary.warnings} warnings · {latest.summary.info} info
						</span>
					)}
				</div>
				<div className="flex flex-wrap items-end gap-2 border-b border-border p-2 text-xs">
					<label className="grid gap-1">
						<span className="text-muted-foreground">Future API target</span>
						<Input
							className="h-7 w-28"
							value={this.state.obsoleteTargetVersion}
							onChange={(event) => this.setState({ obsoleteTargetVersion: event.currentTarget.value })}
						/>
					</label>
					<label className="grid gap-1">
						<span className="text-muted-foreground">Atlas allocation waste %</span>
						<Input
							className="h-7 w-24"
							type="number"
							min={1}
							max={100}
							value={this.state.atlasAllocationWasteThresholdPercent}
							onChange={(event) => this.setState({ atlasAllocationWasteThresholdPercent: Number(event.currentTarget.value) })}
						/>
					</label>
					<label className="grid gap-1">
						<span className="text-muted-foreground">Unused regions %</span>
						<Input
							className="h-7 w-24"
							type="number"
							min={1}
							max={100}
							value={this.state.atlasUnusedRegionThresholdPercent}
							onChange={(event) => this.setState({ atlasUnusedRegionThresholdPercent: Number(event.currentTarget.value) })}
						/>
					</label>
					<span className="ml-auto max-w-xl text-[10px] text-muted-foreground">
						Compile errors also stop the real script emitter before Play/export. Auditor work yields between bounded phases.
					</span>
				</div>
				<div className="flex gap-1 border-b border-border p-1">
					{(["all", ...categories] as const).map((category) => (
						<Button
							key={category}
							size="sm"
							variant={this.state.category === category ? "secondary" : "ghost"}
							className="h-7"
							onClick={() => this.setState({ category }, () => void this._refreshIssues())}
						>
							{category}
						</Button>
					))}
				</div>
				{this.state.error && <div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
					{!latest && (
						<div className="p-4 text-muted-foreground">Run a non-blocking project audit to collect serialization, API, particle texture, and atlas findings.</div>
					)}
					{latest && !this.state.issues.length && (
						<div className="p-4 text-muted-foreground">{latest.status === "completed" ? "No matching unresolved issues." : latest.progress.message}</div>
					)}
					<div className="grid gap-2">
						{this.state.issues.map((issue) => (
							<section key={issue.id} className="rounded border border-border p-3" data-project-auditor-issue={issue.code}>
								<div className="flex items-center gap-2">
									<span className={issue.severity === "error" ? "text-destructive" : issue.severity === "warning" ? "text-amber-400" : "text-sky-400"}>
										{issue.severity.toUpperCase()}
									</span>
									<span className="font-mono text-[10px] text-muted-foreground">{issue.code}</span>
									<span className="font-semibold">{issue.title}</span>
									{issue.fixAvailable && (
										<Button className="ml-auto h-7" size="sm" variant="outline" disabled={this.state.busy} onClick={() => void this._fix(issue)}>
											Apply safe fix
										</Button>
									)}
								</div>
								<div className="mt-1">{issue.message}</div>
								<div className="mt-1 text-muted-foreground">{issue.recommendation}</div>
								<div className="mt-2 font-mono text-[10px] text-muted-foreground">
									{issue.location.path ?? issue.location.nodeName ?? "project"}
									{issue.location.line ? `:${issue.location.line}:${issue.location.column}` : ""} · {issue.category}
								</div>
							</section>
						))}
					</div>
				</div>
			</div>
		);
	}

	private async _refresh(): Promise<void> {
		if (this._refreshPending || !this.props.editor.layout.preview?.scene) {
			return;
		}
		this._refreshPending = true;
		try {
			const snapshot = getProjectAuditorState(this.props.editor.layout.preview.scene);
			this.setState({ snapshot });
			await this._refreshIssues(snapshot);
		} finally {
			this._refreshPending = false;
		}
	}

	private async _refreshIssues(snapshot = this.state.snapshot): Promise<void> {
		const latest = snapshot?.active ?? snapshot?.recentJobs?.[0] ?? null;
		if (!latest) {
			this.setState({ issues: [] });
			return;
		}
		try {
			const result = listProjectAuditIssues(this.props.editor.layout.preview.scene, {
				id: latest.id,
				expectedJobRevision: latest.revision,
				category: this.state.category === "all" ? undefined : this.state.category,
				offset: 0,
				limit: 100,
			});
			this.setState({ issues: result.issues, error: null });
		} catch (error) {
			if (!String(error).includes("job changed")) {
				this.setState({ error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	private async _run(): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const scene = this.props.editor.layout.preview.scene;
			const snapshot = getProjectAuditorState(scene);
			const settings: IProjectAuditSettings = {
				categories,
				obsoleteTargetVersion: this.state.obsoleteTargetVersion,
				maximumIssues: 5_000,
				atlasAllocationWasteThresholdPercent: this.state.atlasAllocationWasteThresholdPercent,
				atlasUnusedRegionThresholdPercent: this.state.atlasUnusedRegionThresholdPercent,
			};
			startProjectAudit(scene, { expectedRevision: snapshot.revision, settings }, { editor: this.props.editor });
			await this._refresh();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _cancel(): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const scene = this.props.editor.layout.preview.scene;
			const snapshot = getProjectAuditorState(scene);
			if (snapshot.active) {
				cancelProjectAudit(scene, { id: snapshot.active.id, expectedRevision: snapshot.revision }, { editor: this.props.editor });
			}
			await this._refresh();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _fix(issue: IProjectAuditIssue): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const scene = this.props.editor.layout.preview.scene;
			const snapshot = getProjectAuditorState(scene);
			const latest = snapshot.active ?? snapshot.recentJobs[0];
			await applyProjectAuditorFix(
				scene,
				{
					id: latest.id,
					issueId: issue.id,
					expectedIssueFingerprint: issue.fingerprint,
					expectedRevision: snapshot.revision,
					expectedJobRevision: latest.revision,
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			await this._refresh();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
