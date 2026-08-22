import { describe, expect, test } from "vitest";

import {
	createAddressablePortableBundle,
	parseAddressablePortableBundle,
	serializeAddressablePortableBundle,
	validateAddressablePortableBundle,
} from "../../src/loading/addressable-portable-bundles";
import { createAddressableTypeTreeRegistry, extractAddressableTypeTreeSchema, validateAddressableTypeTreeRegistry } from "../../src/loading/addressable-type-trees";

describe("loading/addressable-portable-bundles", () => {
	test("shares schemas while reconstructing content-addressed bundle entries", async () => {
		const hero = { displayName: "Hero", healthPoints: 100, inventoryCapacity: 20 };
		const enemy = { inventoryCapacity: 5, healthPoints: 35, displayName: "Enemy" };
		const [heroSchema, enemySchema] = await Promise.all([extractAddressableTypeTreeSchema(hero), extractAddressableTypeTreeSchema(enemy)]);
		expect(enemySchema.id).toBe(heroSchema.id);
		const registry = await createAddressableTypeTreeRegistry([heroSchema, enemySchema]);
		const bundle = await createAddressablePortableBundle([
			{ address: "characters/hero", value: hero, schema: heroSchema },
			{ address: "characters/enemy", value: enemy, schema: enemySchema },
		]);
		const bytes = serializeAddressablePortableBundle(bundle);
		const parsed = await parseAddressablePortableBundle(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
			await validateAddressableTypeTreeRegistry(registry)
		);
		expect(parsed.bundle.id).toBe(bundle.id);
		expect(JSON.parse(new TextDecoder().decode(parsed.entries.get("characters/hero")!.bytes))).toEqual(hero);
		expect(JSON.parse(new TextDecoder().decode(parsed.entries.get("characters/enemy")!.bytes))).toEqual(enemy);
	});

	test("rejects duplicate addresses, missing schemas, malformed bytes, and tampered entries", async () => {
		const value = { longPropertyName: "value" };
		const schema = await extractAddressableTypeTreeSchema(value);
		await expect(
			createAddressablePortableBundle([
				{ address: "same", value, schema },
				{ address: "same", value, schema },
			])
		).rejects.toThrow(/duplicated/);
		const bundle = await createAddressablePortableBundle([{ address: "one", value, schema }]);
		await expect(validateAddressablePortableBundle(bundle, new Map())).rejects.toThrow(/unavailable/);
		await expect(parseAddressablePortableBundle(new TextEncoder().encode("not-json").buffer, new Map())).rejects.toThrow(/UTF-8 JSON/);

		const tampered = structuredClone(bundle);
		tampered.entries[0].payload = ["different"];
		await expect(validateAddressablePortableBundle(tampered, new Map([[schema.id, schema]]))).rejects.toThrow(/id does not match/);
	});
});
