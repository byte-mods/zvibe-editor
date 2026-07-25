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

	/** Project-wide behavior-script execution orders, applied to every exported scene. */
	scriptExecutionOrders?: Record<string, number>;

	/**
	 * Gizmo snap preferences (translate / rotate / scale).
	 */
	gizmoSnap?: IGizmoSnapPreferences;
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

export type EditorProjectCompressedTextureSoftware = "PVRTexTool" | "Khronos KTX-Software";
export type EditorProjectCompressedTextureQuality = "very-fast" | "fast" | "normal" | "high";

export type EditorProjectPackageManager = "npm" | "yarn" | "pnpm" | "bun";

export type EditorProjectTemplate = "nextjs" | "nuxtjs" | "solidjs" | "vanillajs" | "electron";
