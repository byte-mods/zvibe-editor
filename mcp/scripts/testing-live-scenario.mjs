#!/usr/bin/env node
/** Real stdio/editor/player lifecycle for exact-revision portable testing and connected-player orchestration. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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

async function waitFor(read, predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for connected-player testing evidence.");
}

const requiredTools = [
	"compare_visual_regression_images",
	"create_performance_budget",
	"set_performance_budget",
	"run_performance_budgets",
	"delete_performance_budget",
	"create_scene_test",
	"set_scene_test",
	"run_scene_tests",
	"delete_scene_test",
	"get_testing_capabilities",
	"get_testing_state",
	"set_testing_settings",
	"create_test_suite",
	"set_test_suite",
	"delete_test_suite",
	"create_test_case",
	"set_test_case",
	"delete_test_case",
	"run_testing",
	"get_testing_run_status",
	"cancel_testing_run",
	"list_testing_runs",
	"get_testing_run",
	"export_testing_run_report",
	"clear_testing_runs",
	"get_project_code_tests",
	"set_project_code_tests",
	"run_project_code_tests",
	"cancel_project_code_tests",
];
const suffix = `${Date.now()}-${process.pid}`;
const suiteId = `live-testing-${suffix}`;
const testId = `${suiteId}-case`;
const transientTestId = `${suiteId}-transient`;
const performanceBudgetId = `${suiteId}-budget`;
const sceneTestId = `${suiteId}-scene`;
const visualFolder = `assets/mcp-testing-${suffix}`;
const reportPath = `.bjseditor/test-results/mcp-testing-${suffix}.json`;
const setupScriptName = `testing-setup-${suffix}.js`;
const cleanupScriptName = `testing-cleanup-${suffix}.js`;
const codeTestScript = `mcp-live-test-${process.pid}`;
const createdRunIds = [];
let currentRevision = null;
let suiteCreated = false;
let labStarted = false;
let player;
let fixtureNodeId;
let baselineSettings;
let baselineSuiteIds = new Set();
let baselineRunIds = new Set();
let baselineCodeState;
let codeFixtureInstalled = false;

async function cleanupCodeFixtures() {
	if (baselineCodeState && codeFixtureInstalled) {
		const restored = {
			version: baselineCodeState.version,
			revision: baselineCodeState.revision,
			...baselineCodeState.configuration,
			runs: baselineCodeState.runs,
		};
		const cleanupSource = `
import { dirname, join } from "path";
import { readJSON, writeJSON } from "fs-extra";
export async function main(editor) {
	const project = dirname(editor.state.projectPath);
	const packagePath = join(project, "package.json");
	const manifest = await readJSON(packagePath);
	const expected = 'node -e "setInterval(()=>{},1000)"';
	if (manifest.scripts?.[${JSON.stringify(codeTestScript)}] !== expected) throw new Error("Temporary MCP code-test package script changed unexpectedly.");
	delete manifest.scripts[${JSON.stringify(codeTestScript)}];
	await writeJSON(packagePath, manifest, { spaces: "\\t" });
	const scene = editor.layout.preview.scene;
	scene.metadata ??= {};
	scene.metadata.babylonEditorProjectCodeTesting = ${JSON.stringify(restored)};
	return "testing fixtures restored";
}`;
		await call("run_agent_script", { name: cleanupScriptName, content: cleanupSource });
		codeFixtureInstalled = false;
	}
	for (const path of [
		`${visualFolder}/baseline.png.bjsmeta.json`,
		`${visualFolder}/candidate.png.bjsmeta.json`,
		`${visualFolder}/diff.png.bjsmeta.json`,
		`${visualFolder}/baseline.png`,
		`${visualFolder}/candidate.png`,
		`${visualFolder}/diff.png`,
		visualFolder,
		reportPath,
		`agentdata/${setupScriptName}`,
		`agentdata/${cleanupScriptName}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs.map")}`,
		`.bjseditor/agent-scripts/${cleanupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${cleanupScriptName.replace(/\.js$/, ".cjs.map")}`,
	]) {
		await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "testing-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	const available = new Set(listed.result?.tools?.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing Testing tools: ${missing.join(", ")}`);
	const editorStatus = await call("get_editor_status");
	if (!editorStatus.ready || !editorStatus.projectPath) throw new Error("A ready project editor is required for the Testing live scenario.");

	const capabilities = await call("get_testing_capabilities");
	if (capabilities.version !== 2 || !capabilities.modes.includes("connected-player") || !capabilities.reports.includes("junit")) {
		throw new Error("Testing capability boundaries were incomplete.");
	}
	const baseline = await call("get_testing_state");
	baselineSettings = structuredClone(baseline.settings);
	baselineSuiteIds = new Set(baseline.suites.map((suite) => suite.id));
	baselineRunIds = new Set(baseline.runs.map((run) => run.id));
	baselineCodeState = await call("get_project_code_tests");
	const setupSource = `
import { dirname, join } from "path";
import { ensureDir, readJSON, writeJSON } from "fs-extra";
import sharp from "sharp";
export async function main(editor) {
	const project = dirname(editor.state.projectPath);
	const directory = join(project, ${JSON.stringify(visualFolder)});
	await ensureDir(directory);
	for (const name of ["baseline.png", "candidate.png"]) {
		await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 1 } } }).png().toFile(join(directory, name));
	}
	const packagePath = join(project, "package.json");
	const manifest = await readJSON(packagePath);
	manifest.scripts ??= {};
	if (manifest.scripts[${JSON.stringify(codeTestScript)}] !== undefined) throw new Error("Temporary MCP code-test script already exists.");
	manifest.scripts[${JSON.stringify(codeTestScript)}] = 'node -e "setInterval(()=>{},1000)"';
	await writeJSON(packagePath, manifest, { spaces: "\\t" });
	return "testing fixtures created";
}`;
	await call("run_agent_script", { name: setupScriptName, content: setupSource });
	codeFixtureInstalled = true;
	const compared = await call("compare_visual_regression_images", {
		baselinePath: `${visualFolder}/baseline.png`,
		candidatePath: `${visualFolder}/candidate.png`,
		tolerance: 0,
		diffPath: `${visualFolder}/diff.png`,
	});
	if (!compared.passed || compared.differingPixels !== 0 || compared.totalPixels !== 64) throw new Error("Visual-regression comparison evidence was incomplete.");

	let budget = await call("create_performance_budget", { id: performanceBudgetId, name: `MCP Performance ${suffix}`, limits: { drawCalls: 1_000_000 } });
	budget = await call("set_performance_budget", { id: budget.id, name: `MCP Performance Updated ${suffix}`, limits: { drawCalls: 1_000_000, meshes: 1_000_000 } });
	const budgetRun = await call("run_performance_budgets", { id: budget.id });
	if (!budgetRun.passed || budgetRun.results.length !== 1) throw new Error("Performance-budget execution evidence was incomplete.");
	await call("delete_performance_budget", { id: budget.id });

	const fixtureNode = await call("create_primitive_mesh", { type: "box", name: `MCP Testing Fixture ${suffix}`, position: [0, 100, 0], options: { size: 10 } });
	fixtureNodeId = fixtureNode.id;
	let sceneTest = await call("create_scene_test", {
		id: sceneTestId,
		name: `MCP Scene Test ${suffix}`,
		assertions: [{ type: "node-enabled", nodeId: fixtureNodeId, equals: true }],
	});
	sceneTest = await call("set_scene_test", {
		id: sceneTest.id,
		name: `MCP Scene Test Updated ${suffix}`,
		assertions: [{ type: "node-position", nodeId: fixtureNodeId, equals: [0, 100, 0], epsilon: 0.001 }],
	});
	const sceneRun = await call("run_scene_tests", { id: sceneTest.id });
	if (!sceneRun.passed || sceneRun.results.length !== 1) throw new Error("Scene-test execution evidence was incomplete.");
	await call("delete_scene_test", { id: sceneTest.id });

	let state = await call("get_testing_state");
	state = await call("set_testing_settings", {
		expectedRevision: state.revision,
		settings: { defaultTimeoutMs: Math.min(600_000, baselineSettings.defaultTimeoutMs + 1) },
	});
	currentRevision = state.revision;
	const authored = await call("create_test_suite", {
		expectedRevision: currentRevision,
		id: suiteId,
		name: "Live portable testing",
		mode: "edit",
		categories: ["live", "mcp"],
		tests: [
			{
				id: testId,
				name: "Live scene inventory",
				kind: "scene",
				assertions: [{ type: "scene-count", collection: "nodes", operator: "greater-than-or-equal", expected: 0 }],
			},
		],
	});
	suiteCreated = true;
	currentRevision = authored.revision;
	let withTransient = await call("create_test_case", {
		expectedRevision: currentRevision,
		suiteId,
		test: {
			id: transientTestId,
			name: "Transient authored case",
			kind: "scene",
			assertions: [{ type: "node-exists", nodeId: fixtureNodeId, exists: true }],
		},
	});
	currentRevision = withTransient.revision;
	withTransient = await call("set_test_case", {
		expectedRevision: currentRevision,
		suiteId,
		testId: transientTestId,
		patch: { name: "Transient authored case updated", repeat: 2 },
	});
	currentRevision = withTransient.revision;
	withTransient = await call("delete_test_case", { expectedRevision: currentRevision, suiteId, testId: transientTestId, confirm: true });
	currentRevision = withTransient.revision;
	await call("set_test_suite", { expectedRevision: baseline.revision, suiteId, enabled: false }, true);

	const editRun = await call("run_testing", { expectedRevision: currentRevision, modes: ["edit"], suiteIds: [suiteId] });
	if (editRun.target !== "editor-edit" || editRun.status !== "passed" || editRun.summary.total !== 1)
		throw new Error(`Live Edit test evidence was incomplete: ${JSON.stringify(editRun)}`);
	createdRunIds.push(editRun.id);
	const retained = await call("get_testing_run", { runId: editRun.id });
	if (retained.results[0]?.id !== testId || retained.results[0]?.status !== "passed") throw new Error("Retained per-case Edit evidence was incomplete.");
	const exported = await call("export_testing_run_report", { runId: editRun.id, format: "json", path: reportPath });
	if (!exported.exported || exported.path !== reportPath) throw new Error("Testing report export evidence was incomplete.");

	let cancellationAuthored = await call("set_test_case", {
		expectedRevision: currentRevision,
		suiteId,
		testId,
		patch: { steps: [{ type: "wait-ms", milliseconds: 10_000 }] },
	});
	currentRevision = cancellationAuthored.revision;
	const cancellableRunPromise = call("run_testing", { expectedRevision: currentRevision, modes: ["edit"], suiteIds: [suiteId] });
	const activeTesting = await waitFor(
		() => call("get_testing_run_status"),
		(value) => value.active !== null
	);
	const canceledTesting = await call("cancel_testing_run", { runId: activeTesting.active.id, confirm: true });
	if (!canceledTesting.canceled) throw new Error("Active portable Testing run was not canceled.");
	const canceledRun = await cancellableRunPromise;
	createdRunIds.push(canceledRun.id);
	if (canceledRun.status !== "canceled") throw new Error(`Canceled Testing run reported ${canceledRun.status}.`);
	cancellationAuthored = await call("set_test_case", { expectedRevision: currentRevision, suiteId, testId, patch: { steps: [] } });
	currentRevision = cancellationAuthored.revision;

	const playAuthored = await call("set_test_suite", { expectedRevision: currentRevision, suiteId, mode: "play" });
	currentRevision = playAuthored.revision;
	const labStatus = await call("get_device_lab_status");
	if (labStatus.listening) throw new Error("Device Lab was already active; refusing to replace an existing session.");
	const started = await call("start_device_lab", { port: 0, pairingMinutes: 1 });
	labStarted = true;
	player = new WebSocket(`${started.pairing.wsUrl}?token=${started.pairing.pairingToken}`);
	await new Promise((resolve, reject) => {
		player.once("open", resolve);
		player.once("error", reject);
	});
	player.on("message", (bytes) => {
		const message = JSON.parse(bytes.toString());
		if (message.type !== "command") return;
		if (message.command === "run-tests") {
			const suite = message.state.suites.find((candidate) => candidate.id === suiteId);
			const test = suite.tests.find((candidate) => candidate.id === testId);
			const at = new Date().toISOString();
			player.send(
				JSON.stringify({
					protocol: "zvibe-device-lab",
					version: 1,
					type: "response",
					requestId: message.requestId,
					ok: true,
					result: {
						id: `remote-${process.pid}`,
						sequence: message.sequence,
						target: "connected-player",
						status: "passed",
						startedAt: at,
						finishedAt: at,
						durationMs: 0,
						filters: message.request,
						summary: { total: 1, passed: 1, failed: 0, skipped: 0, canceled: 0, timedOut: 0 },
						results: [
							{
								id: test.id,
								suiteId: suite.id,
								name: test.name,
								suiteName: suite.name,
								kind: test.kind,
								mode: "play",
								repeatIndex: 0,
								status: "passed",
								startedAt: at,
								finishedAt: at,
								durationMs: 0,
								assertions: [{ assertion: test.assertions[0], passed: true, actual: 0, message: "Remote scene inventory matched." }],
								errors: [],
							},
						],
						limitations: ["Live mock transport; portable runtime execution is covered by runtime integration tests."],
					},
				})
			);
		} else if (message.command === "cancel-tests") {
			player.send(JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "response", requestId: message.requestId, ok: true, result: { canceled: true } }));
		}
	});
	player.send(
		JSON.stringify({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "hello",
			identity: { deviceId: `testing-${process.pid}`, name: "Testing CLI Player", platform: process.platform },
			capabilities: ["portable-tests"],
		})
	);
	const inventory = await waitFor(
		() => call("list_remote_devices"),
		(value) => value.devices.length === 1
	);
	const connectionId = inventory.devices[0].connectionId;
	const remoteRun = await call("run_testing", {
		expectedRevision: currentRevision,
		target: "connected-player",
		connectionId,
		modes: ["play"],
		suiteIds: [suiteId],
		timeoutMs: 5_000,
		confirm: true,
	});
	if (remoteRun.target !== "connected-player" || remoteRun.status !== "passed" || remoteRun.summary.total !== 1)
		throw new Error("Connected-player report evidence was incomplete.");
	createdRunIds.push(remoteRun.id);
	if ((await call("get_testing_run_status")).active !== null) throw new Error("Testing runner remained active after completion.");
	const codeTests = await call("get_project_code_tests");
	if (codeTests.version !== 1 || !Array.isArray(codeTests.discoveredFiles) || typeof codeTests.configuredScriptAvailable !== "boolean") {
		throw new Error("Project code-test discovery evidence was incomplete.");
	}
	const configuredCodeTests = await call("set_project_code_tests", {
		expectedRevision: codeTests.revision,
		packageScript: codeTestScript,
		timeoutMs: 30_000,
		maximumOutputBytes: 16_384,
	});
	const codeRunPromise = call("run_project_code_tests", { expectedRevision: configuredCodeTests.revision, confirm: true });
	const activeCodeTests = await waitFor(
		() => call("get_project_code_tests"),
		(value) => value.active !== null
	);
	const canceledCodeTests = await call("cancel_project_code_tests", { runId: activeCodeTests.active.id, confirm: true });
	if (!canceledCodeTests.canceled) throw new Error("Active project code-test process was not canceled.");
	const codeRun = await codeRunPromise;
	if (codeRun.status !== "canceled") throw new Error(`Canceled project code-test process reported ${codeRun.status}.`);

	const closed = new Promise((resolve) => player.once("close", resolve));
	await call("disconnect_remote_device", { connectionId, confirm: true });
	await closed;
	player = undefined;
	await call("stop_device_lab", { confirm: true });
	labStarted = false;
	let cleanupState = await call("get_testing_state");
	for (const suite of cleanupState.suites.filter((candidate) => !baselineSuiteIds.has(candidate.id))) {
		cleanupState = await call("delete_test_suite", { expectedRevision: cleanupState.revision, suiteId: suite.id, confirm: true });
		if (suite.id === suiteId) suiteCreated = false;
	}
	if (JSON.stringify(cleanupState.settings) !== JSON.stringify(baselineSettings)) {
		cleanupState = await call("set_testing_settings", { expectedRevision: cleanupState.revision, settings: baselineSettings });
	}
	const newRunIds = cleanupState.runs.filter((run) => !baselineRunIds.has(run.id)).map((run) => run.id);
	if (newRunIds.length) cleanupState = await call("clear_testing_runs", { expectedRevision: cleanupState.revision, runIds: newRunIds, confirm: true });
	if (cleanupState.runs.some((run) => !baselineRunIds.has(run.id))) throw new Error("Live reports were not selectively cleaned.");
	if (fixtureNodeId) {
		await call("delete_node", { nodeId: fixtureNodeId });
		fixtureNodeId = undefined;
	}
	await cleanupCodeFixtures();
	console.log(
		`[testing-live] PASS — ${requiredTools.length}/${requiredTools.length} tools live-tested; visual comparison, performance budgets, scene assertions, suite/case authoring, active cancellation, report export, connected-player execution, project-code cancellation, and exact cleanup verified.`
	);
} catch (error) {
	console.error(`[testing-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		player?.close();
		if (labStarted) await call("stop_device_lab", { confirm: true });
		if (baselineSettings) {
			let state = await call("get_testing_state");
			for (const suite of state.suites.filter((candidate) => !baselineSuiteIds.has(candidate.id))) {
				state = await call("delete_test_suite", { expectedRevision: state.revision, suiteId: suite.id, confirm: true });
			}
			suiteCreated = false;
			if (JSON.stringify(state.settings) !== JSON.stringify(baselineSettings)) {
				state = await call("set_testing_settings", { expectedRevision: state.revision, settings: baselineSettings });
			}
			const remaining = state.runs.filter((run) => !baselineRunIds.has(run.id)).map((run) => run.id);
			if (remaining.length) await call("clear_testing_runs", { expectedRevision: state.revision, runIds: remaining, confirm: true });
		} else if (suiteCreated) {
			const state = await call("get_testing_state");
			if (state.suites.some((suite) => suite.id === suiteId)) await call("delete_test_suite", { expectedRevision: state.revision, suiteId, confirm: true });
		}
		if (fixtureNodeId) await call("delete_node", { nodeId: fixtureNodeId });
		await cleanupCodeFixtures();
	} catch (cleanupError) {
		console.error(`[testing-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}
