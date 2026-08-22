import { describe, expect, test } from "vitest";

import {
	defaultInputSystemSettings,
	normalizeInputActionMap,
	normalizeInputActionMaps,
	normalizeInputSystemSettings,
	validateInputActionMaps,
	validateInputSystemSettings,
} from "../../src/loading/input-actions-model";

describe("input actions model", () => {
	test("migrates legacy string bindings and control schemes to stable version 2 records", () => {
		const map = normalizeInputActionMap({
			id: "player",
			name: "Player",
			actions: [{ name: "Jump", bindings: ["space", "<gamepad>/buttonSouth"] }],
			controlSchemes: [{ name: "Desktop", devices: ["keyboard", "mouse"] }],
		});
		expect(map).toMatchObject({ version: 2, revision: 1, id: "player", enabled: true });
		expect(map.actions[0]).toMatchObject({ type: "button", expectedControlType: "button", enabled: true, initialStateCheck: false });
		expect(map.actions[0].bindings.map((binding) => binding.path)).toEqual(["space", "<gamepad>/buttonSouth"]);
		expect(map.actions[0].bindings.every((binding) => binding.id.startsWith("binding-"))).toBe(true);
		expect(map.controlSchemes[0]).toMatchObject({ name: "Desktop", devices: ["keyboard", "mouse"] });
		expect(() => validateInputActionMaps([map])).not.toThrow();
	});

	test("rejects duplicate names, invalid composites, and unsafe processor ranges", () => {
		const duplicate = normalizeInputActionMap({ id: "map", name: "Player", actions: [{ name: "Move" }, { name: "move" }] });
		expect(() => validateInputActionMaps([duplicate])).toThrow("unique");
		const invalidComposite = normalizeInputActionMap({
			id: "map",
			name: "Player",
			actions: [{ name: "Move", bindings: [{ id: "bad", composite: { type: "vector2", parts: [] } }] }],
		});
		expect(() => validateInputActionMaps([invalidComposite])).toThrow("1 through 8 parts");
		const invalidProcessor = normalizeInputActionMap({
			id: "map",
			name: "Player",
			actions: [{ name: "Move", processors: [{ type: "axisDeadzone", min: 0.9, max: 0.2 }] }],
		});
		expect(() => validateInputActionMaps([invalidProcessor])).toThrow("min less than max");
	});

	test("assigns repeatable ids while migrating persisted legacy map arrays", () => {
		const legacy = [{ name: "Player", actions: [{ name: "Jump", bindings: ["space"] }], controlSchemes: [{ name: "Desktop", devices: ["keyboard"] }] }];
		const first = normalizeInputActionMaps(legacy);
		const second = normalizeInputActionMaps(legacy);
		expect(second).toEqual(first);
		expect(first[0].id).toMatch(/^legacy-map-0-/);
		expect(first[0].actions[0].id).toMatch(/^legacy-action-0-/);
		expect(first[0].actions[0].bindings[0].id).toMatch(/^legacy-binding-0-/);
		expect(first[0].controlSchemes[0].id).toMatch(/^legacy-scheme-0-/);
	});

	test("rejects non-Boolean enable flags and ambiguous duplicate binding data", () => {
		const invalidEnabled = normalizeInputActionMap({ id: "map", name: "Player", enabled: "yes", actions: [] });
		expect(() => validateInputActionMaps([invalidEnabled])).toThrow("Boolean");
		const ambiguous = normalizeInputActionMap({
			id: "map",
			name: "Player",
			actions: [
				{ name: "Move", bindings: [{ id: "bad", path: "<keyboard>/space", composite: { type: "axis1d", parts: [{ name: "Positive", path: "<keyboard>/space" }] } }] },
			],
		});
		expect(() => validateInputActionMaps([ambiguous])).toThrow("exactly one");
	});

	test("normalizes settings and rejects invalid timing and trace budgets", () => {
		expect(normalizeInputSystemSettings({ updateMode: "manual" })).toMatchObject({ ...defaultInputSystemSettings, updateMode: "manual" });
		expect(() => validateInputSystemSettings(normalizeInputSystemSettings({ defaultTapTime: 1, defaultSlowTapTime: 0.5 }))).toThrow("slow-tap");
		expect(() => validateInputSystemSettings(normalizeInputSystemSettings({ maxTraceEvents: 5000 }))).toThrow("16 through 4096");
	});
});
