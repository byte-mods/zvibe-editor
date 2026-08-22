import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NullEngine, Scene } from "babylonjs";

import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { clearUndoRedo } from "../../src/tools/undoredo";

const mobileEndpoints = [
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
	"get_adaptive_performance_capabilities",
	"get_adaptive_performance_configuration",
	"set_adaptive_performance_configuration",
	"get_adaptive_performance_runtime",
	"simulate_adaptive_performance_state",
	"reset_adaptive_performance_runtime",
	"get_mobile_system_capabilities",
	"get_mobile_system_configuration",
	"set_mobile_system_configuration",
	"get_mobile_system_runtime",
	"simulate_mobile_system_state",
	"reset_mobile_system_runtime",
	"get_grpc_transport_capabilities",
	"get_grpc_transport_configuration",
	"set_grpc_transport_configuration",
	"invoke_grpc_unary",
	"invoke_grpc_server_stream",
	"get_grpc_transport_runtime",
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

describe("mcp/mobile bridge", () => {
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		clearUndoRedo();
		scene = new Scene(new NullEngine());
		options = {
			editor: {
				state: { projectPath: "/tmp/mobile/project.bjseditor", projectSettings: { identity: { applicationId: "com.example.mobile" } } },
				layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() }, mobile: { forceUpdate: vi.fn() } },
			},
		};
	});

	afterEach(() => {
		clearUndoRedo();
		scene.dispose();
	});

	test("registers every Mobile editor endpoint and advertises its feature flags", () => {
		for (const endpoint of mobileEndpoints) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		expect(getEditorCapabilities(scene, {}, options).features).toMatchObject({
			mobileNativeWrapperScaffolds: true,
			mobileTouchControls: true,
			mobileTouchLayoutWorkspace: true,
			mobileNativePackaging: true,
			mobileEnvironmentSigning: true,
			mobileConnectedDevices: true,
			mobileBoundedLogCapture: true,
			mobileStoreSubmissionPlans: true,
			adaptivePerformanceBasicProvider: true,
			adaptivePerformanceAppleBridge: true,
			adaptivePerformanceScalers: true,
			adaptivePerformanceThermalSimulation: true,
			androidWindowInsetPolicy: true,
			iosThermalFrameRateControl: true,
			visionOSMinimumTargetVersion: true,
			portableGrpcWebTransport: true,
		});
	});

	test("routes exact Touch Controls and deployment authoring through the endpoint map", async () => {
		const created: any = await MCPEndpoints.create_touch_control(
			scene,
			{ expectedRevision: 1, control: { name: "Jump", type: "button", controlPath: "<touch>/jump" } },
			options
		);
		expect(created).toMatchObject({ configuration: { revision: 2 }, control: { name: "Jump" } });
		expect(await MCPEndpoints.get_touch_controls_configuration(scene, {}, options)).toMatchObject({ revision: 2, controls: [{ id: created.control.id }] });
		const deployment: any = await MCPEndpoints.set_mobile_deployment_configuration(
			scene,
			{ expectedRevision: 1, changes: { android: { format: "apk", variant: "debug" } } },
			options
		);
		expect(deployment).toMatchObject({ revision: 2, android: { applicationId: "com.example.mobile", format: "apk", variant: "debug" } });
		expect(await MCPEndpoints.get_mobile_deployment_configuration(scene, {}, options)).toEqual(deployment);
		expect(await MCPEndpoints.get_mobile_capabilities(scene, {}, options)).toMatchObject({
			version: 1,
			mcpToolCount: 38,
			targets: ["android", "ios"],
			adaptivePerformance: { providers: ["basic", "apple"], appleTargets: ["ios", "tvos", "visionos"] },
			grpcTransport: { protocols: ["grpc-web-binary", "grpc-web-text", "connect"], calls: ["unary", "server-streaming"] },
		});
		const adaptive: any = await MCPEndpoints.set_adaptive_performance_configuration(
			scene,
			{ expectedRevision: 1, changes: { enabled: true, provider: "basic", sampleFrames: 2, thermalActionDelaySeconds: 0 } },
			options
		);
		expect(adaptive).toMatchObject({ configuration: { revision: 2, enabled: true, provider: "basic" }, runtime: { activeProvider: "basic" } });
		expect(await MCPEndpoints.simulate_adaptive_performance_state(scene, { expectedRevision: 2, thermalState: "serious", frameTimeMs: 20, repeat: 2 }, options)).toMatchObject({
			runtime: { thermalWarning: true, providerEvents: [{ source: "editor-simulation" }] },
		});
	});
});
