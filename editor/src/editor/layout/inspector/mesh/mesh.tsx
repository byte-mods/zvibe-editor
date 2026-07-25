import { extname } from "path/posix";

import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { FaLink } from "react-icons/fa6";
import { AiOutlinePlus } from "react-icons/ai";

import { AbstractMesh, InstancedMesh, Material, MorphTarget, MultiMaterial, Node, Observer, PBRMaterial, StandardMaterial, NodeMaterial, TrailMesh } from "babylonjs";
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
	unwrapMeshUVs,
	subdivideMesh,
} from "../../../../mcp/meshes/meshes";
import { getVfxTrail, setVfxTrail } from "../../../../mcp/vfx/trails";
import {
	createPhysics2DEffector,
	deletePhysics2DEffector,
	generatePhysics2DPolygonCollider,
	listPhysics2D,
	listPhysics2DEffectors,
	listPhysics2DMaterials,
	removePhysics2DBody,
	setPhysics2DBody,
	setPhysics2DEffector,
} from "../../../../mcp/physics2d/physics2d";
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

export interface IEditorMeshInspectorState {
	dragOver: boolean;
	selectionIndices: string | null;
	faceOperationAmount: string;
	uvProjectionPlane: "xy" | "xz" | "yz";
	uvProjectionScale: string;
	navMeshPath: string;
	polygonColliderImagePath: string;
	prefabLinks: any[];
	prefabTargetIndex: number;
	prefabBusy: boolean;
	prefabStructure: any | null;
	prefabComparison: any | null;
	prefabComparisonQuery: string;
}

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

		this.state = {
			dragOver: false,
			selectionIndices: null,
			faceOperationAmount: "10",
			uvProjectionPlane: "xz",
			uvProjectionScale: "100",
			navMeshPath: "",
			polygonColliderImagePath: "",
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
						{this._getPhysics2DComponent()}
						{this._getPhysics2DEffectorComponent()}
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
							{agent.navMeshPath} · {agent.isMoving ? "moving" : `${agent.path?.length ?? 0} path points`}
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
								defaultValue={String(agent.avoidanceRadius ?? agent.radius)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Nav agent avoidance radius"
								onBlur={(event) => this._setNavAgentNumber(agent, "avoidanceRadius", event.target.value)}
							/>
							<Input
								defaultValue={String(agent.avoidanceWeight ?? 1)}
								type="number"
								min="0"
								step="any"
								aria-label="Nav agent avoidance weight"
								onBlur={(event) => this._setNavAgentNumber(agent, "avoidanceWeight", event.target.value)}
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

	private _setNavAgentNumber(agent: any, property: "radius" | "height" | "maxSpeed" | "maxAcceleration" | "avoidanceRadius" | "avoidanceWeight", value: string): void {
		const number = Number(value);
		if (!Number.isFinite(number) || (property === "avoidanceWeight" ? number < 0 : number <= 0)) {
			return;
		}
		try {
			setNavAgent(this.props.object.getScene(), { id: agent.id, [property]: number }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setNavAgentAvoidance(agent: any, avoidanceEnabled: boolean): void {
		try {
			setNavAgent(this.props.object.getScene(), { id: agent.id, avoidanceEnabled }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
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
		try {
			startNavAgent(this.props.object.getScene(), { id: agent.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _stopNavAgent(agent: any): void {
		try {
			stopNavAgent(this.props.object.getScene(), { id: agent.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteNavAgent(agent: any): void {
		try {
			deleteNavAgent(this.props.object.getScene(), { id: agent.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
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
				)}
				{selection.mode === "edge" && selection.indices.length >= 1 && (
					<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
						<Input
							type="number"
							min="0.0001"
							max="0.999999"
							step="0.1"
							value={this.state.faceOperationAmount}
							onChange={(event) => this.setState({ faceOperationAmount: event.target.value })}
							aria-label="Selected edge bevel amount"
						/>
						<Button size="sm" variant="secondary" onClick={() => this._bevelSelectedEdge()}>
							Bevel
						</Button>
					</div>
				)}
				{selection.mode === "edge" && selection.indices.length === 2 && (
					<Button size="sm" variant="secondary" className="w-full" onClick={() => this._bridgeSelectedEdges()}>
						Bridge Selected Edges
					</Button>
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
					<Button size="sm" variant="secondary" onClick={() => this._unwrapMeshUVs()}>
						Auto Unwrap
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

	private _bevelSelectedEdge(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const amount = Number(this.state.faceOperationAmount);
		if (!(amount > 0 && amount < 1)) {
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
			undo: () => setMeshVertexData(scene, { nodeId: mesh.id, positions: before.positions, normals: before.normals, uvs: before.uvs, indices: before.indices }, options),
			redo: () => {
				if (!after) {
					after =
						selection.indices.length === 1
							? bevelMeshEdge(scene, { nodeId: mesh.id, edgeIndex: selection.indices[0], amount }, options)
							: bevelMeshEdges(scene, { nodeId: mesh.id, edgeIndices: selection.indices, amount }, options);
				} else {
					setMeshVertexData(scene, { nodeId: mesh.id, positions: after.positions, normals: after.normals, uvs: after.uvs, indices: after.indices }, options);
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

	private _unwrapMeshUVs(): void {
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
			undo: () => setMeshVertexData(scene, { nodeId: mesh.id, positions: before.positions, normals: before.normals, uvs: before.uvs, indices: before.indices }, options),
			redo: () => {
				if (!after) {
					after = unwrapMeshUVs(scene, { nodeId: mesh.id }, options);
				} else {
					setMeshVertexData(scene, { nodeId: mesh.id, positions: after.positions, normals: after.normals, uvs: after.uvs, indices: after.indices }, options);
				}
			},
			action: () => this.props.editor.layout.inspector.forceUpdate(),
		});
	}

	private _getPhysics2DComponent(): ReactNode {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return null;
		}
		const body = listPhysics2D(mesh.getScene()).bodies.find((candidate: any) => candidate.nodeId === mesh.id);
		const physicsMaterials = listPhysics2DMaterials(mesh.getScene()).materials;
		return (
			<EditorInspectorSectionField
				title="2D Physics"
				tooltip="Lightweight X/Y-plane body, collider, trigger, and material simulation. Configure joints and numeric solver settings through MCP."
			>
				{!body ? (
					<Button variant="secondary" className="w-full" onClick={() => this._setPhysics2DBody()}>
						Add 2D Body
					</Button>
				) : (
					<>
						<div className="grid grid-cols-2 gap-2">
							<select
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={body.bodyType}
								onChange={(event) => this._setPhysics2DBody({ bodyType: event.target.value })}
							>
								<option value="dynamic">Dynamic</option>
								<option value="static">Static</option>
							</select>
							<Button variant={body.isTrigger ? "default" : "secondary"} onClick={() => this._setPhysics2DBody({ isTrigger: !body.isTrigger })}>
								{body.isTrigger ? "Trigger" : "Solid"}
							</Button>
						</div>
						<div className="text-xs text-muted-foreground">
							{body.collider.shape === "circle"
								? `Circle radius ${body.collider.radius}`
								: body.collider.shape === "polygon"
									? `${body.collider.parts?.length > 1 ? "Concave" : "Convex"} polygon (${body.collider.points.length} vertices${body.collider.parts?.length > 1 ? `, ${body.collider.parts.length} parts` : ""})`
									: `Box ${body.collider.size[0]} × ${body.collider.size[1]}`}{" "}
							cm
						</div>
						<select
							className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
							value={body.collider.shape}
							onChange={(event) => this._setPhysics2DColliderShape(event.target.value)}
						>
							<option value="box">Box collider</option>
							<option value="circle">Circle collider</option>
							<option value="polygon">Polygon collider</option>
						</select>
						{body.collider.shape === "circle" ? (
							<label className="flex items-center justify-between gap-2 text-sm">
								Radius (cm)
								<input
									className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm"
									type="number"
									min={0.01}
									step={1}
									value={body.collider.radius}
									onChange={(event) => this._setPhysics2DCircleRadius(event.target.value)}
								/>
							</label>
						) : body.collider.shape === "polygon" ? (
							<>
								<label className="flex flex-col gap-1 text-sm">
									<span>Vertices (local x,y; x,y…)</span>
									<textarea
										className="min-h-16 rounded-md border border-input bg-background p-2 font-mono text-xs"
										defaultValue={body.collider.points.map((point: number[]) => point.join(",")).join("; ")}
										onBlur={(event) => this._setPhysics2DPolygonVertices(event.currentTarget.value)}
									/>
								</label>
								<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
									<Input
										value={this.state.polygonColliderImagePath}
										onChange={(event) => this.setState({ polygonColliderImagePath: event.currentTarget.value })}
										placeholder="assets/sprite.png"
										aria-label="Polygon collider source image"
									/>
									<div className="flex gap-2">
										<Button
											variant="secondary"
											disabled={!this.state.polygonColliderImagePath.trim()}
											onClick={() => this._generatePhysics2DPolygonCollider("convex")}
										>
											Convex Outline
										</Button>
										<Button
											variant="secondary"
											disabled={!this.state.polygonColliderImagePath.trim()}
											onClick={() => this._generatePhysics2DPolygonCollider("concave")}
										>
											Concave Outline
										</Button>
									</div>
								</div>
							</>
						) : (
							<div className="grid grid-cols-2 gap-2">
								<label className="flex items-center justify-between gap-2 text-sm">
									W (cm)
									<input
										className="h-9 w-20 rounded-md border border-input bg-background px-3 text-sm"
										type="number"
										min={0.01}
										step={1}
										value={body.collider.size[0]}
										onChange={(event) => this._setPhysics2DBoxSize(event.target.value, body.collider.size[1])}
									/>
								</label>
								<label className="flex items-center justify-between gap-2 text-sm">
									H (cm)
									<input
										className="h-9 w-20 rounded-md border border-input bg-background px-3 text-sm"
										type="number"
										min={0.01}
										step={1}
										value={body.collider.size[1]}
										onChange={(event) => this._setPhysics2DBoxSize(body.collider.size[0], event.target.value)}
									/>
								</label>
							</div>
						)}
						<select
							className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
							value={body.materialId ?? ""}
							onChange={(event) => this._setPhysics2DBody({ materialId: event.target.value || null })}
						>
							<option value="">No 2D material</option>
							{physicsMaterials.map((material: any) => (
								<option key={material.id} value={material.id}>
									{material.name} ({material.friction} friction, {material.restitution} bounce)
								</option>
							))}
						</select>
						<Button variant="ghost" className="w-full hover:bg-destructive" onClick={() => this._removePhysics2DBody()}>
							Remove 2D Body
						</Button>
					</>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _setPhysics2DBody(update: any = {}): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const current = listPhysics2D(mesh.getScene()).bodies.find((candidate: any) => candidate.nodeId === mesh.id);
		setPhysics2DBody(
			mesh.getScene(),
			{
				nodeId: mesh.id,
				bodyType: current?.bodyType ?? "dynamic",
				collider: current?.collider ?? { shape: "box", size: [100, 100] },
				...update,
			},
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _setPhysics2DColliderShape(shape: string): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		const body = listPhysics2D(mesh.getScene()).bodies.find((candidate: any) => candidate.nodeId === mesh.id);
		const collider =
			shape === "circle"
				? { shape, radius: body?.collider.radius ?? 50 }
				: shape === "polygon"
					? {
							shape,
							points: body?.collider.points ?? [
								[-50, -50],
								[50, -50],
								[50, 50],
								[-50, 50],
							],
						}
					: { shape: "box", size: body?.collider.size ?? [100, 100] };
		this._setPhysics2DBody({ collider });
	}

	private _setPhysics2DPolygonVertices(value: string): void {
		const points = value
			.split(";")
			.map((pair) => pair.split(",").map(Number))
			.filter((point) => point.length === 2 && point.every(Number.isFinite));
		if (points.length < 3) {
			return;
		}
		this._setPhysics2DBody({ collider: { shape: "polygon", points } });
	}

	private async _generatePhysics2DPolygonCollider(outline: "convex" | "concave"): Promise<void> {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		try {
			await generatePhysics2DPolygonCollider(
				mesh.getScene(),
				{ nodeId: mesh.id, imagePath: this.state.polygonColliderImagePath.trim(), outline },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not generate the polygon collider.");
		}
	}

	private _setPhysics2DCircleRadius(value: string): void {
		const radius = Number(value);
		if (radius > 0) {
			this._setPhysics2DBody({ collider: { shape: "circle", radius } });
		}
	}

	private _setPhysics2DBoxSize(widthValue: string | number, heightValue: string | number): void {
		const width = Number(widthValue);
		const height = Number(heightValue);
		if (width > 0 && height > 0) {
			this._setPhysics2DBody({ collider: { shape: "box", size: [width, height] } });
		}
	}

	private _removePhysics2DBody(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		removePhysics2DBody(mesh.getScene(), { nodeId: mesh.id }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _getPhysics2DEffectorComponent(): ReactNode {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return null;
		}
		const effector = listPhysics2DEffectors(mesh.getScene()).effectors.find((candidate: any) => candidate.nodeId === mesh.id);
		return (
			<EditorInspectorSectionField title="2D Effector" tooltip="Point, Area, Surface, or one-way Platform behavior in the local X/Y plane.">
				{!effector ? (
					<Button variant="secondary" className="w-full" onClick={() => this._createPhysics2DEffector()}>
						Add Point Effector
					</Button>
				) : (
					<>
						<select
							className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
							value={effector.type ?? "point"}
							onChange={(event) => this._setPhysics2DEffector(effector, { type: event.target.value })}
						>
							<option value="point">Point (attract / repel)</option>
							<option value="area">Area (directional)</option>
							<option value="surface">Surface (tangential ring)</option>
							<option value="platform">Platform (one-way collision)</option>
						</select>
						<label className="flex items-center justify-between gap-2 text-sm">
							Radius (cm)
							<input
								className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm"
								type="number"
								min={0.01}
								step={1}
								value={effector.radius}
								onChange={(event) => this._setPhysics2DEffectorNumber(effector, "radius", event.target.value)}
							/>
						</label>
						<label className="flex items-center justify-between gap-2 text-sm">
							Force
							<input
								className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm"
								type="number"
								step={1}
								value={effector.force}
								onChange={(event) => this._setPhysics2DEffectorNumber(effector, "force", event.target.value)}
							/>
						</label>
						<label className="flex items-center justify-between gap-2 text-sm">
							Falloff
							<input
								className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm"
								type="number"
								min={0}
								step={0.1}
								value={effector.falloff}
								onChange={(event) => this._setPhysics2DEffectorNumber(effector, "falloff", event.target.value)}
							/>
						</label>
						{effector.type === "area" && (
							<label className="flex items-center justify-between gap-2 text-sm">
								Angle (deg)
								<input
									className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm"
									type="number"
									step={1}
									value={effector.forceAngle ?? 0}
									onChange={(event) => this._setPhysics2DEffectorNumber(effector, "forceAngle", event.target.value)}
								/>
							</label>
						)}
						{effector.type === "surface" && (
							<label className="flex items-center justify-between gap-2 text-sm">
								Ring thickness (cm)
								<input
									className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm"
									type="number"
									min={0.01}
									step={1}
									value={effector.surfaceThickness ?? 20}
									onChange={(event) => this._setPhysics2DEffectorNumber(effector, "surfaceThickness", event.target.value)}
								/>
							</label>
						)}
						{effector.type === "platform" && (
							<label className="flex items-center justify-between gap-2 text-sm">
								Surface side (deg)
								<input
									className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm"
									type="number"
									step={1}
									value={effector.platformAngle ?? 90}
									onChange={(event) => this._setPhysics2DEffectorNumber(effector, "platformAngle", event.target.value)}
								/>
							</label>
						)}
						<Button variant="ghost" className="w-full hover:bg-destructive" onClick={() => this._deletePhysics2DEffector(effector.id)}>
							Remove Effector
						</Button>
					</>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _createPhysics2DEffector(): void {
		const mesh = this.props.object;
		if (!isMesh(mesh)) {
			return;
		}
		createPhysics2DEffector(mesh.getScene(), { nodeId: mesh.id }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setPhysics2DEffector(effector: any, update: any): void {
		setPhysics2DEffector(this.props.object.getScene(), { id: effector.id, ...update }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setPhysics2DEffectorNumber(effector: any, property: "radius" | "force" | "falloff" | "forceAngle" | "surfaceThickness" | "platformAngle", value: string): void {
		const number = Number(value);
		if (
			Number.isFinite(number) &&
			(property === "force" || property === "forceAngle" || property === "platformAngle" || number >= 0) &&
			(!["radius", "surfaceThickness"].includes(property) || number > 0)
		) {
			this._setPhysics2DEffector(effector, { [property]: number });
		}
	}

	private _deletePhysics2DEffector(id: string): void {
		deletePhysics2DEffector(this.props.object.getScene(), { id }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _getMaterialInspectorComponent(material: Material): ReactNode {
		switch (material.getClassName()) {
			case "PBRMaterial":
				return <EditorPBRMaterialInspector mesh={this.props.object} material={this.props.object.material as PBRMaterial} editor={this.props.editor} />;

			case "StandardMaterial":
				return <EditorStandardMaterialInspector mesh={this.props.object} material={this.props.object.material as StandardMaterial} />;

			case "NodeMaterial":
				return <EditorNodeMaterialInspector mesh={this.props.object} material={this.props.object.material as NodeMaterial} />;

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
