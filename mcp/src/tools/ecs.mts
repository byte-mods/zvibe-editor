import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const finite = z.number().finite();
const identifier = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
	.describe("Stable ECS schema id.");
const entityId = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
	.describe("Stable baked or runtime entity id.");
const name = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.regex(/^[^\0\r\n]+$/);
const qualifiedIdentifier = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)
	.describe("Bounded namespace or assembly identifier.");
const ecsFingerprint = z
	.string()
	.length(16)
	.regex(/^[a-f0-9]{16}$/)
	.describe("Exact 64-bit FNV-1a ECS configuration fingerprint returned by inspect_ecs.");
const sourceHash = z
	.string()
	.length(16)
	.regex(/^[a-f0-9]{16}$/);
const expectedRevision = z.number().int().min(0).safe().describe("Exact ECS authoring revision returned by inspect_ecs.");
const expectedGeneration = z.number().int().min(1).safe().describe("Exact live ECS world generation returned by inspect_ecs.");
const expectedStatus = z.enum(["stopped", "running", "paused"]).optional();
const fieldType = z.enum(["f64", "f32", "i32", "u32", "bool", "vec2", "vec3", "vec4", "quat"]);
const fieldValue = z.union([finite, z.boolean(), z.tuple([finite, finite]), z.tuple([finite, finite, finite]), z.tuple([finite, finite, finite, finite])]);
const phase = z.enum(["fixed", "update", "late"]);
const executionMode = z.enum(["auto", "main-thread", "worker"]);
const uniqueIdentifiers = (maximum: number) =>
	z
		.array(identifier)
		.max(maximum)
		.refine((values) => new Set(values).size === values.length, "Ids must be unique.");
const nonEmpty = <T extends z.ZodRawShape>(shape: T, label: string) =>
	z
		.object(shape)
		.strict()
		.refine((value) => Object.keys(value).length > 0, `${label} cannot be empty.`);

const authoringLease = {
	expectedRevision,
	expectedFingerprint: ecsFingerprint,
};
const runtimeLease = {
	expectedGeneration,
	expectedStatus,
};
const fieldReference = z.object({ componentId: identifier, fieldId: identifier }).strict();
const query = z
	.object({
		all: uniqueIdentifiers(64),
		any: uniqueIdentifiers(64),
		none: uniqueIdentifiers(64),
	})
	.strict()
	.refine(
		(value) => !value.all.some((id) => value.none.includes(id)) && !value.any.some((id) => value.none.includes(id)),
		"A query cannot require and exclude the same component."
	);
const operation = z
	.object({
		id: identifier,
		kind: z.enum(["set", "add", "multiply", "copy", "integrate", "clamp"]),
		target: fieldReference,
		source: fieldReference.optional(),
		constant: finite.min(-1e15).max(1e15).optional(),
		minimum: finite.min(-1e15).max(1e15).optional(),
		maximum: finite.min(-1e15).max(1e15).optional(),
		useDeltaTime: z.boolean(),
	})
	.strict()
	.superRefine((value, context) => {
		if (["set", "add", "multiply"].includes(value.kind) && value.constant === undefined) {
			context.addIssue({ code: "custom", message: `${value.kind} requires constant.` });
		}
		if (["copy", "integrate"].includes(value.kind) && !value.source) {
			context.addIssue({ code: "custom", message: `${value.kind} requires source.` });
		}
		if (value.kind === "clamp" && (value.minimum === undefined || value.maximum === undefined || value.minimum > value.maximum)) {
			context.addIssue({ code: "custom", message: "clamp requires minimum <= maximum." });
		}
	});
const fieldDefinition = z
	.object({
		id: identifier,
		name,
		type: fieldType,
		defaultValue: fieldValue,
		minimum: finite.min(-1e15).max(1e15).optional(),
		maximum: finite.min(-1e15).max(1e15).optional(),
	})
	.strict();
const createField = z
	.object({
		id: identifier.optional(),
		name,
		type: fieldType,
		defaultValue: fieldValue,
		minimum: finite.min(-1e15).max(1e15).optional(),
		maximum: finite.min(-1e15).max(1e15).optional(),
	})
	.strict();
const fieldChanges = nonEmpty(
	{
		name: name.optional(),
		type: fieldType.optional(),
		defaultValue: fieldValue.optional(),
		minimum: finite.min(-1e15).max(1e15).nullable().optional(),
		maximum: finite.min(-1e15).max(1e15).nullable().optional(),
	},
	"ECS field changes"
);
const componentDefinition = z
	.object({ id: identifier, name, namespace: qualifiedIdentifier, assembly: qualifiedIdentifier, fields: z.array(fieldDefinition).max(64), builtIn: z.boolean() })
	.strict();
const createComponent = z
	.object({
		id: identifier.optional(),
		name,
		namespace: qualifiedIdentifier.optional(),
		assembly: qualifiedIdentifier.optional(),
		fields: z.array(fieldDefinition).max(64).optional(),
	})
	.strict();
const systemFields = {
	name,
	namespace: qualifiedIdentifier,
	enabled: z.boolean(),
	phase,
	order: z.number().int().min(-100_000).max(100_000),
	query,
	reads: z.array(fieldReference).max(128),
	writes: z.array(fieldReference).max(128),
	dependsOn: uniqueIdentifiers(64),
	operations: z.array(operation).max(64),
};
const systemDefinition = z.object({ id: identifier, ...systemFields }).strict();
const createSystem = z
	.object({
		id: identifier.optional(),
		name,
		namespace: systemFields.namespace.optional(),
		enabled: systemFields.enabled.optional(),
		phase: systemFields.phase.optional(),
		order: systemFields.order.optional(),
		query: systemFields.query.optional(),
		reads: systemFields.reads.optional(),
		writes: systemFields.writes.optional(),
		dependsOn: systemFields.dependsOn.optional(),
		operations: systemFields.operations.optional(),
	})
	.strict();
const systemChanges = nonEmpty(
	{
		name: systemFields.name.optional(),
		namespace: systemFields.namespace.optional(),
		enabled: systemFields.enabled.optional(),
		phase: systemFields.phase.optional(),
		order: systemFields.order.optional(),
		query: systemFields.query.optional(),
		reads: systemFields.reads.optional(),
		writes: systemFields.writes.optional(),
		dependsOn: systemFields.dependsOn.optional(),
		operations: systemFields.operations.optional(),
	},
	"ECS system changes"
);
const sectionDefinition = z.object({ id: identifier, name, autoLoad: z.boolean(), priority: z.number().int().min(-1000).max(1000) }).strict();
const createSection = z.object({ id: identifier.optional(), name, autoLoad: z.boolean().optional(), priority: z.number().int().min(-1000).max(1000).optional() }).strict();
const sectionChanges = nonEmpty({ name: name.optional(), autoLoad: z.boolean().optional(), priority: z.number().int().min(-1000).max(1000).optional() }, "ECS section changes");
const settings = z
	.object({
		enabled: z.boolean(),
		autoStart: z.boolean(),
		safetyChecks: z.boolean(),
		executionMode,
		workerCount: z.number().int().min(0).max(8),
		minimumWorkerEntities: z.number().int().min(1).max(1_000_000),
		fixedDeltaSeconds: finite.min(1 / 1000).max(1),
		maxCatchUpSteps: z.number().int().min(1).max(32),
		chunkCapacity: z.number().int().min(16).max(4096),
		traceLimit: z.number().int().min(16).max(4096),
		showHiddenEntitiesInHierarchy: z.boolean(),
		hierarchyWorldMode: z.enum(["authoring", "runtime", "combined"]),
	})
	.strict();
const settingsChanges = nonEmpty(
	{
		enabled: z.boolean().optional(),
		autoStart: z.boolean().optional(),
		safetyChecks: z.boolean().optional(),
		executionMode: executionMode.optional(),
		workerCount: z.number().int().min(0).max(8).optional(),
		minimumWorkerEntities: z.number().int().min(1).max(1_000_000).optional(),
		fixedDeltaSeconds: finite
			.min(1 / 1000)
			.max(1)
			.optional(),
		maxCatchUpSteps: z.number().int().min(1).max(32).optional(),
		chunkCapacity: z.number().int().min(16).max(4096).optional(),
		traceLimit: z.number().int().min(16).max(4096).optional(),
		showHiddenEntitiesInHierarchy: z.boolean().optional(),
		hierarchyWorldMode: z.enum(["authoring", "runtime", "combined"]).optional(),
	},
	"ECS settings changes"
);
const configuration = z
	.object({
		settings,
		componentTypes: z.array(componentDefinition).min(1).max(256),
		systems: z.array(systemDefinition).max(256),
		sections: z.array(sectionDefinition).min(1).max(256),
		typeRegistrationPolicies: z
			.array(
				z
					.object({
						assembly: qualifiedIdentifier,
						disableAutoRegistration: z.boolean(),
						registeredTypeIds: uniqueIdentifiers(256),
					})
					.strict()
			)
			.max(128),
	})
	.strict();
const runtimeCommand = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("set-field"), entityId, componentId: identifier, fieldId: identifier, value: fieldValue }).strict(),
	z.object({ kind: z.literal("destroy-entity"), entityId, confirm: z.literal(true) }).strict(),
	z.object({ kind: z.literal("instantiate-entity"), sourceEntityId: entityId, entityId }).strict(),
	z.object({ kind: z.literal("set-section-loaded"), sectionId: identifier, loaded: z.boolean() }).strict(),
]);

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutationAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

function register(
	server: McpServer,
	toolName: string,
	title: string,
	description: string,
	inputSchema: z.ZodTypeAny,
	annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
): void {
	server.registerTool(toolName, { title, description, inputSchema, annotations }, async (args): Promise<CallToolResult> => callTextTool(toolName, args));
}

/** Registers complete portable data-oriented authoring, baking, runtime, streaming, and debugger controls. */
export function registerECSTools(server: McpServer): void {
	register(
		server,
		"inspect_ecs",
		"Inspect ECS",
		"Read the complete versioned scene ECS configuration, exact revision/fingerprint lease, runtime report, and bounded typed-chunk world summary.",
		z.object({}).strict(),
		readOnlyAnnotations
	);
	register(
		server,
		"replace_ecs_configuration",
		"Replace ECS configuration",
		"Atomically replace the complete portable ECS schema, systems, settings, and sections under the exact authoring lease. This does not claim Unity Entities package or Burst-native binary identity.",
		z.object({ ...authoringLease, configuration }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"delete_ecs_configuration",
		"Delete ECS configuration",
		"Delete the scene-owned ECS asset and dispose its runtime under the exact authoring lease after literal confirmation. The operation is rejected while Entity components remain.",
		z.object({ ...authoringLease, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"set_ecs_settings",
		"Set ECS settings",
		"Patch bounded ECS enable, fixed-step, chunk, safety, tracing, and portable main-thread/Worker execution settings under the exact authoring lease.",
		z.object({ ...authoringLease, settings: settingsChanges }).strict(),
		mutationAnnotations
	);
	register(
		server,
		"create_ecs_component_type",
		"Create ECS component type",
		"Create one stable-id typed ECS component schema with bounded scalar, boolean, vector, or quaternion fields.",
		z.object({ ...authoringLease, component: createComponent }).strict(),
		mutationAnnotations
	);
	register(
		server,
		"set_ecs_component_type",
		"Set ECS component type",
		"Patch one non-built-in ECS component type's display name, namespace, or assembly under the exact authoring lease; use field tools for schema changes.",
		z
			.object({
				...authoringLease,
				componentId: identifier,
				changes: nonEmpty({ name: name.optional(), namespace: qualifiedIdentifier.optional(), assembly: qualifiedIdentifier.optional() }, "ECS component changes"),
			})
			.strict(),
		mutationAnnotations
	);
	register(
		server,
		"delete_ecs_component_type",
		"Delete ECS component type",
		"Delete one unreferenced non-built-in ECS component type after literal confirmation. System and authored-entity references are rejected.",
		z.object({ ...authoringLease, componentId: identifier, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"create_ecs_field",
		"Create ECS field",
		"Create one bounded typed field on an editable ECS component schema under the exact authoring lease.",
		z.object({ ...authoringLease, componentId: identifier, field: createField }).strict(),
		mutationAnnotations
	);
	register(
		server,
		"set_ecs_field",
		"Set ECS field",
		"Patch one exact ECS field definition; null minimum or maximum removes that bound. Cross-references and typed defaults are validated atomically.",
		z.object({ ...authoringLease, componentId: identifier, fieldId: identifier, changes: fieldChanges }).strict(),
		mutationAnnotations
	);
	register(
		server,
		"delete_ecs_field",
		"Delete ECS field",
		"Delete one unreferenced ECS field after literal confirmation. System and authored-entity references are rejected.",
		z.object({ ...authoringLease, componentId: identifier, fieldId: identifier, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"create_ecs_system",
		"Create ECS system",
		"Create one declarative fixed/update/late ECS system with a typed query, access declarations, dependencies, and portable compiled operations.",
		z.object({ ...authoringLease, system: createSystem }).strict(),
		mutationAnnotations
	);
	register(
		server,
		"set_ecs_system",
		"Set ECS system",
		"Atomically patch one ECS system while validating component access, operation fields, dependency phases, conflicts, and cycles.",
		z.object({ ...authoringLease, systemId: identifier, changes: systemChanges }).strict(),
		mutationAnnotations
	);
	register(
		server,
		"delete_ecs_system",
		"Delete ECS system",
		"Delete one ECS system after literal confirmation when no remaining system depends on it.",
		z.object({ ...authoringLease, systemId: identifier, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"create_ecs_section",
		"Create ECS section",
		"Create one stable streaming section with authored auto-load behavior and deterministic priority.",
		z.object({ ...authoringLease, section: createSection }).strict(),
		mutationAnnotations
	);
	register(
		server,
		"set_ecs_section",
		"Set ECS section",
		"Patch one ECS streaming section name, auto-load state, or priority under the exact authoring lease.",
		z.object({ ...authoringLease, sectionId: identifier, changes: sectionChanges }).strict(),
		mutationAnnotations
	);
	register(
		server,
		"delete_ecs_section",
		"Delete ECS section",
		"Delete one unused non-main ECS streaming section after literal confirmation.",
		z.object({ ...authoringLease, sectionId: identifier, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"validate_ecs",
		"Validate ECS",
		"Read-only validation of the complete ECS model, cross-references, dependency schedule, full bake report, and bounded world snapshot.",
		z.object({}).strict(),
		readOnlyAnnotations
	);
	register(
		server,
		"bake_ecs",
		"Bake ECS",
		"Run a full or source-lease-guarded incremental bake into typed archetype chunks and return runtime, schedule, trace, section, and bounded world evidence.",
		z
			.object({
				...authoringLease,
				expectedGeneration: expectedGeneration.optional(),
				mode: z.enum(["full", "incremental"]).optional(),
				expectedSourceHashes: z
					.record(entityId, sourceHash)
					.refine((value) => Object.keys(value).length <= 10_000, "At most 10,000 source leases may be supplied.")
					.optional(),
				includeValues: z.boolean().optional(),
				chunkOffset: z.number().int().min(0).max(1_000_000).optional(),
				chunkLimit: z.number().int().min(1).max(256).optional(),
			})
			.strict(),
		mutationAnnotations
	);
	register(
		server,
		"control_ecs_runtime",
		"Control ECS runtime",
		"Start, resume, pause, or stop the live ECS world under its exact generation and optional status lease.",
		z.object({ ...runtimeLease, action: z.enum(["start", "resume", "pause", "stop"]) }).strict(),
		{ ...mutationAnnotations, idempotentHint: true }
	);
	register(
		server,
		"step_ecs_runtime",
		"Step ECS runtime",
		"Execute one bounded ECS frame with deterministic fixed/update/late ordering, deferred-command playback, and optional real Web Worker kernels.",
		z.object({ ...runtimeLease, deltaSeconds: finite.min(0).max(1), useWorkers: z.boolean().optional() }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"queue_ecs_runtime_command",
		"Queue ECS runtime command",
		"Queue one exact-generation field write, entity instantiate/destroy, or section load-state command for atomic deferred playback. Destroy requires literal confirmation.",
		z.object({ ...runtimeLease, command: runtimeCommand }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"playback_ecs_runtime_commands",
		"Playback ECS runtime commands",
		"Atomically validate and apply all queued exact-generation ECS structural commands, publishing a new generation only if every command succeeds.",
		z.object(runtimeLease).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"query_ecs_entities",
		"Query ECS entities",
		"Read a bounded page of live entities by required, optional-any, excluded components, section, and loaded state, with optional typed field values.",
		z
			.object({
				all: uniqueIdentifiers(64).optional(),
				any: uniqueIdentifiers(64).optional(),
				none: uniqueIdentifiers(64).optional(),
				sectionId: identifier.optional(),
				loadedOnly: z.boolean().optional(),
				includeValues: z.boolean().optional(),
				search: z
					.string()
					.trim()
					.max(256)
					.regex(/^[^\0\r\n]*$/)
					.optional(),
				showHidden: z.boolean().optional(),
				origin: z.enum(["authoring", "runtime"]).optional(),
				offset: z.number().int().min(0).max(1_000_000).optional(),
				limit: z.number().int().min(1).max(1000).optional(),
			})
			.strict(),
		readOnlyAnnotations
	);
	register(
		server,
		"inspect_ecs_schedule",
		"Inspect ECS schedule",
		"Read the immutable compiled phase batches, dependency/conflict ordering, runtime backend evidence, and bounded execution traces.",
		z.object({}).strict(),
		readOnlyAnnotations
	);
	register(
		server,
		"set_ecs_hierarchy_preferences",
		"Set ECS hierarchy preferences",
		"Persist whether hidden Entities appear in the main Hierarchy and choose the authoring, runtime, or combined Entities debugger world under the exact authoring lease.",
		z
			.object({
				...authoringLease,
				showHiddenEntitiesInHierarchy: z.boolean().optional(),
				hierarchyWorldMode: z.enum(["authoring", "runtime", "combined"]).optional(),
			})
			.strict()
			.refine((value) => value.showHiddenEntitiesInHierarchy !== undefined || value.hierarchyWorldMode !== undefined, "At least one hierarchy preference is required."),
		mutationAnnotations
	);
	register(
		server,
		"query_ecs_hierarchy",
		"Query ECS hierarchy",
		"Read a bounded authoring, runtime, or combined Entity hierarchy page with name, parent path, hidden state, origin, archetype, section, and components. Runtime/combined reads require the exact live generation.",
		z
			.object({
				...authoringLease,
				expectedGeneration: expectedGeneration.optional(),
				world: z.enum(["authoring", "runtime", "combined"]).optional(),
				showHidden: z.boolean().optional(),
				search: z
					.string()
					.trim()
					.max(256)
					.regex(/^[^\0\r\n]*$/)
					.optional(),
				sectionId: identifier.optional(),
				offset: z.number().int().min(0).max(1_000_000).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			})
			.strict()
			.superRefine((value, context) => {
				if ((value.world === "runtime" || value.world === "combined") && value.expectedGeneration === undefined) {
					context.addIssue({ code: "custom", message: "runtime and combined hierarchy reads require expectedGeneration." });
				}
			}),
		readOnlyAnnotations
	);
	register(
		server,
		"query_ecs_systems_window",
		"Query ECS Systems window",
		"Run the bounded Systems quick-search language and structured namespace, phase, enabled, read, write, and component filters under the exact authoring lease. Quick tokens use namespace:, phase:, enabled:, reads:, writes:, or component:.",
		z
			.object({
				...authoringLease,
				search: z
					.string()
					.max(256)
					.regex(/^[^\0\r\n]*$/)
					.optional(),
				namespaces: z.array(qualifiedIdentifier).max(32).optional(),
				phases: z.array(phase).max(3).optional(),
				enabled: z.boolean().optional(),
				reads: uniqueIdentifiers(32).optional(),
				writes: uniqueIdentifiers(32).optional(),
				components: uniqueIdentifiers(32).optional(),
				offset: z.number().int().min(0).max(1_000_000).optional(),
				limit: z.number().int().min(1).max(256).optional(),
			})
			.strict(),
		readOnlyAnnotations
	);
	register(
		server,
		"inspect_ecs_type_registry",
		"Inspect ECS type registry",
		"Read a bounded page of effective component registration status and assembly-wide policies. This is Zvibe's portable registry, not Unity TypeManager or C# attribute identity.",
		z
			.object({
				assembly: qualifiedIdentifier.optional(),
				registered: z.boolean().optional(),
				offset: z.number().int().min(0).max(1_000_000).optional(),
				limit: z.number().int().min(1).max(256).optional(),
			})
			.strict(),
		readOnlyAnnotations
	);
	register(
		server,
		"set_ecs_type_registration_policy",
		"Set ECS type registration policy",
		"Create or replace one assembly-wide auto-registration policy under the exact authoring lease. When auto-registration is disabled, only explicit registeredTypeIds are usable by bakers and compiled systems.",
		z
			.object({
				...authoringLease,
				policy: z
					.object({ assembly: qualifiedIdentifier, disableAutoRegistration: z.boolean(), registeredTypeIds: uniqueIdentifiers(256) })
					.strict()
					.refine((value) => value.disableAutoRegistration || value.registeredTypeIds.length === 0, "Enabled auto-registration cannot have explicit registeredTypeIds."),
			})
			.strict(),
		mutationAnnotations
	);
	register(
		server,
		"delete_ecs_type_registration_policy",
		"Delete ECS type registration policy",
		"Delete one assembly-wide registration policy under the exact authoring lease after literal confirmation, restoring automatic registration for that assembly.",
		z.object({ ...authoringLease, assembly: qualifiedIdentifier, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
}
