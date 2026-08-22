import { ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "sonner";

import {
	applyPrefabInstancesOverrides,
	inspectPrefabInstancesOverrides,
	IPrefabBulkOverrideEntry,
	IPrefabBulkOverrideTarget,
	PrefabBulkOverrideMode,
	PrefabInstanceOverrideCategory,
	revertPrefabInstancesOverrides,
} from "../../../../mcp/prefabs/prefabs";
import { DialogReturnType, showAlert, showConfirm } from "../../../../ui/dialog";
import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { Editor } from "../../../main";
import { PrefabOverridesPresentation } from "./prefab-overrides";

export type PrefabBulkOverridesSelector =
	| { all: true }
	| { path: string }
	| { targets: (({ nodeId: string; nodeName?: never } | { nodeId?: never; nodeName: string }) & { targetPath?: string; targetIndex?: number })[] };

interface IPrefabBulkOverridesSnapshot {
	batchFingerprint: string;
	targets: IPrefabBulkOverrideTarget[];
	targetCount: number;
	entries: IPrefabBulkOverrideEntry[];
	counts: Record<PrefabInstanceOverrideCategory, number>;
	truncated: boolean;
}

interface IPrefabBulkMutationResult {
	mode: PrefabBulkOverrideMode;
	attempted: number;
	succeeded: number;
	failed: number;
	partial: boolean;
	results: { targetId: string; ok: boolean; error?: string }[];
}

export interface IPrefabBulkOverridesPresentationProps {
	targets: IPrefabBulkOverrideTarget[];
	entries: IPrefabBulkOverrideEntry[];
	selectedKeys: ReadonlySet<string>;
	results?: IPrefabBulkMutationResult | null;
	onToggle: (item: IPrefabBulkOverrideEntry, checked: boolean) => void;
}

/** Namespaces an entry id by its exact live boundary so identical source differences stay independent. */
export function prefabBulkOverrideSelectionKey(item: IPrefabBulkOverrideEntry): string {
	return `${item.targetId}:${item.entry.id}`;
}

/** Selects every mutation-capable row in a complete bulk snapshot. */
export function actionablePrefabBulkOverrideKeys(entries: IPrefabBulkOverrideEntry[]): Set<string> {
	return new Set(entries.filter((item) => item.entry.canApply || item.entry.canRevert).map(prefabBulkOverrideSelectionKey));
}

/** Keeps hierarchy changes atomic within one target without coupling independent targets. */
export function updatePrefabBulkOverrideSelection(
	current: ReadonlySet<string>,
	item: IPrefabBulkOverrideEntry,
	entries: IPrefabBulkOverrideEntry[],
	checked: boolean
): Set<string> {
	const next = new Set(current);
	const targetEntries =
		item.entry.category === "structure" ? entries.filter((candidate) => candidate.targetId === item.targetId && candidate.entry.category === "structure") : [item];
	for (const candidate of targetEntries) {
		const key = prefabBulkOverrideSelectionKey(candidate);
		if (checked) {
			next.add(key);
		} else {
			next.delete(key);
		}
	}
	return next;
}

/** Pure multi-instance grouping and per-target result view used by the live window and UI tests. */
export function PrefabBulkOverridesPresentation(props: IPrefabBulkOverridesPresentationProps): ReactNode {
	return (
		<div className="space-y-3">
			{props.results && (
				<div
					className={`rounded border p-2 text-xs ${props.results.failed ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"}`}
				>
					<div className="font-medium">
						{props.results.mode === "atomic" ? "Atomic" : "Best effort"} result · {props.results.succeeded} succeeded · {props.results.failed} failed
					</div>
					{props.results.results
						.filter((result) => !result.ok)
						.map((result) => (
							<div key={result.targetId} className="mt-1 break-all">
								{result.targetId.slice(0, 12)} · {result.error}
							</div>
						))}
				</div>
			)}
			{props.targets.map((target) => {
				const items = props.entries.filter((item) => item.targetId === target.targetId);
				const selectedIds = new Set(items.filter((item) => props.selectedKeys.has(prefabBulkOverrideSelectionKey(item))).map((item) => item.entry.id));
				return (
					<section key={target.targetId} className="overflow-hidden rounded border border-white/15">
						<div className="flex items-start justify-between gap-3 bg-secondary/80 px-3 py-2 text-xs">
							<div className="min-w-0">
								<div className="truncate font-medium" title={target.rootNodeName}>
									{target.rootNodeName}
								</div>
								<div className="truncate text-muted-foreground" title={target.targetPath}>
									{target.targetPath} · boundary {target.targetIndex} · {target.variant ? "variant" : "base"}
								</div>
							</div>
							<div className="shrink-0 text-right text-muted-foreground">
								<div>
									{items.length} shown · {selectedIds.size} selected
								</div>
								<div>revision {target.revision.slice(0, 12)}</div>
							</div>
						</div>
						{target.conflictCount > 0 && (
							<div className="border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{target.conflictCount} unresolved source conflict(s)</div>
						)}
						{target.blockerCount > 0 && (
							<div className="border-t border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{target.blockerCount} structural blocker(s)</div>
						)}
						<div className="p-2">
							<PrefabOverridesPresentation
								entries={items.map((item) => item.entry)}
								selectedIds={selectedIds}
								conflicts={[]}
								blockers={[]}
								onToggle={(entry, checked) => {
									const item = items.find((candidate) => candidate.entry.id === entry.id);
									if (item) {
										props.onToggle(item, checked);
									}
								}}
							/>
						</div>
					</section>
				);
			})}
			{!props.targets.length && (
				<div className="rounded border border-dashed border-white/15 p-8 text-center text-sm text-muted-foreground">No matching prefab instance overrides.</div>
			)}
		</div>
	);
}

let activePrefabBulkOverridesDialog: DialogReturnType | null = null;

/** Opens one shared multi-instance Overrides window for all, one asset, or explicit boundaries. */
export function openPrefabBulkOverrides(editor: Editor, selector: PrefabBulkOverridesSelector = { all: true }): void {
	activePrefabBulkOverridesDialog?.close();
	const dialog = showAlert("Prefab Overrides — Multiple Instances", <PrefabBulkOverridesWindow editor={editor} selector={selector} />, true);
	activePrefabBulkOverridesDialog = dialog;
	void dialog.wait().finally(() => {
		if (activePrefabBulkOverridesDialog === dialog) {
			activePrefabBulkOverridesDialog = null;
		}
	});
}

/** Closes the active multi-instance Prefab Overrides dialog, if one is open. */
export function closePrefabBulkOverrides(): boolean {
	const dialog = activePrefabBulkOverridesDialog;
	if (!dialog) {
		return false;
	}
	activePrefabBulkOverridesDialog = null;
	dialog.close();
	return true;
}

function PrefabBulkOverridesWindow(props: { editor: Editor; selector: PrefabBulkOverridesSelector }): ReactNode {
	const mounted = useRef(true);
	const loadGeneration = useRef(0);
	const [snapshot, setSnapshot] = useState<IPrefabBulkOverridesSnapshot | null>(null);
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const [mode, setMode] = useState<PrefabBulkOverrideMode>("atomic");
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<"all" | PrefabInstanceOverrideCategory>("all");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<IPrefabBulkMutationResult | null>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	async function loadOverrides(resetResult = true): Promise<void> {
		const generation = ++loadGeneration.current;
		setLoading(true);
		setError(null);
		try {
			const first = await inspectPrefabInstancesOverrides(props.editor.layout.preview.scene, { ...props.selector, offset: 0, limit: 500 });
			const entries = [...first.entries] as IPrefabBulkOverrideEntry[];
			let page = first;
			while (page.hasMore && page.nextOffset !== null) {
				page = await inspectPrefabInstancesOverrides(props.editor.layout.preview.scene, { ...props.selector, offset: page.nextOffset, limit: 500 });
				if (page.batchFingerprint !== first.batchFingerprint) {
					throw new Error("The prefab target set changed while loading. Refresh and try again.");
				}
				entries.push(...page.entries);
			}
			if (first.truncated) {
				throw new Error("This selection exceeds the safe bulk override limit. Open a single prefab path or an explicit target subset.");
			}
			if (mounted.current && loadGeneration.current === generation) {
				const next = { ...first, entries } as IPrefabBulkOverridesSnapshot;
				setSnapshot(next);
				setSelectedKeys(actionablePrefabBulkOverrideKeys(entries));
				if (resetResult) {
					setResult(null);
				}
			}
		} catch (caught) {
			if (mounted.current && loadGeneration.current === generation) {
				setSnapshot(null);
				setSelectedKeys(new Set());
				setError(caught instanceof Error ? caught.message : "Could not inspect prefab instance overrides.");
			}
		} finally {
			if (mounted.current && loadGeneration.current === generation) {
				setLoading(false);
			}
		}
	}

	useEffect(() => {
		void loadOverrides();
	}, []);

	const visibleEntries = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return (snapshot?.entries ?? []).filter(
			(item) =>
				(category === "all" || item.entry.category === category) &&
				(!normalized ||
					`${item.rootNodeName} ${item.targetPath} ${item.entry.label} ${item.entry.nodeName} ${item.entry.sourceNodeName} ${item.entry.kind}`
						.toLowerCase()
						.includes(normalized))
		);
	}, [snapshot, query, category]);
	const selectedEntries = useMemo(() => (snapshot?.entries ?? []).filter((item) => selectedKeys.has(prefabBulkOverrideSelectionKey(item))), [snapshot, selectedKeys]);
	const canApply = selectedEntries.length > 0 && selectedEntries.every((item) => item.entry.canApply);
	const canRevert =
		selectedEntries.length > 0 &&
		selectedEntries.every((item) => item.entry.canRevert) &&
		(mode === "bestEffort" || selectedEntries.every((item) => item.entry.category !== "structure"));

	function operations(): any[] {
		if (!snapshot) {
			return [];
		}
		return snapshot.targets.flatMap((target) => {
			const entryIds = snapshot.entries
				.filter((item) => item.targetId === target.targetId && selectedKeys.has(prefabBulkOverrideSelectionKey(item)))
				.map((item) => item.entry.id);
			return entryIds.length
				? [
						{
							targetId: target.targetId,
							nodeId: target.nodeId,
							targetPath: target.targetPath,
							targetIndex: target.targetIndex,
							expectedRevision: target.revision,
							expectedFingerprint: target.fingerprint,
							entryIds,
						},
					]
				: [];
		});
	}

	async function mutate(action: "apply" | "revert"): Promise<void> {
		if (!snapshot || !selectedEntries.length) {
			return;
		}
		const confirmed = await showConfirm(
			`${action === "apply" ? "Apply" : "Revert"} overrides across ${operations().length} prefab instance(s)?`,
			mode === "atomic"
				? "Atomic mode rolls every selected target back if any target fails."
				: "Best-effort mode keeps successful targets and reports every failed target explicitly."
		);
		if (!confirmed) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const request = { expectedBatchFingerprint: snapshot.batchFingerprint, operations: operations(), mode, confirm: true };
			const response =
				action === "apply"
					? await applyPrefabInstancesOverrides(props.editor.layout.preview.scene, request, { editor: props.editor })
					: await revertPrefabInstancesOverrides(props.editor.layout.preview.scene, request, { editor: props.editor });
			setResult(response);
			if (response.failed) {
				toast.warning(`${response.succeeded} prefab target(s) succeeded; ${response.failed} failed`);
			} else {
				toast.success(`${action === "apply" ? "Applied" : "Reverted"} ${selectedEntries.length} override(s) across ${response.succeeded} target(s)`);
			}
			await loadOverrides(false);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : `Could not ${action} bulk prefab overrides.`);
		} finally {
			if (mounted.current) {
				setBusy(false);
			}
		}
	}

	return (
		<div className="flex h-[78vh] w-[90vw] max-w-[1650px] flex-col gap-3 overflow-hidden text-foreground">
			<div className="grid grid-cols-[minmax(0,1fr)_12rem_11rem_auto_auto_auto] gap-2">
				<Input
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					placeholder="Search instance, asset, node, component, or change"
					aria-label="Search bulk prefab overrides"
				/>
				<select
					className="h-9 rounded-md border border-input bg-background px-3 text-sm"
					value={category}
					onChange={(event) => setCategory(event.currentTarget.value as typeof category)}
				>
					<option value="all">All categories</option>
					<option value="transform">Transform</option>
					<option value="component">Components</option>
					<option value="structure">Structure</option>
				</select>
				<select
					className="h-9 rounded-md border border-input bg-background px-3 text-sm"
					value={mode}
					disabled={busy}
					onChange={(event) => setMode(event.currentTarget.value as PrefabBulkOverrideMode)}
				>
					<option value="atomic">Atomic</option>
					<option value="bestEffort">Best effort</option>
				</select>
				<Button variant="outline" disabled={busy || loading || !snapshot} onClick={() => setSelectedKeys(actionablePrefabBulkOverrideKeys(snapshot?.entries ?? []))}>
					Select All
				</Button>
				<Button variant="outline" disabled={busy || loading || !selectedKeys.size} onClick={() => setSelectedKeys(new Set())}>
					Clear
				</Button>
				<Button variant="outline" disabled={busy || loading} onClick={() => void loadOverrides()}>
					Refresh
				</Button>
			</div>
			<div className="flex items-center justify-between gap-3">
				<div className="text-xs text-muted-foreground">
					{snapshot
						? `${snapshot.targetCount} target(s) · ${visibleEntries.length} shown · ${selectedEntries.length} selected · batch ${snapshot.batchFingerprint.slice(0, 12)}`
						: "No snapshot loaded"}
				</div>
				<div className="flex gap-2">
					<Button disabled={busy || loading || !canApply} onClick={() => void mutate("apply")}>
						{busy ? "Working…" : "Apply Selected"}
					</Button>
					<Button
						variant="secondary"
						disabled={busy || loading || !canRevert}
						title={
							mode === "atomic" && selectedEntries.some((item) => item.entry.category === "structure")
								? "Atomic bulk Revert supports value/component rows only; choose Best effort for structure."
								: undefined
						}
						onClick={() => void mutate("revert")}
					>
						Revert Selected
					</Button>
				</div>
			</div>
			{error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{error}</div>}
			<div className="min-h-0 flex-1 overflow-auto pr-1">
				{loading ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Inspecting all selected prefab boundaries…</div>
				) : (
					<PrefabBulkOverridesPresentation
						targets={snapshot?.targets ?? []}
						entries={visibleEntries}
						selectedKeys={selectedKeys}
						results={result}
						onToggle={(item, checked) => setSelectedKeys((current) => updatePrefabBulkOverrideSelection(current, item, snapshot?.entries ?? [], checked))}
					/>
				)}
			</div>
		</div>
	);
}
