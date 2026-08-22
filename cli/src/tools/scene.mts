import { join } from "node:path/posix";
import { readdir } from "node:fs/promises";

import fs from "fs-extra";

async function readSceneContentFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });

	return entries
		.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && !entry.name.endsWith(".bjsmeta.json"))
		.map((entry) => entry.name)
		.sort();
}

export async function ensureSceneDirectories(scenePath: string) {
	await Promise.all([
		fs.ensureDir(join(scenePath, "nodes")),
		fs.ensureDir(join(scenePath, "meshes")),
		fs.ensureDir(join(scenePath, "lods")),
		fs.ensureDir(join(scenePath, "lights")),
		fs.ensureDir(join(scenePath, "cameras")),
		fs.ensureDir(join(scenePath, "geometries")),
		fs.ensureDir(join(scenePath, "generatedGeometries")),
		fs.ensureDir(join(scenePath, "skeletons")),
		fs.ensureDir(join(scenePath, "shadowGenerators")),
		fs.ensureDir(join(scenePath, "sceneLinks")),
		fs.ensureDir(join(scenePath, "gui")),
		fs.ensureDir(join(scenePath, "sounds")),
		fs.ensureDir(join(scenePath, "soundNodes")),
		fs.ensureDir(join(scenePath, "particleSystems")),
		fs.ensureDir(join(scenePath, "morphTargetManagers")),
		fs.ensureDir(join(scenePath, "morphTargets")),
		fs.ensureDir(join(scenePath, "animationGroups")),
		fs.ensureDir(join(scenePath, "sprite-maps")),
		fs.ensureDir(join(scenePath, "sprite-managers")),
		fs.ensureDir(join(scenePath, "nodeParticleSystemSets")),
	]);
}

export async function readSceneDirectories(scenePath: string) {
	const [
		nodesFiles,
		meshesFiles,
		lodsFiles,
		lightsFiles,
		cameraFiles,
		skeletonFiles,
		shadowGeneratorFiles,
		sceneLinkFiles,
		guiFiles,
		soundFiles,
		soundNodeFiles,
		particleSystemFiles,
		morphTargetManagerFiles,
		morphTargetFiles,
		animationGroupFiles,
		spriteMapFiles,
		spriteManagerFiles,
		geometryFiles,
		nodeParticleSystemSetFiles,
	] = await Promise.all([
		readSceneContentFiles(join(scenePath, "nodes")),
		readSceneContentFiles(join(scenePath, "meshes")),
		readSceneContentFiles(join(scenePath, "lods")),
		readSceneContentFiles(join(scenePath, "lights")),
		readSceneContentFiles(join(scenePath, "cameras")),
		readSceneContentFiles(join(scenePath, "skeletons")),
		readSceneContentFiles(join(scenePath, "shadowGenerators")),
		readSceneContentFiles(join(scenePath, "sceneLinks")),
		readSceneContentFiles(join(scenePath, "gui")),
		readSceneContentFiles(join(scenePath, "sounds")),
		readSceneContentFiles(join(scenePath, "soundNodes")),
		readSceneContentFiles(join(scenePath, "particleSystems")),
		readSceneContentFiles(join(scenePath, "morphTargetManagers")),
		readSceneContentFiles(join(scenePath, "morphTargets")),
		readSceneContentFiles(join(scenePath, "animationGroups")),
		readSceneContentFiles(join(scenePath, "sprite-maps")),
		readSceneContentFiles(join(scenePath, "sprite-managers")),
		readSceneContentFiles(join(scenePath, "geometries")),
		readSceneContentFiles(join(scenePath, "nodeParticleSystemSets")),
	]);

	return {
		nodesFiles,
		meshesFiles,
		lodsFiles,
		lightsFiles,
		cameraFiles,
		skeletonFiles,
		shadowGeneratorFiles,
		sceneLinkFiles,
		guiFiles,
		soundFiles,
		soundNodeFiles,
		particleSystemFiles,
		morphTargetManagerFiles,
		morphTargetFiles,
		animationGroupFiles,
		spriteMapFiles,
		spriteManagerFiles,
		geometryFiles,
		nodeParticleSystemSetFiles,
	};
}
