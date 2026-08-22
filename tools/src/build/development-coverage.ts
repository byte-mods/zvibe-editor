import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

import ts from "typescript";

export type DevelopmentCoveragePointKind = "statement" | "function" | "branch";

export interface IDevelopmentCoveragePoint {
	id: string;
	path: string;
	line: number;
	column: number;
	kind: DevelopmentCoveragePointKind;
	functionName: string | null;
}

export interface IDevelopmentCoverageManifest {
	version: 1;
	backend: "zvibe-development-build-coverage-v1";
	fingerprint: string;
	profileId: string;
	targetPlatform: "darwin" | "win32" | "linux";
	files: number;
	points: IDevelopmentCoveragePoint[];
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

const maximumSourcePoints = 100_000;
const maximumSourceFiles = 1_024;
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

function normalizeSourcePath(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized.startsWith("src/") || normalized.includes("../") || !/\.(?:[cm]?[jt]sx?)$/.test(normalized) || normalized.length > 1_024) {
		throw new Error(`Development coverage paths must be project source files: ${value}`);
	}
	return normalized;
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

function declarationName(node: ts.FunctionLikeDeclarationBase, sourceFile: ts.SourceFile, parentFunctionName: string | null): string | null {
	const ownName = node.name?.getText(sourceFile) ?? (ts.isConstructorDeclaration(node) ? "constructor" : null);
	const parent = node.parent;
	if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) && ts.isClassLike(parent)) {
		return `${parent.name?.getText(sourceFile) ?? "anonymous class"}.${ownName ?? "anonymous"}`;
	}
	if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent))) {
		return parent.name.getText(sourceFile);
	}
	return ownName ?? parentFunctionName;
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

/** Inserts bounded line-preserving source probes used only by explicit desktop development builds. */
export function instrumentDevelopmentCoverageSource(contents: string, projectRelativePath: string): { contents: string; points: IDevelopmentCoveragePoint[] } {
	const path = normalizeSourcePath(projectRelativePath);
	const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, scriptKind);
	const points: IDevelopmentCoveragePoint[] = [];
	const insertions: IInsertion[] = [];
	let sequence = 0;
	const insert = (position: number, text: string, priority = 0): void => {
		insertions.push({ position, text, priority, sequence: sequence++ });
	};
	const addPoint = (kind: DevelopmentCoveragePointKind, node: ts.Node, functionName: string | null): string => {
		const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		const point: IDevelopmentCoveragePoint = {
			id: `${kind}:${location.line + 1}:${location.character + 1}:${points.length}`,
			path,
			line: location.line + 1,
			column: location.character + 1,
			kind,
			functionName,
		};
		points.push(point);
		if (points.length > maximumSourcePoints) {
			throw new Error(`Development coverage supports at most ${maximumSourcePoints} source points.`);
		}
		return `globalThis.__zvibeDevelopmentBuildCoverageProbeV1?.(${JSON.stringify(point.id)})`;
	};
	const visit = (node: ts.Node, parentFunctionName: string | null): void => {
		let functionName = parentFunctionName;
		if (isInstrumentableFunction(node) && node.body) {
			functionName = declarationName(node, sourceFile, parentFunctionName);
			const entry = addPoint("function", node, functionName);
			if (ts.isBlock(node.body)) {
				insert(node.body.getStart(sourceFile) + 1, `${entry};`, -100);
			} else {
				insert(node.body.getStart(sourceFile), `(${entry},`, -100);
				insert(node.body.end, ")", 100);
			}
		}
		if (functionName && ts.isStatement(node) && !ignoredStatements.has(node.kind)) {
			const probe = `${addPoint("statement", node, functionName)};`;
			if (isDirectStatementBody(node)) {
				insert(node.getStart(sourceFile), `{${probe}`, -50);
				insert(node.end, "}", 50);
			} else if (isStatementListEntry(node)) {
				insert(node.getStart(sourceFile), probe, -50);
			}
		}
		if (functionName && ts.isIfStatement(node)) {
			const truthy = addPoint("branch", node.expression, functionName);
			const falsy = addPoint("branch", node.expression, functionName);
			insert(node.expression.getStart(sourceFile), "((", -25);
			insert(node.expression.end, `)?(${truthy},true):(${falsy},false))`, 25);
		}
		if (functionName && ts.isConditionalExpression(node)) {
			const truthy = addPoint("branch", node.whenTrue, functionName);
			const falsy = addPoint("branch", node.whenFalse, functionName);
			insert(node.whenTrue.getStart(sourceFile), `(${truthy},`, -25);
			insert(node.whenTrue.end, ")", 25);
			insert(node.whenFalse.getStart(sourceFile), `(${falsy},`, -25);
			insert(node.whenFalse.end, ")", 25);
		}
		if (functionName && (ts.isCaseClause(node) || ts.isDefaultClause(node)) && node.statements.length) {
			insert(node.statements[0].getStart(sourceFile), `${addPoint("branch", node, functionName)};`, -75);
		}
		node.forEachChild((child) => visit(child, functionName));
	};
	visit(sourceFile, null);
	const grouped = new Map<number, IInsertion[]>();
	for (const insertion of insertions) {
		const group = grouped.get(insertion.position) ?? [];
		group.push(insertion);
		grouped.set(insertion.position, group);
	}
	let transformed = contents;
	for (const position of [...grouped.keys()].sort((left, right) => right - left)) {
		const text = grouped
			.get(position)!
			.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
			.map((entry) => entry.text)
			.join("");
		transformed = `${transformed.slice(0, position)}${text}${transformed.slice(position)}`;
	}
	return { contents: transformed, points };
}

function runtimeBootstrap(manifest: IDevelopmentCoverageManifest): string {
	const serialized = JSON.stringify(manifest).replace(/</g, "\\u003c");
	return `(() => {
	const g = globalThis;
	const m = ${serialized};
	if (g.__zvibeDevelopmentBuildCoverageV1?.manifestFingerprint === m.fingerprint) return;
	const hits = Object.create(null);
	const pointIds = new Set(m.points.map((point) => point.id));
	let revision = 0;
	const increment = (value) => (value < Number.MAX_SAFE_INTEGER ? value + 1 : value);
	const metric = (total, covered) => ({ total, covered, percent: total ? Number(((covered / total) * 100).toFixed(2)) : 100 });
	const snapshot = (options = {}) => {
		const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
		const limit = Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= 10000 ? options.limit : 500;
		const points = options.path == null ? m.points : m.points.filter((point) => point.path === options.path);
		const files = new Map();
		for (const point of points) {
			const entry = files.get(point.path) || { lines: new Map(), statement: [0, 0], function: [0, 0], branch: [0, 0] };
			const pointHits = hits[point.id] || 0;
			entry.lines.set(point.line, (entry.lines.get(point.line) || false) || pointHits > 0);
			entry[point.kind][0]++;
			if (pointHits > 0) entry[point.kind][1]++;
			files.set(point.path, entry);
		}
		const rows = [...files]
			.sort((left, right) => left[0].localeCompare(right[0]))
			.map(([path, entry]) => ({
				path,
				lines: metric(entry.lines.size, [...entry.lines.values()].filter(Boolean).length),
				statements: metric(...entry.statement),
				functions: metric(...entry.function),
				branches: metric(...entry.branch),
				uncoveredLines: [...entry.lines]
					.filter((line) => !line[1])
					.map((line) => line[0])
					.sort((left, right) => left - right)
					.slice(0, 256),
			}));
		const aggregate = (key) => metric(rows.reduce((sum, row) => sum + row[key].total, 0), rows.reduce((sum, row) => sum + row[key].covered, 0));
		return {
			version: 1,
			backend: m.backend,
			manifestFingerprint: m.fingerprint,
			profileId: m.profileId,
			targetPlatform: m.targetPlatform,
			coverageRevision: revision,
			summary: {
				files: metric(rows.length, rows.filter((row) => row.lines.covered > 0).length),
				lines: aggregate("lines"),
				statements: aggregate("statements"),
				functions: aggregate("functions"),
				branches: aggregate("branches"),
			},
			files: rows,
			points: points.slice(offset, offset + limit).map((point) => ({ ...point, hits: hits[point.id] || 0 })),
			pagination: {
				offset,
				limit,
				total: points.length,
				hasMore: offset + limit < points.length,
				nextOffset: offset + limit < points.length ? offset + limit : null,
			},
		};
	};
	g.__zvibeDevelopmentBuildCoverageProbeV1 = (id) => {
		if (pointIds.has(id)) {
			hits[id] = increment(hits[id] || 0);
			revision = increment(revision);
		}
	};
	g.__zvibeDevelopmentBuildCoverageV1 = {
		version: 1,
		manifestFingerprint: m.fingerprint,
		snapshot,
		clear: (expectedRevision) => {
			if (expectedRevision !== revision) throw new Error("Development coverage changed. Read it again before clearing.");
			for (const key of Object.keys(hits)) delete hits[key];
			revision = increment(revision);
			return snapshot();
		},
		export: (format) => {
			const current = snapshot({ limit: 10000 });
			if (format === "json") return JSON.stringify(current, null, 2) + "\\n";
			if (format !== "lcov") throw new Error("Coverage format must be json or lcov.");
			const byPath = new Map();
			for (const point of m.points) {
				const entries = byPath.get(point.path) || [];
				entries.push({ ...point, hits: hits[point.id] || 0 });
				byPath.set(point.path, entries);
			}
			const output = [];
			for (const [path, points] of [...byPath].sort((left, right) => left[0].localeCompare(right[0]))) {
				output.push("SF:" + path);
				const lines = new Map();
				for (const point of points) lines.set(point.line, Math.max(lines.get(point.line) || 0, point.hits));
				const functions = points.filter((point) => point.kind === "function");
				for (let index = 0; index < functions.length; index++) {
					const point = functions[index];
					const name = (point.functionName || "anonymous") + "@" + point.line + ":" + point.column + ":" + index;
					output.push("FN:" + point.line + "," + name, "FNDA:" + point.hits + "," + name);
				}
				output.push("FNF:" + functions.length, "FNH:" + functions.filter((point) => point.hits > 0).length);
				const branches = points.filter((point) => point.kind === "branch");
				for (let index = 0; index < branches.length; index++) {
					const point = branches[index];
					output.push("BRDA:" + point.line + ",0," + index + "," + point.hits);
				}
				output.push("BRF:" + branches.length, "BRH:" + branches.filter((point) => point.hits > 0).length);
				for (const [line, lineHits] of [...lines].sort((left, right) => left[0] - right[0])) output.push("DA:" + line + "," + lineHits);
				output.push("LF:" + lines.size, "LH:" + [...lines.values()].filter(Boolean).length, "end_of_record");
			}
			return output.join("\\n") + "\\n";
		},
	};
	if (typeof addEventListener === "function") {
		addEventListener("pagehide", () => {
			try {
				localStorage.setItem("zvibe-development-build-coverage-v1", JSON.stringify(snapshot({ limit: 10000 })));
			} catch {}
		});
	}
})();
`;
}

export interface IDevelopmentCoveragePluginOptions {
	profileId?: string;
	targetPlatform?: "darwin" | "win32" | "linux";
	manifestPath?: string;
}

/** Vite-compatible plugin used by generated Electron projects; it is inert unless BJS_EDITOR_CODE_COVERAGE=true. */
export function createDevelopmentBuildCoveragePlugin(options: IDevelopmentCoveragePluginOptions = {}): any {
	const enabled = process.env.BJS_EDITOR_CODE_COVERAGE === "true";
	const profileId = (options.profileId ?? process.env.BJS_EDITOR_BUILD_PROFILE_ID ?? "development").slice(0, 128);
	const targetPlatform = options.targetPlatform ?? (process.env.BJS_EDITOR_ELECTRON_PLATFORM as "darwin" | "win32" | "linux" | undefined) ?? "linux";
	const manifestPath = options.manifestPath ?? process.env.BJS_EDITOR_CODE_COVERAGE_MANIFEST;
	let root = process.cwd();
	const sources = new Map<string, { contents: string; points: IDevelopmentCoveragePoint[] }>();
	let manifest: IDevelopmentCoverageManifest | null = null;
	const makeManifest = (): IDevelopmentCoverageManifest => {
		const ordered = [...sources.entries()].sort(([left], [right]) => left.localeCompare(right));
		const points = ordered.flatMap(([, source]) => source.points);
		const fingerprint = createHash("sha256")
			.update(JSON.stringify(ordered.map(([path, source]) => ({ path, contents: source.contents, points: source.points }))))
			.digest("hex");
		return { version: 1, backend: "zvibe-development-build-coverage-v1", fingerprint, profileId, targetPlatform, files: ordered.length, points };
	};
	return {
		name: "zvibe-development-build-coverage",
		apply: "build",
		enforce: "pre",
		configResolved(configuration: { root?: string }): void {
			root = configuration.root ?? root;
		},
		transform(code: string, id: string): { code: string; map: null } | null {
			if (!enabled) {
				return null;
			}
			const absolutePath = id.split("?", 1)[0];
			const projectPath = relative(root, absolutePath).replace(/\\/g, "/");
			if (!projectPath.startsWith("src/") || projectPath.includes("../") || !/\.(?:[cm]?[jt]sx?)$/.test(projectPath) || projectPath.endsWith(".d.ts")) {
				return null;
			}
			if (!sources.has(projectPath) && sources.size >= maximumSourceFiles) {
				throw new Error(`Development coverage supports at most ${maximumSourceFiles} source files.`);
			}
			const instrumented = instrumentDevelopmentCoverageSource(code, projectPath);
			sources.set(projectPath, instrumented);
			return { code: instrumented.contents, map: null };
		},
		generateBundle(this: { emitFile: (asset: { type: "asset"; fileName: string; source: string }) => void }, _output: unknown, bundle: Record<string, any>): void {
			if (!enabled) {
				return;
			}
			manifest = makeManifest();
			const bootstrap = runtimeBootstrap(manifest);
			for (const artifact of Object.values(bundle)) {
				if (artifact?.type === "chunk" && artifact.isEntry) {
					artifact.code = `${bootstrap}${artifact.code}`;
				}
			}
			this.emitFile({ type: "asset", fileName: "zvibe-code-coverage-manifest.json", source: `${JSON.stringify(manifest, null, "\t")}\n` });
		},
		async closeBundle(): Promise<void> {
			if (!enabled || !manifestPath || !manifest) {
				return;
			}
			if (!isAbsolute(manifestPath)) {
				throw new Error("BJS_EDITOR_CODE_COVERAGE_MANIFEST must be an absolute editor-provided path.");
			}
			await mkdir(dirname(manifestPath), { recursive: true });
			const temporary = `${manifestPath}.tmp-${process.pid}`;
			try {
				await writeFile(temporary, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
				await rename(temporary, manifestPath);
			} finally {
				await rm(temporary, { force: true });
			}
		},
	};
}
