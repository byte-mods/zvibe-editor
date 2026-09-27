import { basename, dirname, join } from "path/posix";
import { pathExists, readJSON } from "fs-extra";

import { toast } from "sonner";

import { Editor } from "../../editor/main";

import packageJson from "../../../package.json";

import { requirePlugin } from "../../tools/plugins/require";
import { defaultGizmoSnapPreferences, roundGizmoSnapSteps } from "../../tools/scene/gizmo";

import { projectConfiguration } from "../configuration";
import { EditorProjectPackageManager, IEditorProject } from "../typings";
import { readSceneBuildSettings } from "../scenes";
import { readSceneWorkspaceSettings } from "../scene-workspace";
import { normalizePrefabStageSettings } from "../prefab-stage";
import { normalizeProjectSettings } from "../settings";
import { normalizeProjectEditorExtensions, syncProjectEditorExtensions } from "../../extensions/project";
import { readSerializedJSON } from "../serialization-session";

import { loadSceneWorkspace } from "./workspace";
import { LoadScenePrepareComponent } from "./prepare";
import { installBabylonJSEditorCLI, installBabylonJSEditorTools, installDependencies } from "./install";
import {
	getEditorRuntimePackagesDirectory,
	getRuntimePackageSpecifier,
	isEditorRuntimePackageInstalled,
	readEditorRuntimePackages,
	vendorEditorRuntimePackages,
} from "../runtime-packages";

const runtimeDependenciesVersion = packageJson.runtimeDependenciesVersion;

/**
 * Loads an editor project located at the given path. Typically called at startup when opening
 * a project from the dashboard.
 * @param editor defines the reference to the editor.
 * @param path defines the absolute path to the project file.
 */
export async function loadProject(editor: Editor, path: string) {
	const directory = dirname(path);
	const project = await readSerializedJSON<IEditorProject>(path, "utf-8");
	const [sceneBuildSettings, sceneWorkspace] = await Promise.all([readSceneBuildSettings(path, project), readSceneWorkspaceSettings(path, project)]);
	const activeScenePath = sceneWorkspace.activeScene ? join(directory, sceneWorkspace.activeScene) : null;
	const packageManager = project.packageManager ?? "yarn";
	const gizmoSnap = roundGizmoSnapSteps({ ...defaultGizmoSnapPreferences, ...(project.gizmoSnap ?? {}) });
	const projectSettings = normalizeProjectSettings(project.projectSettings, basename(path, ".bjseditor"));

	await new Promise<void>((resolve) =>
		editor.setState(
			{
				packageManager,
				projectPath: path,
				plugins: (project.plugins ?? []).map((plugin) => plugin.nameOrPath),
				editorExtensions: normalizeProjectEditorExtensions(project.editorExtensions),
				lastOpenedScenePath: activeScenePath,
				sceneBuildSettings,
				prefabStage: normalizePrefabStageSettings(project.prefabStage),

				compressedTextureSoftware: project.compressedTextureSoftware ?? "PVRTexTool",
				compressedTexturesEnabled: project.compressedTexturesEnabled ?? false,
				compressedTexturesEnabledInPreview: project.compressedTexturesEnabledInPreview ?? false,
				compressedEtc2Enabled: project.compressedEtc2Enabled ?? false,
				compressedPvrtcEnabled: project.compressedPvrtcEnabled ?? false,
				compressedTextureQuality: project.compressedTextureQuality ?? "very-fast",
				externalEditorCommand: project.externalEditorCommand ?? "code",
				projectSettings,
				scriptExecutionOrders: project.scriptExecutionOrders ?? {},
			},
			() => resolve()
		)
	);
	editor.sceneWorkspace.configure(sceneWorkspace);

	editor.layout.forceUpdate();
	editor.layout.preview?.updateGizmoSnapPreferences(gizmoSnap);
	const devicePixelRatio = window.devicePixelRatio || 1;
	editor.layout.preview.engine.setHardwareScalingLevel(Math.max(1, devicePixelRatio / projectSettings.rendering.maximumDevicePixelRatio));
	editor.layout.preview.engine.resize();
	await editor.layout.assets.configureProjectAssetWatching(projectSettings.assetPipeline.directoryMonitoring);

	projectConfiguration.compressedTexturesEnabled = project.compressedTexturesEnabled ?? false;
	projectConfiguration.importAccelerator = structuredClone(projectSettings.assetPipeline.accelerator);

	// Update dependencies
	// Dependency work must not block scene loading; extension reconciliation runs at the end of that exact install.
	void checkDependencies(editor, {
		path,
		project,
		directory,
		packageManager,
	}).catch((error) => {
		console.error(error);
		editor.layout.console.error(`Failed to update project dependencies: ${error instanceof Error ? error.message : String(error)}`);
	});

	// Load every persisted authored scene; the active scene only controls authoring focus.
	if (sceneWorkspace.loadedScenes.length) {
		const sceneExists = await Promise.all(sceneWorkspace.loadedScenes.map((scenePath) => pathExists(join(directory, scenePath))));
		const missingScene = sceneWorkspace.loadedScenes.find((_, index) => !sceneExists[index]);
		if (missingScene) {
			toast(`Scene "${missingScene}" does not exist.`);
			return editor.layout.console.error(`Scene "${missingScene}" does not exist.`);
		}

		await loadSceneWorkspace(editor, directory, sceneWorkspace);

		editor.layout.preview.scene.onBeforeRenderObservable.addOnce(() => {
			editor.layout.graph.refresh();
		});

		editor.layout.inspector.setEditedObject(editor.layout.preview.scene);
	}
}

export async function checkDependencies(
	editor: Editor,
	{
		directory,
		path,
		project,
		packageManager,
	}: {
		directory: string;
		path: string;
		project: IEditorProject;
		packageManager: EditorProjectPackageManager;
	}
) {
	const toastId = toast(<LoadScenePrepareComponent />, {
		duration: Infinity,
		dismissible: false,
	});
	try {
		const installCode = await installDependencies(packageManager as any, directory);
		if (installCode !== 0) {
			toast.warning(`Package manager "${packageManager}" is not available on your system. Dependencies will not be updated.`);
		}

		let toolsCode = 0;
		let cliCode = 0;

		const packagesDirectory = getEditorRuntimePackagesDirectory(window.location.href);
		const runtimePackages = await readEditorRuntimePackages(packagesDirectory).catch((error) => {
			console.error(error);
			return null;
		});

		if (runtimePackages) {
			// This editor ships its own builds of the runtime and CLI. Registry packages with the same names and versions are
			// the upstream ones, so install the vendored tarballs unless exactly these builds are already installed.
			const [toolsInstalled, cliInstalled] = await Promise.all([
				isEditorRuntimePackageInstalled(directory, runtimePackages.tools),
				isEditorRuntimePackageInstalled(directory, runtimePackages.cli),
			]);

			if (!toolsInstalled || !cliInstalled) {
				await vendorEditorRuntimePackages(directory, packagesDirectory, runtimePackages);
			}

			if (!toolsInstalled) {
				toolsCode = await installBabylonJSEditorTools(packageManager, directory, getRuntimePackageSpecifier(runtimePackages.tools));
				if (toolsCode !== 0) {
					toast.warning(`Package manager "${packageManager}" is not available on your system. Can't install "babylonjs-editor-tools" package dependency.`);
				}
			}

			if (!cliInstalled) {
				cliCode = await installBabylonJSEditorCLI(packageManager, directory, getRuntimePackageSpecifier(runtimePackages.cli));
				if (cliCode !== 0) {
					toast.warning(`Package manager "${packageManager}" is not available on your system. Can't install "babylonjs-editor-cli" package dependency.`);
				}
			}
		} else {
			const cliPackageJsonPath = "node_modules/babylonjs-editor-cli/package.json";
			const toolsPackageJsonPath = "node_modules/babylonjs-editor-tools/package.json";

			let matchesCliVersion = false;
			let matchesToolsVersion = false;

			// Recursively search for the "babylonjs-editor-tools" package in parent directories, to handle monorepos where the package might be hoisted to the root "node_modules" folder.
			const toolsPathSplit = directory.split("/");
			do {
				try {
					const path = join(toolsPathSplit.join("/"), toolsPackageJsonPath);
					const toolsPackageJson = await readJSON(path, "utf-8");

					matchesToolsVersion = toolsPackageJson.version === runtimeDependenciesVersion;
					break;
				} catch (e) {
					// Catch silently
				}

				toolsPathSplit.pop();
			} while (toolsPathSplit.length > 0);

			const cliPathSplit = directory.split("/");
			do {
				try {
					const path = join(cliPathSplit.join("/"), cliPackageJsonPath);
					const cliPackageJson = await readJSON(path, "utf-8");

					matchesCliVersion = cliPackageJson.version === runtimeDependenciesVersion;
					break;
				} catch (e) {
					// Catch silently
				}

				cliPathSplit.pop();
			} while (cliPathSplit.length > 0);

			if (!matchesToolsVersion) {
				toolsCode = await installBabylonJSEditorTools(packageManager, directory, runtimeDependenciesVersion);
				if (toolsCode !== 0) {
					toast.warning(`Package manager "${packageManager}" is not available on your system. Can't install "babylonjs-editor-tools" package dependency.`);
				}
			}

			if (!matchesCliVersion) {
				cliCode = await installBabylonJSEditorCLI(packageManager, directory, runtimeDependenciesVersion);
				if (cliCode !== 0) {
					toast.warning(`Package manager "${packageManager}" is not available on your system. Can't install "babylonjs-editor-cli" package dependency.`);
				}
			}
		}

		if (editor.state.projectPath !== path) {
			return;
		}

		if (installCode === 0 && toolsCode === 0 && cliCode === 0) {
			editor.layout.preview.setState({
				playEnabled: true,
			});

			toast.success("Dependencies successfully updated");
		}

		await loadProjectPlugins(editor, path, project);
		try {
			await syncProjectEditorExtensions(editor);
		} catch (error) {
			console.error(error);
			editor.layout.console.error(`Failed to synchronize editor extensions: ${error instanceof Error ? error.message : String(error)}`);
		}
	} finally {
		toast.dismiss(toastId);
	}
}

export async function loadProjectPlugins(editor: Editor, path: string, project: IEditorProject) {
	for (const plugin of project.plugins ?? []) {
		if (editor.state.projectPath !== path) {
			return;
		}
		try {
			await requirePlugin(editor, {
				projectPath: path,
				pluginNameOrPath: plugin.nameOrPath,
			});
		} catch (e) {
			console.error(e);
			editor.layout.console.error(`Failed to load plugin from project "${plugin.nameOrPath}"`);
		}
	}
}
