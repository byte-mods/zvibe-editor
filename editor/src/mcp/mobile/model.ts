export const MOBILE_DEPLOYMENT_VERSION = 1 as const;

export type MobileTarget = "android" | "ios";
export type MobileBuildVariant = "debug" | "release";
export type AndroidPackageFormat = "apk" | "aab";
export type MobileStoreTrack = "internal" | "alpha" | "beta" | "production";
export type IosExportMethod = "development" | "ad-hoc" | "app-store-connect";

export interface IEnvironmentReference {
	enabled: boolean;
	[key: string]: string | boolean | undefined;
}

export interface IAndroidDeploymentSettings {
	variant: MobileBuildVariant;
	format: AndroidPackageFormat;
	applicationId: string;
	launchActivity: string;
	gradleTask?: string;
	signing: IEnvironmentReference & {
		keystorePathEnvironment?: string;
		keystorePasswordEnvironment?: string;
		keyAliasEnvironment?: string;
		keyPasswordEnvironment?: string;
	};
	store: {
		credentialPathEnvironment?: string;
		track: MobileStoreTrack;
		releaseStatus: "draft" | "completed";
	};
}

export interface IIosDeploymentSettings {
	variant: MobileBuildVariant;
	applicationId: string;
	workspace: string;
	scheme: string;
	archivePath: string;
	exportDirectory: string;
	exportMethod: IosExportMethod;
	signing: IEnvironmentReference & {
		teamIdEnvironment?: string;
		identityEnvironment?: string;
	};
	store: {
		apiKeyPathEnvironment?: string;
		submitForReview: boolean;
	};
}

export interface IMobileDeploymentConfiguration {
	version: typeof MOBILE_DEPLOYMENT_VERSION;
	revision: number;
	android: IAndroidDeploymentSettings;
	ios: IIosDeploymentSettings;
}

const environmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const applicationIdPattern = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/;
const gradleTaskPattern = /^[A-Za-z][A-Za-z0-9:._-]{0,127}$/;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function environmentName(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Rejects traversal before a project-relative path reaches native tooling. */
export function validateMobileRelativePath(value: string, label: string): void {
	const normalized = value.replaceAll("\\", "/");
	if (!normalized || normalized === "." || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..") || normalized.length > 1024) {
		throw new Error(`${label} must be a bounded project-relative path without traversal.`);
	}
}

/** Provides host-independent defaults; no signing or store credential values are persisted. */
export function createDefaultMobileDeploymentConfiguration(applicationId = "com.zvibe.game"): IMobileDeploymentConfiguration {
	return {
		version: MOBILE_DEPLOYMENT_VERSION,
		revision: 1,
		android: {
			variant: "release",
			format: "aab",
			applicationId,
			launchActivity: ".MainActivity",
			signing: { enabled: false },
			store: { track: "internal", releaseStatus: "draft" },
		},
		ios: {
			variant: "release",
			applicationId,
			workspace: ".zvibe/platforms/ios/ios/App/App.xcworkspace",
			scheme: "App",
			archivePath: ".zvibe/mobile/ios/App.xcarchive",
			exportDirectory: ".zvibe/mobile/ios/export",
			exportMethod: "app-store-connect",
			signing: { enabled: false },
			store: { submitForReview: false },
		},
	};
}

/** Migrates partial records while preserving exact revisions and target-specific settings. */
export function normalizeMobileDeploymentConfiguration(value: unknown, applicationId = "com.zvibe.game"): IMobileDeploymentConfiguration {
	const source = asRecord(value);
	const android = asRecord(source.android);
	const androidSigning = asRecord(android.signing);
	const androidStore = asRecord(android.store);
	const ios = asRecord(source.ios);
	const iosSigning = asRecord(ios.signing);
	const iosStore = asRecord(ios.store);
	const defaults = createDefaultMobileDeploymentConfiguration(applicationId);
	return {
		version: MOBILE_DEPLOYMENT_VERSION,
		revision: Number.isSafeInteger(source.revision) && Number(source.revision) >= 1 ? Number(source.revision) : defaults.revision,
		android: {
			variant: android.variant === "debug" ? "debug" : "release",
			format: android.format === "apk" ? "apk" : "aab",
			applicationId: typeof android.applicationId === "string" && android.applicationId.trim() ? android.applicationId.trim() : defaults.android.applicationId,
			launchActivity: typeof android.launchActivity === "string" && android.launchActivity.trim() ? android.launchActivity.trim() : defaults.android.launchActivity,
			gradleTask: typeof android.gradleTask === "string" && android.gradleTask.trim() ? android.gradleTask.trim() : undefined,
			signing: {
				enabled: androidSigning.enabled === true,
				keystorePathEnvironment: environmentName(androidSigning.keystorePathEnvironment),
				keystorePasswordEnvironment: environmentName(androidSigning.keystorePasswordEnvironment),
				keyAliasEnvironment: environmentName(androidSigning.keyAliasEnvironment),
				keyPasswordEnvironment: environmentName(androidSigning.keyPasswordEnvironment),
			},
			store: {
				credentialPathEnvironment: environmentName(androidStore.credentialPathEnvironment),
				track: ["alpha", "beta", "production"].includes(String(androidStore.track)) ? (androidStore.track as MobileStoreTrack) : "internal",
				releaseStatus: androidStore.releaseStatus === "completed" ? "completed" : "draft",
			},
		},
		ios: {
			variant: ios.variant === "debug" ? "debug" : "release",
			applicationId: typeof ios.applicationId === "string" && ios.applicationId.trim() ? ios.applicationId.trim() : defaults.ios.applicationId,
			workspace: typeof ios.workspace === "string" && ios.workspace.trim() ? ios.workspace.trim() : defaults.ios.workspace,
			scheme: typeof ios.scheme === "string" && ios.scheme.trim() ? ios.scheme.trim() : defaults.ios.scheme,
			archivePath: typeof ios.archivePath === "string" && ios.archivePath.trim() ? ios.archivePath.trim() : defaults.ios.archivePath,
			exportDirectory: typeof ios.exportDirectory === "string" && ios.exportDirectory.trim() ? ios.exportDirectory.trim() : defaults.ios.exportDirectory,
			exportMethod: ios.exportMethod === "development" || ios.exportMethod === "ad-hoc" ? ios.exportMethod : "app-store-connect",
			signing: {
				enabled: iosSigning.enabled === true,
				teamIdEnvironment: environmentName(iosSigning.teamIdEnvironment),
				identityEnvironment: environmentName(iosSigning.identityEnvironment),
			},
			store: {
				apiKeyPathEnvironment: environmentName(iosStore.apiKeyPathEnvironment),
				submitForReview: iosStore.submitForReview === true,
			},
		},
	};
}

function validateEnvironmentReferences(value: Record<string, unknown>, label: string, required: string[]): void {
	for (const [key, entry] of Object.entries(value)) {
		if (key !== "enabled" && entry !== undefined && (typeof entry !== "string" || !environmentPattern.test(entry))) {
			throw new Error(`${label} ${key} must name an environment variable.`);
		}
	}
	if (value.enabled === true) {
		for (const key of required) {
			if (typeof value[key] !== "string") {
				throw new Error(`${label} requires ${key} when enabled.`);
			}
		}
	}
}

/** Enforces portable bounds and environment-reference-only credential storage. */
export function validateMobileDeploymentConfiguration(configuration: IMobileDeploymentConfiguration): void {
	if (configuration.version !== MOBILE_DEPLOYMENT_VERSION || !Number.isSafeInteger(configuration.revision) || configuration.revision < 1) {
		throw new Error("Mobile Deployment requires version 1 and a positive safe-integer revision.");
	}
	for (const [target, applicationId] of [
		["Android", configuration.android.applicationId],
		["iOS", configuration.ios.applicationId],
	] as const) {
		if (!applicationIdPattern.test(applicationId) || applicationId.length > 255) {
			throw new Error(`${target} applicationId is invalid.`);
		}
	}
	if (!/^\.?[A-Za-z][A-Za-z0-9_.$]{0,254}$/.test(configuration.android.launchActivity)) {
		throw new Error("Android launchActivity must be a bounded Java activity name.");
	}
	if (configuration.android.gradleTask && !gradleTaskPattern.test(configuration.android.gradleTask)) {
		throw new Error("Android gradleTask is invalid.");
	}
	validateEnvironmentReferences(configuration.android.signing, "Android signing", [
		"keystorePathEnvironment",
		"keystorePasswordEnvironment",
		"keyAliasEnvironment",
		"keyPasswordEnvironment",
	]);
	if (configuration.android.store.credentialPathEnvironment && !environmentPattern.test(configuration.android.store.credentialPathEnvironment)) {
		throw new Error("Android store credentialPathEnvironment must name an environment variable.");
	}
	for (const [label, value] of [
		["iOS workspace", configuration.ios.workspace],
		["iOS archivePath", configuration.ios.archivePath],
		["iOS exportDirectory", configuration.ios.exportDirectory],
	] as const) {
		validateMobileRelativePath(value, label);
	}
	if (!configuration.ios.scheme.trim() || configuration.ios.scheme.length > 128 || /[\r\n\0]/.test(configuration.ios.scheme)) {
		throw new Error("iOS scheme must contain 1 through 128 safe characters.");
	}
	validateEnvironmentReferences(configuration.ios.signing, "iOS signing", ["teamIdEnvironment", "identityEnvironment"]);
	if (configuration.ios.store.apiKeyPathEnvironment && !environmentPattern.test(configuration.ios.store.apiKeyPathEnvironment)) {
		throw new Error("iOS store apiKeyPathEnvironment must name an environment variable.");
	}
}
