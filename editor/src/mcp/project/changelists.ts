import { randomUUID } from "crypto";
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join, normalize, relative, resolve } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

const changelistStoreVersion = 1;
const maximumChangelists = 100;
const maximumFilesPerChangelist = 2000;
const operationGuardStaleMilliseconds = 10000;

export interface IProjectChangelist {
	id: string;
	name: string;
	description: string;
	owner: string;
	paths: string[];
	createdAt: string;
	updatedAt: string;
}

interface IProjectChangelistStore {
	version: 1;
	changelists: IProjectChangelist[];
}

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

function storeDirectory(root: string): string {
	return join(root, ".babylon-editor");
}

function storePath(root: string): string {
	return join(storeDirectory(root), "changelists.json");
}

function validateText(value: unknown, name: string, maximumLength: number, required: boolean): string {
	if (value === undefined || value === null) {
		if (required) {
			throw new Error(`${name} is required.`);
		}
		return "";
	}
	if (typeof value !== "string" || value.length > maximumLength || value.includes("\0") || (/[\r\n]/.test(value) && name !== "description")) {
		throw new Error(
			`${name} must be a ${required ? "non-empty " : ""}string of at most ${maximumLength} characters without null bytes${name === "description" ? "" : " or line breaks"}.`
		);
	}
	const normalized = value.trim();
	if (required && !normalized) {
		throw new Error(`${name} is required.`);
	}
	return normalized;
}

function isChangelist(value: any): value is IProjectChangelist {
	return (
		typeof value?.id === "string" &&
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		typeof value.owner === "string" &&
		Array.isArray(value.paths) &&
		value.paths.every((path: unknown) => typeof path === "string") &&
		Number.isFinite(Date.parse(value.createdAt)) &&
		Number.isFinite(Date.parse(value.updatedAt))
	);
}

async function readStore(root: string): Promise<IProjectChangelistStore> {
	try {
		const value = JSON.parse(await readFile(storePath(root), "utf-8"));
		if (value?.version !== changelistStoreVersion || !Array.isArray(value.changelists) || !value.changelists.every(isChangelist)) {
			throw new Error("The project changelist store has an unsupported or malformed schema.");
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return { version: changelistStoreVersion, changelists: [] };
		}
		if (error instanceof SyntaxError) {
			throw new Error("The project changelist store contains invalid JSON. Repair .babylon-editor/changelists.json before continuing.");
		}
		throw error;
	}
}

async function writeStore(root: string, value: IProjectChangelistStore): Promise<void> {
	const path = storePath(root);
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporaryPath, path);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

async function withStoreGuard<T>(root: string, action: (store: IProjectChangelistStore) => Promise<T>): Promise<T> {
	const directory = storeDirectory(root);
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".changelists.operation");
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const candidate = await open(guardPath, "wx");
			try {
				await candidate.writeFile(`${Date.now()}\n`, "utf-8");
				handle = candidate;
			} catch (error) {
				await candidate.close().catch(() => undefined);
				await unlink(guardPath).catch(() => undefined);
				throw error;
			}
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				throw error;
			}
			const guardStat = await stat(guardPath).catch(() => null);
			if (guardStat && Date.now() - guardStat.mtimeMs > operationGuardStaleMilliseconds) {
				await unlink(guardPath).catch(() => undefined);
			} else {
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
	}
	if (!handle) {
		throw new Error("The project changelist store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

async function normalizeProjectPath(root: string, value: unknown): Promise<string> {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error("Changelist paths must be non-empty project-relative paths.");
	}
	const slashPath = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	const path = normalize(slashPath);
	if (path === "." || path.startsWith("/") || path.split("/").includes("..") || path === ".babylon-editor" || path.startsWith(".babylon-editor/")) {
		throw new Error("Changelist paths must stay inside the active project and cannot include editor collaboration metadata.");
	}
	const absolute = resolve(root, path);
	const details = await stat(absolute).catch((error: any) => {
		if (error?.code === "ENOENT") {
			return null;
		}
		throw error;
	});
	if (details) {
		const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
		if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
			throw new Error("Changelist paths must resolve inside the active project.");
		}
		if (!details.isFile()) {
			throw new Error(`Changelist entries must be files, not directories: ${path}`);
		}
	}
	return relative(root, absolute).replace(/\\/g, "/");
}

async function normalizePaths(root: string, value: unknown): Promise<string[]> {
	if (!Array.isArray(value) || value.length > maximumFilesPerChangelist) {
		throw new Error(`paths must be an array containing at most ${maximumFilesPerChangelist} project-relative file paths.`);
	}
	const paths = await Promise.all(value.map((path) => normalizeProjectPath(root, path)));
	return [...new Set(paths)].sort();
}

function resolveChangelist(store: IProjectChangelistStore, data: any): IProjectChangelist {
	const changelist = store.changelists.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!changelist) {
		throw new Error(`Project changelist was not found: ${data.id ?? data.name ?? "missing id/name"}`);
	}
	return changelist;
}

function sortedChangelists(store: IProjectChangelistStore): IProjectChangelist[] {
	return [...store.changelists].sort((first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id));
}

/** Lists persisted project-local changelists without changing the store. */
export async function listProjectChangelists(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const store = await readStore(root);
	const owner = data.owner === undefined ? null : validateText(data.owner, "owner", 128, true);
	const changelists = sortedChangelists(store).filter((changelist) => !owner || changelist.owner === owner);
	return {
		storage: relative(root, storePath(root)),
		count: changelists.length,
		assignedFileCount: new Set(changelists.flatMap((changelist) => changelist.paths)).size,
		changelists,
	};
}

/** Creates one named changelist with optional initial file assignments. */
export async function createProjectChangelist(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const name = validateText(data.name, "name", 80, true);
	const description = validateText(data.description, "description", 512, false);
	const owner = validateText(data.owner, "owner", 128, true);
	const paths = await normalizePaths(root, data.paths ?? []);
	return withStoreGuard(root, async (store) => {
		if (store.changelists.length >= maximumChangelists) {
			throw new Error(`A project can contain at most ${maximumChangelists} changelists.`);
		}
		if (store.changelists.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
			throw new Error(`A project changelist named "${name}" already exists.`);
		}
		const conflicts = store.changelists.flatMap((candidate) => candidate.paths.filter((path) => paths.includes(path)).map((path) => ({ path, changelist: candidate.name })));
		if (conflicts.length) {
			throw new Error(`Files are already assigned to another changelist: ${conflicts.map((conflict) => `${conflict.path} (${conflict.changelist})`).join(", ")}`);
		}
		const now = new Date().toISOString();
		const changelist: IProjectChangelist = { id: randomUUID(), name, description, owner, paths, createdAt: now, updatedAt: now };
		store.changelists.push(changelist);
		await writeStore(root, store);
		return { created: true, changelist };
	});
}

/** Updates changelist name, description, or owner while preserving file assignments. */
export async function setProjectChangelist(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const changelist = resolveChangelist(store, data);
		const name = data.newName === undefined ? changelist.name : validateText(data.newName, "newName", 80, true);
		if (store.changelists.some((candidate) => candidate.id !== changelist.id && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
			throw new Error(`A project changelist named "${name}" already exists.`);
		}
		changelist.name = name;
		if (data.description !== undefined) {
			changelist.description = validateText(data.description, "description", 512, false);
		}
		if (data.owner !== undefined) {
			changelist.owner = validateText(data.owner, "owner", 128, true);
		}
		changelist.updatedAt = new Date().toISOString();
		await writeStore(root, store);
		return { updated: true, changelist };
	});
}

/** Replaces, adds, or removes changelist file assignments with optional explicit reassignment. */
export async function setProjectChangelistFiles(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const mode = data.mode ?? "replace";
	if (!["replace", "add", "remove"].includes(mode)) {
		throw new Error("mode must be replace, add, or remove.");
	}
	const paths = await normalizePaths(root, data.paths);
	return withStoreGuard(root, async (store) => {
		const changelist = resolveChangelist(store, data);
		const nextPaths =
			mode === "replace" ? paths : mode === "add" ? [...new Set([...changelist.paths, ...paths])].sort() : changelist.paths.filter((path) => !paths.includes(path));
		if (nextPaths.length > maximumFilesPerChangelist) {
			throw new Error(`A changelist can contain at most ${maximumFilesPerChangelist} files.`);
		}
		const movedFrom: Array<{ id: string; name: string; paths: string[] }> = [];
		for (const candidate of store.changelists.filter((candidate) => candidate.id !== changelist.id)) {
			const conflicts = candidate.paths.filter((path) => nextPaths.includes(path));
			if (!conflicts.length) {
				continue;
			}
			if (data.reassign !== true) {
				throw new Error(`Files are already assigned to changelist "${candidate.name}": ${conflicts.join(", ")}. Set reassign: true to move them.`);
			}
			candidate.paths = candidate.paths.filter((path) => !conflicts.includes(path));
			candidate.updatedAt = new Date().toISOString();
			movedFrom.push({ id: candidate.id, name: candidate.name, paths: conflicts });
		}
		changelist.paths = nextPaths;
		changelist.updatedAt = new Date().toISOString();
		await writeStore(root, store);
		return { updated: true, mode, reassigned: movedFrom.length > 0, movedFrom, changelist };
	});
}

/** Deletes an empty changelist, or a non-empty one only with explicit force. */
export async function deleteProjectChangelist(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const changelist = resolveChangelist(store, data);
		if (changelist.paths.length && data.force !== true) {
			throw new Error(`Changelist "${changelist.name}" still contains ${changelist.paths.length} files. Set force: true to delete it and unassign them.`);
		}
		store.changelists = store.changelists.filter((candidate) => candidate.id !== changelist.id);
		await writeStore(root, store);
		return { deleted: true, forced: data.force === true, changelist };
	});
}
