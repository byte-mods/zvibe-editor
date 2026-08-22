import { Scene } from "babylonjs";
import {
	configureGrpcTransport,
	getGrpcTransportCapabilities as getSharedGrpcTransportCapabilities,
	getGrpcTransportRuntime as getSharedGrpcTransportRuntime,
	grpcTransportMetadataKey,
	grpcTransportProtocols,
	invokeGrpcServerStream as invokeSharedGrpcServerStream,
	invokeGrpcUnary as invokeSharedGrpcUnary,
	validateGrpcTransportConfiguration,
} from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";

interface IGrpcSnapshot {
	hadMetadata: boolean;
	hadConfiguration: boolean;
	configuration: unknown;
}

function assertRecord(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function snapshot(scene: Scene): IGrpcSnapshot {
	return {
		hadMetadata: Boolean(scene.metadata),
		hadConfiguration: Boolean(scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, grpcTransportMetadataKey)),
		configuration: structuredClone(scene.metadata?.[grpcTransportMetadataKey]),
	};
}

function runtimeScene(scene: Scene): Parameters<typeof configureGrpcTransport>[0] {
	return scene as unknown as Parameters<typeof configureGrpcTransport>[0];
}

function refresh(scene: Scene, options: IMCPActionOptions): void {
	configureGrpcTransport(runtimeScene(scene));
	options.editor.layout.inspector?.setEditedObject?.(scene);
	options.editor.layout.inspector?.forceUpdate?.();
	(options.editor.layout as any).mobile?.forceUpdate?.();
}

function restore(scene: Scene, value: IGrpcSnapshot, options: IMCPActionOptions): void {
	if (value.hadConfiguration) {
		scene.metadata ??= {};
		scene.metadata[grpcTransportMetadataKey] = structuredClone(value.configuration);
	} else if (scene.metadata) {
		delete scene.metadata[grpcTransportMetadataKey];
		if (!value.hadMetadata && Object.keys(scene.metadata).length === 0) {
			scene.metadata = null;
		}
	}
	refresh(scene, options);
}

export function getGrpcTransportCapabilities(): object {
	return getSharedGrpcTransportCapabilities();
}

export function getGrpcTransportConfiguration(scene: Scene): object {
	return {
		configuration: structuredClone(validateGrpcTransportConfiguration(scene.metadata?.[grpcTransportMetadataKey])),
		runtime: structuredClone(getSharedGrpcTransportRuntime(runtimeScene(scene))),
	};
}

export function setGrpcTransportConfiguration(scene: Scene, data: unknown, options: IMCPActionOptions): object {
	assertRecord(data, ["expectedRevision", "changes", "endpoint", "collaborationToken"], "set_grpc_transport_configuration input");
	assertRecord(
		data.changes,
		["enabled", "endpoint", "protocol", "defaultTimeoutMs", "maximumSendMessageBytes", "maximumReceiveMessageBytes", "credentials", "defaultMetadata"],
		"gRPC transport changes"
	);
	if (!Object.keys(data.changes).length) {
		throw new Error("gRPC transport changes must contain at least one field.");
	}
	if (data.changes.protocol !== undefined && !grpcTransportProtocols.includes(data.changes.protocol as (typeof grpcTransportProtocols)[number])) {
		throw new Error("gRPC transport protocol is invalid.");
	}
	const current = validateGrpcTransportConfiguration(scene.metadata?.[grpcTransportMetadataKey]);
	if (data.expectedRevision !== current.revision) {
		throw new Error(`gRPC transport revision is stale: expected ${String(data.expectedRevision)}, current ${current.revision}.`);
	}
	const next = validateGrpcTransportConfiguration({ ...current, ...structuredClone(data.changes), revision: current.revision + 1 });
	const previous = snapshot(scene);
	scene.metadata ??= {};
	scene.metadata[grpcTransportMetadataKey] = structuredClone(next);
	try {
		refresh(scene, options);
	} catch (error) {
		restore(scene, previous, options);
		throw error;
	}
	registerUndoRedo({
		undo: () => restore(scene, previous, options),
		redo: () => {
			scene.metadata ??= {};
			scene.metadata[grpcTransportMetadataKey] = structuredClone(next);
			refresh(scene, options);
		},
	});
	return { configuration: structuredClone(next), runtime: structuredClone(getSharedGrpcTransportRuntime(runtimeScene(scene))) };
}

function assertCall(data: unknown, label: string): asserts data is Record<string, unknown> {
	assertRecord(data, ["expectedRevision", "service", "method", "payloadBase64", "metadata", "timeoutMs", "endpoint", "collaborationToken"], label);
	const configurationFields = { ...data };
	delete configurationFields.expectedRevision;
	delete configurationFields.endpoint;
	delete configurationFields.collaborationToken;
	if (configurationFields.service === undefined || configurationFields.method === undefined || configurationFields.payloadBase64 === undefined) {
		throw new Error(`${label} requires service, method, and payloadBase64.`);
	}
}

async function invoke(scene: Scene, data: unknown, kind: "unary" | "server-streaming"): Promise<object> {
	assertCall(data, kind === "unary" ? "invoke_grpc_unary input" : "invoke_grpc_server_stream input");
	const configuration = validateGrpcTransportConfiguration(scene.metadata?.[grpcTransportMetadataKey]);
	if (data.expectedRevision !== configuration.revision) {
		throw new Error(`gRPC transport revision is stale: expected ${String(data.expectedRevision)}, current ${configuration.revision}.`);
	}
	const request = {
		service: data.service,
		method: data.method,
		payloadBase64: data.payloadBase64,
		metadata: data.metadata,
		timeoutMs: data.timeoutMs,
	};
	const response = kind === "unary" ? await invokeSharedGrpcUnary(runtimeScene(scene), request) : await invokeSharedGrpcServerStream(runtimeScene(scene), request);
	return { configurationRevision: configuration.revision, kind, response };
}

export function invokeGrpcUnary(scene: Scene, data: unknown): Promise<object> {
	return invoke(scene, data, "unary");
}

export function invokeGrpcServerStream(scene: Scene, data: unknown): Promise<object> {
	return invoke(scene, data, "server-streaming");
}

export function getGrpcTransportRuntime(scene: Scene): object {
	const configuration = validateGrpcTransportConfiguration(scene.metadata?.[grpcTransportMetadataKey]);
	let runtime = getSharedGrpcTransportRuntime(runtimeScene(scene));
	if (runtime.configurationRevision !== configuration.revision) {
		runtime = configureGrpcTransport(runtimeScene(scene), configuration);
	}
	return { configurationRevision: configuration.revision, runtime: structuredClone(runtime) };
}
