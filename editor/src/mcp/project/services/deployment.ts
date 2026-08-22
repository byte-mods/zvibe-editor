import { createHash, randomUUID } from "crypto";
import { rename, rm, writeFile } from "fs/promises";
import { join, relative } from "path";

import { Scene } from "babylonjs";
import { projectServiceCategories } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../../action";
import { getProjectPackageContext } from "../package-manager/context";
import { cancelProjectPackageProcess, runProjectPackageProcess } from "../package-manager/process";
import { IProjectPackageCommand, ProjectPackageManager } from "../package-manager/types";
import { ensureProjectStoreDirectory } from "../project-store";
import { getProjectServicesConfiguration, validateProjectServicesReadiness } from "./configuration";
import { IProjectServiceEnvironment, IProjectServicesDeploymentPlan, IProjectServicesDeploymentReport, PROJECT_SERVICES_REPORT_LIMIT } from "./types";

const planLifetimeMs = 10 * 60 * 1000;
const defaultTimeoutMs = 10 * 60 * 1000;
const maximumTimeoutMs = 30 * 60 * 1000;
const plansByScene = new WeakMap<Scene, Map<string, IProjectServicesDeploymentPlan>>();
const deploymentsInProgress = new WeakSet<Scene>();

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonical(entry)])
		);
	}
	return value;
}

function fingerprint(environment: IProjectServiceEnvironment, revision: number, projectFingerprint: string, dryRun: boolean, reconcile: boolean): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical({ environment, revision, projectFingerprint, dryRun, reconcile })))
		.digest("hex");
}

function planMap(scene: Scene): Map<string, IProjectServicesDeploymentPlan> {
	let plans = plansByScene.get(scene);
	if (!plans) {
		plans = new Map();
		plansByScene.set(scene, plans);
	}
	const now = Date.now();
	for (const [id, plan] of plans) {
		if (Date.parse(plan.expiresAt) <= now) {
			plans.delete(id);
		}
	}
	return plans;
}

function quoteDisplayArgument(value: string): string {
	return /^[A-Za-z0-9_./:@=+^~,-]+$/.test(value) ? value : JSON.stringify(value);
}

function deploymentCommand(
	manager: ProjectPackageManager,
	script: string,
	environmentId: string,
	artifactPath: string,
	dryRun: boolean,
	reconcile: boolean
): IProjectPackageCommand {
	const scriptArguments = ["--environment", environmentId, "--config", artifactPath, ...(dryRun ? ["--dry-run"] : []), ...(reconcile ? ["--reconcile"] : [])];
	const args = ["run", script, ...(["npm", "pnpm"].includes(manager) ? ["--"] : []), ...scriptArguments];
	return { command: manager, args, display: [manager, ...args].map(quoteDisplayArgument).join(" ") };
}

function timeout(value: unknown): number {
	const result = value ?? defaultTimeoutMs;
	if (!Number.isSafeInteger(result) || Number(result) < 1_000 || Number(result) > maximumTimeoutMs) {
		throw new Error(`timeoutMs must be an integer from 1000 through ${maximumTimeoutMs}.`);
	}
	return Number(result);
}

/** Produces a short-lived, immutable deployment intent without writing files or invoking project code. */
export async function planProjectServicesDeployment(scene: Scene, data: any, options: IMCPActionOptions): Promise<IProjectServicesDeploymentPlan> {
	const configuration = getProjectServicesConfiguration(scene, {});
	if (!Number.isSafeInteger(data?.expectedRevision) || data.expectedRevision !== configuration.revision) {
		throw new Error(`expectedRevision must equal current project services revision ${configuration.revision}.`);
	}
	const environmentId = data.environmentId ?? configuration.activeEnvironmentId;
	const environment = configuration.environments.find((entry) => entry.id === environmentId);
	if (!environment) {
		throw new Error(`Unknown project service environment: ${String(environmentId)}.`);
	}
	const dryRun = data.dryRun !== false;
	const reconcile = data.reconcile === true;
	if ((data.dryRun !== undefined && typeof data.dryRun !== "boolean") || (data.reconcile !== undefined && typeof data.reconcile !== "boolean")) {
		throw new Error("dryRun and reconcile must be booleans when provided.");
	}
	const deploymentTimeout = timeout(data.timeoutMs);
	const readiness = await validateProjectServicesReadiness(scene, { environmentId }, options);
	const context = await getProjectPackageContext(options);
	const artifactPath = `.zvibe/services/environments/${environment.id}.json`;
	const command = deploymentCommand(context.packageManager, environment.deployment.script, environment.id, artifactPath, dryRun, reconcile);
	const planFingerprint = fingerprint(environment, configuration.revision, context.fingerprint, dryRun, reconcile);
	const createdAtMs = Date.now();
	const plan: IProjectServicesDeploymentPlan = {
		id: randomUUID(),
		createdAt: new Date(createdAtMs).toISOString(),
		expiresAt: new Date(createdAtMs + planLifetimeMs).toISOString(),
		configurationRevision: configuration.revision,
		environmentId: environment.id,
		dryRun,
		reconcile,
		fingerprint: planFingerprint,
		projectFingerprint: context.fingerprint,
		valid: readiness.readiness.deployment,
		script: environment.deployment.script,
		command: command.display,
		artifactPath,
		timeoutMs: deploymentTimeout,
		credentialEnvironmentVariables: readiness.deployment.credentialEnvironmentVariables,
		enabledCategories: projectServiceCategories.filter((category) => environment.services[category].enabled),
		resourceCounts: {
			analyticsEvents: environment.resources.analyticsEvents.length,
			iapProducts: environment.resources.iapProducts.length,
			adPlacements: environment.resources.adPlacements.length,
			matchmakingQueues: environment.resources.matchmakingQueues.length,
			leaderboards: environment.resources.leaderboards.length,
			remoteConfig: environment.resources.remoteConfig.length,
			contentDeliveryBuckets: environment.resources.contentDeliveryBuckets.length,
			cloudFunctions: environment.resources.cloudFunctions.length,
		},
		findings: readiness.findings,
	};
	planMap(scene).set(plan.id, plan);
	return clone(plan);
}

function reports(scene: Scene): IProjectServicesDeploymentReport[] {
	const value = scene.metadata?.babylonEditorServicesDeploymentReports;
	if (!Array.isArray(value)) {
		return [];
	}
	return value.slice(0, PROJECT_SERVICES_REPORT_LIMIT).filter((entry): entry is IProjectServicesDeploymentReport => {
		return (
			entry &&
			typeof entry === "object" &&
			typeof entry.id === "string" &&
			typeof entry.planId === "string" &&
			typeof entry.environmentId === "string" &&
			typeof entry.fingerprint === "string" &&
			["succeeded", "failed", "timed-out", "canceled"].includes(entry.status) &&
			typeof entry.stdout === "string" &&
			entry.stdout.length <= 64 * 1024 &&
			typeof entry.stderr === "string" &&
			entry.stderr.length <= 64 * 1024
		);
	});
}

function storeReport(scene: Scene, report: IProjectServicesDeploymentReport): void {
	const entries = reports(scene);
	entries.unshift(clone(report));
	entries.splice(PROJECT_SERVICES_REPORT_LIMIT);
	(scene.metadata ??= {}).babylonEditorServicesDeploymentReports = entries;
}

/** Executes only a previously reviewed plan and rejects any scene or package drift since planning. */
export async function deployProjectServices(scene: Scene, data: any, options: IMCPActionOptions): Promise<IProjectServicesDeploymentReport> {
	if (data?.confirm !== true) {
		throw new Error("Deploying project services requires confirm=true.");
	}
	const plan = planMap(scene).get(data.planId);
	if (!plan) {
		throw new Error(`Services deployment plan ${String(data.planId)} is missing or expired; create a fresh plan.`);
	}
	if (data.expectedFingerprint !== plan.fingerprint) {
		throw new Error(`expectedFingerprint must exactly match services deployment plan fingerprint ${plan.fingerprint}.`);
	}
	if (!plan.valid) {
		throw new Error("The services deployment plan has blocking readiness findings; resolve them and create a fresh plan.");
	}
	if (deploymentsInProgress.has(scene)) {
		throw new Error("A project services deployment is already running for this scene.");
	}
	const configuration = getProjectServicesConfiguration(scene, {});
	const environment = configuration.environments.find((entry) => entry.id === plan.environmentId);
	const context = await getProjectPackageContext(options);
	if (!environment || configuration.revision !== plan.configurationRevision || context.fingerprint !== plan.projectFingerprint) {
		throw new Error("Project services or package state changed after planning; create a fresh deployment plan.");
	}
	const currentFingerprint = fingerprint(environment, configuration.revision, context.fingerprint, plan.dryRun, plan.reconcile);
	if (currentFingerprint !== plan.fingerprint) {
		throw new Error("Project service environment content changed after planning; create a fresh deployment plan.");
	}
	deploymentsInProgress.add(scene);
	try {
		const directory = await ensureProjectStoreDirectory(context.projectRoot, ".zvibe", "services", "environments");
		const target = join(directory, `${environment.id}.json`);
		const temporary = join(directory, `.${environment.id}.${randomUUID()}.tmp`);
		const artifact = {
			version: 1,
			generatedAt: new Date().toISOString(),
			configurationRevision: configuration.revision,
			fingerprint: plan.fingerprint,
			environment,
		};
		try {
			await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, target);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
		const command = deploymentCommand(
			context.packageManager,
			plan.script,
			environment.id,
			relative(context.projectRoot, target).replace(/\\/g, "/"),
			plan.dryRun,
			plan.reconcile
		);
		const processResult = await runProjectPackageProcess(scene, context.projectRoot, command, {
			kind: `services-deployment:${environment.id}`,
			timeoutMs: plan.timeoutMs,
			maximumOutputBytes: 64 * 1024,
		});
		const report: IProjectServicesDeploymentReport = {
			id: randomUUID(),
			planId: plan.id,
			environmentId: environment.id,
			fingerprint: plan.fingerprint,
			dryRun: plan.dryRun,
			reconcile: plan.reconcile,
			startedAt: processResult.startedAt,
			finishedAt: processResult.finishedAt,
			durationMs: processResult.durationMs,
			status: processResult.status,
			exitCode: processResult.exitCode,
			command: processResult.display,
			stdout: processResult.stdout,
			stderr: processResult.stderr,
			outputTruncated: processResult.outputTruncated,
			artifactPath: plan.artifactPath,
		};
		storeReport(scene, report);
		planMap(scene).delete(plan.id);
		return clone(report);
	} finally {
		deploymentsInProgress.delete(scene);
	}
}

export function listProjectServicesDeploymentReports(scene: Scene): IProjectServicesDeploymentReport[] {
	return clone(reports(scene));
}

export function getProjectServicesDeploymentReport(scene: Scene, data: any): IProjectServicesDeploymentReport {
	const report = reports(scene).find((entry) => entry.id === data?.reportId);
	if (!report) {
		throw new Error(`Unknown project services deployment report: ${String(data?.reportId)}.`);
	}
	return clone(report);
}

export function deleteProjectServicesDeploymentReport(scene: Scene, data: any): { deleted: boolean; reportId: string } {
	if (data?.confirm !== true) {
		throw new Error("Deleting a project services deployment report requires confirm=true.");
	}
	const entries = reports(scene);
	const index = entries.findIndex((entry) => entry.id === data?.reportId);
	if (index === -1) {
		throw new Error(`Unknown project services deployment report: ${String(data?.reportId)}.`);
	}
	entries.splice(index, 1);
	(scene.metadata ??= {}).babylonEditorServicesDeploymentReports = entries;
	return { deleted: true, reportId: data.reportId };
}

export async function cancelProjectServicesDeployment(scene: Scene, data: any): Promise<any> {
	return cancelProjectPackageProcess(scene, data);
}
