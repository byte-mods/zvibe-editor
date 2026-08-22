#!/usr/bin/env node
/** Real stdio/editor lifecycle for versioned Build Profiles, staged builds, cache verification, Build & Run, PWA generation, reports, and cleanup. */
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { connectEditorUi } from "./electron-ui-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server", "index.mjs");
const child = spawn("node", [server], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;

child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	let newline;
	while ((newline = stdout.indexOf("\n")) >= 0) {
		const line = stdout.slice(0, newline).trim();
		stdout = stdout.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function rpc(method, params, timeoutMs = 180_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}, expectError = false, timeoutMs = 180_000, log = true) {
	const startedAt = Date.now();
	if (log) console.log(`[build-pipeline-live] CALL ${name}`);
	const response = await rpc("tools/call", { name, arguments: args }, timeoutMs);
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (log) console.log(`[build-pipeline-live] ${failed ? "EXPECTED-ERROR" : "DONE"} ${name} (${Date.now() - startedAt} ms)`);
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

async function waitForBuildJob(jobId, timeoutMs = 1_800_000) {
	const deadline = Date.now() + timeoutMs;
	let lastStatus;
	while (Date.now() < deadline) {
		let status;
		try {
			status = await call("get_build_pipeline_status", { jobId, includeResult: true }, false, 180_000, false);
		} catch (error) {
			if (!/ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/i.test(error instanceof Error ? error.message : String(error))) throw error;
			console.log(`[build-pipeline-live] JOB ${jobId} poll transport recovered: ${error instanceof Error ? error.message : String(error)}`);
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			continue;
		}
		const job = status.jobs?.[0];
		if (!job) throw new Error(`Build Pipeline job disappeared: ${jobId}`);
		if (job.status !== lastStatus) {
			console.log(`[build-pipeline-live] JOB ${jobId} ${job.status} (${job.durationMs} ms)`);
			lastStatus = job.status;
		}
		if (job.status === "succeeded") return job.result;
		if (job.status === "failed") throw new Error(`Build Pipeline job ${jobId} failed: ${job.error}`);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`Build Pipeline job ${jobId} did not finish within ${timeoutMs} ms.`);
}

async function callBackground(name, args, timeoutMs = 1_800_000) {
	const accepted = await call(name, { ...args, background: true }, false, 180_000);
	if (!accepted.accepted || !accepted.job?.id) throw new Error(`${name} did not return a retained background job: ${JSON.stringify(accepted)}`);
	activeBuildJobId = accepted.job.id;
	const result = await waitForBuildJob(activeBuildJobId, timeoutMs);
	activeBuildJobId = undefined;
	return result;
}

async function optionalRead(path) {
	try {
		return await readFile(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function restoreFile(path, bytes) {
	if (bytes === null) await rm(path, { force: true });
	else await writeFile(path, bytes);
}

const requiredTools = [
	"list_build_profiles",
	"create_build_profile",
	"duplicate_build_profile",
	"set_active_build_profile",
	"set_build_profile",
	"delete_build_profile",
	"get_build_profile_environment",
	"inspect_web_build_plan",
	"verify_web_build_output",
	"validate_build_profile",
	"run_build_profile",
	"build_build_profile",
	"build_and_run_build_profile",
	"stop_build_profile_run",
	"get_build_pipeline_status",
	"clean_build_profile_output",
	"generate_pwa_manifest",
	"generate_pwa_service_worker",
	"install_pwa_service_worker_registration",
	"list_build_reports",
	"get_build_report",
	"delete_build_report",
	"get_generate_options",
	"get_export_report",
	"export_active_scene",
];

const suffix = `${Date.now()}-${process.pid}`;
const profileId = `mcp-live-build-${suffix}`;
const duplicateId = `${profileId}-copy`;
const buildScript = `zvibe-build-${suffix}`;
const runScript = `zvibe-run-${suffix}`;
let projectDirectory;
let packagePath;
let packageBaseline;
let indexPath;
let indexBaseline;
let outputPath;
let manifestPath;
let workerPath;
let baselineConfiguration;
let baselineReportIds = new Set();
let activeRunId;
let activeBuildJobId;
let ui;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "build-pipeline-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const listed = await rpc("tools/list", {});
	const available = new Set(listed.result?.tools?.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing Build Pipeline tools: ${missing.join(", ")}`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for the Build Pipeline live scenario.");
	ui = await connectEditorUi(".flexlayout__tab_button");
	projectDirectory = dirname(status.projectPath);
	packagePath = join(projectDirectory, "package.json");
	indexPath = join(projectDirectory, "index.html");
	packageBaseline = await optionalRead(packagePath);
	indexBaseline = await optionalRead(indexPath);
	if (!packageBaseline) throw new Error("The live project has no package.json.");

	baselineConfiguration = await call("list_build_profiles");
	const baselineReports = await call("list_build_reports");
	if (baselineReports.reports.length > 40)
		throw new Error("The live scene has more than 40 retained build reports; use a disposable verification scene to avoid retention eviction.");
	baselineReportIds = new Set(baselineReports.reports.map((report) => report.id));

	const packageJson = JSON.parse(packageBaseline.toString("utf8"));
	packageJson.scripts ??= {};
	packageJson.scripts[buildScript] =
		"node -e \"const f=require('fs'),p=process.env.BJS_EDITOR_OUTPUT_DIRECTORY;f.mkdirSync(p,{recursive:true});f.writeFileSync(p+'/artifact.json',JSON.stringify({profile:process.env.BJS_EDITOR_BUILD_PROFILE_ID,target:process.env.BJS_EDITOR_BUILD_TARGET}))\"";
	packageJson.scripts[runScript] = 'node -e "setInterval(()=>{},1000)"';
	await writeFile(packagePath, `${JSON.stringify(packageJson, null, "\t")}\n`);
	if (!indexBaseline) await writeFile(indexPath, "<!doctype html><html><body><main></main></body></html>\n");

	const relativeOutput = `build-live-${suffix}`;
	const relativeManifest = `public/build-live-${suffix}.webmanifest`;
	const relativeWorker = `public/build-live-${suffix}.js`;
	outputPath = join(projectDirectory, relativeOutput);
	manifestPath = join(projectDirectory, relativeManifest);
	workerPath = join(projectDirectory, relativeWorker);

	let configuration = await call("create_build_profile", {
		expectedRevision: baselineConfiguration.revision,
		id: profileId,
		name: `MCP Live Build ${suffix}`,
		target: "web",
		settings: {
			productName: "Zvibe MCP Live",
			companyName: "Zvibe",
			version: "1.0.0",
			applicationId: "com.zvibe.mcplive",
			outputDirectory: relativeOutput,
			buildMode: "release",
			cleanBuild: false,
			incremental: true,
			sourceMaps: false,
			minify: true,
			compression: "brotli",
			defineSymbols: ["MCP_LIVE"],
			preBuildScripts: [],
			buildScripts: [buildScript],
			postBuildScripts: [],
			runScript,
			signing: { enabled: false },
			web: {
				basePath: "/",
				moduleStripping: true,
				webAssembly2023: true,
				emscriptenToolchain: "typescript-bundler",
				emscriptenExecutable: "emcc",
			},
			pwa: { name: "Zvibe MCP Live", shortName: "Zvibe", manifestPath: relativeManifest, serviceWorkerPath: relativeWorker, startUrl: "/", precacheUrls: ["/"] },
		},
	});
	configuration = configuration.configuration;
	await call("create_build_profile", { expectedRevision: configuration.revision, name: "Invalid", unknownField: true }, true);
	await call("set_build_profile", { expectedRevision: configuration.revision - 1, id: profileId, enabled: false }, true);

	const duplicated = await call("duplicate_build_profile", {
		expectedRevision: configuration.revision,
		id: profileId,
		newId: duplicateId,
		newName: `MCP Live Build Copy ${suffix}`,
	});
	configuration = duplicated.configuration;
	configuration = await call("set_active_build_profile", { expectedRevision: configuration.revision, id: duplicateId });
	const renamed = await call("set_build_profile", { expectedRevision: configuration.revision, id: duplicateId, name: `MCP Live Build Duplicate ${suffix}`, target: "headless" });
	configuration = renamed.configuration;
	configuration = (await call("delete_build_profile", { expectedRevision: configuration.revision, id: duplicateId })).configuration;

	const environment = await call("get_build_profile_environment", { id: profileId });
	const validation = await call("validate_build_profile", { id: profileId });
	if (
		!validation.valid ||
		environment.environment.BJS_EDITOR_BUILD_TARGET !== "web" ||
		environment.environment.BJS_EDITOR_OUTPUT_DIRECTORY !== relativeOutput ||
		environment.environment.BJS_EDITOR_WEB_MODULE_STRIPPING !== "true" ||
		environment.environment.BJS_EDITOR_WEBASSEMBLY_2023 !== "true" ||
		environment.environment.BJS_EDITOR_EMSCRIPTEN_VERSION !== "not-used"
	)
		throw new Error("Build profile environment or target validation evidence was incomplete.");
	await call("get_generate_options");
	await call("get_export_report");
	await callBackground("run_build_profile", { expectedRevision: configuration.revision, id: profileId });
	await call("export_active_scene", { optimize: true }, false, 600_000);
	const webPlan = await call("inspect_web_build_plan", { expectedRevision: configuration.revision, id: profileId });
	if (
		webPlan.settings.webAssembly2023 !== true ||
		webPlan.settings.moduleStripping !== true ||
		webPlan.toolchain.verified !== true ||
		webPlan.toolchain.selection !== "typescript-bundler" ||
		!/^[a-f0-9]{64}$/.test(webPlan.planFingerprint)
	)
		throw new Error("Web plan defaults, toolchain boundary, or exact fingerprint were incomplete.");

	const first = await callBackground("build_build_profile", { expectedRevision: configuration.revision, id: profileId });
	const builtPlanFingerprint = first.webBuildEvidence?.plan?.planFingerprint;
	if (!/^[a-f0-9]{64}$/.test(builtPlanFingerprint ?? "")) throw new Error("Built Web plan fingerprint was missing or malformed.");
	const webVerification = await call("verify_web_build_output", {
		expectedRevision: configuration.revision,
		id: profileId,
		expectedPlanFingerprint: builtPlanFingerprint,
	});
	const cached = await callBackground("build_build_profile", { expectedRevision: configuration.revision, id: profileId });
	if (
		!first.built ||
		first.cacheHit ||
		cached.built ||
		!cached.cacheHit ||
		first.output.fileCount < 3 ||
		!first.output.completeArtifactHashes ||
		first.webBuildEvidence?.output?.valid !== true ||
		first.webBuildEvidence?.toolchain?.verified !== true ||
		webVerification.valid !== true ||
		webVerification.output.images.png.nativeLibraryMarkersAbsent !== true ||
		webVerification.output.images.jpeg.nativeLibraryMarkersAbsent !== true
	)
		throw new Error("Full/cached Build Pipeline evidence was incomplete.");
	await call("verify_web_build_output", { expectedRevision: configuration.revision, id: profileId, expectedPlanFingerprint: "0".repeat(64) }, true);
	await writeFile(join(outputPath, "artifact.json"), "tampered");
	const rebuilt = await callBackground("build_build_profile", { expectedRevision: configuration.revision, id: profileId });
	if (!rebuilt.built || rebuilt.cacheHit || !rebuilt.buildReport.stages.some((stage) => stage.name === "build" && stage.status === "passed"))
		throw new Error("Output tamper did not invalidate and execute the verified incremental build.");

	await call("generate_pwa_manifest", { expectedRevision: configuration.revision, id: profileId });
	await call("generate_pwa_service_worker", { expectedRevision: configuration.revision, id: profileId });
	const installed = await call("install_pwa_service_worker_registration", { expectedRevision: configuration.revision, id: profileId });
	if (!installed.changed) throw new Error("PWA service-worker registration was not installed.");

	const launched = await callBackground("build_and_run_build_profile", { expectedRevision: configuration.revision, id: profileId });
	activeRunId = launched.run.id;
	const running = await call("get_build_pipeline_status");
	if (!running.runs.some((run) => run.id === activeRunId && run.status === "running")) throw new Error("Build & Run process status did not round-trip.");
	const stopped = await call("stop_build_profile_run", { runId: activeRunId, confirm: true });
	activeRunId = undefined;
	if (!stopped.stopped || !stopped.dismissed || (await call("get_build_pipeline_status")).runs.some((run) => run.id === launched.run.id))
		throw new Error("Build & Run process was not stopped and dismissed.");

	const reports = await call("list_build_reports");
	const report = await call("get_build_report", { id: rebuilt.buildReport.id });
	if (!reports.reports.some((candidate) => candidate.id === rebuilt.buildReport.id) || report.output.outputFingerprint !== rebuilt.output.outputFingerprint)
		throw new Error("Retained build report evidence did not round-trip.");
	const cleaned = await call("clean_build_profile_output", { expectedRevision: configuration.revision, id: profileId, confirm: true });
	if (!cleaned.cleaned || cleaned.removedFileCount < 1) throw new Error("Build output cleanup evidence was incomplete.");

	console.log(
		`[build-pipeline-live] PASS — ${requiredTools.length}/25 tools present, exact revision + strict rejection, Web plan ${builtPlanFingerprint}, generated module/Wasm/PNG/JPEG evidence, staged build ${first.buildReport.id}, verified cache ${cached.buildReport.id}, tamper rebuild ${rebuilt.buildReport.id}, Build & Run stop/dismiss, PWA generation, report read, semantic baseline cleanup.`
	);
} catch (error) {
	console.error(`[build-pipeline-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (ui?.consoleEntries.length) console.error(`[build-pipeline-live] renderer console — ${ui.consoleEntries.slice(-20).join(" | ")}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (activeBuildJobId) {
			await waitForBuildJob(activeBuildJobId);
			activeBuildJobId = undefined;
		}
		if (activeRunId) await call("stop_build_profile_run", { runId: activeRunId, confirm: true });
		if (baselineConfiguration) {
			let configuration = await call("list_build_profiles");
			if (baselineConfiguration.activeProfileId && configuration.profiles.some((profile) => profile.id === baselineConfiguration.activeProfileId)) {
				configuration = await call("set_active_build_profile", { expectedRevision: configuration.revision, id: baselineConfiguration.activeProfileId });
			}
			for (const id of [duplicateId, profileId]) {
				if (configuration.profiles.some((profile) => profile.id === id)) {
					configuration = (await call("delete_build_profile", { expectedRevision: configuration.revision, id })).configuration;
				}
			}
			const remaining = await call("list_build_profiles");
			const simplify = (value) => ({ activeProfileId: value.activeProfileId, profiles: value.profiles });
			if (JSON.stringify(simplify(remaining)) !== JSON.stringify(simplify(baselineConfiguration)))
				throw new Error("Authored build profiles were not restored to their semantic baseline.");
			const reports = await call("list_build_reports");
			for (const report of reports.reports) {
				if (!baselineReportIds.has(report.id)) await call("delete_build_report", { id: report.id, confirm: true });
			}
		}
		if (packagePath) await restoreFile(packagePath, packageBaseline);
		if (indexPath) await restoreFile(indexPath, indexBaseline);
		for (const path of [outputPath, manifestPath, workerPath, manifestPath ? `${manifestPath}.bjsmeta.json` : null, workerPath ? `${workerPath}.bjsmeta.json` : null]) {
			if (path) await rm(path, { recursive: true, force: true });
		}
	} catch (cleanupError) {
		console.error(`[build-pipeline-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	ui?.socket.close();
	child.kill("SIGTERM");
}
