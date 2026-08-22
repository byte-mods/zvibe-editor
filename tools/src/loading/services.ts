import { Scene } from "@babylonjs/core/scene";
import { AssetContainer } from "@babylonjs/core/assetContainer";

export const servicesConfigurationVersion = 3;

/**
 * The service categories a project can configure. These mirror the families a
 * game normally needs from a backend; the editor authors the contract and a
 * project-provided SDK consumes it, exactly like the network replication
 * component. The editor deliberately ships no vendor SDK and stores no secret.
 */
export type ProjectServiceCategory = "auth" | "cloudSave" | "analytics" | "iap" | "ads" | "matchmaking" | "leaderboards" | "remoteConfig" | "contentDelivery" | "cloudFunctions";

export const projectServiceCategories: readonly ProjectServiceCategory[] = [
	"auth",
	"cloudSave",
	"analytics",
	"iap",
	"ads",
	"matchmaking",
	"leaderboards",
	"remoteConfig",
	"contentDelivery",
	"cloudFunctions",
];

export interface IProjectServiceSettings extends Record<string, unknown> {
	enabled: boolean;
	/** Free-form provider id, e.g. "firebase", "playfab", "custom". */
	provider: string;
	/** Base endpoint the runtime SDK should talk to. */
	endpoint: string;
	/**
	 * Non-secret configuration forwarded verbatim to the runtime SDK.
	 * Secrets must NOT be stored here: a project file is committed to source
	 * control, so anything placed in it is effectively public.
	 */
	options: Record<string, unknown>;
}

export type IProjectServicesConfiguration = {
	version: typeof servicesConfigurationVersion;
	/** Active service environment sent with every generic REST request. */
	environment: string;
} & Record<ProjectServiceCategory, IProjectServiceSettings>;

const maximumStringLength = 512;
const maximumOptionEntries = 64;
const serviceOptionNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const secretOptionNamePattern = /(?:secret|password|private[_.-]?key|access[_.-]?token|refresh[_.-]?token)/i;

function normalizeString(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, maximumStringLength) : "";
}

/**
 * Keeps only JSON-safe, non-secret-sized option entries. Nested objects are
 * rejected rather than deep-cloned so a runtime SDK always receives a flat,
 * predictable shape and a malformed project file cannot smuggle huge payloads.
 */
function normalizeOptions(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}

	const options: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (Object.keys(options).length >= maximumOptionEntries) {
			break;
		}
		if (!serviceOptionNamePattern.test(key) || secretOptionNamePattern.test(key)) {
			continue;
		}
		if (typeof entry === "string") {
			options[key] = entry.slice(0, maximumStringLength);
		} else if (typeof entry === "boolean") {
			options[key] = entry;
		} else if (typeof entry === "number" && Number.isFinite(entry)) {
			options[key] = entry;
		}
	}
	return options;
}

function normalizeService(value: unknown): IProjectServiceSettings {
	const service = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
	const provider = normalizeString(service.provider);
	const endpoint = normalizeString(service.endpoint);

	return {
		// A service cannot be enabled without a provider to route to; this makes
		// "enabled" mean "actually usable" for the runtime rather than a flag the
		// SDK has to re-validate.
		enabled: service.enabled === true && provider.length > 0,
		provider,
		endpoint,
		options: normalizeOptions(service.options),
	};
}

/**
 * Normalizes a whole services block, filling in every known category so a
 * runtime consumer can read `config.analytics.enabled` without existence
 * checks. Never throws: malformed or partial authored data degrades to a
 * disabled service instead of breaking a scene load.
 */
export function normalizeProjectServicesConfiguration(value: unknown): IProjectServicesConfiguration {
	const source = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
	const configuration = {
		version: servicesConfigurationVersion,
		environment: normalizeString(source.environment) || "development",
	} as IProjectServicesConfiguration;
	projectServiceCategories.forEach((category) => {
		configuration[category] = normalizeService(source[category]);
	});
	return configuration;
}

/** Reads the normalized services contract persisted on a scene. */
export function getProjectServicesConfiguration(scene: Scene | AssetContainer): IProjectServicesConfiguration {
	const metadata = (scene as Scene).metadata as Record<string, unknown> | undefined;
	return normalizeProjectServicesConfiguration(metadata?.babylonEditorServices);
}

/** Returns the enabled service categories, in stable declaration order. */
export function getEnabledProjectServices(scene: Scene | AssetContainer): ProjectServiceCategory[] {
	const configuration = getProjectServicesConfiguration(scene);
	return projectServiceCategories.filter((category) => configuration[category].enabled);
}
