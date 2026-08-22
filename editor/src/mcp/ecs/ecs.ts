import { randomUUID } from "crypto";

import { Scene } from "babylonjs";
import {
	ECSBaker,
	ECSRuntime,
	ECSRuntimeCommand,
	IECSComponentTypeDefinition,
	IECSConfiguration,
	IECSFieldDefinition,
	IECSSectionDefinition,
	IECSSystemDefinition,
	compileECSConfiguration,
	configureECSRuntime,
	createDefaultECSConfiguration,
	createECSWorldSnapshot,
	disposeECSRuntime,
	getECSRuntime,
	getECSStableHash,
	getECSTypeRegistration,
	getSceneECSConfiguration,
	normalizeECSConfiguration,
	normalizeEntityComponentData,
	queryECSSystems,
	setSceneECSConfiguration,
	validateECSConfiguration,
} from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";

interface IECSAuthoringSnapshot {
	hadMetadata: boolean;
	hadConfiguration: boolean;
	configuration: unknown;
}

function capture(scene: Scene): IECSAuthoringSnapshot {
	return {
		hadMetadata: scene.metadata !== null && scene.metadata !== undefined,
		hadConfiguration: Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorECS"),
		configuration: structuredClone(scene.metadata?.babylonEditorECS),
	};
}

function hasEntityComponents(scene: Scene): boolean {
	return scene.getNodes().some((node) => node.metadata?.babylonEditorComponentStack?.components?.some((component: any) => component.type === "entity"));
}

function refreshUI(options: IMCPActionOptions): void {
	options.editor.layout.inspector?.forceUpdate();
	options.editor.layout.entities?.forceUpdate();
	void options.editor.layout.graph?.refresh();
}

function synchronizeRuntime(scene: Scene, configuration: IECSConfiguration | null): void {
	const existing = getECSRuntime(scene as any);
	if (!configuration && !hasEntityComponents(scene)) {
		disposeECSRuntime(scene as any);
		return;
	}
	const target = configuration ?? createDefaultECSConfiguration();
	if (existing) {
		existing.rebake(target, { mode: "full", expectedGeneration: existing.world.generation });
	} else {
		configureECSRuntime(scene as any, target);
	}
}

function restore(scene: Scene, snapshot: IECSAuthoringSnapshot, options: IMCPActionOptions): void {
	if (!snapshot.hadMetadata) {
		scene.metadata = null;
	} else {
		scene.metadata ??= {};
		if (snapshot.hadConfiguration) {
			scene.metadata.babylonEditorECS = structuredClone(snapshot.configuration);
		} else {
			delete scene.metadata.babylonEditorECS;
		}
	}
	const configuration = snapshot.hadConfiguration ? normalizeECSConfiguration(snapshot.configuration) : null;
	synchronizeRuntime(scene, configuration);
	refreshUI(options);
}

function publish(scene: Scene, configuration: IECSConfiguration, options: IMCPActionOptions): void {
	const before = capture(scene);
	const previousConfiguration = before.hadConfiguration ? normalizeECSConfiguration(before.configuration) : null;
	try {
		setSceneECSConfiguration(scene as any, configuration);
		synchronizeRuntime(scene, configuration);
	} catch (error) {
		if (!before.hadMetadata) {
			scene.metadata = null;
		} else if (before.hadConfiguration) {
			scene.metadata ??= {};
			scene.metadata.babylonEditorECS = structuredClone(before.configuration);
		} else {
			delete scene.metadata?.babylonEditorECS;
		}
		synchronizeRuntime(scene, previousConfiguration);
		throw error;
	}
	const after = capture(scene);
	registerUndoRedo({ undo: () => restore(scene, before, options), redo: () => restore(scene, after, options), action: () => refreshUI(options) });
	refreshUI(options);
}

function current(scene: Scene): IECSConfiguration {
	return getSceneECSConfiguration(scene as any, false);
}

function fingerprint(configuration: IECSConfiguration): string {
	return getECSStableHash(configuration);
}

function assertLease(configuration: IECSConfiguration, data: any): void {
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== configuration.revision) {
		throw new Error(`ECS configuration revision is stale: expected ${String(data.expectedRevision)}, current ${configuration.revision}.`);
	}
	const actual = fingerprint(configuration);
	if (typeof data.expectedFingerprint !== "string" || data.expectedFingerprint !== actual) {
		throw new Error("ECS configuration changed after inspection. Re-inspect and use its exact fingerprint.");
	}
}

function mutate(scene: Scene, data: any, options: IMCPActionOptions, mutation: (configuration: IECSConfiguration) => void): IECSConfiguration {
	const previous = current(scene);
	assertLease(previous, data);
	const next = structuredClone(previous);
	mutation(next);
	next.revision = previous.revision + 1;
	validateECSConfiguration(next);
	publish(scene, next, options);
	return structuredClone(next);
}

function makeId(name: unknown, prefix: string, existing: ReadonlySet<string>): string {
	const seed =
		typeof name === "string"
			? name
					.trim()
					.replace(/[^A-Za-z0-9_-]+/g, "-")
					.replace(/^[^A-Za-z]+/, "")
					.replace(/-+$/g, "")
			: "";
	const base = (seed || `${prefix}-${randomUUID().slice(0, 8)}`).slice(0, 64);
	let result = base;
	let suffix = 2;
	while (existing.has(result)) {
		result = `${base.slice(0, 60)}-${suffix++}`;
	}
	return result;
}

function runtime(scene: Scene): ECSRuntime {
	const value = getECSRuntime(scene as any);
	if (!value) {
		throw new Error("ECS runtime is not active. Bake or start the ECS world first.");
	}
	return value;
}

function assertRuntimeLease(value: ECSRuntime, data: any): void {
	if (!Number.isInteger(data.expectedGeneration) || data.expectedGeneration !== value.world.generation) {
		throw new Error(`ECS runtime generation is stale: expected ${String(data.expectedGeneration)}, current ${value.world.generation}.`);
	}
	if (data.expectedStatus !== undefined && data.expectedStatus !== value.status) {
		throw new Error(`ECS runtime status is stale: expected ${String(data.expectedStatus)}, current ${value.status}.`);
	}
}

function assertConfirm(data: any, action: string): void {
	if (data.confirm !== true) {
		throw new Error(`${action} requires confirm=true.`);
	}
}

function systemReferencesField(system: IECSSystemDefinition, componentId: string, fieldId: string): boolean {
	const matches = (reference: { componentId: string; fieldId: string } | undefined): boolean => reference?.componentId === componentId && reference.fieldId === fieldId;
	return system.reads.some(matches) || system.writes.some(matches) || system.operations.some((operation) => matches(operation.target) || matches(operation.source));
}

function systemReferencesComponent(system: IECSSystemDefinition, componentId: string): boolean {
	return (
		system.query.all.includes(componentId) ||
		system.query.any.includes(componentId) ||
		system.query.none.includes(componentId) ||
		system.reads.some((reference) => reference.componentId === componentId) ||
		system.writes.some((reference) => reference.componentId === componentId) ||
		system.operations.some((operation) => operation.target.componentId === componentId || operation.source?.componentId === componentId)
	);
}

/** Reads the exact scene-owned authoring lease plus live runtime summary. */
export function inspectECS(scene: Scene): any {
	const configuration = current(scene);
	const live = getECSRuntime(scene as any);
	return {
		authored: Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorECS"),
		configuration: structuredClone(configuration),
		fingerprint: fingerprint(configuration),
		typeRegistration: getECSTypeRegistration(configuration),
		runtime: live?.report ?? null,
		world: live ? createECSWorldSnapshot(live.world, { chunkLimit: 64 }) : null,
	};
}

/** Deletes the scene ECS asset and runtime when no Entity components remain. */
export function deleteECSConfiguration(scene: Scene, data: any, options: IMCPActionOptions): any {
	const configuration = current(scene);
	assertLease(configuration, data);
	assertConfirm(data, "delete_ecs_configuration");
	if (hasEntityComponents(scene)) {
		throw new Error("ECS configuration cannot be deleted while the scene contains Entity components.");
	}
	const before = capture(scene);
	scene.metadata ??= {};
	delete scene.metadata.babylonEditorECS;
	synchronizeRuntime(scene, null);
	const after = capture(scene);
	registerUndoRedo({ undo: () => restore(scene, before, options), redo: () => restore(scene, after, options), action: () => refreshUI(options) });
	refreshUI(options);
	return { deleted: true, ...inspectECS(scene) };
}

/** Replaces the complete validated configuration under an exact lease. */
export function replaceECSConfiguration(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = current(scene);
	assertLease(previous, data);
	const next = normalizeECSConfiguration({ ...structuredClone(data.configuration), version: previous.version, revision: previous.revision + 1 });
	publish(scene, next, options);
	return inspectECS(scene);
}

export function setECSSettings(scene: Scene, data: any, options: IMCPActionOptions): any {
	mutate(scene, data, options, (configuration) => Object.assign(configuration.settings, structuredClone(data.settings)));
	return inspectECS(scene);
}

/** Updates persisted Entities Hierarchy preferences under the exact scene configuration lease. */
export function setECSHierarchyPreferences(scene: Scene, data: any, options: IMCPActionOptions): any {
	mutate(scene, data, options, (configuration) => {
		if (data.showHiddenEntitiesInHierarchy !== undefined) {
			configuration.settings.showHiddenEntitiesInHierarchy = data.showHiddenEntitiesInHierarchy;
		}
		if (data.hierarchyWorldMode !== undefined) {
			configuration.settings.hierarchyWorldMode = data.hierarchyWorldMode;
		}
	});
	return inspectECS(scene);
}

export function createECSComponentType(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IECSComponentTypeDefinition;
	const configuration = mutate(scene, data, options, (value) => {
		const id = data.component.id ?? makeId(data.component.name, "component", new Set(value.componentTypes.map((entry) => entry.id)));
		created = {
			id,
			name: data.component.name,
			namespace: data.component.namespace ?? "Game.Entities",
			assembly: data.component.assembly ?? "game",
			fields: structuredClone(data.component.fields ?? []),
			builtIn: false,
		};
		value.componentTypes.push(created);
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), component: structuredClone(created) };
}

export function setECSComponentType(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IECSComponentTypeDefinition;
	const configuration = mutate(scene, data, options, (value) => {
		const index = value.componentTypes.findIndex((entry) => entry.id === data.componentId);
		if (index < 0) {
			throw new Error(`ECS component type "${data.componentId}" was not found.`);
		}
		if (value.componentTypes[index].builtIn) {
			throw new Error("Built-in ECS component types cannot be edited.");
		}
		updated = { ...value.componentTypes[index], ...structuredClone(data.changes), id: data.componentId, builtIn: false };
		value.componentTypes[index] = updated;
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), component: structuredClone(updated) };
}

/** Creates or replaces one assembly-wide auto-registration policy under an exact authoring lease. */
export function setECSTypeRegistrationPolicy(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated: any;
	const configuration = mutate(scene, data, options, (value) => {
		if (!data.policy.disableAutoRegistration && data.policy.registeredTypeIds.length) {
			throw new Error("An assembly with auto-registration enabled cannot contain explicit registeredTypeIds.");
		}
		updated = structuredClone(data.policy);
		const index = value.typeRegistrationPolicies.findIndex((entry) => entry.assembly === data.policy.assembly);
		if (index === -1) {
			value.typeRegistrationPolicies.push(updated);
		} else {
			value.typeRegistrationPolicies[index] = updated;
		}
		value.typeRegistrationPolicies.sort((left, right) => left.assembly.localeCompare(right.assembly));
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), policy: updated, registry: getECSTypeRegistration(configuration) };
}

/** Deletes one exact assembly-wide registration policy after literal confirmation. */
export function deleteECSTypeRegistrationPolicy(scene: Scene, data: any, options: IMCPActionOptions): any {
	assertConfirm(data, "delete_ecs_type_registration_policy");
	const configuration = mutate(scene, data, options, (value) => {
		if (!value.typeRegistrationPolicies.some((entry) => entry.assembly === data.assembly)) {
			throw new Error(`ECS type-registration policy for assembly "${data.assembly}" was not found.`);
		}
		value.typeRegistrationPolicies = value.typeRegistrationPolicies.filter((entry) => entry.assembly !== data.assembly);
	});
	return { deleted: true, assembly: data.assembly, revision: configuration.revision, fingerprint: fingerprint(configuration), registry: getECSTypeRegistration(configuration) };
}

/** Reads a bounded page of the effective component TypeManager-equivalent registry. */
export function inspectECSTypeRegistry(scene: Scene, data: any = {}): any {
	const configuration = current(scene);
	const all = getECSTypeRegistration(configuration).filter(
		(entry) => (!data.assembly || entry.assembly === data.assembly) && (data.registered === undefined || entry.registered === data.registered)
	);
	const offset = Math.max(0, Math.floor(data.offset ?? 0));
	const limit = Math.min(256, Math.max(1, Math.floor(data.limit ?? 100)));
	const types = all.slice(offset, offset + limit);
	return {
		revision: configuration.revision,
		fingerprint: fingerprint(configuration),
		policies: structuredClone(configuration.typeRegistrationPolicies),
		total: all.length,
		offset,
		limit,
		returned: types.length,
		hasMore: offset + types.length < all.length,
		types,
	};
}

export function deleteECSComponentType(scene: Scene, data: any, options: IMCPActionOptions): any {
	assertConfirm(data, "delete_ecs_component_type");
	const configuration = mutate(scene, data, options, (value) => {
		const component = value.componentTypes.find((entry) => entry.id === data.componentId);
		if (!component) {
			throw new Error(`ECS component type "${data.componentId}" was not found.`);
		}
		if (component.builtIn) {
			throw new Error("Built-in ECS component types cannot be deleted.");
		}
		if (value.systems.some((system) => systemReferencesComponent(system, data.componentId))) {
			throw new Error(`ECS component type "${data.componentId}" is still referenced by a system.`);
		}
		if (
			scene
				.getNodes()
				.some(
					(node) =>
						normalizeEntityComponentData(node.metadata?.babylonEditorComponentStack?.components?.find((entry: any) => entry.type === "entity")?.data ?? {}).components[
							data.componentId
						]
				)
		) {
			throw new Error(`ECS component type "${data.componentId}" is still authored on an entity.`);
		}
		value.componentTypes = value.componentTypes.filter((entry) => entry.id !== data.componentId);
	});
	return { deleted: true, componentId: data.componentId, revision: configuration.revision, fingerprint: fingerprint(configuration) };
}

export function createECSField(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IECSFieldDefinition;
	const configuration = mutate(scene, data, options, (value) => {
		const component = value.componentTypes.find((entry) => entry.id === data.componentId);
		if (!component || component.builtIn) {
			throw new Error(`Editable ECS component type "${data.componentId}" was not found.`);
		}
		const id = data.field.id ?? makeId(data.field.name, "field", new Set(component.fields.map((entry) => entry.id)));
		created = {
			id,
			name: data.field.name,
			type: data.field.type,
			defaultValue: structuredClone(data.field.defaultValue),
			...(data.field.minimum === undefined ? {} : { minimum: data.field.minimum }),
			...(data.field.maximum === undefined ? {} : { maximum: data.field.maximum }),
		};
		component.fields.push(created);
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), componentId: data.componentId, field: structuredClone(created) };
}

export function setECSField(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IECSFieldDefinition;
	const configuration = mutate(scene, data, options, (value) => {
		const component = value.componentTypes.find((entry) => entry.id === data.componentId);
		if (!component || component.builtIn) {
			throw new Error(`Editable ECS component type "${data.componentId}" was not found.`);
		}
		const index = component.fields.findIndex((entry) => entry.id === data.fieldId);
		if (index < 0) {
			throw new Error(`ECS field "${data.componentId}.${data.fieldId}" was not found.`);
		}
		const changes = structuredClone(data.changes);
		updated = { ...component.fields[index], ...changes, id: data.fieldId };
		if (changes.minimum === null) {
			delete updated.minimum;
		}
		if (changes.maximum === null) {
			delete updated.maximum;
		}
		component.fields[index] = updated;
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), componentId: data.componentId, field: structuredClone(updated) };
}

export function deleteECSField(scene: Scene, data: any, options: IMCPActionOptions): any {
	assertConfirm(data, "delete_ecs_field");
	const configuration = mutate(scene, data, options, (value) => {
		const component = value.componentTypes.find((entry) => entry.id === data.componentId);
		if (!component || component.builtIn) {
			throw new Error(`Editable ECS component type "${data.componentId}" was not found.`);
		}
		if (value.systems.some((system) => systemReferencesField(system, data.componentId, data.fieldId))) {
			throw new Error(`ECS field "${data.componentId}.${data.fieldId}" is still referenced by a system.`);
		}
		if (
			scene
				.getNodes()
				.some((node) =>
					Object.prototype.hasOwnProperty.call(
						normalizeEntityComponentData(node.metadata?.babylonEditorComponentStack?.components?.find((entry: any) => entry.type === "entity")?.data ?? {}).components[
							data.componentId
						] ?? {},
						data.fieldId
					)
				)
		) {
			throw new Error(`ECS field "${data.componentId}.${data.fieldId}" is still authored on an entity.`);
		}
		if (!component.fields.some((entry) => entry.id === data.fieldId)) {
			throw new Error(`ECS field "${data.componentId}.${data.fieldId}" was not found.`);
		}
		component.fields = component.fields.filter((entry) => entry.id !== data.fieldId);
	});
	return { deleted: true, componentId: data.componentId, fieldId: data.fieldId, revision: configuration.revision, fingerprint: fingerprint(configuration) };
}

export function createECSSystem(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IECSSystemDefinition;
	const configuration = mutate(scene, data, options, (value) => {
		const id = data.system.id ?? makeId(data.system.name, "system", new Set(value.systems.map((entry) => entry.id)));
		created = {
			id,
			name: data.system.name,
			namespace: data.system.namespace ?? "Game.Systems",
			enabled: data.system.enabled ?? true,
			phase: data.system.phase ?? "update",
			order: data.system.order ?? 0,
			query: structuredClone(data.system.query ?? { all: [], any: [], none: [] }),
			reads: structuredClone(data.system.reads ?? []),
			writes: structuredClone(data.system.writes ?? []),
			dependsOn: structuredClone(data.system.dependsOn ?? []),
			operations: structuredClone(data.system.operations ?? []),
		};
		value.systems.push(created);
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), system: structuredClone(created) };
}

export function setECSSystem(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IECSSystemDefinition;
	const configuration = mutate(scene, data, options, (value) => {
		const index = value.systems.findIndex((entry) => entry.id === data.systemId);
		if (index < 0) {
			throw new Error(`ECS system "${data.systemId}" was not found.`);
		}
		updated = { ...value.systems[index], ...structuredClone(data.changes), id: data.systemId };
		value.systems[index] = updated;
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), system: structuredClone(updated) };
}

export function deleteECSSystem(scene: Scene, data: any, options: IMCPActionOptions): any {
	assertConfirm(data, "delete_ecs_system");
	const configuration = mutate(scene, data, options, (value) => {
		if (!value.systems.some((entry) => entry.id === data.systemId)) {
			throw new Error(`ECS system "${data.systemId}" was not found.`);
		}
		if (value.systems.some((entry) => entry.dependsOn.includes(data.systemId))) {
			throw new Error(`ECS system "${data.systemId}" is still a dependency of another system.`);
		}
		value.systems = value.systems.filter((entry) => entry.id !== data.systemId);
	});
	return { deleted: true, systemId: data.systemId, revision: configuration.revision, fingerprint: fingerprint(configuration) };
}

export function createECSSection(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IECSSectionDefinition;
	const configuration = mutate(scene, data, options, (value) => {
		const id = data.section.id ?? makeId(data.section.name, "section", new Set(value.sections.map((entry) => entry.id)));
		created = { id, name: data.section.name, autoLoad: data.section.autoLoad ?? false, priority: data.section.priority ?? 0 };
		value.sections.push(created);
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), section: structuredClone(created) };
}

export function setECSSection(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IECSSectionDefinition;
	const configuration = mutate(scene, data, options, (value) => {
		const index = value.sections.findIndex((entry) => entry.id === data.sectionId);
		if (index < 0) {
			throw new Error(`ECS section "${data.sectionId}" was not found.`);
		}
		updated = { ...value.sections[index], ...structuredClone(data.changes), id: data.sectionId };
		value.sections[index] = updated;
	});
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), section: structuredClone(updated) };
}

export function deleteECSSection(scene: Scene, data: any, options: IMCPActionOptions): any {
	assertConfirm(data, "delete_ecs_section");
	const configuration = mutate(scene, data, options, (value) => {
		if (data.sectionId === "main") {
			throw new Error('The built-in "main" ECS section cannot be deleted.');
		}
		if (!value.sections.some((entry) => entry.id === data.sectionId)) {
			throw new Error(`ECS section "${data.sectionId}" was not found.`);
		}
		if (
			scene
				.getNodes()
				.some(
					(node) =>
						normalizeEntityComponentData(node.metadata?.babylonEditorComponentStack?.components?.find((entry: any) => entry.type === "entity")?.data ?? {})
							.sectionId === data.sectionId
				)
		) {
			throw new Error(`ECS section "${data.sectionId}" is still used by an entity.`);
		}
		value.sections = value.sections.filter((entry) => entry.id !== data.sectionId);
	});
	return { deleted: true, sectionId: data.sectionId, revision: configuration.revision, fingerprint: fingerprint(configuration) };
}

export function validateECS(scene: Scene): any {
	const configuration = current(scene);
	validateECSConfiguration(configuration);
	const schedule = compileECSConfiguration(configuration);
	const bake = new ECSBaker().bake(scene as any, configuration, { mode: "full" });
	return {
		valid: true,
		fingerprint: fingerprint(configuration),
		revision: configuration.revision,
		schedule,
		bake: bake.report,
		world: createECSWorldSnapshot(bake.world, { chunkLimit: 64 }),
	};
}

export function bakeECS(scene: Scene, data: any, options: IMCPActionOptions): any {
	const configuration = current(scene);
	assertLease(configuration, data);
	let value = getECSRuntime(scene as any);
	if (value) {
		assertRuntimeLease(value, data);
		value.rebake(configuration, { mode: data.mode ?? "incremental", expectedGeneration: value.world.generation, expectedSourceHashes: data.expectedSourceHashes });
	} else {
		value = configureECSRuntime(scene as any, configuration);
	}
	refreshUI(options);
	return value.snapshot(data.includeValues ?? false, data.chunkOffset ?? 0, data.chunkLimit ?? 64);
}

export function controlECSRuntime(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = runtime(scene);
	assertRuntimeLease(value, data);
	if (data.action === "start" || data.action === "resume") {
		value.start();
	} else if (data.action === "pause") {
		value.pause();
	} else if (data.action === "stop") {
		value.stop();
	} else {
		throw new Error("ECS runtime action must be start, resume, pause, or stop.");
	}
	refreshUI(options);
	return value.report;
}

export async function stepECSRuntime(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = runtime(scene);
	assertRuntimeLease(value, data);
	const result = data.useWorkers ? await value.stepAsync(data.deltaSeconds) : value.step(data.deltaSeconds);
	refreshUI(options);
	return { result, runtime: value.report };
}

export function queueECSRuntimeCommand(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = runtime(scene);
	assertRuntimeLease(value, data);
	const command = structuredClone(data.command);
	delete command.confirm;
	const count = value.queueCommand(command as ECSRuntimeCommand, data.expectedGeneration);
	refreshUI(options);
	return { queued: true, count, runtime: value.report };
}

export function playbackECSRuntimeCommands(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = runtime(scene);
	assertRuntimeLease(value, data);
	const applied = value.playbackCommands();
	refreshUI(options);
	return { applied, runtime: value.report };
}

export function queryECSEntities(scene: Scene, data: any): any {
	return runtime(scene).query(data);
}

/** Runs the shared bounded Systems quick-search and namespace-filter projection. */
export function queryECSSystemsWindow(scene: Scene, data: any): any {
	const configuration = current(scene);
	assertLease(configuration, data);
	return { revision: configuration.revision, fingerprint: fingerprint(configuration), ...queryECSSystems(configuration, data) };
}

function authoredHierarchyRows(scene: Scene): any[] {
	const nodes = scene.getNodes();
	const entityNodes = nodes.filter((node) => node.metadata?.babylonEditorComponentStack?.components?.some((component: any) => component.type === "entity" && component.enabled));
	const ids = new Set(entityNodes.map((node) => node.id));
	return entityNodes.map((node) => {
		const descriptor = node.metadata.babylonEditorComponentStack.components.find((component: any) => component.type === "entity" && component.enabled);
		const authored = normalizeEntityComponentData(descriptor.data ?? {});
		let parent = node.parent;
		while (parent && !ids.has(parent.id)) {
			parent = parent.parent;
		}
		return {
			entityId: node.id,
			name: (node.name || node.id).slice(0, 120),
			parentEntityId: parent?.id ?? null,
			hiddenInHierarchy: authored.hiddenInHierarchy,
			origin: "authoring",
			runtimePresent: false,
			archetype: authored.archetype,
			sectionId: authored.sectionId,
			componentIds: ["transform", ...Object.keys(authored.components).sort()],
		};
	});
}

function runtimeHierarchyRows(scene: Scene): any[] {
	const live = getECSRuntime(scene as any);
	if (!live) {
		return [];
	}
	return live.world.chunks.flatMap((chunk) =>
		chunk.entityIds.map((entityId, row) => ({
			entityId,
			name: chunk.entityNames[row],
			parentEntityId: chunk.parentEntityIds[row],
			hiddenInHierarchy: chunk.hiddenInHierarchy[row],
			origin: chunk.authoredEntities[row] ? "authoring" : "runtime",
			runtimePresent: true,
			archetype: chunk.archetype,
			sectionId: chunk.sectionId,
			componentIds: [...chunk.componentIds],
		}))
	);
}

function hierarchyDepth(row: any, byId: ReadonlyMap<string, any>): { depth: number; path: string[] } {
	const path = [row.entityId];
	const visited = new Set(path);
	let parentId = row.parentEntityId;
	while (parentId && path.length < 65 && !visited.has(parentId)) {
		path.unshift(parentId);
		visited.add(parentId);
		parentId = byId.get(parentId)?.parentEntityId ?? null;
	}
	return { depth: path.length - 1, path };
}

/** Reads one exact, bounded authoring/runtime/combined Entities hierarchy page. */
export function queryECSHierarchy(scene: Scene, data: any): any {
	const configuration = current(scene);
	assertLease(configuration, data);
	const world = data.world ?? configuration.settings.hierarchyWorldMode;
	const live = getECSRuntime(scene as any);
	if (world !== "authoring") {
		if (!live) {
			throw new Error(`ECS ${world} hierarchy requires an active runtime. Bake the ECS world first.`);
		}
		if (!Number.isInteger(data.expectedGeneration) || data.expectedGeneration !== live.world.generation) {
			throw new Error(`ECS hierarchy runtime generation is stale: expected ${String(data.expectedGeneration)}, current ${live.world.generation}.`);
		}
	}
	const authored = authoredHierarchyRows(scene);
	const rows = world === "authoring" ? authored : runtimeHierarchyRows(scene);
	if (world === "combined") {
		const ids = new Set(rows.map((row) => row.entityId));
		rows.push(...authored.filter((row) => !ids.has(row.entityId)));
	}
	const showHidden = data.showHidden ?? configuration.settings.showHiddenEntitiesInHierarchy;
	const search = data.search?.trim().toLowerCase();
	const filtered = rows
		.filter((row) => showHidden || !row.hiddenInHierarchy)
		.filter((row) => !data.sectionId || row.sectionId === data.sectionId)
		.filter((row) => !search || `${row.entityId} ${row.name} ${row.archetype} ${row.sectionId} ${row.componentIds.join(" ")}`.toLowerCase().includes(search))
		.sort((left, right) => left.entityId.localeCompare(right.entityId));
	const byId = new Map(rows.map((row) => [row.entityId, row]));
	const projected = filtered.map((row) => ({ ...row, ...hierarchyDepth(row, byId) }));
	const offset = Math.max(0, Math.floor(data.offset ?? 0));
	const limit = Math.min(500, Math.max(1, Math.floor(data.limit ?? 100)));
	const entities = projected.slice(offset, offset + limit);
	return {
		revision: configuration.revision,
		fingerprint: fingerprint(configuration),
		generation: live?.world.generation ?? null,
		preferences: { showHiddenEntitiesInHierarchy: configuration.settings.showHiddenEntitiesInHierarchy, hierarchyWorldMode: configuration.settings.hierarchyWorldMode },
		world,
		showHidden,
		total: projected.length,
		offset,
		limit,
		returned: entities.length,
		hasMore: offset + entities.length < projected.length,
		entities,
	};
}

export function inspectECSSchedule(scene: Scene): any {
	const value = runtime(scene);
	return { runtime: value.report, schedule: value.schedule, traces: value.traces.map((trace) => ({ ...trace })) };
}
