import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, pathExists, readFile, remove, symlink, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import {
	createScript,
	deleteCustomScriptTemplate,
	deleteScript,
	getCustomScriptTemplate,
	listCustomScriptTemplates,
	listScriptTemplates,
	setCustomScriptTemplate,
} from "../../src/mcp/scripts/scripts";

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
		expect(listScriptTemplates().templates.map((template: any) => template.id)).toEqual([
			"component",
			"empty",
			"animator-behaviour",
			"animation-rig-job",
			"grid-brush",
			"light2d-providers",
		]);
		await createScript(scene, { path: "src/idle.ts", className: "Idle", template: "empty" });
		expect(await readFile(join(directory, "src/idle.ts"), "utf-8")).toContain("class Idle");
		expect(await readFile(join(directory, "src/idle.ts"), "utf-8")).toContain("onStop");
		await createScript(scene, { path: "src/custom-rig.ts", className: "CustomRigRegistration", template: "animation-rig-job" });
		const customRig = await readFile(join(directory, "src/custom-rig.ts"), "utf-8");
		expect(customRig).toContain("registerAnimationRigJob");
		expect(customRig).toContain("processRootMotion");
		expect(customRig).toContain("processAnimation");
		expect(customRig).toContain("class CustomRigRegistration");
		await createScript(scene, { path: "src/custom-grid-brush.ts", className: "CustomGridBrush", template: "grid-brush" });
		const customGridBrush = await readFile(join(directory, "src/custom-grid-brush.ts"), "utf-8");
		expect(customGridBrush).toContain("registerGridBrush");
		expect(customGridBrush).toContain("project.checker-grid-brush");
		expect(customGridBrush).toContain("class CustomGridBrush");
		await createScript(scene, { path: "src/custom-lighting-2d.ts", className: "CustomLighting2DProviders", template: "light2d-providers" });
		const customLighting2D = await readFile(join(directory, "src/custom-lighting-2d.ts"), "utf-8");
		expect(customLighting2D).toContain("registerLight2DProvider");
		expect(customLighting2D).toContain("registerShadowShape2DProvider");
		expect(customLighting2D).toContain("project.pulse-light");
		expect(customLighting2D).toContain("project.box-shadow");
		expect(customLighting2D).toContain("class CustomLighting2DProviders");
		await expect(createScript(scene, { path: "src/bad.ts", template: "unknown" })).rejects.toThrow("Unknown script template");
	});

	test("deletes a script and its generated metadata sidecar only after confirmation", async () => {
		await createScript(scene, { path: "src/disposable.ts", template: "empty" });
		const scriptPath = join(directory, "src/disposable.ts");
		const sidecarPath = `${scriptPath}.bjsmeta.json`;
		const inspectorCachePath = join(directory, ".bjseditor/scripts/disposable.ts.cjs");
		await writeFile(sidecarPath, "{}\n");
		await ensureDir(join(directory, ".bjseditor/scripts"));
		await writeFile(inspectorCachePath, "module.exports = {};\n");

		await expect(deleteScript(scene, { path: "src/disposable.ts", confirm: false })).rejects.toThrow("confirm: true");
		expect(await pathExists(scriptPath)).toBe(true);
		expect(await pathExists(sidecarPath)).toBe(true);
		expect(await pathExists(inspectorCachePath)).toBe(true);

		await expect(deleteScript(scene, { path: "src/disposable.ts", confirm: true })).resolves.toEqual({ deleted: true, path: "src/disposable.ts" });
		expect(await pathExists(scriptPath)).toBe(false);
		expect(await pathExists(sidecarPath)).toBe(false);
		expect(await pathExists(inspectorCachePath)).toBe(false);
	});

	test("rejects sibling paths whose names merely start with src", async () => {
		await expect(createScript(scene, { path: "src-outside/escape.ts", template: "empty" })).rejects.toThrow('Scripts must live under "src/"');
		expect(await pathExists(join(directory, "src-outside/escape.ts"))).toBe(false);
	});

	test("inspects, stale-guards, replaces, consumes, and confirms deletion of custom templates", async () => {
		const created = await setCustomScriptTemplate(scene, {
			id: "gameplay",
			description: "Gameplay behavior",
			content: "export default class MyScriptComponent { public value = 1; }\n",
		});
		expect(created.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(await listCustomScriptTemplates()).toEqual({
			templates: [expect.objectContaining({ id: "gameplay", path: created.path, fingerprint: created.fingerprint, contentBytes: 61 })],
		});
		expect((await listCustomScriptTemplates()).templates[0]).not.toHaveProperty("content");

		const inspected = await getCustomScriptTemplate(scene, { id: "gameplay" });
		expect(inspected).toMatchObject({ id: "gameplay", description: "Gameplay behavior", content: expect.stringContaining("value = 1"), fingerprint: created.fingerprint });
		await expect(setCustomScriptTemplate(scene, { id: "gameplay", content: "export default class MyScriptComponent {}\n" })).rejects.toThrow("expectedFingerprint");
		await expect(
			setCustomScriptTemplate(scene, { id: "gameplay", content: "export default class MyScriptComponent {}\n", expectedFingerprint: "0".repeat(64) })
		).rejects.toThrow("changed since");

		const replaced = await setCustomScriptTemplate(scene, {
			id: "gameplay",
			description: "Updated",
			content: "export default class MyScriptComponent { public value = 2; }\n",
			expectedFingerprint: inspected.fingerprint,
		});
		expect(replaced.fingerprint).not.toBe(inspected.fingerprint);
		await createScript(scene, { path: "src/from-template.ts", className: "FromTemplate", templatePath: replaced.path });
		expect(await readFile(join(directory, "src/from-template.ts"), "utf8")).toContain("class FromTemplate");
		expect(await readFile(join(directory, "src/from-template.ts"), "utf8")).toContain("value = 2");

		await expect(deleteCustomScriptTemplate(scene, { id: "gameplay", expectedFingerprint: replaced.fingerprint, confirm: false })).rejects.toThrow("confirm: true");
		await expect(deleteCustomScriptTemplate(scene, { id: "gameplay", expectedFingerprint: inspected.fingerprint, confirm: true })).rejects.toThrow("changed since");
		await expect(deleteCustomScriptTemplate(scene, { id: "gameplay", expectedFingerprint: replaced.fingerprint, confirm: true })).resolves.toMatchObject({
			deleted: true,
			id: "gameplay",
		});
		expect((await listCustomScriptTemplates()).templates).toEqual([]);
	});

	test("rejects custom-template symlinks instead of reading outside project storage", async () => {
		const external = join(directory, "external.json");
		const templateDirectory = join(directory, ".babylon-editor/script-templates");
		await ensureDir(templateDirectory);
		await writeFile(external, JSON.stringify({ version: 1, description: "outside", content: "export default class MyScriptComponent {}" }));
		await symlink(external, join(templateDirectory, "linked.script-template.json"));
		await expect(getCustomScriptTemplate(scene, { id: "linked" })).rejects.toThrow("not a symlink");
		await expect(listCustomScriptTemplates()).rejects.toThrow("not a symlink");
	});
});
