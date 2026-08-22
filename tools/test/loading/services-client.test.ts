import { describe, expect, test, vi } from "vitest";

import { ProjectServiceError, ProjectServicesClient } from "../../src/loading/services-client";
import { projectServiceCategories, servicesConfigurationVersion } from "../../src/loading/services";

function configuration(endpoint = "https://services.example.test/base/"): any {
	const service = { enabled: true, provider: "rest", endpoint, options: {} };
	return { version: servicesConfigurationVersion, environment: "staging", ...Object.fromEntries(projectServiceCategories.map((category) => [category, service])) };
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("loading/services-client", () => {
	test("authenticates in memory and sends bounded authenticated requests to the active environment", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ playerId: "player-1", profile: "qa", expiresAt: "2030-01-01T00:00:00.000Z", accessToken: "abcdefghijklmnop" }))
			.mockResolvedValueOnce(jsonResponse({ items: [{ key: "level", value: 7, revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" }] }));
		const client = new ProjectServicesClient(configuration(), { fetch: fetchMock as typeof fetch });

		expect(await client.signInAnonymously("qa")).toMatchObject({ playerId: "player-1", profile: "qa" });
		expect(await client.writeCloudSave([{ key: "level", value: 7, expectedRevision: 0 }])).toHaveLength(1);
		const [url, request] = fetchMock.mock.calls[1];
		expect(String(url)).toBe("https://services.example.test/base/v1/cloud-save");
		expect(request.headers).toMatchObject({ Authorization: "Bearer abcdefghijklmnop", "X-Zvibe-Environment": "staging" });
	});

	test("covers analytics, catalogs, ads, purchases, and matchmaking with focused routes", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ playerId: "p1", profile: "default", expiresAt: "2030-01-01T00:00:00.000Z", accessToken: "abcdefghijklmnop" }))
			.mockResolvedValueOnce(jsonResponse({ accepted: 1, rejected: 0 }))
			.mockResolvedValueOnce(jsonResponse({ products: [] }))
			.mockResolvedValueOnce(jsonResponse({ placements: [] }))
			.mockResolvedValueOnce(jsonResponse({ orderId: "order-1" }))
			.mockResolvedValueOnce(jsonResponse({ id: "ticket-1", queue: "ranked", status: "searching", createdAt: "2030-01-01T00:00:00.000Z" }));
		const client = new ProjectServicesClient(configuration(), { fetch: fetchMock as typeof fetch });
		await client.signInAnonymously();
		expect(await client.recordAnalyticsEvents([{ name: "levelCompleted", parameters: { level: 2 } }])).toEqual({ accepted: 1, rejected: 0 });
		expect(await client.listIapProducts()).toEqual([]);
		expect(await client.listAdPlacements()).toEqual([]);
		expect(await client.purchaseProduct("coins", "purchase_123")).toMatchObject({ orderId: "order-1" });
		expect(await client.createMatchTicket("ranked", { skill: 7 })).toMatchObject({ id: "ticket-1", status: "searching" });
		expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
			"/base/v1/auth/anonymous",
			"/base/v1/analytics/events",
			"/base/v1/iap/products",
			"/base/v1/ads/placements",
			"/base/v1/iap/purchases",
			"/base/v1/matchmaking/tickets",
		]);
	});

	test("rejects disabled services, invalid inputs, oversized bodies, provider errors, malformed JSON, and timeouts", async () => {
		const disabled = configuration();
		disabled.analytics.enabled = false;
		const client = new ProjectServicesClient(disabled, { fetch: vi.fn() as typeof fetch, timeoutMs: 100 });
		await expect(client.recordAnalyticsEvents([{ name: "gameStarted" }])).rejects.toMatchObject({ code: "service_disabled" });
		const insecure = new ProjectServicesClient(configuration("http://services.example.test/"), { fetch: vi.fn() as typeof fetch });
		await expect(insecure.listIapProducts()).rejects.toMatchObject({ code: "invalid_endpoint" });
		await expect(client.writeCloudSave([])).rejects.toThrow("1–100");
		await expect(client.writeCloudSave([{ key: "bad key", value: 1 }])).rejects.toThrow("Cloud Save key");
		await expect(client.writeCloudSave([{ key: "large", value: "x".repeat(1024 * 1024) }])).rejects.toThrow("at most 1048576 bytes");
		await expect(client.deleteCloudSave([{ key: "score", expectedRevision: -1 }])).rejects.toThrow("expectedRevision");
		await expect(client.recordAnalyticsEvents([{ name: "valid", parameters: { nested: {} as any } }])).rejects.toThrow("finite scalar values");
		expect(() => client.adoptSession({ playerId: "p1", profile: "bad profile", expiresAt: "2030-01-01T00:00:00.000Z" }, "abcdefghijklmnop")).toThrow("session is malformed");

		const provider = new ProjectServicesClient(configuration(), {
			fetch: vi.fn().mockResolvedValue(jsonResponse({ error: "revision mismatch", code: "conflict" }, 409)) as typeof fetch,
		});
		provider.adoptSession({ playerId: "p1", profile: "qa", expiresAt: "2030-01-01T00:00:00.000Z" }, "abcdefghijklmnop");
		await expect(provider.readCloudSave()).rejects.toMatchObject({ category: "cloudSave", status: 409, code: "conflict" });

		const malformed = new ProjectServicesClient(configuration(), { fetch: vi.fn().mockResolvedValue(new Response("not-json")) as typeof fetch });
		await expect(malformed.listIapProducts()).rejects.toMatchObject({ code: "malformed_response" });

		const timeout = new ProjectServicesClient(configuration(), {
			timeoutMs: 100,
			fetch: vi.fn((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch,
		});
		await expect(timeout.listIapProducts()).rejects.toEqual(expect.objectContaining({ code: "timeout" }) as ProjectServiceError);
	});

	test("covers Leaderboards, Remote Config, Cloud Content Delivery, and Cloud Functions routes", async () => {
		const score = { playerId: "p1", score: 42, rank: 1, metadata: { level: 3 }, updatedAt: "2030-01-01T00:00:00.000Z" };
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ playerId: "p1", profile: "default", expiresAt: "2030-01-01T00:00:00.000Z", accessToken: "abcdefghijklmnop" }))
			.mockResolvedValueOnce(jsonResponse(score))
			.mockResolvedValueOnce(jsonResponse({ leaderboardId: "career", offset: 0, limit: 20, total: 1, entries: [score] }))
			.mockResolvedValueOnce(jsonResponse({ revision: "a".repeat(64), values: { difficulty: "hard" } }))
			.mockResolvedValueOnce(
				jsonResponse({
					bucketId: "game",
					badge: "latest",
					releaseId: "r1",
					entries: [{ key: "level", url: "https://cdn.example.test/level.glb", sha256: "b".repeat(64), bytes: 10, contentType: "model/gltf-binary" }],
				})
			)
			.mockResolvedValueOnce(jsonResponse({ functionId: "grant", executionId: "execution-1", result: { granted: true } }));
		const client = new ProjectServicesClient(configuration(), { fetch: fetchMock as typeof fetch });
		await client.signInAnonymously();
		expect(await client.submitLeaderboardScore("career", 42, { level: 3 })).toMatchObject({ rank: 1, score: 42 });
		expect((await client.getLeaderboardScores("career")).entries).toHaveLength(1);
		expect(await client.fetchRemoteConfig(["difficulty"])).toMatchObject({ values: { difficulty: "hard" } });
		expect(await client.getContentDeliveryManifest("game")).toMatchObject({ releaseId: "r1" });
		expect(await client.callCloudFunction("grant", { amount: 1 }, "function_0001")).toMatchObject({ result: { granted: true } });
		expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
			"/base/v1/auth/anonymous",
			"/base/v1/leaderboards/career/score",
			"/base/v1/leaderboards/career/scores",
			"/base/v1/remote-config",
			"/base/v1/content-delivery/game/latest",
			"/base/v1/cloud-functions/grant",
		]);
	});
});
