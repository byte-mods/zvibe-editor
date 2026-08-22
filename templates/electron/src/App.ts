import { Scene } from "@babylonjs/core/scene";
// Registers TransformNode.Parse and keeps InstancedMesh side effects: the .pure
// loader chain never installs them, and any scene containing transform nodes or
// instanced meshes fails to parse ("loadAssets of unknown") without this.
import { RegisterTransformNode } from "@babylonjs/core/Meshes/transformNode.pure";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SceneLoaderFlags } from "@babylonjs/core/Loading/sceneLoaderFlags";
import { FileToolsOptions } from "@babylonjs/core/Misc/fileTools";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";

import HavokPhysics from "@babylonjs/havok";

import "@babylonjs/core/Loading/loadingScreen";
import "@babylonjs/core/Loading/Plugins/babylonFileLoader";

import "@babylonjs/core/Cameras/camera";
import "@babylonjs/core/Cameras/universalCamera";

import "@babylonjs/core/Meshes/groundMesh";

import "@babylonjs/core/Lights/directionalLight";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";

import "@babylonjs/core/Materials/PBR/pbrMaterial";
import "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Materials/imageProcessingConfiguration";

import "@babylonjs/core/XR/features/WebXRDepthSensing";

import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";

import "@babylonjs/core/Materials/Textures/cubeTexture";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";

import "@babylonjs/core/Physics";

// Register every Babylon Materials Library type used by scenes authored in the editor.
// This includes terrain, water, triplanar, and the procedural library materials.
import "@babylonjs/materials";

import {
	getAssetStreamingBuildPlan,
	loadScene,
	normalizeAssetStreamingSettings,
	normalizePlatformPlayerSettings,
	PlatformPlayerRuntime,
	rewriteAssetUrlForStreaming,
	type AssetStreamingHost,
	type IAssetStreamingBuildPlan,
} from "babylonjs-editor-tools";

import "./style.css";

/**
 * We import the map of all scripts attached to objects in the editor.
 * This will allow the loader from `babylonjs-editor-tools` to attach the scripts to the
 * loaded objects (scene, meshes, transform nodes, lights, cameras, etc.).
 */
import { scriptsMap } from "./scripts";

export class App {
	private _canvas: HTMLCanvasElement;
	private _engine: Engine | null = null;
	private _scene: Scene | null = null;
	private _platformPlayerRuntime: PlatformPlayerRuntime | null = null;
	private _assetStreamingPlan: IAssetStreamingBuildPlan | null = null;
	private _previousAssetUrlPreprocessor: ((url: string) => string) | null = null;
	private _assetUrlPreprocessor: ((url: string) => string) | null = null;

	public constructor() {
		const canvasElement = document.getElementById("canvas") as HTMLCanvasElement;
		if (!canvasElement) {
			throw new Error("Canvas element not found");
		}
		this._canvas = canvasElement;
	}

	public async init(): Promise<void> {
		const parameters = new URLSearchParams(window.location.search);
		const authoredPlatformSettings = this._readQueryJson(parameters, "zvibePlatformPlayerSettings");
		this._platformPlayerRuntime = new PlatformPlayerRuntime(normalizePlatformPlayerSettings(authoredPlatformSettings), {
			imeTarget: document,
		});
		this._platformPlayerRuntime.start();
		this._installAssetStreamingPreprocessor(parameters);
		this._engine = new Engine(this._canvas, true, {
			stencil: true,
			antialias: true,
			audioEngine: true,
			adaptToDeviceRatio: true,
			disableWebGL2Support: false,
			useHighPrecisionFloats: true,
			powerPreference: "high-performance",
			failIfMajorPerformanceCaveat: false,
		});

		this._scene = new Scene(this._engine);

		await this._handleLoad();

		// Handle window resize
		const handleResize = () => {
			this._engine?.resize();
		};

		window.addEventListener("resize", handleResize);

		// Start render loop
		this._engine.runRenderLoop(() => {
			this._scene?.render();
		});
	}

	private async _handleLoad(): Promise<void> {
		if (!this._engine || !this._scene) {
			return;
		}

		const havok = await HavokPhysics();
		this._scene.enablePhysics(new Vector3(0, -981, 0), new HavokPlugin(true, havok));

		SceneLoaderFlags.ForceFullSceneLoadingForIncremental = true;
		RegisterTransformNode();
		void InstancedMesh;
		await loadScene("./scene/", "example.babylon", this._scene, scriptsMap, {
			quality: "high",
		});

		if (this._scene.activeCamera) {
			this._scene.activeCamera.attachControl();
		}
	}

	public dispose(): void {
		if (this._assetUrlPreprocessor && FileToolsOptions.PreprocessUrl === this._assetUrlPreprocessor && this._previousAssetUrlPreprocessor) {
			FileToolsOptions.PreprocessUrl = this._previousAssetUrlPreprocessor;
		}
		this._assetUrlPreprocessor = null;
		this._previousAssetUrlPreprocessor = null;
		this._platformPlayerRuntime?.dispose();
		this._scene?.dispose();
		this._engine?.dispose();
	}

	private _readQueryJson(parameters: URLSearchParams, key: string): unknown {
		const value = parameters.get(key);
		if (!value) {
			return {};
		}
		try {
			return JSON.parse(value);
		} catch {
			return {};
		}
	}

	private _installAssetStreamingPreprocessor(parameters: URLSearchParams): void {
		const settings = normalizeAssetStreamingSettings(this._readQueryJson(parameters, "zvibeAssetStreamingSettings"));
		const authoredPlan = this._readQueryJson(parameters, "zvibeAssetStreamingPlan") as { platform?: unknown };
		const platform: AssetStreamingHost =
			authoredPlan.platform === "win32" || authoredPlan.platform === "darwin" || authoredPlan.platform === "linux" ? authoredPlan.platform : "unknown";
		this._assetStreamingPlan = getAssetStreamingBuildPlan(settings, platform);
		this._previousAssetUrlPreprocessor = FileToolsOptions.PreprocessUrl;
		const previous = this._previousAssetUrlPreprocessor;
		const plan = this._assetStreamingPlan;
		this._assetUrlPreprocessor = (url) => rewriteAssetUrlForStreaming(previous(url), window.location.href, plan);
		FileToolsOptions.PreprocessUrl = this._assetUrlPreprocessor;
		(globalThis as any).__zvibeAssetStreamingEvidenceV1 = {
			backend: plan.backend,
			enabled: plan.enabled,
			model: plan.model,
			platform: plan.platform,
			nativeBackendUsed: plan.directStorage.nativeBackendUsed,
			urlPreprocessorInstalled: true,
		};
	}
}
