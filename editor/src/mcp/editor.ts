import { Engine, EngineInstrumentation, Scene } from "babylonjs";

import { getUndoRedoState, redo, undo } from "../tools/undoredo";

import { IMCPActionOptions } from "./action";

export {
	activateDeviceSimulatorProfile,
	deleteDeviceSimulatorProfile,
	getDeviceSimulation,
	listDeviceSimulatorProfiles,
	setDeviceSimulation,
	setDeviceSimulatorProfile,
} from "./device/simulation";

const engineInstrumentation = new WeakMap<Engine, EngineInstrumentation>();

function getEngineInstrumentation(engine: Engine): EngineInstrumentation {
	let instrumentation = engineInstrumentation.get(engine);
	if (!instrumentation) {
		instrumentation = new EngineInstrumentation(engine);
		instrumentation.captureGPUFrameTime = true;
		engineInstrumentation.set(engine, instrumentation);
	}
	return instrumentation;
}

/**
 * Gets the live editor state needed by MCP clients before they mutate a project.
 */
export function getEditorStatus(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const editor = options.editor;
	const play = editor.layout.preview.play;

	return {
		ready: Boolean(editor.layout?.preview?.scene),
		projectPath: editor.state.projectPath,
		activeScenePath: editor.state.lastOpenedScenePath,
		experimentalFeaturesEnabled: editor.state.enableExperimentalFeatures,
		play: {
			playing: play.state.playing,
			preparing: play.state.preparingPlay,
			loading: play.state.loading,
			canPlay: play.canPlayScene,
		},
		undoRedo: getUndoRedoState(),
		scene: {
			meshes: scene.meshes.length,
			lights: scene.lights.length,
			cameras: scene.cameras.length,
			materials: scene.materials.length,
			particleSystems: scene.particleSystems.length,
			animationGroups: scene.animationGroups.length,
		},
	};
}

/** Applies the visible Inspector field filter through the same state owner as direct UI input. */
export function setInspectorSearchQuery(_scene: Scene, data: any, options: IMCPActionOptions): any {
	if (typeof data.query !== "string" || data.query.length > 128) {
		throw new Error("Inspector search query must be a string of at most 128 characters.");
	}
	options.editor.layout.inspector.setSearch(data.query);
	return { query: data.query };
}

/**
 * Gets the editor feature areas exposed by this version of the MCP bridge.
 */
export function getEditorCapabilities(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	return {
		projectOpen: Boolean(options.editor.state.projectPath),
		experimentalFeaturesEnabled: options.editor.state.enableExperimentalFeatures,
		features: {
			scene: true,
			nodes: true,
			meshes: true,
			lights: true,
			lighting2D: true,
			lightingSearchWorkspace: true,
			lightingSearchQueryTree: true,
			lightingSearchLightmapPreview: true,
			lightingSearchBatchEditing: true,
			light2DProviderRegistry: true,
			shadowShape2DProviderLifecycle: true,
			lighting2DEditPlayDiagnostics: true,
			cameras: true,
			rendering: true,
			occlusionCulling: true,
			bakedOcclusionPvs: true,
			occlusionAreas: true,
			occlusionVisualization: true,
			dynamicOcclusionQueries: true,
			onTileValidation: true,
			onTilePostProcessing: true,
			tileOnlyRendererExtensions: true,
			onTileRuntimeSuppression: true,
			onTileNativeMemoryEvidence: false,
			materials: true,
			shaderGraphTemplates: true,
			shaderGraphMultiCaseSwitch: true,
			shaderGraphStaticSubgraphInputs: true,
			shaderGraphReflectedFunctions: true,
			shaderGraphFloatModes: true,
			vfxGraphTemplates: true,
			vfxGraphTemplateSearchAndFiltering: true,
			vfxBatchReleaseOnDisable: true,
			guiUXMLUpgradeService: true,
			guiPanelRenderer: true,
			guiWorldSpacePanelRenderer: true,
			guiUSSStatistics: true,
			guiStylesheetStaging: true,
			guiVisualElementReferences: true,
			guiAttributeOverrides: true,
			guiRetainedAnimations: true,
			guiWorldSpaceTestClicks: true,
			assets: true,
			persistentAssetRegistry: true,
			assetRegistryDuplicateGuidRepair: true,
			persistentAssetDependencyGraph: true,
			assetDependencyDiagnostics: true,
			binaryModelAssetDependencyScanners: true,
			semanticAssetMovePlanning: true,
			assetMoveRollback: true,
			backgroundAssetIndexing: true,
			assetIndexingWorkerIsolates: true,
			cancellableAssetIndexing: true,
			assetTags: true,
			projectAssetFavorites: true,
			assetImportStateDiagnostics: true,
			typedAssetImporters: true,
			buildAwareAssetImporters: true,
			textureInspectorChannelPreview: true,
			particles: true,
			sounds: true,
			scriptableAudioGenerators: true,
			animationGroups: true,
			animatorControllers: true,
			animatorRuntime: true,
			entitiesECS: true,
			ecsTypedChunks: true,
			ecsIncrementalBaking: true,
			ecsSceneStreaming: true,
			ecsCompiledSystems: true,
			ecsDependencyScheduling: true,
			ecsWorkerExecution: true,
			ecsDeferredCommands: true,
			ecsDebugger: true,
			ecsExactRevisionAuthoring: true,
			ecsHierarchyPreferences: true,
			ecsSystemQuickSearch: true,
			ecsNamespaceFiltering: true,
			ecsAssemblyTypeRegistrationPolicy: true,
			terrain: true,
			splines: true,
			virtualCameras: true,
			diagnostics: true,
			renderDebugViews: true,
			portableProfiler: true,
			profilerCpuHierarchy: true,
			profilerMemorySnapshots: true,
			profilerAssetLoadingEvents: true,
			profilerScriptMarkers: true,
			profilerEditPlayTargets: true,
			profilerConnectedPlayers: true,
			profilerPortableReports: true,
			profiler2DAtlasUsage: true,
			inputActions: true,
			inputActionsRuntime: true,
			audioMixer: true,
			buildProfiles: true,
			buildProfileFooterExtensionActions: true,
			buildPipelineExactRevisions: true,
			buildPipelineIncrementalCache: true,
			buildPipelineSigningEnvironment: true,
			buildPipelineStageReports: true,
			buildPipelineBackgroundJobs: true,
			androidBuildProfileLtoAndInitializationMarkers: true,
			shaderVariantAutomaticTracingAndPrewarming: true,
			linuxArm64DedicatedServerPublicSourceBuild: true,
			webBuildModuleStrippingEvidence: true,
			webAssembly2023BuildProfiles: true,
			emscripten4019AdapterValidation: true,
			browserNativeImageCodecEvidence: true,
			developmentBuildCodeCoverage: true,
			serializationSessionDiagnostics: true,
			packageManagerSamplesView: true,
			packageManagerSampleImages: true,
			packageManagerSampleLocate: true,
			packageManagerSamplePublishDateSort: true,
			developmentPackageTechnicalNameEditing: true,
			packageManagerDetailCards: true,
			platformCapabilityInventory: true,
			platformToolchainDiagnostics: true,
			platformScaffolds: true,
			installedPlatformRestartFlow: true,
			experimentalSwiftIosProjectGeneration: true,
			deviceSimulatorProfiles: true,
			deviceSimulatorSystemClasses: true,
			remoteDeviceLab: true,
			remoteDeviceLogs: true,
			remoteDeviceMetrics: true,
			remoteDeviceScreenshots: true,
			remoteDevicePointerInput: true,
			dedicatedServerScaffold: true,
			productionHeadlessSceneRuntime: true,
			serverAuthoritativeRuntime: true,
			serverContainerPipeline: true,
			serverKubernetesDeployment: true,
			serverFleetWorkflows: true,
			licensedConsoleProviders: true,
			mobileNativeWrapperScaffolds: true,
			mobileTouchControls: true,
			mobileTouchLayoutWorkspace: true,
			mobileNativePackaging: true,
			mobileEnvironmentSigning: true,
			mobileConnectedDevices: true,
			mobileBoundedLogCapture: true,
			mobileStoreSubmissionPlans: true,
			adaptivePerformanceBasicProvider: true,
			adaptivePerformanceAppleBridge: true,
			adaptivePerformanceScalers: true,
			adaptivePerformanceThermalSimulation: true,
			androidWindowInsetPolicy: true,
			androidWindowInsetsNativeBridge: true,
			iosThermalFrameRateControl: true,
			visionOSMinimumTargetVersion: true,
			portableGrpcWebTransport: true,
			portableConnectTransport: true,
			grpcResponseTrailers: true,
			webXRPlatformIntegration: true,
			webXRSessionLifecycle: true,
			webXRInteractionToolkit: true,
			webXRDesktopSimulation: true,
			webXRTargetValidation: true,
			webXRExactRevisionAuthoring: true,
			buildAndRun: true,
			projectServices: true,
			projectServiceEnvironments: true,
			projectServiceDeploymentPlans: true,
			projectServicesEmulator: true,
			projectServicesPortableRuntimeClient: true,
			sourceControlWorkspace65: true,
			sourceControlBranchExplorer: true,
			sourceControlChangesetDiffProperties: true,
			sourceControlFolderActions: true,
			sourceControlPartialShelvesetApply: true,
			sourceControlPersistentSplitters: true,
			sourceControlF2RefRename: true,
			networkingTransport: true,
			networkReplication: true,
			networkPredictionReconciliation: true,
			gameplaySessionHost: true,
			gameplayLobbyRelay: true,
			multiplayerPlayMode: true,
			networkSimulation: true,
			reflectionProbes: true,
			materialVariants: true,
			physicsConstraints: true,
			hybridPhysicsSolver: true,
			directPhysicsConstraintRows: true,
			iterativePhysicsContactCoupling: true,
			physicsGearCouplings: true,
			chainGearsPhysicsSample: true,
			physicsContactCapture: true,
			physicsContactHistoryAssets: true,
			physicsContactHistoryReplay: true,
			physicsForceVisualization: true,
			navAgents: true,
			navOffMeshLinks: true,
			navAgentPathFollowing: true,
			riggingIK: true,
			humanoidAvatars: true,
			humanoidAnimationRetargeting: true,
			humanoidMuscleLimits: true,
			humanoidAvatarMasks: true,
			clothPhysics: true,
			clothConstraintPainting: true,
			clothTriangleColliders: true,
			physics2D: true,
			physics2DWorlds: true,
			physics2DCustomTransformPlanes: true,
			physics2DTransformWriteEvents: true,
			physics2DPerWorldContactFiltering: true,
			physics2DMultiCameraDebugRendering: true,
			proBuilderFaceExtrusion: true,
			proBuilderCSG: true,
			proBuilderBridge: true,
			proBuilderUVProjection: true,
			prefabVariants: true,
			prefabDynamicVariantRebase: true,
			prefabMode: true,
			prefabArbitraryPropertyOverrides: true,
			prefabStructuralOverrides: true,
			prefabComponentOverrides: true,
			prefabNestedAssets: true,
			prefabInstanceBoundaryLinks: true,
			prefabInstanceUnpack: true,
			prefabBoundaryOverridePromotion: true,
			prefabRootApplyRevert: true,
			prefabNestedApplyRevert: true,
			visualScripting: true,
			visualScriptingFlowGraphs: true,
			visualScriptingStateGraphs: true,
			visualScriptingCustomUnits: true,
			visualScriptingDebugger: true,
			visualScriptingExportRuntime: true,
			graphToolkitExpressions: true,
			graphToolkitUntypedPorts: true,
			graphToolkitMultilinePortsAndOptions: true,
			graphToolkitCustomTypeStyles: true,
			graphToolkitEditableCollections: true,
			guiCanvasGroups: true,
			guiRaycastReceivers: true,
			guiLocalUsageTracking: true,
			inspectorStyledCollections: true,
			sceneTestRunner: true,
			versionedTestSuites: true,
			editModeTests: true,
			playModeTests: true,
			connectedPlayerTests: true,
			performanceTestSampling: true,
			visualTestCases: true,
			projectCodeTests: true,
			compileTimeSerializationDiagnostics: true,
			asynchronousProjectAuditor: true,
			projectAuditorParticleTextureReadability: true,
			projectAuditorObsoleteApis: true,
			projectAuditorAtlasWaste: true,
			linuxPlayerLtoModes: true,
			linuxPlayerIme: true,
			macosDisplayLinkFramePacing: true,
			platformPlayerRuntimeEvidence: true,
			windowsAssetStreamingBuildProfiles: true,
			portableAsyncAssetStreaming: true,
			assetStreamingRuntimeDiagnostics: true,
			nativeMicrosoftDirectStorageAdapter: false,
			headlessTestCli: true,
			testReports: true,
			addressablesCatalog: true,
			addressablesRuntime: true,
			addressablesProfiles: true,
			addressablesContentUpdates: true,
			addressablesRemoteCatalogs: true,
			addressablesDeployment: true,
			addressablesBuildReports: true,
			addressablesRuntimeCache: true,
			addressablesSharedTypeTrees: true,
			addressablesPortableBundles: true,
			localizationRuntime: true,
			behaviorTrees: true,
			behaviorGraphBlackboard: true,
			behaviorGraphSubgraphs: true,
			behaviorGraphEvents: true,
			behaviorGraphUtilityAI: true,
			behaviorGraphNavigation: true,
			behaviorGraphCustomNodes: true,
			behaviorGraphDebugger: true,
			behaviorGraphExportRuntime: true,
			runtimeAiInference: true,
			onnxModelAssets: true,
			liteRtModelAssets: true,
			pytorchExportModelAssets: true,
			runtimeAiWasm: true,
			runtimeAiWebGpu: typeof navigator !== "undefined" && "gpu" in navigator && !!navigator.gpu,
			runtimeAiLiteRt: true,
			runtimeAiExportedPyTorch: true,
			runtimeAiModelGraphs: true,
			projectPackages: true,
			sourceControlStatus: true,
			collaborationAssetLocks: true,
			semanticSceneDiff: true,
			semanticSceneMerge: true,
			semanticMergeRules: true,
			projectCollaborationRoles: true,
			projectCollaborationPresence: true,
			remoteCollaborationGateway: true,
			remoteCollaborationOperationStream: true,
			projectChangelists: true,
			scripts: true,
			marketplace: true,
			mcpAutomation: true,
			undoRedo: true,
			previewPlayMode: true,
			navMesh: true,
			ragdoll: true,
			sprites: true,
			weightedSpriteSkinning: true,
			spriteBonePainting: true,
			psdSpriteRigging: true,
			spriteAnimationWorkspace: true,
			gui: true,
			cinematic: true,
			cinematicTimelineV2: true,
			cinematicExactRevisionAuthoring: true,
			cinematicDeterministicPreview: true,
			cinematicDeterministicVisualCapture: true,
			cinematicBuiltInAudioCapture: true,
			cinematicOfflineMasterBusCapture: true,
			projectPreferences: true,
			projectPlayerSettings: true,
			projectSettingsExactRevisions: true,
			projectSettingsPlatformOverrides: true,
			importAccelerator: true,
			importAcceleratorMcpManagement: true,
			editorUserPreferences: true,
			editorPreferencesExactRevisions: true,
			export: true,
			editorControls: true,
		},
	};
}

/**
 * Undoes the most recent editor operation when one is available.
 */
export function undoEditor(_scene: Scene, _data: any, _options: IMCPActionOptions): any {
	const previous = getUndoRedoState();
	if (previous.canUndo) {
		undo();
	}

	return {
		undone: previous.canUndo,
		undoRedo: getUndoRedoState(),
	};
}

/**
 * Redoes the next editor operation when one is available.
 */
export function redoEditor(_scene: Scene, _data: any, _options: IMCPActionOptions): any {
	const previous = getUndoRedoState();
	if (previous.canRedo) {
		redo();
	}

	return {
		redone: previous.canRedo,
		undoRedo: getUndoRedoState(),
	};
}

/**
 * Controls the editor preview play mode without starting an external development server.
 */
export async function setPreviewPlayMode(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const play = options.editor.layout.preview.play;

	switch (data.action) {
		case "play":
			if (!play.state.playing) {
				await play.play();
			}
			break;
		case "stop":
			if (play.state.playing) {
				await new Promise<void>((resolve) => play.stop(resolve));
			}
			break;
		case "restart":
			if (!play.state.playing) {
				throw new Error("Preview is not playing. Call set_preview_play_mode with action 'play' first.");
			}
			await play.restart();
			break;
		default:
			throw new Error(`Unsupported preview play action: ${data.action}`);
	}

	return {
		action: data.action,
		playing: play.state.playing,
		preparing: play.state.preparingPlay,
		loading: play.state.loading,
	};
}

/** Returns live renderer and scene metrics for profiling/debugging a preview. */
export function getSceneDiagnostics(scene: Scene): any {
	const engine = scene.getEngine();
	const gpuCounter = getEngineInstrumentation(engine as Engine).gpuFrameTimeCounter;
	return {
		frameRate: engine.getFps(),
		frameTimeMs: engine.getDeltaTime(),
		drawCalls: (engine as any)._drawCalls?.current ?? null,
		activeMeshes: scene.getActiveMeshes().length,
		totalVertices: scene.getTotalVertices(),
		meshes: scene.meshes.length,
		materials: scene.materials.length,
		textures: scene.textures.length,
		lights: scene.lights.length,
		cameras: scene.cameras.length,
		particleSystems: scene.particleSystems.length,
		gpuFrameTimeMs: gpuCounter ? gpuCounter.lastSecAverage * 0.000001 : null,
		gpuFrameTimeAverageMs: gpuCounter ? gpuCounter.average * 0.000001 : null,
	};
}

export {
	captureProfilerSnapshot,
	clearProfilerData,
	compareProfilerSnapshots,
	deleteProfilerCapture,
	deleteProfilerSnapshot,
	exportProfilerCapture,
	getProfilerCapabilities,
	getProfilerCapture,
	getProfiler2DState,
	getProfilerRunStatus,
	getProfilerState,
	importProfilerCapture,
	listProfilerCaptures,
	listProfilerSnapshots,
	shutdownProfiling,
	startProfilerCapture,
	stopProfilerCapture,
} from "./profiling/runner";
