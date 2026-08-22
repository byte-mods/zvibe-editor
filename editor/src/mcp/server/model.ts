export const CONSOLE_SERVER_CONFIGURATION_VERSION = 1 as const;

export type ServerDeploymentProvider = "local" | "container" | "kubernetes" | "console";
export type ServerContainerEngine = "docker" | "podman";

export interface IConsoleServerConfiguration {
	version: typeof CONSOLE_SERVER_CONFIGURATION_VERSION;
	revision: number;
	headless: {
		buildProfileId: string | null;
		initialScenePath: string | null;
		publicHost: string;
		port: number;
		tickRate: number;
		maximumCatchUpSteps: number;
		maximumPlayers: number;
		joinCodeEnvironment: string;
		healthPath: string;
		metricsPath: string;
	};
	container: {
		engine: ServerContainerEngine;
		image: string;
		dockerfilePath: string;
		registryCredentialEnvironment: string | null;
	};
	deployment: {
		provider: ServerDeploymentProvider;
		replicas: number;
		namespace: string;
		kubeContext: string | null;
		consoleProviderId: string | null;
	};
	observability: {
		logLimitBytes: number;
		metrics: boolean;
		portableProfiling: boolean;
	};
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const environmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const imagePattern = /^[A-Za-z0-9][A-Za-z0-9./_:@-]{0,255}$/;
const routePattern = /^\/[A-Za-z0-9/_-]{0,127}$/;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function optionalString(value: unknown, fallback: string | null, maximum: number): string | null {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : fallback;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	const result = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(result) || Number(result) < minimum || Number(result) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return Number(result);
}

function projectPath(value: unknown, fallback: string, label: string): string {
	const result = optionalString(value, fallback, 1_024)!.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!result || result.startsWith("/") || /^[A-Za-z]:\//.test(result) || result.split("/").includes("..")) {
		throw new Error(`${label} must be a project-relative path without traversal.`);
	}
	return result;
}

export function createDefaultConsoleServerConfiguration(): IConsoleServerConfiguration {
	return {
		version: CONSOLE_SERVER_CONFIGURATION_VERSION,
		revision: 1,
		headless: {
			buildProfileId: null,
			initialScenePath: null,
			publicHost: "127.0.0.1",
			port: 7777,
			tickRate: 30,
			maximumCatchUpSteps: 4,
			maximumPlayers: 64,
			joinCodeEnvironment: "ZVIBE_SERVER_JOIN_CODE",
			healthPath: "/health",
			metricsPath: "/metrics",
		},
		container: {
			engine: "docker",
			image: "zvibe/game-server:latest",
			dockerfilePath: ".zvibe/platforms/headless/Dockerfile",
			registryCredentialEnvironment: null,
		},
		deployment: {
			provider: "local",
			replicas: 1,
			namespace: "default",
			kubeContext: null,
			consoleProviderId: null,
		},
		observability: { logLimitBytes: 65_536, metrics: true, portableProfiling: true },
	};
}

/** Normalizes legacy/partial metadata into one strict non-secret configuration. */
export function normalizeConsoleServerConfiguration(value: unknown): IConsoleServerConfiguration {
	const defaults = createDefaultConsoleServerConfiguration();
	if (value === undefined || value === null) {
		return defaults;
	}
	const source = record(value, "Console/server configuration");
	exactKeys(source, ["version", "revision", "headless", "container", "deployment", "observability"], "Console/server configuration");
	const headless = source.headless === undefined ? {} : record(source.headless, "Headless configuration");
	const container = source.container === undefined ? {} : record(source.container, "Container configuration");
	const deployment = source.deployment === undefined ? {} : record(source.deployment, "Deployment configuration");
	const observability = source.observability === undefined ? {} : record(source.observability, "Observability configuration");
	exactKeys(headless, Object.keys(defaults.headless), "Headless configuration");
	exactKeys(container, Object.keys(defaults.container), "Container configuration");
	exactKeys(deployment, Object.keys(defaults.deployment), "Deployment configuration");
	exactKeys(observability, Object.keys(defaults.observability), "Observability configuration");
	const result: IConsoleServerConfiguration = {
		version: CONSOLE_SERVER_CONFIGURATION_VERSION,
		revision: integer(source.revision, defaults.revision, 1, Number.MAX_SAFE_INTEGER, "Console/server revision"),
		headless: {
			buildProfileId: optionalString(headless.buildProfileId, null, 160),
			initialScenePath: optionalString(headless.initialScenePath, null, 1_024),
			publicHost: optionalString(headless.publicHost, defaults.headless.publicHost, 255)!,
			port: integer(headless.port, defaults.headless.port, 1_024, 65_535, "Headless port"),
			tickRate: integer(headless.tickRate, defaults.headless.tickRate, 1, 240, "Headless tickRate"),
			maximumCatchUpSteps: integer(headless.maximumCatchUpSteps, defaults.headless.maximumCatchUpSteps, 1, 16, "Headless maximumCatchUpSteps"),
			maximumPlayers: integer(headless.maximumPlayers, defaults.headless.maximumPlayers, 1, 256, "Headless maximumPlayers"),
			joinCodeEnvironment: optionalString(headless.joinCodeEnvironment, defaults.headless.joinCodeEnvironment, 128)!,
			healthPath: optionalString(headless.healthPath, defaults.headless.healthPath, 128)!,
			metricsPath: optionalString(headless.metricsPath, defaults.headless.metricsPath, 128)!,
		},
		container: {
			engine: container.engine === "podman" ? "podman" : "docker",
			image: optionalString(container.image, defaults.container.image, 256)!,
			dockerfilePath: projectPath(container.dockerfilePath, defaults.container.dockerfilePath, "Container dockerfilePath"),
			registryCredentialEnvironment: optionalString(container.registryCredentialEnvironment, null, 128),
		},
		deployment: {
			provider: ["local", "container", "kubernetes", "console"].includes(String(deployment.provider))
				? (deployment.provider as ServerDeploymentProvider)
				: defaults.deployment.provider,
			replicas: integer(deployment.replicas, defaults.deployment.replicas, 0, 256, "Deployment replicas"),
			namespace: optionalString(deployment.namespace, defaults.deployment.namespace, 128)!,
			kubeContext: optionalString(deployment.kubeContext, null, 256),
			consoleProviderId: optionalString(deployment.consoleProviderId, null, 128),
		},
		observability: {
			logLimitBytes: integer(observability.logLimitBytes, defaults.observability.logLimitBytes, 1_024, 1_048_576, "Observability logLimitBytes"),
			metrics: observability.metrics !== false,
			portableProfiling: observability.portableProfiling !== false,
		},
	};
	validateConsoleServerConfiguration(result);
	return result;
}

/** Rejects unsafe identifiers, routes, secrets, and contradictory provider settings. */
export function validateConsoleServerConfiguration(value: IConsoleServerConfiguration): void {
	if (value.version !== CONSOLE_SERVER_CONFIGURATION_VERSION) {
		throw new Error(`Console/server configuration version must be ${CONSOLE_SERVER_CONFIGURATION_VERSION}.`);
	}
	if (!/^[A-Za-z0-9.:-]{1,255}$/.test(value.headless.publicHost) || ["0.0.0.0", "::"].includes(value.headless.publicHost)) {
		throw new Error("Headless publicHost must be a concrete hostname or IP address.");
	}
	if (![value.headless.healthPath, value.headless.metricsPath].every((route) => routePattern.test(route)) || value.headless.healthPath === value.headless.metricsPath) {
		throw new Error("Headless healthPath and metricsPath must be distinct safe absolute routes.");
	}
	if (value.headless.buildProfileId && !identifierPattern.test(value.headless.buildProfileId)) {
		throw new Error("Headless buildProfileId is invalid.");
	}
	if (!environmentPattern.test(value.headless.joinCodeEnvironment)) {
		throw new Error("Headless joinCodeEnvironment must name an environment variable.");
	}
	if (value.headless.initialScenePath !== null) {
		const path = projectPath(value.headless.initialScenePath, "assets/example.scene", "Headless initialScenePath");
		if (!path.endsWith(".scene")) {
			throw new Error("Headless initialScenePath must end in .scene.");
		}
	}
	if (!imagePattern.test(value.container.image)) {
		throw new Error("Container image is invalid.");
	}
	if (value.container.registryCredentialEnvironment && !environmentPattern.test(value.container.registryCredentialEnvironment)) {
		throw new Error("Container registryCredentialEnvironment must name an environment variable.");
	}
	if (!/^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/.test(value.deployment.namespace)) {
		throw new Error("Deployment namespace must be a DNS-compatible name.");
	}
	if (value.deployment.consoleProviderId && !identifierPattern.test(value.deployment.consoleProviderId)) {
		throw new Error("Deployment consoleProviderId is invalid.");
	}
	if (value.deployment.provider === "console" && !value.deployment.consoleProviderId) {
		throw new Error("Console deployment requires consoleProviderId.");
	}
}
