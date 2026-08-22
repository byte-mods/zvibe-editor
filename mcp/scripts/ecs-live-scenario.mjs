#!/usr/bin/env node
/** Real stdio/editor lifecycle for ECS schema authoring, baking, scheduling, streaming, commands, strict guards, and semantic cleanup. */
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

function rpc(method, params, timeoutMs = 90_000) {
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

function semanticConfiguration(configuration) {
	const result = structuredClone(configuration);
	delete result.revision;
	return result;
}

function replacementConfiguration(configuration) {
	return {
		settings: configuration.settings,
		componentTypes: configuration.componentTypes,
		systems: configuration.systems,
		sections: configuration.sections,
		typeRegistrationPolicies: configuration.typeRegistrationPolicies,
	};
}

function runtimeAction(status) {
	return status === "running" ? "start" : status === "stopped" ? "stop" : "pause";
}

async function inspect() {
	return call("inspect_ecs");
}

async function author(name, arguments_) {
	const current = await inspect();
	return call(name, { expectedRevision: current.configuration.revision, expectedFingerprint: current.fingerprint, ...arguments_ });
}

const requiredTools = [
	"inspect_ecs",
	"replace_ecs_configuration",
	"delete_ecs_configuration",
	"set_ecs_settings",
	"create_ecs_component_type",
	"set_ecs_component_type",
	"delete_ecs_component_type",
	"create_ecs_field",
	"set_ecs_field",
	"delete_ecs_field",
	"create_ecs_system",
	"set_ecs_system",
	"delete_ecs_system",
	"create_ecs_section",
	"set_ecs_section",
	"delete_ecs_section",
	"validate_ecs",
	"bake_ecs",
	"control_ecs_runtime",
	"step_ecs_runtime",
	"queue_ecs_runtime_command",
	"playback_ecs_runtime_commands",
	"query_ecs_entities",
	"inspect_ecs_schedule",
];
const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-18);
const componentId = `ecsLiveMotion${suffix}`.slice(0, 64);
const sectionId = `ecsLiveSection${suffix}`.slice(0, 64);
const systemId = `ecsLiveSystem${suffix}`.slice(0, 64);
const operationId = `ecsLiveOp${suffix}`.slice(0, 64);
const cloneId = `ecs-live-clone-${suffix}`;
const registrationAssembly = `Mcp.Live${suffix}`;
const fixtureName = `ECS Live Fixture ${suffix}`;
let baseline;
let fixtureId;
let runtimePaused = false;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ecs-live-scenario", version: "1.0.0" } });
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
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for the ECS live scenario.");
	baseline = await inspect();
	let current = await inspect();
	await call("set_ecs_settings", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		settings: { traceLimit: current.configuration.settings.traceLimit },
	});
	current = await inspect();
	await call("create_ecs_component_type", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		component: {
			id: componentId,
			name: "Live Motion",
			assembly: registrationAssembly,
			fields: [
				{ id: "position", name: "Position", type: "vec3", defaultValue: [0, 0, 0] },
				{ id: "velocity", name: "Velocity", type: "vec3", defaultValue: [1, 0, 0] },
			],
		},
	});
	current = await inspect();
	await call("set_ecs_component_type", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		componentId,
		changes: { name: "Live Motion Updated" },
	});
	current = await inspect();
	await call("create_ecs_field", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		componentId,
		field: { id: "temporary", name: "Temporary", type: "f64", defaultValue: 0 },
	});
	current = await inspect();
	await call("set_ecs_field", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		componentId,
		fieldId: "temporary",
		changes: { name: "Temporary Updated", defaultValue: 1 },
	});
	current = await inspect();
	await call("delete_ecs_field", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		componentId,
		fieldId: "temporary",
		confirm: true,
	});
	current = await inspect();
	await call("create_ecs_section", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		section: { id: sectionId, name: "Live Section", autoLoad: true, priority: 100 },
	});
	current = await inspect();
	await call("set_ecs_section", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		sectionId,
		changes: { name: "Live Section Updated", priority: 99 },
	});
	const fixture = await call("create_primitive_mesh", { type: "box", name: fixtureName, position: [0, 0, 0], options: { size: 25 } });
	fixtureId = fixture.id;
	const stack = await call("inspect_game_object_components", { nodeId: fixtureId });
	await call("add_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: stack.fingerprint,
		type: "entity",
		name: "Live Entity",
		data: {
			version: 2,
			archetype: "LiveMover",
			sectionId,
			values: {},
			components: { [componentId]: { position: [0, 0, 0], velocity: [1, 0, 0] } },
			bakingEnabled: true,
		},
	});
	current = await inspect();
	await call("create_ecs_system", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		system: {
			id: systemId,
			name: "Live Integrate",
			enabled: true,
			phase: "fixed",
			order: 0,
			query: { all: [componentId], any: [], none: [] },
			reads: [{ componentId, fieldId: "velocity" }],
			writes: [{ componentId, fieldId: "position" }],
			dependsOn: [],
			operations: [
				{
					id: operationId,
					kind: "integrate",
					target: { componentId, fieldId: "position" },
					source: { componentId, fieldId: "velocity" },
					constant: 1,
					useDeltaTime: true,
				},
			],
		},
	});
	current = await inspect();
	await call("set_ecs_system", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		systemId,
		changes: { name: "Live Integrate Updated", order: 1 },
	});
	current = await inspect();
	await call("set_ecs_type_registration_policy", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		policy: { assembly: registrationAssembly, disableAutoRegistration: true, registeredTypeIds: [componentId] },
	});

	current = await inspect();
	if (current.runtime?.status === "running") {
		await call("control_ecs_runtime", { expectedGeneration: current.runtime.generation, expectedStatus: "running", action: "pause" });
		runtimePaused = true;
	}
	const stale = await call(
		"set_ecs_settings",
		{ expectedRevision: current.configuration.revision - 1, expectedFingerprint: current.fingerprint, settings: { traceLimit: current.configuration.settings.traceLimit } },
		true
	);
	if (!String(stale).includes("revision is stale")) throw new Error("ECS stale authoring mutation did not reject.");
	const unknown = await call("inspect_ecs", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("ECS read tool did not reject an unknown input field.");

	const validation = await call("validate_ecs");
	if (!validation.valid || !validation.schedule?.phases?.fixed) throw new Error("ECS validation or fixed-phase schedule evidence is incomplete.");
	current = await inspect();
	const baked = await call("bake_ecs", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		expectedGeneration: current.runtime.generation,
		mode: "full",
		includeValues: true,
	});
	const fixtureChunk = baked.world.chunks.find((chunk) => chunk.entityIds.includes(fixtureId));
	const fixtureLease = baked.world.sourceLeases?.[fixtureId];
	if (!fixtureChunk || !fixtureLease?.sourceHash) throw new Error("Full bake did not expose the fixture's typed chunk and source lease.");
	const incrementallyBaked = await call("bake_ecs", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		expectedGeneration: baked.runtime.generation,
		mode: "incremental",
		expectedSourceHashes: { [fixtureId]: fixtureLease.sourceHash },
		includeValues: true,
	});
	if (!incrementallyBaked.world.chunks.some((chunk) => chunk.entityIds.includes(fixtureId))) throw new Error("Incremental bake lost the guarded fixture.");

	const stepped = await call("step_ecs_runtime", {
		expectedGeneration: incrementallyBaked.runtime.generation,
		expectedStatus: incrementallyBaked.runtime.status,
		deltaSeconds: 0.1,
		useWorkers: false,
	});
	if (stepped.result.scalarWrites < 1 || stepped.result.backend !== "main-thread") throw new Error("ECS compiled main-thread step evidence is incomplete.");
	let queried = await call("query_ecs_entities", { all: [componentId], sectionId, includeValues: true, limit: 10 });
	if (queried.total !== 1 || queried.entities[0].entityId !== fixtureId || queried.entities[0].values[`${componentId}.position`][0] <= 0) {
		throw new Error("ECS typed query did not expose the integrated fixture value.");
	}
	const schedule = await call("inspect_ecs_schedule");
	if (!schedule.schedule.phases.fixed.batches.some((batch) => batch.systemIds.includes(systemId)) || !schedule.traces.some((trace) => trace.systemIds.includes(systemId))) {
		throw new Error("ECS compiled schedule or trace omitted the live system.");
	}

	let generation = stepped.runtime.generation;
	await call("queue_ecs_runtime_command", { expectedGeneration: generation, command: { kind: "instantiate-entity", sourceEntityId: fixtureId, entityId: cloneId } });
	let playback = await call("playback_ecs_runtime_commands", { expectedGeneration: generation });
	generation = playback.runtime.generation;
	queried = await call("query_ecs_entities", { all: [componentId], sectionId, limit: 10 });
	if (queried.total !== 2) throw new Error("Deferred ECS instantiate did not publish atomically.");
	await call("queue_ecs_runtime_command", { expectedGeneration: generation, command: { kind: "set-section-loaded", sectionId, loaded: false } });
	playback = await call("playback_ecs_runtime_commands", { expectedGeneration: generation });
	generation = playback.runtime.generation;
	if ((await call("query_ecs_entities", { all: [componentId], sectionId, loadedOnly: true, limit: 10 })).total !== 0) {
		throw new Error("ECS section unload did not exclude entities from loaded-only queries.");
	}
	await call("queue_ecs_runtime_command", { expectedGeneration: generation, command: { kind: "set-section-loaded", sectionId, loaded: true } });
	playback = await call("playback_ecs_runtime_commands", { expectedGeneration: generation });
	generation = playback.runtime.generation;
	await call("queue_ecs_runtime_command", { expectedGeneration: generation, command: { kind: "destroy-entity", entityId: cloneId, confirm: true } });
	playback = await call("playback_ecs_runtime_commands", { expectedGeneration: generation });
	if ((await call("query_ecs_entities", { all: [componentId], sectionId, limit: 10 })).total !== 1) throw new Error("Deferred ECS destroy cleanup failed.");

	current = await inspect();
	await call("delete_ecs_system", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		systemId,
		confirm: true,
	});
	await call("delete_node", { nodeId: fixtureId });
	fixtureId = undefined;
	current = await inspect();
	await call("delete_ecs_section", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		sectionId,
		confirm: true,
	});
	current = await inspect();
	await call("delete_ecs_type_registration_policy", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		assembly: registrationAssembly,
		confirm: true,
	});
	current = await inspect();
	await call("delete_ecs_component_type", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		componentId,
		confirm: true,
	});
	if (!baseline.authored) {
		await author("delete_ecs_configuration", { confirm: true });
	}
	current = await inspect();
	if (JSON.stringify(semanticConfiguration(current.configuration)) !== JSON.stringify(semanticConfiguration(baseline.configuration))) {
		throw new Error("ECS live cleanup did not restore the semantic authoring baseline.");
	}
	const desiredStatus = baseline.runtime?.status ?? "stopped";
	if (current.runtime && current.runtime.status !== desiredStatus) {
		await call("control_ecs_runtime", {
			expectedGeneration: current.runtime.generation,
			expectedStatus: current.runtime.status,
			action: runtimeAction(desiredStatus),
		});
	}
	runtimePaused = false;
	console.log(
		`[ecs-live] PASS — 24/24 strict tools, exact leases, asset/schema CRUD, full/incremental typed-chunk baking, fixed schedule/trace, field integration, section streaming, atomic instantiate/destroy, and semantic cleanup verified.`
	);
} catch (error) {
	console.error(`[ecs-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (fixtureId) await call("delete_node", { nodeId: fixtureId });
		if (baseline) {
			let current = await inspect();
			if (JSON.stringify(semanticConfiguration(current.configuration)) !== JSON.stringify(semanticConfiguration(baseline.configuration))) {
				await call("replace_ecs_configuration", {
					expectedRevision: current.configuration.revision,
					expectedFingerprint: current.fingerprint,
					configuration: replacementConfiguration(baseline.configuration),
				});
				current = await inspect();
			}
			if (!baseline.authored && current.authored) {
				await call("delete_ecs_configuration", {
					expectedRevision: current.configuration.revision,
					expectedFingerprint: current.fingerprint,
					confirm: true,
				});
				current = await inspect();
			}
			const desiredStatus = baseline.runtime?.status ?? "stopped";
			if ((runtimePaused || current.runtime?.status !== desiredStatus) && current.runtime) {
				await call("control_ecs_runtime", {
					expectedGeneration: current.runtime.generation,
					expectedStatus: current.runtime.status,
					action: runtimeAction(desiredStatus),
				});
			}
		}
	} catch (cleanupError) {
		console.error(`[ecs-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}
