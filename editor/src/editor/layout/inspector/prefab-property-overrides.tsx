import { ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";

import { toast } from "sonner";

import { Button } from "../../../ui/shadcn/ui/button";
import { showConfirm } from "../../../ui/dialog";
import { applyPrefabInstanceOverrides, inspectPrefabInstanceLinks, inspectPrefabInstanceOverrides, revertPrefabInstanceOverrides } from "../../../mcp/prefabs/prefabs";
import { onNodeModifiedObservable } from "../../../tools/observables";

import { Editor } from "../../main";

interface IPrefabPropertyOverrideContext {
	object: any;
	links: any[];
	targetIndex: number;
	snapshot: any | null;
	busy: boolean;
	refreshVersion: number;
	setTargetIndex: (index: number) => void;
	scheduleRefresh: () => void;
	apply: (entry: any) => Promise<void>;
	revert: (entry: any) => Promise<void>;
}

const PrefabPropertyOverrideContext = createContext<IPrefabPropertyOverrideContext | null>(null);

export interface IPrefabFieldOverrideTarget {
	object?: any;
	property?: string;
	category?: "transform" | "component";
	kind?: string;
}

export interface IPrefabFieldOverrideProps {
	object: any;
	property: string;
	prefabOverride?: false | IPrefabFieldOverrideTarget;
}

/** Finds the exact node/property row represented by one Inspector field. */
export function findPrefabFieldOverrideEntry(snapshot: any, object: any, property: string, target?: Pick<IPrefabFieldOverrideTarget, "category" | "kind">): any | null {
	if (target?.category && target.kind) {
		return snapshot?.entries?.find((candidate: any) => candidate.category === target.category && candidate.nodeId === object?.id && candidate.kind === target.kind) ?? null;
	}
	const segments = property.split(".");
	if (segments[0] === "metadata" && segments[1]) {
		return snapshot?.entries?.find((candidate: any) => candidate.category === "component" && candidate.nodeId === object?.id && candidate.kind === segments[1]) ?? null;
	}
	const rootProperty = property.split(".")[0] === "rotationQuaternion" ? "rotation" : property.split(".")[0];
	return snapshot?.entries?.find((candidate: any) => candidate.category === "transform" && candidate.nodeId === object?.id && candidate.kind === rootProperty) ?? null;
}

/** Loads one exact boundary's complete transform/name/visibility override model for every compatible Inspector field. */
export function PrefabPropertyOverrideProvider(props: { editor: Editor; object: any; children: ReactNode }): ReactNode {
	const [links, setLinks] = useState<any[]>([]);
	const [targetIndex, setTargetIndex] = useState(0);
	const [snapshot, setSnapshot] = useState<any | null>(null);
	const [busy, setBusy] = useState(false);
	const [refreshVersion, setRefreshVersion] = useState(0);
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loadGeneration = useRef(0);
	const supported = !!props.object?.metadata?.prefab?.path && typeof props.object?.getScene === "function" && typeof props.object?.id === "string";

	async function load(index = targetIndex): Promise<void> {
		const generation = ++loadGeneration.current;
		if (!supported) {
			setLinks([]);
			setSnapshot(null);
			return;
		}
		setBusy(true);
		try {
			const scene = props.object.getScene();
			const inspectedLinks = await inspectPrefabInstanceLinks(scene, { nodeId: props.object.id });
			const boundedIndex = Math.max(0, Math.min(index, inspectedLinks.links.length - 1));
			const target = inspectedLinks.links[boundedIndex];
			if (generation !== loadGeneration.current) {
				return;
			}
			setLinks(inspectedLinks.links);
			setTargetIndex(boundedIndex);
			if (!target) {
				setSnapshot(null);
				return;
			}
			const request = {
				nodeId: props.object.id,
				targetPath: target.path,
				targetIndex: boundedIndex,
				categories: ["transform", "component"],
				limit: 500,
			};
			const first = await inspectPrefabInstanceOverrides(scene, request);
			const entries = [...first.entries];
			for (let offset = entries.length; offset < first.total; offset += 500) {
				const page = await inspectPrefabInstanceOverrides(scene, { ...request, offset });
				if (page.fingerprint !== first.fingerprint || page.revision !== first.revision) {
					throw new Error("Prefab override state changed while loading Inspector property indicators. Refresh and retry.");
				}
				entries.push(...page.entries);
			}
			if (generation !== loadGeneration.current) {
				return;
			}
			setSnapshot({ ...first, entries });
			setRefreshVersion((value) => value + 1);
		} catch (error) {
			if (generation === loadGeneration.current) {
				setSnapshot(null);
				toast.error(error instanceof Error ? error.message : "Could not inspect prefab property overrides.");
			}
		} finally {
			if (generation === loadGeneration.current) {
				setBusy(false);
			}
		}
	}

	useEffect(() => {
		setTargetIndex(0);
		void load(0);
		const observer = onNodeModifiedObservable.add((node) => {
			if (node === props.object) {
				scheduleRefresh();
			}
		});
		return () => {
			// Invalidate every request owned by the previous Inspector selection.
			loadGeneration.current++;
			if (refreshTimer.current) {
				clearTimeout(refreshTimer.current);
			}
			onNodeModifiedObservable.remove(observer);
		};
	}, [props.object]);

	function scheduleRefresh(): void {
		if (!supported) {
			return;
		}
		if (refreshTimer.current) {
			clearTimeout(refreshTimer.current);
		}
		refreshTimer.current = setTimeout(() => void load(), 180);
	}

	async function mutate(entry: any, action: "apply" | "revert"): Promise<void> {
		if (!snapshot || busy) {
			return;
		}
		const confirmed = await showConfirm(
			`${action === "apply" ? "Apply" : "Revert"} prefab property?`,
			action === "apply" ? `Write ${entry.label} into ${snapshot.targetPath}?` : `Restore ${entry.label} from ${snapshot.targetPath} without changing the asset?`
		);
		if (!confirmed) {
			return;
		}
		setBusy(true);
		try {
			const request = {
				nodeId: props.object.id,
				targetPath: snapshot.targetPath,
				targetIndex: snapshot.targetIndex,
				expectedRevision: snapshot.revision,
				expectedFingerprint: snapshot.fingerprint,
				entryIds: [entry.id],
				confirm: true,
			};
			if (action === "apply") {
				await applyPrefabInstanceOverrides(props.object.getScene(), request, { editor: props.editor });
			} else {
				await revertPrefabInstanceOverrides(props.object.getScene(), request, { editor: props.editor });
			}
			await load(snapshot.targetIndex);
			props.editor.layout.inspector.forceUpdate();
			toast.success(`${entry.label} ${action === "apply" ? "applied" : "reverted"}.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : `Could not ${action} prefab property.`);
		} finally {
			setBusy(false);
		}
	}

	if (!supported) {
		return props.children;
	}
	const value: IPrefabPropertyOverrideContext = {
		object: props.object,
		links,
		targetIndex,
		snapshot,
		busy,
		refreshVersion,
		setTargetIndex: (index) => void load(index),
		scheduleRefresh,
		apply: (entry) => mutate(entry, "apply"),
		revert: (entry) => mutate(entry, "revert"),
	};
	return (
		<PrefabPropertyOverrideContext.Provider value={value}>
			<div className="mb-2 rounded border border-blue-500/25 bg-blue-500/5 p-2 text-xs">
				<div className="mb-1 flex items-center justify-between gap-2">
					<span className="font-medium text-blue-300">Prefab property source</span>
					<span className="text-[10px] text-muted-foreground">{busy ? "Refreshing…" : `${snapshot?.total ?? 0} property/component override(s)`}</span>
				</div>
				<select
					className="h-8 w-full rounded border border-input bg-background px-2"
					value={targetIndex}
					disabled={busy || !links.length}
					onChange={(event) => value.setTargetIndex(Number(event.target.value))}
				>
					{links.map((link) => (
						<option key={`${link.index}:${link.path}`} value={link.index}>
							{link.index === 0 ? "Outer" : `Nested ${link.index}`} · {link.path} · {link.sourceNodeName}
						</option>
					))}
				</select>
			</div>
			{props.children}
		</PrefabPropertyOverrideContext.Provider>
	);
}

/** Resolves one field to its exact live prefab override entry, including proxy-object mappings. */
export function usePrefabFieldOverride(props: IPrefabFieldOverrideProps): {
	entry: any | null;
	busy: boolean;
	refreshVersion: number;
	notifyChanged: () => void;
	apply: () => void;
	revert: () => void;
} {
	const context = useContext(PrefabPropertyOverrideContext);
	if (!context || props.prefabOverride === false) {
		return { entry: null, busy: false, refreshVersion: 0, notifyChanged: () => undefined, apply: () => undefined, revert: () => undefined };
	}
	const target = typeof props.prefabOverride === "object" ? props.prefabOverride : {};
	const object = target.object ?? props.object;
	const entry = findPrefabFieldOverrideEntry(context.snapshot, object, target.property ?? props.property, target);
	return {
		entry,
		busy: context.busy,
		refreshVersion: context.refreshVersion,
		notifyChanged: context.scheduleRefresh,
		apply: () => entry && void context.apply(entry),
		revert: () => entry && void context.revert(entry),
	};
}

/** Wraps composite or class-based Inspector controls in the same exact component/property adornment used by primitive fields. */
export function PrefabFieldOverrideDecorator(props: IPrefabFieldOverrideProps & { children: ReactNode; className?: string }): ReactNode {
	const prefab = usePrefabFieldOverride(props);
	return (
		<div className={`${props.className ?? ""} ${prefab.entry ? "border-l-2 border-blue-500 bg-blue-500/5" : ""}`}>
			{prefab.entry && (
				<div className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] text-blue-300">
					<span className="truncate" title={prefab.entry.label}>
						Prefab override · {prefab.entry.kind}
					</span>
					<PrefabFieldOverrideActions {...prefab} />
				</div>
			)}
			{props.children}
		</div>
	);
}

/** Renders the compact per-property Apply/Revert controls used by all compatible fields. */
export function PrefabFieldOverrideActions(props: ReturnType<typeof usePrefabFieldOverride>): ReactNode {
	if (!props.entry) {
		return null;
	}
	return (
		<div className="ml-auto flex shrink-0 gap-1" onClick={(event) => event.stopPropagation()}>
			<Button className="h-6 px-1.5 text-[10px]" size="sm" variant="ghost" disabled={props.busy || !props.entry.canApply} onClick={props.apply}>
				Apply
			</Button>
			<Button className="h-6 px-1.5 text-[10px]" size="sm" variant="ghost" disabled={props.busy || !props.entry.canRevert} onClick={props.revert}>
				Revert
			</Button>
		</div>
	);
}
