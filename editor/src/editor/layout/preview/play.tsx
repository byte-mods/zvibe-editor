import { ipcRenderer } from "electron";
import { join as nativeJoin } from "path";
import { watch, FSWatcher } from "chokidar";
import { basename, dirname, join } from "path/posix";

import { Button } from "@blueprintjs/core";
import { Component, ReactNode } from "react";

import { Grid } from "react-loader-spinner";

import { IoPlay, IoStop, IoRefresh } from "react-icons/io5";

import { AbstractEngine, Scene, Vector3, HavokPlugin } from "babylonjs";
import type {
	IClothSimulationControl,
	IEditorNetworkingConfiguration,
	ILighting2DProviderType,
	IPhysics2DSimulationControl,
	IRegisteredScript,
	IScriptSimulationControl,
	IScriptSimulationStepResult,
	IScriptSourceBreakpointInput,
	IScriptSourceCoverageSnapshot,
	IScriptSourceDebuggerSnapshot,
	IScriptSourceManifest,
	NetworkingRuntime,
} from "babylonjs-editor-tools";

import { ensureTemporaryDirectoryExists } from "../../../tools/project";

import { compileScript } from "../../../tools/compile";
import { wait, waitNextAnimationFrame } from "../../../tools/tools";
import { forceCompileAllSceneMaterials } from "../../../tools/scene/materials";
import { applyOverrides, restorePlayOverrides } from "../../../tools/scene/play/override";

import { exportProject } from "../../../project/export/export";
import { projectConfiguration } from "../../../project/configuration";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../ui/shadcn/ui/tooltip";

import { Editor } from "../../main";

export interface IEditorPreviewPlayComponentProps {
	/**
	 * The editor reference.
	 */
	editor: Editor;
	/**
	 * Defines wether or not the play button is enabled in the preview.
	 */
	enabled: boolean;

	/**
	 * Called on the user wants to restart the game / application (aka. refresh the page of the game / application).
	 */
	onRestart: () => void;
}

export interface IEditorPreviewPlayComponentState {
	/**
	 * Defines wether or not the player is being prepared.
	 */
	preparingPlay: boolean;
	/**
	 * Defines wether or not the game / application is currently loading.
	 */
	loading: boolean;
	/**
	 * Defines wether or not the game / application is playing in the editor.
	 */
	playing: boolean;
}

export class EditorPreviewPlayComponent extends Component<IEditorPreviewPlayComponentProps, IEditorPreviewPlayComponentState> {
	/**
	 * Defines the reference to the scene that is reserved for the game / application when playing.
	 * This scene is used to be renderer directly in the preview panel of the editor and is disposed when the
	 * game / application is stopped.
	 */
	public scene: Scene | null = null;

	private _srcWatcher: FSWatcher | null = null;
	private _temporaryDirectory: string | null = null;

	private _compiledScriptExports: any = null;
	private _instrumentProjectSources = false;
	private _scriptSourceManifest: IScriptSourceManifest | null = null;
	private _scriptSourceBreakpoints: IScriptSourceBreakpointInput[] = [];
	private _scriptSourceCoverageEnabled = false;

	public constructor(props: IEditorPreviewPlayComponentProps) {
		super(props);

		this.state = {
			playing: false,
			loading: false,
			preparingPlay: false,
		};
	}

	public render(): ReactNode {
		return (
			<TooltipProvider>
				{this.state.playing && !this.state.preparingPlay && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								minimal
								onClick={() => this.props.onRestart()}
								icon={<IoRefresh className="w-6 h-6" strokeWidth={1} color="red" />}
								className="w-10 h-10 bg-muted/50 !rounded-lg transition-all duration-300 ease-in-out"
							/>
						</TooltipTrigger>
						<TooltipContent>Restart the game / application</TooltipContent>
					</Tooltip>
				)}

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							minimal
							active={this.state.playing}
							disabled={this.state.preparingPlay || !this.props.enabled}
							icon={
								this.state.preparingPlay ? (
									<Grid width={24} height={24} color="gray" />
								) : this.state.playing ? (
									<IoStop className="w-6 h-6" strokeWidth={1} color="red" />
								) : (
									<IoPlay className="w-6 h-6" strokeWidth={1} color="green" />
								)
							}
							onClick={() => this.playOrStopApplication()}
							className={`
                                w-10 h-10 bg-muted/50 !rounded-lg
                                ${this.state.preparingPlay || !this.props.enabled ? `bg-muted/50 ${!this.props.enabled && "opacity-35"}` : this.state.playing ? "!bg-red-500/35" : "hover:!bg-green-500/35"}
                                transition-all duration-300 ease-in-out
                            `}
						/>
					</TooltipTrigger>
					<TooltipContent className="flex gap-2 items-center">
						{this.props.enabled ? "Play the game / application" : "Can't play the game now. Dependencies are still installing..."}
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		);
	}

	public componentDidMount(): void {
		ipcRenderer.on("preview:play-scene", () => {
			this.triggerPlayScene();
		});
	}

	public triggerPlayScene(): void {
		if (this.state.playing) {
			this.props.onRestart();
		} else if (!this.state.preparingPlay) {
			this.playOrStopApplication();
		}
	}

	public componentDidUpdate(_: Readonly<IEditorPreviewPlayComponentProps>, prevState: Readonly<IEditorPreviewPlayComponentState>): void {
		if (prevState !== this.state) {
			this.props.editor.layout.preview.forceUpdate();
			this.props.editor.layout.preview.gizmo._gizmosLayer.pickingEnabled = this.scene ? false : true;
		}
	}

	/**
	 * Gets wether or not everything is ready to play the current scene of the game / application.
	 */
	public get canPlayScene(): boolean {
		return this.state.playing && !this.state.preparingPlay && !this.state.loading;
	}

	/** Reads attached-script simulation state from the exact tools module bundled into the active Play scene. */
	public getScriptSimulationControl(): IScriptSimulationControl {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for game-script simulation control.");
		}
		return this._getCompiledScriptExport("getScriptSimulationControl")(this.scene);
	}

	/** Pauses or resumes the attached scripts owned by the exact tools module bundled into Play. */
	public setScriptSimulationPaused(paused: boolean): IScriptSimulationControl {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for game-script simulation control.");
		}
		return this._getCompiledScriptExport("setScriptSimulationPaused")(this.scene, paused);
	}

	/** Advances the attached scripts owned by the exact tools module bundled into Play by one fixed frame. */
	public stepPausedScriptSimulation(deltaSeconds: number): IScriptSimulationStepResult {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for game-script simulation control.");
		}
		return this._getCompiledScriptExport("stepPausedScriptSimulation")(this.scene, deltaSeconds);
	}

	/** Returns whether source probes are requested for current and subsequent Play compilations. */
	public get scriptSourceDebuggingEnabled(): boolean {
		return this._instrumentProjectSources;
	}

	/** Rebuilds Play with source probes, or removes them, without changing exported project builds. */
	public async setScriptSourceDebuggingEnabled(enabled: boolean): Promise<IScriptSourceDebuggerSnapshot | null> {
		if (typeof enabled !== "boolean") {
			throw new Error("Script source debugging enabled must be a boolean.");
		}
		this._instrumentProjectSources = enabled;
		if (this.state.playing) {
			const compiled = await this._compileScripts();
			if (!compiled) {
				throw new Error("Failed to compile source-instrumented Play scripts.");
			}
			await this.restart();
		} else if (enabled) {
			await this.play();
		}
		if (enabled && (!this.scene || !this._scriptSourceManifest)) {
			throw new Error("Debug Play did not become ready. Check the editor Console for the compile or scene-load failure.");
		}
		return enabled ? this.getScriptSourceDebuggerSnapshot() : null;
	}

	/** Reads the source debugger attached to the exact tools module bundled into Play. */
	public getScriptSourceDebuggerSnapshot(traceOffset = 0, traceLimit = 100): IScriptSourceDebuggerSnapshot {
		if (!this.scene || !this._scriptSourceManifest) {
			throw new Error("Source-instrumented Play is not ready. Prepare the script debugger first.");
		}
		return this._getCompiledScriptExport("getScriptSourceDebuggerSnapshot")(this.scene, traceOffset, traceLimit);
	}

	/** Atomically replaces source breakpoints and preserves them across Debug Play restarts. */
	public setScriptSourceBreakpoints(breakpoints: IScriptSourceBreakpointInput[]): IScriptSourceDebuggerSnapshot {
		if (!this.scene || !this._scriptSourceManifest) {
			throw new Error("Source-instrumented Play is not ready. Prepare the script debugger first.");
		}
		const snapshot = this._getCompiledScriptExport("setScriptSourceBreakpoints")(this.scene, breakpoints) as IScriptSourceDebuggerSnapshot;
		this._scriptSourceBreakpoints = breakpoints.map((breakpoint) => ({ ...breakpoint }));
		return snapshot;
	}

	/** Controls source coverage and preserves its enabled state across Debug Play restarts. */
	public setScriptSourceCoverage(enabled: boolean, clear = false): IScriptSourceDebuggerSnapshot {
		if (!this.scene || !this._scriptSourceManifest) {
			throw new Error("Source-instrumented Play is not ready. Prepare the script debugger first.");
		}
		const snapshot = this._getCompiledScriptExport("setScriptSourceCoverage")(this.scene, enabled, clear) as IScriptSourceDebuggerSnapshot;
		this._scriptSourceCoverageEnabled = enabled;
		return snapshot;
	}

	/** Clears retained debugger hits without changing authored breakpoints or coverage. */
	public clearScriptSourceDebuggerTrace(): IScriptSourceDebuggerSnapshot {
		if (!this.scene || !this._scriptSourceManifest) {
			throw new Error("Source-instrumented Play is not ready. Prepare the script debugger first.");
		}
		return this._getCompiledScriptExport("clearScriptSourceDebuggerTrace")(this.scene);
	}

	/** Reads bounded source-level coverage from the active Debug Play scene. */
	public getScriptSourceCoverage(options: { path?: string; offset?: number; limit?: number } = {}): IScriptSourceCoverageSnapshot {
		if (!this.scene || !this._scriptSourceManifest) {
			throw new Error("Source-instrumented Play is not ready. Prepare the script debugger first.");
		}
		return this._getCompiledScriptExport("getScriptSourceCoverage")(this.scene, options);
	}

	/** Reads cloth simulation state from the exact tools module bundled into the active Play scene. */
	public getClothSimulationControl(): IClothSimulationControl {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for cloth simulation control.");
		}
		return this._getCompiledScriptExport("getClothSimulationControl")(this.scene);
	}

	/** Pauses or resumes the shared cloth solver owned by the exact Play bundle. */
	public setClothSimulationPaused(paused: boolean): IClothSimulationControl {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for cloth simulation control.");
		}
		return this._getCompiledScriptExport("setClothSimulationPaused")(this.scene, paused);
	}

	/** Advances the shared cloth solver owned by the exact Play bundle by one fixed frame. */
	public stepPausedClothSimulation(deltaSeconds: number): IClothSimulationControl & { steppedCloths: number } {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for cloth simulation control.");
		}
		return this._getCompiledScriptExport("stepPausedClothSimulation")(this.scene, deltaSeconds);
	}

	/** Reads Physics 2D state from the exact tools module bundled into the active Play scene. */
	public getPhysics2DSimulationControl(): IPhysics2DSimulationControl {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for Physics 2D simulation control.");
		}
		return this._getCompiledScriptExport("getPhysics2DSimulationControl")(this.scene);
	}

	/** Pauses or resumes the shared Physics 2D solver owned by the exact Play bundle. */
	public setPhysics2DSimulationPaused(paused: boolean): IPhysics2DSimulationControl {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for Physics 2D simulation control.");
		}
		return this._getCompiledScriptExport("setPhysics2DSimulationPaused")(this.scene, paused);
	}

	/** Advances the shared Physics 2D solver owned by the exact Play bundle by one fixed frame. */
	public stepPausedPhysics2DSimulation(deltaSeconds: number): IPhysics2DSimulationControl & { steppedBodies: number } {
		if (!this.scene) {
			throw new Error("The Play scene is not ready for Physics 2D simulation control.");
		}
		return this._getCompiledScriptExport("stepPausedPhysics2DSimulation")(this.scene, deltaSeconds);
	}

	/** Returns runtime registrations from the exact tools module bundled into the active Play scene. */
	public getScriptRuntimeRegistrations(object: any): IRegisteredScript[] {
		const dictionary = this._compiledScriptExports?.scriptsDictionary;
		if (!dictionary || typeof dictionary.get !== "function") {
			throw new Error("The compiled Play script registration bridge is unavailable. Regenerate and restart Play mode.");
		}
		return dictionary.get(object) ?? [];
	}

	/**
	 * Loads an isolated player through the exact compiled Play bundle on a
	 * caller-owned engine. Multiplayer tooling owns rendering and disposal.
	 */
	public async createIsolatedPlayerScene(engine: AbstractEngine): Promise<Scene> {
		if (!this.canPlayScene || !this._compiledScriptExports?.loadScene || !this._compiledScriptExports?.scriptsMap) {
			throw new Error("Compiled Play must be ready before creating an isolated multiplayer player.");
		}
		const scene = new Scene(engine);
		scene.enablePhysics(new Vector3(0, -981, 0), new HavokPlugin());
		scene.audioEnabled = false;
		const projectDir = dirname(projectConfiguration.path!);
		const rootUrl = join(projectDir, "public", "scene", "/");
		const sceneName = basename(this.props.editor.state.lastOpenedScenePath!).split(".").shift()!;
		try {
			await this._compiledScriptExports.loadScene(rootUrl, `${sceneName}.babylon`, scene, this._compiledScriptExports.scriptsMap, {
				quality: "high",
				headless: true,
				networking: { autoConnect: false },
			});
			scene.activeCamera ??= scene.cameras[0] ?? null;
			return scene;
		} catch (error) {
			scene.dispose();
			throw new Error(`Failed to load isolated multiplayer player: ${this._describePlayError(error)}`);
		}
	}

	/** Reads a runtime from the same bundled tools instance that loaded its scene. */
	public getCompiledNetworkingRuntime(scene: Scene): NetworkingRuntime | null {
		return this._getCompiledScriptExport("getNetworkingRuntime")(scene);
	}

	/** Rebuilds networking through the exact bundled tools instance for this Play scene. */
	public configureCompiledNetworking(scene: Scene, configuration: IEditorNetworkingConfiguration): NetworkingRuntime | null {
		return this._getCompiledScriptExport("configureNetworking")(scene, { configuration });
	}

	/** Lists Light2D providers registered by the exact game-script bundle running in Play. */
	public listCompiledLight2DProviderTypes(): ILighting2DProviderType[] {
		return this._getCompiledScriptExport("listLight2DProviderTypes")();
	}

	/** Lists ShadowShape2D providers registered by the exact game-script bundle running in Play. */
	public listCompiledShadowShape2DProviderTypes(): ILighting2DProviderType[] {
		return this._getCompiledScriptExport("listShadowShape2DProviderTypes")();
	}

	/** Reads measured 2D-light runtime evidence from the exact tools instance that owns the active Play scene. */
	public getCompiledLighting2DRuntimeEvidence(scene: Scene = this.scene!): Record<string, unknown> {
		if (!scene) {
			throw new Error("The Play scene is not ready for 2D lighting diagnostics.");
		}
		return this._getCompiledScriptExport("getLighting2DRuntimeEvidence")(scene);
	}

	/**
	 * Sets the game / application to play or stop.
	 * If the game / application is not playing, it will start it.
	 * If the game / application is playing, it will stop it.
	 */
	public async playOrStopApplication(): Promise<void> {
		if (this.state.playing) {
			this.stop();
		} else {
			await this.play();
		}
	}

	/**
	 * Restarts the game / application.
	 * This will just clean the current scene instance (event receivers, etc.) and reload the same scene.
	 */
	public async restart(): Promise<void> {
		if (!this.state.playing) {
			return;
		}

		this.scene?.dispose();
		this.scene = null;

		restorePlayOverrides(this.props.editor);

		this.props.editor.layout.preview.engine.wipeCaches(true);

		this.setState({
			loading: true,
		});

		this.props.editor.layout.preview.setState({
			playSceneLoadingProgress: 0,
		});

		// TODO: find why we need to wait before starting the loading
		// Try it: play scene, restart it and then stop it. The edited scene in "edit mode" will be full of glitches.
		await wait(150);

		await this._createAndLoadScene();
	}

	/**
	 * Stops the game / application.
	 * It will dispose the scene and reset the state.
	 */
	public stop(onStopped?: () => void): void {
		this.scene?.dispose();
		this.scene = null;

		restorePlayOverrides(this.props.editor);

		this.props.editor.layout.preview.engine.wipeCaches(true);

		this.setState(
			{
				playing: false,
				loading: false,
				preparingPlay: false,
			},
			onStopped
		);

		this.props.editor.layout.preview.setState({
			pickingEnabled: true,
			playSceneLoadingProgress: 0,
		});

		this.props.editor.layout.preview.scene.activeCamera?.attachControl(true);

		this._closeWatchSrcDirectory();
	}

	/**
	 * Starts the game / application.
	 * The play process consists on:
	 * - the exporting the final scene without optimizations (to save export time)
	 * - compiling the scripts map using esbuild (located at projectAbsoluteDir/src/scripts.ts)
	 * - store the output of esbuild and put it in the temporary directory of the project (.bjseditor folder)
	 * - require the compiled script and use babylonjs-editor-tools to render the scene.
	 */
	public async play(noExportScene?: boolean, noCompile?: boolean): Promise<void> {
		if (this.state.playing) {
			return;
		}

		this.setState({
			playing: true,
			preparingPlay: true,
		});

		this.props.editor.layout.preview.setState({
			pickingEnabled: false,
		});

		this.props.editor.layout.preview.scene.activeCamera?.detachControl();

		try {
			this._temporaryDirectory ??= await ensureTemporaryDirectoryExists(projectConfiguration.path!);

			if (!noExportScene) {
				// Export first as src/scripts.ts may change during the export.
				const exported = await exportProject(this.props.editor, {
					optimize: false,
					noProgress: true,
				});
				if (!exported) {
					return this.stop();
				}
			}

			if (!noCompile) {
				// Once exported, the src/scripts.ts file is updated and can be compiled.
				const compiled = await this._compileScripts();
				if (!compiled) {
					return this.stop();
				}
			}

			await waitNextAnimationFrame();

			if (!this.state.playing) {
				return; // In case the user stopped the play while preparing it
			}

			this.setState({
				preparingPlay: false,
			});

			await this._createAndLoadScene();

			if (this.state.playing) {
				this._watchSrcDirectory();
			}
		} catch (error) {
			console.error("Failed to start play mode:", error);
			this.props.editor.layout.selectTab("console");
			this.props.editor.layout.console.error(`Failed to start play mode:\n${error instanceof Error ? error.message : String(error)}`);
			this.stop();
		}
	}

	/**
	 * The script that is required and executed is a bundled version of the "src/scripts.ts" file.
	 * Here we use esbuild to bundle the scripts and transform the imports to use the correct paths.
	 * @see compileScript for more information.
	 */
	private async _compileScripts(): Promise<boolean> {
		const log = await this.props.editor.layout.console.progress("Compiling scripts...");

		try {
			const result = await compileScript({
				entryPoints: [join(dirname(projectConfiguration.path!), "src/scripts.ts")],
				outfile: join(this._temporaryDirectory!, "play/script.cjs"),
				instrumentProjectSources: this._instrumentProjectSources,
				onTransformSource: (path) =>
					log.setState({
						message: `Compiling source: ${basename(path)}`,
					}),
			});
			this._scriptSourceManifest = result?.sourceManifest ?? null;

			log.setState({
				done: true,
				message: "Scripts compiled",
			});

			return true;
		} catch (e) {
			console.error("Failed to compile play scripts:", e);
			if (e instanceof Error) {
				this.props.editor.layout.console.error(`Failed to compile play scripts:\n${e.message}`);
			}

			log.setState({
				error: true,
				message: "Failed to compile scripts",
			});

			return false;
		}
	}

	private async _createAndLoadScene(): Promise<void> {
		this.setState({
			loading: true,
		});

		applyOverrides(this.props.editor);

		this._requireCompiledScripts();

		const scene = new Scene(this.props.editor.layout.preview.engine);
		scene.enablePhysics(new Vector3(0, -981, 0), new HavokPlugin());
		scene.audioEnabled = !this.props.editor.state.projectSettings.playMode.muteAudio;

		this.scene = scene;
		if (this._scriptSourceManifest) {
			this._getCompiledScriptExport("configureScriptSourceDebugger")(scene, this._scriptSourceManifest, () =>
				this._getCompiledScriptExport("setScriptSimulationPaused")(scene, true)
			);
			this._getCompiledScriptExport("setScriptSourceBreakpoints")(scene, this._scriptSourceBreakpoints);
			this._getCompiledScriptExport("setScriptSourceCoverage")(scene, this._scriptSourceCoverageEnabled, false);
		}

		const projectDir = dirname(projectConfiguration.path!);
		const rootUrl = join(projectDir, "public", "scene", "/");

		const sceneName = basename(this.props.editor.state.lastOpenedScenePath!).split(".").shift()!;

		try {
			await this._compiledScriptExports.loadScene(rootUrl, `${sceneName}.babylon`, scene, this._compiledScriptExports.scriptsMap, {
				quality: "high",
				onProgress: (progress) =>
					this.props.editor.layout.preview.setState({
						playSceneLoadingProgress: progress,
					}),
			});
		} catch (e) {
			if (!scene.isDisposed) {
				const description = this._describePlayError(e);
				console.error("Failed to load play scene:", e);
				this.props.editor.layout.selectTab("console");
				this.props.editor.layout.console.error(`Failed to load scene:\n${description}`);
				return this.stop();
			}
		}

		if (scene.isDisposed) {
			return; // scene may be disposed if the user stopped the play while loading it
		}

		scene.activeCamera?.attachControl(true);

		await forceCompileAllSceneMaterials(scene);
		if (scene.isDisposed || !this.state.playing) {
			return;
		}

		this.setState({
			loading: false,
		});
	}

	private _requireCompiledScripts(): void {
		const scriptPath = join(this._temporaryDirectory!, "play/script.cjs");
		this._compiledScriptExports = require(scriptPath);
		delete require.cache[nativeJoin(scriptPath)];
	}

	private _getCompiledScriptExport(
		name:
			| "getScriptSimulationControl"
			| "setScriptSimulationPaused"
			| "stepPausedScriptSimulation"
			| "configureScriptSourceDebugger"
			| "getScriptSourceDebuggerSnapshot"
			| "setScriptSourceBreakpoints"
			| "setScriptSourceCoverage"
			| "clearScriptSourceDebuggerTrace"
			| "getScriptSourceCoverage"
			| "getClothSimulationControl"
			| "setClothSimulationPaused"
			| "stepPausedClothSimulation"
			| "getPhysics2DSimulationControl"
			| "setPhysics2DSimulationPaused"
			| "stepPausedPhysics2DSimulation"
			| "configureNetworking"
			| "getNetworkingRuntime"
			| "listLight2DProviderTypes"
			| "listShadowShape2DProviderTypes"
			| "getLighting2DRuntimeEvidence"
	): (...args: any[]) => any {
		const value = this._compiledScriptExports?.[name];
		if (typeof value !== "function") {
			throw new Error(
				`The compiled Play game-script bridge "${name}" is unavailable. Update the project's babylonjs-editor-tools dependency, regenerate, and restart Play mode.`
			);
		}
		return value;
	}

	private _describePlayError(error: unknown): string {
		if (!(error instanceof Error)) {
			return String(error);
		}
		const details = [error.stack ?? error.message];
		const innerError = (error as any).innerError;
		if (innerError && innerError !== error) {
			details.push(`Inner error: ${innerError instanceof Error ? (innerError.stack ?? innerError.message) : String(innerError)}`);
		}
		const cause = error.cause;
		if (cause && cause !== error && cause !== innerError) {
			details.push(`Cause: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
		}
		return details.join("\n");
	}

	/**
	 * Watches all the src directory of the project to detect changes in the scripts.
	 * If a change is detected, it will restart the game / application.
	 * TODO: change only those one that changed.
	 */
	private _watchSrcDirectory(): void {
		if (this._srcWatcher || !projectConfiguration.path) {
			return;
		}

		const srcPath = join(dirname(projectConfiguration.path), "src");

		this._srcWatcher = watch(srcPath, {
			persistent: false,
			ignoreInitial: true,
		});

		this._srcWatcher.on("change", async (path) => {
			if (this.canPlayScene) {
				this.props.editor.layout.console.log(`Detected change in ${path}, restarting play...`);
				await this._compileScripts();
				await this.restart();
			}
		});
	}

	private _closeWatchSrcDirectory(): void {
		this._srcWatcher?.close();
		this._srcWatcher = null;
	}
}
