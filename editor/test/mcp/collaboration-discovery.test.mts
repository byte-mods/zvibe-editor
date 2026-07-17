import { createSocket } from "dgram";
import { createServer } from "net";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureDir, mkdtemp, readJSON, remove, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { configureProjectCollaboration, createProjectCollaborationMember, joinProjectCollaborationSession } from "../../src/mcp/project/collaboration";
import { discoverRemoteCollaborationProjects, getRemoteCollaborationDiscovery, setRemoteCollaborationDiscovery } from "../../src/mcp/project/collaboration-discovery";
import { generateRemoteCollaborationTlsCertificate } from "../../src/mcp/project/collaboration-tls";
import { initializeRemoteCollaborationGateway, setRemoteCollaborationGateway, shutdownRemoteCollaborationGateway } from "../../src/mcp/project/remote-collaboration";

describe("mcp/project/collaboration-discovery", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;
	let options: any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-collaboration-discovery-"));
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = {
			state: { projectPath: join(directory, "Discovery Game.bjseditor") },
			layout: { preview: { scene }, console: { error: () => undefined, log: () => undefined } },
		};
		options = { editor };
		await writeJSON(editor.state.projectPath, {});
		await ensureDir(join(directory, "assets"));
		await initializeRemoteCollaborationGateway(editor, {});
	});

	afterEach(async () => {
		await shutdownRemoteCollaborationGateway();
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	async function freeTcpPort(): Promise<number> {
		const server = createServer();
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		return port;
	}

	async function freeUdpPort(): Promise<number> {
		const socket = createSocket("udp4");
		await new Promise<void>((resolveBind) => socket.bind(0, "127.0.0.1", resolveBind));
		const address = socket.address();
		await new Promise<void>((resolveClose) => socket.close(() => resolveClose()));
		return address.port;
	}

	async function bootstrap(): Promise<{ adminToken: string; viewerToken: string }> {
		const configured = await configureProjectCollaboration(scene, { enabled: true, bootstrapAdminName: "Owner" }, options);
		const admin = await joinProjectCollaborationSession(
			scene,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "Discovery Admin" },
			options
		);
		const viewer = await createProjectCollaborationMember(scene, { name: "Viewer", role: "viewer", collaborationToken: admin.session.token }, options);
		const viewerSession = await joinProjectCollaborationSession(scene, { memberId: viewer.member.id, accessKey: viewer.accessKey, clientName: "Discovery Viewer" }, options);
		return { adminToken: admin.session.token, viewerToken: viewerSession.session.token };
	}

	test("advertises and discovers a sanitized authenticated gateway over a real UDP socket", async () => {
		const { adminToken } = await bootstrap();
		const gatewayPort = await freeTcpPort();
		const discoveryPort = await freeUdpPort();
		await setRemoteCollaborationGateway(scene, { enabled: true, bindAddress: "127.0.0.1", port: gatewayPort, collaborationToken: adminToken }, options);
		const enabled = await setRemoteCollaborationDiscovery(
			scene,
			{ enabled: true, displayName: "Level Design Room", address: "127.0.0.1", port: discoveryPort, collaborationToken: adminToken },
			options
		);
		expect(enabled).toMatchObject({ advertising: true, gatewayRunning: true, config: { enabled: true, displayName: "Level Design Room", port: discoveryPort } });

		const result = await discoverRemoteCollaborationProjects(scene, { address: "127.0.0.1", port: discoveryPort, timeoutMs: 150, collaborationToken: adminToken }, options);
		expect(result).toMatchObject({ count: 1, untrustedDiscoveryMetadata: true, target: { address: "127.0.0.1", port: discoveryPort } });
		expect(result.projects[0]).toMatchObject({
			displayName: "Level Design Room",
			gatewayProtocol: "http",
			host: "127.0.0.1",
			port: gatewayPort,
			url: `http://127.0.0.1:${gatewayPort}`,
			requiresAuthentication: true,
			tlsFingerprint256: null,
		});
		expect(Date.parse(result.projects[0].expiresAt)).toBeGreaterThan(Date.now());
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(directory);
		expect(serialized).not.toContain(adminToken);
		expect(serialized).not.toContain("allowedHosts");
		expect((await getRemoteCollaborationDiscovery(scene, { collaborationToken: adminToken }, options)).responseCount).toBe(1);
	});

	test("enforces administrator configuration, validates targets, and follows gateway lifecycle", async () => {
		const { adminToken, viewerToken } = await bootstrap();
		const discoveryPort = await freeUdpPort();
		await expect(
			setRemoteCollaborationDiscovery(scene, { enabled: true, displayName: "Denied", address: "127.0.0.1", port: discoveryPort, collaborationToken: viewerToken }, options)
		).rejects.toThrow("admin role");
		await expect(
			setRemoteCollaborationDiscovery(scene, { enabled: true, displayName: "Bad\nName", address: "127.0.0.1", port: discoveryPort, collaborationToken: adminToken }, options)
		).rejects.toThrow("displayName");
		await expect(discoverRemoteCollaborationProjects(scene, { address: "8.8.8.8", port: discoveryPort, collaborationToken: adminToken }, options)).rejects.toThrow(
			"multicast address or 127.0.0.1"
		);

		const waiting = await setRemoteCollaborationDiscovery(
			scene,
			{ enabled: true, displayName: "Waiting Room", address: "127.0.0.1", port: discoveryPort, collaborationToken: adminToken },
			options
		);
		expect(waiting).toMatchObject({ advertising: false, gatewayRunning: false, reason: expect.stringContaining("Start the remote collaboration gateway") });
		const gatewayPort = await freeTcpPort();
		await setRemoteCollaborationGateway(scene, { enabled: true, bindAddress: "127.0.0.1", port: gatewayPort, collaborationToken: adminToken }, options);
		expect(await getRemoteCollaborationDiscovery(scene, { collaborationToken: adminToken }, options)).toMatchObject({ advertising: true, lastError: null });
		await setRemoteCollaborationGateway(scene, { enabled: false, collaborationToken: adminToken }, options);
		expect(await getRemoteCollaborationDiscovery(scene, { collaborationToken: adminToken }, options)).toMatchObject({ advertising: false, gatewayRunning: false });
	});

	test("persists public discovery identity and restores advertising across editor restart", async () => {
		const { adminToken } = await bootstrap();
		const gatewayPort = await freeTcpPort();
		const discoveryPort = await freeUdpPort();
		await setRemoteCollaborationGateway(scene, { enabled: true, bindAddress: "127.0.0.1", port: gatewayPort, collaborationToken: adminToken }, options);
		const first = await setRemoteCollaborationDiscovery(
			scene,
			{ enabled: true, displayName: "Persistent Room", address: "127.0.0.1", port: discoveryPort, collaborationToken: adminToken },
			options
		);
		const discoveryId = first.config.discoveryId;
		await shutdownRemoteCollaborationGateway();
		await initializeRemoteCollaborationGateway(editor, {});

		const restored = await getRemoteCollaborationDiscovery(scene, { collaborationToken: adminToken }, options);
		expect(restored).toMatchObject({ advertising: true, config: { enabled: true, discoveryId, displayName: "Persistent Room" } });
		expect(await readJSON(join(directory, ".babylon-editor", "remote-collaboration-discovery.json"))).toMatchObject({ version: 1, discoveryId });
		const discovered = await discoverRemoteCollaborationProjects(scene, { address: "127.0.0.1", port: discoveryPort, timeoutMs: 150, collaborationToken: adminToken }, options);
		expect(discovered.projects[0].discoveryId).toBe(discoveryId);
	});

	test("publishes the generated HTTPS certificate fingerprint without certificate or key contents", async () => {
		const { adminToken } = await bootstrap();
		const generated = await generateRemoteCollaborationTlsCertificate(
			scene,
			{ certificatePath: "certs/discovery.crt", privateKeyPath: "certs/discovery.key", hosts: ["127.0.0.1"], collaborationToken: adminToken },
			options
		);
		const gatewayPort = await freeTcpPort();
		const discoveryPort = await freeUdpPort();
		await setRemoteCollaborationGateway(
			scene,
			{
				enabled: true,
				bindAddress: "127.0.0.1",
				port: gatewayPort,
				tlsCertificatePath: "certs/discovery.crt",
				tlsPrivateKeyPath: "certs/discovery.key",
				collaborationToken: adminToken,
			},
			options
		);
		await setRemoteCollaborationDiscovery(
			scene,
			{ enabled: true, displayName: "Secure Room", address: "127.0.0.1", port: discoveryPort, collaborationToken: adminToken },
			options
		);
		const result = await discoverRemoteCollaborationProjects(scene, { address: "127.0.0.1", port: discoveryPort, timeoutMs: 150, collaborationToken: adminToken }, options);
		expect(result.projects[0]).toMatchObject({ gatewayProtocol: "https", tlsFingerprint256: generated.fingerprint256 });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("BEGIN CERTIFICATE");
		expect(serialized).not.toContain("PRIVATE KEY");
	});
});
