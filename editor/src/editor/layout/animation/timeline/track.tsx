import { Component, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { AiOutlinePlus } from "react-icons/ai";

import { Animation, IAnimatable, IAnimationKey } from "babylonjs";

import { TooltipProvider } from "../../../../ui/shadcn/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../../../ui/shadcn/ui/context-menu";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { getInspectorPropertyValue } from "../../../../tools/property";
import { cloneAnimationCurveKey, getAutoSmoothedAnimationKeys } from "../../../../tools/animation/curve";

import { EditorAnimation } from "../../animation";

import { EditorAnimationTimelineKey, IAnimationKeyConfigurationToMove } from "./key";

export interface IEditorAnimationTimelineItemProps {
	scale: number;
	currentTime: number;
	animation: Animation;
	animatable: IAnimatable | null;
	animationEditor: EditorAnimation;
}

export interface IEditorAnimationTimelineItemState {
	rightClickPositionX: number | null;
}

type ICurveValueDrag = { key: IAnimationKey; component: number; initialValue: number; minimum: number; maximum: number; svg: SVGSVGElement };
type ICurveTangentDrag = {
	key: IAnimationKey;
	component: number;
	direction: -1 | 1;
	initialValue: number;
	minimum: number;
	maximum: number;
	frameSpan: number;
	firstFrame: number;
	svg: SVGSVGElement;
};
type ICurveTangentDragInput = Omit<ICurveTangentDrag, "initialValue" | "svg">;

export class EditorAnimationTimelineItem extends Component<IEditorAnimationTimelineItemProps, IEditorAnimationTimelineItemState> {
	/**
	 * Defines the list of all available key frames in the track.
	 */
	public keyFrames: (EditorAnimationTimelineKey | null)[] = [];

	private _curveValueDrag: ICurveValueDrag | null = null;
	private _curveTangentDrag: ICurveTangentDrag | null = null;

	public constructor(props: IEditorAnimationTimelineItemProps) {
		super(props);

		this.state = {
			rightClickPositionX: null,
		};
	}

	public componentWillUnmount(): void {
		window.removeEventListener("mousemove", this._onCurveValueDrag);
		window.removeEventListener("mouseup", this._stopCurveValueDrag);
		window.removeEventListener("mousemove", this._onCurveTangentDrag);
		window.removeEventListener("mouseup", this._stopCurveTangentDrag);
	}

	public render(): ReactNode {
		this.keyFrames.splice(0, this.keyFrames.length);
		this.keyFrames.length = this.props.animation.getKeys().length;

		const curveComponents = this._getCurveComponents();
		const curveKeys = this.props.animation.getKeys().filter((key) => curveComponents.length && Number.isFinite(this._getCurveKeyComponent(key, curveComponents[0])));
		const frames = curveKeys.map((key) => key.frame);
		const values = curveKeys.flatMap((key) => curveComponents.map((component) => this._getCurveKeyComponent(key, component)));
		const minimum = Math.min(...values, 0);
		const maximum = Math.max(...values, 1);
		const span = Math.max(0.00001, maximum - minimum);
		const frameSpan = Math.max(1, Math.max(...frames, 1) - Math.min(...frames, 0));
		const firstFrame = Math.min(...frames, 0);
		const curvePoint = (key: IAnimationKey, component: number): string =>
			`${((key.frame - firstFrame) / frameSpan) * 100},${36 - ((this._getCurveKeyComponent(key, component) - minimum) / span) * 32}`;
		const curveColors = ["#ef4444", "#22c55e", "#3b82f6", "#f59e0b"];
		const tangentFrameDelta = frameSpan * 0.08;
		return (
			<ContextMenu onOpenChange={(o) => !o && this.setState({ rightClickPositionX: null })}>
				<ContextMenuTrigger>
					<div
						onContextMenu={(ev) => this.setState({ rightClickPositionX: ev.nativeEvent.offsetX })}
						onMouseLeave={() => this.props.animationEditor.setState({ selectedAnimation: null })}
						onMouseEnter={() => this.props.animationEditor.setState({ selectedAnimation: this.props.animation })}
						className={`
                            relative flex items-center w-full h-10 p-2 ring-accent ring-1
                            ${this.props.animationEditor.state.selectedAnimation === this.props.animation ? "bg-accent" : ""}
                            transition-all duration-300 ease-in-out
                        `}
					>
						{curveKeys.length >= 2 && (
							<svg viewBox="0 0 100 36" preserveAspectRatio="none" className="absolute inset-0 h-full w-full opacity-60">
								{curveComponents.map((component) => (
									<g key={component}>
										<polyline
											points={curveKeys.map((key) => curvePoint(key, component)).join(" ")}
											fill="none"
											stroke={curveColors[component]}
											strokeWidth="1"
										/>
										{curveKeys.map((key, index) => {
											const [cx, cy] = curvePoint(key, component).split(",");
											const numericX = Number(cx);
											const numericY = Number(cy);
											return (
												<g key={index}>
													{([-1, 1] as const).map((direction) => {
														const tangent = this._getCurveTangentComponent(key, direction, component);
														const handleX = numericX + direction * 8;
														const handleY = numericY - (direction * tangent * tangentFrameDelta * 32) / span;
														return (
															<g key={direction}>
																<line
																	x1={numericX}
																	y1={numericY}
																	x2={handleX}
																	y2={handleY}
																	stroke={curveColors[component]}
																	strokeWidth="0.6"
																	opacity="0.8"
																/>
																<circle
																	cx={handleX}
																	cy={handleY}
																	r="1.35"
																	className="cursor-crosshair stroke-background"
																	fill={curveColors[component]}
																	strokeWidth="0.5"
																	onMouseDown={(event) =>
																		this._startCurveTangentDrag(event, { key, component, direction, minimum, maximum, frameSpan, firstFrame })
																	}
																/>
															</g>
														);
													})}
													<circle
														cx={cx}
														cy={cy}
														r="2.25"
														className="cursor-ns-resize stroke-background"
														fill={curveColors[component]}
														strokeWidth="0.75"
														onMouseDown={(event) => this._startCurveValueDrag(event, key, component, minimum, maximum)}
													/>
												</g>
											);
										})}
									</g>
								))}
							</svg>
						)}
						<TooltipProvider>
							{this.props.animation.getKeys().map((key, index) => (
								<EditorAnimationTimelineKey
									key={index}
									animationKey={key}
									scale={this.props.scale}
									animatable={this.props.animatable!}
									ref={(r) => (this.keyFrames[index] = r)}
									animationEditor={this.props.animationEditor}
									onRemoved={(key) => this._onAnimationKeyRemoved(key)}
									onClicked={() => this.props.animationEditor.inspector.setEditedKey(key)}
									onMoved={(animationsKeyConfigurationsToMove) => this._onAnimationKeyMoved(animationsKeyConfigurationsToMove)}
								/>
							))}

							{this.state.rightClickPositionX && (
								<div
									style={{
										left: `${this.state.rightClickPositionX}px`,
									}}
									className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rotate-45 bg-muted-foreground/35 border-foreground/35 border-2"
								/>
							)}
						</TooltipProvider>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem className="flex items-center gap-2" onClick={() => this._autoSmoothTangents()}>
						Auto Smooth Tangents
					</ContextMenuItem>
					<ContextMenuItem className="flex items-center gap-2" onClick={() => this.addAnimationKey()}>
						<AiOutlinePlus className="w-5 h-5" /> Add Key Here
					</ContextMenuItem>
					<ContextMenuItem className="flex items-center gap-2" onClick={() => this.addAnimationKey(this.props.currentTime * this.props.scale)}>
						<AiOutlinePlus className="w-5 h-5" /> Add Key at Tracker Position
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		);
	}

	/**
	 * Adds a new animation key for this track located at the current time selected in
	 * the animation editor using the time tracker.
	 */
	public addAnimationKey(positionX?: number | null): void {
		positionX ??= this.state.rightClickPositionX;

		if (positionX === null) {
			return;
		}

		const value = getInspectorPropertyValue(this.props.animatable, this.props.animation.targetProperty);

		const key = {
			value: value.clone?.() ?? value,
			frame: Math.round(positionX / this.props.scale),
		} as IAnimationKey;

		const existingKey = this.props.animation.getKeys().find((k) => k.frame === key.frame);
		if (existingKey) {
			return;
		}

		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				const index = this.props.animation.getKeys().indexOf(key);
				if (index !== -1) {
					this.props.animation.getKeys().splice(index, 1);
				}
			},
			redo: () => this.props.animation.getKeys().push(key),
			action: () => this.props.animation.getKeys().sort((a, b) => a.frame - b.frame),
		});

		this.setState({ rightClickPositionX: null });
	}

	private _onAnimationKeyMoved(animationsKeyConfigurationsToMove: IAnimationKeyConfigurationToMove[][]): void {
		const newKeyFrames = animationsKeyConfigurationsToMove.map((configuration) => {
			return configuration.map((key) => key.key.frame);
		});

		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				animationsKeyConfigurationsToMove.forEach((configurations) => {
					configurations.forEach((key) => {
						key.key.frame = key.startPosition;
					});
				});
			},
			redo: () => {
				animationsKeyConfigurationsToMove.forEach((configurations, configurationIndex) => {
					configurations.forEach((key, keyIndex) => {
						key.key.frame = newKeyFrames[configurationIndex][keyIndex];
					});
				});
			},
			action: () => {
				this.props.animatable?.animations?.forEach((animation) => {
					animation.getKeys().sort((a, b) => a.frame - b.frame);
				});
			},
		});

		this.forceUpdate();
	}

	private _onAnimationKeyRemoved(key: IAnimationKey): void {
		const keys = this.props.animation.getKeys();

		const index = keys.indexOf(key);
		if (index === -1) {
			return;
		}

		registerUndoRedo({
			executeRedo: true,
			undo: () => keys.splice(index, 0, key),
			redo: () => keys.splice(index, 1),
		});

		this.forceUpdate();
	}

	private _autoSmoothTangents(): void {
		const oldKeys = this.props.animation.getKeys().map(cloneAnimationCurveKey);
		const newKeys = getAutoSmoothedAnimationKeys(oldKeys);
		registerUndoRedo({
			executeRedo: true,
			undo: () => this.props.animation.setKeys(oldKeys.map(cloneAnimationCurveKey)),
			redo: () => this.props.animation.setKeys(newKeys.map(cloneAnimationCurveKey)),
			action: () => {
				this.props.animationEditor.timelines.updateTracksAtCurrentTime();
				this.forceUpdate();
			},
		});
	}

	private _getCurveComponents(): number[] {
		const value = this.props.animation.getKeys()[0]?.value;
		if (typeof value === "number") {
			return [0];
		}
		const components = value?.asArray?.();
		return Array.isArray(components) ? components.map((_: number, index: number) => index).slice(0, 4) : [];
	}

	private _getCurveKeyComponent(key: IAnimationKey, component: number): number {
		if (typeof key.value === "number") {
			return key.value;
		}
		return key.value?.asArray?.()[component] ?? 0;
	}

	private _setCurveKeyComponent(key: IAnimationKey, component: number, scalar: number): void {
		if (typeof key.value === "number") {
			key.value = scalar;
			return;
		}
		const values = key.value?.asArray?.();
		if (!Array.isArray(values) || typeof key.value?.copyFromFloats !== "function") {
			return;
		}
		values[component] = scalar;
		key.value.copyFromFloats(...values);
	}

	private _getCurveTangentComponent(key: IAnimationKey, direction: -1 | 1, component: number): number {
		const tangent = direction < 0 ? key.inTangent : key.outTangent;
		if (typeof tangent === "number") {
			return tangent;
		}
		return tangent?.asArray?.()[component] ?? 0;
	}

	private _setCurveTangentComponent(key: IAnimationKey, direction: -1 | 1, component: number, scalar: number): void {
		const property = direction < 0 ? "inTangent" : "outTangent";
		if (typeof key.value === "number") {
			key[property] = scalar;
			return;
		}
		const existing = key[property] ?? key.value;
		const values = existing?.asArray?.();
		if (!Array.isArray(values) || typeof existing?.clone !== "function" || typeof existing?.copyFromFloats !== "function") {
			return;
		}
		const tangent = existing.clone();
		const tangentValues = tangent.asArray();
		tangentValues[component] = scalar;
		tangent.copyFromFloats(...tangentValues);
		key[property] = tangent;
	}

	private _startCurveValueDrag(event: ReactMouseEvent<SVGCircleElement>, key: IAnimationKey, component: number, minimum: number, maximum: number): void {
		event.preventDefault();
		event.stopPropagation();
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) {
			return;
		}
		this._curveValueDrag = { key, component, initialValue: this._getCurveKeyComponent(key, component), minimum, maximum, svg };
		window.addEventListener("mousemove", this._onCurveValueDrag);
		window.addEventListener("mouseup", this._stopCurveValueDrag, { once: true });
	}

	private _startCurveTangentDrag(event: ReactMouseEvent<SVGCircleElement>, input: ICurveTangentDragInput): void {
		event.preventDefault();
		event.stopPropagation();
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) {
			return;
		}
		this._curveTangentDrag = {
			...input,
			initialValue: this._getCurveTangentComponent(input.key, input.direction, input.component),
			svg,
		};
		window.addEventListener("mousemove", this._onCurveTangentDrag);
		window.addEventListener("mouseup", this._stopCurveTangentDrag, { once: true });
	}

	private _onCurveTangentDrag = (event: MouseEvent): void => {
		const drag = this._curveTangentDrag;
		if (!drag) {
			return;
		}
		const bounds = drag.svg.getBoundingClientRect();
		if (!bounds.width || !bounds.height) {
			return;
		}
		const keyX = ((drag.key.frame - drag.firstFrame) / drag.frameSpan) * bounds.width;
		const keyY = (36 - ((this._getCurveKeyComponent(drag.key, drag.component) - drag.minimum) / Math.max(0.00001, drag.maximum - drag.minimum)) * 32) * (bounds.height / 36);
		const frameDelta = ((event.clientX - bounds.left - keyX) / bounds.width) * drag.frameSpan;
		if (Math.abs(frameDelta) < 0.001 || Math.sign(frameDelta) !== drag.direction) {
			return;
		}
		const valueDelta = -((event.clientY - bounds.top - keyY) / bounds.height) * Math.max(0.00001, drag.maximum - drag.minimum) * (36 / 32);
		this._setCurveTangentComponent(drag.key, drag.direction, drag.component, valueDelta / frameDelta);
		this.props.animationEditor.timelines.forceUpdate();
		this.props.animationEditor.inspector.setEditedKey(drag.key);
	};

	private _stopCurveTangentDrag = (): void => {
		window.removeEventListener("mousemove", this._onCurveTangentDrag);
		const drag = this._curveTangentDrag;
		this._curveTangentDrag = null;
		if (!drag) {
			return;
		}
		const value = this._getCurveTangentComponent(drag.key, drag.direction, drag.component);
		if (value === drag.initialValue) {
			return;
		}
		registerUndoRedo({
			executeRedo: false,
			undo: () => this._setCurveTangentComponent(drag.key, drag.direction, drag.component, drag.initialValue),
			redo: () => this._setCurveTangentComponent(drag.key, drag.direction, drag.component, value),
			action: () => this.props.animationEditor.timelines.updateTracksAtCurrentTime(),
		});
	};

	private _onCurveValueDrag = (event: MouseEvent): void => {
		if (!this._curveValueDrag) {
			return;
		}
		const bounds = this._curveValueDrag.svg.getBoundingClientRect();
		if (!bounds?.height) {
			return;
		}
		const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
		const { key, component, minimum, maximum } = this._curveValueDrag;
		this._setCurveKeyComponent(key, component, maximum - ratio * Math.max(0.00001, maximum - minimum));
		this.props.animationEditor.timelines.forceUpdate();
		this.props.animationEditor.inspector.setEditedKey(key);
	};

	private _stopCurveValueDrag = (): void => {
		window.removeEventListener("mousemove", this._onCurveValueDrag);
		const drag = this._curveValueDrag;
		this._curveValueDrag = null;
		if (!drag || this._getCurveKeyComponent(drag.key, drag.component) === drag.initialValue) {
			return;
		}
		const value = this._getCurveKeyComponent(drag.key, drag.component);
		registerUndoRedo({
			executeRedo: false,
			undo: () => this._setCurveKeyComponent(drag.key, drag.component, drag.initialValue),
			redo: () => this._setCurveKeyComponent(drag.key, drag.component, value),
			action: () => this.props.animationEditor.timelines.updateTracksAtCurrentTime(),
		});
	};
}
