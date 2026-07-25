import { Scene } from "babylonjs";

import { openPrefabBulkOverrides, PrefabBulkOverridesSelector } from "../../editor/layout/inspector/mesh/prefab-bulk-overrides";
import { IMCPActionOptions } from "../action";
import { inspectPrefabInstancesOverrides } from "./prefabs";

/** Validates and opens the same bounded multi-instance Overrides workflow used by the Inspector. */
export async function openPrefabBulkOverridesAction(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const selectorCount = Number(data.targets !== undefined) + Number(data.path !== undefined) + Number(data.all === true);
	if (selectorCount !== 1) {
		throw new Error("Supply exactly one bulk selector: targets, path, or all=true.");
	}
	const selector: PrefabBulkOverridesSelector = data.targets !== undefined ? { targets: data.targets } : data.path !== undefined ? { path: data.path } : { all: true };
	const inspection = await inspectPrefabInstancesOverrides(scene, { ...selector, offset: 0, limit: 1 });
	openPrefabBulkOverrides(options.editor, selector);
	return {
		opened: true,
		targetCount: inspection.targetCount,
		totalOverrideCount: inspection.total,
		batchFingerprint: inspection.batchFingerprint,
		selector,
	};
}
