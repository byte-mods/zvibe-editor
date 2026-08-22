import { Component, ReactNode } from "react";

import { Animation, IAnimatable } from "babylonjs";

import { isNode } from "../../tools/guards/nodes";
import { isScene } from "../../tools/guards/scene";
import { isDomElementFocusable } from "../../tools/dom";
import { isAnyParticleSystem } from "../../tools/guards/particles";

import { Editor } from "../main";

import { EditorAnimationToolbar } from "./animation/toolbar";
import { EditorAnimationTracksPanel } from "./animation/tracks/tracks";
import { EditorAnimationInspector } from "./animation/inspector/inspector";
import { EditorAnimationTimelinePanel } from "./animation/timeline/timeline";
import { EditorAnimatorPanel } from "./animation/animator";
import { EditorBehaviorTreesPanel } from "./animation/behavior-trees";
import { EditorComputeGraphPanel } from "./animation/compute-graph";
import { EditorVisualScriptingPanel } from "./animation/visual-scripting";
import { EditorAnimationWindowPanel } from "./animation/window";
import { EditorSpriteSkinningPanel } from "./animation/sprite-skinning";

export interface IEditorAnimationProps {
	/**
	 * Defines the reference to the editor.
	 */
	editor: Editor;
}

export interface IEditorAnimationState {
	playing: boolean;
	focused: boolean;
	animatable: IAnimatable | null;
	selectedAnimation: Animation | null;
	mode: "timeline" | "animation-window" | "2d-animation" | "animator" | "behavior-trees" | "compute-graph" | "visual-scripting";
	animationGroupName: string | null;
	animatorControllerId: string | null;
	animatorDebugEnabled: boolean;
}

export class EditorAnimation extends Component<IEditorAnimationProps, IEditorAnimationState> {
	/**
	 * Defines the reference to the inspector used to edit animations properties.
	 */
	public inspector!: EditorAnimationInspector;
	/**
	 * Defines the reference to the tracks panel component used to display the animations tracks.
	 */
	public tracks!: EditorAnimationTracksPanel;
	/**
	 * Defines the reference to the timelines panel component used to display the animations timeline.
	 */
	public timelines!: EditorAnimationTimelinePanel;

	private _playing: boolean = false;
	private _currentTimeBeforePlay: number | null = null;

	private _onKeyUpListener: (event: KeyboardEvent) => void;

	public constructor(props: IEditorAnimationProps) {
		super(props);

		this.state = {
			playing: false,
			focused: false,
			animatable: null,
			selectedAnimation: null,
			mode: "timeline",
			animationGroupName: null,
			animatorControllerId: null,
			animatorDebugEnabled: false,
		};
	}

	public render(): ReactNode {
		return (
			<div className="flex flex-col min-w-full h-full">
				<div className="flex min-h-10 flex-wrap items-center gap-1 border-b border-input bg-input px-2">
					<button
						className={`rounded px-3 py-1 text-sm ${this.state.mode === "behavior-trees" ? "bg-secondary font-medium" : "text-muted-foreground"}`}
						onClick={() => this.setState({ mode: "behavior-trees" })}
					>
						Behavior Trees
					</button>
					<button
						className={`rounded px-3 py-1 text-sm ${this.state.mode === "timeline" ? "bg-secondary font-medium" : "text-muted-foreground"}`}
						onClick={() => this.setState({ mode: "timeline" })}
					>
						Timeline
					</button>
					<button
						className={`rounded px-3 py-1 text-sm ${this.state.mode === "animation-window" ? "bg-secondary font-medium" : "text-muted-foreground"}`}
						onClick={() => this.setState({ mode: "animation-window" })}
					>
						Animation Window
					</button>
					<button
						className={`rounded px-3 py-1 text-sm ${this.state.mode === "2d-animation" ? "bg-secondary font-medium" : "text-muted-foreground"}`}
						onClick={() => this.setState({ mode: "2d-animation" })}
					>
						2D Animation
					</button>
					<button
						className={`rounded px-3 py-1 text-sm ${this.state.mode === "animator" ? "bg-secondary font-medium" : "text-muted-foreground"}`}
						onClick={() => this.setState({ mode: "animator" })}
					>
						Animator
					</button>
					<button
						className={`rounded px-3 py-1 text-sm ${this.state.mode === "visual-scripting" ? "bg-secondary font-medium" : "text-muted-foreground"}`}
						onClick={() => this.setState({ mode: "visual-scripting" })}
					>
						Visual Scripting
					</button>
					<button
						className={`rounded px-3 py-1 text-sm ${this.state.mode === "compute-graph" ? "bg-secondary font-medium" : "text-muted-foreground"}`}
						onClick={() => this.setState({ mode: "compute-graph" })}
					>
						Compute Graph
					</button>
				</div>

				{this.state.mode === "animator" ? (
					<EditorAnimatorPanel
						editor={this.props.editor}
						requestedControllerId={this.state.animatorControllerId}
						requestedDebugEnabled={this.state.animatorDebugEnabled}
					/>
				) : this.state.mode === "2d-animation" ? (
					<EditorSpriteSkinningPanel editor={this.props.editor} />
				) : this.state.mode === "animation-window" ? (
					<EditorAnimationWindowPanel
						editor={this.props.editor}
						requestedGroupName={this.state.animationGroupName}
						onGroupChange={(animationGroupName) => this.setState({ animationGroupName })}
					/>
				) : this.state.mode === "behavior-trees" ? (
					<EditorBehaviorTreesPanel editor={this.props.editor} />
				) : this.state.mode === "visual-scripting" ? (
					<EditorVisualScriptingPanel editor={this.props.editor} />
				) : this.state.mode === "compute-graph" ? (
					<EditorComputeGraphPanel editor={this.props.editor} />
				) : (
					<>
						<EditorAnimationToolbar animationEditor={this} playing={this.state.playing} animatable={this.state.animatable} />

						<div className="flex w-full h-10">
							<div className="flex justify-center items-center font-semibold w-96 h-full bg-secondary">Tracks</div>

							<div className="w-1 h-full bg-input" />

							<div className="flex justify-center items-center font-semibold w-full h-full bg-secondary">Timeline</div>
						</div>

						<div
							onClick={() => this.setState({ focused: true })}
							onMouseLeave={() => this.setState({ focused: false })}
							className="relative flex w-full h-full overflow-x-hidden overflow-y-auto"
						>
							<EditorAnimationTracksPanel animationEditor={this} ref={(r) => (this.tracks = r!)} animatable={this.state.animatable} />

							<div className="w-1 h-full bg-input" />

							<EditorAnimationTimelinePanel animationEditor={this} editor={this.props.editor} ref={(r) => (this.timelines = r!)} animatable={this.state.animatable} />

							<EditorAnimationInspector animationEditor={this} ref={(r) => (this.inspector = r!)} />
						</div>
					</>
				)}
			</div>
		);
	}

	public componentDidMount(): void {
		window.addEventListener(
			"keyup",
			(this._onKeyUpListener = (ev) => {
				if (ev.key !== " " || !this.state.focused) {
					return;
				}

				if (!isDomElementFocusable(document.activeElement)) {
					if (this.state.playing) {
						this.stop();
					} else {
						this.play();
					}
				}
			})
		);
	}

	public componentWillUnmount(): void {
		window.removeEventListener("keyup", this._onKeyUpListener);
	}

	/**
	 * Sets the reference to the edited object, selected somewhere in the graph or the preview, to edit its animations.
	 * @param object defines the reference to the object that has been selected somewhere in the graph or the preview.
	 */
	public setEditedObject(object: unknown): void {
		if (!object) {
			return this.setState({ animatable: null });
		}

		if (isNode(object) || isScene(object) || isAnyParticleSystem(object)) {
			if (!object.animations) {
				object.animations = [];
			}

			this.setState({ animatable: object });
		}
	}

	/**
	 * Opens the clip-centric Animation Window and selects the requested AnimationGroup.
	 * @param animationGroupName defines the existing AnimationGroup to edit.
	 */
	public openAnimationWindow(animationGroupName: string): void {
		this.setState({ mode: "animation-window", animationGroupName });
	}

	/**
	 * Opens the Animator workspace on one controller with its live runtime debugger enabled.
	 * @param controllerId defines the persisted Animator controller to inspect.
	 */
	public openAnimatorDebugger(controllerId: string): void {
		this.setState({ mode: "animator", animatorControllerId: controllerId, animatorDebugEnabled: true });
	}

	/** Opens the focused weighted-sprite and PSD rigging workspace. */
	public openSpriteSkinningWorkspace(): void {
		this.setState({ mode: "2d-animation" });
	}

	/**
	 * Plays the current timeline starting from the current tracker position.
	 */
	public play(): void {
		if (this._playing) {
			return;
		}

		this.setState({ playing: true });

		this._playing = true;
		this._currentTimeBeforePlay = this.timelines.state.currentTime;

		this.timelines.play();
	}

	/**
	 * Stops the current timeline being played and returns to the previous tracker position
	 * saved before the timeline was played.
	 */
	public stop(): void {
		if (!this._playing) {
			return;
		}

		this._playing = false;
		this.setState({ playing: false });

		this.timelines.stop();

		if (this._currentTimeBeforePlay !== null) {
			this.timelines.setCurrentTime(this._currentTimeBeforePlay);
			this._currentTimeBeforePlay = null;
		}
	}
}
