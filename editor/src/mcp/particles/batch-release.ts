import { createHash } from "crypto";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

import { NodeParticleSystemSetMesh } from "../../editor/nodes/node-particle-system";
import { isNodeParticleSystemSetMesh } from "../../tools/guards/particles";
import { onNodeModifiedObservable } from "../../tools/observables";

function resolveVfxNode(scene: Scene, data: any): NodeParticleSystemSetMesh {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isNodeParticleSystemSetMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Node Particle System Set.`);
	}
	return node;
}

function revision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Reads the exact disable-time VFX batch policy and live allocation evidence. */
export function getNodeParticleBatchRelease(scene: Scene, data: any): Record<string, unknown> {
	const node = resolveVfxNode(scene, data);
	const evidence = node.getVfxBatchReleaseEvidence();
	const result = {
		node: toNodeSummary(node),
		graphId: node.nodeParticleSystemSet?.id ?? null,
		systemCount: node.particleSystemSet?.systems.length ?? 0,
		...evidence,
		boundary: "Portable Babylon Node Particle batch lifecycle; not Unity VFXManager, VFX Graph package/API, GPU batch identity, or binary compatibility.",
	};
	return { ...result, revision: revision(result) };
}

/** Changes the release-on-disable policy under the exact previously inspected state revision. */
export async function setNodeParticleBatchRelease(scene: Scene, data: any, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const node = resolveVfxNode(scene, data);
	const current = getNodeParticleBatchRelease(scene, { nodeId: node.id });
	if (data.expectedRevision !== current.revision) {
		throw new Error("The Node Particle batch lifecycle changed after inspection; inspect it again before changing the policy.");
	}
	const previous = node.releaseVfxBatchOnDisable;
	const next = data.releaseOnDisable === true;
	const evidence = await node.setReleaseVfxBatchOnDisable(next);
	if (evidence.state === "error") {
		const firstError = evidence.lastError ?? "The VFX batch could not be rebuilt.";
		const rollback = await node.setReleaseVfxBatchOnDisable(previous);
		if (rollback.state === "error") {
			throw new Error(`${firstError} Policy rollback also failed: ${rollback.lastError ?? "unknown error"}`);
		}
		throw new Error(firstError);
	}
	onNodeModifiedObservable.notifyObservers(node);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return getNodeParticleBatchRelease(scene, { nodeId: node.id });
}
