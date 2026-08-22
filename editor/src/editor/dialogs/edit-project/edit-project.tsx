import { toast } from "sonner";
import { Component, ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../ui/shadcn/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../ui/shadcn/ui/alert-dialog";
import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { Label } from "../../../ui/shadcn/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../ui/shadcn/ui/select";

import { Editor } from "../../main";

import { checkProjectCachedCompressedTextures } from "../../../tools/assets/ktx";

import { projectConfiguration } from "../../../project/configuration";
import { listInstalledExternalEditors, setProjectSettings } from "../../../mcp/project/project";
import { updateEditorUserPreferences } from "../../preferences";

import { EditorExtensionsSettings } from "./extensions";
import { EditorProjectServicesSettings } from "./services";
import { EditorEditProjectTextureComponent } from "./textures/component";
import { EditorProjectSettingsComponent } from "./project-settings";
import { EditorGraphicsSettings } from "./graphics";

export interface IEditorEditProjectComponentProps {
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

export interface IEditorEditProjectComponentState {
	detectedExternalEditors: { name: string; command: string }[];
	detectingExternalEditors: boolean;
}

export class EditorEditProjectComponent extends Component<IEditorEditProjectComponentProps, IEditorEditProjectComponentState> {
	public constructor(props: IEditorEditProjectComponentProps) {
		super(props);

		this.state = {
			detectedExternalEditors: [],
			detectingExternalEditors: false,
		};
	}

	public render(): ReactNode {
		return (
			<AlertDialog open={this.props.open}>
				<AlertDialogContent className="flex flex-col justify-center max-w-5xl max-h-[90vh]">
					<AlertDialogHeader>
						<AlertDialogTitle className="text-3xl font-[400]">Project Settings</AlertDialogTitle>
					</AlertDialogHeader>

					<div className="py-5 overflow-y-auto pr-2">
						<Tabs defaultValue="editor" className="w-full">
							<TabsList className="w-full">
								<TabsTrigger className="w-full" value="editor">
									Editor
								</TabsTrigger>
								<TabsTrigger className="w-full" value="extensions">
									Extensions
								</TabsTrigger>
								<TabsTrigger className="w-full" value="services">
									Services
								</TabsTrigger>
								<TabsTrigger className="w-full" value="player">
									Player
								</TabsTrigger>
								<TabsTrigger className="w-full" value="graphics">
									Graphics
								</TabsTrigger>
								<TabsTrigger className="w-full" value="asset-pipeline">
									Asset Pipeline
								</TabsTrigger>
								<TabsTrigger className="w-full" value="play-mode">
									Play Mode
								</TabsTrigger>
							</TabsList>

							<TabsContent value="editor">
								<div className="flex flex-col gap-2 mb-5">
									<Label htmlFor="external-editor-command">External script editor</Label>
									<div className="flex gap-2">
										<Input
											id="external-editor-command"
											value={this.props.editor.state.externalEditorCommand}
											placeholder="code"
											onChange={(event) => this.props.editor.setState({ externalEditorCommand: event.target.value })}
										/>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={this.state.detectingExternalEditors}
											onClick={() => this._detectExternalEditors()}
										>
											{this.state.detectingExternalEditors ? "Detecting..." : "Detect Editors"}
										</Button>
									</div>
									{this.state.detectedExternalEditors.length > 0 && (
										<Select
											value={this.props.editor.state.externalEditorCommand}
											onValueChange={(command) => this.props.editor.setState({ externalEditorCommand: command })}
										>
											<SelectTrigger>
												<SelectValue placeholder="Choose a detected editor" />
											</SelectTrigger>
											<SelectContent>
												{this.state.detectedExternalEditors.map((editor) => (
													<SelectItem key={editor.command} value={editor.command}>
														{editor.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
									<p className="text-xs text-muted-foreground">
										Choose a detected editor or enter an executable name/absolute application path. It is used by “Open in External Editor” and MCP source-file
										opening. Example: code.
									</p>
								</div>
								<EditorEditProjectTextureComponent editor={this.props.editor} />
							</TabsContent>
							<TabsContent value="extensions">
								<EditorExtensionsSettings editor={this.props.editor} />
							</TabsContent>
							<TabsContent value="services">
								<EditorProjectServicesSettings editor={this.props.editor} />
							</TabsContent>
							<TabsContent value="player">
								<EditorProjectSettingsComponent editor={this.props.editor} page="player" />
							</TabsContent>
							<TabsContent value="graphics">
								<EditorGraphicsSettings editor={this.props.editor} />
							</TabsContent>
							<TabsContent value="asset-pipeline">
								<EditorProjectSettingsComponent editor={this.props.editor} page="assetPipeline" />
							</TabsContent>
							<TabsContent value="play-mode">
								<EditorProjectSettingsComponent editor={this.props.editor} page="playMode" />
							</TabsContent>
						</Tabs>
					</div>

					<AlertDialogFooter>
						<AlertDialogCancel className="w-20" onClick={() => this.props.onClose()}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction className="w-20" onClick={() => this._handleSave()}>
							Save
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		);
	}

	private async _handleSave(): Promise<void> {
		projectConfiguration.compressedTexturesEnabled = this.props.editor.state.compressedTexturesEnabled;
		const currentSettings = this.props.editor.state.projectSettings;
		const currentPreferences = this.props.editor.state.editorUserPreferences;
		const preferences =
			currentPreferences.externalTools.scriptEditorCommand === this.props.editor.state.externalEditorCommand
				? currentPreferences
				: updateEditorUserPreferences(currentPreferences, currentPreferences.revision, {
						externalTools: { ...currentPreferences.externalTools, scriptEditorCommand: this.props.editor.state.externalEditorCommand },
					});
		await setProjectSettings(this.props.editor.layout.preview.scene, { expectedRevision: currentSettings.revision, settings: currentSettings }, { editor: this.props.editor });
		if (preferences !== currentPreferences) {
			await this.props.editor.setEditorUserPreferences(preferences);
		}

		await checkProjectCachedCompressedTextures(this.props.editor);

		toast.success("Project preferences saved");

		this.props.onClose();
	}

	private async _detectExternalEditors(): Promise<void> {
		this.setState({ detectingExternalEditors: true });

		try {
			const result = await listInstalledExternalEditors(this.props.editor.layout.preview.scene, {});
			this.setState({ detectedExternalEditors: result.editors });
			if (result.editors.length === 0) {
				toast.info("No supported external editors were detected");
			}
		} catch (error) {
			toast.error(`Failed to detect external editors: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.setState({ detectingExternalEditors: false });
		}
	}
}
