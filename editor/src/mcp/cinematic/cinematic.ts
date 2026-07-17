import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";
import { pathExists, readJSON, writeJSON } from "fs-extra";

import { Scene } from "babylonjs";
import { generateCinematicAnimationGroup, ICinematic } from "babylonjs-editor-tools";

import { normalizedGlob } from "../../tools/fs";
import { parseCinematic } from "../../editor/layout/cinematic/serialization/parse";
import { serializeCinematic } from "../../editor/layout/cinematic/serialization/serialize";
import { projectConfiguration } from "../../project/configuration";

function getProjectDirectory(): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	return dirname(projectConfiguration.path);
}

function resolveProjectPath(path: string): string {
	const directory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(directory, path));
	if (absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) throw new Error("Cinematic paths must stay inside the open project directory.");
	return absolutePath;
}

export async function listCinematics(): Promise<any> {
	const directory = getProjectDirectory();
	const matches = await normalizedGlob(join(directory, "/**/*.cinematic"), { nodir: true, ignore: ["**/node_modules/**"] });
	return {
		cinematics: (matches as string[]).map((path) => ({
			path: relative(directory, path),
			name: path
				.split("/")
				.pop()
				?.replace(/\.cinematic$/, ""),
		})),
	};
}

export async function getCinematic(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (extname(absolutePath) !== ".cinematic") throw new Error("Cinematic paths must end in .cinematic.");
	return readJSON(absolutePath, { encoding: "utf-8" });
}

export async function createCinematic(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (extname(absolutePath) !== ".cinematic") throw new Error("Cinematic paths must end in .cinematic.");
	if (await pathExists(absolutePath)) throw new Error(`An asset already exists at ${data.path}`);
	const cinematic: ICinematic = {
		name: data.name ?? "New Cinematic",
		framesPerSecond: data.framesPerSecond ?? 60,
		outputFramesPerSecond: data.outputFramesPerSecond ?? data.framesPerSecond ?? 60,
		tracks: data.tracks ?? [],
	};
	await writeJSON(absolutePath, cinematic, { spaces: "\t", encoding: "utf-8" });
	return { created: true, path: relative(getProjectDirectory(), absolutePath), cinematic };
}

export async function saveCinematic(scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (extname(absolutePath) !== ".cinematic") throw new Error("Cinematic paths must end in .cinematic.");
	if ((await pathExists(absolutePath)) && data.overwrite !== true) throw new Error(`A cinematic already exists at ${data.path}. Set overwrite: true to replace it.`);
	const parsed = parseCinematic(data.cinematic, scene);
	const cinematic = serializeCinematic(parsed);
	await writeJSON(absolutePath, cinematic, { spaces: "\t", encoding: "utf-8" });
	return { saved: true, path: relative(getProjectDirectory(), absolutePath), cinematic };
}

export async function playCinematic(scene: Scene, data: any): Promise<any> {
	const raw = await getCinematic(scene, data);
	const cinematic = parseCinematic(raw, scene);
	const group = generateCinematicAnimationGroup(cinematic as any, scene as any, { ignoreSounds: data.ignoreSounds ?? false });
	group.start(data.loop ?? false, data.speedRatio ?? 1);
	return { playing: true, name: cinematic.name, from: group.from, to: group.to };
}
