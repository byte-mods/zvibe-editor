import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

export function registerProjectTools(server: McpServer): void {
	const collaborationVector3 = z.tuple([
		z.number().finite().min(-1_000_000_000).max(1_000_000_000),
		z.number().finite().min(-1_000_000_000).max(1_000_000_000),
		z.number().finite().min(-1_000_000_000).max(1_000_000_000),
	]);
	const collaborationPointer = z.object({
		id: z.string().min(1).max(128).optional(),
		viewport: z.string().min(1).max(128).optional(),
		x: z.number().finite().min(0).max(1),
		y: z.number().finite().min(0).max(1),
		pointerType: z.enum(["mouse", "pen", "touch", "xr"]).optional(),
		buttons: z.number().int().min(0).max(31).optional(),
		pressure: z.number().finite().min(0).max(1).optional(),
		worldRay: z.object({ origin: collaborationVector3, direction: collaborationVector3, length: z.number().finite().positive().max(1_000_000_000).optional() }).optional(),
		worldPosition: collaborationVector3.optional(),
	});
	const collaborationCamera = z.object({
		viewport: z.string().min(1).max(128).optional(),
		position: collaborationVector3,
		target: collaborationVector3,
		up: collaborationVector3.optional(),
		fovDegrees: z.number().finite().min(1).max(179).optional(),
		orthographicSize: z.number().finite().positive().max(1_000_000_000).optional(),
	});
	const richPresenceShape = {
		selectionNodeIds: z.array(z.string().min(1).max(128)).max(64).optional(),
		primarySelectionNodeId: z.string().min(1).max(128).nullable().optional(),
		hoveredNodeId: z.string().min(1).max(128).nullable().optional(),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
			.optional(),
		toolMode: z.enum(["select", "move", "rotate", "scale", "rect", "paint", "terrain", "animate", "play", "navigate", "custom"]).optional(),
		pointers: z.array(collaborationPointer).max(8).optional(),
		camera: collaborationCamera.nullable().optional(),
		cursor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), viewport: z.string().min(1).max(128).optional() }).optional(),
	};
	const collaborativeTextOperation = z.discriminatedUnion("type", [
		z.object({ type: z.literal("insert"), afterId: z.string().max(256).nullable(), text: z.string().min(1).max(65536) }),
		z.object({ type: z.literal("delete"), ids: z.array(z.string().min(1).max(256)).min(1).max(10000) }),
	]);
	const collaborativeListOperation = z.discriminatedUnion("type", [
		z.object({ type: z.literal("insert"), afterId: z.string().max(256).nullable(), value: z.json() }),
		z.object({ type: z.literal("update"), id: z.string().min(1).max(256), value: z.json() }),
		z.object({ type: z.literal("move"), id: z.string().min(1).max(256), afterId: z.string().max(256).nullable() }),
		z.object({ type: z.literal("delete"), id: z.string().min(1).max(256) }),
	]);
	const semanticMergeChoiceSchema = z.enum(["ours", "theirs", "base", "delete", "custom"]);
	const semanticMergeResolutionSchema = z
		.object({
			file: z.string().min(1).max(512).describe("Exact scene-manifest JSON path, or prefab.json for a prefab conflict."),
			path: z.string().startsWith("/").max(512).describe("Exact semantic conflict path returned by a merge preview."),
			choice: semanticMergeChoiceSchema,
			customValue: z.json().optional().describe("Bounded JSON value required only when choice is custom."),
		})
		.refine((value) => value.choice !== "custom" || value.customValue !== undefined, { message: "customValue is required when choice is custom." });
	const semanticGitConflictOptionsShape = {
		path: z.string().min(1).max(512).describe("Exact currently unmerged .prefab path or JSON manifest path inside a persisted .scene directory."),
		resolution: z.enum(["manual", "ours", "theirs"]).optional().describe("Global semantic conflict policy; defaults to manual."),
		maximumConflicts: z.number().int().min(1).max(5000).optional().describe("Maximum detailed semantic conflicts returned; defaults to 500."),
		numericTolerance: z.number().min(0).max(1).optional().describe("Absolute tolerance for numeric leaf equality; defaults to exact comparison."),
		ignorePaths: z.array(z.string().startsWith("/").max(512)).max(64).optional().describe("Semantic path prefixes kept from ours and excluded from merging."),
		conflictResolutions: z.array(semanticMergeResolutionSchema).max(500).optional().describe("Exact per-property choices from a semantic Git conflict preview."),
		ruleIds: z.array(z.string().uuid()).max(100).optional().describe("Ordered persistent semantic merge-rule ids applied after exact overrides."),
	};
	server.registerTool(
		"get_collaborative_ordered_collection",
		{
			title: "Get collaborative ordered collection",
			description:
				"Open/read a named stable-ID ordered JSON collection materialized in scene metadata. Returns paginated visible item IDs/values, revision, tombstones, source hashes, and divergence state. IDs are anchors/targets for conflict-free insert, update, move, and delete operations.",
			inputSchema: z.object({ name: z.string().min(1).max(128), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_collaborative_ordered_collection", args)
	);

	server.registerTool(
		"apply_collaborative_ordered_collection_operations",
		{
			title: "Apply collaborative ordered-collection operations",
			description:
				"Apply deterministic stable-ID insert/update/move/delete operations to a scene collection. Concurrent inserts share anchors and converge by ID; updates/moves use operation clocks; deletes tombstone stable IDs. Authenticated actor identity is automatic, operationId makes retries safe, and external materialized edits return externalConflict.",
			inputSchema: z.object({
				name: z.string().min(1).max(128),
				actorId: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
					.optional(),
				operationId: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
				operations: z.array(collaborativeListOperation).min(1).max(128),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_collaborative_ordered_collection_operations", args)
	);

	server.registerTool(
		"rebase_collaborative_ordered_collection",
		{
			title: "Rebase collaborative ordered collection",
			description:
				"Import the current externally edited scene-metadata array as a fresh stable-ID baseline. Requires its exact SHA-256 and invalidates prior item IDs/history without changing visible values.",
			inputSchema: z.object({ name: z.string().min(1).max(128), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/) }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("rebase_collaborative_ordered_collection", args)
	);

	server.registerTool(
		"get_collaborative_text_document",
		{
			title: "Get collaborative text document",
			description:
				"Open or read a project-contained script, shader, JSON, markup, style, Markdown, or text file as a bounded RGA character document. Returns visible character IDs/text with pagination, revision, tombstone count, hashes, and external-file divergence state. Use item IDs as insert anchors or delete targets.",
			inputSchema: z.object({ path: z.string().min(1).max(512), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(5000).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_collaborative_text_document", args)
	);

	server.registerTool(
		"apply_collaborative_text_operations",
		{
			title: "Apply collaborative text operations",
			description:
				"Apply 1-128 deterministic RGA insert/delete operations to a project text file. Concurrent inserts at the same stable afterId merge by item ID; deletes create tombstones. Authenticated sessions derive actor identity automatically; otherwise actorId is required. operationId makes retries safe. External file changes return status=externalConflict and require an explicit hash-guarded rebase.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				actorId: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
					.optional(),
				operationId: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
				operations: z.array(collaborativeTextOperation).min(1).max(128),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_collaborative_text_operations", args)
	);

	server.registerTool(
		"rebase_collaborative_text_document",
		{
			title: "Rebase collaborative text document",
			description:
				"Explicitly import the current externally edited project file into a fresh RGA baseline after divergence. expectedSourceHash must match the current file, preventing a stale reset. Existing CRDT item IDs/tombstones/operation history are replaced, while file content is unchanged.",
			inputSchema: z.object({ path: z.string().min(1).max(512), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/) }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("rebase_collaborative_text_document", args)
	);

	server.registerTool(
		"get_project_source_control_status",
		{
			title: "Get project source-control status",
			description: "Read the active project's Git branch and porcelain worktree status without changing files, staging, or committing.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_source_control_status", {})
	);
	server.registerTool(
		"get_project_source_control_workspace",
		{
			title: "Get project source-control workspace",
			description:
				"Read the portable Git equivalent of Unity 6.5's Version Control workspace: filtered Pending and Incoming Changes with precise empty states, a bounded branch/changeset graph, retained Git-stash shelvesets, exact workspace fingerprint, refs, and persisted splitter layout. Never fetches or contacts a remote.",
			inputSchema: z
				.object({
					pendingFilter: z.string().max(128).optional(),
					incomingFilter: z.string().max(128).optional(),
					branchFilter: z.string().max(128).optional(),
					limit: z.number().int().min(1).max(200).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_source_control_workspace", args)
	);
	server.registerTool(
		"get_project_source_control_workspace_layout",
		{
			title: "Get source-control workspace layout",
			description:
				"Read the persistent branch explorer, changes, and properties splitter percentages plus active panel and exact layout revision for the current repository.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_source_control_workspace_layout", {})
	);
	server.registerTool(
		"set_project_source_control_workspace_layout",
		{
			title: "Set source-control workspace layout",
			description:
				"Persist exact source-control splitter positions and active panel across reloads/sessions. Requires the inspected layout revision, percentages from 15 to 70 that total exactly 100, and changes only renderer-local preferences—not project or Git files.",
			inputSchema: z
				.object({
					expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
					branchExplorerPercent: z.number().min(15).max(70),
					changesPercent: z.number().min(15).max(70),
					propertiesPercent: z.number().min(15).max(70),
					activePanel: z.enum(["pending", "incoming", "branches", "shelvesets"]),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_source_control_workspace_layout", args)
	);
	server.registerTool(
		"inspect_project_source_control_changeset",
		{
			title: "Inspect source-control changeset",
			description:
				"Read exact author/committer properties, parents, changed project paths, and a bounded first-parent unified diff for one exact 40-character commit hash. This is the changeset-by-changeset diff and properties panel contract and does not mutate Git state.",
			inputSchema: z.object({ hash: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_project_source_control_changeset", args)
	);
	server.registerTool(
		"inspect_project_source_control_shelveset",
		{
			title: "Inspect source-control shelveset",
			description:
				"Read properties, project-scoped paths, and a bounded diff for one exact currently retained Git-stash shelveset hash. The response states portable Git boundaries and never applies or drops the shelveset.",
			inputSchema: z.object({ shelvesetHash: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_project_source_control_shelveset", args)
	);
	server.registerTool(
		"apply_project_source_control_folder_action",
		{
			title: "Apply source-control folder action",
			description:
				"Apply Project-browser-style Add to Source Control or Undo Changes to one existing contained non-symlink folder. Both require the exact inspected workspace fingerprint; undo additionally requires confirm=true, collaboration admin, and restores tracked/index content from HEAD while preserving untracked files.",
			inputSchema: z
				.object({
					action: z.enum(["add", "undo"]),
					path: z.string().min(1).max(512),
					expectedWorkspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					confirm: z.boolean().optional(),
					collaborationToken: z.string().min(1).max(256).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_project_source_control_folder_action", args)
	);
	server.registerTool(
		"create_project_source_control_shelveset",
		{
			title: "Create source-control shelveset",
			description:
				"Create and retain a Git-stash shelveset snapshot of tracked pending changes while leaving the worktree and index unchanged. Requires root-owned project, admin, confirm=true, and an exact workspace fingerprint; untracked-only content is intentionally unsupported.",
			inputSchema: z
				.object({
					message: z.string().min(1).max(500),
					expectedWorkspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					confirm: z.literal(true),
					collaborationToken: z.string().min(1).max(256).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_project_source_control_shelveset", args)
	);
	server.registerTool(
		"apply_project_source_control_shelveset_paths",
		{
			title: "Partially apply source-control shelveset",
			description:
				"Apply 1–128 selected tracked paths from one exact retained Git shelveset into the worktree, retaining the shelveset and leaving results unstaged. Requires root ownership, admin, confirm=true, the exact workspace fingerprint, and collision-free selected paths.",
			inputSchema: z
				.object({
					shelvesetHash: z.string().regex(/^[a-f0-9]{40}$/),
					paths: z.array(z.string().min(1).max(512)).min(1).max(128),
					expectedWorkspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					confirm: z.literal(true),
					collaborationToken: z.string().min(1).max(256).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_project_source_control_shelveset_paths", args)
	);
	server.registerTool(
		"delete_project_source_control_shelveset",
		{
			title: "Delete source-control shelveset",
			description:
				"Drop one exact currently retained Git shelveset without touching the worktree or index. Requires root ownership, collaboration admin, and confirm=true; a stale or arbitrary commit hash is rejected.",
			inputSchema: z
				.object({
					shelvesetHash: z.string().regex(/^[a-f0-9]{40}$/),
					confirm: z.literal(true),
					collaborationToken: z.string().min(1).max(256).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_source_control_shelveset", args)
	);
	server.registerTool(
		"rename_project_source_control_ref",
		{
			title: "Rename source-control branch or label",
			description:
				"Rename one local branch or label (Git tag), powering the workspace F2 shortcut. Requires root ownership, collaboration admin, confirm=true, and the exact inspected ref object hash; existing targets and stale hashes are rejected, and tag object identity is preserved.",
			inputSchema: z
				.object({
					kind: z.enum(["branch", "label"]),
					name: z.string().min(1).max(255),
					newName: z.string().min(1).max(255),
					expectedHash: z.string().regex(/^[a-f0-9]{40}$/),
					confirm: z.literal(true),
					collaborationToken: z.string().min(1).max(256).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("rename_project_source_control_ref", args)
	);
	server.registerTool(
		"get_project_source_control_history",
		{
			title: "Get project source-control history",
			description: "Read up to 50 recent Git commits without changing files, staging, or committing.",
			inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_source_control_history", args)
	);
	server.registerTool(
		"get_project_source_control_diff",
		{
			title: "Get project source-control diff",
			description: "Read a bounded unified diff for one project-relative file without changing the worktree. Set staged to inspect the index diff.",
			inputSchema: z.object({ path: z.string().min(1), staged: z.boolean().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_source_control_diff", args)
	);
	server.registerTool(
		"stage_project_source_control_paths",
		{
			title: "Stage project source-control paths",
			description:
				"Stage additions, modifications, and deletions for 1–128 contained project-relative paths, or the complete active project with all=true. Paths reject traversal, .git metadata, controls, option prefixes, and Git pathspec magic. Collaboration viewers are denied; editors and admins may stage. Returns refreshed project-scoped status.",
			inputSchema: z.object({ paths: z.array(z.string().min(1).max(512)).min(1).max(128).optional(), all: z.boolean().optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("stage_project_source_control_paths", args)
	);
	server.registerTool(
		"unstage_project_source_control_paths",
		{
			title: "Unstage project source-control paths",
			description:
				"Remove 1–128 contained project-relative paths, or all active-project paths, from the Git index without changing working-tree files. Supports repositories with or without an initial commit. Collaboration viewers are denied; editors and admins may unstage. Returns refreshed project-scoped status.",
			inputSchema: z.object({ paths: z.array(z.string().min(1).max(512)).min(1).max(128).optional(), all: z.boolean().optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("unstage_project_source_control_paths", args)
	);
	server.registerTool(
		"commit_project_source_control",
		{
			title: "Commit project source-control changes",
			description:
				"Create one Git commit from the current index after confirm=true. Requires collaboration admin when enforcement is enabled, rejects an empty index and every staged path outside a nested active project, bounds the message to 5000 characters, optionally adds Signed-off-by, runs normal Git hooks, and returns the new commit plus refreshed status.",
			inputSchema: z.object({ message: z.string().min(1).max(5000), signoff: z.boolean().optional(), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("commit_project_source_control", args)
	);
	server.registerTool(
		"push_project_source_control",
		{
			title: "Push project source-control branch",
			description:
				"Push current HEAD without force to a validated named remote/branch after confirm=true. Requires collaboration admin, rejects embedded HTTP(S) remote credentials, disables terminal prompting, optionally sets upstream, bounds/redacts output, and never accepts force options. Uses configured branch remote or origin by default; credential helpers or SSH agents remain external.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
				branch: z.string().min(1).max(255).optional(),
				setUpstream: z.boolean().optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("push_project_source_control", args)
	);
	server.registerTool(
		"list_project_source_control_refs",
		{
			title: "List project source-control refs",
			description:
				"Read up to 500 local branches, 500 remote-tracking branches, and 500 tags plus the current branch, upstream, and ahead/behind counts. Returns per-category truncation flags and never contacts a remote or changes repository state.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_project_source_control_refs", {})
	);
	server.registerTool(
		"fetch_project_source_control",
		{
			title: "Fetch project source-control remote",
			description:
				"Fetch one validated configured remote after confirm=true, optionally pruning deleted remote-tracking refs and fetching tags. Requires collaboration admin, disables prompting, rejects embedded HTTP(S) credentials, never changes working-tree files, and returns bounded output plus refreshed refs.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
				prune: z.boolean().optional(),
				tags: z.boolean().optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("fetch_project_source_control", args)
	);
	server.registerTool(
		"pull_project_source_control",
		{
			title: "Fast-forward pull project source control",
			description:
				"Fetch and fast-forward-only pull a validated remote branch after confirm=true. Requires collaboration admin, the active project to own the Git worktree root, and the complete index/worktree including untracked files to be clean. Rejects embedded credentials and never creates merge commits or rebases.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
				branch: z.string().min(1).max(255).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("pull_project_source_control", args)
	);
	server.registerTool(
		"create_project_source_control_branch",
		{
			title: "Create project source-control branch",
			description:
				"Create one validated local branch at HEAD or a verified commit after confirm=true without switching branches or changing files. Requires collaboration admin and the active project directory to be the Git worktree root. Existing refs are never overwritten.",
			inputSchema: z.object({ name: z.string().min(1).max(255), startPoint: z.string().min(1).max(255).optional(), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_project_source_control_branch", args)
	);
	server.registerTool(
		"switch_project_source_control_branch",
		{
			title: "Switch project source-control branch",
			description:
				"Switch to an existing validated local branch after confirm=true. Requires collaboration admin, the active project to own the worktree root, and the complete index/worktree including untracked files to be clean. Detached checkout, implicit remote branch creation, and forced file replacement are not supported.",
			inputSchema: z.object({ name: z.string().min(1).max(255), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("switch_project_source_control_branch", args)
	);
	server.registerTool(
		"delete_project_source_control_branch",
		{
			title: "Delete project source-control branch",
			description:
				"Safely delete a validated non-current local branch after confirm=true. Requires collaboration admin and worktree-root ownership. Uses Git's fully-merged check and never force-deletes a branch or changes any remote ref.",
			inputSchema: z.object({ name: z.string().min(1).max(255), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_source_control_branch", args)
	);
	server.registerTool(
		"create_project_source_control_tag",
		{
			title: "Create project source-control tag",
			description:
				"Create a validated local lightweight tag, or an annotated tag when message is supplied, at HEAD or a verified commit after confirm=true. Requires collaboration admin and worktree-root ownership. Existing tags are never overwritten and no remote ref is changed.",
			inputSchema: z.object({
				name: z.string().min(1).max(255),
				startPoint: z.string().min(1).max(255).optional(),
				message: z.string().min(1).max(5000).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_project_source_control_tag", args)
	);
	server.registerTool(
		"delete_project_source_control_tag",
		{
			title: "Delete project source-control tag",
			description:
				"Delete one validated local tag after confirm=true. Requires collaboration admin and worktree-root ownership. The operation never deletes or updates a remote tag.",
			inputSchema: z.object({ name: z.string().min(1).max(255), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_source_control_tag", args)
	);
	server.registerTool(
		"preview_project_source_control_integration",
		{
			title: "Preview project source-control integration",
			description:
				"Resolve a target commit-ish and read its merge base, exact HEAD/target hashes, relationship (up-to-date, fast-forward, already merged, or diverged), current-only/target-only commit counts, and up to 500 affected active-project paths. Does not change refs, index, or files and reports whether the project owns the worktree root required for integration.",
			inputSchema: z.object({ target: z.string().min(1).max(255) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("preview_project_source_control_integration", args)
	);
	server.registerTool(
		"get_project_source_control_integration_state",
		{
			title: "Get project source-control integration state",
			description:
				"Read whether a merge, rebase, cherry-pick, or revert is active plus up to 500 unresolved paths and their Git stage mode/hash metadata. Returns project-scoped status and truncation without returning file contents or changing repository state.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_source_control_integration_state", {})
	);
	server.registerTool(
		"start_project_source_control_merge",
		{
			title: "Start project source-control merge",
			description:
				"After confirm=true, start a merge of a verified target hash with --no-commit --no-ff so even a clean result remains staged for review and explicit continuation. Requires collaboration admin, root-owned project, clean complete worktree/index, and no active integration. Returns preview, conflict state, and bounded output; never auto-commits or force-updates refs.",
			inputSchema: z.object({ target: z.string().min(1).max(255), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_project_source_control_merge", args)
	);
	server.registerTool(
		"start_project_source_control_rebase",
		{
			title: "Start project source-control rebase",
			description:
				"After confirm=true, non-interactively rebase the current named branch onto a verified target hash. Requires collaboration admin, root-owned project, clean complete worktree/index, and no active integration. May rewrite local commits and completes automatically when conflict-free or stops with recoverable conflict state; no autostash, force push, or remote operation occurs.",
			inputSchema: z.object({ target: z.string().min(1).max(255), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_project_source_control_rebase", args)
	);
	server.registerTool(
		"resolve_project_source_control_conflict",
		{
			title: "Resolve project source-control conflict",
			description:
				"After confirm=true, resolve one validated currently unmerged path during merge/rebase using Git's ours stage, theirs stage, deletion, or markResolved for content already edited externally. Requires collaboration admin and root ownership, stages the resolution, and returns remaining conflicts. During rebase, Git ours means the upstream/onto side and theirs means the commit being replayed.",
			inputSchema: z.object({ path: z.string().min(1).max(512), resolution: z.enum(["ours", "theirs", "delete", "markResolved"]), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("resolve_project_source_control_conflict", args)
	);
	server.registerTool(
		"inspect_project_source_control_semantic_conflict",
		{
			title: "Inspect project semantic Git conflict",
			description:
				"Read one active merge/rebase conflict directly from Git stage 1/2/3 blobs and run the bounded Babylon-aware three-way merge for a .prefab or JSON manifest inside a .scene directory. Returns exact stage fingerprint/output hash, stable-identity automatic merges, explicit property conflicts, selected-rule evidence, and no merged file contents. Invalid JSON, binary/symlink modes, unsupported paths, and oversized blobs are refused without changing the worktree or index.",
			inputSchema: z.object(semanticGitConflictOptionsShape),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_project_source_control_semantic_conflict", args)
	);
	server.registerTool(
		"apply_project_source_control_semantic_conflict",
		{
			title: "Apply project semantic Git conflict",
			description:
				"After confirm=true, rerun the exact Babylon-aware Git-stage merge and atomically write/delete plus stage its fully resolved result. Requires collaboration admin, a root-owned active merge/rebase, exact conflict fingerprint and semantic output hash from inspection, and zero unresolved properties. Any stale stage, changed rule/resolution output, unsupported content, oversized rollback/output, or staging failure is rejected with the previous worktree content restored.",
			inputSchema: z.object({
				...semanticGitConflictOptionsShape,
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				expectedOutputHash: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_project_source_control_semantic_conflict", args)
	);
	server.registerTool(
		"continue_project_source_control_integration",
		{
			title: "Continue project source-control integration",
			description:
				"After confirm=true and zero unresolved paths, complete a pending merge with a required bounded message or non-interactively continue a rebase. Requires collaboration admin/root ownership. A multi-commit rebase may stop again and return new conflicts; hooks still run, no force push occurs, and bounded refreshed refs are returned only when complete.",
			inputSchema: z.object({ message: z.string().min(1).max(5000).optional(), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("continue_project_source_control_integration", args)
	);
	server.registerTool(
		"abort_project_source_control_integration",
		{
			title: "Abort project source-control integration",
			description:
				"After confirm=true, abort an active merge or rebase and ask Git to restore its pre-operation index/worktree state. Requires collaboration admin and root ownership. Does not handle unrelated cherry-pick/revert state, contact remotes, reset arbitrary commits, or perform force operations.",
			inputSchema: z.object({ confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("abort_project_source_control_integration", args)
	);
	server.registerTool(
		"inspect_project_source_control_remote_refs",
		{
			title: "Inspect project source-control remote refs",
			description:
				"Contact one validated configured remote and authoritatively list up to 500 branch heads and 500 tag refs with exact hashes, total counts, truncation, and its advertised default branch. Rejects embedded HTTP(S) credentials and never returns the remote URL, credentials, peeled duplicate tags, or changes local/remote state.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_project_source_control_remote_refs", args)
	);
	server.registerTool(
		"publish_project_source_control_remote_branch",
		{
			title: "Publish project source-control remote branch",
			description:
				"After confirm=true, publish one existing validated local branch to the same or another validated branch name on a configured remote. Requires collaboration admin, root ownership, and no active integration. Uses a fully qualified refspec without force, so it creates or fast-forwards but never overwrites non-fast-forward remote history; returns refreshed authoritative remote refs without URL/credentials.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
				localBranch: z.string().min(1).max(255),
				remoteBranch: z.string().min(1).max(255).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("publish_project_source_control_remote_branch", args)
	);
	server.registerTool(
		"delete_project_source_control_remote_branch",
		{
			title: "Delete project source-control remote branch",
			description:
				"After confirm=true, delete a validated non-default remote branch only when authoritative inspection still reports the caller's exact expectedHash. Requires collaboration admin/root ownership/no active integration, rejects the advertised default branch, and uses a ref-specific force-with-lease so stale or concurrent updates fail instead of being deleted. Returns refreshed remote refs without URL/credentials.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
				branch: z.string().min(1).max(255),
				expectedHash: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_source_control_remote_branch", args)
	);
	server.registerTool(
		"publish_project_source_control_remote_tag",
		{
			title: "Publish project source-control remote tag",
			description:
				"After confirm=true, publish one existing validated local lightweight or annotated tag to the same name on a configured remote. Requires collaboration admin, root ownership, and no active integration. Uses a fully qualified non-force refspec, never overwrites an existing remote tag, and returns refreshed authoritative refs without URL/credentials.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
				tag: z.string().min(1).max(255),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("publish_project_source_control_remote_tag", args)
	);
	server.registerTool(
		"delete_project_source_control_remote_tag",
		{
			title: "Delete project source-control remote tag",
			description:
				"After confirm=true, delete one validated remote tag only when authoritative inspection still reports the caller's exact expectedHash. Requires collaboration admin/root ownership/no active integration and uses a ref-specific force-with-lease so stale or concurrent tag changes fail instead of being deleted. Returns refreshed refs without URL/credentials.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
				tag: z.string().min(1).max(255),
				expectedHash: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_source_control_remote_tag", args)
	);
	server.registerTool(
		"inspect_project_source_control_conflict_details",
		{
			title: "Inspect project source-control conflict details",
			description:
				"For one validated currently unresolved merge/rebase path, return a SHA-256 conflict fingerprint plus bounded base(stage 1), ours(stage 2), theirs(stage 3), and current worktree details. Each present stage includes mode/hash/byte size and, only when at most 256 KiB valid UTF-8 without nulls, complete text; larger blobs are metadata-only and binary/invalid UTF-8 is flagged without corrupt decoding. Requires root ownership, returns no unrelated files, and documents whether custom text editing is safe.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_project_source_control_conflict_details", args)
	);
	server.registerTool(
		"apply_project_source_control_text_resolution",
		{
			title: "Apply project source-control text resolution",
			description:
				"After confirm=true, atomically replace one unresolved regular worktree file with up to 1 MiB custom UTF-8 text and stage it only when expectedFingerprint exactly matches current merge/rebase stage hashes. Requires collaboration admin/root ownership, rejects traversal/symlinks/nulls/binary or oversized stages/stale fingerprints, writes through a same-directory temporary file, and restores prior worktree bytes if Git staging fails. Returns remaining conflict state.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				content: z.string().max(1048576),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_project_source_control_text_resolution", args)
	);
	server.registerTool(
		"inspect_project_source_control_authentication",
		{
			title: "Inspect project source-control authentication",
			description:
				"Diagnose one configured Git remote's fetch and push authentication locally without contacting it or invoking credential fill, credential helpers, AskPass, SSH, or terminal prompts. Returns only remote name, URL counts, transport classes, embedded-credential presence, sanitized effective URL-matched helper classes/security/persistence/executable availability, username-presence/useHttpPath/interactive flags, SSH-agent and environment-provider booleans, readiness status, and actionable issue codes. Never returns URLs, hosts, usernames, helper commands/arguments, environment values, socket/key paths, tokens, passwords, or credential payloads.",
			inputSchema: z.object({
				remote: z
					.string()
					.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
					.optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_project_source_control_authentication", args)
	);
	server.registerTool(
		"inspect_project_source_control_image_conflict",
		{
			title: "Inspect project source-control image conflict",
			description:
				"For one validated active merge/rebase conflict, decode each present Base/Ours/Theirs stage only when it is a non-animated PNG, JPEG, or WebP of at most 8 MiB and 4,194,304 pixels. Returns the conflict fingerprint, bounded format/dimensions/RGBA hash/color/alpha statistics, optional deterministic PNG previews up to 128 pixels, and exact same-dimension pairwise changed-pixel ratio, RGBA MAE/RMSE, maximum delta, changed bounds, and optional heatmap. Missing, malformed, unsupported, animated, oversized, or dimension-mismatched stages remain explicit non-comparable metadata states. Never writes files, resolves/stages the conflict, or returns original full-size image bytes.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				includePreviews: z.boolean().optional().describe("Include bounded stage PNG previews and pairwise heatmaps; defaults to true."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_project_source_control_image_conflict", args)
	);
	server.registerTool(
		"get_project_source_control_review_provider",
		{
			title: "Get project source-control review provider",
			description:
				"Read the project-local GitHub/GitLab/Bitbucket Cloud/Azure DevOps hosted-review configuration, authentication mode, storage path, and whether its named token environment variable is populated. Returns the environment-variable name but never its value; makes no provider request.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_source_control_review_provider", {})
	);
	server.registerTool(
		"set_project_source_control_review_provider",
		{
			title: "Set project source-control review provider",
			description:
				"After confirm=true, atomically configure or disable project-local GitHub/GitLab/Bitbucket Cloud/Azure DevOps review integration. Azure repositories use organization/project/repository and support environment-only PAT Basic or Bearer authentication. Requires collaboration admin. Stores only credential-free settings and an environment-variable name in a contained non-symlink metadata file; credential contents are never accepted or persisted.",
			inputSchema: z.object({
				enabled: z.boolean(),
				provider: z.enum(["github", "gitlab", "bitbucket", "azure"]),
				authenticationMode: z.enum(["provider", "pat", "bearer"]).optional(),
				apiBaseUrl: z.string().min(1).max(2048).optional(),
				repository: z.string().min(1).max(512).optional(),
				tokenEnvironmentVariable: z
					.string()
					.regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
					.optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_source_control_review_provider", args)
	);
	server.registerTool(
		"list_project_source_control_reviews",
		{
			title: "List project source-control reviews",
			description:
				"List one bounded page of normalized GitHub, GitLab, Bitbucket Cloud, or Azure DevOps pull/merge requests using the configured environment credential. Returns number/title/state/draft/author/head/base/timestamps/safe web URL and pagination hint, with at most 50 entries and a 2-MiB response cap.",
			inputSchema: z.object({ state: z.enum(["open", "closed", "all"]).optional(), limit: z.number().int().min(1).max(50).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_source_control_reviews", args)
	);
	server.registerTool(
		"get_project_source_control_review",
		{
			title: "Get project source-control review",
			description:
				"Read one normalized GitHub, GitLab, Bitbucket Cloud, or Azure DevOps pull/merge request including bounded body text, exact head SHA for later leased merge, base SHA, mergeability, timestamps, and credential-free web URL. Uses the configured environment credential and caps provider responses at 2 MiB.",
			inputSchema: z.object({ number: z.number().int().min(1).max(2147483647) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_source_control_review", args)
	);
	server.registerTool(
		"create_project_source_control_review",
		{
			title: "Create project source-control review",
			description:
				"After confirm=true, create a GitHub, GitLab, Bitbucket Cloud, or Azure DevOps pull/merge request from validated head to base with bounded title/body and optional draft state. Requires collaboration admin and an environment-only provider credential; returns the normalized created review without credentials.",
			inputSchema: z.object({
				title: z.string().min(1).max(256),
				body: z.string().max(65536).optional(),
				head: z.string().min(1).max(255),
				base: z.string().min(1).max(255),
				draft: z.boolean().optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_project_source_control_review", args)
	);
	server.registerTool(
		"get_project_source_control_review_metadata",
		{
			title: "Get project source-control review metadata",
			description:
				"Inspect bounded requested reviewers, supported teams/labels, exact head SHA, and a SHA-256 state fingerprint for one GitHub, GitLab, Bitbucket Cloud, or Azure DevOps review. Bitbucket returns immutable reviewer {UUID} identifiers and no teams/labels; Azure returns reviewer GUIDs and labels but no teams. Use the fingerprint as the lease for replacement.",
			inputSchema: z.object({ number: z.number().int().min(1).max(2147483647) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_source_control_review_metadata", args)
	);
	server.registerTool(
		"set_project_source_control_review_metadata",
		{
			title: "Set project source-control review metadata",
			description:
				"After confirm=true, replace bounded provider-supported reviewers, teams, and labels only if expectedFingerprint still matches current metadata and head. Requires collaboration admin. GitHub reports multi-request partial-mutation risk; GitLab resolves exact usernames; Bitbucket accepts inspected reviewer {UUID}s and rejects teams/labels; Azure accepts reviewer GUIDs and labels, rejects teams, and reports multi-request partial-mutation risk.",
			inputSchema: z.object({
				number: z.number().int().min(1).max(2147483647),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				reviewers: z.array(z.string().min(1).max(128)).max(20).optional(),
				teams: z.array(z.string().min(1).max(128)).max(20).optional(),
				labels: z.array(z.string().min(1).max(128)).max(50).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_source_control_review_metadata", args)
	);
	server.registerTool(
		"list_project_source_control_review_checks",
		{
			title: "List project source-control review checks",
			description:
				"Inspect bounded normalized GitHub check-runs/Actions, GitLab pipelines/jobs, Bitbucket commit statuses, or Azure DevOps PR statuses and policy evaluations for the review's exact current head SHA. Returns a compact summary; Bitbucket status reruns are unsupported while Azure policy evaluations expose rerunnable GUIDs.",
			inputSchema: z.object({ number: z.number().int().min(1).max(2147483647) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_source_control_review_checks", args)
	);
	server.registerTool(
		"rerun_project_source_control_review_checks",
		{
			title: "Rerun project source-control review checks",
			description:
				"After confirm=true, re-inspect review checks and rerun a verified GitHub Actions run, retry a GitLab pipeline, or requeue an Azure DevOps policy evaluation only when it belongs to expectedHeadSha, which must still be the exact current review head. Requires collaboration admin; GitLab supports failed-job retry only and Bitbucket rejects rerun as unsupported.",
			inputSchema: z.object({
				number: z.number().int().min(1).max(2147483647),
				expectedHeadSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
				runId: z.union([z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[a-fA-F0-9-]{36}$/)]),
				mode: z.enum(["failed", "all"]).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("rerun_project_source_control_review_checks", args)
	);
	server.registerTool(
		"submit_project_source_control_review",
		{
			title: "Submit project source-control review",
			description:
				"After confirm=true, submit an approval, request-changes decision, or comment to one hosted review. GitHub, Bitbucket, and Azure DevOps support all three; Azure maps decisions to reviewer votes and comments to PR threads. GitLab supports approve/comment and rejects requestChanges. Requires collaboration admin, bounded body text, and an environment-only credential.",
			inputSchema: z.object({
				number: z.number().int().min(1).max(2147483647),
				action: z.enum(["approve", "requestChanges", "comment"]),
				body: z.string().max(65536).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("submit_project_source_control_review", args)
	);
	server.registerTool(
		"merge_project_source_control_review",
		{
			title: "Merge project source-control review",
			description:
				"After confirm=true, re-inspect and merge one hosted review only when its exact current head SHA equals expectedHeadSha from review inspection. Requires collaboration admin and an environment-only credential. GitHub and Azure DevOps support merge/squash/rebase; GitLab and Bitbucket Cloud support merge/squash and reject rebase. Azure completion leases lastMergeSourceCommit. Returns normalized outcome without force-updating Git refs directly.",
			inputSchema: z.object({
				number: z.number().int().min(1).max(2147483647),
				expectedHeadSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
				method: z.enum(["merge", "squash", "rebase"]).optional(),
				commitTitle: z.string().min(1).max(256).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("merge_project_source_control_review", args)
	);
	server.registerTool(
		"get_project_collaboration_status",
		{
			title: "Get project collaboration status",
			description:
				"Read whether project collaboration role enforcement is enabled, bounded member/session counts, and the MCP process's current joined actor when available. No credentials or stored token hashes are returned.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_collaboration_status", {})
	);
	server.registerTool(
		"configure_project_collaboration",
		{
			title: "Configure project collaboration",
			description:
				"Enable opt-in role enforcement and bootstrap the first admin, or disable/reset it as a joined admin. Enabling returns a one-time member id and access key; save them securely, then join a session. Disabling removes all members and sessions.",
			inputSchema: z.object({ enabled: z.boolean(), bootstrapAdminName: z.string().min(1).max(128).optional() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("configure_project_collaboration", args)
	);
	server.registerTool(
		"list_project_collaboration_members",
		{
			title: "List project collaboration members",
			description:
				"List public project member identities, roles, enabled states, and timestamps. Enforcement requires a joined session; secrets and token hashes are never returned.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_project_collaboration_members", {})
	);
	server.registerTool(
		"create_project_collaboration_member",
		{
			title: "Create project collaboration member",
			description:
				"Create an admin, editor, or viewer as a joined admin. The response returns the member's access key exactly once; share it securely so that member can join from their own MCP process.",
			inputSchema: z.object({ name: z.string().min(1).max(128), role: z.enum(["admin", "editor", "viewer"]), enabled: z.boolean().optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_project_collaboration_member", args)
	);
	server.registerTool(
		"set_project_collaboration_member",
		{
			title: "Set project collaboration member",
			description:
				"Update a member as a joined admin. Rotating the access key invalidates that member's active sessions and returns the new key once. The last enabled admin cannot be removed, disabled, or demoted.",
			inputSchema: z.object({
				id: z.string().uuid(),
				name: z.string().min(1).max(128).optional(),
				role: z.enum(["admin", "editor", "viewer"]).optional(),
				enabled: z.boolean().optional(),
				rotateAccessKey: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_collaboration_member", args)
	);
	server.registerTool(
		"delete_project_collaboration_member",
		{
			title: "Delete project collaboration member",
			description: "Delete another member and all of their active sessions as a joined admin. Self-deletion and deletion of the final enabled admin are rejected.",
			inputSchema: z.object({ id: z.string().uuid() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_collaboration_member", args)
	);
	server.registerTool(
		"join_project_collaboration_session",
		{
			title: "Join project collaboration session",
			description:
				"Authenticate a member and create an expiring rich-presence session for this MCP process. Presence can include identity color/tool, stable primary/hover/selection ids, up to eight normalized multi-viewport mouse/pen/touch/XR pointers with optional world rays/hits, and bounded shared camera framing. The returned token is retained internally and attached to later tools.",
			inputSchema: z.object({
				memberId: z.string().uuid(),
				accessKey: z.string().min(32).max(128),
				clientName: z.string().min(1).max(128),
				state: z.string().max(256).optional(),
				...richPresenceShape,
				ttlSeconds: z.number().int().min(30).max(3600).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("join_project_collaboration_session", args)
	);
	server.registerTool(
		"heartbeat_project_collaboration_session",
		{
			title: "Heartbeat project collaboration session",
			description:
				"Refresh this MCP process's presence expiry and atomically replace any supplied rich-presence fields: activity, color/tool, stable selection/primary/hover ids, up to eight viewport pointers with optional world rays/hits, legacy cursor, and shared camera framing. Empty pointers clears pointers; null primary/hover/camera clears that field.",
			inputSchema: z.object({
				state: z.string().max(256).optional(),
				...richPresenceShape,
				ttlSeconds: z.number().int().min(30).max(3600).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("heartbeat_project_collaboration_session", args)
	);
	server.registerTool(
		"leave_project_collaboration_session",
		{
			title: "Leave project collaboration session",
			description: "Remove this MCP process's current presence session and clear its internally retained session token.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("leave_project_collaboration_session", {})
	);
	server.registerTool(
		"list_project_collaboration_presence",
		{
			title: "List project collaboration presence",
			description:
				"List non-expired sessions with public member/client identity, stable color/tool, selection/primary/hover ids, normalized multi-viewport pointers and optional world rays/hits, shared camera framing, legacy cursor compatibility, and heartbeat/expiry timestamps. Enforcement requires a joined session.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_project_collaboration_presence", {})
	);
	server.registerTool(
		"generate_remote_collaboration_tls_certificate",
		{
			title: "Generate remote collaboration TLS certificate",
			description:
				"Generate or explicitly rotate a project-contained self-signed development server certificate and RSA private key for the remote collaboration HTTPS gateway. Requires a joined administrator. Supports 1–32 DNS/IP SANs, 1–825 validity days, and RSA-2048/3072/4096. Existing files require confirmOverwrite=true. The private key is mode 0600 and is never returned; OS trust is never changed automatically.",
			inputSchema: z.object({
				certificatePath: z.string().min(1).max(512).optional(),
				privateKeyPath: z.string().min(1).max(512).optional(),
				hosts: z.array(z.string().min(1).max(253)).min(1).max(32).optional(),
				commonName: z.string().min(1).max(253).optional(),
				validityDays: z.number().int().min(1).max(825).optional(),
				rsaBits: z.union([z.literal(2048), z.literal(3072), z.literal(4096)]).optional(),
				confirmOverwrite: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_remote_collaboration_tls_certificate", args)
	);
	server.registerTool(
		"inspect_remote_collaboration_tls_certificate",
		{
			title: "Inspect remote collaboration TLS certificate",
			description:
				"Inspect a project-contained X.509 certificate without returning certificate or key contents. Reports subject/issuer/SAN, SHA-256 fingerprint, serial, validity and expiry warning, key type/bits, private-key presence/match, and review-first OS trust guidance. Requires a joined collaboration session and rejects traversal, metadata paths, symlinks, and oversized files.",
			inputSchema: z.object({ certificatePath: z.string().min(1).max(512).optional(), privateKeyPath: z.string().min(1).max(512).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_remote_collaboration_tls_certificate", args)
	);
	server.registerTool(
		"get_remote_collaboration_discovery",
		{
			title: "Get remote collaboration discovery",
			description:
				"Read the project-contained UDP discovery configuration and live advertiser state. Reports the public discovery ID, display name, multicast/local target, response count, gateway dependency, last error, and an explicit inventory of published versus excluded fields. Requires a joined collaboration session.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_remote_collaboration_discovery", {})
	);
	server.registerTool(
		"set_remote_collaboration_discovery",
		{
			title: "Set remote collaboration discovery",
			description:
				"Enable, disable, or reconfigure authenticated-project LAN discovery as a joined administrator. Advertising runs only while the collaboration gateway is running. Announcements contain a sanitized label, random public ID, gateway address/protocol/port, authentication requirement, expiry, and optional TLS fingerprint; they never contain paths, allowlists, members, sessions, tokens, certificate contents, or private keys.",
			inputSchema: z.object({
				enabled: z.boolean().optional(),
				displayName: z.string().min(1).max(80).optional(),
				address: z.string().min(7).max(15).optional().describe("IPv4 multicast address, or 127.0.0.1 for local-only discovery."),
				port: z.number().int().min(1024).max(65535).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_remote_collaboration_discovery", args)
	);
	server.registerTool(
		"discover_remote_collaboration_projects",
		{
			title: "Discover remote collaboration projects",
			description:
				"Send one bounded UDP discovery query and collect nonce-matched, unexpired Babylon Editor collaboration announcements. Results are deduplicated by public discovery ID and include the gateway URL, authentication requirement, and optional TLS fingerprint. Discovery metadata is explicitly untrusted; obtain credentials separately and verify TLS before connecting.",
			inputSchema: z.object({
				address: z.string().min(7).max(15).optional().describe("IPv4 multicast target, or 127.0.0.1 for deterministic local-only discovery."),
				port: z.number().int().min(1024).max(65535).optional(),
				timeoutMs: z.number().int().min(100).max(5000).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("discover_remote_collaboration_projects", args)
	);
	server.registerTool(
		"get_remote_collaboration_relay",
		{
			title: "Get remote collaboration relay",
			description:
				"Read the outbound managed-relay configuration and credential-safe runtime status, including connection/registration state, public URL, reconnect attempt, request/byte counters, limits, and whether authentication is available live or through the named environment variable. Relay secrets are never returned or persisted. Requires a joined collaboration session.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_remote_collaboration_relay", {})
	);
	server.registerTool(
		"set_remote_collaboration_relay",
		{
			title: "Set remote collaboration relay",
			description:
				"Enable, disable, or configure the editor's NAT-friendly outbound WebSocket relay as a joined administrator. Production URLs require wss://; ws:// is accepted only for loopback development. relayAccessToken is live-only and never written to project metadata, returned, or logged. The relay tunnels bounded action, presence, event-read, and asset-lock requests through the existing collaboration-session RBAC.",
			inputSchema: z.object({
				enabled: z.boolean().optional(),
				relayUrl: z.string().url().max(2048).optional(),
				projectSlug: z
					.string()
					.regex(/^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/)
					.optional(),
				relayAccessToken: z.string().min(16).max(512).optional().describe("Live-only relay credential. It is never persisted or returned."),
				tokenEnvironmentVariable: z
					.string()
					.regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
					.optional(),
				reconnectMinimumMs: z.number().int().min(500).max(30000).optional(),
				reconnectMaximumMs: z.number().int().min(1000).max(120000).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_remote_collaboration_relay", args)
	);
	server.registerTool(
		"reconnect_remote_collaboration_relay",
		{
			title: "Reconnect remote collaboration relay",
			description:
				"Close the current outbound relay connection, reset exponential backoff, and connect immediately. A joined administrator may optionally replace the live-only relay token. The configured relay must already be enabled; no credential is persisted or returned.",
			inputSchema: z.object({ relayAccessToken: z.string().min(16).max(512).optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("reconnect_remote_collaboration_relay", args)
	);
	server.registerTool(
		"get_remote_collaboration_gateway",
		{
			title: "Get remote collaboration gateway",
			description:
				"Read the opt-in remote HTTP/HTTPS gateway configuration and runtime state, including actual port, protocol, retained-event sequence, and SSE subscriber count. A joined collaboration session is required.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_remote_collaboration_gateway", {})
	);
	server.registerTool(
		"set_remote_collaboration_gateway",
		{
			title: "Set remote collaboration gateway",
			description:
				"Start, stop, or reconfigure the authenticated remote action/SSE gateway as a joined admin. Non-loopback binding requires project-contained TLS certificate/key files and explicit exact allowed origins/hosts. Remote access is disabled by default; session tokens are accepted only as Authorization Bearer headers, never URLs.",
			inputSchema: z.object({
				enabled: z.boolean().optional(),
				bindAddress: z.string().min(2).max(64).optional(),
				port: z.number().int().min(1024).max(65535).optional(),
				allowedOrigins: z.array(z.string().url().max(256)).max(32).optional(),
				allowedHosts: z.array(z.string().min(1).max(256)).max(32).optional(),
				tlsCertificatePath: z.string().max(512).nullable().optional(),
				tlsPrivateKeyPath: z.string().max(512).nullable().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_remote_collaboration_gateway", args)
	);
	server.registerTool(
		"list_remote_collaboration_events",
		{
			title: "List remote collaboration events",
			description:
				"Read a paginated, durable cross-restart replay window of sanitized local/remote operation, presence, gateway, and lock events after a sequence number. Returns oldest/latest sequence, gap detection, nextAfterSequence, and filters. Full action payloads and credentials are never retained. For live delivery, remote clients subscribe to authenticated /events with Last-Event-ID.",
			inputSchema: z.object({
				afterSequence: z.number().int().min(0).optional(),
				limit: z.number().int().min(1).max(500).optional(),
				type: z.enum(["operation", "presence", "gateway", "lock"]).optional(),
				source: z.enum(["local", "remote", "system"]).optional(),
				success: z.boolean().optional(),
				endpoint: z.string().min(1).max(128).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_remote_collaboration_events", args)
	);
	server.registerTool(
		"set_remote_collaboration_event_history",
		{
			title: "Configure remote collaboration event history",
			description:
				"Enable or disable durable sanitized collaboration event journaling and set retention from 100 through 10,000 events. Requires a joined project administrator. Disabling future persistence does not erase existing history; use the explicit clear tool for erasure.",
			inputSchema: z.object({ enabled: z.boolean().optional(), retention: z.number().int().min(100).max(10000).optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_remote_collaboration_event_history", args)
	);
	server.registerTool(
		"clear_remote_collaboration_event_history",
		{
			title: "Clear remote collaboration event history",
			description:
				"Permanently erase all retained sanitized collaboration events while preserving the monotonic next sequence for connected replay clients. Requires a joined project administrator and confirm=true.",
			inputSchema: z.object({ confirm: z.literal(true) }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_remote_collaboration_event_history", args)
	);
	server.registerTool(
		"get_project_asset_lock_federation",
		{
			title: "Get remote asset-lock federation",
			description:
				"Inspect the authenticated remote asset-lock routes, gateway address, collaboration-member identity mode, and the current session's list/acquire/refresh/release/force-release permissions. Remote clients use the same leases as local editor and MCP clients.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_asset_lock_federation", args)
	);

	server.registerTool(
		"list_project_asset_locks",
		{
			title: "List project asset locks",
			description:
				"List active project leases shared by local editor/MCP and authenticated remote clients. Expired locks are hidden unless requested. Under collaboration, another member's lockId is redacted and canManage reports whether the current session may renew/release it.",
			inputSchema: z.object({ includeExpired: z.boolean().optional().describe("Include expired leases for diagnostics without deleting them.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_asset_locks", args)
	);
	server.registerTool(
		"inspect_project_asset_lock_policy",
		{
			title: "Inspect project Smart Lock policy",
			description:
				"For one existing project file, read the first matching ordered Smart Lock rule, exact current/destination Git commit and asset-blob revisions, clean-path and destination-ancestor freshness, current shared lock with permission-safe lease identity, and retained/releasable merge evidence. A remote rule uses the already-fetched remote-tracking ref and never contacts the network; fetch explicitly first when authoritative remote freshness is required.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_project_asset_lock_policy", args)
	);
	server.registerTool(
		"list_project_asset_lock_rules",
		{
			title: "List project Smart Lock rules",
			description:
				"List up to 100 ordered persistent Smart Lock rules, or only enabled rules matching one project-relative path. The first enabled match owns policy. Rules bind wildcard asset paths to a local or known remote-tracking destination branch and manual or until-merged retention without changing Git, locks, or files.",
			inputSchema: z.object({ path: z.string().min(1).max(512).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_asset_lock_rules", args)
	);
	server.registerTool(
		"create_project_asset_lock_rule",
		{
			title: "Create project Smart Lock rule",
			description:
				"Create one of at most 100 ordered persistent Smart Lock policies after collaboration-admin authorization when enforcement is enabled. Path patterns support bounded *, **, and ? wildcards; destinationRemote null means a local branch, while a named remote uses its explicitly fetched tracking ref. Until-merged retention survives lease expiry and prevents normal release while the acquisition branch has dirty asset edits or unmerged commits.",
			inputSchema: z.object({
				name: z.string().min(1).max(128),
				enabled: z.boolean().optional(),
				pathPattern: z.string().min(1).max(256),
				destinationBranch: z.string().min(1).max(255),
				destinationRemote: z.string().min(1).max(128).nullable().optional(),
				retention: z.enum(["manual", "untilMerged"]).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_project_asset_lock_rule", args)
	);
	server.registerTool(
		"set_project_asset_lock_rule",
		{
			title: "Set project Smart Lock rule",
			description:
				"Update selected fields of one persistent Smart Lock rule after collaboration-admin authorization while preserving its stable id, order, and creation timestamp.",
			inputSchema: z.object({
				id: z.string().uuid(),
				name: z.string().min(1).max(128).optional(),
				enabled: z.boolean().optional(),
				pathPattern: z.string().min(1).max(256).optional(),
				destinationBranch: z.string().min(1).max(255).optional(),
				destinationRemote: z.string().min(1).max(128).nullable().optional(),
				retention: z.enum(["manual", "untilMerged"]).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_asset_lock_rule", args)
	);
	server.registerTool(
		"delete_project_asset_lock_rule",
		{
			title: "Delete project Smart Lock rule",
			description:
				"Delete one persistent Smart Lock rule after collaboration-admin authorization. Existing leases and their retained acquisition evidence are preserved and remain enforceable.",
			inputSchema: z.object({ id: z.string().uuid() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_asset_lock_rule", args)
	);
	server.registerTool(
		"acquire_project_asset_lock",
		{
			title: "Acquire project asset lock",
			description:
				"Atomically acquire a shared local/remote lease for an existing project file before editing it. In an authenticated collaboration session, owner is derived from the member identity and the lease is bound to that member; caller-supplied owner is used only in legacy collaboration-disabled mode. When a Smart Lock rule matches, exact head/destination hashes from policy inspection are required, the asset path must be clean, and the current branch must contain the destination. A conflict is returned without exposing its lockId.",
			inputSchema: z.object({
				path: z.string().min(1).describe("Existing project-relative asset or serialized editor-file path."),
				owner: z
					.string()
					.min(1)
					.max(128)
					.optional()
					.describe("Legacy owner used only when collaboration is disabled; authenticated sessions derive this from their member identity."),
				note: z.string().max(512).optional().describe("Optional reason for the lock."),
				ttlSeconds: z.number().int().min(30).max(604800).optional().describe("Lease duration from 30 seconds through 7 days; defaults to 30 minutes."),
				expectedHeadHash: z
					.string()
					.regex(/^[a-f0-9]{40,64}$/)
					.optional()
					.describe("Required exact HEAD from policy inspection when a Smart Lock rule matches."),
				expectedDestinationHash: z
					.string()
					.regex(/^[a-f0-9]{40,64}$/)
					.optional()
					.describe("Required exact local or remote-tracking destination revision from policy inspection when a Smart Lock rule matches."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("acquire_project_asset_lock", args)
	);
	server.registerTool(
		"refresh_project_asset_lock",
		{
			title: "Refresh project asset lock",
			description:
				"Extend an unexpired project asset-lock lease using the lockId returned for the current member. Federated leases also require the authenticated member that owns the lock (or an admin). The lock identity and original creation time are preserved.",
			inputSchema: z.object({
				path: z.string().min(1),
				lockId: z.string().uuid(),
				ttlSeconds: z.number().int().min(30).max(604800).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_project_asset_lock", args)
	);
	server.registerTool(
		"release_project_asset_lock",
		{
			title: "Release project asset lock",
			description:
				"Release a shared local/remote asset lock using its lockId. Federated leases require the owning collaboration member. An until-merged Smart Lock remains retained while its acquisition branch has dirty asset changes or a tip not merged into the current destination. Set force only for explicit admin recovery; non-admin force attempts are rejected.",
			inputSchema: z
				.object({ path: z.string().min(1), lockId: z.string().uuid().optional(), force: z.boolean().optional() })
				.refine((value) => value.force === true || Boolean(value.lockId), { message: "lockId is required unless force is true." }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("release_project_asset_lock", args)
	);
	server.registerTool(
		"compare_project_scene_assets",
		{
			title: "Compare project scene or prefab assets",
			description:
				"Read a bounded identity-aware semantic diff between two persisted .scene directories or two .prefab JSON files. Scene JSON manifests are compared across files; identified arrays match by uniqueId/id/key/name/frame so harmless reordering is ignored. No project files are changed.",
			inputSchema: z.object({
				sourcePath: z.string().min(1).describe("Project-relative baseline .scene directory or .prefab file."),
				targetPath: z.string().min(1).describe("Project-relative candidate asset of the same kind."),
				maximumChanges: z
					.number()
					.int()
					.min(1)
					.max(5000)
					.optional()
					.describe("Maximum detailed changes returned; totals still describe the complete comparison. Defaults to 500."),
				numericTolerance: z.number().min(0).max(1).optional().describe("Absolute tolerance for numeric leaf differences. Defaults to exact comparison."),
				ignorePaths: z.array(z.string().startsWith("/").max(512)).max(64).optional().describe("Semantic path prefixes to ignore across compared JSON files."),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("compare_project_scene_assets", args)
	);
	server.registerTool(
		"merge_project_scene_assets",
		{
			title: "Merge project scene or prefab assets",
			description:
				"Perform a bounded three-way semantic merge of base, ours, and theirs persisted .scene directories or .prefab JSON files. Stable-ID arrays merge by uniqueId/id/key/name/frame. The default is a read-like preview with explicit conflicts; write=true creates a new output asset and never overwrites a source or existing output. Manual conflicts must be resolved by choosing ours or theirs before writing.",
			inputSchema: z.object({
				basePath: z.string().min(1).describe("Project-relative common-ancestor .scene directory or .prefab file."),
				oursPath: z.string().min(1).describe("Project-relative local asset derived from base."),
				theirsPath: z.string().min(1).describe("Project-relative incoming asset derived from base."),
				outputPath: z.string().min(1).optional().describe("New project-relative output path. Required only when write=true; existing assets are never overwritten."),
				write: z.boolean().optional().describe("Create the new output asset when true. Defaults to a non-mutating preview."),
				resolution: z.enum(["manual", "ours", "theirs"]).optional().describe("Conflict policy. Manual reports unresolved conflicts and blocks writes; defaults to manual."),
				maximumConflicts: z.number().int().min(1).max(5000).optional().describe("Maximum detailed conflicts returned; complete totals are retained. Defaults to 500."),
				numericTolerance: z.number().min(0).max(1).optional().describe("Absolute tolerance for numeric leaf equality. Defaults to exact comparison."),
				ignorePaths: z.array(z.string().startsWith("/").max(512)).max(64).optional().describe("Semantic path prefixes kept from ours and excluded from merging."),
				conflictResolutions: z
					.array(semanticMergeResolutionSchema)
					.max(500)
					.optional()
					.describe("Exact per-conflict choices. These override selected reusable rules and the global resolution policy."),
				ruleIds: z.array(z.string().uuid()).max(100).optional().describe("Ordered persistent semantic merge-rule ids to apply after exact overrides."),
				expectedBaseHash: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional()
					.describe("Optional preview SHA-256 guard for base."),
				expectedOursHash: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional()
					.describe("Optional preview SHA-256 guard for ours."),
				expectedTheirsHash: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional()
					.describe("Optional preview SHA-256 guard for theirs."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("merge_project_scene_assets", args)
	);
	server.registerTool(
		"list_project_semantic_merge_rules",
		{
			title: "List project semantic merge rules",
			description:
				"List persistent named semantic merge-resolution rules in their application order. Rules match asset kind, a bounded manifest-file wildcard, and a semantic-path prefix; listing does not change the project.",
			inputSchema: z.object({ assetKind: z.enum(["any", "scene", "prefab"]).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_semantic_merge_rules", args)
	);
	server.registerTool(
		"create_project_semantic_merge_rule",
		{
			title: "Create project semantic merge rule",
			description:
				"Create a persistent named merge-resolution rule. A selected rule resolves matching conflicts with ours, theirs, base, deletion, or bounded custom JSON; exact conflict resolutions still take precedence.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(128),
					enabled: z.boolean().optional(),
					assetKind: z.enum(["any", "scene", "prefab"]).optional(),
					filePattern: z.string().min(1).max(256).optional(),
					pathPrefix: z.string().startsWith("/").max(512).optional(),
					choice: semanticMergeChoiceSchema,
					customValue: z.json().optional(),
				})
				.refine((value) => value.choice !== "custom" || value.customValue !== undefined, { message: "customValue is required when choice is custom." }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_project_semantic_merge_rule", args)
	);
	server.registerTool(
		"set_project_semantic_merge_rule",
		{
			title: "Set project semantic merge rule",
			description: "Update selected fields of a persistent semantic merge-resolution rule without changing its stable id or creation timestamp.",
			inputSchema: z.object({
				id: z.string().uuid(),
				name: z.string().min(1).max(128).optional(),
				enabled: z.boolean().optional(),
				assetKind: z.enum(["any", "scene", "prefab"]).optional(),
				filePattern: z.string().min(1).max(256).optional(),
				pathPrefix: z.string().startsWith("/").max(512).optional(),
				choice: semanticMergeChoiceSchema.optional(),
				customValue: z.json().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_semantic_merge_rule", args)
	);
	server.registerTool(
		"delete_project_semantic_merge_rule",
		{
			title: "Delete project semantic merge rule",
			description: "Delete one persistent semantic merge-resolution rule by stable id. Existing scene, prefab, and merge output assets are not changed.",
			inputSchema: z.object({ id: z.string().uuid() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_semantic_merge_rule", args)
	);
	server.registerTool(
		"list_project_changelists",
		{
			title: "List project changelists",
			description:
				"List persistent project-local changelists and their exclusively assigned file paths without changing the store. Optionally filter by exact owner identity.",
			inputSchema: z.object({ owner: z.string().min(1).max(128).optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_changelists", args)
	);
	server.registerTool(
		"create_project_changelist",
		{
			title: "Create project changelist",
			description:
				"Create a named project-local changelist with an owner, optional description, and optional initial project-relative files. A file cannot belong to two changelists.",
			inputSchema: z.object({
				name: z.string().min(1).max(80),
				owner: z.string().min(1).max(128),
				description: z.string().max(512).optional(),
				paths: z.array(z.string().min(1)).max(2000).optional(),
			}),
			annotations: { idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_project_changelist", args)
	);
	server.registerTool(
		"set_project_changelist",
		{
			title: "Update project changelist",
			description: "Update a changelist's name, description, or owner while preserving its assigned files. Identify it by id or exact current name.",
			inputSchema: z
				.object({
					id: z.string().uuid().optional(),
					name: z.string().min(1).max(80).optional(),
					newName: z.string().min(1).max(80).optional(),
					description: z.string().max(512).optional(),
					owner: z.string().min(1).max(128).optional(),
				})
				.refine((value) => Boolean(value.id || value.name), { message: "id or name is required." })
				.refine((value) => value.newName !== undefined || value.description !== undefined || value.owner !== undefined, {
					message: "At least one updated field is required.",
				}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_changelist", args)
	);
	server.registerTool(
		"set_project_changelist_files",
		{
			title: "Set project changelist files",
			description:
				"Replace, add, or remove bounded project-relative file assignments. Existing and deleted files are supported. Set reassign only when explicitly moving conflicts out of other changelists.",
			inputSchema: z
				.object({
					id: z.string().uuid().optional(),
					name: z.string().min(1).max(80).optional(),
					mode: z.enum(["replace", "add", "remove"]).optional(),
					paths: z.array(z.string().min(1)).max(2000),
					reassign: z.boolean().optional(),
				})
				.refine((value) => Boolean(value.id || value.name), { message: "id or name is required." }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_changelist_files", args)
	);
	server.registerTool(
		"delete_project_changelist",
		{
			title: "Delete project changelist",
			description: "Delete an empty changelist. Deleting a non-empty changelist requires force:true and unassigns its files without deleting project files.",
			inputSchema: z
				.object({ id: z.string().uuid().optional(), name: z.string().min(1).max(80).optional(), force: z.boolean().optional() })
				.refine((value) => Boolean(value.id || value.name), { message: "id or name is required." }),
			annotations: { destructiveHint: true, idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_changelist", args)
	);
	const projectPackageName = z
		.string()
		.min(1)
		.max(214)
		.regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i)
		.describe("Normal npm package identifier, including an optional @scope/ prefix.");
	const projectPackageDependencyType = z.enum(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);
	const projectPackageExactVersion = z
		.string()
		.min(5)
		.max(512)
		.regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
		.describe("Exact semantic version without a range, tag, protocol, or package-manager alias.");
	const projectPackageSource = z.discriminatedUnion("type", [
		z.object({ type: z.literal("registry") }).strict(),
		z
			.object({
				type: z.literal("git"),
				url: z.string().url().max(2048),
				commit: z
					.string()
					.regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/)
					.optional(),
			})
			.strict(),
		z.object({ type: z.literal("local"), path: z.string().min(1).max(1024) }).strict(),
		z
			.object({ type: z.literal("tarball"), path: z.string().min(1).max(1024).optional(), url: z.string().url().max(2048).optional() })
			.strict()
			.refine((value) => Number(value.path !== undefined) + Number(value.url !== undefined) === 1, { message: "Exactly one tarball path or URL is required." }),
	]);
	const projectPackageChange = z
		.object({
			operation: z.enum(["install", "remove", "update"]),
			name: projectPackageName,
			version: projectPackageExactVersion.optional(),
			dependencyType: projectPackageDependencyType.optional(),
			source: projectPackageSource.optional(),
		})
		.strict();
	const projectPackagePagination = {
		offset: z.number().int().min(0).max(1_000_000).optional(),
		limit: z.number().int().min(1).max(500).optional(),
	};
	const projectPackageSampleLease = {
		sampleId: z.string().regex(/^[a-f0-9]{32}$/),
		expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
		expectedPackageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	};
	server.registerTool(
		"list_project_packages",
		{
			title: "List project packages",
			description:
				"List a bounded page of direct dependencies across dependencies, devDependencies, optionalDependencies, and peerDependencies. Returns the exact package/lock fingerprint, workspace ownership, lockfile hashes, totals, and nextOffset without running a manager or contacting a registry.",
			inputSchema: z.object({ ...projectPackagePagination, query: z.string().max(214).optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_packages", args)
	);
	server.registerTool(
		"get_project_package_manager",
		{
			title: "Get project package manager",
			description:
				"Inspect the configured npm, Yarn, pnpm, or Bun executable and version plus exact manifest/lock/workspace evidence, supported sources, script policy, and the active bounded operation. Runs only the manager's local --version command.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_package_manager", {})
	);
	server.registerTool(
		"list_project_package_registries",
		{
			title: "List project package registries",
			description:
				"List configured default and scoped project registries with configuration hashes and credential availability. Credential values are never returned; only environment-variable names and literal-secret presence are reported.",
			inputSchema: z.object({ offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_package_registries", args)
	);
	server.registerTool(
		"search_project_package_registry",
		{
			title: "Search project package registry",
			description:
				"Search one configured registry with bounded offset/limit pagination. Uses an environment-resolved credential only in memory, enforces HTTPS or loopback HTTP, bounded redirects/body/timeouts, and returns concise package metadata plus total/nextOffset.",
			inputSchema: z
				.object({
					query: z.string().min(1).max(200),
					registryId: z
						.string()
						.regex(/^[a-f0-9]{24}$/)
						.optional(),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(50).optional(),
					timeoutMs: z.number().int().min(1000).max(60000).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("search_project_package_registry", args)
	);
	server.registerTool(
		"get_project_package_details",
		{
			title: "Get project package details",
			description:
				"Get one package's registry metadata, dist-tags, selected exact release dependencies/integrity, and paginated release history. Readmes are deliberately omitted and all responses/timeouts are bounded.",
			inputSchema: z
				.object({
					name: projectPackageName,
					version: projectPackageExactVersion.optional(),
					registryId: z
						.string()
						.regex(/^[a-f0-9]{24}$/)
						.optional(),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(100).optional(),
					timeoutMs: z.number().int().min(1000).max(60000).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_package_details", args)
	);
	server.registerTool(
		"plan_project_package_registry_change",
		{
			title: "Plan project package registry change",
			description:
				"Create an expiring no-write plan to upsert or remove one default/scoped project-root .npmrc registry. The source fingerprint is exact; credentials may only be authored as environment-variable references.",
			inputSchema: z
				.object({
					action: z.enum(["upsert", "remove"]),
					scope: z
						.string()
						.regex(/^@[a-z0-9][a-z0-9._-]*$/i)
						.max(214)
						.nullable()
						.optional(),
					url: z.string().url().max(2048).optional(),
					credentialEnvironmentVariable: z
						.string()
						.regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
						.nullable()
						.optional(),
					removeCredential: z.boolean().optional(),
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("plan_project_package_registry_change", args)
	);
	server.registerTool(
		"apply_project_package_registry_plan",
		{
			title: "Apply project package registry plan",
			description:
				"Apply one exact unexpired registry plan through an atomic project-root .npmrc replacement. Requires the plan id, exact source fingerprint, and confirm:true; verifies the planned SHA-256 postcondition.",
			inputSchema: z.object({ planId: z.string().uuid(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_project_package_registry_plan", args)
	);
	server.registerTool(
		"get_project_package_dependency_graph",
		{
			title: "Get project package dependency graph",
			description:
				"Read a bounded paginated direct/resolved/transitive graph from npm package-lock/shrinkwrap, Yarn classic, pnpm YAML, Bun text, or a contained installed fallback. Returns lock hashes, missing edges, warnings, totals, and nextOffset.",
			inputSchema: z
				.object({
					...projectPackagePagination,
					query: z.string().max(214).optional(),
					directOnly: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_package_dependency_graph", args)
	);
	server.registerTool(
		"get_project_package_updates",
		{
			title: "Get project package updates",
			description:
				"Resolve current locked versions and registry wanted/latest versions for a bounded page of direct packages. Reports semver change kind, unsupported ranges, per-package errors, totals, and nextOffset without changing package files.",
			inputSchema: z
				.object({
					names: z.array(projectPackageName).min(1).max(100).optional(),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(50).optional(),
					includePrerelease: z.boolean().optional(),
					timeoutMs: z.number().int().min(1000).max(60000).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_package_updates", args)
	);
	server.registerTool(
		"plan_project_package_changes",
		{
			title: "Plan project package changes",
			description:
				"Create an expiring no-write exact plan for 1–100 installs, updates, and removals using npm, Yarn, pnpm, or Bun. Registry changes require exact versions; Git/local/tarball sources are validated; scripts stay disabled unless explicitly enabled.",
			inputSchema: z
				.object({
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					changes: z.array(projectPackageChange).min(1).max(100),
					allowWorkspaceRoot: z.boolean().optional(),
					allowScripts: z.boolean().optional(),
					timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
					maximumOutputBytes: z.number().int().min(16_384).max(4_194_304).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("plan_project_package_changes", args)
	);
	server.registerTool(
		"apply_project_package_plan",
		{
			title: "Apply project package plan",
			description:
				"Apply one exact unexpired package plan through the selected manager with shell-free bounded execution, one-operation locking, confirmation, stale checks, exact package/lock snapshots, postconditions, file hashes, and rollback on failure.",
			inputSchema: z.object({ planId: z.string().uuid(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_project_package_plan", args)
	);
	server.registerTool(
		"cancel_project_package_operation",
		{
			title: "Cancel project package operation",
			description: "Cancel the one active bounded package-manager child process. Optionally require its exact operationId; returns a no-op reason when nothing is running.",
			inputSchema: z.object({ operationId: z.string().uuid().optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_project_package_operation", args)
	);
	server.registerTool(
		"list_project_package_samples",
		{
			title: "List project package samples",
			description:
				"List installed direct-package sample manifests with bounded file/byte/depth scans and exact source SHA-256 evidence. Returns per-package validation errors, pagination totals, and nextOffset without writing assets.",
			inputSchema: z
				.object({
					packageName: projectPackageName.optional(),
					query: z.string().max(200).optional(),
					sortBy: z.enum(["display-name", "package-name", "publish-date"]).optional(),
					sortDirection: z.enum(["asc", "desc"]).optional(),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_package_samples", args)
	);
	server.registerTool(
		"get_project_package_sample_details",
		{
			title: "Get project package sample details",
			description:
				"Read one exact installed sample's bounded Overview/Details cards, publication timestamp, verified PNG/JPEG/WebP/GIF image metadata and contained preview URLs, source evidence, and current imported-target match state without writing files.",
			inputSchema: z.object({ ...projectPackageSampleLease, targetPath: z.string().min(1).max(1024).optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_package_sample_details", args)
	);
	server.registerTool(
		"locate_project_package_sample",
		{
			title: "Locate imported project package sample",
			description:
				"Reveal one exact existing imported sample target in the normal Assets Browser and select its first file. Validates the current package/source lease and contained target tree; does not change project files.",
			inputSchema: z.object({ ...projectPackageSampleLease, targetPath: z.string().min(1).max(1024).optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("locate_project_package_sample", args)
	);
	server.registerTool(
		"plan_project_package_sample_import",
		{
			title: "Plan project package sample import",
			description:
				"Create an expiring no-write sample import plan from exact source/package hashes. Destination must be under assets; collisions require explicit fail, rename, or replace policy and the existing tree receives an exact fingerprint.",
			inputSchema: z
				.object({
					sampleId: z.string().regex(/^[a-f0-9]{32}$/),
					expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
					expectedPackageFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.optional(),
					targetPath: z.string().min(1).max(1024).optional(),
					collision: z.enum(["fail", "rename", "replace"]).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("plan_project_package_sample_import", args)
	);
	server.registerTool(
		"apply_project_package_sample_import",
		{
			title: "Apply project package sample import",
			description:
				"Apply one exact sample plan through a contained staging directory and atomic publish. Requires confirmation and the exact source hash; stale sources/targets reject, and replacement restores the previous destination on failure.",
			inputSchema: z.object({ planId: z.string().uuid(), expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_project_package_sample_import", args)
	);
	server.registerTool(
		"set_project_development_package_technical_name",
		{
			title: "Set development package technical name",
			description:
				"Atomically replace the active development package's complete npm technical name in package.json. Requires the exact package fingerprint, manifest SHA-256, prior name, and confirm:true; rejects dependency-name conflicts and verifies the postcondition.",
			inputSchema: z
				.object({
					technicalName: projectPackageName,
					expectedTechnicalName: projectPackageName.nullable(),
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					expectedManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_development_package_technical_name", args)
	);
	server.registerTool(
		"modify_project_package",
		{
			title: "Modify one project package",
			description:
				"Compatibility convenience for one exact install, update, or removal. Internally creates and applies the same fingerprinted transaction with exact package/lock rollback. Registry installs/updates require an exact version; confirm:true and the current fingerprint are required.",
			inputSchema: z
				.object({
					operation: z.enum(["install", "remove", "update"]),
					name: projectPackageName,
					version: z.string().min(1).max(512).optional(),
					dependencyType: projectPackageDependencyType.optional(),
					source: projectPackageSource.optional(),
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					allowWorkspaceRoot: z.boolean().optional(),
					allowScripts: z.boolean().optional(),
					timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
					maximumOutputBytes: z.number().int().min(16_384).max(4_194_304).optional(),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("modify_project_package", args)
	);
	server.registerTool(
		"list_installed_external_editors",
		{
			title: "List installed external editors",
			description: "Detect supported installed graphical code editors without launching them. Use a returned command with set_project_preferences.externalEditorCommand.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_installed_external_editors", {})
	);
	server.registerTool(
		"get_project_preferences",
		{
			title: "Get project preferences",
			description: "Get persisted package-manager, plugin, and compressed-texture settings for the active project.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_preferences", {})
	);
	server.registerTool(
		"set_project_preferences",
		{
			title: "Set project preferences",
			description: "Persist project plugin, package-manager, and compressed-texture settings through the editor's project save configuration pipeline.",
			inputSchema: z
				.object({
					preferences: z
						.object({
							plugins: z.array(z.string().min(1).max(1024)).max(128).optional(),
							packageManager: z.enum(["npm", "yarn", "pnpm", "bun"]).optional(),
							compressedTextureSoftware: z.enum(["PVRTexTool", "Khronos KTX-Software"]).optional(),
							compressedTexturesEnabled: z.boolean().optional(),
							compressedTexturesEnabledInPreview: z.boolean().optional(),
							compressedEtc2Enabled: z.boolean().optional(),
							compressedPvrtcEnabled: z.boolean().optional(),
							compressedTextureQuality: z.enum(["very-fast", "fast", "normal", "high"]).optional(),
							externalEditorCommand: z.string().min(1).max(1024).optional(),
						})
						.strict()
						.refine((value) => Object.keys(value).length > 0, { message: "At least one project preference is required." }),
				})
				.strict(),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_preferences", args)
	);
	const identitySettings = z
		.object({
			companyName: z.string().min(1).max(128).optional(),
			productName: z.string().min(1).max(128).optional(),
			version: z
				.string()
				.regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
				.max(64)
				.optional(),
			applicationId: z
				.string()
				.regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/)
				.max(255)
				.optional(),
		})
		.strict();
	const displaySettings = z
		.object({
			defaultWidth: z.number().int().min(1).max(16384).optional(),
			defaultHeight: z.number().int().min(1).max(16384).optional(),
			fullscreenMode: z.enum(["windowed", "fullscreen", "borderless"]).optional(),
			resizableWindow: z.boolean().optional(),
			runInBackground: z.boolean().optional(),
			allowHighDpi: z.boolean().optional(),
		})
		.strict();
	const renderingSettings = z
		.object({
			colorSpace: z.enum(["gamma", "linear"]).optional(),
			renderingBackend: z.enum(["auto", "webgl2", "webgpu"]).optional(),
			powerPreference: z.enum(["default", "high-performance", "low-power"]).optional(),
			targetFrameRate: z
				.number()
				.int()
				.min(-1)
				.max(1000)
				.refine((value) => value === -1 || value > 0)
				.optional(),
			maximumDevicePixelRatio: z.number().finite().min(0.25).max(8).optional(),
			preserveDrawingBuffer: z.boolean().optional(),
		})
		.strict();
	const runtimeSettings = z
		.object({
			showBabylonLoadingScreen: z.boolean().optional(),
			disableContextMenu: z.boolean().optional(),
			dataCaching: z.boolean().optional(),
			deterministicLockstep: z.boolean().optional(),
			lockstepMaxSteps: z.number().int().min(1).max(64).optional(),
		})
		.strict();
	const platformSettings = z.object({ display: displaySettings.optional(), rendering: renderingSettings.optional(), runtime: runtimeSettings.optional() }).strict();
	const importAcceleratorSettings = z
		.object({
			enabled: z.boolean().optional(),
			endpoint: z.string().url().max(2048).optional(),
			namespacePrefix: z
				.string()
				.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
				.optional(),
			downloadEnabled: z.boolean().optional(),
			uploadEnabled: z.boolean().optional(),
			authenticationEnvironmentVariable: z
				.string()
				.max(128)
				.refine((value) => value === "" || /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value), "Must be empty or a valid environment-variable name.")
				.optional(),
			contentValidation: z.enum(["disabled", "uploadOnly", "enabled", "required"]).optional(),
			downloadBatchSize: z.number().int().min(1).max(32).optional(),
			requestTimeoutMilliseconds: z.number().int().min(1000).max(300000).optional(),
			maximumResultSizeBytes: z.number().int().min(1_048_576).max(2_147_483_648).optional(),
		})
		.strict();
	const projectSettingsPatch = z
		.object({
			identity: identitySettings.optional(),
			display: displaySettings.optional(),
			rendering: renderingSettings.optional(),
			runtime: runtimeSettings.optional(),
			assetPipeline: z
				.object({
					autoRefresh: z.boolean().optional(),
					autoRefreshOnFocus: z.boolean().optional(),
					directoryMonitoring: z.boolean().optional(),
					importWorkerCount: z.number().int().min(1).max(32).optional(),
					serializationMode: z.enum(["forceText", "mixed", "forceBinary"]).optional(),
					reduceVersionControlNoise: z.boolean().optional(),
					accelerator: importAcceleratorSettings.optional(),
				})
				.strict()
				.optional(),
			playMode: z
				.object({ reloadScene: z.boolean().optional(), reloadScripts: z.boolean().optional(), muteAudio: z.boolean().optional(), maximizeOnPlay: z.boolean().optional() })
				.strict()
				.optional(),
			defaultBehaviorMode: z.enum(["2d", "3d"]).optional(),
			platformOverrides: z
				.object({
					web: platformSettings.optional(),
					electron: platformSettings.optional(),
					headless: platformSettings.optional(),
					android: platformSettings.optional(),
					ios: platformSettings.optional(),
				})
				.strict()
				.optional(),
		})
		.strict()
		.refine((value) => Object.keys(value).length > 0, { message: "At least one Project Settings field is required." });
	const editorPreferencesPatch = z
		.object({
			appearance: z
				.object({ theme: z.enum(["system", "light", "dark"]).optional(), uiScale: z.number().finite().min(0.5).max(2).optional() })
				.strict()
				.optional(),
			workflow: z
				.object({
					autoSave: z.boolean().optional(),
					autoSaveIntervalMinutes: z.number().int().min(1).max(120).optional(),
					confirmDestructiveActions: z.boolean().optional(),
				})
				.strict()
				.optional(),
			externalTools: z
				.object({
					scriptEditorCommand: z.string().max(1024).optional(),
					imageEditorCommand: z.string().max(1024).optional(),
					diffToolCommand: z.string().max(1024).optional(),
				})
				.strict()
				.optional(),
			diagnostics: z
				.object({ logLevel: z.enum(["error", "warning", "info", "verbose"]).optional() })
				.strict()
				.optional(),
		})
		.strict()
		.refine((value) => Object.keys(value).length > 0, { message: "At least one Editor Preferences field is required." });
	server.registerTool(
		"get_project_settings",
		{
			title: "Get Project Settings",
			description:
				"Read versioned Unity-style common Player, display, rendering, runtime, asset-pipeline, serialization, play-mode, default-behavior, and per-target override settings with exact revision and resolved target views.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_settings", {})
	);
	server.registerTool(
		"set_project_settings",
		{
			title: "Set Project Settings",
			description:
				"Atomically patch validated common Player/Editor settings and bounded web, desktop, headless, Android, or iOS overrides at the exact current revision. Persists through the project configuration pipeline and reports live versus restart-required settings.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), settings: projectSettingsPatch }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_settings", args)
	);
	server.registerTool(
		"reset_project_settings",
		{
			title: "Reset Project Settings",
			description: "Restore safe Zvibe Player/Editor defaults under the exact current revision while preserving the project product name and unrelated project data.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_project_settings", args)
	);
	server.registerTool(
		"get_editor_preferences",
		{
			title: "Get Editor Preferences",
			description: "Read user-scoped theme, UI scale, autosave, confirmation, external-tool, and diagnostics preferences with an exact revision.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_editor_preferences", {})
	);
	server.registerTool(
		"set_editor_preferences",
		{
			title: "Set Editor Preferences",
			description:
				"Atomically patch user-scoped appearance, autosave/workflow, external tools, or diagnostic verbosity at the exact current revision and apply live-safe values immediately.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), preferences: editorPreferencesPatch }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_editor_preferences", args)
	);
	server.registerTool(
		"reset_editor_preferences",
		{
			title: "Reset Editor Preferences",
			description: "Restore user-scoped editor defaults under the exact current revision without changing project-owned Player Settings.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_editor_preferences", args)
	);
	server.registerTool(
		"list_project_templates",
		{ title: "List project templates", description: "List the editor's available project templates.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_project_templates", {})
	);
	server.registerTool(
		"open_project_file_in_external_editor",
		{
			title: "Open project file in external editor",
			description: "Open a supported source file inside the active project with the configured external editor command.",
			inputSchema: z.object({ path: z.string().describe("Project-relative source-file path such as src/scripts.ts.") }),
		},
		async (args): Promise<CallToolResult> => callTextTool("open_project_file_in_external_editor", args)
	);
}
