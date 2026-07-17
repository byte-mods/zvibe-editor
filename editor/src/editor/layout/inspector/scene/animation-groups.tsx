import { Reorder } from "framer-motion";

import { MouseEvent, useEffect, useState } from "react";

import { IoPlay, IoStop } from "react-icons/io5";
import { AiFillMerge, AiOutlineClose, AiOutlineMinus } from "react-icons/ai";

import { Scene, AnimationGroup } from "babylonjs";

import { Editor } from "../../../main";

import { showPrompt } from "../../../../ui/dialog";
import { Button } from "../../../../ui/shadcn/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../../../ui/shadcn/ui/context-menu";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { listAnimationEvents, setAnimationEvents } from "../../../../mcp/animations/animations";

import { EditorInspectorSectionField } from "../fields/section";

export interface IEditorSceneAnimationGroupsInspectorProps {
	scene: Scene;
	editor: Editor;
}

export function EditorSceneAnimationGroupsInspector(props: IEditorSceneAnimationGroupsInspectorProps) {
	const [animationGroupsSearch, setAnimationGroupsSearch] = useState<string>("");
	const [selectedAnimationGroups, setSelectedAnimationGroups] = useState<AnimationGroup[]>([]);

	const [animationGroups, setAnimationGroups] = useState<AnimationGroup[]>([]);
	const [playingAnimationGroups, setPlayingAnimationGroups] = useState<AnimationGroup[]>([]);
	const [, setAnimationEventsVersion] = useState(0);

	useEffect(() => {
		setAnimationGroups(props.scene.animationGroups);
		setPlayingAnimationGroups(props.scene.animationGroups.filter((animationGroup) => animationGroup.isPlaying));
	}, [props.scene]);

	function handleAnimationGroupClick(ev: MouseEvent<HTMLDivElement>, animationGroup: AnimationGroup) {
		if (ev.ctrlKey || ev.metaKey) {
			const newSelectedAnimationGroups = selectedAnimationGroups.slice();
			if (newSelectedAnimationGroups.includes(animationGroup)) {
				const index = newSelectedAnimationGroups.indexOf(animationGroup);
				if (index !== -1) {
					newSelectedAnimationGroups.splice(index, 1);
				}
			} else {
				newSelectedAnimationGroups.push(animationGroup);
			}

			setSelectedAnimationGroups(newSelectedAnimationGroups);
		} else if (ev.shiftKey) {
			const newSelectedAnimationGroups = selectedAnimationGroups.slice();
			const lastSelectedAnimationGroup = newSelectedAnimationGroups[newSelectedAnimationGroups.length - 1];
			if (!lastSelectedAnimationGroup) {
				return setSelectedAnimationGroups([animationGroup]);
			}

			const lastIndex = props.scene.animationGroups.indexOf(lastSelectedAnimationGroup);
			const currentIndex = props.scene.animationGroups.indexOf(animationGroup);

			const [start, end] = lastIndex < currentIndex ? [lastIndex, currentIndex] : [currentIndex, lastIndex];

			for (let i = start; i <= end; i++) {
				const ag = props.scene.animationGroups[i];
				if (!newSelectedAnimationGroups.includes(ag)) {
					newSelectedAnimationGroups.push(ag);
				}
			}

			setSelectedAnimationGroups(newSelectedAnimationGroups);
		} else {
			setSelectedAnimationGroups([animationGroup]);
		}
	}

	function handlePlayOrStopAnimationGroup(animationGroup: AnimationGroup) {
		if (animationGroup.isPlaying) {
			animationGroup.stop();
			setPlayingAnimationGroups(playingAnimationGroups.filter((ag) => ag !== animationGroup));
		} else {
			animationGroup.play(true);
			setPlayingAnimationGroups([...playingAnimationGroups, animationGroup]);
		}
	}

	function handlePlaySelectedAnimationGroups() {
		props.scene.animationGroups.forEach((animationGroup) => {
			animationGroup.stop();
		});

		selectedAnimationGroups.forEach((animationGroup) => {
			animationGroup.play(true);
		});

		setPlayingAnimationGroups(props.scene.animationGroups.filter((animationGroup) => animationGroup.isPlaying));
	}

	function handleRemoveSelectedAnimationGroups() {
		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				selectedAnimationGroups.forEach((animationGroup) => {
					props.scene.addAnimationGroup(animationGroup);
				});
			},
			redo: () => {
				selectedAnimationGroups.forEach((animationGroup) => {
					props.scene.removeAnimationGroup(animationGroup);
				});
			},
		});

		setAnimationGroups(props.scene.animationGroups.slice());
	}

	async function handleMergeSelectedAnimationGroups() {
		const name = await showPrompt("Merge Animation Groups", "Enter a name for the merged animation group", "Merged Animation Group");
		if (!name) {
			return;
		}

		const animationGroup = new AnimationGroup(name, props.scene);

		selectedAnimationGroups.forEach((ag) => {
			ag.targetedAnimations.forEach((targetedAnimation) => {
				animationGroup.addTargetedAnimation(targetedAnimation.animation, targetedAnimation.target);
			});
		});

		setSelectedAnimationGroups([animationGroup]);
		setAnimationGroups(props.scene.animationGroups.slice());
	}

	async function handleAddAnimationEvent(animationGroup: AnimationGroup, action: "log" | "setEnabled" | "playAnimationGroup" | "stopAnimationGroup") {
		const value = await showPrompt("Add Animation Event", "Frame at which this animation event runs", String(animationGroup.from));
		if (value === null) {
			return;
		}
		const frame = Number(value);
		if (!Number.isFinite(frame)) {
			return;
		}
		const existing = listAnimationEvents(props.scene, { name: animationGroup.name }).groups[0]?.events ?? [];
		const event: any = { frame, action };
		if (action === "setEnabled") {
			const nodeName = await showPrompt("Animation Event Target", "Exact scene node name to enable/disable", props.scene.rootNodes[0]?.name ?? "");
			if (!nodeName) {
				return;
			}
			const enabled = await showPrompt("Animation Event Enabled", "Enter true to enable or false to disable the target node", "true");
			if (enabled === null || !["true", "false"].includes(enabled.toLowerCase())) {
				return;
			}
			event.nodeName = nodeName;
			event.enabled = enabled.toLowerCase() === "true";
		}
		if (action === "playAnimationGroup" || action === "stopAnimationGroup") {
			const animationGroupName = await showPrompt(
				"Animation Event Clip",
				"Exact Animation Group name to play or stop",
				props.scene.animationGroups.find((group) => group !== animationGroup)?.name ?? ""
			);
			if (!animationGroupName) {
				return;
			}
			event.animationGroupName = animationGroupName;
			if (action === "playAnimationGroup") {
				event.loop = true;
			}
		}
		setAnimationEvents(props.scene, { name: animationGroup.name, events: [...existing, event] }, { editor: props.editor });
		setAnimationEventsVersion((version) => version + 1);
	}

	function handleClearAnimationEvents(animationGroup: AnimationGroup) {
		setAnimationEvents(props.scene, { name: animationGroup.name, events: [] }, { editor: props.editor });
		setAnimationEventsVersion((version) => version + 1);
	}

	function handleUpdateAnimationEvent(animationGroup: AnimationGroup, eventIndex: number, update: Record<string, any>) {
		const events = listAnimationEvents(props.scene, { name: animationGroup.name }).groups[0]?.events ?? [];
		setAnimationEvents(
			props.scene,
			{ name: animationGroup.name, events: events.map((event: any, index: number) => (index === eventIndex ? { ...event, ...update } : event)) },
			{ editor: props.editor }
		);
		setAnimationEventsVersion((version) => version + 1);
	}

	function handleRemoveAnimationEvent(animationGroup: AnimationGroup, eventIndex: number) {
		const events = listAnimationEvents(props.scene, { name: animationGroup.name }).groups[0]?.events ?? [];
		setAnimationEvents(props.scene, { name: animationGroup.name, events: events.filter((_event: any, index: number) => index !== eventIndex) }, { editor: props.editor });
		setAnimationEventsVersion((version) => version + 1);
	}

	async function handleChangeAnimationEventAction(
		animationGroup: AnimationGroup,
		eventIndex: number,
		action: "log" | "setEnabled" | "playAnimationGroup" | "stopAnimationGroup"
	) {
		const events = listAnimationEvents(props.scene, { name: animationGroup.name }).groups[0]?.events ?? [];
		const current = events[eventIndex];
		if (!current || current.action === action) {
			return;
		}
		const update: any = { action };
		if (action === "setEnabled" && !current.nodeId && !current.nodeName) {
			const nodeName = await showPrompt("Animation Event Target", "Exact scene node name to enable or disable", props.scene.rootNodes[0]?.name ?? "");
			if (!nodeName) {
				return;
			}
			update.nodeName = nodeName;
			update.enabled = true;
		}
		if ((action === "playAnimationGroup" || action === "stopAnimationGroup") && !current.animationGroupName) {
			const animationGroupName = await showPrompt(
				"Animation Event Clip",
				"Exact Animation Group name to play or stop",
				props.scene.animationGroups.find((group) => group !== animationGroup)?.name ?? ""
			);
			if (!animationGroupName) {
				return;
			}
			update.animationGroupName = animationGroupName;
		}
		if (action === "playAnimationGroup") {
			update.loop = current.loop ?? true;
		}
		handleUpdateAnimationEvent(animationGroup, eventIndex, update);
	}

	async function handleChangeAnimationEventTarget(animationGroup: AnimationGroup, eventIndex: number) {
		const events = listAnimationEvents(props.scene, { name: animationGroup.name }).groups[0]?.events ?? [];
		const nodeName = await showPrompt("Animation Event Target", "Exact scene node name to enable or disable", events[eventIndex]?.nodeName ?? "");
		if (!nodeName) {
			return;
		}
		handleUpdateAnimationEvent(animationGroup, eventIndex, { nodeName, nodeId: undefined });
	}

	async function handleChangeAnimationEventClip(animationGroup: AnimationGroup, eventIndex: number) {
		const events = listAnimationEvents(props.scene, { name: animationGroup.name }).groups[0]?.events ?? [];
		const animationGroupName = await showPrompt("Animation Event Clip", "Exact Animation Group name to play or stop", events[eventIndex]?.animationGroupName ?? "");
		if (!animationGroupName) {
			return;
		}
		handleUpdateAnimationEvent(animationGroup, eventIndex, { animationGroupName });
	}

	const hasAnimations = animationGroups.length > 0;
	const animations = animationGroups.filter((animationGroup) => (animationGroup.name ?? "").toLowerCase().includes(animationGroupsSearch.toLowerCase()));
	const selectedAnimationGroup = selectedAnimationGroups.length === 1 ? selectedAnimationGroups[0] : null;
	const selectedAnimationEvents = selectedAnimationGroup ? (listAnimationEvents(props.scene, { name: selectedAnimationGroup.name }).groups[0]?.events ?? []) : [];

	return (
		<EditorInspectorSectionField title="Animation Groups">
			{!hasAnimations && <div className="text-center text-xl">No animation groups</div>}

			{hasAnimations && (
				<>
					<input
						type="text"
						placeholder="Search..."
						value={animationGroupsSearch}
						onChange={(e) => setAnimationGroupsSearch(e.currentTarget.value)}
						className="px-5 py-2 rounded-lg bg-input outline-none w-full"
					/>

					<div className="flex justify-between items-center">
						<div className="p-2 font-bold">Actions</div>

						<div className="flex gap-2">
							<Button variant="ghost" disabled={selectedAnimationGroups.length === 0} className="p-1 w-8 h-8" onClick={() => handleRemoveSelectedAnimationGroups()}>
								<AiOutlineMinus className="w-6 h-6" />
							</Button>

							<Button variant="ghost" className="p-1 w-8 h-8" onClick={() => handlePlaySelectedAnimationGroups()}>
								<IoPlay className="w-6 h-6" />
							</Button>
						</div>
					</div>

					<Reorder.Group
						axis="y"
						values={props.scene.animationGroups}
						onReorder={(items) => {
							setAnimationGroups(items);
							props.scene.animationGroups = items;
						}}
						className="flex flex-col rounded-lg bg-black/50 text-white/75 h-96 overflow-y-auto"
					>
						{animations.map((animationGroup) => (
							<Reorder.Item key={animationGroup.uniqueId} value={animationGroup} id={`animation-group-${animationGroup.uniqueId}`}>
								<ContextMenu>
									<ContextMenuTrigger>
										<div
											onClick={(ev) => handleAnimationGroupClick(ev, animationGroup)}
											className={`
                                        flex items-center gap-2
                                        ${selectedAnimationGroups.includes(animationGroup) ? "bg-muted" : "hover:bg-muted/35"}
                                        transition-all duration-300 ease-in-out
                                    `}
										>
											<Button variant="ghost" className="w-8 h-8 p-1" onClick={() => handlePlayOrStopAnimationGroup(animationGroup)}>
												{animationGroup.isPlaying ? <IoStop className="w-6 h-6" strokeWidth={1} /> : <IoPlay className="w-6 h-6" strokeWidth={1} />}
											</Button>
											{animationGroup.name}
										</div>
									</ContextMenuTrigger>
									<ContextMenuContent>
										<ContextMenuItem onClick={() => handleAddAnimationEvent(animationGroup, "log")}>Add Log Event...</ContextMenuItem>
										<ContextMenuItem onClick={() => handleAddAnimationEvent(animationGroup, "setEnabled")}>Add Enable/Disable Event...</ContextMenuItem>
										<ContextMenuItem onClick={() => handleAddAnimationEvent(animationGroup, "playAnimationGroup")}>Add Play Clip Event...</ContextMenuItem>
										<ContextMenuItem onClick={() => handleAddAnimationEvent(animationGroup, "stopAnimationGroup")}>Add Stop Clip Event...</ContextMenuItem>
										<ContextMenuItem
											onClick={() => handleClearAnimationEvents(animationGroup)}
											disabled={!listAnimationEvents(props.scene, { name: animationGroup.name }).groups[0]?.events.length}
										>
											Clear Animation Events ({listAnimationEvents(props.scene, { name: animationGroup.name }).groups[0]?.events.length ?? 0})
										</ContextMenuItem>
										<ContextMenuSeparator />
										<ContextMenuItem className="flex items-center gap-2" onClick={handleMergeSelectedAnimationGroups}>
											<AiFillMerge className="w-5 h-5" /> Merge...
										</ContextMenuItem>
										<ContextMenuSeparator />
										<ContextMenuItem className="flex items-center gap-2 !text-red-400" onClick={handleRemoveSelectedAnimationGroups}>
											<AiOutlineClose className="w-5 h-5" fill="rgb(248, 113, 113)" /> Remove
										</ContextMenuItem>
									</ContextMenuContent>
								</ContextMenu>
							</Reorder.Item>
						))}
					</Reorder.Group>

					{selectedAnimationGroup && (
						<div className="flex flex-col gap-2 rounded-lg bg-black/30 p-2">
							<div className="font-bold">Animation Events — {selectedAnimationGroup.name}</div>
							{selectedAnimationEvents.length === 0 && (
								<div className="text-sm text-white/60">No frame events. Use the animation group's context menu to add one.</div>
							)}
							{selectedAnimationEvents.map((event: any, eventIndex: number) => (
								<div key={`${eventIndex}-${event.frame}-${event.action}`} className="flex flex-col gap-2 rounded bg-input p-2">
									<div className="grid grid-cols-[72px_1fr_auto] gap-2 items-center">
										<input
											type="number"
											aria-label={`Animation event ${eventIndex + 1} frame`}
											value={event.frame}
											onChange={(ev) => {
												const frame = Number(ev.currentTarget.value);
												if (Number.isFinite(frame)) {
													handleUpdateAnimationEvent(selectedAnimationGroup, eventIndex, { frame });
												}
											}}
											className="min-w-0 rounded bg-background px-2 py-1"
										/>
										<select
											aria-label={`Animation event ${eventIndex + 1} action`}
											value={event.action}
											onChange={(ev) => void handleChangeAnimationEventAction(selectedAnimationGroup, eventIndex, ev.currentTarget.value as any)}
											className="min-w-0 rounded bg-background px-2 py-1"
										>
											<option value="log">Log</option>
											<option value="setEnabled">Enable / Disable Node</option>
											<option value="playAnimationGroup">Play Animation Group</option>
											<option value="stopAnimationGroup">Stop Animation Group</option>
										</select>
										<Button variant="ghost" className="h-7 px-2 !text-red-400" onClick={() => handleRemoveAnimationEvent(selectedAnimationGroup, eventIndex)}>
											Remove
										</Button>
									</div>
									{event.action === "setEnabled" && (
										<div className="flex items-center justify-between gap-2 text-sm text-white/70">
											<Button
												variant="ghost"
												className="h-7 min-w-0 truncate px-2"
												onClick={() => void handleChangeAnimationEventTarget(selectedAnimationGroup, eventIndex)}
											>
												Target: {event.nodeName ?? event.nodeId}
											</Button>
											<label className="flex items-center gap-1 whitespace-nowrap">
												<input
													type="checkbox"
													checked={event.enabled ?? true}
													onChange={(ev) => handleUpdateAnimationEvent(selectedAnimationGroup, eventIndex, { enabled: ev.currentTarget.checked })}
												/>
												Enabled
											</label>
										</div>
									)}
									{(event.action === "playAnimationGroup" || event.action === "stopAnimationGroup") && (
										<div className="flex items-center justify-between gap-2 text-sm text-white/70">
											<Button
												variant="ghost"
												className="h-7 min-w-0 truncate px-2"
												onClick={() => void handleChangeAnimationEventClip(selectedAnimationGroup, eventIndex)}
											>
												Clip: {event.animationGroupName}
											</Button>
											{event.action === "playAnimationGroup" && (
												<label className="flex items-center gap-1 whitespace-nowrap">
													<input
														type="checkbox"
														checked={event.loop ?? true}
														onChange={(ev) => handleUpdateAnimationEvent(selectedAnimationGroup, eventIndex, { loop: ev.currentTarget.checked })}
													/>
													Loop
												</label>
											)}
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</>
			)}
		</EditorInspectorSectionField>
	);
}
