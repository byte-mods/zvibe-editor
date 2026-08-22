import { Component, ReactNode } from "react";

import { Button } from "../../../ui/shadcn/ui/button";
import { ALEMBIC_PLAYER_METADATA_KEY, getAlembicPlayer, IAlembicPlayerConfiguration } from "babylonjs-editor-tools";

import { Editor } from "../../main";
import { controlAlembicPlayer, setAlembicPlayer } from "../../../mcp/assets/alembic";
import { EditorInspectorSectionField } from "./fields/section";

export interface IAlembicPlayerInspectorProps {
	node: any;
	editor: Editor;
}

export class AlembicPlayerInspector extends Component<IAlembicPlayerInspectorProps, { busy: boolean; message: string | null }> {
	public state = { busy: false, message: null as string | null };
	private _timer: ReturnType<typeof setInterval> | null = null;

	public componentDidMount(): void {
		this._timer = setInterval(() => this.forceUpdate(), 250);
	}

	public componentWillUnmount(): void {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = null;
		}
	}

	public render(): ReactNode {
		const configuration = this._configuration();
		if (!configuration) {
			return null;
		}
		const runtime = getAlembicPlayer(this.props.editor.layout.preview.scene as any, configuration.id);
		const state = runtime?.state;
		const start = state?.startTimeSeconds ?? configuration.startTimeSeconds ?? 0;
		const end = state?.endTimeSeconds ?? configuration.endTimeSeconds ?? start;
		return (
			<EditorInspectorSectionField title="Alembic Player">
				<div className="flex flex-col gap-2 px-2 py-2 text-sm">
					<div className="break-all text-xs text-muted-foreground">{configuration.assetPath}</div>
					<div className="flex justify-between gap-2 text-xs">
						<span>Revision {configuration.revision}</span>
						<span className={state?.lastError ? "text-red-400" : runtime ? "text-green-400" : "text-amber-300"}>
							{state?.lastError ? "Error" : runtime ? (state?.playing ? "Playing" : "Ready") : "Reload required"}
						</span>
					</div>
					<div className="grid grid-cols-[1fr_130px] items-center gap-2">
						<label>Name</label>
						<input
							key={`${configuration.id}:${configuration.revision}:name`}
							className="h-8 rounded border border-border bg-input px-2"
							defaultValue={configuration.name}
							disabled={this.state.busy}
							onBlur={(event) => event.currentTarget.value !== configuration.name && void this._set({ name: event.currentTarget.value })}
							onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
						/>
						<label>Enabled</label>
						<input type="checkbox" checked={configuration.enabled} onChange={(event) => void this._set({ enabled: event.currentTarget.checked })} />
						<label>Play On Awake</label>
						<input type="checkbox" checked={configuration.playOnAwake} onChange={(event) => void this._set({ playOnAwake: event.currentTarget.checked })} />
						<label>Loop</label>
						<input type="checkbox" checked={configuration.loop} onChange={(event) => void this._set({ loop: event.currentTarget.checked })} />
						<label>Speed</label>
						<input
							key={`${configuration.id}:${configuration.revision}:speed`}
							type="number"
							className="h-8 rounded border border-border bg-input px-2"
							min={-100}
							max={100}
							step={0.1}
							defaultValue={configuration.speed}
							disabled={this.state.busy}
							onBlur={(event) => Number(event.currentTarget.value) !== configuration.speed && void this._set({ speed: Number(event.currentTarget.value) })}
						/>
						<label>Interpolation</label>
						<select
							className="h-8 rounded border border-border bg-input px-2"
							value={configuration.interpolation}
							onChange={(event) => void this._set({ interpolation: event.currentTarget.value as "hold" | "linear" })}
						>
							<option value="linear">linear</option>
							<option value="hold">hold</option>
						</select>
						<label>Point Size</label>
						<input
							key={`${configuration.id}:${configuration.revision}:pointSize`}
							type="number"
							className="h-8 rounded border border-border bg-input px-2"
							min={0.01}
							max={1000}
							step={0.1}
							defaultValue={configuration.pointSize}
							disabled={this.state.busy}
							onBlur={(event) => Number(event.currentTarget.value) !== configuration.pointSize && void this._set({ pointSize: Number(event.currentTarget.value) })}
						/>
						<label>Curve Width</label>
						<input
							key={`${configuration.id}:${configuration.revision}:curveWidth`}
							type="number"
							className="h-8 rounded border border-border bg-input px-2"
							min={0.01}
							max={1000}
							step={0.1}
							defaultValue={configuration.curveWidth}
							disabled={this.state.busy}
							onBlur={(event) => Number(event.currentTarget.value) !== configuration.curveWidth && void this._set({ curveWidth: Number(event.currentTarget.value) })}
						/>
					</div>
					<div className="flex gap-1">
						<Button className="h-7 px-2" disabled={!runtime || this.state.busy} onClick={() => void this._control("play")}>
							Play
						</Button>
						<Button variant="outline" className="h-7 px-2" disabled={!runtime || this.state.busy} onClick={() => void this._control("pause")}>
							Pause
						</Button>
						<Button variant="outline" className="h-7 px-2" disabled={!runtime || this.state.busy} onClick={() => void this._control("stop")}>
							Stop
						</Button>
					</div>
					<input
						type="range"
						aria-label="Alembic playback time"
						min={start}
						max={Math.max(start, end)}
						step={Math.max(0.001, (end - start) / 1000)}
						value={state?.currentTimeSeconds ?? start}
						disabled={!runtime || this.state.busy || end <= start}
						onChange={(event) => void this._control("seek", Number(event.currentTarget.value))}
					/>
					<div className="flex justify-between text-xs text-muted-foreground">
						<span>{(state?.currentTimeSeconds ?? start).toFixed(3)} s</span>
						<span>{end.toFixed(3)} s</span>
					</div>
					{state && (
						<div className="text-xs text-muted-foreground">
							Frames {state.currentFrame} → {state.nextFrame} · blend {state.blendAmount.toFixed(3)} · resident {state.loadedFrameIndices.join(", ") || "none"}
						</div>
					)}
					{state?.lastError && <div className="text-xs text-red-400 break-all">{state.lastError}</div>}
					{this.state.message && <div className="text-xs text-muted-foreground break-all">{this.state.message}</div>}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _configuration(): IAlembicPlayerConfiguration | null {
		return this.props.node.metadata?.[ALEMBIC_PLAYER_METADATA_KEY] ?? null;
	}

	private async _set(patch: Partial<IAlembicPlayerConfiguration>): Promise<void> {
		const configuration = this._configuration();
		if (!configuration || this.state.busy) {
			return;
		}
		this.setState({ busy: true, message: null });
		try {
			const result = await setAlembicPlayer(
				this.props.editor.layout.preview.scene,
				{ id: configuration.id, expectedRevision: configuration.revision, ...patch },
				{ editor: this.props.editor }
			);
			this.setState({ message: `Updated revision ${result.configuration.revision}.` });
		} catch (error) {
			this.setState({ message: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _control(action: "play" | "pause" | "stop" | "seek", timeSeconds?: number): Promise<void> {
		const configuration = this._configuration();
		if (!configuration || this.state.busy) {
			return;
		}
		this.setState({ busy: true, message: null });
		try {
			await controlAlembicPlayer(
				this.props.editor.layout.preview.scene,
				{ id: configuration.id, action, ...(timeSeconds === undefined ? {} : { timeSeconds }) },
				{ editor: this.props.editor }
			);
		} catch (error) {
			this.setState({ message: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
