import { Component, ReactNode } from "react";

import { Scene } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import { clearSubsurfaceRuntimeState, getSubsurfaceRuntimeState, setSubsurfaceRuntimeState } from "../../../../mcp/materials/subsurface";
import { Editor } from "../../../main";
import { EditorInspectorSectionField } from "../fields/section";

interface IEditorSubsurfaceRuntimeInspectorProps {
	editor: Editor;
	scene: Scene;
}

interface IEditorSubsurfaceRuntimeInspectorState {
	quality: "low" | "medium" | "high" | "custom";
	sampleBudget: number;
	metersPerUnit: number;
	transportMode: "screen-space" | "baked-ray-traced";
	transportIntensity: number;
	busy: boolean;
	error: string | null;
}

export class EditorSubsurfaceRuntimeInspector extends Component<IEditorSubsurfaceRuntimeInspectorProps, IEditorSubsurfaceRuntimeInspectorState> {
	public constructor(props: IEditorSubsurfaceRuntimeInspectorProps) {
		super(props);
		const { settings } = getSubsurfaceRuntimeState(props.scene);
		this.state = {
			quality: settings.quality,
			sampleBudget: settings.sampleBudget,
			metersPerUnit: settings.metersPerUnit,
			transportMode: settings.transportMode,
			transportIntensity: settings.transportIntensity,
			busy: false,
			error: null,
		};
	}

	public render(): ReactNode {
		const { hasExplicitSettings, settings, runtime } = getSubsurfaceRuntimeState(this.props.scene);
		return (
			<EditorInspectorSectionField
				title="Subsurface Scattering Runtime"
				tooltip="Scene-wide Babylon Burley screen-space pre-pass policy. Supports up to 15 effective diffusion profiles and is shared with exported full/additive scenes and MCP."
			>
				<div className="flex flex-col gap-2 text-xs">
					<div className={`rounded p-2 ${runtime.errors.length ? "bg-destructive/10 text-destructive" : runtime.configured ? "bg-success/10 text-success" : "bg-input"}`}>
						<div>
							{runtime.configured ? "Configured" : "Idle"} · {runtime.backend} · {runtime.shaderLanguage}
						</div>
						<div>
							Profiles {runtime.profileCount}/{runtime.profileCapacity} · materials {runtime.materialCount} · scattering {runtime.scatteringMaterialCount} ·
							transmission {runtime.transmissionMaterialCount}
						</div>
						<div>
							Pre-pass {runtime.prePassEnabled ? "enabled" : "disabled"} · post-process {runtime.postProcessReady ? "ready" : "not ready"} · frame {runtime.frameId}
						</div>
						<div>
							Mask target {runtime.maskTargetReady ? "ready" : runtime.maskTargetAllocated ? "compiling" : "idle"} · {runtime.maskTargetWidth}×
							{runtime.maskTargetHeight} · meshes {runtime.maskMeshCount} · textures {runtime.maskTextureCount} · frames {runtime.maskRenderedFrames}
						</div>
						<div>
							Off-screen transport {runtime.transport.enabled ? (runtime.transport.ready ? "ready" : "needs attention") : "disabled"} · active{" "}
							{runtime.transport.activeCacheCount}/{runtime.transport.cacheCount} · stale {runtime.transport.staleCacheCount} · rays {runtime.transport.totalRayCount}
						</div>
						{runtime.warnings.map((warning: string) => (
							<div key={warning} className="text-amber-400">
								{warning}
							</div>
						))}
						{runtime.errors.map((error: string) => (
							<div key={error}>{error}</div>
						))}
					</div>
					<label className="flex items-center justify-between gap-2">
						Enabled
						<input
							type="checkbox"
							checked={settings.enabled}
							disabled={this.state.busy}
							onChange={(event) => void this._apply({ enabled: event.currentTarget.checked })}
						/>
					</label>
					<label className="grid grid-cols-[1fr_140px] items-center gap-2">
						Quality
						<select
							className="h-8 rounded border border-border bg-input px-2"
							value={this.state.quality}
							onChange={(event) => {
								const quality = event.currentTarget.value as IEditorSubsurfaceRuntimeInspectorState["quality"];
								const sampleBudget = quality === "low" ? 24 : quality === "medium" ? 40 : quality === "high" ? 64 : this.state.sampleBudget;
								this.setState({ quality, sampleBudget });
							}}
						>
							<option value="low">Low · 24</option>
							<option value="medium">Medium · 40</option>
							<option value="high">High · 64</option>
							<option value="custom">Custom</option>
						</select>
					</label>
					<label className="grid grid-cols-[1fr_120px] items-center gap-2">
						Sample Budget
						<Input
							type="number"
							min={8}
							max={256}
							value={this.state.sampleBudget}
							onChange={(event) => this.setState({ sampleBudget: Number(event.currentTarget.value) })}
						/>
					</label>
					<label className="grid grid-cols-[1fr_120px] items-center gap-2">
						Meters Per Unit
						<Input
							type="number"
							min={0.000001}
							max={1000}
							step={0.001}
							value={this.state.metersPerUnit}
							onChange={(event) => this.setState({ metersPerUnit: Number(event.currentTarget.value) })}
						/>
					</label>
					<label className="grid grid-cols-[1fr_170px] items-center gap-2">
						Transport Mode
						<select
							className="h-8 rounded border border-border bg-input px-2"
							value={this.state.transportMode}
							onChange={(event) => this.setState({ transportMode: event.currentTarget.value as IEditorSubsurfaceRuntimeInspectorState["transportMode"] })}
						>
							<option value="screen-space">Screen-space Burley</option>
							<option value="baked-ray-traced">Baked Ray-traced</option>
						</select>
					</label>
					<label className="grid grid-cols-[1fr_120px] items-center gap-2">
						Transport Intensity
						<Input
							type="number"
							min={0}
							max={16}
							step={0.05}
							value={this.state.transportIntensity}
							onChange={(event) => this.setState({ transportIntensity: Number(event.currentTarget.value) })}
						/>
					</label>
					<Button
						size="sm"
						disabled={this.state.busy}
						onClick={() =>
							void this._apply({
								quality: this.state.quality,
								sampleBudget: this.state.sampleBudget,
								metersPerUnit: this.state.metersPerUnit,
								transportMode: this.state.transportMode,
								transportIntensity: this.state.transportIntensity,
							})
						}
					>
						{this.state.busy ? "Applying…" : `Apply Runtime Revision ${settings.revision + 1}`}
					</Button>
					{hasExplicitSettings && (
						<Button size="sm" variant="secondary" disabled={this.state.busy} onClick={() => void this._clear(settings.revision)}>
							Restore Portable Defaults
						</Button>
					)}
					{this.state.error && <div className="rounded bg-destructive/10 p-2 text-destructive">{this.state.error}</div>}
					<div className="text-muted-foreground">
						Baked Ray-traced mode composes signed camera-independent static transport caches; it is a bounded CPU/web workflow rather than hardware DXR. Independent
						red-channel masks continue through the native pre-pass.
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _apply(patch: Record<string, unknown>): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const { settings } = getSubsurfaceRuntimeState(this.props.scene);
			setSubsurfaceRuntimeState(this.props.scene, { expectedRevision: settings.revision, ...patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _clear(expectedRevision: number): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			clearSubsurfaceRuntimeState(this.props.scene, { expectedRevision, confirm: true }, { editor: this.props.editor });
			const { settings } = getSubsurfaceRuntimeState(this.props.scene);
			this.setState({
				quality: settings.quality,
				sampleBudget: settings.sampleBudget,
				metersPerUnit: settings.metersPerUnit,
				transportMode: settings.transportMode,
				transportIntensity: settings.transportIntensity,
			});
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
