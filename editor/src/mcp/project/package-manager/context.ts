import { createHash } from "crypto";
import { lstat, readFile, realpath } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

import { IMCPActionOptions } from "../../action";
import { projectPathContains } from "../project-store";
import { IProjectPackageContext, IProjectPackageFileEvidence, IProjectPackageManifest, ProjectPackageManager } from "./types";

const maximumManifestBytes = 1024 * 1024;
const maximumLockfileBytes = 32 * 1024 * 1024;
const maximumWorkspaceDepth = 16;
const managerNames = new Set<ProjectPackageManager>(["npm", "yarn", "pnpm", "bun"]);
const dependencyKeys = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

interface ILockfileDefinition {
	name: string;
	format: IProjectPackageFileEvidence["format"];
	managers: ProjectPackageManager[];
}

const lockfileDefinitions: ILockfileDefinition[] = [
	{ name: "npm-shrinkwrap.json", format: "npm-shrinkwrap", managers: ["npm"] },
	{ name: "package-lock.json", format: "package-lock", managers: ["npm"] },
	{ name: "yarn.lock", format: "yarn", managers: ["yarn"] },
	{ name: "pnpm-lock.yaml", format: "pnpm", managers: ["pnpm"] },
	{ name: "bun.lock", format: "bun-text", managers: ["bun"] },
	{ name: "bun.lockb", format: "bun-binary", managers: ["bun"] },
];

export function packageSha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function projectDirectory(options: IMCPActionOptions): string {
	const projectPath = options.editor.state.projectPath;
	if (typeof projectPath !== "string" || !projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectPath);
}

function configuredManager(options: IMCPActionOptions): ProjectPackageManager {
	const manager = options.editor.state.packageManager ?? "yarn";
	if (!managerNames.has(manager as ProjectPackageManager)) {
		throw new Error(`Unsupported package manager "${String(manager)}". Choose npm, yarn, pnpm, or bun in Project Settings.`);
	}
	return manager as ProjectPackageManager;
}

async function readRegularBoundedFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
	let fileStat;
	try {
		fileStat = await lstat(path);
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			throw new Error(`${label} is missing.`);
		}
		throw error;
	}
	if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
		throw new Error(`${label} must be a regular file and cannot be a symbolic link.`);
	}
	if (fileStat.size > maximumBytes) {
		throw new Error(`${label} exceeds the ${maximumBytes}-byte safety limit.`);
	}
	return readFile(path);
}

function stringMap(value: unknown, label: string): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} in package.json must be an object.`);
	}
	const result: Record<string, string> = {};
	const entries = Object.entries(value);
	if (entries.length > 10_000) {
		throw new Error(`${label} in package.json exceeds 10,000 entries.`);
	}
	for (const [name, specification] of entries) {
		if (!name || name.length > 214 || typeof specification !== "string" || !specification || specification.length > 2_048) {
			throw new Error(`${label} in package.json contains an invalid package name or specification.`);
		}
		result[name] = specification;
	}
	return result;
}

function parseManifest(bytes: Buffer, label: string): IProjectPackageManifest {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must contain a JSON object.`);
	}
	const manifest = value as IProjectPackageManifest;
	for (const key of dependencyKeys) {
		manifest[key] = stringMap(manifest[key], key);
	}
	return manifest;
}

async function readOptionalManifest(path: string): Promise<IProjectPackageManifest | null> {
	try {
		return parseManifest(await readRegularBoundedFile(path, maximumManifestBytes, path), path);
	} catch (error: any) {
		if (error?.code === "ENOENT" || String(error?.message ?? "").endsWith(" is missing.")) {
			return null;
		}
		throw error;
	}
}

function workspacePatterns(manifest: IProjectPackageManifest): string[] {
	if (Array.isArray(manifest.workspaces)) {
		return manifest.workspaces.filter((value): value is string => typeof value === "string");
	}
	if (manifest.workspaces && typeof manifest.workspaces === "object" && Array.isArray(manifest.workspaces.packages)) {
		return manifest.workspaces.packages.filter((value): value is string => typeof value === "string");
	}
	return [];
}

function matchesWorkspacePattern(relativePath: string, pattern: string): boolean {
	const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
	const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
	const escaped = normalizedPattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\uE000")
		.replace(/\*/g, "[^/]*")
		.replace(/\uE000/g, ".*");
	return new RegExp(`^${escaped}$`).test(normalizedPath);
}

async function findWorkspaceRoot(projectRoot: string): Promise<{ root: string; relativePath: string } | null> {
	let current = dirname(projectRoot);
	for (let depth = 0; depth < maximumWorkspaceDepth; depth++) {
		if (current === dirname(current)) {
			break;
		}
		const manifest = await readOptionalManifest(join(current, "package.json"));
		if (manifest) {
			const projectRelative = relative(current, projectRoot).replace(/\\/g, "/");
			if (projectRelative && !projectRelative.startsWith("../") && workspacePatterns(manifest).some((pattern) => matchesWorkspacePattern(projectRelative, pattern))) {
				return { root: current, relativePath: projectRelative };
			}
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return null;
}

async function lockfileEvidence(projectRoot: string, workspaceRoot: string | null, manager: ProjectPackageManager): Promise<IProjectPackageFileEvidence[]> {
	const roots = workspaceRoot && workspaceRoot !== projectRoot ? [projectRoot, workspaceRoot] : [projectRoot];
	const evidence: IProjectPackageFileEvidence[] = [];
	for (const root of roots) {
		for (const definition of lockfileDefinitions) {
			const path = join(root, definition.name);
			let fileStat;
			try {
				fileStat = await lstat(path);
			} catch (error: any) {
				if (error?.code === "ENOENT") {
					continue;
				}
				throw error;
			}
			if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
				throw new Error(`Package lockfile must be a regular file and cannot be a symbolic link: ${path}`);
			}
			if (fileStat.size > maximumLockfileBytes) {
				throw new Error(`Package lockfile exceeds the ${maximumLockfileBytes}-byte safety limit: ${path}`);
			}
			const bytes = await readFile(path);
			evidence.push({
				path,
				exists: true,
				bytes: bytes.byteLength,
				sha256: packageSha256(bytes),
				format: definition.format,
				authoritative: definition.managers.includes(manager) && root === (workspaceRoot ?? projectRoot),
				outsideProject: !projectPathContains(projectRoot, path),
			});
		}
	}
	return evidence.sort((left, right) => left.path.localeCompare(right.path));
}

export async function getProjectPackageContext(options: IMCPActionOptions): Promise<IProjectPackageContext> {
	const requestedRoot = resolve(projectDirectory(options));
	const projectRoot = await realpath(requestedRoot);
	const manifestPath = join(projectRoot, "package.json");
	const manifestBytes = await readRegularBoundedFile(manifestPath, maximumManifestBytes, "package.json");
	const manifest = parseManifest(manifestBytes, "package.json");
	const packageManager = configuredManager(options);
	const workspace = await findWorkspaceRoot(projectRoot);
	const lockfiles = await lockfileEvidence(projectRoot, workspace?.root ?? null, packageManager);
	const manifestSha256 = packageSha256(manifestBytes);
	const fingerprint = packageSha256(
		JSON.stringify({
			manager: packageManager,
			manifestSha256,
			workspaceRoot: workspace?.root ?? null,
			locks: lockfiles.map((lockfile) => ({ path: lockfile.path, sha256: lockfile.sha256, bytes: lockfile.bytes, authoritative: lockfile.authoritative })),
		})
	);
	return {
		projectRoot,
		manifestPath,
		manifest,
		manifestBytes,
		manifestSha256,
		packageManager,
		workspaceRoot: workspace?.root ?? null,
		workspaceRelativePath: workspace?.relativePath ?? null,
		lockfiles,
		fingerprint,
	};
}

export function requireWorkspaceMutationPermission(context: IProjectPackageContext, allowWorkspaceRoot: unknown): void {
	if (context.workspaceRoot && context.workspaceRoot !== context.projectRoot && allowWorkspaceRoot !== true) {
		throw new Error(
			`The active project is workspace "${context.workspaceRelativePath}" inside ${context.workspaceRoot}. Set allowWorkspaceRoot=true only after reviewing that the package manager may update the workspace-root lockfile.`
		);
	}
}

export function packageProjectRelativePath(context: IProjectPackageContext, absolutePath: string): string {
	const value = relative(context.projectRoot, absolutePath);
	return value === "" ? "." : isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`) ? absolutePath : value.replace(/\\/g, "/");
}
