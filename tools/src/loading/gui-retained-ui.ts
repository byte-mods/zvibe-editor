export const guiRetainedDocumentModel = "unity-retained-ui-document-v1" as const;
export const guiRetainedCompilationModel = "bounded-uxml-uss-compiler-v1" as const;
export const guiRetainedControlMetadataKey = "zvibeGUIRetainedControl" as const;

export type GUIRetainedControlKind =
	| "container"
	| "rectangle"
	| "text"
	| "button"
	| "image"
	| "stackPanel"
	| "grid"
	| "scrollViewer"
	| "checkbox"
	| "radioButton"
	| "slider"
	| "inputText"
	| "inputTextArea"
	| "canvasGroup"
	| "raycastReceiver";

export type GUIRetainedPseudoState = "hover" | "active" | "focus" | "disabled" | "checked";

export interface IGUIRetainedControlProperties {
	width?: string;
	height?: string;
	left?: string;
	top?: string;
	horizontalAlignment?: "left" | "center" | "right";
	verticalAlignment?: "top" | "center" | "bottom";
	alpha?: number;
	zIndex?: number;
	isVisible?: boolean;
	isEnabled?: boolean;
	isHitTestVisible?: boolean;
	color?: string;
	background?: string;
	fontSize?: number;
	text?: string;
	source?: string;
	thickness?: number;
	cornerRadius?: number;
	spacing?: number;
	isVertical?: boolean;
	minimum?: number;
	maximum?: number;
	value?: number;
	isChecked?: boolean;
	interactable?: boolean;
	blocksRaycasts?: boolean;
	ignoreParentGroups?: boolean;
	paddingLeft?: string;
	paddingTop?: string;
	paddingRight?: string;
	paddingBottom?: string;
}

export interface IGUIRetainedPseudoStyleRule {
	state: GUIRetainedPseudoState;
	properties: IGUIRetainedControlProperties;
	specificity: number;
	order: number;
}

export interface IGUIRetainedCompiledControl {
	id: string;
	sourceName: string;
	parentId: string | null;
	typeName: string;
	kind: GUIRetainedControlKind;
	name: string;
	classes: string[];
	properties: IGUIRetainedControlProperties;
	pseudoStyles: Partial<Record<GUIRetainedPseudoState, IGUIRetainedControlProperties>>;
	pseudoCascade: IGUIRetainedPseudoStyleRule[];
	tooltip: string | null;
	bindingPath: string | null;
	tabIndex: number | null;
	matchedRuleCount: number;
	inlinePropertyCount: number;
}

export interface IGUIRetainedSourceFingerprint {
	path: string;
	kind: "uxml" | "uss" | "template";
	sha256: string;
	bytes: number;
}

export interface IGUIRetainedCompilation {
	model: typeof guiRetainedCompilationModel;
	sourceFingerprint: string;
	sources: IGUIRetainedSourceFingerprint[];
	controls: IGUIRetainedCompiledControl[];
	rootControlIds: string[];
	styleRuleCount: number;
	pseudoRuleCount: number;
	selectorStatistics: IGUIRetainedSelectorStatistic[];
	templateCount: number;
	generatedIdCount: number;
	maximumDepth: number;
	warnings: string[];
}

export interface IGUIRetainedSelectorStatistic {
	sourcePath: string;
	selector: string;
	specificity: number;
	pseudoState: GUIRetainedPseudoState | null;
	declarationCount: number;
	matchedControlCount: number;
}

export interface IGUIRetainedDocumentState {
	model: typeof guiRetainedDocumentModel;
	uxmlPath: string;
	stylesheetPaths: string[];
	templatePaths: string[];
	hotReload: boolean;
	sourceRevision: number;
	compiled: IGUIRetainedCompilation;
}

export interface IGUIRetainedSourceFile {
	path: string;
	source: string;
}

export interface ICompileGUIRetainedDocumentOptions {
	uxmlPath: string;
	uxml: string;
	stylesheets?: IGUIRetainedSourceFile[];
	templates?: IGUIRetainedSourceFile[];
	stylesheetOrder?: string[];
}

interface IXMLNode {
	tag: string;
	attributes: Record<string, string>;
	children: IXMLNode[];
	text: string;
}

interface IParsedSelectorPart {
	typeName: string | null;
	id: string | null;
	classes: string[];
	pseudo: GUIRetainedPseudoState | null;
	combinatorToLeft: "child" | "descendant" | null;
}

interface IParsedStyleRule {
	selector: string;
	parts: IParsedSelectorPart[];
	properties: IGUIRetainedControlProperties;
	specificity: number;
	order: number;
	pseudo: GUIRetainedPseudoState | null;
	sourcePath: string;
}

interface IMutableCompiledControl extends IGUIRetainedCompiledControl {
	_inlineProperties: IGUIRetainedControlProperties;
}

interface ITemplateDefinition {
	name: string;
	path: string;
}

export interface IGUIRetainedUXMLReferences {
	stylesheetPaths: string[];
	templates: Array<{ name: string; path: string }>;
}

const maximumDocumentBytes = 1024 * 1024;
const maximumStylesheetBytes = 512 * 1024;
const maximumNodes = 4096;
const maximumDepth = 64;
const maximumAttributes = 64;
const maximumAttributeLength = 16384;
const maximumStyleRules = 2048;
const maximumDeclarationsPerRule = 64;
const maximumSelectorsPerRule = 32;
const maximumTemplateDepth = 16;
const maximumSourceFiles = 128;

const allowedPseudoStates = new Set<GUIRetainedPseudoState>(["hover", "active", "focus", "disabled", "checked"]);
const containerKinds = new Set<GUIRetainedControlKind>(["container", "rectangle", "button", "stackPanel", "grid", "scrollViewer", "canvasGroup"]);
const elementKinds = new Map<string, GUIRetainedControlKind>([
	["VisualElement", "stackPanel"],
	["Panel", "rectangle"],
	["Label", "text"],
	["Button", "button"],
	["Image", "image"],
	["StackPanel", "stackPanel"],
	["Grid", "grid"],
	["ScrollView", "scrollViewer"],
	["Toggle", "checkbox"],
	["RadioButton", "radioButton"],
	["Slider", "slider"],
	["TextField", "inputText"],
	["TextArea", "inputTextArea"],
	["CanvasGroup", "canvasGroup"],
	["RaycastReceiver", "raycastReceiver"],
]);
const styleAttributeNames = new Set([
	"width",
	"height",
	"left",
	"top",
	"opacity",
	"z-index",
	"display",
	"visibility",
	"pointer-events",
	"color",
	"background-color",
	"background-image",
	"font-size",
	"border-width",
	"border-radius",
	"gap",
	"flex-direction",
	"align-self",
	"-unity-text-align",
	"padding-left",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"min-value",
	"max-value",
	"value",
	"checked",
	"enabled",
]);

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function validateSourcePath(path: unknown, extension: ".uxml" | ".uss", label: string): string {
	if (typeof path !== "string") {
		throw new Error(`${label} must be a project-relative ${extension} path.`);
	}
	const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized || normalized.length > 1024 || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error(`${label} must stay inside the project and contain at most 1,024 characters.`);
	}
	if (!normalized.toLowerCase().endsWith(extension)) {
		throw new Error(`${label} must end in ${extension}.`);
	}
	return normalized;
}

function resolveSourceReference(documentPath: string, reference: unknown, extension: ".uxml" | ".uss", label: string): string {
	if (typeof reference !== "string") {
		return validateSourcePath(reference, extension, label);
	}
	const normalizedReference = reference.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (normalizedReference.startsWith("assets/")) {
		return validateSourcePath(normalizedReference, extension, label);
	}
	const segments = documentPath.split("/").slice(0, -1);
	for (const segment of normalizedReference.split("/")) {
		if (!segment || segment === ".") {
			continue;
		}
		if (segment === "..") {
			if (segments.length <= 1) {
				throw new Error(`${label} escapes the project assets directory.`);
			}
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return validateSourcePath(segments.join("/"), extension, label);
}

function localName(value: string): string {
	return value.slice(value.lastIndexOf(":") + 1);
}

function decodeXML(value: string): string {
	const decoded = value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
		if (entity === "amp") {
			return "&";
		}
		if (entity === "lt") {
			return "<";
		}
		if (entity === "gt") {
			return ">";
		}
		if (entity === "quot") {
			return '"';
		}
		if (entity === "apos") {
			return "'";
		}
		const codepoint = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
		if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
			throw new Error(`UXML contains an invalid numeric character entity: ${match}`);
		}
		return String.fromCodePoint(codepoint);
	});
	if (/&[^\s;]{1,64};/.test(decoded)) {
		throw new Error("UXML contains an unsupported named entity.");
	}
	return decoded;
}

function findTagEnd(source: string, start: number): number {
	let quote: string | null = null;
	for (let index = start; index < source.length; index++) {
		const character = source[index];
		if (quote) {
			if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return index;
		}
	}
	throw new Error("UXML contains an unterminated tag.");
}

function parseAttributes(source: string): { tag: string; attributes: Record<string, string> } {
	const nameMatch = source.match(/^\s*([^\s/>]+)/);
	if (!nameMatch || !/^[A-Za-z_][\w.:-]*$/.test(nameMatch[1])) {
		throw new Error("UXML contains an invalid element name.");
	}
	const tag = localName(nameMatch[1]);
	const attributes: Record<string, string> = {};
	let offset = nameMatch[0].length;
	while (offset < source.length) {
		const whitespace = source.slice(offset).match(/^\s+/)?.[0] ?? "";
		offset += whitespace.length;
		if (offset >= source.length) {
			break;
		}
		const attributeMatch = source.slice(offset).match(/^([^\s=/>]+)\s*=\s*(["'])/);
		if (!attributeMatch || !/^[A-Za-z_][\w.:-]*$/.test(attributeMatch[1])) {
			throw new Error(`UXML element <${tag}> contains an invalid or unquoted attribute.`);
		}
		const name = localName(attributeMatch[1]);
		if (Object.prototype.hasOwnProperty.call(attributes, name)) {
			throw new Error(`UXML element <${tag}> repeats attribute "${name}".`);
		}
		if (Object.keys(attributes).length >= maximumAttributes) {
			throw new Error(`UXML element <${tag}> exceeds ${maximumAttributes} attributes.`);
		}
		offset += attributeMatch[0].length;
		const quote = attributeMatch[2];
		const end = source.indexOf(quote, offset);
		if (end === -1) {
			throw new Error(`UXML attribute "${name}" on <${tag}> is unterminated.`);
		}
		const value = decodeXML(source.slice(offset, end));
		if (value.length > maximumAttributeLength) {
			throw new Error(`UXML attribute "${name}" exceeds ${maximumAttributeLength.toLocaleString()} characters.`);
		}
		attributes[name] = value;
		offset = end + 1;
	}
	return { tag, attributes };
}

function parseUXML(source: string, path: string): IXMLNode {
	if (utf8Bytes(source) > maximumDocumentBytes) {
		throw new Error(`UXML source "${path}" exceeds ${maximumDocumentBytes.toLocaleString()} bytes.`);
	}
	if (/<!DOCTYPE/i.test(source) || /<!ENTITY/i.test(source)) {
		throw new Error("UXML DTD and entity declarations are not supported.");
	}
	const artificialRoot: IXMLNode = { tag: "#document", attributes: {}, children: [], text: "" };
	const stack = [artificialRoot];
	let cursor = 0;
	let nodeCount = 0;
	while (cursor < source.length) {
		const opening = source.indexOf("<", cursor);
		if (opening === -1) {
			stack[stack.length - 1].text += decodeXML(source.slice(cursor));
			break;
		}
		stack[stack.length - 1].text += decodeXML(source.slice(cursor, opening));
		if (source.startsWith("<!--", opening)) {
			const end = source.indexOf("-->", opening + 4);
			if (end === -1) {
				throw new Error("UXML contains an unterminated comment.");
			}
			cursor = end + 3;
			continue;
		}
		if (source.startsWith("<?", opening)) {
			const end = source.indexOf("?>", opening + 2);
			if (end === -1) {
				throw new Error("UXML contains an unterminated processing instruction.");
			}
			cursor = end + 2;
			continue;
		}
		if (source.startsWith("<!", opening)) {
			throw new Error("UXML declarations other than comments are not supported.");
		}
		const end = findTagEnd(source, opening + 1);
		const raw = source.slice(opening + 1, end);
		if (/^\s*\//.test(raw)) {
			const closingName = localName(raw.replace(/^\s*\//, "").trim());
			if (!/^[A-Za-z_][\w.:-]*$/.test(closingName) || stack.length === 1 || stack[stack.length - 1].tag !== closingName) {
				throw new Error(`UXML closing element </${closingName}> does not match the current element.`);
			}
			stack.pop();
			cursor = end + 1;
			continue;
		}
		const selfClosing = /\/\s*$/.test(raw);
		const parsed = parseAttributes(raw.replace(/\/\s*$/, ""));
		const node: IXMLNode = { tag: parsed.tag, attributes: parsed.attributes, children: [], text: "" };
		stack[stack.length - 1].children.push(node);
		nodeCount++;
		if (nodeCount > maximumNodes) {
			throw new Error(`UXML source "${path}" exceeds ${maximumNodes.toLocaleString()} elements.`);
		}
		if (!selfClosing) {
			stack.push(node);
			if (stack.length - 1 > maximumDepth) {
				throw new Error(`UXML source "${path}" exceeds nesting depth ${maximumDepth}.`);
			}
		}
		cursor = end + 1;
	}
	if (stack.length !== 1) {
		throw new Error(`UXML source "${path}" has unclosed element <${stack[stack.length - 1].tag}>.`);
	}
	if (artificialRoot.children.length !== 1 || artificialRoot.children[0].tag !== "UXML") {
		throw new Error(`UXML source "${path}" must contain exactly one <ui:UXML> root.`);
	}
	return artificialRoot.children[0];
}

function parseBoolean(value: string, label: string): boolean {
	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	throw new Error(`${label} must be true or false.`);
}

function parseBoundedNumber(value: string, minimum: number, maximum: number, label: string, integer = false): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
		throw new Error(`${label} must be ${integer ? "an integer" : "a finite number"} between ${minimum.toLocaleString()} and ${maximum.toLocaleString()}.`);
	}
	return parsed;
}

function parseDimension(value: string, label: string, allowNegative = false): string {
	const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(px|%)$/);
	if (!match) {
		throw new Error(`${label} must use px or % units.`);
	}
	const numeric = Number(match[1]);
	if (!Number.isFinite(numeric) || (!allowNegative && numeric < 0) || Math.abs(numeric) > 100000) {
		throw new Error(`${label} is outside the supported range.`);
	}
	return `${numeric}${match[2]}`;
}

function parsePixels(value: string, minimum: number, maximum: number, label: string): number {
	const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(?:px)?$/);
	if (!match) {
		throw new Error(`${label} must be a pixel number.`);
	}
	return parseBoundedNumber(match[1], minimum, maximum, label);
}

function normalizeColor(value: string, label: string): string {
	const normalized = value.trim().toLowerCase();
	if (/^#[\da-f]{3,8}$/.test(normalized) || /^(transparent|black|white|red|green|blue|yellow|gray|grey)$/.test(normalized)) {
		return normalized;
	}
	if (/^rgba?\(\s*\d{1,3}(?:\s*,\s*\d{1,3}){2}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(normalized)) {
		return normalized;
	}
	throw new Error(`${label} must be a bounded hex, rgb/rgba, or supported named color.`);
}

function splitDeclarations(source: string): string[] {
	const result: string[] = [];
	let quote: string | null = null;
	let parentheses = 0;
	let start = 0;
	for (let index = 0; index <= source.length; index++) {
		const character = source[index];
		if (quote) {
			if (character === quote && source[index - 1] !== "\\") {
				quote = null;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "(") {
			parentheses++;
		} else if (character === ")") {
			parentheses--;
		} else if ((character === ";" || index === source.length) && parentheses === 0) {
			const declaration = source.slice(start, index).trim();
			if (declaration) {
				result.push(declaration);
			}
			start = index + 1;
		}
		if (parentheses < 0) {
			throw new Error("USS contains an unmatched closing parenthesis.");
		}
	}
	if (quote || parentheses !== 0) {
		throw new Error("USS contains an unterminated string or function.");
	}
	return result;
}

function resolveVariable(value: string, variables: Map<string, string>, label: string): string {
	const match = value.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
	if (!match) {
		return value.trim();
	}
	const resolved = variables.get(match[1]) ?? match[2]?.trim();
	if (resolved === undefined) {
		throw new Error(`${label} references undefined USS variable ${match[1]}.`);
	}
	return resolved;
}

function declarationProperty(name: string, rawValue: string, variables: Map<string, string>, label: string): IGUIRetainedControlProperties {
	const value = resolveVariable(rawValue, variables, label);
	switch (name) {
		case "width":
		case "height":
			return { [name]: parseDimension(value, label) };
		case "left":
		case "top":
			return { [name]: parseDimension(value, label, true) };
		case "opacity":
			return { alpha: parseBoundedNumber(value, 0, 1, label) };
		case "z-index":
			return { zIndex: parseBoundedNumber(value, -32768, 32767, label, true) };
		case "display":
			if (value !== "flex" && value !== "none") {
				throw new Error(`${label} supports flex or none.`);
			}
			return { isVisible: value !== "none" };
		case "visibility":
			if (value !== "visible" && value !== "hidden") {
				throw new Error(`${label} supports visible or hidden.`);
			}
			return { isVisible: value === "visible" };
		case "pointer-events":
			if (value !== "auto" && value !== "none") {
				throw new Error(`${label} supports auto or none.`);
			}
			return { isHitTestVisible: value === "auto" };
		case "color":
			return { color: normalizeColor(value, label) };
		case "background-color":
			return { background: normalizeColor(value, label) };
		case "background-image": {
			const match = value.match(/^url\(\s*(["']?)([^"')]+)\1\s*\)$/);
			if (!match) {
				throw new Error(`${label} must use url(project/relative/path).`);
			}
			const source = match[2].trim().replace(/\\/g, "/");
			if (!source || source.startsWith("/") || source.startsWith("../") || source.includes("/../") || source.length > 4096) {
				throw new Error(`${label} must stay inside the project.`);
			}
			return { source };
		}
		case "font-size":
			return { fontSize: parsePixels(value, 1, 1024, label) };
		case "border-width":
			return { thickness: parsePixels(value, 0, 4096, label) };
		case "border-radius":
			return { cornerRadius: parsePixels(value, 0, 4096, label) };
		case "gap":
			return { spacing: parsePixels(value, 0, 4096, label) };
		case "flex-direction":
			if (value !== "row" && value !== "column") {
				throw new Error(`${label} supports row or column.`);
			}
			return { isVertical: value === "column" };
		case "align-self":
			if (value === "flex-start") {
				return { horizontalAlignment: "left" };
			}
			if (value === "center") {
				return { horizontalAlignment: "center" };
			}
			if (value === "flex-end") {
				return { horizontalAlignment: "right" };
			}
			throw new Error(`${label} supports flex-start, center, or flex-end.`);
		case "-unity-text-align": {
			const parts = value.split("-");
			const horizontal = parts.includes("left") ? "left" : parts.includes("right") ? "right" : "center";
			const vertical = parts.includes("upper") ? "top" : parts.includes("lower") ? "bottom" : "center";
			return { horizontalAlignment: horizontal, verticalAlignment: vertical };
		}
		case "padding-left":
		case "padding-top":
		case "padding-right":
		case "padding-bottom": {
			const property = name.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase()) as "paddingLeft" | "paddingTop" | "paddingRight" | "paddingBottom";
			return { [property]: parseDimension(value, label) };
		}
		case "min-value":
			return { minimum: parseBoundedNumber(value, -1000000, 1000000, label) };
		case "max-value":
			return { maximum: parseBoundedNumber(value, -1000000, 1000000, label) };
		case "value":
			return { value: parseBoundedNumber(value, -1000000, 1000000, label) };
		case "checked":
			return { isChecked: parseBoolean(value, label) };
		case "enabled":
			return { isEnabled: parseBoolean(value, label) };
		default:
			throw new Error(`${label} uses unsupported retained-UI property "${name}".`);
	}
}

function parseDeclarationBlock(source: string, variables: Map<string, string>, label: string): IGUIRetainedControlProperties {
	const declarations = splitDeclarations(source);
	if (declarations.length > maximumDeclarationsPerRule) {
		throw new Error(`${label} exceeds ${maximumDeclarationsPerRule} declarations.`);
	}
	const properties: IGUIRetainedControlProperties = {};
	for (const declaration of declarations) {
		const separator = declaration.indexOf(":");
		if (separator <= 0) {
			throw new Error(`${label} contains an invalid declaration: ${declaration}`);
		}
		const name = declaration.slice(0, separator).trim().toLowerCase();
		const value = declaration.slice(separator + 1).trim();
		if (!value) {
			throw new Error(`${label} property "${name}" has no value.`);
		}
		if (name.startsWith("--")) {
			variables.set(name, value);
			continue;
		}
		Object.assign(properties, declarationProperty(name, value, variables, `${label} property "${name}"`));
	}
	return properties;
}

function parseSimpleSelector(source: string): Omit<IParsedSelectorPart, "combinatorToLeft"> {
	let cursor = 0;
	let typeName: string | null = null;
	let id: string | null = null;
	const classes: string[] = [];
	let pseudo: GUIRetainedPseudoState | null = null;
	const typeMatch = source.match(/^(\*|[A-Za-z_][\w-]*)/);
	if (typeMatch) {
		typeName = typeMatch[1] === "*" ? null : typeMatch[1];
		cursor = typeMatch[0].length;
	}
	while (cursor < source.length) {
		const marker = source[cursor];
		const match = source.slice(cursor + 1).match(/^[-\w]+/);
		if (!match || !["#", ".", ":"].includes(marker)) {
			throw new Error(`USS selector "${source}" is unsupported.`);
		}
		const value = match[0];
		cursor += value.length + 1;
		if (marker === "#") {
			if (id) {
				throw new Error(`USS selector "${source}" contains multiple ids.`);
			}
			id = value;
		} else if (marker === ".") {
			if (classes.includes(value)) {
				throw new Error(`USS selector "${source}" repeats class ".${value}".`);
			}
			classes.push(value);
		} else {
			if (!allowedPseudoStates.has(value as GUIRetainedPseudoState)) {
				throw new Error(`USS selector "${source}" uses unsupported pseudo-state ":${value}".`);
			}
			if (pseudo) {
				throw new Error(`USS selector "${source}" may contain only one pseudo-state.`);
			}
			pseudo = value as GUIRetainedPseudoState;
		}
	}
	if (!typeName && !id && !classes.length && !pseudo) {
		throw new Error(`USS selector "${source}" is empty.`);
	}
	return { typeName, id, classes, pseudo };
}

function parseSelector(source: string): { parts: IParsedSelectorPart[]; specificity: number; pseudo: GUIRetainedPseudoState | null } {
	const tokens = source.trim().replace(/>/g, " > ").split(/\s+/).filter(Boolean);
	if (!tokens.length || tokens[0] === ">" || tokens[tokens.length - 1] === ">") {
		throw new Error(`USS selector "${source}" is invalid.`);
	}
	const parts: IParsedSelectorPart[] = [];
	let pending: "child" | "descendant" | null = null;
	for (const token of tokens) {
		if (token === ">") {
			if (!parts.length || pending === "child") {
				throw new Error(`USS selector "${source}" has an invalid child combinator.`);
			}
			pending = "child";
			continue;
		}
		const parsed = parseSimpleSelector(token);
		parts.push({ ...parsed, combinatorToLeft: parts.length ? (pending ?? "descendant") : null });
		pending = null;
	}
	const pseudos = parts.map((part, index) => ({ pseudo: part.pseudo, index })).filter((entry) => entry.pseudo !== null);
	if (pseudos.length > 1 || (pseudos.length === 1 && pseudos[0].index !== parts.length - 1)) {
		throw new Error(`USS selector "${source}" must place at most one pseudo-state on its rightmost element.`);
	}
	const specificity = parts.reduce((total, part) => total + (part.id ? 100 : 0) + (part.classes.length + (part.pseudo ? 1 : 0)) * 10 + (part.typeName ? 1 : 0), 0);
	return { parts, specificity, pseudo: pseudos[0]?.pseudo ?? null };
}

function parseStylesheets(files: IGUIRetainedSourceFile[]): IParsedStyleRule[] {
	const variables = new Map<string, string>();
	const pending: Array<{ selectors: string[]; body: string; path: string; order: number }> = [];
	let order = 0;
	for (const file of files) {
		if (utf8Bytes(file.source) > maximumStylesheetBytes) {
			throw new Error(`USS source "${file.path}" exceeds ${maximumStylesheetBytes.toLocaleString()} bytes.`);
		}
		const source = file.source.replace(/\/\*[\s\S]*?\*\//g, "").trim();
		if (/@(?:import|media|supports|keyframes|font-face)\b/i.test(source)) {
			throw new Error(`USS source "${file.path}" uses unsupported at-rules.`);
		}
		let cursor = 0;
		while (cursor < source.length) {
			const opening = source.indexOf("{", cursor);
			if (opening === -1) {
				if (source.slice(cursor).trim()) {
					throw new Error(`USS source "${file.path}" has trailing text outside a rule.`);
				}
				break;
			}
			const closing = source.indexOf("}", opening + 1);
			if (closing === -1 || source.slice(opening + 1, closing).includes("{")) {
				throw new Error(`USS source "${file.path}" contains an unterminated or nested rule.`);
			}
			const selectorSource = source.slice(cursor, opening).trim();
			const selectors = selectorSource
				.split(",")
				.map((selector) => selector.trim())
				.filter(Boolean);
			if (!selectors.length || selectors.length > maximumSelectorsPerRule) {
				throw new Error(`USS rule in "${file.path}" must contain 1-${maximumSelectorsPerRule} selectors.`);
			}
			const body = source.slice(opening + 1, closing);
			if (selectors.length === 1 && selectors[0] === ":root") {
				const declarations = splitDeclarations(body);
				for (const declaration of declarations) {
					const separator = declaration.indexOf(":");
					const name = declaration.slice(0, separator).trim();
					const value = declaration.slice(separator + 1).trim();
					if (separator <= 2 || !name.startsWith("--") || !value) {
						throw new Error(`USS :root in "${file.path}" may contain only custom variables.`);
					}
					variables.set(name, value);
				}
			} else {
				pending.push({ selectors, body, path: file.path, order: order++ });
			}
			cursor = closing + 1;
		}
	}
	const rules: IParsedStyleRule[] = [];
	for (const entry of pending) {
		const properties = parseDeclarationBlock(entry.body, variables, `USS rule "${entry.selectors.join(", ")}" in "${entry.path}"`);
		for (const selector of entry.selectors) {
			const parsed = parseSelector(selector);
			rules.push({ selector, ...parsed, properties, sourcePath: entry.path, order: entry.order });
			if (rules.length > maximumStyleRules) {
				throw new Error(`Retained UI exceeds ${maximumStyleRules.toLocaleString()} compiled style rules.`);
			}
		}
	}
	return rules;
}

function selectorPartMatches(part: IParsedSelectorPart, control: IMutableCompiledControl): boolean {
	return (
		(!part.typeName || part.typeName === control.typeName) &&
		(!part.id || part.id === control.id || part.id === control.sourceName) &&
		part.classes.every((className) => control.classes.includes(className))
	);
}

function selectorMatches(parts: IParsedSelectorPart[], control: IMutableCompiledControl, controlsById: Map<string, IMutableCompiledControl>): boolean {
	const visit = (partIndex: number, candidate: IMutableCompiledControl | undefined): boolean => {
		if (!candidate || !selectorPartMatches(parts[partIndex], candidate)) {
			return false;
		}
		if (partIndex === 0) {
			return true;
		}
		const combinator = parts[partIndex].combinatorToLeft;
		if (combinator === "child") {
			return visit(partIndex - 1, candidate.parentId ? controlsById.get(candidate.parentId) : undefined);
		}
		let parent = candidate.parentId ? controlsById.get(candidate.parentId) : undefined;
		while (parent) {
			if (visit(partIndex - 1, parent)) {
				return true;
			}
			parent = parent.parentId ? controlsById.get(parent.parentId) : undefined;
		}
		return false;
	};
	return visit(parts.length - 1, control);
}

function styleAttributes(node: IXMLNode, variables: Map<string, string>): IGUIRetainedControlProperties {
	const properties: IGUIRetainedControlProperties = {};
	for (const [name, value] of Object.entries(node.attributes)) {
		if (styleAttributeNames.has(name)) {
			Object.assign(properties, declarationProperty(name, value, variables, `UXML <${node.tag}> attribute "${name}"`));
		}
	}
	if (node.attributes.style) {
		Object.assign(properties, parseDeclarationBlock(node.attributes.style, variables, `UXML <${node.tag}> inline style`));
	}
	return properties;
}

function validateClassList(value: string | undefined, label: string): string[] {
	const classes = (value ?? "").split(/\s+/).filter(Boolean);
	if (classes.length > 32 || classes.some((className) => !/^[A-Za-z_][\w-]{0,63}$/.test(className)) || new Set(classes).size !== classes.length) {
		throw new Error(`${label} must contain up to 32 unique class names.`);
	}
	return classes;
}

function collectSpecialNodes(root: IXMLNode, documentPath: string, definitions: Map<string, ITemplateDefinition>, stylePaths: string[]): void {
	const visit = (node: IXMLNode): void => {
		if (node.tag === "Style") {
			if (Object.keys(node.attributes).some((name) => name !== "src") || node.children.length || node.text.trim()) {
				throw new Error("UXML Style supports only a self-contained src attribute.");
			}
			const path = resolveSourceReference(documentPath, node.attributes.src, ".uss", "UXML Style src");
			if (!stylePaths.includes(path)) {
				stylePaths.push(path);
			}
		} else if (node.tag === "Template") {
			if (Object.keys(node.attributes).some((name) => name !== "name" && name !== "src") || node.children.length || node.text.trim()) {
				throw new Error("UXML Template supports only name and src attributes.");
			}
			const name = node.attributes.name;
			if (!name || !/^[A-Za-z_][\w-]{0,63}$/.test(name)) {
				throw new Error("UXML Template name must be a stable 1-64 character identifier.");
			}
			const path = resolveSourceReference(documentPath, node.attributes.src, ".uxml", `UXML Template "${name}" src`);
			if (definitions.has(name)) {
				throw new Error(`UXML template name "${name}" is duplicated.`);
			}
			definitions.set(name, { name, path });
		}
		node.children.forEach(visit);
	};
	visit(root);
}

/** Returns bounded, normalized direct Style and Template references without compiling a document. */
export function inspectGUIRetainedUXMLReferences(source: string, path: string): IGUIRetainedUXMLReferences {
	const normalizedPath = validateSourcePath(path, ".uxml", "UXML path");
	const root = parseUXML(source, normalizedPath);
	const definitions = new Map<string, ITemplateDefinition>();
	const stylesheetPaths: string[] = [];
	collectSpecialNodes(root, normalizedPath, definitions, stylesheetPaths);
	return { stylesheetPaths, templates: [...definitions.values()].map((definition) => ({ ...definition })) };
}

async function sha256(value: string): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Retained UI compilation requires Web Crypto SHA-256 support.");
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCompiledProperties(value: unknown, label: string): IGUIRetainedControlProperties {
	if (!isPlainObject(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const allowed = new Set<keyof IGUIRetainedControlProperties>([
		"width",
		"height",
		"left",
		"top",
		"horizontalAlignment",
		"verticalAlignment",
		"alpha",
		"zIndex",
		"isVisible",
		"isEnabled",
		"isHitTestVisible",
		"color",
		"background",
		"fontSize",
		"text",
		"source",
		"thickness",
		"cornerRadius",
		"spacing",
		"isVertical",
		"minimum",
		"maximum",
		"value",
		"isChecked",
		"interactable",
		"blocksRaycasts",
		"ignoreParentGroups",
		"paddingLeft",
		"paddingTop",
		"paddingRight",
		"paddingBottom",
	]);
	const unknown = Object.keys(value).find((key) => !allowed.has(key as keyof IGUIRetainedControlProperties));
	if (unknown) {
		throw new Error(`${label} contains unknown property "${unknown}".`);
	}
	const result = JSON.parse(JSON.stringify(value)) as IGUIRetainedControlProperties;
	for (const property of ["width", "height", "paddingLeft", "paddingTop", "paddingRight", "paddingBottom"] as const) {
		if (result[property] !== undefined) {
			result[property] = parseDimension(result[property]!, `${label}.${property}`);
		}
	}
	for (const property of ["left", "top"] as const) {
		if (result[property] !== undefined) {
			result[property] = parseDimension(result[property]!, `${label}.${property}`, true);
		}
	}
	if (result.horizontalAlignment !== undefined && !(["left", "center", "right"] as unknown[]).includes(result.horizontalAlignment)) {
		throw new Error(`${label}.horizontalAlignment is invalid.`);
	}
	if (result.verticalAlignment !== undefined && !(["top", "center", "bottom"] as unknown[]).includes(result.verticalAlignment)) {
		throw new Error(`${label}.verticalAlignment is invalid.`);
	}
	if (result.alpha !== undefined) {
		result.alpha = parseBoundedNumber(String(result.alpha), 0, 1, `${label}.alpha`);
	}
	if (result.zIndex !== undefined) {
		result.zIndex = parseBoundedNumber(String(result.zIndex), -32768, 32767, `${label}.zIndex`, true);
	}
	for (const property of ["isVisible", "isEnabled", "isHitTestVisible", "isVertical", "isChecked", "interactable", "blocksRaycasts", "ignoreParentGroups"] as const) {
		if (result[property] !== undefined && typeof result[property] !== "boolean") {
			throw new Error(`${label}.${property} must be boolean.`);
		}
	}
	for (const property of ["color", "background"] as const) {
		if (result[property] !== undefined) {
			result[property] = normalizeColor(result[property]!, `${label}.${property}`);
		}
	}
	if (result.fontSize !== undefined) {
		result.fontSize = parseBoundedNumber(String(result.fontSize), 1, 1024, `${label}.fontSize`);
	}
	if (result.text !== undefined && (typeof result.text !== "string" || result.text.length > 16384)) {
		throw new Error(`${label}.text must contain at most 16,384 characters.`);
	}
	if (result.source !== undefined) {
		if (
			typeof result.source !== "string" ||
			!result.source ||
			result.source.startsWith("/") ||
			result.source.startsWith("../") ||
			result.source.includes("/../") ||
			result.source.length > 4096
		) {
			throw new Error(`${label}.source must be a bounded project-relative path.`);
		}
	}
	for (const property of ["thickness", "cornerRadius", "spacing"] as const) {
		if (result[property] !== undefined) {
			result[property] = parseBoundedNumber(String(result[property]), 0, 4096, `${label}.${property}`);
		}
	}
	for (const property of ["minimum", "maximum", "value"] as const) {
		if (result[property] !== undefined) {
			result[property] = parseBoundedNumber(String(result[property]), -1000000, 1000000, `${label}.${property}`);
		}
	}
	if (result.minimum !== undefined && result.maximum !== undefined && result.minimum >= result.maximum) {
		throw new Error(`${label}.minimum must be below maximum.`);
	}
	return result;
}

/** Validates a persisted retained-document state before it becomes authoritative for a live GUI tree. */
export function normalizeGUIRetainedDocumentState(value: unknown, liveControlIds?: ReadonlySet<string>): IGUIRetainedDocumentState {
	if (!isPlainObject(value) || value.model !== guiRetainedDocumentModel) {
		throw new Error(`GUI retained document model must be "${guiRetainedDocumentModel}".`);
	}
	const state = JSON.parse(JSON.stringify(value)) as IGUIRetainedDocumentState;
	state.uxmlPath = validateSourcePath(state.uxmlPath, ".uxml", "GUI retained UXML path");
	if (!Array.isArray(state.stylesheetPaths) || state.stylesheetPaths.length > maximumSourceFiles) {
		throw new Error(`GUI retained document supports at most ${maximumSourceFiles} USS paths.`);
	}
	state.stylesheetPaths = state.stylesheetPaths.map((path, index) => validateSourcePath(path, ".uss", `GUI retained USS path ${index}`));
	if (new Set(state.stylesheetPaths).size !== state.stylesheetPaths.length) {
		throw new Error("GUI retained USS paths must be unique.");
	}
	if (!Array.isArray(state.templatePaths) || state.templatePaths.length > maximumSourceFiles) {
		throw new Error(`GUI retained document supports at most ${maximumSourceFiles} template paths.`);
	}
	state.templatePaths = state.templatePaths.map((path, index) => validateSourcePath(path, ".uxml", `GUI retained template path ${index}`));
	if (new Set(state.templatePaths).size !== state.templatePaths.length || state.templatePaths.includes(state.uxmlPath)) {
		throw new Error("GUI retained template paths must be unique and distinct from the root UXML path.");
	}
	if (typeof state.hotReload !== "boolean") {
		throw new Error("GUI retained hotReload must be boolean.");
	}
	if (!Number.isInteger(state.sourceRevision) || state.sourceRevision < 0) {
		throw new Error("GUI retained sourceRevision must be a non-negative integer.");
	}
	const compiled = state.compiled;
	if (!isPlainObject(compiled) || compiled.model !== guiRetainedCompilationModel || !/^[a-f\d]{64}$/.test(compiled.sourceFingerprint)) {
		throw new Error(`GUI retained compilation must use "${guiRetainedCompilationModel}" and a SHA-256 source fingerprint.`);
	}
	if (!Array.isArray(compiled.sources) || !compiled.sources.length || compiled.sources.length > maximumSourceFiles) {
		throw new Error(`GUI retained compilation must contain 1-${maximumSourceFiles} sources.`);
	}
	const sourcePaths = new Set<string>();
	compiled.sources = compiled.sources.map((source, index) => {
		if (!isPlainObject(source) || !(source.kind === "uxml" || source.kind === "uss" || source.kind === "template")) {
			throw new Error(`GUI retained source ${index} is invalid.`);
		}
		const extension = source.kind === "uss" ? ".uss" : ".uxml";
		const path = validateSourcePath(source.path, extension, `GUI retained source ${index} path`);
		if (sourcePaths.has(path) || !/^[a-f\d]{64}$/.test(source.sha256) || !Number.isInteger(source.bytes) || source.bytes < 0 || source.bytes > maximumDocumentBytes) {
			throw new Error(`GUI retained source ${index} has duplicate path or invalid fingerprint/size evidence.`);
		}
		sourcePaths.add(path);
		return { path, kind: source.kind, sha256: source.sha256, bytes: source.bytes };
	});
	if (!compiled.sources.some((source) => source.kind === "uxml" && source.path === state.uxmlPath)) {
		throw new Error("GUI retained compilation does not own its root UXML source.");
	}
	if (state.stylesheetPaths.some((path) => !compiled.sources.some((source) => source.kind === "uss" && source.path === path))) {
		throw new Error("GUI retained compilation is missing a declared USS source.");
	}
	if (state.templatePaths.some((path) => !compiled.sources.some((source) => source.kind === "template" && source.path === path))) {
		throw new Error("GUI retained compilation is missing a declared template source.");
	}
	if (!Array.isArray(compiled.controls) || !compiled.controls.length || compiled.controls.length > maximumNodes) {
		throw new Error(`GUI retained compilation must contain 1-${maximumNodes} controls.`);
	}
	const controlsById = new Map<string, IGUIRetainedCompiledControl>();
	compiled.controls = compiled.controls.map((control, index) => {
		if (!isPlainObject(control)) {
			throw new Error(`GUI retained control ${index} must be an object.`);
		}
		if (!/^[A-Za-z_][\w.:-]{0,127}$/.test(control.id) || controlsById.has(control.id)) {
			throw new Error(`GUI retained control ${index} id is invalid or duplicated.`);
		}
		if (!/^[A-Za-z_][\w.:-]{0,127}$/.test(control.sourceName) || typeof control.name !== "string" || !control.name || control.name.length > 128) {
			throw new Error(`GUI retained control "${control.id}" has invalid source/name identity.`);
		}
		if (control.parentId !== null && (!/^[A-Za-z_][\w.:-]{0,127}$/.test(control.parentId) || !controlsById.has(control.parentId))) {
			throw new Error(`GUI retained control "${control.id}" parent must precede it in document order.`);
		}
		if (!elementKinds.has(control.typeName) || !new Set(elementKinds.values()).has(control.kind)) {
			throw new Error(`GUI retained control "${control.id}" has unsupported type/kind.`);
		}
		if (
			!Array.isArray(control.classes) ||
			control.classes.length > 32 ||
			control.classes.some((className) => typeof className !== "string" || !/^[A-Za-z_][\w-]{0,63}$/.test(className)) ||
			new Set(control.classes).size !== control.classes.length
		) {
			throw new Error(`GUI retained control "${control.id}" classes are invalid.`);
		}
		const properties = normalizeCompiledProperties(control.properties, `GUI retained control "${control.id}" properties`);
		if (!isPlainObject(control.pseudoStyles) || Object.keys(control.pseudoStyles).some((pseudo) => !allowedPseudoStates.has(pseudo as GUIRetainedPseudoState))) {
			throw new Error(`GUI retained control "${control.id}" pseudo styles are invalid.`);
		}
		const pseudoStyles: Partial<Record<GUIRetainedPseudoState, IGUIRetainedControlProperties>> = {};
		for (const [pseudo, pseudoValue] of Object.entries(control.pseudoStyles)) {
			pseudoStyles[pseudo as GUIRetainedPseudoState] = normalizeCompiledProperties(pseudoValue, `GUI retained control "${control.id}" :${pseudo}`);
		}
		if (!Array.isArray(control.pseudoCascade) || control.pseudoCascade.length > maximumStyleRules) {
			throw new Error(`GUI retained control "${control.id}" pseudo cascade is invalid.`);
		}
		const pseudoCascade = control.pseudoCascade.map((entry, pseudoIndex) => {
			if (
				!isPlainObject(entry) ||
				!allowedPseudoStates.has(entry.state as GUIRetainedPseudoState) ||
				!Number.isInteger(entry.specificity) ||
				entry.specificity < 0 ||
				entry.specificity > 10000 ||
				!Number.isInteger(entry.order) ||
				entry.order < 0 ||
				entry.order > maximumStyleRules
			) {
				throw new Error(`GUI retained control "${control.id}" pseudo cascade entry ${pseudoIndex} is invalid.`);
			}
			return {
				state: entry.state as GUIRetainedPseudoState,
				properties: normalizeCompiledProperties(entry.properties, `GUI retained control "${control.id}" pseudo cascade entry ${pseudoIndex}`),
				specificity: entry.specificity,
				order: entry.order,
			};
		});
		if (
			pseudoCascade.some(
				(entry, index) =>
					index > 0 &&
					(entry.specificity < pseudoCascade[index - 1].specificity ||
						(entry.specificity === pseudoCascade[index - 1].specificity && entry.order < pseudoCascade[index - 1].order))
			)
		) {
			throw new Error(`GUI retained control "${control.id}" pseudo cascade must preserve CSS specificity and source order.`);
		}
		if (control.tooltip !== null && (typeof control.tooltip !== "string" || control.tooltip.length > 1024)) {
			throw new Error(`GUI retained control "${control.id}" tooltip is invalid.`);
		}
		if (control.bindingPath !== null && (typeof control.bindingPath !== "string" || control.bindingPath.length > 1024)) {
			throw new Error(`GUI retained control "${control.id}" bindingPath is invalid.`);
		}
		if (control.tabIndex !== null && (!Number.isInteger(control.tabIndex) || control.tabIndex < 0 || control.tabIndex > 32767)) {
			throw new Error(`GUI retained control "${control.id}" tabIndex is invalid.`);
		}
		for (const property of ["matchedRuleCount", "inlinePropertyCount"] as const) {
			if (!Number.isInteger(control[property]) || control[property] < 0 || control[property] > maximumStyleRules) {
				throw new Error(`GUI retained control "${control.id}" ${property} is invalid.`);
			}
		}
		const normalized: IGUIRetainedCompiledControl = { ...control, properties, pseudoStyles, pseudoCascade };
		controlsById.set(normalized.id, normalized);
		return normalized;
	});
	if (
		!Array.isArray(compiled.rootControlIds) ||
		compiled.rootControlIds.length !== compiled.controls.filter((control) => control.parentId === null).length ||
		compiled.rootControlIds.some((id) => !controlsById.has(id))
	) {
		throw new Error("GUI retained rootControlIds do not match the compiled root controls.");
	}
	const actualRoots = compiled.controls.filter((control) => control.parentId === null).map((control) => control.id);
	if (compiled.rootControlIds.some((id, index) => id !== actualRoots[index])) {
		throw new Error("GUI retained rootControlIds must preserve document order.");
	}
	if (liveControlIds && (liveControlIds.size !== controlsById.size || [...controlsById.keys()].some((id) => !liveControlIds.has(id)))) {
		throw new Error("GUI retained document no longer exactly owns the live control tree; refresh it or detach retained authoring before manual hierarchy edits.");
	}
	for (const property of ["styleRuleCount", "pseudoRuleCount"] as const) {
		if (!Number.isInteger(compiled[property]) || compiled[property] < 0 || compiled[property] > maximumStyleRules) {
			throw new Error(`GUI retained ${property} is invalid.`);
		}
	}
	if (compiled.pseudoRuleCount > compiled.styleRuleCount) {
		throw new Error("GUI retained pseudoRuleCount cannot exceed styleRuleCount.");
	}
	compiled.selectorStatistics ??= [];
	if (!Array.isArray(compiled.selectorStatistics) || compiled.selectorStatistics.length > maximumStyleRules) {
		throw new Error("GUI retained selectorStatistics are invalid.");
	}
	compiled.selectorStatistics = compiled.selectorStatistics.map((statistic, index) => {
		if (
			!isPlainObject(statistic) ||
			typeof statistic.selector !== "string" ||
			!statistic.selector ||
			statistic.selector.length > 1024 ||
			!Number.isInteger(statistic.specificity) ||
			statistic.specificity < 0 ||
			statistic.specificity > 10000 ||
			(statistic.pseudoState !== null && !allowedPseudoStates.has(statistic.pseudoState as GUIRetainedPseudoState)) ||
			!Number.isInteger(statistic.declarationCount) ||
			statistic.declarationCount < 0 ||
			statistic.declarationCount > maximumDeclarationsPerRule ||
			!Number.isInteger(statistic.matchedControlCount) ||
			statistic.matchedControlCount < 0 ||
			statistic.matchedControlCount > compiled.controls.length
		) {
			throw new Error(`GUI retained selector statistic ${index} is invalid.`);
		}
		const sourcePath = validateSourcePath(statistic.sourcePath, ".uss", `GUI retained selector statistic ${index} sourcePath`);
		if (!compiled.sources.some((source) => source.kind === "uss" && source.path === sourcePath)) {
			throw new Error(`GUI retained selector statistic ${index} references an unknown stylesheet.`);
		}
		return {
			sourcePath,
			selector: statistic.selector,
			specificity: statistic.specificity,
			pseudoState: statistic.pseudoState as GUIRetainedPseudoState | null,
			declarationCount: statistic.declarationCount,
			matchedControlCount: statistic.matchedControlCount,
		};
	});
	if (!Number.isInteger(compiled.templateCount) || compiled.templateCount < 0 || compiled.templateCount > state.templatePaths.length) {
		throw new Error("GUI retained templateCount is invalid.");
	}
	if (!Number.isInteger(compiled.generatedIdCount) || compiled.generatedIdCount < 0 || compiled.generatedIdCount > compiled.controls.length) {
		throw new Error("GUI retained generatedIdCount is invalid.");
	}
	if (!Number.isInteger(compiled.maximumDepth) || compiled.maximumDepth < 1 || compiled.maximumDepth > maximumDepth) {
		throw new Error("GUI retained maximumDepth is invalid.");
	}
	if (!Array.isArray(compiled.warnings) || compiled.warnings.length > 64 || compiled.warnings.some((warning) => typeof warning !== "string" || warning.length > 1024)) {
		throw new Error("GUI retained warnings are invalid.");
	}
	return state;
}

/** Compiles bounded Unity-style UXML and USS sources into a deterministic Babylon GUI-neutral retained tree. */
export async function compileGUIRetainedDocument(options: ICompileGUIRetainedDocumentOptions): Promise<IGUIRetainedCompilation> {
	const uxmlPath = validateSourcePath(options.uxmlPath, ".uxml", "UXML path");
	const stylesheetInputs = options.stylesheets ?? [];
	const templateInputs = options.templates ?? [];
	if (stylesheetInputs.length + templateInputs.length + 1 > maximumSourceFiles) {
		throw new Error(`Retained UI supports at most ${maximumSourceFiles} source files.`);
	}
	const stylesheetSources = new Map<string, string>();
	for (const file of stylesheetInputs) {
		const path = validateSourcePath(file.path, ".uss", "USS path");
		if (stylesheetSources.has(path)) {
			throw new Error(`USS source path "${path}" is duplicated.`);
		}
		stylesheetSources.set(path, file.source);
	}
	const templateSources = new Map<string, string>();
	for (const file of templateInputs) {
		const path = validateSourcePath(file.path, ".uxml", "Template UXML path");
		if (path === uxmlPath || templateSources.has(path)) {
			throw new Error(`Template UXML source path "${path}" is duplicated.`);
		}
		templateSources.set(path, file.source);
	}
	const roots = new Map<string, IXMLNode>([[uxmlPath, parseUXML(options.uxml, uxmlPath)]]);
	for (const [path, source] of templateSources) {
		roots.set(path, parseUXML(source, path));
	}
	const definitions = new Map<string, ITemplateDefinition>();
	const stylePaths: string[] = [];
	for (const [path, root] of roots) {
		collectSpecialNodes(root, path, definitions, stylePaths);
	}
	for (const path of stylePaths) {
		if (!stylesheetSources.has(path)) {
			throw new Error(`UXML references USS source "${path}", but its contents were not provided.`);
		}
	}
	const discoveredStylePaths = [...new Set(stylePaths)];
	const unreferencedStyles = [...stylesheetSources.keys()].filter((path) => !discoveredStylePaths.includes(path));
	discoveredStylePaths.push(...unreferencedStyles);
	let orderedStylePaths = discoveredStylePaths;
	if (options.stylesheetOrder !== undefined) {
		if (!Array.isArray(options.stylesheetOrder) || options.stylesheetOrder.length !== discoveredStylePaths.length) {
			throw new Error("Retained UI stylesheetOrder must contain every stylesheet exactly once.");
		}
		orderedStylePaths = options.stylesheetOrder.map((path, index) => validateSourcePath(path, ".uss", `Retained UI stylesheetOrder ${index}`));
		if (new Set(orderedStylePaths).size !== orderedStylePaths.length || discoveredStylePaths.some((path) => !orderedStylePaths.includes(path))) {
			throw new Error("Retained UI stylesheetOrder must contain every stylesheet exactly once.");
		}
	}
	const styleFiles = orderedStylePaths.map((path) => ({ path, source: stylesheetSources.get(path)! }));
	const rules = parseStylesheets(styleFiles);
	const controls: IMutableCompiledControl[] = [];
	const controlIds = new Set<string>();
	const usedTemplatePaths = new Set<string>();
	let generatedIdCount = 0;
	let greatestDepth = 0;
	let sequence = 0;
	const emptyVariables = new Map<string, string>();

	const compileNode = (node: IXMLNode, parentId: string | null, idPrefix: string, depth: number, templateStack: string[], inheritedClasses: string[] = []): void => {
		if (depth > maximumDepth) {
			throw new Error(`Compiled retained UI exceeds depth ${maximumDepth}.`);
		}
		greatestDepth = Math.max(greatestDepth, depth);
		if (node.tag === "Style" || node.tag === "Template") {
			return;
		}
		if (node.tag === "Instance") {
			if (node.children.length || node.text.trim()) {
				throw new Error("UXML Instance elements cannot contain inline children in the bounded template model.");
			}
			if (Object.keys(node.attributes).some((name) => !["template", "name", "class"].includes(name))) {
				throw new Error("UXML Instance supports only template, name, and class attributes.");
			}
			const templateName = node.attributes.template;
			const definition = templateName ? definitions.get(templateName) : undefined;
			if (!definition) {
				throw new Error(`UXML Instance references unknown template "${templateName ?? ""}".`);
			}
			if (templateStack.includes(definition.path) || templateStack.length >= maximumTemplateDepth) {
				throw new Error(`UXML template cycle or depth overflow includes "${definition.path}".`);
			}
			const templateRoot = roots.get(definition.path);
			if (!templateRoot) {
				throw new Error(`UXML template "${templateName}" source "${definition.path}" was not provided.`);
			}
			usedTemplatePaths.add(definition.path);
			const instanceName = node.attributes.name ?? `instance-${++sequence}`;
			if (!/^[A-Za-z_][\w.:-]{0,127}$/.test(instanceName)) {
				throw new Error(`UXML Instance name "${instanceName}" is invalid.`);
			}
			const instanceClasses = validateClassList(node.attributes.class, `UXML Instance "${instanceName}" class`);
			for (const child of templateRoot.children) {
				compileNode(child, parentId, `${idPrefix}${instanceName}::`, depth, [...templateStack, definition.path], instanceClasses);
			}
			return;
		}
		const kind = elementKinds.get(node.tag);
		if (!kind) {
			throw new Error(`UXML element <${node.tag}> is not supported by retained Babylon GUI authoring.`);
		}
		const allowedAttributes = new Set([
			"name",
			"id",
			"class",
			"style",
			"text",
			"src",
			"value",
			"checked",
			"enabled",
			"low-value",
			"high-value",
			"label",
			"tooltip",
			"binding-path",
			"tabindex",
			"interactable",
			"blocks-raycasts",
			"ignore-parent-groups",
			...styleAttributeNames,
		]);
		const unknownAttribute = Object.keys(node.attributes).find((name) => !allowedAttributes.has(name));
		if (unknownAttribute) {
			throw new Error(`UXML <${node.tag}> uses unsupported attribute "${unknownAttribute}".`);
		}
		const authoredName = node.attributes.name ?? node.attributes.id;
		const sourceName = authoredName ?? `${node.tag.toLowerCase()}-${++sequence}`;
		if (!authoredName) {
			generatedIdCount++;
		}
		if (!/^[A-Za-z_][\w.:-]{0,127}$/.test(sourceName)) {
			throw new Error(`UXML <${node.tag}> name/id "${sourceName}" is invalid.`);
		}
		const id = `${idPrefix}${sourceName}`;
		if (id.length > 128 || controlIds.has(id)) {
			throw new Error(`Compiled UXML control id "${id}" is duplicated or exceeds 128 characters.`);
		}
		controlIds.add(id);
		const classes = [...new Set([...inheritedClasses, ...validateClassList(node.attributes.class, `UXML control "${id}" class`)])];
		const inlineProperties = styleAttributes(node, emptyVariables);
		const text = node.attributes.text ?? node.text.trim();
		if (text) {
			inlineProperties.text = text.slice(0, 16384);
		}
		if (node.attributes.src) {
			const source = node.attributes.src.trim().replace(/\\/g, "/");
			if (!source || source.startsWith("/") || source.startsWith("../") || source.includes("/../") || source.length > 4096) {
				throw new Error(`UXML Image src for "${id}" must stay inside the project.`);
			}
			inlineProperties.source = source;
		}
		if (node.attributes.value && !Object.prototype.hasOwnProperty.call(inlineProperties, "value") && kind !== "inputText" && kind !== "inputTextArea") {
			inlineProperties.value = parseBoundedNumber(node.attributes.value, -1000000, 1000000, `UXML control "${id}" value`);
		}
		if (node.attributes.value && (kind === "inputText" || kind === "inputTextArea")) {
			inlineProperties.text = node.attributes.value.slice(0, 16384);
		}
		if (node.attributes.checked) {
			inlineProperties.isChecked = parseBoolean(node.attributes.checked, `UXML control "${id}" checked`);
		}
		if (node.attributes.enabled) {
			inlineProperties.isEnabled = parseBoolean(node.attributes.enabled, `UXML control "${id}" enabled`);
		}
		if (node.attributes.interactable) {
			inlineProperties.interactable = parseBoolean(node.attributes.interactable, `UXML CanvasGroup "${id}" interactable`);
		}
		if (node.attributes["blocks-raycasts"]) {
			inlineProperties.blocksRaycasts = parseBoolean(node.attributes["blocks-raycasts"], `UXML CanvasGroup "${id}" blocks-raycasts`);
		}
		if (node.attributes["ignore-parent-groups"]) {
			inlineProperties.ignoreParentGroups = parseBoolean(node.attributes["ignore-parent-groups"], `UXML CanvasGroup "${id}" ignore-parent-groups`);
		}
		if (kind !== "canvasGroup" && ["interactable", "blocks-raycasts", "ignore-parent-groups"].some((attribute) => node.attributes[attribute] !== undefined)) {
			throw new Error(`UXML control "${id}" may use CanvasGroup interaction attributes only on <CanvasGroup>.`);
		}
		if (node.attributes["low-value"]) {
			inlineProperties.minimum = parseBoundedNumber(node.attributes["low-value"], -1000000, 1000000, `UXML control "${id}" low-value`);
		}
		if (node.attributes["high-value"]) {
			inlineProperties.maximum = parseBoundedNumber(node.attributes["high-value"], -1000000, 1000000, `UXML control "${id}" high-value`);
		}
		if (inlineProperties.minimum !== undefined && inlineProperties.maximum !== undefined && inlineProperties.minimum >= inlineProperties.maximum) {
			throw new Error(`UXML Slider "${id}" low-value must be below high-value.`);
		}
		const tabIndex = node.attributes.tabindex === undefined ? null : parseBoundedNumber(node.attributes.tabindex, 0, 32767, `UXML control "${id}" tabindex`, true);
		const control: IMutableCompiledControl = {
			id,
			sourceName,
			parentId,
			typeName: node.tag,
			kind,
			name: node.attributes.label ?? sourceName,
			classes,
			properties: {},
			pseudoStyles: {},
			pseudoCascade: [],
			tooltip: node.attributes.tooltip?.slice(0, 1024) ?? null,
			bindingPath: node.attributes["binding-path"]?.slice(0, 1024) ?? null,
			tabIndex,
			matchedRuleCount: 0,
			inlinePropertyCount: Object.keys(inlineProperties).length,
			_inlineProperties: inlineProperties,
		};
		controls.push(control);
		if (controls.length > maximumNodes) {
			throw new Error(`Compiled retained UI exceeds ${maximumNodes.toLocaleString()} controls.`);
		}
		if (node.children.length && !containerKinds.has(kind)) {
			throw new Error(`UXML control "${id}" of type <${node.tag}> cannot contain child controls.`);
		}
		for (const child of node.children) {
			compileNode(child, id, idPrefix, depth + 1, templateStack);
		}
	};

	for (const child of roots.get(uxmlPath)!.children) {
		compileNode(child, null, "", 1, [uxmlPath]);
	}
	if (!controls.length) {
		throw new Error("UXML must compile at least one visual control.");
	}
	const controlsById = new Map(controls.map((control) => [control.id, control]));
	const orderedRules = rules.slice().sort((left, right) => left.specificity - right.specificity || left.order - right.order);
	for (const control of controls) {
		const staticRules = orderedRules.filter((rule) => !rule.pseudo && selectorMatches(rule.parts, control, controlsById));
		control.matchedRuleCount = staticRules.length;
		control.properties = Object.assign({}, ...staticRules.map((rule) => rule.properties), control._inlineProperties);
		for (const pseudo of allowedPseudoStates) {
			const stateRules = orderedRules.filter((rule) => rule.pseudo === pseudo && selectorMatches(rule.parts, control, controlsById));
			if (stateRules.length) {
				const stateProperties = Object.assign({}, ...stateRules.map((rule) => rule.properties));
				for (const property of Object.keys(control._inlineProperties)) {
					delete stateProperties[property as keyof IGUIRetainedControlProperties];
				}
				if (Object.keys(stateProperties).length) {
					control.pseudoStyles[pseudo] = stateProperties;
				}
			}
		}
		control.pseudoCascade = orderedRules
			.filter((rule) => rule.pseudo && selectorMatches(rule.parts, control, controlsById))
			.map((rule) => {
				const properties = { ...rule.properties };
				for (const property of Object.keys(control._inlineProperties)) {
					delete properties[property as keyof IGUIRetainedControlProperties];
				}
				return { state: rule.pseudo!, properties, specificity: rule.specificity, order: rule.order };
			})
			.filter((rule) => Object.keys(rule.properties).length > 0);
		delete (control as Partial<IMutableCompiledControl>)._inlineProperties;
	}
	const sources: IGUIRetainedSourceFingerprint[] = [];
	const sourceEntries: Array<{ path: string; kind: IGUIRetainedSourceFingerprint["kind"]; source: string }> = [
		{ path: uxmlPath, kind: "uxml", source: options.uxml },
		...styleFiles.map((file) => ({ ...file, kind: "uss" as const })),
		...[...usedTemplatePaths].sort().map((path) => ({ path, kind: "template" as const, source: templateSources.get(path)! })),
	];
	for (const entry of sourceEntries) {
		sources.push({ path: entry.path, kind: entry.kind, sha256: await sha256(entry.source), bytes: utf8Bytes(entry.source) });
	}
	const sourceFingerprint = await sha256(sources.map((source) => `${source.kind}\0${source.path}\0${source.sha256}\0${source.bytes}`).join("\n"));
	return {
		model: guiRetainedCompilationModel,
		sourceFingerprint,
		sources,
		controls: controls as IGUIRetainedCompiledControl[],
		rootControlIds: controls.filter((control) => control.parentId === null).map((control) => control.id),
		styleRuleCount: rules.length,
		pseudoRuleCount: rules.filter((rule) => rule.pseudo !== null).length,
		selectorStatistics: rules.map((rule) => ({
			sourcePath: rule.sourcePath,
			selector: rule.selector,
			specificity: rule.specificity,
			pseudoState: rule.pseudo,
			declarationCount: Object.keys(rule.properties).length,
			matchedControlCount: controls.filter((control) => selectorMatches(rule.parts, control, controlsById)).length,
		})),
		templateCount: usedTemplatePaths.size,
		generatedIdCount,
		maximumDepth: greatestDepth,
		warnings: generatedIdCount ? [`${generatedIdCount} control id(s) were generated from source order; add stable name attributes before collaborative editing.`] : [],
	};
}
