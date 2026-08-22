import { describe, expect, test } from "vitest";

import { createDefaultConsoleServerConfiguration, normalizeConsoleServerConfiguration } from "../../src/mcp/server/model";

describe("Console/server model", () => {
	test("normalizes one strict non-secret production configuration", () => {
		const configuration = normalizeConsoleServerConfiguration({
			...createDefaultConsoleServerConfiguration(),
			revision: 4,
			deployment: { provider: "kubernetes", replicas: 3, namespace: "production", kubeContext: "cluster-a", consoleProviderId: null },
		});
		expect(configuration).toMatchObject({ revision: 4, deployment: { provider: "kubernetes", replicas: 3, namespace: "production" } });
		expect(JSON.stringify(configuration)).not.toContain("password");
	});

	test("rejects unsafe paths, routes, environment references, and incomplete console providers", () => {
		expect(() => normalizeConsoleServerConfiguration({ container: { dockerfilePath: "../Dockerfile" } })).toThrow("project-relative");
		expect(() => normalizeConsoleServerConfiguration({ headless: { healthPath: "/same", metricsPath: "/same" } })).toThrow("distinct");
		expect(() => normalizeConsoleServerConfiguration({ container: { registryCredentialEnvironment: "secret value" } })).toThrow("environment variable");
		expect(() => normalizeConsoleServerConfiguration({ deployment: { provider: "console" } })).toThrow("consoleProviderId");
	});
});
