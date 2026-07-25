import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { addPrefabReviewComment, inspectPrefabReview, listPrefabReviews, setPrefabReview, submitPrefabReviewDecision } from "../../src/mcp/prefabs/reviews";
import { configureProjectCollaboration, createProjectCollaborationMember, joinProjectCollaborationSession } from "../../src/mcp/project/collaboration";
import { projectConfiguration } from "../../src/project/configuration";

function prefab(position = 0): any {
	return {
		version: 5,
		producer: { name: "Prefab review test", version: "1" },
		metadata: { babylonEditorPrefab: { version: 1, rootName: "Root", rootClassName: "Mesh" } },
		meshes: [
			{
				name: "Root",
				id: "root",
				type: "Mesh",
				position: [position, 0, 0],
				rotation: [0, 0, 0],
				scaling: [1, 1, 1],
				visibility: 1,
				isVisible: true,
			},
		],
	};
}

describe("mcp/prefabs revision-bound reviews", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-editor-prefab-reviews-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		options.editor.state.projectPath = projectConfiguration.path;
		await writeFile(projectConfiguration.path, "{}\n");
		await writeFile(join(directory, "hero.prefab"), `${JSON.stringify(prefab(), null, "\t")}\n`);
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await rm(directory, { recursive: true, force: true });
	});

	test("keeps ownership, comments, review requests, and approvals separate from runtime Prefab content", async () => {
		const beforeBytes = await readFile(join(directory, "hero.prefab"), "utf-8");
		const missing = await inspectPrefabReview(scene, { path: "hero.prefab" }, options);
		expect(missing).toMatchObject({ exists: false, path: "hero.prefab" });

		const draft = await setPrefabReview(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: missing.fingerprint,
				title: "Hero gameplay review",
				reviewers: [{ id: "reviewer", name: "Gameplay Reviewer" }],
				action: "saveDraft",
				actorId: "owner",
				actorName: "Prefab Owner",
				confirm: true,
			},
			options
		);
		expect(draft.review).toMatchObject({ state: "draft", round: 0, owner: { id: "owner" }, approval: { status: "pending" } });

		const request = await setPrefabReview(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: draft.review.fingerprint,
				expectedPrefabRevision: draft.review.currentRevision,
				title: "Hero gameplay review",
				reviewers: [{ id: "reviewer", name: "Gameplay Reviewer" }],
				action: "requestReview",
				actorId: "owner",
				actorName: "Prefab Owner",
				confirm: true,
			},
			options
		);
		expect(request.review).toMatchObject({ state: "inReview", round: 1, stale: false, approval: { status: "pending" } });

		const commented = await addPrefabReviewComment(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: request.review.fingerprint,
				expectedPrefabRevision: request.review.currentRevision,
				body: "Transform and component setup look correct.",
				actorId: "reviewer",
				actorName: "Gameplay Reviewer",
				confirm: true,
			},
			options
		);
		expect(commented.comment).toMatchObject({ author: { id: "reviewer" }, round: 1, prefabRevision: request.review.currentRevision });

		const approved = await submitPrefabReviewDecision(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: commented.review.fingerprint,
				expectedPrefabRevision: commented.review.currentRevision,
				decision: "approve",
				body: "Approved for integration.",
				actorId: "reviewer",
				actorName: "Gameplay Reviewer",
				confirm: true,
			},
			options
		);
		expect(approved.review.approval).toMatchObject({ status: "approved", decisions: [{ reviewer: { id: "reviewer" }, decision: "approve" }] });
		expect(await readFile(join(directory, "hero.prefab"), "utf-8")).toBe(beforeBytes);
		expect(JSON.parse(await readFile(join(directory, ".babylon-editor", "prefab-reviews.json"), "utf-8"))).toMatchObject({ version: 1 });
	});

	test("automatically stales approval after any Prefab revision change and requires a new exact review round", async () => {
		const missing = await inspectPrefabReview(scene, { path: "hero.prefab" }, options);
		const request = await setPrefabReview(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: missing.fingerprint,
				expectedPrefabRevision: missing.currentRevision,
				title: "Revision lease",
				reviewers: [{ id: "reviewer", name: "Reviewer" }],
				action: "requestReview",
				actorId: "owner",
				actorName: "Owner",
				confirm: true,
			},
			options
		);
		const approved = await submitPrefabReviewDecision(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: request.review.fingerprint,
				expectedPrefabRevision: request.review.currentRevision,
				decision: "approve",
				actorId: "reviewer",
				actorName: "Reviewer",
				confirm: true,
			},
			options
		);
		await writeFile(join(directory, "hero.prefab"), `${JSON.stringify(prefab(4), null, "\t")}\n`);
		const stale = await inspectPrefabReview(scene, { path: "hero.prefab" }, options);
		expect(stale.review).toMatchObject({ stale: true, approval: { status: "stale" }, round: 1 });
		await expect(
			submitPrefabReviewDecision(
				scene,
				{
					path: "hero.prefab",
					expectedReviewFingerprint: approved.review.fingerprint,
					expectedPrefabRevision: stale.review.currentRevision,
					decision: "approve",
					actorId: "reviewer",
					actorName: "Reviewer",
					confirm: true,
				},
				options
			)
		).rejects.toThrow("stale");

		const reopened = await setPrefabReview(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: stale.review.fingerprint,
				expectedPrefabRevision: stale.review.currentRevision,
				title: "Revision lease",
				reviewers: [{ id: "reviewer", name: "Reviewer" }],
				action: "requestReview",
				actorId: "owner",
				actorName: "Owner",
				confirm: true,
			},
			options
		);
		expect(reopened.review).toMatchObject({ stale: false, round: 2, approval: { status: "pending" } });
		expect(reopened.review.decisions).toHaveLength(1);
	});

	test("rejects stale concurrent metadata leases and paginates the project review queue", async () => {
		const missing = await inspectPrefabReview(scene, { path: "hero.prefab" }, options);
		const draft = await setPrefabReview(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: missing.fingerprint,
				title: "Concurrent comments",
				reviewers: [],
				action: "saveDraft",
				actorId: "owner",
				actorName: "Owner",
				confirm: true,
			},
			options
		);
		const attempts = await Promise.allSettled([
			addPrefabReviewComment(
				scene,
				{
					path: "hero.prefab",
					expectedReviewFingerprint: draft.review.fingerprint,
					expectedPrefabRevision: draft.review.currentRevision,
					body: "First",
					actorId: "one",
					actorName: "One",
					confirm: true,
				},
				options
			),
			addPrefabReviewComment(
				scene,
				{
					path: "hero.prefab",
					expectedReviewFingerprint: draft.review.fingerprint,
					expectedPrefabRevision: draft.review.currentRevision,
					body: "Second",
					actorId: "two",
					actorName: "Two",
					confirm: true,
				},
				options
			),
		]);
		expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((entry) => entry.status === "rejected")).toHaveLength(1);
		const listed = await listPrefabReviews(scene, { offset: 0, limit: 1 }, options);
		expect(listed).toMatchObject({ total: 1, count: 1, hasMore: false, reviews: [{ path: "hero.prefab" }] });
	});

	test("uses authoritative collaboration identities and allows only assigned reviewers to decide", async () => {
		const configured = await configureProjectCollaboration(scene, { enabled: true, bootstrapAdminName: "Admin" }, options);
		const admin = await joinProjectCollaborationSession(
			scene,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "Admin test" },
			options
		);
		const createdReviewer = await createProjectCollaborationMember(scene, { name: "Art Reviewer", role: "viewer", collaborationToken: admin.session.token }, options);
		const reviewer = await joinProjectCollaborationSession(
			scene,
			{ memberId: createdReviewer.member.id, accessKey: createdReviewer.accessKey, clientName: "Review test" },
			options
		);
		const missing = await inspectPrefabReview(scene, { path: "hero.prefab" }, options);
		const request = await setPrefabReview(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: missing.fingerprint,
				expectedPrefabRevision: missing.currentRevision,
				title: "Collaboration review",
				reviewers: [{ id: createdReviewer.member.id, name: "Spoofed name" }],
				action: "requestReview",
				collaborationToken: admin.session.token,
				confirm: true,
			},
			options
		);
		expect(request.review.reviewers).toEqual([{ id: createdReviewer.member.id, name: "Art Reviewer" }]);
		await expect(
			submitPrefabReviewDecision(
				scene,
				{
					path: "hero.prefab",
					expectedReviewFingerprint: request.review.fingerprint,
					expectedPrefabRevision: request.review.currentRevision,
					decision: "approve",
					collaborationToken: admin.session.token,
					confirm: true,
				},
				options
			)
		).rejects.toThrow("assigned reviewer");
		const approved = await submitPrefabReviewDecision(
			scene,
			{
				path: "hero.prefab",
				expectedReviewFingerprint: request.review.fingerprint,
				expectedPrefabRevision: request.review.currentRevision,
				decision: "approve",
				collaborationToken: reviewer.session.token,
				confirm: true,
			},
			options
		);
		expect(approved.review.approval.status).toBe("approved");
	});
});
