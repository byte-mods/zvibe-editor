import { IVisibleInInspectorCollectionStyle, VisibleInInspectorCollectionElementType } from "babylonjs-editor-tools";

export interface IEditorInspectorCollectionStyle extends Required<IVisibleInInspectorCollectionStyle> {
	styleType: string;
}

const defaultStyle: IEditorInspectorCollectionStyle = {
	styleType: "default",
	icon: "[]",
	accentColor: "#64748b",
	variant: "outlined",
	density: "normal",
	showIndices: true,
	striped: false,
};

const styles = new Map<string, IEditorInspectorCollectionStyle>([
	["default", defaultStyle],
	["number", { ...defaultStyle, styleType: "number", icon: "#", accentColor: "#3b82f6", variant: "flat", density: "compact" }],
	["boolean", { ...defaultStyle, styleType: "boolean", icon: "✓", accentColor: "#22c55e", variant: "cards" }],
	["string", { ...defaultStyle, styleType: "string", icon: "T", accentColor: "#a855f7", striped: true }],
	["vector2", { ...defaultStyle, styleType: "vector2", icon: "V2", accentColor: "#06b6d4", variant: "cards" }],
	["vector3", { ...defaultStyle, styleType: "vector3", icon: "V3", accentColor: "#06b6d4", variant: "cards" }],
	["color3", { ...defaultStyle, styleType: "color3", icon: "RGB", accentColor: "#f59e0b", variant: "cards" }],
	["color4", { ...defaultStyle, styleType: "color4", icon: "RGBA", accentColor: "#f59e0b", variant: "cards" }],
]);

function normalizeStyle(styleType: string, style: IVisibleInInspectorCollectionStyle, base: IEditorInspectorCollectionStyle): IEditorInspectorCollectionStyle {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(styleType)) {
		throw new Error("Inspector collection style type must contain 1-64 identifier characters.");
	}
	if (style.icon !== undefined && style.icon.length > 16) {
		throw new Error("Inspector collection style icons are limited to 16 characters.");
	}
	if (style.accentColor !== undefined && !/^#[\da-f]{6}$/i.test(style.accentColor)) {
		throw new Error("Inspector collection accentColor must use six-digit hex syntax.");
	}
	return { ...base, ...style, styleType };
}

/** Registers or replaces one editor-wide collection style for a custom data type. */
export function registerInspectorCollectionStyle(styleType: string, style: IVisibleInInspectorCollectionStyle): () => void {
	const previous = styles.get(styleType);
	styles.set(styleType, normalizeStyle(styleType, style, previous ?? defaultStyle));
	return () => {
		if (previous) {
			styles.set(styleType, previous);
		} else {
			styles.delete(styleType);
		}
	};
}

/** Resolves DataTypeStyleMapper-compatible list/array styling with an optional field-local override. */
export function getInspectorCollectionStyle(
	elementType: VisibleInInspectorCollectionElementType,
	styleType?: string,
	override?: IVisibleInInspectorCollectionStyle
): IEditorInspectorCollectionStyle {
	const selectedType = styleType ?? elementType;
	const base = styles.get(selectedType) ?? styles.get(elementType) ?? defaultStyle;
	return normalizeStyle(selectedType, override ?? {}, base);
}

/** Returns immutable built-in and extension-registered collection style evidence. */
export function listInspectorCollectionStyles(): IEditorInspectorCollectionStyle[] {
	return [...styles.values()].map((style) => ({ ...style })).sort((left, right) => left.styleType.localeCompare(right.styleType));
}
