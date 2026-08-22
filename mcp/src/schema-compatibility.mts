import { z } from "zod";

type JsonSchema = Record<string, unknown>;

const projectedSchemas = new WeakSet<object>();

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueSchemas(schemas: JsonSchema[]): JsonSchema[] {
	const unique = new Map<string, JsonSchema>();
	for (const schema of schemas) {
		unique.set(JSON.stringify(schema), schema);
	}
	return [...unique.values()];
}

function compatibleTupleItems(items: JsonSchema[], additionalItems: unknown): JsonSchema {
	const candidates = additionalItems && isObject(additionalItems) ? [...items, additionalItems] : items;
	const unique = uniqueSchemas(candidates);
	return unique.length === 1 ? unique[0] : { anyOf: unique };
}

/**
 * Converts valid draft-7 constructs that current Codex CLI cannot deserialize
 * into equivalent client-facing forms. This only changes schema publication;
 * the original Zod schema remains the runtime source of truth.
 */
export function projectMCPClientCompatibleJsonSchema(value: unknown): unknown {
	if (Array.isArray(value)) {
		value.forEach(projectMCPClientCompatibleJsonSchema);
		return value;
	}
	if (!isObject(value)) {
		return value;
	}

	if (Array.isArray(value.items)) {
		const tupleItems = value.items.filter(isObject);
		tupleItems.forEach(projectMCPClientCompatibleJsonSchema);
		if (isObject(value.additionalItems)) {
			projectMCPClientCompatibleJsonSchema(value.additionalItems);
		}
		value.items = compatibleTupleItems(tupleItems, value.additionalItems);
		value.minItems = tupleItems.length;
		if (value.additionalItems === undefined || value.additionalItems === false) {
			value.maxItems = tupleItems.length;
		}
		delete value.additionalItems;
	}

	if (isObject(value.additionalProperties)) {
		projectMCPClientCompatibleJsonSchema(value.additionalProperties);
		value.additionalProperties = true;
	}

	Object.values(value).forEach(projectMCPClientCompatibleJsonSchema);
	return value;
}

/**
 * Adds a persistent JSON Schema projection to a Zod input schema without
 * changing its parse/refinement behavior. The MCP SDK invokes this hook only
 * while publishing tools/list; normal tools/call validation still evaluates
 * the exact original schema.
 */
export function attachMCPClientCompatibleInputSchema(schema: unknown): void {
	if (!isObject(schema) || projectedSchemas.has(schema) || !isObject(schema._zod)) {
		return;
	}

	const typedSchema = schema as unknown as z.ZodType;
	const internals = schema._zod as { toJSONSchema?: () => unknown };
	const originalProjection = internals.toJSONSchema;
	const projection = (): unknown => {
		internals.toJSONSchema = originalProjection;
		try {
			const jsonSchema = z.toJSONSchema(typedSchema, { target: "draft-7", io: "input" });
			return projectMCPClientCompatibleJsonSchema(jsonSchema);
		} finally {
			internals.toJSONSchema = projection;
		}
	};

	internals.toJSONSchema = projection;
	projectedSchemas.add(schema);
}
