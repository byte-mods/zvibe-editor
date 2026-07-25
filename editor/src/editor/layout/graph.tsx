import { basename, extname } from "path/posix";

import { Component, DragEvent, ReactNode } from "react";
import { Button, Tree, TreeNodeInfo } from "@blueprintjs/core";
import { toast } from "sonner";

import { FaLink } from "react-icons/fa6";
import { IoMdCube } from "react-icons/io";
import { AiOutlinePlus } from "react-icons/ai";
import { HiSpeakerWave } from "react-icons/hi2";
import { SiBabylondotjs } from "react-icons/si";
import { MdOutlineQuestionMark } from "react-icons/md";
import { GiBrickWall, GiSparkles } from "react-icons/gi";
import { HiOutlineCubeTransparent } from "react-icons/hi";
import { IoCheckmark, IoSparklesSharp } from "react-icons/io5";
import { TbGhost2Filled, TbServerSpark, TbBrandAdobeIndesign } from "react-icons/tb";
import { FaCamera, FaImage, FaLightbulb, FaBone, FaRegLightbulb } from "react-icons/fa";

import { AdvancedDynamicTexture } from "babylonjs-gui";
import { BaseTexture, Node, Scene, Tools, IParticleSystem, Sprite, Skeleton, TransformNode, AbstractMesh, Light } from "babylonjs";

import { Editor } from "../main";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/shadcn/ui/dropdown-menu";
import {
	ContextMenu,
	ContextMenuItem,
	ContextMenuContent,
	ContextMenuTrigger,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "../../ui/shadcn/ui/context-menu";

import { cloneNode } from "../../tools/node/clone";
import { isSoundNode } from "../../tools/guards/sound";
import { clearUndoRedo, registerUndoRedo } from "../../tools/undoredo";
import { isDomTextInputFocused } from "../../tools/dom";
import { isSceneLinkNode } from "../../tools/guards/scene";
import { updateAllLights } from "../../tools/light/shadows";
import { isClusteredLight } from "../../tools/light/cluster";
import { getCollisionMeshFor } from "../../tools/mesh/collision";
import { isNodeVisibleInGraph } from "../../tools/node/metadata";
import { isAdvancedDynamicTexture } from "../../tools/guards/texture";
import { updateIblShadowsRenderPipeline } from "../../tools/light/ibl";
import { UniqueNumber, waitNextAnimationFrame } from "../../tools/tools";
import { getSpriteManagerNodeFromSprite } from "../../tools/sprite/tools";
import { isParticleSystemVisibleInGraph } from "../../tools/particles/metadata";
import { applyTransformNodeParentingConfiguration } from "../../tools/node/parenting";
import { isSprite, isSpriteManagerNode, isSpriteMapNode } from "../../tools/guards/sprites";
import { parsePhysicsAggregate, serializePhysicsAggregate } from "../../tools/physics/serialization/aggregate";
import { isAnyParticleSystem, isGPUParticleSystem, isNodeParticleSystemSetMesh, isParticleSystem } from "../../tools/guards/particles";
import {
	isAbstractMesh,
	isAnyTransformNode,
	isCamera,
	isClusteredLightContainer,
	isCollisionInstancedMesh,
	isCollisionMesh,
	isEditorCamera,
	isInstancedMesh,
	isLight,
	isMesh,
	isNode,
	isTransformNode,
} from "../../tools/guards/nodes";
import {
	onNodeModifiedObservable,
	onNodesAddedObservable,
	onParticleSystemAddedObservable,
	onParticleSystemModifiedObservable,
	onSkeletonModifiedObservable,
	onSpriteModifiedObservable,
	onTextureModifiedObservable,
} from "../../tools/observables";

import { getNodeCommands } from "../dialogs/command-palette/node";
import { getMeshCommands } from "../dialogs/command-palette/mesh";
import { getLightCommands } from "../dialogs/command-palette/light";
import { getCameraCommands } from "../dialogs/command-palette/camera";
import { getSpriteCommands } from "../dialogs/command-palette/sprite";

import { addSoundNode } from "../../project/add/sound";
import { onProjectConfigurationChangedObservable } from "../../project/configuration";
import { IEditorLoadedSceneState } from "../../project/scene-workspace-runtime";
import { getAuthoringSceneRootNodes, getEffectiveHierarchyOwner, getSceneScopedHierarchyId } from "../../project/scene-hierarchy";
import { revertWorkspaceScene, saveWorkspaceScene, setActiveWorkspaceScene, setLightingWorkspaceScene, unloadWorkspaceScene } from "../../project/scene-workspace-actions";
import { showConfirm } from "../../ui/dialog";

import { applySoundAsset } from "./preview/import/sound";

import { EditorGraphLabel } from "./graph/label";
import { EditorGraphContextMenu } from "./graph/context-menu";
import { moveGraphSelectedNodesToScene, setNewParentForGraphSelectedNodes } from "./graph/move";

export interface IEditorGraphProps {
	/**
	 * The editor reference.
	 */
	editor: Editor;
}

export interface IEditorGraphState {
	/**
	 * Defines the current value of the search in the graph.
	 */
	search: string;
	/**
	 * The nodes of the graph.
	 */
	nodes: TreeNodeInfo[];

	/**
	 * Defines wether or not the preview is focused.
	 */
	isFocused: boolean;

	/**
	 * Defines wether or not only lights should be shown in the graph.
	 */
	showOnlyLights: boolean;
	/**
	 * Defines wether or not only decals should be shown in the graph.
	 */
	showOnlyDecals: boolean;

	/**
	 * Defines wether or not instanced meshes should be hidden from the graph.
	 */
	hideInstancedMeshes: boolean;
}

interface IAuthoringSceneTreeNodeInfo extends TreeNodeInfo {
	authoringScenePath: string;
}

export class EditorGraph extends Component<IEditorGraphProps, IEditorGraphState> {
	public _nodeToCopyTransform: Node | null = null;
	public _objectsToCopy: TreeNodeInfo<unknown>[] = [];
	private _sceneWorkspaceCleanup: (() => void) | null = null;

	public constructor(props: IEditorGraphProps) {
		super(props);

		this.state = {
			nodes: [],
			search: "",
			isFocused: false,

			showOnlyLights: false,
			showOnlyDecals: false,

			hideInstancedMeshes: false,
		};

		onNodesAddedObservable.add(() => this.refresh());
		onParticleSystemAddedObservable.add(() => this.refresh());

		onNodeModifiedObservable.add((node) => this._handleObjectModified(node));
		onSpriteModifiedObservable.add((node) => this._handleObjectModified(node));
		onTextureModifiedObservable.add((texture) => this._handleObjectModified(texture));
		onSkeletonModifiedObservable.add((skeleton) => this._handleObjectModified(skeleton));
		onParticleSystemModifiedObservable.add((particleSystem) => this._handleObjectModified(particleSystem));

		document.addEventListener("copy", () => !isDomTextInputFocused() && this.copySelectedNodes());
		document.addEventListener("paste", () => !isDomTextInputFocused() && this.pasteSelectedNodes());
	}

	public render(): ReactNode {
		return (
			<div
				className="flex flex-col w-full h-full text-foreground"
				onClick={() => this.setState({ isFocused: true })}
				onMouseLeave={() => this.setState({ isFocused: false })}
			>
				<div className="flex justify-between gap-2 w-full p-2">
					<input
						type="text"
						placeholder="Search..."
						value={this.state.search}
						onChange={(ev) => this._handleSearch(ev.currentTarget.value)}
						className="px-5 py-2 w-full rounded-lg bg-input outline-none"
					/>

					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button minimal icon="settings" className="transition-all duration-300" />
						</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuItem
								className="flex gap-1 items-center"
								onClick={() => {
									this.setState({ hideInstancedMeshes: !this.state.hideInstancedMeshes }, () => this.refresh());
								}}
							>
								{this.state.hideInstancedMeshes ? <IoCheckmark /> : ""} Hide Instanced Meshes
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="flex gap-1 items-center"
								onClick={() => {
									this.setState({ showOnlyLights: !this.state.showOnlyLights }, () => this.refresh());
								}}
							>
								{this.state.showOnlyLights ? <IoCheckmark /> : ""} Show Only Lights
							</DropdownMenuItem>
							<DropdownMenuItem
								className="flex gap-1 items-center"
								onClick={() => {
									this.setState({ showOnlyDecals: !this.state.showOnlyDecals }, () => this.refresh());
								}}
							>
								{this.state.showOnlyDecals ? <IoCheckmark /> : ""} Show Only Decals
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>

				<Tree
					contents={this.state.nodes}
					onNodeExpand={(n) => this._handleNodeExpanded(n)}
					onNodeCollapse={(n) => this._handleNodeCollapsed(n)}
					onNodeClick={(n, _, ev) => this._handleNodeClicked(n, ev)}
					onNodeContextMenu={(n, _, ev) => this._handleNodeContextMenu(n, ev)}
					onNodeDoubleClick={(n, _, ev) => this._handleNodeDoubleClicked(n, ev)}
				/>

				<div className="w-full h-full min-h-20" onDragOver={(ev) => ev.preventDefault()} onDrop={(ev) => this._handleDropEmpty(ev)}>
					<ContextMenu>
						<ContextMenuTrigger className="w-full h-full">
							<div className="w-full h-full"></div>
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuSub>
								<ContextMenuSubTrigger className="flex items-center gap-2">
									<AiOutlinePlus className="w-5 h-5" /> Add
								</ContextMenuSubTrigger>
								<ContextMenuSubContent>
									{getLightCommands(this.props.editor).map((command) => {
										return (
											<ContextMenuItem key={command.key} disabled={command.disabled} onClick={command.action}>
												{command.text}
											</ContextMenuItem>
										);
									})}
									<ContextMenuSeparator />
									{getNodeCommands(this.props.editor).map((command) => {
										return (
											<ContextMenuItem key={command.key} disabled={command.disabled} onClick={command.action}>
												{command.text}
											</ContextMenuItem>
										);
									})}
									<ContextMenuSeparator />
									<ContextMenuSub>
										<ContextMenuSubTrigger className="flex items-center gap-2">
											<IoMdCube className="w-5 h-5" /> Meshes
										</ContextMenuSubTrigger>
										<ContextMenuSubContent>
											{getMeshCommands(this.props.editor).map((command) => {
												return (
													<ContextMenuItem key={command.key} disabled={command.disabled} onClick={command.action}>
														{command.text}
													</ContextMenuItem>
												);
											})}
										</ContextMenuSubContent>
									</ContextMenuSub>
									<ContextMenuSeparator />
									{getCameraCommands(this.props.editor).map((command) => {
										return (
											<ContextMenuItem key={command.key} disabled={command.disabled} onClick={command.action}>
												{command.text}
											</ContextMenuItem>
										);
									})}
									<ContextMenuSeparator />
									<ContextMenuItem onClick={() => addSoundNode(this.props.editor)}>Sound Node</ContextMenuItem>
									<ContextMenuSeparator />
									{getSpriteCommands(this.props.editor).map((command) => {
										return (
											<ContextMenuItem key={command.key} disabled={command.disabled} onClick={command.action}>
												{command.text}
											</ContextMenuItem>
										);
									})}
								</ContextMenuSubContent>
							</ContextMenuSub>
						</ContextMenuContent>
					</ContextMenu>
				</div>
			</div>
		);
	}

	public componentDidMount(): void {
		onProjectConfigurationChangedObservable.add(() => {
			this.refresh();
		});
		this._sceneWorkspaceCleanup = this.props.editor.sceneWorkspace.subscribe(() => void this.refresh());
	}

	public componentWillUnmount(): void {
		this._sceneWorkspaceCleanup?.();
		this._sceneWorkspaceCleanup = null;
	}

	/**
	 * Refreshes the graph.
	 */
	public refresh(): Promise<void> {
		const scene = this.props.editor.layout.preview.scene;
		const clusteredLightContainer = this.props.editor.layout.preview.clusteredLightContainer;
		const sceneStates = this.props.editor.sceneWorkspace.getLoadedSceneStates();
		const nodes = sceneStates.length
			? sceneStates.map((state) => this._parseAuthoringSceneRoot(scene, state, clusteredLightContainer.lights))
			: [this._parseLegacySceneRoot(scene, clusteredLightContainer.lights)];

		this.setState({
			nodes,
		});

		return waitNextAnimationFrame();
	}

	/**
	 * Sets the given node selected in the graph. All other selected nodes
	 * become unselected to have only the given node selected. All parents are expanded.
	 * @param node defines the reference tot the node to select in the graph.
	 */
	public setSelectedNode(node: Node | IParticleSystem | Sprite): void {
		const originalSource = (isAnyParticleSystem(node) ? (node.emitter as AbstractMesh) : node) as Node | null;

		let source = originalSource;
		if (!source) {
			return;
		}

		if (isSprite(source)) {
			source = getSpriteManagerNodeFromSprite(source);
		}

		const idsToExpand: string[] = [];
		const isLegacyHierarchy = this.props.editor.sceneWorkspace.getLoadedSceneStates().length === 0;

		const owner = getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, source);
		if (isLegacyHierarchy) {
			idsToExpand.push("__editor__scene__");
		} else if (owner) {
			idsToExpand.push(this._getAuthoringSceneRootId(owner));
		}

		while (source) {
			if (!isLegacyHierarchy && getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, source) !== owner) {
				break;
			}
			idsToExpand.push(isLegacyHierarchy ? `legacy::${source.id}` : getSceneScopedHierarchyId(this.props.editor.sceneWorkspace, source, source.id));
			source = source.parent;
		}

		if (isLight(originalSource) && this.props.editor.layout.preview.clusteredLightContainer.lights.includes(originalSource)) {
			if (isLegacyHierarchy) {
				idsToExpand.push("__editor__scene__");
			} else if (owner) {
				idsToExpand.push(this._getAuthoringSceneRootId(owner));
			}
		}

		this._forEachNode(this.state.nodes, (n) => {
			if (typeof n.id === "string" && idsToExpand.includes(n.id)) {
				n.isExpanded = true;
			}

			n.isSelected = n.nodeData === node;
		});

		this.setState({
			nodes: this.state.nodes,
		});
	}

	/**
	 * Returns whether or not the given node is selected in the graph.
	 * @param nodeData defines the reference to the node data to check.
	 */
	public isNodeSelected(nodeData: any): boolean {
		return this.getSelectedNodes().find((n) => n.nodeData === nodeData) !== undefined;
	}

	/**
	 * Sets the given node selected in the graph. All other selected nodes remain selected.
	 * @param node defines the reference to the node to select in the graph.
	 */
	public addToSelectedNodes(node: Node | IParticleSystem | Sprite): void {
		this._forEachNode(this.state.nodes, (n) => {
			if (n.nodeData === node) {
				n.isSelected = true;
			}
		});

		this.setState({
			nodes: this.state.nodes,
		});
	}

	/**
	 * Returns the list of all selected nodes
	 */
	public getSelectedNodes(): TreeNodeInfo<unknown>[] {
		const result: any[] = [];
		this._forEachNode(this.state.nodes, (n) => n.isSelected && result.push(n));
		return result;
	}

	/**
	 * Copies the selected nodes from the graph.
	 */
	public copySelectedNodes(): void {
		this._objectsToCopy = this.props.editor.layout.graph.getSelectedNodes();
		this.refresh();
	}

	/**
	 * Pastes the previously copied nodes.
	 */
	public pasteSelectedNodes(parent?: Node, shift?: boolean): void {
		if (!this._objectsToCopy.length) {
			return;
		}

		const newNodes: (Node | IParticleSystem | Sprite)[] = [];
		const nodesToCopy = this._objectsToCopy.map((n) => n.nodeData);

		registerUndoRedo({
			executeRedo: true,
			action: () => {
				this.refresh();

				waitNextAnimationFrame().then(() => {
					const firstNode = newNodes[0] ?? null;
					if (firstNode) {
						this.props.editor.layout.graph.setSelectedNode(firstNode);

						if (isNode(firstNode) || isSprite(firstNode)) {
							this.props.editor.layout.preview.gizmo.setAttachedObject(firstNode);
						}
					}

					this.props.editor.layout.inspector.setEditedObject(firstNode);
					this.props.editor.layout.animations.setEditedObject(firstNode);
				});
			},
			undo: () => {
				newNodes.forEach((node) => {
					node.dispose(false, false);
				});
				newNodes.splice(0, newNodes.length);
			},
			redo: () => {
				const tempTransfromNode = new TransformNode("tempParent", this.props.editor.layout.preview.scene);

				try {
					nodesToCopy.forEach((object) => {
						let node: Node | IParticleSystem | Sprite | null = null;

						if (isAbstractMesh(object) && !isNodeParticleSystemSetMesh(object)) {
							const suffix = "(Instanced Mesh)";
							const name = isInstancedMesh(object) ? object.name : `${object.name.replace(` ${suffix}`, "")} ${suffix}`;

							const instance = (node = object.createInstance(name));
							instance.isPickable = object.isPickable;
							instance.position.copyFrom(object.position);
							instance.rotation.copyFrom(object.rotation);
							instance.scaling.copyFrom(object.scaling);
							instance.rotationQuaternion = object.rotationQuaternion?.clone() ?? null;
							instance.parent = object.parent;

							if (object.physicsAggregate) {
								instance.physicsAggregate = parsePhysicsAggregate(instance, serializePhysicsAggregate(object.physicsAggregate));
								instance.physicsAggregate.body.disableSync = true;
							}

							const collisionMesh = getCollisionMeshFor(instance.sourceMesh);
							collisionMesh?.updateInstances(instance.sourceMesh);
						} else if (isParticleSystem(object) && isAbstractMesh(parent)) {
							const suffix = "(Clone)";
							const name = `${object.name.replace(` ${suffix}`, "")} ${suffix}`;

							node = object.clone(name, parent, false);
						} else if (isNode(object) || isSprite(object)) {
							node = cloneNode(this.props.editor, object);
						}

						if (node) {
							if (!isSprite(node)) {
								node.id = Tools.RandomId();
							}

							node.uniqueId = UniqueNumber.Get();

							if (parent && isNode(node)) {
								if (shift && isNode(object)) {
									node.parent = object.parent;
									applyTransformNodeParentingConfiguration(node, parent, tempTransfromNode);
								} else {
									node.parent = parent;
								}
							}

							if (isAbstractMesh(node)) {
								this.props.editor.layout.preview.scene.lights
									.map((light) => light.getShadowGenerator())
									.forEach((generator) => generator?.getShadowMap()?.renderList?.push(node));
							}

							newNodes.push(node);
						}
					});
				} catch (e) {
					console.error(e);
				}

				tempTransfromNode.dispose(false, true);
			},
		});
	}

	public copySelectedNodeTransform(node: Node): void {
		this._nodeToCopyTransform = node;
		this.refresh();
	}

	public pasteSelectedNodeTransform(node: Node): void {
		if (!this._nodeToCopyTransform) {
			return;
		}

		const sourcePosition = (this._nodeToCopyTransform as any)["position"];
		const sourceRotation = (this._nodeToCopyTransform as any)["rotation"];
		const sourceScaling = (this._nodeToCopyTransform as any)["scaling"];
		const sourceRotationQuaternion = (this._nodeToCopyTransform as any)["rotationQuaternion"];
		const sourceDirection = (this._nodeToCopyTransform as any)["direction"];

		const targetPosition = (node as any)["position"];
		const targetRotation = (node as any)["rotation"];
		const targetScaling = (node as any)["scaling"];
		const targetRotationQuaternion = (node as any)["rotationQuaternion"];
		const targetDirection = (node as any)["direction"];

		const savedTargetPosition = targetPosition?.clone();
		const savedTargetRotation = targetRotation?.clone();
		const savedTargetScaling = targetScaling?.clone();
		const savedTargetRotationQuaternion = targetRotationQuaternion?.clone();
		const savedTargetDirection = targetDirection?.clone();

		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				if (savedTargetPosition && targetPosition) {
					targetPosition.copyFrom(savedTargetPosition);
				}

				if (savedTargetRotation && targetRotation) {
					targetRotation.copyFrom(savedTargetRotation);
				}

				if (savedTargetScaling && targetScaling) {
					targetScaling.copyFrom(savedTargetScaling);
				}

				if (targetRotationQuaternion) {
					if (!savedTargetRotationQuaternion) {
						(node as any)["rotationQuaternion"] = null;
					} else {
						targetRotationQuaternion.copyFrom(savedTargetRotationQuaternion);
					}
				}

				if (savedTargetDirection && targetDirection) {
					targetDirection.copyFrom(savedTargetDirection);
				}
			},
			redo: () => {
				if (sourcePosition && targetPosition) {
					targetPosition.copyFrom(sourcePosition);
				}

				if (sourceRotation && targetRotation) {
					targetRotation.copyFrom(sourceRotation);
				}

				if (sourceScaling && targetScaling) {
					targetScaling.copyFrom(sourceScaling);
				}

				if (sourceRotationQuaternion) {
					if (targetRotationQuaternion) {
						targetRotationQuaternion.copyFrom(sourceRotationQuaternion);
					} else {
						(node as any)["rotationQuaternion"] = sourceRotationQuaternion.clone();
					}
				}

				if (sourceDirection && targetDirection) {
					targetDirection.copyFrom(sourceDirection);
				}
			},
		});

		this.props.editor.layout.inspector.forceUpdate();
	}

	private _handleSearch(search: string): void {
		this.setState({ search }, () => {
			this.refresh();
		});
	}

	private _handleNodeClicked(node: TreeNodeInfo, ev: React.MouseEvent<HTMLElement>): void {
		this.props.editor.layout.inspector.setEditedObject(node.nodeData);
		this.props.editor.layout.animations.setEditedObject(node.nodeData);

		if (isNode(node.nodeData) || isSprite(node.nodeData)) {
			this.props.editor.layout.preview.gizmo.setAttachedObject(node.nodeData);
		}

		if (isCamera(node.nodeData)) {
			this.props.editor.layout.preview.setCameraPreviewActive(node.nodeData);
		}

		if (ev.ctrlKey || ev.metaKey) {
			this._forEachNode(this.state.nodes, (n) => n.id === node.id && (n.isSelected = !n.isSelected));
		} else if (ev.shiftKey) {
			this._handleShiftSelect(node);
		} else {
			this._forEachNode(this.state.nodes, (n) => (n.isSelected = n.id === node.id));
		}

		this.setState({ nodes: this.state.nodes });
	}

	private _handleShiftSelect(node: TreeNodeInfo): void {
		let lastSelected!: TreeNodeInfo;
		let firstSelected!: TreeNodeInfo;

		this._forEachNode(this.state.nodes, (n) => {
			if (n.id === node.id) {
				if (!firstSelected) {
					firstSelected = n;
				} else {
					lastSelected = n;
				}
			} else if (n.isSelected) {
				if (!firstSelected) {
					firstSelected = n;
				} else {
					lastSelected = n;
				}
			}
		});

		if (!lastSelected || !firstSelected) {
			return;
		}

		let select = false;
		this._forEachNode(this.state.nodes, (n) => {
			if (n.id === firstSelected.id) {
				select = true;
			}

			if (select) {
				n.isSelected = true;
			}

			if (n.id === lastSelected.id) {
				select = false;
			}
		});
	}

	private _handleNodeContextMenu(node: TreeNodeInfo, ev: React.MouseEvent<HTMLElement>): void {
		if (!node.isSelected) {
			this._handleNodeClicked(node, ev);
		}
	}

	private _handleNodeExpanded(node: TreeNodeInfo): void {
		this._forEachNode(this.state.nodes, (n) => n.id === node.id && (n.isExpanded = true));
		this.setState({ nodes: this.state.nodes });
	}

	private _handleNodeCollapsed(node: TreeNodeInfo): void {
		this._forEachNode(this.state.nodes, (n) => n.id === node.id && (n.isExpanded = false));
		this.setState({ nodes: this.state.nodes });
	}

	private _handleNodeDoubleClicked(node: TreeNodeInfo, ev: React.MouseEvent<HTMLElement>): void {
		this._forEachNode(this.state.nodes, (n) => n.id === node.id && (n.isExpanded = !n.isExpanded));

		this._handleNodeClicked(node, ev);
		this.setState({ nodes: this.state.nodes });
	}

	public _forEachNode(nodes: TreeNodeInfo[] | undefined, callback: (node: TreeNodeInfo, index: number) => void): void {
		if (nodes === undefined) {
			return;
		}

		for (let i = 0, len = nodes.length; i < len; ++i) {
			const node = nodes[i];

			callback(node, i);
			this._forEachNode(node.childNodes, callback);
		}
	}

	private _parseAuthoringSceneRoot(scene: Scene, state: IEditorLoadedSceneState, clusteredLights: readonly Light[]): IAuthoringSceneTreeNodeInfo {
		const scenePath = state.path;
		let childNodes: TreeNodeInfo[] = [];

		if (this.state.showOnlyLights) {
			childNodes.push(
				...[...scene.lights, ...clusteredLights]
					.filter((light) => getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, light) === scenePath)
					.map((light) => this._parseSceneNode(light, scenePath, true))
					.filter((node) => node !== null)
			);
		}

		if (this.state.showOnlyDecals) {
			childNodes.push(
				...scene.meshes
					.filter((mesh) => mesh.metadata?.decal && getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, mesh) === scenePath)
					.map((mesh) => this._parseSceneNode(mesh, scenePath, true))
					.filter((node) => node !== null)
			);
		}

		if (!this.state.showOnlyLights && !this.state.showOnlyDecals) {
			const rootNodes = getAuthoringSceneRootNodes(scene, this.props.editor.sceneWorkspace, scenePath)
				.filter((node) => !isClusteredLightContainer(node))
				.map((node) => this._parseSceneNode(node, scenePath))
				.filter((node) => node !== null) as TreeNodeInfo[];
			const directClusteredLights = clusteredLights
				.filter((light) => getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, light) === scenePath)
				.map((light) => this._parseSceneNode(light, scenePath))
				.filter((node) => node !== null) as TreeNodeInfo[];
			childNodes.push(...rootNodes, ...directClusteredLights);

			const guiNode = this._parseGuiNode(scene, scenePath);
			if (guiNode) {
				childNodes.splice(0, 0, guiNode);
			}

			const skeletonNode = this._parseSkeletonNode(scene, scenePath);
			if (skeletonNode) {
				childNodes.splice(0, 0, skeletonNode);
			}
		}

		const rootId = this._getAuthoringSceneRootId(scenePath);
		const rootNode = {
			id: rootId,
			nodeData: scene,
			authoringScenePath: scenePath,
			childNodes: childNodes.length ? childNodes : undefined,
			hasCaret: childNodes.length > 0,
			icon: <SiBabylondotjs className="w-4 h-4" />,
			label: this._getAuthoringSceneLabel(state),
		} as IAuthoringSceneTreeNodeInfo;

		this._restoreTreeNodeState(rootNode);
		return rootNode;
	}

	private _parseLegacySceneRoot(scene: Scene, clusteredLights: readonly Light[]): TreeNodeInfo {
		let childNodes: TreeNodeInfo[] = [];
		if (this.state.showOnlyLights) {
			childNodes.push(...[...scene.lights, ...clusteredLights].map((light) => this._parseSceneNode(light, "legacy", true)).filter((node) => node !== null));
		}
		if (this.state.showOnlyDecals) {
			childNodes.push(
				...scene.meshes
					.filter((mesh) => mesh.metadata?.decal)
					.map((mesh) => this._parseSceneNode(mesh, "legacy", true))
					.filter((node) => node !== null)
			);
		}
		if (!this.state.showOnlyLights && !this.state.showOnlyDecals) {
			childNodes = scene.rootNodes
				.filter((node) => !isEditorCamera(node))
				.map((node) => this._parseSceneNode(node, "legacy"))
				.filter((node) => node !== null) as TreeNodeInfo[];
		}

		const rootNode = {
			id: "__editor__scene__",
			nodeData: scene,
			childNodes: childNodes.length ? childNodes : undefined,
			hasCaret: childNodes.length > 0,
			icon: <SiBabylondotjs className="w-4 h-4" />,
			label: this._getNodeLabelComponent(scene, "Scene", false),
		} as TreeNodeInfo;
		this._restoreTreeNodeState(rootNode);
		return rootNode;
	}

	private _parseSkeletonNode(scene: Scene, scenePath: string): TreeNodeInfo | null {
		const skeletons = scene.skeletons.filter((skeleton) => getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, skeleton) === scenePath);
		if (!skeletons.length) {
			return null;
		}

		const childNodes: TreeNodeInfo[] = [];

		skeletons.forEach((skeleton) => {
			if (!(skeleton.name ?? "").toLowerCase().includes(this.state.search.toLowerCase())) {
				return;
			}

			childNodes.push(this._getSkeletonNode(skeleton, scenePath));
		});

		const rootSkeletonNode = {
			childNodes,
			nodeData: scene,
			id: `${scenePath}::__editor__skeletons__`,
			icon: <FaBone className="w-4 h-4" />,
			label: this._getNodeLabelComponent(scene, "Skeletons", false),
		} as TreeNodeInfo;

		this._restoreTreeNodeState(rootSkeletonNode);

		return rootSkeletonNode;
	}

	private _getSkeletonNode(skeleton: Skeleton, scenePath: string): TreeNodeInfo {
		const info = {
			nodeData: skeleton,
			id: `${scenePath}::${skeleton.id ?? `__editor__skeleton__${skeleton.uniqueId}`}`,
			icon: <FaBone className="w-4 h-4" />,
			label: this._getNodeLabelComponent(skeleton, skeleton.name, false),
		} as TreeNodeInfo;

		this._restoreTreeNodeState(info);

		return info;
	}

	private _getParticleSystemNode(particleSystem: IParticleSystem, scenePath: string): TreeNodeInfo {
		const info = {
			nodeData: particleSystem,
			id: `${scenePath}::${particleSystem.id}`,
			icon: this._getIcon(particleSystem),
			label: this._getNodeLabelComponent(particleSystem, particleSystem.name, false),
		} as TreeNodeInfo;

		this._restoreTreeNodeState(info);

		return info;
	}

	private _getSpriteNode(sprite: Sprite, scenePath: string): TreeNodeInfo {
		const info = {
			nodeData: sprite,
			id: `${scenePath}::${sprite.uniqueId}`,
			icon: this._getIcon(sprite),
			label: this._getNodeLabelComponent(sprite, sprite.name, false),
		} as TreeNodeInfo;

		this._restoreTreeNodeState(info);

		return info;
	}

	private _parseGuiNode(scene: Scene, scenePath: string): TreeNodeInfo | null {
		const guiTextures = scene.textures.filter(
			(texture) => texture.getClassName() === "AdvancedDynamicTexture" && getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, texture) === scenePath
		) as AdvancedDynamicTexture[];
		if (!guiTextures.length) {
			return null!;
		}

		const childNodes: TreeNodeInfo[] = [];

		guiTextures.forEach((texture) => {
			if (!(texture.name ?? "").toLowerCase().includes(this.state.search.toLowerCase())) {
				return;
			}

			const info = {
				nodeData: texture,
				id: `${scenePath}::${texture.uniqueId}`,
				icon: this._getAdvancedTextureIconComponent(texture),
				label: this._getNodeLabelComponent(texture, texture.name, false),
			} as TreeNodeInfo;

			this._restoreTreeNodeState(info);

			childNodes.push(info);
		});

		if (!childNodes.length) {
			return null;
		}

		const rootGuiNode = {
			childNodes,
			nodeData: scene,
			id: `${scenePath}::__editor__gui__`,
			icon: <TbBrandAdobeIndesign className="w-4 h-4" />,
			label: this._getNodeLabelComponent(scene, "Gui", false),
		} as TreeNodeInfo;

		this._restoreTreeNodeState(rootGuiNode);

		return rootGuiNode;
	}

	private _parseSceneNode(node: Node, scenePath: string, noChildren?: boolean): TreeNodeInfo | null {
		const isLegacyHierarchy = scenePath === "legacy";
		if ((isMesh(node) && (node._masterMesh || !isNodeVisibleInGraph(node))) || isCollisionMesh(node) || isCollisionInstancedMesh(node)) {
			return null;
		}

		// Check is in graph
		if (isInstancedMesh(node) && this.state.hideInstancedMeshes) {
			return null;
		}

		if (isAnyTransformNode(node) && !node._scene.transformNodes.includes(node)) {
			return null;
		}

		if (isAbstractMesh(node) && !node._scene.meshes.includes(node)) {
			return null;
		}

		if (isLight(node) && !node._scene.lights.includes(node) && !isClusteredLight(node, this.props.editor)) {
			return null;
		}

		if (isCamera(node) && !node._scene.cameras.includes(node)) {
			return null;
		}

		if (isClusteredLightContainer(node) && (this.state.showOnlyLights || this.state.showOnlyDecals)) {
			return null;
		}

		node.id ??= Tools.RandomId();

		const info = {
			id: `${scenePath}::${node.id}`,
			nodeData: node,
			isSelected: false,
			childNodes: [],
			hasCaret: false,
			icon: this._getNodeIconComponent(node),
			label: this._getNodeLabelComponent(node, node.name),
		} as TreeNodeInfo;

		if (!isSceneLinkNode(node) && !noChildren) {
			const children = node.getDescendants(true).filter((child) => isLegacyHierarchy || getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, child) === scenePath);

			if (children.length) {
				info.childNodes = children.map((child) => this._parseSceneNode(child, scenePath)).filter((child) => child !== null) as TreeNodeInfo[];
			}

			// Handle particle systems
			if (isAbstractMesh(node) && !noChildren) {
				const particleSystems = this.props.editor.layout.preview.scene.particleSystems.filter((particleSystem) => {
					return particleSystem.emitter === node && (isLegacyHierarchy || getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, particleSystem) === scenePath);
				});
				particleSystems.forEach((particleSystem) => {
					if (
						(isParticleSystem(particleSystem) || isGPUParticleSystem(particleSystem)) &&
						isParticleSystemVisibleInGraph(particleSystem) &&
						(particleSystem.name ?? "").toLowerCase().includes(this.state.search.toLowerCase())
					) {
						info.childNodes?.push(this._getParticleSystemNode(particleSystem, scenePath));
					}
				});
			}

			// Handle sprites
			if (isSpriteManagerNode(node) && !noChildren) {
				node.spriteManager?.sprites.forEach((sprite) => {
					info.childNodes?.push(this._getSpriteNode(sprite, scenePath));
				});
			}

			// Handle clustered lights
			if (isClusteredLightContainer(node) && !noChildren) {
				node.lights
					.filter((light) => isLegacyHierarchy || getEffectiveHierarchyOwner(this.props.editor.sceneWorkspace, light) === scenePath)
					.forEach((light) => {
						const clusteredLightNode = this._parseSceneNode(light, scenePath, false);
						if (clusteredLightNode) {
							info.childNodes?.push(clusteredLightNode);
						}
					});
			}

			if (info.childNodes?.length) {
				info.hasCaret = true;
			} else {
				info.childNodes = undefined;
			}
		}

		if (!(node.name ?? "").toLowerCase().includes(this.state.search.toLowerCase()) && !info.childNodes?.length) {
			return null;
		}

		this._restoreTreeNodeState(info);

		return info;
	}

	private _getAuthoringSceneRootId(scenePath: string): string {
		return `__editor__scene__::${scenePath}`;
	}

	private _getAuthoringSceneLabel(state: IEditorLoadedSceneState): JSX.Element {
		const fileName = basename(state.path);
		const label = (
			<div
				className="flex min-w-0 items-center gap-1.5"
				title={`${state.path}\nDrop scene-root objects here to move them into this scene.`}
				onDragOver={(event) => {
					if (event.dataTransfer.types.includes("graph/node")) {
						event.preventDefault();
						event.stopPropagation();
					}
				}}
				onDrop={(event) => {
					event.preventDefault();
					event.stopPropagation();
					if (event.dataTransfer.getData("graph/node")) {
						try {
							moveGraphSelectedNodesToScene(this.props.editor, state.path);
						} catch (error) {
							toast.error(error instanceof Error ? error.message : String(error));
						}
					}
				}}
			>
				<span className="truncate">{fileName}</span>
				{state.isActive && <span className="rounded bg-blue-600/30 px-1 text-[10px] text-blue-200">Active</span>}
				{state.isLighting && <span className="rounded bg-amber-600/30 px-1 text-[10px] text-amber-200">Lighting</span>}
				{state.isDirty && (
					<span className="text-amber-300" title="Unsaved changes">
						●
					</span>
				)}
			</div>
		);

		return (
			<ContextMenu>
				<ContextMenuTrigger>{label}</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem disabled={state.isActive} onClick={() => void this._executeSceneRootAction("active", state)}>
						Set Active Scene
					</ContextMenuItem>
					<ContextMenuItem disabled={state.isLighting} onClick={() => void this._executeSceneRootAction("lighting", state)}>
						Set Lighting Scene
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem onClick={() => void this._executeSceneRootAction("save", state)}>Save Scene</ContextMenuItem>
					<ContextMenuItem onClick={() => void this._executeSceneRootAction("revert", state)}>Revert Scene</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						disabled={this.props.editor.sceneWorkspace.getLoadedSceneStates().length === 1}
						onClick={() => void this._executeSceneRootAction("unload", state)}
					>
						Unload Scene
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		);
	}

	private async _executeSceneRootAction(action: "active" | "lighting" | "save" | "revert" | "unload", state: IEditorLoadedSceneState): Promise<void> {
		try {
			if ((action === "revert" || action === "unload") && state.isDirty) {
				const confirmed = await showConfirm(
					action === "revert" ? "Discard Scene Changes?" : "Unload Unsaved Scene?",
					action === "revert" ? `Reload "${state.path}" from disk and discard its unsaved changes?` : `Unload "${state.path}" and discard its unsaved changes?`,
					{ confirmText: action === "revert" ? "Revert" : "Unload" }
				);
				if (!confirmed) {
					return;
				}
			}

			switch (action) {
				case "active":
					await setActiveWorkspaceScene(this.props.editor, state.path);
					break;
				case "lighting":
					await setLightingWorkspaceScene(this.props.editor, state.path);
					break;
				case "save":
					await saveWorkspaceScene(this.props.editor, state.path);
					break;
				case "revert":
					clearUndoRedo();
					await revertWorkspaceScene(this.props.editor, state.path);
					break;
				case "unload":
					clearUndoRedo();
					await unloadWorkspaceScene(this.props.editor, state.path);
					this.props.editor.layout.inspector.setEditedObject(this.props.editor.layout.preview.scene);
					this.props.editor.layout.animations.setEditedObject(this.props.editor.layout.preview.scene);
					break;
			}
			const message = {
				active: "activated",
				lighting: "selected for lighting",
				save: "saved",
				revert: "reverted",
				unload: "unloaded",
			}[action];
			toast.success(`Scene "${state.path}" ${message}.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _restoreTreeNodeState(node: TreeNodeInfo): void {
		this._forEachNode(this.state.nodes, (previousNode) => {
			if (previousNode.id === node.id) {
				node.isSelected = previousNode.isSelected;
				node.isExpanded = previousNode.isExpanded;
			}
		});
	}

	private _getNodeIconComponent(node: Node): ReactNode {
		return (
			<div
				onClick={(ev) => {
					const enabled = !node.isEnabled();

					let selectedNodeData = this.getSelectedNodes().map((n) => n.nodeData);
					if (!selectedNodeData.includes(node)) {
						selectedNodeData = [node];
					}

					selectedNodeData.forEach((node) => {
						if (isNode(node) || isClusteredLightContainer(node)) {
							node.setEnabled(enabled);
						}
					});

					this.refresh();
					ev.stopPropagation();

					updateAllLights(this.props.editor.layout.preview.scene);
					updateIblShadowsRenderPipeline(this.props.editor.layout.preview.scene);
				}}
				className={`cursor-pointer ${node.isEnabled() ? "opacity-100" : "opacity-20"} transition-all duration-100 ease-in-out`}
			>
				{this._getIcon(node)}
			</div>
		);
	}

	private _getAdvancedTextureIconComponent(texture: AdvancedDynamicTexture): ReactNode {
		const layer = this.props.editor.layout.preview.scene.layers.find((l) => l.texture === texture);
		if (!layer) {
			return null;
		}

		return (
			<div
				onClick={(ev) => {
					layer.isEnabled = !layer.isEnabled;
					this.refresh();
					ev.stopPropagation();
				}}
				className={`cursor-pointer ${layer?.isEnabled ? "opacity-100" : "opacity-20"} transition-all duration-100 ease-in-out`}
			>
				{this._getIcon(texture)}
			</div>
		);
	}

	private _getIcon(object: any): ReactNode {
		if (isTransformNode(object)) {
			return <HiOutlineCubeTransparent className="w-4 h-4" />;
		}

		if (isNodeParticleSystemSetMesh(object)) {
			return <TbServerSpark className="w-4 h-4" />;
		}

		if (isAbstractMesh(object)) {
			return <IoMdCube className="w-4 h-4" />;
		}

		if (isLight(object)) {
			return <FaLightbulb className="w-4 h-4" />;
		}

		if (isClusteredLightContainer(object)) {
			return <FaRegLightbulb className="w-4 h-4" />;
		}

		if (isCamera(object)) {
			return <FaCamera className="w-4 h-4" />;
		}

		if (isSceneLinkNode(object)) {
			return <FaLink className="w-4 h-4" />;
		}

		if (isAdvancedDynamicTexture(object)) {
			return <TbBrandAdobeIndesign className="w-4 h-4" />;
		}

		if (isSoundNode(object)) {
			return <HiSpeakerWave className="w-4 h-4" />;
		}

		if (isParticleSystem(object)) {
			return <IoSparklesSharp className="w-4 h-4" />;
		}

		if (isGPUParticleSystem(object)) {
			return <GiSparkles className="w-4 h-4" />;
		}

		if (isSprite(object)) {
			return <FaImage className="w-4 h-4" />;
		}

		if (isSpriteMapNode(object)) {
			return <GiBrickWall className="w-4 h-4" />;
		}

		if (isSpriteManagerNode(object)) {
			return <TbGhost2Filled className="w-4 h-4" />;
		}

		return <MdOutlineQuestionMark className="w-4 h-4" />;
	}

	private _getNodeLabelComponent(object: any, name?: string | null, noContextMenu?: boolean): JSX.Element {
		const label = <EditorGraphLabel object={object} editor={this.props.editor} name={name ?? "Unnamed Node"} />;

		if (noContextMenu) {
			return label;
		}

		return (
			<EditorGraphContextMenu editor={this.props.editor} object={object}>
				{label}
			</EditorGraphContextMenu>
		);
	}

	private _handleObjectModified(node: Node | BaseTexture | IParticleSystem | Sprite | Skeleton): void {
		this._forEachNode(this.state.nodes, (n) => {
			if (n.nodeData === node) {
				n.label = this._getNodeLabelComponent(node, node.name);
			}
		});

		this.setState({ nodes: this.state.nodes });
	}

	private _handleDropEmpty(ev: DragEvent<HTMLDivElement>): void {
		const node = ev.dataTransfer.getData("graph/node");
		if (node) {
			setNewParentForGraphSelectedNodes(this.props.editor, this.props.editor.layout.preview.scene, ev.shiftKey);
		}

		const asset = ev.dataTransfer.getData("assets");
		if (asset) {
			const absolutePaths = this.props.editor.layout.assets.state.selectedKeys;

			absolutePaths.forEach((absolutePath) => {
				const extension = extname(absolutePath).toLowerCase();

				switch (extension) {
					case ".mp3":
					case ".ogg":
					case ".wav":
					case ".wave":
						applySoundAsset(this.props.editor, this.props.editor.layout.preview.scene, absolutePath).then(() => {
							this.props.editor.layout.graph.refresh();
						});
						break;
				}
			});
		}
	}
}
