import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { Scene } from "babylonjs";
import { dirname, join, relative } from "path/posix";
import { readFile, readdir } from "fs/promises";

import { IMCPActionOptions } from "../action";
import { projectConfiguration } from "../../project/configuration";

interface IProjectCodeTestRun {
	id: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	status: "passed" | "failed" | "canceled" | "timed-out";
	exitCode: number | null;
	packageScript: string;
	coverage: boolean;
	command: string;
	output: string;
	outputTruncated: boolean;
}

interface IProjectCodeTestingState {
	version: 1;
	revision: number;
	packageScript: string;
	coverageScript: string | null;
	timeoutMs: number;
	maximumOutputBytes: number;
	runs: IProjectCodeTestRun[];
}

interface IActiveCodeTestRun {
	id: string;
	child: ChildProcessWithoutNullStreams;
	startedAt: string;
	packageScript: string;
	coverage: boolean;
	outputBytes: number;
	output: string[];
	outputTruncated: boolean;
	canceled: boolean;
	timedOut: boolean;
	closed: boolean;
	forceKill: ReturnType<typeof setTimeout> | null;
}

const activeCodeRuns = new WeakMap<Scene, IActiveCodeTestRun>();

function state(scene: Scene): IProjectCodeTestingState {
	scene.metadata ??= {};
	const source = scene.metadata.babylonEditorProjectCodeTesting;
	if (!source || source.version !== 1) {
		scene.metadata.babylonEditorProjectCodeTesting = {
			version: 1,
			revision: 0,
			packageScript: "test",
			coverageScript: "coverage",
			timeoutMs: 120_000,
			maximumOutputBytes: 1_048_576,
			runs: [],
		} satisfies IProjectCodeTestingState;
	}
	const value = scene.metadata.babylonEditorProjectCodeTesting as IProjectCodeTestingState;
	if (!Number.isInteger(value.revision) || value.revision < 0) {
		throw new Error("Project code-test revision is invalid.");
	}
	if (typeof value.packageScript !== "string" || !value.packageScript || value.packageScript.length > 128) {
		throw new Error("Project code-test packageScript is invalid.");
	}
	if (value.coverageScript !== null && (typeof value.coverageScript !== "string" || !value.coverageScript || value.coverageScript.length > 128)) {
		throw new Error("Project code-test coverageScript is invalid.");
	}
	if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1_000 || value.timeoutMs > 600_000) {
		throw new Error("Project code-test timeoutMs must be from 1000 through 600000.");
	}
	if (!Number.isInteger(value.maximumOutputBytes) || value.maximumOutputBytes < 16_384 || value.maximumOutputBytes > 4_194_304) {
		throw new Error("Project code-test maximumOutputBytes must be from 16384 through 4194304.");
	}
	value.runs = Array.isArray(value.runs) ? value.runs.slice(0, 10) : [];
	return value;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

async function packageJson(): Promise<any> {
	try {
		return JSON.parse(await readFile(join(projectDirectory(), "package.json"), "utf8"));
	} catch (error) {
		throw new Error(`Could not read the open project's package.json: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function discoverTestFiles(): Promise<string[]> {
	const root = projectDirectory();
	const results: string[] = [];
	const queue = [root];
	let visited = 0;
	while (queue.length && visited < 10_000 && results.length < 2_000) {
		const directory = queue.shift()!;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			visited++;
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".bjseditor" || entry.name === "dist" || entry.name === "build") {
				continue;
			}
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				queue.push(absolute);
			} else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry.name)) {
				results.push(relative(root, absolute));
			}
		}
	}
	return results.sort();
}

function detectFramework(manifest: any): string {
	const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
	if (dependencies.vitest) {
		return "vitest";
	}
	if (dependencies.jest) {
		return "jest";
	}
	if (dependencies.mocha) {
		return "mocha";
	}
	if (dependencies.ava) {
		return "ava";
	}
	if (dependencies["@playwright/test"]) {
		return "playwright";
	}
	return "project-defined";
}

function commandFor(packageManager: string, script: string): { command: string; args: string[]; display: string } {
	switch (packageManager) {
		case "npm":
			return { command: "npm", args: ["run", script], display: `npm run ${script}` };
		case "pnpm":
			return { command: "pnpm", args: ["run", script], display: `pnpm run ${script}` };
		case "bun":
			return { command: "bun", args: ["run", script], display: `bun run ${script}` };
		default:
			return { command: "yarn", args: ["run", script], display: `yarn run ${script}` };
	}
}

function appendOutput(run: IActiveCodeTestRun, chunk: Buffer, maximumBytes: number): void {
	if (run.outputBytes >= maximumBytes) {
		run.outputTruncated = true;
		return;
	}
	const remaining = maximumBytes - run.outputBytes;
	const bounded = chunk.subarray(0, remaining);
	run.outputBytes += bounded.byteLength;
	run.output.push(bounded.toString("utf8"));
	if (bounded.byteLength < chunk.byteLength) {
		run.outputTruncated = true;
	}
}

function stripAnsiColors(value: string): string {
	let result = "";
	let offset = 0;
	while (offset < value.length) {
		const start = value.indexOf("\u001b[", offset);
		if (start < 0) {
			result += value.slice(offset);
			break;
		}
		result += value.slice(offset, start);
		const end = value.indexOf("m", start + 2);
		if (end < 0) {
			result += value.slice(start);
			break;
		}
		offset = end + 1;
	}
	return result;
}

/**
 * Signals the package-manager process and everything it started. Killing only `yarn`/`npm` leaves the actual test
 * process running with the output pipe open, so the run would never finish and every later run would be refused.
 */
function signalCodeTestTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (child.pid === undefined) {
		return;
	}
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill(signal));
		return;
	}
	try {
		// The child leads its own process group (spawned detached), so a negative pid reaches its descendants too.
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

function terminateCodeTest(run: IActiveCodeTestRun): void {
	if (run.closed) {
		return;
	}
	signalCodeTestTree(run.child, "SIGTERM");
	if (!run.forceKill) {
		run.forceKill = setTimeout(() => signalCodeTestTree(run.child, "SIGKILL"), 5_000);
		run.forceKill.unref?.();
	}
}

export async function getProjectCodeTests(scene: Scene): Promise<any> {
	const value = state(scene);
	const manifest = await packageJson();
	const files = await discoverTestFiles();
	const active = activeCodeRuns.get(scene);
	return {
		version: value.version,
		revision: value.revision,
		configuration: {
			packageScript: value.packageScript,
			coverageScript: value.coverageScript,
			timeoutMs: value.timeoutMs,
			maximumOutputBytes: value.maximumOutputBytes,
		},
		framework: detectFramework(manifest),
		scripts: Object.keys(manifest.scripts ?? {}).sort(),
		configuredScriptAvailable: typeof manifest.scripts?.[value.packageScript] === "string",
		coverageScriptAvailable: value.coverageScript !== null && typeof manifest.scripts?.[value.coverageScript] === "string",
		discoveredFiles: files,
		discoveryTruncated: files.length >= 2_000,
		active: active
			? {
					id: active.id,
					startedAt: active.startedAt,
					packageScript: active.packageScript,
					coverage: active.coverage,
					outputBytes: active.outputBytes,
					outputTruncated: active.outputTruncated,
				}
			: null,
		runs: structuredClone(value.runs),
		limitation:
			"The editor executes the selected project-owned package script and reports its exit/output; test syntax, discovery, isolation, and coverage semantics remain owned by that framework.",
	};
}

export async function setProjectCodeTests(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = state(scene);
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== value.revision) {
		throw new Error(`Project code-test revision is ${value.revision}; received stale or missing expectedRevision ${String(data.expectedRevision)}.`);
	}
	const manifest = await packageJson();
	if (data.packageScript !== undefined) {
		if (typeof data.packageScript !== "string" || !data.packageScript || data.packageScript.length > 128) {
			throw new Error("packageScript must be a bounded non-empty script name.");
		}
		if (typeof manifest.scripts?.[data.packageScript] !== "string") {
			throw new Error(`package.json has no "${data.packageScript}" script.`);
		}
		value.packageScript = data.packageScript;
	}
	if (data.coverageScript !== undefined) {
		if (data.coverageScript !== null && (typeof data.coverageScript !== "string" || !data.coverageScript || data.coverageScript.length > 128)) {
			throw new Error("coverageScript must be null or a bounded non-empty script name.");
		}
		if (data.coverageScript !== null && typeof manifest.scripts?.[data.coverageScript] !== "string") {
			throw new Error(`package.json has no "${data.coverageScript}" script.`);
		}
		value.coverageScript = data.coverageScript;
	}
	if (data.timeoutMs !== undefined) {
		if (!Number.isInteger(data.timeoutMs) || data.timeoutMs < 1_000 || data.timeoutMs > 600_000) {
			throw new Error("timeoutMs must be from 1000 through 600000.");
		}
		value.timeoutMs = data.timeoutMs;
	}
	if (data.maximumOutputBytes !== undefined) {
		if (!Number.isInteger(data.maximumOutputBytes) || data.maximumOutputBytes < 16_384 || data.maximumOutputBytes > 4_194_304) {
			throw new Error("maximumOutputBytes must be from 16384 through 4194304.");
		}
		value.maximumOutputBytes = data.maximumOutputBytes;
	}
	value.revision++;
	options.editor.layout.inspector.forceUpdate();
	return getProjectCodeTests(scene);
}

export async function runProjectCodeTests(scene: Scene, data: any, options: IMCPActionOptions): Promise<IProjectCodeTestRun> {
	if (activeCodeRuns.has(scene)) {
		throw new Error("A project code-test process is already active.");
	}
	if (data.confirm !== true) {
		throw new Error("Running project-owned package scripts requires confirm=true.");
	}
	const value = state(scene);
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== value.revision) {
		throw new Error(`Project code-test revision is ${value.revision}; received stale or missing expectedRevision ${String(data.expectedRevision)}.`);
	}
	const manifest = await packageJson();
	const script = data.coverage === true ? value.coverageScript : value.packageScript;
	if (!script) {
		throw new Error("No coverage package script is configured.");
	}
	if (typeof manifest.scripts?.[script] !== "string") {
		throw new Error(`package.json has no "${script}" script.`);
	}
	const command = commandFor(options.editor.state.packageManager ?? "yarn", script);
	const child = spawn(command.command, command.args, {
		cwd: projectDirectory(),
		env: { ...process.env, CI: data.ci === false ? process.env.CI : "true", FORCE_COLOR: "0", NO_COLOR: "1" },
		shell: false,
		windowsHide: true,
		stdio: "pipe",
		// Own process group on POSIX so timeouts and cancellation can terminate the whole script tree.
		detached: process.platform !== "win32",
	});
	const started = Date.now();
	const active: IActiveCodeTestRun = {
		id: `code-test-${started}`,
		child,
		startedAt: new Date(started).toISOString(),
		packageScript: script,
		coverage: data.coverage === true,
		outputBytes: 0,
		output: [],
		outputTruncated: false,
		canceled: false,
		timedOut: false,
		closed: false,
		forceKill: null,
	};
	activeCodeRuns.set(scene, active);
	child.stdout.on("data", (chunk: Buffer) => appendOutput(active, chunk, value.maximumOutputBytes));
	child.stderr.on("data", (chunk: Buffer) => appendOutput(active, chunk, value.maximumOutputBytes));
	const timeout = setTimeout(() => {
		active.timedOut = true;
		terminateCodeTest(active);
	}, value.timeoutMs);
	child.once("close", () => {
		active.closed = true;
		if (active.forceKill) {
			clearTimeout(active.forceKill);
		}
	});
	timeout.unref?.();
	try {
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const finished = Date.now();
		const result: IProjectCodeTestRun = {
			id: active.id,
			startedAt: active.startedAt,
			finishedAt: new Date(finished).toISOString(),
			durationMs: finished - started,
			status: active.canceled ? "canceled" : active.timedOut ? "timed-out" : exitCode === 0 ? "passed" : "failed",
			exitCode,
			packageScript: script,
			coverage: active.coverage,
			command: command.display,
			output: stripAnsiColors(active.output.join("")),
			outputTruncated: active.outputTruncated,
		};
		value.runs = [result, ...value.runs].slice(0, 10);
		options.editor.layout.inspector.forceUpdate();
		return structuredClone(result);
	} finally {
		clearTimeout(timeout);
		activeCodeRuns.delete(scene);
	}
}

export function cancelProjectCodeTests(scene: Scene, data: any): any {
	const active = activeCodeRuns.get(scene);
	if (!active) {
		return { canceled: false, reason: "no-active-run" };
	}
	if (data.confirm !== true) {
		throw new Error("Canceling a project code-test process requires confirm=true.");
	}
	if (data.runId && data.runId !== active.id) {
		throw new Error(`Active project code-test run is "${active.id}", not "${data.runId}".`);
	}
	active.canceled = true;
	terminateCodeTest(active);
	return { canceled: true, runId: active.id };
}

export function shutdownProjectCodeTests(scene: Scene): void {
	const active = activeCodeRuns.get(scene);
	if (active) {
		active.canceled = true;
		terminateCodeTest(active);
	}
	activeCodeRuns.delete(scene);
}
