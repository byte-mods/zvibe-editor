import { AnimationEvent } from "@babylonjs/core/Animations/animationEvent";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Scene } from "@babylonjs/core/scene";

function resolveGroup(scene: Scene, name: string): AnimationGroup | null {
	return scene.getAnimationGroupByName(name);
}

function executeEvent(scene: Scene, groupName: string, event: any): void {
	const log = (scene.metadata.babylonEditorAnimationEventLog ??= []);
	log.push({ groupName, frame: event.frame, action: event.action, parameter: event.parameter ?? null });
	if (log.length > 128) log.splice(0, log.length - 128);
	if (event.action === "setEnabled") {
		const node = event.nodeId ? scene.getNodeById(event.nodeId) : scene.getNodeByName(event.nodeName);
		node?.setEnabled(event.enabled ?? true);
	} else if (event.action === "playAnimationGroup") {
		resolveGroup(scene, event.animationGroupName)?.play(event.loop ?? true);
	} else if (event.action === "stopAnimationGroup") {
		resolveGroup(scene, event.animationGroupName)?.stop();
	}
}

/** Installs persisted editor-authored AnimationEvent callbacks in an exported game scene. */
export function configureAnimationEvents(scene: Scene): void {
	const configurations = scene.metadata?.babylonEditorAnimationEvents;
	if (!Array.isArray(configurations)) return;
	for (const configuration of configurations) {
		const group = resolveGroup(scene, configuration.groupName);
		const animation = group?.targetedAnimations[0]?.animation;
		if (!group || !animation) continue;
		for (const frame of new Set(animation.getEvents().map((event) => event.frame))) animation.removeEvents(frame);
		for (const event of configuration.events ?? []) animation.addEvent(new AnimationEvent(event.frame, () => executeEvent(scene, group.name, event), event.onlyOnce ?? false));
	}
}
