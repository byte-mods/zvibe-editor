import { describe, expect, test } from "vitest";

import {
	createAddressableTypeTreeRegistry,
	decodeAddressableTypeTreeValue,
	encodeAddressableTypeTreeValue,
	extractAddressableTypeTreeSchema,
	validateAddressableTypeTreeRegistry,
	validateAddressableTypeTreeSchema,
} from "../../src/loading/addressable-type-trees";

describe("loading/addressable-type-trees", () => {
	test("extracts stable shared schemas and round-trips compact object and union-array payloads", async () => {
		const left = {
			actors: [
				{ displayName: "Hero", healthPoints: 100 },
				{ displayName: "Guide", healthPoints: 80 },
			],
			enabled: true,
		};
		const right = { enabled: false, actors: [{ healthPoints: 25, displayName: "Enemy" }, "marker", null] };
		const leftSchema = await extractAddressableTypeTreeSchema(left);
		const reorderedSchema = await extractAddressableTypeTreeSchema({ enabled: false, actors: [{ healthPoints: 1, displayName: "Other" }] });
		expect(reorderedSchema.id).toBe(leftSchema.id);
		const encoded = encodeAddressableTypeTreeValue(left, leftSchema);
		expect(decodeAddressableTypeTreeValue(encoded, leftSchema)).toEqual(left);
		expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(left).length);

		const rightSchema = await extractAddressableTypeTreeSchema(right);
		const rightEncoded = encodeAddressableTypeTreeValue(right, rightSchema);
		expect(decodeAddressableTypeTreeValue(rightEncoded, rightSchema)).toEqual(right);
		const registry = await createAddressableTypeTreeRegistry([rightSchema, leftSchema, leftSchema]);
		expect(registry.schemas).toHaveLength(2);
		expect(await validateAddressableTypeTreeRegistry(registry)).toEqual(new Map(registry.schemas.map((schema) => [schema.id, schema])));
	});

	test("rejects non-JSON values, cycles, shape drift, malformed unions, and tampered hashes", async () => {
		await expect(extractAddressableTypeTreeSchema({ value: Number.NaN })).rejects.toThrow(/finite/);
		await expect(extractAddressableTypeTreeSchema({ value: undefined })).rejects.toThrow(/undefined/);
		await expect(extractAddressableTypeTreeSchema(new Date())).rejects.toThrow(/plain JSON/);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		await expect(extractAddressableTypeTreeSchema(cycle)).rejects.toThrow(/circular/);

		const schema = await extractAddressableTypeTreeSchema({ items: [1, "two"] });
		expect(() => encodeAddressableTypeTreeValue({ items: [true] }, schema)).toThrow(/variant/);
		const encoded = encodeAddressableTypeTreeValue({ items: [1, "two"] }, schema) as any[];
		(encoded[0] as any[])[0] = [99, 1];
		expect(() => decodeAddressableTypeTreeValue(encoded, schema)).toThrow(/variant index/);

		const tampered = structuredClone(schema);
		tampered.root = { kind: "string" };
		await expect(validateAddressableTypeTreeSchema(tampered)).rejects.toThrow(/measurements|does not match/);
		const registry = await createAddressableTypeTreeRegistry([schema]);
		registry.id = `zvttr-${"0".repeat(64)}`;
		await expect(validateAddressableTypeTreeRegistry(registry)).rejects.toThrow(/does not match/);
	});
});
