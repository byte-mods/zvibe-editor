import { Scene } from "babylonjs";
import { dirname, isAbsolute, join, relative } from "path/posix";
import { mkdir, pathExists } from "fs-extra";
import sharp from "sharp";

import { projectConfiguration } from "../../project/configuration";

export function projectTestingPath(path: string): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	const directory = dirname(projectConfiguration.path);
	const absolute = isAbsolute(path) ? path : join(directory, path);
	if (absolute !== directory && !absolute.startsWith(`${directory}/`)) {
		throw new Error("Testing artifact paths must stay inside the open project.");
	}
	return absolute;
}

/** Compares two project raster images in RGBA space with bounded tolerance and optional red diff output. */
export async function compareVisualRegressionImages(_scene: Scene, data: any, _options?: unknown): Promise<any> {
	const baselinePath = projectTestingPath(data.baselinePath);
	const candidatePath = projectTestingPath(data.candidatePath);
	if (!(await pathExists(baselinePath)) || !(await pathExists(candidatePath))) {
		throw new Error("Both baselinePath and candidatePath must reference existing project images.");
	}
	const tolerance = data.tolerance ?? 0;
	if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
		throw new Error("tolerance must be an integer from 0 to 255.");
	}
	const [baseline, candidate] = await Promise.all([
		sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
		sharp(candidatePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
	]);
	if (baseline.info.width !== candidate.info.width || baseline.info.height !== candidate.info.height) {
		return {
			passed: false,
			reason: "dimension-mismatch",
			baseline: { width: baseline.info.width, height: baseline.info.height },
			candidate: { width: candidate.info.width, height: candidate.info.height },
		};
	}
	let differingPixels = 0;
	const diff = Buffer.alloc(baseline.data.length);
	for (let offset = 0; offset < baseline.data.length; offset += 4) {
		if ([0, 1, 2, 3].some((channel) => Math.abs(baseline.data[offset + channel] - candidate.data[offset + channel]) > tolerance)) {
			differingPixels++;
			diff[offset] = 255;
			diff[offset + 3] = 255;
		}
	}
	let diffPath: string | null = null;
	if (data.diffPath && differingPixels) {
		const output = projectTestingPath(data.diffPath);
		if (!output.endsWith(".png")) {
			throw new Error("diffPath must end in .png.");
		}
		await mkdir(dirname(output), { recursive: true });
		await sharp(diff, { raw: { width: baseline.info.width, height: baseline.info.height, channels: 4 } })
			.png()
			.toFile(output);
		diffPath = relative(dirname(projectConfiguration.path!), output);
	}
	return {
		passed: differingPixels === 0,
		baselinePath: relative(dirname(projectConfiguration.path!), baselinePath),
		candidatePath: relative(dirname(projectConfiguration.path!), candidatePath),
		diffPath,
		width: baseline.info.width,
		height: baseline.info.height,
		differingPixels,
		totalPixels: baseline.info.width * baseline.info.height,
		tolerance,
	};
}
