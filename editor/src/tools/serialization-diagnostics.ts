import ts from "typescript";

export type SerializationDiagnosticCategory = "error" | "warning";

export interface ISerializationCompileDiagnostic {
	category: SerializationDiagnosticCategory;
	code: string;
	message: string;
	path: string;
	line: number;
	column: number;
	length: number;
	field: string | null;
	decorator: string | null;
}

const scalarTypes: Record<string, string> = {
	visibleAsBoolean: "boolean",
	visibleAsKeyMap: "number",
	visibleAsNumber: "number",
	visibleAsString: "string",
};

const objectTypes: Record<string, string[]> = {
	visibleAsColor3: ["Color3"],
	visibleAsColor4: ["Color4"],
	visibleAsEntity: ["AnimationGroup", "Camera", "IParticleSystem", "Light", "Node", "ParticleSystem", "Scene", "Sound", "TransformNode"],
	visibleAsTexture: ["BaseTexture", "CubeTexture", "DynamicTexture", "RawTexture", "Texture"],
	visibleAsVector2: ["Vector2"],
	visibleAsVector3: ["Vector3"],
};

const collectionTypes: Record<string, string> = {
	visibleAsArray: "array",
	visibleAsList: "list",
};

const supportedCollectionElements = new Set(["number", "boolean", "string", "vector2", "vector3", "color3", "color4", "entity", "texture", "keymap", "asset"]);
const unsupportedTypeNames = new Set(["any", "unknown", "never", "bigint", "symbol", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Function"]);

function decoratorName(decorator: ts.Decorator): string | null {
	let expression: ts.Expression = decorator.expression;
	if (ts.isCallExpression(expression)) {
		expression = expression.expression;
	}
	if (ts.isIdentifier(expression)) {
		return expression.text;
	}
	if (ts.isPropertyAccessExpression(expression)) {
		return expression.name.text;
	}
	return null;
}

// The source node plus five serialized diagnostic fields are kept explicit so every call site remains reviewable.
// eslint-disable-next-line max-params
function diagnostic(
	sourceFile: ts.SourceFile,
	node: ts.Node,
	category: SerializationDiagnosticCategory,
	code: string,
	message: string,
	field: string | null,
	decorator: string | null
): ISerializationCompileDiagnostic {
	const start = node.getStart(sourceFile);
	const position = sourceFile.getLineAndCharacterOfPosition(start);
	return {
		category,
		code,
		message,
		path: sourceFile.fileName.replace(/\\/g, "/"),
		line: position.line + 1,
		column: position.character + 1,
		length: Math.max(1, node.getWidth(sourceFile)),
		field,
		decorator,
	};
}

function removeNullableType(type: ts.TypeNode): ts.TypeNode[] {
	const candidates = ts.isUnionTypeNode(type) ? type.types : [type];
	return candidates.filter((candidate) => candidate.kind !== ts.SyntaxKind.NullKeyword && candidate.kind !== ts.SyntaxKind.UndefinedKeyword);
}

function simpleTypeName(type: ts.TypeNode): string | null {
	if (type.kind === ts.SyntaxKind.NumberKeyword) {
		return "number";
	}
	if (type.kind === ts.SyntaxKind.BooleanKeyword) {
		return "boolean";
	}
	if (type.kind === ts.SyntaxKind.StringKeyword) {
		return "string";
	}
	if (type.kind === ts.SyntaxKind.AnyKeyword) {
		return "any";
	}
	if (type.kind === ts.SyntaxKind.UnknownKeyword) {
		return "unknown";
	}
	if (type.kind === ts.SyntaxKind.NeverKeyword) {
		return "never";
	}
	if (type.kind === ts.SyntaxKind.BigIntKeyword) {
		return "bigint";
	}
	if (type.kind === ts.SyntaxKind.SymbolKeyword) {
		return "symbol";
	}
	if (ts.isTypeReferenceNode(type)) {
		const text = type.typeName.getText();
		return text.slice(text.lastIndexOf(".") + 1);
	}
	return null;
}

function collectionElementType(type: ts.TypeNode): ts.TypeNode | null {
	if (ts.isArrayTypeNode(type)) {
		return type.elementType;
	}
	if (ts.isTupleTypeNode(type)) {
		return type.elements.length ? type.elements[0] : null;
	}
	if (ts.isTypeReferenceNode(type)) {
		const name = simpleTypeName(type);
		if (["Array", "ReadonlyArray"].includes(name ?? "") && type.typeArguments?.length === 1) {
			return type.typeArguments[0];
		}
	}
	return null;
}

function expectedCollectionTypeName(elementType: string): string[] | null {
	if (elementType === "keymap") {
		return ["number"];
	}
	if (["number", "boolean", "string"].includes(elementType)) {
		return [elementType];
	}
	if (elementType === "vector2") {
		return ["Vector2"];
	}
	if (elementType === "vector3") {
		return ["Vector3"];
	}
	if (elementType === "color3") {
		return ["Color3"];
	}
	if (elementType === "color4") {
		return ["Color4"];
	}
	if (elementType === "texture") {
		return objectTypes.visibleAsTexture;
	}
	return null;
}

function inferredInitializerType(initializer: ts.Expression | undefined): string | null {
	if (!initializer) {
		return null;
	}
	if (initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) {
		return "boolean";
	}
	if (ts.isNumericLiteral(initializer) || (ts.isPrefixUnaryExpression(initializer) && ts.isNumericLiteral(initializer.operand))) {
		return "number";
	}
	if (ts.isStringLiteralLike(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
		return "string";
	}
	if (ts.isArrayLiteralExpression(initializer)) {
		return "array";
	}
	if (ts.isNewExpression(initializer)) {
		return initializer.expression.getText().split(".").pop() ?? null;
	}
	return null;
}

function decoratorCall(decorator: ts.Decorator): ts.CallExpression | null {
	return ts.isCallExpression(decorator.expression) ? decorator.expression : null;
}

function fieldName(node: ts.PropertyDeclaration, sourceFile: ts.SourceFile): string | null {
	return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name) ? node.name.text : node.name.getText(sourceFile).slice(0, 128);
}

/**
 * Performs the portable editor's compile-time checks for fields persisted by `visibleAs*` decorators.
 * This intentionally validates the Babylon/TypeScript contract and does not claim Unity Roslyn analyzer identity.
 */
export function analyzeSerializationSource(source: string, path: string): ISerializationCompileDiagnostic[] {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const diagnostics: ISerializationCompileDiagnostic[] = [];
	const visit = (node: ts.Node): void => {
		if (!ts.isPropertyDeclaration(node)) {
			ts.forEachChild(node, visit);
			return;
		}
		const decorators = (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined) ?? [];
		const serializationDecorators = decorators
			.map((decorator) => ({ decorator, name: decoratorName(decorator) }))
			.filter((entry): entry is { decorator: ts.Decorator; name: string } =>
				Boolean(entry.name && (scalarTypes[entry.name!] || objectTypes[entry.name!] || collectionTypes[entry.name!] || entry.name === "visibleAsAsset"))
			);
		if (!serializationDecorators.length) {
			ts.forEachChild(node, visit);
			return;
		}
		const name = fieldName(node, sourceFile);
		if (serializationDecorators.length > 1) {
			diagnostics.push(
				diagnostic(
					sourceFile,
					node.name,
					"error",
					"SER1001",
					`Serialized field "${name ?? "<computed>"}" has multiple visibleAs* decorators; keep exactly one.`,
					name,
					null
				)
			);
		}
		const selected = serializationDecorators[0];
		const modifiers = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? [];
		if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
			diagnostics.push(diagnostic(sourceFile, node.name, "error", "SER1002", `Serialized field "${name}" cannot be static.`, name, selected.name));
		}
		if (ts.isComputedPropertyName(node.name) || ts.isPrivateIdentifier(node.name)) {
			diagnostics.push(
				diagnostic(sourceFile, node.name, "error", "SER1003", "Serialized fields must use a stable identifier, string, or numeric property name.", name, selected.name)
			);
		}
		const types = node.type ? removeNullableType(node.type) : [];
		if (types.length > 1) {
			diagnostics.push(
				diagnostic(
					sourceFile,
					node.type!,
					"error",
					"SER1004",
					`Serialized field "${name}" cannot use a non-null union; choose one stable serialized representation.`,
					name,
					selected.name
				)
			);
		}
		const declaredType = types[0] ?? null;
		const declaredName = declaredType ? simpleTypeName(declaredType) : inferredInitializerType(node.initializer);
		if (declaredName && unsupportedTypeNames.has(declaredName)) {
			diagnostics.push(
				diagnostic(
					sourceFile,
					node.type ?? node.name,
					"error",
					"SER1005",
					`Serialized field "${name}" uses unsupported type ${declaredName}; use a concrete bounded Inspector type.`,
					name,
					selected.name
				)
			);
		}
		const scalar = scalarTypes[selected.name];
		if (scalar && declaredName && declaredName !== scalar) {
			diagnostics.push(
				diagnostic(
					sourceFile,
					node.type ?? node.initializer ?? node.name,
					"error",
					"SER1006",
					`@${selected.name} requires ${scalar}, but serialized field "${name}" is ${declaredName}.`,
					name,
					selected.name
				)
			);
		}
		const expectedObjects = objectTypes[selected.name];
		if (expectedObjects && declaredName && !expectedObjects.includes(declaredName)) {
			diagnostics.push(
				diagnostic(
					sourceFile,
					node.type ?? node.initializer ?? node.name,
					"error",
					"SER1007",
					`@${selected.name} requires ${expectedObjects.join("/")}, but serialized field "${name}" is ${declaredName}.`,
					name,
					selected.name
				)
			);
		}
		if (collectionTypes[selected.name]) {
			const call = decoratorCall(selected.decorator);
			const elementArgument = call?.arguments[0];
			const elementKind = elementArgument && ts.isStringLiteralLike(elementArgument) ? elementArgument.text : null;
			if (!elementKind || !supportedCollectionElements.has(elementKind)) {
				diagnostics.push(
					diagnostic(
						sourceFile,
						elementArgument ?? selected.decorator,
						"error",
						"SER1008",
						`@${selected.name} requires one literal supported element type.`,
						name,
						selected.name
					)
				);
			}
			const elementType = declaredType ? collectionElementType(declaredType) : null;
			if (declaredType && !elementType) {
				diagnostics.push(diagnostic(sourceFile, declaredType, "error", "SER1009", `@${selected.name} requires an array or ReadonlyArray field.`, name, selected.name));
			} else if (elementKind && elementType) {
				const expected = expectedCollectionTypeName(elementKind);
				const actual = simpleTypeName(elementType);
				if (expected && actual && !expected.includes(actual)) {
					diagnostics.push(
						diagnostic(
							sourceFile,
							elementType,
							"error",
							"SER1010",
							`@${selected.name}("${elementKind}") requires ${expected.join("/")} elements, but serialized field "${name}" contains ${actual}.`,
							name,
							selected.name
						)
					);
				}
			}
		}
		if (!node.type && !node.initializer) {
			diagnostics.push(
				diagnostic(
					sourceFile,
					node.name,
					"warning",
					"SER1011",
					`Serialized field "${name}" has neither an explicit type nor an initializer; declare its stable serialized type.`,
					name,
					selected.name
				)
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return diagnostics;
}

export function formatSerializationDiagnostic(value: ISerializationCompileDiagnostic): string {
	return `${value.path}:${value.line}:${value.column} ${value.code} ${value.message}`;
}
