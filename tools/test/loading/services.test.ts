import { describe, expect, test } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";

import {
	getEnabledProjectServices,
	getProjectServicesConfiguration,
	normalizeProjectServicesConfiguration,
	projectServiceCategories,
	servicesConfigurationVersion,
} from "../../src/loading/services";

describe("loading/services", () => {
	test("fills in every known category so a runtime never needs existence checks", () => {
		const configuration = normalizeProjectServicesConfiguration(undefined);
		expect(configuration.version).toBe(servicesConfigurationVersion);
		projectServiceCategories.forEach((category) => {
			expect(configuration[category]).toEqual({ enabled: false, provider: "", endpoint: "", options: {} });
		});
	});

	test("a service cannot be enabled without a provider to route to", () => {
		const configuration = normalizeProjectServicesConfiguration({
			auth: { enabled: true, provider: "firebase", endpoint: "https://auth.example.com" },
			// Enabled but no provider — must resolve to disabled rather than
			// handing the runtime an unroutable "enabled" service.
			analytics: { enabled: true, endpoint: "https://a.example.com" },
		});

		expect(configuration.auth).toMatchObject({ enabled: true, provider: "firebase", endpoint: "https://auth.example.com" });
		expect(configuration.analytics.enabled).toBe(false);
		expect(configuration.iap.enabled).toBe(false);
	});

	test("keeps only flat JSON-safe options and bounds their count and size", () => {
		const options: Record<string, unknown> = {
			region: "eu",
			retries: 3,
			debug: true,
			nested: { nope: 1 },
			list: [1, 2],
			huge: "x".repeat(1000),
		};
		for (let index = 0; index < 100; index++) {
			options[`extra${index}`] = index;
		}

		const service = normalizeProjectServicesConfiguration({ ads: { enabled: true, provider: "admob", options } }).ads;

		expect(service.options.region).toBe("eu");
		expect(service.options.retries).toBe(3);
		expect(service.options.debug).toBe(true);
		// Nested objects and arrays are rejected, not deep-cloned.
		expect(service.options.nested).toBeUndefined();
		expect(service.options.list).toBeUndefined();
		// Oversized strings are truncated and the entry count is capped.
		expect((service.options.huge as string).length).toBe(512);
		expect(Object.keys(service.options).length).toBeLessThanOrEqual(64);
	});

	test("trims and bounds provider/endpoint strings", () => {
		const service = normalizeProjectServicesConfiguration({
			matchmaking: { enabled: true, provider: "  relay  ", endpoint: `  ${"e".repeat(900)}  ` },
		}).matchmaking;

		expect(service.provider).toBe("relay");
		expect(service.endpoint.length).toBe(512);
		expect(service.enabled).toBe(true);
	});

	test("reads the contract off a scene and lists enabled categories in stable order", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.metadata = {
			babylonEditorServices: {
				analytics: { enabled: true, provider: "custom", endpoint: "https://a.example.com" },
				auth: { enabled: true, provider: "firebase" },
				ads: { enabled: false, provider: "admob" },
			},
		};

		expect(getProjectServicesConfiguration(scene).auth.provider).toBe("firebase");
		// Declaration order, not authored order, so the result is deterministic.
		expect(getEnabledProjectServices(scene)).toEqual(["auth", "analytics"]);

		scene.dispose();
		engine.dispose();
	});

	test("degrades malformed authored data instead of throwing", () => {
		for (const malformed of [null, 42, "nope", [], { auth: "not-an-object" }, { auth: { enabled: "yes" } }]) {
			const configuration = normalizeProjectServicesConfiguration(malformed);
			expect(configuration.version).toBe(servicesConfigurationVersion);
			expect(configuration.auth.enabled).toBe(false);
		}

		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.metadata = { babylonEditorServices: "corrupt" };
		expect(getEnabledProjectServices(scene)).toEqual([]);
		scene.dispose();
		engine.dispose();
	});
});
