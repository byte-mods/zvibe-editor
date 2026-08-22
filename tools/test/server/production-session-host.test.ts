import { createServer } from "node:http";

import { NullEngine, Scene, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, test } from "vitest";

import { ProductionSessionHost } from "../../src/server/production-session-host";
import { configureGameObjectComponents } from "../../src/loading/game-object-components";

const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (resources.length) await resources.pop()?.();
});

describe("ProductionSessionHost", () => {
	test("publishes credential-free authoritative health without player-host migration", async () => {
		const scene = new Scene(new NullEngine());
		const node = new TransformNode("Player", scene);
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				revision: 1,
				components: [
					{
						id: "network",
						type: "network",
						enabled: true,
						data: { networkId: "player", authority: "owner", syncTransform: true, syncAnimation: false, sendRateHz: 20, interpolate: true },
					},
				],
			},
		};
		configureGameObjectComponents(scene);
		const http = createServer();
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const host = new ProductionSessionHost(scene, { joinCode: "SERVER1", maximumPlayers: 8 });
		host.attach(http);
		resources.push(
			async () => host.close(),
			async () => new Promise<void>((resolve) => http.close(() => resolve())),
			() => scene.dispose()
		);
		host.tick();
		expect(host.status()).toMatchObject({ state: "listening", tick: 1, maximumPlayers: 8, networkObjectCount: 1, joinCodeRequired: true });
		expect(JSON.stringify(host.status())).not.toContain("SERVER1");
	});

	test("rejects weak credentials and invalid capacity", () => {
		const scene = new Scene(new NullEngine());
		expect(() => new ProductionSessionHost(scene, { joinCode: "weak", maximumPlayers: 1 })).toThrow("joinCode");
		expect(() => new ProductionSessionHost(scene, { joinCode: "SERVER1", maximumPlayers: 0 })).toThrow("maximumPlayers");
		scene.dispose();
	});
});
