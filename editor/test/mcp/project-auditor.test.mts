import { tmpdir } from "os";
import { join } from "path/posix";
import { symlink } from "fs/promises";
import { mkdtemp, mkdir, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import {
	applyProjectAuditorFix,
	cancelProjectAudit,
	getProjectAudit,
	getProjectAuditorCapabilities,
	getProjectAuditorState,
	listProjectAuditIssues,
	shutdownProjectAuditor,
	startProjectAudit,
} from "../../src/mcp/project/auditor";
import { readAssetMetadata, rebuildAssetRegistry, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";
import { compileScript } from "../../src/tools/compile";
import { analyzeSerializationSource } from "../../src/tools/serialization-diagnostics";

async function waitForAudit(scene: Scene, id: string): Promise<any> {
	for (let attempt = 0; attempt < 500; attempt++) {
		const result = getProjectAudit(scene, { id });
		if (["completed", "cancelled", "failed"].includes(result.job.status)) {
			return result;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Project audit did not reach a terminal state.");
}

describe("asynchronous Project Auditor and serialization diagnostics", () => {
	let directory: string;
	let scene: Scene;
	let engine: NullEngine;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-project-auditor-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeJSON(projectConfiguration.path, {});
		await writeJSON(join(directory, "tsconfig.json"), { compilerOptions: { target: "ES2022", module: "ESNext", experimentalDecorators: true } });
		await mkdir(join(directory, "src"), { recursive: true });
		await mkdir(join(directory, "assets"), { recursive: true });
		await mkdir(join(directory, "scene", "particleSystems"), { recursive: true });
		await writeFile(
			join(directory, "src", "component.ts"),
			'import { guiFromAsset, visibleAsNumber } from "babylonjs-editor-tools";\nexport class Component {\n @visibleAsNumber() public broken: string = "fast";\n @guiFromAsset<Component>("ui.gui") public ui: unknown;\n}\n'
		);
		await writeFile(join(directory, "assets", "particle.png"), Buffer.from([137, 80, 78, 71]));
		await writeJSON(join(directory, "scene", "particleSystems", "particles.json"), { id: "particles", name: "Particles", textureName: "assets/particle.png" });
		await writeJSON(join(directory, "assets", "wasteful-atlas.json"), {
			frames: { hero: { frame: { x: 0, y: 0, w: 10, h: 10 } } },
			meta: { image: "particle.png", size: { w: 100, h: 100 } },
		});
		const texturePath = join(directory, "assets", "particle.png");
		const metadata = await readAssetMetadata(texturePath);
		metadata.importer = { ...metadata.importer, settings: { ...metadata.importer.settings, readable: true } };
		await writeAssetMetadata(texturePath, metadata);
		await rebuildAssetRegistry();
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		shutdownProjectAuditor(scene);
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("accepts compatible scalar and collection serialization declarations", () => {
		const diagnostics = analyzeSerializationSource(
			'class Valid { @visibleAsNumber() public speed: number = 1; @visibleAsArray("string") public names: string[] = []; }',
			"src/valid.ts"
		);
		expect(diagnostics).toEqual([]);
	});

	test("reports deterministic compile-time errors for incompatible, static, and non-null-union fields", () => {
		const diagnostics = analyzeSerializationSource(
			'class Invalid { @visibleAsNumber() public static speed: string = "x"; @visibleAsBoolean() public flag: boolean | number = true; }',
			"src/invalid.ts"
		);
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining(["SER1002", "SER1004", "SER1006"]));
		expect(diagnostics.every((diagnostic) => diagnostic.line > 0 && diagnostic.column > 0)).toBe(true);
	});

	test("blocks the real project script emitter before incompatible serialized code is emitted", async () => {
		await expect(compileScript({ entryPoints: [join(directory, "src", "component.ts")], outfile: join(directory, ".bjseditor", "invalid.cjs") })).rejects.toThrow("SER1006");
	});

	test("runs all analyzer categories asynchronously and returns serialization, future API, texture, and atlas findings", async () => {
		await writeFile(join(directory, "src", "same-name-local.ts"), "export function guiFromAsset(): void {}\nguiFromAsset();\n");
		const before = getProjectAuditorState(scene);
		const started = startProjectAudit(scene, { expectedRevision: before.revision }, { editor: {} } as any);
		expect(["queued", "running"]).toContain(started.job.status);
		const completed = await waitForAudit(scene, started.job.id);
		expect(completed.job.status, completed.job.error).toBe("completed");
		const page = listProjectAuditIssues(scene, { id: started.job.id, expectedJobRevision: completed.job.revision, offset: 0, limit: 100 });
		expect(page.issues.map((issue: any) => issue.code)).toEqual(expect.arrayContaining(["SER1006", "PA2002", "PA3001", "PA4001"]));
		expect(page.issues.filter((issue: any) => issue.code === "PA2002")).toHaveLength(1);
		expect(completed.job.issuesFingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("keeps issue pagination stable under an exact job revision and rejects stale readers", async () => {
		const started = startProjectAudit(scene, { expectedRevision: getProjectAuditorState(scene).revision }, { editor: {} } as any);
		const completed = await waitForAudit(scene, started.job.id);
		const first = listProjectAuditIssues(scene, { id: started.job.id, expectedJobRevision: completed.job.revision, limit: 1, offset: 0 });
		expect(first.limit).toBe(1);
		expect(first.totalCount).toBeGreaterThan(1);
		expect(first.hasMore).toBe(true);
		expect(() => listProjectAuditIssues(scene, { id: started.job.id, expectedJobRevision: completed.job.revision - 1 })).toThrow(
			`expectedJobRevision ${completed.job.revision}`
		);
	});

	test("supports category/severity/search filters without exposing internal fix payloads", async () => {
		const started = startProjectAudit(scene, { expectedRevision: getProjectAuditorState(scene).revision }, { editor: {} } as any);
		const completed = await waitForAudit(scene, started.job.id);
		const page = listProjectAuditIssues(scene, {
			id: started.job.id,
			expectedJobRevision: completed.job.revision,
			category: "particle-texture-readability",
			severity: "warning",
			search: "particle",
		});
		expect(page.issues).toHaveLength(1);
		expect(page.issues[0]).toMatchObject({ code: "PA3001", fixAvailable: true });
		expect(page.issues[0]).not.toHaveProperty("fix");
	});

	test("applies the exact safe texture-importer fix and resolves only the leased issue", async () => {
		const sourceBytes = await readFile(join(directory, "assets", "particle.png"));
		const started = startProjectAudit(scene, { expectedRevision: getProjectAuditorState(scene).revision }, { editor: {} } as any);
		const completed = await waitForAudit(scene, started.job.id);
		const page = listProjectAuditIssues(scene, {
			id: started.job.id,
			expectedJobRevision: completed.job.revision,
			category: "particle-texture-readability",
		});
		const issue = page.issues[0];
		const state = getProjectAuditorState(scene);
		const result = await applyProjectAuditorFix(
			scene,
			{
				id: started.job.id,
				issueId: issue.id,
				expectedIssueFingerprint: issue.fingerprint,
				expectedRevision: state.revision,
				expectedJobRevision: completed.job.revision,
				confirm: true,
			},
			{ editor: {} } as any
		);
		expect(result.issue.resolvedAt).toBeTruthy();
		expect((await readAssetMetadata(join(directory, "assets", "particle.png"))).importer.settings.readable).toBe(false);
		const sidecar = await readJSON(join(directory, "assets", "particle.png.bjsmeta.json"));
		expect(sidecar.importer.settings.readable).toBe(false);
		expect(await readFile(join(directory, "assets", "particle.png"))).toEqual(sourceBytes);
	});

	test("rejects stale, unconfirmed, and unsupported issue fixes", async () => {
		const started = startProjectAudit(scene, { expectedRevision: getProjectAuditorState(scene).revision }, { editor: {} } as any);
		const completed = await waitForAudit(scene, started.job.id);
		const page = listProjectAuditIssues(scene, { id: started.job.id, expectedJobRevision: completed.job.revision, limit: 100 });
		const fixable = page.issues.find((issue: any) => issue.fixAvailable);
		const unsupported = page.issues.find((issue: any) => !issue.fixAvailable);
		const state = getProjectAuditorState(scene);
		await expect(
			applyProjectAuditorFix(
				scene,
				{
					id: started.job.id,
					issueId: fixable.id,
					expectedIssueFingerprint: fixable.fingerprint,
					expectedRevision: state.revision,
					expectedJobRevision: completed.job.revision,
					confirm: false,
				},
				{ editor: {} } as any
			)
		).rejects.toThrow("confirm=true");
		await expect(
			applyProjectAuditorFix(
				scene,
				{
					id: started.job.id,
					issueId: unsupported.id,
					expectedIssueFingerprint: unsupported.fingerprint,
					expectedRevision: state.revision,
					expectedJobRevision: completed.job.revision,
					confirm: true,
				},
				{ editor: {} } as any
			)
		).rejects.toThrow("no automatic fix");
	});

	test("rejects source symlink escape, then cancels queued/running work cooperatively with no project mutation", async () => {
		const externalDirectory = await mkdtemp(join(tmpdir(), "zvibe-project-auditor-external-"));
		const externalSource = join(externalDirectory, "external.ts");
		const linkedSource = join(directory, "src", "external.ts");
		await writeFile(externalSource, "export const escaped = true;\n");
		await symlink(externalSource, linkedSource);
		const rejected = startProjectAudit(scene, { expectedRevision: getProjectAuditorState(scene).revision }, { editor: {} } as any);
		const failed = await waitForAudit(scene, rejected.job.id);
		expect(failed.job.status).toBe("failed");
		expect(failed.job.error).toContain("refused a symlink that resolves outside the project");
		await remove(linkedSource);
		await remove(externalDirectory);
		for (let index = 0; index < 96; index++) {
			await writeFile(join(directory, "src", `extra-${index}.ts`), `export const value${index}: number = ${index};\n`);
		}
		const started = startProjectAudit(scene, { expectedRevision: getProjectAuditorState(scene).revision }, { editor: {} } as any);
		const current = getProjectAuditorState(scene);
		const cancelled = cancelProjectAudit(scene, { id: started.job.id, expectedRevision: current.revision }, { editor: {} } as any);
		expect(cancelled.job.cancelRequested).toBeUndefined();
		const terminal = await waitForAudit(scene, started.job.id);
		expect(terminal.job.status).toBe("cancelled");
		expect((await readAssetMetadata(join(directory, "assets", "particle.png"))).importer.settings.readable).toBe(true);
	});

	test("publishes the permanent editor capability and every strict renderer endpoint", () => {
		const featureFlags = getEditorCapabilities(null as any, {}, {
			editor: { state: { projectPath: projectConfiguration.path, enableExperimentalFeatures: false } },
		} as any).features;
		expect(featureFlags).toMatchObject({
			compileTimeSerializationDiagnostics: true,
			asynchronousProjectAuditor: true,
			projectAuditorParticleTextureReadability: true,
			projectAuditorObsoleteApis: true,
			projectAuditorAtlasWaste: true,
		});
		for (const endpoint of [
			"get_project_auditor_capabilities",
			"get_project_auditor_state",
			"start_project_audit",
			"get_project_audit",
			"list_project_audit_issues",
			"cancel_project_audit",
			"apply_project_auditor_fix",
		]) {
			expect(MCPEndpoints[endpoint]).toBeTypeOf("function");
		}
		expect(getProjectAuditorCapabilities()).toMatchObject({ model: "zvibe-project-auditor-v1", asynchronous: true });
	});
});
