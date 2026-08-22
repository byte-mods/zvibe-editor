import { ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { ensureDir, lstat, pathExists, readFile, readdir, remove, writeFile } from "fs-extra";
import { Scene } from "babylonjs";
import stripAnsi from "strip-ansi";

import { IMCPActionOptions } from "../action";
import { getPlatformDiagnostics, getPlatformScaffold } from "../project/platforms";
import { getMobileDeploymentConfiguration } from "./configuration";
import { IMobileDeploymentConfiguration, MobileTarget, validateMobileDeploymentConfiguration, validateMobileRelativePath } from "./model";

export type MobileWorkflowOperation = "package" | "install" | "launch" | "logs" | "submit";
export type MobileJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceling" | "canceled";

interface IMobileArtifact {
	path: string;
	extension: ".apk" | ".aab" | ".ipa";
	sizeBytes: number;
	sha256: string;
	modifiedAt: string;
}

interface IMobileWorkflowPlan {
	id: string;
	target: MobileTarget;
	operation: MobileWorkflowOperation;
	configurationRevision: number;
	scaffoldRevision: number;
	createdAt: string;
	expiresAt: string;
	artifact?: IMobileArtifact;
	deviceId?: string;
	durationSeconds?: number;
	warnings: string[];
	androidBuildPlan?: IAndroidBuildPlanEvidence | null;
}

interface IAndroidBuildPlanEvidence {
	path: string;
	sha256: string;
	settings: {
		linkTimeOptimization: "none" | "thin" | "full";
		xrLinkTimeOptimization: "inherit" | "thin";
		initializationProfiling: boolean;
	};
}

interface IMobileCommand {
	executable: string;
	args: string[];
	safeArgs: string[];
	cwd: string;
	environment: NodeJS.ProcessEnv;
}

interface IMobileJob {
	id: string;
	planId: string;
	target: MobileTarget;
	operation: MobileWorkflowOperation;
	status: MobileJobStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	commandIndex: number;
	commands: IMobileCommand[];
	outputTail: string;
	exitCode?: number | null;
	error?: string;
	artifacts: IMobileArtifact[];
	baselineArtifacts: IMobileArtifact[];
	expectedArtifactExtension?: IMobileArtifact["extension"];
	secretValues: string[];
	cleanupPaths: string[];
	durationSeconds?: number;
	child?: ChildProcess;
	timedCompletion: boolean;
}

const execFileAsync = promisify(execFile);
const plansByScene = new WeakMap<Scene, Map<string, IMobileWorkflowPlan>>();
const jobsByScene = new WeakMap<Scene, Map<string, IMobileJob>>();
const activeJobs = new Set<IMobileJob>();
const supportedOperations = new Set<MobileWorkflowOperation>(["package", "install", "launch", "logs", "submit"]);
const deviceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function assertRecord(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function projectDirectory(options: IMCPActionOptions): string {
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectPath);
}

function planStore(scene: Scene): Map<string, IMobileWorkflowPlan> {
	let result = plansByScene.get(scene);
	if (!result) {
		result = new Map();
		plansByScene.set(scene, result);
	}
	return result;
}

function jobStore(scene: Scene): Map<string, IMobileJob> {
	let result = jobsByScene.get(scene);
	if (!result) {
		result = new Map();
		jobsByScene.set(scene, result);
	}
	return result;
}

function randomId(prefix: string): string {
	return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function publicPlan(plan: IMobileWorkflowPlan): object {
	return structuredClone(plan);
}

function safeCommand(command: IMobileCommand): object {
	return { executable: command.executable, args: [...command.safeArgs], cwd: command.cwd };
}

function publicJob(job: IMobileJob): object {
	return {
		id: job.id,
		planId: job.planId,
		target: job.target,
		operation: job.operation,
		durationSeconds: job.durationSeconds,
		status: job.status,
		createdAt: job.createdAt,
		startedAt: job.startedAt,
		completedAt: job.completedAt,
		commandIndex: job.commandIndex,
		commands: job.commands.map(safeCommand),
		outputTail: job.outputTail,
		exitCode: job.exitCode,
		error: job.error,
		artifacts: structuredClone(job.artifacts),
	};
}

function stripUnsafeControlCharacters(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
			result += value[index];
		}
	}
	return result;
}

function cleanOutput(job: IMobileJob, value: string): string {
	let result = stripUnsafeControlCharacters(stripAnsi(value));
	for (const secret of job.secretValues.filter(Boolean)) {
		result = result.replaceAll(secret, "[REDACTED]");
	}
	return `${job.outputTail}${result}`.slice(-65_536);
}

async function commandAvailable(command: string): Promise<boolean> {
	try {
		await execFileAsync(process.platform === "win32" ? "where" : "which", [command], { timeout: 2_000 });
		return true;
	} catch {
		return false;
	}
}

async function containedExistingPath(directory: string, relativePath: string, label: string): Promise<string> {
	validateMobileRelativePath(relativePath, label);
	const projectReal = await realpath(directory);
	const requested = resolve(directory, relativePath);
	if (!(await pathExists(requested))) {
		throw new Error(`${label} was not found: ${relativePath}`);
	}
	const details = await lstat(requested);
	if (details.isSymbolicLink()) {
		throw new Error(`${label} cannot be a symbolic link: ${relativePath}`);
	}
	const requestedReal = await realpath(requested);
	if (requestedReal !== projectReal && !requestedReal.startsWith(`${projectReal}${sep}`)) {
		throw new Error(`${label} resolves outside the project: ${relativePath}`);
	}
	return requestedReal;
}

async function containedOutputPath(directory: string, relativePath: string, label: string, directoryOutput: boolean): Promise<string> {
	validateMobileRelativePath(relativePath, label);
	const projectReal = await realpath(directory);
	const requested = resolve(projectReal, relativePath);
	const directoryToCreate = directoryOutput ? requested : dirname(requested);
	let ancestor = directoryToCreate;
	while (!(await pathExists(ancestor)) && ancestor !== projectReal) {
		ancestor = dirname(ancestor);
	}
	if (ancestor !== projectReal) {
		const details = await lstat(ancestor);
		if (details.isSymbolicLink()) {
			throw new Error(`${label} cannot traverse a symbolic link.`);
		}
		const ancestorReal = await realpath(ancestor);
		if (ancestorReal !== projectReal && !ancestorReal.startsWith(`${projectReal}${sep}`)) {
			throw new Error(`${label} resolves outside the project.`);
		}
	}
	await ensureDir(directoryToCreate);
	const createdReal = await realpath(directoryToCreate);
	if (createdReal !== projectReal && !createdReal.startsWith(`${projectReal}${sep}`)) {
		throw new Error(`${label} resolves outside the project.`);
	}
	return requested;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolveHash, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("error", reject);
		stream.once("end", resolveHash);
	});
	return hash.digest("hex");
}

async function readAndroidBuildPlan(directory: string): Promise<IAndroidBuildPlanEvidence | null> {
	const relativePath = ".zvibe/platforms/android/zvibe-android-build-profile.json";
	if (!(await pathExists(resolve(directory, relativePath)))) {
		return null;
	}
	const path = await containedExistingPath(directory, relativePath, "Android Build Profile plan");
	const details = await lstat(path);
	if (!details.isFile() || details.size > 64 * 1024) {
		throw new Error("Android Build Profile plan must be a regular JSON file of at most 64 KiB.");
	}
	let value: any;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error("Android Build Profile plan is not valid JSON; rebuild the exact Android profile.");
	}
	const settings = value?.settings;
	if (
		value?.version !== 1 ||
		value?.backend !== "zvibe-android-project-native-lto-v1" ||
		Object.keys(value).some((key) => !["version", "backend", "profileId", "settings", "lto", "xr", "initializationProfiling"].includes(key)) ||
		!settings ||
		typeof settings !== "object" ||
		Array.isArray(settings) ||
		Object.keys(settings).some((key) => !["linkTimeOptimization", "xrLinkTimeOptimization", "initializationProfiling"].includes(key)) ||
		!["none", "thin", "full"].includes(settings.linkTimeOptimization) ||
		!["inherit", "thin"].includes(settings.xrLinkTimeOptimization) ||
		typeof settings.initializationProfiling !== "boolean"
	) {
		throw new Error("Android Build Profile plan is malformed; rebuild the exact Android profile.");
	}
	return { path: relativePath, sha256: await hashFile(path), settings: structuredClone(settings) };
}

async function artifactFromPath(directory: string, relativePath: string, target: MobileTarget): Promise<IMobileArtifact> {
	const path = await containedExistingPath(directory, relativePath, "Mobile artifact");
	const projectReal = await realpath(directory);
	const details = await lstat(path);
	if (!details.isFile()) {
		throw new Error("Mobile artifact must be a regular file.");
	}
	const extension = extname(path).toLowerCase();
	const supported = target === "android" ? [".apk", ".aab"] : [".ipa"];
	if (!supported.includes(extension)) {
		throw new Error(`${target} artifact must use ${supported.join(" or ")}.`);
	}
	return {
		path: relative(projectReal, path).replaceAll("\\", "/"),
		extension: extension as IMobileArtifact["extension"],
		sizeBytes: details.size,
		sha256: await hashFile(path),
		modifiedAt: details.mtime.toISOString(),
	};
}

async function scanArtifacts(directory: string, target?: MobileTarget): Promise<IMobileArtifact[]> {
	const roots = [
		...(target !== "ios" ? [join(directory, ".zvibe/platforms/android/android/app/build/outputs")] : []),
		...(target !== "android" ? [join(directory, ".zvibe/mobile/ios/export")] : []),
	];
	const paths: string[] = [];
	let visited = 0;
	const visit = async (path: string): Promise<void> => {
		if (!(await pathExists(path)) || visited >= 8_192 || paths.length >= 256) {
			return;
		}
		const details = await lstat(path);
		if (details.isSymbolicLink()) {
			return;
		}
		visited++;
		if (details.isDirectory()) {
			for (const name of (await readdir(path)).sort()) {
				await visit(join(path, name));
			}
			return;
		}
		if ([".apk", ".aab", ".ipa"].includes(extname(path).toLowerCase())) {
			paths.push(path);
		}
	};
	for (const root of roots) {
		await visit(root);
	}
	const artifacts = await Promise.all(paths.map((path) => artifactFromPath(directory, relative(directory, path), extname(path).toLowerCase() === ".ipa" ? "ios" : "android")));
	return artifacts.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function environmentValue(name: string | undefined, label: string, secrets: string[]): string {
	if (!name) {
		throw new Error(`${label} environment reference is not configured.`);
	}
	const value = process.env[name];
	if (!value) {
		throw new Error(`${label} environment variable is not defined: ${name}`);
	}
	secrets.push(value);
	return value;
}

function packageTask(configuration: IMobileDeploymentConfiguration): string {
	if (configuration.android.gradleTask) {
		return configuration.android.gradleTask;
	}
	const suffix = configuration.android.variant === "debug" ? "Debug" : "Release";
	return configuration.android.format === "aab" ? `bundle${suffix}` : `assemble${suffix}`;
}

function xmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function commandsForPlan(
	plan: IMobileWorkflowPlan,
	configuration: IMobileDeploymentConfiguration,
	options: IMCPActionOptions,
	jobId: string
): Promise<{ commands: IMobileCommand[]; secrets: string[]; cleanupPaths: string[] }> {
	const directory = projectDirectory(options);
	const secrets: string[] = [];
	const cleanupPaths: string[] = [];
	const environment = { ...process.env };
	const command = (executable: string, args: string[], safeArgs = args, cwd = directory): IMobileCommand => ({
		executable,
		args,
		safeArgs,
		cwd,
		environment: { ...environment },
	});
	if (plan.operation === "package" && plan.target === "android") {
		const nativeDirectory = await containedExistingPath(directory, ".zvibe/platforms/android/android", "Android native project");
		const wrapperName = process.platform === "win32" ? "gradlew.bat" : "gradlew";
		const wrapper = await containedExistingPath(directory, `.zvibe/platforms/android/android/${wrapperName}`, "Android Gradle wrapper");
		const args = ["--no-daemon", packageTask(configuration)];
		if (plan.androidBuildPlan) {
			const buildProfileInit = await containedExistingPath(directory, ".zvibe/platforms/android/zvibe-build-profile.init.gradle", "Android Build Profile init script");
			environment.ZVIBE_ANDROID_BUILD_PLAN = JSON.stringify({ settings: plan.androidBuildPlan.settings });
			args.push("--init-script", buildProfileInit);
		}
		if (configuration.android.signing.enabled) {
			const signingInit = await containedExistingPath(directory, ".zvibe/platforms/android/zvibe-signing.init.gradle", "Android signing init script");
			environment.ZVIBE_ANDROID_KEYSTORE = environmentValue(configuration.android.signing.keystorePathEnvironment, "Android keystore path", secrets);
			environment.ZVIBE_ANDROID_STORE_PASSWORD = environmentValue(configuration.android.signing.keystorePasswordEnvironment, "Android keystore password", secrets);
			environment.ZVIBE_ANDROID_KEY_ALIAS = environmentValue(configuration.android.signing.keyAliasEnvironment, "Android key alias", secrets);
			environment.ZVIBE_ANDROID_KEY_PASSWORD = environmentValue(configuration.android.signing.keyPasswordEnvironment, "Android key password", secrets);
			args.push("--init-script", signingInit);
		}
		return { commands: [{ executable: wrapper, args, safeArgs: [...args], cwd: nativeDirectory, environment: { ...environment } }], secrets, cleanupPaths };
	}
	if (plan.operation === "package" && plan.target === "ios") {
		const workspace = await containedExistingPath(directory, configuration.ios.workspace, "iOS workspace");
		const archive = await containedOutputPath(directory, configuration.ios.archivePath, "iOS archivePath", false);
		const exportDirectory = await containedOutputPath(directory, configuration.ios.exportDirectory, "iOS exportDirectory", true);
		const temporaryDirectory = await containedOutputPath(directory, `.zvibe/mobile/jobs/${jobId}`, "Mobile temporary job directory", true);
		const exportOptions = join(temporaryDirectory, "ExportOptions.plist");
		const signingStyle = configuration.ios.signing.enabled ? "manual" : "automatic";
		await writeFile(
			exportOptions,
			`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>method</key><string>${xmlEscape(configuration.ios.exportMethod)}</string><key>signingStyle</key><string>${signingStyle}</string></dict></plist>\n`,
			"utf8"
		);
		cleanupPaths.push(temporaryDirectory);
		const archiveArgs = [
			"archive",
			"-workspace",
			workspace,
			"-scheme",
			configuration.ios.scheme,
			"-configuration",
			configuration.ios.variant === "debug" ? "Debug" : "Release",
			"-archivePath",
			archive,
		];
		const safeArchiveArgs = [...archiveArgs];
		if (configuration.ios.signing.enabled) {
			const team = environmentValue(configuration.ios.signing.teamIdEnvironment, "iOS team id", secrets);
			const identity = environmentValue(configuration.ios.signing.identityEnvironment, "iOS signing identity", secrets);
			archiveArgs.push(`DEVELOPMENT_TEAM=${team}`, `CODE_SIGN_IDENTITY=${identity}`);
			safeArchiveArgs.push("DEVELOPMENT_TEAM=[REDACTED]", "CODE_SIGN_IDENTITY=[REDACTED]");
		}
		return {
			commands: [
				command("xcodebuild", archiveArgs, safeArchiveArgs),
				command("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", exportDirectory, "-exportOptionsPlist", exportOptions]),
			],
			secrets,
			cleanupPaths,
		};
	}
	if (plan.operation === "install") {
		const artifact = await containedExistingPath(directory, plan.artifact!.path, "Mobile artifact");
		return {
			commands: [
				plan.target === "android"
					? command("adb", ["-s", plan.deviceId!, "install", "-r", artifact])
					: command("xcrun", ["devicectl", "device", "install", "app", "--device", plan.deviceId!, artifact]),
			],
			secrets,
			cleanupPaths,
		};
	}
	if (plan.operation === "launch") {
		return {
			commands: [
				plan.target === "android"
					? command("adb", ["-s", plan.deviceId!, "shell", "am", "start", "-n", `${configuration.android.applicationId}/${configuration.android.launchActivity}`])
					: command("xcrun", ["devicectl", "device", "process", "launch", "--device", plan.deviceId!, configuration.ios.applicationId]),
			],
			secrets,
			cleanupPaths,
		};
	}
	if (plan.operation === "logs") {
		return {
			commands: [
				plan.target === "android"
					? command("adb", ["-s", plan.deviceId!, "logcat", "-v", "threadtime"])
					: command("xcrun", ["devicectl", "device", "process", "launch", "--console", "--device", plan.deviceId!, configuration.ios.applicationId]),
			],
			secrets,
			cleanupPaths,
		};
	}
	const artifact = await containedExistingPath(directory, plan.artifact!.path, "Mobile artifact");
	if (plan.target === "android") {
		const credentials = environmentValue(configuration.android.store.credentialPathEnvironment, "Google Play credential path", secrets);
		const artifactFlag = plan.artifact!.extension === ".aab" ? "--aab" : "--apk";
		const args = [
			"supply",
			artifactFlag,
			artifact,
			"--package_name",
			configuration.android.applicationId,
			"--json_key",
			credentials,
			"--track",
			configuration.android.store.track,
			"--release_status",
			configuration.android.store.releaseStatus,
			"--skip_upload_metadata",
			"true",
			"--skip_upload_images",
			"true",
			"--skip_upload_screenshots",
			"true",
		];
		const safeArgs = args.map((value, index) => (args[index - 1] === "--json_key" ? "[REDACTED]" : value));
		return { commands: [command("fastlane", args, safeArgs)], secrets, cleanupPaths };
	}
	const apiKeyPath = environmentValue(configuration.ios.store.apiKeyPathEnvironment, "App Store Connect API key path", secrets);
	const args = [
		"deliver",
		"--ipa",
		artifact,
		"--api_key_path",
		apiKeyPath,
		"--skip_metadata",
		"true",
		"--skip_screenshots",
		"true",
		"--submit_for_review",
		String(configuration.ios.store.submitForReview),
	];
	const safeArgs = args.map((value, index) => (args[index - 1] === "--api_key_path" ? "[REDACTED]" : value));
	return { commands: [command("fastlane", args, safeArgs)], secrets, cleanupPaths };
}

async function waitForChild(job: IMobileJob, command: IMobileCommand, durationSeconds?: number): Promise<number | null> {
	return new Promise<number | null>((resolveExit, reject) => {
		const child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.environment, stdio: ["ignore", "pipe", "pipe"], shell: false });
		job.child = child;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		const onData = (chunk: Buffer | string): void => {
			job.outputTail = cleanOutput(job, chunk.toString());
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", reject);
		child.once("exit", (code) => {
			if (timer) {
				clearTimeout(timer);
			}
			if (forceTimer) {
				clearTimeout(forceTimer);
			}
			resolveExit(code);
		});
		if (durationSeconds) {
			timer = setTimeout(() => {
				job.timedCompletion = true;
				child.kill("SIGTERM");
				forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			}, durationSeconds * 1_000);
		}
	});
}

function cancellationRequested(job: IMobileJob): boolean {
	return job.status === "canceling" || job.status === "canceled";
}

async function runJob(job: IMobileJob, options: IMCPActionOptions): Promise<void> {
	job.status = "running";
	job.startedAt = new Date().toISOString();
	activeJobs.add(job);
	try {
		for (let index = 0; index < job.commands.length; index++) {
			job.commandIndex = index;
			const exitCode = await waitForChild(job, job.commands[index], job.operation === "logs" ? job.durationSeconds : undefined);
			job.exitCode = exitCode;
			job.child = undefined;
			if (cancellationRequested(job)) {
				job.status = "canceled";
				return;
			}
			if (exitCode !== 0 && !job.timedCompletion) {
				throw new Error(`Mobile ${job.operation} command ${index + 1} exited with code ${String(exitCode)}.`);
			}
		}
		if (job.operation === "package") {
			const baseline = new Map(job.baselineArtifacts.map((artifact) => [artifact.path, artifact]));
			job.artifacts = (await scanArtifacts(projectDirectory(options), job.target)).filter((artifact) => {
				const previous = baseline.get(artifact.path);
				return artifact.extension === job.expectedArtifactExtension && (!previous || previous.sha256 !== artifact.sha256 || previous.modifiedAt !== artifact.modifiedAt);
			});
			if (!job.artifacts.length) {
				throw new Error(`Mobile package completed without producing a new or changed ${job.expectedArtifactExtension} artifact.`);
			}
		}
		job.status = "succeeded";
	} catch (error) {
		if (!cancellationRequested(job)) {
			job.status = "failed";
			job.error = error instanceof Error ? error.message : String(error);
		}
	} finally {
		job.child = undefined;
		job.completedAt = new Date().toISOString();
		activeJobs.delete(job);
		for (const path of job.cleanupPaths) {
			await remove(path).catch(() => undefined);
		}
		job.commands = job.commands.map((command) => ({ ...command, args: [...command.safeArgs], environment: {} }));
		job.secretValues = [];
		(options.editor.layout as any).mobile?.forceUpdate?.();
	}
}

/** Lists portable operations, external tool dependencies, and explicit vendor boundaries. */
export function getMobileCapabilities(): object {
	return {
		version: 1,
		mcpToolCount: 38,
		targets: ["android", "ios"],
		touchControls: ["button", "fixed-center-stick", "safe-area-layout", "Input-Actions-path-binding", "multi-pointer"],
		adaptivePerformance: {
			providers: ["basic", "apple"],
			appleTargets: ["ios", "tvos", "visionos"],
			scalers: ["render-scale", "lod-quality", "shadow-quality", "view-distance", "post-process", "particles"],
			hardwareBoundary: "Apple provider evidence requires the generated Swift bridge compiled into the native host.",
		},
		mobileSystem: {
			androidWindowInsets: ["visibility-policy", "system-bars-behavior", "native-events", "css-safe-area-fallback"],
			iosThermalFrameRate: { enabledByDefault: true, seriousFps: 30, criticalFps: 15 },
			visionOSMinimumTargetVersion: true,
		},
		grpcTransport: { protocols: ["grpc-web-binary", "grpc-web-text", "connect"], calls: ["unary", "server-streaming"], responseTrailers: true },
		workflows: ["package", "environment-only-signing", "list-devices", "install", "launch", "bounded-logs", "store-submit"],
		android: {
			packages: ["apk", "aab"],
			tools: ["Capacitor", "Gradle wrapper", "Android SDK", "adb", "Fastlane supply"],
			buildProfile: ["project-native-none-thin-full-lto", "xr-thinlto-adapter", "android-trace-initialization-markers"],
		},
		ios: { packages: ["xcarchive", "ipa"], tools: ["Capacitor", "Xcode/xcodebuild", "xcrun devicectl", "Fastlane deliver"], host: "darwin" },
		security: ["exact expiring plans", "confirmation", "project path containment", "no shell", "environment references only", "redacted bounded output"],
		boundaries: ["vendor SDK installation", "developer certificates/profiles", "store accounts/agreements", "hardware access", "store review outcome"],
	};
}

/** Audits one target for scaffold, native-project, command, credential-reference, and operation readiness. */
export async function validateMobileTarget(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(data, ["target", "endpoint", "collaborationToken"], "validate_mobile_target input");
	if (data.target !== "android" && data.target !== "ios") {
		throw new Error("Mobile target must be android or ios.");
	}
	const target = data.target;
	const directory = projectDirectory(options);
	const configuration = getMobileDeploymentConfiguration(scene, options);
	validateMobileDeploymentConfiguration(configuration);
	const [diagnostics, scaffold, adb, xcodebuild, xcrun, fastlane] = await Promise.all([
		getPlatformDiagnostics(scene, { target }, options),
		getPlatformScaffold(scene, { target }, options),
		commandAvailable("adb"),
		commandAvailable("xcodebuild"),
		commandAvailable("xcrun"),
		commandAvailable("fastlane"),
	]);
	const nativePath = target === "android" ? ".zvibe/platforms/android/android" : configuration.ios.workspace;
	const nativeProject = await pathExists(resolve(directory, nativePath));
	const signing = target === "android" ? configuration.android.signing : configuration.ios.signing;
	const store = target === "android" ? configuration.android.store.credentialPathEnvironment : configuration.ios.store.apiKeyPathEnvironment;
	const signingEntries = Object.entries(signing).filter((entry): entry is [string, string] => entry[0] !== "enabled" && typeof entry[1] === "string");
	const environment = Object.fromEntries(
		[...signingEntries, [target === "android" ? "credentialPathEnvironment" : "apiKeyPathEnvironment", store]]
			.filter((entry): entry is [string, string] => entry[0] !== "enabled" && typeof entry[1] === "string")
			.map(([name, reference]) => [name, { reference, defined: Boolean(process.env[reference]) }])
	);
	const signingReady = signing.enabled !== true || signingEntries.every(([, reference]) => Boolean(process.env[reference]));
	const packageToolReady =
		target === "android"
			? nativeProject && (await pathExists(resolve(directory, nativePath, process.platform === "win32" ? "gradlew.bat" : "gradlew")))
			: process.platform === "darwin" && xcodebuild;
	const androidBuildPlan = target === "android" ? await readAndroidBuildPlan(directory) : null;
	return {
		target,
		configurationRevision: configuration.revision,
		configuration: structuredClone(target === "android" ? configuration.android : configuration.ios),
		platform: diagnostics.diagnostics[0],
		scaffold,
		nativeProject: { path: nativePath, exists: nativeProject },
		commands: { adb, xcodebuild, xcrun, fastlane },
		environment,
		androidBuildPlan,
		ready: {
			package: Boolean(scaffold.exists && scaffold.integrity && packageToolReady && signingReady),
			device: target === "android" ? adb : process.platform === "darwin" && xcrun,
			store: fastlane && Boolean(store && process.env[store]),
		},
	};
}

/** Creates a one-time ten-minute plan bound to exact authored/scaffold/artifact state. */
export async function planMobileWorkflow(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(
		data,
		["target", "operation", "expectedRevision", "expectedScaffoldRevision", "artifactPath", "deviceId", "durationSeconds", "endpoint", "collaborationToken"],
		"plan_mobile_workflow input"
	);
	if (data.target !== "android" && data.target !== "ios") {
		throw new Error("Mobile target must be android or ios.");
	}
	if (!supportedOperations.has(data.operation as MobileWorkflowOperation)) {
		throw new Error("Mobile operation must be package, install, launch, logs, or submit.");
	}
	const target = data.target;
	const operation = data.operation as MobileWorkflowOperation;
	const configuration = getMobileDeploymentConfiguration(scene, options);
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== configuration.revision) {
		throw new Error(`Mobile Deployment revision is stale: expected ${String(data.expectedRevision)}, current ${configuration.revision}.`);
	}
	const scaffold = await getPlatformScaffold(scene, { target }, options);
	if (!scaffold.exists || scaffold.integrity !== true) {
		throw new Error(`The ${target} scaffold must exist with complete generated-file integrity.`);
	}
	if (!Number.isSafeInteger(data.expectedScaffoldRevision) || data.expectedScaffoldRevision !== scaffold.revision) {
		throw new Error(`${target} scaffold revision is stale: expected ${String(data.expectedScaffoldRevision)}, current ${scaffold.revision}.`);
	}
	const requiresArtifact = operation === "install" || operation === "submit";
	const requiresDevice = operation === "install" || operation === "launch" || operation === "logs";
	if (requiresArtifact !== (typeof data.artifactPath === "string" && Boolean(data.artifactPath.trim()))) {
		throw new Error(`${operation} ${requiresArtifact ? "requires" : "does not accept"} artifactPath.`);
	}
	if (requiresDevice !== (typeof data.deviceId === "string" && Boolean(data.deviceId.trim()))) {
		throw new Error(`${operation} ${requiresDevice ? "requires" : "does not accept"} deviceId.`);
	}
	if (requiresDevice && !deviceIdPattern.test(data.deviceId as string)) {
		throw new Error("Mobile deviceId contains unsupported characters or exceeds 256 characters.");
	}
	if (operation === "logs" && (!Number.isSafeInteger(data.durationSeconds ?? 60) || Number(data.durationSeconds ?? 60) < 1 || Number(data.durationSeconds ?? 60) > 3_600)) {
		throw new Error("Mobile log durationSeconds must be an integer from 1 through 3600.");
	}
	if (operation !== "logs" && data.durationSeconds !== undefined) {
		throw new Error(`${operation} does not accept durationSeconds.`);
	}
	const directory = projectDirectory(options);
	if (operation === "package") {
		if (target === "android") {
			await containedExistingPath(directory, ".zvibe/platforms/android/android", "Android native project");
			await containedExistingPath(directory, `.zvibe/platforms/android/android/${process.platform === "win32" ? "gradlew.bat" : "gradlew"}`, "Android Gradle wrapper");
			if (configuration.android.signing.enabled) {
				for (const [label, reference] of Object.entries(configuration.android.signing).filter(
					(entry): entry is [string, string] => entry[0] !== "enabled" && typeof entry[1] === "string"
				)) {
					if (!process.env[reference]) {
						throw new Error(`Android signing ${label} environment variable is not defined: ${reference}`);
					}
				}
			}
		} else {
			if (process.platform !== "darwin" || !(await commandAvailable("xcodebuild"))) {
				throw new Error("iOS packaging requires macOS and xcodebuild.");
			}
			await containedExistingPath(directory, configuration.ios.workspace, "iOS workspace");
			if (configuration.ios.signing.enabled) {
				for (const [label, reference] of Object.entries(configuration.ios.signing).filter(
					(entry): entry is [string, string] => entry[0] !== "enabled" && typeof entry[1] === "string"
				)) {
					if (!process.env[reference]) {
						throw new Error(`iOS signing ${label} environment variable is not defined: ${reference}`);
					}
				}
			}
		}
	} else if (["install", "launch", "logs"].includes(operation) && !(await commandAvailable(target === "android" ? "adb" : "xcrun"))) {
		throw new Error(`${operation} requires ${target === "android" ? "adb" : "xcrun"} on PATH.`);
	} else if (operation === "submit") {
		if (!(await commandAvailable("fastlane"))) {
			throw new Error("Store submission requires fastlane on PATH.");
		}
		const reference = target === "android" ? configuration.android.store.credentialPathEnvironment : configuration.ios.store.apiKeyPathEnvironment;
		if (!reference || !process.env[reference]) {
			throw new Error(`${target} store credential environment variable is not configured or defined.`);
		}
	}
	const artifact = requiresArtifact ? await artifactFromPath(directory, data.artifactPath as string, target) : undefined;
	const androidBuildPlan = target === "android" && operation === "package" ? await readAndroidBuildPlan(directory) : undefined;
	const now = Date.now();
	const plan: IMobileWorkflowPlan = {
		id: randomId("mobile-plan"),
		target,
		operation,
		configurationRevision: configuration.revision,
		scaffoldRevision: scaffold.revision,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 10 * 60_000).toISOString(),
		artifact,
		deviceId: requiresDevice ? (data.deviceId as string) : undefined,
		durationSeconds: operation === "logs" ? Number(data.durationSeconds ?? 60) : undefined,
		warnings: [
			"Execution invokes installed vendor tools and can change native projects, connected devices, or store state.",
			...(target === "android" && operation === "package" && !androidBuildPlan
				? ["No exact Android Build Profile plan exists. Build the Android profile before packaging to apply project-native LTO and initialization-marker policy."]
				: []),
			...(androidBuildPlan && androidBuildPlan.settings.linkTimeOptimization !== "none"
				? ["Android LTO applies only to project externalNativeBuild/CMake inputs; prebuilt engine, browser, Capacitor, XR, and vendor libraries are not recompiled."]
				: []),
		],
		...(target === "android" && operation === "package" ? { androidBuildPlan } : {}),
	};
	const store = planStore(scene);
	store.set(plan.id, plan);
	for (const candidate of store.values()) {
		if (Date.parse(candidate.expiresAt) <= now || store.size > 64) {
			store.delete(candidate.id);
		}
	}
	return publicPlan(plan);
}

/** Reads one plan while rejecting expired tokens. */
export function getMobileWorkflowPlan(scene: Scene, data: unknown): object {
	assertRecord(data, ["planId", "endpoint", "collaborationToken"], "get_mobile_workflow_plan input");
	if (typeof data.planId !== "string" || !data.planId) {
		throw new Error("Mobile workflow planId must be a non-empty string.");
	}
	const plan = typeof data.planId === "string" ? planStore(scene).get(data.planId) : undefined;
	if (!plan) {
		throw new Error("Mobile workflow plan was not found.");
	}
	if (Date.parse(plan.expiresAt) <= Date.now()) {
		planStore(scene).delete(plan.id);
		throw new Error("Mobile workflow plan expired; create a fresh exact-state plan.");
	}
	return publicPlan(plan);
}

/** Consumes one exact plan and starts a bounded asynchronous native-tool job. */
export async function executeMobileWorkflowPlan(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(data, ["planId", "confirm", "endpoint", "collaborationToken"], "execute_mobile_workflow_plan input");
	if (data.confirm !== true) {
		throw new Error("Executing a Mobile workflow plan requires confirm=true.");
	}
	const plan = getMobileWorkflowPlan(scene, { planId: data.planId }) as IMobileWorkflowPlan;
	const configuration = getMobileDeploymentConfiguration(scene, options);
	if (configuration.revision !== plan.configurationRevision) {
		throw new Error(`Mobile workflow plan is stale against configuration revision ${configuration.revision}.`);
	}
	const scaffold = await getPlatformScaffold(scene, { target: plan.target }, options);
	if (!scaffold.exists || scaffold.integrity !== true || scaffold.revision !== plan.scaffoldRevision) {
		throw new Error("Mobile workflow plan is stale against the current scaffold or generated-file integrity.");
	}
	if (plan.target === "android" && plan.operation === "package") {
		const currentBuildPlan = await readAndroidBuildPlan(projectDirectory(options));
		if (currentBuildPlan?.sha256 !== plan.androidBuildPlan?.sha256) {
			throw new Error("Mobile workflow plan is stale because the Android Build Profile plan changed; create a fresh package plan.");
		}
	}
	if (plan.artifact) {
		const current = await artifactFromPath(projectDirectory(options), plan.artifact.path, plan.target);
		if (current.sha256 !== plan.artifact.sha256 || current.sizeBytes !== plan.artifact.sizeBytes) {
			throw new Error("Mobile workflow plan is stale because the selected artifact changed.");
		}
	}
	if ([...jobStore(scene).values()].some((job) => job.target === plan.target && ["queued", "running", "canceling"].includes(job.status))) {
		throw new Error(`A ${plan.target} Mobile workflow job is already active.`);
	}
	const id = randomId("mobile-job");
	planStore(scene).delete(plan.id);
	let prepared: Awaited<ReturnType<typeof commandsForPlan>>;
	let baselineArtifacts: IMobileArtifact[];
	try {
		prepared = await commandsForPlan(plan, configuration, options, id);
		baselineArtifacts = plan.operation === "package" ? await scanArtifacts(projectDirectory(options), plan.target) : [];
	} catch (error) {
		await remove(join(projectDirectory(options), ".zvibe/mobile/jobs", id)).catch(() => undefined);
		throw error;
	}
	const job: IMobileJob = {
		id,
		planId: plan.id,
		target: plan.target,
		operation: plan.operation,
		status: "queued",
		createdAt: new Date().toISOString(),
		commandIndex: 0,
		commands: prepared.commands,
		outputTail: "",
		artifacts: [],
		baselineArtifacts,
		expectedArtifactExtension: plan.operation === "package" ? (plan.target === "ios" ? ".ipa" : configuration.android.format === "aab" ? ".aab" : ".apk") : undefined,
		secretValues: prepared.secrets,
		cleanupPaths: prepared.cleanupPaths,
		durationSeconds: plan.durationSeconds,
		timedCompletion: false,
	};
	const store = jobStore(scene);
	store.set(job.id, job);
	for (const candidate of store.values()) {
		if (store.size <= 32) {
			break;
		}
		if (!["queued", "running", "canceling"].includes(candidate.status)) {
			store.delete(candidate.id);
		}
	}
	void runJob(job, options);
	return publicJob(job);
}

/** Reads one retained job with redacted commands/output. */
export function getMobileJob(scene: Scene, data: unknown): object {
	assertRecord(data, ["jobId", "endpoint", "collaborationToken"], "get_mobile_job input");
	const job = typeof data.jobId === "string" ? jobStore(scene).get(data.jobId) : undefined;
	if (!job) {
		throw new Error("Mobile workflow job was not found.");
	}
	return publicJob(job);
}

/** Lists bounded retained jobs with offset pagination. */
export function listMobileJobs(scene: Scene, data: unknown = {}): object {
	assertRecord(data, ["target", "status", "offset", "limit", "endpoint", "collaborationToken"], "list_mobile_jobs input");
	if (data.target !== undefined && data.target !== "android" && data.target !== "ios") {
		throw new Error("Mobile job target must be android or ios.");
	}
	if (data.status !== undefined && !["queued", "running", "succeeded", "failed", "canceling", "canceled"].includes(data.status as string)) {
		throw new Error("Mobile job status is invalid.");
	}
	const offset = Number.isSafeInteger(data.offset) && Number(data.offset) >= 0 ? Number(data.offset) : 0;
	const limit = Number.isSafeInteger(data.limit) && Number(data.limit) >= 1 && Number(data.limit) <= 100 ? Number(data.limit) : 25;
	let values = [...jobStore(scene).values()];
	if (data.target === "android" || data.target === "ios") {
		values = values.filter((job) => job.target === data.target);
	}
	if (typeof data.status === "string") {
		values = values.filter((job) => job.status === data.status);
	}
	values.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	return {
		total: values.length,
		count: values.slice(offset, offset + limit).length,
		offset,
		jobs: values.slice(offset, offset + limit).map(publicJob),
		hasMore: offset + limit < values.length,
		nextOffset: offset + limit < values.length ? offset + limit : null,
	};
}

/** Cancels one active native-tool child process and retains its final redacted evidence. */
export function cancelMobileJob(scene: Scene, data: unknown): object {
	assertRecord(data, ["jobId", "confirm", "endpoint", "collaborationToken"], "cancel_mobile_job input");
	if (data.confirm !== true) {
		throw new Error("Canceling a Mobile workflow job requires confirm=true.");
	}
	const job = typeof data.jobId === "string" ? jobStore(scene).get(data.jobId) : undefined;
	if (!job) {
		throw new Error("Mobile workflow job was not found.");
	}
	if (!["queued", "running", "canceling"].includes(job.status)) {
		return { canceled: false, reason: "already-finished", job: publicJob(job) };
	}
	job.status = "canceling";
	if (job.child) {
		job.child.kill("SIGTERM");
		setTimeout(() => job.child?.kill("SIGKILL"), 2_000);
	} else {
		job.status = "canceled";
		job.completedAt = new Date().toISOString();
	}
	return { canceled: true, job: publicJob(job) };
}

/** Lists hash-verified native artifacts without following links. */
export async function listMobileArtifacts(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(data, ["target", "offset", "limit", "endpoint", "collaborationToken"], "list_mobile_artifacts input");
	if (data.target !== undefined && data.target !== "android" && data.target !== "ios") {
		throw new Error("Mobile artifact target must be android or ios.");
	}
	const offset = Number.isSafeInteger(data.offset) && Number(data.offset) >= 0 ? Number(data.offset) : 0;
	const limit = Number.isSafeInteger(data.limit) && Number(data.limit) >= 1 && Number(data.limit) <= 100 ? Number(data.limit) : 25;
	const values = await scanArtifacts(projectDirectory(options), data.target as MobileTarget | undefined);
	return {
		total: values.length,
		count: values.slice(offset, offset + limit).length,
		offset,
		artifacts: values.slice(offset, offset + limit),
		hasMore: offset + limit < values.length,
		nextOffset: offset + limit < values.length ? offset + limit : null,
	};
}

function parseAndroidDevices(output: string): object[] {
	return output
		.split(/\r?\n/)
		.slice(1)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 256)
		.map((line) => {
			const [id, state, ...details] = line.split(/\s+/);
			return {
				id,
				state,
				platform: "android",
				details: Object.fromEntries(details.filter((entry) => entry.includes(":")).map((entry) => entry.split(/:(.*)/s).slice(0, 2))),
			};
		});
}

function parseIosDevices(output: string): object[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /\([0-9A-Fa-f-]{8,}\)$/.test(line))
		.slice(0, 256)
		.map((line) => {
			const match = line.match(/^(.*?)\s+\(([^()]*)\)\s+\(([0-9A-Fa-f-]+)\)$/);
			return match ? { id: match[3], name: match[1], os: match[2], state: "available", platform: "ios" } : { id: line, state: "unknown", platform: "ios" };
		});
}

/** Queries installed Android/iOS vendor tools for connected physical/simulated devices. */
export async function listMobileDevices(_scene: Scene, data: unknown): Promise<object> {
	assertRecord(data, ["target", "offset", "limit", "endpoint", "collaborationToken"], "list_mobile_devices input");
	if (data.target !== "android" && data.target !== "ios") {
		throw new Error("Mobile device target must be android or ios.");
	}
	const offset = Number.isSafeInteger(data.offset) && Number(data.offset) >= 0 ? Number(data.offset) : 0;
	const limit = Number.isSafeInteger(data.limit) && Number(data.limit) >= 1 && Number(data.limit) <= 100 ? Number(data.limit) : 25;
	const executable = data.target === "android" ? "adb" : "xcrun";
	const args = data.target === "android" ? ["devices", "-l"] : ["xctrace", "list", "devices"];
	let output: string;
	try {
		output = String((await execFileAsync(executable, args, { timeout: 10_000, maxBuffer: 1_048_576 })).stdout);
	} catch (error) {
		throw new Error(`Could not list ${data.target} devices through ${executable}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const values = data.target === "android" ? parseAndroidDevices(output) : parseIosDevices(output);
	return {
		target: data.target,
		total: values.length,
		count: values.slice(offset, offset + limit).length,
		offset,
		devices: values.slice(offset, offset + limit),
		hasMore: offset + limit < values.length,
		nextOffset: offset + limit < values.length ? offset + limit : null,
	};
}

/** Stops every transient child and drops expiring plans during editor reload/shutdown. */
export async function shutdownMobileWorkflows(): Promise<void> {
	for (const job of [...activeJobs]) {
		job.status = "canceling";
		job.child?.kill("SIGTERM");
		setTimeout(() => job.child?.kill("SIGKILL"), 1_000);
	}
	const deadline = Date.now() + 5_000;
	while (activeJobs.size && Date.now() < deadline) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
}
