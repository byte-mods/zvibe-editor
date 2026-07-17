import { createHash } from "crypto";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { pathExists, readFile, readJSON, stat, writeJSON } from "fs-extra";
import { Scene, Tools } from "babylonjs";
import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";

function directory(): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	return dirname(projectConfiguration.path);
}
function path(value: string): string {
	const root = directory(),
		resolved = normalize(isAbsolute(value) ? value : join(root, value));
	if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error("Addressable paths must stay inside the open project.");
	return resolved;
}
function configPath(): string {
	return join(directory(), "addressables.json");
}
async function config(): Promise<any> {
	return (await pathExists(configPath())) ? readJSON(configPath()) : { version: 1, groups: [] };
}
async function save(value: any): Promise<void> {
	await writeJSON(configPath(), value, { spaces: "\t" });
}
function group(value: any, data: any): any {
	const found = value.groups.find((candidate: any) => candidate.id === data.id || candidate.name === data.name);
	if (!found) throw new Error("Addressable group not found.");
	return found;
}
export async function listAddressableGroups(): Promise<any> {
	return config();
}
export async function createAddressableGroup(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await config();
	if (value.groups.some((candidate: any) => candidate.name === data.name)) throw new Error(`Addressable group "${data.name}" already exists.`);
	const result = { id: data.id ?? Tools.RandomId(), name: data.name, remoteUrl: data.remoteUrl, assets: [], assetLabels: {} };
	value.groups.push(result);
	await save(value);
	options.editor.layout.assets.refresh();
	return result;
}
export async function assignAddressableAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await config(),
		target = group(value, data),
		asset = path(data.assetPath);
	if (!(await pathExists(asset)) || (await stat(asset)).isDirectory()) throw new Error("Addressable asset must be an existing project file.");
	const assetPath = relative(directory(), asset);
	for (const candidate of value.groups) candidate.assets = candidate.assets.filter((candidatePath: string) => candidatePath !== assetPath);
	target.assets.push(assetPath);
	target.assetLabels ??= {};
	await save(value);
	options.editor.layout.assets.refresh();
	return { groupId: target.id, assetPath };
}
export async function removeAddressableAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await config(),
		target = group(value, data),
		assetPath = relative(directory(), path(data.assetPath));
	const index = target.assets.indexOf(assetPath);
	if (index === -1) throw new Error(`Asset "${assetPath}" is not in this group.`);
	target.assets.splice(index, 1);
	delete target.assetLabels?.[assetPath];
	await save(value);
	options.editor.layout.assets.refresh();
	return { removed: true, groupId: target.id, assetPath };
}
/** Sets the complete label set for one addressable asset in its group. */
export async function setAddressableAssetLabels(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await config(),
		target = group(value, data),
		assetPath = relative(directory(), path(data.assetPath));
	if (!target.assets.includes(assetPath)) throw new Error(`Asset "${assetPath}" is not in this group.`);
	if (!Array.isArray(data.labels) || data.labels.some((label: unknown) => typeof label !== "string" || !label.trim()))
		throw new Error("labels must be an array of non-empty strings.");
	target.assetLabels ??= {};
	target.assetLabels[assetPath] = [...new Set(data.labels.map((label: string) => label.trim()))].sort();
	await save(value);
	options.editor.layout.assets.refresh();
	return { groupId: target.id, assetPath, labels: target.assetLabels[assetPath] };
}
/** Finds addressable assets by one or more labels. */
export async function findAddressableAssetsByLabels(_scene: Scene, data: any): Promise<any> {
	const value = await config();
	if (!Array.isArray(data.labels) || !data.labels.length || data.labels.some((label: unknown) => typeof label !== "string" || !label.trim()))
		throw new Error("labels must contain one or more non-empty strings.");
	const requested = [...new Set(data.labels.map((label: string) => label.trim()))];
	const match = data.match ?? "all";
	if (!["all", "any"].includes(match)) throw new Error("match must be all or any.");
	return {
		assets: value.groups.flatMap((candidate: any) =>
			candidate.assets
				.filter((assetPath: string) => {
					const labels = candidate.assetLabels?.[assetPath] ?? [];
					return match === "all" ? requested.every((label) => labels.includes(label)) : requested.some((label) => labels.includes(label));
				})
				.map((assetPath: string) => ({ groupId: candidate.id, groupName: candidate.name, path: assetPath, labels: candidate.assetLabels?.[assetPath] ?? [] }))
		),
	};
}
/** Compares two generated addressable catalogs to plan a content update without changing files. */
export async function diffAddressableCatalogs(_scene: Scene, data: any): Promise<any> {
	const oldPath = path(data.previousCatalogPath);
	const nextPath = path(data.nextCatalogPath);
	if (!(await pathExists(oldPath)) || !(await pathExists(nextPath))) throw new Error("Both previousCatalogPath and nextCatalogPath must reference existing catalog files.");
	const [previous, next] = await Promise.all([readJSON(oldPath), readJSON(nextPath)]);
	const flatten = (catalog: any): Map<string, any> =>
		new Map(
			(catalog.groups ?? []).flatMap((candidate: any) =>
				(candidate.assets ?? []).map((asset: any) => [`${candidate.id}:${asset.path}`, { groupId: candidate.id, groupName: candidate.name, ...asset }])
			)
		);
	const before = flatten(previous),
		after = flatten(next);
	const added: any[] = [],
		changed: any[] = [],
		removed: any[] = [],
		unchanged: any[] = [];
	for (const [key, asset] of after) {
		const old = before.get(key);
		if (!old) added.push(asset);
		else if (old.hash !== asset.hash || JSON.stringify(old.labels ?? []) !== JSON.stringify(asset.labels ?? [])) changed.push({ previous: old, next: asset });
		else unchanged.push(asset);
	}
	for (const [key, asset] of before) if (!after.has(key)) removed.push(asset);
	return {
		previousCatalogPath: relative(directory(), oldPath),
		nextCatalogPath: relative(directory(), nextPath),
		added,
		changed,
		removed,
		unchanged,
		summary: { added: added.length, changed: changed.length, removed: removed.length, unchanged: unchanged.length },
	};
}
export async function buildAddressableCatalog(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await config(),
		output = path(data.outputPath ?? "assets/addressables.catalog.json");
	const groups = await Promise.all(
		value.groups.map(async (candidate: any) => ({
			id: candidate.id,
			name: candidate.name,
			remoteUrl: candidate.remoteUrl,
			assets: await Promise.all(
				candidate.assets.map(async (assetPath: string) => {
					const asset = path(assetPath),
						bytes = await readFile(asset);
					return {
						path: assetPath,
						sizeBytes: bytes.byteLength,
						hash: createHash("sha256").update(bytes).digest("hex"),
						labels: candidate.assetLabels?.[assetPath] ?? [],
					};
				})
			),
		}))
	);
	await writeJSON(output, { version: 1, generatedAt: new Date().toISOString(), groups }, { spaces: "\t" });
	options.editor.layout.assets.refresh();
	return {
		built: true,
		outputPath: relative(directory(), output),
		groupCount: groups.length,
		assetCount: groups.reduce((total, candidate) => total + candidate.assets.length, 0),
	};
}
