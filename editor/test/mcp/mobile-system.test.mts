import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import {
	getMobileSystemCapabilities,
	getMobileSystemConfiguration,
	getMobileSystemRuntime,
	resetMobileSystemRuntime,
	setMobileSystemConfiguration,
	simulateMobileSystemState,
} from "../../src/mcp/mobile/system-runtime";
import { getGrpcTransportCapabilities, getGrpcTransportConfiguration, getGrpcTransportRuntime, invokeGrpcUnary, setGrpcTransportConfiguration } from "../../src/mcp/mobile/grpc";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

describe("mcp/mobile-system", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				mobile: { forceUpdate: vi.fn() },
				preview: { scene: null as Scene | null },
			},
		},
	} as any;

	beforeEach(() => {
		clearUndoRedo();
		engine = new NullEngine();
		scene = new Scene(engine);
		options.editor.layout.preview.scene = scene;
	});

	afterEach(() => {
		clearUndoRedo();
		vi.unstubAllGlobals();
		scene.dispose();
		engine.dispose();
	});

	test("maps all 12 bridge endpoints and publishes honest capabilities", () => {
		for (const endpoint of [
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
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		expect(getMobileSystemCapabilities()).toMatchObject({ version: 1, iosThermalFrameRate: { seriousDefaultFps: 30, criticalDefaultFps: 15 } });
		expect(getGrpcTransportCapabilities()).toMatchObject({ protocols: ["grpc-web-binary", "grpc-web-text", "connect"] });
	});

	test("authors Mobile System policy with exact revisions, Undo/Redo, labeled evidence, and reset", () => {
		expect(getMobileSystemConfiguration(scene)).toMatchObject({ configuration: { revision: 1, platform: "auto" } });
		const configured = setMobileSystemConfiguration(
			scene,
			{
				expectedRevision: 1,
				changes: {
					platform: "ios",
					android: { systemBarsBehavior: "show-transient-bars-by-swipe", requestedVisibleWindowInsets: ["statusBars", "ime"] },
					iosThermalFrameRate: { seriousThermalStateFps: 30, criticalThermalStateFps: 15 },
				},
			},
			options
		) as any;
		expect(configured.configuration).toMatchObject({ revision: 2, platform: "ios", android: { requestedVisibleWindowInsets: ["statusBars", "ime"] } });
		expect(() => setMobileSystemConfiguration(scene, { expectedRevision: 1, changes: { platform: "android" } }, options)).toThrow("revision is stale");
		expect(() => setMobileSystemConfiguration(scene, { expectedRevision: 2, changes: { unknown: true } }, options)).toThrow("unsupported fields");
		const simulated = simulateMobileSystemState(
			scene,
			{ expectedRevision: 2, thermalState: "critical", windowInsets: { left: 0, top: 44, right: 0, bottom: 60 }, visibleWindowInsets: ["statusBars"] },
			options
		) as any;
		expect(simulated).toMatchObject({
			simulation: true,
			hardwareEvidence: false,
			runtime: { thermalState: "critical", appliedTargetFrameRate: 15, windowInsetsSource: "editor-simulation" },
		});
		expect(getMobileSystemRuntime(scene)).toMatchObject({ configurationRevision: 2, runtime: { thermalSource: "editor-simulation" } });
		expect(resetMobileSystemRuntime(scene, { expectedRevision: 2 }, options)).toMatchObject({ runtime: { thermalState: "unknown", appliedTargetFrameRate: null } });
		undo();
		expect(getMobileSystemConfiguration(scene)).toMatchObject({ configuration: { revision: 1, platform: "auto" } });
		redo();
		expect(getMobileSystemConfiguration(scene)).toMatchObject({ configuration: { revision: 2, platform: "ios" } });
	});

	test("authors gRPC transport without persisted secrets and invokes a bounded unary call", async () => {
		expect(getGrpcTransportConfiguration(scene)).toMatchObject({ configuration: { revision: 1, enabled: false } });
		const configured = setGrpcTransportConfiguration(
			scene,
			{ expectedRevision: 1, changes: { enabled: true, endpoint: "http://localhost:8080", protocol: "connect", defaultTimeoutMs: 1000 } },
			options
		) as any;
		expect(configured.configuration).toMatchObject({ revision: 2, enabled: true, protocol: "connect" });
		expect(() => setGrpcTransportConfiguration(scene, { expectedRevision: 2, changes: { defaultMetadata: { authorization: "secret" } } }, options)).toThrow(
			"transiently per call"
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }))
		);
		await expect(
			invokeGrpcUnary(scene, { expectedRevision: 2, service: "zvibe.Game", method: "Ping", payloadBase64: "AA==", metadata: { authorization: "Bearer transient" } })
		).resolves.toMatchObject({ configurationRevision: 2, kind: "unary", response: { grpcStatus: 0, messagesBase64: ["AQID"] } });
		expect(getGrpcTransportRuntime(scene)).toMatchObject({ runtime: { calls: [{ service: "zvibe.Game", method: "Ping", succeeded: true, messageCount: 1 }] } });
	});
});
