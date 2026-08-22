import { constants } from "fs";
import { lstat, open, readdir, realpath } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { createHash } from "crypto";

import { valid } from "semver";

import { editorExtensionFingerprint, editorExtensionSha256, normalizeEditorExtensionManifest } from "./manifest";
import { IEditorExtensionDiscoveryResult, IInstalledEditorExtension } from "./types";

// Discovery runs on untrusted dependency trees, so every independently exhaustible dimension is bounded.
const maximumPackageJsonBytes = 1024 * 1024;
const maximumEntryBytes = 16 * 1024 * 1024;
const maximumContentBytes = 64 * 1024 * 1024;
const maximumContentFiles = 4096;
const maximumContentDirectories = 4096;
const maximumDirectoryEntries = 4096;
const maximumContentDepth = 32;
const maximumPackages = 512;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;

function packageSegments(packageName: string): string[] {
	if (typeof packageName !== "string" || packageName.length > 214 || !packageNamePattern.test(packageName)) {
		throw new Error(`Invalid package name "${String(packageName)}".`);
	}
	return packageName.split("/");
}

function contained(root: string, path: string): boolean {
	const candidate = relative(root, path);
	return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

async function regularBoundedFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
	// Opening the final component without following links closes the common lstat/read symlink race.
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new Error(`${label} must be a regular file.`);
		}
		if (stat.size > maximumBytes) {
			throw new Error(`${label} exceeds the ${maximumBytes}-byte limit.`);
		}
		const bytes = await handle.readFile();
		if (bytes.byteLength > maximumBytes) {
			throw new Error(`${label} exceeds the ${maximumBytes}-byte limit.`);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function findPackageJson(projectRoot: string, packageName: string): Promise<string | null> {
	const segments = packageSegments(packageName);
	let current = resolve(projectRoot);
	for (let depth = 0; depth < 32; depth++) {
		const candidate = join(current, "node_modules", ...segments, "package.json");
		try {
			const stat = await lstat(candidate);
			if (stat.isFile() && !stat.isSymbolicLink()) {
				return candidate;
			}
		} catch (error: unknown) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
				throw error;
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

async function resolveEntry(packageRoot: string, main: unknown): Promise<string> {
	if (main !== undefined && (typeof main !== "string" || !main.trim() || main.length > 512 || isAbsolute(main))) {
		throw new Error("Extension package main must be a non-empty relative path of at most 512 characters.");
	}
	const authored = typeof main === "string" ? main.trim() : "index.js";
	const base = resolve(packageRoot, authored);
	if (!contained(packageRoot, base)) {
		throw new Error("Extension package main escapes the installed package root.");
	}
	const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, join(base, "index.js"), join(base, "index.cjs"), join(base, "index.mjs")];
	for (const candidate of [...new Set(candidates)]) {
		try {
			const resolved = await realpath(candidate);
			if (!contained(packageRoot, resolved)) {
				throw new Error("Extension package entry resolves outside the installed package root.");
			}
			await regularBoundedFile(resolved, maximumEntryBytes, "Extension package entry");
			return resolved;
		} catch (error: unknown) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
		}
	}
	throw new Error(`Extension package entry "${authored}" does not exist.`);
}

async function hashPackageContent(packageRoot: string): Promise<{ sha256: string; fileCount: number; bytes: number }> {
	const hash = createHash("sha256");
	let fileCount = 0;
	let directoryCount = 0;
	let totalBytes = 0;
	async function visit(directory: string, depth: number): Promise<void> {
		if (depth > maximumContentDepth || directoryCount >= maximumContentDirectories) {
			throw new Error(`Extension package content exceeds the ${maximumContentDepth}-level or ${maximumContentDirectories}-directory limit.`);
		}
		directoryCount++;
		const resolvedDirectory = await realpath(directory);
		if (!contained(packageRoot, resolvedDirectory)) {
			throw new Error(`Extension package directory resolves outside the installed package root: ${relative(packageRoot, directory)}`);
		}
		// Stable traversal order makes trust fingerprints independent of filesystem enumeration order.
		const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
		if (entries.length > maximumDirectoryEntries) {
			throw new Error(`Extension package directory exceeds the ${maximumDirectoryEntries}-entry limit: ${relative(packageRoot, directory) || "."}`);
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") {
				continue;
			}
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(`Extension package content cannot contain symbolic links: ${relative(packageRoot, path)}`);
			}
			if (entry.isDirectory()) {
				await visit(path, depth + 1);
				continue;
			}
			if (!entry.isFile()) {
				throw new Error(`Extension package content must contain only regular files and directories: ${relative(packageRoot, path)}`);
			}
			if (fileCount >= maximumContentFiles) {
				throw new Error(`Extension package content exceeds the ${maximumContentFiles}-file limit.`);
			}
			const bytes = await regularBoundedFile(path, maximumContentBytes, `Extension package content file "${relative(packageRoot, path)}"`);
			totalBytes += bytes.byteLength;
			if (totalBytes > maximumContentBytes) {
				throw new Error(`Extension package content exceeds the ${maximumContentBytes}-byte limit.`);
			}
			const semanticPath = relative(packageRoot, path).split(sep).join("/");
			hash.update(`${semanticPath}\0${bytes.byteLength}\0`);
			hash.update(bytes);
			hash.update("\0");
			fileCount++;
		}
	}
	await visit(packageRoot, 0);
	return { sha256: hash.digest("hex"), fileCount, bytes: totalBytes };
}

function validatePackageManagerFingerprint(value: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error("packageManagerFingerprint must be the exact 64-character package state fingerprint.");
	}
	return value;
}

/** Inspects one installed dependency without importing or evaluating its entry module. */
export async function inspectInstalledEditorExtension(projectRoot: string, packageName: string, packageManagerFingerprint: string): Promise<IInstalledEditorExtension | null> {
	validatePackageManagerFingerprint(packageManagerFingerprint);
	const packageJsonPath = await findPackageJson(projectRoot, packageName);
	if (!packageJsonPath) {
		throw new Error(`Package "${packageName}" is not installed under the project or an ancestor workspace.`);
	}
	const packageJsonBytes = await regularBoundedFile(packageJsonPath, maximumPackageJsonBytes, `Package "${packageName}" package.json`);
	let packageJson: Record<string, unknown>;
	try {
		packageJson = JSON.parse(packageJsonBytes.toString("utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`Package "${packageName}" has malformed package.json JSON.`);
	}
	if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
		throw new Error(`Package "${packageName}" package.json must contain an object.`);
	}
	if (packageJson.zvibeEditor === undefined) {
		return null;
	}
	if (packageJson.name !== packageName) {
		throw new Error(`Extension package name must exactly match "${packageName}".`);
	}
	if (typeof packageJson.version !== "string" || valid(packageJson.version) !== packageJson.version) {
		throw new Error(`Extension package "${packageName}" must have an exact semantic version.`);
	}
	const packageRoot = await realpath(dirname(packageJsonPath));
	const entryPath = await resolveEntry(packageRoot, packageJson.main);
	const entryBytes = await regularBoundedFile(entryPath, maximumEntryBytes, `Extension package "${packageName}" entry`);
	const manifest = normalizeEditorExtensionManifest(packageJson.zvibeEditor);
	const packageJsonSha256 = editorExtensionSha256(packageJsonBytes);
	const entrySha256 = editorExtensionSha256(entryBytes);
	const content = await hashPackageContent(packageRoot);
	const fingerprint = editorExtensionFingerprint({
		packageName,
		packageVersion: packageJson.version,
		packageJsonSha256,
		entrySha256,
		contentSha256: content.sha256,
		packageManagerFingerprint,
		manifest,
	});
	return {
		packageName,
		packageVersion: packageJson.version,
		packageRoot,
		packageJsonPath,
		entryPath,
		packageJsonSha256,
		entrySha256,
		contentSha256: content.sha256,
		contentFileCount: content.fileCount,
		contentBytes: content.bytes,
		packageManagerFingerprint,
		fingerprint,
		manifest,
	};
}

/** Discovers manifest-bearing direct dependencies while isolating invalid packages as issues. */
export async function discoverInstalledEditorExtensions(
	projectRoot: string,
	packageNames: readonly string[],
	packageManagerFingerprint: string
): Promise<IEditorExtensionDiscoveryResult> {
	validatePackageManagerFingerprint(packageManagerFingerprint);
	if (!Array.isArray(packageNames) || packageNames.length > maximumPackages) {
		throw new Error(`packageNames must contain at most ${maximumPackages} entries.`);
	}
	packageNames.forEach(packageSegments);
	const uniqueNames = [...new Set(packageNames)].sort((left, right) => left.localeCompare(right));
	const extensions: IInstalledEditorExtension[] = [];
	const issues: { packageName: string; message: string }[] = [];
	for (const packageName of uniqueNames) {
		try {
			const extension = await inspectInstalledEditorExtension(projectRoot, packageName, packageManagerFingerprint);
			if (extension) {
				extensions.push(extension);
			}
		} catch (error) {
			issues.push({ packageName: String(packageName), message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { extensions, issues };
}
