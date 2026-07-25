import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { actionablePrefabOverrideIds, PrefabOverridesPresentation, updatePrefabOverrideSelection } from "../../src/editor/layout/inspector/mesh/prefab-overrides";
import {
	actionablePrefabBulkOverrideKeys,
	PrefabBulkOverridesPresentation,
	prefabBulkOverrideSelectionKey,
	updatePrefabBulkOverrideSelection,
} from "../../src/editor/layout/inspector/mesh/prefab-bulk-overrides";
import { IPrefabBulkOverrideEntry, IPrefabBulkOverrideTarget, IPrefabInstanceOverrideEntry, PrefabInstanceOverrideCategory } from "../../src/mcp/prefabs/prefabs";
import { findPrefabFieldOverrideEntry, PrefabFieldOverrideActions } from "../../src/editor/layout/inspector/prefab-property-overrides";
import { PrefabConflictComparisonPresentation } from "../../src/editor/layout/assets-browser/viewers/prefab-conflict-comparison";

function override(category: PrefabInstanceOverrideCategory, kind: string, sourceNodeName: string, currentValue: unknown, sourceValue: unknown): IPrefabInstanceOverrideEntry {
	return {
		id: `${category}-${kind}-${sourceNodeName}`,
		category,
		kind,
		nodeId: `live-${sourceNodeName}`,
		nodeName: sourceNodeName,
		sourceNodeName,
		label: `${sourceNodeName} · ${kind}`,
		currentExists: true,
		sourceExists: true,
		currentValue,
		sourceValue,
		canApply: true,
		canRevert: true,
		blockedReason: null,
	};
}

function bulkItem(targetId: string, entry: IPrefabInstanceOverrideEntry): IPrefabBulkOverrideEntry {
	return { targetId, rootNodeId: `root-${targetId}`, rootNodeName: `Instance ${targetId}`, targetPath: `${targetId}.prefab`, targetIndex: 0, entry };
}

function bulkTarget(targetId: string): IPrefabBulkOverrideTarget {
	return {
		targetId,
		nodeId: `root-${targetId}`,
		nodeName: `Instance ${targetId}`,
		instanceId: `instance-${targetId}`,
		rootNodeId: `root-${targetId}`,
		rootNodeName: `Instance ${targetId}`,
		targetPath: `${targetId}.prefab`,
		targetIndex: 0,
		variant: false,
		revision: "a".repeat(64),
		fingerprint: "b".repeat(64),
		stale: false,
		conflictCount: 0,
		blockerCount: 0,
		entryCount: 1,
		counts: { transform: 1, component: 0, structure: 0 },
	};
}

describe("editor/prefab-overrides", () => {
	test("test_prefab_overrides_presentation_groups_values_and_diagnostics", () => {
		const entries = [
			override("transform", "position", "Root", [25, 0, 0], [0, 0, 0]),
			override("component", "gameplay", "Root", { health: 50 }, { health: 100 }),
			{ ...override("structure", "addition", "Socket", { parentNodeName: "Root" }, null), sourceExists: false },
		];
		const markup = renderToStaticMarkup(
			createElement(PrefabOverridesPresentation, {
				entries,
				selectedIds: new Set(entries.map((entry) => entry.id)),
				conflicts: [{ message: "Base node changed." }],
				blockers: [{ message: "Resolve the stale hierarchy." }],
				onToggle: () => undefined,
			})
		);

		expect(markup).toContain("Transform &amp; Visibility");
		expect(markup).toContain("Components");
		expect(markup).toContain("Hierarchy Structure");
		expect(markup).toContain("Instance");
		expect(markup).toContain("Source");
		expect(markup).toContain("[25,0,0]");
		expect(markup).toContain("{&quot;health&quot;:100}");
		expect(markup).toContain("Source conflicts");
		expect(markup).toContain("Base node changed.");
		expect(markup).toContain("Resolve before changing structure");
		expect(markup).toContain("Resolve the stale hierarchy.");
	});

	test("test_prefab_override_selection_toggles_complete_structure_batch_only", () => {
		const transform = override("transform", "position", "Root", [1, 0, 0], [0, 0, 0]);
		const addition = override("structure", "addition", "Socket", {}, null);
		const reparent = override("structure", "reparent", "Child", {}, null);
		const entries = [transform, addition, reparent];

		const structural = updatePrefabOverrideSelection(new Set([transform.id]), addition, entries, true);
		expect([...structural].sort()).toEqual([addition.id, reparent.id, transform.id].sort());
		const cleared = updatePrefabOverrideSelection(structural, reparent, entries, false);
		expect([...cleared]).toEqual([transform.id]);
		expect([...updatePrefabOverrideSelection(cleared, transform, entries, false)]).toEqual([]);
	});

	test("test_prefab_override_bulk_selection_excludes_diagnostic_only_rows", () => {
		const applyOnly = { ...override("transform", "position", "Root", [1, 0, 0], [0, 0, 0]), canRevert: false };
		const revertOnly = { ...override("component", "metadata", "Root", {}, {}), canApply: false };
		const blocked = { ...override("structure", "addition", "Socket", {}, null), canApply: false, canRevert: false, blockedReason: "Stale source." };

		expect([...actionablePrefabOverrideIds([applyOnly, revertOnly, blocked])].sort()).toEqual([applyOnly.id, revertOnly.id].sort());
	});

	test("test_multi_instance_prefab_overrides_group_targets_and_partial_results", () => {
		const first = bulkItem("first", override("transform", "position", "Root", [1, 0, 0], [0, 0, 0]));
		const second = bulkItem("second", override("component", "gameplay", "Root", { health: 50 }, { health: 100 }));
		const markup = renderToStaticMarkup(
			createElement(PrefabBulkOverridesPresentation, {
				targets: [bulkTarget("first"), { ...bulkTarget("second"), variant: true, conflictCount: 1, blockerCount: 2 }],
				entries: [first, second],
				selectedKeys: new Set([prefabBulkOverrideSelectionKey(first), prefabBulkOverrideSelectionKey(second)]),
				results: {
					mode: "bestEffort",
					attempted: 2,
					succeeded: 1,
					failed: 1,
					partial: true,
					results: [
						{ targetId: "first", ok: true },
						{ targetId: "second", ok: false, error: "Stale fingerprint" },
					],
				},
				onToggle: () => undefined,
			})
		);

		expect(markup).toContain("Instance first");
		expect(markup).toContain("Instance second");
		expect(markup).toContain("second.prefab · boundary 0 · variant");
		expect(markup).toContain("Best effort result · 1 succeeded · 1 failed");
		expect(markup).toContain("Stale fingerprint");
		expect(markup).toContain("1 unresolved source conflict(s)");
		expect(markup).toContain("2 structural blocker(s)");
	});

	test("test_multi_instance_structure_selection_is_complete_per_target_only", () => {
		const firstAddition = bulkItem("first", override("structure", "addition", "Socket", {}, null));
		const firstReparent = bulkItem("first", override("structure", "reparent", "Child", {}, null));
		const secondAddition = bulkItem("second", { ...override("structure", "addition", "Socket", {}, null), id: "second-addition" });
		const entries = [firstAddition, firstReparent, secondAddition];

		const selected = updatePrefabBulkOverrideSelection(new Set(), firstAddition, entries, true);
		expect([...selected].sort()).toEqual([prefabBulkOverrideSelectionKey(firstAddition), prefabBulkOverrideSelectionKey(firstReparent)].sort());
		expect(selected.has(prefabBulkOverrideSelectionKey(secondAddition))).toBe(false);
		expect([...actionablePrefabBulkOverrideKeys(entries)]).toHaveLength(3);
		expect(updatePrefabBulkOverrideSelection(selected, firstReparent, entries, false).size).toBe(0);
	});

	test("test_prefab_property_override_actions_expose_apply_and_revert", () => {
		const markup = renderToStaticMarkup(
			createElement(PrefabFieldOverrideActions, {
				entry: override("transform", "name", "Root", "Live Root", "Source Root"),
				busy: false,
				refreshVersion: 1,
				notifyChanged: () => undefined,
				apply: () => undefined,
				revert: () => undefined,
			})
		);
		expect(markup).toContain("Apply");
		expect(markup).toContain("Revert");
	});

	test("test_prefab_property_override_field_mapping_uses_exact_node_and_rotation_proxy", () => {
		const position = override("transform", "position", "Root", [1, 0, 0], [0, 0, 0]);
		const rotation = { ...override("transform", "rotation", "Root", [0, 1, 0], [0, 0, 0]), nodeId: "live-rotation" };
		const snapshot = { entries: [position, rotation] };
		expect(findPrefabFieldOverrideEntry(snapshot, { id: position.nodeId }, "position.x")).toBe(position);
		expect(findPrefabFieldOverrideEntry(snapshot, { id: rotation.nodeId }, "rotationQuaternion.y")).toBe(rotation);
		expect(findPrefabFieldOverrideEntry(snapshot, { id: "different-node" }, "position")).toBeNull();
	});

	test("test_prefab_property_override_field_mapping_resolves_exact_serialized_component", () => {
		const gameplay = { ...override("component", "gameplay", "Root", { health: 50 }, { health: 100 }), nodeId: "live-root" };
		const physics = { ...override("component", "physicsAggregate", "Root", { mass: 2 }, { mass: 1 }), nodeId: "live-root" };
		const snapshot = { entries: [gameplay, physics] };
		const node = { id: "live-root" };

		expect(findPrefabFieldOverrideEntry(snapshot, node, "metadata.gameplay.health")).toBe(gameplay);
		expect(findPrefabFieldOverrideEntry(snapshot, node, "ignored", { category: "component", kind: "physicsAggregate" })).toBe(physics);
		expect(findPrefabFieldOverrideEntry(snapshot, { id: "different-node" }, "metadata.gameplay.health")).toBeNull();
		expect(findPrefabFieldOverrideEntry(snapshot, node, "metadata.prefab.path")).toBeNull();
	});

	test("test_prefab_conflict_comparison_renders_base_variant_and_live_values", () => {
		const markup = renderToStaticMarkup(
			createElement(PrefabConflictComparisonPresentation, {
				conflict: {
					base: { exists: true, value: { health: 100 } },
					variant: { exists: true, value: { health: 250 } },
					resolved: { exists: true, value: { health: 100 } },
					live: { exists: true, value: { health: 175 } },
				},
			})
		);
		expect(markup).toContain("Current Base");
		expect(markup).toContain("Variant Override");
		expect(markup).toContain("Live Instance");
		expect(markup).toContain("250");
		expect(markup).toContain("175");
	});
});
