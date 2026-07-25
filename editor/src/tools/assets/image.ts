import { extname } from "path/posix";

import { readFile } from "fs-extra";
import sharp, { Sharp, SharpOptions } from "sharp";

import { decodeHighDynamicRange, decodePsd, decodeTga, HighDynamicRangeFormat, toneMapHighDynamicRange } from "babylonjs-editor-tools";

const decodedProjectImageExtensions = new Set([".tga", ".psd", ".psb", ".hdr", ".exr"]);

/** Returns whether an authored image source needs a shared bounded decoder before Sharp/browser consumption. */
export function requiresDecodedProjectImage(path: string): boolean {
	return decodedProjectImageExtensions.has(extname(path).toLowerCase());
}

/** Opens a project image with Sharp, adding bounded TGA/PSD decoders and tone-mapped HDR/EXR previews that libvips does not provide. */
export async function openProjectImage(path: string, options: SharpOptions = {}): Promise<Sharp> {
	const extension = extname(path).toLowerCase();
	if (!decodedProjectImageExtensions.has(extension)) {
		return Object.keys(options).length > 0 ? sharp(path, options) : sharp(path);
	}
	if (extension === ".hdr" || extension === ".exr") {
		const decoded = await decodeHighDynamicRange(await readFile(path), extension.slice(1) as HighDynamicRangeFormat);
		return sharp(Buffer.from(toneMapHighDynamicRange(decoded.pixels)), { ...options, raw: { width: decoded.width, height: decoded.height, channels: 4 } });
	}
	const decoded = extension === ".psd" || extension === ".psb" ? decodePsd(await readFile(path)) : decodeTga(await readFile(path));
	return sharp(Buffer.from(decoded.pixels), { ...options, raw: { width: decoded.width, height: decoded.height, channels: 4 } });
}
