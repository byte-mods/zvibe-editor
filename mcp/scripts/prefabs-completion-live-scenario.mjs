#!/usr/bin/env node
/** Positive real-editor lifecycle for every previously uncovered Prefabs MCP tool. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function rpc(method, params, timeoutMs = 180_000) {
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

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	if (response.error || result?.isError === true) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	return content ? JSON.parse(content) : result;
}

const required = [
	"get_prefab",
	"create_prefab",
	"create_prefab_variant",
	"inspect_prefab_review",
	"set_prefab_review",
	"add_prefab_review_comment",
	"submit_prefab_review_decision",
	"inspect_prefab_variant_rebase",
	"inspect_prefab_variant_conflicts",
	"resolve_prefab_variant_conflicts",
	"rebase_prefab_variant",
	"set_prefab_variant_overrides",
	"inspect_prefab_variant_structure",
	"set_prefab_variant_structure",
	"inspect_prefab_variant_components",
	"set_prefab_variant_components",
	"set_prefab_asset_node_properties",
	"set_prefab_asset_nodes_properties",
	"set_prefab_stage_settings",
	"open_prefab_stage",
	"close_prefab_stage",
	"inspect_prefab_asset_node_property",
	"set_prefab_asset_node_property",
	"inspect_prefab_instance_links",
	"inspect_prefab_instance_overrides",
	"apply_prefab_instance_overrides",
	"revert_prefab_instance_overrides",
	"inspect_prefab_instances_overrides",
	"apply_prefab_instances_overrides",
	"revert_prefab_instances_overrides",
	"open_prefab_bulk_overrides",
	"close_prefab_bulk_overrides",
	"inspect_prefab_instance_structure",
	"capture_prefab_instance_structure",
	"compare_prefab_instances",
	"apply_prefab_instance_boundary",
	"revert_prefab_instance_boundary",
	"unpack_prefab_instance",
	"promote_prefab_instance_boundary_overrides",
	"apply_prefab_instance_root",
	"revert_prefab_instance_root",
	"apply_prefab_instance_node",
	"revert_prefab_instance_node",
	"instantiate_prefab",
];

const suffix = `${Date.now()}-${process.pid}`;
const folder = `assets/mcp-prefabs-${suffix}`;
const paths = {
	base: `${folder}/base.prefab`,
	second: `${folder}/second.prefab`,
	variant: `${folder}/variant.prefab`,
	child: `${folder}/child.prefab`,
	outerBase: `${folder}/outer-base.prefab`,
	promotion: `${folder}/promotion.prefab`,
	conflictBase: `${folder}/conflict-base.prefab`,
	conflictVariant: `${folder}/conflict-variant.prefab`,
};
const nodeIds = new Set();
const instanceRootIds = new Set();
let originalStage;
let reviewTouched = false;

function rememberNode(node) {
	if (node?.id) nodeIds.add(node.id);
	return node;
}

function bulkOperations(inspection) {
	return inspection.targets.map((target) => {
		const row = inspection.entries.find((entry) => entry.targetId === target.targetId && entry.entry.kind === "position");
		if (!row) throw new Error(`Bulk Prefab inspection has no position row for ${target.rootNodeName}.`);
		return {
			targetId: target.targetId,
			nodeId: target.nodeId,
			targetPath: target.targetPath,
			targetIndex: target.targetIndex,
			expectedRevision: target.revision,
			expectedFingerprint: target.fingerprint,
			entryIds: [row.entry.id],
		};
	});
}

async function cleanup() {
	await call("close_prefab_bulk_overrides").catch(() => undefined);
	await call("close_prefab_stage").catch(() => undefined);
	if (originalStage) {
		const current = await call("get_prefab_stage_settings").catch(() => undefined);
		if (current?.fingerprint) await call("set_prefab_stage_settings", { expectedFingerprint: current.fingerprint, settings: originalStage.settings }).catch(() => undefined);
	}
	for (const id of [...instanceRootIds, ...nodeIds].reverse()) await call("delete_node", { nodeId: id }).catch(() => undefined);
	for (const path of [...Object.values(paths).reverse(), folder]) await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	if (reviewTouched) {
		const cleanupName = `prefab-review-cleanup-${suffix}.js`;
		const source = `
import { dirname, join } from "path";
import { pathExists, readJSON, writeJSON } from "fs-extra";
export async function main(editor) {
	const path = join(dirname(editor.state.projectPath), ".babylon-editor", "prefab-reviews.json");
	if (!(await pathExists(path))) return "no review file";
	const document = await readJSON(path);
	if (Array.isArray(document.reviews)) document.reviews = document.reviews.filter((entry) => entry.path !== ${JSON.stringify(paths.base)});
	else if (document.reviews && typeof document.reviews === "object") delete document.reviews[${JSON.stringify(paths.base)}];
	await writeJSON(path, document, { spaces: "\t" });
	return "review entry removed";
}`;
		await call("run_agent_script", { name: cleanupName, content: source }).catch(() => undefined);
		for (const path of [
			`agentdata/${cleanupName}`,
			`.bjseditor/agent-scripts/${cleanupName.replace(/\.js$/, ".cjs")}`,
			`.bjseditor/agent-scripts/${cleanupName.replace(/\.js$/, ".cjs.map")}`,
		]) {
			await call("delete_asset", { path, confirm: true }).catch(() => undefined);
		}
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prefabs-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Prefabs completion testing.");

	const root = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP Prefab Root ${suffix}`, position: [0, 100, 0], options: { size: 100 } }));
	const childNode = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP Prefab Child ${suffix}`, position: [0, 60, 0], options: { size: 50 } }));
	await call("set_node_parent", { nodeId: childNode.id, parentId: root.id });
	await call("set_node_properties", { nodeId: root.id, properties: { "metadata.gameplay": { health: 100 } } });
	await call("set_node_properties", { nodeId: childNode.id, properties: { "metadata.rendering": { exposure: 1 } } });
	const createdBase = await call("create_prefab", { nodeId: root.id, path: paths.base });
	if (!createdBase.created) throw new Error("Base Prefab creation evidence is incomplete.");
	let baseDocument = await call("get_prefab", { path: paths.base });
	const rootSource = baseDocument.meshes[0].metadata.babylonEditorPrefabSourceNodeName;
	const childSource = baseDocument.meshes.find((mesh) => mesh !== baseDocument.meshes[0]).metadata.babylonEditorPrefabSourceNodeName;

	await call("create_prefab_variant", {
		basePath: paths.base,
		path: paths.variant,
		rootOverrides: { visibility: 0.9 },
		nodeOverrides: [{ nodeName: childSource, properties: { position: [0, 80, 0] } }],
		propertyOverrides: [{ nodeName: rootSource, path: "/metadata/gameplay/health", value: 150 }],
		structuralOverrides: {
			removals: [],
			additions: [{ nodeName: "AddedTransform", displayName: "Added Transform", parentNodeName: rootSource, kind: "transform", properties: { position: [25, 0, 0] } }],
			reparents: [],
		},
		componentOverrides: { additions: [{ nodeName: childSource, componentKey: "combatStats", value: { damage: 25 } }], removals: [] },
	});
	let rebase = await call("inspect_prefab_variant_rebase", { path: paths.variant });
	await call("rebase_prefab_variant", { path: paths.variant, expectedBaseRevision: rebase.baseRevision, confirm: true });
	rebase = await call("inspect_prefab_variant_rebase", { path: paths.variant });
	await call("set_prefab_variant_overrides", {
		path: paths.variant,
		expectedRevision: rebase.resolvedRevision,
		rootOverrides: rebase.rootOverrides,
		nodeOverrides: rebase.nodeOverrides,
		propertyOverrides: rebase.propertyOverrides,
		structuralOverrides: rebase.structuralOverrides,
		componentOverrides: rebase.componentOverrides,
		confirm: true,
	});
	let structure = await call("inspect_prefab_variant_structure", { path: paths.variant });
	await call("set_prefab_variant_structure", { path: paths.variant, expectedRevision: structure.revision, structuralOverrides: structure.structuralOverrides, confirm: true });
	let components = await call("inspect_prefab_variant_components", { path: paths.variant });
	await call("set_prefab_variant_components", { path: paths.variant, expectedRevision: components.revision, componentOverrides: components.componentOverrides, confirm: true });
	rebase = await call("inspect_prefab_variant_rebase", { path: paths.variant });
	await call("set_prefab_asset_node_properties", {
		path: paths.variant,
		sourceNodeName: childSource,
		properties: { scaling: [1.1, 1.1, 1.1] },
		expectedRevision: rebase.resolvedRevision,
		confirm: true,
	});
	rebase = await call("inspect_prefab_variant_rebase", { path: paths.variant });
	await call("set_prefab_asset_nodes_properties", {
		path: paths.variant,
		expectedRevision: rebase.resolvedRevision,
		changes: [
			{ sourceNodeName: rootSource, properties: { visibility: 0.85 } },
			{ sourceNodeName: childSource, properties: { isVisible: true } },
		],
		confirm: true,
	});
	let property = await call("inspect_prefab_asset_node_property", { path: paths.variant, sourceNodeName: rootSource, propertyPath: "/metadata/gameplay/health" });
	await call("set_prefab_asset_node_property", {
		path: paths.variant,
		sourceNodeName: rootSource,
		propertyPath: "/metadata/gameplay/health",
		value: 175,
		expectedRevision: property.revision,
		confirm: true,
	});

	originalStage = await call("get_prefab_stage_settings");
	const stageSettings = {
		...originalStage.settings,
		mode: "isolation",
		contextAppearance: "gray",
		showOverrides: true,
		autoSave: false,
		environment: "neutral",
		backgroundColor: [0.08, 0.09, 0.12, 1],
		lightIntensity: 1.25,
	};
	await call("set_prefab_stage_settings", { expectedFingerprint: originalStage.fingerprint, settings: stageSettings });
	await call("open_prefab_stage", { path: paths.variant, mode: "isolation" });
	await call("close_prefab_stage");

	let review = await call("inspect_prefab_review", { path: paths.base, offset: 0, limit: 20 });
	review = await call("set_prefab_review", {
		path: paths.base,
		expectedReviewFingerprint: review.fingerprint,
		expectedPrefabRevision: review.currentRevision,
		title: `MCP Prefab Review ${suffix}`,
		reviewers: [{ id: "mcp-reviewer", name: "MCP Reviewer" }],
		action: "requestReview",
		actorId: "mcp-owner",
		actorName: "MCP Owner",
		confirm: true,
	});
	reviewTouched = true;
	review = await call("add_prefab_review_comment", {
		path: paths.base,
		expectedReviewFingerprint: review.review.fingerprint,
		expectedPrefabRevision: review.review.currentRevision,
		body: "Prefab lifecycle verified through MCP.",
		actorId: "mcp-reviewer",
		actorName: "MCP Reviewer",
		confirm: true,
	});
	review = await call("submit_prefab_review_decision", {
		path: paths.base,
		expectedReviewFingerprint: review.review.fingerprint,
		expectedPrefabRevision: review.review.currentRevision,
		decision: "approve",
		body: "Approved by live verification.",
		actorId: "mcp-reviewer",
		actorName: "MCP Reviewer",
		confirm: true,
	});
	if (review.review.approval?.status !== "approved") throw new Error("Prefab review approval evidence is incomplete.");

	let instance = await call("instantiate_prefab", { path: paths.variant, name: `MCP Variant Instance ${suffix}`, position: [300, 0, 0] });
	instanceRootIds.add(instance.root.id);
	let links = await call("inspect_prefab_instance_links", { nodeId: instance.root.id });
	if (!links.links?.length) throw new Error("Prefab instance link evidence is incomplete.");
	await call("set_node_transform", { nodeId: instance.root.id, position: [350, 0, 0] });
	let overrides = await call("inspect_prefab_instance_overrides", { nodeId: instance.root.id, categories: ["transform"], offset: 0, limit: 500 });
	let positionEntry = overrides.entries.find((entry) => entry.kind === "position");
	await call("apply_prefab_instance_overrides", {
		nodeId: instance.root.id,
		expectedRevision: overrides.revision,
		expectedFingerprint: overrides.fingerprint,
		entryIds: [positionEntry.id],
		confirm: true,
	});
	await call("set_node_transform", { nodeId: instance.root.id, position: [425, 0, 0] });
	overrides = await call("inspect_prefab_instance_overrides", { nodeId: instance.root.id, categories: ["transform"], offset: 0, limit: 500 });
	positionEntry = overrides.entries.find((entry) => entry.kind === "position");
	await call("revert_prefab_instance_overrides", {
		nodeId: instance.root.id,
		expectedRevision: overrides.revision,
		expectedFingerprint: overrides.fingerprint,
		entryIds: [positionEntry.id],
		confirm: true,
	});
	await call("apply_prefab_instance_root", { nodeId: instance.root.id });
	await call("revert_prefab_instance_root", { nodeId: instance.root.id });
	const nestedInstanceNode = instance.meshes.find((mesh) => mesh.id !== instance.root.id);
	await call("apply_prefab_instance_node", { nodeId: nestedInstanceNode.id });
	await call("revert_prefab_instance_node", { nodeId: nestedInstanceNode.id });
	links = await call("inspect_prefab_instance_links", { nodeId: instance.root.id });
	await call("apply_prefab_instance_boundary", {
		nodeId: instance.root.id,
		targetPath: links.links[0].path,
		targetIndex: 0,
		expectedRevision: links.links[0].revision,
		transformVisibility: true,
		confirm: true,
	});
	links = await call("inspect_prefab_instance_links", { nodeId: instance.root.id });
	await call("revert_prefab_instance_boundary", {
		nodeId: instance.root.id,
		targetPath: links.links[0].path,
		targetIndex: 0,
		expectedRevision: links.links[0].revision,
		transformVisibility: true,
		confirm: true,
	});
	const compared = await call("compare_prefab_instances", { path: paths.variant, limit: 50 });
	if (!compared.instanceCount) throw new Error("Prefab instance comparison evidence is incomplete.");

	const captureInstance = await call("instantiate_prefab", { path: paths.variant, name: `MCP Capture Instance ${suffix}`, position: [600, 0, 0] });
	instanceRootIds.add(captureInstance.root.id);
	const added = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP Captured Child ${suffix}`, position: [600, 50, 0], options: { size: 25 } }));
	await call("set_node_parent", { nodeId: added.id, parentId: captureInstance.root.id });
	const liveStructure = await call("inspect_prefab_instance_structure", { nodeId: captureInstance.root.id });
	if (!liveStructure.hasStructuralOverrides) throw new Error("Live Prefab structural inspection found no addition.");
	await call("capture_prefab_instance_structure", { nodeId: captureInstance.root.id, expectedRevision: liveStructure.revision, confirm: true });

	const unpackedInstance = await call("instantiate_prefab", { path: paths.base, name: `MCP Unpack Instance ${suffix}`, position: [800, 0, 0] });
	instanceRootIds.add(unpackedInstance.root.id);
	await call("unpack_prefab_instance", { nodeId: unpackedInstance.root.id, mode: "completely", confirm: true });

	const secondRoot = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP Second Prefab Root ${suffix}`, position: [0, 0, 300], options: { size: 80 } }));
	await call("create_prefab", { nodeId: secondRoot.id, path: paths.second });
	const bulkOne = await call("instantiate_prefab", { path: paths.base, name: `MCP Bulk One ${suffix}` });
	const bulkTwo = await call("instantiate_prefab", { path: paths.second, name: `MCP Bulk Two ${suffix}` });
	instanceRootIds.add(bulkOne.root.id);
	instanceRootIds.add(bulkTwo.root.id);
	await call("set_node_transform", { nodeId: bulkOne.root.id, position: [1000, 0, 0] });
	await call("set_node_transform", { nodeId: bulkTwo.root.id, position: [1200, 0, 0] });
	const bulkTargets = [
		{ nodeId: bulkOne.root.id, targetPath: paths.base, targetIndex: 0 },
		{ nodeId: bulkTwo.root.id, targetPath: paths.second, targetIndex: 0 },
	];
	let bulk = await call("inspect_prefab_instances_overrides", { targets: bulkTargets, categories: ["transform"], offset: 0, limit: 500 });
	await call("open_prefab_bulk_overrides", { targets: bulkTargets });
	await call("close_prefab_bulk_overrides");
	let bulkResult = await call("apply_prefab_instances_overrides", {
		expectedBatchFingerprint: bulk.batchFingerprint,
		operations: bulkOperations(bulk),
		mode: "atomic",
		confirm: true,
	});
	if (bulkResult.succeeded !== 2) throw new Error("Bulk Prefab apply evidence is incomplete.");
	await call("set_node_transform", { nodeId: bulkOne.root.id, position: [1300, 0, 0] });
	await call("set_node_transform", { nodeId: bulkTwo.root.id, position: [1400, 0, 0] });
	bulk = await call("inspect_prefab_instances_overrides", { targets: bulkTargets, categories: ["transform"], offset: 0, limit: 500 });
	bulkResult = await call("revert_prefab_instances_overrides", {
		expectedBatchFingerprint: bulk.batchFingerprint,
		operations: bulkOperations(bulk),
		mode: "atomic",
		confirm: true,
	});
	if (bulkResult.succeeded !== 2) throw new Error("Bulk Prefab revert evidence is incomplete.");

	const childPrefabRoot = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP ChildRoot ${suffix}`, position: [0, 0, 0], options: { size: 60 } }));
	const childPrefabLeaf = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP ChildLeaf ${suffix}`, position: [0, 50, 0], options: { size: 30 } }));
	await call("set_node_parent", { nodeId: childPrefabLeaf.id, parentId: childPrefabRoot.id });
	await call("set_node_properties", { nodeId: childPrefabLeaf.id, properties: { "metadata.rendering": { exposure: 1 } } });
	await call("create_prefab", { nodeId: childPrefabRoot.id, path: paths.child });
	const childDoc = await call("get_prefab", { path: paths.child });
	const childRootSource = childDoc.meshes[0].metadata.babylonEditorPrefabSourceNodeName;
	const childLeafSource = childDoc.meshes.find((mesh) => mesh !== childDoc.meshes[0]).metadata.babylonEditorPrefabSourceNodeName;
	const outerRoot = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP OuterRoot ${suffix}`, position: [0, 0, 0], options: { size: 120 } }));
	await call("create_prefab", { nodeId: outerRoot.id, path: paths.outerBase });
	const outerDoc = await call("get_prefab", { path: paths.outerBase });
	const outerSource = outerDoc.meshes[0].metadata.babylonEditorPrefabSourceNodeName;
	await call("create_prefab_variant", {
		basePath: paths.outerBase,
		path: paths.promotion,
		nodeOverrides: [{ nodeName: `NestedWeapon/${childLeafSource}`, properties: { position: [4, 5, 6] } }],
		propertyOverrides: [{ nodeName: `NestedWeapon/${childLeafSource}`, path: "/metadata/rendering/exposure", value: 2.5 }],
		componentOverrides: { additions: [{ nodeName: "NestedWeapon", componentKey: "weaponStats", value: { damage: 50 } }], removals: [] },
		structuralOverrides: {
			removals: [],
			additions: [
				{ nodeName: "NestedWeapon", displayName: "Nested Weapon", parentNodeName: outerSource, kind: "nestedPrefab", prefabPath: paths.child, properties: {} },
				{ nodeName: "Socket", displayName: "Socket", parentNodeName: "NestedWeapon", kind: "transform", properties: { position: [1, 0, 0] } },
			],
			reparents: [{ nodeName: `NestedWeapon/${childLeafSource}`, parentNodeName: "Socket" }],
		},
	});
	const promotionInstance = await call("instantiate_prefab", { path: paths.promotion, name: `MCP Promotion Instance ${suffix}`, position: [1600, 0, 0] });
	instanceRootIds.add(promotionInstance.root.id);
	let nestedLinks;
	let nestedNode;
	for (const candidate of [...promotionInstance.meshes, ...promotionInstance.transformNodes]) {
		const candidateLinks = await call("inspect_prefab_instance_links", { nodeId: candidate.id });
		if (candidateLinks.links?.some((entry) => entry.path === paths.child)) {
			nestedLinks = candidateLinks;
			nestedNode = candidate;
			break;
		}
	}
	if (!nestedLinks || !nestedNode) throw new Error("Nested Prefab boundary evidence is incomplete.");
	const targetIndex = nestedLinks.links.findIndex((entry) => entry.path === paths.child);
	await call("promote_prefab_instance_boundary_overrides", {
		nodeId: nestedNode.id,
		targetPath: paths.child,
		targetIndex,
		expectedContainerRevision: nestedLinks.links[targetIndex - 1].revision,
		expectedTargetRevision: nestedLinks.links[targetIndex].revision,
		categories: ["transforms", "properties", "components", "structure"],
		confirm: true,
	});

	const conflictRoot = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP ConflictRoot ${suffix}`, position: [0, 0, 0], options: { size: 50 } }));
	const conflictChild = rememberNode(await call("create_primitive_mesh", { type: "box", name: `MCP ConflictChild ${suffix}`, position: [0, 50, 0], options: { size: 20 } }));
	await call("set_node_parent", { nodeId: conflictChild.id, parentId: conflictRoot.id });
	await call("create_prefab", { nodeId: conflictRoot.id, path: paths.conflictBase });
	const conflictBase = await call("get_prefab", { path: paths.conflictBase });
	const conflictChildSource = conflictBase.meshes.find((mesh) => mesh !== conflictBase.meshes[0]).metadata.babylonEditorPrefabSourceNodeName;
	await call("create_prefab_variant", {
		basePath: paths.conflictBase,
		path: paths.conflictVariant,
		nodeOverrides: [{ nodeName: conflictChildSource, properties: { position: [1, 2, 3] } }],
	});
	const replacementRoot = rememberNode(await call("create_primitive_mesh", { type: "box", name: conflictBase.meshes[0].name, position: [0, 0, 0], options: { size: 50 } }));
	await call("create_prefab", { nodeId: replacementRoot.id, path: paths.conflictBase, overwrite: true });
	const conflictedRebase = await call("inspect_prefab_variant_rebase", { path: paths.conflictVariant });
	if (!conflictedRebase.conflicts?.length) throw new Error("Prefab conflict setup did not produce a conflict.");
	const conflictInspection = await call("inspect_prefab_variant_conflicts", { path: paths.conflictVariant, offset: 0, limit: 500 });
	const resolved = await call("resolve_prefab_variant_conflicts", {
		path: paths.conflictVariant,
		expectedRevision: conflictInspection.revision,
		expectedBaseRevision: conflictInspection.baseRevision,
		resolutions: conflictInspection.conflicts.map((conflict) => ({ conflictId: conflict.id, choice: "base" })),
		confirm: true,
	});
	if (!resolved.resolved || resolved.remainingConflicts?.length) throw new Error("Prefab conflict resolution evidence is incomplete.");

	await cleanup();
	console.log(
		`[prefabs-completion-live] PASS — ${required.length}/${required.length} previously uncovered tools, asset/variant/review/stage/instance/bulk/nested lifecycles, and MCP-only cleanup verified.`
	);
} catch (error) {
	await cleanup().catch(() => undefined);
	console.error(`[prefabs-completion-live] FAIL — ${error.stack ?? error.message}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}
