import { ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "sonner";

import { AbstractMesh } from "babylonjs";

import {
	applyPrefabInstanceOverrides,
	inspectPrefabInstanceLinks,
	inspectPrefabInstanceOverrides,
	IPrefabInstanceOverrideEntry,
	PrefabInstanceOverrideCategory,
	revertPrefabInstanceOverrides,
} from "../../../../mcp/prefabs/prefabs";
import { showAlert, showConfirm } from "../../../../ui/dialog";
import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { Editor } from "../../../main";

interface IPrefabOverridesSnapshot {
	rootNodeName: string;
	targetPath: string;
	targetIndex: number;
	variant: boolean;
	revision: string;
	fingerprint: string;
	stale: boolean;
	conflicts: { message: string }[];
	blockers: { message: string }[];
	entries: IPrefabInstanceOverrideEntry[];
}

export interface IPrefabOverridesPresentationProps {
	entries: IPrefabInstanceOverrideEntry[];
	selectedIds: ReadonlySet<string>;
	conflicts: { message: string }[];
	blockers: { message: string }[];
	onToggle: (entry: IPrefabInstanceOverrideEntry, checked: boolean) => void;
}

const overrideCategories: { category: PrefabInstanceOverrideCategory; title: string }[] = [
	{ category: "transform", title: "Transform & Visibility" },
	{ category: "component", title: "Components" },
	{ category: "structure", title: "Hierarchy Structure" },
];

function displayOverrideValue(exists: boolean, value: unknown): string {
	if (!exists) {
		return "Not present";
	}
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

/** Excludes diagnostic-only rows so bulk selection always leaves at least one valid mutation path. */
export function actionablePrefabOverrideIds(entries: IPrefabInstanceOverrideEntry[]): Set<string> {
	return new Set(entries.filter((entry) => entry.canApply || entry.canRevert).map((entry) => entry.id));
}

/** Keeps structure selected as one dependency-safe batch while allowing independent value rows. */
export function updatePrefabOverrideSelection(
	current: ReadonlySet<string>,
	entry: IPrefabInstanceOverrideEntry,
	entries: IPrefabInstanceOverrideEntry[],
	checked: boolean
): Set<string> {
	const next = new Set(current);
	const ids = entry.category === "structure" ? entries.filter((candidate) => candidate.category === "structure").map((candidate) => candidate.id) : [entry.id];
	for (const id of ids) {
		if (checked) {
			next.add(id);
		} else {
			next.delete(id);
		}
	}
	return next;
}

/** Pure grouped override list used by the live window and static UI tests. */
export function PrefabOverridesPresentation(props: IPrefabOverridesPresentationProps): ReactNode {
	return (
		<div className="space-y-3">
			{props.conflicts.length > 0 && (
				<div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
					<div className="font-medium">Source conflicts</div>
					{props.conflicts.map((conflict, index) => (
						<div key={index}>{conflict.message}</div>
					))}
				</div>
			)}
			{props.blockers.length > 0 && (
				<div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
					<div className="font-medium">Resolve before changing structure</div>
					{props.blockers.map((blocker, index) => (
						<div key={index}>{blocker.message}</div>
					))}
				</div>
			)}
			{overrideCategories.map(({ category, title }) => {
				const entries = props.entries.filter((entry) => entry.category === category);
				if (!entries.length) {
					return null;
				}
				return (
					<section key={category} className="overflow-hidden rounded border border-white/10">
						<div className="flex items-center justify-between bg-secondary/70 px-3 py-2 text-xs font-medium">
							<span>{title}</span>
							<span className="text-muted-foreground">{entries.length}</span>
						</div>
						{entries.map((entry) => (
							<label
								key={entry.id}
								className="grid grid-cols-[auto_minmax(9rem,0.8fr)_minmax(12rem,1fr)_minmax(12rem,1fr)] gap-3 border-t border-white/5 px-3 py-2 text-xs"
							>
								<input
									type="checkbox"
									checked={props.selectedIds.has(entry.id)}
									disabled={!entry.canApply && !entry.canRevert}
									onChange={(event) => props.onToggle(entry, event.currentTarget.checked)}
									aria-label={`Select ${entry.label}`}
								/>
								<div className="min-w-0">
									<div className="truncate font-medium" title={entry.label}>
										{entry.label}
									</div>
									<div className="truncate text-muted-foreground">{entry.kind}</div>
									{entry.blockedReason && <div className="mt-1 text-amber-300">{entry.blockedReason}</div>}
								</div>
								<div className="min-w-0">
									<div className="text-[10px] uppercase tracking-wide text-muted-foreground">Instance</div>
									<code className="block break-all text-[11px]">{displayOverrideValue(entry.currentExists, entry.currentValue)}</code>
								</div>
								<div className="min-w-0">
									<div className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</div>
									<code className="block break-all text-[11px]">{displayOverrideValue(entry.sourceExists, entry.sourceValue)}</code>
								</div>
							</label>
						))}
					</section>
				);
			})}
			{!props.entries.length && <div className="rounded border border-dashed border-white/15 p-8 text-center text-sm text-muted-foreground">No matching overrides.</div>}
		</div>
	);
}

/** Opens the Unity-style whole-instance Overrides window for one live prefab node. */
export function openPrefabOverrides(editor: Editor, node: AbstractMesh, initialTargetIndex = 0): void {
	showAlert(`Prefab Overrides — ${node.name}`, <PrefabOverridesWindow editor={editor} node={node} initialTargetIndex={initialTargetIndex} />, true);
}

function PrefabOverridesWindow(props: { editor: Editor; node: AbstractMesh; initialTargetIndex: number }): ReactNode {
	const mounted = useRef(true);
	const loadGeneration = useRef(0);
	const [links, setLinks] = useState<any[]>([]);
	const [targetIndex, setTargetIndex] = useState(props.initialTargetIndex);
	const [snapshot, setSnapshot] = useState<IPrefabOverridesSnapshot | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<"all" | PrefabInstanceOverrideCategory>("all");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	async function loadOverrides(index: number): Promise<void> {
		const generation = ++loadGeneration.current;
		setLoading(true);
		setError(null);
		try {
			const first = await inspectPrefabInstanceOverrides(props.node.getScene(), { nodeId: props.node.id, targetIndex: index, offset: 0, limit: 500 });
			const entries = [...first.entries] as IPrefabInstanceOverrideEntry[];
			let offset = first.nextOffset;
			while (first.hasMore && offset !== null) {
				const page = await inspectPrefabInstanceOverrides(props.node.getScene(), { nodeId: props.node.id, targetIndex: index, offset, limit: 500 });
				if (page.revision !== first.revision || page.fingerprint !== first.fingerprint) {
					throw new Error("The prefab instance changed while loading Overrides. Refresh and try again.");
				}
				entries.push(...page.entries);
				offset = page.nextOffset;
				if (!page.hasMore) {
					break;
				}
			}
			if (mounted.current && loadGeneration.current === generation) {
				setSnapshot({ ...first, entries });
				setSelectedIds(actionablePrefabOverrideIds(entries));
			}
		} catch (caught) {
			if (mounted.current && loadGeneration.current === generation) {
				setSnapshot(null);
				setSelectedIds(new Set());
				setError(caught instanceof Error ? caught.message : "Could not inspect prefab overrides.");
			}
		} finally {
			if (mounted.current && loadGeneration.current === generation) {
				setLoading(false);
			}
		}
	}

	useEffect(() => {
		void (async () => {
			try {
				const inspection = await inspectPrefabInstanceLinks(props.node.getScene(), { nodeId: props.node.id });
				const index = inspection.links.some((link: any) => link.index === props.initialTargetIndex) ? props.initialTargetIndex : 0;
				if (mounted.current) {
					setLinks(inspection.links);
					setTargetIndex(index);
				}
				await loadOverrides(index);
			} catch (caught) {
				if (mounted.current) {
					setError(caught instanceof Error ? caught.message : "Could not inspect prefab source boundaries.");
					setLoading(false);
				}
			}
		})();
	}, [props.node.id]);

	const visibleEntries = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return (snapshot?.entries ?? []).filter(
			(entry) =>
				(category === "all" || entry.category === category) &&
				(!normalized || `${entry.label} ${entry.nodeName} ${entry.sourceNodeName} ${entry.kind}`.toLowerCase().includes(normalized))
		);
	}, [snapshot, query, category]);
	const selectedEntries = useMemo(() => (snapshot?.entries ?? []).filter((entry) => selectedIds.has(entry.id)), [snapshot, selectedIds]);
	const canApplySelection = selectedEntries.length > 0 && selectedEntries.every((entry) => entry.canApply);
	const canRevertSelection = selectedEntries.length > 0 && selectedEntries.every((entry) => entry.canRevert);

	function toggleEntry(entry: IPrefabInstanceOverrideEntry, checked: boolean): void {
		setSelectedIds((current) => updatePrefabOverrideSelection(current, entry, snapshot?.entries ?? [], checked));
	}

	async function mutate(action: "apply" | "revert"): Promise<void> {
		if (!snapshot || !selectedIds.size) {
			return;
		}
		const selected = selectedEntries;
		const unavailable = selected.find((entry) => (action === "apply" ? !entry.canApply : !entry.canRevert));
		if (unavailable) {
			setError(`${unavailable.label}: ${unavailable.blockedReason ?? `${action} is unavailable.`}`);
			return;
		}
		const confirmed = await showConfirm(
			`${action === "apply" ? "Apply" : "Revert"} selected prefab overrides?`,
			action === "apply"
				? `Write ${selected.length} selected change(s) into ${snapshot.targetPath}?`
				: `Replace ${selected.length} selected live change(s) from ${snapshot.targetPath}?`
		);
		if (!confirmed) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const request = {
				nodeId: props.node.id,
				targetPath: snapshot.targetPath,
				targetIndex: snapshot.targetIndex,
				expectedRevision: snapshot.revision,
				expectedFingerprint: snapshot.fingerprint,
				entryIds: selected.map((entry) => entry.id),
				confirm: true,
			};
			if (action === "apply") {
				await applyPrefabInstanceOverrides(props.node.getScene(), request, { editor: props.editor });
			} else {
				await revertPrefabInstanceOverrides(props.node.getScene(), request, { editor: props.editor });
			}
			toast.success(`${action === "apply" ? "Applied" : "Reverted"} ${selected.length} prefab override(s)`);
			await loadOverrides(snapshot.targetIndex);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : `Could not ${action} prefab overrides.`);
		} finally {
			if (mounted.current) {
				setBusy(false);
			}
		}
	}

	return (
		<div className="flex h-[72vh] w-[86vw] max-w-[1500px] flex-col gap-3 overflow-hidden text-foreground">
			<div className="grid grid-cols-[minmax(16rem,1fr)_auto_auto_auto] gap-2">
				<select
					className="h-9 rounded-md border border-input bg-background px-3 text-sm"
					value={targetIndex}
					disabled={busy || loading}
					onChange={(event) => {
						const index = Number(event.currentTarget.value);
						setTargetIndex(index);
						void loadOverrides(index);
					}}
				>
					{links.map((link) => (
						<option key={link.index} value={link.index}>
							{link.index === 0 ? "Outer" : `Nested ${link.index}`} · {link.path} · {link.boundarySourceNodeName ?? link.sourceNodeName}
						</option>
					))}
				</select>
				<Button variant="outline" disabled={busy || loading || !snapshot} onClick={() => setSelectedIds(actionablePrefabOverrideIds(snapshot?.entries ?? []))}>
					Select All
				</Button>
				<Button variant="outline" disabled={busy || loading || !selectedIds.size} onClick={() => setSelectedIds(new Set())}>
					Clear
				</Button>
				<Button variant="outline" disabled={busy || loading} onClick={() => void loadOverrides(targetIndex)}>
					Refresh
				</Button>
			</div>
			<div className="grid grid-cols-[minmax(0,1fr)_12rem_auto_auto] gap-2">
				<Input
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					placeholder="Search node, component, or change"
					aria-label="Search prefab overrides"
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
				<Button disabled={busy || loading || !canApplySelection} onClick={() => void mutate("apply")}>
					{busy ? "Working…" : "Apply Selected"}
				</Button>
				<Button variant="secondary" disabled={busy || loading || !canRevertSelection} onClick={() => void mutate("revert")}>
					Revert Selected
				</Button>
			</div>
			{snapshot && (
				<div className="flex items-center justify-between text-xs text-muted-foreground">
					<span>
						{snapshot.rootNodeName} · {snapshot.targetPath} · {snapshot.variant ? "variant" : "base"} {snapshot.stale ? "· stale base" : ""}
					</span>
					<span>
						{visibleEntries.length} shown · {selectedIds.size} selected · revision {snapshot.revision.slice(0, 12)}
					</span>
				</div>
			)}
			{error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{error}</div>}
			<div className="min-h-0 flex-1 overflow-auto pr-1">
				{loading ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Inspecting complete prefab override state…</div>
				) : (
					<PrefabOverridesPresentation
						entries={visibleEntries}
						selectedIds={selectedIds}
						conflicts={snapshot?.conflicts ?? []}
						blockers={snapshot?.blockers ?? []}
						onToggle={toggleEntry}
					/>
				)}
			</div>
		</div>
	);
}
