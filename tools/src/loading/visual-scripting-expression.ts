const maximumExpressionLength = 2_048;
const maximumTokens = 512;
const maximumDepth = 64;

type ExpressionTokenKind = "number" | "identifier" | "operator" | "left" | "right" | "comma" | "question" | "colon" | "eof";

interface IExpressionToken {
	kind: ExpressionTokenKind;
	text: string;
	value?: number;
}

const binaryPrecedence: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "^": 7 };
const functions: Record<string, (...values: number[]) => number> = {
	abs: Math.abs,
	ceil: Math.ceil,
	clamp: (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum),
	cos: Math.cos,
	floor: Math.floor,
	max: Math.max,
	min: Math.min,
	pow: Math.pow,
	round: Math.round,
	sin: Math.sin,
	sqrt: Math.sqrt,
	tan: Math.tan,
};
const functionArities: Record<string, [number, number]> = {
	abs: [1, 1],
	ceil: [1, 1],
	clamp: [3, 3],
	cos: [1, 1],
	floor: [1, 1],
	max: [1, 16],
	min: [1, 16],
	pow: [2, 2],
	round: [1, 1],
	sin: [1, 1],
	sqrt: [1, 1],
	tan: [1, 1],
};

/** Tokenizes only the bounded mathematical grammar; property access and strings are intentionally unsupported. */
function tokenize(source: string): IExpressionToken[] {
	if (!source.trim() || source.length > maximumExpressionLength) {
		throw new Error(`Expression must contain 1 through ${maximumExpressionLength} characters.`);
	}
	const tokens: IExpressionToken[] = [];
	let offset = 0;
	while (offset < source.length) {
		const character = source[offset];
		if (/\s/.test(character)) {
			offset++;
			continue;
		}
		const number = source.slice(offset).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
		if (number) {
			const value = Number(number[0]);
			if (!Number.isFinite(value)) {
				throw new Error(`Expression number at offset ${offset} must be finite.`);
			}
			tokens.push({ kind: "number", text: number[0], value });
			offset += number[0].length;
			continue;
		}
		const identifier = source.slice(offset).match(/^[A-Za-z_][A-Za-z0-9_]*/);
		if (identifier) {
			tokens.push({ kind: "identifier", text: identifier[0] });
			offset += identifier[0].length;
			continue;
		}
		const pair = source.slice(offset, offset + 2);
		if (["&&", "||", "==", "!=", "<=", ">="].includes(pair)) {
			tokens.push({ kind: "operator", text: pair });
			offset += 2;
			continue;
		}
		const kind: ExpressionTokenKind | undefined =
			character === "(" ? "left" : character === ")" ? "right" : character === "," ? "comma" : character === "?" ? "question" : character === ":" ? "colon" : undefined;
		if (kind) {
			tokens.push({ kind, text: character });
			offset++;
			continue;
		}
		if ("+-*/%^!<>".includes(character)) {
			tokens.push({ kind: "operator", text: character });
			offset++;
			continue;
		}
		throw new Error(`Expression contains unsupported character "${character}" at offset ${offset}.`);
	}
	if (tokens.length > maximumTokens) {
		throw new Error(`Expression exceeds the ${maximumTokens}-token limit.`);
	}
	return [...tokens, { kind: "eof", text: "" }];
}

function numberValue(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must resolve to a finite number.`);
	}
	return value;
}

type ExpressionNode =
	| { kind: "literal"; value: unknown }
	| { kind: "input"; name: string }
	| { kind: "unary"; operator: string; value: ExpressionNode }
	| { kind: "binary"; operator: string; left: ExpressionNode; right: ExpressionNode }
	| { kind: "call"; name: string; values: ExpressionNode[] }
	| { kind: "conditional"; condition: ExpressionNode; whenTrue: ExpressionNode; whenFalse: ExpressionNode };

/** Builds a bounded AST first so conditional and boolean branches can be evaluated lazily. */
class ExpressionParser {
	private _offset = 0;
	private _depth = 0;

	public constructor(private readonly _tokens: IExpressionToken[]) {}

	public parse(): ExpressionNode {
		const result = this._parseExpression(0);
		if (this._peek().kind !== "eof") {
			throw new Error(`Unexpected token "${this._peek().text}" in expression.`);
		}
		return result;
	}

	private _parseExpression(minimumPrecedence: number): ExpressionNode {
		if (++this._depth > maximumDepth) {
			throw new Error(`Expression exceeds the ${maximumDepth}-level nesting limit.`);
		}
		let left = this._parsePrefix();
		while (this._peek().kind === "operator" && (binaryPrecedence[this._peek().text] ?? -1) >= minimumPrecedence) {
			const operator = this._take().text;
			const precedence = binaryPrecedence[operator];
			const right = this._parseExpression(precedence + (operator === "^" ? 0 : 1));
			left = { kind: "binary", operator, left, right };
		}
		if (minimumPrecedence === 0 && this._peek().kind === "question") {
			this._take();
			const whenTrue = this._parseExpression(0);
			this._require("colon");
			const whenFalse = this._parseExpression(0);
			left = { kind: "conditional", condition: left, whenTrue, whenFalse };
		}
		this._depth--;
		return left;
	}

	private _parsePrefix(): ExpressionNode {
		const token = this._take();
		if (token.kind === "number") {
			return { kind: "literal", value: token.value };
		}
		if (token.kind === "operator" && ["+", "-", "!"].includes(token.text)) {
			return { kind: "unary", operator: token.text, value: this._parseExpression(8) };
		}
		if (token.kind === "left") {
			const value = this._parseExpression(0);
			this._require("right");
			return value;
		}
		if (token.kind !== "identifier") {
			throw new Error(`Expected a number, input, or function but found "${token.text}".`);
		}
		if (token.text === "true" || token.text === "false" || token.text === "null") {
			return { kind: "literal", value: token.text === "true" ? true : token.text === "false" ? false : null };
		}
		if (this._peek().kind !== "left") {
			return { kind: "input", name: token.text };
		}
		const operation = functions[token.text];
		if (!operation) {
			throw new Error(`Expression function "${token.text}" is not supported.`);
		}
		this._take();
		const values: ExpressionNode[] = [];
		while (this._peek().kind !== "right") {
			values.push(this._parseExpression(0));
			if (this._peek().kind !== "comma") {
				break;
			}
			this._take();
		}
		this._require("right");
		const [minimum, maximum] = functionArities[token.text];
		if (values.length < minimum || values.length > maximum) {
			throw new Error(`Expression function "${token.text}" requires ${minimum === maximum ? minimum : `${minimum} through ${maximum}`} argument(s).`);
		}
		return { kind: "call", name: token.text, values };
	}

	private _peek(): IExpressionToken {
		return this._tokens[this._offset];
	}

	private _take(): IExpressionToken {
		return this._tokens[this._offset++];
	}

	private _require(kind: ExpressionTokenKind): void {
		const token = this._take();
		if (token.kind !== kind) {
			throw new Error(`Expected ${kind} but found "${token.text}".`);
		}
	}
}

function finiteResult(value: number): number {
	if (!Number.isFinite(value)) {
		throw new Error("Expression produced a non-finite result.");
	}
	return value;
}

/** Evaluates only explicit AST nodes; no host object, property, or callable can enter this dispatch. */
function evaluate(node: ExpressionNode, inputs: Readonly<Record<string, unknown>>): unknown {
	switch (node.kind) {
		case "literal":
			return node.value;
		case "input":
			if (!Object.prototype.hasOwnProperty.call(inputs, node.name)) {
				throw new Error(`Expression input "${node.name}" is not declared.`);
			}
			return inputs[node.name];
		case "conditional":
			return evaluate(node.condition, inputs) === true ? evaluate(node.whenTrue, inputs) : evaluate(node.whenFalse, inputs);
		case "unary": {
			const value = evaluate(node.value, inputs);
			return node.operator === "!" ? value !== true : finiteResult(node.operator === "+" ? numberValue(value, "Unary operand") : -numberValue(value, "Unary operand"));
		}
		case "call": {
			const values = node.values.map((value, index) => numberValue(evaluate(value, inputs), `Argument ${index + 1} for ${node.name}`));
			return finiteResult(functions[node.name](...values));
		}
		case "binary": {
			const left = evaluate(node.left, inputs);
			if (node.operator === "&&") {
				return left === true && evaluate(node.right, inputs) === true;
			}
			if (node.operator === "||") {
				return left === true || evaluate(node.right, inputs) === true;
			}
			const right = evaluate(node.right, inputs);
			switch (node.operator) {
				case "+":
					return typeof left === "string" || typeof right === "string"
						? `${left ?? ""}${right ?? ""}`
						: finiteResult(numberValue(left, "Left operand") + numberValue(right, "Right operand"));
				case "-":
					return finiteResult(numberValue(left, "Left operand") - numberValue(right, "Right operand"));
				case "*":
					return finiteResult(numberValue(left, "Left operand") * numberValue(right, "Right operand"));
				case "/":
				case "%": {
					const divisor = numberValue(right, "Right operand");
					if (Math.abs(divisor) < 1e-12) {
						throw new Error(`Expression ${node.operator === "/" ? "divided" : "used modulo"} by zero.`);
					}
					return finiteResult(node.operator === "/" ? numberValue(left, "Left operand") / divisor : numberValue(left, "Left operand") % divisor);
				}
				case "^":
					return finiteResult(Math.pow(numberValue(left, "Left operand"), numberValue(right, "Right operand")));
				case "==":
					return JSON.stringify(left) === JSON.stringify(right);
				case "!=":
					return JSON.stringify(left) !== JSON.stringify(right);
				case "<":
					return numberValue(left, "Left operand") < numberValue(right, "Right operand");
				case "<=":
					return numberValue(left, "Left operand") <= numberValue(right, "Right operand");
				case ">":
					return numberValue(left, "Left operand") > numberValue(right, "Right operand");
				case ">=":
					return numberValue(left, "Left operand") >= numberValue(right, "Right operand");
			}
			throw new Error(`Expression operator "${node.operator}" is not supported.`);
		}
	}
}

/** Runs a deterministic expression against explicit named inputs only. */
export function evaluateVisualScriptExpression(source: string, inputs: Readonly<Record<string, unknown>>): unknown {
	return evaluate(new ExpressionParser(tokenize(source)).parse(), inputs);
}

function collectInputs(node: ExpressionNode, result: Set<string>): void {
	if (node.kind === "input") {
		result.add(node.name);
	} else if (node.kind === "unary") {
		collectInputs(node.value, result);
	} else if (node.kind === "binary") {
		collectInputs(node.left, result);
		collectInputs(node.right, result);
	} else if (node.kind === "call") {
		node.values.forEach((value) => collectInputs(value, result));
	} else if (node.kind === "conditional") {
		collectInputs(node.condition, result);
		collectInputs(node.whenTrue, result);
		collectInputs(node.whenFalse, result);
	}
}

/** Validates syntax and declarations without inventing placeholder values that could trigger arithmetic errors. */
export function validateVisualScriptExpression(source: string, inputNames: readonly string[]): void {
	const used = new Set<string>();
	collectInputs(new ExpressionParser(tokenize(source)).parse(), used);
	for (const name of used) {
		if (!inputNames.includes(name)) {
			throw new Error(`Expression input "${name}" is not declared.`);
		}
	}
}
