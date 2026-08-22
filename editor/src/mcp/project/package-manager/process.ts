import { randomUUID } from "crypto";
import { spawn } from "child_process";

import { Scene } from "babylonjs";

import {
	IActiveProjectPackageProcess,
	IProjectPackageCommand,
	IProjectPackageCommandOptions,
	IProjectPackageProcessResult,
	IRunProjectPackageProcessOptions,
	ProjectPackageDependencyType,
	ProjectPackageManager,
	ProjectPackageOperation,
} from "./types";

const defaultMaximumOutputBytes = 1024 * 1024;
const defaultTimeoutMs = 600_000;
const maximumTimeoutMs = 1_800_000;
const activePackageProcesses = new WeakMap<Scene, IActiveProjectPackageProcess>();
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const packageVersionPattern = /^(?!-)[A-Za-z0-9][A-Za-z0-9*+._~^<>=|:/#@-]{0,511}$/;

export function validateProjectPackageName(value: unknown): string {
	if (typeof value !== "string" || !packageNamePattern.test(value)) {
		throw new Error("Package name must be a normal npm package identifier of at most 214 characters.");
	}
	if (value.length > 214) {
		throw new Error("Package name must be at most 214 characters.");
	}
	return value;
}

export function validateProjectPackageVersion(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	if (typeof value !== "string" || !packageVersionPattern.test(value)) {
		throw new Error("Package version/tag must be 1–512 characters, start with an alphanumeric character, and exclude whitespace or control characters.");
	}
	return value;
}

function dependencyFlag(manager: ProjectPackageManager, type: ProjectPackageDependencyType): string[] {
	if (type === "dependencies") {
		return [];
	}
	if (manager === "npm") {
		return type === "devDependencies" ? ["--save-dev"] : type === "optionalDependencies" ? ["--save-optional"] : ["--save-peer"];
	}
	if (manager === "yarn") {
		return type === "devDependencies" ? ["--dev"] : type === "optionalDependencies" ? ["--optional"] : ["--peer"];
	}
	if (manager === "pnpm") {
		return type === "devDependencies" ? ["--save-dev"] : type === "optionalDependencies" ? ["--save-optional"] : ["--save-peer"];
	}
	return type === "devDependencies" ? ["--dev"] : type === "optionalDependencies" ? ["--optional"] : ["--peer"];
}

function exactVersionFlag(manager: ProjectPackageManager, hasVersion: boolean): string[] {
	if (!hasVersion) {
		return [];
	}
	if (manager === "yarn" || manager === "bun") {
		return ["--exact"];
	}
	return ["--save-exact"];
}

function safetyFlags(manager: ProjectPackageManager, allowScripts: boolean): string[] {
	if (manager === "npm") {
		return ["--no-audit", "--no-fund", ...(allowScripts ? [] : ["--ignore-scripts"]), "--color=false"];
	}
	if (manager === "yarn") {
		return ["--non-interactive", ...(allowScripts ? [] : ["--ignore-scripts"]), "--no-progress"];
	}
	if (manager === "pnpm") {
		return ["--reporter=append-only", ...(allowScripts ? [] : ["--ignore-scripts"])];
	}
	return allowScripts ? [] : ["--ignore-scripts"];
}

function redactArgument(value: string): string {
	return value
		.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[redacted]@")
		.replace(/(token|password|_authToken)=([^\s]+)/gi, "$1=[redacted]")
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
}

function quoteDisplayArgument(value: string): string {
	const redacted = redactArgument(value);
	return /^[A-Za-z0-9_./:@=+^~,-]+$/.test(redacted) ? redacted : JSON.stringify(redacted);
}

export function projectPackageCommand(
	manager: ProjectPackageManager,
	operation: ProjectPackageOperation,
	name: string,
	options: IProjectPackageCommandOptions = {}
): IProjectPackageCommand {
	const packageName = validateProjectPackageName(name);
	const version = validateProjectPackageVersion(options.version);
	const specification = version ? `${packageName}@${version}` : packageName;
	const dependencyType = options.dependencyType ?? "dependencies";
	const safe = safetyFlags(manager, options.allowScripts === true);
	let args: string[];
	if (operation === "remove") {
		args = [manager === "npm" ? "uninstall" : "remove", packageName, ...safe];
	} else if (operation === "install") {
		args = [manager === "npm" ? "install" : "add", specification, ...dependencyFlag(manager, dependencyType), ...exactVersionFlag(manager, Boolean(version)), ...safe];
	} else if (manager === "npm") {
		args = version ? ["install", specification, ...exactVersionFlag(manager, true), ...safe] : ["update", packageName, ...safe];
	} else {
		args = [manager === "yarn" ? "upgrade" : "update", specification, ...exactVersionFlag(manager, Boolean(version)), ...safe];
	}
	return { command: manager, args, display: [manager, ...args].map(quoteDisplayArgument).join(" ") };
}

export function projectPackageSourceCommand(
	manager: ProjectPackageManager,
	specification: string,
	dependencyType: ProjectPackageDependencyType,
	allowScripts = false
): IProjectPackageCommand {
	if (!specification || specification.length > 2_048 || [...specification].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
		throw new Error("Package source specification must be 1–2048 characters without control characters.");
	}
	const args = [manager === "npm" ? "install" : "add", specification, ...dependencyFlag(manager, dependencyType), ...safetyFlags(manager, allowScripts)];
	return { command: manager, args, display: [manager, ...args].map(quoteDisplayArgument).join(" ") };
}

function packageEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		CI: "1",
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		GIT_TERMINAL_PROMPT: "0",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_progress: "false",
		npm_config_yes: "true",
		YARN_ENABLE_PROGRESS_BARS: "0",
	};
}

function appendOutput(active: IActiveProjectPackageProcess, destination: "stdout" | "stderr", chunk: Buffer): void {
	const byteKey = destination === "stdout" ? "stdoutBytes" : "stderrBytes";
	const currentBytes = active[byteKey];
	const totalBytes = active.stdoutBytes + active.stderrBytes;
	if (totalBytes >= active.maximumOutputBytes) {
		active.outputTruncated = true;
		return;
	}
	const bounded = chunk.subarray(0, active.maximumOutputBytes - totalBytes);
	active[byteKey] = currentBytes + bounded.byteLength;
	active[destination].push(bounded);
	if (bounded.byteLength < chunk.byteLength) {
		active.outputTruncated = true;
	}
}

function stripAnsiColors(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
			index += 2;
			while (index < value.length && /[0-9;]/.test(value[index])) {
				index++;
			}
			if (value[index] === "m") {
				continue;
			}
		}
		result += value[index];
	}
	return result;
}

function cleanOutput(chunks: Buffer[]): string {
	return stripAnsiColors(redactArgument(Buffer.concat(chunks).toString("utf8"))).replace(/\r/g, "");
}

function terminateProcess(active: IActiveProjectPackageProcess): void {
	if (active.child.exitCode !== null || active.child.signalCode !== null) {
		return;
	}
	if (process.platform !== "win32" && active.child.pid) {
		try {
			process.kill(-active.child.pid, "SIGTERM");
		} catch {
			active.child.kill("SIGTERM");
		}
	} else {
		active.child.kill("SIGTERM");
	}
	if (!active.forceKillTimer) {
		active.forceKillTimer = setTimeout(() => {
			if (process.platform !== "win32" && active.child.pid) {
				try {
					process.kill(-active.child.pid, "SIGKILL");
				} catch {
					active.child.kill("SIGKILL");
				}
			} else {
				active.child.kill("SIGKILL");
			}
		}, 5_000);
		active.forceKillTimer.unref?.();
	}
}

export async function runProjectPackageProcess(
	scene: Scene,
	cwd: string,
	command: IProjectPackageCommand,
	options: IRunProjectPackageProcessOptions
): Promise<IProjectPackageProcessResult> {
	if (activePackageProcesses.has(scene)) {
		const current = activePackageProcesses.get(scene)!;
		throw new Error(`Package operation ${current.id} (${current.kind}) is already running.`);
	}
	const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
	const maximumOutputBytes = options.maximumOutputBytes ?? defaultMaximumOutputBytes;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > maximumTimeoutMs) {
		throw new Error(`Package operation timeoutMs must be an integer from 1000 through ${maximumTimeoutMs}.`);
	}
	if (!Number.isInteger(maximumOutputBytes) || maximumOutputBytes < 16_384 || maximumOutputBytes > 4 * 1024 * 1024) {
		throw new Error("Package operation maximumOutputBytes must be an integer from 16384 through 4194304.");
	}
	const startedAtMs = Date.now();
	const active: IActiveProjectPackageProcess = {
		id: randomUUID(),
		kind: options.kind,
		command,
		child: spawn(command.command, command.args, {
			cwd,
			env: packageEnvironment(),
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		}),
		startedAt: new Date(startedAtMs).toISOString(),
		startedAtMs,
		maximumOutputBytes,
		stdout: [],
		stderr: [],
		stdoutBytes: 0,
		stderrBytes: 0,
		outputTruncated: false,
		canceled: false,
		timedOut: false,
		forceKillTimer: null,
		timeoutTimer: null,
	};
	activePackageProcesses.set(scene, active);
	active.child.stdout.on("data", (chunk: Buffer) => appendOutput(active, "stdout", chunk));
	active.child.stderr.on("data", (chunk: Buffer) => appendOutput(active, "stderr", chunk));
	active.timeoutTimer = setTimeout(() => {
		active.timedOut = true;
		terminateProcess(active);
	}, timeoutMs);
	active.timeoutTimer.unref?.();
	const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; spawnError: Error | null }>((resolveResult) => {
		let spawnError: Error | null = null;
		active.child.once("error", (error) => {
			spawnError = error;
		});
		active.child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal, spawnError }));
	});
	if (active.timeoutTimer) {
		clearTimeout(active.timeoutTimer);
	}
	if (active.forceKillTimer) {
		clearTimeout(active.forceKillTimer);
	}
	activePackageProcesses.delete(scene);
	const stdout = cleanOutput(active.stdout);
	const stderr = cleanOutput(active.stderr);
	const status = active.timedOut ? "timed-out" : active.canceled ? "canceled" : outcome.exitCode === 0 && !outcome.spawnError ? "succeeded" : "failed";
	return {
		id: active.id,
		kind: active.kind,
		command: command.command,
		args: command.args.map(redactArgument),
		display: command.display,
		startedAt: active.startedAt,
		finishedAt: new Date().toISOString(),
		durationMs: Date.now() - active.startedAtMs,
		status,
		exitCode: outcome.exitCode,
		signal: outcome.signal,
		stdout,
		stderr: outcome.spawnError ? `${stderr}${stderr ? "\n" : ""}${outcome.spawnError.message}` : stderr,
		outputTruncated: active.outputTruncated,
	};
}

export function getActiveProjectPackageProcess(scene: Scene): any {
	const active = activePackageProcesses.get(scene);
	return active
		? {
				id: active.id,
				kind: active.kind,
				display: active.command.display,
				startedAt: active.startedAt,
				durationMs: Date.now() - active.startedAtMs,
				outputBytes: active.stdoutBytes + active.stderrBytes,
				outputTruncated: active.outputTruncated,
			}
		: null;
}

export async function cancelProjectPackageProcess(scene: Scene, data: any): Promise<any> {
	const active = activePackageProcesses.get(scene);
	if (!active) {
		return { canceled: false, active: null, reason: "No package operation is running." };
	}
	if (data?.operationId !== undefined && data.operationId !== active.id) {
		throw new Error(`Package operation ${data.operationId} is not active; the active operation is ${active.id}.`);
	}
	active.canceled = true;
	terminateProcess(active);
	return { canceled: true, operationId: active.id, kind: active.kind };
}
