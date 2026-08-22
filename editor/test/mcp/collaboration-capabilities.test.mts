import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { getProjectCollaborationCapabilities, validateProjectCollaborationReadiness } from "../../src/mcp/project/collaboration-capabilities";
import { configureProjectCollaboration, joinProjectCollaborationSession } from "../../src/mcp/project/collaboration";

describe("mcp/project/collaboration-capabilities", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-collaboration-capabilities-"));
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

	async function bootstrapAdmin(): Promise<string> {
		const configured = await configureProjectCollaboration(scene, { enabled: true, bootstrapAdminName: "Owner" }, options);
		const joined = await joinProjectCollaborationSession(
			scene,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "Capability Test" },
			options
		);
		return joined.session.token;
	}

	test("reports the exact complete capability and explicit-conflict contract", async () => {
		const result = await getProjectCollaborationCapabilities(scene, {}, options);

		expect(result).toMatchObject({ contractVersion: 1, project: { enforcementEnabled: false, actor: null } });
		expect(result.capabilities).toHaveLength(8);
		expect(result.capabilities.every((entry: any) => entry.state === "complete")).toBe(true);
		expect(result.capabilities.map((entry: any) => entry.id)).toContain("semantic-conflict-resolution");
		expect(result.conflictPolicy.ambiguous).toContain("explicit conflicts");
		expect(result.conflictPolicy.binary).toContain("locks");
		expect(JSON.stringify(result)).not.toMatch(/accessKey|tokenHash|privateKey/i);
	});

	test("distinguishes legacy local access from authenticated and remote readiness", async () => {
		const result = await validateProjectCollaborationReadiness(scene, {}, options);

		expect(result).toMatchObject({
			overall: "setup-required",
			readiness: { legacyLocalEditing: true, authenticatedLocalEditing: false, conflictResolution: true, remoteEditing: false, readOnlyReview: true },
			project: { semanticMergeRuleCount: 0 },
			summary: { errorCount: 0, warningCount: 1, findingCount: 1 },
		});
		expect(result.findings[0].code).toBe("authentication_disabled");
	});

	test("requires an active session after role enforcement is enabled", async () => {
		await bootstrapAdmin();

		const result = await validateProjectCollaborationReadiness(scene, {}, options);
		expect(result.overall).toBe("attention-required");
		expect(result.readiness.authenticatedLocalEditing).toBe(false);
		expect(result.findings).toContainEqual(expect.objectContaining({ code: "session_required", severity: "error" }));
		expect(result.team).toEqual({ members: null, presence: null });
	});

	test("audits authenticated team state and remote transport availability without returning secrets", async () => {
		const collaborationToken = await bootstrapAdmin();

		const result = await validateProjectCollaborationReadiness(scene, { collaborationToken }, options);
		expect(result.overall).toBe("setup-required");
		expect(result.readiness).toMatchObject({ authenticatedLocalEditing: true, conflictResolution: true, remoteEditing: false, readOnlyReview: true });
		expect(result.team.members.total).toBe(1);
		expect(result.team.presence.total).toBe(1);
		expect(result.transports.gateway.running).toBe(false);
		expect(result.transports.relay.connected).toBe(false);
		expect(result.findings).toContainEqual(expect.objectContaining({ code: "remote_transport_inactive", severity: "warning" }));
		expect(JSON.stringify(result)).not.toContain(collaborationToken);
	});

	test("returns actionable evidence when the semantic merge-rule store is malformed", async () => {
		await ensureDir(join(directory, ".babylon-editor"));
		await writeFile(join(directory, ".babylon-editor", "merge-rules.json"), "{broken", "utf-8");

		const result = await validateProjectCollaborationReadiness(scene, {}, options);
		expect(result.overall).toBe("attention-required");
		expect(result.readiness.conflictResolution).toBe(false);
		expect(result.project.semanticMergeRuleCount).toBeNull();
		expect(result.findings).toContainEqual(expect.objectContaining({ code: "semantic_merge_rules_invalid", severity: "error" }));
	});
});
