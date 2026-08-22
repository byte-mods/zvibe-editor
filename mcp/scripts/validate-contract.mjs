#!/usr/bin/env node
/**
 * Real stdio validation of the published MCP tool contract.
 *
 * This is the executable form of the gate the parity/contract docs describe.
 * It launches the bundled server over real stdio, performs a real MCP
 * handshake, pages through the complete tool list, and asserts the contract
 * invariants that clients depend on:
 *
 *   1. Tool count matches the packaged manifest or an explicit baseline (guards silent loss/dupes).
 *   2. Every tool has a non-empty description.
 *   3. Every tool input schema is closed-world (`additionalProperties: false`),
 *      so unknown arguments cannot be silently ignored.
 *   4. Every tool publishes all four boolean safety annotations.
 *   5. No tool is BOTH read-only and destructive.
 *   6. A real call carrying an unknown field is rejected with MCP `-32602`
 *      before the editor is contacted. The SDK surfaces validation failures as
 *      an MCP tool error (`isError: true`) rather than a JSON-RPC top-level
 *      error, so both encodings are accepted.
 *   7. Every nested input schema uses client-compatible array `items` and
 *      boolean `additionalProperties`; the original Zod validators still
 *      reject invalid tuple lengths and typed-map values before editor I/O.
 *
 * Usage:
 *   yarn workspace babylonjs-editor-mcp-server validate
 *   node scripts/validate-contract.mjs --expect-tools 1350
 *
 * Exits non-zero with a precise reason on any violation.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server", "index.mjs");
const MANIFEST = join(HERE, "..", "manifest.json");

const argv = process.argv.slice(2);
const expectIndex = argv.indexOf("--expect-tools");
const packagedManifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const packagedTools = packagedManifest.server?.tools ?? packagedManifest.tools;
if (!Array.isArray(packagedTools)) {
	throw new Error("MCPB manifest does not contain a packaged tool catalog.");
}
const EXPECTED_TOOLS = expectIndex >= 0 ? Number(argv[expectIndex + 1]) : packagedTools.length;
if (!Number.isSafeInteger(EXPECTED_TOOLS) || EXPECTED_TOOLS < 1) {
	throw new Error("--expect-tools must be a positive safe integer.");
}
const REQUIRED_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

if (!existsSync(SERVER)) {
	console.error(`[validate-contract] bundled server missing at ${SERVER}\n` + `Run: yarn workspace babylonjs-editor-mcp-server bundle`);
	process.exit(2);
}

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdoutBuffer = "";
let stderrText = "";

child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk.toString();
	let newline;
	while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
		const line = stdoutBuffer.slice(0, newline).trim();
		stdoutBuffer = stdoutBuffer.slice(newline + 1);
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
child.stderr.on("data", (chunk) => {
	stderrText += chunk.toString();
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

const failures = [];
let toolCount = 0;

try {
	const init = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "validate-contract", version: "1.0.0" },
	});
	if (init.error) {
		throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
	}
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	let tools = [];
	let cursor;
	do {
		const page = await rpc("tools/list", cursor ? { cursor } : {});
		if (page.error) {
			throw new Error(`tools/list failed: ${JSON.stringify(page.error)}`);
		}
		tools = tools.concat(page.result.tools ?? []);
		cursor = page.result.nextCursor;
	} while (cursor);
	toolCount = tools.length;

	if (Number.isFinite(EXPECTED_TOOLS) && tools.length !== EXPECTED_TOOLS) {
		failures.push(`expected ${EXPECTED_TOOLS} tools, discovered ${tools.length}`);
	}

	const duplicates = tools.map((tool) => tool.name).filter((name, index, all) => all.indexOf(name) !== index);
	if (duplicates.length) {
		failures.push(`duplicate tool names: ${[...new Set(duplicates)].slice(0, 5).join(", ")}`);
	}

	const undescribed = tools.filter((tool) => !tool.description?.trim());
	if (undescribed.length) {
		failures.push(
			`${undescribed.length} tools without a description (e.g. ${undescribed
				.slice(0, 5)
				.map((t) => t.name)
				.join(", ")})`
		);
	}

	const openSchemas = tools.filter((tool) => tool.inputSchema?.type !== "object" || tool.inputSchema.additionalProperties !== false);
	if (openSchemas.length) {
		failures.push(
			`${openSchemas.length} tools with non-closed input schemas (e.g. ${openSchemas
				.slice(0, 5)
				.map((t) => t.name)
				.join(", ")})`
		);
	}

	const incompleteHints = tools.filter((tool) => REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean"));
	if (incompleteHints.length) {
		failures.push(
			`${incompleteHints.length} tools missing safety annotations (e.g. ${incompleteHints
				.slice(0, 5)
				.map((t) => t.name)
				.join(", ")})`
		);
	}

	const contradictory = tools.filter((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === true);
	if (contradictory.length) {
		failures.push(
			`${contradictory.length} tools marked both read-only and destructive (e.g. ${contradictory
				.slice(0, 5)
				.map((t) => t.name)
				.join(", ")})`
		);
	}

	const vfx65ToolNames = ["list_vfx_graph_templates", "create_vfx_graph_from_template", "get_node_particle_batch_release", "set_node_particle_batch_release"];
	for (const name of vfx65ToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean") || tool.inputSchema?.additionalProperties !== false) {
			failures.push(`${name} must publish a closed four-annotation contract`);
		}
	}
	for (const invalid of [
		{ name: "list_vfx_graph_templates", label: "unknown field", arguments: { unknown: true } },
		{ name: "list_vfx_graph_templates", label: "unknown category", arguments: { category: "Weather" } },
		{ name: "create_vfx_graph_from_template", label: "non-hash revision", arguments: { templateId: "starter-sprite", expectedCatalogRevision: "stale" } },
		{ name: "get_node_particle_batch_release", label: "unknown field", arguments: { nodeId: "node", unknown: true } },
		{ name: "set_node_particle_batch_release", label: "missing exact revision", arguments: { nodeId: "node", releaseOnDisable: true } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const developmentDiagnosticsToolNames = ["get_development_build_coverage", "get_project_serialization_session"];
	for (const name of developmentDiagnosticsToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}

	const webBuildEvidenceToolNames = ["inspect_web_build_plan", "verify_web_build_output"];
	for (const name of webBuildEvidenceToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}
	for (const invalid of [
		{ name: "inspect_web_build_plan", label: "missing exact revision", arguments: { id: "web" } },
		{ name: "inspect_web_build_plan", label: "unknown field", arguments: { expectedRevision: 0, id: "web", unknown: true } },
		{ name: "verify_web_build_output", label: "short plan fingerprint", arguments: { expectedRevision: 0, id: "web", expectedPlanFingerprint: "stale" } },
		{ name: "verify_web_build_output", label: "missing profile id", arguments: { expectedRevision: 0, expectedPlanFingerprint: "0".repeat(64) } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}
	for (const invalid of [
		{ name: "get_development_build_coverage", label: "unknown field", arguments: { id: "desktop", unknown: true } },
		{ name: "get_development_build_coverage", label: "source traversal", arguments: { id: "desktop", path: "src/../secret.ts" } },
		{ name: "get_development_build_coverage", label: "oversized page", arguments: { id: "desktop", limit: 10_001 } },
		{ name: "get_project_serialization_session", label: "negative offset", arguments: { offset: -1 } },
		{ name: "get_project_serialization_session", label: "unknown field", arguments: { unknown: true } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const twoDProfiler = tools.find((tool) => tool.name === "get_2d_profiler_state");
	if (!twoDProfiler) {
		failures.push("get_2d_profiler_state is missing");
	} else {
		if (!twoDProfiler.annotations?.readOnlyHint || twoDProfiler.annotations?.destructiveHint || twoDProfiler.annotations?.openWorldHint) {
			failures.push("get_2d_profiler_state must publish a closed read-only safety contract");
		}
		for (const probe of [{ unknown: true }, { frameIndex: 0 }, { captureId: "capture", frameIndex: -1 }]) {
			const response = await rpc("tools/call", { name: "get_2d_profiler_state", arguments: probe });
			const encoded = JSON.stringify(response);
			const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
			if (!rejected) failures.push(`get_2d_profiler_state accepted invalid schema probe ${JSON.stringify(probe)}`);
		}
	}

	const cinematicToolNames = [
		"list_cinematics",
		"get_cinematic_capabilities",
		"inspect_cinematic_audio_capture_plan",
		"get_cinematic",
		"create_cinematic",
		"fork_cinematic",
		"delete_cinematic",
		"replace_cinematic",
		"set_cinematic_settings",
		"create_cinematic_track",
		"set_cinematic_track",
		"move_cinematic_track",
		"delete_cinematic_track",
		"create_cinematic_clip",
		"set_cinematic_clip",
		"delete_cinematic_clip",
		"create_cinematic_key",
		"set_cinematic_key",
		"delete_cinematic_key",
		"create_cinematic_marker",
		"set_cinematic_marker",
		"delete_cinematic_marker",
		"create_cinematic_recorder_profile",
		"set_cinematic_recorder_profile",
		"delete_cinematic_recorder_profile",
		"validate_cinematic",
		"get_cinematic_preview",
		"control_cinematic_preview",
		"play_cinematic",
		"start_cinematic_capture",
		"get_cinematic_capture",
		"cancel_cinematic_capture",
	];
	for (const name of cinematicToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	for (const name of [
		"list_cinematics",
		"get_cinematic_capabilities",
		"inspect_cinematic_audio_capture_plan",
		"get_cinematic",
		"validate_cinematic",
		"get_cinematic_preview",
		"get_cinematic_capture",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}
	for (const name of [
		"delete_cinematic",
		"replace_cinematic",
		"delete_cinematic_track",
		"delete_cinematic_clip",
		"delete_cinematic_key",
		"delete_cinematic_marker",
		"delete_cinematic_recorder_profile",
		"start_cinematic_capture",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed destructive mutation contract`);
		}
	}
	const invalidCinematicCalls = [
		{ name: "get_cinematic_capabilities", arguments: { unknown: true } },
		{ name: "create_cinematic", arguments: { path: "../outside.cinematic" } },
		{ name: "set_cinematic_settings", arguments: { path: "assets/intro.cinematic", expectedRevision: 1, changes: { name: "Missing fingerprint" } } },
		{ name: "delete_cinematic", arguments: { path: "assets/intro.cinematic", expectedRevision: 1, expectedFingerprint: "0".repeat(16), confirm: false } },
		{
			name: "create_cinematic_marker",
			arguments: {
				path: "assets/intro.cinematic",
				expectedRevision: 1,
				expectedFingerprint: "0".repeat(16),
				trackId: "signals",
				marker: { id: "mark", name: "Mark", type: "signal", frame: 0, emitOnce: false, retroactive: false, payload: null, unknown: true },
			},
		},
		{ name: "control_cinematic_preview", arguments: { action: "pause", path: "assets/intro.cinematic" } },
		{
			name: "start_cinematic_capture",
			arguments: {
				path: "assets/intro.cinematic",
				expectedRevision: 1,
				expectedFingerprint: "0".repeat(16),
				profileId: "capture",
				destination: "captures/intro.webm",
				overwrite: false,
			},
		},
	];
	for (const invalid of invalidCinematicCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		if (!(response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602")))) {
			failures.push(`${invalid.name} accepted an invalid cinematic schema probe`);
		}
	}

	const videoToolNames = [
		"get_video_importer_capabilities",
		"get_video_platform_overrides",
		"set_video_platform_overrides",
		"get_video_importer_result",
		"apply_video_importer",
		"list_video_players",
		"create_video_player",
		"set_video_player",
		"control_video_player",
		"delete_video_player",
	];
	for (const name of videoToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	for (const name of ["get_video_importer_capabilities", "get_video_platform_overrides", "get_video_importer_result", "list_video_players"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint)) {
			failures.push(`${name} must publish a read-only safety contract`);
		}
	}
	const deleteVideoPlayer = tools.find((tool) => tool.name === "delete_video_player");
	if (deleteVideoPlayer && (deleteVideoPlayer.annotations?.readOnlyHint || !deleteVideoPlayer.annotations?.destructiveHint || deleteVideoPlayer.annotations?.openWorldHint)) {
		failures.push("delete_video_player must publish a closed destructive mutation contract");
	}
	const videoTrackSchema = tools.find((tool) => tool.name === "create_cinematic_track")?.inputSchema?.properties?.track;
	if (!JSON.stringify(videoTrackSchema).includes('"video"')) failures.push("create_cinematic_track is missing the Video track contract");
	const invalidVideoCalls = [
		{ name: "get_video_importer_capabilities", label: "unknown capability field", arguments: { unknown: true } },
		{
			name: "set_video_platform_overrides",
			label: "odd platform dimension",
			arguments: { path: "assets/probe.mp4", expectedFingerprint: "0".repeat(64), overrides: { web: { enabled: true, maxWidth: 1919 } } },
		},
		{ name: "apply_video_importer", label: "false confirmation", arguments: { path: "assets/probe.mp4", expectedFingerprint: "0".repeat(64), confirm: false } },
		{ name: "create_video_player", label: "material target without material", arguments: { name: "Probe", path: "assets/probe.mp4" } },
		{ name: "control_video_player", label: "seek without time", arguments: { name: "Probe", action: "seek" } },
		{
			name: "create_cinematic_clip",
			label: "reverse Video clip",
			arguments: {
				path: "assets/intro.cinematic",
				expectedRevision: 1,
				expectedFingerprint: "0".repeat(16),
				trackId: "video-track",
				clip: {
					id: "video-clip",
					name: "Video",
					type: "video",
					startFrame: 0,
					durationFrames: 30,
					clipInFrame: 0,
					timeScale: -1,
					enabled: true,
					blendInFrames: 0,
					blendOutFrames: 0,
					easeIn: "linear",
					easeOut: "linear",
					preExtrapolation: "none",
					postExtrapolation: "none",
					videoPlayerId: "player",
					volume: 1,
					loop: false,
					muteAudio: false,
				},
			},
		},
	];
	for (const invalid of invalidVideoCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const spriteSkinToolNames = [
		"list_sprite_skins",
		"get_sprite_skin",
		"open_sprite_skinning_workspace",
		"create_sprite_skin",
		"replace_sprite_skin_bones",
		"inspect_psd_sprite_skin_rig",
		"apply_psd_sprite_skin_rig",
		"create_sprite_skin_animation_clip",
	];
	for (const name of spriteSkinToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	for (const name of ["list_sprite_skins", "get_sprite_skin", "inspect_psd_sprite_skin_rig"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}
	const replaceSpriteSkinBones = tools.find((tool) => tool.name === "replace_sprite_skin_bones");
	if (
		replaceSpriteSkinBones &&
		(replaceSpriteSkinBones.annotations?.readOnlyHint || !replaceSpriteSkinBones.annotations?.destructiveHint || replaceSpriteSkinBones.annotations?.openWorldHint)
	) {
		failures.push("replace_sprite_skin_bones must publish a closed destructive mutation contract");
	}
	const invalidSpriteSkinCalls = [
		{ name: "get_sprite_skin", label: "missing identity", arguments: {} },
		{ name: "create_sprite_skin", label: "oversized deformation grid", arguments: { documentWidthPixels: 64, documentHeightPixels: 64, columns: 65 } },
		{
			name: "replace_sprite_skin_bones",
			label: "invalid fingerprint",
			arguments: { nodeId: "sprite", expectedRevision: 1, expectedFingerprint: "short", bones: [] },
		},
		{ name: "inspect_psd_sprite_skin_rig", label: "duplicate layer filter", arguments: { sourcePath: "assets/hero.psd", layerIndices: [1, 1] } },
		{ name: "apply_psd_sprite_skin_rig", label: "invalid plan lease", arguments: { sourcePath: "assets/hero.psd", expectedFingerprint: "short" } },
		{
			name: "create_sprite_skin_animation_clip",
			label: "rotation key with vector value",
			arguments: {
				nodeId: "sprite",
				expectedRevision: 1,
				expectedFingerprint: "0".repeat(64),
				name: "Probe",
				tracks: [{ boneName: "Root", property: "rotation", keys: [{ frame: 0, value: [0, 0] }] }],
			},
		},
	];
	for (const invalid of invalidSpriteSkinCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const collaborationAuditToolNames = ["get_project_collaboration_capabilities", "validate_project_collaboration_readiness"];
	for (const name of collaborationAuditToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
			continue;
		}
		if (
			tool.annotations?.readOnlyHint !== true ||
			tool.annotations?.destructiveHint !== false ||
			tool.annotations?.idempotentHint !== true ||
			tool.annotations?.openWorldHint !== false
		) {
			failures.push(`${name} must publish the complete read-only safety contract`);
		}
		const response = await rpc("tools/call", { name, arguments: { unknown: true } });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${name} accepted an unknown field`);
		}
	}

	const projectServiceToolNames = [
		"get_project_services_capabilities",
		"get_project_services_configuration",
		"set_project_service_environment",
		"set_active_project_service_environment",
		"delete_project_service_environment",
		"set_project_service_category",
		"set_project_service_resources",
		"validate_project_services_readiness",
		"plan_project_services_deployment",
		"deploy_project_services",
		"cancel_project_services_deployment",
		"list_project_services_deployment_reports",
		"get_project_services_deployment_report",
		"delete_project_services_deployment_report",
		"start_project_services_emulator",
		"stop_project_services_emulator",
		"get_project_services_emulator_status",
		"get_project_services_emulator_events",
		"reset_project_services_emulator",
	];
	for (const name of projectServiceToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	const expectedProjectServiceCategories = ["auth", "cloudSave", "analytics", "iap", "ads", "matchmaking", "leaderboards", "remoteConfig", "contentDelivery", "cloudFunctions"];
	const projectServiceCategoryTool = tools.find((tool) => tool.name === "set_project_service_category");
	if (JSON.stringify(projectServiceCategoryTool?.inputSchema?.properties?.category?.enum) !== JSON.stringify(expectedProjectServiceCategories)) {
		failures.push("set_project_service_category does not expose the complete ordered ten-category contract");
	}
	const expectedProjectServiceResources = [
		"analyticsEvents",
		"iapProducts",
		"adPlacements",
		"matchmakingQueues",
		"leaderboards",
		"remoteConfig",
		"contentDeliveryBuckets",
		"cloudFunctions",
	];
	const projectServiceResourcesTool = tools.find((tool) => tool.name === "set_project_service_resources");
	const projectServiceResourceProperties = projectServiceResourcesTool?.inputSchema?.properties?.resources?.properties ?? {};
	if (expectedProjectServiceResources.some((resource) => !(resource in projectServiceResourceProperties))) {
		failures.push("set_project_service_resources does not expose all eight hosted-service resource catalogs");
	}
	for (const name of [
		"get_project_services_capabilities",
		"get_project_services_configuration",
		"validate_project_services_readiness",
		"list_project_services_deployment_reports",
		"get_project_services_emulator_status",
		"get_project_services_emulator_events",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}
	for (const name of ["delete_project_service_environment", "deploy_project_services", "delete_project_services_deployment_report", "reset_project_services_emulator"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint)) failures.push(`${name} must publish a destructive mutation contract`);
	}
	const invalidProjectServiceCalls = [
		{
			name: "set_project_service_category",
			arguments: {
				expectedRevision: 0,
				environmentId: "development",
				category: "auth",
				settings: { enabled: true, provider: "rest", endpoint: "https://example.test", options: { accessToken: "secret" } },
			},
		},
		{
			name: "set_project_service_resources",
			arguments: {
				expectedRevision: 0,
				environmentId: "development",
				resources: { analyticsEvents: [], iapProducts: [], adPlacements: [{ id: "reward", type: "rewarded", reward: null }], matchmakingQueues: [] },
			},
		},
		{ name: "start_project_services_emulator", arguments: { expectedRevision: 0, port: 80 } },
		{ name: "deploy_project_services", arguments: { planId: "00000000-0000-4000-8000-000000000000", expectedFingerprint: "0".repeat(64), confirm: false } },
		{ name: "reset_project_services_emulator", arguments: { confirm: false } },
	];
	for (const invalid of invalidProjectServiceCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		if (!(response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"))))
			failures.push(`${invalid.name} accepted an invalid services schema probe`);
	}

	const networkingToolNames = [
		"get_networking_capabilities",
		"get_networking_configuration",
		"set_networking_configuration",
		"validate_networking_target",
		"start_gameplay_session_host",
		"stop_gameplay_session_host",
		"get_gameplay_session_host_status",
		"create_gameplay_session",
		"list_gameplay_sessions",
		"get_gameplay_session",
		"set_gameplay_session",
		"delete_gameplay_session",
		"connect_networking_runtime",
		"disconnect_networking_runtime",
		"get_networking_runtime",
		"set_networking_ownership",
		"submit_networking_input",
		"send_networking_rpc",
		"clear_networking_evidence",
		"start_multiplayer_play_mode",
		"get_multiplayer_play_mode",
		"control_multiplayer_play_mode",
		"stop_multiplayer_play_mode",
	];
	for (const name of networkingToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	const setGameplaySessionSchema = tools.find((tool) => tool.name === "set_gameplay_session")?.inputSchema;
	if (!setGameplaySessionSchema?.properties?.changes?.properties?.name) {
		failures.push("set_gameplay_session is missing changes.name schema coverage");
	}
	for (const name of [
		"get_networking_capabilities",
		"get_networking_configuration",
		"validate_networking_target",
		"get_gameplay_session_host_status",
		"list_gameplay_sessions",
		"get_gameplay_session",
		"get_networking_runtime",
		"get_multiplayer_play_mode",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}
	for (const name of ["stop_gameplay_session_host", "delete_gameplay_session", "disconnect_networking_runtime", "control_multiplayer_play_mode", "stop_multiplayer_play_mode"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || !tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish an open-world destructive networking contract`);
		}
	}
	const invalidNetworkingCalls = [
		{ name: "get_networking_capabilities", label: "unknown root field", arguments: { unknown: true } },
		{
			name: "add_game_object_component",
			label: "malformed Network Replication data",
			arguments: { nodeId: "player", expectedFingerprint: "0".repeat(64), type: "network", data: { networkId: "bad id", credential: "secret" } },
		},
		{ name: "set_networking_configuration", label: "empty changes", arguments: { expectedRevision: 1, changes: {} } },
		{
			name: "set_networking_configuration",
			label: "credential-bearing endpoint",
			arguments: { expectedRevision: 1, changes: { transport: { endpoint: "wss://user:secret@example.test/game" } } },
		},
		{ name: "start_gameplay_session_host", label: "privileged port", arguments: { port: 443 } },
		{ name: "stop_gameplay_session_host", label: "false confirmation", arguments: { confirm: false } },
		{ name: "delete_gameplay_session", label: "missing exact lease", arguments: { sessionId: "00000000-0000-4000-8000-000000000000", confirm: true } },
		{ name: "submit_networking_input", label: "wrong vector tuple", arguments: { networkId: "player", translation: [1, 2], rotationDegrees: [0, 0, 0] } },
		{ name: "send_networking_rpc", label: "owner RPC without object", arguments: { name: "damage", target: "owner", payload: null } },
		{
			name: "start_multiplayer_play_mode",
			label: "too many players",
			arguments: { expectedRevision: 1, playerCount: 5 },
		},
		{
			name: "control_multiplayer_play_mode",
			label: "incomplete input command",
			arguments: { expectedRunRevision: 1, command: "input", playerIndex: 1, networkId: "player" },
		},
	];
	for (const invalid of invalidNetworkingCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const mobileToolNames = [
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
	for (const name of mobileToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	for (const name of [
		"get_mobile_capabilities",
		"get_touch_controls_configuration",
		"validate_touch_controls",
		"get_touch_controls_runtime",
		"get_mobile_deployment_configuration",
		"get_mobile_workflow_plan",
		"get_mobile_job",
		"list_mobile_jobs",
		"list_mobile_artifacts",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}
	for (const name of ["validate_mobile_target", "list_mobile_devices"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || !tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish an open-world diagnostic-read contract`);
		}
	}
	for (const name of ["execute_mobile_workflow_plan", "cancel_mobile_job"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.idempotentHint || !tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish an open-world destructive Mobile contract`);
		}
	}
	const mobileControlRectSchema = tools.find((tool) => tool.name === "create_touch_control")?.inputSchema?.properties?.control?.properties?.rect;
	if (!mobileControlRectSchema || mobileControlRectSchema.additionalProperties !== false) {
		failures.push("create_touch_control is missing nested-closed normalized rect coverage");
	}
	const invalidMobileCalls = [
		{ name: "get_mobile_capabilities", label: "unknown root field", arguments: { unknown: true } },
		{ name: "set_touch_controls_configuration", label: "empty changes", arguments: { expectedRevision: 1, changes: {} } },
		{ name: "create_touch_control", label: "malformed touch path", arguments: { expectedRevision: 1, control: { type: "button", controlPath: "keyboard/jump" } } },
		{ name: "set_touch_control", label: "surplus control field", arguments: { expectedRevision: 1, id: "jump", changes: { script: "secret" } } },
		{ name: "delete_touch_control", label: "false confirmation", arguments: { expectedRevision: 1, id: "jump", confirm: false } },
		{ name: "simulate_touch_control", label: "wrong stick tuple", arguments: { id: "move", phase: "move", value: [1] } },
		{
			name: "set_mobile_deployment_configuration",
			label: "raw signing secret",
			arguments: { expectedRevision: 1, changes: { android: { signing: { enabled: true, keystorePassword: "raw-secret" } } } },
		},
		{
			name: "plan_mobile_workflow",
			label: "launch with artifact",
			arguments: { target: "android", operation: "launch", expectedRevision: 1, expectedScaffoldRevision: 1, deviceId: "emulator-5554", artifactPath: "build/game.apk" },
		},
		{
			name: "plan_mobile_workflow",
			label: "logs without bounded duration",
			arguments: { target: "android", operation: "logs", expectedRevision: 1, expectedScaffoldRevision: 1, deviceId: "emulator-5554" },
		},
		{
			name: "plan_mobile_workflow",
			label: "artifact traversal",
			arguments: { target: "android", operation: "install", expectedRevision: 1, expectedScaffoldRevision: 1, deviceId: "emulator-5554", artifactPath: "../outside.apk" },
		},
		{ name: "execute_mobile_workflow_plan", label: "false confirmation", arguments: { planId: `mobile-plan-${"0".repeat(24)}`, confirm: false } },
		{ name: "list_mobile_devices", label: "unsupported target", arguments: { target: "windows" } },
	];
	for (const invalid of invalidMobileCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const xrToolNames = [
		"get_xr_capabilities",
		"get_xr_configuration",
		"set_xr_configuration",
		"create_xr_interactable",
		"set_xr_interactable",
		"delete_xr_interactable",
		"validate_xr_target",
		"get_xr_runtime",
		"initialize_xr_runtime",
		"reconfigure_xr_runtime",
		"enter_xr_session",
		"exit_xr_session",
		"get_xr_simulation",
		"start_xr_simulation",
		"simulate_xr_input",
		"stop_xr_simulation",
	];
	for (const name of xrToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	for (const name of ["get_xr_capabilities", "get_xr_configuration", "validate_xr_target", "get_xr_runtime", "get_xr_simulation"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}
	for (const name of ["delete_xr_interactable", "reconfigure_xr_runtime"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed destructive mutation contract`);
		}
	}
	const xrConfigurationSchema = tools.find((tool) => tool.name === "set_xr_configuration")?.inputSchema;
	for (const path of [
		["changes", "session", "requiredFeatures"],
		["changes", "origin", "originNodeId"],
		["changes", "interaction", "gazeSelectionTimeMs"],
		["changes", "locomotion", "snapPoints"],
		["changes", "simulation", "rightController"],
	]) {
		let schema = xrConfigurationSchema;
		for (const segment of path) schema = schema?.properties?.[segment];
		if (!schema) failures.push(`set_xr_configuration is missing complete ${path.join(".")} schema coverage`);
	}
	const invalidXRCalls = [
		{ name: "set_xr_configuration", label: "revision zero", arguments: { expectedRevision: 0, changes: { enabled: true } } },
		{ name: "set_xr_configuration", label: "unknown nested session field", arguments: { expectedRevision: 1, changes: { session: { token: "secret" } } } },
		{
			name: "set_xr_configuration",
			label: "overlapping native features",
			arguments: { expectedRevision: 1, changes: { session: { requiredFeatures: ["hand-tracking"], optionalFeatures: ["hand-tracking"] } } },
		},
		{ name: "create_xr_interactable", label: "empty interaction modes", arguments: { expectedRevision: 1, interactable: { name: "Box", meshId: "box", modes: [] } } },
		{ name: "delete_xr_interactable", label: "false confirmation", arguments: { expectedRevision: 1, id: "box", confirm: false } },
		{ name: "simulate_xr_input", label: "headset button press", arguments: { expectedRevision: 1, input: { type: "press-select", device: "headset" } } },
		{ name: "simulate_xr_input", label: "empty set-pose", arguments: { expectedRevision: 1, input: { type: "set-pose", device: "right" } } },
		{ name: "simulate_xr_input", label: "wrong pose tuple length", arguments: { expectedRevision: 1, input: { type: "set-pose", device: "right", position: [0, 1] } } },
	];
	for (const invalid of invalidXRCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		if (!(response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602")))) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const ecsToolNames = [
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
	for (const name of ecsToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	for (const name of ["inspect_ecs", "validate_ecs", "query_ecs_entities", "inspect_ecs_schedule"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only safety contract`);
		}
	}
	for (const name of [
		"replace_ecs_configuration",
		"delete_ecs_configuration",
		"delete_ecs_component_type",
		"delete_ecs_field",
		"delete_ecs_system",
		"delete_ecs_section",
		"step_ecs_runtime",
		"queue_ecs_runtime_command",
		"playback_ecs_runtime_commands",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed destructive mutation contract`);
		}
	}
	const invalidECSCalls = [
		{ name: "inspect_ecs", label: "unknown read field", arguments: { unknown: true } },
		{ name: "set_ecs_settings", label: "empty settings update", arguments: { expectedRevision: 0, expectedFingerprint: "0".repeat(16), settings: {} } },
		{
			name: "create_ecs_field",
			label: "wrong vector lane count",
			arguments: {
				expectedRevision: 0,
				expectedFingerprint: "0".repeat(16),
				componentId: "motion",
				field: { id: "velocity", name: "Velocity", type: "vec3", defaultValue: [0, 0, 0, 0, 0] },
			},
		},
		{
			name: "create_ecs_system",
			label: "integrate operation without source",
			arguments: {
				expectedRevision: 0,
				expectedFingerprint: "0".repeat(16),
				system: {
					name: "Move",
					operations: [{ id: "move", kind: "integrate", target: { componentId: "motion", fieldId: "position" }, useDeltaTime: true }],
				},
			},
		},
		{ name: "delete_ecs_system", label: "false confirmation", arguments: { expectedRevision: 0, expectedFingerprint: "0".repeat(16), systemId: "move", confirm: false } },
		{ name: "delete_ecs_configuration", label: "false confirmation", arguments: { expectedRevision: 0, expectedFingerprint: "0".repeat(16), confirm: false } },
		{ name: "query_ecs_entities", label: "duplicate query ids", arguments: { all: ["motion", "motion"] } },
		{
			name: "queue_ecs_runtime_command",
			label: "runtime destroy without confirmation",
			arguments: { expectedGeneration: 1, command: { kind: "destroy-entity", entityId: "entity" } },
		},
		{ name: "bake_ecs", label: "invalid source fingerprint", arguments: { expectedRevision: 0, expectedFingerprint: "0".repeat(16), expectedSourceHashes: { entity: "bad" } } },
	];
	for (const invalid of invalidECSCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		if (!(response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602")))) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const scriptWorkflowToolNames = [
		"get_custom_script_template",
		"delete_custom_script_template",
		"get_script_debugger_capabilities",
		"prepare_script_debugger",
		"get_script_debugger",
		"set_script_breakpoints",
		"control_script_debugger",
		"get_script_source_coverage",
		"set_script_source_coverage",
		"export_script_source_coverage",
	];
	for (const name of scriptWorkflowToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
			continue;
		}
		if (REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean")) failures.push(`${name} must publish all four safety annotations`);
	}
	for (const name of ["get_custom_script_template", "get_script_debugger_capabilities", "get_script_debugger", "get_script_source_coverage"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint))
			failures.push(`${name} must publish the closed read-only contract`);
	}
	const deleteCustomTemplate = tools.find((candidate) => candidate.name === "delete_custom_script_template");
	if (
		deleteCustomTemplate &&
		(deleteCustomTemplate.annotations?.readOnlyHint || !deleteCustomTemplate.annotations?.destructiveHint || deleteCustomTemplate.annotations?.openWorldHint)
	)
		failures.push("delete_custom_script_template must publish the closed destructive contract");
	const invalidScriptWorkflowCalls = [
		{ name: "get_script_debugger_capabilities", label: "unknown root field", arguments: { unknown: true } },
		{
			name: "set_script_breakpoints",
			label: "non-boolean nested breakpoint enabled",
			arguments: {
				expectedManifestFingerprint: "0".repeat(64),
				expectedConfigurationRevision: 1,
				breakpoints: [{ path: "src/player.ts", line: 1, enabled: "yes" }],
			},
		},
		{
			name: "export_script_source_coverage",
			label: "output path outside report storage",
			arguments: {
				expectedManifestFingerprint: "0".repeat(64),
				expectedConfigurationRevision: 1,
				expectedCoverageRevision: 0,
				format: "json",
				path: "coverage.json",
			},
		},
		{ name: "delete_custom_script_template", label: "missing true confirmation", arguments: { id: "probe", expectedFingerprint: "0".repeat(64), confirm: false } },
	];
	for (const invalid of invalidScriptWorkflowCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		if (!(response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602")))) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const guiInteractionToolNames = [
		"get_gui_interaction_capabilities",
		"get_gui_canvas_group",
		"set_gui_canvas_group",
		"list_gui_raycast_receivers",
		"set_gui_raycast_receiver",
		"get_gui_usage_tracking",
		"set_gui_usage_tracking",
		"reset_gui_usage_tracking",
		"get_inspector_collection_capabilities",
	];
	for (const name of guiInteractionToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (tool.annotations?.openWorldHint !== false || typeof tool.annotations?.idempotentHint !== "boolean") {
			failures.push(`${name} must publish the complete closed safety contract`);
		}
	}
	for (const name of [
		"get_gui_interaction_capabilities",
		"get_gui_canvas_group",
		"list_gui_raycast_receivers",
		"get_gui_usage_tracking",
		"get_inspector_collection_capabilities",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint !== false)) {
			failures.push(`${name} must publish the closed read-only contract`);
		}
	}
	const invalidGUIInteractionCalls = [
		{ name: "get_gui_interaction_capabilities", label: "unknown root field", arguments: { unknown: true } },
		{
			name: "set_gui_canvas_group",
			label: "alpha outside the inclusive range",
			arguments: {
				guiId: "probe",
				expectedRevision: 0,
				controlId: "group",
				assignment: { alpha: 1.01, interactable: true, blocksRaycasts: true, ignoreParentGroups: false },
			},
		},
		{
			name: "set_gui_usage_tracking",
			label: "unbounded recent-event retention",
			arguments: { guiId: "probe", expectedRevision: 0, settings: { enabled: true, maxRecentEvents: 2049 } },
		},
		{
			name: "list_gui_raycast_receivers",
			label: "oversized result page",
			arguments: { guiId: "probe", offset: 0, limit: 201 },
		},
		{
			name: "set_script_exported_value",
			label: "unsafe exported-field key",
			arguments: { nodeId: "probe", path: "src/probe.ts", key: "__proto__", value: [] },
		},
	];
	for (const invalid of invalidGUIInteractionCalls) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		if (!(response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602")))) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const findClientIncompatibleSchemaNodes = (value, path = "inputSchema", result = []) => {
		if (!value || typeof value !== "object") {
			return result;
		}
		if (Array.isArray(value)) {
			value.forEach((entry, index) => findClientIncompatibleSchemaNodes(entry, `${path}[${index}]`, result));
			return result;
		}
		if (Array.isArray(value.items)) {
			result.push(`${path}.items uses a tuple array`);
		}
		if (value.additionalProperties && typeof value.additionalProperties === "object") {
			result.push(`${path}.additionalProperties uses a schema map`);
		}
		for (const [key, entry] of Object.entries(value)) {
			findClientIncompatibleSchemaNodes(entry, `${path}.${key}`, result);
		}
		return result;
	};
	for (const tool of tools) {
		const incompatibleNodes = findClientIncompatibleSchemaNodes(tool.inputSchema);
		if (incompatibleNodes.length) {
			failures.push(`${tool.name} is not Codex CLI compatible: ${incompatibleNodes.slice(0, 3).join(", ")}`);
		}
	}

	// Unknown-field rejection must happen before the editor is contacted, so a
	// read-only tool is a safe probe even with no editor running.
	const probe = tools.find((tool) => tool.name === "list_scenes") ?? tools.find((tool) => tool.annotations?.readOnlyHint === true);
	if (!probe) {
		failures.push("no read-only tool available to probe unknown-field rejection");
	} else {
		const response = await rpc("tools/call", { name: probe.name, arguments: { __unknown_contract_probe__: 1 } });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602") && /nrecognized/i.test(encoded));
		if (!rejected) {
			failures.push(`${probe.name} did not reject an unknown field with -32602`);
		}
	}

	const projectPackageToolNames = [
		"list_project_packages",
		"get_project_package_manager",
		"list_project_package_registries",
		"search_project_package_registry",
		"get_project_package_details",
		"plan_project_package_registry_change",
		"apply_project_package_registry_plan",
		"get_project_package_dependency_graph",
		"get_project_package_updates",
		"plan_project_package_changes",
		"apply_project_package_plan",
		"cancel_project_package_operation",
		"list_project_package_samples",
		"plan_project_package_sample_import",
		"apply_project_package_sample_import",
		"modify_project_package",
	];
	for (const name of projectPackageToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	for (const name of ["plan_project_package_registry_change", "plan_project_package_changes", "plan_project_package_sample_import"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint !== false)) {
			failures.push(`${name} must describe a non-mutating plan`);
		}
	}
	for (const name of ["apply_project_package_registry_plan", "apply_project_package_plan", "apply_project_package_sample_import", "modify_project_package"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint !== false || tool.annotations?.destructiveHint !== true)) {
			failures.push(`${name} must describe a confirmed destructive mutation`);
		}
	}
	const invalidProjectPackageCalls = [
		{
			name: "plan_project_package_changes",
			label: "registry semver range instead of an exact version",
			arguments: {
				expectedFingerprint: "0".repeat(64),
				changes: [{ operation: "install", name: "schema-probe", version: "^1.0.0", source: { type: "registry" } }],
			},
		},
		{
			name: "plan_project_package_changes",
			label: "unknown nested source field",
			arguments: {
				expectedFingerprint: "0".repeat(64),
				changes: [{ operation: "install", name: "schema-probe", version: "1.0.0", source: { type: "registry", token: "secret" } }],
			},
		},
		{
			name: "plan_project_package_changes",
			label: "tarball source without exactly one path or URL",
			arguments: {
				expectedFingerprint: "0".repeat(64),
				changes: [{ operation: "install", name: "schema-probe", source: { type: "tarball" } }],
			},
		},
		{
			name: "apply_project_package_plan",
			label: "false mutation confirmation",
			arguments: { planId: "00000000-0000-4000-8000-000000000000", expectedFingerprint: "0".repeat(64), confirm: false },
		},
	];
	for (const invalid of invalidProjectPackageCalls) {
		if (!tools.some((tool) => tool.name === invalid.name)) {
			continue;
		}
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const texturePlatformTool = tools.find((tool) => tool.name === "set_texture_platform_overrides");
	if (!texturePlatformTool) {
		failures.push("set_texture_platform_overrides is missing");
	} else {
		const outputFormatSchema = texturePlatformTool.inputSchema?.properties?.overrides?.properties?.web?.properties?.outputFormat;
		if (JSON.stringify(outputFormatSchema?.enum) !== JSON.stringify(["automatic", "png", "jpeg", "webp"])) {
			failures.push("set_texture_platform_overrides does not expose the complete portable outputFormat enum");
		}
		for (const invalid of [
			{ label: "unknown nested override field", override: { enabled: true, unknown: true } },
			{ label: "unsupported output format", override: { enabled: true, outputFormat: "tiff" } },
		]) {
			const response = await rpc("tools/call", {
				name: texturePlatformTool.name,
				arguments: { path: "assets/schema-probe.png", expectedFingerprint: "0".repeat(64), overrides: { web: invalid.override } },
			});
			const encoded = JSON.stringify(response);
			const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
			if (!rejected) {
				failures.push(`set_texture_platform_overrides accepted ${invalid.label}`);
			}
		}
	}

	const physics2DToolNames = [
		"get_physics2d_settings",
		"set_physics2d_settings",
		"create_physics2d_world",
		"set_physics2d_world",
		"delete_physics2d_world",
		"get_physics2d_debug_rendering",
		"list_physics2d_materials",
		"create_physics2d_material",
		"set_physics2d_material",
		"delete_physics2d_material",
		"list_physics2d_bodies",
		"set_physics2d_body",
		"remove_physics2d_body",
		"get_physics2d_polygon_collider",
		"set_physics2d_polygon_collider",
		"generate_physics2d_polygon_collider",
		"list_physics2d_joints",
		"create_physics2d_joint",
		"set_physics2d_joint",
		"delete_physics2d_joint",
		"list_physics2d_effectors",
		"create_physics2d_effector",
		"set_physics2d_effector",
		"delete_physics2d_effector",
		"apply_physics2d_force",
		"apply_physics2d_torque",
		"set_physics2d_runtime_velocity",
	];
	for (const name of physics2DToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	for (const [name, properties] of Object.entries({
		set_physics2d_body: [
			"expectedRevision",
			"worldId",
			"worldDrawing",
			"bodyType",
			"collider",
			"angularVelocity",
			"mass",
			"inertia",
			"centerOfMass",
			"collisionDetection",
			"layerOverrides",
		],
		create_physics2d_world: ["id", "expectedRevision", "transformPlane", "transformWriteMode", "contactFilterMode", "debugCameraIds"],
		set_physics2d_world: ["id", "expectedRevision", "worldDrawing", "alwaysDraw", "syncInterpolation", "tweenDurationSeconds"],
		get_physics2d_debug_rendering: ["cameraIds", "releaseBuild", "cursor", "limit", "customElements"],
		create_physics2d_joint: ["type", "anchor", "maxDistanceOnly", "frequency", "maxTorque", "useLimits", "linearOffset", "lowerTranslation", "target", "maxMotorForce"],
		set_physics2d_joint: ["expectedRevision", "type", "firstAnchor", "breakAction", "correctionScale", "upperTranslation", "maxMotorTorque"],
		create_physics2d_effector: [
			"type",
			"useColliderMask",
			"forceMagnitude",
			"forceSource",
			"useGlobalAngle",
			"surfaceThickness",
			"rotationalOffset",
			"surfaceLevel",
			"flowMagnitude",
		],
		set_physics2d_effector: ["expectedRevision", "type", "colliderMask", "forceMode", "speedVariation", "surfaceArc", "density"],
	})) {
		const tool = tools.find((candidate) => candidate.name === name);
		for (const property of properties) {
			if (!tool?.inputSchema?.properties?.[property]) failures.push(`${name} is missing complete ${property} schema coverage`);
		}
	}
	const polygonTool = tools.find((tool) => tool.name === "set_physics2d_polygon_collider");
	if (polygonTool) {
		for (const invalid of [
			{
				label: "negative revision",
				arguments: {
					nodeId: "schema-probe",
					expectedRevision: -1,
					contours: [
						{
							id: "outer",
							points: [
								[0, 0],
								[1, 0],
								[0, 1],
							],
							holes: [],
						},
					],
				},
			},
			{
				label: "missing exact revision",
				arguments: {
					nodeId: "schema-probe",
					contours: [
						{
							id: "outer",
							points: [
								[0, 0],
								[1, 0],
								[0, 1],
							],
							holes: [],
						},
					],
				},
			},
			{ label: "empty contours", arguments: { nodeId: "schema-probe", expectedRevision: 0, contours: [] } },
			{
				label: "missing holes array",
				arguments: {
					nodeId: "schema-probe",
					expectedRevision: 0,
					contours: [
						{
							id: "outer",
							points: [
								[0, 0],
								[1, 0],
								[0, 1],
							],
						},
					],
				},
			},
		]) {
			const response = await rpc("tools/call", { name: polygonTool.name, arguments: invalid.arguments });
			const encoded = JSON.stringify(response);
			const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
			if (!rejected) {
				failures.push(`set_physics2d_polygon_collider accepted ${invalid.label}`);
			}
		}
	}
	for (const invalid of [
		{
			name: "set_mesh_pivot",
			label: "invalid client-compatible tuple length",
			arguments: { nodeId: "probe", expectedPivotFingerprint: "probe", mode: "world", worldPosition: [0, 0] },
		},
		{
			name: "compute_navmesh_path",
			label: "invalid client-compatible map value",
			arguments: { path: "assets/probe.navmesh", start: [0, 0, 0], destination: [1, 0, 0], areaCosts: { walkable: "invalid" } },
		},
		{ name: "set_physics2d_settings", label: "missing settings lease", arguments: { velocityIterations: 4 } },
		{ name: "create_physics2d_world", label: "missing world lease", arguments: { id: "probe" } },
		{
			name: "set_physics2d_world",
			label: "non-orthogonal custom plane",
			arguments: { id: "probe", expectedRevision: 1, transformPlane: { mode: "custom", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [1, 0, 0] } },
		},
		{ name: "delete_physics2d_world", label: "missing world delete lease", arguments: { id: "probe" } },
		{
			name: "get_physics2d_debug_rendering",
			label: "unknown nested custom debug field",
			arguments: {
				customElements: [
					{
						id: "probe",
						worldId: "default",
						points: [
							[0, 0],
							[1, 0],
						],
						mystery: true,
					},
				],
			},
		},
		{ name: "set_physics2d_material", label: "missing material lease", arguments: { id: "probe", friction: 0.5 } },
		{ name: "delete_physics2d_material", label: "missing material delete lease", arguments: { id: "probe" } },
		{
			name: "set_physics2d_body",
			label: "unknown nested collider field",
			arguments: { nodeId: "probe", expectedRevision: 0, collider: { shape: "box", size: [1, 1], mystery: true } },
		},
		{ name: "set_physics2d_body", label: "missing body lease", arguments: { nodeId: "probe", mass: 2 } },
		{ name: "remove_physics2d_body", label: "missing body delete lease", arguments: { nodeId: "probe" } },
		{ name: "generate_physics2d_polygon_collider", label: "missing generator lease", arguments: { nodeId: "probe", imagePath: "assets/probe.png" } },
		{ name: "create_physics2d_joint", label: "cross-family joint field", arguments: { type: "distance", firstNodeId: "first", target: [0, 0] } },
		{ name: "set_physics2d_joint", label: "missing joint lease", arguments: { id: "probe", type: "hinge", motorSpeed: 1 } },
		{ name: "delete_physics2d_joint", label: "missing joint delete lease", arguments: { id: "probe" } },
		{ name: "create_physics2d_effector", label: "cross-family effector field", arguments: { type: "point", nodeId: "probe", surfaceArc: 90 } },
		{ name: "set_physics2d_effector", label: "missing effector lease", arguments: { id: "probe", type: "area", forceAngle: 90 } },
		{ name: "delete_physics2d_effector", label: "missing effector delete lease", arguments: { id: "probe" } },
		{ name: "apply_physics2d_force", label: "missing force lease", arguments: { nodeId: "probe", value: [1, 0] } },
		{ name: "apply_physics2d_torque", label: "missing torque lease", arguments: { nodeId: "probe", value: 1 } },
		{ name: "set_physics2d_runtime_velocity", label: "missing velocity lease", arguments: { nodeId: "probe", velocity: [1, 0] } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const physicsContactHistoryToolNames = [
		"save_physics_contact_history",
		"list_physics_contact_histories",
		"get_physics_contact_history",
		"delete_physics_contact_history",
		"start_physics_contact_history_replay",
		"get_physics_contact_history_replay",
		"control_physics_contact_history_replay",
	];
	for (const name of physicsContactHistoryToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	const replayDescriptions = tools.filter((tool) => ["start_physics_contact_history_replay", "control_physics_contact_history_replay"].includes(tool.name));
	if (replayDescriptions.some((tool) => !/never .*(physics|Havok)|never step physics/i.test(tool.description ?? "") || !/callback/i.test(tool.description ?? ""))) {
		failures.push("physics contact history replay descriptions must explicitly deny physics stepping and callback execution");
	}
	for (const invalid of [
		{ name: "list_physics_contact_histories", label: "unknown list field", arguments: { unknown: true } },
		{
			name: "get_physics_contact_history",
			label: "unknown nested filter field",
			arguments: { path: "assets/probe.physicscontacts.json", filter: { unknown: true } },
		},
		{
			name: "delete_physics_contact_history",
			label: "missing literal confirmation",
			arguments: { path: "assets/probe.physicscontacts.json", expectedRevision: "0".repeat(64) },
		},
		{
			name: "start_physics_contact_history_replay",
			label: "invalid content revision",
			arguments: { path: "assets/probe.physicscontacts.json", expectedRevision: "stale" },
		},
		{
			name: "control_physics_contact_history_replay",
			label: "seek without cursor",
			arguments: { command: "seek", sessionId: "probe", expectedSessionRevision: 1 },
		},
		{
			name: "control_physics_contact_history_replay",
			label: "setting on play command",
			arguments: { command: "play", sessionId: "probe", expectedSessionRevision: 1, loop: true },
		},
	]) {
		if (!tools.some((tool) => tool.name === invalid.name)) {
			continue;
		}
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const physicsForceVisualizationToolNames = ["get_physics_force_visualization", "set_physics_force_visualization"];
	for (const name of physicsForceVisualizationToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	const forceVisualizationDescriptions = tools.filter((tool) => physicsForceVisualizationToolNames.includes(tool.name));
	if (
		forceVisualizationDescriptions.some(
			(tool) => !/never advances physics|physics was not advanced/i.test(tool.description ?? "") || !/bodies were not mutated|never calls body/i.test(tool.description ?? "")
		)
	) {
		failures.push("physics force visualization descriptions must explicitly deny physics advancement and body mutation");
	}
	for (const invalid of [
		{ name: "get_physics_force_visualization", label: "unknown read field", arguments: { unknown: true } },
		{
			name: "get_physics_force_visualization",
			label: "duplicate category filter",
			arguments: { categories: ["net-force", "net-force"] },
		},
		{
			name: "get_physics_force_visualization",
			label: "duplicate body filter",
			arguments: { bodyNodeIds: ["body", "body"] },
		},
		{ name: "set_physics_force_visualization", label: "missing exact revision", arguments: { enabled: true } },
		{ name: "set_physics_force_visualization", label: "revision-only update", arguments: { expectedRevision: 1 } },
		{
			name: "set_physics_force_visualization",
			label: "unsupported vector category",
			arguments: { expectedRevision: 1, categories: ["constraint-reaction"] },
		},
		{
			name: "set_physics_force_visualization",
			label: "unknown update field",
			arguments: { expectedRevision: 1, enabled: true, unknown: true },
		},
	]) {
		if (!tools.some((tool) => tool.name === invalid.name)) {
			continue;
		}
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const tilePaintToolNames = [
		"list_tile_palettes",
		"get_tile_palette",
		"get_tile_grid_configuration",
		"set_tile_grid_configuration",
		"list_grid_brush_types",
		"get_tile_paint_viewport",
		"set_tile_paint_viewport",
		"apply_tile_paint_viewport_stroke",
		"apply_tile_palette_operation",
	];
	for (const name of tilePaintToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	for (const invalid of [
		{ name: "get_tile_palette", label: "ambiguous palette identity", arguments: { paletteId: "a", paletteName: "b" } },
		{ name: "set_tile_grid_configuration", label: "missing grid lease", arguments: { mapNodeId: "probe", layout: "isometric" } },
		{ name: "set_tile_grid_configuration", label: "unsupported layout", arguments: { mapNodeId: "probe", expectedRevision: 0, layout: "triangular" } },
		{ name: "set_tile_palette", label: "missing palette lease", arguments: { paletteId: "probe", activeTileIndex: 2 } },
		{ name: "delete_tile_palette", label: "missing delete lease", arguments: { paletteId: "probe" } },
		{ name: "get_tile_paint_viewport", label: "unknown read field", arguments: { unknown: true } },
		{ name: "set_tile_paint_viewport", label: "missing exact revision", arguments: { enabled: false } },
		{ name: "set_tile_paint_viewport", label: "zero brush width", arguments: { expectedRevision: 0, brushSize: [0, 1] } },
		{
			name: "apply_tile_paint_viewport_stroke",
			label: "missing position and anchors",
			arguments: { expectedRevision: 0, expectedMapRevision: 0 },
		},
		{
			name: "apply_tile_paint_viewport_stroke",
			label: "position and anchors together",
			arguments: { expectedRevision: 0, expectedMapRevision: 0, position: [0, 0], anchors: [[0, 0]] },
		},
		{
			name: "apply_tile_palette_operation",
			label: "missing exact palette revision",
			arguments: { expectedRevision: 0, expectedMapRevision: 0, operation: "paint", position: [0, 0] },
		},
		{
			name: "apply_tile_palette_operation",
			label: "move without offset",
			arguments: { expectedRevision: 0, expectedMapRevision: 0, expectedPaletteRevision: 0, operation: "move" },
		},
		{
			name: "apply_tile_palette_operation",
			label: "unknown nested transform field",
			arguments: { expectedRevision: 0, expectedMapRevision: 0, expectedPaletteRevision: 0, operation: "paint", position: [0, 0], transform: { skew: true } },
		},
	]) {
		if (!tools.some((tool) => tool.name === invalid.name)) {
			continue;
		}
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const localizationToolNames = [
		"list_localization_tables",
		"set_localization_settings",
		"upsert_localization_locale",
		"delete_localization_locale",
		"create_localization_table",
		"set_localization_table_settings",
		"delete_localization_table",
		"set_localization_entry",
		"delete_localization_entry",
		"resolve_localization_entry",
		"pseudo_localize_entry",
		"create_localized_asset_table",
		"set_localized_asset_table_settings",
		"delete_localized_asset_table",
		"set_localized_asset_entry",
		"delete_localized_asset_entry",
		"resolve_localized_asset",
		"preload_localized_assets",
		"validate_localization",
	];
	for (const name of localizationToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	for (const invalid of [
		{ name: "list_localization_tables", label: "unknown read field", arguments: { unknown: true } },
		{ name: "set_localization_settings", label: "missing exact fingerprint", arguments: { expectedRevision: 0, defaultLocale: "en" } },
		{
			name: "upsert_localization_locale",
			label: "unknown nested locale field",
			arguments: {
				expectedRevision: 0,
				expectedFingerprint: "0".repeat(16),
				locale: { id: "en", name: "English", direction: "ltr", fallbackLocales: [], pseudo: null, unknown: true },
			},
		},
		{ name: "delete_localization_locale", label: "missing explicit confirmation", arguments: { expectedRevision: 0, expectedFingerprint: "0".repeat(16), locale: "fr" } },
		{
			name: "set_localized_asset_entry",
			label: "unknown nested asset field",
			arguments: {
				expectedRevision: 0,
				expectedFingerprint: "0".repeat(16),
				name: "Images",
				key: "logo",
				locale: "en",
				asset: { path: "assets/logo.png", type: "texture", unknown: true },
			},
		},
		{
			name: "delete_localization_entry",
			label: "missing explicit confirmation",
			arguments: { expectedRevision: 0, expectedFingerprint: "0".repeat(16), name: "UI", key: "play", locale: "en" },
		},
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const guiAuthoringToolNames = [
		"get_gui_authoring",
		"set_gui_localization_binding",
		"delete_gui_localization_binding",
		"set_gui_accessibility_settings",
		"set_gui_accessibility_node",
		"delete_gui_accessibility_node",
		"inspect_gui_accessibility_hierarchy",
		"focus_gui_accessibility_node",
		"invoke_gui_accessibility_action",
		"announce_gui_accessibility",
		"set_gui_canvas_settings",
		"create_gui_control",
		"update_gui_control",
		"move_gui_control",
		"delete_gui_control",
		"set_gui_control_font",
		"create_gui_atlas_text",
		"get_gui_atlas_text",
		"set_gui_atlas_text",
		"refresh_gui_atlas_text",
		"clear_gui_atlas_text",
		"create_gui_event_binding",
		"update_gui_event_binding",
		"delete_gui_event_binding",
		"delete_gui_instance",
	];
	for (const name of guiAuthoringToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	for (const invalid of [
		{ name: "get_gui_authoring", label: "unknown read field", arguments: { guiId: "schema-probe", unknown: true } },
		{
			name: "set_gui_localization_binding",
			label: "unknown nested localization field",
			arguments: { guiId: "schema-probe", expectedRevision: 0, binding: { controlId: "title", property: "text", table: "UI", key: "title", unknown: true } },
		},
		{
			name: "delete_gui_localization_binding",
			label: "missing explicit confirmation",
			arguments: { guiId: "schema-probe", expectedRevision: 0, controlId: "title", property: "text" },
		},
		{
			name: "set_gui_accessibility_node",
			label: "unknown nested semantic field",
			arguments: {
				guiId: "schema-probe",
				expectedRevision: 0,
				node: { controlId: "play", role: "button", label: "Play", focusOrder: 0, actions: ["activate"], unknown: true },
			},
		},
		{ name: "delete_gui_accessibility_node", label: "missing explicit confirmation", arguments: { guiId: "schema-probe", expectedRevision: 0, controlId: "play" } },
		{ name: "delete_gui_instance", label: "missing explicit confirmation", arguments: { guiId: "schema-probe", expectedRevision: 0 } },
		{
			name: "set_gui_canvas_settings",
			label: "unknown nested safe-area field",
			arguments: { guiId: "schema-probe", expectedRevision: 0, canvas: { safeArea: { enabled: true, unknown: 1 } } },
		},
		{
			name: "create_gui_control",
			label: "unknown nested control property",
			arguments: { guiId: "schema-probe", expectedRevision: 0, type: "button", properties: { name: "Play", unknown: true } },
		},
		{
			name: "set_gui_control_font",
			label: "excessive font fallback chain",
			arguments: {
				guiId: "schema-probe",
				expectedRevision: 0,
				controlId: "play",
				assignment: { assetPaths: Array.from({ length: 9 }, (_, index) => `assets/font-${index}.ttf`) },
			},
		},
		{
			name: "create_gui_event_binding",
			label: "unknown nested event target field",
			arguments: {
				guiId: "schema-probe",
				expectedRevision: 0,
				binding: { id: "play", controlId: "play", event: "pointerClick", target: { kind: "customEvent", eventName: "game.play", detail: null, unknown: true } },
			},
		},
		{
			name: "create_gui_atlas_text",
			label: "unknown nested atlas-text field",
			arguments: {
				guiId: "schema-probe",
				expectedRevision: 0,
				controlId: "title",
				name: "Title",
				assignment: {
					fontAssetPaths: ["assets/title.ttf"],
					text: "Title",
					width: 512,
					height: 128,
					fontSize: 48,
					color: "#fff",
					unknown: true,
				},
			},
		},
		{
			name: "set_gui_atlas_text",
			label: "oversized atlas-text surface",
			arguments: {
				guiId: "schema-probe",
				expectedRevision: 0,
				controlId: "title",
				assignment: { fontAssetPaths: ["assets/title.ttf"], text: "Title", width: 4096, height: 4096, fontSize: 48, color: "#fff" },
			},
		},
		{ name: "refresh_gui_atlas_text", label: "unknown refresh field", arguments: { guiId: "schema-probe", expectedRevision: 0, controlId: "title", unknown: true } },
		{
			name: "update_gui_event_binding",
			label: "unknown nested update field",
			arguments: { guiId: "schema-probe", expectedRevision: 0, bindingId: "play", updates: { unknown: true } },
		},
	]) {
		if (!tools.some((tool) => tool.name === invalid.name)) continue;
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const tileColliderToolNames = [
		"get_tile_collider_generator",
		"generate_tile_colliders",
		"set_tile_collider_generator",
		"refresh_tile_colliders",
		"clear_tile_collider_generator",
	];
	for (const name of tileColliderToolNames) {
		if (!tools.some((tool) => tool.name === name)) failures.push(`${name} is missing`);
	}
	for (const invalid of [
		{ name: "get_tile_collider_generator", label: "unknown read field", arguments: { mapNodeId: "schema-probe", unknown: true } },
		{ name: "generate_tile_colliders", label: "zero replacement revision", arguments: { mapNodeId: "schema-probe", expectedRevision: 0 } },
		{ name: "set_tile_collider_generator", label: "missing exact revision", arguments: { mapNodeId: "schema-probe", update: { friction: 0.5 } } },
		{ name: "set_tile_collider_generator", label: "unknown nested update field", arguments: { mapNodeId: "schema-probe", expectedRevision: 1, update: { unknown: true } } },
		{
			name: "set_tile_collider_generator",
			label: "sprite point outside normalized cell bounds",
			arguments: {
				mapNodeId: "schema-probe",
				expectedRevision: 1,
				update: {
					spriteShapes: {
						7: [
							{
								id: "outer",
								points: [
									[-0.5, -0.5],
									[0.6, -0.5],
									[0, 0.5],
								],
								holes: [],
							},
						],
					},
				},
			},
		},
		{ name: "refresh_tile_colliders", label: "missing exact revision", arguments: { mapNodeId: "schema-probe" } },
		{ name: "clear_tile_collider_generator", label: "missing exact revision", arguments: { mapNodeId: "schema-probe" } },
	]) {
		if (!tools.some((tool) => tool.name === invalid.name)) continue;
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const spriteShapeToolNames = [
		"list_sprite_shape_profiles",
		"get_sprite_shape_profile",
		"create_sprite_shape_profile",
		"set_sprite_shape_profile",
		"delete_sprite_shape_profile",
		"list_sprite_shapes",
		"get_sprite_shape",
		"create_sprite_shape",
		"set_sprite_shape",
		"delete_sprite_shape",
	];
	for (const name of spriteShapeToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	for (const invalid of [
		{ name: "list_sprite_shapes", label: "unknown list field", arguments: { unknown: true } },
		{ name: "get_sprite_shape_profile", label: "missing profile identity", arguments: {} },
		{ name: "set_sprite_shape_profile", label: "empty profile update", arguments: { profileId: "schema-probe", expectedRevision: 1, update: {} } },
		{
			name: "create_sprite_shape_profile",
			label: "reversed angle range",
			arguments: {
				angleRanges: [{ id: "range", name: "Range", minimumDegrees: 45, maximumDegrees: -45, order: 0, texturePath: null, color: [1, 1, 1, 1] }],
			},
		},
		{
			name: "create_sprite_shape",
			label: "unknown nested definition field",
			arguments: { definition: { closed: true, unknown: true } },
		},
		{
			name: "create_sprite_shape",
			label: "only one control point",
			arguments: {
				definition: {
					points: [{ id: "point", position: [0, 0], leftTangent: [0, 0], rightTangent: [0, 0], tangentMode: "linear", height: 1, corner: true }],
				},
			},
		},
		{ name: "set_sprite_shape", label: "missing exact revision", arguments: { nodeId: "schema-probe", update: { detail: 4 } } },
		{ name: "set_sprite_shape", label: "empty controller update", arguments: { nodeId: "schema-probe", expectedRevision: 1, update: {} } },
		{
			name: "set_sprite_shape",
			label: "unknown collider field",
			arguments: { nodeId: "schema-probe", expectedRevision: 1, update: { collider: { enabled: true, unknown: true } } },
		},
		{ name: "delete_sprite_shape", label: "missing shape identity", arguments: { expectedRevision: 1 } },
	]) {
		if (!tools.some((tool) => tool.name === invalid.name)) {
			continue;
		}
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const subsurfaceToolNames = [
		"create_diffusion_profile",
		"list_diffusion_profiles",
		"get_diffusion_profile",
		"set_diffusion_profile",
		"delete_diffusion_profile",
		"get_subsurface_material",
		"set_subsurface_material",
		"clear_subsurface_material",
		"get_subsurface_runtime",
		"set_subsurface_runtime",
		"clear_subsurface_runtime",
		"refresh_subsurface_profile_assignments",
	];
	for (const name of subsurfaceToolNames) {
		if (!tools.some((tool) => tool.name === name)) {
			failures.push(`${name} is missing`);
		}
	}
	const invalidSubsurfaceCalls = [
		{
			name: "create_diffusion_profile",
			label: "zero scattering distance",
			arguments: { path: "assets/invalid.diffusionprofile.json", name: "Invalid", scatteringDistance: [0, 1, 1] },
		},
		{
			name: "create_diffusion_profile",
			label: "reversed thickness remap",
			arguments: { path: "assets/invalid.diffusionprofile.json", name: "Invalid", thicknessRemap: [2, 1] },
		},
		{
			name: "set_subsurface_material",
			label: "first assignment without an exact profile lease",
			arguments: { materialId: "schema-probe", expectedRevision: 0 },
		},
		{
			name: "set_subsurface_material",
			label: "profile path without its exact profile revision",
			arguments: { materialId: "schema-probe", expectedRevision: 1, profilePath: "assets/probe.diffusionprofile.json" },
		},
		{
			name: "set_subsurface_material",
			label: "empty subsurface mask texture path",
			arguments: { materialId: "schema-probe", expectedRevision: 1, subsurfaceMaskTexturePath: "" },
		},
		{
			name: "refresh_subsurface_profile_assignments",
			label: "refresh without an exact content revision",
			arguments: { path: "assets/probe.diffusionprofile.json" },
		},
	];
	for (const invalid of invalidSubsurfaceCalls) {
		if (!tools.some((tool) => tool.name === invalid.name)) {
			continue;
		}
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const invalidDecalCalls = [
		{
			label: "screen-space projector with every material channel disabled",
			arguments: {
				projectionMode: "screen-space-volume",
				materialId: "schema-probe",
				position: [0, 0, 0],
				channels: { albedo: false, normal: false, metallic: false, ambientOcclusion: false, emissive: false },
			},
		},
		{
			label: "geometry decal with screen-space material channels",
			arguments: {
				projectionMode: "geometry",
				sourceNodeId: "schema-probe-source",
				materialId: "schema-probe",
				position: [0, 0, 0],
				channels: { albedo: true },
			},
		},
		{
			label: "Decal Layer mask outside the unsigned 32-bit range",
			arguments: {
				projectionMode: "screen-space-volume",
				materialId: "schema-probe",
				position: [0, 0, 0],
				decalLayerMask: 0x1_0000_0000,
			},
		},
	];
	if (!tools.some((tool) => tool.name === "create_decal")) {
		failures.push("create_decal is missing");
	} else {
		for (const invalid of invalidDecalCalls) {
			const response = await rpc("tools/call", { name: "create_decal", arguments: invalid.arguments });
			const encoded = JSON.stringify(response);
			const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
			if (!rejected) {
				failures.push(`create_decal accepted ${invalid.label}`);
			}
		}
	}

	const psdTool = tools.find((tool) => tool.name === "inspect_psd_layer_extraction");
	if (!psdTool) {
		failures.push("inspect_psd_layer_extraction is missing");
	} else {
		const invalidPsdCalls = [
			{
				label: "style-run bindings without authored mode",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", styleRunFontBindings: [{ fontIndex: 0, fontPath: "assets/probe.ttf" }] }],
				},
			},
			{
				label: "replacement text with authored mode",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, text: "replacement", fontPath: "assets/probe.ttf", useAuthoredStyleRuns: true }],
				},
			},
			{
				label: "duplicate authored FontSet bindings",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [
						{
							layerIndex: 0,
							fontPath: "assets/probe.ttf",
							useAuthoredStyleRuns: true,
							styleRunFontBindings: [
								{ fontIndex: 0, fontPath: "assets/probe.ttf" },
								{ fontIndex: 0, fontPath: "assets/probe.ttf" },
							],
						},
					],
				},
			},
			{
				label: "unknown authored FontSet binding field",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [
						{
							layerIndex: 0,
							fontPath: "assets/probe.ttf",
							useAuthoredStyleRuns: true,
							styleRunFontBindings: [{ fontIndex: 0, fontPath: "assets/probe.ttf", unknown: true }],
						},
					],
				},
			},
			{
				label: "invalid complex-text shaping direction",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "auto" } }],
				},
			},
			{
				label: "invalid complex-text shaping script",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "rtl", script: "Arabic" } }],
				},
			},
			{
				label: "non-Boolean bidirectional shaping option",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "ltr", bidirectional: "yes" } }],
				},
			},
			{
				label: "non-Boolean cross-style shaping option",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", useAuthoredStyleRuns: true, shaping: { direction: "rtl", joinAcrossStyleRuns: "yes" } }],
				},
			},
			{
				label: "cross-style shaping without authored mode",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "rtl", joinAcrossStyleRuns: true } }],
				},
			},
			{
				label: "non-Boolean authored text warp option",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", applyAuthoredWarp: "yes" }],
				},
			},
			{
				label: "duplicate complex-text shaping features",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [
						{
							layerIndex: 0,
							fontPath: "assets/probe.ttf",
							shaping: {
								direction: "rtl",
								features: [
									{ tag: "rlig", value: 1 },
									{ tag: "rlig", value: 0 },
								],
							},
						},
					],
				},
			},
			{
				label: "unknown complex-text shaping field",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "rtl", guessBidi: true } }],
				},
			},
		];
		for (const invalid of invalidPsdCalls) {
			const response = await rpc("tools/call", { name: psdTool.name, arguments: invalid.arguments });
			const encoded = JSON.stringify(response);
			const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
			if (!rejected) {
				failures.push(`inspect_psd_layer_extraction accepted ${invalid.label}`);
			}
		}
	}

	const runtimeAiToolNames = [
		"get_runtime_ai_capabilities",
		"inspect_runtime_ai_model",
		"create_runtime_ai_session",
		"list_runtime_ai_sessions",
		"get_runtime_ai_session",
		"run_runtime_ai_inference",
		"dispose_runtime_ai_session",
		"reset_runtime_ai_runtime",
	];
	for (const name of runtimeAiToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean") || tool.inputSchema?.additionalProperties !== false) {
			failures.push(`${name} must publish a closed four-annotation contract`);
		}
	}
	for (const name of ["get_runtime_ai_capabilities", "inspect_runtime_ai_model", "list_runtime_ai_sessions", "get_runtime_ai_session"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only contract`);
		}
	}
	for (const name of ["dispose_runtime_ai_session", "reset_runtime_ai_runtime"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed destructive contract`);
		}
	}
	for (const invalid of [
		{ name: "get_runtime_ai_capabilities", label: "unknown field", arguments: { unknown: true } },
		{ name: "inspect_runtime_ai_model", label: "unsupported traversal", arguments: { modelPath: "../outside.bin" } },
		{ name: "create_runtime_ai_session", label: "short model hash", arguments: { modelPath: "assets/model.onnx", expectedModelSha256: "stale" } },
		{ name: "list_runtime_ai_sessions", label: "oversized page", arguments: { limit: 101 } },
		{ name: "get_runtime_ai_session", label: "malformed session id", arguments: { id: "session" } },
		{ name: "run_runtime_ai_inference", label: "missing exact revision", arguments: { id: "runtime-ai-1", inputs: {} } },
		{
			name: "run_runtime_ai_inference",
			label: "unknown tensor field",
			arguments: { id: "runtime-ai-1", expectedRevision: 1, inputs: { input: { type: "float32", dims: [1], data: [1], unknown: true } } },
		},
		{ name: "dispose_runtime_ai_session", label: "missing confirmation", arguments: { id: "runtime-ai-1", expectedRevision: 1 } },
		{ name: "reset_runtime_ai_runtime", label: "false confirmation", arguments: { confirm: false } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const generativeAssetToolNames = [
		"get_generative_asset_capabilities",
		"list_generative_asset_providers",
		"set_generative_asset_provider",
		"delete_generative_asset_provider",
		"start_generative_asset_job",
		"list_generative_asset_jobs",
		"get_generative_asset_job",
		"cancel_generative_asset_job",
		"retry_generative_asset_job",
		"get_generative_asset_preview",
		"inspect_generative_asset_publication",
		"publish_generative_asset_candidate",
		"delete_generative_asset_job",
	];
	for (const name of generativeAssetToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean") || tool.inputSchema?.additionalProperties !== false) {
			failures.push(`${name} must publish a closed four-annotation contract`);
		}
	}
	for (const name of [
		"get_generative_asset_capabilities",
		"list_generative_asset_providers",
		"list_generative_asset_jobs",
		"get_generative_asset_job",
		"get_generative_asset_preview",
		"inspect_generative_asset_publication",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only contract`);
		}
	}
	for (const name of ["delete_generative_asset_provider", "cancel_generative_asset_job", "publish_generative_asset_candidate", "delete_generative_asset_job"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed destructive contract`);
		}
	}
	for (const name of ["start_generative_asset_job", "retry_generative_asset_job"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || tool.annotations?.idempotentHint || !tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a non-idempotent open-world provider-execution contract`);
		}
	}
	const validJobId = `generative-job-${"0".repeat(24)}`;
	const validHash = "0".repeat(64);
	for (const invalid of [
		{ name: "get_generative_asset_capabilities", label: "unknown field", arguments: { unknown: true } },
		{ name: "list_generative_asset_providers", label: "unknown field", arguments: { unknown: true } },
		{ name: "set_generative_asset_provider", label: "missing provider manifest", arguments: { expectedInventoryFingerprint: validHash } },
		{
			name: "delete_generative_asset_provider",
			label: "false confirmation",
			arguments: { id: "provider", expectedInventoryFingerprint: validHash, expectedProviderFingerprint: validHash, confirm: false },
		},
		{
			name: "start_generative_asset_job",
			label: "mismatched modality options",
			arguments: {
				providerId: "provider",
				expectedProviderFingerprint: validHash,
				confirm: true,
				request: {
					version: 1,
					modality: "image",
					prompt: "probe",
					negativePrompt: null,
					style: null,
					seed: null,
					count: 1,
					references: [],
					parameters: {},
					options: { modality: "audio", value: { durationSeconds: 1, sampleRate: 48000, channels: 2, loop: false } },
				},
			},
		},
		{ name: "list_generative_asset_jobs", label: "oversized page", arguments: { limit: 101 } },
		{ name: "get_generative_asset_job", label: "malformed job id", arguments: { jobId: "job" } },
		{ name: "cancel_generative_asset_job", label: "missing exact revision", arguments: { jobId: validJobId, confirm: true } },
		{
			name: "retry_generative_asset_job",
			label: "short provider fingerprint",
			arguments: { jobId: validJobId, expectedRevision: 1, expectedProviderFingerprint: "stale", confirm: true },
		},
		{
			name: "get_generative_asset_preview",
			label: "oversized preview",
			arguments: { jobId: validJobId, expectedResultFingerprint: validHash, candidateId: "candidate", maximumBytes: 8 * 1024 * 1024 + 1 },
		},
		{
			name: "inspect_generative_asset_publication",
			label: "parent-directory destination",
			arguments: { jobId: validJobId, expectedRevision: 1, expectedResultFingerprint: validHash, candidateId: "candidate", destinationDirectory: "assets/../outside" },
		},
		{
			name: "publish_generative_asset_candidate",
			label: "missing confirmation",
			arguments: {
				jobId: validJobId,
				expectedRevision: 1,
				expectedResultFingerprint: validHash,
				candidateId: "candidate",
				expectedPlanFingerprint: validHash,
			},
		},
		{ name: "delete_generative_asset_job", label: "false confirmation", arguments: { jobId: validJobId, expectedRevision: 1, confirm: false } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const mlTrainingToolNames = [
		"get_ml_training_capabilities",
		"get_ml_training_configuration",
		"set_ml_training_configuration",
		"list_ml_training_providers",
		"set_ml_training_provider",
		"delete_ml_training_provider",
		"record_ml_training_episode",
		"list_ml_training_episodes",
		"get_ml_training_episode",
		"clear_ml_training_dataset",
		"start_ml_training_job",
		"list_ml_training_jobs",
		"get_ml_training_job",
		"cancel_ml_training_job",
		"retry_ml_training_job",
		"inspect_ml_training_checkpoint_publication",
		"publish_ml_training_checkpoint",
		"delete_ml_training_job",
	];
	for (const name of mlTrainingToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean") || tool.inputSchema?.additionalProperties !== false) {
			failures.push(`${name} must publish a closed four-annotation contract`);
		}
	}
	for (const name of [
		"get_ml_training_capabilities",
		"get_ml_training_configuration",
		"list_ml_training_providers",
		"list_ml_training_episodes",
		"get_ml_training_episode",
		"list_ml_training_jobs",
		"get_ml_training_job",
		"inspect_ml_training_checkpoint_publication",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only contract`);
		}
	}
	for (const name of ["delete_ml_training_provider", "clear_ml_training_dataset", "cancel_ml_training_job", "publish_ml_training_checkpoint", "delete_ml_training_job"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed destructive contract`);
		}
	}
	for (const name of ["start_ml_training_job", "retry_ml_training_job"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || tool.annotations?.idempotentHint || !tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a non-idempotent open-world trainer-execution contract`);
		}
	}
	const validMlJobId = `ml-training-job-${"0".repeat(24)}`;
	for (const invalid of [
		{ name: "get_ml_training_capabilities", label: "unknown field", arguments: { unknown: true } },
		{ name: "get_ml_training_configuration", label: "unknown field", arguments: { unknown: true } },
		{ name: "set_ml_training_configuration", label: "missing exact revision", arguments: { configuration: { enabled: true, timeScale: 1, behaviors: [], curriculum: [] } } },
		{ name: "list_ml_training_providers", label: "unknown field", arguments: { unknown: true } },
		{
			name: "set_ml_training_provider",
			label: "credential value instead of name",
			arguments: {
				provider: {
					version: 1,
					id: "trainer",
					name: "Trainer",
					algorithms: ["ppo"],
					executable: "python3",
					args: [],
					credentialEnvironments: ["bad-name=value"],
					maximumDurationSeconds: 10,
				},
			},
		},
		{ name: "delete_ml_training_provider", label: "false confirmation", arguments: { id: "trainer", expectedFingerprint: validHash, confirm: false } },
		{
			name: "record_ml_training_episode",
			label: "missing terminal boundary",
			arguments: {
				expectedConfigurationRevision: 1,
				episode: {
					id: "episode",
					behaviorId: "behavior",
					agentId: "agent",
					lessonId: null,
					parameters: {},
					steps: [{ observations: [0], continuousActions: [0], discreteActions: [], reward: 0, done: false, interrupted: false }],
				},
			},
		},
		{ name: "list_ml_training_episodes", label: "oversized page", arguments: { behaviorId: "behavior", limit: 101 } },
		{ name: "get_ml_training_episode", label: "short dataset fingerprint", arguments: { behaviorId: "behavior", episodeId: "episode", expectedDatasetFingerprint: "stale" } },
		{ name: "clear_ml_training_dataset", label: "missing confirmation", arguments: { behaviorId: "behavior", expectedDatasetFingerprint: validHash } },
		{
			name: "start_ml_training_job",
			label: "missing confirmation",
			arguments: {
				behaviorId: "behavior",
				expectedConfigurationRevision: 1,
				providerId: "trainer",
				expectedProviderFingerprint: validHash,
				expectedDatasetFingerprint: validHash,
				settings: { algorithm: "ppo" },
			},
		},
		{ name: "list_ml_training_jobs", label: "oversized page", arguments: { limit: 101 } },
		{ name: "get_ml_training_job", label: "malformed job id", arguments: { jobId: "job" } },
		{ name: "cancel_ml_training_job", label: "missing exact revision", arguments: { jobId: validMlJobId, confirm: true } },
		{
			name: "retry_ml_training_job",
			label: "short provider fingerprint",
			arguments: {
				jobId: validMlJobId,
				expectedRevision: 1,
				expectedConfigurationRevision: 1,
				expectedProviderFingerprint: "stale",
				expectedDatasetFingerprint: validHash,
				confirm: true,
			},
		},
		{
			name: "inspect_ml_training_checkpoint_publication",
			label: "unsafe destination",
			arguments: { jobId: validMlJobId, expectedRevision: 1, expectedResultFingerprint: validHash, path: "assets/../policy.onnx", overwrite: false },
		},
		{
			name: "publish_ml_training_checkpoint",
			label: "missing confirmation",
			arguments: {
				jobId: validMlJobId,
				expectedRevision: 1,
				expectedResultFingerprint: validHash,
				path: "assets/models/policy.onnx",
				overwrite: false,
				expectedPlanFingerprint: validHash,
			},
		},
		{ name: "delete_ml_training_job", label: "false confirmation", arguments: { jobId: validMlJobId, expectedRevision: 1, confirm: false } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) failures.push(`${invalid.name} accepted ${invalid.label}`);
	}

	const alembicToolNames = [
		"get_alembic_capabilities",
		"inspect_alembic_import",
		"apply_alembic_import",
		"instantiate_alembic_asset",
		"list_alembic_players",
		"get_alembic_player",
		"set_alembic_player",
		"control_alembic_player",
		"delete_alembic_player",
	];
	for (const name of alembicToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean") || tool.inputSchema?.additionalProperties !== false) {
			failures.push(`${name} must publish a closed four-annotation contract`);
		}
	}
	for (const name of ["get_alembic_capabilities", "inspect_alembic_import", "list_alembic_players", "get_alembic_player"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only contract`);
		}
	}
	for (const name of ["apply_alembic_import", "delete_alembic_player"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed destructive contract`);
		}
	}
	for (const invalid of [
		{ name: "get_alembic_capabilities", label: "unknown field", arguments: { unknown: true } },
		{ name: "inspect_alembic_import", label: "non-Alembic path", arguments: { path: "assets/cache.fbx" } },
		{ name: "apply_alembic_import", label: "missing literal confirmation", arguments: { path: "assets/cache.abc", expectedFingerprint: "0".repeat(64) } },
		{ name: "instantiate_alembic_asset", label: "two parent references", arguments: { path: "assets/cache.abc", parentId: "one", parentName: "two" } },
		{ name: "list_alembic_players", label: "oversized page", arguments: { limit: 101 } },
		{ name: "get_alembic_player", label: "two player references", arguments: { id: "player", name: "Player" } },
		{ name: "set_alembic_player", label: "empty patch", arguments: { id: "player", expectedRevision: 1 } },
		{ name: "control_alembic_player", label: "seek without time", arguments: { id: "player", action: "seek" } },
		{ name: "delete_alembic_player", label: "false confirmation", arguments: { id: "player", confirm: false } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}

	const occlusionCullingToolNames = [
		"get_occlusion_culling_capabilities",
		"get_occlusion_culling",
		"set_occlusion_culling_settings",
		"set_occlusion_culling_mesh",
		"set_camera_occlusion_culling",
		"create_occlusion_culling_area",
		"update_occlusion_culling_area",
		"delete_occlusion_culling_area",
		"inspect_occlusion_culling_bake",
		"bake_occlusion_culling",
		"cancel_occlusion_culling_bake",
		"clear_occlusion_culling_bake",
		"get_occlusion_culling_runtime",
		"set_occlusion_culling_visualization",
		"reset_occlusion_culling",
	];
	for (const name of occlusionCullingToolNames) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			failures.push(`${name} is missing`);
		} else if (REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean") || tool.inputSchema?.additionalProperties !== false) {
			failures.push(`${name} must publish a closed four-annotation contract`);
		}
	}
	for (const name of ["get_occlusion_culling_capabilities", "get_occlusion_culling", "inspect_occlusion_culling_bake", "get_occlusion_culling_runtime"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (!tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint || !tool.annotations?.idempotentHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed read-only contract`);
		}
	}
	for (const name of ["delete_occlusion_culling_area", "clear_occlusion_culling_bake", "reset_occlusion_culling"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool && (tool.annotations?.readOnlyHint || !tool.annotations?.destructiveHint || tool.annotations?.openWorldHint)) {
			failures.push(`${name} must publish a closed destructive contract`);
		}
	}
	for (const invalid of [
		{ name: "get_occlusion_culling_capabilities", label: "unknown field", arguments: { unknown: true } },
		{ name: "get_occlusion_culling", label: "oversized page", arguments: { limit: 501 } },
		{ name: "set_occlusion_culling_settings", label: "empty settings patch", arguments: { expectedRevision: 0, settings: {} } },
		{ name: "set_occlusion_culling_mesh", label: "missing object revision", arguments: { meshId: "mesh", expectedRevision: 0, settings: { staticOccluder: true } } },
		{ name: "set_camera_occlusion_culling", label: "non-Boolean toggle", arguments: { cameraId: "camera", expectedRevision: 0, expectedObjectRevision: 0, enabled: "yes" } },
		{
			name: "create_occlusion_culling_area",
			label: "zero area extent",
			arguments: { expectedRevision: 0, name: "Area", center: [0, 0, 0], size: [100, 0, 100] },
		},
		{ name: "update_occlusion_culling_area", label: "empty patch", arguments: { areaId: "area", expectedRevision: 0, expectedObjectRevision: 1, patch: {} } },
		{ name: "delete_occlusion_culling_area", label: "false confirmation", arguments: { areaId: "area", expectedRevision: 0, expectedObjectRevision: 1, confirm: false } },
		{ name: "inspect_occlusion_culling_bake", label: "missing exact revision", arguments: {} },
		{ name: "bake_occlusion_culling", label: "short source fingerprint", arguments: { expectedRevision: 0, expectedSourceFingerprint: "stale" } },
		{ name: "cancel_occlusion_culling_bake", label: "malformed job id", arguments: { id: "job", expectedJobRevision: 1 } },
		{ name: "clear_occlusion_culling_bake", label: "missing confirmation", arguments: { expectedRevision: 0, expectedBakeFingerprint: "0".repeat(64) } },
		{ name: "get_occlusion_culling_runtime", label: "unknown field", arguments: { unknown: true } },
		{ name: "set_occlusion_culling_visualization", label: "empty patch", arguments: {} },
		{ name: "reset_occlusion_culling", label: "false confirmation", arguments: { expectedRevision: 0, confirm: false } },
	]) {
		const response = await rpc("tools/call", { name: invalid.name, arguments: invalid.arguments });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
		if (!rejected) {
			failures.push(`${invalid.name} accepted ${invalid.label}`);
		}
	}
} catch (error) {
	failures.push(`exception: ${error.message}`);
} finally {
	child.kill();
}

console.log(`[validate-contract] tools discovered: ${toolCount}`);
if (stderrText.trim()) {
	console.log(`[validate-contract] server stderr: ${stderrText.trim().split("\n").slice(-2).join(" | ")}`);
}

if (failures.length) {
	console.error("[validate-contract] FAIL");
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log("[validate-contract] PASS — count, descriptions, closed/client-compatible schemas, annotations, and exact validation all verified.");
