import assert from "node:assert/strict";
import test from "node:test";

import { registerFbxExportTools } from "../build/src/tools/fbx-export.mjs";

function registeredTools() {
	const tools = new Map();
	registerFbxExportTools({
		registerTool(name, configuration, handler) {
			tools.set(name, { configuration, handler });
		},
	});
	return tools;
}

const names = ["get_fbx_export_capabilities", "inspect_fbx_export", "export_fbx_asset", "round_trip_fbx_export"];

test("registers the complete closed and annotated FBX export tool family", () => {
	const tools = registeredTools();
	assert.deepEqual([...tools.keys()], names);
	for (const name of names) {
		const { configuration } = tools.get(name);
		assert.equal(typeof configuration.title, "string");
		assert.ok(configuration.description.length > 100);
		assert.deepEqual(Object.keys(configuration.annotations).sort(), ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
		assert.equal(configuration.annotations.openWorldHint, false);
		assert.equal(configuration.inputSchema.safeParse({ unknown: true }).success, false);
	}
	assert.deepEqual(tools.get("get_fbx_export_capabilities").configuration.annotations, {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	});
	assert.equal(tools.get("export_fbx_asset").configuration.annotations.idempotentHint, true);
	assert.equal(tools.get("round_trip_fbx_export").configuration.annotations.idempotentHint, false);
});

test("accepts exact bounded scene/selection plans and rejects unsafe or contradictory requests before editor contact", () => {
	const tools = registeredTools();
	const schema = (name) => tools.get(name).configuration.inputSchema;
	const hash = "a".repeat(64);

	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/models/scene.fbx" }).success, true);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/models/hero.FBX", rootNodeIds: ["hero"], includeDescendants: false, nodeLimit: 500 }).success, true);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "../scene.fbx" }).success, false);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/../scene.fbx" }).success, false);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/scene.glb" }).success, false);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/scene.fbx", rootNodeIds: [] }).success, false);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/scene.fbx", rootNodeIds: ["hero", "hero"] }).success, false);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/scene.fbx", nodeLimit: 501 }).success, false);

	assert.equal(
		schema("inspect_fbx_export").safeParse({ path: "assets/scene.fbx", settings: { axisForward: "-Z", axisUp: "Y", includeMaterials: false, embedTextures: false } }).success,
		true
	);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/scene.fbx", settings: { axisForward: "Y" } }).success, false);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/scene.fbx", settings: { includeMaterials: false } }).success, false);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/scene.fbx", settings: { globalScale: 0 } }).success, false);
	assert.equal(schema("inspect_fbx_export").safeParse({ path: "assets/scene.fbx", settings: { includeLights: "false" } }).success, false);

	assert.equal(schema("export_fbx_asset").safeParse({ path: "assets/scene.fbx", expectedFingerprint: hash, confirm: true }).success, true);
	assert.equal(schema("export_fbx_asset").safeParse({ path: "assets/scene.fbx", expectedFingerprint: hash, confirm: false }).success, false);
	assert.equal(schema("export_fbx_asset").safeParse({ path: "assets/scene.fbx", expectedFingerprint: "A".repeat(64), confirm: true }).success, false);

	assert.equal(schema("round_trip_fbx_export").safeParse({ path: "assets/scene.fbx", expectedFingerprint: hash, confirm: true, position: [1, 2, 3] }).success, true);
	assert.equal(
		schema("round_trip_fbx_export").safeParse({ path: "assets/scene.fbx", expectedFingerprint: hash, confirm: true, parentId: "root", parentName: "Root" }).success,
		false
	);
	assert.equal(schema("round_trip_fbx_export").safeParse({ path: "assets/scene.fbx", expectedFingerprint: hash, confirm: true, position: [1, 2] }).success, false);
});
