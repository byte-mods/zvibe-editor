import { Component, ReactNode } from "react";

import { inspectRuntimeAiModel, IRuntimeAiModelInspection } from "../../../../mcp/ai/runtime-inference";
import { Button } from "../../../../ui/shadcn/ui/button";
import { Editor } from "../../../main";
import type { FileInspectorObject } from "../file";

interface IEditorInspectorRuntimeAiProps {
	object: FileInspectorObject;
	editor: Editor;
}

interface IEditorInspectorRuntimeAiState {
	inspection: IRuntimeAiModelInspection | null;
	busy: boolean;
	error: string | null;
}

export class EditorInspectorRuntimeAiComponent extends Component<IEditorInspectorRuntimeAiProps, IEditorInspectorRuntimeAiState> {
	public state: IEditorInspectorRuntimeAiState = { inspection: null, busy: false, error: null };

	public render(): ReactNode {
		return (
			<div className="flex flex-col gap-2 rounded-lg bg-secondary p-3 text-sm dark:bg-secondary/35" data-runtime-ai-file-inspector>
				<div className="font-semibold">Runtime AI Model</div>
				<div className="text-xs text-muted-foreground">Compile and inspect this model with its AI Model Importer settings before creating a retained session.</div>
				<div className="flex gap-2">
					<Button size="sm" disabled={this.state.busy} onClick={() => void this._inspect()}>
						{this.state.busy ? "Compiling…" : "Inspect Model"}
					</Button>
					<Button size="sm" variant="outline" onClick={() => this._openWorkspace()}>
						Open Runtime AI
					</Button>
				</div>
				{this.state.inspection && (
					<div className="grid gap-1 rounded border border-border p-2 text-xs">
						<div>
							{this.state.inspection.description.modelFormat} · {this.state.inspection.description.runtimeEngine} · {this.state.inspection.description.backend} ·{" "}
							{(this.state.inspection.modelBytes / 1024).toFixed(1)} KiB
						</div>
						<div>
							{this.state.inspection.description.graph.nodes.length} graph operator(s) · {this.state.inspection.description.externalDataFiles.length} external weight
							file(s)
						</div>
						<div>Inputs: {this.state.inspection.description.inputs.map((value) => `${value.name} ${value.type}[${value.shape.join(", ")}]`).join("; ") || "none"}</div>
						<div>
							Outputs: {this.state.inspection.description.outputs.map((value) => `${value.name} ${value.type}[${value.shape.join(", ")}]`).join("; ") || "none"}
						</div>
					</div>
				)}
				{this.state.error && <div className="text-xs text-destructive">{this.state.error}</div>}
			</div>
		);
	}

	private async _inspect(): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const inspection = await inspectRuntimeAiModel(this.props.editor.layout.preview.scene, { modelPath: this.props.object.absolutePath }, { editor: this.props.editor });
			this.setState({ inspection });
		} catch (error) {
			this.setState({ inspection: null, error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private _openWorkspace(): void {
		this.props.editor.layout.selectTab("runtime-ai");
		this.props.editor.layout.runtimeAi?.openModel(this.props.object.absolutePath);
	}
}
