import { ISceneDecoratorData } from "./apply";

export type VisibleInInspectorDecoratorType =
	| "number"
	| "boolean"
	| "string"
	| "vector2"
	| "vector3"
	| "color3"
	| "color4"
	| "entity"
	| "texture"
	| "keymap"
	| "asset"
	| "array"
	| "list";

export type VisibleInInspectorDecoratorConfiguration = {
	type: VisibleInInspectorDecoratorType;
	description?: string;
};

export type VisibleInInspectorCollectionElementType = Exclude<VisibleInInspectorDecoratorType, "array" | "list">;

export interface IVisibleInInspectorCollectionStyle {
	icon?: string;
	accentColor?: string;
	variant?: "flat" | "cards" | "outlined";
	density?: "compact" | "normal" | "comfortable";
	showIndices?: boolean;
	striped?: boolean;
}

export type VisibleInInspectorDecoratorCollectionConfiguration = VisibleInInspectorDecoratorConfiguration & {
	type: "array" | "list";
	elementType: VisibleInInspectorCollectionElementType;
	minItems?: number;
	maxItems?: number;
	defaultItem?: unknown;
	styleType?: string;
	style?: IVisibleInInspectorCollectionStyle;
};

const collectionElementTypes = new Set<VisibleInInspectorCollectionElementType>([
	"number",
	"boolean",
	"string",
	"vector2",
	"vector3",
	"color3",
	"color4",
	"entity",
	"texture",
	"keymap",
	"asset",
]);

function validateCollectionDefaultItem(type: VisibleInInspectorCollectionElementType, value: unknown): void {
	if (value === undefined) {
		return;
	}
	if ((type === "number" || type === "keymap") && (typeof value !== "number" || !Number.isFinite(value))) {
		throw new Error(`Inspector collection ${type} defaultItem must be a finite number.`);
	}
	if (type === "boolean" && typeof value !== "boolean") {
		throw new Error("Inspector collection boolean defaultItem must be boolean.");
	}
	if (type === "string" && typeof value !== "string") {
		throw new Error("Inspector collection string defaultItem must be a string.");
	}
	if (["entity", "asset"].includes(type) && value !== null && typeof value !== "string") {
		throw new Error(`Inspector collection ${type} defaultItem must be a string or null.`);
	}
	const componentCounts: Partial<Record<VisibleInInspectorCollectionElementType, number>> = { vector2: 2, vector3: 3, color3: 3, color4: 4 };
	const componentCount = componentCounts[type];
	if (componentCount && (!Array.isArray(value) || value.length !== componentCount || value.some((component) => typeof component !== "number" || !Number.isFinite(component)))) {
		throw new Error(`Inspector collection ${type} defaultItem must contain ${componentCount} finite numbers.`);
	}
}

function visibleAsCollection(
	type: "array" | "list",
	elementType: VisibleInInspectorCollectionElementType,
	label?: string,
	configuration?: Omit<VisibleInInspectorDecoratorCollectionConfiguration, "type" | "elementType">
) {
	if (!collectionElementTypes.has(elementType)) {
		throw new Error(`Unsupported Inspector collection element type "${elementType}".`);
	}
	const minimum = configuration?.minItems ?? 0;
	const maximum = configuration?.maxItems ?? 64;
	if (!Number.isInteger(minimum) || minimum < 0 || minimum > 256) {
		throw new Error("Inspector collection minItems must be an integer between 0 and 256.");
	}
	if (!Number.isInteger(maximum) || maximum < 1 || maximum > 256) {
		throw new Error("Inspector collection maxItems must be an integer between 1 and 256.");
	}
	if (minimum > maximum) {
		throw new Error("Inspector collection minItems cannot exceed maxItems.");
	}
	if (configuration?.style?.icon !== undefined && configuration.style.icon.length > 16) {
		throw new Error("Inspector collection style icons are limited to 16 characters.");
	}
	if (configuration?.style?.accentColor !== undefined && !/^#[\da-f]{6}$/i.test(configuration.style.accentColor)) {
		throw new Error("Inspector collection accentColor must use six-digit hex syntax.");
	}
	if (configuration?.styleType !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(configuration.styleType)) {
		throw new Error("Inspector collection styleType must contain 1-64 identifier characters.");
	}
	if (configuration?.style?.variant !== undefined && !["flat", "cards", "outlined"].includes(configuration.style.variant)) {
		throw new Error("Inspector collection style variant is invalid.");
	}
	if (configuration?.style?.density !== undefined && !["compact", "normal", "comfortable"].includes(configuration.style.density)) {
		throw new Error("Inspector collection style density is invalid.");
	}
	for (const property of ["showIndices", "striped"] as const) {
		if (configuration?.style?.[property] !== undefined && typeof configuration.style[property] !== "boolean") {
			throw new Error(`Inspector collection style ${property} must be boolean.`);
		}
	}
	validateCollectionDefaultItem(elementType, configuration?.defaultItem);
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;
		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: { ...configuration, type, elementType } as VisibleInInspectorDecoratorCollectionConfiguration,
		});
	};
}

/** Makes an array property editable with typed elements and DataTypeStyleMapper-compatible styling. */
export function visibleAsArray(
	elementType: VisibleInInspectorCollectionElementType,
	label?: string,
	configuration?: Omit<VisibleInInspectorDecoratorCollectionConfiguration, "type" | "elementType">
) {
	return visibleAsCollection("array", elementType, label, configuration);
}

/** Makes a list property editable with typed elements and DataTypeStyleMapper-compatible styling. */
export function visibleAsList(
	elementType: VisibleInInspectorCollectionElementType,
	label?: string,
	configuration?: Omit<VisibleInInspectorDecoratorCollectionConfiguration, "type" | "elementType">
) {
	return visibleAsCollection("list", elementType, label, configuration);
}

/**
 * Makes the decorated property visible in the editor inspector as a boolean.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (description, etc.).
 */
export function visibleAsBoolean(label?: string, configuration?: Omit<VisibleInInspectorDecoratorConfiguration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "boolean",
			},
		});
	};
}

export type VisibleInInspectorDecoratorStringConfiguration = VisibleInInspectorDecoratorConfiguration & {
	multiline?: boolean;
};

/**
 * Makes the decorated property visible in the editor inspector as a string.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (description, etc.).
 */
export function visibleAsString(label?: string, configuration?: Omit<VisibleInInspectorDecoratorStringConfiguration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "string",
			},
		});
	};
}

/**
 * Makes the decorated property visible in the editor inspector as a number.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (min, max, etc.).
 */
export function visibleAsNumber(label?: string, configuration?: Omit<VisibleInInspectorDecoratorNumberConfiguration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "number",
			},
		});
	};
}

export type VisibleInInspectorDecoratorNumberConfiguration = VisibleInInspectorDecoratorConfiguration & {
	min?: number;
	max?: number;
	step?: number;
};

/**
 * Makes the decorated property visible in the editor inspector as a vector2.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (min, max, etc.).
 */
export function visibleAsVector2(label?: string, configuration?: Omit<VisibleInInspectorDecoratorVector2Configuration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "vector2",
			},
		});
	};
}

export type VisibleInInspectorDecoratorVector2Configuration = VisibleInInspectorDecoratorConfiguration & {
	min?: number;
	max?: number;
	step?: number;
	asDegrees?: boolean;
};

/**
 * Makes the decorated property visible in the editor inspector as a vector3.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (min, max, etc.).
 */
export function visibleAsVector3(label?: string, configuration?: Omit<VisibleInInspectorDecoratorVector3Configuration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "vector3",
			},
		});
	};
}

export type VisibleInInspectorDecoratorVector3Configuration = VisibleInInspectorDecoratorConfiguration & {
	min?: number;
	max?: number;
	step?: number;
	asDegrees?: boolean;
};

/**
 * Makes the decorated property visible in the editor inspector as a color3.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (min, max, etc.).
 */
export function visibleAsColor3(label?: string, configuration?: Omit<VisibleInInspectorDecoratorColor3Configuration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "color3",
			},
		});
	};
}

export type VisibleInInspectorDecoratorColor3Configuration = VisibleInInspectorDecoratorConfiguration & {
	noClamp?: boolean;
	noColorPicker?: boolean;
};

/**
 * Makes the decorated property visible in the editor inspector as a color4.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (min, max, etc.).
 */
export function visibleAsColor4(label?: string, configuration?: Omit<VisibleInInspectorDecoratorColor4Configuration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "color4",
			},
		});
	};
}

export type VisibleInInspectorDecoratorColor4Configuration = VisibleInInspectorDecoratorConfiguration & {
	noClamp?: boolean;
	noColorPicker?: boolean;
};

/**
 * Makes the decorated property visible in the editor inspector as an entity.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param entityType defines the type of entity to be displayed in the inspector (node, sound, animationGroup or particleSystem).
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (min, max, etc.).
 */
export function visibleAsEntity(entityType: VisibleAsEntityType, label?: string, configuration?: Omit<VisibleInInspectorDecoratorEntityConfiguration, "type" | "entityType">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				entityType,
				type: "entity",
			} as VisibleInInspectorDecoratorEntityConfiguration,
		});
	};
}

export type VisibleAsEntityType = "node" | "sound" | "animationGroup" | "particleSystem";

export type VisibleInInspectorDecoratorEntityConfiguration = VisibleInInspectorDecoratorConfiguration & {
	entityType?: VisibleAsEntityType;
};

/**
 * Makes the decorated property visible in the editor inspector as a Texture.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (accept cubes, etc.).
 */
export function visibleAsTexture(label?: string, configuration?: Omit<VisibleInInspectorDecoratorTextureConfiguration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "texture",
			},
		});
	};
}

export type VisibleInInspectorDecoratorTextureConfiguration = VisibleInInspectorDecoratorConfiguration & {
	acceptCubes?: boolean;
	onlyCubes?: boolean;
};

/**
 * Makes the decorated property visible in the editor inspector as a KeyMap.
 * The property can be customized per object in the editor and the custom value is applied
 * once the script is invoked at runtime in the game/application.
 * This can be used only by scripts using Classes.
 * @param label defines the optional label displayed in the inspector in the editor.
 * @param configuration defines the optional configuration for the field in the inspector (description, etc.).
 */
export function visibleAsKeyMap(label?: string, configuration?: Omit<VisibleInInspectorDecoratorConfiguration, "type">) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				type: "keymap",
			},
		});
	};
}

export type VisibleInspectorDecoratorAssetPossibleTypes = "json" | "material" | "nodeParticleSystemSet" | "scene" | "gui" | "navmesh" | "cinematic" | "ragdoll";

export type VisibleInspectorDecoratorAssetConfiguration<T = VisibleInspectorDecoratorAssetPossibleTypes> = VisibleInInspectorDecoratorConfiguration & {
	assetType: T;
	typeRestriction?: T extends "material" ? "PBRMaterial" | "StandardMaterial" | "AnyMaterial" : never;
};

export function visibleAsAsset(
	assetType: VisibleInspectorDecoratorAssetPossibleTypes,
	label?: string,
	configuration?: Omit<VisibleInspectorDecoratorAssetConfiguration, "type" | "assetType">
) {
	return function (target: any, propertyKey: string | Symbol) {
		const ctor = target.constructor as ISceneDecoratorData;

		ctor._VisibleInInspector ??= [];
		ctor._VisibleInInspector.push({
			label,
			propertyKey,
			configuration: {
				...configuration,
				assetType,
				type: "asset",
			} as VisibleInspectorDecoratorAssetConfiguration,
		});
	};
}
