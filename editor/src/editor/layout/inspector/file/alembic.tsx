import { Component, ReactNode } from "react";

import { Button } from "../../../../ui/shadcn/ui/button";
import { IAlembicImporterArtifactStatus } from "../../../../mcp/assets/alembic-importer";

export interface IEditorInspectorAlembicComponentProps {
	artifact: IAlembicImporterArtifactStatus | null;
	onInstantiate: () => Promise<string>;
}

export class EditorInspectorAlembicComponent extends Component<IEditorInspectorAlembicComponentProps, { busy: boolean; message: string | null }> {
	public state = { busy: false, message: null as string | null };

	public render(): ReactNode {
		const artifact = this.props.artifact;
		const manifest = artifact?.result?.manifest;
		return (
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm" data-alembic-inspector>
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Alembic Cache</div>
					<span className={artifact?.current ? "text-green-400" : "text-amber-300"}>{artifact?.current ? "Current" : artifact?.exists ? "Stale" : "Not converted"}</span>
				</div>
				{manifest ? (
					<>
						<div>
							{manifest.sampleCount.toLocaleString()} samples · {manifest.durationSeconds.toFixed(3)} s · {manifest.fps.toFixed(3)} FPS
						</div>
						<div>
							{manifest.statistics.meshCount} meshes · {manifest.statistics.pointCount} points · {manifest.statistics.curveCount} curves ·{" "}
							{manifest.statistics.cameraCount} cameras
						</div>
						<div>
							Topology: {manifest.statistics.stableTopologyCount} stable · {manifest.statistics.variableTopologyCount} variable
						</div>
						<div className="text-xs text-muted-foreground">
							{manifest.coordinateSystem} · {(artifact!.result!.outputBytes / 1024).toFixed(1)} KiB · Blender {manifest.generator.blenderVersion}
						</div>
						<div className="max-h-36 overflow-auto rounded border border-border p-2 text-xs">
							{manifest.objects.map((object) => (
								<div key={object.id} className="break-all">
									{object.name} · {object.kind} · {object.topology} · {object.maximumVertexCount.toLocaleString()} vertices
								</div>
							))}
						</div>
						<div className="text-xs text-muted-foreground">Alembic retains face-set/material slot names but does not embed material definitions.</div>
					</>
				) : (
					<div className="text-xs text-muted-foreground">Apply the Alembic Importer to generate a portable Web/Desktop playback cache.</div>
				)}
				<Button data-alembic-instantiate className="h-7 px-2" disabled={!artifact?.current || this.state.busy} onClick={() => void this._instantiate()}>
					{this.state.busy ? "Instantiating…" : "Instantiate In Scene"}
				</Button>
				{this.state.message && (
					<div className="text-xs break-all text-muted-foreground" data-alembic-message>
						{this.state.message}
					</div>
				)}
			</div>
		);
	}

	private async _instantiate(): Promise<void> {
		this.setState({ busy: true, message: null });
		try {
			this.setState({ message: await this.props.onInstantiate() });
		} catch (error) {
			this.setState({ message: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
