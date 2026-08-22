import { ChildProcessByStdio } from "child_process";
import { Readable } from "stream";

export type ProjectPackageManager = "npm" | "yarn" | "pnpm" | "bun";
export type ProjectPackageDependencyType = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
export type ProjectPackageOperation = "install" | "remove" | "update";

export interface IProjectPackageManifest {
	name?: string;
	version?: string;
	private?: boolean;
	scripts?: Record<string, string>;
	workspaces?: string[] | { packages?: string[] };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	[key: string]: unknown;
}

export interface IProjectPackageFileEvidence {
	path: string;
	exists: boolean;
	bytes: number;
	sha256: string | null;
	format: "package-lock" | "npm-shrinkwrap" | "yarn" | "pnpm" | "bun-text" | "bun-binary";
	authoritative: boolean;
	outsideProject: boolean;
}

export interface IProjectPackageContext {
	projectRoot: string;
	manifestPath: string;
	manifest: IProjectPackageManifest;
	manifestBytes: Buffer;
	manifestSha256: string;
	packageManager: ProjectPackageManager;
	workspaceRoot: string | null;
	workspaceRelativePath: string | null;
	lockfiles: IProjectPackageFileEvidence[];
	fingerprint: string;
}

export interface IProjectPackageCommand {
	command: string;
	args: string[];
	display: string;
}

export interface IProjectPackageProcessResult {
	id: string;
	kind: string;
	command: string;
	args: string[];
	display: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	status: "succeeded" | "failed" | "canceled" | "timed-out";
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	outputTruncated: boolean;
}

export interface IActiveProjectPackageProcess {
	id: string;
	kind: string;
	command: IProjectPackageCommand;
	child: ChildProcessByStdio<null, Readable, Readable>;
	startedAt: string;
	startedAtMs: number;
	maximumOutputBytes: number;
	stdout: Buffer[];
	stderr: Buffer[];
	stdoutBytes: number;
	stderrBytes: number;
	outputTruncated: boolean;
	canceled: boolean;
	timedOut: boolean;
	forceKillTimer: ReturnType<typeof setTimeout> | null;
	timeoutTimer: ReturnType<typeof setTimeout> | null;
}

export interface IProjectPackageCommandOptions {
	dependencyType?: ProjectPackageDependencyType;
	version?: string;
	allowScripts?: boolean;
}

export interface IRunProjectPackageProcessOptions {
	kind: string;
	timeoutMs?: number;
	maximumOutputBytes?: number;
}
