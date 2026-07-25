import type { Editor } from "../../editor/main";
import { normalizePrefabStageSettings, prefabStageSettingsFingerprint } from "../../project/prefab-stage";
import { saveProjectConfiguration } from "../../project/save/save";
import type { IEditorPrefabStageSettings } from "../../project/typings";

const prefabStageSettingsMutationLanes = new WeakMap<object, Promise<void>>();

export interface IPrefabStageSettingsSnapshot {
	settings: IEditorPrefabStageSettings;
	fingerprint: string;
}

/** Reads the complete normalized Stage settings and their exact project-local lease. */
export function getPrefabStageSettingsForEditor(editor: Editor): IPrefabStageSettingsSnapshot {
	const settings = normalizePrefabStageSettings(editor.state.prefabStage);
	return { settings, fingerprint: prefabStageSettingsFingerprint(settings) };
}

/** Serializes exact settings leases per editor window without blocking other projects. */
async function runPrefabStageSettingsMutation<T>(editor: object, operation: () => Promise<T>): Promise<T> {
	const previous = prefabStageSettingsMutationLanes.get(editor) ?? Promise.resolve();
	let release = (): void => undefined;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	prefabStageSettingsMutationLanes.set(editor, current);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		if (prefabStageSettingsMutationLanes.get(editor) === current) {
			prefabStageSettingsMutationLanes.delete(editor);
		}
	}
}

/** Replaces and persists the complete Stage settings document under one exact fingerprint. */
export async function replacePrefabStageSettingsForEditor(editor: Editor, expectedFingerprint: string, value: unknown): Promise<IPrefabStageSettingsSnapshot> {
	return runPrefabStageSettingsMutation(editor, async () => {
		const current = getPrefabStageSettingsForEditor(editor);
		if (expectedFingerprint !== current.fingerprint) {
			throw new Error(`Prefab Stage settings changed. Read them again and use current fingerprint ${current.fingerprint}.`);
		}
		const settings = normalizePrefabStageSettings(value);
		await new Promise<void>((resolve) => editor.setState({ prefabStage: settings }, () => resolve()));
		try {
			await saveProjectConfiguration(editor);
		} catch (error) {
			// Keep the live editor lease aligned with the persisted project if publication fails.
			await new Promise<void>((resolve) => editor.setState({ prefabStage: current.settings }, () => resolve()));
			throw error;
		}
		return getPrefabStageSettingsForEditor(editor);
	});
}
