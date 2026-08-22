import { Scene } from "babylonjs";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";
import { IMobileDeploymentConfiguration, normalizeMobileDeploymentConfiguration, validateMobileDeploymentConfiguration } from "./model";

const targetFields = {
	android: ["variant", "format", "applicationId", "launchActivity", "gradleTask", "signing", "store"],
	ios: ["variant", "applicationId", "workspace", "scheme", "archivePath", "exportDirectory", "exportMethod", "signing", "store"],
};
const androidSigningFields = ["enabled", "keystorePathEnvironment", "keystorePasswordEnvironment", "keyAliasEnvironment", "keyPasswordEnvironment"];
const androidStoreFields = ["credentialPathEnvironment", "track", "releaseStatus"];
const iosSigningFields = ["enabled", "teamIdEnvironment", "identityEnvironment"];
const iosStoreFields = ["apiKeyPathEnvironment", "submitForReview"];

interface IMobileConfigurationSnapshot {
	hadMetadata: boolean;
	hadConfiguration: boolean;
	configuration: unknown;
}

function assertRecord(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function validateChanges(value: unknown): asserts value is Record<string, unknown> {
	assertRecord(value, ["android", "ios"], "Mobile Deployment changes");
	if (!Object.keys(value).length) {
		throw new Error("Mobile Deployment changes must contain android or ios fields.");
	}
	for (const target of ["android", "ios"] as const) {
		if (value[target] === undefined) {
			continue;
		}
		assertRecord(value[target], targetFields[target], `${target} deployment changes`);
		const changes = value[target] as Record<string, unknown>;
		if (!Object.keys(changes).length) {
			throw new Error(`${target} deployment changes must contain at least one field.`);
		}
		if (changes.signing !== undefined) {
			assertRecord(changes.signing, target === "android" ? androidSigningFields : iosSigningFields, `${target} signing changes`);
		}
		if (changes.store !== undefined) {
			assertRecord(changes.store, target === "android" ? androidStoreFields : iosStoreFields, `${target} store changes`);
		}
		const stringFields = target === "android" ? ["applicationId", "launchActivity"] : ["applicationId", "workspace", "scheme", "archivePath", "exportDirectory"];
		for (const field of stringFields) {
			if (changes[field] !== undefined && typeof changes[field] !== "string") {
				throw new Error(`${target} ${field} must be a string.`);
			}
		}
		if (changes.variant !== undefined && changes.variant !== "debug" && changes.variant !== "release") {
			throw new Error(`${target} variant must be debug or release.`);
		}
		if (target === "android") {
			if (changes.format !== undefined && changes.format !== "apk" && changes.format !== "aab") {
				throw new Error("android format must be apk or aab.");
			}
			if (changes.gradleTask !== undefined && changes.gradleTask !== null && typeof changes.gradleTask !== "string") {
				throw new Error("android gradleTask must be a string or null.");
			}
		} else if (changes.exportMethod !== undefined && !["development", "ad-hoc", "app-store-connect"].includes(changes.exportMethod as string)) {
			throw new Error("ios exportMethod must be development, ad-hoc, or app-store-connect.");
		}
		if (changes.signing !== undefined) {
			const signing = changes.signing as Record<string, unknown>;
			if (signing.enabled !== undefined && typeof signing.enabled !== "boolean") {
				throw new Error(`${target} signing enabled must be a boolean.`);
			}
			for (const [field, entry] of Object.entries(signing)) {
				if (field !== "enabled" && entry !== undefined && entry !== null && typeof entry !== "string") {
					throw new Error(`${target} signing ${field} must be a string or null.`);
				}
			}
		}
		if (changes.store !== undefined) {
			const store = changes.store as Record<string, unknown>;
			if (target === "android") {
				if (store.credentialPathEnvironment !== undefined && store.credentialPathEnvironment !== null && typeof store.credentialPathEnvironment !== "string") {
					throw new Error("android store credentialPathEnvironment must be a string or null.");
				}
				if (store.track !== undefined && !["internal", "alpha", "beta", "production"].includes(store.track as string)) {
					throw new Error("android store track must be internal, alpha, beta, or production.");
				}
				if (store.releaseStatus !== undefined && store.releaseStatus !== "draft" && store.releaseStatus !== "completed") {
					throw new Error("android store releaseStatus must be draft or completed.");
				}
			} else {
				if (store.apiKeyPathEnvironment !== undefined && store.apiKeyPathEnvironment !== null && typeof store.apiKeyPathEnvironment !== "string") {
					throw new Error("ios store apiKeyPathEnvironment must be a string or null.");
				}
				if (store.submitForReview !== undefined && typeof store.submitForReview !== "boolean") {
					throw new Error("ios store submitForReview must be a boolean.");
				}
			}
		}
	}
}

function defaultApplicationId(options?: IMCPActionOptions): string {
	const value = options?.editor.state.projectSettings?.identity?.applicationId;
	return typeof value === "string" && value.trim() ? value.trim() : "com.zvibe.game";
}

function snapshot(scene: Scene): IMobileConfigurationSnapshot {
	return {
		hadMetadata: Boolean(scene.metadata),
		hadConfiguration: Boolean(scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, "babylonEditorMobileDeployment")),
		configuration: structuredClone(scene.metadata?.babylonEditorMobileDeployment),
	};
}

function refresh(scene: Scene, options: IMCPActionOptions): void {
	options.editor.layout.inspector?.setEditedObject?.(scene);
	options.editor.layout.inspector?.forceUpdate?.();
	(options.editor.layout as any).mobile?.forceUpdate?.();
}

function restore(scene: Scene, value: IMobileConfigurationSnapshot, options: IMCPActionOptions): void {
	if (value.hadConfiguration) {
		scene.metadata ??= {};
		scene.metadata.babylonEditorMobileDeployment = structuredClone(value.configuration);
	} else if (scene.metadata) {
		delete scene.metadata.babylonEditorMobileDeployment;
		if (!value.hadMetadata && Object.keys(scene.metadata).length === 0) {
			scene.metadata = null;
		}
	}
	refresh(scene, options);
}

/** Reads normalized deployment settings without writing defaults into scene metadata. */
export function getMobileDeploymentConfiguration(scene: Scene, options?: IMCPActionOptions): IMobileDeploymentConfiguration {
	return normalizeMobileDeploymentConfiguration(scene.metadata?.babylonEditorMobileDeployment, defaultApplicationId(options));
}

/** Atomically patches Android/iOS deployment settings under one exact scene revision. */
export function setMobileDeploymentConfiguration(scene: Scene, data: unknown, options: IMCPActionOptions): IMobileDeploymentConfiguration {
	assertRecord(data, ["expectedRevision", "changes", "endpoint", "collaborationToken"], "set_mobile_deployment_configuration input");
	validateChanges(data.changes);
	const current = getMobileDeploymentConfiguration(scene, options);
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== current.revision) {
		throw new Error(`Mobile Deployment revision is stale: expected ${String(data.expectedRevision)}, current ${current.revision}.`);
	}
	const changes = structuredClone(data.changes);
	const androidChanges = (changes.android ?? {}) as Record<string, unknown>;
	const iosChanges = (changes.ios ?? {}) as Record<string, unknown>;
	const next = normalizeMobileDeploymentConfiguration(
		{
			...current,
			revision: current.revision + 1,
			android: {
				...current.android,
				...androidChanges,
				signing: { ...current.android.signing, ...((androidChanges.signing ?? {}) as Record<string, unknown>) },
				store: { ...current.android.store, ...((androidChanges.store ?? {}) as Record<string, unknown>) },
			},
			ios: {
				...current.ios,
				...iosChanges,
				signing: { ...current.ios.signing, ...((iosChanges.signing ?? {}) as Record<string, unknown>) },
				store: { ...current.ios.store, ...((iosChanges.store ?? {}) as Record<string, unknown>) },
			},
		},
		defaultApplicationId(options)
	);
	validateMobileDeploymentConfiguration(next);
	const previous = snapshot(scene);
	scene.metadata ??= {};
	scene.metadata.babylonEditorMobileDeployment = structuredClone(next);
	refresh(scene, options);
	registerUndoRedo({
		undo: () => restore(scene, previous, options),
		redo: () => {
			scene.metadata ??= {};
			scene.metadata.babylonEditorMobileDeployment = structuredClone(next);
			refresh(scene, options);
		},
	});
	return structuredClone(next);
}
