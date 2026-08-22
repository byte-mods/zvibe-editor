import { createHash } from "crypto";
import { createReadStream } from "fs";
import { tmpdir } from "os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "path";

import { ensureDir, lstat, mkdtemp, move, pathExists, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";

import { AbstractMesh, Camera, Light, Matrix, Node, Quaternion, Scene, TransformNode, Vector3 } from "babylonjs";
import { convertGlbFileToFbx, IFbxConversionResult } from "babylonjs-editor-cli";
import {
	FBX_EXPORT_MAX_OUTPUT_BYTES,
	FBX_EXPORT_MAX_SOURCE_BYTES,
	FBX_EXPORT_MODEL,
	FBX_EXPORT_VERSION,
	getDefaultFbxExportSettings,
	IFbxExportEvidence,
	IFbxExportSettings,
	normalizeFbxExportSettings,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import { instantiateMeshAsset } from "./assets";
import { getFbxExportManifestPath, withFbxExportLane } from "./fbx-export-state";
import { applyModelImporterArtifact, getModelImporterArtifactStatus } from "./model-importer";
import { refreshAssetRegistryPaths } from "./registry";

const EXPORT_FILE_NAME = "zvibe-fbx-source";
const MAXIMUM_ROOT_NODES = 256;
const MAXIMUM_EXPORTED_NODES = 10_000;
const fingerprintPattern = /^[a-f0-9]{64}$/;
type TFbxGltf2Export = typeof import("babylonjs-serializers").GLTF2Export;
let fbxGltf2Export: TFbxGltf2Export | null = null;

/** Resolves the build-time CJS bridge first because Electron's renderer does not expose the legacy UMD package's named exports. */
export function resolveFbxGltf2Export(loadModule: NodeJS.Require = require, compiledDirectory: string = __dirname): TFbxGltf2Export {
	const useCache = loadModule === require && compiledDirectory === __dirname;
	if (useCache && fbxGltf2Export) {
		return fbxGltf2Export;
	}
	const candidates = [resolve(compiledDirectory, "../../../babylonjs-serializers.cjs"), "babylonjs-serializers"];
	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			const loaded = loadModule(candidate) as { GLTF2Export?: TFbxGltf2Export };
			if (typeof loaded.GLTF2Export?.GLBAsync === "function") {
				if (useCache) {
					fbxGltf2Export = loaded.GLTF2Export;
				}
				return loaded.GLTF2Export;
			}
			failures.push(`${candidate}: GLTF2Export.GLBAsync is unavailable`);
		} catch (error) {
			failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`FBX export could not load Babylon's glTF serializer. Rebuild the Editor before retrying. ${failures.join("; ")}`);
}

interface IFbxExportScope {
	kind: "scene" | "nodes";
	includeDescendants: boolean;
	rootNodeIds: string[];
	nodeIds: string[];
}

interface IFbxExportSnapshotStatistics {
	nodeCount: number;
	ancestorShellCount: number;
	meshCount: number;
	transformNodeCount: number;
	cameraCount: number;
	lightCount: number;
	materialCount: number;
	skeletonCount: number;
	animationGroupCount: number;
}

interface IFbxExportSnapshot {
	content: Uint8Array;
	sha256: string;
	scope: IFbxExportScope;
	statistics: IFbxExportSnapshotStatistics;
}

interface IFbxExportManifest {
	version: 1;
	fingerprint: string;
	destinationPath: string;
	generatedAt: string;
	scope: IFbxExportScope;
	snapshot: { bytes: number; sha256: string; statistics: IFbxExportSnapshotStatistics };
	evidence: IFbxExportEvidence;
	executable: string;
}

interface IFbxExportStatus {
	path: string;
	absolutePath: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	settings: IFbxExportSettings;
	scope: IFbxExportScope;
	snapshot: { bytes: number; sha256: string; statistics: IFbxExportSnapshotStatistics };
	result: IFbxExportManifest | null;
	_content: Uint8Array;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

/** Restricts authored FBX output to one ordinary project asset and never follows a caller-supplied sidecar path. */
function resolveDestinationPath(value: unknown): { absolutePath: string; projectPath: string; manifestPath: string } {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) {
		throw new Error("FBX destination path must be a non-empty project path of at most 4,096 characters.");
	}
	const root = projectDirectory();
	const absolutePath = normalize(isAbsolute(value) ? value : join(root, value));
	if (absolutePath === root || !absolutePath.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error("FBX destination paths must stay inside the open project directory.");
	}
	const projectPath = relative(root, absolutePath).replace(/\\/g, "/");
	if (!projectPath.startsWith("assets/") || extname(projectPath).toLowerCase() !== ".fbx") {
		throw new Error("FBX exports must be .fbx files inside the project assets directory.");
	}
	const manifestPath = getFbxExportManifestPath(root, projectPath);
	return { absolutePath, projectPath, manifestPath };
}

/** Walks existing output ancestors so a project-contained lexical path cannot escape through a symbolic link. */
async function rejectSymbolicLinkPath(absolutePath: string): Promise<void> {
	const root = projectDirectory();
	const segments = relative(root, absolutePath).split(/[\\/]/).filter(Boolean);
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new Error("FBX destination paths cannot contain symbolic links.");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
	}
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a Boolean.`);
	}
	return value;
}

function normalizeRootNodeIds(value: unknown): string[] | null {
	if (value === undefined) {
		return null;
	}
	if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_ROOT_NODES) {
		throw new Error(`FBX rootNodeIds must contain from 1 through ${MAXIMUM_ROOT_NODES} exact node ids.`);
	}
	const result = value.map((entry) => {
		if (typeof entry !== "string" || !entry || entry.length > 1024 || entry.includes("\0")) {
			throw new Error("Every FBX rootNodeId must be a non-empty string of at most 1,024 characters.");
		}
		return entry;
	});
	if (new Set(result).size !== result.length) {
		throw new Error("FBX rootNodeIds must be unique.");
	}
	return result.sort();
}

function allSceneNodes(scene: Scene): Node[] {
	const result = new Set<Node>();
	for (const root of scene.rootNodes) {
		result.add(root);
		for (const descendant of root.getDescendants(false)) {
			result.add(descendant);
		}
	}
	return [...result];
}

function exactNodeIds(nodes: Node[]): string[] {
	const ids = nodes.map((node) => node.id);
	if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
		throw new Error("Every node in an FBX export scope must have a non-empty unique id.");
	}
	return ids.sort();
}

function resolveScope(scene: Scene, rootNodeIds: string[] | null, includeDescendants: boolean): { scope: IFbxExportScope; nodes: Set<Node> } {
	const sceneNodes = allSceneNodes(scene);
	if (sceneNodes.length > MAXIMUM_EXPORTED_NODES) {
		throw new Error(`FBX export supports at most ${MAXIMUM_EXPORTED_NODES.toLocaleString()} scene nodes.`);
	}
	if (!rootNodeIds) {
		if (!sceneNodes.length) {
			throw new Error("The scene has no nodes to export to FBX.");
		}
		return {
			scope: { kind: "scene", includeDescendants: true, rootNodeIds: [], nodeIds: exactNodeIds(sceneNodes) },
			nodes: new Set(sceneNodes),
		};
	}
	const byId = new Map<string, Node[]>();
	for (const node of sceneNodes) {
		const matches = byId.get(node.id) ?? [];
		matches.push(node);
		byId.set(node.id, matches);
	}
	const roots = rootNodeIds.map((id) => {
		const matches = byId.get(id) ?? [];
		if (matches.length !== 1) {
			throw new Error(matches.length ? `FBX root node id ${id} is ambiguous.` : `FBX root node id ${id} was not found.`);
		}
		return matches[0];
	});
	const selected = new Set<Node>(roots);
	if (includeDescendants) {
		for (const root of roots) {
			for (const descendant of root.getDescendants(false)) {
				selected.add(descendant);
			}
		}
	}
	if (selected.size > MAXIMUM_EXPORTED_NODES) {
		throw new Error(`FBX export selection supports at most ${MAXIMUM_EXPORTED_NODES.toLocaleString()} nodes.`);
	}
	return {
		scope: { kind: "nodes", includeDescendants, rootNodeIds, nodeIds: exactNodeIds([...selected]) },
		nodes: selected,
	};
}

function snapshotStatistics(scene: Scene, nodes: Set<Node>): IFbxExportSnapshotStatistics {
	const meshes = [...nodes].filter((node): node is AbstractMesh => node instanceof AbstractMesh);
	const targetedNodes = new Set(nodes);
	return {
		nodeCount: nodes.size,
		ancestorShellCount: 0,
		meshCount: meshes.length,
		transformNodeCount: [...nodes].filter((node) => node instanceof TransformNode).length,
		cameraCount: [...nodes].filter((node) => node instanceof Camera).length,
		lightCount: [...nodes].filter((node) => node instanceof Light).length,
		materialCount: new Set(meshes.flatMap((mesh) => (mesh.material ? [mesh.material] : []))).size,
		skeletonCount: new Set(meshes.flatMap((mesh) => (mesh.skeleton ? [mesh.skeleton] : []))).size,
		animationGroupCount: scene.animationGroups.filter((group) =>
			group.targetedAnimations.some((animation) => animation.target instanceof Node && targetedNodes.has(animation.target))
		).length,
	};
}

interface IAncestorShellScope {
	exportNodes: Set<Node>;
	dispose: () => void;
	count: number;
}

/** Recreates excluded ancestors as transform-only shells, preserving selected world transforms without leaking ancestor mesh geometry into a node export. */
function createAncestorShellScope(scene: Scene, nodes: Set<Node>): IAncestorShellScope {
	const shellBySource = new Map<Node, TransformNode>();
	const originalParents = new Map<Node, Node | null>();
	const boundaryNodes = [...nodes].filter((node) => node.parent && !nodes.has(node.parent));
	for (const node of allSceneNodes(scene)) {
		if (node instanceof TransformNode) {
			node.computeWorldMatrix(true);
		}
	}
	const createShell = (source: Node): TransformNode => {
		const existing = shellBySource.get(source);
		if (existing) {
			return existing;
		}
		const parent = source.parent ? (nodes.has(source.parent) ? source.parent : createShell(source.parent)) : null;
		const world = source.getWorldMatrix().clone();
		const local = source.parent ? world.multiply(Matrix.Invert(source.parent.getWorldMatrix())) : world;
		const scaling = new Vector3();
		const rotation = new Quaternion();
		const position = new Vector3();
		if (!local.decompose(scaling, rotation, position)) {
			throw new Error(`FBX export could not decompose excluded ancestor ${source.name || source.id} into a transform shell.`);
		}
		const shell = new TransformNode(source.name || "FBX Transform", scene);
		shell.id = `__zvibe_fbx_shell_${shell.uniqueId}`;
		shell.position.copyFrom(position);
		shell.scaling.copyFrom(scaling);
		shell.rotationQuaternion = rotation;
		shell.parent = parent;
		shellBySource.set(source, shell);
		return shell;
	};
	try {
		for (const node of boundaryNodes) {
			const originalParent = node.parent;
			if (!originalParent) {
				continue;
			}
			originalParents.set(node, originalParent);
			node.parent = createShell(originalParent);
		}
	} catch (error) {
		for (const [node, parent] of originalParents) {
			node.parent = parent;
		}
		for (const shell of [...shellBySource.values()].reverse()) {
			shell.dispose();
		}
		throw error;
	}
	return {
		exportNodes: new Set([...nodes, ...shellBySource.values()]),
		count: shellBySource.size,
		dispose: () => {
			for (const [node, parent] of originalParents) {
				node.parent = parent;
			}
			for (const shell of [...shellBySource.values()].reverse()) {
				shell.dispose();
			}
		},
	};
}

function validateGlb(content: Uint8Array): void {
	if (content.byteLength < 20 || content.byteLength > FBX_EXPORT_MAX_SOURCE_BYTES) {
		throw new Error(`Babylon generated an invalid or oversized FBX source snapshot (${content.byteLength.toLocaleString()} bytes).`);
	}
	const header = new DataView(content.buffer, content.byteOffset, content.byteLength);
	if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== content.byteLength) {
		throw new Error("Babylon generated a malformed GLB v2 snapshot for FBX export.");
	}
}

/** Serializes only the requested live nodes so the lease covers geometry, transforms, materials, rigs, and animations rather than project-file timestamps. */
async function createSnapshot(scene: Scene, rootNodeIds: string[] | null, includeDescendants: boolean, includeAnimations: boolean): Promise<IFbxExportSnapshot> {
	const { scope, nodes } = resolveScope(scene, rootNodeIds, includeDescendants);
	const ancestorScope = createAncestorShellScope(scene, nodes);
	try {
		const data = await resolveFbxGltf2Export().GLBAsync(scene, EXPORT_FILE_NAME, {
			shouldExportNode: (node) => ancestorScope.exportNodes.has(node),
			shouldExportAnimation: () => includeAnimations,
			exportWithoutWaitingForScene: true,
			removeNoopRootNodes: false,
		});
		const file = data.files[`${EXPORT_FILE_NAME}.glb`];
		if (!file || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") {
			throw new Error("Babylon did not produce the expected binary GLB snapshot for FBX export.");
		}
		const content = new Uint8Array(await (file as Blob).arrayBuffer());
		validateGlb(content);
		const statistics = snapshotStatistics(scene, nodes);
		statistics.ancestorShellCount = ancestorScope.count;
		return {
			content,
			sha256: createHash("sha256").update(content).digest("hex"),
			scope,
			statistics,
		};
	} finally {
		ancestorScope.dispose();
	}
}

async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolvePromise, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolvePromise);
	});
	return hash.digest("hex");
}

function exportFingerprint(snapshot: IFbxExportSnapshot, destinationPath: string, settings: IFbxExportSettings): string {
	return createHash("sha256")
		.update(snapshot.sha256)
		.update("\0")
		.update(destinationPath)
		.update("\0")
		.update(JSON.stringify(snapshot.scope))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

async function readCurrentManifest(
	manifestPath: string,
	absolutePath: string,
	fingerprint: string,
	destinationPath: string,
	snapshot: IFbxExportSnapshot,
	settings: IFbxExportSettings
): Promise<IFbxExportManifest | null> {
	try {
		const manifest = (await readJSON(manifestPath)) as IFbxExportManifest;
		if (
			manifest?.version !== 1 ||
			manifest.fingerprint !== fingerprint ||
			manifest.destinationPath !== destinationPath ||
			JSON.stringify(manifest.scope) !== JSON.stringify(snapshot.scope) ||
			manifest.snapshot?.bytes !== snapshot.content.byteLength ||
			manifest.snapshot.sha256 !== snapshot.sha256 ||
			JSON.stringify(manifest.snapshot.statistics) !== JSON.stringify(snapshot.statistics) ||
			!manifest.evidence ||
			manifest.evidence.model !== FBX_EXPORT_MODEL ||
			manifest.evidence.version !== FBX_EXPORT_VERSION ||
			manifest.evidence.source.bytes !== snapshot.content.byteLength ||
			manifest.evidence.source.sha256 !== snapshot.sha256 ||
			JSON.stringify(manifest.evidence.settings) !== JSON.stringify(settings) ||
			typeof manifest.executable !== "string" ||
			!manifest.executable
		) {
			return null;
		}
		const details = await stat(absolutePath);
		if (!details.isFile() || details.size !== manifest.evidence.output.bytes || details.size > FBX_EXPORT_MAX_OUTPUT_BYTES) {
			return null;
		}
		return (await fileSha256(absolutePath)) === manifest.evidence.output.sha256 ? manifest : null;
	} catch {
		return null;
	}
}

async function inspectStatus(scene: Scene, data: any): Promise<IFbxExportStatus> {
	const destination = resolveDestinationPath(data.path);
	await rejectSymbolicLinkPath(destination.absolutePath);
	await rejectSymbolicLinkPath(destination.manifestPath);
	const settings = normalizeFbxExportSettings(data.settings);
	const rootNodeIds = normalizeRootNodeIds(data.rootNodeIds);
	const includeDescendants = boolean(data.includeDescendants, true, "FBX includeDescendants");
	const snapshot = await createSnapshot(scene, rootNodeIds, includeDescendants, settings.includeAnimations);
	const fingerprint = exportFingerprint(snapshot, destination.projectPath, settings);
	const result = await readCurrentManifest(destination.manifestPath, destination.absolutePath, fingerprint, destination.projectPath, snapshot, settings);
	return {
		path: destination.projectPath,
		absolutePath: destination.absolutePath,
		manifestPath: destination.manifestPath,
		fingerprint,
		current: result !== null,
		exists: (await pathExists(destination.absolutePath)) || (await pathExists(destination.manifestPath)),
		settings,
		scope: snapshot.scope,
		snapshot: { bytes: snapshot.content.byteLength, sha256: snapshot.sha256, statistics: snapshot.statistics },
		result,
		_content: snapshot.content,
	};
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value as number;
}

function portableStatus(status: IFbxExportStatus, data: any): any {
	const nodeOffset = boundedInteger(data.nodeOffset, 0, 0, status.scope.nodeIds.length, "FBX nodeOffset");
	const nodeLimit = boundedInteger(data.nodeLimit, 100, 1, 500, "FBX nodeLimit");
	const nodes = status.scope.nodeIds.slice(nodeOffset, nodeOffset + nodeLimit);
	return {
		path: status.path,
		fingerprint: status.fingerprint,
		current: status.current,
		exists: status.exists,
		settings: status.settings,
		scope: {
			kind: status.scope.kind,
			includeDescendants: status.scope.includeDescendants,
			rootNodeIds: status.scope.rootNodeIds,
			nodes: {
				total: status.scope.nodeIds.length,
				offset: nodeOffset,
				count: nodes.length,
				nextOffset: nodeOffset + nodes.length < status.scope.nodeIds.length ? nodeOffset + nodes.length : null,
				items: nodes,
			},
		},
		snapshot: status.snapshot,
		result: status.result
			? {
					generatedAt: status.result.generatedAt,
					evidence: status.result.evidence,
					executable: status.result.executable,
				}
			: null,
	};
}

function refreshEditor(options: IMCPActionOptions): void {
	options.editor.layout.assets?.refresh?.();
	void options.editor.layout.graph.refresh();
	options.editor.layout.inspector.forceUpdate();
}

/** Publishes output and evidence together while retaining the previous complete pair until both replacements are ready. */
async function publishExport(status: IFbxExportStatus, converted: IFbxConversionResult): Promise<void> {
	const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const outputTemporaryPath = `${status.absolutePath}.tmp-${nonce}`;
	const outputBackupPath = `${status.absolutePath}.bak-${nonce}`;
	const manifestTemporaryPath = `${status.manifestPath}.tmp-${nonce}`;
	const manifestBackupPath = `${status.manifestPath}.bak-${nonce}`;
	const manifest: IFbxExportManifest = {
		version: 1,
		fingerprint: status.fingerprint,
		destinationPath: status.path,
		generatedAt: new Date().toISOString(),
		scope: status.scope,
		snapshot: status.snapshot,
		evidence: converted.evidence,
		executable: converted.executable,
	};
	await ensureDir(dirname(status.absolutePath));
	await ensureDir(dirname(status.manifestPath));
	await writeFile(outputTemporaryPath, converted.content, { mode: 0o600 });
	await writeJSON(manifestTemporaryPath, manifest, { spaces: "\t", mode: 0o600 });
	let backedUpOutput = false;
	let backedUpManifest = false;
	let installedOutput = false;
	let installedManifest = false;
	try {
		if (await pathExists(status.absolutePath)) {
			await move(status.absolutePath, outputBackupPath);
			backedUpOutput = true;
		}
		if (await pathExists(status.manifestPath)) {
			await move(status.manifestPath, manifestBackupPath);
			backedUpManifest = true;
		}
		await move(outputTemporaryPath, status.absolutePath);
		installedOutput = true;
		await move(manifestTemporaryPath, status.manifestPath);
		installedManifest = true;
		await remove(outputBackupPath);
		await remove(manifestBackupPath);
	} catch (error) {
		if (installedOutput) {
			await remove(status.absolutePath).catch(() => undefined);
		}
		if (installedManifest) {
			await remove(status.manifestPath).catch(() => undefined);
		}
		if (backedUpOutput) {
			await move(outputBackupPath, status.absolutePath, { overwrite: true }).catch(() => undefined);
		}
		if (backedUpManifest) {
			await move(manifestBackupPath, status.manifestPath, { overwrite: true }).catch(() => undefined);
		}
		throw error;
	} finally {
		await remove(outputTemporaryPath).catch(() => undefined);
		await remove(manifestTemporaryPath).catch(() => undefined);
		await remove(outputBackupPath).catch(() => undefined);
		await remove(manifestBackupPath).catch(() => undefined);
	}
}

/** Reports the exact portable FBX authoring boundary shared by the Editor UI and MCP clients. */
export function getFbxExportCapabilities(): any {
	return {
		model: FBX_EXPORT_MODEL,
		version: FBX_EXPORT_VERSION,
		input: "live Babylon scene or exact node roots",
		outputExtensions: [".fbx"],
		adapter: "Blender glTF import plus binary FBX export",
		defaultSettings: getDefaultFbxExportSettings(),
		limits: { sourceBytes: FBX_EXPORT_MAX_SOURCE_BYTES, outputBytes: FBX_EXPORT_MAX_OUTPUT_BYTES, rootNodes: MAXIMUM_ROOT_NODES, exportedNodes: MAXIMUM_EXPORTED_NODES },
		features: ["meshes", "materials", "embedded textures", "skeletons", "animations", "cameras", "lights", "scene export", "node selection", "round-trip reimport"],
		clients: ["Codex CLI", "Claude-compatible MCP clients"],
	};
}

/** Returns a fresh GLB-bound lease and verifies any previously published FBX without mutating project state. */
export async function inspectFbxExport(scene: Scene, data: any): Promise<any> {
	return portableStatus(await inspectStatus(scene, data), data);
}

/** Converts and atomically publishes an exact inspected scene/node snapshot as a binary FBX project asset. */
export async function applyFbxExport(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("FBX export requires confirm=true because it can replace an existing project asset.");
	}
	if (typeof data.expectedFingerprint !== "string" || !fingerprintPattern.test(data.expectedFingerprint)) {
		throw new Error("FBX expectedFingerprint must be the exact 64-character SHA-256 returned by inspect_fbx_export.");
	}
	const destination = resolveDestinationPath(data.path);
	return withFbxExportLane(destination.absolutePath, async () => {
		const status = await inspectStatus(scene, data);
		if (status.absolutePath !== destination.absolutePath) {
			throw new Error("The open project changed while FBX export was waiting. Inspect the export again in the current project.");
		}
		if (status.fingerprint !== data.expectedFingerprint) {
			throw new Error(`FBX export plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
		}
		if (status.current) {
			await refreshAssetRegistryPaths([status.absolutePath]);
			refreshEditor(options);
			return portableStatus(status, data);
		}
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "zvibe-editor-fbx-"));
		try {
			const sourcePath = join(temporaryDirectory, `${basename(status.absolutePath, extname(status.absolutePath))}.glb`);
			await writeFile(sourcePath, status._content, { mode: 0o600 });
			const converted = await convertGlbFileToFbx(sourcePath, { settings: status.settings });
			if (
				converted.evidence.source.bytes !== status.snapshot.bytes ||
				converted.evidence.source.sha256 !== status.snapshot.sha256 ||
				converted.evidence.output.bytes !== converted.content.byteLength ||
				converted.evidence.output.sha256 !== createHash("sha256").update(converted.content).digest("hex") ||
				JSON.stringify(converted.evidence.settings) !== JSON.stringify(status.settings)
			) {
				throw new Error("FBX converter evidence does not match the exact inspected snapshot, settings, or output bytes.");
			}
			const revalidated = await inspectStatus(scene, data);
			if (revalidated.absolutePath !== status.absolutePath || revalidated.manifestPath !== status.manifestPath) {
				throw new Error("The open project changed during FBX conversion. Inspect the export again in the current project.");
			}
			if (revalidated.fingerprint !== status.fingerprint) {
				throw new Error(`FBX export plan changed during conversion. Inspect again and use current fingerprint ${revalidated.fingerprint}.`);
			}
			await publishExport(status, converted);
			await refreshAssetRegistryPaths([status.absolutePath]);
			refreshEditor(options);
			const applied = await inspectStatus(scene, data);
			if (!applied.current || applied.fingerprint !== status.fingerprint) {
				throw new Error("FBX export publication could not be verified against the exact live scene snapshot.");
			}
			return portableStatus(applied, data);
		} finally {
			await remove(temporaryDirectory).catch(() => undefined);
		}
	});
}

/** Exports, runs the normal model-importer artifact pipeline, and instantiates the result through the ordinary asset path. */
export async function roundTripFbxExport(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const exported = await applyFbxExport(scene, data, options);
	const destination = resolveDestinationPath(data.path);
	let importer = await getModelImporterArtifactStatus(destination.absolutePath);
	if (!importer.current) {
		importer = await applyModelImporterArtifact(destination.absolutePath, importer.fingerprint);
	}
	if (!importer.current || !importer.result?.valid || !importer.result.outputPath) {
		throw new Error("The exported FBX could not be processed by the normal model importer for round-trip instantiation.");
	}
	await refreshAssetRegistryPaths([destination.absolutePath, importer.result.outputPath]);
	const instance = await instantiateMeshAsset(
		scene,
		{
			path: destination.projectPath,
			name: data.name,
			parentId: data.parentId,
			parentName: data.parentName,
			position: data.position,
		},
		options
	);
	return {
		export: exported,
		importer: {
			fingerprint: importer.fingerprint,
			current: importer.current,
			valid: importer.result.valid,
			outputPath: relative(projectDirectory(), importer.result.outputPath).replace(/\\/g, "/"),
			statistics: {
				meshCount: importer.result.meshCount,
				vertexCount: importer.result.vertexCount,
				triangleCount: importer.result.triangleCount,
				materialCount: importer.result.materialCount,
				textureCount: importer.result.textureCount,
				animationGroupCount: importer.result.animationGroupCount,
				skeletonCount: importer.result.skeletonCount,
			},
		},
		instance,
	};
}
