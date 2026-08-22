import { Scene } from "babylonjs";
import { lstat, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { IMCPActionOptions } from "../action";
import { getProjectPackageContext, packageProjectRelativePath, requireWorkspaceMutationPermission } from "./package-manager/context";
export { getProjectPackageDependencyGraph, getProjectPackageUpdates } from "./package-manager/dependencies";
import { applyProjectPackagePlan, planProjectPackageChanges } from "./package-manager/plans";
export { applyProjectPackagePlan, planProjectPackageChanges } from "./package-manager/plans";
import { cancelProjectPackageProcess, getActiveProjectPackageProcess, runProjectPackageProcess, validateProjectPackageName } from "./package-manager/process";
export {
	applyProjectPackageRegistryPlan,
	getProjectPackageDetails,
	listProjectPackageRegistries,
	planProjectPackageRegistryChange,
	searchProjectPackageRegistry,
	validateProjectPackageRegistryUrl,
} from "./package-manager/registry";
export {
	applyProjectPackageSampleImport,
	getProjectPackageSampleDetails,
	listProjectPackageSamples,
	locateProjectPackageSample,
	planProjectPackageSampleImport,
} from "./package-manager/samples";
import { ProjectPackageDependencyType } from "./package-manager/types";

export { projectPackageCommand } from "./package-manager/process";

const dependencyTypes: ProjectPackageDependencyType[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function directDependencies(manifest: any): { name: string; specification: string; dependencyType: ProjectPackageDependencyType }[] {
	return dependencyTypes.flatMap((dependencyType) =>
		Object.entries(manifest[dependencyType] ?? {}).map(([name, specification]) => ({ name, specification: String(specification), dependencyType }))
	);
}

/** Lists direct project dependencies as understood by the configured package manager. */
export async function listProjectPackages(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	const context = await getProjectPackageContext(options);
	const offset = _data?.offset ?? 0;
	const limit = _data?.limit ?? 100;
	if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
		throw new Error("offset must be an integer from 0 through 1000000.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new Error("limit must be an integer from 1 through 500.");
	}
	const query = typeof _data?.query === "string" ? _data.query.trim().toLowerCase() : "";
	if (query.length > 214) {
		throw new Error("query must be at most 214 characters.");
	}
	const allDependencies = directDependencies(context.manifest).filter((dependency) => !query || dependency.name.toLowerCase().includes(query));
	const page = allDependencies.slice(offset, offset + limit);
	const dependencyMap = (type: ProjectPackageDependencyType): Record<string, string> =>
		Object.fromEntries(page.filter((dependency) => dependency.dependencyType === type).map((dependency) => [dependency.name, dependency.specification]));
	return {
		packageManager: context.packageManager,
		name: context.manifest.name,
		version: context.manifest.version,
		private: context.manifest.private === true,
		fingerprint: context.fingerprint,
		manifest: { path: "package.json", sha256: context.manifestSha256, bytes: context.manifestBytes.byteLength },
		workspace: context.workspaceRoot
			? { root: context.workspaceRoot, relativePath: context.workspaceRelativePath, lockfileMutationRequiresOptIn: context.workspaceRoot !== context.projectRoot }
			: null,
		dependencies: dependencyMap("dependencies"),
		devDependencies: dependencyMap("devDependencies"),
		optionalDependencies: dependencyMap("optionalDependencies"),
		peerDependencies: dependencyMap("peerDependencies"),
		directDependencies: page,
		lockfiles: context.lockfiles.map((lockfile) => ({ ...lockfile, path: packageProjectRelativePath(context, lockfile.path) })),
		offset,
		limit,
		count: page.length,
		total: allDependencies.length,
		hasMore: offset + page.length < allDependencies.length,
		nextOffset: offset + page.length < allDependencies.length ? offset + page.length : null,
	};
}

/** Returns the configured package manager, deterministic file evidence, executable availability, and any active operation. */
export async function getProjectPackageManager(scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	const context = await getProjectPackageContext(options);
	const command = { command: context.packageManager, args: ["--version"], display: `${context.packageManager} --version` };
	const versionResult = await runProjectPackageProcess(scene, context.projectRoot, command, { kind: "inspect-manager", timeoutMs: 10_000, maximumOutputBytes: 64 * 1024 });
	return {
		packageManager: context.packageManager,
		available: versionResult.status === "succeeded",
		version: versionResult.status === "succeeded" ? versionResult.stdout.trim().split(/\s+/)[0] || null : null,
		fingerprint: context.fingerprint,
		workspace: context.workspaceRoot ? { root: context.workspaceRoot, relativePath: context.workspaceRelativePath } : null,
		lockfiles: context.lockfiles.map((lockfile) => ({ ...lockfile, path: packageProjectRelativePath(context, lockfile.path) })),
		active: getActiveProjectPackageProcess(scene),
		capabilities: {
			registryPackages: true,
			gitPackages: true,
			localPackages: true,
			tarballPackages: true,
			dependencyTypes,
			scriptsDisabledByDefault: true,
			workspaceRootOptIn: Boolean(context.workspaceRoot && context.workspaceRoot !== context.projectRoot),
			developmentTechnicalNameEditing: true,
		},
		inspection: versionResult,
	};
}

/** Atomically edits the active development package's technical name under an exact package-state lease. */
export async function setProjectDevelopmentPackageTechnicalName(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data?.confirm !== true) {
		throw new Error("confirm must be true to change the development package technical name.");
	}
	const context = await getProjectPackageContext(options);
	if (data.expectedFingerprint !== context.fingerprint || data.expectedManifestSha256 !== context.manifestSha256) {
		throw new Error(`Package state changed. Read it again and use expectedFingerprint ${context.fingerprint} with expectedManifestSha256 ${context.manifestSha256}.`);
	}
	const previousName = typeof context.manifest.name === "string" ? context.manifest.name : null;
	if (data.expectedTechnicalName !== previousName) {
		throw new Error(`Development package technical name changed; expected ${String(data.expectedTechnicalName)} but found ${String(previousName)}.`);
	}
	const technicalName = validateProjectPackageName(data.technicalName);
	if (technicalName === previousName) {
		return { changed: false, previousTechnicalName: previousName, technicalName, fingerprint: context.fingerprint, manifestSha256: context.manifestSha256 };
	}
	const direct = directDependencies(context.manifest).map((entry) => entry.name);
	if (direct.includes(technicalName)) {
		throw new Error(`Technical name "${technicalName}" conflicts with an existing direct dependency.`);
	}
	const manifest = { ...context.manifest, name: technicalName };
	const resultBytes = Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	if (resultBytes.byteLength > 1024 * 1024) {
		throw new Error("Updated package.json exceeds the 1 MiB safety limit.");
	}
	const parent = dirname(context.manifestPath);
	const mutationId = `${process.pid}-${Date.now()}`;
	const temporary = join(parent, `.package.json.zvibe-${mutationId}.tmp`);
	const backup = join(parent, `.package.json.zvibe-${mutationId}.bak`);
	const sourceStat = await lstat(context.manifestPath);
	if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
		throw new Error("package.json must remain a regular file and cannot be a symbolic link.");
	}
	await writeFile(temporary, resultBytes, { flag: "wx", mode: sourceStat.mode & 0o777 });
	let backedUp = false;
	try {
		await rename(context.manifestPath, backup);
		backedUp = true;
		await rename(temporary, context.manifestPath);
		const applied = await getProjectPackageContext(options);
		if (applied.manifest.name !== technicalName || applied.manifestSha256 === context.manifestSha256) {
			throw new Error("Development package technical-name postcondition failed.");
		}
		await unlink(backup).catch(() => undefined);
		backedUp = false;
		options.editor.layout?.inspector?.forceUpdate?.();
		return {
			changed: true,
			previousTechnicalName: previousName,
			technicalName,
			previousFingerprint: context.fingerprint,
			fingerprint: applied.fingerprint,
			previousManifestSha256: context.manifestSha256,
			manifestSha256: applied.manifestSha256,
			path: "package.json",
		};
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		if (backedUp) {
			await unlink(context.manifestPath).catch(() => undefined);
			await rename(backup, context.manifestPath).catch(() => undefined);
		}
		throw error;
	}
}

/** Installs, removes, or updates one dependency using the active project's configured package manager. */
export async function modifyProjectPackage(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data?.confirm !== true) {
		throw new Error("confirm must be true to install, update, or remove a project package.");
	}
	const context = await getProjectPackageContext(options);
	requireWorkspaceMutationPermission(context, data.allowWorkspaceRoot);
	if (data.expectedFingerprint !== undefined && data.expectedFingerprint !== context.fingerprint) {
		throw new Error(`Package state changed since inspection; expected ${String(data.expectedFingerprint)} but found ${context.fingerprint}. Refresh before retrying.`);
	}
	const plan = await planProjectPackageChanges(
		scene,
		{
			expectedFingerprint: context.fingerprint,
			allowWorkspaceRoot: data.allowWorkspaceRoot,
			allowScripts: data.allowScripts,
			changes: [{ operation: data.operation, name: data.name, version: data.version, dependencyType: data.dependencyType, source: data.source }],
			timeoutMs: data.timeoutMs,
			maximumOutputBytes: data.maximumOutputBytes,
		},
		options
	);
	const transaction = await applyProjectPackagePlan(scene, { planId: plan.id, expectedFingerprint: plan.sourceFingerprint, confirm: true }, options);
	return {
		operation: data.operation,
		name: data.name,
		version: data.version ?? null,
		dependencyType: data.dependencyType ?? null,
		packageManager: context.packageManager,
		transaction,
		...(await listProjectPackages(scene, data, options)),
	};
}

/** Cancels the one active package-manager process for this scene. */
export async function cancelProjectPackageOperation(scene: Scene, data: any): Promise<any> {
	return cancelProjectPackageProcess(scene, data);
}
