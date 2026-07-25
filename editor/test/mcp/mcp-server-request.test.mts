import { describe, expect, test } from "vitest";

import { parseMcpRequestBody } from "../../src/mcp/mcp";

describe("MCP editor bridge request parsing", () => {
	test("accepts a non-empty endpoint and preserves closed request data", () => {
		expect(parseMcpRequestBody('{"endpoint":"get_editor_status","value":4}')).toEqual({ endpoint: "get_editor_status", value: 4 });
	});

	test.each([
		["empty", "", "MCP request body must contain a JSON object."],
		["malformed", "{", "MCP request body must contain valid JSON."],
		["array", "[]", "MCP request body must be a JSON object."],
		["missing endpoint", "{}", "MCP request body requires a non-empty endpoint string."],
		["blank endpoint", '{"endpoint":"   "}', "MCP request body requires a non-empty endpoint string."],
	] as const)("rejects %s input without an uncaught callback exception", (_name, body, message) => {
		expect(() => parseMcpRequestBody(body)).toThrow(message);
	});
});
