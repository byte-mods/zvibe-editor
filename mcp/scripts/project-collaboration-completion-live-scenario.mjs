#!/usr/bin/env node
/** Positive real-editor MCP verification for project CRDT, collaboration, discovery, relay, gateway, locks, merge data, changelists, preferences, and external-editor dispatch. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;

child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	let newline;
	while ((newline = stdout.indexOf("\n")) >= 0) {
		const line = stdout.slice(0, newline).trim();
		stdout = stdout.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function rpc(method, params, timeoutMs = 90_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}, expectError = false) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

async function waitFor(read, predicate, label, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

async function freeTcpPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function assert(condition, message, evidence) {
	if (!condition) throw new Error(`${message}: ${JSON.stringify(evidence)}`);
}

const suffix = `${Date.now()}-${process.pid}`;
const collectionName = `ZvibeLive${suffix}`;
const textPath = "README.md";
const marker = `\n<!-- zvibe-mcp-live-${suffix} -->\n`;
let admin;
let secondary;
let lock;
let rule;
let changelist;
let gatewayEnabled = false;
let discoveryEnabled = false;
let relayEnabled = false;
let collaborationEnabled = false;
let originalExternalEditorCommand = null;
let relayServer = null;

try {
	const initialized = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "project-collaboration-completion-live-scenario", version: "1.0.0" },
	});
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	if (process.env.BJS_LIVE_RECOVERY_MEMBER_ID && process.env.BJS_LIVE_RECOVERY_ACCESS_KEY) {
		await call("join_project_collaboration_session", {
			memberId: process.env.BJS_LIVE_RECOVERY_MEMBER_ID,
			accessKey: process.env.BJS_LIVE_RECOVERY_ACCESS_KEY,
			clientName: "Zvibe MCP Live Recovery",
			ttlSeconds: 60,
		});
		await call("configure_project_collaboration", { enabled: false });
	}

	const status = await call("get_editor_status");
	assert(status.ready && status.projectPath, "A ready editor project is required", status);
	await call("delete_asset", { path: "certs", confirm: true }).catch(() => undefined);

	const initialCollection = await call("get_collaborative_ordered_collection", { name: collectionName });
	assert(initialCollection.total === 0, "Unique ordered collection did not start empty", initialCollection);
	await call("apply_collaborative_ordered_collection_operations", {
		name: collectionName,
		actorId: "zvibe-live",
		operationId: `insert-${suffix}`,
		operations: [{ type: "insert", afterId: null, value: { verified: true, suffix } }],
	});
	const insertedCollection = await call("get_collaborative_ordered_collection", { name: collectionName });
	assert(insertedCollection.total === 1 && insertedCollection.items[0]?.value?.verified === true, "Ordered collection insert was not materialized", insertedCollection);
	await call("apply_collaborative_ordered_collection_operations", {
		name: collectionName,
		actorId: "zvibe-live",
		operationId: `delete-${suffix}`,
		operations: [{ type: "delete", id: insertedCollection.items[0].id }],
	});
	const emptyCollection = await call("get_collaborative_ordered_collection", { name: collectionName });
	const rebasedCollection = await call("rebase_collaborative_ordered_collection", { name: collectionName, expectedSourceHash: emptyCollection.sourceHash });
	assert(rebasedCollection.rebased === true && rebasedCollection.total === 0, "Ordered collection rebase failed", rebasedCollection);

	const initialText = await call("get_collaborative_text_document", { path: textPath, limit: 5000 });
	const tail = initialText.items.at(-1)?.id ?? null;
	await call("apply_collaborative_text_operations", {
		path: textPath,
		actorId: "zvibe-live",
		operationId: `text-insert-${suffix}`,
		operations: [{ type: "insert", afterId: tail, text: marker }],
	});
	const changedText = await call("get_collaborative_text_document", { path: textPath, offset: 0, limit: 5000 });
	assert(changedText.text.endsWith(marker), "Collaborative text insert was not persisted", { tail: changedText.text.slice(-marker.length) });
	const insertedIds = changedText.items.slice(initialText.totalCharacters).map((entry) => entry.id);
	await call("apply_collaborative_text_operations", {
		path: textPath,
		actorId: "zvibe-live",
		operationId: `text-delete-${suffix}`,
		operations: [{ type: "delete", ids: insertedIds }],
	});
	const restoredText = await call("get_collaborative_text_document", { path: textPath, offset: 0, limit: 5000 });
	assert(restoredText.text === initialText.text, "Collaborative text cleanup did not restore the source", { before: initialText.text.length, after: restoredText.text.length });
	const rebasedText = await call("rebase_collaborative_text_document", { path: textPath, expectedSourceHash: restoredText.sourceHash });
	assert(rebasedText.rebased === true, "Collaborative text rebase failed", rebasedText);

	const currentCollaboration = await call("get_project_collaboration_status");
	assert(currentCollaboration.enforcementEnabled === false, "Live scenario requires collaboration to be disabled before its isolated lifecycle", currentCollaboration);
	admin = await call("configure_project_collaboration", { enabled: true, bootstrapAdminName: `Zvibe Owner ${suffix}` });
	collaborationEnabled = true;
	admin = { ...admin, memberId: admin.bootstrap?.member?.id ?? admin.memberId, accessKey: admin.bootstrap?.accessKey ?? admin.accessKey };
	assert(admin.enforcementEnabled === true && admin.memberId && admin.accessKey, "Collaboration bootstrap did not return one-time credentials", admin);
	const joinedAdmin = await call("join_project_collaboration_session", {
		memberId: admin.memberId,
		accessKey: admin.accessKey,
		clientName: "Zvibe MCP Live Admin",
		state: "verifying project collaboration",
		ttlSeconds: 300,
	});
	assert(joinedAdmin.session?.tokenPresent !== false || joinedAdmin.joined === true || joinedAdmin.session, "Admin session did not join", joinedAdmin);

	secondary = await call("create_project_collaboration_member", { name: `Zvibe Live Editor ${suffix}`, role: "editor" });
	assert(secondary.member?.id && secondary.accessKey, "Editor member creation failed", secondary);
	const changedMember = await call("set_project_collaboration_member", { id: secondary.member.id, name: `Zvibe Live Reviewer ${suffix}`, role: "viewer", rotateAccessKey: true });
	assert(changedMember.member?.role === "viewer" && changedMember.accessKey, "Member update/key rotation failed", changedMember);
	secondary.accessKey = changedMember.accessKey;
	await call("heartbeat_project_collaboration_session", {
		state: "project live verification",
		color: "#42A5F5",
		toolMode: "navigate",
		pointers: [{ id: "mouse-1", viewport: "preview", x: 0.25, y: 0.75, pointerType: "mouse", buttons: 0 }],
		ttlSeconds: 300,
	});

	const tls = await call("generate_remote_collaboration_tls_certificate", {
		certificatePath: `certs/zvibe-live-${suffix}.crt`,
		privateKeyPath: `certs/zvibe-live-${suffix}.key`,
		hosts: ["localhost", "127.0.0.1"],
		commonName: "localhost",
		validityDays: 1,
		rsaBits: 2048,
	});
	assert(tls.generated === true && tls.keyMatches === true, "TLS certificate generation failed", tls);
	const inspectedTls = await call("inspect_remote_collaboration_tls_certificate", {
		certificatePath: tls.certificatePath,
		privateKeyPath: tls.privateKeyPath,
	});
	assert(inspectedTls.fingerprint256 === tls.fingerprint256 && inspectedTls.keyMatches === true, "TLS inspection did not match generated material", inspectedTls);

	const gatewayPort = await freeTcpPort();
	const gateway = await call("set_remote_collaboration_gateway", { enabled: true, bindAddress: "127.0.0.1", port: gatewayPort });
	gatewayEnabled = true;
	assert(gateway.running === true && gateway.actualPort === gatewayPort, "Remote gateway did not start", gateway);
	const gatewayStatus = await call("get_remote_collaboration_gateway");
	assert(gatewayStatus.running === true && gatewayStatus.actualPort === gatewayPort, "Remote gateway status is inconsistent", gatewayStatus);

	const discoveryPort = await freeTcpPort();
	const discovery = await call("set_remote_collaboration_discovery", { enabled: true, displayName: "Zvibe Live Project", address: "127.0.0.1", port: discoveryPort });
	discoveryEnabled = true;
	assert(discovery.advertising === true, "Remote discovery did not start", discovery);
	const discovered = await call("discover_remote_collaboration_projects", { address: "127.0.0.1", port: discoveryPort, timeoutMs: 300 });
	assert(discovered.count >= 1, "Remote discovery did not find the running project", discovered);
	const discoveryStatus = await call("get_remote_collaboration_discovery");
	assert(discoveryStatus.advertising === true, "Remote discovery status is inconsistent", discoveryStatus);

	relayServer = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
	await new Promise((resolve, reject) => {
		relayServer.once("listening", resolve);
		relayServer.once("error", reject);
	});
	relayServer.on("connection", (socket) => {
		socket.on("message", (bytes) => {
			const message = JSON.parse(bytes.toString("utf8"));
			if (message?.protocol === "babylon-editor-collaboration-relay" && message?.version === 1 && message?.type === "register") {
				socket.send(JSON.stringify({ type: "registered", connectionId: `live-relay-${suffix}` }));
			}
		});
	});
	const relayAddress = relayServer.address();
	assert(typeof relayAddress === "object" && relayAddress !== null, "Loopback relay did not expose a TCP address", relayAddress);
	const relayStatus = await call("set_remote_collaboration_relay", {
		enabled: true,
		relayUrl: `ws://127.0.0.1:${relayAddress.port}`,
		projectSlug: `zvibe-live-${process.pid}`,
		relayAccessToken: `zvibe-live-token-${suffix}`,
		reconnectMinimumMs: 500,
		reconnectMaximumMs: 1000,
	});
	relayEnabled = true;
	assert(relayStatus.config?.enabled === true || relayStatus.enabled === true, "Relay configuration was not accepted", relayStatus);
	const relayRead = await call("get_remote_collaboration_relay");
	assert(relayRead.config?.enabled === true || relayRead.enabled === true, "Relay status did not retain enabled configuration", relayRead);
	const relayConnected = await waitFor(
		() => call("get_remote_collaboration_relay"),
		(status) => status.connected === true && status.connectionId === `live-relay-${suffix}`,
		"authenticated collaboration relay registration"
	);
	assert(relayConnected.authentication?.persisted === false, "Relay credentials must remain memory-only", relayConnected);
	const relayReconnect = await call("reconnect_remote_collaboration_relay", { relayAccessToken: `zvibe-live-token-${suffix}` });
	assert(relayReconnect !== null, "Relay reconnect returned no status", relayReconnect);
	await waitFor(
		() => call("get_remote_collaboration_relay"),
		(status) => status.connected === true && status.connectionId === `live-relay-${suffix}`,
		"collaboration relay reconnection"
	);

	const history = await call("set_remote_collaboration_event_history", { enabled: true, retention: 200 });
	assert(history.config?.enabled === true || history.enabled === true, "Event history configuration failed", history);
	const events = await call("list_remote_collaboration_events", { afterSequence: 0, limit: 200 });
	assert(Array.isArray(events.events), "Event history listing failed", events);
	const clearedEvents = await call("clear_remote_collaboration_event_history", { confirm: true });
	assert(clearedEvents.cleared === true || clearedEvents.eventCount === 0, "Event history clear failed", clearedEvents);

	const federation = await call("get_project_asset_lock_federation");
	assert(federation.authenticated === true || federation.member || federation.permissions, "Asset-lock federation did not report the authenticated session", federation);
	lock = await call("acquire_project_asset_lock", { path: "project.bjseditor", note: "MCP live verification", ttlSeconds: 120 });
	assert(lock.acquired === true && lock.lock?.lockId, "Asset lock acquisition failed", lock);
	const refreshed = await call("refresh_project_asset_lock", { path: "project.bjseditor", lockId: lock.lock.lockId, ttlSeconds: 180 });
	assert(refreshed.refreshed === true || refreshed.lock?.lockId === lock.lock.lockId, "Asset lock refresh failed", refreshed);
	const released = await call("release_project_asset_lock", { path: "project.bjseditor", lockId: lock.lock.lockId });
	assert(released.released === true, "Asset lock release failed", released);
	lock = null;

	rule = await call("create_project_semantic_merge_rule", { name: `Zvibe Live Rule ${suffix}`, assetKind: "prefab", filePattern: "*.prefab", pathPrefix: "/", choice: "ours" });
	assert(rule.rule?.id, "Semantic merge rule creation failed", rule);
	const updatedRule = await call("set_project_semantic_merge_rule", { id: rule.rule.id, name: `Zvibe Live Rule Updated ${suffix}`, choice: "theirs" });
	assert(updatedRule.rule?.choice === "theirs", "Semantic merge rule update failed", updatedRule);
	const deletedRule = await call("delete_project_semantic_merge_rule", { id: rule.rule.id });
	assert(deletedRule.deleted === true, "Semantic merge rule deletion failed", deletedRule);
	rule = null;

	const hierarchy = await call("get_scene_hierarchy");
	const activeScenePath = status.activeScenePath ?? status.scenePath;
	assert(activeScenePath, "Active scene path is required for semantic comparison", status);
	const relativeScene = activeScenePath.slice(dirname(status.projectPath).length + 1);
	const compared = await call("compare_project_scene_assets", { sourcePath: relativeScene, targetPath: relativeScene, maximumChanges: 10 });
	assert(compared.equal === true && compared.summary?.totalChanges === 0, "Self semantic comparison reported changes", { compared, hierarchyCount: hierarchy.nodes?.length });
	const merged = await call("merge_project_scene_assets", { basePath: relativeScene, oursPath: relativeScene, theirsPath: relativeScene, maximumConflicts: 10 });
	assert((merged.summary?.conflicts ?? merged.totalConflicts ?? 0) === 0, "Identical semantic merge reported conflicts", merged);

	changelist = await call("create_project_changelist", {
		name: `Zvibe Live Changelist ${suffix}`,
		owner: "MCP Live",
		description: "Project tool verification",
		paths: ["project.bjseditor"],
	});
	assert(changelist.changelist?.id, "Changelist creation failed", changelist);
	const changedList = await call("set_project_changelist", { id: changelist.changelist.id, newName: `Zvibe Live Updated ${suffix}`, owner: "MCP Verification" });
	assert(changedList.changelist?.owner === "MCP Verification", "Changelist metadata update failed", changedList);
	const changedFiles = await call("set_project_changelist_files", { id: changelist.changelist.id, mode: "remove", paths: ["project.bjseditor"] });
	assert(changedFiles.changelist?.paths?.length === 0 || changedFiles.changelist?.files?.length === 0, "Changelist file update failed", changedFiles);
	const deletedList = await call("delete_project_changelist", { id: changelist.changelist.id });
	assert(deletedList.deleted === true, "Changelist deletion failed", deletedList);
	changelist = null;

	const preferences = await call("get_project_preferences");
	assert(typeof preferences.externalEditorCommand === "string" && preferences.externalEditorCommand.length > 0, "Project has no configured external editor command", preferences);
	originalExternalEditorCommand = preferences.externalEditorCommand;
	const changedPreferences = await call("set_project_preferences", { preferences: { externalEditorCommand: "/usr/bin/true" } });
	assert(changedPreferences.preferences || changedPreferences.externalEditorCommand !== undefined, "Project preference write failed", changedPreferences);
	const external = await call("open_project_file_in_external_editor", { path: textPath });
	assert(external.opened === true || external.launched === true, "External editor dispatch failed", external);
	await call("set_project_preferences", { preferences: { externalEditorCommand: originalExternalEditorCommand } });
	originalExternalEditorCommand = null;

	await call("set_remote_collaboration_relay", { enabled: false });
	relayEnabled = false;
	await call("set_remote_collaboration_discovery", { enabled: false });
	discoveryEnabled = false;
	await call("set_remote_collaboration_gateway", { enabled: false });
	gatewayEnabled = false;
	await call("delete_asset", { path: "certs", confirm: true });

	await call("join_project_collaboration_session", { memberId: secondary.member.id, accessKey: secondary.accessKey, clientName: "Zvibe MCP Live Viewer", ttlSeconds: 60 });
	const left = await call("leave_project_collaboration_session");
	assert(left.left === true, "Secondary session did not leave", left);
	await call("join_project_collaboration_session", { memberId: admin.memberId, accessKey: admin.accessKey, clientName: "Zvibe MCP Live Cleanup", ttlSeconds: 60 });
	const deletedMember = await call("delete_project_collaboration_member", { id: secondary.member.id });
	assert(deletedMember.deleted === true, "Secondary collaboration member deletion failed", deletedMember);
	secondary = null;
	const disabled = await call("configure_project_collaboration", { enabled: false });
	assert(disabled.enforcementEnabled === false, "Collaboration did not disable after verification", disabled);
	collaborationEnabled = false;

	console.log(
		JSON.stringify(
			{
				ok: true,
				verified: 39,
				project: status.projectPath,
				semanticScene: relativeScene,
				eventCountBeforeClear: events.events.length,
			},
			null,
			2
		)
	);
} finally {
	try {
		if (originalExternalEditorCommand) await call("set_project_preferences", { preferences: { externalEditorCommand: originalExternalEditorCommand } });
		if (lock?.lock?.lockId) await call("release_project_asset_lock", { path: "project.bjseditor", lockId: lock.lock.lockId });
		if (rule?.rule?.id) await call("delete_project_semantic_merge_rule", { id: rule.rule.id });
		if (changelist?.changelist?.id) await call("delete_project_changelist", { id: changelist.changelist.id, force: true });
		if (relayEnabled) await call("set_remote_collaboration_relay", { enabled: false });
		if (discoveryEnabled) await call("set_remote_collaboration_discovery", { enabled: false });
		if (gatewayEnabled) await call("set_remote_collaboration_gateway", { enabled: false });
		if (collaborationEnabled && admin?.memberId && admin?.accessKey) {
			await call("join_project_collaboration_session", {
				memberId: admin.memberId,
				accessKey: admin.accessKey,
				clientName: "Zvibe MCP Live Emergency Cleanup",
				ttlSeconds: 60,
			});
			await call("configure_project_collaboration", { enabled: false });
		}
		if (relayServer) {
			for (const socket of relayServer.clients) socket.terminate();
			await new Promise((resolve) => relayServer.close(resolve));
		}
	} catch (cleanupError) {
		stderr += `\nCleanup error: ${cleanupError?.stack ?? cleanupError}`;
	}
	child.kill();
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}
