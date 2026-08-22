import { extname } from "path/posix";

import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { FaLink } from "react-icons/fa6";
import { AiOutlinePlus } from "react-icons/ai";

import {
	AbstractMesh,
	InstancedMesh,
	Material,
	Mesh,
	MorphTarget,
	MultiMaterial,
	Node,
	Observer,
	PBRMaterial,
	StandardMaterial,
	NodeMaterial,
	TrailMesh,
	VertexBuffer,
} from "babylonjs";
import {
	SkyMaterial,
	GridMaterial,
	NormalMaterial,
	WaterMaterial,
	LavaMaterial,
	TriPlanarMaterial,
	TerrainMaterial,
	CellMaterial,
	FireMaterial,
	GradientMaterial,
} from "babylonjs-materials";

import { CollisionMesh } from "../../../nodes/collision";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "../../../../ui/shadcn/ui/dropdown-menu";

import { ICommandPaletteType } from "../../../dialogs/command-palette/command-palette";
import { getMaterialCommands, getMaterialsLibraryCommands } from "../../../dialogs/command-palette/material";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { waitNextAnimationFrame } from "../../../../tools/tools";
import { onNodeModifiedObservable } from "../../../../tools/observables";
import { updateIblShadowsRenderPipeline } from "../../../../tools/light/ibl";
import { isAbstractMesh, isInstancedMesh, isMesh } from "../../../../tools/guards/nodes";
import { updateAllLights, updateLightShadowMapRefreshRate, updatePointLightShadowMapRenderListPredicate } from "../../../../tools/light/shadows";

import { applyMaterialAssetToObject } from "../../preview/import/material";

import {
	bridgeMeshEdges,
	bevelMeshEdge,
	bevelMeshEdges,
	extrudeMeshFaces,
	getMeshSelection,
	getMeshTopology,
	getMeshVertexData,
	insetMeshFaces,
	setMeshSelection,
	setMeshVertexData,
	setMeshUVProjection,
	subdivideMesh,
} from "../../../../mcp/meshes/meshes";
import { getMeshUvLayout, setMeshUvSeams, unwrapMeshUVs } from "../../../../mcp/meshes/uv";
import { captureLoopCutMeshSnapshot, loopCutMesh, restoreLoopCutMeshSnapshot } from "../../../../mcp/meshes/loop-cut";
import { detachMeshFaces } from "../../../../mcp/meshes/detach";
import { autoSmoothMeshFaces, getMeshSmoothingGroups, setMeshSmoothingGroup } from "../../../../mcp/meshes/smoothing";
import { getMeshVertexColors, paintMeshVertexColors } from "../../../../mcp/meshes/vertex-colors";
import { captureMeshIntegritySnapshot, inspectMeshIntegrity, repairMeshIntegrity, restoreMeshIntegritySnapshot } from "../../../../mcp/meshes/integrity";
import { captureMeshPivotSnapshot, getMeshPivot, restoreMeshPivotSnapshot, setMeshPivot } from "../../../../mcp/meshes/pivot";
import { captureMeshEditableSourceSnapshot, getMeshEditableSource, restoreMeshEditableSourceSnapshot, setMeshExportGeometry } from "../../../../mcp/meshes/editable-source";
import { getVfxTrail, setVfxTrail } from "../../../../mcp/vfx/trails";
import { createNavAgent, deleteNavAgent, listNavAgents, setNavAgent, setNavAgentDestination, startNavAgent, stopNavAgent } from "../../../../mcp/navmesh/navmesh";
import {
	applyPrefabInstanceBoundary,
	capturePrefabInstanceStructure,
	comparePrefabInstances,
	inspectPrefabInstanceLinks,
	inspectPrefabInstanceStructure,
	promotePrefabInstanceBoundaryOverrides,
	revertPrefabInstanceBoundary,
	unpackPrefabInstance,
} from "../../../../mcp/prefabs/prefabs";
import { showConfirm } from "../../../../ui/dialog";
import { NodeRenderingLayersInspector } from "../rendering-layers";

import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorVectorField } from "../fields/vector";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorListField } from "../fields/list";
import { EditorInspectorSectionField } from "../fields/section";

import { ScriptInspectorComponent } from "../script/script";
import { CustomMetadataInspector } from "../metadata/custom-metadata";

import { onGizmoNodeChangedObservable } from "../../preview/gizmo/gizmo";

import { EditorTransformNodeInspector } from "../transform";
import { IEditorInspectorImplementationProps } from "../inspector";

import { EditorPBRMaterialInspector } from "../material/pbr";
import { EditorSkyMaterialInspector } from "../material/sky";
import { EditorGridMaterialInspector } from "../material/grid";
import { EditorNodeMaterialInspector } from "../material/node";
import { EditorLavaMaterialInspector } from "../material/lava";
import { EditorCellMaterialInspector } from "../material/cell";
import { EditorFireMaterialInspector } from "../material/fire";
import { EditorMultiMaterialInspector } from "../material/multi";
import { EditorWaterMaterialInspector } from "../material/water";
import { EditorNormalMaterialInspector } from "../material/normal";
import { EditorGradientMaterialInspector } from "../material/gradient";
import { EditorStandardMaterialInspector } from "../material/standard";
import { EditorTriPlanarMaterialInspector } from "../material/tri-planar";
import { EditorTerrainMaterialInspector } from "../material/terrain";

import { MeshLODInspector } from "./lod";
import { MeshDecalInspector } from "./decal";
import { MeshGeometryInspector } from "./geometry";
import { EditorSkeletonInspector } from "./skeleton";
import { EditorMeshPhysicsInspector } from "./physics";
import { EditorMeshCollisionInspector } from "./collision";
import { openPrefabBulkOverrides } from "./prefab-bulk-overrides";
import { openPrefabOverrides } from "./prefab-overrides";
import { openPrefabMode } from "../../assets-browser/viewers/prefab-mode";
import { SpriteShapeInspector } from "./sprite-shape";
import { Physics2DEffectorInspector } from "./physics2d-effector";
import { Physics2DBodyInspector } from "./physics2d-body";

export interface IEditorMeshInspectorState {
	dragOver: boolean;
	selectionIndices: string | null;
	faceOperationAmount: string;
	edgeBevelAmount: string;
	edgeBevelSegments: string;
	loopCutCount: string;
	loopCutOffset: string;
	smoothingGroup: string;
	smoothingAngle: string;
	vertexPaintColor: string;
	vertexPaintAlpha: string;
	vertexPaintOpacity: string;
	vertexPaintBlendMode: "replace" | "add" | "multiply";
	vertexPaintSplitFaces: boolean;
	meshIntegrity: any | null;
	pivotWorldCoordinates: [string, string, string];
	uvProjectionPlane: "xy" | "xz" | "yz";
	uvProjectionScale: string;
	uvChartPadding: string;
	uvRelaxIterations: string;
	uvRelaxStrength: string;
	uvAllowRotation: boolean;
	navMeshPath: string;
	prefabLinks: any[];
	prefabTargetIndex: number;
	prefabBusy: boolean;
	prefabStructure: any | null;
	prefabComparison: any | null;
	prefabComparisonQuery: string;
}

interface IMeshUvVertexStreamSnapshot {
	kind: string;
	values: number[];
	stride: number;
	updatable: boolean;
}

const meshIntegrityReports = new WeakMap<Mesh, any>();

export class EditorMeshInspector extends Component<IEditorInspectorImplementationProps<AbstractMesh>, IEditorMeshInspectorState> {
	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: unknown): boolean {
		return isAbstractMesh(object);
	}

	private _castShadows: boolean;

	private _collisionMesh: CollisionMesh | null = null;

	public constructor(props: IEditorInspectorImplementationProps<AbstractMesh>) {
		super(props);
		props.object.computeWorldMatrix(true);
		const pivotWorld = isMesh(props.object) ? props.object.getAbsolutePivotPoint().asArray() : [0, 0, 0];

		this.state = {
			dragOver: false,
			selectionIndices: null,
			faceOperationAmount: "10",
			edgeBevelAmount: "0.2",
			edgeBevelSegments: "1",
			loopCutCount: "1",
			loopCutOffset: "0",
			smoothingGroup: "1",
			smoothingAngle: "45",
			vertexPaintColor: "#ff3b30",
			vertexPaintAlpha: "1",
			vertexPaintOpacity: "1",
			vertexPaintBlendMode: "replace",
			vertexPaintSplitFaces: true,
			meshIntegrity: isMesh(props.object) ? (meshIntegrityReports.get(props.object) ?? null) : null,
			pivotWorldCoordinates: pivotWorld.map((value) => String(value)) as [string, string, string],
			uvProjectionPlane: "xz",
			uvProjectionScale: "100",
			uvChartPadding: "0.01",
			uvRelaxIterations: "20",
			uvRelaxStrength: "0.5",
			uvAllowRotation: true,
			navMeshPath: "",
			prefabLinks: [],
			prefabTargetIndex: 0,
			prefabBusy: false,
			prefabStructure: null,
			prefabComparison: null,
			prefabComparisonQuery: "",
		};

		this._castShadows = props.editor.layout.preview.scene.lights.some((light) => {
			return light.getShadowGenerator()?.getShadowMap()?.renderList?.includes(props.object);
		});
	}

	public render(): ReactNode {
		return (
			<>
				<EditorInspectorSectionField title="Common">
					<div className="flex justify-between items-center px-2 py-2">
						<div className="w-1/2">Type</div>

						<div className="flex justify-between items-center w-full">
							<div className="text-white/50">{this.props.object.getClassName()}</div>

							{isInstancedMesh(this.props.object) && (
								<Button
									variant="ghost"
									onClick={() => {
										const instance = this.props.object as InstancedMesh;
										this.props.editor.layout.preview.gizmo.setAttachedObject(instance.sourceMesh);
										this.props.editor.layout.graph.setSelectedNode(instance.sourceMesh);
										this.props.editor.layout.inspector.setEditedObject(instance.sourceMesh);
									}}
								>
									<FaLink className="w-4 h-4" />
								</Button>
							)}
						</div>
					</div>
					<EditorInspectorStringField
						label="Name"
						object={this.props.object}
						property="name"
						onChange={() => onNodeModifiedObservable.notifyObservers(this.props.object)}
					/>
					{this.props.object.geometry && (
						<>
							<EditorInspectorSwitchField label="Pickable" object={this.props.object} property="isPickable" />
							<EditorInspectorSwitchField
								label="Visible"
								object={this.props.object}
								property="isVisible"
								onChange={() => updateAllLights(this.props.editor.layout.preview.scene)}
							/>
						</>
					)}
				</EditorInspectorSectionField>

				<NodeRenderingLayersInspector editor={this.props.editor} node={this.props.object} showMeshOrder onUpdate={() => this.forceUpdate()} />

				<EditorInspectorSectionField title="Transforms">
					<EditorInspectorVectorField
						label={<div className="w-14">Position</div>}
						object={this.props.object}
						property="position"
						onFinishChange={() => this._handleTransformsUpdated()}
					/>
					{EditorTransformNodeInspector.GetRotationInspector(this.props.object, () => this._handleTransformsUpdated())}
					<EditorInspectorVectorField
						label={<div className="w-14">Scaling</div>}
						object={this.props.object}
						property="scaling"
						onFinishChange={() => this._handleTransformsUpdated()}
					/>
				</EditorInspectorSectionField>

				{this._getPrefabInstanceComponent()}

				{this._getSplineFollowerComponent()}
				{this._getVfxTrailComponent()}
				{this._getNavigationAgentComponent()}
				{isMesh(this.props.object) && this.props.object.metadata?.babylonEditorSpriteShape?.model === "unity-sprite-shape-controller-v1" && (
					<SpriteShapeInspector object={this.props.object} editor={this.props.editor} />
				)}

				{this.props.object.geometry && (
					<>
						<EditorMeshCollisionInspector {...this.props} />
						<EditorMeshPhysicsInspector mesh={this.props.object} editor={this.props.editor} />
					</>
				)}

				{this.props.editor.layout.preview.scene.lights.length > 0 && this.props.object.geometry && (
					<EditorInspectorSectionField title="Shadows">
						<EditorInspectorSwitchField
							label="Cast Shadows"
							object={this}
							property="_castShadows"
							noUndoRedo
							onChange={() => this._handleCastShadowsChanged(this._castShadows)}
						/>
						<EditorInspectorSwitchField label="Receive Shadows" object={this.props.object} property="receiveShadows" />
					</EditorInspectorSectionField>
				)}

				<ScriptInspectorComponent editor={this.props.editor} object={this.props.object} />

				{isMesh(this.props.object) && (
					<>
						<MeshGeometryInspector object={this.props.object} editor={this.props.editor} />
						<EditorInspectorSectionField title="Mesh Modeling" tooltip="ProBuilder-style topology operations. Mesh subdivision supports the editor Undo/Redo stack.">
							{this._getMeshComponentSelection()}
							<Button variant="secondary" className="w-full" onClick={() => this._subdivideMesh()}>
								Subdivide Mesh
							</Button>
						</EditorInspectorSectionField>
						<Physics2DBodyInspector node={this.props.object} editor={this.props.editor} onChanged={() => this.forceUpdate()} />
						<Physics2DEffectorInspector mesh={this.props.object} editor={this.props.editor} onChanged={() => this.forceUpdate()} />
						<MeshDecalInspector object={this.props.object} />
						<MeshLODInspector mesh={this.props.object} editor={this.props.editor} />
					</>
				)}

				{this._getMaterialComponent()}
				{this._getSkeletonComponent()}
				{this._getMorphTargetManagerComponent()}

				{this.props.object.geometry && (
					<EditorInspectorSectionField title="Misc">
						<EditorInspectorSwitchField label="Infinite Distance" object={this.props.object} property="infiniteDistance" />
						<EditorInspectorSwitchField label="Always Select As Active Mesh" object={this.props.object} property="alwaysSelectAsActiveMesh" />
					</EditorInspectorSectionField>
				)}

				<CustomMetadataInspector object={this.props.object} />
			</>
		);
	}

	private async _loadPrefabLinks(): Promise<void> {
		try {
			const inspection = await inspectPrefabInstanceLinks(this.props.object.getScene(), { nodeId: this.props.object.id });
			this.setState(
				(state) => ({
					prefabLinks: inspection.links,
					prefabTargetIndex: state.prefabTargetIndex < inspection.links.length ? state.prefabTargetIndex : 0,
				}),
				() => void this._loadPrefabStructure()
			);
		} catch (error: any) {
			this.setState({ prefabLinks: [], prefabTargetIndex: 0, prefabStructure: null, prefabComparison: null });
			toast.error(error.message);
		}
	}

	private _getPrefabInstanceComponent(): ReactNode {
		if (!this.props.object.metadata?.prefab) {
			return null;
		}
		const selectedIndex = this.state.prefabTargetIndex;
		const selected = this.state.prefabLinks[selectedIndex];
		return (
			<EditorInspectorSectionField
				title="Prefab Instance"
				tooltip="Choose the exact outer or nested source boundary for Apply/Revert. Outermost unpack preserves deeper nested prefab links; complete unpack removes every link."
			>
				<div className="flex flex-col gap-2 px-2 pb-2">
					<select
						className="h-8 rounded border border-white/15 bg-secondary px-2 text-xs"
						value={this.state.prefabTargetIndex}
						disabled={this.state.prefabBusy || !this.state.prefabLinks.length}
						onChange={(event) => this.setState({ prefabTargetIndex: Number(event.target.value) }, () => void this._loadPrefabStructure())}
					>
						{this.state.prefabLinks.map((link) => (
							<option key={`${link.index}:${link.path}`} value={link.index}>
								{link.index === 0 ? "Outer" : `Nested ${link.index}`} · {link.path} · {link.sourceNodeName}
							</option>
						))}
					</select>
					{selected && (
						<div className="text-[11px] text-muted-foreground">
							Revision {selected.revision.slice(0, 12)} · {selected.variant ? "variant" : "base"} {selected.stale ? "· stale" : ""}
						</div>
					)}
					<Button
						variant="default"
						disabled={!selected || this.state.prefabBusy}
						onClick={() => openPrefabOverrides(this.props.editor, this.props.object, selectedIndex)}
					>
						Open Prefab Overrides
					</Button>
					<Button variant="secondary" disabled={this.state.prefabBusy} onClick={() => openPrefabBulkOverrides(this.props.editor, { all: true })}>
						Open All Prefab Overrides
					</Button>
					{selected && (
						<Button variant="secondary" disabled={this.state.prefabBusy} onClick={() => openPrefabBulkOverrides(this.props.editor, { path: selected.path })}>
							Open Matching Prefab Overrides
						</Button>
					)}
					<Button
						variant="secondary"
						disabled={!selected || this.state.prefabBusy}
						onClick={() =>
							openPrefabMode(this.props.editor, selected.path, {
								instance: { nodeId: this.props.object.id, targetIndex: selectedIndex },
								mode: "context",
							})
						}
					>
						Open Prefab Stage
					</Button>
					<div className="grid grid-cols-2 gap-2">
						<Button variant="secondary" disabled={!selected || this.state.prefabBusy} onClick={() => this._applyPrefabBoundary()}>
							Apply Transform
						</Button>
						<Button variant="secondary" disabled={!selected || this.state.prefabBusy} onClick={() => this._revertPrefabBoundary()}>
							Revert Transform
						</Button>
					</div>
					{this._getPrefabLiveOverridesComponent()}
					<Button variant="secondary" disabled={!selected || selectedIndex < 1 || this.state.prefabBusy} onClick={() => this._promotePrefabBoundary()}>
						Promote All Boundary Overrides
					</Button>
					<div className="grid grid-cols-2 gap-2">
						<Button variant="outline" disabled={!selected || this.state.prefabBusy} onClick={() => this._unpackPrefab("outermost")}>
							Unpack Outermost
						</Button>
						<Button variant="destructive" disabled={!selected || this.state.prefabBusy} onClick={() => this._unpackPrefab("completely")}>
							Unpack Completely
						</Button>
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getPrefabLiveOverridesComponent(): ReactNode {
		const structure = this.state.prefabStructure;
		const comparison = this.state.prefabComparison;
		return (
			<div className="rounded border border-white/10 p-2 text-[11px]">
				<div className="font-medium text-xs">Live Overrides</div>
				{!structure && <div className="mt-1 text-muted-foreground">Detecting live hierarchy differences…</div>}
				{structure && (
					<>
						<div className="mt-1 grid grid-cols-2 gap-x-2 text-muted-foreground">
							<div>{structure.additions.length} additions</div>
							<div>{structure.removals.length} removals</div>
							<div>{structure.reparents.length} reparents</div>
							<div>{structure.modified.length} transforms</div>
						</div>
						{structure.blockers.length > 0 && <div className="mt-1 text-red-400">{structure.blockers.length} unsupported or stale change(s)</div>}
						<div className="mt-2 grid grid-cols-2 gap-2">
							<Button variant="outline" className="h-7 px-2" disabled={this.state.prefabBusy} onClick={() => void this._loadPrefabStructure()}>
								Detect Again
							</Button>
							<Button
								variant="secondary"
								className="h-7 px-2"
								disabled={this.state.prefabBusy || !structure.variant || !structure.hasStructuralOverrides || structure.blockers.length > 0}
								onClick={() => void this._capturePrefabStructure()}
							>
								Capture Structure
							</Button>
						</div>
					</>
				)}
				<div className="mt-2 flex gap-1">
					<Input
						className="h-7 text-xs"
						placeholder="Search instances"
						value={this.state.prefabComparisonQuery}
						onChange={(event) => this.setState({ prefabComparisonQuery: event.target.value })}
					/>
					<Button variant="outline" className="h-7 px-2" disabled={this.state.prefabBusy} onClick={() => void this._comparePrefabInstances()}>
						Compare
					</Button>
				</div>
				{comparison && (
					<div className="mt-2">
						<div className="text-muted-foreground">
							{comparison.instanceCount} instances · {comparison.distinctSignatureCount} override patterns
						</div>
						{comparison.instances.slice(0, 12).map((instance: any) => (
							<button
								key={instance.instanceId}
								className="mt-1 block w-full truncate text-left text-blue-400 hover:underline"
								title={`${instance.rootNodeName}: ${instance.additionCount} add, ${instance.removalCount} remove, ${instance.reparentCount} reparent, ${instance.modifiedCount} transform`}
								onClick={() => {
									const node = this.props.object.getScene().getNodeById(instance.rootNodeId);
									if (node) {
										this.props.editor.layout.graph.setSelectedNode(node);
										this.props.editor.layout.inspector.setEditedObject(node);
									}
								}}
							>
								{instance.rootNodeName} · {instance.additionCount + instance.removalCount + instance.reparentCount + instance.modifiedCount} changes
							</button>
						))}
					</div>
				)}
			</div>
		);
	}

	private async _loadPrefabStructure(): Promise<void> {
		const selected = this.state.prefabLinks[this.state.prefabTargetIndex];
		if (!this.props.object.metadata?.prefab || !selected || this.state.prefabBusy) {
			return;
		}
		try {
			const prefabStructure = await inspectPrefabInstanceStructure(this.props.object.getScene(), {
				nodeId: this.props.object.id,
				targetPath: selected.path,
				targetIndex: this.state.prefabTargetIndex,
			});
			this.setState({ prefabStructure });
		} catch (error: any) {
			this.setState({ prefabStructure: null });
			toast.error(error.message);
		}
	}

	private async _capturePrefabStructure(): Promise<void> {
		const structure = this.state.prefabStructure;
		if (!structure) {
			return;
		}
		const confirmed = await showConfirm(
			"Capture live prefab structure?",
			`Write ${structure.additions.length} addition(s), ${structure.removals.length} removal(s), and ${structure.reparents.length} reparent(s) into ${structure.targetPath}?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ prefabBusy: true });
		try {
			await capturePrefabInstanceStructure(
				this.props.object.getScene(),
				{
					nodeId: this.props.object.id,
					targetPath: structure.targetPath,
					targetIndex: structure.targetIndex,
					expectedRevision: structure.revision,
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			toast.success(`Captured live structure into ${structure.targetPath}`);
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ prefabBusy: false }, () => void this._loadPrefabLinks());
		}
	}

	private async _comparePrefabInstances(): Promise<void> {
		const path = this.state.prefabLinks[0]?.path;
		if (!path) {
			return;
		}
		this.setState({ prefabBusy: true });
		try {
			const prefabComparison = await comparePrefabInstances(this.props.object.getScene(), {
				path,
				query: this.state.prefabComparisonQuery,
				limit: 200,
			});
			this.setState({ prefabComparison });
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ prefabBusy: false });
		}
	}

	private async _applyPrefabBoundary(): Promise<void> {
		const targetIndex = this.state.prefabTargetIndex;
		const link = this.state.prefabLinks[targetIndex];
		if (!link) {
			return;
		}
		this.setState({ prefabBusy: true });
		try {
			await applyPrefabInstanceBoundary(
				this.props.object.getScene(),
				{
					nodeId: this.props.object.id,
					targetPath: link.path,
					targetIndex,
					expectedRevision: link.revision,
					transformVisibility: true,
					componentChanges: [],
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			toast.success(`Applied transform to ${link.path}`);
			await this._loadPrefabLinks();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ prefabBusy: false });
		}
	}

	private async _revertPrefabBoundary(): Promise<void> {
		const targetIndex = this.state.prefabTargetIndex;
		const link = this.state.prefabLinks[targetIndex];
		if (!link) {
			return;
		}
		this.setState({ prefabBusy: true });
		try {
			await revertPrefabInstanceBoundary(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, targetPath: link.path, targetIndex, expectedRevision: link.revision, transformVisibility: true, componentKeys: [], confirm: true },
				{ editor: this.props.editor }
			);
			toast.success(`Reverted transform from ${link.path}`);
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ prefabBusy: false });
		}
	}

	private async _promotePrefabBoundary(): Promise<void> {
		const targetIndex = this.state.prefabTargetIndex;
		const target = this.state.prefabLinks[targetIndex];
		const container = this.state.prefabLinks[targetIndex - 1];
		if (!target || !container) {
			return;
		}
		const confirmed = await showConfirm(
			"Promote nested prefab overrides?",
			`Move all transform, property, component, and descendant structural overrides at this boundary from ${container.path} into ${target.path}?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ prefabBusy: true });
		try {
			await promotePrefabInstanceBoundaryOverrides(
				this.props.object.getScene(),
				{
					nodeId: this.props.object.id,
					targetPath: target.path,
					targetIndex,
					expectedContainerRevision: container.revision,
					expectedTargetRevision: target.revision,
					categories: ["transforms", "properties", "components", "structure"],
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			toast.success(`Promoted nested overrides into ${target.path}`);
			await this._loadPrefabLinks();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ prefabBusy: false });
		}
	}

	private async _unpackPrefab(mode: "outermost" | "completely"): Promise<void> {
		const targetIndex = this.state.prefabTargetIndex;
		const link = this.state.prefabLinks[targetIndex];
		if (!link) {
			return;
		}
		const confirmed = await showConfirm(
			mode === "completely" ? "Unpack prefab completely?" : "Unpack prefab boundary?",
			mode === "completely"
				? "Remove every prefab source link from this live subtree? Source assets will not be deleted."
				: `Detach ${link.path} while preserving deeper nested prefab links?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ prefabBusy: true });
		try {
			await unpackPrefabInstance(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, targetPath: link.path, targetIndex, mode, confirm: true },
				{ editor: this.props.editor }
			);
			toast.success(mode === "completely" ? "Prefab instance unpacked completely" : "Prefab boundary unpacked");
			if (this.props.object.metadata?.prefab) {
				await this._loadPrefabLinks();
			} else {
				this.setState({ prefabLinks: [], prefabTargetIndex: 0 });
			}
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ prefabBusy: false });
		}
	}

	private _getVfxTrailComponent(): ReactNode {
		const trail = this.props.object;
		if (!(trail instanceof TrailMesh)) {
			return null;
		}
		const configuration = getVfxTrail(trail.getScene(), { nodeId: trail.id });
		return (
			<EditorInspectorSectionField
				title="VFX Trail"
				tooltip="Persistent Babylon trail geometry. It follows the configured generator and is available through the VFX MCP tools."
			>
				<div className="px-2 text-sm text-muted-foreground">Generator: {configuration.generatorId}</div>
				<div className="grid grid-cols-2 gap-2 px-2">
					<Input
						defaultValue={String(configuration.diameter)}
						type="number"
						min="0.0001"
						step="1"
						aria-label="VFX trail diameter"
						onBlur={(event) => this._setVfxTrail({ diameter: Number(event.target.value) })}
					/>
					<Input
						defaultValue={String(configuration.length)}
						type="number"
						min="0.0001"
						step="1"
						aria-label="VFX trail length"
						onBlur={(event) => this._setVfxTrail({ length: Number(event.target.value) })}
					/>
					<Input
						defaultValue={String(configuration.segments)}
						type="number"
						min="1"
						step="1"
						aria-label="VFX trail segments"
						onBlur={(event) => this._setVfxTrail({ segments: Number(event.target.value) })}
					/>
					<Input
						defaultValue={String(configuration.sections)}
						type="number"
						min="2"
						step="1"
						aria-label="VFX trail sections"
						onBlur={(event) => this._setVfxTrail({ sections: Number(event.target.value) })}
					/>
				</div>
				<div className="grid grid-cols-2 gap-2">
					<Button variant="secondary" onClick={() => this._setVfxTrail({ playing: true })}>
						Start Trail
					</Button>
					<Button variant="secondary" onClick={() => this._setVfxTrail({ playing: false })}>
						Stop Trail
					</Button>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getNavigationAgentComponent(): ReactNode {
		const scene = this.props.object.getScene();
		const agent = (listNavAgents(scene).agents as any[]).find((candidate) => candidate.nodeId === this.props.object.id);
		return (
			<EditorInspectorSectionField
				title="Navigation Agent"
				tooltip="Node-bound Recast path follower. Create one with a rebuilt .navmesh asset, tune movement and avoidance, then set a world-space destination. The same configuration is available through MCP."
			>
				{agent ? (
					<div className="space-y-2">
						<div className="text-xs text-muted-foreground">
							{agent.navMeshPath} · {agent.runtime ? `Detour ${agent.runtime.state} · ${agent.runtime.remainingDistance.toFixed(1)} remaining` : "crowd unavailable"}
						</div>
						<div className="grid grid-cols-3 gap-1">
							<Input
								defaultValue={String(agent.radius)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent radius"
								onBlur={(event) => this._setNavAgentNumber(agent, "radius", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.height)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent height"
								onBlur={(event) => this._setNavAgentNumber(agent, "height", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.maxSpeed)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent speed"
								onBlur={(event) => this._setNavAgentNumber(agent, "maxSpeed", event.target.value)}
							/>
						</div>
						<div className="grid grid-cols-3 gap-1">
							<Input
								defaultValue={String(agent.maxAcceleration)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent acceleration"
								onBlur={(event) => this._setNavAgentNumber(agent, "maxAcceleration", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.collisionQueryRange ?? agent.avoidanceRadius ?? agent.radius * 2)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent collision query range"
								onBlur={(event) => this._setNavAgentNumber(agent, "collisionQueryRange", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.separationWeight ?? agent.avoidanceWeight ?? 1)}
								type="number"
								min="0"
								step="any"
								aria-label="Nav agent separation weight"
								onBlur={(event) => this._setNavAgentNumber(agent, "separationWeight", event.target.value)}
							/>
						</div>
						<div className="grid grid-cols-3 gap-1">
							<Input
								defaultValue={String(agent.pathOptimizationRange ?? agent.radius * 30)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent path optimization range"
								onBlur={(event) => this._setNavAgentNumber(agent, "pathOptimizationRange", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.reachRadius ?? agent.radius)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent reach radius"
								onBlur={(event) => this._setNavAgentNumber(agent, "reachRadius", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.queryFilterType ?? 0)}
								type="number"
								min="0"
								max="15"
								step="1"
								aria-label="Nav agent query filter"
								onBlur={(event) => this._setNavAgentNumber(agent, "queryFilterType", event.target.value)}
							/>
						</div>
						<div className="grid grid-cols-3 gap-1">
							<Input
								defaultValue={String(agent.obstacleAvoidanceType ?? 0)}
								type="number"
								min="0"
								max="7"
								step="1"
								aria-label="Nav agent avoidance quality"
								onBlur={(event) => this._setNavAgentNumber(agent, "obstacleAvoidanceType", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.updateFlags ?? 31)}
								type="number"
								min="0"
								max="31"
								step="1"
								aria-label="Nav agent Detour update flags"
								onBlur={(event) => this._setNavAgentNumber(agent, "updateFlags", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.angularSpeed ?? Math.PI * 4)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent angular speed"
								onBlur={(event) => this._setNavAgentNumber(agent, "angularSpeed", event.target.value)}
							/>
						</div>
						<Button
							size="sm"
							variant={agent.avoidanceEnabled === false ? "ghost" : "secondary"}
							className="w-full"
							onClick={() => this._setNavAgentAvoidance(agent, agent.avoidanceEnabled === false)}
						>
							{agent.avoidanceEnabled === false ? "Enable Local Avoidance" : "Disable Local Avoidance"}
						</Button>
						<Button
							size="sm"
							variant={agent.updateRotation === false ? "ghost" : "secondary"}
							className="w-full"
							onClick={() => this._setNavAgentBoolean(agent, "updateRotation", agent.updateRotation === false)}
						>
							{agent.updateRotation === false ? "Enable Velocity Rotation" : "Disable Velocity Rotation"}
						</Button>
						<Button
							size="sm"
							variant={agent.autoRepath === false ? "ghost" : "secondary"}
							className="w-full"
							onClick={() => this._setNavAgentBoolean(agent, "autoRepath", agent.autoRepath === false)}
						>
							{agent.autoRepath === false ? "Enable Auto Repath" : "Disable Auto Repath"}
						</Button>
						<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-1">
							<Input
								placeholder="Destination x, y, z"
								aria-label="Nav agent destination"
								onBlur={(event) => this._setNavAgentDestination(agent, event.target.value)}
							/>
							<Button size="sm" variant="secondary" disabled={!agent.path?.length || agent.isMoving} onClick={() => this._startNavAgent(agent)}>
								Start
							</Button>
							<Button size="sm" variant="ghost" disabled={!agent.isMoving} onClick={() => this._stopNavAgent(agent)}>
								Stop
							</Button>
						</div>
						<Button size="sm" variant="ghost" className="w-full hover:bg-destructive" onClick={() => this._deleteNavAgent(agent)}>
							Remove Agent
						</Button>
					</div>
				) : (
					<div className="flex gap-1">
						<Input
							placeholder="assets/world.navmesh"
							value={this.state.navMeshPath}
							aria-label="Navigation mesh asset path"
							onChange={(event) => this.setState({ navMeshPath: event.target.value })}
						/>
						<Button size="sm" disabled={!this.state.navMeshPath.trim()} onClick={() => this._createNavAgent()}>
							Create
						</Button>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _createNavAgent(): void {
		createNavAgent(this.props.object.getScene(), { nodeId: this.props.object.id, navMeshPath: this.state.navMeshPath.trim() }, { editor: this.props.editor })
			.then(() => this.forceUpdate())
			.catch((error: any) => toast.error(error.message));
	}

	private _setNavAgentNumber(
		agent: any,
		property:
			| "radius"
			| "height"
			| "maxSpeed"
			| "maxAcceleration"
			| "collisionQueryRange"
			| "pathOptimizationRange"
			| "separationWeight"
			| "reachRadius"
			| "queryFilterType"
			| "obstacleAvoidanceType"
			| "updateFlags"
			| "angularSpeed",
		value: string
	): void {
		const number = Number(value);
		if (
			!Number.isFinite(number) ||
			(property === "separationWeight" || property === "queryFilterType" || property === "obstacleAvoidanceType" || property === "updateFlags" ? number < 0 : number <= 0)
		) {
			return;
		}
		setNavAgent(this.props.object.getScene(), { id: agent.id, [property]: number }, { editor: this.props.editor })
			.then(() => this.forceUpdate())
			.catch((error: Error) => toast.error(error.message));
	}

	private _setNavAgentAvoidance(agent: any, avoidanceEnabled: boolean): void {
		this._setNavAgentBoolean(agent, "avoidanceEnabled", avoidanceEnabled);
	}

	private _setNavAgentBoolean(agent: any, property: "avoidanceEnabled" | "updateRotation" | "autoRepath", value: boolean): void {
		setNavAgent(this.props.object.getScene(), { id: agent.id, [property]: value }, { editor: this.props.editor })
			.then(() => this.forceUpdate())
			.catch((error: Error) => toast.error(error.message));
	}

	private _setNavAgentDestination(agent: any, value: string): void {
		const destination = value.split(",").map((part) => Number(part.trim()));
		if (destination.length !== 3 || destination.some((coordinate) => !Number.isFinite(coordinate))) {
			return;
		}
		setNavAgentDestination(this.props.object.getScene(), { id: agent.id, destination }, { editor: this.props.editor })
			.then(() => this.forceUpdate())
			.catch((error: any) => toast.error(error.message));
	}

	private _startNavAgent(agent: any): void {
		startNavAgent(this.props.object.getScene(), { id: agent.id }, { editor: this.props.editor })
			.then(() => this.forceUpdate())
			.catch((error: Error) => toast.error(error.message));
	}

	private _stopNavAgent(agent: any): void {
		stopNavAgent(this.props.object.getScene(), { id: agent.id }, { editor: this.props.editor })
			.then(() => this.forceUpdate())
			.catch((error: Error) => toast.error(error.message));
	}

	private _deleteNavAgent(agent: any): void {
		deleteNavAgent(this.props.object.getScene(), { id: agent.id }, { editor: this.props.editor })
			.then(() => this.forceUpdate())
			.catch((error: Error) => toast.error(error.message));
	}

	private _setVfxTrail(data: any): void {
		const trail = this.props.object;
		if (!(trail instanceof TrailMesh)) {
			return;
		}
		if (Object.values(data).some((value) => typeof value === "number" && !Number.isFinite(value))) {
			return;
		}
		setVfxTrail(trail.getScene(), { nodeId: trail.id, ...data }, { editor: this.props.editor });
	}

	private _gizmoObserver: Observer<Node> | null = null;

	public componentDidMount(): void {
		this._gizmoObserver = onGizmoNodeChangedObservable.add((node) => {
			if (node === this.props.object) {
				this.props.editor.layout.inspector.forceUpdate();
			}
		});

		this.props.editor.layout.preview.selectionOutlineLayer.addSelection(this.props.object);
		if (this.props.object.metadata?.prefab) {
			this._loadPrefabLinks();
		}
	}

	public componentWillUnmount(): void {
		if (this._collisionMesh) {
			this._collisionMesh.isVisible = false;
		}

		if (this._gizmoObserver) {
			onGizmoNodeChangedObservable.remove(this._gizmoObserver);
		}

		this.props.editor.layout.preview.selectionOutlineLayer.clearSelection();
	}

	private _handleTransformsUpdated(): void {
		if (isMesh(this.props.object)) {
			updateIblShadowsRenderPipeline(this.props.object.getScene());
		}
	}

	private _getMaterialComponent(): ReactNode {
		if (!this.props.object.geometry) {
			return;
		}

		if (!this.props.object.material) {
			return (
				<EditorInspectorSectionField title="Material">
					<div
						onDrop={(e) => this._handleMaterialDrop(e)}
						onDragLeave={() =>
							this.setState({
								dragOver: false,
							})
						}
						onDragOver={(ev) => this._handleMaterialDragOver(ev)}
						className={`flex flex-col justify-center items-center w-full p-4 rounded-lg border-[1px] border-secondary-foreground/35 border-dashed ${this.state.dragOver ? "bg-secondary-foreground/35" : ""} transition-all duration-300 ease-in-out`}
					>
						<div className="text-center">
							<div className="text-xl mb-2">No material</div>
							<div className="text-sm text-muted-foreground mb-2">Drop material file or create material</div>
						</div>

						<div className="flex gap-2">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="outline" className="flex gap-2 items-center">
										<AiOutlinePlus className="w-4 h-4" />
										Create Material
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent>
									{getMaterialCommands(this.props.editor).map((command) => (
										<DropdownMenuItem key={command.key} onClick={() => this._handleAddMaterial(command)}>
											{command.text}
										</DropdownMenuItem>
									))}

									<DropdownMenuSeparator />

									<DropdownMenuSub>
										<DropdownMenuSubTrigger>Materials Library</DropdownMenuSubTrigger>
										<DropdownMenuSubContent>
											{getMaterialsLibraryCommands(this.props.editor).map((command) => (
												<DropdownMenuItem key={command.key} onClick={() => this._handleAddMaterial(command)}>
													{command.text}
												</DropdownMenuItem>
											))}
										</DropdownMenuSubContent>
									</DropdownMenuSub>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>
				</EditorInspectorSectionField>
			);
		}

		const inspector = this._getMaterialInspectorComponent(this.props.object.material);
		if (!inspector) {
			return (
				<EditorInspectorSectionField title="Material">
					<div className="text-center text-yellow-500">Unsupported material type: {this.props.object.material.getClassName()}</div>
				</EditorInspectorSectionField>
			);
		}

		return <div className="flex flex-col gap-2 relative">{inspector}</div>;
	}

	private _handleMaterialDrop(ev: React.DragEvent<HTMLDivElement>): void {
		ev.preventDefault();
		ev.stopPropagation();

		this.setState({
			dragOver: false,
		});

		const assets = ev.dataTransfer.getData("assets");
		if (assets) {
			this._handleMaterialDropped(assets);
		}
	}

	private _handleMaterialDragOver(ev: React.DragEvent<HTMLDivElement>): void {
		ev.preventDefault();
		ev.stopPropagation();

		this.setState({
			dragOver: true,
		});
	}

	private _handleMaterialDropped(assets: string): void {
		const absolutePaths = JSON.parse(assets) as string[];

		if (!Array.isArray(absolutePaths)) {
			return;
		}

		absolutePaths.forEach(async (absolutePath) => {
			await waitNextAnimationFrame();
			const extension = extname(absolutePath).toLowerCase();
			switch (extension) {
				case ".material":
					applyMaterialAssetToObject(this.props.editor, this.props.object, absolutePath);
					break;
			}
		});
	}

	private _handleAddMaterial(command: ICommandPaletteType): void {
		const material = command.action() as Material | null;

		if (!material) {
			return;
		}

		registerUndoRedo({
			executeRedo: true,
			onLost: () => material.dispose(),
			undo: () => (this.props.object.material = null),
			redo: () => (this.props.object.material = material),
		});

		this.forceUpdate();
	}

	private _subdivideMesh(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const scene = mesh.getScene();
		const options = { editor: this.props.editor };
		const before = getMeshVertexData(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof getMeshVertexData> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => setMeshVertexData(scene, { nodeId: mesh.id, positions: before.positions, uvs: before.uvs, indices: before.indices }, options),
			redo: () => {
				if (!after) {
					after = subdivideMesh(scene, { nodeId: mesh.id }, options);
				} else {
					setMeshVertexData(scene, { nodeId: mesh.id, positions: after.positions, uvs: after.uvs, indices: after.indices }, options);
				}
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _getMeshComponentSelection(): ReactNode {
		const mesh = this.props.object;
		if (!isMesh(mesh) || !mesh.geometry || !mesh.getVerticesData("position")?.length) {
			return null;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		let uvLayout: ReturnType<typeof getMeshUvLayout> | null = null;
		let selectedSmoothing: ReturnType<typeof getMeshSmoothingGroups> | null = null;
		let selectedVertexColors: ReturnType<typeof getMeshVertexColors> | null = null;
		let editableSource: ReturnType<typeof getMeshEditableSource> | null = null;
		try {
			editableSource = getMeshEditableSource(scene, { nodeId: mesh.id });
		} catch {
			// Invalid source topology remains repairable through Mesh Integrity.
		}
		try {
			uvLayout = getMeshUvLayout(scene, { nodeId: mesh.id, offset: 0, limit: 1 });
		} catch {
			// Damaged topology must remain inspectable so Mesh Integrity can repair it.
		}
		if (selection.mode === "face" && selection.indices.length) {
			try {
				selectedSmoothing = getMeshSmoothingGroups(scene, { nodeId: mesh.id, faceIndices: selection.indices.slice(0, 256) });
			} catch {
				// Smoothing authoring stays unavailable until invalid faces are repaired.
			}
		}
		if ((selection.mode === "vertex" || selection.mode === "face") && selection.indices.length) {
			try {
				selectedVertexColors = getMeshVertexColors(scene, { nodeId: mesh.id, selectedOnly: true, offset: 0, limit: 1 });
			} catch {
				// Vertex painting stays unavailable until invalid streams are repaired.
			}
		}
		const meshIntegrity = this.state.meshIntegrity?.node?.id === mesh.id ? this.state.meshIntegrity : null;
		mesh.computeWorldMatrix(true);
		const pivotLocal = mesh.getPivotPoint().asArray();
		const pivotWorld = mesh.getAbsolutePivotPoint().asArray();
		const text = this.state.selectionIndices ?? selection.indices.join(", ");
		const total = selection.mode === "vertex" ? topology.vertexCount : selection.mode === "edge" ? topology.edges.length : topology.faceCount;
		return (
			<div className="space-y-2 rounded border border-input p-2">
				<div className="flex items-center justify-between gap-2">
					<div className="text-xs font-medium text-muted-foreground">Component Selection</div>
					<div className="text-xs text-muted-foreground">
						{topology.vertexCount} vertices · {topology.edges.length} edges · {topology.faceCount} faces
					</div>
				</div>
				<div className="grid grid-cols-[8rem_minmax(0,1fr)_auto] gap-2">
					<select
						className="h-9 rounded-md border border-input bg-background px-2 text-sm"
						value={selection.mode}
						onChange={(event) => this._setMeshComponentSelection(event.target.value, [])}
					>
						<option value="vertex">Vertex</option>
						<option value="edge">Edge</option>
						<option value="face">Face</option>
					</select>
					<Input
						value={text}
						placeholder={`IDs 0–${Math.max(0, total - 1)}, comma-separated`}
						onChange={(event) => this.setState({ selectionIndices: event.target.value })}
						aria-label={`${selection.mode} component IDs`}
					/>
					<Button size="sm" variant="secondary" onClick={() => this._applyMeshComponentSelection(selection.mode)}>
						Apply
					</Button>
				</div>
				<div className="text-xs text-muted-foreground">
					Edges are stable unique-edge IDs returned by MCP topology. In the viewport, Ctrl/Cmd-click toggles faces, Ctrl/Cmd+Shift selects nearest vertices, and
					Ctrl/Cmd+Alt selects nearest edges.
				</div>
				{selection.mode === "face" && selection.indices.length > 0 && (
					<div className="space-y-2">
						<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
							<Input
								type="number"
								min="0.0001"
								step="0.1"
								value={this.state.faceOperationAmount}
								onChange={(event) => this.setState({ faceOperationAmount: event.target.value })}
								aria-label="Selected face operation amount"
							/>
							<Button size="sm" variant="secondary" onClick={() => this._applySelectedFaceOperation("extrude")}>
								Extrude
							</Button>
							<Button size="sm" variant="secondary" onClick={() => this._applySelectedFaceOperation("inset")}>
								Inset
							</Button>
						</div>
						<div className="grid grid-cols-3 gap-2">
							<Button size="sm" variant="secondary" onClick={() => this._detachSelectedFaces("gameObject")}>
								Detach To Game Object
							</Button>
							<Button size="sm" variant="secondary" onClick={() => this._detachSelectedFaces("submesh")}>
								Detach To Submesh
							</Button>
						</div>
						<div className="space-y-2 border-t border-input pt-2">
							<div className="flex items-center justify-between text-xs text-muted-foreground">
								<span>Smoothing Groups</span>
								<span>
									{selectedSmoothing?.faces.length
										? new Set(selectedSmoothing.faces.map((face: any) => face.group)).size === 1
											? selectedSmoothing.faces[0].group === 0
												? "Hard"
												: `Group ${selectedSmoothing.faces[0].group}`
											: "Mixed"
										: "No faces"}
									· revision {selectedSmoothing?.revision ?? 0}
								</span>
							</div>
							<div className="grid grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)] gap-2">
								<Input
									type="number"
									min="1"
									max="24"
									step="1"
									value={this.state.smoothingGroup}
									onChange={(event) => this.setState({ smoothingGroup: event.target.value })}
									aria-label="Smoothing group"
								/>
								<Button size="sm" variant="secondary" onClick={() => this._applySelectedSmoothingGroup(Number(this.state.smoothingGroup))}>
									Apply Group
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._applySelectedSmoothingGroup(0)}>
									Clear To Hard
								</Button>
							</div>
							<div className="grid grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)] gap-2">
								<Input
									type="number"
									min="0"
									max="180"
									step="1"
									value={this.state.smoothingAngle}
									onChange={(event) => this.setState({ smoothingAngle: event.target.value })}
									aria-label="Auto smooth angle threshold"
								/>
								<Button size="sm" variant="secondary" onClick={() => this._autoSmoothSelectedFaces()}>
									Auto Smooth
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._selectSmoothingGroup()}>
									Select Group
								</Button>
							</div>
							<div className="text-xs text-muted-foreground">
								Group 0 is hard. Groups 1–24 average normals across coincident vertices without changing UV or material seams.
							</div>
						</div>
					</div>
				)}
				{(selection.mode === "vertex" || selection.mode === "face") && selection.indices.length > 0 && (
					<div className="space-y-2 border-t border-input pt-2">
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span>Vertex Colors</span>
							<span>
								{selectedVertexColors?.selectedVertexCount ?? 0} selected · {selectedVertexColors?.paintedVertexCount ?? 0}/{selectedVertexColors?.vertexCount ?? 0}{" "}
								painted · revision {selectedVertexColors?.revision ?? 0}
							</span>
						</div>
						<div className="grid grid-cols-[4rem_5rem_minmax(0,1fr)] gap-2">
							<Input
								type="color"
								value={this.state.vertexPaintColor}
								onChange={(event) => this.setState({ vertexPaintColor: event.target.value })}
								aria-label="Vertex paint color"
							/>
							<Input
								type="number"
								min="0"
								max="1"
								step="0.05"
								value={this.state.vertexPaintAlpha}
								onChange={(event) => this.setState({ vertexPaintAlpha: event.target.value })}
								aria-label="Vertex paint alpha"
							/>
							<select
								className="h-9 rounded-md border border-input bg-background px-2 text-sm"
								value={this.state.vertexPaintBlendMode}
								onChange={(event) => this.setState({ vertexPaintBlendMode: event.target.value as IEditorMeshInspectorState["vertexPaintBlendMode"] })}
								aria-label="Vertex paint blend mode"
							>
								<option value="replace">Replace</option>
								<option value="add">Add</option>
								<option value="multiply">Multiply</option>
							</select>
						</div>
						<div className="grid grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)] gap-2">
							<Input
								type="number"
								min="0"
								max="1"
								step="0.05"
								value={this.state.vertexPaintOpacity}
								onChange={(event) => this.setState({ vertexPaintOpacity: event.target.value })}
								aria-label="Vertex paint opacity"
							/>
							<Button size="sm" variant="secondary" onClick={() => this._paintSelectedVertexColors(false)}>
								Paint Colors
							</Button>
							<Button size="sm" variant="secondary" onClick={() => this._paintSelectedVertexColors(true)}>
								Clear To White
							</Button>
						</div>
						{selection.mode === "face" && (
							<label className="flex items-center gap-2 text-xs text-muted-foreground">
								<input
									type="checkbox"
									checked={this.state.vertexPaintSplitFaces}
									onChange={(event) => this.setState({ vertexPaintSplitFaces: event.target.checked })}
									aria-label="Isolate painted face boundaries"
								/>
								Isolate selected face corners so paint does not bleed into unselected faces
							</label>
						)}
						<div className="text-xs text-muted-foreground">
							RGBA is stored in Babylon's color vertex stream and participates in compatible Standard, PBR, and Node Materials.
						</div>
					</div>
				)}
				<div className="space-y-2 border-t border-input pt-2">
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>Pivot Editing</span>
						<span>World {pivotWorld.map((value) => value.toFixed(3)).join(", ")}</span>
					</div>
					<div className="text-xs text-muted-foreground">Local {pivotLocal.map((value) => value.toFixed(3)).join(", ")}</div>
					<div className="grid grid-cols-3 gap-2">
						{this.state.pivotWorldCoordinates.map((value, index) => (
							<Input
								key={index}
								type="number"
								step="1"
								value={value}
								onChange={(event) => {
									const next = [...this.state.pivotWorldCoordinates] as [string, string, string];
									next[index] = event.target.value;
									this.setState({ pivotWorldCoordinates: next });
								}}
								aria-label={`Pivot world ${["X", "Y", "Z"][index]}`}
							/>
						))}
					</div>
					<div className="grid grid-cols-3 gap-2">
						<Button size="sm" variant="secondary" onClick={() => this._setSelectedMeshPivot("world")}>
							Set World Pivot
						</Button>
						<Button size="sm" variant="secondary" onClick={() => this._setSelectedMeshPivot("boundsCenter")}>
							Center Pivot
						</Button>
						<Button size="sm" variant="secondary" disabled={!selection.indices.length} onClick={() => this._setSelectedMeshPivot("selectionAverage")}>
							Pivot To Selection
						</Button>
					</div>
					<div className="text-xs text-muted-foreground">
						Unity-style pivot relocation preserves world geometry, children, topology, rotation, and scale. The viewport transform gizmo anchors to this pivot.
					</div>
				</div>
				{editableSource && (
					<div className="space-y-2 border-t border-input pt-2">
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span>Editable Source / Runtime Geometry</span>
							<span>
								revision {editableSource.source.revision} · settings {editableSource.exportSettings.revision}
							</span>
						</div>
						<div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
							<div>
								Source: {editableSource.source.vertexCount} vertices · {editableSource.source.faceCount} faces
							</div>
							<div>
								Runtime: {editableSource.generated.vertexCount} vertices · {editableSource.generated.faceCount} faces
							</div>
						</div>
						<label className="flex items-center justify-between gap-2 text-sm">
							<span>Optimize Generated Geometry</span>
							<input
								type="checkbox"
								checked={editableSource.exportSettings.optimize}
								onChange={(event) => this._setMeshExportOptimization(event.target.checked)}
								aria-label="Optimize generated runtime geometry"
							/>
						</label>
						<div className="text-xs text-muted-foreground">
							{editableSource.exportSettings.optimize && editableSource.generated.optimizationApplied
								? `${editableSource.generated.removedUnusedOrDuplicateVertices} unused or bit-identical vertices removed from the detached runtime artifact.`
								: "Runtime records preserve the canonical source layout."}
						</div>
						{editableSource.generated.optimizationBlockers.length > 0 && (
							<div className="text-xs text-amber-400">Optimization held safely: {editableSource.generated.optimizationBlockers.join("; ")}.</div>
						)}
						<div className="text-xs text-muted-foreground">
							Project source stays in geometries/. Generated output is written separately and excludes selection, UV-layout, smoothing-group, vertex-paint, and
							source-manifest metadata.
						</div>
					</div>
				)}
				<div className="space-y-2 border-t border-input pt-2">
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>Mesh Integrity</span>
						<span>
							{meshIntegrity
								? `${meshIntegrity.issueCounts.errors} errors · ${meshIntegrity.issueCounts.warnings} warnings · ${meshIntegrity.issueCounts.info} info`
								: "Not inspected"}
						</span>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Button size="sm" variant="secondary" onClick={() => this._inspectSelectedMeshIntegrity()}>
							Validate Mesh
						</Button>
						<Button size="sm" variant="secondary" onClick={() => this._repairSelectedMeshIntegrity()}>
							Repair Mesh
						</Button>
					</div>
					{meshIntegrity && (
						<div className="text-xs text-muted-foreground">
							{meshIntegrity.counts.vertices} vertices · {meshIntegrity.counts.completeFaces} faces · {meshIntegrity.counts.connectedComponents} components ·{" "}
							{meshIntegrity.counts.boundaryEdges} boundaries · {meshIntegrity.counts.nonManifoldEdges} non-manifold
						</div>
					)}
					<div className="text-xs text-muted-foreground">
						Repair removes invalid, zero-area, and duplicate faces; compacts/welds compatible vertices; fixes winding, normals, skin weights, and submesh ranges.
						Ambiguous holes and non-manifold ownership remain diagnostics.
					</div>
				</div>
				{selection.mode === "edge" && selection.indices.length >= 1 && (
					<div className="space-y-1">
						<div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-2 text-xs text-muted-foreground">
							<span>Amount</span>
							<span>Segments</span>
							<span />
						</div>
						<div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-2">
							<Input
								type="number"
								min="0.0001"
								max="0.999999"
								step="0.1"
								value={this.state.edgeBevelAmount}
								onChange={(event) => this.setState({ edgeBevelAmount: event.target.value })}
								aria-label="Selected edge bevel amount"
							/>
							<Input
								type="number"
								min="1"
								max="8"
								step="1"
								value={this.state.edgeBevelSegments}
								onChange={(event) => this.setState({ edgeBevelSegments: event.target.value })}
								aria-label="Selected edge bevel segments"
							/>
							<Button size="sm" variant="secondary" onClick={() => this._bevelSelectedEdge()}>
								Bevel Connected
							</Button>
						</div>
					</div>
				)}
				{selection.mode === "edge" && selection.indices.length === 1 && (
					<div className="space-y-1">
						<div className="grid grid-cols-[7rem_7rem_minmax(0,1fr)] gap-2 text-xs text-muted-foreground">
							<span>Loop Cuts</span>
							<span>Offset</span>
							<span />
						</div>
						<div className="grid grid-cols-[7rem_7rem_minmax(0,1fr)] gap-2">
							<Input
								type="number"
								min="1"
								max="8"
								step="1"
								value={this.state.loopCutCount}
								onChange={(event) => this.setState({ loopCutCount: event.target.value })}
								aria-label="Loop cut count"
							/>
							<Input
								type="number"
								min="-0.49"
								max="0.49"
								step="0.05"
								value={this.state.loopCutOffset}
								onChange={(event) => this.setState({ loopCutOffset: event.target.value })}
								aria-label="Loop cut interval offset"
							/>
							<Button size="sm" variant="secondary" onClick={() => this._loopCutSelectedEdge()}>
								Insert Edge Loop
							</Button>
						</div>
						<div className="text-xs text-muted-foreground">Traverses opposite edges across the reconstructed manifold quad strip.</div>
					</div>
				)}
				{selection.mode === "edge" && selection.indices.length === 2 && (
					<Button size="sm" variant="secondary" className="w-full" onClick={() => this._bridgeSelectedEdges()}>
						Bridge Selected Edges
					</Button>
				)}
				{selection.mode === "edge" && selection.indices.length >= 1 && (
					<div className="grid grid-cols-2 gap-2">
						<Button size="sm" variant="secondary" onClick={() => this._setSelectedUvSeams("add")}>
							Mark UV Seams
						</Button>
						<Button size="sm" variant="secondary" onClick={() => this._setSelectedUvSeams("remove")}>
							Clear UV Seams
						</Button>
					</div>
				)}
				<div className="grid grid-cols-[6rem_minmax(0,1fr)_auto] gap-2 border-t border-input pt-2">
					<select
						className="h-9 rounded-md border border-input bg-background px-2 text-sm"
						value={this.state.uvProjectionPlane}
						onChange={(event) => this.setState({ uvProjectionPlane: event.target.value as "xy" | "xz" | "yz" })}
					>
						<option value="xy">XY UV</option>
						<option value="xz">XZ UV</option>
						<option value="yz">YZ UV</option>
					</select>
					<Input
						type="number"
						min="0.0001"
						step="1"
						value={this.state.uvProjectionScale}
						onChange={(event) => this.setState({ uvProjectionScale: event.target.value })}
						aria-label="Planar UV projection scale"
					/>
					<Button size="sm" variant="secondary" onClick={() => this._applyUVProjection()}>
						Project UVs
					</Button>
				</div>
				<div className="space-y-2 border-t border-input pt-2">
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>UV Charts</span>
						<span>{uvLayout ? `${uvLayout.chartCount} charts · ${uvLayout.seamCount} seams · revision ${uvLayout.revision}` : "Unavailable until mesh repair"}</span>
					</div>
					<div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
						<span>Padding</span>
						<span>Relax Iterations</span>
						<span>Strength</span>
					</div>
					<div className="grid grid-cols-3 gap-2">
						<Input
							type="number"
							min="0"
							max="0.1"
							step="0.005"
							value={this.state.uvChartPadding}
							onChange={(event) => this.setState({ uvChartPadding: event.target.value })}
							aria-label="UV chart padding"
						/>
						<Input
							type="number"
							min="0"
							max="100"
							step="1"
							value={this.state.uvRelaxIterations}
							onChange={(event) => this.setState({ uvRelaxIterations: event.target.value })}
							aria-label="UV relax iterations"
						/>
						<Input
							type="number"
							min="0.01"
							max="1"
							step="0.1"
							value={this.state.uvRelaxStrength}
							onChange={(event) => this.setState({ uvRelaxStrength: event.target.value })}
							aria-label="UV relax strength"
						/>
					</div>
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={this.state.uvAllowRotation}
							onChange={(event) => this.setState({ uvAllowRotation: event.target.checked })}
							aria-label="Allow UV chart rotation"
						/>
						Allow 90° chart rotation · harmonic relax · equal texel density
					</label>
					<Button size="sm" variant="secondary" className="w-full" onClick={() => this._unwrapMeshUVs()}>
						Relax &amp; Pack UV Charts
					</Button>
				</div>
			</div>
		);
	}

	private _setMeshComponentSelection(mode: string, indices: number[]): void {
		const mesh = this.props.object;
		if (!isMesh(mesh) || (mode !== "vertex" && mode !== "edge" && mode !== "face")) {
			return;
		}
		setMeshSelection(mesh.getScene(), { nodeId: mesh.id, mode, indices }, { editor: this.props.editor });
		this.setState({ selectionIndices: null });
	}

	private _applyMeshComponentSelection(mode: string): void {
		const text = (this.state.selectionIndices ?? "").trim();
		const indices = text ? text.split(",").map((value) => Number(value.trim())) : [];
		this._setMeshComponentSelection(mode, indices);
	}

	private _applySelectedFaceOperation(operation: "extrude" | "inset"): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const amount = Number(this.state.faceOperationAmount);
		if (!Number.isFinite(amount) || amount <= 0) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if (selection.mode !== "face" || !selection.indices.length) {
			return;
		}
		const options = { editor: this.props.editor };
		const before = getMeshVertexData(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof getMeshVertexData> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => setMeshVertexData(scene, { nodeId: mesh.id, positions: before.positions, normals: before.normals, uvs: before.uvs, indices: before.indices }, options),
			redo: () => {
				if (!after) {
					after =
						operation === "extrude"
							? extrudeMeshFaces(scene, { nodeId: mesh.id, faceIndices: selection.indices, distance: amount }, options)
							: insetMeshFaces(scene, { nodeId: mesh.id, faceIndices: selection.indices, amount: Math.min(amount, 0.999999) }, options);
				} else {
					setMeshVertexData(scene, { nodeId: mesh.id, positions: after.positions, normals: after.normals, uvs: after.uvs, indices: after.indices }, options);
				}
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _detachSelectedFaces(mode: "gameObject" | "submesh"): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if (selection.mode !== "face" || !selection.indices.length) {
			return;
		}
		const options = { editor: this.props.editor };
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof captureLoopCutMeshSnapshot> | null = null;
		let detachedId: string | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				if (detachedId) {
					scene.getMeshById(detachedId)?.dispose(false, false);
					void this.props.editor.layout.graph.refresh().then(() => this.props.editor.layout.graph.setSelectedNode(mesh));
				}
				restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options);
			},
			redo: () => {
				if (mode === "submesh" && after) {
					restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, after, options);
					return;
				}
				const topology = getMeshTopology(scene, { nodeId: mesh.id });
				const result = detachMeshFaces(
					scene,
					{
						nodeId: mesh.id,
						expectedTopologyFingerprint: topology.topologyFingerprint,
						faceIndices: selection.indices,
						mode,
						name: mode === "gameObject" ? `${mesh.name} Detached` : undefined,
						detachedId: detachedId ?? undefined,
					},
					options
				);
				detachedId = result.detachedMesh?.id ?? null;
				after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _applySelectedSmoothingGroup(group: number): void {
		const mesh = this.props.object;
		if (!isMesh(mesh) || !Number.isInteger(group) || group < 0 || group > 24) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if (selection.mode !== "face" || !selection.indices.length) {
			return;
		}
		const options = { editor: this.props.editor };
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof captureLoopCutMeshSnapshot> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options),
			redo: () => {
				if (after) {
					restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, after, options);
					return;
				}
				const state = getMeshSmoothingGroups(scene, { nodeId: mesh.id, faceIndices: selection.indices.slice(0, 256) });
				setMeshSmoothingGroup(
					scene,
					{
						nodeId: mesh.id,
						expectedTopologyFingerprint: state.topologyFingerprint,
						expectedRevision: state.revision,
						faceIndices: selection.indices,
						group,
					},
					options
				);
				after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _autoSmoothSelectedFaces(): void {
		const mesh = this.props.object;
		const angleThreshold = Number(this.state.smoothingAngle);
		if (!isMesh(mesh) || !Number.isFinite(angleThreshold) || angleThreshold < 0 || angleThreshold > 180) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if (selection.mode !== "face" || !selection.indices.length) {
			return;
		}
		const options = { editor: this.props.editor };
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof captureLoopCutMeshSnapshot> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options),
			redo: () => {
				if (after) {
					restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, after, options);
					return;
				}
				const state = getMeshSmoothingGroups(scene, { nodeId: mesh.id, faceIndices: selection.indices.slice(0, 256) });
				autoSmoothMeshFaces(
					scene,
					{
						nodeId: mesh.id,
						expectedTopologyFingerprint: state.topologyFingerprint,
						expectedRevision: state.revision,
						faceIndices: selection.indices,
						angleThreshold,
					},
					options
				);
				after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _selectSmoothingGroup(): void {
		const mesh = this.props.object;
		const group = Number(this.state.smoothingGroup);
		if (!isMesh(mesh) || !Number.isInteger(group) || group < 0 || group > 24) {
			return;
		}
		const scene = mesh.getScene();
		const indices: number[] = [];
		let offset = 0;
		while (true) {
			const page = getMeshSmoothingGroups(scene, { nodeId: mesh.id, group, offset, limit: 256 });
			indices.push(...page.faces.map((face: any) => face.faceIndex));
			if (!page.hasMore) {
				break;
			}
			offset += page.returned;
		}
		this._setMeshComponentSelection("face", indices);
	}

	private _paintSelectedVertexColors(clear: boolean): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const alpha = clear ? 1 : Number(this.state.vertexPaintAlpha);
		const opacity = clear ? 1 : Number(this.state.vertexPaintOpacity);
		const match = /^#([0-9a-f]{6})$/i.exec(this.state.vertexPaintColor);
		if (!match || !Number.isFinite(alpha) || alpha < 0 || alpha > 1 || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if ((selection.mode !== "vertex" && selection.mode !== "face") || !selection.indices.length) {
			return;
		}
		const integer = Number.parseInt(match[1], 16);
		const color: [number, number, number, number] = clear ? [1, 1, 1, 1] : [((integer >> 16) & 255) / 255, ((integer >> 8) & 255) / 255, (integer & 255) / 255, alpha];
		const options = { editor: this.props.editor };
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof captureLoopCutMeshSnapshot> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options),
			redo: () => {
				if (after) {
					restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, after, options);
					return;
				}
				const state = getMeshVertexColors(scene, { nodeId: mesh.id, selectedOnly: true, offset: 0, limit: 1 });
				paintMeshVertexColors(
					scene,
					{
						nodeId: mesh.id,
						expectedTopologyFingerprint: state.topologyFingerprint,
						expectedColorFingerprint: state.colorFingerprint,
						expectedRevision: state.revision,
						targetMode: selection.mode,
						vertexIndices: selection.mode === "vertex" ? selection.indices : undefined,
						faceIndices: selection.mode === "face" ? selection.indices : undefined,
						color,
						blendMode: clear ? "replace" : this.state.vertexPaintBlendMode,
						opacity,
						splitFaceBoundaries: selection.mode === "face" ? this.state.vertexPaintSplitFaces : undefined,
					},
					options
				);
				after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _inspectSelectedMeshIntegrity(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const integrity = inspectMeshIntegrity(mesh.getScene(), { nodeId: mesh.id, offset: 0, limit: 256 });
		meshIntegrityReports.set(mesh, integrity);
		this.setState({ meshIntegrity: integrity });
	}

	private _syncPivotWorldCoordinates(mesh: Mesh): void {
		mesh.computeWorldMatrix(true);
		this.setState({
			pivotWorldCoordinates: mesh
				.getAbsolutePivotPoint()
				.asArray()
				.map((value) => String(value)) as [string, string, string],
		});
	}

	private _setSelectedMeshPivot(mode: "world" | "boundsCenter" | "selectionAverage"): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const worldPosition = this.state.pivotWorldCoordinates.map(Number);
		if (mode === "world" && worldPosition.some((value) => !Number.isFinite(value))) {
			toast.error("World pivot coordinates must be finite numbers.");
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if (mode === "selectionAverage" && !selection.indices.length) {
			toast.error("Select at least one vertex, edge, or face before setting the pivot to selection.");
			return;
		}
		const options = { editor: this.props.editor };
		const before = captureMeshPivotSnapshot(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof captureMeshPivotSnapshot> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => restoreMeshPivotSnapshot(scene, { nodeId: mesh.id }, before, options),
			redo: () => {
				if (after) {
					restoreMeshPivotSnapshot(scene, { nodeId: mesh.id }, after, options);
					return;
				}
				const inspected = getMeshPivot(scene, { nodeId: mesh.id });
				setMeshPivot(
					scene,
					{
						nodeId: mesh.id,
						expectedPivotFingerprint: inspected.pivotFingerprint,
						mode,
						worldPosition: mode === "world" ? worldPosition : undefined,
						selectionMode: mode === "selectionAverage" ? selection.mode : undefined,
						componentIndices: mode === "selectionAverage" ? selection.indices : undefined,
					},
					options
				);
				after = captureMeshPivotSnapshot(scene, { nodeId: mesh.id });
			},
			action: () => {
				this._syncPivotWorldCoordinates(mesh);
				onNodeModifiedObservable.notifyObservers(mesh);
				updateIblShadowsRenderPipeline(scene);
			},
		});
	}

	private _setMeshExportOptimization(optimize: boolean): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const scene = mesh.getScene();
		const options = { editor: this.props.editor };
		const before = captureMeshEditableSourceSnapshot(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof captureMeshEditableSourceSnapshot> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => restoreMeshEditableSourceSnapshot(scene, { nodeId: mesh.id }, before, options),
			redo: () => {
				if (after) {
					restoreMeshEditableSourceSnapshot(scene, { nodeId: mesh.id }, after, options);
					return;
				}
				const inspected = getMeshEditableSource(scene, { nodeId: mesh.id });
				setMeshExportGeometry(
					scene,
					{
						nodeId: mesh.id,
						expectedSourceFingerprint: inspected.source.fingerprint,
						expectedSourceRevision: inspected.source.revision,
						expectedExportSettingsRevision: inspected.exportSettings.revision,
						optimize,
					},
					options
				);
				after = captureMeshEditableSourceSnapshot(scene, { nodeId: mesh.id });
			},
			action: () => {
				onNodeModifiedObservable.notifyObservers(mesh);
				this.props.editor.layout.inspector.forceUpdate();
			},
		});
	}

	private _repairSelectedMeshIntegrity(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const scene = mesh.getScene();
		const options = { editor: this.props.editor };
		const before = captureMeshIntegritySnapshot(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof captureMeshIntegritySnapshot> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => restoreMeshIntegritySnapshot(scene, { nodeId: mesh.id }, before, options),
			redo: () => {
				if (after) {
					restoreMeshIntegritySnapshot(scene, { nodeId: mesh.id }, after, options);
					return;
				}
				const inspected = inspectMeshIntegrity(scene, { nodeId: mesh.id, offset: 0, limit: 256 });
				const repaired = repairMeshIntegrity(
					scene,
					{
						nodeId: mesh.id,
						expectedIntegrityFingerprint: inspected.integrityFingerprint,
						operations: [
							"removeInvalidFaces",
							"removeDegenerateFaces",
							"removeDuplicateFaces",
							"removeUnusedVertices",
							"weldIdenticalVertices",
							"fixWinding",
							"rebuildNormals",
							"normalizeSkinWeights",
							"rebuildSubMeshes",
						],
						confirm: true,
					},
					options
				);
				meshIntegrityReports.set(mesh, repaired);
				after = captureMeshIntegritySnapshot(scene, { nodeId: mesh.id });
			},
			action: () => {
				const integrity = inspectMeshIntegrity(scene, { nodeId: mesh.id, offset: 0, limit: 256 });
				meshIntegrityReports.set(mesh, integrity);
				this.setState({ meshIntegrity: integrity });
			},
		});
	}

	private _bridgeSelectedEdges(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		if (selection.mode !== "edge" || selection.indices.length !== 2) {
			return;
		}
		const firstEdge = topology.edges[selection.indices[0]];
		const secondEdge = topology.edges[selection.indices[1]];
		if (!firstEdge || !secondEdge) {
			return;
		}
		const options = { editor: this.props.editor };
		const before = getMeshVertexData(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof getMeshVertexData> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => setMeshVertexData(scene, { nodeId: mesh.id, positions: before.positions, normals: before.normals, uvs: before.uvs, indices: before.indices }, options),
			redo: () => {
				if (!after) {
					after = bridgeMeshEdges(scene, { nodeId: mesh.id, firstEdge, secondEdge }, options);
				} else {
					setMeshVertexData(scene, { nodeId: mesh.id, positions: after.positions, normals: after.normals, uvs: after.uvs, indices: after.indices }, options);
				}
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _loopCutSelectedEdge(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const cuts = Number(this.state.loopCutCount);
		const offset = Number(this.state.loopCutOffset);
		if (!Number.isInteger(cuts) || cuts < 1 || cuts > 8 || !Number.isFinite(offset) || offset < -0.49 || offset > 0.49) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if (selection.mode !== "edge" || selection.indices.length !== 1) {
			return;
		}
		const options = { editor: this.props.editor };
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof captureLoopCutMeshSnapshot> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options),
			redo: () => {
				if (!after) {
					const topology = getMeshTopology(scene, { nodeId: mesh.id });
					loopCutMesh(
						scene,
						{
							nodeId: mesh.id,
							expectedTopologyFingerprint: topology.topologyFingerprint,
							edgeIndex: selection.indices[0],
							cuts,
							offset,
						},
						options
					);
					after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
				} else {
					restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, after, options);
				}
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _bevelSelectedEdge(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const amount = Number(this.state.edgeBevelAmount);
		const segments = Number(this.state.edgeBevelSegments);
		if (!(amount > 0 && amount < 1)) {
			return;
		}
		if (!Number.isInteger(segments) || segments < 1 || segments > 8) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if (selection.mode !== "edge" || !selection.indices.length) {
			return;
		}
		const options = { editor: this.props.editor };
		const before = getMeshVertexData(scene, { nodeId: mesh.id });
		let after: any = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				setMeshVertexData(scene, { nodeId: mesh.id, positions: before.positions, normals: before.normals, uvs: before.uvs, indices: before.indices }, options);
				setMeshSelection(scene, { nodeId: mesh.id, mode: "edge", indices: selection.indices }, options);
			},
			redo: () => {
				if (!after) {
					after =
						selection.indices.length === 1
							? bevelMeshEdge(scene, { nodeId: mesh.id, edgeIndex: selection.indices[0], amount, segments }, options)
							: bevelMeshEdges(scene, { nodeId: mesh.id, edgeIndices: selection.indices, amount, segments }, options);
				} else {
					setMeshVertexData(scene, { nodeId: mesh.id, positions: after.positions, normals: after.normals, uvs: after.uvs, indices: after.indices }, options);
					setMeshSelection(scene, { nodeId: mesh.id, mode: "edge", indices: [] }, options);
				}
			},
		});
	}

	private _setSelectedUvSeams(mode: "add" | "remove"): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const scene = mesh.getScene();
		const selection = getMeshSelection(scene, { nodeId: mesh.id });
		if (selection.mode !== "edge" || !selection.indices.length) {
			return;
		}
		const options = { editor: this.props.editor };
		const beforeMetadata = mesh.metadata?.babylonEditorUvLayout ? JSON.parse(JSON.stringify(mesh.metadata.babylonEditorUvLayout)) : undefined;
		let afterMetadata: any;
		const restoreMetadata = (value: any): void => {
			mesh.metadata ??= {};
			if (value === undefined) {
				delete mesh.metadata.babylonEditorUvLayout;
			} else {
				mesh.metadata.babylonEditorUvLayout = JSON.parse(JSON.stringify(value));
			}
			this.props.editor.layout.inspector.forceUpdate();
		};
		registerUndoRedo({
			executeRedo: true,
			undo: () => restoreMetadata(beforeMetadata),
			redo: () => {
				if (afterMetadata === undefined) {
					const layout = getMeshUvLayout(scene, { nodeId: mesh.id, offset: 0, limit: 1 });
					setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: layout.revision, mode, edgeIndices: selection.indices }, options);
					afterMetadata = JSON.parse(JSON.stringify(mesh.metadata.babylonEditorUvLayout));
				} else {
					restoreMetadata(afterMetadata);
				}
			},
		});
	}

	private _applyUVProjection(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const scale = Number(this.state.uvProjectionScale);
		if (!Number.isFinite(scale) || scale <= 0) {
			return;
		}
		const scene = mesh.getScene();
		const options = { editor: this.props.editor };
		const before = getMeshVertexData(scene, { nodeId: mesh.id });
		let after: ReturnType<typeof getMeshVertexData> | null = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () => setMeshVertexData(scene, { nodeId: mesh.id, positions: before.positions, normals: before.normals, uvs: before.uvs, indices: before.indices }, options),
			redo: () => {
				if (!after) {
					after = setMeshUVProjection(scene, { nodeId: mesh.id, plane: this.state.uvProjectionPlane, scale }, options);
				} else {
					setMeshVertexData(scene, { nodeId: mesh.id, positions: after.positions, normals: after.normals, uvs: after.uvs, indices: after.indices }, options);
				}
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _captureUvVertexStreams(mesh: Mesh): IMeshUvVertexStreamSnapshot[] {
		const managedKinds = new Set([
			VertexBuffer.PositionKind,
			VertexBuffer.NormalKind,
			VertexBuffer.UVKind,
			VertexBuffer.MatricesIndicesKind,
			VertexBuffer.MatricesWeightsKind,
			VertexBuffer.MatricesIndicesExtraKind,
			VertexBuffer.MatricesWeightsExtraKind,
		]);
		return mesh
			.getVerticesDataKinds()
			.filter((kind) => !managedKinds.has(kind))
			.flatMap((kind) => {
				const buffer = mesh.getVertexBuffer(kind);
				const values = mesh.getVerticesData(kind, false);
				return buffer && values ? [{ kind, values: Array.from(values), stride: buffer.getStrideSize(), updatable: buffer.isUpdatable() }] : [];
			});
	}

	private _restoreUvVertexStreams(mesh: Mesh, streams: IMeshUvVertexStreamSnapshot[]): void {
		const kinds = new Set(streams.map((stream) => stream.kind));
		for (const currentKind of this._captureUvVertexStreams(mesh).map((stream) => stream.kind)) {
			if (!kinds.has(currentKind)) {
				mesh.removeVerticesData(currentKind);
			}
		}
		for (const stream of streams) {
			mesh.setVerticesData(stream.kind, stream.values, stream.updatable, stream.stride);
		}
	}

	private _unwrapMeshUVs(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const padding = Number(this.state.uvChartPadding);
		const relaxIterations = Number(this.state.uvRelaxIterations);
		const relaxStrength = Number(this.state.uvRelaxStrength);
		if (
			!Number.isFinite(padding) ||
			padding < 0 ||
			padding > 0.1 ||
			!Number.isInteger(relaxIterations) ||
			relaxIterations < 0 ||
			relaxIterations > 100 ||
			!(relaxStrength > 0 && relaxStrength <= 1)
		) {
			return;
		}
		const scene = mesh.getScene();
		const options = { editor: this.props.editor };
		const before = getMeshVertexData(scene, { nodeId: mesh.id });
		const beforeVertexStreams = this._captureUvVertexStreams(mesh);
		const beforeMetadata = mesh.metadata?.babylonEditorUvLayout ? JSON.parse(JSON.stringify(mesh.metadata.babylonEditorUvLayout)) : undefined;
		let after: any = null;
		let afterVertexStreams: IMeshUvVertexStreamSnapshot[] = [];
		let afterMetadata: any;
		const restoreMetadata = (value: any): void => {
			mesh.metadata ??= {};
			if (value === undefined) {
				delete mesh.metadata.babylonEditorUvLayout;
			} else {
				mesh.metadata.babylonEditorUvLayout = JSON.parse(JSON.stringify(value));
			}
		};
		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				setMeshVertexData(
					scene,
					{
						nodeId: mesh.id,
						positions: before.positions,
						normals: before.normals,
						uvs: before.uvs,
						indices: before.indices,
						matricesIndices: before.matricesIndices,
						matricesWeights: before.matricesWeights,
						matricesIndicesExtra: before.matricesIndicesExtra,
						matricesWeightsExtra: before.matricesWeightsExtra,
					},
					options
				);
				this._restoreUvVertexStreams(mesh, beforeVertexStreams);
				restoreMetadata(beforeMetadata);
			},
			redo: () => {
				if (!after) {
					const layout = getMeshUvLayout(scene, { nodeId: mesh.id, offset: 0, limit: 1 });
					after = unwrapMeshUVs(
						scene,
						{
							nodeId: mesh.id,
							expectedRevision: layout.revision,
							padding,
							relaxIterations,
							relaxStrength,
							allowRotation: this.state.uvAllowRotation,
							autoSeams: true,
							normalizeTexelDensity: true,
						},
						options
					);
					afterVertexStreams = this._captureUvVertexStreams(mesh);
					afterMetadata = JSON.parse(JSON.stringify(mesh.metadata.babylonEditorUvLayout));
				} else {
					setMeshVertexData(
						scene,
						{
							nodeId: mesh.id,
							positions: after.positions,
							normals: after.normals,
							uvs: after.uvs,
							indices: after.indices,
							matricesIndices: after.matricesIndices,
							matricesWeights: after.matricesWeights,
							matricesIndicesExtra: after.matricesIndicesExtra,
							matricesWeightsExtra: after.matricesWeightsExtra,
						},
						options
					);
					this._restoreUvVertexStreams(mesh, afterVertexStreams);
					restoreMetadata(afterMetadata);
				}
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _getMaterialInspectorComponent(material: Material): ReactNode {
		switch (material.getClassName()) {
			case "PBRMaterial":
				return <EditorPBRMaterialInspector mesh={this.props.object} material={this.props.object.material as PBRMaterial} editor={this.props.editor} />;

			case "StandardMaterial":
				return <EditorStandardMaterialInspector mesh={this.props.object} material={this.props.object.material as StandardMaterial} />;

			case "NodeMaterial":
				return <EditorNodeMaterialInspector mesh={this.props.object} material={this.props.object.material as NodeMaterial} editor={this.props.editor} />;

			case "MultiMaterial":
				return <EditorMultiMaterialInspector editor={this.props.editor} material={this.props.object.material as MultiMaterial} />;

			case "SkyMaterial":
				return <EditorSkyMaterialInspector mesh={this.props.object} material={this.props.object.material as SkyMaterial} />;

			case "GridMaterial":
				return <EditorGridMaterialInspector mesh={this.props.object} material={this.props.object.material as GridMaterial} />;

			case "NormalMaterial":
				return <EditorNormalMaterialInspector mesh={this.props.object} material={this.props.object.material as NormalMaterial} />;

			case "WaterMaterial":
				return <EditorWaterMaterialInspector mesh={this.props.object} material={this.props.object.material as WaterMaterial} />;

			case "LavaMaterial":
				return <EditorLavaMaterialInspector mesh={this.props.object} material={this.props.object.material as LavaMaterial} />;

			case "TriPlanarMaterial":
				return <EditorTriPlanarMaterialInspector mesh={this.props.object} material={this.props.object.material as TriPlanarMaterial} />;

			case "TerrainMaterial":
				return <EditorTerrainMaterialInspector mesh={this.props.object} material={this.props.object.material as TerrainMaterial} editor={this.props.editor} />;

			case "CellMaterial":
				return <EditorCellMaterialInspector mesh={this.props.object} material={this.props.object.material as CellMaterial} />;

			case "FireMaterial":
				return <EditorFireMaterialInspector mesh={this.props.object} material={this.props.object.material as FireMaterial} />;

			case "GradientMaterial":
				return <EditorGradientMaterialInspector mesh={this.props.object} material={this.props.object.material as GradientMaterial} />;
		}
	}

	private _getSplineFollowerComponent(): ReactNode {
		const follower = this.props.object.metadata?.babylonEditorSplineFollower;
		if (!follower) {
			return null;
		}
		return (
			<EditorInspectorSectionField title="Spline Follower">
				<EditorInspectorListField
					label="Spline"
					object={follower}
					property="splineId"
					search
					items={this.props.editor.layout.preview.scene.meshes
						.filter((mesh) => mesh.metadata?.type === "Spline")
						.map((spline) => ({ key: spline.id, text: spline.name, value: spline.id }))}
				/>
				<EditorInspectorNumberField label="Speed (cm/s)" object={follower} property="speed" min={0} step={1} />
				<EditorInspectorNumberField label="Start Position" object={follower} property="t" min={0} max={1} step={0.01} />
				<EditorInspectorSwitchField label="Loop" object={follower} property="loop" />
				<EditorInspectorSwitchField label="Orient To Path" object={follower} property="orientToPath" />
			</EditorInspectorSectionField>
		);
	}

	private _getSkeletonComponent(): ReactNode {
		if (!this.props.object.skeleton) {
			return null;
		}

		return <EditorSkeletonInspector object={this.props.object.skeleton} editor={this.props.editor} />;
	}

	private _getMorphTargetManagerComponent(): ReactNode {
		if (!this.props.object.morphTargetManager) {
			return null;
		}

		const targets: MorphTarget[] = [];
		for (let i = 0, len = this.props.object.morphTargetManager.numTargets; i < len; ++i) {
			targets.push(this.props.object.morphTargetManager.getTarget(i));
		}

		return (
			<EditorInspectorSectionField title="Morph Targets">
				{targets.map((target, index) => (
					<EditorInspectorNumberField key={index} object={target} property="influence" min={0} max={1} label={target.name} />
				))}
			</EditorInspectorSectionField>
		);
	}

	private _handleCastShadowsChanged(enabled: boolean): void {
		const lightsWithShadows = this.props.editor.layout.preview.scene.lights.filter((light) => {
			return light.getShadowGenerator()?.getShadowMap()?.renderList;
		});

		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				lightsWithShadows.forEach((light) => {
					if (enabled) {
						const index = light.getShadowGenerator()?.getShadowMap()?.renderList?.indexOf(this.props.object);
						if (index !== undefined && index !== -1) {
							light.getShadowGenerator()?.getShadowMap()?.renderList?.splice(index, 1);
						}
					} else {
						light.getShadowGenerator()?.getShadowMap()?.renderList?.push(this.props.object);
					}

					updateLightShadowMapRefreshRate(light);
					updatePointLightShadowMapRenderListPredicate(light);
				});
			},
			redo: () => {
				lightsWithShadows.forEach((light) => {
					if (enabled) {
						light.getShadowGenerator()?.getShadowMap()?.renderList?.push(this.props.object);
					} else {
						const index = light.getShadowGenerator()?.getShadowMap()?.renderList?.indexOf(this.props.object);
						if (index !== undefined && index !== -1) {
							light.getShadowGenerator()?.getShadowMap()?.renderList?.splice(index, 1);
						}
					}

					updateLightShadowMapRefreshRate(light);
					updatePointLightShadowMapRenderListPredicate(light);
				});
			},
		});
	}
}
