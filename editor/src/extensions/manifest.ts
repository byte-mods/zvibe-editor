import { createHash } from "crypto";

import {
	editorExtensionApiVersion,
	editorExtensionCapabilities,
	EditorExtensionCapability,
	EditorExtensionBuildTarget,
	IEditorExtensionBuildProfileFooterContribution,
	IEditorExtensionContributions,
	IEditorExtensionInspectorContribution,
	IEditorExtensionManifest,
	IEditorExtensionMenuContribution,
	IEditorExtensionTestContribution,
	IEditorExtensionWindowContribution,
} from "./types";

// These bounds keep package metadata cheap to validate before any third-party code executes.
const extensionIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const contributionIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const maximumContributionsPerKind = 64;
const capabilitySet = new Set<string>(editorExtensionCapabilities);

function plainObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown) {
		throw new Error(`${label} contains unsupported field "${unknown}".`);
	}
}

function boundedString(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
	}
	return value.trim();
}

function containsControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function contributionId(value: unknown, extensionId: string, label: string): string {
	const id = boundedString(value, `${label}.id`, 160);
	if (!contributionIdPattern.test(id) || !id.startsWith(`${extensionId}.`)) {
		throw new Error(`${label}.id must use lowercase identifier segments and start with "${extensionId}.".`);
	}
	return id;
}

function contributionArray(value: unknown, label: string): unknown[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > maximumContributionsPerKind) {
		throw new Error(`${label} must contain at most ${maximumContributionsPerKind} entries.`);
	}
	return value;
}

function inspectors(value: unknown, extensionId: string): IEditorExtensionInspectorContribution[] {
	return contributionArray(value, "contributes.inspectors").map((entry, index) => {
		const label = `contributes.inspectors[${index}]`;
		const object = plainObject(entry, label);
		exactKeys(object, ["id", "title", "priority"], label);
		const priority = object.priority ?? 0;
		if (!Number.isInteger(priority) || Number(priority) < -1000 || Number(priority) > 1000) {
			throw new Error(`${label}.priority must be an integer from -1000 through 1000.`);
		}
		return { id: contributionId(object.id, extensionId, label), title: boundedString(object.title, `${label}.title`, 80), priority: Number(priority) };
	});
}

function windows(value: unknown, extensionId: string): IEditorExtensionWindowContribution[] {
	return contributionArray(value, "contributes.windows").map((entry, index) => {
		const label = `contributes.windows[${index}]`;
		const object = plainObject(entry, label);
		exactKeys(object, ["id", "title", "neighborId"], label);
		if (object.neighborId !== undefined && object.neighborId !== "inspector" && object.neighborId !== "assets-browser") {
			throw new Error(`${label}.neighborId must be inspector or assets-browser.`);
		}
		return {
			id: contributionId(object.id, extensionId, label),
			title: boundedString(object.title, `${label}.title`, 80),
			...(object.neighborId ? { neighborId: object.neighborId as "inspector" | "assets-browser" } : {}),
		};
	});
}

function menus(value: unknown, extensionId: string): IEditorExtensionMenuContribution[] {
	return contributionArray(value, "contributes.menus").map((entry, index) => {
		const label = `contributes.menus[${index}]`;
		const object = plainObject(entry, label);
		exactKeys(object, ["id", "path"], label);
		const path = boundedString(object.path, `${label}.path`, 196);
		const segments = path.split("/");
		if (segments.length < 1 || segments.length > 4 || segments.some((segment) => !segment.trim() || segment.length > 48 || containsControlCharacter(segment))) {
			throw new Error(`${label}.path must contain 1–4 non-empty slash-separated segments of at most 48 characters.`);
		}
		return { id: contributionId(object.id, extensionId, label), path: segments.map((segment) => segment.trim()).join("/") };
	});
}

function tests(value: unknown, extensionId: string): IEditorExtensionTestContribution[] {
	return contributionArray(value, "contributes.tests").map((entry, index) => {
		const label = `contributes.tests[${index}]`;
		const object = plainObject(entry, label);
		exactKeys(object, ["id", "title"], label);
		return { id: contributionId(object.id, extensionId, label), title: boundedString(object.title, `${label}.title`, 80) };
	});
}

function buildProfileFooterActions(value: unknown, extensionId: string): IEditorExtensionBuildProfileFooterContribution[] {
	const supportedTargets = new Set<EditorExtensionBuildTarget>(["web", "electron", "headless", "android", "ios"]);
	return contributionArray(value, "contributes.buildProfileFooterActions").map((entry, index) => {
		const label = `contributes.buildProfileFooterActions[${index}]`;
		const object = plainObject(entry, label);
		exactKeys(object, ["id", "title", "description", "order", "targets", "activeProfileOnly"], label);
		const order = object.order ?? 0;
		if (!Number.isInteger(order) || Number(order) < -1000 || Number(order) > 1000) {
			throw new Error(`${label}.order must be an integer from -1000 through 1000.`);
		}
		if (object.activeProfileOnly !== undefined && typeof object.activeProfileOnly !== "boolean") {
			throw new Error(`${label}.activeProfileOnly must be a boolean.`);
		}
		const targetValues = object.targets ?? [];
		if (!Array.isArray(targetValues) || targetValues.length > supportedTargets.size) {
			throw new Error(`${label}.targets must contain at most ${supportedTargets.size} supported targets.`);
		}
		const targets = targetValues.map((target, targetIndex) => {
			if (typeof target !== "string" || !supportedTargets.has(target as EditorExtensionBuildTarget)) {
				throw new Error(`${label}.targets[${targetIndex}] is unsupported.`);
			}
			return target as EditorExtensionBuildTarget;
		});
		if (new Set(targets).size !== targets.length) {
			throw new Error(`${label}.targets must not contain duplicates.`);
		}
		return {
			id: contributionId(object.id, extensionId, label),
			title: boundedString(object.title, `${label}.title`, 80),
			...(object.description === undefined ? {} : { description: boundedString(object.description, `${label}.description`, 240) }),
			order: Number(order),
			targets,
			activeProfileOnly: object.activeProfileOnly === true,
		};
	});
}

function capabilities(value: unknown): EditorExtensionCapability[] {
	if (!Array.isArray(value) || value.length > editorExtensionCapabilities.length) {
		throw new Error(`capabilities must contain at most ${editorExtensionCapabilities.length} supported values.`);
	}
	const result = value.map((entry, index) => {
		if (typeof entry !== "string" || !capabilitySet.has(entry)) {
			throw new Error(`capabilities[${index}] is unsupported.`);
		}
		return entry as EditorExtensionCapability;
	});
	if (new Set(result).size !== result.length) {
		throw new Error("capabilities must not contain duplicates.");
	}
	return result;
}

function validateContributionCapabilities(contributes: IEditorExtensionContributions, declared: readonly EditorExtensionCapability[]): void {
	for (const capability of ["inspectors", "windows", "menus", "tests"] as const) {
		if (contributes[capability].length && !declared.includes(capability)) {
			throw new Error(`Capability "${capability}" is required by its declared contributions.`);
		}
	}
	if (contributes.buildProfileFooterActions.length && !declared.includes("buildProfiles")) {
		throw new Error('Capability "buildProfiles" is required by its declared contributions.');
	}
	const ids = Object.values(contributes).flatMap((entries) => entries.map((entry) => entry.id));
	if (new Set(ids).size !== ids.length) {
		throw new Error("Contribution ids must be unique across inspectors, windows, menus, tests, and Build Profile footer actions.");
	}
}

/** Parses an untrusted package manifest into the exact versioned SDK contract. */
export function normalizeEditorExtensionManifest(value: unknown): IEditorExtensionManifest {
	const object = plainObject(value, "zvibeEditor");
	exactKeys(object, ["apiVersion", "id", "displayName", "description", "capabilities", "contributes"], "zvibeEditor");
	if (object.apiVersion !== editorExtensionApiVersion) {
		throw new Error(`zvibeEditor.apiVersion must be ${editorExtensionApiVersion}.`);
	}
	const id = boundedString(object.id, "zvibeEditor.id", 128);
	if (!extensionIdPattern.test(id)) {
		throw new Error("zvibeEditor.id must be a lowercase dotted or hyphenated identifier.");
	}
	const declaredCapabilities = capabilities(object.capabilities);
	const rawContributions = object.contributes === undefined ? {} : plainObject(object.contributes, "zvibeEditor.contributes");
	exactKeys(rawContributions, ["inspectors", "windows", "menus", "tests", "buildProfileFooterActions"], "zvibeEditor.contributes");
	const contributes = {
		inspectors: inspectors(rawContributions.inspectors, id),
		windows: windows(rawContributions.windows, id),
		menus: menus(rawContributions.menus, id),
		tests: tests(rawContributions.tests, id),
		buildProfileFooterActions: buildProfileFooterActions(rawContributions.buildProfileFooterActions, id),
	};
	validateContributionCapabilities(contributes, declaredCapabilities);
	return {
		apiVersion: editorExtensionApiVersion,
		id,
		displayName: boundedString(object.displayName, "zvibeEditor.displayName", 80),
		...(object.description === undefined ? {} : { description: boundedString(object.description, "zvibeEditor.description", 500) }),
		capabilities: declaredCapabilities,
		contributes,
	};
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableValue(entry)])
		);
	}
	return value;
}

/** Produces lowercase SHA-256 values used by extension integrity records. */
export function editorExtensionSha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Hashes canonical JSON so equivalent objects have the same trust fingerprint. */
export function editorExtensionFingerprint(value: unknown): string {
	const serialized = JSON.stringify(stableValue(value));
	if (serialized === undefined) {
		throw new Error("Extension fingerprint input must be JSON-serializable.");
	}
	return editorExtensionSha256(serialized);
}
