import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";
import { pathExists, readJSON, writeJSON } from "fs-extra";
import { Scene } from "babylonjs";
import { normalizedGlob } from "../../tools/fs";
import { projectConfiguration } from "../../project/configuration";

function getProjectDirectory(): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	return dirname(projectConfiguration.path);
}

function resolvePath(path: string): string {
	const directory = getProjectDirectory();
	const absolute = normalize(isAbsolute(path) ? path : join(directory, path));
	if (absolute !== directory && !absolute.startsWith(`${directory}/`)) throw new Error("Ragdoll paths must stay inside the open project directory.");
	if (extname(absolute) !== ".ragdoll") throw new Error("Ragdoll paths must end in .ragdoll.");
	return absolute;
}

export async function listRagdolls(): Promise<any> {
	const directory = getProjectDirectory();
	const paths = await normalizedGlob(join(directory, "/**/*.ragdoll"), { nodir: true, ignore: ["**/node_modules/**"] });
	return { ragdolls: paths.map((path) => ({ path: relative(directory, path.toString()) })) };
}

export async function getRagdoll(_scene: Scene, data: any): Promise<any> {
	return readJSON(resolvePath(data.path), { encoding: "utf-8" });
}

export async function saveRagdoll(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolvePath(data.path);
	if ((await pathExists(absolutePath)) && data.overwrite !== true) throw new Error(`Ragdoll already exists at ${data.path}. Set overwrite: true to replace it.`);
	const configuration = {
		assetRelativePath: data.configuration.assetRelativePath ?? "",
		rootNodeId: data.configuration.rootNodeId ?? "",
		skeletonName: data.configuration.skeletonName ?? "",
		scalingFactor: data.configuration.scalingFactor ?? 100,
		runtimeConfiguration: data.configuration.runtimeConfiguration ?? [],
	};
	await writeJSON(absolutePath, configuration, { spaces: "\t", encoding: "utf-8" });
	return { saved: true, path: relative(getProjectDirectory(), absolutePath), configuration };
}
