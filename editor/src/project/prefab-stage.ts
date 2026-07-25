import { createHash } from "crypto";

import { EditorPrefabStageContextAppearance, EditorPrefabStageEnvironment, EditorPrefabStageMode, IEditorPrefabStageSettings } from "./typings";

export const defaultPrefabStageSettings: IEditorPrefabStageSettings = {
	version: 1,
	mode: "isolation",
	contextAppearance: "gray",
	showOverrides: true,
	autoSave: false,
	environment: "neutral",
	backgroundColor: [0.025, 0.03, 0.04, 1],
	lightIntensity: 1.2,
};

function finiteColorComponent(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

/** Normalizes persisted or MCP-provided Prefab Stage settings into the closed version-1 model. */
export function normalizePrefabStageSettings(value: unknown): IEditorPrefabStageSettings {
	const candidate = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const color = Array.isArray(candidate.backgroundColor) ? candidate.backgroundColor : defaultPrefabStageSettings.backgroundColor;
	const intensity =
		typeof candidate.lightIntensity === "number" && Number.isFinite(candidate.lightIntensity) ? candidate.lightIntensity : defaultPrefabStageSettings.lightIntensity;
	return {
		version: 1,
		mode: (["isolation", "context"] as EditorPrefabStageMode[]).includes(candidate.mode as EditorPrefabStageMode)
			? (candidate.mode as EditorPrefabStageMode)
			: defaultPrefabStageSettings.mode,
		contextAppearance: (["normal", "gray", "hidden"] as EditorPrefabStageContextAppearance[]).includes(candidate.contextAppearance as EditorPrefabStageContextAppearance)
			? (candidate.contextAppearance as EditorPrefabStageContextAppearance)
			: defaultPrefabStageSettings.contextAppearance,
		showOverrides: typeof candidate.showOverrides === "boolean" ? candidate.showOverrides : defaultPrefabStageSettings.showOverrides,
		autoSave: typeof candidate.autoSave === "boolean" ? candidate.autoSave : defaultPrefabStageSettings.autoSave,
		environment: (["neutral", "scene"] as EditorPrefabStageEnvironment[]).includes(candidate.environment as EditorPrefabStageEnvironment)
			? (candidate.environment as EditorPrefabStageEnvironment)
			: defaultPrefabStageSettings.environment,
		backgroundColor: [
			finiteColorComponent(color[0], defaultPrefabStageSettings.backgroundColor[0]),
			finiteColorComponent(color[1], defaultPrefabStageSettings.backgroundColor[1]),
			finiteColorComponent(color[2], defaultPrefabStageSettings.backgroundColor[2]),
			finiteColorComponent(color[3], defaultPrefabStageSettings.backgroundColor[3]),
		],
		lightIntensity: Math.max(0, Math.min(16, intensity)),
	};
}

/** Returns the exact SHA-256 lease for a normalized Prefab Stage settings document. */
export function prefabStageSettingsFingerprint(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(normalizePrefabStageSettings(value)))
		.digest("hex");
}
