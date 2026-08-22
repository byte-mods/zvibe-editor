import { afterEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, readFile, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import ts from "typescript";

import { projectConfiguration } from "../../src/project/configuration";
import { handleExportScripts } from "../../src/project/export/scripts";
import { compileScript } from "../../src/tools/compile";
import { instrumentTypeScriptSource } from "../../src/tools/script-instrumentation";

describe("tools/script-instrumentation", () => {
	const previousProbe = (globalThis as any).__zvibeEditorScriptProbeV1;

	afterEach(() => {
		(globalThis as any).__zvibeEditorScriptProbeV1 = previousProbe;
	});

	test("preserves source lines and runtime behavior while recording function, statement, and both branch arms", () => {
		const source = `export function choose(primary: boolean, secondary: boolean): number {
	let result = 0;
	if (primary)
		if (secondary) result = 1;
		else result = 2;
	return result;
}
export const label = (value: number) => value > 0 ? "positive" : "other";`;
		const instrumented = instrumentTypeScriptSource(source, "src/choose.ts");
		expect(instrumented.contents.split("\n")).toHaveLength(source.split("\n").length);
		expect(instrumented.points.some((point) => point.kind === "function" && point.functionName === "choose")).toBe(true);
		expect(instrumented.points.filter((point) => point.kind === "branch")).toHaveLength(6);

		const transpiled = ts.transpileModule(instrumented.contents, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
			reportDiagnostics: true,
		});
		expect(transpiled.diagnostics ?? []).toEqual([]);
		const hits: string[] = [];
		(globalThis as any).__zvibeEditorScriptProbeV1 = (_path: string, id: string) => hits.push(id);
		const module = { exports: {} as any };
		new Function("exports", "module", transpiled.outputText)(module.exports, module);

		expect(module.exports.choose(false, false)).toBe(0);
		expect(module.exports.choose(true, false)).toBe(2);
		expect(module.exports.choose(true, true)).toBe(1);
		expect(module.exports.label(2)).toBe("positive");
		expect(module.exports.label(0)).toBe("other");
		expect(hits.length).toBeGreaterThan(10);
	});

	test("rejects paths outside project TypeScript sources", () => {
		expect(() => instrumentTypeScriptSource("export {};", "../outside.ts")).toThrow("under src");
		expect(() => instrumentTypeScriptSource("export {};", "src/plain.js")).toThrow("under src");
	});
});

describe("tools/compile source instrumentation", () => {
	const previousProjectPath = projectConfiguration.path;
	const directories: string[] = [];

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("instruments only project sources for Debug Play and returns an exact manifest", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-source-instrumentation-"));
		directories.push(directory);
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await ensureDir(join(directory, "src"));
		await ensureDir(join(directory, ".temp"));
		await writeFile(projectConfiguration.path, "{}\n");
		await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
		await writeFile(join(directory, "src/player.ts"), "export function update(value: number): number { return value > 0 ? value + 1 : 0; }\n");
		await writeFile(join(directory, "src/enemy.ts"), "export function damage(value: number): number { return value > 0 ? value - 1 : 0; }\n");
		await writeFile(join(directory, "src/scripts.ts"), 'export { update } from "./player";\nexport { damage } from "./enemy";\n');

		const normalOutput = join(directory, ".temp/normal.cjs");
		const debugOutput = join(directory, ".temp/debug.cjs");
		const normal = await compileScript({ entryPoints: [join(directory, "src/scripts.ts")], outfile: normalOutput });
		const debug = await compileScript({ entryPoints: [join(directory, "src/scripts.ts")], outfile: debugOutput, instrumentProjectSources: true });

		expect(normal?.sourceManifest).toBeNull();
		expect(await readFile(normalOutput, "utf8")).not.toContain("__zvibeEditorScriptProbeV1");
		expect(debug?.sourceManifest).toMatchObject({ version: 1, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(debug?.sourceManifest?.points.length).toBeGreaterThan(0);
		expect(new Set(debug?.sourceManifest?.points.map((point) => point.path))).toEqual(new Set(["src/enemy.ts", "src/player.ts"]));
		expect(new Set(debug?.sourceManifest?.points.map((point) => point.id)).size).toBe(debug?.sourceManifest?.points.length);
		expect(await readFile(debugOutput, "utf8")).toContain("__zvibeEditorScriptProbeV1");
	});

	test("generates the exact Play bridge exports required by the debugger runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-source-bridge-"));
		directories.push(directory);
		await ensureDir(join(directory, "src"));
		await ensureDir(join(directory, "assets"));
		await handleExportScripts({
			state: { projectPath: join(directory, "Game.bjseditor") },
			layout: {
				preview: {
					scene: { meshes: [], lights: [], cameras: [], transformNodes: [], particleSystems: [], spriteManagers: [] },
				},
			},
		} as any);

		const generated = await readFile(join(directory, "src/scripts.ts"), "utf8");
		for (const name of [
			"configureScriptSourceDebugger",
			"getScriptSourceDebuggerSnapshot",
			"setScriptSourceBreakpoints",
			"setScriptSourceCoverage",
			"clearScriptSourceDebuggerTrace",
			"getScriptSourceCoverage",
			"configureNetworking",
			"getNetworkingRuntime",
			"getSceneNetworkingConfiguration",
			"listLight2DProviderTypes",
			"listShadowShape2DProviderTypes",
			"getLighting2DRuntimeEvidence",
		]) {
			expect(generated).toContain(name);
		}
	});

	test("collects scripts from serialized entities without treating editor sidecars as runtime entities", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-export-scripts-"));
		directories.push(directory);
		await ensureDir(join(directory, "src"));
		await ensureDir(join(directory, "assets/Test.scene/nodes"));
		await writeFile(join(directory, "src/included.ts"), "export class Included {}\n");
		await writeFile(join(directory, "src/sidecar-only.ts"), "export class SidecarOnly {}\n");
		await writeJSON(join(directory, "assets/Test.scene/nodes/entity.json"), {
			name: "Entity",
			metadata: { scripts: [{ key: "included.ts" }] },
		});
		await writeJSON(join(directory, "assets/Test.scene/nodes/entity.json.bjsmeta.json"), {
			metadata: { scripts: [{ key: "sidecar-only.ts" }] },
		});

		await handleExportScripts({
			state: { projectPath: join(directory, "Game.bjseditor") },
			layout: {
				preview: {
					scene: { meshes: [], lights: [], cameras: [], transformNodes: [], particleSystems: [], spriteManagers: [] },
				},
			},
		} as any);

		const generated = await readFile(join(directory, "src/scripts.ts"), "utf8");
		expect(generated).toContain('import * as included from "./included";');
		expect(generated).not.toContain("sidecar_only");
	});
});
