export const editorUserPreferencesVersion = 1 as const;
export const editorUserPreferencesStorageKey = "zvibe-editor-user-preferences-v1";

export interface IEditorUserPreferences {
	version: typeof editorUserPreferencesVersion;
	revision: number;
	appearance: {
		theme: "system" | "light" | "dark";
		uiScale: number;
	};
	workflow: {
		autoSave: boolean;
		autoSaveIntervalMinutes: number;
		confirmDestructiveActions: boolean;
	};
	externalTools: {
		scriptEditorCommand: string;
		imageEditorCommand: string;
		diffToolCommand: string;
	};
	diagnostics: {
		logLevel: "error" | "warning" | "info" | "verbose";
	};
}

interface IStorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function record(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	return values.includes(value as T) ? (value as T) : fallback;
}

function command(value: unknown, fallback: string): string {
	return typeof value === "string" ? value.trim().slice(0, 1024) : fallback;
}

export function createDefaultEditorUserPreferences(): IEditorUserPreferences {
	return {
		version: editorUserPreferencesVersion,
		revision: 0,
		appearance: { theme: "dark", uiScale: 0.8 },
		workflow: { autoSave: false, autoSaveIntervalMinutes: 5, confirmDestructiveActions: true },
		externalTools: { scriptEditorCommand: "code", imageEditorCommand: "", diffToolCommand: "" },
		diagnostics: { logLevel: "info" },
	};
}

export function normalizeEditorUserPreferences(value: unknown): IEditorUserPreferences {
	const source = record(value);
	const appearance = record(source.appearance);
	const workflow = record(source.workflow);
	const externalTools = record(source.externalTools);
	const diagnostics = record(source.diagnostics);
	const defaults = createDefaultEditorUserPreferences();
	return {
		version: editorUserPreferencesVersion,
		revision: typeof source.revision === "number" && Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
		appearance: {
			theme: choice(appearance.theme, ["system", "light", "dark"], defaults.appearance.theme),
			uiScale: typeof appearance.uiScale === "number" && Number.isFinite(appearance.uiScale) ? Math.min(2, Math.max(0.5, appearance.uiScale)) : defaults.appearance.uiScale,
		},
		workflow: {
			autoSave: workflow.autoSave === true,
			autoSaveIntervalMinutes:
				typeof workflow.autoSaveIntervalMinutes === "number" && Number.isInteger(workflow.autoSaveIntervalMinutes)
					? Math.min(120, Math.max(1, workflow.autoSaveIntervalMinutes))
					: defaults.workflow.autoSaveIntervalMinutes,
			confirmDestructiveActions: workflow.confirmDestructiveActions !== false,
		},
		externalTools: {
			scriptEditorCommand: command(externalTools.scriptEditorCommand, defaults.externalTools.scriptEditorCommand),
			imageEditorCommand: command(externalTools.imageEditorCommand, defaults.externalTools.imageEditorCommand),
			diffToolCommand: command(externalTools.diffToolCommand, defaults.externalTools.diffToolCommand),
		},
		diagnostics: { logLevel: choice(diagnostics.logLevel, ["error", "warning", "info", "verbose"], defaults.diagnostics.logLevel) },
	};
}

export function readEditorUserPreferences(storage: IStorageLike = localStorage): IEditorUserPreferences {
	try {
		const stored = storage.getItem(editorUserPreferencesStorageKey);
		if (stored) {
			return normalizeEditorUserPreferences(JSON.parse(stored));
		}
		const migrated = createDefaultEditorUserPreferences();
		const legacyTheme = storage.getItem("editor-theme");
		if (legacyTheme === "light" || legacyTheme === "dark") {
			migrated.appearance.theme = legacyTheme;
		}
		return migrated;
	} catch {
		return createDefaultEditorUserPreferences();
	}
}

export function writeEditorUserPreferences(preferences: IEditorUserPreferences, storage: IStorageLike = localStorage): void {
	storage.setItem(editorUserPreferencesStorageKey, JSON.stringify(preferences));
	storage.setItem("editor-theme", preferences.appearance.theme === "system" ? "dark" : preferences.appearance.theme);
}

export function updateEditorUserPreferences(current: IEditorUserPreferences, expectedRevision: number, patch: Partial<IEditorUserPreferences>): IEditorUserPreferences {
	if (current.revision !== expectedRevision) {
		throw new Error(`Stale Editor Preferences revision ${expectedRevision}; current revision is ${current.revision}.`);
	}
	return normalizeEditorUserPreferences({
		...current,
		...patch,
		appearance: { ...current.appearance, ...record(patch.appearance) },
		workflow: { ...current.workflow, ...record(patch.workflow) },
		externalTools: { ...current.externalTools, ...record(patch.externalTools) },
		diagnostics: { ...current.diagnostics, ...record(patch.diagnostics) },
		revision: current.revision + 1,
	});
}

export function applyEditorUserPreferences(preferences: IEditorUserPreferences): void {
	const systemDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
	const dark = preferences.appearance.theme === "dark" || (preferences.appearance.theme === "system" && systemDark);
	document.body.classList.toggle("dark", dark);
}
