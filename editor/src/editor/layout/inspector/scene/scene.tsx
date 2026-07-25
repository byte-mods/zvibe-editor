import { Component, DragEvent, ReactNode } from "react";

import { IoMdCube } from "react-icons/io";
import { Divider } from "@blueprintjs/core";

import { toast } from "sonner";

import { DepthOfFieldEffectBlurLevel, Scene, TonemappingOperator, AnimationGroup, VolumetricLightScatteringPostProcess } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import { Textarea } from "../../../../ui/shadcn/ui/textarea";
import { showConfirm } from "../../../../ui/dialog";

import { isMesh } from "../../../../tools/guards/nodes";
import { isScene } from "../../../../tools/guards/scene";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { updateAllLights } from "../../../../tools/light/shadows";
import { updateIblShadowsRenderPipeline } from "../../../../tools/light/ibl";

import { getPhysicsSimulationState, validatePhysicsScene } from "../../../../mcp/physics/constraints";
import {
	clearPhysicsContactCapture,
	getPhysicsContactCapture,
	getPhysicsContactVisualization,
	setPhysicsContactVisualization,
	startPhysicsContactCapture,
	stopPhysicsContactCapture,
} from "../../../../mcp/physics/contacts";
import { getPhysicsSimulationControl, setPhysicsSimulationPaused, stepPhysicsSimulation } from "../../../../mcp/physics/simulation";
import {
	createBuildProfile,
	deleteBuildProfile,
	generatePwaManifest,
	generatePwaServiceWorker,
	installPwaServiceWorkerRegistration,
	listBuildProfiles,
	listBuildReports,
	setBuildProfile,
	validateBuildProfile,
} from "../../../../mcp/project/export";
import {
	abortProjectSourceControlIntegration,
	applyProjectSourceControlTextResolution,
	commitProjectSourceControl,
	continueProjectSourceControlIntegration,
	createProjectSourceControlBranch,
	createProjectSourceControlTag,
	deleteProjectSourceControlBranch,
	deleteProjectSourceControlRemoteBranch,
	deleteProjectSourceControlRemoteTag,
	deleteProjectSourceControlTag,
	fetchProjectSourceControl,
	getProjectSourceControlDiff,
	getProjectSourceControlHistory,
	getProjectSourceControlIntegrationState,
	getProjectSourceControlStatus,
	inspectProjectSourceControlAuthentication,
	inspectProjectSourceControlConflictDetails,
	inspectProjectSourceControlImageConflict,
	inspectProjectSourceControlRemoteRefs,
	listProjectSourceControlRefs,
	previewProjectSourceControlIntegration,
	publishProjectSourceControlRemoteBranch,
	publishProjectSourceControlRemoteTag,
	pullProjectSourceControl,
	pushProjectSourceControl,
	resolveProjectSourceControlConflict,
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
import { acquireProjectAssetLock, listProjectAssetLocks, refreshProjectAssetLock, releaseProjectAssetLock } from "../../../../mcp/project/asset-locks";
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
import {
	createPhysics2DJoint,
	createPhysics2DMaterial,
	deletePhysics2DJoint,
	deletePhysics2DMaterial,
	listPhysics2D,
	listPhysics2DJoints,
	listPhysics2DMaterials,
	setPhysics2DJoint,
	setPhysics2DMaterial,
	getPhysics2DSettings,
	setPhysics2DSettings,
} from "../../../../mcp/physics2d/physics2d";
import { get2DSceneMode, getPhysicsCollisionLayers, IPhysicsCollisionLayer, set2DSceneMode, setPhysicsCollisionLayers } from "../../../../mcp/scene/scene";
import { applyRenderingProfile, createRenderingProfile, deleteRenderingProfile, listRenderingProfiles, setRenderingProfile } from "../../../../mcp/rendering/profiles";
import { createRenderingVolume, deleteRenderingVolume, evaluateRenderingVolumes, listRenderingVolumes, setRenderingVolume } from "../../../../mcp/rendering/volumes";
import {
	createCustomRenderPass,
	deleteCustomRenderPass,
	evaluateCustomRenderPassGraph,
	listCustomRenderPasses,
	setCustomRenderPass,
} from "../../../../mcp/rendering/custom-passes";
import { createCloth, deleteCloth, listCloths, setCloth } from "../../../../mcp/cloth/cloth";
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
import {
	createLocalizationTable,
	deleteLocalizationEntry,
	deleteLocalizationTable,
	listLocalizationTables,
	pseudoLocalizeEntry,
	setLocalizationEntry,
	validateLocalization,
} from "../../../../mcp/localization/localization";
import { validateGUIAccessibility } from "../../../../mcp/gui/gui";
import { listProjectPackages, modifyProjectPackage } from "../../../../mcp/project/packages";
import {
	assignAddressableAsset,
	createAddressableGroup,
	diffAddressableCatalogs,
	listAddressableGroups,
	setAddressableAssetLabels,
} from "../../../../mcp/addressables/addressables";
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
	createAudioBus,
	createAudioMixerSnapshot,
	deleteAudioBus,
	deleteAudioMixerSnapshot,
	listAudioBuses,
	listAudioRuntimeDiagnostics,
	listAudioMixerSnapshots,
	setAudioBus,
} from "../../../../mcp/sounds/sounds";
import { applyVfxBudgetProfile, createVfxBudgetProfile, deleteVfxBudgetProfile, listVfxBudgetProfiles } from "../../../../mcp/particles/particles";
import { controlVideoPlayer, createVideoPlayer, deleteVideoPlayer, listVideoPlayers, setVideoPlayer } from "../../../../mcp/videos/videos";
import { generateInputActionWrapper, listInputActionMaps } from "../../../../mcp/input/input";
import { packSpriteAtlas, sliceSpriteSheet } from "../../../../mcp/sprites/sprites";
import { captureVisualRegressionBaseline } from "../../../../mcp/screenshot";
import { deleteProfilerCapture, getDeviceSimulation, listProfilerCaptures, setDeviceSimulation, startProfilerCapture, stopProfilerCapture } from "../../../../mcp/editor";
import { createSpriteIKController, createSpriteIKRig, deleteSpriteIKController, listSpriteIKControllers, setSpriteIKController } from "../../../../mcp/rigging/ik";

import { createVLSPostProcess, disposeVLSPostProcess, getVLSPostProcess, parseVLSPostProcess, serializeVLSPostProcess } from "../../../rendering/vls";
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

export interface IEditorSceneInspectorState {
	dragOverVlsMesh: boolean;

	animationGroupsSearch: string;
	selectedAnimationGroups: AnimationGroup[];
	physics2DJointFirstNodeId: string;
	physics2DJointSecondNodeId: string;
	spriteIKRootNodeId: string;
	spriteIKJointNodeId: string;
	spriteIKTipNodeId: string;
	spriteIKTargetNodeId: string;
	spriteIKRigName: string;
	reflectionProbeName: string;
	sceneTestName: string;
	sceneTestNodeId: string;
	visualBaselinePath: string;
	visualCandidatePath: string;
	visualTolerance: number;
	visualResult: any | null;
	localizationTables: any[];
	localizationError: string | null;
	localizationTableName: string;
	localizationFallbackLocale: string;
	localizationSelectedTable: string;
	localizationKey: string;
	localizationLocale: string;
	localizationValue: string;
	pseudoLocalizationValue: string | null;
	localizationValidation: any | null;
	guiAccessibilityValidation: any | null;
	physicsContactCapture: any | null;
	projectPackages: any | null;
	projectPackagesError: string | null;
	packageName: string;
	packageVersion: string;
	packageBusy: boolean;
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
	sourceControlBusy: boolean;
	sourceControlResult: string | null;
	assetLocks: any[];
	assetLockPath: string;
	assetLockOwner: string;
	assetLockNote: string;
	assetLockError: string | null;
	assetLockBusy: boolean;
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
	videoPlayerMaterialId: string;
	vfxBudgetProfileName: string;
	vfxCapacityScale: number;
	vfxEmissionScale: number;
	vfxMaxCapacity: number;
	addressableConfig: any | null;
	addressableGroupName: string;
	addressableAssetPath: string;
	addressableLabels: string;
	addressableError: string | null;
	addressablePreviousCatalogPath: string;
	addressableNextCatalogPath: string;
	addressableDiff: any | null;
	inputWrapperMapName: string;
	inputWrapperSource: string;
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
	profilerCaptureName: string;
	performanceBudgetName: string;
	performanceBudgetMetric: string;
	performanceBudgetLimit: number;
}

export class EditorSceneInspector extends Component<IEditorInspectorImplementationProps<Scene>, IEditorSceneInspectorState> {
	private _collaborationHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

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
			physics2DJointFirstNodeId: "",
			physics2DJointSecondNodeId: "",
			spriteIKRootNodeId: "",
			spriteIKJointNodeId: "",
			spriteIKTipNodeId: "",
			spriteIKTargetNodeId: "",
			spriteIKRigName: "Sprite Rig",
			reflectionProbeName: "Reflection Probe",
			sceneTestName: "Scene Test",
			sceneTestNodeId: "",
			visualBaselinePath: "",
			visualCandidatePath: "",
			visualTolerance: 0,
			visualResult: null,
			localizationTables: [],
			localizationError: null,
			localizationTableName: "Strings",
			localizationFallbackLocale: "en",
			localizationSelectedTable: "",
			localizationKey: "",
			localizationLocale: "en",
			localizationValue: "",
			pseudoLocalizationValue: null,
			localizationValidation: null,
			guiAccessibilityValidation: null,
			physicsContactCapture: null,
			projectPackages: null,
			projectPackagesError: null,
			packageName: "",
			packageVersion: "",
			packageBusy: false,
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
			sourceControlBusy: false,
			sourceControlResult: null,
			assetLocks: [],
			assetLockPath: "assets/",
			assetLockOwner: "Editor User",
			assetLockNote: "",
			assetLockError: null,
			assetLockBusy: false,
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
			videoPlayerMaterialId: "",
			vfxBudgetProfileName: "VFX Quality",
			vfxCapacityScale: 1,
			vfxEmissionScale: 1,
			vfxMaxCapacity: 1000,
			addressableConfig: null,
			addressableGroupName: "Content",
			addressableAssetPath: "",
			addressableLabels: "",
			addressableError: null,
			addressablePreviousCatalogPath: "assets/addressables.previous.catalog.json",
			addressableNextCatalogPath: "assets/addressables.catalog.json",
			addressableDiff: null,
			inputWrapperMapName: "",
			inputWrapperSource: "",
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
			profilerCaptureName: "Profiler Capture",
			performanceBudgetName: "Performance Budget",
			performanceBudgetMetric: "drawCalls",
			performanceBudgetLimit: 100,
		};
	}

	public componentDidMount(): void {
		this._refreshSourceControlStatus();
		this._refreshSourceControlHistory();
		this._refreshSourceControlRefs();
		this._refreshSourceControlIntegration();
		this._refreshSourceControlIntegration();
		void this._refreshAssetLocks();
		void this._refreshProjectChangelists();
		void this._refreshProjectCollaboration();
		void this._refreshSemanticMergeRules();
		void this._refreshLocalizationTables();
		void this._refreshProjectPackages();
		void this._refreshAddressables();
		void this._refreshScriptTemplates();
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

				{this._getPhysicsComponent()}
				{this._getPhysicsCollisionLayersComponent()}
				{this._getPhysics2DMaterialsComponent()}
				{this._getPhysics2DSettingsComponent()}
				{this._getPhysics2DJointsComponent()}
				{this._getSpriteIKComponent()}
				{this._getClothsComponent()}
				{this._getLightingScenariosComponent()}
				{this._getReflectionProbesComponent()}
				{this._getDeviceSimulationComponent()}
				{this._getProfilerCapturesComponent()}
				{this._getPerformanceBudgetsComponent()}
				{this._getSceneTestsComponent()}
				{this._getVisualRegressionComponent()}
				{this._getLocalizationComponent()}
				{this._getGUIAccessibilityComponent()}
				{this._getPackageManagerComponent()}
				{this._getScriptTemplatesComponent()}
				{this._getProjectScriptExecutionOrdersComponent()}
				{this._getAudioMixerComponent()}
				{this._getAudioRuntimeDiagnosticsComponent()}
				{this._getVideoPlayersComponent()}
				{this._getVfxBudgetProfilesComponent()}
				{this._getAddressablesComponent()}
				{this._getInputWrapperComponent()}
				{this._getSpriteAtlasPackerComponent()}
				{this._getSpriteSheetSlicerComponent()}
				{this._get2DSceneModeComponent()}
				{this._getBuildProfilesComponent()}
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
				{this._getRenderingProfilesComponent()}
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

	private _runPerformanceBudget(id: string): void {
		try {
			runPerformanceBudgets(this.props.object, { id }, { editor: this.props.editor });
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
										<span className="truncate">
											{assertion.type === "node-enabled" ? `Enabled = ${assertion.equals}` : `Position = [${assertion.equals.join(", ")}]`}
										</span>
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

	private _runSceneTests(id?: string): void {
		try {
			runSceneTests(this.props.object, id ? { id } : {}, { editor: this.props.editor });
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
		return (
			<EditorInspectorSectionField
				title="GUI Accessibility"
				tooltip="Read-only audit for basic fullscreen GUI readability and labeling concerns. It checks duplicate control names, text below 12px, unlabeled interactive controls, and explicit foreground/background contrast."
			>
				<Button size="sm" variant="secondary" className="w-full" onClick={() => this._validateGUIAccessibility()}>
					Audit Fullscreen GUIs
				</Button>
				{validation && (
					<div className="space-y-1 text-xs">
						<div className={validation.warningCount ? "text-amber-400" : "text-green-400"}>
							{validation.guiCount} GUIs · {validation.controlCount} controls · {validation.warningCount} warnings
						</div>
						{validation.issues.slice(0, 8).map((issue: any, index: number) => (
							<div key={`${issue.path}-${issue.code}-${index}`} className="rounded bg-input px-2 py-1 text-muted-foreground">
								{issue.path}: {issue.message}
							</div>
						))}
						{validation.issues.length > 8 && <div className="text-muted-foreground">+{validation.issues.length - 8} additional warnings</div>}
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	private _getLocalizationComponent(): ReactNode {
		const selected = this.state.localizationTables.find((table) => table.name === this.state.localizationSelectedTable) ?? this.state.localizationTables[0] ?? null;
		return (
			<EditorInspectorSectionField
				title="Localization"
				tooltip="Project localization tables persist to localization.json and export with the game. The same tables are available through MCP."
			>
				<div className="flex flex-col gap-2">
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
					{this.state.localizationError && <div className="text-xs text-red-400">{this.state.localizationError}</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _refreshLocalizationTables(): Promise<void> {
		try {
			const data = await listLocalizationTables();
			this.setState((state) => ({
				localizationTables: data.tables ?? [],
				localizationSelectedTable: state.localizationSelectedTable || data.tables?.[0]?.name || "",
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
				{ name: this.state.localizationTableName.trim(), fallbackLocale: this.state.localizationFallbackLocale.trim() },
				{ editor: this.props.editor }
			);
			await this._refreshLocalizationTables();
			this.setState({ localizationSelectedTable: table.name });
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not create localization table." });
		}
	}

	private async _deleteLocalizationTable(name: string): Promise<void> {
		try {
			await deleteLocalizationTable(this.props.object, { name }, { editor: this.props.editor });
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
				{ name, key: this.state.localizationKey.trim(), locale: this.state.localizationLocale.trim(), value: this.state.localizationValue },
				{ editor: this.props.editor }
			);
			await this._refreshLocalizationTables();
		} catch (error) {
			this.setState({ localizationError: error instanceof Error ? error.message : "Could not save localization entry." });
		}
	}

	private async _deleteLocalizationEntry(name: string, key: string, locale: string): Promise<void> {
		try {
			await deleteLocalizationEntry(this.props.object, { name, key, locale }, { editor: this.props.editor });
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

	private _getPackageManagerComponent(): ReactNode {
		const packages = this.state.projectPackages;
		const dependencies = Object.entries({ ...(packages?.dependencies ?? {}), ...(packages?.devDependencies ?? {}) }) as [string, string][];
		return (
			<EditorInspectorSectionField
				title="Package Manager"
				tooltip="Direct project dependencies managed with the project's configured yarn, npm, or bun command. Installing, updating, or removing is performed only after you click the relevant button."
			>
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>{packages ? `${packages.name ?? "Project"} · ${packages.packageManager}` : "Loading packages…"}</span>
						<Button size="sm" variant="secondary" className="h-7 px-2" disabled={this.state.packageBusy} onClick={() => void this._refreshProjectPackages()}>
							Refresh
						</Button>
					</div>
					<div className="grid grid-cols-[minmax(0,1fr)_6rem_auto] gap-2">
						<Input
							value={this.state.packageName}
							aria-label="Package name"
							onChange={(event) => this.setState({ packageName: event.currentTarget.value })}
							placeholder="package-name"
						/>
						<Input
							value={this.state.packageVersion}
							aria-label="Package version"
							onChange={(event) => this.setState({ packageVersion: event.currentTarget.value })}
							placeholder="version"
						/>
						<Button
							size="sm"
							disabled={this.state.packageBusy || !this.state.packageName.trim()}
							onClick={() => void this._modifyProjectPackage("install", this.state.packageName, this.state.packageVersion)}
						>
							Install
						</Button>
					</div>
					{dependencies.slice(0, 30).map(([name, version]) => (
						<div key={name} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded bg-input px-2 py-1 text-xs">
							<span className="truncate">{name}</span>
							<span className="text-muted-foreground">{version}</span>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 px-1"
								disabled={this.state.packageBusy}
								onClick={() => void this._modifyProjectPackage("update", name)}
							>
								Update
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 px-1 !text-red-400"
								disabled={this.state.packageBusy}
								onClick={() => void this._modifyProjectPackage("remove", name)}
							>
								Remove
							</Button>
						</div>
					))}
					{dependencies.length > 30 && <div className="text-xs text-muted-foreground">…and {dependencies.length - 30} more direct dependencies.</div>}
					{this.state.projectPackagesError && <div className="text-xs text-red-400">{this.state.projectPackagesError}</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _refreshProjectPackages(): Promise<void> {
		try {
			const projectPackages = await listProjectPackages(this.props.object, {}, { editor: this.props.editor });
			this.setState({ projectPackages, projectPackagesError: null });
		} catch (error) {
			this.setState({ projectPackages: null, projectPackagesError: error instanceof Error ? error.message : "Could not list project packages." });
		}
	}

	private async _modifyProjectPackage(operation: "install" | "remove" | "update", name: string, version?: string): Promise<void> {
		this.setState({ packageBusy: true, projectPackagesError: null });
		try {
			const projectPackages = await modifyProjectPackage(
				this.props.object,
				{ operation, name, ...(version?.trim() ? { version: version.trim() } : {}) },
				{ editor: this.props.editor }
			);
			this.setState({
				projectPackages,
				packageName: operation === "install" ? "" : this.state.packageName,
				packageVersion: operation === "install" ? "" : this.state.packageVersion,
			});
		} catch (error) {
			this.setState({ projectPackagesError: error instanceof Error ? error.message : "Package operation failed." });
		} finally {
			this.setState({ packageBusy: false });
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
		const scenarios = listLightingScenarios(this.props.object).scenarios as any[];
		return (
			<EditorInspectorSectionField
				title="Lighting Scenarios"
				tooltip="Reusable realtime light snapshots. Apply a scenario instantly through MCP or cross-fade light transforms, colors, and intensity in preview/exported games."
			>
				<Button size="sm" variant="secondary" className="w-full" onClick={() => this._createLightingScenario()}>
					Capture Current Lights
				</Button>
				{!scenarios.length && <div className="px-2 text-xs text-muted-foreground">No scenarios saved. Capture the current realtime lights to create one.</div>}
				{scenarios.map((scenario) => (
					<div key={scenario.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1 rounded bg-input px-2 py-1 text-xs">
						<span className="truncate">
							{scenario.name} · {scenario.lights.length} lights
						</span>
						<Button size="sm" variant="secondary" onClick={() => this._blendLightingScenario(scenario, 0)}>
							Apply
						</Button>
						<Button size="sm" variant="ghost" onClick={() => this._blendLightingScenario(scenario, 1000)}>
							Blend 1s
						</Button>
						<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteLightingScenario(scenario.id)}>
							×
						</Button>
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

	private _deleteLightingScenario(id: string): void {
		try {
			deleteLightingScenario(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getReflectionProbesComponent(): ReactNode {
		const probes = listReflectionProbes(this.props.object).probes as any[];
		const meshes = this.props.object.meshes;
		return (
			<EditorInspectorSectionField
				title="Reflection Probes"
				tooltip="Realtime cubemap reflection captures. Changes use the same persisted MCP reflection-probe actions available to Codex and Claude."
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
						<div key={probe.name} className="flex flex-col gap-2 rounded-lg bg-input p-2">
							<div className="flex items-center justify-between gap-2">
								<div className="truncate font-medium">{probe.name}</div>
								<Button size="sm" variant="ghost" className="h-7 px-2 !text-red-400" onClick={() => this._deleteReflectionProbe(probe.name)}>
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
									Refresh Rate
									<input
										type="number"
										min={0}
										defaultValue={String(probe.refreshRate)}
										onBlur={(event) => this._setReflectionProbeNumber(probe.name, "refreshRate", event.currentTarget.value)}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									Samples
									<input
										type="number"
										min={0}
										defaultValue={String(probe.samples)}
										onBlur={(event) => this._setReflectionProbeNumber(probe.name, "samples", event.currentTarget.value)}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
							</div>
							<label className="flex flex-col gap-1 text-xs">
								Attach to Mesh
								<select
									value={probe.attachedMeshId ?? ""}
									onChange={(event) => this._setReflectionProbe(probe.name, { attachedMeshId: event.currentTarget.value || null })}
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
								<div>Capture Render List ({probe.renderList?.length ?? meshes.length})</div>
								{meshes.map((mesh) => {
									const selected = probe.renderList?.includes(mesh.id) ?? false;
									return (
										<label key={mesh.id} className="flex items-center gap-2">
											<input type="checkbox" checked={selected} onChange={() => this._toggleReflectionProbeRenderMesh(probe, mesh.id)} />
											<span className="truncate">{mesh.name}</span>
										</label>
									);
								})}
								{!meshes.length && <div className="text-muted-foreground">No meshes in this scene.</div>}
							</div>
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

	private _setReflectionProbe(name: string, update: any): void {
		try {
			setReflectionProbe(this.props.object, { name, ...update }, { editor: this.props.editor });
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
		this._setReflectionProbe(probe.name, { position });
	}

	private _setReflectionProbeNumber(name: string, property: "refreshRate" | "samples", value: string): void {
		const number = Number(value);
		if (Number.isInteger(number) && number >= 0) {
			this._setReflectionProbe(name, { [property]: number });
		}
	}

	private _toggleReflectionProbeRenderMesh(probe: any, meshId: string): void {
		const current = probe.renderList ?? [];
		this._setReflectionProbe(probe.name, { renderListIds: current.includes(meshId) ? current.filter((id: string) => id !== meshId) : [...current, meshId] });
	}

	private _deleteReflectionProbe(name: string): void {
		try {
			deleteReflectionProbe(this.props.object, { name }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not remove reflection probe.");
		}
	}

	private _getPhysicsComponent(): ReactNode {
		const physicsEngine = this.props.editor.layout.preview.scene.getPhysicsEngine();
		if (!physicsEngine) {
			return null;
		}

		const o = {
			gravity: physicsEngine.gravity.clone(),
		};
		const activeCapture = getPhysicsContactCapture(this.props.object);
		const capture = activeCapture.active ? activeCapture : this.state.physicsContactCapture;
		const simulationControl = getPhysicsSimulationControl(this.props.object);
		const contactVisualization = getPhysicsContactVisualization(this.props.object);

		return (
			<EditorInspectorSectionField title="Physics">
				<EditorInspectorVectorField
					noUndoRedo
					object={o}
					property="gravity"
					label="Gravity"
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
					Inspect Simulation State
				</Button>
				<div className="grid grid-cols-3 gap-1">
					<Button size="sm" variant="secondary" onClick={() => this._setPhysicsSimulationPaused(!simulationControl.paused)}>
						{simulationControl.paused ? "Resume Physics" : "Pause Physics"}
					</Button>
					<Button size="sm" variant="ghost" disabled={!simulationControl.paused} onClick={() => this._stepPhysicsSimulation(1)}>
						Step 1
					</Button>
					<Button size="sm" variant="ghost" disabled={!simulationControl.paused} onClick={() => this._stepPhysicsSimulation(10)}>
						Step 10
					</Button>
				</div>
				{simulationControl.totalManualSteps > 0 && (
					<div className="px-2 text-xs text-muted-foreground">
						{simulationControl.totalManualSteps} manual steps · {simulationControl.totalManualSeconds.toFixed(3)}s simulated
					</div>
				)}
				{activeCapture.active ? (
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
				)}
				<Button
					size="sm"
					variant={contactVisualization.enabled ? "default" : "ghost"}
					className="w-full"
					onClick={() => this._setPhysicsContactVisualization(!contactVisualization.enabled)}
				>
					{contactVisualization.enabled ? `Contact Vectors On · ${contactVisualization.activeOverlayCount} visible` : "Show Contact Vectors"}
				</Button>
				{capture && (
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

	private _getBuildProfilesComponent(): ReactNode {
		const profiles = listBuildProfiles(this.props.object).profiles;
		return (
			<EditorInspectorSectionField
				title="Build Profiles"
				tooltip="Persisted web/Electron export profiles. Validate checks the current project's required package scripts before running a target build through MCP."
			>
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
				{profiles.map((profile: any) => (
					<div key={profile.name} className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
						<div className="flex justify-between items-center gap-2">
							<div className="min-w-0">
								<div className="truncate">{profile.name}</div>
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
								<Button size="sm" variant="secondary" onClick={() => this._validateBuildProfile(profile.name)}>
									Validate
								</Button>
								<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteBuildProfile(profile.name)}>
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
							placeholder="Output directory (used by your build script)"
							onChange={(event) => this._setBuildProfileSetting(profile, "outputDirectory", event.target.value)}
						/>
						{profile.target === "web" && (
							<div className="space-y-2 rounded-md border border-input p-2">
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
										onChange={(event) => this._setBuildProfileSetting(profile, "pwa", { ...(profile.settings?.pwa ?? {}), manifestPath: event.target.value })}
									/>
									<Button size="sm" variant="secondary" onClick={() => void this._generatePwaManifest(profile.name)}>
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
									<Button size="sm" variant="secondary" onClick={() => void this._generatePwaServiceWorker(profile.name)}>
										Generate Service Worker
									</Button>
									<Button size="sm" variant="secondary" onClick={() => void this._installPwaServiceWorkerRegistration(profile.name)}>
										Install Registration
									</Button>
								</div>
							</div>
						)}
						{profile.target === "electron" && (
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
						)}
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _getBuildReportsComponent(): ReactNode {
		const reports = listBuildReports(this.props.object).reports as any[];
		return (
			<EditorInspectorSectionField
				title="Build Reports"
				tooltip="The 20 latest export/build reports, including failed attempts, stored with this scene. Detailed reports are also available through MCP."
			>
				{reports.length === 0 && <div className="px-2 text-sm text-muted-foreground">No export or build reports recorded yet.</div>}
				{reports.slice(0, 5).map((report) => (
					<div key={report.id} className={`space-y-1 rounded-lg p-2 text-xs ${report.outcome === "failed" ? "bg-destructive/10" : "bg-muted-foreground/10"}`}>
						<div className="flex justify-between gap-2">
							<span className="font-medium">{report.profile ?? "Active scene export"}</span>
							<span className={report.outcome === "failed" ? "text-destructive" : "text-muted-foreground"}>{report.outcome ?? "exported"}</span>
						</div>
						<div className="text-muted-foreground">
							{report.output?.fileCount ?? 0} files · {this._formatBuildBytes(report.output?.totalBytes ?? 0)} · {new Date(report.createdAt).toLocaleString()}
						</div>
						{report.commands?.length > 0 && <div className="truncate text-muted-foreground">{report.commands.join("; ")}</div>}
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
					}}
				>
					Refresh Git Status
				</Button>
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
				<div className="grid grid-cols-2 gap-2">
					<Input
						className="col-span-2"
						value={this.state.assetLockPath}
						onChange={(event) => this.setState({ assetLockPath: event.target.value })}
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
				<div className="grid grid-cols-2 gap-2">
					<Button size="sm" disabled={this.state.assetLockBusy} onClick={() => void this._acquireAssetLock()}>
						Acquire 30m Lock
					</Button>
					<Button size="sm" variant="secondary" disabled={this.state.assetLockBusy} onClick={() => void this._refreshAssetLocks()}>
						Refresh Locks
					</Button>
				</div>
				{this.state.assetLockError && <div className="px-2 text-xs text-destructive">{this.state.assetLockError}</div>}
				{this.state.assetLocks.length === 0 && <div className="px-2 text-xs text-muted-foreground">No active project asset locks.</div>}
				{this.state.assetLocks.map((lock) => (
					<div key={lock.lockId} className="space-y-1 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="flex justify-between gap-2">
							<span className="truncate font-medium" title={lock.path}>
								{lock.path}
							</span>
							<span className="shrink-0 text-muted-foreground">{lock.owner}</span>
						</div>
						<div className="text-muted-foreground">
							Expires {new Date(lock.expiresAt).toLocaleString()}
							{lock.memberId ? ` · federated${lock.clientName ? ` via ${lock.clientName}` : ""}` : ""}
							{lock.note ? ` · ${lock.note}` : ""}
						</div>
						<div className="grid grid-cols-2 gap-2">
							<Button
								size="sm"
								variant="secondary"
								disabled={this.state.assetLockBusy || !lock.canManage || !lock.lockId}
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

	private async _acquireAssetLock(): Promise<void> {
		this.setState({ assetLockBusy: true, assetLockError: null });
		try {
			const result = await acquireProjectAssetLock(
				this.props.object,
				{
					path: this.state.assetLockPath,
					owner: this.state.assetLockOwner || undefined,
					note: this.state.assetLockNote,
					ttlSeconds: 1800,
					collaborationToken: this.state.collaborationToken || undefined,
				},
				{ editor: this.props.editor }
			);
			if (!result.acquired) {
				throw new Error(`${result.conflict.path} is locked by ${result.conflict.owner} until ${new Date(result.conflict.expiresAt).toLocaleString()}.`);
			}
			toast.success(result.reused ? "Asset lock renewed." : "Asset lock acquired.");
			await this._refreshAssetLocks();
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

	private _getPhysics2DSettingsComponent(): ReactNode {
		const physicsSettings = getPhysics2DSettings(this.props.object);
		return (
			<EditorInspectorSectionField title="2D Physics Settings" tooltip="Solver iterations improve the stability of 2D contacts and joints at additional CPU cost.">
				<div className="flex items-center justify-between gap-2 px-2 text-sm">
					<span>Solver Iterations</span>
					<Input
						type="number"
						min="1"
						max="16"
						step="1"
						defaultValue={String(physicsSettings.solverIterations)}
						onBlur={(event) => this._setPhysics2DSolverIterations(event.target.value)}
						aria-label="2D physics solver iterations"
					/>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _setPhysics2DSolverIterations(value: string): void {
		const solverIterations = Number(value);
		if (!Number.isInteger(solverIterations)) {
			return;
		}
		try {
			setPhysics2DSettings(this.props.object, { solverIterations }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getPhysics2DJointsComponent(): ReactNode {
		const bodies = listPhysics2D(this.props.object).bodies as any[];
		const joints = listPhysics2DJoints(this.props.object).joints as any[];
		const firstNodeId = this.state.physics2DJointFirstNodeId || bodies[0]?.nodeId || "";
		const secondNodeId = this.state.physics2DJointSecondNodeId || bodies.find((body) => body.nodeId !== firstNodeId)?.nodeId || "";
		const name = (nodeId: string): string => this.props.object.getNodeById(nodeId)?.name ?? nodeId;
		return (
			<EditorInspectorSectionField
				title="2D Joints"
				tooltip="Connect two authored 2D bodies. Hinge joints maintain a shared pivot; angular limits are available through the joint MCP tool."
			>
				{bodies.length < 2 ? (
					<div className="px-2 text-sm text-muted-foreground">Add 2D Physics bodies to at least two scene nodes before creating a joint.</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-2">
							<select
								className="h-9 rounded-md border border-input bg-background px-2 text-sm"
								value={firstNodeId}
								onChange={(event) => this.setState({ physics2DJointFirstNodeId: event.target.value })}
							>
								{bodies.map((body) => (
									<option key={body.nodeId} value={body.nodeId}>
										{name(body.nodeId)}
									</option>
								))}
							</select>
							<select
								className="h-9 rounded-md border border-input bg-background px-2 text-sm"
								value={secondNodeId}
								onChange={(event) => this.setState({ physics2DJointSecondNodeId: event.target.value })}
							>
								{bodies.map((body) => (
									<option key={body.nodeId} value={body.nodeId} disabled={body.nodeId === firstNodeId}>
										{name(body.nodeId)}
									</option>
								))}
							</select>
						</div>
						<div className="grid grid-cols-3 gap-2">
							<Button
								size="sm"
								variant="secondary"
								disabled={!firstNodeId || !secondNodeId || firstNodeId === secondNodeId}
								onClick={() => this._createPhysics2DJoint("distance", firstNodeId, secondNodeId)}
							>
								Add Distance
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={!firstNodeId || !secondNodeId || firstNodeId === secondNodeId}
								onClick={() => this._createPhysics2DJoint("fixed", firstNodeId, secondNodeId)}
							>
								Add Fixed
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={!firstNodeId || !secondNodeId || firstNodeId === secondNodeId}
								onClick={() => this._createPhysics2DJoint("hinge", firstNodeId, secondNodeId)}
							>
								Add Hinge
							</Button>
						</div>
					</>
				)}
				{joints.map((joint) => (
					<div key={joint.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<div className="min-w-0">
							<div className="font-medium capitalize">
								{joint.type} · {name(joint.firstNodeId)} → {name(joint.secondNodeId)}
							</div>
							<div className="truncate text-muted-foreground">
								{joint.type === "hinge"
									? `Pivot [${joint.firstAnchor?.map((value: number) => value.toFixed(1)).join(", ") ?? "0, 0"}]`
									: `Distance ${joint.distance?.toFixed?.(1) ?? joint.distance}`}
							</div>
							{joint.type === "hinge" && (
								<div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
									<label>
										Motor rad/s
										<Input
											type="number"
											step="0.1"
											defaultValue={String(joint.motorSpeed ?? 0)}
											onBlur={(event) => this._setPhysics2DJointNumber(joint, "motorSpeed", event.target.value)}
											aria-label="2D hinge motor speed"
										/>
									</label>
									<label>
										Motor authority
										<Input
											type="number"
											min="0"
											step="1"
											defaultValue={String(joint.maxMotorTorque ?? 10000)}
											onBlur={(event) => this._setPhysics2DJointNumber(joint, "maxMotorTorque", event.target.value)}
											aria-label="2D hinge motor authority"
										/>
									</label>
								</div>
							)}
						</div>
						<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deletePhysics2DJoint(joint.id)}>
							Remove
						</Button>
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _createPhysics2DJoint(type: "distance" | "fixed" | "hinge", firstNodeId: string, secondNodeId: string): void {
		try {
			createPhysics2DJoint(this.props.object, { type, firstNodeId, secondNodeId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deletePhysics2DJoint(id: string): void {
		try {
			deletePhysics2DJoint(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setPhysics2DJointNumber(joint: any, property: "motorSpeed" | "maxMotorTorque", value: string): void {
		const number = Number(value);
		if (!Number.isFinite(number)) {
			return;
		}
		try {
			setPhysics2DJoint(this.props.object, { id: joint.id, [property]: number }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
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
		return (
			<EditorInspectorSectionField
				title="Cloth Physics"
				tooltip="Persistent gridded cloth meshes with editor and exported-runtime simulation. Local collision planes, spheres, and boxes are authored here through the same MCP configuration used by exported games."
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
									variant="ghost"
									disabled={!(cloth.collisionSpheres?.length || cloth.collisionBoxes?.length)}
									onClick={() => this._clearClothVolumes(cloth)}
								>
									Clear Volumes
								</Button>
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
		const update = (values: any): void => {
			try {
				setDeviceSimulation(this.props.object, values, { editor: this.props.editor });
				this.forceUpdate();
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Could not update device simulation.");
			}
		};
		return (
			<EditorInspectorSectionField
				title="Device Simulator"
				tooltip="Resizes the actual editor preview engine view to a target resolution and shows its safe area. This is preview tooling, not an Android/iOS build pipeline."
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
					<Button
						size="sm"
						variant="secondary"
						onClick={() => update({ enabled: true, width: 1170, height: 2532, dpi: 460, orientation: "portrait", safeArea: [132, 0, 102, 0] })}
					>
						iPhone 13 Preset
					</Button>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _getProfilerCapturesComponent(): ReactNode {
		const captures = listProfilerCaptures(this.props.object).captures as any[];
		return (
			<EditorInspectorSectionField
				title="Profiler Captures"
				tooltip="Bounded samples of preview frame timing, draw calls, mesh, vertex, and resource metrics. Captures persist with the scene after stopping."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
						<Input
							value={this.state.profilerCaptureName}
							aria-label="Profiler capture name"
							onChange={(event) => this.setState({ profilerCaptureName: event.currentTarget.value })}
						/>
						<Button size="sm" disabled={!this.state.profilerCaptureName.trim()} onClick={() => this._startProfilerCapture()}>
							Start
						</Button>
					</div>
					{captures.map((capture) => (
						<div key={capture.id} className="rounded-lg bg-input p-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate font-medium">{capture.name}</span>
								<div className="flex gap-1">
									{capture.active && (
										<Button size="sm" variant="secondary" onClick={() => this._stopProfilerCapture(capture.id)}>
											Stop
										</Button>
									)}
									<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteProfilerCapture(capture.id)}>
										Remove
									</Button>
								</div>
							</div>
							<div className="text-muted-foreground">
								{capture.active ? "Recording" : "Stopped"} · {capture.sampleCount} samples ·{" "}
								{capture.summary.frameTimeMs ? `${capture.summary.frameTimeMs.average.toFixed(2)} ms avg` : "waiting for samples"}
							</div>
						</div>
					))}
					{!captures.length && <div className="px-2 text-xs text-muted-foreground">No captures. Start the preview, then record a bounded metrics history.</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _startProfilerCapture(): void {
		try {
			startProfilerCapture(this.props.object, { name: this.state.profilerCaptureName.trim() }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not start profiler capture.");
		}
	}

	private _stopProfilerCapture(id: string): void {
		try {
			stopProfilerCapture(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not stop profiler capture.");
		}
	}

	private _deleteProfilerCapture(id: string): void {
		try {
			deleteProfilerCapture(this.props.object, { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not remove profiler capture.");
		}
	}

	private _getVideoPlayersComponent(): ReactNode {
		const players = listVideoPlayers(this.props.object).players as any[];
		const materials = this.props.object.materials.filter((material) => Boolean(material.id));
		const materialId = this.state.videoPlayerMaterialId || materials[0]?.id || "";
		return (
			<EditorInspectorSectionField
				title="Video Players"
				tooltip="Persistent browser-video players. The selected material receives a VideoTexture in the editor preview and exported game; muted autoplay is enabled by default for browser policy compatibility."
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
							disabled={!this.state.videoPlayerName.trim() || !this.state.videoPlayerPath.trim() || !materialId}
							onClick={() => this._createVideoPlayer(materialId)}
						>
							Create
						</Button>
					</div>
					<Input
						value={this.state.videoPlayerPath}
						aria-label="Video asset path"
						onChange={(event) => this.setState({ videoPlayerPath: event.currentTarget.value })}
						placeholder="assets/video.webm"
					/>
					<select
						className="h-8 rounded bg-input px-2 text-sm"
						value={materialId}
						onChange={(event) => this.setState({ videoPlayerMaterialId: event.currentTarget.value })}
					>
						{materials.length === 0 && <option value="">Create a material first</option>}
						{materials.map((material) => (
							<option key={material.id} value={material.id}>
								{material.name}
							</option>
						))}
					</select>
					{players.map((player) => (
						<div key={player.id} className="flex flex-col gap-1 rounded-lg bg-input p-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate font-medium">{player.name}</span>
								<Button size="sm" variant="ghost" className="h-6 px-1 !text-red-400" onClick={() => this._deleteVideoPlayer(player.id)}>
									Remove
								</Button>
							</div>
							<span className="truncate text-muted-foreground">
								{player.path} → {this.props.object.getMaterialById(player.materialId)?.name ?? player.materialId}.{player.textureSlot}
							</span>
							<div className="flex items-center gap-3">
								<Button size="sm" variant="secondary" onClick={() => this._controlVideoPlayer(player.id, "play")}>
									Play
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._controlVideoPlayer(player.id, "pause")}>
									Pause
								</Button>
								<label className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={player.autoPlay}
										onChange={(event) => this._setVideoPlayer(player.id, { autoPlay: event.currentTarget.checked })}
									/>{" "}
									autoplay
								</label>
								<label className="flex items-center gap-1">
									<input type="checkbox" checked={player.loop} onChange={(event) => this._setVideoPlayer(player.id, { loop: event.currentTarget.checked })} />{" "}
									loop
								</label>
								<label className="flex items-center gap-1">
									<input type="checkbox" checked={player.muted} onChange={(event) => this._setVideoPlayer(player.id, { muted: event.currentTarget.checked })} />{" "}
									muted
								</label>
							</div>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createVideoPlayer(materialId: string): void {
		try {
			createVideoPlayer(this.props.object, { name: this.state.videoPlayerName.trim(), path: this.state.videoPlayerPath.trim(), materialId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create video player.");
		}
	}

	private _setVideoPlayer(id: string, update: any): void {
		try {
			setVideoPlayer(this.props.object, { id, ...update }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update video player.");
		}
	}

	private async _controlVideoPlayer(id: string, action: "play" | "pause"): Promise<void> {
		try {
			await controlVideoPlayer(this.props.object, { id, action });
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
		const groups = this.state.addressableConfig?.groups ?? [];
		return (
			<EditorInspectorSectionField
				title="Addressables"
				tooltip="Persisted addressable groups, asset labels, hashes, and exported catalog entries. Asset paths are project-relative."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
						<Input
							value={this.state.addressableGroupName}
							aria-label="Addressable group name"
							onChange={(event) => this.setState({ addressableGroupName: event.currentTarget.value })}
							placeholder="Group name"
						/>
						<Button size="sm" disabled={!this.state.addressableGroupName.trim()} onClick={() => void this._createAddressableGroup()}>
							Create Group
						</Button>
					</div>
					<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
						<select
							className="h-8 min-w-0 rounded bg-input px-2 text-sm"
							value={this.state.addressableGroupName}
							onChange={(event) => this.setState({ addressableGroupName: event.currentTarget.value })}
						>
							{groups.map((group: any) => (
								<option key={group.id} value={group.name}>
									{group.name}
								</option>
							))}
						</select>
						<Input
							value={this.state.addressableAssetPath}
							aria-label="Addressable asset path"
							onChange={(event) => this.setState({ addressableAssetPath: event.currentTarget.value })}
							placeholder="assets/hero.glb"
						/>
						<Input
							value={this.state.addressableLabels}
							aria-label="Addressable asset labels"
							onChange={(event) => this.setState({ addressableLabels: event.currentTarget.value })}
							placeholder="character, featured"
						/>
						<Button
							size="sm"
							disabled={!this.state.addressableGroupName || !this.state.addressableAssetPath.trim()}
							onClick={() => void this._assignAddressableAsset()}
						>
							Assign
						</Button>
					</div>
					{groups.map((group: any) => (
						<div key={group.id} className="rounded-lg bg-input p-2 text-xs">
							<div className="mb-1 font-medium">{group.name}</div>
							{(group.assets ?? []).map((assetPath: string) => (
								<div key={assetPath} className="truncate text-muted-foreground">
									{assetPath} {(group.assetLabels?.[assetPath] ?? []).length ? `· ${(group.assetLabels[assetPath] ?? []).join(", ")}` : ""}
								</div>
							))}
						</div>
					))}
					<Button size="sm" variant="secondary" onClick={() => void this._refreshAddressables()}>
						Refresh
					</Button>
					<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
						<Input
							value={this.state.addressablePreviousCatalogPath}
							aria-label="Previous addressable catalog path"
							onChange={(event) => this.setState({ addressablePreviousCatalogPath: event.currentTarget.value })}
							placeholder="previous.catalog.json"
						/>
						<Input
							value={this.state.addressableNextCatalogPath}
							aria-label="Next addressable catalog path"
							onChange={(event) => this.setState({ addressableNextCatalogPath: event.currentTarget.value })}
							placeholder="next.catalog.json"
						/>
						<Button size="sm" variant="secondary" onClick={() => void this._diffAddressableCatalogs()}>
							Diff
						</Button>
					</div>
					{this.state.addressableDiff && (
						<div className="text-xs text-muted-foreground">
							Content update: +{this.state.addressableDiff.summary.added} · ~{this.state.addressableDiff.summary.changed} · -
							{this.state.addressableDiff.summary.removed} · ={this.state.addressableDiff.summary.unchanged}
						</div>
					)}
					{this.state.addressableError && <div className="text-xs text-red-400">{this.state.addressableError}</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _refreshAddressables(): Promise<void> {
		try {
			this.setState({ addressableConfig: await listAddressableGroups(), addressableError: null });
		} catch (error) {
			this.setState({ addressableError: error instanceof Error ? error.message : "Could not list Addressables." });
		}
	}

	private async _createAddressableGroup(): Promise<void> {
		try {
			await createAddressableGroup(this.props.object, { name: this.state.addressableGroupName.trim() }, { editor: this.props.editor });
			await this._refreshAddressables();
		} catch (error) {
			this.setState({ addressableError: error instanceof Error ? error.message : "Could not create Addressable group." });
		}
	}

	private async _assignAddressableAsset(): Promise<void> {
		try {
			const data = { name: this.state.addressableGroupName, assetPath: this.state.addressableAssetPath.trim() };
			await assignAddressableAsset(this.props.object, data, { editor: this.props.editor });
			const labels = this.state.addressableLabels
				.split(",")
				.map((label) => label.trim())
				.filter(Boolean);
			if (labels.length) {
				await setAddressableAssetLabels(this.props.object, { ...data, labels }, { editor: this.props.editor });
			}
			this.setState({ addressableAssetPath: "", addressableLabels: "" });
			await this._refreshAddressables();
		} catch (error) {
			this.setState({ addressableError: error instanceof Error ? error.message : "Could not assign Addressable asset." });
		}
	}

	private async _diffAddressableCatalogs(): Promise<void> {
		try {
			const addressableDiff = await diffAddressableCatalogs(this.props.object, {
				previousCatalogPath: this.state.addressablePreviousCatalogPath.trim(),
				nextCatalogPath: this.state.addressableNextCatalogPath.trim(),
			});
			this.setState({ addressableDiff, addressableError: null });
		} catch (error) {
			this.setState({ addressableDiff: null, addressableError: error instanceof Error ? error.message : "Could not compare Addressable catalogs." });
		}
	}

	private _getInputWrapperComponent(): ReactNode {
		const maps = listInputActionMaps(this.props.object).maps as any[];
		const selectedMapName = this.state.inputWrapperMapName || maps[0]?.name || "";
		return (
			<EditorInspectorSectionField title="Input Actions Wrapper" tooltip="Generate TypeScript constants and a union type from a persisted Input Action Map.">
				<div className="flex flex-col gap-2">
					{maps.length ? (
						<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
							<select
								className="h-8 min-w-0 rounded bg-input px-2 text-sm"
								value={selectedMapName}
								onChange={(event) => this.setState({ inputWrapperMapName: event.currentTarget.value, inputWrapperSource: "" })}
							>
								{maps.map((map) => (
									<option key={map.id} value={map.name}>
										{map.name}
									</option>
								))}
							</select>
							<Button size="sm" onClick={() => this._generateInputActionWrapper(selectedMapName)}>
								Generate
							</Button>
						</div>
					) : (
						<div className="text-xs text-muted-foreground">No Input Action Maps are configured. Create one with the Input Actions MCP tools first.</div>
					)}
					{this.state.inputWrapperSource && <pre className="max-h-48 overflow-auto rounded-lg bg-input p-2 text-xs">{this.state.inputWrapperSource}</pre>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _generateInputActionWrapper(mapName: string): void {
		try {
			const result = generateInputActionWrapper(this.props.object, { mapName });
			this.setState({ inputWrapperMapName: mapName, inputWrapperSource: result.source });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not generate the Input Actions wrapper.");
		}
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
		return (
			<EditorInspectorSectionField
				title="Audio Mixer"
				tooltip="Persisted SoundNode gain buses and recallable gain snapshots. Use MCP to assign individual sound nodes to a bus."
			>
				<Button size="sm" variant="secondary" className="w-full" onClick={() => this._createAudioBus()}>
					Add Mixer Bus
				</Button>
				{buses.length === 0 ? (
					<div className="px-2 text-xs text-muted-foreground">No mixer buses. New buses start empty and can be assigned SoundNodes through MCP.</div>
				) : (
					buses.map((bus) => (
						<div key={bus.id} className="flex items-center gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{bus.name}</div>
								<div className="text-muted-foreground">
									{bus.soundNodeIds.length} sound node{bus.soundNodeIds.length === 1 ? "" : "s"}
								</div>
							</div>
							<Input
								type="number"
								min="0"
								step="0.05"
								defaultValue={String(bus.gain)}
								onBlur={(event) => this._setAudioBusGain(bus, event.target.value)}
								aria-label={`${bus.name} gain`}
							/>
							<Button size="sm" variant={bus.muted ? "default" : "ghost"} onClick={() => this._setAudioBusMuted(bus, !bus.muted)}>
								Mute
							</Button>
							<Button size="sm" variant={bus.solo ? "default" : "ghost"} onClick={() => this._setAudioBusSolo(bus, !bus.solo)}>
								Solo
							</Button>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteAudioBus(bus.id)}>
								Remove
							</Button>
						</div>
					))
				)}
				<div className="mt-2 flex items-center justify-between gap-2">
					<span className="text-xs font-medium">Snapshots</span>
					<Button size="sm" variant="secondary" onClick={() => this._createAudioMixerSnapshot()}>
						Capture
					</Button>
				</div>
				{snapshots.map((snapshot) => (
					<div key={snapshot.id} className="flex items-center gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
						<span className="min-w-0 flex-1 truncate">{snapshot.name}</span>
						<Button size="sm" variant="ghost" onClick={() => this._applyAudioMixerSnapshot(snapshot.id)}>
							Apply
						</Button>
						<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteAudioMixerSnapshot(snapshot.id)}>
							Remove
						</Button>
					</div>
				))}
			</EditorInspectorSectionField>
		);
	}

	private _getAudioRuntimeDiagnosticsComponent(): ReactNode {
		const diagnostics = listAudioRuntimeDiagnostics(this.props.object);
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

	private _applyAudioMixerSnapshot(id: string): void {
		try {
			applyAudioMixerSnapshot(this.props.object, { id }, { editor: this.props.editor });
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

	private _createBuildProfile(target: "web" | "electron" | "headless" | "android" | "ios"): void {
		const profiles = listBuildProfiles(this.props.object).profiles;
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
		createBuildProfile(this.props.object, { name: `${prefix} ${suffix}`, target });
		this.forceUpdate();
	}

	private _deleteBuildProfile(name: string): void {
		deleteBuildProfile(this.props.object, { name });
		this.forceUpdate();
	}

	private _setBuildProfileSetting(profile: any, key: string, value: any): void {
		setBuildProfile(this.props.object, { name: profile.name, settings: { ...(profile.settings ?? {}), [key]: value } });
		this.forceUpdate();
	}

	private async _validateBuildProfile(name: string): Promise<void> {
		try {
			const result = await validateBuildProfile(this.props.object, { name }, { editor: this.props.editor });
			if (result.valid) {
				toast.success(`${name} is ready: ${result.commands.join("; ")}.`);
			} else {
				toast.error(`${name}: ${result.reasons.join(" ")}`);
			}
		} catch (error: any) {
			toast.error(`Unable to validate ${name}: ${error.message}`);
		}
	}

	private async _generatePwaManifest(name: string): Promise<void> {
		try {
			const result = await generatePwaManifest(this.props.object, { name }, { editor: this.props.editor });
			toast.success(`Generated ${result.path}.`);
		} catch (error: any) {
			toast.error(`Unable to generate PWA manifest: ${error.message}`);
		}
	}

	private async _generatePwaServiceWorker(name: string): Promise<void> {
		try {
			const result = await generatePwaServiceWorker(this.props.object, { name }, { editor: this.props.editor });
			toast.success(`Generated ${result.path}. Register it in your web app entry point.`);
		} catch (error: any) {
			toast.error(`Unable to generate PWA service worker: ${error.message}`);
		}
	}

	private async _installPwaServiceWorkerRegistration(name: string): Promise<void> {
		try {
			const result = await installPwaServiceWorkerRegistration(this.props.object, { name }, { editor: this.props.editor });
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

	private _stopPhysicsContactCapture(): void {
		try {
			const result = stopPhysicsContactCapture(this.props.object, {}, { editor: this.props.editor });
			this.setState({ physicsContactCapture: result });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not stop physics contact capture.");
		}
	}

	private _validateGUIAccessibility(): void {
		const result = validateGUIAccessibility(this.props.object, {});
		this.setState({ guiAccessibilityValidation: result });
		if (result.warningCount) {
			toast.warning(`GUI accessibility audit found ${result.warningCount} warning${result.warningCount === 1 ? "" : "s"}.`);
		} else {
			toast.success("GUI accessibility audit found no warnings.");
		}
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

	private _getRenderingProfilesComponent(): ReactNode {
		const profiles = listRenderingProfiles(this.props.object).profiles as any[];
		const volumes = listRenderingVolumes(this.props.object).volumes as any[];
		const camera = this.props.object.activeCamera;
		return (
			<EditorInspectorSectionField
				title="Rendering Profiles"
				tooltip="Reusable snapshots of the active camera's post-process configuration. Applying a profile persists the selected camera configuration for exported games."
			>
				<Button variant="secondary" className="w-full" disabled={!camera} onClick={() => this._createRenderingProfile()}>
					Save Active Camera Profile
				</Button>
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
							<Button size="sm" variant="secondary" disabled={!camera} onClick={() => this._applyRenderingProfile(profile)}>
								Apply
							</Button>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteRenderingProfile(profile)}>
								Remove
							</Button>
						</div>
						<div className="text-xs text-muted-foreground">
							{Object.entries(profile.configurations)
								.filter(([, configuration]) => configuration !== null)
								.map(([type]) => type)
								.join(", ") || "All post-processes disabled"}
						</div>
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

	private _createRenderingProfile(): void {
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
			createRenderingProfile(this.props.object, { name: `Rendering Profile ${index}`, nodeId: camera.id }, { editor: this.props.editor });
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
		return (
			<EditorInspectorSectionField
				title="Custom Render Pass Graph"
				tooltip="Dependency-ordered shader, fixed copy, scene-raster, and native WebGPU compute passes with named texture outputs."
			>
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" onClick={() => this._createCustomRenderPass()}>
						Add Pass
					</Button>
					<Button variant="secondary" className="flex-1" disabled={!camera} onClick={() => this._evaluateCustomRenderPassGraph()}>
						Rebuild Preview
					</Button>
				</div>
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
								aria-label={`Enable ${pass.name}`}
								onChange={(event) => this._setCustomRenderPass(pass, { enabled: event.currentTarget.checked })}
							/>
							<Input
								defaultValue={pass.name}
								aria-label="Custom render pass name"
								onBlur={(event) => this._setCustomRenderPass(pass, { name: event.currentTarget.value })}
							/>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteCustomRenderPass(pass)}>
								Remove
							</Button>
						</div>
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
								<option value="raster">Scene Raster</option>
								<option value="compute">WebGPU Compute</option>
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
							<label>
								Scene raster settings JSON
								<Textarea
									className="font-mono"
									placeholder={
										'{"cameraId":null,"meshIds":[],"clearColor":[0,0,0,0],"renderParticles":false,"renderSprites":false,"useCameraPostProcesses":false,"refreshRate":"everyFrame"}'
									}
									defaultValue={JSON.stringify(pass.rasterSettings, null, 2)}
									onBlur={(event) => this._setCustomRenderPassJson(pass, "rasterSettings", event.currentTarget.value)}
								/>
								<div className="text-muted-foreground">
									An empty meshIds array draws all scene meshes. Named mesh and camera ids are validated when preview rebuilds.
								</div>
							</label>
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
								<Input type="number" defaultValue={pass.order} onBlur={(event) => this._setCustomRenderPassNumber(pass, "order", event.currentTarget.value)} />
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

	private _renameRenderingProfile(profile: any, name: string): void {
		if (!name.trim() || name === profile.name) {
			return;
		}
		try {
			setRenderingProfile(this.props.object, { id: profile.id, name }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _applyRenderingProfile(profile: any): void {
		const camera = this.props.object.activeCamera;
		if (!camera) {
			return;
		}
		try {
			applyRenderingProfile(this.props.object, { id: profile.id, nodeId: camera.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteRenderingProfile(profile: any): void {
		try {
			deleteRenderingProfile(this.props.object, { id: profile.id }, { editor: this.props.editor });
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
