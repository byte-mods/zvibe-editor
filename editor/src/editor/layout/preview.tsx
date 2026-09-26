import { ipcRenderer } from "electron";
import { extname, basename, join } from "path/posix";

import { toast } from "sonner";
import { Component, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { Grid } from "react-loader-spinner";

import { FaCheck } from "react-icons/fa6";
import { IoIosStats } from "react-icons/io";
import { LuEraser, LuMove3D, LuPaintbrush, LuRotate3D, LuScale3D } from "react-icons/lu";
import { GiArrowCursor, GiTeapot, GiWireframeGlobe } from "react-icons/gi";

import {
	AbstractEngine,
	AbstractMesh,
	Animation,
	Camera,
	CubicEase,
	EasingFunction,
	Engine,
	GizmoCoordinatesMode,
	ISceneLoaderAsyncResult,
	Node,
	Scene,
	Vector2,
	Vector3,
	WebGPUEngine,
	PickingInfo,
	SceneLoaderFlags,
	EngineView,
	Sprite,
	Color3,
	Color4,
	BoundingBox,
	SelectionOutlineLayer,
	ClusteredLightContainer,
	Tools,
	_GetAudioEngine,
	LinesMesh,
	Matrix,
	Mesh,
	MeshBuilder,
	Plane,
	StandardMaterial,
} from "babylonjs";
import { getSpriteMapTileGridConfiguration, getTileGridCellPolygon, ISpriteShapeDefinition, restoreCameraStackBaseline } from "babylonjs-editor-tools";

import { SpinnerUIComponent } from "../../ui/spinner";

import { Button } from "../../ui/shadcn/ui/button";
import { Toggle } from "../../ui/shadcn/ui/toggle";
import { Progress } from "../../ui/shadcn/ui/progress";
import { Separator } from "../../ui/shadcn/ui/separator";
import { ToolbarRadioGroup, ToolbarRadioGroupItem } from "../../ui/shadcn/ui/toolbar-radio-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/shadcn/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/shadcn/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/shadcn/ui/dropdown-menu";

import { Editor } from "../main";

import { isVector3 } from "../../tools/guards/math";
import { toNormalizedTouchPosition } from "../../tools/input/touch";
import { isDomTextInputFocused } from "../../tools/dom";
import { isNodeLocked, setNodeSerializable, setNodeVisibleInGraph } from "../../tools/node/metadata";
import { registerUndoRedo } from "../../tools/undoredo";
import { enableEditorPhysics, initializeHavok } from "../../tools/physics/init";
import { initializeRecast } from "../../tools/recast/init";
import { isAnyParticleSystem } from "../../tools/guards/particles";
import { saveSceneScreenshot } from "../../tools/scene/screenshot";
import { onTextureAddedObservable } from "../../tools/observables";
import { getCameraFocusPositionFor } from "../../tools/camera/focus";
import { ITweenConfiguration, Tween } from "../../tools/animation/tween";
import { checkProjectCachedCompressedTextures, initializeKtx2Decoder } from "../../tools/assets/ktx";
import { createSceneLink, getRootSceneLink } from "../../tools/scene/scene-link";
import { UniqueNumber, waitNextAnimationFrame, waitUntil } from "../../tools/tools";
import { isSprite, isSpriteManagerNode, isSpriteMapNode } from "../../tools/guards/sprites";
import { defaultGizmoSnapPreferences, IGizmoSnapPreferences, roundGizmoSnapSteps } from "../../tools/scene/gizmo";
import { isAbstractMesh, isAnyTransformNode, isCamera, isCollisionInstancedMesh, isCollisionMesh, isLight, isMesh, isNode } from "../../tools/guards/nodes";

import { getMeshSelection, getMeshTopology, getMeshVertexData, sculptTerrain, setMeshSelection, setMeshVertexData } from "../../mcp/meshes/meshes";
import { simulateInputTouch } from "../../mcp/input/input";
import {
	applyTilePaintViewportStroke,
	applyTilePaletteOperation,
	getTilePaintViewport,
	getTilePaintViewportEditorState,
	getTilePaintViewportSnapshot,
	ITilePaintViewportMode,
	ITilePaintViewportSnapshot,
	restoreTilePaintViewportSnapshot,
	setTilePaintViewport,
	spriteMapLocalPointToGrid,
} from "../../mcp/sprites/sprites";
import { getSpriteShape, getSpriteShapeSnapshot, ISpriteShapeSnapshot, restoreSpriteShapeSnapshot, setSpriteShape } from "../../mcp/sprites/sprite-shapes";
import {
	ClothConstraintChannel,
	getClothConstraintPaintViewport,
	getClothConstraintSnapshot,
	getClothConstraintViewportData,
	IClothConstraintSnapshot,
	paintClothConstraints,
	restoreClothConstraintSnapshot,
	setClothConstraintPaintViewport,
} from "../../mcp/cloth/cloth";

import { EditorCamera } from "../nodes/camera";

import { saveRenderingConfigurationForCamera } from "../rendering/tools";
import { disposeVLSPostProcess, parseVLSPostProcess, vlsPostProcessCameraConfigurations } from "../rendering/vls";
import { disposeTAARenderingPipeline, parseTAARenderingPipeline, taaPipelineCameraConfigurations } from "../rendering/taa";
import { disposeSSRRenderingPipeline, parseSSRRenderingPipeline, ssrRenderingPipelineCameraConfigurations } from "../rendering/ssr";
import { disposeSSAO2RenderingPipeline, parseSSAO2RenderingPipeline, ssaoRenderingPipelineCameraConfigurations } from "../rendering/ssao";
import { disposeMotionBlurPostProcess, motionBlurPostProcessCameraConfigurations, parseMotionBlurPostProcess } from "../rendering/motion-blur";
import { defaultPipelineCameraConfigurations, disposeDefaultRenderingPipeline, parseDefaultRenderingPipeline } from "../rendering/default-pipeline";
import { customColorPostProcessCameraConfigurations, disposeCustomColorPostProcess, parseCustomColorPostProcess } from "../rendering/custom-color";

import { EditorGraphContextMenu } from "./graph/context-menu";

import { EditorPreviewIcons } from "./preview/icons";
import { EditorPreviewCamera } from "./preview/camera";
import { EditorPreviewAxisHelper } from "./preview/axis";
import { EditorPreviewPlayComponent } from "./preview/play";

import { EditorPreviewGizmo } from "./preview/gizmo/gizmo";
import { EditorPreviewGizmoSettings } from "./preview/gizmo/settings";
import { EditorPhysics2DEffectorViewport } from "./preview/physics2d-effectors";
import { EditorPhysics2DJointViewport } from "./preview/physics2d-joints";

import { Stats } from "./preview/stats/stats";
import { StatRow } from "./preview/stats/row";
import { StatsValuesType } from "./preview/stats/types";

import { applySoundAsset } from "./preview/import/sound";
import { applyTextureAssetToObject } from "./preview/import/texture";
import { applyMaterialAssetToObject } from "./preview/import/material";
import { EditorPreviewConvertProgress } from "./preview/import/progress";
import { loadImportedParticleSystemFile } from "./preview/import/particles";
import { loadImportedSceneFile, tryConvertBlendFileLocally, tryConvertSceneFile } from "./preview/import/import";

export interface IEditorPreviewProps {
	/**
	 * The editor reference.
	 */
	editor: Editor;
}

export interface IEditorPreviewState {
	/**
	 * Defines the information message drawn over the preview to tell the user what is happening.
	 */
	informationMessage: ReactNode;

	isFocused: boolean;
	rightClickedObject?: any;
	pickingEnabled: boolean;

	showStatsValues: boolean;
	statsValues?: StatsValuesType;

	playEnabled: boolean;
	playSceneLoadingProgress: number;

	gizmoSnap: IGizmoSnapPreferences;
	activeGizmo: "position" | "rotation" | "scaling" | "none";

	/**
	 * Defines the fixed dimensions of the preview canvas.
	 * "fit" means the canvas will fit the entire panel container.
	 */
	fixedDimensions: "720p" | "1080p" | "4k" | "device" | "fit";
	deviceSimulation: { width: number; height: number; dpi: number; safeArea: [number, number, number, number] } | null;
	touchSimulation: { pressed: boolean; x: number; y: number };
}

export class EditorPreview extends Component<IEditorPreviewProps, IEditorPreviewState> {
	/**
	 * The engine of the preview.
	 */
	public engine!: AbstractEngine;
	/**
	 * The scene of the preview.
	 */
	public scene!: Scene;
	/**
	 * The camera of the preview.
	 */
	public camera!: EditorCamera;

	/**
	 * The gizmo manager of the preview
	 */
	public gizmo!: EditorPreviewGizmo;
	/**
	 * The helper drawn over the scene to help visualizing and selecting nodes like lights, cameras, particle systems, etc.
	 */
	public icons!: EditorPreviewIcons;
	/**
	 * The helper drawn over the scene to help visualizing the axis according to the current camera view.
	 */
	public axis!: EditorPreviewAxisHelper;

	/**
	 * The play component of the preview.
	 */
	public play!: EditorPreviewPlayComponent;

	/**
	 * The current statistics of the preview.
	 * This is used to display the FPS and other values.
	 */
	public statistics!: Stats;

	/**
	 * Defines the reference to the canvas drawn in the preview.
	 */
	public canvas: HTMLCanvasElement | null = null;

	/**
	 * Defines the reference to the last picking info processed in the preview.
	 */
	public lastPickingInfo: PickingInfo | null = null;

	/**
	 * Defines the reference to the selection outline layer used to highlight a mesh when, for example, the pointer is over it.
	 */
	public selectionOutlineLayer!: SelectionOutlineLayer;
	/**
	 * Defines the reference to the clustered lighting container.
	 */
	public clusteredLightContainer!: ClusteredLightContainer;

	private _renderScene: boolean = true;
	private _mouseDownPosition: Vector2 = Vector2.Zero();

	private _lastPickedDecal: AbstractMesh | null = null;
	private _objectUnderPointer: AbstractMesh | Sprite | null = null;
	private _tilePaintGridMesh: LinesMesh | null = null;
	private _tilePaintBrushMesh: LinesMesh | null = null;
	private _tilePaintVisualKey: string | null = null;
	private _tilePaintBrushKey: string | null = null;
	private _tilePaintHover: [number, number] | null = null;
	private _tilePaintStrokeBefore: ITilePaintViewportSnapshot | null = null;
	private _tilePaintStrokeMode: Extract<ITilePaintViewportMode, "paint" | "erase"> | null = null;
	private _tilePaintStrokeAnchors = new Set<string>();
	private _tilePaintSelectionAnchor: [number, number] | null = null;
	private _clothConstraintMarkersMesh: LinesMesh | null = null;
	private _clothConstraintBrushMesh: LinesMesh | null = null;
	private _clothConstraintMarkerLineCount = 0;
	private _clothConstraintVisualTargetId: string | null = null;
	private _clothConstraintHover: { point: Vector3; normal: Vector3 } | null = null;
	private _clothConstraintStrokeBefore: IClothConstraintSnapshot | null = null;
	private _clothConstraintStrokeMode: "paint" | "erase" | null = null;
	private _clothConstraintStrokeAnchors = new Set<string>();
	private _spriteShapeHandleMeshes: Mesh[] = [];
	private _spriteShapeHandleLine: LinesMesh | null = null;
	private _spriteShapeHandleMaterial: StandardMaterial | null = null;
	private _spriteShapeVisualKey: string | null = null;
	private _spriteShapeDrag: { shape: Mesh; pointId: string; before: ISpriteShapeSnapshot } | null = null;
	private _physics2DJointViewport = new EditorPhysics2DJointViewport();
	private _physics2DEffectorViewport = new EditorPhysics2DEffectorViewport();

	private _workingCanvas: HTMLCanvasElement | null = null;
	private _mainView: EngineView | null = null;

	/** @internal */
	public _previewCamera: Camera | null = null;

	public constructor(props: IEditorPreviewProps) {
		super(props);

		this.state = {
			isFocused: false,
			activeGizmo: "none",
			pickingEnabled: true,
			informationMessage: "",
			fixedDimensions: "fit",
			deviceSimulation: null,
			touchSimulation: { pressed: false, x: 0.5, y: 0.5 },

			showStatsValues: false,

			playEnabled: false,
			playSceneLoadingProgress: 0,

			gizmoSnap: { ...defaultGizmoSnapPreferences },
		};

		ipcRenderer.on("gizmo:position", () => this.setActiveGizmo("position"));
		ipcRenderer.on("gizmo:rotation", () => this.setActiveGizmo("rotation"));
		ipcRenderer.on("gizmo:scaling", () => this.setActiveGizmo("scaling"));

		ipcRenderer.on("preview:focus", () => !isDomTextInputFocused() && this.focusObject());
		ipcRenderer.on("preview:edit-camera", () => this.props.editor.layout.inspector.setEditedObject(this.props.editor.layout.preview.scene.activeCamera));

		ipcRenderer.on("preview:screenshot", (_, size) => saveSceneScreenshot(this.props.editor.layout.preview.scene, size));

		onTextureAddedObservable.add(() => checkProjectCachedCompressedTextures(props.editor));
	}

	public render(): ReactNode {
		return (
			<div className="relative w-full h-full text-foreground">
				<div className="flex flex-col w-full h-full">
					{this._getToolbar()}

					<EditorGraphContextMenu editor={this.props.editor} object={this.state.rightClickedObject} onOpenChange={(o) => !o && this._resetPointerContextInfo()}>
						<canvas
							ref={(r) => this._onGotCanvasRef(r!)}
							onDrop={(ev) => this._handleDrop(ev)}
							onDragOver={(ev) => ev.preventDefault()}
							onContextMenu={(ev) =>
								this.scene && (getTilePaintViewportEditorState(this.scene).enabled || getClothConstraintPaintViewport(this.scene).enabled) && ev.preventDefault()
							}
							onBlur={() => this.setState({ isFocused: false })}
							onFocus={() => this.setState({ isFocused: true })}
							onPointerUp={(ev) => this._handleMouseUp(ev)}
							onPointerDown={(ev) => this._handleMouseDown(ev)}
							onPointerMove={(ev) => this.scene && this._handleMouseMove(this.scene.pointerX, this.scene.pointerY, ev)}
							onPointerCancel={(ev) =>
								!this._finishPhysics2DJointDrag(ev) &&
								!this._finishPhysics2DEffectorDrag(ev) &&
								!this._finishSpriteShapeDrag(ev) &&
								!this._finishClothConstraintPaintStroke(ev) &&
								this._finishTilePaintStroke(ev)
							}
							onDoubleClick={(ev) => this._handleDoubleClick(ev)}
							onMouseLeave={() => this._handleMouseLeave()}
							onDragLeave={() => this._handleMouseLeave()}
							className={`
                                select-none outline-none w-full h-full object-contain
                                ${this.state.fixedDimensions !== "fit" ? "bg-black" : "bg-background"}
                                transition-all duration-300 ease-in-out
                            `}
						/>
						{this.state.deviceSimulation && (
							<div
								className="absolute border-2 border-dashed border-yellow-400/80 pointer-events-none"
								style={{
									left: `${(this.state.deviceSimulation.safeArea[3] / this.state.deviceSimulation.width) * 100}%`,
									right: `${(this.state.deviceSimulation.safeArea[1] / this.state.deviceSimulation.width) * 100}%`,
									top: `${(this.state.deviceSimulation.safeArea[0] / this.state.deviceSimulation.height) * 100}%`,
									bottom: `${(this.state.deviceSimulation.safeArea[2] / this.state.deviceSimulation.height) * 100}%`,
								}}
							/>
						)}
						{this.state.deviceSimulation && this._getTouchSimulationOverlay()}

						{(this.play?.state.preparingPlay || this.play?.state.loading) && (
							<div className="absolute top-0 left-0 w-full h-full bg-black">
								<div className="flex flex-col justify-center items-center gap-10 w-full h-full bg-black">
									<Grid width={24} height={24} color="gray" />

									{this.play?.state.loading && <Progress className="w-1/2" value={this.state.playSceneLoadingProgress * 100} />}
								</div>
							</div>
						)}
					</EditorGraphContextMenu>
				</div>

				<EditorGraphContextMenu editor={this.props.editor} object={this.state.rightClickedObject} onOpenChange={(o) => !o && this._resetPointerContextInfo()}>
					<EditorPreviewIcons ref={(r) => this._onGotIconsRef(r!)} editor={this.props.editor} />
				</EditorGraphContextMenu>

				{this._previewCamera && this.scene?.cameras.includes(this._previewCamera) && (
					<EditorPreviewCamera hidden={this.play?.state.playing} key={this._previewCamera.id} editor={this.props.editor} camera={this._previewCamera} />
				)}

				<EditorPreviewAxisHelper ref={(r) => (this.axis = r!)} editor={this.props.editor} />

				<div
					style={{
						opacity: this.state.informationMessage ? "1" : "0",
						top: this.state.informationMessage ? "45px" : "-50px",
					}}
					className="absolute left-0 flex gap-2 items-center px-2 h-10 bg-black/50 transition-all duration-300 pointer-events-none"
				>
					<SpinnerUIComponent width="16" />
					<div>{this.state.informationMessage}</div>
				</div>
			</div>
		);
	}

	/**
	 * Sets whether or not to render the scene.
	 * @param render defines whether or not to render the scene.
	 */
	public setRenderScene(render: boolean): void {
		this._renderScene = render;
	}

	public get renderScene(): boolean {
		return this._renderScene;
	}

	/**
	 * When set (e.g. while capturing a cinematic at a profile resolution), panel resizes keep the canvas at exactly this size.
	 */
	public lockedCanvasSize: { width: number; height: number } | null = null;

	private _suspendedCaptureViews: { enabled: boolean }[] = [];

	/**
	 * Renders at an exact resolution for captures: locks the canvas size and suspends the engine views, which otherwise
	 * resize the rendering canvas to their on-screen size every frame. Callers render explicitly (e.g. `scene.render()`).
	 */
	public beginFixedSizeCapture(width: number, height: number): void {
		this.lockedCanvasSize = { width, height };
		this._suspendedCaptureViews = (this.engine.views ?? []).filter((view) => view.enabled);
		this._suspendedCaptureViews.forEach((view) => (view.enabled = false));
		this.engine.setSize(width, height);
	}

	/**
	 * Restores the engine views and panel-driven resizing after {@link beginFixedSizeCapture}.
	 */
	public endFixedSizeCapture(): void {
		this._suspendedCaptureViews.forEach((view) => (view.enabled = true));
		this._suspendedCaptureViews = [];
		this.lockedCanvasSize = null;
	}

	/**
	 * Resizes the engine.
	 */
	public resize(): void {
		if (this.lockedCanvasSize) {
			this.engine?.setSize(this.lockedCanvasSize.width, this.lockedCanvasSize.height);
			return;
		}

		if (this.state.fixedDimensions === "fit") {
			this.engine?.resize();
		}
	}

	/**
	 * Resets the preview component by re-creating the engine and an empty scene.
	 */
	public async reset(): Promise<void> {
		if (!this.canvas) {
			return;
		}

		this.axis?.stop();
		this.icons?.stop();

		disposeSSRRenderingPipeline();
		disposeMotionBlurPostProcess();
		disposeSSAO2RenderingPipeline();
		disposeDefaultRenderingPipeline();
		disposeTAARenderingPipeline();
		disposeCustomColorPostProcess();

		this._disposeTilePaintViewportVisuals();
		this._disposeClothConstraintViewportVisuals();
		this._disposeSpriteShapeHandles(true);
		this._physics2DJointViewport.cancel(this.scene, this.props.editor);
		this._physics2DJointViewport.dispose(true);
		this._physics2DEffectorViewport.dispose(true);
		this.scene?.dispose();

		/**
		 * engine.dispose() generates an error:
		 * node_modules/babylonjs/babylon.js:1 Uncaught (in promise) InvalidAccessError: Failed to execute 'disconnect' on 'AudioNode': the given destination is not connected.
		 * This error is located in _WebAudioMainBus class in the dispose method. It is not reproduced on the Babylon.js playground. This error
		 * appeared after the migration to electron 35.7.5. A workaround consists on try/catching the dispose method.
		 * It appears to work this way and the VRAM is successfully released during the second .dispose() call in the catch.
		 * TODO: investigate in future bump of electron versions if the problem persists.
		 */
		try {
			this.engine?.dispose();
		} catch (e) {
			this.engine?.dispose();
		}

		this.scene = null!;
		this.engine = null!;

		this._previewCamera = null;

		return this._onGotCanvasRef(this.canvas);
	}

	/**
	 * Sets the fixed dimensions of the renderer. This is particularly useful to test the rendering
	 * performances and the aspect ratio of the scene in case it'll be renderer in fullscreen.
	 */
	public setFixedDimensions(fixedDimensions: "720p" | "1080p" | "4k" | "fit"): void {
		this.setState({
			fixedDimensions,
		});

		if (!this.engine || !this._mainView || !this.canvas) {
			return;
		}

		this._mainView!.customResize = undefined;

		switch (fixedDimensions) {
			case "720p":
				this.canvas!.width = 1280;
				this.canvas!.height = 720;

				this._mainView!.customResize = () => {
					this.engine.setSize(1280, 720);
				};
				break;
			case "1080p":
				this.canvas!.width = 1920;
				this.canvas!.height = 1080;

				this._mainView!.customResize = () => {
					this.engine.setSize(1920, 1080);
				};
				break;
			case "4k":
				this.canvas!.width = 3840;
				this.canvas!.height = 2160;

				this._mainView!.customResize = () => {
					this.engine.setSize(3840, 2160);
				};
				break;
		}
	}

	/** Applies a validated device profile to the actual preview engine view. */
	public setDeviceSimulation(simulation: { width: number; height: number; dpi: number; safeArea: [number, number, number, number] } | null): void {
		if (!simulation) {
			this.setState({ deviceSimulation: null });
			this.setFixedDimensions("fit");
			return;
		}
		this.setState({ fixedDimensions: "device", deviceSimulation: simulation });
		if (!this.engine || !this._mainView || !this.canvas) {
			return;
		}
		this.canvas.width = simulation.width;
		this.canvas.height = simulation.height;
		this._mainView.customResize = () => this.engine.setSize(simulation.width, simulation.height);
		this.engine.resize();
	}

	/**
	 * Tries to focused the given object or the first one selected in the graph.
	 */
	public focusObject(object?: any): void {
		const selectedNode = object ?? this.props.editor.layout.graph.getSelectedNodes()[0]?.nodeData;
		if (!selectedNode) {
			return;
		}

		const camera = this.scene.activeCamera;
		if (!camera) {
			return;
		}

		let target: Vector3 | undefined;
		let position: Vector3 | undefined;

		if (isCamera(selectedNode)) {
			target = selectedNode.globalPosition;
		} else if (isAbstractMesh(selectedNode)) {
			selectedNode.refreshBoundingInfo({
				applyMorph: true,
				applySkeleton: true,
				updatePositionsArray: true,
			});

			const bb = selectedNode.getBoundingInfo();
			const center = bb.boundingSphere.centerWorld;

			position = getCameraFocusPositionFor(center, camera, {
				distance: 2,
				minimum: selectedNode.geometry ? bb.boundingBox.minimumWorld : new Vector3(-75, -75, -75),
				maximum: selectedNode.geometry ? bb.boundingBox.maximumWorld : new Vector3(75, 75, 75),
			});
			target = bb.boundingBox.centerWorld;
		} else if (isLight(selectedNode) || isAnyTransformNode(selectedNode)) {
			target = selectedNode.getAbsolutePosition();
		} else if (isAnyParticleSystem(selectedNode)) {
			if (isAbstractMesh(selectedNode.emitter)) {
				target = selectedNode.emitter.getAbsolutePosition();
			} else if (isVector3(selectedNode.emitter)) {
				target = selectedNode.emitter;
			}
		} else if (isSprite(selectedNode)) {
			const bb = new BoundingBox(new Vector3(-selectedNode.width * 0.5, -selectedNode.height * 0.5, 0), new Vector3(selectedNode.width * 0.5, selectedNode.height * 0.5, 0));
			const center = bb.centerWorld;

			position = getCameraFocusPositionFor(center, camera, {
				distance: 2,
				minimum: bb.minimumWorld,
				maximum: bb.maximumWorld,
			});

			target = selectedNode.position.clone();
		}

		if (target) {
			const tweenConfiguration = {
				target,
			} as ITweenConfiguration;

			if (position) {
				tweenConfiguration.position = position;
			}

			Tween.create(camera, 0.5, tweenConfiguration);
		}
	}

	/**
	 * Sets the given camera active as a preview.
	 * This helps to visualize what the selected camera sees when being manipulated
	 * using gizmos for example.
	 * When "null", the preview is removed.
	 * @param camera the camera to activate the preview
	 */
	public setCameraPreviewActive(camera: Camera | null): void {
		if (this._previewCamera === camera || camera === this.scene.activeCamera) {
			return;
		}

		this._previewCamera = camera;
		this.forceUpdate();
	}

	private _onGotIconsRef(ref: EditorPreviewIcons): void {
		if (this.icons) {
			return;
		}

		waitNextAnimationFrame().then(() => {
			this.icons = ref;
			this.icons?.start();
		});
	}

	private async _onGotCanvasRef(canvas: HTMLCanvasElement): Promise<void> {
		if (this.engine) {
			return;
		}

		this.canvas ??= canvas;
		this._workingCanvas ??= document.createElement("canvas");

		await waitUntil(() => this.props.editor.path);

		initializeKtx2Decoder(this.props.editor.path!);
		await Promise.all([await initializeRecast(this.props.editor), await initializeHavok(this.props.editor.path!)]);

		SceneLoaderFlags.ShowLoadingScreen = false;

		Animation.AllowMatricesInterpolation = true;
		Animation.AllowMatrixDecomposeForInterpolation = true;

		const webGpuSupported = false;
		// const webGpuSupported = await WebGPUEngine.IsSupportedAsync;

		if (webGpuSupported) {
			this.engine = await this._createWebgpuEngine(this._workingCanvas);
		} else {
			this.engine = new Engine(this._workingCanvas, true, {
				antialias: true,
				audioEngine: true,
				adaptToDeviceRatio: true,
				disableWebGL2Support: false,
				useHighPrecisionFloats: true,
				useHighPrecisionMatrix: true,
				powerPreference: "high-performance",
				failIfMajorPerformanceCaveat: false,
				useExactSrgbConversions: true,
			});
		}

		this.engine.disableContextMenu = false;
		this.engine.inputElement = this.canvas;

		this.scene = new Scene(this.engine);
		this.scene.autoClear = true;
		this.scene.skipPointerUpPicking = true;
		this.scene.skipPointerDownPicking = true;
		this.scene.skipPointerMovePicking = true;

		this.camera = new EditorCamera("camera", Vector3.Zero(), this.scene);
		this.camera.attachControl(true);

		_GetAudioEngine(null).listener.attach(this.camera);

		this.gizmo = new EditorPreviewGizmo(this.scene);
		this.gizmo.setSnapPreferences(this.state.gizmoSnap);

		this.selectionOutlineLayer = new SelectionOutlineLayer("selectionOutline", this.scene);
		this.selectionOutlineLayer.outlineThickness = 4;

		this.clusteredLightContainer = new ClusteredLightContainer("Clustered Light Container", [], this.scene);
		this.clusteredLightContainer.id = Tools.RandomId();
		this.clusteredLightContainer.uniqueId = UniqueNumber.Get();

		this.engine.hideLoadingUI();
		this._mainView = this.engine.registerView(this.canvas);

		this.engine.runRenderLoop(() => {
			if (this._renderScene && !this.play.state.playing) {
				this._syncClothConstraintViewportVisuals();
				this._syncTilePaintViewportVisuals();
				this._syncSpriteShapeHandles();
				const selectedNode = this.props.editor.layout.graph.getSelectedNodes()[0]?.nodeData;
				this._physics2DJointViewport.sync(this.scene, selectedNode);
				this._physics2DEffectorViewport.sync(this.scene, selectedNode);
				if (this._previewCamera) {
					// TODO: remove this once fixed
					// Bug report on forum: https://forum.babylonjs.com/t/multi-canvas-and-post-processes/59616/23
					const ppRenderer = this.scene.prePassRenderer;
					if (ppRenderer) {
						ppRenderer.markAsDirty();
					}
				}

				this.scene.render();

				if (!this.engine.activeView?.camera) {
					this.axis.scene?.render();
				}
				return;
			}

			if (this.play.canPlayScene) {
				try {
					return this.play.scene?.render();
				} catch (e) {
					if (e instanceof Error) {
						this.props.editor.layout.console.error(`Error while playing the scene:\n${e.message}`);
					}
					console.error(e);
					this.play.stop();
				}
			}
		});

		Tween.Scene = this.scene;
		Tween.DefaultEasing = {
			type: new CubicEase(),
			mode: EasingFunction.EASINGMODE_EASEINOUT,
		};

		enableEditorPhysics(this.scene);

		this.statistics = new Stats(this.props.editor);
		this.statistics.onValuesChangedObservable.add((values) => {
			if (this.state.showStatsValues) {
				this.setState({
					statsValues: { ...values },
				});
			}
		});

		this.axis?.start();
		this.icons?.start();

		this.forceUpdate();
	}

	private async _createWebgpuEngine(canvas: HTMLCanvasElement): Promise<WebGPUEngine> {
		const glslangJs = require("@babylonjs/core/assets/glslang/glslang.cjs");
		const glslang = glslangJs(join(process.cwd(), "../node_modules/@babylonjs/core/assets/glslang/glslang.wasm"));

		const twgslJs = require("@babylonjs/core/assets/twgsl/twgsl.cjs");
		const twgsl = await twgslJs(join(process.cwd(), "../node_modules/@babylonjs/core/assets/twgsl/twgsl.wasm"));

		const engine = new WebGPUEngine(canvas, {
			antialias: true,
			audioEngine: true,
			adaptToDeviceRatio: true,
			glslangOptions: {
				glslang,
			},
			twgslOptions: {
				twgsl,
			},
			useHighPrecisionMatrix: true,
			powerPreference: "high-performance",
		});

		await engine.initAsync();

		return engine;
	}

	private _beginPhysics2DEffectorDrag(event: ReactPointerEvent<HTMLCanvasElement>): boolean {
		if (event.button !== 0 || !this._physics2DEffectorViewport.begin(this.scene, this.scene.pointerX, this.scene.pointerY)) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		this.scene.activeCamera?.inputs.detachElement();
		this.setState({ informationMessage: "Physics 2D Effector: dragging a direction, arc, or liquid-surface handle." });
		return true;
	}

	private _beginPhysics2DJointDrag(event: ReactPointerEvent<HTMLCanvasElement>): boolean {
		if (event.button !== 0 || !this._physics2DJointViewport.begin(this.scene, this.scene.pointerX, this.scene.pointerY)) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		this.scene.activeCamera?.inputs.detachElement();
		this.setState({ informationMessage: "Physics 2D Joint: dragging an anchor, axis, limit, target, or offset handle." });
		return true;
	}

	private _movePhysics2DJointDrag(x: number, y: number, event: ReactPointerEvent<HTMLCanvasElement>): boolean {
		try {
			if (!this._physics2DJointViewport.move(this.scene, this.scene.activeCamera, x, y, this.props.editor)) {
				return false;
			}
			event.preventDefault();
			event.stopPropagation();
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not edit the Physics 2D Joint handle.");
			this._finishPhysics2DJointDrag(event);
			return true;
		}
	}

	private _finishPhysics2DJointDrag(event?: ReactPointerEvent<HTMLCanvasElement>): boolean {
		if (!this._physics2DJointViewport.finish(this.scene, this.props.editor, () => this.forceUpdate())) {
			return false;
		}
		this.scene.activeCamera?.inputs.attachElement();
		if (event && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		this.setState({ informationMessage: "Physics 2D Joint: orange handles edit solver-space anchors, axes, limits, targets, and offsets." });
		return true;
	}

	private _movePhysics2DEffectorDrag(x: number, y: number, event: ReactPointerEvent<HTMLCanvasElement>): boolean {
		try {
			if (!this._physics2DEffectorViewport.move(this.scene, this.scene.activeCamera, x, y, this.props.editor)) {
				return false;
			}
			event.preventDefault();
			event.stopPropagation();
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not edit the Physics 2D Effector handle.");
			this._finishPhysics2DEffectorDrag(event);
			return true;
		}
	}

	private _finishPhysics2DEffectorDrag(event?: ReactPointerEvent<HTMLCanvasElement>): boolean {
		if (!this._physics2DEffectorViewport.finish(this.scene, this.props.editor, () => this.forceUpdate())) {
			return false;
		}
		this.scene.activeCamera?.inputs.attachElement();
		if (event && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		this.setState({ informationMessage: "Physics 2D Effector: cyan handles edit direction, accepted arc, and Buoyancy surface in the solver's authored frame." });
		return true;
	}

	private _disposeSpriteShapeHandles(disposeMaterial = false): void {
		for (const handle of this._spriteShapeHandleMeshes) {
			handle.dispose(false, false);
		}
		this._spriteShapeHandleMeshes = [];
		this._spriteShapeHandleLine?.dispose(false, false);
		this._spriteShapeHandleLine = null;
		this._spriteShapeVisualKey = null;
		if (disposeMaterial) {
			this._spriteShapeHandleMaterial?.dispose(true, true);
			this._spriteShapeHandleMaterial = null;
			this._spriteShapeDrag = null;
		}
	}

	private _syncSpriteShapeHandles(): void {
		if (!this.scene) {
			return;
		}
		const selected = this.props.editor.layout.graph.getSelectedNodes()[0]?.nodeData;
		if (!isMesh(selected) || selected.metadata?.babylonEditorSpriteShape?.model !== "unity-sprite-shape-controller-v1") {
			this._disposeSpriteShapeHandles();
			return;
		}
		let definition: ISpriteShapeDefinition;
		try {
			definition = (getSpriteShape(this.scene, { nodeId: selected.id }) as { definition: ISpriteShapeDefinition }).definition;
		} catch {
			this._disposeSpriteShapeHandles();
			return;
		}
		const visualKey = `${selected.id}:${definition.revision}`;
		if (visualKey === this._spriteShapeVisualKey && this._spriteShapeHandleMeshes.every((handle) => !handle.isDisposed())) {
			return;
		}
		this._disposeSpriteShapeHandles();
		this._spriteShapeHandleMaterial ??= new StandardMaterial("Sprite Shape Control Point Material", this.scene);
		this._spriteShapeHandleMaterial.disableLighting = true;
		this._spriteShapeHandleMaterial.emissiveColor = new Color3(1, 0.72, 0.08);
		this._spriteShapeHandleMaterial.diffuseColor = new Color3(1, 0.72, 0.08);
		this._spriteShapeHandleMaterial.backFaceCulling = false;
		const linePoints = definition.points.map((point) => new Vector3(point.position[0], point.position[1], -2));
		if (definition.closed) {
			linePoints.push(linePoints[0].clone());
		}
		this._spriteShapeHandleLine = MeshBuilder.CreateLines("Sprite Shape Spline Handles", { points: linePoints }, this.scene);
		this._spriteShapeHandleLine.parent = selected;
		this._spriteShapeHandleLine.color = new Color3(1, 0.72, 0.08);
		this._spriteShapeHandleLine.alpha = 0.9;
		this._spriteShapeHandleLine.isPickable = false;
		this._spriteShapeHandleLine.alwaysSelectAsActiveMesh = true;
		this._spriteShapeHandleLine.renderingGroupId = 3;
		setNodeSerializable(this._spriteShapeHandleLine, false);
		setNodeVisibleInGraph(this._spriteShapeHandleLine, false);
		for (const point of definition.points) {
			const handle = MeshBuilder.CreateSphere(`Sprite Shape Point ${point.id}`, { diameter: 16, segments: 8 }, this.scene);
			handle.parent = selected;
			handle.position.set(point.position[0], point.position[1], -3);
			handle.material = this._spriteShapeHandleMaterial;
			handle.renderOverlay = true;
			handle.overlayColor = new Color3(1, 0.72, 0.08);
			handle.overlayAlpha = 0.75;
			handle.renderingGroupId = 3;
			handle.alwaysSelectAsActiveMesh = true;
			handle.metadata = { babylonEditorSpriteShapeHandle: { nodeId: selected.id, pointId: point.id } };
			setNodeSerializable(handle, false);
			setNodeVisibleInGraph(handle, false);
			this._spriteShapeHandleMeshes.push(handle);
		}
		this._spriteShapeVisualKey = visualKey;
	}

	private _getSpriteShapeHandleHit(x: number, y: number): Mesh | null {
		const hit = this.scene.pick(x, y, (mesh) => Boolean(mesh.metadata?.babylonEditorSpriteShapeHandle), false, this.scene.activeCamera ?? undefined);
		return isMesh(hit.pickedMesh) && hit.pickedMesh.metadata?.babylonEditorSpriteShapeHandle ? hit.pickedMesh : null;
	}

	private _beginSpriteShapeDrag(event: ReactPointerEvent<HTMLCanvasElement>): boolean {
		if (event.button !== 0) {
			return false;
		}
		const handle = this._getSpriteShapeHandleHit(this.scene.pointerX, this.scene.pointerY);
		const metadata = handle?.metadata?.babylonEditorSpriteShapeHandle as { nodeId?: string; pointId?: string } | undefined;
		const shape = metadata?.nodeId ? this.scene.getMeshById(metadata.nodeId) : null;
		if (!isMesh(shape) || !metadata?.pointId) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		this.scene.activeCamera?.inputs.detachElement();
		this._spriteShapeDrag = { shape, pointId: metadata.pointId, before: getSpriteShapeSnapshot(shape) };
		this.setState({ informationMessage: `Sprite Shape: dragging control point ${metadata.pointId}.` });
		return true;
	}

	private _moveSpriteShapeDrag(x: number, y: number, event: ReactPointerEvent<HTMLCanvasElement>): boolean {
		const drag = this._spriteShapeDrag;
		const camera = this.scene.activeCamera;
		if (!drag || !camera) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		const worldMatrix = drag.shape.computeWorldMatrix(true);
		const planePosition = Vector3.TransformCoordinates(Vector3.Zero(), worldMatrix);
		const planeNormal = Vector3.TransformNormal(Vector3.Forward(), worldMatrix).normalize();
		const ray = this.scene.createPickingRay(x, y, Matrix.Identity(), camera);
		const distance = ray.intersectsPlane(Plane.FromPositionAndNormal(planePosition, planeNormal));
		if (distance === null) {
			return true;
		}
		const worldPoint = ray.origin.add(ray.direction.scale(distance));
		const localPoint = Vector3.TransformCoordinates(worldPoint, worldMatrix.clone().invert());
		try {
			const readback = getSpriteShape(this.scene, { nodeId: drag.shape.id }) as { definition: ISpriteShapeDefinition };
			const point = readback.definition.points.find((candidate) => candidate.id === drag.pointId);
			if (!point || (Math.abs(point.position[0] - localPoint.x) < 0.001 && Math.abs(point.position[1] - localPoint.y) < 0.001)) {
				return true;
			}
			const points = readback.definition.points.map((candidate) =>
				candidate.id === drag.pointId ? { ...candidate, position: [localPoint.x, localPoint.y] as [number, number] } : candidate
			);
			setSpriteShape(this.scene, { nodeId: drag.shape.id, expectedRevision: readback.definition.revision, update: { points } }, { editor: this.props.editor });
			this._spriteShapeVisualKey = null;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not move the Sprite Shape control point.");
			this._finishSpriteShapeDrag(event);
		}
		return true;
	}

	private _finishSpriteShapeDrag(event?: ReactPointerEvent<HTMLCanvasElement>): boolean {
		const drag = this._spriteShapeDrag;
		if (!drag) {
			return false;
		}
		const after = getSpriteShapeSnapshot(drag.shape);
		if (JSON.stringify(drag.before.definition.points) !== JSON.stringify(after.definition.points)) {
			const before = drag.before;
			registerUndoRedo({
				undo: () => {
					restoreSpriteShapeSnapshot(this.scene, before, { editor: this.props.editor });
					this._spriteShapeVisualKey = null;
				},
				redo: () => {
					restoreSpriteShapeSnapshot(this.scene, after, { editor: this.props.editor });
					this._spriteShapeVisualKey = null;
				},
			});
		}
		this._spriteShapeDrag = null;
		this.scene.activeCamera?.inputs.attachElement();
		if (event && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		this.setState({ informationMessage: "Sprite Shape: drag yellow control points; Inspector edits tangents, height, UVs, profile, and collision." });
		return true;
	}

	private _disposeTilePaintViewportVisuals(): void {
		this._tilePaintGridMesh?.dispose();
		this._tilePaintBrushMesh?.dispose();
		this._tilePaintGridMesh = null;
		this._tilePaintBrushMesh = null;
		this._tilePaintVisualKey = null;
		this._tilePaintBrushKey = null;
		this._tilePaintHover = null;
	}

	private _disposeClothConstraintViewportVisuals(): void {
		this._clothConstraintMarkersMesh?.dispose();
		this._clothConstraintBrushMesh?.dispose();
		this._clothConstraintMarkersMesh = null;
		this._clothConstraintBrushMesh = null;
		this._clothConstraintMarkerLineCount = 0;
		this._clothConstraintVisualTargetId = null;
		this._clothConstraintHover = null;
	}

	private _getActiveClothConstraintPaint(): {
		state: ReturnType<typeof getClothConstraintPaintViewport>;
		cloth: ReturnType<typeof getClothConstraintViewportData>;
		mesh: Mesh;
	} | null {
		const state = getClothConstraintPaintViewport(this.scene);
		const cloth = state.enabled && state.clothId ? getClothConstraintViewportData(this.scene, state.clothId, state.channel) : null;
		const mesh = cloth ? this.scene.getMeshById(cloth.meshId) : null;
		return cloth && isMesh(mesh) ? { state, cloth, mesh } : null;
	}

	private _syncClothConstraintViewportVisuals(): void {
		const active = this._getActiveClothConstraintPaint();
		if (!active) {
			this._disposeClothConstraintViewportVisuals();
			return;
		}
		if (this._clothConstraintVisualTargetId !== active.cloth.id) {
			this._disposeClothConstraintViewportVisuals();
			this._clothConstraintVisualTargetId = active.cloth.id;
		}
		const positions = active.mesh.getVerticesData("position");
		if (!positions) {
			this._disposeClothConstraintViewportVisuals();
			return;
		}
		const markerSize = Math.min(5, Math.max(0.5, active.state.radius * 0.04));
		const markerLines: Vector3[][] = [];
		for (const vertexIndex of active.cloth.vertexIndices) {
			const point = Vector3.FromArray(positions, vertexIndex * 3);
			markerLines.push(
				[point.add(new Vector3(-markerSize, 0, 0)), point.add(new Vector3(markerSize, 0, 0))],
				[point.add(new Vector3(0, -markerSize, 0)), point.add(new Vector3(0, markerSize, 0))],
				[point.add(new Vector3(0, 0, -markerSize)), point.add(new Vector3(0, 0, markerSize))]
			);
		}
		if (!markerLines.length) {
			this._clothConstraintMarkersMesh?.dispose();
			this._clothConstraintMarkersMesh = null;
			this._clothConstraintMarkerLineCount = 0;
		} else if (this._clothConstraintMarkersMesh && !this._clothConstraintMarkersMesh.isDisposed() && this._clothConstraintMarkerLineCount === markerLines.length) {
			MeshBuilder.CreateLineSystem("Cloth Constraint Markers", { lines: markerLines, instance: this._clothConstraintMarkersMesh });
		} else {
			this._clothConstraintMarkersMesh?.dispose();
			this._clothConstraintMarkersMesh = MeshBuilder.CreateLineSystem("Cloth Constraint Markers", { lines: markerLines, updatable: true }, this.scene);
			this._clothConstraintMarkersMesh.parent = active.mesh;
			this._clothConstraintMarkersMesh.color = active.state.channel === "maxDistance" ? new Color3(0.2, 0.85, 1) : new Color3(1, 0.55, 0.15);
			this._clothConstraintMarkersMesh.alpha = 0.9;
			this._clothConstraintMarkersMesh.isPickable = false;
			this._clothConstraintMarkersMesh.renderingGroupId = 3;
			setNodeSerializable(this._clothConstraintMarkersMesh, false);
			setNodeVisibleInGraph(this._clothConstraintMarkersMesh, false);
			this._clothConstraintMarkerLineCount = markerLines.length;
		}
		if (this._clothConstraintMarkersMesh) {
			this._clothConstraintMarkersMesh.color = active.state.channel === "maxDistance" ? new Color3(0.2, 0.85, 1) : new Color3(1, 0.55, 0.15);
		}

		if (!this._clothConstraintHover) {
			this._clothConstraintBrushMesh?.dispose();
			this._clothConstraintBrushMesh = null;
			return;
		}
		const normal = this._clothConstraintHover.normal.clone().normalize();
		const reference = Math.abs(normal.y) < 0.9 ? Vector3.Up() : Vector3.Right();
		const tangent = Vector3.Cross(normal, reference).normalize();
		const bitangent = Vector3.Cross(normal, tangent).normalize();
		const points: Vector3[] = [];
		for (let index = 0; index <= 48; index++) {
			const angle = (index / 48) * Math.PI * 2;
			points.push(this._clothConstraintHover.point.add(tangent.scale(Math.cos(angle) * active.state.radius)).add(bitangent.scale(Math.sin(angle) * active.state.radius)));
		}
		if (this._clothConstraintBrushMesh && !this._clothConstraintBrushMesh.isDisposed()) {
			MeshBuilder.CreateLines("Cloth Constraint Brush", { points, instance: this._clothConstraintBrushMesh });
		} else {
			this._clothConstraintBrushMesh = MeshBuilder.CreateLines("Cloth Constraint Brush", { points, updatable: true }, this.scene);
			this._clothConstraintBrushMesh.parent = active.mesh;
			this._clothConstraintBrushMesh.isPickable = false;
			this._clothConstraintBrushMesh.renderingGroupId = 3;
			setNodeSerializable(this._clothConstraintBrushMesh, false);
			setNodeVisibleInGraph(this._clothConstraintBrushMesh, false);
		}
		this._clothConstraintBrushMesh.color = this._clothConstraintStrokeMode === "erase" ? new Color3(1, 0.2, 0.2) : new Color3(0.25, 1, 0.35);
	}

	private _syncTilePaintViewportVisuals(): void {
		if (!this.scene) {
			return;
		}
		const state = getTilePaintViewportEditorState(this.scene);
		const candidate = state.enabled && state.mapNodeId ? this.scene.getTransformNodeById(state.mapNodeId) : null;
		if (!candidate || !isSpriteMapNode(candidate)) {
			this._disposeTilePaintViewportVisuals();
			return;
		}
		const map = candidate;
		const spriteMap = map.spriteMap;
		const outputPlane = map.outputPlane;
		const stage = spriteMap?.options.stageSize;
		if (!spriteMap || !outputPlane || !stage) {
			this._disposeTilePaintViewportVisuals();
			return;
		}
		if (!Number.isInteger(stage.x) || !Number.isInteger(stage.y) || stage.x < 1 || stage.y < 1) {
			this._disposeTilePaintViewportVisuals();
			return;
		}
		const layout = getSpriteMapTileGridConfiguration(map).layout;
		const gridKey = `${map.id}:${outputPlane.uniqueId}:${stage.x}:${stage.y}:${layout}`;
		if (gridKey !== this._tilePaintVisualKey || !this._tilePaintGridMesh || this._tilePaintGridMesh.isDisposed()) {
			this._tilePaintGridMesh?.dispose();
			const lines: Vector3[][] = [];
			if (layout === "rectangular") {
				const xStep = Math.max(1, Math.ceil(stage.x / 256));
				const yStep = Math.max(1, Math.ceil(stage.y / 256));
				for (let x = 0; x <= stage.x; x += xStep) {
					lines.push([new Vector3(-0.5 + x / stage.x, -0.5, -0.001), new Vector3(-0.5 + x / stage.x, 0.5, -0.001)]);
				}
				for (let y = 0; y <= stage.y; y += yStep) {
					lines.push([new Vector3(-0.5, 0.5 - y / stage.y, -0.001), new Vector3(0.5, 0.5 - y / stage.y, -0.001)]);
				}
			} else {
				const stride = Math.max(1, Math.ceil(Math.sqrt((stage.x * stage.y) / 4096)));
				for (let y = 0; y < stage.y; y += stride) {
					for (let x = 0; x < stage.x; x += stride) {
						const polygon = getTileGridCellPolygon([x, y], stage.x, stage.y, layout);
						lines.push([...polygon, polygon[0]].map((point) => new Vector3(point[0], point[1], -0.001)));
					}
				}
			}
			this._tilePaintGridMesh = MeshBuilder.CreateLineSystem("Tile Paint Grid", { lines }, this.scene);
			this._tilePaintGridMesh.parent = outputPlane;
			this._tilePaintGridMesh.color = new Color3(0.25, 0.72, 1);
			this._tilePaintGridMesh.alpha = 0.42;
			this._tilePaintGridMesh.isPickable = false;
			this._tilePaintGridMesh.alwaysSelectAsActiveMesh = true;
			this._tilePaintGridMesh.renderingGroupId = 3;
			this._tilePaintVisualKey = gridKey;
		}

		const hover = this._tilePaintHover;
		const brushKey = hover ? `${gridKey}:${hover[0]}:${hover[1]}:${state.brushSize[0]}:${state.brushSize[1]}:${this._tilePaintStrokeMode ?? state.mode}` : null;
		if (brushKey === this._tilePaintBrushKey && (!brushKey || (this._tilePaintBrushMesh && !this._tilePaintBrushMesh.isDisposed()))) {
			return;
		}
		this._tilePaintBrushMesh?.dispose();
		this._tilePaintBrushMesh = null;
		this._tilePaintBrushKey = brushKey;
		if (!hover) {
			return;
		}
		const outside = hover[0] + state.brushSize[0] > stage.x || hover[1] + state.brushSize[1] > stage.y;
		const mode = this._tilePaintStrokeMode ?? state.mode;
		const outlines: Vector3[][] = [];
		for (let y = 0; y < state.brushSize[1]; y++) {
			for (let x = 0; x < state.brushSize[0]; x++) {
				const polygon = getTileGridCellPolygon([hover[0] + x, hover[1] + y], stage.x, stage.y, layout);
				outlines.push([...polygon, polygon[0]].map((point) => new Vector3(point[0], point[1], -0.002)));
			}
		}
		this._tilePaintBrushMesh = MeshBuilder.CreateLineSystem("Tile Paint Brush", { lines: outlines }, this.scene);
		this._tilePaintBrushMesh.parent = outputPlane;
		this._tilePaintBrushMesh.color = outside || mode === "erase" ? new Color3(1, 0.25, 0.25) : new Color3(0.2, 1, 0.35);
		this._tilePaintBrushMesh.alpha = 1;
		this._tilePaintBrushMesh.isPickable = false;
		this._tilePaintBrushMesh.alwaysSelectAsActiveMesh = true;
		this._tilePaintBrushMesh.renderingGroupId = 3;
	}

	private _getTilePaintHit(x: number, y: number): { map: import("../nodes/sprite-map").SpriteMapNode; cell: [number, number] } | null {
		const state = getTilePaintViewportEditorState(this.scene);
		if (!state.enabled || !state.mapNodeId) {
			return null;
		}
		const candidate = this.scene.getTransformNodeById(state.mapNodeId);
		if (!candidate || !isSpriteMapNode(candidate) || !candidate.outputPlane || !candidate.spriteMap?.options.stageSize) {
			return null;
		}
		const pickingInfo = this._getPickingInfo(x, y);
		if (pickingInfo.pickedMesh !== candidate.outputPlane || !pickingInfo.pickedPoint) {
			return null;
		}
		const local = Vector3.TransformCoordinates(pickingInfo.pickedPoint, candidate.outputPlane.getWorldMatrix().clone().invert());
		const stage = candidate.spriteMap.options.stageSize;
		const cell = spriteMapLocalPointToGrid(local.x, local.y, stage.x, stage.y, getSpriteMapTileGridConfiguration(candidate).layout);
		return cell ? { map: candidate, cell } : null;
	}

	private _getClothConstraintPaintHit(x: number, y: number): { cloth: any; mesh: Mesh; point: Vector3; normal: Vector3 } | null {
		const active = this._getActiveClothConstraintPaint();
		if (!active) {
			return null;
		}
		const pickingInfo = this._getPickingInfo(x, y);
		const pickedMesh = pickingInfo.pickedMesh?._masterMesh ?? pickingInfo.pickedMesh;
		if (pickedMesh !== active.mesh || !pickingInfo.pickedPoint) {
			return null;
		}
		const inverseWorld = active.mesh.computeWorldMatrix(true).clone().invert();
		const point = Vector3.TransformCoordinates(pickingInfo.pickedPoint, inverseWorld);
		const normal = pickingInfo.getNormal(false) ?? Vector3.Forward();
		return { cloth: active.cloth, mesh: active.mesh, point, normal };
	}

	private _setClothConstraintPaintViewport(data: Record<string, unknown>): void {
		try {
			const current = getClothConstraintPaintViewport(this.scene);
			setClothConstraintPaintViewport(this.scene, { expectedRevision: current.revision, ...data }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update Cloth constraint paint settings.");
		}
	}

	private _applyClothConstraintPaintAnchor(hit: { cloth: any; point: Vector3 }): void {
		const key = `${hit.point.x.toFixed(2)}:${hit.point.y.toFixed(2)}:${hit.point.z.toFixed(2)}`;
		if (this._clothConstraintStrokeAnchors.has(key)) {
			return;
		}
		const state = getClothConstraintPaintViewport(this.scene);
		const snapshot = getClothConstraintSnapshot(this.scene, hit.cloth.id);
		try {
			paintClothConstraints(
				this.scene,
				{
					id: hit.cloth.id,
					expectedConstraintRevision: snapshot.constraintRevision,
					center: hit.point.asArray(),
					radius: state.radius,
					channel: state.channel,
					mode: this._clothConstraintStrokeMode ?? "paint",
					value: state.value,
					strength: state.strength,
					falloff: state.falloff,
					maxAffectedVertices: 1024,
				},
				{ editor: this.props.editor }
			);
			this._clothConstraintStrokeAnchors.add(key);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not paint Cloth constraints.");
		}
	}

	private _finishClothConstraintPaintStroke(event?: ReactPointerEvent<HTMLCanvasElement>): boolean {
		if (!this._clothConstraintStrokeBefore) {
			return false;
		}
		const before = this._clothConstraintStrokeBefore;
		const after = getClothConstraintSnapshot(this.scene, before.id);
		if (JSON.stringify(before.vertexConstraints) !== JSON.stringify(after.vertexConstraints)) {
			let expectedRevision = after.constraintRevision;
			registerUndoRedo({
				undo: () => {
					const restored = restoreClothConstraintSnapshot(this.scene, before, { editor: this.props.editor }, expectedRevision);
					expectedRevision = restored.constraintRevision;
				},
				redo: () => {
					const restored = restoreClothConstraintSnapshot(this.scene, after, { editor: this.props.editor }, expectedRevision);
					expectedRevision = restored.constraintRevision;
				},
			});
		}
		this._clothConstraintStrokeBefore = null;
		this._clothConstraintStrokeMode = null;
		this._clothConstraintStrokeAnchors.clear();
		this.scene.activeCamera?.inputs.attachElement();
		if (event && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		this.setState({ informationMessage: "Cloth constraints: left-drag paints; right-drag erases. Undo/Redo restores the complete stroke." });
		return true;
	}

	private _setTilePaintViewport(data: Record<string, unknown>): void {
		try {
			const current = getTilePaintViewport(this.scene);
			setTilePaintViewport(this.scene, { expectedRevision: current.revision, ...data }, { editor: this.props.editor });
			this._tilePaintBrushKey = null;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update Tile Paint viewport settings.");
		}
	}

	private _applyTilePaintAnchor(cell: [number, number]): void {
		const key = `${cell[0]}:${cell[1]}`;
		if (this._tilePaintStrokeAnchors.has(key)) {
			return;
		}
		const current = getTilePaintViewport(this.scene);
		try {
			applyTilePaintViewportStroke(
				this.scene,
				{
					expectedRevision: current.revision,
					expectedMapRevision: current.mapRevision,
					position: cell,
					mode: this._tilePaintStrokeMode ?? current.mode,
				},
				{ editor: this.props.editor }
			);
			this._tilePaintStrokeAnchors.add(key);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not apply Tile Paint stroke.");
		}
	}

	private _applyTilePalettePointOperation(cell: [number, number], operation: "fill" | "pick" | "select", endPosition?: [number, number]): void {
		const current = getTilePaintViewport(this.scene);
		try {
			applyTilePaletteOperation(
				this.scene,
				{
					expectedRevision: current.revision,
					expectedMapRevision: current.mapRevision,
					expectedPaletteRevision: current.palette.revision,
					operation,
					position: cell,
					endPosition,
				},
				{ editor: this.props.editor }
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : `Could not ${operation} Tile Palette cells.`);
		}
	}

	private _finishTilePaintStroke(event?: ReactPointerEvent<HTMLCanvasElement>): boolean {
		if (!this._tilePaintStrokeBefore) {
			return false;
		}
		const before = this._tilePaintStrokeBefore;
		const after = getTilePaintViewportSnapshot(this.scene, { mapNodeId: before.mapNodeId });
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			registerUndoRedo({
				undo: () => restoreTilePaintViewportSnapshot(this.scene, before, { editor: this.props.editor }),
				redo: () => restoreTilePaintViewportSnapshot(this.scene, after, { editor: this.props.editor }),
			});
		}
		this._tilePaintStrokeBefore = null;
		this._tilePaintStrokeMode = null;
		this._tilePaintStrokeAnchors.clear();
		this._tilePaintSelectionAnchor = null;
		this._tilePaintBrushKey = null;
		this.scene.activeCamera?.inputs.attachElement();
		if (event && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		this.setState({ informationMessage: "Tile Paint: left-drag paints; right-drag erases. Undo/Redo restores the complete stroke." });
		return true;
	}

	/** @internal */
	public _handleMouseLeave(): void {
		this._restoreCurrentMeshUnderPointer();
		this.lastPickingInfo = null;
		this._objectUnderPointer = null;
		if (!this._tilePaintStrokeBefore) {
			this._tilePaintHover = null;
			this._tilePaintBrushKey = null;
		}
		if (!this._clothConstraintStrokeBefore) {
			this._clothConstraintHover = null;
		}
	}

	private _mouseMoveTimeoutId: number = -1;

	private _handleMouseMove(x: number, y: number, event: ReactPointerEvent<HTMLCanvasElement>): void {
		this.lastPickingInfo = null;

		if (this._movePhysics2DJointDrag(x, y, event)) {
			return;
		}
		if (!this.state.pickingEnabled) {
			return;
		}
		if (this._movePhysics2DEffectorDrag(x, y, event)) {
			return;
		}
		if (this._moveSpriteShapeDrag(x, y, event)) {
			return;
		}
		const clothConstraintHit = this._getClothConstraintPaintHit(x, y);
		if (clothConstraintHit) {
			this._clothConstraintHover = { point: clothConstraintHit.point, normal: clothConstraintHit.normal };
			if (this._clothConstraintStrokeBefore && event.buttons !== 0) {
				this._applyClothConstraintPaintAnchor(clothConstraintHit);
			}
			this._restoreCurrentMeshUnderPointer();
			this._objectUnderPointer = null;
			return;
		}
		if (getClothConstraintPaintViewport(this.scene).enabled) {
			this._clothConstraintHover = null;
			this._restoreCurrentMeshUnderPointer();
			this._objectUnderPointer = null;
			return;
		}
		const tilePaintHit = this._getTilePaintHit(x, y);
		if (tilePaintHit) {
			if (!this._tilePaintHover || this._tilePaintHover[0] !== tilePaintHit.cell[0] || this._tilePaintHover[1] !== tilePaintHit.cell[1]) {
				this._tilePaintHover = tilePaintHit.cell;
				this._tilePaintBrushKey = null;
			}
			if (this._tilePaintStrokeBefore && !this._tilePaintSelectionAnchor && event.buttons !== 0) {
				this._applyTilePaintAnchor(tilePaintHit.cell);
			}
			this._restoreCurrentMeshUnderPointer();
			this._objectUnderPointer = null;
			return;
		}
		if (getTilePaintViewportEditorState(this.scene).enabled) {
			this._tilePaintHover = null;
			this._tilePaintBrushKey = null;
			this._restoreCurrentMeshUnderPointer();
			this._objectUnderPointer = null;
			return;
		}

		const pickingInfo = this._getPickingInfo(x, y);
		const pickedObject = pickingInfo.pickedSprite ?? pickingInfo.pickedMesh?._masterMesh ?? pickingInfo.pickedMesh;

		if (!pickedObject || (isNode(pickedObject) && isNodeLocked(pickedObject))) {
			this._restoreCurrentMeshUnderPointer();
			this._objectUnderPointer = null;
			return;
		}

		if (this._objectUnderPointer !== pickedObject) {
			this._restoreCurrentMeshUnderPointer();
			this._highlightCurrentMeshUnderPointer(pickedObject);

			this._objectUnderPointer = pickedObject;

			if (this._mouseMoveTimeoutId) {
				clearTimeout(this._mouseMoveTimeoutId);
			}

			this._mouseMoveTimeoutId = window.setTimeout(() => {
				this.forceUpdate();
			}, 200);
		}
	}

	private _handleMouseDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
		this.lastPickingInfo = null;

		if (!this.state.pickingEnabled) {
			return;
		}

		this._mouseDownPosition.set(event.clientX, event.clientY);
		if (this._beginPhysics2DJointDrag(event)) {
			return;
		}
		if (this._beginPhysics2DEffectorDrag(event)) {
			return;
		}
		if (this._beginSpriteShapeDrag(event)) {
			return;
		}
		const clothConstraintHit = this._getClothConstraintPaintHit(this.scene.pointerX, this.scene.pointerY);
		if (clothConstraintHit && (event.button === 0 || event.button === 2)) {
			event.preventDefault();
			event.stopPropagation();
			event.currentTarget.setPointerCapture?.(event.pointerId);
			this.scene.activeCamera?.inputs.detachElement();
			this._clothConstraintStrokeBefore = getClothConstraintSnapshot(this.scene, clothConstraintHit.cloth.id);
			this._clothConstraintStrokeMode = event.button === 2 ? "erase" : "paint";
			this._clothConstraintStrokeAnchors.clear();
			this._clothConstraintHover = { point: clothConstraintHit.point, normal: clothConstraintHit.normal };
			this._applyClothConstraintPaintAnchor(clothConstraintHit);
			return;
		}
		const tilePaintHit = this._getTilePaintHit(this.scene.pointerX, this.scene.pointerY);
		if (tilePaintHit && (event.button === 0 || event.button === 2)) {
			event.preventDefault();
			event.stopPropagation();
			event.currentTarget.setPointerCapture?.(event.pointerId);
			this.scene.activeCamera?.inputs.detachElement();
			const tileState = getTilePaintViewportEditorState(this.scene);
			if (event.button === 0 && (tileState.mode === "fill" || tileState.mode === "pick")) {
				const before = getTilePaintViewportSnapshot(this.scene, { mapNodeId: tilePaintHit.map.id });
				this._applyTilePalettePointOperation(tilePaintHit.cell, tileState.mode);
				const after = getTilePaintViewportSnapshot(this.scene, { mapNodeId: tilePaintHit.map.id });
				if (JSON.stringify(before) !== JSON.stringify(after)) {
					registerUndoRedo({
						undo: () => restoreTilePaintViewportSnapshot(this.scene, before, { editor: this.props.editor }),
						redo: () => restoreTilePaintViewportSnapshot(this.scene, after, { editor: this.props.editor }),
					});
				}
				return;
			}
			this._tilePaintStrokeBefore = getTilePaintViewportSnapshot(this.scene, { mapNodeId: tilePaintHit.map.id });
			this._tilePaintStrokeMode = event.button === 2 ? "erase" : tileState.mode === "erase" ? "erase" : "paint";
			this._tilePaintSelectionAnchor = event.button === 0 && tileState.mode === "select" ? tilePaintHit.cell : null;
			this._tilePaintStrokeAnchors.clear();
			this._tilePaintHover = tilePaintHit.cell;
			this._tilePaintBrushKey = null;
			if (!this._tilePaintSelectionAnchor) {
				this._applyTilePaintAnchor(tilePaintHit.cell);
			}
			return;
		}

		if (event.button === 2) {
			this.setState({
				rightClickedObject: this._objectUnderPointer,
			});
		}

		this._restoreCurrentMeshUnderPointer();

		if (event.button === 2 && this._objectUnderPointer) {
			this.scene.activeCamera?.inputs.detachElement();
			this._handleMouseUp(event);
		}

		this._objectUnderPointer = null;
	}

	private _getTouchSimulationOverlay(): ReactNode {
		const touch = this.state.touchSimulation;
		return (
			<div className="absolute bottom-3 right-3 z-10 w-36 rounded-md border border-primary/60 bg-background/90 p-2 shadow-lg backdrop-blur">
				<div className="mb-1 text-center text-[10px] font-medium text-muted-foreground">Touch Simulator</div>
				<div
					className="relative h-28 w-full touch-none overflow-hidden rounded border border-input bg-muted/50"
					onPointerDown={(event) => this._handleSimulatedTouchPointer(event, true)}
					onPointerMove={(event) => touch.pressed && this._handleSimulatedTouchPointer(event, true)}
					onPointerUp={(event) => this._handleSimulatedTouchPointer(event, false)}
					onPointerCancel={(event) => this._handleSimulatedTouchPointer(event, false)}
					aria-label="Touch simulation surface"
				>
					<div className="absolute left-1/2 top-1/2 h-px w-full bg-border/70" />
					<div className="absolute left-1/2 top-1/2 h-full w-px bg-border/70" />
					{touch.pressed && (
						<div
							className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/30"
							style={{ left: `${touch.x * 100}%`, top: `${touch.y * 100}%` }}
						/>
					)}
				</div>
				<div className="mt-1 text-center text-[10px] text-muted-foreground">
					{touch.pressed ? `${Math.round(touch.x * 100)}, ${Math.round(touch.y * 100)}` : "Hold and drag"}
				</div>
			</div>
		);
	}

	private _handleSimulatedTouchPointer(event: ReactPointerEvent<HTMLDivElement>, pressed: boolean): void {
		event.preventDefault();
		event.stopPropagation();
		if (pressed) {
			event.currentTarget.setPointerCapture?.(event.pointerId);
		}
		const [x, y] = toNormalizedTouchPosition(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
		try {
			const result = simulateInputTouch(this.scene, { pressed, x, y });
			if (!result.simulated) {
				throw new Error("The active Input Actions runtime did not accept the simulated touch.");
			}
			this.setState({ touchSimulation: { pressed, x: result.x, y: result.y } });
		} catch (error) {
			this.setState({ touchSimulation: { pressed: false, x, y } });
			if (pressed) {
				toast.error(error instanceof Error ? error.message : "Could not simulate touch input.");
			}
		}
	}

	private _handleDoubleClick(_event: MouseEvent<HTMLCanvasElement, globalThis.MouseEvent>): void {
		this.lastPickingInfo = null;

		if (!this.state.pickingEnabled || this.axis._axisMeshUnderPointer || getTilePaintViewportEditorState(this.scene).enabled) {
			return;
		}

		const pickingInfo = this._getPickingInfo(this.scene.pointerX, this.scene.pointerY);
		if (pickingInfo.pickedMesh || pickingInfo.pickedSprite) {
			this.focusObject(pickingInfo.pickedMesh ?? pickingInfo.pickedSprite);
		}
	}

	private _handleMouseUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
		this.lastPickingInfo = null;

		if (this._finishPhysics2DJointDrag(event)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (!this.state.pickingEnabled) {
			return;
		}
		if (this._finishPhysics2DEffectorDrag(event)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (this._finishSpriteShapeDrag(event)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (this._clothConstraintStrokeBefore) {
			const clothConstraintHit = this._getClothConstraintPaintHit(this.scene.pointerX, this.scene.pointerY);
			if (clothConstraintHit) {
				this._applyClothConstraintPaintAnchor(clothConstraintHit);
			}
			this._finishClothConstraintPaintStroke(event);
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (this._tilePaintStrokeBefore) {
			const tilePaintHit = this._getTilePaintHit(this.scene.pointerX, this.scene.pointerY);
			if (tilePaintHit) {
				if (this._tilePaintSelectionAnchor) {
					this._applyTilePalettePointOperation(this._tilePaintSelectionAnchor, "select", tilePaintHit.cell);
				} else {
					this._applyTilePaintAnchor(tilePaintHit.cell);
				}
			}
			this._finishTilePaintStroke(event);
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		if (event.altKey || event.button === 1) {
			return;
		}

		const distance = Vector2.Distance(this._mouseDownPosition, new Vector2(event.clientX, event.clientY));

		if (distance > 2) {
			return;
		}

		this.scene.meshes.forEach((mesh) => {
			if (mesh.geometry) {
				mesh.refreshBoundingInfo({
					applyMorph: true,
					applySkeleton: true,
				});
			}
		});

		const pickingInfo = this._getPickingInfo(this.scene.pointerX, this.scene.pointerY);
		const pickedMesh = pickingInfo.pickedMesh?._masterMesh ?? pickingInfo.pickedMesh;
		if (event.shiftKey && isMesh(pickedMesh) && pickedMesh.metadata?.type === "Ground" && pickingInfo.pickedPoint) {
			this._applyViewportTerrainBrush(pickedMesh, pickingInfo.pickedPoint, event.ctrlKey || event.metaKey ? "lower" : "raise");
			return;
		}
		if ((event.ctrlKey || event.metaKey) && isMesh(pickedMesh) && pickingInfo.faceId !== undefined && pickingInfo.faceId >= 0) {
			this._toggleViewportMeshComponent(pickedMesh, pickingInfo, event);
		}

		let effectivePickedObject = (pickingInfo.pickedSprite ?? pickingInfo.pickedMesh?._masterMesh ?? pickingInfo.pickedMesh) as Node;
		if (effectivePickedObject && isNode(effectivePickedObject) && !isNodeLocked(effectivePickedObject)) {
			const sceneLink = getRootSceneLink(effectivePickedObject);
			if (sceneLink) {
				effectivePickedObject = sceneLink;
			}

			if (effectivePickedObject.parent && isSpriteMapNode(effectivePickedObject.parent) && effectivePickedObject.parent.outputPlane === effectivePickedObject) {
				effectivePickedObject = effectivePickedObject.parent;
			}
		}

		this.lastPickingInfo = pickingInfo;

		if (effectivePickedObject) {
			if (event.shiftKey) {
				this.props.editor.layout.graph.addToSelectedNodes(effectivePickedObject);
			} else {
				this.props.editor.layout.graph.setSelectedNode(effectivePickedObject);
			}

			this.gizmo.setAttachedObject(effectivePickedObject);
			this.props.editor.layout.inspector.setEditedObject(effectivePickedObject);
			this.props.editor.layout.animations.setEditedObject(effectivePickedObject);
		}
	}

	private _applyViewportTerrainBrush(terrain: AbstractMesh, worldPoint: Vector3, mode: "raise" | "lower"): void {
		const mesh = terrain as any;
		const localPoint = Vector3.TransformCoordinates(worldPoint, mesh.getWorldMatrix().clone().invert());
		const settings = mesh.metadata?.terrainBrush ?? {};
		const radius = settings.radius ?? 100;
		const strength = settings.strength ?? 10;
		if (!(radius > 0) || !(strength >= 0)) {
			return;
		}
		const before = getMeshVertexData(this.scene, { nodeId: mesh.id });
		let after: any = null;
		registerUndoRedo({
			executeRedo: true,
			undo: () =>
				setMeshVertexData(
					this.scene,
					{ nodeId: mesh.id, positions: before.positions, normals: before.normals, uvs: before.uvs, indices: before.indices },
					{ editor: this.props.editor }
				),
			redo: () => {
				if (!after) {
					sculptTerrain(this.scene, { nodeId: mesh.id, center: [localPoint.x, localPoint.z], radius, strength, mode }, { editor: this.props.editor });
					after = getMeshVertexData(this.scene, { nodeId: mesh.id });
				} else {
					setMeshVertexData(
						this.scene,
						{ nodeId: mesh.id, positions: after.positions, normals: after.normals, uvs: after.uvs, indices: after.indices },
						{ editor: this.props.editor }
					);
				}
			},
		});
		this.setState({ informationMessage: `Terrain ${mode}: Shift-click to raise; Ctrl/Cmd+Shift-click to lower.` });
	}

	private _toggleViewportMeshComponent(mesh: AbstractMesh, pickingInfo: PickingInfo, event: MouseEvent<HTMLCanvasElement, globalThis.MouseEvent>): void {
		const faceId = pickingInfo.faceId!;
		const data = getMeshVertexData(this.scene, { nodeId: mesh.id });
		const triangle = data.indices.slice(faceId * 3, faceId * 3 + 3) as number[];
		if (triangle.length !== 3) {
			return;
		}
		let mode: "vertex" | "edge" | "face" = "face";
		let component = faceId;
		const point = pickingInfo.pickedPoint;
		if (event.altKey) {
			mode = "edge";
		} else if (event.shiftKey) {
			mode = "vertex";
		}
		if (mode === "vertex" && point) {
			component = triangle.reduce((nearest, vertex) => {
				const nearestPoint = Vector3.TransformCoordinates(Vector3.FromArray(data.positions, nearest * 3), mesh.getWorldMatrix());
				const vertexPoint = Vector3.TransformCoordinates(Vector3.FromArray(data.positions, vertex * 3), mesh.getWorldMatrix());
				return Vector3.DistanceSquared(vertexPoint, point) < Vector3.DistanceSquared(nearestPoint, point) ? vertex : nearest;
			}, triangle[0]);
		}
		if (mode === "edge" && point) {
			const topology = getMeshTopology(this.scene, { nodeId: mesh.id });
			const edges = [
				[triangle[0], triangle[1]],
				[triangle[1], triangle[2]],
				[triangle[2], triangle[0]],
			] as [number, number][];
			const closest = edges.reduce(
				(nearest, edge) => (this._distanceToMeshEdge(mesh, data.positions, edge, point) < this._distanceToMeshEdge(mesh, data.positions, nearest, point) ? edge : nearest),
				edges[0]
			);
			const normalized: [number, number] = closest[0] < closest[1] ? closest : [closest[1], closest[0]];
			component = topology.edges.findIndex((edge: [number, number]) => edge[0] === normalized[0] && edge[1] === normalized[1]);
			if (component < 0) {
				return;
			}
		}
		const selection = getMeshSelection(this.scene, { nodeId: mesh.id });
		const indices = selection.mode === mode ? [...selection.indices] : [];
		const index = indices.indexOf(component);
		if (index === -1) {
			indices.push(component);
		} else {
			indices.splice(index, 1);
		}
		setMeshSelection(this.scene, { nodeId: mesh.id, mode, indices }, { editor: this.props.editor });
	}

	private _distanceToMeshEdge(mesh: AbstractMesh, positions: number[], edge: [number, number], point: Vector3): number {
		const first = Vector3.TransformCoordinates(Vector3.FromArray(positions, edge[0] * 3), mesh.getWorldMatrix());
		const second = Vector3.TransformCoordinates(Vector3.FromArray(positions, edge[1] * 3), mesh.getWorldMatrix());
		const direction = second.subtract(first);
		const lengthSquared = direction.lengthSquared();
		const amount = lengthSquared ? Math.min(1, Math.max(0, Vector3.Dot(point.subtract(first), direction) / lengthSquared)) : 0;
		return Vector3.DistanceSquared(point, first.add(direction.scale(amount)));
	}

	public _pickingDecalMeshPredicate(m: AbstractMesh): boolean {
		if (!m.isVisible || !m.isEnabled() || !m.metadata?.decal) {
			return false;
		}

		if (this._lastPickedDecal) {
			return m !== this._lastPickedDecal;
		}

		return true;
	}

	public _pickingMeshPredicate(m: AbstractMesh): boolean {
		return !m._masterMesh && !isCollisionMesh(m) && !isCollisionInstancedMesh(m) && m.isVisible && m.isEnabled();
	}

	private _getPickingInfo(x: number, y: number): PickingInfo {
		const decalPick = this.scene.pick(x, y, (m) => this._pickingDecalMeshPredicate(m), false);
		const meshPick = this.scene.pick(x, y, (m) => this._pickingMeshPredicate(m), false);
		const spritePick = this.scene.pickSprite(x, y, (s) => isSprite(s), false);

		this._lastPickedDecal = null;

		let pickingInfo = meshPick;
		if (decalPick?.pickedPoint && meshPick?.pickedPoint) {
			const distance = Vector3.Distance(decalPick.pickedPoint, meshPick.pickedPoint);
			const zOffset = decalPick.pickedMesh?.material?.zOffset ?? 0;

			if (distance <= zOffset + 1) {
				pickingInfo = decalPick;
				this._lastPickedDecal = decalPick.pickedMesh;
			}
		}

		if (spritePick?.pickedSprite) {
			if (!pickingInfo.pickedMesh) {
				pickingInfo = spritePick;
			} else if (pickingInfo.ray && spritePick.ray) {
				const spriteDistance = Vector2.Distance(spritePick.ray.origin, spritePick.pickedPoint!);
				const meshDistance = Vector3.Distance(pickingInfo.ray.origin, pickingInfo.pickedPoint!);

				if (spriteDistance <= meshDistance) {
					pickingInfo = spritePick;
				}
			}
		}

		return pickingInfo;
	}

	private _resetPointerContextInfo(): void {
		if (this.state.rightClickedObject) {
			this.setState({
				rightClickedObject: null,
			});

			this.scene.activeCamera?.inputs.attachElement();
		}
	}

	private _highlightCurrentMeshUnderPointer(pickedObject: AbstractMesh | Sprite): void {
		if (isSprite(pickedObject)) {
			pickedObject.overrideColor ??= new Color4(1, 1, 1, 1);
			Tween.create(pickedObject, 0.1, {
				overrideColor: new Color4(0.5, 0.5, 0.5, 1.0),
			});
		}
	}

	private _restoreCurrentMeshUnderPointer(): void {
		const objectUnderPointer = this._objectUnderPointer;

		if (objectUnderPointer) {
			if (isSprite(objectUnderPointer)) {
				Tween.killTweensOf(objectUnderPointer);
				Tween.create(objectUnderPointer, 0.1, {
					overrideColor: new Color4(1.0, 1.0, 1.0, 1.0),
				});
			}
		}
	}

	private _getToolbar(): ReactNode {
		return (
			<div className="absolute top-0 left-0 w-full h-12 z-10">
				<div className="flex justify-between items-center gap-4 h-full bg-background/95 w-full px-2 py-1">
					{
						this.play?.state.playing && <div /> // For justify between
					}

					{!this.play?.state.playing && this._getEditToolbar()}

					<div className="flex gap-2 items-center h-10">
						<EditorPreviewPlayComponent
							ref={(r) => (this.play = r!)}
							editor={this.props.editor}
							enabled={this.state.playEnabled}
							onRestart={() => this.play.restart()}
						/>
					</div>
				</div>
			</div>
		);
	}

	public updateGizmoSnapPreferences(prefs: IGizmoSnapPreferences): void {
		const normalized = roundGizmoSnapSteps(prefs);
		this.gizmo?.setSnapPreferences(normalized);
		this.setState({
			gizmoSnap: normalized,
		});
	}

	private _getEditToolbar(): ReactNode {
		const tilePaint = this.scene ? getTilePaintViewportEditorState(this.scene) : null;
		const clothPaint = this.scene ? getClothConstraintPaintViewport(this.scene) : null;
		return (
			<div className="flex flex-wrap gap-2 items-center h-10">
				<TooltipProvider>
					<Select value={this.scene?.activeCamera?.id} onOpenChange={(o) => o && this.forceUpdate()} onValueChange={(v) => this._switchToCameraById(v)}>
						<SelectTrigger className="w-36 border-none bg-muted/50">
							<SelectValue placeholder="Select Value..." />
						</SelectTrigger>
						<SelectContent>
							{this.scene?.cameras.map((c) => (
								<SelectItem key={c.id} value={c.id}>
									{c.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					<Separator orientation="vertical" className="mx-1 h-[24px]" />

					<ToolbarRadioGroup
						value={this.state.activeGizmo === "none" ? "select" : this.state.activeGizmo}
						onValueChange={(value) => {
							if (value === "select") {
								this.setActiveGizmo("none");
							} else {
								this.setActiveGizmo(value as "position" | "rotation" | "scaling");
							}
						}}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<ToolbarRadioGroupItem value="select" className={this.state.activeGizmo === "none" ? "bg-primary/20" : ""}>
									<GiArrowCursor className="h-4 w-4" />
								</ToolbarRadioGroupItem>
							</TooltipTrigger>
							<TooltipContent>Select mode</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<ToolbarRadioGroupItem value="position" className={this.state.activeGizmo === "position" ? "bg-primary/20" : ""}>
									<LuMove3D height={16} />
								</ToolbarRadioGroupItem>
							</TooltipTrigger>
							<TooltipContent>Toggle position gizmo</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<ToolbarRadioGroupItem value="rotation" className={this.state.activeGizmo === "rotation" ? "bg-primary/20" : ""}>
									<LuRotate3D height={16} />
								</ToolbarRadioGroupItem>
							</TooltipTrigger>
							<TooltipContent>Toggle rotation gizmo</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<ToolbarRadioGroupItem value="scaling" className={this.state.activeGizmo === "scaling" ? "bg-primary/20" : ""}>
									<LuScale3D height={16} />
								</ToolbarRadioGroupItem>
							</TooltipTrigger>
							<TooltipContent>Toggle scaling gizmo</TooltipContent>
						</Tooltip>
					</ToolbarRadioGroup>

					<Separator orientation="vertical" className="mx-1 h-[24px]" />

					<Tooltip>
						<TooltipTrigger asChild>
							<Toggle
								pressed={clothPaint?.enabled ?? false}
								disabled={!clothPaint?.enabled}
								className={clothPaint?.enabled ? "!px-2 !py-2 bg-primary/20" : "!px-2 !py-2"}
								onPressedChange={() => this._setClothConstraintPaintViewport({ enabled: false })}
							>
								<LuPaintbrush className="h-4 w-4" />
							</Toggle>
						</TooltipTrigger>
						<TooltipContent>{clothPaint?.enabled ? "Stop Cloth constraint painting" : "Activate Cloth painting from the Scene Inspector"}</TooltipContent>
					</Tooltip>
					{clothPaint?.enabled && (
						<>
							<Toggle
								pressed={clothPaint.channel === "maxDistance"}
								className="!px-2 !py-2 text-[10px]"
								onPressedChange={() => this._setClothConstraintPaintViewport({ channel: "maxDistance" satisfies ClothConstraintChannel })}
							>
								Motion
							</Toggle>
							<Toggle
								pressed={clothPaint.channel === "surfacePenetration"}
								className="!px-2 !py-2 text-[10px]"
								onPressedChange={() => this._setClothConstraintPaintViewport({ channel: "surfacePenetration" satisfies ClothConstraintChannel })}
							>
								Surface
							</Toggle>
							<div className="rounded bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground">
								R {clothPaint.radius} cm · V {clothPaint.value} cm
							</div>
						</>
					)}

					<Separator orientation="vertical" className="mx-1 h-[24px]" />

					<Tooltip>
						<TooltipTrigger asChild>
							<Toggle
								pressed={tilePaint?.enabled ?? false}
								disabled={!tilePaint?.enabled}
								className={tilePaint?.enabled ? "!px-2 !py-2 bg-primary/20" : "!px-2 !py-2"}
								onPressedChange={() => this._setTilePaintViewport({ enabled: false })}
							>
								<LuPaintbrush className="h-4 w-4" />
							</Toggle>
						</TooltipTrigger>
						<TooltipContent>{tilePaint?.enabled ? "Stop Tile Paint viewport" : "Activate Tile Paint from a Sprite Map palette Inspector"}</TooltipContent>
					</Tooltip>
					{tilePaint?.enabled && (
						<>
							<Tooltip>
								<TooltipTrigger asChild>
									<Toggle pressed={tilePaint.mode === "paint"} className="!px-2 !py-2" onPressedChange={() => this._setTilePaintViewport({ mode: "paint" })}>
										<LuPaintbrush className="h-4 w-4" />
									</Toggle>
								</TooltipTrigger>
								<TooltipContent>Paint tiles (left drag)</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Toggle pressed={tilePaint.mode === "erase"} className="!px-2 !py-2" onPressedChange={() => this._setTilePaintViewport({ mode: "erase" })}>
										<LuEraser className="h-4 w-4" />
									</Toggle>
								</TooltipTrigger>
								<TooltipContent>Erase tiles (or right drag)</TooltipContent>
							</Tooltip>
							{(["fill", "pick", "select"] as const).map((mode) => (
								<Button
									key={mode}
									size="sm"
									variant={tilePaint.mode === mode ? "default" : "ghost"}
									className="h-8 px-2 text-[10px] capitalize"
									onClick={() => this._setTilePaintViewport({ mode })}
								>
									{mode}
								</Button>
							))}
							<div className="rounded bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground">
								{tilePaint.target} · L{tilePaint.layer} · {tilePaint.brushSize[0]}×{tilePaint.brushSize[1]}
							</div>
						</>
					)}

					<Separator orientation="vertical" className="mx-1 h-[24px]" />

					<EditorPreviewGizmoSettings editor={this.props.editor} />

					<Separator orientation="vertical" className="mx-1 h-[24px]" />

					<Tooltip>
						<TooltipTrigger asChild>
							<Toggle
								className={this.scene?.forceWireframe ? "!px-2 !py-2 bg-primary/20" : "!px-2 !py-2"}
								pressed={this.scene?.forceWireframe}
								onPressedChange={() => {
									this.scene.forceWireframe = !this.scene.forceWireframe;
									this.forceUpdate();
								}}
							>
								<GiWireframeGlobe className="w-6 h-6 scale-125" strokeWidth={1} color="white" />
							</Toggle>
						</TooltipTrigger>
						<TooltipContent>Toggle wireframe</TooltipContent>
					</Tooltip>

					<Separator orientation="vertical" className="mx-1 h-[24px]" />

					<Select
						value={this.gizmo?.getCoordinateMode().toString()}
						onValueChange={(v) => {
							this.gizmo?.setCoordinatesMode(parseInt(v));
							this.forceUpdate();
						}}
					>
						<SelectTrigger className="w-32 border-none bg-muted/50">
							<SelectValue placeholder="Select Value..." />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={GizmoCoordinatesMode.World.toString()}>World</SelectItem>
							<SelectItem value={GizmoCoordinatesMode.Local.toString()}>Local</SelectItem>
						</SelectContent>
					</Select>

					<Separator orientation="vertical" className="mx-1 h-[24px]" />

					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" className="px-1 py-1 w-9 h-9">
								<GiTeapot className="w-6 h-6" strokeWidth={1} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent onClick={() => this.forceUpdate()}>
							<DropdownMenuLabel className="text-center text-lg">Options</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => (this.axis.enabled ? this.axis.stop() : this.axis.start())}>
								{this.axis?.enabled && <FaCheck className="w-4 h-4" />} Axis Helper
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => (this.icons.enabled ? this.icons.stop() : this.icons.start())}>
								{this.icons?.enabled && <FaCheck className="w-4 h-4" />} Icons Helper
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => (this.scene.postProcessesEnabled = !this.scene.postProcessesEnabled)}>
								{this.scene?.postProcessesEnabled && <FaCheck className="w-4 h-4" />} Post-processes enabled
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => (this.scene.texturesEnabled = !this.scene.texturesEnabled)}>
								{this.scene?.texturesEnabled && <FaCheck className="w-4 h-4" />} Textures enabled
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => (this.scene.lightsEnabled = !this.scene.lightsEnabled)}>
								{this.scene?.lightsEnabled && <FaCheck className="w-4 h-4" />} Lights enabled
							</DropdownMenuItem>
							<DropdownMenuItem
								className="flex gap-2 items-center"
								onClick={() => {
									this.scene.shadowsEnabled = !this.scene.shadowsEnabled;
									this.scene.renderTargetsEnabled = this.scene.shadowsEnabled;
								}}
							>
								{this.scene?.shadowsEnabled && <FaCheck className="w-4 h-4" />} Shadows enabled
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => (this.scene.particlesEnabled = !this.scene.particlesEnabled)}>
								{this.scene?.particlesEnabled && <FaCheck className="w-4 h-4" />} Particles enabled
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="text-center text-lg">Dimensions</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => this.setFixedDimensions("720p")}>
								{this.state.fixedDimensions === "720p" && <FaCheck className="w-4 h-4" />} 720p
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => this.setFixedDimensions("1080p")}>
								{this.state.fixedDimensions === "1080p" && <FaCheck className="w-4 h-4" />} 1080p
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => this.setFixedDimensions("4k")}>
								{this.state.fixedDimensions === "4k" && <FaCheck className="w-4 h-4" />} 4K (UHD)
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => this.setFixedDimensions("fit")}>
								{this.state.fixedDimensions === "fit" && <FaCheck className="w-4 h-4" />} Fit
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="text-center text-lg">Scaling</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => this.engine?.setHardwareScalingLevel(2)}>
								{this.engine?.getHardwareScalingLevel() === 2 && <FaCheck className="w-4 h-4" />} 50%
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => this.engine?.setHardwareScalingLevel(1)}>
								{this.engine?.getHardwareScalingLevel() === 1 && <FaCheck className="w-4 h-4" />} 100%
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => this.engine?.setHardwareScalingLevel(0.5)}>
								{this.engine?.getHardwareScalingLevel() === 0.5 && <FaCheck className="w-4 h-4" />} 200%
							</DropdownMenuItem>
							<DropdownMenuItem className="flex gap-2 items-center" onClick={() => this.engine?.setHardwareScalingLevel(1 / devicePixelRatio)}>
								{this.engine?.getHardwareScalingLevel() === 1 / devicePixelRatio && <FaCheck className="w-4 h-4" />} Default ({(devicePixelRatio * 100).toFixed(0)}
								%)
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>

					<DropdownMenu onOpenChange={(o) => this.setState({ showStatsValues: o })}>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" className="px-1 py-1 w-9 h-9">
								<IoIosStats className="w-6 h-6" strokeWidth={1} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent className="w-72" onClick={() => this.forceUpdate()}>
							<DropdownMenuLabel>Statistics</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="flex flex-col gap-1">
								<StatRow label="Average FPS" value={this.state.statsValues?.averageFPS} />
								<StatRow label="Instantaneous FPS" value={this.state.statsValues?.instantaneousFPS} />
								<StatRow label="Draw Calls" value={this.state.statsValues?.drawCalls} />
							</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="flex flex-col gap-1">
								<StatRow label="Active Faces" value={this.state.statsValues?.activeFaces} />
								<StatRow label="Active Meshes" value={this.state.statsValues?.activeMeshes} />
								<StatRow label="Active Indices" value={this.state.statsValues?.activeIndices} />
								<StatRow label="Active Bones" value={this.state.statsValues?.activeBones} />
								<StatRow label="Active Particles" value={this.state.statsValues?.activeParticles} />
							</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="flex flex-col gap-1">
								<StatRow label="Total Meshes" value={this.state.statsValues?.totalMeshes} />
								<StatRow label="Total Vertices" value={this.state.statsValues?.totalVertices} />
								<StatRow label="Total Materials" value={this.state.statsValues?.totalMaterials} />
								<StatRow label="Total Textures" value={this.state.statsValues?.totalTextures} />
								<StatRow label="Total Lights" value={this.state.statsValues?.totalLights} />
							</DropdownMenuLabel>
						</DropdownMenuContent>
					</DropdownMenu>
				</TooltipProvider>
			</div>
		);
	}

	/**
	 * Makes the given camera the editor's active camera, saving the rendering configurations of the
	 * previously active camera and restoring those associated to the new one. This is the supported way
	 * to switch cameras so that per-camera post-processes are set up correctly (and exported for runtime).
	 * @param camera defines the reference to the camera to activate.
	 */
	public switchToCamera(camera: Camera): void {
		this._switchToCameraById(camera.id);
	}

	private _switchToCameraById(id: string): void {
		if (this.scene.metadata?.babylonEditorActiveCameraStack) {
			this.scene.metadata.babylonEditorActiveCameraStack = null;
			restoreCameraStackBaseline(this.scene as any);
		}
		const camera = this.scene.cameras.find((c) => c.id === id);
		if (!camera) {
			return;
		}

		if (this.scene.activeCamera) {
			saveRenderingConfigurationForCamera(this.scene.activeCamera);
		}

		this.scene.activeCamera?.detachControl();

		this.scene.activeCamera = camera;
		if (!isNodeLocked(camera)) {
			this.scene.activeCamera?.attachControl(true);
		}

		_GetAudioEngine(null).listener.attach(camera);

		disposeSSAO2RenderingPipeline();
		disposeVLSPostProcess(this.props.editor);
		disposeSSRRenderingPipeline();
		disposeMotionBlurPostProcess();
		disposeDefaultRenderingPipeline();
		disposeTAARenderingPipeline();
		disposeCustomColorPostProcess();

		const ssao2Pipeline = ssaoRenderingPipelineCameraConfigurations.get(camera);
		if (ssao2Pipeline) {
			parseSSAO2RenderingPipeline(this.props.editor, ssao2Pipeline);
		}

		const vlsPostProcess = vlsPostProcessCameraConfigurations.get(camera);
		if (vlsPostProcess) {
			parseVLSPostProcess(this.props.editor, vlsPostProcess);
		}

		const ssrPipeline = ssrRenderingPipelineCameraConfigurations.get(camera);
		if (ssrPipeline) {
			parseSSRRenderingPipeline(this.props.editor, ssrPipeline);
		}

		const motionBlurPostProcess = motionBlurPostProcessCameraConfigurations.get(camera);
		if (motionBlurPostProcess) {
			parseMotionBlurPostProcess(this.props.editor, motionBlurPostProcess);
		}

		const defaultRenderingPipeline = defaultPipelineCameraConfigurations.get(camera);
		if (defaultRenderingPipeline) {
			parseDefaultRenderingPipeline(this.props.editor, defaultRenderingPipeline);
		}

		const taaRenderingPipeline = taaPipelineCameraConfigurations.get(camera);
		if (taaRenderingPipeline) {
			parseTAARenderingPipeline(this.props.editor, taaRenderingPipeline);
		}

		const customColorPostProcess = customColorPostProcessCameraConfigurations.get(camera);
		if (customColorPostProcess) {
			parseCustomColorPostProcess(this.props.editor, customColorPostProcess);
		}

		this.scene.lights.forEach((light) => {
			light.getShadowGenerators()?.forEach((shadowGenerator) => {
				const shadowMap = shadowGenerator.getShadowMap();
				if (shadowMap) {
					shadowMap.activeCamera = camera;
				}
			});
		});

		this.props.editor.layout.inspector.forceUpdate();

		if (this._previewCamera === camera) {
			this.setCameraPreviewActive(null);
		}
	}

	/**
	 * Sets the currently active gizmo. Set "none" to deactivate the gizmo.
	 * @param gizmo defines the type of gizmo to activate.
	 */
	public setActiveGizmo(gizmo: "position" | "rotation" | "scaling" | "none"): void {
		if (this.state.activeGizmo === gizmo) {
			gizmo = "none";
		}

		this.gizmo.setGizmoType(gizmo);
		this.setState({ activeGizmo: gizmo });
	}

	public async importSceneFile(absolutePath: string, useCloudConverter: boolean): Promise<ISceneLoaderAsyncResult | null> {
		const sourceExtension = extname(absolutePath).toLowerCase();
		if (useCloudConverter) {
			switch (sourceExtension) {
				case ".fbx":
				case ".blend":
					let progressRef: EditorPreviewConvertProgress;
					this.setState({
						informationMessage: <EditorPreviewConvertProgress absolutePath={absolutePath} ref={(r) => (progressRef = r!)} />,
					});

					const newAbsolutePath = await tryConvertSceneFile(absolutePath, (value) => progressRef?.setState({ value }));

					if (newAbsolutePath) {
						absolutePath = newAbsolutePath;
					} else {
						useCloudConverter = false;

						toast.error("Failed to convert the file. Fallback on local Assimp loader.");
						this.setState({
							informationMessage: null,
						});
					}
					break;
			}
		}
		if (sourceExtension === ".blend" && extname(absolutePath).toLowerCase() === ".blend") {
			try {
				absolutePath = await tryConvertBlendFileLocally(absolutePath);
			} catch (error) {
				console.error(error);
				toast.error(error instanceof Error ? error.message : String(error));
				this.setState({ informationMessage: null });
				return null;
			}
		}

		this.setState({ informationMessage: `Importing scene "${basename(absolutePath)}"...` });
		const result = await loadImportedSceneFile(this.scene, absolutePath);
		this.setState({ informationMessage: "" });

		return result;
	}

	private async _handleDrop(ev: React.DragEvent<HTMLCanvasElement>): Promise<void> {
		const assets = ev.dataTransfer.getData("assets");
		if (assets) {
			return this._handleAssetsDropped(ev);
		}

		const graphNode = ev.dataTransfer.getData("graph/node");
		if (graphNode) {
			return this._handleGraphNodesDropped(ev);
		}

		const sprite = ev.dataTransfer.getData("sprite");
		if (sprite) {
			return this._handleSpritesDropped(ev);
		}
	}

	private _handleGraphNodesDropped(ev: React.DragEvent<HTMLCanvasElement>): void {
		const pick = this.scene.pick(ev.nativeEvent.offsetX, ev.nativeEvent.offsetY, (m) => !m._masterMesh && !isCollisionMesh(m) && !isCollisionInstancedMesh(m), false);
		const mesh = pick.pickedMesh?._masterMesh ?? pick.pickedMesh;

		if (!mesh || !pick.pickedPoint) {
			return;
		}

		const pickedPoint = pick.pickedPoint.clone();

		const nodesToMove = this.props.editor.layout.graph.getSelectedNodes();
		const oldPositionsMap = new Map<unknown, Vector3>();

		nodesToMove.forEach((n) => {
			if (isAnyTransformNode(n.nodeData) || isAbstractMesh(n.nodeData)) {
				oldPositionsMap.set(n.nodeData, n.nodeData.getAbsolutePosition().clone());
			} else if (isSprite(n.nodeData)) {
				oldPositionsMap.set(n.nodeData, n.nodeData.position.clone());
			}
		});

		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				nodesToMove.forEach((n) => {
					if (oldPositionsMap.has(n.nodeData)) {
						if (isAnyTransformNode(n.nodeData) || isAbstractMesh(n.nodeData)) {
							n.nodeData.setAbsolutePosition(oldPositionsMap.get(n.nodeData)!);
						} else if (isSprite(n.nodeData)) {
							n.nodeData.position.copyFrom(oldPositionsMap.get(n.nodeData)!);
						}
					}
				});
			},
			redo: () => {
				nodesToMove.forEach((n) => {
					if (isAnyTransformNode(n.nodeData) || isAbstractMesh(n.nodeData)) {
						n.nodeData.setAbsolutePosition(pickedPoint);
					} else if (isSprite(n.nodeData)) {
						n.nodeData.position.copyFrom(pickedPoint);
					}
				});
			},
		});
	}

	private _handleSpritesDropped(ev: React.DragEvent<HTMLCanvasElement>): void {
		const data = JSON.parse(ev.dataTransfer.getData("sprite"));
		const spriteNode = this.scene.getNodeById(data.spriteNodeId);

		if (!isSpriteManagerNode(spriteNode) || !spriteNode.spriteManager) {
			return;
		}

		const pick = this.scene.pick(ev.nativeEvent.offsetX, ev.nativeEvent.offsetY, (m) => !m._masterMesh && !isCollisionMesh(m) && !isCollisionInstancedMesh(m), false);

		const sprite = new Sprite(`sprite-${spriteNode.spriteManager.sprites.length}`, spriteNode.spriteManager);
		sprite.size = 100;
		sprite.uniqueId = UniqueNumber.Get();

		if (data.cellRef) {
			sprite.cellRef = data.cellRef;

			sprite.width = spriteNode.atlasJson.frames[data.cellRef].sourceSize.w;
			sprite.height = spriteNode.atlasJson.frames[data.cellRef].sourceSize.h;
		} else if (data.cellIndex !== undefined) {
			sprite.cellIndex = data.cellIndex;
		}

		if (pick.pickedPoint) {
			sprite.position.copyFrom(pick.pickedPoint);
		}

		this.gizmo.setAttachedObject(sprite);
		this.props.editor.layout.graph.refresh();
	}

	private _handleAssetsDropped(ev: React.DragEvent<HTMLCanvasElement>): void {
		const absolutePaths = this.props.editor.layout.assets.state.selectedKeys;

		absolutePaths.forEach(async (absolutePath) => {
			await waitNextAnimationFrame();

			const pick = this.scene.pick(ev.nativeEvent.offsetX, ev.nativeEvent.offsetY, (m) => !m._masterMesh && !isCollisionMesh(m) && !isCollisionInstancedMesh(m), false);
			const mesh = pick.pickedMesh?._masterMesh ?? pick.pickedMesh;
			if (absolutePath.toLowerCase().endsWith(".audio-generator.json")) {
				void applySoundAsset(this.props.editor, mesh ?? this.scene, absolutePath).then(() => this.props.editor.layout.graph.refresh());
				return;
			}

			const extension = extname(absolutePath).toLowerCase();
			switch (extension) {
				case ".abc":
					try {
						const { instantiateAlembicAsset } = await import("../../mcp/assets/alembic");
						const result = await instantiateAlembicAsset(this.scene, { path: absolutePath }, { editor: this.props.editor });
						if (pick.pickedPoint) {
							const root = this.scene.getNodeById(result.rootNodeId);
							if (root && "position" in root) {
								(root as any).position.addInPlace(pick.pickedPoint);
							}
						}
					} catch (error) {
						toast.error(error instanceof Error ? error.message : String(error));
					}
					break;

				case ".x":
				case ".b3d":
				case ".dae":
				case ".glb":
				case ".gltf":
				case ".fbx":
				case ".stl":
				case ".lwo":
				case ".dxf":
				case ".obj":
				case ".3ds":
				case ".ms3d":
				case ".blend":
				case ".babylon":
					this.importSceneFile(absolutePath, ev.shiftKey).then((result) => {
						if (pick.pickedPoint) {
							result?.meshes.forEach((m) => !m.parent && m.position.addInPlace(pick.pickedPoint!));
							result?.transformNodes.forEach((t) => !t.parent && t.position.addInPlace(pick.pickedPoint!));
						}
					});
					break;

				case ".env":
				case ".jpg":
				case ".png":
				case ".webp":
				case ".bmp":
				case ".jpeg":
					applyTextureAssetToObject(this.props.editor, mesh ?? this.scene, absolutePath);
					break;

				case ".material":
					applyMaterialAssetToObject(this.props.editor, mesh, absolutePath);
					break;

				case ".scene":
					createSceneLink(this.props.editor, absolutePath).then((node) => {
						this.setRenderScene(true);

						if (pick.pickedPoint) {
							node?.position.addInPlace(pick.pickedPoint);
						}
					});
					break;

				// case ".gui":
				// 	if (this.props.editor.state.enableExperimentalFeatures) {
				// 		applyImportedGuiFile(this.props.editor, absolutePath).then(() => {
				// 			this.props.editor.layout.graph.refresh();
				// 		});
				// 	}
				// 	break;

				case ".mp3":
				case ".ogg":
				case ".wav":
				case ".wave":
					applySoundAsset(this.props.editor, mesh ?? this.scene, absolutePath).then(() => {
						this.props.editor.layout.graph.refresh();
					});
					break;

				case ".npss":
					if (mesh) {
						loadImportedParticleSystemFile(this.props.editor.layout.preview.scene, mesh, absolutePath).then(() => {
							this.props.editor.layout.graph.refresh();
						});
					}
					break;
			}
		});
	}
}
