import assert from "node:assert/strict";
import test from "node:test";

import { getManifestDrift, normalizeTools, replaceManifestTools } from "./sync-manifest-tools.mjs";

test("normalizes a complete unique tool catalog", () => {
	assert.deepEqual(normalizeTools([{ name: "get_state", description: "Read state.", inputSchema: {} }]), [{ name: "get_state", description: "Read state." }]);
	assert.throws(
		() =>
			normalizeTools([
				{ name: "same", description: "A" },
				{ name: "same", description: "B" },
			]),
		/Duplicate MCP tools/
	);
	assert.throws(() => normalizeTools([{ name: "missing_description" }]), /non-empty names and descriptions/);
});

test("reports generated, missing, extra, and changed metadata independently", () => {
	const drift = getManifestDrift(
		{
			tools_generated: false,
			tools: [
				{ name: "changed", description: "old" },
				{ name: "extra", description: "extra" },
				{ name: "extra", description: "extra" },
			],
		},
		[
			{ name: "changed", description: "new" },
			{ name: "missing", description: "missing" },
		]
	);
	assert.deepEqual(drift, { generated: false, duplicates: ["extra"], missing: ["missing"], extra: ["extra"], changed: ["changed"] });
});

test("replaces only generated tool metadata with valid escaped JSON", () => {
	const source = '{\n\t"name": "example",\n\t"tools_generated": false,\n\t"tools": [\n\t\t{"name":"old"}\n\t],\n\t"compatibility": {}\n}\n';
	const replaced = replaceManifestTools(source, [{ name: "new", description: 'Line 1\n"Line 2"' }]);
	const parsed = JSON.parse(replaced);
	assert.equal(parsed.tools_generated, true);
	assert.deepEqual(parsed.tools, [{ name: "new", description: 'Line 1\n"Line 2"' }]);
	assert.deepEqual(parsed.compatibility, {});
});
