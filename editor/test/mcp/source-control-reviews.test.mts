import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, test } from "vitest";

import {
	createProjectSourceControlReview,
	getProjectSourceControlReview,
	getProjectSourceControlReviewMetadata,
	getProjectSourceControlReviewProvider,
	listProjectSourceControlReviewChecks,
	listProjectSourceControlReviews,
	mergeProjectSourceControlReview,
	rerunProjectSourceControlReviewChecks,
	setProjectSourceControlReviewMetadata,
	setProjectSourceControlReviewProvider,
	submitProjectSourceControlReview,
} from "../../src/mcp/project/source-control-reviews";
import { configureProjectCollaboration, createProjectCollaborationMember, joinProjectCollaborationSession } from "../../src/mcp/project/collaboration";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const environmentVariables: string[] = [];

async function createProject(): Promise<{ root: string; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-reviews-"));
	temporaryDirectories.push(root);
	await writeFile(join(root, "project.bjseditor"), "{}\n");
	return { root, options: { editor: { state: { projectPath: join(root, "project.bjseditor") } } } as any };
}

async function requestBody(request: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk));
	}
	const text = Buffer.concat(chunks).toString("utf-8");
	return text ? JSON.parse(text) : null;
}

function json(response: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void {
	const body = JSON.stringify(value);
	response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers });
	response.end(body);
}

async function startProvider(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<string> {
	const server = createServer((request, response) => void handler(request, response));
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/`;
}

function setToken(name: string, value: string): void {
	process.env[name] = value;
	environmentVariables.push(name);
}

afterEach(async () => {
	for (const name of environmentVariables.splice(0)) {
		delete process.env[name];
	}
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				})
		)
	);
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("mcp/project/source-control-reviews", () => {
	test("persists only constrained provider metadata and enforces confirmation, containment, and collaboration admin", async () => {
		const { root, options } = await createProject();
		expect(await getProjectSourceControlReviewProvider({} as any, {}, options)).toMatchObject({ enabled: false, provider: "github", tokenConfigured: false });
		await expect(
			setProjectSourceControlReviewProvider(
				{} as any,
				{
					enabled: true,
					provider: "github",
					apiBaseUrl: "https://api.github.com/",
					repository: "acme/game",
					tokenEnvironmentVariable: "TEST_REVIEW_TOKEN",
					confirm: false,
				},
				options
			)
		).rejects.toThrow("confirm must be true");
		await expect(
			setProjectSourceControlReviewProvider(
				{} as any,
				{
					enabled: true,
					provider: "github",
					apiBaseUrl: "https://user:password@example.invalid/",
					repository: "acme/game",
					tokenEnvironmentVariable: "TEST_REVIEW_TOKEN",
					confirm: true,
				},
				options
			)
		).rejects.toThrow("must not contain credentials");
		await expect(
			setProjectSourceControlReviewProvider(
				{} as any,
				{
					enabled: true,
					provider: "gitlab",
					apiBaseUrl: "https://gitlab.example.invalid/",
					repository: "group/game",
					tokenEnvironmentVariable: "TEST_REVIEW_TOKEN",
					confirm: true,
				},
				options
			)
		).rejects.toThrow("end with /api/v4");

		const collaboration = await configureProjectCollaboration({} as any, { enabled: true, bootstrapAdminName: "Admin", confirm: true }, options);
		const admin = await joinProjectCollaborationSession(
			{} as any,
			{ memberId: collaboration.bootstrap.member.id, accessKey: collaboration.bootstrap.accessKey, clientName: "admin-client" },
			options
		);
		const member = await createProjectCollaborationMember({} as any, { name: "Editor", role: "editor", collaborationToken: admin.session.token }, options);
		const editor = await joinProjectCollaborationSession({} as any, { memberId: member.member.id, accessKey: member.accessKey, clientName: "editor-client" }, options);
		await expect(
			setProjectSourceControlReviewProvider(
				{} as any,
				{
					enabled: true,
					provider: "github",
					apiBaseUrl: "https://api.github.com/",
					repository: "acme/game",
					tokenEnvironmentVariable: "TEST_REVIEW_TOKEN",
					confirm: true,
					collaborationToken: editor.session.token,
				},
				options
			)
		).rejects.toThrow("admin role");
		setToken("TEST_REVIEW_TOKEN", "environment-only-provider-token-123456");
		const configured = await setProjectSourceControlReviewProvider(
			{} as any,
			{
				enabled: true,
				provider: "github",
				apiBaseUrl: "https://api.github.com/",
				repository: "acme/game",
				tokenEnvironmentVariable: "TEST_REVIEW_TOKEN",
				confirm: true,
				collaborationToken: admin.session.token,
			},
			options
		);
		expect(configured).toMatchObject({ enabled: true, provider: "github", repository: "acme/game", tokenConfigured: true });
		const stored = await readFile(join(root, ".babylon-editor", "source-control-review-provider.json"), "utf-8");
		expect(stored).toContain("TEST_REVIEW_TOKEN");
		expect(stored).not.toContain("environment-only-provider-token");
		expect(JSON.stringify(configured)).not.toContain("environment-only-provider-token");

		const escaped = await mkdtemp(join(tmpdir(), "babylon-editor-source-control-reviews-escape-"));
		temporaryDirectories.push(escaped);
		const symlinkProject = await createProject();
		await symlink(escaped, join(symlinkProject.root, ".babylon-editor"));
		await expect(
			setProjectSourceControlReviewProvider(
				{} as any,
				{ enabled: false, provider: "github", apiBaseUrl: "https://api.github.com/", tokenEnvironmentVariable: "GITHUB_TOKEN", confirm: true },
				symlinkProject.options
			)
		).rejects.toThrow("must stay inside");
	});

	test("runs bounded GitHub list, detail, create, review, and exact-head leased merge workflows without exposing the token", async () => {
		const { root, options } = await createProject();
		const token = "github-provider-token-never-returned-123456";
		setToken("TEST_GITHUB_REVIEW_TOKEN", token);
		const requests: { method: string; path: string; authorization?: string; body: any }[] = [];
		const headSha = "a".repeat(40);
		let githubReviewers = ["alice"];
		let githubTeams = ["rendering"];
		let githubLabels = ["bug"];
		const review = (number: number, title: string): any => ({
			number,
			title,
			body: "Review body",
			state: "open",
			draft: false,
			user: { login: "reviewer" },
			head: { ref: "feature/rendering", sha: headSha },
			base: { ref: "main", sha: "b".repeat(40) },
			mergeable: true,
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-02T00:00:00Z",
			html_url: "https://example.invalid/acme/game/pull/7",
			requested_reviewers: githubReviewers.map((login) => ({ login })),
			requested_teams: githubTeams.map((slug) => ({ slug })),
			labels: githubLabels.map((name) => ({ name })),
		});
		const api = await startProvider(async (request, response) => {
			const body = await requestBody(request);
			requests.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization, body });
			if (request.method === "GET" && request.url === "/repos/acme/game/pulls?state=open&per_page=2") {
				return json(response, 200, [review(7, "Lighting review")], { link: '<http://127.0.0.1/next>; rel="next"' });
			}
			if (request.method === "GET" && request.url === "/repos/acme/game/pulls?state=closed&per_page=2") {
				return json(response, 401, { message: `denied ${token}` });
			}
			if (request.method === "GET" && request.url === "/repos/acme/game/pulls?state=all&per_page=2") {
				return json(response, 200, { padding: "x".repeat(2 * 1024 * 1024) });
			}
			if (request.method === "GET" && request.url === "/repos/acme/game/pulls/7") {
				return json(response, 200, review(7, "Lighting review"));
			}
			if (request.method === "POST" && request.url === "/repos/acme/game/pulls/7/requested_reviewers") {
				githubReviewers = [...new Set([...githubReviewers, ...(body.reviewers ?? [])])];
				githubTeams = [...new Set([...githubTeams, ...(body.team_reviewers ?? [])])];
				return json(response, 200, review(7, "Lighting review"));
			}
			if (request.method === "DELETE" && request.url === "/repos/acme/game/pulls/7/requested_reviewers") {
				githubReviewers = githubReviewers.filter((name) => !(body.reviewers ?? []).includes(name));
				githubTeams = githubTeams.filter((name) => !(body.team_reviewers ?? []).includes(name));
				return json(response, 200, review(7, "Lighting review"));
			}
			if (request.method === "PUT" && request.url === "/repos/acme/game/issues/7/labels") {
				githubLabels = body.labels;
				return json(
					response,
					200,
					githubLabels.map((name) => ({ name }))
				);
			}
			if (request.method === "GET" && request.url === `/repos/acme/game/commits/${headSha}/check-runs?per_page=50`) {
				return json(response, 200, {
					check_runs: [{ id: 301, name: "Editor tests", status: "completed", conclusion: "success", html_url: "https://example.invalid/check/301" }],
				});
			}
			if (request.method === "GET" && request.url === `/repos/acme/game/actions/runs?head_sha=${headSha}&per_page=50`) {
				return json(response, 200, { workflow_runs: [{ id: 401, name: "CI", status: "completed", conclusion: "failure", head_sha: headSha, run_attempt: 1 }] });
			}
			if (request.method === "POST" && request.url === "/repos/acme/game/actions/runs/401/rerun-failed-jobs") {
				return json(response, 201, {});
			}
			if (request.method === "POST" && request.url === "/repos/acme/game/pulls") {
				return json(response, 201, review(8, body.title));
			}
			if (request.method === "POST" && request.url === "/repos/acme/game/pulls/7/reviews") {
				return json(response, 200, { id: 91, state: body.event });
			}
			if (request.method === "PUT" && request.url === "/repos/acme/game/pulls/7/merge") {
				return json(response, 200, { merged: true, message: "Pull Request successfully merged" });
			}
			return json(response, 404, { message: `Unhandled ${request.method} ${request.url}` });
		});
		await setProjectSourceControlReviewProvider(
			{} as any,
			{ enabled: true, provider: "github", apiBaseUrl: api, repository: "acme/game", tokenEnvironmentVariable: "TEST_GITHUB_REVIEW_TOKEN", confirm: true },
			options
		);

		const listed = await listProjectSourceControlReviews({} as any, { state: "open", limit: 2 }, options);
		expect(listed).toMatchObject({
			provider: "github",
			repository: "acme/game",
			count: 1,
			hasMore: true,
			reviews: [{ number: 7, title: "Lighting review", head: { sha: headSha } }],
		});
		const detail = await getProjectSourceControlReview({} as any, { number: 7 }, options);
		expect(detail.review).toMatchObject({ number: 7, body: "Review body", mergeable: true, head: { ref: "feature/rendering", sha: headSha } });
		const metadata = await getProjectSourceControlReviewMetadata({} as any, { number: 7 }, options);
		expect(metadata).toMatchObject({ reviewers: ["alice"], teams: ["rendering"], labels: ["bug"], headSha });
		await expect(
			setProjectSourceControlReviewMetadata(
				{} as any,
				{ number: 7, expectedFingerprint: "0".repeat(64), reviewers: ["bob"], teams: [], labels: ["ready"], confirm: true },
				options
			)
		).rejects.toThrow("changed since inspection");
		const updatedMetadata = await setProjectSourceControlReviewMetadata(
			{} as any,
			{ number: 7, expectedFingerprint: metadata.fingerprint, reviewers: ["bob"], teams: ["engine"], labels: ["ready"], confirm: true },
			options
		);
		expect(updatedMetadata).toMatchObject({ updated: true, partialMutationPossible: true, metadata: { reviewers: ["bob"], teams: ["engine"], labels: ["ready"] } });
		const checks = await listProjectSourceControlReviewChecks({} as any, { number: 7 }, options);
		expect(checks).toMatchObject({ headSha, summary: { total: 2, succeeded: 1, failed: 1, pending: 0 }, runs: [{ id: 401, headSha }] });
		await expect(
			rerunProjectSourceControlReviewChecks({} as any, { number: 7, expectedHeadSha: "c".repeat(40), runId: 401, mode: "failed", confirm: true }, options)
		).rejects.toThrow("head changed");
		expect(await rerunProjectSourceControlReviewChecks({} as any, { number: 7, expectedHeadSha: headSha, runId: 401, mode: "failed", confirm: true }, options)).toMatchObject({
			accepted: true,
			runId: 401,
			mode: "failed",
		});
		let providerError = "";
		try {
			await listProjectSourceControlReviews({} as any, { state: "closed", limit: 2 }, options);
		} catch (error) {
			providerError = error instanceof Error ? error.message : String(error);
		}
		expect(providerError).toContain("[redacted]");
		expect(providerError).not.toContain(token);
		await expect(listProjectSourceControlReviews({} as any, { state: "all", limit: 2 }, options)).rejects.toThrow("2097152-byte limit");
		await expect(createProjectSourceControlReview({} as any, { title: "New review", head: "feature/rendering", base: "main", confirm: false }, options)).rejects.toThrow(
			"confirm must be true"
		);
		const created = await createProjectSourceControlReview(
			{} as any,
			{ title: "New review", body: "Please review", head: "feature/rendering", base: "main", draft: true, confirm: true },
			options
		);
		expect(created).toMatchObject({ created: true, review: { number: 8, title: "New review" } });
		const submitted = await submitProjectSourceControlReview({} as any, { number: 7, action: "requestChanges", body: "Please fix the shader", confirm: true }, options);
		expect(submitted).toMatchObject({ submitted: true, action: "requestChanges", reviewId: 91, state: "REQUEST_CHANGES" });
		await expect(mergeProjectSourceControlReview({} as any, { number: 7, expectedHeadSha: "c".repeat(40), method: "squash", confirm: true }, options)).rejects.toThrow(
			"head changed"
		);
		const merged = await mergeProjectSourceControlReview(
			{} as any,
			{ number: 7, expectedHeadSha: headSha, method: "squash", commitTitle: "Merge rendering", confirm: true },
			options
		);
		expect(merged).toMatchObject({ merged: true, provider: "github", number: 7, method: "squash", headSha });
		expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
		expect(requests.find((request) => request.path.endsWith("/merge"))?.body).toMatchObject({ sha: headSha, merge_method: "squash", commit_title: "Merge rendering" });
		const serialized = JSON.stringify({ listed, detail, metadata, updatedMetadata, checks, created, submitted, merged });
		expect(serialized).not.toContain(token);
		expect(await readFile(join(root, ".babylon-editor", "source-control-review-provider.json"), "utf-8")).not.toContain(token);
	});

	test("maps GitLab merge requests, approvals, comments, and leased squash merge while rejecting unsupported request-changes/rebase", async () => {
		const { options } = await createProject();
		const token = "gitlab-provider-token-never-returned-123456";
		setToken("TEST_GITLAB_REVIEW_TOKEN", token);
		const requests: { method: string; path: string; token?: string; body: any }[] = [];
		const headSha = "d".repeat(40);
		let gitlabReviewers = ["alice"];
		let gitlabLabels = ["terrain"];
		const review = (iid: number, title: string, state = "opened"): any => ({
			iid,
			title,
			description: "Merge request body",
			state,
			draft: false,
			author: { username: "gitlab-user" },
			source_branch: "feature/terrain",
			target_branch: "main",
			sha: headSha,
			diff_refs: { head_sha: headSha, base_sha: "e".repeat(40) },
			merge_status: "can_be_merged",
			has_conflicts: false,
			created_at: "2026-02-01T00:00:00Z",
			updated_at: "2026-02-02T00:00:00Z",
			web_url: "https://gitlab.example.invalid/group/game/-/merge_requests/3",
			reviewers: gitlabReviewers.map((username) => ({ username })),
			labels: gitlabLabels,
		});
		const apiRoot = await startProvider(async (request, response) => {
			const body = await requestBody(request);
			requests.push({ method: request.method!, path: request.url!, token: request.headers["private-token"] as string | undefined, body });
			if (request.method === "GET" && request.url === "/api/v4/projects/group%2Fgame/merge_requests?state=opened&per_page=5") {
				return json(response, 200, [review(3, "Terrain MR")], { "x-next-page": "" });
			}
			if (request.method === "GET" && request.url === "/api/v4/projects/group%2Fgame/merge_requests/3") {
				return json(response, 200, review(3, "Terrain MR"));
			}
			if (request.method === "GET" && request.url === "/api/v4/users?username=bob") {
				return json(response, 200, [{ id: 72, username: "bob" }]);
			}
			if (request.method === "PUT" && request.url === "/api/v4/projects/group%2Fgame/merge_requests/3") {
				gitlabReviewers = body.reviewer_ids.includes(72) ? ["bob"] : [];
				gitlabLabels = body.labels ? body.labels.split(",") : [];
				return json(response, 200, review(3, "Terrain MR"));
			}
			if (request.method === "GET" && request.url === "/api/v4/projects/group%2Fgame/merge_requests/3/pipelines?per_page=20") {
				return json(response, 200, [{ id: 501, sha: headSha, status: "failed", web_url: "https://gitlab.example.invalid/pipeline/501" }]);
			}
			if (request.method === "GET" && request.url === "/api/v4/projects/group%2Fgame/pipelines/501/jobs?per_page=100") {
				return json(response, 200, [{ id: 601, name: "Build", status: "failed", web_url: "https://gitlab.example.invalid/job/601" }]);
			}
			if (request.method === "POST" && request.url === "/api/v4/projects/group%2Fgame/pipelines/501/retry") {
				return json(response, 201, { id: 501, status: "pending", sha: headSha });
			}
			if (request.method === "POST" && request.url === "/api/v4/projects/group%2Fgame/merge_requests") {
				return json(response, 201, review(4, body.title));
			}
			if (request.method === "POST" && request.url === "/api/v4/projects/group%2Fgame/merge_requests/3/approve") {
				return json(response, 200, { approved: true });
			}
			if (request.method === "POST" && request.url === "/api/v4/projects/group%2Fgame/merge_requests/3/notes") {
				return json(response, 201, { id: 55, body: body.body });
			}
			if (request.method === "PUT" && request.url === "/api/v4/projects/group%2Fgame/merge_requests/3/merge") {
				return json(response, 200, review(3, "Terrain MR", "merged"));
			}
			return json(response, 404, { message: `Unhandled ${request.method} ${request.url}` });
		});
		await setProjectSourceControlReviewProvider(
			{} as any,
			{ enabled: true, provider: "gitlab", apiBaseUrl: `${apiRoot}api/v4/`, repository: "group/game", tokenEnvironmentVariable: "TEST_GITLAB_REVIEW_TOKEN", confirm: true },
			options
		);
		expect(await listProjectSourceControlReviews({} as any, { limit: 5 }, options)).toMatchObject({
			provider: "gitlab",
			count: 1,
			hasMore: false,
			reviews: [{ number: 3, title: "Terrain MR", head: { ref: "feature/terrain", sha: headSha }, base: { ref: "main" } }],
		});
		expect((await getProjectSourceControlReview({} as any, { number: 3 }, options)).review.body).toBe("Merge request body");
		const metadata = await getProjectSourceControlReviewMetadata({} as any, { number: 3 }, options);
		expect(metadata).toMatchObject({ reviewers: ["alice"], teams: [], labels: ["terrain"], headSha });
		await expect(
			setProjectSourceControlReviewMetadata(
				{} as any,
				{ number: 3, expectedFingerprint: metadata.fingerprint, reviewers: ["bob"], teams: ["rendering"], labels: ["ready"], confirm: true },
				options
			)
		).rejects.toThrow("do not support team reviewer");
		const updatedMetadata = await setProjectSourceControlReviewMetadata(
			{} as any,
			{ number: 3, expectedFingerprint: metadata.fingerprint, reviewers: ["bob"], labels: ["ready"], confirm: true },
			options
		);
		expect(updatedMetadata).toMatchObject({ updated: true, partialMutationPossible: false, metadata: { reviewers: ["bob"], teams: [], labels: ["ready"] } });
		const checks = await listProjectSourceControlReviewChecks({} as any, { number: 3 }, options);
		expect(checks).toMatchObject({ headSha, summary: { total: 2, succeeded: 0, failed: 2, pending: 0 }, runs: [{ id: 501, headSha }] });
		await expect(rerunProjectSourceControlReviewChecks({} as any, { number: 3, expectedHeadSha: headSha, runId: 501, mode: "all", confirm: true }, options)).rejects.toThrow(
			"failed/canceled jobs only"
		);
		expect(await rerunProjectSourceControlReviewChecks({} as any, { number: 3, expectedHeadSha: headSha, runId: 501, mode: "failed", confirm: true }, options)).toMatchObject({
			accepted: true,
			provider: "gitlab",
			runId: 501,
		});
		expect(
			await createProjectSourceControlReview(
				{} as any,
				{ title: "Draft terrain", body: "Review", head: "feature/terrain", base: "main", draft: true, confirm: true },
				options
			)
		).toMatchObject({ created: true, review: { number: 4, title: "Draft: Draft terrain" } });
		expect(await submitProjectSourceControlReview({} as any, { number: 3, action: "approve", confirm: true }, options)).toMatchObject({ approved: true });
		expect(await submitProjectSourceControlReview({} as any, { number: 3, action: "comment", body: "Looks good", confirm: true }, options)).toMatchObject({ noteId: 55 });
		await expect(submitProjectSourceControlReview({} as any, { number: 3, action: "requestChanges", body: "Change this", confirm: true }, options)).rejects.toThrow(
			"does not expose"
		);
		await expect(mergeProjectSourceControlReview({} as any, { number: 3, expectedHeadSha: headSha, method: "rebase", confirm: true }, options)).rejects.toThrow(
			"do not expose"
		);
		expect(await mergeProjectSourceControlReview({} as any, { number: 3, expectedHeadSha: headSha, method: "squash", confirm: true }, options)).toMatchObject({
			merged: true,
			provider: "gitlab",
			method: "squash",
		});
		expect(requests.every((request) => request.token === token)).toBe(true);
		expect(requests.find((request) => request.path.endsWith("/merge"))?.body).toMatchObject({ sha: headSha, squash: true, merge_when_pipeline_succeeds: false });
		expect(JSON.stringify(requests.map(({ token: _token, ...request }) => request))).not.toContain(token);
	});

	test("maps Bitbucket Cloud pull requests, UUID reviewers, statuses, review decisions, and leased merge without inventing unsupported labels or reruns", async () => {
		const { options } = await createProject();
		const token = "bitbucket-provider-token-never-returned-123456";
		setToken("TEST_BITBUCKET_REVIEW_TOKEN", token);
		const requests: { method: string; path: string; authorization?: string; body: any }[] = [];
		const headSha = "f".repeat(40);
		const originalReviewer = "{11111111-1111-1111-1111-111111111111}";
		const replacementReviewer = "{22222222-2222-2222-2222-222222222222}";
		let reviewers = [originalReviewer];
		const review = (id: number, title: string, state = "OPEN"): any => ({
			id,
			title,
			description: "Bitbucket review body",
			state,
			author: { nickname: "bitbucket-user", uuid: "{33333333-3333-3333-3333-333333333333}" },
			source: { branch: { name: "feature/vfx" }, commit: { hash: headSha } },
			destination: { branch: { name: "main" }, commit: { hash: "e".repeat(40) } },
			reviewers: reviewers.map((uuid) => ({ uuid })),
			created_on: "2026-03-01T00:00:00Z",
			updated_on: "2026-03-02T00:00:00Z",
			links: { html: { href: "https://bitbucket.example.invalid/acme/game/pull-requests/9" } },
		});
		const apiRoot = await startProvider(async (request, response) => {
			const body = await requestBody(request);
			requests.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization, body });
			const collection = "/2.0/repositories/acme/game/pullrequests";
			if (request.method === "GET" && request.url === `${collection}?state=OPEN&pagelen=5`) {
				return json(response, 200, { values: [review(9, "VFX review")], next: "https://api.bitbucket.org/2.0/next" });
			}
			if (request.method === "GET" && request.url === `${collection}?q=state%3D%22MERGED%22+OR+state%3D%22DECLINED%22+OR+state%3D%22SUPERSEDED%22&pagelen=5`) {
				return json(response, 200, { values: [review(8, "Merged VFX review", "MERGED"), review(7, "Declined VFX review", "DECLINED")] });
			}
			if (request.method === "GET" && request.url === `${collection}/9`) {
				return json(response, 200, review(9, "VFX review"));
			}
			if (request.method === "POST" && request.url === collection) {
				return json(response, 201, review(10, body.title));
			}
			if (request.method === "PUT" && request.url === `${collection}/9`) {
				reviewers = body.reviewers.map((entry: any) => entry.uuid);
				return json(response, 200, review(9, "VFX review"));
			}
			if (request.method === "POST" && request.url === `${collection}/9/comments`) {
				return json(response, 201, { id: 81, content: body.content });
			}
			if (request.method === "POST" && request.url === `${collection}/9/request-changes`) {
				return json(response, 200, { approved: false, state: "changes_requested" });
			}
			if (request.method === "POST" && request.url === `${collection}/9/approve`) {
				return json(response, 200, { approved: true, state: "approved" });
			}
			if (request.method === "GET" && request.url === `${collection}/9/statuses?pagelen=50`) {
				return json(response, 200, {
					values: [
						{ key: "build", name: "Web build", state: "SUCCESSFUL", url: "https://ci.example.invalid/build" },
						{ key: "test", name: "Editor tests", state: "FAILED", url: "https://ci.example.invalid/test" },
					],
				});
			}
			if (request.method === "POST" && request.url === `${collection}/9/merge`) {
				return json(response, 200, review(9, "VFX review", "MERGED"));
			}
			return json(response, 404, { error: { message: `Unhandled ${request.method} ${request.url}` } });
		});
		await setProjectSourceControlReviewProvider(
			{} as any,
			{ enabled: true, provider: "bitbucket", apiBaseUrl: `${apiRoot}2.0/`, repository: "acme/game", tokenEnvironmentVariable: "TEST_BITBUCKET_REVIEW_TOKEN", confirm: true },
			options
		);

		expect(await listProjectSourceControlReviews({} as any, { limit: 5 }, options)).toMatchObject({
			provider: "bitbucket",
			count: 1,
			hasMore: true,
			reviews: [{ number: 9, title: "VFX review", head: { ref: "feature/vfx", sha: headSha }, base: { ref: "main" } }],
		});
		expect(await listProjectSourceControlReviews({} as any, { state: "closed", limit: 5 }, options)).toMatchObject({
			count: 2,
			hasMore: false,
			reviews: [{ state: "merged" }, { state: "closed" }],
		});
		expect((await getProjectSourceControlReview({} as any, { number: 9 }, options)).review.body).toBe("Bitbucket review body");
		const metadata = await getProjectSourceControlReviewMetadata({} as any, { number: 9 }, options);
		expect(metadata).toMatchObject({ reviewers: [originalReviewer], teams: [], labels: [], headSha });
		await expect(
			setProjectSourceControlReviewMetadata(
				{} as any,
				{ number: 9, expectedFingerprint: metadata.fingerprint, reviewers: [replacementReviewer], labels: ["ready"], confirm: true },
				options
			)
		).rejects.toThrow("do not support team reviewer slugs or labels");
		expect(
			await setProjectSourceControlReviewMetadata(
				{} as any,
				{ number: 9, expectedFingerprint: metadata.fingerprint, reviewers: [replacementReviewer], confirm: true },
				options
			)
		).toMatchObject({ updated: true, metadata: { reviewers: [replacementReviewer] } });
		expect(
			await createProjectSourceControlReview({} as any, { title: "New VFX", body: "Please review", head: "feature/vfx", base: "main", draft: true, confirm: true }, options)
		).toMatchObject({ created: true, review: { number: 10, title: "Draft: New VFX" } });
		expect(await submitProjectSourceControlReview({} as any, { number: 9, action: "requestChanges", body: "Fix the graph", confirm: true }, options)).toMatchObject({
			submitted: true,
			action: "requestChanges",
			noteId: 81,
			partialMutationPossible: true,
		});
		expect(await submitProjectSourceControlReview({} as any, { number: 9, action: "approve", confirm: true }, options)).toMatchObject({ approved: true });
		const checks = await listProjectSourceControlReviewChecks({} as any, { number: 9 }, options);
		expect(checks).toMatchObject({ headSha, rerunSupported: false, summary: { total: 2, succeeded: 1, failed: 1, pending: 0 }, runs: [] });
		await expect(rerunProjectSourceControlReviewChecks({} as any, { number: 9, expectedHeadSha: headSha, runId: 1, mode: "failed", confirm: true }, options)).rejects.toThrow(
			"do not expose a portable rerun endpoint"
		);
		await expect(mergeProjectSourceControlReview({} as any, { number: 9, expectedHeadSha: headSha, method: "rebase", confirm: true }, options)).rejects.toThrow(
			"do not expose a rebase"
		);
		expect(
			await mergeProjectSourceControlReview({} as any, { number: 9, expectedHeadSha: headSha, method: "squash", commitTitle: "Merge VFX", confirm: true }, options)
		).toMatchObject({
			merged: true,
			provider: "bitbucket",
			method: "squash",
		});
		expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
		expect(requests.find((request) => request.path.endsWith("/merge"))?.body).toMatchObject({ type: "pullrequest", merge_strategy: "squash", message: "Merge VFX" });
		expect(JSON.stringify(requests.map(({ authorization: _authorization, ...request }) => request))).not.toContain(token);
	});

	test("maps Azure DevOps pull requests, reviewer votes, labels, statuses, policy requeue, and exact-head completion without persisting PAT credentials", async () => {
		const { root, options } = await createProject();
		const token = "azure-devops-pat-never-persisted-123456";
		const expectedAuthorization = `Basic ${Buffer.from(`:${token}`, "utf-8").toString("base64")}`;
		setToken("TEST_AZURE_DEVOPS_PAT", token);
		const requests: { method: string; path: string; authorization?: string; body: any }[] = [];
		const headSha = "1".repeat(40);
		const projectId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
		const authenticatedReviewer = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
		const originalReviewer = "cccccccc-cccc-cccc-cccc-cccccccccccc";
		const replacementReviewer = "dddddddd-dddd-dddd-dddd-dddddddddddd";
		const evaluationId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
		let reviewers = [originalReviewer];
		let labels = [{ id: "label-old", name: "terrain" }];
		const review = (pullRequestId: number, title: string, status = "active"): any => ({
			pullRequestId,
			title,
			description: "Azure review body",
			status,
			isDraft: false,
			createdBy: { displayName: "Azure User", id: authenticatedReviewer },
			sourceRefName: "refs/heads/feature/navmesh",
			targetRefName: "refs/heads/main",
			lastMergeSourceCommit: { commitId: headSha },
			lastMergeTargetCommit: { commitId: "2".repeat(40) },
			mergeStatus: "succeeded",
			creationDate: "2026-04-01T00:00:00Z",
			closedDate: status === "completed" ? "2026-04-02T00:00:00Z" : undefined,
			repository: { project: { id: projectId } },
			reviewers: reviewers.map((id) => ({ id, vote: 0 })),
			labels,
			_links: { web: { href: `https://dev.azure.com/acme/editor/_git/game/pullrequest/${pullRequestId}` } },
		});
		const apiRoot = await startProvider(async (request, response) => {
			const body = await requestBody(request);
			const url = new URL(request.url!, "http://127.0.0.1");
			requests.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization, body });
			const previewPolicy = url.pathname.includes("/_apis/policy/evaluations");
			if (url.searchParams.get("api-version") !== (previewPolicy ? "7.1-preview.1" : "7.1")) {
				return json(response, 400, { message: "Missing Azure API version" });
			}
			const collection = "/acme/editor/_apis/git/repositories/game/pullrequests";
			if (request.method === "GET" && url.pathname === collection) {
				return json(response, 200, { value: [review(12, "NavMesh review")], count: 1 }, { "x-ms-continuationtoken": "next-page" });
			}
			if (request.method === "POST" && url.pathname === collection) {
				return json(response, 201, review(13, body.title));
			}
			if (request.method === "GET" && url.pathname === `${collection}/12`) {
				return json(response, 200, review(12, "NavMesh review"));
			}
			if (request.method === "PATCH" && url.pathname === `${collection}/12`) {
				return json(response, 200, review(12, "NavMesh review", "completed"));
			}
			if (request.method === "PUT" && url.pathname.startsWith(`${collection}/12/reviewers/`)) {
				const reviewerId = decodeURIComponent(url.pathname.split("/").at(-1)!);
				if (body.vote === 0 && !reviewers.includes(reviewerId)) {
					reviewers.push(reviewerId);
				}
				return json(response, 200, { id: reviewerId, vote: body.vote });
			}
			if (request.method === "DELETE" && url.pathname.startsWith(`${collection}/12/reviewers/`)) {
				const reviewerId = decodeURIComponent(url.pathname.split("/").at(-1)!);
				reviewers = reviewers.filter((id) => id !== reviewerId);
				return json(response, 204, {});
			}
			if (request.method === "POST" && url.pathname === `${collection}/12/labels`) {
				labels.push({ id: "label-ready", name: body.name });
				return json(response, 200, labels.at(-1));
			}
			if (request.method === "DELETE" && url.pathname === `${collection}/12/labels/label-old`) {
				labels = labels.filter((label) => label.id !== "label-old");
				return json(response, 204, {});
			}
			if (request.method === "POST" && url.pathname === `${collection}/12/threads`) {
				return json(response, 200, { id: 91, comments: body.comments });
			}
			if (request.method === "GET" && url.pathname === "/acme/_apis/connectionData") {
				return json(response, 200, { authenticatedUser: { id: authenticatedReviewer } });
			}
			if (request.method === "GET" && url.pathname === `${collection}/12/statuses`) {
				return json(response, 200, {
					value: [
						{ id: 1, state: "succeeded", context: { name: "Web build" }, targetUrl: "https://ci.example.invalid/build" },
						{ id: 2, state: "failed", context: { name: "Editor tests" }, targetUrl: "https://ci.example.invalid/test" },
					],
				});
			}
			if (request.method === "GET" && url.pathname === "/acme/editor/_apis/policy/evaluations") {
				return json(response, 200, {
					value: [
						{ evaluationId, status: "rejected", configuration: { type: { displayName: "Required build" } } },
						{ evaluationId: "ffffffff-ffff-ffff-ffff-ffffffffffff", status: "approved", configuration: { type: { displayName: "Reviewers" } } },
					],
				});
			}
			if (request.method === "PATCH" && url.pathname === `/acme/editor/_apis/policy/evaluations/${evaluationId}`) {
				return json(response, 200, { evaluationId, status: body.status });
			}
			return json(response, 404, { message: `Unhandled ${request.method} ${request.url}` });
		});
		const configured = await setProjectSourceControlReviewProvider(
			{} as any,
			{
				enabled: true,
				provider: "azure",
				authenticationMode: "pat",
				apiBaseUrl: apiRoot,
				repository: "acme/editor/game",
				tokenEnvironmentVariable: "TEST_AZURE_DEVOPS_PAT",
				confirm: true,
			},
			options
		);
		expect(configured).toMatchObject({ provider: "azure", authenticationMode: "pat", repository: "acme/editor/game", tokenConfigured: true });
		expect(await listProjectSourceControlReviews({} as any, { limit: 5 }, options)).toMatchObject({
			provider: "azure",
			count: 1,
			hasMore: true,
			reviews: [{ number: 12, title: "NavMesh review", head: { ref: "feature/navmesh", sha: headSha }, base: { ref: "main" } }],
		});
		expect((await getProjectSourceControlReview({} as any, { number: 12 }, options)).review.body).toBe("Azure review body");
		const metadata = await getProjectSourceControlReviewMetadata({} as any, { number: 12 }, options);
		expect(metadata).toMatchObject({ reviewers: [originalReviewer], teams: [], labels: ["terrain"], headSha });
		await expect(
			setProjectSourceControlReviewMetadata(
				{} as any,
				{ number: 12, expectedFingerprint: metadata.fingerprint, reviewers: [replacementReviewer], teams: ["rendering"], labels: ["ready"], confirm: true },
				options
			)
		).rejects.toThrow("leave teams empty");
		expect(
			await setProjectSourceControlReviewMetadata(
				{} as any,
				{ number: 12, expectedFingerprint: metadata.fingerprint, reviewers: [replacementReviewer], labels: ["ready"], confirm: true },
				options
			)
		).toMatchObject({ updated: true, partialMutationPossible: true, metadata: { reviewers: [replacementReviewer], labels: ["ready"] } });
		expect(
			await createProjectSourceControlReview(
				{} as any,
				{ title: "New navmesh", body: "Please review", head: "feature/navmesh", base: "main", draft: true, confirm: true },
				options
			)
		).toMatchObject({ created: true, review: { number: 13, title: "New navmesh" } });
		expect(await submitProjectSourceControlReview({} as any, { number: 12, action: "requestChanges", body: "Fix the agent path", confirm: true }, options)).toMatchObject({
			submitted: true,
			action: "requestChanges",
			noteId: 91,
			state: "rejected",
			partialMutationPossible: true,
		});
		expect(await submitProjectSourceControlReview({} as any, { number: 12, action: "approve", confirm: true }, options)).toMatchObject({ approved: true });
		const checks = await listProjectSourceControlReviewChecks({} as any, { number: 12 }, options);
		expect(checks).toMatchObject({ headSha, summary: { total: 4, succeeded: 2, failed: 2, pending: 0 } });
		expect(checks.runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: evaluationId, headSha })]));
		expect(
			await rerunProjectSourceControlReviewChecks({} as any, { number: 12, expectedHeadSha: headSha, runId: evaluationId, mode: "failed", confirm: true }, options)
		).toMatchObject({
			accepted: true,
			provider: "azure",
			runId: evaluationId,
		});
		expect(
			await mergeProjectSourceControlReview({} as any, { number: 12, expectedHeadSha: headSha, method: "rebase", commitTitle: "Complete navmesh", confirm: true }, options)
		).toMatchObject({ merged: true, provider: "azure", method: "rebase" });
		expect(requests.every((request) => request.authorization === expectedAuthorization)).toBe(true);
		expect(requests.find((request) => request.method === "PATCH" && request.path.includes("pullrequests/12?"))?.body).toMatchObject({
			status: "completed",
			lastMergeSourceCommit: { commitId: headSha },
			completionOptions: { mergeStrategy: "rebase", bypassPolicy: false },
		});
		expect(requests.find((request) => request.method === "PATCH" && request.path.includes(`/policy/evaluations/${evaluationId}?`))?.body).toEqual({ status: "queued" });
		const stored = await readFile(join(root, ".babylon-editor", "source-control-review-provider.json"), "utf-8");
		expect(stored).not.toContain(token);
		expect(stored).not.toContain(expectedAuthorization.split(" ")[1]);
		expect(JSON.stringify(configured)).not.toContain(token);
	});
});
