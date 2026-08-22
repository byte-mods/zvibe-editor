import { useEffect, useState } from "react";

import { Editor } from "../../main";

import { revokeEditorExtensionTrust, trustEditorExtension } from "../../../extensions/trust";
import {
	IProjectEditorExtensionsSnapshot,
	removeProjectEditorExtensionConfiguration,
	setProjectEditorExtensionEnabled,
	syncProjectEditorExtensions,
} from "../../../extensions/project";
import type { IEditorExtensionTestResult } from "../../../extensions/types";

import { Badge } from "../../../ui/shadcn/ui/badge";
import { Button } from "../../../ui/shadcn/ui/button";
import { Separator } from "../../../ui/shadcn/ui/separator";

/** Live editor authority required for project enablement and machine-local trust actions. */
export interface IEditorExtensionsSettingsProps {
	editor: Editor;
}

/** Project Settings surface for enablement and local trust; dependency mutation stays in Package Manager. */
export function EditorExtensionsSettings(props: IEditorExtensionsSettingsProps): JSX.Element {
	const [snapshot, setSnapshot] = useState<IProjectEditorExtensionsSnapshot | null>(null);
	const [results, setResults] = useState<IEditorExtensionTestResult[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function refresh(): Promise<void> {
		setSnapshot(await syncProjectEditorExtensions(props.editor));
	}

	async function run(action: () => Promise<void>): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Editor extension operation failed.");
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		if (props.editor.state.projectPath) {
			void run(refresh);
		}
	}, [props.editor.state.projectPath]);

	return (
		<div className="mt-3 flex flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="text-lg font-medium">Editor Extensions</div>
					<p className="text-xs text-muted-foreground">
						Install, update, or remove extension packages in the Scene Inspector’s Package Manager. This page only discovers direct dependencies, saves project
						enablement, and grants machine-local executable trust.
					</p>
				</div>
				<Button size="sm" variant="secondary" disabled={busy || !props.editor.state.projectPath} onClick={() => void run(refresh)}>
					Refresh
				</Button>
			</div>

			{props.editor.state.plugins.length > 0 && (
				<div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
					<div className="font-medium">Legacy plugins are still configured</div>
					<div className="mt-1 text-muted-foreground">{props.editor.state.plugins.join(", ")}</div>
					<div className="mt-1">
						Legacy plugin install/update controls are disabled. Migrate these packages to a versioned zvibeEditor manifest and Package Manager dependency.
					</div>
				</div>
			)}

			{error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
			{snapshot?.issues.map((issue, index) => (
				<div key={`${issue.packageName ?? "project"}-${issue.stage}-${index}`} className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
					{issue.packageName ? `${issue.packageName}: ` : ""}
					{issue.message}
				</div>
			))}

			<Separator />
			{snapshot?.configured
				.filter((setting) => !snapshot.extensions.some((view) => view.extension.packageName === setting.packageName))
				.map((setting) => (
					<div key={setting.packageName} className="flex items-center justify-between gap-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
						<div>
							<div className="font-medium">Stale extension configuration</div>
							<div className="font-mono text-muted-foreground">{setting.packageName}</div>
						</div>
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => void run(async () => setSnapshot(await removeProjectEditorExtensionConfiguration(props.editor, setting.packageName)))}
						>
							Remove configuration
						</Button>
					</div>
				))}
			{snapshot && snapshot.extensions.length === 0 && (
				<div className="py-5 text-center text-sm text-muted-foreground">No direct dependency exposes a valid zvibeEditor manifest.</div>
			)}
			{snapshot?.extensions.map((view) => {
				const manifest = view.extension.manifest;
				const active = view.runtime?.state === "active";
				return (
					<div key={view.extension.packageName} className="rounded border border-border bg-secondary/40 p-3">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<div className="font-medium">
									{manifest.displayName} <span className="text-xs text-muted-foreground">v{view.extension.packageVersion}</span>
								</div>
								<div className="truncate font-mono text-xs text-muted-foreground" title={view.extension.packageName}>
									{view.extension.packageName}
								</div>
								{manifest.description && <div className="mt-1 text-xs">{manifest.description}</div>}
							</div>
							<div className="flex flex-wrap justify-end gap-1">
								<Badge variant={view.enabled ? "default" : "secondary"}>{view.enabled ? "Enabled" : "Disabled"}</Badge>
								<Badge variant={view.trusted ? "default" : "destructive"}>{view.trusted ? "Trusted locally" : "Untrusted"}</Badge>
								<Badge variant={active ? "default" : "secondary"}>{view.runtime?.state ?? "inactive"}</Badge>
							</div>
						</div>
						<div className="mt-2 text-xs text-muted-foreground">Capabilities: {manifest.capabilities.length ? manifest.capabilities.join(", ") : "none"}</div>
						<div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={view.extension.fingerprint}>
							Fingerprint {view.extension.fingerprint}
						</div>
						{view.runtime?.error && <div className="mt-2 text-xs text-destructive">{view.runtime.error}</div>}
						<div className="mt-3 flex flex-wrap gap-2">
							<Button
								size="sm"
								variant={view.enabled ? "secondary" : "default"}
								disabled={busy}
								onClick={() => void run(async () => setSnapshot(await setProjectEditorExtensionEnabled(props.editor, view.extension.packageName, !view.enabled)))}
							>
								{view.enabled ? "Disable" : "Enable"}
							</Button>
							{!view.trusted ? (
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										void run(async () => {
											trustEditorExtension(localStorage, view.extension, view.extension.manifest.capabilities);
											await refresh();
										})
									}
								>
									Trust exact version
								</Button>
							) : (
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										void run(async () => {
											revokeEditorExtensionTrust(localStorage, view.extension.packageName);
											await refresh();
										})
									}
								>
									Revoke trust
								</Button>
							)}
							<Button
								size="sm"
								variant="outline"
								disabled={busy || !active}
								onClick={() =>
									void run(async () => {
										try {
											await props.editor.extensionHost?.reload(view.extension.packageName);
										} finally {
											await refresh();
										}
									})
								}
							>
								Reload
							</Button>
							{manifest.contributes.windows.map((window) => (
								<Button
									key={window.id}
									size="sm"
									variant="outline"
									disabled={busy || !active}
									onClick={() =>
										void run(async () => {
											props.editor.extensionHost?.openWindow(window.id);
										})
									}
								>
									Open {window.title}
								</Button>
							))}
							{manifest.contributes.tests.length > 0 && (
								<Button
									size="sm"
									variant="outline"
									disabled={busy || !active}
									onClick={() =>
										void run(async () => setResults((await props.editor.extensionHost?.runTests({ packageName: view.extension.packageName })) ?? []))
									}
								>
									Run editor tests
								</Button>
							)}
						</div>
					</div>
				);
			})}

			{results.length > 0 && (
				<div className="rounded border border-border p-3 text-xs">
					<div className="mb-2 font-medium">Latest editor test run</div>
					{results.map((result) => (
						<div key={result.id} className="flex justify-between gap-3 py-1">
							<span>{result.title}</span>
							<span className={result.state === "passed" ? "text-green-400" : "text-destructive"}>
								{result.state} · {result.durationMs.toFixed(1)} ms {result.error ? `· ${result.error}` : ""}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
