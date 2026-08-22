import { IGizmoSnapPreferences } from "../tools/scene/gizmo";

export interface IEditorProject {
	/**
	 * The version of the editor that saved this project.
	 */
	version: string;
	/**
	 * The path to the last opened scene.
	 */
	lastOpenedScene: string | null;

	/**
	 * Ordered scenes included in project builds. Older projects are migrated by
	 * discovering their `.scene` assets and enabling them in deterministic order.
	 */
	sceneBuildSettings?: IEditorSceneBuildSettings;

	/** Restores the editor's additive multi-scene authoring workspace. */
	sceneWorkspace?: IEditorSceneWorkspaceSettings;

	/** Project-wide defaults for the isolated Unity-style Prefab Stage. */
	prefabStage?: IEditorPrefabStageSettings;

	/**
	 * The plugins of the project.
	 */
	plugins: IEditorProjectPlugin[];

	/** Shared enablement for package-managed editor extensions; executable trust remains machine-local. */
	editorExtensions?: IEditorProjectExtension[];

	/**
	 * Defines the software used for compressing textures.
	 */
	compressedTextureSoftware?: EditorProjectCompressedTextureSoftware;
	/**
	 * If the compressed textures are enabled using PVRTexTool.
	 */
	compressedTexturesEnabled: boolean;
	/**
	 * If the compressed textures are enabled in the preview.
	 */
	compressedTexturesEnabledInPreview: boolean;

	/**
	 * If the ETC2 compressed textures are enabled using PVRTexTool.
	 */
	compressedEtc2Enabled?: boolean;
	/**
	 * If the PVRTC compressed textures are enabled using PVRTexTool.
	 */
	compressedPvrtcEnabled?: boolean;
	/**
	 * The quality of the compressed textures.
	 */
	compressedTextureQuality?: EditorProjectCompressedTextureQuality;

	/**
	 * The package manager being used by the project.
	 */
	packageManager?: EditorProjectPackageManager;

	/**
	 * Executable name or absolute path used to open project source files.
	 */
	externalEditorCommand?: string;

	/** Versioned Unity-style Editor and Player settings shared by every scene and build. */
	projectSettings?: IEditorProjectSettings;

	/** Project-wide behavior-script execution orders, applied to every exported scene. */
	scriptExecutionOrders?: Record<string, number>;

	/**
	 * Gizmo snap preferences (translate / rotate / scale).
	 */
	gizmoSnap?: IGizmoSnapPreferences;
}

export const editorProjectSettingsVersion = 2 as const;

export type EditorPlayerFullscreenMode = "windowed" | "fullscreen" | "borderless";
export type EditorPlayerColorSpace = "gamma" | "linear";
export type EditorPlayerRenderingBackend = "auto" | "webgl2" | "webgpu";
export type EditorAssetSerializationMode = "forceText" | "mixed" | "forceBinary";
export type EditorDefaultBehaviorMode = "2d" | "3d";
export type EditorProjectBuildTarget = "web" | "electron" | "headless" | "android" | "ios";

export interface IEditorPlayerIdentitySettings {
	companyName: string;
	productName: string;
	version: string;
	applicationId: string;
}

export interface IEditorPlayerDisplaySettings {
	defaultWidth: number;
	defaultHeight: number;
	fullscreenMode: EditorPlayerFullscreenMode;
	resizableWindow: boolean;
	runInBackground: boolean;
	allowHighDpi: boolean;
}

export interface IEditorPlayerRenderingSettings {
	colorSpace: EditorPlayerColorSpace;
	renderingBackend: EditorPlayerRenderingBackend;
	powerPreference: "default" | "high-performance" | "low-power";
	targetFrameRate: number;
	maximumDevicePixelRatio: number;
	preserveDrawingBuffer: boolean;
}

export interface IEditorPlayerRuntimeSettings {
	showBabylonLoadingScreen: boolean;
	disableContextMenu: boolean;
	dataCaching: boolean;
	deterministicLockstep: boolean;
	lockstepMaxSteps: number;
}

export type EditorImportAcceleratorContentValidation = "disabled" | "uploadOnly" | "enabled" | "required";

/** Project-owned remote import-result cache policy. Authentication values are resolved from the named environment variable and are never persisted here. */
export interface IEditorImportAcceleratorSettings {
	enabled: boolean;
	endpoint: string;
	namespacePrefix: string;
	downloadEnabled: boolean;
	uploadEnabled: boolean;
	authenticationEnvironmentVariable: string;
	contentValidation: EditorImportAcceleratorContentValidation;
	downloadBatchSize: number;
	requestTimeoutMilliseconds: number;
	maximumResultSizeBytes: number;
}

export interface IEditorAssetPipelineSettings {
	autoRefresh: boolean;
	autoRefreshOnFocus: boolean;
	directoryMonitoring: boolean;
	importWorkerCount: number;
	serializationMode: EditorAssetSerializationMode;
	reduceVersionControlNoise: boolean;
	accelerator: IEditorImportAcceleratorSettings;
}

export interface IEditorPlayModeSettings {
	reloadScene: boolean;
	reloadScripts: boolean;
	muteAudio: boolean;
	maximizeOnPlay: boolean;
}

export interface IEditorPlatformSettingsOverride {
	display?: Partial<IEditorPlayerDisplaySettings>;
	rendering?: Partial<IEditorPlayerRenderingSettings>;
	runtime?: Partial<IEditorPlayerRuntimeSettings>;
}

export interface IEditorProjectSettings {
	version: typeof editorProjectSettingsVersion;
	revision: number;
	identity: IEditorPlayerIdentitySettings;
	display: IEditorPlayerDisplaySettings;
	rendering: IEditorPlayerRenderingSettings;
	runtime: IEditorPlayerRuntimeSettings;
	assetPipeline: IEditorAssetPipelineSettings;
	playMode: IEditorPlayModeSettings;
	defaultBehaviorMode: EditorDefaultBehaviorMode;
	platformOverrides: Partial<Record<EditorProjectBuildTarget, IEditorPlatformSettingsOverride>>;
}

export interface IEditorSceneBuildSettings {
	version: 1;
	scenes: IEditorBuildScene[];
}

export interface IEditorBuildScene {
	/** Project-relative path ending in `.scene`. Array order is the build index. */
	path: string;
	/** Disabled scenes remain authored but are omitted from generated builds. */
	enabled: boolean;
}

export interface IEditorSceneWorkspaceSettings {
	version: 1;
	/** Ordered project-relative scenes currently loaded for authoring. */
	loadedScenes: string[];
	/** Scene that receives newly authored root objects. */
	activeScene: string | null;
	/** Loaded scene whose environment, fog, physics, and rendering settings are applied. */
	lightingScene: string | null;
}

export type EditorPrefabStageMode = "isolation" | "context";
export type EditorPrefabStageContextAppearance = "normal" | "gray" | "hidden";
export type EditorPrefabStageEnvironment = "neutral" | "scene";

export interface IEditorPrefabStageSettings {
	version: 1;
	/** Isolation edits only the source; context clones the live authored scene around one instance. */
	mode: EditorPrefabStageMode;
	/** Controls how locked scene objects are rendered while editing in context. */
	contextAppearance: EditorPrefabStageContextAppearance;
	/** Highlights the locked live instance beside the editable source. */
	showOverrides: boolean;
	/** Saves changed source-node properties after a short bounded debounce. */
	autoSave: boolean;
	/** Neutral uses the stage light; scene copies the current scene lighting and environment. */
	environment: EditorPrefabStageEnvironment;
	/** Neutral-stage clear color in linear RGBA. */
	backgroundColor: [number, number, number, number];
	/** Neutral-stage hemispheric-light intensity. */
	lightIntensity: number;
}

export interface IEditorSceneTemplateManifest {
	version: 1;
	name: string;
	description?: string;
	/** Project-relative scene path captured when the template was created. */
	sourceScenePath: string;
	createdAt: string;
}

export interface IEditorProjectPlugin {
	/**
	 * The name or path of the plugin.
	 */
	nameOrPath: string;
}

/** Project-shared extension choice intentionally excludes executable trust. */
export interface IEditorProjectExtension {
	/** Must name a direct dependency in the active project's package.json. */
	packageName: string;
	/** Disabled extensions remain configured but execute no editor code. */
	enabled: boolean;
}

export type EditorProjectCompressedTextureSoftware = "PVRTexTool" | "Khronos KTX-Software";
export type EditorProjectCompressedTextureQuality = "very-fast" | "fast" | "normal" | "high";

export type EditorProjectPackageManager = "npm" | "yarn" | "pnpm" | "bun";

export type EditorProjectTemplate = "nextjs" | "nuxtjs" | "solidjs" | "vanillajs" | "electron";
