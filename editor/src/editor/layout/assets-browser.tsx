import { clipboard, webUtils } from "electron";
import { FSWatcher, watch } from "chokidar";
import { dirname, join, extname, basename, relative, resolve } from "path/posix";
import { copyFile, copy, mkdir, pathExists, readdir, stat, writeFile, writeJSON } from "fs-extra";

import filenamify from "filenamify";

import { AdvancedDynamicTexture } from "babylonjs-gui";
import { INavMeshParametersV2 } from "babylonjs-addons/navigation/types";
import { Material, NodeMaterial, Tools, RegisterSceneLoaderPlugin } from "babylonjs";

import { createDefaultGUIAuthoringState, createDefaultScriptableAudioGeneratorGraph, IRagDollConfiguration, normalizeCinematicDocument } from "babylonjs-editor-tools";

import { Fade } from "react-awesome-reveal";
import { Grid } from "react-loader-spinner";
import { Component, DragEvent, MouseEvent, ReactNode } from "react";
import { SelectableGroup, createSelectable } from "react-selectable";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { IoIosOptions } from "react-icons/io";
import { AiOutlinePlus } from "react-icons/ai";
import { MdOutlineRefresh } from "react-icons/md";
import { FaMagnifyingGlass } from "react-icons/fa6";
import { IoRefresh, IoCheckmark, IoArrowDownCircleOutline } from "react-icons/io5";
import { FaArrowLeft, FaArrowRight, FaFolder, FaFolderOpen, FaRegFolderOpen } from "react-icons/fa";

import { toast } from "sonner";

import { Tree, TreeNodeInfo } from "@blueprintjs/core";

import { Editor } from "../main";

import { execNodePty } from "../../tools/node-pty";
import { openInExternalEditor } from "../../tools/external-editor";
import { clearUndoRedo } from "../../tools/undoredo";
import { isTexture } from "../../tools/guards/texture";
import { renameScene } from "../../tools/scene/rename";
import { isSoundNode } from "../../tools/guards/sound";
import { openMultipleFilesDialog } from "../../tools/dialog";
import { onSelectedAssetChanged } from "../../tools/observables";
import { sortAlphabetically, UniqueNumber } from "../../tools/tools";
import { findAvailableFilename, normalizedGlob } from "../../tools/fs";
import { loadSavedThumbnailsCache } from "../../tools/assets/thumbnail";
import { assetsCache, saveAssetsCache } from "../../tools/assets/cache";
import { getProjectAssetWatchPaths } from "../../tools/assets/watch";
import { assetRootPlacementError, inspectAssetRootPlacement, isInsideAssetRoot } from "../../tools/assets/root-placement";
import { checkProjectCachedCompressedTextures, processingCompressedTextures } from "../../tools/assets/ktx";
import { applyAssetImporterPreset, getAssetDetails, listAssetImporterPresets, setAssetImporterPreset } from "../../mcp/assets/assets";
import {
	ensureAssetRegistry,
	cancelAssetIndexingJob,
	getAssetIndexingStatus,
	getAssetRegistryStatus,
	IAssetIndexingJob,
	isAssetMetadataPath,
	queryAssetRegistry,
	readAssetMetadata,
	refreshAssetRegistryPaths,
	startAssetIndexingJob,
	writeAssetMetadata,
} from "../../mcp/assets/registry";
import { applySemanticAssetMove, inspectSemanticAssetMove } from "../../mcp/assets/move";
import { getAutoReimportOriginPaths, getAutoReimportStatus, IAutoReimportJob, processAutoReimportChanges, processAutoReimportOriginChanges } from "../../mcp/assets/auto-reimport";
import { refreshGUIRetainedDocumentsForSource } from "../../mcp/gui/gui";
import { writeScriptableAudioAsset } from "../../mcp/assets/scriptable-audio-assets";
import { moveTextureChannelPreviewStates } from "../../mcp/assets/texture-channel-preview";

import { ICommandPaletteType } from "../dialogs/command-palette/command-palette";
import { getMaterialCommands, getMaterialsLibraryCommands } from "../dialogs/command-palette/material";
import { VfxTemplateBrowser } from "../dialogs/vfx-template-browser";
import { createCinematicDocumentFile } from "./cinematic/serialization/document";

import { replaceWithSingleSceneWorkspace } from "../../project/load/workspace";
import { saveProject, saveProjectConfiguration } from "../../project/save/save";
import { getProjectAssetsRootUrl, onProjectConfigurationChangedObservable, projectConfiguration } from "../../project/configuration";
import { addSceneToBuildSettings, renameSceneInBuildSettings } from "../../project/scenes";

import { Button } from "../../ui/shadcn/ui/button";
import { showAlert, showConfirm, showPrompt } from "../../ui/dialog";

import { Input } from "../../ui/shadcn/ui/input";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from "../../ui/shadcn/ui/breadcrumb";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/shadcn/ui/dropdown-menu";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
	ContextMenuSeparator,
	ContextMenuSubTrigger,
	ContextMenuSub,
	ContextMenuSubContent,
} from "../../ui/shadcn/ui/context-menu";

import { exportNodeToPath } from "./graph/export";

import { FileInspectorObject } from "./inspector/file";

import { INavMeshConfiguration } from "./navmesh/types";

import { AssetBrowserGUIItem } from "./assets-browser/items/gui-item";
import { AssetBrowserHDRItem } from "./assets-browser/items/hdr-item";
import { AssetBrowserJsonItem } from "./assets-browser/items/json-item";
import { AssetBrowserMeshItem } from "./assets-browser/items/mesh-item";
import { AssetBrowserRagdollItem } from "./assets-browser/items/ragdoll";
import { AssetBrowserSceneItem } from "./assets-browser/items/scene-item";
import { AssetBrowserImageItem } from "./assets-browser/items/image-item";
import { AssetBrowserNavmeshItem } from "./assets-browser/items/navmesh-item";
import { AssetBrowserMaterialItem } from "./assets-browser/items/material-item";
import { AssetBrowserCinematicItem } from "./assets-browser/items/cinematic-item";
import { AssetBrowserJavaScriptItem } from "./assets-browser/items/javascript-item";
import { AssetsBrowserItem, IAssetsBrowserItemProps } from "./assets-browser/items/item";
import { AssetBrowserParticleSystemItem } from "./assets-browser/items/particle-system-item";
import { AssetBrowserAudioGeneratorItem } from "./assets-browser/items/audio-generator-item";

import { listenGuiAssetsEvents } from "./assets-browser/events/gui";
import { listenSceneAssetsEvents } from "./assets-browser/events/scene";
import { listenMaterialAssetsEvents } from "./assets-browser/events/material";
import { listenParticleAssetsEvents } from "./assets-browser/events/particles";

import { openEnvViewer } from "./assets-browser/viewers/env-viewer";
import { openModelViewer } from "./assets-browser/viewers/model-viewer";
import { openPrefabMode } from "./assets-browser/viewers/prefab-mode";
import { openAssetDependencyGraph } from "./assets-browser/dependency-graph";

import { EditorAssetsTreeLabel } from "./assets-browser/label";

import { EditorAssetsBrowserRenameProgressComponent } from "./assets-browser/rename-progress";

import "babylonjs-loaders";

import { AssimpJSLoader } from "../../loader/assimpjs";

const HDRSelectable = createSelectable(AssetBrowserHDRItem);
const GuiSelectable = createSelectable(AssetBrowserGUIItem);
const JsonSelectable = createSelectable(AssetBrowserJsonItem);
const DefaultSelectable = createSelectable(AssetsBrowserItem);
const MeshSelectable = createSelectable(AssetBrowserMeshItem);
const ImageSelectable = createSelectable(AssetBrowserImageItem);
const SceneSelectable = createSelectable(AssetBrowserSceneItem);
const NavmeshSelectable = createSelectable(AssetBrowserNavmeshItem);
const RagdollSelectable = createSelectable(AssetBrowserRagdollItem);
const MaterialSelectable = createSelectable(AssetBrowserMaterialItem);
const CinematicSelectable = createSelectable(AssetBrowserCinematicItem);
const JavascriptSelectable = createSelectable(AssetBrowserJavaScriptItem);
const ParticleSystemSelectable = createSelectable(AssetBrowserParticleSystemItem);
const AudioGeneratorSelectable = createSelectable(AssetBrowserAudioGeneratorItem);

const directoryPackagesExtensions = [".scene", ".navmesh"];

RegisterSceneLoaderPlugin(new AssimpJSLoader(true, true));

export interface IEditorAssetsBrowserProps {
	/**
	 * The editor reference.
	 */
	editor: Editor;
}

export interface IEditorAssetsBrowserState {
	/**
	 * The sizes of the panels.
	 */
	sizes: number[];

	files: string[];
	selectedKeys: string[];
	selectionEnabled: boolean;

	treeSearch: string;
	gridSearch: string;

	showGeneratedFiles: boolean;
	importerPresets: any[];
	watchingAssets: boolean;
	assetChangeCount: number;
	lastAssetChange: { event: string; path: string; at: string } | null;
	autoReimportEnabled: boolean;
	autoReimportExternalSourceCount: number;
	autoReimportLastJob: IAutoReimportJob | null;
	assetRegistryEntries: number;
	assetRegistryConflicts: number;
	assetRegistryMissingReferences: number;
	assetIndexingWorkerAvailable: boolean;
	assetIndexingActiveJob: IAssetIndexingJob | null;
	assetViewFilter: "all" | "favorites" | "problems";
	assetRegistryMetadata: Record<string, { favorite: boolean; tags: string[]; importStatus: "native" | "unchecked" | "current" | "stale" | "missing" | "error" }>;

	browsedPath?: string;

	filesTreeNodes: TreeNodeInfo[];

	dragAndDroppingFiles: boolean;
	vfxTemplateBrowserOpen: boolean;
}

export class EditorAssetsBrowser extends Component<IEditorAssetsBrowserProps, IEditorAssetsBrowserState> {
	private _isMouseOver: boolean = false;
	private _selectedFiles: string[] = [];
	private _projectWatcher: FSWatcher | null = null;
	private _importSourceWatcher: FSWatcher | null = null;
	private _assetWatchRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
	private _importSourceRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
	private _assetIndexingStatusTimeout: ReturnType<typeof setTimeout> | null = null;
	private _pendingRegistryPaths = new Set<string>();
	private _pendingAssetChangeCount = 0;
	private _pendingLastAssetChange: { event: string; path: string; at: string } | null = null;
	private _pendingImportSourcePaths = new Set<string>();
	private _importSourceWatchSignature = "";
	private _autoReimportWatchRefresh: Promise<void> = Promise.resolve();
	private _autoReimportSuppressedProjectPaths = new Map<string, number>();

	public constructor(props: IEditorAssetsBrowserProps) {
		super(props);

		this.state = {
			files: [],
			sizes: [25, 75],

			treeSearch: "",
			gridSearch: "",

			selectedKeys: [],
			filesTreeNodes: [],

			selectionEnabled: true,
			showGeneratedFiles: false,
			importerPresets: [],
			watchingAssets: false,
			assetChangeCount: 0,
			lastAssetChange: null,
			autoReimportEnabled: true,
			autoReimportExternalSourceCount: 0,
			autoReimportLastJob: null,
			assetRegistryEntries: 0,
			assetRegistryConflicts: 0,
			assetRegistryMissingReferences: 0,
			assetIndexingWorkerAvailable: false,
			assetIndexingActiveJob: null,
			assetViewFilter: "all",
			assetRegistryMetadata: {},

			dragAndDroppingFiles: false,
			vfxTemplateBrowserOpen: false,
		};
	}

	public render(): ReactNode {
		return (
			<>
				<PanelGroup direction="horizontal" className="w-full h-full text-foreground">
					<Panel order={1} minSize={20} className="w-full h-full" defaultSize={this.state.sizes[0]}>
						<div className="flex flex-col w-full h-full">
							<div className="relative flex items-center px-1 w-full h-10 min-h-10 bg-input">
								<Input
									placeholder="Search"
									value={this.state.treeSearch}
									onChange={(e) => {
										this.setState({ treeSearch: e.currentTarget.value }, () => {
											if (projectConfiguration.path) {
												this._refreshFilesTreeNodes(projectConfiguration.path!);
											}
										});
									}}
									className={`
                                    w-full h-8 !border-none pl-7
                                    hover:border-border focus:border-border
                                    transition-all duration-300 ease-in-out    
                                `}
								/>

								<FaMagnifyingGlass className="absolute top-1/2 -translate-y-1/2 left-2 w-4 h-4" />
							</div>

							<div className="flex-1 w-full h-full overflow-auto">
								<Tree
									contents={this.state.filesTreeNodes}
									onNodeClick={(n) => this._handleNodeClicked(n)}
									onNodeExpand={(n) => this._handleNodeExpanded(n)}
									onNodeCollapse={(n) => this._handleNodeCollapsed(n)}
									onNodeDoubleClick={(n) => this._handleNodeDoubleClicked(n)}
								/>
							</div>
						</div>
					</Panel>

					<PanelResizeHandle className="w-2 bg-border/10 h-full cursor-pointer hover:bg-black/30 transition-all duration-300" />

					<Panel order={2} className="w-full h-full" defaultSize={this.state.sizes[1]}>
						{this._getFilesGridComponent()}
					</Panel>
				</PanelGroup>
				<VfxTemplateBrowser
					editor={this.props.editor}
					open={this.state.vfxTemplateBrowserOpen}
					folder={this.state.browsedPath && projectConfiguration.path ? relative(dirname(projectConfiguration.path), this.state.browsedPath) || "." : "assets"}
					onClose={() => this.setState({ vfxTemplateBrowserOpen: false })}
					onCreated={() => this.refresh()}
				/>
			</>
		);
	}

	public componentDidMount(): void {
		if (projectConfiguration.path) {
			void this._refreshImporterPresets();
			void this._refreshAssetRegistryStatus();
			this._watchProjectAssets(dirname(projectConfiguration.path));
		}
		onProjectConfigurationChangedObservable.add((c) => {
			if (c.path) {
				const rootUrl = dirname(c.path);

				this._refreshFilesTreeNodes(c.path);
				this.setBrowsePath(rootUrl);
				this._watchProjectAssets(rootUrl);
				void this._refreshImporterPresets();
				void this._refreshAssetRegistryStatus();

				loadSavedThumbnailsCache();
			}
		});

		document.addEventListener("keydown", (ev) => {
			if (this._isMouseOver && ev.key.toLowerCase() === "a" && (ev.ctrlKey || ev.metaKey)) {
				ev.preventDefault();
				this.setState({
					selectedKeys: this.state.files.map((f) => join(this.state.browsedPath!, f)),
				});
			}
		});

		onSelectedAssetChanged.add(async (path) => {
			await this.setBrowsePath(dirname(path));
			this.setSelectedFile(path);
			this.props.editor.layout.selectTab("assets-browser");
		});

		listenGuiAssetsEvents(this.props.editor);
		listenSceneAssetsEvents(this.props.editor);
		listenMaterialAssetsEvents(this.props.editor);
		listenParticleAssetsEvents(this.props.editor);
	}

	public componentWillUnmount(): void {
		if (this._assetWatchRefreshTimeout) {
			clearTimeout(this._assetWatchRefreshTimeout);
		}
		if (this._assetIndexingStatusTimeout) {
			clearTimeout(this._assetIndexingStatusTimeout);
		}
		if (this._importSourceRefreshTimeout) {
			clearTimeout(this._importSourceRefreshTimeout);
		}
		void this._projectWatcher?.close();
		void this._importSourceWatcher?.close();
		this._projectWatcher = null;
		this._importSourceWatcher = null;
	}

	/** Returns the current local project asset watcher status for MCP and the editor UI. */
	public getAssetWatchStatus(): {
		watching: boolean;
		changeCount: number;
		lastChange: { event: string; path: string; at: string } | null;
		autoReimport: { enabled: boolean; externalSourceCount: number; lastJob: IAutoReimportJob | null };
	} {
		return {
			watching: this.state.watchingAssets,
			changeCount: this.state.assetChangeCount,
			lastChange: this.state.lastAssetChange,
			autoReimport: {
				enabled: this.state.autoReimportEnabled,
				externalSourceCount: this.state.autoReimportExternalSourceCount,
				lastJob: this.state.autoReimportLastJob,
			},
		};
	}

	/** Rebuilds the browser's filesystem tree/items immediately. */
	public refreshWatchedAssets(): void {
		this.refresh();
	}

	/** Enables or disables project-directory monitoring from Project Settings. */
	public async configureProjectAssetWatching(enabled: boolean): Promise<void> {
		if (!enabled) {
			await this._projectWatcher?.close();
			this._projectWatcher = null;
			this.setState({ watchingAssets: false });
			return;
		}
		if (projectConfiguration.path) {
			this._watchProjectAssets(dirname(projectConfiguration.path));
		}
	}

	/** Rebuilds optional external-origin watches and refreshes the displayed Auto Reimport status. */
	public refreshAutoReimportWatchers(): Promise<void> {
		const result = this._autoReimportWatchRefresh.then(() => this._refreshAutoReimportWatchers());
		this._autoReimportWatchRefresh = result.catch(() => undefined);
		return result;
	}

	private async _refreshAutoReimportWatchers(): Promise<void> {
		const [paths, status] = await Promise.all([getAutoReimportOriginPaths(), getAutoReimportStatus()]);
		const signature = paths.join("\0");
		if (signature !== this._importSourceWatchSignature) {
			await this._importSourceWatcher?.close();
			this._importSourceWatcher = paths.length
				? watch(paths, { ignoreInitial: true, persistent: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } })
				: null;
			this._importSourceWatcher?.on("all", (event, changedPath) => this._onImportedSourceChanged(event, changedPath));
			this._importSourceWatchSignature = signature;
		}
		await new Promise<void>((resolveState) => {
			this.setState(
				{
					autoReimportEnabled: status.settings.enabled,
					autoReimportExternalSourceCount: paths.length,
					autoReimportLastJob: status.activeJob ?? status.lastJob,
				},
				resolveState
			);
		});
	}

	private _watchProjectAssets(projectDirectory: string): void {
		void this._projectWatcher?.close();
		if (this._assetWatchRefreshTimeout) {
			clearTimeout(this._assetWatchRefreshTimeout);
		}
		const watchedPaths = getProjectAssetWatchPaths(projectDirectory);
		this._projectWatcher = watch(watchedPaths, {
			ignoreInitial: true,
			persistent: true,
			ignored: ["**/node_modules/**", "**/.git/**", "**/public/scene/**", "**/editor-generated_*/**"],
		});
		this._projectWatcher.on("all", (event, changedPath) => this._onProjectAssetChanged(event, changedPath));
		this.setState({ watchingAssets: true, assetChangeCount: 0, lastAssetChange: null });
		void this.refreshAutoReimportWatchers();
	}

	private _onProjectAssetChanged(event: string, changedPath: string): void {
		const path = changedPath.replace(/\\/g, "/");
		if (/\.bjsmeta\.json\.[0-9a-f-]+\.tmp$/i.test(path)) {
			return;
		}
		const registryPath = path.endsWith(".bjsmeta.json") ? path.slice(0, -".bjsmeta.json".length) : path;
		this._pendingRegistryPaths.add(registryPath);
		// Count changes here but render them once per debounced burst: a setState per event re-rendered the whole browser
		// for every file of a large copy/delete (thousands of renders), starving the renderer and every pending asset call.
		this._pendingAssetChangeCount++;
		this._pendingLastAssetChange = { event, path, at: new Date().toISOString() };
		if (this._assetWatchRefreshTimeout) {
			clearTimeout(this._assetWatchRefreshTimeout);
		}
		this._assetWatchRefreshTimeout = setTimeout(() => {
			this._assetWatchRefreshTimeout = null;
			const paths = [...this._pendingRegistryPaths];
			this._pendingRegistryPaths.clear();
			const changeCount = this._pendingAssetChangeCount;
			const lastAssetChange = this._pendingLastAssetChange;
			this._pendingAssetChangeCount = 0;
			this._pendingLastAssetChange = null;
			this.setState((state) => ({ assetChangeCount: state.assetChangeCount + changeCount, lastAssetChange }));
			void (async () => {
				try {
					await refreshAssetRegistryPaths(paths);
					const now = Date.now();
					const autoReimportPaths = paths.filter((path) => {
						const expiresAt = this._autoReimportSuppressedProjectPaths.get(path) ?? 0;
						if (expiresAt < now) {
							this._autoReimportSuppressedProjectPaths.delete(path);
						}
						return expiresAt < now;
					});
					const job = autoReimportPaths.length ? await processAutoReimportChanges(autoReimportPaths, this.props.editor) : null;
					if (job?.appliedCount) {
						toast.success(`Auto Reimport rebuilt ${job.appliedCount} asset${job.appliedCount === 1 ? "" : "s"}.`);
					}
					if (job?.failedCount) {
						toast.error(`Auto Reimport completed with ${job.failedCount} failure${job.failedCount === 1 ? "" : "s"}.`);
					}
					const retainedSourcePaths = paths.filter((path) => [".uxml", ".uss"].includes(extname(path).toLowerCase()));
					for (const sourcePath of retainedSourcePaths) {
						const results = await refreshGUIRetainedDocumentsForSource(this.props.editor.layout.preview.scene, sourcePath, { editor: this.props.editor });
						for (const result of results) {
							if (result.error) {
								toast.error(`Retained UI hot reload failed: ${String(result.error)}`);
							} else if (result.changed) {
								toast.success(`Retained UI hot reloaded from ${String(result.sourcePath)}.`);
							}
						}
					}
					await this._refreshAssetRegistryStatus();
					await this.refreshAutoReimportWatchers();
					this.refresh();
				} catch (error) {
					console.error("Failed to refresh the asset registry after a watched project change.", error);
					toast.error(`Asset watcher refresh failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			})();
		}, 200);
	}

	private _onImportedSourceChanged(event: string, changedPath: string): void {
		if (event !== "add" && event !== "change") {
			return;
		}
		this._pendingImportSourcePaths.add(changedPath.replace(/\\/g, "/"));
		if (this._importSourceRefreshTimeout) {
			clearTimeout(this._importSourceRefreshTimeout);
		}
		this._importSourceRefreshTimeout = setTimeout(() => {
			this._importSourceRefreshTimeout = null;
			const paths = [...this._pendingImportSourcePaths];
			this._pendingImportSourcePaths.clear();
			void (async () => {
				try {
					const job = await processAutoReimportOriginChanges(paths, this.props.editor);
					for (const copyResult of job?.sourceCopies ?? []) {
						if (copyResult.status === "copied") {
							this._autoReimportSuppressedProjectPaths.set(resolve(dirname(projectConfiguration.path!), copyResult.assetPath), Date.now() + 5_000);
						}
					}
					if (job?.appliedCount) {
						toast.success(`Auto Reimport synchronized ${job.sourceCopies.length} source file${job.sourceCopies.length === 1 ? "" : "s"}.`);
					}
					if (job?.failedCount) {
						toast.error(`External-source Auto Reimport completed with ${job.failedCount} failure${job.failedCount === 1 ? "" : "s"}.`);
					}
					await this._refreshAssetRegistryStatus();
					await this.refreshAutoReimportWatchers();
					this.refresh();
				} catch (error) {
					console.error("Failed to automatically reimport a watched external source.", error);
					toast.error(`Auto Reimport failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			})();
		}, 300);
	}

	private async _refreshAssetRegistryStatus(): Promise<void> {
		await ensureAssetRegistry();
		const [status, indexing] = await Promise.all([getAssetRegistryStatus(), getAssetIndexingStatus()]);
		const hadActiveJob = this.state.assetIndexingActiveJob !== null;
		this.setState({
			assetRegistryEntries: status.entryCount,
			assetRegistryConflicts: status.duplicateGuidCount,
			assetRegistryMissingReferences: status.missingDependencyCount,
			assetIndexingWorkerAvailable: indexing.workerAvailable,
			assetIndexingActiveJob: indexing.activeJob,
		});
		if (this._assetIndexingStatusTimeout) {
			clearTimeout(this._assetIndexingStatusTimeout);
		}
		if (indexing.activeJob) {
			this._assetIndexingStatusTimeout = setTimeout(() => void this._refreshAssetRegistryStatus(), 500);
		} else if (hadActiveJob) {
			this.refresh();
		}
	}

	private _startBackgroundAssetIndexing(): void {
		try {
			startAssetIndexingJob({ mode: "rebuild" });
			void this._refreshAssetRegistryStatus();
			toast.success("Background asset indexing started.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _cancelBackgroundAssetIndexing(): void {
		const job = this.state.assetIndexingActiveJob;
		if (!job) {
			return;
		}
		try {
			cancelAssetIndexingJob(job.id);
			void this._refreshAssetRegistryStatus();
			toast.info("Asset indexing cancellation requested.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Returns wether or not the currently browsed folder is the /assets folder.
	 */
	public isAssetsFolder(): boolean {
		return this.state.browsedPath ? isInsideAssetRoot(this.state.browsedPath, join(dirname(projectConfiguration.path!), "/assets")) : false;
	}

	/**
	 * Returns wether or not the currently browsed folder is the /src folder.
	 */
	public isSrcFolder(): boolean {
		return this.state.browsedPath?.startsWith(join(dirname(projectConfiguration.path!), "/src")) ?? false;
	}

	private async _refreshFilesTreeNodes(path: string): Promise<void> {
		const files = await normalizedGlob(join(dirname(path), "**"), {
			ignore: {
				childrenIgnored: (p) => directoryPackagesExtensions.includes(extname(p.name).toLowerCase()),
				ignored: (p) => !p.isDirectory() || directoryPackagesExtensions.includes(extname(p.name).toLowerCase()),
			},
		});

		sortAlphabetically(files);

		const allNodes: TreeNodeInfo[] = [];
		const filesTreeNodes: TreeNodeInfo[] = [];

		const search = this.state.treeSearch.toLowerCase();

		files.forEach((f) => {
			const relative = f.replace(join(dirname(path), "/"), "");
			const split = relative.split("/") as string[];

			if (!split.find((s) => s.toLowerCase().includes(search))) {
				return;
			}

			for (let i = 0, len = split.length; i < len; ++i) {
				const relativePath = split.slice(0, i + 1).join("/");

				let node = allNodes.find((n) => n.id === relativePath);
				if (!node) {
					node = {
						label: <EditorAssetsTreeLabel name={split[i]} relativePath={relativePath} onDrop={(ev) => this._handleDropInTree(ev, relativePath)} />,
						id: relativePath,
						nodeData: relativePath,
						icon: <FaFolder className="w-4 h-4" />,
					};

					if (i === 0) {
						filesTreeNodes.push(node);
					} else {
						const parent = allNodes.find((n) => n.id === split.slice(0, i).join("/"));
						if (parent) {
							parent.childNodes ??= [];
							parent.childNodes.push(node);
						}
					}

					this._forEachNode(this.state.filesTreeNodes, (n) => {
						if (n.id === node!.id) {
							node!.isSelected = n.isSelected;
							node!.isExpanded = n.isExpanded;
						}
					});

					allNodes.push(node);
				}

				const hitsSearch = search && split[i].toLocaleLowerCase().includes(search);

				if (hitsSearch && !relativePath.startsWith("public") && !relativePath.startsWith("node_modules") && !relativePath.startsWith("editor-generated_")) {
					let tempNode = node;
					let parent: TreeNodeInfo | undefined = undefined;

					do {
						parent = allNodes.find((n) => {
							return n.childNodes?.find((c) => c.id === tempNode.id);
						});

						if (parent) {
							tempNode = parent;
							parent.isExpanded = true;
						}
					} while (parent !== undefined);
				}
			}
		});

		this.setState({
			filesTreeNodes: [
				{
					label: <div className="ml-2 p-1">Project</div>,
					id: "/",
					nodeData: "/",
					isExpanded: true,
					childNodes: filesTreeNodes,
					icon: <FaFolderOpen className="w-4 h-4" />,
				},
			],
		});
	}

	/**
	 * Sets the new path being browsed by the assets browser.
	 */
	public async setBrowsePath(path: string): Promise<void> {
		this.setState({
			gridSearch: "",
			browsedPath: path,
		});

		return this._refreshItems(path);
	}

	/**
	 * Refreshes the assets browser. This will refresh the files and the files tree nodes.
	 */
	public refresh(): void {
		this.setState({
			files: [],
		});

		const browsedPath = this.state.browsedPath ?? (projectConfiguration.path ? dirname(projectConfiguration.path) : null);
		if (browsedPath) {
			void this._getExistingBrowsePath(browsedPath)
				.then((path) => this.setBrowsePath(path))
				.catch((error) => {
					console.error("Failed to refresh the Assets Browser.", error);
				});
		}

		if (projectConfiguration.path) {
			this._refreshFilesTreeNodes(projectConfiguration.path!);
			void this._refreshImporterPresets();
		}
	}

	/**
	 * Returns the given path, or its closest existing parent when the browsed folder has been deleted or moved,
	 * so refreshing never keeps pointing at a folder that no longer exists.
	 */
	private async _getExistingBrowsePath(path: string): Promise<string> {
		const projectRoot = projectConfiguration.path ? dirname(projectConfiguration.path) : null;

		let current = path;
		while (!(await pathExists(current))) {
			const parent = dirname(current);
			if (parent === current || (projectRoot && !isInsideAssetRoot(parent, projectRoot))) {
				return projectRoot ?? path;
			}

			current = parent;
		}

		return current;
	}

	/**
	 * Copies the selected files.
	 */
	public copySelectedFiles(): void {
		this._selectedFiles = this.state.selectedKeys;

		const projectDir = join(dirname(projectConfiguration.path!), "/");
		const relativePaths = this.state.selectedKeys.map((f) => f.replace(projectDir, ""));

		clipboard.writeText(relativePaths.join("\n"));
	}

	private async _pasteSelectedFiles(): Promise<void> {
		if (!this._selectedFiles.length || !this.state.browsedPath) {
			return;
		}

		await Promise.all(
			this._selectedFiles.map(async (f) => {
				const fStat = await stat(f);
				const targetPath = join(this.state.browsedPath!, basename(f));

				if (fStat.isDirectory() || (await pathExists(targetPath))) {
					return;
				}

				await copyFile(f, join(this.state.browsedPath!, basename(f)));
			})
		);

		this.refresh();
	}

	/**
	 *  Handles the file renamed event. This will update the file paths in the editor.
	 */
	public async handleFileRenamed(oldAbsolutePath: string, newAbsolutePath: string): Promise<void> {
		const toastId = toast(<EditorAssetsBrowserRenameProgressComponent />, {
			duration: Infinity,
			dismissible: false,
		});

		const rootUrl = getProjectAssetsRootUrl();

		if (!rootUrl || !this.props.editor.state.projectPath) {
			return;
		}
		moveTextureChannelPreviewStates(oldAbsolutePath, newAbsolutePath);

		const oldRelativePath = oldAbsolutePath.replace(join(rootUrl, "/"), "");
		const newRelativePath = newAbsolutePath.replace(join(rootUrl, "/"), "");

		// Scene
		if (oldAbsolutePath === this.props.editor.state.lastOpenedScenePath) {
			await renameScene(oldAbsolutePath, newAbsolutePath);

			this._handleFileRenamed(oldRelativePath, newRelativePath);
			const sceneBuildSettings = renameSceneInBuildSettings(this.props.editor.state.sceneBuildSettings, oldRelativePath, newRelativePath);

			return this.props.editor.setState({ lastOpenedScenePath: newAbsolutePath, sceneBuildSettings }, () => {
				saveProjectConfiguration(this.props.editor);
			});
		}

		const fStat = await stat(newAbsolutePath);
		if (fStat.isDirectory()) {
			const extension = extname(newAbsolutePath).toLowerCase();
			if (extension === ".scene") {
				await renameScene(oldAbsolutePath, newAbsolutePath);
			}

			const files = (await normalizedGlob(join(newAbsolutePath, "**"), {
				ignore: {
					ignored: (p) => p.isDirectory() && extname(p.name).toLowerCase() !== ".scene",
				},
			})) as string[];

			for (const file of files) {
				const newFileRelativePath = file.replace(join(rootUrl, "/"), "");
				const oldFileRelativePath = newFileRelativePath.replace(newRelativePath, oldRelativePath);

				const extension = extname(oldFileRelativePath).toLowerCase();
				if (extension === ".scene") {
					const oldSceneAbsolutePath = join(rootUrl, oldFileRelativePath);
					await renameScene(oldSceneAbsolutePath, file);

					if (oldSceneAbsolutePath === this.props.editor.state.lastOpenedScenePath) {
						const sceneBuildSettings = renameSceneInBuildSettings(
							this.props.editor.state.sceneBuildSettings,
							oldSceneAbsolutePath.replace(rootUrl, ""),
							newFileRelativePath
						);
						this.props.editor.setState({ lastOpenedScenePath: file, sceneBuildSettings }, () => {
							saveProjectConfiguration(this.props.editor);
						});
					} else {
						await new Promise<void>((resolve) =>
							this.props.editor.setState(
								(state) => ({ sceneBuildSettings: renameSceneInBuildSettings(state.sceneBuildSettings, oldFileRelativePath, newFileRelativePath) }),
								resolve
							)
						);
						await saveProjectConfiguration(this.props.editor);
					}
				}

				this._handleFileRenamed(oldFileRelativePath, newFileRelativePath);
			}
		} else {
			this._handleFileRenamed(oldRelativePath, newRelativePath);
		}

		this.props.editor.layout.graph.refresh();
		this.props.editor.layout.inspector.forceUpdate();

		await saveAssetsCache();

		toast.dismiss(toastId);
		toast.success("Assets updated successfully");
	}

	private _handleFileRenamed(oldRelativePath: string, newRelativePath: string): void {
		const scene = this.props.editor.layout.preview.scene;

		// Textures
		scene.textures.forEach((texture) => {
			if (texture.name === oldRelativePath) {
				texture.name = newRelativePath;
				if (isTexture(texture)) {
					texture.url = newRelativePath;
				}
			}
		});

		// Sounds
		scene.transformNodes.forEach((node) => {
			if (isSoundNode(node) && node.soundRelativePath === oldRelativePath) {
				node.soundRelativePath = newRelativePath;
			}
		});

		// Scripts
		const nodes = [scene, ...scene.transformNodes, ...scene.meshes, ...scene.lights, ...scene.cameras];
		const scripts = nodes.map((node) => node.metadata?.scripts ?? []).flat();

		scripts.forEach((script) => {
			for (const v in script.values) {
				if (!script.values.hasOwnProperty(v)) {
					continue;
				}

				const value = script.values[v];
				if (!value.value) {
					continue;
				}

				if (value.type === "texture") {
					const serializationObject = value.value;
					if (serializationObject?.name === oldRelativePath) {
						serializationObject.name = newRelativePath;
						if (serializationObject.url) {
							serializationObject.url = newRelativePath;
						}
					}
				}

				if (value.type === "asset") {
					if (value.value === oldRelativePath) {
						value.value = newRelativePath;
					}
				}
			}
		});

		if (!oldRelativePath.includes(".scene") || oldRelativePath.endsWith(".scene")) {
			assetsCache[oldRelativePath] = {
				newRelativePath,
			};
		}
	}

	/**
	 * Adds the specified file to the selected files. This will add to the current selection the specified file.
	 */
	public addToSelectedFiles(absolutePath: string): void {
		if (!this.state.selectedKeys.includes(absolutePath)) {
			this.setState({ selectedKeys: [absolutePath] });
		}
	}

	/**
	 * Sets the selected file. This will clear the current selection and select the specified file.
	 */
	public setSelectedFile(absolutePath: string): void {
		if (this.state.selectedKeys.includes(absolutePath)) {
			return;
		}

		this.setState({ selectedKeys: [absolutePath] });
	}

	private async _handleDropInTree(ev: React.DragEvent<HTMLDivElement>, relativePath): Promise<void> {
		ev.preventDefault();
		ev.stopPropagation();

		if (!projectConfiguration.path) {
			return;
		}

		try {
			JSON.parse(ev.dataTransfer.getData("assets"));
		} catch (e) {
			return;
		}

		return this.handleMoveSelectedFilesTo(join(dirname(projectConfiguration.path), relativePath));
	}

	/**
	 * Handles the move selected files to event. This will move the selected files to the specified path.
	 */
	public async handleMoveSelectedFilesTo(absolutePath: string): Promise<void> {
		const files = this.state.selectedKeys;

		for (const file of files) {
			await this.moveAssetWithReferences(file, join(absolutePath, basename(file)));
		}

		this.refresh();
	}

	/** Plans, confirms, and applies a GUID-preserving semantic asset move from the visible editor. */
	public async moveAssetWithReferences(oldAbsolutePath: string, newAbsolutePath: string): Promise<void> {
		const root = dirname(projectConfiguration.path!);
		const sourcePath = relative(root, oldAbsolutePath).replace(/\\/g, "/");
		const destinationPath = relative(root, newAbsolutePath).replace(/\\/g, "/");
		const plan = await inspectSemanticAssetMove({ sourcePath, destinationPath });
		if (plan.blockers.length) {
			showAlert(
				"Asset Move Blocked",
				`${plan.blockers.length} indexed reference source(s) cannot be rewritten safely. Inspect the move through MCP and repair or re-export the reported malformed, oversized, or semantically unsupported referencer before moving.`,
				true
			);
			throw new Error(`Asset move is blocked by ${plan.blockers.length} unsafe reference source(s).`);
		}
		if (plan.totalReplacementCount) {
			const confirmed = await showConfirm(
				"Update Asset References?",
				`Move this asset and update ${plan.totalReplacementCount} semantic reference(s) in ${plan.rewrites.length} file(s)? The operation rolls back if any write fails.`
			);
			if (!confirmed) {
				return;
			}
		}
		const result = await applySemanticAssetMove({ sourcePath, destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		await refreshAssetRegistryPaths([oldAbsolutePath, newAbsolutePath, ...result.updatedReferences]);
		await this.handleFileRenamed(oldAbsolutePath, newAbsolutePath);
		this.refresh();
	}

	private async _refreshItems(path: string): Promise<void> {
		let files = await readdir(path);
		files = files.filter((f) => {
			if (f.charAt(0) === ".") {
				return false;
			}
			if (isAssetMetadataPath(f)) {
				return false;
			}

			if (f.startsWith("editor-generated_") && !this.state.showGeneratedFiles) {
				return false;
			}

			return true;
		});

		const root = dirname(projectConfiguration.path!);
		const relativePath = path.replace(`${root}/`, "").replace(/\\/g, "/");
		if (relativePath === "assets" || relativePath === "src" || relativePath.startsWith("assets/") || relativePath.startsWith("src/")) {
			const directories = (await Promise.all(files.map(async (file) => ({ file, directory: (await stat(join(path, file))).isDirectory() }))))
				.filter((entry) => entry.directory)
				.map((entry) => entry.file);
			const result = await queryAssetRegistry({ folder: relativePath, recursive: false, limit: 500 });
			const directEntries = result.entries.filter((entry: any) => dirname(entry.path) === relativePath);
			const registryFiles = directEntries
				.filter(
					(entry: any) =>
						this.state.assetViewFilter === "all" ||
						(this.state.assetViewFilter === "favorites" ? entry.favorite : ["unchecked", "stale", "missing", "error"].includes(entry.importState.status))
				)
				.map((entry: any) => entry.name);
			const assetRegistryMetadata = Object.fromEntries(
				directEntries.map((entry: any) => [entry.name, { favorite: entry.favorite, tags: entry.tags, importStatus: entry.importState.status }])
			);
			files = [...new Set([...directories, ...registryFiles])].sort();
			this.setState({ assetRegistryMetadata });
		}

		this.setState({ files });
	}

	private _getFilesGridComponent(): ReactNode {
		return (
			<div className="flex flex-col w-full h-full">
				<div className="flex gap-2 justify-between px-2 w-full h-10 min-h-10 bg-input">
					<div className="flex gap-2 items-center h-full">
						<Button
							variant="ghost"
							disabled={this._isBrowsingProjectRootPath()}
							className="w-8 h-8 p-0.5"
							title="Go to previous directory"
							onClick={() => this.setBrowsePath(dirname(this.state.browsedPath!))}
						>
							<FaArrowLeft className="w-4 h-4" />
						</Button>
						<Button variant="ghost" className="w-8 h-8 p-0.5" title="Go to previous directory">
							<FaArrowRight className="w-4 h-4" />
						</Button>
						<Button variant="ghost" className="w-8 h-8 p-0.5" disabled={!this.state.browsedPath} title="Refresh" onClick={() => this.refresh()}>
							<MdOutlineRefresh className="w-5 h-5" />
						</Button>

						<Button variant="ghost" className="gap-2 w-24 h-8 p-0.5" title="Import existing assets to current directory" onClick={() => this._handleImportFiles()}>
							<IoArrowDownCircleOutline className="w-5 h-5" /> Import
						</Button>
					</div>

					<div className="flex gap-2 items-center">
						<div className="relative">
							<Input
								placeholder="Search"
								value={this.state.gridSearch}
								onChange={(e) => this.setState({ gridSearch: e.currentTarget.value })}
								className={`
                                    max-w-52 w-full h-8 !border-none pl-7
                                    hover:border-border focus:border-border
                                    transition-all duration-300 ease-in-out    
                                `}
							/>

							<FaMagnifyingGlass className="absolute top-1/2 -translate-y-1/2 left-2 w-4 h-4" />
						</div>

						<DropdownMenu onOpenChange={(o) => o && this.forceUpdate()}>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" className="w-8 h-8 p-0.5" disabled={!this.state.browsedPath} onClick={() => this._refreshItems(this.state.browsedPath!)}>
									<IoIosOptions className="w-6 h-6" strokeWidth={1} />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuItem disabled>
									Asset Registry: {this.state.assetRegistryEntries} indexed
									{this.state.assetRegistryConflicts
										? `, ${this.state.assetRegistryConflicts} GUID conflict(s)`
										: this.state.assetRegistryMissingReferences
											? ""
											: ", healthy"}
									{this.state.assetRegistryMissingReferences ? `, ${this.state.assetRegistryMissingReferences} missing reference(s)` : ""}
								</DropdownMenuItem>
								{this.state.assetIndexingActiveJob && (
									<DropdownMenuItem disabled>
										Indexing: {this.state.assetIndexingActiveJob.phase} {this.state.assetIndexingActiveJob.processedFiles}/
										{this.state.assetIndexingActiveJob.totalFiles || "?"} ({this.state.assetIndexingActiveJob.workerCount} workers)
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									disabled={!this.state.assetIndexingWorkerAvailable || this.state.assetIndexingActiveJob !== null}
									onClick={() => this._startBackgroundAssetIndexing()}
								>
									Rebuild Registry in Background
								</DropdownMenuItem>
								{this.state.assetIndexingActiveJob && (
									<DropdownMenuItem onClick={() => this._cancelBackgroundAssetIndexing()}>Cancel Background Indexing</DropdownMenuItem>
								)}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									disabled={this.state.selectedKeys.length !== 1}
									onClick={async () => {
										const selected = this.state.selectedKeys[0];
										if (selected && (await pathExists(selected)) && !(await stat(selected)).isDirectory()) {
											openAssetDependencyGraph(this.props.editor, relative(dirname(projectConfiguration.path!), selected));
										}
									}}
								>
									Open Dependency Graph
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								{(["all", "favorites", "problems"] as const).map((filter) => (
									<DropdownMenuItem
										key={filter}
										className="flex gap-1 items-center"
										onClick={() => this.setState({ assetViewFilter: filter }, () => this._refreshItems(this.state.browsedPath!))}
									>
										{this.state.assetViewFilter === filter ? <IoCheckmark /> : ""}{" "}
										{filter === "all" ? "All Assets" : filter === "favorites" ? "Favorites Only" : "Import Problems Only"}
									</DropdownMenuItem>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="flex gap-1 items-center"
									onClick={() => {
										this.setState({ showGeneratedFiles: !this.state.showGeneratedFiles }, () => this.refresh());
									}}
								>
									{this.state.showGeneratedFiles ? <IoCheckmark /> : ""} Show Generated Files
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									disabled={processingCompressedTextures || !this.props.editor.state.compressedTexturesEnabledInPreview}
									className="flex gap-2 items-center"
									onClick={() => checkProjectCachedCompressedTextures(this.props.editor)}
								>
									{processingCompressedTextures && <Grid width={14} height={14} color="#ffffff" />}
									Check Compressed Textures
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>

				{this._getBreadcrumbComponent()}
				{this._getGridComponent()}
			</div>
		);
	}

	private _getBreadcrumbComponent(): ReactNode {
		if (!this.state.browsedPath) {
			return null;
		}

		const browsedPath = join(this.state.browsedPath, "/");
		const rootPath = join(dirname(projectConfiguration.path!), "/");

		const relativePath = browsedPath.replace(rootPath, "");

		const split = relativePath.split("/").filter((s) => s !== "");
		split.splice(0, 0, "Project");

		return (
			<div className="flex items-center px-2.5 h-10 min-h-10 bg-input/50">
				<Breadcrumb>
					<BreadcrumbList>
						{split
							.filter((s) => s !== "")
							.map((s, i) => (
								<Fade key={i} delay={0} duration={300}>
									<BreadcrumbItem className="flex gap-[5px] items-center">
										{(i === 0 || i < split.length - 1) && <FaRegFolderOpen className="text-foreground w-[20px] h-[20px]" />}

										<BreadcrumbLink
											className="text-foreground font-[400] hover:text-foreground/50"
											onClick={() => this.setBrowsePath(join(rootPath, split.slice(1, i + 1).join("/")))}
										>
											{s}
										</BreadcrumbLink>
									</BreadcrumbItem>

									{i < split.length - 1 && <BreadcrumbSeparator />}
								</Fade>
							))}
					</BreadcrumbList>
				</Breadcrumb>
			</div>
		);
	}

	private _getGridComponent(): ReactNode {
		return (
			<SelectableGroup
				className="w-full min-h-full pb-20"
				enabled={this.state.selectionEnabled}
				onNonItemClick={() => this.setState({ selectedKeys: [] })}
				onSelection={(keys: string[]) => this.setState({ selectedKeys: keys })}
			>
				<ContextMenu>
					<ContextMenuTrigger>
						<div
							style={{
								gridTemplateRows: `repeat(auto-fill, ${120 * 1}px)`,
								gridTemplateColumns: `repeat(auto-fill, ${120 * 1}px)`,
							}}
							onMouseMove={() => (this._isMouseOver = true)}
							onMouseLeave={() => (this._isMouseOver = false)}
							onDragOver={(ev) => this._handleDragOver(ev)}
							onDragLeave={() => this.setState({ dragAndDroppingFiles: false })}
							onDrop={(ev) => this._handleDrop(ev)}
							className={`
                                grid gap-4 justify-left w-full h-full p-5 overflow-y-auto pb-10
                                ${this.state.dragAndDroppingFiles ? "bg-primary/10" : ""}
                                transition-colors duration-300 ease-in-out    
                            `}
						>
							{this.state.files
								.filter((f) => f.toLowerCase().includes(this.state.gridSearch.toLowerCase()))
								.map((f) => {
									const key = join(this.state.browsedPath!, f);
									const selected = this.state.selectedKeys.indexOf(key) > -1;

									return this._getAssetBrowserItem(f, key, selected);
								})}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem className="flex items-center gap-2" onClick={() => this._refreshItems(this.state.browsedPath!)}>
							<IoRefresh className="w-5 h-5" /> Refresh
						</ContextMenuItem>

						<ContextMenuSeparator />

						<ContextMenuItem disabled={this._selectedFiles.length === 0} onClick={() => this._pasteSelectedFiles()}>
							Paste
						</ContextMenuItem>

						{(this.isAssetsFolder() || this.isSrcFolder()) && (
							<>
								<ContextMenuSeparator />
								<ContextMenuSub>
									<ContextMenuSubTrigger className="flex items-center gap-2">
										<AiOutlinePlus className="w-5 h-5" /> Add
									</ContextMenuSubTrigger>
									<ContextMenuSubContent>
										{this.isAssetsFolder() && this._getAssetsContextMenuItems()}
										{this.isSrcFolder() && this._getSrcContextMenuItems()}
									</ContextMenuSubContent>
								</ContextMenuSub>
							</>
						)}

						{this.state.selectedKeys.length > 0 && (
							<>
								<ContextMenuSeparator />
								<ContextMenuItem onClick={() => void this._setSelectedFavorite(true)}>Add to Project Favorites</ContextMenuItem>
								<ContextMenuItem onClick={() => void this._setSelectedFavorite(false)}>Remove from Project Favorites</ContextMenuItem>
								<ContextMenuItem onClick={() => void this._editSelectedTags()}>Edit Tags...</ContextMenuItem>
								<ContextMenuSeparator />
								<ContextMenuSub>
									<ContextMenuSubTrigger>Importer Presets</ContextMenuSubTrigger>
									<ContextMenuSubContent>
										<ContextMenuItem onClick={() => this._saveSelectedImporterPreset()}>Save Selected Asset as Preset...</ContextMenuItem>
										<ContextMenuSeparator />
										{this.state.importerPresets.length ? (
											this.state.importerPresets.map((preset) => (
												<ContextMenuItem key={preset.name} onClick={() => this._applyImporterPreset(preset.name)}>
													Apply {preset.name}
												</ContextMenuItem>
											))
										) : (
											<ContextMenuItem disabled>No saved presets</ContextMenuItem>
										)}
									</ContextMenuSubContent>
								</ContextMenuSub>
							</>
						)}

						<ContextMenuSeparator />

						<ContextMenuItem className="flex items-center gap-2" onClick={() => this._handleCreateDirectory()}>
							<AiOutlinePlus className="w-5 h-5" /> Create Directory
						</ContextMenuItem>
					</ContextMenuContent>
				</ContextMenu>
			</SelectableGroup>
		);
	}

	private _getAssetsContextMenuItems(): ReactNode {
		return (
			<>
				<ContextMenuItem onClick={() => this._handleAddScene()}>Scene</ContextMenuItem>
				<ContextMenuSeparator />
				{getMaterialCommands(this.props.editor).map((command) => (
					<ContextMenuItem key={command.key} onClick={() => this._handleAddMaterial(command)}>
						{command.text}
					</ContextMenuItem>
				))}

				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => this._handleAddNodeMaterialFromSnippet()}>Node Material From Snippet...</ContextMenuItem>
				<ContextMenuSeparator />

				<ContextMenuSub>
					<ContextMenuSubTrigger className="flex items-center gap-2">Materials Library</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						{getMaterialsLibraryCommands(this.props.editor).map((command) => (
							<ContextMenuItem key={command.key} onClick={() => this._handleAddMaterial(command)}>
								{command.text}
							</ContextMenuItem>
						))}
					</ContextMenuSubContent>
				</ContextMenuSub>

				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => this._handleAddNodeParticleSystem()}>Node Particle System</ContextMenuItem>
				<ContextMenuItem onClick={() => this._handleAddAudioGenerator()}>Audio Generator</ContextMenuItem>

				{this.props.editor.state.enableExperimentalFeatures && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onClick={() => this._handleAddCinematic()}>Cinematic</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuItem onClick={() => this._handleAddNavmesh()}>Navmesh</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuItem onClick={() => this._handleAddRagdoll()}>Ragdoll</ContextMenuItem>
					</>
				)}

				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => this._handleAddFullScreenGUI()}>Fullscreen GUI</ContextMenuItem>
			</>
		);
	}

	private async _refreshImporterPresets(): Promise<void> {
		if (!projectConfiguration.path) {
			return;
		}
		try {
			this.setState({ importerPresets: (await listAssetImporterPresets()).presets });
		} catch {
			this.setState({ importerPresets: [] });
		}
	}

	private async _saveSelectedImporterPreset(): Promise<void> {
		const sourcePath = this.state.selectedKeys[0];
		if (!sourcePath) {
			return;
		}
		try {
			const details = await getAssetDetails(this.props.editor.layout.preview.scene, { path: sourcePath });
			if (details.isDirectory) {
				throw new Error("Select a file asset to save its importer settings as a preset.");
			}
			const name = await showPrompt("Save Importer Preset", "Name this reusable importer preset.", details.name.replace(extname(details.name), ""));
			if (!name?.trim()) {
				return;
			}
			await setAssetImporterPreset(this.props.editor.layout.preview.scene, {
				name,
				importer: details.metadata?.importer ?? {},
				labels: details.metadata?.labels ?? [],
				extensions: details.extension ? [details.extension] : [],
			});
			await this._refreshImporterPresets();
			toast.success(`Saved importer preset "${name}".`);
		} catch (error: any) {
			toast.error(`Unable to save importer preset: ${error.message}`);
		}
	}

	private async _applyImporterPreset(name: string): Promise<void> {
		try {
			const files = await Promise.all(this.state.selectedKeys.map(async (path) => ((await stat(path)).isDirectory() ? null : path)));
			const paths = files.filter((path): path is string => !!path);
			if (!paths.length) {
				throw new Error("Select one or more file assets before applying a preset.");
			}
			const result = await applyAssetImporterPreset(this.props.editor.layout.preview.scene, { name, paths }, { editor: this.props.editor });
			toast.success(`Applied ${name} to ${result.applied.length} asset${result.applied.length === 1 ? "" : "s"}.`);
			this.refresh();
		} catch (error: any) {
			toast.error(`Unable to apply importer preset: ${error.message}`);
		}
	}

	private _getSrcContextMenuItems(): ReactNode {
		return (
			<>
				<ContextMenuItem onClick={() => this._handleAddScript("class")}>Class-based Script</ContextMenuItem>
				<ContextMenuItem onClick={() => this._handleAddScript("function")}>Function-based Script</ContextMenuItem>
			</>
		);
	}

	private async _setSelectedFavorite(favorite: boolean): Promise<void> {
		try {
			const files: string[] = [];
			for (const path of this.state.selectedKeys.slice(0, 100)) {
				if (!(await pathExists(path)) || (await stat(path)).isDirectory()) {
					continue;
				}
				const metadata = await readAssetMetadata(path);
				await writeAssetMetadata(path, { ...metadata, favorite });
				files.push(path);
			}
			if (!files.length) {
				throw new Error("Select at least one file asset.");
			}
			await refreshAssetRegistryPaths(files);
			await this._refreshItems(this.state.browsedPath!);
			toast.success(`${favorite ? "Added" : "Removed"} ${files.length} asset(s) ${favorite ? "to" : "from"} project favorites.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _editSelectedTags(): Promise<void> {
		try {
			const files: string[] = [];
			for (const path of this.state.selectedKeys.slice(0, 100)) {
				if ((await pathExists(path)) && !(await stat(path)).isDirectory()) {
					files.push(path);
				}
			}
			if (!files.length) {
				throw new Error("Select at least one file asset.");
			}
			const current = files.length === 1 ? (await readAssetMetadata(files[0])).tags.join(", ") : "";
			const value = await showPrompt("Asset Tags", "Enter comma-separated project tags. These are separate from build/import labels.", current);
			if (value === null) {
				return;
			}
			const tags = value
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean);
			for (const path of files) {
				const metadata = await readAssetMetadata(path);
				await writeAssetMetadata(path, { ...metadata, tags });
			}
			await refreshAssetRegistryPaths(files);
			await this._refreshItems(this.state.browsedPath!);
			toast.success(`Updated tags for ${files.length} asset(s).`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _getAssetBrowserItem(filename: string, key: string, selected: boolean): ReactNode {
		const extension = extname(filename).toLowerCase();

		const props: IAssetsBrowserItemProps & { key: string } = {
			key,
			selected,
			absolutePath: key,
			selectableKey: key,
			editor: this.props.editor,
			onRefresh: () => this.refresh(),
			onClick: (ev, i, c) => this._handleItemClick(ev, i, c),
			onDoubleClick: (i) => this._handleItemDoubleClick(i),
			setSelectionEnabled: (e) => this.setState({ selectionEnabled: e }),
			favorite: this.state.assetRegistryMetadata[filename]?.favorite,
			importStatus: this.state.assetRegistryMetadata[filename]?.importStatus,
		};

		if (filename.toLowerCase().endsWith(".audio-generator.json")) {
			return <AudioGeneratorSelectable {...props} />;
		}

		switch (extension) {
			case ".abc":
				return <DefaultSelectable {...props} />;

			case ".x":
			case ".dae":
			case ".dxf":
			case ".b3d":
			case ".stl":
			case ".fbx":
			case ".3ds":
			case ".glb":
			case ".obj":
			case ".lwo":
			case ".gltf":
			case ".ms3d":
			case ".blend":
			case ".babylon":
				return <MeshSelectable {...props} />;

			case ".material":
				return <MaterialSelectable {...props} />;

			case ".scene":
				return <SceneSelectable {...props} />;

			case ".png":
			case ".jpg":
			case ".jpeg":
			case ".bmp":
			case ".webp":
			case ".gif":
			case ".tif":
			case ".tiff":
			case ".tga":
			case ".psd":
			case ".psb":
				return <ImageSelectable {...props} />;

			case ".hdr":
			case ".exr":
				return <HDRSelectable {...props} />;

			case ".json":
				return <JsonSelectable {...props} />;

			case ".gui":
				return <GuiSelectable {...props} />;

			case ".cinematic":
				return <CinematicSelectable {...props} />;

			case ".npss":
				return <ParticleSystemSelectable {...props} />;

			case ".navmesh":
				return <NavmeshSelectable {...props} />;

			case ".ragdoll":
				return <RagdollSelectable {...props} />;

			case ".js":
				return <JavascriptSelectable {...props} />;

			default:
				return <DefaultSelectable {...props} />;
		}
	}

	private _handleDragOver(event: DragEvent<HTMLDivElement>): void {
		event.preventDefault();

		const isGraphNode = event.dataTransfer.types.includes("graph/node");
		const isFiles = event.dataTransfer.types.length === 1 && event.dataTransfer.types[0] === "Files";

		this.setState({
			dragAndDroppingFiles: isFiles || isGraphNode,
		});
	}

	private async _handleDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
		event.persist();
		event.preventDefault();

		this.setState({
			dragAndDroppingFiles: false,
		});

		if (!this.state.browsedPath) {
			return;
		}

		// Nodes from graph?
		try {
			const data = JSON.parse(event.dataTransfer.getData("graph/node")) as string[];
			if (data?.length) {
				return this._handleDroppedNodesFromGraph(data);
			}
		} catch (e) {
			// Catch silently.
		}

		// Those are files.
		let assetPlacementWarning: string | null = null;

		const filesToCopy: Record<string, string> = {};

		for (let i = 0, len = event.dataTransfer.files.length; i < len; ++i) {
			const file = event.dataTransfer.files.item(i);
			if (!file) {
				continue;
			}

			const path = webUtils.getPathForFile(file).replace(/\\/g, "/");
			const absolutePath = join(this.state.browsedPath, basename(path));

			if (!this.isAssetsFolder()) {
				const placement = await inspectAssetRootPlacement(path, absolutePath, join(dirname(projectConfiguration.path!), "/assets"));
				if (!placement.allowed) {
					assetPlacementWarning ??= assetRootPlacementError(placement);
					continue;
				}
			}

			filesToCopy[path] = absolutePath;
		}

		if (assetPlacementWarning) {
			showAlert(
				"Warning",
				<div>
					{assetPlacementWarning}
					<br />
					Other safe project files were copied normally.
				</div>,
				true
			);
		}

		await Promise.all(
			Object.entries(filesToCopy).map(async ([source, destination]) => {
				const fStat = await stat(source);
				if (fStat.isDirectory()) {
					await copy(source, destination, {
						recursive: true,
					});
				} else {
					await copyFile(source, destination);
				}
			})
		);

		this.refresh();
	}

	private async _handleDroppedNodesFromGraph(nodeIds: string[]): Promise<void> {
		if (!this.state.browsedPath || !this.props.editor.state.enableExperimentalFeatures) {
			return;
		}

		if (!this.isAssetsFolder()) {
			showAlert("Warning", <div>You can only export nodes to at least in the root "assets" folder.</div>, true);
			return;
		}

		for (const nodeId of nodeIds) {
			const node = this.props.editor.layout.preview.scene.getNodeById(nodeId);
			if (node) {
				const scenePath = join(this.state.browsedPath, `${filenamify(node.name)}.babylon`);
				if (await pathExists(scenePath)) {
					const overwrite = await showConfirm("Overwrite Scene?", `A scene named "${node.name}" already exists at this location. Do you want to overwrite it?`);
					if (!overwrite) {
						continue;
					}
				}

				await exportNodeToPath(this.props.editor, node, join(this.state.browsedPath, `${filenamify(node.name)}.babylon`));
			}
		}

		return this.refresh();
	}

	private async _handleCreateDirectory(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const name = await findAvailableFilename(this.state.browsedPath, "New Folder", "");
		await mkdir(join(this.state.browsedPath, name));
		await this._refreshItems(this.state.browsedPath);

		this.setState({
			selectedKeys: [join(this.state.browsedPath, name)],
		});
	}

	private async _handleImportFiles(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const files = openMultipleFilesDialog({
			title: "Import Files & Folders",
		});

		let assetPlacementWarning: string | null = null;

		await Promise.all(
			files.map(async (file) => {
				const destination = join(this.state.browsedPath!, basename(file));

				const fStat = await stat(file);
				if (!this.isAssetsFolder()) {
					const placement = await inspectAssetRootPlacement(file, destination, join(dirname(projectConfiguration.path!), "/assets"));
					if (!placement.allowed) {
						assetPlacementWarning ??= assetRootPlacementError(placement);
						return;
					}
				}

				if (fStat.isDirectory()) {
					await copy(file, destination, {
						recursive: true,
					});
				} else {
					await copyFile(file, destination);
				}
			})
		);

		if (assetPlacementWarning) {
			showAlert(
				"Warning",
				<div>
					{assetPlacementWarning}
					<br />
					Other safe project files were copied normally.
				</div>,
				true
			);
		}

		this._refreshItems(this.state.browsedPath);
	}

	private async _handleAddScene(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		let name = await showPrompt("Scene Name", "Enter the name of the new scene", "New Scene");
		if (!name) {
			return;
		}

		name = await findAvailableFilename(this.state.browsedPath, name, ".scene");

		const scene = this.props.editor.layout.preview.scene;
		const absolutePath = join(this.state.browsedPath, name);
		const serializedCamera = this.props.editor.layout.preview.camera.serialize();

		await mkdir(absolutePath);

		const config = {
			newScene: true,
			metadata: {},
			environment: {
				environmentIntensity: 1,
			},
			fog: {
				fogEnabled: scene.fogEnabled,
				fogMode: scene.fogMode,
				fogStart: scene.fogStart,
				fogEnd: scene.fogEnd,
				fogDensity: scene.fogDensity,
				fogColor: scene.fogColor.asArray(),
			},
			editorCamera: serializedCamera,
		};

		await writeJSON(join(absolutePath, "config.json"), config, {
			spaces: "\t",
			encoding: "utf-8",
		});

		const previewContent = await fetch("assets/new-scene-preview.png").then((r) => r.arrayBuffer());
		await writeFile(join(absolutePath, "preview.png"), Buffer.from(previewContent));

		if (this.props.editor.state.projectPath) {
			const scenePath = relative(dirname(this.props.editor.state.projectPath), absolutePath);
			const sceneBuildSettings = addSceneToBuildSettings(this.props.editor.state.sceneBuildSettings, scenePath);
			await new Promise<void>((resolve) => this.props.editor.setState({ sceneBuildSettings }, resolve));
			await saveProjectConfiguration(this.props.editor);
		}

		this._refreshItems(this.state.browsedPath!);

		const openResult = await showConfirm("Open New Scene", "Do you want to open the new scene now?");
		if (openResult) {
			this._handleLoadScene(absolutePath, true);
		}
	}

	private async _handleAddMaterial(command: ICommandPaletteType): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const material = command.action() as Material | null;

		if (!material) {
			return;
		}

		const name = await findAvailableFilename(this.state.browsedPath, material.name, ".material");
		await writeJSON(join(this.state.browsedPath, name), material.serialize(), {
			spaces: "\t",
			encoding: "utf-8",
		});

		material.dispose();

		return this._refreshItems(this.state.browsedPath);
	}

	private async _handleAddNodeMaterialFromSnippet(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const id = await showPrompt("Snippet Id", "Enter the Node Material Snippet Id you want to import");
		if (!id) {
			return;
		}

		const material = await NodeMaterial.ParseFromSnippetAsync(id, this.props.editor.layout.preview.scene);
		material.id = Tools.RandomId();
		material.uniqueId = UniqueNumber.Get();

		const name = await findAvailableFilename(this.state.browsedPath, filenamify(material.name), ".material");
		await writeJSON(join(this.state.browsedPath, name), material.serialize(), {
			spaces: "\t",
			encoding: "utf-8",
		});

		material.dispose();

		return this._refreshItems(this.state.browsedPath);
	}

	private _handleAddNodeParticleSystem(): void {
		if (!this.state.browsedPath) {
			return;
		}
		this.setState({ vfxTemplateBrowserOpen: true });
	}

	private async _handleAddAudioGenerator(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}
		try {
			const name = await findAvailableFilename(this.state.browsedPath, "New Audio Generator", ".audio-generator.json");
			await writeScriptableAudioAsset(join(this.state.browsedPath, name), createDefaultScriptableAudioGeneratorGraph());
			await this._refreshItems(this.state.browsedPath);
			toast.success(`Created ${name}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	/** Creates a path-seeded version-2 document instead of the original unversioned placeholder. */
	private async _handleAddCinematic(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const name = await findAvailableFilename(this.state.browsedPath, "New Cinematic", ".cinematic");
		const absolutePath = join(this.state.browsedPath, name);
		const projectDirectory = this.props.editor.state.projectPath ? dirname(this.props.editor.state.projectPath) : this.state.browsedPath;
		const identitySeed = relative(projectDirectory, absolutePath).replace(/\\/g, "/");
		const cinematic = normalizeCinematicDocument({ name: "New Cinematic", tracks: [], framesPerSecond: 60, outputFramesPerSecond: 60 }, { identitySeed });
		await createCinematicDocumentFile(absolutePath, cinematic, { identitySeed });

		return this._refreshItems(this.state.browsedPath);
	}

	private async _handleAddNavmesh(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const cellSize = 10;
		const walkableRadius = 10;
		const walkableHeight = 10;
		const navmeshParameters = {
			ch: 1,
			cs: cellSize,
			walkableHeight: Math.round(walkableHeight / cellSize),
			walkableRadius: Math.round(walkableRadius / cellSize),
			keepIntermediates: true,
		} as INavMeshParametersV2;

		const configuration: INavMeshConfiguration = {
			navMeshParameters: navmeshParameters,
			staticMeshes: [],
			obstacleMeshes: [],
		};

		const name = await findAvailableFilename(this.state.browsedPath, "New NavMesh", ".navmesh");

		await mkdir(join(this.state.browsedPath, name));
		await writeJSON(join(this.state.browsedPath, name, "config.json"), configuration, {
			spaces: "\t",
			encoding: "utf-8",
		});

		return this._refreshItems(this.state.browsedPath);
	}

	private async _handleAddRagdoll(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const configuration: IRagDollConfiguration = {
			rootNodeId: "",
			scalingFactor: 100,
			runtimeConfiguration: [],
		};

		const name = await findAvailableFilename(this.state.browsedPath, "New Ragdoll", ".ragdoll");
		await writeJSON(join(this.state.browsedPath, name), configuration, {
			spaces: "\t",
			encoding: "utf-8",
		});

		return this._refreshItems(this.state.browsedPath);
	}

	private async _handleAddFullScreenGUI(): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const gui = AdvancedDynamicTexture.CreateFullscreenUI("New GUI", true, this.props.editor.layout.preview.scene);
		gui.uniqueId = UniqueNumber.Get();

		const data = gui.serialize();
		data.uniqueId = gui.uniqueId;
		data.content = gui.serializeContent();
		data.guiType = "fullscreen";
		data.zvibeGUIAuthoring = createDefaultGUIAuthoringState();

		const name = await findAvailableFilename(this.state.browsedPath, gui.name, ".gui");
		await writeJSON(join(this.state.browsedPath, name), data, {
			spaces: "\t",
			encoding: "utf-8",
		});

		gui.dispose();

		return this._refreshItems(this.state.browsedPath);
	}

	private async _handleAddScript(type: "class" | "function"): Promise<void> {
		if (!this.state.browsedPath) {
			return;
		}

		const url = type === "class" ? "assets/class-based-script.ts" : "assets/function-based-script.ts";

		const content = await fetch(url).then((r) => r.text());

		const name = await findAvailableFilename(this.state.browsedPath, "new-script", ".ts");
		const scriptPath = join(this.state.browsedPath, name);

		await writeFile(scriptPath, content, {
			encoding: "utf-8",
		});

		this.setState({
			selectedKeys: [scriptPath],
		});

		return this._refreshItems(this.state.browsedPath);
	}

	/**
	 * Returns whether the browsed path is the project root path.
	 * @returns Whether the browsed path is the project root path.
	 */
	private _isBrowsingProjectRootPath(): boolean {
		if (!this.state.browsedPath) {
			return true;
		}

		return join(this.state.browsedPath!) === join(dirname(projectConfiguration.path!));
	}

	private async _handleItemClick(event: MouseEvent<HTMLDivElement, globalThis.MouseEvent>, item: AssetsBrowserItem, contextMenu: boolean): Promise<void> {
		if (contextMenu && this.state.selectedKeys.includes(item.props.selectableKey)) {
			return;
		}

		if (event.ctrlKey || event.metaKey) {
			if (this.state.selectedKeys.includes(item.props.selectableKey)) {
				this.setState({ selectedKeys: this.state.selectedKeys.filter((k) => k !== item.props.selectableKey) });
			} else {
				this.setState({ selectedKeys: [...this.state.selectedKeys, item.props.selectableKey] });
			}
		} else if (event.shiftKey) {
			this._handleShiftItemClick(item);
		} else {
			this.setState({ selectedKeys: [item.props.selectableKey] });
		}

		if (!item.state.isDirectory) {
			this.props.editor.layout.inspector.setEditedObject(new FileInspectorObject(item.props.absolutePath));
		}
	}

	private _handleShiftItemClick(item: AssetsBrowserItem): void {
		let lastSelected!: string;
		let firstSelected!: string;

		this.state.files.forEach((path) => {
			const absolutePath = join(this.state.browsedPath!, path);

			if (absolutePath === item.props.selectableKey) {
				if (!firstSelected) {
					firstSelected = path;
				} else {
					lastSelected = path;
				}
			} else if (this.state.selectedKeys.includes(absolutePath)) {
				if (!firstSelected) {
					firstSelected = path;
				} else {
					lastSelected = path;
				}
			}
		});

		if (!lastSelected || !firstSelected) {
			return;
		}

		const selectedKeys: string[] = [];

		let select = false;

		this.state.files.forEach((path) => {
			if (path === firstSelected) {
				select = true;
			}

			if (select) {
				selectedKeys.push(join(this.state.browsedPath!, path));
			}

			if (path === lastSelected) {
				select = false;
			}
		});

		this.setState({ selectedKeys });
	}

	private async _handleItemDoubleClick(item: AssetsBrowserItem): Promise<unknown> {
		if (item.state.isDirectory) {
			const extension = extname(item.props.absolutePath).toLowerCase();
			if (extension === ".scene") {
				this._handleLoadScene(item.props.absolutePath);
			} else if (!directoryPackagesExtensions.includes(extension)) {
				this.setBrowsePath(item.props.absolutePath);
			}

			return;
		}
		if (item.props.absolutePath.toLowerCase().endsWith(".audio-generator.json")) {
			return;
		}

		const extension = extname(item.props.absolutePath).toLowerCase();
		switch (extension) {
			case ".abc":
			case ".md":
			case ".png":
			case ".webp":
			case ".jpg":
			case ".bmp":
			case ".jpeg":
			case ".gif":
			case ".tif":
			case ".tiff":
			case ".tga":
			case ".psd":
			case ".psb":
			case ".hdr":
			case ".exr":
			case ".mp3":
			case ".wav":
			case ".wave":
				return this.props.editor.layout.inspector.setEditedObject(new FileInspectorObject(item.props.absolutePath));

			case ".glb":
			case ".gltf":
			case ".babylon":
			case ".fbx":
				return openModelViewer(this.props.editor, item.props.absolutePath);

			case ".env":
				return openEnvViewer(item.props.absolutePath);

			case ".prefab":
				return openPrefabMode(this.props.editor, item.props.absolutePath);

			case ".uxml":
			case ".uss":
				return openInExternalEditor(this.props.editor.state.externalEditorCommand, item.props.absolutePath);

			case ".ts":
			case ".tsx":
			case ".js":
			case ".jsx":
			case ".fx":
			case ".json":
				return execNodePty(`code "${item.props.absolutePath}"`);
		}
	}

	private async _handleLoadScene(absolutePath: string, newlyCreated?: boolean): Promise<void> {
		if (!this.props.editor.state.projectPath) {
			return;
		}

		if (!(await pathExists(join(absolutePath, "config.json")))) {
			return;
		}

		if (!newlyCreated) {
			const accept = await showConfirm("Are you sure?", "This will close the current scene and open the selected one.");
			if (!accept) {
				return;
			}
		}

		const acceptSave = await showConfirm("Save Current Scene?", "Do you want to save the current scene before opening the new one?", {
			confirmText: "Save",
			cancelText: "Don't Save",
		});

		if (acceptSave) {
			await saveProject(this.props.editor);
		}

		clearUndoRedo();

		this.props.editor.setState({
			lastOpenedScenePath: absolutePath,
		});

		const directory = dirname(this.props.editor.state.projectPath);

		await replaceWithSingleSceneWorkspace(this.props.editor, directory, absolutePath);

		await this.props.editor.layout.graph.refresh();

		const scene = this.props.editor.layout.preview.scene;

		this.props.editor.layout.inspector.setEditedObject(scene);
		this.props.editor.layout.animations.setEditedObject(scene);
		this.props.editor.layout.preview.gizmo.setAttachedObject(null);
		await saveProjectConfiguration(this.props.editor);
	}

	private _handleNodeClicked(node: TreeNodeInfo): void {
		this.setBrowsePath(join(dirname(projectConfiguration.path!), node.id as string));

		this._forEachNode(this.state.filesTreeNodes, (n) => (n.isSelected = n.id === node.id));
		this.setState({ filesTreeNodes: this.state.filesTreeNodes });
	}

	private _handleNodeDoubleClicked(node: TreeNodeInfo): void {
		this.setBrowsePath(join(dirname(projectConfiguration.path!), node.id as string));

		this._forEachNode(this.state.filesTreeNodes, (n) => {
			if (n.id === node.id) {
				n.isExpanded = !n.isExpanded;
			}
		});

		this.setState({ filesTreeNodes: this.state.filesTreeNodes });
	}

	private _handleNodeExpanded(node: TreeNodeInfo): void {
		this._forEachNode(this.state.filesTreeNodes, (n) => n.id === node.id && (n.isExpanded = true));
		this.setState({ filesTreeNodes: this.state.filesTreeNodes });
	}

	private _handleNodeCollapsed(node: TreeNodeInfo): void {
		this._forEachNode(this.state.filesTreeNodes, (n) => n.id === node.id && (n.isExpanded = false));
		this.setState({ filesTreeNodes: this.state.filesTreeNodes });
	}

	private _forEachNode(nodes: TreeNodeInfo[] | undefined, callback: (node: TreeNodeInfo, index: number) => void): void {
		if (nodes === undefined) {
			return;
		}

		for (let i = 0, len = nodes.length; i < len; ++i) {
			const node = nodes[i];

			callback(node, i);
			this._forEachNode(node.childNodes, callback);
		}
	}
}
