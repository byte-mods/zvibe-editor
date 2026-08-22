import { isValidElement, ReactNode } from "react";

export interface IEditorInspectorFieldProps<T = any> {
	object: T;
	property: string;

	label?: ReactNode;
	tooltip?: ReactNode;

	noUndoRedo?: boolean;

	/** Overrides the automatic live-prefab object/property mapping, or disables it for composite child controls. */
	prefabOverride?: false | { object?: any; property?: string; category?: "transform" | "component"; kind?: string };
}

let inspectorSearch = "";

/**
 * Sets the new search value used to filter fields in inspector.
 * @param search defines the new search value to filter fields in inspector.
 */
export function setInspectorSearch(search: string): void {
	inspectorSearch = search;
}

function inspectorSearchText(value: ReactNode): string {
	if (typeof value === "string" || typeof value === "number") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map(inspectorSearchText).join(" ");
	}
	if (isValidElement(value)) {
		const props = value.props as { children?: ReactNode; label?: ReactNode; property?: ReactNode; title?: ReactNode; tooltip?: ReactNode };
		return [props.label, props.property, props.title, props.tooltip, props.children].map(inspectorSearchText).join(" ");
	}
	return "";
}

/** Matches all normalized Inspector search terms against field labels, property paths, tooltips, and nested child declarations. */
export function matchesInspectorSearch(...values: ReactNode[]): boolean {
	const terms = inspectorSearch
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_./-]+/g, " ")
		.toLocaleLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (!terms.length) {
		return true;
	}
	const text = values
		.map(inspectorSearchText)
		.join(" ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_./-]+/g, " ")
		.toLocaleLowerCase();
	return terms.every((term) => text.includes(term));
}
