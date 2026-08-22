import { ipcRenderer } from "electron";
import { Component, ReactNode } from "react";

import { Label } from "../../../ui/shadcn/ui/label";
import { Input } from "../../../ui/shadcn/ui/input";
import { Switch } from "../../../ui/shadcn/ui/switch";
import { Separator } from "../../../ui/shadcn/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../ui/shadcn/ui/select";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../ui/shadcn/ui/alert-dialog";

import { trySetExperimentalFeaturesEnabledInLocalStorage } from "../../../tools/local-storage";

import { EditorInspectorKeyField } from "../../layout/inspector/fields/key";
import { EditorInspectorNumberField } from "../../layout/inspector/fields/number";

import { Editor } from "../../main";
import { IEditorUserPreferences, updateEditorUserPreferences } from "../../preferences";

export interface IEditorEditPreferencesComponentProps {
	/**
	 * Defines the editor reference.
	 */
	editor: Editor;
	/**
	 * Defines if the dialog is open.
	 */
	open: boolean;
	onClose: () => void;
}

export class EditorEditPreferencesComponent extends Component<IEditorEditPreferencesComponentProps> {
	public render(): ReactNode {
		return (
			<AlertDialog open={this.props.open}>
				<AlertDialogContent className="max-w-3xl max-h-[90vh]">
					<AlertDialogHeader>
						<AlertDialogTitle className="text-3xl font-[400]">Edit Preferences</AlertDialogTitle>
					</AlertDialogHeader>

					<div className="flex flex-col gap-[20px] overflow-y-auto pr-2">
						<Separator />
						{this._getAppearanceComponent()}
						<Separator />
						{this._getWorkflowComponent()}
						<Separator />
						{this._getExternalToolsComponent()}
						<Separator />
						{this._getCameraControlPreferences()}
						<Separator />
						{this._getExperimentalComponent()}
					</div>

					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => this.props.onClose()}>Close</AlertDialogCancel>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		);
	}

	private _getAppearanceComponent(): ReactNode {
		const preferences = this.props.editor.state.editorUserPreferences;
		return (
			<div className="flex flex-col gap-[10px] w-full">
				<Label className="text-xl font-[400]">Appearance</Label>
				<div className="grid grid-cols-2 gap-3 items-center">
					<Label>Theme</Label>
					<Select
						value={preferences.appearance.theme}
						onValueChange={(theme) =>
							this._updatePreferences({ appearance: { ...preferences.appearance, theme: theme as IEditorUserPreferences["appearance"]["theme"] } })
						}
					>
						<SelectTrigger className="">
							<SelectValue placeholder="Select Value..." />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="system">System</SelectItem>
							<SelectItem value="light">Light</SelectItem>
							<SelectItem value="dark">Dark</SelectItem>
						</SelectContent>
					</Select>
					<Label>UI Scale</Label>
					<Input
						type="number"
						min={0.5}
						max={2}
						step={0.05}
						value={preferences.appearance.uiScale}
						onChange={(event) => this._updatePreferences({ appearance: { ...preferences.appearance, uiScale: Number(event.target.value) } })}
					/>
				</div>
			</div>
		);
	}

	private _getWorkflowComponent(): ReactNode {
		const preferences = this.props.editor.state.editorUserPreferences;
		return (
			<div className="flex flex-col gap-[10px] w-full">
				<Label className="text-xl font-[400]">Workflow</Label>
				<div className="grid grid-cols-2 gap-3 items-center">
					<Label>Auto Save</Label>
					<Switch checked={preferences.workflow.autoSave} onCheckedChange={(autoSave) => this._updatePreferences({ workflow: { ...preferences.workflow, autoSave } })} />
					<Label>Auto Save Interval (minutes)</Label>
					<Input
						type="number"
						min={1}
						max={120}
						value={preferences.workflow.autoSaveIntervalMinutes}
						onChange={(event) => this._updatePreferences({ workflow: { ...preferences.workflow, autoSaveIntervalMinutes: Number(event.target.value) } })}
					/>
					<Label>Confirm destructive actions</Label>
					<Switch
						checked={preferences.workflow.confirmDestructiveActions}
						onCheckedChange={(confirmDestructiveActions) => this._updatePreferences({ workflow: { ...preferences.workflow, confirmDestructiveActions } })}
					/>
				</div>
			</div>
		);
	}

	private _getExternalToolsComponent(): ReactNode {
		const preferences = this.props.editor.state.editorUserPreferences;
		return (
			<div className="flex flex-col gap-[10px] w-full">
				<Label className="text-xl font-[400]">External Tools</Label>
				<div className="grid grid-cols-2 gap-3 items-center">
					<Label>Script Editor</Label>
					<Input
						value={preferences.externalTools.scriptEditorCommand}
						onChange={(event) => this._updatePreferences({ externalTools: { ...preferences.externalTools, scriptEditorCommand: event.target.value } })}
					/>
					<Label>Image Editor</Label>
					<Input
						value={preferences.externalTools.imageEditorCommand}
						onChange={(event) => this._updatePreferences({ externalTools: { ...preferences.externalTools, imageEditorCommand: event.target.value } })}
					/>
					<Label>Diff Tool</Label>
					<Input
						value={preferences.externalTools.diffToolCommand}
						onChange={(event) => this._updatePreferences({ externalTools: { ...preferences.externalTools, diffToolCommand: event.target.value } })}
					/>
					<Label>Log Level</Label>
					<Select
						value={preferences.diagnostics.logLevel}
						onValueChange={(logLevel) => this._updatePreferences({ diagnostics: { logLevel: logLevel as IEditorUserPreferences["diagnostics"]["logLevel"] } })}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="error">Errors</SelectItem>
							<SelectItem value="warning">Warnings</SelectItem>
							<SelectItem value="info">Info</SelectItem>
							<SelectItem value="verbose">Verbose</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>
		);
	}

	private _updatePreferences(patch: Partial<IEditorUserPreferences>): void {
		const current = this.props.editor.state.editorUserPreferences;
		void this.props.editor.setEditorUserPreferences(updateEditorUserPreferences(current, current.revision, patch));
	}

	private _getCameraControlPreferences(): ReactNode {
		const camera = this.props.editor.layout?.preview?.camera;
		if (!camera) {
			return false;
		}

		return (
			<div>
				<div className="flex flex-col gap-[10px] w-full">
					<div className="flex flex-col gap-[10px]">
						<Label className="text-xl font-[400]">Editor camera control</Label>

						<EditorInspectorKeyField
							value={camera.keysUp[0]?.toString() ?? ""}
							label="Forward"
							onChange={(v) => {
								camera.keysUp = [v];
								this._saveCameraControls();
							}}
						/>
						<EditorInspectorKeyField
							value={camera.keysDown[0]?.toString() ?? ""}
							label="Backward"
							onChange={(v) => {
								camera.keysDown = [v];
								this._saveCameraControls();
							}}
						/>

						<EditorInspectorKeyField
							value={camera.keysLeft[0]?.toString() ?? ""}
							label="Left"
							onChange={(v) => {
								camera.keysLeft = [v];
								this._saveCameraControls();
							}}
						/>
						<EditorInspectorKeyField
							value={camera.keysRight[0]?.toString() ?? ""}
							label="Right"
							onChange={(v) => {
								camera.keysRight = [v];
								this._saveCameraControls();
							}}
						/>

						<EditorInspectorKeyField
							value={camera.keysUpward[0]?.toString() ?? ""}
							label="Up"
							onChange={(v) => {
								camera.keysUpward = [v];
								this._saveCameraControls();
							}}
						/>
						<EditorInspectorKeyField
							value={camera.keysDownward[0]?.toString() ?? ""}
							label="Down"
							onChange={(v) => {
								camera.keysDownward = [v];
								this._saveCameraControls();
							}}
						/>

						<EditorInspectorNumberField
							object={camera}
							property="panSensitivityMultiplier"
							label="Pan Sensitivity"
							min={0.1}
							max={50}
							step={0.5}
							onChange={() => {
								this._saveCameraControls();
							}}
						/>
					</div>
				</div>
			</div>
		);
	}

	private _saveCameraControls(): void {
		const camera = this.props.editor.layout?.preview?.camera;
		if (!camera) {
			return;
		}

		try {
			localStorage.setItem(
				"editor-camera-controls",
				JSON.stringify({
					keysUp: camera.keysUp,
					keysDown: camera.keysDown,
					keysLeft: camera.keysLeft,
					keysRight: camera.keysRight,
					keysUpward: camera.keysUpward,
					keysDownward: camera.keysDownward,
					panSensitivityMultiplier: camera.panSensitivityMultiplier,
				})
			);
		} catch (e) {
			this.props.editor.layout.console.error("Failed to write editor's camera controls configuration.");
			if (e.message) {
				this.props.editor.layout.console.error(e.message);
			}
		}
	}

	private _getExperimentalComponent(): ReactNode {
		return (
			<div className="flex flex-col gap-[10px] w-full">
				<div className="flex flex-col gap-[10px]">
					<Label className="text-xl font-[400]">Experimental features</Label>
					<div className="flex items-center gap-2">
						<Switch
							checked={this.props.editor.state.enableExperimentalFeatures}
							onCheckedChange={(v) => {
								this.props.editor.setState({ enableExperimentalFeatures: v });

								trySetExperimentalFeaturesEnabledInLocalStorage(v);

								ipcRenderer.send("editor:setup-menu", { enableExperimentalFeatures: v });

								this.props.editor.layout.graph.refresh();
								this.props.editor.layout.assets.refresh();
								this.props.editor.layout.preview.forceUpdate();
								this.props.editor.layout.inspector.forceUpdate();
								this.props.editor.layout.animations.forceUpdate();

								this.props.editor.layout.removeLayoutTab("marketplace");
							}}
						/>
						Enable experimental features
					</div>
				</div>
			</div>
		);
	}
}
