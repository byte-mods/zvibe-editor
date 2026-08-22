import { isAbsolute, relative, sep } from "path";

import type { Editor } from "../editor/main";

import { getEditorExtensionTrustRecord } from "./trust";
import {
	EditorExtensionCapability,
	EditorExtensionDispose,
	IEditorExtensionBuildProfileActionContext,
	IEditorExtensionBuildProfileFooterDescriptor,
	IEditorExtensionBuildProfileFooterRegistration,
	IEditorExtensionContext,
	IEditorExtensionInspectorRegistration,
	IEditorExtensionMenuDescriptor,
	IEditorExtensionMenuRegistration,
	IEditorExtensionManifest,
	IEditorExtensionModule,
	IEditorExtensionRuntimeStatus,
	IEditorExtensionTestRegistration,
	IEditorExtensionTestResult,
	IEditorExtensionTrustStorage,
	IEditorExtensionWindowContribution,
	IEditorExtensionWindowRegistration,
	IInstalledEditorExtension,
} from "./types";

/** Small host-port contract keeps lifecycle policy independent from React and Electron. */
export interface IEditorExtensionHostAdapter {
	editor: Editor;
	trustStorage: IEditorExtensionTrustStorage;
	reinspect(packageName: string): Promise<IInstalledEditorExtension | null>;
	registerInspector(registration: IEditorExtensionInspectorRegistration): EditorExtensionDispose;
	openWindow(contribution: IEditorExtensionWindowContribution, registration: IEditorExtensionWindowRegistration): void;
	closeWindow(id: string): void;
	selectWindow(id: string): void;
	updateMenus(descriptors: readonly IEditorExtensionMenuDescriptor[]): void;
	loadModule?(entryPath: string, packageRoot: string): IEditorExtensionModule;
}

interface IEditorExtensionOwnedRegistration {
	id: string;
	dispose: EditorExtensionDispose;
}

interface IEditorExtensionRuntimeRecord {
	extension: IInstalledEditorExtension;
	state: IEditorExtensionRuntimeStatus["state"];
	error?: string;
	module?: IEditorExtensionModule;
	activateDispose?: EditorExtensionDispose;
	registrations: IEditorExtensionOwnedRegistration[];
	windowRegistrations: Map<string, IEditorExtensionWindowRegistration>;
	menuRegistrations: Map<string, IEditorExtensionMenuRegistration>;
	testRegistrations: Map<string, IEditorExtensionTestRegistration>;
	buildProfileFooterRegistrations: Map<string, IEditorExtensionBuildProfileFooterRegistration>;
}

const maximumActiveExtensions = 128;
const maximumRuntimeContributions = 512;
const maximumTestsPerRun = 100;
const maximumTestTimeoutMs = 30_000;
const maximumActivationTimeoutMs = 30_000;
const maximumCleanupTimeoutMs = 10_000;
const maximumCommandTimeoutMs = 30_000;
const maximumErrorLength = 4096;

function contained(root: string, path: string): boolean {
	const candidate = relative(root, path);
	return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

function defaultLoadModule(entryPath: string, packageRoot: string): IEditorExtensionModule {
	for (const cachedPath of Object.keys(require.cache)) {
		if (contained(packageRoot, cachedPath)) {
			delete require.cache[cachedPath];
		}
	}
	const loaded = require(entryPath) as unknown;
	const candidate = loaded && (typeof loaded === "object" || typeof loaded === "function") && "default" in loaded && loaded.default ? loaded.default : loaded;
	if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
		throw new Error("Extension entry must export activate(context) and may export deactivate().");
	}
	const module = candidate as Partial<IEditorExtensionModule>;
	if (typeof module.activate !== "function" || (module.deactivate !== undefined && typeof module.deactivate !== "function")) {
		throw new Error("Extension entry must export activate(context) and may export deactivate().");
	}
	return module as IEditorExtensionModule;
}

function errorMessage(error: unknown): string {
	let message = "Unknown extension error.";
	try {
		message = error instanceof Error ? error.message : String(error);
	} catch {
		// A hostile thrown value may itself fail string coercion; retain the safe fallback.
	}
	return message.slice(0, maximumErrorLength);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function freezeManifest(manifest: IEditorExtensionManifest): IEditorExtensionManifest {
	const contributes = {
		inspectors: Object.freeze(manifest.contributes.inspectors.map((contribution) => Object.freeze({ ...contribution }))),
		windows: Object.freeze(manifest.contributes.windows.map((contribution) => Object.freeze({ ...contribution }))),
		menus: Object.freeze(manifest.contributes.menus.map((contribution) => Object.freeze({ ...contribution }))),
		tests: Object.freeze(manifest.contributes.tests.map((contribution) => Object.freeze({ ...contribution }))),
		buildProfileFooterActions: Object.freeze(
			manifest.contributes.buildProfileFooterActions.map((contribution) => Object.freeze({ ...contribution, targets: Object.freeze([...contribution.targets]) }))
		),
	};
	return Object.freeze({ ...manifest, capabilities: Object.freeze([...manifest.capabilities]), contributes: Object.freeze(contributes) }) as IEditorExtensionManifest;
}

/** Owns trusted extension execution and every runtime contribution it creates. */
export class EditorExtensionHost {
	private _lifecycleQueue: Promise<void> = Promise.resolve();
	private _records = new Map<string, IEditorExtensionRuntimeRecord>();
	private _contributionOwners = new Map<string, string>();

	public constructor(private _adapter: IEditorExtensionHostAdapter) {}

	/** Returns stable, serializable lifecycle state for settings UI and MCP callers. */
	public list(): IEditorExtensionRuntimeStatus[] {
		return [...this._records.values()]
			.map((record) => ({
				packageName: record.extension.packageName,
				packageVersion: record.extension.packageVersion,
				extensionId: record.extension.manifest.id,
				fingerprint: record.extension.fingerprint,
				state: record.state,
				...(record.error ? { error: record.error } : {}),
			}))
			.sort((left, right) => left.packageName.localeCompare(right.packageName));
	}

	/** Activates only the exact package content that was trusted and then re-inspected. */
	public activate(extension: IInstalledEditorExtension): Promise<IEditorExtensionRuntimeStatus> {
		return this._serialize(async () => this._activate(extension));
	}

	/** Disposes and re-inspects an extension so reload cannot reuse a stale trust decision. */
	public reload(packageName: string): Promise<IEditorExtensionRuntimeStatus> {
		return this._serialize(async () => {
			await this._dispose(packageName);
			const extension = await this._adapter.reinspect(packageName);
			if (!extension) {
				throw new Error(`Package "${packageName}" is not an editor extension.`);
			}
			return this._activate(extension);
		});
	}

	/** Releases every resource owned by an extension in reverse registration order. */
	public dispose(packageName: string): Promise<IEditorExtensionRuntimeStatus | null> {
		return this._serialize(async () => this._dispose(packageName));
	}

	/** Releases all active extensions without allowing lifecycle operations to overlap. */
	public disposeAll(): Promise<void> {
		return this._serialize(async () => {
			for (const packageName of [...this._records.keys()].reverse()) {
				await this._dispose(packageName);
			}
		});
	}

	/** Opens a registered dockable window by its globally unique contribution id. */
	public openWindow(id: string): void {
		const { record, registration } = this._findRegistration("window", id);
		const contribution = record.extension.manifest.contributes.windows.find((candidate) => candidate.id === id)!;
		this._adapter.openWindow(contribution, registration as IEditorExtensionWindowRegistration);
		this._adapter.selectWindow(id);
	}

	/** Closes a registered dockable window without unregistering its implementation. */
	public closeWindow(id: string): void {
		this._findRegistration("window", id);
		this._adapter.closeWindow(id);
	}

	/** Invokes one registered menu command; callers receive extension failures. */
	public async invokeMenu(id: string): Promise<void> {
		const { registration } = this._findRegistration("menu", id);
		await withTimeout(
			Promise.resolve().then(() => (registration as IEditorExtensionMenuRegistration).execute()),
			maximumCommandTimeoutMs,
			`Extension menu "${id}"`
		);
	}

	/** Lists active actions whose declarative target and active-profile filters match. */
	public listBuildProfileFooterActions(context: IEditorExtensionBuildProfileActionContext): IEditorExtensionBuildProfileFooterDescriptor[] {
		return [...this._records.values()]
			.filter((record) => record.state === "active")
			.flatMap((record) =>
				[...record.buildProfileFooterRegistrations.keys()].map((id) => ({
					packageName: record.extension.packageName,
					extensionFingerprint: record.extension.fingerprint,
					...record.extension.manifest.contributes.buildProfileFooterActions.find((candidate) => candidate.id === id)!,
				}))
			)
			.filter((action) => (!action.targets.length || action.targets.includes(context.profile.target)) && (!action.activeProfileOnly || context.isActive))
			.sort((left, right) => left.order - right.order || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
	}

	/** Invokes one active footer action with an immutable exact-profile snapshot. */
	public async invokeBuildProfileFooterAction(id: string, context: IEditorExtensionBuildProfileActionContext): Promise<void> {
		const { record, registration } = this._findRegistration("build-profile-footer", id);
		const contribution = record.extension.manifest.contributes.buildProfileFooterActions.find((candidate) => candidate.id === id)!;
		if ((contribution.targets.length && !contribution.targets.includes(context.profile.target)) || (contribution.activeProfileOnly && !context.isActive)) {
			throw new Error(`Editor extension Build Profile footer action "${id}" is unavailable for the selected profile.`);
		}
		const immutableContext = Object.freeze({
			configurationRevision: context.configurationRevision,
			isActive: context.isActive,
			profile: Object.freeze({
				...structuredClone(context.profile),
				options: Object.freeze({ ...context.profile.options }),
				settings: Object.freeze(structuredClone(context.profile.settings)),
			}),
		});
		await withTimeout(
			Promise.resolve().then(() => (registration as IEditorExtensionBuildProfileFooterRegistration).execute(immutableContext)),
			maximumCommandTimeoutMs,
			`Extension Build Profile footer action "${id}"`
		);
	}

	/** Runs selected editor-only tests sequentially with a hard per-test timeout. */
	public runTests(options: { packageName?: string; ids?: readonly string[]; timeoutMs?: number } = {}): Promise<IEditorExtensionTestResult[]> {
		return this._serialize(async () => this._runTests(options));
	}

	private async _runTests(options: { packageName?: string; ids?: readonly string[]; timeoutMs?: number }): Promise<IEditorExtensionTestResult[]> {
		const timeoutMs = options.timeoutMs ?? maximumTestTimeoutMs;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTestTimeoutMs) {
			throw new Error(`timeoutMs must be an integer from 1 through ${maximumTestTimeoutMs}.`);
		}
		if (options.ids && (!Array.isArray(options.ids) || options.ids.length > maximumTestsPerRun || options.ids.some((id) => typeof id !== "string" || !id))) {
			throw new Error(`ids must contain at most ${maximumTestsPerRun} non-empty strings.`);
		}
		const selectedIds = options.ids ? new Set(options.ids) : null;
		if (selectedIds && selectedIds.size !== options.ids!.length) {
			throw new Error("ids must not contain duplicates.");
		}
		if (options.packageName && ![...this._records.values()].some((record) => record.state === "active" && record.extension.packageName === options.packageName)) {
			throw new Error(`Editor extension package "${options.packageName}" is not active.`);
		}
		const tests = [...this._records.values()]
			.filter((record) => record.state === "active" && (!options.packageName || record.extension.packageName === options.packageName))
			.flatMap((record) =>
				[...record.testRegistrations.entries()].map(([id, registration]) => ({
					record,
					id,
					registration,
					contribution: record.extension.manifest.contributes.tests.find((candidate) => candidate.id === id)!,
				}))
			)
			.filter((test) => !selectedIds || selectedIds.has(test.id))
			.sort((left, right) => left.id.localeCompare(right.id));
		if (tests.length > maximumTestsPerRun) {
			throw new Error(`A test run is limited to ${maximumTestsPerRun} tests.`);
		}
		if (selectedIds && tests.length !== selectedIds.size) {
			throw new Error("One or more requested editor extension test ids are not registered and active.");
		}
		const results: IEditorExtensionTestResult[] = [];
		for (const test of tests) {
			const startedAt = performance.now();
			const controller = new AbortController();
			let timedOut = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.resolve(test.registration.run(controller.signal)),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							timedOut = true;
							reject(new Error(`Timed out after ${timeoutMs}ms.`));
							controller.abort();
						}, timeoutMs);
					}),
				]);
				results.push({
					packageName: test.record.extension.packageName,
					id: test.id,
					title: test.contribution.title,
					state: "passed",
					durationMs: performance.now() - startedAt,
				});
			} catch (error) {
				results.push({
					packageName: test.record.extension.packageName,
					id: test.id,
					title: test.contribution.title,
					state: timedOut ? "timed-out" : "failed",
					durationMs: performance.now() - startedAt,
					error: errorMessage(error),
				});
			} finally {
				if (timer) {
					clearTimeout(timer);
				}
			}
		}
		return results;
	}

	private _serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this._lifecycleQueue.then(operation, operation);
		this._lifecycleQueue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	private async _activate(extension: IInstalledEditorExtension): Promise<IEditorExtensionRuntimeStatus> {
		const activeRecords = [...this._records.values()].filter((record) => record.state === "active" || record.state === "activating");
		if (!this._records.has(extension.packageName) && activeRecords.length >= maximumActiveExtensions) {
			throw new Error(`At most ${maximumActiveExtensions} editor extensions can be active.`);
		}
		await this._dispose(extension.packageName);
		const inspected = await this._adapter.reinspect(extension.packageName);
		if (
			!inspected ||
			inspected.packageName !== extension.packageName ||
			inspected.fingerprint !== extension.fingerprint ||
			inspected.entryPath !== extension.entryPath ||
			inspected.packageRoot !== extension.packageRoot
		) {
			throw new Error(`Extension package "${extension.packageName}" changed after discovery; inspect it again before activation.`);
		}
		if (!getEditorExtensionTrustRecord(this._adapter.trustStorage, inspected)) {
			throw new Error(`Extension package "${extension.packageName}" is not trusted for its exact content and capabilities.`);
		}
		if (activeRecords.some((record) => record.extension.packageName !== inspected.packageName && record.extension.manifest.id === inspected.manifest.id)) {
			throw new Error(`Extension id "${inspected.manifest.id}" is already active from another package.`);
		}
		const securedExtension = Object.freeze({ ...inspected, manifest: freezeManifest(inspected.manifest) });
		const record: IEditorExtensionRuntimeRecord = {
			extension: securedExtension,
			state: "activating",
			registrations: [],
			windowRegistrations: new Map(),
			menuRegistrations: new Map(),
			testRegistrations: new Map(),
			buildProfileFooterRegistrations: new Map(),
		};
		this._records.set(securedExtension.packageName, record);
		let acceptingRegistrations = true;
		try {
			const module = (this._adapter.loadModule ?? defaultLoadModule)(securedExtension.entryPath, securedExtension.packageRoot);
			record.module = module;
			const returnedDispose = await withTimeout(
				Promise.resolve().then(() => module.activate(this._createContext(record, () => acceptingRegistrations))),
				maximumActivationTimeoutMs,
				`Extension "${securedExtension.packageName}" activation`
			);
			acceptingRegistrations = false;
			if (returnedDispose !== undefined) {
				if (typeof returnedDispose !== "function") {
					throw new Error("Extension activate(context) must return a cleanup function or nothing.");
				}
				record.activateDispose = returnedDispose;
			}
			this._validateAllDeclaredContributions(record);
			record.state = "active";
			record.error = undefined;
			this._refreshMenus();
			return this._status(record);
		} catch (error) {
			acceptingRegistrations = false;
			const activationError = errorMessage(error);
			record.state = "error";
			record.error = activationError;
			const cleanupErrors = await this._disposeRecord(record, true);
			if (cleanupErrors.length) {
				record.error = `${activationError}; cleanup: ${cleanupErrors.join("; ")}`.slice(0, maximumErrorLength);
			}
			this._records.set(securedExtension.packageName, record);
			throw new Error(`Failed to activate editor extension "${securedExtension.packageName}": ${record.error}`);
		}
	}

	private _createContext(record: IEditorExtensionRuntimeRecord, acceptingRegistrations: () => boolean): IEditorExtensionContext {
		const requireCapability = (capability: EditorExtensionCapability): void => {
			if (record.state !== "activating" && record.state !== "active") {
				throw new Error(`Extension "${record.extension.manifest.id}" is not active.`);
			}
			if (!record.extension.manifest.capabilities.includes(capability)) {
				throw new Error(`Extension "${record.extension.manifest.id}" did not declare capability "${capability}".`);
			}
		};
		const contribution = <T extends { id: string }>(kind: "inspectors" | "windows" | "menus" | "tests" | "buildProfileFooterActions", id: string): T => {
			if (!acceptingRegistrations()) {
				throw new Error("Extension contributions may only be registered during activate(context).");
			}
			const declared = record.extension.manifest.contributes[kind].find((candidate) => candidate.id === id);
			if (!declared) {
				throw new Error(`Extension contribution "${id}" is not declared in manifest section "${kind}".`);
			}
			if (this._contributionOwners.size >= maximumRuntimeContributions || this._contributionOwners.has(id)) {
				throw new Error(`Extension contribution id "${id}" is already registered or the ${maximumRuntimeContributions}-contribution limit was reached.`);
			}
			return declared as unknown as T;
		};
		const own = (id: string, dispose: EditorExtensionDispose): EditorExtensionDispose => {
			let active = true;
			const ownedDispose = async (): Promise<void> => {
				if (!active) {
					return;
				}
				active = false;
				this._contributionOwners.delete(id);
				await dispose();
			};
			this._contributionOwners.set(id, record.extension.packageName);
			record.registrations.push({ id, dispose: ownedDispose });
			return ownedDispose;
		};
		return {
			manifest: record.extension.manifest,
			capabilities: new Set(record.extension.manifest.capabilities),
			inspectors: {
				register: (registration) => {
					requireCapability("inspectors");
					const declared = contribution<{ id: string; priority: number }>("inspectors", registration.id);
					if (registration.priority !== undefined && registration.priority !== declared.priority) {
						throw new Error(`Inspector "${registration.id}" priority must match its manifest declaration.`);
					}
					return own(registration.id, this._adapter.registerInspector({ ...registration, priority: declared.priority }));
				},
			},
			windows: {
				register: (registration) => {
					requireCapability("windows");
					contribution("windows", registration.id);
					record.windowRegistrations.set(registration.id, registration);
					return own(registration.id, () => {
						this._adapter.closeWindow(registration.id);
						record.windowRegistrations.delete(registration.id);
					});
				},
				open: (id) => {
					requireCapability("windows");
					this.openWindow(id);
				},
				close: (id) => {
					requireCapability("windows");
					this.closeWindow(id);
				},
			},
			menus: {
				register: (registration) => {
					requireCapability("menus");
					const declared = contribution<{ id: string; path: string }>("menus", registration.id);
					const conflictingPath = [...this._records.values()].some((candidateRecord) =>
						[...candidateRecord.menuRegistrations.keys()].some(
							(id) => candidateRecord.extension.manifest.contributes.menus.find((candidate) => candidate.id === id)?.path === declared.path
						)
					);
					if (conflictingPath) {
						throw new Error(`Editor extension menu path "${declared.path}" is already registered.`);
					}
					record.menuRegistrations.set(registration.id, registration);
					const dispose = own(registration.id, () => {
						record.menuRegistrations.delete(registration.id);
						this._refreshMenus();
					});
					this._refreshMenus();
					return dispose;
				},
			},
			tests: {
				register: (registration) => {
					requireCapability("tests");
					contribution("tests", registration.id);
					record.testRegistrations.set(registration.id, registration);
					return own(registration.id, () => {
						record.testRegistrations.delete(registration.id);
					});
				},
			},
			buildProfiles: {
				registerFooterAction: (registration) => {
					requireCapability("buildProfiles");
					contribution("buildProfileFooterActions", registration.id);
					record.buildProfileFooterRegistrations.set(registration.id, registration);
					return own(registration.id, () => {
						record.buildProfileFooterRegistrations.delete(registration.id);
					});
				},
			},
			getEditor: () => {
				requireCapability("editor");
				return this._adapter.editor;
			},
		};
	}

	private _validateAllDeclaredContributions(record: IEditorExtensionRuntimeRecord): void {
		const missing = Object.values(record.extension.manifest.contributes)
			.flatMap((contributions) => contributions.map((contribution) => contribution.id))
			.filter((id) => this._contributionOwners.get(id) !== record.extension.packageName);
		if (missing.length) {
			throw new Error(`Extension did not register declared contribution(s): ${missing.join(", ")}.`);
		}
	}

	private _findRegistration(
		kind: "window" | "menu" | "build-profile-footer",
		id: string
	): {
		record: IEditorExtensionRuntimeRecord;
		registration: IEditorExtensionWindowRegistration | IEditorExtensionMenuRegistration | IEditorExtensionBuildProfileFooterRegistration;
	} {
		const packageName = this._contributionOwners.get(id);
		const record = packageName ? this._records.get(packageName) : undefined;
		if (!record || record.state !== "active") {
			throw new Error(`Editor extension ${kind} "${id}" is not registered and active.`);
		}
		const registration =
			kind === "window" ? record.windowRegistrations.get(id) : kind === "menu" ? record.menuRegistrations.get(id) : record.buildProfileFooterRegistrations.get(id);
		if (!registration) {
			throw new Error(`Editor extension ${kind} "${id}" is not registered and active.`);
		}
		return { record, registration };
	}

	private async _dispose(packageName: string): Promise<IEditorExtensionRuntimeStatus | null> {
		const record = this._records.get(packageName);
		if (!record) {
			return null;
		}
		const errors = await this._disposeRecord(record, true);
		record.state = errors.length ? "error" : "inactive";
		record.error = errors.length ? errors.join("; ") : undefined;
		this._refreshMenus();
		return this._status(record);
	}

	private async _disposeRecord(record: IEditorExtensionRuntimeRecord, invokeDeactivate: boolean): Promise<string[]> {
		const errors: string[] = [];
		for (const registration of record.registrations.splice(0).reverse()) {
			try {
				await withTimeout(
					Promise.resolve().then(() => registration.dispose()),
					maximumCleanupTimeoutMs,
					`Cleanup for "${registration.id}"`
				);
			} catch (error) {
				errors.push(`${registration.id}: ${errorMessage(error)}`);
			}
		}
		if (record.activateDispose) {
			try {
				await withTimeout(
					Promise.resolve().then(() => record.activateDispose!()),
					maximumCleanupTimeoutMs,
					`Activation cleanup for "${record.extension.packageName}"`
				);
			} catch (error) {
				errors.push(`activate cleanup: ${errorMessage(error)}`);
			}
			record.activateDispose = undefined;
		}
		if (invokeDeactivate && record.module?.deactivate) {
			try {
				await withTimeout(
					Promise.resolve().then(() => record.module!.deactivate!()),
					maximumCleanupTimeoutMs,
					`Deactivation for "${record.extension.packageName}"`
				);
			} catch (error) {
				errors.push(`deactivate: ${errorMessage(error)}`);
			}
		}
		record.module = undefined;
		record.windowRegistrations.clear();
		record.menuRegistrations.clear();
		record.testRegistrations.clear();
		record.buildProfileFooterRegistrations.clear();
		return errors;
	}

	private _refreshMenus(): void {
		const descriptors = [...this._records.values()]
			.filter((record) => record.state === "active" || record.state === "activating")
			.flatMap((record) =>
				[...record.menuRegistrations.keys()].map((id) => ({ id, path: record.extension.manifest.contributes.menus.find((candidate) => candidate.id === id)!.path }))
			)
			.sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
		this._adapter.updateMenus(descriptors);
	}

	private _status(record: IEditorExtensionRuntimeRecord): IEditorExtensionRuntimeStatus {
		return {
			packageName: record.extension.packageName,
			packageVersion: record.extension.packageVersion,
			extensionId: record.extension.manifest.id,
			fingerprint: record.extension.fingerprint,
			state: record.state,
			...(record.error ? { error: record.error } : {}),
		};
	}
}
