import { createHash, randomUUID } from "crypto";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { BuildTarget, listBuildProfiles } from "./export";
import { getPlatformDiagnostics } from "./platforms";

const restartPlanLifetimeMs = 5 * 60 * 1000;
const maximumPlansPerScene = 20;
const restartableTargets = new Set<BuildTarget>(["web", "electron", "headless", "android", "ios"]);

export interface IInstalledPlatformRestartPlan {
	id: string;
	target: BuildTarget;
	projectPath: string;
	configurationRevision: number;
	diagnosticFingerprint: string;
	createdAt: string;
	expiresAt: string;
	summary: string;
}

const plans = new WeakMap<Scene, Map<string, IInstalledPlatformRestartPlan>>();

function target(value: unknown): BuildTarget {
	if (!restartableTargets.has(value as BuildTarget)) {
		throw new Error("target must be web, electron, headless, android, or ios.");
	}
	return value as BuildTarget;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function expectedFingerprint(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error("expectedDiagnosticFingerprint must be a lowercase SHA-256 fingerprint.");
	}
	return value;
}

function planMap(scene: Scene): Map<string, IInstalledPlatformRestartPlan> {
	let map = plans.get(scene);
	if (!map) {
		map = new Map();
		plans.set(scene, map);
	}
	const now = Date.now();
	for (const [id, plan] of map) {
		if (Date.parse(plan.expiresAt) <= now) {
			map.delete(id);
		}
	}
	return map;
}

async function platformSnapshot(scene: Scene, requestedTarget: BuildTarget, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const configuration = listBuildProfiles(scene);
	const diagnostic = (await getPlatformDiagnostics(scene, { target: requestedTarget }, options)).diagnostics[0];
	const profiles = configuration.profiles.filter((profile) => profile.target === requestedTarget);
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const evidence = options.editor.platformRestartEvidence ?? null;
	const fingerprintSource = {
		configurationRevision: configuration.revision,
		target: requestedTarget,
		profiles: profiles.map((profile) => ({ id: profile.id, enabled: profile.enabled })),
		host: diagnostic.host,
		commands: diagnostic.commands,
		environment: diagnostic.environment,
		scaffold: diagnostic.scaffold
			? { exists: diagnostic.scaffold.exists, revision: diagnostic.scaffold.revision ?? 0, integrity: diagnostic.scaffold.integrity ?? null }
			: null,
		packageScript: diagnostic.packageScript ?? null,
		readyForProjectExport: diagnostic.readyForProjectExport,
		readyForNativePackage: diagnostic.readyForNativePackage,
	};
	return {
		version: 1,
		target: requestedTarget,
		projectPath,
		configurationRevision: configuration.revision,
		diagnosticFingerprint: sha256(fingerprintSource),
		installed: diagnostic.readyForProjectExport === true,
		nativeToolchainReady: diagnostic.readyForNativePackage === true,
		profiles,
		diagnostic,
		startupEvidence: evidence && evidence.target === requestedTarget ? evidence : null,
	};
}

/** Reads exact installed-platform restart readiness and evidence from the latest application launch. */
export async function getInstalledPlatformRestartStatus(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	return platformSnapshot(scene, target(input.target), options);
}

/** Creates a short-lived single-use restart lease for one currently installed project platform. */
export async function planInstalledPlatformRestart(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<IInstalledPlatformRestartPlan> {
	const input = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const requestedTarget = target(input.target);
	const expected = expectedFingerprint(input.expectedDiagnosticFingerprint);
	const snapshot = await platformSnapshot(scene, requestedTarget, options);
	if (snapshot.diagnosticFingerprint !== expected) {
		throw new Error(`Platform diagnostics changed; expected ${expected} but found ${snapshot.diagnosticFingerprint}. Refresh before retrying.`);
	}
	if (snapshot.installed !== true) {
		throw new Error(`Platform support for ${requestedTarget} is not installed in this project. Generate/configure its scaffold and package script before restarting.`);
	}
	const now = Date.now();
	const plan: IInstalledPlatformRestartPlan = {
		id: randomUUID(),
		target: requestedTarget,
		projectPath: String(snapshot.projectPath),
		configurationRevision: Number(snapshot.configurationRevision),
		diagnosticFingerprint: expected,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + restartPlanLifetimeMs).toISOString(),
		summary: `Save, relaunch Zvibe Editor, and reopen ${requestedTarget} platform support for the current project`,
	};
	const map = planMap(scene);
	if (map.size >= maximumPlansPerScene) {
		map.delete(map.keys().next().value!);
	}
	map.set(plan.id, plan);
	return plan;
}

/** Saves the project and requests one exact, non-expired, single-use Electron relaunch. */
export async function restartEditorForInstalledPlatform(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	if (input.confirm !== true) {
		throw new Error("confirm must be true to save and restart Zvibe Editor.");
	}
	if (typeof input.planId !== "string" || !/^[a-f0-9-]{36}$/.test(input.planId)) {
		throw new Error("planId must be a valid restart plan identifier.");
	}
	const expected = expectedFingerprint(input.expectedDiagnosticFingerprint);
	const map = planMap(scene);
	const plan = map.get(input.planId);
	if (!plan) {
		throw new Error("Installed-platform restart plan is missing or expired; create a fresh plan before restarting.");
	}
	map.delete(plan.id);
	const snapshot = await platformSnapshot(scene, plan.target, options);
	if (
		expected !== plan.diagnosticFingerprint ||
		snapshot.diagnosticFingerprint !== plan.diagnosticFingerprint ||
		snapshot.configurationRevision !== plan.configurationRevision ||
		snapshot.projectPath !== plan.projectPath ||
		snapshot.installed !== true
	) {
		throw new Error("Installed-platform state changed after planning. Refresh status and create a new restart plan.");
	}
	const accepted = await options.editor.restartForInstalledPlatform({
		target: plan.target,
		planId: plan.id,
		projectPath: plan.projectPath,
		diagnosticFingerprint: plan.diagnosticFingerprint,
		requestedAt: new Date().toISOString(),
	});
	return { accepted: true, plan, relaunch: accepted };
}
