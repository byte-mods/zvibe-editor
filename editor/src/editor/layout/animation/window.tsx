import { Component, MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Scene } from "babylonjs";
import { toast } from "sonner";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";

import { editAnimationWindowKeys, getAnimationWindow } from "../../../mcp/animations/animations";

import { Editor } from "../../main";

interface IAnimationWindowSelection {
	trackIndex: number;
	frame: number;
	component?: number;
}

interface IAnimationWindowBoxSelection {
	startX: number;
	startY: number;
	x: number;
	y: number;
	append: boolean;
}

interface IAnimationWindowCurveDrag {
	selection: IAnimationWindowSelection[];
	startClientX: number;
	startClientY: number;
	frameSpan: number;
	valueSpan: number;
	svg: SVGSVGElement;
	frameDelta: number;
	valueDelta: number;
}

export interface IEditorAnimationWindowPanelProps {
	editor: Editor;
	requestedGroupName: string | null;
	onGroupChange: (name: string) => void;
}

export interface IEditorAnimationWindowPanelState {
	groupName: string;
	view: "dopesheet" | "curves";
	activeTrackIndex: number;
	selected: IAnimationWindowSelection[];
	from: number;
	to: number;
	currentFrame: number;
	frameDelta: number;
	valueDelta: number;
	frameScale: number;
	pivotFrame: number;
	revision: number;
	boxSelection: IAnimationWindowBoxSelection | null;
	curveDrag: IAnimationWindowCurveDrag | null;
}

const rowHeight = 34;
const curveColors = ["#ef4444", "#22c55e", "#3b82f6", "#f59e0b"];

function selectionIdentity(selection: IAnimationWindowSelection): string {
	return `${selection.trackIndex}:${selection.frame}:${selection.component ?? "*"}`;
}

function shortText(value: string, maximum = 34): string {
	return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

/**
 * Clip-centric Unity-style Animation Window with a multi-track Dope Sheet and
 * component-aware Curve view. All mutations use the same leased MCP actions.
 */
export class EditorAnimationWindowPanel extends Component<IEditorAnimationWindowPanelProps, IEditorAnimationWindowPanelState> {
	public constructor(props: IEditorAnimationWindowPanelProps) {
		super(props);
		const scene = props.editor.layout.preview.scene;
		const groupName = props.requestedGroupName ?? scene.animationGroups[0]?.name ?? "";
		const window = groupName ? getAnimationWindow(scene, { name: groupName }) : null;
		this.state = {
			groupName,
			view: "dopesheet",
			activeTrackIndex: 0,
			selected: [],
			from: window?.from ?? 0,
			to: Math.max(window?.to ?? 60, (window?.from ?? 0) + 1),
			currentFrame: window?.from ?? 0,
			frameDelta: 1,
			valueDelta: 0.1,
			frameScale: 1,
			pivotFrame: window?.from ?? 0,
			revision: 0,
			boxSelection: null,
			curveDrag: null,
		};
	}

	public componentDidUpdate(previousProps: IEditorAnimationWindowPanelProps): void {
		if (this.props.requestedGroupName && this.props.requestedGroupName !== previousProps.requestedGroupName && this.props.requestedGroupName !== this.state.groupName) {
			this._selectGroup(this.props.requestedGroupName);
		}
	}

	public componentWillUnmount(): void {
		window.removeEventListener("mousemove", this._moveCurveDrag);
		window.removeEventListener("mouseup", this._endCurveDrag);
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const groups = scene.animationGroups;
		const groupName = groups.some((group) => group.name === this.state.groupName) ? this.state.groupName : (groups[0]?.name ?? "");
		if (!groupName) {
			return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Create or import an AnimationGroup to use the Animation Window.</div>;
		}
		const model = getAnimationWindow(scene, { name: groupName });
		const activeTrack = model.tracks.find((track: any) => track.index === this.state.activeTrackIndex) ?? model.tracks[0];
		const from = Math.min(this.state.from, this.state.to - 0.001);
		const to = Math.max(this.state.to, from + 0.001);
		return (
			<div className="flex h-full min-h-0 flex-col bg-background">
				<div className="flex flex-wrap items-center gap-2 border-b border-input bg-input p-2">
					<select
						className="h-8 min-w-48 rounded border border-border bg-background px-2 text-xs"
						value={groupName}
						onChange={(event) => this._selectGroup(event.target.value)}
					>
						{groups.map((group) => (
							<option key={group.uniqueId} value={group.name}>
								{group.name}
							</option>
						))}
					</select>
					<div className="flex rounded border border-border">
						<Button size="sm" variant={this.state.view === "dopesheet" ? "default" : "ghost"} onClick={() => this.setState({ view: "dopesheet" })}>
							Dope Sheet
						</Button>
						<Button size="sm" variant={this.state.view === "curves" ? "default" : "ghost"} onClick={() => this.setState({ view: "curves" })}>
							Curves
						</Button>
					</div>
					<Button size="sm" variant="outline" onClick={() => this._play(scene, groupName)}>
						Play
					</Button>
					<Button size="sm" variant="outline" onClick={() => scene.getAnimationGroupByName(groupName)?.stop()}>
						Stop
					</Button>
					<label className="flex items-center gap-1 text-xs">
						Frame
						<Input
							className="h-8 w-20 text-xs"
							type="number"
							value={String(this.state.currentFrame)}
							onChange={(event) => this._scrub(scene, groupName, Number(event.target.value))}
						/>
					</label>
					<label className="flex items-center gap-1 text-xs">
						From
						<Input className="h-8 w-20 text-xs" type="number" value={String(from)} onChange={(event) => this.setState({ from: Number(event.target.value) })} />
					</label>
					<label className="flex items-center gap-1 text-xs">
						To
						<Input className="h-8 w-20 text-xs" type="number" value={String(to)} onChange={(event) => this.setState({ to: Number(event.target.value) })} />
					</label>
					<Button size="sm" variant="outline" onClick={() => this._fit(model)}>
						Frame All
					</Button>
					<div className="ml-auto text-xs text-muted-foreground">
						{model.trackCount} tracks · {model.keyCount} keys · {this.state.selected.length} selected · {model.durationSeconds.toFixed(2)}s
					</div>
				</div>

				<div className="flex min-h-0 flex-1 flex-col">
					{this.state.view === "dopesheet" ? this._renderDopeSheet(model, from, to) : this._renderCurves(model, activeTrack, from, to)}
					{this._renderSelectionTools(model)}
				</div>
			</div>
		);
	}

	private _renderDopeSheet(model: any, from: number, to: number): ReactNode {
		const width = Math.max(900, (to - from) * 18);
		const height = Math.max(120, model.tracks.length * rowHeight + 32);
		const frameX = (frame: number): number => ((frame - from) / (to - from)) * width;
		const selected = new Set(this.state.selected.map(selectionIdentity));
		const box = this.state.boxSelection;
		const ticks = this._ticks(from, to, width);
		return (
			<div className="flex min-h-0 flex-1 overflow-auto border-b border-input">
				<div className="sticky left-0 z-10 w-[248px] shrink-0 border-r border-input bg-background">
					<div className="h-8 border-b border-input px-2 py-2 text-xs font-medium">Animated properties</div>
					{model.tracks.map((track: any) => (
						<button
							key={track.index}
							className={`block h-[34px] w-full border-b border-input px-2 text-left text-xs ${this.state.activeTrackIndex === track.index ? "bg-secondary" : ""}`}
							onClick={() => this.setState({ activeTrackIndex: track.index })}
							title={`${track.targetName ?? track.targetId ?? "Target"} · ${track.property}`}
						>
							<div className="truncate font-medium">{shortText(track.property)}</div>
							<div className="truncate text-[10px] text-muted-foreground">{shortText(track.targetName ?? track.targetId ?? "Unknown target")}</div>
						</button>
					))}
				</div>
				<svg
					className="block shrink-0 select-none"
					width={width}
					height={height}
					viewBox={`0 0 ${width} ${height}`}
					onMouseDown={(event) => this._beginBoxSelection(event, width, height)}
					onMouseMove={(event) => this._moveBoxSelection(event, width, height)}
					onMouseUp={() => this._endBoxSelection(model, from, to, width)}
					onMouseLeave={() => this._endBoxSelection(model, from, to, width)}
				>
					<rect x="0" y="0" width={width} height={height} className="fill-background" />
					{ticks.map((tick) => (
						<g key={tick.frame}>
							<line x1={tick.x} y1="0" x2={tick.x} y2={height} className="stroke-border" strokeWidth={tick.major ? 1 : 0.5} />
							{tick.major && (
								<text x={tick.x + 3} y="19" className="fill-muted-foreground text-[10px]">
									{tick.frame}
								</text>
							)}
						</g>
					))}
					{model.tracks.map((track: any, row: number) => (
						<g key={track.index}>
							<rect x="0" y={32 + row * rowHeight} width={width} height={rowHeight} className={row % 2 ? "fill-muted/20" : "fill-background"} />
							<line x1="0" y1={32 + (row + 1) * rowHeight} x2={width} y2={32 + (row + 1) * rowHeight} className="stroke-border" />
							{track.keys.map((key: any) => {
								const identity = selectionIdentity({ trackIndex: track.index, frame: key.frame });
								const x = frameX(key.frame);
								const y = 32 + row * rowHeight + rowHeight / 2;
								return (
									<rect
										key={key.frame}
										x={x - 5}
										y={y - 5}
										width="10"
										height="10"
										transform={`rotate(45 ${x} ${y})`}
										className={
											selected.has(identity)
												? "cursor-pointer fill-primary stroke-primary-foreground"
												: "cursor-pointer fill-muted-foreground stroke-background"
										}
										strokeWidth="1"
										onMouseDown={(event) => {
											event.stopPropagation();
											this._selectKey({ trackIndex: track.index, frame: key.frame }, event.shiftKey || event.metaKey || event.ctrlKey);
										}}
									/>
								);
							})}
						</g>
					))}
					{model.events.map((event: any, index: number) => {
						const x = frameX(event.frame);
						return (
							<g key={`${event.frame}:${index}`}>
								<path d={`M ${x - 5} 2 L ${x + 5} 2 L ${x} 11 z`} className="fill-amber-400" />
								<title>{`${event.action} at frame ${event.frame}`}</title>
							</g>
						);
					})}
					<line x1={frameX(this.state.currentFrame)} y1="0" x2={frameX(this.state.currentFrame)} y2={height} className="stroke-red-500" strokeWidth="1.5" />
					{box && (
						<rect
							x={Math.min(box.startX, box.x)}
							y={Math.min(box.startY, box.y)}
							width={Math.abs(box.x - box.startX)}
							height={Math.abs(box.y - box.startY)}
							className="fill-primary/15 stroke-primary"
							strokeDasharray="4 3"
						/>
					)}
				</svg>
			</div>
		);
	}

	private _renderCurves(model: any, activeTrack: any, from: number, to: number): ReactNode {
		if (!activeTrack) {
			return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">This clip contains no tracks.</div>;
		}
		const components = activeTrack.componentLabels.map((label: string, component: number) => ({ label, component }));
		const values = activeTrack.keys.flatMap((key: any) => key.values);
		let minimum = Math.min(...values, 0);
		let maximum = Math.max(...values, 1);
		if (minimum === maximum) {
			minimum -= 0.5;
			maximum += 0.5;
		}
		const valueSpan = maximum - minimum;
		const width = 1000;
		const height = 430;
		const x = (frame: number): number => 48 + ((frame - from) / (to - from)) * (width - 72);
		const y = (value: number): number => 18 + ((maximum - value) / valueSpan) * (height - 58);
		const selected = new Set(this.state.selected.map(selectionIdentity));
		const drag = this.state.curveDrag;
		return (
			<div className="flex min-h-0 flex-1">
				<div className="w-[248px] shrink-0 overflow-auto border-r border-input">
					<div className="border-b border-input p-2 text-xs font-medium">Tracks</div>
					{model.tracks.map((track: any) => (
						<button
							key={track.index}
							className={`block w-full border-b border-input p-2 text-left text-xs ${activeTrack.index === track.index ? "bg-secondary" : ""}`}
							onClick={() => this.setState({ activeTrackIndex: track.index, selected: [] })}
						>
							<div className="truncate font-medium">{track.property}</div>
							<div className="truncate text-[10px] text-muted-foreground">{track.targetName ?? track.targetId}</div>
						</button>
					))}
				</div>
				<div className="min-w-0 flex-1 overflow-auto p-2">
					<div className="mb-2 flex gap-3 text-xs">
						{components.map(({ label, component }: any) => (
							<span key={component} style={{ color: curveColors[component] }}>
								● {label}
							</span>
						))}
						<span className="ml-auto text-muted-foreground">
							{minimum.toFixed(3)} … {maximum.toFixed(3)}
						</span>
					</div>
					<svg
						className="block min-w-[62rem] rounded border border-input bg-muted/10"
						viewBox={`0 0 ${width} ${height}`}
						role="img"
						aria-label={`${model.name} curve editor`}
					>
						{this._ticks(from, to, width - 72).map((tick) => (
							<g key={tick.frame}>
								<line x1={48 + tick.x} y1="0" x2={48 + tick.x} y2={height - 30} className="stroke-border" strokeWidth={tick.major ? 1 : 0.5} />
								{tick.major && (
									<text x={48 + tick.x + 2} y={height - 10} className="fill-muted-foreground text-[10px]">
										{tick.frame}
									</text>
								)}
							</g>
						))}
						{[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
							const value = maximum - valueSpan * ratio;
							return (
								<g key={ratio}>
									<line x1="48" y1={y(value)} x2={width - 24} y2={y(value)} className="stroke-border" strokeWidth="0.5" />
									<text x="4" y={y(value) + 4} className="fill-muted-foreground text-[10px]">
										{value.toFixed(2)}
									</text>
								</g>
							);
						})}
						{components.map(({ component }: any) => (
							<g key={component}>
								<polyline
									points={activeTrack.keys.map((key: any) => `${x(key.frame)},${y(key.values[component] ?? 0)}`).join(" ")}
									fill="none"
									stroke={curveColors[component]}
									strokeWidth="2"
								/>
								{activeTrack.keys.map((key: any) => {
									const reference = { trackIndex: activeTrack.index, frame: key.frame, component };
									const identity = selectionIdentity(reference);
									const dragged = !!drag && drag.selection.some((candidate) => selectionIdentity(candidate) === identity);
									const cx = x(key.frame + (dragged ? drag!.frameDelta : 0));
									const cy = y((key.values[component] ?? 0) + (dragged ? drag!.valueDelta : 0));
									return (
										<circle
											key={key.frame}
											cx={cx}
											cy={cy}
											r={selected.has(identity) ? 5 : 3.5}
											fill={curveColors[component]}
											className="cursor-move stroke-background"
											strokeWidth="1"
											onMouseDown={(event) => this._beginCurveDrag(event, reference, to - from, valueSpan, selected)}
										/>
									);
								})}
							</g>
						))}
						<line x1={x(this.state.currentFrame)} y1="0" x2={x(this.state.currentFrame)} y2={height - 30} className="stroke-red-500" strokeWidth="1.5" />
					</svg>
				</div>
			</div>
		);
	}

	private _renderSelectionTools(model: any): ReactNode {
		const disabled = !this.state.selected.length;
		return (
			<div className="flex flex-wrap items-center gap-2 border-t border-input bg-input p-2 text-xs">
				<span className="font-medium">Selected keys</span>
				<label className="flex items-center gap-1">
					Δ Frame
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						step="any"
						value={String(this.state.frameDelta)}
						onChange={(event) => this.setState({ frameDelta: Number(event.target.value) })}
					/>
				</label>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._edit(model, { operation: "move", frameDelta: this.state.frameDelta })}>
					Move
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={disabled || this.state.frameDelta === 0}
					onClick={() => this._edit(model, { operation: "duplicate", frameDelta: this.state.frameDelta })}
				>
					Duplicate
				</Button>
				<label className="flex items-center gap-1">
					Scale
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						min="0.001"
						step="0.1"
						value={String(this.state.frameScale)}
						onChange={(event) => this.setState({ frameScale: Number(event.target.value) })}
					/>
				</label>
				<label className="flex items-center gap-1">
					Pivot
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						value={String(this.state.pivotFrame)}
						onChange={(event) => this.setState({ pivotFrame: Number(event.target.value) })}
					/>
				</label>
				<Button
					size="sm"
					variant="outline"
					disabled={disabled}
					onClick={() => this._edit(model, { operation: "scale", frameScale: this.state.frameScale, pivotFrame: this.state.pivotFrame })}
				>
					Scale Time
				</Button>
				<label className="flex items-center gap-1">
					Δ Value
					<Input
						className="h-8 w-20 text-xs"
						type="number"
						step="any"
						value={String(this.state.valueDelta)}
						onChange={(event) => this.setState({ valueDelta: Number(event.target.value) })}
					/>
				</label>
				<Button
					size="sm"
					variant="outline"
					disabled={disabled || this.state.selected.some((selection) => selection.component === undefined)}
					onClick={() => this._edit(model, { operation: "offsetValue", valueDelta: this.state.valueDelta })}
				>
					Offset Value
				</Button>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._edit(model, { operation: "setInterpolation", interpolation: "linear" })}>
					Linear
				</Button>
				<Button size="sm" variant="outline" disabled={disabled} onClick={() => this._edit(model, { operation: "setInterpolation", interpolation: "step" })}>
					Step
				</Button>
				<Button size="sm" variant="destructive" disabled={disabled} onClick={() => this._edit(model, { operation: "delete" })}>
					Delete
				</Button>
				<Button size="sm" variant="ghost" disabled={disabled} onClick={() => this.setState({ selected: [] })}>
					Clear
				</Button>
			</div>
		);
	}

	private _ticks(from: number, to: number, width: number): Array<{ frame: number; x: number; major: boolean }> {
		const span = to - from;
		const rough = Math.max(1, span / Math.max(4, Math.floor(width / 120)));
		const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
		const normalized = rough / magnitude;
		const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
		const first = Math.ceil(from / step) * step;
		const ticks: Array<{ frame: number; x: number; major: boolean }> = [];
		for (let frame = first, index = 0; frame <= to && ticks.length < 200; frame += step / 5, index++) {
			ticks.push({ frame: Number(frame.toFixed(6)), x: ((frame - from) / span) * width, major: index % 5 === 0 });
		}
		return ticks;
	}

	private _selectGroup(name: string): void {
		const model = getAnimationWindow(this.props.editor.layout.preview.scene, { name });
		this.props.onGroupChange(name);
		this.setState({
			groupName: name,
			activeTrackIndex: model.tracks[0]?.index ?? 0,
			selected: [],
			from: model.from,
			to: Math.max(model.to, model.from + 1),
			currentFrame: model.from,
			pivotFrame: model.from,
		});
	}

	private _selectKey(selection: IAnimationWindowSelection, append: boolean): void {
		const identity = selectionIdentity(selection);
		if (!append) {
			this.setState({ selected: [selection], activeTrackIndex: selection.trackIndex, pivotFrame: selection.frame });
			return;
		}
		const exists = this.state.selected.some((candidate) => selectionIdentity(candidate) === identity);
		this.setState({
			selected: exists ? this.state.selected.filter((candidate) => selectionIdentity(candidate) !== identity) : [...this.state.selected, selection],
			activeTrackIndex: selection.trackIndex,
			pivotFrame: selection.frame,
		});
	}

	private _fit(model: any): void {
		this.setState({ from: model.from, to: Math.max(model.to, model.from + 1), currentFrame: model.from });
	}

	private _play(scene: Scene, name: string): void {
		const group = scene.getAnimationGroupByName(name);
		if (!group) {
			return;
		}
		group.play(true);
	}

	private _scrub(scene: Scene, name: string, frame: number): void {
		if (!Number.isFinite(frame)) {
			return;
		}
		const group = scene.getAnimationGroupByName(name);
		if (!group) {
			return;
		}
		group.start(false, 1, group.from, group.to);
		group.goToFrame(frame);
		group.pause();
		this.setState({ currentFrame: frame });
	}

	private _edit(model: any, patch: Record<string, unknown>, selection = this.state.selected): void {
		try {
			const result = editAnimationWindowKeys(
				this.props.editor.layout.preview.scene,
				{ name: model.name, expectedFingerprint: model.fingerprint, selection, ...patch },
				{ editor: this.props.editor }
			);
			const next = result.window;
			this.setState({
				selected: [],
				revision: this.state.revision + 1,
				from: Math.min(this.state.from, next.from),
				to: Math.max(this.state.to, next.to, next.from + 1),
			});
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _beginBoxSelection(event: ReactMouseEvent<SVGSVGElement>, width: number, height: number): void {
		if (event.button !== 0 || (event.target !== event.currentTarget && (event.target as Element).tagName !== "rect")) {
			return;
		}
		const position = this._svgPointer(event, event.currentTarget, width, height);
		this.setState({ boxSelection: { startX: position[0], startY: position[1], x: position[0], y: position[1], append: event.shiftKey || event.metaKey || event.ctrlKey } });
	}

	private _moveBoxSelection(event: ReactMouseEvent<SVGSVGElement>, width: number, height: number): void {
		if (!this.state.boxSelection) {
			return;
		}
		const position = this._svgPointer(event, event.currentTarget, width, height);
		this.setState({ boxSelection: { ...this.state.boxSelection, x: position[0], y: position[1] } });
	}

	private _endBoxSelection(model: any, from: number, to: number, width: number): void {
		const box = this.state.boxSelection;
		if (!box) {
			return;
		}
		this.setState({ boxSelection: null });
		const minimumX = Math.min(box.startX, box.x);
		const maximumX = Math.max(box.startX, box.x);
		const minimumY = Math.min(box.startY, box.y);
		const maximumY = Math.max(box.startY, box.y);
		if (maximumX - minimumX < 3 && maximumY - minimumY < 3) {
			if (!box.append) {
				this.setState({ selected: [] });
			}
			return;
		}
		const selections: IAnimationWindowSelection[] = [];
		for (const [row, track] of model.tracks.entries()) {
			const y = 32 + row * rowHeight + rowHeight / 2;
			if (y < minimumY || y > maximumY) {
				continue;
			}
			for (const key of track.keys) {
				const x = ((key.frame - from) / (to - from)) * width;
				if (x >= minimumX && x <= maximumX) {
					selections.push({ trackIndex: track.index, frame: key.frame });
				}
			}
		}
		const combined = box.append ? [...this.state.selected, ...selections] : selections;
		this.setState({ selected: [...new Map(combined.map((selection) => [selectionIdentity(selection), selection])).values()] });
	}

	private _beginCurveDrag(
		event: ReactMouseEvent<SVGCircleElement>,
		reference: IAnimationWindowSelection,
		frameSpan: number,
		valueSpan: number,
		selectedIdentities: Set<string>
	): void {
		event.preventDefault();
		event.stopPropagation();
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) {
			return;
		}
		const append = event.shiftKey || event.metaKey || event.ctrlKey;
		const identity = selectionIdentity(reference);
		let selection = this.state.selected;
		if (!selectedIdentities.has(identity)) {
			selection = append ? [...selection, reference] : [reference];
			this.setState({ selected: selection, activeTrackIndex: reference.trackIndex, pivotFrame: reference.frame });
		}
		this.setState({
			curveDrag: {
				selection,
				startClientX: event.clientX,
				startClientY: event.clientY,
				frameSpan,
				valueSpan,
				svg,
				frameDelta: 0,
				valueDelta: 0,
			},
		});
		window.addEventListener("mousemove", this._moveCurveDrag);
		window.addEventListener("mouseup", this._endCurveDrag, { once: true });
	}

	private _moveCurveDrag = (event: MouseEvent): void => {
		const drag = this.state.curveDrag;
		if (!drag) {
			return;
		}
		const bounds = drag.svg.getBoundingClientRect();
		if (!bounds.width || !bounds.height) {
			return;
		}
		this.setState({
			curveDrag: {
				...drag,
				frameDelta: Math.round(((event.clientX - drag.startClientX) / bounds.width) * drag.frameSpan),
				valueDelta: -((event.clientY - drag.startClientY) / bounds.height) * drag.valueSpan,
			},
		});
	};

	private _endCurveDrag = (): void => {
		window.removeEventListener("mousemove", this._moveCurveDrag);
		const drag = this.state.curveDrag;
		if (!drag) {
			return;
		}
		this.setState({ curveDrag: null });
		if (drag.frameDelta === 0 && Math.abs(drag.valueDelta) < 0.0000001) {
			return;
		}
		const model = getAnimationWindow(this.props.editor.layout.preview.scene, { name: this.state.groupName });
		this._edit(model, { operation: "move", frameDelta: drag.frameDelta, valueDelta: drag.valueDelta }, drag.selection);
	};

	private _svgPointer(event: ReactMouseEvent<SVGSVGElement>, svg: SVGSVGElement, width: number, height: number): [number, number] {
		const bounds = svg.getBoundingClientRect();
		return [(event.clientX - bounds.left) * (width / bounds.width), (event.clientY - bounds.top) * (height / bounds.height)];
	}
}
