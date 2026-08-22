import { execFile } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { createProjectAssetLockRule, deleteProjectAssetLockRule, listProjectAssetLockRules, setProjectAssetLockRule } from "../../src/mcp/project/asset-lock-rules";
import { acquireProjectAssetLock, inspectProjectAssetLockPolicy, listProjectAssetLocks, releaseProjectAssetLock } from "../../src/mcp/project/asset-locks";
import { configureProjectCollaboration, createProjectCollaborationMember, joinProjectCollaborationSession } from "../../src/mcp/project/collaboration";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf-8" });
	return result.stdout;
}

describe("mcp/project Smart Lock rules", () => {
	let root: string;
	let options: any;
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "babylon-editor-smart-lock-"));
		await git(root, "init", "-b", "main");
		await git(root, "config", "user.name", "Babylon Editor Test");
		await git(root, "config", "user.email", "editor-test@example.invalid");
		await mkdir(join(root, "assets", "characters"), { recursive: true });
		await writeFile(join(root, "project.bjseditor"), "{}\n");
		await writeFile(join(root, "assets", "characters", "hero.prefab"), '{"health":100}\n');
		await git(root, "add", "-A");
		await git(root, "commit", "-m", "Initial project");
		options = { editor: { state: { projectPath: join(root, "project.bjseditor") } } } as any;
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		await rm(root, { recursive: true, force: true });
	});

	test("persists ordered wildcard policies with atomic CRUD and strict matching", async () => {
		const first = await createProjectAssetLockRule(
			scene,
			{ name: "Serialized Assets", pathPattern: "assets/**/*.prefab", destinationBranch: "main", retention: "untilMerged" },
			options
		);
		const second = await createProjectAssetLockRule(
			scene,
			{ name: "Textures", pathPattern: "assets/textures/*.png", destinationBranch: "release", destinationRemote: "origin", retention: "manual" },
			options
		);
		expect(await listProjectAssetLockRules(scene, { path: "assets/characters/hero.prefab" }, options)).toMatchObject({
			total: 2,
			rules: [{ id: first.rule.id, name: "Serialized Assets" }],
		});
		await expect(setProjectAssetLockRule(scene, { id: second.rule.id, name: "Raster Textures", enabled: false, destinationRemote: null }, options)).resolves.toMatchObject({
			updated: true,
			rule: { name: "Raster Textures", enabled: false, destinationRemote: null },
		});
		await expect(createProjectAssetLockRule(scene, { name: "serialized assets", pathPattern: "*.prefab", destinationBranch: "main" }, options)).rejects.toThrow(
			"already exists"
		);
		await expect(createProjectAssetLockRule(scene, { name: "Unsafe", pathPattern: "../*.prefab", destinationBranch: "main" }, options)).rejects.toThrow(
			"safe project-relative"
		);
		await expect(listProjectAssetLockRules(scene, { path: "../hero.prefab" }, options)).rejects.toThrow("safe project-relative path");
		await expect(deleteProjectAssetLockRule(scene, { id: second.rule.id }, options)).resolves.toMatchObject({ deleted: true });
		expect((await listProjectAssetLockRules(scene, {}, options)).rules).toHaveLength(1);
	});

	test("requires exact clean destination-fresh evidence and retains the lock until its branch is merged", async () => {
		const path = "assets/characters/hero.prefab";
		await git(root, "switch", "-c", "feature/hero");
		await createProjectAssetLockRule(scene, { name: "Prefabs", pathPattern: "assets/**/*.prefab", destinationBranch: "main", retention: "untilMerged" }, options);

		const policy = await inspectProjectAssetLockPolicy(scene, { path }, options);
		expect(policy).toMatchObject({
			smartLockRequired: true,
			matchedRuleCount: 1,
			freshness: { currentBranch: "feature/hero", destinationBranch: "main", containsDestination: true, pathClean: true, fresh: true },
		});
		await expect(acquireProjectAssetLock(scene, { path, owner: "Alice" }, options)).rejects.toThrow("expectedHeadHash is required");
		const acquired = await acquireProjectAssetLock(
			scene,
			{ path, owner: "Alice", expectedHeadHash: policy.freshness.headHash, expectedDestinationHash: policy.freshness.destinationHash },
			options
		);
		expect(acquired).toMatchObject({
			acquired: true,
			smartLockRequired: true,
			lock: {
				smartLock: {
					acquisitionBranch: "feature/hero",
					destinationBranch: "main",
					retention: "untilMerged",
					acquisitionAssetHash: policy.freshness.headAssetHash,
					destinationAssetHash: policy.freshness.destinationAssetHash,
				},
			},
		});

		await writeFile(join(root, path), '{"health":80}\n');
		const storage = join(root, ".babylon-editor", "asset-locks");
		const storedLockPath = join(storage, `${createHash("sha256").update(path).digest("hex")}.lock.json`);
		const storedLock = JSON.parse(await readFile(storedLockPath, "utf-8"));
		await writeFile(storedLockPath, `${JSON.stringify({ ...storedLock, expiresAt: new Date(0).toISOString() }, null, "\t")}\n`);
		await expect(
			acquireProjectAssetLock(scene, { path, owner: "Bob", expectedHeadHash: policy.freshness.headHash, expectedDestinationHash: policy.freshness.destinationHash }, options)
		).resolves.toMatchObject({ acquired: false, retained: true, conflict: { owner: "Alice" } });
		expect(await listProjectAssetLocks(scene, {}, options)).toMatchObject({ retainedPolicyCount: 1, locks: [{ path, expired: true, retainedByPolicy: true }] });

		expect(await inspectProjectAssetLockPolicy(scene, { path }, options)).toMatchObject({ retention: { retained: true, releaseReady: false, pathClean: false } });
		await expect(releaseProjectAssetLock(scene, { path, lockId: acquired.lock.lockId }, options)).rejects.toThrow("retained until feature/hero is clean");
		await git(root, "add", path);
		await git(root, "commit", "-m", "Edit hero");
		expect(await inspectProjectAssetLockPolicy(scene, { path }, options)).toMatchObject({
			retention: { retained: true, releaseReady: false, pathClean: true, acquisitionMergedToDestination: false },
		});

		await git(root, "switch", "main");
		await git(root, "merge", "--no-ff", "feature/hero", "-m", "Merge hero");
		expect(await inspectProjectAssetLockPolicy(scene, { path }, options)).toMatchObject({
			retention: { retained: false, releaseReady: true, acquisitionMergedToDestination: true },
		});
		await expect(releaseProjectAssetLock(scene, { path, lockId: acquired.lock.lockId }, options)).resolves.toMatchObject({
			released: true,
			retention: { acquisitionMergedToDestination: true },
		});
	});

	test("rejects dirty or destination-stale acquisition and stale exact revision evidence", async () => {
		const path = "assets/characters/hero.prefab";
		await git(root, "switch", "-c", "feature/stale");
		await git(root, "switch", "main");
		await writeFile(join(root, "main-only.txt"), "new destination revision\n");
		await git(root, "add", "main-only.txt");
		await git(root, "commit", "-m", "Advance main");
		await git(root, "switch", "feature/stale");
		await createProjectAssetLockRule(scene, { name: "Prefabs", pathPattern: "assets/**/*.prefab", destinationBranch: "main" }, options);

		const stale = await inspectProjectAssetLockPolicy(scene, { path }, options);
		expect(stale.freshness).toMatchObject({ containsDestination: false, pathClean: true, fresh: false });
		await expect(
			acquireProjectAssetLock(scene, { path, owner: "Alice", expectedHeadHash: stale.freshness.headHash, expectedDestinationHash: stale.freshness.destinationHash }, options)
		).rejects.toThrow("does not contain destination");

		await git(root, "merge", "main", "--no-edit");
		const fresh = await inspectProjectAssetLockPolicy(scene, { path }, options);
		await writeFile(join(root, "feature-note.txt"), "advance head\n");
		await git(root, "add", "feature-note.txt");
		await git(root, "commit", "-m", "Advance feature after inspection");
		await expect(
			acquireProjectAssetLock(scene, { path, owner: "Alice", expectedHeadHash: fresh.freshness.headHash, expectedDestinationHash: fresh.freshness.destinationHash }, options)
		).rejects.toThrow("revisions changed");

		const current = await inspectProjectAssetLockPolicy(scene, { path }, options);
		await writeFile(join(root, path), '{"health":60}\n');
		await expect(
			acquireProjectAssetLock(
				scene,
				{ path, owner: "Alice", expectedHeadHash: current.freshness.headHash, expectedDestinationHash: current.freshness.destinationHash },
				options
			)
		).rejects.toThrow("requires assets/characters/hero.prefab to be clean");
	});

	test("quarantines malformed persisted policy state instead of silently applying it", async () => {
		await mkdir(join(root, ".babylon-editor"), { recursive: true });
		await writeFile(join(root, ".babylon-editor", "asset-lock-rules.json"), "{broken", "utf-8");
		await expect(listProjectAssetLockRules(scene, {}, options)).rejects.toThrow("contains invalid JSON");
	});

	test("refuses a symlinked policy store during read-only inspection", async () => {
		await symlink(join(root, "assets"), join(root, ".babylon-editor"));
		await expect(listProjectAssetLockRules(scene, {}, options)).rejects.toThrow("cannot be a symbolic link");
	});

	test("reserves Smart Lock policy mutation for collaboration administrators", async () => {
		const configured = await configureProjectCollaboration(scene, { enabled: true, bootstrapAdminName: "Owner" }, options);
		const admin = await joinProjectCollaborationSession(
			scene,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "Admin CLI" },
			options
		);
		const member = await createProjectCollaborationMember(scene, { name: "Builder", role: "editor", collaborationToken: admin.session.token }, options);
		const editor = await joinProjectCollaborationSession(scene, { memberId: member.member.id, accessKey: member.accessKey, clientName: "Editor CLI" }, options);
		await expect(
			createProjectAssetLockRule(scene, { name: "Denied", pathPattern: "assets/**/*.prefab", destinationBranch: "main", collaborationToken: editor.session.token }, options)
		).rejects.toThrow("collaboration admin role");
		await expect(
			createProjectAssetLockRule(scene, { name: "Allowed", pathPattern: "assets/**/*.prefab", destinationBranch: "main", collaborationToken: admin.session.token }, options)
		).resolves.toMatchObject({ created: true });

		const acquired = await acquireProjectAssetLock(scene, { path: "project.bjseditor", collaborationToken: admin.session.token }, options);
		await expect(releaseProjectAssetLock(scene, { path: "project.bjseditor", force: true }, options)).rejects.toThrow("collaboration admin role");
		await expect(releaseProjectAssetLock(scene, { path: "project.bjseditor", force: true, collaborationToken: editor.session.token }, options)).rejects.toThrow(
			"collaboration admin role"
		);
		await expect(releaseProjectAssetLock(scene, { path: "project.bjseditor", force: true, collaborationToken: admin.session.token }, options)).resolves.toMatchObject({
			released: true,
			forced: true,
			lock: { lockId: acquired.lock.lockId },
		});
	});
});
