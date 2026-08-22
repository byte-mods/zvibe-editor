import ts from "typescript";
import { createHash } from "crypto";

import type { IScriptSourcePoint } from "babylonjs-editor-tools";

export interface IInstrumentedScriptSource {
	contents: string;
	points: IScriptSourcePoint[];
}

interface IInsertion {
	position: number;
	priority: number;
	sequence: number;
	text: string;
}

type InstrumentableFunction =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration
	| ts.ConstructorDeclaration;

const ignoredStatements = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.Block,
	ts.SyntaxKind.EmptyStatement,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.ClassDeclaration,
	ts.SyntaxKind.InterfaceDeclaration,
	ts.SyntaxKind.TypeAliasDeclaration,
	ts.SyntaxKind.ModuleDeclaration,
	ts.SyntaxKind.ImportDeclaration,
	ts.SyntaxKind.ImportEqualsDeclaration,
	ts.SyntaxKind.ExportDeclaration,
]);

function declarationName(node: ts.FunctionLikeDeclarationBase, sourceFile: ts.SourceFile, parentFunctionName: string | null): string | null {
	const ownName = node.name?.getText(sourceFile) ?? (ts.isConstructorDeclaration(node) ? "constructor" : null);
	const parent = node.parent;
	if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) && ts.isClassLike(parent)) {
		const className = parent.name?.getText(sourceFile) ?? "anonymous class";
		return `${className}.${ownName ?? "anonymous"}`;
	}
	if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(parent)) {
		return parent.name.getText(sourceFile);
	}
	if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyAssignment(parent)) {
		return parent.name.getText(sourceFile);
	}
	return ownName ?? parentFunctionName ?? null;
}

function isInstrumentableFunction(node: ts.Node): node is InstrumentableFunction {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node)
	);
}

function isDirectStatementBody(node: ts.Statement): boolean {
	const parent = node.parent;
	return (
		(ts.isIfStatement(parent) && (parent.thenStatement === node || parent.elseStatement === node)) ||
		((ts.isForStatement(parent) ||
			ts.isForInStatement(parent) ||
			ts.isForOfStatement(parent) ||
			ts.isWhileStatement(parent) ||
			ts.isDoStatement(parent) ||
			ts.isWithStatement(parent)) &&
			parent.statement === node) ||
		(ts.isLabeledStatement(parent) && parent.statement === node)
	);
}

function isStatementListEntry(node: ts.Statement): boolean {
	const parent = node.parent;
	return ts.isBlock(parent) || ts.isSourceFile(parent) || ((ts.isCaseClause(parent) || ts.isDefaultClause(parent)) && parent.statements.includes(node));
}

/**
 * Inserts line-preserving, expression-safe probes into one project TypeScript source file.
 * The transformed source is used only by Debug Play; ordinary Play and exported builds never call this function.
 */
export function instrumentTypeScriptSource(contents: string, projectRelativePath: string): IInstrumentedScriptSource {
	if (!projectRelativePath.startsWith("src/") || projectRelativePath.includes("../") || !/\.(?:ts|tsx)$/.test(projectRelativePath)) {
		throw new Error(`Instrumented script paths must be project-relative TypeScript files under src/: ${projectRelativePath}`);
	}
	const sourceFile = ts.createSourceFile(
		projectRelativePath,
		contents,
		ts.ScriptTarget.Latest,
		true,
		projectRelativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
	const points: IScriptSourcePoint[] = [];
	const insertions: IInsertion[] = [];
	const pathFingerprint = createHash("sha256").update(projectRelativePath).digest("hex");
	let sequence = 0;

	const insert = (position: number, text: string, priority = 0): void => {
		insertions.push({ position, text, priority, sequence: sequence++ });
	};
	const addPoint = (kind: IScriptSourcePoint["kind"], node: ts.Node, functionName: string | null): { point: IScriptSourcePoint; probe: string } => {
		const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		const point: IScriptSourcePoint = {
			id: `${kind}:${pathFingerprint}:${location.line + 1}:${location.character + 1}:${points.length}`,
			path: projectRelativePath,
			line: location.line + 1,
			column: location.character + 1,
			kind,
			functionName,
		};
		points.push(point);
		return {
			point,
			probe: `(globalThis as any).__zvibeEditorScriptProbeV1?.(${JSON.stringify(point.path)},${JSON.stringify(point.id)},${point.line},${point.column},${JSON.stringify(
				point.kind
			)},${JSON.stringify(point.functionName)})`,
		};
	};

	const visit = (node: ts.Node, parentFunctionName: string | null): void => {
		let functionName = parentFunctionName;
		if (isInstrumentableFunction(node) && node.body) {
			functionName = declarationName(node, sourceFile, parentFunctionName);
			const entry = addPoint("function", node, functionName).probe;
			if (ts.isBlock(node.body)) {
				insert(node.body.getStart(sourceFile) + 1, `${entry};`, -100);
			} else {
				insert(node.body.getStart(sourceFile), `(${entry},`, -100);
				insert(node.body.end, ")", 100);
			}
		}

		if (functionName && ts.isStatement(node) && !ignoredStatements.has(node.kind)) {
			const statementProbe = `${addPoint("statement", node, functionName).probe};`;
			if (isDirectStatementBody(node)) {
				insert(node.getStart(sourceFile), `{${statementProbe}`, -50);
				insert(node.end, "}", 50);
			} else if (isStatementListEntry(node)) {
				insert(node.getStart(sourceFile), statementProbe, -50);
			}
		}

		if (functionName && ts.isIfStatement(node)) {
			const truthy = addPoint("branch", node.expression, functionName).probe;
			const falsy = addPoint("branch", node.expression, functionName).probe;
			insert(node.expression.getStart(sourceFile), "((", -25);
			insert(node.expression.end, `)?(${truthy},true):(${falsy},false))`, 25);
		}

		if (functionName && ts.isConditionalExpression(node)) {
			const truthy = addPoint("branch", node.whenTrue, functionName).probe;
			const falsy = addPoint("branch", node.whenFalse, functionName).probe;
			insert(node.whenTrue.getStart(sourceFile), `(${truthy},`, -25);
			insert(node.whenTrue.end, ")", 25);
			insert(node.whenFalse.getStart(sourceFile), `(${falsy},`, -25);
			insert(node.whenFalse.end, ")", 25);
		}

		if (functionName && (ts.isCaseClause(node) || ts.isDefaultClause(node)) && node.statements.length) {
			const probe = `${addPoint("branch", node, functionName).probe};`;
			insert(node.statements[0].getStart(sourceFile), probe, -75);
		}

		node.forEachChild((child) => visit(child, functionName));
	};
	visit(sourceFile, null);

	const byPosition = new Map<number, IInsertion[]>();
	for (const insertion of insertions) {
		const entries = byPosition.get(insertion.position) ?? [];
		entries.push(insertion);
		byPosition.set(insertion.position, entries);
	}
	const positions = [...byPosition.keys()].sort((left, right) => right - left);
	let transformed = contents;
	for (const position of positions) {
		const text = byPosition
			.get(position)!
			.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
			.map((entry) => entry.text)
			.join("");
		transformed = `${transformed.slice(0, position)}${text}${transformed.slice(position)}`;
	}
	return { contents: transformed, points };
}
