import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { mkdtemp, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { createScript, listScriptTemplates } from "../../src/mcp/scripts/scripts";

describe("mcp/script-templates", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-script-template-"));
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

	test("lists and writes named script templates under src", async () => {
		expect(listScriptTemplates().templates.map((template: any) => template.id)).toEqual(["component", "empty", "animator-behaviour"]);
		await createScript(scene, { path: "src/idle.ts", className: "Idle", template: "empty" });
		expect(await readFile(join(directory, "src/idle.ts"), "utf-8")).toContain("class Idle");
		expect(await readFile(join(directory, "src/idle.ts"), "utf-8")).toContain("onStop");
		await expect(createScript(scene, { path: "src/bad.ts", template: "unknown" })).rejects.toThrow("Unknown script template");
	});
});
