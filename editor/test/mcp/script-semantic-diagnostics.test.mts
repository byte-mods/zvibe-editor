import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import {
	createScript,
	getProjectScriptSemanticDiagnostics,
	getScriptSemanticDiagnostics,
	listCustomScriptTemplates,
	readScript,
	setCustomScriptTemplate,
} from "../../src/mcp/scripts/scripts";

describe("mcp/script-semantic-diagnostics", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-script-diagnostics-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("returns semantic type errors with project-relative source locations", async () => {
		await ensureDir(join(directory, "src"));
		await writeFile(join(directory, "src", "broken.ts"), "const value: number = 'wrong';\n");
		const result = await getScriptSemanticDiagnostics(scene, { path: "src/broken.ts" });
		expect(result.valid).toBe(false);
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 2322, path: "src/broken.ts", line: 1 }));
	});

	test("discovers and type-checks every project script", async () => {
		await ensureDir(join(directory, "src", "nested"));
		await writeFile(join(directory, "src", "good.ts"), "export const value: number = 1;\n");
		await writeFile(join(directory, "src", "nested", "bad.ts"), "export const value: string = 1;\n");
		const result = await getProjectScriptSemanticDiagnostics(scene);
		expect(result.valid).toBe(false);
		expect(result.filesChecked).toEqual(expect.arrayContaining(["src/good.ts", "src/nested/bad.ts"]));
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 2322, path: "src/nested/bad.ts", line: 1 }));
	});

	test("persists, discovers, and applies a reusable project-local script template", async () => {
		const template = await setCustomScriptTemplate(scene, {
			id: "trigger",
			description: "Trigger behavior",
			content: "export default class Trigger { public onStart(): void {} }\n",
		});
		expect(template.path).toBe(".babylon-editor/script-templates/trigger.script-template.json");
		expect((await listCustomScriptTemplates()).templates).toEqual([expect.objectContaining({ id: "trigger", description: "Trigger behavior", path: template.path })]);
		await createScript(scene, { path: "src/trigger.ts", templatePath: template.path });
		expect((await readScript(scene, { path: "src/trigger.ts" })).content).toContain("class Trigger");
	});
});
