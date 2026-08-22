import { createHash, randomUUID } from "crypto";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";

import { ensureDir, move, pathExists, readJSON, realpath, remove, stat, writeJSON } from "fs-extra";

import { projectConfiguration } from "../../project/configuration";

export function renderingAssetProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function isContained(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === "" || (!value.startsWith("../") && value !== "..");
}

export async function secureRenderingAssetPath(path: unknown, extension: string, label: string): Promise<string> {
	if (typeof path !== "string" || !path.trim()) {
		throw new Error(`${label} path must be a non-empty project-relative path.`);
	}
	if (isAbsolute(path)) {
		throw new Error(`${label} paths must be relative to the open project.`);
	}
	const projectDirectory = renderingAssetProjectDirectory();
	const absolutePath = normalize(join(projectDirectory, path));
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error(`${label} paths must stay inside the open project directory.`);
	}
	if (!absolutePath.toLowerCase().endsWith(extension.toLowerCase())) {
		throw new Error(`${label} assets must use the ${extension} extension.`);
	}
	const root = await realpath(projectDirectory);
	let current = projectDirectory;
	for (const segment of relative(projectDirectory, dirname(absolutePath)).split("/").filter(Boolean)) {
		current = join(current, segment);
		if (await pathExists(current)) {
			const canonical = await realpath(current);
			if (!isContained(root, canonical)) {
				throw new Error(`${label} path traverses a symbolic link outside the project: ${path}`);
			}
		}
	}
	if (await pathExists(absolutePath)) {
		const canonical = await realpath(absolutePath);
		if (!isContained(root, canonical)) {
			throw new Error(`${label} path resolves outside the project: ${path}`);
		}
	}
	return absolutePath;
}

export function renderingAssetRelativePath(absolutePath: string): string {
	return relative(renderingAssetProjectDirectory(), absolutePath).replace(/\\/g, "/");
}

export function renderingAssetHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function readBoundedRenderingAsset(
	path: unknown,
	extension: string,
	label: string,
	maximumBytes: number
): Promise<{ absolutePath: string; relativePath: string; source: unknown }> {
	const absolutePath = await secureRenderingAssetPath(path, extension, label);
	if (!(await pathExists(absolutePath))) {
		throw new Error(`${label} asset not found: ${path}`);
	}
	const information = await stat(absolutePath);
	if (!information.isFile() || information.size > maximumBytes) {
		throw new Error(`${label} asset must be a file no larger than ${maximumBytes} bytes.`);
	}
	return { absolutePath, relativePath: renderingAssetRelativePath(absolutePath), source: await readJSON(absolutePath) };
}

export async function writeAtomicRenderingAsset(
	absolutePath: string,
	value: unknown,
	maximumBytes: number,
	validate: (source: unknown) => void,
	label = "Rendering asset"
): Promise<void> {
	await ensureDir(dirname(absolutePath));
	const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
	try {
		await writeJSON(temporaryPath, value, { spaces: "\t", encoding: "utf-8" });
		const information = await stat(temporaryPath);
		if (information.size > maximumBytes) {
			throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
		}
		const source = await readJSON(temporaryPath);
		validate(source);
		await move(temporaryPath, absolutePath, { overwrite: true });
	} finally {
		if (await pathExists(temporaryPath)) {
			await remove(temporaryPath);
		}
	}
}
