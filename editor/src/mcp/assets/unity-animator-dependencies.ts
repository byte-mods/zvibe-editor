import { createHash } from "crypto";
import { createReadStream } from "fs";
import { dirname, join, normalize, relative, resolve } from "path/posix";

import { readFile, realpath, stat } from "fs-extra";
import { Scene } from "babylonjs";
import {
	executeAnimationImporterSource,
	IAnimatorControllerBehaviourBinding,
	IHumanoidAvatar,
	IHumanoidAvatarMask,
	IImportedAnimatorControllerDocument,
	normalizeAnimationImporterSettings,
	parseUnityAvatarMaskAsset,
	scriptsDictionary,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { getUnityAssetGuidIndex, IUnityAssetGuidIndexEntry } from "./registry";

export const UNITY_ANIMATION_SOURCE_METADATA_KEY = "babylonEditorUnityAssetSource";

export interface IUnityAnimatorDependencySource {
	guid: string;
	fileId: string;
	path: string;
	metaPath: string;
	contentHash: string;
	metaHash: string;
	name: string | null;
}

export interface IUnityAnimatorMotionBindingPlan {
	key: string;
	fileId: string;
	guid: string | null;
	type: number | null;
	suggestedAnimationGroup: string;
	usedBy: string[];
	suggestedMatch: string | null;
	resolution: "unity-guid-provenance" | "unity-guid-fileid-name" | "legacy-suggested-name" | "unresolved";
	dependency: IUnityAnimatorDependencySource | null;
	diagnostics: string[];
}

export interface IUnityAnimatorAvatarMaskBindingPlan {
	key: string;
	fileId: string;
	guid: string | null;
	type: number | null;
	suggestedAvatarMask: string;
	usedBy: string[];
	suggestedMatch: string | null;
	resolution: "unity-guid-provenance" | "unity-guid-mask-name" | "unity-guid-auto-import" | "legacy-suggested-name" | "unresolved";
	dependency: IUnityAnimatorDependencySource | null;
	autoImport: {
		maskId: string;
		avatarId: string;
		avatarName: string;
		name: string;
		bodyParts: Record<string, boolean>;
		transformNames: string[];
		disabledTransformNames: string[];
		ignoredIkBodyParts: Array<{ name: string; active: boolean }>;
	} | null;
	diagnostics: string[];
}

export interface IUnityAnimatorBehaviourBindingPlan extends IAnimatorControllerBehaviourBinding {
	suggestedMatch: string | null;
	resolution: "unity-guid-attached-script" | "unresolved";
	dependency: IUnityAnimatorDependencySource | null;
	diagnostics: string[];
}

export interface IUnityAnimatorScriptTargetPlan {
	id: string;
	name: string;
	attachedScriptKeys: string[];
}

export interface IUnityAnimatorControllerBindingPlan {
	fingerprint: string;
	artifactFingerprint: string;
	unityGuidIndexFingerprint: string;
	motionBindings: IUnityAnimatorMotionBindingPlan[];
	avatarMaskBindings: IUnityAnimatorAvatarMaskBindingPlan[];
	behaviourBindings: IUnityAnimatorBehaviourBindingPlan[];
	unresolvedMotionBindings: string[];
	unresolvedAvatarMaskBindings: string[];
	unresolvedBehaviourBindings: string[];
	availableAnimationGroups: string[];
	availableAvatarMasks: Array<{ id: string; name: string }>;
	availableHumanoidAvatars: Array<{ id: string; name: string }>;
	selectedScriptTarget: IUnityAnimatorScriptTargetPlan | null;
	availableScriptTargets: IUnityAnimatorScriptTargetPlan[];
	guidIndexDiagnostics: {
		entryCount: number;
		duplicates: Array<{ guid: string; assetPaths: string[] }>;
		malformed: Array<{ metaPath: string; error: string }>;
	};
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function absoluteProjectPath(path: string): string {
	const root = projectDirectory();
	const absolute = normalize(join(root, path));
	if (absolute !== root && !absolute.startsWith(`${root}/`)) {
		throw new Error("Unity dependency paths must stay inside the open project directory.");
	}
	return absolute;
}

async function readBoundedText(path: string, maximumBytes: number): Promise<string> {
	const details = await stat(path);
	if (!details.isFile() || details.size > maximumBytes) {
		throw new Error(`Dependency must be a regular file no larger than ${maximumBytes} bytes.`);
	}
	return readFile(path, "utf-8");
}

async function exactDependencyEntry(entry: IUnityAssetGuidIndexEntry): Promise<IUnityAssetGuidIndexEntry> {
	const path = absoluteProjectPath(entry.assetPath);
	let details;
	try {
		const rootRealPath = await realpath(projectDirectory());
		const assetRealPath = await realpath(path);
		if (assetRealPath !== rootRealPath && !assetRealPath.startsWith(`${rootRealPath}/`)) {
			return { ...entry, assetContentHash: null, assetHashDeferred: true };
		}
		details = await stat(path);
	} catch {
		return { ...entry, assetContentHash: null, assetHashDeferred: true };
	}
	if (!details.isFile()) {
		return { ...entry, assetContentHash: null, assetHashDeferred: true };
	}
	if (details.size > 64 * 1024 * 1024) {
		return { ...entry, assetContentHash: null, assetHashDeferred: true };
	}
	const assetContentHash = await new Promise<string>((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
	return { ...entry, assetContentHash, assetHashDeferred: false };
}

function sourceEvidence(entry: IUnityAssetGuidIndexEntry, fileId: string, name: string | null): IUnityAnimatorDependencySource | null {
	return entry.assetContentHash
		? {
				guid: entry.guid,
				fileId,
				path: entry.assetPath,
				metaPath: entry.metaPath,
				contentHash: entry.assetContentHash,
				metaHash: entry.metaContentHash,
				name,
			}
		: null;
}

function matchingEntry(binding: { guid: string | null }, byGuid: Map<string, IUnityAssetGuidIndexEntry[]>): { entry: IUnityAssetGuidIndexEntry | null; diagnostics: string[] } {
	if (!binding.guid) {
		return { entry: null, diagnostics: ["The Unity reference is local to the controller but is not a supported embedded Blend Tree."] };
	}
	const matches = byGuid.get(binding.guid) ?? [];
	if (matches.length === 0) {
		return { entry: null, diagnostics: [`Unity GUID ${binding.guid} has no indexed project .meta match.`] };
	}
	if (matches.length > 1) {
		return { entry: null, diagnostics: [`Unity GUID ${binding.guid} is duplicated by ${matches.map((match) => match.assetPath).join(", ")}.`] };
	}
	if (matches[0].assetHashDeferred || !matches[0].assetContentHash) {
		return {
			entry: null,
			diagnostics: [`Unity dependency ${matches[0].assetPath} is missing, unreadable, or exceeds the 64 MiB exact-hash limit and cannot be bound automatically.`],
		};
	}
	return { entry: matches[0], diagnostics: [] };
}

async function motionName(entry: IUnityAssetGuidIndexEntry, fileId: string): Promise<{ name: string | null; diagnostics: string[] }> {
	const tableName = entry.subAssets.find((candidate) => candidate.fileId === fileId)?.name ?? null;
	if (tableName) {
		return { name: tableName, diagnostics: [] };
	}
	if (entry.assetExtension !== ".anim") {
		return { name: null, diagnostics: [`Unity dependency ${entry.assetPath} has no exact AnimationClip fileID ${fileId} name in its .meta table.`] };
	}
	try {
		const source = await readBoundedText(absoluteProjectPath(entry.assetPath), 64 * 1024 * 1024);
		const header = [...source.matchAll(/^---\s+!u!74\s+&(-?\d+)\s*$/gm)].map((match) => match[1]);
		if (header.length !== 1 || header[0] !== fileId) {
			return { name: null, diagnostics: [`Unity AnimationClip ${entry.assetPath} does not contain exact class-74 fileID ${fileId}.`] };
		}
		const imported = executeAnimationImporterSource(source, entry.assetPath, normalizeAnimationImporterSettings({ resampleCurves: false, compression: "none" }));
		if (imported.errors.length || imported.clips.length !== 1) {
			return {
				name: null,
				diagnostics: [`Unity AnimationClip ${entry.assetPath} could not provide one valid clip name: ${imported.errors.join("; ") || "clip count is not one"}.`],
			};
		}
		return { name: imported.clips[0].name, diagnostics: [] };
	} catch (error) {
		return { name: null, diagnostics: [`Unity AnimationClip ${entry.assetPath} could not be inspected: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

function sameUnitySource(value: unknown, dependency: IUnityAnimatorDependencySource): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const source = value as Record<string, unknown>;
	return (
		source.guid === dependency.guid &&
		String(source.fileId) === dependency.fileId &&
		source.path === dependency.path &&
		source.contentHash === dependency.contentHash &&
		source.metaHash === dependency.metaHash
	);
}

function uniqueByName<T extends { name: string }>(values: T[], name: string): T | null {
	const matches = values.filter((value) => value.name === name);
	return matches.length === 1 ? matches[0] : null;
}

function automaticMaskId(guid: string, fileId: string, avatarId: string): string {
	return `unity-mask:${guid}:${fileId}:${avatarId}`.slice(0, 256);
}

function attachedScriptKeys(node: any): string[] {
	return [
		...new Set<string>([
			...((node.metadata?.scripts ?? []).map((script: any) => script.key).filter((key: unknown): key is string => typeof key === "string" && key.length > 0) as string[]),
			...((scriptsDictionary.get(node) ?? []).map((script) => script.key).filter((key): key is string => typeof key === "string" && key.length > 0) as string[]),
		]),
	].sort();
}

function scriptTargetPlan(node: any): IUnityAnimatorScriptTargetPlan {
	return { id: node.id, name: node.name, attachedScriptKeys: attachedScriptKeys(node) };
}

function resolveScriptTarget(scene: Scene, targetNodeId?: string, targetNodeName?: string): any | null {
	if (!targetNodeId && !targetNodeName) {
		return null;
	}
	const byId = targetNodeId ? scene.getNodeById(targetNodeId) : null;
	const byName = targetNodeName ? scene.getNodes().filter((node) => node.name === targetNodeName) : [];
	if (targetNodeId && !byId) {
		throw new Error(`Animator script target node id "${targetNodeId}" was not found.`);
	}
	if (targetNodeName && byName.length !== 1) {
		throw new Error(`Animator script target name "${targetNodeName}" must resolve to exactly one scene node; found ${byName.length}.`);
	}
	if (byId && byName[0] && byId !== byName[0]) {
		throw new Error("Animator targetNodeId and targetNodeName resolve to different scene nodes.");
	}
	return byId ?? byName[0] ?? null;
}

/** Resolves Unity controller references through exact .meta GUID/fileID evidence, with explicit bounded compatibility fallbacks. */
export async function getUnityAnimatorControllerBindingPlan(
	scene: Scene,
	document: IImportedAnimatorControllerDocument,
	artifactFingerprint: string,
	targetSelection: { targetNodeId?: string; targetNodeName?: string } = {}
): Promise<IUnityAnimatorControllerBindingPlan> {
	const index = await getUnityAssetGuidIndex();
	const referencedGuids = new Set(
		[
			...[...document.motionBindings, ...document.avatarMaskBindings].map((binding) => binding.guid),
			...(document.behaviourBindings ?? []).map((binding) => binding.scriptGuid),
		].filter((guid): guid is string => guid !== null)
	);
	const byGuid = new Map<string, IUnityAssetGuidIndexEntry[]>();
	for (const entry of index.entries) {
		if (referencedGuids.has(entry.guid)) {
			const exact = await exactDependencyEntry(entry);
			byGuid.set(entry.guid, [...(byGuid.get(entry.guid) ?? []), exact]);
		}
	}
	const groups = scene.animationGroups.slice().sort((left, right) => left.name.localeCompare(right.name));
	const masks = ((scene.metadata?.babylonEditorHumanoidAvatarMasks ?? []) as IHumanoidAvatarMask[]).slice().sort((left, right) => left.id.localeCompare(right.id));
	const avatars = ((scene.metadata?.babylonEditorHumanoidAvatars ?? []) as IHumanoidAvatar[])
		.filter((avatar) => avatar.animationType === "humanoid")
		.slice()
		.sort((left, right) => left.id.localeCompare(right.id));
	const selectedTargetNode = resolveScriptTarget(scene, targetSelection.targetNodeId, targetSelection.targetNodeName);
	const discoveredScriptTargets = scene
		.getNodes()
		.map(scriptTargetPlan)
		.filter((target) => target.attachedScriptKeys.length > 0 || target.id === selectedTargetNode?.id)
		.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
	const selectedScriptTarget = selectedTargetNode ? scriptTargetPlan(selectedTargetNode) : null;
	const availableScriptTargets = [
		...(selectedScriptTarget ? [selectedScriptTarget] : []),
		...discoveredScriptTargets.filter((target) => target.id !== selectedScriptTarget?.id),
	].slice(0, 512);
	const motionBindings: IUnityAnimatorMotionBindingPlan[] = [];
	for (const binding of document.motionBindings) {
		const matched = matchingEntry(binding, byGuid);
		const nameResult = matched.entry ? await motionName(matched.entry, binding.fileId) : { name: null, diagnostics: [] as string[] };
		const dependency = matched.entry ? sourceEvidence(matched.entry, binding.fileId, nameResult.name) : null;
		let suggestedMatch: string | null = null;
		let resolution: IUnityAnimatorMotionBindingPlan["resolution"] = "unresolved";
		const diagnostics = [...matched.diagnostics, ...nameResult.diagnostics];
		if (dependency) {
			const provenanceMatches = groups.filter((group) => sameUnitySource(group.metadata?.[UNITY_ANIMATION_SOURCE_METADATA_KEY], dependency));
			if (provenanceMatches.length === 1) {
				suggestedMatch = provenanceMatches[0].name;
				resolution = "unity-guid-provenance";
			} else if (provenanceMatches.length > 1) {
				diagnostics.push(`Multiple AnimationGroups claim exact Unity provenance ${dependency.guid}/${dependency.fileId}.`);
			} else if (dependency.name) {
				const exactName = uniqueByName(groups, dependency.name);
				if (exactName) {
					suggestedMatch = exactName.name;
					resolution = "unity-guid-fileid-name";
					diagnostics.push("The exact Unity GUID/fileID supplied the clip name; this live group has no source-provenance marker yet.");
				} else if (groups.some((group) => group.name === dependency.name)) {
					diagnostics.push(`Multiple AnimationGroups are named "${dependency.name}"; automatic binding requires one.`);
				}
			}
		}
		if (!suggestedMatch) {
			const legacy = uniqueByName(groups, binding.suggestedAnimationGroup);
			if (legacy) {
				suggestedMatch = legacy.name;
				resolution = "legacy-suggested-name";
				diagnostics.push("Compatibility fallback matched the controller state-derived name without Unity dependency provenance.");
			}
		}
		motionBindings.push({ ...binding, suggestedMatch, resolution, dependency, diagnostics });
	}
	const avatarMaskBindings: IUnityAnimatorAvatarMaskBindingPlan[] = [];
	for (const binding of document.avatarMaskBindings) {
		const matched = matchingEntry(binding, byGuid);
		let dependency: IUnityAnimatorDependencySource | null = null;
		let parsedMask: ReturnType<typeof parseUnityAvatarMaskAsset> | null = null;
		const diagnostics = [...matched.diagnostics];
		if (matched.entry) {
			if (matched.entry.assetExtension !== ".mask") {
				diagnostics.push(`Unity AvatarMask GUID resolves to unsupported asset ${matched.entry.assetPath}; expected .mask.`);
			} else {
				try {
					parsedMask = parseUnityAvatarMaskAsset(await readBoundedText(absoluteProjectPath(matched.entry.assetPath), 8 * 1024 * 1024));
					if (parsedMask.fileId !== binding.fileId) {
						diagnostics.push(`Unity AvatarMask ${matched.entry.assetPath} has fileID ${parsedMask.fileId}, not referenced ${binding.fileId}.`);
						parsedMask = null;
					} else {
						dependency = sourceEvidence(matched.entry, binding.fileId, parsedMask.name);
					}
				} catch (error) {
					diagnostics.push(`Unity AvatarMask ${matched.entry.assetPath} could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		let suggestedMatch: string | null = null;
		let resolution: IUnityAnimatorAvatarMaskBindingPlan["resolution"] = "unresolved";
		let autoImport: IUnityAnimatorAvatarMaskBindingPlan["autoImport"] = null;
		if (dependency && parsedMask) {
			const provenanceMatches = masks.filter((mask) => sameUnitySource(mask.unitySource, dependency));
			if (provenanceMatches.length === 1) {
				suggestedMatch = provenanceMatches[0].id;
				resolution = "unity-guid-provenance";
			} else if (provenanceMatches.length > 1) {
				diagnostics.push(`Multiple Avatar Masks claim exact Unity provenance ${dependency.guid}/${dependency.fileId}.`);
			} else {
				const byName = uniqueByName(masks, parsedMask.name);
				if (byName) {
					suggestedMatch = byName.id;
					resolution = "unity-guid-mask-name";
					diagnostics.push("The exact Unity GUID/fileID supplied the mask name; this scene mask has no source-provenance marker yet.");
				} else if (avatars.length === 1) {
					const avatar = avatars[0];
					const maskId = automaticMaskId(dependency.guid, dependency.fileId, avatar.id);
					if (masks.some((mask) => mask.id === maskId)) {
						diagnostics.push(`Automatic Unity AvatarMask id "${maskId}" conflicts with an existing mask that has different provenance.`);
					} else {
						suggestedMatch = maskId;
						resolution = "unity-guid-auto-import";
						autoImport = {
							maskId,
							avatarId: avatar.id,
							avatarName: avatar.name,
							name: parsedMask.name,
							bodyParts: parsedMask.bodyParts,
							transformNames: parsedMask.transformNames,
							disabledTransformNames: parsedMask.disabledTransformNames,
							ignoredIkBodyParts: parsedMask.ignoredIkBodyParts,
						};
						diagnostics.push(`The exact Unity mask will be imported for the only humanoid Avatar, "${avatar.name}".`);
					}
				} else if (avatars.length === 0) {
					diagnostics.push("Automatic Unity AvatarMask import requires a humanoid Avatar in the scene.");
				} else {
					diagnostics.push("Automatic Unity AvatarMask import is ambiguous because the scene has multiple humanoid Avatars.");
				}
			}
		}
		if (!suggestedMatch) {
			const legacy = uniqueByName(masks, binding.suggestedAvatarMask);
			if (legacy) {
				suggestedMatch = legacy.id;
				resolution = "legacy-suggested-name";
				diagnostics.push("Compatibility fallback matched the controller layer-derived name without Unity dependency provenance.");
			}
		}
		avatarMaskBindings.push({ ...binding, suggestedMatch, resolution, dependency, autoImport, diagnostics });
	}
	const behaviourBindings: IUnityAnimatorBehaviourBindingPlan[] = [];
	for (const binding of document.behaviourBindings ?? []) {
		const matched = binding.scriptGuid
			? matchingEntry({ guid: binding.scriptGuid }, byGuid)
			: { entry: null, diagnostics: ["The Unity MonoBehaviour has no exact MonoScript GUID and requires an explicit attached-script binding."] };
		const dependency = matched.entry ? sourceEvidence(matched.entry, binding.scriptFileId ?? "11500000", binding.scriptClassHint || null) : null;
		const diagnostics = [...binding.diagnostics, ...matched.diagnostics];
		let suggestedMatch: string | null = null;
		let resolution: IUnityAnimatorBehaviourBindingPlan["resolution"] = "unresolved";
		if (!selectedScriptTarget) {
			diagnostics.push("Select one Animator target node before binding Unity behaviours to attached project scripts.");
		} else if (!selectedScriptTarget.attachedScriptKeys.length) {
			diagnostics.push(`Animator target "${selectedScriptTarget.name}" has no attached project scripts.`);
		}
		if (matched.entry && dependency && selectedScriptTarget) {
			const supportedProjectScript = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(matched.entry.assetExtension);
			const sourceKey = matched.entry.assetPath.startsWith("src/") ? matched.entry.assetPath.slice("src/".length) : null;
			const candidates = new Set([matched.entry.assetPath, ...(sourceKey ? [sourceKey] : [])]);
			const attachedMatches = selectedScriptTarget.attachedScriptKeys.filter((key) => candidates.has(key));
			if (!supportedProjectScript) {
				diagnostics.push(
					`Exact Unity MonoScript GUID resolves to ${matched.entry.assetPath}; ${matched.entry.assetExtension || "extensionless"} files cannot execute as Babylon project scripts.`
				);
			} else if (!sourceKey) {
				diagnostics.push(`Exact Unity MonoScript ${matched.entry.assetPath} is outside src/ and cannot be attached as a project script.`);
			} else if (attachedMatches.length === 1) {
				suggestedMatch = attachedMatches[0];
				resolution = "unity-guid-attached-script";
			} else if (attachedMatches.length > 1) {
				diagnostics.push(`Multiple attachment-key spellings match exact Unity MonoScript ${matched.entry.assetPath}; choose one explicitly.`);
			} else {
				diagnostics.push(`Exact Unity MonoScript ${matched.entry.assetPath} is not attached to target "${selectedScriptTarget.name}".`);
			}
		}
		behaviourBindings.push({ ...binding, suggestedMatch, resolution, dependency, diagnostics });
	}
	const availableAnimationGroups = groups.map((group) => group.name);
	const availableAvatarMasks = masks.map((mask) => ({ id: mask.id, name: mask.name }));
	const availableHumanoidAvatars = avatars.map((avatar) => ({ id: avatar.id, name: avatar.name }));
	const fingerprintState = {
		artifactFingerprint,
		motionBindings,
		avatarMaskBindings,
		behaviourBindings,
		groups: groups.map((group) => ({ name: group.name, source: group.metadata?.[UNITY_ANIMATION_SOURCE_METADATA_KEY] ?? null })),
		masks: masks.map((mask) => ({ id: mask.id, name: mask.name, avatarId: mask.avatarId, unitySource: mask.unitySource ?? null })),
		avatars: availableHumanoidAvatars,
		selectedScriptTarget,
		availableScriptTargets,
	};
	const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintState)).digest("hex");
	return {
		fingerprint,
		artifactFingerprint,
		unityGuidIndexFingerprint: index.fingerprint,
		motionBindings,
		avatarMaskBindings,
		behaviourBindings,
		unresolvedMotionBindings: motionBindings.filter((binding) => !binding.suggestedMatch).map((binding) => binding.key),
		unresolvedAvatarMaskBindings: avatarMaskBindings.filter((binding) => !binding.suggestedMatch).map((binding) => binding.key),
		unresolvedBehaviourBindings: behaviourBindings.filter((binding) => !binding.suggestedMatch).map((binding) => binding.key),
		availableAnimationGroups,
		availableAvatarMasks,
		availableHumanoidAvatars,
		selectedScriptTarget,
		availableScriptTargets,
		guidIndexDiagnostics: { entryCount: index.entries.length, duplicates: index.duplicates, malformed: index.malformed },
	};
}

/** Returns an exact source marker for a Unity clip imported through the Animation File Inspector. */
export async function getUnityAnimationSourceEvidence(path: string, fileId = "7400000"): Promise<IUnityAnimatorDependencySource | null> {
	const root = projectDirectory();
	const projectPath = relative(root, normalize(path)).replace(/\\/g, "/");
	const index = await getUnityAssetGuidIndex();
	const entry = index.entries.find((candidate) => candidate.assetPath === projectPath);
	if (!entry || !entry.assetContentHash) {
		return null;
	}
	const name = (await motionName(entry, fileId)).name;
	return sourceEvidence(entry, fileId, name);
}

export function createImportedUnityAvatarMask(plan: IUnityAnimatorAvatarMaskBindingPlan, avatarId?: string): IHumanoidAvatarMask {
	if (!plan.dependency || !plan.autoImport) {
		throw new Error(`Unity AvatarMask binding "${plan.key}" has no exact importable dependency.`);
	}
	if (avatarId && avatarId !== plan.autoImport.avatarId) {
		throw new Error(`Unity AvatarMask binding "${plan.key}" must be re-inspected for Avatar ${avatarId}.`);
	}
	return {
		version: 1,
		id: plan.autoImport.maskId,
		name: plan.autoImport.name,
		avatarId: plan.autoImport.avatarId,
		bodyParts: plan.autoImport.bodyParts as IHumanoidAvatarMask["bodyParts"],
		transformNames: plan.autoImport.transformNames,
		unitySource: {
			guid: plan.dependency.guid,
			fileId: plan.dependency.fileId,
			path: plan.dependency.path,
			contentHash: plan.dependency.contentHash,
			metaHash: plan.dependency.metaHash,
		},
	};
}
