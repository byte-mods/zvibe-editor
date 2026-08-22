import { basename } from "path/posix";

import { useEffect, useMemo, useRef, useState } from "react";

import {
	AbstractMesh,
	ArcRotateCamera,
	Color3,
	Engine,
	HemisphericLight,
	Node,
	PointerEventTypes,
	Quaternion,
	Scene,
	SceneLoader,
	SceneSerializer,
	StandardMaterial,
	Vector3,
} from "babylonjs";

import {
	getPrefab,
	inspectPrefabAssetNodeProperty,
	inspectPrefabVariantStructure,
	inspectPrefabVariantComponents,
	inspectPrefabVariantConflicts,
	inspectPrefabVariantRebase,
	inspectPrefabInstanceLinks,
	inspectPrefabInstanceOverrides,
	rebasePrefabVariant,
	resolvePrefabVariantConflicts,
	setPrefabAssetNodesProperties,
	setPrefabAssetNodeProperty,
	setPrefabVariantStructure,
	setPrefabVariantComponents,
	setPrefabVariantOverrides,
} from "../../../../mcp/prefabs/prefabs";
import { DialogReturnType, showAlert, showConfirm } from "../../../../ui/dialog";
import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { Editor } from "../../../main";
import { normalizePrefabStageSettings, prefabStageSettingsFingerprint } from "../../../../project/prefab-stage";
import { EditorPrefabStageMode, IEditorPrefabStageSettings } from "../../../../project/typings";
import { replacePrefabStageSettingsForEditor } from "../../../../mcp/prefabs/stage-settings";
import { PrefabConflictComparisonPresentation } from "./prefab-conflict-comparison";
import { PrefabReviewPanel } from "./prefab-review-panel";

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

interface IPrefabConflictResolutionDraft {
	choice: "base" | "variant" | "retarget";
	targetNodeName?: string;
	targetParentNodeName?: string | null;
	targetPropertyPath?: string;
	targetCloneSourceNodeName?: string;
}

export interface IOpenPrefabModeOptions {
	instance?: { nodeId?: string; nodeName?: string; targetIndex?: number };
	mode?: EditorPrefabStageMode;
}

let activePrefabModeDialog: DialogReturnType | null = null;

export function openPrefabMode(editor: Editor, absolutePath: string, options?: IOpenPrefabModeOptions): void {
	activePrefabModeDialog?.close();
	const dialog = showAlert(`Prefab Stage — ${basename(absolutePath)}`, <PrefabMode editor={editor} path={absolutePath} options={options} />, true);
	activePrefabModeDialog = dialog;
	void dialog.wait().finally(() => {
		if (activePrefabModeDialog === dialog) {
			activePrefabModeDialog = null;
		}
	});
}

/** Closes the active Prefab Stage dialog, if one is open. */
export function closePrefabMode(): boolean {
	const dialog = activePrefabModeDialog;
	if (!dialog) {
		return false;
	}
	activePrefabModeDialog = null;
	dialog.close();
	return true;
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

function PrefabMode(props: { editor: Editor; path: string; options?: IOpenPrefabModeOptions }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const runtimeRef = useRef<{ engine: Engine; scene: Scene; nodes: Map<string, Node>; stageMeshes: Set<AbstractMesh>; contextMeshes: Set<AbstractMesh> } | null>(null);
	const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [reload, setReload] = useState(0);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [settingsSaving, setSettingsSaving] = useState(false);
	const [autoSaveBlocked, setAutoSaveBlocked] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [inspection, setInspection] = useState<any>(null);
	const [mergeInspection, setMergeInspection] = useState<any>(null);
	const [conflictResolutions, setConflictResolutions] = useState<Record<string, IPrefabConflictResolutionDraft>>({});
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
	const [settings, setSettings] = useState<IEditorPrefabStageSettings>(() =>
		normalizePrefabStageSettings({
			...props.editor.state.prefabStage,
			mode: props.options?.instance ? (props.options.mode ?? props.editor.state.prefabStage.mode) : "isolation",
		})
	);
	const [dirtySourceNames, setDirtySourceNames] = useState<Set<string>>(() => new Set());
	const [contextWarning, setContextWarning] = useState<string | null>(null);
	const selected = useMemo(() => nodes.find((node) => node.sourceNodeName === selectedSourceName) ?? null, [nodes, selectedSourceName]);
	const rootSourceName = useMemo(() => nodes.find((node) => node.parentId === null)?.sourceNodeName ?? null, [nodes]);
	const rootTransformLocked = settings.mode === "context" && !!props.options?.instance && selectedSourceName === rootSourceName;
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
			let pendingEngine: Engine | null = null;
			let pendingScene: Scene | null = null;
			setLoading(true);
			setError(null);
			try {
				const [document, nextInspection, nextStructure, nextComponents] = await Promise.all([
					getPrefab(props.editor.layout.preview.scene, { path: props.path }),
					inspectPrefabVariantRebase(props.editor.layout.preview.scene, { path: props.path }),
					inspectPrefabVariantStructure(props.editor.layout.preview.scene, { path: props.path }),
					inspectPrefabVariantComponents(props.editor.layout.preview.scene, { path: props.path }),
				]);
				const nextMergeInspection = nextInspection.variant
					? await inspectPrefabVariantConflicts(props.editor.layout.preview.scene, {
							path: props.path,
							...(props.options?.instance ?? {}),
							limit: 500,
						})
					: null;
				if (cancelled) {
					return;
				}
				const nextNodes = serializedNodes(document);
				setInspection(nextInspection);
				setMergeInspection(nextMergeInspection);
				setConflictResolutions((current) =>
					Object.fromEntries(Object.entries(current).filter(([id]) => nextMergeInspection?.conflicts.some((conflict: any) => conflict.id === id)))
				);
				setStructure(nextStructure);
				setComponents(nextComponents);
				setNodes(nextNodes);
				setSelectedSourceName((current) => (current && nextNodes.some((node) => node.sourceNodeName === current) ? current : (nextNodes[0]?.sourceNodeName ?? null)));

				let instanceInspection: any | null = null;
				let selectedBoundary: any | null = null;
				const overrideNodeIds = new Set<string>();
				if (settings.mode === "context" && props.options?.instance) {
					instanceInspection = await inspectPrefabInstanceLinks(props.editor.layout.preview.scene, props.options.instance);
					const targetIndex = props.options.instance.targetIndex ?? 0;
					selectedBoundary = instanceInspection.links[targetIndex];
					if (!selectedBoundary) {
						throw new Error(`Prefab source boundary ${targetIndex} is not available on the selected live instance.`);
					}
					if (selectedBoundary.path !== nextInspection.path) {
						throw new Error(`The selected live boundary references ${selectedBoundary.path}, not ${nextInspection.path}.`);
					}
					if (settings.showOverrides) {
						const request = {
							nodeId: instanceInspection.nodeId,
							targetPath: selectedBoundary.path,
							targetIndex,
							limit: 500,
						};
						const first = await inspectPrefabInstanceOverrides(props.editor.layout.preview.scene, request);
						for (const entry of first.entries) {
							if (typeof entry.nodeId === "string") {
								overrideNodeIds.add(entry.nodeId);
							}
						}
						for (let offset = first.entries.length; offset < first.total; offset += 500) {
							const page = await inspectPrefabInstanceOverrides(props.editor.layout.preview.scene, { ...request, offset });
							if (page.fingerprint !== first.fingerprint) {
								throw new Error("Live prefab overrides changed while opening Prefab Stage.");
							}
							for (const entry of page.entries) {
								if (typeof entry.nodeId === "string") {
									overrideNodeIds.add(entry.nodeId);
								}
							}
						}
					}
					if (cancelled) {
						return;
					}
				}

				const engine = new Engine(canvasRef.current!, true, { antialias: true, audioEngine: false, adaptToDeviceRatio: true });
				pendingEngine = engine;
				const useSceneEnvironment = settings.mode === "context" || settings.environment === "scene";
				let scene: Scene;
				if (useSceneEnvironment) {
					try {
						const contextDocument = SceneSerializer.Serialize(props.editor.layout.preview.scene);
						scene = await SceneLoader.LoadAsync("", `data:${JSON.stringify(contextDocument)}`, engine, undefined, ".babylon");
						if (!cancelled) {
							setContextWarning(settings.mode === "context" && !selectedBoundary ? "Open Prefab Stage from a live instance to display scene context." : null);
						}
					} catch (caught: any) {
						// The loader may have attached a partially constructed scene before failing.
						for (const failedScene of [...engine.scenes]) {
							failedScene.dispose();
						}
						scene = new Scene(engine);
						if (!cancelled) {
							setContextWarning(`Scene environment could not be cloned; using the neutral stage. ${caught.message}`);
						}
					}
				} else {
					scene = new Scene(engine);
					setContextWarning(null);
				}
				pendingScene = scene;
				if (cancelled) {
					scene.dispose();
					engine.dispose();
					pendingScene = null;
					pendingEngine = null;
					return;
				}
				if (!useSceneEnvironment || settings.environment === "neutral") {
					scene.clearColor.set(...settings.backgroundColor);
				}
				const contextMeshes = new Set<AbstractMesh>(scene.meshes);
				// Context is visual reference only: stop authored playback/physics and freeze every copied transform before importing the editable source.
				scene.stopAllAnimations();
				scene.disablePhysicsEngine();
				for (const node of [...scene.transformNodes, ...scene.meshes]) {
					node.freezeWorldMatrix();
				}
				const contextBoundaryRoot = selectedBoundary ? scene.getNodeById(selectedBoundary.boundaryRootNodeId) : null;
				const contextBoundaryNodes = new Set<Node>(contextBoundaryRoot ? [contextBoundaryRoot, ...contextBoundaryRoot.getDescendants(false)] : []);
				const grayMaterial = new StandardMaterial("prefab-stage-context-gray", scene);
				grayMaterial.diffuseColor = new Color3(0.32, 0.34, 0.38);
				grayMaterial.specularColor = Color3.Black();
				for (const mesh of contextMeshes) {
					mesh.isPickable = false;
					const boundaryMesh = contextBoundaryNodes.has(mesh);
					if (settings.mode !== "context") {
						mesh.isVisible = false;
					} else if (boundaryMesh) {
						const showOverride = settings.showOverrides && overrideNodeIds.has(mesh.id);
						mesh.isVisible = showOverride;
						mesh.renderOverlay = showOverride;
						mesh.overlayColor = new Color3(0.1, 0.55, 1);
						mesh.overlayAlpha = 0.35;
					} else {
						mesh.isVisible = settings.contextAppearance !== "hidden";
						if (settings.contextAppearance === "gray") {
							mesh.material = grayMaterial;
						}
					}
				}
				if (!useSceneEnvironment || scene.lights.length === 0 || settings.environment === "neutral") {
					for (const light of [...scene.lights]) {
						light.dispose();
					}
					new HemisphericLight("prefab-stage-light", new Vector3(0.25, 1, 0.25), scene).intensity = settings.lightIntensity;
				}
				const imported = await SceneLoader.ImportMeshAsync("", "", `data:${JSON.stringify(document)}`, scene, undefined, ".babylon");
				if (cancelled) {
					scene.dispose();
					engine.dispose();
					return;
				}
				const camera = new ArcRotateCamera("prefab-mode-camera", -Math.PI * 0.7, Math.PI * 0.35, 10, Vector3.Zero(), scene);
				camera.attachControl(canvasRef.current!, true);
				camera.lowerRadiusLimit = 0.01;
				const stageNodes = [...imported.meshes, ...imported.transformNodes] as Node[];
				const nodesBySourceName = new Map<string, Node>();
				const stageMeshes = new Set<AbstractMesh>();
				for (const node of stageNodes) {
					const sourceName = node.metadata?.babylonEditorPrefabSourceNodeName ?? node.name;
					node.metadata ??= {};
					node.metadata.babylonEditorPrefabStageSourceName = sourceName;
					nodesBySourceName.set(sourceName, node);
					if (node instanceof AbstractMesh) {
						node.isPickable = true;
						stageMeshes.add(node);
					}
				}
				if (selectedBoundary && instanceInspection) {
					const liveRoot = props.editor.layout.preview.scene.getNodeById(selectedBoundary.boundaryRootNodeId);
					const sourceRootName = nextNodes.find((node) => node.parentId === null)?.sourceNodeName;
					const stageRoot = (sourceRootName ? nodesBySourceName.get(sourceRootName) : null) ?? stageNodes.find((node) => !node.parent);
					if (liveRoot && stageRoot && "position" in stageRoot) {
						const scaling = Vector3.One();
						const rotation = Quaternion.Identity();
						const position = Vector3.Zero();
						liveRoot.computeWorldMatrix(true).decompose(scaling, rotation, position);
						(stageRoot as any).position.copyFrom(position);
						(stageRoot as any).rotationQuaternion = rotation;
						(stageRoot as any).scaling.copyFrom(scaling);
					}
				}
				if (imported.meshes.length) {
					camera.zoomOn(imported.meshes, true);
				}
				scene.activeCamera = camera;
				scene.onPointerObservable.add((event) => {
					if (event.type !== PointerEventTypes.POINTERPICK || !event.pickInfo?.hit || !event.pickInfo.pickedMesh) {
						return;
					}
					const sourceName = event.pickInfo.pickedMesh.metadata?.babylonEditorPrefabStageSourceName;
					if (typeof sourceName === "string") {
						setSelectedSourceName(sourceName);
					}
				});
				engine.runRenderLoop(() => scene.render());
				runtimeRef.current = { engine, scene, nodes: nodesBySourceName, stageMeshes, contextMeshes };
				pendingScene = null;
				pendingEngine = null;
			} catch (caught: any) {
				pendingScene?.dispose();
				pendingEngine?.dispose();
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
	}, [props.path, props.options?.instance, reload, settings]);

	useEffect(() => {
		for (const [sourceName, node] of runtimeRef.current?.nodes ?? []) {
			if (node instanceof AbstractMesh) {
				node.showBoundingBox = sourceName === selectedSourceName;
			}
		}
	}, [selectedSourceName, reload]);

	useEffect(() => {
		setPropertyInspection(null);
		setPropertyJson("");
		setReparentTarget("");
		setSelectedComponentKey("");
	}, [selectedSourceName]);

	useEffect(() => {
		if (autoSaveTimerRef.current) {
			clearTimeout(autoSaveTimerRef.current);
			autoSaveTimerRef.current = null;
		}
		if (!settings.autoSave || autoSaveBlocked || !dirtySourceNames.size || saving || !inspection || inspection.conflicts.length) {
			return;
		}
		autoSaveTimerRef.current = setTimeout(() => void persistDirtySourceNames([...dirtySourceNames], true), 650);
		return () => {
			if (autoSaveTimerRef.current) {
				clearTimeout(autoSaveTimerRef.current);
				autoSaveTimerRef.current = null;
			}
		};
	}, [autoSaveBlocked, dirtySourceNames, inspection, nodes, saving, settings.autoSave]);

	function updateSelected(update: Partial<IPrefabModeNode>): void {
		if (!selected || saving) {
			return;
		}
		setAutoSaveBlocked(false);
		setNodes((current) => current.map((node) => (node.sourceNodeName === selected.sourceNodeName ? { ...node, ...update } : node)));
		setDirtySourceNames((current) => new Set(current).add(selected.sourceNodeName));
		const runtime = runtimeRef.current?.nodes.get(selected.sourceNodeName) as any;
		if (!runtime) {
			return;
		}
		const value = { ...selected, ...update };
		runtime.name = value.name;
		runtime.position.set(...value.position);
		runtime.rotation.set(...value.rotation);
		runtime.scaling.set(...value.scaling);
		if ("visibility" in runtime) {
			runtime.visibility = value.visibility;
		}
		if ("isVisible" in runtime) {
			runtime.isVisible = value.isVisible;
		}
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
							disabled={saving || rootTransformLocked}
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

	async function updateStageSettings(update: Partial<IEditorPrefabStageSettings>): Promise<void> {
		if (settingsSaving || saving) {
			return;
		}
		const previous = settings;
		const next = normalizePrefabStageSettings({ ...settings, ...update });
		setSettings(next);
		setSettingsSaving(true);
		setError(null);
		try {
			const result = await replacePrefabStageSettingsForEditor(props.editor, prefabStageSettingsFingerprint(previous), next);
			setSettings(result.settings);
			if (update.autoSave !== undefined) {
				setAutoSaveBlocked(false);
			}
		} catch (caught: any) {
			setSettings(normalizePrefabStageSettings(props.editor.state.prefabStage));
			setError(caught.message);
		} finally {
			setSettingsSaving(false);
		}
	}

	async function persistDirtySourceNames(sourceNames: string[], automatic = false): Promise<void> {
		if (!sourceNames.length || !inspection || inspection.conflicts.length) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const sourceSet = new Set(sourceNames);
			await setPrefabAssetNodesProperties(props.editor.layout.preview.scene, {
				path: props.path,
				changes: nodes
					.filter((node) => sourceSet.has(node.sourceNodeName))
					.map((node) => ({
						sourceNodeName: node.sourceNodeName,
						properties: {
							name: node.name,
							position: node.position,
							rotation: node.rotation,
							scaling: node.scaling,
							visibility: node.visibility,
							isVisible: node.isVisible,
						},
					})),
				expectedRevision: inspection.resolvedRevision,
				confirm: true,
			});
			setDirtySourceNames((current) => new Set([...current].filter((sourceName) => !sourceSet.has(sourceName))));
			setAutoSaveBlocked(false);
			setReload((value) => value + 1);
		} catch (caught: any) {
			setError(caught.message);
			if (automatic) {
				// A stale lease or I/O failure needs a user decision; do not hammer the file forever.
				setAutoSaveBlocked(true);
			}
		} finally {
			setSaving(false);
		}
	}

	async function save(): Promise<void> {
		if (!dirtySourceNames.size || !inspection || inspection.conflicts.length) {
			return;
		}
		const confirmed = await showConfirm("Save Prefab Stage changes?", `Atomically write ${dirtySourceNames.size} changed source node(s) into ${inspection.path}?`);
		if (confirmed) {
			await persistDirtySourceNames([...dirtySourceNames], false);
		}
	}

	async function discardDirtyChanges(): Promise<void> {
		if (!dirtySourceNames.size || saving) {
			return;
		}
		const confirmed = await showConfirm("Discard Prefab Stage changes?", `Reload ${dirtySourceNames.size} unsaved source node(s) from ${inspection?.path ?? props.path}?`);
		if (!confirmed) {
			return;
		}
		setDirtySourceNames(new Set());
		setAutoSaveBlocked(false);
		setReload((value) => value + 1);
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

	function setConflictResolution(conflictId: string, update: Partial<IPrefabConflictResolutionDraft>): void {
		setConflictResolutions((current) => ({
			...current,
			[conflictId]: { ...(current[conflictId] ?? { choice: "base" }), ...update },
		}));
	}

	async function resolveConflicts(): Promise<void> {
		if (!mergeInspection?.conflicts.length || mergeInspection.inheritedConflicts.length) {
			return;
		}
		const unresolved = mergeInspection.conflicts.filter((conflict: any) => !conflictResolutions[conflict.id]);
		if (unresolved.length) {
			setError(`Choose an explicit resolution for all ${mergeInspection.conflicts.length} conflict(s); ${unresolved.length} remain unresolved.`);
			return;
		}
		const confirmed = await showConfirm(
			"Resolve prefab conflicts?",
			`Atomically apply ${mergeInspection.conflicts.length} explicit base, variant, or retarget choice(s) to ${mergeInspection.path}? The exact variant${mergeInspection.liveFingerprint ? ", base, and live-instance" : " and base"} leases will be verified first.`
		);
		if (!confirmed) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await resolvePrefabVariantConflicts(props.editor.layout.preview.scene, {
				path: props.path,
				expectedRevision: mergeInspection.revision,
				expectedBaseRevision: mergeInspection.baseRevision,
				...(props.options?.instance ?? {}),
				...(mergeInspection.liveFingerprint ? { expectedLiveFingerprint: mergeInspection.liveFingerprint } : {}),
				resolutions: mergeInspection.conflicts.map((conflict: any) => ({ conflictId: conflict.id, ...conflictResolutions[conflict.id] })),
				confirm: true,
			});
			setConflictResolutions({});
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

	function renderConflictCard(conflict: any) {
		const draft = conflictResolutions[conflict.id];
		const uniqueTargets = mergeInspection?.targets.filter((target: any) => target.unique) ?? [];
		const collection = conflict.origin?.collection as string | undefined;
		const retargetsNode = ["nodeOverrides", "propertyOverrides", "structuralRemovals", "structuralReparents", "componentAdditions", "componentRemovals"].includes(
			collection ?? ""
		);
		const retargetsParent = collection === "structuralAdditions" || collection === "structuralReparents";
		const retargetsProperty = collection === "propertyOverrides";
		const retargetsClone = collection === "structuralAdditions";
		return (
			<div key={conflict.id} className="space-y-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs">
				<div className="flex items-start justify-between gap-2">
					<div>
						<div className="font-medium text-destructive">{conflict.message}</div>
						<div className="text-[10px] text-muted-foreground">
							{conflict.code} · {collection}[{conflict.origin?.index}] · {conflict.nodeName}
							{conflict.path ? ` · ${conflict.path}` : ""}
						</div>
					</div>
					<div className="rounded bg-background/70 px-1.5 py-0.5 text-[10px]">{draft ? `Choice: ${draft.choice}` : "Unresolved"}</div>
				</div>
				<PrefabConflictComparisonPresentation conflict={conflict} />
				<div className="flex flex-wrap gap-1">
					{conflict.choices.map((choice: "base" | "variant" | "retarget") => (
						<Button
							key={choice}
							size="sm"
							variant={draft?.choice === choice ? "default" : "outline"}
							disabled={saving}
							onClick={() =>
								setConflictResolution(conflict.id, {
									choice,
									...(choice === "retarget" && retargetsProperty ? { targetPropertyPath: conflict.path ?? undefined } : {}),
								})
							}
						>
							{choice === "base" ? "Use Base" : choice === "variant" ? "Keep Variant" : "Retarget…"}
						</Button>
					))}
				</div>
				{draft?.choice === "retarget" && (
					<div className="space-y-1 rounded bg-background/60 p-2">
						{collection === "structuralAdditions" && (
							<Input
								value={draft.targetNodeName ?? ""}
								placeholder="New stable identity (only when current identity collides)"
								onChange={(event) => setConflictResolution(conflict.id, { targetNodeName: event.target.value || undefined })}
							/>
						)}
						{retargetsNode && (
							<select
								className="h-9 w-full rounded border border-input bg-background px-2"
								value={draft.targetNodeName ?? ""}
								onChange={(event) => setConflictResolution(conflict.id, { targetNodeName: event.target.value || undefined })}
							>
								<option value="">Select exact target node…</option>
								{uniqueTargets.map((target: any) => (
									<option key={target.nodeName} value={target.nodeName}>
										{target.displayName} · {target.nodeName}
									</option>
								))}
							</select>
						)}
						{retargetsParent && (
							<select
								className="h-9 w-full rounded border border-input bg-background px-2"
								value={draft.targetParentNodeName === null ? "__root__" : (draft.targetParentNodeName ?? "")}
								onChange={(event) =>
									setConflictResolution(conflict.id, { targetParentNodeName: event.target.value === "__root__" ? null : event.target.value || undefined })
								}
							>
								<option value="">Keep current parent target</option>
								<option value="__root__">Prefab Root</option>
								{uniqueTargets.map((target: any) => (
									<option key={target.nodeName} value={target.nodeName}>
										Parent: {target.displayName} · {target.nodeName}
									</option>
								))}
							</select>
						)}
						{retargetsProperty && (
							<Input
								value={draft.targetPropertyPath ?? ""}
								placeholder="Existing JSON Pointer, e.g. /metadata/gameplay/health"
								onChange={(event) => setConflictResolution(conflict.id, { targetPropertyPath: event.target.value || undefined })}
							/>
						)}
						{retargetsClone && (
							<select
								className="h-9 w-full rounded border border-input bg-background px-2"
								value={draft.targetCloneSourceNodeName ?? ""}
								onChange={(event) => setConflictResolution(conflict.id, { targetCloneSourceNodeName: event.target.value || undefined })}
							>
								<option value="">Keep current clone source</option>
								{uniqueTargets
									.filter((target: any) => target.kind === "mesh")
									.map((target: any) => (
										<option key={target.nodeName} value={target.nodeName}>
											Clone: {target.displayName} · {target.nodeName}
										</option>
									))}
							</select>
						)}
					</div>
				)}
			</div>
		);
	}
	// Rebuilding the Stage for appearance settings would otherwise replace unsaved node values.
	const stageControlsDisabled = saving || settingsSaving || dirtySourceNames.size > 0;

	return (
		<div className="grid h-[82vh] w-[94vw] grid-cols-[240px_minmax(360px,1fr)_500px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded border border-border bg-background">
			<div className="col-span-3 flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
				<span className="font-medium">Prefab Stage</span>
				<select
					className="h-8 rounded border border-input bg-background px-2"
					value={settings.mode}
					disabled={stageControlsDisabled}
					onChange={(event) => void updateStageSettings({ mode: event.target.value as EditorPrefabStageMode })}
				>
					<option value="isolation">Isolation</option>
					<option value="context" disabled={!props.options?.instance}>
						In Context
					</option>
				</select>
				<select
					className="h-8 rounded border border-input bg-background px-2"
					value={settings.contextAppearance}
					disabled={stageControlsDisabled || settings.mode !== "context"}
					onChange={(event) => void updateStageSettings({ contextAppearance: event.target.value as IEditorPrefabStageSettings["contextAppearance"] })}
				>
					<option value="normal">Context: Normal</option>
					<option value="gray">Context: Gray</option>
					<option value="hidden">Context: Hidden</option>
				</select>
				<select
					className="h-8 rounded border border-input bg-background px-2"
					value={settings.environment}
					disabled={stageControlsDisabled}
					onChange={(event) => void updateStageSettings({ environment: event.target.value as IEditorPrefabStageSettings["environment"] })}
				>
					<option value="neutral">Neutral Environment</option>
					<option value="scene">Scene Environment</option>
				</select>
				<label className="flex items-center gap-1">
					<input
						type="checkbox"
						checked={settings.showOverrides}
						disabled={stageControlsDisabled}
						onChange={(event) => void updateStageSettings({ showOverrides: event.target.checked })}
					/>{" "}
					Show Overrides
				</label>
				<label className="flex items-center gap-1">
					<input
						type="checkbox"
						checked={settings.autoSave}
						disabled={stageControlsDisabled}
						onChange={(event) => void updateStageSettings({ autoSave: event.target.checked })}
					/>{" "}
					Auto Save
				</label>
				<label className="flex items-center gap-1">
					Light
					<Input
						className="h-8 w-20"
						type="number"
						disabled={stageControlsDisabled}
						min={0}
						max={16}
						step={0.1}
						value={settings.lightIntensity}
						onChange={(event) => void updateStageSettings({ lightIntensity: Number(event.target.value) })}
					/>
				</label>
				<label className="flex items-center gap-1" title="Neutral environment background RGBA">
					Background
					{settings.backgroundColor.map((component, index) => (
						<Input
							key={index}
							className="h-8 w-14 px-1"
							type="number"
							disabled={stageControlsDisabled}
							min={0}
							max={1}
							step={0.01}
							value={component}
							onChange={(event) => {
								const backgroundColor = [...settings.backgroundColor] as [number, number, number, number];
								backgroundColor[index] = Number(event.target.value);
								void updateStageSettings({ backgroundColor });
							}}
						/>
					))}
				</label>
				<span className="ml-auto text-muted-foreground">
					{settingsSaving
						? "Saving Stage settings…"
						: autoSaveBlocked
							? `Auto Save paused · ${dirtySourceNames.size} unsaved node(s)`
							: dirtySourceNames.size
								? `${dirtySourceNames.size} unsaved node(s)`
								: "Source up to date"}
				</span>
				{dirtySourceNames.size > 0 && (
					<Button size="sm" variant="ghost" disabled={saving} onClick={() => void discardDirtyChanges()}>
						Discard
					</Button>
				)}
			</div>
			<div className="flex min-h-0 flex-col border-r border-border">
				<div className="border-b border-border p-3">
					<div className="font-medium">Prefab Hierarchy</div>
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
				<div className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-[11px] text-white">
					{settings.mode === "context" ? `Scene context is locked · ${settings.contextAppearance}` : "Source isolated from scene objects"}
				</div>
				{contextWarning && <div className="absolute bottom-3 left-3 right-3 rounded bg-amber-950/85 px-2 py-1 text-[11px] text-amber-100">{contextWarning}</div>}
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
				<PrefabReviewPanel editor={props.editor} scene={props.editor.layout.preview.scene} path={props.path} currentRevision={inspection?.resolvedRevision ?? null} />
				{inspection?.chain?.length > 1 && <div className="mb-3 rounded bg-muted p-2 text-[10px]">{inspection.chain.join(" → ")}</div>}
				{mergeInspection?.inheritedConflicts?.length > 0 && (
					<div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
						<div className="font-medium">Inherited conflicts must be repaired at their owning variant</div>
						{mergeInspection.inheritedConflicts.map((conflict: any) => (
							<div key={conflict.id} className="mt-1">
								{conflict.ownerPath ?? mergeInspection.basePath}: {conflict.message}
							</div>
						))}
					</div>
				)}
				{mergeInspection?.conflicts?.length > 0 && (
					<div className="mb-3 space-y-2">
						<div className="rounded border border-blue-500/30 bg-blue-500/10 p-2 text-[11px]">
							<div className="font-medium">Visual Prefab Merge</div>
							<div className="text-muted-foreground">
								Compare the current base, authored variant override, and {mergeInspection.liveFingerprint ? "exact live instance" : "resolved preview"}. Every
								conflict needs an explicit choice; ambiguous identities are never selected automatically.
							</div>
						</div>
						{mergeInspection.conflicts.map((conflict: any) => renderConflictCard(conflict))}
						<Button
							className="w-full"
							variant="destructive"
							disabled={saving || mergeInspection.inheritedConflicts.length > 0 || Object.keys(conflictResolutions).length !== mergeInspection.conflicts.length}
							onClick={() => void resolveConflicts()}
						>
							{saving
								? "Resolving…"
								: `Resolve ${Object.keys(conflictResolutions).length}/${mergeInspection.conflicts.length} Conflict${mergeInspection.conflicts.length === 1 ? "" : "s"}`}
						</Button>
					</div>
				)}
				{error && <div className="mb-2 rounded bg-destructive/15 p-2 text-xs text-destructive">{error}</div>}
				{selected && (
					<div className="space-y-3">
						{rootTransformLocked && (
							<div className="rounded border border-blue-500/30 bg-blue-500/10 p-2 text-[11px] text-blue-200">
								The root transform is locked In Context so the source remains aligned to the live instance pose.
							</div>
						)}
						<div className="space-y-1">
							<div className="text-[11px] text-muted-foreground">Name</div>
							<Input disabled={saving} value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} />
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
								disabled={saving}
								value={selected.visibility}
								onChange={(event) => updateSelected({ visibility: Math.max(0, Math.min(1, Number(event.target.value))) })}
							/>
						</div>
						<label className="flex items-center gap-2 text-xs">
							<input type="checkbox" disabled={saving} checked={selected.isVisible} onChange={(event) => updateSelected({ isVisible: event.target.checked })} />{" "}
							Visible
						</label>
						<Button className="w-full" disabled={saving || loading || !dirtySourceNames.size || inspection?.conflicts?.length > 0} onClick={() => void save()}>
							{saving
								? "Saving…"
								: settings.autoSave && !autoSaveBlocked
									? "Auto Save Enabled"
									: autoSaveBlocked
										? `Retry Save ${dirtySourceNames.size} Node${dirtySourceNames.size === 1 ? "" : "s"}`
										: `Save ${dirtySourceNames.size || ""} Changed Node${dirtySourceNames.size === 1 ? "" : "s"}`}
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
