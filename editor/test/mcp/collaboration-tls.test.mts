import { createServer } from "net";
import { request as httpsRequest } from "https";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, lstat, mkdtemp, remove, symlink, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { generateRemoteCollaborationTlsCertificate, inspectRemoteCollaborationTlsCertificate } from "../../src/mcp/project/collaboration-tls";
import { configureProjectCollaboration, createProjectCollaborationMember, joinProjectCollaborationSession } from "../../src/mcp/project/collaboration";
import { initializeRemoteCollaborationGateway, setRemoteCollaborationGateway, shutdownRemoteCollaborationGateway } from "../../src/mcp/project/remote-collaboration";

describe("mcp/project/collaboration TLS automation", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;
	let options: any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-collaboration-tls-"));
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = { state: { projectPath: join(directory, "Game.bjseditor") }, layout: { preview: { scene }, console: { error: () => undefined, log: () => undefined } } };
		options = { editor };
		await writeJSON(editor.state.projectPath, {});
		await initializeRemoteCollaborationGateway(editor, { get_test_value: async () => ({ value: 42 }) });
	});

	afterEach(async () => {
		await shutdownRemoteCollaborationGateway();
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	async function sessions(): Promise<{ adminToken: string; viewerToken: string }> {
		const configured = await configureProjectCollaboration(scene, { enabled: true, bootstrapAdminName: "Owner" }, options);
		const admin = await joinProjectCollaborationSession(
			scene,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "TLS Admin" },
			options
		);
		const viewer = await createProjectCollaborationMember(scene, { name: "TLS Reviewer", role: "viewer", collaborationToken: admin.session.token }, options);
		const viewerSession = await joinProjectCollaborationSession(scene, { memberId: viewer.member.id, accessKey: viewer.accessKey, clientName: "TLS Viewer" }, options);
		return { adminToken: admin.session.token, viewerToken: viewerSession.session.token };
	}

	async function freePort(): Promise<number> {
		const server = createServer();
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		return port;
	}

	test("generates, inspects, protects, and explicitly rotates a private-key-matched certificate", async () => {
		const { adminToken, viewerToken } = await sessions();
		await expect(generateRemoteCollaborationTlsCertificate(scene, { collaborationToken: viewerToken }, options)).rejects.toThrow("admin role");
		const generated = await generateRemoteCollaborationTlsCertificate(
			scene,
			{ hosts: ["localhost", "127.0.0.1", "::1"], commonName: "localhost", validityDays: 30, rsaBits: 2048, collaborationToken: adminToken },
			options
		);
		expect(generated).toMatchObject({
			generated: true,
			rotated: false,
			certificatePath: "certs/collaboration.crt",
			privateKeyPath: "certs/collaboration.key",
			validNow: true,
			keyType: "rsa",
			keyBits: 2048,
			privateKeyExists: true,
			keyMatches: true,
		});
		expect(generated.subjectAltName).toContain("DNS:localhost");
		expect(generated.subjectAltName).toContain("IP Address:127.0.0.1");
		expect(JSON.stringify(generated)).not.toContain("PRIVATE KEY");
		expect(JSON.stringify(generated)).not.toContain(adminToken);
		expect((await lstat(join(directory, "certs", "collaboration.key"))).mode & 0o777).toBe(0o600);

		const inspected = await inspectRemoteCollaborationTlsCertificate(scene, { collaborationToken: viewerToken }, options);
		expect(inspected).toMatchObject({ fingerprint256: generated.fingerprint256, keyMatches: true, validNow: true });
		await expect(generateRemoteCollaborationTlsCertificate(scene, { collaborationToken: adminToken }, options)).rejects.toThrow("confirmOverwrite=true");
		const rotated = await generateRemoteCollaborationTlsCertificate(scene, { confirmOverwrite: true, collaborationToken: adminToken }, options);
		expect(rotated).toMatchObject({ generated: true, rotated: true, keyMatches: true });
		expect(rotated.fingerprint256).not.toBe(generated.fingerprint256);
	});

	test("rejects traversal, metadata paths, unsafe hosts, and certificate symlinks", async () => {
		const { adminToken, viewerToken } = await sessions();
		await expect(generateRemoteCollaborationTlsCertificate(scene, { certificatePath: "../outside.crt", collaborationToken: adminToken }, options)).rejects.toThrow(
			"inside the project"
		);
		await expect(generateRemoteCollaborationTlsCertificate(scene, { privateKeyPath: ".babylon-editor/key.pem", collaborationToken: adminToken }, options)).rejects.toThrow(
			"outside editor metadata"
		);
		await expect(generateRemoteCollaborationTlsCertificate(scene, { hosts: ["bad/host"], collaborationToken: adminToken }, options)).rejects.toThrow("DNS name or IP");
		const outside = await mkdtemp(join(tmpdir(), "babylon-collaboration-tls-outside-"));
		try {
			await symlink(outside, join(directory, "linked-certs"));
			await expect(
				generateRemoteCollaborationTlsCertificate(
					scene,
					{ certificatePath: "linked-certs/server.crt", privateKeyPath: "linked-certs/server.key", collaborationToken: adminToken },
					options
				)
			).rejects.toThrow("outside the project");
			await ensureDir(join(directory, "certs"));
			await writeFile(join(outside, "foreign.crt"), "not a certificate", "utf-8");
			await symlink(join(outside, "foreign.crt"), join(directory, "certs", "collaboration.crt"));
			await expect(inspectRemoteCollaborationTlsCertificate(scene, { collaborationToken: viewerToken }, options)).rejects.toThrow("must not be a symbolic link");
		} finally {
			await remove(outside);
		}
	});

	test("starts the real collaboration gateway over the generated HTTPS certificate", async () => {
		const { adminToken } = await sessions();
		await generateRemoteCollaborationTlsCertificate(scene, { hosts: ["localhost", "127.0.0.1"], collaborationToken: adminToken }, options);
		const port = await freePort();
		const gateway = await setRemoteCollaborationGateway(
			scene,
			{
				enabled: true,
				bindAddress: "127.0.0.1",
				port,
				allowedOrigins: ["https://allowed.test"],
				allowedHosts: [`127.0.0.1:${port}`],
				tlsCertificatePath: "certs/collaboration.crt",
				tlsPrivateKeyPath: "certs/collaboration.key",
				collaborationToken: adminToken,
			},
			options
		);
		expect(gateway).toMatchObject({ running: true, actualPort: port, protocol: "https" });
		const response = await new Promise<{ status: number | undefined; body: string }>((resolveResponse, rejectResponse) => {
			const request = httpsRequest(
				{ hostname: "127.0.0.1", port, path: "/health", method: "GET", rejectUnauthorized: false, headers: { Host: `127.0.0.1:${port}`, Origin: "https://allowed.test" } },
				(response) => {
					let body = "";
					response.on("data", (chunk) => (body += chunk));
					response.on("end", () => resolveResponse({ status: response.statusCode, body }));
				}
			);
			request.on("error", rejectResponse);
			request.end();
		});
		expect(response).toEqual({ status: 200, body: JSON.stringify({ ok: true, tls: true }) });
	});
});
