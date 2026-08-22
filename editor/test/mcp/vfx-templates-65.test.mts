import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";

import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { createVfxGraphFromTemplate, createVfxTemplateGraph, listVfxGraphTemplates, vfxGraphTemplateCatalogRevision } from "../../src/mcp/particles/vfx-templates";

describe("mcp/vfx-templates-65", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let previousProjectPath: string | null;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-vfx-templates-65-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Project.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await rm(projectDirectory, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	test("searches and category-filters deterministic buildable templates", async () => {
		const result = listVfxGraphTemplates(null, { query: "weather", category: "Environment", offset: 0, limit: 10 }) as any;
		expect(result).toMatchObject({ catalogRevision: vfxGraphTemplateCatalogRevision, category: "Environment", total: 1 });
		expect(result.templates.map((template: any) => template.id)).toEqual(["rain-field"]);
		const graph = createVfxTemplateGraph("sparks-burst", "Focused Sparks");
		const batch = await graph.buildAsync(scene, false);
		expect(batch.systems).toHaveLength(1);
		const systemBlock = graph.serialize().blocks.find((block: any) => block.customType === "BABYLON.SystemBlock");
		expect(systemBlock.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "emitRate", value: 80 })]));
		batch.dispose();
		graph.dispose();
		expect(() => listVfxGraphTemplates(scene, { category: "Unknown" })).toThrow("query or category is invalid");
	});

	test("creates an exact-revision compile-checked NPSS asset and rejects stale or escaping requests", async () => {
		const created = (await createVfxGraphFromTemplate(
			scene,
			{
				templateId: "smoke-plume",
				expectedCatalogRevision: vfxGraphTemplateCatalogRevision,
				name: "Factory Smoke",
				folder: "assets/vfx",
			},
			options
		)) as any;
		expect(created).toMatchObject({ path: "assets/vfx/Factory Smoke.npss", name: "Factory Smoke", template: { id: "smoke-plume" }, systemCount: 1 });
		const persisted = JSON.parse(await readFile(join(projectDirectory, created.path), "utf-8"));
		expect(persisted).toMatchObject({
			customType: "BABYLON.NodeParticleSystemSet",
			babylonEditorVfxTemplate: { id: "smoke-plume", catalogRevision: vfxGraphTemplateCatalogRevision },
		});
		const persistedSystem = persisted.blocks.find((block: any) => block.customType === "BABYLON.SystemBlock");
		expect(persistedSystem.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "emitRate", value: 24 })]));
		expect(options.editor.layout.assets.refresh).toHaveBeenCalledOnce();

		await expect(
			createVfxGraphFromTemplate(scene, { templateId: "starter-sprite", expectedCatalogRevision: "0".repeat(64), name: "Stale", folder: "assets" }, options)
		).rejects.toThrow("catalog changed");
		await symlink(join(projectDirectory, "assets"), join(projectDirectory, "linked-assets"));
		await expect(
			createVfxGraphFromTemplate(
				scene,
				{ templateId: "starter-sprite", expectedCatalogRevision: vfxGraphTemplateCatalogRevision, name: "Escape", folder: "linked-assets" },
				options
			)
		).rejects.toThrow("regular project directories");
	});

	test("creates assets for headless MCP clients before the Assets Browser mounts", async () => {
		const created = (await createVfxGraphFromTemplate(
			scene,
			{
				templateId: "starter-sprite",
				expectedCatalogRevision: vfxGraphTemplateCatalogRevision,
				name: "Headless Starter",
				folder: "assets",
			},
			{ editor: { layout: {} } } as any
		)) as any;

		expect(created.path).toBe("assets/Headless Starter.npss");
		expect(JSON.parse(await readFile(join(projectDirectory, created.path), "utf-8"))).toMatchObject({ customType: "BABYLON.NodeParticleSystemSet" });
	});
});
