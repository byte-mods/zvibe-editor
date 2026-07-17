import { execFile } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

import sharp from "sharp";

import { afterEach, describe, expect, test } from "vitest";

import {
	abortProjectSourceControlIntegration,
	applyProjectSourceControlTextResolution,
	commitProjectSourceControl,
	continueProjectSourceControlIntegration,
	createProjectSourceControlBranch,
	createProjectSourceControlTag,
	deleteProjectSourceControlBranch,
	deleteProjectSourceControlRemoteBranch,
	deleteProjectSourceControlRemoteTag,
	deleteProjectSourceControlTag,
	fetchProjectSourceControl,
	getProjectSourceControlIntegrationState,
	getProjectSourceControlDiff,
	getProjectSourceControlHistory,
	getProjectSourceControlStatus,
	inspectProjectSourceControlAuthentication,
	inspectProjectSourceControlRemoteRefs,
	inspectProjectSourceControlConflictDetails,
	inspectProjectSourceControlImageConflict,
	listProjectSourceControlRefs,
	pullProjectSourceControl,
	previewProjectSourceControlIntegration,
	publishProjectSourceControlRemoteBranch,
	publishProjectSourceControlRemoteTag,
	pushProjectSourceControl,
	resolveProjectSourceControlConflict,
	stageProjectSourceControlPaths,
	startProjectSourceControlMerge,
	startProjectSourceControlRebase,
	switchProjectSourceControlBranch,
	unstageProjectSourceControlPaths,
} from "../../src/mcp/project/source-control";
import { configureProjectCollaboration, createProjectCollaborationMember, joinProjectCollaborationSession } from "../../src/mcp/project/collaboration";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf-8" });
	return result.stdout;
}

async function png(width: number, height: number, rgba: number[]): Promise<Buffer> {
	return sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
		.png({ compressionLevel: 9, adaptiveFiltering: false })
		.toBuffer();
}

async function createRepository(nestedProject = false): Promise<{ root: string; projectRoot: string; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-"));
	temporaryDirectories.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Babylon Editor Test");
	await git(root, "config", "user.email", "editor-test@example.invalid");
	const projectRoot = nestedProject ? join(root, "Game") : root;
	await mkdir(join(projectRoot, "src"), { recursive: true });
	await writeFile(join(projectRoot, "project.bjseditor"), "{}\n");
	await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 1;\n");
	if (nestedProject) {
		await writeFile(join(root, "outside.txt"), "outside\n");
	}
	await git(root, "add", "-A");
	await git(root, "commit", "-m", "Initial project");
	return { root, projectRoot, options: { editor: { state: { projectPath: join(projectRoot, "project.bjseditor") } } } as any };
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mcp/project/source-control", () => {
	test("reads project-scoped status, history, and staged or worktree diffs from a real repository", async () => {
		const { projectRoot, options } = await createRepository();
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 2;\n");
		await writeFile(join(projectRoot, "notes.txt"), "new note\n");

		const status = await getProjectSourceControlStatus({} as any, {}, options);
		expect(status).toMatchObject({ branch: "main", clean: false, changeCount: 2, stagedCount: 0, unstagedCount: 2, truncated: false, projectPrefix: "" });
		expect(status.changes.map((change: any) => change.path).sort()).toEqual(["notes.txt", "src/game.ts"]);

		const history = await getProjectSourceControlHistory({} as any, { limit: 10 }, options);
		expect(history.commits).toHaveLength(1);
		expect(history.commits[0]).toMatchObject({ author: "Babylon Editor Test", subject: "Initial project" });

		const worktreeDiff = await getProjectSourceControlDiff({} as any, { path: "src/game.ts" }, options);
		expect(worktreeDiff.diff).toContain("+export const version = 2;");
		await stageProjectSourceControlPaths({} as any, { paths: ["src/game.ts"] }, options);
		const stagedDiff = await getProjectSourceControlDiff({} as any, { path: "src/game.ts", staged: true }, options);
		expect(stagedDiff.diff).toContain("+export const version = 2;");
	});

	test("stages and unstages selected or all project paths without changing worktree files", async () => {
		const { projectRoot, options } = await createRepository();
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 3;\n");
		await writeFile(join(projectRoot, "notes.txt"), "note\n");

		const selected = await stageProjectSourceControlPaths({} as any, { paths: ["src/game.ts"] }, options);
		expect(selected.status).toMatchObject({ stagedCount: 1, unstagedCount: 1 });
		const unstaged = await unstageProjectSourceControlPaths({} as any, { paths: ["src/game.ts"] }, options);
		expect(unstaged.status).toMatchObject({ stagedCount: 0, unstagedCount: 2 });

		const all = await stageProjectSourceControlPaths({} as any, { all: true }, options);
		expect(all.status).toMatchObject({ stagedCount: 2, unstagedCount: 0 });
		const allUnstaged = await unstageProjectSourceControlPaths({} as any, { all: true }, options);
		expect(allUnstaged.status).toMatchObject({ stagedCount: 0, unstagedCount: 2 });
		expect(await getProjectSourceControlDiff({} as any, { path: "src/game.ts" }, options)).toMatchObject({ truncated: false });
	});

	test("rejects traversal, metadata, pathspec magic, option prefixes, and ambiguous selections", async () => {
		const { options } = await createRepository();
		for (const path of ["../secret", "src/../secret", ".git/config", ":(glob)**", "--all"]) {
			await expect(stageProjectSourceControlPaths({} as any, { paths: [path] }, options)).rejects.toThrow("Git paths must stay inside");
		}
		await expect(stageProjectSourceControlPaths({} as any, { all: true, paths: ["src/game.ts"] }, options)).rejects.toThrow("either all=true or paths");
	});

	test("requires confirmation, commits staged changes, and rejects staged paths outside a nested project", async () => {
		const { root, projectRoot, options } = await createRepository(true);
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 4;\n");
		await writeFile(join(root, "outside.txt"), "changed outside\n");
		await stageProjectSourceControlPaths({} as any, { all: true }, options);
		await git(root, "add", "outside.txt");

		await expect(commitProjectSourceControl({} as any, { message: "Update project", confirm: false }, options)).rejects.toThrow("confirm must be true");
		await expect(commitProjectSourceControl({} as any, { message: "Update project", confirm: true }, options)).rejects.toThrow("outside the active project");
		await git(root, "restore", "--staged", "outside.txt");

		const committed = await commitProjectSourceControl({} as any, { message: "Update project", signoff: true, confirm: true }, options);
		expect(committed).toMatchObject({ committed: true, stagedPathCount: 1, commit: { subject: "Update project" } });
		expect(await git(root, "show", "-s", "--format=%B", "HEAD")).toContain("Signed-off-by: Babylon Editor Test <editor-test@example.invalid>");
	});

	test("pushes without force to a real bare remote and rejects missing confirmation or embedded credentials", async () => {
		const { root, projectRoot, options } = await createRepository();
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 5;\n");
		await stageProjectSourceControlPaths({} as any, { all: true }, options);
		await commitProjectSourceControl({} as any, { message: "Ready to push", confirm: true }, options);

		const bare = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-remote-"));
		temporaryDirectories.push(bare);
		await git(bare, "init", "--bare");
		await git(root, "remote", "add", "origin", bare);
		await expect(pushProjectSourceControl({} as any, { remote: "origin", confirm: false }, options)).rejects.toThrow("confirm must be true");

		const pushed = await pushProjectSourceControl({} as any, { remote: "origin", branch: "main", setUpstream: true, confirm: true }, options);
		expect(pushed).toMatchObject({ pushed: true, remote: "origin", branch: "main", setUpstream: true });
		expect((await git(bare, "rev-parse", "refs/heads/main")).trim()).toBe((await git(root, "rev-parse", "HEAD")).trim());

		await git(root, "remote", "set-url", "origin", "https://user:secret@example.invalid/repository.git");
		await expect(pushProjectSourceControl({} as any, { remote: "origin", branch: "main", confirm: true }, options)).rejects.toThrow("embedded credentials");
	});

	test("diagnoses effective HTTPS credential helpers without returning URLs, usernames, commands, or secrets", async () => {
		const { root, options } = await createRepository();
		await git(root, "remote", "add", "origin", "https://private.example.invalid/organization/secret-repository.git");
		await git(root, "config", "credential.helper", "");
		await git(root, "config", "--add", "credential.helper", "store");
		await git(root, "config", "--add", "credential.helper", "!credential-command super-secret-helper-argument");
		await git(root, "config", "credential.https://private.example.invalid.helper", "osxkeychain");
		await git(root, "config", "credential.https://private.example.invalid.useHttpPath", "true");
		await git(root, "config", "credential.https://private.example.invalid.username", "secret-user-name");

		const diagnostics = await inspectProjectSourceControlAuthentication({} as any, { remote: "origin" }, options);
		expect(diagnostics).toMatchObject({
			remote: "origin",
			status: "attention",
			contactsRemote: false,
			invokesCredentialProvider: false,
			terminalPromptEnabled: false,
			fetch: { transports: ["https"], embeddedCredentials: false },
			push: { transports: ["https"], embeddedCredentials: false },
		});
		expect(diagnostics.fetch.https[0]).toMatchObject({ useHttpPath: true, usernameConfigured: true });
		expect(diagnostics.fetch.https[0].helpers.map((helper: any) => helper.kind)).toEqual(["store", "custom-command", "osxkeychain"]);
		expect(diagnostics.issues.map((issue: any) => issue.code)).toEqual(expect.arrayContaining(["fetchPlaintextCredentialStore", "fetchCustomCredentialHelper"]));
		const serialized = JSON.stringify(diagnostics);
		for (const secret of ["private.example.invalid", "organization", "secret-repository", "secret-user-name", "credential-command", "super-secret-helper-argument"]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("classifies SSH and local remote authentication without connecting and reports no host or path", async () => {
		const { root, options } = await createRepository();
		await git(root, "remote", "add", "origin", "ssh://git@unreachable-auth-test.invalid/private/repository.git");
		const ssh = await inspectProjectSourceControlAuthentication({} as any, { remote: "origin" }, options);
		expect(ssh.fetch).toMatchObject({ transports: ["ssh"], urlCount: 1, embeddedCredentials: false });
		expect(ssh.push).toMatchObject({ transports: ["ssh"], urlCount: 1, embeddedCredentials: false });
		expect(JSON.stringify(ssh)).not.toContain("unreachable-auth-test.invalid");
		await git(root, "remote", "set-url", "origin", "unreachable-scp-test.invalid:private/repository.git");
		const scpStyle = await inspectProjectSourceControlAuthentication({} as any, { remote: "origin" }, options);
		expect(scpStyle.fetch.transports).toEqual(["ssh"]);
		expect(JSON.stringify(scpStyle)).not.toContain("unreachable-scp-test.invalid");

		const bare = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-auth-local-"));
		temporaryDirectories.push(bare);
		await git(bare, "init", "--bare");
		await git(root, "remote", "set-url", "origin", bare);
		const local = await inspectProjectSourceControlAuthentication({} as any, { remote: "origin" }, options);
		expect(local).toMatchObject({ status: "ready", fetch: { transports: ["local"] }, push: { transports: ["local"] }, issues: [] });
		expect(JSON.stringify(local)).not.toContain(bare);
	});

	test("flags embedded remote credentials without disclosing them and rejects invalid remote names", async () => {
		const { root, options } = await createRepository();
		await git(root, "remote", "add", "origin", "https://leaked-user:leaked-password@example.invalid/private.git");
		const diagnostics = await inspectProjectSourceControlAuthentication({} as any, { remote: "origin" }, options);
		expect(diagnostics).toMatchObject({ status: "attention", fetch: { embeddedCredentials: true }, push: { embeddedCredentials: true } });
		expect(diagnostics.issues.map((issue: any) => issue.code)).toEqual(expect.arrayContaining(["fetchEmbeddedCredentials", "pushEmbeddedCredentials"]));
		expect(JSON.stringify(diagnostics)).not.toMatch(/leaked-user|leaked-password|example\.invalid|private\.git/);
		await expect(inspectProjectSourceControlAuthentication({} as any, { remote: "../origin" }, options)).rejects.toThrow("configured Git remote name");
		await expect(inspectProjectSourceControlAuthentication({} as any, { remote: "missing" }, options)).rejects.toThrow("not configured");
	});

	test("lists refs and manages local branches and annotated tags without forced deletion", async () => {
		const { root, projectRoot, options } = await createRepository();
		expect(await listProjectSourceControlRefs({} as any, {}, options)).toMatchObject({ currentBranch: "main", detached: false, upstream: null, ahead: 0, behind: 0 });

		await expect(createProjectSourceControlBranch({} as any, { name: "feature/lighting", confirm: false }, options)).rejects.toThrow("confirm must be true");
		const createdBranch = await createProjectSourceControlBranch({} as any, { name: "feature/lighting", confirm: true }, options);
		expect(createdBranch.refs.localBranches.map((branch: any) => branch.name)).toContain("feature/lighting");
		await expect(pullProjectSourceControl({} as any, { remote: "origin", branch: "feature/lighting", confirm: true }, options)).rejects.toThrow("only the current branch");

		await writeFile(join(projectRoot, "dirty.txt"), "dirty\n");
		await expect(switchProjectSourceControlBranch({} as any, { name: "feature/lighting", confirm: true }, options)).rejects.toThrow("completely clean");
		await rm(join(projectRoot, "dirty.txt"));
		expect(await switchProjectSourceControlBranch({} as any, { name: "feature/lighting", confirm: true }, options)).toMatchObject({
			switched: true,
			branch: "feature/lighting",
		});
		expect(await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options)).toMatchObject({ switched: true, branch: "main" });
		expect(await deleteProjectSourceControlBranch({} as any, { name: "feature/lighting", confirm: true }, options)).toMatchObject({ deleted: true });

		const createdTag = await createProjectSourceControlTag({} as any, { name: "v1.0.0", message: "First release", confirm: true }, options);
		expect(createdTag).toMatchObject({ created: true, tag: "v1.0.0", annotated: true });
		const refs = await listProjectSourceControlRefs({} as any, {}, options);
		expect(refs.tags).toContainEqual(expect.objectContaining({ name: "v1.0.0", objectType: "tag", subject: "First release" }));
		expect(await deleteProjectSourceControlTag({} as any, { name: "v1.0.0", confirm: true }, options)).toMatchObject({ deleted: true, tag: "v1.0.0" });

		await expect(createProjectSourceControlBranch({} as any, { name: "--orphan", confirm: true }, options)).rejects.toThrow("valid Git branch");
		await expect(createProjectSourceControlTag({} as any, { name: "../escape", confirm: true }, options)).rejects.toThrow("valid Git tag");
		expect((await git(root, "branch", "--show-current")).trim()).toBe("main");
	});

	test("fetches and fast-forward-only pulls from a real bare remote while rejecting dirty worktrees", async () => {
		const { root, projectRoot, options } = await createRepository();
		const bare = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-fetch-remote-"));
		temporaryDirectories.push(bare);
		await git(bare, "init", "--bare");
		await git(root, "remote", "add", "origin", bare);
		await git(root, "push", "--set-upstream", "origin", "main");

		const publisherRoot = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-publisher-"));
		temporaryDirectories.push(publisherRoot);
		const publisher = join(publisherRoot, "checkout");
		await git(publisherRoot, "clone", bare, publisher);
		await git(publisher, "config", "user.name", "Remote Publisher");
		await git(publisher, "config", "user.email", "publisher@example.invalid");
		await writeFile(join(publisher, "src", "game.ts"), "export const version = 6;\n");
		await git(publisher, "add", "src/game.ts");
		await git(publisher, "commit", "-m", "Remote update");
		await git(publisher, "push", "origin", "main");

		await expect(fetchProjectSourceControl({} as any, { remote: "origin", confirm: false }, options)).rejects.toThrow("confirm must be true");
		const fetched = await fetchProjectSourceControl({} as any, { remote: "origin", prune: true, tags: true, confirm: true }, options);
		expect(fetched).toMatchObject({ fetched: true, remote: "origin", prune: true, tags: true, refs: { ahead: 0, behind: 1 } });

		await writeFile(join(projectRoot, "dirty.txt"), "dirty\n");
		await expect(pullProjectSourceControl({} as any, { remote: "origin", branch: "main", confirm: true }, options)).rejects.toThrow("completely clean");
		await rm(join(projectRoot, "dirty.txt"));
		const pulled = await pullProjectSourceControl({} as any, { remote: "origin", branch: "main", confirm: true }, options);
		expect(pulled).toMatchObject({ pulled: true, remote: "origin", branch: "main", status: { clean: true }, refs: { ahead: 0, behind: 0 } });
		expect(await readFile(join(projectRoot, "src", "game.ts"), "utf-8")).toBe("export const version = 6;\n");
	});

	test("rejects repository-wide branch, tag, switch, and pull operations for a nested active project", async () => {
		const { options } = await createRepository(true);
		await expect(createProjectSourceControlBranch({} as any, { name: "feature", confirm: true }, options)).rejects.toThrow("worktree root");
		await expect(switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options)).rejects.toThrow("worktree root");
		await expect(createProjectSourceControlTag({} as any, { name: "v2", confirm: true }, options)).rejects.toThrow("worktree root");
		await expect(pullProjectSourceControl({} as any, { remote: "origin", branch: "main", confirm: true }, options)).rejects.toThrow("worktree root");
	});

	test("reserves repository administration for collaboration admins", async () => {
		const { options } = await createRepository();
		const configured = await configureProjectCollaboration({} as any, { enabled: true, bootstrapAdminName: "Owner" }, options);
		const adminSession = await joinProjectCollaborationSession(
			{} as any,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "Admin CLI" },
			options
		);
		const editor = await createProjectCollaborationMember({} as any, { name: "Builder", role: "editor", collaborationToken: adminSession.session.token }, options);
		const editorSession = await joinProjectCollaborationSession({} as any, { memberId: editor.member.id, accessKey: editor.accessKey, clientName: "Editor CLI" }, options);

		await expect(
			createProjectSourceControlBranch({} as any, { name: "editor-branch", confirm: true, collaborationToken: editorSession.session.token }, options)
		).rejects.toThrow("collaboration admin role");
		await expect(
			createProjectSourceControlBranch({} as any, { name: "admin-branch", confirm: true, collaborationToken: adminSession.session.token }, options)
		).resolves.toMatchObject({ created: true, branch: "admin-branch" });
		await expect(startProjectSourceControlMerge({} as any, { target: "HEAD", confirm: true, collaborationToken: editorSession.session.token }, options)).rejects.toThrow(
			"collaboration admin role"
		);
		await expect(
			publishProjectSourceControlRemoteBranch({} as any, { remote: "origin", localBranch: "main", confirm: true, collaborationToken: editorSession.session.token }, options)
		).rejects.toThrow("collaboration admin role");
		await expect(
			applyProjectSourceControlTextResolution(
				{} as any,
				{ path: "src/game.ts", content: "resolved\n", expectedFingerprint: "0".repeat(64), confirm: true, collaborationToken: editorSession.session.token },
				options
			)
		).rejects.toThrow("collaboration admin role");
	});

	test("previews and explicitly completes a clean no-auto-commit merge", async () => {
		const { root, projectRoot, options } = await createRepository();
		await createProjectSourceControlBranch({} as any, { name: "feature/clean-merge", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/clean-merge", confirm: true }, options);
		await writeFile(join(projectRoot, "feature.txt"), "feature\n");
		await git(root, "add", "feature.txt");
		await git(root, "commit", "-m", "Feature commit");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);

		const preview = await previewProjectSourceControlIntegration({} as any, { target: "feature/clean-merge" }, options);
		expect(preview).toMatchObject({
			relationship: "fastForward",
			currentOnly: 0,
			targetOnly: 1,
			changedFileCount: 1,
			changedFiles: ["feature.txt"],
			projectOwnsWorktree: true,
		});
		await expect(startProjectSourceControlMerge({} as any, { target: "feature/clean-merge", confirm: false }, options)).rejects.toThrow("confirm must be true");

		const started = await startProjectSourceControlMerge({} as any, { target: "feature/clean-merge", confirm: true }, options);
		expect(started).toMatchObject({ started: true, completed: false, integration: { operation: "merge", conflictCount: 0 } });
		expect(await getProjectSourceControlIntegrationState({} as any, {}, options)).toMatchObject({ operation: "merge", conflictCount: 0 });

		const continued = await continueProjectSourceControlIntegration({} as any, { message: "Merge clean feature", confirm: true }, options);
		expect(continued).toMatchObject({ continued: true, completed: true, operation: "merge", integration: { operation: null, conflictCount: 0 } });
		expect((await git(root, "log", "-1", "--format=%s")).trim()).toBe("Merge clean feature");
	});

	test("lists merge conflicts, resolves Git stages, aborts safely, and completes after review", async () => {
		const { root, projectRoot, options } = await createRepository();
		await createProjectSourceControlBranch({} as any, { name: "feature/conflict", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/conflict", confirm: true }, options);
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 'feature';\n");
		await git(root, "add", "src/game.ts");
		await git(root, "commit", "-m", "Feature changes game");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 'main';\n");
		await git(root, "add", "src/game.ts");
		await git(root, "commit", "-m", "Main changes game");

		const firstStart = await startProjectSourceControlMerge({} as any, { target: "feature/conflict", confirm: true }, options);
		expect(firstStart).toMatchObject({ completed: false, integration: { operation: "merge", conflictCount: 1 } });
		expect(firstStart.integration.conflicts[0]).toMatchObject({ path: "src/game.ts", stages: [{ stage: 1 }, { stage: 2 }, { stage: 3 }] });
		await expect(resolveProjectSourceControlConflict({} as any, { path: "src/game.ts", resolution: "ours", confirm: false }, options)).rejects.toThrow("confirm must be true");
		expect(await resolveProjectSourceControlConflict({} as any, { path: "src/game.ts", resolution: "ours", confirm: true }, options)).toMatchObject({
			resolved: true,
			integration: { operation: "merge", conflictCount: 0 },
		});
		expect(await abortProjectSourceControlIntegration({} as any, { confirm: true }, options)).toMatchObject({
			aborted: true,
			operation: "merge",
			integration: { operation: null },
		});
		expect(await readFile(join(projectRoot, "src", "game.ts"), "utf-8")).toBe("export const version = 'main';\n");

		await startProjectSourceControlMerge({} as any, { target: "feature/conflict", confirm: true }, options);
		await resolveProjectSourceControlConflict({} as any, { path: "src/game.ts", resolution: "theirs", confirm: true }, options);
		const completed = await continueProjectSourceControlIntegration({} as any, { message: "Resolve feature conflict", confirm: true }, options);
		expect(completed).toMatchObject({ completed: true, integration: { operation: null } });
		expect(await readFile(join(projectRoot, "src", "game.ts"), "utf-8")).toBe("export const version = 'feature';\n");
	});

	test("stops a conflicting rebase, documents rebase stage semantics, and continues non-interactively", async () => {
		const { root, projectRoot, options } = await createRepository();
		await createProjectSourceControlBranch({} as any, { name: "feature/rebase", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/rebase", confirm: true }, options);
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 'feature-rebase';\n");
		await git(root, "add", "src/game.ts");
		await git(root, "commit", "-m", "Feature rebase commit");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 'main-rebase';\n");
		await git(root, "add", "src/game.ts");
		await git(root, "commit", "-m", "Main rebase commit");
		await switchProjectSourceControlBranch({} as any, { name: "feature/rebase", confirm: true }, options);

		expect(await previewProjectSourceControlIntegration({} as any, { target: "main" }, options)).toMatchObject({ relationship: "diverged", currentOnly: 1, targetOnly: 1 });
		const started = await startProjectSourceControlRebase({} as any, { target: "main", confirm: true }, options);
		expect(started).toMatchObject({ completed: false, integration: { operation: "rebase", conflictCount: 1 } });
		await expect(continueProjectSourceControlIntegration({} as any, { confirm: true }, options)).rejects.toThrow("Resolve all 1 remaining");

		await resolveProjectSourceControlConflict({} as any, { path: "src/game.ts", resolution: "theirs", confirm: true }, options);
		const continued = await continueProjectSourceControlIntegration({} as any, { confirm: true }, options);
		expect(continued).toMatchObject({ continued: true, completed: true, operation: "rebase", integration: { operation: null } });
		expect(await readFile(join(projectRoot, "src", "game.ts"), "utf-8")).toBe("export const version = 'feature-rebase';\n");
		await expect(git(root, "merge-base", "--is-ancestor", "main", "feature/rebase")).resolves.toBe("");
	});

	test("rejects integration starts for nested projects, dirty worktrees, invalid targets, and active operations", async () => {
		const nested = await createRepository(true);
		expect(await previewProjectSourceControlIntegration({} as any, { target: "HEAD" }, nested.options)).toMatchObject({ projectOwnsWorktree: false });
		await expect(startProjectSourceControlMerge({} as any, { target: "HEAD", confirm: true }, nested.options)).rejects.toThrow("worktree root");

		const { root, projectRoot, options } = await createRepository();
		await expect(previewProjectSourceControlIntegration({} as any, { target: "--invalid" }, options)).rejects.toThrow("startPoint must name a valid commit");
		await createProjectSourceControlBranch({} as any, { name: "feature/pending", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/pending", confirm: true }, options);
		await writeFile(join(projectRoot, "feature.txt"), "pending\n");
		await git(root, "add", "feature.txt");
		await git(root, "commit", "-m", "Pending feature");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);
		await writeFile(join(projectRoot, "dirty.txt"), "dirty\n");
		await expect(startProjectSourceControlMerge({} as any, { target: "feature/pending", confirm: true }, options)).rejects.toThrow("completely clean");
		await rm(join(projectRoot, "dirty.txt"));
		await startProjectSourceControlMerge({} as any, { target: "feature/pending", confirm: true }, options);
		await expect(startProjectSourceControlRebase({} as any, { target: "feature/pending", confirm: true }, options)).rejects.toThrow("already in progress");
		await abortProjectSourceControlIntegration({} as any, { confirm: true }, options);
	});

	test("authoritatively inspects, publishes, lease-deletes, and protects remote branches", async () => {
		const { root, projectRoot, options } = await createRepository();
		const bare = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-remote-branch-"));
		temporaryDirectories.push(bare);
		await git(bare, "init", "--bare");
		await git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
		await git(root, "remote", "add", "origin", bare);
		await git(root, "push", "--set-upstream", "origin", "main");

		await createProjectSourceControlBranch({} as any, { name: "feature/remote", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/remote", confirm: true }, options);
		await writeFile(join(projectRoot, "remote-feature.txt"), "remote feature\n");
		await git(root, "add", "remote-feature.txt");
		await git(root, "commit", "-m", "Remote branch feature");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);

		const initial = await inspectProjectSourceControlRemoteRefs({} as any, { remote: "origin" }, options);
		expect(initial).toMatchObject({ remote: "origin", defaultBranch: "main", branchCount: 1, tagCount: 0, branches: [{ name: "main" }] });
		await expect(publishProjectSourceControlRemoteBranch({} as any, { remote: "origin", localBranch: "feature/remote", confirm: false }, options)).rejects.toThrow(
			"confirm must be true"
		);

		const published = await publishProjectSourceControlRemoteBranch(
			{} as any,
			{ remote: "origin", localBranch: "feature/remote", remoteBranch: "review/remote", confirm: true },
			options
		);
		expect(published).toMatchObject({ published: true, remote: "origin", localBranch: "feature/remote", remoteBranch: "review/remote" });
		const review = published.remoteRefs.branches.find((branch: any) => branch.name === "review/remote");
		expect(review.hash).toBe(published.localHash);

		const main = published.remoteRefs.branches.find((branch: any) => branch.name === "main");
		await expect(deleteProjectSourceControlRemoteBranch({} as any, { remote: "origin", branch: "main", expectedHash: main.hash, confirm: true }, options)).rejects.toThrow(
			"default branch"
		);
		await expect(
			deleteProjectSourceControlRemoteBranch({} as any, { remote: "origin", branch: "review/remote", expectedHash: "0".repeat(40), confirm: true }, options)
		).rejects.toThrow("changed since inspection");
		await expect(
			deleteProjectSourceControlRemoteBranch({} as any, { remote: "origin", branch: "review/remote", expectedHash: review.hash, confirm: false }, options)
		).rejects.toThrow("confirm must be true");

		const deleted = await deleteProjectSourceControlRemoteBranch({} as any, { remote: "origin", branch: "review/remote", expectedHash: review.hash, confirm: true }, options);
		expect(deleted).toMatchObject({ deleted: true, branch: "review/remote", remoteRefs: { branchCount: 1 } });
		await expect(git(bare, "show-ref", "--verify", "refs/heads/review/remote")).rejects.toThrow();
	});

	test("publishes immutable remote tags and deletes them only under an exact authoritative lease", async () => {
		const { root, options } = await createRepository();
		const bare = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-remote-tag-"));
		temporaryDirectories.push(bare);
		await git(bare, "init", "--bare");
		await git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
		await git(root, "remote", "add", "origin", bare);
		await git(root, "push", "--set-upstream", "origin", "main");
		await createProjectSourceControlTag({} as any, { name: "release-1", message: "Release one", confirm: true }, options);

		const published = await publishProjectSourceControlRemoteTag({} as any, { remote: "origin", tag: "release-1", confirm: true }, options);
		expect(published).toMatchObject({ published: true, remote: "origin", tag: "release-1" });
		const tag = published.remoteRefs.tags.find((candidate: any) => candidate.name === "release-1");
		expect(tag.hash).toBe(published.localHash);
		await expect(publishProjectSourceControlRemoteTag({} as any, { remote: "origin", tag: "release-1", confirm: true }, options)).resolves.toMatchObject({ published: true });
		await expect(deleteProjectSourceControlRemoteTag({} as any, { remote: "origin", tag: "release-1", expectedHash: "f".repeat(40), confirm: true }, options)).rejects.toThrow(
			"changed since inspection"
		);

		const deleted = await deleteProjectSourceControlRemoteTag({} as any, { remote: "origin", tag: "release-1", expectedHash: tag.hash, confirm: true }, options);
		expect(deleted).toMatchObject({ deleted: true, tag: "release-1", remoteRefs: { tagCount: 0 } });
		await expect(git(bare, "show-ref", "--verify", "refs/tags/release-1")).rejects.toThrow();
	});

	test("inspects complete three-way text details and atomically applies a fingerprint-guarded custom resolution", async () => {
		const { root, projectRoot, options } = await createRepository();
		await createProjectSourceControlBranch({} as any, { name: "feature/custom-text", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/custom-text", confirm: true }, options);
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 'feature-custom';\n");
		await git(root, "add", "src/game.ts");
		await git(root, "commit", "-m", "Feature custom text");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);
		await writeFile(join(projectRoot, "src", "game.ts"), "export const version = 'main-custom';\n");
		await git(root, "add", "src/game.ts");
		await git(root, "commit", "-m", "Main custom text");
		await startProjectSourceControlMerge({} as any, { target: "feature/custom-text", confirm: true }, options);

		const details = await inspectProjectSourceControlConflictDetails({} as any, { path: "src/game.ts" }, options);
		expect(details).toMatchObject({
			operation: "merge",
			path: "src/game.ts",
			textEditable: true,
			base: { stage: 1, binary: false, tooLarge: false, text: "export const version = 1;\n" },
			ours: { stage: 2, binary: false, text: "export const version = 'main-custom';\n" },
			theirs: { stage: 3, binary: false, text: "export const version = 'feature-custom';\n" },
			worktree: { exists: true, binary: false },
		});
		expect(details.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(details.worktree.text).toContain("<<<<<<< HEAD");
		await expect(inspectProjectSourceControlConflictDetails({} as any, { path: "../outside" }, options)).rejects.toThrow("stay inside");
		await expect(
			applyProjectSourceControlTextResolution(
				{} as any,
				{ path: "src/game.ts", content: "export const version = 'resolved';\n", expectedFingerprint: details.fingerprint, confirm: false },
				options
			)
		).rejects.toThrow("confirm must be true");
		await expect(
			applyProjectSourceControlTextResolution(
				{} as any,
				{ path: "src/game.ts", content: "export const version = 'resolved';\n", expectedFingerprint: "0".repeat(64), confirm: true },
				options
			)
		).rejects.toThrow("changed since inspection");

		const worktreeBeforeFailedStage = await readFile(join(projectRoot, "src", "game.ts"));
		await writeFile(join(root, ".git", "index.lock"), "locked\n");
		await expect(
			applyProjectSourceControlTextResolution(
				{} as any,
				{ path: "src/game.ts", content: "export const version = 'not-staged';\n", expectedFingerprint: details.fingerprint, confirm: true },
				options
			)
		).rejects.toThrow("Unable to stage");
		expect(await readFile(join(projectRoot, "src", "game.ts"))).toEqual(worktreeBeforeFailedStage);
		await rm(join(root, ".git", "index.lock"));

		const applied = await applyProjectSourceControlTextResolution(
			{} as any,
			{ path: "src/game.ts", content: "export const version = 'resolved';\n", expectedFingerprint: details.fingerprint, confirm: true },
			options
		);
		expect(applied).toMatchObject({ applied: true, path: "src/game.ts", fingerprint: details.fingerprint, integration: { operation: "merge", conflictCount: 0 } });
		await continueProjectSourceControlIntegration({} as any, { message: "Apply custom text resolution", confirm: true }, options);
		expect(await readFile(join(projectRoot, "src", "game.ts"), "utf-8")).toBe("export const version = 'resolved';\n");
	});

	test("reports binary conflict stages without corrupt decoding and blocks the custom text writer", async () => {
		const { root, projectRoot, options } = await createRepository();
		await writeFile(join(projectRoot, "asset.bin"), Buffer.from([0, 1, 2, 3]));
		await git(root, "add", "asset.bin");
		await git(root, "commit", "-m", "Add binary asset");
		await createProjectSourceControlBranch({} as any, { name: "feature/binary", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/binary", confirm: true }, options);
		await writeFile(join(projectRoot, "asset.bin"), Buffer.from([0, 4, 5, 6]));
		await git(root, "add", "asset.bin");
		await git(root, "commit", "-m", "Feature binary");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);
		await writeFile(join(projectRoot, "asset.bin"), Buffer.from([0, 7, 8, 9]));
		await git(root, "add", "asset.bin");
		await git(root, "commit", "-m", "Main binary");
		await startProjectSourceControlMerge({} as any, { target: "feature/binary", confirm: true }, options);

		const details = await inspectProjectSourceControlConflictDetails({} as any, { path: "asset.bin" }, options);
		expect(details).toMatchObject({
			textEditable: false,
			base: { byteLength: 4, binary: true, text: null },
			ours: { byteLength: 4, binary: true, text: null },
			theirs: { byteLength: 4, binary: true, text: null },
			worktree: { binary: true, text: null },
		});
		await expect(
			applyProjectSourceControlTextResolution({} as any, { path: "asset.bin", content: "not binary", expectedFingerprint: details.fingerprint, confirm: true }, options)
		).rejects.toThrow("binary or exceeds");
		const imageDetails = await inspectProjectSourceControlImageConflict({} as any, { path: "asset.bin" }, options);
		expect(imageDetails).toMatchObject({
			fingerprint: details.fingerprint,
			base: { status: "invalid" },
			ours: { status: "invalid" },
			theirs: { status: "invalid" },
			comparisons: { oursToTheirs: { available: false, comparable: false } },
		});
		expect(JSON.stringify(imageDetails)).not.toContain("imageBase64");
		await abortProjectSourceControlIntegration({} as any, { confirm: true }, options);
	});

	test("decodes bounded raster conflict stages and reports deterministic exact pairwise pixel differences", async () => {
		const { root, projectRoot, options } = await createRepository();
		const red = [255, 0, 0, 255];
		const green = [0, 255, 0, 255];
		const blue = [0, 0, 255, 255];
		const basePixels = [...red, ...red, ...red, ...red];
		const oursPixels = [...green, ...red, ...red, ...red];
		const theirsPixels = [...red, ...red, ...red, ...blue];
		await writeFile(join(projectRoot, "texture.png"), await png(2, 2, basePixels));
		await git(root, "add", "texture.png");
		await git(root, "commit", "-m", "Add base texture");
		await createProjectSourceControlBranch({} as any, { name: "feature/image-conflict", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/image-conflict", confirm: true }, options);
		await writeFile(join(projectRoot, "texture.png"), await png(2, 2, theirsPixels));
		await git(root, "add", "texture.png");
		await git(root, "commit", "-m", "Feature texture pixel");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);
		await writeFile(join(projectRoot, "texture.png"), await png(2, 2, oursPixels));
		await git(root, "add", "texture.png");
		await git(root, "commit", "-m", "Main texture pixel");
		await startProjectSourceControlMerge({} as any, { target: "feature/image-conflict", confirm: true }, options);

		const result = await inspectProjectSourceControlImageConflict({} as any, { path: "texture.png", includePreviews: true }, options);
		expect(result).toMatchObject({
			operation: "merge",
			path: "texture.png",
			includePreviews: true,
			limits: { maximumBlobBytes: 8 * 1024 * 1024, maximumPixels: 4 * 1024 * 1024, previewMaximumDimension: 128 },
			base: { status: "ready", format: "png", width: 2, height: 2, channels: 4, alphaCoverage: 1 },
			ours: { status: "ready", format: "png", width: 2, height: 2 },
			theirs: { status: "ready", format: "png", width: 2, height: 2 },
			comparisons: {
				baseToOurs: { available: true, comparable: true, pixelCount: 4, changedPixels: 1, changedRatio: 0.25, changedBounds: { x: 0, y: 0, width: 1, height: 1 } },
				baseToTheirs: { available: true, comparable: true, pixelCount: 4, changedPixels: 1, changedRatio: 0.25, changedBounds: { x: 1, y: 1, width: 1, height: 1 } },
				oursToTheirs: { available: true, comparable: true, pixelCount: 4, changedPixels: 2, changedRatio: 0.5, changedBounds: { x: 0, y: 0, width: 2, height: 2 } },
			},
		});
		expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		for (const stage of [result.base, result.ours, result.theirs]) {
			expect(stage.pixelSha256).toMatch(/^[a-f0-9]{64}$/);
			const metadata = await sharp(Buffer.from(stage.preview.imageBase64, "base64")).metadata();
			expect(metadata).toMatchObject({ format: "png", width: 2, height: 2 });
		}
		for (const comparison of Object.values(result.comparisons) as any[]) {
			expect(comparison.differencePreview.imageBase64).toBeTruthy();
		}
		const withoutPreviews = await inspectProjectSourceControlImageConflict({} as any, { path: "texture.png", includePreviews: false }, options);
		expect(JSON.stringify(withoutPreviews)).not.toContain("imageBase64");
		expect(withoutPreviews.comparisons.oursToTheirs).toMatchObject({ changedPixels: 2, changedRatio: 0.5 });
		await expect(inspectProjectSourceControlImageConflict({} as any, { path: "../texture.png" }, options)).rejects.toThrow("stay inside");
		await abortProjectSourceControlIntegration({} as any, { confirm: true }, options);
	});

	test("keeps oversized raster-like conflict blobs metadata-only without reading or decoding them", async () => {
		const { root, projectRoot, options } = await createRepository();
		const byteLength = 8 * 1024 * 1024 + 1;
		const base = Buffer.alloc(byteLength, 0);
		await writeFile(join(projectRoot, "oversized.png"), base);
		await git(root, "add", "oversized.png");
		await git(root, "commit", "-m", "Add oversized binary");
		await createProjectSourceControlBranch({} as any, { name: "feature/oversized-image", confirm: true }, options);
		await switchProjectSourceControlBranch({} as any, { name: "feature/oversized-image", confirm: true }, options);
		const theirs = Buffer.from(base);
		theirs[0] = 1;
		await writeFile(join(projectRoot, "oversized.png"), theirs);
		await git(root, "add", "oversized.png");
		await git(root, "commit", "-m", "Feature oversized binary");
		await switchProjectSourceControlBranch({} as any, { name: "main", confirm: true }, options);
		const ours = Buffer.from(base);
		ours[0] = 2;
		await writeFile(join(projectRoot, "oversized.png"), ours);
		await git(root, "add", "oversized.png");
		await git(root, "commit", "-m", "Main oversized binary");
		await startProjectSourceControlMerge({} as any, { target: "feature/oversized-image", confirm: true }, options);

		const result = await inspectProjectSourceControlImageConflict({} as any, { path: "oversized.png" }, options);
		expect(result).toMatchObject({
			base: { status: "too-large", byteLength, maximumBytes: 8 * 1024 * 1024 },
			ours: { status: "too-large", byteLength, maximumBytes: 8 * 1024 * 1024 },
			theirs: { status: "too-large", byteLength, maximumBytes: 8 * 1024 * 1024 },
			comparisons: { oursToTheirs: { available: false, comparable: false } },
		});
		expect(JSON.stringify(result)).not.toContain("imageBase64");
		await abortProjectSourceControlIntegration({} as any, { confirm: true }, options);
	});
});
