import { lstat } from "fs/promises";
import { join } from "path";

import { Scene } from "babylonjs";
import {
	IProjectServiceSettings,
	ProjectServiceCategory,
	ProjectServiceJson,
	normalizeProjectServicesConfiguration,
	projectServiceCategories,
	servicesConfigurationVersion,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../../action";
import { getProjectPackageContext } from "../package-manager/context";
import {
	IProjectAdPlacementDefinition,
	IProjectAnalyticsEventDefinition,
	IProjectIapProductDefinition,
	IProjectLeaderboardDefinition,
	IProjectMatchmakingQueueDefinition,
	IProjectRemoteConfigDefinition,
	IProjectContentDeliveryBucketDefinition,
	IProjectCloudFunctionDefinition,
	IProjectServiceEnvironment,
	IProjectServiceFinding,
	IProjectServiceResources,
	IProjectServicesControlConfiguration,
	PROJECT_SERVICES_CONTROL_VERSION,
	ProjectServiceEnvironmentKind,
} from "./types";

const environmentIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const eventNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const packageScriptPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const environmentVariablePattern = /^[A-Z_][A-Z0-9_]{0,127}$/;
const maximumEnvironments = 16;

export function getProjectServicesCapabilities(): any {
	return {
		version: PROJECT_SERVICES_CONTROL_VERSION,
		categories: [...projectServiceCategories],
		maximumEnvironments,
		runtime: {
			portableClient: true,
			genericRest: true,
			memoryOnlySessions: true,
			exactCloudSaveRevisions: true,
			analyticsSchemas: true,
			iapCatalogsAndRestore: true,
			rewardedAds: true,
			matchmakingTickets: true,
			leaderboardScores: true,
			remoteConfig: true,
			contentDeliveryManifests: true,
			cloudFunctionCalls: true,
		},
		resources: ["analyticsEvents", "iapProducts", "adPlacements", "matchmakingQueues", "leaderboards", "remoteConfig", "contentDeliveryBuckets", "cloudFunctions"],
		environments: { exactRevisions: true, kinds: ["development", "staging", "production"] },
		deployment: { plansExpire: true, exactFingerprints: true, fixedPackageScripts: true, credentialValuesPersisted: false, boundedReports: true },
		emulator: { loopbackOnly: true, persistent: true, allCategories: true, credentialsPersisted: false },
		providerBoundary:
			"Vendor SDKs and remote account provisioning are supplied by project packages/scripts; the editor stores provider-neutral configuration and never stores service secrets.",
		providerAdapters: ["generic-rest", "local-emulator", "project-deployment-script"],
		notCoreAdapters: ["lobbyRelay"],
	};
}

function plainObject(value: unknown, label: string): Record<string, any> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, any>;
}

function exactKeys(source: Record<string, any>, allowed: string[], label: string): void {
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`Unknown ${label} field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	}
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.trim().length > maximum) {
		throw new Error(`${label} must be ${allowEmpty ? `at most ${maximum}` : `1–${maximum}`} characters.`);
	}
	return value.trim();
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return Number(value);
}

function uniqueById<T extends { id?: string; name?: string }>(entries: T[], key: "id" | "name", label: string): void {
	const values = entries.map((entry) => entry[key]);
	if (new Set(values).size !== values.length) {
		throw new Error(`${label} ${key}s must be unique.`);
	}
}

function emptyResources(): IProjectServiceResources {
	return { analyticsEvents: [], iapProducts: [], adPlacements: [], matchmakingQueues: [], leaderboards: [], remoteConfig: [], contentDeliveryBuckets: [], cloudFunctions: [] };
}

function boundedJson(value: unknown, label: string, maximumBytes = 64 * 1024): ProjectServiceJson {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error(`${label} must be JSON-serializable.`);
	}
	if (serialized === undefined || Buffer.byteLength(serialized) > maximumBytes) {
		throw new Error(`${label} must serialize to at most ${maximumBytes} bytes.`);
	}
	return JSON.parse(serialized) as ProjectServiceJson;
}

function validateAnalyticsEvents(value: unknown): IProjectAnalyticsEventDefinition[] {
	if (!Array.isArray(value) || value.length > 100) {
		throw new Error("analyticsEvents must be an array of at most 100 definitions.");
	}
	const events = value.map((entry, index) => {
		const source = plainObject(entry, `analyticsEvents[${index}]`);
		exactKeys(source, ["name", "description", "enabled", "parameters"], `analyticsEvents[${index}]`);
		const name = boundedString(source.name, `analyticsEvents[${index}].name`, 64);
		if (!eventNamePattern.test(name)) {
			throw new Error(`analyticsEvents[${index}].name must start with a letter and contain only alphanumeric or underscore characters.`);
		}
		if (!Array.isArray(source.parameters) || source.parameters.length > 64) {
			throw new Error(`analyticsEvents[${index}].parameters must be an array of at most 64 definitions.`);
		}
		const parameters = source.parameters.map((parameter: unknown, parameterIndex: number) => {
			const parameterSource = plainObject(parameter, `analyticsEvents[${index}].parameters[${parameterIndex}]`);
			exactKeys(parameterSource, ["name", "type", "required"], `analyticsEvents[${index}].parameters[${parameterIndex}]`);
			const parameterName = boundedString(parameterSource.name, `analyticsEvents[${index}].parameters[${parameterIndex}].name`, 64);
			if (!eventNamePattern.test(parameterName) || !["string", "integer", "number", "boolean", "timestamp"].includes(parameterSource.type)) {
				throw new Error(`analyticsEvents[${index}] contains an invalid parameter name or type.`);
			}
			if (typeof parameterSource.required !== "boolean") {
				throw new Error(`analyticsEvents[${index}].parameters[${parameterIndex}].required must be a boolean.`);
			}
			return { name: parameterName, type: parameterSource.type, required: parameterSource.required };
		});
		uniqueById(parameters, "name", `analyticsEvents[${index}] parameter`);
		return {
			name,
			description: boundedString(source.description ?? "", `analyticsEvents[${index}].description`, 512, true),
			enabled: source.enabled !== false,
			parameters,
		} as IProjectAnalyticsEventDefinition;
	});
	uniqueById(events, "name", "Analytics event");
	return events;
}

function validateIapProducts(value: unknown): IProjectIapProductDefinition[] {
	if (!Array.isArray(value) || value.length > 500) {
		throw new Error("iapProducts must be an array of at most 500 products.");
	}
	const products = value.map((entry, index) => {
		const source = plainObject(entry, `iapProducts[${index}]`);
		exactKeys(source, ["id", "type", "title", "description", "currency", "priceMicros", "payouts"], `iapProducts[${index}]`);
		const id = boundedString(source.id, `iapProducts[${index}].id`, 128);
		if (!identifierPattern.test(id) || !["consumable", "non-consumable", "subscription"].includes(source.type)) {
			throw new Error(`iapProducts[${index}] has an invalid id or type.`);
		}
		const currency = boundedString(source.currency, `iapProducts[${index}].currency`, 3);
		if (!/^[A-Z]{3}$/.test(currency)) {
			throw new Error(`iapProducts[${index}].currency must be an uppercase ISO-style three-letter code.`);
		}
		if (!Array.isArray(source.payouts ?? []) || (source.payouts ?? []).length > 8) {
			throw new Error(`iapProducts[${index}].payouts must contain at most 8 entries.`);
		}
		const payouts = (source.payouts ?? []).map((payout: unknown, payoutIndex: number) => {
			const payoutSource = plainObject(payout, `iapProducts[${index}].payouts[${payoutIndex}]`);
			exactKeys(payoutSource, ["id", "quantity"], `iapProducts[${index}].payouts[${payoutIndex}]`);
			const payoutId = boundedString(payoutSource.id, `iapProducts[${index}].payouts[${payoutIndex}].id`, 128);
			if (!identifierPattern.test(payoutId)) {
				throw new Error(`iapProducts[${index}].payouts[${payoutIndex}].id is invalid.`);
			}
			return { id: payoutId, quantity: boundedInteger(payoutSource.quantity, `iapProducts[${index}].payouts[${payoutIndex}].quantity`, 1, 1_000_000_000) };
		});
		uniqueById(payouts, "id", `iapProducts[${index}] payout`);
		return {
			id,
			type: source.type,
			title: boundedString(source.title, `iapProducts[${index}].title`, 128),
			description: boundedString(source.description ?? "", `iapProducts[${index}].description`, 1024, true),
			currency,
			priceMicros: boundedInteger(source.priceMicros, `iapProducts[${index}].priceMicros`, 0, Number.MAX_SAFE_INTEGER),
			payouts,
		} as IProjectIapProductDefinition;
	});
	uniqueById(products, "id", "IAP product");
	return products;
}

function validateAdPlacements(value: unknown): IProjectAdPlacementDefinition[] {
	if (!Array.isArray(value) || value.length > 100) {
		throw new Error("adPlacements must be an array of at most 100 placements.");
	}
	const placements = value.map((entry, index) => {
		const source = plainObject(entry, `adPlacements[${index}]`);
		exactKeys(source, ["id", "type", "reward"], `adPlacements[${index}]`);
		const id = boundedString(source.id, `adPlacements[${index}].id`, 128);
		if (!identifierPattern.test(id) || !["rewarded", "interstitial", "banner"].includes(source.type)) {
			throw new Error(`adPlacements[${index}] has an invalid id or type.`);
		}
		let reward: { id: string; quantity: number } | null = null;
		if (source.reward !== undefined && source.reward !== null) {
			const rewardSource = plainObject(source.reward, `adPlacements[${index}].reward`);
			exactKeys(rewardSource, ["id", "quantity"], `adPlacements[${index}].reward`);
			const rewardId = boundedString(rewardSource.id, `adPlacements[${index}].reward.id`, 128);
			if (!identifierPattern.test(rewardId)) {
				throw new Error(`adPlacements[${index}].reward.id is invalid.`);
			}
			reward = { id: rewardId, quantity: boundedInteger(rewardSource.quantity, `adPlacements[${index}].reward.quantity`, 1, 1_000_000_000) };
		}
		if (source.type === "rewarded" && !reward) {
			throw new Error(`Rewarded ad placement ${id} requires a reward.`);
		}
		return { id, type: source.type, reward } as IProjectAdPlacementDefinition;
	});
	uniqueById(placements, "id", "Ad placement");
	return placements;
}

function validateMatchmakingQueues(value: unknown): IProjectMatchmakingQueueDefinition[] {
	if (!Array.isArray(value) || value.length > 50) {
		throw new Error("matchmakingQueues must be an array of at most 50 queues.");
	}
	const queues = value.map((entry, index) => {
		const source = plainObject(entry, `matchmakingQueues[${index}]`);
		exactKeys(source, ["id", "minPlayers", "maxPlayers", "ticketTimeoutSeconds", "skillTolerance", "relaxationSeconds"], `matchmakingQueues[${index}]`);
		const id = boundedString(source.id, `matchmakingQueues[${index}].id`, 128);
		if (!identifierPattern.test(id)) {
			throw new Error(`matchmakingQueues[${index}].id is invalid.`);
		}
		const minPlayers = boundedInteger(source.minPlayers, `matchmakingQueues[${index}].minPlayers`, 1, 100);
		const maxPlayers = boundedInteger(source.maxPlayers, `matchmakingQueues[${index}].maxPlayers`, minPlayers, 100);
		const optionalInteger = (field: "skillTolerance" | "relaxationSeconds", maximum: number): number | null =>
			source[field] === undefined || source[field] === null ? null : boundedInteger(source[field], `matchmakingQueues[${index}].${field}`, 0, maximum);
		return {
			id,
			minPlayers,
			maxPlayers,
			ticketTimeoutSeconds: boundedInteger(source.ticketTimeoutSeconds, `matchmakingQueues[${index}].ticketTimeoutSeconds`, 5, 3600),
			skillTolerance: optionalInteger("skillTolerance", 1_000_000),
			relaxationSeconds: optionalInteger("relaxationSeconds", 3600),
		};
	});
	uniqueById(queues, "id", "Matchmaking queue");
	return queues;
}

function validateLeaderboards(value: unknown): IProjectLeaderboardDefinition[] {
	if (!Array.isArray(value) || value.length > 100) {
		throw new Error("leaderboards must be an array of at most 100 definitions.");
	}
	const entries = value.map((entry, index): IProjectLeaderboardDefinition => {
		const source = plainObject(entry, `leaderboards[${index}]`);
		exactKeys(source, ["id", "name", "sortOrder", "keepBest", "maxEntries"], `leaderboards[${index}]`);
		const id = boundedString(source.id, `leaderboards[${index}].id`, 128);
		if (!identifierPattern.test(id) || !["descending", "ascending"].includes(source.sortOrder) || typeof source.keepBest !== "boolean") {
			throw new Error(`leaderboards[${index}] has invalid id, sortOrder, or keepBest values.`);
		}
		return {
			id,
			name: boundedString(source.name, `leaderboards[${index}].name`, 128),
			sortOrder: source.sortOrder,
			keepBest: source.keepBest,
			maxEntries: boundedInteger(source.maxEntries, `leaderboards[${index}].maxEntries`, 1, 100_000),
		};
	});
	uniqueById(entries, "id", "Leaderboard");
	return entries;
}

function validateRemoteConfig(value: unknown): IProjectRemoteConfigDefinition[] {
	if (!Array.isArray(value) || value.length > 1_000) {
		throw new Error("remoteConfig must be an array of at most 1000 entries.");
	}
	const entries = value.map((entry, index): IProjectRemoteConfigDefinition => {
		const source = plainObject(entry, `remoteConfig[${index}]`);
		exactKeys(source, ["key", "value"], `remoteConfig[${index}]`);
		const key = boundedString(source.key, `remoteConfig[${index}].key`, 128);
		if (!identifierPattern.test(key)) {
			throw new Error(`remoteConfig[${index}].key is invalid.`);
		}
		return { key, value: boundedJson(source.value, `remoteConfig[${index}].value`) };
	});
	const keys = entries.map((entry) => entry.key);
	if (new Set(keys).size !== keys.length) {
		throw new Error("Remote Config keys must be unique.");
	}
	return entries;
}

function validateContentDeliveryBuckets(value: unknown): IProjectContentDeliveryBucketDefinition[] {
	if (!Array.isArray(value) || value.length > 64) {
		throw new Error("contentDeliveryBuckets must be an array of at most 64 buckets.");
	}
	const buckets = value.map((entry, index): IProjectContentDeliveryBucketDefinition => {
		const source = plainObject(entry, `contentDeliveryBuckets[${index}]`);
		exactKeys(source, ["id", "badges", "releases"], `contentDeliveryBuckets[${index}]`);
		const id = boundedString(source.id, `contentDeliveryBuckets[${index}].id`, 128);
		if (!identifierPattern.test(id) || !Array.isArray(source.badges) || source.badges.length > 100 || !Array.isArray(source.releases) || source.releases.length > 100) {
			throw new Error(`contentDeliveryBuckets[${index}] has invalid id, badges, or releases.`);
		}
		const releases = source.releases.map((release: unknown, releaseIndex: number) => {
			const releaseSource = plainObject(release, `contentDeliveryBuckets[${index}].releases[${releaseIndex}]`);
			exactKeys(releaseSource, ["id", "entries"], `contentDeliveryBuckets[${index}].releases[${releaseIndex}]`);
			const releaseId = boundedString(releaseSource.id, `contentDeliveryBuckets[${index}].releases[${releaseIndex}].id`, 128);
			if (!identifierPattern.test(releaseId) || !Array.isArray(releaseSource.entries) || releaseSource.entries.length > 1_000) {
				throw new Error(`contentDeliveryBuckets[${index}].releases[${releaseIndex}] is invalid.`);
			}
			const entries = releaseSource.entries.map((asset: unknown, assetIndex: number) => {
				const assetSource = plainObject(asset, `contentDeliveryBuckets[${index}].releases[${releaseIndex}].entries[${assetIndex}]`);
				exactKeys(assetSource, ["key", "url", "sha256", "bytes", "contentType"], `contentDeliveryBuckets[${index}].releases[${releaseIndex}].entries[${assetIndex}]`);
				const key = boundedString(assetSource.key, "content delivery key", 128);
				const url = boundedString(assetSource.url, "content delivery URL", 2048);
				let parsed: URL;
				try {
					parsed = new URL(url);
				} catch {
					throw new Error("Content delivery URLs must be absolute HTTPS or loopback HTTP URLs.");
				}
				const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
				if (
					!identifierPattern.test(key) ||
					(parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
					parsed.username ||
					parsed.password ||
					parsed.search ||
					parsed.hash
				) {
					throw new Error("Content delivery entries require valid keys and credential-free HTTPS or loopback HTTP URLs.");
				}
				if (typeof assetSource.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(assetSource.sha256)) {
					throw new Error("Content delivery entry sha256 must be a lowercase SHA-256 digest.");
				}
				return {
					key,
					url,
					sha256: assetSource.sha256,
					bytes: boundedInteger(assetSource.bytes, "content delivery bytes", 0, 2 * 1024 * 1024 * 1024),
					contentType: boundedString(assetSource.contentType, "content delivery contentType", 128),
				};
			});
			if (new Set(entries.map((asset) => asset.key)).size !== entries.length) {
				throw new Error(`Content delivery release ${releaseId} contains duplicate keys.`);
			}
			return { id: releaseId, entries };
		});
		uniqueById(releases, "id", `Content delivery bucket ${id} release`);
		const releaseIds = new Set(releases.map((release) => release.id));
		const badges = source.badges.map((badge: unknown, badgeIndex: number) => {
			const badgeSource = plainObject(badge, `contentDeliveryBuckets[${index}].badges[${badgeIndex}]`);
			exactKeys(badgeSource, ["id", "releaseId"], `contentDeliveryBuckets[${index}].badges[${badgeIndex}]`);
			const badgeId = boundedString(badgeSource.id, "content delivery badge id", 128);
			const releaseId = boundedString(badgeSource.releaseId, "content delivery badge releaseId", 128);
			if (!identifierPattern.test(badgeId) || !releaseIds.has(releaseId)) {
				throw new Error(`Content delivery badge ${badgeId} must reference a release in its bucket.`);
			}
			return { id: badgeId, releaseId };
		});
		uniqueById(badges, "id", `Content delivery bucket ${id} badge`);
		return { id, badges, releases };
	});
	uniqueById(buckets, "id", "Content delivery bucket");
	return buckets;
}

function validateCloudFunctions(value: unknown): IProjectCloudFunctionDefinition[] {
	if (!Array.isArray(value) || value.length > 256) {
		throw new Error("cloudFunctions must be an array of at most 256 definitions.");
	}
	const functions = value.map((entry, index): IProjectCloudFunctionDefinition => {
		const source = plainObject(entry, `cloudFunctions[${index}]`);
		exactKeys(source, ["id", "entryPoint", "timeoutMs", "authenticated", "emulatorResponse"], `cloudFunctions[${index}]`);
		const id = boundedString(source.id, `cloudFunctions[${index}].id`, 128);
		const entryPoint = boundedString(source.entryPoint, `cloudFunctions[${index}].entryPoint`, 1024);
		if (!identifierPattern.test(id) || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s)$/.test(entryPoint)) {
			throw new Error(`cloudFunctions[${index}] requires a valid id and contained JavaScript/TypeScript entryPoint.`);
		}
		if (typeof source.authenticated !== "boolean") {
			throw new Error(`cloudFunctions[${index}].authenticated must be a boolean.`);
		}
		return {
			id,
			entryPoint,
			timeoutMs: boundedInteger(source.timeoutMs, `cloudFunctions[${index}].timeoutMs`, 100, 120_000),
			authenticated: source.authenticated,
			emulatorResponse: boundedJson(source.emulatorResponse, `cloudFunctions[${index}].emulatorResponse`),
		};
	});
	uniqueById(functions, "id", "Cloud Function");
	return functions;
}

export function validateProjectServiceResources(value: unknown): IProjectServiceResources {
	const source = plainObject(value ?? emptyResources(), "resources");
	exactKeys(
		source,
		["analyticsEvents", "iapProducts", "adPlacements", "matchmakingQueues", "leaderboards", "remoteConfig", "contentDeliveryBuckets", "cloudFunctions"],
		"resources"
	);
	return {
		analyticsEvents: validateAnalyticsEvents(source.analyticsEvents ?? []),
		iapProducts: validateIapProducts(source.iapProducts ?? []),
		adPlacements: validateAdPlacements(source.adPlacements ?? []),
		matchmakingQueues: validateMatchmakingQueues(source.matchmakingQueues ?? []),
		leaderboards: validateLeaderboards(source.leaderboards ?? []),
		remoteConfig: validateRemoteConfig(source.remoteConfig ?? []),
		contentDeliveryBuckets: validateContentDeliveryBuckets(source.contentDeliveryBuckets ?? []),
		cloudFunctions: validateCloudFunctions(source.cloudFunctions ?? []),
	};
}

function validateServiceSettings(value: unknown, category: ProjectServiceCategory, environmentId: string): IProjectServiceSettings {
	const source = plainObject(value, `${category} service`);
	exactKeys(source, ["enabled", "provider", "endpoint", "options"], `${category} service`);
	if (typeof source.enabled !== "boolean") {
		throw new Error(`${category}.enabled must be a boolean.`);
	}
	const provider = boundedString(source.provider ?? "", `${category}.provider`, 128, true);
	const endpoint = boundedString(source.endpoint ?? "", `${category}.endpoint`, 512, true);
	if (source.enabled && !provider) {
		throw new Error(`${category}.provider is required when the service is enabled.`);
	}
	const optionsSource = source.options === undefined ? {} : plainObject(source.options, `${category}.options`);
	if (Object.keys(optionsSource).length > 64) {
		throw new Error(`${category}.options supports at most 64 entries.`);
	}
	for (const [key, entry] of Object.entries(optionsSource)) {
		if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) || /(?:secret|password|private[_.-]?key|access[_.-]?token|refresh[_.-]?token)/i.test(key)) {
			throw new Error(`${category}.options contains an invalid or secret-like key: ${key}.`);
		}
		if (
			!(["string", "number", "boolean"].includes(typeof entry) && (typeof entry !== "number" || Number.isFinite(entry))) ||
			(typeof entry === "string" && entry.length > 512)
		) {
			throw new Error(`${category}.options.${key} must be a bounded JSON scalar.`);
		}
	}
	return normalizeProjectServicesConfiguration({ environment: environmentId, [category]: { enabled: source.enabled, provider, endpoint, options: optionsSource } })[category];
}

function validateDeployment(value: unknown): IProjectServiceEnvironment["deployment"] {
	const source = plainObject(value ?? {}, "deployment");
	exactKeys(source, ["script", "credentialEnvironmentVariables"], "deployment");
	const script = source.script === undefined || source.script === "" ? "services:deploy" : boundedString(source.script, "deployment.script", 128);
	if (!packageScriptPattern.test(script)) {
		throw new Error("deployment.script must be a package-script name.");
	}
	if (!Array.isArray(source.credentialEnvironmentVariables ?? []) || (source.credentialEnvironmentVariables ?? []).length > 32) {
		throw new Error("deployment.credentialEnvironmentVariables must contain at most 32 names.");
	}
	const variables = (source.credentialEnvironmentVariables ?? []).map((entry: unknown) => boundedString(entry, "credential environment variable", 128));
	if (variables.some((entry: string) => !environmentVariablePattern.test(entry)) || new Set(variables).size !== variables.length) {
		throw new Error("Credential environment variables must be unique uppercase environment-variable names.");
	}
	return { script, credentialEnvironmentVariables: variables };
}

function createEnvironment(id: string, name: string, kind: ProjectServiceEnvironmentKind, legacy?: unknown): IProjectServiceEnvironment {
	const services = normalizeProjectServicesConfiguration({ ...(legacy && typeof legacy === "object" ? legacy : {}), environment: id });
	return { id, name, kind, services, resources: emptyResources(), deployment: { script: "services:deploy", credentialEnvironmentVariables: [] } };
}

function normalizeEnvironment(value: unknown, index: number): IProjectServiceEnvironment {
	const source = plainObject(value, `environments[${index}]`);
	exactKeys(source, ["id", "name", "kind", "services", "resources", "deployment"], `environments[${index}]`);
	const id = boundedString(source.id, `environments[${index}].id`, 64);
	if (!environmentIdPattern.test(id)) {
		throw new Error(`environments[${index}].id must be a lowercase slug.`);
	}
	if (!["development", "staging", "production"].includes(source.kind)) {
		throw new Error(`environments[${index}].kind is invalid.`);
	}
	const serviceSource = plainObject(source.services, `environments[${index}].services`);
	exactKeys(serviceSource, ["version", "environment", ...projectServiceCategories], `environments[${index}].services`);
	if (![2, servicesConfigurationVersion].includes(serviceSource.version) || serviceSource.environment !== id) {
		throw new Error(`environments[${index}].services must use runtime version ${servicesConfigurationVersion} and environment ${id}.`);
	}
	const services = normalizeProjectServicesConfiguration({ environment: id });
	for (const category of projectServiceCategories) {
		services[category] = validateServiceSettings(serviceSource[category] ?? { enabled: false, provider: "", endpoint: "", options: {} }, category, id);
	}
	return {
		id,
		name: boundedString(source.name, `environments[${index}].name`, 128),
		kind: source.kind,
		services,
		resources: validateProjectServiceResources(source.resources ?? emptyResources()),
		deployment: validateDeployment(source.deployment),
	};
}

/** Migrates the legacy one-environment scene contract without allowing malformed authored state to become executable. */
export function normalizeProjectServicesControlConfiguration(value: unknown, legacy: unknown): IProjectServicesControlConfiguration {
	if (value === undefined || value === null) {
		return {
			version: PROJECT_SERVICES_CONTROL_VERSION,
			revision: 0,
			activeEnvironmentId: "development",
			environments: [createEnvironment("development", "Development", "development", legacy)],
		};
	}
	const source = plainObject(value, "project services configuration");
	exactKeys(source, ["version", "revision", "activeEnvironmentId", "environments"], "project services configuration");
	if (![1, PROJECT_SERVICES_CONTROL_VERSION].includes(source.version)) {
		throw new Error(`Unsupported project services control version: ${String(source.version)}.`);
	}
	if (!Number.isSafeInteger(source.revision) || source.revision < 0) {
		throw new Error("Project services revision must be a non-negative safe integer.");
	}
	if (!Array.isArray(source.environments) || !source.environments.length || source.environments.length > maximumEnvironments) {
		throw new Error(`Project services require 1–${maximumEnvironments} environments.`);
	}
	const environments = source.environments.map(normalizeEnvironment);
	uniqueById(environments, "id", "Service environment");
	uniqueById(environments, "name", "Service environment");
	const activeEnvironmentId = boundedString(source.activeEnvironmentId, "activeEnvironmentId", 64);
	if (!environments.some((environment) => environment.id === activeEnvironmentId)) {
		throw new Error("The active service environment does not exist.");
	}
	return { version: PROJECT_SERVICES_CONTROL_VERSION, revision: source.revision, activeEnvironmentId, environments };
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function readConfiguration(scene: Scene): IProjectServicesControlConfiguration {
	const metadata = scene.metadata ?? {};
	return normalizeProjectServicesControlConfiguration(metadata.babylonEditorServicesControl, metadata.babylonEditorServices);
}

function writeConfiguration(scene: Scene, configuration: IProjectServicesControlConfiguration): void {
	const metadata = (scene.metadata ??= {});
	metadata.babylonEditorServicesControl = clone(configuration);
	const active = configuration.environments.find((environment) => environment.id === configuration.activeEnvironmentId)!;
	metadata.babylonEditorServices = clone(active.services);
}

function expectedRevision(configuration: IProjectServicesControlConfiguration, value: unknown): void {
	if (!Number.isSafeInteger(value) || value !== configuration.revision) {
		throw new Error(`Project services expectedRevision must equal current revision ${configuration.revision}.`);
	}
}

export function getProjectServicesConfiguration(_scene: Scene, _data: any, _options?: IMCPActionOptions): IProjectServicesControlConfiguration {
	return clone(readConfiguration(_scene));
}

export function setProjectServiceEnvironment(scene: Scene, data: any): IProjectServicesControlConfiguration {
	const configuration = readConfiguration(scene);
	expectedRevision(configuration, data.expectedRevision);
	const id = boundedString(data.id, "environment id", 64);
	if (!environmentIdPattern.test(id)) {
		throw new Error("Environment id must be a lowercase slug.");
	}
	const existing = configuration.environments.find((environment) => environment.id === id);
	if (!existing && configuration.environments.length >= maximumEnvironments) {
		throw new Error(`Project services support at most ${maximumEnvironments} environments.`);
	}
	const next = existing ?? createEnvironment(id, id, "development");
	if (data.name !== undefined) {
		next.name = boundedString(data.name, "environment name", 128);
	}
	if (data.kind !== undefined) {
		if (!["development", "staging", "production"].includes(data.kind)) {
			throw new Error("Environment kind must be development, staging, or production.");
		}
		next.kind = data.kind;
	}
	if (data.deployment !== undefined) {
		next.deployment = validateDeployment(data.deployment);
	}
	if (!existing) {
		configuration.environments.push(next);
	}
	uniqueById(configuration.environments, "name", "Service environment");
	configuration.revision++;
	writeConfiguration(scene, configuration);
	return clone(configuration);
}

export function setActiveProjectServiceEnvironment(scene: Scene, data: any): IProjectServicesControlConfiguration {
	const configuration = readConfiguration(scene);
	expectedRevision(configuration, data.expectedRevision);
	if (!configuration.environments.some((environment) => environment.id === data.id)) {
		throw new Error(`Unknown project service environment: ${String(data.id)}.`);
	}
	configuration.activeEnvironmentId = data.id;
	configuration.revision++;
	writeConfiguration(scene, configuration);
	return clone(configuration);
}

export function deleteProjectServiceEnvironment(scene: Scene, data: any): IProjectServicesControlConfiguration {
	const configuration = readConfiguration(scene);
	expectedRevision(configuration, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Deleting a project service environment requires confirm=true.");
	}
	if (configuration.environments.length === 1 || data.id === configuration.activeEnvironmentId) {
		throw new Error("The only or active project service environment cannot be deleted.");
	}
	const next = configuration.environments.filter((environment) => environment.id !== data.id);
	if (next.length === configuration.environments.length) {
		throw new Error(`Unknown project service environment: ${String(data.id)}.`);
	}
	configuration.environments = next;
	configuration.revision++;
	writeConfiguration(scene, configuration);
	return clone(configuration);
}

export function setProjectServiceCategory(scene: Scene, data: any): IProjectServicesControlConfiguration {
	const configuration = readConfiguration(scene);
	expectedRevision(configuration, data.expectedRevision);
	if (!projectServiceCategories.includes(data.category)) {
		throw new Error(`Unknown project service category: ${String(data.category)}.`);
	}
	const environment = configuration.environments.find((entry) => entry.id === data.environmentId);
	if (!environment) {
		throw new Error(`Unknown project service environment: ${String(data.environmentId)}.`);
	}
	environment.services[data.category as ProjectServiceCategory] = validateServiceSettings(data.settings, data.category, environment.id);
	configuration.revision++;
	writeConfiguration(scene, configuration);
	return clone(configuration);
}

export function setProjectServiceResources(scene: Scene, data: any): IProjectServicesControlConfiguration {
	const configuration = readConfiguration(scene);
	expectedRevision(configuration, data.expectedRevision);
	const environment = configuration.environments.find((entry) => entry.id === data.environmentId);
	if (!environment) {
		throw new Error(`Unknown project service environment: ${String(data.environmentId)}.`);
	}
	environment.resources = validateProjectServiceResources(data.resources);
	configuration.revision++;
	writeConfiguration(scene, configuration);
	return clone(configuration);
}

function endpointFinding(category: ProjectServiceCategory, settings: IProjectServiceSettings): IProjectServiceFinding | null {
	if (!settings.endpoint) {
		return ["rest", "local"].includes(settings.provider)
			? {
					code: "endpoint_required",
					severity: "error",
					category,
					message: `${category} provider ${settings.provider} requires an endpoint.`,
					remediation: "Set an HTTPS endpoint or start the loopback emulator.",
				}
			: {
					code: "provider_sdk_required",
					severity: "info",
					category,
					message: `${category} is routed through provider SDK ${settings.provider}.`,
					remediation: "Install and initialize that provider SDK in game code.",
				};
	}
	try {
		const url = new URL(settings.endpoint);
		const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
		if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
			throw new Error();
		}
		return null;
	} catch {
		return {
			code: "endpoint_invalid",
			severity: "error",
			category,
			message: `${category} endpoint is not secure and valid.`,
			remediation: "Use HTTPS, or loopback HTTP, without credentials, query parameters, or fragments.",
		};
	}
}

export async function validateProjectServicesReadiness(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = readConfiguration(scene);
	const environmentId = data.environmentId ?? configuration.activeEnvironmentId;
	const environment = configuration.environments.find((entry) => entry.id === environmentId);
	if (!environment) {
		throw new Error(`Unknown project service environment: ${String(environmentId)}.`);
	}
	const findings: IProjectServiceFinding[] = [];
	const enabledCategories = projectServiceCategories.filter((category) => environment.services[category].enabled);
	for (const category of enabledCategories) {
		const finding = endpointFinding(category, environment.services[category]);
		if (finding) {
			findings.push(finding);
		}
	}
	if (!enabledCategories.length) {
		findings.push({
			code: "no_services_enabled",
			severity: "warning",
			category: "configuration",
			message: "No project service is enabled in this environment.",
			remediation: "Enable the service categories the game uses.",
		});
	}
	const packageContext = await getProjectPackageContext(options);
	for (const definition of environment.resources.cloudFunctions) {
		const target = join(packageContext.projectRoot, definition.entryPoint);
		const details = await lstat(target).catch(() => null);
		if (!details?.isFile() || details.isSymbolicLink()) {
			findings.push({
				code: "cloud_function_entry_missing",
				severity: "error",
				category: "cloudFunctions",
				message: `Cloud Function ${definition.id} entry point ${definition.entryPoint} is missing or symbolic.`,
				remediation: "Create the contained project JavaScript/TypeScript entry point before deployment.",
			});
		}
	}
	const scriptAvailable = typeof packageContext.manifest.scripts?.[environment.deployment.script] === "string";
	if (!scriptAvailable) {
		findings.push({
			code: "deployment_script_missing",
			severity: "warning",
			category: "deployment",
			message: `Package script ${environment.deployment.script} is not configured.`,
			remediation: "Add the fixed project package script before remote provisioning or deployment.",
		});
	}
	const credentialEnvironmentVariables = environment.deployment.credentialEnvironmentVariables.map((name) => ({
		name,
		available: typeof process.env[name] === "string" && process.env[name]!.length > 0,
	}));
	for (const credential of credentialEnvironmentVariables.filter((entry) => !entry.available)) {
		findings.push({
			code: "credential_unavailable",
			severity: "error",
			category: "deployment",
			message: `${credential.name} is not available in the editor environment.`,
			remediation: "Set the credential environment variable and restart the editor without placing its value in project files.",
		});
	}
	const errorCount = findings.filter((finding) => finding.severity === "error").length;
	return {
		version: PROJECT_SERVICES_CONTROL_VERSION,
		configurationRevision: configuration.revision,
		environment: clone(environment),
		enabledCategories,
		readiness: {
			runtime: enabledCategories.length > 0 && findings.every((finding) => finding.category === "deployment" || finding.severity !== "error"),
			deployment: scriptAvailable && errorCount === 0,
		},
		deployment: { scriptAvailable, credentialEnvironmentVariables },
		findings,
		summary: { errorCount, warningCount: findings.filter((finding) => finding.severity === "warning").length, findingCount: findings.length },
	};
}
