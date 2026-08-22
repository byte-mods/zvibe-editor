import { execFile } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

import { afterEach, describe, expect, test } from "vitest";

import {
	applyProjectSourceControlFolderAction,
	applyProjectSourceControlShelvesetPaths,
	createProjectSourceControlShelveset,
	deleteProjectSourceControlShelveset,
	getProjectSourceControlWorkspace,
	getProjectSourceControlWorkspaceLayout,
	inspectProjectSourceControlChangeset,
	inspectProjectSourceControlShelveset,
	renameProjectSourceControlRef,
	setProjectSourceControlWorkspaceLayout,
} from "../../src/mcp/project/source-control";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf-8" });
	return result.stdout;
}

async function createRepository(): Promise<{ root: string; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-workspace-"));
	temporaryDirectories.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Workspace Test");
	await git(root, "config", "user.email", "workspace@example.invalid");
	await mkdir(join(root, "assets"), { recursive: true });
	await writeFile(join(root, "project.bjseditor"), "{}\n");
	await writeFile(join(root, "assets", "level.txt"), "version one\n");
	await git(root, "add", "-A");
	await git(root, "commit", "-m", "Initial project");
	return { root, options: { editor: { state: { projectPath: join(root, "project.bjseditor") } } } as any };
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mcp/project/source-control-workspace", () => {
	test("returns filtered pending/incoming empty states, branch graph, exact changeset properties, and persistent layout", async () => {
		const { root, options } = await createRepository();
		await writeFile(join(root, "assets", "level.txt"), "version two\n");
		const workspace = await getProjectSourceControlWorkspace({} as any, { pendingFilter: "level", incomingFilter: "missing", limit: 50 }, options);
		expect(workspace).toMatchObject({
			contract: "portable-git-source-control-workspace-v1",
			projectOwnsWorktree: true,
			pending: { filter: "level", totalMatching: 1, emptyState: null },
			incoming: { upstream: null, commits: [], emptyState: expect.stringContaining("Set an upstream") },
			boundaries: { provider: "Git", unityVersionControlServiceIdentity: false, remoteContacted: false, shelvesetEquivalent: "git-stash" },
		});
		expect(workspace.workspaceFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(workspace.branchExplorer.commits).toHaveLength(1);
		expect(workspace.branchExplorer.commits[0].parents).toEqual([]);

		const changeset = await inspectProjectSourceControlChangeset({} as any, { hash: workspace.branchExplorer.commits[0].hash }, options);
		expect(changeset).toMatchObject({ comparison: { from: null, mode: "root" }, changeset: { subject: "Initial project", author: { name: "Workspace Test" } } });
		expect(changeset.diff).toContain("version one");

		const originalLayout = await getProjectSourceControlWorkspaceLayout({} as any, {}, options);
		const saved = await setProjectSourceControlWorkspaceLayout(
			{} as any,
			{ expectedRevision: originalLayout.revision, branchExplorerPercent: 30, changesPercent: 45, propertiesPercent: 25, activePanel: "branches" },
			options
		);
		expect(saved).toMatchObject({ saved: true, persistence: "renderer-local-storage", layout: { branchExplorerPercent: 30, activePanel: "branches" } });
		expect(await getProjectSourceControlWorkspaceLayout({} as any, {}, options)).toEqual(saved.layout);
		await expect(
			setProjectSourceControlWorkspaceLayout(
				{} as any,
				{ expectedRevision: originalLayout.revision, branchExplorerPercent: 30, changesPercent: 45, propertiesPercent: 25, activePanel: "pending" },
				options
			)
		).rejects.toThrow("changed after inspection");
	});

	test("adds a contained folder and exact-fingerprint undo restores tracked files while preserving untracked files", async () => {
		const { root, options } = await createRepository();
		await writeFile(join(root, "assets", "level.txt"), "staged version\n");
		await writeFile(join(root, "assets", "new.txt"), "new\n");
		let workspace = await getProjectSourceControlWorkspace({} as any, {}, options);
		const added = await applyProjectSourceControlFolderAction(
			{} as any,
			{ action: "add", path: "assets", expectedWorkspaceFingerprint: workspace.workspaceFingerprint },
			options
		);
		expect(added).toMatchObject({ applied: true, action: "add", path: "assets", status: { stagedCount: 2 } });

		await git(root, "reset", "--hard", "HEAD");
		await writeFile(join(root, "assets", "level.txt"), "discard me\n");
		await writeFile(join(root, "assets", "untracked.txt"), "keep me\n");
		workspace = await getProjectSourceControlWorkspace({} as any, {}, options);
		await expect(
			applyProjectSourceControlFolderAction({} as any, { action: "undo", path: "assets", expectedWorkspaceFingerprint: "0".repeat(64), confirm: true }, options)
		).rejects.toThrow("changed after inspection");
		const undone = await applyProjectSourceControlFolderAction(
			{} as any,
			{ action: "undo", path: "assets", expectedWorkspaceFingerprint: workspace.workspaceFingerprint, confirm: true },
			options
		);
		expect(await readFile(join(root, "assets", "level.txt"), "utf-8")).toBe("version one\n");
		expect(await readFile(join(root, "assets", "untracked.txt"), "utf-8")).toBe("keep me\n");
		expect(undone.untrackedFilesPreserved).toEqual(["assets/untracked.txt"]);
	});

	test("creates, inspects, partially applies, retains, and exactly deletes a tracked Git shelveset", async () => {
		const { root, options } = await createRepository();
		await writeFile(join(root, "assets", "level.txt"), "shelved version\n");
		let workspace = await getProjectSourceControlWorkspace({} as any, {}, options);
		const created = await createProjectSourceControlShelveset(
			{} as any,
			{ message: "Level experiment", expectedWorkspaceFingerprint: workspace.workspaceFingerprint, confirm: true },
			options
		);
		expect(created).toMatchObject({ created: true, workspaceUnchanged: true, shelveset: { subject: expect.stringContaining("Level experiment") } });
		expect(await readFile(join(root, "assets", "level.txt"), "utf-8")).toBe("shelved version\n");
		const inspected = await inspectProjectSourceControlShelveset({} as any, { shelvesetHash: created.shelveset.hash }, options);
		expect(inspected).toMatchObject({ retainedAfterPartialApply: true, supportsUntrackedPartialApply: false });
		expect(inspected.diff).toContain("shelved version");

		await git(root, "restore", "--worktree", "--", "assets/level.txt");
		workspace = await getProjectSourceControlWorkspace({} as any, {}, options);
		const applied = await applyProjectSourceControlShelvesetPaths(
			{} as any,
			{ shelvesetHash: created.shelveset.hash, paths: ["assets/level.txt"], expectedWorkspaceFingerprint: workspace.workspaceFingerprint, confirm: true },
			options
		);
		expect(applied).toMatchObject({ applied: true, retained: true, paths: ["assets/level.txt"] });
		expect(await readFile(join(root, "assets", "level.txt"), "utf-8")).toBe("shelved version\n");
		expect((await getProjectSourceControlWorkspace({} as any, {}, options)).shelvesets.entries).toHaveLength(1);

		const deleted = await deleteProjectSourceControlShelveset({} as any, { shelvesetHash: created.shelveset.hash, confirm: true }, options);
		expect(deleted).toMatchObject({ deleted: true, shelvesetHash: created.shelveset.hash, shelvesets: [] });
		await expect(inspectProjectSourceControlShelveset({} as any, { shelvesetHash: created.shelveset.hash }, options)).rejects.toThrow("currently retained");
	});

	test("renames branches and annotated labels under exact inspected hashes and rejects stale identity", async () => {
		const { root, options } = await createRepository();
		const head = (await git(root, "rev-parse", "HEAD")).trim();
		await git(root, "branch", "feature-old");
		await git(root, "tag", "-a", "label-old", "-m", "Annotated label");
		const labelObject = (await git(root, "rev-parse", "refs/tags/label-old")).trim();

		await expect(
			renameProjectSourceControlRef({} as any, { kind: "branch", name: "feature-old", newName: "feature-stale", expectedHash: "0".repeat(40), confirm: true }, options)
		).rejects.toThrow("changed after inspection");
		const branch = await renameProjectSourceControlRef({} as any, { kind: "branch", name: "feature-old", newName: "feature-new", expectedHash: head, confirm: true }, options);
		expect(branch).toMatchObject({ renamed: true, kind: "branch", oldName: "feature-old", newName: "feature-new", hash: head });

		const label = await renameProjectSourceControlRef({} as any, { kind: "label", name: "label-old", newName: "label-new", expectedHash: labelObject, confirm: true }, options);
		expect(label).toMatchObject({ renamed: true, kind: "label", oldName: "label-old", newName: "label-new", hash: labelObject });
		expect((await git(root, "rev-parse", "refs/tags/label-new")).trim()).toBe(labelObject);
		expect(await git(root, "cat-file", "-t", labelObject)).toBe("tag\n");
	});
});
