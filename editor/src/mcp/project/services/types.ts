import { IProjectServicesConfiguration, ProjectServiceCategory, ProjectServiceJson, ProjectServiceScalar } from "babylonjs-editor-tools";

export const PROJECT_SERVICES_CONTROL_VERSION = 2 as const;
export const PROJECT_SERVICES_REPORT_LIMIT = 20;

export type ProjectServiceEnvironmentKind = "development" | "staging" | "production";
export type ProjectAnalyticsParameterType = "string" | "integer" | "number" | "boolean" | "timestamp";

export interface IProjectAnalyticsParameterDefinition {
	name: string;
	type: ProjectAnalyticsParameterType;
	required: boolean;
}

export interface IProjectAnalyticsEventDefinition {
	name: string;
	description: string;
	enabled: boolean;
	parameters: IProjectAnalyticsParameterDefinition[];
}

export interface IProjectIapProductDefinition {
	id: string;
	type: "consumable" | "non-consumable" | "subscription";
	title: string;
	description: string;
	currency: string;
	priceMicros: number;
	payouts: Array<{ id: string; quantity: number }>;
}

export interface IProjectAdPlacementDefinition {
	id: string;
	type: "rewarded" | "interstitial" | "banner";
	reward: { id: string; quantity: number } | null;
}

export interface IProjectMatchmakingQueueDefinition {
	id: string;
	minPlayers: number;
	maxPlayers: number;
	ticketTimeoutSeconds: number;
	skillTolerance: number | null;
	relaxationSeconds: number | null;
}

export interface IProjectLeaderboardDefinition {
	id: string;
	name: string;
	sortOrder: "descending" | "ascending";
	keepBest: boolean;
	maxEntries: number;
}

export interface IProjectRemoteConfigDefinition {
	key: string;
	value: ProjectServiceJson;
}

export interface IProjectContentDeliveryEntryDefinition {
	key: string;
	url: string;
	sha256: string;
	bytes: number;
	contentType: string;
}

export interface IProjectContentDeliveryBucketDefinition {
	id: string;
	badges: Array<{ id: string; releaseId: string }>;
	releases: Array<{ id: string; entries: IProjectContentDeliveryEntryDefinition[] }>;
}

export interface IProjectCloudFunctionDefinition {
	id: string;
	entryPoint: string;
	timeoutMs: number;
	authenticated: boolean;
	emulatorResponse: ProjectServiceJson;
}

export interface IProjectServiceResources {
	analyticsEvents: IProjectAnalyticsEventDefinition[];
	iapProducts: IProjectIapProductDefinition[];
	adPlacements: IProjectAdPlacementDefinition[];
	matchmakingQueues: IProjectMatchmakingQueueDefinition[];
	leaderboards: IProjectLeaderboardDefinition[];
	remoteConfig: IProjectRemoteConfigDefinition[];
	contentDeliveryBuckets: IProjectContentDeliveryBucketDefinition[];
	cloudFunctions: IProjectCloudFunctionDefinition[];
}

export interface IProjectServiceEnvironment {
	id: string;
	name: string;
	kind: ProjectServiceEnvironmentKind;
	services: IProjectServicesConfiguration;
	resources: IProjectServiceResources;
	deployment: {
		script: string;
		credentialEnvironmentVariables: string[];
	};
}

export interface IProjectServicesControlConfiguration {
	version: typeof PROJECT_SERVICES_CONTROL_VERSION;
	revision: number;
	activeEnvironmentId: string;
	environments: IProjectServiceEnvironment[];
}

export interface IProjectServiceFinding {
	code: string;
	severity: "info" | "warning" | "error";
	category: ProjectServiceCategory | "deployment" | "resources" | "configuration";
	message: string;
	remediation: string | null;
}

export interface IProjectServicesDeploymentPlan {
	id: string;
	createdAt: string;
	expiresAt: string;
	configurationRevision: number;
	environmentId: string;
	dryRun: boolean;
	reconcile: boolean;
	fingerprint: string;
	projectFingerprint: string;
	valid: boolean;
	script: string;
	command: string;
	artifactPath: string;
	timeoutMs: number;
	credentialEnvironmentVariables: Array<{ name: string; available: boolean }>;
	enabledCategories: ProjectServiceCategory[];
	resourceCounts: Record<keyof IProjectServiceResources, number>;
	findings: IProjectServiceFinding[];
}

export interface IProjectServicesDeploymentReport {
	id: string;
	planId: string;
	environmentId: string;
	fingerprint: string;
	dryRun: boolean;
	reconcile: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	status: "succeeded" | "failed" | "timed-out" | "canceled";
	exitCode: number | null;
	command: string;
	stdout: string;
	stderr: string;
	outputTruncated: boolean;
	artifactPath: string;
}

export interface IProjectServiceEmulatorEvent {
	sequence: number;
	timestamp: string;
	category: ProjectServiceCategory;
	action: string;
	playerId: string | null;
	details: Record<string, ProjectServiceScalar>;
}
