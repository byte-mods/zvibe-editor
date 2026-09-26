#!/usr/bin/env node
/** Real Editor -> Blender binary FBX -> Assimp importer -> stdio MCP round-trip lifecycle. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectEditorUi, waitForUi } from "./electron-ui-harness.mjs";

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

function rpc(method, params, timeoutMs = 240_000) {
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

async function callImage(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	if (response.error || response.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? response.result)}`);
	const image = response.result?.content?.find((entry) => entry.type === "image");
	if (!image?.data || !image.mimeType?.startsWith("image/")) throw new Error(`${name} did not return an image block.`);
	return { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType };
}

async function safeCall(name, args = {}) {
	try {
		return await call(name, args);
	} catch {
		return null;
	}
}

async function listTools() {
	const tools = [];
	let cursor;
	do {
		const response = await rpc("tools/list", cursor ? { cursor } : {});
		if (response.error) throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
		tools.push(...(response.result?.tools ?? []));
		cursor = response.result?.nextCursor;
	} while (cursor);
	return tools;
}

async function waitFor(read, predicate, label, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

function binaryFbxVersion(content) {
	const magic = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
	if (content.length < magic.length + 4 || !content.subarray(0, magic.length).equals(magic)) throw new Error("Exported FBX does not have the binary FBX header.");
	return content.readUInt32LE(magic.length);
}

const requiredTools = [
	"get_fbx_export_capabilities",
	"inspect_fbx_export",
	"export_fbx_asset",
	"round_trip_fbx_export",
	"get_editor_status",
	"get_active_scene",
	"create_scene",
	"open_scene",
	"delete_scene",
	"save_scene",
	"create_primitive_mesh",
	"create_material",
	"set_mesh_material",
	"set_node_transform",
	"create_animation",
	"get_node",
	"focus_node",
	"get_screenshot",
	"delete_node",
	"delete_asset",
];
const packagedManifest = JSON.parse(await readFile(join(here, "..", "manifest.json"), "utf8"));
const packagedTools = packagedManifest.server?.tools ?? packagedManifest.tools;
if (!Array.isArray(packagedTools)) throw new Error("MCPB manifest does not contain a packaged tool catalog.");
const expectedToolCount = packagedTools.length;
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const retainFixtures = process.env.FBX_LIVE_RETAIN_FIXTURES === "1";
const allowSceneSwitch = process.env.FBX_LIVE_ALLOW_SCENE_SWITCH === "1";
const scenePath = `scenes/mcp-fbx-${suffix}.scene`;
const assetFolder = `assets/.mcp-fbx-${suffix}`;
const assetPath = `${assetFolder}/complex-round-trip.fbx`;
const uiAssetPath = `${assetFolder}/direct-ui-selection.fbx`;
const parentName = `FBX Parent ${suffix}`;
const importedName = `FBX Returned ${suffix}`;
const settings = {
	globalScale: 1.25,
	axisForward: "-Z",
	axisUp: "Y",
	applyTransforms: false,
	applyModifiers: true,
	includeMaterials: true,
	embedTextures: false,
	includeAnimations: true,
	animationSamplingRate: 1,
	animationSimplification: 0,
	includeCameras: false,
	includeLights: false,
	exportTangents: true,
	exportCustomProperties: true,
	addLeafBones: false,
	useArmatureDeformOnly: false,
};
let projectDirectory = null;
let originalScenePath = null;
let manifestPath = null;
let sourceParentId = null;
let importedRootId = null;
let materialPath = null;
let sceneCreated = false;
let completed = false;
let fbxUi = null;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fbx-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} MCP tools, received ${tools.length}.`);
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing from real stdio discovery.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}
	const unknown = await call("get_fbx_export_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Closed FBX schema did not reject an unknown field.");
	const invalidSettings = await call("inspect_fbx_export", { path: assetPath, settings: { includeMaterials: false } }, true);
	if (!String(invalidSettings).includes("embedTextures")) throw new Error(`FBX settings relation did not reject invalid material/texture input: ${invalidSettings}`);

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready editor project is required for the FBX live scenario.");
	projectDirectory = dirname(status.projectPath);
	manifestPath = join(projectDirectory, ".bjseditor", "fbx-exports", `${createHash("sha256").update(assetPath).digest("hex")}.json`);
	const active = await call("get_active_scene");
	originalScenePath = active.path;
	if (!originalScenePath || originalScenePath === scenePath)
		throw new Error("The live scenario requires an existing active scene that can be restored after the disposable test scene.");
	if (!allowSceneSwitch)
		throw new Error("Set FBX_LIVE_ALLOW_SCENE_SWITCH=1 only for a disposable editor project; the test opens a temporary scene and restores the current one.");

	await call("create_scene", { path: scenePath });
	sceneCreated = true;
	const parent = await call("create_primitive_mesh", { type: "empty", name: parentName, position: [150, 35, -80] });
	if (!parent?.id) throw new Error(`Creating the FBX parent failed: ${JSON.stringify(parent)}`);
	sourceParentId = parent.id;
	const box = await call("create_primitive_mesh", {
		type: "box",
		name: `FBX Animated Box ${suffix}`,
		parentId: parent.id,
		position: [25, 15, 0],
		options: { width: 40, height: 30, depth: 20, wrap: true },
	});
	const sphere = await call("create_primitive_mesh", {
		type: "sphere",
		name: `FBX Detailed Sphere ${suffix}`,
		parentId: parent.id,
		position: [-35, 20, 10],
		options: { diameter: 28, segments: 24 },
	});
	if (!box?.id || !sphere?.id) throw new Error(`Creating FBX child meshes failed: ${JSON.stringify({ box, sphere })}`);
	const material = await call("create_material", { type: "pbr", name: `FBX Copper ${suffix}`, folder: assetFolder });
	if (!material?.id || !material?.path) throw new Error(`Creating the FBX material failed: ${JSON.stringify(material)}`);
	materialPath = material.path;
	await call("set_mesh_material", { nodeId: box.id, materialId: material.id });
	await call("set_mesh_material", { nodeId: sphere.id, materialId: material.id });
	await call("set_node_transform", { nodeId: sphere.id, rotation: [0.3, -0.5, 0.2], scaling: [1.1, 0.8, 1.35] });
	const animation = await call("create_animation", {
		nodeId: box.id,
		name: `FBX Box Motion ${suffix}`,
		targetProperty: "position",
		framesPerSecond: 30,
		loopMode: "cycle",
		keys: [
			{ frame: 0, value: [25, 15, 0], interpolation: "linear" },
			{ frame: 15, value: [25, 70, 20], interpolation: "linear" },
			{ frame: 30, value: [25, 15, 0], interpolation: "linear" },
		],
	});
	if (!animation?.name && !animation?.animationGroup?.name) throw new Error(`Creating the FBX animation failed: ${JSON.stringify(animation)}`);

	await call("focus_node", { nodeId: parent.id });
	fbxUi = await connectEditorUi(".flexlayout__tab_button");
	await fbxUi.clickText("Graph", ".flexlayout__tab_button");
	await waitForUi(
		() => fbxUi.evaluate(`[...document.querySelectorAll('[draggable="true"]')].some((entry)=>entry.textContent?.trim()===${JSON.stringify(parentName)})`),
		Boolean,
		"focused FBX source hierarchy in Graph"
	);
	await fbxUi.clickText(parentName, '[draggable="true"]', "right");
	await waitForUi(
		() => fbxUi.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].some((entry)=>entry.textContent?.trim() === "Export Selection as FBX...")`),
		Boolean,
		"FBX Graph context action"
	);
	await fbxUi.clickText("Export Selection as FBX...", '[role="menuitem"]');
	await waitForUi(() => fbxUi.evaluate("Boolean(document.querySelector('[data-testid=fbx-destination]'))"), Boolean, "FBX settings dialog");
	await fbxUi.setValue("[data-testid=fbx-destination]", join(projectDirectory, uiAssetPath));
	await fbxUi.setValue("[data-testid=fbx-global-scale]", 2);
	await fbxUi.click("[data-testid=fbx-apply-transforms]");
	await fbxUi.click("[data-testid=fbx-include-cameras]");
	await fbxUi.click("[data-testid=fbx-export]");
	await waitForUi(() => fbxUi.evaluate("!document.querySelector('[data-testid=fbx-destination]')"), Boolean, "completed FBX direct-UI export", 120_000);
	const uiOutput = await readFile(join(projectDirectory, uiAssetPath));
	if (binaryFbxVersion(uiOutput) !== 7400 || uiOutput.byteLength < 1_000) throw new Error("The direct-UI FBX export is not a valid binary FBX 7400 asset.");
	if (fbxUi.runtimeErrors.length) throw new Error(`FBX dialog renderer errors: ${fbxUi.runtimeErrors.join(" | ")}`);
	fbxUi.socket.close();
	fbxUi = null;

	const capabilities = await call("get_fbx_export_capabilities");
	if (capabilities.model !== "zvibe-fbx-export-v1" || capabilities.version !== 1 || capabilities.adapter !== "Blender glTF import plus binary FBX export") {
		throw new Error(`FBX capabilities are incomplete: ${JSON.stringify(capabilities)}`);
	}
	const inspectionInput = { path: assetPath, rootNodeIds: [parent.id], includeDescendants: true, settings, nodeOffset: 0, nodeLimit: 2 };
	let inspection = await call("inspect_fbx_export", inspectionInput);
	if (
		inspection.current ||
		inspection.exists ||
		!/^[a-f0-9]{64}$/.test(inspection.fingerprint) ||
		inspection.scope?.kind !== "nodes" ||
		inspection.scope?.nodes?.total !== 3 ||
		inspection.scope?.nodes?.count !== 2 ||
		inspection.scope?.nodes?.nextOffset !== 2 ||
		inspection.snapshot?.statistics?.meshCount < 2 ||
		inspection.snapshot?.statistics?.animationGroupCount < 1 ||
		inspection.snapshot?.statistics?.ancestorShellCount !== 0
	) {
		throw new Error(`Initial FBX inspection is incomplete: ${JSON.stringify(inspection)}`);
	}
	await call("inspect_fbx_export", { ...inspectionInput, rootNodeIds: [`missing-${suffix}`] }, true);
	const falseConfirmation = await call("export_fbx_asset", { ...inspectionInput, expectedFingerprint: inspection.fingerprint, confirm: false }, true);
	if (!String(falseConfirmation).includes("-32602")) throw new Error(`False FBX confirmation was not rejected by the schema: ${falseConfirmation}`);

	await call("set_node_transform", { nodeId: parent.id, position: [175, 35, -80], rotation: [0.1, 0.25, -0.15], scaling: [1.2, 0.9, 1.1] });
	const stale = await call("export_fbx_asset", { ...inspectionInput, expectedFingerprint: inspection.fingerprint, confirm: true }, true);
	if (!String(stale).includes("plan changed")) throw new Error(`Stale FBX lease was not rejected: ${stale}`);

	inspection = await call("inspect_fbx_export", inspectionInput);
	const exported = await call("export_fbx_asset", { ...inspectionInput, expectedFingerprint: inspection.fingerprint, confirm: true });
	if (
		!exported.current ||
		exported.fingerprint !== inspection.fingerprint ||
		exported.result?.evidence?.source?.sha256 !== exported.snapshot?.sha256 ||
		exported.result?.evidence?.statistics?.meshCount < 2 ||
		exported.result?.evidence?.statistics?.materialCount < 1 ||
		exported.result?.evidence?.statistics?.actionCount < 1
	) {
		throw new Error(`Real Blender FBX evidence is incomplete: ${JSON.stringify(exported)}`);
	}
	const outputAbsolutePath = join(projectDirectory, assetPath);
	const output = await readFile(outputAbsolutePath);
	const version = binaryFbxVersion(output);
	const outputSha256 = createHash("sha256").update(output).digest("hex");
	if (
		version !== exported.result.evidence.output.binaryVersion ||
		outputSha256 !== exported.result.evidence.output.sha256 ||
		output.length !== exported.result.evidence.output.bytes
	) {
		throw new Error("Published FBX bytes do not match the exact converter evidence.");
	}
	const privateManifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (privateManifest.fingerprint !== exported.fingerprint || privateManifest.destinationPath !== assetPath || privateManifest.evidence?.output?.sha256 !== outputSha256) {
		throw new Error(`Private FBX evidence does not bind the published bytes: ${JSON.stringify(privateManifest)}`);
	}
	const current = await call("inspect_fbx_export", inspectionInput);
	if (!current.current || current.fingerprint !== exported.fingerprint) throw new Error(`Published FBX did not re-inspect as current: ${JSON.stringify(current)}`);

	const roundTrip = await call("round_trip_fbx_export", {
		...inspectionInput,
		expectedFingerprint: current.fingerprint,
		confirm: true,
		name: importedName,
		position: [-120, 25, 60],
	});
	importedRootId = roundTrip.instance?.rootNodeId;
	if (
		!roundTrip.export?.current ||
		!roundTrip.importer?.current ||
		!roundTrip.importer?.valid ||
		!importedRootId ||
		roundTrip.importer?.statistics?.meshCount < 2 ||
		roundTrip.importer?.statistics?.materialCount < 1 ||
		roundTrip.importer?.statistics?.animationGroupCount < 1
	) {
		throw new Error(`FBX normal-importer round trip is incomplete: ${JSON.stringify(roundTrip)}`);
	}
	const importedNode = await call("get_node", { nodeId: importedRootId });
	if (importedNode.name !== importedName || importedNode.position?.[0] !== -120 || importedNode.position?.[1] !== 25 || importedNode.position?.[2] !== 60) {
		throw new Error(`Round-trip root transform/name did not survive instantiation: ${JSON.stringify(importedNode)}`);
	}
	await call("focus_node", { nodeId: importedRootId });
	const screenshot = await callImage("get_screenshot", { width: 960, height: 540 });
	if (screenshot.bytes.length < 5_000) throw new Error(`FBX screenshot is unexpectedly small (${screenshot.bytes.length} bytes).`);
	const screenshotSha256 = createHash("sha256").update(screenshot.bytes).digest("hex");

	await call("save_scene");
	await call("open_scene", { path: scenePath });
	await waitFor(
		() => safeCall("get_node", { nodeId: importedRootId }),
		(value) => value?.name === importedName,
		"serialized FBX round-trip root rebind"
	);
	const sourceAfterReload = await call("get_node", { nodeId: sourceParentId });
	if (sourceAfterReload.name !== parentName || sourceAfterReload.position?.[0] !== 175)
		throw new Error(`FBX source hierarchy did not survive save/reload: ${JSON.stringify(sourceAfterReload)}`);

	await call("delete_node", { nodeId: importedRootId });
	importedRootId = null;
	await call("delete_node", { nodeId: sourceParentId });
	sourceParentId = null;
	const deletedAssets = await call("delete_asset", { path: assetFolder, confirm: true });
	if (deletedAssets.removedFbxExportEvidence?.length !== 2) {
		throw new Error(`FBX export-evidence cleanup failed: ${JSON.stringify(deletedAssets)}`);
	}
	materialPath = null;
	await call("open_scene", { path: originalScenePath });
	await call("delete_scene", { path: scenePath, confirm: true });
	sceneCreated = false;
	await stat(join(projectDirectory, assetFolder)).then(
		() => {
			throw new Error("FBX asset folder still exists after cleanup.");
		},
		(error) => {
			if (error?.code !== "ENOENT") throw error;
		}
	);
	await stat(manifestPath).then(
		() => {
			throw new Error("FBX export-evidence manifest still exists after generic asset cleanup.");
		},
		(error) => {
			if (error?.code !== "ENOENT") throw error;
		}
	);
	completed = true;
	console.log(
		`[fbx-live] PASS — real Blender binary FBX ${version}, ${exported.result.evidence.statistics.meshCount} meshes/${exported.result.evidence.statistics.materialCount} materials/${exported.result.evidence.statistics.actionCount} actions, exact schema/lease/hash/manifest evidence, normal Assimp importer round-trip with ${roundTrip.importer.statistics.meshCount} meshes, ${screenshot.bytes.length}-byte ${screenshot.mimeType} screenshot ${screenshotSha256}, save/reload, and exact cleanup verified.`
	);
} catch (error) {
	console.error(`[fbx-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	// A failed export leaves the modal FBX dialog open, which blocks every later UI scenario; cancel it before disconnecting.
	await fbxUi
		?.evaluate(
			`(() => { let node = document.querySelector('[data-testid=fbx-destination]'); while (node && ![...node.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Cancel')) node = node.parentElement; [...(node?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === 'Cancel')?.click(); })()`
		)
		.catch(() => undefined);
	fbxUi?.socket?.close();
	if (!completed && !retainFixtures) {
		if (importedRootId) await safeCall("delete_node", { nodeId: importedRootId });
		if (sourceParentId) await safeCall("delete_node", { nodeId: sourceParentId });
		if (materialPath) await safeCall("delete_asset", { path: assetFolder, confirm: true });
		else if (projectDirectory) await rm(join(projectDirectory, assetFolder), { recursive: true, force: true });
		if (manifestPath) await rm(manifestPath, { force: true });
		if (sceneCreated && originalScenePath) {
			await safeCall("open_scene", { path: originalScenePath });
			await safeCall("delete_scene", { path: scenePath, confirm: true });
		}
	}
	if (!completed && retainFixtures) {
		console.error(`[fbx-live] retained diagnostic asset folder: ${assetFolder}`);
		if (sceneCreated) console.error(`[fbx-live] retained diagnostic scene: ${scenePath}`);
	}
	child.stdin.end();
	setTimeout(() => child.kill("SIGTERM"), 1000).unref();
}
