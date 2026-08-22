#!/usr/bin/env node
/**
 * Runs a real live MCP scenario against a RUNNING Zvibe Editor project window.
 *
 * The parity matrix only lets a row reach **Complete** once "a live MCP
 * scenario has been verified". That check used to be manual, which is why rows
 * drifted from reality. This makes it a repeatable command.
 *
 * Prerequisite — the editor must be running with a PROJECT open, not just the
 * dashboard (the MCP HTTP bridge only starts for a project window):
 *
 *   yarn start /absolute/path/to/project.bjseditor
 *
 * Usage:
 *   node scripts/live-scenario.mjs                 # connectivity + status
 *   node scripts/live-scenario.mjs --tools a,b,c   # assert tools are callable
 *   node scripts/live-scenario.mjs --components    # component round-trip
 *   node scripts/live-scenario.mjs --render-debug-views [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --subsurface-mask [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --subsurface-transport [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --reflection-probe-blending [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --probuilder-bevel [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --uv-charts [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --probuilder-loop-cut [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --probuilder-detach [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --probuilder-smoothing [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --probuilder-vertex-colors [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --probuilder-integrity [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --probuilder-pivot [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --probuilder-editable-source [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --terrain-remote-streaming [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --spline-camera-timeline [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --vehicle-anti-roll [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --vehicle-tire-friction [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --vehicle-drivetrain [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --game-script-fixed-step [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --custom-physics-fixed-step [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --cloth-physics-completion [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --physics-contact-history [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --physics-force-visualization [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --physics2d-completion [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --development-diagnostics
 *   node scripts/live-scenario.mjs --physics2d-compound-polygon [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --tile-paint-viewport [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --sprite-shape [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --tilemap-collider [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --gui-authoring [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --gui-atlas-text [--hold-ms 60000]
 *   node scripts/live-scenario.mjs --gui-retained-ui [--hold-ms 60000]
 *
 * Every mutation is undone before exit, so a scenario never leaves residue in
 * the user's project. Exits non-zero with a precise reason on any failure.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server", "index.mjs");

const argv = process.argv.slice(2);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? (argv[index + 1] ?? "") : null;
};
const has = (name) => argv.includes(name);

if (!existsSync(SERVER)) {
	console.error("[live-scenario] bundled server missing — run: yarn workspace babylonjs-editor-mcp-server bundle");
	process.exit(2);
}

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) {
			continue;
		}
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});

let nextId = 1;
function rpc(method, params, timeoutMs = 60000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const text = response.result?.content?.[0]?.text ?? "";
	if (response.error || response.result?.isError || (typeof text === "string" && text.startsWith("MCP error"))) {
		const details = (typeof text === "string" && text.trim() ? text : JSON.stringify(response.error ?? response.result)).replace(/\s+/g, " ").slice(0, 2000);
		throw new Error(`${name}: ${details}`);
	}
	return text;
}

async function expectCallFailure(name, args, expected) {
	try {
		await call(name, args);
	} catch (error) {
		if (expected.test(error.message)) {
			return error.message;
		}
		throw error;
	}
	throw new Error(`${name} unexpectedly accepted an invalid live request`);
}

function flattenHierarchy(nodes) {
	return nodes.flatMap((node) => [node, ...flattenHierarchy(Array.isArray(node.children) ? node.children : [])]);
}

const failures = [];
let restore = null;

try {
	await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live-scenario", version: "1.0.0" } });
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	// 1. Connectivity — a dashboard-only editor fails here with "fetch failed".
	let status;
	try {
		status = JSON.parse(await call("get_editor_status"));
	} catch (error) {
		throw new Error(`no live editor reachable (${error.message}). Start one with: yarn start <project>.bjseditor`);
	}
	if (!status.ready) {
		throw new Error("editor responded but is not ready");
	}
	console.log(`[live-scenario] editor ready — project ${status.projectPath}`);
	console.log(`[live-scenario] active scene ${status.activeScenePath ?? "(none)"}`);

	// 2. Optional: assert specific tools are callable end to end.
	const toolList = flag("--tools");
	if (toolList) {
		for (const name of toolList
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)) {
			try {
				await call(name);
				console.log(`[live-scenario] ${name}: callable`);
			} catch (error) {
				failures.push(error.message);
			}
		}
	}

	// Portable equivalent of Unity 6.5 standalone development-build coverage
	// plus per-session oldest-serialization diagnostics. The disposable profile
	// proves both read surfaces through real external stdio without running a
	// package script or leaving an authored profile behind.
	if (has("--development-diagnostics")) {
		const serialization = JSON.parse(await call("get_project_serialization_session", { offset: 0, limit: 8 }));
		if (!serialization.oldest || serialization.loadedFileCount < 1 || serialization.totalLoadCount < serialization.loadedFileCount) {
			throw new Error(`serialization session omitted loaded-file evidence: ${JSON.stringify(serialization)}`);
		}
		const baseline = JSON.parse(await call("list_build_profiles"));
		const profileId = `codex-development-diagnostics-${process.pid}`;
		let createdRevision = null;
		restore = async () => {
			if (createdRevision !== null) {
				const current = JSON.parse(await call("list_build_profiles"));
				if (current.profiles.some((profile) => profile.id === profileId)) {
					await call("delete_build_profile", { expectedRevision: current.revision, id: profileId });
				}
				createdRevision = null;
			}
		};
		const created = JSON.parse(
			await call("create_build_profile", {
				expectedRevision: baseline.revision,
				id: profileId,
				name: `Codex Development Diagnostics ${process.pid}`,
				target: "electron",
				settings: { buildMode: "development", codeCoverage: true, electronPlatform: process.platform },
			})
		);
		createdRevision = created.configuration.revision;
		const coverage = JSON.parse(await call("get_development_build_coverage", { id: profileId, offset: 0, limit: 8 }));
		const environment = JSON.parse(await call("get_build_profile_environment", { id: profileId }));
		if (
			coverage.configured !== true ||
			coverage.compatible !== true ||
			coverage.profile?.settings?.codeCoverage !== true ||
			coverage.manifest !== null ||
			!coverage.reason?.includes("Build this exact profile") ||
			environment.environment?.BJS_EDITOR_CODE_COVERAGE !== "true" ||
			!environment.environment?.BJS_EDITOR_CODE_COVERAGE_MANIFEST?.includes("/.bjseditor/build-coverage/")
		) {
			throw new Error(`development coverage readback was incomplete: ${JSON.stringify({ coverage, environment })}`);
		}
		const traversalEvidence = await expectCallFailure("get_development_build_coverage", { id: profileId, path: "src/../secret.ts" }, /(unrecognized|invalid)/i);
		await call("delete_build_profile", { expectedRevision: createdRevision, id: profileId });
		createdRevision = null;
		restore = null;
		const finalConfiguration = JSON.parse(await call("list_build_profiles"));
		if (
			finalConfiguration.profiles.length !== baseline.profiles.length ||
			finalConfiguration.profiles.some((profile) => !baseline.profiles.some((entry) => entry.id === profile.id)) ||
			finalConfiguration.activeProfileId !== baseline.activeProfileId
		) {
			throw new Error(`development diagnostics cleanup mismatch: ${JSON.stringify({ baseline, finalConfiguration })}`);
		}
		console.log(
			`[live-scenario] serialization session: files=${serialization.loadedFileCount} reads=${serialization.totalLoadCount} oldest=${serialization.oldest.version} path=${serialization.oldest.path}`
		);
		console.log(`[live-scenario] development coverage: configured=true compatible=true manifest=pending runtime=${coverage.runtime.global}`);
		console.log(`[live-scenario] traversal rejection: ${traversalEvidence}`);
		console.log(`[live-scenario] development diagnostics cleanup: profiles=${finalConfiguration.profiles.length}`);
	}

	// Deterministic attached-script stepping in the real Play scene. This
	// disposable workflow proves automatic render suppression, fixed lifecycle
	// counts/delta evidence, strict schema rejection, and exact project cleanup.
	if (has("--game-script-fixed-step")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const node = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Fixed-step Probe ${process.pid}`,
				position: [0, 300, 0],
				options: { width: 25, height: 25, depth: 25 },
			})
		);
		const scriptPath = `src/__codex_fixed_step_${process.pid}.ts`;
		const scriptsEntryPath = "src/scripts.ts";
		const scriptsEntryBefore = JSON.parse(await call("read_script", { path: scriptsEntryPath })).content;
		const baselinePlaying = status.play.playing;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		let attached = false;
		let scriptCreated = false;
		let pausedByScenario = false;
		let fixtureExists = true;
		let attachmentRemoved = false;

		restore = async () => {
			const currentStatus = JSON.parse(await call("get_editor_status"));
			if (currentStatus.play.playing) {
				const currentControl = JSON.parse(await call("get_physics_simulation_control"));
				if (pausedByScenario && currentControl.paused) await call("set_physics_simulation_paused", { paused: false });
				await call("set_preview_play_mode", { action: "stop" });
			}
			pausedByScenario = false;
			if (attached) {
				await call("detach_script", { nodeId: node.id, path: scriptPath });
				attached = false;
				const remainingAttachments = JSON.parse(await call("list_attached_scripts", { nodeId: node.id })).scripts;
				if (remainingAttachments.some((entry) => entry.path === scriptPath)) {
					throw new Error(`fixed-step cleanup failed to detach the disposable script: ${JSON.stringify(remainingAttachments)}`);
				}
				attachmentRemoved = true;
			}
			if (fixtureExists) {
				try {
					await call("delete_node", { nodeId: node.id });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				fixtureExists = false;
			}
			if (scriptCreated) {
				try {
					await call("delete_script", { path: scriptPath, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				scriptCreated = false;
			}
			await call("write_script", { path: scriptsEntryPath, content: scriptsEntryBefore });
			if (baselinePlaying) {
				await call("set_preview_play_mode", { action: "play" });
				if (baselineControl.paused) await call("set_physics_simulation_paused", { paused: true });
			}
		};

		if (baselinePlaying) await call("set_preview_play_mode", { action: "stop" });
		await call("write_script", {
			path: scriptPath,
			content: `import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

export default class CodexFixedStepProbe {
	public constructor(public mesh: AbstractMesh) {}

	public onStart(): void {}

	public onUpdate(): void {
		this.mesh.metadata ??= {};
		this.mesh.metadata.codexFixedStepDeltaMs = this.mesh.getScene().getEngine().getDeltaTime();
	}
}
`,
		});
		scriptCreated = true;
		await call("attach_script", { nodeId: node.id, path: scriptPath });
		attached = true;
		await call("set_preview_play_mode", { action: "play" });
		const playStatus = JSON.parse(await call("get_editor_status"));
		if (!playStatus.play.canPlay) throw new Error(`preview did not reach a ready Play scene: ${JSON.stringify(playStatus.play)}`);

		const beforePause = JSON.parse(await call("get_physics_simulation_control"));
		if (beforePause.target !== "play" || beforePause.gameScripts.registeredScripts < 1) {
			throw new Error(`fixed-step controls did not resolve the live Play scene or its script: ${JSON.stringify(beforePause)}`);
		}
		if (!beforePause.paused) {
			await call("set_physics_simulation_paused", { paused: true });
			pausedByScenario = true;
		}
		const frozenBefore = JSON.parse(await call("get_script_runtime_diagnostics", { nodeId: node.id }));
		const frozenAfter = JSON.parse(await call("get_script_runtime_diagnostics", { nodeId: node.id }));
		const beforeScript = frozenBefore.scripts.find((entry) => entry.path === scriptPath);
		const frozenScript = frozenAfter.scripts.find((entry) => entry.path === scriptPath);
		if (!beforeScript || !frozenScript || frozenAfter.target !== "play" || frozenScript.diagnostics.onUpdateCalls !== beforeScript.diagnostics.onUpdateCalls) {
			throw new Error(`paused render delivery was not frozen or runtime diagnostics missed the Play script: ${JSON.stringify({ frozenBefore, frozenAfter })}`);
		}

		const unknownEvidence = await expectCallFailure("step_physics_simulation", { steps: 1, deltaSeconds: 0.02, gameScriptMagic: true }, /(unrecognized|invalid)/i);
		const stepped = JSON.parse(await call("step_physics_simulation", { steps: 3, deltaSeconds: 0.02 }));
		const afterDiagnostics = JSON.parse(await call("get_script_runtime_diagnostics", { nodeId: node.id }));
		const afterScript = afterDiagnostics.scripts.find((entry) => entry.path === scriptPath);
		if (
			stepped.target !== "play" ||
			stepped.stepped !== 3 ||
			stepped.advancedSeconds !== 0.06 ||
			stepped.gameScriptStep.updateCalls < 3 ||
			stepped.gameScripts.lastStepSeconds !== 0.02 ||
			!afterScript ||
			afterScript.diagnostics.onUpdateCalls !== beforeScript.diagnostics.onUpdateCalls + 3 ||
			afterScript.diagnostics.manualOnUpdateCalls !== beforeScript.diagnostics.manualOnUpdateCalls + 3 ||
			afterScript.diagnostics.lastManualDeltaSeconds !== 0.02
		) {
			throw new Error(`live fixed-step lifecycle/delta evidence was incomplete: ${JSON.stringify({ stepped, beforeScript, afterScript })}`);
		}

		await call("select_node", { nodeId: node.id });
		console.log(
			`[live-scenario] game-script fixed step: target=${stepped.target} steps=${stepped.stepped} delta=${stepped.gameScripts.lastStepSeconds}s starts=${stepped.gameScriptStep.startCalls} updates=${stepped.gameScriptStep.updateCalls} scriptUpdates=${afterScript.diagnostics.onUpdateCalls}`
		);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding fixed-step Play/Inspector evidence for ${holdMilliseconds}ms`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalScripts = JSON.parse(await call("list_scripts")).scripts;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (!attachmentRemoved || finalScripts.some((entry) => entry.path === scriptPath) || finalDiagnostics.meshes !== baselineDiagnostics.meshes) {
			throw new Error(`fixed-step cleanup left a script, attachment, or mesh: ${JSON.stringify({ attachmentRemoved, finalScripts, baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] game-script fixed-step cleanup: script=false attachment=false meshes=${finalDiagnostics.meshes} baselinePlay=${baselinePlaying}`);
	}

	// Shared Cloth and Physics 2D stepping in the real generated Play bundle.
	// This proves exact bundled ownership, paused automatic suppression, bounded
	// multi-frame evidence, strict rejection, and exact disposable cleanup.
	if (has("--custom-physics-fixed-step")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineCloths = JSON.parse(await call("list_cloths")).cloths.length;
		const baselineBodies = JSON.parse(await call("list_physics2d_bodies")).bodies.length;
		const baselinePlaying = status.play.playing;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		const clothId = `codex-custom-step-cloth-${process.pid}`;
		let cloth = null;
		let bodyNode = null;
		let bodyAttached = false;

		restore = async () => {
			const currentStatus = JSON.parse(await call("get_editor_status"));
			if (currentStatus.play.playing) {
				const currentControl = JSON.parse(await call("get_physics_simulation_control"));
				if (currentControl.paused) await call("set_physics_simulation_paused", { paused: false });
				await call("set_preview_play_mode", { action: "stop" });
			}
			if (bodyAttached && bodyNode) {
				try {
					const body = JSON.parse(await call("list_physics2d_bodies")).bodies.find((candidate) => candidate.nodeId === bodyNode.id);
					if (body) await call("remove_physics2d_body", { nodeId: bodyNode.id, expectedRevision: body.revision });
				} catch (error) {
					if (!/(No 2D physics body|not found)/i.test(error.message)) throw error;
				}
				bodyAttached = false;
			}
			if (cloth) {
				try {
					await call("delete_cloth", { id: clothId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				try {
					await call("delete_node", { nodeId: cloth.mesh.id });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				cloth = null;
			}
			if (bodyNode) {
				try {
					await call("delete_node", { nodeId: bodyNode.id });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				bodyNode = null;
			}
			if (baselinePlaying) {
				await call("set_preview_play_mode", { action: "play" });
				if (baselineControl.paused) await call("set_physics_simulation_paused", { paused: true });
			} else if (baselineControl.paused) {
				await call("set_physics_simulation_paused", { paused: true });
			}
		};

		if (baselinePlaying) await call("set_preview_play_mode", { action: "stop" });
		cloth = JSON.parse(
			await call("create_cloth", {
				id: clothId,
				name: `Codex Fixed-step Cloth ${process.pid}`,
				width: 80,
				height: 80,
				subdivisions: 2,
				position: [0, 300, 0],
				gravity: [0, -100, 0],
				pinnedVertices: [0, 1, 2],
			})
		);
		bodyNode = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Fixed-step 2D Body ${process.pid}`,
				position: [160, 300, 0],
				options: { width: 30, height: 30, depth: 10 },
			})
		);
		await call("set_physics2d_body", {
			nodeId: bodyNode.id,
			expectedRevision: 0,
			bodyType: "dynamic",
			collider: { shape: "box", size: [30, 30] },
			gravity: [0, -100],
			velocity: [0, 0],
		});
		bodyAttached = true;
		await call("set_preview_play_mode", { action: "play" });
		const playStatus = JSON.parse(await call("get_editor_status"));
		if (!playStatus.play.canPlay) throw new Error(`preview did not reach a ready Play scene: ${JSON.stringify(playStatus.play)}`);

		let control = JSON.parse(await call("get_physics_simulation_control"));
		if (control.target !== "play" || !control.cloth.clothIds.includes(clothId) || !control.physics2D.bodyIds.includes(bodyNode.id)) {
			throw new Error(`custom fixed-step controls did not resolve both Play solvers: ${JSON.stringify(control)}`);
		}
		if (!control.paused) {
			await call("set_physics_simulation_paused", { paused: true });
		}
		const frozenBefore = JSON.parse(await call("get_physics_simulation_control"));
		const frozenAfter = JSON.parse(await call("get_physics_simulation_control"));
		if (
			frozenAfter.cloth.totalAutomaticSteps !== frozenBefore.cloth.totalAutomaticSteps ||
			frozenAfter.physics2D.totalAutomaticSteps !== frozenBefore.physics2D.totalAutomaticSteps
		) {
			throw new Error(`paused custom solvers continued automatic delivery: ${JSON.stringify({ frozenBefore, frozenAfter })}`);
		}

		const unknownEvidence = await expectCallFailure("step_physics_simulation", { steps: 1, deltaSeconds: 0.02, customSolverMagic: true }, /(unrecognized|invalid)/i);
		const stepped = JSON.parse(await call("step_physics_simulation", { steps: 3, deltaSeconds: 0.02 }));
		control = JSON.parse(await call("get_physics_simulation_control"));
		if (
			stepped.target !== "play" ||
			stepped.stepped !== 3 ||
			stepped.advancedSeconds !== 0.06 ||
			stepped.clothStep?.steppedCloths < 1 ||
			stepped.physics2DStep?.steppedBodies < 1 ||
			control.cloth.totalManualSteps !== frozenBefore.cloth.totalManualSteps + 3 ||
			control.physics2D.totalManualSteps !== frozenBefore.physics2D.totalManualSteps + 3 ||
			control.cloth.lastStepSeconds !== 0.02 ||
			control.physics2D.lastStepSeconds !== 0.02
		) {
			throw new Error(`live custom-solver fixed-step evidence was incomplete: ${JSON.stringify({ stepped, frozenBefore, control })}`);
		}

		console.log(
			`[live-scenario] custom physics fixed step: target=${stepped.target} steps=${stepped.stepped} delta=${control.cloth.lastStepSeconds}s cloth=${stepped.clothStep.steppedCloths} bodies=${stepped.physics2DStep.steppedBodies}`
		);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding shared Cloth/Physics 2D Play evidence for ${holdMilliseconds}ms`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalCloths = JSON.parse(await call("list_cloths")).cloths.length;
		const finalBodies = JSON.parse(await call("list_physics2d_bodies")).bodies.length;
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalCloths !== baselineCloths || finalBodies !== baselineBodies) {
			throw new Error(
				`custom fixed-step cleanup left scene residue: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineCloths, finalCloths, baselineBodies, finalBodies })}`
			);
		}
		console.log(`[live-scenario] custom fixed-step cleanup: meshes=${finalDiagnostics.meshes} cloths=${finalCloths} bodies=${finalBodies} baselinePlay=${baselinePlaying}`);
	}

	// Complete Cloth Physics parity: exact-revision constraint painting and a
	// current-transformed triangle collider backed by a real static Havok body.
	if (has("--cloth-physics-completion")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineCloths = JSON.parse(await call("list_cloths")).cloths.length;
		const baselinePlaying = status.play.playing;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		const clothId = `codex-cloth-completion-${process.pid}`;
		let cloth = null;
		let collider = null;
		let colliderPhysics = false;
		let pausedByScenario = false;
		restore = async () => {
			const currentStatus = JSON.parse(await call("get_editor_status"));
			if (currentStatus.play.playing) await call("set_preview_play_mode", { action: "stop" });
			if (cloth) {
				try {
					await call("delete_cloth", { id: clothId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				try {
					await call("delete_node", { nodeId: cloth.mesh.id });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				cloth = null;
			}
			if (collider) {
				if (colliderPhysics) {
					try {
						await call("set_mesh_physics", { nodeId: collider.id, enabled: false });
					} catch (error) {
						if (!/not found/i.test(error.message)) throw error;
					}
					colliderPhysics = false;
				}
				try {
					await call("delete_node", { nodeId: collider.id });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				collider = null;
			}
			const currentControl = JSON.parse(await call("get_physics_simulation_control"));
			if (pausedByScenario && currentControl.paused) await call("set_physics_simulation_paused", { paused: false });
			pausedByScenario = false;
			if (baselinePlaying) {
				await call("set_preview_play_mode", { action: "play" });
				if (baselineControl.paused) await call("set_physics_simulation_paused", { paused: true });
			} else if (baselineControl.paused) {
				await call("set_physics_simulation_paused", { paused: true });
			}
		};

		if (baselinePlaying) await call("set_preview_play_mode", { action: "stop" });
		collider = JSON.parse(
			await call("create_primitive_mesh", {
				type: "plane",
				name: `Codex Cloth Triangle Body ${process.pid}`,
				position: [0, 200, 0],
				options: { size: 100 },
			})
		);
		await call("set_mesh_physics", { nodeId: collider.id, enabled: true, motionType: "static", shapeType: "mesh", friction: 0.5, restitution: 0 });
		colliderPhysics = true;
		cloth = JSON.parse(
			await call("create_cloth", {
				id: clothId,
				name: `Codex Constraint-painted Cloth ${process.pid}`,
				width: 80,
				height: 80,
				subdivisions: 4,
				position: [0, 200, 5],
				gravity: [0, 0, -1000],
				pinnedVertices: [0, 1, 2, 3, 4],
				triangleColliders: [{ meshId: collider.id, thickness: 2, restitution: 0, friction: 0.5 }],
			})
		);
		const configuredCloth = JSON.parse(await call("set_cloth", { id: clothId, damping: 0.02, constraintIterations: 5, enabled: true, reset: true }));
		if (configuredCloth.id !== clothId || configuredCloth.damping !== 0.02 || configuredCloth.constraintIterations !== 5 || !configuredCloth.enabled) {
			throw new Error(`live Cloth update evidence was incomplete: ${JSON.stringify(configuredCloth)}`);
		}
		const initial = JSON.parse(await call("get_cloth_constraints", { id: clothId, offset: 0, limit: 100 }));
		const unknownEvidence = await expectCallFailure(
			"paint_cloth_constraints",
			{
				id: clothId,
				expectedConstraintRevision: initial.constraintRevision,
				center: [0, 0, 0],
				radius: 25,
				channel: "maxDistance",
				mode: "paint",
				value: 3,
				strength: 1,
				falloff: "smooth",
				maxAffectedVertices: 64,
				magicConstraint: true,
			},
			/(unrecognized|invalid)/i
		);
		const painted = JSON.parse(
			await call("paint_cloth_constraints", {
				id: clothId,
				expectedConstraintRevision: initial.constraintRevision,
				center: [0, 0, 0],
				radius: 25,
				channel: "maxDistance",
				mode: "paint",
				value: 3,
				strength: 1,
				falloff: "smooth",
				maxAffectedVertices: 64,
			})
		);
		if (!painted.mutated || painted.constraintRevision !== 2 || painted.affectedCount !== 5) {
			throw new Error(`live Cloth constraint paint evidence was incomplete: ${JSON.stringify(painted)}`);
		}
		const staleEvidence = await expectCallFailure(
			"paint_cloth_constraints",
			{
				id: clothId,
				expectedConstraintRevision: 1,
				center: [0, 0, 0],
				radius: 25,
				channel: "surfacePenetration",
				mode: "paint",
				value: 1,
				strength: 1,
				falloff: "constant",
				maxAffectedVertices: 64,
			},
			/stale/i
		);
		const readback = JSON.parse(await call("get_cloth_constraints", { id: clothId, offset: 0, limit: 2 }));
		if (
			readback.page.total !== 5 ||
			readback.page.returned !== 2 ||
			readback.page.nextOffset !== 2 ||
			readback.vertexConstraints.some((constraint) => constraint.maxDistance !== 3)
		) {
			throw new Error(`live Cloth paginated readback was incomplete: ${JSON.stringify(readback)}`);
		}
		let control = JSON.parse(await call("get_physics_simulation_control"));
		if (!control.paused) {
			await call("set_physics_simulation_paused", { paused: true });
			pausedByScenario = true;
		}
		await call("step_physics_simulation", { steps: 1, deltaSeconds: 0.1 });
		const collision = JSON.parse(await call("get_cloth_collision_diagnostics", { id: clothId }));
		const evidence = collision.diagnostics[0];
		if (!evidence || evidence.activeColliders !== 1 || evidence.triangles !== 2 || evidence.candidateTests < 1 || evidence.contacts < 1 || evidence.workTruncated) {
			const clothNode = await call("get_node", { nodeId: cloth.mesh.id });
			const colliderNode = await call("get_node", { nodeId: collider.id });
			const clothGeometry = await call("get_mesh_vertex_data", { nodeId: cloth.mesh.id });
			const colliderGeometry = await call("get_mesh_vertex_data", { nodeId: collider.id });
			throw new Error(
				`live Cloth triangle collision evidence was incomplete: ${JSON.stringify(collision)} nodes=${clothNode}/${colliderNode} geometry=${clothGeometry.slice(0, 1200)}/${colliderGeometry.slice(0, 1200)}`
			);
		}
		await call("select_node", { nodeId: cloth.mesh.id });
		console.log(
			`[live-scenario] Cloth completion: revision=${painted.constraintRevision} painted=${painted.affectedCount} triangles=${evidence.triangles} candidates=${evidence.candidateTests} contacts=${evidence.contacts} physicsBody=true`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding painted Cloth and triangle-body collision evidence for ${holdMilliseconds}ms`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalCloths = JSON.parse(await call("list_cloths")).cloths.length;
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalCloths !== baselineCloths) {
			throw new Error(`Cloth completion cleanup left scene residue: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineCloths, finalCloths })}`);
		}
		console.log(`[live-scenario] Cloth completion cleanup: meshes=${finalDiagnostics.meshes} cloths=${finalCloths} baselinePlay=${baselinePlaying}`);
	}

	// Persisted Havok contact evidence and deterministic visualization-only replay.
	// This proves exact asset/session leases, strict nested schemas, no physics or
	// callback replay, source-deletion cleanup, and exact disposable scene cleanup.
	if (has("--physics-contact-history")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const validation = JSON.parse(await call("validate_physics_scene"));
		if (
			typeof validation.valid !== "boolean" ||
			!Array.isArray(validation.errors) ||
			!Array.isArray(validation.warnings) ||
			!Number.isSafeInteger(validation.statistics?.bodyCount)
		) {
			throw new Error(`Physics validation evidence is incomplete: ${JSON.stringify(validation)}`);
		}
		const baselineContactVisualization = JSON.parse(await call("get_physics_contact_visualization"));
		const enabledContactVisualization = JSON.parse(
			await call("set_physics_contact_visualization", { enabled: true, normalScale: 60, pointSize: 8, lifetimeMs: 5000, clear: true })
		);
		if (!enabledContactVisualization.enabled || enabledContactVisualization.normalScale !== 60 || enabledContactVisualization.pointSize !== 8) {
			throw new Error(`Physics contact visualization evidence is incomplete: ${JSON.stringify(enabledContactVisualization)}`);
		}
		const baselineHistories = JSON.parse(await call("list_physics_contact_histories", { limit: 100 })).page.total;
		const baselinePlaying = status.play.playing;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		const historyPath = `assets/__codex_contact_history_${process.pid}.physicscontacts.json`;
		let ground = null;
		let body = null;
		let captureActive = false;
		let historyExists = false;
		let pausedByScenario = false;

		restore = async () => {
			await call("set_physics_contact_visualization", {
				enabled: baselineContactVisualization.enabled,
				normalScale: baselineContactVisualization.normalScale,
				pointSize: baselineContactVisualization.pointSize,
				lifetimeMs: baselineContactVisualization.lifetimeMs,
				clear: true,
			});
			try {
				const replay = JSON.parse(await call("get_physics_contact_history_replay"));
				if (replay.active) {
					await call("control_physics_contact_history_replay", {
						command: "stop",
						sessionId: replay.sessionId,
						expectedSessionRevision: replay.sessionRevision,
					});
				}
			} finally {
			}
			if (captureActive) {
				try {
					await call("stop_physics_contact_capture");
				} catch (error) {
					if (!/No physics contact capture/i.test(error.message)) throw error;
				}
				captureActive = false;
			}
			if (historyExists) {
				try {
					const history = JSON.parse(await call("get_physics_contact_history", { path: historyPath, limit: 1 }));
					await call("delete_physics_contact_history", { path: historyPath, expectedRevision: history.contentRevision, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				historyExists = false;
			}
			for (const node of [body, ground]) {
				if (!node) continue;
				try {
					await call("set_mesh_physics", { nodeId: node.id, enabled: false });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				try {
					await call("delete_node", { nodeId: node.id });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
			body = null;
			ground = null;
			const currentControl = JSON.parse(await call("get_physics_simulation_control"));
			if (pausedByScenario && currentControl.paused) await call("set_physics_simulation_paused", { paused: false });
			pausedByScenario = false;
			if (baselinePlaying) {
				await call("set_preview_play_mode", { action: "play" });
				if (baselineControl.paused) await call("set_physics_simulation_paused", { paused: true });
			} else if (baselineControl.paused) {
				await call("set_physics_simulation_paused", { paused: true });
			}
		};

		if (baselinePlaying) await call("set_preview_play_mode", { action: "stop" });
		ground = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Contact Ground ${process.pid}`,
				position: [0, 0, 0],
				options: { width: 120, height: 20, depth: 120 },
			})
		);
		body = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Contact Body ${process.pid}`,
				position: [0, 12, 0],
				options: { width: 24, height: 24, depth: 24 },
			})
		);
		await call("set_mesh_physics", { nodeId: ground.id, enabled: true, motionType: "static", shapeType: "box", friction: 0.5, restitution: 0 });
		await call("set_mesh_physics", { nodeId: body.id, enabled: true, motionType: "dynamic", shapeType: "box", mass: 1, friction: 0.5, restitution: 0 });
		const control = JSON.parse(await call("get_physics_simulation_control"));
		if (!control.paused) {
			await call("set_physics_simulation_paused", { paused: true });
			pausedByScenario = true;
		}
		await call("start_physics_contact_capture", { maxEvents: 64, includeContinued: true });
		captureActive = true;
		await call("step_physics_simulation", { steps: 10, deltaSeconds: 0.016 });
		const capture = JSON.parse(await call("get_physics_contact_capture"));
		if (!capture.active || capture.eventCount < 1 || !capture.events.some((event) => event.point && event.normal)) {
			throw new Error(`live contact capture produced no complete contact vector: ${JSON.stringify(capture)}`);
		}

		const saved = JSON.parse(await call("save_physics_contact_history", { path: historyPath, name: `Codex Contact History ${process.pid}` }));
		historyExists = true;
		if (!saved.created || saved.summary.eventCount !== capture.eventCount || saved.source.maxEvents !== 64) {
			throw new Error(`saved contact history did not preserve the capture: ${JSON.stringify({ capture, saved })}`);
		}
		const clearedCapture = JSON.parse(await call("clear_physics_contact_capture"));
		const captureAfterClear = JSON.parse(await call("get_physics_contact_capture"));
		if (!clearedCapture.cleared || !captureAfterClear.active || captureAfterClear.eventCount !== 0 || captureAfterClear.droppedEvents !== 0) {
			throw new Error(`Physics contact capture cleanup evidence is incomplete: ${JSON.stringify(clearedCapture)}`);
		}
		await call("stop_physics_contact_capture");
		captureActive = false;

		const listed = JSON.parse(await call("list_physics_contact_histories", { search: `Codex Contact History ${process.pid}`, limit: 10 }));
		const read = JSON.parse(
			await call("get_physics_contact_history", {
				path: historyPath,
				filter: { types: ["COLLISION_STARTED", "COLLISION_CONTINUED", "COLLISION_FINISHED"], bodyNodeIds: [body.id] },
				limit: 1000,
			})
		);
		if (
			listed.page.total !== 1 ||
			read.matchedSummary.eventCount < 1 ||
			read.events.some((event) => event.colliderNodeId !== body.id && event.collidedAgainstNodeId !== body.id)
		) {
			throw new Error(`list/filter contact-history evidence was incomplete: ${JSON.stringify({ listed, read })}`);
		}
		const nestedUnknown = await expectCallFailure(
			"get_physics_contact_history",
			{ path: historyPath, filter: { bodyNodeIds: [body.id], unknown: true } },
			/(unrecognized|invalid)/i
		);
		const staleAsset = await expectCallFailure("start_physics_contact_history_replay", { path: historyPath, expectedRevision: "0".repeat(64) }, /revision is stale/i);

		const replay = JSON.parse(
			await call("start_physics_contact_history_replay", {
				path: historyPath,
				expectedRevision: saved.contentRevision,
				filter: { bodyNodeIds: [body.id] },
				cursorMs: saved.durationMs,
				trailMs: Math.min(60_000, saved.durationMs),
				normalScale: 60,
				pointSize: 8,
			})
		);
		if (!replay.active || replay.filteredSummary.eventCount < 1 || replay.activeOverlayCount < 1 || replay.physicsAdvanced || replay.callbacksReexecuted) {
			throw new Error(`replay start evidence was incomplete: ${JSON.stringify(replay)}`);
		}
		const invalidControl = await expectCallFailure(
			"control_physics_contact_history_replay",
			{ command: "play", sessionId: replay.sessionId, expectedSessionRevision: replay.sessionRevision, loop: true },
			/(unrecognized|invalid)/i
		);
		const configured = JSON.parse(
			await call("control_physics_contact_history_replay", {
				command: "configure",
				sessionId: replay.sessionId,
				expectedSessionRevision: replay.sessionRevision,
				loop: true,
				playbackRate: 2,
			})
		);
		const sought = JSON.parse(
			await call("control_physics_contact_history_replay", {
				command: "seek",
				sessionId: replay.sessionId,
				expectedSessionRevision: configured.sessionRevision,
				cursorMs: 0,
			})
		);
		const physicsBeforeReplay = JSON.parse(await call("get_physics_simulation_state")).bodies.find((entry) => entry.nodeId === body.id);
		await call("control_physics_contact_history_replay", {
			command: "play",
			sessionId: replay.sessionId,
			expectedSessionRevision: sought.sessionRevision,
		});
		await new Promise((resolve) => setTimeout(resolve, 160));
		const played = JSON.parse(await call("get_physics_contact_history_replay"));
		const paused = JSON.parse(
			await call("control_physics_contact_history_replay", {
				command: "pause",
				sessionId: replay.sessionId,
				expectedSessionRevision: played.sessionRevision,
			})
		);
		const physicsAfterReplay = JSON.parse(await call("get_physics_simulation_state")).bodies.find((entry) => entry.nodeId === body.id);
		if (
			played.cursorMs <= 0 ||
			paused.physicsAdvanced ||
			paused.callbacksReexecuted ||
			JSON.stringify(physicsAfterReplay?.position) !== JSON.stringify(physicsBeforeReplay?.position) ||
			JSON.stringify(physicsAfterReplay?.linearVelocity) !== JSON.stringify(physicsBeforeReplay?.linearVelocity) ||
			JSON.stringify(physicsAfterReplay?.angularVelocity) !== JSON.stringify(physicsBeforeReplay?.angularVelocity)
		) {
			throw new Error(`replay changed physics or lacked cursor evidence: ${JSON.stringify({ played, paused, physicsBeforeReplay, physicsAfterReplay })}`);
		}
		const held = JSON.parse(
			await call("control_physics_contact_history_replay", {
				command: "seek",
				sessionId: replay.sessionId,
				expectedSessionRevision: paused.sessionRevision,
				cursorMs: saved.durationMs,
			})
		);
		if (held.activeOverlayCount < 1 || held.physicsAdvanced || held.callbacksReexecuted) {
			throw new Error(`final held replay did not expose a contact overlay safely: ${JSON.stringify(held)}`);
		}

		console.log(
			`[live-scenario] physics contact history: target=${saved.source.target} events=${saved.summary.eventCount} bodies=${saved.summary.uniqueBodyCount} revision=${saved.contentRevision.slice(0, 12)} overlays=${held.activeOverlayCount} cursor=${held.cursorMs.toFixed(2)}ms`
		);
		console.log(`[live-scenario] strict rejection: nested=${nestedUnknown} stale=${staleAsset} control=${invalidControl}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding Physics Contact History Inspector/replay evidence for ${holdMilliseconds}ms`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		const deleted = JSON.parse(await call("delete_physics_contact_history", { path: historyPath, expectedRevision: saved.contentRevision, confirm: true }));
		historyExists = false;
		const replayAfterDelete = JSON.parse(await call("get_physics_contact_history_replay"));
		if (!deleted.replayStopped || replayAfterDelete.active) {
			throw new Error(`history deletion did not stop replay: ${JSON.stringify({ deleted, replayAfterDelete })}`);
		}
		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalHistories = JSON.parse(await call("list_physics_contact_histories", { limit: 100 })).page.total;
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalHistories !== baselineHistories) {
			throw new Error(`contact-history cleanup left scene or asset residue: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineHistories, finalHistories })}`);
		}
		console.log(`[live-scenario] physics contact history cleanup: meshes=${finalDiagnostics.meshes} histories=${finalHistories} replay=false`);
	}

	// Bounded Unity-style multi-vector Physics Debug visualization. This proves
	// exact-revision configuration, Play/Edit ownership, real body/contact/joint
	// evidence, negative mutation guarantees, strict rejection, and cleanup.
	if (has("--physics-force-visualization")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineConstraints = JSON.parse(await call("list_physics_constraints")).constraints.length;
		const baselinePlaying = status.play.playing;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		const baselineVisualization = JSON.parse(await call("get_physics_force_visualization"));
		const baselineCapture = JSON.parse(await call("get_physics_contact_capture"));
		if (baselineCapture.active) {
			throw new Error("stop the existing physics contact capture before running the force-visualization live scenario");
		}
		let ground = null;
		let body = null;
		let anchor = null;
		let jointBody = null;
		let constraint = null;
		let captureActive = false;
		let pausedByScenario = false;
		let scenarioVisualization = baselineVisualization;

		const restoreVisualization = async (saved) => {
			const current = JSON.parse(await call("get_physics_force_visualization"));
			await call("set_physics_force_visualization", {
				expectedRevision: current.revision,
				enabled: saved.enabled,
				clear: true,
				...saved.settings,
			});
		};
		restore = async () => {
			await restoreVisualization(scenarioVisualization);
			if (captureActive) {
				try {
					await call("stop_physics_contact_capture");
				} catch (error) {
					if (!/No physics contact capture/i.test(error.message)) throw error;
				}
				captureActive = false;
			}
			if (constraint) {
				try {
					await call("delete_physics_constraint", { id: constraint.id });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				constraint = null;
			}
			for (const node of [jointBody, anchor, body, ground]) {
				if (!node) continue;
				try {
					await call("set_mesh_physics", { nodeId: node.id, enabled: false });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				try {
					await call("delete_node", { nodeId: node.id });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
			jointBody = null;
			anchor = null;
			body = null;
			ground = null;
			const currentControl = JSON.parse(await call("get_physics_simulation_control"));
			if (pausedByScenario && currentControl.paused) await call("set_physics_simulation_paused", { paused: false });
			pausedByScenario = false;
			if (baselinePlaying) {
				await call("set_preview_play_mode", { action: "play" });
				if (baselineControl.paused) await call("set_physics_simulation_paused", { paused: true });
				await restoreVisualization(baselineVisualization);
			} else if (baselineControl.paused) {
				await call("set_physics_simulation_paused", { paused: true });
			}
		};

		if (baselinePlaying) {
			await call("set_preview_play_mode", { action: "stop" });
			scenarioVisualization = JSON.parse(await call("get_physics_force_visualization"));
		}
		ground = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Force Ground ${process.pid}`,
				position: [0, 0, 0],
				options: { width: 120, height: 20, depth: 120 },
			})
		);
		body = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Force Contact Body ${process.pid}`,
				position: [0, 12, 0],
				options: { width: 24, height: 24, depth: 24 },
			})
		);
		anchor = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Force Joint Anchor ${process.pid}`,
				position: [200, 80, 0],
				options: { width: 20, height: 20, depth: 20 },
			})
		);
		jointBody = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Force Joint Body ${process.pid}`,
				position: [225, 80, 0],
				options: { width: 20, height: 20, depth: 20 },
			})
		);
		await call("set_mesh_physics", { nodeId: ground.id, enabled: true, motionType: "static", shapeType: "box", friction: 0.5, restitution: 0 });
		await call("set_mesh_physics", { nodeId: body.id, enabled: true, motionType: "dynamic", shapeType: "box", mass: 2, friction: 0.5, restitution: 0 });
		await call("set_mesh_physics", { nodeId: anchor.id, enabled: true, motionType: "static", shapeType: "box", friction: 0.5, restitution: 0 });
		await call("set_mesh_physics", { nodeId: jointBody.id, enabled: true, motionType: "dynamic", shapeType: "box", mass: 1, friction: 0.5, restitution: 0 });
		constraint = JSON.parse(
			await call("create_physics_constraint", {
				type: "hinge",
				parentNodeId: anchor.id,
				childNodeId: jointBody.id,
				pivotA: [10, 0, 0],
				pivotB: [-10, 0, 0],
				axisA: [0, 1, 0],
				axisB: [0, 1, 0],
				collision: false,
			})
		);
		const control = JSON.parse(await call("get_physics_simulation_control"));
		if (!control.paused) {
			await call("set_physics_simulation_paused", { paused: true });
			pausedByScenario = true;
		}
		await call("start_physics_contact_capture", { maxEvents: 64, includeContinued: true });
		captureActive = true;
		const enabled = JSON.parse(
			await call("set_physics_force_visualization", {
				expectedRevision: scenarioVisualization.revision,
				enabled: true,
				clear: true,
				categories: ["gravity-force", "net-force", "linear-velocity", "angular-velocity", "contact-normal", "contact-impulse", "constraint-axis", "constraint-separation"],
				bodyNodeIds: [ground.id, body.id, anchor.id, jointBody.id],
				maximumVectors: 256,
				refreshIntervalMs: 16,
				forceScale: 0.05,
				impulseScale: 10,
				velocityScale: 0.2,
				angularVelocityScale: 50,
				directionScale: 60,
				separationScale: 1,
				pointSize: 8,
			})
		);
		await call("step_physics_simulation", { steps: 10, deltaSeconds: 0.016 });
		const capture = JSON.parse(await call("get_physics_contact_capture"));
		if (!capture.active || capture.eventCount < 1) {
			throw new Error(`force visualization live capture produced no contacts: ${JSON.stringify(capture)}`);
		}
		const physicsBeforeRead = JSON.parse(await call("get_physics_simulation_state")).bodies.find((entry) => entry.nodeId === body.id);
		const rebuilt = JSON.parse(
			await call("set_physics_force_visualization", {
				expectedRevision: enabled.revision,
				pointSize: 9,
			})
		);
		const evidence = JSON.parse(await call("get_physics_force_visualization", { limit: 100 }));
		const physicsAfterRead = JSON.parse(await call("get_physics_simulation_state")).bodies.find((entry) => entry.nodeId === body.id);
		const requiredCategories = ["gravity-force", "net-force", "linear-velocity", "contact-normal", "constraint-axis", "constraint-separation"];
		const missingCategories = requiredCategories.filter((category) => !evidence.categoryCounts[category]);
		if (
			missingCategories.length ||
			!evidence.enabled ||
			evidence.activeOverlayCount !== 1 ||
			evidence.renderedVectorCount < requiredCategories.length ||
			evidence.physicsAdvanced ||
			evidence.bodiesMutated ||
			evidence.originalAppliedForcesAvailable ||
			evidence.constraintReactionForcesAvailable ||
			JSON.stringify(physicsAfterRead?.position) !== JSON.stringify(physicsBeforeRead?.position) ||
			JSON.stringify(physicsAfterRead?.linearVelocity) !== JSON.stringify(physicsBeforeRead?.linearVelocity) ||
			JSON.stringify(physicsAfterRead?.angularVelocity) !== JSON.stringify(physicsBeforeRead?.angularVelocity)
		) {
			throw new Error(
				`force visualization evidence was incomplete or mutated physics: ${JSON.stringify({ missingCategories, evidence, physicsBeforeRead, physicsAfterRead })}`
			);
		}
		const staleEvidence = await expectCallFailure("set_physics_force_visualization", { expectedRevision: enabled.revision, forceScale: 1 }, /revision is stale/i);
		const unknownEvidence = await expectCallFailure(
			"set_physics_force_visualization",
			{ expectedRevision: rebuilt.revision, enabled: true, unknown: true },
			/(unrecognized|invalid)/i
		);

		console.log(
			`[live-scenario] physics force visualization: target=${evidence.target} vectors=${evidence.availableVectorCount} rendered=${evidence.renderedVectorCount} lines=${evidence.renderedLineCount} samples=${evidence.sampling.sampleCount} categories=${Object.keys(evidence.categoryCounts).join(",")}`
		);
		console.log(`[live-scenario] physics unchanged: position/linear/angular exact; strict rejection: stale=${staleEvidence} unknown=${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding Physics Force Visualization Inspector evidence for ${holdMilliseconds}ms`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalConstraints = JSON.parse(await call("list_physics_constraints")).constraints.length;
		const finalVisualization = JSON.parse(await call("get_physics_force_visualization"));
		if (
			finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
			finalConstraints !== baselineConstraints ||
			finalVisualization.enabled !== baselineVisualization.enabled ||
			JSON.stringify(finalVisualization.settings) !== JSON.stringify(baselineVisualization.settings)
		) {
			throw new Error(
				`force visualization cleanup left residue: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineConstraints, finalConstraints, baselineVisualization, finalVisualization })}`
			);
		}
		console.log(`[live-scenario] physics force visualization cleanup: meshes=${finalDiagnostics.meshes} constraints=${finalConstraints} enabled=${finalVisualization.enabled}`);
	}

	// 3. Optional: full component round-trip on a real scene node, then undo.
	if (has("--components")) {
		const hierarchy = JSON.parse(await call("get_scene_hierarchy"));
		const node = (Array.isArray(hierarchy) ? hierarchy : []).find((entry) => entry.id);
		if (!node) {
			throw new Error("the open scene has no nodes to author on");
		}

		const registry = JSON.parse(await call("list_game_object_component_types", { nodeId: node.id }));
		const types = registry.types.map((entry) => entry.type);
		console.log(`[live-scenario] node "${node.name}" publishes: ${types.join(", ")}`);

		for (const type of ["entity", "network"]) {
			if (!types.includes(type)) {
				failures.push(`component type "${type}" is not published by the live editor`);
				continue;
			}
			const before = JSON.parse(await call("inspect_game_object_components", { nodeId: node.id }));
			const added = JSON.parse(await call("add_game_object_component", { nodeId: node.id, expectedFingerprint: before.fingerprint, type }));
			const component = added.components.find((entry) => entry.type === type);
			if (!component) {
				failures.push(`add_game_object_component did not return a "${type}" row`);
				continue;
			}
			console.log(`[live-scenario] added ${component.label}: ${JSON.stringify(component.data)}`);

			// Always undo the mutation, even if a later assertion fails.
			restore = async () => {
				const current = JSON.parse(await call("inspect_game_object_components", { nodeId: node.id }));
				const live = current.components.find((entry) => entry.id === component.id);
				if (live) {
					await call("remove_game_object_component", { nodeId: node.id, expectedFingerprint: current.fingerprint, componentId: component.id });
				}
			};
			await restore();
			restore = null;
			console.log(`[live-scenario] removed ${component.label} — project left unchanged`);
		}

		if (!types.includes("data")) {
			failures.push('component type "data" is not published by the live editor');
		} else {
			const marker = `MCP Component Lifecycle ${Date.now()}`;
			const authoredIds = [];
			const cleanupDataComponents = async () => {
				let current = JSON.parse(await call("inspect_game_object_components", { nodeId: node.id }));
				for (const componentId of authoredIds.reverse()) {
					if (current.components.some((entry) => entry.id === componentId)) {
						current = JSON.parse(
							await call("remove_game_object_component", {
								nodeId: node.id,
								expectedFingerprint: current.fingerprint,
								componentId,
							})
						);
					}
				}
			};

			try {
				let current = JSON.parse(await call("inspect_game_object_components", { nodeId: node.id }));
				const added = JSON.parse(
					await call("add_game_object_component", {
						nodeId: node.id,
						expectedFingerprint: current.fingerprint,
						type: "data",
						name: marker,
						values: { verifiedBy: "mcp-live-scenario", sequence: 1 },
					})
				);
				const source = added.components.find((entry) => entry.type === "data" && entry.label === marker);
				if (!source) {
					throw new Error("add_game_object_component did not return the authored data component");
				}
				authoredIds.push(source.id);

				const copied = JSON.parse(
					await call("copy_game_object_component", {
						nodeId: node.id,
						expectedFingerprint: added.fingerprint,
						componentId: source.id,
					})
				);
				if (!copied.copied || copied.type !== "data" || !copied.clipboardFingerprint) {
					throw new Error(`copy_game_object_component returned invalid evidence: ${JSON.stringify(copied)}`);
				}

				const pasted = JSON.parse(
					await call("paste_game_object_component", {
						nodeId: node.id,
						expectedFingerprint: added.fingerprint,
						expectedClipboardFingerprint: copied.clipboardFingerprint,
						mode: "new",
					})
				);
				const duplicates = pasted.components.filter((entry) => entry.type === "data" && entry.label === marker);
				const duplicate = duplicates.find((entry) => entry.id !== source.id);
				if (!duplicate || duplicates.length !== 2) {
					throw new Error(`paste_game_object_component did not create exactly one guarded duplicate: ${JSON.stringify(duplicates)}`);
				}
				authoredIds.push(duplicate.id);

				const moved = JSON.parse(
					await call("move_game_object_component", {
						nodeId: node.id,
						expectedFingerprint: pasted.fingerprint,
						componentId: duplicate.id,
						targetOrder: 1,
					})
				);
				const movedDuplicate = moved.components.find((entry) => entry.id === duplicate.id);
				if (movedDuplicate?.order !== 1) {
					throw new Error(`move_game_object_component did not place the duplicate at order 1: ${JSON.stringify(movedDuplicate)}`);
				}

				const reset = JSON.parse(
					await call("reset_game_object_component", {
						nodeId: node.id,
						expectedFingerprint: moved.fingerprint,
						componentId: duplicate.id,
					})
				);
				const resetDuplicate = reset.components.find((entry) => entry.id === duplicate.id);
				if (resetDuplicate?.label !== "Data Component" || Object.keys(resetDuplicate.data?.values ?? {}).length !== 0 || resetDuplicate.enabled !== true) {
					throw new Error(`reset_game_object_component did not restore deterministic defaults: ${JSON.stringify(resetDuplicate)}`);
				}
				console.log(`[live-scenario] component clipboard lifecycle verified: copied=${source.id} pasted=${duplicate.id} reordered=1 reset=defaults`);
			} finally {
				await cleanupDataComponents();
			}
			console.log("[live-scenario] component clipboard lifecycle cleanup complete — project left unchanged");
		}
	}

	// 4. Optional: exact-leased transient overdraw and light-complexity views,
	// real target readback, strict rejection, and residue-free restoration.
	if (has("--render-debug-views")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baseline = JSON.parse(await call("get_render_debug_view"));
		const baselineCaptures = JSON.parse(await call("list_profiler_captures")).captures;
		let profilerCaptureId = null;
		const restoreBaseline = async () => {
			if (profilerCaptureId) {
				try {
					await call("delete_profiler_capture", { id: profilerCaptureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				profilerCaptureId = null;
			}
			const current = JSON.parse(await call("get_render_debug_view"));
			if (current.mode !== baseline.mode || current.maximumOverdraw !== baseline.maximumOverdraw || current.maximumLightCount !== baseline.maximumLightCount) {
				await call("set_render_debug_view", {
					expectedRevision: current.revision,
					mode: baseline.mode,
					maximumOverdraw: baseline.maximumOverdraw,
					maximumLightCount: baseline.maximumLightCount,
				});
			}
		};
		restore = restoreBaseline;

		const overdraw = JSON.parse(
			await call("set_render_debug_view", {
				expectedRevision: baseline.revision,
				mode: "overdraw",
				maximumOverdraw: 12,
				maximumLightCount: 8,
			})
		);
		if (overdraw.mode !== "overdraw" || !overdraw.active || overdraw.maximumOverdraw !== 12 || overdraw.meshCount < 1) {
			throw new Error(`live overdraw activation was incomplete: ${JSON.stringify(overdraw)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		const overdrawCapture = JSON.parse(await call("capture_render_debug_view", { expectedRevision: overdraw.revision, width: 256, height: 144 }));
		if (
			overdrawCapture.mode !== "overdraw" ||
			overdrawCapture.ready !== true ||
			overdrawCapture.renderedFrames < 1 ||
			overdrawCapture.pixelCount < 1 ||
			overdrawCapture.coloredPixelCount < 1 ||
			!Number.isFinite(overdrawCapture.coloredCoverage) ||
			!/^[a-f0-9]{64}$/.test(overdrawCapture.pixelSha256) ||
			overdrawCapture.preview?.width > 256 ||
			overdrawCapture.preview?.height > 144
		) {
			throw new Error(`live overdraw capture was incomplete: ${JSON.stringify(overdrawCapture)}`);
		}
		const staleEvidence = await expectCallFailure("set_render_debug_view", { expectedRevision: baseline.revision, mode: "disabled" }, /revision is stale/i);
		const unknownEvidence = await expectCallFailure(
			"set_render_debug_view",
			{ expectedRevision: overdraw.revision, mode: "light-complexity", unknownDiagnosticField: true },
			/(unrecognized|invalid)/i
		);

		const complexity = JSON.parse(
			await call("set_render_debug_view", {
				expectedRevision: overdraw.revision,
				mode: "light-complexity",
				maximumOverdraw: 12,
				maximumLightCount: 8,
			})
		);
		const histogramTotal = complexity.lightCountHistogram.reduce((sum, value) => sum + value, 0);
		if (complexity.mode !== "light-complexity" || !complexity.active || histogramTotal !== complexity.meshCount || complexity.maximumLightCount !== 8) {
			throw new Error(`live light-complexity activation was incomplete: ${JSON.stringify(complexity)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		const complexityCapture = JSON.parse(await call("capture_render_debug_view", { expectedRevision: complexity.revision, width: 256, height: 144 }));
		if (
			complexityCapture.mode !== "light-complexity" ||
			complexityCapture.ready !== true ||
			complexityCapture.renderedFrames < 1 ||
			complexityCapture.coloredPixelCount < 1 ||
			complexityCapture.lightCountHistogram.reduce((sum, value) => sum + value, 0) !== complexityCapture.meshCount ||
			!/^[a-f0-9]{64}$/.test(complexityCapture.preview?.sha256 ?? "")
		) {
			throw new Error(`live light-complexity capture was incomplete: ${JSON.stringify(complexityCapture)}`);
		}

		const profiler = JSON.parse(
			await call("start_profiler_capture", {
				id: `codex-diagnostics-690-${process.pid}`,
				name: `Codex Diagnostics 690 ${process.pid}`,
				sampleIntervalMs: 1,
				maxSamples: 64,
			})
		);
		profilerCaptureId = profiler.id;
		await new Promise((resolve) => setTimeout(resolve, 500));
		const stoppedProfiler = JSON.parse(await call("stop_profiler_capture", { id: profilerCaptureId }));
		const profilerDetail = JSON.parse(await call("get_profiler_capture", { id: profilerCaptureId }));
		if (
			stoppedProfiler.active !== false ||
			profilerDetail.sampleCount < 1 ||
			!profilerDetail.summary?.frameTimeMs ||
			!Object.hasOwn(profilerDetail.samples[0]?.metrics ?? {}, "gpuFrameTimeMs") ||
			!Object.hasOwn(profilerDetail.samples[0]?.metrics ?? {}, "gpuFrameTimeAverageMs")
		) {
			throw new Error(`live sampled CPU/GPU profiler evidence was incomplete: ${JSON.stringify(profilerDetail)}`);
		}
		console.log(
			`[live-scenario] render debug views: overdraw=${(overdrawCapture.coloredCoverage * 100).toFixed(2)}%/${overdrawCapture.pixelSha256} complexity=${(
				complexityCapture.coloredCoverage * 100
			).toFixed(2)}%/${complexityCapture.pixelSha256} histogram=${complexityCapture.lightCountHistogram.join(",")}`
		);
		console.log(
			`[live-scenario] sampled profiler: samples=${profilerDetail.sampleCount} cpu=${profilerDetail.summary.frameTimeMs.average.toFixed(3)}ms gpu=${
				profilerDetail.summary.gpuFrameTimeMs?.average?.toFixed(3) ?? "unavailable"
			}ms`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the light-complexity overlay for ${holdMilliseconds}ms of visible Scene Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await call("delete_profiler_capture", { id: profilerCaptureId });
		profilerCaptureId = null;
		await call("set_render_debug_view", { expectedRevision: complexity.revision, mode: "disabled" });
		await restoreBaseline();
		restore = null;
		const final = JSON.parse(await call("get_render_debug_view"));
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalCaptures = JSON.parse(await call("list_profiler_captures")).captures;
		for (const key of ["meshes", "materials", "textures", "lights", "cameras", "particleSystems"]) {
			if (finalDiagnostics[key] !== baselineDiagnostics[key]) {
				throw new Error(`render-debug cleanup changed ${key}: ${baselineDiagnostics[key]} -> ${finalDiagnostics[key]}`);
			}
		}
		if (final.mode !== baseline.mode || final.maximumOverdraw !== baseline.maximumOverdraw || final.maximumLightCount !== baseline.maximumLightCount) {
			throw new Error(`render-debug cleanup did not restore the baseline view: ${JSON.stringify({ baseline, final })}`);
		}
		if (finalCaptures.length !== baselineCaptures.length || finalCaptures.some((capture) => !baselineCaptures.some((baselineCapture) => baselineCapture.id === capture.id))) {
			throw new Error(`render-debug cleanup changed profiler captures: ${JSON.stringify({ baselineCaptures, finalCaptures })}`);
		}
		console.log(
			`[live-scenario] render-debug cleanup: mode=${final.mode} meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials} textures=${finalDiagnostics.textures}`
		);
	}

	// 5. Optional: complete five-channel screen-space projector and Decal Layer
	// lifecycle through the bundled external stdio MCP server. Every mutation is
	// removed before exit, including restoring the target's exact native mask.
	if (has("--decal-channels")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineDecals = JSON.parse(await call("list_decals", { offset: 0, limit: 100 }));
		const baselineLayers = JSON.parse(await call("list_rendering_layers"));
		const hierarchy = flattenHierarchy(JSON.parse(await call("get_scene_hierarchy")));
		const materials = JSON.parse(await call("list_materials")).materials;
		const supportedMaterialIds = new Set(
			materials
				.filter((material) =>
					["StandardMaterial", "PBRMaterial", "PBRMetallicRoughnessMaterial", "PBRSpecularGlossinessMaterial", "OpenPBRMaterial"].includes(material.className)
				)
				.map((material) => material.id)
		);
		let target = null;
		for (const candidate of hierarchy.filter((node) => node.type === "Mesh" || node.type === "GroundMesh")) {
			const details = JSON.parse(await call("get_node", { nodeId: candidate.id }));
			if (details.materialId && supportedMaterialIds.has(details.materialId) && !details.metadata?.decal) {
				target = details;
				break;
			}
		}
		if (!target) {
			throw new Error("the open scene has no supported material-backed Mesh for the live projector fixture");
		}
		const targetUsage = baselineLayers.usage.meshes.find((mesh) => mesh.id === target.id);
		if (!targetUsage) {
			throw new Error(`rendering-layer usage omitted target ${target.id}`);
		}
		const projectorName = `Codex Five-Channel Decal ${process.pid}`;
		const layerMask = 0x80000000;
		let projectorId = null;
		restore = async () => {
			if (projectorId) {
				try {
					await call("delete_node", { nodeId: projectorId });
				} catch (error) {
					if (!/Node not found/i.test(error.message)) {
						throw error;
					}
				}
			}
			const currentLayers = JSON.parse(await call("list_rendering_layers"));
			const currentTarget = currentLayers.usage.meshes.find((mesh) => mesh.id === target.id);
			if (currentTarget?.mask !== targetUsage.mask) {
				await call("set_node_rendering_layers", { nodeId: target.id, mask: targetUsage.mask });
			}
		};

		await call("set_node_rendering_layers", { nodeId: target.id, mask: layerMask });
		const created = JSON.parse(
			await call("create_decal", {
				projectionMode: "screen-space-volume",
				materialId: target.materialId,
				name: projectorName,
				position: target.position ?? [0, 0, 0],
				rotation: [0.1, 0.2, 0.3],
				size: [100000, 100000, 100000],
				edgeFade: 0.2,
				uvScale: [1.5, 0.75],
				uvOffset: [0.1, -0.1],
				channels: { albedo: true, normal: true, metallic: true, ambientOcclusion: true, emissive: true },
				normalStrength: 1.25,
				metallic: 0.65,
				smoothness: 0.8,
				ambientOcclusion: 0.7,
				emissiveIntensity: 2.5,
				decalLayerMask: layerMask,
				alphaIndex: 664,
				renderingGroupId: 0,
			})
		);
		projectorId = created.node.id;
		if (created.projectionMode !== "screen-space-volume" || created.revision !== 1 || created.decalLayerMask !== layerMask || !Object.values(created.channels).every(Boolean)) {
			throw new Error(`create_decal returned incomplete five-channel evidence: ${JSON.stringify(created)}`);
		}

		const updated = JSON.parse(
			await call("set_decal", {
				nodeId: projectorId,
				expectedRevision: created.revision,
				channels: { albedo: false },
				normalStrength: 1.5,
				metallic: 0.75,
				smoothness: 0.9,
				ambientOcclusion: 0.6,
				emissiveIntensity: 3,
				decalLayerMask: layerMask,
			})
		);
		if (updated.revision !== 2 || updated.channels.albedo || !updated.channels.normal || updated.decalLayerMask !== layerMask || updated.emissiveIntensity !== 3) {
			throw new Error(`set_decal did not preserve the exact partial channel update: ${JSON.stringify(updated)}`);
		}
		const staleEvidence = await expectCallFailure("set_decal", { nodeId: projectorId, expectedRevision: 1, metallic: 0.5 }, /stale/i);
		const unknownEvidence = await expectCallFailure(
			"create_decal",
			{ projectionMode: "screen-space-volume", materialId: target.materialId, position: [0, 0, 0], unknownProjectorField: true },
			/(unrecognized|invalid)/i
		);
		const reread = JSON.parse(await call("get_decal", { nodeId: projectorId }));
		const listed = JSON.parse(await call("list_decals", { search: projectorName, offset: 0, limit: 10 }));
		if (reread.revision !== 2 || listed.totalCount !== 1 || listed.decals[0]?.node.id !== projectorId) {
			throw new Error("live projector reread/list evidence did not match the exact created node");
		}
		await call("select_node", { nodeId: projectorId });
		console.log(
			`[live-scenario] decal channels: target=${target.name} mask=${layerMask} projector=${projectorId} revision=${reread.revision} channels=${JSON.stringify(reread.channels)}`
		);
		console.log(`[live-scenario] stale rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected projector for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalDecals = JSON.parse(await call("list_decals", { offset: 0, limit: 100 }));
		const finalLayers = JSON.parse(await call("list_rendering_layers"));
		const finalTarget = finalLayers.usage.meshes.find((mesh) => mesh.id === target.id);
		if (
			finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
			finalDiagnostics.materials !== baselineDiagnostics.materials ||
			finalDecals.totalCount !== baselineDecals.totalCount ||
			finalTarget?.mask !== targetUsage.mask
		) {
			throw new Error(
				`live projector cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineDecals: baselineDecals.totalCount, finalDecals: finalDecals.totalCount, baselineMask: targetUsage.mask, finalMask: finalTarget?.mask })}`
			);
		}
		console.log(
			`[live-scenario] decal cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials} decals=${finalDecals.totalCount} targetMask=${finalTarget.mask}`
		);
	}

	// 5. Optional: independent red-channel subsurface-mask texture lifecycle
	// through the bundled external stdio MCP server. The fixture uses an
	// existing project texture and an unconfigured PBR material, then removes
	// both the assignment and temporary profile before exit.
	if (has("--subsurface-mask")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const materials = JSON.parse(await call("list_materials")).materials;
		let target = null;
		for (const material of materials.filter((entry) => entry.className === "PBRMaterial")) {
			const state = JSON.parse(await call("get_subsurface_material", { materialId: material.id }));
			if (!state.configured) {
				target = state;
				break;
			}
		}
		if (!target) {
			throw new Error("the open scene has no unconfigured PBRMaterial for the live subsurface-mask fixture");
		}
		const textureAssets = JSON.parse(await call("list_assets", { type: "texture", offset: 0, limit: 500 })).assets;
		const maskAsset = textureAssets.find((asset) => /\.(png|jpe?g|bmp|tga|webp|gif|tiff?)$/i.test(asset.path));
		if (!maskAsset) {
			throw new Error("the open project has no supported 2D texture asset for the live subsurface-mask fixture");
		}

		const profileName = `Codex Subsurface Mask ${process.pid}`;
		const profilePath = `assets/codex-live-${process.pid}.diffusionprofile.json`;
		let profileRevision = null;
		let materialRevision = 0;
		restore = async () => {
			const currentMaterial = JSON.parse(await call("get_subsurface_material", { materialId: target.materialId }));
			if (currentMaterial.configured) {
				await call("clear_subsurface_material", {
					materialId: target.materialId,
					expectedRevision: currentMaterial.metadata.revision,
					confirm: true,
				});
			}
			try {
				const currentProfile = JSON.parse(await call("get_diffusion_profile", { path: profilePath }));
				await call("delete_diffusion_profile", { path: profilePath, expectedRevision: currentProfile.contentRevision, confirm: true });
			} catch (error) {
				if (!/(does not exist|not found)/i.test(error.message)) {
					throw error;
				}
			}
		};

		const created = JSON.parse(
			await call("create_diffusion_profile", {
				path: profilePath,
				name: profileName,
				scatteringDistance: [1.2, 0.45, 0.22],
				transmissionTint: [1, 0.3, 0.2],
				thicknessRemap: [0.25, 6],
				worldScale: 1,
				indexOfRefraction: 1.42,
			})
		);
		profileRevision = created.contentRevision;
		const assigned = JSON.parse(
			await call("set_subsurface_material", {
				materialId: target.materialId,
				expectedRevision: 0,
				profilePath: created.path,
				expectedProfileRevision: profileRevision,
				mode: "subsurface-scattering",
				subsurfaceMask: 0.8,
				subsurfaceMaskTexturePath: maskAsset.path,
				transmissionEnabled: true,
				transmissionIntensity: 0.7,
				thicknessMultiplier: 2,
			})
		);
		materialRevision = assigned.metadata?.revision ?? 0;
		if (
			materialRevision !== 1 ||
			assigned.metadata?.version !== 2 ||
			!assigned.metadata?.subsurfaceMaskTextureAssigned ||
			assigned.metadata?.subsurfaceMaskTexturePath !== maskAsset.path ||
			assigned.native?.subsurfaceMaskChannel !== "red" ||
			assigned.runtime?.backend !== "babylon-native-burley-screen-space-mask-v2" ||
			!assigned.runtime?.maskTargetAllocated ||
			assigned.runtime?.maskTextureCount !== 1
		) {
			throw new Error(`set_subsurface_material returned incomplete mask evidence: ${JSON.stringify(assigned)}`);
		}

		const updated = JSON.parse(
			await call("set_subsurface_material", {
				materialId: target.materialId,
				expectedRevision: materialRevision,
				subsurfaceMask: 0.45,
				transmissionIntensity: 0.4,
			})
		);
		materialRevision = updated.metadata?.revision ?? 0;
		if (
			materialRevision !== 2 ||
			updated.metadata?.subsurfaceMask !== 0.45 ||
			updated.metadata?.transmissionIntensity !== 0.4 ||
			updated.metadata?.subsurfaceMaskTexturePath !== maskAsset.path ||
			!updated.metadata?.subsurfaceMaskTextureAssigned
		) {
			throw new Error(`set_subsurface_material did not preserve the exact partial mask update: ${JSON.stringify(updated)}`);
		}
		const staleEvidence = await expectCallFailure("set_subsurface_material", { materialId: target.materialId, expectedRevision: 1, subsurfaceMask: 0.25 }, /stale/i);
		const unknownEvidence = await expectCallFailure(
			"set_subsurface_material",
			{ materialId: target.materialId, expectedRevision: materialRevision, unknownMaskField: true },
			/(unrecognized|invalid)/i
		);
		await new Promise((resolve) => setTimeout(resolve, 250));
		const reread = JSON.parse(await call("get_subsurface_material", { materialId: target.materialId }));
		const runtimeState = JSON.parse(await call("get_subsurface_runtime"));
		const runtime = runtimeState.runtime;
		if (
			reread.metadata?.revision !== materialRevision ||
			reread.metadata?.subsurfaceMaskTexturePath !== maskAsset.path ||
			!runtime.maskTargetAllocated ||
			runtime.maskTargetWidth < 1 ||
			runtime.maskTargetHeight < 1 ||
			runtime.maskTextureCount < 1 ||
			!runtime.materials.some((entry) => entry.materialId === target.materialId && entry.subsurfaceMaskChannel === "red" && entry.subsurfaceMaskTextureReady)
		) {
			throw new Error(`live subsurface-mask runtime evidence was incomplete: ${JSON.stringify({ reread, runtime })}`);
		}
		console.log(
			`[live-scenario] subsurface mask: material=${target.materialName} texture=${maskAsset.path} revision=${materialRevision} target=${runtime.maskTargetWidth}x${runtime.maskTargetHeight} frames=${runtime.maskRenderedFrames}`
		);
		console.log(`[live-scenario] stale rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected subsurface material for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalMaterial = JSON.parse(await call("get_subsurface_material", { materialId: target.materialId }));
		const finalProfiles = JSON.parse(await call("list_diffusion_profiles", { search: profileName, offset: 0, limit: 10 }));
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (
			finalMaterial.configured ||
			finalProfiles.page.total !== 0 ||
			finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
			finalDiagnostics.materials !== baselineDiagnostics.materials ||
			(finalDiagnostics.textures !== undefined && finalDiagnostics.textures !== baselineDiagnostics.textures)
		) {
			throw new Error(
				`live subsurface-mask cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, finalMaterial, remainingProfiles: finalProfiles.page.total })}`
			);
		}
		console.log(
			`[live-scenario] subsurface cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials} textures=${finalDiagnostics.textures ?? "unreported"} profiles=${finalProfiles.page.total}`
		);
	}

	// Camera-independent bounded ray-transport lifecycle through the bundled
	// external stdio MCP server. The fixture signs a real closed PBR mesh,
	// proves stale transform/lease/schema rejection, visibly exposes the
	// material Inspector, and restores every scene/file/runtime baseline.
	if (has("--subsurface-transport")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineRuntime = JSON.parse(await call("get_subsurface_runtime"));
		const hierarchy = flattenHierarchy(JSON.parse(await call("get_scene_hierarchy")));
		const materials = JSON.parse(await call("list_materials")).materials;
		let targetMaterial = null;
		let targetMesh = null;
		for (const material of materials.filter((entry) => entry.className === "PBRMaterial")) {
			const state = JSON.parse(await call("get_subsurface_material", { materialId: material.id }));
			if (state.configured) continue;
			for (const node of hierarchy.filter((entry) => entry.type === "Mesh")) {
				const details = JSON.parse(await call("get_node", { nodeId: node.id }));
				if (details.materialId === material.id && Array.isArray(details.position) && Array.isArray(details.rotation) && Array.isArray(details.scaling)) {
					targetMaterial = state;
					targetMesh = details;
					break;
				}
			}
			if (targetMesh) break;
		}
		if (!targetMaterial || !targetMesh) {
			throw new Error("the open scene has no unconfigured PBR material on a transformable closed mesh for the transport fixture");
		}

		const profileName = `Codex Off-screen Transport ${process.pid}`;
		const profilePath = `assets/codex-transport-${process.pid}.diffusionprofile.json`;
		const outputPath = `assets/Lighting/Subsurface/codex-transport-${process.pid}.png`;
		let transformChanged = false;
		restore = async () => {
			if (transformChanged) {
				await call("set_node_transform", {
					nodeId: targetMesh.id,
					position: targetMesh.position,
					rotation: targetMesh.rotation,
					scaling: targetMesh.scaling,
				});
				transformChanged = false;
			}
			let currentMaterial = JSON.parse(await call("get_subsurface_material", { materialId: targetMaterial.materialId }));
			const cache = currentMaterial.metadata?.transportCaches?.find((entry) => entry.meshId === targetMesh.id);
			if (cache) {
				await call("clear_subsurface_transport", {
					materialId: targetMaterial.materialId,
					meshId: targetMesh.id,
					expectedRevision: currentMaterial.metadata.revision,
					expectedCacheRevision: cache.revision,
					confirm: true,
				});
			}
			currentMaterial = JSON.parse(await call("get_subsurface_material", { materialId: targetMaterial.materialId }));
			if (currentMaterial.configured) {
				await call("clear_subsurface_material", {
					materialId: targetMaterial.materialId,
					expectedRevision: currentMaterial.metadata.revision,
					confirm: true,
				});
			}
			const currentRuntime = JSON.parse(await call("get_subsurface_runtime"));
			if (baselineRuntime.hasExplicitSettings) {
				await call("set_subsurface_runtime", {
					expectedRevision: currentRuntime.settings.revision,
					enabled: baselineRuntime.settings.enabled,
					quality: baselineRuntime.settings.quality,
					sampleBudget: baselineRuntime.settings.sampleBudget,
					metersPerUnit: baselineRuntime.settings.metersPerUnit,
					transportMode: baselineRuntime.settings.transportMode,
					transportIntensity: baselineRuntime.settings.transportIntensity,
				});
			} else if (currentRuntime.hasExplicitSettings) {
				await call("clear_subsurface_runtime", { expectedRevision: currentRuntime.settings.revision, confirm: true });
			}
			try {
				const profile = JSON.parse(await call("get_diffusion_profile", { path: profilePath }));
				await call("delete_diffusion_profile", { path: profilePath, expectedRevision: profile.contentRevision, confirm: true });
			} catch (error) {
				if (!/(does not exist|not found)/i.test(error.message)) throw error;
			}
		};

		const profile = JSON.parse(
			await call("create_diffusion_profile", {
				path: profilePath,
				name: profileName,
				scatteringDistance: [20, 8, 3],
				transmissionTint: [1, 0.48, 0.3],
				thicknessRemap: [0, 120],
				worldScale: 1,
				indexOfRefraction: 1.4,
			})
		);
		let assigned = JSON.parse(
			await call("set_subsurface_material", {
				materialId: targetMaterial.materialId,
				expectedRevision: 0,
				profilePath: profile.path,
				expectedProfileRevision: profile.contentRevision,
				mode: "subsurface-scattering",
				subsurfaceMask: 1,
				transmissionEnabled: true,
				transmissionIntensity: 1,
				thicknessMultiplier: 1,
			})
		);
		const baked = JSON.parse(
			await call("bake_subsurface_transport", {
				materialId: targetMaterial.materialId,
				meshId: targetMesh.id,
				expectedRevision: assigned.metadata.revision,
				outputPath,
				resolution: 16,
				sampleCount: 2,
				maxDistance: 500,
				bias: 0.05,
				shadowing: true,
				dilation: 2,
				uvChannel: "uv0",
				intensity: 0.75,
			})
		);
		if (
			baked.cache?.revision !== 1 ||
			baked.cache?.contentRevision?.length !== 64 ||
			baked.cache?.backend !== "bounded-cpu-ray-traced-offscreen-transport-v1" ||
			baked.cache?.rayCount < 1 ||
			baked.cache?.coveredTexels < 1 ||
			baked.cache?.hitTexels < 1 ||
			baked.cache?.texturePath !== outputPath
		) {
			throw new Error(`transport bake returned incomplete evidence: ${JSON.stringify(baked)}`);
		}
		assigned = JSON.parse(await call("get_subsurface_material", { materialId: targetMaterial.materialId }));
		const staleLeaseEvidence = await expectCallFailure(
			"bake_subsurface_transport",
			{
				materialId: targetMaterial.materialId,
				meshId: targetMesh.id,
				expectedRevision: assigned.metadata.revision - 1,
				expectedCacheRevision: 1,
				resolution: 16,
				sampleCount: 1,
			},
			/stale/i
		);
		const unknownEvidence = await expectCallFailure(
			"bake_subsurface_transport",
			{
				materialId: targetMaterial.materialId,
				meshId: targetMesh.id,
				expectedRevision: assigned.metadata.revision,
				expectedCacheRevision: 1,
				resolution: 16,
				sampleCount: 1,
				unsafeHardwareDxr: true,
			},
			/(unrecognized|invalid)/i
		);
		let runtimeState = JSON.parse(await call("get_subsurface_runtime"));
		await call("set_subsurface_runtime", {
			expectedRevision: runtimeState.settings.revision,
			enabled: true,
			quality: "high",
			transportMode: "baked-ray-traced",
			transportIntensity: 1.25,
		});
		await new Promise((resolve) => setTimeout(resolve, 350));
		let transport = JSON.parse(await call("get_subsurface_transport", { materialId: targetMaterial.materialId }));
		let cacheEvidence = transport.runtime.caches.find((entry) => entry.materialId === targetMaterial.materialId && entry.meshId === targetMesh.id);
		if (!transport.runtime.enabled || !cacheEvidence?.active || cacheEvidence.stale || transport.runtime.activeCacheCount < 1) {
			throw new Error(`transport runtime did not activate the exact cache: ${JSON.stringify(transport)}`);
		}

		await call("set_node_transform", {
			nodeId: targetMesh.id,
			position: [targetMesh.position[0] + 5, targetMesh.position[1], targetMesh.position[2]],
		});
		transformChanged = true;
		transport = JSON.parse(await call("get_subsurface_transport", { materialId: targetMaterial.materialId }));
		cacheEvidence = transport.runtime.caches.find((entry) => entry.materialId === targetMaterial.materialId && entry.meshId === targetMesh.id);
		if (!cacheEvidence?.stale || cacheEvidence.active || !cacheEvidence.staleReasons.some((reason) => /geometry|transform|UV/i.test(reason))) {
			throw new Error(`transport cache did not invalidate after the signed transform changed: ${JSON.stringify(cacheEvidence)}`);
		}
		await call("set_node_transform", {
			nodeId: targetMesh.id,
			position: targetMesh.position,
			rotation: targetMesh.rotation,
			scaling: targetMesh.scaling,
		});
		transformChanged = false;
		transport = JSON.parse(await call("get_subsurface_transport", { materialId: targetMaterial.materialId }));
		cacheEvidence = transport.runtime.caches.find((entry) => entry.materialId === targetMaterial.materialId && entry.meshId === targetMesh.id);
		if (!cacheEvidence?.active || cacheEvidence.stale) {
			throw new Error(`transport cache did not reactivate after restoring the exact signed transform: ${JSON.stringify(cacheEvidence)}`);
		}
		assigned = JSON.parse(await call("get_subsurface_material", { materialId: targetMaterial.materialId }));
		assigned = JSON.parse(
			await call("set_subsurface_material", {
				materialId: targetMaterial.materialId,
				expectedRevision: assigned.metadata.revision,
				subsurfaceMask: assigned.metadata.subsurfaceMask,
			})
		);
		await call("select_node", { nodeId: targetMesh.id });
		console.log(
			`[live-scenario] subsurface transport: material=${assigned.materialName} mesh=${targetMesh.name} rays=${baked.cache.rayCount} covered=${baked.cache.coveredTexels} hits=${baked.cache.hitTexels} hash=${baked.cache.contentRevision} active=${cacheEvidence.active}`
		);
		console.log(`[live-scenario] stale-lease rejection: ${staleLeaseEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the active transport Material Inspector for ${holdMilliseconds}ms of visible verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalMaterial = JSON.parse(await call("get_subsurface_material", { materialId: targetMaterial.materialId }));
		const finalRuntime = JSON.parse(await call("get_subsurface_runtime"));
		const finalProfiles = JSON.parse(await call("list_diffusion_profiles", { search: profileName, offset: 0, limit: 10 }));
		const finalAssets = JSON.parse(await call("list_assets", { query: `codex-transport-${process.pid}`, offset: 0, limit: 50 })).assets;
		if (
			finalMaterial.configured ||
			finalProfiles.page.total !== 0 ||
			finalAssets.length !== 0 ||
			finalRuntime.runtime.prePassEnabled ||
			finalRuntime.runtime.maskTargetAllocated ||
			finalRuntime.runtime.transport.cacheCount !== 0 ||
			finalRuntime.runtime.transport.textureCount !== 0 ||
			finalRuntime.hasExplicitSettings !== baselineRuntime.hasExplicitSettings ||
			finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
			finalDiagnostics.materials !== baselineDiagnostics.materials
		) {
			throw new Error(
				`live transport cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, finalMaterial, baselineRuntime, finalRuntime, profiles: finalProfiles.page.total, assets: finalAssets })}`
			);
		}
		console.log(
			`[live-scenario] subsurface transport cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials} textures=${finalDiagnostics.textures ?? "unreported"} profiles=${finalProfiles.page.total}`
		);
	}

	// 6. Optional: two overlapping reflection probes assigned to one real
	// material through the bundled stdio server. This proves equal-priority
	// blend membership, exact priority updates, deferred rebuild evidence,
	// strict/stale rejection, and residue-free cleanup.
	if (has("--reflection-probe-blending")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineProbes = JSON.parse(await call("list_reflection_probes", { offset: 0, limit: 50 }));
		const hierarchy = flattenHierarchy(JSON.parse(await call("get_scene_hierarchy")));
		const materials = JSON.parse(await call("list_materials")).materials;
		const supportedMaterialIds = new Set(
			materials
				.filter((material) =>
					["StandardMaterial", "PBRMaterial", "PBRMetallicRoughnessMaterial", "PBRSpecularGlossinessMaterial", "OpenPBRMaterial"].includes(material.className)
				)
				.map((material) => material.id)
		);
		const alreadyAssignedMaterialIds = new Set(baselineProbes.probes.flatMap((probe) => probe.assignedMaterialIds ?? []));
		let target = null;
		for (const candidate of hierarchy.filter((node) => node.type === "Mesh" || node.type === "GroundMesh")) {
			const details = JSON.parse(await call("get_node", { nodeId: candidate.id }));
			if (details.materialId && supportedMaterialIds.has(details.materialId) && !alreadyAssignedMaterialIds.has(details.materialId)) {
				target = details;
				break;
			}
		}
		if (!target) {
			throw new Error("the open scene has no unassigned supported material-backed Mesh for the live reflection-probe blend fixture");
		}

		const firstName = `Codex Blend Probe A ${process.pid}`;
		const secondName = `Codex Blend Probe B ${process.pid}`;
		const center = target.position ?? [0, 0, 0];
		const probeIds = [];
		let deferredCameraId = null;
		let selectionRevision = null;
		let temporaryRendererPath = null;
		let temporaryRendererRevision = null;
		let temporaryRendererCameraId = null;
		let temporaryRendererAssigned = false;
		let previousRendererAssignment = null;
		restore = async () => {
			for (const id of [...probeIds].reverse()) {
				try {
					const page = JSON.parse(await call("list_reflection_probes", { id, offset: 0, limit: 1 }));
					if (page.probes[0]) {
						await call("delete_reflection_probe", { id, expectedRevision: page.probes[0].revision, confirm: true });
					}
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
			if (temporaryRendererAssigned && temporaryRendererCameraId) {
				const rendererState = JSON.parse(await call("get_renderer_data_state"));
				if (previousRendererAssignment) {
					await call("assign_renderer_data", {
						path: previousRendererAssignment.path,
						expectedRevision: previousRendererAssignment.contentRevision,
						selectionRevision: rendererState.selections.revision,
						cameraId: temporaryRendererCameraId,
					});
				} else {
					await call("clear_renderer_data_assignment", { cameraId: temporaryRendererCameraId, selectionRevision: rendererState.selections.revision });
				}
				temporaryRendererAssigned = false;
			} else if (deferredCameraId && selectionRevision) {
				await call("rebuild_deferred_lighting", { cameraId: deferredCameraId, selectionRevision });
			}
			if (temporaryRendererPath) {
				try {
					const asset = JSON.parse(await call("get_renderer_data_asset", { path: temporaryRendererPath }));
					await call("delete_renderer_data_asset", { path: temporaryRendererPath, expectedRevision: asset.contentRevision, confirm: true });
				} catch (error) {
					if (!/(does not exist|not found)/i.test(error.message)) {
						throw error;
					}
				}
				temporaryRendererPath = null;
			}
		};

		const createProbe = async (name) =>
			JSON.parse(
				await call("create_reflection_probe", {
					name,
					size: 16,
					position: center,
					refreshRate: 0,
					renderListIds: [],
					boxProjection: true,
					influencePosition: center,
					influenceSize: [100000, 100000, 100000],
					importance: 7,
					blendDistance: 5000,
					assignMaterialIds: [target.materialId],
				})
			);
		const first = await createProbe(firstName);
		probeIds.push(first.id);
		const second = await createProbe(secondName);
		probeIds.push(second.id);
		if (
			first.blendModel !== "unity-priority-box-blend-skybox-v1" ||
			second.blendModel !== "unity-priority-box-blend-skybox-v1" ||
			first.importance !== 7 ||
			second.importance !== 7 ||
			first.assignedMaterialIds[0] !== target.materialId ||
			second.assignedMaterialIds[0] !== target.materialId
		) {
			throw new Error(`create_reflection_probe returned incomplete overlapping assignment evidence: ${JSON.stringify({ first, second })}`);
		}

		const updated = JSON.parse(
			await call("set_reflection_probe", {
				id: second.id,
				expectedRevision: second.revision,
				importance: 8,
				blendDistance: 6000,
			})
		);
		if (updated.revision !== 2 || updated.importance !== 8 || updated.blendDistance !== 6000 || updated.assignedMaterialIds[0] !== target.materialId) {
			throw new Error(`set_reflection_probe did not preserve the exact overlap update: ${JSON.stringify(updated)}`);
		}
		const staleEvidence = await expectCallFailure("set_reflection_probe", { id: second.id, expectedRevision: 1, importance: 9 }, /(changed after inspection|stale)/i);
		const unknownEvidence = await expectCallFailure(
			"create_reflection_probe",
			{ name: `Codex Invalid Probe ${process.pid}`, unknownBlendField: true },
			/(unrecognized|invalid)/i
		);
		const reread = JSON.parse(await call("list_reflection_probes", { offset: 0, limit: 50 }));
		const firstReread = reread.probes.find((probe) => probe.id === first.id);
		const secondReread = reread.probes.find((probe) => probe.id === second.id);
		if (!firstReread || secondReread?.revision !== 2 || firstReread.assignedMaterialIds[0] !== target.materialId || secondReread.assignedMaterialIds[0] !== target.materialId) {
			throw new Error("live reflection-probe list evidence did not preserve both assignments");
		}

		let deferredState = JSON.parse(await call("get_deferred_lighting_state"));
		let deferredCamera = deferredState.requestedCameras[0];
		if (!deferredCamera) {
			const rendererState = JSON.parse(await call("get_renderer_data_state"));
			const overriddenCameraIds = new Set(rendererState.selections.cameras.map((entry) => entry.cameraId));
			let camera = rendererState.runtime.cameras.find((entry) => !overriddenCameraIds.has(entry.cameraId));
			if (!camera) {
				for (const assignment of rendererState.selections.cameras) {
					try {
						const asset = JSON.parse(await call("get_renderer_data_asset", { path: assignment.asset.path }));
						if (asset.contentRevision === assignment.asset.contentRevision) {
							camera = rendererState.runtime.cameras.find((entry) => entry.cameraId === assignment.cameraId);
							previousRendererAssignment = { path: assignment.asset.path, contentRevision: assignment.asset.contentRevision };
							break;
						}
					} catch {
						// Try another camera whose exact assigned asset can be restored.
					}
				}
			}
			if (camera) {
				temporaryRendererPath = `assets/codex-live-${process.pid}.rendererdata.json`;
				temporaryRendererCameraId = camera.cameraId;
				const asset = JSON.parse(
					await call("create_renderer_data_asset", {
						path: temporaryRendererPath,
						name: `Codex Live Reflection Blend ${process.pid}`,
						renderingPath: "deferred",
					})
				);
				temporaryRendererRevision = asset.contentRevision;
				const assigned = JSON.parse(
					await call("assign_renderer_data", {
						path: temporaryRendererPath,
						expectedRevision: temporaryRendererRevision,
						selectionRevision: rendererState.selections.revision,
						cameraId: temporaryRendererCameraId,
					})
				);
				temporaryRendererAssigned = true;
				deferredState = JSON.parse(await call("get_deferred_lighting_state", { cameraId: temporaryRendererCameraId }));
				deferredCamera = deferredState.requestedCameras[0];
				if (!deferredCamera || assigned.selections.revision !== deferredState.selectionRevision) {
					throw new Error("temporary deferred renderer assignment did not publish exact requested-camera evidence");
				}
			}
		}
		let runtimeEvidence = null;
		if (deferredCamera) {
			deferredCameraId = deferredCamera.cameraId;
			selectionRevision = deferredState.selectionRevision;
			const rebuilt = JSON.parse(await call("rebuild_deferred_lighting", { cameraId: deferredCameraId, selectionRevision }));
			if (
				!rebuilt.runtime.active ||
				!rebuilt.runtime.iblProbeBlendingActive ||
				rebuilt.runtime.iblProbeBlendModel !== "unity-priority-box-blend-skybox-v1" ||
				rebuilt.runtime.iblProbeBlendMeshCount < 1 ||
				!rebuilt.runtime.iblSources.some((source) => source.name === firstName && source.importance === 7) ||
				!rebuilt.runtime.iblSources.some((source) => source.name === secondName && source.importance === 8)
			) {
				throw new Error(`live deferred reflection-probe blend evidence was incomplete: ${JSON.stringify(rebuilt.runtime)}`);
			}
			runtimeEvidence = rebuilt.runtime;
		}
		console.log(
			`[live-scenario] reflection-probe blend: material=${target.materialId} probes=${first.id},${second.id} revision=${updated.revision} model=${runtimeEvidence?.iblProbeBlendModel ?? first.blendModel} blendedMeshes=${runtimeEvidence?.iblProbeBlendMeshCount ?? "GPU-gate"}`
		);
		if (!runtimeEvidence) {
			console.log("[live-scenario] live scene has no persistent camera; runtime pixels are covered by the dedicated dual-backend GPU gate");
		}
		console.log(`[live-scenario] stale rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the live overlapping probes for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalProbes = JSON.parse(await call("list_reflection_probes", { offset: 0, limit: 50 }));
		if (
			finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
			finalDiagnostics.materials !== baselineDiagnostics.materials ||
			finalProbes.total !== baselineProbes.total ||
			finalProbes.probes.some((probe) => probeIds.includes(probe.id))
		) {
			throw new Error(
				`live reflection-probe cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineTotal: baselineProbes.total, finalTotal: finalProbes.total })}`
			);
		}
		console.log(`[live-scenario] reflection-probe cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials} probes=${finalProbes.total}`);
	}

	// 7. Optional: connected, segmented ProBuilder-style bevel through the
	// bundled external stdio MCP server. A closed tetrahedron provides adjacent
	// manifold edges, deterministic topology evidence, strict rejection, and a
	// disposable Inspector fixture without touching authored nodes.
	if (has("--probuilder-bevel")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const fixtureName = `Codex Connected Bevel ${process.pid}`;
		let fixtureId = null;
		restore = async () => {
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const fixture = JSON.parse(await call("create_primitive_mesh", { type: "plane", name: fixtureName, position: [0, 200, 0] }));
		fixtureId = fixture.id;
		await call("set_mesh_vertex_data", {
			nodeId: fixtureId,
			positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1].map((value) => value * 100),
			uvs: [1, 1, 0, 0, 0, 1, 1, 0],
			indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
		});
		const topology = JSON.parse(await call("get_mesh_topology", { nodeId: fixtureId }));
		const firstIndex = topology.edges.findIndex((edge) => edge[0] === 0 && edge[1] === 1);
		const secondIndex = topology.edges.findIndex((edge) => edge[0] === 0 && edge[1] === 2);
		if (firstIndex < 0 || secondIndex < 0) {
			throw new Error(`live bevel fixture did not expose the expected adjacent edges: ${JSON.stringify(topology.edges)}`);
		}
		await call("set_mesh_selection", { nodeId: fixtureId, mode: "edge", indices: [firstIndex, secondIndex] });
		const beforeRejected = JSON.parse(await call("get_mesh_vertex_data", { nodeId: fixtureId }));
		const amountEvidence = await expectCallFailure("bevel_mesh_edges", { nodeId: fixtureId, edgeIndices: [firstIndex, secondIndex], amount: 0.6, segments: 2 }, /too large/i);
		const duplicateEvidence = await expectCallFailure("bevel_mesh_edges", { nodeId: fixtureId, edgeIndices: [firstIndex, firstIndex], amount: 0.2, segments: 2 }, /unique/i);
		const schemaEvidence = await expectCallFailure(
			"bevel_mesh_edges",
			{ nodeId: fixtureId, edgeIndices: [firstIndex, secondIndex], amount: 0.2, segments: 3, unknownBevelField: true },
			/(unrecognized|invalid)/i
		);
		const afterRejected = JSON.parse(await call("get_mesh_vertex_data", { nodeId: fixtureId }));
		if (
			JSON.stringify(afterRejected.positions) !== JSON.stringify(beforeRejected.positions) ||
			JSON.stringify(afterRejected.indices) !== JSON.stringify(beforeRejected.indices)
		) {
			throw new Error("invalid connected-bevel requests changed the live mesh before rejection");
		}

		const beveled = JSON.parse(
			await call("bevel_mesh_edges", {
				nodeId: fixtureId,
				edgeIndices: [firstIndex, secondIndex],
				amount: 0.2,
				segments: 3,
			})
		);
		if (
			beveled.bevelModel !== "segmented-adjacent-miter-v1" ||
			beveled.bevelSegments !== 3 ||
			beveled.adjacentEdgePairs !== 1 ||
			beveled.connectedComponentCount !== 1 ||
			beveled.addedVertices < 1 ||
			beveled.addedTriangles < 1
		) {
			throw new Error(`bevel_mesh_edges returned incomplete connected-segment evidence: ${JSON.stringify(beveled)}`);
		}
		const result = JSON.parse(await call("get_mesh_vertex_data", { nodeId: fixtureId }));
		const incidence = new Map();
		for (let offset = 0; offset < result.indices.length; offset += 3) {
			const triangle = result.indices.slice(offset, offset + 3);
			for (let corner = 0; corner < 3; corner++) {
				const edge = [triangle[corner], triangle[(corner + 1) % 3]].sort((first, second) => first - second);
				const key = `${edge[0]}:${edge[1]}`;
				incidence.set(key, (incidence.get(key) ?? 0) + 1);
			}
		}
		if (![...incidence.values()].every((count) => count === 2)) {
			throw new Error(`connected bevel produced an open live topology: ${JSON.stringify([...incidence.entries()].filter(([, count]) => count !== 2))}`);
		}
		const resultTopology = JSON.parse(await call("get_mesh_topology", { nodeId: fixtureId }));
		await call("set_mesh_selection", { nodeId: fixtureId, mode: "edge", indices: [0] });
		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] connected bevel: mesh=${fixtureId} model=${beveled.bevelModel} segments=${beveled.bevelSegments} adjacentPairs=${beveled.adjacentEdgePairs} vertices=${resultTopology.vertexCount} faces=${resultTopology.faceCount}`
		);
		console.log(`[live-scenario] amount rejection: ${amountEvidence}`);
		console.log(`[live-scenario] duplicate rejection: ${duplicateEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${schemaEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected beveled mesh for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live connected-bevel cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] connected-bevel cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 8. Optional: persistent logical seams plus chart-aware harmonic unwrap and
	// deterministic packing through the bundled external stdio MCP server.
	if (has("--uv-charts")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const fixtureName = `Codex UV Charts ${process.pid}`;
		let fixtureId = null;
		restore = async () => {
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const fixture = JSON.parse(await call("create_primitive_mesh", { type: "plane", name: fixtureName, position: [250, 200, 0] }));
		fixtureId = fixture.id;
		await call("set_mesh_vertex_data", {
			nodeId: fixtureId,
			positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1].map((value) => value * 100),
			uvs: [1, 1, 0, 0, 0, 1, 1, 0],
			indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
		});
		const topology = JSON.parse(await call("get_mesh_topology", { nodeId: fixtureId }));
		const initial = JSON.parse(await call("get_mesh_uv_layout", { nodeId: fixtureId, offset: 0, limit: 1 }));
		if (initial.revision !== 0 || initial.chartCount !== 1 || topology.edges.length !== 6) {
			throw new Error(`live UV fixture did not expose the expected closed topology: ${JSON.stringify({ topology, initial })}`);
		}
		const added = JSON.parse(await call("set_mesh_uv_seams", { nodeId: fixtureId, expectedRevision: 0, mode: "add", edgeIndices: [0] }));
		const removed = JSON.parse(await call("set_mesh_uv_seams", { nodeId: fixtureId, expectedRevision: 1, mode: "remove", edgeIndices: [0] }));
		if (added.revision !== 1 || added.seamCount !== 1 || removed.revision !== 2 || removed.seamCount !== 0) {
			throw new Error(`live UV seam lifecycle returned incomplete evidence: ${JSON.stringify({ added, removed })}`);
		}
		const staleEvidence = await expectCallFailure("set_mesh_uv_seams", { nodeId: fixtureId, expectedRevision: 1, mode: "add", edgeIndices: [0] }, /stale/i);
		const unknownEvidence = await expectCallFailure(
			"set_mesh_uv_seams",
			{ nodeId: fixtureId, expectedRevision: 2, mode: "add", edgeIndices: [0], unknownUvField: true },
			/(unrecognized|invalid)/i
		);
		const paddingEvidence = await expectCallFailure("unwrap_mesh_uvs", { nodeId: fixtureId, expectedRevision: 2, padding: 0.2 }, /(too_big|invalid|less than or equal)/i);
		const unwrapped = JSON.parse(
			await call("unwrap_mesh_uvs", {
				nodeId: fixtureId,
				expectedRevision: 2,
				padding: 0.02,
				relaxIterations: 24,
				relaxStrength: 0.6,
				allowRotation: true,
				autoSeams: true,
				normalizeTexelDensity: true,
			})
		);
		const layout = JSON.parse(await call("get_mesh_uv_layout", { nodeId: fixtureId, offset: 0, limit: 10 }));
		if (
			unwrapped.unwrap?.model !== "logical-seam-harmonic-relax-pack-v1" ||
			unwrapped.unwrap.autoSeamCount !== 3 ||
			unwrapped.unwrap.chartCount !== 1 ||
			layout.revision !== 3 ||
			layout.seamCount !== 3 ||
			layout.lastUnwrap?.atlasUtilization <= 0 ||
			Math.min(...unwrapped.uvs) < -0.000001 ||
			Math.max(...unwrapped.uvs) > 1.000001
		) {
			throw new Error(`live UV unwrap returned incomplete chart evidence: ${JSON.stringify({ unwrapped, layout })}`);
		}
		await call("set_mesh_selection", { nodeId: fixtureId, mode: "edge", indices: [layout.seamEdgeIndices[0]] });
		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] UV charts: mesh=${fixtureId} model=${unwrapped.unwrap.model} revision=${layout.revision} charts=${layout.chartCount} seams=${layout.seamCount} autoSeams=${unwrapped.unwrap.autoSeamCount} vertices=${unwrapped.positions.length / 3}`
		);
		console.log(`[live-scenario] stale rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		console.log(`[live-scenario] padding rejection: ${paddingEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected UV chart mesh for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live UV chart cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] UV chart cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 9. Optional: exact-fingerprint multi-cut traversal through a closed logical
	// quad ring, including Babylon hard face seams and strict atomic rejection.
	if (has("--probuilder-loop-cut")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const fixtureName = `Codex Loop Cut ${process.pid}`;
		let fixtureId = null;
		restore = async () => {
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const fixture = JSON.parse(await call("create_primitive_mesh", { type: "box", name: fixtureName, position: [-250, 200, 0] }));
		fixtureId = fixture.id;
		const topology = JSON.parse(await call("get_mesh_topology", { nodeId: fixtureId }));
		if (!topology.topologyFingerprint || topology.faceCount !== 12 || topology.edges.length !== 30) {
			throw new Error(`live loop-cut fixture did not expose the expected exact box topology: ${JSON.stringify(topology)}`);
		}
		const beforeRejected = JSON.parse(await call("get_mesh_vertex_data", { nodeId: fixtureId }));
		const staleEvidence = await expectCallFailure("loop_cut_mesh", { nodeId: fixtureId, expectedTopologyFingerprint: "stale", edgeIndex: 0, cuts: 2 }, /stale/i);
		const unknownEvidence = await expectCallFailure(
			"loop_cut_mesh",
			{ nodeId: fixtureId, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: 0, cuts: 2, unknownLoopCutField: true },
			/(unrecognized|invalid)/i
		);
		const offsetEvidence = await expectCallFailure(
			"loop_cut_mesh",
			{ nodeId: fixtureId, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: 0, cuts: 2, offset: 0.5 },
			/(too_big|invalid|less than or equal)/i
		);
		const afterRejected = JSON.parse(await call("get_mesh_vertex_data", { nodeId: fixtureId }));
		if (
			JSON.stringify(afterRejected.positions) !== JSON.stringify(beforeRejected.positions) ||
			JSON.stringify(afterRejected.indices) !== JSON.stringify(beforeRejected.indices)
		) {
			throw new Error("invalid loop-cut requests changed the live mesh before rejection");
		}
		const result = JSON.parse(
			await call("loop_cut_mesh", {
				nodeId: fixtureId,
				expectedTopologyFingerprint: topology.topologyFingerprint,
				edgeIndex: 0,
				cuts: 2,
				offset: 0.25,
			})
		);
		if (
			result.loopCutModel !== "logical-quad-strip-loop-cut-v1" ||
			result.stripClosed !== true ||
			result.stripQuadCount !== 4 ||
			result.splitLogicalEdgeCount !== 4 ||
			result.pairedQuadCount !== 6 ||
			result.cuts !== 2 ||
			result.loops?.length !== 2 ||
			result.loops.some((loop) => loop.edgeIndices.length !== 4) ||
			result.addedVertices !== 16 ||
			result.addedTriangles !== 16
		) {
			throw new Error(`loop_cut_mesh returned incomplete closed-strip evidence: ${JSON.stringify(result)}`);
		}
		const selection = JSON.parse(await call("get_mesh_selection", { nodeId: fixtureId }));
		if (selection.mode !== "edge" || JSON.stringify(selection.indices) !== JSON.stringify(result.createdEdgeIndices)) {
			throw new Error(`loop cut did not select its created edge loops: ${JSON.stringify({ selection, result })}`);
		}
		await call("set_mesh_selection", { nodeId: fixtureId, mode: "edge", indices: [0] });
		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] loop cut: mesh=${fixtureId} model=${result.loopCutModel} cuts=${result.cuts} offset=${result.offset} closed=${result.stripClosed} quads=${result.stripQuadCount} vertices=${result.vertexCount} faces=${result.triangleCount}`
		);
		console.log(`[live-scenario] stale rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		console.log(`[live-scenario] offset rejection: ${offsetEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected loop-cut mesh for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live loop-cut cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] loop-cut cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 10. Optional: Unity ProBuilder-style face detach through both supported
	// modes, with exact topology leases, strict atomic rejection, transform
	// preservation, disconnected submesh proof, and residue-free cleanup.
	if (has("--probuilder-detach")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const fixtureIds = [];
		let detachedId = null;
		restore = async () => {
			for (const nodeId of [detachedId, ...fixtureIds].filter(Boolean).reverse()) {
				try {
					await call("delete_node", { nodeId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const submeshFixture = JSON.parse(await call("create_primitive_mesh", { type: "box", name: `Codex Detach Submesh ${process.pid}`, position: [-250, 200, 0] }));
		fixtureIds.push(submeshFixture.id);
		const submeshTopology = JSON.parse(await call("get_mesh_topology", { nodeId: submeshFixture.id }));
		if (!submeshTopology.topologyFingerprint || submeshTopology.faceCount !== 12) {
			throw new Error(`live detach fixture did not expose the expected exact box topology: ${JSON.stringify(submeshTopology)}`);
		}
		const beforeRejected = JSON.parse(await call("get_mesh_vertex_data", { nodeId: submeshFixture.id }));
		const staleEvidence = await expectCallFailure(
			"detach_mesh_faces",
			{ nodeId: submeshFixture.id, expectedTopologyFingerprint: "stale", faceIndices: [0, 1], mode: "submesh" },
			/stale/i
		);
		const duplicateEvidence = await expectCallFailure(
			"detach_mesh_faces",
			{ nodeId: submeshFixture.id, expectedTopologyFingerprint: submeshTopology.topologyFingerprint, faceIndices: [0, 0], mode: "submesh" },
			/unique/i
		);
		const completeEvidence = await expectCallFailure(
			"detach_mesh_faces",
			{
				nodeId: submeshFixture.id,
				expectedTopologyFingerprint: submeshTopology.topologyFingerprint,
				faceIndices: Array.from({ length: submeshTopology.faceCount }, (_, index) => index),
				mode: "submesh",
			},
			/at least one unselected/i
		);
		const unknownEvidence = await expectCallFailure(
			"detach_mesh_faces",
			{
				nodeId: submeshFixture.id,
				expectedTopologyFingerprint: submeshTopology.topologyFingerprint,
				faceIndices: [0, 1],
				mode: "submesh",
				unknownDetachField: true,
			},
			/(unrecognized|invalid)/i
		);
		const afterRejected = JSON.parse(await call("get_mesh_vertex_data", { nodeId: submeshFixture.id }));
		if (
			JSON.stringify(afterRejected.positions) !== JSON.stringify(beforeRejected.positions) ||
			JSON.stringify(afterRejected.indices) !== JSON.stringify(beforeRejected.indices)
		) {
			throw new Error("invalid face-detach requests changed the live mesh before rejection");
		}

		const submeshResult = JSON.parse(
			await call("detach_mesh_faces", {
				nodeId: submeshFixture.id,
				expectedTopologyFingerprint: submeshTopology.topologyFingerprint,
				faceIndices: [0, 1],
				mode: "submesh",
			})
		);
		const submeshData = JSON.parse(await call("get_mesh_vertex_data", { nodeId: submeshFixture.id }));
		const submeshSelection = JSON.parse(await call("get_mesh_selection", { nodeId: submeshFixture.id }));
		const sourceIndices = new Set(submeshData.indices.slice(0, submeshResult.remainingFaceCount * 3));
		const detachedIndices = new Set(submeshData.indices.slice(submeshResult.remainingFaceCount * 3));
		const sharesVertex = [...detachedIndices].some((index) => sourceIndices.has(index));
		if (
			submeshResult.detachModel !== "stream-preserving-face-detach-v1" ||
			submeshResult.mode !== "submesh" ||
			submeshResult.detachedMesh !== null ||
			submeshResult.detachedFaceCount !== 2 ||
			submeshResult.remainingFaceCount !== 10 ||
			submeshResult.sourceSubMeshes.length !== 2 ||
			submeshSelection.mode !== "face" ||
			JSON.stringify(submeshSelection.indices) !== JSON.stringify([10, 11]) ||
			sharesVertex
		) {
			throw new Error(`submesh detach returned incomplete or connected evidence: ${JSON.stringify({ submeshResult, submeshSelection, sharesVertex })}`);
		}

		const gameObjectFixture = JSON.parse(await call("create_primitive_mesh", { type: "box", name: `Codex Detach Game Object ${process.pid}`, position: [250, 200, 0] }));
		fixtureIds.push(gameObjectFixture.id);
		await call("set_node_transform", { nodeId: gameObjectFixture.id, position: [250, 200, 50], rotation: [0.1, 0.2, 0.3], scaling: [1.25, 0.75, 1.5] });
		const gameObjectBefore = JSON.parse(await call("get_node", { nodeId: gameObjectFixture.id }));
		const gameObjectTopology = JSON.parse(await call("get_mesh_topology", { nodeId: gameObjectFixture.id }));
		const gameObjectResult = JSON.parse(
			await call("detach_mesh_faces", {
				nodeId: gameObjectFixture.id,
				expectedTopologyFingerprint: gameObjectTopology.topologyFingerprint,
				faceIndices: [0, 1],
				mode: "gameObject",
				name: `Codex Detached Faces ${process.pid}`,
			})
		);
		detachedId = gameObjectResult.detachedMesh?.id ?? null;
		if (!detachedId) {
			throw new Error(`game-object detach did not return a detached mesh: ${JSON.stringify(gameObjectResult)}`);
		}
		const gameObjectAfter = JSON.parse(await call("get_mesh_topology", { nodeId: gameObjectFixture.id }));
		const detachedTopology = JSON.parse(await call("get_mesh_topology", { nodeId: detachedId }));
		const detachedNode = JSON.parse(await call("get_node", { nodeId: detachedId }));
		if (
			gameObjectResult.mode !== "gameObject" ||
			gameObjectResult.detachedFaceCount !== 2 ||
			gameObjectResult.remainingFaceCount !== 10 ||
			gameObjectAfter.faceCount !== 10 ||
			detachedTopology.faceCount !== 2 ||
			JSON.stringify(detachedNode.position) !== JSON.stringify(gameObjectBefore.position) ||
			JSON.stringify(detachedNode.rotation) !== JSON.stringify(gameObjectBefore.rotation) ||
			JSON.stringify(detachedNode.scaling) !== JSON.stringify(gameObjectBefore.scaling)
		) {
			throw new Error(
				`game-object detach returned incomplete topology/transform evidence: ${JSON.stringify({ gameObjectResult, gameObjectBefore, gameObjectAfter, detachedTopology, detachedNode })}`
			);
		}

		await call("set_mesh_selection", { nodeId: gameObjectFixture.id, mode: "face", indices: [0] });
		await call("select_node", { nodeId: gameObjectFixture.id });
		console.log(
			`[live-scenario] face detach: model=${gameObjectResult.detachModel} submesh=12→${submeshResult.remainingFaceCount}+${submeshResult.detachedFaceCount} gameObject=12→${gameObjectAfter.faceCount}+${detachedTopology.faceCount} detached=${detachedId}`
		);
		console.log(`[live-scenario] stale rejection: ${staleEvidence}`);
		console.log(`[live-scenario] duplicate rejection: ${duplicateEvidence}`);
		console.log(`[live-scenario] complete-selection rejection: ${completeEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected detach source for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live face-detach cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] face-detach cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 11. Optional: persistent Unity ProBuilder-style smoothing groups through
	// exact leases, manual and angle-generated assignments, strict rejection,
	// visible selected-face authoring, and residue-free cleanup.
	if (has("--probuilder-smoothing")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		let fixtureId = null;
		restore = async () => {
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const fixture = JSON.parse(await call("create_primitive_mesh", { type: "box", name: `Codex Smoothing Groups ${process.pid}`, position: [0, 200, 250] }));
		fixtureId = fixture.id;
		const initial = JSON.parse(await call("get_mesh_smoothing_groups", { nodeId: fixtureId, offset: 0, limit: 24 }));
		if (
			initial.model !== "coincident-face-smoothing-groups-v1" ||
			initial.revision !== 0 ||
			initial.derivedFromCurrentNormals !== true ||
			initial.faceCount !== 12 ||
			initial.returned !== 12
		) {
			throw new Error(`live smoothing fixture did not expose current-normal-derived groups: ${JSON.stringify(initial)}`);
		}
		const beforeRejected = JSON.parse(await call("get_mesh_vertex_data", { nodeId: fixtureId }));
		const staleTopologyEvidence = await expectCallFailure(
			"set_mesh_smoothing_group",
			{ nodeId: fixtureId, expectedTopologyFingerprint: "stale", expectedRevision: 0, faceIndices: [0, 1], group: 1 },
			/topology is stale/i
		);
		const staleRevisionEvidence = await expectCallFailure(
			"set_mesh_smoothing_group",
			{ nodeId: fixtureId, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 1, faceIndices: [0, 1], group: 1 },
			/revision/i
		);
		const duplicateEvidence = await expectCallFailure(
			"set_mesh_smoothing_group",
			{ nodeId: fixtureId, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: [0, 0], group: 1 },
			/unique/i
		);
		const unknownEvidence = await expectCallFailure(
			"set_mesh_smoothing_group",
			{ nodeId: fixtureId, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: [0, 1], group: 1, unknownSmoothingField: true },
			/(unrecognized|invalid)/i
		);
		const afterRejected = JSON.parse(await call("get_mesh_vertex_data", { nodeId: fixtureId }));
		if (
			JSON.stringify(afterRejected.positions) !== JSON.stringify(beforeRejected.positions) ||
			JSON.stringify(afterRejected.normals) !== JSON.stringify(beforeRejected.normals) ||
			JSON.stringify(afterRejected.indices) !== JSON.stringify(beforeRejected.indices)
		) {
			throw new Error("invalid smoothing-group requests changed the live mesh before rejection");
		}

		const allFaces = Array.from({ length: 12 }, (_, index) => index);
		const smoothed = JSON.parse(
			await call("set_mesh_smoothing_group", {
				nodeId: fixtureId,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedRevision: 0,
				faceIndices: allFaces,
				group: 1,
			})
		);
		const smoothData = JSON.parse(await call("get_mesh_vertex_data", { nodeId: fixtureId }));
		const cornerVertices = Array.from({ length: smoothData.positions.length / 3 }, (_, vertex) => vertex).filter(
			(vertex) => smoothData.positions[vertex * 3] === 50 && smoothData.positions[vertex * 3 + 1] === 50 && smoothData.positions[vertex * 3 + 2] === 50
		);
		const cornerNormals = cornerVertices.map((vertex) => smoothData.normals.slice(vertex * 3, vertex * 3 + 3));
		if (
			smoothed.revision !== 1 ||
			smoothed.hardFaceCount !== 0 ||
			smoothed.smoothFaceCount !== 12 ||
			smoothed.assignedGroup !== 1 ||
			!cornerNormals.length ||
			cornerNormals.some((normal) => normal.some((value, index) => Math.abs(value - cornerNormals[0][index]) > 0.000001))
		) {
			throw new Error(`manual smoothing did not publish coincident averaged normals: ${JSON.stringify({ smoothed, cornerNormals })}`);
		}

		const automatic = JSON.parse(
			await call("auto_smooth_mesh_faces", {
				nodeId: fixtureId,
				expectedTopologyFingerprint: smoothed.topologyFingerprint,
				expectedRevision: 1,
				faceIndices: allFaces,
				angleThreshold: 1,
			})
		);
		if (
			automatic.revision !== 2 ||
			automatic.componentCount !== 6 ||
			automatic.assignments.length !== 6 ||
			automatic.assignments.some((assignment) => assignment.faceIndices.length !== 2)
		) {
			throw new Error(`automatic smoothing did not produce six coplanar box groups: ${JSON.stringify(automatic)}`);
		}
		const hardened = JSON.parse(
			await call("set_mesh_smoothing_group", {
				nodeId: fixtureId,
				expectedTopologyFingerprint: automatic.topologyFingerprint,
				expectedRevision: 2,
				faceIndices: [0, 1],
				group: 0,
			})
		);
		const hardPage = JSON.parse(await call("get_mesh_smoothing_groups", { nodeId: fixtureId, group: 0, offset: 0, limit: 10 }));
		if (
			hardened.revision !== 3 ||
			hardened.hardFaceCount !== 2 ||
			hardPage.total !== 2 ||
			JSON.stringify(hardPage.faces.map((face) => face.faceIndex)) !== JSON.stringify([0, 1])
		) {
			throw new Error(`hard-group clear/filter evidence is incomplete: ${JSON.stringify({ hardened, hardPage })}`);
		}

		await call("set_mesh_selection", { nodeId: fixtureId, mode: "face", indices: [2, 3] });
		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] smoothing groups: mesh=${fixtureId} model=${hardened.model} revision=${hardened.revision} manual=1 autoComponents=${automatic.componentCount} hardFaces=${hardened.hardFaceCount} vertices=${smoothData.positions.length / 3}`
		);
		console.log(`[live-scenario] stale-topology rejection: ${staleTopologyEvidence}`);
		console.log(`[live-scenario] stale-revision rejection: ${staleRevisionEvidence}`);
		console.log(`[live-scenario] duplicate rejection: ${duplicateEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected smoothing-group faces for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live smoothing-group cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] smoothing-group cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 12. Optional: Unity ProBuilder-style RGBA vertex painting through exact
	// topology/color/revision leases, face-boundary isolation, strict rejection,
	// visible selected-face authoring, and residue-free cleanup.
	if (has("--probuilder-vertex-colors")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		let fixtureId = null;
		restore = async () => {
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const fixture = JSON.parse(await call("create_primitive_mesh", { type: "plane", name: `Codex Vertex Colors ${process.pid}`, position: [0, 200, 250] }));
		fixtureId = fixture.id;
		const initial = JSON.parse(await call("get_mesh_vertex_colors", { nodeId: fixtureId, offset: 0, limit: 4 }));
		if (
			initial.model !== "selection-vertex-color-rgba-v1" ||
			initial.revision !== 0 ||
			initial.derivedDefaultWhite !== true ||
			initial.hasColorStream !== false ||
			initial.vertexCount !== 4 ||
			initial.faceCount !== 2 ||
			initial.returned !== 4
		) {
			throw new Error(`live vertex-color fixture did not expose exact default-white evidence: ${JSON.stringify(initial)}`);
		}
		const staleTopologyEvidence = await expectCallFailure(
			"paint_mesh_vertex_colors",
			{
				nodeId: fixtureId,
				expectedTopologyFingerprint: "stale",
				expectedColorFingerprint: initial.colorFingerprint,
				expectedRevision: 0,
				targetMode: "vertex",
				vertexIndices: [0],
				color: [1, 0, 0, 1],
			},
			/topology is stale/i
		);
		const staleColorEvidence = await expectCallFailure(
			"paint_mesh_vertex_colors",
			{
				nodeId: fixtureId,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedColorFingerprint: "stale",
				expectedRevision: 0,
				targetMode: "vertex",
				vertexIndices: [0],
				color: [1, 0, 0, 1],
			},
			/values are stale/i
		);
		const staleRevisionEvidence = await expectCallFailure(
			"paint_mesh_vertex_colors",
			{
				nodeId: fixtureId,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedColorFingerprint: initial.colorFingerprint,
				expectedRevision: 1,
				targetMode: "vertex",
				vertexIndices: [0],
				color: [1, 0, 0, 1],
			},
			/revision is stale/i
		);
		const duplicateEvidence = await expectCallFailure(
			"paint_mesh_vertex_colors",
			{
				nodeId: fixtureId,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedColorFingerprint: initial.colorFingerprint,
				expectedRevision: 0,
				targetMode: "vertex",
				vertexIndices: [0, 0],
				color: [1, 0, 0, 1],
			},
			/unique/i
		);
		const unknownEvidence = await expectCallFailure(
			"paint_mesh_vertex_colors",
			{
				nodeId: fixtureId,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedColorFingerprint: initial.colorFingerprint,
				expectedRevision: 0,
				targetMode: "vertex",
				vertexIndices: [0],
				color: [1, 0, 0, 1],
				unknownPaintField: true,
			},
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("get_mesh_vertex_colors", { nodeId: fixtureId, offset: 0, limit: 4 }));
		if (unchanged.topologyFingerprint !== initial.topologyFingerprint || unchanged.colorFingerprint !== initial.colorFingerprint || unchanged.revision !== 0) {
			throw new Error("invalid vertex-color requests changed the live mesh before rejection");
		}

		const painted = JSON.parse(
			await call("paint_mesh_vertex_colors", {
				nodeId: fixtureId,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedColorFingerprint: initial.colorFingerprint,
				expectedRevision: 0,
				targetMode: "face",
				faceIndices: [0],
				color: [1, 0.125, 0, 0.75],
				blendMode: "replace",
				opacity: 1,
				splitFaceBoundaries: true,
			})
		);
		const paintedPage = JSON.parse(await call("get_mesh_vertex_colors", { nodeId: fixtureId, nonWhiteOnly: true, offset: 0, limit: 10 }));
		if (
			painted.revision !== 1 ||
			painted.operation?.splitVertexCount !== 2 ||
			painted.operation?.affectedVertexCount !== 3 ||
			painted.vertexCountBefore !== 4 ||
			painted.vertexCountAfter !== 6 ||
			painted.topologyFingerprintBefore === painted.topologyFingerprintAfter ||
			paintedPage.total !== 3 ||
			paintedPage.vertices.some(
				(entry) =>
					Math.abs(entry.color[0] - 1) > 0.000001 ||
					Math.abs(entry.color[1] - 0.125) > 0.000001 ||
					Math.abs(entry.color[2]) > 0.000001 ||
					Math.abs(entry.color[3] - 0.75) > 0.000001
			)
		) {
			throw new Error(`face-isolated vertex painting returned incomplete evidence: ${JSON.stringify({ painted, paintedPage })}`);
		}

		await call("set_mesh_selection", { nodeId: fixtureId, mode: "face", indices: [0] });
		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] vertex colors: mesh=${fixtureId} model=${painted.model} revision=${painted.revision} vertices=${painted.vertexCountBefore}→${painted.vertexCountAfter} split=${painted.operation.splitVertexCount} painted=${paintedPage.total} alpha=${painted.hasVertexAlpha}`
		);
		console.log(`[live-scenario] stale-topology rejection: ${staleTopologyEvidence}`);
		console.log(`[live-scenario] stale-color rejection: ${staleColorEvidence}`);
		console.log(`[live-scenario] stale-revision rejection: ${staleRevisionEvidence}`);
		console.log(`[live-scenario] duplicate rejection: ${duplicateEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected vertex-painted face for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live vertex-color cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] vertex-color cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 13. Optional: bounded Unity ProBuilder-style mesh validation and repair
	// through the bundled external stdio MCP server. A disposable fixture proves
	// exact inspection, strict atomic rejection, multi-operation repair, optional
	// visible Inspector execution, and residue-free cleanup.
	if (has("--probuilder-integrity")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		let fixtureId = null;
		const positions = [0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0, 0, 0, 0, 900, 900, 900];
		const normals = Array.from({ length: 6 }, () => [0, 0, 1]).flat();
		const uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0.5, 0.5];
		const indices = [0, 1, 2, 0, 3, 2, 0, 0, 1, 4, 1, 2];
		const corruptFixture = async () =>
			call("set_mesh_vertex_data", {
				nodeId: fixtureId,
				positions,
				normals,
				uvs,
				indices,
			});
		restore = async () => {
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const fixture = JSON.parse(await call("create_primitive_mesh", { type: "plane", name: `Codex Mesh Integrity ${process.pid}`, position: [0, 200, -250] }));
		fixtureId = fixture.id;
		await corruptFixture();
		const initial = JSON.parse(await call("inspect_mesh_integrity", { nodeId: fixtureId, offset: 0, limit: 256 }));
		const degeneratePage = JSON.parse(await call("inspect_mesh_integrity", { nodeId: fixtureId, categories: ["degenerateFaces"], severity: "error", offset: 0, limit: 1 }));
		if (
			initial.model !== "bounded-triangle-mesh-integrity-v1" ||
			initial.valid !== false ||
			initial.structurallyRepairable !== true ||
			initial.counts.vertices !== 6 ||
			initial.counts.completeFaces !== 4 ||
			initial.counts.validFaces !== 2 ||
			initial.counts.unusedVertices !== 1 ||
			initial.counts.weldableVertexGroups !== 1 ||
			initial.counts.nonManifoldEdges !== 1 ||
			initial.counts.inconsistentWindingEdges !== 2 ||
			degeneratePage.total !== 1 ||
			degeneratePage.returned !== 1
		) {
			throw new Error(`live mesh-integrity fixture did not expose exact bounded diagnostics: ${JSON.stringify({ initial, degeneratePage })}`);
		}
		const staleEvidence = await expectCallFailure(
			"repair_mesh_integrity",
			{
				nodeId: fixtureId,
				expectedIntegrityFingerprint: "stale",
				operations: ["removeDegenerateFaces"],
				confirm: true,
			},
			/stale/i
		);
		const confirmationEvidence = await expectCallFailure(
			"repair_mesh_integrity",
			{
				nodeId: fixtureId,
				expectedIntegrityFingerprint: initial.integrityFingerprint,
				operations: ["removeDegenerateFaces"],
				confirm: false,
			},
			/(invalid|true|confirm)/i
		);
		const duplicateEvidence = await expectCallFailure(
			"repair_mesh_integrity",
			{
				nodeId: fixtureId,
				expectedIntegrityFingerprint: initial.integrityFingerprint,
				operations: ["removeDegenerateFaces", "removeDegenerateFaces"],
				confirm: true,
			},
			/(unique|invalid)/i
		);
		const unknownEvidence = await expectCallFailure(
			"repair_mesh_integrity",
			{
				nodeId: fixtureId,
				expectedIntegrityFingerprint: initial.integrityFingerprint,
				operations: ["removeDegenerateFaces"],
				confirm: true,
				unknownRepairField: true,
			},
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("inspect_mesh_integrity", { nodeId: fixtureId }));
		if (unchanged.integrityFingerprint !== initial.integrityFingerprint) {
			throw new Error("invalid mesh-integrity repair requests changed the live mesh before rejection");
		}

		const repaired = JSON.parse(
			await call("repair_mesh_integrity", {
				nodeId: fixtureId,
				expectedIntegrityFingerprint: initial.integrityFingerprint,
				operations: [
					"removeInvalidFaces",
					"removeDegenerateFaces",
					"removeDuplicateFaces",
					"removeUnusedVertices",
					"weldIdenticalVertices",
					"fixWinding",
					"rebuildNormals",
					"rebuildSubMeshes",
				],
				confirm: true,
			})
		);
		if (
			repaired.valid !== true ||
			repaired.countsBefore.vertices !== 6 ||
			repaired.countsBefore.faces !== 4 ||
			repaired.countsAfter.vertices !== 4 ||
			repaired.countsAfter.faces !== 2 ||
			repaired.removedDegenerateFaces !== 1 ||
			repaired.removedDuplicateFaces !== 1 ||
			repaired.flippedFaceCount !== 1 ||
			repaired.counts.nonManifoldEdges !== 0 ||
			repaired.counts.inconsistentWindingEdges !== 0
		) {
			throw new Error(`live mesh repair returned incomplete evidence: ${JSON.stringify(repaired)}`);
		}

		console.log(
			`[live-scenario] mesh integrity: mesh=${fixtureId} model=${initial.model} errors=${initial.issueCounts.errors} warnings=${initial.issueCounts.warnings} vertices=${repaired.countsBefore.vertices}→${repaired.countsAfter.vertices} faces=${repaired.countsBefore.faces}→${repaired.countsAfter.faces}`
		);
		console.log(`[live-scenario] stale-fingerprint rejection: ${staleEvidence}`);
		console.log(`[live-scenario] confirmation rejection: ${confirmationEvidence}`);
		console.log(`[live-scenario] duplicate rejection: ${duplicateEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			await corruptFixture();
			await call("select_node", { nodeId: fixtureId });
			console.log(`[live-scenario] holding the selected corrupt mesh for ${holdMilliseconds}ms of visible Inspector repair verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live mesh-integrity cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] mesh-integrity cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 14. Optional: Unity-style world-stable ProBuilder pivot authoring through
	// the bundled external stdio MCP server. A disposable asymmetric fixture
	// proves bounds, selection, and explicit-world sources; exact stale/schema
	// rejection; invariant evidence; optional visible Inspector execution; and
	// residue-free cleanup.
	if (has("--probuilder-pivot")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		let fixtureId = null;
		restore = async () => {
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const fixture = JSON.parse(await call("create_primitive_mesh", { type: "plane", name: `Codex Pivot ${process.pid}`, position: [0, 200, -250] }));
		fixtureId = fixture.id;
		await call("set_mesh_vertex_data", {
			nodeId: fixtureId,
			positions: [0, 0, 0, 100, 0, 0, 100, 50, 0, 0, 50, 0],
			indices: [0, 1, 2, 0, 2, 3],
		});
		const initial = JSON.parse(await call("get_mesh_pivot", { nodeId: fixtureId }));
		if (
			initial.model !== "unity-world-stable-mesh-pivot-v1" ||
			initial.geometry.vertexCount !== 4 ||
			initial.geometry.faceCount !== 2 ||
			initial.geometry.boundsCenterLocal.some((value, index) => Math.abs(value - [50, 25, 0][index]) > 0.000001)
		) {
			throw new Error(`live pivot fixture returned incomplete inspection evidence: ${JSON.stringify(initial)}`);
		}
		const staleEvidence = await expectCallFailure("set_mesh_pivot", { nodeId: fixtureId, expectedPivotFingerprint: "stale", mode: "boundsCenter" }, /stale/i);
		const duplicateEvidence = await expectCallFailure(
			"set_mesh_pivot",
			{
				nodeId: fixtureId,
				expectedPivotFingerprint: initial.pivotFingerprint,
				mode: "selectionAverage",
				selectionMode: "vertex",
				componentIndices: [0, 0],
			},
			/(unique|invalid)/i
		);
		const invalidModeFieldsEvidence = await expectCallFailure(
			"set_mesh_pivot",
			{ nodeId: fixtureId, expectedPivotFingerprint: initial.pivotFingerprint, mode: "boundsCenter", worldPosition: [0, 0, 0] },
			/(does not accept|invalid|target fields)/i
		);
		const unknownEvidence = await expectCallFailure(
			"set_mesh_pivot",
			{ nodeId: fixtureId, expectedPivotFingerprint: initial.pivotFingerprint, mode: "boundsCenter", preserveGeometry: true },
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("get_mesh_pivot", { nodeId: fixtureId }));
		if (unchanged.pivotFingerprint !== initial.pivotFingerprint) {
			throw new Error("invalid pivot requests changed the live mesh before rejection");
		}

		const centered = JSON.parse(await call("set_mesh_pivot", { nodeId: fixtureId, expectedPivotFingerprint: initial.pivotFingerprint, mode: "boundsCenter" }));
		if (
			centered.pivot.local.some((value, index) => Math.abs(value - [50, 25, 0][index]) > 0.000001) ||
			centered.pivotFingerprint === initial.pivotFingerprint ||
			centered.topologyFingerprint !== initial.topologyFingerprint ||
			!centered.verification.worldGeometryPreserved ||
			!centered.verification.topologyPreserved ||
			centered.verification.maximumWorldVertexDrift > centered.verification.tolerance
		) {
			throw new Error(`live centered pivot returned incomplete invariant evidence: ${JSON.stringify(centered)}`);
		}

		const selected = JSON.parse(
			await call("set_mesh_pivot", {
				nodeId: fixtureId,
				expectedPivotFingerprint: centered.pivotFingerprint,
				mode: "selectionAverage",
				selectionMode: "face",
				componentIndices: [1],
			})
		);
		if (
			selected.selectedVertexCount !== 3 ||
			Math.abs(selected.pivot.local[0] - 100 / 3) > 0.00001 ||
			Math.abs(selected.pivot.local[1] - 100 / 3) > 0.00001 ||
			selected.topologyFingerprint !== initial.topologyFingerprint
		) {
			throw new Error(`live selection-average pivot returned incomplete evidence: ${JSON.stringify(selected)}`);
		}

		const targetWorld = [75, 125, -200];
		const explicit = JSON.parse(
			await call("set_mesh_pivot", {
				nodeId: fixtureId,
				expectedPivotFingerprint: selected.pivotFingerprint,
				mode: "world",
				worldPosition: targetWorld,
			})
		);
		if (
			explicit.pivot.world.some((value, index) => Math.abs(value - targetWorld[index]) > explicit.verification.tolerance) ||
			explicit.topologyFingerprint !== initial.topologyFingerprint ||
			!explicit.verification.worldGeometryPreserved ||
			explicit.verification.worldMatrixDrift > explicit.verification.tolerance ||
			explicit.verification.pivotTargetDrift > explicit.verification.tolerance
		) {
			throw new Error(`live explicit-world pivot returned incomplete invariant evidence: ${JSON.stringify(explicit)}`);
		}

		await call("set_mesh_selection", { nodeId: fixtureId, mode: "face", indices: [1] });
		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] mesh pivot: mesh=${fixtureId} model=${initial.model} local=${explicit.pivot.local.map((value) => value.toFixed(3)).join(",")} world=${explicit.pivot.world.map((value) => value.toFixed(3)).join(",")} matrixDrift=${explicit.verification.worldMatrixDrift} vertexDrift=${explicit.verification.maximumWorldVertexDrift}`
		);
		console.log(`[live-scenario] stale-fingerprint rejection: ${staleEvidence}`);
		console.log(`[live-scenario] duplicate-selection rejection: ${duplicateEvidence}`);
		console.log(`[live-scenario] invalid-mode-fields rejection: ${invalidModeFieldsEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected world-pivot fixture for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live pivot cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] pivot cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 15. Optional: canonical editable-source and detached generated geometry
	// lifecycle through the bundled external stdio MCP server. A disposable
	// duplicate/unused-vertex fixture proves exact source/settings leases,
	// non-mutating generation, strict schema rejection, both compile modes,
	// visible Inspector access, and residue-free cleanup.
	if (has("--probuilder-editable-source")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		let fixtureId = null;
		restore = async () => {
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) {
						throw error;
					}
				}
			}
		};

		const fixture = JSON.parse(await call("create_primitive_mesh", { type: "plane", name: `Codex Editable Source ${process.pid}`, position: [0, 200, -250] }));
		fixtureId = fixture.id;
		await call("set_mesh_vertex_data", {
			nodeId: fixtureId,
			positions: [0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 0, 900, 900, 900],
			uvs: [0, 0, 1, 0, 0, 1, 0, 0, 0.5, 0.5],
			indices: [0, 1, 2, 3, 1, 2],
		});
		const initial = JSON.parse(await call("get_mesh_editable_source", { nodeId: fixtureId }));
		if (
			initial.model !== "unity-editable-source-generated-export-v1" ||
			initial.ownership.canonical !== "live-and-project-source-geometry" ||
			initial.ownership.generated !== "detached-derived-runtime-artifact" ||
			initial.source.vertexCount !== 5 ||
			initial.source.faceCount !== 2 ||
			initial.exportSettings.optimize !== true ||
			initial.generated.vertexCount !== 3 ||
			initial.generated.removedUnusedOrDuplicateVertices !== 2 ||
			initial.generated.sourcePreserved !== true
		) {
			throw new Error(`live editable-source fixture returned incomplete evidence: ${JSON.stringify(initial)}`);
		}
		const staleSourceEvidence = await expectCallFailure(
			"set_mesh_export_geometry",
			{
				nodeId: fixtureId,
				expectedSourceFingerprint: "stale",
				expectedSourceRevision: initial.source.revision,
				expectedExportSettingsRevision: initial.exportSettings.revision,
				optimize: false,
			},
			/stale/i
		);
		const staleSettingsEvidence = await expectCallFailure(
			"set_mesh_export_geometry",
			{
				nodeId: fixtureId,
				expectedSourceFingerprint: initial.source.fingerprint,
				expectedSourceRevision: initial.source.revision,
				expectedExportSettingsRevision: 999999,
				optimize: false,
			},
			/settings are stale/i
		);
		const unknownEvidence = await expectCallFailure(
			"set_mesh_export_geometry",
			{
				nodeId: fixtureId,
				expectedSourceFingerprint: initial.source.fingerprint,
				expectedSourceRevision: initial.source.revision,
				expectedExportSettingsRevision: initial.exportSettings.revision,
				optimize: false,
				replaceSource: true,
			},
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("get_mesh_editable_source", { nodeId: fixtureId }));
		if (unchanged.source.fingerprint !== initial.source.fingerprint || unchanged.exportSettings.revision !== initial.exportSettings.revision) {
			throw new Error("invalid editable-source requests changed live source or policy before rejection");
		}

		const preserved = JSON.parse(
			await call("set_mesh_export_geometry", {
				nodeId: fixtureId,
				expectedSourceFingerprint: initial.source.fingerprint,
				expectedSourceRevision: initial.source.revision,
				expectedExportSettingsRevision: initial.exportSettings.revision,
				optimize: false,
			})
		);
		if (
			preserved.changed !== true ||
			preserved.source.fingerprint !== initial.source.fingerprint ||
			preserved.source.revision !== initial.source.revision ||
			preserved.exportSettings.revision !== initial.exportSettings.revision + 1 ||
			preserved.generated.vertexCount !== 5 ||
			preserved.generated.fingerprint !== initial.source.fingerprint ||
			preserved.generated.sourcePreserved !== true
		) {
			throw new Error(`live preserve-source compile returned incomplete evidence: ${JSON.stringify(preserved)}`);
		}

		const optimized = JSON.parse(
			await call("set_mesh_export_geometry", {
				nodeId: fixtureId,
				expectedSourceFingerprint: preserved.source.fingerprint,
				expectedSourceRevision: preserved.source.revision,
				expectedExportSettingsRevision: preserved.exportSettings.revision,
				optimize: true,
			})
		);
		if (
			optimized.source.fingerprint !== initial.source.fingerprint ||
			optimized.source.vertexCount !== 5 ||
			optimized.generated.vertexCount !== 3 ||
			optimized.generated.removedUnusedOrDuplicateVertices !== 2 ||
			optimized.generated.optimizationApplied !== true ||
			optimized.generated.sourcePreserved !== true
		) {
			throw new Error(`live optimized compile returned incomplete evidence: ${JSON.stringify(optimized)}`);
		}

		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] editable source: mesh=${fixtureId} model=${initial.model} source=${optimized.source.vertexCount}/${optimized.source.faceCount} generated=${optimized.generated.vertexCount}/${optimized.generated.faceCount} removed=${optimized.generated.removedUnusedOrDuplicateVertices} sourcePreserved=${optimized.generated.sourcePreserved}`
		);
		console.log(`[live-scenario] stale-source rejection: ${staleSourceEvidence}`);
		console.log(`[live-scenario] stale-settings rejection: ${staleSettingsEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding the selected editable-source fixture for ${holdMilliseconds}ms of visible Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live editable-source cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] editable-source cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 16. Optional: exact-leased asynchronous Terrain tile-streaming lifecycle.
	// Two disposable Grounds prove strict creation/update/list/delete behavior,
	// distance hysteresis settings, remote-origin policy, one-owner safety, live
	// runtime configuration evidence, stale rejection, and residue-free cleanup.
	if (has("--terrain-remote-streaming")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const fixtureIds = [];
		let groupId = null;
		restore = async () => {
			if (groupId) {
				const groups = JSON.parse(await call("list_terrain_streaming_groups")).groups;
				const group = groups.find((candidate) => candidate.id === groupId);
				if (group) {
					await call("delete_terrain_streaming_group", { groupId, expectedRevision: group.revision });
				}
				groupId = null;
			}
			for (const nodeId of fixtureIds.reverse()) {
				try {
					await call("delete_node", { nodeId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
		};

		const first = JSON.parse(
			await call("create_primitive_mesh", {
				type: "ground",
				name: `Codex Stream Tile A ${process.pid}`,
				position: [0, 0, 0],
				options: { width: 1000, height: 1000, subdivisions: 8 },
			})
		);
		fixtureIds.push(first.id);
		const second = JSON.parse(
			await call("create_primitive_mesh", {
				type: "ground",
				name: `Codex Stream Tile B ${process.pid}`,
				position: [1500, 0, 0],
				options: { width: 1000, height: 1000, subdivisions: 8 },
			})
		);
		fixtureIds.push(second.id);

		const created = JSON.parse(
			await call("set_terrain_streaming_group", {
				name: `Codex Async Terrain ${process.pid}`,
				terrainIds: [first.id, second.id],
				distance: 3000,
				preloadDistance: 4000,
				unloadDistance: 5000,
				unloadDelayMs: 250,
				maxConcurrentLoads: 3,
				retryCount: 4,
				requestTimeoutMs: 12000,
				remoteBaseUrl: "http://127.0.0.1:8787/content?ignored=true#fragment",
				streamGeometry: true,
			})
		);
		groupId = created.id;
		if (
			created.version !== 2 ||
			created.revision !== 1 ||
			created.streamGeometry !== true ||
			created.releaseGeometry !== false ||
			created.remoteBaseUrl !== "http://127.0.0.1:8787/content/" ||
			created.runtime?.configured !== true
		) {
			throw new Error(`live terrain creation returned incomplete evidence: ${JSON.stringify(created)}`);
		}

		const staleEvidence = await expectCallFailure("set_terrain_streaming_group", { groupId, expectedRevision: 999999, distance: 2500 }, /stale/i);
		const unsafeOriginEvidence = await expectCallFailure(
			"set_terrain_streaming_group",
			{ groupId, expectedRevision: created.revision, remoteBaseUrl: "http://example.com/world" },
			/HTTPS/i
		);
		const duplicateOwnerEvidence = await expectCallFailure(
			"set_terrain_streaming_group",
			{ name: `Codex Duplicate Terrain ${process.pid}`, terrainIds: [first.id], distance: 1000 },
			/already belongs/i
		);
		const unknownEvidence = await expectCallFailure(
			"set_terrain_streaming_group",
			{ groupId, expectedRevision: created.revision, distance: 2500, unboundedDownloads: true },
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("list_terrain_streaming_groups"));
		const unchangedGroup = unchanged.groups.find((candidate) => candidate.id === groupId);
		if (unchanged.model !== "unity-async-terrain-tile-streaming-v1" || unchangedGroup?.revision !== created.revision || unchanged.limits.maxConcurrentLoads !== 16) {
			throw new Error(`invalid terrain requests changed state or omitted bounded evidence: ${JSON.stringify(unchanged)}`);
		}

		const updated = JSON.parse(
			await call("set_terrain_streaming_group", {
				groupId,
				expectedRevision: created.revision,
				distance: 3500,
				preloadDistance: 4500,
				unloadDistance: 6000,
				maxConcurrentLoads: 4,
			})
		);
		if (updated.revision !== 2 || updated.distance !== 3500 || updated.preloadDistance !== 4500 || updated.unloadDistance !== 6000 || updated.maxConcurrentLoads !== 4) {
			throw new Error(`live terrain update returned incomplete evidence: ${JSON.stringify(updated)}`);
		}

		console.log(
			`[live-scenario] async terrain: group=${groupId} revision=${updated.revision} tiles=${updated.terrainIds.length} visible=${updated.distance} preload=${updated.preloadDistance} unload=${updated.unloadDistance} concurrent=${updated.maxConcurrentLoads}`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unsafe-origin rejection: ${unsafeOriginEvidence}`);
		console.log(`[live-scenario] duplicate-owner rejection: ${duplicateOwnerEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding terrain fixtures for ${holdMilliseconds}ms; select the Scene root to inspect Terrain Tile Streaming`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials) {
			throw new Error(`live terrain cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics })}`);
		}
		console.log(`[live-scenario] terrain cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials}`);
	}

	// 17. Optional: exact-revision spline camera-path timeline lifecycle.
	// Disposable spline/camera/virtual-camera fixtures prove timed eased keys,
	// seek/play/pause, strict rejection, visible Inspector access, and cleanup.
	if (has("--spline-camera-timeline")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineVirtualCameras = JSON.parse(await call("list_virtual_cameras")).virtualCameras.length;
		let splineId = null;
		let cameraId = null;
		let virtualCameraId = null;
		let noiseProfileId = null;
		let impulseId = null;
		let targetGroupId = null;
		restore = async () => {
			if (impulseId) {
				await call("delete_camera_impulse_source", { impulseId }).catch((error) => {
					if (!/not found/i.test(error.message)) throw error;
				});
				impulseId = null;
			}
			if (targetGroupId) {
				await call("delete_camera_target_group", { targetGroupId }).catch((error) => {
					if (!/not found/i.test(error.message)) throw error;
				});
				targetGroupId = null;
			}
			if (noiseProfileId) {
				await call("delete_camera_noise_profile", { noiseProfileId, force: true }).catch((error) => {
					if (!/not found/i.test(error.message)) throw error;
				});
				noiseProfileId = null;
			}
			if (virtualCameraId) {
				try {
					const timeline = JSON.parse(await call("get_virtual_camera_path_timeline", { virtualCameraId })).timeline;
					if (timeline) await call("set_virtual_camera_path_timeline", { virtualCameraId, expectedRevision: timeline.revision, clear: true });
					await call("delete_virtual_camera", { virtualCameraId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				virtualCameraId = null;
			}
			for (const nodeId of [cameraId, splineId]) {
				if (!nodeId) continue;
				try {
					await call("delete_node", { nodeId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
			cameraId = null;
			splineId = null;
		};

		const spline = JSON.parse(
			await call("create_spline", {
				name: `Codex Camera Path ${process.pid}`,
				points: [
					[0, 200, -400],
					[300, 250, -100],
					[600, 200, 200],
				],
				radius: 3,
				tessellation: 8,
				closed: false,
			})
		);
		splineId = spline.node.id;
		const camera = JSON.parse(await call("create_camera", { type: "free", name: `Codex Timeline Camera ${process.pid}`, position: [0, 200, -400] }));
		cameraId = camera.id;
		const virtualCamera = JSON.parse(await call("create_virtual_camera", { name: `Codex Timeline Shot ${process.pid}`, cameraId }));
		virtualCameraId = virtualCamera.id;
		const emptyChannels = { x: [], y: [], z: [] };
		const noiseProfile = JSON.parse(
			await call("set_camera_noise_profile", {
				name: `Codex Camera Noise ${process.pid}`,
				position: { x: [{ amplitude: 2, frequency: 3, nonRandom: true, phase: 0 }], y: [], z: [] },
				rotation: emptyChannels,
			})
		);
		noiseProfileId = noiseProfile.id;
		const noisy = JSON.parse(
			await call("set_virtual_camera_noise", {
				virtualCameraId,
				noiseProfileId,
				enabled: true,
				amplitudeGain: 0.5,
				frequencyGain: 1,
				pivotOffset: [0, 1, 0],
				seed: 7,
			})
		);
		if (noisy.virtualCamera.noise?.profileId !== noiseProfileId) throw new Error("Virtual camera noise assignment did not round-trip.");
		const targetGroup = JSON.parse(await call("set_camera_target_group", { name: `Codex Camera Target ${process.pid}`, members: [{ nodeId: splineId, weight: 1 }] }));
		targetGroupId = targetGroup.id;
		await call("set_virtual_camera_target_groups", { virtualCameraId, followTargetGroupId: targetGroupId, lookAtTargetGroupId: targetGroupId });
		await call("set_virtual_camera_deoccluder", {
			virtualCameraId,
			enabled: true,
			avoidObstacles: true,
			strategy: "pullForward",
			minimumDistanceFromTarget: 10,
			cameraRadius: 2,
			shotQuality: { enabled: true, nearLimit: 10, optimalDistance: 100, farLimit: 1000 },
		});
		await call("set_virtual_camera_impulse_listener", { virtualCameraId, channelMask: 1 });
		const impulse = JSON.parse(
			await call("set_camera_impulse_source", {
				name: `Codex Camera Impulse ${process.pid}`,
				amplitude: 2,
				duration: 0.25,
				frequency: 8,
				direction: [1, 0, 0],
				cameraId,
				channelMask: 1,
				noiseProfileId,
			})
		);
		impulseId = impulse.id;
		const fired = JSON.parse(await call("fire_camera_impulse", { impulseId, origin: [0, 0, 0], impact: 1 }));
		if (!fired.fired) throw new Error("Camera impulse did not fire.");
		await call("activate_virtual_camera", { virtualCameraId });
		await call("blend_virtual_camera", { virtualCameraId, duration: 0 });
		await call("activate_highest_priority_virtual_camera");
		const cameraRuntime = JSON.parse(await call("get_virtual_camera_runtime", { virtualCameraId }));
		if (!cameraRuntime.evaluated || cameraRuntime.virtualCamera.id !== virtualCameraId) throw new Error("Virtual camera runtime evidence is incomplete.");
		await call("set_virtual_camera_dolly", { virtualCameraId, splineId, t: 0, speed: 0, loop: false, orientToPath: true });
		const created = JSON.parse(
			await call("set_virtual_camera_path_timeline", {
				virtualCameraId,
				duration: 4,
				autoPlay: false,
				wrapMode: "pingPong",
				keys: [
					{ id: "opening", time: 0, t: 0, easing: "easeInOut" },
					{ id: "apex", time: 2, t: 0.4, easing: "easeOut" },
					{ id: "finish", time: 4, t: 1, easing: "linear" },
				],
			})
		);
		if (created.model !== "unity-spline-camera-path-timeline-v1" || created.timeline.revision !== 1 || created.timeline.keys.length !== 3) {
			throw new Error(`live spline timeline creation returned incomplete evidence: ${JSON.stringify(created)}`);
		}
		const staleEvidence = await expectCallFailure("set_virtual_camera_path_timeline", { virtualCameraId, expectedRevision: 999999, autoPlay: true }, /stale/i);
		const invalidEvidence = await expectCallFailure(
			"set_virtual_camera_path_timeline",
			{
				virtualCameraId,
				expectedRevision: 1,
				keys: [
					{ id: "opening", time: 0, t: 0 },
					{ id: "finish", time: 0, t: 1 },
				],
			},
			/(strictly increasing|endpoint)/i
		);
		const unknownEvidence = await expectCallFailure(
			"set_virtual_camera_path_timeline",
			{ virtualCameraId, expectedRevision: 1, autoPlay: true, cinematicMagic: true },
			/(unrecognized|invalid)/i
		);
		const seek = JSON.parse(await call("control_virtual_camera_path_timeline", { virtualCameraId, expectedRevision: 1, action: "seek", time: 2 }));
		if (seek.runtime.time !== 2 || seek.runtime.pathT !== 0.4 || seek.runtime.fromKeyId !== "opening" || seek.runtime.toKeyId !== "apex") {
			throw new Error(`live spline timeline seek returned incomplete evidence: ${JSON.stringify(seek)}`);
		}
		const playing = JSON.parse(await call("control_virtual_camera_path_timeline", { virtualCameraId, expectedRevision: 1, action: "play" }));
		if (!playing.runtime.playing) throw new Error(`live spline timeline did not play: ${JSON.stringify(playing)}`);
		const paused = JSON.parse(await call("control_virtual_camera_path_timeline", { virtualCameraId, expectedRevision: 1, action: "pause" }));
		if (paused.runtime.playing || paused.runtime.time < 2) throw new Error(`live spline timeline did not pause: ${JSON.stringify(paused)}`);
		const unchanged = JSON.parse(await call("get_virtual_camera_path_timeline", { virtualCameraId }));
		if (unchanged.timeline.revision !== 1 || unchanged.timeline.autoPlay !== false || unchanged.limits.maximumKeys !== 512) {
			throw new Error(`invalid spline timeline requests changed state or omitted bounds: ${JSON.stringify(unchanged)}`);
		}

		await call("select_node", { nodeId: cameraId });
		console.log(
			`[live-scenario] spline camera timeline: camera=${cameraId} spline=${splineId} revision=${unchanged.timeline.revision} keys=${unchanged.timeline.keys.length} time=${paused.runtime.time.toFixed(3)} pathT=${paused.runtime.pathT.toFixed(3)} wrap=${unchanged.timeline.wrapMode}`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] invalid-key rejection: ${invalidEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding selected camera for ${holdMilliseconds}ms of Path Timeline Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalVirtualCameras = JSON.parse(await call("list_virtual_cameras")).virtualCameras.length;
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.cameras !== baselineDiagnostics.cameras || finalVirtualCameras !== baselineVirtualCameras) {
			throw new Error(`live spline timeline cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineVirtualCameras, finalVirtualCameras })}`);
		}
		console.log(`[live-scenario] spline timeline cleanup: meshes=${finalDiagnostics.meshes} cameras=${finalDiagnostics.cameras} virtualCameras=${finalVirtualCameras}`);
	}

	// 18. Optional: persisted paired-wheel anti-roll authoring, fixed-step
	// runtime evidence, strict rejection, visible Inspector state, and cleanup.
	if (has("--vehicle-anti-roll")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineVehicles = JSON.parse(await call("list_vehicles")).vehicles;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		const fixtureIds = [];
		let vehicleId = null;
		let pausedByScenario = false;
		restore = async () => {
			if (vehicleId) {
				try {
					await call("delete_vehicle", { id: vehicleId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				vehicleId = null;
			}
			for (const nodeId of fixtureIds.reverse()) {
				try {
					await call("delete_node", { nodeId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
			fixtureIds.length = 0;
			if (pausedByScenario) {
				await call("set_physics_simulation_paused", { paused: false });
				pausedByScenario = false;
			}
		};

		const ground = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Anti-roll Ground ${process.pid}`,
				position: [0, -10, 0],
				options: { width: 1000, height: 20, depth: 1000 },
			})
		);
		fixtureIds.push(ground.id);
		const chassis = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Anti-roll Chassis ${process.pid}`,
				position: [0, 100, 0],
				options: { width: 100, height: 60, depth: 180 },
			})
		);
		fixtureIds.push(chassis.id);
		await call("set_mesh_physics", { nodeId: ground.id, enabled: true, motionType: "static", shapeType: "box", friction: 1 });
		await call("set_mesh_physics", { nodeId: chassis.id, enabled: true, motionType: "dynamic", shapeType: "box", mass: 100, friction: 0.5 });
		if (!baselineControl.paused) {
			await call("set_physics_simulation_paused", { paused: true });
			pausedByScenario = true;
		}

		const wheel = (id, x, y, antiRollGroup) => ({
			id,
			name: id,
			connectionPoint: [x, y, 0],
			radius: 20,
			suspensionRestLength: 80,
			maxTravel: 40,
			springStrength: 0,
			damping: 0,
			steering: false,
			driven: false,
			brake: false,
			antiRollGroup,
		});
		const wheels = [wheel("left", -35, -45, "front"), wheel("right", 35, -25, "front")];
		const created = JSON.parse(
			await call("create_vehicle", {
				id: `codex-anti-roll-${process.pid}`,
				name: "Codex Anti-roll Vehicle",
				chassisNodeId: chassis.id,
				maxEngineForce: 0,
				maxBrakeForce: 0,
				lateralGrip: 0,
				antiRollStiffness: 100,
				maxAntiRollForce: 500,
				wheels,
			})
		);
		vehicleId = created.id;
		if (created.antiRollStiffness !== 100 || created.maxAntiRollForce !== 500 || created.wheels.filter((entry) => entry.antiRollGroup === "front").length !== 2) {
			throw new Error(`live anti-roll creation returned incomplete authoring: ${JSON.stringify(created)}`);
		}
		const replacedWheels = JSON.parse(await call("set_vehicle_wheels", { id: vehicleId, wheels }));
		if (replacedWheels.id !== vehicleId || replacedWheels.wheels.length !== wheels.length || replacedWheels.wheels.some((entry) => entry.antiRollGroup !== "front")) {
			throw new Error(`live anti-roll wheel replacement returned incomplete authoring: ${JSON.stringify(replacedWheels)}`);
		}

		const invalidPairEvidence = await expectCallFailure(
			"set_vehicle_wheels",
			{ id: vehicleId, wheels: [wheel("left", -35, -45, "unpaired"), wheel("right", 35, -25, null)] },
			/exactly two wheels/i
		);
		const invalidRangeEvidence = await expectCallFailure("set_vehicle", { id: vehicleId, antiRollStiffness: 1000001 }, /(less than or equal|1000000)/i);
		const unknownEvidence = await expectCallFailure("set_vehicle", { id: vehicleId, antiRollStiffness: 100, antiRollMagic: true }, /(unrecognized|invalid)/i);
		await call("step_physics_simulation", { steps: 1, deltaSeconds: 1 / 60 });
		const listed = JSON.parse(await call("list_vehicles"));
		const live = listed.vehicles.find((entry) => entry.id === vehicleId);
		const leftForce = live?.wheelStates?.left?.antiRollForce;
		const rightForce = live?.wheelStates?.right?.antiRollForce;
		if (live?.antiRollStiffness !== 100 || live?.maxAntiRollForce !== 500 || !live.wheelStates?.left?.grounded || !live.wheelStates?.right?.grounded) {
			throw new Error(`live anti-roll state omitted authored or grounded-wheel evidence: ${JSON.stringify(live)}`);
		}
		if (leftForce !== 500 || rightForce !== -500) {
			throw new Error(`live anti-roll forces were not equal, opposite, and capped: ${JSON.stringify({ leftForce, rightForce, live })}`);
		}
		const updated = JSON.parse(await call("set_vehicle", { id: vehicleId, antiRollStiffness: 250, maxAntiRollForce: 1000 }));
		if (updated.antiRollStiffness !== 250 || updated.maxAntiRollForce !== 1000) throw new Error(`live anti-roll update was incomplete: ${JSON.stringify(updated)}`);

		await call("select_node", { nodeId: chassis.id });
		console.log(
			`[live-scenario] vehicle anti-roll: vehicle=${vehicleId} axle=front compression=${live.wheelStates.left.compression}/${live.wheelStates.right.compression} force=${leftForce}/${rightForce}`
		);
		console.log(`[live-scenario] invalid-pair rejection: ${invalidPairEvidence}`);
		console.log(`[live-scenario] invalid-range rejection: ${invalidRangeEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding selected chassis for ${holdMilliseconds}ms of Anti-roll Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalVehicles = JSON.parse(await call("list_vehicles")).vehicles;
		const baselineIds = baselineVehicles.map((entry) => entry.id).sort();
		const finalIds = finalVehicles.map((entry) => entry.id).sort();
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || JSON.stringify(finalIds) !== JSON.stringify(baselineIds)) {
			throw new Error(`live anti-roll cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineIds, finalIds })}`);
		}
		console.log(`[live-scenario] vehicle anti-roll cleanup: meshes=${finalDiagnostics.meshes} vehicles=${finalVehicles.length} paused=${baselineControl.paused}`);
	}

	// 19. Optional: Unity-style forward/sideways tire curves, real wheel-contact
	// slip/RPM evidence, strict nested rejection, visible Inspector, and cleanup.
	if (has("--vehicle-tire-friction")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineVehicles = JSON.parse(await call("list_vehicles")).vehicles;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		const fixtureIds = [];
		let vehicleId = null;
		let pausedByScenario = false;
		restore = async () => {
			if (vehicleId) {
				try {
					await call("delete_vehicle", { id: vehicleId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				vehicleId = null;
			}
			for (const nodeId of fixtureIds.reverse()) {
				try {
					await call("delete_node", { nodeId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
			fixtureIds.length = 0;
			if (pausedByScenario) {
				await call("set_physics_simulation_paused", { paused: false });
				pausedByScenario = false;
			}
		};

		const ground = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Tire Ground ${process.pid}`,
				position: [0, -10, 0],
				options: { width: 1200, height: 20, depth: 1200 },
			})
		);
		fixtureIds.push(ground.id);
		const chassis = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Tire Chassis ${process.pid}`,
				position: [0, 100, 0],
				options: { width: 100, height: 60, depth: 180 },
			})
		);
		fixtureIds.push(chassis.id);
		await call("set_mesh_physics", { nodeId: ground.id, enabled: true, motionType: "static", shapeType: "box", friction: 1 });
		await call("set_mesh_physics", { nodeId: chassis.id, enabled: true, motionType: "dynamic", shapeType: "box", mass: 100, friction: 0.5 });
		if (!baselineControl.paused) {
			await call("set_physics_simulation_paused", { paused: true });
			pausedByScenario = true;
		}

		const forwardFriction = { extremumSlip: 0.3, extremumValue: 1.4, asymptoteSlip: 0.9, asymptoteValue: 0.45, stiffness: 1.2 };
		const sidewaysFriction = { extremumSlip: 0.25, extremumValue: 1.6, asymptoteSlip: 0.75, asymptoteValue: 0.55, stiffness: 1.1 };
		const wheel = (id, x, z, steering, group) => ({
			id,
			name: id,
			connectionPoint: [x, -45, z],
			radius: 20,
			mass: 20,
			dampingRate: 0.1,
			suspensionRestLength: 80,
			maxTravel: 40,
			springStrength: 0,
			damping: 0,
			steering,
			driven: true,
			brake: true,
			antiRollGroup: group,
		});
		const created = JSON.parse(
			await call("create_vehicle", {
				id: `codex-tire-friction-${process.pid}`,
				name: "Codex Tire Friction Vehicle",
				chassisNodeId: chassis.id,
				maxEngineForce: 30000,
				maxBrakeForce: 20000,
				maxSpeed: 2500,
				forwardFriction,
				sidewaysFriction,
				antiRollStiffness: 0,
				wheels: [
					{ ...wheel("front-left", -35, 0, true, "front"), forwardFriction: { ...forwardFriction, stiffness: 1.3 } },
					wheel("front-right", 35, 0, true, "front"),
					wheel("rear-left", -35, 0, false, "rear"),
					wheel("rear-right", 35, 0, false, "rear"),
				],
			})
		);
		vehicleId = created.id;
		if (created.forwardFriction?.extremumSlip !== 0.3 || created.sidewaysFriction?.extremumValue !== 1.6 || created.wheels[0].forwardFriction?.stiffness !== 1.3) {
			throw new Error(`live tire creation returned incomplete curves: ${JSON.stringify(created)}`);
		}

		const invalidOrderEvidence = await expectCallFailure(
			"set_vehicle",
			{ id: vehicleId, forwardFriction: { ...forwardFriction, asymptoteSlip: 0.2 } },
			/(asymptoteSlip|greater than extremumSlip)/i
		);
		const invalidNestedEvidence = await expectCallFailure(
			"set_vehicle_wheels",
			{
				id: vehicleId,
				wheels: created.wheels.map((entry, index) => (index === 0 ? { ...entry, forwardFriction: { ...entry.forwardFriction, magicGrip: 9 } } : entry)),
			},
			/(unrecognized|invalid)/i
		);
		const invalidRangeEvidence = await expectCallFailure(
			"set_vehicle",
			{ id: vehicleId, sidewaysFriction: { ...sidewaysFriction, stiffness: 11 } },
			/(less than or equal|10)/i
		);
		await call("set_vehicle_input", { id: vehicleId, throttle: 1, steering: 0.65, brake: 0 });
		await call("step_physics_simulation", { steps: 4, deltaSeconds: 1 / 60 });
		const listed = JSON.parse(await call("list_vehicles"));
		const live = listed.vehicles.find((entry) => entry.id === vehicleId);
		const states = Object.values(live?.wheelStates ?? {});
		const maximumForwardSlip = Math.max(0, ...states.map((state) => Math.abs(state.forwardSlip ?? 0)));
		const maximumSidewaysSlip = Math.max(0, ...states.map((state) => Math.abs(state.sidewaysSlip ?? 0)));
		const maximumRpm = Math.max(0, ...states.map((state) => Math.abs(state.rpm ?? 0)));
		if (!states.length || !states.every((state) => state.grounded) || maximumForwardSlip <= 0 || maximumSidewaysSlip <= 0 || maximumRpm <= 0) {
			throw new Error(`live tire solver omitted grounded slip/RPM evidence: ${JSON.stringify(live)}`);
		}
		if (!states.every((state) => state.forwardGrip >= 0 && state.sidewaysGrip >= 0 && Number.isFinite(state.forwardForce) && Number.isFinite(state.sidewaysForce))) {
			throw new Error(`live tire solver returned non-finite grip/force evidence: ${JSON.stringify(states)}`);
		}
		const updatedCurve = { ...sidewaysFriction, stiffness: 0.7 };
		const updated = JSON.parse(await call("set_vehicle", { id: vehicleId, sidewaysFriction: updatedCurve }));
		if (updated.sidewaysFriction?.stiffness !== 0.7) throw new Error(`live tire curve update was incomplete: ${JSON.stringify(updated)}`);

		await call("select_node", { nodeId: chassis.id });
		console.log(
			`[live-scenario] vehicle tire friction: vehicle=${vehicleId} grounded=${states.length} forwardSlip=${maximumForwardSlip.toFixed(4)} sidewaysSlip=${maximumSidewaysSlip.toFixed(4)} rpm=${maximumRpm.toFixed(2)}`
		);
		console.log(`[live-scenario] invalid-curve-order rejection: ${invalidOrderEvidence}`);
		console.log(`[live-scenario] invalid-nested-field rejection: ${invalidNestedEvidence}`);
		console.log(`[live-scenario] invalid-range rejection: ${invalidRangeEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding selected chassis for ${holdMilliseconds}ms of Tire Friction Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalVehicles = JSON.parse(await call("list_vehicles")).vehicles;
		const baselineIds = baselineVehicles.map((entry) => entry.id).sort();
		const finalIds = finalVehicles.map((entry) => entry.id).sort();
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || JSON.stringify(finalIds) !== JSON.stringify(baselineIds)) {
			throw new Error(`live tire cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineIds, finalIds })}`);
		}
		console.log(`[live-scenario] vehicle tire cleanup: meshes=${finalDiagnostics.meshes} vehicles=${finalVehicles.length} paused=${baselineControl.paused}`);
	}

	// Optional: complete engine torque curve, manual gearbox, clutch, final
	// drive, and limited-slip differential through external MCP stdio. The
	// disposable vehicle proves atomic nested rejection, fixed-step torque
	// evidence, visible Inspector state, and residue-free cleanup.
	if (has("--vehicle-drivetrain")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineVehicles = JSON.parse(await call("list_vehicles")).vehicles;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		const fixtureIds = [];
		let vehicleId = null;
		let pausedByScenario = false;
		restore = async () => {
			if (vehicleId) {
				try {
					await call("delete_vehicle", { id: vehicleId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				vehicleId = null;
			}
			for (const nodeId of fixtureIds.reverse()) {
				try {
					await call("delete_node", { nodeId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
			fixtureIds.length = 0;
			if (pausedByScenario) {
				await call("set_physics_simulation_paused", { paused: false });
				pausedByScenario = false;
			}
		};

		const ground = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Drivetrain Ground ${process.pid}`,
				position: [0, -10, 0],
				options: { width: 1200, height: 20, depth: 1200 },
			})
		);
		fixtureIds.push(ground.id);
		const chassis = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Drivetrain Chassis ${process.pid}`,
				position: [0, 100, 0],
				options: { width: 100, height: 60, depth: 180 },
			})
		);
		fixtureIds.push(chassis.id);
		await call("set_mesh_physics", { nodeId: ground.id, enabled: true, motionType: "static", shapeType: "box", friction: 1 });
		await call("set_mesh_physics", { nodeId: chassis.id, enabled: true, motionType: "dynamic", shapeType: "box", mass: 100, friction: 0.5 });
		if (!baselineControl.paused) {
			await call("set_physics_simulation_paused", { paused: true });
			pausedByScenario = true;
		}

		const drivetrain = {
			engineTorqueCurve: [
				{ rpm: 800, torque: 280 },
				{ rpm: 3500, torque: 420 },
				{ rpm: 6500, torque: 300 },
			],
			idleRpm: 800,
			redlineRpm: 6500,
			engineInertia: 0.3,
			engineBrakingTorque: 60,
			forwardGearRatios: [3.5, 2.2, 1.5],
			reverseGearRatio: 3.2,
			finalDriveRatio: 3.42,
			transmissionEfficiency: 0.9,
			automatic: false,
			downshiftRpm: 1800,
			upshiftRpm: 6000,
			shiftDuration: 0,
			clutchEngagementRate: 100,
			differentialType: "limited-slip",
			limitedSlipBias: 3,
			differentialLockStrength: 2,
		};
		const tireCurve = { extremumSlip: 0.3, extremumValue: 1.4, asymptoteSlip: 0.9, asymptoteValue: 0.45, stiffness: 1.2 };
		const wheel = (id, x, steering, group, stiffness) => ({
			id,
			name: id,
			connectionPoint: [x, -45, 0],
			radius: 20,
			mass: 20,
			dampingRate: 0.1,
			suspensionRestLength: 80,
			maxTravel: 40,
			springStrength: 0,
			damping: 0,
			steering,
			driven: true,
			brake: true,
			antiRollGroup: group,
			forwardFriction: { ...tireCurve, stiffness },
		});
		const created = JSON.parse(
			await call("create_vehicle", {
				id: `codex-drivetrain-${process.pid}`,
				name: "Codex Drivetrain Vehicle",
				chassisNodeId: chassis.id,
				maxBrakeForce: 20000,
				maxSpeed: 2500,
				forwardFriction: tireCurve,
				sidewaysFriction: tireCurve,
				antiRollStiffness: 0,
				drivetrain,
				wheels: [
					wheel("front-left", -35, true, "front", 0.55),
					wheel("front-right", 35, true, "front", 1.6),
					wheel("rear-left", -35, false, "rear", 0.8),
					wheel("rear-right", 35, false, "rear", 1.3),
				],
			})
		);
		vehicleId = created.id;
		if (created.drivetrain?.forwardGearRatios?.length !== 3 || created.drivetrain?.differentialType !== "limited-slip" || created.shiftUpActionName !== "Shift Up") {
			throw new Error(`live drivetrain creation returned incomplete authoring: ${JSON.stringify(created)}`);
		}

		const invalidCurve = structuredClone(drivetrain);
		invalidCurve.engineTorqueCurve[1].rpm = 700;
		const invalidCurveEvidence = await expectCallFailure("set_vehicle", { id: vehicleId, drivetrain: invalidCurve }, /(strictly increasing|invalid)/i);
		const invalidThreshold = { ...structuredClone(drivetrain), downshiftRpm: 3000, upshiftRpm: 3050 };
		const invalidThresholdEvidence = await expectCallFailure("set_vehicle", { id: vehicleId, drivetrain: invalidThreshold }, /(at least 100|invalid)/i);
		const unknownDrivetrain = { ...structuredClone(drivetrain), magicGearbox: true };
		const unknownEvidence = await expectCallFailure("set_vehicle", { id: vehicleId, drivetrain: unknownDrivetrain }, /(unrecognized|invalid)/i);
		const contradictoryEvidence = await expectCallFailure("set_vehicle_input", { id: vehicleId, throttle: 0.4, gear: 2, shiftUp: true }, /exactly one gear command/i);
		const invalidGearEvidence = await expectCallFailure("set_vehicle_input", { id: vehicleId, gear: 4 }, /integer from -1 through 3/i);
		const afterRejected = JSON.parse(await call("list_vehicles")).vehicles.find((entry) => entry.id === vehicleId);
		if (JSON.stringify(afterRejected?.drivetrain) !== JSON.stringify(drivetrain) || afterRejected?.input !== null) {
			throw new Error(`invalid drivetrain requests changed persisted or transient state: ${JSON.stringify(afterRejected)}`);
		}

		await call("set_vehicle_input", { id: vehicleId, throttle: 0.4, steering: 0, brake: 0, gear: 2 });
		await call("step_physics_simulation", { steps: 4, deltaSeconds: 1 / 60 });
		const listed = JSON.parse(await call("list_vehicles"));
		const live = listed.vehicles.find((entry) => entry.id === vehicleId);
		const state = live?.drivetrainState;
		const drivenStates = Object.values(live?.wheelStates ?? {}).filter((entry) => entry.torqueShare > 0);
		const torqueShares = drivenStates.map((entry) => entry.torqueShare);
		const shareSum = torqueShares.reduce((sum, value) => sum + value, 0);
		const minimumShare = Math.min(...torqueShares);
		const maximumShare = Math.max(...torqueShares);
		if (
			state?.currentGear !== 2 ||
			state.pendingGear !== null ||
			state.gearRatio !== drivetrain.forwardGearRatios[1] ||
			state.engineRpm < drivetrain.idleRpm ||
			state.engineRpm > drivetrain.redlineRpm ||
			state.clutch < 0 ||
			state.clutch > 1 ||
			!Number.isFinite(state.outputTorque) ||
			state.outputTorque <= 0 ||
			drivenStates.length !== 4 ||
			!drivenStates.every(
				(entry) =>
					entry.grounded &&
					Number.isFinite(entry.driveTorque) &&
					Number.isFinite(entry.differentialTorque) &&
					Number.isFinite(entry.brakeTorque) &&
					Number.isFinite(entry.totalTorque) &&
					Number.isFinite(entry.torqueShare)
			) ||
			Math.abs(shareSum - 1) > 0.000001 ||
			minimumShare <= 0 ||
			maximumShare / minimumShare > drivetrain.limitedSlipBias + 0.000001
		) {
			throw new Error(`live drivetrain solver omitted bounded gear/torque evidence: ${JSON.stringify(live)}`);
		}

		await call("select_node", { nodeId: chassis.id });
		console.log(
			`[live-scenario] vehicle drivetrain: vehicle=${vehicleId} gear=${state.currentGear} rpm=${state.engineRpm.toFixed(2)} clutch=${state.clutch.toFixed(3)} outputTorque=${state.outputTorque.toFixed(2)}Nm shareRange=${minimumShare.toFixed(4)}-${maximumShare.toFixed(4)}`
		);
		console.log(`[live-scenario] invalid-curve rejection: ${invalidCurveEvidence}`);
		console.log(`[live-scenario] invalid-threshold rejection: ${invalidThresholdEvidence}`);
		console.log(`[live-scenario] nested-unknown rejection: ${unknownEvidence}`);
		console.log(`[live-scenario] contradictory-command rejection: ${contradictoryEvidence}`);
		console.log(`[live-scenario] invalid-gear rejection: ${invalidGearEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding selected chassis for ${holdMilliseconds}ms of Drivetrain Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalVehicles = JSON.parse(await call("list_vehicles")).vehicles;
		const baselineIds = baselineVehicles.map((entry) => entry.id).sort();
		const finalIds = finalVehicles.map((entry) => entry.id).sort();
		const finalControl = JSON.parse(await call("get_physics_simulation_control"));
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || JSON.stringify(finalIds) !== JSON.stringify(baselineIds) || finalControl.paused !== baselineControl.paused) {
			throw new Error(`live drivetrain cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineIds, finalIds, baselineControl, finalControl })}`);
		}
		console.log(`[live-scenario] vehicle drivetrain cleanup: meshes=${finalDiagnostics.meshes} vehicles=${finalVehicles.length} paused=${finalControl.paused}`);
	}

	// Complete external Physics 2D lifecycle. This exercises world settings/debug rendering, every body resource,
	// all nine joints, all five effectors, transient commands, shared stepping,
	// stale-lease rejection, and exact fixture cleanup through bundled stdio.
	if (has("--physics2d-completion")) {
		const initialStatus = JSON.parse(await call("get_editor_status"));
		const baselinePlaying = initialStatus.play.playing;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		if (baselinePlaying) await call("set_preview_play_mode", { action: "stop" });
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineBodies = JSON.parse(await call("list_physics2d_bodies")).bodies;
		const baselineJoints = JSON.parse(await call("list_physics2d_joints")).joints;
		const baselineEffectors = JSON.parse(await call("list_physics2d_effectors")).effectors;
		const baselineMaterials = JSON.parse(await call("list_physics2d_materials")).materials;
		const baselineSettings = JSON.parse(await call("get_physics2d_settings"));
		const settingsRoundTrip = JSON.parse(
			await call("set_physics2d_settings", {
				expectedRevision: baselineSettings.revision,
				velocityIterations: baselineSettings.velocityIterations,
				positionIterations: baselineSettings.positionIterations,
			})
		);
		if (settingsRoundTrip.revision !== baselineSettings.revision + 1) {
			throw new Error(`Physics 2D settings round-trip evidence is incomplete: ${JSON.stringify(settingsRoundTrip)}`);
		}
		await call("undo_editor");
		const restoredBaselineSettings = JSON.parse(await call("get_physics2d_settings"));
		if (JSON.stringify(restoredBaselineSettings) !== JSON.stringify(baselineSettings)) {
			throw new Error(`Physics 2D settings round-trip did not restore exactly: ${JSON.stringify({ baselineSettings, restoredBaselineSettings })}`);
		}
		const prefix = `codex-physics2d-completion-${process.pid}`;
		const nodeIds = [];
		const jointIds = new Set();
		const effectorIds = new Set();
		const materialId = `${prefix}-material`;
		const worldId = `${prefix}-world`;

		restore = async () => {
			const currentStatus = JSON.parse(await call("get_editor_status"));
			if (currentStatus.play.playing) await call("set_preview_play_mode", { action: "stop" });
			for (const effector of JSON.parse(await call("list_physics2d_effectors")).effectors.filter((entry) => effectorIds.has(entry.id))) {
				await call("delete_physics2d_effector", { id: effector.id, expectedRevision: effector.revision });
			}
			for (const joint of JSON.parse(await call("list_physics2d_joints")).joints.filter((entry) => jointIds.has(entry.id))) {
				await call("delete_physics2d_joint", { id: joint.id, expectedRevision: joint.revision });
			}
			for (const body of JSON.parse(await call("list_physics2d_bodies")).bodies.filter((entry) => nodeIds.includes(entry.nodeId))) {
				await call("remove_physics2d_body", { nodeId: body.nodeId, expectedRevision: body.revision });
			}
			const material = JSON.parse(await call("list_physics2d_materials")).materials.find((entry) => entry.id === materialId);
			if (material) await call("delete_physics2d_material", { id: material.id, expectedRevision: material.revision });
			for (const nodeId of [...nodeIds].reverse()) {
				try {
					await call("delete_node", { nodeId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
			nodeIds.length = 0;
			const editControl = JSON.parse(await call("get_physics_simulation_control"));
			if (editControl.paused) await call("set_physics_simulation_paused", { paused: false });
			if (baselinePlaying) {
				await call("set_preview_play_mode", { action: "play" });
				if (baselineControl.paused) await call("set_physics_simulation_paused", { paused: true });
			} else if (baselineControl.paused) {
				await call("set_physics_simulation_paused", { paused: true });
			}
		};

		const createdWorld = JSON.parse(
			await call("create_physics2d_world", {
				id: worldId,
				name: "Codex Physics 2D World",
				expectedRevision: baselineSettings.revision,
				worldDrawing: true,
				alwaysDraw: true,
				transformWriteMode: "tween",
			})
		);
		const updatedWorld = JSON.parse(
			await call("set_physics2d_world", {
				id: worldId,
				expectedRevision: baselineSettings.revision + 1,
				transformPlane: { mode: "custom", origin: [10, 20, 30], xAxis: [0, 1, 0], yAxis: [0, 0, 1] },
				contactFilterMode: "none",
				tweenDurationSeconds: 0.25,
			})
		);
		const debugWorld = JSON.parse(
			await call("get_physics2d_debug_rendering", {
				limit: 1,
				customElements: [
					{
						id: `${prefix}-axis`,
						worldId,
						points: [
							[0, 0],
							[10, 0],
						],
					},
				],
			})
		);
		if (
			createdWorld.id !== worldId ||
			updatedWorld.transformPlane.mode !== "custom" ||
			updatedWorld.contactFilterMode !== "none" ||
			debugWorld.total !== 1 ||
			debugWorld.primitives[0]?.order !== "custom"
		) {
			throw new Error(`Physics 2D world/debug lifecycle returned incomplete evidence: ${JSON.stringify({ createdWorld, updatedWorld, debugWorld })}`);
		}
		await expectCallFailure("set_physics2d_world", { id: worldId, expectedRevision: baselineSettings.revision + 1, enabled: false }, /stale/i);
		await call("delete_physics2d_world", { id: worldId, expectedRevision: baselineSettings.revision + 2 });
		await call("undo_editor");
		await call("undo_editor");
		await call("undo_editor");
		const restoredWorldSettings = JSON.parse(await call("get_physics2d_settings"));
		if (JSON.stringify(restoredWorldSettings) !== JSON.stringify(baselineSettings)) {
			throw new Error(`Physics 2D settings Undo cleanup mismatch: ${JSON.stringify({ baselineSettings, restoredWorldSettings })}`);
		}

		const material = JSON.parse(await call("create_physics2d_material", { id: materialId, name: `Codex Physics 2D ${process.pid}`, friction: 0.4, restitution: 0.1 }));
		const updatedMaterial = JSON.parse(await call("set_physics2d_material", { id: material.id, expectedRevision: material.revision, friction: 0.25, restitution: 0.2 }));
		const dynamicNode = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Physics 2D Dynamic ${process.pid}`,
				position: [0, 500, 0],
				options: { width: 20, height: 20, depth: 10 },
			})
		);
		const staticNode = JSON.parse(
			await call("create_primitive_mesh", {
				type: "box",
				name: `Codex Physics 2D Static ${process.pid}`,
				position: [0, 440, 0],
				options: { width: 220, height: 10, depth: 10 },
			})
		);
		nodeIds.push(dynamicNode.id, staticNode.id);
		const dynamicBody = JSON.parse(
			await call("set_physics2d_body", {
				nodeId: dynamicNode.id,
				expectedRevision: 0,
				bodyType: "dynamic",
				collider: { shape: "box", size: [20, 20], offset: [0, 0], density: 0.001 },
				gravity: [0, -981],
				materialId,
				usedByEffector: true,
				collisionDetection: "continuous",
				layerOverrides: { priority: 2, callbackLayers: 3, contactCaptureLayers: 3 },
			})
		);
		const staticBody = JSON.parse(
			await call("set_physics2d_body", {
				nodeId: staticNode.id,
				expectedRevision: 0,
				bodyType: "static",
				collider: {
					shape: "edge",
					points: [
						[-110, 0],
						[0, 5],
						[110, 0],
					],
					edgeRadius: 2,
				},
			})
		);
		if (dynamicBody.bodyType !== "dynamic" || dynamicBody.collisionDetection !== "continuous" || staticBody.collider.parts.length !== 2 || updatedMaterial.revision !== 2) {
			throw new Error(`complete Physics 2D body/material creation returned incomplete evidence: ${JSON.stringify({ dynamicBody, staticBody, updatedMaterial })}`);
		}

		const jointDefinitions = [
			{ type: "distance", distance: 60, maxDistanceOnly: true },
			{ type: "fixed", frequency: 3, dampingRatio: 0.5 },
			{ type: "friction", maxForce: 500, maxTorque: 200 },
			{ type: "hinge", useLimits: true, minAngle: -0.5, maxAngle: 0.5, useMotor: true, motorSpeed: 1, maxMotorTorque: 100 },
			{ type: "relative", linearOffset: [0, 60], angularOffset: 0.1, correctionScale: 0.4 },
			{ type: "slider", angle: 0, useLimits: true, lowerTranslation: -20, upperTranslation: 20, useMotor: true, motorSpeed: 2, maxMotorForce: 100 },
			{ type: "spring", distance: 60, frequency: 4, dampingRatio: 0.6 },
			{ type: "target", target: [0, 500], maxForce: 1000 },
			{ type: "wheel", angle: Math.PI / 2, frequency: 5, dampingRatio: 0.7, useMotor: true, motorSpeed: 2, maxMotorTorque: 100 },
		];
		const jointPatches = {
			distance: { distance: 62 },
			fixed: { frequency: 4 },
			friction: { maxForce: 550 },
			hinge: { motorSpeed: 1.5 },
			relative: { correctionScale: 0.5 },
			slider: { lowerTranslation: -25, upperTranslation: 25 },
			spring: { dampingRatio: 0.65 },
			target: { target: [5, 505] },
			wheel: { frequency: 6 },
		};
		for (const definition of jointDefinitions) {
			const id = `${prefix}-joint-${definition.type}`;
			jointIds.add(id);
			const createdJoint = JSON.parse(
				await call("create_physics2d_joint", {
					id,
					...definition,
					firstNodeId: dynamicNode.id,
					...(definition.type === "target" ? {} : { secondNodeId: staticNode.id }),
					enableCollision: false,
					breakAction: "callback-only",
				})
			);
			await call("set_physics2d_joint", { id, type: definition.type, expectedRevision: createdJoint.revision, ...jointPatches[definition.type] });
		}

		const effectorDefinitions = [
			{ type: "point", nodeId: dynamicNode.id, forceMagnitude: 100, forceMode: "inverse-linear", distanceScale: 50 },
			{ type: "area", nodeId: dynamicNode.id, forceMagnitude: 50, useGlobalAngle: false, forceAngle: 90 },
			{ type: "surface", nodeId: dynamicNode.id, speed: 20, forceScale: 0.5, useFriction: true },
			{ type: "platform", nodeId: staticNode.id, rotationalOffset: 0, useOneWay: true, surfaceArc: 180 },
			{ type: "buoyancy", nodeId: staticNode.id, surfaceLevel: 10, density: 1, flowAngle: 0, flowMagnitude: 5 },
		];
		const effectorPatches = { point: { forceMagnitude: 120 }, area: { forceAngle: 45 }, surface: { speed: 25 }, platform: { sideArc: 2 }, buoyancy: { flowMagnitude: 8 } };
		for (const definition of effectorDefinitions) {
			const id = `${prefix}-effector-${definition.type}`;
			effectorIds.add(id);
			const createdEffector = JSON.parse(await call("create_physics2d_effector", { id, ...definition, useColliderMask: true, colliderMask: 0xffffffff }));
			await call("set_physics2d_effector", { id, type: definition.type, expectedRevision: createdEffector.revision, ...effectorPatches[definition.type] });
		}

		await call("set_physics2d_runtime_velocity", { nodeId: dynamicNode.id, expectedRevision: 1, velocity: [0, 0], angularVelocity: 0 });
		const impulse = JSON.parse(await call("apply_physics2d_force", { nodeId: dynamicNode.id, expectedRevision: 1, value: [2, 0], mode: "impulse", worldPoint: [0, 510] }));
		const angularImpulse = JSON.parse(await call("apply_physics2d_torque", { nodeId: dynamicNode.id, expectedRevision: 1, value: 1, mode: "impulse" }));
		let control = JSON.parse(await call("get_physics_simulation_control"));
		if (!control.paused) await call("set_physics_simulation_paused", { paused: true });
		const stepped = JSON.parse(await call("step_physics_simulation", { steps: 2, deltaSeconds: 0.016 }));
		if (stepped.physics2DStep?.steppedBodies < 2 || impulse.runtime.velocity[0] <= 0 || angularImpulse.runtime.angularVelocity === 0) {
			throw new Error(`complete Physics 2D runtime commands omitted live evidence: ${JSON.stringify({ impulse, angularImpulse, stepped })}`);
		}

		const updatedBody = JSON.parse(await call("set_physics2d_body", { nodeId: dynamicNode.id, expectedRevision: 1, mass: 2, useAutoMass: false }));
		const staleBodyEvidence = await expectCallFailure("apply_physics2d_force", { nodeId: dynamicNode.id, expectedRevision: 1, value: [1, 0] }, /stale/i);
		const staleJointEvidence = await expectCallFailure("set_physics2d_joint", { id: `${prefix}-joint-hinge`, type: "hinge", expectedRevision: 1, motorSpeed: 3 }, /stale/i);
		const crossFamilyEvidence = await expectCallFailure(
			"set_physics2d_effector",
			{ id: `${prefix}-effector-point`, type: "point", expectedRevision: 2, surfaceArc: 90 },
			/(invalid|not valid|unrecognized)/i
		);
		const listed = JSON.parse(await call("list_physics2d_bodies"));
		const listedJoints = JSON.parse(await call("list_physics2d_joints")).joints.filter((joint) => jointIds.has(joint.id));
		const listedEffectors = JSON.parse(await call("list_physics2d_effectors")).effectors.filter((effector) => effectorIds.has(effector.id));
		if (listedJoints.length !== 9 || listedEffectors.length !== 5 || updatedBody.revision !== 2 || listed.settings.version !== 3) {
			throw new Error(`complete Physics 2D discovery mismatch: ${JSON.stringify({ listedJoints, listedEffectors, updatedBody, settings: listed.settings })}`);
		}
		await call("select_node", { nodeId: dynamicNode.id });
		console.log(
			`[live-scenario] Physics 2D completion: bodies=2 joints=${listedJoints.length} effectors=${listedEffectors.length} materialRevision=${updatedMaterial.revision} stepped=${stepped.stepped}`
		);
		console.log(`[live-scenario] stale body rejection: ${staleBodyEvidence}`);
		console.log(`[live-scenario] stale joint rejection: ${staleJointEvidence}`);
		console.log(`[live-scenario] cross-family rejection: ${crossFamilyEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding selected Physics 2D body for ${holdMilliseconds}ms of Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalBodies = JSON.parse(await call("list_physics2d_bodies")).bodies;
		const finalJoints = JSON.parse(await call("list_physics2d_joints")).joints;
		const finalEffectors = JSON.parse(await call("list_physics2d_effectors")).effectors;
		const finalMaterials = JSON.parse(await call("list_physics2d_materials")).materials;
		const finalSettings = JSON.parse(await call("get_physics2d_settings"));
		const sameIds = (first, second) =>
			JSON.stringify(first.map((entry) => entry.id ?? entry.nodeId).sort()) === JSON.stringify(second.map((entry) => entry.id ?? entry.nodeId).sort());
		control = JSON.parse(await call("get_physics_simulation_control"));
		if (
			finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
			!sameIds(finalBodies, baselineBodies) ||
			!sameIds(finalJoints, baselineJoints) ||
			!sameIds(finalEffectors, baselineEffectors) ||
			!sameIds(finalMaterials, baselineMaterials) ||
			JSON.stringify(finalSettings) !== JSON.stringify(baselineSettings) ||
			control.paused !== baselineControl.paused
		) {
			throw new Error(
				`complete Physics 2D cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineSettings, finalSettings, baselineControl, control })}`
			);
		}
		console.log(
			`[live-scenario] Physics 2D cleanup: meshes=${finalDiagnostics.meshes} bodies=${finalBodies.length} joints=${finalJoints.length} effectors=${finalEffectors.length} materials=${finalMaterials.length}`
		);
	}

	// 20. Optional: versioned PolygonCollider2D-style holes/islands lifecycle.
	// Disposable nodes prove exact MCP authoring, shared editor collision parts,
	// empty-hole behavior, disconnected-island hits, strict rejection, and cleanup.
	if (has("--physics2d-compound-polygon")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineBodies = JSON.parse(await call("list_physics2d_bodies")).bodies.length;
		const baselineControl = JSON.parse(await call("get_physics_simulation_control"));
		const sourceImagePath = join(HERE, "..", "..", "templates", "electron", "assets", "albedo.png");
		const importedImagePath = `assets/__codex_physics2d_alpha_${process.pid}.png`;
		if (!existsSync(sourceImagePath)) throw new Error(`Physics 2D alpha fixture is missing: ${sourceImagePath}`);
		const fixtureIds = [];
		let pausedByScenario = false;
		restore = async () => {
			for (const nodeId of fixtureIds) {
				try {
					const body = JSON.parse(await call("list_physics2d_bodies")).bodies.find((candidate) => candidate.nodeId === nodeId);
					if (body) await call("remove_physics2d_body", { nodeId, expectedRevision: body.revision });
				} catch (error) {
					if (!/(No 2D physics body|not found)/i.test(error.message)) throw error;
				}
				try {
					await call("delete_node", { nodeId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
			fixtureIds.length = 0;
			try {
				await call("delete_asset", { path: importedImagePath, confirm: true });
			} catch (error) {
				if (!/not found/i.test(error.message)) throw error;
			}
			if (pausedByScenario && !baselineControl.paused) {
				await call("set_physics_simulation_paused", { paused: false });
				pausedByScenario = false;
			}
		};
		await call("import_asset", { sourcePath: sourceImagePath, destinationPath: importedImagePath });

		const createFixture = async (name, position) => {
			const node = JSON.parse(await call("create_primitive_mesh", { type: "box", name: `${name} ${process.pid}`, position }));
			fixtureIds.push(node.id);
			return node;
		};
		const polygon = await createFixture("Codex Compound Collider", [0, 250, 0]);
		const solid = await createFixture("Codex Compound Solid Probe", [-30, 250, 0]);
		const hole = await createFixture("Codex Compound Hole Probe", [0, 250, 0]);
		const island = await createFixture("Codex Compound Island Probe", [90, 250, 0]);
		const generatedNode = await createFixture("Codex Generated Alpha Collider", [180, 250, 0]);
		const generated = JSON.parse(
			await call("generate_physics2d_polygon_collider", {
				nodeId: generatedNode.id,
				expectedRevision: 0,
				imagePath: importedImagePath,
				size: [64, 64],
				alphaThreshold: 1,
				outline: "convex",
				maxVertices: 32,
			})
		);
		if (generated.revision !== 1 || generated.sourceImagePath !== importedImagePath || generated.sampledVertexCount < 3 || generated.partCount < 1) {
			throw new Error(`Physics 2D generated polygon evidence is incomplete: ${JSON.stringify(generated)}`);
		}
		await call("remove_physics2d_body", { nodeId: generatedNode.id, expectedRevision: generated.revision });
		await call("delete_node", { nodeId: generatedNode.id });
		fixtureIds.splice(fixtureIds.indexOf(generatedNode.id), 1);
		const contours = [
			{
				id: "main-island",
				points: [
					[-50, -50],
					[50, -50],
					[50, 50],
					[-50, 50],
				],
				holes: [
					{
						id: "main-opening",
						points: [
							[-10, -10],
							[-10, 10],
							[10, 10],
							[10, -10],
						],
					},
				],
			},
			{
				id: "detached-island",
				points: [
					[80, -10],
					[100, -10],
					[100, 10],
					[80, 10],
				],
				holes: [],
			},
		];
		const created = JSON.parse(await call("set_physics2d_polygon_collider", { nodeId: polygon.id, expectedRevision: 0, contours }));
		if (
			created.model !== "unity-polygon-collider-holes-islands-v1" ||
			created.version !== 2 ||
			created.revision !== 1 ||
			created.outerCount !== 2 ||
			created.holeCount !== 1 ||
			created.vertexCount !== 12 ||
			created.filledArea !== created.decomposedArea
		) {
			throw new Error(`live compound polygon creation returned incomplete evidence: ${JSON.stringify(created)}`);
		}
		await call("set_physics2d_body", { nodeId: polygon.id, expectedRevision: 1, bodyType: "static", isTrigger: true });
		for (const probe of [solid, hole, island]) {
			await call("set_physics2d_body", { nodeId: probe.id, expectedRevision: 0, bodyType: "static", collider: { shape: "circle", radius: 5 } });
		}
		if (!baselineControl.paused) {
			await call("set_physics_simulation_paused", { paused: true });
			pausedByScenario = true;
		}
		await call("step_physics_simulation", { steps: 2, deltaSeconds: 0.016 });
		const live = JSON.parse(await call("list_physics2d_bodies"));
		const hitIds = live.triggers
			.filter((event) => event.firstNodeId === polygon.id || event.secondNodeId === polygon.id)
			.map((event) => (event.firstNodeId === polygon.id ? event.secondNodeId : event.firstNodeId));
		if (!hitIds.includes(solid.id) || !hitIds.includes(island.id) || hitIds.includes(hole.id)) {
			throw new Error(`live compound polygon collision evidence filled a hole or missed an island: ${JSON.stringify(live.triggers)}`);
		}
		const staleEvidence = await expectCallFailure("set_physics2d_polygon_collider", { nodeId: polygon.id, expectedRevision: 999999, contours }, /stale/i);
		const invalidEvidence = await expectCallFailure(
			"set_physics2d_polygon_collider",
			{
				nodeId: polygon.id,
				expectedRevision: 1,
				contours: [
					{
						id: "touching",
						points: [
							[0, 0],
							[50, 0],
							[50, 50],
							[0, 50],
						],
						holes: [
							{
								id: "bad-hole",
								points: [
									[0, 10],
									[10, 10],
									[10, 20],
									[0, 20],
								],
							},
						],
					},
				],
			},
			/strictly inside/i
		);
		const unknownEvidence = await expectCallFailure(
			"set_physics2d_polygon_collider",
			{ nodeId: polygon.id, expectedRevision: 1, contours, fillHoles: true },
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("get_physics2d_polygon_collider", { nodeId: polygon.id }));
		if (unchanged.revision !== 1 || unchanged.outerCount !== 2 || unchanged.holeCount !== 1) {
			throw new Error(`invalid compound polygon requests changed state: ${JSON.stringify(unchanged)}`);
		}
		const updated = JSON.parse(await call("set_physics2d_polygon_collider", { nodeId: polygon.id, expectedRevision: 1, contours }));
		if (updated.revision !== 2 || updated.parts.length < 3) {
			throw new Error(`live compound polygon update returned incomplete evidence: ${JSON.stringify(updated)}`);
		}
		await call("select_node", { nodeId: polygon.id });
		console.log(
			`[live-scenario] compound polygon: node=${polygon.id} revision=${updated.revision} outer=${updated.outerCount} holes=${updated.holeCount} vertices=${updated.vertexCount} parts=${updated.parts.length} area=${updated.filledArea}`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] invalid-hole rejection: ${invalidEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding selected polygon for ${holdMilliseconds}ms of 2D Physics Inspector verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalBodies = JSON.parse(await call("list_physics2d_bodies")).bodies.length;
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalBodies !== baselineBodies) {
			throw new Error(`live compound polygon cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineBodies, finalBodies })}`);
		}
		console.log(`[live-scenario] compound polygon cleanup: meshes=${finalDiagnostics.meshes} bodies=${finalBodies}`);
	}

	// 20. Optional: exact Unity-style scene-view Tile Paint lifecycle.
	// A disposable real atlas/SpriteMap proves shared grid painting, erase,
	// revisions, strict rejection, visible Inspector state, and exact cleanup.
	if (has("--tile-paint-viewport")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselinePalettes = JSON.parse(await call("list_tile_palettes")).palettes.length;
		const baselineViewport = JSON.parse(await call("get_tile_paint_viewport"));
		if (baselineViewport.enabled) {
			throw new Error("Tile Paint live scenario requires the transient viewport tool to be disabled so it does not replace the user's active stroke context.");
		}
		const fixtureName = `Codex Tile Paint 679 ${process.pid}`;
		const assetFolder = `assets/${fixtureName}`;
		const scriptPath = `agentdata/codex-tile-paint-679-${process.pid}.js`;
		let fixtureId = null;
		let paletteId = null;
		restore = async () => {
			try {
				const current = JSON.parse(await call("get_tile_paint_viewport"));
				await call("set_tile_paint_viewport", {
					expectedRevision: current.revision,
					enabled: false,
					mapNodeId: null,
					paletteId: null,
					mode: baselineViewport.mode,
					layer: baselineViewport.layer,
					brushSize: baselineViewport.brushSize,
				});
			} catch (error) {
				if (!/fetch failed|not found/i.test(error.message)) throw error;
			}
			if (paletteId) {
				try {
					const currentPalette = JSON.parse(await call("get_tile_palette", { paletteId }));
					await call("delete_tile_palette", { paletteId, expectedRevision: currentPalette.revision });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				paletteId = null;
			}
			if (fixtureId) {
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				fixtureId = null;
			}
			for (const path of [assetFolder, scriptPath]) {
				try {
					await call("delete_asset", { path, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
		};

		const setupSource = `
import { dirname, join } from "path";
import { ensureDir, writeFile, writeJSON } from "fs-extra";
import { Vector2, Vector3 } from "babylonjs";
import { SpriteMapNode } from "babylonjs-editor";

export async function main(editor) {
	const scene = editor.layout.preview.scene;
	const directory = join(dirname(editor.path), ${JSON.stringify(assetFolder)});
	await ensureDir(directory);
	await writeFile(join(directory, "atlas.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYx8WQAAAABJRU5ErkJggg==", "base64"));
	await writeJSON(join(directory, "atlas.json"), {
		frames: {
			"tile.png": {
				frame: { x: 0, y: 0, w: 1, h: 1 },
				rotated: false,
				trimmed: false,
				spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 },
				sourceSize: { w: 1, h: 1 }
			}
		},
		meta: { app: "Zvibe Editor", version: "1", image: "atlas.png", format: "RGBA8888", size: { w: 1, h: 1 }, scale: "1" }
	}, { spaces: "\t" });
	const node = new SpriteMapNode(${JSON.stringify(fixtureName)}, scene);
	await node.buildFromAbsolutePath(join(directory, "atlas.json"), undefined, undefined, {
		layerCount: 2,
		stageSize: new Vector2(8, 6),
		outputSize: new Vector2(800, 600),
		colorMultiply: new Vector3(1, 1, 1)
	});
	node.position.set(0, 250, 0);
	await editor.layout.graph.refresh();
	editor.layout.graph.setSelectedNode(node);
	editor.layout.inspector.setEditedObject(node);
	editor.layout.preview.focusObject(node.outputPlane);
	return JSON.stringify({ id: node.id });
}`;
		const setup = JSON.parse(await call("run_agent_script", { name: scriptPath.replace(/^agentdata\//, ""), content: setupSource }));
		const setupResult = JSON.parse(setup.result);
		fixtureId = setupResult.id;
		const palette = JSON.parse(await call("create_tile_palette", { mapNodeId: fixtureId, name: `${fixtureName} Palette`, tileIndexes: [0] }));
		paletteId = palette.id;
		const initial = JSON.parse(await call("get_tile_paint_viewport"));
		const configured = JSON.parse(
			await call("set_tile_paint_viewport", {
				expectedRevision: initial.revision,
				enabled: true,
				mapNodeId: fixtureId,
				paletteId,
				mode: "paint",
				layer: 1,
				brushSize: [2, 2],
			})
		);
		if (!configured.enabled || configured.grid?.width !== 8 || configured.grid?.height !== 6 || configured.grid?.layerCount !== 2) {
			throw new Error(`live Tile Paint configuration returned incomplete grid evidence: ${JSON.stringify(configured)}`);
		}
		const painted = JSON.parse(
			await call("apply_tile_paint_viewport_stroke", {
				expectedRevision: configured.revision,
				expectedMapRevision: configured.mapRevision,
				anchors: [
					[1, 1],
					[2, 1],
					[2, 2],
				],
			})
		);
		if (painted.stroke.changedTiles !== 8 || painted.stroke.affectedCells.length !== 8 || painted.mapRevision !== 1) {
			throw new Error(`live Tile Paint drag returned incomplete evidence: ${JSON.stringify(painted.stroke)}`);
		}
		const erased = JSON.parse(
			await call("apply_tile_paint_viewport_stroke", {
				expectedRevision: painted.revision,
				expectedMapRevision: painted.mapRevision,
				position: [2, 2],
				brushSize: [1, 1],
				mode: "erase",
			})
		);
		if (erased.stroke.changedTiles !== 1 || erased.mapRevision !== 2) {
			throw new Error(`live Tile Paint erase returned incomplete evidence: ${JSON.stringify(erased.stroke)}`);
		}
		const staleEvidence = await expectCallFailure(
			"apply_tile_paint_viewport_stroke",
			{ expectedRevision: painted.revision, expectedMapRevision: painted.mapRevision, position: [0, 0] },
			/revision is/i
		);
		const invalidEvidence = await expectCallFailure(
			"apply_tile_paint_viewport_stroke",
			{ expectedRevision: erased.revision, expectedMapRevision: erased.mapRevision, position: [7, 5] },
			/must stay inside/i
		);
		const unknownEvidence = await expectCallFailure(
			"apply_tile_paint_viewport_stroke",
			{ expectedRevision: erased.revision, expectedMapRevision: erased.mapRevision, position: [0, 0], floodFill: true },
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("get_tile_paint_viewport"));
		const maps = JSON.parse(await call("list_sprite_maps"));
		const liveMap = maps.maps.find((entry) => entry.id === fixtureId);
		if (unchanged.revision !== erased.revision || unchanged.mapRevision !== 2 || unchanged.lastStroke?.mode !== "erase" || liveMap?.tiles.length !== 7) {
			throw new Error(`invalid Tile Paint requests changed state or final cells are wrong: ${JSON.stringify({ unchanged, liveMap })}`);
		}
		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] Tile Paint viewport: map=${fixtureId} revision=${unchanged.revision} mapRevision=${unchanged.mapRevision} grid=${unchanged.grid.width}x${unchanged.grid.height} layer=${unchanged.layer} brush=${unchanged.brushSize.join("x")} cells=${liveMap.tiles.length}`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] out-of-stage rejection: ${invalidEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding active Tile Paint grid/brush/Inspector for ${holdMilliseconds}ms of visible verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalPalettes = JSON.parse(await call("list_tile_palettes")).palettes.length;
		const finalViewport = JSON.parse(await call("get_tile_paint_viewport"));
		if (
			finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
			finalPalettes !== baselinePalettes ||
			finalViewport.enabled ||
			finalViewport.mapNodeId ||
			finalViewport.paletteId
		) {
			throw new Error(`live Tile Paint cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselinePalettes, finalPalettes, finalViewport })}`);
		}
		console.log(`[live-scenario] Tile Paint cleanup: meshes=${finalDiagnostics.meshes} palettes=${finalPalettes} enabled=${finalViewport.enabled}`);
	}

	// 21. Optional: complete reusable Sprite Shape profile plus generated
	// spline/rendering/collider lifecycle through the bundled stdio server.
	if (has("--sprite-shape")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineProfiles = JSON.parse(await call("list_sprite_shape_profiles", { offset: 0, limit: 100 })).profiles.total;
		const baselineShapes = JSON.parse(await call("list_sprite_shapes", { offset: 0, limit: 100 })).shapes.total;
		const baselineBodies = JSON.parse(await call("list_physics2d_bodies")).bodies.length;
		const fixtureName = `Codex Sprite Shape 680 ${process.pid}`;
		let profileId = null;
		let shapeId = null;
		restore = async () => {
			if (shapeId) {
				try {
					const current = JSON.parse(await call("get_sprite_shape", { nodeId: shapeId }));
					await call("delete_sprite_shape", { nodeId: shapeId, expectedRevision: current.definition.revision });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				shapeId = null;
			}
			if (profileId) {
				try {
					const current = JSON.parse(await call("get_sprite_shape_profile", { profileId }));
					await call("delete_sprite_shape_profile", { profileId, expectedRevision: current.revision });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				profileId = null;
			}
		};

		const profile = JSON.parse(
			await call("create_sprite_shape_profile", {
				name: `${fixtureName} Profile`,
				edgeColor: [0.12, 0.82, 0.28, 1],
				fillColor: [0.04, 0.24, 0.1, 1],
				pixelsPerUnit: 100,
				useSpriteBorders: true,
				angleRanges: [{ id: "uphill", name: "Uphill", minimumDegrees: 0, maximumDegrees: 90, order: 5, texturePath: null, color: [0.95, 0.65, 0.12, 1] }],
			})
		);
		profileId = profile.id;
		const created = JSON.parse(await call("create_sprite_shape", { name: fixtureName, profileId }));
		shapeId = created.node.id;
		if (
			created.definition.revision !== 1 ||
			created.definition.points.length !== 4 ||
			created.generated.sampleCount !== 4 ||
			created.generated.fillTriangleCount !== 2 ||
			created.generated.colliderType !== "polygon" ||
			created.generated.colliderPartCount !== 2
		) {
			throw new Error(`live Sprite Shape creation returned incomplete generated evidence: ${JSON.stringify(created)}`);
		}
		const updated = JSON.parse(
			await call("set_sprite_shape", {
				nodeId: shapeId,
				expectedRevision: 1,
				update: {
					closed: false,
					detail: 6,
					geometryOptimization: false,
					worldSpaceUV: true,
					points: [
						{ id: "start", position: [-180, 0], leftTangent: [0, 0], rightTangent: [90, 140], tangentMode: "broken", height: 34, corner: false },
						{ id: "end", position: [180, 0], leftTangent: [-90, 140], rightTangent: [0, 0], tangentMode: "broken", height: 54, corner: false },
					],
					collider: { enabled: true, type: "edge", detail: 4, offset: 3, edgeRadius: 6, optimize: false, isTrigger: true, friction: 0.25, restitution: 0.1 },
				},
			})
		);
		if (
			updated.definition.revision !== 2 ||
			updated.generated.sampleCount !== 7 ||
			updated.generated.edgeQuadCount !== 6 ||
			updated.generated.fillTriangleCount !== 0 ||
			updated.generated.colliderType !== "edge" ||
			updated.generated.colliderPartCount !== 4
		) {
			throw new Error(`live Sprite Shape curve update returned incomplete evidence: ${JSON.stringify(updated)}`);
		}
		const updatedProfile = JSON.parse(
			await call("set_sprite_shape_profile", {
				profileId,
				expectedRevision: 1,
				update: { pixelsPerUnit: 128, useSpriteBorders: false, fillColor: [0.08, 0.18, 0.72, 0.92] },
			})
		);
		if (updatedProfile.revision !== 2) {
			throw new Error(`live Sprite Shape profile update did not publish revision 2: ${JSON.stringify(updatedProfile)}`);
		}
		const rebuilt = JSON.parse(await call("get_sprite_shape", { nodeId: shapeId }));
		if (rebuilt.generated.profileRevision !== 2 || rebuilt.profile.revision !== 2 || rebuilt.definition.revision !== 2) {
			throw new Error(`dependent Sprite Shape was not rebuilt from profile revision 2: ${JSON.stringify(rebuilt)}`);
		}
		const staleShapeEvidence = await expectCallFailure("set_sprite_shape", { nodeId: shapeId, expectedRevision: 1, update: { detail: 8 } }, /revision is 2/i);
		const staleProfileEvidence = await expectCallFailure(
			"set_sprite_shape_profile",
			{ profileId, expectedRevision: 1, update: { name: `${fixtureName} Stale` } },
			/revision is 2/i
		);
		const invalidTangentEvidence = await expectCallFailure(
			"set_sprite_shape",
			{
				nodeId: shapeId,
				expectedRevision: 2,
				update: {
					points: [
						{ id: "start", position: [-180, 0], leftTangent: [-10, 0], rightTangent: [0, 10], tangentMode: "continuous", height: 34, corner: false },
						{ id: "end", position: [180, 0], leftTangent: [-90, 140], rightTangent: [0, 0], tangentMode: "broken", height: 54, corner: false },
					],
				},
			},
			/continuous tangents/i
		);
		const unknownEvidence = await expectCallFailure(
			"set_sprite_shape",
			{ nodeId: shapeId, expectedRevision: 2, update: { detail: 8, autoSmooth: true } },
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("get_sprite_shape", { nodeId: shapeId }));
		if (unchanged.definition.revision !== 2 || unchanged.profile.revision !== 2 || unchanged.generated.sampleCount !== 7) {
			throw new Error(`invalid Sprite Shape requests changed live state: ${JSON.stringify(unchanged)}`);
		}
		await call("select_node", { nodeId: shapeId });
		await call("focus_node", { nodeId: shapeId });
		console.log(
			`[live-scenario] Sprite Shape: node=${shapeId} shapeRevision=${unchanged.definition.revision} profileRevision=${unchanged.profile.revision} points=${unchanged.definition.points.length} samples=${unchanged.generated.sampleCount} quads=${unchanged.generated.edgeQuadCount} collider=${unchanged.generated.colliderType}/${unchanged.generated.colliderPartCount}`
		);
		console.log(`[live-scenario] stale-shape rejection: ${staleShapeEvidence}`);
		console.log(`[live-scenario] stale-profile rejection: ${staleProfileEvidence}`);
		console.log(`[live-scenario] invalid-tangent rejection: ${invalidTangentEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding selected Sprite Shape and yellow scene handles for ${holdMilliseconds}ms of visible verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalProfiles = JSON.parse(await call("list_sprite_shape_profiles", { offset: 0, limit: 100 })).profiles.total;
		const finalShapes = JSON.parse(await call("list_sprite_shapes", { offset: 0, limit: 100 })).shapes.total;
		const finalBodies = JSON.parse(await call("list_physics2d_bodies")).bodies.length;
		if (
			finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
			finalDiagnostics.materials !== baselineDiagnostics.materials ||
			finalProfiles !== baselineProfiles ||
			finalShapes !== baselineShapes ||
			finalBodies !== baselineBodies
		) {
			throw new Error(
				`live Sprite Shape cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineProfiles, finalProfiles, baselineShapes, finalShapes, baselineBodies, finalBodies })}`
			);
		}
		console.log(
			`[live-scenario] Sprite Shape cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials} profiles=${finalProfiles} shapes=${finalShapes} bodies=${finalBodies}`
		);
	}

	// 22. Optional: complete Unity-style Tilemap Collider 2D lifecycle. A
	// disposable atlas-backed Sprite Map proves Grid and compound Sprite shapes,
	// manual pending changes, incremental reuse, threshold full rebuilding,
	// outline/Delaunay/material/layer settings, strict rejection, and cleanup.
	if (has("--tilemap-collider")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineBodies = JSON.parse(await call("list_physics2d_bodies")).bodies.length;
		const fixtureName = `Codex Tilemap Collider 681 ${process.pid}`;
		const assetFolder = `assets/${fixtureName}`;
		const scriptPath = `agentdata/codex-tilemap-collider-681-${process.pid}.js`;
		let fixtureId = null;
		restore = async () => {
			if (fixtureId) {
				try {
					const current = JSON.parse(await call("get_tile_collider_generator", { mapNodeId: fixtureId }));
					if (current.generator) {
						await call("clear_tile_collider_generator", { mapNodeId: fixtureId, expectedRevision: current.generator.revision });
					}
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				try {
					await call("delete_node", { nodeId: fixtureId });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				fixtureId = null;
			}
			for (const path of [assetFolder, scriptPath]) {
				try {
					await call("delete_asset", { path, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
		};

		const setupSource = `
import { dirname, join } from "path";
import { ensureDir, writeFile, writeJSON } from "fs-extra";
import { Vector2, Vector3 } from "babylonjs";
import { SpriteMapNode } from "babylonjs-editor";

export async function main(editor) {
	const scene = editor.layout.preview.scene;
	const directory = join(dirname(editor.path), ${JSON.stringify(assetFolder)});
	await ensureDir(directory);
	await writeFile(join(directory, "atlas.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYx8WQAAAABJRU5ErkJggg==", "base64"));
	await writeJSON(join(directory, "atlas.json"), {
		frames: {
			"grid.png": { frame: { x: 0, y: 0, w: 1, h: 1 }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 }, sourceSize: { w: 1, h: 1 } },
			"sprite.png": { frame: { x: 0, y: 0, w: 1, h: 1 }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 }, sourceSize: { w: 1, h: 1 } }
		},
		meta: { app: "Zvibe Editor", version: "1", image: "atlas.png", format: "RGBA8888", size: { w: 1, h: 1 }, scale: "1" }
	}, { spaces: "\t" });
	const node = new SpriteMapNode(${JSON.stringify(fixtureName)}, scene);
	await node.buildFromAbsolutePath(join(directory, "atlas.json"), undefined, undefined, {
		layerCount: 2,
		stageSize: new Vector2(8, 6),
		outputSize: new Vector2(800, 600),
		colorMultiply: new Vector3(1, 1, 1)
	});
	node.position.set(0, 250, 0);
	await editor.layout.graph.refresh();
	editor.layout.graph.setSelectedNode(node);
	editor.layout.inspector.setEditedObject(node);
	editor.layout.preview.focusObject(node.outputPlane);
	return JSON.stringify({ id: node.id });
}`;
		const setup = JSON.parse(await call("run_agent_script", { name: scriptPath.replace(/^agentdata\//, ""), content: setupSource }));
		fixtureId = JSON.parse(setup.result).id;
		await call("set_sprite_map_tiles", {
			mapNodeId: fixtureId,
			mode: "replace",
			tiles: [
				{ name: "Grid A", layer: 0, position: { x: 0, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 0 },
				{ name: "Grid B", layer: 0, position: { x: 1, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 0 },
				{ name: "Sprite", layer: 0, position: { x: 3, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 },
			],
		});
		const spriteContours = [
			{
				id: "outer",
				points: [
					[-0.5, -0.5],
					[0.5, -0.5],
					[0.5, 0.5],
					[-0.5, 0.5],
				],
				holes: [
					{
						id: "window",
						points: [
							[-0.12, -0.12],
							[-0.12, 0.12],
							[0.12, 0.12],
							[0.12, -0.12],
						],
					},
				],
			},
		];
		const created = JSON.parse(
			await call("generate_tile_colliders", {
				mapNodeId: fixtureId,
				compositeOperation: "merge",
				geometryType: "polygons",
				generationType: "manual",
				useDelaunayMesh: true,
				maxTileChangeCount: 1,
				extrusionFactor: 2,
				offsetDistance: 1,
				tileColliderTypes: { 0: "grid", 1: "sprite" },
				spriteShapes: { 1: spriteContours },
				isTrigger: true,
				usedByEffector: true,
				friction: 0.25,
				restitution: 0.5,
				collisionLayer: 3,
				layerOverrides: {
					priority: 2,
					includeLayers: 4,
					excludeLayers: 8,
					forceSendLayers: 16,
					forceReceiveLayers: 32,
					contactCaptureLayers: 64,
					callbackLayers: 128,
				},
			})
		);
		if (
			created.generator?.revision !== 1 ||
			created.colliderCount !== 2 ||
			created.evidence?.boxCount !== 1 ||
			created.evidence?.polygonCount !== 1 ||
			created.evidence?.triangulation !== "bounded-delaunay-edge-flips-v1"
		) {
			throw new Error(`live Tilemap Collider creation returned incomplete evidence: ${JSON.stringify(created)}`);
		}
		const originalNodeIds = created.generator.nodeIds;
		await call("set_sprite_map_tiles", {
			mapNodeId: fixtureId,
			mode: "add",
			tiles: [{ name: "Grid C", layer: 0, position: { x: 0, y: 1 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 0 }],
		});
		const pending = JSON.parse(await call("get_tile_collider_generator", { mapNodeId: fixtureId }));
		if (!pending.generator?.hasTilemapChanges || pending.generator.pendingChangeCount !== 1 || pending.generator.nodeIds.join(",") !== originalNodeIds.join(",")) {
			throw new Error(`manual Tilemap Collider changes were not retained as pending: ${JSON.stringify(pending)}`);
		}
		const incremental = JSON.parse(await call("refresh_tile_colliders", { mapNodeId: fixtureId, expectedRevision: 1 }));
		if (incremental.mode !== "incremental" || incremental.changedCellCount !== 1 || incremental.reusedColliderCount !== 2 || incremental.createdColliderCount !== 1) {
			throw new Error(`live Tilemap Collider incremental generation was incomplete: ${JSON.stringify(incremental)}`);
		}
		await call("set_sprite_map_tiles", {
			mapNodeId: fixtureId,
			mode: "add",
			tiles: [
				{ name: "Grid D", layer: 0, position: { x: 1, y: 1 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 0 },
				{ name: "Grid E", layer: 0, position: { x: 2, y: 1 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 0 },
			],
		});
		const full = JSON.parse(await call("refresh_tile_colliders", { mapNodeId: fixtureId, expectedRevision: 1 }));
		if (full.mode !== "full" || full.changedCellCount !== 2 || full.reusedColliderCount !== 0 || full.createdColliderCount < 2) {
			throw new Error(`Max Tile Change Count did not select a full rebuild: ${JSON.stringify(full)}`);
		}
		const outlined = JSON.parse(
			await call("set_tile_collider_generator", {
				mapNodeId: fixtureId,
				expectedRevision: 1,
				update: { generationType: "synchronous", geometryType: "outlines", edgeRadius: 5, offset: [20, -10] },
			})
		);
		if (outlined.generator?.revision !== 2 || outlined.generator?.lastBuild?.evidence?.edgeCount < 8 || outlined.generator?.lastBuild?.evidence?.polygonCount !== 0) {
			throw new Error(`live Tilemap Collider outline update returned incomplete evidence: ${JSON.stringify(outlined)}`);
		}
		const staleEvidence = await expectCallFailure("set_tile_collider_generator", { mapNodeId: fixtureId, expectedRevision: 1, update: { friction: 0.75 } }, /revision is 2/i);
		const invalidShapeEvidence = await expectCallFailure(
			"set_tile_collider_generator",
			{
				mapNodeId: fixtureId,
				expectedRevision: 2,
				update: {
					spriteShapes: {
						1: [
							{
								id: "invalid",
								points: [
									[-0.5, -0.5],
									[0.75, -0.5],
									[0, 0.5],
								],
								holes: [],
							},
						],
					},
				},
			},
			/(invalid|0\.5|too big|less_than_equal)/i
		);
		const unknownEvidence = await expectCallFailure(
			"set_tile_collider_generator",
			{ mapNodeId: fixtureId, expectedRevision: 2, update: { autoTilePhysics: true } },
			/(unrecognized|invalid)/i
		);
		const unchanged = JSON.parse(await call("get_tile_collider_generator", { mapNodeId: fixtureId }));
		if (unchanged.generator?.revision !== 2 || unchanged.generator?.geometryType !== "outlines" || unchanged.generator?.lastBuild?.evidence?.edgeCount < 8) {
			throw new Error(`invalid Tilemap Collider requests changed state: ${JSON.stringify(unchanged)}`);
		}
		await call("select_node", { nodeId: fixtureId });
		console.log(
			`[live-scenario] Tilemap Collider 2D: map=${fixtureId} revision=${unchanged.generator.revision} geometryRevision=${unchanged.generator.geometryRevision} colliders=${unchanged.generator.nodeIds.length} edges=${unchanged.generator.lastBuild.evidence.edgeCount} masks=${JSON.stringify(unchanged.generator.layerOverrides)}`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] invalid-shape rejection: ${invalidShapeEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding selected Tilemap Collider 2D Inspector for ${holdMilliseconds}ms of visible verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalBodies = JSON.parse(await call("list_physics2d_bodies")).bodies.length;
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalDiagnostics.materials !== baselineDiagnostics.materials || finalBodies !== baselineBodies) {
			throw new Error(`live Tilemap Collider cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineBodies, finalBodies })}`);
		}
		console.log(`[live-scenario] Tilemap Collider cleanup: meshes=${finalDiagnostics.meshes} materials=${finalDiagnostics.materials} bodies=${finalBodies}`);
	}

	// 23. Optional: complete Unity-style visual UI authoring lifecycle. A
	// disposable GUI proves stable control identities, nested layout, Canvas
	// Scaler/safe area, custom-event bindings, exact revisions, persistence,
	// strict rejection, live disposal, asset deletion, and zero-residue cleanup.
	if (has("--gui-authoring")) {
		const baselineGUIs = JSON.parse(await call("list_guis")).guis;
		const assetPath = `assets/codex-gui-authoring-682-${process.pid}.gui`;
		const fontPath = `assets/codex-gui-authoring-682-${process.pid}.ttf`;
		const fontFixture = join(HERE, "..", "..", "editor", "test", "fixtures", "fonts", "Amiri-Regular.ttf");
		let guiId = null;
		restore = async () => {
			if (guiId) {
				try {
					const current = JSON.parse(await call("get_gui_authoring", { guiId, offset: 0, limit: 1 }));
					await call("delete_gui_instance", { guiId, expectedRevision: current.authoring.revision, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				guiId = null;
			}
			for (const path of [assetPath, fontPath]) {
				try {
					await call("delete_asset", { path, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
		};

		if (!existsSync(fontFixture)) throw new Error(`GUI live font fixture is missing: ${fontFixture}`);
		await call("import_asset", { sourcePath: fontFixture, destinationPath: fontPath });
		console.log(`[live-scenario] GUI fixture font imported: ${fontPath}`);
		const fontPlan = JSON.parse(await call("get_font_importer_result", { path: fontPath }));
		const fontStatus = JSON.parse(await call("apply_font_importer", { path: fontPath, expectedFingerprint: fontPlan.fingerprint, confirm: true }));
		if (!fontStatus.current || !fontStatus.result?.sourceFontPath || fontStatus.result.sourceFontPath.startsWith("/")) {
			throw new Error(`GUI live font importer omitted a portable browser source fallback: ${JSON.stringify(fontStatus)}`);
		}
		console.log(`[live-scenario] GUI fixture font ready: mode=${fontStatus.result.renderMode} source=${fontStatus.result.sourceFontPath}`);
		await call("create_gui_asset", { path: assetPath, name: `Codex GUI Authoring 682 ${process.pid}` });
		const instantiated = JSON.parse(await call("instantiate_gui_asset", { path: assetPath }));
		guiId = instantiated.id;
		console.log(`[live-scenario] GUI fixture instantiated: gui=${guiId}`);
		let result = JSON.parse(
			await call("create_gui_control", {
				guiId,
				expectedRevision: 0,
				controlId: "menu-panel",
				type: "rectangle",
				properties: { name: "Menu Panel", width: "720px", height: "420px", background: "#182030ee", thickness: 2, cornerRadius: 16 },
			})
		);
		if (result.revision !== 1 || result.control?.id !== "menu-panel") throw new Error(`GUI panel creation returned incomplete evidence: ${JSON.stringify(result)}`);
		result = JSON.parse(
			await call("create_gui_control", {
				guiId,
				expectedRevision: 1,
				controlId: "play-button",
				parentControlId: "menu-panel",
				type: "button",
				properties: { name: "Play Button", text: "Play", width: "260px", height: "72px", background: "#5f7cff", color: "#ffffff" },
			})
		);
		if (result.revision !== 2 || result.control?.parentId !== "menu-panel")
			throw new Error(`GUI nested button creation returned incomplete evidence: ${JSON.stringify(result)}`);
		result = JSON.parse(
			await call("update_gui_control", {
				guiId,
				expectedRevision: 2,
				controlId: "play-button",
				properties: { text: "Start Game", fontSize: 30, alpha: 0.95, top: "80px" },
			})
		);
		if (result.revision !== 3 || result.control?.properties?.text !== "Start Game")
			throw new Error(`GUI control update returned incomplete evidence: ${JSON.stringify(result)}`);
		result = JSON.parse(
			await call("set_gui_canvas_settings", {
				guiId,
				expectedRevision: 3,
				canvas: {
					referenceWidth: 1280,
					referenceHeight: 720,
					scaleMode: "scaleWithScreenSize",
					screenMatchMode: "matchWidthOrHeight",
					matchWidthOrHeight: 0.4,
					safeArea: { enabled: true, left: 0.03, top: 0.02, right: 0.03, bottom: 0.04 },
				},
			})
		);
		if (result.revision !== 4 || result.canvas?.safeArea?.bottom !== 0.04) throw new Error(`GUI Canvas settings returned incomplete evidence: ${JSON.stringify(result)}`);
		result = JSON.parse(
			await call("set_gui_control_font", {
				guiId,
				expectedRevision: 4,
				controlId: "play-button",
				assignment: { assetPaths: [fontPath], fontStyle: "normal", fontWeight: "700" },
			})
		);
		if (result.revision !== 5 || result.assignment?.assetPaths?.[0] !== fontPath)
			throw new Error(`GUI font assignment returned incomplete evidence: ${JSON.stringify(result)}`);
		console.log(`[live-scenario] GUI fixture font assigned at revision ${result.revision}`);
		result = JSON.parse(
			await call("create_gui_event_binding", {
				guiId,
				expectedRevision: 5,
				binding: {
					id: "play-click",
					controlId: "play-button",
					event: "pointerClick",
					enabled: true,
					target: { kind: "customEvent", eventName: "game.play", detail: { source: "live-scenario" } },
				},
			})
		);
		if (result.revision !== 6 || result.binding?.target?.eventName !== "game.play")
			throw new Error(`GUI event binding returned incomplete evidence: ${JSON.stringify(result)}`);
		result = JSON.parse(await call("update_gui_event_binding", { guiId, expectedRevision: 6, bindingId: "play-click", updates: { event: "pointerUp" } }));
		if (result.revision !== 7 || result.binding?.event !== "pointerUp") throw new Error(`GUI event update returned incomplete evidence: ${JSON.stringify(result)}`);
		result = JSON.parse(await call("move_gui_control", { guiId, expectedRevision: 7, controlId: "play-button", parentControlId: null, zIndex: 8 }));
		if (result.revision !== 8 || result.control?.parentId !== null || result.control?.properties?.zIndex !== 8) {
			throw new Error(`GUI hierarchy move returned incomplete evidence: ${JSON.stringify(result)}`);
		}

		const staleEvidence = await expectCallFailure(
			"update_gui_control",
			{ guiId, expectedRevision: 7, controlId: "play-button", properties: { alpha: 0.5 } },
			/expectedRevision 8/i
		);
		const unknownEvidence = await expectCallFailure(
			"update_gui_control",
			{ guiId, expectedRevision: 8, controlId: "play-button", properties: { autoLayout: true } },
			/(unrecognized|invalid)/i
		);
		const authored = JSON.parse(await call("get_gui_authoring", { guiId, offset: 0, limit: 20 }));
		const authoredButton = authored.controls?.items?.find((control) => control.id === "play-button");
		if (
			authored.authoring?.revision !== 8 ||
			authored.controls?.total !== 3 ||
			authored.authoring?.bindings?.length !== 1 ||
			authored.authoring?.fonts?.length !== 1 ||
			authored.authoring?.canvas?.referenceWidth !== 1280 ||
			authoredButton?.properties?.width !== "260px" ||
			authoredButton?.properties?.fontSize !== "30px"
		) {
			throw new Error(`live GUI authoring evidence was incomplete: ${JSON.stringify(authored)}`);
		}
		await call("save_gui_asset", { guiId, path: assetPath, overwrite: true });
		const saved = JSON.parse(await call("get_gui_asset", { path: assetPath }));
		if (saved.zvibeGUIAuthoring?.revision !== 8 || saved.zvibeGUIAuthoring?.fonts?.[0]?.assetPaths?.[0] !== fontPath || !saved.content) {
			throw new Error(`saved GUI omitted authored state, font assignment, or content: ${JSON.stringify(saved)}`);
		}
		console.log(
			`[live-scenario] GUI authoring: gui=${guiId} revision=${authored.authoring.revision} controls=${authored.controls.total} bindings=${authored.authoring.bindings.length} canvas=${authored.authoring.canvas.referenceWidth}x${authored.authoring.canvas.referenceHeight}`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding authored GUI Inspector for ${holdMilliseconds}ms of visible verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		await call("delete_gui_event_binding", { guiId, expectedRevision: 8, bindingId: "play-click" });
		await call("delete_gui_control", { guiId, expectedRevision: 9, controlId: "play-button" });
		await call("delete_gui_control", { guiId, expectedRevision: 10, controlId: "menu-panel" });
		const staleDeleteEvidence = await expectCallFailure("delete_gui_instance", { guiId, expectedRevision: 10, confirm: true }, /expectedRevision 11/i);
		await call("delete_gui_instance", { guiId, expectedRevision: 11, confirm: true });
		guiId = null;
		for (const path of [assetPath, fontPath]) await call("delete_asset", { path, confirm: true });
		restore = null;
		const finalGUIs = JSON.parse(await call("list_guis")).guis;
		if (finalGUIs.length !== baselineGUIs.length || finalGUIs.some((gui) => !baselineGUIs.some((baseline) => baseline.id === gui.id))) {
			throw new Error(`live GUI cleanup mismatch: ${JSON.stringify({ baselineGUIs, finalGUIs })}`);
		}
		console.log(`[live-scenario] stale-disposal rejection: ${staleDeleteEvidence}`);
		console.log(`[live-scenario] GUI cleanup: instances=${finalGUIs.length}, deletedAsset=${assetPath}`);
	}

	// 24. Optional: complete atlas-rich-text lifecycle through the external
	// stdio MCP server. This exercises real MSDF pages, TMP-style tags, ordered
	// font fallback, bounded missing-glyph population, exact revisions,
	// persistence without generated base64 pixels, refresh, and exact cleanup.
	if (has("--gui-atlas-text")) {
		const baselineGUIs = JSON.parse(await call("list_guis")).guis;
		const assetPath = `assets/codex-gui-atlas-683-${process.pid}.gui`;
		const fontPath = `assets/codex-gui-atlas-683-${process.pid}.ttf`;
		const fontFixture = join(HERE, "..", "..", "editor", "test", "fixtures", "fonts", "Amiri-Regular.ttf");
		let guiId = null;
		restore = async () => {
			if (guiId) {
				try {
					const current = JSON.parse(await call("get_gui_authoring", { guiId, offset: 0, limit: 1 }));
					await call("delete_gui_instance", { guiId, expectedRevision: current.authoring.revision, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				guiId = null;
			}
			for (const path of [assetPath, fontPath]) {
				try {
					await call("delete_asset", { path, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
		};

		if (!existsSync(fontFixture)) throw new Error(`GUI atlas live font fixture is missing: ${fontFixture}`);
		await call("import_asset", { sourcePath: fontFixture, destinationPath: fontPath });
		await call("set_asset_importer_settings", {
			paths: [fontPath],
			settings: {
				renderMode: "msdf",
				characterSet: "custom",
				customCharacters: " ZvibeAtlasReadyUpdated0123456789…?",
				fontSize: 64,
				padding: 5,
				distanceRange: 8,
			},
		});
		const fontPlan = JSON.parse(await call("get_font_importer_result", { path: fontPath }));
		const fontStatus = JSON.parse(await call("apply_font_importer", { path: fontPath, expectedFingerprint: fontPlan.fingerprint, confirm: true }));
		if (fontStatus.result?.renderMode !== "msdf" || !fontStatus.result?.pages?.length || !fontStatus.result?.sourceFontPath) {
			throw new Error(`GUI atlas font importer did not publish complete MSDF/source artifacts: ${JSON.stringify(fontStatus)}`);
		}
		console.log(`[live-scenario] GUI atlas font ready: glyphs=${fontStatus.result.glyphCount} pages=${fontStatus.result.pages.length}`);
		await call("create_gui_asset", { path: assetPath, name: `Codex Atlas Text 683 ${process.pid}` });
		const instantiated = JSON.parse(await call("instantiate_gui_asset", { path: assetPath }));
		guiId = instantiated.id;
		const firstAssignment = {
			fontAssetPaths: [fontPath],
			text: "<b>Zvibe</b> <color=#73a7ffff>Atlas</color> 🚀",
			width: 720,
			height: 320,
			fontSize: 64,
			color: "#ffffffff",
			outlineColor: "#10182fff",
			outlineWidth: 3,
			characterSpacing: 1,
			lineSpacing: 1.1,
			horizontalAlignment: "center",
			verticalAlignment: "center",
			wrapMode: "word",
			overflowMode: "ellipsis",
			richText: true,
			populateMissingGlyphs: true,
			maxRuntimeGlyphs: 64,
		};
		let result = JSON.parse(
			await call("create_gui_atlas_text", {
				guiId,
				expectedRevision: 0,
				controlId: "atlas-title",
				name: "Atlas Rich Title",
				width: "720px",
				height: "320px",
				assignment: firstAssignment,
			})
		);
		if (
			result.revision !== 1 ||
			result.assignment?.model !== "unity-atlas-rich-text-v1" ||
			result.runtime?.renderModes?.msdf < 1 ||
			result.runtime?.runtimeGlyphCount < 1 ||
			!result.runtime?.populatedCodepoints?.includes(0x1f680)
		) {
			throw new Error(`GUI atlas creation omitted MSDF or runtime-population evidence: ${JSON.stringify(result)}`);
		}
		const read = JSON.parse(await call("get_gui_atlas_text", { guiId, controlId: "atlas-title" }));
		if (read.revision !== 1 || read.assignment?.text !== firstAssignment.text || read.runtime?.glyphCount < 1) {
			throw new Error(`GUI atlas readback was incomplete: ${JSON.stringify(read)}`);
		}
		const updatedAssignment = {
			...firstAssignment,
			text: "<size=110%><b>Updated</b></size><br><u>Atlas Ready</u> 🚀",
			characterSpacing: 2,
			lineSpacing: 1,
			horizontalAlignment: "left",
		};
		result = JSON.parse(await call("set_gui_atlas_text", { guiId, expectedRevision: 1, controlId: "atlas-title", assignment: updatedAssignment }));
		if (result.revision !== 2 || result.runtime?.lineCount !== 2 || result.runtime?.richTagCount < 6) {
			throw new Error(`GUI atlas update omitted rich layout evidence: ${JSON.stringify(result)}`);
		}
		const staleEvidence = await expectCallFailure(
			"set_gui_atlas_text",
			{ guiId, expectedRevision: 1, controlId: "atlas-title", assignment: firstAssignment },
			/expectedRevision 2/i
		);
		const unknownEvidence = await expectCallFailure("refresh_gui_atlas_text", { guiId, expectedRevision: 2, controlId: "atlas-title", force: true }, /(unrecognized|invalid)/i);
		const refreshed = JSON.parse(await call("refresh_gui_atlas_text", { guiId, expectedRevision: 2, controlId: "atlas-title" }));
		if (refreshed.revision !== 2 || refreshed.runtime?.renderModes?.msdf < 1) {
			throw new Error(`GUI atlas refresh omitted live MSDF evidence: ${JSON.stringify(refreshed)}`);
		}
		await call("save_gui_asset", { guiId, path: assetPath, overwrite: true });
		const saved = JSON.parse(await call("get_gui_asset", { path: assetPath }));
		if (saved.zvibeGUIAuthoring?.atlasTexts?.[0]?.model !== "unity-atlas-rich-text-v1" || JSON.stringify(saved.content).includes("data:image")) {
			throw new Error(`saved GUI atlas state is missing or embedded generated pixels: ${JSON.stringify(saved).slice(0, 2000)}`);
		}
		await call("delete_gui_instance", { guiId, expectedRevision: 2, confirm: true });
		guiId = null;
		const reloadedInstance = JSON.parse(await call("instantiate_gui_asset", { path: assetPath }));
		guiId = reloadedInstance.id;
		const reloaded = JSON.parse(await call("get_gui_atlas_text", { guiId, controlId: "atlas-title" }));
		if (reloaded.revision !== 2 || reloaded.runtime?.renderModes?.msdf < 1 || reloaded.runtime?.runtimeGlyphCount !== 1 || reloaded.runtime?.lineCount !== 2) {
			throw new Error(`reloaded GUI atlas asset did not reconstruct its live canvas: ${JSON.stringify(reloaded)}`);
		}
		console.log(
			`[live-scenario] GUI atlas text: gui=${guiId} revision=2 glyphs=${reloaded.runtime.glyphCount} msdf=${reloaded.runtime.renderModes.msdf} runtime=${reloaded.runtime.runtimeGlyphCount} lines=${reloaded.runtime.lineCount} reloaded=true`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding atlas-rich-text Inspector for ${holdMilliseconds}ms of visible verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}

		const cleared = JSON.parse(await call("clear_gui_atlas_text", { guiId, expectedRevision: 2, controlId: "atlas-title" }));
		const clearedAuthoring = JSON.parse(await call("get_gui_authoring", { guiId, offset: 0, limit: 200 }));
		if (
			cleared.revision !== 3 ||
			cleared.runtimeCleared !== true ||
			cleared.transparentCanvas?.width !== 1 ||
			cleared.transparentCanvas?.height !== 1 ||
			clearedAuthoring.authoring?.atlasTexts?.length !== 0 ||
			clearedAuthoring.atlasTextRuntime?.length !== 0
		) {
			throw new Error(`GUI atlas clear retained live pixels or authored/runtime state: ${JSON.stringify({ cleared, clearedAuthoring })}`);
		}
		await call("delete_gui_control", { guiId, expectedRevision: 3, controlId: "atlas-title" });
		const staleDeleteEvidence = await expectCallFailure("delete_gui_instance", { guiId, expectedRevision: 3, confirm: true }, /expectedRevision 4/i);
		await call("delete_gui_instance", { guiId, expectedRevision: 4, confirm: true });
		guiId = null;
		for (const path of [assetPath, fontPath]) await call("delete_asset", { path, confirm: true });
		restore = null;
		const finalGUIs = JSON.parse(await call("list_guis")).guis;
		if (finalGUIs.length !== baselineGUIs.length || finalGUIs.some((gui) => !baselineGUIs.some((baseline) => baseline.id === gui.id))) {
			throw new Error(`live GUI atlas cleanup mismatch: ${JSON.stringify({ baselineGUIs, finalGUIs })}`);
		}
		console.log(`[live-scenario] stale-disposal rejection: ${staleDeleteEvidence}`);
		console.log(`[live-scenario] GUI atlas cleanup: instances=${finalGUIs.length}, deletedAsset=${assetPath}, deletedFont=${fontPath}`);
	}

	// 25. Optional: complete bounded UXML/USS retained-UI lifecycle through
	// real external stdio, including templates, selector/pseudo compilation,
	// exact source leases, source rewrite, detach/reattach, persistence/reload,
	// unknown/stale rejection, and exact cleanup.
	if (has("--gui-retained-ui")) {
		const baselineGUIs = JSON.parse(await call("list_guis")).guis;
		const suffix = `${process.pid}`;
		const assetPath = `assets/codex-gui-retained-684-${suffix}.gui`;
		const uxmlPath = `assets/codex-gui-retained-684-${suffix}.uxml`;
		const ussPath = `assets/codex-gui-retained-684-${suffix}.uss`;
		const templatePath = `assets/codex-gui-retained-card-684-${suffix}.uxml`;
		let guiId = null;
		restore = async () => {
			if (guiId) {
				try {
					const current = JSON.parse(await call("get_gui_authoring", { guiId, offset: 0, limit: 1 }));
					await call("delete_gui_instance", { guiId, expectedRevision: current.authoring.revision, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
				guiId = null;
			}
			for (const path of [assetPath, uxmlPath, ussPath, templatePath]) {
				try {
					await call("delete_asset", { path, confirm: true });
				} catch (error) {
					if (!/not found/i.test(error.message)) throw error;
				}
			}
		};

		await call("create_gui_asset", { path: assetPath, name: `Codex Retained UI 684 ${suffix}` });
		guiId = JSON.parse(await call("instantiate_gui_asset", { path: assetPath })).id;
		const uxmlSource = `<UXML><Style src="${ussPath.slice("assets/".length)}"/><Template name="Card" src="${templatePath.slice("assets/".length)}"/><VisualElement name="screen" class="screen" width="100%" height="100%"><Label name="title" class="title" text="Retained Ready"/><Instance template="Card" name="primary" class="instance"/></VisualElement></UXML>`;
		const templateSource = `<UXML><Button name="action" class="primary" text="Play"/></UXML>`;
		const firstUSS = `:root { --accent: #73a7ff; } .screen { flex-direction: column; gap: 12px; background-color: #10182f; } .title { color: #ffffff; font-size: 36px; } Button.primary { width: 220px; height: 56px; background-color: #202840; } Button.primary:hover { background-color: var(--accent); opacity: 0.9; } #action:active { opacity: 0.7; }`;
		let result = JSON.parse(
			await call("write_gui_retained_document", {
				guiId,
				expectedRevision: 0,
				expectedSourceFingerprint: null,
				uxml: { path: uxmlPath, source: uxmlSource },
				stylesheets: [{ path: ussPath, source: firstUSS }],
				templates: [{ path: templatePath, source: templateSource }],
				hotReload: true,
				overwrite: false,
			})
		);
		if (
			result.revision !== 1 ||
			result.controlCount !== 3 ||
			result.retainedDocument?.compiled?.pseudoRuleCount !== 2 ||
			result.retainedDocument?.compiled?.templateCount !== 1
		) {
			throw new Error(`retained UI write omitted compiler evidence: ${JSON.stringify(result)}`);
		}
		let retained = JSON.parse(await call("get_gui_retained_document", { guiId, includeSources: true }));
		if (retained.revision !== 1 || retained.sources?.length !== 3 || retained.retainedDocument?.compiled?.controls?.length !== 3) {
			throw new Error(`retained UI readback was incomplete: ${JSON.stringify(retained)}`);
		}
		const staleEvidence = await expectCallFailure(
			"refresh_gui_retained_document",
			{ guiId, expectedRevision: 0, expectedSourceFingerprint: retained.retainedDocument.compiled.sourceFingerprint },
			/expectedRevision 1/i
		);
		const unknownEvidence = await expectCallFailure(
			"refresh_gui_retained_document",
			{ guiId, expectedRevision: 1, expectedSourceFingerprint: retained.retainedDocument.compiled.sourceFingerprint, force: true },
			/(unrecognized|invalid)/i
		);
		const updatedUSS = firstUSS.replace("#73a7ff", "#ffcc00").replace("#202840", "#263860");
		result = JSON.parse(
			await call("write_gui_retained_document", {
				guiId,
				expectedRevision: 1,
				expectedSourceFingerprint: retained.retainedDocument.compiled.sourceFingerprint,
				uxml: { path: uxmlPath, source: uxmlSource },
				stylesheets: [{ path: ussPath, source: updatedUSS }],
				templates: [{ path: templatePath, source: templateSource }],
				hotReload: true,
				overwrite: true,
			})
		);
		if (result.revision !== 2 || result.retainedDocument.compiled.sourceFingerprint === retained.retainedDocument.compiled.sourceFingerprint) {
			throw new Error(`retained UI rewrite did not advance exact source evidence: ${JSON.stringify(result)}`);
		}
		retained = JSON.parse(await call("get_gui_retained_document", { guiId, includeSources: false }));
		const detached = JSON.parse(
			await call("detach_gui_retained_document", {
				guiId,
				expectedRevision: 2,
				expectedSourceFingerprint: retained.retainedDocument.compiled.sourceFingerprint,
			})
		);
		if (detached.revision !== 3 || detached.preservedControlCount !== 3) throw new Error(`retained UI detach evidence was incomplete: ${JSON.stringify(detached)}`);
		result = JSON.parse(
			await call("set_gui_retained_document", {
				guiId,
				expectedRevision: 3,
				expectedSourceFingerprint: null,
				uxmlPath,
				hotReload: true,
			})
		);
		if (result.revision !== 4 || result.controlCount !== 3) throw new Error(`retained UI existing-source attach failed: ${JSON.stringify(result)}`);
		result = JSON.parse(
			await call("refresh_gui_retained_document", {
				guiId,
				expectedRevision: 4,
				expectedSourceFingerprint: result.retainedDocument.compiled.sourceFingerprint,
			})
		);
		if (result.revision !== 5 || result.changed !== false) throw new Error(`retained UI explicit refresh evidence failed: ${JSON.stringify(result)}`);
		await call("save_gui_asset", { guiId, path: assetPath, overwrite: true });
		await call("delete_gui_instance", { guiId, expectedRevision: 5, confirm: true });
		guiId = null;
		guiId = JSON.parse(await call("instantiate_gui_asset", { path: assetPath })).id;
		const reloaded = JSON.parse(await call("get_gui_retained_document", { guiId, includeSources: false }));
		if (reloaded.revision !== 5 || reloaded.retainedDocument?.compiled?.controls?.length !== 3 || reloaded.retainedDocument?.compiled?.pseudoRuleCount !== 2) {
			throw new Error(`reloaded retained UI did not reconstruct compiler/runtime state: ${JSON.stringify(reloaded)}`);
		}
		console.log(
			`[live-scenario] GUI retained UI: gui=${guiId} revision=5 controls=${reloaded.retainedDocument.compiled.controls.length} rules=${reloaded.retainedDocument.compiled.styleRuleCount} pseudos=${reloaded.retainedDocument.compiled.pseudoRuleCount} templates=${reloaded.retainedDocument.compiled.templateCount} reloaded=true`
		);
		console.log(`[live-scenario] stale-revision rejection: ${staleEvidence}`);
		console.log(`[live-scenario] unknown-field rejection: ${unknownEvidence}`);
		const holdMilliseconds = Math.max(0, Math.min(120_000, Number(flag("--hold-ms") ?? 0) || 0));
		if (holdMilliseconds > 0) {
			console.log(`[live-scenario] holding retained UXML/USS Inspector for ${holdMilliseconds}ms of visible verification`);
			await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
		}
		await call("delete_gui_instance", { guiId, expectedRevision: 5, confirm: true });
		guiId = null;
		for (const path of [assetPath, uxmlPath, ussPath, templatePath]) await call("delete_asset", { path, confirm: true });
		restore = null;
		const finalGUIs = JSON.parse(await call("list_guis")).guis;
		if (finalGUIs.length !== baselineGUIs.length || finalGUIs.some((gui) => !baselineGUIs.some((baseline) => baseline.id === gui.id))) {
			throw new Error(`live retained UI cleanup mismatch: ${JSON.stringify({ baselineGUIs, finalGUIs })}`);
		}
		console.log(`[live-scenario] GUI retained cleanup: instances=${finalGUIs.length}, deletedSources=3, deletedAsset=${assetPath}`);
	}

	// Complete standalone Animation/Animation Window authoring, runtime debugger,
	// curve editing, export/import, and exact MCP cleanup.
	if (has("--animation-completion")) {
		const baselineDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const baselineNames = new Set(JSON.parse(await call("list_animation_groups")).groups.map((group) => group.name));
		const suffix = `${Date.now()}-${process.pid}`;
		const scalarName = `MCP Scalar Animation ${suffix}`;
		const vectorName = `MCP Vector Animation ${suffix}`;
		const importedName = `MCP Imported Animation ${suffix}`;
		const exportPath = `assets/mcp-animation-${suffix}.animation`;
		let nodeId = null;
		const groupNames = new Set();
		restore = async () => {
			await call("stop_animation_group", {}).catch(() => undefined);
			for (const groupName of [...groupNames].reverse()) {
				await call("delete_animation_group", { name: groupName }).catch((error) => {
					if (!/not found/i.test(error.message)) throw error;
				});
			}
			groupNames.clear();
			await call("delete_asset", { path: exportPath, confirm: true }).catch(() => undefined);
			if (nodeId) {
				await call("delete_node", { nodeId }).catch((error) => {
					if (!/not found/i.test(error.message)) throw error;
				});
				nodeId = null;
			}
		};

		const node = JSON.parse(await call("create_primitive_mesh", { type: "box", name: `MCP Animation Fixture ${suffix}`, options: { size: 30 } }));
		nodeId = node.id;
		JSON.parse(
			await call("create_animation", {
				nodeId,
				name: scalarName,
				targetProperty: "rotation.y",
				framesPerSecond: 60,
				loopMode: "cycle",
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 30, value: 1 },
					{ frame: 60, value: 0 },
				],
			})
		);
		groupNames.add(scalarName);
		JSON.parse(
			await call("create_animation", {
				nodeId,
				name: vectorName,
				targetProperty: "position",
				framesPerSecond: 60,
				loopMode: "cycle",
				keys: [
					{ frame: 0, value: [0, 0, 0] },
					{ frame: 30, value: [100, 50, 0] },
					{ frame: 60, value: [0, 0, 0] },
				],
			})
		);
		groupNames.add(vectorName);

		const group = JSON.parse(await call("get_animation_group", { name: scalarName }));
		if (group.tracks.length !== 1 || group.tracks[0].property !== "rotation.y") throw new Error("Animation group serialization evidence is incomplete.");
		let events = JSON.parse(await call("list_animation_events", { name: scalarName }));
		events = JSON.parse(
			await call("set_animation_events", {
				name: scalarName,
				expectedRevision: events.targetRevision,
				events: [{ frame: 30, action: "log", parameter: "MCP animation event", onlyOnce: false }],
			})
		);
		if (events.targetRevision !== 1) throw new Error("Animation event revision did not advance.");
		let window = JSON.parse(await call("get_animation_window", { name: scalarName }));
		const edited = JSON.parse(
			await call("edit_animation_window_keys", {
				name: scalarName,
				expectedFingerprint: window.fingerprint,
				selection: [{ trackIndex: 0, frame: 30 }],
				operation: "setInterpolation",
				interpolation: "step",
			})
		);
		window = edited.window;
		const recorded = JSON.parse(
			await call("record_animation_window_properties", {
				name: scalarName,
				expectedFingerprint: window.fingerprint,
				frame: 15,
				entries: [{ targetTrackIndex: 0, property: "rotation.y", interpolation: "linear" }],
			})
		);
		window = recorded.window;
		const tangentMode = JSON.parse(
			await call("set_animation_window_tangent_modes", {
				name: scalarName,
				expectedFingerprint: window.fingerprint,
				selection: [{ trackIndex: 0, frame: 0, component: 0 }],
				mode: "linear",
			})
		);
		window = tangentMode.window;
		const opened = JSON.parse(await call("open_animation_window", { name: scalarName }));
		if (!opened.opened) throw new Error("Standalone Animation Window did not open.");

		JSON.parse(
			await call("set_animation_keys", {
				name: scalarName,
				trackIndex: 0,
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 30, value: 1 },
					{ frame: 60, value: 0 },
				],
			})
		);
		JSON.parse(
			await call("set_animation_curve_keys", {
				name: scalarName,
				trackIndex: 0,
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 30, value: 1 },
					{ frame: 60, value: 0 },
				],
			})
		);
		JSON.parse(await call("set_animation_curve_tangents", { name: scalarName, trackIndex: 0, keys: [{ frame: 30, inTangent: 0.1, outTangent: -0.1 }] }));
		JSON.parse(await call("auto_smooth_animation_curve_tangents", { name: scalarName, trackIndex: 0 }));
		const samples = JSON.parse(await call("sample_animation_curve", { name: scalarName, trackIndex: 0, from: 0, to: 60, samples: 7 }));
		if (samples.samples.length !== 7) throw new Error("Animation curve sampling did not return the requested page.");
		JSON.parse(
			await call("set_animation_curve_component_keys", {
				name: vectorName,
				trackIndex: 0,
				component: 1,
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 30, value: 75 },
					{ frame: 60, value: 0 },
				],
			})
		);

		const playing = JSON.parse(await call("play_animation_group", { name: scalarName, loop: true, speed: 1, from: 0, to: 60 }));
		if (!playing.playing) throw new Error("Animation preview did not start.");
		let runtime = JSON.parse(await call("get_animation_runtime_debug", { name: scalarName, trackLimit: 8, historyLimit: 16, eventLimit: 8 }));
		runtime = JSON.parse(
			await call("set_animation_runtime_debug", {
				name: scalarName,
				expectedFingerprint: runtime.fingerprint,
				paused: true,
				breakpoints: [{ id: "middle", frame: 30, enabled: true }],
				speedRatio: 1,
				loopAnimation: true,
			})
		);
		const stepped = JSON.parse(
			await call("step_animation_runtime_debug", { name: scalarName, expectedFingerprint: runtime.fingerprint, frameDelta: 1, steps: 2, trackLimit: 8, historyLimit: 16 })
		);
		if (stepped.status !== "paused") throw new Error(`Animation runtime debugger did not remain paused after stepping: ${JSON.stringify(stepped)}`);
		await call("stop_animation_group", { name: scalarName });

		const exported = JSON.parse(await call("export_animation_group", { name: scalarName, path: exportPath }));
		if (!exported.exported) throw new Error("Animation export did not complete.");
		const imported = JSON.parse(
			await call("import_animation_group", {
				path: exportPath,
				name: importedName,
				targetBindings: [{ kind: "node", sourceTarget: group.tracks[0].targetId, nodeId }],
			})
		);
		groupNames.add(importedName);
		if (imported.name !== importedName) throw new Error(`Animation import did not apply the requested name: ${JSON.stringify(imported)}`);

		await restore();
		restore = null;
		const finalDiagnostics = JSON.parse(await call("get_scene_diagnostics"));
		const finalGroups = JSON.parse(await call("list_animation_groups")).groups;
		if (finalDiagnostics.meshes !== baselineDiagnostics.meshes || finalGroups.some((candidate) => !baselineNames.has(candidate.name))) {
			throw new Error(`Animation completion cleanup mismatch: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, finalGroups })}`);
		}
		console.log(`[live-scenario] animation completion: runtime step, events, Window edits, scalar/vector curves, export/import, and exact cleanup verified`);
	}
} catch (error) {
	failures.push(error.message);
} finally {
	if (restore) {
		try {
			await restore();
		} catch {
			failures.push("could not undo a scenario mutation — inspect the project manually");
		}
	}
	child.kill();
}

if (failures.length) {
	console.error("[live-scenario] FAIL");
	failures.forEach((failure) => console.error(`  - ${failure}`));
	process.exit(1);
}
console.log("[live-scenario] PASS");
