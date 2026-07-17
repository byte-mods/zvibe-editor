import { createHash } from "crypto";
import { realpath } from "fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";

import { pathExists } from "fs-extra";
import sharp from "sharp";

import { Scene } from "babylonjs";
import { IComputeNodeGraphNode, ICustomRenderPassDefinition } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";

import { getCustomComputeNodeGraph } from "./compute-graph";
import { listCustomRenderPasses } from "./custom-passes";

const supportedExtensions = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);

function projectDirectory(): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	return dirname(projectConfiguration.path);
}

function projectTexturePath(path: string): { absolutePath: string; relativePath: string } {
	if (!path?.trim() || isAbsolute(path)) throw new Error("Texture preview paths must be non-empty and project-relative.");
	const root = projectDirectory();
	const absolutePath = normalize(join(root, path));
	if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) throw new Error("Texture preview paths must stay inside the open project directory.");
	const extension = extname(absolutePath).toLowerCase();
	if (!supportedExtensions.has(extension)) throw new Error(`Texture preview does not support ${extension || "extensionless"} files.`);
	return { absolutePath, relativePath: relative(root, absolutePath) };
}

function computePass(scene: Scene, data: any): ICustomRenderPassDefinition {
	const passes = listCustomRenderPasses(scene).passes as ICustomRenderPassDefinition[];
	const pass = passes.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!pass) throw new Error("Compute pass not found. Provide id (preferred) or name.");
	if (pass.passType !== "compute") throw new Error(`Custom render pass "${pass.name}" is not a compute pass.`);
	return pass;
}

async function thumbnail(
	node: IComputeNodeGraphNode,
	pass: ICustomRenderPassDefinition,
	width: number,
	height: number,
	sampling: "nearest" | "bilinear",
	includeImage: boolean
): Promise<any> {
	const input = node.resourceName ? pass.inputs[node.resourceName] : undefined;
	if (!input) throw new Error(`Texture input binding "${node.resourceName}" was not found.`);
	if (input.source !== "texture" || !input.path) throw new Error(`Texture input "${node.resourceName}" is a live ${input.source} resource and has no project image to decode.`);
	const path = projectTexturePath(input.path);
	if (!(await pathExists(path.absolutePath))) throw new Error(`Project texture was not found: ${path.relativePath}`);
	const realRoot = await realpath(projectDirectory());
	const realSource = await realpath(path.absolutePath);
	if (realSource !== realRoot && !realSource.startsWith(`${realRoot}/`)) throw new Error("Texture preview paths must resolve inside the open project directory.");
	const source = sharp(realSource, { animated: false, limitInputPixels: 67_108_864 }).rotate();
	const metadata = await source.metadata();
	if (!metadata.width || !metadata.height) throw new Error(`Project texture has no decodable dimensions: ${path.relativePath}`);
	const resized = await source
		.resize({ width, height, fit: "inside", withoutEnlargement: false, kernel: sampling === "nearest" ? sharp.kernel.nearest : sharp.kernel.lanczos3 })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const pixels = resized.data;
	const pixelCount = resized.info.width * resized.info.height;
	const sums = [0, 0, 0, 0];
	const minimum = [255, 255, 255, 255];
	const maximum = [0, 0, 0, 0];
	let coveredPixels = 0;
	for (let offset = 0; offset < pixels.length; offset += 4) {
		for (let channel = 0; channel < 4; channel++) {
			const value = pixels[offset + channel];
			sums[channel] += value;
			minimum[channel] = Math.min(minimum[channel], value);
			maximum[channel] = Math.max(maximum[channel], value);
		}
		if (pixels[offset + 3] > 0) coveredPixels++;
	}
	const png = includeImage
		? await sharp(pixels, { raw: { width: resized.info.width, height: resized.info.height, channels: 4 } })
				.png({ compressionLevel: 9 })
				.toBuffer()
		: null;
	return {
		nodeId: node.id,
		resourceName: node.resourceName,
		status: "ready",
		source: { path: path.relativePath, width: metadata.width, height: metadata.height, format: metadata.format ?? null },
		thumbnail: {
			width: resized.info.width,
			height: resized.info.height,
			channels: 4,
			sampling,
			mimeType: "image/png",
			pixelSha256: createHash("sha256").update(pixels).digest("hex"),
			averageRgba: sums.map((sum) => Number((sum / pixelCount / 255).toFixed(6))),
			minimumRgba: minimum.map((value) => Number((value / 255).toFixed(6))),
			maximumRgba: maximum.map((value) => Number((value / 255).toFixed(6))),
			alphaCoverage: Number((coveredPixels / pixelCount).toFixed(6)),
			...(png ? { imageBase64: png.toString("base64") } : {}),
		},
	};
}

/** Decodes bounded visual thumbnails for project-backed texture-load nodes without touching GPU resources. */
export async function getCustomComputeTextureNodePreviews(scene: Scene, data: any): Promise<any> {
	const pass = computePass(scene, data);
	const graph = getCustomComputeNodeGraph(scene, { id: pass.id }).graph;
	if (!graph) throw new Error(`Compute pass "${pass.name}" has no node graph.`);
	const width = data.width ?? 96;
	const height = data.height ?? 96;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || width > 128 || height < 16 || height > 128)
		throw new Error("Texture thumbnail width and height must be integers from 16 through 128.");
	const sampling: "nearest" | "bilinear" = data.sampling ?? (pass.samplingMode === "nearest" ? "nearest" : "bilinear");
	if (sampling !== "nearest" && sampling !== "bilinear") throw new Error("Texture thumbnail sampling must be nearest or bilinear.");
	const includeImage = data.includeImage !== false;
	const requested = data.nodeIds ? new Set<string>(data.nodeIds) : null;
	const nodes = graph.nodes.filter((node: IComputeNodeGraphNode) => node.type === "texture-load" && (!requested || requested.has(node.id)));
	if (nodes.length > 32) throw new Error("Texture thumbnail requests support at most 32 texture-load nodes at once; provide nodeIds to narrow the request.");
	const entries = await Promise.all(
		nodes.map(async (node: IComputeNodeGraphNode) => {
			try {
				return await thumbnail(node, pass, width, height, sampling, includeImage);
			} catch (error) {
				return { nodeId: node.id, resourceName: node.resourceName, status: "unavailable", error: error instanceof Error ? error.message : String(error) };
			}
		})
	);
	return {
		passId: pass.id,
		passName: pass.name,
		requestedSize: [width, height],
		sampling,
		includeImage,
		readyCount: entries.filter((entry) => entry.status === "ready").length,
		unavailableCount: entries.filter((entry) => entry.status === "unavailable").length,
		entries,
	};
}
