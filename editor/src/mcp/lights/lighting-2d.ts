import { Scene } from "babylonjs";
import { getLighting2DRuntimeEvidence, listLight2DProviderTypes, listShadowShape2DProviderTypes, type ILighting2DProviderType } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

type Lighting2DTarget = "auto" | "edit" | "play";
type Lighting2DProviderKind = "light" | "shadow" | "all";

function requestedTarget(value: unknown): Lighting2DTarget {
	if (value === undefined) {
		return "auto";
	}
	if (value !== "auto" && value !== "edit" && value !== "play") {
		throw new Error("target must be auto, edit, or play.");
	}
	return value;
}

function providerKind(value: unknown): Lighting2DProviderKind {
	if (value === undefined) {
		return "all";
	}
	if (value !== "light" && value !== "shadow" && value !== "all") {
		throw new Error("kind must be light, shadow, or all.");
	}
	return value;
}

function resolveTarget(scene: Scene, value: unknown, options: IMCPActionOptions): { target: "edit" | "play"; scene: Scene; play: any | null } {
	const target = requestedTarget(value);
	const play = options.editor.layout.preview?.play;
	const playReady = Boolean(play?.canPlayScene && play.scene && !play.scene.isDisposed);
	if (target === "play" && !playReady) {
		throw new Error("The compiled Play scene is not ready. Start Play mode and retry with target: play.");
	}
	if (target === "play" || (target === "auto" && playReady)) {
		return { target: "play", scene: play.scene!, play };
	}
	return { target: "edit", scene, play: null };
}

function paginate<T>(values: T[], cursorValue: unknown, limitValue: unknown): { items: T[]; nextCursor: string | null; total: number } {
	const cursor = cursorValue === undefined ? 0 : Number(cursorValue);
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new Error("cursor must be a non-negative integer string.");
	}
	const limit = limitValue === undefined ? 50 : Number(limitValue);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("limit must be an integer from 1 through 100.");
	}
	const items = values.slice(cursor, cursor + limit);
	return { items, nextCursor: cursor + items.length < values.length ? String(cursor + items.length) : null, total: values.length };
}

/** Lists built-in and project-registered Light2D/ShadowShape2D providers from the requested module instance. */
export function listLighting2DProviderTypes(scene: Scene, data: any, options: IMCPActionOptions): Record<string, unknown> {
	const resolved = resolveTarget(scene, data.target, options);
	const kind = providerKind(data.kind);
	const lightProviders: ILighting2DProviderType[] = kind === "shadow" ? [] : resolved.play ? resolved.play.listCompiledLight2DProviderTypes() : listLight2DProviderTypes();
	const shadowProviders: ILighting2DProviderType[] =
		kind === "light" ? [] : resolved.play ? resolved.play.listCompiledShadowShape2DProviderTypes() : listShadowShape2DProviderTypes();
	const rows = [
		...lightProviders.map((provider) => ({ kind: "light" as const, ...provider })),
		...shadowProviders.map((provider) => ({ kind: "shadow" as const, ...provider })),
	].sort((left, right) => left.kind.localeCompare(right.kind) || left.menuPriority - right.menuPriority || left.id.localeCompare(right.id));
	const page = paginate(rows, data.cursor, data.limit);
	return {
		target: resolved.target,
		kind,
		providers: page.items,
		total: page.total,
		nextCursor: page.nextCursor,
		registryScope: resolved.target === "play" ? "compiled-game-script-bundle" : "editor-tools-module",
	};
}

/** Returns measured provider lifecycle and render-consumer evidence for Edit or the exact compiled Play scene. */
export function getLighting2DRuntime(scene: Scene, data: any, options: IMCPActionOptions): Record<string, unknown> {
	const resolved = resolveTarget(scene, data.target, options);
	const evidence = resolved.play ? resolved.play.getCompiledLighting2DRuntimeEvidence(resolved.scene) : getLighting2DRuntimeEvidence(resolved.scene as any);
	return {
		target: resolved.target,
		registryScope: resolved.target === "play" ? "compiled-game-script-bundle" : "editor-tools-module",
		...evidence,
	};
}
