import { basename, dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";

import { copy, lstat, mkdir, move, pathExists, readJSON, remove, stat, writeJSON } from "fs-extra";

import { normalizedGlob } from "../tools/fs";

import { IEditorBuildScene, IEditorProject, IEditorSceneBuildSettings, IEditorSceneTemplateManifest } from "./typings";

const sceneBuildSettingsVersion = 1 as const;
const sceneTemplateVersion = 1 as const;
const maximumManagedScenes = 512;
const maximumTemplateFiles = 10_000;
const maximumTemplateBytes = 2 * 1024 * 1024 * 1024;
const maximumTemplateJsonBytes = 64 * 1024 * 1024;

export interface IEditorSceneTemplateSummary extends IEditorSceneTemplateManifest {
	path: string;
}

function normalizeRelativePath(path: string): string {
	return normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "").replace(/^\/+/, "");
}

function assertProjectRelativePath(projectDirectory: string, path: string, extension: string): { absolutePath: string; relativePath: string } {
	const relativePath = normalizeRelativePath(path);
	const absolutePath = normalize(join(projectDirectory, relativePath));
	const relativeFromProject = relative(projectDirectory, absolutePath);

	if (
		!relativePath ||
		path.length > 1024 ||
		isAbsolute(path) ||
		/^[a-z]:\//i.test(path.replaceAll("\\", "/")) ||
		relativeFromProject.startsWith("../") ||
		relativeFromProject === ".." ||
		extname(relativePath).toLowerCase() !== extension
	) {
		throw new Error(`Path must be project-relative and end in ${extension}: ${path}`);
	}

	return { absolutePath, relativePath };
}

export function normalizeSceneBuildSettings(
	settings: IEditorSceneBuildSettings | undefined,
	lastOpenedScene: string | null,
	discoveredScenePaths: string[]
): IEditorSceneBuildSettings {
	const discovered = [...new Set(discoveredScenePaths.map(normalizeRelativePath))].sort((a, b) => a.localeCompare(b));
	const discoveredSet = new Set(discovered);
	const scenes: IEditorBuildScene[] = [];
	const added = new Set<string>();

	const add = (path: string, enabled: boolean): void => {
		path = normalizeRelativePath(path);
		if (!discoveredSet.has(path) || added.has(path)) {
			return;
		}

		added.add(path);
		scenes.push({ path, enabled });
	};

	if (settings?.version === sceneBuildSettingsVersion && Array.isArray(settings.scenes)) {
		settings.scenes.forEach((entry) => add(entry.path, entry.enabled !== false));
	} else if (lastOpenedScene) {
		add(lastOpenedScene, true);
	}

	discovered.forEach((path) => add(path, true));

	return { version: sceneBuildSettingsVersion, scenes };
}

export function addSceneToBuildSettings(settings: IEditorSceneBuildSettings, path: string, enabled = true): IEditorSceneBuildSettings {
	path = normalizeRelativePath(path);
	if (settings.scenes.some((entry) => entry.path === path)) {
		return settings;
	}

	return { version: sceneBuildSettingsVersion, scenes: [...settings.scenes, { path, enabled }] };
}

export function renameSceneInBuildSettings(settings: IEditorSceneBuildSettings, oldPath: string, newPath: string): IEditorSceneBuildSettings {
	oldPath = normalizeRelativePath(oldPath);
	newPath = normalizeRelativePath(newPath);
	return {
		version: sceneBuildSettingsVersion,
		scenes: settings.scenes.map((entry) => (entry.path === oldPath ? { ...entry, path: newPath } : entry)),
	};
}

export function removeSceneFromBuildSettings(settings: IEditorSceneBuildSettings, path: string): IEditorSceneBuildSettings {
	path = normalizeRelativePath(path);
	return { version: sceneBuildSettingsVersion, scenes: settings.scenes.filter((entry) => entry.path !== path) };
}

export async function discoverProjectScenes(projectDirectory: string): Promise<string[]> {
	const paths = await normalizedGlob(join(projectDirectory, "**/*.scene"), {
		nodir: false,
		ignore: ["**/node_modules/**", "**/public/**", "**/*.scenetemplate/**"],
	});

	if (paths.length > maximumManagedScenes) {
		throw new Error(`Scene management supports at most ${maximumManagedScenes} scene assets per project.`);
	}

	return paths.map((path) => normalizeRelativePath(relative(projectDirectory, path.toString()))).sort((a, b) => a.localeCompare(b));
}

export async function readSceneBuildSettings(projectPath: string, project?: IEditorProject): Promise<IEditorSceneBuildSettings> {
	project ??= (await readJSON(projectPath, "utf-8")) as IEditorProject;
	const projectDirectory = dirname(projectPath);
	const discovered = await discoverProjectScenes(projectDirectory);

	return normalizeSceneBuildSettings(project.sceneBuildSettings, project.lastOpenedScene, discovered);
}

export async function writeSceneBuildSettings(projectPath: string, settings: IEditorSceneBuildSettings): Promise<IEditorSceneBuildSettings> {
	const project = (await readJSON(projectPath, "utf-8")) as IEditorProject;
	const normalizedSettings = normalizeSceneBuildSettings(settings, project.lastOpenedScene, await discoverProjectScenes(dirname(projectPath)));
	project.sceneBuildSettings = normalizedSettings;
	await writeJSON(projectPath, project, { spaces: 4 });

	return normalizedSettings;
}

function rewritePathStrings(value: unknown, sourcePath: string, destinationPath: string): unknown {
	if (typeof value === "string") {
		return value.includes(sourcePath) ? value.replaceAll(sourcePath, destinationPath) : value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => rewritePathStrings(entry, sourcePath, destinationPath));
	}
	if (value && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			(value as Record<string, unknown>)[key] = rewritePathStrings(entry, sourcePath, destinationPath);
		}
	}

	return value;
}

async function rewriteCopiedScenePaths(scenePath: string, sourcePath: string, destinationPath: string): Promise<void> {
	const jsonFiles = await normalizedGlob(join(scenePath, "**/*.json"), { nodir: true });
	await Promise.all(
		jsonFiles.map(async (file) => {
			if ((await stat(file.toString())).size > maximumTemplateJsonBytes) {
				throw new Error(`Scene template JSON exceeds ${maximumTemplateJsonBytes} bytes: ${file.toString()}`);
			}
			const data = await readJSON(file.toString(), "utf-8");
			rewritePathStrings(data, sourcePath, destinationPath);
			await writeJSON(file.toString(), data, { spaces: 4 });
		})
	);
}

async function assertSceneTemplatePayloadBounds(scenePath: string): Promise<void> {
	const files = await normalizedGlob(join(scenePath, "**/*"), { nodir: true, dot: true });
	if (files.length > maximumTemplateFiles) {
		throw new Error(`Scene templates support at most ${maximumTemplateFiles} files.`);
	}

	let totalBytes = 0;
	for (const file of files) {
		const fileStat = await lstat(file.toString());
		if (fileStat.isSymbolicLink()) {
			throw new Error(`Scene templates cannot contain symbolic links: ${file.toString()}`);
		}
		totalBytes += fileStat.size;
		if (totalBytes > maximumTemplateBytes) {
			throw new Error(`Scene template payload exceeds ${maximumTemplateBytes} bytes.`);
		}
	}
}

async function readSceneTemplateManifest(templatePath: string): Promise<IEditorSceneTemplateManifest> {
	if ((await stat(join(templatePath, "template.json"))).size > maximumTemplateJsonBytes) {
		throw new Error(`Scene template manifest exceeds ${maximumTemplateJsonBytes} bytes: ${templatePath}`);
	}
	const manifest = (await readJSON(join(templatePath, "template.json"), "utf-8")) as IEditorSceneTemplateManifest;
	if (
		manifest.version !== sceneTemplateVersion ||
		typeof manifest.name !== "string" ||
		!manifest.name ||
		manifest.name.length > 128 ||
		(typeof manifest.description !== "undefined" && (typeof manifest.description !== "string" || manifest.description.length > 1024)) ||
		typeof manifest.sourceScenePath !== "string" ||
		!manifest.sourceScenePath ||
		manifest.sourceScenePath.length > 1024 ||
		extname(normalizeRelativePath(manifest.sourceScenePath)).toLowerCase() !== ".scene" ||
		typeof manifest.createdAt !== "string"
	) {
		throw new Error(`Invalid scene template manifest: ${templatePath}`);
	}

	return manifest;
}

export async function listSceneTemplates(projectDirectory: string): Promise<IEditorSceneTemplateSummary[]> {
	const paths = await normalizedGlob(join(projectDirectory, "**/*.scenetemplate"), {
		nodir: false,
		ignore: ["**/node_modules/**", "**/public/**"],
	});
	if (paths.length > maximumManagedScenes) {
		throw new Error(`Scene management supports at most ${maximumManagedScenes} scene templates per project.`);
	}
	const templates = await Promise.all(
		paths.map(async (path) => {
			const absolutePath = path.toString();
			const manifest = await readSceneTemplateManifest(absolutePath);
			return { ...manifest, path: normalizeRelativePath(relative(projectDirectory, absolutePath)) };
		})
	);

	return templates.sort((a, b) => a.path.localeCompare(b.path));
}

export async function createSceneTemplate(
	projectDirectory: string,
	data: { sourcePath: string; templatePath: string; name?: string; description?: string }
): Promise<IEditorSceneTemplateSummary> {
	const source = assertProjectRelativePath(projectDirectory, data.sourcePath, ".scene");
	const template = assertProjectRelativePath(projectDirectory, data.templatePath, ".scenetemplate");
	if ((data.name?.length ?? 0) > 128 || (data.description?.length ?? 0) > 1024) {
		throw new Error("Scene template names support 128 characters and descriptions support 1024 characters.");
	}
	if (!(await pathExists(join(source.absolutePath, "config.json")))) {
		throw new Error(`Scene not found: ${source.relativePath}`);
	}
	if (await pathExists(template.absolutePath)) {
		throw new Error(`Scene template already exists: ${template.relativePath}`);
	}

	const temporaryPath = `${template.absolutePath}.tmp-${process.pid}-${Date.now()}`;
	const manifest: IEditorSceneTemplateManifest = {
		version: sceneTemplateVersion,
		name: data.name?.trim() || basename(template.relativePath, ".scenetemplate"),
		description: data.description?.trim() || undefined,
		sourceScenePath: source.relativePath,
		createdAt: new Date().toISOString(),
	};

	try {
		await assertSceneTemplatePayloadBounds(source.absolutePath);
		await mkdir(temporaryPath, { recursive: true });
		await copy(source.absolutePath, join(temporaryPath, "source.scene"));
		await writeJSON(join(temporaryPath, "template.json"), manifest, { spaces: 4 });
		await move(temporaryPath, template.absolutePath);
	} catch (error) {
		await remove(temporaryPath);
		throw error;
	}

	return { ...manifest, path: template.relativePath };
}

export async function instantiateSceneTemplate(projectDirectory: string, data: { templatePath: string; destinationPath: string }): Promise<{ path: string; templatePath: string }> {
	const template = assertProjectRelativePath(projectDirectory, data.templatePath, ".scenetemplate");
	const destination = assertProjectRelativePath(projectDirectory, data.destinationPath, ".scene");
	const manifest = await readSceneTemplateManifest(template.absolutePath);
	if (!(await pathExists(join(template.absolutePath, "source.scene", "config.json")))) {
		throw new Error(`Scene template payload is missing: ${template.relativePath}`);
	}
	if (await pathExists(destination.absolutePath)) {
		throw new Error(`Scene already exists: ${destination.relativePath}`);
	}

	const temporaryPath = `${destination.absolutePath}.tmp-${process.pid}-${Date.now()}`;
	try {
		await assertSceneTemplatePayloadBounds(join(template.absolutePath, "source.scene"));
		await copy(join(template.absolutePath, "source.scene"), temporaryPath);
		await rewriteCopiedScenePaths(temporaryPath, normalizeRelativePath(manifest.sourceScenePath), destination.relativePath);
		await move(temporaryPath, destination.absolutePath);
	} catch (error) {
		await remove(temporaryPath);
		throw error;
	}

	return { path: destination.relativePath, templatePath: template.relativePath };
}

export async function deleteSceneTemplate(projectDirectory: string, templatePath: string): Promise<{ deleted: true; path: string }> {
	const template = assertProjectRelativePath(projectDirectory, templatePath, ".scenetemplate");
	await readSceneTemplateManifest(template.absolutePath);
	await remove(template.absolutePath);

	return { deleted: true, path: template.relativePath };
}
