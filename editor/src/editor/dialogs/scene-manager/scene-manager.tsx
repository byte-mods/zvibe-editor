import { basename, dirname, relative } from "path/posix";

import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../ui/shadcn/ui/alert-dialog";
import { Button } from "../../../ui/shadcn/ui/button";
import { Checkbox } from "../../../ui/shadcn/ui/checkbox";
import { showConfirm, showPrompt } from "../../../ui/dialog";

import { clearUndoRedo } from "../../../tools/undoredo";

import { saveProject, saveProjectConfiguration } from "../../../project/save/save";
import {
	loadSceneIntoWorkspace,
	revertWorkspaceScene,
	saveWorkspaceScene,
	setActiveWorkspaceScene,
	setLightingWorkspaceScene,
	unloadWorkspaceScene,
} from "../../../project/scene-workspace-actions";
import { IEditorSceneBuildSettings } from "../../../project/typings";
import {
	addSceneToBuildSettings,
	createSceneTemplate,
	deleteSceneTemplate,
	IEditorSceneTemplateSummary,
	instantiateSceneTemplate,
	listSceneTemplates,
	readSceneBuildSettings,
} from "../../../project/scenes";

import { Editor } from "../../main";

export interface IEditorSceneManagerProps {
	editor: Editor;
	open: boolean;
	onClose: () => void;
}

interface IEditorSceneManagerState {
	templates: IEditorSceneTemplateSummary[];
	originalSceneBuildSettings: IEditorSceneBuildSettings;
	working: boolean;
}

export class EditorSceneManager extends Component<IEditorSceneManagerProps, IEditorSceneManagerState> {
	private _workspaceCleanup: (() => void) | null = null;

	public constructor(props: IEditorSceneManagerProps) {
		super(props);
		this.state = { templates: [], originalSceneBuildSettings: { version: 1, scenes: [] }, working: false };
	}

	public componentDidUpdate(previousProps: IEditorSceneManagerProps): void {
		if (this.props.open && !previousProps.open) {
			void this._refresh(true);
		}
	}

	public componentDidMount(): void {
		this._workspaceCleanup = this.props.editor.sceneWorkspace.subscribe(() => this.forceUpdate());
	}

	public componentWillUnmount(): void {
		this._workspaceCleanup?.();
		this._workspaceCleanup = null;
	}

	public render(): ReactNode {
		const projectDirectory = this.props.editor.state.projectPath ? dirname(this.props.editor.state.projectPath) : null;
		const workspaceStates = new Map(this.props.editor.sceneWorkspace.getLoadedSceneStates().map((state) => [state.path, state]));
		return (
			<AlertDialog open={this.props.open}>
				<AlertDialogContent className="flex flex-col w-[900px] max-w-[95vw] max-h-[90vh]">
					<AlertDialogHeader>
						<AlertDialogTitle className="text-3xl font-[400]">Scene Manager</AlertDialogTitle>
					</AlertDialogHeader>

					<div className="flex flex-col gap-5 overflow-auto py-3">
						<section className="flex flex-col gap-2">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="text-lg font-medium">Scenes in Build</h3>
									<p className="text-xs text-muted-foreground">
										Order defines build index. Disabled scenes remain editable but are omitted from generated builds.
									</p>
								</div>
								<Button variant="outline" size="sm" disabled={this.state.working || !projectDirectory} onClick={() => this._refresh(true)}>
									Refresh
								</Button>
							</div>

							<div className="flex flex-col border rounded-md divide-y">
								{this.props.editor.state.sceneBuildSettings.scenes.map((entry, index) => {
									const workspaceState = workspaceStates.get(entry.path);
									return (
										<div key={entry.path} className="grid grid-cols-[32px_48px_minmax(150px,1fr)_auto] items-center gap-2 p-2">
											<Checkbox
												checked={entry.enabled}
												onCheckedChange={(checked) => this._setEnabled(index, checked === true)}
												aria-label={`Include ${entry.path} in build`}
											/>
											<span className="text-xs text-muted-foreground text-center">{index}</span>
											<div className="min-w-0">
												<div className="truncate">{entry.path}</div>
												<div className="flex gap-2 text-xs">
													{workspaceState?.isActive && <span className="text-blue-400">Active</span>}
													{workspaceState?.isLighting && <span className="text-amber-400">Lighting</span>}
													{workspaceState?.isDirty && <span className="text-orange-400">Unsaved</span>}
													{!workspaceState && <span className="text-muted-foreground">Unloaded</span>}
												</div>
											</div>
											<div className="flex flex-wrap justify-end gap-1">
												<Button variant="outline" size="sm" disabled={index === 0 || this.state.working} onClick={() => this._move(index, -1)}>
													Up
												</Button>
												<Button
													variant="outline"
													size="sm"
													disabled={index === this.props.editor.state.sceneBuildSettings.scenes.length - 1 || this.state.working}
													onClick={() => this._move(index, 1)}
												>
													Down
												</Button>
												{workspaceState ? (
													<>
														<Button
															variant="outline"
															size="sm"
															disabled={workspaceState.isActive || this.state.working}
															onClick={() => this._setActiveScene(entry.path)}
														>
															Active
														</Button>
														<Button
															variant="outline"
															size="sm"
															disabled={workspaceState.isLighting || this.state.working}
															onClick={() => this._setLightingScene(entry.path)}
														>
															Lighting
														</Button>
														<Button variant="outline" size="sm" disabled={this.state.working} onClick={() => this._saveLoadedScene(entry.path)}>
															Save
														</Button>
														<Button variant="outline" size="sm" disabled={this.state.working} onClick={() => this._revertLoadedScene(entry.path)}>
															Revert
														</Button>
														<Button
															variant="destructive"
															size="sm"
															disabled={this.state.working || workspaceStates.size === 1}
															onClick={() => this._unloadScene(entry.path)}
														>
															Unload
														</Button>
													</>
												) : (
													<Button
														variant="outline"
														size="sm"
														disabled={this.state.working || !projectDirectory}
														onClick={() => this._loadScene(entry.path)}
													>
														Load Additive
													</Button>
												)}
											</div>
										</div>
									);
								})}
								{this.props.editor.state.sceneBuildSettings.scenes.length === 0 && <div className="p-4 text-sm text-muted-foreground">No scene assets found.</div>}
							</div>
						</section>

						<section className="flex flex-col gap-2">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="text-lg font-medium">Scene Templates</h3>
									<p className="text-xs text-muted-foreground">Capture the active scene as a reusable, self-contained template.</p>
								</div>
								<Button disabled={this.state.working || !this.props.editor.state.lastOpenedScenePath} onClick={() => this._createTemplate()}>
									Create from Active Scene
								</Button>
							</div>
							<div className="flex flex-col border rounded-md divide-y">
								{this.state.templates.map((template) => (
									<div key={template.path} className="flex items-center justify-between gap-3 p-2">
										<div className="min-w-0">
											<div className="font-medium truncate">{template.name}</div>
											<div className="text-xs text-muted-foreground truncate">{template.path}</div>
											{template.description && <div className="text-xs mt-1">{template.description}</div>}
										</div>
										<div className="flex gap-1">
											<Button variant="outline" size="sm" disabled={this.state.working} onClick={() => this._instantiateTemplate(template)}>
												Create Scene
											</Button>
											<Button variant="destructive" size="sm" disabled={this.state.working} onClick={() => this._deleteTemplate(template)}>
												Delete
											</Button>
										</div>
									</div>
								))}
								{this.state.templates.length === 0 && <div className="p-4 text-sm text-muted-foreground">No scene templates found.</div>}
							</div>
						</section>
					</div>

					<AlertDialogFooter>
						<AlertDialogCancel disabled={this.state.working} onClick={() => this._cancel()}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction disabled={this.state.working} onClick={() => this._save()}>
							Save
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		);
	}

	private async _refresh(captureOriginal = false): Promise<void> {
		const projectPath = this.props.editor.state.projectPath;
		if (!projectPath) {
			return;
		}

		this.setState({ working: true });
		try {
			const [sceneBuildSettings, templates] = await Promise.all([readSceneBuildSettings(projectPath), listSceneTemplates(dirname(projectPath))]);
			this.props.editor.setState({ sceneBuildSettings });
			this.setState({
				templates,
				originalSceneBuildSettings: captureOriginal ? structuredClone(sceneBuildSettings) : this.state.originalSceneBuildSettings,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ working: false });
		}
	}

	private async _refreshTemplates(): Promise<void> {
		const projectPath = this.props.editor.state.projectPath;
		if (projectPath) {
			this.setState({ templates: await listSceneTemplates(dirname(projectPath)) });
		}
	}

	private _setEnabled(index: number, enabled: boolean): void {
		const scenes = this.props.editor.state.sceneBuildSettings.scenes.map((entry, entryIndex) => (entryIndex === index ? { ...entry, enabled } : entry));
		this.props.editor.setState({ sceneBuildSettings: { version: 1, scenes } });
	}

	private _move(index: number, direction: -1 | 1): void {
		const scenes = [...this.props.editor.state.sceneBuildSettings.scenes];
		const [entry] = scenes.splice(index, 1);
		scenes.splice(index + direction, 0, entry);
		this.props.editor.setState({ sceneBuildSettings: { version: 1, scenes } });
	}

	private async _loadScene(path: string): Promise<void> {
		await this._runWorkspaceAction(() => loadSceneIntoWorkspace(this.props.editor, path), `Scene "${path}" loaded additively.`);
	}

	private async _setActiveScene(path: string): Promise<void> {
		await this._runWorkspaceAction(() => setActiveWorkspaceScene(this.props.editor, path), `Scene "${path}" is now active.`);
	}

	private async _setLightingScene(path: string): Promise<void> {
		await this._runWorkspaceAction(() => setLightingWorkspaceScene(this.props.editor, path), `Scene "${path}" now supplies lighting and render settings.`);
	}

	private async _saveLoadedScene(path: string): Promise<void> {
		await this._runWorkspaceAction(() => saveWorkspaceScene(this.props.editor, path), `Scene "${path}" saved.`);
	}

	private async _revertLoadedScene(path: string): Promise<void> {
		const state = this.props.editor.sceneWorkspace.getLoadedSceneStates().find((candidate) => candidate.path === path);
		if (state?.isDirty && !(await showConfirm("Discard Scene Changes?", `Reload "${path}" from disk and discard its unsaved changes?`, { confirmText: "Revert" }))) {
			return;
		}
		clearUndoRedo();
		await this._runWorkspaceAction(() => revertWorkspaceScene(this.props.editor, path), `Scene "${path}" reverted from disk.`);
	}

	private async _unloadScene(path: string): Promise<void> {
		const state = this.props.editor.sceneWorkspace.getLoadedSceneStates().find((candidate) => candidate.path === path);
		if (state?.isDirty && !(await showConfirm("Unload Unsaved Scene?", `Unload "${path}" and discard its unsaved changes?`, { confirmText: "Unload" }))) {
			return;
		}
		clearUndoRedo();
		await this._runWorkspaceAction(() => unloadWorkspaceScene(this.props.editor, path), `Scene "${path}" unloaded.`);
	}

	private async _runWorkspaceAction(action: () => Promise<unknown>, successMessage: string): Promise<void> {
		this.setState({ working: true });
		try {
			await action();
			await this.props.editor.layout.graph.refresh();
			this.props.editor.layout.inspector.setEditedObject(this.props.editor.layout.preview.scene);
			this.props.editor.layout.animations.setEditedObject(this.props.editor.layout.preview.scene);
			toast.success(successMessage);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ working: false });
		}
	}

	private async _createTemplate(): Promise<void> {
		const projectPath = this.props.editor.state.projectPath;
		const activeScenePath = this.props.editor.state.lastOpenedScenePath;
		if (!projectPath || !activeScenePath) {
			return;
		}

		const projectDirectory = dirname(projectPath);
		const sceneName = basename(activeScenePath, ".scene");
		const templatePath = await showPrompt("Scene Template Path", "Enter a project-relative .scenetemplate path", `assets/templates/${sceneName}.scenetemplate`);
		if (!templatePath) {
			return;
		}
		const name = await showPrompt("Scene Template Name", "Enter the display name", sceneName);
		if (!name) {
			return;
		}
		const description = await showPrompt("Scene Template Description", "Optional description", "");

		this.setState({ working: true });
		try {
			await saveProject(this.props.editor);
			this.setState({ originalSceneBuildSettings: structuredClone(this.props.editor.state.sceneBuildSettings) });
			await createSceneTemplate(projectDirectory, { sourcePath: relative(projectDirectory, activeScenePath), templatePath, name, description: description ?? undefined });
			this.props.editor.layout.assets.refresh();
			await this._refreshTemplates();
			toast.success(`Scene template "${name}" created.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ working: false });
		}
	}

	private async _instantiateTemplate(template: IEditorSceneTemplateSummary): Promise<void> {
		const projectPath = this.props.editor.state.projectPath;
		if (!projectPath) {
			return;
		}
		const destinationPath = await showPrompt("New Scene Path", "Enter a project-relative .scene path", `assets/${template.name}.scene`);
		if (!destinationPath) {
			return;
		}

		this.setState({ working: true });
		try {
			await instantiateSceneTemplate(dirname(projectPath), { templatePath: template.path, destinationPath });
			const sceneBuildSettings = addSceneToBuildSettings(this.props.editor.state.sceneBuildSettings, destinationPath);
			await new Promise<void>((resolve) => this.props.editor.setState({ sceneBuildSettings }, resolve));
			await saveProjectConfiguration(this.props.editor);
			this.setState({ originalSceneBuildSettings: structuredClone(sceneBuildSettings) });
			this.props.editor.layout.assets.refresh();
			toast.success(`Scene "${destinationPath}" created from template.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ working: false });
		}
	}

	private async _deleteTemplate(template: IEditorSceneTemplateSummary): Promise<void> {
		const projectPath = this.props.editor.state.projectPath;
		if (!projectPath || !(await showConfirm("Delete Scene Template?", `Permanently delete "${template.path}"?`))) {
			return;
		}

		this.setState({ working: true });
		try {
			await deleteSceneTemplate(dirname(projectPath), template.path);
			this.props.editor.layout.assets.refresh();
			await this._refreshTemplates();
			toast.success(`Scene template "${template.name}" deleted.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ working: false });
		}
	}

	private async _save(): Promise<void> {
		this.setState({ working: true });
		try {
			await saveProjectConfiguration(this.props.editor);
			this.setState({ originalSceneBuildSettings: structuredClone(this.props.editor.state.sceneBuildSettings) });
			toast.success("Scene build settings saved.");
			this.props.onClose();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ working: false });
		}
	}

	private _cancel(): void {
		this.props.editor.setState({ sceneBuildSettings: structuredClone(this.state.originalSceneBuildSettings) });
		this.props.onClose();
	}
}
