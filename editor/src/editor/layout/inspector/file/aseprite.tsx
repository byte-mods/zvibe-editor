import { Component, ReactNode } from "react";

import { IAsepriteImporterArtifactStatus } from "../../../../mcp/assets/aseprite-importer";
import { Button } from "../../../../ui/shadcn/ui/button";

export interface IEditorInspectorAsepriteComponentProps {
	artifact: IAsepriteImporterArtifactStatus | null;
	onInstantiate: (options: { mode: "composite" | "layers"; animationName?: string; playOnAwake: boolean; speed: number }) => Promise<string>;
}

export class EditorInspectorAsepriteComponent extends Component<
	IEditorInspectorAsepriteComponentProps,
	{ busy: boolean; message: string | null; animationName: string; playOnAwake: boolean; speed: number }
> {
	public state = { busy: false, message: null as string | null, animationName: "", playOnAwake: true, speed: 1 };

	public render(): ReactNode {
		const artifact = this.props.artifact;
		const result = artifact?.result;
		const tags = result?.atlas.frameTags ?? [];
		// Reimports may remove or rename a tag while this inspector stays mounted; fall back to the new first valid animation.
		const availableAnimations = tags.length ? tags.map((tag) => tag.name) : ["Default"];
		const selectedAnimation = availableAnimations.includes(this.state.animationName) ? this.state.animationName : availableAnimations[0];
		return (
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm" data-aseprite-inspector>
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Aseprite Sprite Import</div>
					<span className={artifact?.current ? "text-green-400" : "text-amber-300"}>{artifact?.current ? "Current" : artifact?.exists ? "Stale" : "Not imported"}</span>
				</div>
				{result ? (
					<>
						<div>
							{result.document.width}×{result.document.height} · {result.document.colorDepth}-bit · {result.document.frameCount.toLocaleString()} frames ·{" "}
							{result.document.layers.length} layers
						</div>
						<div>
							Atlas {result.atlas.width}×{result.atlas.height} · {result.atlas.statistics.entryCount.toLocaleString()} entries ·{" "}
							{(result.atlasImageBytes / 1024).toFixed(1)} KiB
						</div>
						<div className="text-xs text-muted-foreground">
							RGBA, grayscale, indexed, linked cels, tilemaps, external tilesets, 19 blend modes, variable timing, pivots, slices, and cel events are preserved.
						</div>
						<div className="max-h-36 overflow-auto rounded border border-border p-2 text-xs">
							<div className="font-medium">Layer hierarchy</div>
							{result.document.layers.slice(0, 100).map((layer) => (
								<div
									key={layer.index}
									style={{ paddingLeft: `${Math.min(8, layer.childLevel) * 10}px` }}
									className={layer.visible ? "break-all" : "break-all text-muted-foreground"}
								>
									{layer.name} · {layer.type} · {layer.blendMode} · {layer.opacity}/255 {layer.visible ? "" : "· hidden"}
								</div>
							))}
							{result.document.layers.length > 100 && <div>…and {result.document.layers.length - 100} more layers</div>}
						</div>
						<div className="text-xs">
							Tags:{" "}
							{tags.length
								? tags.map((tag) => `${tag.name} (${tag.from}–${tag.to}, ${tag.direction}, repeat ${tag.repeat || "∞"})`).join(" · ")
								: "Default full timeline"}
						</div>
						<div className="text-xs">
							Slices:{" "}
							{result.document.slices.length ? result.document.slices.map((slice) => `${slice.name}${slice.ninePatch ? " (9-slice)" : ""}`).join(", ") : "None"}
						</div>
						<div className="text-xs">
							Tilesets: {result.document.tilesets.length} · External dependencies: {result.dependencies.length} · Events:{" "}
							{result.document.celUserData.filter((entry) => entry.text).length}
						</div>
						{result.document.warnings.map((warning, index) => (
							<div key={`${index}:${warning}`} className="text-xs text-amber-300 break-all">
								{warning}
							</div>
						))}
						<label className="grid grid-cols-[1fr_140px] gap-2 items-center">
							<span>Animation</span>
							<select
								data-aseprite-animation
								className="h-8 rounded border border-border bg-input px-2"
								value={selectedAnimation}
								onChange={(event) => this.setState({ animationName: event.target.value })}
							>
								{(tags.length ? tags : [{ name: "Default" }]).map((tag) => (
									<option key={tag.name} value={tag.name}>
										{tag.name}
									</option>
								))}
							</select>
						</label>
						<label className="grid grid-cols-[1fr_140px] gap-2 items-center">
							<span>Playback Speed</span>
							<input
								data-aseprite-speed
								type="number"
								min={0.01}
								max={100}
								step={0.1}
								className="h-8 rounded border border-border bg-input px-2"
								value={this.state.speed}
								onChange={(event) => this.setState({ speed: Number(event.target.value) })}
							/>
						</label>
						<label className="flex items-center gap-2 text-xs">
							<input
								data-aseprite-play-on-awake
								type="checkbox"
								checked={this.state.playOnAwake}
								onChange={(event) => this.setState({ playOnAwake: event.target.checked })}
							/>{" "}
							Play on awake
						</label>
						<div className="flex flex-wrap gap-2">
							<Button
								data-aseprite-instantiate-composite
								className="h-7 px-2"
								disabled={!artifact?.current || this.state.busy}
								onClick={() => void this._instantiate("composite", selectedAnimation)}
							>
								{this.state.busy ? "Instantiating…" : "Instantiate Composite"}
							</Button>
							<Button
								data-aseprite-instantiate-layers
								variant="outline"
								className="h-7 px-2"
								disabled={!artifact?.current || result.settings.layerMode !== "compositeAndLayers" || this.state.busy}
								onClick={() => void this._instantiate("layers", selectedAnimation)}
							>
								Instantiate Layer Hierarchy
							</Button>
						</div>
					</>
				) : (
					<div className="text-xs text-muted-foreground">Apply the Aseprite Importer to generate a deterministic atlas before scene instantiation.</div>
				)}
				{this.state.message && (
					<div className="text-xs break-all text-muted-foreground" data-aseprite-message>
						{this.state.message}
					</div>
				)}
			</div>
		);
	}

	private async _instantiate(mode: "composite" | "layers", animationName: string): Promise<void> {
		this.setState({ busy: true, message: null });
		try {
			this.setState({ message: await this.props.onInstantiate({ mode, animationName, playOnAwake: this.state.playOnAwake, speed: this.state.speed }) });
		} catch (error) {
			this.setState({ message: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
