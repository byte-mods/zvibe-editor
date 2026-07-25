import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const MAX_BLENDER_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_BLENDER_LOG_BYTES = 64 * 1024;
const DEFAULT_BLENDER_TIMEOUT_MS = 5 * 60 * 1000;

const BLENDER_EXPORT_SCRIPT = `import bpy
import sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) != 2:
    raise RuntimeError("Expected input and output paths after --")

bpy.ops.wm.open_mainfile(filepath=argv[0])
bpy.ops.export_scene.gltf(filepath=argv[1], export_format="GLB", export_apply=True)
`;

export interface IBlenderConversionOptions {
	executable?: string;
	timeoutMs?: number;
}

export interface IBlenderConversionResult {
	content: Uint8Array;
	executable: string;
	outputBytes: number;
	stdout: string;
	stderr: string;
}

function blenderCandidates(explicit?: string): string[] {
	const configured = explicit ?? process.env.BJS_EDITOR_BLENDER_EXECUTABLE ?? process.env.BLENDER_EXECUTABLE;
	const values = [
		configured,
		...(process.platform === "darwin" ? ["/Applications/Blender.app/Contents/MacOS/Blender"] : []),
		...(process.platform === "win32" ? ["C:/Program Files/Blender Foundation/Blender 4.5/blender.exe", "C:/Program Files/Blender Foundation/Blender 4.4/blender.exe"] : []),
		"blender",
	].filter((value): value is string => !!value?.trim());
	return [...new Set(values)];
}

async function executableCanBeAttempted(executable: string): Promise<boolean> {
	if (executable === "blender") {
		return true;
	}
	try {
		await access(executable, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function appendBounded(current: string, chunk: Buffer): string {
	if (Buffer.byteLength(current) >= MAX_BLENDER_LOG_BYTES) {
		return current;
	}
	return `${current}${chunk.toString("utf-8", 0, Math.max(0, MAX_BLENDER_LOG_BYTES - Buffer.byteLength(current)))}`;
}

async function runBlender(executable: string, scriptPath: string, inputPath: string, outputPath: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["--background", "--factory-startup", "--python", scriptPath, "--", inputPath, outputPath], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => (stdout = appendBounded(stdout, chunk)));
		child.stderr.on("data", (chunk: Buffer) => (stderr = appendBounded(stderr, chunk)));
		child.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`Blender conversion exceeded the ${timeoutMs.toLocaleString()} ms timeout.`));
			} else if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new Error(`Blender exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.${stderr.trim() ? ` ${stderr.trim().slice(-2048)}` : ""}`));
			}
		});
	});
}

function validateGlb(content: Buffer): void {
	if (content.length < 20 || content.length > MAX_BLENDER_OUTPUT_BYTES) {
		throw new Error(`Blender produced an invalid or oversized GLB payload (${content.length.toLocaleString()} bytes).`);
	}
	if (content.readUInt32LE(0) !== 0x46546c67 || content.readUInt32LE(4) !== 2 || content.readUInt32LE(8) !== content.length) {
		throw new Error("Blender produced a malformed GLB v2 header.");
	}
}

/** Converts a real `.blend` file to a bounded GLB using an explicitly configured or installed Blender executable. */
export async function convertBlendFileToGlb(sourcePath: string, options: IBlenderConversionOptions = {}): Promise<IBlenderConversionResult> {
	const source = await stat(sourcePath);
	if (!source.isFile()) {
		throw new Error(`Blender conversion source is not a file: ${sourcePath}`);
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_BLENDER_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60 * 1000) {
		throw new Error("Blender conversion timeoutMs must be an integer from 1,000 through 900,000.");
	}
	const directory = await mkdtemp(join(tmpdir(), "zvibe-blender-"));
	const scriptPath = join(directory, "export_glb.py");
	const outputPath = join(directory, `${basename(sourcePath)}.glb`);
	await writeFile(scriptPath, BLENDER_EXPORT_SCRIPT, { encoding: "utf-8", mode: 0o600 });
	const failures: string[] = [];
	try {
		for (const executable of blenderCandidates(options.executable)) {
			if (!(await executableCanBeAttempted(executable))) {
				failures.push(`${executable}: not executable`);
				continue;
			}
			try {
				const logs = await runBlender(executable, scriptPath, sourcePath, outputPath, timeoutMs);
				const content = await readFile(outputPath);
				validateGlb(content);
				return { content: new Uint8Array(content), executable, outputBytes: content.length, ...logs };
			} catch (error) {
				failures.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(
			`Modern Blender files require Blender for deterministic GLB conversion. Configure BJS_EDITOR_BLENDER_EXECUTABLE or install Blender, then retry. Attempts: ${failures.join(" | ") || "none"}`
		);
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}
