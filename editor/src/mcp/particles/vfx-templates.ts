import { createHash } from "crypto";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";

import { lstat, mkdir, realpath, writeFile } from "fs-extra";

import { Color4, NodeParticleSystemSet, Scene, Tools, Vector2, Vector3 } from "babylonjs";

import { projectConfiguration } from "../../project/configuration";
import { findAvailableFilename } from "../../tools/fs";
import { UniqueNumber } from "../../tools/tools";

import { IMCPActionOptions } from "../action";

export type VfxGraphTemplateCategory = "Starter" | "Environment" | "Impact";

export interface IVfxGraphTemplate {
	id: string;
	name: string;
	category: VfxGraphTemplateCategory;
	description: string;
	tags: string[];
	emitRate: number;
	lifeTime: number;
	size: number;
	scale: [number, number];
	color: [number, number, number, number];
	colorDead: [number, number, number, number];
	direction1: [number, number, number];
	direction2: [number, number, number];
	minEmitBox: [number, number, number];
	maxEmitBox: [number, number, number];
}

export const vfxGraphTemplateCategories: readonly VfxGraphTemplateCategory[] = ["Starter", "Environment", "Impact"];

const vfxGraphTemplates: readonly IVfxGraphTemplate[] = [
	{
		id: "starter-sprite",
		name: "Starter Sprite",
		category: "Starter",
		description: "A compact portable Node Particle graph with a box emitter, lifetime, color fade, and sprite output.",
		tags: ["default", "basic", "sprite", "portable"],
		emitRate: 10,
		lifeTime: 1,
		size: 1,
		scale: [1, 1],
		color: [1, 1, 1, 1],
		colorDead: [0, 0, 0, 0],
		direction1: [0, 1, 0],
		direction2: [0, 1, 0],
		minEmitBox: [-0.5, -0.5, -0.5],
		maxEmitBox: [0.5, 0.5, 0.5],
	},
	{
		id: "smoke-plume",
		name: "Smoke Plume",
		category: "Environment",
		description: "A slow upward plume with broad translucent particles and a four-second lifetime.",
		tags: ["smoke", "fog", "steam", "plume", "environment"],
		emitRate: 24,
		lifeTime: 4,
		size: 1.5,
		scale: [1, 1],
		color: [0.42, 0.45, 0.5, 0.42],
		colorDead: [0.12, 0.12, 0.14, 0],
		direction1: [-0.15, 0.45, -0.15],
		direction2: [0.15, 0.85, 0.15],
		minEmitBox: [-0.3, 0, -0.3],
		maxEmitBox: [0.3, 0.15, 0.3],
	},
	{
		id: "rain-field",
		name: "Rain Field",
		category: "Environment",
		description: "A wide, dense downward field using narrow stretched particles for rain-like effects.",
		tags: ["rain", "weather", "downward", "field", "environment"],
		emitRate: 500,
		lifeTime: 2,
		size: 0.08,
		scale: [0.25, 2.5],
		color: [0.55, 0.72, 1, 0.7],
		colorDead: [0.35, 0.5, 0.8, 0],
		direction1: [-0.1, -4, -0.1],
		direction2: [0.1, -5, 0.1],
		minEmitBox: [-5, 0, -5],
		maxEmitBox: [5, 0.2, 5],
	},
	{
		id: "sparks-burst",
		name: "Sparks Burst",
		category: "Impact",
		description: "A short-lived orange impact spray suitable for sparks, hits, and debris accents.",
		tags: ["sparks", "burst", "impact", "hit", "combat"],
		emitRate: 80,
		lifeTime: 0.75,
		size: 0.12,
		scale: [0.45, 1.8],
		color: [1, 0.55, 0.08, 1],
		colorDead: [0.22, 0.02, 0, 0],
		direction1: [-0.8, 1.6, -0.8],
		direction2: [0.8, 3, 0.8],
		minEmitBox: [-0.08, -0.08, -0.08],
		maxEmitBox: [0.08, 0.08, 0.08],
	},
];

const defaultParticleTextureDataUrl =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";

function canonical(value: any): any {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonical(child)])
		);
	}
	return value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export const vfxGraphTemplateCatalogRevision = sha256(JSON.stringify(canonical(vfxGraphTemplates)));

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function resolveTemplate(templateId: unknown): IVfxGraphTemplate {
	const template = vfxGraphTemplates.find((candidate) => candidate.id === templateId);
	if (!template) {
		throw new Error(`VFX Graph template was not found: ${String(templateId)}.`);
	}
	return template;
}

function setInputValue(graph: NodeParticleSystemSet, className: string, inputName: string, value: unknown): void {
	const block = graph.attachedBlocks.find((candidate) => candidate.getClassName() === className);
	const input = block?.inputs.find((candidate) => candidate.name === inputName);
	if (!block || !input || input.isConnected) {
		throw new Error(`The portable VFX template target ${className}.${inputName} is unavailable.`);
	}
	input.value = value as any;
}

/** Creates one deterministic, buildable Babylon Node Particle graph from the catalog. */
export function createVfxTemplateGraph(templateId: string, name?: string): NodeParticleSystemSet {
	const template = resolveTemplate(templateId);
	const graph = NodeParticleSystemSet.CreateDefault(name ?? template.name);
	for (const systemBlock of graph.systemBlocks) {
		(graph as any)._initializeBlock(systemBlock);
	}
	setInputValue(graph, "SystemBlock", "emitRate", template.emitRate);
	setInputValue(graph, "CreateParticleBlock", "lifeTime", template.lifeTime);
	setInputValue(graph, "CreateParticleBlock", "size", template.size);
	setInputValue(graph, "CreateParticleBlock", "scale", Vector2.FromArray(template.scale));
	setInputValue(graph, "CreateParticleBlock", "color", Color4.FromArray(template.color));
	setInputValue(graph, "CreateParticleBlock", "colorDead", Color4.FromArray(template.colorDead));
	setInputValue(graph, "BoxShapeBlock", "direction1", Vector3.FromArray(template.direction1));
	setInputValue(graph, "BoxShapeBlock", "direction2", Vector3.FromArray(template.direction2));
	setInputValue(graph, "BoxShapeBlock", "minEmitBox", Vector3.FromArray(template.minEmitBox));
	setInputValue(graph, "BoxShapeBlock", "maxEmitBox", Vector3.FromArray(template.maxEmitBox));
	const textureBlock = graph.attachedBlocks.find((block) => block.getClassName() === "ParticleTextureSourceBlock") as any;
	textureBlock.url = "";
	textureBlock.textureDataUrl = defaultParticleTextureDataUrl;
	textureBlock.serializedCachedData = true;
	graph.id = Tools.RandomId();
	graph.uniqueId = UniqueNumber.Get();
	return graph;
}

/** Searches and category-filters the deterministic VFX Graph template catalog. */
export function listVfxGraphTemplates(_scene: Scene | null, data: any): Record<string, unknown> {
	const query = String(data.query ?? "")
		.trim()
		.toLowerCase();
	const category = data.category as VfxGraphTemplateCategory | undefined;
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 50;
	if (query.length > 256 || (category !== undefined && !vfxGraphTemplateCategories.includes(category))) {
		throw new Error("VFX Graph template query or category is invalid.");
	}
	if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
		throw new Error("VFX Graph template paging requires offset 0-10000 and limit 1-50.");
	}
	const matches = vfxGraphTemplates.filter((template) => {
		const searchable = [template.id, template.name, template.category, template.description, ...template.tags].join(" ").toLowerCase();
		return (!category || template.category === category) && (!query || searchable.includes(query));
	});
	return {
		catalogRevision: vfxGraphTemplateCatalogRevision,
		query,
		category: category ?? null,
		total: matches.length,
		offset,
		limit,
		templates: structuredClone(matches.slice(offset, offset + limit)),
	};
}

async function resolveWritableProjectDirectory(path: string): Promise<string> {
	if (!path || path.length > 1024 || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
		throw new Error("VFX Graph output folders must be non-empty project-relative POSIX paths.");
	}
	const normalized = normalize(path);
	if (normalized === ".." || normalized.startsWith("../")) {
		throw new Error("VFX Graph output folders must stay inside the open project.");
	}
	const root = projectDirectory();
	const realRoot = await realpath(root);
	let output = root;
	for (const segment of normalized.split("/").filter((entry) => entry && entry !== ".")) {
		output = join(output, segment);
		let details = await lstat(output).catch((error: any) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
		if (!details) {
			await mkdir(output).catch((error: any) => {
				if (error?.code !== "EEXIST") {
					throw error;
				}
			});
			details = await lstat(output);
		}
		if (details.isSymbolicLink() || !details.isDirectory()) {
			throw new Error("VFX Graph output folders must contain only regular project directories.");
		}
		const canonicalPath = await realpath(output);
		if (canonicalPath !== realRoot && !canonicalPath.startsWith(`${realRoot}/`)) {
			throw new Error("VFX Graph output folders cannot escape the open project through symbolic links.");
		}
	}
	return output;
}

/** Creates a compile-checked `.npss` asset from one exact catalog revision. */
export async function createVfxGraphFromTemplate(scene: Scene, data: any, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	if (data.expectedCatalogRevision !== vfxGraphTemplateCatalogRevision) {
		throw new Error("The VFX Graph template catalog changed after inspection; search it again before creating an asset.");
	}
	const template = resolveTemplate(data.templateId);
	const name = String(data.name ?? template.name).trim();
	if (!name || name.length > 128 || name.includes("/") || name.includes("\\") || name.includes("\0")) {
		throw new Error("VFX Graph asset names must be 1-128 characters and cannot contain path separators.");
	}
	const graph = createVfxTemplateGraph(template.id, name);
	let batch: Awaited<ReturnType<NodeParticleSystemSet["buildAsync"]>> | null = null;
	try {
		batch = await graph.buildAsync(scene, false);
		const folder = await resolveWritableProjectDirectory(data.folder ?? "assets");
		const filename = await findAvailableFilename(folder, name, ".npss");
		const absolutePath = join(folder, filename);
		const serialized = {
			...graph.serialize(),
			id: graph.id,
			uniqueId: graph.uniqueId,
			babylonEditorVfxTemplate: {
				version: 1,
				id: template.id,
				category: template.category,
				catalogRevision: vfxGraphTemplateCatalogRevision,
			},
		};
		await writeFile(absolutePath, `${JSON.stringify(serialized, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
		// Asset panels are mounted lazily by FlexLayout. Persistence must remain
		// usable from an external MCP client even when that tab has not mounted.
		options.editor.layout.assets?.refresh?.();
		return {
			path: relative(projectDirectory(), absolutePath),
			name,
			template: structuredClone(template),
			catalogRevision: vfxGraphTemplateCatalogRevision,
			graphId: graph.id,
			systemCount: batch.systems.length,
		};
	} finally {
		batch?.dispose();
		graph.dispose();
	}
}
