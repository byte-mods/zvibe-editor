import type { Editor } from "../editor/main";
import type { IEditorProjectExtension } from "../project/typings";

import { getProjectPackageContext } from "../mcp/project/package-manager/context";
import type { IProjectPackageContext } from "../mcp/project/package-manager/types";

import { discoverInstalledEditorExtensions, inspectInstalledEditorExtension } from "./discovery";
import type { EditorExtensionHost } from "./host";
import { getEditorExtensionTrustRecord } from "./trust";
import type { IEditorExtensionRuntimeStatus, IEditorExtensionTrustStorage, IInstalledEditorExtension } from "./types";

/** Joins immutable package inspection with shared enablement, local trust, and live state. */
export interface IProjectEditorExtensionView {
	extension: IInstalledEditorExtension;
	enabled: boolean;
	trusted: boolean;
	runtime: IEditorExtensionRuntimeStatus | null;
}

/** Bounded user-facing problem isolated to a reconciliation stage and optional package. */
export interface IProjectEditorExtensionIssue {
	packageName: string | null;
	stage: "configuration" | "discovery" | "trust" | "activation";
	message: string;
}

/** Exact project extension state returned to settings UI and future automation endpoints. */
export interface IProjectEditorExtensionsSnapshot {
	projectRoot: string;
	packageManagerFingerprint: string;
	configured: IEditorProjectExtension[];
	extensions: IProjectEditorExtensionView[];
	issues: IProjectEditorExtensionIssue[];
	runtime: IEditorExtensionRuntimeStatus[];
}

/** Optional exact context and test seams; production callers use renderer-local trust storage. */
export interface IProjectEditorExtensionSyncOptions {
	trustStorage?: IEditorExtensionTrustStorage;
	context?: IProjectPackageContext;
	hostFactory?: (editor: Editor, reinspect: (packageName: string) => Promise<IInstalledEditorExtension | null>, storage: IEditorExtensionTrustStorage) => EditorExtensionHost;
}

const maximumConfiguredExtensions = 128;
const maximumDirectDependencies = 512;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const dependencyKeys = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const syncQueues = new WeakMap<Editor, Promise<void>>();
const suspendedPackages = new WeakMap<Editor, Set<string>>();

function enqueueProjectExtensionOperation<T>(editor: Editor, operation: () => Promise<T>): Promise<T> {
	const previous = syncQueues.get(editor) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	syncQueues.set(
		editor,
		result.then(
			() => undefined,
			() => undefined
		)
	);
	return result;
}

function trustStorage(options: IProjectEditorExtensionSyncOptions): IEditorExtensionTrustStorage {
	if (options.trustStorage) {
		return options.trustStorage;
	}
	if (typeof localStorage === "undefined") {
		throw new Error("Editor extension trust storage is unavailable outside the editor renderer.");
	}
	return localStorage;
}

/** Normalizes untrusted project JSON to a bounded, unique, deterministic enablement list. */
export function normalizeProjectEditorExtensions(value: unknown): IEditorProjectExtension[] {
	if (!Array.isArray(value) || value.length > maximumConfiguredExtensions) {
		return [];
	}
	const result: IEditorProjectExtension[] = [];
	const names = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const record = entry as Partial<IEditorProjectExtension>;
		if (
			Object.keys(record).some((key) => key !== "packageName" && key !== "enabled") ||
			typeof record.packageName !== "string" ||
			record.packageName.length > 214 ||
			!packageNamePattern.test(record.packageName) ||
			typeof record.enabled !== "boolean" ||
			names.has(record.packageName)
		) {
			continue;
		}
		names.add(record.packageName);
		result.push({ packageName: record.packageName, enabled: record.enabled });
	}
	return result.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

/** Returns every direct dependency category because editor extensions may be development-only packages. */
export function projectEditorExtensionPackageNames(context: IProjectPackageContext): string[] {
	return [...new Set(dependencyKeys.flatMap((key) => Object.keys(context.manifest[key] ?? {})).filter((name) => name.length <= 214 && packageNamePattern.test(name)))].sort(
		(left, right) => left.localeCompare(right)
	);
}

/** Re-inspects one direct dependency against the latest package-manager fingerprint. */
export async function inspectProjectEditorExtension(editor: Editor, packageName: string): Promise<IInstalledEditorExtension | null> {
	const context = await getProjectPackageContext({ editor });
	if (!projectEditorExtensionPackageNames(context).includes(packageName)) {
		throw new Error(`Editor extension package "${packageName}" must be a direct project dependency managed by Package Manager.`);
	}
	return inspectInstalledEditorExtension(context.projectRoot, packageName, context.fingerprint);
}

/** Inspects extension packages, configuration, local trust, and current runtime without loading or unloading executable code. */
export async function inspectProjectEditorExtensionsState(editor: Editor, options: IProjectEditorExtensionSyncOptions = {}): Promise<IProjectEditorExtensionsSnapshot> {
	const storage = trustStorage(options);
	const freshContext = await getProjectPackageContext({ editor });
	const context = options.context?.fingerprint === freshContext.fingerprint && options.context.projectRoot === freshContext.projectRoot ? options.context : freshContext;
	const configured = normalizeProjectEditorExtensions(editor.state.editorExtensions);
	const packageNames = projectEditorExtensionPackageNames(context);
	const runtime = editor.extensionHost?.list() ?? [];
	const issues: IProjectEditorExtensionIssue[] = [];
	if (packageNames.length > maximumDirectDependencies) {
		issues.push({
			packageName: null,
			stage: "discovery",
			message: `Extension discovery stopped because the project has more than ${maximumDirectDependencies} direct dependencies.`,
		});
		return { projectRoot: context.projectRoot, packageManagerFingerprint: context.fingerprint, configured, extensions: [], issues, runtime };
	}
	const discovery = await discoverInstalledEditorExtensions(context.projectRoot, packageNames, context.fingerprint);
	issues.push(...discovery.issues.map((issue) => ({ packageName: issue.packageName, stage: "discovery" as const, message: issue.message })));
	const discoveredByPackage = new Map(discovery.extensions.map((extension) => [extension.packageName, extension]));
	const configuredByPackage = new Map(configured.map((setting) => [setting.packageName, setting]));
	for (const setting of configured) {
		if (!packageNames.includes(setting.packageName)) {
			issues.push({ packageName: setting.packageName, stage: "configuration", message: "Configured extension is not a direct Package Manager dependency." });
		} else if (!discoveredByPackage.has(setting.packageName)) {
			issues.push({ packageName: setting.packageName, stage: "configuration", message: "Configured dependency does not expose a valid zvibeEditor extension manifest." });
		}
	}
	for (const extension of discovery.extensions) {
		if (configuredByPackage.get(extension.packageName)?.enabled && !getEditorExtensionTrustRecord(storage, extension)) {
			issues.push({ packageName: extension.packageName, stage: "trust", message: "Exact package content and requested capabilities are not trusted on this machine." });
		}
	}
	return {
		projectRoot: context.projectRoot,
		packageManagerFingerprint: context.fingerprint,
		configured,
		extensions: discovery.extensions.map((extension) => ({
			extension,
			enabled: configuredByPackage.get(extension.packageName)?.enabled ?? false,
			trusted: Boolean(getEditorExtensionTrustRecord(storage, extension)),
			runtime: runtime.find((status) => status.packageName === extension.packageName) ?? null,
		})),
		issues,
		runtime,
	};
}

function ensureHost(editor: Editor, storage: IEditorExtensionTrustStorage, factory?: IProjectEditorExtensionSyncOptions["hostFactory"]): NonNullable<Editor["extensionHost"]> {
	if (!editor.extensionHost) {
		const createHost = factory ?? (require("./editor-adapter") as typeof import("./editor-adapter")).createEditorExtensionHost;
		editor.extensionHost = createHost(editor, async (packageName) => inspectProjectEditorExtension(editor, packageName), storage);
	}
	return editor.extensionHost;
}

/** Serializes discovery and activation so project loads, settings actions, and package mutations cannot race. */
export function syncProjectEditorExtensions(editor: Editor, options: IProjectEditorExtensionSyncOptions = {}): Promise<IProjectEditorExtensionsSnapshot> {
	return enqueueProjectExtensionOperation(editor, async () => syncProjectEditorExtensionsNow(editor, options));
}

async function syncProjectEditorExtensionsNow(editor: Editor, options: IProjectEditorExtensionSyncOptions): Promise<IProjectEditorExtensionsSnapshot> {
	const storage = trustStorage(options);
	const freshContext = await getProjectPackageContext({ editor });
	const context = options.context?.fingerprint === freshContext.fingerprint && options.context.projectRoot === freshContext.projectRoot ? options.context : freshContext;
	const configured = normalizeProjectEditorExtensions(editor.state.editorExtensions);
	const packageNames = projectEditorExtensionPackageNames(context);
	const host = ensureHost(editor, storage, options.hostFactory);
	const issues: IProjectEditorExtensionIssue[] = [];
	if (packageNames.length > maximumDirectDependencies) {
		await host.disposeAll();
		issues.push({
			packageName: null,
			stage: "discovery",
			message: `Extension discovery stopped because the project has more than ${maximumDirectDependencies} direct dependencies.`,
		});
		return { projectRoot: context.projectRoot, packageManagerFingerprint: context.fingerprint, configured, extensions: [], issues, runtime: host.list() };
	}
	const discovery = await discoverInstalledEditorExtensions(context.projectRoot, packageNames, context.fingerprint);
	issues.push(...discovery.issues.map((issue) => ({ packageName: issue.packageName, stage: "discovery" as const, message: issue.message })));
	const discoveredByPackage = new Map(discovery.extensions.map((extension) => [extension.packageName, extension]));
	const configuredByPackage = new Map(configured.map((setting) => [setting.packageName, setting]));
	for (const setting of configured) {
		if (!packageNames.includes(setting.packageName)) {
			issues.push({ packageName: setting.packageName, stage: "configuration", message: "Configured extension is not a direct Package Manager dependency." });
		} else if (!discoveredByPackage.has(setting.packageName)) {
			issues.push({ packageName: setting.packageName, stage: "configuration", message: "Configured dependency does not expose a valid zvibeEditor extension manifest." });
		}
	}
	const enabledPackages = new Set(configured.filter((setting) => setting.enabled).map((setting) => setting.packageName));
	const suspended = suspendedPackages.get(editor) ?? new Set<string>();
	for (const runtime of host.list()) {
		const discovered = discoveredByPackage.get(runtime.packageName);
		if (
			runtime.state === "active" &&
			(suspended.has(runtime.packageName) || !enabledPackages.has(runtime.packageName) || !discovered || discovered.fingerprint !== runtime.fingerprint)
		) {
			await host.dispose(runtime.packageName);
		}
	}
	for (const extension of discovery.extensions) {
		if (!configuredByPackage.get(extension.packageName)?.enabled) {
			continue;
		}
		if (suspended.has(extension.packageName)) {
			issues.push({ packageName: extension.packageName, stage: "configuration", message: "Extension is suspended while Package Manager changes its dependency." });
			continue;
		}
		if (editor.state.plugins.includes(extension.packageName)) {
			await host.dispose(extension.packageName);
			issues.push({
				packageName: extension.packageName,
				stage: "configuration",
				message: "Package is also configured as a legacy plugin; remove the legacy entry before enabling its extension manifest.",
			});
			continue;
		}
		if (!getEditorExtensionTrustRecord(storage, extension)) {
			await host.dispose(extension.packageName);
			issues.push({ packageName: extension.packageName, stage: "trust", message: "Exact package content and requested capabilities are not trusted on this machine." });
			continue;
		}
		const current = host.list().find((runtime) => runtime.packageName === extension.packageName);
		if (current?.state === "active" && current.fingerprint === extension.fingerprint) {
			continue;
		}
		try {
			await host.activate(extension);
		} catch (error) {
			issues.push({ packageName: extension.packageName, stage: "activation", message: error instanceof Error ? error.message : String(error) });
		}
	}
	const runtime = host.list();
	return {
		projectRoot: context.projectRoot,
		packageManagerFingerprint: context.fingerprint,
		configured,
		extensions: discovery.extensions.map((extension) => ({
			extension,
			enabled: configuredByPackage.get(extension.packageName)?.enabled ?? false,
			trusted: Boolean(getEditorExtensionTrustRecord(storage, extension)),
			runtime: runtime.find((status) => status.packageName === extension.packageName) ?? null,
		})),
		issues,
		runtime,
	};
}

/** Updates shared enablement and immediately reconciles runtime state; project saving remains explicit. */
export async function setProjectEditorExtensionEnabled(
	editor: Editor,
	packageName: string,
	enabled: boolean,
	options: IProjectEditorExtensionSyncOptions = {}
): Promise<IProjectEditorExtensionsSnapshot> {
	if (typeof packageName !== "string" || !packageNamePattern.test(packageName) || packageName.length > 214) {
		throw new Error("Invalid editor extension package name.");
	}
	const configured = normalizeProjectEditorExtensions(editor.state.editorExtensions).filter((setting) => setting.packageName !== packageName);
	configured.push({ packageName, enabled });
	configured.sort((left, right) => left.packageName.localeCompare(right.packageName));
	await new Promise<void>((resolve) => editor.setState({ editorExtensions: configured }, () => resolve()));
	return syncProjectEditorExtensions(editor, options);
}

/** Removes stale or unwanted shared configuration without mutating the dependency itself. */
export async function removeProjectEditorExtensionConfiguration(
	editor: Editor,
	packageName: string,
	options: IProjectEditorExtensionSyncOptions = {}
): Promise<IProjectEditorExtensionsSnapshot> {
	if (typeof packageName !== "string" || !packageNamePattern.test(packageName) || packageName.length > 214) {
		throw new Error("Invalid editor extension package name.");
	}
	const configured = normalizeProjectEditorExtensions(editor.state.editorExtensions).filter((setting) => setting.packageName !== packageName);
	await new Promise<void>((resolve) => editor.setState({ editorExtensions: configured }, () => resolve()));
	return syncProjectEditorExtensions(editor, options);
}

/** Prevents changed packages from executing while a Package Manager transaction mutates node_modules. */
export function suspendProjectEditorExtensions(editor: Editor, packageNames: readonly string[]): Promise<void> {
	if (!Array.isArray(packageNames) || packageNames.length > 100 || packageNames.some((packageName) => typeof packageName !== "string" || !packageNamePattern.test(packageName))) {
		throw new Error("Suspended extension package names must contain at most 100 valid direct dependency names.");
	}
	let suspended = suspendedPackages.get(editor);
	if (!suspended) {
		suspended = new Set();
		suspendedPackages.set(editor, suspended);
	}
	packageNames.forEach((packageName) => suspended!.add(packageName));
	return enqueueProjectExtensionOperation(editor, async () => {
		for (const packageName of new Set(packageNames)) {
			await editor.extensionHost?.dispose(packageName);
		}
	});
}

/** Ends Package Manager suspension and reconciles against the transaction's final exact state. */
export function resumeProjectEditorExtensions(
	editor: Editor,
	packageNames: readonly string[],
	options: IProjectEditorExtensionSyncOptions = {}
): Promise<IProjectEditorExtensionsSnapshot> {
	const suspended = suspendedPackages.get(editor);
	packageNames.forEach((packageName) => suspended?.delete(packageName));
	if (suspended?.size === 0) {
		suspendedPackages.delete(editor);
	}
	return syncProjectEditorExtensions(editor, options);
}

/** Clears all runtime extension resources before switching projects or closing the editor. */
export async function disposeProjectEditorExtensions(editor: Editor): Promise<void> {
	await enqueueProjectExtensionOperation(editor, async () => {
		await editor.extensionHost?.disposeAll();
		editor.extensionHost = null;
		suspendedPackages.delete(editor);
		editor.setExtensionMenus([]);
	});
}
