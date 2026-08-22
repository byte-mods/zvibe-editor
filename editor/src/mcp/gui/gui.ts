import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";
import { randomUUID } from "node:crypto";
import { lstat, rename } from "node:fs/promises";
import { ensureDir, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";

import { Scene } from "babylonjs";
import {
	AdvancedDynamicTexture,
	Button,
	Checkbox,
	Container,
	Control,
	Ellipse,
	Grid,
	Image,
	InputText,
	InputTextArea,
	RadioButton,
	Rectangle,
	ScrollViewer,
	Slider,
	StackPanel,
	TextBlock,
} from "babylonjs-gui";
import {
	applyGUIAuthoringRuntime,
	announceGUIAccessibility,
	auditGUIAccessibility,
	createDefaultGUIAuthoringState,
	describeGUIControls,
	detachGUIAuthoringRuntime,
	findGUIControlById as findSharedGUIControlById,
	getGUIAuthoringState,
	getGUIAccessibilityRuntimeEvidence,
	getGUIAtlasTextRuntimeEvidence,
	getGUIUsageTrackingEvidence,
	getGUIPanelRendererEvidence,
	guiAtlasTextModel,
	guiAtlasTextRuntimeMetadataKey,
	guiControlIdentityMetadataKey,
	guiInternalControlMetadataKey,
	guiCanvasGroupMetadataKey,
	guiRaycastReceiverMetadataKey,
	guiRetainedControlMetadataKey,
	guiRetainedDocumentModel,
	compileGUIRetainedDocument,
	inspectGUIRetainedUXMLReferences,
	IGUIAtlasTextAssignment,
	IGUIAuthoringState,
	IGUIAccessibilityAuditControl,
	IGUIAccessibilityNode,
	IGUIControlDescription,
	IGUIEventBinding,
	IGUIFontAssignment,
	IGUIRetainedCompilation,
	IGUIRetainedDocumentState,
	IGUIAnimationTrack,
	IGUIAttributeOverride,
	IGUIPanelRendererSettings,
	IGUIVisualElementReference,
	createGUIPanelRendererTexture,
	normalizeGUIAtlasTextAssignment,
	resetGUIUsageTrackingEvidence,
	releaseGUIPanelRendererTexture,
	focusGUIAccessibilityNode,
	invokeGUIAccessibilityAction,
	normalizeGUIToolkitState,
	planGUIUXMLUpgrades,
	setGUIAuthoringState,
} from "babylonjs-editor-tools";

import { applyImportedGuiFile } from "../../editor/layout/preview/import/gui";
import { getProjectAssetsRootUrl, projectConfiguration } from "../../project/configuration";
import { isAdvancedDynamicTexture } from "../../tools/guards/texture";
import { installEditorGUIFontFamily, loadEditorGUIFontAsset } from "../../tools/gui/authoring";
import { configureEditorLocalization } from "../localization/localization";

import { IMCPActionOptions } from "../action";

function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function resolveProjectPath(path: string): string {
	const projectDirectory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(projectDirectory, path));
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error("GUI paths must stay inside the open project directory.");
	}
	return absolutePath;
}

async function assertProjectPathHasNoSymbolicLinks(absolutePath: string, requireRegularFile: boolean): Promise<void> {
	const projectDirectory = getProjectDirectory();
	const projectRelative = relative(projectDirectory, absolutePath);
	let current = projectDirectory;
	for (const segment of projectRelative.split("/").filter(Boolean)) {
		current = join(current, segment);
		try {
			const status = await lstat(current);
			if (status.isSymbolicLink()) {
				throw new Error(`GUI project path may not traverse symbolic links: ${projectRelative}`);
			}
			if (current === absolutePath && requireRegularFile && !status.isFile()) {
				throw new Error(`GUI project source must be a regular file: ${projectRelative}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && !requireRegularFile) {
				return;
			}
			throw error;
		}
	}
}

function serializeGui(gui: AdvancedDynamicTexture): any {
	const data = gui.serialize();
	data.uniqueId = gui.uniqueId;
	data.content = gui.serializeContent();
	data.zvibeGUIAuthoring = getGUIAuthoringState(gui);
	data.guiType = data.zvibeGUIAuthoring.toolkit.panelRenderer.renderMode === "worldSpace" ? "worldSpace" : "fullscreen";
	return data;
}

interface ILoadedGUIRetainedProjectSources {
	uxmlPath: string;
	uxml: string;
	stylesheets: Array<{ path: string; source: string }>;
	templates: Array<{ path: string; source: string }>;
}

async function readGUIRetainedSource(path: string, extension: ".uxml" | ".uss"): Promise<{ path: string; source: string }> {
	const absolutePath = resolveProjectPath(path);
	const projectPath = relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/");
	if (!projectPath.toLowerCase().endsWith(extension)) {
		throw new Error(`Retained UI source "${projectPath}" must end in ${extension}.`);
	}
	if (!(await pathExists(absolutePath))) {
		throw new Error(`Retained UI source was not found: ${projectPath}`);
	}
	await assertProjectPathHasNoSymbolicLinks(absolutePath, true);
	return { path: projectPath, source: await readFile(absolutePath, "utf8") };
}

async function loadGUIRetainedProjectSources(path: string): Promise<ILoadedGUIRetainedProjectSources> {
	const root = await readGUIRetainedSource(path, ".uxml");
	const templates = new Map<string, { path: string; source: string }>();
	const stylesheets = new Map<string, { path: string; source: string }>();
	const pending = [root];
	const inspected = new Set<string>();
	while (pending.length) {
		const source = pending.shift()!;
		if (inspected.has(source.path)) {
			continue;
		}
		inspected.add(source.path);
		const references = inspectGUIRetainedUXMLReferences(source.source, source.path);
		for (const stylesheetPath of references.stylesheetPaths) {
			if (!stylesheets.has(stylesheetPath)) {
				stylesheets.set(stylesheetPath, await readGUIRetainedSource(stylesheetPath, ".uss"));
			}
		}
		for (const template of references.templates) {
			if (!templates.has(template.path)) {
				const loaded = await readGUIRetainedSource(template.path, ".uxml");
				templates.set(template.path, loaded);
				pending.push(loaded);
			}
		}
		if (inspected.size + templates.size + stylesheets.size > 128) {
			throw new Error("Retained UI source graph exceeds 128 files.");
		}
	}
	return { uxmlPath: root.path, uxml: root.source, stylesheets: [...stylesheets.values()], templates: [...templates.values()] };
}

async function compileGUIRetainedProjectDocument(
	path: string,
	stylesheetOrder?: string[]
): Promise<{ sources: ILoadedGUIRetainedProjectSources; compiled: IGUIRetainedCompilation }> {
	const sources = await loadGUIRetainedProjectSources(path);
	const compiled = await compileGUIRetainedDocument({ ...sources, stylesheetOrder: stylesheetOrder?.length ? stylesheetOrder : undefined });
	return { sources, compiled };
}

function createGUIRetainedControlTree(compiled: IGUIRetainedCompilation): { roots: Control[]; controls: Map<string, Control> } {
	const controls = new Map<string, Control>();
	const roots: Control[] = [];
	try {
		for (const definition of compiled.controls) {
			const control = createControl(definition.kind, definition.name, definition.properties as IGUIControlProperties);
			control.metadata = {
				...(control.metadata ?? {}),
				[guiControlIdentityMetadataKey]: definition.id,
				[guiRetainedControlMetadataKey]: {
					model: guiRetainedDocumentModel,
					sourceName: definition.sourceName,
					typeName: definition.typeName,
					classes: definition.classes,
					pseudoStyles: definition.pseudoStyles,
					tooltip: definition.tooltip,
					bindingPath: definition.bindingPath,
				},
			};
			if (definition.tabIndex !== null) {
				control.tabIndex = definition.tabIndex;
			}
			controls.set(definition.id, control);
			if (definition.parentId) {
				const parent = controls.get(definition.parentId);
				if (!parent || typeof (parent as unknown as { addControl?: unknown }).addControl !== "function") {
					throw new Error(`Compiled retained control "${definition.id}" has non-container parent "${definition.parentId}".`);
				}
				(parent as Container).addControl(control);
			} else {
				roots.push(control);
			}
		}
		return { roots, controls };
	} catch (error) {
		roots.forEach((root) => root.dispose());
		throw error;
	}
}

async function replaceGUIWithRetainedCompilation(params: {
	gui: AdvancedDynamicTexture;
	current: IGUIAuthoringState;
	expectedRevision: number;
	compiled: IGUIRetainedCompilation;
	uxmlPath: string;
	hotReload: boolean;
	sourceRevision: number;
	options: IMCPActionOptions;
}): Promise<IGUIAuthoringState> {
	const { gui, current, expectedRevision, compiled, uxmlPath, hotReload, sourceRevision, options } = params;
	const tree = createGUIRetainedControlTree(compiled);
	const retainedDocument: IGUIRetainedDocumentState = {
		model: guiRetainedDocumentModel,
		uxmlPath,
		stylesheetPaths: compiled.sources.filter((source) => source.kind === "uss").map((source) => source.path),
		templatePaths: compiled.sources.filter((source) => source.kind === "template").map((source) => source.path),
		hotReload,
		sourceRevision,
		compiled,
	};
	const ownedIds = new Set(compiled.controls.map((control) => control.id));
	const stylesheetOrder = compiled.sources.filter((source) => source.kind === "uss").map((source) => source.path);
	const previousStage = current.toolkit.stylesheetStage;
	const next: IGUIAuthoringState = {
		...current,
		bindings: current.bindings.filter((binding) => ownedIds.has(binding.controlId)),
		fonts: current.fonts.filter((font) => ownedIds.has(font.controlId)),
		atlasTexts: current.atlasTexts.filter((assignment) => ownedIds.has(assignment.controlId)),
		localizations: current.localizations.filter((binding) => ownedIds.has(binding.controlId)),
		accessibility: { ...current.accessibility, nodes: current.accessibility.nodes.filter((node) => ownedIds.has(node.controlId)) },
		canvasGroups: compiled.controls
			.filter((control) => control.kind === "canvasGroup")
			.map((control) => ({
				controlId: control.id,
				alpha: control.properties.alpha ?? 1,
				interactable: control.properties.interactable ?? true,
				blocksRaycasts: control.properties.blocksRaycasts ?? true,
				ignoreParentGroups: control.properties.ignoreParentGroups ?? false,
			})),
		raycastReceivers: compiled.controls.filter((control) => control.kind === "raycastReceiver").map((control) => ({ controlId: control.id, enabled: true })),
		toolkit: {
			...current.toolkit,
			references: current.toolkit.references.filter((reference) => ownedIds.has(reference.controlId)),
			attributeOverrides: current.toolkit.attributeOverrides.filter((override) => ownedIds.has(override.controlId)),
			animations: current.toolkit.animations.filter((animation) => ownedIds.has(animation.controlId)),
			stylesheetStage: {
				contextId: previousStage.contextId,
				activeStylesheetPath:
					previousStage.activeStylesheetPath && stylesheetOrder.includes(previousStage.activeStylesheetPath)
						? previousStage.activeStylesheetPath
						: (stylesheetOrder[0] ?? null),
				stylesheetOrder,
			},
		},
		retainedDocument,
	};
	const before = captureGUISnapshot(gui);
	try {
		gui.rootContainer.clearControls();
		tree.roots.forEach((root) => gui.rootContainer.addControl(root));
		gui.metadata = { ...(gui.metadata ?? {}), zvibeGUIAuthoring: { ...next, revision: current.revision } };
		return await commitGUIState({ gui, expectedRevision, nextState: next, options, rollbackSnapshot: before });
	} catch (error) {
		if (gui.rootContainer.children.some((control) => tree.roots.includes(control))) {
			await restoreGUISnapshot(gui, before, options);
		}
		throw error;
	}
}

export function findGui(scene: Scene, data: any): AdvancedDynamicTexture {
	const gui = scene.textures.find((texture) => isAdvancedDynamicTexture(texture) && (texture.uniqueId.toString() === data.guiId || texture.name === data.guiName)) as
		| AdvancedDynamicTexture
		| undefined;
	if (!gui) {
		throw new Error("Fullscreen GUI not found. Provide guiId (preferred) or guiName.");
	}
	return gui;
}

function finitePixels(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0 ? value : null;
	}
	if (typeof value !== "string" || !value.trim().endsWith("px")) {
		return null;
	}
	const numeric = Number.parseFloat(value);
	return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

async function sampleGUIImage(control: any): Promise<Array<[number, number, number, number]> | null> {
	const image = control.domImage as CanvasImageSource | null | undefined;
	if (!image || typeof document === "undefined") {
		return null;
	}
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 16;
		canvas.height = 16;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) {
			return null;
		}
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
		const samples: Array<[number, number, number, number]> = [];
		for (let index = 0; index < bytes.length; index += 4) {
			samples.push([bytes[index], bytes[index + 1], bytes[index + 2], bytes[index + 3] / 255]);
		}
		return samples;
	} catch {
		// Cross-origin or not-yet-decoded images remain an explicit unresolved audit warning.
		return null;
	}
}

async function accessibilityAuditControls(gui: AdvancedDynamicTexture): Promise<IGUIAccessibilityAuditControl[]> {
	const descriptions = describeGUIControls(gui);
	return Promise.all(
		descriptions.map(async (description) => {
			const control = findGUIControlById(gui, description.id) as any;
			const currentMeasure = control?._currentMeasure as { width?: number; height?: number } | undefined;
			const imageBacked = Boolean(control?.domImage || (typeof control?.source === "string" && control.source));
			return {
				...description,
				text: typeof control?.text === "string" ? control.text.replace(/[\u2066-\u2069]/g, "").trim() : "",
				fontSize: finitePixels(control?.fontSize),
				fontWeight: typeof control?.fontWeight === "string" ? control.fontWeight : "normal",
				foreground: typeof control?.color === "string" ? control.color : null,
				background: typeof control?.background === "string" ? control.background : null,
				alpha: typeof control?.alpha === "number" && Number.isFinite(control.alpha) ? Math.max(0, Math.min(1, control.alpha)) : 1,
				width: finitePixels(currentMeasure?.width) ?? finitePixels(control?.width),
				height: finitePixels(currentMeasure?.height) ?? finitePixels(control?.height),
				visible: control?.isVisible !== false,
				enabled: control?.isEnabled !== false,
				hasImageBackground: imageBacked,
				backgroundSamples: imageBacked ? await sampleGUIImage(control) : null,
			};
		})
	);
}

/** Audits authored semantics, keyboard focus, target sizing, alpha composition, and sampled image-backed contrast without mutation. */
export async function validateGUIAccessibility(scene: Scene, data: any): Promise<any> {
	const guis = data.guiId || data.guiName ? [findGui(scene, data)] : (scene.textures.filter((texture) => isAdvancedDynamicTexture(texture)) as AdvancedDynamicTexture[]);
	const reports = await Promise.all(
		guis.map(async (gui) => ({
			id: gui.uniqueId.toString(),
			name: gui.name,
			...auditGUIAccessibility(await accessibilityAuditControls(gui), getGUIAuthoringState(gui).accessibility),
		}))
	);
	const issues = reports.flatMap((report) => report.issues.map((issue) => ({ guiId: report.id, guiName: report.name, ...issue })));
	return {
		guiCount: guis.length,
		controlCount: reports.reduce((sum, report) => sum + report.controlCount, 0),
		errorCount: issues.filter((issue) => issue.severity === "error").length,
		warningCount: issues.filter((issue) => issue.severity === "warning").length,
		issues,
		reports,
	};
}

export function listGUIs(scene: Scene): any {
	return {
		guis: scene.textures
			.filter((texture) => isAdvancedDynamicTexture(texture))
			.map((texture) => {
				const gui = texture as AdvancedDynamicTexture;
				const state = getGUIAuthoringState(gui);
				return {
					id: gui.uniqueId.toString(),
					name: gui.name,
					size: { width: gui.getSize().width, height: gui.getSize().height },
					controlCount: gui.rootContainer.children.length,
					panelRenderer: getGUIPanelRendererEvidence(gui, state.toolkit.panelRenderer),
				};
			}),
	};
}

export async function createGUIAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (extname(data.path).toLowerCase() !== ".gui") {
		throw new Error("GUI asset paths must end in .gui.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (await pathExists(absolutePath)) {
		throw new Error(`An asset already exists at: ${data.path}`);
	}

	const gui = AdvancedDynamicTexture.CreateFullscreenUI(data.name ?? "New GUI", true, scene);
	try {
		gui.metadata = { ...(gui.metadata ?? {}), zvibeGUIAuthoring: createDefaultGUIAuthoringState() };
		await writeJSON(absolutePath, serializeGui(gui), { spaces: "\t", encoding: "utf-8" });
	} finally {
		gui.dispose();
	}
	options.editor.layout.assets.refresh();
	return { created: true, path: relative(getProjectDirectory(), absolutePath) };
}

export async function instantiateGUIAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (extname(absolutePath).toLowerCase() !== ".gui") {
		throw new Error("Only .gui assets can be instantiated.");
	}
	const gui = await applyImportedGuiFile(options.editor, absolutePath);
	if (!gui) {
		throw new Error(`Unable to instantiate GUI asset: ${data.path}`);
	}
	options.editor.layout.inspector.setEditedObject(gui);
	return { id: gui.uniqueId.toString(), name: gui.name, path: relative(getProjectDirectory(), absolutePath) };
}

/** Disposes one live GUI instance after verifying its exact authoring revision. Saved .gui assets are deleted separately through delete_asset. */
export function deleteGUIInstance(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Deleting a live GUI instance requires confirm: true.");
	}
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	if (state.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${state.revision}.`);
	}
	const result = {
		id: gui.uniqueId.toString(),
		name: gui.name,
		revision: state.revision,
		controlCount: describeGUIControls(gui).length,
	};
	detachGUIAuthoringRuntime(gui);
	const release = releaseGUIPanelRendererTexture(gui, state.toolkit.panelRenderer.releaseRootOnDispose);
	options.editor.layout.inspector.setEditedObject(scene);
	return { ...result, ...release, disposed: true };
}

export function getGUIContent(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	return { id: gui.uniqueId.toString(), name: gui.name, content: gui.serializeContent() };
}

export function setGUIContent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const gui = findGui(scene, data);
	const previous = captureGUISnapshot(gui);
	if (data.content !== undefined && previous.authoring.retainedDocument) {
		throw new Error("GUI hierarchy is owned by a retained UXML/USS document. Edit and refresh that source or detach retained authoring before replacing serialized content.");
	}
	if (data.name !== undefined) {
		gui.name = data.name;
	}
	try {
		if (data.content !== undefined) {
			gui.rootContainer.clearControls?.();
			gui.parseSerializedObject(data.content, false);
		}
		const controls = new Set(describeGUIControls(gui).map((control) => control.id));
		const reconciled = {
			...previous.authoring,
			bindings: previous.authoring.bindings.filter((binding) => controls.has(binding.controlId)),
			fonts: previous.authoring.fonts.filter((font) => controls.has(font.controlId)),
			atlasTexts: previous.authoring.atlasTexts.filter((assignment) => controls.has(assignment.controlId)),
			localizations: previous.authoring.localizations.filter((binding) => controls.has(binding.controlId)),
			accessibility: { ...previous.authoring.accessibility, nodes: previous.authoring.accessibility.nodes.filter((node) => controls.has(node.controlId)) },
			canvasGroups: previous.authoring.canvasGroups.filter((assignment) => controls.has(assignment.controlId)),
			raycastReceivers: previous.authoring.raycastReceivers.filter((assignment) => controls.has(assignment.controlId)),
		};
		const state = setGUIAuthoringState(gui, previous.authoring.revision, reconciled);
		void applyGUIAuthoringRuntime(gui, state, optionsForGUI(options)).catch((error) =>
			options.editor.layout.console.error(error instanceof Error ? error.message : String(error))
		);
		notifyGUIChanged(gui, options);
		return { id: gui.uniqueId.toString(), name: gui.name, controlCount: describeGUIControls(gui).length, revision: state.revision };
	} catch (error) {
		void restoreGUISnapshot(gui, previous, options);
		throw error;
	}
}

export async function saveGUIAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	if (extname(data.path).toLowerCase() !== ".gui") {
		throw new Error("GUI asset paths must end in .gui.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if ((await pathExists(absolutePath)) && data.overwrite !== true) {
		throw new Error(`GUI asset already exists at ${data.path}. Set overwrite: true to replace it.`);
	}
	await writeJSON(absolutePath, serializeGui(gui), { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { saved: true, path: relative(getProjectDirectory(), absolutePath) };
}

export async function getGUIAsset(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (extname(absolutePath).toLowerCase() !== ".gui") {
		throw new Error("GUI asset paths must end in .gui.");
	}
	return readJSON(absolutePath, { encoding: "utf-8" });
}

export type GUIControlKind =
	| "container"
	| "rectangle"
	| "ellipse"
	| "text"
	| "button"
	| "image"
	| "stackPanel"
	| "grid"
	| "scrollViewer"
	| "checkbox"
	| "radioButton"
	| "slider"
	| "inputText"
	| "inputTextArea"
	| "canvasGroup"
	| "raycastReceiver";

export interface IGUIControlProperties {
	name?: string;
	width?: string;
	height?: string;
	left?: string;
	top?: string;
	horizontalAlignment?: "left" | "center" | "right";
	verticalAlignment?: "top" | "center" | "bottom";
	alpha?: number;
	zIndex?: number;
	isVisible?: boolean;
	isEnabled?: boolean;
	isHitTestVisible?: boolean;
	color?: string;
	background?: string;
	fontSize?: number;
	text?: string;
	source?: string;
	thickness?: number;
	cornerRadius?: number;
	spacing?: number;
	isVertical?: boolean;
	minimum?: number;
	maximum?: number;
	value?: number;
	isChecked?: boolean;
	interactable?: boolean;
	blocksRaycasts?: boolean;
	ignoreParentGroups?: boolean;
	paddingLeft?: string;
	paddingTop?: string;
	paddingRight?: string;
	paddingBottom?: string;
}

export interface IGUISnapshot {
	name: string;
	content: Record<string, unknown>;
	authoring: IGUIAuthoringState;
}

interface IGUIControlRecord extends IGUIControlDescription {
	properties: Record<string, unknown>;
}

function findGUIControlById(gui: AdvancedDynamicTexture, controlId: string): Control | null {
	return findSharedGUIControlById(gui, controlId) as unknown as Control | null;
}

function optionsForGUI(options: IMCPActionOptions): Parameters<typeof applyGUIAuthoringRuntime>[2] {
	return {
		rootUrl: getProjectAssetsRootUrl() ?? "",
		scene: options.editor.layout.preview.scene,
		loadFontFamily: installEditorGUIFontFamily,
		loadFontAsset: loadEditorGUIFontAsset,
	};
}

function notifyGUIChanged(gui: AdvancedDynamicTexture, options: IMCPActionOptions): void {
	options.editor.layout.inspector.setEditedObject(gui);
	options.editor.layout.inspector.forceUpdate();
}

function validateDimension(value: string, label: string): void {
	if (!/^-?\d+(?:\.\d+)?(?:px|%)$/.test(value)) {
		throw new Error(`${label} must use a finite pixel or percentage value such as "320px" or "50%".`);
	}
}

function validateControlProperties(properties: IGUIControlProperties): void {
	if (properties.name !== undefined && (!properties.name.trim() || properties.name.length > 128)) {
		throw new Error("GUI control name must contain 1-128 characters.");
	}
	for (const property of ["width", "height", "left", "top"] as const) {
		if (properties[property] !== undefined) {
			validateDimension(properties[property]!, `GUI control ${property}`);
		}
	}
	for (const property of ["paddingLeft", "paddingTop", "paddingRight", "paddingBottom"] as const) {
		if (properties[property] !== undefined) {
			validateDimension(properties[property]!, `GUI control ${property}`);
			if (properties[property]!.startsWith("-")) {
				throw new Error(`GUI control ${property} cannot be negative.`);
			}
		}
	}
	if (properties.alpha !== undefined && (!Number.isFinite(properties.alpha) || properties.alpha < 0 || properties.alpha > 1)) {
		throw new Error("GUI control alpha must be between 0 and 1.");
	}
	if (properties.zIndex !== undefined && (!Number.isInteger(properties.zIndex) || properties.zIndex < -32768 || properties.zIndex > 32767)) {
		throw new Error("GUI control zIndex must be an integer between -32,768 and 32,767.");
	}
	if (properties.fontSize !== undefined && (!Number.isFinite(properties.fontSize) || properties.fontSize < 1 || properties.fontSize > 1024)) {
		throw new Error("GUI font size must be between 1 and 1,024 pixels.");
	}
	if (properties.text !== undefined && properties.text.length > 16384) {
		throw new Error("GUI control text is limited to 16,384 characters.");
	}
	if (properties.source !== undefined && properties.source.length > 4096) {
		throw new Error("GUI image source is limited to 4,096 characters.");
	}
	for (const property of ["thickness", "cornerRadius", "spacing"] as const) {
		const value = properties[property];
		if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 4096)) {
			throw new Error(`GUI control ${property} must be between 0 and 4,096.`);
		}
	}
	for (const property of ["minimum", "maximum", "value"] as const) {
		const value = properties[property];
		if (value !== undefined && !Number.isFinite(value)) {
			throw new Error(`GUI control ${property} must be finite.`);
		}
	}
	if (properties.minimum !== undefined && properties.maximum !== undefined && properties.minimum >= properties.maximum) {
		throw new Error("GUI slider minimum must be less than maximum.");
	}
	for (const property of ["interactable", "blocksRaycasts", "ignoreParentGroups"] as const) {
		if (properties[property] !== undefined && typeof properties[property] !== "boolean") {
			throw new Error(`GUI CanvasGroup ${property} must be boolean.`);
		}
	}
}

function applyControlProperties(control: Control, properties: IGUIControlProperties): void {
	validateControlProperties(properties);
	if (properties.name !== undefined) {
		control.name = properties.name.trim();
	}
	if (properties.width !== undefined) {
		control.width = properties.width;
	}
	if (properties.height !== undefined) {
		control.height = properties.height;
	}
	if (properties.left !== undefined) {
		control.left = properties.left;
	}
	if (properties.top !== undefined) {
		control.top = properties.top;
	}
	if (properties.horizontalAlignment !== undefined) {
		control.horizontalAlignment =
			properties.horizontalAlignment === "left"
				? Control.HORIZONTAL_ALIGNMENT_LEFT
				: properties.horizontalAlignment === "right"
					? Control.HORIZONTAL_ALIGNMENT_RIGHT
					: Control.HORIZONTAL_ALIGNMENT_CENTER;
	}
	if (properties.verticalAlignment !== undefined) {
		control.verticalAlignment =
			properties.verticalAlignment === "top"
				? Control.VERTICAL_ALIGNMENT_TOP
				: properties.verticalAlignment === "bottom"
					? Control.VERTICAL_ALIGNMENT_BOTTOM
					: Control.VERTICAL_ALIGNMENT_CENTER;
	}
	if (properties.alpha !== undefined) {
		control.alpha = properties.alpha;
	}
	if (properties.zIndex !== undefined) {
		control.zIndex = properties.zIndex;
	}
	if (properties.isVisible !== undefined) {
		control.isVisible = properties.isVisible;
	}
	if (properties.isEnabled !== undefined) {
		control.isEnabled = properties.isEnabled;
	}
	if (properties.isHitTestVisible !== undefined) {
		control.isHitTestVisible = properties.isHitTestVisible;
	}
	const dynamic = control as unknown as Record<string, unknown>;
	for (const property of [
		"color",
		"background",
		"fontSize",
		"source",
		"thickness",
		"cornerRadius",
		"spacing",
		"isVertical",
		"minimum",
		"maximum",
		"value",
		"isChecked",
		"paddingLeft",
		"paddingTop",
		"paddingRight",
		"paddingBottom",
	] as const) {
		if (properties[property] !== undefined && property in dynamic) {
			dynamic[property] = properties[property];
		}
	}
	if (properties.text !== undefined) {
		if ("text" in dynamic) {
			dynamic.text = properties.text;
		} else if (control instanceof Button) {
			const text = control.children.find((child) => child instanceof TextBlock) as TextBlock | undefined;
			if (text) {
				text.text = properties.text;
			}
		}
	}
}

function authoredValueAndUnit(control: Control, property: "width" | "height" | "left" | "top" | "fontSize"): string | number {
	const internal = (control as unknown as Record<string, unknown>)[`_${property}`] as { toString?: (host?: unknown) => string } | undefined;
	if (typeof internal?.toString === "function") {
		return internal.toString();
	}
	return (control as unknown as Record<string, string | number>)[property];
}

function controlProperties(control: Control): Record<string, unknown> {
	const dynamic = control as unknown as Record<string, unknown>;
	const properties: Record<string, unknown> = {
		name: control.name,
		width: authoredValueAndUnit(control, "width"),
		height: authoredValueAndUnit(control, "height"),
		left: authoredValueAndUnit(control, "left"),
		top: authoredValueAndUnit(control, "top"),
		horizontalAlignment:
			control.horizontalAlignment === Control.HORIZONTAL_ALIGNMENT_LEFT ? "left" : control.horizontalAlignment === Control.HORIZONTAL_ALIGNMENT_RIGHT ? "right" : "center",
		verticalAlignment:
			control.verticalAlignment === Control.VERTICAL_ALIGNMENT_TOP ? "top" : control.verticalAlignment === Control.VERTICAL_ALIGNMENT_BOTTOM ? "bottom" : "center",
		alpha: control.alpha,
		zIndex: control.zIndex,
		isVisible: control.isVisible,
		isEnabled: control.isEnabled,
		isHitTestVisible: control.isHitTestVisible,
	};
	for (const property of [
		"color",
		"background",
		"fontFamily",
		"fontStyle",
		"fontWeight",
		"source",
		"thickness",
		"cornerRadius",
		"spacing",
		"isVertical",
		"minimum",
		"maximum",
		"value",
		"isChecked",
		"paddingLeft",
		"paddingTop",
		"paddingRight",
		"paddingBottom",
	] as const) {
		if (property in dynamic && ["string", "number", "boolean"].includes(typeof dynamic[property])) {
			properties[property] = dynamic[property];
		}
	}
	if ("fontSize" in dynamic) {
		properties.fontSize = authoredValueAndUnit(control, "fontSize");
	}
	if ("text" in dynamic && typeof dynamic.text === "string") {
		properties.text = dynamic.text;
	} else if (control instanceof Button) {
		const text = control.children.find((child) => child instanceof TextBlock) as TextBlock | undefined;
		if (text) {
			properties.text = text.text;
		}
	}
	return properties;
}

function authoredControlProperties(control: Control, controlId: string, state: IGUIAuthoringState): Record<string, unknown> {
	const properties = controlProperties(control);
	const canvasGroup = state.canvasGroups.find((assignment) => assignment.controlId === controlId);
	if (canvasGroup) {
		properties.alpha = canvasGroup.alpha;
		properties.interactable = canvasGroup.interactable;
		properties.blocksRaycasts = canvasGroup.blocksRaycasts;
		properties.ignoreParentGroups = canvasGroup.ignoreParentGroups;
	}
	const receiver = state.raycastReceivers.find((assignment) => assignment.controlId === controlId);
	if (receiver) {
		properties.receiverEnabled = receiver.enabled;
	}
	return properties;
}

function createControl(kind: GUIControlKind, name: string, properties: IGUIControlProperties): Control {
	let control: Control;
	switch (kind) {
		case "container":
			control = new Container(name);
			break;
		case "rectangle":
			control = new Rectangle(name);
			break;
		case "ellipse":
			control = new Ellipse(name);
			break;
		case "text":
			control = new TextBlock(name, properties.text ?? "Text");
			break;
		case "button":
			control = Button.CreateSimpleButton(name, properties.text ?? "Button");
			(control as Button).children.forEach((child) => {
				child.metadata = { ...(child.metadata ?? {}), [guiInternalControlMetadataKey]: true };
			});
			break;
		case "image":
			control = new Image(name, properties.source ?? null);
			break;
		case "stackPanel":
			control = new StackPanel(name);
			break;
		case "grid":
			control = new Grid(name);
			break;
		case "scrollViewer":
			control = new ScrollViewer(name);
			break;
		case "checkbox":
			control = new Checkbox(name);
			break;
		case "radioButton":
			control = new RadioButton(name);
			break;
		case "slider":
			control = new Slider(name);
			break;
		case "inputText":
			control = new InputText(name, properties.text ?? "");
			break;
		case "inputTextArea":
			control = new InputTextArea(name, properties.text ?? "");
			break;
		case "canvasGroup":
			control = new Container(name);
			control.metadata = { ...(control.metadata ?? {}), [guiCanvasGroupMetadataKey]: true };
			break;
		case "raycastReceiver":
			control = new Rectangle(name);
			(control as Rectangle).thickness = 0;
			(control as Rectangle).background = "";
			control.isPointerBlocker = true;
			control.metadata = { ...(control.metadata ?? {}), [guiRaycastReceiverMetadataKey]: true };
			break;
		default:
			throw new Error(`Unsupported GUI control type: ${kind}`);
	}
	const nativeProperties =
		kind === "canvasGroup" ? { ...properties, alpha: undefined, interactable: undefined, blocksRaycasts: undefined, ignoreParentGroups: undefined } : properties;
	applyControlProperties(control, { ...nativeProperties, name });
	return control;
}

function containerForId(gui: AdvancedDynamicTexture, controlId: string | null | undefined): Container {
	if (!controlId) {
		return gui.rootContainer;
	}
	const control = findGUIControlById(gui, controlId);
	if (!control) {
		throw new Error(`GUI parent control "${controlId}" was not found.`);
	}
	if (typeof (control as unknown as { addControl?: unknown }).addControl !== "function") {
		throw new Error(`GUI control "${controlId}" cannot contain child controls.`);
	}
	return control as Container;
}

function descendantIds(control: Control): string[] {
	const result: string[] = [];
	const visit = (entry: Control): void => {
		const id = (entry.metadata as Record<string, unknown> | null)?.[guiControlIdentityMetadataKey];
		if (typeof id === "string") {
			result.push(id);
		}
		const children = (entry as unknown as { children?: Control[] }).children;
		children?.forEach(visit);
	};
	visit(control);
	return result;
}

function parentContainer(gui: AdvancedDynamicTexture, target: Control): Container | null {
	let result: Container | null = null;
	const visit = (container: Container): void => {
		for (const child of container.children) {
			if (child === target) {
				result = container;
				return;
			}
			if (child instanceof Container) {
				visit(child);
			}
			if (result) {
				return;
			}
		}
	};
	visit(gui.rootContainer);
	return result;
}

export function captureGUISnapshot(gui: AdvancedDynamicTexture): IGUISnapshot {
	return { name: gui.name, content: JSON.parse(JSON.stringify(gui.serializeContent())), authoring: getGUIAuthoringState(gui) };
}

export async function restoreGUISnapshot(gui: AdvancedDynamicTexture, snapshot: IGUISnapshot, options: IMCPActionOptions): Promise<void> {
	gui.rootContainer.clearControls();
	gui.parseSerializedObject(JSON.parse(JSON.stringify(snapshot.content)), false);
	gui.name = snapshot.name;
	gui.metadata = { ...(gui.metadata ?? {}), zvibeGUIAuthoring: JSON.parse(JSON.stringify(snapshot.authoring)) };
	await applyGUIAuthoringRuntime(gui, snapshot.authoring, optionsForGUI(options));
	notifyGUIChanged(gui, options);
}

async function commitGUIState(params: {
	gui: AdvancedDynamicTexture;
	expectedRevision: number;
	nextState: IGUIAuthoringState;
	options: IMCPActionOptions;
	rollbackSnapshot?: IGUISnapshot;
}): Promise<IGUIAuthoringState> {
	const { gui, expectedRevision, nextState, options, rollbackSnapshot = captureGUISnapshot(gui) } = params;
	try {
		if (nextState.localizations.length) {
			await configureEditorLocalization(options.editor.layout.preview.scene);
		}
		const state = setGUIAuthoringState(gui, expectedRevision, nextState);
		await applyGUIAuthoringRuntime(gui, state, optionsForGUI(options));
		notifyGUIChanged(gui, options);
		return state;
	} catch (error) {
		await restoreGUISnapshot(gui, rollbackSnapshot, options);
		throw error;
	}
}

function assertGUIRetainedHierarchyDetached(state: IGUIAuthoringState, operation: string): void {
	if (state.retainedDocument) {
		throw new Error(
			`GUI hierarchy is owned by retained UXML/USS source "${state.retainedDocument.uxmlPath}". Edit and refresh that source or detach retained authoring before ${operation}.`
		);
	}
}

export function getGUIAuthoring(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	const controls = describeGUIControls(gui);
	const offset = Math.max(0, Math.min(controls.length, Number.isInteger(data.offset) ? data.offset : 0));
	const limit = Math.max(1, Math.min(200, Number.isInteger(data.limit) ? data.limit : 50));
	const items: IGUIControlRecord[] = controls.slice(offset, offset + limit).map((description) => ({
		...description,
		properties: authoredControlProperties(findGUIControlById(gui, description.id)!, description.id, state),
	}));
	return {
		id: gui.uniqueId.toString(),
		name: gui.name,
		authoring: state,
		atlasTextRuntime: getGUIAtlasTextRuntimeEvidence(gui),
		controls: { total: controls.length, count: items.length, offset, hasMore: offset + items.length < controls.length, items },
	};
}

/** Sets or replaces one text/source localization binding under the GUI's exact authoring revision. */
export async function setGUILocalizationBinding(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (!findGUIControlById(gui, data.binding.controlId)) {
		throw new Error(`GUI control "${data.binding.controlId}" was not found.`);
	}
	const localizations = current.localizations.filter((binding) => binding.controlId !== data.binding.controlId || binding.property !== data.binding.property);
	localizations.push(data.binding);
	const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: { ...current, localizations }, options });
	return {
		id: gui.uniqueId.toString(),
		revision: state.revision,
		binding: state.localizations.find((binding) => binding.controlId === data.binding.controlId && binding.property === data.binding.property),
	};
}

/** Removes one persisted localization property binding and restores its authored control value. */
export async function deleteGUILocalizationBinding(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (!current.localizations.some((binding) => binding.controlId === data.controlId && binding.property === data.property)) {
		throw new Error(`GUI localization binding "${data.controlId}/${data.property}" was not found.`);
	}
	const state = await commitGUIState({
		gui,
		expectedRevision: data.expectedRevision,
		nextState: { ...current, localizations: current.localizations.filter((binding) => binding.controlId !== data.controlId || binding.property !== data.property) },
		options,
	});
	return { id: gui.uniqueId.toString(), revision: state.revision, deletedControlId: data.controlId, deletedProperty: data.property };
}

/** Updates GUI-wide accessibility enablement and system preference policy. */
export async function setGUIAccessibilitySettings(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	const state = await commitGUIState({
		gui,
		expectedRevision: data.expectedRevision,
		nextState: { ...current, accessibility: { ...current.accessibility, settings: { ...current.accessibility.settings, ...data.settings } } },
		options,
	});
	return { id: gui.uniqueId.toString(), revision: state.revision, settings: state.accessibility.settings, runtime: getGUIAccessibilityRuntimeEvidence(gui) };
}

/** Sets one semantic node for an exact GUI control. */
export async function setGUIAccessibilityNode(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (!findGUIControlById(gui, data.node.controlId)) {
		throw new Error(`GUI control "${data.node.controlId}" was not found.`);
	}
	const nodes = current.accessibility.nodes.filter((node) => node.controlId !== data.node.controlId);
	nodes.push(data.node as IGUIAccessibilityNode);
	const state = await commitGUIState({
		gui,
		expectedRevision: data.expectedRevision,
		nextState: { ...current, accessibility: { ...current.accessibility, nodes } },
		options,
	});
	return {
		id: gui.uniqueId.toString(),
		revision: state.revision,
		node: state.accessibility.nodes.find((node) => node.controlId === data.node.controlId),
		runtime: getGUIAccessibilityRuntimeEvidence(gui),
	};
}

/** Deletes one authored semantic node; automatic text exposure may still represent its control. */
export async function deleteGUIAccessibilityNode(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (!current.accessibility.nodes.some((node) => node.controlId === data.controlId)) {
		throw new Error(`GUI accessibility node "${data.controlId}" was not found.`);
	}
	const state = await commitGUIState({
		gui,
		expectedRevision: data.expectedRevision,
		nextState: { ...current, accessibility: { ...current.accessibility, nodes: current.accessibility.nodes.filter((node) => node.controlId !== data.controlId) } },
		options,
	});
	return { id: gui.uniqueId.toString(), revision: state.revision, deletedControlId: data.controlId, runtime: getGUIAccessibilityRuntimeEvidence(gui) };
}

/** Reads the exact semantic hierarchy, live bridge evidence, and control ownership without mutation. */
export function inspectGUIAccessibilityHierarchy(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	const nodes = new Map(state.accessibility.nodes.map((node) => [node.controlId, node]));
	const descriptions = describeGUIControls(gui);
	const items = descriptions.map((description) => ({ ...description, semantic: nodes.get(description.id) ?? null }));
	const offset = Math.max(0, Math.min(items.length, Number.isInteger(data.offset) ? data.offset : 0));
	const limit = Math.max(1, Math.min(200, Number.isInteger(data.limit) ? data.limit : 50));
	return {
		id: gui.uniqueId.toString(),
		name: gui.name,
		revision: state.revision,
		settings: state.accessibility.settings,
		runtime: getGUIAccessibilityRuntimeEvidence(gui),
		hierarchy: {
			total: items.length,
			count: Math.min(limit, items.length - offset),
			offset,
			hasMore: offset + limit < items.length,
			items: items.slice(offset, offset + limit),
		},
	};
}

export function focusGUIAccessibilityNodeAction(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	if (state.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${state.revision}.`);
	}
	focusGUIAccessibilityNode(gui, data.controlId);
	return { id: gui.uniqueId.toString(), revision: state.revision, focusedControlId: data.controlId };
}

export function invokeGUIAccessibilityActionAction(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	if (state.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${state.revision}.`);
	}
	invokeGUIAccessibilityAction(gui, data.controlId, data.action);
	return { id: gui.uniqueId.toString(), revision: state.revision, controlId: data.controlId, action: data.action };
}

export function announceGUIAccessibilityAction(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	if (state.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${state.revision}.`);
	}
	announceGUIAccessibility(gui, data.message, data.priority);
	return { id: gui.uniqueId.toString(), revision: state.revision, announced: true, priority: data.priority ?? "polite" };
}

export async function setGUICanvasSettings(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	const next: IGUIAuthoringState = {
		...current,
		canvas: {
			...current.canvas,
			...data.canvas,
			safeArea: { ...current.canvas.safeArea, ...(data.canvas?.safeArea ?? {}) },
		},
	};
	const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: next, options });
	return { id: gui.uniqueId.toString(), name: gui.name, revision: state.revision, canvas: state.canvas };
}

/** Describes the portable CanvasGroup, RaycastReceiver, and local usage-tracking contract. */
export function getGUIInteractionCapabilities(): any {
	return {
		model: "zvibe-gui-interaction-v1",
		canvasGroup: { alpha: [0, 1], interactable: true, blocksRaycasts: true, ignoreParentGroups: true, hierarchyEffective: true },
		raycastReceiver: { invisible: true, receivesPointerEvents: true, blocksPointerByDefault: true },
		usageTracking: { localOnly: true, externallyTransmitted: false, maximumRecentEvents: 2048, counters: ["layout", "render", "pointer", "value", "focus"] },
	};
}

/** Reads one exact CanvasGroup assignment and its current control hierarchy. */
export function getGUICanvasGroup(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	const assignment = state.canvasGroups.find((candidate) => candidate.controlId === data.controlId);
	if (!assignment) {
		throw new Error(`GUI control "${data.controlId}" does not have a CanvasGroup assignment.`);
	}
	const control = describeGUIControls(gui).find((candidate) => candidate.id === data.controlId);
	return { id: gui.uniqueId.toString(), name: gui.name, revision: state.revision, assignment, control };
}

/** Sets, replaces, or removes one CanvasGroup assignment under the exact GUI revision. */
export async function setGUICanvasGroup(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	assertGUIRetainedHierarchyDetached(current, "changing CanvasGroup components manually");
	const control = findGUIControlById(gui, data.controlId);
	if (!control) {
		throw new Error(`GUI control "${data.controlId}" was not found.`);
	}
	if (data.assignment && typeof (control as unknown as { addControl?: unknown }).addControl !== "function") {
		throw new Error("CanvasGroup can be assigned only to a container control so it can affect a hierarchy.");
	}
	const before = captureGUISnapshot(gui);
	control.metadata = { ...(control.metadata ?? {}) };
	const previousAssignment = current.canvasGroups.find((assignment) => assignment.controlId === data.controlId);
	if (data.assignment) {
		(control.metadata as Record<string, unknown>)[guiCanvasGroupMetadataKey] = true;
		control.alpha = 1;
	} else {
		delete (control.metadata as Record<string, unknown>)[guiCanvasGroupMetadataKey];
		if (previousAssignment) {
			control.alpha = previousAssignment.alpha;
		}
	}
	const canvasGroups = current.canvasGroups.filter((assignment) => assignment.controlId !== data.controlId);
	if (data.assignment) {
		canvasGroups.push({ controlId: data.controlId, ...data.assignment });
	}
	const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: { ...current, canvasGroups }, options, rollbackSnapshot: before });
	return { id: gui.uniqueId.toString(), revision: state.revision, assignment: state.canvasGroups.find((assignment) => assignment.controlId === data.controlId) ?? null };
}

/** Lists a bounded page of invisible RaycastReceiver controls. */
export function listGUIRaycastReceivers(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	const descriptions = new Map(describeGUIControls(gui).map((description) => [description.id, description]));
	const offset = Math.max(0, Math.min(state.raycastReceivers.length, Number.isInteger(data.offset) ? data.offset : 0));
	const limit = Math.max(1, Math.min(200, Number.isInteger(data.limit) ? data.limit : 50));
	const items = state.raycastReceivers.slice(offset, offset + limit).map((assignment) => ({ ...assignment, control: descriptions.get(assignment.controlId) ?? null }));
	return {
		id: gui.uniqueId.toString(),
		name: gui.name,
		revision: state.revision,
		receivers: { total: state.raycastReceivers.length, count: items.length, offset, hasMore: offset + items.length < state.raycastReceivers.length, items },
	};
}

/** Enables, disables, attaches, or removes one invisible RaycastReceiver component. */
export async function setGUIRaycastReceiver(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	assertGUIRetainedHierarchyDetached(current, "changing RaycastReceiver components manually");
	const control = findGUIControlById(gui, data.controlId);
	if (!control) {
		throw new Error(`GUI control "${data.controlId}" was not found.`);
	}
	const before = captureGUISnapshot(gui);
	control.metadata = { ...(control.metadata ?? {}) };
	if (data.enabled === null) {
		delete (control.metadata as Record<string, unknown>)[guiRaycastReceiverMetadataKey];
	} else {
		(control.metadata as Record<string, unknown>)[guiRaycastReceiverMetadataKey] = true;
	}
	const raycastReceivers = current.raycastReceivers.filter((assignment) => assignment.controlId !== data.controlId);
	if (data.enabled !== null) {
		raycastReceivers.push({ controlId: data.controlId, enabled: data.enabled });
	}
	const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: { ...current, raycastReceivers }, options, rollbackSnapshot: before });
	return { id: gui.uniqueId.toString(), revision: state.revision, assignment: state.raycastReceivers.find((assignment) => assignment.controlId === data.controlId) ?? null };
}

/** Reads bounded local-only UGUI usage counters and recent event evidence. */
export function getGUIUsageTracking(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	return {
		id: gui.uniqueId.toString(),
		name: gui.name,
		revision: state.revision,
		settings: state.usageTracking,
		evidence: getGUIUsageTrackingEvidence(gui, data.offset, data.limit),
		privacy: { localOnly: true, externallyTransmitted: false },
	};
}

/** Updates local-only UGUI usage tracking under the exact GUI revision. */
export async function setGUIUsageTracking(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	const state = await commitGUIState({
		gui,
		expectedRevision: data.expectedRevision,
		nextState: { ...current, usageTracking: { ...current.usageTracking, ...data.settings } },
		options,
	});
	return { id: gui.uniqueId.toString(), revision: state.revision, settings: state.usageTracking, evidence: getGUIUsageTrackingEvidence(gui, 0, 100) };
}

/** Clears transient UGUI usage evidence without changing the authored policy or scene revision. */
export function resetGUIUsageTracking(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	if (state.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${state.revision}.`);
	}
	return { id: gui.uniqueId.toString(), revision: state.revision, evidence: resetGUIUsageTrackingEvidence(gui) };
}

export async function createGUIControl(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	assertGUIRetainedHierarchyDetached(current, "creating controls manually");
	const existingIds = new Set(describeGUIControls(gui).map((control) => control.id));
	if (data.controlId && existingIds.has(data.controlId)) {
		throw new Error(`GUI control id "${data.controlId}" already exists.`);
	}
	const parent = containerForId(gui, data.parentControlId);
	const control = createControl(data.type, data.properties.name, data.properties);
	if (data.controlId) {
		control.metadata = { ...(control.metadata ?? {}), [guiControlIdentityMetadataKey]: data.controlId };
	}
	const before = captureGUISnapshot(gui);
	let commitStarted = false;
	try {
		parent.addControl(control);
		const description = describeGUIControls(gui).find((entry) => findGUIControlById(gui, entry.id) === control)!;
		const next: IGUIAuthoringState = {
			...current,
			canvasGroups:
				data.type === "canvasGroup"
					? [
							...current.canvasGroups,
							{
								controlId: description.id,
								alpha: data.properties.alpha ?? 1,
								interactable: data.properties.interactable ?? true,
								blocksRaycasts: data.properties.blocksRaycasts ?? true,
								ignoreParentGroups: data.properties.ignoreParentGroups ?? false,
							},
						]
					: current.canvasGroups,
			raycastReceivers: data.type === "raycastReceiver" ? [...current.raycastReceivers, { controlId: description.id, enabled: true }] : current.raycastReceivers,
		};
		commitStarted = true;
		const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: next, options, rollbackSnapshot: before });
		return { id: gui.uniqueId.toString(), revision: state.revision, control: { ...description, properties: authoredControlProperties(control, description.id, state) } };
	} catch (error) {
		if (!commitStarted) {
			await restoreGUISnapshot(gui, before, options);
		}
		throw error;
	}
}

export async function updateGUIControl(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	assertGUIRetainedHierarchyDetached(current, "editing control properties manually");
	const control = findGUIControlById(gui, data.controlId);
	if (!control) {
		throw new Error(`GUI control "${data.controlId}" was not found.`);
	}
	const before = captureGUISnapshot(gui);
	let commitStarted = false;
	try {
		const canvasGroup = current.canvasGroups.find((assignment) => assignment.controlId === data.controlId);
		const next: IGUIAuthoringState = canvasGroup
			? {
					...current,
					canvasGroups: current.canvasGroups.map((assignment) =>
						assignment.controlId === data.controlId
							? {
									...assignment,
									alpha: data.properties.alpha ?? assignment.alpha,
									interactable: data.properties.interactable ?? assignment.interactable,
									blocksRaycasts: data.properties.blocksRaycasts ?? assignment.blocksRaycasts,
									ignoreParentGroups: data.properties.ignoreParentGroups ?? assignment.ignoreParentGroups,
								}
							: assignment
					),
				}
			: current;
		const nativeProperties = canvasGroup
			? { ...data.properties, alpha: undefined, interactable: undefined, blocksRaycasts: undefined, ignoreParentGroups: undefined }
			: data.properties;
		applyControlProperties(control, nativeProperties);
		commitStarted = true;
		const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: next, options, rollbackSnapshot: before });
		const description = describeGUIControls(gui).find((entry) => entry.id === data.controlId)!;
		return { id: gui.uniqueId.toString(), revision: state.revision, control: { ...description, properties: authoredControlProperties(control, data.controlId, state) } };
	} catch (error) {
		if (!commitStarted) {
			await restoreGUISnapshot(gui, before, options);
		}
		throw error;
	}
}

export async function moveGUIControl(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	assertGUIRetainedHierarchyDetached(current, "moving controls manually");
	const control = findGUIControlById(gui, data.controlId);
	if (!control) {
		throw new Error(`GUI control "${data.controlId}" was not found.`);
	}
	const nextParent = containerForId(gui, data.parentControlId);
	if (nextParent === control || descendantIds(control).includes(data.parentControlId)) {
		throw new Error("A GUI control cannot be parented to itself or one of its descendants.");
	}
	const previousParent = parentContainer(gui, control);
	if (!previousParent) {
		throw new Error(`GUI control "${data.controlId}" has no editable parent.`);
	}
	const before = captureGUISnapshot(gui);
	let commitStarted = false;
	try {
		previousParent.removeControl(control);
		nextParent.addControl(control);
		control.zIndex = data.zIndex;
		commitStarted = true;
		const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: current, options, rollbackSnapshot: before });
		const description = describeGUIControls(gui).find((entry) => entry.id === data.controlId)!;
		return { id: gui.uniqueId.toString(), revision: state.revision, control: { ...description, properties: controlProperties(control) } };
	} catch (error) {
		if (!commitStarted) {
			await restoreGUISnapshot(gui, before, options);
		}
		throw error;
	}
}

export async function deleteGUIControl(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	assertGUIRetainedHierarchyDetached(current, "deleting controls manually");
	const control = findGUIControlById(gui, data.controlId);
	if (!control) {
		throw new Error(`GUI control "${data.controlId}" was not found.`);
	}
	const parent = parentContainer(gui, control);
	if (!parent) {
		throw new Error(`GUI control "${data.controlId}" has no editable parent.`);
	}
	const removedIds = new Set(descendantIds(control));
	const next: IGUIAuthoringState = {
		...current,
		bindings: current.bindings.filter((binding) => !removedIds.has(binding.controlId)),
		fonts: current.fonts.filter((font) => !removedIds.has(font.controlId)),
		atlasTexts: current.atlasTexts.filter((assignment) => !removedIds.has(assignment.controlId)),
		localizations: current.localizations.filter((binding) => !removedIds.has(binding.controlId)),
		accessibility: { ...current.accessibility, nodes: current.accessibility.nodes.filter((node) => !removedIds.has(node.controlId)) },
		canvasGroups: current.canvasGroups.filter((assignment) => !removedIds.has(assignment.controlId)),
		raycastReceivers: current.raycastReceivers.filter((assignment) => !removedIds.has(assignment.controlId)),
	};
	const before = captureGUISnapshot(gui);
	let commitStarted = false;
	try {
		parent.removeControl(control);
		control.dispose();
		gui.metadata = { ...(gui.metadata ?? {}), zvibeGUIAuthoring: { ...next, revision: current.revision } };
		commitStarted = true;
		const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: next, options, rollbackSnapshot: before });
		return { id: gui.uniqueId.toString(), revision: state.revision, deletedControlIds: [...removedIds] };
	} catch (error) {
		if (!commitStarted) {
			await restoreGUISnapshot(gui, before, options);
		}
		throw error;
	}
}

export async function setGUIControlFont(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (!findGUIControlById(gui, data.controlId)) {
		throw new Error(`GUI control "${data.controlId}" was not found.`);
	}
	const assignment: IGUIFontAssignment | null = data.assignment;
	const fonts = current.fonts.filter((font) => font.controlId !== data.controlId);
	if (assignment) {
		fonts.push({ ...assignment, controlId: data.controlId });
	}
	const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: { ...current, fonts }, options });
	return { id: gui.uniqueId.toString(), revision: state.revision, controlId: data.controlId, assignment: state.fonts.find((font) => font.controlId === data.controlId) ?? null };
}

function normalizeAtlasTextForControl(controlId: string, value: Record<string, unknown>): IGUIAtlasTextAssignment {
	return normalizeGUIAtlasTextAssignment({ ...value, model: guiAtlasTextModel, controlId });
}

/** Creates one native GUI Image control and atomically binds an atlas-rich-text renderer to it. */
export async function createGUIAtlasText(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	assertGUIRetainedHierarchyDetached(current, "creating atlas-text controls manually");
	const existingIds = new Set(describeGUIControls(gui).map((control) => control.id));
	if (existingIds.has(data.controlId)) {
		throw new Error(`GUI control id "${data.controlId}" already exists.`);
	}
	const parent = containerForId(gui, data.parentControlId);
	const assignment = normalizeAtlasTextForControl(data.controlId, data.assignment);
	const control = new Image(data.name, null);
	applyControlProperties(control, {
		name: data.name,
		width: data.width ?? `${assignment.width}px`,
		height: data.height ?? `${assignment.height}px`,
		left: data.left ?? "0px",
		top: data.top ?? "0px",
	});
	control.metadata = { ...(control.metadata ?? {}), [guiControlIdentityMetadataKey]: data.controlId };
	const before = captureGUISnapshot(gui);
	let commitStarted = false;
	try {
		parent.addControl(control);
		commitStarted = true;
		const state = await commitGUIState({
			gui,
			expectedRevision: data.expectedRevision,
			nextState: { ...current, atlasTexts: [...current.atlasTexts, assignment] },
			options,
			rollbackSnapshot: before,
		});
		const description = describeGUIControls(gui).find((entry) => entry.id === data.controlId)!;
		return {
			id: gui.uniqueId.toString(),
			revision: state.revision,
			control: { ...description, properties: controlProperties(control) },
			assignment: state.atlasTexts.find((entry) => entry.controlId === data.controlId),
			runtime: getGUIAtlasTextRuntimeEvidence(gui).find((entry) => entry.controlId === data.controlId) ?? null,
		};
	} catch (error) {
		if (!commitStarted) {
			await restoreGUISnapshot(gui, before, options);
		}
		throw error;
	}
}

/** Reads persisted settings and the last live rendering evidence for one atlas-text control. */
export function getGUIAtlasText(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const state = getGUIAuthoringState(gui);
	const assignment = state.atlasTexts.find((entry) => entry.controlId === data.controlId);
	if (!assignment) {
		throw new Error(`GUI atlas text assignment for control "${data.controlId}" was not found.`);
	}
	return {
		id: gui.uniqueId.toString(),
		name: gui.name,
		revision: state.revision,
		assignment,
		runtime: getGUIAtlasTextRuntimeEvidence(gui).find((entry) => entry.controlId === data.controlId) ?? null,
	};
}

/** Sets one complete atlas-rich-text assignment under the GUI's exact revision lease. */
export async function setGUIAtlasText(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const control = findGUIControlById(gui, data.controlId);
	if (!control) {
		throw new Error(`GUI control "${data.controlId}" was not found.`);
	}
	if (!(control instanceof Image)) {
		throw new Error(`GUI atlas text control "${data.controlId}" must be a Babylon Image control.`);
	}
	const assignment = normalizeAtlasTextForControl(data.controlId, data.assignment);
	const atlasTexts = current.atlasTexts.filter((entry) => entry.controlId !== data.controlId);
	atlasTexts.push(assignment);
	const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: { ...current, atlasTexts }, options });
	return {
		id: gui.uniqueId.toString(),
		revision: state.revision,
		assignment: state.atlasTexts.find((entry) => entry.controlId === data.controlId),
		runtime: getGUIAtlasTextRuntimeEvidence(gui).find((entry) => entry.controlId === data.controlId) ?? null,
	};
}

/** Rebuilds a live atlas canvas from persisted assets without changing authored state or revision. */
export async function refreshGUIAtlasText(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	if (!current.atlasTexts.some((entry) => entry.controlId === data.controlId)) {
		throw new Error(`GUI atlas text assignment for control "${data.controlId}" was not found.`);
	}
	const runtime = await applyGUIAuthoringRuntime(gui, current, optionsForGUI(options));
	notifyGUIChanged(gui, options);
	return {
		id: gui.uniqueId.toString(),
		revision: current.revision,
		runtime: runtime.atlasTexts.find((entry) => entry.controlId === data.controlId) ?? null,
	};
}

/** Clears one atlas-text assignment while preserving its underlying GUI Image control. */
export async function clearGUIAtlasText(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	if (!current.atlasTexts.some((entry) => entry.controlId === data.controlId)) {
		throw new Error(`GUI atlas text assignment for control "${data.controlId}" was not found.`);
	}
	const control = findGUIControlById(gui, data.controlId);
	if (!(control instanceof Image)) {
		throw new Error(`GUI atlas text control "${data.controlId}" must be a Babylon Image control.`);
	}
	const state = await commitGUIState({
		gui,
		expectedRevision: data.expectedRevision,
		nextState: { ...current, atlasTexts: current.atlasTexts.filter((entry) => entry.controlId !== data.controlId) },
		options,
	});
	const runtimeMetadata = control.metadata as Record<string, unknown> | null;
	const domImage = control.domImage as { width?: number; height?: number } | null;
	return {
		id: gui.uniqueId.toString(),
		revision: state.revision,
		clearedControlId: data.controlId,
		runtimeCleared: !runtimeMetadata || !(guiAtlasTextRuntimeMetadataKey in runtimeMetadata),
		transparentCanvas: domImage && Number.isFinite(domImage.width) && Number.isFinite(domImage.height) ? { width: domImage.width, height: domImage.height } : null,
	};
}

/** Reads one retained UXML/USS source lease, compilation evidence, and optional current source text. */
export async function getGUIRetainedDocument(scene: Scene, data: any): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	const retained = current.retainedDocument;
	if (!retained) {
		throw new Error("GUI does not have a retained UXML/USS document attached.");
	}
	let sources: Array<{ path: string; kind: "uxml" | "uss" | "template"; source: string }> | undefined;
	if (data.includeSources) {
		sources = [];
		for (const source of retained.compiled.sources) {
			const loaded = await readGUIRetainedSource(source.path, source.kind === "uss" ? ".uss" : ".uxml");
			sources.push({ path: source.path, kind: source.kind, source: loaded.source });
		}
	}
	return {
		id: gui.uniqueId.toString(),
		name: gui.name,
		revision: current.revision,
		retainedDocument: retained,
		...(sources ? { sources } : {}),
	};
}

/** Attaches or replaces a retained document from project UXML/USS sources under exact GUI and source leases. */
export async function setGUIRetainedDocument(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const existingFingerprint = current.retainedDocument?.compiled.sourceFingerprint ?? null;
	if ((data.expectedSourceFingerprint ?? null) !== existingFingerprint) {
		throw new Error(
			existingFingerprint
				? `GUI retained source changed. Inspect again and use expectedSourceFingerprint ${existingFingerprint}.`
				: "GUI has no retained source; expectedSourceFingerprint must be null."
		);
	}
	const { sources, compiled } = await compileGUIRetainedProjectDocument(data.uxmlPath);
	const state = await replaceGUIWithRetainedCompilation({
		gui,
		current,
		expectedRevision: data.expectedRevision,
		compiled,
		uxmlPath: sources.uxmlPath,
		hotReload: data.hotReload ?? current.retainedDocument?.hotReload ?? true,
		sourceRevision: (current.retainedDocument?.sourceRevision ?? 0) + 1,
		options,
	});
	return {
		id: gui.uniqueId.toString(),
		revision: state.revision,
		retainedDocument: state.retainedDocument,
		controlCount: compiled.controls.length,
	};
}

/** Writes a complete bounded retained source graph and atomically attaches its compiled controls under exact leases. */
export async function writeGUIRetainedDocument(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const existingFingerprint = current.retainedDocument?.compiled.sourceFingerprint ?? null;
	if ((data.expectedSourceFingerprint ?? null) !== existingFingerprint) {
		throw new Error(
			existingFingerprint
				? `GUI retained source changed. Inspect again and use expectedSourceFingerprint ${existingFingerprint}.`
				: "GUI has no retained source; expectedSourceFingerprint must be null."
		);
	}
	if (current.retainedDocument) {
		const disk = await compileGUIRetainedProjectDocument(current.retainedDocument.uxmlPath, current.toolkit.stylesheetStage.stylesheetOrder);
		if (disk.compiled.sourceFingerprint !== existingFingerprint) {
			throw new Error("Retained source files changed on disk. Refresh and inspect again before overwriting them.");
		}
	}
	const sources: ILoadedGUIRetainedProjectSources = {
		uxmlPath: data.uxml.path,
		uxml: data.uxml.source,
		stylesheets: data.stylesheets ?? [],
		templates: data.templates ?? [],
	};
	const compiled = await compileGUIRetainedDocument(sources);
	const inputSources = [{ path: sources.uxmlPath, source: sources.uxml }, ...sources.stylesheets, ...sources.templates];
	if (new Set(inputSources.map((source) => source.path)).size !== inputSources.length) {
		throw new Error("Retained source paths must be unique across UXML, USS, and templates.");
	}
	const compiledPaths = new Set(compiled.sources.map((source) => source.path));
	const unused = inputSources.find((source) => !compiledPaths.has(source.path));
	if (unused) {
		throw new Error(`Retained source "${unused.path}" is not referenced by the compiled document graph.`);
	}
	const backups: Array<{ path: string; existed: boolean; source: string | null }> = [];
	for (const source of inputSources) {
		const absolutePath = resolveProjectPath(source.path);
		await assertProjectPathHasNoSymbolicLinks(absolutePath, false);
		const existed = await pathExists(absolutePath);
		if (existed && data.overwrite !== true) {
			throw new Error(`Retained source already exists: ${source.path}. Set overwrite true after inspecting the target.`);
		}
		backups.push({ path: absolutePath, existed, source: existed ? await readFile(absolutePath, "utf8") : null });
	}
	try {
		for (let index = 0; index < inputSources.length; index++) {
			await ensureDir(dirname(backups[index].path));
			await writeFile(backups[index].path, inputSources[index].source, "utf8");
		}
		const state = await replaceGUIWithRetainedCompilation({
			gui,
			current,
			expectedRevision: data.expectedRevision,
			compiled,
			uxmlPath: sources.uxmlPath,
			hotReload: data.hotReload ?? true,
			sourceRevision: (current.retainedDocument?.sourceRevision ?? 0) + 1,
			options,
		});
		return {
			id: gui.uniqueId.toString(),
			revision: state.revision,
			retainedDocument: state.retainedDocument,
			writtenPaths: inputSources.map((source) => source.path),
			controlCount: compiled.controls.length,
		};
	} catch (error) {
		for (const backup of backups) {
			if (backup.existed) {
				await writeFile(backup.path, backup.source!, "utf8");
			} else {
				await remove(backup.path);
			}
		}
		throw error;
	}
}

/** Recompiles the currently attached project UXML/USS graph under exact GUI and source leases. */
export async function refreshGUIRetainedDocument(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const retained = current.retainedDocument;
	if (!retained) {
		throw new Error("GUI does not have a retained UXML/USS document attached.");
	}
	if (retained.compiled.sourceFingerprint !== data.expectedSourceFingerprint) {
		throw new Error(`GUI retained source changed. Inspect again and use expectedSourceFingerprint ${retained.compiled.sourceFingerprint}.`);
	}
	const { sources, compiled } = await compileGUIRetainedProjectDocument(retained.uxmlPath, current.toolkit.stylesheetStage.stylesheetOrder);
	const state = await replaceGUIWithRetainedCompilation({
		gui,
		current,
		expectedRevision: data.expectedRevision,
		compiled,
		uxmlPath: sources.uxmlPath,
		hotReload: retained.hotReload,
		sourceRevision: retained.sourceRevision + 1,
		options,
	});
	return {
		id: gui.uniqueId.toString(),
		revision: state.revision,
		changed: compiled.sourceFingerprint !== retained.compiled.sourceFingerprint,
		retainedDocument: state.retainedDocument,
	};
}

/** Hot-reloads every retained GUI that owns one changed UXML/USS source, without recompiling unchanged fingerprints. */
export async function refreshGUIRetainedDocumentsForSource(scene: Scene, changedSourcePath: string, options: IMCPActionOptions): Promise<Array<Record<string, unknown>>> {
	const projectDirectory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(changedSourcePath) ? changedSourcePath : join(projectDirectory, changedSourcePath));
	const projectPath = relative(projectDirectory, absolutePath).replace(/\\/g, "/");
	const results: Array<Record<string, unknown>> = [];
	for (const texture of scene.textures) {
		if (!isAdvancedDynamicTexture(texture)) {
			continue;
		}
		const gui = texture as AdvancedDynamicTexture;
		const current = getGUIAuthoringState(gui);
		const retained = current.retainedDocument;
		if (!retained?.hotReload || !retained.compiled.sources.some((source) => source.path === projectPath)) {
			continue;
		}
		try {
			const { sources, compiled } = await compileGUIRetainedProjectDocument(retained.uxmlPath, current.toolkit.stylesheetStage.stylesheetOrder);
			if (compiled.sourceFingerprint === retained.compiled.sourceFingerprint) {
				results.push({ id: gui.uniqueId.toString(), revision: current.revision, changed: false, sourcePath: projectPath });
				continue;
			}
			const state = await replaceGUIWithRetainedCompilation({
				gui,
				current,
				expectedRevision: current.revision,
				compiled,
				uxmlPath: sources.uxmlPath,
				hotReload: true,
				sourceRevision: retained.sourceRevision + 1,
				options,
			});
			results.push({ id: gui.uniqueId.toString(), revision: state.revision, changed: true, sourcePath: projectPath, sourceFingerprint: compiled.sourceFingerprint });
		} catch (error) {
			results.push({
				id: gui.uniqueId.toString(),
				revision: current.revision,
				changed: false,
				sourcePath: projectPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}

/** Detaches retained source ownership while preserving the last compiled live controls for manual editing. */
export async function detachGUIRetainedDocument(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const retained = current.retainedDocument;
	if (!retained) {
		throw new Error("GUI does not have a retained UXML/USS document attached.");
	}
	if (retained.compiled.sourceFingerprint !== data.expectedSourceFingerprint) {
		throw new Error(`GUI retained source changed. Inspect again and use expectedSourceFingerprint ${retained.compiled.sourceFingerprint}.`);
	}
	const before = captureGUISnapshot(gui);
	for (const definition of retained.compiled.controls) {
		const control = findGUIControlById(gui, definition.id);
		if (control?.metadata && typeof control.metadata === "object") {
			delete (control.metadata as Record<string, unknown>)[guiRetainedControlMetadataKey];
		}
	}
	const next = { ...current, retainedDocument: null };
	gui.metadata = { ...(gui.metadata ?? {}), zvibeGUIAuthoring: { ...next, revision: current.revision } };
	const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: next, options, rollbackSnapshot: before });
	return { id: gui.uniqueId.toString(), revision: state.revision, detached: true, preservedControlCount: retained.compiled.controls.length };
}

/** Describes the bounded portable UI Toolkit 6.5 surface without claiming Unity package or renderer identity. */
export function getGUIToolkitCapabilities(): any {
	return {
		model: "unity-ui-toolkit-65-portable-v1",
		uxmlUpgrade: { exactSourceLease: true, maximumBytes: 1024 * 1024, rules: ["legacy-namespace", "class-name", "picking-mode", "focus-index", "visible"] },
		panelRenderer: { modes: ["overlay", "worldSpace"], nativeBabylonMeshTexture: true, maximumTextureSize: 8192, hierarchy: true, releaseResources: true },
		ussStats: { perSelector: true, matchedControlCounts: true, stagingOrder: true, dragDropEditor: true },
		visualElementReferences: { stableIds: true, expectedTypeValidation: true, maximum: 1024 },
		attributeOverrides: { exactRevision: true, normalInspectorAffordances: true, maximum: 2048 },
		animations: { properties: ["alpha", "value", "fontSize", "left", "top", "width", "height"], easing: ["linear", "easeIn", "easeOut", "easeInOut"], maximum: 1024 },
		testFramework: { worldSpaceSyntheticClick: true, hitTestGuards: true },
		boundary:
			"Portable Babylon GUI/React behavior; not Unity UI Toolkit package/API, UXML/USS serialization, native renderer, C# attributes, or Unity Test Framework identity.",
	};
}

function requireRetainedToolkit(gui: AdvancedDynamicTexture): { state: IGUIAuthoringState; retained: IGUIRetainedDocumentState } {
	const state = getGUIAuthoringState(gui);
	if (!state.retainedDocument) {
		throw new Error("GUI does not have a retained UXML/USS document attached.");
	}
	return { state, retained: state.retainedDocument };
}

/** Projects PanelRenderer, hierarchy, references, overrides, animations, staging, and per-selector USS statistics through one exact read. */
export function inspectGUIToolkitWorkspace(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const { state, retained } = requireRetainedToolkit(gui);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 100;
	const controlsById = new Map(retained.compiled.controls.map((control) => [control.id, control]));
	const hierarchy = retained.compiled.controls.map((control) => {
		let depth = 0;
		let parentId = control.parentId;
		while (parentId) {
			depth++;
			parentId = controlsById.get(parentId)?.parentId ?? null;
		}
		return { id: control.id, parentId: control.parentId, depth, name: control.name, typeName: control.typeName, classes: control.classes };
	});
	const selectorStatistics = retained.compiled.selectorStatistics;
	return {
		id: gui.uniqueId.toString(),
		name: gui.name,
		revision: state.revision,
		sourceFingerprint: retained.compiled.sourceFingerprint,
		panelRenderer: { settings: state.toolkit.panelRenderer, runtime: getGUIPanelRendererEvidence(gui, state.toolkit.panelRenderer) },
		hierarchy: { total: hierarchy.length, offset, limit, items: hierarchy.slice(offset, offset + limit) },
		uss: {
			styleRuleCount: retained.compiled.styleRuleCount,
			pseudoRuleCount: retained.compiled.pseudoRuleCount,
			unmatchedSelectorCount: selectorStatistics.filter((statistic) => statistic.matchedControlCount === 0).length,
			selectorStatistics: { total: selectorStatistics.length, offset, limit, items: selectorStatistics.slice(offset, offset + limit) },
		},
		stylesheetStage: state.toolkit.stylesheetStage,
		references: state.toolkit.references.map((reference) => ({
			...reference,
			resolved: controlsById.has(reference.controlId),
			typeName: controlsById.get(reference.controlId)?.typeName ?? null,
		})),
		attributeOverrides: state.toolkit.attributeOverrides.map((override) => ({
			...override,
			baseValue: controlsById.get(override.controlId)?.properties[override.property] ?? null,
		})),
		animations: state.toolkit.animations,
	};
}

/** Plans deterministic legacy-UXML replacements against the exact attached root source. */
export async function inspectGUIUXMLUpgrades(scene: Scene, data: any): Promise<any> {
	const gui = findGui(scene, data);
	const { state, retained } = requireRetainedToolkit(gui);
	const absolutePath = resolveProjectPath(retained.uxmlPath);
	await assertProjectPathHasNoSymbolicLinks(absolutePath, true);
	const source = await readFile(absolutePath, "utf8");
	return {
		id: gui.uniqueId.toString(),
		revision: state.revision,
		sourceFingerprint: retained.compiled.sourceFingerprint,
		plan: await planGUIUXMLUpgrades(retained.uxmlPath, source),
	};
}

async function writeTextAtomically(path: string, source: string): Promise<void> {
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, path);
	} catch (error) {
		await remove(temporaryPath).catch(() => undefined);
		throw error;
	}
}

/** Applies the exact current UXML upgrade plan, recompiles the GUI, and restores source bytes if publication fails. */
export async function applyGUIUXMLUpgrades(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const { state, retained } = requireRetainedToolkit(gui);
	if (state.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${state.revision}.`);
	}
	if (retained.compiled.sourceFingerprint !== data.expectedSourceFingerprint) {
		throw new Error(`GUI retained source changed. Inspect again and use expectedSourceFingerprint ${retained.compiled.sourceFingerprint}.`);
	}
	const absolutePath = resolveProjectPath(retained.uxmlPath);
	await assertProjectPathHasNoSymbolicLinks(absolutePath, true);
	const source = await readFile(absolutePath, "utf8");
	const plan = await planGUIUXMLUpgrades(retained.uxmlPath, source);
	if (plan.sourceRevision !== data.expectedSourceRevision) {
		throw new Error(`UXML source changed. Inspect again and use expectedSourceRevision ${plan.sourceRevision}.`);
	}
	if (!plan.edits.length) {
		return { id: gui.uniqueId.toString(), revision: state.revision, changed: false, plan };
	}
	await writeTextAtomically(absolutePath, plan.upgradedSource);
	try {
		const refreshed = await refreshGUIRetainedDocument(
			scene,
			{ guiId: gui.uniqueId.toString(), expectedRevision: state.revision, expectedSourceFingerprint: retained.compiled.sourceFingerprint },
			options
		);
		return { ...refreshed, changed: true, appliedEditCount: plan.edits.length, previousSourceRevision: plan.sourceRevision };
	} catch (error) {
		await writeTextAtomically(absolutePath, source);
		throw error;
	}
}

/** Updates native overlay/world-space PanelRenderer intent, converting the live texture when the render mode changes. */
export async function setGUIPanelRenderer(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const toolkit = normalizeGUIToolkitState({ ...current.toolkit, panelRenderer: data.settings as IGUIPanelRendererSettings }, current.retainedDocument?.compiled ?? null);
	const previous = current.toolkit.panelRenderer;
	const next = toolkit.panelRenderer;
	if (previous.renderMode === "worldSpace" && next.renderMode === "worldSpace" && previous.targetMeshId !== next.targetMeshId) {
		throw new Error("Changing a live world-space PanelRenderer target mesh is unsafe; switch to overlay or delete and reinstantiate the GUI first.");
	}
	if (previous.renderMode === next.renderMode) {
		if (next.renderMode === "worldSpace") {
			if (previous.onlyAlphaTesting !== next.onlyAlphaTesting || previous.invertY !== next.invertY || previous.supportPointerMove !== next.supportPointerMove) {
				throw new Error("Changing live world-space material/pointer attachment options requires re-instantiation.");
			}
			gui.scaleTo(next.textureWidth, next.textureHeight);
		} else if (gui.layer) {
			gui.layer.isBackground = !next.foreground;
		}
		const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: { ...current, toolkit }, options });
		return { id: gui.uniqueId.toString(), revision: state.revision, replaced: false, panelRenderer: getGUIPanelRendererEvidence(gui, state.toolkit.panelRenderer) };
	}
	const content = gui.serializeContent();
	let replacement: AdvancedDynamicTexture | null = null;
	try {
		const created = createGUIPanelRendererTexture<AdvancedDynamicTexture>(scene, gui.name, next);
		replacement = created;
		created.parseSerializedObject(content, false);
		created.uniqueId = gui.uniqueId;
		created.metadata = { ...(gui.metadata ?? {}), zvibeGUIAuthoring: { ...current, toolkit, revision: current.revision } };
		const state = setGUIAuthoringState(created, current.revision, { ...current, toolkit });
		await applyGUIAuthoringRuntime(created, state, optionsForGUI(options));
		detachGUIAuthoringRuntime(gui);
		releaseGUIPanelRendererTexture(gui, previous.releaseRootOnDispose);
		options.editor.layout.inspector.setEditedObject(created);
		notifyGUIChanged(created, options);
		return {
			id: created.uniqueId.toString(),
			revision: state.revision,
			replaced: true,
			panelRenderer: getGUIPanelRendererEvidence(created, state.toolkit.panelRenderer),
		};
	} catch (error) {
		if (replacement) {
			releaseGUIPanelRendererTexture(replacement, true);
		}
		throw error;
	}
}

/** Reorders every retained stylesheet as one staging-context transaction and recompiles the cascade. */
export async function setGUIStylesheetStage(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const { state, retained } = requireRetainedToolkit(gui);
	if (state.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${state.revision}.`);
	}
	if (retained.compiled.sourceFingerprint !== data.expectedSourceFingerprint) {
		throw new Error(`GUI retained source changed. Inspect again and use expectedSourceFingerprint ${retained.compiled.sourceFingerprint}.`);
	}
	const stagedToolkit = normalizeGUIToolkitState(
		{
			...state.toolkit,
			stylesheetStage: { contextId: data.contextId, activeStylesheetPath: data.activeStylesheetPath, stylesheetOrder: data.stylesheetOrder },
		},
		retained.compiled
	);
	const { sources, compiled } = await compileGUIRetainedProjectDocument(retained.uxmlPath, stagedToolkit.stylesheetStage.stylesheetOrder);
	const nextState = { ...state, toolkit: stagedToolkit };
	const committed = await replaceGUIWithRetainedCompilation({
		gui,
		current: nextState,
		expectedRevision: state.revision,
		compiled,
		uxmlPath: sources.uxmlPath,
		hotReload: retained.hotReload,
		sourceRevision: retained.sourceRevision + 1,
		options,
	});
	return {
		id: gui.uniqueId.toString(),
		revision: committed.revision,
		sourceFingerprint: committed.retainedDocument?.compiled.sourceFingerprint,
		stylesheetStage: committed.toolkit.stylesheetStage,
	};
}

async function commitGUIToolkitState(gui: AdvancedDynamicTexture, current: IGUIAuthoringState, toolkitValue: unknown, options: IMCPActionOptions): Promise<IGUIAuthoringState> {
	const toolkit = normalizeGUIToolkitState(toolkitValue, current.retainedDocument?.compiled ?? null);
	return commitGUIState({ gui, expectedRevision: current.revision, nextState: { ...current, toolkit }, options });
}

/** Creates or replaces one stable VisualElement reference under an exact GUI lease. */
export async function setGUIVisualElementReference(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const reference = data.reference as IGUIVisualElementReference;
	const state = await commitGUIToolkitState(
		gui,
		current,
		{ ...current.toolkit, references: [...current.toolkit.references.filter((entry) => entry.id !== reference.id), reference] },
		options
	);
	return { id: gui.uniqueId.toString(), revision: state.revision, reference: state.toolkit.references.find((entry) => entry.id === reference.id) };
}

/** Creates or replaces one retained attribute override and applies it through shared runtime. */
export async function setGUIAttributeOverride(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const override = data.override as IGUIAttributeOverride;
	const key = `${override.controlId}:${override.property}`;
	const state = await commitGUIToolkitState(
		gui,
		current,
		{ ...current.toolkit, attributeOverrides: [...current.toolkit.attributeOverrides.filter((entry) => `${entry.controlId}:${entry.property}` !== key), override] },
		options
	);
	return { id: gui.uniqueId.toString(), revision: state.revision, override: state.toolkit.attributeOverrides.find((entry) => `${entry.controlId}:${entry.property}` === key) };
}

/** Deletes one exact retained attribute override. */
export async function deleteGUIAttributeOverride(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting a GUI attribute override requires confirm: true.");
	}
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const existing = current.toolkit.attributeOverrides.find((entry) => entry.controlId === data.controlId && entry.property === data.property);
	if (!existing) {
		throw new Error(`GUI attribute override "${data.controlId}:${data.property}" was not found.`);
	}
	const state = await commitGUIToolkitState(
		gui,
		current,
		{ ...current.toolkit, attributeOverrides: current.toolkit.attributeOverrides.filter((entry) => entry !== existing) },
		options
	);
	return { id: gui.uniqueId.toString(), revision: state.revision, deleted: existing };
}

/** Creates or replaces one bounded numeric retained-control animation. */
export async function setGUIAnimation(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const animation = data.animation as IGUIAnimationTrack;
	const state = await commitGUIToolkitState(
		gui,
		current,
		{ ...current.toolkit, animations: [...current.toolkit.animations.filter((entry) => entry.id !== animation.id), animation] },
		options
	);
	return { id: gui.uniqueId.toString(), revision: state.revision, animation: state.toolkit.animations.find((entry) => entry.id === animation.id) };
}

/** Deletes one retained-control animation. */
export async function deleteGUIAnimation(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting a GUI animation requires confirm: true.");
	}
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const animation = current.toolkit.animations.find((entry) => entry.id === data.animationId);
	if (!animation) {
		throw new Error(`GUI animation "${data.animationId}" was not found.`);
	}
	const state = await commitGUIToolkitState(
		gui,
		current,
		{ ...current.toolkit, animations: current.toolkit.animations.filter((entry) => entry.id !== data.animationId) },
		options
	);
	return { id: gui.uniqueId.toString(), revision: state.revision, deleted: animation };
}

/** Executes the portable UI-test synthetic Click contract on one real world-space Babylon control. */
export function simulateGUIWorldSpaceClick(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	if (current.toolkit.panelRenderer.renderMode !== "worldSpace" || gui._isFullscreen) {
		throw new Error("World-space Click simulation requires a native mesh-backed PanelRenderer.");
	}
	const control = findGUIControlById(gui, data.controlId);
	if (!control) {
		throw new Error(`GUI control "${data.controlId}" was not found.`);
	}
	if (!control.isVisible || !control.isEnabled || !control.isHitTestVisible) {
		throw new Error(`GUI control "${data.controlId}" is not visible, enabled, and hit-testable.`);
	}
	const eventData = { ...(data.eventData ?? {}), synthetic: true, worldSpace: true, pointerId: data.pointerId ?? 1 };
	control.onPointerDownObservable.notifyObservers(eventData as any);
	control.onPointerClickObservable.notifyObservers(eventData as any);
	control.onPointerUpObservable.notifyObservers(eventData as any);
	return { id: gui.uniqueId.toString(), revision: current.revision, controlId: data.controlId, clicked: true, eventData };
}

/** Releases the PanelRenderer root, native texture, and generated world-space material after exact confirmation. */
export function releaseGUIPanelRendererResources(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Releasing GUI PanelRenderer resources requires confirm: true.");
	}
	return deleteGUIInstance(scene, data, options);
}

export async function createGUIEventBinding(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (current.bindings.some((binding) => binding.id === data.binding.id)) {
		throw new Error(`GUI binding id "${data.binding.id}" already exists.`);
	}
	const state = await commitGUIState({
		gui,
		expectedRevision: data.expectedRevision,
		nextState: { ...current, bindings: [...current.bindings, data.binding as IGUIEventBinding] },
		options,
	});
	return { id: gui.uniqueId.toString(), revision: state.revision, binding: state.bindings.find((binding) => binding.id === data.binding.id) };
}

export async function updateGUIEventBinding(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	const index = current.bindings.findIndex((binding) => binding.id === data.bindingId);
	if (index === -1) {
		throw new Error(`GUI binding "${data.bindingId}" was not found.`);
	}
	const binding = { ...current.bindings[index], ...data.updates, id: data.bindingId } as IGUIEventBinding;
	const bindings = current.bindings.slice();
	bindings[index] = binding;
	const state = await commitGUIState({ gui, expectedRevision: data.expectedRevision, nextState: { ...current, bindings }, options });
	return { id: gui.uniqueId.toString(), revision: state.revision, binding: state.bindings[index] };
}

export async function deleteGUIEventBinding(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	const current = getGUIAuthoringState(gui);
	if (!current.bindings.some((binding) => binding.id === data.bindingId)) {
		throw new Error(`GUI binding "${data.bindingId}" was not found.`);
	}
	const state = await commitGUIState({
		gui,
		expectedRevision: data.expectedRevision,
		nextState: { ...current, bindings: current.bindings.filter((binding) => binding.id !== data.bindingId) },
		options,
	});
	return { id: gui.uniqueId.toString(), revision: state.revision, deletedBindingId: data.bindingId };
}
