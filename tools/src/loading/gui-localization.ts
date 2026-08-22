import { LocalizationManager } from "./localization";
import { LocalizationSmartValue } from "./localization-smart";
import { normalizeLocaleId } from "./localization-model";

export type GUILocalizationProperty = "source" | "text";

export interface IGUILocalizationBinding {
	controlId: string;
	property: GUILocalizationProperty;
	table: string;
	key: string;
	localeOverride: string | null;
	arguments: LocalizationSmartValue;
	isolateBidirectionalText: boolean;
	mirrorHorizontalAlignment: boolean;
}

export interface IGUILocalizationControlLike {
	text?: string;
	source?: string;
	textHorizontalAlignment?: number;
}

export interface IGUILocalizationEvidence {
	controlId: string;
	property: GUILocalizationProperty;
	table: string;
	key: string;
	requestedLocale: string;
	resolvedLocale: string;
	direction: "ltr" | "rtl";
	assetPath: string | null;
}

export interface IApplyGUILocalizationOptions {
	bindings: IGUILocalizationBinding[];
	controls: ReadonlyMap<string, IGUILocalizationControlLike>;
	localization: LocalizationManager;
	rootUrl: string;
	onCleanup: (callback: () => void) => void;
	onObserver: (observer: { remove: () => void }) => void;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error(`${label} must be a stable 1-128 character identifier.`);
	}
	return value;
}

function boundedName(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} must contain 1-128 characters without line breaks.`);
	}
	return value.trim();
}

function jsonValue(value: unknown, depth = 0): LocalizationSmartValue {
	if (depth > 12) {
		throw new Error("GUI localization arguments exceed 12 nested levels.");
	}
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("GUI localization arguments cannot contain non-finite numbers.");
		}
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) {
			throw new Error("GUI localization argument arrays support at most 64 values.");
		}
		return value.map((entry) => jsonValue(entry, depth + 1));
	}
	const source = object(value, "GUI localization argument");
	if (Object.keys(source).length > 64) {
		throw new Error("GUI localization argument objects support at most 64 fields.");
	}
	return Object.fromEntries(
		Object.entries(source).map(([key, entry]) => {
			if (!key || key.length > 128) {
				throw new Error("GUI localization argument field names must contain 1-128 characters.");
			}
			return [key, jsonValue(entry, depth + 1)];
		})
	);
}

/** Validates a persisted GUI localization binding against the current control hierarchy. */
export function normalizeGUILocalizationBinding(value: unknown, controlIds?: ReadonlySet<string>): IGUILocalizationBinding {
	const source = object(value, "GUI localization binding");
	const controlId = identifier(source.controlId, "GUI localization controlId");
	if (controlIds && !controlIds.has(controlId)) {
		throw new Error(`GUI localization binding references unknown control "${controlId}".`);
	}
	if (source.property !== "text" && source.property !== "source") {
		throw new Error("GUI localization property must be text or source.");
	}
	for (const key of ["isolateBidirectionalText", "mirrorHorizontalAlignment"] as const) {
		if (source[key] !== undefined && typeof source[key] !== "boolean") {
			throw new Error(`GUI localization ${key} must be boolean.`);
		}
	}
	return {
		controlId,
		property: source.property,
		table: boundedName(source.table, "GUI localization table"),
		key: boundedName(source.key, "GUI localization key"),
		localeOverride: source.localeOverride === null || source.localeOverride === undefined ? null : normalizeLocaleId(source.localeOverride),
		arguments: jsonValue(source.arguments ?? {}),
		isolateBidirectionalText: source.isolateBidirectionalText !== false,
		mirrorHorizontalAlignment: source.mirrorHorizontalAlignment !== false,
	};
}

function isolated(value: string, direction: "ltr" | "rtl"): string {
	return `${direction === "rtl" ? "\u2067" : "\u2066"}${value}\u2069`;
}

/** Applies all bindings now and on later locale changes through one cleanup-aware registration. */
export async function applyGUILocalizationBindings(options: IApplyGUILocalizationOptions): Promise<IGUILocalizationEvidence[]> {
	const originalAlignments = new Map<string, number | undefined>();
	const originalValues = new Map<string, string | undefined>();
	const objectUrls = new Set<string>();
	const evidence: IGUILocalizationEvidence[] = [];
	let active = true;
	let generation = 0;
	const render = async (): Promise<void> => {
		const renderGeneration = ++generation;
		const nextUrls = new Set<string>();
		const updates: Array<{ binding: IGUILocalizationBinding; control: IGUILocalizationControlLike; value: string; evidence: IGUILocalizationEvidence }> = [];
		let committed = false;
		try {
			for (const binding of options.bindings) {
				const control = options.controls.get(binding.controlId);
				if (!control) {
					continue;
				}
				const locale = binding.localeOverride ?? options.localization.locale;
				if (binding.property === "text") {
					const resolution = options.localization.resolveString(binding.table, binding.key, locale, binding.arguments);
					if (!resolution) {
						throw new Error(`GUI localized string was not found: ${binding.table}/${binding.key}/${locale}`);
					}
					updates.push({
						binding,
						control,
						value: binding.isolateBidirectionalText ? isolated(resolution.value, resolution.direction) : resolution.value,
						evidence: { ...resolution, controlId: binding.controlId, property: binding.property, assetPath: null },
					});
				} else {
					const resolution = options.localization.resolveAsset(binding.table, binding.key, locale);
					if (!resolution) {
						throw new Error(`GUI localized asset was not found: ${binding.table}/${binding.key}/${locale}`);
					}
					if (resolution.value.type !== "texture") {
						throw new Error(`GUI source localization requires a texture asset, received ${resolution.value.type}.`);
					}
					let value = `${options.rootUrl}${resolution.value.path}`;
					if (resolution.value.addressableGroup && resolution.value.address) {
						const loaded = await options.localization.loadAsset(binding.table, binding.key, locale);
						value = URL.createObjectURL(new Blob([loaded.bytes], { type: "image/*" }));
						nextUrls.add(value);
					}
					updates.push({
						binding,
						control,
						value,
						evidence: { ...resolution, controlId: binding.controlId, property: binding.property, assetPath: resolution.value.path },
					});
				}
			}
			if (!active || renderGeneration !== generation) {
				return;
			}
			for (const url of objectUrls) {
				URL.revokeObjectURL(url);
			}
			objectUrls.clear();
			nextUrls.forEach((url) => objectUrls.add(url));
			evidence.length = 0;
			for (const update of updates) {
				const { binding, control } = update;
				const originalKey = `${binding.controlId}:${binding.property}`;
				if (!originalValues.has(originalKey)) {
					originalValues.set(originalKey, control[binding.property]);
				}
				if (!originalAlignments.has(binding.controlId)) {
					originalAlignments.set(binding.controlId, control.textHorizontalAlignment);
				}
				control[binding.property] = update.value;
				const original = originalAlignments.get(binding.controlId);
				if (binding.property === "text" && binding.mirrorHorizontalAlignment && original !== undefined) {
					control.textHorizontalAlignment = update.evidence.direction === "rtl" ? (original === 0 ? 2 : original === 2 ? 0 : original) : original;
				}
				evidence.push(update.evidence);
			}
			committed = true;
		} finally {
			if (!committed) {
				for (const url of nextUrls) {
					URL.revokeObjectURL(url);
				}
			}
		}
	};
	await render();
	options.onObserver(
		options.localization.onLocaleChangedObservable.add(() => {
			void render().catch((error) => console.error(error instanceof Error ? error.message : String(error)));
		})
	);
	options.onCleanup(() => {
		active = false;
		generation++;
		for (const [key, value] of originalValues) {
			const separator = key.lastIndexOf(":");
			const control = options.controls.get(key.slice(0, separator));
			if (control) {
				control[key.slice(separator + 1) as GUILocalizationProperty] = value;
			}
		}
		for (const [controlId, alignment] of originalAlignments) {
			const control = options.controls.get(controlId);
			if (control && alignment !== undefined) {
				control.textHorizontalAlignment = alignment;
			}
		}
		for (const url of objectUrls) {
			URL.revokeObjectURL(url);
		}
	});
	return evidence;
}
