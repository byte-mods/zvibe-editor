import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import {
	createProjectSemanticMergeRule,
	deleteProjectSemanticMergeRule,
	listProjectSemanticMergeRules,
	setProjectSemanticMergeRule,
} from "../../src/mcp/project/semantic-merge-rules";
import { mergeProjectSceneAssets } from "../../src/mcp/project/semantic-merge";

describe("mcp/project/semantic-merge-rules", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-semantic-merge-rules-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await writeJSON(options.editor.state.projectPath, {});
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	test("creates, updates, lists, and deletes versioned reusable rules atomically", async () => {
		const [first, second] = await Promise.all([
			createProjectSemanticMergeRule(
				scene,
				{ name: "Prefer Incoming Settings", assetKind: "prefab", filePattern: "*.json", pathPrefix: "/settings", choice: "theirs" },
				options
			),
			createProjectSemanticMergeRule(scene, { name: "Keep Scene Camera", assetKind: "scene", filePattern: "cameras/*.json", pathPrefix: "/", choice: "ours" }, options),
		]);
		expect((await listProjectSemanticMergeRules(scene, {}, options)).rules).toHaveLength(2);
		const updated = await setProjectSemanticMergeRule(
			scene,
			{ id: first.rule.id, name: "Incoming Gameplay Settings", choice: "custom", customValue: { mode: "competitive" } },
			options
		);
		expect(updated.rule).toMatchObject({ name: "Incoming Gameplay Settings", choice: "custom", customValue: { mode: "competitive" } });
		await expect(createProjectSemanticMergeRule(scene, { name: "incoming gameplay settings", choice: "ours" }, options)).rejects.toThrow("already exists");
		expect((await deleteProjectSemanticMergeRule(scene, { id: second.rule.id }, options)).deleted).toBe(true);
		expect((await listProjectSemanticMergeRules(scene, { assetKind: "prefab" }, options)).rules).toHaveLength(1);
	});

	test("applies exact per-conflict choices including custom JSON and deletion", async () => {
		await writeJSON(join(directory, "base.prefab"), { a: 0, b: 0, c: 0 });
		await writeJSON(join(directory, "ours.prefab"), { a: 1, b: 1, c: 1 });
		await writeJSON(join(directory, "theirs.prefab"), { a: 2, b: 2, c: 2 });
		const conflictResolutions = [
			{ file: "prefab.json", path: "/a", choice: "theirs" },
			{ file: "prefab.json", path: "/b", choice: "custom", customValue: { selected: 42 } },
			{ file: "prefab.json", path: "/c", choice: "delete" },
		];

		const preview = await mergeProjectSceneAssets(scene, { basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", conflictResolutions }, options);
		expect(preview).toMatchObject({
			summary: { totalConflicts: 3, resolvedConflicts: 3, unresolvedConflicts: 0 },
			options: { conflictResolutionCount: 3 },
		});
		expect(preview.conflicts.every((conflict: any) => conflict.resolved && conflict.resolutionSource === "override")).toBe(true);

		await mergeProjectSceneAssets(
			scene,
			{ basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", outputPath: "merged.prefab", write: true, conflictResolutions },
			options
		);
		expect(await readJSON(join(directory, "merged.prefab"))).toEqual({ a: 2, b: { selected: 42 } });
	});

	test("applies selected saved rules while exact overrides retain precedence", async () => {
		await writeJSON(join(directory, "base.prefab"), { settings: { speed: 1, lives: 3 }, title: "base" });
		await writeJSON(join(directory, "ours.prefab"), { settings: { speed: 2, lives: 4 }, title: "ours" });
		await writeJSON(join(directory, "theirs.prefab"), { settings: { speed: 3, lives: 5 }, title: "theirs" });
		const created = await createProjectSemanticMergeRule(
			scene,
			{ name: "Incoming Settings", assetKind: "prefab", filePattern: "prefab.json", pathPrefix: "/settings", choice: "theirs" },
			options
		);

		const result = await mergeProjectSceneAssets(
			scene,
			{
				basePath: "base.prefab",
				oursPath: "ours.prefab",
				theirsPath: "theirs.prefab",
				ruleIds: [created.rule.id],
				conflictResolutions: [{ file: "prefab.json", path: "/settings/speed", choice: "base" }],
			},
			options
		);
		expect(result.summary).toMatchObject({ totalConflicts: 3, resolvedConflicts: 2, unresolvedConflicts: 1 });
		expect(result.options.appliedRuleIds).toEqual([created.rule.id]);
		expect(result.conflicts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "/settings/speed", resolution: "base", resolutionSource: "override", resolved: true }),
				expect.objectContaining({ path: "/settings/lives", resolution: "theirs", resolutionSource: "rule", ruleId: created.rule.id, resolved: true }),
				expect.objectContaining({ path: "/title", resolution: "manual", resolutionSource: "unresolved", resolved: false }),
			])
		);
	});

	test("rejects malformed stores and invalid override payloads", async () => {
		await writeJSON(join(directory, "base.prefab"), { value: 0 });
		await writeJSON(join(directory, "ours.prefab"), { value: 1 });
		await writeJSON(join(directory, "theirs.prefab"), { value: 2 });
		await expect(
			mergeProjectSceneAssets(
				scene,
				{
					basePath: "base.prefab",
					oursPath: "ours.prefab",
					theirsPath: "theirs.prefab",
					conflictResolutions: [{ file: "../prefab.json", path: "/value", choice: "ours" }],
				},
				options
			)
		).rejects.toThrow("without traversal");
		await ensureDir(join(directory, ".babylon-editor"));
		await writeFile(join(directory, ".babylon-editor", "merge-rules.json"), "{broken", "utf-8");
		await expect(listProjectSemanticMergeRules(scene, {}, options)).rejects.toThrow("invalid JSON");
		await writeJSON(join(directory, ".babylon-editor", "merge-rules.json"), {
			version: 1,
			rules: [
				{
					id: "not-a-uuid",
					name: "Invalid",
					enabled: true,
					assetKind: "any",
					filePattern: "*".repeat(300),
					pathPrefix: "/",
					choice: "ours",
					createdAt: "now",
					updatedAt: "now",
				},
			],
		});
		await expect(listProjectSemanticMergeRules(scene, {}, options)).rejects.toThrow("malformed schema");
	});
});
