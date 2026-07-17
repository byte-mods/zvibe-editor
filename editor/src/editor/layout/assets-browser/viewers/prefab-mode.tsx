import { basename } from "path/posix";

import { useEffect, useMemo, useRef, useState } from "react";

import { AbstractMesh, ArcRotateCamera, Engine, HemisphericLight, Scene, SceneLoader, Vector3 } from "babylonjs";

import {
	getPrefab,
	inspectPrefabAssetNodeProperty,
	inspectPrefabVariantStructure,
	inspectPrefabVariantComponents,
	inspectPrefabVariantRebase,
	rebasePrefabVariant,
	setPrefabAssetNodeProperties,
	setPrefabAssetNodeProperty,
	setPrefabVariantStructure,
	setPrefabVariantComponents,
	setPrefabVariantOverrides,
} from "../../../../mcp/prefabs/prefabs";
import { showAlert, showConfirm } from "../../../../ui/dialog";
import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { Editor } from "../../../main";

import "babylonjs-loaders";

interface IPrefabModeNode {
	sourceNodeName: string;
	name: string;
	parentId: string | null;
	position: [number, number, number];
	rotation: [number, number, number];
	scaling: [number, number, number];
	visibility: number;
	isVisible: boolean;
}

export function openPrefabMode(editor: Editor, absolutePath: string): void {
	showAlert(`Prefab Mode — ${basename(absolutePath)}`, <PrefabMode editor={editor} path={absolutePath} />, true);
}

function serializedNodes(document: any): IPrefabModeNode[] {
	return [...(document.meshes ?? []), ...(document.transformNodes ?? [])].map((node: any) => ({
		sourceNodeName: node.metadata?.babylonEditorPrefabSourceNodeName ?? node.name,
		name: node.name,
		parentId: node.parentId ?? null,
		position: Array.isArray(node.position) ? node.position : [0, 0, 0],
		rotation: Array.isArray(node.rotation) ? node.rotation : [0, 0, 0],
		scaling: Array.isArray(node.scaling) ? node.scaling : [1, 1, 1],
		visibility: typeof node.visibility === "number" ? node.visibility : 1,
		isVisible: node.isVisible !== false,
	}));
}

function PrefabMode(props: { editor: Editor; path: string }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const runtimeRef = useRef<{ engine: Engine; scene: Scene; meshes: Map<string, AbstractMesh> } | null>(null);
	const [reload, setReload] = useState(0);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [inspection, setInspection] = useState<any>(null);
	const [structure, setStructure] = useState<any>(null);
	const [components, setComponents] = useState<any>(null);
	const [nodes, setNodes] = useState<IPrefabModeNode[]>([]);
	const [selectedSourceName, setSelectedSourceName] = useState<string | null>(null);
	const [propertyPath, setPropertyPath] = useState("");
	const [propertyJson, setPropertyJson] = useState("");
	const [propertyInspection, setPropertyInspection] = useState<any>(null);
	const [newNodeName, setNewNodeName] = useState("");
	const [newDisplayName, setNewDisplayName] = useState("New Node");
	const [newNodeKind, setNewNodeKind] = useState<"transform" | "cloneMesh" | "nestedPrefab">("transform");
	const [nestedPrefabPath, setNestedPrefabPath] = useState("");
	const [reparentTarget, setReparentTarget] = useState("");
	const [componentKey, setComponentKey] = useState("");
	const [componentJson, setComponentJson] = useState("{}");
	const [selectedComponentKey, setSelectedComponentKey] = useState("");
	const selected = useMemo(() => nodes.find((node) => node.sourceNodeName === selectedSourceName) ?? null, [nodes, selectedSourceName]);
	const selectedStructure = useMemo(() => structure?.nodes?.find((node: any) => node.nodeName === selectedSourceName) ?? null, [structure, selectedSourceName]);
	const selectedComponents = useMemo(() => {
		const current = [...(components?.nodes?.find((node: any) => node.nodeName === selectedSourceName)?.components ?? [])];
		for (const removal of inspection?.componentOverrides?.removals ?? []) {
			if (removal.nodeName === selectedSourceName && !current.some((component: any) => component.componentKey === removal.componentKey)) {
				current.push({ componentKey: removal.componentKey, valueType: "removed override", bytes: 0 });
			}
		}
		return current;
	}, [components, inspection, selectedSourceName]);

	useEffect(() => {
		let cancelled = false;
		async function load(): Promise<void> {
			setLoading(true);
			setError(null);
			try {
				const [document, nextInspection, nextStructure, nextComponents] = await Promise.all([
					getPrefab(props.editor.layout.preview.scene, { path: props.path }),
					inspectPrefabVariantRebase(props.editor.layout.preview.scene, { path: props.path }),
					inspectPrefabVariantStructure(props.editor.layout.preview.scene, { path: props.path }),
					inspectPrefabVariantComponents(props.editor.layout.preview.scene, { path: props.path }),
				]);
				if (cancelled) {
					return;
				}
				const nextNodes = serializedNodes(document);
				setInspection(nextInspection);
				setStructure(nextStructure);
				setComponents(nextComponents);
				setNodes(nextNodes);
				setSelectedSourceName((current) => (current && nextNodes.some((node) => node.sourceNodeName === current) ? current : (nextNodes[0]?.sourceNodeName ?? null)));

				const engine = new Engine(canvasRef.current!, true, { antialias: true, audioEngine: false, adaptToDeviceRatio: true });
				const scene = new Scene(engine);
				scene.clearColor.set(0.025, 0.03, 0.04, 1);
				const imported = await SceneLoader.ImportMeshAsync("", "", `data:${JSON.stringify(document)}`, scene, undefined, ".babylon");
				if (cancelled) {
					scene.dispose();
					engine.dispose();
					return;
				}
				const camera = new ArcRotateCamera("prefab-mode-camera", -Math.PI * 0.7, Math.PI * 0.35, 10, Vector3.Zero(), scene);
				camera.attachControl(canvasRef.current!, true);
				camera.lowerRadiusLimit = 0.01;
				new HemisphericLight("prefab-mode-light", new Vector3(0.25, 1, 0.25), scene).intensity = 1.2;
				const meshes = new Map<string, AbstractMesh>();
				for (const mesh of imported.meshes) {
					if (mesh instanceof AbstractMesh) {
						const sourceName = mesh.metadata?.babylonEditorPrefabSourceNodeName ?? mesh.name;
						meshes.set(sourceName, mesh);
					}
				}
				if (imported.meshes.length) {
					camera.zoomOn(imported.meshes, true);
				}
				scene.activeCamera = camera;
				engine.runRenderLoop(() => scene.render());
				runtimeRef.current = { engine, scene, meshes };
			} catch (caught: any) {
				if (!cancelled) {
					setError(caught.message);
				}
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		}
		void load();
		return () => {
			cancelled = true;
			runtimeRef.current?.scene.dispose();
			runtimeRef.current?.engine.dispose();
			runtimeRef.current = null;
		};
	}, [props.path, reload]);

	useEffect(() => {
		for (const [sourceName, mesh] of runtimeRef.current?.meshes ?? []) {
			mesh.showBoundingBox = sourceName === selectedSourceName;
		}
	}, [selectedSourceName, reload]);

	useEffect(() => {
		setPropertyInspection(null);
		setPropertyJson("");
		setReparentTarget("");
		setSelectedComponentKey("");
	}, [selectedSourceName]);

	function updateSelected(update: Partial<IPrefabModeNode>): void {
		if (!selected) {
			return;
		}
		setNodes((current) => current.map((node) => (node.sourceNodeName === selected.sourceNodeName ? { ...node, ...update } : node)));
		const runtime = runtimeRef.current?.meshes.get(selected.sourceNodeName);
		if (!runtime) {
			return;
		}
		const value = { ...selected, ...update };
		runtime.name = value.name;
		runtime.position.set(...value.position);
		runtime.rotation.set(...value.rotation);
		runtime.scaling.set(...value.scaling);
		runtime.visibility = value.visibility;
		runtime.isVisible = value.isVisible;
	}

	function vectorInput(label: string, key: "position" | "rotation" | "scaling", value: [number, number, number]) {
		return (
			<div className="space-y-1">
				<div className="text-[11px] text-muted-foreground">{label}</div>
				<div className="grid grid-cols-3 gap-1">
					{value.map((component, index) => (
						<Input
							key={index}
							type="number"
							step="0.01"
							value={component}
							onChange={(event) => {
								const next = [...value] as [number, number, number];
								next[index] = Number(event.target.value);
								if (Number.isFinite(next[index])) {
									updateSelected({ [key]: next });
								}
							}}
						/>
					))}
				</div>
			</div>
		);
	}

	async function save(): Promise<void> {
		if (!selected || !inspection || inspection.conflicts.length) {
			return;
		}
		const confirmed = await showConfirm(
			"Save Prefab Mode changes?",
			`Write transform and visibility changes for source node ${selected.sourceNodeName} into ${inspection.path}?`
		);
		if (!confirmed) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await setPrefabAssetNodeProperties(props.editor.layout.preview.scene, {
				path: props.path,
				sourceNodeName: selected.sourceNodeName,
				properties: {
					name: selected.name,
					position: selected.position,
					rotation: selected.rotation,
					scaling: selected.scaling,
					visibility: selected.visibility,
					isVisible: selected.isVisible,
				},
				expectedRevision: inspection.resolvedRevision,
				confirm: true,
			});
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setSaving(false);
		}
	}

	async function rebase(): Promise<void> {
		if (!inspection?.variant || !inspection.baseRevision || inspection.conflicts.length) {
			return;
		}
		const confirmed = await showConfirm(
			"Rebase prefab variant?",
			`Persist ${inspection.path} against the exact current base revision ${inspection.baseRevision.slice(0, 12)}?`
		);
		if (!confirmed) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await rebasePrefabVariant(props.editor.layout.preview.scene, { path: props.path, expectedBaseRevision: inspection.baseRevision, confirm: true });
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setSaving(false);
		}
	}

	async function removeConflictedOverrides(): Promise<void> {
		if (!inspection?.variant || !inspection.conflicts.length) {
			return;
		}
		const conflicted = new Set(inspection.conflicts.map((conflict: any) => conflict.nodeName));
		const remaining = inspection.nodeOverrides.filter((override: any) => !conflicted.has(override.nodeName));
		const remainingProperties = inspection.propertyOverrides.filter(
			(override: any) => !inspection.conflicts.some((conflict: any) => conflict.nodeName === override.nodeName && (!conflict.path || conflict.path === override.path))
		);
		const remainingComponentAdditions = inspection.componentOverrides.additions.filter(
			(entry: any) =>
				!inspection.conflicts.some((conflict: any) => conflict.nodeName === entry.nodeName && (!conflict.path || conflict.path === `/metadata/${entry.componentKey}`))
		);
		const remainingComponentRemovals = inspection.componentOverrides.removals.filter(
			(entry: any) =>
				!inspection.conflicts.some((conflict: any) => conflict.nodeName === entry.nodeName && (!conflict.path || conflict.path === `/metadata/${entry.componentKey}`))
		);
		const confirmed = await showConfirm(
			"Remove conflicted prefab overrides?",
			`Remove ${inspection.nodeOverrides.length - remaining.length} missing or ambiguous source-node override(s) from ${inspection.path}? Current base content will become authoritative for those nodes.`
		);
		if (!confirmed) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await setPrefabVariantOverrides(props.editor.layout.preview.scene, {
				path: props.path,
				expectedRevision: inspection.resolvedRevision,
				rootOverrides: inspection.rootOverrides,
				nodeOverrides: remaining,
				propertyOverrides: remainingProperties,
				structuralOverrides: {
					removals: inspection.structuralOverrides.removals.filter((nodeName: string) => !conflicted.has(nodeName)),
					additions: inspection.structuralOverrides.additions.filter((addition: any) => !conflicted.has(addition.nodeName)),
					reparents: inspection.structuralOverrides.reparents.filter((entry: any) => !conflicted.has(entry.nodeName)),
				},
				componentOverrides: { additions: remainingComponentAdditions, removals: remainingComponentRemovals },
				confirm: true,
			});
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setSaving(false);
		}
	}

	async function inspectProperty(): Promise<void> {
		if (!selected) {
			return;
		}
		setError(null);
		try {
			const result = await inspectPrefabAssetNodeProperty(props.editor.layout.preview.scene, {
				path: props.path,
				sourceNodeName: selected.sourceNodeName,
				propertyPath,
			});
			setPropertyInspection(result);
			setPropertyJson(JSON.stringify(result.value, null, 2));
		} catch (caught: any) {
			setPropertyInspection(null);
			setError(caught.message);
		}
	}

	async function saveProperty(): Promise<void> {
		if (!selected || !propertyInspection) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await setPrefabAssetNodeProperty(props.editor.layout.preview.scene, {
				path: props.path,
				sourceNodeName: selected.sourceNodeName,
				propertyPath,
				value: JSON.parse(propertyJson),
				expectedRevision: propertyInspection.revision,
				confirm: true,
			});
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setSaving(false);
		}
	}

	async function resetPropertyOverride(): Promise<void> {
		if (!selected || !inspection?.variant || !propertyInspection?.overridden) {
			return;
		}
		const remaining = inspection.propertyOverrides.filter((override: any) => !(override.nodeName === selected.sourceNodeName && override.path === propertyPath));
		setSaving(true);
		setError(null);
		try {
			await setPrefabVariantOverrides(props.editor.layout.preview.scene, {
				path: props.path,
				expectedRevision: inspection.resolvedRevision,
				rootOverrides: inspection.rootOverrides,
				nodeOverrides: inspection.nodeOverrides,
				propertyOverrides: remaining,
				structuralOverrides: inspection.structuralOverrides,
				componentOverrides: inspection.componentOverrides,
				confirm: true,
			});
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setSaving(false);
		}
	}

	async function replaceStructure(structuralOverrides: any): Promise<void> {
		if (!inspection?.variant) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await setPrefabVariantStructure(props.editor.layout.preview.scene, {
				path: props.path,
				expectedRevision: inspection.resolvedRevision,
				structuralOverrides,
				confirm: true,
			});
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setSaving(false);
		}
	}

	async function addStructuralNode(): Promise<void> {
		if (!selected || !inspection?.variant || !newNodeName.trim()) {
			return;
		}
		await replaceStructure({
			...inspection.structuralOverrides,
			additions: [
				...inspection.structuralOverrides.additions,
				{
					nodeName: newNodeName.trim(),
					displayName: newDisplayName,
					parentNodeName: selected.sourceNodeName,
					kind: newNodeKind,
					...(newNodeKind === "cloneMesh" ? { cloneSourceNodeName: selected.sourceNodeName } : {}),
					...(newNodeKind === "nestedPrefab" ? { prefabPath: nestedPrefabPath } : {}),
					properties: {},
				},
			],
		});
	}

	async function reparentSelected(): Promise<void> {
		if (!selected || !inspection?.variant) {
			return;
		}
		const withoutCurrent = inspection.structuralOverrides.reparents.filter((entry: any) => entry.nodeName !== selected.sourceNodeName);
		const isAdded = inspection.structuralOverrides.additions.some((addition: any) => addition.nodeName === selected.sourceNodeName);
		await replaceStructure({
			...inspection.structuralOverrides,
			additions: inspection.structuralOverrides.additions.map((addition: any) =>
				addition.nodeName === selected.sourceNodeName ? { ...addition, parentNodeName: reparentTarget || null } : addition
			),
			reparents: isAdded ? withoutCurrent : [...withoutCurrent, { nodeName: selected.sourceNodeName, parentNodeName: reparentTarget || null }],
		});
	}

	async function removeSelectedNode(): Promise<void> {
		if (!selected || !inspection?.variant || structure?.nodes?.[0]?.nodeName === selected.sourceNodeName) {
			return;
		}
		const added = inspection.structuralOverrides.additions.some((addition: any) => addition.nodeName === selected.sourceNodeName);
		const removedNames = new Set<string>([selected.sourceNodeName]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of structure.nodes) {
				if (node.parentNodeName && removedNames.has(node.parentNodeName) && !removedNames.has(node.nodeName)) {
					removedNames.add(node.nodeName);
					changed = true;
				}
			}
		}
		const structuralOverrides = {
			...inspection.structuralOverrides,
			removals: added ? inspection.structuralOverrides.removals : [...inspection.structuralOverrides.removals, selected.sourceNodeName],
			additions: inspection.structuralOverrides.additions.filter((addition: any) => !removedNames.has(addition.nodeName)),
			reparents: inspection.structuralOverrides.reparents.filter((entry: any) => !removedNames.has(entry.nodeName)),
		};
		setSaving(true);
		setError(null);
		try {
			await setPrefabVariantOverrides(props.editor.layout.preview.scene, {
				path: props.path,
				expectedRevision: inspection.resolvedRevision,
				rootOverrides: inspection.rootOverrides,
				nodeOverrides: inspection.nodeOverrides.filter((override: any) => !removedNames.has(override.nodeName)),
				propertyOverrides: inspection.propertyOverrides.filter((override: any) => !removedNames.has(override.nodeName)),
				structuralOverrides,
				componentOverrides: {
					additions: inspection.componentOverrides.additions.filter((entry: any) => !removedNames.has(entry.nodeName)),
					removals: inspection.componentOverrides.removals.filter((entry: any) => !removedNames.has(entry.nodeName)),
				},
				confirm: true,
			});
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setSaving(false);
		}
	}

	async function replaceComponents(componentOverrides: any): Promise<void> {
		if (!inspection?.variant) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await setPrefabVariantComponents(props.editor.layout.preview.scene, {
				path: props.path,
				expectedRevision: inspection.resolvedRevision,
				componentOverrides,
				confirm: true,
			});
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setSaving(false);
		}
	}

	async function addComponentOverride(): Promise<void> {
		if (!selected || !componentKey.trim()) {
			return;
		}
		try {
			await replaceComponents({
				...inspection.componentOverrides,
				additions: [...inspection.componentOverrides.additions, { nodeName: selected.sourceNodeName, componentKey: componentKey.trim(), value: JSON.parse(componentJson) }],
			});
		} catch (caught: any) {
			setError(caught.message);
		}
	}

	async function removeComponentOverride(): Promise<void> {
		if (!selected || !selectedComponentKey) {
			return;
		}
		const addedHere = inspection.componentOverrides.additions.some((entry: any) => entry.nodeName === selected.sourceNodeName && entry.componentKey === selectedComponentKey);
		const removedHere = inspection.componentOverrides.removals.some((entry: any) => entry.nodeName === selected.sourceNodeName && entry.componentKey === selectedComponentKey);
		await replaceComponents({
			additions: inspection.componentOverrides.additions.filter((entry: any) => !(entry.nodeName === selected.sourceNodeName && entry.componentKey === selectedComponentKey)),
			removals:
				addedHere || removedHere
					? inspection.componentOverrides.removals.filter((entry: any) => !(entry.nodeName === selected.sourceNodeName && entry.componentKey === selectedComponentKey))
					: [...inspection.componentOverrides.removals, { nodeName: selected.sourceNodeName, componentKey: selectedComponentKey }],
		});
	}

	return (
		<div className="grid h-[72vh] w-[82vw] grid-cols-[240px_minmax(360px,1fr)_300px] overflow-hidden rounded border border-border bg-background">
			<div className="flex min-h-0 flex-col border-r border-border">
				<div className="border-b border-border p-3">
					<div className="font-medium">Isolated Prefab Hierarchy</div>
					<div className="truncate text-[11px] text-muted-foreground">{inspection?.path ?? props.path}</div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-2">
					{nodes.map((node) => (
						<button
							key={node.sourceNodeName}
							className={`mb-1 w-full rounded px-2 py-1.5 text-left text-xs ${node.sourceNodeName === selectedSourceName ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
							onClick={() => setSelectedSourceName(node.sourceNodeName)}
						>
							<div className="truncate">{node.name}</div>
							<div className="truncate text-[10px] opacity-70">source: {node.sourceNodeName}</div>
						</button>
					))}
				</div>
			</div>
			<div className="relative min-h-0 bg-black">
				<canvas ref={canvasRef} className="h-full w-full outline-none" />
				{loading && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm text-white">Loading isolated prefab…</div>}
				<div className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-[11px] text-white">Scene objects are hidden in Prefab Mode</div>
			</div>
			<div className="min-h-0 overflow-y-auto border-l border-border p-3">
				<div className="mb-3 flex items-center justify-between gap-2">
					<div>
						<div className="font-medium">Prefab Inspector</div>
						<div className="text-[11px] text-muted-foreground">
							{inspection?.variant ? `Variant of ${inspection.basePath}` : "Base prefab"} {inspection?.stale ? "· base changed" : ""}
						</div>
					</div>
					{inspection?.variant && inspection.stale && (
						<Button size="sm" variant="outline" disabled={saving || inspection.conflicts.length > 0} onClick={() => void rebase()}>
							Rebase
						</Button>
					)}
				</div>
				{inspection?.chain?.length > 1 && <div className="mb-3 rounded bg-muted p-2 text-[10px]">{inspection.chain.join(" → ")}</div>}
				{inspection?.conflicts?.map((conflict: any) => (
					<div key={`${conflict.code}-${conflict.nodeName}-${conflict.path ?? ""}`} className="mb-2 rounded bg-destructive/15 p-2 text-xs text-destructive">
						{conflict.message}
					</div>
				))}
				{inspection?.conflicts?.length > 0 && (
					<Button className="mb-3 w-full" size="sm" variant="destructive" disabled={saving} onClick={() => void removeConflictedOverrides()}>
						Remove Conflicted Overrides
					</Button>
				)}
				{error && <div className="mb-2 rounded bg-destructive/15 p-2 text-xs text-destructive">{error}</div>}
				{selected && (
					<div className="space-y-3">
						<div className="space-y-1">
							<div className="text-[11px] text-muted-foreground">Name</div>
							<Input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} />
						</div>
						{vectorInput("Position", "position", selected.position)}
						{vectorInput("Rotation (radians)", "rotation", selected.rotation)}
						{vectorInput("Scaling", "scaling", selected.scaling)}
						<div className="space-y-1">
							<div className="text-[11px] text-muted-foreground">Visibility</div>
							<Input
								type="number"
								min={0}
								max={1}
								step="0.05"
								value={selected.visibility}
								onChange={(event) => updateSelected({ visibility: Math.max(0, Math.min(1, Number(event.target.value))) })}
							/>
						</div>
						<label className="flex items-center gap-2 text-xs">
							<input type="checkbox" checked={selected.isVisible} onChange={(event) => updateSelected({ isVisible: event.target.checked })} /> Visible
						</label>
						<Button className="w-full" disabled={saving || loading || inspection?.conflicts?.length > 0} onClick={() => void save()}>
							{saving ? "Saving…" : inspection?.variant ? "Save Variant Override" : "Save Prefab"}
						</Button>
						{inspection?.variant && (
							<div className="border-t border-border pt-3">
								<div className="mb-1 text-xs font-medium">Structural Overrides</div>
								<div className="mb-2 text-[10px] text-muted-foreground">
									Add an empty transform or mesh clone below the selection, remove a variant node, or reparent it by stable source identity.
								</div>
								<Input value={newNodeName} placeholder="Stable source name" onChange={(event) => setNewNodeName(event.target.value)} />
								<Input className="mt-1" value={newDisplayName} placeholder="Display name" onChange={(event) => setNewDisplayName(event.target.value)} />
								<select
									className="mt-1 h-9 w-full rounded border border-input bg-background px-2 text-xs"
									value={newNodeKind}
									onChange={(event) => setNewNodeKind(event.target.value as "transform" | "cloneMesh" | "nestedPrefab")}
								>
									<option value="transform">Empty Transform</option>
									<option value="cloneMesh" disabled={selectedStructure?.kind !== "mesh"}>
										Clone Selected Mesh
									</option>
									<option value="nestedPrefab">Nested Prefab Asset</option>
								</select>
								{newNodeKind === "nestedPrefab" && (
									<Input
										className="mt-1"
										value={nestedPrefabPath}
										placeholder="assets/child.prefab"
										onChange={(event) => setNestedPrefabPath(event.target.value)}
									/>
								)}
								<Button
									className="mt-2 w-full"
									size="sm"
									variant="outline"
									disabled={saving || !newNodeName.trim() || (newNodeKind === "nestedPrefab" && !nestedPrefabPath.trim())}
									onClick={() => void addStructuralNode()}
								>
									Add Child Override
								</Button>
								<select
									className="mt-2 h-9 w-full rounded border border-input bg-background px-2 text-xs"
									value={reparentTarget}
									onChange={(event) => setReparentTarget(event.target.value)}
								>
									<option value="">Prefab root</option>
									{structure?.nodes
										?.filter((node: any) => node.nodeName !== selected.sourceNodeName)
										.map((node: any) => (
											<option key={node.nodeName} value={node.nodeName}>
												{node.displayName} ({node.nodeName})
											</option>
										))}
								</select>
								<div className="mt-2 grid grid-cols-2 gap-2">
									<Button
										size="sm"
										variant="outline"
										disabled={saving || structure?.nodes?.[0]?.nodeName === selected.sourceNodeName}
										onClick={() => void reparentSelected()}
									>
										Reparent
									</Button>
									<Button
										size="sm"
										variant="destructive"
										disabled={saving || structure?.nodes?.[0]?.nodeName === selected.sourceNodeName}
										onClick={() => void removeSelectedNode()}
									>
										Remove Node
									</Button>
								</div>
							</div>
						)}
						{inspection?.variant && (
							<div className="border-t border-border pt-3">
								<div className="mb-1 text-xs font-medium">Component Overrides</div>
								<div className="mb-2 text-[10px] text-muted-foreground">
									Add or remove serialized metadata components. Scripts and physics aggregates receive stricter runtime-shape validation.
								</div>
								<Input value={componentKey} placeholder="Component metadata key" onChange={(event) => setComponentKey(event.target.value)} />
								<textarea
									className="mt-1 min-h-20 w-full rounded border border-input bg-background p-2 font-mono text-[11px]"
									value={componentJson}
									onChange={(event) => setComponentJson(event.target.value)}
								/>
								<Button className="mt-1 w-full" size="sm" variant="outline" disabled={saving || !componentKey.trim()} onClick={() => void addComponentOverride()}>
									Add Component
								</Button>
								<select
									className="mt-2 h-9 w-full rounded border border-input bg-background px-2 text-xs"
									value={selectedComponentKey}
									onChange={(event) => setSelectedComponentKey(event.target.value)}
								>
									<option value="">Select existing component</option>
									{selectedComponents.map((component: any) => (
										<option key={component.componentKey} value={component.componentKey}>
											{component.componentKey} · {component.valueType} · {component.bytes} B
										</option>
									))}
								</select>
								<Button
									className="mt-1 w-full"
									size="sm"
									variant="destructive"
									disabled={saving || !selectedComponentKey}
									onClick={() => void removeComponentOverride()}
								>
									Remove / Reset Component
								</Button>
							</div>
						)}
						<div className="border-t border-border pt-3">
							<div className="mb-1 text-xs font-medium">Serialized Property Override</div>
							<div className="mb-2 text-[10px] text-muted-foreground">
								Existing safe JSON Pointer paths only. IDs, hierarchy, prototypes and transform/name fields are protected.
							</div>
							<Input value={propertyPath} placeholder="/metadata/gameplay/health" onChange={(event) => setPropertyPath(event.target.value)} />
							<Button className="mt-2 w-full" size="sm" variant="outline" disabled={saving || !propertyPath} onClick={() => void inspectProperty()}>
								Inspect Property
							</Button>
							{propertyInspection && (
								<div className="mt-2 space-y-2">
									<div className="text-[10px] text-muted-foreground">{propertyInspection.overridden ? "Variant override" : "Inherited/base value"}</div>
									<textarea
										className="min-h-24 w-full rounded border border-input bg-background p-2 font-mono text-[11px]"
										value={propertyJson}
										onChange={(event) => setPropertyJson(event.target.value)}
									/>
									<div className="grid grid-cols-2 gap-2">
										<Button size="sm" disabled={saving || inspection?.conflicts?.length > 0} onClick={() => void saveProperty()}>
											Apply Value
										</Button>
										<Button size="sm" variant="outline" disabled={saving || !propertyInspection.overridden} onClick={() => void resetPropertyOverride()}>
											Reset Override
										</Button>
									</div>
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
