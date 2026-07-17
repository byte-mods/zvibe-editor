import { execFile } from "child_process";
import { createHash, randomBytes } from "crypto";
import { constants as fsConstants } from "fs";
import { access, lstat, readFile, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "path";
import { normalize } from "path/posix";

import sharp from "sharp";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { getProjectCollaborationStatus, resolveProjectCollaborationActor } from "./collaboration";

const maximumGitOutputBytes = 1024 * 1024;
const maximumStatusChanges = 2000;
const maximumConflictPreviewBytes = 256 * 1024;
const maximumConflictResolutionBytes = 1024 * 1024;
const maximumConflictRollbackBytes = 2 * 1024 * 1024;
const maximumConflictImageBytes = 8 * 1024 * 1024;
const maximumConflictImagePixels = 4 * 1024 * 1024;
const conflictImagePreviewSize = 128;

interface IGitContext {
	projectRoot: string;
	gitRoot: string;
	projectPrefix: string;
}

interface IGitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface IGitBytesResult {
	exitCode: number;
	stdout: Buffer;
	stderr: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_EDITOR: "true",
		GIT_SEQUENCE_EDITOR: "true",
		GIT_MERGE_AUTOEDIT: "no",
	};
}

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
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

function redactGitOutput(value: string, preserveNulls = false): string {
	const redacted = stripAnsiColors(value)
		.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[redacted]@")
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/\r/g, "")
		.slice(0, maximumGitOutputBytes);
	return preserveNulls ? redacted : redacted.replace(/\0/g, "");
}

function hasControlCharacters(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function runGit(cwd: string, args: string[], timeout = 15_000, preserveNulls = false): Promise<IGitResult> {
	return new Promise((resolveResult) => {
		execFile(
			"git",
			args,
			{
				cwd,
				timeout,
				maxBuffer: maximumGitOutputBytes,
				env: gitEnvironment(),
				encoding: "utf-8",
			},
			(error, stdout, stderr) => {
				const code = typeof (error as any)?.code === "number" ? (error as any).code : error ? 1 : 0;
				resolveResult({ exitCode: code, stdout: redactGitOutput(String(stdout ?? ""), preserveNulls), stderr: redactGitOutput(String(stderr ?? ""), preserveNulls) });
			}
		);
	});
}

function runGitBytes(cwd: string, args: string[], maximumBytes: number): Promise<IGitBytesResult> {
	return new Promise((resolveResult) => {
		execFile("git", args, { cwd, timeout: 30_000, maxBuffer: maximumBytes, env: gitEnvironment(), encoding: null }, (error, stdout, stderr) => {
			const code = typeof (error as any)?.code === "number" ? (error as any).code : error ? 1 : 0;
			resolveResult({
				exitCode: code,
				stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
				stderr: redactGitOutput(Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr ?? "")),
			});
		});
	});
}

async function requireGitSuccess(cwd: string, args: string[], message: string, timeout?: number, preserveNulls = false): Promise<IGitResult> {
	const result = await runGit(cwd, args, timeout, preserveNulls);
	if (result.exitCode !== 0) {
		const details = (result.stderr || result.stdout).trim().slice(0, 512);
		throw new Error(details ? `${message}: ${details}` : message);
	}
	return result;
}

async function gitContext(options: IMCPActionOptions): Promise<IGitContext> {
	const projectRoot = await realpath(projectDirectory(options));
	const topLevel = await requireGitSuccess(projectRoot, ["rev-parse", "--show-toplevel"], "The active project is not a readable Git worktree.");
	const gitRoot = await realpath(topLevel.stdout.trim());
	const prefix = relative(gitRoot, projectRoot).replace(/\\/g, "/");
	if (prefix === ".." || prefix.startsWith("../") || isAbsolute(prefix)) {
		throw new Error("The active project must resolve inside its Git worktree.");
	}
	return { projectRoot, gitRoot, projectPrefix: prefix === "." ? "" : prefix };
}

function validatePath(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 512 || hasControlCharacters(value)) {
		throw new Error("Each Git path must be a non-empty project-relative path of at most 512 characters without control characters.");
	}
	const portableValue = value.trim().replace(/\\/g, "/");
	if (portableValue.split("/").includes("..")) {
		throw new Error("Git paths must stay inside the active project, exclude .git metadata, and not use option or pathspec-magic prefixes.");
	}
	const path = normalize(portableValue.replace(/^\.\//, ""));
	if (path === "." || path.startsWith("/") || path.startsWith(":") || path.startsWith("-") || path.split("/").includes("..") || path === ".git" || path.startsWith(".git/")) {
		throw new Error("Git paths must stay inside the active project, exclude .git metadata, and not use option or pathspec-magic prefixes.");
	}
	return path;
}

function validatePaths(data: any): { all: boolean; paths: string[] } {
	const all = data.all === true;
	if (all && data.paths !== undefined) {
		throw new Error("Use either all=true or paths, not both.");
	}
	if (!all && (!Array.isArray(data.paths) || data.paths.length < 1 || data.paths.length > 128)) {
		throw new Error("paths must contain 1–128 project-relative paths unless all=true.");
	}
	const paths: string[] = all ? ["."] : [...new Set<string>((data.paths as unknown[]).map(validatePath))];
	return { all, paths };
}

async function requireSourceControlRole(scene: Scene, data: any, options: IMCPActionOptions, adminOnly: boolean): Promise<void> {
	const status = await getProjectCollaborationStatus(scene, { collaborationToken: data.collaborationToken }, options);
	if (!status.enforcementEnabled) {
		return;
	}
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role === "viewer" || (adminOnly && actor.role !== "admin")) {
		throw new Error(adminOnly ? "Git repository administration requires the collaboration admin role." : "Git staging requires the collaboration editor or admin role.");
	}
}

function requireConfirmation(data: any, action: string): void {
	if (data.confirm !== true) {
		throw new Error(`confirm must be true to ${action}.`);
	}
}

async function statusForContext(context: IGitContext): Promise<any> {
	const result = await requireGitSuccess(
		context.projectRoot,
		["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--", "."],
		"Unable to read the active project's Git status.",
		undefined,
		true
	);
	const entries = result.stdout.split("\0").filter(Boolean);
	const branchEntry = entries[0]?.startsWith("## ") ? entries.shift() : undefined;
	const branch = branchEntry?.slice(3) ?? "detached";
	const allChanges: { index: string; worktree: string; path: string; originalPath?: string }[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const indexState = entry.slice(0, 1);
		const worktreeState = entry.slice(1, 2);
		const renamedOrCopied = [indexState, worktreeState].some((state) => state === "R" || state === "C");
		allChanges.push({ index: indexState, worktree: worktreeState, path: entry.slice(3), ...(renamedOrCopied ? { originalPath: entries[++index] } : {}) });
	}
	const changes = allChanges.slice(0, maximumStatusChanges);
	return {
		branch,
		clean: allChanges.length === 0,
		changes,
		changeCount: allChanges.length,
		stagedCount: allChanges.filter((change) => ![" ", "?"].includes(change.index)).length,
		unstagedCount: allChanges.filter((change) => ![" "].includes(change.worktree)).length,
		truncated: allChanges.length > maximumStatusChanges,
		projectPrefix: context.projectPrefix,
	};
}

/** Returns concise read-only Git branch and project-scoped porcelain status for the open project. */
export async function getProjectSourceControlStatus(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	return statusForContext(await gitContext(options));
}

/** Returns a bounded read-only Git commit history for the active project. */
export async function getProjectSourceControlHistory(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const limit = data.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
		throw new Error("limit must be an integer from 1 to 50.");
	}
	const context = await gitContext(options);
	const result = await requireGitSuccess(
		context.projectRoot,
		["log", "-n", String(limit), "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s", "--", "."],
		"Unable to read the active project's Git history."
	);
	const commits = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, shortHash, author, date, subject] = line.split("\u001f");
			return { hash, shortHash, author, date, subject };
		});
	return { commits };
}

/** Returns a bounded read-only unified diff for one project-relative changed file. */
export async function getProjectSourceControlDiff(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const path = validatePath(data.path);
	const context = await gitContext(options);
	const result = await requireGitSuccess(
		context.projectRoot,
		["diff", "--no-ext-diff", "--unified=3", ...(data.staged ? ["--cached"] : []), "--", path],
		"Unable to read the active project's Git diff."
	);
	const maximumCharacters = 50_000;
	return { path, staged: data.staged === true, diff: result.stdout.slice(0, maximumCharacters), truncated: result.stdout.length > maximumCharacters };
}

/** Stages selected project paths, or every project path when all=true. */
export async function stageProjectSourceControlPaths(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, false);
	const selection = validatePaths(data);
	const context = await gitContext(options);
	await requireGitSuccess(context.projectRoot, ["add", "-A", "--", ...selection.paths], "Unable to stage the selected project paths.", 30_000);
	return { staged: true, all: selection.all, paths: selection.all ? [] : selection.paths, status: await statusForContext(context) };
}

/** Unstages selected project paths without changing working-tree files. */
export async function unstageProjectSourceControlPaths(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, false);
	const selection = validatePaths(data);
	const context = await gitContext(options);
	const hasHead = (await runGit(context.projectRoot, ["rev-parse", "--verify", "HEAD"])).exitCode === 0;
	const args = hasHead ? ["restore", "--staged", "--", ...selection.paths] : ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...selection.paths];
	await requireGitSuccess(context.projectRoot, args, "Unable to unstage the selected project paths.", 30_000);
	return { unstaged: true, all: selection.all, paths: selection.all ? [] : selection.paths, status: await statusForContext(context) };
}

function stagedPathBelongsToProject(path: string, context: IGitContext): boolean {
	return !context.projectPrefix || path === context.projectPrefix || path.startsWith(`${context.projectPrefix}/`);
}

/** Creates one commit from the current index after verifying it contains only active-project paths. */
export async function commitProjectSourceControl(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	if (data.confirm !== true) {
		throw new Error("confirm must be true to create a Git commit.");
	}
	if (typeof data.message !== "string" || !data.message.trim() || data.message.length > 5000 || /\0/.test(data.message)) {
		throw new Error("message must be 1–5000 characters without null bytes.");
	}
	const context = await gitContext(options);
	const staged = await requireGitSuccess(context.gitRoot, ["diff", "--cached", "--name-only", "-z"], "Unable to inspect staged Git paths.", undefined, true);
	const stagedPaths = staged.stdout.split("\0").filter(Boolean);
	if (!stagedPaths.length) {
		throw new Error("There are no staged changes to commit.");
	}
	const outsidePaths = stagedPaths.filter((path) => !stagedPathBelongsToProject(path, context));
	if (outsidePaths.length) {
		throw new Error(`Commit rejected because ${outsidePaths.length} staged path(s) are outside the active project. Unstage them before committing.`);
	}
	const args = ["commit", "-m", data.message, ...(data.signoff === true ? ["--signoff"] : [])];
	const committed = await requireGitSuccess(context.gitRoot, args, "Unable to create the Git commit.", 60_000);
	const summary = await requireGitSuccess(context.gitRoot, ["show", "-s", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s", "HEAD"], "Commit created but its summary could not be read.");
	const [hash, shortHash, author, date, subject] = summary.stdout.trim().split("\u001f");
	return {
		committed: true,
		commit: { hash, shortHash, author, date, subject },
		stagedPathCount: stagedPaths.length,
		output: committed.stdout.trim(),
		status: await statusForContext(context),
	};
}

function validateRemoteName(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new Error("remote must be a configured Git remote name of at most 128 safe characters.");
	}
	return value;
}

function requireProjectOwnsWorktree(context: IGitContext, action: string): void {
	if (context.projectPrefix) {
		throw new Error(`${action} is repository-wide and requires the active project directory to be the Git worktree root.`);
	}
}

async function requireCleanWorktree(context: IGitContext, action: string): Promise<void> {
	const status = await requireGitSuccess(
		context.gitRoot,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		`Unable to verify the worktree before ${action}.`,
		undefined,
		true
	);
	if (status.stdout.length > 0) {
		throw new Error(`${action} requires a completely clean Git worktree and index. Commit, stash, or remove all changes first.`);
	}
}

async function validateBranch(context: IGitContext, value: unknown): Promise<string> {
	let branch = value;
	if (branch === undefined) {
		const current = await requireGitSuccess(context.gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], "A named current branch is required for push.");
		branch = current.stdout.trim();
	}
	if (typeof branch !== "string" || !branch || branch.length > 255 || /[\r\n\0]/.test(branch)) {
		throw new Error("branch must be a valid Git branch name of at most 255 characters.");
	}
	await requireGitSuccess(context.gitRoot, ["check-ref-format", "--branch", branch], "branch is not a valid Git branch name.");
	return branch;
}

function rejectCredentialBearingRemote(urlValue: string): void {
	if (!/^https?:\/\//i.test(urlValue)) {
		return;
	}
	const url = new URL(urlValue);
	if (url.username || url.password) {
		throw new Error("Remote operation rejected because the configured URL contains embedded credentials. Use a credential helper or SSH agent instead.");
	}
}

async function validateRemoteForNetwork(context: IGitContext, value: unknown, push = false): Promise<{ remote: string; url: string }> {
	const remote = validateRemoteName(value ?? "origin");
	const urlResult = await requireGitSuccess(context.gitRoot, ["remote", "get-url", ...(push ? ["--push"] : []), remote], `Git remote ${remote} is not configured.`);
	const url = urlResult.stdout.trim();
	rejectCredentialBearingRemote(url);
	return { remote, url };
}

type GitRemoteTransport = "https" | "http" | "ssh" | "git" | "file" | "local" | "unknown";

function classifyRemoteUrl(value: string): { transport: GitRemoteTransport; embeddedCredentials: boolean } {
	if (/^https?:\/\//i.test(value)) {
		try {
			const parsed = new URL(value);
			return { transport: parsed.protocol.toLowerCase() === "https:" ? "https" : "http", embeddedCredentials: Boolean(parsed.username || parsed.password) };
		} catch {
			return { transport: "unknown", embeddedCredentials: false };
		}
	}
	if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(value)) {
		return { transport: "local", embeddedCredentials: false };
	}
	if (/^ssh:\/\//i.test(value) || /^[^\s/:]+(?:@[^\s/:]+)?:(?![\\/]).+/.test(value)) {
		return { transport: "ssh", embeddedCredentials: false };
	}
	if (/^git:\/\//i.test(value)) {
		return { transport: "git", embeddedCredentials: false };
	}
	if (/^file:\/\//i.test(value)) {
		return { transport: "file", embeddedCredentials: false };
	}
	if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
		return { transport: "local", embeddedCredentials: false };
	}
	return { transport: "unknown", embeddedCredentials: false };
}

async function executableExists(program: string, gitExecPath: string): Promise<boolean> {
	const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	const directories = [gitExecPath, ...(process.env.PATH ?? "").split(delimiter)].filter(Boolean).slice(0, 128);
	for (const directory of directories) {
		for (const suffix of suffixes) {
			try {
				await access(join(directory, `${program}${suffix}`), fsConstants.X_OK);
				return true;
			} catch {
				// Continue searching without exposing host paths.
			}
		}
	}
	return false;
}

async function summarizeCredentialHelper(value: string, gitExecPath: string): Promise<any | null> {
	const helper = value.trim();
	if (!helper) {
		return null;
	}
	if (helper.startsWith("!")) {
		return { kind: "custom-command", secureStorage: "unknown", persistence: "unknown", executableAvailable: null };
	}
	const firstToken = helper.split(/\s+/, 1)[0];
	if (isAbsolute(firstToken) || !/^[A-Za-z0-9._-]{1,80}$/.test(firstToken)) {
		return { kind: "custom-executable", secureStorage: "unknown", persistence: "unknown", executableAvailable: null };
	}
	const normalized = firstToken.toLowerCase();
	const known: Record<string, { kind: string; secureStorage: boolean | "unknown"; persistence: string }> = {
		cache: { kind: "cache", secureStorage: false, persistence: "memory" },
		store: { kind: "store", secureStorage: false, persistence: "plaintext-disk" },
		manager: { kind: "manager", secureStorage: true, persistence: "os-vault" },
		"manager-core": { kind: "manager-core", secureStorage: true, persistence: "os-vault" },
		osxkeychain: { kind: "osxkeychain", secureStorage: true, persistence: "os-vault" },
		libsecret: { kind: "libsecret", secureStorage: true, persistence: "os-vault" },
		wincred: { kind: "wincred", secureStorage: true, persistence: "os-vault" },
		"gnome-keyring": { kind: "gnome-keyring", secureStorage: true, persistence: "os-vault" },
		oauth: { kind: "oauth", secureStorage: "unknown", persistence: "helper-managed" },
	};
	const classification = known[normalized] ?? { kind: "custom-name", secureStorage: "unknown" as const, persistence: "unknown" };
	return { ...classification, executableAvailable: await executableExists(`git-credential-${normalized}`, gitExecPath) };
}

async function effectiveCredentialSettings(context: IGitContext, url: string, gitExecPath: string): Promise<any> {
	const [genericHelpersResult, matchedHelperResult, useHttpPathResult, usernameResult, interactiveResult] = await Promise.all([
		runGit(context.gitRoot, ["config", "--null", "--get-all", "credential.helper"], 15_000, true),
		runGit(context.gitRoot, ["config", "--null", "--get-urlmatch", "credential.helper", url], 15_000, true),
		runGit(context.gitRoot, ["config", "--get-urlmatch", "credential.useHttpPath", url]),
		runGit(context.gitRoot, ["config", "--get-urlmatch", "credential.username", url]),
		runGit(context.gitRoot, ["config", "--get-urlmatch", "credential.interactive", url]),
	]);
	const helperValues: string[] = [];
	if (genericHelpersResult.exitCode === 0) {
		const configuredHelpers = genericHelpersResult.stdout.split("\0");
		if (configuredHelpers.at(-1) === "") {
			configuredHelpers.pop();
		}
		for (const helper of configuredHelpers) {
			if (!helper.trim()) {
				helperValues.length = 0;
			} else {
				helperValues.push(helper);
			}
		}
	}
	if (matchedHelperResult.exitCode === 0) {
		const matchedHelper = matchedHelperResult.stdout.split("\0")[0] ?? "";
		if (!matchedHelper.trim()) {
			helperValues.length = 0;
		} else if (helperValues.at(-1) !== matchedHelper) {
			helperValues.push(matchedHelper);
		}
	}
	const boundedHelperValues = helperValues.slice(0, 16);
	const helpers = (await Promise.all(boundedHelperValues.map((helper) => summarizeCredentialHelper(helper, gitExecPath)))).filter(Boolean);
	const interactiveValue = interactiveResult.exitCode === 0 ? interactiveResult.stdout.trim().toLowerCase() : "";
	const interactive = ["false", "never", "0", "no"].includes(interactiveValue)
		? "disabled"
		: ["true", "always", "1", "yes"].includes(interactiveValue)
			? "enabled"
			: interactiveValue
				? "custom"
				: "default";
	return {
		helpers,
		helperCount: helpers.length,
		truncated: helperValues.length > 16,
		useHttpPath: useHttpPathResult.exitCode === 0 ? ["true", "yes", "on", "1"].includes(useHttpPathResult.stdout.trim().toLowerCase()) : false,
		usernameConfigured: usernameResult.exitCode === 0 && Boolean(usernameResult.stdout.trim()),
		interactive,
	};
}

async function sshAgentStatus(): Promise<{ configured: boolean; socketAvailable: boolean }> {
	const socket = process.env.SSH_AUTH_SOCK;
	if (!socket) {
		return { configured: false, socketAvailable: false };
	}
	try {
		return { configured: true, socketAvailable: (await lstat(socket)).isSocket() };
	} catch {
		return { configured: true, socketAvailable: false };
	}
}

/** Diagnoses configured Git remote authentication without contacting the remote or invoking any credential provider. */
export async function inspectProjectSourceControlAuthentication(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const context = await gitContext(options);
	const remote = validateRemoteName(data.remote ?? "origin");
	const fetchResult = await requireGitSuccess(context.gitRoot, ["remote", "get-url", "--all", remote], `Git remote ${remote} is not configured.`);
	const [pushResult, execPathResult, sshAgent] = await Promise.all([
		requireGitSuccess(context.gitRoot, ["remote", "get-url", "--push", "--all", remote], `Git remote ${remote} has no push URL.`),
		requireGitSuccess(context.gitRoot, ["--exec-path"], "Unable to inspect the Git helper execution path."),
		sshAgentStatus(),
	]);
	const gitExecPath = execPathResult.stdout.trim();
	const issues: { code: string; severity: "error" | "warning"; message: string }[] = [];
	const inspectDirection = async (direction: "fetch" | "push", output: string): Promise<any> => {
		const urls = output
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean)
			.slice(0, 16);
		const classifications = urls.map(classifyRemoteUrl);
		const transports = [...new Set(classifications.map((entry) => entry.transport))];
		const embeddedCredentials = classifications.some((entry) => entry.embeddedCredentials);
		if (embeddedCredentials) {
			issues.push({
				code: `${direction}EmbeddedCredentials`,
				severity: "error",
				message: `${direction} URL contains embedded HTTP credentials; remove them and use a helper or SSH agent.`,
			});
		}
		if (transports.includes("http") || transports.includes("git")) {
			issues.push({ code: `${direction}InsecureTransport`, severity: "error", message: `${direction} uses an unencrypted Git transport; use HTTPS or SSH.` });
		}
		if (transports.includes("unknown")) {
			issues.push({ code: `${direction}UnknownTransport`, severity: "warning", message: `${direction} contains a transport the editor cannot classify.` });
		}
		const httpsSettings: any[] = [];
		for (const [index, url] of urls.entries()) {
			if (classifications[index].transport === "https" || classifications[index].transport === "http") {
				httpsSettings.push(await effectiveCredentialSettings(context, url, gitExecPath));
			}
		}
		for (const settings of httpsSettings) {
			for (const helper of settings.helpers) {
				if (helper.kind === "store") {
					issues.push({
						code: `${direction}PlaintextCredentialStore`,
						severity: "error",
						message: `${direction} uses credential.helper=store, which persists secrets as plaintext; use an OS-vault helper.`,
					});
				} else if (helper.kind === "cache") {
					issues.push({
						code: `${direction}EphemeralCredentialCache`,
						severity: "warning",
						message: `${direction} uses only an in-memory credential cache and may require periodic re-authentication.`,
					});
				} else if (helper.kind.startsWith("custom")) {
					issues.push({
						code: `${direction}CustomCredentialHelper`,
						severity: "warning",
						message: `${direction} uses a custom credential helper whose command and security cannot be inspected safely.`,
					});
				}
				if (helper.executableAvailable === false) {
					issues.push({
						code: `${direction}CredentialHelperUnavailable`,
						severity: "error",
						message: `${direction} names a credential helper executable that is not available to the editor process.`,
					});
				}
			}
			if (!settings.helpers.length && !process.env.GIT_ASKPASS) {
				issues.push({
					code: `${direction}NoHttpsCredentialProvider`,
					severity: "warning",
					message: `${direction} has no effective credential helper or Git AskPass provider; private HTTPS remotes may fail non-interactively.`,
				});
			}
		}
		if (transports.includes("ssh") && !sshAgent.socketAvailable && !process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) {
			issues.push({
				code: `${direction}SshReadinessUnknown`,
				severity: "warning",
				message: `${direction} uses SSH without a usable agent socket or explicit Git SSH override; default key files may still work.`,
			});
		}
		return { urlCount: urls.length, truncated: output.split("\n").filter(Boolean).length > 16, transports, embeddedCredentials, https: httpsSettings };
	};
	const [fetch, push] = await Promise.all([inspectDirection("fetch", fetchResult.stdout), inspectDirection("push", pushResult.stdout)]);
	const uniqueIssues = [...new Map(issues.map((issue) => [issue.code, issue])).values()];
	return {
		remote,
		status: uniqueIssues.some((issue) => issue.severity === "error") ? "attention" : uniqueIssues.length ? "review" : "ready",
		contactsRemote: false,
		invokesCredentialProvider: false,
		terminalPromptEnabled: false,
		environment: {
			gitAskPassConfigured: Boolean(process.env.GIT_ASKPASS),
			sshAskPassConfigured: Boolean(process.env.SSH_ASKPASS),
			gitSshConfigured: Boolean(process.env.GIT_SSH),
			gitSshCommandConfigured: Boolean(process.env.GIT_SSH_COMMAND),
			sshAgent,
		},
		fetch,
		push,
		issues: uniqueIssues,
	};
}

/** Pushes the current commit to a named remote without force after explicit confirmation. */
export async function pushProjectSourceControl(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "push Git commits to a remote");
	const context = await gitContext(options);
	const branch = await validateBranch(context, data.branch);
	let remoteValue = data.remote;
	if (remoteValue === undefined) {
		const configured = await runGit(context.gitRoot, ["config", "--get", `branch.${branch}.remote`]);
		remoteValue = configured.exitCode === 0 && configured.stdout.trim() && configured.stdout.trim() !== "." ? configured.stdout.trim() : "origin";
	}
	const remote = validateRemoteName(remoteValue);
	const url = await requireGitSuccess(context.gitRoot, ["remote", "get-url", "--push", remote], `Git remote ${remote} is not configured.`);
	rejectCredentialBearingRemote(url.stdout.trim());
	const args = ["push", "--porcelain", ...(data.setUpstream === true ? ["--set-upstream"] : []), remote, `HEAD:refs/heads/${branch}`];
	const pushed = await requireGitSuccess(context.gitRoot, args, "Unable to push the Git branch. No force push was attempted.", 120_000);
	return { pushed: true, remote, branch, setUpstream: data.setUpstream === true, output: `${pushed.stdout}${pushed.stderr}`.trim().slice(0, 50_000) };
}

interface IProjectSourceControlRef {
	name: string;
	hash: string;
	objectType: string;
	subject: string;
}

async function readRefs(context: IGitContext, namespace: "heads" | "remotes" | "tags"): Promise<{ refs: IProjectSourceControlRef[]; truncated: boolean }> {
	const result = await requireGitSuccess(
		context.gitRoot,
		["for-each-ref", "--count=501", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(subject)%00", `refs/${namespace}`],
		`Unable to list Git ${namespace}.`,
		undefined,
		true
	);
	const fields = result.stdout.split("\0");
	const parsedRefs: IProjectSourceControlRef[] = [];
	for (let index = 0; index + 3 < fields.length; index += 4) {
		const refName = fields[index].replace(/^\n+/, "");
		if (!refName) {
			continue;
		}
		parsedRefs.push({
			name: refName.slice(`refs/${namespace}/`.length),
			hash: fields[index + 1],
			objectType: fields[index + 2],
			subject: fields[index + 3].trim().slice(0, 500),
		});
	}
	return { refs: parsedRefs.slice(0, 500), truncated: parsedRefs.length > 500 };
}

/** Lists bounded local branches, remote-tracking branches, tags, and current upstream divergence. */
export async function listProjectSourceControlRefs(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	const context = await gitContext(options);
	const [localResult, remoteResult, tagResult] = await Promise.all([readRefs(context, "heads"), readRefs(context, "remotes"), readRefs(context, "tags")]);
	const currentResult = await runGit(context.gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const currentBranch = currentResult.exitCode === 0 ? currentResult.stdout.trim() : null;
	const upstreamResult = await runGit(context.gitRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : null;
	let ahead = 0;
	let behind = 0;
	if (upstream) {
		const divergence = await requireGitSuccess(context.gitRoot, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], "Unable to calculate upstream divergence.");
		[ahead, behind] = divergence.stdout.trim().split(/\s+/).map(Number);
	}
	return {
		currentBranch,
		detached: !currentBranch,
		upstream,
		ahead,
		behind,
		localBranches: localResult.refs.map((ref) => ({ ...ref, current: ref.name === currentBranch })),
		remoteBranches: remoteResult.refs,
		tags: tagResult.refs,
		truncated: { localBranches: localResult.truncated, remoteBranches: remoteResult.truncated, tags: tagResult.truncated },
	};
}

/** Fetches one validated remote after explicit confirmation. */
export async function fetchProjectSourceControl(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "fetch Git remote refs");
	const context = await gitContext(options);
	const { remote } = await validateRemoteForNetwork(context, data.remote);
	const args = ["fetch", "--verbose", ...(data.prune === true ? ["--prune"] : []), ...(data.tags === true ? ["--tags"] : []), remote];
	const fetched = await requireGitSuccess(context.gitRoot, args, `Unable to fetch Git remote ${remote}.`, 120_000);
	return {
		fetched: true,
		remote,
		prune: data.prune === true,
		tags: data.tags === true,
		output: `${fetched.stdout}${fetched.stderr}`.trim().slice(0, 50_000),
		refs: await listProjectSourceControlRefs(scene, {}, options),
	};
}

/** Fast-forward-only pulls one branch into a clean root-owned project worktree. */
export async function pullProjectSourceControl(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "pull Git changes");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git pull");
	await requireCleanWorktree(context, "Git pull");
	const currentBranch = await validateBranch(context, undefined);
	const branch = data.branch === undefined ? currentBranch : await validateBranch(context, data.branch);
	if (branch !== currentBranch) {
		throw new Error(`Git pull can update only the current branch (${currentBranch}); switch branches explicitly before pulling ${branch}.`);
	}
	let remoteValue = data.remote;
	if (remoteValue === undefined) {
		const configured = await runGit(context.gitRoot, ["config", "--get", `branch.${branch}.remote`]);
		remoteValue = configured.exitCode === 0 && configured.stdout.trim() && configured.stdout.trim() !== "." ? configured.stdout.trim() : "origin";
	}
	const { remote } = await validateRemoteForNetwork(context, remoteValue);
	const pulled = await requireGitSuccess(context.gitRoot, ["pull", "--ff-only", remote, branch], `Unable to fast-forward ${branch} from ${remote}.`, 120_000);
	return {
		pulled: true,
		remote,
		branch,
		output: `${pulled.stdout}${pulled.stderr}`.trim().slice(0, 50_000),
		status: await statusForContext(context),
		refs: await listProjectSourceControlRefs(scene, {}, options),
	};
}

function validateTag(context: IGitContext, value: unknown): Promise<string> {
	if (typeof value !== "string" || !value || value.length > 255 || hasControlCharacters(value) || value.startsWith("-")) {
		throw new Error("tag must be a valid Git tag name of at most 255 characters.");
	}
	return requireGitSuccess(context.gitRoot, ["check-ref-format", `refs/tags/${value}`], "tag is not a valid Git tag name.").then(() => value);
}

async function validateStartPoint(context: IGitContext, value: unknown): Promise<string> {
	const startPoint = value ?? "HEAD";
	if (typeof startPoint !== "string" || !startPoint || startPoint.length > 255 || hasControlCharacters(startPoint) || startPoint.startsWith("-") || startPoint.startsWith(":")) {
		throw new Error("startPoint must name a valid commit using at most 255 safe characters.");
	}
	await requireGitSuccess(context.gitRoot, ["rev-parse", "--verify", `${startPoint}^{commit}`], "startPoint does not resolve to a Git commit.");
	return startPoint;
}

/** Creates a local branch without changing the worktree. */
export async function createProjectSourceControlBranch(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "create a Git branch");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git branch creation");
	const name = await validateBranch(context, data.name);
	const startPoint = await validateStartPoint(context, data.startPoint);
	await requireGitSuccess(context.gitRoot, ["branch", "--no-track", name, startPoint], `Unable to create Git branch ${name}.`);
	return { created: true, branch: name, startPoint, refs: await listProjectSourceControlRefs(scene, {}, options) };
}

/** Switches to an existing local branch only when the complete worktree is clean. */
export async function switchProjectSourceControlBranch(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "switch Git branches");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git branch switching");
	await requireCleanWorktree(context, "Git branch switching");
	const name = await validateBranch(context, data.name);
	await requireGitSuccess(context.gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], `Local Git branch ${name} does not exist.`);
	const switched = await requireGitSuccess(context.gitRoot, ["switch", name], `Unable to switch to Git branch ${name}.`, 60_000);
	return {
		switched: true,
		branch: name,
		output: `${switched.stdout}${switched.stderr}`.trim().slice(0, 50_000),
		status: await statusForContext(context),
		refs: await listProjectSourceControlRefs(scene, {}, options),
	};
}

/** Safely deletes a fully merged non-current local branch without force. */
export async function deleteProjectSourceControlBranch(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "delete a Git branch");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git branch deletion");
	const name = await validateBranch(context, data.name);
	const deleted = await requireGitSuccess(
		context.gitRoot,
		["branch", "--delete", "--", name],
		`Unable to safely delete Git branch ${name}. The branch may be current or not fully merged.`
	);
	return { deleted: true, branch: name, output: `${deleted.stdout}${deleted.stderr}`.trim().slice(0, 50_000), refs: await listProjectSourceControlRefs(scene, {}, options) };
}

/** Creates a lightweight or annotated local tag at a verified commit. */
export async function createProjectSourceControlTag(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "create a Git tag");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git tag creation");
	const name = await validateTag(context, data.name);
	const startPoint = await validateStartPoint(context, data.startPoint);
	if (data.message !== undefined && (typeof data.message !== "string" || !data.message.trim() || data.message.length > 5000 || /\0/.test(data.message))) {
		throw new Error("message must be 1–5000 characters without null bytes when creating an annotated tag.");
	}
	const annotated = data.message !== undefined;
	await requireGitSuccess(context.gitRoot, ["tag", ...(annotated ? ["--annotate", name, "--message", data.message] : [name]), startPoint], `Unable to create Git tag ${name}.`);
	return { created: true, tag: name, startPoint, annotated, refs: await listProjectSourceControlRefs(scene, {}, options) };
}

/** Deletes one local tag without changing any remote tag. */
export async function deleteProjectSourceControlTag(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "delete a local Git tag");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git tag deletion");
	const name = await validateTag(context, data.name);
	const deleted = await requireGitSuccess(context.gitRoot, ["tag", "--delete", name], `Unable to delete local Git tag ${name}.`);
	return { deleted: true, tag: name, output: `${deleted.stdout}${deleted.stderr}`.trim().slice(0, 50_000), refs: await listProjectSourceControlRefs(scene, {}, options) };
}

type ProjectSourceControlOperation = "merge" | "rebase" | "cherry-pick" | "revert" | null;

async function gitInternalPath(context: IGitContext, name: string): Promise<string> {
	const result = await requireGitSuccess(context.gitRoot, ["rev-parse", "--git-path", name], `Unable to locate Git operation state ${name}.`);
	const value = result.stdout.trim();
	return isAbsolute(value) ? value : join(context.gitRoot, value);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function projectSourceControlOperation(context: IGitContext): Promise<ProjectSourceControlOperation> {
	if ((await pathExists(await gitInternalPath(context, "rebase-merge"))) || (await pathExists(await gitInternalPath(context, "rebase-apply")))) {
		return "rebase";
	}
	if ((await runGit(context.gitRoot, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).exitCode === 0) {
		return "merge";
	}
	if ((await runGit(context.gitRoot, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"])).exitCode === 0) {
		return "cherry-pick";
	}
	if ((await runGit(context.gitRoot, ["rev-parse", "--verify", "--quiet", "REVERT_HEAD"])).exitCode === 0) {
		return "revert";
	}
	return null;
}

async function requireNoSourceControlOperation(context: IGitContext): Promise<void> {
	const operation = await projectSourceControlOperation(context);
	if (operation) {
		throw new Error(`A Git ${operation} operation is already in progress. Continue or abort it before starting another integration.`);
	}
}

async function resolveCommit(context: IGitContext, value: unknown, field: string): Promise<{ name: string; hash: string }> {
	const name = await validateStartPoint(context, value);
	const result = await requireGitSuccess(context.gitRoot, ["rev-parse", "--verify", `${name}^{commit}`], `${field} does not resolve to a Git commit.`);
	const hash = result.stdout.trim();
	if (!/^[a-f0-9]{40,64}$/i.test(hash)) {
		throw new Error(`${field} resolved to an invalid Git commit hash.`);
	}
	return { name, hash };
}

function throwGitResult(message: string, result: IGitResult): never {
	const details = (result.stderr || result.stdout).trim().slice(0, 512);
	throw new Error(details ? `${message}: ${details}` : message);
}

/** Previews merge-base relationship, commit divergence, and bounded project-file impact for one commit-ish target. */
export async function previewProjectSourceControlIntegration(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const context = await gitContext(options);
	const target = await resolveCommit(context, data.target, "target");
	const head = await resolveCommit(context, "HEAD", "HEAD");
	const mergeBaseResult = await requireGitSuccess(context.gitRoot, ["merge-base", head.hash, target.hash], "HEAD and target do not have a common merge base.");
	const mergeBase = mergeBaseResult.stdout.trim();
	const divergence = await requireGitSuccess(
		context.gitRoot,
		["rev-list", "--left-right", "--count", `${head.hash}...${target.hash}`],
		"Unable to calculate integration divergence."
	);
	const [currentOnly, targetOnly] = divergence.stdout.trim().split(/\s+/).map(Number);
	const changedResult = await requireGitSuccess(
		context.projectRoot,
		["diff", "--name-only", "-z", head.hash, target.hash, "--", "."],
		"Unable to calculate project files affected by integration.",
		undefined,
		true
	);
	const allChangedFiles = changedResult.stdout.split("\0").filter(Boolean);
	const relationship = head.hash === target.hash ? "upToDate" : mergeBase === head.hash ? "fastForward" : mergeBase === target.hash ? "targetAlreadyMerged" : "diverged";
	return {
		target: target.name,
		targetHash: target.hash,
		headHash: head.hash,
		mergeBase,
		relationship,
		currentOnly,
		targetOnly,
		changedFileCount: allChangedFiles.length,
		changedFiles: allChangedFiles.slice(0, 500),
		truncated: allChangedFiles.length > 500,
		projectOwnsWorktree: !context.projectPrefix,
	};
}

async function sourceControlConflictState(context: IGitContext): Promise<any> {
	const operation = await projectSourceControlOperation(context);
	const pathsResult = await requireGitSuccess(context.gitRoot, ["diff", "--name-only", "--diff-filter=U", "-z"], "Unable to list unresolved Git conflicts.", undefined, true);
	const allPaths = pathsResult.stdout.split("\0").filter(Boolean);
	const stagesResult = await requireGitSuccess(context.gitRoot, ["ls-files", "--unmerged", "-z"], "Unable to inspect Git conflict stages.", undefined, true);
	const stageMap = new Map<string, { stage: number; mode: string; hash: string }[]>();
	for (const record of stagesResult.stdout.split("\0").filter(Boolean)) {
		const separator = record.indexOf("\t");
		const metadata = record.slice(0, separator).split(" ");
		const path = record.slice(separator + 1);
		if (separator < 0 || metadata.length !== 3) {
			continue;
		}
		const stages = stageMap.get(path) ?? [];
		stages.push({ mode: metadata[0], hash: metadata[1], stage: Number(metadata[2]) });
		stageMap.set(path, stages);
	}
	return {
		operation,
		conflictCount: allPaths.length,
		conflicts: allPaths.slice(0, 500).map((path) => ({ path, stages: stageMap.get(path) ?? [] })),
		truncated: allPaths.length > 500,
		status: await statusForContext(context),
	};
}

/** Returns the active merge/rebase state and bounded unresolved conflict metadata without file contents. */
export async function getProjectSourceControlIntegrationState(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	return sourceControlConflictState(await gitContext(options));
}

/** Starts a no-fast-forward, no-auto-commit merge so its staged result can be reviewed. */
export async function startProjectSourceControlMerge(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "start a Git merge");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git merge");
	await requireNoSourceControlOperation(context);
	await requireCleanWorktree(context, "Git merge");
	const target = await resolveCommit(context, data.target, "target");
	const preview = await previewProjectSourceControlIntegration(scene, { target: target.hash }, options);
	if (preview.relationship === "upToDate" || preview.relationship === "targetAlreadyMerged") {
		return {
			started: false,
			completed: true,
			target: target.name,
			targetHash: target.hash,
			preview,
			integration: await sourceControlConflictState(context),
			output: "Target is already integrated.",
		};
	}
	const result = await runGit(context.gitRoot, ["merge", "--no-commit", "--no-ff", target.hash], 120_000);
	const integration = await sourceControlConflictState(context);
	if (result.exitCode !== 0 && integration.operation !== "merge") {
		throwGitResult(`Unable to start Git merge of ${target.name}`, result);
	}
	return {
		started: true,
		completed: integration.operation === null,
		target: target.name,
		targetHash: target.hash,
		preview,
		integration,
		output: `${result.stdout}${result.stderr}`.trim().slice(0, 50_000),
	};
}

/** Starts a non-interactive rebase onto a verified target and stops safely on conflicts. */
export async function startProjectSourceControlRebase(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "start a Git rebase");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git rebase");
	await requireNoSourceControlOperation(context);
	await requireCleanWorktree(context, "Git rebase");
	const target = await resolveCommit(context, data.target, "target");
	const preview = await previewProjectSourceControlIntegration(scene, { target: target.hash }, options);
	const result = await runGit(context.gitRoot, ["rebase", target.hash], 120_000);
	const integration = await sourceControlConflictState(context);
	if (result.exitCode !== 0 && !(integration.operation === "rebase" && integration.conflictCount > 0)) {
		throwGitResult(`Unable to rebase onto ${target.name}`, result);
	}
	return {
		started: true,
		completed: integration.operation === null,
		target: target.name,
		targetHash: target.hash,
		preview,
		integration,
		output: `${result.stdout}${result.stderr}`.trim().slice(0, 50_000),
	};
}

/** Resolves one currently unmerged safe path using a Git stage, deletion, or externally edited worktree content. */
export async function resolveProjectSourceControlConflict(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "resolve a Git conflict");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git conflict resolution");
	const integration = await sourceControlConflictState(context);
	if (integration.operation !== "merge" && integration.operation !== "rebase") {
		throw new Error("Conflict resolution requires an active Git merge or rebase.");
	}
	const path = validatePath(data.path);
	if (!integration.conflicts.some((conflict: any) => conflict.path === path)) {
		throw new Error(`${path} is not a currently unresolved Git conflict.`);
	}
	if (!(data.resolution === "ours" || data.resolution === "theirs" || data.resolution === "delete" || data.resolution === "markResolved")) {
		throw new Error("resolution must be ours, theirs, delete, or markResolved.");
	}
	if (data.resolution === "ours" || data.resolution === "theirs") {
		await requireGitSuccess(context.gitRoot, ["checkout", `--${data.resolution}`, "--", path], `Unable to apply the ${data.resolution} conflict stage for ${path}.`);
		await requireGitSuccess(context.gitRoot, ["add", "--", path], `Unable to stage resolved conflict ${path}.`);
	} else if (data.resolution === "delete") {
		await requireGitSuccess(context.gitRoot, ["rm", "--force", "--", path], `Unable to resolve ${path} as deleted.`);
	} else {
		await requireGitSuccess(context.gitRoot, ["add", "-A", "--", path], `Unable to mark externally edited conflict ${path} as resolved.`);
	}
	return { resolved: true, path, resolution: data.resolution, integration: await sourceControlConflictState(context) };
}

/** Continues an active merge or rebase only after every conflict is resolved. */
export async function continueProjectSourceControlIntegration(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "continue the Git integration");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git integration continuation");
	const before = await sourceControlConflictState(context);
	if (before.operation !== "merge" && before.operation !== "rebase") {
		throw new Error("There is no active Git merge or rebase to continue.");
	}
	if (before.conflictCount > 0) {
		throw new Error(`Resolve all ${before.conflictCount} remaining Git conflict(s) before continuing.`);
	}
	let result: IGitResult;
	if (before.operation === "merge") {
		if (typeof data.message !== "string" || !data.message.trim() || data.message.length > 5000 || /\0/.test(data.message)) {
			throw new Error("message must be 1–5000 characters without null bytes to complete a merge.");
		}
		result = await runGit(context.gitRoot, ["commit", "-m", data.message], 120_000);
	} else {
		result = await runGit(context.gitRoot, ["rebase", "--continue"], 120_000);
	}
	const integration = await sourceControlConflictState(context);
	if (result.exitCode !== 0 && !(before.operation === "rebase" && integration.operation === "rebase" && integration.conflictCount > 0)) {
		throwGitResult(`Unable to continue Git ${before.operation}`, result);
	}
	return {
		continued: true,
		completed: integration.operation === null,
		operation: before.operation,
		integration,
		output: `${result.stdout}${result.stderr}`.trim().slice(0, 50_000),
		refs: integration.operation === null ? await listProjectSourceControlRefs(scene, {}, options) : undefined,
	};
}

/** Aborts an active merge or rebase and restores its pre-operation worktree/index state. */
export async function abortProjectSourceControlIntegration(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "abort the Git integration");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git integration abort");
	const operation = await projectSourceControlOperation(context);
	if (operation !== "merge" && operation !== "rebase") {
		throw new Error("There is no active Git merge or rebase to abort.");
	}
	const result = await requireGitSuccess(context.gitRoot, [operation, "--abort"], `Unable to abort Git ${operation}.`, 120_000);
	return {
		aborted: true,
		operation,
		output: `${result.stdout}${result.stderr}`.trim().slice(0, 50_000),
		integration: await sourceControlConflictState(context),
		refs: await listProjectSourceControlRefs(scene, {}, options),
	};
}

interface IProjectSourceControlRemoteRef {
	name: string;
	hash: string;
}

async function readProjectSourceControlRemoteRefs(context: IGitContext, remoteValue: unknown): Promise<any> {
	const { remote, url } = await validateRemoteForNetwork(context, remoteValue, true);
	const result = await requireGitSuccess(
		context.gitRoot,
		["ls-remote", "--symref", url, "HEAD", "refs/heads/*", "refs/tags/*"],
		`Unable to inspect Git remote ${remote}.`,
		120_000
	);
	let defaultBranch: string | null = null;
	const branches: IProjectSourceControlRemoteRef[] = [];
	const tags: IProjectSourceControlRemoteRef[] = [];
	for (const line of result.stdout.split("\n").filter(Boolean)) {
		const [value, ref] = line.split("\t");
		if (value?.startsWith("ref: refs/heads/") && ref === "HEAD") {
			defaultBranch = value.slice("ref: refs/heads/".length);
			continue;
		}
		if (!/^[a-f0-9]{40,64}$/i.test(value ?? "") || !ref || ref.endsWith("^{}")) {
			continue;
		}
		if (ref.startsWith("refs/heads/")) {
			branches.push({ name: ref.slice("refs/heads/".length), hash: value });
		} else if (ref.startsWith("refs/tags/")) {
			tags.push({ name: ref.slice("refs/tags/".length), hash: value });
		}
	}
	return {
		remote,
		defaultBranch,
		branchCount: branches.length,
		tagCount: tags.length,
		branches: branches.slice(0, 500),
		tags: tags.slice(0, 500),
		truncated: { branches: branches.length > 500, tags: tags.length > 500 },
	};
}

/** Reads authoritative remote heads/tags and the advertised default branch without returning the remote URL. */
export async function inspectProjectSourceControlRemoteRefs(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	return readProjectSourceControlRemoteRefs(await gitContext(options), data.remote);
}

async function localRefHash(context: IGitContext, namespace: "heads" | "tags", name: string): Promise<string> {
	const result = await requireGitSuccess(
		context.gitRoot,
		["show-ref", "--verify", "--hash", `refs/${namespace}/${name}`],
		`Local Git ${namespace === "heads" ? "branch" : "tag"} ${name} does not exist.`
	);
	const hash = result.stdout.trim();
	if (!/^[a-f0-9]{40,64}$/i.test(hash)) {
		throw new Error(`Local Git ref ${name} resolved to an invalid hash.`);
	}
	return hash;
}

function validateExpectedRemoteHash(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/i.test(value)) {
		throw new Error("expectedHash must be the exact 40–64 character hexadecimal hash returned by remote-ref inspection.");
	}
	return value.toLowerCase();
}

async function requireRemoteRef(context: IGitContext, remoteValue: unknown, kind: "branch" | "tag", name: string, expectedHash: string): Promise<{ remote: string; refs: any }> {
	const refs = await readProjectSourceControlRemoteRefs(context, remoteValue);
	const ref = (kind === "branch" ? refs.branches : refs.tags).find((candidate: IProjectSourceControlRemoteRef) => candidate.name === name);
	if (!ref) {
		throw new Error(`Remote Git ${kind} ${name} does not exist or is outside the bounded inspection result.`);
	}
	if (ref.hash.toLowerCase() !== expectedHash) {
		throw new Error(`Remote Git ${kind} ${name} changed since inspection. Refresh remote refs and use its current expectedHash.`);
	}
	return { remote: refs.remote, refs };
}

/** Publishes an existing local branch to a validated remote without force. */
export async function publishProjectSourceControlRemoteBranch(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "publish a Git branch");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Remote Git branch publication");
	await requireNoSourceControlOperation(context);
	const localBranch = await validateBranch(context, data.localBranch);
	const remoteBranch = data.remoteBranch === undefined ? localBranch : await validateBranch(context, data.remoteBranch);
	const localHash = await localRefHash(context, "heads", localBranch);
	const { remote } = await validateRemoteForNetwork(context, data.remote, true);
	const result = await requireGitSuccess(
		context.gitRoot,
		["push", "--porcelain", remote, `refs/heads/${localBranch}:refs/heads/${remoteBranch}`],
		`Unable to publish ${localBranch} to ${remote}/${remoteBranch}. No force update was attempted.`,
		120_000
	);
	return {
		published: true,
		remote,
		localBranch,
		remoteBranch,
		localHash,
		output: `${result.stdout}${result.stderr}`.trim().slice(0, 50_000),
		remoteRefs: await readProjectSourceControlRemoteRefs(context, remote),
	};
}

/** Deletes a non-default remote branch only while its authoritative hash matches an explicit lease. */
export async function deleteProjectSourceControlRemoteBranch(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "delete a remote Git branch");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Remote Git branch deletion");
	await requireNoSourceControlOperation(context);
	const branch = await validateBranch(context, data.branch);
	const expectedHash = validateExpectedRemoteHash(data.expectedHash);
	const { remote, refs } = await requireRemoteRef(context, data.remote, "branch", branch, expectedHash);
	if (refs.defaultBranch === branch) {
		throw new Error(`Remote Git branch ${branch} is advertised as the default branch and cannot be deleted by this workflow.`);
	}
	const result = await requireGitSuccess(
		context.gitRoot,
		["push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${expectedHash}`, remote, `:refs/heads/${branch}`],
		`Unable to delete remote Git branch ${remote}/${branch}; its lease may be stale or the server may protect it.`,
		120_000
	);
	return {
		deleted: true,
		remote,
		branch,
		expectedHash,
		output: `${result.stdout}${result.stderr}`.trim().slice(0, 50_000),
		remoteRefs: await readProjectSourceControlRemoteRefs(context, remote),
	};
}

/** Publishes one existing local tag to the same remote tag name without overwrite. */
export async function publishProjectSourceControlRemoteTag(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "publish a Git tag");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Remote Git tag publication");
	await requireNoSourceControlOperation(context);
	const tag = await validateTag(context, data.tag);
	const localHash = await localRefHash(context, "tags", tag);
	const { remote } = await validateRemoteForNetwork(context, data.remote, true);
	const result = await requireGitSuccess(
		context.gitRoot,
		["push", "--porcelain", remote, `refs/tags/${tag}:refs/tags/${tag}`],
		`Unable to publish Git tag ${tag}. Existing remote tags are never overwritten.`,
		120_000
	);
	return {
		published: true,
		remote,
		tag,
		localHash,
		output: `${result.stdout}${result.stderr}`.trim().slice(0, 50_000),
		remoteRefs: await readProjectSourceControlRemoteRefs(context, remote),
	};
}

/** Deletes a remote tag only while its authoritative hash matches an explicit lease. */
export async function deleteProjectSourceControlRemoteTag(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "delete a remote Git tag");
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Remote Git tag deletion");
	await requireNoSourceControlOperation(context);
	const tag = await validateTag(context, data.tag);
	const expectedHash = validateExpectedRemoteHash(data.expectedHash);
	const { remote } = await requireRemoteRef(context, data.remote, "tag", tag, expectedHash);
	const result = await requireGitSuccess(
		context.gitRoot,
		["push", "--porcelain", `--force-with-lease=refs/tags/${tag}:${expectedHash}`, remote, `:refs/tags/${tag}`],
		`Unable to delete remote Git tag ${tag}; its lease may be stale or the server may protect it.`,
		120_000
	);
	return {
		deleted: true,
		remote,
		tag,
		expectedHash,
		output: `${result.stdout}${result.stderr}`.trim().slice(0, 50_000),
		remoteRefs: await readProjectSourceControlRemoteRefs(context, remote),
	};
}

function isContainedPath(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function safeConflictWorktreePath(context: IGitContext, path: string): Promise<{ target: string; exists: boolean; mode: number; size: number }> {
	const target = join(context.gitRoot, path);
	const parent = await realpath(dirname(target));
	if (!isContainedPath(context.gitRoot, parent)) {
		throw new Error("Conflict path parent resolves outside the active Git worktree.");
	}
	try {
		const info = await lstat(target);
		if (info.isSymbolicLink() || !info.isFile()) {
			throw new Error("Conflict resolution supports regular worktree files only and rejects symbolic links.");
		}
		return { target, exists: true, mode: info.mode & 0o777, size: info.size };
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return { target, exists: false, mode: 0o644, size: 0 };
		}
		throw error;
	}
}

function decodeConflictBytes(bytes: Buffer): { binary: boolean; text: string | null } {
	if (bytes.includes(0)) {
		return { binary: true, text: null };
	}
	try {
		return { binary: false, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
	} catch {
		return { binary: true, text: null };
	}
}

async function conflictStageDetails(context: IGitContext, stage: { stage: number; mode: string; hash: string } | undefined): Promise<any> {
	if (!stage) {
		return null;
	}
	const sizeResult = await requireGitSuccess(context.gitRoot, ["cat-file", "-s", stage.hash], "Unable to read Git conflict blob size.");
	const byteLength = Number(sizeResult.stdout.trim());
	if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
		throw new Error("Git conflict blob reported an invalid size.");
	}
	if (byteLength > maximumConflictPreviewBytes) {
		return { stage: stage.stage, mode: stage.mode, hash: stage.hash, byteLength, tooLarge: true, binary: null, text: null };
	}
	const content = await runGitBytes(context.gitRoot, ["cat-file", "blob", stage.hash], maximumConflictPreviewBytes + 1024);
	if (content.exitCode !== 0) {
		throw new Error(content.stderr ? `Unable to read Git conflict blob: ${content.stderr.slice(0, 512)}` : "Unable to read Git conflict blob.");
	}
	const decoded = decodeConflictBytes(content.stdout);
	return { stage: stage.stage, mode: stage.mode, hash: stage.hash, byteLength, tooLarge: false, ...decoded };
}

async function conflictWorktreeDetails(context: IGitContext, path: string): Promise<any> {
	const worktreePath = await safeConflictWorktreePath(context, path);
	if (!worktreePath.exists) {
		return { exists: false, byteLength: 0, tooLarge: false, binary: null, text: null };
	}
	if (worktreePath.size > maximumConflictPreviewBytes) {
		return { exists: true, byteLength: worktreePath.size, tooLarge: true, binary: null, text: null };
	}
	const content = await readFile(worktreePath.target);
	return { exists: true, byteLength: content.length, tooLarge: false, ...decodeConflictBytes(content) };
}

async function conflictIdentityForContext(context: IGitContext, pathValue: unknown): Promise<any> {
	const integration = await sourceControlConflictState(context);
	if (integration.operation !== "merge" && integration.operation !== "rebase") {
		throw new Error("Conflict detail inspection requires an active Git merge or rebase.");
	}
	const path = validatePath(pathValue);
	const conflict = integration.conflicts.find((candidate: any) => candidate.path === path);
	if (!conflict) {
		throw new Error(`${path} is not a currently unresolved Git conflict.`);
	}
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				operation: integration.operation,
				path,
				stages: [...conflict.stages].sort((left: any, right: any) => left.stage - right.stage).map((stage: any) => [stage.stage, stage.mode, stage.hash]),
			})
		)
		.digest("hex");
	return { integration, path, conflict, fingerprint };
}

async function conflictDetailsForContext(context: IGitContext, pathValue: unknown): Promise<any> {
	const { integration, path, conflict, fingerprint } = await conflictIdentityForContext(context, pathValue);
	const stage = (number: number): any => conflict.stages.find((candidate: any) => candidate.stage === number);
	const [base, ours, theirs, worktree] = await Promise.all([
		conflictStageDetails(context, stage(1)),
		conflictStageDetails(context, stage(2)),
		conflictStageDetails(context, stage(3)),
		conflictWorktreeDetails(context, path),
	]);
	return {
		operation: integration.operation,
		path,
		fingerprint,
		maximumContentBytes: maximumConflictPreviewBytes,
		base,
		ours,
		theirs,
		worktree,
		textEditable: [base, ours, theirs].filter(Boolean).every((details) => details.binary === false && details.tooLarge === false),
	};
}

/** Returns bounded base/ours/theirs blob details and current worktree conflict content for one unresolved path. */
export async function inspectProjectSourceControlConflictDetails(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git conflict detail inspection");
	return conflictDetailsForContext(context, data.path);
}

interface IConflictImageStage {
	summary: any;
	pixels: Buffer | null;
	width: number;
	height: number;
}

async function conflictImageStageDetails(
	context: IGitContext,
	stage: { stage: number; mode: string; hash: string } | undefined,
	includePreview: boolean
): Promise<IConflictImageStage | null> {
	if (!stage) {
		return null;
	}
	const sizeResult = await requireGitSuccess(context.gitRoot, ["cat-file", "-s", stage.hash], "Unable to read Git conflict image blob size.");
	const byteLength = Number(sizeResult.stdout.trim());
	if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
		throw new Error("Git conflict image blob reported an invalid size.");
	}
	const metadata = { stage: stage.stage, mode: stage.mode, hash: stage.hash, byteLength };
	if (byteLength > maximumConflictImageBytes) {
		return { summary: { ...metadata, status: "too-large", maximumBytes: maximumConflictImageBytes }, pixels: null, width: 0, height: 0 };
	}
	const content = await runGitBytes(context.gitRoot, ["cat-file", "blob", stage.hash], maximumConflictImageBytes + 1024);
	if (content.exitCode !== 0) {
		throw new Error(content.stderr ? `Unable to read Git conflict image blob: ${content.stderr.slice(0, 512)}` : "Unable to read Git conflict image blob.");
	}
	try {
		const source = sharp(content.stdout, { animated: false, failOn: "error", limitInputPixels: maximumConflictImagePixels });
		const imageMetadata = await source.metadata();
		if (!imageMetadata.format || !["png", "jpeg", "webp"].includes(imageMetadata.format)) {
			return {
				summary: { ...metadata, status: "unsupported", reason: "Only non-animated PNG, JPEG, and WebP conflict stages are supported." },
				pixels: null,
				width: 0,
				height: 0,
			};
		}
		if ((imageMetadata.pages ?? 1) > 1) {
			return { summary: { ...metadata, status: "unsupported", reason: "Animated or multi-page conflict images are not compared." }, pixels: null, width: 0, height: 0 };
		}
		const decoded = await source.rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		const width = decoded.info.width;
		const height = decoded.info.height;
		const pixelCount = width * height;
		if (!width || !height || pixelCount > maximumConflictImagePixels || decoded.info.channels !== 4) {
			return { summary: { ...metadata, status: "unsupported", reason: "Decoded dimensions or channel layout are unsupported." }, pixels: null, width: 0, height: 0 };
		}
		const sums = [0, 0, 0, 0];
		const minimum = [255, 255, 255, 255];
		const maximum = [0, 0, 0, 0];
		let alphaCoveredPixels = 0;
		for (let offset = 0; offset < decoded.data.length; offset += 4) {
			for (let channel = 0; channel < 4; channel++) {
				const value = decoded.data[offset + channel];
				sums[channel] += value;
				minimum[channel] = Math.min(minimum[channel], value);
				maximum[channel] = Math.max(maximum[channel], value);
			}
			if (decoded.data[offset + 3] > 0) {
				alphaCoveredPixels++;
			}
		}
		let preview: any = null;
		if (includePreview) {
			const encoded = await sharp(decoded.data, { raw: { width, height, channels: 4 } })
				.resize({ width: conflictImagePreviewSize, height: conflictImagePreviewSize, fit: "inside", withoutEnlargement: true, kernel: sharp.kernel.lanczos3 })
				.png({ compressionLevel: 9, adaptiveFiltering: false })
				.toBuffer({ resolveWithObject: true });
			preview = { mimeType: "image/png", width: encoded.info.width, height: encoded.info.height, imageBase64: encoded.data.toString("base64") };
		}
		return {
			summary: {
				...metadata,
				status: "ready",
				format: imageMetadata.format,
				width,
				height,
				channels: 4,
				pixelSha256: createHash("sha256").update(decoded.data).digest("hex"),
				averageRgba: sums.map((sum) => Number((sum / pixelCount / 255).toFixed(6))),
				minimumRgba: minimum.map((value) => Number((value / 255).toFixed(6))),
				maximumRgba: maximum.map((value) => Number((value / 255).toFixed(6))),
				alphaCoverage: Number((alphaCoveredPixels / pixelCount).toFixed(6)),
				...(preview ? { preview } : {}),
			},
			pixels: decoded.data,
			width,
			height,
		};
	} catch (error) {
		const exceededPixelLimit = error instanceof Error && /pixel limit|exceeds.*pixels|too many pixels/i.test(error.message);
		return {
			summary: {
				...metadata,
				status: exceededPixelLimit ? "too-many-pixels" : "invalid",
				reason: exceededPixelLimit
					? `Decoded image exceeds the ${maximumConflictImagePixels}-pixel safety limit.`
					: "The conflict blob is not a valid bounded PNG, JPEG, or WebP image.",
			},
			pixels: null,
			width: 0,
			height: 0,
		};
	}
}

async function compareConflictImages(label: string, left: IConflictImageStage | null, right: IConflictImageStage | null, includePreview: boolean): Promise<any> {
	if (!left || !right) {
		return { label, available: false, comparable: false, reason: "One or both conflict stages are absent." };
	}
	if (!left.pixels || !right.pixels) {
		return { label, available: false, comparable: false, reason: "One or both conflict stages are not decodable bounded raster images." };
	}
	if (left.width !== right.width || left.height !== right.height) {
		return {
			label,
			available: true,
			comparable: false,
			reason: "Exact pixel comparison requires matching oriented dimensions.",
			leftSize: [left.width, left.height],
			rightSize: [right.width, right.height],
		};
	}
	const pixelCount = left.width * left.height;
	const absoluteSums = [0, 0, 0, 0];
	const squaredSums = [0, 0, 0, 0];
	let changedPixels = 0;
	let maximumChannelDelta = 0;
	let leftBound = left.width;
	let topBound = left.height;
	let rightBound = -1;
	let bottomBound = -1;
	const differencePixels = includePreview ? Buffer.alloc(left.pixels.length) : null;
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		const offset = pixel * 4;
		let changed = false;
		let greatestDelta = 0;
		for (let channel = 0; channel < 4; channel++) {
			const delta = Math.abs(left.pixels[offset + channel] - right.pixels[offset + channel]);
			absoluteSums[channel] += delta;
			squaredSums[channel] += delta * delta;
			maximumChannelDelta = Math.max(maximumChannelDelta, delta);
			greatestDelta = Math.max(greatestDelta, delta);
			changed ||= delta !== 0;
		}
		if (changed) {
			changedPixels++;
			const x = pixel % left.width;
			const y = Math.floor(pixel / left.width);
			leftBound = Math.min(leftBound, x);
			topBound = Math.min(topBound, y);
			rightBound = Math.max(rightBound, x);
			bottomBound = Math.max(bottomBound, y);
		}
		if (differencePixels) {
			differencePixels[offset] = greatestDelta;
			differencePixels[offset + 1] = 0;
			differencePixels[offset + 2] = 255 - greatestDelta;
			differencePixels[offset + 3] = changed ? 255 : 0;
		}
	}
	let differencePreview: any = null;
	if (differencePixels) {
		const encoded = await sharp(differencePixels, { raw: { width: left.width, height: left.height, channels: 4 } })
			.resize({ width: conflictImagePreviewSize, height: conflictImagePreviewSize, fit: "inside", withoutEnlargement: true, kernel: sharp.kernel.nearest })
			.png({ compressionLevel: 9, adaptiveFiltering: false })
			.toBuffer({ resolveWithObject: true });
		differencePreview = { mimeType: "image/png", width: encoded.info.width, height: encoded.info.height, imageBase64: encoded.data.toString("base64") };
	}
	return {
		label,
		available: true,
		comparable: true,
		width: left.width,
		height: left.height,
		pixelCount,
		changedPixels,
		changedRatio: Number((changedPixels / pixelCount).toFixed(6)),
		meanAbsoluteErrorRgba: absoluteSums.map((sum) => Number((sum / pixelCount / 255).toFixed(6))),
		rootMeanSquareErrorRgba: squaredSums.map((sum) => Number((Math.sqrt(sum / pixelCount) / 255).toFixed(6))),
		maximumChannelDelta: Number((maximumChannelDelta / 255).toFixed(6)),
		changedBounds: changedPixels ? { x: leftBound, y: topBound, width: rightBound - leftBound + 1, height: bottomBound - topBound + 1 } : null,
		...(differencePreview ? { differencePreview } : {}),
	};
}

/** Returns bounded visual previews and exact pairwise pixel metrics for raster-image Git conflict stages. */
export async function inspectProjectSourceControlImageConflict(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git image conflict inspection");
	const { integration, path, conflict, fingerprint } = await conflictIdentityForContext(context, data.path);
	const includePreviews = data.includePreviews !== false;
	const stage = (number: number): any => conflict.stages.find((candidate: any) => candidate.stage === number);
	const [base, ours, theirs] = await Promise.all([
		conflictImageStageDetails(context, stage(1), includePreviews),
		conflictImageStageDetails(context, stage(2), includePreviews),
		conflictImageStageDetails(context, stage(3), includePreviews),
	]);
	const [baseToOurs, baseToTheirs, oursToTheirs] = await Promise.all([
		compareConflictImages("base-to-ours", base, ours, includePreviews),
		compareConflictImages("base-to-theirs", base, theirs, includePreviews),
		compareConflictImages("ours-to-theirs", ours, theirs, includePreviews),
	]);
	return {
		operation: integration.operation,
		path,
		fingerprint,
		includePreviews,
		limits: { maximumBlobBytes: maximumConflictImageBytes, maximumPixels: maximumConflictImagePixels, previewMaximumDimension: conflictImagePreviewSize },
		base: base?.summary ?? null,
		ours: ours?.summary ?? null,
		theirs: theirs?.summary ?? null,
		comparisons: { baseToOurs, baseToTheirs, oursToTheirs },
	};
}

async function atomicConflictWrite(target: string, content: Buffer, mode: number): Promise<void> {
	const temporaryPath = `${target}.babylon-editor-conflict-${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(temporaryPath, content, { flag: "wx", mode });
		await rename(temporaryPath, target);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

/** Atomically writes and stages a fingerprint-guarded custom UTF-8 resolution for one text conflict. */
export async function applyProjectSourceControlTextResolution(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireSourceControlRole(scene, data, options, true);
	requireConfirmation(data, "apply a custom Git text conflict resolution");
	if (typeof data.content !== "string" || data.content.includes("\0") || Buffer.byteLength(data.content, "utf-8") > maximumConflictResolutionBytes) {
		throw new Error(`content must be UTF-8 text without null bytes and at most ${maximumConflictResolutionBytes} bytes.`);
	}
	if (typeof data.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedFingerprint)) {
		throw new Error("expectedFingerprint must be the exact lowercase SHA-256 returned by conflict detail inspection.");
	}
	const context = await gitContext(options);
	requireProjectOwnsWorktree(context, "Git custom text conflict resolution");
	const details = await conflictDetailsForContext(context, data.path);
	if (details.fingerprint !== data.expectedFingerprint) {
		throw new Error("The Git conflict stages changed since inspection. Inspect the conflict again before applying custom text.");
	}
	if (!details.textEditable) {
		throw new Error(
			"Custom text resolution is unavailable because at least one conflict stage is binary or exceeds the bounded content limit. Use ours, theirs, or delete instead."
		);
	}
	const worktreePath = await safeConflictWorktreePath(context, details.path);
	if (worktreePath.size > maximumConflictRollbackBytes) {
		throw new Error("Current conflict worktree content is too large for rollback-safe custom text replacement.");
	}
	const previousContent = worktreePath.exists ? await readFile(worktreePath.target) : null;
	await atomicConflictWrite(worktreePath.target, Buffer.from(data.content, "utf-8"), worktreePath.mode);
	try {
		await requireGitSuccess(context.gitRoot, ["add", "--", details.path], `Unable to stage custom text resolution ${details.path}.`);
	} catch (error) {
		if (previousContent) {
			await atomicConflictWrite(worktreePath.target, previousContent, worktreePath.mode);
		} else {
			await unlink(worktreePath.target).catch(() => undefined);
		}
		throw error;
	}
	return {
		applied: true,
		path: details.path,
		fingerprint: details.fingerprint,
		byteLength: Buffer.byteLength(data.content, "utf-8"),
		integration: await sourceControlConflictState(context),
	};
}
