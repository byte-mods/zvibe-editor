import { Component, DragEvent, ReactNode } from "react";

import { IoMdCube } from "react-icons/io";
import { Divider } from "@blueprintjs/core";

import { toast } from "sonner";

import { DepthOfFieldEffectBlurLevel, Scene, TonemappingOperator, AnimationGroup, VolumetricLightScatteringPostProcess } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import { Textarea } from "../../../../ui/shadcn/ui/textarea";
import { showConfirm } from "../../../../ui/dialog";

import type { IEditorExtensionBuildProfileActionContext, IEditorExtensionBuildProfileFooterDescriptor } from "../../../../extensions/types";

import { isMesh } from "../../../../tools/guards/nodes";
import { isScene } from "../../../../tools/guards/scene";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { updateAllLights } from "../../../../tools/light/shadows";
import { updateIblShadowsRenderPipeline } from "../../../../tools/light/ibl";

import { getPhysicsSimulationState, validatePhysicsScene } from "../../../../mcp/physics/constraints";
import {
	createChainGearsPhysicsSample,
	deleteChainGearsPhysicsSample,
	getHybridPhysicsSolver,
	setHybridPhysicsSolver,
	solveHybridPhysicsNow,
} from "../../../../mcp/physics/hybrid-solver";
import {
	clearPhysicsContactCapture,
	getPhysicsContactCapture,
	getPhysicsContactVisualization,
	setPhysicsContactVisualization,
	startPhysicsContactCapture,
	stopPhysicsContactCapture,
} from "../../../../mcp/physics/contacts";
import { deletePhysicsContactHistory, getPhysicsContactHistory, listPhysicsContactHistories, savePhysicsContactHistory } from "../../../../mcp/physics/contact-history-assets";
import { controlPhysicsContactHistoryReplay, getPhysicsContactHistoryReplay, startPhysicsContactHistoryReplay } from "../../../../mcp/physics/contact-history-replay";
import { PhysicsContactEventType, physicsContactEventTypes } from "../../../../mcp/physics/contact-history-types";
import { getPhysicsForceVisualization, setPhysicsForceVisualization } from "../../../../mcp/physics/force-visualization";
import { PhysicsForceVectorCategory, physicsForceVectorCategories } from "../../../../mcp/physics/force-visualization-types";
import { getPhysicsSimulationControlForInspector, setPhysicsSimulationPaused, stepPhysicsSimulation } from "../../../../mcp/physics/simulation";
import {
	buildAndRunBuildProfile,
	buildBuildProfile,
	cleanBuildProfileOutput,
	createBuildProfile,
	deleteBuildProfile,
	deleteBuildReport,
	duplicateBuildProfile,
	generatePwaManifest,
	generatePwaServiceWorker,
	getBuildProfileAssetStreamingPlan,
	getBuildPipelineStatus,
	installPwaServiceWorkerRegistration,
	inspectWebBuildPlan,
	listBuildProfiles,
	listBuildReports,
	setActiveBuildProfile,
	setBuildProfile,
	stopBuildProfileRun,
	validateBuildProfile,
	verifyWebBuildOutput,
} from "../../../../mcp/project/export";
import { generatePlatformScaffold, getPlatformDiagnostics, listPlatformCapabilities, removePlatformScaffold, validateIosGeneratedProject } from "../../../../mcp/project/platforms";
import { getSerializationSessionDiagnostics } from "../../../../project/serialization-session";
import { getInstalledPlatformRestartStatus, planInstalledPlatformRestart, restartEditorForInstalledPlatform } from "../../../../mcp/project/platform-restart";
import {
	abortProjectSourceControlIntegration,
	applyProjectSourceControlFolderAction,
	applyProjectSourceControlShelvesetPaths,
	applyProjectSourceControlTextResolution,
	commitProjectSourceControl,
	continueProjectSourceControlIntegration,
	createProjectSourceControlBranch,
	createProjectSourceControlShelveset,
	createProjectSourceControlTag,
	deleteProjectSourceControlBranch,
	deleteProjectSourceControlRemoteBranch,
	deleteProjectSourceControlRemoteTag,
	deleteProjectSourceControlShelveset,
	deleteProjectSourceControlTag,
	fetchProjectSourceControl,
	getProjectSourceControlDiff,
	getProjectSourceControlHistory,
	getProjectSourceControlIntegrationState,
	getProjectSourceControlStatus,
	getProjectSourceControlWorkspace,
	inspectProjectSourceControlAuthentication,
	inspectProjectSourceControlChangeset,
	inspectProjectSourceControlConflictDetails,
	inspectProjectSourceControlImageConflict,
	inspectProjectSourceControlShelveset,
	inspectProjectSourceControlSemanticConflict,
	inspectProjectSourceControlRemoteRefs,
	listProjectSourceControlRefs,
	previewProjectSourceControlIntegration,
	publishProjectSourceControlRemoteBranch,
	publishProjectSourceControlRemoteTag,
	pullProjectSourceControl,
	pushProjectSourceControl,
	renameProjectSourceControlRef,
	resolveProjectSourceControlConflict,
	applyProjectSourceControlSemanticConflict,
	setProjectSourceControlWorkspaceLayout,
	stageProjectSourceControlPaths,
	startProjectSourceControlMerge,
	startProjectSourceControlRebase,
	switchProjectSourceControlBranch,
	unstageProjectSourceControlPaths,
} from "../../../../mcp/project/source-control";
import {
	createProjectSourceControlReview,
	getProjectSourceControlReview,
	getProjectSourceControlReviewMetadata,
	getProjectSourceControlReviewProvider,
	listProjectSourceControlReviewChecks,
	listProjectSourceControlReviews,
	mergeProjectSourceControlReview,
	rerunProjectSourceControlReviewChecks,
	setProjectSourceControlReviewMetadata,
	setProjectSourceControlReviewProvider,
	submitProjectSourceControlReview,
} from "../../../../mcp/project/source-control-reviews";
import {
	acquireProjectAssetLock,
	inspectProjectAssetLockPolicy,
	listProjectAssetLocks,
	refreshProjectAssetLock,
	releaseProjectAssetLock,
} from "../../../../mcp/project/asset-locks";
import { createProjectAssetLockRule, deleteProjectAssetLockRule, listProjectAssetLockRules } from "../../../../mcp/project/asset-lock-rules";
import { compareProjectSceneAssets } from "../../../../mcp/project/semantic-diff";
import { mergeProjectSceneAssets } from "../../../../mcp/project/semantic-merge";
import { createProjectSemanticMergeRule, deleteProjectSemanticMergeRule, listProjectSemanticMergeRules } from "../../../../mcp/project/semantic-merge-rules";
import { createProjectChangelist, deleteProjectChangelist, listProjectChangelists, setProjectChangelistFiles } from "../../../../mcp/project/changelists";
import {
	configureProjectCollaboration,
	createProjectCollaborationMember,
	deleteProjectCollaborationMember,
	getProjectCollaborationStatus,
	heartbeatProjectCollaborationSession,
	joinProjectCollaborationSession,
	leaveProjectCollaborationSession,
	listProjectCollaborationMembers,
	listProjectCollaborationPresence,
} from "../../../../mcp/project/collaboration";
import { generateRemoteCollaborationTlsCertificate, inspectRemoteCollaborationTlsCertificate } from "../../../../mcp/project/collaboration-tls";
import { discoverRemoteCollaborationProjects, getRemoteCollaborationDiscovery, setRemoteCollaborationDiscovery } from "../../../../mcp/project/collaboration-discovery";
import { getRemoteCollaborationRelay, reconnectRemoteCollaborationRelay, setRemoteCollaborationRelay } from "../../../../mcp/project/collaboration-relay";
import {
	clearRemoteCollaborationEventHistory,
	getRemoteCollaborationGateway,
	listRemoteCollaborationEvents,
	setRemoteCollaborationEventHistory,
	setRemoteCollaborationGateway,
} from "../../../../mcp/project/remote-collaboration";
import { applyCollaborativeTextOperations, getCollaborativeTextDocument, rebaseCollaborativeTextDocument } from "../../../../mcp/project/collaborative-text";
import {
	applyCollaborativeOrderedCollectionOperations,
	getCollaborativeOrderedCollection,
	rebaseCollaborativeOrderedCollection,
} from "../../../../mcp/project/collaborative-lists";
import { applyCollaborativeNodeTransform, getCollaborationNodeRevision } from "../../../../mcp/project/collaboration-transforms";
import { applyCollaborativeNodeEdit, getCollaborationNodeEditRevision } from "../../../../mcp/project/collaboration-node-edits";
import {
	applyCollaborativeHierarchyEdit,
	applyCollaborativeNodeProperties,
	getCollaborationHierarchyRevision,
	getCollaborationNodePropertyRevision,
} from "../../../../mcp/project/collaboration-structure";
import { createPhysics2DMaterial, deletePhysics2DMaterial, listPhysics2DMaterials, setPhysics2DMaterial } from "../../../../mcp/physics2d/physics2d";
import { get2DSceneMode, getPhysicsCollisionLayers, IPhysicsCollisionLayer, set2DSceneMode, setPhysicsCollisionLayers } from "../../../../mcp/scene/scene";
import {
	applyRenderingProfile,
	clearActiveRenderingProfile,
	createRenderingProfile,
	deleteRenderingProfile,
	listRenderingProfiles,
	setRenderingProfile,
} from "../../../../mcp/rendering/profiles";
import { resetDynamicResolutionRuntime, setDynamicResolution } from "../../../../mcp/rendering/dynamic-resolution";
import { resetRenderReconstructionHistory, setRenderReconstruction } from "../../../../mcp/rendering/render-reconstruction";
import {
	assignRendererData,
	clearRendererDataAssignment,
	createRendererDataAsset,
	deleteRendererDataAsset,
	getRendererDataAsset,
	getRendererDataState,
	rebuildDeferredLighting,
} from "../../../../mcp/rendering/renderer-data";
import { createRenderingVolume, deleteRenderingVolume, evaluateRenderingVolumes, listRenderingVolumes, setRenderingVolume } from "../../../../mcp/rendering/volumes";
import {
	addCameraStackOverlay,
	applyCameraStack,
	clearActiveCameraStack,
	createCameraStack,
	deleteCameraStack,
	listCameraStacks,
	removeCameraStackOverlay,
	setCameraStack,
	setCameraStackOverlay,
} from "../../../../mcp/rendering/camera-stacks";
import {
	createRendererList,
	createRenderingLayer,
	deleteRendererList,
	deleteRenderingLayer,
	listRendererLists,
	listRenderingLayers,
	resetRenderingGroup,
	resolveRendererList,
	setRendererList,
	setRenderingGroup,
	setRenderingLayer,
} from "../../../../mcp/rendering/renderer-lists";
import {
	captureCustomRenderPassFrameDebugger,
	createCustomRenderPass,
	deleteCustomRenderPass,
	evaluateCustomRenderPassGraph,
	getCustomRenderPassFrameDebugger,
	listCustomRenderPasses,
	setCustomRenderPass,
	setCustomRenderPassFrameIsolation,
} from "../../../../mcp/rendering/custom-passes";
import { clearRenderGraphConformance, getRenderGraphConformance, runRenderGraphConformance } from "../../../../mcp/rendering/render-graph-conformance";
import {
	applyCustomRenderGraphAsset,
	deleteCustomRenderGraphAsset,
	detachCustomRenderGraphAsset,
	getCustomRenderGraphAsset,
	getCustomRenderGraphAssetMigration,
	migrateCustomRenderGraphAsset,
	saveCustomRenderGraphAsset,
	updateAssignedCustomRenderGraphAsset,
} from "../../../../mcp/rendering/render-graph-assets";
import {
	deleteRendererFeatureAsset,
	deleteRendererFeatureInstance,
	getRendererFeatureAsset,
	instantiateRendererFeature,
	listRendererFeatureInstances,
	refreshRendererFeatureInstance,
	saveRendererFeatureAsset,
	setRendererFeatureInstance,
} from "../../../../mcp/rendering/renderer-features";
import { createCloth, deleteCloth, getClothConstraintPaintViewport, listCloths, setCloth, setClothConstraintPaintViewport } from "../../../../mcp/cloth/cloth";
import {
	blendLightingScenario,
	createLightingScenario,
	createReflectionProbe,
	deleteLightingScenario,
	deleteReflectionProbe,
	listLightingScenarios,
	listReflectionProbes,
	setReflectionProbe,
} from "../../../../mcp/lights/lights";
import { bakeBakedGlobalIllumination, clearBakedGlobalIllumination, getBakedGlobalIllumination } from "../../../../mcp/lights/baked-gi";
import { bakeLightProbeVolume, createLightProbeVolume, deleteLightProbeVolume, listLightProbeVolumes, setLightProbeVolume } from "../../../../mcp/lights/light-probes";
import {
	compareVisualRegressionImages,
	createPerformanceBudget,
	createSceneTest,
	deletePerformanceBudget,
	deleteSceneTest,
	listPerformanceBudgets,
	listSceneTests,
	runPerformanceBudgets,
	runSceneTests,
	setSceneTest,
} from "../../../../mcp/testing/tests";
import { clearTestingRuns, createTestSuite, getTestingState } from "../../../../mcp/testing/state";
import { cancelTestingRun, exportTestingRunReport, getTestingRunStatus, runTesting } from "../../../../mcp/testing/runner";
import { cancelProjectCodeTests, getProjectCodeTests, runProjectCodeTests } from "../../../../mcp/testing/code-tests";
import {
	createLocalizedAssetTable,
	createLocalizationTable,
	deleteLocalizedAssetEntry,
	deleteLocalizedAssetTable,
	deleteLocalizationEntry,
	deleteLocalizationLocale,
	deleteLocalizationTable,
	listLocalizationTables,
	pseudoLocalizeEntry,
	setLocalizedAssetEntry,
	setLocalizationEntry,
	setLocalizationSettings,
	setLocalizationTableSettings,
	upsertLocalizationLocale,
	validateLocalization,
} from "../../../../mcp/localization/localization";
import {
	deleteGUIAccessibilityNode,
	deleteGUILocalizationBinding,
	getGUIAuthoring,
	listGUIs,
	setGUIAccessibilityNode,
	setGUIAccessibilitySettings,
	setGUILocalizationBinding,
	validateGUIAccessibility,
} from "../../../../mcp/gui/gui";
import { AddressablesInspector } from "./addressables";
import { PackageManagerInspector } from "./package-manager";
import {
	createScript,
	listCustomScriptTemplates,
	listProjectScriptExecutionOrders,
	listProjectWideScriptExecutionOrders,
	listScriptTemplates,
	setProjectScriptExecutionOrder,
	setProjectWideScriptExecutionOrder,
} from "../../../../mcp/scripts/scripts";
import {
	applyAudioMixerSnapshot,
	clearAudioMixerProfile,
	createAudioBus,
	createAudioEffect,
	createAudioMixerSnapshot,
	createAudioReverbZone,
	createAudioSend,
	deleteAudioBus,
	deleteAudioEffect,
	deleteAudioMixerSnapshot,
	deleteAudioReverbZone,
	deleteAudioSend,
	getAudioMixerRuntime,
	getAudioMixerProfile,
	listAudioBuses,
	listAudioRuntimeDiagnostics,
	listAudioMixerSnapshots,
	listAudioReverbZones,
	setAudioBus,
	setAudioMixerProfile,
	setAudioReverbZone,
	setAudioEffect,
	setAudioSend,
} from "../../../../mcp/sounds/sounds";
import { applyVfxBudgetProfile, createVfxBudgetProfile, deleteVfxBudgetProfile, listVfxBudgetProfiles } from "../../../../mcp/particles/particles";
import { controlVideoPlayer, createVideoPlayer, deleteVideoPlayer, listVideoPlayers, setVideoPlayer } from "../../../../mcp/videos/videos";
import { packSpriteAtlas, sliceSpriteSheet } from "../../../../mcp/sprites/sprites";
import { captureVisualRegressionBaseline } from "../../../../mcp/screenshot";
import {
	activateDeviceSimulatorProfile,
	deleteDeviceSimulatorProfile,
	getDeviceSimulation,
	listDeviceSimulatorProfiles,
	setDeviceSimulation,
	setDeviceSimulatorProfile,
} from "../../../../mcp/editor";
import { clearRemoteDeviceData, disconnectRemoteDevice, getDeviceLabStatus, listRemoteDevices, startDeviceLab, stopDeviceLab } from "../../../../mcp/device/device-lab";
import { createSpriteIKController, createSpriteIKRig, deleteSpriteIKController, listSpriteIKControllers, setSpriteIKController } from "../../../../mcp/rigging/ik";
import { deleteTerrainStreamingGroup, listTerrainStreamingGroups, setTerrainStreamingGroup } from "../../../../mcp/terrain/streaming";

import { createVLSPostProcess, disposeVLSPostProcess, getVLSPostProcess, parseVLSPostProcess, serializeVLSPostProcess } from "../../../rendering/vls";
import { InputActionsSceneInspector } from "./input-actions";
import { XRSceneInspector } from "./xr";
import { createSSRRenderingPipeline, disposeSSRRenderingPipeline, getSSRRenderingPipeline, parseSSRRenderingPipeline, serializeSSRRenderingPipeline } from "../../../rendering/ssr";
import { createTAARenderingPipeline, disposeTAARenderingPipeline, getTAARenderingPipeline, parseTAARenderingPipeline, serializeTAARenderingPipeline } from "../../../rendering/taa";
import {
	createSSAO2RenderingPipeline,
	disposeSSAO2RenderingPipeline,
	getSSAO2RenderingPipeline,
	parseSSAO2RenderingPipeline,
	serializeSSAO2RenderingPipeline,
} from "../../../rendering/ssao";
import {
	createMotionBlurPostProcess,
	disposeMotionBlurPostProcess,
	getMotionBlurPostProcess,
	parseMotionBlurPostProcess,
	serializeMotionBlurPostProcess,
} from "../../../rendering/motion-blur";
import {
	createDefaultRenderingPipeline,
	disposeDefaultRenderingPipeline,
	getDefaultRenderingPipeline,
	parseDefaultRenderingPipeline,
	serializeDefaultRenderingPipeline,
} from "../../../rendering/default-pipeline";
import {
	createCustomColorPostProcess,
	disposeCustomColorPostProcess,
	getCustomColorPostProcess,
	parseCustomColorPostProcess,
	serializeCustomColorPostProcess,
} from "../../../rendering/custom-color";
import {
	createIblShadowsRenderingPipeline,
	disposeIblShadowsRenderingPipeline,
	getIblShadowsRenderingPipeline,
	parseIblShadowsRenderingPipeline,
	serializeIblShadowsRenderingPipeline,
} from "../../../rendering/ibl-shadows";

import { EditorInspectorSectionField } from "../fields/section";

import { EditorInspectorListField } from "../fields/list";
import { EditorInspectorColorField } from "../fields/color";
import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorVectorField } from "../fields/vector";
import { EditorInspectorSliderField } from "../fields/slider";
import { EditorInspectorTextureField } from "../fields/texture";

import { ScriptInspectorComponent } from "../script/script";

import { IEditorInspectorImplementationProps } from "../inspector";
import { EditorSceneAnimationGroupsInspector } from "./animation-groups";
import { Physics2DSceneInspector } from "./physics2d-joints";
import { EditorRenderDebugInspector } from "./render-debug";
import { EditorOnTileRenderingInspector } from "./on-tile-rendering";
import { EditorSubsurfaceRuntimeInspector } from "./subsurface";
import { formatSceneTestAssertion } from "../../../../mcp/testing/format";

export interface IEditorSceneInspectorState {
	dragOverVlsMesh: boolean;

	animationGroupsSearch: string;
	selectedAnimationGroups: AnimationGroup[];
	spriteIKRootNodeId: string;
	spriteIKJointNodeId: string;
	spriteIKTipNodeId: string;
	spriteIKTargetNodeId: string;
	spriteIKRigName: string;
	reflectionProbeName: string;
	bakedGiResolution: number;
	bakedGiSamples: number;
	bakedGiBounces: 0 | 1;
	bakedGiBusy: boolean;
	renderGraphAssetPath: string;
	renderGraphAssetName: string;
	renderGraphAssetBusy: boolean;
	rendererFeatureAssetPath: string;
	rendererFeatureAssetName: string;
	rendererFeaturePassIds: string;
	rendererFeaturePrefix: string;
	rendererFeatureBusy: boolean;
	rendererDataAssetPath: string;
	rendererDataAssetName: string;
	rendererDataRenderingPath: "forward" | "forward-plus" | "deferred";
	rendererDataCameraId: string;
	rendererDataBusy: boolean;
	cameraStackName: string;
	cameraStackBaseCameraId: string;
	cameraStackOverlayCameraId: string;
	renderingLayerName: string;
	renderingLayerBit: number;
	rendererListName: string;
	lightProbeName: string;
	lightProbeBaseResolution: number;
	lightProbeAdaptiveLevels: number;
	lightProbeSamples: number;
	lightProbeBusyId: string | null;
	sceneTestName: string;
	sceneTestNodeId: string;
	testingSuiteName: string;
	testingSuiteMode: "edit" | "play";
	testingFilter: string;
	testingBusy: boolean;
	testingCodeBusy: boolean;
	projectCodeTests: any | null;
	visualBaselinePath: string;
	visualCandidatePath: string;
	visualTolerance: number;
	visualResult: any | null;
	localizationTables: any[];
	localizationData: any | null;
	localizationLocales: any[];
	localizationAssetTables: any[];
	localizationError: string | null;
	localizationTableName: string;
	localizationFallbackLocale: string;
	localizationSelectedTable: string;
	localizationKey: string;
	localizationLocale: string;
	localizationValue: string;
	localizationSmart: boolean;
	localizationLocaleName: string;
	localizationDirection: "auto" | "ltr" | "rtl";
	localizationLocaleFallbacks: string;
	localizationPseudoEnabled: boolean;
	localizationAssetTableName: string;
	localizationSelectedAssetTable: string;
	localizationAssetKey: string;
	localizationAssetPath: string;
	localizationAssetType: "audio" | "binary" | "font" | "model" | "texture" | "video";
	pseudoLocalizationValue: string | null;
	localizationValidation: any | null;
	guiAccessibilityValidation: any | null;
	guiAccessibilityGuis: any[];
	guiAccessibilityGuiId: string;
	guiAccessibilityAuthoring: any | null;
	guiAccessibilityControlId: string;
	guiAccessibilityRole: string;
	guiAccessibilityLabel: string;
	guiAccessibilityFocusOrder: number;
	guiLocalizationProperty: "source" | "text";
	guiLocalizationTable: string;
	guiLocalizationKey: string;
	physicsContactCapture: any | null;
	physicsContactHistories: any[];
	physicsContactHistorySelectedPath: string;
	physicsContactHistoryPath: string;
	physicsContactHistoryName: string;
	physicsContactHistoryDetail: any | null;
	physicsContactHistoryError: string | null;
	physicsContactHistoryBusy: boolean;
	physicsContactHistoryEventTypes: PhysicsContactEventType[];
	physicsContactHistoryBodyNodeIds: string;
	physicsContactHistoryFromMs: string;
	physicsContactHistoryToMs: string;
	physicsContactHistoryMinimumImpulse: string;
	physicsContactHistoryMaximumImpulse: string;
	physicsContactReplayRate: number;
	physicsContactReplayTrailMs: number;
	physicsContactReplayLoop: boolean;
	physicsContactReplayNormalScale: number;
	physicsContactReplayPointSize: number;
	scriptTemplates: { id: string; description: string; path?: string }[];
	scriptTemplateId: string;
	scriptPath: string;
	scriptClassName: string;
	scriptTemplateError: string | null;
	projectScriptOrderPath: string;
	projectScriptOrder: number;
	sourceControlStatus: {
		branch: string;
		clean: boolean;
		changes: { index: string; worktree: string; path: string }[];
		changeCount: number;
		stagedCount: number;
		unstagedCount: number;
		truncated: boolean;
	} | null;
	sourceControlError: string | null;
	sourceControlHistory: { hash: string; shortHash: string; author: string; date: string; subject: string }[];
	sourceControlDiff: { path: string; diff: string; truncated: boolean } | null;
	sourceControlCommitMessage: string;
	sourceControlRemote: string;
	sourceControlBranch: string;
	sourceControlNewBranch: string;
	sourceControlStartPoint: string;
	sourceControlTagName: string;
	sourceControlTagMessage: string;
	sourceControlRefs: {
		currentBranch: string | null;
		upstream: string | null;
		ahead: number;
		behind: number;
		localBranches: { name: string; hash: string; current: boolean }[];
		remoteBranches: { name: string; hash: string }[];
		tags: { name: string; hash: string; objectType: string; subject: string }[];
	} | null;
	sourceControlIntegrationTarget: string;
	sourceControlIntegrationPreview: any | null;
	sourceControlIntegrationState: any | null;
	sourceControlRemoteRefs: any | null;
	sourceControlRemoteRefName: string;
	sourceControlConflictDetails: any | null;
	sourceControlConflictCustomText: string;
	sourceControlAuthentication: any | null;
	sourceControlImageConflict: any | null;
	sourceControlSemanticConflict: any | null;
	sourceControlSemanticConflictResolutions: any[];
	sourceControlReviewProvider: any | null;
	sourceControlReviewProviderType: "github" | "gitlab" | "bitbucket" | "azure";
	sourceControlReviewAuthenticationMode: "provider" | "pat" | "bearer";
	sourceControlReviewApiBaseUrl: string;
	sourceControlReviewRepository: string;
	sourceControlReviewTokenEnvironmentVariable: string;
	sourceControlReviews: any[];
	sourceControlReviewNumber: string;
	sourceControlReviewDetail: any | null;
	sourceControlReviewMetadata: any | null;
	sourceControlReviewReviewers: string;
	sourceControlReviewTeams: string;
	sourceControlReviewLabels: string;
	sourceControlReviewChecks: any | null;
	sourceControlReviewRunId: string;
	sourceControlReviewRerunMode: "failed" | "all";
	sourceControlReviewTitle: string;
	sourceControlReviewBody: string;
	sourceControlReviewHead: string;
	sourceControlReviewBase: string;
	sourceControlReviewMergeMethod: "merge" | "squash" | "rebase";
	sourceControlWorkspace: any | null;
	sourceControlWorkspacePendingFilter: string;
	sourceControlWorkspaceIncomingFilter: string;
	sourceControlWorkspaceBranchFilter: string;
	sourceControlWorkspaceChangeset: any | null;
	sourceControlWorkspaceShelveset: any | null;
	sourceControlWorkspaceFolderPath: string;
	sourceControlWorkspaceShelvesetMessage: string;
	sourceControlWorkspaceShelvesetPaths: string;
	sourceControlWorkspaceSelectedRef: { kind: "branch" | "label"; name: string; hash: string } | null;
	sourceControlWorkspaceRenameValue: string;
	sourceControlWorkspaceRenameEditing: boolean;
	sourceControlBusy: boolean;
	sourceControlResult: string | null;
	assetLocks: any[];
	assetLockPath: string;
	assetLockOwner: string;
	assetLockNote: string;
	assetLockError: string | null;
	assetLockBusy: boolean;
	assetLockPolicy: any | null;
	assetLockRules: any[];
	assetLockRuleName: string;
	assetLockRulePattern: string;
	assetLockRuleDestinationBranch: string;
	assetLockRuleDestinationRemote: string;
	assetLockRuleRetention: "manual" | "untilMerged";
	semanticDiffSourcePath: string;
	semanticDiffTargetPath: string;
	semanticDiffTolerance: number;
	semanticDiffResult: any | null;
	semanticDiffError: string | null;
	semanticDiffBusy: boolean;
	semanticMergeBasePath: string;
	semanticMergeOursPath: string;
	semanticMergeTheirsPath: string;
	semanticMergeOutputPath: string;
	semanticMergeResolution: "manual" | "ours" | "theirs";
	semanticMergeResult: any | null;
	semanticMergeError: string | null;
	semanticMergeBusy: boolean;
	semanticMergeConflictResolutions: any[];
	semanticMergeCustomValues: Record<string, string>;
	semanticMergeRules: any[];
	semanticMergeRuleIds: string[];
	semanticMergeRuleName: string;
	semanticMergeRuleFilePattern: string;
	semanticMergeRulePathPrefix: string;
	semanticMergeRuleChoice: "ours" | "theirs" | "base" | "delete";
	projectChangelists: any[];
	changelistName: string;
	changelistOwner: string;
	changelistDescription: string;
	changelistSelectedId: string;
	changelistPaths: string;
	changelistError: string | null;
	changelistBusy: boolean;
	collaborationStatus: any | null;
	collaborationMembers: any[];
	collaborationPresence: any[];
	collaborationToken: string;
	collaborationBootstrapName: string;
	collaborationJoinMemberId: string;
	collaborationJoinAccessKey: string;
	collaborationClientName: string;
	collaborationPresenceColor: string;
	collaborationToolMode: "select" | "move" | "rotate" | "scale" | "rect" | "paint" | "terrain" | "animate" | "play" | "navigate" | "custom";
	collaborationHoveredNodeId: string;
	collaborationNewMemberName: string;
	collaborationNewMemberRole: "admin" | "editor" | "viewer";
	collaborationLastCredential: string;
	collaborationError: string | null;
	collaborationBusy: boolean;
	collaborationRevisionNodeId: string;
	collaborationRevisionPosition: string;
	collaborationRevision: any | null;
	collaborationRevisionError: string | null;
	collaborationRevisionBusy: boolean;
	collaborationNodeEditRevision: any | null;
	collaborationNodeEditError: string | null;
	collaborationNodeEditBusy: boolean;
	collaborationStructureHierarchy: any | null;
	collaborationStructureParentId: string;
	collaborationStructureProperties: any | null;
	collaborationStructurePaths: string;
	collaborationStructureValues: string;
	collaborationStructureError: string | null;
	collaborationStructureBusy: boolean;
	collaborativeTextPath: string;
	collaborativeTextAppend: string;
	collaborativeTextDocument: any | null;
	collaborativeTextError: string | null;
	collaborativeTextBusy: boolean;
	collaborativeCollectionName: string;
	collaborativeCollectionValue: string;
	collaborativeCollectionDocument: any | null;
	collaborativeCollectionError: string | null;
	collaborativeCollectionBusy: boolean;
	remoteCollaborationGateway: any | null;
	remoteCollaborationEvents: any[];
	remoteCollaborationBindAddress: string;
	remoteCollaborationPort: number;
	remoteCollaborationAllowedOrigins: string;
	remoteCollaborationAllowedHosts: string;
	remoteCollaborationTlsCertificatePath: string;
	remoteCollaborationTlsPrivateKeyPath: string;
	remoteCollaborationTlsHosts: string;
	remoteCollaborationTlsValidityDays: number;
	remoteCollaborationTlsInfo: any | null;
	remoteCollaborationDiscovery: any | null;
	remoteCollaborationDiscoveredProjects: any[];
	remoteCollaborationDiscoveryEnabled: boolean;
	remoteCollaborationDiscoveryDisplayName: string;
	remoteCollaborationDiscoveryAddress: string;
	remoteCollaborationDiscoveryPort: number;
	remoteCollaborationRelay: any | null;
	remoteCollaborationRelayEnabled: boolean;
	remoteCollaborationRelayUrl: string;
	remoteCollaborationRelayProjectSlug: string;
	remoteCollaborationRelayTokenEnvironmentVariable: string;
	remoteCollaborationRelayAccessToken: string;
	remoteCollaborationHistoryEnabled: boolean;
	remoteCollaborationHistoryRetention: number;
	remoteCollaborationError: string | null;
	remoteCollaborationBusy: boolean;
	videoPlayerName: string;
	videoPlayerPath: string;
	videoPlayerSourceType: "asset" | "url";
	videoPlayerTargetMode: "material" | "renderTexture" | "cameraNearPlane" | "cameraFarPlane" | "apiOnly";
	videoPlayerMaterialId: string;
	videoPlayerCameraId: string;
	vfxBudgetProfileName: string;
	vfxCapacityScale: number;
	vfxEmissionScale: number;
	vfxMaxCapacity: number;
	spriteAtlasSources: string;
	spriteAtlasOutputPath: string;
	spriteAtlasPadding: number;
	spriteAtlasTrimTransparent: boolean;
	spriteAtlasAllowRotation: boolean;
	spriteAtlasError: string | null;
	spriteSheetSourcePath: string;
	spriteSheetOutputPath: string;
	spriteSheetFrames: string;
	spriteSheetError: string | null;
	performanceBudgetName: string;
	performanceBudgetMetric: string;
	performanceBudgetLimit: number;
	terrainStreamingName: string;
	terrainStreamingDistance: number;
	terrainStreamingPreloadDistance: number;
	terrainStreamingUnloadDistance: number;
	terrainStreamingMode: "resident" | "release" | "stream";
	terrainStreamingRemoteBaseUrl: string;
	platformDiagnostics: any[];
	platformBusy: boolean;
	webBuildEvidence: Record<string, any>;
	webBuildBusyId: string | null;
	deviceProfileId: string;
	deviceProfileName: string;
	deviceLabPairing: any | null;
	deviceLabBusy: boolean;
}

export class EditorSceneInspector extends Component<IEditorInspectorImplementationProps<Scene>, IEditorSceneInspectorState> {
	private _collaborationHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private _audioMixerRefreshTimeout: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: unknown): boolean {
		return isScene(object);
	}

	public constructor(props: IEditorInspectorImplementationProps<Scene>) {
		super(props);

		this.state = {
			dragOverVlsMesh: false,

			animationGroupsSearch: "",
			selectedAnimationGroups: [],
			spriteIKRootNodeId: "",
			spriteIKJointNodeId: "",
			spriteIKTipNodeId: "",
			spriteIKTargetNodeId: "",
			spriteIKRigName: "Sprite Rig",
			reflectionProbeName: "Reflection Probe",
			bakedGiResolution: 64,
			bakedGiSamples: 4,
			bakedGiBounces: 1,
			bakedGiBusy: false,
			renderGraphAssetPath: "assets/rendering/main.rendergraph.json",
			renderGraphAssetName: "Main Render Graph",
			renderGraphAssetBusy: false,
			rendererFeatureAssetPath: "assets/rendering/feature.renderfeature.json",
			rendererFeatureAssetName: "Renderer Feature",
			rendererFeaturePassIds: "",
			rendererFeaturePrefix: "feature",
			rendererFeatureBusy: false,
			rendererDataAssetPath: "assets/rendering/main.rendererdata.json",
			rendererDataAssetName: "Main Renderer",
			rendererDataRenderingPath: "forward",
			rendererDataCameraId: "",
			rendererDataBusy: false,
			cameraStackName: "Camera Stack",
			cameraStackBaseCameraId: "",
			cameraStackOverlayCameraId: "",
			renderingLayerName: "Rendering Layer",
			renderingLayerBit: 0,
			rendererListName: "Renderer List",
			lightProbeName: "Light Probe Volume",
			lightProbeBaseResolution: 3,
			lightProbeAdaptiveLevels: 1,
			lightProbeSamples: 32,
			lightProbeBusyId: null,
			sceneTestName: "Scene Test",
			sceneTestNodeId: "",
			testingSuiteName: "Game Tests",
			testingSuiteMode: "play",
			testingFilter: "",
			testingBusy: false,
			testingCodeBusy: false,
			projectCodeTests: null,
			visualBaselinePath: "",
			visualCandidatePath: "",
			visualTolerance: 0,
			visualResult: null,
			localizationTables: [],
			localizationData: null,
			localizationLocales: [],
			localizationAssetTables: [],
			localizationError: null,
			localizationTableName: "Strings",
			localizationFallbackLocale: "en",
			localizationSelectedTable: "",
			localizationKey: "",
			localizationLocale: "en",
			localizationValue: "",
			localizationSmart: false,
			localizationLocaleName: "English",
			localizationDirection: "auto",
			localizationLocaleFallbacks: "",
			localizationPseudoEnabled: false,
			localizationAssetTableName: "Localized Assets",
			localizationSelectedAssetTable: "",
			localizationAssetKey: "",
			localizationAssetPath: "assets/",
			localizationAssetType: "texture",
			pseudoLocalizationValue: null,
			localizationValidation: null,
			guiAccessibilityValidation: null,
			guiAccessibilityGuis: [],
			guiAccessibilityGuiId: "",
			guiAccessibilityAuthoring: null,
			guiAccessibilityControlId: "",
			guiAccessibilityRole: "button",
			guiAccessibilityLabel: "",
			guiAccessibilityFocusOrder: 0,
			guiLocalizationProperty: "text",
			guiLocalizationTable: "",
			guiLocalizationKey: "",
			physicsContactCapture: null,
			physicsContactHistories: [],
			physicsContactHistorySelectedPath: "",
			physicsContactHistoryPath: "assets/physics/contact-history.physicscontacts.json",
			physicsContactHistoryName: "Contact History",
			physicsContactHistoryDetail: null,
			physicsContactHistoryError: null,
			physicsContactHistoryBusy: false,
			physicsContactHistoryEventTypes: [...physicsContactEventTypes],
			physicsContactHistoryBodyNodeIds: "",
			physicsContactHistoryFromMs: "",
			physicsContactHistoryToMs: "",
			physicsContactHistoryMinimumImpulse: "",
			physicsContactHistoryMaximumImpulse: "",
			physicsContactReplayRate: 1,
			physicsContactReplayTrailMs: 250,
			physicsContactReplayLoop: false,
			physicsContactReplayNormalScale: 100,
			physicsContactReplayPointSize: 12,
			scriptTemplates: [],
			scriptTemplateId: "component",
			scriptPath: "src/new-script.ts",
			scriptClassName: "",
			scriptTemplateError: null,
			projectScriptOrderPath: "",
			projectScriptOrder: 0,
			sourceControlStatus: null,
			sourceControlError: null,
			sourceControlHistory: [],
			sourceControlDiff: null,
			sourceControlCommitMessage: "",
			sourceControlRemote: "origin",
			sourceControlBranch: "",
			sourceControlNewBranch: "",
			sourceControlStartPoint: "HEAD",
			sourceControlTagName: "",
			sourceControlTagMessage: "",
			sourceControlRefs: null,
			sourceControlIntegrationTarget: "main",
			sourceControlIntegrationPreview: null,
			sourceControlIntegrationState: null,
			sourceControlRemoteRefs: null,
			sourceControlRemoteRefName: "",
			sourceControlConflictDetails: null,
			sourceControlConflictCustomText: "",
			sourceControlAuthentication: null,
			sourceControlImageConflict: null,
			sourceControlSemanticConflict: null,
			sourceControlSemanticConflictResolutions: [],
			sourceControlReviewProvider: null,
			sourceControlReviewProviderType: "github",
			sourceControlReviewAuthenticationMode: "provider",
			sourceControlReviewApiBaseUrl: "https://api.github.com/",
			sourceControlReviewRepository: "",
			sourceControlReviewTokenEnvironmentVariable: "GITHUB_TOKEN",
			sourceControlReviews: [],
			sourceControlReviewNumber: "",
			sourceControlReviewDetail: null,
			sourceControlReviewMetadata: null,
			sourceControlReviewReviewers: "",
			sourceControlReviewTeams: "",
			sourceControlReviewLabels: "",
			sourceControlReviewChecks: null,
			sourceControlReviewRunId: "",
			sourceControlReviewRerunMode: "failed",
			sourceControlReviewTitle: "",
			sourceControlReviewBody: "",
			sourceControlReviewHead: "",
			sourceControlReviewBase: "main",
			sourceControlReviewMergeMethod: "squash",
			sourceControlWorkspace: null,
			sourceControlWorkspacePendingFilter: "",
			sourceControlWorkspaceIncomingFilter: "",
			sourceControlWorkspaceBranchFilter: "",
			sourceControlWorkspaceChangeset: null,
			sourceControlWorkspaceShelveset: null,
			sourceControlWorkspaceFolderPath: "assets",
			sourceControlWorkspaceShelvesetMessage: "Work in progress",
			sourceControlWorkspaceShelvesetPaths: "",
			sourceControlWorkspaceSelectedRef: null,
			sourceControlWorkspaceRenameValue: "",
			sourceControlWorkspaceRenameEditing: false,
			sourceControlBusy: false,
			sourceControlResult: null,
			assetLocks: [],
			assetLockPath: "assets/",
			assetLockOwner: "Editor User",
			assetLockNote: "",
			assetLockError: null,
			assetLockBusy: false,
			assetLockPolicy: null,
			assetLockRules: [],
			assetLockRuleName: "Serialized Assets",
			assetLockRulePattern: "assets/**/*.prefab",
			assetLockRuleDestinationBranch: "main",
			assetLockRuleDestinationRemote: "",
			assetLockRuleRetention: "untilMerged",
			semanticDiffSourcePath: "assets/Base.scene",
			semanticDiffTargetPath: "assets/Working.scene",
			semanticDiffTolerance: 0,
			semanticDiffResult: null,
			semanticDiffError: null,
			semanticDiffBusy: false,
			semanticMergeBasePath: "assets/Base.scene",
			semanticMergeOursPath: "assets/Ours.scene",
			semanticMergeTheirsPath: "assets/Theirs.scene",
			semanticMergeOutputPath: "assets/Merged.scene",
			semanticMergeResolution: "manual",
			semanticMergeResult: null,
			semanticMergeError: null,
			semanticMergeBusy: false,
			semanticMergeConflictResolutions: [],
			semanticMergeCustomValues: {},
			semanticMergeRules: [],
			semanticMergeRuleIds: [],
			semanticMergeRuleName: "Merge Rule",
			semanticMergeRuleFilePattern: "*.json",
			semanticMergeRulePathPrefix: "/",
			semanticMergeRuleChoice: "theirs",
			projectChangelists: [],
			changelistName: "New Changelist",
			changelistOwner: "Editor User",
			changelistDescription: "",
			changelistSelectedId: "",
			changelistPaths: "",
			changelistError: null,
			changelistBusy: false,
			collaborationStatus: null,
			collaborationMembers: [],
			collaborationPresence: [],
			collaborationToken: "",
			collaborationBootstrapName: "Project Administrator",
			collaborationJoinMemberId: "",
			collaborationJoinAccessKey: "",
			collaborationClientName: "Babylon.js Editor",
			collaborationPresenceColor: "#3B82F6",
			collaborationToolMode: "select",
			collaborationHoveredNodeId: "",
			collaborationNewMemberName: "New Collaborator",
			collaborationNewMemberRole: "editor",
			collaborationLastCredential: "",
			collaborationError: null,
			collaborationBusy: false,
			collaborationRevisionNodeId: "",
			collaborationRevisionPosition: "",
			collaborationRevision: null,
			collaborationRevisionError: null,
			collaborationRevisionBusy: false,
			collaborationNodeEditRevision: null,
			collaborationNodeEditError: null,
			collaborationNodeEditBusy: false,
			collaborationStructureHierarchy: null,
			collaborationStructureParentId: "",
			collaborationStructureProperties: null,
			collaborationStructurePaths: "intensity",
			collaborationStructureValues: "{}",
			collaborationStructureError: null,
			collaborationStructureBusy: false,
			collaborativeTextPath: "src/scripts.ts",
			collaborativeTextAppend: "",
			collaborativeTextDocument: null,
			collaborativeTextError: null,
			collaborativeTextBusy: false,
			collaborativeCollectionName: "SharedSequence",
			collaborativeCollectionValue: '{\n\t"name": "New item"\n}',
			collaborativeCollectionDocument: null,
			collaborativeCollectionError: null,
			collaborativeCollectionBusy: false,
			remoteCollaborationGateway: null,
			remoteCollaborationEvents: [],
			remoteCollaborationBindAddress: "127.0.0.1",
			remoteCollaborationPort: 3713,
			remoteCollaborationAllowedOrigins: "",
			remoteCollaborationAllowedHosts: "127.0.0.1:3713\nlocalhost:3713",
			remoteCollaborationTlsCertificatePath: "certs/collaboration.crt",
			remoteCollaborationTlsPrivateKeyPath: "certs/collaboration.key",
			remoteCollaborationTlsHosts: "localhost\n127.0.0.1\n::1",
			remoteCollaborationTlsValidityDays: 397,
			remoteCollaborationTlsInfo: null,
			remoteCollaborationDiscovery: null,
			remoteCollaborationDiscoveredProjects: [],
			remoteCollaborationDiscoveryEnabled: false,
			remoteCollaborationDiscoveryDisplayName: "Babylon Project",
			remoteCollaborationDiscoveryAddress: "239.255.37.13",
			remoteCollaborationDiscoveryPort: 3714,
			remoteCollaborationRelay: null,
			remoteCollaborationRelayEnabled: false,
			remoteCollaborationRelayUrl: "",
			remoteCollaborationRelayProjectSlug: "",
			remoteCollaborationRelayTokenEnvironmentVariable: "BABYLON_EDITOR_RELAY_TOKEN",
			remoteCollaborationRelayAccessToken: "",
			remoteCollaborationHistoryEnabled: true,
			remoteCollaborationHistoryRetention: 1000,
			remoteCollaborationError: null,
			remoteCollaborationBusy: false,
			videoPlayerName: "Video Player",
			videoPlayerPath: "assets/video.webm",
			videoPlayerSourceType: "asset",
			videoPlayerTargetMode: "material",
			videoPlayerMaterialId: "",
			videoPlayerCameraId: "",
			vfxBudgetProfileName: "VFX Quality",
			vfxCapacityScale: 1,
			vfxEmissionScale: 1,
			vfxMaxCapacity: 1000,
			spriteAtlasSources: "",
			spriteAtlasOutputPath: "assets/atlas.png",
			spriteAtlasPadding: 2,
			spriteAtlasTrimTransparent: false,
			spriteAtlasAllowRotation: false,
			spriteAtlasError: null,
			spriteSheetSourcePath: "",
			spriteSheetOutputPath: "assets/sprites.json",
			spriteSheetFrames: '[{ "name": "idle", "x": 0, "y": 0, "width": 64, "height": 64 }]',
			spriteSheetError: null,
			performanceBudgetName: "Performance Budget",
			performanceBudgetMetric: "drawCalls",
			performanceBudgetLimit: 100,
			terrainStreamingName: "Terrain Tiles",
			terrainStreamingDistance: 50000,
			terrainStreamingPreloadDistance: 60000,
			terrainStreamingUnloadDistance: 75000,
			terrainStreamingMode: "stream",
			terrainStreamingRemoteBaseUrl: "",
			platformDiagnostics: [],
			platformBusy: false,
			webBuildEvidence: {},
			webBuildBusyId: null,
			deviceProfileId: "custom-device",
			deviceProfileName: "Custom Device",
			deviceLabPairing: null,
			deviceLabBusy: false,
		};
	}

	public componentDidMount(): void {
		this._refreshSourceControlStatus();
		this._refreshSourceControlHistory();
		this._refreshSourceControlRefs();
		void this._refreshSourceControlWorkspace();
		this._refreshSourceControlIntegration();
		this._refreshSourceControlIntegration();
		void this._refreshAssetLocks();
		void this._refreshAssetLockRules();
		void this._refreshProjectChangelists();
		void this._refreshProjectCollaboration();
		void this._refreshSemanticMergeRules();
		void this._refreshLocalizationTables();
		void this._refreshGUIAccessibilityAuthoring();
		void this._refreshScriptTemplates();
		void this._refreshPhysicsContactHistories();
		void this._refreshPlatformDiagnostics();
		void this._refreshProjectCodeTests();
		this._collaborationHeartbeatInterval = setInterval(() => {
			if (this.state.collaborationToken) {
				void this._heartbeatProjectCollaboration();
			}
		}, 45000);
	}

	public componentWillUnmount(): void {
		if (this._collaborationHeartbeatInterval) {
			clearInterval(this._collaborationHeartbeatInterval);
			this._collaborationHeartbeatInterval = null;
		}
		if (this._audioMixerRefreshTimeout) {
			clearTimeout(this._audioMixerRefreshTimeout);
			this._audioMixerRefreshTimeout = null;
		}
	}

	public render(): ReactNode {
		return (
			<>
				<EditorInspectorSectionField title="Colors">
					<EditorInspectorColorField object={this.props.object} property="clearColor" label={<div className="w-14">Clear</div>} />
					<EditorInspectorColorField object={this.props.object} property="ambientColor" label={<div className="w-14">Ambient</div>} />
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Environment">
					<EditorInspectorTextureField
						acceptCubeTexture
						object={this.props.object}
						property="environmentTexture"
						title="Environment Texture"
						onChange={() => this.forceUpdate()}
					/>
					<EditorInspectorNumberField object={this.props.object} property="iblIntensity" label="IBL Intensity" />
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Fog">
					<EditorInspectorSwitchField object={this.props.object} property="fogEnabled" label="Enabled" onChange={() => this.forceUpdate()} />

					{this.props.object.fogEnabled && (
						<>
							<EditorInspectorListField
								object={this.props.object}
								property="fogMode"
								label="Mode"
								items={[
									{ text: "None", value: Scene.FOGMODE_NONE },
									{ text: "Linear", value: Scene.FOGMODE_LINEAR },
									{ text: "Exp", value: Scene.FOGMODE_EXP },
									{ text: "Exp2", value: Scene.FOGMODE_EXP2 },
								]}
								onChange={() => this.forceUpdate()}
							/>

							{this.props.object.fogMode === Scene.FOGMODE_LINEAR && (
								<>
									<EditorInspectorNumberField object={this.props.object} property="fogStart" label="Start" />
									<EditorInspectorNumberField object={this.props.object} property="fogEnd" label="End" />
								</>
							)}

							{(this.props.object.fogMode === Scene.FOGMODE_EXP || this.props.object.fogMode === Scene.FOGMODE_EXP2) && (
								<EditorInspectorNumberField object={this.props.object} property="fogDensity" label="Density" />
							)}

							<EditorInspectorColorField object={this.props.object} property="fogColor" label="Color" />
						</>
					)}
				</EditorInspectorSectionField>

				<ScriptInspectorComponent editor={this.props.editor} object={this.props.object} />

				{this._getTerrainStreamingComponent()}
				{this._getPhysicsComponent()}
				{this._getPhysicsForceVisualizationComponent()}
				{this._getPhysicsContactHistoryComponent()}
				{this._getPhysicsCollisionLayersComponent()}
				{this._getPhysics2DMaterialsComponent()}
				<Physics2DSceneInspector scene={this.props.object} editor={this.props.editor} onChanged={() => this.forceUpdate()} />
				{this._getSpriteIKComponent()}
				{this._getClothsComponent()}
				{this._getBakedGiComponent()}
				{this._getLightProbeVolumesComponent()}
				{this._getLightingScenariosComponent()}
				{this._getReflectionProbesComponent()}
				<EditorSubsurfaceRuntimeInspector editor={this.props.editor} scene={this.props.object} />
				{this._getDeviceSimulationComponent()}
				{this._getDeviceLabComponent()}
				<EditorRenderDebugInspector editor={this.props.editor} scene={this.props.object} />
				{this._getTestingRunnerComponent()}
				{this._getPerformanceBudgetsComponent()}
				{this._getSceneTestsComponent()}
				{this._getVisualRegressionComponent()}
				{this._getLocalizationComponent()}
				{this._getGUIAccessibilityComponent()}
				<PackageManagerInspector scene={this.props.object} editor={this.props.editor} />
				{this._getScriptTemplatesComponent()}
				{this._getProjectScriptExecutionOrdersComponent()}
				{this._getAudioMixerComponent()}
				{this._getAudioRuntimeDiagnosticsComponent()}
				{this._getVideoPlayersComponent()}
				{this._getVfxBudgetProfilesComponent()}
				{this._getAddressablesComponent()}
				<InputActionsSceneInspector scene={this.props.object} editor={this.props.editor} />
				<XRSceneInspector scene={this.props.object} editor={this.props.editor} />
				{this._getSpriteAtlasPackerComponent()}
				{this._getSpriteSheetSlicerComponent()}
				{this._get2DSceneModeComponent()}
				{this._getPlatformSupportComponent()}
				{this._getBuildProfilesComponent()}
				{this._getSerializationSessionComponent()}
				{this._getBuildReportsComponent()}
				{this._getSourceControlComponent()}
				{this._getAssetLocksComponent()}
				{this._getProjectChangelistsComponent()}
				{this._getProjectCollaborationComponent()}
				{this._getCollaborationTransformRevisionComponent()}
				{this._getCollaborationNodeEditRevisionComponent()}
				{this._getCollaborationStructureRevisionComponent()}
				{this._getCollaborativeTextComponent()}
				{this._getCollaborativeCollectionComponent()}
				{this._getRemoteCollaborationComponent()}
				{this._getSemanticDiffComponent()}
				{this._getSemanticMergeComponent()}
				{this._getRenderingLayersAndRendererListsComponent()}
				{this._getCameraStacksComponent()}
				{this._getRendererDataComponent()}
				{this._getRenderingProfilesComponent()}
				<EditorOnTileRenderingInspector editor={this.props.editor} scene={this.props.object} />
				{this._getCustomRenderPassGraphComponent()}

				{this._getDefaultRenderingPipelineComponent()}
				{this._getCustomColorPostProcessComponent()}
				{this._getTAARenderingPipelineComponent()}
				{this._getSSAO2RenderingPipelineComponent()}
				{this._getMotionBlurPostProcessComponent()}
				{this._getSSRPipelineComponent()}
				{this._getVLSComponent()}

				{/* {this.props.editor.state.enableExperimentalFeatures && this._getIblShadowsRenderingPipelineComponent()} */}

				<EditorSceneAnimationGroupsInspector editor={this.props.editor} scene={this.props.object} />
			</>
		);
	}

	private _getSelectedTerrainIds(): string[] {
		return this.props.editor.layout.graph
			.getSelectedNodes()
			.map((entry) => entry.nodeData as any)
			.filter((node) => node?.metadata?.type === "Ground" && typeof node.id === "string")
			.map((node) => node.id);
	}

	private _getTerrainStreamingComponent(): ReactNode {
		const response = listTerrainStreamingGroups(this.props.object);
		const groups = response.groups as any[];
		const selectedTerrainIds = this._getSelectedTerrainIds();
		const createValid =
			!!this.state.terrainStreamingName.trim() &&
			selectedTerrainIds.length > 0 &&
			Number.isFinite(this.state.terrainStreamingDistance) &&
			this.state.terrainStreamingDistance > 0 &&
			this.state.terrainStreamingPreloadDistance >= this.state.terrainStreamingDistance &&
			this.state.terrainStreamingUnloadDistance >= this.state.terrainStreamingPreloadDistance;

		return (
			<EditorInspectorSectionField
				title="Terrain Tile Streaming"
				tooltip="Unity-style terrain tile loading with preload radius, visible distance, unload hysteresis, bounded asynchronous geometry requests, SHA-256 verification, retries, and editor/runtime evidence."
			>
				<div className="flex flex-col gap-2 text-xs">
					<div className="rounded-lg border border-border bg-muted/20 p-2">
						<div className="mb-2 font-medium">Create from selected Ground tiles</div>
						<div className="grid grid-cols-2 gap-2">
							<Input
								aria-label="Terrain streaming group name"
								value={this.state.terrainStreamingName}
								onChange={(event) => this.setState({ terrainStreamingName: event.currentTarget.value })}
							/>
							<select
								aria-label="Terrain streaming mode"
								className="h-9 rounded-md border border-input bg-background px-2 text-xs"
								value={this.state.terrainStreamingMode}
								onChange={(event) => this.setState({ terrainStreamingMode: event.currentTarget.value as IEditorSceneInspectorState["terrainStreamingMode"] })}
							>
								<option value="stream">Async binary geometry</option>
								<option value="release">Embedded geometry unload</option>
								<option value="resident">Visibility only</option>
							</select>
						</div>
						<div className="mt-2 grid grid-cols-3 gap-2">
							<label className="text-muted-foreground">
								Visible
								<Input
									aria-label="Terrain visible distance"
									type="number"
									min={0.001}
									value={this.state.terrainStreamingDistance}
									onChange={(event) => this.setState({ terrainStreamingDistance: Number(event.currentTarget.value) })}
								/>
							</label>
							<label className="text-muted-foreground">
								Preload
								<Input
									aria-label="Terrain preload distance"
									type="number"
									min={0.001}
									value={this.state.terrainStreamingPreloadDistance}
									onChange={(event) => this.setState({ terrainStreamingPreloadDistance: Number(event.currentTarget.value) })}
								/>
							</label>
							<label className="text-muted-foreground">
								Unload
								<Input
									aria-label="Terrain unload distance"
									type="number"
									min={0.001}
									value={this.state.terrainStreamingUnloadDistance}
									onChange={(event) => this.setState({ terrainStreamingUnloadDistance: Number(event.currentTarget.value) })}
								/>
							</label>
						</div>
						{this.state.terrainStreamingMode === "stream" && (
							<Input
								className="mt-2"
								aria-label="Terrain remote base URL"
								placeholder="Optional HTTPS CDN base URL"
								value={this.state.terrainStreamingRemoteBaseUrl}
								onChange={(event) => this.setState({ terrainStreamingRemoteBaseUrl: event.currentTarget.value })}
							/>
						)}
						<div className="mt-2 flex items-center justify-between gap-2">
							<span className={selectedTerrainIds.length ? "text-muted-foreground" : "text-amber-400"}>
								{selectedTerrainIds.length
									? `${selectedTerrainIds.length} selected Ground tile${selectedTerrainIds.length === 1 ? "" : "s"}`
									: "Select one or more Ground tiles"}
							</span>
							<Button size="sm" disabled={!createValid} onClick={() => this._createTerrainStreamingGroup()}>
								Create Group
							</Button>
						</div>
					</div>

					{groups.map((group) => {
						const tiles = group.runtime?.tiles ?? [];
						const statusCounts = tiles.reduce((counts: Record<string, number>, tile: any) => {
							counts[tile.status] = (counts[tile.status] ?? 0) + 1;
							return counts;
						}, {});
						const mode = group.streamGeometry ? "stream" : group.releaseGeometry ? "release" : "resident";
						return (
							<div key={`${group.id}:${group.revision}`} className="rounded-lg bg-input p-2">
								<div className="flex items-center justify-between gap-2">
									<div className="min-w-0">
										<div className="truncate font-medium">{group.name}</div>
										<div className="text-muted-foreground">
											r{group.revision} · {group.terrainIds.length} tile{group.terrainIds.length === 1 ? "" : "s"}
										</div>
									</div>
									<div className="flex gap-1">
										<Button
											size="sm"
											variant={group.enabled ? "secondary" : "outline"}
											onClick={() => this._updateTerrainStreamingGroup(group, { enabled: !group.enabled })}
										>
											{group.enabled ? "Enabled" : "Disabled"}
										</Button>
										<Button size="sm" variant="ghost" className="!text-red-400" onClick={() => void this._deleteTerrainStreamingGroup(group)}>
											Remove
										</Button>
									</div>
								</div>
								<div className="mt-2 grid grid-cols-2 gap-2">
									<Input
										aria-label={`Terrain group ${group.name} name`}
										defaultValue={group.name}
										onBlur={(event) =>
											event.currentTarget.value !== group.name && this._updateTerrainStreamingGroup(group, { name: event.currentTarget.value })
										}
									/>
									<select
										aria-label={`Terrain group ${group.name} mode`}
										className="h-9 rounded-md border border-input bg-background px-2 text-xs"
										value={mode}
										onChange={(event) => this._setTerrainStreamingMode(group, event.currentTarget.value as IEditorSceneInspectorState["terrainStreamingMode"])}
									>
										<option value="stream">Async binary geometry</option>
										<option value="release">Embedded geometry unload</option>
										<option value="resident">Visibility only</option>
									</select>
								</div>
								<div className="mt-2 grid grid-cols-3 gap-2">
									{(["distance", "preloadDistance", "unloadDistance"] as const).map((property) => (
										<label key={property} className="text-muted-foreground">
											{property === "distance" ? "Visible" : property === "preloadDistance" ? "Preload" : "Unload"}
											<Input
												aria-label={`Terrain ${property}`}
												type="number"
												min={0.001}
												defaultValue={group[property]}
												onBlur={(event) => this._updateTerrainStreamingNumber(group, property, event.currentTarget.value)}
											/>
										</label>
									))}
								</div>
								{mode === "stream" && (
									<>
										<Input
											className="mt-2"
											aria-label={`Terrain group ${group.name} remote base URL`}
											placeholder="Packaged geometry or optional HTTPS CDN base URL"
											defaultValue={group.remoteBaseUrl ?? ""}
											onBlur={(event) => this._updateTerrainStreamingGroup(group, { remoteBaseUrl: event.currentTarget.value.trim() || null })}
										/>
										<div className="mt-2 grid grid-cols-4 gap-2">
											{(
												[
													["maxConcurrentLoads", "Concurrent", 1],
													["retryCount", "Retries", 0],
													["requestTimeoutMs", "Timeout ms", 1000],
													["unloadDelayMs", "Unload ms", 0],
												] as const
											).map(([property, label, minimum]) => (
												<label key={property} className="text-muted-foreground">
													{label}
													<Input
														aria-label={`Terrain ${label}`}
														type="number"
														min={minimum}
														defaultValue={group[property]}
														onBlur={(event) => this._updateTerrainStreamingNumber(group, property, event.currentTarget.value)}
													/>
												</label>
											))}
										</div>
									</>
								)}
								<div className="mt-2 text-muted-foreground">
									Runtime: {group.runtime?.configured ? "configured" : "not configured"}
									{Object.entries(statusCounts)
										.map(([status, count]) => ` · ${status} ${count}`)
										.join("")}
								</div>
								{tiles.some((tile: any) => tile.error) && <div className="mt-1 text-red-400">{tiles.find((tile: any) => tile.error)?.error}</div>}
							</div>
						);
					})}
					{!groups.length && <div className="text-muted-foreground">No terrain streaming groups. Select editor Ground nodes in the Hierarchy to create one.</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createTerrainStreamingGroup(): void {
		try {
			const mode = this.state.terrainStreamingMode;
			setTerrainStreamingGroup(
				this.props.object,
				{
					name: this.state.terrainStreamingName.trim(),
					terrainIds: this._getSelectedTerrainIds(),
					distance: this.state.terrainStreamingDistance,
					preloadDistance: this.state.terrainStreamingPreloadDistance,
					unloadDistance: this.state.terrainStreamingUnloadDistance,
					streamGeometry: mode === "stream",
					releaseGeometry: mode === "release",
					remoteBaseUrl: this.state.terrainStreamingRemoteBaseUrl.trim() || undefined,
				},
				{ editor: this.props.editor }
			);
			toast.success("Terrain streaming group created.");
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create the terrain streaming group.");
		}
	}

	private _updateTerrainStreamingGroup(group: any, patch: Record<string, unknown>): void {
		try {
			setTerrainStreamingGroup(this.props.object, { groupId: group.id, expectedRevision: group.revision, ...patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update the terrain streaming group.");
			this.forceUpdate();
		}
	}

	private _updateTerrainStreamingNumber(group: any, property: string, source: string): void {
		const value = Number(source);
		if (!Number.isFinite(value)) {
			toast.error(`${property} must be a finite number.`);
			this.forceUpdate();
			return;
		}
		this._updateTerrainStreamingGroup(group, { [property]: value });
	}

	private _setTerrainStreamingMode(group: any, mode: IEditorSceneInspectorState["terrainStreamingMode"]): void {
		this._updateTerrainStreamingGroup(group, { streamGeometry: mode === "stream", releaseGeometry: mode === "release" });
	}

	private async _deleteTerrainStreamingGroup(group: any): Promise<void> {
		const confirmed = await showConfirm("Delete Terrain Streaming Group?", `Remove “${group.name}” and restore its resident authoring geometry?`, {
			confirmText: "Delete Group",
		});
		if (!confirmed) {
			return;
		}
		try {
			deleteTerrainStreamingGroup(this.props.object, { groupId: group.id, expectedRevision: group.revision }, { editor: this.props.editor });
			toast.success("Terrain streaming group deleted and resident geometry restored.");
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not delete the terrain streaming group.");
		}
	}

	private _getBakedGiComponent(): ReactNode {
		const bake = getBakedGlobalIllumination(this.props.object) as any;
		return (
			<EditorInspectorSectionField
				title="Baked Global Illumination"
				tooltip="Automatic static lightmap generation using real mesh UVs, direct-light shadow rays, and an optional deterministic diffuse bounce. The same persisted bake/get/clear actions are available to Codex CLI and Claude CLI."
			>
				{bake.configured ? (
					<div className="flex flex-col gap-2 text-xs">
						<div className="rounded bg-input p-2">
							<div className="font-medium">Completion: Applied</div>
							<div className="text-muted-foreground">
								{bake.backend} · {bake.meshCount} meshes · {bake.resolution}² · {bake.bounces} bounce{bake.bounces === 1 ? "" : "s"}
							</div>
							<div className="text-muted-foreground">
								{Number(bake.totalCoveredTexels).toLocaleString()} covered texels · {Number(bake.totalRayCount).toLocaleString()} rays
							</div>
							<div className={bake.totalOverlapTexels || bake.totalSaturatedTexels ? "text-amber-400" : "text-green-400"}>
								Testing evidence: {bake.totalOverlapTexels} overlaps · {bake.totalSaturatedTexels} saturated
							</div>
						</div>
						<Button size="sm" variant="destructive" disabled={this.state.bakedGiBusy} onClick={() => void this._clearBakedGi()}>
							{this.state.bakedGiBusy ? "Clearing…" : "Clear Bake and Restore Materials"}
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-2 text-xs">
						<div className="grid grid-cols-3 gap-2">
							<label className="flex flex-col gap-1">
								Resolution
								<Input
									type="number"
									min={16}
									max={256}
									value={this.state.bakedGiResolution}
									onChange={(event) => this.setState({ bakedGiResolution: Number(event.currentTarget.value) })}
								/>
							</label>
							<label className="flex flex-col gap-1">
								Samples
								<Input
									type="number"
									min={1}
									max={32}
									value={this.state.bakedGiSamples}
									onChange={(event) => this.setState({ bakedGiSamples: Number(event.currentTarget.value) })}
								/>
							</label>
							<label className="flex flex-col gap-1">
								Bounces
								<select
									className="h-9 rounded border border-input bg-background px-2"
									value={this.state.bakedGiBounces}
									onChange={(event) => this.setState({ bakedGiBounces: Number(event.currentTarget.value) as 0 | 1 })}
								>
									<option value={0}>Direct only</option>
									<option value={1}>One bounce</option>
								</select>
							</label>
						</div>
						<div className="text-muted-foreground">Auto UV selection prefers UV2 and falls back to UV0. PBR and Standard materials are cloned per mesh.</div>
						<Button
							size="sm"
							disabled={
								this.state.bakedGiBusy ||
								!Number.isInteger(this.state.bakedGiResolution) ||
								this.state.bakedGiResolution < 16 ||
								this.state.bakedGiResolution > 256 ||
								!Number.isInteger(this.state.bakedGiSamples) ||
								this.state.bakedGiSamples < 1 ||
								this.state.bakedGiSamples > 32
							}
							onClick={() => void this._bakeBakedGi()}
						>
							{this.state.bakedGiBusy ? "Baking…" : "Bake Eligible Meshes"}
						</Button>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private async _bakeBakedGi(): Promise<void> {
		this.setState({ bakedGiBusy: true });
		try {
			const result = (await bakeBakedGlobalIllumination(
				this.props.object,
				{
					resolution: this.state.bakedGiResolution,
					samples: this.state.bakedGiSamples,
					bounces: this.state.bakedGiBounces,
					uvChannel: "auto",
				},
				{ editor: this.props.editor }
			)) as any;
			toast.success(`Baked ${result.meshCount} mesh lightmap${result.meshCount === 1 ? "" : "s"} with ${Number(result.totalRayCount).toLocaleString()} rays.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not bake global illumination.");
		} finally {
			this.setState({ bakedGiBusy: false });
		}
	}

	private async _clearBakedGi(): Promise<void> {
		const bake = getBakedGlobalIllumination(this.props.object) as any;
		if (!bake.configured) {
			return;
		}
		const confirmed = await showConfirm(
			"Clear baked global illumination?",
			"Restore the original mesh materials and permanently delete only the generated lightmaps owned by this bake?",
			{ confirmText: "Clear Bake" }
		);
		if (!confirmed) {
			return;
		}
		this.setState({ bakedGiBusy: true });
		try {
			await clearBakedGlobalIllumination(this.props.object, { expectedBakeId: bake.bakeId, confirm: true }, { editor: this.props.editor });
			toast.success("Baked GI cleared and original materials restored.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not clear baked global illumination.");
		} finally {
			this.setState({ bakedGiBusy: false });
		}
	}

	private _getLightProbeVolumesComponent(): ReactNode {
		const inspection = listLightProbeVolumes(this.props.object) as any;
		const volumes = inspection.volumes as any[];
		const runtime = inspection.runtime as any;
		return (
			<EditorInspectorSectionField
				title="Light Probes / Adaptive Probe Volumes"
				tooltip="Bakes adaptive SH9 irradiance probes around static geometry, then trilinearly lights targeted moving PBR/Standard meshes through the same GLSL/WGSL runtime in editor preview and exported games. Six strict MCP tools expose the complete lifecycle to Codex CLI and Claude CLI."
			>
				<div className="flex flex-col gap-2 text-xs">
					<div className="rounded bg-input p-2 text-muted-foreground">
						Runtime: {runtime.backend} · {runtime.materialPluginCount} material plugins · GLSL + WGSL · {runtime.matchedQueries}/{runtime.queries} matched queries
					</div>
					{volumes.map((volume) => {
						const evidence = volume.bake?.evidence;
						const busy = this.state.lightProbeBusyId === volume.id;
						return (
							<div key={volume.id} className="flex flex-col gap-2 rounded border border-border p-2">
								<div className="flex items-center justify-between gap-2">
									<div>
										<div className="font-medium">{volume.name}</div>
										<div className="text-muted-foreground">
											rev {volume.revision} · {volume.baseResolution.join("×")} base · {volume.adaptiveLevels} adaptive level
											{volume.adaptiveLevels === 1 ? "" : "s"} · {volume.targetMeshIds.length} targets
										</div>
									</div>
									<Button size="sm" variant="outline" disabled={busy} onClick={() => void this._setLightProbeVolume(volume, { enabled: !volume.enabled })}>
										{volume.enabled ? "Disable" : "Enable"}
									</Button>
								</div>
								<div className="text-muted-foreground">
									Bounds: [{volume.minimum.map((value: number) => value.toFixed(1)).join(", ")}] → [
									{volume.maximum.map((value: number) => value.toFixed(1)).join(", ")}]
								</div>
								{evidence ? (
									<div className="rounded bg-input p-2">
										<div className="font-medium text-green-400">Completion: Baked and Applied</div>
										<div className="text-muted-foreground">
											{evidence.probeCount} probes · {evidence.cellCount} cells · {evidence.refinedCellCount} refined ·{" "}
											{Number(evidence.totalRays).toLocaleString()} rays
										</div>
										<div className={evidence.minimumValidity < 0.5 ? "text-amber-400" : "text-green-400"}>
											Testing evidence: {(evidence.minimumValidity * 100).toFixed(1)}% minimum · {(evidence.averageValidity * 100).toFixed(1)}% average
											validity
										</div>
									</div>
								) : (
									<div className="rounded bg-input p-2 text-amber-400">Completion: Authored · bake pending</div>
								)}
								<div className="grid grid-cols-2 gap-2">
									<Button size="sm" disabled={busy} onClick={() => void this._bakeLightProbeVolume(volume)}>
										{busy ? "Working…" : evidence ? "Rebake Volume" : "Bake Volume"}
									</Button>
									<Button size="sm" variant="destructive" disabled={busy} onClick={() => void this._deleteLightProbeVolume(volume)}>
										Delete Volume
									</Button>
								</div>
							</div>
						);
					})}
					<div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_5rem] gap-2">
						<Input
							value={this.state.lightProbeName}
							onChange={(event) => this.setState({ lightProbeName: event.currentTarget.value })}
							aria-label="Light Probe Volume name"
						/>
						<Input
							type="number"
							min={2}
							max={8}
							value={this.state.lightProbeBaseResolution}
							onChange={(event) => this.setState({ lightProbeBaseResolution: Number(event.currentTarget.value) })}
							aria-label="Base probe resolution per axis"
						/>
						<Input
							type="number"
							min={0}
							max={2}
							value={this.state.lightProbeAdaptiveLevels}
							onChange={(event) => this.setState({ lightProbeAdaptiveLevels: Number(event.currentTarget.value) })}
							aria-label="Adaptive subdivision levels"
						/>
						<Input
							type="number"
							min={8}
							max={256}
							value={this.state.lightProbeSamples}
							onChange={(event) => this.setState({ lightProbeSamples: Number(event.currentTarget.value) })}
							aria-label="Probe bake samples"
						/>
					</div>
					<div className="text-muted-foreground">
						Name · base probes/axis · adaptive levels · bake samples. New volumes use padded scene bounds and all eligible PBR/Standard meshes.
					</div>
					<Button
						size="sm"
						disabled={
							this.state.lightProbeBusyId !== null ||
							!this.state.lightProbeName.trim() ||
							!Number.isInteger(this.state.lightProbeBaseResolution) ||
							this.state.lightProbeBaseResolution < 2 ||
							this.state.lightProbeBaseResolution > 8 ||
							!Number.isInteger(this.state.lightProbeAdaptiveLevels) ||
							this.state.lightProbeAdaptiveLevels < 0 ||
							this.state.lightProbeAdaptiveLevels > 2
						}
						onClick={() => void this._createLightProbeVolume()}
					>
						Create Scene-Bounds Volume
					</Button>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _createLightProbeVolume(): Promise<void> {
		this.setState({ lightProbeBusyId: "create" });
		try {
			await createLightProbeVolume(
				this.props.object,
				{
					name: this.state.lightProbeName.trim(),
					baseResolution: [this.state.lightProbeBaseResolution, this.state.lightProbeBaseResolution, this.state.lightProbeBaseResolution],
					adaptiveLevels: this.state.lightProbeAdaptiveLevels,
				},
				{ editor: this.props.editor }
			);
			toast.success("Light Probe Volume created. Bake it to generate adaptive SH9 coefficients.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create the Light Probe Volume.");
		} finally {
			this.setState({ lightProbeBusyId: null });
		}
	}

	private async _setLightProbeVolume(volume: any, changes: Record<string, unknown>): Promise<void> {
		this.setState({ lightProbeBusyId: volume.id });
		try {
			await setLightProbeVolume(this.props.object, { id: volume.id, expectedRevision: volume.revision, ...changes }, { editor: this.props.editor });
			toast.success(`Light Probe Volume ${changes.enabled === false ? "disabled" : "updated"}.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update the Light Probe Volume.");
		} finally {
			this.setState({ lightProbeBusyId: null });
		}
	}

	private async _bakeLightProbeVolume(volume: any): Promise<void> {
		this.setState({ lightProbeBusyId: volume.id });
		try {
			const result = (await bakeLightProbeVolume(
				this.props.object,
				{ id: volume.id, expectedRevision: volume.revision, samples: this.state.lightProbeSamples },
				{ editor: this.props.editor }
			)) as any;
			const evidence = result.volume.bake.evidence;
			toast.success(`Baked ${evidence.probeCount} probes through ${Number(evidence.totalRays).toLocaleString()} rays.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not bake the Light Probe Volume.");
		} finally {
			this.setState({ lightProbeBusyId: null });
		}
	}

	private async _deleteLightProbeVolume(volume: any): Promise<void> {
		const confirmed = await showConfirm("Delete Light Probe Volume?", `Permanently remove “${volume.name}” and all of its baked SH9 coefficients?`, {
			confirmText: "Delete Volume",
		});
		if (!confirmed) {
			return;
		}
		this.setState({ lightProbeBusyId: volume.id });
		try {
			await deleteLightProbeVolume(this.props.object, { id: volume.id, expectedRevision: volume.revision, confirm: true }, { editor: this.props.editor });
			toast.success("Light Probe Volume deleted and runtime rebuilt.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not delete the Light Probe Volume.");
		} finally {
			this.setState({ lightProbeBusyId: null });
		}
	}

	private _getTestingRunnerComponent(): ReactNode {
		const testing = getTestingState(this.props.object);
		const status = getTestingRunStatus(this.props.object);
		const latest = testing.runs[0];
		const code = this.state.projectCodeTests;
		const caseCount = testing.suites.reduce((total, suite) => total + suite.tests.length, 0);
		return (
			<EditorInspectorSectionField
				title="Test Runner"
				tooltip="Versioned Edit/Play/connected-player suites with bounded setup, frame steps, scene assertions, sampled performance, visual artifacts, cancellation, project code tests, and JSON/JUnit reports."
			>
				<div className="flex flex-col gap-2 text-xs">
					<div className="rounded bg-input p-2 text-muted-foreground">
						Version 2 · revision {testing.revision} · {testing.suites.length} suites · {caseCount} cases · {testing.runs.length}/{testing.settings.maximumRetainedRuns}{" "}
						retained runs
					</div>
					<div className="grid grid-cols-[minmax(0,1fr)_6rem_auto] gap-2">
						<Input
							value={this.state.testingSuiteName}
							aria-label="New test suite name"
							onChange={(event) => this.setState({ testingSuiteName: event.currentTarget.value })}
						/>
						<select
							className="h-9 rounded border border-input bg-background px-2"
							value={this.state.testingSuiteMode}
							onChange={(event) => this.setState({ testingSuiteMode: event.currentTarget.value as "edit" | "play" })}
						>
							<option value="edit">Edit</option>
							<option value="play">Play</option>
						</select>
						<Button size="sm" disabled={!this.state.testingSuiteName.trim() || this.state.testingBusy} onClick={() => this._createTestingSuite()}>
							Create Suite
						</Button>
					</div>
					<Input
						value={this.state.testingFilter}
						aria-label="Test filter"
						placeholder="Filter suite, test, or category"
						onChange={(event) => this.setState({ testingFilter: event.currentTarget.value })}
					/>
					<div className="flex flex-wrap gap-1">
						<Button size="sm" disabled={this.state.testingBusy || !caseCount} onClick={() => void this._runTesting()}>
							Run All
						</Button>
						<Button size="sm" variant="secondary" disabled={this.state.testingBusy || !caseCount} onClick={() => void this._runTesting(["edit"])}>
							Run Edit
						</Button>
						<Button size="sm" variant="secondary" disabled={this.state.testingBusy || !caseCount} onClick={() => void this._runTesting(["play"])}>
							Run Play
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={this.state.testingBusy || !latest || latest.status === "passed"}
							onClick={() => void this._runTesting(undefined, true)}
						>
							Rerun Failed
						</Button>
						<Button size="sm" variant="destructive" disabled={!status.active} onClick={() => void this._cancelTestingRun()}>
							Cancel
						</Button>
					</div>
					{status.active && (
						<div className="rounded border border-blue-500/40 bg-blue-500/10 p-2 text-blue-300">
							Running {status.active.target} · {status.active.progress.completed}/{status.active.progress.total} ·{" "}
							{status.active.progress.currentTestId ?? status.active.progress.status}
						</div>
					)}
					{testing.suites.map((suite) => {
						const latestResults = latest?.results.filter((result) => result.suiteId === suite.id) ?? [];
						const failures = latestResults.filter((result) => result.status !== "passed").length;
						return (
							<div key={suite.id} className="rounded-lg bg-input p-2">
								<div className="flex items-center justify-between gap-2">
									<span className="truncate font-medium">{suite.name}</span>
									<span className={failures ? "text-red-400" : latestResults.length ? "text-green-400" : "text-muted-foreground"}>
										{suite.mode.toUpperCase()} · {suite.tests.length} cases{latestResults.length ? ` · ${failures ? `${failures} failed` : "passed"}` : ""}
									</span>
								</div>
								<div className="mt-1 text-muted-foreground">
									{suite.tests.map((test) => `${test.name} [${test.kind}]`).join(" · ") ||
										"No cases yet — use Scene Tests, Performance Budgets, Visual Regression, or MCP authoring below."}
								</div>
							</div>
						);
					})}
					{!testing.suites.length && <div className="text-muted-foreground">No suites yet. Create an Edit or Play suite to begin.</div>}
					{latest && (
						<div className={`rounded p-2 ${latest.status === "passed" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
							<div>
								Latest {latest.target}: {latest.status} · {latest.summary.passed}/{latest.summary.total} passed · {latest.durationMs} ms
							</div>
							<div className="mt-1 flex gap-1">
								<Button size="sm" variant="secondary" onClick={() => void this._exportTestingReport(latest.id, "json")}>
									JSON
								</Button>
								<Button size="sm" variant="secondary" onClick={() => void this._exportTestingReport(latest.id, "junit")}>
									JUnit
								</Button>
								<Button size="sm" variant="ghost" onClick={() => void this._clearTestingRuns()}>
									Clear History
								</Button>
							</div>
						</div>
					)}
					<div className="rounded-lg border border-border p-2">
						<div className="flex items-center justify-between gap-2">
							<span className="font-medium">Project Code Tests</span>
							<Button size="sm" variant="ghost" onClick={() => void this._refreshProjectCodeTests()}>
								Refresh
							</Button>
						</div>
						{code ? (
							<>
								<div className="mt-1 text-muted-foreground">
									{code.framework} · {code.discoveredFiles.length} files · script {code.configuration.packageScript}{" "}
									{code.configuredScriptAvailable ? "ready" : "missing"}
								</div>
								<div className="mt-2 flex gap-1">
									<Button
										size="sm"
										disabled={this.state.testingCodeBusy || !code.configuredScriptAvailable}
										onClick={() => void this._runProjectCodeTests(false)}
									>
										Run Code Tests
									</Button>
									<Button
										size="sm"
										variant="secondary"
										disabled={this.state.testingCodeBusy || !code.coverageScriptAvailable}
										onClick={() => void this._runProjectCodeTests(true)}
									>
										Coverage
									</Button>
									<Button size="sm" variant="destructive" disabled={!code.active} onClick={() => this._cancelProjectCodeTests()}>
										Cancel
									</Button>
								</div>
								{code.runs[0] && (
									<div className={code.runs[0].status === "passed" ? "mt-1 text-green-400" : "mt-1 text-red-400"}>
										Latest: {code.runs[0].status} · exit {String(code.runs[0].exitCode)}
									</div>
								)}
							</>
						) : (
							<div className="mt-1 text-muted-foreground">Discovering project test files and package scripts…</div>
						)}
					</div>
					<div className="text-muted-foreground">
						Connected-player runs use Device Lab through MCP. Headless CI uses <code>babylonjs-editor-cli test</code>. NUnit/Unity assembly, coroutine, protocol, and
						binary identity are not claimed.
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createTestingSuite(): void {
		try {
			const testing = getTestingState(this.props.object);
			createTestSuite(
				this.props.object,
				{ expectedRevision: testing.revision, name: this.state.testingSuiteName.trim(), mode: this.state.testingSuiteMode, categories: [], tests: [] },
				{ editor: this.props.editor }
			);
			this.setState({ testingSuiteName: `${this.state.testingSuiteName.trim()} 2` });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create test suite.");
		}
	}

	private async _runTesting(modes?: ("edit" | "play")[], failedOnly = false): Promise<void> {
		this.setState({ testingBusy: true });
		try {
			const testing = getTestingState(this.props.object);
			const report = await runTesting(
				this.props.object,
				{
					expectedRevision: testing.revision,
					...(modes ? { modes } : {}),
					...(this.state.testingFilter.trim() ? { search: this.state.testingFilter.trim() } : {}),
					...(failedOnly ? { failedOnly: true } : {}),
				},
				{ editor: this.props.editor }
			);
			toast[report.status === "passed" ? "success" : "error"](`Test run ${report.status}: ${report.summary.passed}/${report.summary.total} passed.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Test run failed.");
		} finally {
			this.setState({ testingBusy: false });
			this.forceUpdate();
		}
	}

	private async _cancelTestingRun(): Promise<void> {
		const confirmed = await showConfirm("Cancel Test Run?", "Stop the active test run and clean up its transient Play scene and authored mutations?", {
			confirmText: "Cancel Run",
		});
		if (!confirmed) {
			return;
		}
		await cancelTestingRun(this.props.object, { confirm: true });
	}

	private async _exportTestingReport(runId: string, format: "json" | "junit"): Promise<void> {
		try {
			const result = await exportTestingRunReport(this.props.object, { runId, format });
			toast.success(`Exported ${format.toUpperCase()} report to ${result.path}.`);
			await this.props.editor.layout.assets.refresh();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not export test report.");
		}
	}

	private async _clearTestingRuns(): Promise<void> {
		const confirmed = await showConfirm("Clear Test History?", "Remove every retained Test Runner report from this scene?", { confirmText: "Clear History" });
		if (!confirmed) {
			return;
		}
		const testing = getTestingState(this.props.object);
		clearTestingRuns(this.props.object, { expectedRevision: testing.revision, confirm: true }, { editor: this.props.editor });
	}

	private async _refreshProjectCodeTests(): Promise<void> {
		try {
			this.setState({ projectCodeTests: await getProjectCodeTests(this.props.object) });
		} catch {
			this.setState({ projectCodeTests: null });
		}
	}

	private async _runProjectCodeTests(coverage: boolean): Promise<void> {
		const code = this.state.projectCodeTests;
		if (!code) {
			return;
		}
		const confirmed = await showConfirm(
			"Run Project Code?",
			`Execute the project-owned package script “${coverage ? code.configuration.coverageScript : code.configuration.packageScript}”?`,
			{
				confirmText: "Run Tests",
			}
		);
		if (!confirmed) {
			return;
		}
		this.setState({ testingCodeBusy: true });
		try {
			const result = await runProjectCodeTests(this.props.object, { expectedRevision: code.revision, coverage, confirm: true }, { editor: this.props.editor });
			toast[result.status === "passed" ? "success" : "error"](`Project code tests ${result.status}.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Project code tests failed.");
		} finally {
			this.setState({ testingCodeBusy: false });
			await this._refreshProjectCodeTests();
		}
	}

	private _cancelProjectCodeTests(): void {
		try {
			cancelProjectCodeTests(this.props.object, { confirm: true });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not cancel project code tests.");
		}
	}

	private _getPerformanceBudgetsComponent(): ReactNode {
		const budgets = listPerformanceBudgets(this.props.object).budgets as any[];
		const metrics = listPerformanceBudgets(this.props.object).supportedMetrics as string[];
		return (
			<EditorInspectorSectionField
				title="Performance Budgets"
				tooltip="Persisted maximum diagnostics thresholds for scene validation. Backend-unavailable metrics are reported as unavailable, never guessed."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5rem_auto] gap-2">
						<Input
							value={this.state.performanceBudgetName}
							aria-label="Performance budget name"
							onChange={(event) => this.setState({ performanceBudgetName: event.currentTarget.value })}
						/>
						<select
							className="h-9 rounded border border-input bg-background px-2 text-xs"
							value={this.state.performanceBudgetMetric}
							onChange={(event) => this.setState({ performanceBudgetMetric: event.currentTarget.value })}
						>
							{metrics.map((metric) => (
								<option key={metric} value={metric}>
									{metric}
								</option>
							))}
						</select>
						<Input
							type="number"
							min={0}
							value={this.state.performanceBudgetLimit}
							aria-label="Performance budget limit"
							onChange={(event) => this.setState({ performanceBudgetLimit: Number(event.currentTarget.value) })}
						/>
						<Button
							size="sm"
							disabled={!this.state.performanceBudgetName.trim() || !Number.isFinite(this.state.performanceBudgetLimit) || this.state.performanceBudgetLimit < 0}
							onClick={() => this._createPerformanceBudget()}
						>
							Add
						</Button>
					</div>
					{budgets.map((budget) => (
						<div key={budget.id} className="rounded-lg bg-input p-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate font-medium">{budget.name}</span>
								<div className="flex gap-1">
									<Button size="sm" variant="secondary" onClick={() => this._runPerformanceBudget(budget.id)}>
										Run
									</Button>
									<Button size="sm" variant="ghost" className="!text-red-400" onClick={() => this._deletePerformanceBudget(budget.id)}>
										Remove
									</Button>
								</div>
							</div>
							<div className="mt-1 text-muted-foreground">
								{Object.entries(budget.limits)
									.map(([metric, limit]) => `${metric} ≤ ${limit}`)
									.join(" · ")}
							</div>
							{budget.lastRun && (
								<div className={budget.lastRun.passed ? "mt-1 text-green-400" : "mt-1 text-red-400"}>
									{budget.lastRun.passed ? "Passed" : "Failed"} · {budget.lastRun.at}
								</div>
							)}
						</div>
					))}
					{!budgets.length && <div className="text-xs text-muted-foreground">No budgets yet. Add a limit to make renderer diagnostics testable.</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createPerformanceBudget(): void {
		try {
			createPerformanceBudget(
				this.props.object,
				{ name: this.state.performanceBudgetName.trim(), limits: { [this.state.performanceBudgetMetric]: this.state.performanceBudgetLimit } },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create performance budget.");
		}
	}

	private async _runPerformanceBudget(id: string): Promise<void> {
		try {
			await runPerformanceBudgets(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not run performance budget.");
		}
	}

	private _deletePerformanceBudget(id: string): void {
		try {
			deletePerformanceBudget(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not delete performance budget.");
		}
	}

	private _getSceneTestsComponent(): ReactNode {
		const tests = listSceneTests(this.props.object).tests as any[];
		const nodes = this.props.object.getNodes().filter((node: any) => Boolean(node.id));
		const selectedNodeId = this.state.sceneTestNodeId || nodes[0]?.id || "";
		return (
			<EditorInspectorSectionField
				title="Scene Tests"
				tooltip="Persisted play-mode-style node assertions. Tests run through the same MCP tools available to external agents."
			>
				<div className="flex flex-col gap-2">
					<div className="flex gap-2">
						<Input
							value={this.state.sceneTestName}
							aria-label="New scene test name"
							onChange={(event) => this.setState({ sceneTestName: event.currentTarget.value })}
							placeholder="Scene Test"
						/>
						<Button size="sm" disabled={!this.state.sceneTestName.trim()} onClick={() => this._createSceneTest()}>
							Create
						</Button>
						<Button size="sm" variant="secondary" disabled={!tests.length} onClick={() => this._runSceneTests()}>
							Run All
						</Button>
					</div>
					{tests.map((sceneTest) => (
						<div key={sceneTest.id} className="flex flex-col gap-2 rounded-lg bg-input p-2">
							<div className="flex items-center justify-between gap-2">
								<div className="truncate font-medium">{sceneTest.name}</div>
								<div className="flex gap-1">
									<Button size="sm" variant="secondary" className="h-7 px-2" onClick={() => this._runSceneTests(sceneTest.id)}>
										Run
									</Button>
									<Button size="sm" variant="ghost" className="h-7 px-2 !text-red-400" onClick={() => this._deleteSceneTest(sceneTest.id)}>
										Remove
									</Button>
								</div>
							</div>
							{sceneTest.lastRun && (
								<div className={`text-xs ${sceneTest.lastRun.passed ? "text-green-400" : "text-red-400"}`}>
									{sceneTest.lastRun.passed ? "Passed" : "Failed"} — {sceneTest.lastRun.at}
								</div>
							)}
							<div className="flex flex-col gap-1 text-xs">
								{sceneTest.assertions.map((assertion: any, index: number) => (
									<div key={index} className="flex items-center justify-between gap-2 rounded bg-background/50 px-2 py-1">
										<span className="truncate">{formatSceneTestAssertion(assertion)}</span>
										<div className="flex items-center gap-2">
											{sceneTest.lastRun?.assertions?.[index] && (
												<span className={sceneTest.lastRun.assertions[index].passed ? "text-green-400" : "text-red-400"}>
													{sceneTest.lastRun.assertions[index].passed ? "Pass" : "Fail"}
												</span>
											)}
											<Button size="sm" variant="ghost" className="h-6 px-1 !text-red-400" onClick={() => this._removeSceneTestAssertion(sceneTest, index)}>
												×
											</Button>
										</div>
									</div>
								))}
								{!sceneTest.assertions.length && <div className="text-muted-foreground">No assertions yet.</div>}
							</div>
							<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
								<select
									value={selectedNodeId}
									onChange={(event) => this.setState({ sceneTestNodeId: event.currentTarget.value })}
									className="h-8 rounded bg-background px-2 text-xs"
								>
									{nodes.map((node: any) => (
										<option key={node.id} value={node.id}>
											{node.name}
										</option>
									))}
								</select>
								<Button
									size="sm"
									variant="secondary"
									disabled={!selectedNodeId}
									onClick={() => this._addSceneTestAssertion(sceneTest, "node-enabled", selectedNodeId)}
								>
									Assert Enabled
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={!selectedNodeId}
									onClick={() => this._addSceneTestAssertion(sceneTest, "node-position", selectedNodeId)}
								>
									Assert Position
								</Button>
							</div>
						</div>
					))}
					{!tests.length && (
						<div className="text-sm text-muted-foreground">No persisted scene tests. Create a test, then capture enabled or position assertions from a node.</div>
					)}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getVisualRegressionComponent(): ReactNode {
		return (
			<EditorInspectorSectionField
				title="Visual Regression"
				tooltip="Compare two project image assets in RGBA space. A result passes only when all pixels are within the selected per-channel tolerance."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
						<Input
							value={this.state.visualBaselinePath}
							aria-label="Visual baseline path"
							onChange={(event) => this.setState({ visualBaselinePath: event.currentTarget.value })}
							placeholder="assets/baseline.png"
						/>
						<Button size="sm" disabled={!this.state.visualBaselinePath.trim()} onClick={() => void this._captureVisualBaseline()}>
							Capture
						</Button>
					</div>
					<div className="grid grid-cols-[minmax(0,1fr)_5rem_auto] gap-2">
						<Input
							value={this.state.visualCandidatePath}
							aria-label="Visual candidate path"
							onChange={(event) => this.setState({ visualCandidatePath: event.currentTarget.value })}
							placeholder="assets/candidate.png"
						/>
						<Input
							type="number"
							min={0}
							max={255}
							value={this.state.visualTolerance}
							aria-label="Visual tolerance"
							onChange={(event) => this.setState({ visualTolerance: Number(event.currentTarget.value) })}
						/>
						<Button
							size="sm"
							disabled={!this.state.visualBaselinePath.trim() || !this.state.visualCandidatePath.trim()}
							onClick={() => void this._compareVisualRegression()}
						>
							Compare
						</Button>
					</div>
					{this.state.visualResult && (
						<div className={`text-xs ${this.state.visualResult.passed ? "text-green-400" : "text-red-400"}`}>
							{this.state.visualResult.passed ? "Passed" : "Failed"} · {this.state.visualResult.differingPixels ?? this.state.visualResult.reason}
						</div>
					)}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _compareVisualRegression(): Promise<void> {
		try {
			this.setState({
				visualResult: await compareVisualRegressionImages(
					this.props.object,
					{ baselinePath: this.state.visualBaselinePath.trim(), candidatePath: this.state.visualCandidatePath.trim(), tolerance: this.state.visualTolerance },
					{ editor: this.props.editor }
				),
			});
		} catch (error) {
			this.setState({ visualResult: { passed: false, reason: error instanceof Error ? error.message : "Comparison failed." } });
		}
	}

	private async _captureVisualBaseline(): Promise<void> {
		try {
			await captureVisualRegressionBaseline(this.props.object, { path: this.state.visualBaselinePath.trim() });
			this.setState({ visualResult: { passed: true, differingPixels: "Baseline captured" } });
			await this.props.editor.layout.assets.refresh();
		} catch (error) {
			this.setState({ visualResult: { passed: false, reason: error instanceof Error ? error.message : "Baseline capture failed." } });
		}
	}

	private _createSceneTest(): void {
		const name = this.state.sceneTestName.trim();
		try {
			createSceneTest(this.props.object, { name, assertions: [] }, { editor: this.props.editor });
			this.setState({ sceneTestName: `${name} 2` });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create scene test.");
		}
	}

	private async _runSceneTests(id?: string): Promise<void> {
		try {
			await runSceneTests(this.props.object, id ? { id } : {}, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not run scene tests.");
		}
	}

	private _addSceneTestAssertion(sceneTest: any, type: "node-enabled" | "node-position", nodeId: string): void {
		const node = this.props.object.getNodeById(nodeId) as any;
		if (!node) {
			return;
		}
		const assertion =
			type === "node-enabled" ? { type, nodeId, equals: node.isEnabled?.() === true } : { type, nodeId, equals: node.position?.asArray() ?? [0, 0, 0], epsilon: 0.001 };
		this._setSceneTest(sceneTest, { assertions: [...sceneTest.assertions, assertion] });
	}

	private _removeSceneTestAssertion(sceneTest: any, index: number): void {
		this._setSceneTest(sceneTest, { assertions: sceneTest.assertions.filter((_assertion: any, assertionIndex: number) => assertionIndex !== index) });
	}

	private _setSceneTest(sceneTest: any, update: any): void {
		try {
			setSceneTest(this.props.object, { id: sceneTest.id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update scene test.");
		}
	}

	private _deleteSceneTest(id: string): void {
		try {
			deleteSceneTest(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not delete scene test.");
		}
	}

	private _getGUIAccessibilityComponent(): ReactNode {
		const validation = this.state.guiAccessibilityValidation;
		const authoring = this.state.guiAccessibilityAuthoring;
		const selectedControl = authoring?.controls?.items?.find((control: any) => control.id === this.state.guiAccessibilityControlId) ?? authoring?.controls?.items?.[0];
		return (
			<EditorInspectorSectionField
				title="GUI Accessibility"
				tooltip="Author semantic roles, ordered focus, actions, text/caption preferences, and audit target size plus alpha/image-backed contrast for fullscreen GUIs."
			>
				<div className="mb-2 flex flex-col gap-2">
					<div className="flex gap-2">
						<select
							className="h-8 min-w-0 flex-1 rounded bg-input px-2 text-sm"
							value={this.state.guiAccessibilityGuiId}
							onChange={(event) => void this._refreshGUIAccessibilityAuthoring(event.currentTarget.value)}
						>
							<option value="">Select fullscreen GUI</option>
							{this.state.guiAccessibilityGuis.map((gui) => (
								<option key={gui.id} value={gui.id}>
									{gui.name}
								</option>
							))}
						</select>
						<Button size="sm" variant="secondary" onClick={() => void this._refreshGUIAccessibilityAuthoring(this.state.guiAccessibilityGuiId)}>
							Refresh
						</Button>
					</div>
					{authoring && (
						<>
							<label className="flex items-center gap-1 text-xs">
								<input
									type="checkbox"
									checked={authoring.authoring.accessibility.settings.enabled}
									onChange={(event) => void this._setGUIAccessibilityEnabled(event.currentTarget.checked)}
								/>
								Enable screen-reader hierarchy (text scale {authoring.authoring.accessibility.settings.textScale}× · captions{" "}
								{authoring.authoring.accessibility.settings.captionsEnabled ? "on" : "off"})
							</label>
							<div className="grid grid-cols-[5rem_repeat(3,minmax(0,1fr))] items-center gap-2 text-xs">
								<Input
									type="number"
									min={0.5}
									max={3}
									step={0.1}
									value={authoring.authoring.accessibility.settings.textScale}
									aria-label="Accessible text scale"
									onChange={(event) => void this._setGUIAccessibilityPreferences({ textScale: Number(event.currentTarget.value) })}
								/>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={authoring.authoring.accessibility.settings.boldText}
										onChange={(event) => void this._setGUIAccessibilityPreferences({ boldText: event.currentTarget.checked })}
									/>{" "}
									Bold text
								</label>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={authoring.authoring.accessibility.settings.captionsEnabled}
										onChange={(event) => void this._setGUIAccessibilityPreferences({ captionsEnabled: event.currentTarget.checked })}
									/>{" "}
									Captions
								</label>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={authoring.authoring.accessibility.settings.usePlatformPreferences}
										onChange={(event) => void this._setGUIAccessibilityPreferences({ usePlatformPreferences: event.currentTarget.checked })}
									/>{" "}
									Platform
								</label>
							</div>
							<select
								className="h-8 rounded bg-input px-2 text-sm"
								value={selectedControl?.id ?? ""}
								onChange={(event) => this._selectGUIAccessibilityControl(event.currentTarget.value)}
							>
								{authoring.controls.items.map((control: any) => (
									<option key={control.id} value={control.id}>
										{control.path} · {control.type}
									</option>
								))}
							</select>
							<div className="rounded bg-background/40 p-2">
								<div className="mb-1 text-xs font-semibold">Localized control property</div>
								<div className="grid grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)] gap-2">
									<select
										className="h-8 rounded bg-input px-2 text-sm"
										value={this.state.guiLocalizationProperty}
										onChange={(event) => this.setState({ guiLocalizationProperty: event.currentTarget.value as any, guiLocalizationTable: "" })}
									>
										<option value="text">Text</option>
										<option value="source">Image</option>
									</select>
									<select
										className="h-8 rounded bg-input px-2 text-sm"
										value={this.state.guiLocalizationTable}
										onChange={(event) => this.setState({ guiLocalizationTable: event.currentTarget.value })}
									>
										<option value="">Select table</option>
										{(this.state.guiLocalizationProperty === "text" ? this.state.localizationTables : this.state.localizationAssetTables).map((table) => (
											<option key={table.name} value={table.name}>
												{table.name}
											</option>
										))}
									</select>
									<Input
										value={this.state.guiLocalizationKey}
										aria-label="GUI localization key"
										onChange={(event) => this.setState({ guiLocalizationKey: event.currentTarget.value })}
										placeholder="Localization key"
									/>
								</div>
								<div className="mt-2 flex gap-2">
									<Button
										size="sm"
										disabled={!selectedControl || !this.state.guiLocalizationTable || !this.state.guiLocalizationKey.trim()}
										onClick={() => void this._saveGUILocalizationBinding()}
									>
										Bind Localization
									</Button>
									<Button
										size="sm"
										variant="ghost"
										className="!text-red-400"
										disabled={!selectedControl}
										onClick={() => void this._deleteGUILocalizationBinding()}
									>
										Remove Binding
									</Button>
								</div>
							</div>
							<div className="grid grid-cols-[7rem_minmax(0,1fr)_5rem] gap-2">
								<select
									className="h-8 rounded bg-input px-2 text-sm"
									value={this.state.guiAccessibilityRole}
									onChange={(event) => this.setState({ guiAccessibilityRole: event.currentTarget.value })}
								>
									{[
										"button",
										"header",
										"image",
										"link",
										"list",
										"listItem",
										"searchField",
										"slider",
										"staticText",
										"tab",
										"tabBar",
										"textField",
										"toggle",
										"none",
									].map((role) => (
										<option key={role} value={role}>
											{role}
										</option>
									))}
								</select>
								<Input
									value={this.state.guiAccessibilityLabel}
									aria-label="Accessible label"
									onChange={(event) => this.setState({ guiAccessibilityLabel: event.currentTarget.value })}
									placeholder="Accessible label"
								/>
								<Input
									type="number"
									value={this.state.guiAccessibilityFocusOrder}
									aria-label="Accessibility focus order"
									onChange={(event) => this.setState({ guiAccessibilityFocusOrder: Number(event.currentTarget.value) })}
								/>
							</div>
							<div className="flex gap-2">
								<Button size="sm" disabled={!selectedControl || !this.state.guiAccessibilityLabel.trim()} onClick={() => void this._saveGUIAccessibilityNode()}>
									Save Semantic Node
								</Button>
								<Button size="sm" variant="ghost" className="!text-red-400" disabled={!selectedControl} onClick={() => void this._deleteGUIAccessibilityNode()}>
									Remove Node
								</Button>
							</div>
						</>
					)}
				</div>
				<Button size="sm" variant="secondary" className="w-full" onClick={() => void this._validateGUIAccessibility()}>
					Audit Fullscreen GUIs
				</Button>
				{validation && (
					<div className="space-y-1 text-xs">
						<div className={validation.errorCount || validation.warningCount ? "text-amber-400" : "text-green-400"}>
							{validation.guiCount} GUIs · {validation.controlCount} controls · {validation.errorCount} errors · {validation.warningCount} warnings
						</div>
						{validation.issues.slice(0, 8).map((issue: any, index: number) => (
							<div key={`${issue.path}-${issue.code}-${index}`} className="rounded bg-input px-2 py-1 text-muted-foreground">
								{issue.path}: {issue.message}
							</div>
						))}
						{validation.issues.length > 8 && <div className="text-muted-foreground">+{validation.issues.length - 8} additional issues</div>}
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getLocalizationComponent(): ReactNode {
		const selected = this.state.localizationTables.find((table) => table.name === this.state.localizationSelectedTable) ?? this.state.localizationTables[0] ?? null;
		const selectedAssetTable =
			this.state.localizationAssetTables.find((table) => table.name === this.state.localizationSelectedAssetTable) ?? this.state.localizationAssetTables[0] ?? null;
		return (
			<EditorInspectorSectionField
				title="Localization"
				tooltip="Project localization tables persist to localization.json and export with the game. The same tables are available through MCP."
			>
				<div className="flex flex-col gap-2">
					<div className="rounded border border-border/60 p-2">
						<div className="mb-2 text-xs font-semibold">Locales and fallback policy</div>
						<div className="grid grid-cols-[5rem_minmax(0,1fr)_5rem] gap-2">
							<Input
								value={this.state.localizationLocale}
								aria-label="Locale id"
								onChange={(event) => this.setState({ localizationLocale: event.currentTarget.value })}
								placeholder="en"
							/>
							<Input
								value={this.state.localizationLocaleName}
								aria-label="Locale display name"
								onChange={(event) => this.setState({ localizationLocaleName: event.currentTarget.value })}
								placeholder="English"
							/>
							<select
								className="h-8 rounded bg-input px-2 text-sm"
								value={this.state.localizationDirection}
								onChange={(event) => this.setState({ localizationDirection: event.currentTarget.value as any })}
							>
								<option value="auto">Auto</option>
								<option value="ltr">LTR</option>
								<option value="rtl">RTL</option>
							</select>
						</div>
						<Input
							className="mt-2"
							value={this.state.localizationLocaleFallbacks}
							aria-label="Ordered locale fallbacks"
							onChange={(event) => this.setState({ localizationLocaleFallbacks: event.currentTarget.value })}
							placeholder="Fallbacks: en, fr"
						/>
						<div className="mt-2 flex items-center gap-2 text-xs">
							<label className="flex items-center gap-1">
								<input
									type="checkbox"
									checked={this.state.localizationPseudoEnabled}
									onChange={(event) => this.setState({ localizationPseudoEnabled: event.currentTarget.checked })}
								/>{" "}
								Pseudo locale
							</label>
							<Button
								size="sm"
								disabled={!this.state.localizationLocale.trim() || !this.state.localizationLocaleName.trim()}
								onClick={() => void this._upsertLocalizationLocale()}
							>
								Save Locale
							</Button>
							<select
								className="h-8 min-w-0 flex-1 rounded bg-input px-2 text-sm"
								value={this.state.localizationData?.defaultLocale ?? ""}
								onChange={(event) => void this._setLocalizationDefaultLocale(event.currentTarget.value)}
							>
								{this.state.localizationLocales.map((locale) => (
									<option key={locale.id} value={locale.id}>
										Default: {locale.name} ({locale.id})
									</option>
								))}
							</select>
						</div>
						<div className="mt-2 flex flex-wrap gap-1 text-xs">
							{this.state.localizationLocales.map((locale) => (
								<button
									key={locale.id}
									className="rounded bg-background/60 px-2 py-1"
									onClick={() =>
										this.setState({
											localizationLocale: locale.id,
											localizationLocaleName: locale.name,
											localizationDirection: locale.direction,
											localizationLocaleFallbacks: locale.fallbackLocales.join(", "),
											localizationPseudoEnabled: Boolean(locale.pseudo?.enabled),
										})
									}
								>
									{locale.id} · {locale.direction}
									{locale.id !== this.state.localizationData?.defaultLocale && (
										<span
											className="ml-1 text-red-400"
											onClick={(event) => {
												event.stopPropagation();
												void this._deleteLocalizationLocale(locale.id);
											}}
										>
											×
										</span>
									)}
								</button>
							))}
						</div>
					</div>
					<div className="grid grid-cols-[minmax(0,1fr)_5rem_auto] gap-2">
						<Input
							value={this.state.localizationTableName}
							aria-label="Localization table name"
							onChange={(event) => this.setState({ localizationTableName: event.currentTarget.value })}
							placeholder="Table name"
						/>
						<Input
							value={this.state.localizationFallbackLocale}
							aria-label="Fallback locale"
							onChange={(event) => this.setState({ localizationFallbackLocale: event.currentTarget.value })}
							placeholder="en"
						/>
						<Button
							size="sm"
							disabled={!this.state.localizationTableName.trim() || !this.state.localizationFallbackLocale.trim()}
							onClick={() => void this._createLocalizationTable()}
						>
							Create
						</Button>
					</div>
					{this.state.localizationTables.length > 0 && (
						<div className="flex gap-2">
							<select
								className="h-8 min-w-0 flex-1 rounded bg-input px-2 text-sm"
								value={selected?.name ?? ""}
								onChange={(event) => this.setState({ localizationSelectedTable: event.currentTarget.value, pseudoLocalizationValue: null })}
							>
								{this.state.localizationTables.map((table) => (
									<option key={table.name} value={table.name}>
										{table.name} (fallback {table.fallbackLocale})
									</option>
								))}
							</select>
							<Button size="sm" variant="ghost" className="h-8 px-2 !text-red-400" onClick={() => void this._deleteLocalizationTable(selected!.name)}>
								Delete Table
							</Button>
							<label className="flex items-center gap-1 text-xs">
								<input
									type="checkbox"
									checked={selected?.preload === true}
									onChange={(event) => void this._toggleLocalizationTablePreload(selected!.name, event.currentTarget.checked)}
								/>{" "}
								Preload
							</label>
						</div>
					)}
					{selected && (
						<>
							<div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
								<Input
									value={this.state.localizationKey}
									aria-label="Localization key"
									onChange={(event) => this.setState({ localizationKey: event.currentTarget.value, pseudoLocalizationValue: null })}
									placeholder="Key"
								/>
								<Input
									value={this.state.localizationLocale}
									aria-label="Localization locale"
									onChange={(event) => this.setState({ localizationLocale: event.currentTarget.value, pseudoLocalizationValue: null })}
									placeholder={selected.fallbackLocale}
								/>
							</div>
							<textarea
								value={this.state.localizationValue}
								aria-label="Localized value"
								onChange={(event) => this.setState({ localizationValue: event.currentTarget.value, pseudoLocalizationValue: null })}
								placeholder="Localized text"
								className="min-h-16 rounded bg-input p-2 text-sm"
							/>
							<label className="flex items-center gap-1 text-xs">
								<input
									type="checkbox"
									checked={this.state.localizationSmart}
									onChange={(event) => this.setState({ localizationSmart: event.currentTarget.checked, pseudoLocalizationValue: null })}
								/>
								Smart String (plural, choose, number/currency, date/time, list)
							</label>
							<div className="flex gap-2">
								<Button
									size="sm"
									disabled={!this.state.localizationKey.trim() || !this.state.localizationLocale.trim()}
									onClick={() => void this._setLocalizationEntry(selected.name)}
								>
									Save Entry
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={!this.state.localizationKey.trim() || !this.state.localizationLocale.trim()}
									onClick={() => void this._pseudoLocalizeEntry(selected.name)}
								>
									Preview Pseudo Locale
								</Button>
								<Button size="sm" variant="secondary" onClick={() => void this._validateLocalization(selected.name)}>
									Validate Table
								</Button>
							</div>
							{this.state.pseudoLocalizationValue && <div className="rounded bg-secondary/40 p-2 text-sm">{this.state.pseudoLocalizationValue}</div>}
							{this.state.localizationValidation && (
								<div className="flex flex-col gap-1 rounded bg-secondary/40 p-2 text-xs">
									<div>
										{this.state.localizationValidation.errorCount} errors · {this.state.localizationValidation.warningCount} warnings
									</div>
									{this.state.localizationValidation.issues.map((issue: any, index: number) => (
										<div key={`${issue.code}-${issue.key}-${issue.locale}-${index}`} className={issue.severity === "error" ? "text-red-400" : "text-amber-400"}>
											{issue.key ?? "Table"} {issue.locale ? `(${issue.locale}) ` : ""}— {issue.message}
										</div>
									))}
									{!this.state.localizationValidation.issues.length && <div className="text-green-400">No localization issues found.</div>}
								</div>
							)}
							<div className="flex flex-col gap-1 text-xs">
								{Object.entries(selected.entries ?? {}).map(([key, values]: [string, any]) => (
									<button
										key={key}
										className="grid grid-cols-[minmax(6rem,1fr)_minmax(0,2fr)] gap-2 rounded bg-background/50 px-2 py-1 text-left hover:bg-muted"
										onClick={() =>
											this.setState({
												localizationKey: key,
												localizationLocale: this.state.localizationLocale || selected.fallbackLocale,
												localizationValue: values[this.state.localizationLocale] ?? values[selected.fallbackLocale] ?? "",
												localizationSmart: selected.smartEntries?.includes(key) ?? false,
												pseudoLocalizationValue: null,
											})
										}
									>
										<span className="flex min-w-0 items-center gap-1">
											<span className="truncate font-medium">{key}</span>
											<span
												className="cursor-pointer text-red-400"
												onClick={(event) => {
													event.stopPropagation();
													void this._deleteLocalizationEntry(selected.name, key, this.state.localizationLocale || selected.fallbackLocale);
												}}
											>
												×
											</span>
										</span>
										<span className="truncate text-muted-foreground">{values[this.state.localizationLocale] ?? values[selected.fallbackLocale] ?? ""}</span>
									</button>
								))}
								{!Object.keys(selected.entries ?? {}).length && <div className="text-muted-foreground">No entries in this table yet.</div>}
							</div>
						</>
					)}
					<div className="rounded border border-border/60 p-2">
						<div className="mb-2 text-xs font-semibold">Localized assets</div>
						<div className="flex gap-2">
							<Input
								value={this.state.localizationAssetTableName}
								aria-label="Localized asset table name"
								onChange={(event) => this.setState({ localizationAssetTableName: event.currentTarget.value })}
								placeholder="Asset table"
							/>
							<Button size="sm" disabled={!this.state.localizationAssetTableName.trim()} onClick={() => void this._createLocalizedAssetTable()}>
								Create
							</Button>
						</div>
						{selectedAssetTable && (
							<>
								<div className="mt-2 flex gap-2">
									<select
										className="h-8 min-w-0 flex-1 rounded bg-input px-2 text-sm"
										value={selectedAssetTable.name}
										onChange={(event) => this.setState({ localizationSelectedAssetTable: event.currentTarget.value })}
									>
										{this.state.localizationAssetTables.map((table) => (
											<option key={table.name} value={table.name}>
												{table.name} (fallback {table.fallbackLocale}){table.preload ? " · preload" : ""}
											</option>
										))}
									</select>
									<Button size="sm" variant="ghost" className="!text-red-400" onClick={() => void this._deleteLocalizedAssetTable(selectedAssetTable.name)}>
										Delete
									</Button>
								</div>
								<div className="mt-2 grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
									<Input
										value={this.state.localizationAssetKey}
										aria-label="Localized asset key"
										onChange={(event) => this.setState({ localizationAssetKey: event.currentTarget.value })}
										placeholder="Key"
									/>
									<select
										className="h-8 rounded bg-input px-2 text-sm"
										value={this.state.localizationAssetType}
										onChange={(event) => this.setState({ localizationAssetType: event.currentTarget.value as any })}
									>
										{["texture", "audio", "font", "video", "model", "binary"].map((type) => (
											<option key={type} value={type}>
												{type}
											</option>
										))}
									</select>
								</div>
								<div className="mt-2 flex gap-2">
									<Input
										value={this.state.localizationAssetPath}
										aria-label="Localized asset project path"
										onChange={(event) => this.setState({ localizationAssetPath: event.currentTarget.value })}
										placeholder="assets/localized/logo.png"
									/>
									<Button
										size="sm"
										disabled={!this.state.localizationAssetKey.trim() || !this.state.localizationAssetPath.trim() || !this.state.localizationLocale.trim()}
										onClick={() => void this._setLocalizedAssetEntry(selectedAssetTable.name)}
									>
										Save Asset
									</Button>
								</div>
								<div className="mt-2 flex flex-col gap-1 text-xs">
									{Object.entries(selectedAssetTable.entries ?? {}).map(([key, values]: [string, any]) => {
										const asset = values[this.state.localizationLocale] ?? values[selectedAssetTable.fallbackLocale];
										return (
											<button
												key={key}
												className="grid grid-cols-[minmax(6rem,1fr)_minmax(0,2fr)] gap-2 rounded bg-background/50 px-2 py-1 text-left"
												onClick={() =>
													this.setState({
														localizationAssetKey: key,
														localizationAssetPath: asset?.path ?? "",
														localizationAssetType: asset?.type ?? "binary",
													})
												}
											>
												<span className="font-medium">
													{key}
													<span
														className="ml-1 text-red-400"
														onClick={(event) => {
															event.stopPropagation();
															void this._deleteLocalizedAssetEntry(
																selectedAssetTable.name,
																key,
																this.state.localizationLocale || selectedAssetTable.fallbackLocale
															);
														}}
													>
														×
													</span>
												</span>
												<span className="truncate text-muted-foreground">{asset?.path ?? "Missing locale value"}</span>
											</button>
										);
									})}
								</div>
							</>
						)}
					</div>
					{this.state.localizationError && <div className="text-xs text-red-400">{this.state.localizationError}</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _refreshLocalizationTables(): Promise<void> {
		try {
			const data = await listLocalizationTables(this.props.object);
			this.setState((state) => ({
				localizationData: data,
				localizationTables: data.tables ?? [],
				localizationLocales: data.locales ?? [],
				localizationAssetTables: data.assetTables ?? [],
				localizationFallbackLocale: state.localizationData ? state.localizationFallbackLocale : data.defaultLocale,
				localizationSelectedTable: state.localizationSelectedTable || data.tables?.[0]?.name || "",
				localizationSelectedAssetTable: state.localizationSelectedAssetTable || data.assetTables?.[0]?.name || "",
				localizationError: null,
			}));
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not read localization tables." });
		}
	}

	private async _createLocalizationTable(): Promise<void> {
		try {
			const table = await createLocalizationTable(
				this.props.object,
				{ ...this._localizationLease(), name: this.state.localizationTableName.trim(), fallbackLocale: this.state.localizationFallbackLocale.trim() },
				{ editor: this.props.editor }
			);
			await this._refreshLocalizationTables();
			this.setState({ localizationSelectedTable: table.table.name });
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not create localization table." });
		}
	}

	private async _deleteLocalizationTable(name: string): Promise<void> {
		try {
			await deleteLocalizationTable(this.props.object, { ...this._localizationLease(), name, confirm: true }, { editor: this.props.editor });
			await this._refreshLocalizationTables();
			this.setState({ localizationSelectedTable: "", localizationKey: "", localizationValue: "", pseudoLocalizationValue: null });
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not delete localization table." });
		}
	}

	private async _setLocalizationEntry(name: string): Promise<void> {
		try {
			await setLocalizationEntry(
				this.props.object,
				{
					...this._localizationLease(),
					name,
					key: this.state.localizationKey.trim(),
					locale: this.state.localizationLocale.trim(),
					value: this.state.localizationValue,
					smart: this.state.localizationSmart,
				},
				{ editor: this.props.editor }
			);
			await this._refreshLocalizationTables();
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not save localization entry." });
		}
	}

	private async _deleteLocalizationEntry(name: string, key: string, locale: string): Promise<void> {
		try {
			await deleteLocalizationEntry(this.props.object, { ...this._localizationLease(), name, key, locale, confirm: true }, { editor: this.props.editor });
			await this._refreshLocalizationTables();
			this.setState({ pseudoLocalizationValue: null });
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not delete localization entry." });
		}
	}

	private async _pseudoLocalizeEntry(name: string): Promise<void> {
		try {
			const result = await pseudoLocalizeEntry(this.props.object, { name, key: this.state.localizationKey.trim(), locale: this.state.localizationLocale.trim() });
			this.setState({ pseudoLocalizationValue: result.value, localizationError: null });
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not pseudo-localize entry." });
		}
	}

	private async _validateLocalization(name: string): Promise<void> {
		try {
			const result = await validateLocalization(this.props.object, { name });
			this.setState({ localizationValidation: result, localizationError: null });
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not validate localization." });
		}
	}

	private _getScriptTemplatesComponent(): ReactNode {
		return (
			<EditorInspectorSectionField
				title="Script Templates"
				tooltip="Create a TypeScript behavior script under src/ from built-in or project-local templates exposed through MCP."
			>
				<div className="flex flex-col gap-2">
					<select
						value={this.state.scriptTemplateId}
						onChange={(event) => this.setState({ scriptTemplateId: event.currentTarget.value, scriptTemplateError: null })}
						className="h-8 rounded bg-input px-2 text-sm"
					>
						{this.state.scriptTemplates.map((template) => (
							<option key={template.id} value={template.id}>
								{template.id} — {template.description}
							</option>
						))}
					</select>
					<Input
						value={this.state.scriptPath}
						aria-label="Script path"
						onChange={(event) => this.setState({ scriptPath: event.currentTarget.value, scriptTemplateError: null })}
						placeholder="src/my-script.ts"
					/>
					<Input
						value={this.state.scriptClassName}
						aria-label="Script class name"
						onChange={(event) => this.setState({ scriptClassName: event.currentTarget.value, scriptTemplateError: null })}
						placeholder="Class name (optional)"
					/>
					<Button size="sm" disabled={!this.state.scriptPath.trim() || !this.state.scriptTemplateId} onClick={() => void this._createScriptFromTemplate()}>
						Create Script
					</Button>
					{this.state.scriptTemplateError && <div className="text-xs text-red-400">{this.state.scriptTemplateError}</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _createScriptFromTemplate(): Promise<void> {
		try {
			const selectedTemplate = this.state.scriptTemplates.find((template) => template.id === this.state.scriptTemplateId);
			await createScript(this.props.object, {
				path: this.state.scriptPath.trim(),
				...(selectedTemplate?.path ? { templatePath: selectedTemplate.path } : { template: this.state.scriptTemplateId }),
				...(this.state.scriptClassName.trim() ? { className: this.state.scriptClassName.trim() } : {}),
			});
			this.setState({ scriptTemplateError: null });
			await this.props.editor.layout.assets.refresh();
		} catch (error) {
			this.setState({ scriptTemplateError: error instanceof Error ? error.message : "Could not create script." });
		}
	}

	private async _refreshScriptTemplates(): Promise<void> {
		try {
			const customTemplates = await listCustomScriptTemplates();
			this.setState({ scriptTemplates: [...listScriptTemplates().templates, ...customTemplates.templates] });
		} catch {
			this.setState({ scriptTemplates: listScriptTemplates().templates });
		}
	}

	private _getProjectScriptExecutionOrdersComponent(): ReactNode {
		const orders = listProjectScriptExecutionOrders(this.props.object).orders as Record<string, number>;
		const projectOrders = listProjectWideScriptExecutionOrders(this.props.object, {}, { editor: this.props.editor }).orders as Record<string, number>;
		return (
			<EditorInspectorSectionField
				title="Script Execution Order"
				tooltip="Scene-wide script class order. Lower values initialize and update first across the loaded scene, overriding project-wide and per-attachment order."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-2">
						<Input
							value={this.state.projectScriptOrderPath}
							aria-label="Project script execution order path"
							onChange={(event) => this.setState({ projectScriptOrderPath: event.currentTarget.value })}
							placeholder="src/bootstrap.ts"
						/>
						<Input
							type="number"
							min={-32000}
							max={32000}
							step={1}
							value={this.state.projectScriptOrder}
							aria-label="Project script execution order"
							onChange={(event) => this.setState({ projectScriptOrder: Number(event.currentTarget.value) })}
						/>
						<Button size="sm" disabled={!this.state.projectScriptOrderPath.trim()} onClick={() => this._setProjectScriptExecutionOrder()}>
							Set Scene
						</Button>
						<Button size="sm" disabled={!this.state.projectScriptOrderPath.trim()} onClick={() => void this._setProjectWideScriptExecutionOrder()}>
							Set Project
						</Button>
					</div>
					{Object.entries(orders).map(([path, order]) => (
						<div key={path} className="flex items-center gap-2 rounded-lg bg-input p-2 text-xs">
							<span className="min-w-0 flex-1 truncate">{path}</span>
							<span>{order}</span>
							<Button size="sm" variant="ghost" className="h-6 px-2 !text-red-400" onClick={() => this._clearProjectScriptExecutionOrder(path)}>
								Clear
							</Button>
						</div>
					))}
					{!Object.keys(orders).length && <div className="text-xs text-muted-foreground">No global overrides. Attachments use their own execution order.</div>}
					{Object.keys(projectOrders).length > 0 && (
						<div className="text-xs text-muted-foreground">
							Project defaults:{" "}
							{Object.entries(projectOrders)
								.map(([path, order]) => `${path}: ${order}`)
								.join(", ")}
						</div>
					)}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _setProjectScriptExecutionOrder(): void {
		try {
			setProjectScriptExecutionOrder(
				this.props.object,
				{ path: this.state.projectScriptOrderPath.trim(), executionOrder: this.state.projectScriptOrder },
				{ editor: this.props.editor }
			);
			this.setState({ projectScriptOrderPath: "" });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not set project script execution order.");
		}
	}

	private async _setProjectWideScriptExecutionOrder(): Promise<void> {
		try {
			await setProjectWideScriptExecutionOrder(
				this.props.object,
				{ path: this.state.projectScriptOrderPath.trim(), executionOrder: this.state.projectScriptOrder },
				{ editor: this.props.editor }
			);
			this.setState({ projectScriptOrderPath: "" });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not set project-wide script execution order.");
		}
	}

	private _clearProjectScriptExecutionOrder(path: string): void {
		try {
			setProjectScriptExecutionOrder(this.props.object, { path: `src/${path}`, executionOrder: null }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not clear project script execution order.");
		}
	}

	private _getLightingScenariosComponent(): ReactNode {
		const response = listLightingScenarios(this.props.object);
		const scenarios = response.scenarios as any[];
		const runtime = response.runtime as any;
		return (
			<EditorInspectorSectionField
				title="Lighting Scenarios"
				tooltip="Versioned realtime plus baked-lighting scenarios. The same editor/export/MCP runtime applies or cross-fades lights, retained PBR/Standard lightmaps, and adaptive SH9 probe volumes with GLSL/WGSL support."
			>
				<div className="px-2 text-xs text-muted-foreground">
					Runtime: {runtime.backend} · {runtime.shaderLanguages.join(" + ")} ·{" "}
					{runtime.blending ? `${Math.round(runtime.weight * 100)}% blending` : (runtime.activeScenarioName ?? "no active scenario")}
				</div>
				<Button size="sm" variant="secondary" className="w-full" onClick={() => this._createLightingScenario()}>
					Capture Lights + Baked Lighting
				</Button>
				{!scenarios.length && (
					<div className="px-2 text-xs text-muted-foreground">No scenarios saved. Bake lightmaps/APV first, then capture the complete lighting state.</div>
				)}
				{scenarios.map((scenario) => (
					<div key={scenario.id} className="space-y-1 rounded bg-input px-2 py-1 text-xs">
						<div className="flex items-center justify-between gap-2">
							<span className="truncate">
								{scenario.name} · rev {scenario.revision} · {scenario.lights.length} lights
							</span>
							<span className="text-muted-foreground">
								{scenario.bakedLighting?.evidence.lightmapMeshCount ?? 0} lightmaps · {scenario.bakedLighting?.evidence.probeVolumeCount ?? 0} APV
							</span>
						</div>
						<div className="rounded bg-secondary px-1 py-0.5 text-green-400">
							Completion: Captured · Testing evidence: {scenario.bakedLighting?.evidence.probeCount ?? 0} probes · {scenario.bakedLighting?.evidence.cellCount ?? 0}{" "}
							cells
						</div>
						<div className="grid grid-cols-3 gap-1">
							<Button size="sm" variant="secondary" onClick={() => this._blendLightingScenario(scenario, 0)}>
								Apply
							</Button>
							<Button size="sm" variant="ghost" onClick={() => this._blendLightingScenario(scenario, 1000)}>
								Blend 1s
							</Button>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => void this._deleteLightingScenario(scenario)}>
								Delete
							</Button>
						</div>
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _createLightingScenario(): void {
		const scenarios = listLightingScenarios(this.props.object).scenarios as any[];
		let index = scenarios.length + 1;
		while (scenarios.some((scenario) => scenario.name === `Lighting Scenario ${index}`)) {
			index++;
		}
		try {
			createLightingScenario(this.props.object, { name: `Lighting Scenario ${index}` }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _blendLightingScenario(scenario: any, durationMs: number): void {
		try {
			blendLightingScenario(this.props.object, { id: scenario.id, durationMs }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _deleteLightingScenario(scenario: any): Promise<void> {
		try {
			await deleteLightingScenario(this.props.object, { id: scenario.id, expectedRevision: scenario.revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getReflectionProbesComponent(): ReactNode {
		const probes = listReflectionProbes(this.props.object).probes as any[];
		const meshes = this.props.object.meshes;
		const materials = this.props.object.materials.filter((material) => !material.doNotSerialize);
		return (
			<EditorInspectorSectionField
				title="Reflection Probes"
				tooltip="Realtime cubemap reflection captures with Unity-style importance, influence-edge blending, environment fallback, and optional box projection. Changes use the same persisted MCP actions available to Codex and Claude."
			>
				<div className="flex flex-col gap-2">
					<div className="flex gap-2">
						<Input
							value={this.state.reflectionProbeName}
							aria-label="New reflection probe name"
							onChange={(event) => this.setState({ reflectionProbeName: event.currentTarget.value })}
							placeholder="Reflection Probe"
						/>
						<Button size="sm" disabled={!this.state.reflectionProbeName.trim()} onClick={() => this._createReflectionProbe()}>
							Create
						</Button>
					</div>
					{probes.map((probe) => (
						<div key={probe.id} className="flex flex-col gap-2 rounded-lg bg-input p-2">
							<div className="flex items-center justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate font-medium">{probe.name}</div>
									<div className="text-xs text-muted-foreground">
										Revision {probe.revision} · {probe.ready ? "Cubemap ready" : "Cubemap pending"}
									</div>
								</div>
								<Button size="sm" variant="ghost" className="h-7 px-2 !text-red-400" onClick={() => this._deleteReflectionProbe(probe)}>
									Remove
								</Button>
							</div>
							<div className="grid grid-cols-3 gap-2">
								{["X", "Y", "Z"].map((axis, index) => (
									<label key={axis} className="flex flex-col gap-1 text-xs">
										{axis}
										<input
											type="number"
											defaultValue={String(probe.position[index])}
											onBlur={(event) => this._setReflectionProbePosition(probe, index, event.currentTarget.value)}
											className="rounded bg-background px-2 py-1"
										/>
									</label>
								))}
							</div>
							<div className="grid grid-cols-2 gap-2">
								<label className="flex flex-col gap-1 text-xs">
									Importance
									<input
										type="number"
										min={0}
										max={1000}
										step={1}
										defaultValue={String(probe.importance)}
										onBlur={(event) => this._setReflectionProbeNumber(probe, "importance", event.currentTarget.value)}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									Blend Distance
									<input
										type="number"
										min={0}
										max={Math.min(...probe.influenceSize) * 0.5}
										step={1}
										defaultValue={String(probe.blendDistance)}
										onBlur={(event) => this._setReflectionProbeNumber(probe, "blendDistance", event.currentTarget.value)}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
							</div>
							<div className="text-xs text-muted-foreground">
								{probe.blendModel} · equal importance blends per pixel; higher importance wins; unused edge weight falls back to sky/environment.
							</div>
							<div className="grid grid-cols-3 gap-2">
								<label className="flex flex-col gap-1 text-xs">
									Refresh Rate
									<input
										type="number"
										min={0}
										defaultValue={String(probe.refreshRate)}
										onBlur={(event) => this._setReflectionProbeNumber(probe, "refreshRate", event.currentTarget.value)}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									Samples
									<input
										type="number"
										min={0}
										defaultValue={String(probe.samples)}
										onBlur={(event) => this._setReflectionProbeNumber(probe, "samples", event.currentTarget.value)}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									IBL Intensity
									<input
										type="number"
										min={0}
										max={16}
										step={0.05}
										defaultValue={String(probe.intensity)}
										onBlur={(event) => this._setReflectionProbeNumber(probe, "intensity", event.currentTarget.value)}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
							</div>
							<label className="flex items-center gap-2 text-xs">
								<input
									type="checkbox"
									checked={probe.boxProjection}
									onChange={(event) => this._setReflectionProbe(probe, { boxProjection: event.currentTarget.checked })}
								/>
								Box-projected local reflections
							</label>
							<div className="grid grid-cols-3 gap-2">
								{(["influencePosition", "influenceSize"] as const).flatMap((property) =>
									["X", "Y", "Z"].map((axis, index) => (
										<label key={`${property}-${axis}`} className="flex flex-col gap-1 text-xs">
											{property === "influencePosition" ? "Center" : "Size"} {axis}
											<input
												type="number"
												min={property === "influenceSize" ? Number.EPSILON : undefined}
												defaultValue={String(probe[property][index])}
												onBlur={(event) => this._setReflectionProbeBounds(probe, property, index, event.currentTarget.value)}
												className="rounded bg-background px-2 py-1"
											/>
										</label>
									))
								)}
							</div>
							<label className="flex flex-col gap-1 text-xs">
								Attach to Mesh
								<select
									value={probe.attachedMeshId ?? ""}
									onChange={(event) => this._setReflectionProbe(probe, { attachedMeshId: event.currentTarget.value || null })}
									className="h-8 rounded bg-background px-2"
								>
									<option value="">World position</option>
									{meshes.map((mesh) => (
										<option key={mesh.id} value={mesh.id}>
											{mesh.name}
										</option>
									))}
								</select>
							</label>
							<div className="flex flex-col gap-1 text-xs">
								<div>Capture Render List ({probe.renderList === null ? "All" : probe.renderList.length})</div>
								{meshes.map((mesh) => {
									const selected = probe.renderList?.includes(mesh.id) ?? true;
									return (
										<label key={mesh.id} className="flex items-center gap-2">
											<input type="checkbox" checked={selected} onChange={() => this._toggleReflectionProbeRenderMesh(probe, mesh.id)} />
											<span className="truncate">{mesh.name}</span>
										</label>
									);
								})}
								{!meshes.length && <div className="text-muted-foreground">No meshes in this scene.</div>}
							</div>
							<div className="flex flex-col gap-1 text-xs">
								<div>Material Assignments ({probe.assignedMaterialIds.length})</div>
								{materials.map((material) => (
									<label key={material.uniqueId} className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={probe.assignedMaterialIds.includes(material.id)}
											onChange={() => this._toggleReflectionProbeMaterial(probe, material.id)}
										/>
										<span className="truncate">{material.name}</span>
									</label>
								))}
								{!materials.length && <div className="text-muted-foreground">No assignable scene materials.</div>}
							</div>
							{probe.deferredCameras.length > 0 && (
								<div
									className={probe.deferredCameras.every((camera: any) => camera.active && camera.ready) ? "text-xs text-emerald-400" : "text-xs text-amber-400"}
								>
									Deferred IBL:{" "}
									{probe.deferredCameras
										.map((camera: any) => `${camera.cameraName} (${camera.active && camera.ready ? "ready" : "rebuild required"})`)
										.join(", ")}
								</div>
							)}
						</div>
					))}
					{!probes.length && <div className="text-sm text-muted-foreground">No realtime reflection probes. Create one to capture local cubemap reflections.</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createReflectionProbe(): void {
		const name = this.state.reflectionProbeName.trim();
		try {
			createReflectionProbe(this.props.object, { name }, { editor: this.props.editor });
			this.setState({ reflectionProbeName: `${name} 2` });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create reflection probe.");
		}
	}

	private _setReflectionProbe(probe: any, update: any): void {
		try {
			setReflectionProbe(this.props.object, { id: probe.id, expectedRevision: probe.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update reflection probe.");
		}
	}

	private _setReflectionProbePosition(probe: any, index: number, value: string): void {
		const coordinate = Number(value);
		if (!Number.isFinite(coordinate)) {
			return;
		}
		const position = [...probe.position];
		position[index] = coordinate;
		this._setReflectionProbe(probe, { position });
	}

	private _setReflectionProbeNumber(probe: any, property: "refreshRate" | "samples" | "intensity" | "importance" | "blendDistance", value: string): void {
		const number = Number(value);
		if (
			Number.isFinite(number) &&
			number >= 0 &&
			(property === "intensity" || property === "blendDistance" || Number.isInteger(number)) &&
			(property !== "importance" || number <= 1000) &&
			(property !== "blendDistance" || number <= Math.min(...probe.influenceSize) * 0.5)
		) {
			this._setReflectionProbe(probe, { [property]: number });
		}
	}

	private _setReflectionProbeBounds(probe: any, property: "influencePosition" | "influenceSize", index: number, value: string): void {
		const coordinate = Number(value);
		if (!Number.isFinite(coordinate) || (property === "influenceSize" && coordinate <= 0)) {
			return;
		}
		const vector = [...probe[property]];
		vector[index] = coordinate;
		const update: Record<string, unknown> = { [property]: vector };
		if (property === "influenceSize" && probe.blendDistance > Math.min(...vector) * 0.5) {
			update.blendDistance = Math.min(...vector) * 0.5;
		}
		this._setReflectionProbe(probe, update);
	}

	private _toggleReflectionProbeRenderMesh(probe: any, meshId: string): void {
		const current = probe.renderList ?? this.props.object.meshes.map((mesh) => mesh.id);
		this._setReflectionProbe(probe, { renderListIds: current.includes(meshId) ? current.filter((id: string) => id !== meshId) : [...current, meshId] });
	}

	private _toggleReflectionProbeMaterial(probe: any, materialId: string): void {
		const current = probe.assignedMaterialIds as string[];
		this._setReflectionProbe(probe, { assignMaterialIds: current.includes(materialId) ? current.filter((id) => id !== materialId) : [...current, materialId] });
	}

	private _deleteReflectionProbe(probe: any): void {
		try {
			deleteReflectionProbe(this.props.object, { id: probe.id, expectedRevision: probe.revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not remove reflection probe.");
		}
	}

	private _getPhysicsComponent(): ReactNode {
		const physicsEngine = this.props.editor.layout.preview.scene.getPhysicsEngine();
		const o = physicsEngine ? { gravity: physicsEngine.gravity.clone() } : null;
		const hybrid = getHybridPhysicsSolver(this.props.object);
		const hybridSettings = structuredClone(hybrid.configuration);
		const activeCapture = physicsEngine ? getPhysicsContactCapture(this.props.object) : { active: false };
		const capture = activeCapture.active ? activeCapture : this.state.physicsContactCapture;
		const simulationInspection = getPhysicsSimulationControlForInspector(this.props.object, { editor: this.props.editor });
		const simulationControl = simulationInspection.control;
		const contactVisualization = physicsEngine ? getPhysicsContactVisualization(this.props.object) : { enabled: false, activeOverlayCount: 0 };

		return (
			<EditorInspectorSectionField
				title="Game Simulation"
				tooltip="Pause and deterministically step scripts, cloth, Physics 2D, and optional Havok in one fixed-frame order."
			>
				<div data-testid="hybrid-physics-solver-status" className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
					<div className="font-semibold">Hybrid Direct + Iterative Solver</div>
					<div className="text-muted-foreground">
						Revision {hybrid.configuration.revision} · {hybrid.runtime.directConstraintCount} direct joints · {hybrid.runtime.gearCouplingCount} gear couplings ·{" "}
						{hybrid.runtime.rowCount} rows · residual {hybrid.runtime.maximumResidualBefore.toFixed(4)} → {hybrid.runtime.maximumResidualAfter.toFixed(4)}
					</div>
					<div className="text-muted-foreground">
						{hybrid.runtime.processedFrames} processed / {hybrid.runtime.skippedFrames} skipped
						{hybrid.runtime.lastSkippedReason ? ` · ${hybrid.runtime.lastSkippedReason}` : ` · ${hybrid.runtime.lastSolveDurationMs.toFixed(3)} ms`}
					</div>
					<EditorInspectorSwitchField
						noUndoRedo
						object={hybridSettings}
						property="enabled"
						label="Direct Solver Enabled"
						onChange={() => this._setHybridPhysicsSolver({ enabled: hybridSettings.enabled })}
					/>
					<div className="grid grid-cols-2 gap-2">
						<label className="space-y-1 text-muted-foreground">
							Position Bias
							<Input
								type="number"
								min={0}
								max={1}
								step={0.01}
								defaultValue={hybridSettings.positionErrorBias}
								onBlur={(event) => this._setHybridPhysicsNumber("positionErrorBias", event.currentTarget.value)}
							/>
						</label>
						<label className="space-y-1 text-muted-foreground">
							Maximum Rows
							<Input
								type="number"
								min={1}
								max={256}
								step={1}
								defaultValue={hybridSettings.maximumRows}
								onBlur={(event) => this._setHybridPhysicsNumber("maximumRows", event.currentTarget.value)}
							/>
						</label>
					</div>
					<div className="grid grid-cols-2 gap-1">
						<Button size="sm" variant="secondary" disabled={!physicsEngine} onClick={() => void this._createChainGearsPhysicsSample()}>
							Create Chain &amp; Gears
						</Button>
						<Button size="sm" variant="ghost" disabled={!physicsEngine} onClick={() => this._solveHybridPhysicsNow()}>
							Solve Direct Rows
						</Button>
					</div>
					{hybrid.samples.map((sample: any) => (
						<div key={sample.id} className="flex items-center justify-between gap-2 rounded bg-input px-2 py-1">
							<span>
								{sample.name} · {sample.nodeIds.length} nodes · {sample.constraintIds.length} direct joints
							</span>
							<Button size="sm" variant="ghost" className="h-6 px-2 text-destructive" onClick={() => void this._deleteChainGearsPhysicsSample(sample)}>
								Remove
							</Button>
						</div>
					))}
				</div>
				{physicsEngine && o && (
					<>
						<EditorInspectorVectorField
							noUndoRedo
							object={o}
							property="gravity"
							label="3D Gravity"
							onFinishChange={() => {
								const oldGravity = physicsEngine.gravity.clone();

								registerUndoRedo({
									executeRedo: true,
									undo: () => {
										physicsEngine.setGravity(oldGravity);
										physicsEngine.gravity.copyFrom(oldGravity);
									},
									redo: () => {
										physicsEngine.setGravity(o.gravity);
										physicsEngine.gravity.copyFrom(o.gravity);
									},
								});
							}}
						/>
						<Button variant="secondary" className="w-full" onClick={() => this._validatePhysics()}>
							Validate Physics Scene
						</Button>
						<Button variant="secondary" className="w-full" onClick={() => this._inspectPhysicsSimulation()}>
							Inspect 3D Simulation State
						</Button>
					</>
				)}
				{simulationInspection.error && (
					<div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
						Play simulation controls are unavailable for this project bundle. {simulationInspection.error}
					</div>
				)}
				{simulationControl && (
					<>
						<div className="grid grid-cols-3 gap-1">
							<Button size="sm" variant="secondary" onClick={() => this._setPhysicsSimulationPaused(!simulationControl.paused)}>
								{simulationControl.paused ? "Resume Simulation" : "Pause Simulation"}
							</Button>
							<Button size="sm" variant="ghost" disabled={!simulationControl.paused} onClick={() => this._stepPhysicsSimulation(1)}>
								Step 1
							</Button>
							<Button size="sm" variant="ghost" disabled={!simulationControl.paused} onClick={() => this._stepPhysicsSimulation(10)}>
								Step 10
							</Button>
						</div>
						<div className="px-2 text-xs text-muted-foreground">
							{simulationControl.target === "play" ? "Play scene" : "Edit scene"} · {simulationControl.gameScripts.registeredScripts} game script
							{simulationControl.gameScripts.registeredScripts === 1 ? "" : "s"} · {simulationControl.gameScripts.startedScripts} started
							{simulationControl.totalManualSteps > 0 && ` · ${simulationControl.totalManualSteps} steps · ${simulationControl.totalManualSeconds.toFixed(3)}s`}
						</div>
						<div className="px-2 text-xs text-muted-foreground">
							Cloth {simulationControl.cloth.registeredCloths}/{simulationControl.cloth.enabledCloths} registered/enabled · Physics 2D{" "}
							{simulationControl.physics2D.registeredBodies}/{simulationControl.physics2D.dynamicBodies} registered/dynamic · Havok{" "}
							{simulationControl.physicsEngineActive ? "active" : "not active"}
						</div>
						{(simulationControl.cloth.totalManualSteps > 0 || simulationControl.physics2D.totalManualSteps > 0) && (
							<div className="px-2 text-xs text-muted-foreground">
								Cloth {simulationControl.cloth.totalManualSteps} manual frames/{simulationControl.cloth.lastSteppedCloths} last cloths · Physics 2D{" "}
								{simulationControl.physics2D.totalManualSteps}
								manual frames/{simulationControl.physics2D.lastSteppedBodies} last bodies · {simulationControl.physics2D.collisions} contacts/
								{simulationControl.physics2D.triggers.length} triggers
							</div>
						)}
						{simulationControl.gameScripts.totalManualUpdateCalls > 0 && (
							<div className="px-2 text-xs text-muted-foreground">
								{simulationControl.gameScripts.totalManualStartCalls} manual starts · {simulationControl.gameScripts.totalManualUpdateCalls} manual updates · fixed
								delta {simulationControl.gameScripts.lastStepSeconds?.toFixed(4)}s
							</div>
						)}
						{simulationControl.lastError && (
							<div className="px-2 text-xs text-red-400">
								Last step failed in {simulationControl.lastError.phase} after {simulationControl.lastError.completedSteps} completed frames (
								{simulationControl.lastError.completedPhases.join(" → ") || "no completed phase"}): {simulationControl.lastError.message}
							</div>
						)}
					</>
				)}
				{physicsEngine &&
					(activeCapture.active ? (
						<div className="grid grid-cols-3 gap-1">
							<Button size="sm" variant="secondary" onClick={() => this.setState({ physicsContactCapture: getPhysicsContactCapture(this.props.object) })}>
								Refresh Contacts
							</Button>
							<Button size="sm" variant="ghost" onClick={() => this._clearPhysicsContactCapture()}>
								Clear
							</Button>
							<Button size="sm" variant="ghost" onClick={() => this._stopPhysicsContactCapture()}>
								Stop
							</Button>
						</div>
					) : (
						<Button size="sm" variant="secondary" className="w-full" onClick={() => this._startPhysicsContactCapture()}>
							Capture Physics Contacts
						</Button>
					))}
				{physicsEngine && (
					<Button
						size="sm"
						variant={contactVisualization.enabled ? "default" : "ghost"}
						className="w-full"
						onClick={() => this._setPhysicsContactVisualization(!contactVisualization.enabled)}
					>
						{contactVisualization.enabled ? `Contact Vectors On · ${contactVisualization.activeOverlayCount} visible` : "Show Contact Vectors"}
					</Button>
				)}
				{physicsEngine && capture && (
					<div className="space-y-1 px-2 text-xs text-muted-foreground">
						<div>
							{capture.eventCount} contacts · {capture.droppedEvents} dropped {capture.active ? "· recording" : "· stopped"}
						</div>
						{capture.events.slice(-5).map((event: any, index: number) => (
							<div key={`${event.elapsedMs}-${index}`} className="rounded bg-input px-2 py-1">
								{event.type}: {event.colliderName ?? event.colliderNodeId ?? "body"} ↔ {event.collidedAgainstName ?? event.collidedAgainstNodeId ?? "body"} ·
								impulse {event.impulse ?? "n/a"}
							</div>
						))}
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getPhysicsForceVisualizationComponent(): ReactNode {
		const visualization = getPhysicsForceVisualization(this.props.object, { limit: 50 }, { editor: this.props.editor });
		const categoryLabels: Record<PhysicsForceVectorCategory, string> = {
			"gravity-force": "Gravity Force",
			"net-force": "Derived Net Force",
			"linear-velocity": "Linear Velocity",
			"angular-velocity": "Angular Velocity",
			"contact-normal": "Contact Normal",
			"contact-impulse": "Contact Impulse",
			"constraint-axis": "Constraint Axis",
			"constraint-separation": "Constraint Separation",
		};
		const numericSettings = [
			{ property: "maximumVectors", label: "Maximum Vectors", min: 1, max: 512, step: 1 },
			{ property: "refreshIntervalMs", label: "Refresh (ms)", min: 16, max: 2000, step: 1 },
			{ property: "forceScale", label: "Force Scale", min: 0.0001, max: 1000, step: 0.01 },
			{ property: "impulseScale", label: "Impulse Scale", min: 0.0001, max: 10000, step: 0.1 },
			{ property: "velocityScale", label: "Velocity Scale", min: 0.0001, max: 1000, step: 0.01 },
			{ property: "angularVelocityScale", label: "Angular Scale", min: 0.0001, max: 10000, step: 0.1 },
			{ property: "directionScale", label: "Direction Scale", min: 1, max: 10000, step: 1 },
			{ property: "separationScale", label: "Separation Scale", min: 0.0001, max: 1000, step: 0.01 },
			{ property: "pointSize", label: "Arrowhead Size", min: 1, max: 1000, step: 1 },
		] as const;

		return (
			<EditorInspectorSectionField
				title="Physics Force Visualization"
				tooltip="Draw bounded Play/Edit gravity, derived net force, velocity, captured contact, and constraint vectors without advancing physics or mutating bodies."
			>
				<div className="grid grid-cols-2 gap-1">
					<Button
						size="sm"
						variant={visualization.enabled ? "default" : "secondary"}
						onClick={() => this._setPhysicsForceVisualization({ enabled: !visualization.enabled })}
					>
						{visualization.enabled ? "Disable Force Vectors" : "Enable Force Vectors"}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => this._setPhysicsForceVisualization({ clear: true })}>
						Clear Samples
					</Button>
				</div>
				<div className="px-2 text-xs text-muted-foreground">
					{visualization.target === "play" ? "Play scene" : "Edit scene"} · revision {visualization.revision} · {visualization.availableVectorCount} available ·{" "}
					{visualization.renderedVectorCount} drawn in {visualization.activeOverlayCount} overlay · {visualization.truncatedVectorCount} truncated
				</div>
				<div className="grid grid-cols-2 gap-1">
					{physicsForceVectorCategories.map((category) => {
						const selected = visualization.settings.categories.includes(category);
						return (
							<Button key={category} size="sm" variant={selected ? "default" : "ghost"} onClick={() => this._togglePhysicsForceVisualizationCategory(category)}>
								{categoryLabels[category]} ({visualization.categoryCounts[category] ?? 0})
							</Button>
						);
					})}
				</div>
				<label className="space-y-1 px-2 text-xs text-muted-foreground">
					Body node ids (comma separated; empty means all)
					<Input
						key={`physics-force-bodies-${visualization.revision}`}
						defaultValue={visualization.settings.bodyNodeIds.join(", ")}
						placeholder="body-id, other-body-id"
						onBlur={(event) => this._setPhysicsForceVisualizationBodyNodeIds(event.currentTarget.value)}
					/>
				</label>
				<div className="grid grid-cols-2 gap-2 px-2">
					{numericSettings.map((setting) => (
						<label key={setting.property} className="space-y-1 text-xs text-muted-foreground">
							{setting.label}
							<Input
								key={`${setting.property}-${visualization.revision}`}
								type="number"
								min={setting.min}
								max={setting.max}
								step={setting.step}
								defaultValue={visualization.settings[setting.property]}
								onBlur={(event) => this._setPhysicsForceVisualizationNumber(setting.property, event.currentTarget.value)}
							/>
						</label>
					))}
				</div>
				<div className="space-y-1 px-2 text-xs text-muted-foreground">
					<div>
						{visualization.sampling.sampleCount} completed samples · {visualization.sampling.derivedNetForceCount} derived net forces · {visualization.refreshCount}{" "}
						overlay refreshes · {visualization.renderedLineCount} line segments
					</div>
					<div className="text-emerald-400">
						Physics advanced: {String(visualization.physicsAdvanced)} · bodies mutated: {String(visualization.bodiesMutated)}
					</div>
					<div>Original applied forces: unavailable · constraint reaction forces: unavailable · net force: derived from completed velocity samples</div>
					{visualization.lastError && <div className="text-red-400">Last visualization error: {visualization.lastError.message}</div>}
				</div>
				{visualization.vectors.length > 0 && (
					<div className="max-h-56 space-y-1 overflow-auto px-2 text-xs">
						{visualization.vectors.slice(0, 12).map((vector: any) => (
							<div key={vector.id} className="rounded bg-input px-2 py-1">
								<div className="font-medium">
									{categoryLabels[vector.category as PhysicsForceVectorCategory]} · {vector.nodeName ?? vector.nodeId ?? "scene"}
								</div>
								<div className="text-muted-foreground">
									[{vector.vector.map((value: number) => value.toFixed(3)).join(", ")}] {vector.unit} · magnitude {vector.magnitude.toFixed(3)} ·{" "}
									{vector.provenance}
								</div>
							</div>
						))}
					</div>
				)}
				{visualization.settings.categories.some((category: PhysicsForceVectorCategory) => category === "contact-normal" || category === "contact-impulse") && (
					<div className="px-2 text-xs text-muted-foreground">Contact vectors use the active bounded contact capture shown in Game Simulation.</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getPhysicsContactHistoryComponent(): ReactNode {
		const selected = this.state.physicsContactHistories.find((history) => history.path === this.state.physicsContactHistorySelectedPath) ?? null;
		const detail = this.state.physicsContactHistoryDetail;
		const replay = getPhysicsContactHistoryReplay(this.props.object, {}, { editor: this.props.editor });
		const capture = getPhysicsContactCapture(this.props.object, {}, { editor: this.props.editor });
		return (
			<EditorInspectorSectionField
				title="Physics Contact History"
				tooltip="Persist, filter, inspect, and replay bounded Play/Edit collision evidence. Replay is visualization-only and never advances physics or invokes recorded callbacks."
			>
				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
					<div className="flex items-center justify-between gap-2 text-xs font-semibold">
						<span>Capture Snapshot</span>
						<Button size="sm" variant="ghost" disabled={this.state.physicsContactHistoryBusy} onClick={() => void this._refreshPhysicsContactHistories()}>
							Refresh Assets
						</Button>
					</div>
					<Input
						value={this.state.physicsContactHistoryPath}
						placeholder="assets/physics/contact-history.physicscontacts.json"
						onChange={(event) => this.setState({ physicsContactHistoryPath: event.currentTarget.value })}
					/>
					<Input
						value={this.state.physicsContactHistoryName}
						placeholder="Contact History"
						onChange={(event) => this.setState({ physicsContactHistoryName: event.currentTarget.value })}
					/>
					<Button
						size="sm"
						variant="secondary"
						className="w-full"
						disabled={
							!capture.active || this.state.physicsContactHistoryBusy || !this.state.physicsContactHistoryPath.trim() || !this.state.physicsContactHistoryName.trim()
						}
						onClick={() => void this._savePhysicsContactHistory()}
					>
						{capture.active ? "Save Active Capture" : "Start Contact Capture To Save"}
					</Button>
					<div className="text-xs text-muted-foreground">Saving does not stop the live capture. Existing paths require and use their exact current revision.</div>
				</div>

				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
					<div className="text-xs font-semibold">Saved Histories ({this.state.physicsContactHistories.length})</div>
					<select
						value={this.state.physicsContactHistorySelectedPath}
						disabled={!this.state.physicsContactHistories.length || this.state.physicsContactHistoryBusy}
						onChange={(event) => void this._selectPhysicsContactHistory(event.currentTarget.value)}
						className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
					>
						{!this.state.physicsContactHistories.length && <option value="">No saved histories</option>}
						{this.state.physicsContactHistories.map((history) => (
							<option key={history.path} value={history.path}>
								{history.name} · r{history.assetRevision}
							</option>
						))}
					</select>
					{selected && (
						<div className="space-y-1 text-xs text-muted-foreground">
							<div className="break-all">{selected.path}</div>
							<div>
								{selected.summary.eventCount} events · {selected.durationMs.toFixed(1)} ms · {selected.summary.uniqueBodyCount} bodies · max impulse{" "}
								{selected.summary.maximumImpulse ?? "n/a"}
							</div>
							<div>
								{selected.source.target === "play" ? "Play" : "Edit"} capture · {selected.source.droppedEvents} dropped · SHA{" "}
								{selected.contentRevision.slice(0, 12)}
							</div>
						</div>
					)}
					<div className="flex gap-1">
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							disabled={!selected || this.state.physicsContactHistoryBusy}
							onClick={() => void this._loadPhysicsContactHistory()}
						>
							Apply Filters
						</Button>
						<Button size="sm" variant="ghost" disabled={!selected || this.state.physicsContactHistoryBusy} onClick={() => void this._deletePhysicsContactHistory()}>
							Delete
						</Button>
					</div>
				</div>

				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
					<div className="text-xs font-semibold">Replay Filter</div>
					<div className="flex flex-wrap gap-2 text-xs">
						{physicsContactEventTypes.map((type) => (
							<label key={type} className="flex items-center gap-1">
								<input
									type="checkbox"
									checked={this.state.physicsContactHistoryEventTypes.includes(type)}
									onChange={() => this._togglePhysicsContactHistoryType(type)}
								/>
								{type.replace("COLLISION_", "")}
							</label>
						))}
					</div>
					<Input
						value={this.state.physicsContactHistoryBodyNodeIds}
						placeholder="Body node ids (comma separated)"
						onChange={(event) => this.setState({ physicsContactHistoryBodyNodeIds: event.currentTarget.value })}
					/>
					<div className="grid grid-cols-2 gap-1">
						<Input
							type="number"
							min={0}
							value={this.state.physicsContactHistoryFromMs}
							placeholder="From ms"
							onChange={(event) => this.setState({ physicsContactHistoryFromMs: event.currentTarget.value })}
						/>
						<Input
							type="number"
							min={0}
							value={this.state.physicsContactHistoryToMs}
							placeholder="To ms"
							onChange={(event) => this.setState({ physicsContactHistoryToMs: event.currentTarget.value })}
						/>
						<Input
							type="number"
							value={this.state.physicsContactHistoryMinimumImpulse}
							placeholder="Min impulse"
							onChange={(event) => this.setState({ physicsContactHistoryMinimumImpulse: event.currentTarget.value })}
						/>
						<Input
							type="number"
							value={this.state.physicsContactHistoryMaximumImpulse}
							placeholder="Max impulse"
							onChange={(event) => this.setState({ physicsContactHistoryMaximumImpulse: event.currentTarget.value })}
						/>
					</div>
					{detail && (
						<div className="space-y-1 text-xs text-muted-foreground">
							<div>
								Matched {detail.matchedSummary.eventCount} · started {detail.matchedSummary.startedCount} · continued {detail.matchedSummary.continuedCount} ·
								finished {detail.matchedSummary.finishedCount}
							</div>
							{detail.events.slice(-5).map((event: any) => (
								<div key={event.sequence} className="rounded bg-input px-2 py-1">
									#{event.sequence} {event.elapsedMs.toFixed(1)} ms · {event.type.replace("COLLISION_", "")} ·{" "}
									{event.colliderName ?? event.colliderNodeId ?? "body"} ↔ {event.collidedAgainstName ?? event.collidedAgainstNodeId ?? "body"} · impulse{" "}
									{event.impulse ?? "n/a"}
								</div>
							))}
						</div>
					)}
				</div>

				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
					<div className="flex items-center justify-between text-xs font-semibold">
						<span>Deterministic Replay</span>
						<span className="text-emerald-400">Physics off · callbacks off</span>
					</div>
					{replay.active ? (
						<>
							<div className="grid grid-cols-5 gap-1">
								<Button
									size="sm"
									variant="ghost"
									disabled={replay.playing || replay.selectedEventIndex <= 0}
									onClick={() => this._controlPhysicsContactHistoryReplay("step", { eventDelta: -1 })}
								>
									Prev
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._controlPhysicsContactHistoryReplay(replay.playing ? "pause" : "play")}>
									{replay.playing ? "Pause" : "Play"}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={replay.playing || replay.selectedEventIndex >= replay.filteredSummary.eventCount - 1}
									onClick={() => this._controlPhysicsContactHistoryReplay("step", { eventDelta: 1 })}
								>
									Next
								</Button>
								<Button size="sm" variant="ghost" onClick={() => this._controlPhysicsContactHistoryReplay("seek", { cursorMs: 0 })}>
									Reset
								</Button>
								<Button size="sm" variant="ghost" onClick={() => this._controlPhysicsContactHistoryReplay("stop")}>
									Stop
								</Button>
							</div>
							<input
								type="range"
								min={0}
								max={replay.durationMs}
								step={0.1}
								value={replay.cursorMs}
								onChange={(event) => this._controlPhysicsContactHistoryReplay("seek", { cursorMs: Number(event.currentTarget.value) })}
								className="w-full"
							/>
							<div className="grid grid-cols-5 gap-1">
								<select
									value={replay.playbackRate}
									onChange={(event) => this._configurePhysicsContactHistoryReplay({ playbackRate: Number(event.currentTarget.value) })}
									className="h-8 rounded-md border border-input bg-background px-1 text-xs"
								>
									<option value={0.25}>0.25×</option>
									<option value={0.5}>0.5×</option>
									<option value={1}>1×</option>
									<option value={2}>2×</option>
									<option value={4}>4×</option>
								</select>
								<Input
									type="number"
									min={0}
									max={60000}
									value={replay.trailMs}
									onChange={(event) => this._configurePhysicsContactHistoryReplay({ trailMs: Number(event.currentTarget.value) })}
								/>
								<Input
									type="number"
									min={1}
									max={10000}
									value={replay.normalScale}
									onChange={(event) => this._configurePhysicsContactHistoryReplay({ normalScale: Number(event.currentTarget.value) })}
								/>
								<Input
									type="number"
									min={1}
									max={1000}
									value={replay.pointSize}
									onChange={(event) => this._configurePhysicsContactHistoryReplay({ pointSize: Number(event.currentTarget.value) })}
								/>
								<label className="flex items-center justify-center gap-1 text-xs">
									<input
										type="checkbox"
										checked={replay.loop}
										onChange={(event) => this._configurePhysicsContactHistoryReplay({ loop: event.currentTarget.checked })}
									/>{" "}
									Loop
								</label>
							</div>
							<div className="space-y-1 text-xs text-muted-foreground">
								<div>
									{replay.cursorMs.toFixed(1)} / {replay.durationMs.toFixed(1)} ms · event {replay.selectedEventIndex + 1}/{replay.filteredSummary.eventCount} ·{" "}
									{replay.activeOverlayCount} overlays
								</div>
								<div>
									{replay.target === "play" ? "Play" : "Edit"} · session r{replay.sessionRevision} · asset r{replay.assetRevision} · frame {replay.renderFrame}
								</div>
								<div className={replay.physicsAdvanced || replay.callbacksReexecuted ? "text-red-400" : "text-emerald-400"}>
									Physics advanced: {String(replay.physicsAdvanced)} · callbacks re-executed: {String(replay.callbacksReexecuted)}
								</div>
							</div>
						</>
					) : (
						<>
							<div className="grid grid-cols-5 gap-1">
								<select
									value={this.state.physicsContactReplayRate}
									onChange={(event) => this.setState({ physicsContactReplayRate: Number(event.currentTarget.value) })}
									className="h-9 rounded-md border border-input bg-background px-1 text-xs"
								>
									<option value={0.25}>0.25×</option>
									<option value={0.5}>0.5×</option>
									<option value={1}>1×</option>
									<option value={2}>2×</option>
									<option value={4}>4×</option>
								</select>
								<Input
									type="number"
									min={0}
									max={60000}
									value={this.state.physicsContactReplayTrailMs}
									onChange={(event) => this.setState({ physicsContactReplayTrailMs: Number(event.currentTarget.value) })}
								/>
								<Input
									type="number"
									min={1}
									max={10000}
									value={this.state.physicsContactReplayNormalScale}
									onChange={(event) => this.setState({ physicsContactReplayNormalScale: Number(event.currentTarget.value) })}
								/>
								<Input
									type="number"
									min={1}
									max={1000}
									value={this.state.physicsContactReplayPointSize}
									onChange={(event) => this.setState({ physicsContactReplayPointSize: Number(event.currentTarget.value) })}
								/>
								<label className="flex items-center justify-center gap-1 text-xs">
									<input
										type="checkbox"
										checked={this.state.physicsContactReplayLoop}
										onChange={(event) => this.setState({ physicsContactReplayLoop: event.currentTarget.checked })}
									/>{" "}
									Loop
								</label>
							</div>
							<Button
								size="sm"
								variant="secondary"
								className="w-full"
								disabled={!selected || capture.active || this.state.physicsContactHistoryBusy}
								onClick={() => void this._startPhysicsContactHistoryReplay()}
							>
								{capture.active ? "Stop Live Capture Before Replay" : "Start Visualization Replay"}
							</Button>
						</>
					)}
					<div className="text-xs text-muted-foreground">Controls: speed · trail ms · normal scale · point size · loop. Replay owns at most 256 transient overlays.</div>
				</div>
				{this.state.physicsContactHistoryError && <div className="px-2 text-xs text-red-400">{this.state.physicsContactHistoryError}</div>}
			</EditorInspectorSectionField>
		);
	}

	private _getPhysicsCollisionLayersComponent(): ReactNode {
		const layers = getPhysicsCollisionLayers(this.props.object).layers as IPhysicsCollisionLayer[];
		return (
			<EditorInspectorSectionField
				title="Physics Collision Layers"
				tooltip="Named 3D collision memberships and a 16-bit collision matrix. Assign a layer to a physics mesh from its Physics inspector."
			>
				<Button variant="secondary" className="w-full" disabled={layers.length >= 16} onClick={() => this._addPhysicsCollisionLayer()}>
					Add Layer
				</Button>
				{layers.map((layer) => (
					<div key={`${layer.bit}-${layer.name}`} className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
						<div className="flex items-center gap-2">
							<Input
								defaultValue={layer.name}
								aria-label={`Physics collision layer ${layer.name} name`}
								onBlur={(event) => this._renamePhysicsCollisionLayer(layer.bit, event.target.value)}
							/>
							<div className="w-16 text-right text-xs text-muted-foreground">Bit {Math.log2(layer.bit)}</div>
							<Button
								size="sm"
								variant="ghost"
								className="hover:bg-destructive"
								disabled={layers.length === 1}
								onClick={() => this._removePhysicsCollisionLayer(layer.bit)}
							>
								Remove
							</Button>
						</div>
						<div className="flex flex-wrap gap-1 items-center">
							<span className="mr-1 text-xs text-muted-foreground">Collides with</span>
							{layers.map((target) => {
								const enabled = (layer.collidesWith & target.bit) !== 0;
								return (
									<Button
										key={target.bit}
										size="sm"
										variant={enabled ? "default" : "secondary"}
										onClick={() => this._togglePhysicsCollisionLayer(layer.bit, target.bit)}
									>
										{target.name}
									</Button>
								);
							})}
						</div>
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _setPhysicsCollisionLayers(layers: IPhysicsCollisionLayer[]): void {
		try {
			const oldLayers = getPhysicsCollisionLayers(this.props.object).layers as IPhysicsCollisionLayer[];
			registerUndoRedo({
				executeRedo: true,
				undo: () => setPhysicsCollisionLayers(this.props.object, { layers: oldLayers }, { editor: this.props.editor }),
				redo: () => setPhysicsCollisionLayers(this.props.object, { layers }, { editor: this.props.editor }),
			});
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _addPhysicsCollisionLayer(): void {
		const layers = getPhysicsCollisionLayers(this.props.object).layers as IPhysicsCollisionLayer[];
		const bit = Array.from({ length: 16 }, (_, index) => 1 << index).find((candidate) => !layers.some((layer) => layer.bit === candidate));
		if (!bit) {
			return;
		}
		let index = layers.length + 1;
		while (layers.some((layer) => layer.name === `Layer ${index}`)) {
			index++;
		}
		this._setPhysicsCollisionLayers([...layers, { name: `Layer ${index}`, bit, collidesWith: 0xffff }]);
	}

	private _removePhysicsCollisionLayer(bit: number): void {
		const layers = getPhysicsCollisionLayers(this.props.object).layers as IPhysicsCollisionLayer[];
		this._setPhysicsCollisionLayers(layers.filter((layer) => layer.bit !== bit).map((layer) => ({ ...layer, collidesWith: layer.collidesWith & ~bit })));
	}

	private _renamePhysicsCollisionLayer(bit: number, name: string): void {
		const layers = getPhysicsCollisionLayers(this.props.object).layers as IPhysicsCollisionLayer[];
		this._setPhysicsCollisionLayers(layers.map((layer) => (layer.bit === bit ? { ...layer, name } : layer)));
	}

	private _togglePhysicsCollisionLayer(layerBit: number, targetBit: number): void {
		const layers = getPhysicsCollisionLayers(this.props.object).layers as IPhysicsCollisionLayer[];
		this._setPhysicsCollisionLayers(layers.map((layer) => (layer.bit === layerBit ? { ...layer, collidesWith: layer.collidesWith ^ targetBit } : layer)));
	}

	private _getPlatformSupportComponent(): ReactNode {
		const capabilities = listPlatformCapabilities().platforms as any[];
		const diagnostics = new Map(this.state.platformDiagnostics.map((entry) => [entry.descriptor.target, entry]));
		return (
			<EditorInspectorSectionField
				title="Platform Support"
				tooltip="Honest built-in, scaffolded, integrated, and unsupported platform inventory with host/SDK diagnostics. Android/iOS native packaging still uses vendor toolchains; proprietary console SDKs are not bundled."
			>
				<div className="flex items-center gap-2 rounded bg-input p-2 text-xs">
					<span>Web · Desktop · Mobile · Dedicated Server · WebXR</span>
					<Button size="sm" variant="secondary" className="ml-auto" disabled={this.state.platformBusy} onClick={() => void this._refreshPlatformDiagnostics()}>
						{this.state.platformBusy ? "Checking…" : "Check Toolchains"}
					</Button>
				</div>
				<div className="grid grid-cols-2 gap-2">
					{capabilities.map((platform) => {
						const diagnostic = diagnostics.get(platform.target);
						const scaffold = diagnostic?.scaffold;
						const scaffoldable = platform.projectScaffold === true;
						const restartable = ["web", "electron", "headless", "android", "ios"].includes(platform.target);
						return (
							<div key={platform.target} className="space-y-2 rounded-md border border-input p-2 text-xs">
								<div className="flex items-center justify-between gap-2">
									<span className="font-medium">{platform.name}</span>
									<span className={platform.support === "unsupported" ? "text-destructive" : "text-muted-foreground"}>{platform.support}</span>
								</div>
								{diagnostic && (
									<div className={diagnostic.readyForProjectExport ? "text-emerald-500" : "text-amber-500"}>
										Project {diagnostic.readyForProjectExport ? "ready" : "needs setup"} · native {diagnostic.readyForNativePackage ? "ready" : "external"}
									</div>
								)}
								{diagnostic?.readyForProjectExport && restartable && (
									<Button
										size="sm"
										variant="secondary"
										disabled={this.state.platformBusy}
										onClick={() => void this._restartForInstalledPlatform(platform.target)}
									>
										Save & Restart Editor
									</Button>
								)}
								{scaffoldable && (
									<div className="flex gap-1">
										<Button
											size="sm"
											variant="secondary"
											disabled={this.state.platformBusy}
											onClick={() => void this._generatePlatformScaffold(platform.target)}
										>
											{scaffold?.exists ? `Update r${scaffold.revision}` : "Generate Scaffold"}
										</Button>
										{scaffold?.exists && (
											<Button size="sm" variant="ghost" disabled={this.state.platformBusy} onClick={() => void this._removePlatformScaffold(platform.target)}>
												Remove
											</Button>
										)}
									</div>
								)}
								{scaffold?.exists && !scaffold.integrity && <div className="text-destructive">Generated-file integrity mismatch</div>}
								{scaffold?.exists && platform.target === "headless" && (
									<div className="grid grid-cols-2 gap-1">
										<Input
											type="number"
											min={1}
											max={65535}
											defaultValue={scaffold.manifest.settings.port}
											placeholder="Server port"
											onBlur={(event) => void this._updatePlatformScaffold("headless", { port: Number(event.target.value) })}
										/>
										<Input
											type="number"
											min={1}
											max={240}
											defaultValue={scaffold.manifest.settings.tickRate}
											placeholder="Tick rate"
											onBlur={(event) => void this._updatePlatformScaffold("headless", { tickRate: Number(event.target.value) })}
										/>
									</div>
								)}
								{scaffold?.exists && platform.target === "android" && (
									<div className="grid grid-cols-3 gap-1">
										<Input
											type="number"
											min={21}
											max={100}
											defaultValue={scaffold.manifest.settings.minimumSdk}
											placeholder="Min SDK"
											onBlur={(event) => void this._updatePlatformScaffold("android", { minimumSdk: Number(event.target.value) })}
										/>
										<Input
											type="number"
											min={21}
											max={100}
											defaultValue={scaffold.manifest.settings.targetSdk}
											placeholder="Target SDK"
											onBlur={(event) => void this._updatePlatformScaffold("android", { targetSdk: Number(event.target.value) })}
										/>
										<select
											className="h-9 rounded-md border border-input bg-background px-1"
											defaultValue={scaffold.manifest.settings.format}
											onChange={(event) => void this._updatePlatformScaffold("android", { format: event.target.value })}
										>
											<option value="project">Project</option>
											<option value="apk">APK</option>
											<option value="aab">AAB</option>
										</select>
									</div>
								)}
								{scaffold?.exists && platform.target === "ios" && (
									<div className="grid grid-cols-2 gap-1">
										<select
											className="h-9 rounded-md border border-input bg-background px-1"
											defaultValue={scaffold.manifest.settings.projectType ?? "capacitor"}
											onChange={(event) => {
												const projectType = event.target.value;
												void this._updatePlatformScaffold("ios", {
													projectType,
													syncNativeProject: projectType === "swift" ? false : scaffold.manifest.settings.syncNativeProject,
													deploymentTarget:
														projectType === "swift" && Number(scaffold.manifest.settings.deploymentTarget) < 16
															? "16.0"
															: scaffold.manifest.settings.deploymentTarget,
												});
											}}
										>
											<option value="capacitor">Capacitor project</option>
											<option value="swift">Swift project (Experimental)</option>
										</select>
										<Input
											defaultValue={scaffold.manifest.settings.deploymentTarget}
											placeholder="iOS target"
											onBlur={(event) => void this._updatePlatformScaffold("ios", { deploymentTarget: event.target.value })}
										/>
										<select
											className="h-9 rounded-md border border-input bg-background px-1"
											defaultValue={scaffold.manifest.settings.deviceFamily}
											onChange={(event) => void this._updatePlatformScaffold("ios", { deviceFamily: event.target.value })}
										>
											<option value="universal">Universal</option>
											<option value="iphone">iPhone</option>
											<option value="ipad">iPad</option>
										</select>
										{scaffold.manifest.settings.projectType === "swift" && (
											<Button
												size="sm"
												variant="secondary"
												disabled={this.state.platformBusy}
												onClick={() => void this._validateIosSwiftProject(scaffold.revision)}
											>
												Validate Swift Project
											</Button>
										)}
										{scaffold.manifest.settings.projectType === "swift" && (
											<div className="col-span-2 text-amber-500">
												Experimental SwiftUI/WKWebView project · iOS 16+ · Xcode and Apple signing remain external.
											</div>
										)}
									</div>
								)}
								<div className="text-muted-foreground">{platform.limitations[0]}</div>
							</div>
						);
					})}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getBuildProfilesComponent(): ReactNode {
		const configuration = listBuildProfiles(this.props.object);
		const profiles = configuration.profiles;
		const runStatus = getBuildPipelineStatus(this.props.object) as { runs: Array<{ id: string; profileId: string; status: string }> };
		const activeProfile = profiles.find((profile) => profile.id === configuration.activeProfileId);
		const footerContext: IEditorExtensionBuildProfileActionContext | null = activeProfile
			? {
					configurationRevision: configuration.revision,
					isActive: true,
					profile: {
						id: activeProfile.id,
						name: activeProfile.name,
						target: activeProfile.target,
						enabled: activeProfile.enabled,
						options: { ...activeProfile.options },
						settings: structuredClone(activeProfile.settings) as unknown as Record<string, unknown>,
					},
				}
			: null;
		const footerActions = footerContext ? (this.props.editor.extensionHost?.listBuildProfileFooterActions(footerContext) ?? []) : [];
		return (
			<EditorInspectorSectionField
				title="Build Profiles"
				tooltip="Versioned exact-revision Web, Electron, Headless, Android, and iOS profiles with development/release, clean/incremental, signing-environment, staged build-report, and Build & Run controls."
			>
				<div className="mb-2 flex items-center gap-2 rounded bg-input p-2 text-xs">
					<span>
						Version {configuration.version} · revision {configuration.revision}
					</span>
					<select
						className="ml-auto h-8 rounded bg-background px-2"
						value={configuration.activeProfileId ?? ""}
						onChange={(event) => this._setActiveBuildProfile(event.target.value)}
					>
						<option value="">No active profile</option>
						{profiles.map((profile) => (
							<option key={profile.id} value={profile.id}>
								{profile.name}
							</option>
						))}
					</select>
				</div>
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" onClick={() => this._createBuildProfile("web")}>
						Add Web
					</Button>
					<Button variant="secondary" className="flex-1" onClick={() => this._createBuildProfile("electron")}>
						Add Electron
					</Button>
					<Button variant="secondary" className="flex-1" onClick={() => this._createBuildProfile("headless")}>
						Add Headless
					</Button>
					<Button variant="secondary" className="flex-1" onClick={() => this._createBuildProfile("android")}>
						Add Android
					</Button>
					<Button variant="secondary" className="flex-1" onClick={() => this._createBuildProfile("ios")}>
						Add iOS
					</Button>
				</div>
				{profiles.length === 0 && <div className="px-2 text-sm text-muted-foreground">No build profiles. Add a target to persist its export options and settings.</div>}
				{profiles.map((profile: any) => {
					const activeRun = runStatus.runs.find((run) => run.profileId === profile.id && run.status !== "exited");
					const webEvidence = this.state.webBuildEvidence[profile.id];
					const assetStreamingPlan = profile.target === "electron" ? getBuildProfileAssetStreamingPlan(this.props.object, { id: profile.id }).plan : null;
					return (
						<div key={profile.id} className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
							<div className="grid grid-cols-3 gap-2">
								<select
									aria-label="Build target"
									className="h-9 rounded-md border border-input bg-background px-2 text-sm"
									value={profile.target}
									onChange={(event) => this._setBuildProfileDefinition(profile.id, { target: event.target.value })}
								>
									<option value="web">Web</option>
									<option value="electron">Electron</option>
									<option value="headless">Headless / Server</option>
									<option value="android">Android</option>
									<option value="ios">iOS</option>
								</select>
								<label className="flex h-9 items-center gap-2 rounded-md border border-input px-2 text-sm">
									<input
										type="checkbox"
										checked={profile.enabled}
										onChange={(event) => this._setBuildProfileDefinition(profile.id, { enabled: event.target.checked })}
									/>
									Enabled
								</label>
								<span className="flex h-9 items-center truncate rounded-md border border-input px-2 text-xs text-muted-foreground" title={profile.id}>
									ID: {profile.id}
								</span>
							</div>
							<div className="flex justify-between items-center gap-2">
								<div className="min-w-0">
									<Input value={profile.name} aria-label="Build profile name" onChange={(event) => this._renameBuildProfile(profile.id, event.target.value)} />
									<div className="text-xs text-muted-foreground">
										{profile.target === "electron"
											? "Electron desktop"
											: profile.target === "headless"
												? "Headless / server"
												: profile.target === "android"
													? "Android project script"
													: profile.target === "ios"
														? "iOS project script"
														: "Web"}
									</div>
								</div>
								<div className="flex gap-1">
									<Button size="sm" variant="secondary" onClick={() => this._validateBuildProfile(profile.id)}>
										Validate
									</Button>
									<Button size="sm" onClick={() => void this._buildBuildProfile(profile.id)}>
										Build
									</Button>
									<Button size="sm" onClick={() => void this._buildAndRunBuildProfile(profile.id)}>
										Build & Run
									</Button>
									<Button size="sm" variant="secondary" disabled={!activeRun} onClick={() => activeRun && this._stopBuildProfileRun(activeRun.id)}>
										Stop
									</Button>
									<Button size="sm" variant="secondary" onClick={() => this._duplicateBuildProfile(profile.id)}>
										Duplicate
									</Button>
									<Button size="sm" variant="secondary" onClick={() => void this._cleanBuildProfile(profile.id)}>
										Clean
									</Button>
									<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteBuildProfile(profile.id)}>
										Remove
									</Button>
								</div>
							</div>
							<div className="grid grid-cols-2 gap-2">
								<Input
									value={profile.settings?.productName ?? ""}
									placeholder="Product name"
									onChange={(event) => this._setBuildProfileSetting(profile, "productName", event.target.value)}
								/>
								<Input
									value={profile.settings?.version ?? ""}
									placeholder="Version"
									onChange={(event) => this._setBuildProfileSetting(profile, "version", event.target.value)}
								/>
							</div>
							<Input
								value={profile.settings?.outputDirectory ?? ""}
								placeholder="Project-relative target output directory"
								onChange={(event) => this._setBuildProfileSetting(profile, "outputDirectory", event.target.value)}
							/>
							<div className="grid grid-cols-2 gap-2">
								<Input
									value={profile.settings?.companyName ?? ""}
									placeholder="Company name"
									onChange={(event) => this._setBuildProfileSetting(profile, "companyName", event.target.value)}
								/>
								<Input
									value={profile.settings?.applicationId ?? ""}
									placeholder="Application id (com.example.game)"
									onChange={(event) => this._setBuildProfileSetting(profile, "applicationId", event.target.value)}
								/>
								<select
									className="h-9 rounded-md border border-input bg-background px-2 text-sm"
									value={profile.settings?.buildMode ?? "release"}
									onChange={(event) =>
										this._setBuildProfileDefinition(profile.id, {
											settings: {
												...(profile.settings ?? {}),
												buildMode: event.target.value,
												...(event.target.value === "release" ? { codeCoverage: false } : {}),
											},
										})
									}
								>
									<option value="development">Development Build</option>
									<option value="release">Release Build</option>
								</select>
								<select
									className="h-9 rounded-md border border-input bg-background px-2 text-sm"
									value={profile.settings?.compression ?? "none"}
									onChange={(event) => this._setBuildProfileSetting(profile, "compression", event.target.value)}
								>
									<option value="none">No Compression</option>
									<option value="gzip">Gzip</option>
									<option value="brotli">Brotli</option>
								</select>
							</div>
							<div className="flex flex-wrap gap-3 text-xs">
								{[
									["cleanBuild", "Clean Build"],
									["incremental", "Incremental Cache"],
									["sourceMaps", "Script Debugging / Source Maps"],
									["minify", "Minify"],
								].map(([key, label]) => (
									<label key={key} className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={Boolean(profile.settings?.[key])}
											onChange={(event) => this._setBuildProfileSetting(profile, key, event.target.checked)}
										/>
										{label}
									</label>
								))}
							</div>
							{profile.target === "android" && (
								<div className="space-y-2 rounded-md border border-input p-2" data-testid="android-build-profile-settings">
									<div className="text-xs font-medium text-muted-foreground">Android Player</div>
									<div className="grid grid-cols-2 gap-2">
										<label className="space-y-1 text-xs text-muted-foreground">
											Link Time Optimization
											<select
												className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
												value={profile.settings?.android?.linkTimeOptimization ?? "none"}
												onChange={(event) =>
													this._setBuildProfileSetting(profile, "android", {
														...(profile.settings?.android ?? {}),
														linkTimeOptimization: event.target.value,
													})
												}
											>
												<option value="none">None</option>
												<option value="thin">Thin LTO</option>
												<option value="full">Full LTO</option>
											</select>
										</label>
										<label className="space-y-1 text-xs text-muted-foreground">
											XR Link Time Optimization
											<select
												className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
												value={profile.settings?.android?.xrLinkTimeOptimization ?? "inherit"}
												onChange={(event) =>
													this._setBuildProfileSetting(profile, "android", {
														...(profile.settings?.android ?? {}),
														xrLinkTimeOptimization: event.target.value,
													})
												}
											>
												<option value="inherit">Inherit Player LTO</option>
												<option value="thin">ThinLTO adapter</option>
											</select>
										</label>
									</div>
									<label className="flex items-center gap-2 text-xs">
										<input
											type="checkbox"
											checked={profile.settings?.android?.initializationProfiling !== false}
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "android", {
													...(profile.settings?.android ?? {}),
													initializationProfiling: event.target.checked,
												})
											}
										/>
										Android Player initialization profiling markers
									</label>
									<div className="text-xs text-muted-foreground">
										LTO applies to project externalNativeBuild/CMake inputs. Generated Android Trace markers cover provider startup, Activity lifecycle,
										Capacitor bridge, first frame, and scene ready; prebuilt engine/browser/vendor libraries are not recompiled.
									</div>
								</div>
							)}
							{profile.target === "headless" && (
								<div className="space-y-2 rounded-md border border-input p-2" data-testid="linux-server-source-build-settings">
									<div className="text-xs font-medium text-muted-foreground">Linux Dedicated Server Source Build</div>
									<label className="space-y-1 text-xs text-muted-foreground">
										Architecture
										<select
											className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
											value={profile.settings?.headless?.architecture ?? "x64"}
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "headless", {
													...(profile.settings?.headless ?? {}),
													operatingSystem: "linux",
													architecture: event.target.value,
													sourceBuild: true,
													nodeMajor: 22,
												})
											}
										>
											<option value="x64">Linux x64</option>
											<option value="arm64">Linux ARM64</option>
										</select>
									</label>
									<div className="text-xs text-muted-foreground">
										Node.js 22 ESM source package · fixed artifact SHA-256 evidence · Linux/arm64 container recipe. Third-party native addons must provide Linux
										ARM64 binaries; Unity source/internal tools are not used.
									</div>
								</div>
							)}
							{profile.target === "electron" && (
								<div className="rounded border border-input p-2 text-xs" data-testid="development-build-code-coverage">
									<label className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={Boolean(profile.settings?.codeCoverage)}
											disabled={profile.settings?.buildMode !== "development"}
											onChange={(event) => this._setBuildProfileSetting(profile, "codeCoverage", event.target.checked)}
										/>
										Development Build Code Coverage
									</label>
									<div className="mt-1 text-muted-foreground">macOS, Windows, and Linux source coverage · JSON/LCOV runtime export · development builds only</div>
								</div>
							)}
							<div className="flex flex-wrap gap-3 text-xs">
								{[
									["optimize", "Optimize Assets"],
									["mergeDecals", "Merge Decals"],
									["mergeGeometries", "Merge Geometries"],
									["uploadToS3", "Upload to S3"],
								].map(([key, label]) => (
									<label key={key} className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={Boolean(profile.options?.[key])}
											onChange={(event) => this._setBuildProfileOptions(profile, key, event.target.checked)}
										/>
										{label}
									</label>
								))}
							</div>
							<Input
								value={profile.settings?.defineSymbols?.join(", ") ?? ""}
								placeholder="Define symbols (comma separated)"
								onChange={(event) =>
									this._setBuildProfileSetting(
										profile,
										"defineSymbols",
										event.target.value
											.split(",")
											.map((value) => value.trim())
											.filter(Boolean)
									)
								}
							/>
							<div className="grid grid-cols-2 gap-2">
								<Input
									value={profile.settings?.preBuildScripts?.join(", ") ?? ""}
									placeholder="Pre-build package scripts"
									onChange={(event) =>
										this._setBuildProfileSetting(
											profile,
											"preBuildScripts",
											event.target.value
												.split(",")
												.map((value) => value.trim())
												.filter(Boolean)
										)
									}
								/>
								<Input
									value={profile.settings?.buildScripts?.join(", ") ?? ""}
									placeholder="Build scripts (blank = target defaults)"
									onChange={(event) =>
										this._setBuildProfileSetting(
											profile,
											"buildScripts",
											event.target.value.trim()
												? event.target.value
														.split(",")
														.map((value) => value.trim())
														.filter(Boolean)
												: undefined
										)
									}
								/>
								<Input
									value={profile.settings?.postBuildScripts?.join(", ") ?? ""}
									placeholder="Post-build package scripts"
									onChange={(event) =>
										this._setBuildProfileSetting(
											profile,
											"postBuildScripts",
											event.target.value
												.split(",")
												.map((value) => value.trim())
												.filter(Boolean)
										)
									}
								/>
								<Input
									value={profile.settings?.runScript ?? ""}
									placeholder="Build & Run package script"
									onChange={(event) => this._setBuildProfileSetting(profile, "runScript", event.target.value)}
								/>
							</div>
							<div className="space-y-2 rounded-md border border-input p-2">
								<label className="flex items-center gap-2 text-xs font-medium">
									<input
										type="checkbox"
										checked={profile.settings?.signing?.enabled ?? false}
										onChange={(event) =>
											this._setBuildProfileSetting(profile, "signing", { ...(profile.settings?.signing ?? {}), enabled: event.target.checked })
										}
									/>
									Signing from environment variables
								</label>
								<div className="grid grid-cols-2 gap-2">
									{[
										["identityEnvironment", "Identity env"],
										["certificateEnvironment", "Certificate env"],
										["passwordEnvironment", "Password env"],
										["provisioningProfileEnvironment", "Provisioning profile env"],
									].map(([key, placeholder]) => (
										<Input
											key={key}
											value={profile.settings?.signing?.[key] ?? ""}
											placeholder={placeholder}
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "signing", { ...(profile.settings?.signing ?? {}), [key]: event.target.value || undefined })
											}
										/>
									))}
								</div>
							</div>
							{profile.target === "web" && (
								<div className="space-y-2 rounded-md border border-input p-2">
									<div className="text-xs font-medium text-muted-foreground">Web Platform</div>
									<div className="grid grid-cols-2 gap-2">
										<select
											className="h-9 rounded-md border border-input bg-background px-2 text-sm"
											value={profile.settings?.web?.mode ?? "browser"}
											onChange={(event) => this._setBuildProfileSetting(profile, "web", { ...(profile.settings?.web ?? {}), mode: event.target.value })}
										>
											<option value="browser">Browser</option>
											<option value="pwa">Progressive Web App</option>
											<option value="webxr">WebXR</option>
										</select>
										<select
											className="h-9 rounded-md border border-input bg-background px-2 text-sm"
											value={profile.settings?.web?.clientBrowser ?? "system"}
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "web", { ...(profile.settings?.web ?? {}), clientBrowser: event.target.value })
											}
										>
											<option value="system">System Browser</option>
											<option value="chrome">Chrome</option>
											<option value="firefox">Firefox</option>
											<option value="safari">Safari</option>
											<option value="edge">Edge</option>
										</select>
										<select
											className="h-9 rounded-md border border-input bg-background px-2 text-sm"
											value={profile.settings?.web?.optimization ?? "balanced"}
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "web", { ...(profile.settings?.web ?? {}), optimization: event.target.value })
											}
										>
											<option value="fast-build">Fast Build</option>
											<option value="balanced">Balanced</option>
											<option value="runtime-performance">Runtime Performance</option>
											<option value="small-download">Small Download</option>
										</select>
										<Input
											value={profile.settings?.web?.basePath ?? "/"}
											placeholder="Base path"
											onChange={(event) => this._setBuildProfileSetting(profile, "web", { ...(profile.settings?.web ?? {}), basePath: event.target.value })}
										/>
									</div>
									<div className="flex flex-wrap gap-3 text-xs" data-testid="web-build-compatibility-settings">
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={profile.settings?.web?.moduleStripping !== false}
												onChange={(event) =>
													this._setBuildProfileSetting(profile, "web", { ...(profile.settings?.web ?? {}), moduleStripping: event.target.checked })
												}
											/>
											Verify ESM Modular Stripping
										</label>
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={profile.settings?.web?.webAssembly2023 !== false}
												onChange={(event) =>
													this._setBuildProfileSetting(profile, "web", { ...(profile.settings?.web ?? {}), webAssembly2023: event.target.checked })
												}
											/>
											WebAssembly 2023
										</label>
									</div>
									<div className="grid grid-cols-2 gap-2">
										<select
											className="h-9 rounded-md border border-input bg-background px-2 text-sm"
											value={profile.settings?.web?.emscriptenToolchain ?? "typescript-bundler"}
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "web", { ...(profile.settings?.web ?? {}), emscriptenToolchain: event.target.value })
											}
										>
											<option value="typescript-bundler">TypeScript / JavaScript (no Emscripten)</option>
											<option value="external-4.0.19">External Emscripten 4.0.19 Adapter</option>
										</select>
										<Input
											value={profile.settings?.web?.emscriptenExecutable ?? "emcc"}
											placeholder="Emscripten executable"
											disabled={profile.settings?.web?.emscriptenToolchain !== "external-4.0.19"}
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "web", { ...(profile.settings?.web ?? {}), emscriptenExecutable: event.target.value })
											}
										/>
									</div>
									<div className="flex gap-2">
										<Button
											size="sm"
											variant="secondary"
											disabled={this.state.webBuildBusyId === profile.id}
											onClick={() => void this._inspectWebBuildPlan(profile.id)}
										>
											Analyze Web Build
										</Button>
										<Button
											size="sm"
											variant="secondary"
											disabled={this.state.webBuildBusyId === profile.id}
											onClick={() => void this._verifyWebBuildOutput(profile.id)}
										>
											Verify Built Output
										</Button>
									</div>
									<div className="rounded bg-input p-2 text-xs" data-testid="web-build-evidence">
										{webEvidence ? (
											<>
												<div>
													Plan {webEvidence.plan.planFingerprint.slice(0, 12)} ·{" "}
													{webEvidence.plan.modules.filter((entry: any) => entry.decision === "retain").length} retain ·{" "}
													{webEvidence.plan.modules.filter((entry: any) => entry.decision === "strip").length} strip
												</div>
												<div className="text-muted-foreground">
													WebAssembly 2023 {webEvidence.plan.settings.webAssembly2023 ? "enabled" : "disabled"} ·{" "}
													{(webEvidence.toolchain ?? webEvidence.plan.toolchain).reason}
												</div>
												<div className={webEvidence.output ? (webEvidence.output.valid ? "text-green-500" : "text-destructive") : "text-muted-foreground"}>
													{webEvidence.output
														? `${webEvidence.output.valid ? "Verified" : "Failed"}: PNG native markers ${webEvidence.output.images.png.nativeLibraryMarkersAbsent ? "absent" : "present"}, JPEG native markers ${webEvidence.output.images.jpeg.nativeLibraryMarkersAbsent ? "absent" : "present"}, ${webEvidence.output.wasm.files} Wasm file(s)`
														: `${webEvidence.plan.images.png.files} PNG and ${webEvidence.plan.images.jpeg.files} JPEG source asset(s); browser-native decoding boundary.`}
												</div>
											</>
										) : (
											<span className="text-muted-foreground">
												Build writes {"zvibe-web-build-manifest.json"} with independent module, Wasm, PNG, and JPEG evidence.
											</span>
										)}
									</div>
									<div className="text-xs font-medium text-muted-foreground">Progressive Web App</div>
									<div className="grid grid-cols-2 gap-2">
										<Input
											value={profile.settings?.pwa?.name ?? profile.settings?.productName ?? ""}
											placeholder="Manifest name"
											onChange={(event) => this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), name: event.target.value })}
										/>
										<Input
											value={profile.settings?.pwa?.shortName ?? ""}
											placeholder="Short name"
											onChange={(event) => this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), shortName: event.target.value })}
										/>
									</div>
									<div className="grid grid-cols-2 gap-2">
										<Input
											value={profile.settings?.pwa?.startUrl ?? profile.settings?.web?.basePath ?? "/"}
											placeholder="Start URL"
											onChange={(event) => this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), startUrl: event.target.value })}
										/>
										<select
											className="h-9 rounded-md border border-input bg-background px-2 text-sm"
											value={profile.settings?.pwa?.display ?? "standalone"}
											onChange={(event) => this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), display: event.target.value })}
										>
											<option value="standalone">Standalone</option>
											<option value="fullscreen">Fullscreen</option>
											<option value="minimal-ui">Minimal UI</option>
											<option value="browser">Browser</option>
										</select>
									</div>
									<div className="grid grid-cols-2 gap-2">
										<Input
											value={profile.settings?.pwa?.backgroundColor ?? "#000000"}
											placeholder="Background color (#000000)"
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), backgroundColor: event.target.value })
											}
										/>
										<Input
											value={profile.settings?.pwa?.themeColor ?? "#000000"}
											placeholder="Theme color (#000000)"
											onChange={(event) => this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), themeColor: event.target.value })}
										/>
									</div>
									<div className="flex gap-2">
										<Input
											value={profile.settings?.pwa?.manifestPath ?? "public/manifest.webmanifest"}
											placeholder="PWA manifest path"
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), manifestPath: event.target.value })
											}
										/>
										<Button size="sm" variant="secondary" onClick={() => void this._generatePwaManifest(profile.id)}>
											Generate PWA
										</Button>
									</div>
									<div className="grid grid-cols-2 gap-2">
										<Input
											value={profile.settings?.pwa?.serviceWorkerPath ?? "public/sw.js"}
											placeholder="Service worker path"
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), serviceWorkerPath: event.target.value })
											}
										/>
										<Input
											value={profile.settings?.pwa?.precacheUrls?.join(", ") ?? profile.settings?.pwa?.startUrl ?? profile.settings?.web?.basePath ?? "/"}
											placeholder="Precache URL paths (comma separated)"
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "pwa", {
													...(profile.settings?.pwa ?? {}),
													precacheUrls: event.target.value
														.split(",")
														.map((url) => url.trim())
														.filter(Boolean),
												})
											}
										/>
									</div>
									<div className="flex gap-2">
										<Input
											value={profile.settings?.pwa?.offlineFallbackUrl ?? profile.settings?.pwa?.startUrl ?? profile.settings?.web?.basePath ?? "/"}
											placeholder="Offline fallback URL path"
											onChange={(event) =>
												this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), offlineFallbackUrl: event.target.value })
											}
										/>
										<Button size="sm" variant="secondary" onClick={() => void this._generatePwaServiceWorker(profile.id)}>
											Generate Service Worker
										</Button>
										<Button size="sm" variant="secondary" onClick={() => void this._installPwaServiceWorkerRegistration(profile.id)}>
											Install Registration
										</Button>
									</div>
								</div>
							)}
							{profile.target === "electron" && (
								<div className="space-y-2 rounded-md border border-input p-2" data-testid="platform-player-settings">
									<div className="text-xs font-medium text-muted-foreground">Desktop Platform Player</div>
									<div className="grid grid-cols-2 gap-2">
										<select
											className="h-9 rounded-md border border-input bg-background px-2 text-sm"
											value={profile.settings?.electronPlatform ?? "darwin"}
											onChange={(event) => this._setBuildProfileSetting(profile, "electronPlatform", event.target.value)}
										>
											<option value="darwin">macOS</option>
											<option value="win32">Windows</option>
											<option value="linux">Linux</option>
										</select>
										<select
											className="h-9 rounded-md border border-input bg-background px-2 text-sm"
											value={profile.settings?.electronArch ?? "x64"}
											onChange={(event) => this._setBuildProfileSetting(profile, "electronArch", event.target.value)}
										>
											<option value="x64">x64</option>
											<option value="arm64">arm64</option>
										</select>
										<Input
											value={profile.settings?.electronIcon ?? ""}
											placeholder="Icon path (optional)"
											onChange={(event) => this._setBuildProfileSetting(profile, "electronIcon", event.target.value)}
										/>
										<label className="flex h-9 items-center gap-2 rounded-md border border-input px-2 text-sm">
											<input
												type="checkbox"
												checked={profile.settings?.electronAsar ?? true}
												onChange={(event) => this._setBuildProfileSetting(profile, "electronAsar", event.target.checked)}
											/>
											ASAR archive
										</label>
									</div>
									{profile.settings?.electronPlatform === "linux" && (
										<div className="grid grid-cols-3 gap-2" data-testid="linux-player-settings">
											<select
												className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												value={profile.settings?.platformPlayer?.linux?.variant ?? "desktop"}
												onChange={(event) => {
													const variant = event.target.value;
													const linux = profile.settings?.platformPlayer?.linux;
													this._setBuildProfileSetting(profile, "platformPlayer", {
														...(profile.settings?.platformPlayer ?? {}),
														linux: {
															...(linux ?? {}),
															variant,
															ime: variant === "embedded" && linux?.ime === "fcitx5" ? "ibus" : (linux?.ime ?? "ibus"),
														},
													});
												}}
											>
												<option value="desktop">Desktop Linux</option>
												<option value="embedded">Embedded Linux</option>
											</select>
											<select
												className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												value={profile.settings?.platformPlayer?.linux?.lto ?? "thin"}
												onChange={(event) =>
													this._setBuildProfileSetting(profile, "platformPlayer", {
														...(profile.settings?.platformPlayer ?? {}),
														linux: { ...(profile.settings?.platformPlayer?.linux ?? {}), lto: event.target.value },
													})
												}
											>
												<option value="thin">Thin LTO</option>
												<option value="full">Full LTO</option>
											</select>
											<select
												className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												value={profile.settings?.platformPlayer?.linux?.ime ?? "ibus"}
												onChange={(event) =>
													this._setBuildProfileSetting(profile, "platformPlayer", {
														...(profile.settings?.platformPlayer ?? {}),
														linux: { ...(profile.settings?.platformPlayer?.linux ?? {}), ime: event.target.value },
													})
												}
											>
												<option value="disabled">IME disabled</option>
												<option value="ibus">IBUS</option>
												{profile.settings?.platformPlayer?.linux?.variant !== "embedded" && <option value="fcitx5">FCITX5</option>}
											</select>
											<div className="col-span-3 text-xs text-muted-foreground">
												LTO applies to project native dependencies rebuilt by Electron packaging. IME environment is installed before Chromium starts.
											</div>
										</div>
									)}
									{profile.settings?.electronPlatform === "darwin" && (
										<div className="grid grid-cols-2 gap-2" data-testid="macos-frame-pacing-settings">
											<label className="flex h-9 items-center gap-2 rounded-md border border-input px-2 text-sm">
												<input
													type="checkbox"
													checked={profile.settings?.platformPlayer?.macos?.useDisplayLink ?? false}
													onChange={(event) =>
														this._setBuildProfileSetting(profile, "platformPlayer", {
															...(profile.settings?.platformPlayer ?? {}),
															macos: { ...(profile.settings?.platformPlayer?.macos ?? {}), useDisplayLink: event.target.checked },
														})
													}
												/>
												Use Display Link
											</label>
											<select
												className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												value={profile.settings?.platformPlayer?.macos?.maximumQueuedFrames ?? 2}
												onChange={(event) =>
													this._setBuildProfileSetting(profile, "platformPlayer", {
														...(profile.settings?.platformPlayer ?? {}),
														macos: { ...(profile.settings?.platformPlayer?.macos ?? {}), maximumQueuedFrames: Number(event.target.value) },
													})
												}
											>
												<option value={1}>1 queued frame</option>
												<option value={2}>2 queued frames</option>
												<option value={3}>3 queued frames</option>
											</select>
											<div className="col-span-2 text-xs text-muted-foreground">
												Electron uses display-synchronized Chromium frames; native CAMetalDisplayLink requires a registered host adapter.
											</div>
										</div>
									)}
									{profile.settings?.electronPlatform === "win32" && assetStreamingPlan && (
										<div className="space-y-2 rounded-md border border-input p-2" data-testid="windows-asset-streaming-settings">
											<label className="flex h-9 items-center gap-2 rounded-md border border-input px-2 text-sm">
												<input
													type="checkbox"
													checked={profile.settings?.assetStreaming?.windows?.enableDirectStorage ?? false}
													onChange={(event) => this._setWindowsAssetStreamingSetting(profile, "enableDirectStorage", event.target.checked)}
												/>
												Enable Direct Storage
											</label>
											<div className="grid grid-cols-3 gap-2">
												<label className="space-y-1 text-xs text-muted-foreground">
													Concurrent reads
													<Input
														type="number"
														min={1}
														max={64}
														defaultValue={profile.settings?.assetStreaming?.windows?.maximumConcurrentReads ?? 8}
														onBlur={(event) => this._setWindowsAssetStreamingSetting(profile, "maximumConcurrentReads", Number(event.target.value))}
													/>
												</label>
												<label className="space-y-1 text-xs text-muted-foreground">
													Queued requests
													<Input
														type="number"
														min={1}
														max={10000}
														defaultValue={profile.settings?.assetStreaming?.windows?.maximumQueuedRequests ?? 4096}
														onBlur={(event) => this._setWindowsAssetStreamingSetting(profile, "maximumQueuedRequests", Number(event.target.value))}
													/>
												</label>
												<label className="space-y-1 text-xs text-muted-foreground">
													Timeout (ms)
													<Input
														type="number"
														min={1000}
														max={120000}
														defaultValue={profile.settings?.assetStreaming?.windows?.requestTimeoutMs ?? 30000}
														onBlur={(event) => this._setWindowsAssetStreamingSetting(profile, "requestTimeoutMs", Number(event.target.value))}
													/>
												</label>
												<label className="space-y-1 text-xs text-muted-foreground">
													Chunk bytes
													<Input
														type="number"
														min={65536}
														max={4194304}
														step={65536}
														defaultValue={profile.settings?.assetStreaming?.windows?.chunkSizeBytes ?? 262144}
														onBlur={(event) => this._setWindowsAssetStreamingSetting(profile, "chunkSizeBytes", Number(event.target.value))}
													/>
												</label>
												<label className="col-span-2 space-y-1 text-xs text-muted-foreground">
													Maximum asset bytes
													<Input
														type="number"
														min={1024}
														max={2147483648}
														defaultValue={profile.settings?.assetStreaming?.windows?.maximumAssetBytes ?? 2147483648}
														onBlur={(event) => this._setWindowsAssetStreamingSetting(profile, "maximumAssetBytes", Number(event.target.value))}
													/>
												</label>
											</div>
											<div
												className={`rounded bg-input p-2 text-xs ${assetStreamingPlan.enabled ? "text-emerald-500" : "text-muted-foreground"}`}
												data-testid="windows-asset-streaming-evidence"
											>
												<div>
													{assetStreamingPlan.enabled ? "Portable async asset streams enabled" : "Disabled by default"} · {assetStreamingPlan.backend}
												</div>
												<div className="text-muted-foreground">
													Priority queue, bounded reads, ranges, cancellation, and diagnostics · native Microsoft DirectStorage/GPU decompression adapter
													not bundled
												</div>
											</div>
										</div>
									)}
								</div>
							)}
						</div>
					);
				})}
				{footerContext && footerActions.length > 0 && (
					<div className="space-y-2 rounded-lg border border-input p-2" data-testid="build-profile-extension-footer">
						<div className="text-xs font-medium text-muted-foreground">Extension actions for {activeProfile!.name}</div>
						<div className="flex flex-wrap gap-2">
							{footerActions.map((action) => (
								<Button
									key={`${action.packageName}:${action.id}`}
									size="sm"
									variant="secondary"
									title={action.description ?? `${action.title} (${action.packageName})`}
									onClick={() => void this._invokeBuildProfileFooterAction(action, footerContext)}
								>
									{action.title}
								</Button>
							))}
						</div>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getSerializationSessionComponent(): ReactNode {
		const diagnostics = getSerializationSessionDiagnostics({ limit: 8 });
		return (
			<EditorInspectorSectionField
				title="Serialization Session"
				tooltip="Read-only session evidence. The same oldest loaded serialized-file version is logged when this editor window closes."
			>
				<div className="space-y-2 text-xs" data-testid="serialization-session-diagnostics">
					<div>
						Revision {diagnostics.revision} · {diagnostics.loadedFileCount} files · {diagnostics.totalLoadCount} reads
					</div>
					{diagnostics.oldest ? (
						<div className="rounded bg-input p-2">
							<div>Oldest loaded version: {diagnostics.oldest.version}</div>
							<div className="truncate text-muted-foreground" title={diagnostics.oldest.path}>
								{diagnostics.oldest.path}
							</div>
							<div className="text-muted-foreground">
								{diagnostics.oldest.versionSource} · current {diagnostics.oldest.currentVersion}
							</div>
						</div>
					) : (
						<div className="text-muted-foreground">No serialized project files loaded in this session.</div>
					)}
					{diagnostics.entries.map((entry) => (
						<div key={entry.path} className="flex gap-2">
							<span>{entry.version}</span>
							<span className="truncate text-muted-foreground" title={entry.path}>
								{entry.path}
							</span>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getBuildReportsComponent(): ReactNode {
		const reports = listBuildReports(this.props.object).reports as any[];
		return (
			<EditorInspectorSectionField
				title="Build Reports"
				tooltip="The 50 latest versioned export/build/clean/cache reports, including stage timing, bounded command output, input/output fingerprints, and artifact hashes."
			>
				{reports.length === 0 && <div className="px-2 text-sm text-muted-foreground">No export or build reports recorded yet.</div>}
				{reports.slice(0, 5).map((report) => (
					<div key={report.id} className={`space-y-1 rounded-lg p-2 text-xs ${report.outcome === "failed" ? "bg-destructive/10" : "bg-muted-foreground/10"}`}>
						<div className="flex justify-between gap-2">
							<span className="font-medium">{report.profile ?? "Active scene export"}</span>
							<div className="flex items-center gap-2">
								<span className={report.outcome === "failed" ? "text-destructive" : "text-muted-foreground"}>{report.outcome ?? "exported"}</span>
								<Button size="sm" variant="ghost" className="h-5 px-1 text-xs" onClick={() => this._deleteBuildReport(report.id)}>
									Delete
								</Button>
							</div>
						</div>
						<div className="text-muted-foreground">
							{report.output?.fileCount ?? 0} files · {this._formatBuildBytes(report.output?.totalBytes ?? 0)} · {new Date(report.createdAt).toLocaleString()}
						</div>
						{report.commands?.length > 0 && <div className="truncate text-muted-foreground">{report.commands.join("; ")}</div>}
						{report.inputFingerprint?.sha256 && <div className="truncate text-muted-foreground">Input {report.inputFingerprint.sha256}</div>}
						{report.output?.outputFingerprint && <div className="truncate text-muted-foreground">Output {report.output.outputFingerprint}</div>}
						{report.stages?.map((stage: any, index: number) => (
							<div key={`${stage.name}-${index}`} className={stage.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
								{stage.name}: {stage.status} · {stage.durationMs} ms{stage.exitCode !== undefined ? ` · exit ${stage.exitCode}` : ""}
							</div>
						))}
						{report.warnings?.map((warning: string, index: number) => (
							<div key={index} className="text-amber-500">
								Warning: {warning}
							</div>
						))}
						{report.error && <div className="text-destructive">{report.error}</div>}
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _getSourceControlWorkspace65Component(): ReactNode {
		const workspace = this.state.sourceControlWorkspace;
		if (!workspace) {
			return <div className="px-2 text-[11px] text-muted-foreground">Unity 6.5-style Git workspace is loading…</div>;
		}
		const layout = workspace.layout;
		const selectedRef = this.state.sourceControlWorkspaceSelectedRef;
		return (
			<div
				className="space-y-2 rounded border border-border bg-background/60 p-2 text-xs"
				data-testid="source-control-65-workspace"
				tabIndex={0}
				onKeyDown={(event) => {
					if (event.key === "F2" && selectedRef) {
						event.preventDefault();
						this.setState({ sourceControlWorkspaceRenameEditing: true, sourceControlWorkspaceRenameValue: selectedRef.name });
					}
				}}
			>
				<div className="flex items-center justify-between gap-2">
					<div>
						<div className="font-medium">Version Control 6.5 Workspace</div>
						<div className="text-[10px] text-muted-foreground">Portable Git · exact fingerprint {workspace.workspaceFingerprint.slice(0, 8)}</div>
					</div>
					<Button size="sm" variant="outline" disabled={this.state.sourceControlBusy} onClick={() => void this._refreshSourceControlWorkspace()}>
						Refresh
					</Button>
				</div>
				<div className="grid grid-cols-3 gap-1">
					<Input
						value={this.state.sourceControlWorkspacePendingFilter}
						onChange={(event) => this.setState({ sourceControlWorkspacePendingFilter: event.target.value })}
						placeholder="Pending filter"
						aria-label="Pending Changes filter"
					/>
					<Input
						value={this.state.sourceControlWorkspaceIncomingFilter}
						onChange={(event) => this.setState({ sourceControlWorkspaceIncomingFilter: event.target.value })}
						placeholder="Incoming filter"
						aria-label="Incoming Changes filter"
					/>
					<Input
						value={this.state.sourceControlWorkspaceBranchFilter}
						onChange={(event) => this.setState({ sourceControlWorkspaceBranchFilter: event.target.value })}
						placeholder="Branch filter"
						aria-label="Branch Explorer filter"
					/>
				</div>
				<Button size="sm" variant="secondary" className="w-full" disabled={this.state.sourceControlBusy} onClick={() => void this._refreshSourceControlWorkspace()}>
					Apply Filters
				</Button>
				<div
					className="grid min-h-40 gap-1 overflow-hidden"
					style={{ gridTemplateColumns: `${layout.branchExplorerPercent}fr ${layout.changesPercent}fr ${layout.propertiesPercent}fr` }}
				>
					<div className="min-w-0 space-y-1 rounded bg-input/60 p-1">
						<div className="font-medium">Branch Explorer</div>
						<div className="max-h-40 overflow-auto">
							{workspace.branchExplorer.commits.map((commit: any) => (
								<button
									key={commit.hash}
									type="button"
									className="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-accent"
									title={`${commit.hash} · ${commit.author} · ${commit.date}`}
									onClick={() => void this._inspectSourceControlWorkspaceChangeset(commit.hash)}
								>
									● {commit.shortHash} {commit.subject}
								</button>
							))}
							{workspace.branchExplorer.emptyState && <div className="p-1 text-[10px] text-muted-foreground">{workspace.branchExplorer.emptyState}</div>}
						</div>
						<div className="border-t border-border pt-1 text-[10px] text-muted-foreground">Select a ref, then press F2 to rename.</div>
						{workspace.branchExplorer.refs.localBranches.slice(0, 20).map((branch: any) => (
							<button
								key={`workspace-branch:${branch.name}`}
								type="button"
								className={`block w-full truncate rounded px-1 text-left ${selectedRef?.kind === "branch" && selectedRef.name === branch.name ? "bg-accent" : ""}`}
								onClick={() => this.setState({ sourceControlWorkspaceSelectedRef: { kind: "branch", name: branch.name, hash: branch.hash } })}
							>
								{branch.current ? "●" : "○"} {branch.name}
							</button>
						))}
						{workspace.branchExplorer.refs.tags.slice(0, 20).map((tag: any) => (
							<button
								key={`workspace-label:${tag.name}`}
								type="button"
								className={`block w-full truncate rounded px-1 text-left ${selectedRef?.kind === "label" && selectedRef.name === tag.name ? "bg-accent" : ""}`}
								onClick={() => this.setState({ sourceControlWorkspaceSelectedRef: { kind: "label", name: tag.name, hash: tag.hash } })}
							>
								◇ {tag.name}
							</button>
						))}
					</div>
					<div className="min-w-0 space-y-1 rounded bg-input/60 p-1">
						<div className="font-medium">Pending Changes</div>
						{workspace.pending.changes.slice(0, 20).map((change: any) => (
							<div key={`workspace-pending:${change.index}${change.worktree}:${change.path}`} className="truncate" title={change.path}>
								{change.index}
								{change.worktree} {change.path}
							</div>
						))}
						{workspace.pending.emptyState && <div className="text-[10px] text-muted-foreground">{workspace.pending.emptyState}</div>}
						<div className="border-t border-border pt-1 font-medium">Incoming Changes</div>
						{workspace.incoming.commits.slice(0, 20).map((commit: any) => (
							<button
								key={`workspace-incoming:${commit.hash}`}
								type="button"
								className="block w-full truncate text-left"
								onClick={() => void this._inspectSourceControlWorkspaceChangeset(commit.hash)}
							>
								↓ {commit.shortHash} {commit.subject}
							</button>
						))}
						{workspace.incoming.emptyState && <div className="text-[10px] text-muted-foreground">{workspace.incoming.emptyState}</div>}
					</div>
					<div className="min-w-0 space-y-1 rounded bg-input/60 p-1">
						<div className="font-medium">Properties / Diff</div>
						{this.state.sourceControlWorkspaceChangeset ? (
							<>
								<div className="truncate" title={this.state.sourceControlWorkspaceChangeset.changeset.hash}>
									{this.state.sourceControlWorkspaceChangeset.changeset.shortHash} · {this.state.sourceControlWorkspaceChangeset.changeset.subject}
								</div>
								<div className="truncate text-[10px] text-muted-foreground">{this.state.sourceControlWorkspaceChangeset.changeset.author.name}</div>
								<pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[9px]">
									{this.state.sourceControlWorkspaceChangeset.diff || "No project-scoped diff."}
								</pre>
							</>
						) : (
							<div className="text-[10px] text-muted-foreground">Select a changeset or shelveset to inspect properties and its cset-by-cset diff.</div>
						)}
					</div>
				</div>
				<div className="grid grid-cols-3 gap-1">
					<Button size="sm" variant="outline" onClick={() => void this._saveSourceControlWorkspaceLayout(32, 43, 25)}>
						Balanced
					</Button>
					<Button size="sm" variant="outline" onClick={() => void this._saveSourceControlWorkspaceLayout(50, 30, 20)}>
						Graph Focus
					</Button>
					<Button size="sm" variant="outline" onClick={() => void this._saveSourceControlWorkspaceLayout(20, 55, 25)}>
						Changes Focus
					</Button>
				</div>
				<div className="space-y-1 border-t border-border pt-2">
					<div className="font-medium">Project Folder Actions</div>
					<Input
						value={this.state.sourceControlWorkspaceFolderPath}
						onChange={(event) => this.setState({ sourceControlWorkspaceFolderPath: event.target.value })}
						placeholder="Project folder (assets)"
						aria-label="Source-control project folder"
					/>
					<div className="grid grid-cols-2 gap-1">
						<Button size="sm" disabled={this.state.sourceControlBusy} onClick={() => void this._applySourceControlWorkspaceFolderAction("add")}>
							Add to Source Control
						</Button>
						<Button size="sm" variant="destructive" disabled={this.state.sourceControlBusy} onClick={() => void this._applySourceControlWorkspaceFolderAction("undo")}>
							Undo Changes…
						</Button>
					</div>
				</div>
				<div className="space-y-1 border-t border-border pt-2">
					<div className="font-medium">Shelvesets (Git stash)</div>
					<Input
						value={this.state.sourceControlWorkspaceShelvesetMessage}
						onChange={(event) => this.setState({ sourceControlWorkspaceShelvesetMessage: event.target.value })}
						placeholder="Shelveset message"
						aria-label="Shelveset message"
					/>
					<Button size="sm" className="w-full" disabled={this.state.sourceControlBusy} onClick={() => void this._createSourceControlWorkspaceShelveset()}>
						Create Retained Shelveset
					</Button>
					{workspace.shelvesets.entries.map((shelveset: any) => (
						<Button
							key={`workspace-shelveset:${shelveset.hash}`}
							size="sm"
							variant="ghost"
							className="h-auto w-full justify-start truncate px-1 text-left"
							onClick={() => void this._inspectSourceControlWorkspaceShelveset(shelveset.hash)}
						>
							▣ {shelveset.subject}
						</Button>
					))}
					{workspace.shelvesets.emptyState && <div className="text-[10px] text-muted-foreground">{workspace.shelvesets.emptyState}</div>}
					{this.state.sourceControlWorkspaceShelveset && (
						<>
							<Input
								value={this.state.sourceControlWorkspaceShelvesetPaths}
								onChange={(event) => this.setState({ sourceControlWorkspaceShelvesetPaths: event.target.value })}
								placeholder="Paths to apply (comma-separated)"
								aria-label="Partial shelveset paths"
							/>
							<div className="grid grid-cols-2 gap-1">
								<Button size="sm" disabled={this.state.sourceControlBusy} onClick={() => void this._applySourceControlWorkspaceShelveset()}>
									Apply Selected Paths…
								</Button>
								<Button size="sm" variant="destructive" disabled={this.state.sourceControlBusy} onClick={() => void this._deleteSourceControlWorkspaceShelveset()}>
									Delete Shelveset…
								</Button>
							</div>
						</>
					)}
				</div>
				{selectedRef && (
					<div className="space-y-1 border-t border-border pt-2">
						<div className="font-medium">
							Selected {selectedRef.kind}: {selectedRef.name} · {selectedRef.hash.slice(0, 8)}
						</div>
						{this.state.sourceControlWorkspaceRenameEditing ? (
							<div className="grid grid-cols-[1fr_auto_auto] gap-1">
								<Input
									autoFocus
									value={this.state.sourceControlWorkspaceRenameValue}
									onChange={(event) => this.setState({ sourceControlWorkspaceRenameValue: event.target.value })}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											void this._renameSourceControlWorkspaceRef();
										}
										if (event.key === "Escape") {
											this.setState({ sourceControlWorkspaceRenameEditing: false });
										}
									}}
									aria-label="Rename selected Git ref"
								/>
								<Button size="sm" onClick={() => void this._renameSourceControlWorkspaceRef()}>
									Rename
								</Button>
								<Button size="sm" variant="ghost" onClick={() => this.setState({ sourceControlWorkspaceRenameEditing: false })}>
									Cancel
								</Button>
							</div>
						) : (
							<Button
								size="sm"
								variant="outline"
								onClick={() => this.setState({ sourceControlWorkspaceRenameEditing: true, sourceControlWorkspaceRenameValue: selectedRef.name })}
							>
								Rename (F2)
							</Button>
						)}
					</div>
				)}
				<div className="text-[10px] text-muted-foreground">
					Git portability layer; it does not claim Unity Version Control service identity. Remote views use the last fetched tracking refs.
				</div>
			</div>
		);
	}

	private _getSourceControlComponent(): ReactNode {
		const status = this.state.sourceControlStatus;
		return (
			<EditorInspectorSectionField
				title="Source Control"
				tooltip="Project-scoped Git status, diff, staging, commits, non-force push, fetch, fast-forward-only pull, and local branch/tag management. Repository-wide worktree changes require a clean root-owned project. Collaboration editors may stage; repository administration requires an admin."
			>
				<Button
					size="sm"
					variant="secondary"
					className="w-full"
					disabled={this.state.sourceControlBusy}
					onClick={() => {
						this._refreshSourceControlStatus();
						this._refreshSourceControlHistory();
						this._refreshSourceControlRefs();
						void this._refreshSourceControlWorkspace();
					}}
				>
					Refresh Git Status
				</Button>
				{this._getSourceControlWorkspace65Component()}
				{this.state.sourceControlError && <div className="px-2 text-xs text-destructive">{this.state.sourceControlError}</div>}
				{this.state.sourceControlResult && <div className="rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-500">{this.state.sourceControlResult}</div>}
				{status && (
					<div className="space-y-2 px-2 text-xs">
						<div className="flex justify-between gap-2">
							<span className="font-medium">{status.branch}</span>
							<span className={status.clean ? "text-emerald-500" : "text-amber-500"}>
								{status.clean ? "Clean" : `${status.changeCount} change${status.changeCount === 1 ? "" : "s"}`}
							</span>
						</div>
						{!status.clean && (
							<div className="grid grid-cols-2 gap-2">
								<Button
									size="sm"
									disabled={this.state.sourceControlBusy || status.unstagedCount === 0}
									onClick={() => void this._stageSourceControl(undefined, true)}
								>
									Stage All ({status.unstagedCount})
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={this.state.sourceControlBusy || status.stagedCount === 0}
									onClick={() => void this._unstageSourceControl(undefined, true)}
								>
									Unstage All ({status.stagedCount})
								</Button>
							</div>
						)}
						{status.changes.slice(0, 20).map((change) => (
							<div key={`${change.index}${change.worktree}${change.path}`} className="grid grid-cols-[1fr_auto] items-center gap-1">
								<Button
									size="sm"
									variant="ghost"
									className="h-auto min-w-0 justify-start truncate px-0 text-xs text-muted-foreground"
									onClick={() => this._getSourceControlDiff(change.path, ![" ", "?"].includes(change.index))}
								>
									{change.index}
									{change.worktree} {change.path}
								</Button>
								{![" ", "?"].includes(change.index) && change.worktree === " " ? (
									<Button size="sm" variant="secondary" disabled={this.state.sourceControlBusy} onClick={() => void this._unstageSourceControl(change.path)}>
										Unstage
									</Button>
								) : (
									<Button size="sm" disabled={this.state.sourceControlBusy} onClick={() => void this._stageSourceControl(change.path)}>
										Stage
									</Button>
								)}
							</div>
						))}
						{status.changeCount > 20 && <div className="text-muted-foreground">…and {status.changeCount - 20} more</div>}
						{status.truncated && <div className="text-amber-500">Status is limited to the first 2,000 paths.</div>}
					</div>
				)}
				<div className="space-y-2 px-2 pt-2">
					<Textarea
						value={this.state.sourceControlCommitMessage}
						onChange={(event) => this.setState({ sourceControlCommitMessage: event.target.value })}
						placeholder="Commit message"
						aria-label="Git commit message"
					/>
					<Button
						size="sm"
						className="w-full"
						disabled={this.state.sourceControlBusy || !this.state.sourceControlCommitMessage.trim() || !status?.stagedCount}
						onClick={() => void this._commitSourceControl()}
					>
						Commit Staged Changes
					</Button>
					<div className="grid grid-cols-2 gap-2">
						<Input
							value={this.state.sourceControlRemote}
							onChange={(event) => this.setState({ sourceControlRemote: event.target.value, sourceControlAuthentication: null })}
							placeholder="Remote (origin)"
							aria-label="Git remote"
						/>
						<Input
							value={this.state.sourceControlBranch}
							onChange={(event) => this.setState({ sourceControlBranch: event.target.value })}
							placeholder="Current branch"
							aria-label="Git branch"
						/>
					</div>
					<Button size="sm" variant="outline" className="w-full" disabled={this.state.sourceControlBusy} onClick={() => void this._inspectSourceControlAuthentication()}>
						Diagnose Authentication
					</Button>
					{this.state.sourceControlAuthentication && (
						<div className="space-y-1 rounded bg-input p-2 text-xs">
							<div className="flex justify-between gap-2 font-medium">
								<span>Credential readiness</span>
								<span
									className={
										this.state.sourceControlAuthentication.status === "ready"
											? "text-emerald-500"
											: this.state.sourceControlAuthentication.status === "attention"
												? "text-destructive"
												: "text-amber-500"
									}
								>
									{this.state.sourceControlAuthentication.status}
								</span>
							</div>
							<div className="text-muted-foreground">
								Fetch: {this.state.sourceControlAuthentication.fetch.transports.join(", ") || "none"} · Push:{" "}
								{this.state.sourceControlAuthentication.push.transports.join(", ") || "none"}
							</div>
							<div className="text-muted-foreground">
								HTTPS helpers: {this._sourceControlAuthenticationHelperKinds().join(", ") || "none"} · SSH agent:{" "}
								{this.state.sourceControlAuthentication.environment.sshAgent.socketAvailable ? "available" : "not available"}
							</div>
							{this.state.sourceControlAuthentication.issues.map((issue: any) => (
								<div key={issue.code} className={issue.severity === "error" ? "text-destructive" : "text-amber-500"}>
									{issue.message}
								</div>
							))}
							<div className="text-[10px] text-muted-foreground">Local inspection only; no remote or credential provider was contacted.</div>
						</div>
					)}
					<Button size="sm" variant="secondary" className="w-full" disabled={this.state.sourceControlBusy} onClick={() => void this._pushSourceControl()}>
						Push Without Force
					</Button>
					<div className="grid grid-cols-2 gap-2">
						<Button size="sm" variant="secondary" disabled={this.state.sourceControlBusy} onClick={() => void this._fetchSourceControl()}>
							Fetch
						</Button>
						<Button size="sm" variant="secondary" disabled={this.state.sourceControlBusy} onClick={() => void this._pullSourceControl()}>
							Pull (FF Only)
						</Button>
					</div>
				</div>
				<div className="space-y-2 px-2 pt-2">
					<div className="text-xs font-medium">Merge, rebase, and conflicts</div>
					<Input
						value={this.state.sourceControlIntegrationTarget}
						onChange={(event) => this.setState({ sourceControlIntegrationTarget: event.target.value })}
						placeholder="Target branch, tag, or commit"
						aria-label="Git integration target"
					/>
					<div className="grid grid-cols-3 gap-2">
						<Button
							size="sm"
							variant="secondary"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlIntegrationTarget.trim()}
							onClick={() => void this._previewSourceControlIntegration()}
						>
							Preview
						</Button>
						<Button
							size="sm"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlIntegrationTarget.trim()}
							onClick={() => void this._startSourceControlMerge()}
						>
							Merge
						</Button>
						<Button
							size="sm"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlIntegrationTarget.trim()}
							onClick={() => void this._startSourceControlRebase()}
						>
							Rebase
						</Button>
					</div>
					{this.state.sourceControlIntegrationPreview && (
						<div className="rounded bg-input p-2 text-xs text-muted-foreground">
							<div className="font-medium text-foreground">{this.state.sourceControlIntegrationPreview.relationship}</div>
							<div>
								Current-only {this.state.sourceControlIntegrationPreview.currentOnly} · Target-only {this.state.sourceControlIntegrationPreview.targetOnly} ·{" "}
								{this.state.sourceControlIntegrationPreview.changedFileCount} project files
							</div>
							{!this.state.sourceControlIntegrationPreview.projectOwnsWorktree && (
								<div className="text-amber-500">Preview only: integration requires the project directory to own the Git worktree root.</div>
							)}
						</div>
					)}
					{this.state.sourceControlIntegrationState?.operation && (
						<div className="space-y-2 rounded bg-amber-500/10 p-2 text-xs">
							<div className="font-medium">
								{this.state.sourceControlIntegrationState.operation} in progress · {this.state.sourceControlIntegrationState.conflictCount} unresolved
							</div>
							{this.state.sourceControlIntegrationState.conflicts.slice(0, 10).map((conflict: any) => (
								<div key={conflict.path} className="space-y-1 rounded bg-background/60 p-1">
									<div className="flex items-center gap-1">
										<div className="min-w-0 flex-1 truncate" title={conflict.path}>
											{conflict.path}
										</div>
										<Button
											size="sm"
											variant="outline"
											disabled={this.state.sourceControlBusy}
											onClick={() => void this._inspectSourceControlConflictDetails(conflict.path)}
										>
											Three-way
										</Button>
										{(/\.prefab$/i.test(conflict.path) || /\.scene\/.*\.json$/i.test(conflict.path)) && (
											<Button
												size="sm"
												variant="outline"
												disabled={this.state.sourceControlBusy}
												onClick={() => void this._inspectSourceControlSemanticConflict(conflict.path)}
											>
												Semantic
											</Button>
										)}
									</div>
									<div className="grid grid-cols-4 gap-1">
										<Button
											size="sm"
											variant="secondary"
											disabled={this.state.sourceControlBusy}
											onClick={() => void this._resolveSourceControlConflict(conflict.path, "ours")}
										>
											Ours
										</Button>
										<Button
											size="sm"
											variant="secondary"
											disabled={this.state.sourceControlBusy}
											onClick={() => void this._resolveSourceControlConflict(conflict.path, "theirs")}
										>
											Theirs
										</Button>
										<Button
											size="sm"
											variant="destructive"
											disabled={this.state.sourceControlBusy}
											onClick={() => void this._resolveSourceControlConflict(conflict.path, "delete")}
										>
											Delete
										</Button>
										<Button
											size="sm"
											disabled={this.state.sourceControlBusy}
											onClick={() => void this._resolveSourceControlConflict(conflict.path, "markResolved")}
										>
											Mark
										</Button>
									</div>
								</div>
							))}
							{this.state.sourceControlIntegrationState.conflictCount > 10 && (
								<div className="text-muted-foreground">
									…and {this.state.sourceControlIntegrationState.conflictCount - 10} more conflicts available through MCP.
								</div>
							)}
							{this.state.sourceControlIntegrationState.operation === "rebase" && (
								<div className="text-muted-foreground">During rebase, ours is the upstream/onto side and theirs is the commit being replayed.</div>
							)}
							{this.state.sourceControlConflictDetails && (
								<div className="space-y-2 rounded border border-border bg-background/70 p-2">
									<div className="flex items-center gap-2">
										<div className="min-w-0 flex-1">
											<div className="truncate font-medium" title={this.state.sourceControlConflictDetails.path}>
												Three-way · {this.state.sourceControlConflictDetails.path}
											</div>
											<div className="truncate font-mono text-[10px] text-muted-foreground" title={this.state.sourceControlConflictDetails.fingerprint}>
												Fingerprint {this.state.sourceControlConflictDetails.fingerprint}
											</div>
										</div>
										<Button
											size="sm"
											variant="ghost"
											onClick={() =>
												this.setState({ sourceControlConflictDetails: null, sourceControlConflictCustomText: "", sourceControlImageConflict: null })
											}
										>
											Close
										</Button>
									</div>
									<div className="grid gap-2 xl:grid-cols-3">
										{this._renderSourceControlConflictPreview("Base", this.state.sourceControlConflictDetails.base)}
										{this._renderSourceControlConflictPreview("Ours", this.state.sourceControlConflictDetails.ours)}
										{this._renderSourceControlConflictPreview("Theirs", this.state.sourceControlConflictDetails.theirs)}
									</div>
									{this._renderSourceControlConflictPreview("Current worktree / conflict markers", this.state.sourceControlConflictDetails.worktree)}
									<Button
										size="sm"
										variant="outline"
										className="w-full"
										disabled={this.state.sourceControlBusy}
										onClick={() => void this._inspectSourceControlImageConflict()}
									>
										Inspect Raster Images
									</Button>
									{this.state.sourceControlImageConflict && (
										<div className="space-y-2 rounded bg-input/60 p-2">
											<div className="font-medium">Raster conflict comparison</div>
											<div className="grid gap-2 xl:grid-cols-3">
												{this._renderSourceControlImageConflictStage("Base", this.state.sourceControlImageConflict.base)}
												{this._renderSourceControlImageConflictStage("Ours", this.state.sourceControlImageConflict.ours)}
												{this._renderSourceControlImageConflictStage("Theirs", this.state.sourceControlImageConflict.theirs)}
											</div>
											<div className="grid gap-2 xl:grid-cols-3">
												{this._renderSourceControlImageConflictComparison(this.state.sourceControlImageConflict.comparisons.baseToOurs)}
												{this._renderSourceControlImageConflictComparison(this.state.sourceControlImageConflict.comparisons.baseToTheirs)}
												{this._renderSourceControlImageConflictComparison(this.state.sourceControlImageConflict.comparisons.oursToTheirs)}
											</div>
										</div>
									)}
									<Textarea
										value={this.state.sourceControlConflictCustomText}
										onChange={(event) => this.setState({ sourceControlConflictCustomText: event.target.value })}
										disabled={this.state.sourceControlBusy || !this.state.sourceControlConflictDetails.textEditable}
										placeholder="Enter the reviewed UTF-8 resolution"
										aria-label="Custom Git conflict resolution"
										className="min-h-32 font-mono text-[11px]"
									/>
									{!this.state.sourceControlConflictDetails.textEditable && (
										<div className="text-amber-500">Custom editing is unavailable because a stage is binary or exceeds the 256 KiB preview limit.</div>
									)}
									<Button
										size="sm"
										className="w-full"
										disabled={this.state.sourceControlBusy || !this.state.sourceControlConflictDetails.textEditable}
										onClick={() => void this._applySourceControlTextResolution()}
									>
										Apply Reviewed Text
									</Button>
								</div>
							)}
							{this.state.sourceControlSemanticConflict && (
								<div className="space-y-2 rounded border border-border bg-background/70 p-2">
									<div className="flex items-center justify-between gap-2">
										<div className="min-w-0">
											<div className="truncate font-medium" title={this.state.sourceControlSemanticConflict.path}>
												Semantic merge · {this.state.sourceControlSemanticConflict.path}
											</div>
											<div className="text-[10px] text-muted-foreground">
												{this.state.sourceControlSemanticConflict.merge.summary.automaticMerges} automatic ·{" "}
												{this.state.sourceControlSemanticConflict.merge.summary.resolvedConflicts} resolved ·{" "}
												{this.state.sourceControlSemanticConflict.merge.summary.unresolvedConflicts} unresolved
											</div>
										</div>
										<Button
											size="sm"
											variant="ghost"
											onClick={() => this.setState({ sourceControlSemanticConflict: null, sourceControlSemanticConflictResolutions: [] })}
										>
											Close
										</Button>
									</div>
									<div className="max-h-64 space-y-1 overflow-auto">
										{this.state.sourceControlSemanticConflict.merge.conflicts.map((conflict: any) => (
											<div key={`${conflict.file}:${conflict.path}`} className="space-y-1 rounded bg-input/60 p-2">
												<div className="truncate" title={`${conflict.file}${conflict.path}`}>
													{conflict.file} · {conflict.path}
												</div>
												<div className="break-all text-[10px] text-muted-foreground">
													base {conflict.base?.preview ?? "deleted"} · ours {conflict.ours?.preview ?? "deleted"} · theirs{" "}
													{conflict.theirs?.preview ?? "deleted"}
												</div>
												<div className="grid grid-cols-4 gap-1">
													{(["base", "ours", "theirs", "delete"] as const).map((choice) => (
														<Button
															key={choice}
															size="sm"
															className="h-6 px-1 text-xs"
															variant={conflict.resolution === choice ? "default" : "secondary"}
															onClick={() => this._setSourceControlSemanticResolution(conflict, choice)}
														>
															{choice}
														</Button>
													))}
												</div>
											</div>
										))}
									</div>
									<Button
										size="sm"
										className="w-full"
										disabled={this.state.sourceControlBusy || this.state.sourceControlSemanticConflict.merge.summary.unresolvedConflicts > 0}
										onClick={() => void this._applySourceControlSemanticConflict()}
									>
										Apply and Stage Semantic Merge
									</Button>
								</div>
							)}
							<div className="grid grid-cols-2 gap-2">
								<Button
									size="sm"
									disabled={
										this.state.sourceControlBusy ||
										this.state.sourceControlIntegrationState.conflictCount > 0 ||
										(this.state.sourceControlIntegrationState.operation === "merge" && !this.state.sourceControlCommitMessage.trim())
									}
									onClick={() => void this._continueSourceControlIntegration()}
								>
									Continue
								</Button>
								<Button size="sm" variant="destructive" disabled={this.state.sourceControlBusy} onClick={() => void this._abortSourceControlIntegration()}>
									Abort
								</Button>
							</div>
						</div>
					)}
				</div>
				<div className="space-y-2 px-2 pt-2">
					<div className="text-xs font-medium">Authoritative remote refs</div>
					<Input
						value={this.state.sourceControlRemoteRefName}
						onChange={(event) => this.setState({ sourceControlRemoteRefName: event.target.value })}
						placeholder="Remote branch name (defaults to local)"
						aria-label="Remote Git ref name"
					/>
					<Button size="sm" variant="secondary" className="w-full" disabled={this.state.sourceControlBusy} onClick={() => void this._inspectSourceControlRemoteRefs()}>
						Inspect Remote Refs
					</Button>
					{this.state.sourceControlRemoteRefs && (
						<div className="space-y-1 rounded bg-input p-2 text-xs text-muted-foreground">
							<div>
								Default {this.state.sourceControlRemoteRefs.defaultBranch ?? "unknown"} · {this.state.sourceControlRemoteRefs.branchCount} branches ·{" "}
								{this.state.sourceControlRemoteRefs.tagCount} tags
							</div>
							<div className="max-h-24 overflow-auto text-[11px]">
								{this.state.sourceControlRemoteRefs.branches.map((branch: any) => (
									<div key={`branch:${branch.name}`} className="truncate" title={branch.hash}>
										○ {branch.name} · {branch.hash.slice(0, 8)}
									</div>
								))}
								{this.state.sourceControlRemoteRefs.tags.map((tag: any) => (
									<div key={`tag:${tag.name}`} className="truncate" title={tag.hash}>
										◇ {tag.name} · {tag.hash.slice(0, 8)}
									</div>
								))}
							</div>
						</div>
					)}
					<div className="grid grid-cols-2 gap-2">
						<Button
							size="sm"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlBranch.trim()}
							onClick={() => void this._publishSourceControlRemoteBranch()}
						>
							Publish Branch
						</Button>
						<Button
							size="sm"
							variant="destructive"
							disabled={
								this.state.sourceControlBusy ||
								!this._selectedSourceControlRemoteBranch() ||
								this._selectedSourceControlRemoteBranch()?.name === this.state.sourceControlRemoteRefs?.defaultBranch
							}
							onClick={() => void this._deleteSourceControlRemoteBranch()}
						>
							Delete Remote Branch
						</Button>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Button
							size="sm"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlTagName.trim()}
							onClick={() => void this._publishSourceControlRemoteTag()}
						>
							Publish Tag
						</Button>
						<Button
							size="sm"
							variant="destructive"
							disabled={this.state.sourceControlBusy || !this._selectedSourceControlRemoteTag()}
							onClick={() => void this._deleteSourceControlRemoteTag()}
						>
							Delete Remote Tag
						</Button>
					</div>
					<div className="text-[11px] text-muted-foreground">
						Remote deletion uses the exact inspected hash as a force-with-lease and refuses the advertised default branch.
					</div>
				</div>
				<div className="space-y-2 px-2 pt-2">
					<div className="text-xs font-medium">Hosted pull / merge requests</div>
					<div className="grid grid-cols-2 gap-2">
						<select
							value={this.state.sourceControlReviewProviderType}
							onChange={(event) => {
								const provider = event.target.value as "github" | "gitlab" | "bitbucket" | "azure";
								this.setState({
									sourceControlReviewProviderType: provider,
									sourceControlReviewApiBaseUrl:
										provider === "github"
											? "https://api.github.com/"
											: provider === "gitlab"
												? "https://gitlab.com/api/v4/"
												: provider === "bitbucket"
													? "https://api.bitbucket.org/2.0/"
													: "https://dev.azure.com/",
									sourceControlReviewTokenEnvironmentVariable:
										provider === "github"
											? "GITHUB_TOKEN"
											: provider === "gitlab"
												? "GITLAB_TOKEN"
												: provider === "bitbucket"
													? "BITBUCKET_TOKEN"
													: "AZURE_DEVOPS_PAT",
									sourceControlReviewAuthenticationMode: provider === "azure" ? "pat" : "provider",
								});
							}}
							className="h-9 rounded-md border border-input bg-background px-3 text-xs"
							aria-label="Hosted review provider"
						>
							<option value="github">GitHub</option>
							<option value="gitlab">GitLab</option>
							<option value="bitbucket">Bitbucket Cloud</option>
							<option value="azure">Azure DevOps</option>
						</select>
						<Input
							value={this.state.sourceControlReviewRepository}
							onChange={(event) => this.setState({ sourceControlReviewRepository: event.target.value })}
							placeholder={this.state.sourceControlReviewProviderType === "azure" ? "organization/project/repository" : "owner/repository"}
							aria-label="Hosted review repository"
						/>
					</div>
					<Input
						value={this.state.sourceControlReviewApiBaseUrl}
						onChange={(event) => this.setState({ sourceControlReviewApiBaseUrl: event.target.value })}
						placeholder="Provider API base URL"
						aria-label="Hosted review API base URL"
					/>
					{this.state.sourceControlReviewProviderType === "azure" && (
						<select
							value={this.state.sourceControlReviewAuthenticationMode}
							onChange={(event) => this.setState({ sourceControlReviewAuthenticationMode: event.target.value as "pat" | "bearer" })}
							className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
							aria-label="Azure DevOps authentication mode"
						>
							<option value="pat">Environment PAT (Basic)</option>
							<option value="bearer">Environment token (Bearer)</option>
						</select>
					)}
					<Input
						value={this.state.sourceControlReviewTokenEnvironmentVariable}
						onChange={(event) => this.setState({ sourceControlReviewTokenEnvironmentVariable: event.target.value })}
						placeholder="GITHUB_TOKEN"
						aria-label="Hosted review token environment variable"
					/>
					<div className="grid grid-cols-3 gap-2">
						<Button size="sm" variant="outline" disabled={this.state.sourceControlBusy} onClick={() => void this._refreshSourceControlReviewProvider()}>
							Load
						</Button>
						<Button
							size="sm"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlReviewRepository.trim()}
							onClick={() => void this._saveSourceControlReviewProvider(true)}
						>
							Enable
						</Button>
						<Button size="sm" variant="destructive" disabled={this.state.sourceControlBusy} onClick={() => void this._saveSourceControlReviewProvider(false)}>
							Disable
						</Button>
					</div>
					{this.state.sourceControlReviewProvider && (
						<div className="rounded bg-input p-2 text-[11px] text-muted-foreground">
							{this.state.sourceControlReviewProvider.enabled ? "Enabled" : "Disabled"} · {this.state.sourceControlReviewProvider.provider} · token environment{" "}
							{this.state.sourceControlReviewProvider.tokenConfigured ? "available" : "missing"}
						</div>
					)}
					<Button
						size="sm"
						variant="secondary"
						className="w-full"
						disabled={this.state.sourceControlBusy || !this.state.sourceControlReviewProvider?.enabled}
						onClick={() => void this._listSourceControlReviews()}
					>
						Refresh Open Reviews
					</Button>
					{this.state.sourceControlReviews.length > 0 && (
						<div className="max-h-40 space-y-1 overflow-auto rounded bg-input p-1 text-xs">
							{this.state.sourceControlReviews.map((review: any) => (
								<Button
									key={review.number}
									size="sm"
									variant="ghost"
									className="h-auto w-full justify-start px-1 text-left"
									onClick={() => void this._inspectSourceControlReview(review.number)}
								>
									#{review.number} · {review.title} · {review.head.ref} → {review.base.ref}
								</Button>
							))}
						</div>
					)}
					<div className="grid grid-cols-2 gap-2">
						<Input
							value={this.state.sourceControlReviewNumber}
							onChange={(event) => this.setState({ sourceControlReviewNumber: event.target.value })}
							placeholder="Review #"
							aria-label="Hosted review number"
						/>
						<Button
							size="sm"
							variant="outline"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlReviewNumber}
							onClick={() => void this._inspectSourceControlReview()}
						>
							Inspect
						</Button>
					</div>
					{this.state.sourceControlReviewDetail && (
						<div className="space-y-1 rounded bg-input p-2 text-xs">
							<div className="font-medium">
								#{this.state.sourceControlReviewDetail.number} · {this.state.sourceControlReviewDetail.title}
							</div>
							<div className="text-muted-foreground">
								{this.state.sourceControlReviewDetail.state} · {this.state.sourceControlReviewDetail.head.ref} → {this.state.sourceControlReviewDetail.base.ref} ·{" "}
								{this.state.sourceControlReviewDetail.head.sha.slice(0, 8)}
							</div>
							<div className="grid grid-cols-4 gap-1">
								<Button size="sm" disabled={this.state.sourceControlBusy} onClick={() => void this._submitSourceControlReview("approve")}>
									Approve
								</Button>
								<Button size="sm" variant="secondary" disabled={this.state.sourceControlBusy} onClick={() => void this._submitSourceControlReview("comment")}>
									Comment
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={this.state.sourceControlBusy}
									onClick={() => void this._submitSourceControlReview("requestChanges")}
								>
									Changes
								</Button>
								<Button size="sm" variant="destructive" disabled={this.state.sourceControlBusy} onClick={() => void this._mergeSourceControlReview()}>
									Merge
								</Button>
							</div>
							<div className="grid grid-cols-2 gap-1">
								<Button size="sm" variant="outline" disabled={this.state.sourceControlBusy} onClick={() => void this._inspectSourceControlReviewMetadata()}>
									Load Metadata
								</Button>
								<Button size="sm" variant="outline" disabled={this.state.sourceControlBusy} onClick={() => void this._inspectSourceControlReviewChecks()}>
									Load Checks
								</Button>
							</div>
							{this.state.sourceControlReviewMetadata && (
								<div className="space-y-1 border-t border-border pt-1">
									<Input
										value={this.state.sourceControlReviewReviewers}
										onChange={(event) => this.setState({ sourceControlReviewReviewers: event.target.value })}
										placeholder="Reviewers (comma-separated)"
									/>
									<Input
										value={this.state.sourceControlReviewTeams}
										onChange={(event) => this.setState({ sourceControlReviewTeams: event.target.value })}
										placeholder="GitHub teams (comma-separated)"
									/>
									<Input
										value={this.state.sourceControlReviewLabels}
										onChange={(event) => this.setState({ sourceControlReviewLabels: event.target.value })}
										placeholder="Labels (comma-separated)"
									/>
									<Button size="sm" disabled={this.state.sourceControlBusy} onClick={() => void this._replaceSourceControlReviewMetadata()}>
										Replace Assignments / Labels
									</Button>
								</div>
							)}
							{this.state.sourceControlReviewChecks && (
								<div className="space-y-1 border-t border-border pt-1">
									<div className="text-muted-foreground">
										{this.state.sourceControlReviewChecks.summary.total} results · {this.state.sourceControlReviewChecks.summary.succeeded} passed ·{" "}
										{this.state.sourceControlReviewChecks.summary.failed} failed · {this.state.sourceControlReviewChecks.summary.pending} pending
									</div>
									{this.state.sourceControlReviewChecks.runs.slice(0, 10).map((run: any) => (
										<button
											key={run.id}
											type="button"
											className="block w-full truncate rounded bg-background px-2 py-1 text-left hover:bg-accent"
											onClick={() => this.setState({ sourceControlReviewRunId: String(run.id) })}
										>
											#{run.id} · {run.name} · {run.conclusion ?? run.status}
										</button>
									))}
									<div className="grid grid-cols-3 gap-1">
										<Input
											value={this.state.sourceControlReviewRunId}
											onChange={(event) => this.setState({ sourceControlReviewRunId: event.target.value })}
											placeholder="Run ID"
										/>
										<select
											value={this.state.sourceControlReviewRerunMode}
											onChange={(event) => this.setState({ sourceControlReviewRerunMode: event.target.value as "failed" | "all" })}
											className="h-9 rounded-md border border-input bg-background px-2 text-xs"
											aria-label="Hosted review check rerun mode"
										>
											<option value="failed">Failed</option>
											<option value="all">All</option>
										</select>
										<Button
											size="sm"
											disabled={this.state.sourceControlBusy || !this.state.sourceControlReviewRunId}
											onClick={() => void this._rerunSourceControlReviewChecks()}
										>
											Rerun
										</Button>
									</div>
								</div>
							)}
						</div>
					)}
					<div className="grid grid-cols-2 gap-2">
						<Input
							value={this.state.sourceControlReviewHead}
							onChange={(event) => this.setState({ sourceControlReviewHead: event.target.value })}
							placeholder="Head branch"
						/>
						<Input
							value={this.state.sourceControlReviewBase}
							onChange={(event) => this.setState({ sourceControlReviewBase: event.target.value })}
							placeholder="Base branch"
						/>
					</div>
					<Input
						value={this.state.sourceControlReviewTitle}
						onChange={(event) => this.setState({ sourceControlReviewTitle: event.target.value })}
						placeholder="Review title"
					/>
					<Textarea
						value={this.state.sourceControlReviewBody}
						onChange={(event) => this.setState({ sourceControlReviewBody: event.target.value })}
						placeholder="Review body / comment"
					/>
					<div className="grid grid-cols-2 gap-2">
						<Button
							size="sm"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlReviewTitle.trim() || !this.state.sourceControlReviewHead.trim()}
							onClick={() => void this._createSourceControlReview()}
						>
							Create Review
						</Button>
						<select
							value={this.state.sourceControlReviewMergeMethod}
							onChange={(event) => this.setState({ sourceControlReviewMergeMethod: event.target.value as "merge" | "squash" | "rebase" })}
							className="h-9 rounded-md border border-input bg-background px-3 text-xs"
							aria-label="Hosted review merge method"
						>
							<option value="squash">Squash merge</option>
							<option value="merge">Merge commit</option>
							<option value="rebase">Rebase merge</option>
						</select>
					</div>
					<div className="text-[10px] text-muted-foreground">Provider tokens are read from the named environment variable and are never stored by the project.</div>
				</div>
				{this.state.sourceControlRefs && (
					<div className="space-y-2 px-2 pt-2 text-xs">
						<div className="font-medium">Branches and tags</div>
						<div className="text-muted-foreground">
							{this.state.sourceControlRefs.currentBranch ?? "Detached HEAD"}
							{this.state.sourceControlRefs.upstream
								? ` · ${this.state.sourceControlRefs.upstream} · ↑${this.state.sourceControlRefs.ahead} ↓${this.state.sourceControlRefs.behind}`
								: " · no upstream"}
						</div>
						<div className="text-muted-foreground">
							{this.state.sourceControlRefs.localBranches.length} local · {this.state.sourceControlRefs.remoteBranches.length} remote ·{" "}
							{this.state.sourceControlRefs.tags.length} tags
						</div>
						<div className="max-h-24 overflow-auto rounded bg-input p-2 text-[11px] text-muted-foreground">
							{this.state.sourceControlRefs.localBranches.map((branch) => (
								<div key={branch.name} className="truncate">
									{branch.current ? "●" : "○"} {branch.name}
								</div>
							))}
							{this.state.sourceControlRefs.tags.map((tag) => (
								<div key={tag.name} className="truncate">
									◇ {tag.name}
								</div>
							))}
						</div>
					</div>
				)}
				<div className="space-y-2 px-2 pt-2">
					<div className="text-xs font-medium">Branch management</div>
					<div className="grid grid-cols-2 gap-2">
						<Input
							value={this.state.sourceControlNewBranch}
							onChange={(event) => this.setState({ sourceControlNewBranch: event.target.value })}
							placeholder="New branch"
							aria-label="New Git branch"
						/>
						<Input
							value={this.state.sourceControlStartPoint}
							onChange={(event) => this.setState({ sourceControlStartPoint: event.target.value })}
							placeholder="Start point (HEAD)"
							aria-label="Git branch start point"
						/>
					</div>
					<Button
						size="sm"
						className="w-full"
						disabled={this.state.sourceControlBusy || !this.state.sourceControlNewBranch.trim()}
						onClick={() => void this._createSourceControlBranch()}
					>
						Create Branch
					</Button>
					<div className="grid grid-cols-2 gap-2">
						<Button
							size="sm"
							variant="secondary"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlBranch.trim()}
							onClick={() => void this._switchSourceControlBranch()}
						>
							Switch Target
						</Button>
						<Button
							size="sm"
							variant="destructive"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlBranch.trim()}
							onClick={() => void this._deleteSourceControlBranch()}
						>
							Delete Target
						</Button>
					</div>
					<div className="text-xs font-medium">Local tag management</div>
					<Input
						value={this.state.sourceControlTagName}
						onChange={(event) => this.setState({ sourceControlTagName: event.target.value })}
						placeholder="Tag name"
						aria-label="Git tag name"
					/>
					<Input
						value={this.state.sourceControlTagMessage}
						onChange={(event) => this.setState({ sourceControlTagMessage: event.target.value })}
						placeholder="Annotation (optional)"
						aria-label="Git tag annotation"
					/>
					<div className="grid grid-cols-2 gap-2">
						<Button size="sm" disabled={this.state.sourceControlBusy || !this.state.sourceControlTagName.trim()} onClick={() => void this._createSourceControlTag()}>
							Create Tag
						</Button>
						<Button
							size="sm"
							variant="destructive"
							disabled={this.state.sourceControlBusy || !this.state.sourceControlTagName.trim()}
							onClick={() => void this._deleteSourceControlTag()}
						>
							Delete Tag
						</Button>
					</div>
				</div>
				{this.state.sourceControlHistory.length > 0 && (
					<div className="space-y-1 px-2 pt-2 text-xs">
						<div className="font-medium">Recent commits</div>
						{this.state.sourceControlHistory.map((commit) => (
							<div key={commit.hash} className="truncate text-muted-foreground" title={`${commit.author} · ${commit.date}`}>
								{commit.shortHash} {commit.subject}
							</div>
						))}
					</div>
				)}
				{this.state.sourceControlDiff && (
					<div className="space-y-1 px-2 pt-2 text-xs">
						<div className="font-medium">
							Diff · {this.state.sourceControlDiff.path}
							{this.state.sourceControlDiff.truncated ? " (truncated)" : ""}
						</div>
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-input p-2 text-[11px]">{this.state.sourceControlDiff.diff || "No diff content."}</pre>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _refreshSourceControlStatus(): void {
		getProjectSourceControlStatus(this.props.object, {}, { editor: this.props.editor })
			.then((sourceControlStatus) => this.setState({ sourceControlStatus, sourceControlError: null }))
			.catch((error: any) => this.setState({ sourceControlStatus: null, sourceControlError: error.message }));
	}

	private _refreshSourceControlHistory(): void {
		getProjectSourceControlHistory(this.props.object, { limit: 10 }, { editor: this.props.editor })
			.then((result) => this.setState({ sourceControlHistory: result.commits }))
			.catch(() => this.setState({ sourceControlHistory: [] }));
	}

	private _refreshSourceControlRefs(): void {
		listProjectSourceControlRefs(this.props.object, {}, { editor: this.props.editor })
			.then((sourceControlRefs) =>
				this.setState((state) => ({ sourceControlRefs, sourceControlBranch: state.sourceControlBranch || sourceControlRefs.currentBranch || "", sourceControlError: null }))
			)
			.catch((error: any) => this.setState({ sourceControlRefs: null, sourceControlError: error.message }));
	}

	private async _refreshSourceControlWorkspace(): Promise<void> {
		try {
			const sourceControlWorkspace = await getProjectSourceControlWorkspace(
				this.props.object,
				{
					pendingFilter: this.state.sourceControlWorkspacePendingFilter,
					incomingFilter: this.state.sourceControlWorkspaceIncomingFilter,
					branchFilter: this.state.sourceControlWorkspaceBranchFilter,
					limit: 100,
				},
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlWorkspace, sourceControlError: null });
		} catch (error: any) {
			this.setState({ sourceControlWorkspace: null, sourceControlError: error.message });
		}
	}

	private async _inspectSourceControlWorkspaceChangeset(hash: string): Promise<void> {
		this.setState({ sourceControlBusy: true, sourceControlError: null });
		try {
			const sourceControlWorkspaceChangeset = await inspectProjectSourceControlChangeset(this.props.object, { hash }, { editor: this.props.editor });
			this.setState({ sourceControlWorkspaceChangeset, sourceControlWorkspaceShelveset: null, sourceControlResult: `Inspected changeset ${hash.slice(0, 8)}.` });
		} catch (error: any) {
			this.setState({ sourceControlWorkspaceChangeset: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _inspectSourceControlWorkspaceShelveset(shelvesetHash: string): Promise<void> {
		this.setState({ sourceControlBusy: true, sourceControlError: null });
		try {
			const result = await inspectProjectSourceControlShelveset(this.props.object, { shelvesetHash }, { editor: this.props.editor });
			this.setState({
				sourceControlWorkspaceShelveset: result.shelveset,
				sourceControlWorkspaceChangeset: result,
				sourceControlWorkspaceShelvesetPaths: result.changedPaths
					.map((entry: any) => entry.path)
					.filter(Boolean)
					.join(", "),
				sourceControlResult: `Inspected shelveset ${shelvesetHash.slice(0, 8)}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlWorkspaceShelveset: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _saveSourceControlWorkspaceLayout(branchExplorerPercent: number, changesPercent: number, propertiesPercent: number): Promise<void> {
		const workspace = this.state.sourceControlWorkspace;
		if (!workspace) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null });
		try {
			const result = await setProjectSourceControlWorkspaceLayout(
				this.props.object,
				{
					expectedRevision: workspace.layout.revision,
					branchExplorerPercent,
					changesPercent,
					propertiesPercent,
					activePanel: workspace.layout.activePanel,
				},
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlWorkspace: { ...workspace, layout: result.layout }, sourceControlResult: "Saved source-control splitter positions." });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _applySourceControlWorkspaceFolderAction(action: "add" | "undo"): Promise<void> {
		const workspace = this.state.sourceControlWorkspace;
		const path = this.state.sourceControlWorkspaceFolderPath.trim();
		if (!workspace || !path) {
			return;
		}
		if (
			action === "undo" &&
			!(await showConfirm("Undo Folder Changes?", `Undo all tracked and staged changes under folder ${path}? Untracked files will be preserved.`, {
				confirmText: "Undo Changes",
			}))
		) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null });
		try {
			const result = await applyProjectSourceControlFolderAction(
				this.props.object,
				{
					action,
					path,
					expectedWorkspaceFingerprint: workspace.workspaceFingerprint,
					confirm: action === "undo",
					collaborationToken: this.state.collaborationToken || undefined,
				},
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlStatus: result.status, sourceControlResult: `${action === "add" ? "Added" : "Undid changes under"} ${path}.` });
			await this._refreshSourceControlWorkspace();
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _createSourceControlWorkspaceShelveset(): Promise<void> {
		const workspace = this.state.sourceControlWorkspace;
		const message = this.state.sourceControlWorkspaceShelvesetMessage.trim();
		if (!workspace || !message) {
			return;
		}
		if (
			!(await showConfirm("Create Retained Shelveset?", `Create retained shelveset “${message}” without changing the current worktree?`, { confirmText: "Create Shelveset" }))
		) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null });
		try {
			const result = await createProjectSourceControlShelveset(
				this.props.object,
				{
					message,
					expectedWorkspaceFingerprint: workspace.workspaceFingerprint,
					confirm: true,
					collaborationToken: this.state.collaborationToken || undefined,
				},
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlResult: `Created retained shelveset ${result.shelveset.hash.slice(0, 8)}.` });
			await this._refreshSourceControlWorkspace();
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _applySourceControlWorkspaceShelveset(): Promise<void> {
		const workspace = this.state.sourceControlWorkspace;
		const shelveset = this.state.sourceControlWorkspaceShelveset;
		const paths = [
			...new Set(
				this.state.sourceControlWorkspaceShelvesetPaths
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean)
			),
		];
		if (!workspace || !shelveset || !paths.length) {
			return;
		}
		if (
			!(await showConfirm("Partially Apply Shelveset?", `Apply ${paths.length} selected path(s) from shelveset ${shelveset.hash.slice(0, 8)} and retain it?`, {
				confirmText: "Apply Selected Paths",
			}))
		) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null });
		try {
			const result = await applyProjectSourceControlShelvesetPaths(
				this.props.object,
				{
					shelvesetHash: shelveset.hash,
					paths,
					expectedWorkspaceFingerprint: workspace.workspaceFingerprint,
					confirm: true,
					collaborationToken: this.state.collaborationToken || undefined,
				},
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlStatus: result.status, sourceControlResult: `Applied ${paths.length} shelveset path(s); shelveset retained.` });
			await this._refreshSourceControlWorkspace();
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _deleteSourceControlWorkspaceShelveset(): Promise<void> {
		const shelveset = this.state.sourceControlWorkspaceShelveset;
		if (!shelveset) {
			return;
		}
		if (!(await showConfirm("Delete Shelveset?", `Delete retained shelveset ${shelveset.hash.slice(0, 8)} (${shelveset.subject})?`, { confirmText: "Delete Shelveset" }))) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null });
		try {
			await deleteProjectSourceControlShelveset(
				this.props.object,
				{ shelvesetHash: shelveset.hash, confirm: true, collaborationToken: this.state.collaborationToken || undefined },
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlWorkspaceShelveset: null,
				sourceControlWorkspaceChangeset: null,
				sourceControlResult: `Deleted shelveset ${shelveset.hash.slice(0, 8)}.`,
			});
			await this._refreshSourceControlWorkspace();
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _renameSourceControlWorkspaceRef(): Promise<void> {
		const selected = this.state.sourceControlWorkspaceSelectedRef;
		const newName = this.state.sourceControlWorkspaceRenameValue.trim();
		if (!selected || !newName || newName === selected.name) {
			return;
		}
		if (!(await showConfirm(`Rename Git ${selected.kind}?`, `Rename ${selected.kind} “${selected.name}” to “${newName}”?`, { confirmText: "Rename" }))) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null });
		try {
			await renameProjectSourceControlRef(
				this.props.object,
				{
					kind: selected.kind,
					name: selected.name,
					newName,
					expectedHash: selected.hash,
					confirm: true,
					collaborationToken: this.state.collaborationToken || undefined,
				},
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlWorkspaceSelectedRef: { ...selected, name: newName },
				sourceControlWorkspaceRenameEditing: false,
				sourceControlResult: `Renamed ${selected.kind} ${selected.name} to ${newName}.`,
			});
			await Promise.all([this._refreshSourceControlWorkspace(), Promise.resolve(this._refreshSourceControlRefs())]);
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private _sourceControlAuthenticationHelperKinds(): string[] {
		const authentication = this.state.sourceControlAuthentication;
		if (!authentication) {
			return [];
		}
		return [...new Set<string>([...authentication.fetch.https, ...authentication.push.https].flatMap((settings: any) => settings.helpers.map((helper: any) => helper.kind)))];
	}

	private async _inspectSourceControlAuthentication(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const sourceControlAuthentication = await inspectProjectSourceControlAuthentication(this.props.object, { remote }, { editor: this.props.editor });
			this.setState({
				sourceControlAuthentication,
				sourceControlResult: `Inspected local authentication readiness for ${remote} without contacting it or invoking credentials.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlAuthentication: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private _refreshSourceControlIntegration(): void {
		getProjectSourceControlIntegrationState(this.props.object, {}, { editor: this.props.editor })
			.then((sourceControlIntegrationState) => this.setState({ sourceControlIntegrationState }))
			.catch((error: any) => this.setState({ sourceControlIntegrationState: null, sourceControlError: error.message }));
	}

	private _getSourceControlDiff(path: string, staged: boolean): void {
		getProjectSourceControlDiff(this.props.object, { path, staged }, { editor: this.props.editor })
			.then((sourceControlDiff) => this.setState({ sourceControlDiff }))
			.catch((error: any) => this.setState({ sourceControlDiff: null, sourceControlError: error.message }));
	}

	private async _stageSourceControl(path?: string, all = false): Promise<void> {
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await stageProjectSourceControlPaths(
				this.props.object,
				{ ...(all ? { all: true } : { paths: [path] }), collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlStatus: result.status, sourceControlResult: all ? "All active-project changes staged." : `${path} staged.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _unstageSourceControl(path?: string, all = false): Promise<void> {
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await unstageProjectSourceControlPaths(
				this.props.object,
				{ ...(all ? { all: true } : { paths: [path] }), collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlStatus: result.status, sourceControlResult: all ? "All active-project changes unstaged." : `${path} unstaged.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _commitSourceControl(): Promise<void> {
		const confirmed = await showConfirm(
			"Create Git commit?",
			"This commits every currently staged path. Staged paths outside a nested active project cause the operation to fail."
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await commitProjectSourceControl(
				this.props.object,
				{ message: this.state.sourceControlCommitMessage, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlCommitMessage: "",
				sourceControlStatus: result.status,
				sourceControlResult: `Committed ${result.commit.shortHash}: ${result.commit.subject}`,
			});
			this._refreshSourceControlHistory();
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _pushSourceControl(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		const branch = this.state.sourceControlBranch.trim();
		const confirmed = await showConfirm("Push Git branch?", `Push current HEAD to ${remote}${branch ? `/${branch}` : " on the current branch"} without force?`);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await pushProjectSourceControl(
				this.props.object,
				{ remote, ...(branch ? { branch } : {}), setUpstream: true, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlResult: `Pushed ${result.branch} to ${result.remote}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _fetchSourceControl(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		const confirmed = await showConfirm("Fetch Git remote?", `Fetch and prune remote-tracking refs plus tags from ${remote}? Working-tree files will not change.`);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await fetchProjectSourceControl(
				this.props.object,
				{ remote, prune: true, tags: true, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlRefs: result.refs, sourceControlResult: `Fetched ${remote}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _pullSourceControl(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		const branch = this.state.sourceControlBranch.trim();
		const confirmed = await showConfirm(
			"Fast-forward Git pull?",
			`Pull ${remote}${branch ? `/${branch}` : " on the current branch"} only if the project owns the repository root, the complete worktree is clean, and no merge commit is needed?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await pullProjectSourceControl(
				this.props.object,
				{ remote, ...(branch ? { branch } : {}), confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlStatus: result.status, sourceControlRefs: result.refs, sourceControlResult: `Fast-forwarded ${result.branch} from ${result.remote}.` });
			this._refreshSourceControlHistory();
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _createSourceControlBranch(): Promise<void> {
		const name = this.state.sourceControlNewBranch.trim();
		const startPoint = this.state.sourceControlStartPoint.trim() || "HEAD";
		const confirmed = await showConfirm("Create Git branch?", `Create local branch ${name} at ${startPoint} without switching the worktree?`);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await createProjectSourceControlBranch(
				this.props.object,
				{ name, startPoint, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlNewBranch: "", sourceControlRefs: result.refs, sourceControlResult: `Created branch ${name}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _switchSourceControlBranch(): Promise<void> {
		const name = this.state.sourceControlBranch.trim();
		const confirmed = await showConfirm("Switch Git branch?", `Switch the clean root-owned project worktree to local branch ${name}?`);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await switchProjectSourceControlBranch(
				this.props.object,
				{ name, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlStatus: result.status, sourceControlRefs: result.refs, sourceControlResult: `Switched to ${name}.` });
			this._refreshSourceControlHistory();
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _deleteSourceControlBranch(): Promise<void> {
		const name = this.state.sourceControlBranch.trim();
		const confirmed = await showConfirm(
			"Delete local Git branch?",
			`Safely delete ${name} only if it is not current and Git reports it fully merged? No force deletion will be attempted.`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await deleteProjectSourceControlBranch(
				this.props.object,
				{ name, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlRefs: result.refs, sourceControlResult: `Deleted local branch ${name}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _createSourceControlTag(): Promise<void> {
		const name = this.state.sourceControlTagName.trim();
		const message = this.state.sourceControlTagMessage.trim();
		const startPoint = this.state.sourceControlStartPoint.trim() || "HEAD";
		const confirmed = await showConfirm("Create local Git tag?", `Create ${message ? "annotated" : "lightweight"} tag ${name} at ${startPoint}? No remote tag will change.`);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await createProjectSourceControlTag(
				this.props.object,
				{ name, startPoint, ...(message ? { message } : {}), confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlTagName: "", sourceControlTagMessage: "", sourceControlRefs: result.refs, sourceControlResult: `Created local tag ${name}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _deleteSourceControlTag(): Promise<void> {
		const name = this.state.sourceControlTagName.trim();
		const confirmed = await showConfirm("Delete local Git tag?", `Delete local tag ${name}? The remote tag, if any, will remain unchanged.`);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await deleteProjectSourceControlTag(
				this.props.object,
				{ name, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlTagName: "", sourceControlTagMessage: "", sourceControlRefs: result.refs, sourceControlResult: `Deleted local tag ${name}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _previewSourceControlIntegration(): Promise<void> {
		const target = this.state.sourceControlIntegrationTarget.trim();
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const sourceControlIntegrationPreview = await previewProjectSourceControlIntegration(this.props.object, { target }, { editor: this.props.editor });
			this.setState({ sourceControlIntegrationPreview, sourceControlResult: `Previewed integration of ${target}.` });
		} catch (error: any) {
			this.setState({ sourceControlIntegrationPreview: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _startSourceControlMerge(): Promise<void> {
		const target = this.state.sourceControlIntegrationTarget.trim();
		const confirmed = await showConfirm(
			"Start Git merge?",
			`Merge ${target} into the current branch without fast-forward or automatic commit? The complete root-owned worktree must be clean; review and continue or abort afterward.`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await startProjectSourceControlMerge(
				this.props.object,
				{ target, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlConflictDetails: null,
				sourceControlConflictCustomText: "",
				sourceControlImageConflict: null,
				sourceControlSemanticConflict: null,
				sourceControlSemanticConflictResolutions: [],
				sourceControlIntegrationPreview: result.preview,
				sourceControlIntegrationState: result.integration,
				sourceControlStatus: result.integration.status,
				sourceControlResult: result.completed
					? result.output || `${target} is already integrated.`
					: result.integration.conflictCount
						? `Merge stopped with ${result.integration.conflictCount} conflict(s).`
						: "Merge staged for review.",
			});
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _startSourceControlRebase(): Promise<void> {
		const target = this.state.sourceControlIntegrationTarget.trim();
		const confirmed = await showConfirm(
			"Start Git rebase?",
			`Rewrite current local commits onto ${target}? The complete root-owned worktree must be clean. No force push occurs; conflicts can be resolved or the rebase aborted.`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await startProjectSourceControlRebase(
				this.props.object,
				{ target, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlConflictDetails: null,
				sourceControlConflictCustomText: "",
				sourceControlImageConflict: null,
				sourceControlSemanticConflict: null,
				sourceControlSemanticConflictResolutions: [],
				sourceControlIntegrationPreview: result.preview,
				sourceControlIntegrationState: result.integration,
				sourceControlStatus: result.integration.status,
				sourceControlResult: result.completed ? `Rebase onto ${target} completed.` : `Rebase stopped with ${result.integration.conflictCount} conflict(s).`,
			});
			if (result.completed) {
				this._refreshSourceControlHistory();
				this._refreshSourceControlRefs();
			}
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private _renderSourceControlConflictPreview(label: string, details: any | null): ReactNode {
		if (!details || details.exists === false) {
			return (
				<div className="rounded bg-input p-2">
					<div className="font-medium">{label}</div>
					<div className="text-muted-foreground">Absent</div>
				</div>
			);
		}
		const description = details.tooLarge
			? `${details.byteLength} bytes · metadata only`
			: details.binary
				? `${details.byteLength} bytes · binary`
				: `${details.byteLength} bytes · UTF-8 text`;
		return (
			<div className="min-w-0 rounded bg-input p-2">
				<div className="font-medium">{label}</div>
				<div className="truncate text-[10px] text-muted-foreground" title={details.hash}>
					{description}
					{details.hash ? ` · ${details.hash}` : ""}
				</div>
				{typeof details.text === "string" && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px]">{details.text}</pre>}
			</div>
		);
	}

	private _renderSourceControlImageConflictStage(label: string, stage: any | null): ReactNode {
		if (!stage) {
			return <div className="rounded bg-background/70 p-2 text-muted-foreground">{label} · absent</div>;
		}
		return (
			<div className="min-w-0 space-y-1 rounded bg-background/70 p-2">
				<div className="font-medium">{label}</div>
				<div className="truncate text-[10px] text-muted-foreground" title={stage.hash}>
					{stage.status === "ready" ? `${stage.format} · ${stage.width}×${stage.height} · ${stage.byteLength} bytes` : `${stage.status} · ${stage.byteLength} bytes`}
				</div>
				{stage.preview && (
					<img
						src={`data:${stage.preview.mimeType};base64,${stage.preview.imageBase64}`}
						alt={`${label} conflict image preview`}
						className="max-h-32 w-full rounded border border-border bg-[repeating-conic-gradient(#999_0_25%,#666_0_50%)_50%/12px_12px] object-contain [image-rendering:auto]"
					/>
				)}
				{stage.reason && <div className="text-[10px] text-amber-500">{stage.reason}</div>}
			</div>
		);
	}

	private _renderSourceControlImageConflictComparison(comparison: any): ReactNode {
		return (
			<div className="min-w-0 space-y-1 rounded bg-background/70 p-2">
				<div className="font-medium">{comparison.label}</div>
				{comparison.comparable ? (
					<>
						<div className="text-[10px] text-muted-foreground">
							{comparison.changedPixels}/{comparison.pixelCount} pixels · {(comparison.changedRatio * 100).toFixed(2)}%
						</div>
						{comparison.differencePreview && (
							<img
								src={`data:${comparison.differencePreview.mimeType};base64,${comparison.differencePreview.imageBase64}`}
								alt={`${comparison.label} difference heatmap`}
								className="max-h-32 w-full rounded border border-border bg-black object-contain [image-rendering:pixelated]"
							/>
						)}
					</>
				) : (
					<div className="text-[10px] text-amber-500">{comparison.reason}</div>
				)}
			</div>
		);
	}

	private async _inspectSourceControlConflictDetails(path: string): Promise<void> {
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const sourceControlConflictDetails = await inspectProjectSourceControlConflictDetails(this.props.object, { path }, { editor: this.props.editor });
			this.setState({
				sourceControlConflictDetails,
				sourceControlConflictCustomText: sourceControlConflictDetails.worktree?.text ?? sourceControlConflictDetails.ours?.text ?? "",
				sourceControlImageConflict: null,
				sourceControlResult: `Inspected base, ours, theirs, and current worktree content for ${path}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlConflictDetails: null, sourceControlConflictCustomText: "", sourceControlImageConflict: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _inspectSourceControlImageConflict(): Promise<void> {
		const path = this.state.sourceControlConflictDetails?.path;
		if (!path) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const sourceControlImageConflict = await inspectProjectSourceControlImageConflict(this.props.object, { path, includePreviews: true }, { editor: this.props.editor });
			this.setState({ sourceControlImageConflict, sourceControlResult: `Inspected bounded raster stages and exact image differences for ${path}.` });
		} catch (error: any) {
			this.setState({ sourceControlImageConflict: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _inspectSourceControlSemanticConflict(path: string): Promise<void> {
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const conflictResolutions = this.state.sourceControlSemanticConflict?.path === path ? this.state.sourceControlSemanticConflictResolutions : [];
			const sourceControlSemanticConflict = await inspectProjectSourceControlSemanticConflict(
				this.props.object,
				{ path, conflictResolutions, ruleIds: this.state.semanticMergeRuleIds, maximumConflicts: 200 },
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlSemanticConflict,
				sourceControlSemanticConflictResolutions: conflictResolutions,
				sourceControlResult: `Inspected Babylon-aware Git stages for ${path}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlSemanticConflict: null, sourceControlSemanticConflictResolutions: [], sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private _setSourceControlSemanticResolution(conflict: any, choice: "base" | "ours" | "theirs" | "delete"): void {
		const key = `${conflict.file}\0${conflict.path}`;
		const sourceControlSemanticConflictResolutions = this.state.sourceControlSemanticConflictResolutions.filter((candidate) => `${candidate.file}\0${candidate.path}` !== key);
		sourceControlSemanticConflictResolutions.push({ file: conflict.file, path: conflict.path, choice });
		const path = this.state.sourceControlSemanticConflict?.path;
		this.setState({ sourceControlSemanticConflictResolutions }, () => {
			if (path) {
				void this._inspectSourceControlSemanticConflict(path);
			}
		});
	}

	private async _applySourceControlSemanticConflict(): Promise<void> {
		const preview = this.state.sourceControlSemanticConflict;
		if (!preview) {
			return;
		}
		const confirmed = await showConfirm(
			"Apply semantic Git resolution?",
			`Atomically write the reviewed Babylon-aware merge for ${preview.path} and stage it? Exact Git stages and semantic output must still match this preview.`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await applyProjectSourceControlSemanticConflict(
				this.props.object,
				{
					path: preview.path,
					conflictResolutions: this.state.sourceControlSemanticConflictResolutions,
					ruleIds: this.state.semanticMergeRuleIds,
					maximumConflicts: 200,
					expectedFingerprint: preview.fingerprint,
					expectedOutputHash: preview.merge.outputHash,
					confirm: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlSemanticConflict: null,
				sourceControlSemanticConflictResolutions: [],
				sourceControlIntegrationState: result.integration,
				sourceControlStatus: result.integration.status,
				sourceControlResult: `Applied and staged the semantic merge for ${preview.path}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _applySourceControlTextResolution(): Promise<void> {
		const details = this.state.sourceControlConflictDetails;
		if (!details) {
			return;
		}
		const confirmed = await showConfirm(
			"Apply custom Git text resolution?",
			`Atomically replace ${details.path} with the reviewed text and stage it as resolved? The operation will stop if the inspected conflict stages changed.`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await applyProjectSourceControlTextResolution(
				this.props.object,
				{
					path: details.path,
					content: this.state.sourceControlConflictCustomText,
					expectedFingerprint: details.fingerprint,
					confirm: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlConflictDetails: null,
				sourceControlConflictCustomText: "",
				sourceControlImageConflict: null,
				sourceControlIntegrationState: result.integration,
				sourceControlStatus: result.integration.status,
				sourceControlResult: `Applied and staged the reviewed text resolution for ${details.path}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _resolveSourceControlConflict(path: string, resolution: "ours" | "theirs" | "delete" | "markResolved"): Promise<void> {
		const confirmed = await showConfirm(
			"Resolve Git conflict?",
			resolution === "markResolved"
				? `Stage the current externally edited contents of ${path} as resolved?`
				: `Resolve ${path} using ${resolution}${this.state.sourceControlIntegrationState?.operation === "rebase" && (resolution === "ours" || resolution === "theirs") ? " (rebase stage semantics apply)" : ""}?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await resolveProjectSourceControlConflict(
				this.props.object,
				{ path, resolution, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlConflictDetails: this.state.sourceControlConflictDetails?.path === path ? null : this.state.sourceControlConflictDetails,
				sourceControlConflictCustomText: this.state.sourceControlConflictDetails?.path === path ? "" : this.state.sourceControlConflictCustomText,
				sourceControlImageConflict: this.state.sourceControlConflictDetails?.path === path ? null : this.state.sourceControlImageConflict,
				sourceControlSemanticConflict: this.state.sourceControlSemanticConflict?.path === path ? null : this.state.sourceControlSemanticConflict,
				sourceControlSemanticConflictResolutions: this.state.sourceControlSemanticConflict?.path === path ? [] : this.state.sourceControlSemanticConflictResolutions,
				sourceControlIntegrationState: result.integration,
				sourceControlStatus: result.integration.status,
				sourceControlResult: `Resolved ${path} using ${resolution}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _continueSourceControlIntegration(): Promise<void> {
		const operation = this.state.sourceControlIntegrationState?.operation;
		const confirmed = await showConfirm(
			`Continue Git ${operation}?`,
			operation === "merge"
				? "Commit the reviewed merge using the current commit message? Normal Git hooks will run."
				: "Continue replaying rebase commits non-interactively? The rebase may stop again on another conflict."
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await continueProjectSourceControlIntegration(
				this.props.object,
				{ ...(operation === "merge" ? { message: this.state.sourceControlCommitMessage } : {}), confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlConflictDetails: result.completed ? null : this.state.sourceControlConflictDetails,
				sourceControlConflictCustomText: result.completed ? "" : this.state.sourceControlConflictCustomText,
				sourceControlImageConflict: result.completed ? null : this.state.sourceControlImageConflict,
				sourceControlSemanticConflict: result.completed ? null : this.state.sourceControlSemanticConflict,
				sourceControlSemanticConflictResolutions: result.completed ? [] : this.state.sourceControlSemanticConflictResolutions,
				sourceControlIntegrationState: result.integration,
				sourceControlStatus: result.integration.status,
				sourceControlRefs: result.refs ?? this.state.sourceControlRefs,
				sourceControlCommitMessage: operation === "merge" && result.completed ? "" : this.state.sourceControlCommitMessage,
				sourceControlResult: result.completed ? `${operation} completed.` : `${operation} stopped with ${result.integration.conflictCount} conflict(s).`,
			});
			if (result.completed) {
				this._refreshSourceControlHistory();
			}
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _abortSourceControlIntegration(): Promise<void> {
		const operation = this.state.sourceControlIntegrationState?.operation;
		const confirmed = await showConfirm(`Abort Git ${operation}?`, "Ask Git to restore the index and worktree state from before this integration began?");
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await abortProjectSourceControlIntegration(
				this.props.object,
				{ confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlConflictDetails: null,
				sourceControlConflictCustomText: "",
				sourceControlImageConflict: null,
				sourceControlSemanticConflict: null,
				sourceControlSemanticConflictResolutions: [],
				sourceControlIntegrationState: result.integration,
				sourceControlStatus: result.integration.status,
				sourceControlRefs: result.refs,
				sourceControlResult: `Aborted Git ${result.operation}.`,
			});
			this._refreshSourceControlHistory();
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _refreshSourceControlReviewProvider(): Promise<void> {
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const sourceControlReviewProvider = await getProjectSourceControlReviewProvider(this.props.object, {}, { editor: this.props.editor });
			this.setState({
				sourceControlReviewProvider,
				sourceControlReviewProviderType: sourceControlReviewProvider.provider,
				sourceControlReviewApiBaseUrl: sourceControlReviewProvider.apiBaseUrl,
				sourceControlReviewRepository: sourceControlReviewProvider.repository,
				sourceControlReviewTokenEnvironmentVariable: sourceControlReviewProvider.tokenEnvironmentVariable,
				sourceControlReviewAuthenticationMode: sourceControlReviewProvider.authenticationMode,
				sourceControlResult: "Loaded hosted review provider configuration.",
			});
		} catch (error: any) {
			this.setState({ sourceControlReviewProvider: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _saveSourceControlReviewProvider(enabled: boolean): Promise<void> {
		const confirmed = await showConfirm(
			enabled ? "Enable hosted review provider?" : "Disable hosted review provider?",
			enabled
				? `Store the credential-free ${this.state.sourceControlReviewProviderType} API/repository settings? The token value remains environment-only.`
				: "Disable hosted review API operations while retaining no access-token value?"
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const sourceControlReviewProvider = await setProjectSourceControlReviewProvider(
				this.props.object,
				{
					enabled,
					provider: this.state.sourceControlReviewProviderType,
					apiBaseUrl: this.state.sourceControlReviewApiBaseUrl,
					...(this.state.sourceControlReviewRepository.trim() ? { repository: this.state.sourceControlReviewRepository.trim() } : {}),
					tokenEnvironmentVariable: this.state.sourceControlReviewTokenEnvironmentVariable,
					authenticationMode: this.state.sourceControlReviewAuthenticationMode,
					confirm: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlReviewProvider,
				sourceControlReviews: enabled ? this.state.sourceControlReviews : [],
				sourceControlReviewDetail: enabled ? this.state.sourceControlReviewDetail : null,
				sourceControlResult: `Hosted reviews ${enabled ? "enabled" : "disabled"}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _listSourceControlReviews(): Promise<void> {
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await listProjectSourceControlReviews(this.props.object, { state: "open", limit: 50 }, { editor: this.props.editor });
			this.setState({ sourceControlReviews: result.reviews, sourceControlResult: `Loaded ${result.count} open hosted review request(s).` });
		} catch (error: any) {
			this.setState({ sourceControlReviews: [], sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _inspectSourceControlReview(number?: number): Promise<void> {
		const reviewNumber = number ?? Number(this.state.sourceControlReviewNumber);
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await getProjectSourceControlReview(this.props.object, { number: reviewNumber }, { editor: this.props.editor });
			this.setState({
				sourceControlReviewNumber: String(result.review.number),
				sourceControlReviewDetail: result.review,
				sourceControlReviewMetadata: null,
				sourceControlReviewChecks: null,
				sourceControlReviewRunId: "",
				sourceControlResult: `Inspected hosted review #${result.review.number} at head ${result.review.head.sha.slice(0, 8)}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlReviewDetail: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private _sourceControlReviewNames(value: string): string[] {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	private async _inspectSourceControlReviewMetadata(): Promise<void> {
		const review = this.state.sourceControlReviewDetail;
		if (!review) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const metadata = await getProjectSourceControlReviewMetadata(this.props.object, { number: review.number }, { editor: this.props.editor });
			this.setState({
				sourceControlReviewMetadata: metadata,
				sourceControlReviewReviewers: metadata.reviewers.join(", "),
				sourceControlReviewTeams: metadata.teams.join(", "),
				sourceControlReviewLabels: metadata.labels.join(", "),
				sourceControlResult: `Loaded reviewers and labels for hosted review #${review.number}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlReviewMetadata: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _replaceSourceControlReviewMetadata(): Promise<void> {
		const review = this.state.sourceControlReviewDetail;
		const metadata = this.state.sourceControlReviewMetadata;
		if (!review || !metadata) {
			return;
		}
		const confirmed = await showConfirm(
			"Replace hosted review assignments?",
			`Replace all requested reviewers, teams, and labels on review #${review.number} only if its inspected metadata is unchanged?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await setProjectSourceControlReviewMetadata(
				this.props.object,
				{
					number: review.number,
					expectedFingerprint: metadata.fingerprint,
					reviewers: this._sourceControlReviewNames(this.state.sourceControlReviewReviewers),
					teams: this._sourceControlReviewNames(this.state.sourceControlReviewTeams),
					labels: this._sourceControlReviewNames(this.state.sourceControlReviewLabels),
					confirm: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlReviewMetadata: result.metadata,
				sourceControlReviewReviewers: result.metadata.reviewers.join(", "),
				sourceControlReviewTeams: result.metadata.teams.join(", "),
				sourceControlReviewLabels: result.metadata.labels.join(", "),
				sourceControlResult: `Replaced reviewers and labels on hosted review #${review.number}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _inspectSourceControlReviewChecks(): Promise<void> {
		const review = this.state.sourceControlReviewDetail;
		if (!review) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const checks = await listProjectSourceControlReviewChecks(this.props.object, { number: review.number }, { editor: this.props.editor });
			this.setState({
				sourceControlReviewChecks: checks,
				sourceControlReviewRunId: checks.runs.length ? String(checks.runs[0].id) : "",
				sourceControlResult: `Loaded ${checks.summary.total} check result(s) for hosted review #${review.number}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlReviewChecks: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _rerunSourceControlReviewChecks(): Promise<void> {
		const review = this.state.sourceControlReviewDetail;
		const checks = this.state.sourceControlReviewChecks;
		const runIdText = this.state.sourceControlReviewRunId.trim();
		const numericRunId = /^\d+$/.test(runIdText) ? Number(runIdText) : null;
		const runId = numericRunId ?? runIdText;
		const validRunId = numericRunId !== null ? Number.isSafeInteger(numericRunId) && numericRunId > 0 : /^[a-fA-F0-9-]{36}$/.test(runIdText);
		if (!review || !checks || !validRunId) {
			return;
		}
		const confirmed = await showConfirm(
			"Rerun hosted review checks?",
			`Rerun ${this.state.sourceControlReviewRerunMode} checks for run ${runId} only if review #${review.number} is still at ${checks.headSha.slice(0, 12)}?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			await rerunProjectSourceControlReviewChecks(
				this.props.object,
				{
					number: review.number,
					expectedHeadSha: checks.headSha,
					runId,
					mode: this.state.sourceControlReviewRerunMode,
					confirm: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlResult: `Accepted ${this.state.sourceControlReviewRerunMode} check rerun for run ${runId}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _createSourceControlReview(): Promise<void> {
		const confirmed = await showConfirm(
			"Create hosted review request?",
			`Create a review from ${this.state.sourceControlReviewHead} into ${this.state.sourceControlReviewBase} on the configured provider?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await createProjectSourceControlReview(
				this.props.object,
				{
					title: this.state.sourceControlReviewTitle,
					body: this.state.sourceControlReviewBody,
					head: this.state.sourceControlReviewHead,
					base: this.state.sourceControlReviewBase,
					confirm: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlReviewNumber: String(result.review.number),
				sourceControlReviewDetail: result.review,
				sourceControlReviewTitle: "",
				sourceControlResult: `Created hosted review #${result.review.number}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _submitSourceControlReview(action: "approve" | "requestChanges" | "comment"): Promise<void> {
		const review = this.state.sourceControlReviewDetail;
		if (!review) {
			return;
		}
		const confirmed = await showConfirm(
			"Submit hosted review?",
			`Submit ${action} on review #${review.number}${action === "approve" ? "" : " using the current review body/comment text"}?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			await submitProjectSourceControlReview(
				this.props.object,
				{
					number: review.number,
					action,
					...(action === "approve" ? {} : { body: this.state.sourceControlReviewBody }),
					confirm: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlResult: `Submitted ${action} on hosted review #${review.number}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _mergeSourceControlReview(): Promise<void> {
		const review = this.state.sourceControlReviewDetail;
		if (!review) {
			return;
		}
		const confirmed = await showConfirm(
			"Merge hosted review?",
			`Permanently ${this.state.sourceControlReviewMergeMethod}-merge review #${review.number} only if its provider head is still ${review.head.sha.slice(0, 12)}?`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await mergeProjectSourceControlReview(
				this.props.object,
				{
					number: review.number,
					expectedHeadSha: review.head.sha,
					method: this.state.sourceControlReviewMergeMethod,
					confirm: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({
				sourceControlReviewDetail: null,
				sourceControlResult: result.merged ? `Merged hosted review #${review.number}.` : `Provider did not merge review #${review.number}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private _selectedSourceControlRemoteBranch(): any | null {
		const name = this.state.sourceControlRemoteRefName.trim() || this.state.sourceControlBranch.trim();
		return this.state.sourceControlRemoteRefs?.branches.find((branch: any) => branch.name === name) ?? null;
	}

	private _selectedSourceControlRemoteTag(): any | null {
		const name = this.state.sourceControlTagName.trim();
		return this.state.sourceControlRemoteRefs?.tags.find((tag: any) => tag.name === name) ?? null;
	}

	private async _inspectSourceControlRemoteRefs(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const sourceControlRemoteRefs = await inspectProjectSourceControlRemoteRefs(this.props.object, { remote }, { editor: this.props.editor });
			this.setState({
				sourceControlRemoteRefs,
				sourceControlResult: `Inspected ${sourceControlRemoteRefs.branchCount} branches and ${sourceControlRemoteRefs.tagCount} tags on ${remote}.`,
			});
		} catch (error: any) {
			this.setState({ sourceControlRemoteRefs: null, sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _publishSourceControlRemoteBranch(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		const localBranch = this.state.sourceControlBranch.trim();
		const remoteBranch = this.state.sourceControlRemoteRefName.trim() || localBranch;
		const confirmed = await showConfirm(
			"Publish remote Git branch?",
			`Publish local ${localBranch} to ${remote}/${remoteBranch} without force? Non-fast-forward remote history will be rejected.`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await publishProjectSourceControlRemoteBranch(
				this.props.object,
				{ remote, localBranch, remoteBranch, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlRemoteRefs: result.remoteRefs, sourceControlResult: `Published ${localBranch} to ${remote}/${remoteBranch}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _deleteSourceControlRemoteBranch(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		const branch = this._selectedSourceControlRemoteBranch();
		if (!branch) {
			this.setState({ sourceControlError: "Inspect the remote and select an existing remote branch before deletion." });
			return;
		}
		const confirmed = await showConfirm(
			"Delete remote Git branch?",
			`Permanently delete ${remote}/${branch.name} only if its remote hash is still ${branch.hash.slice(0, 12)}? The advertised default branch is protected.`
		);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await deleteProjectSourceControlRemoteBranch(
				this.props.object,
				{ remote, branch: branch.name, expectedHash: branch.hash, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlRemoteRefs: result.remoteRefs, sourceControlResult: `Deleted remote branch ${remote}/${branch.name}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _publishSourceControlRemoteTag(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		const tag = this.state.sourceControlTagName.trim();
		const confirmed = await showConfirm("Publish remote Git tag?", `Publish local tag ${tag} to ${remote} without overwriting any existing remote tag?`);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await publishProjectSourceControlRemoteTag(
				this.props.object,
				{ remote, tag, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlRemoteRefs: result.remoteRefs, sourceControlResult: `Published remote tag ${tag}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private async _deleteSourceControlRemoteTag(): Promise<void> {
		const remote = this.state.sourceControlRemote.trim() || "origin";
		const tag = this._selectedSourceControlRemoteTag();
		if (!tag) {
			this.setState({ sourceControlError: "Inspect the remote and select an existing remote tag before deletion." });
			return;
		}
		const confirmed = await showConfirm("Delete remote Git tag?", `Permanently delete ${remote} tag ${tag.name} only if its remote hash is still ${tag.hash.slice(0, 12)}?`);
		if (!confirmed) {
			return;
		}
		this.setState({ sourceControlBusy: true, sourceControlError: null, sourceControlResult: null });
		try {
			const result = await deleteProjectSourceControlRemoteTag(
				this.props.object,
				{ remote, tag: tag.name, expectedHash: tag.hash, confirm: true, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ sourceControlRemoteRefs: result.remoteRefs, sourceControlResult: `Deleted remote tag ${tag.name}.` });
		} catch (error: any) {
			this.setState({ sourceControlError: error.message });
		} finally {
			this.setState({ sourceControlBusy: false });
		}
	}

	private _getAssetLocksComponent(): ReactNode {
		return (
			<EditorInspectorSectionField
				title="Collaboration Asset Locks"
				tooltip="Expiring leases coordinate local and authenticated remote edits to the same binary asset or serialized editor file. Collaboration sessions derive and bind ownership to the signed-in member."
			>
				{this.state.remoteCollaborationGateway?.running && (
					<div className="rounded bg-emerald-500/10 p-2 text-xs">Remote federation active · authenticated members share this lock list</div>
				)}
				<div className="space-y-2 rounded bg-muted-foreground/10 p-2 text-xs">
					<div className="font-medium">Smart Lock policies</div>
					{this.state.assetLockRules.map((rule) => (
						<div key={rule.id} className="flex items-center gap-2">
							<span
								className="min-w-0 flex-1 truncate"
								title={`${rule.pathPattern} → ${rule.destinationRemote ? `${rule.destinationRemote}/` : ""}${rule.destinationBranch}`}
							>
								{rule.name} · {rule.retention}
							</span>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 px-1 hover:bg-destructive"
								disabled={this.state.assetLockBusy}
								onClick={() => void this._deleteAssetLockRule(rule.id)}
							>
								Remove
							</Button>
						</div>
					))}
					<div className="grid grid-cols-2 gap-1">
						<Input
							value={this.state.assetLockRuleName}
							onChange={(event) => this.setState({ assetLockRuleName: event.target.value })}
							placeholder="Rule name"
							aria-label="Smart Lock rule name"
						/>
						<Input
							value={this.state.assetLockRulePattern}
							onChange={(event) => this.setState({ assetLockRulePattern: event.target.value })}
							placeholder="assets/**/*.prefab"
							aria-label="Smart Lock path pattern"
						/>
						<Input
							value={this.state.assetLockRuleDestinationBranch}
							onChange={(event) => this.setState({ assetLockRuleDestinationBranch: event.target.value })}
							placeholder="Destination branch"
							aria-label="Smart Lock destination branch"
						/>
						<Input
							value={this.state.assetLockRuleDestinationRemote}
							onChange={(event) => this.setState({ assetLockRuleDestinationRemote: event.target.value })}
							placeholder="Remote (blank = local)"
							aria-label="Smart Lock destination remote"
						/>
						<select
							className="h-8 rounded bg-input px-2 text-sm"
							value={this.state.assetLockRuleRetention}
							onChange={(event) => this.setState({ assetLockRuleRetention: event.target.value as "manual" | "untilMerged" })}
							aria-label="Smart Lock retention"
						>
							<option value="untilMerged">Retain until merged</option>
							<option value="manual">Manual release</option>
						</select>
						<Button size="sm" variant="secondary" disabled={this.state.assetLockBusy} onClick={() => void this._createAssetLockRule()}>
							Save Rule
						</Button>
					</div>
				</div>
				<div className="grid grid-cols-2 gap-2">
					<Input
						className="col-span-2"
						value={this.state.assetLockPath}
						onChange={(event) => this.setState({ assetLockPath: event.target.value, assetLockPolicy: null })}
						placeholder="assets/character.glb"
						aria-label="Asset lock project-relative path"
					/>
					<Input
						value={this.state.assetLockOwner}
						onChange={(event) => this.setState({ assetLockOwner: event.target.value })}
						placeholder={this.state.collaborationToken ? "Owner derived from session" : "Owner"}
						disabled={Boolean(this.state.collaborationToken)}
						aria-label="Asset lock owner"
					/>
					<Input
						value={this.state.assetLockNote}
						onChange={(event) => this.setState({ assetLockNote: event.target.value })}
						placeholder="Reason (optional)"
						aria-label="Asset lock note"
					/>
				</div>
				<div className="grid grid-cols-3 gap-2">
					<Button size="sm" disabled={this.state.assetLockBusy} onClick={() => void this._acquireAssetLock()}>
						Acquire 30m Lock
					</Button>
					<Button size="sm" variant="outline" disabled={this.state.assetLockBusy} onClick={() => void this._inspectAssetLockPolicy()}>
						Inspect Policy
					</Button>
					<Button size="sm" variant="secondary" disabled={this.state.assetLockBusy} onClick={() => void this._refreshAssetLocks()}>
						Refresh Locks
					</Button>
				</div>
				{this.state.assetLockPolicy && (
					<div
						className={`rounded p-2 text-xs ${this.state.assetLockPolicy.smartLockRequired ? (this.state.assetLockPolicy.freshness?.fresh ? "bg-emerald-500/10" : "bg-amber-500/10") : "bg-input"}`}
					>
						<div className="font-medium">
							{this.state.assetLockPolicy.smartLockRequired
								? `${this.state.assetLockPolicy.rule.name} · ${this.state.assetLockPolicy.freshness?.fresh ? "ready" : "not ready"}`
								: "No Smart Lock rule matches"}
						</div>
						{this.state.assetLockPolicy.freshness && (
							<div className="text-muted-foreground">
								{this.state.assetLockPolicy.freshness.currentBranch} → {this.state.assetLockPolicy.freshness.destinationRef} · path{" "}
								{this.state.assetLockPolicy.freshness.pathClean ? "clean" : "dirty"} · destination{" "}
								{this.state.assetLockPolicy.freshness.containsDestination ? "contained" : "must be integrated"}
							</div>
						)}
						{this.state.assetLockPolicy.retention && (
							<div className="text-muted-foreground">
								{this.state.assetLockPolicy.retention.retained ? "Retained until branch is clean and merged" : "Release ready"}
							</div>
						)}
					</div>
				)}
				{this.state.assetLockError && <div className="px-2 text-xs text-destructive">{this.state.assetLockError}</div>}
				{this.state.assetLocks.length === 0 && <div className="px-2 text-xs text-muted-foreground">No active or retained project asset locks.</div>}
				{this.state.assetLocks.map((lock) => (
					<div key={lock.lockId ?? `${lock.path}:${lock.owner}`} className="space-y-1 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="flex justify-between gap-2">
							<span className="truncate font-medium" title={lock.path}>
								{lock.path}
							</span>
							<span className="shrink-0 text-muted-foreground">{lock.owner}</span>
						</div>
						<div className="text-muted-foreground">
							{lock.expired
								? lock.retainedByPolicy
									? "Lease expired · Smart Lock retention enforced"
									: "Lease expired"
								: `Expires ${new Date(lock.expiresAt).toLocaleString()}`}
							{lock.memberId ? ` · federated${lock.clientName ? ` via ${lock.clientName}` : ""}` : ""}
							{lock.note ? ` · ${lock.note}` : ""}
						</div>
						{lock.smartLock && (
							<div className="text-muted-foreground">
								Smart · {lock.smartLock.ruleName} · {lock.smartLock.acquisitionBranch} →{" "}
								{lock.smartLock.destinationRemote ? `${lock.smartLock.destinationRemote}/` : ""}
								{lock.smartLock.destinationBranch} · {lock.smartLock.retention}
							</div>
						)}
						<div className="grid grid-cols-2 gap-2">
							<Button
								size="sm"
								variant="secondary"
								disabled={this.state.assetLockBusy || lock.expired || !lock.canManage || !lock.lockId}
								onClick={() => void this._refreshAssetLock(lock)}
							>
								Renew 30m
							</Button>
							<Button
								size="sm"
								variant="destructive"
								disabled={this.state.assetLockBusy || !lock.canManage || !lock.lockId}
								onClick={() => void this._releaseAssetLock(lock)}
							>
								Release
							</Button>
						</div>
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private async _refreshAssetLocks(): Promise<void> {
		try {
			const result = await listProjectAssetLocks(this.props.object, { collaborationToken: this.state.collaborationToken || undefined }, { editor: this.props.editor });
			this.setState({ assetLocks: result.locks, assetLockError: result.invalidEntryCount ? `${result.invalidEntryCount} invalid lock entry was ignored.` : null });
		} catch (error: any) {
			this.setState({ assetLocks: [], assetLockError: error.message });
		}
	}

	private async _refreshAssetLockRules(): Promise<void> {
		try {
			const result = await listProjectAssetLockRules(this.props.object, {}, { editor: this.props.editor });
			this.setState({ assetLockRules: result.rules });
		} catch (error: any) {
			this.setState({ assetLockRules: [], assetLockError: error.message });
		}
	}

	private async _inspectAssetLockPolicy(): Promise<any | null> {
		this.setState({ assetLockBusy: true, assetLockError: null });
		try {
			const assetLockPolicy = await inspectProjectAssetLockPolicy(
				this.props.object,
				{ path: this.state.assetLockPath, collaborationToken: this.state.collaborationToken || undefined },
				{ editor: this.props.editor }
			);
			this.setState({ assetLockPolicy });
			return assetLockPolicy;
		} catch (error: any) {
			this.setState({ assetLockPolicy: null, assetLockError: error.message });
			return null;
		} finally {
			this.setState({ assetLockBusy: false });
		}
	}

	private async _createAssetLockRule(): Promise<void> {
		this.setState({ assetLockBusy: true, assetLockError: null });
		try {
			await createProjectAssetLockRule(
				this.props.object,
				{
					name: this.state.assetLockRuleName,
					pathPattern: this.state.assetLockRulePattern,
					destinationBranch: this.state.assetLockRuleDestinationBranch,
					destinationRemote: this.state.assetLockRuleDestinationRemote || null,
					retention: this.state.assetLockRuleRetention,
					collaborationToken: this.state.collaborationToken || undefined,
				},
				{ editor: this.props.editor }
			);
			await this._refreshAssetLockRules();
			this.setState({ assetLockPolicy: null });
			toast.success("Smart Lock rule saved.");
		} catch (error: any) {
			this.setState({ assetLockError: error.message });
		} finally {
			this.setState({ assetLockBusy: false });
		}
	}

	private async _deleteAssetLockRule(id: string): Promise<void> {
		const confirmed = await showConfirm("Delete Smart Lock rule?", "Delete this path and destination policy? Existing leases keep their retained revision evidence.");
		if (!confirmed) {
			return;
		}
		this.setState({ assetLockBusy: true, assetLockError: null });
		try {
			await deleteProjectAssetLockRule(this.props.object, { id, collaborationToken: this.state.collaborationToken || undefined }, { editor: this.props.editor });
			await this._refreshAssetLockRules();
			this.setState({ assetLockPolicy: null });
			toast.success("Smart Lock rule deleted.");
		} catch (error: any) {
			this.setState({ assetLockError: error.message });
		} finally {
			this.setState({ assetLockBusy: false });
		}
	}

	private async _acquireAssetLock(): Promise<void> {
		const policy = await this._inspectAssetLockPolicy();
		if (!policy) {
			return;
		}
		this.setState({ assetLockBusy: true, assetLockError: null });
		try {
			const result = await acquireProjectAssetLock(
				this.props.object,
				{
					path: this.state.assetLockPath,
					owner: this.state.assetLockOwner || undefined,
					note: this.state.assetLockNote,
					ttlSeconds: 1800,
					expectedHeadHash: policy.smartLockRequired ? policy.freshness.headHash : undefined,
					expectedDestinationHash: policy.smartLockRequired ? policy.freshness.destinationHash : undefined,
					collaborationToken: this.state.collaborationToken || undefined,
				},
				{ editor: this.props.editor }
			);
			if (!result.acquired) {
				throw new Error(`${result.conflict.path} is locked by ${result.conflict.owner} until ${new Date(result.conflict.expiresAt).toLocaleString()}.`);
			}
			toast.success(result.reused ? "Asset lock renewed." : "Asset lock acquired.");
			await this._refreshAssetLocks();
			await this._inspectAssetLockPolicy();
		} catch (error: any) {
			this.setState({ assetLockError: error.message });
		} finally {
			this.setState({ assetLockBusy: false });
		}
	}

	private async _refreshAssetLock(lock: any): Promise<void> {
		this.setState({ assetLockBusy: true, assetLockError: null });
		try {
			await refreshProjectAssetLock(
				this.props.object,
				{ path: lock.path, lockId: lock.lockId, ttlSeconds: 1800, collaborationToken: this.state.collaborationToken || undefined },
				{ editor: this.props.editor }
			);
			toast.success("Asset lock renewed.");
			await this._refreshAssetLocks();
			if (this.state.assetLockPath === lock.path) {
				await this._inspectAssetLockPolicy();
			}
		} catch (error: any) {
			this.setState({ assetLockError: error.message });
		} finally {
			this.setState({ assetLockBusy: false });
		}
	}

	private async _releaseAssetLock(lock: any): Promise<void> {
		this.setState({ assetLockBusy: true, assetLockError: null });
		try {
			await releaseProjectAssetLock(
				this.props.object,
				{ path: lock.path, lockId: lock.lockId, collaborationToken: this.state.collaborationToken || undefined },
				{ editor: this.props.editor }
			);
			toast.success("Asset lock released.");
			await this._refreshAssetLocks();
			if (this.state.assetLockPath === lock.path) {
				await this._inspectAssetLockPolicy();
			}
		} catch (error: any) {
			this.setState({ assetLockError: error.message });
		} finally {
			this.setState({ assetLockBusy: false });
		}
	}

	private _getProjectChangelistsComponent(): ReactNode {
		const selected = this.state.projectChangelists.find((changelist) => changelist.id === this.state.changelistSelectedId);
		return (
			<EditorInspectorSectionField
				title="Project Changelists"
				tooltip="Persistent project-local work groups with exclusive file assignment. Deleted/missing file paths remain trackable, while one path cannot belong to two changelists unless explicitly reassigned through MCP."
			>
				<div className="grid grid-cols-2 gap-2">
					<Input
						value={this.state.changelistName}
						onChange={(event) => this.setState({ changelistName: event.target.value })}
						placeholder="Name"
						aria-label="Changelist name"
					/>
					<Input
						value={this.state.changelistOwner}
						onChange={(event) => this.setState({ changelistOwner: event.target.value })}
						placeholder="Owner"
						aria-label="Changelist owner"
					/>
					<Input
						className="col-span-2"
						value={this.state.changelistDescription}
						onChange={(event) => this.setState({ changelistDescription: event.target.value })}
						placeholder="Description (optional)"
						aria-label="Changelist description"
					/>
				</div>
				<div className="grid grid-cols-2 gap-2">
					<Button size="sm" disabled={this.state.changelistBusy} onClick={() => void this._createProjectChangelist()}>
						Create Changelist
					</Button>
					<Button size="sm" variant="secondary" disabled={this.state.changelistBusy} onClick={() => void this._refreshProjectChangelists()}>
						Refresh
					</Button>
				</div>
				{this.state.changelistError && <div className="px-2 text-xs text-destructive">{this.state.changelistError}</div>}
				{this.state.projectChangelists.length === 0 && <div className="px-2 text-xs text-muted-foreground">No project changelists.</div>}
				{this.state.projectChangelists.map((changelist) => (
					<div key={changelist.id} className={`space-y-1 rounded-lg p-2 text-xs ${selected?.id === changelist.id ? "bg-primary/10" : "bg-muted-foreground/10"}`}>
						<div className="flex justify-between gap-2">
							<span className="truncate font-medium">{changelist.name}</span>
							<span className="shrink-0 text-muted-foreground">{changelist.owner}</span>
						</div>
						<div className="text-muted-foreground">
							{changelist.paths.length} file{changelist.paths.length === 1 ? "" : "s"}
							{changelist.description ? ` · ${changelist.description}` : ""}
						</div>
						<div className="grid grid-cols-2 gap-2">
							<Button
								size="sm"
								variant="secondary"
								disabled={this.state.changelistBusy}
								onClick={() => this.setState({ changelistSelectedId: changelist.id, changelistPaths: changelist.paths.join("\n"), changelistError: null })}
							>
								Edit Files
							</Button>
							<Button size="sm" variant="destructive" disabled={this.state.changelistBusy} onClick={() => void this._deleteProjectChangelist(changelist)}>
								{changelist.paths.length ? "Delete + Unassign" : "Delete"}
							</Button>
						</div>
					</div>
				))}
				{selected && (
					<div className="space-y-2 rounded-lg border border-border p-2">
						<div className="text-xs font-medium">Files · {selected.name}</div>
						<Textarea
							value={this.state.changelistPaths}
							onChange={(event) => this.setState({ changelistPaths: event.target.value })}
							placeholder={"assets/hero.glb\nassets/hero.prefab"}
							aria-label="Changelist project-relative files"
						/>
						<Button size="sm" className="w-full" disabled={this.state.changelistBusy} onClick={() => void this._saveProjectChangelistFiles(selected)}>
							Replace Assigned Files
						</Button>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private async _refreshProjectChangelists(): Promise<void> {
		try {
			const result = await listProjectChangelists(this.props.object, {}, { editor: this.props.editor });
			const selected = result.changelists.find((changelist: any) => changelist.id === this.state.changelistSelectedId);
			this.setState({
				projectChangelists: result.changelists,
				changelistSelectedId: selected?.id ?? "",
				changelistPaths: selected ? selected.paths.join("\n") : "",
				changelistError: null,
			});
		} catch (error: any) {
			this.setState({ projectChangelists: [], changelistError: error.message });
		}
	}

	private async _createProjectChangelist(): Promise<void> {
		this.setState({ changelistBusy: true, changelistError: null });
		try {
			const result = await createProjectChangelist(
				this.props.object,
				{ name: this.state.changelistName, owner: this.state.changelistOwner, description: this.state.changelistDescription },
				{ editor: this.props.editor }
			);
			this.setState({ changelistSelectedId: result.changelist.id, changelistPaths: "" });
			toast.success("Project changelist created.");
			await this._refreshProjectChangelists();
		} catch (error: any) {
			this.setState({ changelistError: error.message });
		} finally {
			this.setState({ changelistBusy: false });
		}
	}

	private async _saveProjectChangelistFiles(changelist: any): Promise<void> {
		this.setState({ changelistBusy: true, changelistError: null });
		try {
			const paths = this.state.changelistPaths
				.split(/\r?\n/)
				.map((path) => path.trim())
				.filter(Boolean);
			await setProjectChangelistFiles(this.props.object, { id: changelist.id, mode: "replace", paths }, { editor: this.props.editor });
			toast.success("Changelist files updated.");
			await this._refreshProjectChangelists();
		} catch (error: any) {
			this.setState({ changelistError: error.message });
		} finally {
			this.setState({ changelistBusy: false });
		}
	}

	private async _deleteProjectChangelist(changelist: any): Promise<void> {
		this.setState({ changelistBusy: true, changelistError: null });
		try {
			await deleteProjectChangelist(this.props.object, { id: changelist.id, force: changelist.paths.length > 0 }, { editor: this.props.editor });
			toast.success("Project changelist deleted.");
			await this._refreshProjectChangelists();
		} catch (error: any) {
			this.setState({ changelistError: error.message });
		} finally {
			this.setState({ changelistBusy: false });
		}
	}

	private _getCollaborationTransformRevisionComponent(): ReactNode {
		const revision = this.state.collaborationRevision;
		return (
			<EditorInspectorSectionField
				title="Concurrent Transform Revisions"
				tooltip="Inspect a live node revision and apply an optimistic-concurrency transform. A stale revision reports a conflict instead of overwriting another editor's work."
			>
				<Input
					value={this.state.collaborationRevisionNodeId}
					onChange={(event) => this.setState({ collaborationRevisionNodeId: event.target.value })}
					placeholder="Node id"
					aria-label="Concurrent transform node id"
				/>
				<Button
					className="w-full"
					size="sm"
					variant="secondary"
					disabled={this.state.collaborationRevisionBusy}
					onClick={() => void this._inspectCollaborationTransformRevision()}
				>
					Inspect live revision
				</Button>
				{revision && (
					<div className="space-y-2 rounded bg-muted-foreground/10 p-2 text-xs">
						<div className="font-medium">
							{revision.nodeName} · revision {revision.revision}
						</div>
						<div className="break-all text-muted-foreground">{JSON.stringify(revision.transform)}</div>
						<Input
							value={this.state.collaborationRevisionPosition}
							onChange={(event) => this.setState({ collaborationRevisionPosition: event.target.value })}
							placeholder="Position x, y, z"
							aria-label="Revision guarded position"
						/>
						<Button className="w-full" size="sm" disabled={this.state.collaborationRevisionBusy} onClick={() => void this._applyCollaborationTransformRevision()}>
							Apply guarded position
						</Button>
					</div>
				)}
				{this.state.collaborationRevisionError && <div className="px-2 text-xs text-destructive">{this.state.collaborationRevisionError}</div>}
			</EditorInspectorSectionField>
		);
	}

	private async _inspectCollaborationTransformRevision(): Promise<void> {
		this.setState({ collaborationRevisionBusy: true, collaborationRevisionError: null });
		try {
			const collaborationRevision = await getCollaborationNodeRevision(this.props.object, { nodeId: this.state.collaborationRevisionNodeId }, { editor: this.props.editor });
			this.setState({
				collaborationRevision,
				collaborationRevisionPosition: collaborationRevision.transform.position?.join(", ") ?? "",
			});
		} catch (error: any) {
			this.setState({ collaborationRevision: null, collaborationRevisionError: error.message });
		} finally {
			this.setState({ collaborationRevisionBusy: false });
		}
	}

	private async _applyCollaborationTransformRevision(): Promise<void> {
		const revision = this.state.collaborationRevision;
		const position = this.state.collaborationRevisionPosition.split(",").map((entry) => Number(entry.trim()));
		if (!revision || position.length !== 3 || position.some((entry) => !Number.isFinite(entry))) {
			this.setState({ collaborationRevisionError: "Inspect a node and enter three finite comma-separated position values." });
			return;
		}
		this.setState({ collaborationRevisionBusy: true, collaborationRevisionError: null });
		try {
			const result = await applyCollaborativeNodeTransform(
				this.props.object,
				{
					nodeId: revision.nodeId,
					expectedRevision: revision.revision,
					operationId: `scene-inspector-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					position,
				},
				{ editor: this.props.editor }
			);
			this.setState({ collaborationRevision: result.current });
			if (result.status === "conflict") {
				this.setState({ collaborationRevisionError: "The node changed in another client. The live revision is shown; review it before retrying." });
			} else {
				toast.success(`Applied transform revision ${result.current.revision}.`);
			}
		} catch (error: any) {
			this.setState({ collaborationRevisionError: error.message });
		} finally {
			this.setState({ collaborationRevisionBusy: false });
		}
	}

	private _getCollaborationNodeEditRevisionComponent(): ReactNode {
		const revision = this.state.collaborationNodeEditRevision;
		return (
			<EditorInspectorSectionField
				title="Concurrent Node-State Revisions"
				tooltip="Inspect and compare-and-set common non-transform node state. Stale enabled, visibility, material, classification, collision, picking, gravity, or shadow edits return the live state instead of overwriting another client."
			>
				<div className="px-2 text-xs text-muted-foreground">Uses the node id entered in Concurrent Transform Revisions above.</div>
				<Button
					className="w-full"
					size="sm"
					variant="secondary"
					disabled={this.state.collaborationNodeEditBusy}
					onClick={() => void this._inspectCollaborationNodeEditRevision()}
				>
					Inspect node-state revision
				</Button>
				{revision && (
					<div className="space-y-2 rounded bg-muted-foreground/10 p-2 text-xs">
						<div className="font-medium">
							{revision.nodeName} · revision {revision.revision}
						</div>
						<div className="break-all text-muted-foreground">{JSON.stringify(revision.state)}</div>
						<div className="grid grid-cols-2 gap-2">
							<Button
								size="sm"
								disabled={this.state.collaborationNodeEditBusy}
								onClick={() => void this._applyCollaborationNodeEdit({ enabled: !revision.state.enabled })}
							>
								{revision.state.enabled ? "Disable guarded" : "Enable guarded"}
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={this.state.collaborationNodeEditBusy || revision.state.visible === undefined}
								onClick={() => void this._applyCollaborationNodeEdit({ visible: !revision.state.visible })}
							>
								{revision.state.visible === false ? "Show guarded" : "Hide guarded"}
							</Button>
						</div>
					</div>
				)}
				{this.state.collaborationNodeEditError && <div className="px-2 text-xs text-destructive">{this.state.collaborationNodeEditError}</div>}
			</EditorInspectorSectionField>
		);
	}

	private async _inspectCollaborationNodeEditRevision(): Promise<void> {
		this.setState({ collaborationNodeEditBusy: true, collaborationNodeEditError: null });
		try {
			const collaborationNodeEditRevision = await getCollaborationNodeEditRevision(
				this.props.object,
				{ nodeId: this.state.collaborationRevisionNodeId },
				{ editor: this.props.editor }
			);
			this.setState({ collaborationNodeEditRevision });
		} catch (error: any) {
			this.setState({ collaborationNodeEditRevision: null, collaborationNodeEditError: error.message });
		} finally {
			this.setState({ collaborationNodeEditBusy: false });
		}
	}

	private async _applyCollaborationNodeEdit(patch: Record<string, boolean>): Promise<void> {
		const revision = this.state.collaborationNodeEditRevision;
		if (!revision) {
			this.setState({ collaborationNodeEditError: "Inspect a node-state revision before applying a guarded edit." });
			return;
		}
		this.setState({ collaborationNodeEditBusy: true, collaborationNodeEditError: null });
		try {
			const result = await applyCollaborativeNodeEdit(
				this.props.object,
				{
					nodeId: revision.nodeId,
					expectedRevision: revision.revision,
					operationId: `scene-inspector-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					...patch,
				},
				{ editor: this.props.editor }
			);
			this.setState({ collaborationNodeEditRevision: result.current });
			if (result.status === "conflict") {
				this.setState({ collaborationNodeEditError: "The node state changed in another client. Review the live state shown before retrying." });
			} else {
				toast.success(`Applied node-state revision ${result.current.revision}.`);
			}
		} catch (error: any) {
			this.setState({ collaborationNodeEditError: error.message });
		} finally {
			this.setState({ collaborationNodeEditBusy: false });
		}
	}

	private _getCollaborationStructureRevisionComponent(): ReactNode {
		const hierarchy = this.state.collaborationStructureHierarchy;
		const properties = this.state.collaborationStructureProperties;
		return (
			<EditorInspectorSectionField
				title="Concurrent Hierarchy & Properties"
				tooltip="Revision-guard parent changes and bounded existing property paths. Unsafe prototype, identity, transform, material, metadata, and dedicated node-state paths are rejected."
			>
				<div className="px-2 text-xs text-muted-foreground">Uses the node id entered in Concurrent Transform Revisions.</div>
				<div className="grid grid-cols-2 gap-2">
					<Button size="sm" variant="secondary" disabled={this.state.collaborationStructureBusy} onClick={() => void this._inspectCollaborationHierarchy()}>
						Inspect hierarchy
					</Button>
					<Input
						value={this.state.collaborationStructureParentId}
						onChange={(event) => this.setState({ collaborationStructureParentId: event.target.value })}
						placeholder="Parent id; blank=root"
						aria-label="Guarded hierarchy parent id"
					/>
				</div>
				{hierarchy && (
					<Button className="w-full" size="sm" disabled={this.state.collaborationStructureBusy} onClick={() => void this._applyCollaborationHierarchy()}>
						Apply guarded parent · revision {hierarchy.revision}
					</Button>
				)}
				<Input
					value={this.state.collaborationStructurePaths}
					onChange={(event) => this.setState({ collaborationStructurePaths: event.target.value })}
					placeholder="Property paths, comma-separated"
					aria-label="Guarded property paths"
				/>
				<Button
					className="w-full"
					size="sm"
					variant="secondary"
					disabled={this.state.collaborationStructureBusy}
					onClick={() => void this._inspectCollaborationProperties()}
				>
					Inspect property revision
				</Button>
				{properties && (
					<>
						<div className="rounded bg-muted-foreground/10 p-2 text-xs">
							<div className="font-medium">Property revision {properties.revision}</div>
							<div className="break-all text-muted-foreground">{JSON.stringify(properties.values)}</div>
						</div>
						<Textarea
							value={this.state.collaborationStructureValues}
							onChange={(event) => this.setState({ collaborationStructureValues: event.target.value })}
							aria-label="Guarded property values JSON"
						/>
						<Button className="w-full" size="sm" disabled={this.state.collaborationStructureBusy} onClick={() => void this._applyCollaborationProperties()}>
							Apply guarded properties
						</Button>
					</>
				)}
				{this.state.collaborationStructureError && <div className="px-2 text-xs text-destructive">{this.state.collaborationStructureError}</div>}
			</EditorInspectorSectionField>
		);
	}

	private _collaborationPropertyPaths(): string[] {
		return this.state.collaborationStructurePaths
			.split(",")
			.map((path) => path.trim())
			.filter(Boolean);
	}

	private async _inspectCollaborationHierarchy(): Promise<void> {
		this.setState({ collaborationStructureBusy: true, collaborationStructureError: null });
		try {
			const collaborationStructureHierarchy = await getCollaborationHierarchyRevision(
				this.props.object,
				{ nodeId: this.state.collaborationRevisionNodeId },
				{ editor: this.props.editor }
			);
			this.setState({ collaborationStructureHierarchy, collaborationStructureParentId: collaborationStructureHierarchy.hierarchy.parentId ?? "" });
		} catch (error: any) {
			this.setState({ collaborationStructureHierarchy: null, collaborationStructureError: error.message });
		} finally {
			this.setState({ collaborationStructureBusy: false });
		}
	}

	private async _applyCollaborationHierarchy(): Promise<void> {
		const revision = this.state.collaborationStructureHierarchy;
		if (!revision) {
			return;
		}
		this.setState({ collaborationStructureBusy: true, collaborationStructureError: null });
		try {
			const result = await applyCollaborativeHierarchyEdit(
				this.props.object,
				{
					nodeId: revision.nodeId,
					parentId: this.state.collaborationStructureParentId.trim() || null,
					expectedRevision: revision.revision,
					operationId: `scene-inspector-hierarchy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				},
				{ editor: this.props.editor }
			);
			this.setState({ collaborationStructureHierarchy: result.current });
			if (result.status === "conflict") {
				this.setState({ collaborationStructureError: "Hierarchy changed in another client. Review the live parent before retrying." });
			} else {
				toast.success(`Applied hierarchy revision ${result.current.revision}.`);
			}
		} catch (error: any) {
			this.setState({ collaborationStructureError: error.message });
		} finally {
			this.setState({ collaborationStructureBusy: false });
		}
	}

	private async _inspectCollaborationProperties(): Promise<void> {
		this.setState({ collaborationStructureBusy: true, collaborationStructureError: null });
		try {
			const collaborationStructureProperties = await getCollaborationNodePropertyRevision(
				this.props.object,
				{ nodeId: this.state.collaborationRevisionNodeId, paths: this._collaborationPropertyPaths() },
				{ editor: this.props.editor }
			);
			this.setState({ collaborationStructureProperties, collaborationStructureValues: JSON.stringify(collaborationStructureProperties.values, null, "\t") });
		} catch (error: any) {
			this.setState({ collaborationStructureProperties: null, collaborationStructureError: error.message });
		} finally {
			this.setState({ collaborationStructureBusy: false });
		}
	}

	private async _applyCollaborationProperties(): Promise<void> {
		const revision = this.state.collaborationStructureProperties;
		if (!revision) {
			return;
		}
		this.setState({ collaborationStructureBusy: true, collaborationStructureError: null });
		try {
			const values = JSON.parse(this.state.collaborationStructureValues);
			const result = await applyCollaborativeNodeProperties(
				this.props.object,
				{
					nodeId: revision.nodeId,
					expectedRevision: revision.revision,
					operationId: `scene-inspector-properties-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					properties: values,
				},
				{ editor: this.props.editor }
			);
			this.setState({ collaborationStructureProperties: result.current, collaborationStructureValues: JSON.stringify(result.current.values, null, "\t") });
			if (result.status === "conflict") {
				this.setState({ collaborationStructureError: "Properties changed in another client. Review the live values before retrying." });
			} else {
				toast.success(`Applied property revision ${result.current.revision}.`);
			}
		} catch (error: any) {
			this.setState({ collaborationStructureError: error.message });
		} finally {
			this.setState({ collaborationStructureBusy: false });
		}
	}

	private _getCollaborativeTextComponent(): ReactNode {
		const document = this.state.collaborativeTextDocument;
		return (
			<EditorInspectorSectionField
				title="Collaborative Text (CRDT)"
				tooltip="Conflict-free RGA character editing for project scripts, shaders, JSON, markup, styles, Markdown, and text. External file edits require an explicit hash-guarded rebase."
			>
				<Input
					value={this.state.collaborativeTextPath}
					onChange={(event) => this.setState({ collaborativeTextPath: event.target.value })}
					placeholder="src/scripts.ts"
					aria-label="Collaborative text project path"
				/>
				<Button className="w-full" size="sm" variant="secondary" disabled={this.state.collaborativeTextBusy} onClick={() => void this._loadCollaborativeText()}>
					Load collaborative document
				</Button>
				{document && (
					<div className="space-y-2 text-xs">
						<div className={`rounded p-2 ${document.diverged ? "bg-destructive/10" : "bg-emerald-500/10"}`}>
							Revision {document.revision} · {document.totalCharacters} characters · {document.tombstoneCount} tombstones
							{document.diverged ? " · external file changed" : " · synchronized"}
						</div>
						<pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-input p-2 text-[11px]">{document.text}</pre>
						<Textarea
							value={this.state.collaborativeTextAppend}
							onChange={(event) => this.setState({ collaborativeTextAppend: event.target.value })}
							placeholder="Text to append conflict-free"
							aria-label="Collaborative text append value"
						/>
						<div className="grid grid-cols-2 gap-2">
							<Button
								size="sm"
								disabled={this.state.collaborativeTextBusy || document.diverged || !this.state.collaborativeTextAppend}
								onClick={() => void this._appendCollaborativeText()}
							>
								Append CRDT text
							</Button>
							<Button
								size="sm"
								variant="destructive"
								disabled={this.state.collaborativeTextBusy || !document.diverged}
								onClick={() => void this._rebaseCollaborativeText()}
							>
								Rebase external file
							</Button>
						</div>
					</div>
				)}
				{this.state.collaborativeTextError && <div className="px-2 text-xs text-destructive">{this.state.collaborativeTextError}</div>}
			</EditorInspectorSectionField>
		);
	}

	private async _loadCollaborativeText(): Promise<void> {
		this.setState({ collaborativeTextBusy: true, collaborativeTextError: null });
		try {
			const collaborativeTextDocument = await getCollaborativeTextDocument(
				this.props.object,
				{ path: this.state.collaborativeTextPath, limit: 5000 },
				{ editor: this.props.editor }
			);
			this.setState({ collaborativeTextDocument });
		} catch (error: any) {
			this.setState({ collaborativeTextDocument: null, collaborativeTextError: error.message });
		} finally {
			this.setState({ collaborativeTextBusy: false });
		}
	}

	private async _appendCollaborativeText(): Promise<void> {
		const document = this.state.collaborativeTextDocument;
		if (!document || !this.state.collaborativeTextAppend) {
			return;
		}
		this.setState({ collaborativeTextBusy: true, collaborativeTextError: null });
		try {
			const tail = document.totalCharacters
				? await getCollaborativeTextDocument(this.props.object, { path: document.path, offset: document.totalCharacters - 1, limit: 1 }, { editor: this.props.editor })
				: null;
			const result = await applyCollaborativeTextOperations(
				this.props.object,
				{
					path: document.path,
					actorId: this.state.collaborationToken ? undefined : "scene-inspector",
					collaborationToken: this.state.collaborationToken || undefined,
					operationId: `scene-inspector-text-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					operations: [{ type: "insert", afterId: tail?.items[0]?.id ?? null, text: this.state.collaborativeTextAppend }],
				},
				{ editor: this.props.editor }
			);
			if (result.status === "externalConflict") {
				this.setState({ collaborativeTextError: "The file changed outside the CRDT. Reload and explicitly rebase after reviewing it." });
			} else {
				this.setState({ collaborativeTextAppend: "" });
				toast.success(`Applied collaborative text revision ${result.revision}.`);
			}
			await this._loadCollaborativeText();
		} catch (error: any) {
			this.setState({ collaborativeTextError: error.message });
		} finally {
			this.setState({ collaborativeTextBusy: false });
		}
	}

	private async _rebaseCollaborativeText(): Promise<void> {
		const document = this.state.collaborativeTextDocument;
		if (!document?.diverged) {
			return;
		}
		this.setState({ collaborativeTextBusy: true, collaborativeTextError: null });
		try {
			await rebaseCollaborativeTextDocument(this.props.object, { path: document.path, expectedSourceHash: document.actualSourceHash }, { editor: this.props.editor });
			toast.success("Collaborative document rebased from the external file.");
			await this._loadCollaborativeText();
		} catch (error: any) {
			this.setState({ collaborativeTextError: error.message });
		} finally {
			this.setState({ collaborativeTextBusy: false });
		}
	}

	private _getCollaborativeCollectionComponent(): ReactNode {
		const document = this.state.collaborativeCollectionDocument;
		return (
			<EditorInspectorSectionField
				title="Collaborative Ordered Collection (CRDT)"
				tooltip="Stable-ID ordered JSON collections stored in scene metadata. Concurrent inserts converge deterministically; updates, moves, and tombstone deletes remain retry-safe."
			>
				<Input
					value={this.state.collaborativeCollectionName}
					onChange={(event) => this.setState({ collaborativeCollectionName: event.target.value })}
					placeholder="SharedSequence"
					aria-label="Collaborative collection name"
				/>
				<Button className="w-full" size="sm" variant="secondary" disabled={this.state.collaborativeCollectionBusy} onClick={() => void this._loadCollaborativeCollection()}>
					Load ordered collection
				</Button>
				{document && (
					<div className="space-y-2 text-xs">
						<div className={`rounded p-2 ${document.diverged ? "bg-destructive/10" : "bg-emerald-500/10"}`}>
							Revision {document.revision} · {document.total} items · {document.tombstones} tombstones
							{document.diverged ? " · scene metadata changed externally" : " · synchronized"}
						</div>
						<pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-input p-2 text-[11px]">{JSON.stringify(document.items, null, "\t")}</pre>
						<Textarea
							value={this.state.collaborativeCollectionValue}
							onChange={(event) => this.setState({ collaborativeCollectionValue: event.target.value })}
							placeholder="JSON value to append"
							aria-label="Collaborative collection JSON value"
						/>
						<div className="grid grid-cols-2 gap-2">
							<Button size="sm" disabled={this.state.collaborativeCollectionBusy || document.diverged} onClick={() => void this._appendCollaborativeCollectionItem()}>
								Append JSON item
							</Button>
							<Button
								size="sm"
								variant="destructive"
								disabled={this.state.collaborativeCollectionBusy || document.diverged || document.total === 0}
								onClick={() => void this._deleteLastCollaborativeCollectionItem()}
							>
								Delete last item
							</Button>
						</div>
						<Button
							className="w-full"
							size="sm"
							variant="destructive"
							disabled={this.state.collaborativeCollectionBusy || !document.diverged}
							onClick={() => void this._rebaseCollaborativeCollection()}
						>
							Rebase external scene values
						</Button>
					</div>
				)}
				{this.state.collaborativeCollectionError && <div className="px-2 text-xs text-destructive">{this.state.collaborativeCollectionError}</div>}
			</EditorInspectorSectionField>
		);
	}

	private async _loadCollaborativeCollection(): Promise<void> {
		this.setState({ collaborativeCollectionBusy: true, collaborativeCollectionError: null });
		try {
			const collaborativeCollectionDocument = await getCollaborativeOrderedCollection(
				this.props.object,
				{ name: this.state.collaborativeCollectionName, limit: 1000 },
				{ editor: this.props.editor }
			);
			this.setState({ collaborativeCollectionDocument });
		} catch (error: any) {
			this.setState({ collaborativeCollectionDocument: null, collaborativeCollectionError: error.message });
		} finally {
			this.setState({ collaborativeCollectionBusy: false });
		}
	}

	private async _appendCollaborativeCollectionItem(): Promise<void> {
		const document = this.state.collaborativeCollectionDocument;
		if (!document) {
			return;
		}
		this.setState({ collaborativeCollectionBusy: true, collaborativeCollectionError: null });
		try {
			const value = JSON.parse(this.state.collaborativeCollectionValue);
			const tail = document.total
				? await getCollaborativeOrderedCollection(this.props.object, { name: document.name, offset: document.total - 1, limit: 1 }, { editor: this.props.editor })
				: null;
			const result = await applyCollaborativeOrderedCollectionOperations(
				this.props.object,
				{
					name: document.name,
					actorId: this.state.collaborationToken ? undefined : "scene-inspector",
					collaborationToken: this.state.collaborationToken || undefined,
					operationId: `scene-inspector-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					operations: [{ type: "insert", afterId: tail?.items[0]?.id ?? null, value }],
				},
				{ editor: this.props.editor }
			);
			if (result.status === "externalConflict") {
				this.setState({ collaborativeCollectionError: "Scene metadata changed outside the CRDT. Review and explicitly rebase it." });
			} else {
				toast.success(`Applied ordered collection revision ${result.revision}.`);
			}
			await this._loadCollaborativeCollection();
		} catch (error: any) {
			this.setState({ collaborativeCollectionError: error.message });
		} finally {
			this.setState({ collaborativeCollectionBusy: false });
		}
	}

	private async _deleteLastCollaborativeCollectionItem(): Promise<void> {
		const document = this.state.collaborativeCollectionDocument;
		if (!document || !document.total) {
			return;
		}
		this.setState({ collaborativeCollectionBusy: true, collaborativeCollectionError: null });
		try {
			const tail = await getCollaborativeOrderedCollection(this.props.object, { name: document.name, offset: document.total - 1, limit: 1 }, { editor: this.props.editor });
			const id = tail.items[0]?.id;
			if (!id) {
				throw new Error("The final ordered collection item could not be resolved.");
			}
			await applyCollaborativeOrderedCollectionOperations(
				this.props.object,
				{
					name: document.name,
					actorId: this.state.collaborationToken ? undefined : "scene-inspector",
					collaborationToken: this.state.collaborationToken || undefined,
					operationId: `scene-inspector-list-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					operations: [{ type: "delete", id }],
				},
				{ editor: this.props.editor }
			);
			await this._loadCollaborativeCollection();
			toast.success("Deleted the final ordered collection item.");
		} catch (error: any) {
			this.setState({ collaborativeCollectionError: error.message });
		} finally {
			this.setState({ collaborativeCollectionBusy: false });
		}
	}

	private async _rebaseCollaborativeCollection(): Promise<void> {
		const document = this.state.collaborativeCollectionDocument;
		if (!document?.diverged) {
			return;
		}
		this.setState({ collaborativeCollectionBusy: true, collaborativeCollectionError: null });
		try {
			await rebaseCollaborativeOrderedCollection(this.props.object, { name: document.name, expectedSourceHash: document.actualSourceHash }, { editor: this.props.editor });
			toast.success("Ordered collection rebased from scene metadata.");
			await this._loadCollaborativeCollection();
		} catch (error: any) {
			this.setState({ collaborativeCollectionError: error.message });
		} finally {
			this.setState({ collaborativeCollectionBusy: false });
		}
	}

	private _getProjectCollaborationComponent(): ReactNode {
		const status = this.state.collaborationStatus;
		const actor = status?.actor;
		const isAdmin = actor?.member.role === "admin";
		return (
			<EditorInspectorSectionField
				title="Project Collaboration"
				tooltip="Opt-in project roles and expiring cross-client presence. Viewers are centrally restricted to read-only MCP endpoints; editors can author content; admins manage access."
			>
				{!status?.enforcementEnabled ? (
					<>
						<Input
							value={this.state.collaborationBootstrapName}
							onChange={(event) => this.setState({ collaborationBootstrapName: event.target.value })}
							placeholder="Administrator name"
							aria-label="Collaboration bootstrap administrator name"
						/>
						<Button className="w-full" size="sm" disabled={this.state.collaborationBusy} onClick={() => void this._enableProjectCollaboration()}>
							Enable roles and presence
						</Button>
					</>
				) : !actor ? (
					<>
						<div className="px-2 text-xs text-muted-foreground">Enforcement is active. Join with a member id and one-time access key.</div>
						<Input
							value={this.state.collaborationJoinMemberId}
							onChange={(event) => this.setState({ collaborationJoinMemberId: event.target.value })}
							placeholder="Member UUID"
							aria-label="Collaboration member id"
						/>
						<Input
							type="password"
							value={this.state.collaborationJoinAccessKey}
							onChange={(event) => this.setState({ collaborationJoinAccessKey: event.target.value })}
							placeholder="Access key"
							aria-label="Collaboration access key"
						/>
						<Input
							value={this.state.collaborationClientName}
							onChange={(event) => this.setState({ collaborationClientName: event.target.value })}
							placeholder="Client name"
							aria-label="Collaboration client name"
						/>
						<Button className="w-full" size="sm" disabled={this.state.collaborationBusy} onClick={() => void this._joinProjectCollaboration()}>
							Join session
						</Button>
					</>
				) : (
					<div className="space-y-2 text-xs">
						<div className="rounded bg-emerald-500/10 p-2">
							<div className="font-medium">
								{actor.member.name} · {actor.member.role}
							</div>
							<div className="text-muted-foreground">Session expires {new Date(actor.expiresAt).toLocaleTimeString()}</div>
						</div>
						<div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-1">
							<Input
								type="color"
								value={this.state.collaborationPresenceColor.slice(0, 7)}
								onChange={(event) => this.setState({ collaborationPresenceColor: event.target.value.toUpperCase() })}
								aria-label="Collaboration presence color"
							/>
							<select
								className="h-8 rounded bg-input px-2 text-sm"
								value={this.state.collaborationToolMode}
								onChange={(event) => this.setState({ collaborationToolMode: event.target.value as IEditorSceneInspectorState["collaborationToolMode"] })}
								aria-label="Collaboration tool mode"
							>
								{["select", "move", "rotate", "scale", "rect", "paint", "terrain", "animate", "play", "navigate", "custom"].map((tool) => (
									<option key={tool} value={tool}>
										{tool}
									</option>
								))}
							</select>
						</div>
						<Input
							value={this.state.collaborationHoveredNodeId}
							onChange={(event) => this.setState({ collaborationHoveredNodeId: event.target.value })}
							placeholder="Hovered node id (optional)"
							aria-label="Collaboration hovered node id"
						/>
						<div className="grid grid-cols-2 gap-2">
							<Button size="sm" variant="secondary" disabled={this.state.collaborationBusy} onClick={() => void this._heartbeatProjectCollaboration()}>
								Heartbeat
							</Button>
							<Button size="sm" variant="secondary" disabled={this.state.collaborationBusy} onClick={() => void this._leaveProjectCollaboration()}>
								Leave
							</Button>
						</div>
						<div className="space-y-1 rounded bg-muted-foreground/10 p-2">
							<div className="font-medium">Presence ({this.state.collaborationPresence.length})</div>
							{this.state.collaborationPresence.map((entry) => (
								<div key={entry.sessionId} className="space-y-1 rounded bg-background/40 p-1">
									<div className="flex items-center justify-between gap-2">
										<span className="flex min-w-0 items-center gap-1 truncate">
											<span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
											{entry.memberName} · {entry.clientName}
										</span>
										<span className="shrink-0 text-muted-foreground">{entry.toolMode}</span>
									</div>
									<div className="text-muted-foreground">
										{entry.state} · {entry.selectionNodeIds.length} selected · {entry.pointers.length} pointer{entry.pointers.length === 1 ? "" : "s"}
										{entry.hoveredNodeId ? ` · hover ${entry.hoveredNodeId}` : ""}
									</div>
									{entry.primarySelectionNodeId && (
										<Button className="h-6 w-full" size="sm" variant="ghost" onClick={() => this._selectCollaboratorPrimary(entry.primarySelectionNodeId)}>
											Select {entry.primarySelectionNodeId}
										</Button>
									)}
								</div>
							))}
						</div>
						{isAdmin && (
							<div className="space-y-1 rounded bg-muted-foreground/10 p-2">
								<div className="font-medium">Members</div>
								{this.state.collaborationMembers.map((member) => (
									<div key={member.id} className="flex items-center gap-2">
										<span className="min-w-0 flex-1 truncate">
											{member.name} · {member.role} {member.enabled ? "" : "(disabled)"}
										</span>
										{member.id !== actor.member.id && (
											<Button
												size="sm"
												variant="ghost"
												className="h-6 px-1 hover:bg-destructive"
												onClick={() => void this._deleteProjectCollaborationMember(member.id)}
											>
												Remove
											</Button>
										)}
									</div>
								))}
								<div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-1">
									<Input
										value={this.state.collaborationNewMemberName}
										onChange={(event) => this.setState({ collaborationNewMemberName: event.target.value })}
										aria-label="New collaboration member name"
									/>
									<select
										className="h-8 rounded bg-input px-2 text-sm"
										value={this.state.collaborationNewMemberRole}
										onChange={(event) => this.setState({ collaborationNewMemberRole: event.target.value as "admin" | "editor" | "viewer" })}
										aria-label="New collaboration member role"
									>
										<option value="admin">Admin</option>
										<option value="editor">Editor</option>
										<option value="viewer">Viewer</option>
									</select>
								</div>
								<Button
									className="w-full"
									size="sm"
									variant="secondary"
									disabled={this.state.collaborationBusy}
									onClick={() => void this._createProjectCollaborationMember()}
								>
									Create member
								</Button>
								<Button
									className="w-full"
									size="sm"
									variant="ghost"
									disabled={this.state.collaborationBusy}
									onClick={() => void this._disableProjectCollaboration()}
								>
									Disable and reset collaboration
								</Button>
							</div>
						)}
					</div>
				)}
				{this.state.collaborationLastCredential && (
					<div className="space-y-1">
						<div className="px-2 text-xs font-medium">Copy this credential now; the access key is shown once.</div>
						<Textarea readOnly value={this.state.collaborationLastCredential} aria-label="One-time collaboration credential" />
					</div>
				)}
				{this.state.collaborationError && <div className="px-2 text-xs text-destructive">{this.state.collaborationError}</div>}
			</EditorInspectorSectionField>
		);
	}

	private async _refreshProjectCollaboration(token = this.state.collaborationToken): Promise<void> {
		try {
			const collaborationStatus = await getProjectCollaborationStatus(this.props.object, { collaborationToken: token || undefined }, { editor: this.props.editor });
			let collaborationMembers: any[] = [];
			let collaborationPresence: any[] = [];
			if (collaborationStatus.actor) {
				[collaborationMembers, collaborationPresence] = await Promise.all([
					listProjectCollaborationMembers(this.props.object, { collaborationToken: token }, { editor: this.props.editor }).then((result) => result.members),
					listProjectCollaborationPresence(this.props.object, { collaborationToken: token }, { editor: this.props.editor }).then((result) => result.presence),
				]);
			}
			this.setState({
				collaborationStatus,
				collaborationMembers,
				collaborationPresence,
				collaborationToken: collaborationStatus.actor ? token : "",
				collaborationError: null,
			});
			await this._refreshRemoteCollaboration(collaborationStatus.actor ? token : "");
		} catch (error: any) {
			this.setState({
				collaborationStatus: null,
				collaborationMembers: [],
				collaborationPresence: [],
				remoteCollaborationGateway: null,
				remoteCollaborationEvents: [],
				remoteCollaborationDiscovery: null,
				remoteCollaborationDiscoveredProjects: [],
				collaborationError: error.message,
			});
		}
	}

	private async _enableProjectCollaboration(): Promise<void> {
		this.setState({ collaborationBusy: true, collaborationError: null });
		try {
			const configured = await configureProjectCollaboration(
				this.props.object,
				{ enabled: true, bootstrapAdminName: this.state.collaborationBootstrapName },
				{ editor: this.props.editor }
			);
			const joined = await joinProjectCollaborationSession(
				this.props.object,
				{
					memberId: configured.bootstrap.member.id,
					accessKey: configured.bootstrap.accessKey,
					clientName: this.state.collaborationClientName,
					state: "editing scene",
					color: this.state.collaborationPresenceColor,
					toolMode: this.state.collaborationToolMode,
				},
				{ editor: this.props.editor }
			);
			const token = joined.session.token;
			this.setState({
				collaborationToken: token,
				collaborationJoinMemberId: configured.bootstrap.member.id,
				collaborationJoinAccessKey: configured.bootstrap.accessKey,
				collaborationLastCredential: `memberId=${configured.bootstrap.member.id}\naccessKey=${configured.bootstrap.accessKey}`,
			});
			await this._refreshProjectCollaboration(token);
			toast.success("Project collaboration enabled.");
		} catch (error: any) {
			this.setState({ collaborationError: error.message });
		} finally {
			this.setState({ collaborationBusy: false });
		}
	}

	private async _joinProjectCollaboration(): Promise<void> {
		this.setState({ collaborationBusy: true, collaborationError: null });
		try {
			const joined = await joinProjectCollaborationSession(
				this.props.object,
				{
					memberId: this.state.collaborationJoinMemberId,
					accessKey: this.state.collaborationJoinAccessKey,
					clientName: this.state.collaborationClientName,
					state: "editing scene",
					color: this.state.collaborationPresenceColor,
					toolMode: this.state.collaborationToolMode,
				},
				{ editor: this.props.editor }
			);
			this.setState({ collaborationToken: joined.session.token, collaborationJoinAccessKey: "", collaborationLastCredential: "" });
			await this._refreshProjectCollaboration(joined.session.token);
			toast.success("Collaboration session joined.");
		} catch (error: any) {
			this.setState({ collaborationError: error.message });
		} finally {
			this.setState({ collaborationBusy: false });
		}
	}

	private async _heartbeatProjectCollaboration(): Promise<void> {
		try {
			const selectionNodeIds = this.props.editor.layout.graph
				.getSelectedNodes()
				.map((entry) => (entry.nodeData as any)?.id)
				.filter((id): id is string => typeof id === "string" && id !== "__editor__scene__")
				.slice(0, 64);
			const activeCamera = this.props.object.activeCamera as any;
			let camera: any = null;
			if (activeCamera?.position?.asArray) {
				const target =
					typeof activeCamera.getTarget === "function"
						? activeCamera.getTarget()
						: activeCamera.position.add(activeCamera.getForwardRay?.().direction ?? { x: 0, y: 0, z: 1 });
				camera = {
					viewport: "scene",
					position: activeCamera.position.asArray(),
					target: target.asArray(),
					up: activeCamera.upVector?.asArray?.() ?? [0, 1, 0],
					...(typeof activeCamera.fov === "number" ? { fovDegrees: (activeCamera.fov * 180) / Math.PI } : {}),
				};
			}
			await heartbeatProjectCollaborationSession(
				this.props.object,
				{
					collaborationToken: this.state.collaborationToken,
					state: "editing scene",
					color: this.state.collaborationPresenceColor,
					toolMode: this.state.collaborationToolMode,
					selectionNodeIds,
					primarySelectionNodeId: selectionNodeIds[0] ?? null,
					hoveredNodeId: this.state.collaborationHoveredNodeId || null,
					camera,
				},
				{ editor: this.props.editor }
			);
			await this._refreshProjectCollaboration();
		} catch (error: any) {
			this.setState({ collaborationError: error.message });
		}
	}

	private _selectCollaboratorPrimary(nodeId: string): void {
		const node = this.props.object.getNodeById(nodeId);
		if (!node) {
			toast.error(`Collaborator selection is not loaded: ${nodeId}`);
			return;
		}
		this.props.editor.layout.graph.setSelectedNode(node);
	}

	private async _leaveProjectCollaboration(): Promise<void> {
		try {
			await leaveProjectCollaborationSession(this.props.object, { collaborationToken: this.state.collaborationToken }, { editor: this.props.editor });
			this.setState({ collaborationToken: "", collaborationLastCredential: "" });
			await this._refreshProjectCollaboration("");
		} catch (error: any) {
			this.setState({ collaborationError: error.message });
		}
	}

	private async _createProjectCollaborationMember(): Promise<void> {
		this.setState({ collaborationBusy: true, collaborationError: null });
		try {
			const result = await createProjectCollaborationMember(
				this.props.object,
				{
					name: this.state.collaborationNewMemberName,
					role: this.state.collaborationNewMemberRole,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({ collaborationLastCredential: `memberId=${result.member.id}\naccessKey=${result.accessKey}` });
			await this._refreshProjectCollaboration();
			toast.success("Collaboration member created.");
		} catch (error: any) {
			this.setState({ collaborationError: error.message });
		} finally {
			this.setState({ collaborationBusy: false });
		}
	}

	private async _deleteProjectCollaborationMember(id: string): Promise<void> {
		this.setState({ collaborationBusy: true, collaborationError: null });
		try {
			await deleteProjectCollaborationMember(this.props.object, { id, collaborationToken: this.state.collaborationToken }, { editor: this.props.editor });
			await this._refreshProjectCollaboration();
		} catch (error: any) {
			this.setState({ collaborationError: error.message });
		} finally {
			this.setState({ collaborationBusy: false });
		}
	}

	private async _disableProjectCollaboration(): Promise<void> {
		this.setState({ collaborationBusy: true, collaborationError: null });
		try {
			await configureProjectCollaboration(this.props.object, { enabled: false, collaborationToken: this.state.collaborationToken }, { editor: this.props.editor });
			this.setState({ collaborationToken: "", collaborationLastCredential: "" });
			await this._refreshProjectCollaboration("");
			toast.success("Project collaboration disabled and reset.");
		} catch (error: any) {
			this.setState({ collaborationError: error.message });
		} finally {
			this.setState({ collaborationBusy: false });
		}
	}

	private _getRemoteCollaborationComponent(): ReactNode {
		const actor = this.state.collaborationStatus?.actor;
		const gateway = this.state.remoteCollaborationGateway;
		const discovery = this.state.remoteCollaborationDiscovery;
		const relay = this.state.remoteCollaborationRelay;
		return (
			<EditorInspectorSectionField
				title="Remote Collaboration Gateway"
				tooltip="Opt-in authenticated HTTP/HTTPS actions plus a replayable SSE operation/presence stream. Non-loopback binding requires project-contained TLS files and explicit host/origin allowlists."
			>
				{!actor ? (
					<div className="px-2 text-xs text-muted-foreground">Join the project collaboration session above to inspect or configure the remote gateway.</div>
				) : (
					<>
						<div className={`rounded p-2 text-xs ${gateway?.running ? "bg-emerald-500/10" : "bg-muted-foreground/10"}`}>
							<div className="flex justify-between gap-2 font-medium">
								<span>{gateway?.running ? `${gateway.protocol.toUpperCase()} gateway running` : "Gateway stopped"}</span>
								<span>{gateway?.actualPort ?? this.state.remoteCollaborationPort}</span>
							</div>
							<div className="text-muted-foreground">
								{gateway?.eventCount ?? 0} retained events · {gateway?.subscriberCount ?? 0} live subscribers
							</div>
							<div className={gateway?.eventHistory?.healthy === false ? "text-destructive" : "text-muted-foreground"}>
								History {gateway?.eventHistory?.enabled ? "durable" : "memory-only"} · retention{" "}
								{gateway?.eventHistory?.retention ?? this.state.remoteCollaborationHistoryRetention}
								{gateway?.oldestSequence ? ` · sequences ${gateway.oldestSequence}–${gateway.latestSequence}` : " · empty"}
							</div>
							{gateway?.eventHistory?.recovery && <div className="text-amber-500">Recovered: {gateway.eventHistory.recovery}</div>}
							{gateway?.eventHistory?.error && <div className="text-destructive">Journal error: {gateway.eventHistory.error}</div>}
						</div>
						<div className={`rounded p-2 text-xs ${discovery?.advertising ? "bg-emerald-500/10" : "bg-muted-foreground/10"}`}>
							<div className="flex justify-between gap-2 font-medium">
								<span>{discovery?.advertising ? "LAN discovery advertising" : "LAN discovery idle"}</span>
								<span>{discovery?.config?.port ?? this.state.remoteCollaborationDiscoveryPort}</span>
							</div>
							<div className="text-muted-foreground">
								{discovery?.config?.displayName ?? this.state.remoteCollaborationDiscoveryDisplayName} · {discovery?.responseCount ?? 0} query responses
							</div>
							{discovery?.reason && <div className="text-muted-foreground">{discovery.reason}</div>}
							{discovery?.lastError && <div className="text-destructive">Discovery error: {discovery.lastError}</div>}
						</div>
						<div className={`rounded p-2 text-xs ${relay?.connected ? "bg-emerald-500/10" : "bg-muted-foreground/10"}`}>
							<div className="flex justify-between gap-2 font-medium">
								<span>Outbound relay {relay?.state ?? "disabled"}</span>
								<span>{relay?.receivedRequests ?? 0} requests</span>
							</div>
							{relay?.publicUrl && <div className="truncate text-muted-foreground">{relay.publicUrl}</div>}
							<div className="text-muted-foreground">
								Authentication {relay?.authentication?.source ?? "missing"} · {relay?.succeededRequests ?? 0} succeeded · {relay?.failedRequests ?? 0} failed
							</div>
							{relay?.lastError && <div className="text-destructive">Relay error: {relay.lastError}</div>}
						</div>
						{actor.member.role === "admin" && (
							<div className="space-y-1">
								<Input
									value={this.state.remoteCollaborationDiscoveryDisplayName}
									onChange={(event) => this.setState({ remoteCollaborationDiscoveryDisplayName: event.target.value })}
									placeholder="Project discovery label"
									aria-label="Remote collaboration discovery display name"
								/>
								<div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-1">
									<Input
										value={this.state.remoteCollaborationDiscoveryAddress}
										onChange={(event) => this.setState({ remoteCollaborationDiscoveryAddress: event.target.value })}
										placeholder="239.255.37.13"
										aria-label="Remote collaboration discovery address"
									/>
									<Input
										type="number"
										min={1024}
										max={65535}
										value={this.state.remoteCollaborationDiscoveryPort}
										onChange={(event) => this.setState({ remoteCollaborationDiscoveryPort: Number(event.target.value) })}
										aria-label="Remote collaboration discovery port"
									/>
								</div>
								<div className="grid grid-cols-2 gap-1">
									<Button
										size="sm"
										variant={this.state.remoteCollaborationDiscoveryEnabled ? "secondary" : "default"}
										disabled={this.state.remoteCollaborationBusy}
										onClick={() => void this._setRemoteCollaborationDiscovery(!this.state.remoteCollaborationDiscoveryEnabled)}
									>
										{this.state.remoteCollaborationDiscoveryEnabled ? "Disable discovery" : "Enable discovery"}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={this.state.remoteCollaborationBusy}
										onClick={() => void this._setRemoteCollaborationDiscovery(this.state.remoteCollaborationDiscoveryEnabled)}
									>
										Save discovery
									</Button>
								</div>
								<Input
									value={this.state.remoteCollaborationRelayUrl}
									onChange={(event) => this.setState({ remoteCollaborationRelayUrl: event.target.value })}
									placeholder="wss://relay.example/v1/editor"
									aria-label="Remote collaboration relay URL"
								/>
								<Input
									value={this.state.remoteCollaborationRelayProjectSlug}
									onChange={(event) => this.setState({ remoteCollaborationRelayProjectSlug: event.target.value })}
									placeholder="project-slug"
									aria-label="Remote collaboration relay project slug"
								/>
								<Input
									value={this.state.remoteCollaborationRelayTokenEnvironmentVariable}
									onChange={(event) => this.setState({ remoteCollaborationRelayTokenEnvironmentVariable: event.target.value })}
									placeholder="BABYLON_EDITOR_RELAY_TOKEN"
									aria-label="Remote collaboration relay token environment variable"
								/>
								<Input
									type="password"
									value={this.state.remoteCollaborationRelayAccessToken}
									onChange={(event) => this.setState({ remoteCollaborationRelayAccessToken: event.target.value })}
									placeholder="Live-only relay access token"
									aria-label="Remote collaboration relay access token"
								/>
								<div className="grid grid-cols-2 gap-1">
									<Button
										size="sm"
										variant={this.state.remoteCollaborationRelayEnabled ? "secondary" : "default"}
										disabled={this.state.remoteCollaborationBusy}
										onClick={() => void this._setRemoteCollaborationRelay(!this.state.remoteCollaborationRelayEnabled)}
									>
										{this.state.remoteCollaborationRelayEnabled ? "Disable relay" : "Enable relay"}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={this.state.remoteCollaborationBusy || !this.state.remoteCollaborationRelayEnabled}
										onClick={() => void this._reconnectRemoteCollaborationRelay()}
									>
										Reconnect relay
									</Button>
								</div>
								<div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-1">
									<Input
										type="number"
										min={100}
										max={10000}
										value={this.state.remoteCollaborationHistoryRetention}
										onChange={(event) => this.setState({ remoteCollaborationHistoryRetention: Number(event.target.value) })}
										aria-label="Remote collaboration event retention"
									/>
									<Button size="sm" variant="secondary" disabled={this.state.remoteCollaborationBusy} onClick={() => void this._setRemoteCollaborationHistory()}>
										{this.state.remoteCollaborationHistoryEnabled ? "Save history" : "Enable history"}
									</Button>
								</div>
								<div className="grid grid-cols-2 gap-1">
									<Button
										size="sm"
										variant="ghost"
										disabled={this.state.remoteCollaborationBusy}
										onClick={() =>
											this.setState(
												{ remoteCollaborationHistoryEnabled: !this.state.remoteCollaborationHistoryEnabled },
												() => void this._setRemoteCollaborationHistory()
											)
										}
									>
										{this.state.remoteCollaborationHistoryEnabled ? "Disable persistence" : "Enable persistence"}
									</Button>
									<Button
										size="sm"
										variant="destructive"
										disabled={this.state.remoteCollaborationBusy || !(gateway?.eventCount > 0)}
										onClick={() => void this._clearRemoteCollaborationHistory()}
									>
										Clear history
									</Button>
								</div>
								<div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-1">
									<Input
										value={this.state.remoteCollaborationBindAddress}
										onChange={(event) => this.setState({ remoteCollaborationBindAddress: event.target.value })}
										placeholder="127.0.0.1"
										aria-label="Remote collaboration bind address"
									/>
									<Input
										type="number"
										min={1024}
										max={65535}
										value={this.state.remoteCollaborationPort}
										onChange={(event) => this.setState({ remoteCollaborationPort: Number(event.target.value) })}
										aria-label="Remote collaboration port"
									/>
								</div>
								<Textarea
									value={this.state.remoteCollaborationAllowedHosts}
									onChange={(event) => this.setState({ remoteCollaborationAllowedHosts: event.target.value })}
									placeholder="editor.example:3713"
									aria-label="Remote collaboration allowed hosts"
								/>
								<Textarea
									value={this.state.remoteCollaborationAllowedOrigins}
									onChange={(event) => this.setState({ remoteCollaborationAllowedOrigins: event.target.value })}
									placeholder="https://team.example"
									aria-label="Remote collaboration allowed origins"
								/>
								<Input
									value={this.state.remoteCollaborationTlsCertificatePath}
									onChange={(event) => this.setState({ remoteCollaborationTlsCertificatePath: event.target.value })}
									placeholder="certs/editor.crt (required off-loopback)"
									aria-label="Remote collaboration TLS certificate path"
								/>
								<Input
									value={this.state.remoteCollaborationTlsPrivateKeyPath}
									onChange={(event) => this.setState({ remoteCollaborationTlsPrivateKeyPath: event.target.value })}
									placeholder="certs/editor.key (required off-loopback)"
									aria-label="Remote collaboration TLS private key path"
								/>
								<Textarea
									value={this.state.remoteCollaborationTlsHosts}
									onChange={(event) => this.setState({ remoteCollaborationTlsHosts: event.target.value })}
									placeholder="One DNS name or IP SAN per line"
									aria-label="Remote collaboration TLS hosts"
								/>
								<Input
									type="number"
									min={1}
									max={825}
									value={this.state.remoteCollaborationTlsValidityDays}
									onChange={(event) => this.setState({ remoteCollaborationTlsValidityDays: Number(event.target.value) })}
									aria-label="Remote collaboration TLS validity days"
								/>
								<div className="grid grid-cols-2 gap-1">
									<Button
										size="sm"
										variant="secondary"
										disabled={this.state.remoteCollaborationBusy}
										onClick={() => void this._generateRemoteCollaborationTlsCertificate()}
									>
										Generate / rotate TLS
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={this.state.remoteCollaborationBusy}
										onClick={() => void this._inspectRemoteCollaborationTlsCertificate()}
									>
										Inspect TLS
									</Button>
								</div>
								{this.state.remoteCollaborationTlsInfo && (
									<div
										className={`rounded p-2 text-xs ${this.state.remoteCollaborationTlsInfo.validNow && this.state.remoteCollaborationTlsInfo.keyMatches ? "bg-emerald-500/10" : "bg-destructive/10"}`}
									>
										<div>{this.state.remoteCollaborationTlsInfo.subject}</div>
										<div className="text-muted-foreground">SHA-256 {this.state.remoteCollaborationTlsInfo.fingerprint256}</div>
										<div className="text-muted-foreground">
											Expires {new Date(this.state.remoteCollaborationTlsInfo.validTo).toLocaleDateString()} ·{" "}
											{this.state.remoteCollaborationTlsInfo.daysRemaining} days · key{" "}
											{this.state.remoteCollaborationTlsInfo.keyMatches ? "matches" : "does not match"}
										</div>
										<div className="text-amber-500">
											Review the fingerprint before trusting this development certificate. OS trust is never changed automatically.
										</div>
									</div>
								)}
								<Button
									className="w-full"
									size="sm"
									variant={gateway?.running ? "ghost" : "default"}
									disabled={this.state.remoteCollaborationBusy}
									onClick={() => void this._setRemoteCollaborationGateway(!gateway?.running)}
								>
									{gateway?.running ? "Stop gateway" : "Start gateway"}
								</Button>
							</div>
						)}
						<div className="grid grid-cols-2 gap-1">
							<Button size="sm" variant="ghost" disabled={this.state.remoteCollaborationBusy} onClick={() => void this._refreshRemoteCollaboration()}>
								Refresh remote state
							</Button>
							<Button size="sm" variant="outline" disabled={this.state.remoteCollaborationBusy} onClick={() => void this._discoverRemoteCollaborationProjects()}>
								Discover projects now
							</Button>
						</div>
						{this.state.remoteCollaborationDiscoveredProjects.length > 0 && (
							<div className="max-h-32 space-y-1 overflow-auto rounded bg-muted-foreground/10 p-2 text-xs">
								{this.state.remoteCollaborationDiscoveredProjects.map((project) => (
									<div key={project.discoveryId}>
										<div className="font-medium">{project.displayName}</div>
										<div className="text-muted-foreground">{project.url}</div>
										{project.tlsFingerprint256 && <div className="truncate text-amber-500">TLS {project.tlsFingerprint256}</div>}
									</div>
								))}
							</div>
						)}
						<div className="max-h-40 space-y-1 overflow-auto rounded bg-muted-foreground/10 p-2 text-xs">
							{this.state.remoteCollaborationEvents.slice(-25).map((event) => (
								<div key={event.sequence} className="flex justify-between gap-2">
									<span className="min-w-0 truncate">
										#{event.sequence} {event.endpoint ?? event.type}
									</span>
									<span className={event.success ? "text-muted-foreground" : "text-destructive"}>{event.source}</span>
								</div>
							))}
						</div>
					</>
				)}
				{this.state.remoteCollaborationError && <div className="px-2 text-xs text-destructive">{this.state.remoteCollaborationError}</div>}
			</EditorInspectorSectionField>
		);
	}

	private async _refreshRemoteCollaboration(token = this.state.collaborationToken): Promise<void> {
		if (!token) {
			this.setState({
				remoteCollaborationGateway: null,
				remoteCollaborationEvents: [],
				remoteCollaborationDiscovery: null,
				remoteCollaborationDiscoveredProjects: [],
				remoteCollaborationRelay: null,
			});
			return;
		}
		try {
			const [remoteCollaborationGateway, eventResult, remoteCollaborationDiscovery, remoteCollaborationRelay] = await Promise.all([
				getRemoteCollaborationGateway(this.props.object, { collaborationToken: token }, { editor: this.props.editor }),
				listRemoteCollaborationEvents(this.props.object, { collaborationToken: token, afterSequence: 0, limit: 100 }, { editor: this.props.editor }),
				getRemoteCollaborationDiscovery(this.props.object, { collaborationToken: token }, { editor: this.props.editor }),
				getRemoteCollaborationRelay(this.props.object, { collaborationToken: token }, { editor: this.props.editor }),
			]);
			const config = remoteCollaborationGateway.config;
			const discoveryConfig = remoteCollaborationDiscovery.config;
			const relayConfig = remoteCollaborationRelay.config;
			const remoteCollaborationTlsInfo =
				config.tlsCertificatePath && config.tlsPrivateKeyPath
					? await inspectRemoteCollaborationTlsCertificate(
							this.props.object,
							{ certificatePath: config.tlsCertificatePath, privateKeyPath: config.tlsPrivateKeyPath, collaborationToken: token },
							{ editor: this.props.editor }
						).catch(() => null)
					: this.state.remoteCollaborationTlsInfo;
			this.setState({
				remoteCollaborationGateway,
				remoteCollaborationEvents: eventResult.events,
				remoteCollaborationDiscovery,
				remoteCollaborationRelay,
				remoteCollaborationBindAddress: config.bindAddress,
				remoteCollaborationPort: config.port,
				remoteCollaborationAllowedOrigins: config.allowedOrigins.join("\n"),
				remoteCollaborationAllowedHosts: config.allowedHosts.join("\n"),
				remoteCollaborationTlsCertificatePath: config.tlsCertificatePath ?? this.state.remoteCollaborationTlsCertificatePath,
				remoteCollaborationTlsPrivateKeyPath: config.tlsPrivateKeyPath ?? this.state.remoteCollaborationTlsPrivateKeyPath,
				remoteCollaborationTlsInfo,
				remoteCollaborationDiscoveryEnabled: discoveryConfig.enabled,
				remoteCollaborationDiscoveryDisplayName: discoveryConfig.displayName,
				remoteCollaborationDiscoveryAddress: discoveryConfig.address,
				remoteCollaborationDiscoveryPort: discoveryConfig.port,
				remoteCollaborationRelayEnabled: relayConfig.enabled,
				remoteCollaborationRelayUrl: relayConfig.relayUrl,
				remoteCollaborationRelayProjectSlug: relayConfig.projectSlug,
				remoteCollaborationRelayTokenEnvironmentVariable: relayConfig.tokenEnvironmentVariable,
				remoteCollaborationHistoryEnabled: config.eventHistoryEnabled,
				remoteCollaborationHistoryRetention: config.eventHistoryRetention,
				remoteCollaborationError: null,
			});
		} catch (error: any) {
			this.setState({
				remoteCollaborationGateway: null,
				remoteCollaborationEvents: [],
				remoteCollaborationDiscovery: null,
				remoteCollaborationRelay: null,
				remoteCollaborationError: error.message,
			});
		}
	}

	private async _setRemoteCollaborationDiscovery(enabled: boolean): Promise<void> {
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			await setRemoteCollaborationDiscovery(
				this.props.object,
				{
					enabled,
					displayName: this.state.remoteCollaborationDiscoveryDisplayName,
					address: this.state.remoteCollaborationDiscoveryAddress,
					port: this.state.remoteCollaborationDiscoveryPort,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			await this._refreshRemoteCollaboration();
			toast.success(enabled ? "Remote collaboration discovery is enabled." : "Remote collaboration discovery is disabled.");
		} catch (error: any) {
			this.setState({ remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private async _discoverRemoteCollaborationProjects(): Promise<void> {
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			const result = await discoverRemoteCollaborationProjects(
				this.props.object,
				{
					address: this.state.remoteCollaborationDiscoveryAddress,
					port: this.state.remoteCollaborationDiscoveryPort,
					timeoutMs: 750,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({ remoteCollaborationDiscoveredProjects: result.projects });
			toast.success(`Discovered ${result.count} collaboration project${result.count === 1 ? "" : "s"}.`);
		} catch (error: any) {
			this.setState({ remoteCollaborationDiscoveredProjects: [], remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private async _setRemoteCollaborationRelay(enabled: boolean): Promise<void> {
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			await setRemoteCollaborationRelay(
				this.props.object,
				{
					enabled,
					relayUrl: this.state.remoteCollaborationRelayUrl,
					projectSlug: this.state.remoteCollaborationRelayProjectSlug,
					tokenEnvironmentVariable: this.state.remoteCollaborationRelayTokenEnvironmentVariable,
					relayAccessToken: this.state.remoteCollaborationRelayAccessToken || undefined,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({ remoteCollaborationRelayAccessToken: "" });
			await this._refreshRemoteCollaboration();
			toast.success(enabled ? "Outbound collaboration relay is enabled." : "Outbound collaboration relay is disabled.");
		} catch (error: any) {
			this.setState({ remoteCollaborationRelayAccessToken: "", remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private async _reconnectRemoteCollaborationRelay(): Promise<void> {
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			await reconnectRemoteCollaborationRelay(
				this.props.object,
				{ relayAccessToken: this.state.remoteCollaborationRelayAccessToken || undefined, collaborationToken: this.state.collaborationToken },
				{ editor: this.props.editor }
			);
			this.setState({ remoteCollaborationRelayAccessToken: "" });
			await this._refreshRemoteCollaboration();
			toast.success("Outbound collaboration relay is reconnecting.");
		} catch (error: any) {
			this.setState({ remoteCollaborationRelayAccessToken: "", remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private async _setRemoteCollaborationGateway(enabled: boolean): Promise<void> {
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			const tlsInfo = this.state.remoteCollaborationTlsInfo;
			const tlsReady =
				tlsInfo?.validNow === true &&
				tlsInfo?.keyMatches === true &&
				tlsInfo?.certificatePath === this.state.remoteCollaborationTlsCertificatePath &&
				tlsInfo?.privateKeyPath === this.state.remoteCollaborationTlsPrivateKeyPath;
			await setRemoteCollaborationGateway(
				this.props.object,
				{
					enabled,
					bindAddress: this.state.remoteCollaborationBindAddress,
					port: this.state.remoteCollaborationPort,
					allowedOrigins: this.state.remoteCollaborationAllowedOrigins
						.split(/\r?\n/)
						.map((value) => value.trim())
						.filter(Boolean),
					allowedHosts: this.state.remoteCollaborationAllowedHosts
						.split(/\r?\n/)
						.map((value) => value.trim())
						.filter(Boolean),
					tlsCertificatePath: tlsReady ? this.state.remoteCollaborationTlsCertificatePath : null,
					tlsPrivateKeyPath: tlsReady ? this.state.remoteCollaborationTlsPrivateKeyPath : null,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			await this._refreshRemoteCollaboration();
			toast.success(enabled ? "Remote collaboration gateway started." : "Remote collaboration gateway stopped.");
		} catch (error: any) {
			this.setState({ remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private _remoteCollaborationTlsHosts(): string[] {
		return this.state.remoteCollaborationTlsHosts
			.split(/\r?\n/)
			.map((value) => value.trim())
			.filter(Boolean);
	}

	private async _generateRemoteCollaborationTlsCertificate(): Promise<void> {
		const confirmed = await showConfirm(
			"Generate or rotate TLS certificate?",
			"Existing collaboration certificate and private-key files at these paths will be replaced. The operating-system trust store will not be changed."
		);
		if (!confirmed) {
			return;
		}
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			const remoteCollaborationTlsInfo = await generateRemoteCollaborationTlsCertificate(
				this.props.object,
				{
					certificatePath: this.state.remoteCollaborationTlsCertificatePath,
					privateKeyPath: this.state.remoteCollaborationTlsPrivateKeyPath,
					hosts: this._remoteCollaborationTlsHosts(),
					validityDays: this.state.remoteCollaborationTlsValidityDays,
					rsaBits: 2048,
					confirmOverwrite: true,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({ remoteCollaborationTlsInfo });
			toast.success("Project collaboration TLS certificate generated. Review its fingerprint before configuring trust.");
		} catch (error: any) {
			this.setState({ remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private async _inspectRemoteCollaborationTlsCertificate(): Promise<void> {
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			const remoteCollaborationTlsInfo = await inspectRemoteCollaborationTlsCertificate(
				this.props.object,
				{
					certificatePath: this.state.remoteCollaborationTlsCertificatePath,
					privateKeyPath: this.state.remoteCollaborationTlsPrivateKeyPath,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			this.setState({ remoteCollaborationTlsInfo });
		} catch (error: any) {
			this.setState({ remoteCollaborationTlsInfo: null, remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private async _setRemoteCollaborationHistory(): Promise<void> {
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			await setRemoteCollaborationEventHistory(
				this.props.object,
				{
					enabled: this.state.remoteCollaborationHistoryEnabled,
					retention: this.state.remoteCollaborationHistoryRetention,
					collaborationToken: this.state.collaborationToken,
				},
				{ editor: this.props.editor }
			);
			await this._refreshRemoteCollaboration();
			toast.success(this.state.remoteCollaborationHistoryEnabled ? "Durable collaboration history configured." : "Durable collaboration history disabled.");
		} catch (error: any) {
			this.setState({ remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private async _clearRemoteCollaborationHistory(): Promise<void> {
		this.setState({ remoteCollaborationBusy: true, remoteCollaborationError: null });
		try {
			await clearRemoteCollaborationEventHistory(this.props.object, { confirm: true, collaborationToken: this.state.collaborationToken }, { editor: this.props.editor });
			await this._refreshRemoteCollaboration();
			toast.success("Remote collaboration event history cleared.");
		} catch (error: any) {
			this.setState({ remoteCollaborationError: error.message });
		} finally {
			this.setState({ remoteCollaborationBusy: false });
		}
	}

	private _getSemanticDiffComponent(): ReactNode {
		const result = this.state.semanticDiffResult;
		return (
			<EditorInspectorSectionField
				title="Scene / Prefab Semantic Diff"
				tooltip="Identity-aware structural comparison for two persisted scene directories or prefab files. Stable node arrays are matched by identity so harmless reordering does not create noisy changes."
			>
				<Input
					value={this.state.semanticDiffSourcePath}
					onChange={(event) => this.setState({ semanticDiffSourcePath: event.target.value })}
					placeholder="assets/Base.scene"
					aria-label="Semantic diff baseline path"
				/>
				<Input
					value={this.state.semanticDiffTargetPath}
					onChange={(event) => this.setState({ semanticDiffTargetPath: event.target.value })}
					placeholder="assets/Working.scene"
					aria-label="Semantic diff candidate path"
				/>
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
					<Input
						type="number"
						min={0}
						max={1}
						step={0.0001}
						value={this.state.semanticDiffTolerance}
						onChange={(event) => this.setState({ semanticDiffTolerance: Number(event.target.value) })}
						aria-label="Semantic diff numeric tolerance"
					/>
					<Button size="sm" disabled={this.state.semanticDiffBusy} onClick={() => void this._compareSemanticAssets()}>
						Compare
					</Button>
				</div>
				{this.state.semanticDiffError && <div className="px-2 text-xs text-destructive">{this.state.semanticDiffError}</div>}
				{result && (
					<div className="space-y-2 text-xs">
						<div className={`rounded-lg p-2 ${result.equal ? "bg-emerald-500/10" : "bg-amber-500/10"}`}>
							<div className="flex justify-between gap-2 font-medium">
								<span>{result.equal ? "Semantically equal" : `${result.summary.totalChanges} semantic changes`}</span>
								<span>{result.summary.filesChanged} files</span>
							</div>
							<div className="text-muted-foreground">
								+{result.summary.counts.added} / −{result.summary.counts.removed} / ~{result.summary.counts.changed} / type {result.summary.counts.typeChanged}
								{result.summary.truncated ? ` · showing ${result.summary.returnedChanges}` : ""}
							</div>
						</div>
						<div className="max-h-64 space-y-1 overflow-auto">
							{result.changes.slice(0, 200).map((change: any, index: number) => (
								<div key={`${change.file}:${change.path}:${index}`} className="rounded bg-muted-foreground/10 p-2">
									<div className="flex justify-between gap-2">
										<span className="truncate font-medium" title={`${change.file}${change.path}`}>
											{change.file}
										</span>
										<span className="shrink-0 text-muted-foreground">{change.kind}</span>
									</div>
									<div className="break-all text-muted-foreground">{change.path || "/"}</div>
									{change.before && change.after && (
										<div className="break-all">
											{change.before.preview} → {change.after.preview}
										</div>
									)}
								</div>
							))}
						</div>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private async _compareSemanticAssets(): Promise<void> {
		this.setState({ semanticDiffBusy: true, semanticDiffError: null });
		try {
			const semanticDiffResult = await compareProjectSceneAssets(
				this.props.object,
				{
					sourcePath: this.state.semanticDiffSourcePath,
					targetPath: this.state.semanticDiffTargetPath,
					numericTolerance: this.state.semanticDiffTolerance,
					maximumChanges: 200,
				},
				{ editor: this.props.editor }
			);
			this.setState({ semanticDiffResult, semanticDiffError: null });
		} catch (error: any) {
			this.setState({ semanticDiffResult: null, semanticDiffError: error.message });
		} finally {
			this.setState({ semanticDiffBusy: false });
		}
	}

	private _getSemanticMergeComponent(): ReactNode {
		const result = this.state.semanticMergeResult;
		const unresolved = result?.summary.unresolvedConflicts > 0;
		return (
			<EditorInspectorSectionField
				title="Scene / Prefab Semantic Merge"
				tooltip="Three-way merge a common base, local version, and incoming version. Independent edits and stable-identity arrays merge automatically; conflicting values are reported before a new output asset is written."
			>
				<Input
					value={this.state.semanticMergeBasePath}
					onChange={(event) => this.setState({ semanticMergeBasePath: event.target.value, semanticMergeResult: null, semanticMergeConflictResolutions: [] })}
					placeholder="assets/Base.scene"
					aria-label="Semantic merge base path"
				/>
				<Input
					value={this.state.semanticMergeOursPath}
					onChange={(event) => this.setState({ semanticMergeOursPath: event.target.value, semanticMergeResult: null, semanticMergeConflictResolutions: [] })}
					placeholder="assets/Ours.scene"
					aria-label="Semantic merge ours path"
				/>
				<Input
					value={this.state.semanticMergeTheirsPath}
					onChange={(event) => this.setState({ semanticMergeTheirsPath: event.target.value, semanticMergeResult: null, semanticMergeConflictResolutions: [] })}
					placeholder="assets/Theirs.scene"
					aria-label="Semantic merge theirs path"
				/>
				<Input
					value={this.state.semanticMergeOutputPath}
					onChange={(event) => this.setState({ semanticMergeOutputPath: event.target.value })}
					placeholder="assets/Merged.scene"
					aria-label="Semantic merge output path"
				/>
				<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
					<select
						className="h-8 rounded bg-input px-2 text-sm"
						value={this.state.semanticMergeResolution}
						onChange={(event) => this.setState({ semanticMergeResolution: event.target.value as "manual" | "ours" | "theirs" })}
						aria-label="Semantic merge conflict resolution"
					>
						<option value="manual">Report conflicts</option>
						<option value="ours">Resolve with ours</option>
						<option value="theirs">Resolve with theirs</option>
					</select>
					<Button size="sm" variant="secondary" disabled={this.state.semanticMergeBusy} onClick={() => void this._mergeSemanticAssets(false)}>
						Preview
					</Button>
					<Button size="sm" disabled={this.state.semanticMergeBusy || unresolved} onClick={() => void this._mergeSemanticAssets(true)}>
						Create
					</Button>
				</div>
				<div className="space-y-1 rounded bg-muted-foreground/10 p-2">
					<div className="text-xs font-medium">Reusable rules</div>
					{this.state.semanticMergeRules.map((rule) => (
						<div key={rule.id} className="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								checked={this.state.semanticMergeRuleIds.includes(rule.id)}
								onChange={() => this._toggleSemanticMergeRule(rule.id)}
								aria-label={`Use semantic merge rule ${rule.name}`}
							/>
							<span className="min-w-0 flex-1 truncate" title={`${rule.filePattern}${rule.pathPrefix} → ${rule.choice}`}>
								{rule.name} · {rule.choice}
							</span>
							<Button size="sm" variant="ghost" className="h-6 px-1 hover:bg-destructive" onClick={() => void this._deleteSemanticMergeRule(rule.id)}>
								Remove
							</Button>
						</div>
					))}
					<div className="grid grid-cols-2 gap-1">
						<Input
							value={this.state.semanticMergeRuleName}
							onChange={(event) => this.setState({ semanticMergeRuleName: event.target.value })}
							placeholder="Rule name"
							aria-label="Semantic merge rule name"
						/>
						<select
							className="h-8 rounded bg-input px-2 text-sm"
							value={this.state.semanticMergeRuleChoice}
							onChange={(event) => this.setState({ semanticMergeRuleChoice: event.target.value as "ours" | "theirs" | "base" | "delete" })}
							aria-label="Semantic merge rule choice"
						>
							<option value="ours">Ours</option>
							<option value="theirs">Theirs</option>
							<option value="base">Base</option>
							<option value="delete">Delete</option>
						</select>
						<Input
							value={this.state.semanticMergeRuleFilePattern}
							onChange={(event) => this.setState({ semanticMergeRuleFilePattern: event.target.value })}
							placeholder="*.json"
							aria-label="Semantic merge rule file pattern"
						/>
						<Input
							value={this.state.semanticMergeRulePathPrefix}
							onChange={(event) => this.setState({ semanticMergeRulePathPrefix: event.target.value })}
							placeholder="/settings"
							aria-label="Semantic merge rule path prefix"
						/>
					</div>
					<Button size="sm" variant="secondary" className="w-full" disabled={this.state.semanticMergeBusy} onClick={() => void this._createSemanticMergeRule()}>
						Save reusable rule
					</Button>
				</div>
				{this.state.semanticMergeError && <div className="px-2 text-xs text-destructive">{this.state.semanticMergeError}</div>}
				{result && (
					<div className="space-y-2 text-xs">
						<div className={`rounded-lg p-2 ${result.summary.totalConflicts ? "bg-amber-500/10" : "bg-emerald-500/10"}`}>
							<div className="flex justify-between gap-2 font-medium">
								<span>{result.written ? `Created ${result.output.path}` : "Merge preview"}</span>
								<span>{result.summary.totalConflicts} conflicts</span>
							</div>
							<div className="text-muted-foreground">
								{result.summary.automaticMerges} automatic · {result.summary.resolvedConflicts} resolved · {result.summary.unresolvedConflicts} unresolved ·{" "}
								{result.summary.fileCount} JSON files
								{result.summary.truncated ? ` · showing ${result.summary.returnedConflicts}` : ""}
							</div>
						</div>
						<div className="max-h-64 space-y-1 overflow-auto">
							{result.conflicts.slice(0, 200).map((conflict: any, index: number) => (
								<div key={`${conflict.file}:${conflict.path}:${index}`} className="rounded bg-muted-foreground/10 p-2">
									<div className="flex justify-between gap-2">
										<span className="truncate font-medium" title={`${conflict.file}${conflict.path}`}>
											{conflict.file}
										</span>
										<span className="shrink-0 text-muted-foreground">{conflict.resolution}</span>
									</div>
									<div className="break-all text-muted-foreground">{conflict.path}</div>
									<div className="break-all">
										ours: {conflict.ours?.preview ?? "deleted"} · theirs: {conflict.theirs?.preview ?? "deleted"}
									</div>
									<div className="mt-1 grid grid-cols-4 gap-1">
										{(["base", "ours", "theirs", "delete"] as const).map((choice) => (
											<Button
												key={choice}
												size="sm"
												variant={conflict.resolution === choice ? "default" : "secondary"}
												className="h-6 px-1 text-xs"
												onClick={() => this._setSemanticMergeConflictResolution(conflict, choice)}
											>
												{choice}
											</Button>
										))}
									</div>
									<div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-1">
										<Input
											value={this.state.semanticMergeCustomValues[this._semanticMergeConflictKey(conflict)] ?? ""}
											onChange={(event) =>
												this.setState({
													semanticMergeCustomValues: {
														...this.state.semanticMergeCustomValues,
														[this._semanticMergeConflictKey(conflict)]: event.target.value,
													},
												})
											}
											placeholder="Custom JSON value"
											aria-label={`Custom JSON resolution for ${conflict.file}${conflict.path}`}
										/>
										<Button size="sm" variant="secondary" className="h-8" onClick={() => this._setSemanticMergeCustomResolution(conflict)}>
											Use JSON
										</Button>
									</div>
								</div>
							))}
						</div>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private async _mergeSemanticAssets(write: boolean): Promise<void> {
		this.setState({ semanticMergeBusy: true, semanticMergeError: null });
		try {
			const previous = this.state.semanticMergeResult;
			const matchingPreview =
				previous &&
				previous.base.path === this.state.semanticMergeBasePath &&
				previous.ours.path === this.state.semanticMergeOursPath &&
				previous.theirs.path === this.state.semanticMergeTheirsPath;
			const semanticMergeResult = await mergeProjectSceneAssets(
				this.props.object,
				{
					basePath: this.state.semanticMergeBasePath,
					oursPath: this.state.semanticMergeOursPath,
					theirsPath: this.state.semanticMergeTheirsPath,
					outputPath: this.state.semanticMergeOutputPath,
					resolution: this.state.semanticMergeResolution,
					conflictResolutions: this.state.semanticMergeConflictResolutions,
					ruleIds: this.state.semanticMergeRuleIds,
					write,
					maximumConflicts: 200,
					expectedBaseHash: write && matchingPreview ? previous.base.hash : undefined,
					expectedOursHash: write && matchingPreview ? previous.ours.hash : undefined,
					expectedTheirsHash: write && matchingPreview ? previous.theirs.hash : undefined,
				},
				{ editor: this.props.editor }
			);
			this.setState({ semanticMergeResult, semanticMergeError: null });
			if (semanticMergeResult.written) {
				toast.success(`Created merged asset ${semanticMergeResult.output.path}.`);
			}
		} catch (error: any) {
			this.setState({ semanticMergeError: error.message });
		} finally {
			this.setState({ semanticMergeBusy: false });
		}
	}

	private _semanticMergeConflictKey(conflict: any): string {
		return `${conflict.file}\0${conflict.path}`;
	}

	private _setSemanticMergeConflictResolution(conflict: any, choice: "base" | "ours" | "theirs" | "delete" | "custom", customValue?: unknown): void {
		const key = this._semanticMergeConflictKey(conflict);
		const conflictResolutions = this.state.semanticMergeConflictResolutions.filter((candidate) => `${candidate.file}\0${candidate.path}` !== key);
		conflictResolutions.push({ file: conflict.file, path: conflict.path, choice, ...(choice === "custom" ? { customValue } : {}) });
		this.setState({ semanticMergeConflictResolutions: conflictResolutions, semanticMergeError: null }, () => void this._mergeSemanticAssets(false));
	}

	private _setSemanticMergeCustomResolution(conflict: any): void {
		try {
			const source = this.state.semanticMergeCustomValues[this._semanticMergeConflictKey(conflict)];
			this._setSemanticMergeConflictResolution(conflict, "custom", JSON.parse(source));
		} catch (error: any) {
			this.setState({ semanticMergeError: `Custom resolution must be valid JSON: ${error.message}` });
		}
	}

	private async _refreshSemanticMergeRules(): Promise<void> {
		try {
			const result = await listProjectSemanticMergeRules(this.props.object, {}, { editor: this.props.editor });
			const availableIds = new Set(result.rules.map((rule: any) => rule.id));
			this.setState({ semanticMergeRules: result.rules, semanticMergeRuleIds: this.state.semanticMergeRuleIds.filter((id) => availableIds.has(id)) });
		} catch (error: any) {
			this.setState({ semanticMergeRules: [], semanticMergeError: error.message });
		}
	}

	private _toggleSemanticMergeRule(id: string): void {
		const semanticMergeRuleIds = this.state.semanticMergeRuleIds.includes(id)
			? this.state.semanticMergeRuleIds.filter((candidate) => candidate !== id)
			: [...this.state.semanticMergeRuleIds, id];
		this.setState({ semanticMergeRuleIds }, () => {
			if (this.state.semanticMergeResult) {
				void this._mergeSemanticAssets(false);
			}
		});
	}

	private async _createSemanticMergeRule(): Promise<void> {
		this.setState({ semanticMergeBusy: true, semanticMergeError: null });
		try {
			const result = await createProjectSemanticMergeRule(
				this.props.object,
				{
					name: this.state.semanticMergeRuleName,
					assetKind: this.state.semanticMergeResult?.kind ?? "any",
					filePattern: this.state.semanticMergeRuleFilePattern,
					pathPrefix: this.state.semanticMergeRulePathPrefix,
					choice: this.state.semanticMergeRuleChoice,
				},
				{ editor: this.props.editor }
			);
			await this._refreshSemanticMergeRules();
			this.setState({ semanticMergeRuleIds: [...this.state.semanticMergeRuleIds, result.rule.id] });
			toast.success("Semantic merge rule saved.");
		} catch (error: any) {
			this.setState({ semanticMergeError: error.message });
		} finally {
			this.setState({ semanticMergeBusy: false });
		}
	}

	private async _deleteSemanticMergeRule(id: string): Promise<void> {
		this.setState({ semanticMergeBusy: true, semanticMergeError: null });
		try {
			await deleteProjectSemanticMergeRule(this.props.object, { id }, { editor: this.props.editor });
			await this._refreshSemanticMergeRules();
			toast.success("Semantic merge rule deleted.");
		} catch (error: any) {
			this.setState({ semanticMergeError: error.message });
		} finally {
			this.setState({ semanticMergeBusy: false });
		}
	}

	private _formatBuildBytes(bytes: number): string {
		if (bytes < 1024) {
			return `${bytes} B`;
		}
		if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)} KB`;
		}
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	private _getPhysics2DMaterialsComponent(): ReactNode {
		const materials = listPhysics2DMaterials(this.props.object).materials;
		return (
			<EditorInspectorSectionField
				title="2D Physics Materials"
				tooltip="Reusable friction/restitution assets for 2D bodies. Assign a material id through the 2D-body MCP tool."
			>
				<Button variant="secondary" className="w-full" onClick={() => this._createPhysics2DMaterial()}>
					Add 2D Material
				</Button>
				{materials.map((material: any) => (
					<div key={material.id} className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_auto] gap-2 items-center rounded-lg bg-muted-foreground/10 p-2">
						<Input
							value={material.name}
							onChange={(event) => this._setPhysics2DMaterial(material, { name: event.target.value })}
							aria-label="2D physics material name"
						/>
						<Input
							type="number"
							min="0"
							max="1"
							step="0.01"
							value={String(material.friction)}
							onChange={(event) => this._setPhysics2DMaterialNumber(material, "friction", event.target.value)}
							aria-label="2D physics material friction"
						/>
						<Input
							type="number"
							min="0"
							max="1"
							step="0.01"
							value={String(material.restitution)}
							onChange={(event) => this._setPhysics2DMaterialNumber(material, "restitution", event.target.value)}
							aria-label="2D physics material restitution"
						/>
						<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deletePhysics2DMaterial(material.id)}>
							Remove
						</Button>
					</div>
				))}
				{materials.length > 0 && (
					<div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_auto] gap-2 px-2 text-xs text-muted-foreground">
						<span>Name</span>
						<span>Friction</span>
						<span>Bounce</span>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getSpriteIKComponent(): ReactNode {
		const nodes = this.props.object.transformNodes;
		const controllers = listSpriteIKControllers(this.props.object).controllers as any[];
		const name = (nodeId: string): string => this.props.object.getNodeById(nodeId)?.name ?? nodeId;
		const rootNodeId = this.state.spriteIKRootNodeId || nodes[0]?.id || "";
		const jointNodeId = this.state.spriteIKJointNodeId || nodes.find((node) => node.parent?.id === rootNodeId)?.id || "";
		const tipNodeId = this.state.spriteIKTipNodeId || nodes.find((node) => node.parent?.id === jointNodeId)?.id || "";
		const targetNodeId = this.state.spriteIKTargetNodeId || nodes.find((node) => node.id !== rootNodeId && node.id !== jointNodeId && node.id !== tipNodeId)?.id || "";
		const selectors: { value: string; set: (value: string) => void; label: string }[] = [
			{ value: rootNodeId, set: (value) => this.setState({ spriteIKRootNodeId: value }), label: "Root" },
			{ value: jointNodeId, set: (value) => this.setState({ spriteIKJointNodeId: value }), label: "Joint" },
			{ value: tipNodeId, set: (value) => this.setState({ spriteIKTipNodeId: value }), label: "Tip" },
			{ value: targetNodeId, set: (value) => this.setState({ spriteIKTargetNodeId: value }), label: "Target" },
		];
		return (
			<EditorInspectorSectionField
				title="2D Sprite IK"
				tooltip="Planar cutout rig: select an existing TransformNode hierarchy Root → Joint → Tip with XY segment offsets, plus a target TransformNode."
			>
				<div className="mb-2 flex gap-2">
					<Input value={this.state.spriteIKRigName} onChange={(event) => this.setState({ spriteIKRigName: event.target.value })} aria-label="Sprite IK rig name" />
					<Button size="sm" variant="secondary" onClick={() => this._createSpriteIKRig()}>
						Create Rig
					</Button>
				</div>
				{nodes.length < 4 ? (
					<div className="px-2 text-sm text-muted-foreground">Create a root, joint, tip, and target TransformNode first.</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-2">
							{selectors.map((selector) => (
								<label key={selector.label} className="text-xs text-muted-foreground">
									{selector.label}
									<select
										className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
										value={selector.value}
										onChange={(event) => selector.set(event.target.value)}
									>
										{nodes.map((node) => (
											<option key={node.id} value={node.id}>
												{node.name}
											</option>
										))}
									</select>
								</label>
							))}
						</div>
						<Button
							size="sm"
							variant="secondary"
							className="mt-2 w-full"
							onClick={() => this._createSpriteIKController(rootNodeId, jointNodeId, tipNodeId, targetNodeId)}
						>
							Add Sprite IK
						</Button>
					</>
				)}
				{controllers.map((controller) => (
					<div key={controller.id} className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div>
							<div className="font-medium">
								{name(controller.rootNodeId)} → {name(controller.jointNodeId)} → {name(controller.tipNodeId)}
							</div>
							<div className="text-muted-foreground">
								Target: {name(controller.targetNodeId)} · {controller.bendDirection === "clockwise" ? "Clockwise" : "Counter-clockwise"}
							</div>
						</div>
						<div className="flex gap-1">
							<Button size="sm" variant="ghost" onClick={() => this._setSpriteIKController(controller.id, { enabled: !controller.enabled })}>
								{controller.enabled ? "Disable" : "Enable"}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() =>
									this._setSpriteIKController(controller.id, { bendDirection: controller.bendDirection === "clockwise" ? "counterClockwise" : "clockwise" })
								}
							>
								Flip
							</Button>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteSpriteIKController(controller.id)}>
								Remove
							</Button>
						</div>
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _createSpriteIKController(rootNodeId: string, jointNodeId: string, tipNodeId: string, targetNodeId: string): void {
		try {
			createSpriteIKController(this.props.object, { rootNodeId, jointNodeId, tipNodeId, targetNodeId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createSpriteIKRig(): void {
		try {
			const result = createSpriteIKRig(this.props.object, { name: this.state.spriteIKRigName }, { editor: this.props.editor });
			this.setState({
				spriteIKRootNodeId: result.rootNodeId,
				spriteIKJointNodeId: result.jointNodeId,
				spriteIKTipNodeId: result.tipNodeId,
				spriteIKTargetNodeId: result.targetNodeId,
			});
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setSpriteIKController(id: string, update: any): void {
		try {
			setSpriteIKController(this.props.object, { id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteSpriteIKController(id: string): void {
		try {
			deleteSpriteIKController(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getClothsComponent(): ReactNode {
		const cloths = listCloths(this.props.object).cloths as any[];
		const paint = getClothConstraintPaintViewport(this.props.object);
		return (
			<EditorInspectorSectionField
				title="Cloth Physics"
				tooltip="Persistent gridded cloth meshes with paintable per-vertex motion/surface constraints and local volumes, transformed bounds, or true transformed triangle collision in the editor and exported runtime."
			>
				<Button size="sm" variant="secondary" className="w-full" onClick={() => this._createCloth()}>
					Create Cloth
				</Button>
				{cloths.length === 0 ? (
					<div className="px-2 text-xs text-muted-foreground">No cloth components in this scene.</div>
				) : (
					cloths.map((cloth) => (
						<div key={cloth.id} className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
							<div className="flex items-center gap-2">
								<div className="min-w-0 flex-1">
									<div className="truncate font-medium">{this.props.object.getMeshById(cloth.meshId)?.name ?? cloth.id}</div>
									<div className="text-muted-foreground">
										{cloth.subdivisions} subdivisions · {cloth.active ? "active" : "inactive"}
									</div>
								</div>
								<Button size="sm" variant={cloth.enabled === false ? "ghost" : "default"} onClick={() => this._setClothEnabled(cloth, cloth.enabled === false)}>
									{cloth.enabled === false ? "Enable" : "Disable"}
								</Button>
								<Button size="sm" variant="ghost" onClick={() => this._resetCloth(cloth.id)}>
									Reset
								</Button>
								<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteCloth(cloth.id)}>
									Remove
								</Button>
							</div>
							<div className="flex flex-wrap gap-1">
								<Button size="sm" variant="secondary" onClick={() => this._toggleClothPlane(cloth)}>
									{cloth.collisionPlane ? "Clear Plane" : "Add Ground Plane"}
								</Button>
								<Button size="sm" variant="secondary" disabled={(cloth.collisionSpheres?.length ?? 0) >= 32} onClick={() => this._addClothSphere(cloth)}>
									Add Sphere ({cloth.collisionSpheres?.length ?? 0})
								</Button>
								<Button size="sm" variant="secondary" disabled={(cloth.collisionBoxes?.length ?? 0) >= 32} onClick={() => this._addClothBox(cloth)}>
									Add Box ({cloth.collisionBoxes?.length ?? 0})
								</Button>
								<Button size="sm" variant={cloth.selfCollision ? "default" : "secondary"} onClick={() => this._setClothSelfCollision(cloth, !cloth.selfCollision)}>
									Self Collision: {cloth.selfCollision ? "On" : "Off"}
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={(cloth.collisionMeshIds?.length ?? 0) >= 16}
									onClick={() => this._addSelectedClothMeshCollider(cloth)}
								>
									Add Selected Mesh ({cloth.collisionMeshIds?.length ?? 0})
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={(cloth.triangleColliders?.length ?? 0) >= 8}
									onClick={() => this._addSelectedClothTriangleCollider(cloth)}
								>
									Add Triangle Mesh ({cloth.triangleColliders?.length ?? 0})
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={!(cloth.collisionSpheres?.length || cloth.collisionBoxes?.length)}
									onClick={() => this._clearClothVolumes(cloth)}
								>
									Clear Volumes
								</Button>
							</div>
							<div className="space-y-1 rounded border border-input p-2">
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 font-medium">
										Constraint Paint · {cloth.vertexConstraintCount ?? 0} vertices · revision {cloth.constraintRevision}
									</span>
									<Button
										size="sm"
										variant={paint.enabled && paint.clothId === cloth.id ? "default" : "secondary"}
										onClick={() => this._toggleClothConstraintPaint(cloth.id, !(paint.enabled && paint.clothId === cloth.id))}
									>
										{paint.enabled && paint.clothId === cloth.id ? "Stop Painting" : "Paint in Viewport"}
									</Button>
								</div>
								{paint.enabled && paint.clothId === cloth.id && (
									<>
										<div className="flex flex-wrap gap-1">
											<Button
												size="sm"
												variant={paint.channel === "maxDistance" ? "default" : "secondary"}
												onClick={() => this._setClothConstraintPaint({ channel: "maxDistance" })}
											>
												Maximum Distance
											</Button>
											<Button
												size="sm"
												variant={paint.channel === "surfacePenetration" ? "default" : "secondary"}
												onClick={() => this._setClothConstraintPaint({ channel: "surfacePenetration" })}
											>
												Surface Penetration
											</Button>
											{(["constant", "linear", "smooth"] as const).map((falloff) => (
												<Button
													key={falloff}
													size="sm"
													variant={paint.falloff === falloff ? "default" : "ghost"}
													onClick={() => this._setClothConstraintPaint({ falloff })}
												>
													{falloff}
												</Button>
											))}
										</div>
										<div className="grid grid-cols-3 gap-1">
											<Input
												type="number"
												min="0.001"
												defaultValue={paint.radius}
												aria-label="Cloth paint radius centimeters"
												onBlur={(event) => this._setClothConstraintPaintNumber("radius", event.currentTarget.value)}
											/>
											<Input
												type="number"
												min="0"
												defaultValue={paint.value}
												aria-label="Cloth paint constraint value centimeters"
												onBlur={(event) => this._setClothConstraintPaintNumber("value", event.currentTarget.value)}
											/>
											<Input
												type="number"
												min="0.001"
												max="1"
												step="0.05"
												defaultValue={paint.strength}
												aria-label="Cloth paint strength"
												onBlur={(event) => this._setClothConstraintPaintNumber("strength", event.currentTarget.value)}
											/>
										</div>
										<div className="text-muted-foreground">Left-drag paints; right-drag erases at influence ≥ 0.5. Complete strokes support Undo/Redo.</div>
									</>
								)}
							</div>
							<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-1">
								<span>Pinned vertices</span>
								<Input
									className="h-7 text-xs"
									defaultValue={(cloth.pinnedVertices ?? Array.from({ length: cloth.subdivisions + 1 }, (_, index) => index)).join(", ")}
									aria-label="Cloth pinned vertex indices"
									onBlur={(event) => this._setClothPinnedVertices(cloth, event.target.value)}
								/>
							</div>
							{cloth.collisionPlane && (
								<div className="grid grid-cols-[auto_minmax(0,1fr)_4rem_3.5rem] items-center gap-1">
									<span>Plane</span>
									<Input
										className="h-7 text-xs"
										defaultValue={(cloth.collisionPlane.normal ?? [0, 1, 0]).join(", ")}
										aria-label="Cloth plane normal"
										onBlur={(event) => this._setClothPlaneVector(cloth, event.target.value)}
									/>
									<Input
										className="h-7 text-xs"
										type="number"
										step="any"
										defaultValue={String(cloth.collisionPlane.offset ?? 0)}
										aria-label="Cloth plane offset"
										onBlur={(event) => this._setClothPlaneNumber(cloth, "offset", event.target.value)}
									/>
									<Input
										className="h-7 text-xs"
										type="number"
										min="0"
										max="1"
										step="0.1"
										defaultValue={String(cloth.collisionPlane.restitution ?? 0)}
										aria-label="Cloth plane restitution"
										onBlur={(event) => this._setClothPlaneNumber(cloth, "restitution", event.target.value)}
									/>
								</div>
							)}
							{(cloth.collisionSpheres ?? []).map((sphere: any, index: number) => (
								<div key={`sphere-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)_4rem_3.5rem_auto] items-center gap-1">
									<span>Sphere {index + 1}</span>
									<Input
										className="h-7 text-xs"
										defaultValue={sphere.center.join(", ")}
										aria-label={`Cloth sphere ${index + 1} center`}
										onBlur={(event) => this._setClothSphereVector(cloth, index, event.target.value)}
									/>
									<Input
										className="h-7 text-xs"
										type="number"
										min="0.001"
										defaultValue={String(sphere.radius)}
										aria-label={`Cloth sphere ${index + 1} radius`}
										onBlur={(event) => this._setClothSphereNumber(cloth, index, "radius", event.target.value)}
									/>
									<Input
										className="h-7 text-xs"
										type="number"
										min="0"
										max="1"
										step="0.1"
										defaultValue={String(sphere.restitution ?? 0)}
										aria-label={`Cloth sphere ${index + 1} restitution`}
										onBlur={(event) => this._setClothSphereNumber(cloth, index, "restitution", event.target.value)}
									/>
									<Button size="sm" variant="ghost" onClick={() => this._removeClothSphere(cloth, index)}>
										×
									</Button>
								</div>
							))}
							{(cloth.collisionBoxes ?? []).map((box: any, index: number) => (
								<div key={`box-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_3.5rem_auto] items-center gap-1">
									<span>Box {index + 1}</span>
									<Input
										className="h-7 text-xs"
										defaultValue={box.center.join(", ")}
										aria-label={`Cloth box ${index + 1} center`}
										onBlur={(event) => this._setClothBoxVector(cloth, index, "center", event.target.value)}
									/>
									<Input
										className="h-7 text-xs"
										defaultValue={box.size.join(", ")}
										aria-label={`Cloth box ${index + 1} size`}
										onBlur={(event) => this._setClothBoxVector(cloth, index, "size", event.target.value)}
									/>
									<Input
										className="h-7 text-xs"
										type="number"
										min="0"
										max="1"
										step="0.1"
										defaultValue={String(box.restitution ?? 0)}
										aria-label={`Cloth box ${index + 1} restitution`}
										onBlur={(event) => this._setClothBoxRestitution(cloth, index, event.target.value)}
									/>
									<Button size="sm" variant="ghost" onClick={() => this._removeClothBox(cloth, index)}>
										×
									</Button>
								</div>
							))}
							{(cloth.collisionMeshIds ?? []).map((meshId: string) => (
								<div key={meshId} className="flex items-center gap-2 rounded border border-input px-2 py-1 text-xs">
									<span className="min-w-0 flex-1 truncate">Mesh bounds: {this.props.object.getMeshById(meshId)?.name ?? meshId}</span>
									<Button size="sm" variant="ghost" onClick={() => this._removeClothMeshCollider(cloth, meshId)}>
										×
									</Button>
								</div>
							))}
							{(cloth.triangleColliders ?? []).map((collider: any) => (
								<div key={collider.meshId} className="flex items-center gap-2 rounded border border-input px-2 py-1 text-xs">
									<span className="min-w-0 flex-1 truncate">
										Triangles: {this.props.object.getMeshById(collider.meshId)?.name ?? collider.meshId} · {collider.thickness} cm · restitution{" "}
										{collider.restitution} · friction {collider.friction}
									</span>
									<Button size="sm" variant="ghost" onClick={() => this._removeClothTriangleCollider(cloth, collider.meshId)}>
										×
									</Button>
								</div>
							))}
							{cloth.diagnostics && (
								<div className="text-muted-foreground">
									Triangle runtime: {cloth.diagnostics.activeColliders}/{cloth.diagnostics.configuredColliders} active · {cloth.diagnostics.triangles} triangles ·{" "}
									{cloth.diagnostics.candidateTests} candidates · {cloth.diagnostics.contacts} contacts
									{cloth.diagnostics.workTruncated ? " · WORK TRUNCATED" : ""}
								</div>
							)}
						</div>
					))
				)}
			</EditorInspectorSectionField>
		);
	}

	private _createCloth(): void {
		try {
			createCloth(this.props.object, { name: `Cloth ${listCloths(this.props.object).cloths.length + 1}` }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setClothEnabled(cloth: any, enabled: boolean): void {
		try {
			setCloth(this.props.object, { id: cloth.id, enabled }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setClothSelfCollision(cloth: any, selfCollision: boolean): void {
		try {
			setCloth(this.props.object, { id: cloth.id, selfCollision }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _toggleClothPlane(cloth: any): void {
		try {
			setCloth(
				this.props.object,
				{ id: cloth.id, collisionPlane: cloth.collisionPlane ? null : { normal: [0, 1, 0], offset: 0, restitution: 0 } },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setClothPlaneVector(cloth: any, value: string): void {
		const normal = this._parseClothVector(value);
		if (!normal || !normal.some((candidate) => candidate !== 0)) {
			return;
		}
		this._setClothCollisionPlane(cloth.id, { ...cloth.collisionPlane, normal });
	}

	private _setClothPlaneNumber(cloth: any, property: "offset" | "restitution", value: string): void {
		const number = Number(value);
		if (!Number.isFinite(number) || (property === "restitution" && (number < 0 || number > 1))) {
			return;
		}
		this._setClothCollisionPlane(cloth.id, { ...cloth.collisionPlane, [property]: number });
	}

	private _setClothCollisionPlane(id: string, collisionPlane: any): void {
		try {
			setCloth(this.props.object, { id, collisionPlane }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setClothPinnedVertices(cloth: any, value: string): void {
		const pinnedVertices = value.trim() ? value.split(",").map((part) => Number(part.trim())) : [];
		if (pinnedVertices.some((index) => !Number.isInteger(index))) {
			return;
		}
		try {
			setCloth(this.props.object, { id: cloth.id, pinnedVertices }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _addClothSphere(cloth: any): void {
		try {
			setCloth(
				this.props.object,
				{ id: cloth.id, collisionSpheres: [...(cloth.collisionSpheres ?? []), { center: [0, 0, 0], radius: 50, restitution: 0 }] },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _addClothBox(cloth: any): void {
		try {
			setCloth(
				this.props.object,
				{ id: cloth.id, collisionBoxes: [...(cloth.collisionBoxes ?? []), { center: [0, 0, 0], size: [100, 100, 100], restitution: 0 }] },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _addSelectedClothMeshCollider(cloth: any): void {
		const mesh = this.props.editor.layout.graph.getSelectedNodes()[0]?.nodeData;
		if (!isMesh(mesh)) {
			toast.error("Select a scene mesh to add it as a cloth mesh-bounds collider.");
			return;
		}
		if (mesh.id === cloth.meshId || (cloth.collisionMeshIds ?? []).includes(mesh.id)) {
			return;
		}
		this._setClothCollisionVolumes(cloth.id, { collisionMeshIds: [...(cloth.collisionMeshIds ?? []), mesh.id] });
	}

	private _removeClothMeshCollider(cloth: any, meshId: string): void {
		this._setClothCollisionVolumes(cloth.id, { collisionMeshIds: (cloth.collisionMeshIds ?? []).filter((candidate: string) => candidate !== meshId) });
	}

	private _addSelectedClothTriangleCollider(cloth: any): void {
		const mesh = this.props.editor.layout.graph.getSelectedNodes()[0]?.nodeData;
		if (!isMesh(mesh)) {
			toast.error("Select a scene mesh with triangle geometry to add it as a cloth triangle collider.");
			return;
		}
		if (mesh.id === cloth.meshId || (cloth.triangleColliders ?? []).some((candidate: any) => candidate.meshId === mesh.id)) {
			return;
		}
		this._setClothCollisionVolumes(cloth.id, {
			triangleColliders: [...(cloth.triangleColliders ?? []), { meshId: mesh.id, thickness: 2, restitution: 0, friction: 0.2 }],
		});
	}

	private _removeClothTriangleCollider(cloth: any, meshId: string): void {
		this._setClothCollisionVolumes(cloth.id, { triangleColliders: (cloth.triangleColliders ?? []).filter((candidate: any) => candidate.meshId !== meshId) });
	}

	private _toggleClothConstraintPaint(clothId: string, enabled: boolean): void {
		this._setClothConstraintPaint({ clothId, enabled });
	}

	private _setClothConstraintPaint(update: Record<string, unknown>): void {
		try {
			const current = getClothConstraintPaintViewport(this.props.object);
			setClothConstraintPaintViewport(this.props.object, { expectedRevision: current.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update Cloth constraint painting.");
		}
	}

	private _setClothConstraintPaintNumber(property: "radius" | "value" | "strength", value: string): void {
		const number = Number(value);
		if (!Number.isFinite(number)) {
			return;
		}
		this._setClothConstraintPaint({ [property]: number });
	}

	private _clearClothVolumes(cloth: any): void {
		try {
			setCloth(this.props.object, { id: cloth.id, collisionSpheres: [], collisionBoxes: [] }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setClothSphereVector(cloth: any, index: number, value: string): void {
		const center = this._parseClothVector(value);
		if (!center) {
			return;
		}
		const collisionSpheres = [...(cloth.collisionSpheres ?? [])];
		collisionSpheres[index] = { ...collisionSpheres[index], center };
		this._setClothCollisionVolumes(cloth.id, { collisionSpheres });
	}

	private _setClothSphereNumber(cloth: any, index: number, property: "radius" | "restitution", value: string): void {
		const number = Number(value);
		if (!Number.isFinite(number) || (property === "radius" && number <= 0) || (property === "restitution" && (number < 0 || number > 1))) {
			return;
		}
		const collisionSpheres = [...(cloth.collisionSpheres ?? [])];
		collisionSpheres[index] = { ...collisionSpheres[index], [property]: number };
		this._setClothCollisionVolumes(cloth.id, { collisionSpheres });
	}

	private _removeClothSphere(cloth: any, index: number): void {
		this._setClothCollisionVolumes(cloth.id, { collisionSpheres: (cloth.collisionSpheres ?? []).filter((_: any, candidate: number) => candidate !== index) });
	}

	private _setClothBoxVector(cloth: any, index: number, property: "center" | "size", value: string): void {
		const vector = this._parseClothVector(value);
		if (!vector || (property === "size" && vector.some((candidate) => candidate <= 0))) {
			return;
		}
		const collisionBoxes = [...(cloth.collisionBoxes ?? [])];
		collisionBoxes[index] = { ...collisionBoxes[index], [property]: vector };
		this._setClothCollisionVolumes(cloth.id, { collisionBoxes });
	}

	private _setClothBoxRestitution(cloth: any, index: number, value: string): void {
		const restitution = Number(value);
		if (!Number.isFinite(restitution) || restitution < 0 || restitution > 1) {
			return;
		}
		const collisionBoxes = [...(cloth.collisionBoxes ?? [])];
		collisionBoxes[index] = { ...collisionBoxes[index], restitution };
		this._setClothCollisionVolumes(cloth.id, { collisionBoxes });
	}

	private _removeClothBox(cloth: any, index: number): void {
		this._setClothCollisionVolumes(cloth.id, { collisionBoxes: (cloth.collisionBoxes ?? []).filter((_: any, candidate: number) => candidate !== index) });
	}

	private _parseClothVector(value: string): [number, number, number] | null {
		const vector = value.split(",").map((part) => Number(part.trim()));
		return vector.length === 3 && vector.every((candidate) => Number.isFinite(candidate)) ? (vector as [number, number, number]) : null;
	}

	private _setClothCollisionVolumes(id: string, update: any): void {
		try {
			setCloth(this.props.object, { id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _resetCloth(id: string): void {
		try {
			setCloth(this.props.object, { id, reset: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteCloth(id: string): void {
		try {
			deleteCloth(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getDeviceSimulationComponent(): ReactNode {
		const simulation = getDeviceSimulation(this.props.object);
		const catalog = listDeviceSimulatorProfiles(this.props.object);
		const selectedProfile = catalog.profiles.find((profile: any) => profile.id === simulation.profileId);
		const update = (values: any): void => {
			try {
				setDeviceSimulation(this.props.object, { expectedRevision: simulation.revision, ...values }, { editor: this.props.editor });
				this.forceUpdate();
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Could not update device simulation.");
			}
		};
		return (
			<EditorInspectorSectionField
				title="Device Simulator"
				tooltip="Versioned Device Simulator profiles resize the actual preview engine view, rotate the safe area, and expose normalized Application, Screen, and SystemInfo values. Hardware performance, native plugins, platform defines, and sensors are not simulated."
			>
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2 text-xs">
						<span>
							{simulation.enabled ? "Active" : "Disabled"} · {simulation.width} × {simulation.height} · {simulation.dpi} DPI
						</span>
						<Button size="sm" variant={simulation.enabled ? "secondary" : "default"} onClick={() => update({ enabled: !simulation.enabled })}>
							{simulation.enabled ? "Disable" : "Enable"}
						</Button>
					</div>
					<select
						className="h-8 rounded bg-input px-2 text-sm"
						aria-label="Device Simulator profile"
						value={simulation.profileId ?? ""}
						onChange={(event) => {
							if (!event.currentTarget.value) {
								update({ profileId: null });
								return;
							}
							try {
								activateDeviceSimulatorProfile(
									this.props.object,
									{ id: event.currentTarget.value, expectedRevision: simulation.revision, enabled: true, orientation: simulation.orientation },
									{ editor: this.props.editor }
								);
								this.forceUpdate();
							} catch (error) {
								toast.error(error instanceof Error ? error.message : "Could not activate the device profile.");
							}
						}}
					>
						<option value="">Custom values (unlinked)</option>
						{catalog.profiles.map((profile: any) => (
							<option key={profile.id} value={profile.id}>
								{profile.name} {profile.builtIn ? "(built-in)" : "(project)"}
							</option>
						))}
					</select>
					<div className="grid grid-cols-3 gap-2">
						<Input type="number" defaultValue={simulation.width} aria-label="Device width" onBlur={(event) => update({ width: Number(event.currentTarget.value) })} />
						<Input
							type="number"
							defaultValue={simulation.height}
							aria-label="Device height"
							onBlur={(event) => update({ height: Number(event.currentTarget.value) })}
						/>
						<Input type="number" defaultValue={simulation.dpi} aria-label="Device DPI" onBlur={(event) => update({ dpi: Number(event.currentTarget.value) })} />
					</div>
					<select className="h-8 rounded bg-input px-2 text-sm" value={simulation.orientation} onChange={(event) => update({ orientation: event.target.value })}>
						<option value="portrait">Portrait</option>
						<option value="landscape">Landscape</option>
					</select>
					<div className="grid grid-cols-4 gap-2">
						{simulation.safeArea.map((value: number, index: number) => (
							<Input
								key={index}
								type="number"
								defaultValue={value}
								aria-label={`Safe area ${["top", "right", "bottom", "left"][index]}`}
								onBlur={(event) => {
									const safeArea = [...simulation.safeArea];
									safeArea[index] = Number(event.currentTarget.value);
									update({ safeArea });
								}}
							/>
						))}
					</div>
					<div className="rounded bg-input p-2 text-xs text-muted-foreground">
						<div>
							Resolved Screen: {simulation.resolved.width} × {simulation.resolved.height} · DPR {simulation.resolved.screen.devicePixelRatio}
						</div>
						<div>
							{simulation.resolved.application.operatingSystem} · {simulation.resolved.systemInfo.deviceModel} · {simulation.resolved.systemInfo.processorCount} cores
							· {simulation.resolved.systemInfo.systemMemoryMB} MB
						</div>
						<div>Performance simulated: No · Primary touch preview only</div>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Input
							value={this.state.deviceProfileId}
							aria-label="Custom device profile id"
							onChange={(event) => this.setState({ deviceProfileId: event.currentTarget.value })}
						/>
						<Input
							value={this.state.deviceProfileName}
							aria-label="Custom device profile name"
							onChange={(event) => this.setState({ deviceProfileName: event.currentTarget.value })}
						/>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Button
							size="sm"
							variant="secondary"
							onClick={() => {
								try {
									setDeviceSimulatorProfile(
										this.props.object,
										{
											expectedRevision: catalog.revision,
											id: this.state.deviceProfileId.trim(),
											name: this.state.deviceProfileName.trim(),
											platform: simulation.platform,
											width: simulation.width,
											height: simulation.height,
											dpi: simulation.dpi,
											devicePixelRatio: simulation.devicePixelRatio,
											safeArea: simulation.safeArea,
											operatingSystem: simulation.operatingSystem,
											deviceModel: simulation.deviceModel,
											cpuCores: simulation.cpuCores,
											memoryMB: simulation.memoryMB,
											graphicsApi: simulation.graphicsApi,
											touchPoints: simulation.touchPoints,
										},
										{ editor: this.props.editor }
									);
									toast.success("Custom device profile saved.");
									this.forceUpdate();
								} catch (error) {
									toast.error(error instanceof Error ? error.message : "Could not save the custom device profile.");
								}
							}}
						>
							Save Current as Profile
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={!selectedProfile || selectedProfile.builtIn}
							onClick={() => {
								void (async () => {
									if (!selectedProfile || selectedProfile.builtIn) {
										return;
									}
									if (!(await showConfirm("Delete Device Profile?", `Delete project profile ${selectedProfile.name}?`, { confirmText: "Delete" }))) {
										return;
									}
									try {
										deleteDeviceSimulatorProfile(
											this.props.object,
											{ id: selectedProfile.id, expectedRevision: catalog.revision, confirm: true },
											{ editor: this.props.editor }
										);
										this.forceUpdate();
									} catch (error) {
										toast.error(error instanceof Error ? error.message : "Could not delete the custom device profile.");
									}
								})();
							}}
						>
							Delete Project Profile
						</Button>
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getDeviceLabComponent(): ReactNode {
		const status = getDeviceLabStatus();
		const devices = listRemoteDevices().devices as any[];
		return (
			<EditorInspectorSectionField
				title="Device Lab"
				tooltip="Pairs exported Web/Electron/Capacitor players over an authenticated, bounded WebSocket channel for structured console logs, live metrics, PNG screenshots, and acknowledged primary-pointer input. It does not deploy, sign, record video, or provide native OS-wide logs."
			>
				<div className="flex flex-col gap-2 text-xs">
					<div className="flex items-center justify-between gap-2">
						<span>
							{status.listening ? `Listening on ${status.advertisedHost}:${status.port}` : "Stopped"} · {devices.length} player{devices.length === 1 ? "" : "s"}
						</span>
						<Button
							size="sm"
							variant={status.listening ? "secondary" : "default"}
							disabled={this.state.deviceLabBusy}
							onClick={() => {
								void (async () => {
									this.setState({ deviceLabBusy: true });
									try {
										if (status.listening) {
											if (
												!(await showConfirm("Stop Device Lab?", "Disconnect every paired player and discard the ephemeral pairing token?", {
													confirmText: "Stop",
												}))
											) {
												return;
											}
											await stopDeviceLab(this.props.object, { confirm: true });
											this.setState({ deviceLabPairing: null });
										} else {
											const started = await startDeviceLab(this.props.object, {}, { editor: this.props.editor });
											this.setState({ deviceLabPairing: started.pairing });
										}
									} catch (error) {
										toast.error(error instanceof Error ? error.message : "Could not change Device Lab state.");
									} finally {
										this.setState({ deviceLabBusy: false });
										this.forceUpdate();
									}
								})();
							}}
						>
							{status.listening ? "Stop" : "Start Loopback"}
						</Button>
					</div>
					{this.state.deviceLabPairing && status.listening && (
						<div className="rounded bg-input p-2 font-mono text-[10px] break-all">
							<div>{this.state.deviceLabPairing.wsUrl}</div>
							<div>Pairing token: {this.state.deviceLabPairing.pairingToken}</div>
							<div>
								Launch query: ?zvibeDeviceLab={encodeURIComponent(this.state.deviceLabPairing.wsUrl)}&amp;zvibePairingToken=
								{this.state.deviceLabPairing.pairingToken}
							</div>
						</div>
					)}
					{devices.map((device) => (
						<div key={device.connectionId} className="rounded bg-input p-2">
							<div className="font-medium">{device.identity.name}</div>
							<div className="text-muted-foreground">
								{device.identity.platform ?? "Unknown platform"} · {device.logCount} logs · {device.metricCount} metrics ·{" "}
								{device.capabilities.join(", ") || "no commands"}
							</div>
							<div className="mt-1 flex gap-1">
								<Button
									size="sm"
									variant="ghost"
									onClick={() => {
										void (async () => {
											if (
												!(await showConfirm("Clear Device Evidence?", `Discard the retained logs, metrics, and screenshot for ${device.identity.name}?`, {
													confirmText: "Clear",
												}))
											) {
												return;
											}
											clearRemoteDeviceData(this.props.object, { connectionId: device.connectionId, confirm: true });
											this.forceUpdate();
										})();
									}}
								>
									Clear Evidence
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => {
										void (async () => {
											if (!(await showConfirm("Disconnect Player?", `Disconnect ${device.identity.name} from Device Lab?`, { confirmText: "Disconnect" }))) {
												return;
											}
											disconnectRemoteDevice(this.props.object, { connectionId: device.connectionId, confirm: true });
											this.forceUpdate();
										})();
									}}
								>
									Disconnect
								</Button>
							</div>
						</div>
					))}
					{!devices.length && <div className="text-muted-foreground">No paired players. Pairing credentials exist only for this running editor session.</div>}
					<div className="text-muted-foreground">
						Loopback by default · ephemeral token · 6 MiB frames · 2,000 logs · 1,200 metric samples · no TLS unless externally terminated
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getVideoPlayersComponent(): ReactNode {
		const players = listVideoPlayers(this.props.object).players as any[];
		const materials = this.props.object.materials.filter((material) => Boolean(material.id) && !material.doNotSerialize);
		const cameras = this.props.object.cameras.filter((camera) => Boolean(camera.id) && !camera.doNotSerialize);
		const materialId = this.state.videoPlayerMaterialId || materials[0]?.id || "";
		const cameraId = this.state.videoPlayerCameraId || this.props.object.activeCamera?.id || cameras[0]?.id || "";
		const targetReady =
			this.state.videoPlayerTargetMode === "material"
				? Boolean(materialId)
				: this.state.videoPlayerTargetMode === "cameraNearPlane" || this.state.videoPlayerTargetMode === "cameraFarPlane"
					? Boolean(cameraId)
					: true;
		return (
			<EditorInspectorSectionField
				title="Video Players"
				tooltip="Persistent Unity-style Video Players with project assets or HTTP sources, material/render-texture/camera/API targets, selectable clocks, browser-safe playback, stereo layout, aspect handling, color space, and audio controls."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
						<Input
							value={this.state.videoPlayerName}
							aria-label="Video player name"
							onChange={(event) => this.setState({ videoPlayerName: event.currentTarget.value })}
							placeholder="Player name"
						/>
						<Button
							size="sm"
							disabled={!this.state.videoPlayerName.trim() || !this.state.videoPlayerPath.trim() || !targetReady}
							onClick={() => void this._createVideoPlayer(materialId, cameraId)}
						>
							Create
						</Button>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<select
							className="h-8 rounded bg-input px-2 text-sm"
							aria-label="Video source type"
							value={this.state.videoPlayerSourceType}
							onChange={(event) => this.setState({ videoPlayerSourceType: event.currentTarget.value as "asset" | "url" })}
						>
							<option value="asset">Project asset</option>
							<option value="url">HTTP / HTTPS URL</option>
						</select>
						<select
							className="h-8 rounded bg-input px-2 text-sm"
							aria-label="Video target mode"
							value={this.state.videoPlayerTargetMode}
							onChange={(event) => this.setState({ videoPlayerTargetMode: event.currentTarget.value as IEditorSceneInspectorState["videoPlayerTargetMode"] })}
						>
							<option value="material">Material texture</option>
							<option value="renderTexture">Render texture / API</option>
							<option value="cameraNearPlane">Camera near plane</option>
							<option value="cameraFarPlane">Camera far plane</option>
							<option value="apiOnly">API only</option>
						</select>
					</div>
					<Input
						value={this.state.videoPlayerPath}
						aria-label={this.state.videoPlayerSourceType === "asset" ? "Video asset path" : "Video URL"}
						onChange={(event) => this.setState({ videoPlayerPath: event.currentTarget.value })}
						placeholder={this.state.videoPlayerSourceType === "asset" ? "assets/video.webm" : "https://example.com/video.mp4"}
					/>
					{this.state.videoPlayerTargetMode === "material" && (
						<select
							className="h-8 rounded bg-input px-2 text-sm"
							aria-label="Video target material"
							value={materialId}
							onChange={(event) => this.setState({ videoPlayerMaterialId: event.currentTarget.value })}
						>
							{materials.length === 0 && <option value="">Create a material first</option>}
							{materials.map((material) => (
								<option key={material.uniqueId} value={material.id}>
									{material.name}
								</option>
							))}
						</select>
					)}
					{(this.state.videoPlayerTargetMode === "cameraNearPlane" || this.state.videoPlayerTargetMode === "cameraFarPlane") && (
						<select
							className="h-8 rounded bg-input px-2 text-sm"
							aria-label="Video target camera"
							value={cameraId}
							onChange={(event) => this.setState({ videoPlayerCameraId: event.currentTarget.value })}
						>
							{cameras.length === 0 && <option value="">Create a camera first</option>}
							{cameras.map((camera) => (
								<option key={camera.uniqueId} value={camera.id}>
									{camera.name}
								</option>
							))}
						</select>
					)}
					{players.map((player) => (
						<div key={player.id} className="flex flex-col gap-1 rounded-lg bg-input p-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<Input
									key={`${player.id}:${player.name}`}
									className="h-7 min-w-0 font-medium"
									aria-label={`${player.name} name`}
									defaultValue={player.name}
									onBlur={(event) =>
										event.currentTarget.value.trim() !== player.name && void this._setVideoPlayer(player.id, { name: event.currentTarget.value.trim() })
									}
								/>
								<Button size="sm" variant="ghost" className="h-6 px-1 !text-red-400" onClick={() => this._deleteVideoPlayer(player.id)}>
									Remove
								</Button>
							</div>
							<span className="truncate text-muted-foreground">
								{player.sourceType}: {player.path} → {this._getVideoPlayerTargetLabel(player)} · {player.runtime?.status ?? "saved"}
							</span>
							<div className="grid grid-cols-2 gap-1">
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} source type`}
									value={player.sourceType}
									onChange={(event) => {
										const sourceType = event.currentTarget.value;
										void this._setVideoPlayer(player.id, { sourceType, path: sourceType === "url" ? "https://example.com/video.mp4" : "assets/video.webm" });
									}}
								>
									<option value="asset">Project asset</option>
									<option value="url">HTTP / HTTPS URL</option>
								</select>
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} target mode`}
									value={player.targetMode}
									onChange={(event) => {
										const targetMode = event.currentTarget.value;
										void this._setVideoPlayer(player.id, {
											targetMode,
											materialId: targetMode === "material" ? materials[0]?.id : null,
											cameraId:
												targetMode === "cameraNearPlane" || targetMode === "cameraFarPlane" ? (this.props.object.activeCamera?.id ?? cameras[0]?.id) : null,
										});
									}}
								>
									<option value="material" disabled={!materials.length}>
										Material texture
									</option>
									<option value="renderTexture">Render texture / API</option>
									<option value="cameraNearPlane" disabled={!cameras.length}>
										Camera near plane
									</option>
									<option value="cameraFarPlane" disabled={!cameras.length}>
										Camera far plane
									</option>
									<option value="apiOnly">API only</option>
								</select>
							</div>
							<Input
								key={`${player.id}:${player.sourceType}:${player.path}`}
								className="h-7"
								aria-label={`${player.name} ${player.sourceType === "asset" ? "asset path" : "URL"}`}
								defaultValue={player.path}
								onBlur={(event) =>
									event.currentTarget.value.trim() !== player.path && void this._setVideoPlayer(player.id, { path: event.currentTarget.value.trim() })
								}
							/>
							{player.targetMode === "material" && (
								<div className="grid grid-cols-2 gap-1">
									<select
										className="h-7 rounded bg-background px-1"
										aria-label={`${player.name} target material`}
										value={player.materialId}
										onChange={(event) => void this._setVideoPlayer(player.id, { materialId: event.currentTarget.value })}
									>
										{materials.map((material) => (
											<option key={material.uniqueId} value={material.id}>
												{material.name}
											</option>
										))}
									</select>
									<select
										className="h-7 rounded bg-background px-1"
										aria-label={`${player.name} texture slot`}
										value={player.textureSlot}
										onChange={(event) => void this._setVideoPlayer(player.id, { textureSlot: event.currentTarget.value })}
									>
										<option value="diffuseTexture">Diffuse texture</option>
										<option value="albedoTexture">Albedo texture</option>
										<option value="emissiveTexture">Emissive texture</option>
										<option value="opacityTexture">Opacity texture</option>
									</select>
								</div>
							)}
							{(player.targetMode === "cameraNearPlane" || player.targetMode === "cameraFarPlane") && (
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} target camera`}
									value={player.cameraId ?? this.props.object.activeCamera?.id ?? ""}
									onChange={(event) => void this._setVideoPlayer(player.id, { cameraId: event.currentTarget.value })}
								>
									{cameras.map((camera) => (
										<option key={camera.uniqueId} value={camera.id}>
											{camera.name}
										</option>
									))}
								</select>
							)}
							<div className="flex flex-wrap items-center gap-2">
								<Button size="sm" variant="secondary" onClick={() => this._controlVideoPlayer(player.id, "play")}>
									Play
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._controlVideoPlayer(player.id, "pause")}>
									Pause
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._controlVideoPlayer(player.id, "seek", 0)}>
									Restart
								</Button>
							</div>
							<div className="grid grid-cols-2 gap-1">
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} update mode`}
									value={player.updateMode}
									onChange={(event) => void this._setVideoPlayer(player.id, { updateMode: event.currentTarget.value })}
								>
									<option value="audioTime">Audio / DSP time</option>
									<option value="gameTime">Game time</option>
									<option value="unscaledGameTime">Unscaled game time</option>
								</select>
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} aspect ratio`}
									value={player.aspectRatio}
									onChange={(event) => void this._setVideoPlayer(player.id, { aspectRatio: event.currentTarget.value })}
								>
									<option value="noScaling">No scaling</option>
									<option value="fitVertically">Fit vertically</option>
									<option value="fitHorizontally">Fit horizontally</option>
									<option value="fitInside">Fit inside</option>
									<option value="fitOutside">Fit outside</option>
									<option value="stretch">Stretch</option>
								</select>
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} stereo layout`}
									value={player.stereoLayout}
									onChange={(event) => void this._setVideoPlayer(player.id, { stereoLayout: event.currentTarget.value })}
								>
									<option value="none">Mono</option>
									<option value="sideBySide">Stereo side-by-side</option>
									<option value="overUnder">Stereo over-under</option>
								</select>
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} stereo eye`}
									value={player.stereoEye}
									disabled={player.stereoLayout === "none"}
									onChange={(event) => void this._setVideoPlayer(player.id, { stereoEye: event.currentTarget.value })}
								>
									<option value="left">Left eye</option>
									<option value="right">Right eye</option>
								</select>
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} color space`}
									value={player.colorSpace}
									onChange={(event) => void this._setVideoPlayer(player.id, { colorSpace: event.currentTarget.value })}
								>
									<option value="auto">Auto color space</option>
									<option value="srgb">sRGB</option>
									<option value="linear">Linear</option>
								</select>
								<select
									className="h-7 rounded bg-background px-1"
									aria-label={`${player.name} audio output`}
									value={player.audioOutputMode}
									onChange={(event) => void this._setVideoPlayer(player.id, { audioOutputMode: event.currentTarget.value })}
								>
									<option value="direct">Direct audio</option>
									<option value="none">No audio</option>
								</select>
							</div>
							<div className="grid grid-cols-2 gap-1">
								<label className="flex items-center justify-between gap-1">
									Speed
									<Input
										type="number"
										min={0.01}
										max={10}
										step={0.05}
										value={player.playbackSpeed}
										onChange={(event) => void this._setVideoPlayer(player.id, { playbackSpeed: event.currentTarget.valueAsNumber })}
										className="h-7 w-20"
									/>
								</label>
								<label className="flex items-center justify-between gap-1">
									Start (s)
									<Input
										type="number"
										min={0}
										step={0.1}
										value={player.startTime}
										onChange={(event) => void this._setVideoPlayer(player.id, { startTime: event.currentTarget.valueAsNumber })}
										className="h-7 w-20"
									/>
								</label>
								<label className="flex items-center justify-between gap-1">
									Volume
									<Input
										type="number"
										min={0}
										max={1}
										step={0.05}
										value={player.volume}
										onChange={(event) => void this._setVideoPlayer(player.id, { volume: event.currentTarget.valueAsNumber })}
										className="h-7 w-20"
									/>
								</label>
								<label className="flex items-center justify-between gap-1">
									Alpha
									<Input
										type="number"
										min={0}
										max={1}
										step={0.05}
										value={player.alpha}
										onChange={(event) => void this._setVideoPlayer(player.id, { alpha: event.currentTarget.valueAsNumber })}
										className="h-7 w-20"
									/>
								</label>
							</div>
							<div className="flex flex-wrap items-center gap-3">
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={player.playOnAwake}
										onChange={(event) => void this._setVideoPlayer(player.id, { playOnAwake: event.currentTarget.checked })}
									/>{" "}
									play on awake
								</label>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={player.waitForFirstFrame}
										onChange={(event) => void this._setVideoPlayer(player.id, { waitForFirstFrame: event.currentTarget.checked })}
									/>{" "}
									wait first frame
								</label>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={player.loop}
										onChange={(event) => void this._setVideoPlayer(player.id, { loop: event.currentTarget.checked })}
									/>{" "}
									loop
								</label>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={player.skipOnDrop}
										onChange={(event) => void this._setVideoPlayer(player.id, { skipOnDrop: event.currentTarget.checked })}
									/>{" "}
									skip on drop
								</label>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={player.muted}
										onChange={(event) => void this._setVideoPlayer(player.id, { muted: event.currentTarget.checked })}
									/>{" "}
									muted
								</label>
							</div>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getVideoPlayerTargetLabel(player: any): string {
		if (player.targetMode === "material") {
			return `${this.props.object.getMaterialById(player.materialId)?.name ?? player.materialId}.${player.textureSlot}`;
		}
		if (player.targetMode === "cameraNearPlane" || player.targetMode === "cameraFarPlane") {
			return `${this.props.object.getCameraById(player.cameraId)?.name ?? player.cameraId ?? "Active Camera"} ${player.targetMode === "cameraNearPlane" ? "near plane" : "far plane"}`;
		}
		return player.targetMode === "renderTexture" ? "named render texture / API" : "API only";
	}

	private async _createVideoPlayer(materialId: string, cameraId: string): Promise<void> {
		try {
			await createVideoPlayer(
				this.props.object,
				{
					name: this.state.videoPlayerName.trim(),
					path: this.state.videoPlayerPath.trim(),
					sourceType: this.state.videoPlayerSourceType,
					targetMode: this.state.videoPlayerTargetMode,
					materialId: this.state.videoPlayerTargetMode === "material" ? materialId : null,
					cameraId: this.state.videoPlayerTargetMode === "cameraNearPlane" || this.state.videoPlayerTargetMode === "cameraFarPlane" ? cameraId : null,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create video player.");
		}
	}

	private async _setVideoPlayer(id: string, update: any): Promise<void> {
		try {
			await setVideoPlayer(this.props.object, { id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update video player.");
		}
	}

	private async _controlVideoPlayer(id: string, action: "play" | "pause" | "seek", time?: number): Promise<void> {
		try {
			await controlVideoPlayer(this.props.object, { id, action, time });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not control video preview.");
		}
	}

	private _deleteVideoPlayer(id: string): void {
		try {
			deleteVideoPlayer(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not delete video player.");
		}
	}

	private _getVfxBudgetProfilesComponent(): ReactNode {
		const profiles = listVfxBudgetProfiles(this.props.object).profiles as any[];
		return (
			<EditorInspectorSectionField
				title="VFX Budget Profiles"
				tooltip="Reusable particle quality profiles. Applying a profile changes capacity and emission on all CPU/GPU particle systems before saving/exporting."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
						<Input
							value={this.state.vfxBudgetProfileName}
							aria-label="VFX budget profile name"
							onChange={(event) => this.setState({ vfxBudgetProfileName: event.currentTarget.value })}
							placeholder="Profile name"
						/>
						<Button size="sm" disabled={!this.state.vfxBudgetProfileName.trim()} onClick={() => this._createVfxBudgetProfile()}>
							Create
						</Button>
					</div>
					<div className="grid grid-cols-3 gap-2">
						<Input
							type="number"
							min={0.01}
							step={0.05}
							value={this.state.vfxCapacityScale}
							aria-label="VFX capacity scale"
							onChange={(event) => this.setState({ vfxCapacityScale: Number(event.currentTarget.value) })}
						/>
						<Input
							type="number"
							min={0}
							step={0.05}
							value={this.state.vfxEmissionScale}
							aria-label="VFX emission scale"
							onChange={(event) => this.setState({ vfxEmissionScale: Number(event.currentTarget.value) })}
						/>
						<Input
							type="number"
							min={1}
							step={1}
							value={this.state.vfxMaxCapacity}
							aria-label="VFX maximum capacity"
							onChange={(event) => this.setState({ vfxMaxCapacity: Number(event.currentTarget.value) })}
						/>
					</div>
					<div className="text-xs text-muted-foreground">Capacity scale · emission scale · maximum capacity</div>
					{profiles.map((profile) => (
						<div key={profile.id} className="flex items-center justify-between gap-2 rounded-lg bg-input p-2 text-xs">
							<span className="truncate">
								{profile.name}: {profile.capacityScale}× capacity, {profile.emissionScale}× emission, max {profile.maxCapacity ?? "∞"}
							</span>
							<div className="flex gap-1">
								<Button size="sm" variant="secondary" className="h-6 px-2" onClick={() => this._applyVfxBudgetProfile(profile.id)}>
									Apply
								</Button>
								<Button size="sm" variant="ghost" className="h-6 px-1 !text-red-400" onClick={() => this._deleteVfxBudgetProfile(profile.id)}>
									Remove
								</Button>
							</div>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createVfxBudgetProfile(): void {
		try {
			createVfxBudgetProfile(
				this.props.object,
				{
					name: this.state.vfxBudgetProfileName.trim(),
					capacityScale: this.state.vfxCapacityScale,
					emissionScale: this.state.vfxEmissionScale,
					maxCapacity: this.state.vfxMaxCapacity,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create VFX budget profile.");
		}
	}

	private _applyVfxBudgetProfile(id: string): void {
		try {
			applyVfxBudgetProfile(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not apply VFX budget profile.");
		}
	}

	private _deleteVfxBudgetProfile(id: string): void {
		try {
			deleteVfxBudgetProfile(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not delete VFX budget profile.");
		}
	}

	private _getAddressablesComponent(): ReactNode {
		return <AddressablesInspector scene={this.props.object} editor={this.props.editor} />;
	}

	private _getSpriteAtlasPackerComponent(): ReactNode {
		return (
			<EditorInspectorSectionField
				title="Sprite Atlas Packer"
				tooltip="Pack project PNG assets into a power-of-two atlas PNG and JSON descriptor accepted by Sprite Managers and Sprite Maps."
			>
				<div className="flex flex-col gap-2">
					<Input
						value={this.state.spriteAtlasSources}
						aria-label="Sprite atlas source PNG paths"
						onChange={(event) => this.setState({ spriteAtlasSources: event.currentTarget.value, spriteAtlasError: null })}
						placeholder="assets/hero.png, assets/enemy.png"
					/>
					<div className="grid grid-cols-[minmax(0,1fr)_6rem_auto] gap-2">
						<Input
							value={this.state.spriteAtlasOutputPath}
							aria-label="Sprite atlas output path"
							onChange={(event) => this.setState({ spriteAtlasOutputPath: event.currentTarget.value, spriteAtlasError: null })}
							placeholder="assets/atlas.png"
						/>
						<Input
							type="number"
							min={0}
							max={64}
							value={this.state.spriteAtlasPadding}
							aria-label="Sprite atlas padding"
							onChange={(event) => this.setState({ spriteAtlasPadding: Number(event.currentTarget.value), spriteAtlasError: null })}
						/>
						<Button size="sm" disabled={!this.state.spriteAtlasSources.trim() || !this.state.spriteAtlasOutputPath.trim()} onClick={() => void this._packSpriteAtlas()}>
							Pack
						</Button>
					</div>
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={this.state.spriteAtlasTrimTransparent}
							onChange={(event) => this.setState({ spriteAtlasTrimTransparent: event.currentTarget.checked, spriteAtlasError: null })}
						/>
						Trim transparent borders (preserve source offsets)
					</label>
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={this.state.spriteAtlasAllowRotation}
							onChange={(event) => this.setState({ spriteAtlasAllowRotation: event.currentTarget.checked, spriteAtlasError: null })}
						/>
						Allow 90° rotation (Sprite Manager and Sprite Map compatible)
					</label>
					<div className="text-xs text-muted-foreground">Comma-separated PNG paths · output JSON uses the same name with a .json extension</div>
					{this.state.spriteAtlasError && <div className="text-xs text-red-400">{this.state.spriteAtlasError}</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _packSpriteAtlas(): Promise<void> {
		try {
			await packSpriteAtlas(
				this.props.object,
				{
					sourcePaths: this.state.spriteAtlasSources
						.split(",")
						.map((path) => path.trim())
						.filter(Boolean),
					outputPath: this.state.spriteAtlasOutputPath.trim(),
					padding: this.state.spriteAtlasPadding,
					trimTransparent: this.state.spriteAtlasTrimTransparent,
					allowRotation: this.state.spriteAtlasAllowRotation,
				},
				{ editor: this.props.editor }
			);
			this.setState({ spriteAtlasError: null });
		} catch (error) {
			this.setState({ spriteAtlasError: error instanceof Error ? error.message : "Could not pack sprite atlas." });
		}
	}

	private _getSpriteSheetSlicerComponent(): ReactNode {
		return (
			<EditorInspectorSectionField title="Irregular Sprite Slicing" tooltip="Create named, non-grid sprite frames from one source image as an atlas JSON descriptor.">
				<div className="flex flex-col gap-2">
					<Input
						value={this.state.spriteSheetSourcePath}
						aria-label="Sprite sheet source image path"
						onChange={(event) => this.setState({ spriteSheetSourcePath: event.currentTarget.value, spriteSheetError: null })}
						placeholder="assets/characters.png"
					/>
					<Input
						value={this.state.spriteSheetOutputPath}
						aria-label="Sprite sheet descriptor path"
						onChange={(event) => this.setState({ spriteSheetOutputPath: event.currentTarget.value, spriteSheetError: null })}
						placeholder="assets/characters.json"
					/>
					<textarea
						className="min-h-24 rounded bg-input p-2 font-mono text-xs"
						value={this.state.spriteSheetFrames}
						aria-label="Irregular sprite frame JSON"
						onChange={(event) => this.setState({ spriteSheetFrames: event.currentTarget.value, spriteSheetError: null })}
					/>
					<Button size="sm" disabled={!this.state.spriteSheetSourcePath.trim() || !this.state.spriteSheetOutputPath.trim()} onClick={() => void this._sliceSpriteSheet()}>
						Create Descriptor
					</Button>
					<div className="text-xs text-muted-foreground">Frame JSON: name, x, y, width, height in source pixels</div>
					{this.state.spriteSheetError && <div className="text-xs text-red-400">{this.state.spriteSheetError}</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _sliceSpriteSheet(): Promise<void> {
		try {
			const frames = JSON.parse(this.state.spriteSheetFrames);
			await sliceSpriteSheet(
				this.props.object,
				{ sourcePath: this.state.spriteSheetSourcePath.trim(), outputPath: this.state.spriteSheetOutputPath.trim(), frames },
				{ editor: this.props.editor }
			);
			this.setState({ spriteSheetError: null });
		} catch (error) {
			this.setState({ spriteSheetError: error instanceof Error ? error.message : "Could not slice sprite sheet." });
		}
	}

	private _getAudioMixerComponent(): ReactNode {
		const buses = listAudioBuses(this.props.object).buses as any[];
		const snapshots = listAudioMixerSnapshots(this.props.object).snapshots as any[];
		const runtime = getAudioMixerRuntime(this.props.object);
		const reverbZones = listAudioReverbZones(this.props.object).zones as any[];
		const reverbEffects = buses.flatMap((bus) =>
			(bus.effects ?? [])
				.filter((effect: any) => effect.type === "convolutionReverb")
				.map((effect: any) => ({ ...effect, busId: bus.id, busPath: runtime.buses.find((value: any) => value.id === bus.id)?.path ?? bus.name }))
		);
		const hasActiveSidechain = runtime.buses.some((bus: any) => bus.sends.some((send: any) => send.kind === "sidechain" && send.enabled));
		if ((runtime.transition || hasActiveSidechain || reverbZones.length > 0) && !this._audioMixerRefreshTimeout) {
			this._audioMixerRefreshTimeout = setTimeout(() => {
				this._audioMixerRefreshTimeout = null;
				this.forceUpdate();
			}, 100);
		}
		return (
			<EditorInspectorSectionField
				title="Audio Mixer"
				tooltip="Hierarchical Master routing backed by Babylon AudioV2 buses, inherited gain/pitch, mute/solo, and blendable snapshots."
			>
				<Button size="sm" variant="secondary" className="w-full" onClick={() => this._createAudioBus()}>
					Add Mixer Bus
				</Button>
				{buses.length === 0 ? (
					<div className="px-2 text-xs text-muted-foreground">No mixer buses. Add a group under Master, then assign SoundNodes in their Inspector.</div>
				) : (
					buses.map((bus) => {
						const busRuntime = runtime.buses.find((value: any) => value.id === bus.id);
						return (
							<div key={bus.id} className="flex flex-col gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
								<div className="flex items-center justify-between gap-2">
									<div className="min-w-0">
										<div className="truncate font-medium">{bus.name}</div>
										<div className="truncate text-muted-foreground">{busRuntime?.path ?? `Master/${bus.name}`}</div>
									</div>
									<span className={busRuntime?.nativeConnected ? "text-green-400" : "text-muted-foreground"}>
										{busRuntime?.nativeConnected ? "AudioV2" : "Fallback"}
									</span>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<label className="flex flex-col gap-1">
										<span>Gain</span>
										<Input
											type="number"
											min="0"
											max="16"
											step="0.05"
											value={String(bus.gain)}
											onChange={(event) => this._setAudioBusGain(bus, event.target.value)}
										/>
									</label>
									<label className="flex flex-col gap-1">
										<span>Pitch</span>
										<Input
											type="number"
											min="0.01"
											max="4"
											step="0.01"
											value={String(bus.pitch ?? 1)}
											onChange={(event) => this._setAudioBusPitch(bus, event.target.value)}
										/>
									</label>
								</div>
								<label className="flex items-center justify-between gap-2">
									<span>Output</span>
									<select
										className="h-8 max-w-56 rounded-md border border-input bg-background px-2"
										value={bus.parentBusId ?? ""}
										onChange={(event) => this._setAudioBusParent(bus, event.target.value || null)}
									>
										<option value="">Master</option>
										{buses
											.filter((candidate) => candidate.id !== bus.id)
											.map((candidate) => (
												<option key={candidate.id} value={candidate.id}>
													{runtime.buses.find((value: any) => value.id === candidate.id)?.path ?? candidate.name}
												</option>
											))}
									</select>
								</label>
								<div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2">
									<span className="font-medium">Sends / Sidechains</span>
									<div className="flex gap-1">
										<Button size="sm" variant="ghost" disabled={buses.length < 2} onClick={() => this._createAudioSend(bus, "return")}>
											+ Return
										</Button>
										<Button size="sm" variant="ghost" disabled={buses.length < 2} onClick={() => this._createAudioSend(bus, "sidechain")}>
											+ Duck
										</Button>
									</div>
								</div>
								{(bus.sends ?? []).map((send: any) => {
									const sendRuntime = busRuntime?.sends?.find((value: any) => value.id === send.id);
									return (
										<div key={send.id} className="flex flex-col gap-2 rounded-md border border-border/50 p-2">
											<div className="flex items-center justify-between gap-2">
												<span className="truncate font-medium">{send.name}</span>
												<span className={sendRuntime?.nativeConnected ? "text-green-400" : "text-muted-foreground"}>
													{send.kind === "sidechain" ? "Sidechain" : "Return"} · {sendRuntime?.nativeConnected ? "AudioV2" : "Fallback"}
												</span>
											</div>
											<div className="grid grid-cols-2 gap-2">
												<label className="flex flex-col gap-1">
													<span>Target</span>
													<select
														className="h-8 rounded-md border border-input bg-background px-2"
														value={send.targetBusId}
														onChange={(event) => this._setAudioSend(bus, send, { targetBusId: event.target.value })}
													>
														{buses
															.filter((candidate) => candidate.id !== bus.id)
															.map((candidate) => (
																<option key={candidate.id} value={candidate.id}>
																	{runtime.buses.find((value: any) => value.id === candidate.id)?.path ?? candidate.name}
																</option>
															))}
													</select>
												</label>
												<label className="flex flex-col gap-1">
													<span>Level</span>
													<Input
														type="number"
														min="0"
														max="16"
														step="0.05"
														value={String(send.gain)}
														onChange={(event) => this._setAudioSendGain(bus, send, event.target.value)}
													/>
												</label>
											</div>
											{send.kind === "sidechain" && send.ducking && (
												<>
													<div className="grid grid-cols-3 gap-2">
														{(["threshold", "ratio", "maxReductionDb"] as const).map((key) => (
															<label key={key} className="flex flex-col gap-1">
																<span>{key === "maxReductionDb" ? "Max dB" : key === "threshold" ? "Threshold" : "Ratio"}</span>
																<Input
																	type="number"
																	step="0.01"
																	value={String(send.ducking[key])}
																	onChange={(event) => this._setAudioSendDucking(bus, send, key, event.target.value)}
																/>
															</label>
														))}
													</div>
													<div className="grid grid-cols-2 gap-2">
														{(["attackSeconds", "releaseSeconds"] as const).map((key) => (
															<label key={key} className="flex flex-col gap-1">
																<span>{key === "attackSeconds" ? "Attack s" : "Release s"}</span>
																<Input
																	type="number"
																	step="0.01"
																	value={String(send.ducking[key])}
																	onChange={(event) => this._setAudioSendDucking(bus, send, key, event.target.value)}
																/>
															</label>
														))}
													</div>
													<div className="text-muted-foreground">
														Signal {Number(sendRuntime?.signalLevel ?? 0).toFixed(3)} · duck gain {Number(sendRuntime?.duckGain ?? 1).toFixed(3)}
													</div>
												</>
											)}
											<div className="flex gap-2">
												<Button
													size="sm"
													className="flex-1"
													variant={send.enabled === false ? "ghost" : "default"}
													onClick={() => this._setAudioSend(bus, send, { enabled: send.enabled === false })}
												>
													{send.enabled === false ? "Enable" : "Enabled"}
												</Button>
												<Button size="sm" className="flex-1 hover:bg-destructive" variant="ghost" onClick={() => this._deleteAudioSend(bus, send)}>
													Remove
												</Button>
											</div>
										</div>
									);
								})}
								<div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2">
									<span className="font-medium">DSP Effect Chain</span>
									<Button size="sm" variant="ghost" onClick={() => this._createAudioEffect(bus)}>
										+ Effect
									</Button>
								</div>
								{(bus.effects ?? []).map((effect: any, effectIndex: number) => {
									const effectRuntime = busRuntime?.effects?.find((value: any) => value.id === effect.id);
									return (
										<div key={effect.id} className="flex flex-col gap-2 rounded-md border border-border/50 p-2">
											<div className="flex items-center justify-between gap-2">
												<span className="truncate font-medium">
													{effectIndex + 1}. {effect.name}
												</span>
												<span className={effectRuntime?.nativeConnected ? "text-green-400" : "text-muted-foreground"}>
													{effectRuntime?.nativeConnected ? "WebAudio DSP" : "Fallback"}
												</span>
											</div>
											<div className="grid grid-cols-2 gap-2">
												<label className="flex flex-col gap-1">
													<span>Type</span>
													<select
														className="h-8 rounded-md border border-input bg-background px-2"
														value={effect.type}
														onChange={(event) => this._setAudioEffect(bus, effect, { type: event.target.value })}
													>
														{[
															"gain",
															"lowpass",
															"highpass",
															"parametricEq",
															"compressor",
															"distortion",
															"echo",
															"chorus",
															"flanger",
															"stereoPanner",
															"convolutionReverb",
														].map((type) => (
															<option key={type} value={type}>
																{type}
															</option>
														))}
													</select>
												</label>
												<label className="flex flex-col gap-1">
													<span>Wet</span>
													<Input
														type="number"
														min="0"
														max="1"
														step="0.01"
														value={String(effect.wet ?? 1)}
														onChange={(event) => this._setAudioEffectNumber(bus, effect, "wet", event.target.value)}
													/>
												</label>
											</div>
											<div className="grid grid-cols-2 gap-2">
												{Object.entries(effect.parameters ?? {}).map(([name, value]) => (
													<label key={name} className="flex flex-col gap-1">
														<span>{name}</span>
														{typeof value === "string" ? (
															<select
																className="h-8 rounded-md border border-input bg-background px-2"
																value={value}
																onChange={(event) => this._setAudioEffectParameter(bus, effect, name, event.target.value)}
															>
																{["none", "2x", "4x"].map((option) => (
																	<option key={option} value={option}>
																		{option}
																	</option>
																))}
															</select>
														) : (
															<Input
																type="number"
																step="0.01"
																value={String(value)}
																onChange={(event) => this._setAudioEffectParameter(bus, effect, name, event.target.value)}
															/>
														)}
													</label>
												))}
											</div>
											<div className="flex gap-1">
												<Button
													size="sm"
													variant="ghost"
													disabled={effectIndex === 0}
													onClick={() => this._setAudioEffect(bus, effect, { index: effectIndex - 1 })}
												>
													Up
												</Button>
												<Button
													size="sm"
													variant="ghost"
													disabled={effectIndex === bus.effects.length - 1}
													onClick={() => this._setAudioEffect(bus, effect, { index: effectIndex + 1 })}
												>
													Down
												</Button>
												<Button
													size="sm"
													className="flex-1"
													variant={effect.enabled === false ? "ghost" : "default"}
													onClick={() => this._setAudioEffect(bus, effect, { enabled: effect.enabled === false })}
												>
													{effect.enabled === false ? "Bypassed" : "Enabled"}
												</Button>
												<Button size="sm" className="hover:bg-destructive" variant="ghost" onClick={() => this._deleteAudioEffect(bus, effect)}>
													Remove
												</Button>
											</div>
										</div>
									);
								})}
								<div className="text-muted-foreground">
									{bus.soundNodeIds.length} sound node{bus.soundNodeIds.length === 1 ? "" : "s"} · effective gain{" "}
									{Number(busRuntime?.effectiveGain ?? bus.gain).toFixed(3)} · pitch {Number(busRuntime?.effectivePitch ?? bus.pitch ?? 1).toFixed(3)}
								</div>
								<div className="flex gap-2">
									<Button size="sm" className="flex-1" variant={bus.muted ? "default" : "ghost"} onClick={() => this._setAudioBusMuted(bus, !bus.muted)}>
										Mute
									</Button>
									<Button size="sm" className="flex-1" variant={bus.solo ? "default" : "ghost"} onClick={() => this._setAudioBusSolo(bus, !bus.solo)}>
										Solo
									</Button>
									<Button size="sm" className="flex-1 hover:bg-destructive" variant="ghost" onClick={() => this._deleteAudioBus(bus.id)}>
										Remove
									</Button>
								</div>
							</div>
						);
					})
				)}
				<div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
					<div>
						<div className="text-xs font-medium">Spatial Reverb Zones</div>
						<div className="text-xs text-muted-foreground">Listener {runtime.listenerPosition.map((value: number) => value.toFixed(1)).join(", ")} cm</div>
					</div>
					<Button size="sm" variant="secondary" onClick={() => this._createAudioReverbZone()}>
						Add Zone
					</Button>
				</div>
				{reverbZones.map((zone) => {
					const zoneRuntime = runtime.reverbZones.find((value: any) => value.id === zone.id);
					return (
						<div key={zone.id} className="flex flex-col gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate font-medium">{zone.name}</span>
								<span className={zoneRuntime?.active ? "text-green-400" : "text-muted-foreground"}>
									{zoneRuntime?.active ? "Active" : "Inactive"} · weight {Number(zoneRuntime?.weight ?? 0).toFixed(3)}
								</span>
							</div>
							<div className="grid grid-cols-2 gap-2">
								<label className="flex flex-col gap-1">
									<span>Reverb Effect</span>
									<select
										className="h-8 rounded-md border border-input bg-background px-2"
										value={zone.effectId}
										onChange={(event) => this._setAudioReverbZone(zone, { effectId: event.target.value })}
									>
										{reverbEffects.map((effect) => (
											<option key={effect.id} value={effect.id}>
												{effect.busPath}/{effect.name}
											</option>
										))}
									</select>
								</label>
								<label className="flex flex-col gap-1">
									<span>Shape</span>
									<select
										className="h-8 rounded-md border border-input bg-background px-2"
										value={zone.shape}
										onChange={(event) => this._setAudioReverbZone(zone, { shape: event.target.value })}
									>
										<option value="sphere">Sphere</option>
										<option value="box">Box</option>
									</select>
								</label>
							</div>
							<div className="grid grid-cols-3 gap-2">
								{zone.position.map((value: number, index: number) => (
									<label key={index} className="flex flex-col gap-1">
										<span>{["X", "Y", "Z"][index]} cm</span>
										<Input
											type="number"
											step="1"
											value={String(value)}
											onChange={(event) => this._setAudioReverbZoneVector(zone, "position", index, event.target.value)}
										/>
									</label>
								))}
							</div>
							{zone.shape === "sphere" ? (
								<div className="grid grid-cols-2 gap-2">
									{(["innerRadius", "outerRadius"] as const).map((key) => (
										<label key={key} className="flex flex-col gap-1">
											<span>{key === "innerRadius" ? "Inner Radius cm" : "Outer Radius cm"}</span>
											<Input
												type="number"
												min="0"
												step="1"
												value={String(zone[key])}
												onChange={(event) => this._setAudioReverbZoneNumber(zone, key, event.target.value)}
											/>
										</label>
									))}
								</div>
							) : (
								<>
									<div className="grid grid-cols-3 gap-2">
										{zone.size.map((value: number, index: number) => (
											<label key={index} className="flex flex-col gap-1">
												<span>Size {["X", "Y", "Z"][index]}</span>
												<Input
													type="number"
													min="0.0001"
													step="1"
													value={String(value)}
													onChange={(event) => this._setAudioReverbZoneVector(zone, "size", index, event.target.value)}
												/>
											</label>
										))}
									</div>
									<label className="flex flex-col gap-1">
										<span>Blend Distance cm</span>
										<Input
											type="number"
											min="0"
											step="1"
											value={String(zone.blendDistance)}
											onChange={(event) => this._setAudioReverbZoneNumber(zone, "blendDistance", event.target.value)}
										/>
									</label>
								</>
							)}
							<div className="text-muted-foreground">
								{zoneRuntime?.targetPath ?? "Missing target"} · distance {Number(zoneRuntime?.distance ?? 0).toFixed(1)} cm ·{" "}
								{zoneRuntime?.nativeConnected ? "Convolver connected" : "Fallback"}
							</div>
							<div className="flex gap-2">
								<label className="flex flex-1 items-center gap-2">
									<span>Priority</span>
									<Input
										type="number"
										min="-1000"
										max="1000"
										step="1"
										value={String(zone.priority ?? 0)}
										onChange={(event) => this._setAudioReverbZoneNumber(zone, "priority", event.target.value)}
									/>
								</label>
								<Button
									size="sm"
									variant={zone.enabled === false ? "ghost" : "default"}
									onClick={() => this._setAudioReverbZone(zone, { enabled: zone.enabled === false })}
								>
									{zone.enabled === false ? "Disabled" : "Enabled"}
								</Button>
								<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteAudioReverbZone(zone)}>
									Remove
								</Button>
							</div>
						</div>
					);
				})}
				<div className="mt-2 flex items-center justify-between gap-2">
					<span className="text-xs font-medium">Snapshots</span>
					<Button size="sm" variant="secondary" onClick={() => this._createAudioMixerSnapshot()}>
						Capture
					</Button>
				</div>
				{snapshots.map((snapshot) => (
					<div key={snapshot.id} className="flex items-center gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<span className="min-w-0 flex-1 truncate">{snapshot.name}</span>
						<Button size="sm" variant="ghost" onClick={() => this._applyAudioMixerSnapshot(snapshot.id, 0)}>
							Apply
						</Button>
						<Button size="sm" variant="ghost" onClick={() => this._applyAudioMixerSnapshot(snapshot.id, 1)}>
							Blend 1s
						</Button>
						<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteAudioMixerSnapshot(snapshot.id)}>
							Remove
						</Button>
					</div>
				))}
				{runtime.transition && (
					<div className="text-xs text-blue-300">
						Blending {runtime.transition.snapshotName}: {(runtime.transition.progress * 100).toFixed(1)}% · {runtime.transition.shape}
					</div>
				)}
				{runtime.warnings.map((warning: string) => (
					<div key={warning} className="text-xs text-amber-400">
						{warning}
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _getAudioRuntimeDiagnosticsComponent(): ReactNode {
		const diagnostics = listAudioRuntimeDiagnostics(this.props.object);
		const profile = getAudioMixerProfile(this.props.object, { includeSamples: true, sampleLimit: 1 });
		const latestProfileSample = profile.samples[0] as any;
		if (profile.settings.enabled && !this._audioMixerRefreshTimeout) {
			this._audioMixerRefreshTimeout = setTimeout(() => {
				this._audioMixerRefreshTimeout = null;
				this.forceUpdate();
			}, 250);
		}
		return (
			<EditorInspectorSectionField
				title="Audio Runtime Diagnostics"
				tooltip="Live SoundNode playback, mixer assignment, and effective-volume state. Refresh after changing playback or mixer controls."
			>
				<div className="text-xs text-muted-foreground">
					{diagnostics.summary.playingCount} playing · {diagnostics.summary.loadedCount}/{diagnostics.summary.soundCount} loaded · {diagnostics.summary.busCount} buses
				</div>
				{diagnostics.sounds.length === 0 ? (
					<div className="text-xs text-muted-foreground">No SoundNodes in this scene.</div>
				) : (
					diagnostics.sounds.map((sound: any) => (
						<div key={sound.nodeId} className="rounded-lg bg-muted-foreground/10 p-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate font-medium">{sound.name}</span>
								<span className={sound.isPlaying ? "text-green-400" : "text-muted-foreground"}>
									{sound.isPlaying ? "Playing" : sound.loaded ? "Stopped" : "Unloaded"}
								</span>
							</div>
							<div className="mt-1 text-muted-foreground">
								{sound.bus?.name ?? "No bus"} · effective volume {Number(sound.effectiveVolume).toFixed(2)} · {sound.spatial ? "3D" : "2D"}
							</div>
						</div>
					))
				)}
				{diagnostics.missingBusSoundNodeIds.length > 0 && (
					<div className="text-xs text-amber-400">Missing bus assignments: {diagnostics.missingBusSoundNodeIds.length}</div>
				)}
				<div className="mt-2 space-y-2 border-t border-border/50 pt-2">
					<div className="flex items-center justify-between gap-2">
						<div>
							<div className="text-xs font-medium">Audio Profiler</div>
							<div className="text-xs text-muted-foreground">Shared mixer CPU, voices, latency, estimated levels, and clipping.</div>
						</div>
						<Button
							size="sm"
							variant={profile.settings.enabled ? "destructive" : "secondary"}
							onClick={() => this._setAudioMixerProfiler({ enabled: !profile.settings.enabled })}
						>
							{profile.settings.enabled ? "Stop" : "Start"}
						</Button>
					</div>
					<div className="grid grid-cols-2 gap-2 text-xs">
						<label className="flex flex-col gap-1">
							<span>Sample capacity</span>
							<Input
								type="number"
								min="1"
								max="256"
								value={String(profile.settings.sampleCapacity)}
								onChange={(event) => this._setAudioMixerProfiler({ sampleCapacity: Math.max(1, Math.min(256, Number(event.target.value) || 1)) })}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span>Every N updates</span>
							<Input
								type="number"
								min="1"
								max="120"
								value={String(profile.settings.sampleEveryNUpdates)}
								onChange={(event) => this._setAudioMixerProfiler({ sampleEveryNUpdates: Math.max(1, Math.min(120, Number(event.target.value) || 1)) })}
							/>
						</label>
					</div>
					<div className={profile.settings.enabled ? "text-xs text-emerald-400" : "text-xs text-muted-foreground"}>
						{profile.settings.enabled ? "Recording" : "Stopped"} · {profile.capturedSampleCount} captured · {profile.retainedSampleCount} retained ·{" "}
						{profile.droppedSampleCount} dropped
					</div>
					<div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
						<span>Latest mixer CPU: {Number(latestProfileSample?.mixerCpuMilliseconds ?? 0).toFixed(3)} ms</span>
						<span>Average: {Number(profile.summary.averageMixerCpuMilliseconds).toFixed(3)} ms</span>
						<span>
							Voices: {latestProfileSample?.playingVoiceCount ?? 0}/{latestProfileSample?.voiceCount ?? 0} playing
						</span>
						<span>
							Spatial: {latestProfileSample?.spatialVoiceCount ?? 0} · Streaming: {latestProfileSample?.streamingVoiceCount ?? 0}
						</span>
						<span>Estimated peak: {Number(latestProfileSample?.estimatedPeakLevel ?? 0).toFixed(3)}</span>
						<span>Estimated clipped buses: {latestProfileSample?.estimatedClippedBusCount ?? 0}</span>
						<span>Sample rate: {latestProfileSample?.audioContext?.sampleRate ?? "Unavailable"}</span>
						<span>
							Latency:{" "}
							{typeof latestProfileSample?.audioContext?.baseLatencySeconds === "number"
								? `${(latestProfileSample.audioContext.baseLatencySeconds * 1000).toFixed(2)} ms`
								: "Unavailable"}
						</span>
					</div>
					{profile.busSummaries.slice(0, 8).map((bus: any) => (
						<div key={bus.busId} className="grid grid-cols-[1fr_auto] gap-2 rounded border border-border/50 px-1 py-0.5 text-xs">
							<span className="truncate">{bus.path}</span>
							<span>
								peak {Number(bus.lastEstimatedPeakLevel).toFixed(3)} · max {Number(bus.maximumEstimatedPeakLevel).toFixed(3)}
							</span>
						</div>
					))}
					<div className="text-xs text-muted-foreground">
						Native DSP-thread CPU and hardware clip counters are unavailable in WebAudio; values above are explicitly scoped.
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Button size="sm" variant="outline" onClick={() => this.forceUpdate()}>
							Refresh
						</Button>
						<Button size="sm" variant="ghost" onClick={() => this._clearAudioMixerProfiler()}>
							Clear Samples
						</Button>
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createAudioBus(): void {
		try {
			const buses = listAudioBuses(this.props.object).buses as any[];
			createAudioBus(this.props.object, { name: `Bus ${buses.length + 1}` }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioBusGain(bus: any, value: string): void {
		const gain = Number(value);
		if (!Number.isFinite(gain) || gain < 0) {
			return;
		}
		try {
			setAudioBus(this.props.object, { busId: bus.id, gain }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioBusPitch(bus: any, value: string): void {
		const pitch = Number(value);
		if (!Number.isFinite(pitch) || pitch < 0.01 || pitch > 4) {
			return;
		}
		try {
			setAudioBus(this.props.object, { busId: bus.id, pitch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioBusParent(bus: any, parentBusId: string | null): void {
		try {
			setAudioBus(this.props.object, { busId: bus.id, parentBusId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createAudioSend(bus: any, kind: "return" | "sidechain"): void {
		const buses = listAudioBuses(this.props.object).buses as any[];
		const target = buses.find((candidate) => candidate.id !== bus.id);
		if (!target) {
			return;
		}
		try {
			createAudioSend(
				this.props.object,
				{
					sourceBusId: bus.id,
					targetBusId: target.id,
					name: `${kind === "sidechain" ? "Duck" : "Return"} ${(bus.sends?.length ?? 0) + 1}`,
					kind,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioSend(bus: any, send: any, changes: Record<string, unknown>): void {
		try {
			setAudioSend(this.props.object, { sourceBusId: bus.id, sendId: send.id, ...changes }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioSendGain(bus: any, send: any, value: string): void {
		const gain = Number(value);
		if (!Number.isFinite(gain) || gain < 0 || gain > 16) {
			return;
		}
		this._setAudioSend(bus, send, { gain });
	}

	private _setAudioSendDucking(bus: any, send: any, key: string, value: string): void {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue)) {
			return;
		}
		this._setAudioSend(bus, send, { ducking: { ...send.ducking, [key]: numericValue } });
	}

	private _deleteAudioSend(bus: any, send: any): void {
		try {
			deleteAudioSend(this.props.object, { sourceBusId: bus.id, sendId: send.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createAudioEffect(bus: any): void {
		try {
			createAudioEffect(this.props.object, { busId: bus.id, name: `Low Pass ${(bus.effects?.length ?? 0) + 1}`, type: "lowpass" }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioEffect(bus: any, effect: any, changes: Record<string, unknown>): void {
		try {
			setAudioEffect(this.props.object, { busId: bus.id, effectId: effect.id, ...changes }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioEffectNumber(bus: any, effect: any, name: string, value: string): void {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue)) {
			return;
		}
		this._setAudioEffect(bus, effect, { [name]: numericValue });
	}

	private _setAudioEffectParameter(bus: any, effect: any, name: string, value: string): void {
		const parameterValue = typeof effect.parameters[name] === "number" ? Number(value) : value;
		if (typeof parameterValue === "number" && !Number.isFinite(parameterValue)) {
			return;
		}
		this._setAudioEffect(bus, effect, { parameters: { ...effect.parameters, [name]: parameterValue } });
	}

	private _deleteAudioEffect(bus: any, effect: any): void {
		try {
			deleteAudioEffect(this.props.object, { busId: bus.id, effectId: effect.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createAudioReverbZone(): void {
		try {
			let buses = listAudioBuses(this.props.object).buses as any[];
			if (!buses.length) {
				createAudioBus(this.props.object, { name: "Reverb" }, { editor: this.props.editor });
				buses = listAudioBuses(this.props.object).buses as any[];
			}
			let effect = buses.flatMap((bus) => bus.effects ?? []).find((candidate: any) => candidate.type === "convolutionReverb");
			if (!effect) {
				effect = createAudioEffect(this.props.object, { busId: buses[0].id, name: "Zone Reverb", type: "convolutionReverb", wet: 0.5 }, { editor: this.props.editor });
			}
			const zones = listAudioReverbZones(this.props.object).zones as any[];
			const listenerPosition = getAudioMixerRuntime(this.props.object).listenerPosition;
			createAudioReverbZone(
				this.props.object,
				{ name: `Reverb Zone ${zones.length + 1}`, effectId: effect.id, shape: "sphere", position: listenerPosition, innerRadius: 250, outerRadius: 1000 },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioReverbZone(zone: any, changes: Record<string, unknown>): void {
		try {
			setAudioReverbZone(this.props.object, { id: zone.id, ...changes }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioReverbZoneNumber(zone: any, key: string, value: string): void {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue)) {
			return;
		}
		this._setAudioReverbZone(zone, { [key]: numericValue });
	}

	private _setAudioReverbZoneVector(zone: any, key: "position" | "size", index: number, value: string): void {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue)) {
			return;
		}
		const vector = [...zone[key]];
		vector[index] = numericValue;
		this._setAudioReverbZone(zone, { [key]: vector });
	}

	private _deleteAudioReverbZone(zone: any): void {
		try {
			deleteAudioReverbZone(this.props.object, { id: zone.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioMixerProfiler(settings: { enabled?: boolean; sampleCapacity?: number; sampleEveryNUpdates?: number }): void {
		try {
			setAudioMixerProfile(this.props.object, settings, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _clearAudioMixerProfiler(): void {
		try {
			clearAudioMixerProfile(this.props.object, {}, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteAudioBus(id: string): void {
		try {
			deleteAudioBus(this.props.object, { busId: id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioBusMuted(bus: any, muted: boolean): void {
		try {
			setAudioBus(this.props.object, { busId: bus.id, muted }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAudioBusSolo(bus: any, solo: boolean): void {
		try {
			setAudioBus(this.props.object, { busId: bus.id, solo }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createAudioMixerSnapshot(): void {
		try {
			const snapshots = listAudioMixerSnapshots(this.props.object).snapshots as any[];
			createAudioMixerSnapshot(this.props.object, { name: `Snapshot ${snapshots.length + 1}` }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _applyAudioMixerSnapshot(id: string, durationSeconds: number): void {
		try {
			applyAudioMixerSnapshot(this.props.object, { id, durationSeconds }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteAudioMixerSnapshot(id: string): void {
		try {
			deleteAudioMixerSnapshot(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _get2DSceneModeComponent(): ReactNode {
		const mode = get2DSceneMode(this.props.object);
		return (
			<EditorInspectorSectionField title="2D Scene Mode" tooltip="Configures an orthographic camera foundation for sprite, tilemap, sorting-layer, and 2D-physics authoring.">
				<div className="flex justify-between items-center px-2 text-sm">
					<span>{mode.enabled ? "Orthographic 2D camera active" : "Perspective 3D scene"}</span>
					{mode.enabled && <span className="text-muted-foreground">±{mode.orthographicSize} cm</span>}
				</div>
				<Button variant={mode.enabled ? "secondary" : "default"} className="w-full" onClick={() => this._set2DSceneMode(!mode.enabled)}>
					{mode.enabled ? "Disable 2D Mode" : "Enable 2D Mode"}
				</Button>
			</EditorInspectorSectionField>
		);
	}

	private _set2DSceneMode(enabled: boolean): void {
		set2DSceneMode(this.props.object, { enabled }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private async _refreshPlatformDiagnostics(): Promise<void> {
		this.setState({ platformBusy: true });
		try {
			const result = await getPlatformDiagnostics(this.props.object, {}, { editor: this.props.editor });
			this.setState({ platformDiagnostics: result.diagnostics });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to inspect platform toolchains.");
		} finally {
			this.setState({ platformBusy: false });
		}
	}

	private async _restartForInstalledPlatform(target: "web" | "electron" | "headless" | "android" | "ios"): Promise<void> {
		const confirmed = await showConfirm(
			`Restart for ${target} support?`,
			"Zvibe Editor will save every owned scene, quit without another close prompt, relaunch, and reopen this project.",
			{ confirmText: "Save & Restart" }
		);
		if (!confirmed) {
			return;
		}
		this.setState({ platformBusy: true });
		try {
			const status = await getInstalledPlatformRestartStatus(this.props.object, { target }, { editor: this.props.editor });
			const plan = await planInstalledPlatformRestart(
				this.props.object,
				{ target, expectedDiagnosticFingerprint: status.diagnosticFingerprint },
				{ editor: this.props.editor }
			);
			await restartEditorForInstalledPlatform(
				this.props.object,
				{ planId: plan.id, expectedDiagnosticFingerprint: plan.diagnosticFingerprint, confirm: true },
				{ editor: this.props.editor }
			);
			toast.success("Restart scheduled. Zvibe Editor will reopen this project.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to restart Zvibe Editor.");
			this.setState({ platformBusy: false });
		}
	}

	private async _generatePlatformScaffold(target: "headless" | "android" | "ios"): Promise<void> {
		const diagnostic = this.state.platformDiagnostics.find((entry) => entry.descriptor.target === target);
		const scaffold = diagnostic?.scaffold;
		const overwrite = scaffold?.exists && scaffold.integrity === false;
		if (overwrite) {
			const confirmed = await showConfirm(
				`Replace modified ${target} scaffold?`,
				"Generated files no longer match their recorded hashes. Replace only editor-owned generated files while preserving documented user-owned hooks?",
				{ confirmText: "Replace Generated Files" }
			);
			if (!confirmed) {
				return;
			}
		}
		this.setState({ platformBusy: true });
		try {
			const result = await generatePlatformScaffold(
				this.props.object,
				{ target, expectedRevision: scaffold?.revision ?? 0, overwrite, confirm: overwrite },
				{ editor: this.props.editor }
			);
			toast.success(`${result.manifest.target} scaffold ready at revision ${result.revision}.`);
			await this._refreshPlatformDiagnostics();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to generate the platform scaffold.");
		} finally {
			this.setState({ platformBusy: false });
		}
	}

	private async _updatePlatformScaffold(target: "headless" | "android" | "ios", patch: Record<string, unknown>): Promise<void> {
		const diagnostic = this.state.platformDiagnostics.find((entry) => entry.descriptor.target === target);
		const scaffold = diagnostic?.scaffold;
		if (!scaffold?.exists) {
			return;
		}
		this.setState({ platformBusy: true });
		try {
			await generatePlatformScaffold(
				this.props.object,
				{ target, expectedRevision: scaffold.revision, settings: { ...scaffold.manifest.settings, ...patch } },
				{ editor: this.props.editor }
			);
			await this._refreshPlatformDiagnostics();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to update the platform scaffold.");
		} finally {
			this.setState({ platformBusy: false });
		}
	}

	private async _validateIosSwiftProject(expectedRevision: number): Promise<void> {
		this.setState({ platformBusy: true });
		try {
			const result = await validateIosGeneratedProject(this.props.object, { expectedRevision }, { editor: this.props.editor });
			if (result.valid) {
				toast.success("Experimental Swift Xcode project structure and hashes are valid.");
			} else {
				toast.error("Experimental Swift Xcode project validation failed. Regenerate the scaffold before building.");
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to validate the Swift iOS project.");
		} finally {
			this.setState({ platformBusy: false });
		}
	}

	private async _removePlatformScaffold(target: "headless" | "android" | "ios"): Promise<void> {
		const diagnostic = this.state.platformDiagnostics.find((entry) => entry.descriptor.target === target);
		const scaffold = diagnostic?.scaffold;
		if (!scaffold?.exists) {
			return;
		}
		const confirmed = await showConfirm(
			`Remove ${target} scaffold?`,
			"Remove editor-owned generated files and restore replaced package scripts? Documented user-owned server hooks remain in the project.",
			{ confirmText: "Remove Scaffold" }
		);
		if (!confirmed) {
			return;
		}
		this.setState({ platformBusy: true });
		try {
			await removePlatformScaffold(this.props.object, { target, expectedRevision: scaffold.revision, confirm: true }, { editor: this.props.editor });
			toast.success(`${target} scaffold removed.`);
			await this._refreshPlatformDiagnostics();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to remove the platform scaffold.");
		} finally {
			this.setState({ platformBusy: false });
		}
	}

	private _createBuildProfile(target: "web" | "electron" | "headless" | "android" | "ios"): void {
		const configuration = listBuildProfiles(this.props.object);
		const profiles = configuration.profiles;
		const prefix =
			target === "electron"
				? "Electron Build"
				: target === "headless"
					? "Headless Build"
					: target === "android"
						? "Android Build"
						: target === "ios"
							? "iOS Build"
							: "Web Build";
		let suffix = 1;
		while (profiles.some((profile: any) => profile.name === `${prefix} ${suffix}`)) {
			suffix++;
		}
		createBuildProfile(this.props.object, { expectedRevision: configuration.revision, name: `${prefix} ${suffix}`, target });
		this.forceUpdate();
	}

	private _deleteBuildProfile(id: string): void {
		const configuration = listBuildProfiles(this.props.object);
		deleteBuildProfile(this.props.object, { id, expectedRevision: configuration.revision });
		this.forceUpdate();
	}

	private _setBuildProfileSetting(profile: any, key: string, value: any): void {
		const configuration = listBuildProfiles(this.props.object);
		setBuildProfile(this.props.object, { id: profile.id, expectedRevision: configuration.revision, settings: { ...(profile.settings ?? {}), [key]: value } });
		this.forceUpdate();
	}

	private _setWindowsAssetStreamingSetting(profile: any, key: string, value: boolean | number): void {
		try {
			this._setBuildProfileSetting(profile, "assetStreaming", {
				...(profile.settings?.assetStreaming ?? {}),
				windows: { ...(profile.settings?.assetStreaming?.windows ?? {}), [key]: value },
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to update Windows asset streaming settings.");
			this.forceUpdate();
		}
	}

	private _setBuildProfileDefinition(id: string, values: Record<string, unknown>): void {
		const configuration = listBuildProfiles(this.props.object);
		setBuildProfile(this.props.object, { id, expectedRevision: configuration.revision, ...values });
		this.forceUpdate();
	}

	private _setBuildProfileOptions(profile: any, key: string, value: boolean): void {
		this._setBuildProfileDefinition(profile.id, { options: { ...(profile.options ?? {}), [key]: value } });
	}

	private _renameBuildProfile(id: string, name: string): void {
		if (!name.trim()) {
			return;
		}
		const configuration = listBuildProfiles(this.props.object);
		setBuildProfile(this.props.object, { id, expectedRevision: configuration.revision, name });
		this.forceUpdate();
	}

	private _duplicateBuildProfile(id: string): void {
		const configuration = listBuildProfiles(this.props.object);
		const source = configuration.profiles.find((profile) => profile.id === id);
		if (!source) {
			return;
		}
		let suffix = 2;
		let name = `${source.name} Copy`;
		while (configuration.profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
			name = `${source.name} Copy ${suffix++}`;
		}
		duplicateBuildProfile(this.props.object, { id, expectedRevision: configuration.revision, newName: name });
		this.forceUpdate();
	}

	private _setActiveBuildProfile(id: string): void {
		if (!id) {
			return;
		}
		const configuration = listBuildProfiles(this.props.object);
		setActiveBuildProfile(this.props.object, { id, expectedRevision: configuration.revision });
		this.forceUpdate();
	}

	private async _invokeBuildProfileFooterAction(action: IEditorExtensionBuildProfileFooterDescriptor, context: IEditorExtensionBuildProfileActionContext): Promise<void> {
		try {
			await this.props.editor.extensionHost?.invokeBuildProfileFooterAction(action.id, context);
			toast.success(`${action.title} completed.`);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : `Unable to run ${action.title}.`);
		}
	}

	private async _validateBuildProfile(id: string): Promise<void> {
		try {
			const profile = listBuildProfiles(this.props.object).profiles.find((candidate) => candidate.id === id)!;
			const result = await validateBuildProfile(this.props.object, { id }, { editor: this.props.editor });
			if (result.valid) {
				toast.success(`${profile.name} is ready: ${result.commands.join("; ")}.`);
			} else {
				toast.error(`${profile.name}: ${result.reasons.join(" ")}`);
			}
		} catch (error: any) {
			toast.error(`Unable to validate build profile: ${error.message}`);
		}
	}

	private async _inspectWebBuildPlan(id: string): Promise<any | null> {
		this.setState({ webBuildBusyId: id });
		try {
			const configuration = listBuildProfiles(this.props.object);
			const plan = await inspectWebBuildPlan(this.props.object, { id, expectedRevision: configuration.revision }, { editor: this.props.editor });
			this.setState((state) => ({ webBuildEvidence: { ...state.webBuildEvidence, [id]: { plan } } }));
			toast.success(`Web plan ready: ${plan.modules.filter((entry: any) => entry.decision === "strip").length} module(s) eligible for verified stripping.`);
			return plan;
		} catch (error: any) {
			toast.error(`Unable to analyze Web build: ${error.message}`);
			return null;
		} finally {
			this.setState({ webBuildBusyId: null });
		}
	}

	private async _verifyWebBuildOutput(id: string): Promise<void> {
		this.setState({ webBuildBusyId: id });
		try {
			const configuration = listBuildProfiles(this.props.object);
			const plan = await inspectWebBuildPlan(this.props.object, { id, expectedRevision: configuration.revision }, { editor: this.props.editor });
			const verification = await verifyWebBuildOutput(
				this.props.object,
				{ id, expectedRevision: configuration.revision, expectedPlanFingerprint: plan.planFingerprint },
				{ editor: this.props.editor }
			);
			this.setState((state) => ({
				webBuildEvidence: { ...state.webBuildEvidence, [id]: { plan: verification.plan, toolchain: verification.toolchain, output: verification.output } },
			}));
			if (verification.valid) {
				toast.success("Web build output and generated evidence manifest are current.");
			} else {
				toast.error(`Web build evidence failed: ${verification.reasons.join(" ")}`);
			}
		} catch (error: any) {
			toast.error(`Unable to verify Web build output: ${error.message}`);
		} finally {
			this.setState({ webBuildBusyId: null });
		}
	}

	private async _buildBuildProfile(id: string): Promise<void> {
		try {
			const configuration = listBuildProfiles(this.props.object);
			const result = await buildBuildProfile(this.props.object, { id, expectedRevision: configuration.revision }, { editor: this.props.editor });
			if (result.webBuildEvidence?.plan) {
				this.setState((state) => ({
					webBuildEvidence: {
						...state.webBuildEvidence,
						[id]: { plan: result.webBuildEvidence.plan, toolchain: result.webBuildEvidence.toolchain, output: result.webBuildEvidence.output },
					},
				}));
			}
			toast.success(result.cacheHit ? "Verified incremental build cache hit." : `Built ${result.output.fileCount} artifact(s).`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(`Build failed: ${error.message}`);
			this.forceUpdate();
		}
	}

	private async _buildAndRunBuildProfile(id: string): Promise<void> {
		try {
			const configuration = listBuildProfiles(this.props.object);
			const result = await buildAndRunBuildProfile(this.props.object, { id, expectedRevision: configuration.revision }, { editor: this.props.editor });
			toast.success(`Build run started: ${result.run.id}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(`Build & Run failed: ${error.message}`);
			this.forceUpdate();
		}
	}

	private async _cleanBuildProfile(id: string): Promise<void> {
		try {
			const configuration = listBuildProfiles(this.props.object);
			const result = await cleanBuildProfileOutput(this.props.object, { id, expectedRevision: configuration.revision, confirm: true }, { editor: this.props.editor });
			toast.success(`Removed ${result.removedFileCount} artifact(s) from ${result.outputDirectory}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(`Unable to clean build output: ${error.message}`);
		}
	}

	private async _stopBuildProfileRun(runId: string): Promise<void> {
		try {
			await stopBuildProfileRun(this.props.object, { runId, confirm: true });
			toast.success("Build run stopped.");
			this.forceUpdate();
		} catch (error: any) {
			toast.error(`Unable to stop build run: ${error.message}`);
		}
	}

	private _deleteBuildReport(id: string): void {
		try {
			deleteBuildReport(this.props.object, { id, confirm: true });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(`Unable to delete build report: ${error.message}`);
		}
	}

	private async _generatePwaManifest(id: string): Promise<void> {
		try {
			const configuration = listBuildProfiles(this.props.object);
			const result = await generatePwaManifest(this.props.object, { id, expectedRevision: configuration.revision }, { editor: this.props.editor });
			toast.success(`Generated ${result.path}.`);
		} catch (error: any) {
			toast.error(`Unable to generate PWA manifest: ${error.message}`);
		}
	}

	private async _generatePwaServiceWorker(id: string): Promise<void> {
		try {
			const configuration = listBuildProfiles(this.props.object);
			const result = await generatePwaServiceWorker(this.props.object, { id, expectedRevision: configuration.revision }, { editor: this.props.editor });
			toast.success(`Generated ${result.path}. Register it in your web app entry point.`);
		} catch (error: any) {
			toast.error(`Unable to generate PWA service worker: ${error.message}`);
		}
	}

	private async _installPwaServiceWorkerRegistration(id: string): Promise<void> {
		try {
			const configuration = listBuildProfiles(this.props.object);
			const result = await installPwaServiceWorkerRegistration(this.props.object, { id, expectedRevision: configuration.revision }, { editor: this.props.editor });
			toast.success(result.changed ? "Installed PWA service-worker registration in index.html." : "PWA service-worker registration is already current.");
		} catch (error: any) {
			toast.error(`Unable to install PWA registration: ${error.message}`);
		}
	}

	private _validatePhysics(): void {
		const result = validatePhysicsScene(this.props.object);
		if (result.valid) {
			toast.success(`Physics scene valid${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : ""}.`);
		} else {
			toast.error(result.errors.join("\n"));
		}
	}

	private _inspectPhysicsSimulation(): void {
		const result = getPhysicsSimulationState(this.props.object);
		toast.info(
			`Physics snapshot: ${result.bodies.length} bodies, ${result.constraints.length} constraints${result.validation.warnings.length ? `, ${result.validation.warnings.length} warnings` : ""}.`
		);
	}

	private _setHybridPhysicsSolver(update: Record<string, unknown>): void {
		try {
			const current = getHybridPhysicsSolver(this.props.object).configuration;
			setHybridPhysicsSolver(this.props.object, { expectedRevision: current.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update the hybrid physics solver.");
		}
	}

	private _setHybridPhysicsNumber(property: "positionErrorBias" | "maximumRows", source: string): void {
		const value = Number(source);
		if (Number.isFinite(value) && (property !== "maximumRows" || Number.isInteger(value))) {
			this._setHybridPhysicsSolver({ [property]: value });
		}
	}

	private async _createChainGearsPhysicsSample(): Promise<void> {
		try {
			const current = getHybridPhysicsSolver(this.props.object).configuration;
			const result = await createChainGearsPhysicsSample(this.props.object, { expectedRevision: current.revision }, { editor: this.props.editor });
			toast.success(`Created ${result.mechanism.linkCount}-link Chain & Gears sample.`);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create the Chain & Gears sample.");
		}
	}

	private async _deleteChainGearsPhysicsSample(sample: any): Promise<void> {
		try {
			const current = getHybridPhysicsSolver(this.props.object).configuration;
			await deleteChainGearsPhysicsSample(
				this.props.object,
				{ id: sample.id, expectedRevision: sample.revision, expectedConfigurationRevision: current.revision, confirm: true },
				{ editor: this.props.editor }
			);
			toast.success(`Removed ${sample.name}.`);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not remove the Chain & Gears sample.");
		}
	}

	private _solveHybridPhysicsNow(): void {
		try {
			const current = getHybridPhysicsSolver(this.props.object).configuration;
			const result = solveHybridPhysicsNow(this.props.object, { expectedRevision: current.revision }, { editor: this.props.editor });
			toast.info(`Solved ${result.runtime.rowCount} direct rows; residual ${result.runtime.maximumResidualAfter.toFixed(4)}.`);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not solve direct physics rows.");
		}
	}

	private _startPhysicsContactCapture(): void {
		try {
			startPhysicsContactCapture(this.props.object, { maxEvents: 256 }, { editor: this.props.editor });
			this.setState({ physicsContactCapture: getPhysicsContactCapture(this.props.object) });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not start physics contact capture.");
		}
	}

	private _setPhysicsSimulationPaused(paused: boolean): void {
		try {
			setPhysicsSimulationPaused(this.props.object, { paused }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not change physics simulation pause state.");
		}
	}

	private _stepPhysicsSimulation(steps: number): void {
		try {
			stepPhysicsSimulation(this.props.object, { steps, deltaSeconds: 1 / 60 }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not step physics simulation.");
		}
	}

	private _clearPhysicsContactCapture(): void {
		try {
			clearPhysicsContactCapture(this.props.object);
			this.setState({ physicsContactCapture: getPhysicsContactCapture(this.props.object) });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not clear physics contact capture.");
		}
	}

	private _setPhysicsContactVisualization(enabled: boolean): void {
		try {
			setPhysicsContactVisualization(this.props.object, { enabled }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not configure physics contact visualization.");
		}
	}

	private _setPhysicsForceVisualization(update: Record<string, unknown>): void {
		try {
			const current = getPhysicsForceVisualization(this.props.object, {}, { editor: this.props.editor });
			setPhysicsForceVisualization(this.props.object, { expectedRevision: current.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			this.forceUpdate();
			toast.error(error instanceof Error ? error.message : "Could not configure physics force visualization.");
		}
	}

	private _togglePhysicsForceVisualizationCategory(category: PhysicsForceVectorCategory): void {
		const current = getPhysicsForceVisualization(this.props.object, {}, { editor: this.props.editor });
		const selected = current.settings.categories as PhysicsForceVectorCategory[];
		const categories = selected.includes(category) ? selected.filter((value) => value !== category) : [...selected, category];
		if (!categories.length) {
			toast.error("Keep at least one physics force-vector category enabled.");
			return;
		}
		this._setPhysicsForceVisualization({ categories });
	}

	private _setPhysicsForceVisualizationBodyNodeIds(value: string): void {
		const bodyNodeIds = value
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
		this._setPhysicsForceVisualization({ bodyNodeIds });
	}

	private _setPhysicsForceVisualizationNumber(
		property:
			| "maximumVectors"
			| "refreshIntervalMs"
			| "forceScale"
			| "impulseScale"
			| "velocityScale"
			| "angularVelocityScale"
			| "directionScale"
			| "separationScale"
			| "pointSize",
		value: string
	): void {
		const number = Number(value);
		if (!value.trim() || !Number.isFinite(number)) {
			this.forceUpdate();
			toast.error(`${property} must be a finite number.`);
			return;
		}
		this._setPhysicsForceVisualization({ [property]: number });
	}

	private _stopPhysicsContactCapture(): void {
		try {
			const result = stopPhysicsContactCapture(this.props.object, {}, { editor: this.props.editor });
			this.setState({ physicsContactCapture: result });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not stop physics contact capture.");
		}
	}

	private _physicsContactHistoryFilterNumber(value: string, label: string): number | undefined {
		if (!value.trim()) {
			return undefined;
		}
		const result = Number(value);
		if (!Number.isFinite(result)) {
			throw new Error(`${label} must be a finite number.`);
		}
		return result;
	}

	private _getPhysicsContactHistoryFilter(): any {
		return {
			types: [...this.state.physicsContactHistoryEventTypes],
			bodyNodeIds: [
				...new Set(
					this.state.physicsContactHistoryBodyNodeIds
						.split(/[\s,]+/)
						.map((value) => value.trim())
						.filter(Boolean)
				),
			],
			fromMs: this._physicsContactHistoryFilterNumber(this.state.physicsContactHistoryFromMs, "From time"),
			toMs: this._physicsContactHistoryFilterNumber(this.state.physicsContactHistoryToMs, "To time"),
			minimumImpulse: this._physicsContactHistoryFilterNumber(this.state.physicsContactHistoryMinimumImpulse, "Minimum impulse"),
			maximumImpulse: this._physicsContactHistoryFilterNumber(this.state.physicsContactHistoryMaximumImpulse, "Maximum impulse"),
		};
	}

	private _togglePhysicsContactHistoryType(type: PhysicsContactEventType): void {
		this.setState((state) => ({
			physicsContactHistoryEventTypes: state.physicsContactHistoryEventTypes.includes(type)
				? state.physicsContactHistoryEventTypes.filter((value) => value !== type)
				: [...state.physicsContactHistoryEventTypes, type],
		}));
	}

	private async _refreshPhysicsContactHistories(preferredPath?: string): Promise<void> {
		this.setState({ physicsContactHistoryBusy: true, physicsContactHistoryError: null });
		try {
			const result = await listPhysicsContactHistories(this.props.object, { limit: 100 });
			const histories = result.assets as any[];
			const requestedPath = preferredPath ?? this.state.physicsContactHistorySelectedPath;
			const selectedPath = histories.some((history) => history.path === requestedPath) ? requestedPath : (histories[0]?.path ?? "");
			let detail: any | null = null;
			let error: string | null = null;
			if (selectedPath) {
				try {
					detail = await getPhysicsContactHistory(this.props.object, { path: selectedPath, filter: this._getPhysicsContactHistoryFilter(), limit: 1000 });
				} catch (detailError) {
					error = detailError instanceof Error ? detailError.message : "Could not read the selected physics contact history.";
				}
			}
			const selected = histories.find((history) => history.path === selectedPath);
			const syncAuthoringInputs = Boolean(preferredPath) || Boolean(requestedPath && requestedPath !== selectedPath);
			this.setState({
				physicsContactHistories: histories,
				physicsContactHistorySelectedPath: selectedPath,
				physicsContactHistoryDetail: detail,
				physicsContactHistoryPath: syncAuthoringInputs && selected ? selected.path : this.state.physicsContactHistoryPath,
				physicsContactHistoryName: syncAuthoringInputs && selected ? selected.name : this.state.physicsContactHistoryName,
				physicsContactHistoryError: error ?? (result.malformedCount ? `${result.malformedCount} malformed contact history asset(s) were excluded.` : null),
				physicsContactHistoryBusy: false,
			});
		} catch (error) {
			this.setState({
				physicsContactHistoryError: error instanceof Error ? error.message : "Could not list physics contact histories.",
				physicsContactHistoryBusy: false,
			});
		}
	}

	private _selectPhysicsContactHistory(path: string): void {
		const selected = this.state.physicsContactHistories.find((history) => history.path === path);
		this.setState(
			{
				physicsContactHistorySelectedPath: path,
				physicsContactHistoryPath: selected?.path ?? this.state.physicsContactHistoryPath,
				physicsContactHistoryName: selected?.name ?? this.state.physicsContactHistoryName,
			},
			() => void this._loadPhysicsContactHistory(path)
		);
	}

	private async _loadPhysicsContactHistory(path = this.state.physicsContactHistorySelectedPath): Promise<void> {
		if (!path) {
			return;
		}
		this.setState({ physicsContactHistoryBusy: true, physicsContactHistoryError: null });
		try {
			const detail = await getPhysicsContactHistory(this.props.object, { path, filter: this._getPhysicsContactHistoryFilter(), limit: 1000 });
			this.setState({ physicsContactHistoryDetail: detail, physicsContactHistoryBusy: false });
		} catch (error) {
			this.setState({
				physicsContactHistoryDetail: null,
				physicsContactHistoryError: error instanceof Error ? error.message : "Could not read the selected physics contact history.",
				physicsContactHistoryBusy: false,
			});
		}
	}

	private async _savePhysicsContactHistory(): Promise<void> {
		this.setState({ physicsContactHistoryBusy: true, physicsContactHistoryError: null });
		try {
			const existing = this.state.physicsContactHistories.find((history) => history.path === this.state.physicsContactHistoryPath.trim());
			const saved = await savePhysicsContactHistory(
				this.props.object,
				{
					path: this.state.physicsContactHistoryPath.trim(),
					name: this.state.physicsContactHistoryName.trim(),
					...(existing ? { expectedRevision: existing.contentRevision } : {}),
				},
				{ editor: this.props.editor }
			);
			toast.success(`${saved.created ? "Saved" : "Updated"} ${saved.path} with ${saved.summary.eventCount} contact events.`);
			await this._refreshPhysicsContactHistories(saved.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not save the physics contact history.";
			this.setState({ physicsContactHistoryError: message, physicsContactHistoryBusy: false });
			toast.error(message);
		}
	}

	private async _deletePhysicsContactHistory(): Promise<void> {
		const selected = this.state.physicsContactHistories.find((history) => history.path === this.state.physicsContactHistorySelectedPath);
		if (!selected) {
			return;
		}
		if (
			!(await showConfirm("Delete Physics Contact History?", `Permanently delete ${selected.path}? An active replay using this revision will stop.`, {
				confirmText: "Delete",
			}))
		) {
			return;
		}
		this.setState({ physicsContactHistoryBusy: true, physicsContactHistoryError: null });
		try {
			const result = await deletePhysicsContactHistory(
				this.props.object,
				{ path: selected.path, expectedRevision: selected.contentRevision, confirm: true },
				{ editor: this.props.editor }
			);
			toast.success(`Deleted ${result.path}${result.replayStopped ? " and stopped its replay" : ""}.`);
			await this._refreshPhysicsContactHistories();
			this.forceUpdate();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not delete the physics contact history.";
			this.setState({ physicsContactHistoryError: message, physicsContactHistoryBusy: false });
			toast.error(message);
		}
	}

	private async _startPhysicsContactHistoryReplay(): Promise<void> {
		const selected = this.state.physicsContactHistories.find((history) => history.path === this.state.physicsContactHistorySelectedPath);
		if (!selected) {
			return;
		}
		try {
			await startPhysicsContactHistoryReplay(
				this.props.object,
				{
					path: selected.path,
					expectedRevision: selected.contentRevision,
					filter: this._getPhysicsContactHistoryFilter(),
					playbackRate: this.state.physicsContactReplayRate,
					trailMs: this.state.physicsContactReplayTrailMs,
					loop: this.state.physicsContactReplayLoop,
					normalScale: this.state.physicsContactReplayNormalScale,
					pointSize: this.state.physicsContactReplayPointSize,
				},
				{ editor: this.props.editor }
			);
			this.setState({ physicsContactHistoryError: null });
			this.forceUpdate();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not start physics contact history replay.";
			this.setState({ physicsContactHistoryError: message });
			toast.error(message);
		}
	}

	private _controlPhysicsContactHistoryReplay(command: "play" | "pause" | "seek" | "step" | "stop", data: Record<string, unknown> = {}): void {
		try {
			const replay = getPhysicsContactHistoryReplay(this.props.object, {}, { editor: this.props.editor });
			controlPhysicsContactHistoryReplay(
				this.props.object,
				{ command, sessionId: replay.sessionId, expectedSessionRevision: replay.sessionRevision, ...data },
				{ editor: this.props.editor }
			);
			this.setState({ physicsContactHistoryError: null });
			this.forceUpdate();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not control physics contact history replay.";
			this.setState({ physicsContactHistoryError: message });
			toast.error(message);
		}
	}

	private _configurePhysicsContactHistoryReplay(settings: Record<string, unknown>): void {
		try {
			const replay = getPhysicsContactHistoryReplay(this.props.object, {}, { editor: this.props.editor });
			controlPhysicsContactHistoryReplay(
				this.props.object,
				{ command: "configure", sessionId: replay.sessionId, expectedSessionRevision: replay.sessionRevision, ...settings },
				{ editor: this.props.editor }
			);
			this.setState({ physicsContactHistoryError: null });
			this.forceUpdate();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Could not configure physics contact history replay.";
			this.setState({ physicsContactHistoryError: message });
			toast.error(message);
		}
	}

	private async _refreshGUIAccessibilityAuthoring(preferredGuiId?: string): Promise<void> {
		try {
			const guis = listGUIs(this.props.object).guis as any[];
			const guiId = preferredGuiId || this.state.guiAccessibilityGuiId || guis[0]?.id || "";
			const authoring = guiId ? getGUIAuthoring(this.props.object, { guiId, offset: 0, limit: 200 }) : null;
			const controlId = authoring?.controls?.items?.some((control: any) => control.id === this.state.guiAccessibilityControlId)
				? this.state.guiAccessibilityControlId
				: (authoring?.controls?.items?.[0]?.id ?? "");
			const semantic = authoring?.authoring?.accessibility?.nodes?.find((node: any) => node.controlId === controlId);
			const localization = authoring?.authoring?.localizations?.find((binding: any) => binding.controlId === controlId);
			this.setState({
				guiAccessibilityGuis: guis,
				guiAccessibilityGuiId: guiId,
				guiAccessibilityAuthoring: authoring,
				guiAccessibilityControlId: controlId,
				guiAccessibilityRole: semantic?.role ?? "button",
				guiAccessibilityLabel: semantic?.label ?? "",
				guiAccessibilityFocusOrder: semantic?.focusOrder ?? 0,
				guiLocalizationProperty: localization?.property ?? "text",
				guiLocalizationTable: localization?.table ?? "",
				guiLocalizationKey: localization?.key ?? "",
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not inspect GUI accessibility authoring.");
		}
	}

	private _selectGUIAccessibilityControl(controlId: string): void {
		const semantic = this.state.guiAccessibilityAuthoring?.authoring?.accessibility?.nodes?.find((node: any) => node.controlId === controlId);
		const localization = this.state.guiAccessibilityAuthoring?.authoring?.localizations?.find((binding: any) => binding.controlId === controlId);
		this.setState({
			guiAccessibilityControlId: controlId,
			guiAccessibilityRole: semantic?.role ?? "button",
			guiAccessibilityLabel: semantic?.label ?? "",
			guiAccessibilityFocusOrder: semantic?.focusOrder ?? 0,
			guiLocalizationProperty: localization?.property ?? "text",
			guiLocalizationTable: localization?.table ?? "",
			guiLocalizationKey: localization?.key ?? "",
		});
	}

	private async _saveGUILocalizationBinding(): Promise<void> {
		const authoring = this.state.guiAccessibilityAuthoring;
		if (!authoring || !this.state.guiAccessibilityControlId) {
			return;
		}
		try {
			await setGUILocalizationBinding(
				this.props.object,
				{
					guiId: this.state.guiAccessibilityGuiId,
					expectedRevision: authoring.authoring.revision,
					binding: {
						controlId: this.state.guiAccessibilityControlId,
						property: this.state.guiLocalizationProperty,
						table: this.state.guiLocalizationTable,
						key: this.state.guiLocalizationKey.trim(),
						localeOverride: null,
						arguments: {},
						isolateBidirectionalText: true,
						mirrorHorizontalAlignment: true,
					},
				},
				{ editor: this.props.editor }
			);
			await this._refreshGUIAccessibilityAuthoring(this.state.guiAccessibilityGuiId);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not save GUI localization binding.");
		}
	}

	private async _deleteGUILocalizationBinding(): Promise<void> {
		const authoring = this.state.guiAccessibilityAuthoring;
		if (!authoring || !this.state.guiAccessibilityControlId) {
			return;
		}
		const binding = authoring.authoring.localizations.find(
			(candidate: any) => candidate.controlId === this.state.guiAccessibilityControlId && candidate.property === this.state.guiLocalizationProperty
		);
		if (!binding) {
			toast.error("The selected control does not have this localization binding.");
			return;
		}
		try {
			await deleteGUILocalizationBinding(
				this.props.object,
				{
					guiId: this.state.guiAccessibilityGuiId,
					expectedRevision: authoring.authoring.revision,
					controlId: this.state.guiAccessibilityControlId,
					property: this.state.guiLocalizationProperty,
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			await this._refreshGUIAccessibilityAuthoring(this.state.guiAccessibilityGuiId);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not remove GUI localization binding.");
		}
	}

	private async _setGUIAccessibilityEnabled(enabled: boolean): Promise<void> {
		await this._setGUIAccessibilityPreferences({ enabled });
	}

	private async _setGUIAccessibilityPreferences(settings: Record<string, unknown>): Promise<void> {
		const authoring = this.state.guiAccessibilityAuthoring;
		if (!authoring) {
			return;
		}
		try {
			await setGUIAccessibilitySettings(
				this.props.object,
				{ guiId: this.state.guiAccessibilityGuiId, expectedRevision: authoring.authoring.revision, settings },
				{ editor: this.props.editor }
			);
			await this._refreshGUIAccessibilityAuthoring(this.state.guiAccessibilityGuiId);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update GUI accessibility settings.");
		}
	}

	private async _saveGUIAccessibilityNode(): Promise<void> {
		const authoring = this.state.guiAccessibilityAuthoring;
		const controlId = this.state.guiAccessibilityControlId;
		if (!authoring || !controlId) {
			return;
		}
		const role = this.state.guiAccessibilityRole;
		const actions = role === "slider" ? ["increment", "decrement"] : ["button", "link", "tab", "toggle"].includes(role) ? ["activate"] : [];
		try {
			await setGUIAccessibilityNode(
				this.props.object,
				{
					guiId: this.state.guiAccessibilityGuiId,
					expectedRevision: authoring.authoring.revision,
					node: {
						controlId,
						role,
						label: this.state.guiAccessibilityLabel.trim(),
						hint: "",
						value: "",
						focusOrder: this.state.guiAccessibilityFocusOrder,
						allowsDirectInteraction: false,
						actions,
						live: "off",
					},
				},
				{ editor: this.props.editor }
			);
			await this._refreshGUIAccessibilityAuthoring(this.state.guiAccessibilityGuiId);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not save GUI accessibility node.");
		}
	}

	private async _deleteGUIAccessibilityNode(): Promise<void> {
		const authoring = this.state.guiAccessibilityAuthoring;
		if (!authoring || !this.state.guiAccessibilityControlId) {
			return;
		}
		try {
			await deleteGUIAccessibilityNode(
				this.props.object,
				{ guiId: this.state.guiAccessibilityGuiId, expectedRevision: authoring.authoring.revision, controlId: this.state.guiAccessibilityControlId, confirm: true },
				{ editor: this.props.editor }
			);
			await this._refreshGUIAccessibilityAuthoring(this.state.guiAccessibilityGuiId);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not remove GUI accessibility node.");
		}
	}

	private async _validateGUIAccessibility(): Promise<void> {
		try {
			const result = await validateGUIAccessibility(this.props.object, {});
			this.setState({ guiAccessibilityValidation: result });
			if (result.errorCount || result.warningCount) {
				toast.warning(
					`GUI accessibility audit found ${result.errorCount} error${result.errorCount === 1 ? "" : "s"} and ${result.warningCount} warning${result.warningCount === 1 ? "" : "s"}.`
				);
			} else {
				toast.success("GUI accessibility audit found no issues.");
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not audit GUI accessibility.");
		}
	}

	private async _upsertLocalizationLocale(): Promise<void> {
		try {
			await upsertLocalizationLocale(
				this.props.object,
				{
					...this._localizationLease(),
					locale: {
						id: this.state.localizationLocale.trim(),
						name: this.state.localizationLocaleName.trim(),
						direction: this.state.localizationDirection,
						fallbackLocales: this.state.localizationLocaleFallbacks.split(/[\s,]+/).filter(Boolean),
						pseudo: this.state.localizationPseudoEnabled
							? { enabled: true, expansionPercent: 30, accent: true, wrap: true, mirror: this.state.localizationDirection === "rtl" }
							: null,
					},
				},
				{ editor: this.props.editor }
			);
			await this._refreshLocalizationTables();
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not save localization locale." });
		}
	}

	private async _deleteLocalizationLocale(locale: string): Promise<void> {
		try {
			await deleteLocalizationLocale(this.props.object, { ...this._localizationLease(), locale, confirm: true }, { editor: this.props.editor });
			await this._refreshLocalizationTables();
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not delete localization locale." });
		}
	}

	private async _setLocalizationDefaultLocale(defaultLocale: string): Promise<void> {
		try {
			await setLocalizationSettings(this.props.object, { ...this._localizationLease(), defaultLocale }, { editor: this.props.editor });
			await this._refreshLocalizationTables();
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not set the default locale." });
		}
	}

	private async _toggleLocalizationTablePreload(name: string, preload: boolean): Promise<void> {
		try {
			await setLocalizationTableSettings(this.props.object, { ...this._localizationLease(), name, preload }, { editor: this.props.editor });
			await this._refreshLocalizationTables();
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not update localization table settings." });
		}
	}

	private async _createLocalizedAssetTable(): Promise<void> {
		try {
			const created = await createLocalizedAssetTable(
				this.props.object,
				{ ...this._localizationLease(), name: this.state.localizationAssetTableName.trim(), fallbackLocale: this.state.localizationFallbackLocale.trim(), preload: true },
				{ editor: this.props.editor }
			);
			await this._refreshLocalizationTables();
			this.setState({ localizationSelectedAssetTable: created.table.name });
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not create localized asset table." });
		}
	}

	private async _setLocalizedAssetEntry(name: string): Promise<void> {
		try {
			await setLocalizedAssetEntry(
				this.props.object,
				{
					...this._localizationLease(),
					name,
					key: this.state.localizationAssetKey.trim(),
					locale: this.state.localizationLocale.trim(),
					asset: { path: this.state.localizationAssetPath.trim(), type: this.state.localizationAssetType },
				},
				{ editor: this.props.editor }
			);
			await this._refreshLocalizationTables();
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not save localized asset." });
		}
	}

	private async _deleteLocalizedAssetEntry(name: string, key: string, locale: string): Promise<void> {
		try {
			await deleteLocalizedAssetEntry(this.props.object, { ...this._localizationLease(), name, key, locale, confirm: true }, { editor: this.props.editor });
			await this._refreshLocalizationTables();
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not delete localized asset." });
		}
	}

	private async _deleteLocalizedAssetTable(name: string): Promise<void> {
		try {
			await deleteLocalizedAssetTable(this.props.object, { ...this._localizationLease(), name, confirm: true }, { editor: this.props.editor });
			await this._refreshLocalizationTables();
			this.setState({ localizationSelectedAssetTable: "" });
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not delete localized asset table." });
		}
	}

	private _localizationLease(): { expectedRevision?: number; expectedFingerprint?: string } {
		return this.state.localizationData ? { expectedRevision: this.state.localizationData.revision, expectedFingerprint: this.state.localizationData.fingerprint } : {};
	}

	private _createPhysics2DMaterial(): void {
		const materials = listPhysics2DMaterials(this.props.object).materials;
		let index = materials.length + 1;
		while (materials.some((material: any) => material.name === `2D Material ${index}`)) {
			index++;
		}
		createPhysics2DMaterial(this.props.object, { name: `2D Material ${index}` }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setPhysics2DMaterial(material: any, update: any): void {
		try {
			setPhysics2DMaterial(this.props.object, { id: material.id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setPhysics2DMaterialNumber(material: any, property: "friction" | "restitution", value: string): void {
		const number = Number(value);
		if (Number.isFinite(number)) {
			this._setPhysics2DMaterial(material, { [property]: number });
		}
	}

	private _deletePhysics2DMaterial(id: string): void {
		try {
			deletePhysics2DMaterial(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getRenderingLayersAndRendererListsComponent(): ReactNode {
		const layerState = listRenderingLayers(this.props.object);
		const rendererListState = listRendererLists(this.props.object, { limit: 64 });
		const cameras = this.props.object.cameras;
		return (
			<EditorInspectorSectionField
				title="Rendering Layers / Renderer Lists"
				tooltip="Named native layer masks for camera/light filtering plus reusable Render Graph-style draw-list descriptors and Babylon rendering-group sorting."
			>
				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
					<div className="text-xs font-semibold">Named Rendering Layers (32-bit)</div>
					<div className="grid grid-cols-[1fr_70px_auto] gap-1">
						<Input value={this.state.renderingLayerName} onChange={(event) => this.setState({ renderingLayerName: event.currentTarget.value })} />
						<input
							type="number"
							min={0}
							max={31}
							value={this.state.renderingLayerBit}
							onChange={(event) => this.setState({ renderingLayerBit: Number(event.currentTarget.value) })}
							className="h-9 rounded-md border border-input bg-background px-2"
						/>
						<Button size="sm" variant="secondary" onClick={() => this._createRenderingLayer()} disabled={!this.state.renderingLayerName.trim()}>
							Add
						</Button>
					</div>
					{layerState.layers.map((layer: any) => (
						<div key={`${layer.id}-${layer.revision}`} className="grid grid-cols-[1fr_70px_auto] items-center gap-1">
							<Input
								defaultValue={layer.name}
								onBlur={(event) => event.currentTarget.value !== layer.name && this._setRenderingLayer(layer, { name: event.currentTarget.value })}
							/>
							<input
								type="number"
								min={0}
								max={31}
								defaultValue={layer.bit}
								onBlur={(event) =>
									Number(event.currentTarget.value) !== layer.bit &&
									this._setRenderingLayer(layer, { bit: Number(event.currentTarget.value), migrateAssignments: true })
								}
								className="h-9 rounded-md border border-input bg-background px-2"
							/>
							<Button size="sm" variant="ghost" onClick={() => void this._deleteRenderingLayer(layer)}>
								Delete
							</Button>
						</div>
					))}
					{!layerState.layers.length && <div className="text-xs text-muted-foreground">No named layers. Native masks remain available numerically.</div>}
				</div>

				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
					<div className="text-xs font-semibold">Native Rendering Groups</div>
					{layerState.groups.map((group: any) => (
						<div key={`${group.groupId}-${group.revision}`} className="space-y-1 rounded bg-background/60 p-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<Input
									defaultValue={group.name}
									onBlur={(event) => event.currentTarget.value !== group.name && this._setRenderingGroup(group, { name: event.currentTarget.value })}
								/>
								<span>#{group.groupId}</span>
								<Button size="sm" variant="ghost" disabled={!group.authored} onClick={() => void this._resetRenderingGroup(group)}>
									Reset
								</Button>
							</div>
							<div className="grid grid-cols-3 gap-1">
								{(["opaqueSort", "alphaTestSort", "transparentSort"] as const).map((field) => (
									<select
										key={field}
										value={group[field]}
										onChange={(event) => this._setRenderingGroup(group, { [field]: event.currentTarget.value })}
										className="h-7 rounded-md border border-input bg-background px-1"
									>
										<option value="none">None</option>
										<option value="frontToBack">Front→Back</option>
										<option value="backToFront">Back→Front</option>
										<option value="material">Material</option>
										<option value="defaultTransparent">Alpha index + back</option>
									</select>
								))}
							</div>
							<div className="flex flex-wrap gap-3">
								<label>
									<input
										type="checkbox"
										checked={group.autoClearDepthStencil}
										onChange={(event) => this._setRenderingGroup(group, { autoClearDepthStencil: event.currentTarget.checked })}
									/>{" "}
									Clear between groups
								</label>
								<label>
									<input
										type="checkbox"
										checked={group.clearDepth}
										onChange={(event) => this._setRenderingGroup(group, { clearDepth: event.currentTarget.checked })}
									/>{" "}
									Depth
								</label>
								<label>
									<input
										type="checkbox"
										checked={group.clearStencil}
										onChange={(event) => this._setRenderingGroup(group, { clearStencil: event.currentTarget.checked })}
									/>{" "}
									Stencil
								</label>
							</div>
						</div>
					))}
				</div>

				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
					<div className="text-xs font-semibold">Reusable Renderer Lists</div>
					<div className="flex gap-1">
						<Input value={this.state.rendererListName} onChange={(event) => this.setState({ rendererListName: event.currentTarget.value })} />
						<Button size="sm" variant="secondary" onClick={() => this._createRendererList()} disabled={!this.state.rendererListName.trim()}>
							Create
						</Button>
					</div>
					{rendererListState.lists.map((list: any) => (
						<div key={`${list.id}-${list.revision}`} className="space-y-2 rounded bg-background/60 p-2 text-xs">
							<div className="flex items-center gap-2">
								<input type="checkbox" checked={list.enabled} onChange={(event) => this._setRendererList(list, { enabled: event.currentTarget.checked })} />
								<Input
									defaultValue={list.name}
									onBlur={(event) => event.currentTarget.value !== list.name && this._setRendererList(list, { name: event.currentTarget.value })}
								/>
								<Button size="sm" variant="ghost" onClick={() => void this._deleteRendererList(list)}>
									Delete
								</Button>
							</div>
							<div className={list.valid ? "text-success" : "text-destructive"}>
								revision {list.revision} ·{" "}
								{list.valid
									? `${list.resolvedMeshCount} resolved · O ${list.queueCounts?.opaque} / A ${list.queueCounts?.alphaTest} / T ${list.queueCounts?.transparent}`
									: list.error}
							</div>
							<select
								value={list.cameraId ?? ""}
								onChange={(event) => this._setRendererList(list, { cameraId: event.currentTarget.value || null })}
								className="h-8 w-full rounded-md border border-input bg-background px-2"
							>
								<option value="">Active graph camera</option>
								{cameras.map((camera) => (
									<option key={camera.id} value={camera.id}>
										{camera.name}
									</option>
								))}
							</select>
							<div className="grid grid-cols-2 gap-1">
								<input
									type="number"
									min={0}
									max={4294967295}
									defaultValue={list.includeLayerMask ?? ""}
									placeholder="Include mask (empty = all)"
									onBlur={(event) => this._setRendererList(list, { includeLayerMask: event.currentTarget.value ? Number(event.currentTarget.value) : null })}
									className="h-8 rounded-md border border-input bg-background px-2"
								/>
								<input
									type="number"
									min={0}
									max={4294967295}
									defaultValue={list.excludeLayerMask}
									placeholder="Exclude mask"
									onBlur={(event) => this._setRendererList(list, { excludeLayerMask: Number(event.currentTarget.value) })}
									className="h-8 rounded-md border border-input bg-background px-2"
								/>
							</div>
							<div className="grid grid-cols-2 gap-1">
								<select
									value={list.queue}
									onChange={(event) => this._setRendererList(list, { queue: event.currentTarget.value })}
									className="h-8 rounded-md border border-input bg-background px-2"
								>
									<option value="all">All queues</option>
									<option value="opaque">Opaque</option>
									<option value="alphaTest">Alpha test</option>
									<option value="transparent">Transparent</option>
								</select>
								<select
									value={list.sortMode}
									onChange={(event) => this._setRendererList(list, { sortMode: event.currentTarget.value })}
									className="h-8 rounded-md border border-input bg-background px-2"
								>
									<option value="none">Creation order</option>
									<option value="frontToBack">Front→Back</option>
									<option value="backToFront">Back→Front</option>
									<option value="material">Material</option>
									<option value="defaultTransparent">Alpha + back</option>
								</select>
							</div>
							<Input
								defaultValue={list.renderingGroupIds.join(",")}
								placeholder="Rendering groups, e.g. 0,2"
								onBlur={(event) =>
									this._setRendererList(list, {
										renderingGroupIds: event.currentTarget.value
											.split(",")
											.map((value) => value.trim())
											.filter(Boolean)
											.map(Number),
									})
								}
							/>
							<Textarea
								defaultValue={list.meshIds.join("\n")}
								placeholder="Optional root mesh ids, one per line"
								onBlur={(event) => this._setRendererList(list, { meshIds: event.currentTarget.value.split(/\s+/).filter(Boolean) })}
							/>
							<div className="flex flex-wrap gap-3">
								{(
									[
										["includeDescendants", "Descendants"],
										["respectCameraLayerMask", "Camera mask"],
										["includeDisabled", "Disabled"],
										["includeInvisible", "Invisible"],
									] as const
								).map(([field, label]) => (
									<label key={field}>
										<input type="checkbox" checked={list[field]} onChange={(event) => this._setRendererList(list, { [field]: event.currentTarget.checked })} />{" "}
										{label}
									</label>
								))}
							</div>
							<Button size="sm" variant="secondary" onClick={() => this._inspectRendererList(list)}>
								Refresh Exact Resolution
							</Button>
						</div>
					))}
					{!rendererListState.lists.length && (
						<div className="text-xs text-muted-foreground">No renderer lists. Create one, then assign its stable id to a scene-raster custom pass.</div>
					)}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createRenderingLayer(): void {
		try {
			createRenderingLayer(this.props.object, { name: this.state.renderingLayerName.trim(), bit: this.state.renderingLayerBit }, { editor: this.props.editor });
			this.setState({ renderingLayerBit: Math.min(31, this.state.renderingLayerBit + 1) });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _setRenderingLayer(layer: any, update: any): void {
		try {
			setRenderingLayer(this.props.object, { layerId: layer.id, revision: layer.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _deleteRenderingLayer(layer: any): Promise<void> {
		if (!(await showConfirm("Delete Rendering Layer?", `Delete ${layer.name} and clear its bit from every current consumer?`, { confirmText: "Delete & Clear" }))) {
			return;
		}
		try {
			deleteRenderingLayer(this.props.object, { layerId: layer.id, revision: layer.revision, clearAssignments: true, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _setRenderingGroup(group: any, update: any): void {
		try {
			setRenderingGroup(this.props.object, { groupId: group.groupId, revision: group.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _resetRenderingGroup(group: any): Promise<void> {
		if (!(await showConfirm("Reset Rendering Group?", `Remove the authored policy for ${group.name} and restore Babylon defaults?`, { confirmText: "Reset" }))) {
			return;
		}
		try {
			resetRenderingGroup(this.props.object, { groupId: group.groupId, revision: group.revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _createRendererList(): void {
		try {
			createRendererList(this.props.object, { name: this.state.rendererListName.trim() }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _setRendererList(list: any, update: any): void {
		try {
			setRendererList(this.props.object, { rendererListId: list.id, revision: list.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _inspectRendererList(list: any): void {
		try {
			const resolved = resolveRendererList(this.props.object, { rendererListId: list.id });
			toast.success(
				`${list.name}: ${resolved.totalMeshes} mesh(es), O ${resolved.queueCounts.opaque} / A ${resolved.queueCounts.alphaTest} / T ${resolved.queueCounts.transparent}.`
			);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _deleteRendererList(list: any): Promise<void> {
		if (!(await showConfirm("Delete Renderer List?", `Delete ${list.name}? Referencing raster passes must be reassigned first.`, { confirmText: "Delete" }))) {
			return;
		}
		try {
			deleteRendererList(this.props.object, { rendererListId: list.id, revision: list.revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _getCameraStacksComponent(): ReactNode {
		const state = listCameraStacks(this.props.object, { limit: 32 });
		const stacks = state.stacks as any[];
		const cameras = state.cameras as any[];
		const active = state.active as { id: string; revision: number } | null;
		const runtime = state.runtime as any;
		const defaultBaseCameraId = this.state.cameraStackBaseCameraId || this.props.object.activeCamera?.id || cameras[0]?.id || "";
		return (
			<EditorInspectorSectionField
				title="Base / Overlay Camera Stacks"
				tooltip="Unity URP-style ordered camera composition using Babylon's real multi-camera render loop, with explicit color/depth clear, viewport inheritance, post-process suppression, stable revisions, and exact baseline restoration."
			>
				<div
					className={`rounded-lg p-2 text-xs ${runtime.active && runtime.valid ? "bg-success/10 text-success" : runtime.error ? "bg-destructive/10 text-destructive" : "bg-muted-foreground/10"}`}
				>
					{runtime.active
						? `${runtime.stackName} · revision ${runtime.revision} · ${runtime.cameras.length} camera(s) · frame ${runtime.frameId ?? "not rendered"}`
						: runtime.error
							? `Runtime rejected: ${runtime.error}`
							: "No active camera stack."}
					{runtime.renderedCameraIds?.length ? ` · rendered ${runtime.renderedCameraIds.join(" → ")}` : ""}
				</div>
				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
					<Input value={this.state.cameraStackName} aria-label="Camera stack name" onChange={(event) => this.setState({ cameraStackName: event.currentTarget.value })} />
					<label>
						Base camera
						<select
							className="h-9 w-full rounded-md border border-input bg-background px-2"
							value={defaultBaseCameraId}
							onChange={(event) => this.setState({ cameraStackBaseCameraId: event.currentTarget.value })}
						>
							{cameras.map((camera) => (
								<option key={camera.id} value={camera.id}>
									{camera.name} · {camera.id}
								</option>
							))}
						</select>
					</label>
					<Button
						variant="secondary"
						className="w-full"
						disabled={!defaultBaseCameraId || !this.state.cameraStackName.trim()}
						onClick={() => this._createCameraStack(defaultBaseCameraId)}
					>
						Create Camera Stack
					</Button>
				</div>
				{stacks.length === 0 && <div className="px-2 text-xs text-muted-foreground">No camera stacks. Create one, add overlays, then apply its exact revision.</div>}
				{stacks.map((stack) => (
					<div key={stack.id} className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={stack.enabled}
								disabled={active?.id === stack.id}
								onChange={(event) => this._setCameraStack(stack, { enabled: event.currentTarget.checked })}
							/>
							<Input
								defaultValue={stack.name}
								aria-label={`Camera stack ${stack.name} name`}
								onBlur={(event) => this._setCameraStack(stack, { newName: event.currentTarget.value })}
							/>
							{active?.id === stack.id ? (
								<Button size="sm" variant="secondary" onClick={() => this._clearActiveCameraStack(stack)}>
									Clear
								</Button>
							) : (
								<Button size="sm" variant="secondary" disabled={!stack.enabled} onClick={() => this._applyCameraStack(stack)}>
									Apply
								</Button>
							)}
							<Button size="sm" variant="ghost" className="hover:bg-destructive" disabled={active?.id === stack.id} onClick={() => this._deleteCameraStack(stack)}>
								Delete
							</Button>
						</div>
						<div className="text-muted-foreground">
							schema v{stack.version} · revision {stack.revision} · stable id {stack.id}
						</div>
						<label>
							Base camera
							<select
								className="h-9 w-full rounded-md border border-input bg-background px-2"
								value={stack.baseCameraId}
								onChange={(event) => this._setCameraStack(stack, { baseCameraId: event.currentTarget.value })}
							>
								{cameras.map((camera) => (
									<option key={camera.id} value={camera.id}>
										{camera.name} · {camera.id}
									</option>
								))}
							</select>
						</label>
						<div className="flex flex-wrap gap-4">
							<label className="flex items-center gap-1">
								<input
									type="checkbox"
									checked={stack.baseClearColor}
									onChange={(event) => this._setCameraStack(stack, { baseClearColor: event.currentTarget.checked })}
								/>{" "}
								Base color
							</label>
							<label className="flex items-center gap-1">
								<input
									type="checkbox"
									checked={stack.baseClearDepth}
									onChange={(event) => this._setCameraStack(stack, { baseClearDepth: event.currentTarget.checked })}
								/>{" "}
								Base depth
							</label>
						</div>
						<div className="flex items-end gap-2">
							<label className="min-w-0 flex-1">
								Overlay camera
								<select
									className="h-9 w-full rounded-md border border-input bg-background px-2"
									value={this.state.cameraStackOverlayCameraId}
									onChange={(event) => this.setState({ cameraStackOverlayCameraId: event.currentTarget.value })}
								>
									<option value="">Select camera</option>
									{cameras
										.filter((camera) => camera.id !== stack.baseCameraId && !stack.overlays.some((overlay: any) => overlay.cameraId === camera.id))
										.map((camera) => (
											<option key={camera.id} value={camera.id}>
												{camera.name} · {camera.id}
											</option>
										))}
								</select>
							</label>
							<Button
								size="sm"
								variant="secondary"
								disabled={!this.state.cameraStackOverlayCameraId || stack.overlays.length >= 8}
								onClick={() => this._addCameraStackOverlay(stack)}
							>
								Add Overlay
							</Button>
						</div>
						{stack.overlays.map((overlay: any) => (
							<div key={overlay.id} className="space-y-2 rounded border border-border p-2">
								<div className="flex items-center gap-2">
									<input
										type="checkbox"
										checked={overlay.enabled}
										onChange={(event) => this._setCameraStackOverlay(stack, overlay, { enabled: event.currentTarget.checked })}
									/>
									<span className="min-w-0 flex-1 truncate">
										{cameras.find((camera) => camera.id === overlay.cameraId)?.name ?? `Missing camera ${overlay.cameraId}`}
									</span>
									<Input
										className="w-20"
										type="number"
										min={-1000}
										max={1000}
										defaultValue={overlay.order}
										onBlur={(event) => this._setCameraStackOverlay(stack, overlay, { order: Number(event.currentTarget.value) })}
									/>
									<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._removeCameraStackOverlay(stack, overlay)}>
										Remove
									</Button>
								</div>
								<select
									className="h-9 w-full rounded-md border border-input bg-background px-2"
									value={overlay.cameraId}
									onChange={(event) => this._setCameraStackOverlay(stack, overlay, { cameraId: event.currentTarget.value })}
								>
									{cameras
										.filter(
											(camera) =>
												camera.id === overlay.cameraId ||
												(camera.id !== stack.baseCameraId && !stack.overlays.some((other: any) => other.id !== overlay.id && other.cameraId === camera.id))
										)
										.map((camera) => (
											<option key={camera.id} value={camera.id}>
												{camera.name} · {camera.id}
											</option>
										))}
								</select>
								<div className="flex flex-wrap gap-3">
									<label className="flex items-center gap-1">
										<input
											type="checkbox"
											checked={overlay.clearColor}
											onChange={(event) => this._setCameraStackOverlay(stack, overlay, { clearColor: event.currentTarget.checked })}
										/>{" "}
										Color
									</label>
									<label className="flex items-center gap-1">
										<input
											type="checkbox"
											checked={overlay.clearDepth}
											onChange={(event) => this._setCameraStackOverlay(stack, overlay, { clearDepth: event.currentTarget.checked })}
										/>{" "}
										Depth
									</label>
									<label className="flex items-center gap-1">
										<input
											type="checkbox"
											checked={overlay.postProcessing}
											onChange={(event) => this._setCameraStackOverlay(stack, overlay, { postProcessing: event.currentTarget.checked })}
										/>{" "}
										Post-processing
									</label>
									<select
										className="h-7 rounded-md border border-input bg-background px-2"
										value={overlay.viewportMode}
										onChange={(event) => this._setCameraStackOverlay(stack, overlay, { viewportMode: event.currentTarget.value })}
									>
										<option value="inherit-base">Inherit base viewport</option>
										<option value="camera">Own camera viewport</option>
									</select>
								</div>
							</div>
						))}
					</div>
				))}
				<div className="text-xs text-muted-foreground">
					The runtime rejects camera rigs and output render targets because this stack composes cameras into one shared framebuffer. Layer filtering remains the camera's
					native layerMask.
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createCameraStack(baseCameraId: string): void {
		try {
			createCameraStack(this.props.object, { name: this.state.cameraStackName.trim(), baseCameraId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _setCameraStack(stack: any, update: any): void {
		try {
			setCameraStack(this.props.object, { stackId: stack.id, revision: stack.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _addCameraStackOverlay(stack: any): void {
		try {
			addCameraStackOverlay(
				this.props.object,
				{ stackId: stack.id, revision: stack.revision, cameraId: this.state.cameraStackOverlayCameraId },
				{ editor: this.props.editor }
			);
			this.setState({ cameraStackOverlayCameraId: "" });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _setCameraStackOverlay(stack: any, overlay: any, update: any): void {
		try {
			setCameraStackOverlay(this.props.object, { stackId: stack.id, revision: stack.revision, overlayId: overlay.id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _removeCameraStackOverlay(stack: any, overlay: any): void {
		try {
			removeCameraStackOverlay(this.props.object, { stackId: stack.id, revision: stack.revision, overlayId: overlay.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _applyCameraStack(stack: any): void {
		try {
			applyCameraStack(this.props.object, { stackId: stack.id, revision: stack.revision }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _clearActiveCameraStack(stack: any): Promise<void> {
		if (!(await showConfirm("Clear Camera Stack?", `Restore the camera state captured before ${stack.name} was applied?`, { confirmText: "Clear" }))) {
			return;
		}
		try {
			clearActiveCameraStack(this.props.object, { stackId: stack.id, revision: stack.revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _deleteCameraStack(stack: any): Promise<void> {
		if (!(await showConfirm("Delete Camera Stack?", `Delete ${stack.name}? Cameras and their effects are not deleted.`, { confirmText: "Delete" }))) {
			return;
		}
		try {
			deleteCameraStack(this.props.object, { stackId: stack.id, revision: stack.revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _getRendererDataComponent(): ReactNode {
		const state = getRendererDataState(this.props.object);
		const selections = state.selections as any;
		const runtime = state.runtime as any;
		const selectedCamera = this.state.rendererDataCameraId;
		const selectedAssignment = selectedCamera ? selections.cameras.find((entry: any) => entry.cameraId === selectedCamera)?.asset : selections.default;
		return (
			<EditorInspectorSectionField
				title="Renderer Data / Camera Renderer"
				tooltip="Reusable Unity-style renderer-data assets with exact default/per-camera selection. Executes Babylon native Forward, clustered Forward+, or the bounded native deferred direct-lighting path with native forward composition for transparency, particles, sprites, layers, skyboxes, and later rendering groups."
			>
				<div
					className={`rounded-lg p-2 text-xs ${runtime.configured ? "bg-success/10 text-success" : runtime.errors?.length ? "bg-destructive/10 text-destructive" : "bg-muted-foreground/10"}`}
				>
					{runtime.configured
						? `Active selection revision ${runtime.revision} · ${runtime.cameras.length} configured camera(s)`
						: runtime.errors?.length
							? runtime.errors.join(" ")
							: "No renderer-data asset assigned."}
					{runtime.warnings?.length ? ` · ${runtime.warnings.join(" ")}` : ""}
				</div>
				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
					<Input
						value={this.state.rendererDataAssetPath}
						aria-label="Renderer data asset path"
						onChange={(event) => this.setState({ rendererDataAssetPath: event.currentTarget.value })}
					/>
					<Input
						value={this.state.rendererDataAssetName}
						aria-label="Renderer data asset name"
						onChange={(event) => this.setState({ rendererDataAssetName: event.currentTarget.value })}
					/>
					<div className="grid grid-cols-2 gap-2">
						<label>
							Rendering path
							<select
								className="h-9 w-full rounded-md border border-input bg-background px-2"
								value={this.state.rendererDataRenderingPath}
								onChange={(event) => this.setState({ rendererDataRenderingPath: event.currentTarget.value as any })}
							>
								<option value="forward">Native Forward</option>
								<option value="forward-plus">Clustered Forward+</option>
								<option value="deferred">Native Deferred (bounded)</option>
							</select>
						</label>
						<label>
							Assignment target
							<select
								className="h-9 w-full rounded-md border border-input bg-background px-2"
								value={selectedCamera}
								onChange={(event) => this.setState({ rendererDataCameraId: event.currentTarget.value })}
							>
								<option value="">Scene default</option>
								{this.props.object.cameras.map((camera) => (
									<option key={camera.id} value={camera.id}>
										{camera.name} · {camera.id}
									</option>
								))}
							</select>
						</label>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Button size="sm" variant="secondary" disabled={this.state.rendererDataBusy} onClick={() => void this._createRendererDataAsset()}>
							Create Preset Asset
						</Button>
						<Button size="sm" variant="secondary" disabled={this.state.rendererDataBusy} onClick={() => void this._assignRendererData()}>
							Assign Latest Revision
						</Button>
						<Button size="sm" variant="secondary" disabled={!selectedAssignment || this.state.rendererDataBusy} onClick={() => this._clearRendererDataAssignment()}>
							Clear Selected Assignment
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="hover:bg-destructive"
							disabled={this.state.rendererDataBusy}
							onClick={() => void this._deleteRendererDataAsset()}
						>
							Delete Asset File
						</Button>
					</div>
					{selectedAssignment && (
						<div className="rounded bg-background/60 p-2 text-muted-foreground">
							{selectedAssignment.name} · asset rev {selectedAssignment.assetRevision} · {selectedAssignment.settings.renderingPath} · snapshot{" "}
							{selectedAssignment.contentRevision.slice(0, 12)}
						</div>
					)}
				</div>
				{runtime.cameras.map((camera: any) => (
					<div key={camera.cameraId} className="space-y-1 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="font-medium">
							{camera.cameraName} · {camera.source} · {camera.asset.name}
						</div>
						<div className="text-muted-foreground">
							{camera.requestedRenderingPath} → {camera.effectiveRenderingPath} · mask {camera.layerMask} · post {camera.postProcessesEnabled ? "on" : "off"}
						</div>
						<div className="text-muted-foreground">
							Depth {camera.depthTexture.requestedMode} / {camera.depthTexture.active ? "active" : "inactive"} · {camera.depthTexture.width}×
							{camera.depthTexture.height} · Forward+ {camera.forwardPlus.active ? `${camera.forwardPlus.lightCount} lights` : "inactive"}
						</div>
						{camera.deferred && (
							<>
								<div className="text-muted-foreground">
									Deferred {camera.deferred.active ? (camera.deferred.ready ? "ready" : "warming") : "inactive"} · {camera.deferred.meshCount} meshes /{" "}
									{camera.deferred.materialCount} materials / {camera.deferred.lightCount} lights · G-buffer {camera.deferred.geometryBufferWidth}×
									{camera.deferred.geometryBufferHeight} · albedo {camera.deferred.albedoWidth}×{camera.deferred.albedoHeight} · {camera.deferred.frameCount}{" "}
									frames
								</div>
								<div className="text-muted-foreground">
									Emissive {camera.deferred.emissiveActive ? (camera.deferred.emissiveReady ? "ready" : "warming") : "inactive"} ·{" "}
									{camera.deferred.emissiveActive ? `${camera.deferred.emissiveWidth}×${camera.deferred.emissiveHeight}` : "no attachment"} ·{" "}
									{camera.deferred.emissiveMeshCount} meshes / {camera.deferred.emissiveMaterialCount} materials / {camera.deferred.emissiveTextureCount} textures
									· {camera.deferred.emissiveFrameCount} emissive frames
									{camera.deferred.emissiveEvidenceTruncated ? ` · evidence limited to ${camera.deferred.emissiveMaximumSources}` : ""}
								</div>
								{camera.deferred.emissiveSources.map((source: any) => (
									<div key={source.materialId} className="text-muted-foreground">
										Emission {source.materialName} · {source.materialClassName} · color {source.color.join(", ")} · intensity {source.intensity} ·{" "}
										{source.textureName ? `${source.textureName} (${source.textureReady ? "ready" : "loading"})` : "color only"} · {source.meshCount} mesh(es)
									</div>
								))}
								<div className="text-muted-foreground">
									Decals {camera.deferred.decalActive ? (camera.deferred.decalReady ? "ready" : "warming") : "inactive"} · {camera.deferred.decalGeometryCount}{" "}
									geometry / {camera.deferred.decalProjectorCount}/{camera.deferred.decalProjectorMaximumSources} screen-space projectors ·{" "}
									{camera.deferred.decalSourceMeshCount} source mesh(es) / {camera.deferred.decalMaterialCount} materials / {camera.deferred.decalTextureCount}{" "}
									textures · {camera.deferred.decalProjectorSamplerCount} projector sampler(s) · {camera.deferred.decalLayerFilteredProjectorCount} layer-filtered
									·{" "}
									{camera.deferred.decalLayerFilteredProjectorCount
										? `layer target ${camera.deferred.decalLayerTargetReady ? "ready" : "warming"} ${camera.deferred.decalLayerTargetWidth}×${camera.deferred.decalLayerTargetHeight} · `
										: ""}
									{camera.deferred.decalFrameCount} decal frames · {camera.deferred.decalForwardSubMeshSuppressedCount} forward submeshes suppressed ·{" "}
									{camera.deferred.decalForwardSuppressionFrameCount} suppression frames
									{camera.deferred.decalEvidenceTruncated ? ` · evidence limited to ${camera.deferred.decalMaximumSources}` : ""}
								</div>
								{camera.deferred.decalSources.map((source: any) => (
									<div key={source.nodeId} className="text-muted-foreground">
										Decal {source.nodeName} · {source.backend} · {source.alphaMode} {source.opacity} · {source.materialName} ({source.materialClassName}) ·{" "}
										{source.projectionMode === "screen-space-volume"
											? `volume ${source.size?.join("×")} · edge ${source.edgeFade} · UV ${source.uvScale.join("×")} + ${source.uvOffset.join(",")} · layers ${source.decalLayerMask} · ${
													Object.values(source.projectorTextureNames ?? {})
														.filter(Boolean)
														.join(", ") || "scalar/color only"
												} · ${source.affectedMeshCount} eligible meshes`
											: `source ${source.sourceMeshName ?? "merged geometry"}`}{" "}
										· channels albedo{source.affectsNormal ? "/normal" : ""}
										{source.affectsReflectivity ? "/reflectivity" : ""}
										{source.affectsAmbientOcclusion ? "/AO" : ""}
										{source.affectsEmissive ? "/emissive" : ""} · revision {source.revision} · {source.vertexCount} vertices / {source.indexCount} indices ·{" "}
										{source.geometryReady && source.texturesReady && source.projectorTexturesReady ? "ready" : "warming"}
									</div>
								))}
								<div className="text-muted-foreground">
									Cookies {camera.deferred.cookieActive ? (camera.deferred.cookieReady ? "ready" : "warming") : "inactive"} · {camera.deferred.cookieCount}/
									{camera.deferred.cookieMaximumSources} active · {camera.deferred.cookieFrameCount} cookie frames
								</div>
								{camera.deferred.cookieSources.map((source: any) => (
									<div key={`${source.lightId}-${source.revision}`} className="text-muted-foreground">
										Cookie {source.lightName} · {source.kind} · revision {source.revision} · {source.textureName} {source.textureWidth}×{source.textureHeight} ·
										intensity {source.intensity} · {source.textureReady ? "ready" : "loading"}
									</div>
								))}
								<div className="text-muted-foreground">
									Area lights {camera.deferred.areaLightActive ? (camera.deferred.areaLightReady ? "ready" : "warming") : "inactive"} ·{" "}
									{camera.deferred.areaLightCount} active · {camera.deferred.areaLightFrameCount} area-light frames
								</div>
								{camera.deferred.areaLightSources.map((source: any) => (
									<div key={`${source.lightId}-${source.revision}`} className="text-muted-foreground">
										Area {source.lightName} · {source.shape} · revision {source.revision} ·{" "}
										{source.shape === "disc" ? `radius ${source.radius}` : `${source.width}×${source.height}`} · intensity {source.intensity} · range{" "}
										{source.range} · {source.deferredModel} · {source.oneSided ? "one-sided" : "two-sided"} ·{" "}
										{source.castsRealtimeShadows ? "realtime shadows" : "baked/probe shadows only"}
									</div>
								))}
								<div className="text-muted-foreground">
									Camera context {camera.deferred.cameraId} · {camera.deferred.configuredCameraCount} deferred camera(s) /{" "}
									{camera.deferred.sharedGeometryBufferHolderCount} shared G-buffer lease(s) · viewport {camera.deferred.cameraViewport.join(", ")} · output{" "}
									{camera.deferred.outputRenderTargetName
										? `${camera.deferred.outputRenderTargetName} ${camera.deferred.outputRenderTargetWidth}×${camera.deferred.outputRenderTargetHeight}`
										: "default framebuffer"}
								</div>
								<div className="text-muted-foreground">
									Composition {camera.deferred.compositionMode} · {camera.deferred.forwardCompositionReady ? "ready" : "warming"} ·{" "}
									{camera.deferred.forwardMeshCount} forward meshes ({camera.deferred.transparentMeshCount} transparent / {camera.deferred.backgroundMeshCount}{" "}
									background / {camera.deferred.laterRenderingGroupMeshCount} later-group) · {camera.deferred.particleSystemCount} particles /{" "}
									{camera.deferred.spriteManagerCount} sprites / {camera.deferred.layerCount} layers · {camera.deferred.forwardCompositionFrameCount} composed
									frames
								</div>
								<div className="text-muted-foreground">
									Shadows{" "}
									{camera.deferred.shadowLightCount
										? `${camera.deferred.shadowLightCount}/${camera.deferred.shadowMaximumSources} lights · ${camera.deferred.shadowMapCount} maps · ${camera.deferred.shadowSamplerCount}/${camera.deferred.shadowSamplerBudget} shadow/backend samplers`
										: "none"}{" "}
									· {camera.deferred.shadowMapReady ? `${camera.deferred.shadowMapWidth}×${camera.deferred.shadowMapHeight} ready` : "inactive"} ·{" "}
									{camera.deferred.shadowCasterCount} casters / {camera.deferred.shadowReceiverCount} deferred receivers · {camera.deferred.shadowFrameCount}{" "}
									shadowed frames
								</div>
								{camera.deferred.shadowSources.map((source: any) => (
									<div key={`${source.lightId}-${source.index}`} className="text-muted-foreground">
										Shadow #{source.index} {source.lightName} · light slot {source.lightIndex} · {source.generatorType} · {source.filter} · {source.mapType}
										{source.filteringQuality ? ` · ${source.filteringQuality} quality` : ""}
										{source.cascadeCount ? ` · ${source.cascadeCount} cascades` : ""} · {source.mapCount} map(s) · {source.mapWidth}×{source.mapHeight}{" "}
										{source.mapReady ? "ready" : "warming"} · {source.casterCount} casters / {source.receiverCount} receivers · {source.samplerCount} sampler(s)
										· blur {source.blurScale} · depth {source.depthScale} · light UV {source.contactHardeningLightSizeUVRatio}
									</div>
								))}
								<div className="text-muted-foreground">
									IBL {camera.deferred.iblActive ? (camera.deferred.iblReady ? "ready" : "warming") : "inactive"} · {camera.deferred.iblSourceCount}/
									{camera.deferred.iblMaximumSources} sources · selector{" "}
									{camera.deferred.iblSelectorReady ? `${camera.deferred.iblSelectorWidth}×${camera.deferred.iblSelectorHeight} ready` : "inactive"} · environment{" "}
									{camera.deferred.iblEnvironmentTextureName ?? "none"} · {camera.deferred.iblReflectionProbeCount} reflection probe(s) ·{" "}
									{camera.deferred.iblProbeBlendMeshCount} multi-probe mesh(es) · {camera.deferred.iblProbeBlendModel} · {camera.deferred.iblFrameCount} IBL
									frames
								</div>
								{camera.deferred.iblSources.map((source: any) => (
									<div key={`${source.kind}-${source.index}-${source.textureName}`} className="text-muted-foreground">
										IBL #{source.index} {source.name} · {source.kind} · {source.width}×{source.height} · LOD {source.maximumLod} · {source.diffuseMode} ·
										intensity {source.intensity} · {source.meshCount} meshes / {source.materialCount} materials ·{" "}
										{source.boxProjection ? `box ${source.boxSize.join("×")}` : source.kind === "reflection-probe" ? "unprojected box influence" : "infinite"}
										{source.kind === "reflection-probe" ? ` · slot ${source.probeSlot} · importance ${source.importance} · blend ${source.blendDistance}` : ""}
									</div>
								))}
								<Button size="sm" variant="secondary" disabled={this.state.rendererDataBusy} onClick={() => void this._rebuildDeferredLighting(camera.cameraId)}>
									Rebuild Deferred Runtime
								</Button>
							</>
						)}
						{camera.rendererFeatureInstanceIds !== null && (
							<div className="text-muted-foreground">Features: {camera.rendererFeatureInstanceIds.join(", ") || "none"}</div>
						)}
						{camera.warnings.length > 0 && <div className="text-warning">{camera.warnings.join(" ")}</div>}
						{camera.errors.length > 0 && <div className="text-destructive">{camera.errors.join(" ")}</div>}
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private async _createRendererDataAsset(): Promise<void> {
		this.setState({ rendererDataBusy: true });
		try {
			const result = await createRendererDataAsset(
				this.props.object,
				{
					path: this.state.rendererDataAssetPath,
					name: this.state.rendererDataAssetName,
					renderingPath: this.state.rendererDataRenderingPath,
				},
				{ editor: this.props.editor }
			);
			toast.success(`Created renderer-data asset revision ${result.assetRevision}.`);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ rendererDataBusy: false });
		}
	}

	private async _assignRendererData(): Promise<void> {
		this.setState({ rendererDataBusy: true });
		try {
			const asset = await getRendererDataAsset(this.props.object, { path: this.state.rendererDataAssetPath });
			const current = getRendererDataState(this.props.object).selections;
			await assignRendererData(
				this.props.object,
				{
					path: asset.path,
					expectedRevision: asset.contentRevision,
					selectionRevision: current.revision,
					...(this.state.rendererDataCameraId ? { cameraId: this.state.rendererDataCameraId } : {}),
				},
				{ editor: this.props.editor }
			);
			toast.success(`Assigned ${asset.name} to ${this.state.rendererDataCameraId ? "the selected camera" : "the scene default"}.`);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ rendererDataBusy: false });
		}
	}

	private _clearRendererDataAssignment(): void {
		try {
			const current = getRendererDataState(this.props.object).selections;
			clearRendererDataAssignment(
				this.props.object,
				{ selectionRevision: current.revision, ...(this.state.rendererDataCameraId ? { cameraId: this.state.rendererDataCameraId } : {}) },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _deleteRendererDataAsset(): Promise<void> {
		if (!(await showConfirm("Delete Renderer Data Asset?", `Permanently delete ${this.state.rendererDataAssetPath}?`, { confirmText: "Delete" }))) {
			return;
		}
		this.setState({ rendererDataBusy: true });
		try {
			const asset = await getRendererDataAsset(this.props.object, { path: this.state.rendererDataAssetPath });
			await deleteRendererDataAsset(this.props.object, { path: asset.path, expectedRevision: asset.contentRevision, confirm: true }, { editor: this.props.editor });
			toast.success(`Deleted renderer-data asset ${asset.path}.`);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ rendererDataBusy: false });
		}
	}

	private async _rebuildDeferredLighting(cameraId: string): Promise<void> {
		this.setState({ rendererDataBusy: true });
		try {
			const current = getRendererDataState(this.props.object).selections;
			const result = rebuildDeferredLighting(this.props.object, { cameraId, selectionRevision: current.revision }, { editor: this.props.editor });
			toast.success(result.runtime.active ? "Deferred lighting runtime rebuilt." : "Deferred request rebuilt with its configured forward fallback.");
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ rendererDataBusy: false });
		}
	}

	private _getRenderingProfilesComponent(): ReactNode {
		const profileState = listRenderingProfiles(this.props.object);
		const profiles = profileState.profiles as any[];
		const profileRuntime = profileState.runtime as any;
		const volumes = listRenderingVolumes(this.props.object).volumes as any[];
		const camera = this.props.object.activeCamera;
		return (
			<EditorInspectorSectionField
				title="Rendering Profiles"
				tooltip="Reusable snapshots of the active camera's post-process configuration. Applying a profile persists the selected camera configuration for exported games."
			>
				<Button variant="secondary" className="w-full" disabled={!camera} onClick={() => this._createRenderingProfile("custom")}>
					Save Active Camera Profile
				</Button>
				<div className="grid grid-cols-4 gap-1">
					{(["web-performance", "mobile", "desktop", "xr"] as const).map((target) => (
						<Button key={target} size="sm" variant="secondary" disabled={!camera} onClick={() => this._createRenderingProfile(target)}>
							{target === "web-performance" ? "Web" : target === "mobile" ? "Mobile" : target === "desktop" ? "Desktop" : "XR"}
						</Button>
					))}
				</div>
				<div className={`rounded-lg p-2 text-xs ${profileRuntime?.compatible ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
					Runtime: {profileRuntime?.backend ?? "bounded-project-render-pipeline-profile-v1"} · {profileRuntime?.capabilities?.backend ?? "Unknown"} · active{" "}
					{profileRuntime?.activeProfileName ?? "none"}
					{profileRuntime?.errors?.length ? ` · ${profileRuntime.errors.join(" ")}` : ""}
				</div>
				{profileState.activeProfileId && (
					<Button size="sm" variant="secondary" onClick={() => this._clearActiveRenderingProfile(profileState.activeProfileId, profileRuntime.activeRevision)}>
						Clear Active Project Profile
					</Button>
				)}
				{!camera && <div className="px-2 text-xs text-muted-foreground">Select an active camera before saving or applying a profile.</div>}
				{profiles.length === 0 && (
					<div className="px-2 text-sm text-muted-foreground">No rendering profiles. Save the active camera’s rendering configuration as a reusable preset.</div>
				)}
				{profiles.map((profile) => (
					<div key={profile.id} className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
						<div className="flex items-center gap-2">
							<Input
								defaultValue={profile.name}
								aria-label={`Rendering profile ${profile.name} name`}
								onBlur={(event) => this._renameRenderingProfile(profile, event.target.value)}
							/>
							<Button size="sm" variant="secondary" disabled={!camera} onClick={() => this._applyRenderingProfile(profile, false)}>
								Camera
							</Button>
							<Button size="sm" variant="secondary" disabled={!camera} onClick={() => this._applyRenderingProfile(profile, true)}>
								Project
							</Button>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteRenderingProfile(profile)}>
								Remove
							</Button>
						</div>
						<div className="text-xs text-muted-foreground">
							{profileState.activeProfileId === profile.id ? "Active · " : ""}
							{profile.target} · rev {profile.revision} · {profile.quality.textures}/{profile.quality.shadows}/{profile.quality.lods} · {profile.quality.renderScale}x
						</div>
						<div className="text-xs text-muted-foreground">
							{Object.entries(profile.configurations)
								.filter(([, configuration]) => configuration !== null)
								.map(([type]) => type)
								.join(", ") || "All post-processes disabled"}
						</div>
						<details className="rounded-md border border-border/50 p-2 text-xs">
							<summary className="cursor-pointer font-medium">
								Dynamic Resolution · {profile.dynamicResolution.mode}
								{profileState.activeProfileId === profile.id && profileRuntime?.dynamicResolution
									? ` · ${profileRuntime.dynamicResolution.requestedScale}x requested / ${profileRuntime.dynamicResolution.effectiveScale}x effective`
									: ""}
							</summary>
							<div className="mt-2 grid grid-cols-2 gap-2">
								<label>
									Mode
									<select
										className="h-9 w-full rounded-md border border-input bg-background px-2"
										value={profile.dynamicResolution.mode}
										onChange={(event) => this._setDynamicResolutionProfile(profile, { mode: event.currentTarget.value })}
									>
										<option value="disabled">Disabled</option>
										<option value="fixed">Fixed</option>
										<option value="adaptive">Adaptive</option>
									</select>
								</label>
								<label>
									Upscaler
									<select
										className="h-9 w-full rounded-md border border-input bg-background px-2"
										value={profile.dynamicResolution.upscaler}
										onChange={(event) => this._setDynamicResolutionProfile(profile, { upscaler: event.currentTarget.value })}
									>
										<option value="browser-linear">Browser Linear</option>
										<option value="browser-pixelated">Browser Pixelated</option>
									</select>
								</label>
								{(
									[
										["minimumScale", "Minimum scale", 0.25, 2, 0.05],
										["maximumScale", "Maximum scale", 0.25, 2, 0.05],
										["initialScale", "Initial scale", 0.25, 2, 0.05],
										["fixedScale", "Fixed scale", 0.25, 2, 0.05],
										["targetFrameRate", "Target FPS", 15, 240, 1],
										["sampleFrames", "Sample frames", 2, 240, 1],
										["cooldownFrames", "Cooldown frames", 0, 600, 1],
										["downscaleFrameTimeRatio", "Downscale ratio", 1.01, 3, 0.01],
										["upscaleFrameTimeRatio", "Upscale ratio", 0.1, 0.99, 0.01],
										["downscaleStep", "Downscale step", 0.01, 0.5, 0.01],
										["upscaleStep", "Upscale step", 0.01, 0.5, 0.01],
									] as const
								).map(([property, label, min, max, step]) => (
									<label key={property}>
										{label}
										<Input
											type="number"
											min={min}
											max={max}
											step={step}
											defaultValue={profile.dynamicResolution[property]}
											onBlur={(event) => this._setDynamicResolutionProfile(profile, { [property]: Number(event.currentTarget.value) })}
										/>
									</label>
								))}
							</div>
							{profileState.activeProfileId === profile.id && profileRuntime?.dynamicResolution && (
								<div className="mt-2 space-y-1 rounded-md bg-background/50 p-2 text-muted-foreground">
									<div>
										{profileRuntime.dynamicResolution.running ? "Running" : "Configured"} · {profileRuntime.dynamicResolution.measurement} · average{" "}
										{profileRuntime.dynamicResolution.averageFrameTimeMs ?? "collecting"} ms
									</div>
									<div>
										{profileRuntime.dynamicResolution.lastDecision} · {profileRuntime.dynamicResolution.lastReason}
									</div>
									<div>
										Samples {profileRuntime.dynamicResolution.windowSamples}/{profile.dynamicResolution.sampleFrames} · changes{" "}
										{profileRuntime.dynamicResolution.scaleChanges.length} · cooldown {profileRuntime.dynamicResolution.cooldownRemaining}
									</div>
									<Button size="sm" variant="secondary" onClick={() => this._resetDynamicResolutionRuntime(profile)}>
										Reset Runtime Evidence
									</Button>
								</div>
							)}
						</details>
						<details className="rounded-md border border-border/50 p-2 text-xs">
							<summary className="cursor-pointer font-medium">
								Render Reconstruction · {profile.reconstruction.mode}
								{profileState.activeProfileId === profile.id && profileRuntime?.reconstruction?.running
									? ` · ${profileRuntime.reconstruction.sourceSize?.width ?? "?"}×${profileRuntime.reconstruction.sourceSize?.height ?? "?"} → ${profileRuntime.reconstruction.outputSize.width}×${profileRuntime.reconstruction.outputSize.height}`
									: ""}
							</summary>
							<div className="mt-2 grid grid-cols-2 gap-2">
								<label>
									Mode
									<select
										className="h-9 w-full rounded-md border border-input bg-background px-2"
										value={profile.reconstruction.mode}
										onChange={(event) => this._setRenderReconstructionProfile(profile, { mode: event.currentTarget.value })}
									>
										<option value="disabled">Disabled</option>
										<option value="spatial">Spatial</option>
										<option value="temporal">Temporal</option>
									</select>
								</label>
								{(
									[
										["sharpness", "Sharpness", 0, 1, 0.01],
										["edgeThreshold", "Edge threshold", 0.001, 1, 0.001],
										["historyWeight", "History weight", 0, 0.98, 0.01],
										["disocclusionThreshold", "Disocclusion", 0.001, 1, 0.001],
										["jitterSamples", "Jitter samples", 2, 32, 1],
										["cameraCutPositionThreshold", "Camera-cut distance", 0, 1000000, 1],
										["cameraCutRotationThreshold", "Camera-cut degrees", 0, 180, 1],
									] as const
								).map(([property, label, min, max, step]) => (
									<label key={property}>
										{label}
										<Input
											type="number"
											min={min}
											max={max}
											step={step}
											defaultValue={profile.reconstruction[property]}
											onBlur={(event) => this._setRenderReconstructionProfile(profile, { [property]: Number(event.currentTarget.value) })}
										/>
									</label>
								))}
							</div>
							<div className="mt-2 grid grid-cols-3 gap-2 text-muted-foreground">
								{(
									[
										["clampHistory", "Clamp history"],
										["reprojectHistory", "Velocity reprojection"],
										["resetOnCameraCut", "Reset on camera cut"],
									] as const
								).map(([property, label]) => (
									<label key={property}>
										<input
											type="checkbox"
											checked={profile.reconstruction[property]}
											onChange={(event) => this._setRenderReconstructionProfile(profile, { [property]: event.currentTarget.checked })}
										/>{" "}
										{label}
									</label>
								))}
							</div>
							{profileState.activeProfileId === profile.id && profileRuntime?.reconstruction && (
								<div className="mt-2 space-y-1 rounded-md bg-background/50 p-2 text-muted-foreground">
									<div>
										{profileRuntime.reconstruction.running ? "Running" : "Configured"} · {profileRuntime.reconstruction.backendName} · source{" "}
										{profileRuntime.reconstruction.effectiveSourceScale}x · spatial {profileRuntime.reconstruction.spatialReady ? "ready" : "not ready"} ·
										presentation {profileRuntime.reconstruction.presentationReady ? "ready" : "not ready"}
									</div>
									<div>
										Velocity {profileRuntime.reconstruction.velocityAvailable ? "available" : "unavailable"} · history{" "}
										{profileRuntime.reconstruction.historyFrames} frames / {profileRuntime.reconstruction.historyResets} resets · jitter{" "}
										{profileRuntime.reconstruction.jitterFrame}
									</div>
									{profileRuntime.reconstruction.lastHistoryResetReason && <div>{profileRuntime.reconstruction.lastHistoryResetReason}</div>}
									{profileRuntime.reconstruction.warnings?.length > 0 && <div>{profileRuntime.reconstruction.warnings.join(" ")}</div>}
									{profile.reconstruction.mode === "temporal" && (
										<Button size="sm" variant="secondary" onClick={() => this._resetRenderReconstructionHistory(profile)}>
											Reset Temporal History
										</Button>
									)}
								</div>
							)}
						</details>
					</div>
				))}
				<div className="mt-2 flex items-center justify-between gap-2 text-xs">
					<span className="font-medium">Rendering Volumes</span>
					<Button size="sm" variant="secondary" disabled={!profiles.length} onClick={() => this._createRenderingVolume(profiles[0])}>
						Add at Camera
					</Button>
				</div>
				{volumes.map((volume) => (
					<div key={volume.id} className="rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate">
								{volume.name} · {profiles.find((profile) => profile.id === volume.profileId)?.name ?? "Missing profile"}
							</span>
							<Button size="sm" variant="secondary" onClick={() => this._evaluateRenderingVolumes()}>
								Evaluate
							</Button>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteRenderingVolume(volume.id)}>
								Remove
							</Button>
						</div>
						<div className="mt-2 grid grid-cols-3 gap-2">
							<label>
								Priority
								<Input
									type="number"
									defaultValue={volume.priority}
									onBlur={(event) => this._setRenderingVolumeNumber(volume, "priority", event.currentTarget.value)}
								/>
							</label>
							<label>
								Blend distance
								<Input
									type="number"
									min={0}
									defaultValue={volume.blendDistance ?? 0}
									onBlur={(event) => this._setRenderingVolumeNumber(volume, "blendDistance", event.currentTarget.value)}
								/>
							</label>
							<label>
								Weight
								<Input
									type="number"
									min={0}
									max={1}
									step={0.05}
									defaultValue={volume.weight ?? 1}
									onBlur={(event) => this._setRenderingVolumeNumber(volume, "weight", event.currentTarget.value)}
								/>
							</label>
						</div>
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _createRenderingProfile(target: "web-performance" | "mobile" | "desktop" | "xr" | "custom"): void {
		const camera = this.props.object.activeCamera;
		if (!camera) {
			return;
		}
		const profiles = listRenderingProfiles(this.props.object).profiles as any[];
		let index = profiles.length + 1;
		while (profiles.some((profile) => profile.name === `Rendering Profile ${index}`)) {
			index++;
		}
		try {
			createRenderingProfile(this.props.object, { name: `Rendering Profile ${index}`, nodeId: camera.id, target }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getCustomRenderPassGraphComponent(): ReactNode {
		const graph = listCustomRenderPasses(this.props.object);
		const passes = graph.passes as any[];
		const schedule = graph.schedule as any;
		const camera = this.props.object.activeCamera;
		const frameDebugger = camera ? getCustomRenderPassFrameDebugger(this.props.object, { passLimit: 8, resourceLimit: 8 }) : null;
		const isolationPassId = graph.frameDebugger?.isolationPassId as string | null;
		const assetState = graph.renderGraphAsset as any;
		const assignedAsset = assetState.assignment as any | null;
		const basePasses = passes.filter((pass) => !pass.rendererFeature);
		const featureInstances = listRendererFeatureInstances(this.props.object, { limit: 64 }).instances as any[];
		const rendererLists = listRendererLists(this.props.object, { limit: 64 }).lists as any[];
		const conformance = getRenderGraphConformance(this.props.object);
		return (
			<EditorInspectorSectionField
				title="Custom Render Pass Graph"
				tooltip="Dependency-ordered shader, copy, general scene-graphics, and native WebGPU compute passes with named texture outputs."
			>
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" onClick={() => this._createCustomRenderPass()}>
						Add Pass
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!camera} onClick={() => this._evaluateCustomRenderPassGraph()}>
						Rebuild Preview
					</Button>
				</div>
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" disabled={!camera || !passes.length} onClick={() => this._captureCustomRenderPassFrame()}>
						Capture Frame
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!camera || !isolationPassId} onClick={() => this._setCustomRenderPassFrameIsolation(null)}>
						Clear Isolation
					</Button>
				</div>
				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
					<div className="flex items-center justify-between gap-2">
						<div className="font-medium">WebGL2 / WebGPU Conformance</div>
						<div className="flex gap-1">
							<Button
								size="sm"
								variant="secondary"
								disabled={!camera || !["webgl2", "webgpu"].includes(conformance.capabilities.backend)}
								onClick={() => void this._runRenderGraphConformance(conformance.revision)}
							>
								Run {conformance.capabilities.backend === "webgpu" ? "WebGPU" : "WebGL2"}
							</Button>
							<Button size="sm" variant="ghost" disabled={conformance.revision === null} onClick={() => void this._clearRenderGraphConformance(conformance.revision)}>
								Clear
							</Button>
						</div>
					</div>
					<div className="grid grid-cols-2 gap-2">
						{(["webgl2", "webgpu"] as const).map((target) => {
							const run = conformance.runs[target];
							const status = conformance.coverage[target];
							return (
								<div
									key={target}
									className={`rounded p-2 ${status === "passed" ? "bg-success/10 text-success" : status === "failed" ? "bg-destructive/10 text-destructive" : "bg-background/60"}`}
								>
									<div className="font-medium">{target === "webgpu" ? "WebGPU" : "WebGL2"}</div>
									<div>
										{status === "notRun"
											? "Not run for this graph"
											: status === "passed"
												? `Passed · frame ${run?.frameId ?? "?"}`
												: `Failed · ${run?.error ?? "unready resources"}`}
									</div>
									{conformance.targets[target].blockers.map((blocker: string) => (
										<div key={blocker}>{blocker}</div>
									))}
								</div>
							);
						})}
					</div>
					<div className="text-muted-foreground">
						Graph {conformance.graphSignature} · {conformance.requirements.enabledPassCount} enabled pass(es) · {conformance.requirements.outputCount} output(s) · max{" "}
						{conformance.requirements.maximumColorAttachments} attachment(s) / {conformance.requirements.maximumMsaaSamples}x MSAA
					</div>
					<div className="text-muted-foreground">
						Portable certification: {conformance.coverage.portable ? "passed on this exact graph" : "requires successful live runs on both backends"}. Static target
						checks never certify a device.
					</div>
				</div>
				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
					<div className="font-medium">Reusable Render Graph Asset · schema v2</div>
					<Input
						value={this.state.renderGraphAssetPath}
						aria-label="Render graph asset path"
						onChange={(event) => this.setState({ renderGraphAssetPath: event.currentTarget.value })}
					/>
					<Input
						value={this.state.renderGraphAssetName}
						aria-label="Render graph asset name"
						onChange={(event) => this.setState({ renderGraphAssetName: event.currentTarget.value })}
					/>
					<div className="flex gap-2">
						<Button size="sm" variant="secondary" className="flex-1" disabled={this.state.renderGraphAssetBusy} onClick={() => this._saveCustomRenderGraphAsset()}>
							Save New
						</Button>
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							disabled={this.state.renderGraphAssetBusy || !camera}
							onClick={() => this._applyCustomRenderGraphAsset()}
						>
							Apply Path
						</Button>
					</div>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							disabled={this.state.renderGraphAssetBusy || !assignedAsset || !assetState.dirty}
							onClick={() => this._updateAssignedCustomRenderGraphAsset()}
						>
							Save Assigned
						</Button>
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							disabled={this.state.renderGraphAssetBusy || !assignedAsset}
							onClick={() => this._detachCustomRenderGraphAsset()}
						>
							Detach
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="hover:bg-destructive"
							disabled={this.state.renderGraphAssetBusy}
							onClick={() => this._deleteCustomRenderGraphAsset()}
						>
							Delete File
						</Button>
					</div>
					<div className="text-muted-foreground">
						{assignedAsset
							? `${assignedAsset.path} · asset r${assignedAsset.assetRevision} · ${assetState.dirty ? "scene changes not saved" : "current"}`
							: "No asset assigned; the scene keeps its embedded runtime graph."}
					</div>
				</div>
				<div className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
					<div className="font-medium">Reusable Renderer Features · schema v1</div>
					<Input
						value={this.state.rendererFeatureAssetPath}
						aria-label="Renderer feature asset path"
						onChange={(event) => this.setState({ rendererFeatureAssetPath: event.currentTarget.value })}
					/>
					<Input
						value={this.state.rendererFeatureAssetName}
						aria-label="Renderer feature asset name"
						onChange={(event) => this.setState({ rendererFeatureAssetName: event.currentTarget.value })}
					/>
					<Input
						value={this.state.rendererFeaturePassIds}
						placeholder="Pass ids, comma-separated; empty selects all base passes"
						aria-label="Renderer feature pass ids"
						onChange={(event) => this.setState({ rendererFeaturePassIds: event.currentTarget.value })}
					/>
					<Input
						value={this.state.rendererFeaturePrefix}
						placeholder="Instance namespace prefix"
						aria-label="Renderer feature prefix"
						onChange={(event) => this.setState({ rendererFeaturePrefix: event.currentTarget.value })}
					/>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							disabled={this.state.rendererFeatureBusy || !basePasses.length}
							onClick={() => this._saveRendererFeatureAsset()}
						>
							Save / Update Feature
						</Button>
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							disabled={this.state.rendererFeatureBusy || !camera}
							onClick={() => this._instantiateRendererFeature()}
						>
							Instantiate
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="hover:bg-destructive"
							disabled={this.state.rendererFeatureBusy}
							onClick={() => this._deleteRendererFeatureAsset()}
						>
							Delete File
						</Button>
					</div>
					<div className="text-muted-foreground">
						Features namespace a dependency-closed subpass graph and filter it per camera id, projection, or layer mask. Generated passes are edited through their
						instance or source asset.
					</div>
					{featureInstances.length === 0 && <div className="text-muted-foreground">No renderer-feature instances in this scene.</div>}
					{featureInstances.map((instance) => (
						<div key={instance.id} className="space-y-1 rounded border border-border p-2">
							<div className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={instance.enabled}
									aria-label={`Enable renderer feature ${instance.name}`}
									onChange={(event) => this._setRendererFeatureInstance(instance, { enabled: event.currentTarget.checked })}
								/>
								<div className="min-w-0 flex-1 truncate font-medium" title={instance.name}>
									{instance.name}
								</div>
								<Button size="sm" variant="secondary" disabled={this.state.rendererFeatureBusy} onClick={() => this._refreshRendererFeatureInstance(instance)}>
									Refresh
								</Button>
								<Button
									size="sm"
									variant="ghost"
									className="hover:bg-destructive"
									disabled={this.state.rendererFeatureBusy}
									onClick={() => this._deleteRendererFeatureInstance(instance)}
								>
									Remove
								</Button>
							</div>
							<label>
								Order group
								<Input
									type="number"
									min={-1000}
									max={1000}
									defaultValue={instance.order}
									onBlur={(event) => this._setRendererFeatureInstance(instance, { order: Number(event.currentTarget.value) })}
								/>
							</label>
							<label>
								Camera filter JSON
								<Textarea
									className="font-mono"
									defaultValue={JSON.stringify(instance.cameraFilter, null, 2)}
									onBlur={(event) => {
										try {
											this._setRendererFeatureInstance(instance, { cameraFilter: JSON.parse(event.currentTarget.value) });
										} catch (error) {
											toast.error(error instanceof Error ? error.message : "Camera filter must be valid JSON.");
										}
									}}
								/>
							</label>
							<div className="truncate text-muted-foreground" title={`${instance.assetPath} @ ${instance.assetRevision}`}>
								{instance.activeForCamera ? "Active" : "Filtered"} · {instance.passes.length} pass(es) · {instance.prefix} · r{instance.revision}
							</div>
						</div>
					))}
				</div>
				{frameDebugger?.captured && (
					<div className="space-y-1 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="font-medium">
							Frame Debugger · capture {frameDebugger.captureId} · frame {frameDebugger.frameId} · {frameDebugger.backend}
						</div>
						<div className="text-muted-foreground">
							{frameDebugger.activePassCount}/{frameDebugger.authoredPassCount} active · {frameDebugger.culledPassCount} culled · {frameDebugger.resourceCount}{" "}
							resources / {frameDebugger.allocationCount} allocations{frameDebugger.isolationPassId ? " · isolated dependency closure" : ""}
						</div>
						{frameDebugger.passes.map((debugPass: any) => (
							<div key={debugPass.id} className="truncate text-muted-foreground" title={JSON.stringify(debugPass)}>
								{debugPass.active ? "●" : "○"} {debugPass.name} · {debugPass.phase} · frame {debugPass.lastExecutionFrame ?? "never"} · CPU{" "}
								{debugPass.lastCpuDurationMs === null ? "n/a" : `${debugPass.lastCpuDurationMs.toFixed(3)} ms`}
								{debugPass.gpuDurationMs === null ? "" : ` · GPU ${debugPass.gpuDurationMs.toFixed(3)} ms`}
							</div>
						))}
						{frameDebugger.resources.map((resource: any) => (
							<div key={resource.name} className="truncate text-muted-foreground" title={JSON.stringify(resource)}>
								↳ {resource.name} · slot {resource.allocationSlot} · lifetime {resource.firstUse}–{resource.lastUse} ·{" "}
								{resource.allocated ? `${resource.width}×${resource.height}` : "not allocated"}
							</div>
						))}
					</div>
				)}
				{frameDebugger && !frameDebugger.captured && (
					<div className="px-2 text-xs text-muted-foreground">Capture after rebuilding/rendering to freeze pass and resource evidence.</div>
				)}
				{passes.length === 0 && <div className="px-2 text-sm text-muted-foreground">No custom render-graph passes.</div>}
				{schedule.outputs.length > 0 && (
					<div className="rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="font-medium">Transient outputs · {schedule.allocationCount} allocation(s)</div>
						{schedule.outputs.map((output: any) => (
							<div
								key={output.name}
								className="truncate text-muted-foreground"
								title={`${output.name}: pass ${output.firstUse}–${output.lastUse}, slot ${output.allocationSlot}`}
							>
								{output.name} · {output.outputFormat}/{output.outputType} · {output.outputSamples}x MSAA · lifetime {output.firstUse}–{output.lastUse} · slot{" "}
								{output.allocationSlot}
							</div>
						))}
					</div>
				)}
				{passes.map((pass) => (
					<div key={pass.id} className="space-y-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={pass.enabled}
								disabled={Boolean(pass.rendererFeature)}
								aria-label={`Enable ${pass.name}`}
								onChange={(event) => this._setCustomRenderPass(pass, { enabled: event.currentTarget.checked })}
							/>
							<Input
								defaultValue={pass.name}
								disabled={Boolean(pass.rendererFeature)}
								aria-label="Custom render pass name"
								onBlur={(event) => this._setCustomRenderPass(pass, { name: event.currentTarget.value })}
							/>
							<Button
								size="sm"
								variant="ghost"
								className="hover:bg-destructive"
								disabled={Boolean(pass.rendererFeature)}
								onClick={() => this._deleteCustomRenderPass(pass)}
							>
								Remove
							</Button>
							<Button size="sm" variant={isolationPassId === pass.id ? "default" : "secondary"} onClick={() => this._setCustomRenderPassFrameIsolation(pass)}>
								{isolationPassId === pass.id ? "Isolated" : "Isolate"}
							</Button>
						</div>
						{pass.rendererFeature ? (
							<div className="rounded border border-border p-2 text-muted-foreground">
								Generated by renderer-feature instance {pass.rendererFeature.instanceId} · source pass {pass.rendererFeature.sourcePassId} · {pass.injectionPoint}.
								Edit the source asset or instance above.
							</div>
						) : (
							<>
								<label>
									Pass type
									<select
										className="h-9 w-full rounded-md border border-input bg-background px-2"
										value={pass.passType ?? "shader"}
										onChange={(event) =>
											this._setCustomRenderPass(pass, {
												passType: event.currentTarget.value,
												...(event.currentTarget.value === "copy" || event.currentTarget.value === "raster" || event.currentTarget.value === "compute"
													? {
															additionalOutputs: [],
															output:
																pass.output ??
																`${pass.name.replace(/[^A-Za-z0-9_]/g, "_")}${event.currentTarget.value === "copy" ? "Copy" : event.currentTarget.value === "raster" ? "Raster" : "Compute"}`,
															...(event.currentTarget.value === "compute" ? { outputFormat: "rgba", outputSamples: 1 } : {}),
														}
													: {}),
											})
										}
									>
										<option value="shader">Shader</option>
										<option value="copy">Copy</option>
										<option value="raster">Scene Graphics</option>
										<option value="compute">WebGPU Compute</option>
									</select>
								</label>
								<label>
									Injection point
									<select
										className="h-9 w-full rounded-md border border-input bg-background px-2"
										value={pass.injectionPoint}
										onChange={(event) => this._setCustomRenderPass(pass, { injectionPoint: event.currentTarget.value })}
									>
										{pass.passType === "raster" && <option value="beforeRendering">Before rendering (scene graphics)</option>}
										{pass.passType === "compute" && <option value="afterRenderingPrePasses">After rendering pre-passes (compute)</option>}
										{(pass.passType === "shader" || pass.passType === "copy") && (
											<>
												<option value="beforeRenderingPostProcessing">Before camera post-processing</option>
												<option value="afterRenderingPostProcessing">After camera post-processing</option>
											</>
										)}
									</select>
								</label>
								{pass.passType === "copy" && (
									<label>
										Copy source JSON
										<Textarea
											className="font-mono"
											placeholder={'{"source":"screen"} or {"source":"pass","output":"sceneColor"}'}
											defaultValue={JSON.stringify(pass.copySource ?? { source: "screen" }, null, 2)}
											onBlur={(event) => this._setCustomRenderPassJson(pass, "copySource", event.currentTarget.value)}
										/>
									</label>
								)}
								{pass.passType === "raster" && (
									<div className="space-y-2">
										<label>
											Reusable Renderer List
											<select
												className="h-9 w-full rounded-md border border-input bg-background px-2"
												value={pass.rasterSettings?.rendererListId ?? ""}
												onChange={(event) => {
													const rendererListId = event.currentTarget.value || null;
													this._setCustomRenderPass(pass, {
														rasterSettings: {
															...pass.rasterSettings,
															rendererListId,
															...(rendererListId ? { cameraId: null, meshIds: [], includeDescendants: false, layerMask: null } : {}),
														},
													});
												}}
											>
												<option value="">Local pass filters</option>
												{rendererLists.map((rendererList) => (
													<option key={rendererList.id} value={rendererList.id} disabled={!rendererList.valid}>
														{rendererList.name} · r{rendererList.revision} · {rendererList.resolvedMeshCount} meshes
													</option>
												))}
											</select>
										</label>
										<label>
											Scene graphics settings JSON
											<Textarea
												className="font-mono"
												placeholder={
													'{"rendererListId":null,"cameraId":null,"meshIds":[],"includeDescendants":false,"layerMask":null,"materialId":null,"clearColor":[0,0,0,0],"clearMode":"colorDepth","depthTest":true,"depthWrite":true,"cullMode":"back","blendMode":"opaque","renderParticles":false,"renderSprites":false,"useCameraPostProcesses":false,"refreshRate":"everyFrame"}'
												}
												defaultValue={JSON.stringify(pass.rasterSettings, null, 2)}
												onBlur={(event) => this._setCustomRenderPassJson(pass, "rasterSettings", event.currentTarget.value)}
											/>
										</label>
										<div className="text-muted-foreground">
											Select a reusable list for exact camera/layer/group/queue/sort resolution. Local camera, mesh, descendant, and layer filters must remain
											at their defaults while a list is assigned; material, clear, depth, culling, blending, particle, and sprite state remains pass-local.
										</div>
									</div>
								)}
								{pass.passType === "compute" && (
									<label>
										Compute settings JSON
										<Textarea
											className="min-h-52 font-mono"
											placeholder={
												'{"wgsl":"@group(0) @binding(0) ...","entryPoint":"main","outputBindingName":"outputTexture","outputGroup":0,"outputBinding":0,"dispatch":[128,128,1],"dispatchMode":"everyFrame","dispatchType":"direct","submitAfterDispatch":false,"uniformBuffers":[],"storageBuffers":[{"sharedResource":"simulationData","access":"readWrite"}]}'
											}
											defaultValue={JSON.stringify(pass.computeSettings, null, 2)}
											onBlur={(event) => this._setCustomRenderPassJson(pass, "computeSettings", event.currentTarget.value)}
										/>
										<div className="text-muted-foreground">
											Native WebGPU only. SharedResource keys reuse one allocation; conflicting read/write usages require dependency ordering and use WebGPU's
											implicit command-order synchronization. submitAfterDispatch adds an expensive explicit GPU submission boundary.
										</div>
									</label>
								)}
								<div className="grid grid-cols-3 gap-2">
									<label>
										Order
										<Input
											type="number"
											defaultValue={pass.order}
											onBlur={(event) => this._setCustomRenderPassNumber(pass, "order", event.currentTarget.value)}
										/>
									</label>
									<label>
										Ratio
										<Input
											type="number"
											min={0.01}
											max={1}
											step={0.05}
											defaultValue={pass.ratio}
											onBlur={(event) => this._setCustomRenderPassNumber(pass, "ratio", event.currentTarget.value)}
										/>
									</label>
									<label>
										Sampling
										<select
											className="h-9 w-full rounded-md border border-input bg-background px-2"
											value={pass.samplingMode}
											onChange={(event) => this._setCustomRenderPass(pass, { samplingMode: event.currentTarget.value })}
										>
											<option value="nearest">Nearest</option>
											<option value="bilinear">Bilinear</option>
											<option value="trilinear">Trilinear</option>
										</select>
									</label>
								</div>
								<label>
									Dependency ids (comma-separated)
									<Input
										defaultValue={pass.dependencies.join(", ")}
										onBlur={(event) =>
											this._setCustomRenderPass(pass, {
												dependencies: event.currentTarget.value
													.split(",")
													.map((value) => value.trim())
													.filter(Boolean),
											})
										}
									/>
								</label>
								<label>
									Named output
									<Input
										placeholder="Optional output identifier"
										defaultValue={pass.output ?? ""}
										onBlur={(event) => this._setCustomRenderPass(pass, { output: event.currentTarget.value.trim() || null })}
									/>
								</label>
								{pass.output && (
									<>
										<div className="grid grid-cols-3 gap-2">
											<label>
												Precision
												<select
													className="h-9 w-full rounded-md border border-input bg-background px-2"
													value={pass.outputType}
													onChange={(event) => this._setCustomRenderPass(pass, { outputType: event.currentTarget.value })}
												>
													<option value="uint8">8-bit</option>
													<option value="halfFloat">Half float</option>
													<option value="float">Float</option>
												</select>
											</label>
											<label>
												Channels
												<select
													className="h-9 w-full rounded-md border border-input bg-background px-2"
													value={pass.outputFormat}
													onChange={(event) => this._setCustomRenderPass(pass, { outputFormat: event.currentTarget.value })}
												>
													<option value="r">R</option>
													<option value="rg">RG</option>
													<option value="rgba">RGBA</option>
												</select>
											</label>
											<label>
												MSAA
												<Input
													type="number"
													min={1}
													max={8}
													step={1}
													defaultValue={pass.outputSamples}
													onBlur={(event) => this._setCustomRenderPassNumber(pass, "outputSamples", event.currentTarget.value)}
												/>
											</label>
										</div>
										{pass.passType === "shader" && (
											<>
												<label>
													Additional MRT outputs JSON (maximum 3)
													<Textarea
														className="font-mono"
														placeholder={'[{"name":"normalColor","outputType":"halfFloat","outputFormat":"rgba","outputSamples":1}]'}
														defaultValue={JSON.stringify(pass.additionalOutputs ?? [], null, 2)}
														onBlur={(event) => this._setCustomRenderPassJson(pass, "additionalOutputs", event.currentTarget.value)}
													/>
												</label>
												<div className="text-muted-foreground">
													MRT shaders must write gl_FragData[0] through gl_FragData[N]. All attachments share the primary MSAA count.
												</div>
											</>
										)}
									</>
								)}
								{pass.passType === "shader" && (
									<>
										<label>
											Uniforms JSON
											<Textarea
												className="font-mono"
												defaultValue={JSON.stringify(pass.uniforms, null, 2)}
												onBlur={(event) => this._setCustomRenderPassJson(pass, "uniforms", event.currentTarget.value)}
											/>
										</label>
										<label>
											Resource inputs JSON (depth, normal, texture, pass output)
											<Textarea
												className="font-mono"
												placeholder={'{"depthSampler":{"source":"depth"},"lookupSampler":{"source":"texture","path":"assets/lookup.png"}}'}
												defaultValue={JSON.stringify(pass.inputs ?? {}, null, 2)}
												onBlur={(event) => this._setCustomRenderPassJson(pass, "inputs", event.currentTarget.value)}
											/>
										</label>
										<label>
											Fragment shader
											<Textarea
												className="min-h-40 font-mono"
												defaultValue={pass.fragmentShader}
												onBlur={(event) => this._setCustomRenderPass(pass, { fragmentShader: event.currentTarget.value })}
											/>
										</label>
									</>
								)}
							</>
						)}
						<div className="truncate text-muted-foreground" title={pass.id}>
							Id: {pass.id}
						</div>
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _createCustomRenderPass(): void {
		const passes = listCustomRenderPasses(this.props.object).passes as any[];
		let index = passes.length + 1;
		while (passes.some((pass) => pass.name === `Custom Pass ${index}`)) {
			index++;
		}
		try {
			const result = createCustomRenderPass(this.props.object, { name: `Custom Pass ${index}` }, { editor: this.props.editor });
			if (result.preview.error) {
				toast.warning(result.preview.error);
			}
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setCustomRenderPass(pass: any, update: any): void {
		try {
			const result = setCustomRenderPass(this.props.object, { id: pass.id, ...update }, { editor: this.props.editor });
			if (result.preview.error) {
				toast.warning(result.preview.error);
			}
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setCustomRenderPassNumber(pass: any, property: "order" | "ratio" | "outputSamples", rawValue: string): void {
		const value = Number(rawValue);
		if (Number.isFinite(value)) {
			this._setCustomRenderPass(pass, { [property]: value });
		}
	}

	private _setCustomRenderPassJson(
		pass: any,
		property: "uniforms" | "inputs" | "additionalOutputs" | "copySource" | "rasterSettings" | "computeSettings",
		rawValue: string
	): void {
		try {
			this._setCustomRenderPass(pass, { [property]: JSON.parse(rawValue) });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : `${property} must be valid JSON.`);
		}
	}

	private _deleteCustomRenderPass(pass: any): void {
		try {
			const result = deleteCustomRenderPass(this.props.object, { id: pass.id }, { editor: this.props.editor });
			if (result.preview.error) {
				toast.warning(result.preview.error);
			}
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _evaluateCustomRenderPassGraph(): void {
		try {
			evaluateCustomRenderPassGraph(this.props.object, {}, { editor: this.props.editor });
			toast.success("Custom render-pass graph rebuilt.");
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _captureCustomRenderPassFrame(): void {
		try {
			const result = captureCustomRenderPassFrameDebugger(this.props.object, { passLimit: 8, resourceLimit: 8 }, { editor: this.props.editor });
			toast.success(`Captured render-graph frame ${result.frameId}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _runRenderGraphConformance(expectedRevision: number | null): Promise<void> {
		try {
			const result = await runRenderGraphConformance(this.props.object, { expectedRevision, frameCount: 4 }, { editor: this.props.editor });
			const backend = result.capabilities.backend as "webgl2" | "webgpu";
			const run = result.runs[backend];
			if (run?.passed) {
				toast.success(`${backend === "webgpu" ? "WebGPU" : "WebGL2"} render-graph conformance passed.`);
			} else {
				toast.error(run?.error ?? `${backend} render-graph conformance found unready passes or resources.`);
			}
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _clearRenderGraphConformance(revision: number): Promise<void> {
		if (!(await showConfirm("Clear Render Graph Conformance?", "Remove both persisted backend runs for this graph?", { confirmText: "Clear" }))) {
			return;
		}
		try {
			clearRenderGraphConformance(this.props.object, { revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setCustomRenderPassFrameIsolation(pass: any | null): void {
		try {
			setCustomRenderPassFrameIsolation(this.props.object, pass ? { id: pass.id } : { clear: true }, { editor: this.props.editor });
			toast.success(pass ? `Isolated ${pass.name} and its dependency closure.` : "Cleared render-pass isolation.");
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _saveCustomRenderGraphAsset(): Promise<void> {
		this.setState({ renderGraphAssetBusy: true });
		try {
			const result = await saveCustomRenderGraphAsset(
				this.props.object,
				{ path: this.state.renderGraphAssetPath, assetName: this.state.renderGraphAssetName },
				{ editor: this.props.editor }
			);
			toast.success(`Saved render-graph asset ${result.path}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ renderGraphAssetBusy: false });
		}
	}

	private async _applyCustomRenderGraphAsset(): Promise<void> {
		this.setState({ renderGraphAssetBusy: true });
		try {
			let asset = await getCustomRenderGraphAsset(this.props.object, { path: this.state.renderGraphAssetPath });
			if (asset.migrationRequired) {
				const migration = await getCustomRenderGraphAssetMigration(this.props.object, { path: this.state.renderGraphAssetPath });
				await migrateCustomRenderGraphAsset(
					this.props.object,
					{ path: this.state.renderGraphAssetPath, expectedSourceRevision: migration.sourceRevision },
					{ editor: this.props.editor }
				);
				asset = await getCustomRenderGraphAsset(this.props.object, { path: this.state.renderGraphAssetPath });
			}
			await applyCustomRenderGraphAsset(this.props.object, { path: this.state.renderGraphAssetPath, expectedRevision: asset.contentRevision }, { editor: this.props.editor });
			this.setState({ renderGraphAssetName: asset.name });
			toast.success(`Applied render-graph asset ${asset.path}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ renderGraphAssetBusy: false });
		}
	}

	private async _updateAssignedCustomRenderGraphAsset(): Promise<void> {
		const assigned = listCustomRenderPasses(this.props.object).renderGraphAsset.assignment as any | null;
		if (!assigned) {
			return;
		}
		this.setState({ renderGraphAssetBusy: true });
		try {
			const result = await updateAssignedCustomRenderGraphAsset(
				this.props.object,
				{ expectedRevision: assigned.contentRevision, assetName: this.state.renderGraphAssetName },
				{ editor: this.props.editor }
			);
			toast.success(`Updated render-graph asset revision ${result.assetRevision}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ renderGraphAssetBusy: false });
		}
	}

	private _detachCustomRenderGraphAsset(): void {
		const assigned = listCustomRenderPasses(this.props.object).renderGraphAsset.assignment as any | null;
		if (!assigned) {
			return;
		}
		try {
			detachCustomRenderGraphAsset(this.props.object, { id: assigned.id, expectedRevision: assigned.contentRevision }, { editor: this.props.editor });
			toast.success("Detached the render-graph asset and retained the embedded scene graph.");
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _deleteCustomRenderGraphAsset(): Promise<void> {
		if (!(await showConfirm("Delete Render Graph Asset?", `Permanently delete ${this.state.renderGraphAssetPath}?`, { confirmText: "Delete" }))) {
			return;
		}
		this.setState({ renderGraphAssetBusy: true });
		try {
			const asset = await getCustomRenderGraphAsset(this.props.object, { path: this.state.renderGraphAssetPath });
			await deleteCustomRenderGraphAsset(
				this.props.object,
				{ path: this.state.renderGraphAssetPath, expectedRevision: asset.contentRevision, confirm: true },
				{ editor: this.props.editor }
			);
			toast.success(`Deleted render-graph asset ${asset.path}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ renderGraphAssetBusy: false });
		}
	}

	private async _saveRendererFeatureAsset(): Promise<void> {
		const basePasses = (listCustomRenderPasses(this.props.object).passes as any[]).filter((pass) => !pass.rendererFeature);
		const requestedIds = this.state.rendererFeaturePassIds
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		const passIds = requestedIds.length ? requestedIds : basePasses.map((pass) => pass.id);
		this.setState({ rendererFeatureBusy: true });
		try {
			let existing: any | null = null;
			try {
				existing = await getRendererFeatureAsset(this.props.object, { path: this.state.rendererFeatureAssetPath });
			} catch {
				// The save action distinguishes a missing path from malformed or unsafe existing files.
			}
			if (existing && !(await showConfirm("Update Renderer Feature?", `Publish a new revision of ${existing.path}?`, { confirmText: "Update" }))) {
				return;
			}
			const result = await saveRendererFeatureAsset(
				this.props.object,
				{
					path: this.state.rendererFeatureAssetPath,
					assetName: this.state.rendererFeatureAssetName,
					passIds,
					...(existing ? { overwrite: true, expectedRevision: existing.contentRevision } : {}),
				},
				{ editor: this.props.editor }
			);
			toast.success(`Saved renderer-feature asset revision ${result.assetRevision}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ rendererFeatureBusy: false });
		}
	}

	private async _instantiateRendererFeature(): Promise<void> {
		this.setState({ rendererFeatureBusy: true });
		try {
			const asset = await getRendererFeatureAsset(this.props.object, { path: this.state.rendererFeatureAssetPath });
			const result = await instantiateRendererFeature(
				this.props.object,
				{
					path: this.state.rendererFeatureAssetPath,
					expectedRevision: asset.contentRevision,
					instanceName: asset.name,
					prefix: this.state.rendererFeaturePrefix,
				},
				{ editor: this.props.editor }
			);
			toast.success(`Instantiated ${result.instance.name} with ${result.generatedPassIds.length} subpass(es).`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ rendererFeatureBusy: false });
		}
	}

	private _setRendererFeatureInstance(instance: any, update: any): void {
		try {
			setRendererFeatureInstance(this.props.object, { instanceId: instance.id, revision: instance.revision, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _refreshRendererFeatureInstance(instance: any): Promise<void> {
		this.setState({ rendererFeatureBusy: true });
		try {
			const asset = await getRendererFeatureAsset(this.props.object, { path: instance.assetPath });
			const result = await refreshRendererFeatureInstance(
				this.props.object,
				{ instanceId: instance.id, revision: instance.revision, expectedAssetRevision: asset.contentRevision },
				{ editor: this.props.editor }
			);
			toast.success(`Refreshed ${result.instance.name} to the latest asset revision.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ rendererFeatureBusy: false });
		}
	}

	private async _deleteRendererFeatureInstance(instance: any): Promise<void> {
		if (!(await showConfirm("Remove Renderer Feature?", `Remove ${instance.name} and its generated passes from this scene?`, { confirmText: "Remove" }))) {
			return;
		}
		try {
			deleteRendererFeatureInstance(this.props.object, { instanceId: instance.id, revision: instance.revision, confirm: true }, { editor: this.props.editor });
			toast.success(`Removed renderer-feature instance ${instance.name}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _deleteRendererFeatureAsset(): Promise<void> {
		if (!(await showConfirm("Delete Renderer Feature Asset?", `Permanently delete ${this.state.rendererFeatureAssetPath}?`, { confirmText: "Delete" }))) {
			return;
		}
		this.setState({ rendererFeatureBusy: true });
		try {
			const asset = await getRendererFeatureAsset(this.props.object, { path: this.state.rendererFeatureAssetPath });
			await deleteRendererFeatureAsset(
				this.props.object,
				{ path: this.state.rendererFeatureAssetPath, expectedRevision: asset.contentRevision, confirm: true },
				{ editor: this.props.editor }
			);
			toast.success(`Deleted renderer-feature asset ${asset.path}.`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		} finally {
			this.setState({ rendererFeatureBusy: false });
		}
	}

	private _renameRenderingProfile(profile: any, name: string): void {
		if (!name.trim() || name === profile.name) {
			return;
		}
		try {
			setRenderingProfile(this.props.object, { id: profile.id, revision: profile.revision, name }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setDynamicResolutionProfile(profile: any, patch: Record<string, unknown>): void {
		const [property, nextValue] = Object.entries(patch)[0] ?? [];
		if (!property || nextValue === profile.dynamicResolution[property] || (typeof nextValue === "number" && !Number.isFinite(nextValue))) {
			return;
		}
		try {
			setDynamicResolution(this.props.object, { id: profile.id, revision: profile.revision, configuration: patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _resetDynamicResolutionRuntime(profile: any): void {
		try {
			resetDynamicResolutionRuntime(this.props.object, { id: profile.id, revision: profile.revision }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setRenderReconstructionProfile(profile: any, patch: Record<string, unknown>): void {
		const [property, nextValue] = Object.entries(patch)[0] ?? [];
		if (!property || nextValue === profile.reconstruction[property] || (typeof nextValue === "number" && !Number.isFinite(nextValue))) {
			return;
		}
		try {
			setRenderReconstruction(this.props.object, { id: profile.id, revision: profile.revision, configuration: patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _resetRenderReconstructionHistory(profile: any): void {
		try {
			resetRenderReconstructionHistory(this.props.object, { id: profile.id, revision: profile.revision }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _applyRenderingProfile(profile: any, activateProject: boolean): void {
		const camera = this.props.object.activeCamera;
		if (!camera) {
			return;
		}
		try {
			applyRenderingProfile(this.props.object, { id: profile.id, revision: profile.revision, nodeId: camera.id, activateProject }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteRenderingProfile(profile: any): void {
		try {
			deleteRenderingProfile(this.props.object, { id: profile.id, revision: profile.revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _clearActiveRenderingProfile(id: string, revision: number): void {
		try {
			clearActiveRenderingProfile(this.props.object, { id, revision, confirm: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createRenderingVolume(profile: any): void {
		const camera = this.props.object.activeCamera;
		if (!camera) {
			return;
		}
		try {
			const volumes = listRenderingVolumes(this.props.object).volumes as any[];
			createRenderingVolume(
				this.props.object,
				{ name: `Rendering Volume ${volumes.length + 1}`, profileId: profile.id, center: camera.position.asArray(), size: [1000, 1000, 1000] },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _evaluateRenderingVolumes(): void {
		try {
			evaluateRenderingVolumes(this.props.object, {}, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setRenderingVolumeNumber(volume: any, property: "priority" | "blendDistance" | "weight", rawValue: string): void {
		const value = Number(rawValue);
		if (!Number.isFinite(value) || value === volume[property]) {
			return;
		}
		try {
			setRenderingVolume(this.props.object, { id: volume.id, [property]: value }, { editor: this.props.editor });
			this._evaluateRenderingVolumes();
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteRenderingVolume(id: string): void {
		try {
			deleteRenderingVolume(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getDefaultRenderingPipelineComponent(): ReactNode {
		const defaultRenderingPipeline = getDefaultRenderingPipeline();

		const config = {
			enabled: defaultRenderingPipeline ? true : false,
		};

		return (
			<>
				<EditorInspectorSectionField title="Rendering Pipeline">
					<EditorInspectorSwitchField
						object={config}
						property="enabled"
						label="Enabled"
						noUndoRedo
						onChange={() => {
							const pipeline = defaultRenderingPipeline;
							const serializedPipeline = serializeDefaultRenderingPipeline();

							registerUndoRedo({
								executeRedo: true,
								undo: () => {
									if (!pipeline) {
										disposeDefaultRenderingPipeline();
									} else if (serializedPipeline) {
										parseDefaultRenderingPipeline(this.props.editor, serializedPipeline);
									}
								},
								redo: () => {
									if (pipeline) {
										disposeDefaultRenderingPipeline();
									} else if (serializedPipeline) {
										parseDefaultRenderingPipeline(this.props.editor, serializedPipeline);
									} else {
										createDefaultRenderingPipeline(this.props.editor);
									}
								},
							});

							this.forceUpdate();
						}}
					/>

					{defaultRenderingPipeline && <EditorInspectorSwitchField object={defaultRenderingPipeline} property="fxaaEnabled" label="FXAA Enabled" />}
				</EditorInspectorSectionField>

				{defaultRenderingPipeline && (
					<>
						<EditorInspectorSectionField title="Image Processing">
							<EditorInspectorSwitchField object={defaultRenderingPipeline} property="imageProcessingEnabled" label="Enabled" onChange={() => this.forceUpdate()} />
							{defaultRenderingPipeline.imageProcessingEnabled && (
								<>
									<EditorInspectorNumberField object={defaultRenderingPipeline.imageProcessing} property="exposure" label="Exposure" />
									<EditorInspectorNumberField object={defaultRenderingPipeline.imageProcessing} property="contrast" label="Contrast" />
									<EditorInspectorSwitchField object={defaultRenderingPipeline.imageProcessing} property="fromLinearSpace" label="From Linear Space" />
									<EditorInspectorSwitchField
										object={defaultRenderingPipeline.imageProcessing}
										property="toneMappingEnabled"
										label="Tone Mapping Enabled"
										onChange={() => this.forceUpdate()}
									/>

									{defaultRenderingPipeline.imageProcessing.toneMappingEnabled && (
										<EditorInspectorListField
											object={defaultRenderingPipeline.imageProcessing}
											property="toneMappingType"
											label="Tone Mapping Type"
											items={[
												{ text: "Hable", value: TonemappingOperator.Hable },
												{ text: "Reinhard", value: TonemappingOperator.Reinhard },
												{ text: "Heji Dawson", value: TonemappingOperator.HejiDawson },
												{ text: "Photographic", value: TonemappingOperator.Photographic },
											]}
										/>
									)}

									<EditorInspectorSwitchField
										object={defaultRenderingPipeline.imageProcessing}
										property="ditheringEnabled"
										label="Dithering Enabled"
										onChange={() => this.forceUpdate()}
									/>
									{defaultRenderingPipeline.imageProcessing.ditheringEnabled && (
										<EditorInspectorNumberField object={defaultRenderingPipeline.imageProcessing} property="ditheringIntensity" label="Dithering Intensity" />
									)}
								</>
							)}
						</EditorInspectorSectionField>

						{defaultRenderingPipeline.imageProcessingEnabled && (
							<>
								<EditorInspectorSectionField title="Color Grading">
									<EditorInspectorSwitchField
										object={defaultRenderingPipeline.imageProcessing}
										property="colorGradingEnabled"
										label="Enabled"
										onChange={() => this.forceUpdate()}
									/>

									{defaultRenderingPipeline.imageProcessing.colorGradingEnabled && (
										<>
											<EditorInspectorTextureField
												accept3dlTexture
												title="Texture"
												property="colorGradingTexture"
												scene={this.props.editor.layout.preview.scene}
												object={defaultRenderingPipeline.imageProcessing}
											>
												<EditorInspectorSwitchField
													object={defaultRenderingPipeline.imageProcessing.imageProcessingConfiguration}
													property="colorGradingWithGreenDepth"
													label="Use Green Depth"
												/>
											</EditorInspectorTextureField>
										</>
									)}
								</EditorInspectorSectionField>

								<EditorInspectorSectionField title="Color Curves">
									<EditorInspectorSwitchField
										object={defaultRenderingPipeline.imageProcessing}
										property="colorCurvesEnabled"
										label="Enabled"
										onChange={() => this.forceUpdate()}
									/>

									{defaultRenderingPipeline.imageProcessing.colorCurvesEnabled && (
										<>
											<div className="text-xl font-semibold px-2 text-center">Global</div>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="globalHue"
												min={0}
												max={360}
												defaultValue={30}
												label={<div className="w-16">Hue</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="globalExposure"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Exposure</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="globalDensity"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Density</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="globalSaturation"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Saturation</div>}
											/>

											<div className="text-xl font-semibold px-2 text-center">Highlights</div>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="highlightsHue"
												min={0}
												max={360}
												defaultValue={30}
												label={<div className="w-16">Hue</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="highlightsExposure"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Exposure</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="highlightsDensity"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Density</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="highlightsSaturation"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Saturation</div>}
											/>

											<div className="text-xl font-semibold px-2 text-center">Midtones</div>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="midtonesHue"
												min={0}
												max={360}
												defaultValue={30}
												label={<div className="w-16">Hue</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="midtonesExposure"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Exposure</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="midtonesDensity"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Density</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="midtonesSaturation"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Saturation</div>}
											/>

											<div className="text-xl font-semibold px-2 text-center">Shadows</div>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="shadowsHue"
												min={0}
												max={360}
												defaultValue={30}
												label={<div className="w-16">Hue</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="shadowsExposure"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Exposure</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="shadowsDensity"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Density</div>}
											/>
											<EditorInspectorSliderField
												object={defaultRenderingPipeline.imageProcessing.colorCurves}
												property="shadowsSaturation"
												min={-100}
												max={100}
												defaultValue={0}
												label={<div className="w-16">Saturation</div>}
											/>
										</>
									)}
								</EditorInspectorSectionField>
							</>
						)}

						<EditorInspectorSectionField title="Bloom">
							<EditorInspectorSwitchField object={defaultRenderingPipeline} property="bloomEnabled" label="Enabled" onChange={() => this.forceUpdate()} />
							{defaultRenderingPipeline.bloomEnabled && (
								<>
									<EditorInspectorNumberField object={defaultRenderingPipeline} property="bloomThreshold" label="Threshold" />
									<EditorInspectorNumberField object={defaultRenderingPipeline} property="bloomWeight" label="Weight" />
									<EditorInspectorNumberField object={defaultRenderingPipeline} property="bloomScale" label="Scale" min={0} max={1} />
									<EditorInspectorNumberField object={defaultRenderingPipeline} property="bloomKernel" label="Kernal" step={1} min={0} max={512} />
								</>
							)}
						</EditorInspectorSectionField>

						<EditorInspectorSectionField title="Sharpen">
							<EditorInspectorSwitchField object={defaultRenderingPipeline} property="sharpenEnabled" label="Enabled" onChange={() => this.forceUpdate()} />
							{defaultRenderingPipeline.sharpenEnabled && (
								<>
									<EditorInspectorNumberField object={defaultRenderingPipeline.sharpen} property="edgeAmount" label="Edge Amount" />
									<EditorInspectorNumberField object={defaultRenderingPipeline.sharpen} property="colorAmount" label="Color Amount" />
								</>
							)}
						</EditorInspectorSectionField>

						<EditorInspectorSectionField title="Grain">
							<EditorInspectorSwitchField object={defaultRenderingPipeline} property="grainEnabled" label="Enabled" onChange={() => this.forceUpdate()} />
							{defaultRenderingPipeline.grainEnabled && (
								<>
									<EditorInspectorNumberField object={defaultRenderingPipeline.grain} property="intensity" label="Intensity" />
									<EditorInspectorSwitchField object={defaultRenderingPipeline.grain} property="animated" label="Animated" />
								</>
							)}
						</EditorInspectorSectionField>

						<EditorInspectorSectionField title="Depth-of-field">
							<EditorInspectorSwitchField object={defaultRenderingPipeline} property="depthOfFieldEnabled" label="Enabled" onChange={() => this.forceUpdate()} />

							{defaultRenderingPipeline.depthOfFieldEnabled && (
								<>
									<EditorInspectorListField
										object={defaultRenderingPipeline}
										property="depthOfFieldBlurLevel"
										label="Blur Level"
										items={[
											{ text: "Low", value: DepthOfFieldEffectBlurLevel.Low },
											{ text: "Medium", value: DepthOfFieldEffectBlurLevel.Medium },
											{ text: "High", value: DepthOfFieldEffectBlurLevel.High },
										]}
										onChange={() => this.forceUpdate()}
									/>

									<EditorInspectorNumberField object={defaultRenderingPipeline.depthOfField} property="lensSize" label="Lens Size" step={0.1} min={0} />
									<EditorInspectorNumberField object={defaultRenderingPipeline.depthOfField} property="fStop" label="F-stop" step={0.01} min={0} />
									<EditorInspectorNumberField
										min={0}
										label="Focus Distance"
										property="focusDistance"
										object={defaultRenderingPipeline.depthOfField}
										step={(this.props.editor.layout.preview.scene.activeCamera?.maxZ ?? 0) / 1000}
										max={(this.props.editor.layout.preview.scene.activeCamera?.maxZ ?? 0) * 1000}
									/>
									<EditorInspectorNumberField object={defaultRenderingPipeline.depthOfField} property="focalLength" label="Focal Length" step={0.01} min={0} />
								</>
							)}
						</EditorInspectorSectionField>

						{defaultRenderingPipeline.imageProcessingEnabled && (
							<EditorInspectorSectionField title="Vignette">
								<EditorInspectorSwitchField
									object={defaultRenderingPipeline.imageProcessing}
									property="vignetteEnabled"
									label="Enabled"
									onChange={() => this.forceUpdate()}
								/>

								{defaultRenderingPipeline.imageProcessing.vignetteEnabled && (
									<>
										<EditorInspectorNumberField
											object={defaultRenderingPipeline.imageProcessing}
											property="vignetteWeight"
											label="Weight"
											step={0.01}
											min={0}
										/>
										<EditorInspectorColorField object={defaultRenderingPipeline.imageProcessing} property="vignetteColor" label="Color" />
									</>
								)}
							</EditorInspectorSectionField>
						)}

						<EditorInspectorSectionField title="Chromatic Aberration">
							<EditorInspectorSwitchField
								object={defaultRenderingPipeline}
								property="chromaticAberrationEnabled"
								label="Enabled"
								onChange={() => this.forceUpdate()}
							/>

							{defaultRenderingPipeline.chromaticAberrationEnabled && (
								<>
									<EditorInspectorNumberField
										object={defaultRenderingPipeline.chromaticAberration}
										property="aberrationAmount"
										label="Aberration Amount"
										step={0.01}
										min={0}
									/>
									<EditorInspectorNumberField
										object={defaultRenderingPipeline.chromaticAberration}
										property="radialIntensity"
										label="Radial Intensity"
										step={0.01}
										min={0}
									/>

									<EditorInspectorVectorField object={defaultRenderingPipeline.chromaticAberration} property="direction" label="Direction" />
									<EditorInspectorVectorField object={defaultRenderingPipeline.chromaticAberration} property="centerPosition" label="Center" />
								</>
							)}
						</EditorInspectorSectionField>

						<EditorInspectorSectionField title="Glow Layer">
							<EditorInspectorSwitchField object={defaultRenderingPipeline} property="glowLayerEnabled" label="Enabled" onChange={() => this.forceUpdate()} />

							{defaultRenderingPipeline.glowLayerEnabled && defaultRenderingPipeline.glowLayer && (
								<>
									<EditorInspectorNumberField object={defaultRenderingPipeline.glowLayer} property="intensity" label="Intensity" step={0.01} min={0} />
									<EditorInspectorNumberField
										object={defaultRenderingPipeline.glowLayer}
										property="blurKernelSize"
										label="Blur Kernel Size"
										step={1}
										min={0}
										max={512}
									/>
								</>
							)}
						</EditorInspectorSectionField>
					</>
				)}
			</>
		);
	}

	private _getCustomColorPostProcessComponent(): ReactNode {
		const postProcess = getCustomColorPostProcess();
		const configuration = serializeCustomColorPostProcess();
		const enabled = { value: !!postProcess };

		return (
			<EditorInspectorSectionField title="Custom Color Pass">
				<EditorInspectorSwitchField
					object={enabled}
					property="value"
					label="Enabled"
					noUndoRedo
					onChange={() => {
						if (enabled.value) {
							createCustomColorPostProcess(this.props.editor);
						} else {
							disposeCustomColorPostProcess();
						}
						this.forceUpdate();
					}}
				/>

				{configuration && (
					<>
						<EditorInspectorNumberField
							object={configuration.tint}
							property="0"
							label="Tint Red"
							min={0}
							max={1}
							step={0.01}
							onChange={() => parseCustomColorPostProcess(this.props.editor, configuration)}
						/>
						<EditorInspectorNumberField
							object={configuration.tint}
							property="1"
							label="Tint Green"
							min={0}
							max={1}
							step={0.01}
							onChange={() => parseCustomColorPostProcess(this.props.editor, configuration)}
						/>
						<EditorInspectorNumberField
							object={configuration.tint}
							property="2"
							label="Tint Blue"
							min={0}
							max={1}
							step={0.01}
							onChange={() => parseCustomColorPostProcess(this.props.editor, configuration)}
						/>
						<EditorInspectorNumberField
							object={configuration}
							property="tintStrength"
							label="Tint Strength"
							min={0}
							max={1}
							step={0.01}
							onChange={() => parseCustomColorPostProcess(this.props.editor, configuration)}
						/>
						<EditorInspectorNumberField
							object={configuration}
							property="saturation"
							label="Saturation"
							min={0}
							max={4}
							step={0.01}
							onChange={() => parseCustomColorPostProcess(this.props.editor, configuration)}
						/>
						<EditorInspectorNumberField
							object={configuration}
							property="contrast"
							label="Contrast"
							min={0}
							max={4}
							step={0.01}
							onChange={() => parseCustomColorPostProcess(this.props.editor, configuration)}
						/>
						<EditorInspectorNumberField
							object={configuration}
							property="brightness"
							label="Brightness"
							min={-1}
							max={1}
							step={0.01}
							onChange={() => parseCustomColorPostProcess(this.props.editor, configuration)}
						/>
					</>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getTAARenderingPipelineComponent(): ReactNode {
		const taaRenderingPipeline = getTAARenderingPipeline();

		const config = {
			enabled: taaRenderingPipeline ? true : false,
		};

		return (
			<EditorInspectorSectionField title="Temporal Anti-aliasing (TAA)">
				<EditorInspectorSwitchField
					object={config}
					property="enabled"
					label="Enabled"
					noUndoRedo
					onChange={() => {
						const pipeline = taaRenderingPipeline;
						const serializedPipeline = serializeTAARenderingPipeline();

						registerUndoRedo({
							executeRedo: true,
							undo: () => {
								if (!pipeline) {
									disposeTAARenderingPipeline();
								} else if (serializedPipeline) {
									parseTAARenderingPipeline(this.props.editor, serializedPipeline);
								}
							},
							redo: () => {
								if (pipeline) {
									disposeTAARenderingPipeline();
								} else if (serializedPipeline) {
									parseTAARenderingPipeline(this.props.editor, serializedPipeline);
								} else {
									createTAARenderingPipeline(this.props.editor);
								}
							},
						});

						this.forceUpdate();
					}}
				/>

				{taaRenderingPipeline && (
					<>
						<EditorInspectorSwitchField object={taaRenderingPipeline} property="disableOnCameraMove" label="Disable On Camera Move" />
						<EditorInspectorSwitchField object={taaRenderingPipeline} property="reprojectHistory" label="Reproject History" />
						<EditorInspectorSwitchField object={taaRenderingPipeline} property="clampHistory" label="Clamp History" />
						<EditorInspectorNumberField object={taaRenderingPipeline} property="factor" label="Factor" min={0.005} max={0.3} step={0.001} />
					</>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getSSAO2RenderingPipelineComponent(): ReactNode {
		const ssao2RenderingPipeline = getSSAO2RenderingPipeline();

		const config = {
			enabled: ssao2RenderingPipeline ? true : false,
		};

		return (
			<EditorInspectorSectionField title="SSAO2">
				<EditorInspectorSwitchField
					object={config}
					property="enabled"
					label="Enabled"
					noUndoRedo
					onChange={() => {
						const pipeline = ssao2RenderingPipeline;
						const serializedPipeline = serializeSSAO2RenderingPipeline();

						registerUndoRedo({
							executeRedo: true,
							undo: () => {
								if (!pipeline) {
									disposeSSAO2RenderingPipeline();
								} else if (serializedPipeline) {
									parseSSAO2RenderingPipeline(this.props.editor, serializedPipeline);
								}
							},
							redo: () => {
								if (pipeline) {
									disposeSSAO2RenderingPipeline();
								} else if (serializedPipeline) {
									parseSSAO2RenderingPipeline(this.props.editor, serializedPipeline);
								} else {
									createSSAO2RenderingPipeline(this.props.editor);
								}
							},
						});

						this.forceUpdate();
					}}
				/>

				{ssao2RenderingPipeline && (
					<>
						<EditorInspectorNumberField object={ssao2RenderingPipeline} property="radius" label="Radius" />
						<EditorInspectorNumberField object={ssao2RenderingPipeline} property="totalStrength" label="Total Strength" />
						<EditorInspectorNumberField object={ssao2RenderingPipeline} property="maxZ" label="Max Z" step={1} />

						<Divider />

						<EditorInspectorNumberField object={ssao2RenderingPipeline} property="minZAspect" label="Min Z Aspect" />
						<EditorInspectorNumberField object={ssao2RenderingPipeline} property="epsilon" label="epsilon" />

						<Divider />

						<EditorInspectorNumberField object={ssao2RenderingPipeline} property="bilateralSamples" label="Bilateral Samples" step={1} />
						<EditorInspectorNumberField object={ssao2RenderingPipeline} property="bilateralSoften" label="Bilateral Soften" />
						<EditorInspectorNumberField object={ssao2RenderingPipeline} property="bilateralTolerance" label="Bilateral Tolerance" />
						<EditorInspectorSwitchField object={ssao2RenderingPipeline} property="bypassBlur" label="Bypass Blur" />
						<EditorInspectorSwitchField object={ssao2RenderingPipeline} property="expensiveBlur" label="Expensive Blur" />
					</>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getMotionBlurPostProcessComponent(): ReactNode {
		const motionBlurPostProcess = getMotionBlurPostProcess();

		const config = {
			enabled: motionBlurPostProcess ? true : false,
		};

		return (
			<EditorInspectorSectionField title="Motion Blur">
				<EditorInspectorSwitchField
					object={config}
					property="enabled"
					label="Enabled"
					noUndoRedo
					onChange={() => {
						const pipeline = motionBlurPostProcess;
						const serializedPipeline = serializeMotionBlurPostProcess();

						registerUndoRedo({
							executeRedo: true,
							undo: () => {
								if (!pipeline) {
									disposeMotionBlurPostProcess();
								} else if (serializedPipeline) {
									parseMotionBlurPostProcess(this.props.editor, serializedPipeline);
								}
							},
							redo: () => {
								if (pipeline) {
									disposeMotionBlurPostProcess();
								} else if (serializedPipeline) {
									parseMotionBlurPostProcess(this.props.editor, serializedPipeline);
								} else {
									createMotionBlurPostProcess(this.props.editor);
								}
							},
						});

						this.forceUpdate();
					}}
				/>

				{motionBlurPostProcess && (
					<>
						<EditorInspectorSwitchField object={motionBlurPostProcess} property="isObjectBased" label="Object Based" />
						<EditorInspectorNumberField object={motionBlurPostProcess} property="motionStrength" label="Motion Strength" />
						<EditorInspectorNumberField object={motionBlurPostProcess} property="motionBlurSamples" label="Motion Blur Samples" min={0} step={1} />
					</>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getSSRPipelineComponent(): ReactNode {
		const ssrRenderingPipeline = getSSRRenderingPipeline();

		const config = {
			enabled: ssrRenderingPipeline ? true : false,
		};

		return (
			<EditorInspectorSectionField title="Reflections">
				<EditorInspectorSwitchField
					object={config}
					property="enabled"
					label="Enabled"
					noUndoRedo
					onChange={() => {
						const pipeline = ssrRenderingPipeline;
						const serializedPipeline = serializeSSRRenderingPipeline();

						registerUndoRedo({
							executeRedo: true,
							undo: () => {
								if (!pipeline) {
									disposeSSRRenderingPipeline();
								} else if (serializedPipeline) {
									parseSSRRenderingPipeline(this.props.editor, serializedPipeline);
								}
							},
							redo: () => {
								if (pipeline) {
									disposeSSRRenderingPipeline();
								} else if (serializedPipeline) {
									parseSSRRenderingPipeline(this.props.editor, serializedPipeline);
								} else {
									createSSRRenderingPipeline(this.props.editor);
								}
							},
						});

						this.forceUpdate();
					}}
				/>

				{ssrRenderingPipeline && (
					<>
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="step" label="Step" min={0} />
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="thickness" label="Thickness" />
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="strength" label="Strength" min={0} />
						<EditorInspectorNumberField
							object={ssrRenderingPipeline}
							property="reflectionSpecularFalloffExponent"
							label="Reflection Specular Falloff Exponent"
							min={0}
						/>
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="maxSteps" label="Max Steps" min={0} />
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="maxDistance" label="Max Distance" min={0} />

						<Divider />

						<EditorInspectorNumberField object={ssrRenderingPipeline} property="roughnessFactor" label="Roughness Factors" min={0} max={1} />
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="reflectivityThreshold" label="Reflectivity Threshold" min={0} />
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="blurDispersionStrength" label="Blur Dispersion Strength" min={0} />

						<Divider />

						<EditorInspectorSwitchField object={ssrRenderingPipeline} property="clipToFrustum" label="Clip To Frustum" />
						<EditorInspectorSwitchField object={ssrRenderingPipeline} property="enableSmoothReflections" label="Enable Smooth Reflections" />
						<EditorInspectorSwitchField object={ssrRenderingPipeline} property="enableAutomaticThicknessComputation" label="Enable Automatic Thickness Computation" />

						<EditorInspectorSwitchField object={ssrRenderingPipeline} property="attenuateFacingCamera" label="Attenuate Facing Camera" />
						<EditorInspectorSwitchField object={ssrRenderingPipeline} property="attenuateScreenBorders" label="Attenuate Screen Borders" />
						<EditorInspectorSwitchField object={ssrRenderingPipeline} property="attenuateIntersectionDistance" label="Attenuate Intersection Distance" />
						<EditorInspectorSwitchField object={ssrRenderingPipeline} property="attenuateBackfaceReflection" label="Attenuate Backface Reflection" />

						<Divider />

						<EditorInspectorNumberField object={ssrRenderingPipeline} property="blurDownsample" label="Blur Down Sample" step={1} min={1} max={5} />
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="selfCollisionNumSkip" label="Self Collision Num Skip" step={1} min={1} max={3} />
						<EditorInspectorNumberField object={ssrRenderingPipeline} property="ssrDownsample" label="SSR Down Sample" step={1} min={1} max={5} />
						<EditorInspectorNumberField
							object={ssrRenderingPipeline}
							property="backfaceDepthTextureDownsample"
							label="Backface Depth Texture Sample"
							step={1}
							min={1}
							max={5}
						/>
					</>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getVLSComponent(): ReactNode {
		const vlsPostProcess = getVLSPostProcess();

		const config = {
			enabled: vlsPostProcess ? true : false,
		};

		return (
			<EditorInspectorSectionField title="Volumetric Light Scattering">
				<EditorInspectorSwitchField
					object={config}
					property="enabled"
					label="Enabled"
					noUndoRedo
					onChange={() => {
						const pipeline = vlsPostProcess;
						const serializedPostProcess = serializeVLSPostProcess();

						registerUndoRedo({
							executeRedo: true,
							undo: () => {
								if (!pipeline) {
									disposeVLSPostProcess(this.props.editor);
								} else if (serializedPostProcess) {
									parseVLSPostProcess(this.props.editor, serializedPostProcess);
								}
							},
							redo: () => {
								if (pipeline) {
									disposeVLSPostProcess(this.props.editor);
								} else if (serializedPostProcess) {
									parseVLSPostProcess(this.props.editor, serializedPostProcess);
								} else {
									createVLSPostProcess(this.props.editor);
								}
							},
						});

						this.forceUpdate();
					}}
				/>

				{vlsPostProcess && (
					<>
						<EditorInspectorNumberField object={vlsPostProcess} property="exposure" label="Exposure" min={0} />
						<EditorInspectorNumberField object={vlsPostProcess} property="weight" label="Weight" min={0} />
						<EditorInspectorNumberField object={vlsPostProcess} property="decay" label="Decay" step={0.001} min={0} />
						<EditorInspectorNumberField object={vlsPostProcess} property="density" label="Density" step={0.001} min={0} />

						<EditorInspectorSwitchField object={vlsPostProcess} property="invert" label="Invert" />

						<EditorInspectorSwitchField object={vlsPostProcess} property="useCustomMeshPosition" label="Use Custom Mesh Position" onChange={() => this.forceUpdate()} />

						{vlsPostProcess.useCustomMeshPosition && (
							<EditorInspectorVectorField object={vlsPostProcess} property="customMeshPosition" label="Custom Mesh Position" step={1} />
						)}

						<div
							onDrop={(ev) => this._handleDropVlsMesh(ev, vlsPostProcess)}
							onDragOver={(ev) => this._handleDragOverVlsMesh(ev)}
							onDragLeave={() => this.setState({ dragOverVlsMesh: false })}
							className={`flex flex-col justify-center items-center w-full h-[64px] rounded-lg border-[1px] border-secondary-foreground/35 border-dashed ${this.state.dragOverVlsMesh ? "bg-secondary-foreground/35" : ""} transition-all duration-300 ease-in-out`}
						>
							{!vlsPostProcess.mesh && <div>Drag'n'drop a mesh here</div>}

							{vlsPostProcess.mesh && (
								<div className="flex flex-col items-center gap-2">
									<div className="flex items-center gap-2">
										<IoMdCube className="w-4 h-4" />
										{vlsPostProcess.mesh.name}
									</div>
									<div className="text-xs">Drag'n'drop a mesh here</div>
								</div>
							)}
						</div>
					</>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _handleDragOverVlsMesh(event: DragEvent<HTMLDivElement>): void {
		event.preventDefault();
		event.stopPropagation();

		this.setState({
			dragOverVlsMesh: true,
		});
	}

	private _handleDropVlsMesh(event: DragEvent<HTMLDivElement>, vlsPostProcess: VolumetricLightScatteringPostProcess): void {
		event.preventDefault();
		event.stopPropagation();

		this.setState({
			dragOverVlsMesh: false,
		});

		const eventData = event.dataTransfer.getData("graph/node");
		const node = this.props.editor.layout.graph.getSelectedNodes()[0].nodeData;

		if (eventData && node && isMesh(node)) {
			const oldMesh = vlsPostProcess.mesh;

			registerUndoRedo({
				executeRedo: true,
				undo: () => {
					vlsPostProcess.mesh = oldMesh;
					const serializationObject = serializeVLSPostProcess();
					disposeVLSPostProcess(this.props.editor);
					parseVLSPostProcess(this.props.editor, serializationObject);
				},
				redo: () => {
					vlsPostProcess.mesh = node;
					const serializationObject = serializeVLSPostProcess();
					disposeVLSPostProcess(this.props.editor);
					parseVLSPostProcess(this.props.editor, serializationObject);
				},
			});

			this.forceUpdate();
		}
	}

	// @ts-ignore
	private _getIblShadowsRenderingPipelineComponent(): ReactNode {
		const iblShadowsRenderPipeline = getIblShadowsRenderingPipeline();

		const config = {
			enabled: iblShadowsRenderPipeline ? true : false,
		};

		return (
			<EditorInspectorSectionField title="IBL Shadows">
				<EditorInspectorSwitchField
					object={config}
					property="enabled"
					label="Enabled"
					noUndoRedo
					onChange={() => {
						const pipeline = iblShadowsRenderPipeline;
						const serializedPipeline = serializeIblShadowsRenderingPipeline();

						registerUndoRedo({
							executeRedo: true,
							action: () => {
								updateAllLights(this.props.editor.layout.preview.scene);
							},
							undo: () => {
								if (!pipeline) {
									disposeIblShadowsRenderingPipeline();
								} else if (serializedPipeline) {
									parseIblShadowsRenderingPipeline(this.props.editor, serializedPipeline);
								}
							},
							redo: () => {
								if (pipeline) {
									disposeIblShadowsRenderingPipeline();
								} else if (serializedPipeline) {
									parseIblShadowsRenderingPipeline(this.props.editor, serializedPipeline);
								} else {
									createIblShadowsRenderingPipeline(this.props.editor);
								}
							},
						});

						this.forceUpdate();
					}}
				/>

				{iblShadowsRenderPipeline && (
					<>
						<EditorInspectorNumberField object={iblShadowsRenderPipeline} property="shadowRemanence" label="Shadow Remanence" min={0} max={1} />
						<EditorInspectorNumberField object={iblShadowsRenderPipeline} property="shadowOpacity" label="Shadow Opacity" min={0} max={1} />
						<EditorInspectorNumberField object={iblShadowsRenderPipeline} property="resolutionExp" label="Resolution Exponent" step={1} min={1} max={14} />
						<EditorInspectorNumberField object={iblShadowsRenderPipeline} property="sampleDirections" label="Sample Directions" step={1} min={1} max={4} />

						<Button variant="ghost" size="sm" onClick={() => updateIblShadowsRenderPipeline(this.props.editor.layout.preview.scene, true)}>
							Update voxelization
						</Button>
					</>
				)}
			</EditorInspectorSectionField>
		);
	}
}
