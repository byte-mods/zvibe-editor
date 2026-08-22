#!/usr/bin/env node
/** Real stdio/editor lifecycle for Mobile touch authoring/runtime, deployment settings, target audit, strict guards, and exact cleanup. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
	if (failed !== expectError) {
		throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	}
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

async function listTools() {
	const tools = [];
	let cursor;
	do {
		const response = await rpc("tools/list", cursor ? { cursor } : {});
		if (response.error) throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
		tools.push(...(response.result?.tools ?? []));
		cursor = response.result?.nextCursor;
	} while (cursor);
	return tools;
}

const requiredTools = [
	"get_mobile_capabilities",
	"get_touch_controls_configuration",
	"set_touch_controls_configuration",
	"create_touch_control",
	"set_touch_control",
	"delete_touch_control",
	"validate_touch_controls",
	"simulate_touch_control",
	"get_touch_controls_runtime",
	"get_mobile_deployment_configuration",
	"set_mobile_deployment_configuration",
	"validate_mobile_target",
	"plan_mobile_workflow",
	"get_mobile_workflow_plan",
	"execute_mobile_workflow_plan",
	"get_mobile_job",
	"list_mobile_jobs",
	"cancel_mobile_job",
	"list_mobile_artifacts",
	"list_mobile_devices",
];

const suffix = `${Date.now()}-${process.pid}`;
const mapName = `Mobile Live ${suffix}`;
const touchPath = `<touch>/mobileLive${suffix}`;
let inputMap = null;
let baselineTouch = null;
let baselineDeployment = null;
let baselineInputSettings = null;
let undoCount = 0;
let mobileScaffoldCreated = false;
let mobileJobId = null;

function touchGlobal(configuration) {
	return {
		enabled: configuration.enabled,
		visibleInEditor: configuration.visibleInEditor,
		respectSafeArea: configuration.respectSafeArea,
		opacity: configuration.opacity,
	};
}

function inputSettingsChanges(settings) {
	const { version: _version, revision: _revision, ...changes } = settings;
	return changes;
}

function deploymentChanges(configuration) {
	return {
		android: {
			variant: configuration.android.variant,
			format: configuration.android.format,
			applicationId: configuration.android.applicationId,
			launchActivity: configuration.android.launchActivity,
			gradleTask: configuration.android.gradleTask ?? null,
			signing: {
				enabled: configuration.android.signing.enabled,
				keystorePathEnvironment: configuration.android.signing.keystorePathEnvironment ?? null,
				keystorePasswordEnvironment: configuration.android.signing.keystorePasswordEnvironment ?? null,
				keyAliasEnvironment: configuration.android.signing.keyAliasEnvironment ?? null,
				keyPasswordEnvironment: configuration.android.signing.keyPasswordEnvironment ?? null,
			},
			store: {
				credentialPathEnvironment: configuration.android.store.credentialPathEnvironment ?? null,
				track: configuration.android.store.track,
				releaseStatus: configuration.android.store.releaseStatus,
			},
		},
		ios: {
			variant: configuration.ios.variant,
			applicationId: configuration.ios.applicationId,
			workspace: configuration.ios.workspace,
			scheme: configuration.ios.scheme,
			archivePath: configuration.ios.archivePath,
			exportDirectory: configuration.ios.exportDirectory,
			exportMethod: configuration.ios.exportMethod,
			signing: {
				enabled: configuration.ios.signing.enabled,
				teamIdEnvironment: configuration.ios.signing.teamIdEnvironment ?? null,
				identityEnvironment: configuration.ios.signing.identityEnvironment ?? null,
			},
			store: { apiKeyPathEnvironment: configuration.ios.store.apiKeyPathEnvironment ?? null, submitForReview: configuration.ios.store.submitForReview },
		},
	};
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mobile-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath || !status.activeScenePath) {
		throw new Error("A ready disposable project editor with an active scene is required for Mobile live verification.");
	}
	const capabilities = await call("get_mobile_capabilities");
	if (capabilities.version !== 1 || !capabilities.targets?.includes("android") || !capabilities.targets?.includes("ios") || !capabilities.workflows?.includes("store-submit")) {
		throw new Error("Mobile capabilities are incomplete.");
	}
	if (!capabilities.security?.includes("no shell") || !capabilities.boundaries?.includes("store review outcome")) {
		throw new Error("Mobile security/provider boundaries are incomplete.");
	}

	baselineTouch = await call("get_touch_controls_configuration");
	baselineDeployment = await call("get_mobile_deployment_configuration");
	baselineInputSettings = (await call("get_input_system_settings")).settings;
	inputMap = await call("create_input_action_map", {
		name: mapName,
		enabled: true,
		actions: [{ name: "Mobile Live Jump", type: "button", expectedControlType: "button", bindings: [{ name: "Touch", path: touchPath }] }],
		controlSchemes: [{ name: "Touch", devices: ["touch"] }],
	});
	inputMap = await call("set_input_action_map", { mapId: inputMap.id, expectedRevision: inputMap.revision, name: mapName, enabled: true });
	const created = await call("create_touch_control", {
		expectedRevision: baselineTouch.revision,
		control: { name: `Mobile Live Jump ${suffix}`, type: "button", controlPath: touchPath, label: "Jump", rect: { x: 0.78, y: 0.7, width: 0.16, height: 0.16 } },
	});
	undoCount++;
	await call("simulate_touch_control", { id: created.control.id, phase: "press" });
	await call("simulate_touch_control", { id: created.control.id, phase: "release" });
	const jumpActionId = inputMap.actions[0].id;
	const jumpBindingId = inputMap.actions[0].bindings[0].id;
	const touchSchemeId = inputMap.controlSchemes[0].id;
	let authored = await call("create_input_action", {
		mapId: inputMap.id,
		expectedRevision: inputMap.revision,
		action: { id: "mcp-move", name: "Mobile Live Move", type: "value", expectedControlType: "axis", enabled: true, bindings: [] },
	});
	inputMap.revision = authored.mapRevision;
	authored = await call("set_input_action", {
		mapId: inputMap.id,
		actionId: "mcp-move",
		expectedRevision: inputMap.revision,
		changes: { name: "Mobile Live Move Updated", initialStateCheck: true },
	});
	inputMap.revision = authored.mapRevision;
	authored = await call("create_input_action_binding", {
		mapId: inputMap.id,
		actionId: "mcp-move",
		expectedRevision: inputMap.revision,
		binding: { id: "mcp-move-binding", name: "Keyboard Move", path: "<keyboard>/space", groups: ["Keyboard"] },
	});
	inputMap.revision = authored.mapRevision;
	authored = await call("set_input_action_binding", {
		mapId: inputMap.id,
		actionId: "mcp-move",
		bindingId: "mcp-move-binding",
		expectedRevision: inputMap.revision,
		changes: { name: "Keyboard Move Updated", path: "<keyboard>/space", processors: [{ type: "scale", factor: 1 }] },
	});
	inputMap.revision = authored.mapRevision;
	authored = await call("create_input_control_scheme", {
		mapId: inputMap.id,
		expectedRevision: inputMap.revision,
		scheme: { id: "mcp-keyboard", name: "Keyboard", devices: ["keyboard"] },
	});
	inputMap.revision = authored.mapRevision;
	authored = await call("set_input_control_scheme", {
		mapId: inputMap.id,
		schemeId: "mcp-keyboard",
		expectedRevision: inputMap.revision,
		changes: { name: "Keyboard", devices: ["keyboard", "mouse"] },
	});
	inputMap.revision = authored.mapRevision;
	const manualSettings = await call("set_input_system_settings", { expectedRevision: baselineInputSettings.revision, changes: { updateMode: "manual" } });
	let currentInputSettings = manualSettings.settings;
	const inputRuntime = await call("get_input_runtime", { offset: 0, limit: 128 });
	if (!inputRuntime.maps.some((map) => map.id === inputMap.id)) throw new Error("Input runtime did not load the authored map.");
	await call("set_input_runtime_map_enabled", { mapId: inputMap.id, enabled: false });
	await call("set_input_runtime_map_enabled", { mapId: inputMap.id, enabled: true });
	await call("set_input_runtime_action_enabled", { mapId: inputMap.id, actionId: "mcp-move", enabled: false });
	await call("set_input_runtime_action_enabled", { mapId: inputMap.id, actionId: "mcp-move", enabled: true });
	await call("set_input_runtime_control_scheme", { mapId: inputMap.id, schemeId: "mcp-keyboard" });
	await call("simulate_input_control", { path: "<keyboard>/space", value: 1 });
	await call("update_input_runtime", { deltaSeconds: 0.016, limit: 128 });
	const actionRuntime = await call("read_input_action_runtime", { mapId: inputMap.id, actionId: "mcp-move" });
	if (actionRuntime.value !== 1) throw new Error(`Input action runtime did not read the simulated value: ${JSON.stringify(actionRuntime)}`);
	await call("clear_simulated_input_control", { path: "<keyboard>/space" });
	await call("simulate_input_touch", { pressed: true, x: 0.25, y: 0.75 });
	await call("simulate_input_touch", { pressed: false, x: 0.25, y: 0.75 });
	const override = await call("apply_input_binding_override", { mapId: inputMap.id, actionId: jumpActionId, bindingId: jumpBindingId, path: "<keyboard>/enter" });
	const savedOverrides = await call("save_input_binding_overrides");
	if (!override.applied || savedOverrides.byteLength < 1) throw new Error("Input binding override did not serialize.");
	await call("clear_input_binding_override", { mapId: inputMap.id, actionId: jumpActionId, bindingId: jumpBindingId });
	await call("load_input_binding_overrides", { json: savedOverrides.json, replace: true });
	await call("clear_input_binding_override", { mapId: inputMap.id, actionId: jumpActionId });
	const inputTrace = await call("get_input_action_trace", { offset: 0, limit: 128 });
	if (!Array.isArray(inputTrace.events ?? inputTrace)) throw new Error("Input action trace did not return bounded evidence.");
	await call("clear_input_action_trace", { confirm: true });
	const wrapper = await call("generate_input_action_wrapper", { mapId: inputMap.id });
	if (!wrapper.source.includes("Mobile Live Move Updated")) throw new Error("Input Action TypeScript wrapper omitted the authored action.");
	authored = await call("delete_input_action_binding", {
		mapId: inputMap.id,
		actionId: "mcp-move",
		bindingId: "mcp-move-binding",
		expectedRevision: inputMap.revision,
		confirm: true,
	});
	inputMap.revision = authored.mapRevision;
	authored = await call("delete_input_action", { mapId: inputMap.id, actionId: "mcp-move", expectedRevision: inputMap.revision, confirm: true });
	inputMap.revision = authored.mapRevision;
	authored = await call("delete_input_control_scheme", { mapId: inputMap.id, schemeId: "mcp-keyboard", expectedRevision: inputMap.revision, confirm: true });
	inputMap.revision = authored.mapRevision;
	await call("set_input_runtime_control_scheme", { mapId: inputMap.id, schemeId: touchSchemeId });
	currentInputSettings = (await call("set_input_system_settings", { expectedRevision: currentInputSettings.revision, changes: inputSettingsChanges(baselineInputSettings) }))
		.settings;
	if (JSON.stringify({ ...currentInputSettings, revision: baselineInputSettings.revision }) !== JSON.stringify(baselineInputSettings)) {
		throw new Error("Input System settings did not restore semantically.");
	}

	let touch = await call("set_touch_controls_configuration", {
		expectedRevision: created.configuration.revision,
		changes: { enabled: true, visibleInEditor: true, respectSafeArea: true, opacity: 0.8 },
	});
	undoCount++;
	const staleTouch = await call("set_touch_control", { expectedRevision: baselineTouch.revision, id: created.control.id, changes: { label: "Stale" } }, true);
	if (!String(staleTouch).includes("revision is stale")) throw new Error("Touch Control stale revision did not reject.");
	touch = (await call("set_touch_control", { expectedRevision: touch.revision, id: created.control.id, changes: { buttonValue: 0.75, pressedColor: "#22c55edd" } }))
		.configuration;
	undoCount++;
	const validation = await call("validate_touch_controls");
	if (!validation.valid || validation.boundControlCount < 1 || validation.configuration.revision !== touch.revision) {
		throw new Error("Touch Control/Input Actions validation evidence is incomplete.");
	}
	const pressed = await call("simulate_touch_control", { id: created.control.id, phase: "press" });
	if (pressed.value !== 0.75) throw new Error("Touch Control press did not reach Input Actions.");
	await call("simulate_touch_control", { id: created.control.id, phase: "release" });
	const runtime = await call("get_touch_controls_runtime");
	if (runtime.revision !== touch.revision || runtime.controls?.some((control) => control.id === created.control.id && control.active)) {
		throw new Error("Touch Control runtime/release evidence is incomplete.");
	}
	const deletedTouch = await call("delete_touch_control", { expectedRevision: touch.revision, id: created.control.id, confirm: true });
	undoCount++;
	if (!deletedTouch.deleted || deletedTouch.configuration.controls.some((control) => control.id === created.control.id)) {
		throw new Error(`Touch Control deletion evidence is incomplete: ${JSON.stringify(deletedTouch)}`);
	}

	const deployment = await call("set_mobile_deployment_configuration", {
		expectedRevision: baselineDeployment.revision,
		changes: {
			android: { variant: "debug", format: "apk", signing: { enabled: false }, store: { track: "internal", releaseStatus: "draft" } },
			ios: { variant: "debug", exportMethod: "development", signing: { enabled: false }, store: { submitForReview: false } },
		},
	});
	undoCount++;
	if (JSON.stringify(deployment).includes("password") && JSON.stringify(deployment).includes("top-secret")) {
		throw new Error("Deployment response exposed a secret value.");
	}
	const staleDeployment = await call("set_mobile_deployment_configuration", { expectedRevision: baselineDeployment.revision, changes: { android: { format: "aab" } } }, true);
	if (!String(staleDeployment).includes("revision is stale")) throw new Error("Mobile Deployment stale revision did not reject.");
	const target = await call("validate_mobile_target", { target: "android" });
	if (target.target !== "android" || target.configurationRevision !== deployment.revision || !target.ready || !target.commands) {
		throw new Error("Mobile target audit evidence is incomplete.");
	}
	const deviceInventory = await call("list_mobile_devices", { target: "ios", offset: 0, limit: 10 });
	if (deviceInventory.target !== "ios" || !Array.isArray(deviceInventory.devices) || !deviceInventory.devices[0]?.id)
		throw new Error("iOS device inventory evidence is incomplete.");
	let scaffold = await call("get_platform_scaffold", { target: "ios" });
	if (!scaffold.exists) {
		scaffold = await call("generate_platform_scaffold", {
			target: "ios",
			expectedRevision: 0,
			settings: { baseBuildScript: "build", deploymentTarget: "16.0", deviceFamily: "universal", orientation: "landscape", syncNativeProject: false, projectType: "swift" },
		});
		mobileScaffoldCreated = true;
	}
	const workflowPlan = await call("plan_mobile_workflow", {
		target: "ios",
		operation: "launch",
		expectedRevision: deployment.revision,
		expectedScaffoldRevision: scaffold.revision,
		deviceId: deviceInventory.devices[0].id,
	});
	const inspectedPlan = await call("get_mobile_workflow_plan", { planId: workflowPlan.id });
	if (inspectedPlan.id !== workflowPlan.id || inspectedPlan.operation !== "launch") throw new Error("Mobile workflow plan readback is incomplete.");
	const mobileJob = await call("execute_mobile_workflow_plan", { planId: workflowPlan.id, confirm: true });
	mobileJobId = mobileJob.id;
	const inspectedJob = await call("get_mobile_job", { jobId: mobileJobId });
	if (inspectedJob.id !== mobileJobId || inspectedJob.operation !== "launch") throw new Error("Mobile workflow job readback is incomplete.");
	const canceledJob = await call("cancel_mobile_job", { jobId: mobileJobId, confirm: true });
	if (canceledJob.job?.id !== mobileJobId) throw new Error(`Mobile workflow cancellation evidence is incomplete: ${JSON.stringify(canceledJob)}`);
	const artifacts = await call("list_mobile_artifacts", { target: "android", limit: 10 });
	const jobs = await call("list_mobile_jobs", { target: "android", limit: 10 });
	if (!Array.isArray(artifacts.artifacts) || !Array.isArray(jobs.jobs)) throw new Error("Mobile artifact/job pagination is incomplete.");

	const unknown = await call("get_mobile_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Mobile unknown-field guard did not reject before editor I/O.");
	const unsafe = await call(
		"set_mobile_deployment_configuration",
		{ expectedRevision: deployment.revision, changes: { android: { signing: { enabled: true, keystorePassword: "raw-secret" } } } },
		true
	);
	if (!String(unsafe).includes("-32602")) throw new Error("Mobile raw-secret schema guard did not reject.");

	for (; undoCount > 0; undoCount--) await call("undo_editor");
	if (mobileScaffoldCreated) {
		const currentScaffold = await call("get_platform_scaffold", { target: "ios" });
		await call("remove_platform_scaffold", { target: "ios", expectedRevision: currentScaffold.revision, confirm: true });
		mobileScaffoldCreated = false;
	}
	await call("delete_input_action_map", { mapId: inputMap.id, expectedRevision: inputMap.revision, confirm: true });
	inputMap = null;
	const finalTouch = await call("get_touch_controls_configuration");
	const finalDeployment = await call("get_mobile_deployment_configuration");
	if (JSON.stringify(finalTouch) !== JSON.stringify(baselineTouch) || JSON.stringify(finalDeployment) !== JSON.stringify(baselineDeployment)) {
		throw new Error("Mobile live scenario did not restore exact baseline authoring.");
	}

	console.log(
		"[mobile-live] PASS — 20/20 strict tools, Touch/Input Actions authoring and runtime, exact revisions, deployment references, target audit, pagination, schema guards, Undo, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[mobile-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exitCode = 1;
} finally {
	try {
		if (mobileJobId) await call("cancel_mobile_job", { jobId: mobileJobId, confirm: true }).catch(() => undefined);
		if (mobileScaffoldCreated) {
			const currentScaffold = await call("get_platform_scaffold", { target: "ios" });
			if (currentScaffold.exists) await call("remove_platform_scaffold", { target: "ios", expectedRevision: currentScaffold.revision, confirm: true });
			mobileScaffoldCreated = false;
		}
		for (; undoCount > 0; undoCount--) await call("undo_editor");
		if (inputMap) {
			const maps = await call("list_input_action_maps");
			const current = maps.maps.find((candidate) => candidate.id === inputMap.id);
			if (current) await call("delete_input_action_map", { mapId: current.id, expectedRevision: current.revision, confirm: true });
		}
		if (baselineTouch) {
			const current = await call("get_touch_controls_configuration");
			if (JSON.stringify(current) !== JSON.stringify(baselineTouch) && current.controls.length === baselineTouch.controls.length) {
				await call("set_touch_controls_configuration", { expectedRevision: current.revision, changes: touchGlobal(baselineTouch) });
			}
		}
		if (baselineDeployment) {
			const current = await call("get_mobile_deployment_configuration");
			if (JSON.stringify(current) !== JSON.stringify(baselineDeployment)) {
				await call("set_mobile_deployment_configuration", { expectedRevision: current.revision, changes: deploymentChanges(baselineDeployment) });
			}
		}
		if (baselineInputSettings) {
			const current = (await call("get_input_system_settings")).settings;
			if (JSON.stringify({ ...current, revision: baselineInputSettings.revision }) !== JSON.stringify(baselineInputSettings)) {
				await call("set_input_system_settings", { expectedRevision: current.revision, changes: inputSettingsChanges(baselineInputSettings) });
			}
		}
	} catch (cleanupError) {
		console.error(`[mobile-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.stdin.end();
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}
