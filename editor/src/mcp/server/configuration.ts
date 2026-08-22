import { Scene } from "babylonjs";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";
import { IConsoleServerConfiguration, normalizeConsoleServerConfiguration } from "./model";

interface IConfigurationSnapshot {
	hadMetadata: boolean;
	hadConfiguration: boolean;
	configuration: unknown;
}

const blocks = {
	headless: ["buildProfileId", "initialScenePath", "publicHost", "port", "tickRate", "maximumCatchUpSteps", "maximumPlayers", "joinCodeEnvironment", "healthPath", "metricsPath"],
	container: ["engine", "image", "dockerfilePath", "registryCredentialEnvironment"],
	deployment: ["provider", "replicas", "namespace", "kubeContext", "consoleProviderId"],
	observability: ["logLimitBytes", "metrics", "portableProfiling"],
};

function record(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function snapshot(scene: Scene): IConfigurationSnapshot {
	return {
		hadMetadata: Boolean(scene.metadata),
		hadConfiguration: Boolean(scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, "babylonEditorConsoleServer")),
		configuration: structuredClone(scene.metadata?.babylonEditorConsoleServer),
	};
}

function refresh(scene: Scene, options: IMCPActionOptions): void {
	options.editor.layout.inspector?.setEditedObject?.(scene);
	options.editor.layout.inspector?.forceUpdate?.();
	(options.editor.layout as any).consoleServer?.forceUpdate?.();
}

function restore(scene: Scene, value: IConfigurationSnapshot, options: IMCPActionOptions): void {
	if (value.hadConfiguration) {
		scene.metadata ??= {};
		scene.metadata.babylonEditorConsoleServer = structuredClone(value.configuration);
	} else if (scene.metadata) {
		delete scene.metadata.babylonEditorConsoleServer;
		if (!value.hadMetadata && Object.keys(scene.metadata).length === 0) {
			scene.metadata = null;
		}
	}
	refresh(scene, options);
}

export function getConsoleServerConfiguration(scene: Scene): IConsoleServerConfiguration {
	return normalizeConsoleServerConfiguration(scene.metadata?.babylonEditorConsoleServer);
}

/** Patches one or more complete nested blocks under an exact scene revision. */
export function setConsoleServerConfiguration(scene: Scene, data: unknown, options: IMCPActionOptions): IConsoleServerConfiguration {
	record(data, ["expectedRevision", "changes", "endpoint", "collaborationToken"], "set_console_server_configuration input");
	record(data.changes, Object.keys(blocks), "Console/server changes");
	if (!Object.keys(data.changes).length) {
		throw new Error("Console/server changes must contain at least one block.");
	}
	const current = getConsoleServerConfiguration(scene);
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== current.revision) {
		throw new Error(`Console/server revision is stale: expected ${String(data.expectedRevision)}, current ${current.revision}.`);
	}
	const changes = structuredClone(data.changes) as Record<string, Record<string, unknown>>;
	for (const [name, value] of Object.entries(changes)) {
		record(value, blocks[name as keyof typeof blocks], `${name} changes`);
		if (!Object.keys(value).length) {
			throw new Error(`${name} changes must contain at least one field.`);
		}
	}
	const next = normalizeConsoleServerConfiguration({
		...current,
		revision: current.revision + 1,
		...Object.fromEntries(Object.entries(changes).map(([name, value]) => [name, { ...(current as any)[name], ...value }])),
	});
	const previous = snapshot(scene);
	scene.metadata ??= {};
	scene.metadata.babylonEditorConsoleServer = structuredClone(next);
	refresh(scene, options);
	registerUndoRedo({
		undo: () => restore(scene, previous, options),
		redo: () => {
			scene.metadata ??= {};
			scene.metadata.babylonEditorConsoleServer = structuredClone(next);
			refresh(scene, options);
		},
	});
	return structuredClone(next);
}
