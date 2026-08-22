import { describe, expect, test } from "vitest";

import { evaluateVisualScriptExpression, validateVisualScriptExpression } from "../../src/loading/visual-scripting-expression";

describe("loading/visual-scripting-expression", () => {
	test("evaluates bounded arithmetic, functions, comparisons, and conditional inputs", () => {
		expect(evaluateVisualScriptExpression("clamp(speed * delta + bonus, 0, 10)", { speed: 4, delta: 2, bonus: 3 })).toBe(10);
		expect(evaluateVisualScriptExpression("ready && score >= 5 ? pow(score, 2) : 0", { ready: true, score: 6 })).toBe(36);
		expect(evaluateVisualScriptExpression("2 ^ 3 ^ 2", {})).toBe(512);
		expect(evaluateVisualScriptExpression("true ? 4 : 1 / 0", {})).toBe(4);
		expect(evaluateVisualScriptExpression("false && 1 / 0 > 2", {})).toBe(false);
		expect(() => validateVisualScriptExpression("1 / divisor", ["divisor"])).not.toThrow();
	});

	test("rejects undeclared inputs, host-language access, invalid arithmetic, and excessive source", () => {
		expect(() => validateVisualScriptExpression("missing + 1", [])).toThrow("not declared");
		expect(() => evaluateVisualScriptExpression("globalThis.process", {})).toThrow("unsupported character");
		expect(() => evaluateVisualScriptExpression("1 / 0", {})).toThrow("divided by zero");
		expect(() => evaluateVisualScriptExpression("1 % 0", {})).toThrow("modulo by zero");
		expect(() => evaluateVisualScriptExpression("10 ^ 1000", {})).toThrow("non-finite");
		expect(() => evaluateVisualScriptExpression("clamp(1, 2)", {})).toThrow("requires 3");
		expect(() => evaluateVisualScriptExpression("1".repeat(2_049), {})).toThrow("1 through 2048");
	});
});
