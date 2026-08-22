#!/usr/bin/env node
/** Real stdio/editor lifecycle for the public Linux ARM64 Dedicated Server source build. */
import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getExpectedMcpToolCount } from "./live-scenario-contract.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server", "index.mjs");
const child = spawn(process.execPath, [server], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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

async function call(name, args = {}, expectError = false) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

const requiredTools = [
	"create_build_profile",
	"delete_build_profile",
	"get_build_profile_environment",
	"validate_build_profile",
	"clean_build_profile_output",
	"get_platform_scaffold",
	"generate_platform_scaffold",
	"remove_platform_scaffold",
	"get_linux_arm64_server_source_build_plan",
	"verify_linux_arm64_server_source_build",
];
const profileId = "zvibe-linux-arm64-live";
const outputDirectory = "dist/zvibe-linux-arm64-live";
const baseBuildScript = "build:zvibe-linux-arm64-live";
let projectDirectory;
let packagePath;
let packageBaseline;
let profileRevision;
let profileCreated = false;
let scaffoldRevision;
let scaffoldCreated = false;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "linux-arm64-server-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const listed = await rpc("tools/list", {});
	const availableTools = listed.result?.tools ?? [];
	const available = new Set(availableTools.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	const expectedToolCount = await getExpectedMcpToolCount();
	if (missing.length || availableTools.length !== expectedToolCount) {
		throw new Error(`Expected ${expectedToolCount.toLocaleString("en-US")} tools and the Linux ARM64 surface; missing: ${missing.join(", ") || "none"}.`);
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the Linux ARM64 live scenario.");
	projectDirectory = dirname(status.projectPath);
	packagePath = join(projectDirectory, "package.json");
	packageBaseline = await readFile(packagePath);

	const scaffoldBaseline = await call("get_platform_scaffold", { target: "headless" });
	if (scaffoldBaseline.exists) throw new Error("The live project already has a Headless scaffold; use a disposable clean project.");
	const profilesBaseline = await call("list_build_profiles");
	if (profilesBaseline.profiles.some((profile) => profile.id === profileId)) throw new Error(`The live project already contains ${profileId}.`);

	const packageJson = JSON.parse(packageBaseline.toString("utf8"));
	packageJson.scripts ??= {};
	packageJson.scripts[baseBuildScript] = 'node -e "process.exit(0)"';
	await writeFile(packagePath, `${JSON.stringify(packageJson, null, "\t")}\n`, "utf8");

	const scaffold = await call("generate_platform_scaffold", {
		target: "headless",
		expectedRevision: 0,
		settings: { baseBuildScript, host: "127.0.0.1", port: 17779, tickRate: 60, maximumCatchUpSteps: 4 },
	});
	scaffoldCreated = true;
	scaffoldRevision = scaffold.revision;
	if (!scaffold.integrity || !scaffold.files.some((file) => file.path === "Dockerfile.linux-arm64" && file.matches)) {
		throw new Error("The generated Headless scaffold did not hash-own Dockerfile.linux-arm64.");
	}

	const created = await call("create_build_profile", {
		expectedRevision: profilesBaseline.revision,
		id: profileId,
		name: "Zvibe Linux ARM64 Live",
		target: "headless",
		settings: {
			outputDirectory,
			buildMode: "release",
			cleanBuild: true,
			incremental: false,
			sourceMaps: false,
			minify: true,
			compression: "none",
			buildScripts: ["build:headless"],
			headless: { operatingSystem: "linux", architecture: "arm64", sourceBuild: true, nodeMajor: 22 },
		},
	});
	profileCreated = true;
	profileRevision = created.configuration.revision;

	const plan = await call("get_linux_arm64_server_source_build_plan", { id: profileId });
	if (!/^[a-f0-9]{64}$/.test(plan.plan.planFingerprint) || plan.plan.publicToolchain.containerPlatform !== "linux/arm64" || plan.plan.artifacts.length !== 5) {
		throw new Error("Linux ARM64 source-build plan evidence was incomplete.");
	}
	await call("verify_linux_arm64_server_source_build", { id: profileId, expectedRevision: profileRevision - 1, expectedPlanFingerprint: plan.plan.planFingerprint }, true);
	await call("verify_linux_arm64_server_source_build", { id: profileId, expectedRevision: profileRevision, expectedPlanFingerprint: "0".repeat(64) }, true);
	const beforeBuild = await call("verify_linux_arm64_server_source_build", {
		id: profileId,
		expectedRevision: profileRevision,
		expectedPlanFingerprint: plan.plan.planFingerprint,
	});
	if (beforeBuild.built || beforeBuild.valid) throw new Error("The pre-build verifier did not report missing output.");

	const validation = await call("validate_build_profile", { id: profileId });
	if (!validation.valid || !validation.warnings.some((warning) => warning.includes("native addons")))
		throw new Error("Build Profile validation lacked Linux ARM64 portability evidence.");
	const buildEnvironment = await call("get_build_profile_environment", { id: profileId });
	if (JSON.parse(buildEnvironment.environment.BJS_EDITOR_HEADLESS_BUILD_SETTINGS).architecture !== "arm64")
		throw new Error("Headless build settings were absent from the environment.");
	if (JSON.parse(buildEnvironment.environment.BJS_EDITOR_LINUX_ARM64_SERVER_SOURCE_BUILD_PLAN).planFingerprint !== plan.plan.planFingerprint) {
		throw new Error("The environment source-build plan did not match the inspected lease.");
	}
	await call(
		"set_build_profile",
		{
			id: profileId,
			expectedRevision: profileRevision,
			settings: { headless: { operatingSystem: "linux", architecture: "arm64", sourceBuild: true, nodeMajor: 22, unknown: true } },
		},
		true
	);

	await execFileAsync(process.execPath, [join(projectDirectory, ".zvibe/platforms/headless/build.mjs")], {
		cwd: projectDirectory,
		env: { ...process.env, ...buildEnvironment.environment, npm_config_user_agent: "yarn/1.22.22" },
		timeout: 60_000,
		maxBuffer: 4 * 1024 * 1024,
	});
	const verified = await call("verify_linux_arm64_server_source_build", {
		id: profileId,
		expectedRevision: profileRevision,
		expectedPlanFingerprint: plan.plan.planFingerprint,
	});
	if (!verified.built || !verified.valid || verified.artifacts.length !== 5 || verified.artifacts.some((artifact) => !artifact.matches)) {
		throw new Error(`Built Linux ARM64 source package did not verify: ${JSON.stringify(verified)}`);
	}
	const runtimePackage = JSON.parse(await readFile(join(projectDirectory, outputDirectory, "package.json"), "utf8"));
	if (runtimePackage.os?.[0] !== "linux" || runtimePackage.cpu?.[0] !== "arm64" || runtimePackage.engines?.node !== ">=22 <23") {
		throw new Error("Generated runtime package restrictions were incomplete.");
	}
	await execFileAsync(process.execPath, ["--check", join(projectDirectory, outputDirectory, "server.mjs")], { timeout: 15_000, maxBuffer: 1024 * 1024 });

	await writeFile(join(projectDirectory, outputDirectory, "server.mjs"), "syntax !!!\n", "utf8");
	const tampered = await call("verify_linux_arm64_server_source_build", {
		id: profileId,
		expectedRevision: profileRevision,
		expectedPlanFingerprint: plan.plan.planFingerprint,
	});
	if (tampered.valid || !tampered.errors.some((error) => error.includes("changed after")) || !tampered.errors.some((error) => error.includes("syntax"))) {
		throw new Error("Artifact tampering was not detected by both hash and syntax checks.");
	}

	await call("clean_build_profile_output", { id: profileId, expectedRevision: profileRevision, confirm: true });
	const removedProfile = await call("delete_build_profile", { id: profileId, expectedRevision: profileRevision });
	profileCreated = false;
	profileRevision = removedProfile.configuration.revision;
	await call("remove_platform_scaffold", { target: "headless", expectedRevision: scaffoldRevision, confirm: true });
	scaffoldCreated = false;
	await rm(join(projectDirectory, ".zvibe", "platforms", "headless"), { recursive: true, force: true });
	await writeFile(packagePath, packageBaseline);

	console.log(
		`[linux-arm64-server-live] PASS — ${availableTools.length.toLocaleString("en-US")}-tool discovery, strict/stale rejection, exact plan/environment, real public-source build, five artifact hashes, Linux/arm64/Node22 restrictions, tamper plus syntax detection, and disk cleanup verified.`
	);
} catch (error) {
	console.error(`[linux-arm64-server-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (projectDirectory && profileCreated && Number.isSafeInteger(profileRevision)) {
			await call("clean_build_profile_output", { id: profileId, expectedRevision: profileRevision, confirm: true }).catch(() => null);
			await call("delete_build_profile", { id: profileId, expectedRevision: profileRevision }).catch(() => null);
		}
		if (projectDirectory && scaffoldCreated && Number.isSafeInteger(scaffoldRevision)) {
			await call("remove_platform_scaffold", { target: "headless", expectedRevision: scaffoldRevision, confirm: true }).catch(() => null);
		}
		if (projectDirectory) {
			await rm(join(projectDirectory, outputDirectory), { recursive: true, force: true });
			await rm(join(projectDirectory, ".zvibe", "platforms", "headless"), { recursive: true, force: true });
		}
		if (packagePath && packageBaseline) await writeFile(packagePath, packageBaseline);
	} catch (cleanupError) {
		console.error(`[linux-arm64-server-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}
