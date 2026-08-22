import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, readFile, remove, writeFile, writeJSON } from "fs-extra";
import { chmod } from "fs/promises";
import { delimiter } from "path";
import { tmpdir } from "os";
import { join } from "path";
import { NullEngine, Scene } from "babylonjs";

import { applyProjectPackagePlan, listProjectPackages, planProjectPackageChanges } from "../../src/mcp/project/packages";

const fakeNpmSource = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const root = process.cwd();
const manifestPath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (process.env.ZVIBE_FAKE_NPM_FAIL === "1") {
  fs.writeFileSync(manifestPath, JSON.stringify({ corrupted: true }));
  fs.writeFileSync(lockPath, JSON.stringify({ corrupted: true }));
  process.stderr.write("simulated manager failure with token=secret-output");
  process.exit(7);
}
const args = process.argv.slice(2);
const command = args[0];
const groups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
if (command === "uninstall") {
  const name = args[1];
  for (const group of groups) if (manifest[group]) delete manifest[group][name];
} else if (command === "install" || command === "update") {
  const source = args[1];
  let name;
  let version;
  if (source.startsWith("file:")) {
    const localManifest = JSON.parse(fs.readFileSync(path.join(root, source.slice(5), "package.json"), "utf8"));
    name = localManifest.name;
    version = localManifest.version;
  } else {
    const separator = source.lastIndexOf("@");
    name = source.slice(0, separator);
    version = source.slice(separator + 1);
  }
  const group = args.includes("--save-dev") ? "devDependencies" : args.includes("--save-optional") ? "optionalDependencies" : args.includes("--save-peer") ? "peerDependencies" : "dependencies";
  for (const candidate of groups) if (candidate !== group && manifest[candidate]) delete manifest[candidate][name];
  manifest[group] ||= {};
	manifest[group][name] = source.startsWith("file:") ? source : args.includes("--save-exact") ? version : "^" + version;
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");
const packages = { "": { name: manifest.name } };
for (const group of groups) {
  for (const [name, specification] of Object.entries(manifest[group] || {})) {
    const version = String(specification).replace(/^[^0-9]*/, "") || "1.0.0";
    packages["node_modules/" + name] = { name, version };
  }
}
fs.writeFileSync(lockPath, JSON.stringify({ name: manifest.name, lockfileVersion: 3, packages }, null, 2) + "\\n");
process.stdout.write("fake npm completed");
`;

describe("mcp/project-package-plans", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let previousPath: string | undefined;
	let previousFailure: string | undefined;
	const options = { editor: { state: { projectPath: "", packageManager: "npm" }, layout: { inspector: { forceUpdate: () => undefined } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-package-plan-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await writeJSON(join(directory, "package.json"), { name: "plan-game", dependencies: { alpha: "^1.0.0" } });
		await writeJSON(join(directory, "package-lock.json"), {
			name: "plan-game",
			lockfileVersion: 3,
			packages: { "": { name: "plan-game" }, "node_modules/alpha": { name: "alpha", version: "1.0.0" } },
		});
		const bin = join(directory, "bin");
		await ensureDir(bin);
		await writeFile(join(bin, "npm"), fakeNpmSource);
		await chmod(join(bin, "npm"), 0o755);
		previousPath = process.env.PATH;
		previousFailure = process.env.ZVIBE_FAKE_NPM_FAIL;
		process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
		delete process.env.ZVIBE_FAKE_NPM_FAIL;
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousFailure === undefined) delete process.env.ZVIBE_FAKE_NPM_FAIL;
		else process.env.ZVIBE_FAKE_NPM_FAIL = previousFailure;
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	test("plans and applies a confirmed exact bulk update/install transaction", async () => {
		const before = await listProjectPackages(scene, {}, options);
		const plan = await planProjectPackageChanges(
			scene,
			{
				expectedFingerprint: before.fingerprint,
				changes: [
					{ operation: "update", name: "alpha", version: "1.2.0" },
					{ operation: "install", name: "bravo", version: "2.0.0", dependencyType: "devDependencies" },
				],
			},
			options
		);
		expect(plan).toMatchObject({
			packageManager: "npm",
			sourceFingerprint: before.fingerprint,
			changes: [
				{ operation: "update", name: "alpha" },
				{ operation: "install", name: "bravo" },
			],
		});
		expect(await readFile(join(directory, "package.json"), "utf8")).not.toContain("bravo");
		await expect(applyProjectPackagePlan(scene, { planId: plan.id, expectedFingerprint: plan.sourceFingerprint }, options)).rejects.toThrow(/confirm must be true/);
		const result = await applyProjectPackagePlan(scene, { planId: plan.id, expectedFingerprint: plan.sourceFingerprint, confirm: true }, options);
		expect(result).toMatchObject({ applied: true, beforeFingerprint: before.fingerprint, afterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), rollback: null });
		expect(result.processes).toHaveLength(2);
		expect(result.processes.every((processResult: any) => processResult.status === "succeeded")).toBe(true);
		const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
		expect(manifest.dependencies.alpha).toBe("1.2.0");
		expect(manifest.devDependencies.bravo).toBe("2.0.0");
		expect(result.files).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "package.json", changed: true }), expect.objectContaining({ path: "package-lock.json", changed: true })])
		);
	});

	test("rejects stale package plans without replacing external changes", async () => {
		const before = await listProjectPackages(scene, {}, options);
		const plan = await planProjectPackageChanges(
			scene,
			{ expectedFingerprint: before.fingerprint, changes: [{ operation: "update", name: "alpha", version: "1.1.0" }] },
			options
		);
		await writeJSON(join(directory, "package.json"), { name: "plan-game", dependencies: { alpha: "^1.0.0", external: "1.0.0" } });
		await expect(applyProjectPackagePlan(scene, { planId: plan.id, expectedFingerprint: plan.sourceFingerprint, confirm: true }, options)).rejects.toThrow(
			/changed after planning/
		);
		expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).dependencies.external).toBe("1.0.0");
	});

	test("restores package.json and lockfiles exactly after a manager failure", async () => {
		const manifestBefore = await readFile(join(directory, "package.json"));
		const lockBefore = await readFile(join(directory, "package-lock.json"));
		const before = await listProjectPackages(scene, {}, options);
		const plan = await planProjectPackageChanges(
			scene,
			{ expectedFingerprint: before.fingerprint, changes: [{ operation: "update", name: "alpha", version: "1.3.0" }] },
			options
		);
		process.env.ZVIBE_FAKE_NPM_FAIL = "1";
		await expect(applyProjectPackagePlan(scene, { planId: plan.id, expectedFingerprint: plan.sourceFingerprint, confirm: true }, options)).rejects.toThrow(/restored exactly/);
		expect(await readFile(join(directory, "package.json"))).toEqual(manifestBefore);
		expect(await readFile(join(directory, "package-lock.json"))).toEqual(lockBefore);
	});

	test("requires explicit workspace-root mutation permission", async () => {
		const workspace = join(directory, "workspace");
		const project = join(workspace, "packages", "game");
		await ensureDir(project);
		await writeJSON(join(workspace, "package.json"), { private: true, workspaces: ["packages/*"] });
		await writeJSON(join(workspace, "package-lock.json"), { lockfileVersion: 3, packages: {} });
		await writeJSON(join(project, "package.json"), { name: "workspace-game", dependencies: { alpha: "^1.0.0" } });
		options.editor.state.projectPath = join(project, "Game.bjseditor");
		const before = await listProjectPackages(scene, {}, options);
		await expect(
			planProjectPackageChanges(scene, { expectedFingerprint: before.fingerprint, changes: [{ operation: "update", name: "alpha", version: "1.1.0" }] }, options)
		).rejects.toThrow(/allowWorkspaceRoot=true/);
		expect(
			await planProjectPackageChanges(
				scene,
				{ expectedFingerprint: before.fingerprint, allowWorkspaceRoot: true, changes: [{ operation: "update", name: "alpha", version: "1.1.0" }] },
				options
			)
		).toMatchObject({ workspace: { allowWorkspaceRoot: true } });
	});

	test("validates local, Git, tarball, duplicates, and exact registry versions", async () => {
		const local = join(directory, "assets", "local-package");
		await ensureDir(local);
		await writeJSON(join(local, "package.json"), { name: "local-pkg", version: "1.0.0" });
		const before = await listProjectPackages(scene, {}, options);
		const localPlan = await planProjectPackageChanges(
			scene,
			{ expectedFingerprint: before.fingerprint, changes: [{ operation: "install", name: "local-pkg", source: { type: "local", path: "assets/local-package" } }] },
			options
		);
		expect(localPlan.changes[0]).toMatchObject({ source: { type: "local", display: "assets/local-package" }, command: expect.stringContaining("file:assets/local-package") });
		await expect(
			planProjectPackageChanges(scene, { expectedFingerprint: before.fingerprint, changes: [{ operation: "install", name: "missing-version" }] }, options)
		).rejects.toThrow(/exact semantic version/);
		await expect(
			planProjectPackageChanges(
				scene,
				{
					expectedFingerprint: before.fingerprint,
					changes: [{ operation: "install", name: "git-pkg", source: { type: "git", url: "https://user:secret@example.test/repo.git" } }],
				},
				options
			)
		).rejects.toThrow(/credential-free/);
		await expect(
			planProjectPackageChanges(
				scene,
				{
					expectedFingerprint: before.fingerprint,
					changes: [
						{ operation: "install", name: "same", version: "1.0.0" },
						{ operation: "install", name: "same", version: "1.1.0" },
					],
				},
				options
			)
		).rejects.toThrow(/appears more than once/);
	});
});
