import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import { realpath } from "fs/promises";
import { basename, dirname, join } from "path";
import { promisify } from "util";

import { lstat, move, pathExists, readFile, readdir, remove, writeFile } from "fs-extra";
import { Observable } from "babylonjs";
import { IGenerativeAssetProviderManifest, normalizeGenerativeAssetProviderManifest } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { ensureProjectStoreDirectory, inspectProjectStoreDirectory, projectPathContains } from "../project/project-store";

const execFileAsync = promisify(execFile);
const providerDirectoryPath = ".zvibe/generative-providers";
const maximumProviders = 32;
const maximumManifestBytes = 64 * 1024;
const fingerprintPattern = /^[a-f0-9]{64}$/;

export interface IGenerativeAssetProviderDescriptor extends IGenerativeAssetProviderManifest {
	path: string;
	fingerprint: string;
	available: boolean;
	hostCompatible: boolean;
	executableAvailable: boolean | null;
	credentials: Array<{ name: string; available: boolean }>;
	warnings: string[];
}

export interface IGenerativeAssetProviderInventory {
	version: 1;
	directory: typeof providerDirectoryPath;
	inventoryFingerprint: string;
	providers: IGenerativeAssetProviderDescriptor[];
	errors: Array<{ path: string; error: string }>;
	limits: { providers: number; manifestBytes: number };
}

interface IScannedProviderFile {
	name: string;
	path: string;
	absolutePath: string;
	content: string | null;
	fingerprint: string | null;
	evidence: string;
	error: string | null;
}

const onChangedObservable = new Observable<void>();
let mutationTail: Promise<unknown> = Promise.resolve();

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

async function commandAvailable(command: string): Promise<boolean> {
	try {
		await execFileAsync(process.platform === "win32" ? "where" : "which", [command], { timeout: 2_000, windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

function credentials(manifest: IGenerativeAssetProviderManifest): Array<{ name: string; available: boolean }> {
	const names =
		manifest.transport.kind === "executable"
			? manifest.transport.credentialEnvironments
			: manifest.transport.authorizationEnvironment
				? [manifest.transport.authorizationEnvironment]
				: [];
	return names.map((name) => ({ name, available: Boolean(process.env[name]) }));
}

async function descriptor(manifest: IGenerativeAssetProviderManifest, file: IScannedProviderFile): Promise<IGenerativeAssetProviderDescriptor> {
	const hostCompatible = !manifest.hostPlatforms.length || manifest.hostPlatforms.includes(process.platform as "darwin" | "win32" | "linux");
	const executableAvailable = manifest.transport.kind === "executable" ? await commandAvailable(manifest.transport.executable) : null;
	const credentialState = credentials(manifest);
	const warnings: string[] = [];
	if (!hostCompatible) {
		warnings.push(`Provider supports ${manifest.hostPlatforms.join(", ")}; current host is ${process.platform}.`);
	}
	if (executableAvailable === false) {
		warnings.push(`Executable "${manifest.transport.kind === "executable" ? manifest.transport.executable : ""}" is unavailable on PATH.`);
	}
	for (const credential of credentialState.filter((entry) => !entry.available)) {
		warnings.push(`Credential environment variable ${credential.name} is unavailable.`);
	}
	if (manifest.classification !== "generative-ai") {
		warnings.push(
			manifest.classification === "test-fixture"
				? "This provider is a test fixture and is never evidence of AI generation."
				: "This provider is procedural and is never presented as an AI generator."
		);
	}
	return {
		...clone(manifest),
		path: file.path,
		fingerprint: file.fingerprint!,
		available: hostCompatible && executableAvailable !== false && credentialState.every((entry) => entry.available),
		hostCompatible,
		executableAvailable,
		credentials: credentialState,
		warnings,
	};
}

async function scanFiles(root: string): Promise<{ files: IScannedProviderFile[]; directoryError: string | null; overflowNames: string[] }> {
	let directory: string | null;
	try {
		directory = await inspectProjectStoreDirectory(root, ".zvibe", "generative-providers");
	} catch (error) {
		return { files: [], directoryError: error instanceof Error ? error.message : String(error), overflowNames: [] };
	}
	if (!directory) {
		return { files: [], directoryError: null, overflowNames: [] };
	}
	const entries = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.name.toLowerCase().endsWith(".json"))
		.sort((left, right) => left.name.localeCompare(right.name));
	const overflowNames = entries.slice(maximumProviders).map((entry) => entry.name);
	const files: IScannedProviderFile[] = [];
	const realRoot = await realpath(root);
	for (const entry of entries.slice(0, maximumProviders)) {
		const absolutePath = join(directory, entry.name);
		const path = `${providerDirectoryPath}/${entry.name}`;
		let content: string | null = null;
		let fingerprint: string | null = null;
		let evidence = entry.name;
		let error: string | null = null;
		try {
			const details = await lstat(absolutePath);
			const resolved = await realpath(absolutePath);
			evidence = `${entry.name}:${details.size}:${details.mtimeMs}`;
			if (
				!entry.isFile() ||
				details.isSymbolicLink() ||
				!details.isFile() ||
				details.size <= 0 ||
				details.size > maximumManifestBytes ||
				!projectPathContains(realRoot, resolved)
			) {
				throw new Error("Provider manifest must be a non-empty regular project-contained JSON file no larger than 64 KiB and cannot be a symlink.");
			}
			content = await readFile(absolutePath, "utf8");
			fingerprint = sha256(content);
			evidence = `${entry.name}:${fingerprint}`;
		} catch (scanError) {
			error = scanError instanceof Error ? scanError.message : String(scanError);
		}
		files.push({ name: entry.name, path, absolutePath, content, fingerprint, evidence, error });
	}
	return { files, directoryError: null, overflowNames };
}

/** Reads bounded provider manifests, availability, environment-name readiness, and isolated validation errors. */
async function readInventoryAt(root: string): Promise<IGenerativeAssetProviderInventory> {
	const scan = await scanFiles(root);
	const errors: IGenerativeAssetProviderInventory["errors"] = [];
	if (scan.directoryError) {
		errors.push({ path: providerDirectoryPath, error: scan.directoryError });
	}
	if (scan.overflowNames.length) {
		errors.push({
			path: providerDirectoryPath,
			error: `At most ${maximumProviders} provider manifests are supported; ${scan.overflowNames.length} additional JSON file(s) were ignored.`,
		});
	}
	const parsed: Array<{ manifest: IGenerativeAssetProviderManifest; file: IScannedProviderFile }> = [];
	for (const file of scan.files) {
		if (file.error || !file.content || !file.fingerprint) {
			errors.push({ path: file.path, error: file.error ?? "Provider manifest could not be read." });
			continue;
		}
		try {
			const manifest = normalizeGenerativeAssetProviderManifest(JSON.parse(file.content));
			if (parsed.some((entry) => entry.manifest.id === manifest.id)) {
				throw new Error(`Duplicate generative provider id: ${manifest.id}.`);
			}
			parsed.push({ manifest, file });
		} catch (error) {
			errors.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const providers = await Promise.all(parsed.map((entry) => descriptor(entry.manifest, entry.file)));
	providers.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
	const inventoryFingerprint = sha256(
		JSON.stringify({
			version: 1,
			files: scan.files.map((file) => file.evidence),
			overflowNames: scan.overflowNames,
			directoryError: scan.directoryError,
		})
	);
	return {
		version: 1,
		directory: providerDirectoryPath,
		inventoryFingerprint,
		providers,
		errors,
		limits: { providers: maximumProviders, manifestBytes: maximumManifestBytes },
	};
}

/** Reads bounded provider manifests, availability, environment-name readiness, and isolated validation errors. */
export async function readGenerativeAssetProviderInventory(): Promise<IGenerativeAssetProviderInventory> {
	return readInventoryAt(projectDirectory());
}

function expectedInventory(current: IGenerativeAssetProviderInventory, value: unknown): void {
	if (typeof value !== "string" || !fingerprintPattern.test(value) || value !== current.inventoryFingerprint) {
		throw new Error(`Generative provider inventory changed; read it again and use expectedInventoryFingerprint ${current.inventoryFingerprint}.`);
	}
}

async function mutate<T>(operation: () => Promise<T>): Promise<T> {
	const previous = mutationTail;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	mutationTail = previous.catch(() => undefined).then(() => gate);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
	}
}

function serializable(manifest: IGenerativeAssetProviderManifest): IGenerativeAssetProviderManifest {
	return clone(manifest);
}

/** Atomically creates or exact-leased replaces one provider manifest; credential values are never accepted or persisted. */
export async function setGenerativeAssetProvider(data: unknown): Promise<{ created: boolean; provider: IGenerativeAssetProviderDescriptor; inventoryFingerprint: string }> {
	const source = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const unknown = Object.keys(source).filter((key) => !["expectedInventoryFingerprint", "expectedProviderFingerprint", "provider"].includes(key));
	if (unknown.length) {
		throw new Error(`set_generative_asset_provider contains unsupported fields: ${unknown.join(", ")}.`);
	}
	const manifest = normalizeGenerativeAssetProviderManifest(source.provider);
	return mutate(async () => {
		const root = projectDirectory();
		const current = await readInventoryAt(root);
		expectedInventory(current, source.expectedInventoryFingerprint);
		const existing = current.providers.find((entry) => entry.id === manifest.id) ?? null;
		if (existing) {
			if (source.expectedProviderFingerprint !== existing.fingerprint) {
				throw new Error(`Provider ${manifest.id} already exists; use expectedProviderFingerprint ${existing.fingerprint} to replace it.`);
			}
		} else if (source.expectedProviderFingerprint !== undefined) {
			throw new Error(`Provider ${manifest.id} does not exist; omit expectedProviderFingerprint when creating it.`);
		}
		const directory = await ensureProjectStoreDirectory(root, ".zvibe", "generative-providers");
		const destination = join(directory, `${manifest.id}.json`);
		if (existing && existing.path !== `${providerDirectoryPath}/${manifest.id}.json`) {
			throw new Error(`Provider ${manifest.id} is stored at ${existing.path}; rename that manifest to ${manifest.id}.json before replacing it through the Editor.`);
		}
		if (await pathExists(destination)) {
			const details = await lstat(destination);
			if (details.isSymbolicLink() || !details.isFile()) {
				throw new Error("Generative provider destination must be a regular non-symlink file.");
			}
		}
		const temporary = `${destination}.${randomUUID()}.tmp`;
		const backup = `${destination}.${randomUUID()}.backup`;
		let backedUp = false;
		let preserveBackup = false;
		const bytes = Buffer.from(`${JSON.stringify(serializable(manifest), null, "\t")}\n`, "utf8");
		const writtenFingerprint = sha256(bytes);
		await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
		try {
			if (existing) {
				await move(destination, backup, { overwrite: false });
				backedUp = true;
			}
			await move(temporary, destination, { overwrite: false });
			if (projectDirectory() !== root) {
				throw new Error("The open project changed while the generative provider manifest was being written.");
			}
			const updated = await readInventoryAt(root);
			const provider = updated.providers.find((entry) => entry.id === manifest.id);
			if (!provider) {
				throw new Error(`Provider ${manifest.id} was written but failed strict reinspection.`);
			}
			await remove(backup).catch(() => undefined);
			onChangedObservable.notifyObservers();
			return { created: !existing, provider, inventoryFingerprint: updated.inventoryFingerprint };
		} catch (error) {
			await remove(temporary).catch(() => undefined);
			if (await pathExists(destination)) {
				const currentBytes = await readFile(destination).catch(() => null);
				if (currentBytes && sha256(currentBytes) === writtenFingerprint) {
					await remove(destination);
				} else {
					preserveBackup = backedUp;
				}
			}
			if (backedUp) {
				if (!(await pathExists(destination))) {
					await move(backup, destination, { overwrite: false }).catch(() => {
						preserveBackup = true;
					});
				} else {
					preserveBackup = true;
				}
			}
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}${preserveBackup ? ` Previous provider bytes were retained at ${providerDirectoryPath}/${basename(backup)}.` : ""}`
			);
		} finally {
			await remove(temporary).catch(() => undefined);
			if (!preserveBackup) {
				await remove(backup).catch(() => undefined);
			}
		}
	});
}

/** Confirmation-gated deletion of one exact provider manifest; it never removes provider-side accounts or models. */
export async function deleteGenerativeAssetProvider(data: unknown): Promise<{ deleted: true; id: string; inventoryFingerprint: string }> {
	const source = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const unknown = Object.keys(source).filter((key) => !["id", "expectedInventoryFingerprint", "expectedProviderFingerprint", "confirm"].includes(key));
	if (unknown.length) {
		throw new Error(`delete_generative_asset_provider contains unsupported fields: ${unknown.join(", ")}.`);
	}
	if (source.confirm !== true) {
		throw new Error("Deleting a generative provider requires confirm=true.");
	}
	return mutate(async () => {
		const root = projectDirectory();
		const current = await readInventoryAt(root);
		expectedInventory(current, source.expectedInventoryFingerprint);
		const provider = current.providers.find((entry) => entry.id === source.id);
		if (!provider) {
			throw new Error(`Generative provider "${String(source.id)}" was not found.`);
		}
		if (source.expectedProviderFingerprint !== provider.fingerprint) {
			throw new Error(`Provider ${provider.id} changed; use expectedProviderFingerprint ${provider.fingerprint}.`);
		}
		const absolutePath = join(root, provider.path);
		const rootReal = await realpath(root);
		const fileReal = await realpath(absolutePath);
		const details = await lstat(absolutePath);
		if (details.isSymbolicLink() || !details.isFile() || !projectPathContains(rootReal, fileReal)) {
			throw new Error("Generative provider manifest is no longer a regular contained file.");
		}
		const temporary = `${absolutePath}.${randomUUID()}.delete`;
		await move(absolutePath, temporary);
		try {
			if (projectDirectory() !== root) {
				throw new Error("The open project changed while the generative provider manifest was being deleted.");
			}
			const updated = await readInventoryAt(root);
			if (updated.providers.some((entry) => entry.id === provider.id)) {
				throw new Error(`Provider ${provider.id} remained visible after deletion.`);
			}
			await remove(temporary);
			onChangedObservable.notifyObservers();
			return { deleted: true, id: provider.id, inventoryFingerprint: updated.inventoryFingerprint };
		} catch (error) {
			await move(temporary, absolutePath, { overwrite: false }).catch(() => undefined);
			throw error;
		}
	});
}

/** Lets the permanent workspace observe provider mutations made through MCP. */
export function getGenerativeAssetProvidersChangedObservable(): Observable<void> {
	return onChangedObservable;
}
