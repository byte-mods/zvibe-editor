import { ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { ensureDir, lstat, pathExists, readFile, readdir, remove, writeFile, writeJSON } from "fs-extra";
import { Scene } from "babylonjs";
import stripAnsi from "strip-ansi";

import { IMCPActionOptions } from "../action";
import { listBuildProfiles } from "../project/export";
import { getPlatformScaffold } from "../project/platforms";
import { getConsoleServerConfiguration } from "./configuration";
import { IConsoleServerConfiguration, validateConsoleServerConfiguration } from "./model";

export type ConsoleServerOperation = "build" | "validate" | "container-build" | "deploy" | "scale" | "restart" | "stop" | "logs" | "profile" | "certify";
export type ConsoleServerJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceling" | "canceled";

interface IProviderOperation {
	executable: string;
	args: string[];
}

interface IConsoleProviderManifest {
	version: 1;
	id: string;
	name: string;
	vendor: string;
	platforms: string[];
	hostPlatforms: Array<"darwin" | "win32" | "linux">;
	credentialEnvironments: string[];
	operations: Partial<Record<ConsoleServerOperation, IProviderOperation>>;
	path: string;
	fingerprint: string;
}

interface IDeploymentArtifactsManifest {
	version: 1;
	revision: number;
	configurationRevision: number;
	scaffoldRevision: number;
	createdAt: string;
	updatedAt: string;
	files: Array<{ path: string; sha256: string }>;
}

interface IConsoleServerPlan {
	id: string;
	operation: ConsoleServerOperation;
	provider: IConsoleServerConfiguration["deployment"]["provider"];
	configurationRevision: number;
	scaffoldRevision: number;
	artifactsRevision: number;
	providerFingerprint: string | null;
	createdAt: string;
	expiresAt: string;
	durationSeconds?: number;
	warnings: string[];
}

interface IServerCommand {
	executable: string;
	args: string[];
	cwd: string;
	environment: NodeJS.ProcessEnv;
}

interface IConsoleServerJob {
	id: string;
	planId: string;
	operation: ConsoleServerOperation;
	provider: IConsoleServerPlan["provider"];
	status: ConsoleServerJobStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	commandIndex: number;
	commands: IServerCommand[];
	outputTail: string;
	exitCode?: number | null;
	error?: string;
	child?: ChildProcess;
	secretValues: string[];
	durationSeconds?: number;
}

interface IServerInstance {
	id: string;
	provider: IConsoleServerPlan["provider"];
	state: "starting" | "running" | "stopping" | "stopped" | "failed" | "external";
	createdAt: string;
	updatedAt: string;
	endpoint: string | null;
	jobId: string;
	outputTail: string;
	child?: ChildProcess;
}

const execFileAsync = promisify(execFile);
const environmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const executablePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const placeholderPattern = /\$\{(PROJECT|OUTPUT|IMAGE|NAMESPACE|REPLICAS|PORT|JOB_ID)\}/g;
const plansByScene = new WeakMap<Scene, Map<string, IConsoleServerPlan>>();
const jobsByScene = new WeakMap<Scene, Map<string, IConsoleServerJob>>();
const instancesByScene = new WeakMap<Scene, Map<string, IServerInstance>>();
const activeJobs = new Set<IConsoleServerJob>();
const activeInstances = new Set<IServerInstance>();

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

function randomId(prefix: string): string {
	return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function plans(scene: Scene): Map<string, IConsoleServerPlan> {
	let result = plansByScene.get(scene);
	if (!result) {
		result = new Map();
		plansByScene.set(scene, result);
	}
	return result;
}

function jobs(scene: Scene): Map<string, IConsoleServerJob> {
	let result = jobsByScene.get(scene);
	if (!result) {
		result = new Map();
		jobsByScene.set(scene, result);
	}
	return result;
}

function instances(scene: Scene): Map<string, IServerInstance> {
	let result = instancesByScene.get(scene);
	if (!result) {
		result = new Map();
		instancesByScene.set(scene, result);
	}
	return result;
}

function cleanText(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
			result += value[index];
		}
	}
	return stripAnsi(result);
}

function appendOutput(job: IConsoleServerJob, value: string): void {
	let result = cleanText(value);
	for (const secret of job.secretValues.filter(Boolean)) {
		result = result.replaceAll(secret, "[REDACTED]");
	}
	job.outputTail = `${job.outputTail}${result}`.slice(-65_536);
}

function publicPlan(value: IConsoleServerPlan): object {
	return structuredClone(value);
}

function publicCommand(value: IServerCommand): object {
	return { executable: value.executable, args: [...value.args], cwd: value.cwd };
}

function publicJob(value: IConsoleServerJob): object {
	return {
		id: value.id,
		planId: value.planId,
		operation: value.operation,
		provider: value.provider,
		status: value.status,
		createdAt: value.createdAt,
		startedAt: value.startedAt,
		completedAt: value.completedAt,
		commandIndex: value.commandIndex,
		commands: value.commands.map(publicCommand),
		outputTail: value.outputTail,
		exitCode: value.exitCode,
		error: value.error,
	};
}

function publicInstance(value: IServerInstance): object {
	return {
		id: value.id,
		provider: value.provider,
		state: value.state,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		endpoint: value.endpoint,
		jobId: value.jobId,
		outputTail: value.outputTail,
	};
}

async function commandAvailable(command: string): Promise<boolean> {
	try {
		await execFileAsync(process.platform === "win32" ? "where" : "which", [command], { timeout: 2_000 });
		return true;
	} catch {
		return false;
	}
}

function providerDirectory(root: string): string {
	return join(root, ".zvibe", "console-providers");
}

function validateProviderArg(value: unknown): string {
	if (typeof value !== "string" || !value.length || value.length > 512 || /[\0\r\n]/.test(value)) {
		throw new Error("Console provider arguments must be bounded single-line strings.");
	}
	const withoutKnown = value.replace(placeholderPattern, "");
	if (/\$\{/.test(withoutKnown)) {
		throw new Error("Console provider arguments contain an unsupported placeholder.");
	}
	return value;
}

function normalizeProvider(value: unknown, path: string, content: string): IConsoleProviderManifest {
	assertRecord(value, ["version", "id", "name", "vendor", "platforms", "hostPlatforms", "credentialEnvironments", "operations"], "Console provider manifest");
	if (value.version !== 1 || typeof value.id !== "string" || !identifierPattern.test(value.id)) {
		throw new Error("Console provider version/id is invalid.");
	}
	if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || typeof value.vendor !== "string" || !value.vendor.trim() || value.vendor.length > 128) {
		throw new Error("Console provider name/vendor is invalid.");
	}
	if (
		!Array.isArray(value.platforms) ||
		!value.platforms.length ||
		value.platforms.length > 16 ||
		value.platforms.some((entry) => typeof entry !== "string" || !identifierPattern.test(entry))
	) {
		throw new Error("Console provider platforms must contain 1-16 safe identifiers.");
	}
	if (!Array.isArray(value.hostPlatforms) || value.hostPlatforms.some((entry) => !["darwin", "win32", "linux"].includes(String(entry)))) {
		throw new Error("Console provider hostPlatforms is invalid.");
	}
	if (
		!Array.isArray(value.credentialEnvironments) ||
		value.credentialEnvironments.length > 32 ||
		value.credentialEnvironments.some((entry) => typeof entry !== "string" || !environmentPattern.test(entry))
	) {
		throw new Error("Console provider credentialEnvironments must contain environment-variable names only.");
	}
	assertRecord(value.operations, ["build", "validate", "container-build", "deploy", "scale", "restart", "stop", "logs", "profile", "certify"], "Console provider operations");
	const operations: IConsoleProviderManifest["operations"] = {};
	for (const [name, raw] of Object.entries(value.operations)) {
		assertRecord(raw, ["executable", "args"], `Console provider ${name} operation`);
		if (typeof raw.executable !== "string" || !executablePattern.test(raw.executable) || basename(raw.executable) !== raw.executable) {
			throw new Error(`Console provider ${name} executable must be a command basename.`);
		}
		if (!Array.isArray(raw.args) || raw.args.length > 64) {
			throw new Error(`Console provider ${name} args must contain at most 64 entries.`);
		}
		operations[name as ConsoleServerOperation] = { executable: raw.executable, args: raw.args.map(validateProviderArg) };
	}
	return {
		version: 1,
		id: value.id,
		name: value.name.trim(),
		vendor: value.vendor.trim(),
		platforms: [...new Set(value.platforms as string[])],
		hostPlatforms: [...new Set(value.hostPlatforms as Array<"darwin" | "win32" | "linux">)],
		credentialEnvironments: [...new Set(value.credentialEnvironments as string[])],
		operations,
		path,
		fingerprint: sha256(content),
	};
}

async function readProviders(root: string): Promise<{ providers: IConsoleProviderManifest[]; errors: Array<{ path: string; error: string }> }> {
	const directory = providerDirectory(root);
	if (!(await pathExists(directory))) {
		return { providers: [], errors: [] };
	}
	const directoryPath = ".zvibe/console-providers";
	try {
		const [rootReal, directoryReal, details] = await Promise.all([realpath(root), realpath(directory), lstat(directory)]);
		if (details.isSymbolicLink() || !details.isDirectory() || (directoryReal !== rootReal && !directoryReal.startsWith(`${rootReal}${sep}`))) {
			throw new Error("Console provider directory must be a regular project-contained directory without symlinks.");
		}
	} catch (error) {
		return { providers: [], errors: [{ path: directoryPath, error: error instanceof Error ? error.message : String(error) }] };
	}
	const entries = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.name.endsWith(".json"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, 32);
	const providers: IConsoleProviderManifest[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		try {
			const [details, pathReal, rootReal] = await Promise.all([lstat(path), realpath(path), realpath(root)]);
			if (details.isSymbolicLink() || !details.isFile() || details.size > 65_536 || (pathReal !== rootReal && !pathReal.startsWith(`${rootReal}${sep}`))) {
				throw new Error("Provider manifest must be a regular JSON file no larger than 64 KiB.");
			}
			const content = await readFile(path, "utf8");
			providers.push(normalizeProvider(JSON.parse(content), `.zvibe/console-providers/${entry.name}`, content));
		} catch (error) {
			errors.push({ path: `.zvibe/console-providers/${entry.name}`, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const duplicate = providers.find((entry, index) => providers.findIndex((candidate) => candidate.id === entry.id) !== index);
	if (duplicate) {
		errors.push({ path: duplicate.path, error: `Duplicate console provider id: ${duplicate.id}.` });
	}
	return { providers: providers.filter((entry, index) => providers.findIndex((candidate) => candidate.id === entry.id) === index), errors };
}

function artifactDirectory(root: string): string {
	return join(root, ".zvibe", "server");
}

function artifactManifestPath(root: string): string {
	return join(artifactDirectory(root), "zvibe-server-deployment.json");
}

async function readArtifactManifest(root: string): Promise<IDeploymentArtifactsManifest | null> {
	const path = artifactManifestPath(root);
	if (!(await pathExists(path))) {
		return null;
	}
	const raw = JSON.parse(await readFile(path, "utf8")) as IDeploymentArtifactsManifest;
	if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !Array.isArray(raw.files)) {
		throw new Error("Server deployment artifact manifest is invalid.");
	}
	const allowed = new Set(["deployment.yaml", "server.env.example", "README.md"]);
	if (raw.files.some((entry) => !entry || !allowed.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256))) {
		throw new Error("Server deployment artifact ownership is invalid.");
	}
	return raw;
}

async function artifactStatus(root: string): Promise<any> {
	const manifest = await readArtifactManifest(root);
	if (!manifest) {
		return { exists: false, revision: 0, integrity: false, directory: ".zvibe/server" };
	}
	const files = await Promise.all(
		manifest.files.map(async (entry) => {
			const path = join(artifactDirectory(root), entry.path);
			if (!(await pathExists(path))) {
				return { ...entry, exists: false, matches: false };
			}
			const actualSha256 = sha256(await readFile(path, "utf8"));
			return { ...entry, exists: true, actualSha256, matches: actualSha256 === entry.sha256 };
		})
	);
	return { exists: true, revision: manifest.revision, integrity: files.every((entry) => entry.matches), manifest: structuredClone(manifest), files, directory: ".zvibe/server" };
}

function deploymentSources(config: IConsoleServerConfiguration): Map<string, string> {
	const name = "zvibe-game-server";
	const joinSecretKey = config.headless.joinCodeEnvironment;
	const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${config.deployment.namespace}
  labels: { app.kubernetes.io/name: ${name} }
spec:
  replicas: ${config.deployment.replicas}
  selector: { matchLabels: { app.kubernetes.io/name: ${name} } }
  template:
    metadata: { labels: { app.kubernetes.io/name: ${name} } }
    spec:
      containers:
        - name: server
          image: ${config.container.image}
          imagePullPolicy: IfNotPresent
          ports: [{ name: gameplay, containerPort: 7777 }]
          env:
            - name: HOST
              value: "0.0.0.0"
            - name: PORT
              value: "7777"
            - name: ZVIBE_SERVER_MAXIMUM_PLAYERS
              value: "${config.headless.maximumPlayers}"
            - name: ZVIBE_SERVER_JOIN_CODE
              valueFrom: { secretKeyRef: { name: zvibe-server-secrets, key: ${joinSecretKey} } }
          readinessProbe: { httpGet: { path: /health, port: gameplay }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /health, port: gameplay }, periodSeconds: 15 }
          resources:
            requests: { cpu: "250m", memory: "256Mi" }
            limits: { cpu: "2", memory: "2Gi" }
---
apiVersion: v1
kind: Service
metadata: { name: ${name}, namespace: ${config.deployment.namespace} }
spec:
  selector: { app.kubernetes.io/name: ${name} }
  ports: [{ name: gameplay, port: ${config.headless.port}, targetPort: gameplay }]
  type: ClusterIP
`;
	const env = `# Values are examples or environment references. Never commit real credentials.
HOST=0.0.0.0
PORT=${config.headless.port}
ZVIBE_SERVER_MAXIMUM_PLAYERS=${config.headless.maximumPlayers}
${config.headless.joinCodeEnvironment}=REPLACE_WITH_6_TO_12_UPPERCASE_CHARACTERS
`;
	const readme = `# Zvibe production server deployment

Generated from Console & Server configuration revision ${config.revision}. Build \`dist/headless\` first. The container image runs the exported Babylon NullEngine scene plus the server-authoritative WebSocket host on \`/session\`; health and metrics are exposed at \`${config.headless.healthPath}\` and \`${config.headless.metricsPath}\`.

The Kubernetes manifest references the pre-provisioned \`zvibe-server-secrets\` Secret key \`${config.headless.joinCodeEnvironment}\`. Secret values are never stored by the editor. Licensed console commands are supplied separately through strict provider manifests in \`.zvibe/console-providers\`.
`;
	return new Map([
		["deployment.yaml", deployment],
		["server.env.example", env],
		["README.md", readme],
	]);
}

/** Reports the production server and licensed console-provider surface without claiming vendor SDK ownership. */
export function getConsoleServerCapabilities(): object {
	return {
		version: 1,
		mcpToolCount: 19,
		headless: {
			nullEngineSceneExecution: true,
			serverAuthoritativeWebSocket: true,
			fixedTick: true,
			healthAndMetrics: true,
			containerImage: true,
			kubernetesDeployment: true,
			fleetOperations: ["deploy", "scale", "restart", "stop", "logs", "profile"],
		},
		consoleProviders: {
			manifestVersion: 1,
			fixedNoShellCommands: true,
			environmentOnlyCredentials: true,
			operations: ["build", "deploy", "restart", "stop", "logs", "profile", "certify"],
		},
		security: [
			"exact revisions",
			"expiring single-use plans",
			"confirm before execution",
			"no shell",
			"bounded redacted output",
			"project-contained manifests",
			"symlink rejection",
		],
		externalRequirements: [
			"container engine or Kubernetes installation",
			"registry/cloud credentials",
			"platform-holder approval",
			"licensed console SDK and devkit",
			"vendor certification services",
		],
	};
}

/** Lists valid project-contained licensed console provider manifests and bounded validation errors. */
export async function listConsoleProviders(_scene: Scene, _data: unknown, options: IMCPActionOptions): Promise<object> {
	return readProviders(projectDirectory(options));
}

/** Reads one exact console-provider manifest without exposing credential values. */
export async function getConsoleProvider(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(data, ["id", "endpoint", "collaborationToken"], "get_console_provider input");
	if (typeof data.id !== "string" || !identifierPattern.test(data.id)) {
		throw new Error("Console provider id is invalid.");
	}
	const result = await readProviders(projectDirectory(options));
	const provider = result.providers.find((entry) => entry.id === data.id);
	if (!provider) {
		throw new Error(`Console provider was not found: ${data.id}`);
	}
	return structuredClone(provider);
}

/** Audits exact server authoring, artifacts, tools, credentials, provider, and selected scene readiness. */
export async function validateConsoleServerTarget(scene: Scene, _data: unknown, options: IMCPActionOptions): Promise<object> {
	const root = projectDirectory(options);
	const config = getConsoleServerConfiguration(scene);
	validateConsoleServerConfiguration(config);
	const scaffold = await getPlatformScaffold(scene, { target: "headless" }, options);
	const artifacts = await artifactStatus(root);
	const profiles = listBuildProfiles(scene).profiles;
	const profile = config.headless.buildProfileId
		? profiles.find((entry: any) => entry.id === config.headless.buildProfileId)
		: profiles.find((entry: any) => entry.enabled && entry.target === "headless");
	const scenes = options.editor.state.sceneBuildSettings?.scenes ?? [];
	const selectedScene = config.headless.initialScenePath
		? scenes.find((entry: any) => entry.path === config.headless.initialScenePath && entry.enabled !== false)
		: scenes.find((entry: any) => entry.enabled !== false);
	const providers = await readProviders(root);
	const provider = config.deployment.consoleProviderId ? providers.providers.find((entry) => entry.id === config.deployment.consoleProviderId) : null;
	const commandNames = new Set<string>(["node"]);
	if (config.deployment.provider === "container") {
		commandNames.add(config.container.engine);
	}
	if (config.deployment.provider === "kubernetes") {
		commandNames.add("kubectl");
	}
	if (config.deployment.provider === "console" && provider) {
		Object.values(provider.operations).forEach((operation) => commandNames.add(operation!.executable));
	}
	const commands = Object.fromEntries(await Promise.all([...commandNames].map(async (command) => [command, await commandAvailable(command)])));
	const credentialNames = [
		config.headless.joinCodeEnvironment,
		...(config.container.registryCredentialEnvironment ? [config.container.registryCredentialEnvironment] : []),
		...(provider?.credentialEnvironments ?? []),
	];
	const environment = Object.fromEntries([...new Set(credentialNames)].map((name) => [name, Boolean(process.env[name])]));
	const errors: string[] = [];
	const warnings: string[] = [...providers.errors.map((entry) => `${entry.path}: ${entry.error}`)];
	if (!scaffold.exists || !scaffold.integrity) {
		errors.push("Generate an intact headless platform scaffold.");
	}
	if (!profile || profile.target !== "headless" || profile.enabled === false) {
		errors.push("Select or enable a headless Build Profile.");
	}
	if (!selectedScene) {
		errors.push("Enable the configured initial scene, or at least one scene, in Build Settings.");
	}
	if (!commands.node) {
		errors.push("Node.js is required.");
	}
	if (config.deployment.provider === "container" && !commands[config.container.engine]) {
		errors.push(`${config.container.engine} is required for container deployment.`);
	}
	if (config.deployment.provider === "kubernetes" && !commands.kubectl) {
		errors.push("kubectl is required for Kubernetes deployment.");
	}
	if (config.deployment.provider === "console" && !provider) {
		errors.push("The selected console provider manifest is missing or invalid.");
	}
	if (provider && !provider.hostPlatforms.includes(process.platform as any)) {
		errors.push(`Console provider ${provider.id} does not support host ${process.platform}.`);
	}
	for (const [name, present] of Object.entries(environment)) {
		if (!present) {
			warnings.push(`Environment reference ${name} is not currently defined.`);
		}
	}
	if (!artifacts.exists || !artifacts.integrity || artifacts.manifest?.configurationRevision !== config.revision || artifacts.manifest?.scaffoldRevision !== scaffold.revision) {
		warnings.push("Regenerate deployment artifacts for the exact configuration and scaffold revisions.");
	}
	return {
		valid: errors.length === 0,
		configuration: config,
		scaffold,
		artifacts,
		profile: profile ?? null,
		initialScene: selectedScene?.path ?? null,
		provider,
		commands,
		environment,
		errors,
		warnings,
	};
}

/** Reads generated Kubernetes/environment/documentation artifacts and verifies exact hashes. */
export async function getServerDeploymentArtifacts(_scene: Scene, _data: unknown, options: IMCPActionOptions): Promise<object> {
	return artifactStatus(projectDirectory(options));
}

/** Generates or replaces hash-owned production deployment artifacts under `.zvibe/server`. */
export async function generateServerDeploymentArtifacts(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(
		data,
		["expectedRevision", "expectedConfigurationRevision", "expectedScaffoldRevision", "overwrite", "confirm", "endpoint", "collaborationToken"],
		"generate_server_deployment_artifacts input"
	);
	const root = projectDirectory(options);
	const config = getConsoleServerConfiguration(scene);
	const scaffold = await getPlatformScaffold(scene, { target: "headless" }, options);
	const current = await readArtifactManifest(root);
	const currentStatus = await artifactStatus(root);
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== (current?.revision ?? 0)) {
		throw new Error(`Stale deployment artifact revision ${String(data.expectedRevision)}; current revision is ${current?.revision ?? 0}.`);
	}
	if (data.expectedConfigurationRevision !== config.revision) {
		throw new Error(`Stale Console & Server configuration revision ${String(data.expectedConfigurationRevision)}; current revision is ${config.revision}.`);
	}
	if (!scaffold.exists || !scaffold.integrity) {
		throw new Error("An intact headless platform scaffold is required before deployment artifacts are generated.");
	}
	if (data.expectedScaffoldRevision !== scaffold.revision) {
		throw new Error(`Stale headless scaffold revision ${String(data.expectedScaffoldRevision)}; current revision is ${scaffold.revision}.`);
	}
	if (current && !currentStatus.integrity && data.overwrite !== true) {
		throw new Error("Deployment artifacts were modified or removed; overwrite=true and confirm=true are required.");
	}
	if (data.overwrite === true && data.confirm !== true) {
		throw new Error("Replacing deployment artifacts requires confirm=true.");
	}
	const directory = artifactDirectory(root);
	const sources = deploymentSources(config);
	const previous = new Map<string, string | null>();
	for (const path of [artifactManifestPath(root), ...[...sources.keys()].map((name) => join(directory, name))]) {
		previous.set(path, (await pathExists(path)) ? await readFile(path, "utf8") : null);
	}
	const now = new Date().toISOString();
	const manifest: IDeploymentArtifactsManifest = {
		version: 1,
		revision: (current?.revision ?? 0) + 1,
		configurationRevision: config.revision,
		scaffoldRevision: scaffold.revision,
		createdAt: current?.createdAt ?? now,
		updatedAt: now,
		files: [...sources].map(([path, content]) => ({ path, sha256: sha256(content) })),
	};
	try {
		await ensureDir(directory);
		for (const [path, content] of sources) {
			await writeFile(join(directory, path), content, "utf8");
		}
		await writeJSON(artifactManifestPath(root), manifest, { spaces: "\t" });
	} catch (error) {
		for (const [path, content] of previous) {
			content === null ? await remove(path) : await writeFile(path, content, "utf8");
		}
		throw error;
	}
	return artifactStatus(root);
}

/** Removes only hash-owned generated deployment artifacts under an exact revision. */
export async function removeServerDeploymentArtifacts(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(data, ["expectedRevision", "confirm", "forceModified", "endpoint", "collaborationToken"], "remove_server_deployment_artifacts input");
	if (data.confirm !== true) {
		throw new Error("Removing server deployment artifacts requires confirm=true.");
	}
	const root = projectDirectory(options);
	const manifest = await readArtifactManifest(root);
	if (!manifest) {
		throw new Error("Server deployment artifacts do not exist.");
	}
	if (data.expectedRevision !== manifest.revision) {
		throw new Error(`Stale deployment artifact revision ${String(data.expectedRevision)}; current revision is ${manifest.revision}.`);
	}
	const status = await artifactStatus(root);
	if (!status.integrity && data.forceModified !== true) {
		throw new Error("Deployment artifacts were modified or removed; forceModified=true is required to remove the remaining owned paths.");
	}
	for (const entry of manifest.files) {
		await remove(join(artifactDirectory(root), entry.path));
	}
	await remove(artifactManifestPath(root));
	return { removed: true, revision: manifest.revision, directory: ".zvibe/server" };
}

function operationSupported(provider: IConsoleServerConfiguration["deployment"]["provider"], operation: ConsoleServerOperation): boolean {
	if (["build", "validate"].includes(operation)) {
		return true;
	}
	if (operation === "container-build") {
		return provider === "container" || provider === "kubernetes";
	}
	if (provider === "local") {
		return ["deploy", "stop", "logs", "profile"].includes(operation);
	}
	if (provider === "container") {
		return ["deploy", "restart", "stop", "logs", "profile"].includes(operation);
	}
	if (provider === "kubernetes") {
		return ["deploy", "scale", "restart", "stop", "logs", "profile"].includes(operation);
	}
	return !["container-build", "scale"].includes(operation);
}

function replaceProviderArgs(args: string[], root: string, config: IConsoleServerConfiguration, jobId: string): string[] {
	const values: Record<string, string> = {
		PROJECT: root,
		OUTPUT: join(root, "dist", "headless"),
		IMAGE: config.container.image,
		NAMESPACE: config.deployment.namespace,
		REPLICAS: String(config.deployment.replicas),
		PORT: String(config.headless.port),
		JOB_ID: jobId,
	};
	return args.map((arg) => arg.replace(placeholderPattern, (_match, name: string) => values[name]));
}

function baseEnvironment(options: IMCPActionOptions, config: IConsoleServerConfiguration): NodeJS.ProcessEnv {
	return {
		...process.env,
		BJS_EDITOR_BUILD_TARGET: "headless",
		BJS_EDITOR_OUTPUT_DIRECTORY: "dist/headless",
		BJS_EDITOR_PLAYER_SETTINGS: JSON.stringify(options.editor.state.projectSettings ?? {}),
		BJS_EDITOR_BUILD_SCENES: JSON.stringify(options.editor.state.sceneBuildSettings?.scenes ?? []),
		HOST: config.headless.publicHost,
		PORT: String(config.headless.port),
		ZVIBE_SERVER_MAXIMUM_PLAYERS: String(config.headless.maximumPlayers),
		ZVIBE_SERVER_SCENE: config.headless.initialScenePath ?? undefined,
		ZVIBE_SERVER_JOIN_CODE: process.env[config.headless.joinCodeEnvironment],
	};
}

async function commandsForPlan(plan: IConsoleServerPlan, scene: Scene, options: IMCPActionOptions, jobId: string): Promise<IServerCommand[]> {
	const root = projectDirectory(options);
	const config = getConsoleServerConfiguration(scene);
	const environment = baseEnvironment(options, config);
	const command = (executable: string, args: string[], cwd = root): IServerCommand => ({ executable, args, cwd, environment });
	const packageManager = options.editor.state.packageManager ?? "yarn";
	const packageExecutable = process.platform === "win32" && packageManager !== "bun" ? `${packageManager}.cmd` : packageManager;
	if (plan.operation === "build") {
		return [command(packageExecutable, ["run", "build:headless"])];
	}
	if (plan.operation === "validate") {
		return [command("node", ["--check", join(root, "dist/headless/server.mjs")])];
	}
	if (plan.operation === "container-build") {
		return [command(config.container.engine, ["build", "-f", resolve(root, config.container.dockerfilePath), "-t", config.container.image, join(root, "dist/headless")])];
	}
	if (plan.provider === "local") {
		if (plan.operation === "deploy") {
			return [command("node", [join(root, "dist/headless/server.mjs")], join(root, "dist/headless"))];
		}
		if (plan.operation === "profile") {
			return [command("node", ["--cpu-prof", "--cpu-prof-dir", join(root, ".zvibe/server/profiles"), join(root, "dist/headless/server.mjs")], join(root, "dist/headless"))];
		}
		return [];
	}
	if (plan.provider === "container") {
		const name = "zvibe-game-server";
		if (plan.operation === "deploy") {
			return [
				command(config.container.engine, [
					"run",
					"-d",
					"--name",
					name,
					"-p",
					`${config.headless.port}:7777`,
					"--env",
					config.headless.joinCodeEnvironment,
					config.container.image,
				]),
			];
		}
		if (plan.operation === "restart") {
			return [command(config.container.engine, ["restart", name])];
		}
		if (plan.operation === "stop") {
			return [command(config.container.engine, ["stop", name])];
		}
		if (plan.operation === "logs") {
			return [command(config.container.engine, ["logs", "--tail", "500", name])];
		}
		if (plan.operation === "profile") {
			return [command(config.container.engine, ["exec", name, "node", "--cpu-prof", "server.mjs"])];
		}
	}
	if (plan.provider === "kubernetes") {
		const context = config.deployment.kubeContext ? ["--context", config.deployment.kubeContext] : [];
		const namespace = ["--namespace", config.deployment.namespace];
		if (plan.operation === "deploy") {
			return [command("kubectl", [...context, ...namespace, "apply", "-f", join(root, ".zvibe/server/deployment.yaml")])];
		}
		if (plan.operation === "scale" || plan.operation === "stop") {
			return [
				command("kubectl", [...context, ...namespace, "scale", "deployment/zvibe-game-server", `--replicas=${plan.operation === "stop" ? 0 : config.deployment.replicas}`]),
			];
		}
		if (plan.operation === "restart") {
			return [
				command("kubectl", [...context, ...namespace, "rollout", "restart", "deployment/zvibe-game-server"]),
				command("kubectl", [...context, ...namespace, "rollout", "status", "deployment/zvibe-game-server", "--timeout=300s"]),
			];
		}
		if (plan.operation === "logs") {
			return [command("kubectl", [...context, ...namespace, "logs", "deployment/zvibe-game-server", "--tail=500", "--all-containers=true"])];
		}
		if (plan.operation === "profile") {
			return [command("kubectl", [...context, ...namespace, "top", "pods", "-l", "app.kubernetes.io/name=zvibe-game-server"])];
		}
	}
	if (plan.provider === "console") {
		const providers = await readProviders(root);
		const provider = providers.providers.find((entry) => entry.fingerprint === plan.providerFingerprint);
		const operation = provider?.operations[plan.operation];
		if (!provider || !operation) {
			throw new Error(`Console provider does not implement ${plan.operation}.`);
		}
		return [command(operation.executable, replaceProviderArgs(operation.args, root, config, jobId))];
	}
	throw new Error(`${plan.provider} does not implement ${plan.operation}.`);
}

/** Creates a one-time ten-minute plan bound to exact scene/scaffold/artifact/provider state. */
export async function planConsoleServerWorkflow(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(
		data,
		["operation", "expectedConfigurationRevision", "expectedScaffoldRevision", "expectedArtifactsRevision", "durationSeconds", "endpoint", "collaborationToken"],
		"plan_console_server_workflow input"
	);
	const supported = new Set<ConsoleServerOperation>(["build", "validate", "container-build", "deploy", "scale", "restart", "stop", "logs", "profile", "certify"]);
	if (!supported.has(data.operation as ConsoleServerOperation)) {
		throw new Error("Console/server operation is invalid.");
	}
	const operation = data.operation as ConsoleServerOperation;
	const config = getConsoleServerConfiguration(scene);
	const scaffold = await getPlatformScaffold(scene, { target: "headless" }, options);
	const artifacts = await artifactStatus(projectDirectory(options));
	if (data.expectedConfigurationRevision !== config.revision) {
		throw new Error(`Stale Console & Server configuration revision ${String(data.expectedConfigurationRevision)}; current revision is ${config.revision}.`);
	}
	if (data.expectedScaffoldRevision !== scaffold.revision) {
		throw new Error(`Stale headless scaffold revision ${String(data.expectedScaffoldRevision)}; current revision is ${scaffold.revision}.`);
	}
	if (data.expectedArtifactsRevision !== artifacts.revision) {
		throw new Error(`Stale deployment artifact revision ${String(data.expectedArtifactsRevision)}; current revision is ${artifacts.revision}.`);
	}
	if (!operationSupported(config.deployment.provider, operation)) {
		throw new Error(`${config.deployment.provider} deployment does not support ${operation}.`);
	}
	if ((operation === "profile") !== (data.durationSeconds !== undefined)) {
		throw new Error(`profile requires durationSeconds; other operations do not accept it.`);
	}
	if (data.durationSeconds !== undefined && (!Number.isSafeInteger(data.durationSeconds) || Number(data.durationSeconds) < 1 || Number(data.durationSeconds) > 3_600)) {
		throw new Error("durationSeconds must be an integer from 1 to 3600.");
	}
	const validation = (await validateConsoleServerTarget(scene, {}, options)) as any;
	if (!validation.valid) {
		throw new Error(`Console/server target is invalid: ${validation.errors.join(" ")}`);
	}
	if (
		!["build", "validate"].includes(operation) &&
		(!artifacts.exists || !artifacts.integrity || artifacts.manifest.configurationRevision !== config.revision || artifacts.manifest.scaffoldRevision !== scaffold.revision)
	) {
		throw new Error("Exact deployment artifacts are required for this operation.");
	}
	let providerFingerprint: string | null = null;
	if (config.deployment.provider === "console") {
		const provider = validation.provider as IConsoleProviderManifest | null;
		if (!provider?.operations[operation]) {
			throw new Error(`Console provider does not implement ${operation}.`);
		}
		providerFingerprint = provider.fingerprint;
	}
	const now = Date.now();
	const plan: IConsoleServerPlan = {
		id: randomId("server-plan"),
		operation,
		provider: config.deployment.provider,
		configurationRevision: config.revision,
		scaffoldRevision: scaffold.revision,
		artifactsRevision: artifacts.revision,
		providerFingerprint,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 600_000).toISOString(),
		...(data.durationSeconds === undefined ? {} : { durationSeconds: Number(data.durationSeconds) }),
		warnings: validation.warnings,
	};
	plans(scene).set(plan.id, plan);
	return publicPlan(plan);
}

/** Reads one unexpired exact-state Console & Server workflow plan. */
export function getConsoleServerWorkflowPlan(scene: Scene, data: unknown): object {
	assertRecord(data, ["planId", "endpoint", "collaborationToken"], "get_console_server_workflow_plan input");
	const plan = plans(scene).get(String(data.planId));
	if (!plan) {
		throw new Error("Console/server workflow plan was not found or was already consumed.");
	}
	return { ...publicPlan(plan), expired: Date.now() > Date.parse(plan.expiresAt) };
}

function finishJob(job: IConsoleServerJob, status: ConsoleServerJobStatus, error?: unknown): void {
	job.status = status;
	job.completedAt = new Date().toISOString();
	job.child = undefined;
	if (error !== undefined) {
		job.error = error instanceof Error ? error.message : String(error);
	}
	activeJobs.delete(job);
}

async function runCommand(job: IConsoleServerJob, command: IServerCommand, keepAlive: boolean): Promise<ChildProcess> {
	const child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	job.child = child;
	child.stdout?.on("data", (chunk) => appendOutput(job, chunk.toString()));
	child.stderr?.on("data", (chunk) => appendOutput(job, chunk.toString()));
	if (keepAlive) {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, 1_000);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`Dedicated server exited during startup with code ${code ?? "unknown"}.`));
			});
		});
		return child;
	}
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			job.exitCode = code;
			code === 0 ? resolve() : reject(new Error(`Command exited with code ${code ?? "unknown"}.`));
		});
	});
	job.child = undefined;
	return child;
}

async function runJob(scene: Scene, job: IConsoleServerJob): Promise<void> {
	job.status = "running";
	job.startedAt = new Date().toISOString();
	try {
		if (job.provider === "local" && ["stop", "logs"].includes(job.operation)) {
			const local = [...instances(scene).values()].filter((entry) => entry.provider === "local" && ["starting", "running"].includes(entry.state));
			if (job.operation === "logs") {
				local.forEach((entry) => appendOutput(job, entry.outputTail));
			} else {
				for (const entry of local) {
					await stopInstanceRecord(entry);
				}
			}
			finishJob(job, "succeeded");
			return;
		}
		for (let index = 0; index < job.commands.length; index++) {
			job.commandIndex = index;
			const command = job.commands[index];
			const keepAlive = job.provider === "local" && ["deploy", "profile"].includes(job.operation);
			const child = await runCommand(job, command, keepAlive);
			if (keepAlive) {
				if (job.operation === "profile") {
					const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
					await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, (job.durationSeconds ?? 1) * 1_000))]);
					if ((job as IConsoleServerJob).status === "canceling") {
						throw new Error("Console/server profile job was canceled.");
					}
					if (child.exitCode === null && child.signalCode === null) {
						child.kill("SIGINT");
						await exited;
					}
					job.child = undefined;
				} else {
					const now = new Date().toISOString();
					const instance: IServerInstance = {
						id: randomId("server-instance"),
						provider: "local",
						state: "running",
						createdAt: now,
						updatedAt: now,
						endpoint: `http://${command.environment.HOST}:${command.environment.PORT}`,
						jobId: job.id,
						outputTail: "",
						child,
					};
					const relay = (chunk: any) => (instance.outputTail = `${instance.outputTail}${cleanText(chunk.toString())}`.slice(-65_536));
					child.stdout?.on("data", relay);
					child.stderr?.on("data", relay);
					child.once("exit", (code) => {
						instance.state = code === 0 ? "stopped" : "failed";
						instance.updatedAt = new Date().toISOString();
						instance.child = undefined;
						activeInstances.delete(instance);
					});
					instances(scene).set(instance.id, instance);
					activeInstances.add(instance);
					job.child = undefined;
				}
			}
		}
		if (job.provider !== "local" && ["deploy", "scale", "restart"].includes(job.operation)) {
			const now = new Date().toISOString();
			const instance: IServerInstance = {
				id: randomId("server-instance"),
				provider: job.provider,
				state: "external",
				createdAt: now,
				updatedAt: now,
				endpoint: null,
				jobId: job.id,
				outputTail: job.outputTail,
			};
			instances(scene).set(instance.id, instance);
		}
		finishJob(job, "succeeded");
	} catch (error) {
		if ((job as IConsoleServerJob).status === "canceling") {
			finishJob(job, "canceled");
		} else {
			finishJob(job, "failed", error);
		}
	}
}

/** Consumes and executes one exact plan through fixed no-shell commands. */
export async function executeConsoleServerWorkflowPlan(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	assertRecord(data, ["planId", "confirm", "endpoint", "collaborationToken"], "execute_console_server_workflow_plan input");
	if (data.confirm !== true) {
		throw new Error("Executing a Console & Server workflow requires confirm=true.");
	}
	const store = plans(scene);
	const plan = store.get(String(data.planId));
	if (!plan) {
		throw new Error("Console/server workflow plan was not found or was already consumed.");
	}
	if (Date.now() > Date.parse(plan.expiresAt)) {
		store.delete(plan.id);
		throw new Error("Console/server workflow plan expired; create a new exact-state plan.");
	}
	const config = getConsoleServerConfiguration(scene);
	const scaffold = await getPlatformScaffold(scene, { target: "headless" }, options);
	const artifacts = await artifactStatus(projectDirectory(options));
	if (config.revision !== plan.configurationRevision || scaffold.revision !== plan.scaffoldRevision || artifacts.revision !== plan.artifactsRevision) {
		throw new Error("Console/server workflow state changed after planning; create a new plan.");
	}
	if (plan.provider === "console") {
		const provider = (await readProviders(projectDirectory(options))).providers.find((entry) => entry.id === config.deployment.consoleProviderId);
		if (!provider || provider.fingerprint !== plan.providerFingerprint) {
			throw new Error("Console provider changed after planning; create a new plan.");
		}
	}
	store.delete(plan.id);
	const id = randomId("server-job");
	const commands = await commandsForPlan(plan, scene, options, id);
	const secretNames = [config.headless.joinCodeEnvironment, ...(config.container.registryCredentialEnvironment ? [config.container.registryCredentialEnvironment] : [])];
	const job: IConsoleServerJob = {
		id,
		planId: plan.id,
		operation: plan.operation,
		provider: plan.provider,
		status: "queued",
		createdAt: new Date().toISOString(),
		commandIndex: 0,
		commands,
		outputTail: "",
		secretValues: secretNames.map((name) => process.env[name] ?? "").filter(Boolean),
		durationSeconds: plan.durationSeconds,
	};
	jobs(scene).set(job.id, job);
	activeJobs.add(job);
	void runJob(scene, job);
	return publicJob(job);
}

/** Reads one retained redacted Console & Server job. */
export function getConsoleServerJob(scene: Scene, data: unknown): object {
	assertRecord(data, ["jobId", "endpoint", "collaborationToken"], "get_console_server_job input");
	const job = jobs(scene).get(String(data.jobId));
	if (!job) {
		throw new Error("Console/server job was not found.");
	}
	return publicJob(job);
}

/** Pages retained Console & Server job evidence. */
export function listConsoleServerJobs(scene: Scene, data: unknown): object {
	assertRecord(data, ["provider", "operation", "status", "offset", "limit", "endpoint", "collaborationToken"], "list_console_server_jobs input");
	const offset = Number.isSafeInteger(data.offset) && Number(data.offset) >= 0 ? Number(data.offset) : 0;
	const limit = Number.isSafeInteger(data.limit) && Number(data.limit) >= 1 && Number(data.limit) <= 100 ? Number(data.limit) : 50;
	const values = [...jobs(scene).values()]
		.filter(
			(entry) =>
				(!data.provider || entry.provider === data.provider) && (!data.operation || entry.operation === data.operation) && (!data.status || entry.status === data.status)
		)
		.reverse();
	return { total: values.length, offset, limit, jobs: values.slice(offset, offset + limit).map(publicJob) };
}

/** Cancels one active external process and retains its redacted evidence. */
export function cancelConsoleServerJob(scene: Scene, data: unknown): object {
	assertRecord(data, ["jobId", "confirm", "endpoint", "collaborationToken"], "cancel_console_server_job input");
	if (data.confirm !== true) {
		throw new Error("Canceling a Console & Server job requires confirm=true.");
	}
	const job = jobs(scene).get(String(data.jobId));
	if (!job) {
		throw new Error("Console/server job was not found.");
	}
	if (!["queued", "running"].includes(job.status)) {
		throw new Error(`Console/server job is already ${job.status}.`);
	}
	job.status = "canceling";
	job.child?.kill("SIGTERM");
	if (!job.child) {
		finishJob(job, "canceled");
	}
	return publicJob(job);
}

/** Pages local and externally evidenced server instances without provider-side discovery claims. */
export function listServerInstances(scene: Scene, data: unknown): object {
	assertRecord(data, ["provider", "state", "offset", "limit", "endpoint", "collaborationToken"], "list_server_instances input");
	const offset = Number.isSafeInteger(data.offset) && Number(data.offset) >= 0 ? Number(data.offset) : 0;
	const limit = Number.isSafeInteger(data.limit) && Number(data.limit) >= 1 && Number(data.limit) <= 100 ? Number(data.limit) : 50;
	const values = [...instances(scene).values()].filter((entry) => (!data.provider || entry.provider === data.provider) && (!data.state || entry.state === data.state)).reverse();
	return { total: values.length, offset, limit, instances: values.slice(offset, offset + limit).map(publicInstance) };
}

/** Reads one retained server-instance record. */
export function getServerInstance(scene: Scene, data: unknown): object {
	assertRecord(data, ["instanceId", "endpoint", "collaborationToken"], "get_server_instance input");
	const instance = instances(scene).get(String(data.instanceId));
	if (!instance) {
		throw new Error("Server instance was not found.");
	}
	return publicInstance(instance);
}

async function stopInstanceRecord(instance: IServerInstance): Promise<void> {
	if (!instance.child) {
		instance.state = "stopped";
		instance.updatedAt = new Date().toISOString();
		return;
	}
	instance.state = "stopping";
	instance.updatedAt = new Date().toISOString();
	const child = instance.child;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
	instance.child = undefined;
	instance.state = "stopped";
	instance.updatedAt = new Date().toISOString();
	activeInstances.delete(instance);
}

/** Stops only an editor-launched local instance; external fleets require a planned stop workflow. */
export async function stopServerInstance(scene: Scene, data: unknown): Promise<object> {
	assertRecord(data, ["instanceId", "confirm", "endpoint", "collaborationToken"], "stop_server_instance input");
	if (data.confirm !== true) {
		throw new Error("Stopping a local server instance requires confirm=true.");
	}
	const instance = instances(scene).get(String(data.instanceId));
	if (!instance) {
		throw new Error("Server instance was not found.");
	}
	if (instance.provider !== "local") {
		throw new Error("External instances must be stopped through an exact workflow plan.");
	}
	await stopInstanceRecord(instance);
	return publicInstance(instance);
}

/** Reads the configured health or metrics route with a strict timeout and response bound. */
export async function inspectServerEndpoint(scene: Scene, data: unknown): Promise<object> {
	assertRecord(data, ["kind", "endpoint", "collaborationToken"], "inspect_server_endpoint input");
	if (!["health", "metrics"].includes(String(data.kind))) {
		throw new Error("Endpoint kind must be health or metrics.");
	}
	const config = getConsoleServerConfiguration(scene);
	const path = data.kind === "health" ? config.headless.healthPath : config.headless.metricsPath;
	const url = new URL(`http://${config.headless.publicHost}:${config.headless.port}${path}`);
	const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "error" });
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > config.observability.logLimitBytes) {
		throw new Error("Server endpoint response exceeds the configured bound.");
	}
	const body = await response.text();
	if (Buffer.byteLength(body) > config.observability.logLimitBytes) {
		throw new Error("Server endpoint response exceeds the configured bound.");
	}
	return { kind: data.kind, url: url.toString(), status: response.status, ok: response.ok, contentType: response.headers.get("content-type"), body };
}

/** Terminates every process retained by this editor process during application shutdown. */
export function shutdownConsoleServerWorkflows(): void {
	for (const job of activeJobs) {
		job.child?.kill("SIGTERM");
	}
	for (const instance of activeInstances) {
		instance.child?.kill("SIGTERM");
	}
	activeJobs.clear();
	activeInstances.clear();
}
