import { platform } from "os";
import { join, sep } from "path/posix";
import { webFrame, ipcRenderer } from "electron";

import { Component, ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { HotkeysProvider, HotkeysTarget2 } from "@blueprintjs/core";

import { waitUntil } from "../tools/tools";
import { isDomTextInputFocused } from "../tools/dom";
import { onRedoObservable, onUndoObservable, redo, undo } from "../tools/undoredo";
import { tryGetExperimentalFeaturesEnabledFromLocalStorage } from "../tools/local-storage";
import { checkNodeJSAvailable, checkVisualStudioCodeAvailable, nodeJSAvailable, visualStudioCodeAvailable } from "../tools/process";
import { isSpriteManagerNode } from "../tools/guards/sprites";
import { installBundledExrInflater } from "../tools/assets/exr-inflater";

import { saveProject, saveProjectForRestart } from "../project/save/save";
import { setSerializationSessionPublisher } from "../project/serialization-session";
import { onProjectConfigurationChangedObservable, projectConfiguration } from "../project/configuration";
import { EditorSceneWorkspace } from "../project/scene-workspace-runtime";
import {
	onNodeModifiedObservable,
	onNodesAddedObservable,
	onParticleSystemAddedObservable,
	onParticleSystemModifiedObservable,
	onSkeletonModifiedObservable,
	onSpriteModifiedObservable,
	onTextureAddedObservable,
	onTextureModifiedObservable,
} from "../tools/observables";

import { initializeMcpServer } from "../mcp/mcp";
import { configureBundledMediaExecutables } from "../mcp/assets/media-executables";
import type { EditorExtensionHost } from "../extensions/host";
import type { IEditorExtensionMenuDescriptor } from "../extensions/types";
import { disposeProjectEditorExtensions } from "../extensions/project";

import { loadProject } from "../project/load/load";
import { startProjectDevProcess } from "../project/run";
import { exportProject } from "../project/export/export";
import {
	EditorProjectCompressedTextureQuality,
	EditorProjectCompressedTextureSoftware,
	EditorProjectPackageManager,
	IEditorPrefabStageSettings,
	IEditorProjectExtension,
	IEditorProjectSettings,
	IEditorSceneBuildSettings,
} from "../project/typings";
import { defaultPrefabStageSettings } from "../project/prefab-stage";
import { createDefaultProjectSettings } from "../project/settings";
import { applyEditorUserPreferences, IEditorUserPreferences, readEditorUserPreferences, writeEditorUserPreferences } from "./preferences";

import { disposeVLSPostProcess } from "./rendering/vls";
import { disposeSSRRenderingPipeline } from "./rendering/ssr";
import { disposeSSAO2RenderingPipeline } from "./rendering/ssao";
import { disposeMotionBlurPostProcess } from "./rendering/motion-blur";
import { disposeDefaultRenderingPipeline } from "./rendering/default-pipeline";

import { CommandPalette } from "./dialogs/command-palette/command-palette";
import { EditorGenerateProjectComponent } from "./dialogs/generate/generate-project";
import { showFbxExportDialog } from "./layout/graph/fbx-export";
import { EditorEditProjectComponent } from "./dialogs/edit-project/edit-project";
import { EditorEditPreferencesComponent } from "./dialogs/edit-preferences/edit-preferences";
import { EditorSceneManager } from "./dialogs/scene-manager/scene-manager";

import { Toaster } from "../ui/shadcn/ui/sonner";

import { EditorLayout } from "./layout";
import { removeNodes } from "./layout/graph/remove";

import "./nodes/camera";
import "./nodes/scene-link";
// import "./nodes/sprite-manager";
// import "./nodes/sprite-map";

export function createEditor(): void {
	installBundledExrInflater();
	applyEditorUserPreferences(readEditorUserPreferences());

	const div = document.getElementById("babylonjs-editor-main-div")!;

	const root = createRoot(div);
	root.render(
		<HotkeysProvider>
			<div className="w-screen h-screen">
				<Editor projectPath={null} />
			</div>
		</HotkeysProvider>
	);
}

export interface IEditorProps {
	/**
	 * The path of the project.
	 */
	projectPath: string | null;

	/**
	 * Defines the path to the currently edited scene path.
	 */
	editedScenePath?: string | null;
}

export interface IEditorState {
	/**
	 * The path of the project.
	 */
	projectPath: string | null;
	/**
	 * The path of the last opened scene.
	 */
	lastOpenedScenePath: string | null;
	/** Ordered scenes included in generated builds. */
	sceneBuildSettings: IEditorSceneBuildSettings;
	/** Project-wide Unity-style Prefab Stage defaults. */
	prefabStage: IEditorPrefabStageSettings;
	/**
	 * Defines the list of all plugins to load.
	 */
	plugins: string[];
	/** Shared package-managed extension enablement; machine trust is stored separately. */
	editorExtensions: IEditorProjectExtension[];
	/**
	 * Defines the current package manager being used by the editor.
	 */
	packageManager?: EditorProjectPackageManager;
	/**
	 * Executable name or absolute path used to open project source files.
	 */
	externalEditorCommand: string;
	/** Shared Unity-style Editor and Player settings. */
	projectSettings: IEditorProjectSettings;
	/** User-scoped appearance, workflow, external-tool, and diagnostics preferences. */
	editorUserPreferences: IEditorUserPreferences;
	/** Project-wide behavior-script execution orders. */
	scriptExecutionOrders: Record<string, number>;

	/**
	 * Defines the software used for compressing textures.
	 */
	compressedTextureSoftware?: EditorProjectCompressedTextureSoftware;
	/**
	 * Defines wether or not compressed textures are enabled.
	 */
	compressedTexturesEnabled: boolean;
	/**
	 * Defines wether or not compressed textures are enabled in the preview.
	 */
	compressedTexturesEnabledInPreview: boolean;
	/**
	 * Defines wether or not ETC2 compressed textures are enabled.
	 */
	compressedEtc2Enabled: boolean;
	/**
	 * Defines wether or not PVRTC compressed textures are enabled.
	 */
	compressedPvrtcEnabled: boolean;
	/**
	 * Defines the quality of the compressed textures.
	 */
	compressedTextureQuality?: EditorProjectCompressedTextureQuality;

	/**
	 * Defines wether or not experimental features are enabled.
	 */
	enableExperimentalFeatures: boolean;
	/**
	 * Defines the list of tabs that are currently opened in the layout.
	 */
	openedTabs: string[];

	/**
	 * Defines if the project is being edited.
	 */
	editProject: boolean;
	/**
	 * Defines if the preferences are being edited.
	 */
	editPreferences: boolean;
	/**
	 * Defines if the project generator dialog is opened.
	 */
	generateProject: boolean;
	/** Defines if the scene manager is opened. */
	sceneManager: boolean;

	/**
	 * Defines wether or not NodeJS is available.
	 */
	nodeJSAvailable: boolean;
	/**
	 * Defines wether or not Visual Studio Code is available.
	 */
	visualStudioCodeAvailable: boolean;
}

export interface IPlatformRestartEvidence {
	target: "web" | "electron" | "headless" | "android" | "ios";
	planId: string;
	diagnosticFingerprint: string;
	requestedAt: string;
	restartedAt: string;
}

export class Editor extends Component<IEditorProps, IEditorState> {
	/** Runtime authority for loaded scene ownership and per-scene dirty state. */
	public readonly sceneWorkspace = new EditorSceneWorkspace();
	private _sceneWorkspaceObserverCleanups: (() => void)[] = [];
	private _disposeMcpServer: (() => void) | null = null;
	private _extensionMenus: IEditorExtensionMenuDescriptor[] = [];
	private _extensionCommandHandler = (_event: Electron.IpcRendererEvent, id: unknown): void => {
		if (typeof id !== "string" || id.length > 160 || !this.extensionHost) {
			return;
		}
		void this.extensionHost.invokeMenu(id).catch((error) => console.error(`Editor extension menu command "${id}" failed.`, error));
	};
	private _autoSaveIntervalId: number | null = null;
	private _windowFocusHandler = (): void => {
		const policy = this.state.projectSettings.assetPipeline;
		if (policy.autoRefresh && policy.autoRefreshOnFocus) {
			this.layout?.assets?.refreshWatchedAssets();
		}
	};
	private _platformRestartEvidenceHandler = (_event: Electron.IpcRendererEvent, evidence: unknown): void => {
		if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
			this.platformRestartEvidence = structuredClone(evidence as IPlatformRestartEvidence);
		}
	};

	/**
	 * The layout of the editor.
	 */
	public layout: EditorLayout;
	/** Runtime host is attached after Project Manager dependency discovery completes. */
	public extensionHost: EditorExtensionHost | null = null;
	/** Exact evidence supplied only when this process was relaunched by the installed-platform flow. */
	public platformRestartEvidence: IPlatformRestartEvidence | null = null;
	/**
	 * The command palette of the editor.
	 */
	public commandPalette: CommandPalette;

	/**
	 * Defines the path to the editor application.
	 * This comes from electron `app.getAppPath();`
	 */
	public path: string | null = null;

	public constructor(props: IEditorProps) {
		super(props);
		const editorUserPreferences = readEditorUserPreferences();

		this.state = {
			plugins: [],
			editorExtensions: [],
			lastOpenedScenePath: null,
			sceneBuildSettings: { version: 1, scenes: [] },
			prefabStage: defaultPrefabStageSettings,
			projectPath: props.projectPath,

			compressedTextureSoftware: "PVRTexTool",
			compressedTexturesEnabled: false,
			compressedTexturesEnabledInPreview: false,
			compressedEtc2Enabled: false,
			compressedPvrtcEnabled: false,
			compressedTextureQuality: "very-fast",
			externalEditorCommand: editorUserPreferences.externalTools.scriptEditorCommand,
			projectSettings: createDefaultProjectSettings(),
			editorUserPreferences,
			scriptExecutionOrders: {},

			enableExperimentalFeatures: tryGetExperimentalFeaturesEnabledFromLocalStorage(),
			openedTabs: [],

			editProject: false,
			editPreferences: false,
			generateProject: false,
			sceneManager: false,

			nodeJSAvailable: false,
			visualStudioCodeAvailable: false,
		};

		webFrame.setZoomFactor(editorUserPreferences.appearance.uiScale);

		const nodeObserver = onNodeModifiedObservable.add((object) => this.sceneWorkspace.markObjectDirty(object));
		const addedNodesObserver = onNodesAddedObservable.add((objects) => {
			if (objects) {
				this.sceneWorkspace.claimNewObjectsForActiveScene(objects);
			}
		});
		const addedParticleObserver = onParticleSystemAddedObservable.add((object) => this.sceneWorkspace.markObjectDirty(object));
		const particleObserver = onParticleSystemModifiedObservable.add((object) => this.sceneWorkspace.markObjectDirty(object));
		const skeletonObserver = onSkeletonModifiedObservable.add((object) => this.sceneWorkspace.markObjectDirty(object));
		const spriteObserver = onSpriteModifiedObservable.add((object) => {
			const managerNode = this.layout?.preview?.scene.transformNodes.find((node) => isSpriteManagerNode(node) && node.spriteManager === object.manager);
			this.sceneWorkspace.markObjectDirty(managerNode ?? object);
		});
		const textureObserver = onTextureModifiedObservable.add((object) => this.sceneWorkspace.markObjectDirty(object));
		const addedTextureObserver = onTextureAddedObservable.add((object) => this.sceneWorkspace.markObjectDirty(object));
		this._sceneWorkspaceObserverCleanups.push(
			() => onNodeModifiedObservable.remove(nodeObserver),
			() => onNodesAddedObservable.remove(addedNodesObserver),
			() => onParticleSystemAddedObservable.remove(addedParticleObserver),
			() => onParticleSystemModifiedObservable.remove(particleObserver),
			() => onSkeletonModifiedObservable.remove(skeletonObserver),
			() => onSpriteModifiedObservable.remove(spriteObserver),
			() => onTextureModifiedObservable.remove(textureObserver),
			() => onTextureAddedObservable.remove(addedTextureObserver)
		);
	}

	public render(): ReactNode {
		return (
			<>
				<HotkeysTarget2
					hotkeys={[
						{
							global: true,
							combo: platform() === "darwin" ? "cmd + p" : "ctrl + p",
							preventDefault: true,
							label: "Show Command Palette",
							onKeyDown: () => this.commandPalette.setOpen(true),
						},
						{
							global: true,
							combo: "delete",
							preventDefault: true,
							label: "Delete Selected Objects",
							onKeyDown: () => {
								if (!isDomTextInputFocused()) {
									const selectedNodes = this.layout.graph.getSelectedNodes();
									if (selectedNodes.length > 0) {
										removeNodes(this);
									}
								}
							},
						},
					]}
				>
					<EditorLayout editor={this} ref={(ref) => ref && (this.layout = ref!)} />
				</HotkeysTarget2>

				<EditorEditProjectComponent editor={this} open={this.state.editProject} onClose={() => this.setState({ editProject: false })} />
				<EditorEditPreferencesComponent editor={this} open={this.state.editPreferences} onClose={() => this.setState({ editPreferences: false })} />
				<EditorGenerateProjectComponent editor={this} open={this.state.generateProject} onClose={() => this.setState({ generateProject: false })} />
				<EditorSceneManager editor={this} open={this.state.sceneManager} onClose={() => this.setState({ sceneManager: false })} />

				<CommandPalette ref={(r) => (this.commandPalette = r!)} editor={this} />
				<Toaster />
			</>
		);
	}

	public async componentDidMount(): Promise<void> {
		setSerializationSessionPublisher((snapshot) => ipcRenderer.send("editor:serialization-session-update", snapshot));
		this._configureAutoSave();
		window.addEventListener("focus", this._windowFocusHandler);
		ipcRenderer.on("save", () => saveProject(this));
		ipcRenderer.on("generate", () => exportProject(this, { optimize: false }));

		ipcRenderer.on("editor:edit-project", () => this.setState({ editProject: true }));
		ipcRenderer.on("editor:edit-preferences", () => this.setState({ editPreferences: true }));
		ipcRenderer.on("editor:generate-project", () => this.setState({ generateProject: true }));
		ipcRenderer.on("editor:scene-manager", () => this.setState({ sceneManager: true }));
		ipcRenderer.on("editor:export-scene-fbx", () => showFbxExportDialog(this));

		ipcRenderer.on("editor:open", (_, path) => this.openProject(join(path)));

		ipcRenderer.on("editor:quit-app", () => this.quitApp());
		ipcRenderer.on("editor:close-window", () => this.close());

		ipcRenderer.on("editor:path", (_, path) => {
			const editorPath = path.replace(/\\/g, sep);
			this.path = editorPath;
			configureBundledMediaExecutables(editorPath);
		});

		ipcRenderer.on("editor:run-project", () => startProjectDevProcess(this));
		ipcRenderer.on("editor:extension-command", this._extensionCommandHandler);
		ipcRenderer.on("editor:platform-restart-evidence", this._platformRestartEvidenceHandler);

		// Undo-redo
		ipcRenderer.on("undo", () => undo());
		ipcRenderer.on("redo", () => redo());

		onUndoObservable.add(() => {
			this.layout.graph.refresh();
			this.layout.inspector.forceUpdate();
			this.layout.animations.forceUpdate();
		});

		onRedoObservable.add(() => {
			this.layout.graph.refresh();
			this.layout.inspector.forceUpdate();
			this.layout.animations.forceUpdate();
		});

		await checkNodeJSAvailable();
		this.setState({ nodeJSAvailable });

		checkVisualStudioCodeAvailable().then(() => {
			this.setState({ visualStudioCodeAvailable });
		});

		// Ready
		ipcRenderer.send("editor:ready");
		this.setupApplicationMenu();

		// Start the MCP server once the layout/preview scene is ready.
		await waitUntil(() => this.layout?.preview?.scene);

		// Initialize the MCP server to allow communication between the editor and AI agents
		this._disposeMcpServer?.();
		this._disposeMcpServer = initializeMcpServer(this);
	}

	public componentWillUnmount(): void {
		setSerializationSessionPublisher(null);
		ipcRenderer.removeListener("editor:extension-command", this._extensionCommandHandler);
		ipcRenderer.removeListener("editor:platform-restart-evidence", this._platformRestartEvidenceHandler);
		void disposeProjectEditorExtensions(this).catch((error) => console.error("Failed to dispose editor extensions while closing.", error));
		this._disposeMcpServer?.();
		this._disposeMcpServer = null;
		this._sceneWorkspaceObserverCleanups.splice(0).forEach((cleanup) => cleanup());
		if (this._autoSaveIntervalId !== null) {
			window.clearInterval(this._autoSaveIntervalId);
		}
		window.removeEventListener("focus", this._windowFocusHandler);
	}

	/** Rebuilds the native menu with declarative extension commands only. */
	public setupApplicationMenu(openedTabs: readonly string[] = this.state.openedTabs): void {
		ipcRenderer.send("editor:setup-menu", {
			enableExperimentalFeatures: this.state.enableExperimentalFeatures,
			openedTabs: [...openedTabs],
			extensionMenus: this._extensionMenus,
		});
	}

	/** Replaces the renderer-owned extension command descriptors and refreshes the native menu. */
	public setExtensionMenus(descriptors: readonly IEditorExtensionMenuDescriptor[]): void {
		this._extensionMenus = descriptors.map((descriptor) => ({ ...descriptor }));
		this.setupApplicationMenu();
	}

	/** Persists all owned scenes, then asks Electron main to relaunch this exact project for installed platform support. */
	public async restartForInstalledPlatform(request: {
		target: "web" | "electron" | "headless" | "android" | "ios";
		planId: string;
		projectPath: string;
		diagnosticFingerprint: string;
		requestedAt: string;
	}): Promise<Record<string, unknown>> {
		if (!this.state.projectPath || request.projectPath !== this.state.projectPath) {
			throw new Error("The restart request does not match the currently open project.");
		}
		await saveProjectForRestart(this);
		return ipcRenderer.invoke("editor:restart-for-installed-platform", request);
	}

	/** Applies and persists user-scoped preferences immediately. */
	public async setEditorUserPreferences(preferences: IEditorUserPreferences): Promise<void> {
		await new Promise<void>((resolve) =>
			this.setState({ editorUserPreferences: preferences, externalEditorCommand: preferences.externalTools.scriptEditorCommand }, () => resolve())
		);
		writeEditorUserPreferences(preferences);
		applyEditorUserPreferences(preferences);
		webFrame.setZoomFactor(preferences.appearance.uiScale);
		this._configureAutoSave();
	}

	private _configureAutoSave(): void {
		if (this._autoSaveIntervalId !== null) {
			window.clearInterval(this._autoSaveIntervalId);
		}
		this._autoSaveIntervalId = null;
		const preferences = this.state.editorUserPreferences.workflow;
		if (!preferences.autoSave) {
			return;
		}
		this._autoSaveIntervalId = window.setInterval(() => {
			if (this.state.projectPath && !this.props.editedScenePath) {
				void saveProject(this);
			}
		}, preferences.autoSaveIntervalMinutes * 60_000);
	}

	/**
	 * Opens the project located at the given absolute path.
	 * @param absolutePath defines the absolute path to the project to open.
	 */
	public async openProject(absolutePath: string): Promise<void> {
		await waitUntil(() => this.layout.preview.scene);
		await disposeProjectEditorExtensions(this);

		ipcRenderer.send("editor:maximize-window");

		absolutePath = absolutePath.replace(/\\/g, sep);

		projectConfiguration.path = absolutePath;

		disposeVLSPostProcess(this);
		disposeSSRRenderingPipeline();
		disposeMotionBlurPostProcess();
		disposeSSAO2RenderingPipeline();
		disposeDefaultRenderingPipeline();

		onProjectConfigurationChangedObservable.notifyObservers(projectConfiguration);

		await loadProject(this, absolutePath);
	}

	/**
	 * Closes the current editor window after asking for confirmation.
	 */
	public close(): void {
		ipcRenderer.send("window:close");
	}

	/**
	 * Quits the app after asking for confirmation.
	 */
	public quitApp(): void {
		ipcRenderer.send("app:quit");
	}
}
