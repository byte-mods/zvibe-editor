import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerPrefabTools(server: McpServer): void {
	const prefabProperties = z.object({
		name: z.string().min(1).max(256).optional(),
		position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
		rotation: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
		scaling: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
		visibility: z.number().finite().min(0).max(1).optional(),
		isVisible: z.boolean().optional(),
	});
	const nonEmptyPrefabProperties = prefabProperties.refine((value) => Object.keys(value).length > 0, { message: "At least one prefab property is required." });
	const prefabStageSettings = z
		.object({
			version: z.literal(1),
			mode: z.enum(["isolation", "context"]),
			contextAppearance: z.enum(["normal", "gray", "hidden"]),
			showOverrides: z.boolean(),
			autoSave: z.boolean(),
			environment: z.enum(["neutral", "scene"]),
			backgroundColor: z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1), z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)]),
			lightIntensity: z.number().finite().min(0).max(16),
		})
		.strict();
	const structuralProperties = prefabProperties.omit({ name: true });
	const serializedMesh = z
		.json()
		.refine((value) => !!value && typeof value === "object" && !Array.isArray(value), { message: "serializedMesh must be a serialized Babylon mesh object." })
		.refine((value) => JSON.stringify(value).length <= 2 * 1024 * 1024, { message: "serializedMesh must not exceed 2 MiB." });
	const propertyPath = z
		.string()
		.min(1)
		.max(512)
		.regex(/^\//, "Use an RFC 6901 JSON Pointer beginning with /.")
		.describe("Existing serialized node property as JSON Pointer, for example /metadata/gameplay/health.");
	const propertyValue = z.json().refine((value) => JSON.stringify(value).length <= 64 * 1024, { message: "Serialized property value must not exceed 64 KiB." });
	const propertyOverrides = z.array(z.object({ nodeName: z.string().min(1).max(256), path: propertyPath, value: propertyValue })).max(512);
	const structuralOverrides = z.object({
		removals: z.array(z.string().min(1).max(256)).max(512).optional(),
		additions: z
			.array(
				z.object({
					nodeName: z.string().min(1).max(256).describe("New stable source identity, unique across the resolved prefab."),
					displayName: z.string().min(1).max(256),
					parentNodeName: z.string().min(1).max(256).nullable().describe("Stable parent identity; null means the prefab root."),
					kind: z.enum(["transform", "cloneMesh", "nestedPrefab", "mesh"]),
					cloneSourceNodeName: z.string().min(1).max(256).optional().describe("Required mesh source identity when kind is cloneMesh."),
					prefabPath: z.string().min(1).max(512).optional().describe("Required contained .prefab asset path when kind is nestedPrefab."),
					serializedMesh: serializedMesh.optional().describe("Required one-mesh bounded Babylon serialization when kind is mesh."),
					properties: structuralProperties.optional(),
				})
			)
			.max(256)
			.optional(),
		reparents: z
			.array(
				z.object({
					nodeName: z.string().min(1).max(256),
					parentNodeName: z.string().min(1).max(256).nullable().describe("Stable parent identity; null means the prefab root."),
				})
			)
			.max(512)
			.optional(),
	});
	const componentKey = z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
		.describe("Serialized node metadata key. Prefab identity/runtime keys are protected.");
	const componentValue = z.json().refine((value) => JSON.stringify(value).length <= 64 * 1024, { message: "Serialized component value must not exceed 64 KiB." });
	const componentOverrides = z.object({
		additions: z
			.array(z.object({ nodeName: z.string().min(1).max(256), componentKey, value: componentValue }))
			.max(512)
			.optional(),
		removals: z
			.array(z.object({ nodeName: z.string().min(1).max(256), componentKey }))
			.max(512)
			.optional(),
	});
	const prefabInstanceTarget = {
		nodeId: z.string().min(1).optional().describe("Exact live scene node id. Supply nodeId or nodeName."),
		nodeName: z.string().min(1).max(256).optional().describe("Unique live scene node name. Supply nodeId when names are ambiguous."),
		targetPath: z.string().min(1).max(512).optional().describe("Exact prefab boundary path returned by inspection; the outer boundary is used when omitted."),
		targetIndex: z.number().int().min(0).optional().describe("Exact ordered boundary index returned by inspection; required when the same targetPath occurs more than once."),
	};
	const requirePrefabInstanceTarget = <T extends z.ZodRawShape>(shape: T) =>
		z
			.object({ ...prefabInstanceTarget, ...shape })
			.strict()
			.refine(
				(value) => {
					const target = value as { nodeId?: string; nodeName?: string };
					return !!target.nodeId || !!target.nodeName;
				},
				{ message: "Supply nodeId or nodeName." }
			);
	const exactRevision = z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.describe("Exact SHA-256 revision returned by inspection.");
	const exactOverrideFingerprint = z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.describe("Exact complete live-instance fingerprint returned by override inspection.");
	const overrideEntryIds = z
		.array(z.string().regex(/^[a-f0-9]{64}$/))
		.min(1)
		.max(4096)
		.refine((values) => new Set(values).size === values.length, { message: "entryIds must not contain duplicates." })
		.describe("Stable override ids returned by inspect_prefab_instance_overrides. Structural rows must be selected as one complete batch.");
	const exactBulkOverrideFingerprint = z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.describe("Exact deterministic batch fingerprint returned by inspect_prefab_instances_overrides.");
	const prefabReviewIdentity = z
		.object({
			id: z
				.string()
				.min(1)
				.max(128)
				.regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/)
				.describe("Stable collaboration member or local reviewer id."),
			name: z.string().min(1).max(128).describe("Reviewer display name. Collaboration mode derives the authoritative member name from id."),
		})
		.strict();
	const prefabReviewActor = {
		actorId: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/)
			.optional()
			.describe("Stable local actor id when collaboration enforcement is disabled."),
		actorName: z.string().min(1).max(128).optional().describe("Local actor display name when collaboration enforcement is disabled."),
		collaborationToken: z.string().min(1).max(128).optional().describe("Active collaboration session token; required when project collaboration enforcement is enabled."),
	};
	const bulkPrefabTarget = z
		.object({
			nodeId: z.string().min(1).optional().describe("Exact live scene node id. Supply exactly one of nodeId or nodeName."),
			nodeName: z.string().min(1).max(256).optional().describe("Unique live scene node name. Supply exactly one of nodeId or nodeName."),
			targetPath: z.string().min(1).max(512).optional().describe("Exact prefab boundary path; the outer boundary is used when omitted."),
			targetIndex: z.number().int().min(0).max(16).optional().describe("Exact ordered boundary index; required when targetPath occurs more than once."),
		})
		.strict()
		.superRefine((value, context) => {
			if (Number(value.nodeId !== undefined) + Number(value.nodeName !== undefined) !== 1) {
				context.addIssue({ code: "custom", message: "Supply exactly one of nodeId or nodeName." });
			}
		});
	const bulkPrefabSelectorFields = {
		targets: z.array(bulkPrefabTarget).min(1).max(64).optional().describe("Explicit exact live boundaries; use this when scene-wide discovery exceeds 64 targets."),
		path: z.string().min(1).max(512).optional().describe("Discover every live boundary for one project-relative .prefab path."),
		all: z.literal(true).optional().describe("Discover every outer live prefab instance in the active scene."),
	};
	const requireOneBulkPrefabSelector = <T extends z.ZodRawShape>(shape: T) =>
		z
			.object({ ...bulkPrefabSelectorFields, ...shape })
			.strict()
			.superRefine((value, context) => {
				const selector = value as { targets?: unknown; path?: unknown; all?: unknown };
				if (Number(selector.targets !== undefined) + Number(selector.path !== undefined) + Number(selector.all === true) !== 1) {
					context.addIssue({ code: "custom", message: "Supply exactly one selector: targets, path, or all=true." });
				}
			});
	const bulkPrefabOperation = z
		.object({
			targetId: z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.describe("Exact targetId returned by bulk inspection."),
			nodeId: z.string().min(1).optional(),
			nodeName: z.string().min(1).max(256).optional(),
			targetPath: z.string().min(1).max(512).optional(),
			targetIndex: z.number().int().min(0).max(16).optional(),
			expectedRevision: exactRevision,
			expectedFingerprint: exactOverrideFingerprint,
			entryIds: overrideEntryIds,
		})
		.strict()
		.superRefine((value, context) => {
			if (Number(value.nodeId !== undefined) + Number(value.nodeName !== undefined) !== 1) {
				context.addIssue({ code: "custom", message: "Each operation must supply exactly one of nodeId or nodeName." });
			}
		});
	const bulkPrefabOperations = z
		.array(bulkPrefabOperation)
		.min(1)
		.max(64)
		.superRefine((operations, context) => {
			if (new Set(operations.map((operation) => operation.targetId)).size !== operations.length) {
				context.addIssue({ code: "custom", message: "operations must not repeat a targetId." });
			}
			if (operations.reduce((total, operation) => total + operation.entryIds.length, 0) > 8192) {
				context.addIssue({ code: "custom", message: "A bulk mutation may select at most 8192 aggregate override rows." });
			}
		});
	server.registerTool(
		"list_prefabs",
		{ title: "List prefabs", description: "List persisted .prefab mesh-hierarchy assets in the project.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_prefabs", {})
	);
	server.registerTool(
		"get_prefab",
		{
			title: "Get prefab",
			description: "Read a persisted prefab asset's serialized mesh hierarchy.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_prefab", args)
	);
	server.registerTool(
		"create_prefab",
		{
			title: "Create prefab",
			description: "Serialize a mesh root and its hierarchy into a reusable project-relative .prefab asset. Existing assets require explicit overwrite confirmation.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), path: z.string(), overwrite: z.literal(true).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_prefab", args)
	);
	server.registerTool(
		"create_prefab_variant",
		{
			title: "Create prefab variant",
			description:
				"Create a derived prefab asset from a base prefab with root, named-node, arbitrary property, and bounded add/remove/reparent structural overrides. The variant uses recursive live composition and the normal prefab instantiate workflow.",
			inputSchema: z.object({
				basePath: z.string(),
				path: z.string(),
				rootOverrides: z
					.object({
						name: z.string().optional(),
						position: z.array(z.number()).length(3).optional(),
						rotation: z.array(z.number()).length(3).optional(),
						scaling: z.array(z.number()).length(3).optional(),
						visibility: z.number().optional(),
						isVisible: z.boolean().optional(),
					})
					.optional(),
				nodeOverrides: z
					.array(
						z.object({
							nodeName: z.string(),
							properties: z.object({
								name: z.string().optional(),
								position: z.array(z.number()).length(3).optional(),
								rotation: z.array(z.number()).length(3).optional(),
								scaling: z.array(z.number()).length(3).optional(),
								visibility: z.number().optional(),
								isVisible: z.boolean().optional(),
							}),
						})
					)
					.optional(),
				propertyOverrides: propertyOverrides.optional(),
				structuralOverrides: structuralOverrides.optional(),
				componentOverrides: componentOverrides.optional(),
				overwrite: z.literal(true).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_prefab_variant", args)
	);
	server.registerTool(
		"list_prefab_reviews",
		{
			title: "List Prefab reviews",
			description:
				"List bounded project-local Prefab review requests from metadata stored separately from runtime assets. Returns stable ownership/reviewer identities, request rounds, current resolved revisions, stale flags, and revision-bound approval summaries; optionally filters by state.",
			inputSchema: z
				.object({
					state: z.enum(["draft", "inReview", "closed"]).optional(),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(100).optional(),
					collaborationToken: prefabReviewActor.collaborationToken,
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_prefab_reviews", args)
	);
	server.registerTool(
		"inspect_prefab_review",
		{
			title: "Inspect Prefab review",
			description:
				"Inspect one Prefab's separate review record and a bounded comment page. Returns the exact review fingerprint required for mutation, current and reviewed resolved revisions, automatic stale state, stable owner/reviewers, full decision evidence, and the current round's approval summary. Missing reviews return a deterministic creation fingerprint.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(512),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(100).optional(),
					collaborationToken: prefabReviewActor.collaborationToken,
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_review", args)
	);
	server.registerTool(
		"set_prefab_review",
		{
			title: "Set Prefab review",
			description:
				"After confirm=true, atomically create or update one Prefab review under its exact metadata fingerprint. Replaces title/owner/reviewer identities and can save a draft, close it, or open a new review round bound to expectedPrefabRevision. Review metadata is stored under .babylon-editor and never changes the .prefab runtime asset. Owners/admins control existing requests; collaboration identities are authoritative when enforcement is enabled.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(512),
					expectedReviewFingerprint: exactRevision,
					expectedPrefabRevision: exactRevision.optional().describe("Required for requestReview; must equal the exact current resolved Prefab revision."),
					title: z.string().min(1).max(256),
					ownerId: z
						.string()
						.min(1)
						.max(128)
						.regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/)
						.optional(),
					reviewers: z.array(prefabReviewIdentity).max(50),
					action: z.enum(["saveDraft", "requestReview", "close"]),
					...prefabReviewActor,
					confirm: z.literal(true),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.action === "requestReview" && value.expectedPrefabRevision === undefined) {
						context.addIssue({ code: "custom", message: "expectedPrefabRevision is required for requestReview." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_review", args)
	);
	server.registerTool(
		"add_prefab_review_comment",
		{
			title: "Add Prefab review comment",
			description:
				"After confirm=true, append one stable author comment under the exact current review fingerprint and exact current resolved Prefab revision. The comment records its request round and revision as immutable review evidence; it never changes the Prefab asset.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(512),
					expectedReviewFingerprint: exactRevision,
					expectedPrefabRevision: exactRevision,
					body: z.string().min(1).max(10_000),
					...prefabReviewActor,
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("add_prefab_review_comment", args)
	);
	server.registerTool(
		"submit_prefab_review_decision",
		{
			title: "Submit Prefab review decision",
			description:
				"After confirm=true, append approve, requestChanges, or dismiss evidence for the current assigned reviewer. Requires the exact review fingerprint and a Prefab revision equal to both the active request and current recursively resolved asset; stale requests cannot be approved and must be reopened by the owner. No runtime asset is changed.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(512),
					expectedReviewFingerprint: exactRevision,
					expectedPrefabRevision: exactRevision,
					decision: z.enum(["approve", "requestChanges", "dismiss"]),
					body: z.string().max(10_000).optional(),
					...prefabReviewActor,
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("submit_prefab_review_decision", args)
	);
	server.registerTool(
		"inspect_prefab_variant_rebase",
		{
			title: "Inspect prefab variant rebase",
			description:
				"Resolve a prefab recursively from its current base chain without writing files. Returns exact base/resolved SHA-256 revisions, stale state, inheritance chain, node count, and missing/ambiguous override conflicts. Normal prefabs report variant=false.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_variant_rebase", args)
	);
	const prefabConflictLiveTarget = {
		nodeId: z.string().min(1).optional().describe("Exact live instance node id; supply nodeId or nodeName only when a live comparison is required."),
		nodeName: z.string().min(1).max(256).optional().describe("Unique live instance node name; prefer nodeId when names may be ambiguous."),
		targetIndex: z.number().int().min(0).max(16).optional().describe("Exact repeated boundary index returned by inspect_prefab_instance_links."),
	};
	const inspectPrefabVariantConflictsSchema = z
		.object({
			path: z.string().min(1).max(512).describe("Project-contained prefab variant path."),
			...prefabConflictLiveTarget,
			offset: z.number().int().min(0).max(10_000).optional(),
			limit: z.number().int().min(1).max(500).optional(),
		})
		.strict()
		.superRefine((value, context) => {
			const selectors = Number(value.nodeId !== undefined) + Number(value.nodeName !== undefined);
			if (selectors > 1) {
				context.addIssue({ code: "custom", message: "Supply at most one of nodeId or nodeName." });
			}
			if (value.targetIndex !== undefined && selectors !== 1) {
				context.addIssue({ code: "custom", message: "targetIndex requires nodeId or nodeName." });
			}
		});
	server.registerTool(
		"inspect_prefab_variant_conflicts",
		{
			title: "Inspect prefab variant conflicts",
			description:
				"Build a bounded visual-merge plan for one prefab variant without writing. Each stable conflict row identifies its exact authored override and owner, compares current base, authored variant, dynamically resolved, and optional live-instance values, lists only safe base/variant/retarget choices, and returns exact variant/base/live leases plus unique retarget candidates. Inspect every page under the same leases before resolving.",
			inputSchema: inspectPrefabVariantConflictsSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_variant_conflicts", args)
	);
	const prefabConflictResolution = z
		.object({
			conflictId: z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.describe("Exact conflict id returned by inspection."),
			choice: z.enum(["base", "variant", "retarget"]).describe("Accept current base, preserve the variant where explicitly supported, or retarget the authored override."),
			targetNodeName: z.string().min(1).max(256).optional().describe("Unique current-base stable node, or a new stable identity for a conflicting structural addition."),
			targetParentNodeName: z.string().min(1).max(256).nullable().optional().describe("Unique current-base parent; null means the prefab root."),
			targetPropertyPath: propertyPath.optional().describe("Existing safe serialized property on the retargeted node."),
			targetCloneSourceNodeName: z.string().min(1).max(256).optional().describe("Unique current-base mesh source for a retargeted clone-mesh addition."),
		})
		.strict();
	const resolvePrefabVariantConflictsSchema = z
		.object({
			path: z.string().min(1).max(512),
			expectedRevision: exactRevision,
			expectedBaseRevision: exactRevision,
			...prefabConflictLiveTarget,
			expectedLiveFingerprint: exactOverrideFingerprint.optional().describe("Required when nodeId or nodeName supplies a live comparison."),
			resolutions: z
				.array(prefabConflictResolution)
				.min(1)
				.max(512)
				.refine((values) => new Set(values.map((value) => value.conflictId)).size === values.length, { message: "resolutions must not repeat a conflictId." }),
			confirm: z.literal(true),
		})
		.strict()
		.superRefine((value, context) => {
			const selectors = Number(value.nodeId !== undefined) + Number(value.nodeName !== undefined);
			if (selectors > 1) {
				context.addIssue({ code: "custom", message: "Supply at most one of nodeId or nodeName." });
			}
			if (value.targetIndex !== undefined && selectors !== 1) {
				context.addIssue({ code: "custom", message: "targetIndex requires nodeId or nodeName." });
			}
			if ((selectors === 1) !== (value.expectedLiveFingerprint !== undefined)) {
				context.addIssue({ code: "custom", message: "A live selector and expectedLiveFingerprint must be supplied together." });
			}
		});
	server.registerTool(
		"resolve_prefab_variant_conflicts",
		{
			title: "Resolve prefab variant conflicts",
			description:
				"After confirm=true, atomically apply exactly one explicit choice for every current conflict authored by one prefab variant. Exact variant/base leases are mandatory, and a compared live instance also requires its exact fingerprint. Inherited conflicts must be repaired at their owning variant. Base removes the failing override; variant is accepted only for lossless component/redundant-removal conversions; retarget requires explicit unique stable identities and never guesses ambiguous nodes. Partial, stale, unsafe, or still-conflicted plans write nothing.",
			inputSchema: resolvePrefabVariantConflictsSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("resolve_prefab_variant_conflicts", args)
	);
	server.registerTool(
		"rebase_prefab_variant",
		{
			title: "Rebase prefab variant",
			description:
				"After confirm=true, persist a dynamically resolved prefab variant against its current recursive base only when expectedBaseRevision exactly matches fresh inspection. Missing/ambiguous override targets block the write; source assets are never overwritten indirectly.",
			inputSchema: z.object({ path: z.string().min(1).max(512), expectedBaseRevision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("rebase_prefab_variant", args)
	);
	server.registerTool(
		"set_prefab_variant_overrides",
		{
			title: "Set prefab variant overrides",
			description:
				"After confirm=true, replace the complete root, stable-source-node, arbitrary property, and optional structural override set of a prefab variant under an exact resolved-revision lease. Use this to repair conflicts after a base change. Every target must exist uniquely in the current recursively resolved base before the variant is rewritten.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				rootOverrides: prefabProperties.optional(),
				nodeOverrides: z
					.array(z.object({ nodeName: z.string().min(1).max(256), properties: nonEmptyPrefabProperties }))
					.max(512)
					.optional(),
				propertyOverrides: propertyOverrides.optional(),
				structuralOverrides: structuralOverrides.optional(),
				componentOverrides: componentOverrides.optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_variant_overrides", args)
	);
	server.registerTool(
		"inspect_prefab_variant_structure",
		{
			title: "Inspect prefab variant structure",
			description:
				"Resolve a prefab's stable-source hierarchy without writing. Returns node/display/parent/kind/origin records, the complete current add/remove/reparent override set, conflicts, inheritance chain, and the exact revision required for structural mutation.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_variant_structure", args)
	);
	server.registerTool(
		"set_prefab_variant_structure",
		{
			title: "Set prefab variant structure",
			description:
				"After confirm=true, replace a variant's complete bounded subtree-removal, empty-transform/mesh-clone addition, and reparent set under an exact resolved-revision lease. Root removal, duplicate identities, missing/ambiguous nodes or parents, invalid clone sources, and cycles are rejected atomically; property overrides are preserved.",
			inputSchema: z.object({ path: z.string().min(1).max(512), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), structuralOverrides, confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_variant_structure", args)
	);
	server.registerTool(
		"inspect_prefab_variant_components",
		{
			title: "Inspect prefab variant components",
			description:
				"Resolve a prefab without writing and return bounded per-node serialized metadata-component key/type/size inventories, current add/remove overrides, conflicts, and the exact revision required for mutation. Component values remain available through get_prefab.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_variant_components", args)
	);
	server.registerTool(
		"set_prefab_variant_components",
		{
			title: "Set prefab variant components",
			description:
				"After confirm=true, replace a variant's complete serialized metadata-component add/remove set under an exact resolved-revision lease. Adds require an absent key, removals require an inherited key, identities are protected, JSON is bounded to 64 KiB, and scripts/physicsAggregate values receive stricter runtime-shape validation.",
			inputSchema: z.object({ path: z.string().min(1).max(512), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), componentOverrides, confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_variant_components", args)
	);
	server.registerTool(
		"set_prefab_asset_node_properties",
		{
			title: "Set prefab asset node properties",
			description:
				"After confirm=true, update one stable source node's name/transform/visibility in a prefab asset. An optional exact resolved revision prevents stale Prefab Mode writes. Variant edits are stored as overrides so future base rebases preserve them; unresolved variant conflicts block editing.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				sourceNodeName: z.string().min(1).max(256),
				properties: nonEmptyPrefabProperties,
				expectedRevision: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_asset_node_properties", args)
	);
	server.registerTool(
		"set_prefab_asset_nodes_properties",
		{
			title: "Save Prefab Stage node properties",
			description:
				"After confirm=true, atomically update from one through 256 stable source nodes in one prefab asset under one exact resolved revision. This is the shared manual/Auto Save path used by Prefab Stage; variant edits remain explicit overrides and unresolved conflicts block the complete batch.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(512),
					expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
					changes: z
						.array(z.object({ sourceNodeName: z.string().min(1).max(256), properties: nonEmptyPrefabProperties }).strict())
						.min(1)
						.max(256)
						.refine((values) => new Set(values.map((value) => value.sourceNodeName)).size === values.length, { message: "changes must not repeat sourceNodeName." }),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_asset_nodes_properties", args)
	);
	server.registerTool(
		"get_prefab_stage_settings",
		{
			title: "Get Prefab Stage settings",
			description:
				"Read the complete project-persisted Prefab Stage mode, locked-context appearance, override visualization, Auto Save, environment, color, and lighting settings plus their exact SHA-256 mutation lease.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_prefab_stage_settings", {})
	);
	server.registerTool(
		"set_prefab_stage_settings",
		{
			title: "Set Prefab Stage settings",
			description:
				"Replace the complete version-1 Prefab Stage settings document under the exact fingerprint returned by get_prefab_stage_settings and persist it in the open project.",
			inputSchema: z.object({ expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), settings: prefabStageSettings }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_stage_settings", args)
	);
	server.registerTool(
		"open_prefab_stage",
		{
			title: "Open Prefab Stage",
			description:
				"Open the shared visual Prefab Stage for one contained .prefab asset. Supply a live prefab node and exact targetIndex to edit that source boundary in locked scene context; otherwise the asset opens in isolation.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(512),
					nodeId: z.string().min(1).optional(),
					nodeName: z.string().min(1).max(256).optional(),
					targetIndex: z.number().int().min(0).max(32).optional(),
					mode: z.enum(["isolation", "context"]).optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.nodeId && value.nodeName) {
						context.addIssue({ code: "custom", path: ["nodeName"], message: "Provide nodeId or nodeName, not both." });
					}
					if (value.targetIndex !== undefined && !value.nodeId && !value.nodeName) {
						context.addIssue({ code: "custom", path: ["targetIndex"], message: "targetIndex requires nodeId or nodeName." });
					}
					if (value.mode === "context" && !value.nodeId && !value.nodeName) {
						context.addIssue({ code: "custom", path: ["mode"], message: "Context mode requires nodeId or nodeName." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_prefab_stage", args)
	);
	server.registerTool(
		"inspect_prefab_asset_node_property",
		{
			title: "Inspect prefab asset node property",
			description:
				"Read one existing arbitrary serialized property on a stable prefab source node. Returns its bounded JSON value, whether the path is a variant override, conflicts, and the exact revision lease required for a write.",
			inputSchema: z.object({ path: z.string().min(1).max(512), sourceNodeName: z.string().min(1).max(256), propertyPath }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_asset_node_property", args)
	);
	server.registerTool(
		"set_prefab_asset_node_property",
		{
			title: "Set prefab asset node property",
			description:
				"After confirm=true, update one existing arbitrary serialized node property under the exact revision returned by inspection. Prototype, identity, hierarchy and standard transform/name paths are blocked. Variant writes persist as path overrides and survive rebases.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				sourceNodeName: z.string().min(1).max(256),
				propertyPath,
				value: propertyValue,
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_asset_node_property", args)
	);
	server.registerTool(
		"inspect_prefab_instance_links",
		{
			title: "Inspect prefab instance source links",
			description:
				"Inspect one live instantiated prefab mesh and return its ordered outer-to-inner source-asset boundary links, stable source-node identity at each boundary, exact resolved SHA-256 revision, variant/stale/conflict state, live transform/visibility, and public serialized component keys. Use a returned targetPath and revision for boundary Apply/Revert or unpack.",
			inputSchema: z.object({ nodeId: z.string().min(1).optional(), nodeName: z.string().min(1).max(256).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_instance_links", args)
	);
	server.registerTool(
		"inspect_prefab_instance_overrides",
		{
			title: "Inspect prefab instance overrides",
			description:
				"Compare one complete live prefab instance with an exact outer or nested source boundary. Returns grouped transform/visibility, serialized component, and hierarchy-structure differences; current/source values; conflicts and blockers; exact revision/fingerprint leases; stable pagination; and mutation-safe entry ids. Inspect every page under the same leases before Apply or Revert.",
			inputSchema: requirePrefabInstanceTarget({
				query: z.string().max(256).optional().describe("Optional case-insensitive node, property, component, kind, or label search."),
				categories: z
					.array(z.enum(["transform", "component", "structure"]))
					.max(3)
					.refine((values) => new Set(values).size === values.length, { message: "categories must not contain duplicates." })
					.optional(),
				offset: z.number().int().min(0).optional().describe("Filtered result offset. Defaults to 0."),
				limit: z.number().int().min(1).max(500).optional().describe("Maximum rows for this page. Defaults to 100."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_instance_overrides", args)
	);
	server.registerTool(
		"apply_prefab_instance_overrides",
		{
			title: "Apply selected prefab instance overrides",
			description:
				"After confirm=true, atomically write selected live transform/visibility and serialized component differences into one exact source boundary, plus an optional complete dependency-safe hierarchy batch for prefab variants. Revalidates the exact source revision and complete live fingerprint before writing; repeated nested paths require targetIndex.",
			inputSchema: requirePrefabInstanceTarget({
				expectedRevision: exactRevision,
				expectedFingerprint: exactOverrideFingerprint,
				entryIds: overrideEntryIds,
				confirm: z.literal(true),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_prefab_instance_overrides", args)
	);
	server.registerTool(
		"revert_prefab_instance_overrides",
		{
			title: "Revert selected prefab instance overrides",
			description:
				"After confirm=true, atomically replace selected live transform/visibility, serialized component, and complete hierarchy differences from one exact source boundary without writing the asset. Revalidates the exact source revision and complete live fingerprint before mutating the scene; repeated nested paths require targetIndex.",
			inputSchema: requirePrefabInstanceTarget({
				expectedRevision: exactRevision,
				expectedFingerprint: exactOverrideFingerprint,
				entryIds: overrideEntryIds,
				confirm: z.literal(true),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_prefab_instance_overrides", args)
	);
	server.registerTool(
		"inspect_prefab_instances_overrides",
		{
			title: "Inspect overrides across prefab instances",
			description:
				"Compare multiple exact live prefab boundaries under one deterministic batch lease. Select explicit targets, every boundary for one prefab path, or every outer scene instance. Returns exact per-target revision/fingerprint leases, grouped counts, and a flattened stable page of up to 8192 aggregate rows. Read every page under the same batchFingerprint before mutation.",
			inputSchema: requireOneBulkPrefabSelector({
				query: z.string().max(256).optional().describe("Optional case-insensitive instance, path, node, component, kind, or label search."),
				categories: z
					.array(z.enum(["transform", "component", "structure"]))
					.max(3)
					.refine((values) => new Set(values).size === values.length, { message: "categories must not contain duplicates." })
					.optional(),
				offset: z.number().int().min(0).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_instances_overrides", args)
	);
	server.registerTool(
		"apply_prefab_instances_overrides",
		{
			title: "Apply overrides across prefab instances",
			description:
				"After confirm=true, apply exact selected rows across up to 64 inspected live boundaries. atomic mode publishes distinct dependency-independent source assets as one rollback-safe transaction and rejects duplicate/dependent sources. bestEffort mode keeps successful targets and returns explicit per-target errors. Reinspect after any stale lease or partial result.",
			inputSchema: z
				.object({
					expectedBatchFingerprint: exactBulkOverrideFingerprint,
					operations: bulkPrefabOperations,
					mode: z.enum(["atomic", "bestEffort"]),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_prefab_instances_overrides", args)
	);
	server.registerTool(
		"revert_prefab_instances_overrides",
		{
			title: "Revert overrides across prefab instances",
			description:
				"After confirm=true, revert exact selected rows across up to 64 inspected live boundaries. atomic mode is rollback-safe for transform/visibility and component rows and rejects structural rows or duplicate live properties. Choose bestEffort to explicitly permit independent per-target structural results. Reinspect after any stale lease or partial result.",
			inputSchema: z
				.object({
					expectedBatchFingerprint: exactBulkOverrideFingerprint,
					operations: bulkPrefabOperations,
					mode: z.enum(["atomic", "bestEffort"]),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_prefab_instances_overrides", args)
	);
	server.registerTool(
		"open_prefab_bulk_overrides",
		{
			title: "Open multi-instance Prefab Overrides",
			description:
				"Validate a bounded explicit, path-wide, or scene-wide prefab selection and open the editor's shared multi-instance Overrides window with atomic/best-effort controls. This changes editor presentation only and does not mutate scene or asset data.",
			inputSchema: requireOneBulkPrefabSelector({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_prefab_bulk_overrides", args)
	);
	server.registerTool(
		"inspect_prefab_instance_structure",
		{
			title: "Inspect live prefab instance structure",
			description:
				"Automatically compare one live prefab instance hierarchy with an exact outer or nested source boundary without changing either. Returns detected additions, removals, reparents, transform differences, unsupported-change blockers, a deterministic comparison signature, and the complete proposed structural override set for capture.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional().describe("Optional exact boundary path returned by inspect_prefab_instance_links; outermost by default."),
				targetIndex: z.number().int().min(0).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_instance_structure", args)
	);
	server.registerTool(
		"capture_prefab_instance_structure",
		{
			title: "Capture live prefab instance structure",
			description:
				"After confirm=true, capture automatically detected live additions, removals, and reparents into one instantiated prefab variant under the exact revision returned by inspect_prefab_instance_structure. New mesh geometry is serialized with bounded resource limits, and separately instantiated nested prefabs retain ordered outer-to-inner source links. Stale instances, unsafe or oversized payloads, source conflicts, and base-prefab targets block before writing.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional(),
				targetIndex: z.number().int().min(0).optional(),
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_prefab_instance_structure", args)
	);
	server.registerTool(
		"compare_prefab_instances",
		{
			title: "Compare prefab instances",
			description:
				"Search and compare up to 200 live outer instances of one prefab asset. Returns per-instance structural/transform/blocker counts, deterministic signatures, and signature groups so matching and divergent override sets can be found without modifying the scene.",
			inputSchema: z.object({
				path: z.string().min(1).max(512).describe("Project-relative outer prefab asset path."),
				query: z.string().max(256).optional().describe("Optional case-insensitive root name, node id, or instance id filter."),
				limit: z.number().int().min(1).max(200).optional().describe("Maximum live instances. Defaults to 50."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("compare_prefab_instances", args)
	);
	server.registerTool(
		"apply_prefab_instance_boundary",
		{
			title: "Apply prefab instance values to a source boundary",
			description:
				"After confirm=true, apply selected live transform/visibility and bounded serialized metadata-component set/remove changes to one exact outer or nested source asset boundary. targetPath and expectedRevision must come from inspect_prefab_instance_links; variants retain changes as overrides while base assets are updated directly.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional(),
				targetIndex: z.number().int().min(0).optional(),
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				transformVisibility: z.boolean().default(true),
				componentChanges: z
					.array(
						z.discriminatedUnion("action", [
							z.object({ action: z.literal("set"), componentKey, value: propertyValue }),
							z.object({ action: z.literal("remove"), componentKey }),
						])
					)
					.max(64)
					.optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_prefab_instance_boundary", args)
	);
	server.registerTool(
		"revert_prefab_instance_boundary",
		{
			title: "Revert prefab instance values from a source boundary",
			description:
				"After confirm=true, replace selected live transform/visibility and component values from one exact outer or nested source asset boundary without modifying any asset. Missing selected components are removed from the live node. targetPath and expectedRevision must come from inspect_prefab_instance_links.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional(),
				targetIndex: z.number().int().min(0).optional(),
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				transformVisibility: z.boolean().default(true),
				componentKeys: z.array(componentKey).max(64).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_prefab_instance_boundary", args)
	);
	server.registerTool(
		"unpack_prefab_instance",
		{
			title: "Unpack prefab instance",
			description:
				"After confirm=true, detach the selected live prefab subtree. outermost removes the selected source boundary while preserving deeper nested-prefab links; completely removes every prefab link in the subtree. Scene objects and hierarchy remain in place and source assets are never modified.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional(),
				targetIndex: z.number().int().min(0).optional(),
				mode: z.enum(["outermost", "completely"]),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("unpack_prefab_instance", args)
	);
	server.registerTool(
		"promote_prefab_instance_boundary_overrides",
		{
			title: "Promote nested prefab boundary overrides",
			description:
				"After confirm=true, move selected transform, arbitrary-property, serialized-component, and/or descendant structural overrides from the containing prefab variant into one nested source asset boundary. Stable identities are translated into the target asset, both exact revisions are required, promoted copies are removed from the container, and the target file is restored if the containing write fails.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512),
				targetIndex: z.number().int().min(0).optional(),
				expectedContainerRevision: z.string().regex(/^[a-f0-9]{64}$/),
				expectedTargetRevision: z.string().regex(/^[a-f0-9]{64}$/),
				categories: z
					.array(z.enum(["transforms", "properties", "components", "structure"]))
					.min(1)
					.max(4),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("promote_prefab_instance_boundary_overrides", args)
	);
	server.registerTool(
		"apply_prefab_instance_root",
		{
			title: "Apply prefab instance root",
			description: "Apply a prefab instance root's transform and visibility into its linked prefab (or variant) asset.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_prefab_instance_root", args)
	);
	server.registerTool(
		"revert_prefab_instance_root",
		{
			title: "Revert prefab instance root",
			description: "Restore a prefab instance root's transform and visibility from its linked prefab asset.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_prefab_instance_root", args)
	);
	server.registerTool(
		"apply_prefab_instance_node",
		{
			title: "Apply prefab instance node",
			description: "Apply a nested prefab mesh node's transform and visibility into its linked prefab asset.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_prefab_instance_node", args)
	);
	server.registerTool(
		"revert_prefab_instance_node",
		{
			title: "Revert prefab instance node",
			description: "Restore a nested prefab mesh node's transform and visibility from its linked prefab asset.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_prefab_instance_node", args)
	);
	server.registerTool(
		"instantiate_prefab",
		{
			title: "Instantiate prefab",
			description: "Load a persisted prefab mesh hierarchy into the active scene and mark the created nodes with prefab instance metadata.",
			inputSchema: z.object({ path: z.string(), name: z.string().optional(), position: z.array(z.number()).length(3).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_prefab", args)
	);
}
