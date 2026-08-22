import { Component, ReactNode } from "react";

import { Scene } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import { captureRenderDebugView, getRenderDebugView, IRenderDebugViewCapture, RenderDebugViewMode, setRenderDebugView } from "../../../../mcp/diagnostics/render-debug";
import { Editor } from "../../../main";
import { EditorInspectorSectionField } from "../fields/section";

interface IEditorRenderDebugInspectorProps {
	editor: Editor;
	scene: Scene;
}

interface IEditorRenderDebugInspectorState {
	maximumOverdraw: number;
	maximumLightCount: number;
	busy: boolean;
	capture: IRenderDebugViewCapture | null;
	error: string | null;
}

/** Transient Unity-style overdraw and light-complexity controls backed by the shared MCP implementation. */
export class EditorRenderDebugInspector extends Component<IEditorRenderDebugInspectorProps, IEditorRenderDebugInspectorState> {
	public constructor(props: IEditorRenderDebugInspectorProps) {
		super(props);
		const report = getRenderDebugView(props.scene);
		this.state = {
			maximumOverdraw: report.maximumOverdraw,
			maximumLightCount: report.maximumLightCount,
			busy: false,
			capture: null,
			error: null,
		};
	}

	public render(): ReactNode {
		const report = getRenderDebugView(this.props.scene);
		const capture = this.state.capture?.revision === report.revision ? this.state.capture : null;
		return (
			<EditorInspectorSectionField
				title="Render Debug Views"
				tooltip="Transient overdraw and light-complexity views rendered by Babylon material overrides. They never replace authored materials or persist into the scene."
			>
				<div className="flex flex-col gap-2 text-xs">
					<div className={`rounded p-2 ${report.active && report.ready ? "bg-success/10 text-success" : "bg-input"}`}>
						<div>
							{report.mode === "disabled" ? "Disabled" : report.ready ? "Ready" : "Compiling"} · {report.backend} · {report.shaderLanguage}
						</div>
						<div>
							Target {report.width}×{report.height} · meshes {report.meshCount} · enabled lights {report.lightCount} · frames {report.renderedFrames}
						</div>
						{report.mode === "light-complexity" && (
							<div>
								Histogram 0…{report.maximumLightCount}: {report.lightCountHistogram.join(" · ")}
							</div>
						)}
					</div>
					<label className="grid grid-cols-[1fr_170px] items-center gap-2">
						View
						<select
							className="h-8 rounded border border-border bg-input px-2"
							value={report.mode}
							disabled={this.state.busy}
							onChange={(event) => void this._apply(event.currentTarget.value as RenderDebugViewMode)}
						>
							<option value="disabled">Disabled</option>
							<option value="overdraw">Overdraw</option>
							<option value="light-complexity">Light Complexity</option>
						</select>
					</label>
					<label className="grid grid-cols-[1fr_120px] items-center gap-2">
						Overdraw Saturation
						<Input
							type="number"
							min={4}
							max={32}
							value={this.state.maximumOverdraw}
							onChange={(event) => this.setState({ maximumOverdraw: Number(event.currentTarget.value) })}
						/>
					</label>
					<label className="grid grid-cols-[1fr_120px] items-center gap-2">
						Light Heat Maximum
						<Input
							type="number"
							min={1}
							max={16}
							value={this.state.maximumLightCount}
							onChange={(event) => this.setState({ maximumLightCount: Number(event.currentTarget.value) })}
						/>
					</label>
					<div className="grid grid-cols-2 gap-2">
						<Button size="sm" variant="secondary" disabled={this.state.busy || report.mode === "disabled"} onClick={() => void this._apply(report.mode)}>
							Apply Limits
						</Button>
						<Button size="sm" disabled={this.state.busy || !report.active} onClick={() => void this._capture()}>
							{this.state.busy ? "Working…" : "Capture View"}
						</Button>
					</div>
					{capture && (
						<div className="rounded bg-input p-2">
							<div>
								Captured {capture.coloredPixelCount.toLocaleString()}/{capture.pixelCount.toLocaleString()} colored pixels ·{" "}
								{(capture.coloredCoverage * 100).toFixed(2)}%
							</div>
							<div className="truncate text-muted-foreground">Pixels SHA-256 {capture.pixelSha256}</div>
							{capture.preview.pngBase64 && (
								<img
									className="mt-2 w-full rounded border border-border bg-black"
									src={`data:image/png;base64,${capture.preview.pngBase64}`}
									alt={`${capture.mode} diagnostic capture`}
								/>
							)}
						</div>
					)}
					{this.state.error && <div className="rounded bg-destructive/10 p-2 text-destructive">{this.state.error}</div>}
					<div className="text-muted-foreground">
						Overdraw counts diagnostic fragment submissions with depth disabled. Light complexity reports mesh-level light eligibility, not per-pixel attenuation cost.
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _apply(mode: RenderDebugViewMode): Promise<void> {
		this.setState({ busy: true, error: null, capture: null });
		try {
			const current = getRenderDebugView(this.props.scene);
			setRenderDebugView(
				this.props.scene,
				{
					expectedRevision: current.revision,
					mode,
					maximumOverdraw: this.state.maximumOverdraw,
					maximumLightCount: this.state.maximumLightCount,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _capture(): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const current = getRenderDebugView(this.props.scene);
			const capture = await captureRenderDebugView(this.props.scene, { expectedRevision: current.revision, width: 320, height: 180, includeImage: true });
			this.setState({ capture });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
