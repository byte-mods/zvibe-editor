#!/usr/bin/env node
/** Valid-state live evidence for safe no-argument domain reads that must not be confused with guarded dispatch probes. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "..", "server", "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
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

function rpc(method, params = {}, timeoutMs = 120_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const text = result?.content?.find((entry) => entry.type === "text")?.text ?? "";
	if (response.error || result?.isError) throw new Error(`${name}: ${text || JSON.stringify(response.error ?? result)}`);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "safe-reads-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready) throw new Error("A ready editor is required.");

	await call("list_skeletons");
	await call("list_splines");
	await call("list_spline_assets");
	await call("list_spline_followers");
	await call("list_animator_controllers");
	await call("list_camera_noise_profiles");
	await call("list_camera_impulse_sources");
	await call("list_camera_target_groups");
	await call("get_input_system_settings");
	await call("list_humanoid_avatar_masks");
	await call("list_humanoid_avatars");
	await call("list_sprite_ik_controllers");
	await call("list_animation_rig_job_types");
	await call("get_animation_rig_profile");
	await call("list_rig_layers");
	await call("list_look_at_constraints");
	await call("list_ik_controllers");
	await call("list_performance_budgets");
	await call("list_scene_tests");
	await call("list_testing_runs");
	await call("get_baked_gi");
	await call("list_light_probe_volumes");
	await call("get_light_probe_runtime");
	await call("list_lighting_scenarios");
	await call("get_lighting_scenario_runtime");
	await call("list_rendering_profiles");
	await call("get_rendering_profile_runtime");
	await call("get_shader_variant_collection");
	await call("validate_shader_variant_collection");
	await call("get_shader_variant_collection_runtime");
	await call("list_renderer_data_assets");
	await call("list_rendering_volumes");
	await call("list_camera_stacks");
	await call("get_camera_stack_runtime");
	await call("list_renderer_lists");
	await call("list_custom_render_passes");
	await call("get_custom_render_pass_diagnostics");
	await call("get_render_graph_conformance");
	await call("get_custom_render_pass_schedule");
	await call("get_custom_render_pass_frame");
	await call("list_custom_render_graph_assets");
	await call("list_renderer_feature_assets");
	await call("list_renderer_feature_instances");
	await call("get_renderer_feature_diagnostics");
	await call("get_custom_render_pass_gpu_profile");
	await call("list_custom_compute_subgraphs");
	await call("list_material_types");
	await call("list_material_presets");
	await call("get_environment_lighting");
	await call("list_asset_importer_types");
	await call("get_asset_registry_status");
	await call("get_asset_indexing_status");
	await call("query_asset_registry");
	await call("get_asset_watch_status");
	await call("inspect_auto_reimport");
	await call("list_asset_dependency_scanners");
	await call("get_asset_dependency_diagnostics");
	await call("list_asset_import_diagnostics");
	await call("list_asset_importer_presets");
	await call("list_sprite_managers");
	await call("list_nav_agents");
	await call("list_nav_crowds");
	await call("list_navmeshes");
	await call("list_ragdolls");
	await call("get_project_source_control_review_provider");
	await call("get_project_collaboration_status");
	await call("list_project_collaboration_members");
	await call("list_project_collaboration_presence");
	await call("list_project_asset_locks");
	await call("list_project_semantic_merge_rules");
	await call("list_project_changelists");
	await call("list_installed_external_editors");
	await call("get_project_preferences");
	await call("list_project_templates");
	await call("list_prefabs");
	await call("list_prefab_reviews");
	await call("get_prefab_stage_settings");
	await call("list_vfx_trails");
	await call("list_particle_assets");
	await call("list_particle_systems");
	await call("list_node_particle_systems");
	await call("list_vfx_budget_profiles");
	await call("list_audio_mixer_snapshots");
	await call("list_audio_buses");
	await call("get_audio_mixer_runtime");
	await call("list_audio_runtime_diagnostics");
	await call("get_audio_mixer_profile");
	await call("list_audio_reverb_zones");
	await call("list_animation_groups");
	await call("list_animation_events");
	await call("get_project_script_semantic_diagnostics");
	await call("list_scene_script_execution_orders");
	await call("list_project_script_execution_orders");
	await call("get_editor_api");
	await call("list_agent_scripts");

	console.log("[safe-reads-live] PASS — 95/95 previously uncovered safe domain reads returned valid live state without project mutation.");
} catch (error) {
	console.error(`[safe-reads-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}
