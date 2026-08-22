import { describe, expect, test } from "vitest";

import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints, parseMcpRequestBody } from "../../src/mcp/mcp";

describe("MCP editor bridge request parsing", () => {
	test("maps the complete portable Version Control 6.5 workspace endpoint family and capability flags", () => {
		for (const endpoint of [
			"get_project_source_control_workspace",
			"get_project_source_control_workspace_layout",
			"set_project_source_control_workspace_layout",
			"inspect_project_source_control_changeset",
			"inspect_project_source_control_shelveset",
			"apply_project_source_control_folder_action",
			"create_project_source_control_shelveset",
			"apply_project_source_control_shelveset_paths",
			"delete_project_source_control_shelveset",
			"rename_project_source_control_ref",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			sourceControlWorkspace65: true,
			sourceControlBranchExplorer: true,
			sourceControlChangesetDiffProperties: true,
			sourceControlFolderActions: true,
			sourceControlPartialShelvesetApply: true,
			sourceControlPersistentSplitters: true,
			sourceControlF2RefRename: true,
		});
	});

	test("maps the complete portable UI Toolkit 6.5 endpoint family and capability flags", () => {
		for (const endpoint of [
			"get_gui_toolkit_capabilities",
			"inspect_gui_toolkit_workspace",
			"inspect_gui_uxml_upgrades",
			"apply_gui_uxml_upgrades",
			"set_gui_panel_renderer",
			"set_gui_stylesheet_stage",
			"set_gui_visual_element_reference",
			"set_gui_attribute_override",
			"delete_gui_attribute_override",
			"set_gui_animation",
			"delete_gui_animation",
			"simulate_gui_world_space_click",
			"release_gui_panel_renderer_resources",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			guiUXMLUpgradeService: true,
			guiPanelRenderer: true,
			guiWorldSpacePanelRenderer: true,
			guiUSSStatistics: true,
			guiStylesheetStaging: true,
			guiVisualElementReferences: true,
			guiAttributeOverrides: true,
			guiRetainedAnimations: true,
			guiWorldSpaceTestClicks: true,
		});
	});

	test("maps the complete Shader Graph 6.5 endpoint family and capability flags", () => {
		for (const endpoint of [
			"get_shader_graph_capabilities",
			"list_shader_graph_templates",
			"create_shader_graph_from_template",
			"apply_shader_graph_template",
			"get_shader_graph_extensions",
			"open_shader_graph_inspector",
			"set_shader_graph_switch",
			"delete_shader_graph_switch",
			"inspect_shader_graph_reflected_function",
			"add_shader_graph_reflected_function",
			"set_shader_graph_subgraph_input",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			shaderGraphTemplates: true,
			shaderGraphMultiCaseSwitch: true,
			shaderGraphStaticSubgraphInputs: true,
			shaderGraphReflectedFunctions: true,
			shaderGraphFloatModes: true,
		});
	});

	test("maps the complete portable VFX 6.5 template and batch-release endpoint family", () => {
		for (const endpoint of ["list_vfx_graph_templates", "create_vfx_graph_from_template", "get_node_particle_batch_release", "set_node_particle_batch_release"]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			vfxGraphTemplates: true,
			vfxGraphTemplateSearchAndFiltering: true,
			vfxBatchReleaseOnDisable: true,
		});
	});

	test("accepts a non-empty endpoint and preserves closed request data", () => {
		expect(parseMcpRequestBody('{"endpoint":"get_editor_status","value":4}')).toEqual({ endpoint: "get_editor_status", value: 4 });
	});

	test.each([
		["empty", "", "MCP request body must contain a JSON object."],
		["malformed", "{", "MCP request body must contain valid JSON."],
		["array", "[]", "MCP request body must be a JSON object."],
		["missing endpoint", "{}", "MCP request body requires a non-empty endpoint string."],
		["blank endpoint", '{"endpoint":"   "}', "MCP request body requires a non-empty endpoint string."],
	] as const)("rejects %s input without an uncaught callback exception", (_name, body, message) => {
		expect(() => parseMcpRequestBody(body)).toThrow(message);
	});

	test("maps every physics contact history and force-visualization endpoint and advertises the complete capabilities", () => {
		for (const endpoint of [
			"save_physics_contact_history",
			"list_physics_contact_histories",
			"get_physics_contact_history",
			"delete_physics_contact_history",
			"start_physics_contact_history_replay",
			"get_physics_contact_history_replay",
			"control_physics_contact_history_replay",
			"get_physics_force_visualization",
			"set_physics_force_visualization",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			physicsContactCapture: true,
			physicsContactHistoryAssets: true,
			physicsContactHistoryReplay: true,
			physicsForceVisualization: true,
		});
	});

	test("maps the complete hybrid direct/iterative physics workflow and capability flags", () => {
		for (const endpoint of [
			"get_hybrid_physics_capabilities",
			"get_hybrid_physics_solver",
			"set_hybrid_physics_solver",
			"reset_hybrid_physics_solver",
			"get_hybrid_physics_runtime",
			"solve_hybrid_physics_now",
			"create_hybrid_physics_gear_coupling",
			"set_hybrid_physics_gear_coupling",
			"delete_hybrid_physics_gear_coupling",
			"set_physics_constraint_solver",
			"create_chain_gears_physics_sample",
			"delete_chain_gears_physics_sample",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			hybridPhysicsSolver: true,
			directPhysicsConstraintRows: true,
			iterativePhysicsContactCoupling: true,
			physicsGearCouplings: true,
			chainGearsPhysicsSample: true,
		});
	});

	test("maps the complete Cloth constraint-paint and triangle-collision endpoints", () => {
		for (const endpoint of [
			"list_cloths",
			"get_cloth_constraints",
			"get_cloth_collision_diagnostics",
			"create_cloth",
			"set_cloth",
			"paint_cloth_constraints",
			"delete_cloth",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({ clothPhysics: true, clothConstraintPainting: true, clothTriangleColliders: true });
	});

	test("maps the complete Scriptable Audio Generator endpoint family", () => {
		for (const endpoint of [
			"list_audio_generators",
			"list_audio_generator_types",
			"get_audio_generator",
			"create_audio_generator",
			"set_audio_generator",
			"delete_audio_generator",
			"validate_audio_generator",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({ sounds: true, scriptableAudioGenerators: true });
	});

	test("maps the complete Networking transport/session/runtime/Multiplayer Play endpoints", () => {
		for (const endpoint of [
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
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(null as any, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			networkingTransport: true,
			networkReplication: true,
			networkPredictionReconciliation: true,
			gameplaySessionHost: true,
			gameplayLobbyRelay: true,
			multiplayerPlayMode: true,
			networkSimulation: true,
		});
	});
});
