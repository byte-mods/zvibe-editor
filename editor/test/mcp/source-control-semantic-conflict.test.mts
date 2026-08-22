import { execFile } from "child_process";
import { promisify } from "util";

import { afterEach, describe, expect, test } from "vitest";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";

import {
	abortProjectSourceControlIntegration,
	applyProjectSourceControlSemanticConflict,
	inspectProjectSourceControlSemanticConflict,
	startProjectSourceControlMerge,
} from "../../src/mcp/project/source-control";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf-8" });
	return result.stdout;
}

async function createRepository(path = "assets/hero.prefab", content = '{"position":[0,0,0],"health":100}\n'): Promise<{ root: string; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-editor-semantic-git-"));
	temporaryDirectories.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Babylon Editor Test");
	await git(root, "config", "user.email", "editor-test@example.invalid");
	await mkdir(join(root, path, ".."), { recursive: true });
	await writeFile(join(root, "project.bjseditor"), "{}\n");
	await writeFile(join(root, path), content);
	await git(root, "add", "-A");
	await git(root, "commit", "-m", "Initial project");
	return { root, options: { editor: { state: { projectPath: join(root, "project.bjseditor") } } } as any };
}

async function createConflict(root: string, path: string, ours: string, theirs: string, options: any): Promise<void> {
	await git(root, "switch", "-c", "feature/semantic");
	await writeFile(join(root, path), theirs);
	await git(root, "add", path);
	await git(root, "commit", "-m", "Incoming semantic edit");
	await git(root, "switch", "main");
	await writeFile(join(root, path), ours);
	await git(root, "add", path);
	await git(root, "commit", "-m", "Local semantic edit");
	const started = await startProjectSourceControlMerge({} as any, { target: "feature/semantic", confirm: true }, options);
	expect(started).toMatchObject({ completed: false, integration: { operation: "merge", conflictCount: 1 } });
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mcp/project/source-control semantic conflicts", () => {
	test("previews and atomically stages independent prefab edits from real Git conflict stages", async () => {
		const path = "assets/hero.prefab";
		const { root, options } = await createRepository(path);
		await createConflict(root, path, '{"position":[2,0,0],"health":100}\n', '{"position":[0,0,0],"health":80}\n', options);

		const preview = await inspectProjectSourceControlSemanticConflict({} as any, { path }, options);
		expect(preview).toMatchObject({
			operation: "merge",
			path,
			merge: { kind: "prefab", file: "prefab.json", deleted: false, summary: { totalConflicts: 0, unresolvedConflicts: 0 } },
		});
		expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(preview.merge.outputHash).toMatch(/^[a-f0-9]{64}$/);
		await expect(
			applyProjectSourceControlSemanticConflict(
				{} as any,
				{ path, expectedFingerprint: preview.fingerprint, expectedOutputHash: preview.merge.outputHash, confirm: false },
				options
			)
		).rejects.toThrow("confirm must be true");

		const applied = await applyProjectSourceControlSemanticConflict(
			{} as any,
			{ path, expectedFingerprint: preview.fingerprint, expectedOutputHash: preview.merge.outputHash, confirm: true },
			options
		);
		expect(applied).toMatchObject({ applied: true, path, deleted: false, integration: { operation: "merge", conflictCount: 0 } });
		expect(JSON.parse(await readFile(join(root, path), "utf-8"))).toEqual({ health: 80, position: [2, 0, 0] });
		expect((await git(root, "diff", "--cached", "--name-only")).trim()).toBe(path);
	});

	test("blocks unresolved property conflicts and guards both Git stages and the selected semantic output", async () => {
		const path = "assets/settings.prefab";
		const { root, options } = await createRepository(path, '{"value":0}\n');
		await createConflict(root, path, '{"value":1}\n', '{"value":2}\n', options);

		const unresolved = await inspectProjectSourceControlSemanticConflict({} as any, { path }, options);
		expect(unresolved.merge).toMatchObject({ summary: { totalConflicts: 1, unresolvedConflicts: 1 } });
		await expect(
			applyProjectSourceControlSemanticConflict(
				{} as any,
				{ path, expectedFingerprint: unresolved.fingerprint, expectedOutputHash: unresolved.merge.outputHash, confirm: true },
				options
			)
		).rejects.toThrow("unresolved conflict");

		const resolution = { file: "prefab.json", path: "/value", choice: "theirs" };
		const resolved = await inspectProjectSourceControlSemanticConflict({} as any, { path, conflictResolutions: [resolution] }, options);
		await expect(
			applyProjectSourceControlSemanticConflict(
				{} as any,
				{
					path,
					conflictResolutions: [resolution],
					expectedFingerprint: resolved.fingerprint,
					expectedOutputHash: unresolved.merge.outputHash,
					confirm: true,
				},
				options
			)
		).rejects.toThrow("output changed");
		await expect(
			applyProjectSourceControlSemanticConflict(
				{} as any,
				{
					path,
					conflictResolutions: [resolution],
					expectedFingerprint: "0".repeat(64),
					expectedOutputHash: resolved.merge.outputHash,
					confirm: true,
				},
				options
			)
		).rejects.toThrow("stages changed");
		await applyProjectSourceControlSemanticConflict(
			{} as any,
			{
				path,
				conflictResolutions: [resolution],
				expectedFingerprint: resolved.fingerprint,
				expectedOutputHash: resolved.merge.outputHash,
				confirm: true,
			},
			options
		);
		expect(JSON.parse(await readFile(join(root, path), "utf-8"))).toEqual({ value: 2 });
	});

	test("supports scene manifest paths and refuses unsupported or malformed conflict content", async () => {
		const scenePath = "assets/Level.scene/nodes/hero.json";
		const scene = await createRepository(scenePath, '{"position":[0,0,0]}\n');
		await createConflict(scene.root, scenePath, '{"position":[1,0,0]}\n', '{"position":[2,0,0]}\n', scene.options);
		await expect(inspectProjectSourceControlSemanticConflict({} as any, { path: scenePath }, scene.options)).resolves.toMatchObject({
			merge: { kind: "scene", file: "nodes/hero.json", summary: { totalConflicts: 1 } },
		});
		await abortProjectSourceControlIntegration({} as any, { confirm: true }, scene.options);

		const unsupportedPath = "assets/settings.json";
		const unsupported = await createRepository(unsupportedPath, '{"value":0}\n');
		await createConflict(unsupported.root, unsupportedPath, '{"value":1}\n', '{"value":2}\n', unsupported.options);
		await expect(inspectProjectSourceControlSemanticConflict({} as any, { path: unsupportedPath }, unsupported.options)).rejects.toThrow("supports .prefab JSON files");
		await abortProjectSourceControlIntegration({} as any, { confirm: true }, unsupported.options);

		const malformed = await createRepository("assets/broken.prefab", '{"value":0}\n');
		await createConflict(malformed.root, "assets/broken.prefab", "{broken ours\n", "{broken theirs\n", malformed.options);
		await expect(inspectProjectSourceControlSemanticConflict({} as any, { path: "assets/broken.prefab" }, malformed.options)).rejects.toThrow("contains invalid JSON");
	});
});
