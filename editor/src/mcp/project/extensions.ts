import { randomUUID } from "crypto";

import { Scene } from "babylonjs";

import { editorExtensionFingerprint } from "../../extensions/manifest";
import {
	inspectProjectEditorExtensionsState,
	removeProjectEditorExtensionConfiguration,
	setProjectEditorExtensionEnabled,
	syncProjectEditorExtensions,
} from "../../extensions/project";
import { readEditorExtensionTrustRecords, revokeEditorExtensionTrust, trustEditorExtension } from "../../extensions/trust";
import { editorExtensionApiVersion, editorExtensionCapabilities, EditorExtensionCapability, IEditorExtensionTrustStorage } from "../../extensions/types";
import { saveProjectConfiguration } from "../../project/save/save";
import { IMCPActionOptions } from "../action";
import { listBuildProfiles } from "./export";

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const contributionIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const planLifetimeMs = 15 * 60 * 1000;
const maximumPlansPerScene = 20;

type EditorExtensionPlanOperation = "enable" | "disable" | "trust" | "revoke-trust" | "remove-configuration";

interface IEditorExtensionPlan {
	id: string;
	operation: EditorExtensionPlanOperation;
	packageName: string;
	sourceFingerprint: string;
	extensionFingerprint: string | null;
	capabilities: EditorExtensionCapability[];
	createdAt: string;
	expiresAt: string;
	summary: string;
}

const plans = new WeakMap<Scene, Map<string, IEditorExtensionPlan>>();

function storage(): IEditorExtensionTrustStorage {
	if (typeof localStorage === "undefined") {
		throw new Error("Editor extension trust storage is unavailable outside the editor renderer.");
	}
	return localStorage;
}

function packageName(value: unknown): string {
	if (typeof value !== "string" || value.length > 214 || !packageNamePattern.test(value)) {
		throw new Error("packageName must be a valid direct npm package name of at most 214 characters.");
	}
	return value;
}

function fingerprint(value: unknown, label: string): string {
	if (typeof value !== "string" || !fingerprintPattern.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 fingerprint.`);
	}
	return value;
}

function contributionId(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length > 160 || !contributionIdPattern.test(value)) {
		throw new Error(`${label} must be a valid lowercase extension contribution id of at most 160 characters.`);
	}
	return value;
}

function snapshotFingerprint(snapshot: Awaited<ReturnType<typeof inspectProjectEditorExtensionsState>>): string {
	// Include the complete grant (including trustedAt), not just a trusted boolean, so revoke/re-grant races cannot recreate an apparently identical lease.
	const trustRecords = readEditorExtensionTrustRecords(storage())
		.filter(
			(record) =>
				snapshot.configured.some((entry) => entry.packageName === record.packageName) ||
				snapshot.extensions.some((view) => view.extension.packageName === record.packageName)
		)
		.map((record) => ({ ...record, capabilities: [...record.capabilities].sort() }))
		.sort((left, right) => left.packageName.localeCompare(right.packageName));
	return editorExtensionFingerprint({
		packageManagerFingerprint: snapshot.packageManagerFingerprint,
		configured: snapshot.configured,
		extensions: snapshot.extensions.map((view) => ({ packageName: view.extension.packageName, fingerprint: view.extension.fingerprint })),
		trustRecords,
	});
}

function publicSnapshot(snapshot: Awaited<ReturnType<typeof inspectProjectEditorExtensionsState>>): Record<string, unknown> {
	return {
		projectRoot: snapshot.projectRoot,
		packageManagerFingerprint: snapshot.packageManagerFingerprint,
		fingerprint: snapshotFingerprint(snapshot),
		configured: snapshot.configured,
		extensions: snapshot.extensions.map((view) => ({
			packageName: view.extension.packageName,
			packageVersion: view.extension.packageVersion,
			fingerprint: view.extension.fingerprint,
			packageJsonSha256: view.extension.packageJsonSha256,
			entrySha256: view.extension.entrySha256,
			contentSha256: view.extension.contentSha256,
			contentFileCount: view.extension.contentFileCount,
			contentBytes: view.extension.contentBytes,
			manifest: view.extension.manifest,
			enabled: view.enabled,
			trusted: view.trusted,
			runtime: view.runtime,
		})),
		issues: snapshot.issues,
		runtime: snapshot.runtime,
	};
}

async function currentSnapshot(options: IMCPActionOptions): Promise<Awaited<ReturnType<typeof inspectProjectEditorExtensionsState>>> {
	return inspectProjectEditorExtensionsState(options.editor, { trustStorage: storage() });
}

function extensionView(snapshot: Awaited<ReturnType<typeof inspectProjectEditorExtensionsState>>, requestedPackageName: string) {
	return snapshot.extensions.find((view) => view.extension.packageName === requestedPackageName) ?? null;
}

function getPlanMap(scene: Scene): Map<string, IEditorExtensionPlan> {
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

function buildProfileActionContext(scene: Scene, requestedProfileId?: unknown) {
	const configuration = listBuildProfiles(scene);
	if (requestedProfileId !== undefined && (typeof requestedProfileId !== "string" || !requestedProfileId || requestedProfileId.length > 128)) {
		throw new Error("profileId must be a non-empty Build Profile id of at most 128 characters.");
	}
	const profileId = requestedProfileId ?? configuration.activeProfileId;
	if (!profileId) {
		throw new Error("No Build Profile is selected. Select an active profile or provide profileId.");
	}
	const profile = configuration.profiles.find((candidate) => candidate.id === profileId);
	if (!profile) {
		throw new Error(`Build Profile "${profileId}" was not found. Refresh list_build_profiles before retrying.`);
	}
	return {
		configurationRevision: configuration.revision,
		isActive: configuration.activeProfileId === profile.id,
		profile: {
			id: profile.id,
			name: profile.name,
			target: profile.target,
			enabled: profile.enabled,
			options: { ...profile.options },
			settings: structuredClone(profile.settings) as unknown as Record<string, unknown>,
		},
	};
}

/** Describes the stable extension SDK contract without inspecting or executing third-party packages. */
export function getEditorExtensionSdk(): Record<string, unknown> {
	return {
		apiVersion: editorExtensionApiVersion,
		packageManifestField: "zvibeEditor",
		module: { format: "CommonJS", requiredExport: "activate(context)", optionalExport: "deactivate()" },
		capabilities: [...editorExtensionCapabilities],
		contributions: {
			inspectors: { fields: ["id", "title", "priority"], capability: "inspectors" },
			windows: { fields: ["id", "title", "neighborId"], capability: "windows" },
			menus: { fields: ["id", "path"], capability: "menus" },
			tests: { fields: ["id", "title"], capability: "tests" },
			buildProfileFooterActions: {
				fields: ["id", "title", "description", "order", "targets", "activeProfileOnly"],
				capability: "buildProfiles",
				runtimeContext: ["configurationRevision", "isActive", "profile"],
			},
		},
		lifecycle: ["discover", "inspect", "trust exact content and capabilities", "activate", "dispose or reload"],
		security: {
			directDependenciesOnly: true,
			machineLocalTrust: true,
			trustBoundToExactFingerprint: true,
			capabilityGatedContext: true,
			packageMutationOwnedByPackageManager: true,
		},
		limits: { configuredExtensions: 128, activeExtensions: 128, contributions: 512, testsPerRun: 100, testTimeoutMs: 30_000, actionTimeoutMs: 30_000 },
	};
}

/** Lists installed editor extensions without activating, disposing, or otherwise executing their code. */
export async function listEditorExtensions(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const offset = input.offset ?? 0;
	const limit = input.limit ?? 100;
	const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
	if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 1_000_000) {
		throw new Error("offset must be an integer from 0 through 1000000.");
	}
	if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
		throw new Error("limit must be an integer from 1 through 100.");
	}
	if (query.length > 214) {
		throw new Error("query must be at most 214 characters.");
	}
	const snapshot = await currentSnapshot(options);
	const result = publicSnapshot(snapshot);
	const allExtensions = (result.extensions as Array<Record<string, unknown>>).filter((extension) => {
		const manifest = extension.manifest as { id: string; displayName: string };
		return !query || String(extension.packageName).toLowerCase().includes(query) || manifest.id.includes(query) || manifest.displayName.toLowerCase().includes(query);
	});
	const page = allExtensions.slice(Number(offset), Number(offset) + Number(limit));
	return {
		...result,
		extensions: page,
		offset: Number(offset),
		limit: Number(limit),
		count: page.length,
		total: allExtensions.length,
		hasMore: Number(offset) + page.length < allExtensions.length,
		nextOffset: Number(offset) + page.length < allExtensions.length ? Number(offset) + page.length : null,
	};
}

/** Creates a short-lived, exact-state lease for a shared enablement or machine-local trust mutation. */
export async function planEditorExtensionChange(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<IEditorExtensionPlan> {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Editor extension plan input must be an object.");
	}
	const input = data as Record<string, unknown>;
	const operation = input.operation;
	if (!(["enable", "disable", "trust", "revoke-trust", "remove-configuration"] as unknown[]).includes(operation)) {
		throw new Error("operation must be enable, disable, trust, revoke-trust, or remove-configuration.");
	}
	const requestedPackageName = packageName(input.packageName);
	const expectedStateFingerprint = fingerprint(input.expectedStateFingerprint, "expectedStateFingerprint");
	const snapshot = await currentSnapshot(options);
	const sourceFingerprint = snapshotFingerprint(snapshot);
	if (expectedStateFingerprint !== sourceFingerprint) {
		throw new Error(`Editor extension state changed since inspection; expected ${expectedStateFingerprint} but found ${sourceFingerprint}. Refresh before retrying.`);
	}
	const view = extensionView(snapshot, requestedPackageName);
	const configured = snapshot.configured.find((entry) => entry.packageName === requestedPackageName) ?? null;
	if ((operation === "enable" || operation === "trust" || operation === "revoke-trust") && !view) {
		throw new Error(`Package "${requestedPackageName}" is not an installed direct dependency with a valid zvibeEditor manifest.`);
	}
	if ((operation === "disable" || operation === "remove-configuration") && !configured) {
		throw new Error(`Package "${requestedPackageName}" has no editor extension configuration to change.`);
	}
	if (operation === "trust") {
		const requestedCapabilities = input.capabilities;
		if (
			!Array.isArray(requestedCapabilities) ||
			requestedCapabilities.length !== view!.extension.manifest.capabilities.length ||
			requestedCapabilities.some(
				(capability) => typeof capability !== "string" || !view!.extension.manifest.capabilities.includes(capability as EditorExtensionCapability)
			) ||
			new Set(requestedCapabilities).size !== requestedCapabilities.length
		) {
			throw new Error("capabilities must exactly match the currently inspected extension manifest.");
		}
	} else if (input.capabilities !== undefined) {
		throw new Error("capabilities is supported only when operation is trust.");
	}
	const now = Date.now();
	const plan: IEditorExtensionPlan = {
		id: randomUUID(),
		operation: operation as EditorExtensionPlanOperation,
		packageName: requestedPackageName,
		sourceFingerprint,
		extensionFingerprint: view?.extension.fingerprint ?? null,
		capabilities: view?.extension.manifest.capabilities ?? [],
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + planLifetimeMs).toISOString(),
		summary: `${String(operation)} editor extension ${requestedPackageName}`,
	};
	const map = getPlanMap(scene);
	if (map.size >= maximumPlansPerScene) {
		map.delete(map.keys().next().value!);
	}
	map.set(plan.id, plan);
	return plan;
}

/** Applies one exact, single-use extension plan and persists shared project configuration changes. */
export async function applyEditorExtensionPlan(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Editor extension apply input must be an object.");
	}
	const input = data as Record<string, unknown>;
	if (input.confirm !== true) {
		throw new Error("confirm must be true to apply an editor extension change plan.");
	}
	if (typeof input.planId !== "string" || input.planId.length > 64) {
		throw new Error("planId must be a valid plan identifier.");
	}
	const expectedStateFingerprint = fingerprint(input.expectedStateFingerprint, "expectedStateFingerprint");
	const map = getPlanMap(scene);
	const plan = map.get(input.planId);
	if (!plan) {
		throw new Error("Editor extension plan is missing or expired; create a fresh plan before applying changes.");
	}
	// Consume before the first awaited inspection: even a failed/stale attempt must not leave a destructive lease replayable.
	map.delete(plan.id);
	const snapshot = await currentSnapshot(options);
	const currentFingerprint = snapshotFingerprint(snapshot);
	if (expectedStateFingerprint !== plan.sourceFingerprint || currentFingerprint !== plan.sourceFingerprint) {
		throw new Error(`Editor extension state changed after planning; expected ${plan.sourceFingerprint} but found ${currentFingerprint}. Create a fresh plan.`);
	}
	const view = extensionView(snapshot, plan.packageName);
	if (plan.extensionFingerprint && view?.extension.fingerprint !== plan.extensionFingerprint) {
		throw new Error("Editor extension package content changed after planning; inspect and trust the new exact package content before retrying.");
	}
	if (plan.operation === "trust") {
		trustEditorExtension(storage(), view!.extension, plan.capabilities);
		await syncProjectEditorExtensions(options.editor, { trustStorage: storage() });
	} else if (plan.operation === "revoke-trust") {
		revokeEditorExtensionTrust(storage(), plan.packageName);
		await syncProjectEditorExtensions(options.editor, { trustStorage: storage() });
	} else if (plan.operation === "enable" || plan.operation === "disable") {
		await setProjectEditorExtensionEnabled(options.editor, plan.packageName, plan.operation === "enable", { trustStorage: storage() });
		await saveProjectConfiguration(options.editor);
	} else {
		await removeProjectEditorExtensionConfiguration(options.editor, plan.packageName, { trustStorage: storage() });
		await saveProjectConfiguration(options.editor);
	}
	return { applied: true, plan, state: publicSnapshot(await currentSnapshot(options)) };
}

function activeExtension(options: IMCPActionOptions, requestedPackageName: string, expectedExtensionFingerprint: string) {
	const runtime = options.editor.extensionHost?.list().find((status) => status.packageName === requestedPackageName);
	if (!runtime || runtime.state !== "active") {
		throw new Error(`Editor extension package "${requestedPackageName}" is not active.`);
	}
	if (runtime.fingerprint !== expectedExtensionFingerprint) {
		throw new Error(`Editor extension package content changed; expected ${expectedExtensionFingerprint} but found ${runtime.fingerprint}. Refresh before retrying.`);
	}
	return runtime;
}

/** Re-inspects and reloads an active, exactly fingerprinted extension package. */
export async function reloadEditorExtension(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data as Record<string, unknown>;
	const requestedPackageName = packageName(input?.packageName);
	const expectedExtensionFingerprint = fingerprint(input?.expectedExtensionFingerprint, "expectedExtensionFingerprint");
	activeExtension(options, requestedPackageName, expectedExtensionFingerprint);
	const runtime = await options.editor.extensionHost!.reload(requestedPackageName);
	return { reloaded: true, runtime };
}

/** Opens a manifest-declared window owned by an active, exactly fingerprinted extension. */
export async function openEditorExtensionWindow(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data as Record<string, unknown>;
	const requestedPackageName = packageName(input?.packageName);
	const expectedExtensionFingerprint = fingerprint(input?.expectedExtensionFingerprint, "expectedExtensionFingerprint");
	const id = contributionId(input?.windowId, "windowId");
	activeExtension(options, requestedPackageName, expectedExtensionFingerprint);
	const snapshot = await currentSnapshot(options);
	const view = extensionView(snapshot, requestedPackageName);
	if (view?.extension.fingerprint !== expectedExtensionFingerprint) {
		throw new Error("Editor extension package content changed on disk; reload and trust the new exact content before opening its window.");
	}
	if (!view?.extension.manifest.contributes.windows.some((window) => window.id === id)) {
		throw new Error(`Window "${id}" is not declared by editor extension package "${requestedPackageName}".`);
	}
	// Recheck after filesystem inspection because another lifecycle operation may have run while hashing package content.
	activeExtension(options, requestedPackageName, expectedExtensionFingerprint);
	options.editor.extensionHost!.openWindow(id);
	return { opened: true, packageName: requestedPackageName, windowId: id };
}

/** Invokes a manifest-declared menu command owned by an active, exactly fingerprinted extension. */
export async function invokeEditorExtensionMenu(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data as Record<string, unknown>;
	const requestedPackageName = packageName(input?.packageName);
	const expectedExtensionFingerprint = fingerprint(input?.expectedExtensionFingerprint, "expectedExtensionFingerprint");
	const id = contributionId(input?.menuId, "menuId");
	activeExtension(options, requestedPackageName, expectedExtensionFingerprint);
	const snapshot = await currentSnapshot(options);
	const view = extensionView(snapshot, requestedPackageName);
	if (view?.extension.fingerprint !== expectedExtensionFingerprint) {
		throw new Error("Editor extension package content changed on disk; reload and trust the new exact content before invoking its menu command.");
	}
	if (!view?.extension.manifest.contributes.menus.some((menu) => menu.id === id)) {
		throw new Error(`Menu "${id}" is not declared by editor extension package "${requestedPackageName}".`);
	}
	activeExtension(options, requestedPackageName, expectedExtensionFingerprint);
	await options.editor.extensionHost!.invokeMenu(id);
	return { invoked: true, packageName: requestedPackageName, menuId: id };
}

/** Lists active manifest-declared Build Profile footer actions for one exact selected profile. */
export function listBuildProfileFooterActions(scene: Scene, data: unknown, options: IMCPActionOptions): Record<string, unknown> {
	const input = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const offset = input.offset ?? 0;
	const limit = input.limit ?? 100;
	const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
	if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 1_000_000) {
		throw new Error("offset must be an integer from 0 through 1000000.");
	}
	if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
		throw new Error("limit must be an integer from 1 through 100.");
	}
	if (query.length > 160) {
		throw new Error("query must be at most 160 characters.");
	}
	const context = buildProfileActionContext(scene, input.profileId);
	const allActions = (options.editor.extensionHost?.listBuildProfileFooterActions(context) ?? []).filter(
		(action) => !query || action.id.includes(query) || action.title.toLowerCase().includes(query) || action.packageName.toLowerCase().includes(query)
	);
	const page = allActions.slice(Number(offset), Number(offset) + Number(limit));
	return {
		configurationRevision: context.configurationRevision,
		profile: context.profile,
		isActive: context.isActive,
		actions: page,
		offset: Number(offset),
		limit: Number(limit),
		count: page.length,
		total: allActions.length,
		hasMore: Number(offset) + page.length < allActions.length,
		nextOffset: Number(offset) + page.length < allActions.length ? Number(offset) + page.length : null,
	};
}

/** Invokes one exact-package Build Profile footer action after revalidating profile and on-disk package state. */
export async function invokeBuildProfileFooterAction(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	if (input.confirm !== true) {
		throw new Error("confirm must be true to invoke an editor extension Build Profile footer action.");
	}
	const requestedPackageName = packageName(input.packageName);
	const expectedExtensionFingerprint = fingerprint(input.expectedExtensionFingerprint, "expectedExtensionFingerprint");
	const actionId = contributionId(input.actionId, "actionId");
	if (!Number.isInteger(input.expectedConfigurationRevision) || Number(input.expectedConfigurationRevision) < 0) {
		throw new Error("expectedConfigurationRevision must be a non-negative integer.");
	}
	activeExtension(options, requestedPackageName, expectedExtensionFingerprint);
	const snapshot = await currentSnapshot(options);
	const view = extensionView(snapshot, requestedPackageName);
	if (view?.extension.fingerprint !== expectedExtensionFingerprint) {
		throw new Error("Editor extension package content changed on disk; reload and trust the new exact content before invoking its Build Profile action.");
	}
	if (!view.extension.manifest.contributes.buildProfileFooterActions.some((action) => action.id === actionId)) {
		throw new Error(`Build Profile footer action "${actionId}" is not declared by editor extension package "${requestedPackageName}".`);
	}
	const context = buildProfileActionContext(scene, input.profileId);
	if (context.configurationRevision !== input.expectedConfigurationRevision) {
		throw new Error(
			`Build Profile configuration changed; expected revision ${input.expectedConfigurationRevision} but found ${context.configurationRevision}. Refresh before retrying.`
		);
	}
	const available = options.editor
		.extensionHost!.listBuildProfileFooterActions(context)
		.some((action) => action.packageName === requestedPackageName && action.extensionFingerprint === expectedExtensionFingerprint && action.id === actionId);
	if (!available) {
		throw new Error(`Build Profile footer action "${actionId}" is unavailable for profile "${context.profile.id}".`);
	}
	activeExtension(options, requestedPackageName, expectedExtensionFingerprint);
	await options.editor.extensionHost!.invokeBuildProfileFooterAction(actionId, context);
	return {
		invoked: true,
		packageName: requestedPackageName,
		actionId,
		configurationRevision: context.configurationRevision,
		profileId: context.profile.id,
	};
}

/** Runs a bounded selection of tests registered by one active, exactly fingerprinted extension. */
export async function runEditorExtensionTests(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data as Record<string, unknown>;
	const requestedPackageName = packageName(input?.packageName);
	const expectedExtensionFingerprint = fingerprint(input?.expectedExtensionFingerprint, "expectedExtensionFingerprint");
	activeExtension(options, requestedPackageName, expectedExtensionFingerprint);
	const ids = input?.ids;
	if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== "string" || !contributionIdPattern.test(id) || id.length > 160))) {
		throw new Error("ids must contain at most 100 valid extension contribution ids.");
	}
	const timeoutMs = input?.timeoutMs ?? 30_000;
	if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 30_000) {
		throw new Error("timeoutMs must be an integer from 1 through 30000.");
	}
	const results = await options.editor.extensionHost!.runTests({ packageName: requestedPackageName, ids: ids as string[] | undefined, timeoutMs: Number(timeoutMs) });
	return {
		packageName: requestedPackageName,
		results,
		passed: results.filter((result) => result.state === "passed").length,
		failed: results.filter((result) => result.state === "failed").length,
		timedOut: results.filter((result) => result.state === "timed-out").length,
	};
}
