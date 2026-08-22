import assert from "node:assert/strict";
import test from "node:test";

import { registerAsepriteTools } from "../build/src/tools/aseprite.mjs";

/** Captures registration metadata without opening the editor transport, so schema failures prove pre-forward rejection. */
function registeredTools() {
	const tools = new Map();
	registerAsepriteTools({
		registerTool(name, configuration, handler) {
			tools.set(name, { configuration, handler });
		},
	});
	return tools;
}

const names = [
	"get_aseprite_capabilities",
	"inspect_aseprite_import",
	"apply_aseprite_import",
	"instantiate_aseprite_asset",
	"list_aseprite_instances",
	"get_aseprite_instance",
	"control_aseprite_animation",
	"delete_aseprite_instance",
];

test("registers the complete closed and annotated Aseprite tool family", () => {
	const tools = registeredTools();
	assert.deepEqual([...tools.keys()], names);
	for (const name of names) {
		const { configuration } = tools.get(name);
		assert.equal(typeof configuration.title, "string");
		assert.ok(configuration.description.length > 80);
		assert.deepEqual(Object.keys(configuration.annotations).sort(), ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
		assert.equal(configuration.annotations.openWorldHint, false);
		assert.equal(configuration.inputSchema.safeParse({ unknown: true }).success, false);
	}
});

test("rejects unsafe paths, stale-lease shapes, ambiguous identities, and invalid action combinations before editor contact", () => {
	const tools = registeredTools();
	const schema = (name) => tools.get(name).configuration.inputSchema;

	assert.equal(schema("inspect_aseprite_import").safeParse({ path: "assets/hero.aseprite", frameLimit: 500 }).success, true);
	assert.equal(schema("inspect_aseprite_import").safeParse({ path: "../hero.aseprite" }).success, false);
	assert.equal(schema("inspect_aseprite_import").safeParse({ path: "assets/../hero.aseprite" }).success, false);
	assert.equal(schema("inspect_aseprite_import").safeParse({ path: "assets/hero.png" }).success, false);

	assert.equal(schema("apply_aseprite_import").safeParse({ path: "assets/hero.ase", expectedFingerprint: "a".repeat(64), confirm: true }).success, true);
	assert.equal(schema("apply_aseprite_import").safeParse({ path: "assets/hero.ase", expectedFingerprint: "A".repeat(64), confirm: true }).success, false);
	assert.equal(schema("apply_aseprite_import").safeParse({ path: "assets/hero.ase", expectedFingerprint: "a".repeat(64), confirm: false }).success, false);

	assert.equal(schema("instantiate_aseprite_asset").safeParse({ path: "assets/hero.aseprite", parentId: "root", parentName: "Root" }).success, false);
	assert.equal(schema("instantiate_aseprite_asset").safeParse({ path: "assets/hero.aseprite", speed: 0 }).success, false);
	assert.equal(schema("get_aseprite_instance").safeParse({ id: "hero", managerLimit: 200 }).success, true);
	assert.equal(schema("get_aseprite_instance").safeParse({ id: "hero", name: "Hero" }).success, false);
	assert.equal(schema("get_aseprite_instance").safeParse({}).success, false);

	assert.equal(schema("control_aseprite_animation").safeParse({ id: "hero", expectedRevision: 1, action: "seek", frameCursor: 4, elapsedMs: 10, playing: true }).success, true);
	assert.equal(schema("control_aseprite_animation").safeParse({ id: "hero", expectedRevision: 1, action: "seek" }).success, false);
	assert.equal(schema("control_aseprite_animation").safeParse({ id: "hero", expectedRevision: 1, action: "play", frameCursor: 0 }).success, false);
	assert.equal(schema("control_aseprite_animation").safeParse({ id: "hero", expectedRevision: 1, action: "pause", speed: 2 }).success, false);
	assert.equal(schema("control_aseprite_animation").safeParse({ id: "hero", expectedRevision: 1, action: "stop", restart: true }).success, false);

	assert.equal(schema("delete_aseprite_instance").safeParse({ name: "Hero", confirm: true }).success, true);
	assert.equal(schema("delete_aseprite_instance").safeParse({ name: "Hero", confirm: false }).success, false);
});
