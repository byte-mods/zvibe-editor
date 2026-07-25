import { createHash, randomUUID } from "crypto";

import { AbstractMesh, Node, Quaternion, Scene, TransformNode, Vector3 } from "babylonjs";
import {
	configureGameObjectComponents,
	gameObjectComponentStackVersion,
	normalizeEntityComponentData,
	normalizeNetworkComponentData,
	type GameObjectComponentType,
	type ISerializedGameObjectComponent,
	type ISerializedGameObjectComponentStack,
} from "babylonjs-editor-tools";

import { isAbstractMesh } from "../../tools/guards/nodes";
import { ensureNodeMetadata } from "../../tools/node/metadata";
import { onNodeModifiedObservable } from "../../tools/observables";
import { parsePhysicsAggregate, serializePhysicsAggregate } from "../../tools/physics/serialization/aggregate";
import { registerUndoRedo } from "../../tools/undoredo";

import { IMCPActionOptions } from "../action";
import { setMeshPhysics } from "../meshes/meshes";
import { attachScript } from "../scripts/scripts";
import { resolveNode, toNodeSummary } from "../tools/resolve";

const maxComponents = 128;
const maxJsonBytes = 64 * 1024;
const componentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type ComponentType = "transform" | GameObjectComponentType;

interface IComponentDefinition {
	type: ComponentType;
	label: string;
	description: string;
	allowMultiple: boolean;
	duplicateRule: string;
	removable: boolean;
	canToggle: boolean;
	requiredTypes: ComponentType[];
}

interface IPhysicsSnapshot {
	serialized: any;
	filterMembershipMask: number;
	filterCollideMask: number;
	collisionLayer: string | null;
}

interface INodeComponentSnapshot {
	stack: ISerializedGameObjectComponentStack | null;
	scripts: any[] | null;
	transform: {
		position: number[] | null;
		rotation: number[] | null;
		rotationQuaternion: number[] | null;
		scaling: number[] | null;
	};
	physics: IPhysicsSnapshot | null;
}

interface IComponentClipboard {
	fingerprint: string;
	type: ComponentType;
	sourceNodeId: string;
	sourceComponentId: string;
	payload: any;
}

const componentDefinitions: Record<ComponentType, IComponentDefinition> = {
	transform: {
		type: "transform",
		label: "Transform",
		description: "The required Babylon node transform. It is always first and cannot be removed or disabled.",
		allowMultiple: false,
		duplicateRule: "Exactly one required Transform exists on every node.",
		removable: false,
		canToggle: false,
		requiredTypes: [],
	},
	data: {
		type: "data",
		label: "Data Component",
		description: "A versioned JSON component exposed to behavior scripts at runtime through babylonjs-editor-tools.",
		allowMultiple: true,
		duplicateRule: "Multiple data components are allowed; every row has an independent stable id.",
		removable: true,
		canToggle: true,
		requiredTypes: ["transform"],
	},
	script: {
		type: "script",
		label: "Behavior Script",
		description: "An adapter over an existing TypeScript behavior attachment; its established runtime lifecycle remains authoritative.",
		allowMultiple: true,
		duplicateRule: "Multiple script components are allowed, but the same project script path may be attached only once per node.",
		removable: true,
		canToggle: true,
		requiredTypes: ["transform"],
	},
	physics3d: {
		type: "physics3d",
		label: "Physics Body 3D",
		description: "An adapter over the mesh's real Havok PhysicsAggregate.",
		allowMultiple: false,
		duplicateRule: "At most one Physics Body 3D may own the node's PhysicsAggregate.",
		removable: true,
		canToggle: false,
		requiredTypes: ["transform"],
	},
	entity: {
		type: "entity",
		label: "Entity (ECS)",
		description:
			"Marks the node for data-oriented baking: an archetype name plus numeric fields that bake into struct-of-arrays chunks a data-oriented runtime can iterate without touching Babylon nodes.",
		allowMultiple: false,
		duplicateRule: "At most one Entity component may define a node's archetype.",
		removable: true,
		canToggle: true,
		requiredTypes: ["transform"],
	},
	network: {
		type: "network",
		label: "Network Replication",
		description:
			"Marks the node as replicated and authors its multiplayer contract: authority, transform/animation sync, send rate and interpolation. The editor authors the contract; a project-provided transport consumes it at runtime through babylonjs-editor-tools.",
		allowMultiple: false,
		duplicateRule: "At most one Network Replication component may own a node's replication contract.",
		removable: true,
		canToggle: true,
		requiredTypes: ["transform"],
	},
};

let componentClipboard: IComponentClipboard | null = null;

function jsonClone<T>(value: T): T {
	return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)])
		);
	}
	return value;
}

function hash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function assertFiniteJson(value: unknown, path = "value", depth = 0): void {
	if (depth > 8) {
		throw new Error(`${path} exceeds the maximum JSON depth of 8.`);
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`${path} contains a non-finite number.`);
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 1024) {
			throw new Error(`${path} exceeds the maximum array length of 1024.`);
		}
		value.forEach((child, index) => assertFiniteJson(child, `${path}[${index}]`, depth + 1));
		return;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > 256) {
			throw new Error(`${path} exceeds the maximum object property count of 256.`);
		}
		entries.forEach(([key, child]) => {
			if (!key || key.length > 128 || key === "__proto__" || key === "prototype" || key === "constructor") {
				throw new Error(`${path} contains an unsafe or oversized property name.`);
			}
			assertFiniteJson(child, `${path}.${key}`, depth + 1);
		});
		return;
	}
	throw new Error(`${path} must contain only JSON-compatible values.`);
}

function validateJsonObject(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be a JSON object.`);
	}
	assertFiniteJson(value, path);
	const clone = jsonClone(value as Record<string, unknown>);
	if (Buffer.byteLength(JSON.stringify(clone), "utf8") > maxJsonBytes) {
		throw new Error(`${path} exceeds the maximum serialized size of ${maxJsonBytes} bytes.`);
	}
	return clone;
}

function createComponentId(): string {
	return randomUUID();
}

function validateSerializedComponent(component: ISerializedGameObjectComponent, index: number): void {
	if (!componentIdPattern.test(component.id)) {
		throw new Error(`Component ${index} has an invalid stable id.`);
	}
	if (component.type !== "data" && component.type !== "script" && component.type !== "physics3d" && component.type !== "network" && component.type !== "entity") {
		throw new Error(`Component ${index} has unsupported type "${String(component.type)}".`);
	}
	if (typeof component.enabled !== "boolean") {
		throw new Error(`Component ${index} must have a boolean enabled state.`);
	}
	validateJsonObject(component.data, `components[${index}].data`);
	if (component.type === "data") {
		const name = component.data.name;
		if (typeof name !== "string" || !name.trim() || name.length > 80) {
			throw new Error(`Data component ${index} must have a name between 1 and 80 characters.`);
		}
		validateJsonObject(component.data.values ?? {}, `components[${index}].data.values`);
	}
}

function getStack(node: Node, persist: boolean): ISerializedGameObjectComponentStack {
	const metadata = persist ? ensureNodeMetadata(node) : node.metadata;
	const existing = metadata?.babylonEditorComponentStack as ISerializedGameObjectComponentStack | undefined;
	if (!existing) {
		const created: ISerializedGameObjectComponentStack = { version: gameObjectComponentStackVersion, components: [] };
		if (persist) {
			metadata.babylonEditorComponentStack = created;
		}
		return created;
	}
	if (existing.version !== gameObjectComponentStackVersion) {
		throw new Error(
			`Node "${node.name}" uses unsupported component stack version ${String(existing.version)}. This editor supports version ${gameObjectComponentStackVersion}.`
		);
	}
	if (!Array.isArray(existing.components) || existing.components.length > maxComponents) {
		throw new Error(`Node "${node.name}" has an invalid component stack or exceeds ${maxComponents} components.`);
	}
	const ids = new Set<string>();
	const scriptAttachmentIds = new Set<string>();
	let physicsCount = 0;
	existing.components.forEach((component, index) => {
		validateSerializedComponent(component, index);
		if (ids.has(component.id)) {
			throw new Error(`Node "${node.name}" has duplicate component id "${component.id}".`);
		}
		ids.add(component.id);
		if (component.type === "script") {
			const attachmentId = component.data.attachmentId;
			if (typeof attachmentId !== "string" || !componentIdPattern.test(attachmentId) || scriptAttachmentIds.has(attachmentId)) {
				throw new Error(`Node "${node.name}" has an invalid or duplicate script adapter reference at component ${index}.`);
			}
			scriptAttachmentIds.add(attachmentId);
		}
		if (component.type === "physics3d" && ++physicsCount > 1) {
			throw new Error(`Node "${node.name}" has multiple Physics Body 3D rows, but only one PhysicsAggregate is supported.`);
		}
	});
	return persist ? existing : jsonClone(existing);
}

function deterministicAdapterId(prefix: string, node: Node, source: unknown): string {
	return `${prefix}-${hash({ nodeId: node.id, source }).slice(0, 32)}`;
}

function synchronizeAdapters(node: Node, persist = false): ISerializedGameObjectComponentStack {
	const stack = getStack(node, persist);
	const scripts = Array.isArray(node.metadata?.scripts) ? node.metadata.scripts : [];
	const scriptIds = new Set<string>();

	scripts.forEach((script: any, index: number) => {
		const attachmentId =
			typeof script._id === "string" && componentIdPattern.test(script._id) ? script._id : deterministicAdapterId("script-attachment", node, `${script.key}:${index}`);
		if (persist) {
			script._id = attachmentId;
		}
		scriptIds.add(attachmentId);
		let descriptor = stack.components.find((component) => component.type === "script" && component.data.attachmentId === attachmentId);
		if (!descriptor) {
			if (stack.components.length >= maxComponents) {
				throw new Error(`Node "${node.name}" cannot migrate another script because its component stack already contains ${maxComponents} rows.`);
			}
			descriptor = {
				id: deterministicAdapterId("script-component", node, attachmentId),
				type: "script",
				enabled: script.enabled !== false,
				data: { attachmentId },
			};
			stack.components.push(descriptor);
		}
		descriptor.enabled = script.enabled !== false;
	});
	stack.components = stack.components.filter((component) => component.type !== "script" || scriptIds.has(String(component.data.attachmentId)));

	const mesh = isAbstractMesh(node) ? node : null;
	const hasPhysics = Boolean(mesh?.physicsAggregate);
	let physicsComponentId = node.metadata?.babylonEditorPhysicsComponentId;
	if (hasPhysics) {
		if (typeof physicsComponentId !== "string" || !componentIdPattern.test(physicsComponentId)) {
			physicsComponentId = stack.components.find((component) => component.type === "physics3d")?.id ?? deterministicAdapterId("physics-component", node, "physics3d");
			if (persist) {
				node.metadata.babylonEditorPhysicsComponentId = physicsComponentId;
			}
		}
		if (!stack.components.some((component) => component.type === "physics3d")) {
			if (stack.components.length >= maxComponents) {
				throw new Error(`Node "${node.name}" cannot migrate its physics body because its component stack already contains ${maxComponents} rows.`);
			}
			stack.components.push({ id: physicsComponentId, type: "physics3d", enabled: true, data: {} });
		}
	} else {
		stack.components = stack.components.filter((component) => component.type !== "physics3d");
		if (persist) {
			delete node.metadata.babylonEditorPhysicsComponentId;
		}
	}

	return stack;
}

function vectorArray(value: unknown): number[] | null {
	return value instanceof Vector3 ? value.asArray() : null;
}

function describeTransform(node: Node): any {
	const object = node as any;
	return {
		position: vectorArray(object.position),
		rotation: vectorArray(object.rotation),
		rotationQuaternion: object.rotationQuaternion instanceof Quaternion ? object.rotationQuaternion.asArray() : null,
		scaling: vectorArray(object.scaling),
	};
}

function describePhysics(node: Node): any | null {
	if (!isAbstractMesh(node) || !node.physicsAggregate) {
		return null;
	}
	const serialized = serializePhysicsAggregate(node.physicsAggregate);
	return {
		...jsonClone(serialized),
		filterMembershipMask: node.physicsAggregate.shape.filterMembershipMask ?? 1,
		filterCollideMask: node.physicsAggregate.shape.filterCollideMask ?? 0xffffffff,
		collisionLayer: node.metadata?.babylonEditorPhysicsCollisionLayer ?? null,
	};
}

function getScript(node: Node, descriptor: ISerializedGameObjectComponent): any | null {
	return (
		node.metadata?.scripts?.find((script: any, index: number) => {
			const attachmentId =
				typeof script._id === "string" && componentIdPattern.test(script._id) ? script._id : deterministicAdapterId("script-attachment", node, `${script.key}:${index}`);
			return attachmentId === descriptor.data.attachmentId;
		}) ?? null
	);
}

function componentPayload(node: Node, descriptor: ISerializedGameObjectComponent): any {
	if (descriptor.type === "data") {
		return { name: descriptor.data.name, values: jsonClone(descriptor.data.values ?? {}) };
	}
	if (descriptor.type === "entity") {
		return normalizeEntityComponentData(descriptor.data);
	}
	if (descriptor.type === "network") {
		// Always report the normalized contract, so the Inspector and MCP show
		// the exact values a runtime transport will observe.
		return normalizeNetworkComponentData(descriptor.data);
	}
	if (descriptor.type === "script") {
		const script = getScript(node, descriptor);
		return script
			? {
					path: `src/${script.key}`,
					executionOrder: script.executionOrder ?? 0,
					values: jsonClone(script.values ?? {}),
				}
			: null;
	}
	return describePhysics(node);
}

function componentLabel(node: Node, descriptor: ISerializedGameObjectComponent): string {
	if (descriptor.type === "data") {
		return String(descriptor.data.name);
	}
	if (descriptor.type === "script") {
		return getScript(node, descriptor)?.key ?? "Missing behavior script";
	}
	// Every other row is labelled from its own registered definition. Falling
	// back to a hard-coded physics label mislabels any newly registered type.
	return componentDefinitions[descriptor.type].label;
}

function describeComponents(node: Node): any[] {
	const stack = synchronizeAdapters(node);
	const components: any[] = [
		{
			id: "transform",
			type: "transform",
			label: componentDefinitions.transform.label,
			order: 0,
			enabled: true,
			virtual: true,
			removable: false,
			canToggle: false,
			allowMultiple: false,
			requiredTypes: [],
			data: describeTransform(node),
		},
		...stack.components.map((component, index) => ({
			id: component.id,
			type: component.type,
			label: componentLabel(node, component),
			order: index + 1,
			enabled: component.enabled,
			virtual: false,
			removable: componentDefinitions[component.type].removable,
			canToggle: componentDefinitions[component.type].canToggle,
			allowMultiple: componentDefinitions[component.type].allowMultiple,
			requiredTypes: componentDefinitions[component.type].requiredTypes,
			data: componentPayload(node, component),
		})),
	];

	return components.map((component) => ({
		...component,
		dependentIds: components
			.filter(
				(candidate) =>
					candidate.id !== component.id &&
					candidate.requiredTypes.includes(component.type) &&
					!components.some((other) => other.id !== component.id && other.type === component.type)
			)
			.map((candidate) => candidate.id),
	}));
}

function componentFingerprint(node: Node): string {
	return hash({ nodeId: node.id, components: describeComponents(node) });
}

function assertFingerprint(node: Node, expectedFingerprint: unknown): void {
	if (typeof expectedFingerprint !== "string" || expectedFingerprint !== componentFingerprint(node)) {
		throw new Error(`Component stack changed after inspection. Call inspect_game_object_components again and use its exact fingerprint.`);
	}
}

function resolveComponent(node: Node, componentId: unknown, persist = false): { descriptor: ISerializedGameObjectComponent | null; type: ComponentType; index: number } {
	if (componentId === "transform") {
		return { descriptor: null, type: "transform", index: 0 };
	}
	if (typeof componentId !== "string") {
		throw new Error("componentId must be a stable component id returned by inspect_game_object_components.");
	}
	const stack = synchronizeAdapters(node, persist);
	const index = stack.components.findIndex((component) => component.id === componentId);
	if (index === -1) {
		throw new Error(`Component "${componentId}" was not found on node "${node.name}".`);
	}
	return { descriptor: stack.components[index], type: stack.components[index].type, index: index + 1 };
}

function captureSnapshot(node: Node): INodeComponentSnapshot {
	return {
		stack: node.metadata?.babylonEditorComponentStack ? jsonClone(node.metadata.babylonEditorComponentStack) : null,
		scripts: Array.isArray(node.metadata?.scripts) ? jsonClone(node.metadata.scripts) : null,
		transform: describeTransform(node),
		physics: describePhysics(node)
			? {
					serialized: jsonClone(serializePhysicsAggregate((node as AbstractMesh).physicsAggregate!)),
					filterMembershipMask: (node as AbstractMesh).physicsAggregate!.shape.filterMembershipMask ?? 1,
					filterCollideMask: (node as AbstractMesh).physicsAggregate!.shape.filterCollideMask ?? 0xffffffff,
					collisionLayer: node.metadata?.babylonEditorPhysicsCollisionLayer ?? null,
				}
			: null,
	};
}

function restoreVector(target: unknown, value: number[] | null): void {
	if (target instanceof Vector3 && value) {
		target.copyFromFloats(value[0], value[1], value[2]);
	}
}

function restorePhysics(node: Node, snapshot: IPhysicsSnapshot | null): void {
	if (!isAbstractMesh(node)) {
		return;
	}
	const current = describePhysics(node);
	const target = snapshot
		? {
				...snapshot.serialized,
				filterMembershipMask: snapshot.filterMembershipMask,
				filterCollideMask: snapshot.filterCollideMask,
				collisionLayer: snapshot.collisionLayer,
			}
		: null;
	if (hash(current) === hash(target)) {
		return;
	}
	node.physicsAggregate?.dispose();
	node.physicsBody = null;
	node.physicsAggregate = null;
	delete node.metadata?.physicsAggregate;
	if (!snapshot) {
		return;
	}
	const aggregate = parsePhysicsAggregate(node as TransformNode, snapshot.serialized);
	aggregate.body.disableSync = true;
	aggregate.shape.filterMembershipMask = snapshot.filterMembershipMask;
	aggregate.shape.filterCollideMask = snapshot.filterCollideMask;
	node.physicsAggregate = aggregate;
	node.physicsBody = aggregate.body;
	node.metadata ??= {};
	node.metadata.physicsAggregate = jsonClone(snapshot.serialized);
	if (snapshot.collisionLayer) {
		node.metadata.babylonEditorPhysicsCollisionLayer = snapshot.collisionLayer;
	} else {
		delete node.metadata.babylonEditorPhysicsCollisionLayer;
	}
}

function restoreSnapshot(node: Node, snapshot: INodeComponentSnapshot): void {
	node.metadata ??= {};
	if (snapshot.stack) {
		node.metadata.babylonEditorComponentStack = jsonClone(snapshot.stack);
	} else {
		delete node.metadata.babylonEditorComponentStack;
	}
	if (snapshot.scripts) {
		node.metadata.scripts = jsonClone(snapshot.scripts);
	} else {
		delete node.metadata.scripts;
	}
	const object = node as any;
	restoreVector(object.position, snapshot.transform.position);
	restoreVector(object.rotation, snapshot.transform.rotation);
	restoreVector(object.scaling, snapshot.transform.scaling);
	if (object.rotationQuaternion instanceof Quaternion && snapshot.transform.rotationQuaternion) {
		object.rotationQuaternion.copyFrom(Quaternion.FromArray(snapshot.transform.rotationQuaternion));
	}
	restorePhysics(node, snapshot.physics);
}

function refresh(node: Node, options: IMCPActionOptions): void {
	configureGameObjectComponents(node.getScene() as any);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	onNodeModifiedObservable.notifyObservers(node);
}

function mutate(node: Node, options: IMCPActionOptions, mutation: () => void): void {
	const before = captureSnapshot(node);
	try {
		mutation();
		synchronizeAdapters(node, true);
	} catch (error) {
		restoreSnapshot(node, before);
		throw error;
	}
	const after = captureSnapshot(node);
	registerUndoRedo({
		undo: () => restoreSnapshot(node, before),
		redo: () => restoreSnapshot(node, after),
		action: () => refresh(node, options),
	});
	refresh(node, options);
}

function setTransformValues(node: Node, values: any): void {
	if (!values || typeof values !== "object" || Array.isArray(values)) {
		throw new Error("transform must be an object containing position, rotation, and/or scaling arrays.");
	}
	const object = node as any;
	for (const property of ["position", "rotation", "scaling"] as const) {
		if (values[property] === undefined) {
			continue;
		}
		if (!(object[property] instanceof Vector3)) {
			throw new Error(`Node "${node.name}" does not expose ${property}.`);
		}
		if (!Array.isArray(values[property]) || values[property].length !== 3 || !values[property].every(Number.isFinite)) {
			throw new Error(`${property} must be a finite [x,y,z] array.`);
		}
		object[property].copyFromFloats(values[property][0], values[property][1], values[property][2]);
		if (property === "rotation" && object.rotationQuaternion instanceof Quaternion) {
			object.rotationQuaternion.copyFrom(Vector3.FromArray(values[property]).toQuaternion());
		}
	}
}

function resetComponentValues(node: Node, component: ReturnType<typeof resolveComponent>, options: IMCPActionOptions): void {
	if (component.type === "transform") {
		setTransformValues(node, { position: [0, 0, 0], rotation: [0, 0, 0], scaling: [1, 1, 1] });
		return;
	}
	const descriptor = component.descriptor!;
	if (descriptor.type === "data") {
		descriptor.enabled = true;
		descriptor.data = { name: "Data Component", values: {} };
		return;
	}
	if (descriptor.type === "script") {
		const script = getScript(node, descriptor);
		if (!script) {
			throw new Error("The behavior attachment no longer exists.");
		}
		script.enabled = true;
		script.executionOrder = 0;
		script.values = {};
		descriptor.enabled = true;
		return;
	}
	setMeshPhysics(node.getScene(), { nodeId: node.id, enabled: false }, options);
	setMeshPhysics(node.getScene(), { nodeId: node.id, enabled: true, shapeType: "box", motionType: "dynamic", mass: 1, friction: 0.2, restitution: 0.2 }, options);
}

function applyClipboardValues(node: Node, component: ReturnType<typeof resolveComponent>, clipboard: IComponentClipboard, options: IMCPActionOptions): void {
	if (component.type !== clipboard.type) {
		throw new Error(`Clipboard contains ${clipboard.type}, but target component is ${component.type}.`);
	}
	if (component.type === "transform") {
		setTransformValues(node, clipboard.payload);
		return;
	}
	const descriptor = component.descriptor!;
	if (descriptor.type === "data") {
		descriptor.enabled = clipboard.payload.enabled;
		descriptor.data = jsonClone(clipboard.payload.data);
		return;
	}
	if (descriptor.type === "script") {
		const script = getScript(node, descriptor);
		if (!script) {
			throw new Error("The behavior attachment no longer exists.");
		}
		script.enabled = clipboard.payload.enabled;
		script.executionOrder = clipboard.payload.executionOrder;
		script.values = jsonClone(clipboard.payload.values);
		descriptor.enabled = script.enabled;
		return;
	}
	setMeshPhysics(node.getScene(), { nodeId: node.id, enabled: false }, options);
	const serialized = clipboard.payload.serialized;
	const aggregate = parsePhysicsAggregate(node as TransformNode, serialized);
	aggregate.body.disableSync = true;
	aggregate.shape.filterMembershipMask = clipboard.payload.filterMembershipMask;
	aggregate.shape.filterCollideMask = clipboard.payload.filterCollideMask;
	(node as AbstractMesh).physicsAggregate = aggregate;
	(node as AbstractMesh).physicsBody = aggregate.body;
	node.metadata ??= {};
	if (clipboard.payload.collisionLayer) {
		node.metadata.babylonEditorPhysicsCollisionLayer = clipboard.payload.collisionLayer;
	} else {
		delete node.metadata.babylonEditorPhysicsCollisionLayer;
	}
}

function copyPayload(node: Node, component: ReturnType<typeof resolveComponent>): any {
	if (component.type === "transform") {
		return describeTransform(node);
	}
	const descriptor = component.descriptor!;
	if (descriptor.type === "data") {
		return { enabled: descriptor.enabled, data: jsonClone(descriptor.data) };
	}
	if (descriptor.type === "script") {
		const script = getScript(node, descriptor);
		if (!script) {
			throw new Error("The behavior attachment no longer exists.");
		}
		return {
			enabled: script.enabled !== false,
			key: script.key,
			executionOrder: script.executionOrder ?? 0,
			values: jsonClone(script.values ?? {}),
		};
	}
	if (!isAbstractMesh(node) || !node.physicsAggregate) {
		throw new Error("The physics body no longer exists.");
	}
	return {
		serialized: jsonClone(serializePhysicsAggregate(node.physicsAggregate)),
		filterMembershipMask: node.physicsAggregate.shape.filterMembershipMask ?? 1,
		filterCollideMask: node.physicsAggregate.shape.filterCollideMask ?? 0xffffffff,
		collisionLayer: node.metadata?.babylonEditorPhysicsCollisionLayer ?? null,
	};
}

/** Lists the closed component registry and node-specific availability/duplicate rules. */
export function listGameObjectComponentTypes(scene: Scene, data: any): any {
	const node = data.nodeId || data.nodeName ? resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName }) : null;
	const existingTypes = node ? new Set(describeComponents(node).map((component) => component.type)) : new Set<ComponentType>();
	return {
		version: gameObjectComponentStackVersion,
		types: Object.values(componentDefinitions).map((definition) => ({
			...definition,
			canAdd:
				definition.type !== "transform" &&
				(!node || definition.type !== "physics3d" || isAbstractMesh(node)) &&
				(definition.allowMultiple || !existingTypes.has(definition.type)),
		})),
	};
}

/** Inspects the exact ordered component stack and returns its optimistic-concurrency fingerprint. */
export function inspectGameObjectComponents(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const components = describeComponents(node);
	return {
		node: toNodeSummary(node),
		version: gameObjectComponentStackVersion,
		fingerprint: hash({ nodeId: node.id, components }),
		componentCount: components.length,
		components,
		clipboard: componentClipboard ? { type: componentClipboard.type, fingerprint: componentClipboard.fingerprint } : null,
	};
}

/** Adds a real custom-data, behavior-script, or physics component under an exact stack lease. */
export function addGameObjectComponent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	assertFingerprint(node, data.expectedFingerprint);
	const type = data.type as GameObjectComponentType;
	if (type !== "data" && type !== "script" && type !== "physics3d" && type !== "network" && type !== "entity") {
		throw new Error("type must be data, script, physics3d, network, or entity.");
	}
	const stack = synchronizeAdapters(node);
	if (stack.components.length >= maxComponents) {
		throw new Error(`A node can contain at most ${maxComponents} authored components.`);
	}
	if (!componentDefinitions[type].allowMultiple && stack.components.some((component) => component.type === type)) {
		throw new Error(`${componentDefinitions[type].label} does not allow duplicates.`);
	}
	mutate(node, options, () => {
		const mutableStack = synchronizeAdapters(node, true);
		if (type === "data") {
			const name = data.name ?? "Data Component";
			if (typeof name !== "string" || !name.trim() || name.length > 80) {
				throw new Error("name must contain 1 through 80 characters.");
			}
			const values = validateJsonObject(data.values ?? {}, "values");
			mutableStack.components.push({ id: createComponentId(), type, enabled: data.enabled ?? true, data: { name: name.trim(), values } });
		} else if (type === "script") {
			if (typeof data.path !== "string" || !data.path.trim()) {
				throw new Error("Adding a script component requires path under src/.");
			}
			const beforeIds = new Set((node.metadata?.scripts ?? []).map((script: any) => script._id));
			attachScript(scene, { nodeId: node.id, path: data.path }, options);
			const added = node.metadata?.scripts?.find((script: any) => !beforeIds.has(script._id));
			if (!added) {
				throw new Error(`Behavior script "${data.path}" is already attached to this node.`);
			}
			added.enabled = data.enabled ?? true;
		} else if (type === "entity") {
			const seeded = normalizeEntityComponentData(validateJsonObject(data.data ?? {}, "data"));
			mutableStack.components.push({ id: createComponentId(), type, enabled: data.enabled ?? true, data: seeded });
		} else if (type === "network") {
			// Seed the replication contract from the shared normalizer so a
			// freshly added component is already valid, and default the stable
			// network id to the node's own id rather than leaving it blank.
			const seeded = normalizeNetworkComponentData({ networkId: node.id, ...validateJsonObject(data.data ?? {}, "data") });
			mutableStack.components.push({ id: createComponentId(), type, enabled: data.enabled ?? true, data: seeded });
		} else {
			if (!isAbstractMesh(node)) {
				throw new Error("Physics Body 3D can only be added to a mesh.");
			}
			setMeshPhysics(scene, { nodeId: node.id, enabled: true, shapeType: data.shapeType, motionType: data.motionType, mass: data.mass }, options);
		}
	});
	return inspectGameObjectComponents(scene, { nodeId: node.id });
}

/** Updates supported values without replacing the stable component identity. */
export function setGameObjectComponent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	assertFingerprint(node, data.expectedFingerprint);
	resolveComponent(node, data.componentId);
	mutate(node, options, () => {
		const mutableComponent = resolveComponent(node, data.componentId, true);
		if (mutableComponent.type === "transform") {
			if (!data.transform) {
				throw new Error("Transform updates require the transform object.");
			}
			setTransformValues(node, data.transform);
			return;
		}
		const descriptor = mutableComponent.descriptor!;
		if (data.enabled !== undefined) {
			if (!componentDefinitions[descriptor.type].canToggle) {
				throw new Error(`${componentDefinitions[descriptor.type].label} cannot be disabled.`);
			}
			descriptor.enabled = data.enabled;
			if (descriptor.type === "script") {
				const script = getScript(node, descriptor);
				if (!script) {
					throw new Error("The behavior attachment no longer exists.");
				}
				script.enabled = data.enabled;
			}
		}
		if (descriptor.type === "data") {
			if (data.name !== undefined) {
				if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 80) {
					throw new Error("name must contain 1 through 80 characters.");
				}
				descriptor.data.name = data.name.trim();
			}
			if (data.values !== undefined) {
				descriptor.data.values = validateJsonObject(data.values, "values");
			}
		} else if (descriptor.type === "script" && data.script !== undefined) {
			const script = getScript(node, descriptor);
			if (!script) {
				throw new Error("The behavior attachment no longer exists.");
			}
			if (data.script.executionOrder !== undefined) {
				if (!Number.isInteger(data.script.executionOrder) || data.script.executionOrder < -32000 || data.script.executionOrder > 32000) {
					throw new Error("script.executionOrder must be an integer between -32000 and 32000.");
				}
				script.executionOrder = data.script.executionOrder;
			}
			if (data.script.values !== undefined) {
				script.values = validateJsonObject(data.script.values, "script.values");
			}
		} else if (descriptor.type === "entity" && data.data !== undefined) {
			descriptor.data = normalizeEntityComponentData({ ...descriptor.data, ...validateJsonObject(data.data, "data") });
		} else if (descriptor.type === "network" && data.data !== undefined) {
			// Merge onto the existing contract and re-normalize, so a partial
			// update can never persist an out-of-range or wrong-typed field.
			descriptor.data = normalizeNetworkComponentData({ ...descriptor.data, ...validateJsonObject(data.data, "data") });
		} else if (descriptor.type === "physics3d" && data.physics !== undefined) {
			setMeshPhysics(scene, { nodeId: node.id, enabled: true, ...data.physics }, options);
		}
	});
	return inspectGameObjectComponents(scene, { nodeId: node.id });
}

/** Reorders one component while keeping Transform and required dependencies ahead of dependents. */
export function moveGameObjectComponent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	assertFingerprint(node, data.expectedFingerprint);
	const component = resolveComponent(node, data.componentId);
	if (component.type === "transform") {
		throw new Error("Transform is required and always remains at order 0.");
	}
	const stack = synchronizeAdapters(node);
	if (!Number.isInteger(data.targetOrder) || data.targetOrder < 1 || data.targetOrder > stack.components.length) {
		throw new Error(`targetOrder must be an integer between 1 and ${stack.components.length}.`);
	}
	mutate(node, options, () => {
		const mutableStack = synchronizeAdapters(node, true);
		const mutableComponent = resolveComponent(node, data.componentId, true);
		const [descriptor] = mutableStack.components.splice(mutableComponent.index - 1, 1);
		mutableStack.components.splice(data.targetOrder - 1, 0, descriptor);
		const ordered = [{ type: "transform" as ComponentType }, ...mutableStack.components];
		mutableStack.components.forEach((candidate, index) => {
			componentDefinitions[candidate.type].requiredTypes.forEach((requiredType) => {
				const requiredIndex = ordered.findIndex((entry) => entry.type === requiredType);
				if (requiredIndex === -1 || requiredIndex > index + 1) {
					throw new Error(`${componentDefinitions[candidate.type].label} must remain after required ${componentDefinitions[requiredType].label}.`);
				}
			});
		});
	});
	return inspectGameObjectComponents(scene, { nodeId: node.id });
}

/** Removes one component, rejecting required/dependent or duplicate-ownership violations. */
export function removeGameObjectComponent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	assertFingerprint(node, data.expectedFingerprint);
	const component = resolveComponent(node, data.componentId);
	if (!componentDefinitions[component.type].removable) {
		throw new Error(`${componentDefinitions[component.type].label} is required and cannot be removed.`);
	}
	const components = describeComponents(node);
	const dependentIds = components.find((candidate) => candidate.id === data.componentId)?.dependentIds ?? [];
	if (dependentIds.length && data.cascade !== true) {
		throw new Error(`Component has dependent components: ${dependentIds.join(", ")}. Retry with cascade: true to remove them atomically.`);
	}
	mutate(node, options, () => {
		const stack = synchronizeAdapters(node, true);
		const removeIds = new Set([String(data.componentId), ...dependentIds]);
		const removing = stack.components.filter((candidate) => removeIds.has(candidate.id));
		removing.forEach((descriptor) => {
			if (descriptor.type === "script") {
				const scriptIndex = node.metadata?.scripts?.findIndex((script: any) => script._id === descriptor.data.attachmentId) ?? -1;
				if (scriptIndex !== -1) {
					node.metadata.scripts.splice(scriptIndex, 1);
				}
			} else if (descriptor.type === "physics3d") {
				setMeshPhysics(scene, { nodeId: node.id, enabled: false }, options);
			}
		});
		stack.components = stack.components.filter((candidate) => !removeIds.has(candidate.id));
	});
	return inspectGameObjectComponents(scene, { nodeId: node.id });
}

/** Resets one component to deterministic type defaults under an exact stack lease. */
export function resetGameObjectComponent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	assertFingerprint(node, data.expectedFingerprint);
	resolveComponent(node, data.componentId);
	mutate(node, options, () => resetComponentValues(node, resolveComponent(node, data.componentId, true), options));
	return inspectGameObjectComponents(scene, { nodeId: node.id });
}

/** Copies an exact component snapshot into the shared editor/MCP component clipboard. */
export function copyGameObjectComponent(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	assertFingerprint(node, data.expectedFingerprint);
	const component = resolveComponent(node, data.componentId);
	const payload = copyPayload(node, component);
	const fingerprint = hash({ type: component.type, sourceNodeId: node.id, sourceComponentId: data.componentId, payload });
	componentClipboard = { fingerprint, type: component.type, sourceNodeId: node.id, sourceComponentId: data.componentId, payload };
	return { copied: true, type: component.type, sourceNodeId: node.id, sourceComponentId: data.componentId, clipboardFingerprint: fingerprint };
}

/** Pastes copied values onto the same type, or creates a new duplicate-compatible component. */
export function pasteGameObjectComponent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	assertFingerprint(node, data.expectedFingerprint);
	if (!componentClipboard) {
		throw new Error("The component clipboard is empty. Call copy_game_object_component first.");
	}
	if (data.expectedClipboardFingerprint !== componentClipboard.fingerprint) {
		throw new Error("Component clipboard changed. Copy again and use the returned exact clipboardFingerprint.");
	}
	if (data.mode === "values") {
		resolveComponent(node, data.componentId);
		mutate(node, options, () => applyClipboardValues(node, resolveComponent(node, data.componentId, true), componentClipboard!, options));
	} else if (data.mode === "new") {
		if (componentClipboard.type === "transform") {
			throw new Error("Transform does not allow duplicate components; use mode: values.");
		}
		const type = componentClipboard.type;
		const stack = synchronizeAdapters(node);
		if (!componentDefinitions[type].allowMultiple && stack.components.some((component) => component.type === type)) {
			throw new Error(`${componentDefinitions[type].label} does not allow duplicates on the target node.`);
		}
		mutate(node, options, () => {
			const mutableStack = synchronizeAdapters(node, true);
			if (type === "data") {
				mutableStack.components.push({ id: createComponentId(), type, enabled: componentClipboard!.payload.enabled, data: jsonClone(componentClipboard!.payload.data) });
			} else if (type === "script") {
				const key = componentClipboard!.payload.key;
				if (node.metadata?.scripts?.some((script: any) => script.key === key)) {
					throw new Error(`Behavior script "src/${key}" is already attached to the target node.`);
				}
				node.metadata ??= {};
				node.metadata.scripts ??= [];
				node.metadata.scripts.push({
					_id: createComponentId(),
					enabled: componentClipboard!.payload.enabled,
					key,
					executionOrder: componentClipboard!.payload.executionOrder,
					values: jsonClone(componentClipboard!.payload.values),
				});
			} else {
				if (!isAbstractMesh(node)) {
					throw new Error("Physics Body 3D can only be pasted onto a mesh.");
				}
				const aggregate = parsePhysicsAggregate(node as TransformNode, componentClipboard!.payload.serialized);
				aggregate.body.disableSync = true;
				aggregate.shape.filterMembershipMask = componentClipboard!.payload.filterMembershipMask;
				aggregate.shape.filterCollideMask = componentClipboard!.payload.filterCollideMask;
				node.physicsAggregate = aggregate;
				node.physicsBody = aggregate.body;
				node.metadata ??= {};
				if (componentClipboard!.payload.collisionLayer) {
					node.metadata.babylonEditorPhysicsCollisionLayer = componentClipboard!.payload.collisionLayer;
				} else {
					delete node.metadata.babylonEditorPhysicsCollisionLayer;
				}
			}
		});
	} else {
		throw new Error("mode must be new or values.");
	}
	return inspectGameObjectComponents(scene, { nodeId: node.id });
}
