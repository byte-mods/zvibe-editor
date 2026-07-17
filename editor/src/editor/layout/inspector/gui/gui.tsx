import { Component, ReactNode } from "react";

import { AdvancedDynamicTexture } from "babylonjs-gui";
import { Scene } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { isAdvancedDynamicTexture } from "../../../../tools/guards/texture";
import { onTextureModifiedObservable } from "../../../../tools/observables";
import { getGUIContent, saveGUIAsset, setGUIContent } from "../../../../mcp/gui/gui";

import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorSectionField } from "../fields/section";

import { IEditorInspectorImplementationProps } from "../inspector";

export interface IEditorAdvancedDynamicTextureInspectorState {
	content: string;
	assetPath: string;
	error: string | null;
}

export class EditorAdvancedDynamicTextureInspector extends Component<IEditorInspectorImplementationProps<AdvancedDynamicTexture>, IEditorAdvancedDynamicTextureInspectorState> {
	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: unknown): boolean {
		return isAdvancedDynamicTexture(object) && object._isFullscreen;
	}

	public constructor(props: IEditorInspectorImplementationProps<AdvancedDynamicTexture>) {
		super(props);
		this.state = { content: "", assetPath: `assets/${props.object.name || "gui"}.gui`, error: null };
	}

	public componentDidMount(): void {
		this._readContent();
	}

	public render(): ReactNode {
		return (
			<>
				<EditorInspectorSectionField title="Common">
					<EditorInspectorStringField
						label="Name"
						object={this.props.object}
						property="name"
						onChange={() => onTextureModifiedObservable.notifyObservers(this.props.object)}
					/>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="GUI Control Tree"
					tooltip="Validated Advanced Dynamic Texture JSON. Editing uses the same persisted MCP content action available to external agents."
				>
					<div className="flex flex-col gap-2">
						<textarea
							value={this.state.content}
							aria-label="GUI serialized control tree"
							onChange={(event) => this.setState({ content: event.currentTarget.value, error: null })}
							className="min-h-64 w-full rounded bg-input p-2 font-mono text-xs"
						/>
						<div className="flex gap-2">
							<Button size="sm" variant="secondary" onClick={() => this._readContent()}>
								Reload
							</Button>
							<Button size="sm" onClick={() => this._applyContent()}>
								Apply JSON
							</Button>
						</div>
						<div className="flex gap-2">
							<Input
								value={this.state.assetPath}
								aria-label="GUI asset path"
								onChange={(event) => this.setState({ assetPath: event.currentTarget.value, error: null })}
								placeholder="assets/menu.gui"
							/>
							<Button size="sm" variant="secondary" onClick={() => void this._saveAsset()}>
								Save Asset
							</Button>
						</div>
						{this.state.error && <div className="text-xs text-red-400">{this.state.error}</div>}
					</div>
				</EditorInspectorSectionField>
			</>
		);
	}

	private _readContent(): void {
		try {
			const content = getGUIContent(this._scene(), { guiId: this.props.object.uniqueId.toString() }).content;
			this.setState({ content: JSON.stringify(content, null, 2), error: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Could not read GUI content." });
		}
	}

	private _applyContent(): void {
		try {
			const content = JSON.parse(this.state.content);
			setGUIContent(this._scene(), { guiId: this.props.object.uniqueId.toString(), content }, { editor: this.props.editor });
			this._readContent();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "GUI content must be valid JSON." });
		}
	}

	private async _saveAsset(): Promise<void> {
		try {
			await saveGUIAsset(this._scene(), { guiId: this.props.object.uniqueId.toString(), path: this.state.assetPath, overwrite: true }, { editor: this.props.editor });
			this.setState({ error: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Could not save GUI asset." });
		}
	}

	private _scene(): Scene {
		const scene = this.props.object.getScene();
		if (!scene) throw new Error("This GUI is not attached to a scene.");
		return scene;
	}
}
