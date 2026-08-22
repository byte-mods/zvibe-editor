import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";

import { assetStreamingPriorities, type AssetStreamingPriority } from "babylonjs-editor-tools/loading/asset-streaming";

const contentTypes = new Map<string, string>([
	[".babylon", "application/json"],
	[".babylonbinarymeshdata", "application/octet-stream"],
	[".bin", "application/octet-stream"],
	[".env", "application/octet-stream"],
	[".glb", "model/gltf-binary"],
	[".gltf", "model/gltf+json"],
	[".json", "application/json"],
	[".ktx", "image/ktx"],
	[".ktx2", "image/ktx2"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".webp", "image/webp"],
	[".mp3", "audio/mpeg"],
	[".ogg", "audio/ogg"],
	[".wav", "audio/wav"],
	[".mp4", "video/mp4"],
	[".webm", "video/webm"],
]);

export interface IAssetStreamingByteRange {
	start: number;
	end: number;
	length: number;
}

export interface IPackagedAssetPath {
	absolutePath: string;
	relativePath: string;
	sizeBytes: number;
}

/** Parses one HTTP byte range; multiple or out-of-bounds ranges are rejected for deterministic resource use. */
export function parseAssetStreamingByteRange(value: string | null, sizeBytes: number): IAssetStreamingByteRange | null {
	if (!value) {
		return { start: 0, end: Math.max(0, sizeBytes - 1), length: sizeBytes };
	}
	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
	if (!match || (!match[1] && !match[2]) || sizeBytes === 0) {
		return null;
	}
	let start = match[1] ? Number(match[1]) : Math.max(0, sizeBytes - Number(match[2]));
	let end = match[2] && match[1] ? Number(match[2]) : sizeBytes - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= sizeBytes || end < start) {
		return null;
	}
	end = Math.min(end, sizeBytes - 1);
	return { start, end, length: end - start + 1 };
}

/** Uses an explicit valid priority, otherwise loading scene and geometry dependencies first. */
export function inferAssetStreamingPriority(path: string, authored: string | null): AssetStreamingPriority {
	if (authored && assetStreamingPriorities.includes(authored as AssetStreamingPriority)) {
		return authored as AssetStreamingPriority;
	}
	const extension = extname(path).toLowerCase();
	if (extension === ".babylon") {
		return "critical";
	}
	if ([".babylonbinarymeshdata", ".bin", ".glb", ".gltf"].includes(extension)) {
		return "high";
	}
	return "normal";
}

/** Returns a packaged response type without content sniffing. */
export function getAssetStreamingContentType(path: string): string {
	return contentTypes.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

/** Resolves a protocol URL by walking every segment and rejecting traversal, alternate authorities, and symbolic links. */
export async function resolvePackagedAsset(root: string, requestUrl: string): Promise<IPackagedAssetPath> {
	const resolvedRoot = await realpath(root);
	const url = new URL(requestUrl);
	if (url.protocol !== "zvibe-asset:" || url.hostname !== "local") {
		throw new Error("Asset request must use the local packaged-asset authority.");
	}
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(url.pathname);
	} catch {
		throw new Error("Asset request path contains invalid escaping.");
	}
	const segments = decodedPath.split("/").filter(Boolean);
	if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) {
		throw new Error("Asset request path must remain inside the packaged application.");
	}
	let candidate = resolvedRoot;
	for (const segment of segments) {
		candidate = join(candidate, segment);
		if ((await lstat(candidate)).isSymbolicLink()) {
			throw new Error("Asset request paths cannot traverse symbolic links.");
		}
	}
	const absolutePath = await realpath(candidate);
	const containedPath = relative(resolvedRoot, absolutePath);
	if (!containedPath || containedPath.startsWith("..") || isAbsolute(containedPath)) {
		throw new Error("Asset request path must resolve inside the packaged application.");
	}
	const stats = await lstat(absolutePath);
	if (!stats.isFile()) {
		throw new Error("Asset request path does not identify a file.");
	}
	return { absolutePath, relativePath: segments.join("/"), sizeBytes: stats.size };
}

/** Opens a bounded range and retains one configured chunk in memory while the consumer applies backpressure. */
export function openAssetStreamingFileRange(path: string, range: IAssetStreamingByteRange, chunkSizeBytes: number, signal: AbortSignal): ReadableStream<Uint8Array> {
	const handlePromise = open(path, "r");
	let position = range.start;
	let remaining = range.length;
	let closed = false;
	const close = async (): Promise<void> => {
		if (!closed) {
			closed = true;
			await (await handlePromise).close().catch(() => undefined);
		}
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			if (signal.aborted) {
				await close();
				controller.error(signal.reason ?? new Error("Asset stream was cancelled."));
				return;
			}
			if (remaining === 0) {
				await close();
				controller.close();
				return;
			}
			const target = new Uint8Array(Math.min(chunkSizeBytes, remaining));
			const { bytesRead } = await (await handlePromise).read(target, 0, target.byteLength, position);
			if (bytesRead === 0) {
				await close();
				controller.error(new Error("Packaged asset ended before its declared size."));
				return;
			}
			position += bytesRead;
			remaining -= bytesRead;
			controller.enqueue(bytesRead === target.byteLength ? target : target.subarray(0, bytesRead));
		},
		async cancel(): Promise<void> {
			await close();
		},
	});
}
