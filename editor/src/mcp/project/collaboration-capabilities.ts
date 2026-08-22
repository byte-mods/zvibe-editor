import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { getProjectCollaborationStatus, listProjectCollaborationMembers, listProjectCollaborationPresence } from "./collaboration";
import { getRemoteCollaborationDiscovery } from "./collaboration-discovery";
import { getRemoteCollaborationRelay } from "./collaboration-relay";
import { getProjectAssetLockFederation, getRemoteCollaborationGateway } from "./remote-collaboration";
import { readProjectSemanticMergeRules } from "./semantic-merge-rules";

const contractVersion = 1;

const capabilities = [
	{
		id: "identity-and-roles",
		state: "complete",
		behaviors: ["hashed one-time member credentials", "admin/editor/viewer authorization", "expiring sessions", "credential rotation", "central viewer read-only enforcement"],
		tools: ["configure_project_collaboration", "create_project_collaboration_member", "join_project_collaboration_session", "heartbeat_project_collaboration_session"],
	},
	{
		id: "presence",
		state: "complete",
		behaviors: ["selection and hover", "multi-viewport pointers", "world rays and positions", "tool mode", "camera pose", "bounded heartbeats"],
		tools: ["list_project_collaboration_presence", "heartbeat_project_collaboration_session"],
	},
	{
		id: "scene-coauthoring",
		state: "complete",
		behaviors: ["compare-and-swap transforms", "node edits", "hierarchy edits", "node properties", "idempotent operation replay", "stale revision rejection"],
		tools: ["apply_collaborative_node_transform", "apply_collaborative_node_edit", "apply_collaborative_hierarchy_edit", "apply_collaborative_node_properties"],
	},
	{
		id: "text-and-ordered-data",
		state: "complete",
		behaviors: ["RGA-style UTF-8 text operations", "stable-id ordered JSON collection operations", "rebase", "bounded operation history", "exact source hashes"],
		tools: ["apply_collaborative_text_operations", "apply_collaborative_ordered_collection_operations"],
	},
	{
		id: "semantic-conflict-resolution",
		state: "complete",
		behaviors: [
			"recursive three-way JSON merge",
			"independent edit auto-merge",
			"stable-identity array merge",
			"per-path conflicts",
			"exact manual resolutions",
			"project merge rules",
			"atomic guarded writes",
		],
		tools: ["compare_project_scene_assets", "merge_project_scene_assets", "list_project_semantic_merge_rules"],
	},
	{
		id: "asset-coordination",
		state: "complete",
		behaviors: ["expiring project-local locks", "authenticated lock federation", "smart-lock rules", "Git freshness guards", "admin force release"],
		tools: ["list_project_asset_locks", "acquire_project_asset_lock", "inspect_project_asset_lock_policy", "get_project_asset_lock_federation"],
	},
	{
		id: "remote-collaboration",
		state: "complete",
		behaviors: ["HTTP/HTTPS gateway", "bounded SSE journal", "TLS", "LAN discovery", "outbound WSS relay", "host/origin allowlists", "authenticated operations"],
		tools: ["get_remote_collaboration_gateway", "get_remote_collaboration_discovery", "get_remote_collaboration_relay", "list_remote_collaboration_events"],
	},
	{
		id: "change-and-review-workflows",
		state: "complete",
		behaviors: ["changelists", "Git branches and commits", "hosted review adapters", "prefab reviews", "revision-bound decisions", "merge checks"],
		tools: ["list_project_changelists", "list_project_source_control_reviews", "list_prefab_reviews"],
	},
] as const;

function issue(code: string, severity: "info" | "warning" | "error", message: string, remediation: string | null): any {
	return { code, severity, message, remediation };
}

async function capture<T>(operation: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
	try {
		return { value: await operation(), error: null };
	} catch (error) {
		return { value: null, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Returns the exact supported collaboration contract without claiming automatic resolution for inherently ambiguous conflicts. */
export async function getProjectCollaborationCapabilities(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const status = await getProjectCollaborationStatus(scene, data, options);
	return {
		contractVersion,
		parityTarget: "Unity 6.5 collaboration, version control, Smart Locks, and Smart Merge behavior",
		capabilities,
		conflictPolicy: {
			automatic: "Independent recursive object, file, and stable-identity collection changes are merged automatically.",
			ambiguous: "Same-path incompatible edits remain explicit conflicts until an exact resolution or matching project rule is supplied.",
			binary: "Binary and unsupported assets use locks and manual/source-control workflows instead of unsafe synthesized merges.",
			supportedSemanticAssets: ["scene directories containing bounded JSON documents", ".prefab JSON assets"],
		},
		boundaries: [
			"No system can safely infer intent for every arbitrary same-property conflict; unresolved conflicts are preserved.",
			"The relay and hosted-review adapters are provider-neutral and do not claim Unity service or protocol identity.",
			"Machine-local credentials and relay tokens are never returned by capability or readiness inspection.",
		],
		project: status,
	};
}

/** Audits the current project's local, authenticated, conflict-resolution, and remote collaboration readiness. */
export async function validateProjectCollaborationReadiness(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const status = await getProjectCollaborationStatus(scene, data, options);
	const findings: any[] = [];
	const rules = await capture(() => readProjectSemanticMergeRules(options));
	if (rules.error) {
		findings.push(issue("semantic_merge_rules_invalid", "error", rules.error, "Repair .babylon-editor/merge-rules.json, then run this audit again."));
	}

	const authenticated = status.enforcementEnabled && status.actor !== null;
	if (!status.enforcementEnabled) {
		findings.push(
			issue(
				"authentication_disabled",
				"warning",
				"Legacy local MCP access is available, but named roles and authenticated sessions are disabled.",
				"Enable project collaboration and create the team members."
			)
		);
	} else if (!authenticated) {
		findings.push(
			issue(
				"session_required",
				"error",
				"Collaboration enforcement is enabled, but no valid active session was supplied.",
				"Join the project collaboration session and retry with its token."
			)
		);
	}

	let members: any = null;
	let presence: any = null;
	let gateway: any = null;
	let relay: any = null;
	let discovery: any = null;
	let federation: any = null;
	if (authenticated) {
		const [memberResult, presenceResult, gatewayResult, relayResult, discoveryResult, federationResult] = await Promise.all([
			capture(() => listProjectCollaborationMembers(scene, data, options)),
			capture(() => listProjectCollaborationPresence(scene, data, options)),
			capture(() => getRemoteCollaborationGateway(scene, data, options)),
			capture(() => getRemoteCollaborationRelay(scene, data, options)),
			capture(() => getRemoteCollaborationDiscovery(scene, data, options)),
			capture(() => getProjectAssetLockFederation(scene, data, options)),
		]);
		members = memberResult.value;
		presence = presenceResult.value;
		gateway = gatewayResult.value;
		relay = relayResult.value;
		discovery = discoveryResult.value;
		federation = federationResult.value;
		for (const [code, result] of [
			["members_unavailable", memberResult],
			["presence_unavailable", presenceResult],
			["gateway_unavailable", gatewayResult],
			["relay_unavailable", relayResult],
			["discovery_unavailable", discoveryResult],
			["lock_federation_unavailable", federationResult],
		] as const) {
			if (result.error) {
				findings.push(issue(code, "error", result.error, "Repair the reported collaboration configuration and run this audit again."));
			}
		}
	}

	const remoteReady = authenticated && (gateway?.running === true || relay?.connected === true);
	if (authenticated && !remoteReady) {
		findings.push(
			issue(
				"remote_transport_inactive",
				"warning",
				"Authenticated local collaboration is ready, but neither the remote gateway nor relay is currently connected.",
				"Start the project gateway or configure and connect the WSS relay for off-machine collaboration."
			)
		);
	}
	if (gateway?.eventHistory?.healthy === false) {
		findings.push(
			issue(
				"event_history_unhealthy",
				"error",
				gateway.eventHistory.error ?? "Remote event history is unhealthy.",
				"Repair or clear the quarantined collaboration event journal."
			)
		);
	}
	if (relay?.config?.enabled === true && relay?.lastError) {
		findings.push(issue("relay_error", "error", relay.lastError, "Correct the relay URL/credential configuration and reconnect."));
	}

	const errorCount = findings.filter((entry) => entry.severity === "error").length;
	const warningCount = findings.filter((entry) => entry.severity === "warning").length;
	return {
		contractVersion,
		overall: errorCount > 0 ? "attention-required" : remoteReady ? "ready" : "setup-required",
		readiness: {
			legacyLocalEditing: true,
			authenticatedLocalEditing: authenticated,
			conflictResolution: rules.error === null,
			remoteEditing: remoteReady,
			readOnlyReview: !status.enforcementEnabled || authenticated,
		},
		project: { ...status, semanticMergeRuleCount: rules.value?.length ?? null },
		team: { members, presence },
		transports: { gateway, relay, discovery, assetLockFederation: federation },
		findings,
		summary: { errorCount, warningCount, findingCount: findings.length },
	};
}
