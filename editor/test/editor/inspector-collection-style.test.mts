import { describe, expect, test } from "vitest";

import { getInspectorCollectionStyle, listInspectorCollectionStyles, registerInspectorCollectionStyle } from "../../src/editor/layout/inspector/fields/collection-style";

describe("Inspector collection style mapper", () => {
	test("resolves built-ins and restores extension registrations exactly", () => {
		expect(getInspectorCollectionStyle("number")).toMatchObject({ styleType: "number", icon: "#", accentColor: "#3b82f6", density: "compact" });
		const remove = registerInspectorCollectionStyle("damage", { icon: "DMG", accentColor: "#ff0000", variant: "cards", showIndices: false });
		expect(getInspectorCollectionStyle("number", "damage", { striped: true })).toMatchObject({
			styleType: "damage",
			icon: "DMG",
			accentColor: "#ff0000",
			variant: "cards",
			showIndices: false,
			striped: true,
		});
		expect(listInspectorCollectionStyles().some((style) => style.styleType === "damage")).toBe(true);
		remove();
		expect(listInspectorCollectionStyles().some((style) => style.styleType === "damage")).toBe(false);
	});

	test("rejects malformed style identities and colors", () => {
		expect(() => registerInspectorCollectionStyle("", { icon: "x" })).toThrow(/style type/);
		expect(() => registerInspectorCollectionStyle("bad", { accentColor: "red" })).toThrow(/six-digit hex/);
	});
});
