import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

/** Starts saved editor navigation-agent path followers in generated projects. */
export function configureNavAgents(scene: Scene): void {
	const agents = scene.metadata?.babylonEditorNavAgents;
	if (!Array.isArray(agents)) return;
	scene.onBeforeRenderObservable.add(() => {
		const deltaSeconds = Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
		if (!deltaSeconds) return;
		for (const agent of agents) {
			if (!agent.isMoving || !agent.path?.length) continue;
			const node = scene.getNodeById(agent.nodeId);
			if (!(node instanceof TransformNode)) {
				agent.isMoving = false;
				continue;
			}
			const target = Vector3.FromArray(agent.path[agent.pathIndex ?? 0]);
			const delta = target.subtract(node.position);
			const distance = delta.length();
			const travel = (agent.maxSpeed ?? 6) * 100 * deltaSeconds;
			if (distance <= travel || distance < 0.001) {
				node.position.copyFrom(target);
				agent.pathIndex = (agent.pathIndex ?? 0) + 1;
				if (agent.pathIndex >= agent.path.length) agent.isMoving = false;
			} else {
				const avoidance = Vector3.Zero();
				for (const other of agents) {
					if (other === agent || other.avoidanceEnabled === false) continue;
					const otherNode = scene.getNodeById(other.nodeId);
					if (!(otherNode instanceof TransformNode)) continue;
					const fromOther = node.position.subtract(otherNode.position);
					const otherDistance = fromOther.length();
					const range = Math.max(0.001, (agent.avoidanceRadius ?? agent.radius ?? 1) + (other.avoidanceRadius ?? other.radius ?? 1));
					if (otherDistance >= range) continue;
					if (otherDistance < 0.0001) fromOther.copyFromFloats(agent.id < other.id ? 1 : -1, 0, 0);
					else fromOther.scaleInPlace(1 / otherDistance);
					avoidance.addInPlace(fromOther.scale((1 - otherDistance / range) * (agent.avoidanceWeight ?? 1)));
				}
				const direction = delta.scale(1 / distance).add(avoidance);
				node.position.addInPlace(direction.lengthSquared() > 0.000001 ? direction.normalize().scale(travel) : delta.scale(travel / distance));
			}
		}
	});
}
