import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ensureDir, pathExists, remove, writeJSON } from "fs-extra";
import { NullEngine, Scene } from "babylonjs";

import { getConsoleServerConfiguration, setConsoleServerConfiguration } from "../../src/mcp/server/configuration";
import {
	executeConsoleServerWorkflowPlan,
	generateServerDeploymentArtifacts,
	getConsoleServerCapabilities,
	getConsoleServerJob,
	getServerDeploymentArtifacts,
	listConsoleProviders,
	planConsoleServerWorkflow,
	removeServerDeploymentArtifacts,
	shutdownConsoleServerWorkflows,
	validateConsoleServerTarget,
} from "../../src/mcp/server/workflow";
import { createBuildProfile } from "../../src/mcp/project/export";
import { generatePlatformScaffold } from "../../src/mcp/project/platforms";
import { createDefaultProjectSettings } from "../../src/project/settings";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

async function waitForJob(scene: Scene, jobId: string): Promise<any> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const job = getConsoleServerJob(scene, { jobId }) as any;
		if (["succeeded", "failed", "canceled"].includes(job.status)) return job;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for Console & Server job ${jobId}.`);
}

describe("mcp/console and production server workflows", () => {
	let directory: string;
	let scene: Scene;
	let options: any;

	beforeEach(async () => {
		clearUndoRedo();
		directory = await mkdtemp(join(tmpdir(), "zvibe-console-server-"));
		await ensureDir(join(directory, "assets/example.scene"));
		await writeJSON(join(directory, "package.json"), { name: "server-game", private: true, scripts: { build: 'node -e "process.exit(0)"' } }, { spaces: "\t" });
		await writeFile(join(directory, "project.bjseditor"), "{}", "utf8");
		await symlink(join(process.cwd(), "../node_modules"), join(directory, "node_modules"), "dir");
		scene = new Scene(new NullEngine());
		options = {
			editor: {
				state: {
					projectPath: join(directory, "project.bjseditor"),
					packageManager: "yarn",
					lastOpenedScenePath: join(directory, "assets/example.scene"),
					sceneBuildSettings: { scenes: [{ path: "assets/example.scene", enabled: true }] },
					projectSettings: createDefaultProjectSettings("Server Game"),
				},
				layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() }, consoleServer: { forceUpdate: vi.fn() } },
			},
		};
	});

	afterEach(async () => {
		shutdownConsoleServerWorkflows();
		clearUndoRedo();
		scene.dispose();
		await remove(directory);
	});

	test("authors strict exact-revision configuration with Undo/Redo", () => {
		expect(getConsoleServerConfiguration(scene)).toMatchObject({ version: 1, revision: 1, deployment: { provider: "local" }, headless: { maximumPlayers: 64 } });
		expect(() => setConsoleServerConfiguration(scene, { expectedRevision: 1, changes: { headless: { port: 80 } } }, options)).toThrow("1024 to 65535");
		const configured = setConsoleServerConfiguration(
			scene,
			{ expectedRevision: 1, changes: { headless: { port: 8123, maximumPlayers: 32 }, container: { image: "registry.example/game/server:stable" } } },
			options
		);
		expect(configured).toMatchObject({ revision: 2, headless: { port: 8123, maximumPlayers: 32 }, container: { image: "registry.example/game/server:stable" } });
		undo();
		expect(getConsoleServerConfiguration(scene)).toMatchObject({ revision: 1, headless: { port: 7777 } });
		redo();
		expect(getConsoleServerConfiguration(scene)).toMatchObject({ revision: 2, headless: { port: 8123 } });
	});

	test("loads strict provider manifests while isolating malformed providers", async () => {
		await ensureDir(join(directory, ".zvibe/console-providers"));
		await writeJSON(
			join(directory, ".zvibe/console-providers/acme.json"),
			{
				version: 1,
				id: "acme-console",
				name: "Acme Console",
				vendor: "Acme",
				platforms: ["acme-devkit"],
				hostPlatforms: [process.platform],
				credentialEnvironments: ["ACME_TOKEN"],
				operations: { build: { executable: "acme-cli", args: ["build", "--project", "${PROJECT}"] }, certify: { executable: "acme-cli", args: ["certify", "${OUTPUT}"] } },
			},
			{ spaces: "\t" }
		);
		await writeJSON(join(directory, ".zvibe/console-providers/unsafe.json"), {
			version: 1,
			id: "unsafe",
			name: "Unsafe",
			vendor: "Unsafe",
			platforms: ["unsafe"],
			hostPlatforms: [],
			credentialEnvironments: [],
			operations: { build: { executable: "/bin/sh", args: ["-c", "anything"] } },
		});
		await symlink(join(directory, ".zvibe/console-providers/acme.json"), join(directory, ".zvibe/console-providers/symlink.json"));
		const result = (await listConsoleProviders(scene, {}, options)) as any;
		expect(result.providers).toMatchObject([{ id: "acme-console", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: expect.stringContaining("symlink.json"), error: expect.stringContaining("regular JSON file") }),
				expect.objectContaining({ path: expect.stringContaining("unsafe.json"), error: expect.stringContaining("basename") }),
			])
		);
		expect(JSON.stringify(result)).not.toContain(process.env.ACME_TOKEN ?? "definitely-not-present");
	});

	test("rejects a symlinked provider directory", async () => {
		const target = join(directory, "provider-target");
		await ensureDir(target);
		await ensureDir(join(directory, ".zvibe"));
		await symlink(target, join(directory, ".zvibe/console-providers"), "dir");
		const result = (await listConsoleProviders(scene, {}, options)) as any;
		expect(result.providers).toEqual([]);
		expect(result.errors).toEqual([
			expect.objectContaining({ path: ".zvibe/console-providers", error: expect.stringContaining("project-contained directory without symlinks") }),
		]);
	});

	test("generates hash-owned Kubernetes artifacts and detects tampering", async () => {
		const scaffold = await generatePlatformScaffold(scene, { target: "headless", expectedRevision: 0 }, options);
		createBuildProfile(scene, { expectedRevision: 0, id: "server", name: "Server", target: "headless", enabled: true });
		const created = (await generateServerDeploymentArtifacts(
			scene,
			{ expectedRevision: 0, expectedConfigurationRevision: 1, expectedScaffoldRevision: scaffold.revision },
			options
		)) as any;
		expect(created).toMatchObject({ exists: true, revision: 1, integrity: true });
		expect(await pathExists(join(directory, ".zvibe/server/deployment.yaml"))).toBe(true);
		expect(await readFile(join(directory, ".zvibe/server/deployment.yaml"), "utf8")).toContain("zvibe-server-secrets");
		await writeFile(join(directory, ".zvibe/server/deployment.yaml"), "tampered", "utf8");
		expect(await getServerDeploymentArtifacts(scene, {}, options)).toMatchObject({ revision: 1, integrity: false });
		await expect(
			generateServerDeploymentArtifacts(scene, { expectedRevision: 1, expectedConfigurationRevision: 1, expectedScaffoldRevision: scaffold.revision }, options)
		).rejects.toThrow("modified or removed");
		await expect(removeServerDeploymentArtifacts(scene, { expectedRevision: 1, confirm: true }, options)).rejects.toThrow("forceModified=true");
		expect(await removeServerDeploymentArtifacts(scene, { expectedRevision: 1, confirm: true, forceModified: true }, options)).toMatchObject({ removed: true, revision: 1 });
		expect(await getServerDeploymentArtifacts(scene, {}, options)).toMatchObject({ exists: false, revision: 0 });
	});

	test("validates, creates a single-use plan, executes, and retains redacted bounded evidence", async () => {
		const scaffold = await generatePlatformScaffold(scene, { target: "headless", expectedRevision: 0 }, options);
		createBuildProfile(scene, { expectedRevision: 0, id: "server", name: "Server", target: "headless", enabled: true });
		const artifacts = (await generateServerDeploymentArtifacts(
			scene,
			{ expectedRevision: 0, expectedConfigurationRevision: 1, expectedScaffoldRevision: scaffold.revision },
			options
		)) as any;
		await ensureDir(join(directory, "dist/headless"));
		await writeFile(join(directory, "dist/headless/server.mjs"), "export const valid = true;\n", "utf8");
		const validation = (await validateConsoleServerTarget(scene, {}, options)) as any;
		expect(validation).toMatchObject({ valid: true, scaffold: { integrity: true }, artifacts: { integrity: true }, profile: { target: "headless" } });
		expect(getConsoleServerCapabilities()).toMatchObject({
			mcpToolCount: 19,
			headless: { serverAuthoritativeWebSocket: true },
			consoleProviders: { fixedNoShellCommands: true },
		});
		const plan = (await planConsoleServerWorkflow(
			scene,
			{ operation: "validate", expectedConfigurationRevision: 1, expectedScaffoldRevision: scaffold.revision, expectedArtifactsRevision: artifacts.revision },
			options
		)) as any;
		await expect(executeConsoleServerWorkflowPlan(scene, { planId: plan.id, confirm: false }, options)).rejects.toThrow("confirm=true");
		const started = (await executeConsoleServerWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)) as any;
		const completed = await waitForJob(scene, started.id);
		expect(completed).toMatchObject({ operation: "validate", provider: "local", status: "succeeded", exitCode: 0 });
		expect(completed.commands).toEqual([expect.objectContaining({ executable: "node", args: ["--check", join(directory, "dist/headless/server.mjs")] })]);
		await expect(executeConsoleServerWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)).rejects.toThrow("already consumed");
	});
});
