import { createHash } from "crypto";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { copyFile, ensureDir, pathExists, readFile, readJSON, stat, writeJSON } from "fs-extra";

export interface IExportedAddressableAsset {
	path: string;
	sizeBytes: number;
	hash: string;
	labels?: string[];
}

export interface IExportedAddressableGroup {
	id: string;
	name: string;
	remoteUrl?: string;
	assets: IExportedAddressableAsset[];
}

export interface IExportedAddressableCatalog {
	version: number;
	generatedAt: string;
	groups: IExportedAddressableGroup[];
}

/** Builds a fresh catalog and copies every assigned source file into exported scene output. */
export async function exportAddressables(projectDir: string, scenePath: string): Promise<{ catalog?: IExportedAddressableCatalog; files: string[] }> {
	const configPath = join(projectDir, "addressables.json");
	if (!(await pathExists(configPath))) return { files: [] };

	const config = await readJSON(configPath);
	const files: string[] = [];
	const groups = await Promise.all(
		(config.groups ?? []).map(
			async (group: any): Promise<IExportedAddressableGroup> => ({
				id: group.id,
				name: group.name,
				remoteUrl: group.remoteUrl,
				assets: await Promise.all(
					(group.assets ?? []).map(async (assetPath: string): Promise<IExportedAddressableAsset> => {
						const source = normalize(isAbsolute(assetPath) ? assetPath : join(projectDir, assetPath));
						if (source !== projectDir && !source.startsWith(`${projectDir}/`)) throw new Error(`Addressable asset is outside the project: ${assetPath}`);
						if (!(await pathExists(source))) throw new Error(`Addressable asset no longer exists: ${assetPath}`);
						const destination = join(scenePath, relative(projectDir, source));
						await ensureDir(dirname(destination));
						await copyFile(source, destination);
						files.push(destination);
						const bytes = await readFile(source);
						return {
							path: relative(projectDir, source),
							sizeBytes: (await stat(source)).size,
							hash: createHash("sha256").update(bytes).digest("hex"),
							labels: group.assetLabels?.[assetPath] ?? [],
						};
					})
				),
			})
		)
	);
	const catalog: IExportedAddressableCatalog = { version: 1, generatedAt: new Date().toISOString(), groups };
	const catalogPath = join(scenePath, "addressables.catalog.json");
	await writeJSON(catalogPath, catalog, { spaces: "\t" });
	files.push(catalogPath);
	return { catalog, files };
}
