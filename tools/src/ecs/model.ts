export const ECS_CONFIGURATION_VERSION = 2 as const;
export const ECS_ENTITY_COMPONENT_VERSION = 3 as const;

export const ECS_MAX_COMPONENT_TYPES = 256;
export const ECS_MAX_FIELDS_PER_COMPONENT = 64;
export const ECS_MAX_SYSTEMS = 256;
export const ECS_MAX_OPERATIONS_PER_SYSTEM = 64;
export const ECS_MAX_SECTIONS = 256;
export const ECS_MAX_TYPE_REGISTRATION_POLICIES = 128;

export type ECSFieldType = "f64" | "f32" | "i32" | "u32" | "bool" | "vec2" | "vec3" | "vec4" | "quat";
export type ECSFieldValue = number | boolean | number[];
export type ECSSystemPhase = "fixed" | "update" | "late";
export type ECSExecutionMode = "auto" | "main-thread" | "worker";
export type ECSOperationKind = "set" | "add" | "multiply" | "copy" | "integrate" | "clamp";
export type ECSHierarchyWorldMode = "authoring" | "runtime" | "combined";

export interface IECSFieldDefinition {
	id: string;
	name: string;
	type: ECSFieldType;
	defaultValue: ECSFieldValue;
	minimum?: number;
	maximum?: number;
}

export interface IECSComponentTypeDefinition {
	id: string;
	name: string;
	namespace: string;
	assembly: string;
	fields: IECSFieldDefinition[];
	/** Built-ins are emitted by the baker and cannot be removed by authoring tools. */
	builtIn: boolean;
}

export interface IECSFieldReference {
	componentId: string;
	fieldId: string;
}

export interface IECSQueryDefinition {
	all: string[];
	any: string[];
	none: string[];
}

export interface IECSOperationDefinition {
	id: string;
	kind: ECSOperationKind;
	target: IECSFieldReference;
	source?: IECSFieldReference;
	constant?: number;
	minimum?: number;
	maximum?: number;
	useDeltaTime: boolean;
}

export interface IECSSystemDefinition {
	id: string;
	name: string;
	namespace: string;
	enabled: boolean;
	phase: ECSSystemPhase;
	order: number;
	query: IECSQueryDefinition;
	reads: IECSFieldReference[];
	writes: IECSFieldReference[];
	dependsOn: string[];
	operations: IECSOperationDefinition[];
}

export interface IECSSectionDefinition {
	id: string;
	name: string;
	autoLoad: boolean;
	priority: number;
}

export interface IECSSettings {
	enabled: boolean;
	autoStart: boolean;
	safetyChecks: boolean;
	executionMode: ECSExecutionMode;
	workerCount: number;
	minimumWorkerEntities: number;
	fixedDeltaSeconds: number;
	maxCatchUpSteps: number;
	chunkCapacity: number;
	traceLimit: number;
	showHiddenEntitiesInHierarchy: boolean;
	hierarchyWorldMode: ECSHierarchyWorldMode;
}

export interface IECSAssemblyTypeRegistrationPolicy {
	assembly: string;
	disableAutoRegistration: boolean;
	registeredTypeIds: string[];
}

export interface IECSTypeRegistrationStatus {
	typeId: string;
	name: string;
	namespace: string;
	assembly: string;
	registered: boolean;
	reason: "built-in" | "automatic" | "explicit" | "assembly-auto-registration-disabled";
}

export interface IECSConfiguration {
	version: typeof ECS_CONFIGURATION_VERSION;
	revision: number;
	settings: IECSSettings;
	componentTypes: IECSComponentTypeDefinition[];
	systems: IECSSystemDefinition[];
	sections: IECSSectionDefinition[];
	typeRegistrationPolicies: IECSAssemblyTypeRegistrationPolicy[];
}

/**
 * One authoring node's ECS payload. `values` remains the deterministic legacy
 * component while `components` allows an entity to carry multiple typed ECS
 * components without creating additional scene nodes.
 */
export interface IEntityComponentData extends Record<string, unknown> {
	version: typeof ECS_ENTITY_COMPONENT_VERSION;
	archetype: string;
	sectionId: string;
	values: Record<string, number>;
	components: Record<string, Record<string, ECSFieldValue>>;
	bakingEnabled: boolean;
	hiddenInHierarchy: boolean;
}

export interface IECSMetadataHost {
	metadata?: Record<string, unknown> | null;
}

const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const fieldTypes: readonly ECSFieldType[] = ["f64", "f32", "i32", "u32", "bool", "vec2", "vec3", "vec4", "quat"];
const operationKinds: readonly ECSOperationKind[] = ["set", "add", "multiply", "copy", "integrate", "clamp"];
const phases: readonly ECSSystemPhase[] = ["fixed", "update", "late"];
const executionModes: readonly ECSExecutionMode[] = ["auto", "main-thread", "worker"];
const hierarchyWorldModes: readonly ECSHierarchyWorldMode[] = ["authoring", "runtime", "combined"];
const qualifiedIdentifierPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw new Error(`${path} contains unknown field "${key}".`);
		}
	}
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !identifierPattern.test(value)) {
		throw new Error(`${path} must match ${identifierPattern}.`);
	}
}

function assertName(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\0\r\n]/.test(value)) {
		throw new Error(`${path} must contain 1 through 120 single-line characters.`);
	}
}

function assertQualifiedIdentifier(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !qualifiedIdentifierPattern.test(value)) {
		throw new Error(`${path} must match ${qualifiedIdentifierPattern}.`);
	}
}

function assertInteger(value: unknown, minimum: number, maximum: number, path: string): asserts value is number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${path} must be an integer between ${minimum} and ${maximum}.`);
	}
}

function assertFiniteRange(value: unknown, minimum: number, maximum: number, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${path} must be a finite number between ${minimum} and ${maximum}.`);
	}
}

/** Returns the scalar lane count used by typed chunk storage. */
export function getECSFieldArity(type: ECSFieldType): number {
	switch (type) {
		case "vec2":
			return 2;
		case "vec3":
			return 3;
		case "vec4":
		case "quat":
			return 4;
		default:
			return 1;
	}
}

/**
 * Normalizes a field value into its canonical authored representation. This
 * helper is strict because schema defaults and runtime columns must never have
 * ambiguous lane counts or non-finite numbers.
 */
export function normalizeECSFieldValue(type: ECSFieldType, value: unknown, path = "value"): ECSFieldValue {
	if (type === "bool") {
		if (typeof value !== "boolean") {
			throw new Error(`${path} must be boolean.`);
		}
		return value;
	}
	const arity = getECSFieldArity(type);
	if (arity === 1) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`${path} must be a finite number.`);
		}
		if ((type === "i32" || type === "u32") && !Number.isInteger(value)) {
			throw new Error(`${path} must be an integer for ${type}.`);
		}
		if (type === "i32" && (value < -2147483648 || value > 2147483647)) {
			throw new Error(`${path} is outside the i32 range.`);
		}
		if (type === "u32" && (value < 0 || value > 4294967295)) {
			throw new Error(`${path} is outside the u32 range.`);
		}
		return value;
	}
	if (!Array.isArray(value) || value.length !== arity || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
		throw new Error(`${path} must be a finite ${type} array with ${arity} lanes.`);
	}
	return [...value];
}

function builtInTransform(): IECSComponentTypeDefinition {
	return {
		id: "transform",
		name: "Local Transform",
		namespace: "Zvibe.Entities",
		assembly: "babylonjs-editor-tools",
		builtIn: true,
		fields: [
			{ id: "position", name: "Position", type: "vec3", defaultValue: [0, 0, 0] },
			{ id: "rotation", name: "Rotation", type: "quat", defaultValue: [0, 0, 0, 1] },
			{ id: "scale", name: "Scale", type: "vec3", defaultValue: [1, 1, 1] },
		],
	};
}

/** Creates the complete bounded portable ECS defaults for a scene. */
export function createDefaultECSConfiguration(): IECSConfiguration {
	return {
		version: ECS_CONFIGURATION_VERSION,
		revision: 0,
		settings: {
			enabled: true,
			autoStart: true,
			safetyChecks: true,
			executionMode: "auto",
			workerCount: 0,
			minimumWorkerEntities: 2048,
			fixedDeltaSeconds: 1 / 60,
			maxCatchUpSteps: 4,
			chunkCapacity: 256,
			traceLimit: 512,
			showHiddenEntitiesInHierarchy: false,
			hierarchyWorldMode: "combined",
		},
		componentTypes: [builtInTransform()],
		systems: [],
		sections: [{ id: "main", name: "Main", autoLoad: true, priority: 0 }],
		typeRegistrationPolicies: [],
	};
}

/** Resolves the effective scene-owned component registry after assembly-wide policy. */
export function getECSTypeRegistration(configuration: IECSConfiguration): IECSTypeRegistrationStatus[] {
	const policies = new Map(configuration.typeRegistrationPolicies.map((policy) => [policy.assembly, policy]));
	return configuration.componentTypes.map((component) => {
		if (component.builtIn) {
			return {
				typeId: component.id,
				name: component.name,
				namespace: component.namespace,
				assembly: component.assembly,
				registered: true,
				reason: "built-in",
			};
		}
		const policy = policies.get(component.assembly);
		if (!policy?.disableAutoRegistration) {
			return { typeId: component.id, name: component.name, namespace: component.namespace, assembly: component.assembly, registered: true, reason: "automatic" };
		}
		const registered = policy.registeredTypeIds.includes(component.id);
		return {
			typeId: component.id,
			name: component.name,
			namespace: component.namespace,
			assembly: component.assembly,
			registered,
			reason: registered ? "explicit" : "assembly-auto-registration-disabled",
		};
	});
}

/** Returns whether one configured component type is visible to the portable TypeManager equivalent. */
export function isECSComponentTypeRegistered(configuration: IECSConfiguration, componentId: string): boolean {
	return getECSTypeRegistration(configuration).some((entry) => entry.typeId === componentId && entry.registered);
}

function validateField(field: IECSFieldDefinition, path: string): void {
	if (!isRecord(field)) {
		throw new Error(`${path} must be an object.`);
	}
	assertExactKeys(field, ["id", "name", "type", "defaultValue", "minimum", "maximum"], path);
	assertIdentifier(field.id, `${path}.id`);
	assertName(field.name, `${path}.name`);
	if (!fieldTypes.includes(field.type)) {
		throw new Error(`${path}.type is unsupported.`);
	}
	field.defaultValue = normalizeECSFieldValue(field.type, field.defaultValue, `${path}.defaultValue`);
	if (field.minimum !== undefined) {
		assertFiniteRange(field.minimum, -1e15, 1e15, `${path}.minimum`);
	}
	if (field.maximum !== undefined) {
		assertFiniteRange(field.maximum, -1e15, 1e15, `${path}.maximum`);
	}
	if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
		throw new Error(`${path}.minimum cannot exceed maximum.`);
	}
	if (field.type === "bool" && (field.minimum !== undefined || field.maximum !== undefined)) {
		throw new Error(`${path} cannot apply numeric bounds to a boolean field.`);
	}
	const defaultLanes = Array.isArray(field.defaultValue) ? field.defaultValue : [field.defaultValue];
	for (const lane of defaultLanes) {
		if (typeof lane === "number" && ((field.minimum !== undefined && lane < field.minimum) || (field.maximum !== undefined && lane > field.maximum))) {
			throw new Error(`${path}.defaultValue must remain inside its numeric bounds.`);
		}
	}
}

function validateReference(reference: IECSFieldReference, path: string, fields: ReadonlyMap<string, IECSFieldDefinition>): void {
	if (!isRecord(reference)) {
		throw new Error(`${path} must be an object.`);
	}
	assertExactKeys(reference, ["componentId", "fieldId"], path);
	assertIdentifier(reference.componentId, `${path}.componentId`);
	assertIdentifier(reference.fieldId, `${path}.fieldId`);
	if (!fields.has(`${reference.componentId}.${reference.fieldId}`)) {
		throw new Error(`${path} references unknown field "${reference.componentId}.${reference.fieldId}".`);
	}
}

function uniqueIdentifiers(values: unknown, maximum: number, path: string, allowed?: ReadonlySet<string>): string[] {
	if (!Array.isArray(values) || values.length > maximum) {
		throw new Error(`${path} must be an array with at most ${maximum} entries.`);
	}
	const result = values.map((value, index) => {
		assertIdentifier(value, `${path}[${index}]`);
		if (allowed && !allowed.has(value)) {
			throw new Error(`${path}[${index}] references unknown id "${value}".`);
		}
		return value;
	});
	if (new Set(result).size !== result.length) {
		throw new Error(`${path} must not contain duplicate ids.`);
	}
	return result;
}

/**
 * Validates the complete cross-referenced model. Mutating a candidate before
 * publication keeps malformed manual metadata and stale external writes from
 * partially replacing a valid scene configuration.
 */
export function validateECSConfiguration(configuration: IECSConfiguration): void {
	if (!isRecord(configuration)) {
		throw new Error("ECS configuration must be an object.");
	}
	assertExactKeys(configuration, ["version", "revision", "settings", "componentTypes", "systems", "sections", "typeRegistrationPolicies"], "ECS configuration");
	if (configuration.version !== ECS_CONFIGURATION_VERSION) {
		throw new Error(`Unsupported ECS configuration version ${String(configuration.version)}.`);
	}
	assertInteger(configuration.revision, 0, Number.MAX_SAFE_INTEGER, "ECS configuration.revision");
	if (!isRecord(configuration.settings)) {
		throw new Error("ECS configuration.settings must be an object.");
	}
	assertExactKeys(
		configuration.settings,
		[
			"enabled",
			"autoStart",
			"safetyChecks",
			"executionMode",
			"workerCount",
			"minimumWorkerEntities",
			"fixedDeltaSeconds",
			"maxCatchUpSteps",
			"chunkCapacity",
			"traceLimit",
			"showHiddenEntitiesInHierarchy",
			"hierarchyWorldMode",
		],
		"ECS configuration.settings"
	);
	for (const key of ["enabled", "autoStart", "safetyChecks", "showHiddenEntitiesInHierarchy"] as const) {
		if (typeof configuration.settings[key] !== "boolean") {
			throw new Error(`ECS configuration.settings.${key} must be boolean.`);
		}
	}
	if (!executionModes.includes(configuration.settings.executionMode)) {
		throw new Error("ECS configuration.settings.executionMode is unsupported.");
	}
	assertInteger(configuration.settings.workerCount, 0, 8, "ECS configuration.settings.workerCount");
	assertInteger(configuration.settings.minimumWorkerEntities, 1, 1_000_000, "ECS configuration.settings.minimumWorkerEntities");
	assertFiniteRange(configuration.settings.fixedDeltaSeconds, 1 / 1000, 1, "ECS configuration.settings.fixedDeltaSeconds");
	assertInteger(configuration.settings.maxCatchUpSteps, 1, 32, "ECS configuration.settings.maxCatchUpSteps");
	assertInteger(configuration.settings.chunkCapacity, 16, 4096, "ECS configuration.settings.chunkCapacity");
	assertInteger(configuration.settings.traceLimit, 16, 4096, "ECS configuration.settings.traceLimit");
	if (!hierarchyWorldModes.includes(configuration.settings.hierarchyWorldMode)) {
		throw new Error("ECS configuration.settings.hierarchyWorldMode is unsupported.");
	}

	if (!Array.isArray(configuration.componentTypes) || !configuration.componentTypes.length || configuration.componentTypes.length > ECS_MAX_COMPONENT_TYPES) {
		throw new Error(`ECS configuration.componentTypes must contain 1 through ${ECS_MAX_COMPONENT_TYPES} entries.`);
	}
	const componentIds = new Set<string>();
	const fields = new Map<string, IECSFieldDefinition>();
	configuration.componentTypes.forEach((component, componentIndex) => {
		const path = `ECS configuration.componentTypes[${componentIndex}]`;
		if (!isRecord(component)) {
			throw new Error(`${path} must be an object.`);
		}
		assertExactKeys(component, ["id", "name", "namespace", "assembly", "fields", "builtIn"], path);
		assertIdentifier(component.id, `${path}.id`);
		assertName(component.name, `${path}.name`);
		assertQualifiedIdentifier(component.namespace, `${path}.namespace`);
		assertQualifiedIdentifier(component.assembly, `${path}.assembly`);
		if (componentIds.has(component.id)) {
			throw new Error(`${path}.id duplicates "${component.id}".`);
		}
		componentIds.add(component.id);
		if (typeof component.builtIn !== "boolean") {
			throw new Error(`${path}.builtIn must be boolean.`);
		}
		if (!Array.isArray(component.fields) || component.fields.length > ECS_MAX_FIELDS_PER_COMPONENT) {
			throw new Error(`${path}.fields must contain at most ${ECS_MAX_FIELDS_PER_COMPONENT} entries.`);
		}
		const fieldIds = new Set<string>();
		component.fields.forEach((field, fieldIndex) => {
			validateField(field, `${path}.fields[${fieldIndex}]`);
			if (fieldIds.has(field.id)) {
				throw new Error(`${path}.fields duplicates "${field.id}".`);
			}
			fieldIds.add(field.id);
			fields.set(`${component.id}.${field.id}`, field);
		});
	});
	const transform = configuration.componentTypes.find((component) => component.id === "transform");
	if (!transform?.builtIn || JSON.stringify(transform) !== JSON.stringify(builtInTransform())) {
		throw new Error("ECS configuration must retain the exact built-in transform component schema.");
	}

	if (!Array.isArray(configuration.typeRegistrationPolicies) || configuration.typeRegistrationPolicies.length > ECS_MAX_TYPE_REGISTRATION_POLICIES) {
		throw new Error(`ECS configuration.typeRegistrationPolicies must contain at most ${ECS_MAX_TYPE_REGISTRATION_POLICIES} entries.`);
	}
	const policyAssemblies = new Set<string>();
	configuration.typeRegistrationPolicies.forEach((policy, index) => {
		const path = `ECS configuration.typeRegistrationPolicies[${index}]`;
		if (!isRecord(policy)) {
			throw new Error(`${path} must be an object.`);
		}
		assertExactKeys(policy, ["assembly", "disableAutoRegistration", "registeredTypeIds"], path);
		assertQualifiedIdentifier(policy.assembly, `${path}.assembly`);
		if (policyAssemblies.has(policy.assembly)) {
			throw new Error(`${path}.assembly duplicates "${policy.assembly}".`);
		}
		policyAssemblies.add(policy.assembly);
		if (typeof policy.disableAutoRegistration !== "boolean") {
			throw new Error(`${path}.disableAutoRegistration must be boolean.`);
		}
		policy.registeredTypeIds = uniqueIdentifiers(policy.registeredTypeIds, ECS_MAX_COMPONENT_TYPES, `${path}.registeredTypeIds`, componentIds);
		for (const typeId of policy.registeredTypeIds) {
			const component = configuration.componentTypes.find((entry) => entry.id === typeId);
			if (component?.assembly !== policy.assembly) {
				throw new Error(`${path}.registeredTypeIds contains "${typeId}" from assembly "${component?.assembly}".`);
			}
			if (component.builtIn) {
				throw new Error(`${path}.registeredTypeIds cannot include built-in type "${typeId}".`);
			}
		}
	});

	if (!Array.isArray(configuration.sections) || !configuration.sections.length || configuration.sections.length > ECS_MAX_SECTIONS) {
		throw new Error(`ECS configuration.sections must contain 1 through ${ECS_MAX_SECTIONS} entries.`);
	}
	const sectionIds = new Set<string>();
	configuration.sections.forEach((section, index) => {
		const path = `ECS configuration.sections[${index}]`;
		if (!isRecord(section)) {
			throw new Error(`${path} must be an object.`);
		}
		assertExactKeys(section, ["id", "name", "autoLoad", "priority"], path);
		assertIdentifier(section.id, `${path}.id`);
		assertName(section.name, `${path}.name`);
		if (sectionIds.has(section.id)) {
			throw new Error(`${path}.id duplicates "${section.id}".`);
		}
		sectionIds.add(section.id);
		if (typeof section.autoLoad !== "boolean") {
			throw new Error(`${path}.autoLoad must be boolean.`);
		}
		assertInteger(section.priority, -1000, 1000, `${path}.priority`);
	});
	if (!sectionIds.has("main")) {
		throw new Error('ECS configuration must retain the "main" section.');
	}

	if (!Array.isArray(configuration.systems) || configuration.systems.length > ECS_MAX_SYSTEMS) {
		throw new Error(`ECS configuration.systems must contain at most ${ECS_MAX_SYSTEMS} entries.`);
	}
	const systemIds = new Set<string>();
	configuration.systems.forEach((system, systemIndex) => {
		const path = `ECS configuration.systems[${systemIndex}]`;
		if (!isRecord(system)) {
			throw new Error(`${path} must be an object.`);
		}
		assertExactKeys(system, ["id", "name", "namespace", "enabled", "phase", "order", "query", "reads", "writes", "dependsOn", "operations"], path);
		assertIdentifier(system.id, `${path}.id`);
		assertName(system.name, `${path}.name`);
		assertQualifiedIdentifier(system.namespace, `${path}.namespace`);
		if (systemIds.has(system.id)) {
			throw new Error(`${path}.id duplicates "${system.id}".`);
		}
		systemIds.add(system.id);
		if (typeof system.enabled !== "boolean" || !phases.includes(system.phase)) {
			throw new Error(`${path} has an invalid enabled state or phase.`);
		}
		assertInteger(system.order, -100_000, 100_000, `${path}.order`);
		if (!isRecord(system.query)) {
			throw new Error(`${path}.query must be an object.`);
		}
		assertExactKeys(system.query, ["all", "any", "none"], `${path}.query`);
		system.query.all = uniqueIdentifiers(system.query.all, 64, `${path}.query.all`, componentIds);
		system.query.any = uniqueIdentifiers(system.query.any, 64, `${path}.query.any`, componentIds);
		system.query.none = uniqueIdentifiers(system.query.none, 64, `${path}.query.none`, componentIds);
		if (system.query.all.some((id) => system.query.none.includes(id)) || system.query.any.some((id) => system.query.none.includes(id))) {
			throw new Error(`${path}.query cannot require and exclude the same component.`);
		}
		for (const [key, references] of [
			["reads", system.reads],
			["writes", system.writes],
		] as const) {
			if (!Array.isArray(references) || references.length > 128) {
				throw new Error(`${path}.${key} must contain at most 128 entries.`);
			}
			references.forEach((reference, index) => validateReference(reference, `${path}.${key}[${index}]`, fields));
			const keys = references.map((reference) => `${reference.componentId}.${reference.fieldId}`);
			if (new Set(keys).size !== keys.length) {
				throw new Error(`${path}.${key} must not contain duplicate field references.`);
			}
		}
		system.dependsOn = uniqueIdentifiers(system.dependsOn, 64, `${path}.dependsOn`);
		if (!Array.isArray(system.operations) || system.operations.length > ECS_MAX_OPERATIONS_PER_SYSTEM) {
			throw new Error(`${path}.operations must contain at most ${ECS_MAX_OPERATIONS_PER_SYSTEM} entries.`);
		}
		const operationIds = new Set<string>();
		system.operations.forEach((operation, operationIndex) => {
			const operationPath = `${path}.operations[${operationIndex}]`;
			if (!isRecord(operation)) {
				throw new Error(`${operationPath} must be an object.`);
			}
			assertExactKeys(operation, ["id", "kind", "target", "source", "constant", "minimum", "maximum", "useDeltaTime"], operationPath);
			assertIdentifier(operation.id, `${operationPath}.id`);
			if (operationIds.has(operation.id)) {
				throw new Error(`${operationPath}.id duplicates "${operation.id}".`);
			}
			operationIds.add(operation.id);
			if (!operationKinds.includes(operation.kind)) {
				throw new Error(`${operationPath}.kind is unsupported.`);
			}
			validateReference(operation.target, `${operationPath}.target`, fields);
			if (operation.source !== undefined) {
				validateReference(operation.source, `${operationPath}.source`, fields);
			}
			for (const key of ["constant", "minimum", "maximum"] as const) {
				if (operation[key] !== undefined) {
					assertFiniteRange(operation[key], -1e15, 1e15, `${operationPath}.${key}`);
				}
			}
			if (typeof operation.useDeltaTime !== "boolean") {
				throw new Error(`${operationPath}.useDeltaTime must be boolean.`);
			}
			const targetKey = `${operation.target.componentId}.${operation.target.fieldId}`;
			if (!system.writes.some((reference) => `${reference.componentId}.${reference.fieldId}` === targetKey)) {
				throw new Error(`${operationPath}.target must be declared in system.writes.`);
			}
			if (operation.source) {
				const sourceKey = `${operation.source.componentId}.${operation.source.fieldId}`;
				if (!system.reads.some((reference) => `${reference.componentId}.${reference.fieldId}` === sourceKey)) {
					throw new Error(`${operationPath}.source must be declared in system.reads.`);
				}
			}
			if ((operation.kind === "copy" || operation.kind === "integrate") && !operation.source) {
				throw new Error(`${operationPath}.${operation.kind} requires source.`);
			}
			if (operation.kind === "clamp" && (operation.minimum === undefined || operation.maximum === undefined || operation.minimum > operation.maximum)) {
				throw new Error(`${operationPath}.clamp requires minimum <= maximum.`);
			}
		});
	});
	configuration.systems.forEach((system, index) => {
		for (const dependency of system.dependsOn) {
			if (!systemIds.has(dependency) || dependency === system.id) {
				throw new Error(`ECS configuration.systems[${index}].dependsOn contains invalid system "${dependency}".`);
			}
		}
	});
}

/** Parses current persisted state, returning defaults only when metadata is absent. */
export function normalizeECSConfiguration(value: unknown): IECSConfiguration {
	if (value === undefined || value === null) {
		return createDefaultECSConfiguration();
	}
	if (!isRecord(value)) {
		throw new Error("ECS configuration must be an object.");
	}
	const candidate = clone(value) as Record<string, any>;
	if (candidate.version === 1) {
		const defaults = createDefaultECSConfiguration();
		candidate.version = ECS_CONFIGURATION_VERSION;
		candidate.settings = { ...defaults.settings, ...(isRecord(candidate.settings) ? candidate.settings : {}) };
		candidate.componentTypes = Array.isArray(candidate.componentTypes)
			? candidate.componentTypes.map((component: Record<string, unknown>) =>
					component.id === "transform" ? builtInTransform() : { ...component, namespace: "Game.Entities", assembly: "game" }
				)
			: candidate.componentTypes;
		candidate.systems = Array.isArray(candidate.systems)
			? candidate.systems.map((system: Record<string, unknown>) => ({ ...system, namespace: "Game.Systems" }))
			: candidate.systems;
		candidate.typeRegistrationPolicies = [];
	}
	const configuration = candidate as unknown as IECSConfiguration;
	validateECSConfiguration(configuration);
	return configuration;
}

/** Reads scene ECS metadata and optionally persists deterministic defaults. */
export function getSceneECSConfiguration(scene: IECSMetadataHost, persist = true): IECSConfiguration {
	const configuration = normalizeECSConfiguration(scene.metadata?.babylonEditorECS);
	if (persist && !scene.metadata?.babylonEditorECS) {
		scene.metadata ??= {};
		scene.metadata.babylonEditorECS = clone(configuration);
	}
	return clone(configuration);
}

/** Replaces validated scene metadata without implicitly changing its revision. */
export function setSceneECSConfiguration(scene: IECSMetadataHost, configuration: IECSConfiguration): IECSConfiguration {
	const candidate = clone(configuration);
	validateECSConfiguration(candidate);
	scene.metadata ??= {};
	scene.metadata.babylonEditorECS = candidate;
	return clone(candidate);
}

function normalizeLegacyValues(value: unknown): Record<string, number> {
	if (!isRecord(value)) {
		return {};
	}
	const normalized: Record<string, number> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (Object.keys(normalized).length >= ECS_MAX_FIELDS_PER_COMPONENT) {
			break;
		}
		if (identifierPattern.test(key) && typeof entry === "number" && Number.isFinite(entry)) {
			normalized[key] = entry;
		}
	}
	return normalized;
}

function normalizeAuthoredFieldValue(value: unknown): ECSFieldValue | null {
	if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
		return value;
	}
	if (Array.isArray(value) && value.length >= 2 && value.length <= 4 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
		return [...value];
	}
	return null;
}

/**
 * Migrates the original archetype/numeric-values payload into version 2 while
 * remaining fail-open for hand-edited scene data. Strict schema conformance is
 * enforced later by the baker against the selected scene configuration.
 */
export function normalizeEntityComponentData(data: Readonly<Record<string, unknown>>): IEntityComponentData {
	const archetype = typeof data.archetype === "string" && data.archetype.trim() && data.archetype.length <= 120 ? data.archetype.trim() : "Default";
	const sectionId = typeof data.sectionId === "string" && identifierPattern.test(data.sectionId) ? data.sectionId : "main";
	const components: Record<string, Record<string, ECSFieldValue>> = {};
	if (isRecord(data.components)) {
		for (const [componentId, rawFields] of Object.entries(data.components).slice(0, ECS_MAX_COMPONENT_TYPES)) {
			if (!identifierPattern.test(componentId) || !isRecord(rawFields)) {
				continue;
			}
			const fields: Record<string, ECSFieldValue> = {};
			for (const [fieldId, rawValue] of Object.entries(rawFields).slice(0, ECS_MAX_FIELDS_PER_COMPONENT)) {
				if (!identifierPattern.test(fieldId)) {
					continue;
				}
				const normalized = normalizeAuthoredFieldValue(rawValue);
				if (normalized !== null) {
					fields[fieldId] = normalized;
				}
			}
			components[componentId] = fields;
		}
	}
	return {
		version: ECS_ENTITY_COMPONENT_VERSION,
		archetype,
		sectionId,
		values: normalizeLegacyValues(data.values),
		components,
		bakingEnabled: data.bakingEnabled !== false,
		hiddenInHierarchy: data.hiddenInHierarchy === true,
	};
}
