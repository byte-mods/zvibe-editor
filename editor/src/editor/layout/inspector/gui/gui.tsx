import { ipcRenderer } from "electron";
import { dirname, join, relative } from "path/posix";
import { readJSON } from "fs-extra";

import { Component, ReactNode } from "react";

import { AdvancedDynamicTexture } from "babylonjs-gui";
import { Scene } from "babylonjs";
import { createDefaultGUIAtlasTextAssignment, IGUIAtlasTextAssignment, IGUIAuthoringState } from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { normalizedGlob } from "../../../../tools/fs";
import { isAdvancedDynamicTexture } from "../../../../tools/guards/texture";
import { onTextureModifiedObservable } from "../../../../tools/observables";
import { registerUndoRedo } from "../../../../tools/undoredo";
import { openInExternalEditor } from "../../../../tools/external-editor";
import { projectConfiguration } from "../../../../project/configuration";
import {
	captureGUISnapshot,
	createGUIControl,
	createGUIEventBinding,
	deleteGUIControl,
	deleteGUIEventBinding,
	clearGUIAtlasText,
	detachGUIRetainedDocument,
	getGUIAuthoring,
	getGUIContent,
	getGUIUsageTracking,
	inspectGUIToolkitWorkspace,
	IGUIControlProperties,
	restoreGUISnapshot,
	refreshGUIRetainedDocument,
	saveGUIAsset,
	setGUICanvasSettings,
	setGUICanvasGroup,
	setGUIContent,
	setGUIControlFont,
	setGUIAtlasText,
	setGUIRetainedDocument,
	setGUIAttributeOverride,
	deleteGUIAttributeOverride,
	setGUIPanelRenderer,
	setGUIStylesheetStage,
	setGUIRaycastReceiver,
	setGUIUsageTracking,
	resetGUIUsageTracking,
	updateGUIControl,
} from "../../../../mcp/gui/gui";

import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorSectionField } from "../fields/section";

import { IEditorInspectorImplementationProps } from "../inspector";

interface IGUIInspectorControl {
	id: string;
	parentId: string | null;
	name: string;
	type: string;
	path: string;
	properties: Record<string, unknown>;
}

export interface IEditorAdvancedDynamicTextureInspectorState {
	content: string;
	assetPath: string;
	assetAbsolutePath: string | null;
	error: string | null;
	authoring: IGUIAuthoringState | null;
	controls: IGUIInspectorControl[];
	selectedControlId: string;
	controlProperties: string;
	newControlName: string;
	newControlType: string;
	newParentControlId: string;
	fontPaths: string;
	fontStyle: "normal" | "italic";
	fontWeight: string;
	atlasTextJson: string;
	atlasTextRuntime: Record<string, unknown> | null;
	bindingJson: string;
	retainedUXMLPath: string;
	retainedHotReload: boolean;
	usageEvidence: Record<string, any> | null;
	toolkitWorkspace: Record<string, any> | null;
	panelTargetMeshId: string;
	overrideProperty: string;
	overrideValue: string;
}

const controlTypes = [
	"container",
	"rectangle",
	"ellipse",
	"text",
	"button",
	"image",
	"stackPanel",
	"grid",
	"scrollViewer",
	"checkbox",
	"radioButton",
	"slider",
	"inputText",
	"inputTextArea",
	"canvasGroup",
	"raycastReceiver",
];
const containerControlTypes = new Set(["Container", "Rectangle", "Ellipse", "Button", "StackPanel", "Grid", "ScrollViewer", "CanvasGroup"]);

export class EditorAdvancedDynamicTextureInspector extends Component<IEditorInspectorImplementationProps<AdvancedDynamicTexture>, IEditorAdvancedDynamicTextureInspectorState> {
	public static IsSupported(object: unknown): boolean {
		return isAdvancedDynamicTexture(object);
	}

	public constructor(props: IEditorInspectorImplementationProps<AdvancedDynamicTexture>) {
		super(props);
		this.state = {
			content: "",
			assetPath: `assets/${props.object.name || "gui"}.gui`,
			assetAbsolutePath: null,
			error: null,
			authoring: null,
			controls: [],
			selectedControlId: "",
			controlProperties: "{}",
			newControlName: "New Control",
			newControlType: "rectangle",
			newParentControlId: "",
			fontPaths: "",
			fontStyle: "normal",
			fontWeight: "normal",
			atlasTextJson: JSON.stringify({ ...createDefaultGUIAtlasTextAssignment("control"), fontAssetPaths: ["assets/fonts/Primary.ttf"] }, null, 2),
			atlasTextRuntime: null,
			bindingJson: JSON.stringify(
				{ id: "ui-event", controlId: "", event: "pointerClick", enabled: true, target: { kind: "customEvent", eventName: "ui.event", detail: null } },
				null,
				2
			),
			retainedUXMLPath: "assets/ui/hud.uxml",
			retainedHotReload: true,
			usageEvidence: null,
			toolkitWorkspace: null,
			panelTargetMeshId: "",
			overrideProperty: "alpha",
			overrideValue: "1",
		};
	}

	public componentDidMount(): void {
		this._refresh();
		void this._locateAsset();
	}

	public componentDidUpdate(previous: IEditorInspectorImplementationProps<AdvancedDynamicTexture>): void {
		if (previous.object !== this.props.object) {
			this.setState({ selectedControlId: "", assetAbsolutePath: null }, () => {
				this._refresh();
				void this._locateAsset();
			});
		}
	}

	public render(): ReactNode {
		const authoring = this.state.authoring;
		const canvas = authoring?.canvas;
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

				<EditorInspectorSectionField title="Visual UI Canvas" tooltip="Open the full drag/drop Babylon GUI Editor for this reusable .gui asset.">
					<div className="flex flex-col gap-2 px-1 text-xs">
						<div>
							{this.state.assetAbsolutePath
								? relative(dirname(projectConfiguration.path!), this.state.assetAbsolutePath)
								: "This live GUI is not linked to a saved .gui asset yet."}
						</div>
						<Button size="sm" disabled={!this.state.assetAbsolutePath || !!authoring?.retainedDocument} onClick={() => this._openVisualEditor()}>
							Open Visual GUI Editor
						</Button>
						<div className="text-muted-foreground">
							Drag/drop controls, anchors, sizing, alignment, grids, stacks, images, and text visually; save updates the live scene.
						</div>
					</div>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Retained UXML / USS"
					tooltip="Unity-style retained UI documents compile bounded UXML, templates, USS selectors, variables, and interactive pseudo-states into native Babylon controls."
				>
					<div className="flex flex-col gap-2 px-1 text-xs">
						<Input
							value={this.state.retainedUXMLPath}
							onChange={(event) => this.setState({ retainedUXMLPath: event.currentTarget.value, error: null })}
							placeholder="assets/ui/hud.uxml"
						/>
						<label className="flex items-center gap-2">
							<input type="checkbox" checked={this.state.retainedHotReload} onChange={(event) => this.setState({ retainedHotReload: event.currentTarget.checked })} />{" "}
							Hot Reload
						</label>
						<div className="grid grid-cols-3 gap-2">
							<Button size="sm" disabled={!authoring} onClick={() => void this._attachRetainedDocument()}>
								Attach
							</Button>
							<Button size="sm" disabled={!authoring?.retainedDocument} onClick={() => void this._refreshRetainedDocument()}>
								Refresh
							</Button>
							<Button size="sm" variant="destructive" disabled={!authoring?.retainedDocument} onClick={() => void this._detachRetainedDocument()}>
								Detach
							</Button>
						</div>
						{authoring?.retainedDocument && (
							<>
								<div>
									Source revision {authoring.retainedDocument.sourceRevision}; {authoring.retainedDocument.compiled.controls.length} controls;{" "}
									{authoring.retainedDocument.compiled.styleRuleCount} rules; {authoring.retainedDocument.compiled.pseudoRuleCount} pseudo rules.
								</div>
								<div className="break-all text-muted-foreground">SHA-256: {authoring.retainedDocument.compiled.sourceFingerprint}</div>
								{authoring.retainedDocument.compiled.sources.map((source) => (
									<Button key={source.path} size="sm" variant="secondary" onClick={() => void this._openRetainedSource(source.path)}>
										Open {source.kind}: {source.path}
									</Button>
								))}
								<div className="text-muted-foreground">The compiled hierarchy is source-owned. Detach it before manual hierarchy or visual-editor changes.</div>
							</>
						)}
					</div>
				</EditorInspectorSectionField>

				{authoring?.retainedDocument && (
					<EditorInspectorSectionField
						title="UI Toolkit 6.5"
						tooltip="Portable PanelRenderer, hierarchy, USS statistics/staging, references, animation, test clicks, and retained attribute override affordances."
					>
						<div className="flex flex-col gap-2 px-1 text-xs" data-testid="gui-toolkit-65-status">
							<div className="grid grid-cols-2 gap-2">
								<select
									className="rounded bg-input p-1"
									value={authoring.toolkit.panelRenderer.renderMode}
									onChange={(event) =>
										this.setState({
											authoring: {
												...authoring,
												toolkit: {
													...authoring.toolkit,
													panelRenderer: { ...authoring.toolkit.panelRenderer, renderMode: event.currentTarget.value as "overlay" | "worldSpace" },
												},
											},
										})
									}
								>
									<option value="overlay">Overlay</option>
									<option value="worldSpace">World Space</option>
								</select>
								<Input
									value={this.state.panelTargetMeshId}
									onChange={(event) => this.setState({ panelTargetMeshId: event.currentTarget.value })}
									placeholder="Target mesh id/name"
									disabled={authoring.toolkit.panelRenderer.renderMode === "overlay"}
								/>
							</div>
							<Button size="sm" onClick={() => void this._applyPanelRenderer()}>
								Apply PanelRenderer
							</Button>
							<div>
								{this.state.toolkitWorkspace?.hierarchy?.total ?? 0} visual elements · {this.state.toolkitWorkspace?.uss?.styleRuleCount ?? 0} USS selectors ·{" "}
								{this.state.toolkitWorkspace?.uss?.unmatchedSelectorCount ?? 0} unmatched
							</div>
							<div className="rounded border border-border p-2">
								<div className="mb-1 text-muted-foreground">Stylesheets (drag to reorder cascade)</div>
								{authoring.toolkit.stylesheetStage.stylesheetOrder.map((path, index) => (
									<button
										key={path}
										draggable
										onDragStart={(event) => event.dataTransfer.setData("text/zvibe-uss-index", String(index))}
										onDragOver={(event) => event.preventDefault()}
										onDrop={(event) => void this._moveStylesheet(Number(event.dataTransfer.getData("text/zvibe-uss-index")), index)}
										className={`block w-full truncate rounded px-2 py-1 text-left ${authoring.toolkit.stylesheetStage.activeStylesheetPath === path ? "bg-primary/30 font-bold" : "bg-input"}`}
										onClick={() => void this._activateStylesheet(path)}
									>
										{path}
									</button>
								))}
							</div>
							<div className="border-l-2 border-sky-500 pl-2">
								<div className="text-sky-300">Attribute override</div>
								<div className="grid grid-cols-2 gap-2">
									<Input
										value={this.state.overrideProperty}
										onChange={(event) => this.setState({ overrideProperty: event.currentTarget.value })}
										placeholder="alpha"
									/>
									<Input value={this.state.overrideValue} onChange={(event) => this.setState({ overrideValue: event.currentTarget.value })} placeholder="1" />
								</div>
								<Button size="sm" disabled={!this.state.selectedControlId} onClick={() => void this._applyAttributeOverride()}>
									Set Override
								</Button>
								{authoring.toolkit.attributeOverrides.map((override) => (
									<div key={`${override.controlId}:${override.property}`} className="mt-1 flex items-center justify-between rounded bg-input px-2 py-1">
										<span>
											{override.controlId}.{override.property} = {String(override.value)}
										</span>
										<Button size="sm" variant="destructive" onClick={() => void this._deleteAttributeOverride(override.controlId, override.property)}>
											Unset
										</Button>
									</div>
								))}
							</div>
							<div className="text-muted-foreground">
								{authoring.toolkit.references.length} references · {authoring.toolkit.animations.length} animation tracks · exact revision {authoring.revision}
							</div>
						</div>
					</EditorInspectorSectionField>
				)}

				{authoring && canvas && (
					<EditorInspectorSectionField title="Canvas Scaler & Safe Area" tooltip="Unity-style reference-resolution scaling and normalized device-safe-area padding.">
						<div className="flex flex-col gap-2 px-1 text-xs">
							<div className="grid grid-cols-2 gap-2">
								<label>
									Reference Width
									<Input
										type="number"
										value={canvas.referenceWidth}
										onChange={(event) => this._editCanvas({ referenceWidth: Number(event.currentTarget.value) })}
									/>
								</label>
								<label>
									Reference Height
									<Input
										type="number"
										value={canvas.referenceHeight}
										onChange={(event) => this._editCanvas({ referenceHeight: Number(event.currentTarget.value) })}
									/>
								</label>
							</div>
							<label>
								Scale Mode
								<select
									className="w-full rounded bg-input p-1"
									value={canvas.scaleMode}
									onChange={(event) => this._editCanvas({ scaleMode: event.currentTarget.value as IGUIAuthoringState["canvas"]["scaleMode"] })}
								>
									<option value="constantPixelSize">Constant Pixel Size</option>
									<option value="scaleWithScreenSize">Scale With Screen Size</option>
									<option value="constantPhysicalSize">Constant Physical Size</option>
								</select>
							</label>
							<label>
								Screen Match
								<select
									className="w-full rounded bg-input p-1"
									value={canvas.screenMatchMode}
									onChange={(event) => this._editCanvas({ screenMatchMode: event.currentTarget.value as IGUIAuthoringState["canvas"]["screenMatchMode"] })}
								>
									<option value="matchWidthOrHeight">Match Width Or Height</option>
									<option value="expand">Expand</option>
									<option value="shrink">Shrink</option>
								</select>
							</label>
							<label>
								Width/Height Match ({canvas.matchWidthOrHeight.toFixed(2)})
								<input
									className="w-full"
									type="range"
									min="0"
									max="1"
									step="0.01"
									value={canvas.matchWidthOrHeight}
									onChange={(event) => this._editCanvas({ matchWidthOrHeight: Number(event.currentTarget.value) })}
								/>
							</label>
							<label className="flex items-center gap-2">
								<input type="checkbox" checked={canvas.safeArea.enabled} onChange={(event) => this._editSafeArea({ enabled: event.currentTarget.checked })} />{" "}
								Enable Safe Area
							</label>
							<div className="grid grid-cols-4 gap-1">
								{(["left", "top", "right", "bottom"] as const).map((edge) => (
									<label key={edge} className="capitalize">
										{edge}
										<Input
											type="number"
											min="0"
											max="0.99"
											step="0.01"
											value={canvas.safeArea[edge]}
											onChange={(event) => this._editSafeArea({ [edge]: Number(event.currentTarget.value) })}
										/>
									</label>
								))}
							</div>
							<Button size="sm" onClick={() => void this._applyCanvas()}>
								Apply Canvas (revision {authoring.revision})
							</Button>
						</div>
					</EditorInspectorSectionField>
				)}

				{authoring && (
					<EditorInspectorSectionField title="CanvasGroup & Raycasts" tooltip="Unity-style hierarchy alpha/input policy and invisible pointer hit targets.">
						<div className="flex flex-col gap-2 px-1 text-xs">
							{this._selectedCanvasGroup() ? (
								<>
									<label>
										Alpha ({this._selectedCanvasGroup()!.alpha.toFixed(2)})
										<input
											className="w-full"
											type="range"
											min="0"
											max="1"
											step="0.01"
											value={this._selectedCanvasGroup()!.alpha}
											onChange={(event) => this._editSelectedCanvasGroup({ alpha: Number(event.currentTarget.value) })}
										/>
									</label>
									{(
										[
											["interactable", "Interactable"],
											["blocksRaycasts", "Blocks Raycasts"],
											["ignoreParentGroups", "Ignore Parent Groups"],
										] as const
									).map(([property, label]) => (
										<label key={property} className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={this._selectedCanvasGroup()![property]}
												onChange={(event) => this._editSelectedCanvasGroup({ [property]: event.currentTarget.checked })}
											/>
											{label}
										</label>
									))}
									<div className="flex gap-2">
										<Button size="sm" onClick={() => void this._applySelectedCanvasGroup()}>
											Apply CanvasGroup
										</Button>
										<Button size="sm" variant="destructive" onClick={() => void this._removeSelectedCanvasGroup()}>
											Remove
										</Button>
									</div>
								</>
							) : (
								<Button
									size="sm"
									disabled={!this._selectedControlIsContainer() || !!authoring.retainedDocument}
									onClick={() => void this._addSelectedCanvasGroup()}
								>
									Add CanvasGroup
								</Button>
							)}
							<Button size="sm" disabled={!this.state.selectedControlId || !!authoring.retainedDocument} onClick={() => void this._toggleSelectedRaycastReceiver()}>
								{this._selectedRaycastReceiver() ? "Remove RaycastReceiver" : "Add RaycastReceiver"}
							</Button>
							<div className="text-muted-foreground">RaycastReceiver participates in pointer hit testing without drawing pixels.</div>
						</div>
					</EditorInspectorSectionField>
				)}

				{authoring && (
					<EditorInspectorSectionField title="UGUI Usage Tracking" tooltip="Opt-in local counters; no telemetry is transmitted outside this editor process.">
						<div className="flex flex-col gap-2 px-1 text-xs">
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={authoring.usageTracking.enabled}
									onChange={(event) => this._editUsageTracking({ enabled: event.currentTarget.checked })}
								/>
								Enabled (local only)
							</label>
							<label>
								Recent Event Limit
								<Input
									type="number"
									min="0"
									max="2048"
									value={authoring.usageTracking.maxRecentEvents}
									onChange={(event) => this._editUsageTracking({ maxRecentEvents: Number(event.currentTarget.value) })}
								/>
							</label>
							<div className="grid grid-cols-3 gap-2">
								<Button size="sm" onClick={() => void this._applyUsageTracking()}>
									Apply
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._refresh()}>
									Refresh
								</Button>
								<Button size="sm" variant="destructive" onClick={() => this._resetUsageTracking()}>
									Reset
								</Button>
							</div>
							{this.state.usageEvidence && <pre className="max-h-44 overflow-auto rounded bg-input p-2">{JSON.stringify(this.state.usageEvidence, null, 2)}</pre>}
						</div>
					</EditorInspectorSectionField>
				)}

				<EditorInspectorSectionField title="Control Hierarchy" tooltip="Stable ids and typed edits share the same backend as external MCP agents.">
					<div className="flex flex-col gap-2 px-1 text-xs">
						<select className="w-full rounded bg-input p-1" value={this.state.selectedControlId} onChange={(event) => this._selectControl(event.currentTarget.value)}>
							<option value="">Select a control…</option>
							{this.state.controls.map((control) => (
								<option key={control.id} value={control.id}>
									{control.path} [{control.id}]
								</option>
							))}
						</select>
						<textarea
							className="min-h-40 w-full rounded bg-input p-2 font-mono"
							value={this.state.controlProperties}
							onChange={(event) => this.setState({ controlProperties: event.currentTarget.value, error: null })}
						/>
						<div className="flex gap-2">
							<Button size="sm" disabled={!this.state.selectedControlId || !!authoring?.retainedDocument} onClick={() => void this._updateControl()}>
								Update
							</Button>
							<Button
								size="sm"
								variant="destructive"
								disabled={!this.state.selectedControlId || !!authoring?.retainedDocument}
								onClick={() => void this._deleteControl()}
							>
								Delete
							</Button>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<Input value={this.state.newControlName} onChange={(event) => this.setState({ newControlName: event.currentTarget.value })} />
							<select
								className="rounded bg-input p-1"
								value={this.state.newControlType}
								onChange={(event) => this.setState({ newControlType: event.currentTarget.value })}
							>
								{controlTypes.map((type) => (
									<option key={type}>{type}</option>
								))}
							</select>
						</div>
						<select
							className="w-full rounded bg-input p-1"
							value={this.state.newParentControlId}
							onChange={(event) => this.setState({ newParentControlId: event.currentTarget.value })}
						>
							<option value="">Create at canvas root</option>
							{this.state.controls
								.filter((control) => containerControlTypes.has(control.type))
								.map((control) => (
									<option key={control.id} value={control.id}>
										Inside {control.path}
									</option>
								))}
						</select>
						<Button size="sm" disabled={!authoring || !!authoring.retainedDocument} onClick={() => void this._createControl()}>
							Create Control
						</Button>
					</div>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Font Fallback Chain"
					tooltip="Assign ordered project TTF/OTF/WOFF assets; every importer mode retains a browser-loadable source fallback."
				>
					<div className="flex flex-col gap-2 px-1 text-xs">
						<textarea
							className="min-h-20 w-full rounded bg-input p-2 font-mono"
							placeholder="assets/fonts/Primary.ttf\nassets/fonts/Fallback.ttf"
							value={this.state.fontPaths}
							onChange={(event) => this.setState({ fontPaths: event.currentTarget.value })}
						/>
						<div className="grid grid-cols-2 gap-2">
							<select
								className="rounded bg-input p-1"
								value={this.state.fontStyle}
								onChange={(event) => this.setState({ fontStyle: event.currentTarget.value as "normal" | "italic" })}
							>
								<option value="normal">Normal</option>
								<option value="italic">Italic</option>
							</select>
							<Input
								value={this.state.fontWeight}
								onChange={(event) => this.setState({ fontWeight: event.currentTarget.value })}
								placeholder="normal, bold, 100-900"
							/>
						</div>
						<Button size="sm" disabled={!this.state.selectedControlId} onClick={() => void this._applyFont()}>
							Apply / Clear Font Assignment
						</Button>
					</div>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Atlas / TMP Rich Text"
					tooltip="Render an Image control from imported bitmap, SDF, or MSDF pages with rich tags, fallback fonts, wrapping, alignment, outlines, and bounded runtime glyph population."
				>
					<div className="flex flex-col gap-2 px-1 text-xs">
						<div className="text-muted-foreground">
							Select an Image control. Supported tags: &lt;b&gt;, &lt;i&gt;, &lt;u&gt;, &lt;s&gt;, &lt;color=#...&gt;, &lt;size=...&gt;, and &lt;br&gt;.
						</div>
						<textarea
							className="min-h-72 w-full rounded bg-input p-2 font-mono text-xs"
							value={this.state.atlasTextJson}
							onChange={(event) => this.setState({ atlasTextJson: event.currentTarget.value, error: null })}
						/>
						<div className="flex gap-2">
							<Button size="sm" disabled={!this.state.selectedControlId} onClick={() => void this._applyAtlasText()}>
								Apply Atlas Text
							</Button>
							<Button size="sm" variant="destructive" disabled={!this._selectedAtlasText()} onClick={() => void this._clearAtlasText()}>
								Clear Assignment
							</Button>
						</div>
						{this.state.atlasTextRuntime && <pre className="max-h-44 overflow-auto rounded bg-input p-2">{JSON.stringify(this.state.atlasTextRuntime, null, 2)}</pre>}
					</div>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Event Bindings" tooltip="Bind pointer/value/text/focus events to attached script methods or named custom events.">
					<div className="flex flex-col gap-2 px-1 text-xs">
						<textarea
							className="min-h-52 w-full rounded bg-input p-2 font-mono"
							value={this.state.bindingJson}
							onChange={(event) => this.setState({ bindingJson: event.currentTarget.value })}
						/>
						<Button size="sm" disabled={!authoring} onClick={() => void this._createBinding()}>
							Create Binding
						</Button>
						{authoring?.bindings.map((binding) => (
							<div key={binding.id} className="flex items-center justify-between rounded bg-input p-2">
								<span>
									{binding.id}: {binding.controlId}.{binding.event} → {binding.target.kind}
								</span>
								<Button size="sm" variant="destructive" onClick={() => void this._deleteBinding(binding.id)}>
									Delete
								</Button>
							</div>
						))}
					</div>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Serialized GUI & Asset" tooltip="Advanced Dynamic Texture JSON escape hatch and reusable asset persistence.">
					<div className="flex flex-col gap-2">
						<textarea
							value={this.state.content}
							aria-label="GUI serialized control tree"
							onChange={(event) => this.setState({ content: event.currentTarget.value, error: null })}
							className="min-h-64 w-full rounded bg-input p-2 font-mono text-xs"
						/>
						<div className="flex gap-2">
							<Button size="sm" variant="secondary" onClick={() => this._refresh()}>
								Reload
							</Button>
							<Button size="sm" onClick={() => void this._applyContent()}>
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

	private _refresh(): void {
		try {
			const identity = { guiId: this.props.object.uniqueId.toString(), offset: 0, limit: 200 };
			const content = getGUIContent(this._scene(), identity).content;
			const result = getGUIAuthoring(this._scene(), identity);
			const usage = getGUIUsageTracking(this._scene(), { ...identity, offset: 0, limit: 20 });
			const toolkitWorkspace = result.authoring.retainedDocument ? inspectGUIToolkitWorkspace(this._scene(), identity) : null;
			const controls = result.controls.items as IGUIInspectorControl[];
			const selected = controls.find((control) => control.id === this.state.selectedControlId) ?? controls[0] ?? null;
			const font = selected ? result.authoring.fonts.find((entry: { controlId: string }) => entry.controlId === selected.id) : null;
			const atlasText = selected ? result.authoring.atlasTexts.find((entry: { controlId: string }) => entry.controlId === selected.id) : null;
			const atlasTextRuntime = selected ? result.atlasTextRuntime.find((entry: { controlId: string }) => entry.controlId === selected.id) : null;
			this.setState({
				content: JSON.stringify(content, null, 2),
				authoring: result.authoring,
				controls,
				selectedControlId: selected?.id ?? "",
				controlProperties: JSON.stringify(selected?.properties ?? {}, null, 2),
				fontPaths: font?.assetPaths.join("\n") ?? "",
				fontStyle: font?.fontStyle ?? "normal",
				fontWeight: font?.fontWeight ?? "normal",
				atlasTextJson: JSON.stringify(
					atlasText ?? { ...createDefaultGUIAtlasTextAssignment(selected?.id ?? "control"), fontAssetPaths: ["assets/fonts/Primary.ttf"] },
					null,
					2
				),
				atlasTextRuntime,
				retainedUXMLPath: result.authoring.retainedDocument?.uxmlPath ?? this.state.retainedUXMLPath,
				retainedHotReload: result.authoring.retainedDocument?.hotReload ?? this.state.retainedHotReload,
				usageEvidence: usage.evidence,
				toolkitWorkspace,
				panelTargetMeshId: result.authoring.toolkit.panelRenderer.targetMeshId ?? "",
				error: null,
			});
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Could not read GUI authoring state." });
		}
	}

	private async _locateAsset(): Promise<void> {
		if (!projectConfiguration.path) {
			return;
		}
		const projectDirectory = dirname(projectConfiguration.path);
		for (const file of await normalizedGlob(join(projectDirectory, "assets/**/*.gui"), { nodir: true })) {
			try {
				const absolutePath = String(file);
				const data = await readJSON(absolutePath);
				if (data.uniqueId === this.props.object.uniqueId) {
					this.setState({ assetAbsolutePath: absolutePath, assetPath: relative(projectDirectory, absolutePath) });
					return;
				}
			} catch {
				// Ignore unrelated malformed GUI assets while locating this live instance.
			}
		}
	}

	private _openVisualEditor(): void {
		if (this.state.assetAbsolutePath) {
			ipcRenderer.send("window:open", "build/src/editor/windows/ge", {
				filePath: this.state.assetAbsolutePath,
				projectPath: this.props.editor.state.projectPath,
			});
		}
	}

	private async _openRetainedSource(path: string): Promise<void> {
		try {
			await openInExternalEditor(this.props.editor.state.externalEditorCommand, join(dirname(projectConfiguration.path!), path));
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Could not open retained UI source." });
		}
	}

	private async _attachRetainedDocument(): Promise<void> {
		if (!this.state.authoring) {
			return;
		}
		await this._mutate(() =>
			setGUIRetainedDocument(
				this._scene(),
				{
					guiId: this.props.object.uniqueId.toString(),
					expectedRevision: this.state.authoring!.revision,
					expectedSourceFingerprint: this.state.authoring!.retainedDocument?.compiled.sourceFingerprint ?? null,
					uxmlPath: this.state.retainedUXMLPath,
					hotReload: this.state.retainedHotReload,
				},
				{ editor: this.props.editor }
			)
		);
	}

	private async _refreshRetainedDocument(): Promise<void> {
		const retained = this.state.authoring?.retainedDocument;
		if (!this.state.authoring || !retained) {
			return;
		}
		await this._mutate(() =>
			refreshGUIRetainedDocument(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, expectedSourceFingerprint: retained.compiled.sourceFingerprint },
				{ editor: this.props.editor }
			)
		);
	}

	private async _detachRetainedDocument(): Promise<void> {
		const retained = this.state.authoring?.retainedDocument;
		if (!this.state.authoring || !retained) {
			return;
		}
		await this._mutate(() =>
			detachGUIRetainedDocument(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, expectedSourceFingerprint: retained.compiled.sourceFingerprint },
				{ editor: this.props.editor }
			)
		);
	}

	private async _applyPanelRenderer(): Promise<void> {
		const authoring = this.state.authoring;
		if (!authoring) {
			return;
		}
		const panelRenderer = {
			...authoring.toolkit.panelRenderer,
			targetMeshId: authoring.toolkit.panelRenderer.renderMode === "worldSpace" ? this.state.panelTargetMeshId.trim() || null : null,
		};
		await this._mutate(() =>
			setGUIPanelRenderer(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: authoring.revision, settings: panelRenderer },
				{ editor: this.props.editor }
			)
		);
	}

	private async _setStylesheetStage(stylesheetOrder: string[], activeStylesheetPath: string | null): Promise<void> {
		const authoring = this.state.authoring;
		const retained = authoring?.retainedDocument;
		if (!authoring || !retained) {
			return;
		}
		await this._mutate(() =>
			setGUIStylesheetStage(
				this._scene(),
				{
					guiId: this.props.object.uniqueId.toString(),
					expectedRevision: authoring.revision,
					expectedSourceFingerprint: retained.compiled.sourceFingerprint,
					contextId: authoring.toolkit.stylesheetStage.contextId,
					activeStylesheetPath,
					stylesheetOrder,
				},
				{ editor: this.props.editor }
			)
		);
	}

	private async _moveStylesheet(from: number, to: number): Promise<void> {
		const stage = this.state.authoring?.toolkit.stylesheetStage;
		if (!stage || !Number.isInteger(from) || from < 0 || from >= stage.stylesheetOrder.length || to < 0 || to >= stage.stylesheetOrder.length || from === to) {
			return;
		}
		const order = [...stage.stylesheetOrder];
		const [path] = order.splice(from, 1);
		order.splice(to, 0, path);
		await this._setStylesheetStage(order, stage.activeStylesheetPath);
	}

	private async _activateStylesheet(path: string): Promise<void> {
		const stage = this.state.authoring?.toolkit.stylesheetStage;
		if (stage) {
			await this._setStylesheetStage(stage.stylesheetOrder, path);
		}
	}

	private async _applyAttributeOverride(): Promise<void> {
		const authoring = this.state.authoring;
		if (!authoring || !this.state.selectedControlId) {
			return;
		}
		const text = this.state.overrideValue.trim();
		const value: string | number | boolean = text === "true" ? true : text === "false" ? false : text !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
		await this._mutate(() =>
			setGUIAttributeOverride(
				this._scene(),
				{
					guiId: this.props.object.uniqueId.toString(),
					expectedRevision: authoring.revision,
					override: { controlId: this.state.selectedControlId, property: this.state.overrideProperty.trim(), value },
				},
				{ editor: this.props.editor }
			)
		);
	}

	private async _deleteAttributeOverride(controlId: string, property: string): Promise<void> {
		const authoring = this.state.authoring;
		if (!authoring) {
			return;
		}
		await this._mutate(() =>
			deleteGUIAttributeOverride(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: authoring.revision, controlId, property, confirm: true },
				{ editor: this.props.editor }
			)
		);
	}

	private _selectControl(controlId: string): void {
		const control = this.state.controls.find((entry) => entry.id === controlId);
		const font = this.state.authoring?.fonts.find((entry) => entry.controlId === controlId);
		const atlasText = this.state.authoring?.atlasTexts.find((entry) => entry.controlId === controlId);
		let atlasTextRuntime: Record<string, unknown> | null = null;
		try {
			const identity = { guiId: this.props.object.uniqueId.toString(), offset: 0, limit: 200 };
			atlasTextRuntime = getGUIAuthoring(this._scene(), identity).atlasTextRuntime.find((entry: { controlId: string }) => entry.controlId === controlId) ?? null;
		} catch {
			// The next Inspector refresh will surface any live GUI lookup failure.
		}
		let binding: Record<string, unknown>;
		try {
			binding = JSON.parse(this.state.bindingJson) as Record<string, unknown>;
		} catch {
			binding = { id: "ui-event", event: "pointerClick", enabled: true, target: { kind: "customEvent", eventName: "ui.event", detail: null } };
		}
		binding.controlId = controlId;
		this.setState({
			selectedControlId: controlId,
			controlProperties: JSON.stringify(control?.properties ?? {}, null, 2),
			fontPaths: font?.assetPaths.join("\n") ?? "",
			fontStyle: font?.fontStyle ?? "normal",
			fontWeight: font?.fontWeight ?? "normal",
			atlasTextJson: JSON.stringify(atlasText ?? { ...createDefaultGUIAtlasTextAssignment(controlId || "control"), fontAssetPaths: ["assets/fonts/Primary.ttf"] }, null, 2),
			atlasTextRuntime,
			bindingJson: JSON.stringify(binding, null, 2),
		});
	}

	private _selectedCanvasGroup(): IGUIAuthoringState["canvasGroups"][number] | null {
		return this.state.authoring?.canvasGroups.find((assignment) => assignment.controlId === this.state.selectedControlId) ?? null;
	}

	private _selectedRaycastReceiver(): IGUIAuthoringState["raycastReceivers"][number] | null {
		return this.state.authoring?.raycastReceivers.find((assignment) => assignment.controlId === this.state.selectedControlId) ?? null;
	}

	private _selectedControlIsContainer(): boolean {
		const selected = this.state.controls.find((control) => control.id === this.state.selectedControlId);
		return Boolean(selected && containerControlTypes.has(selected.type));
	}

	private _editSelectedCanvasGroup(updates: Partial<IGUIAuthoringState["canvasGroups"][number]>): void {
		if (!this.state.authoring) {
			return;
		}
		this.setState({
			authoring: {
				...this.state.authoring,
				canvasGroups: this.state.authoring.canvasGroups.map((assignment) =>
					assignment.controlId === this.state.selectedControlId ? { ...assignment, ...updates, controlId: assignment.controlId } : assignment
				),
			},
		});
	}

	private async _addSelectedCanvasGroup(): Promise<void> {
		if (!this.state.authoring || !this.state.selectedControlId) {
			return;
		}
		await this._mutate(() =>
			setGUICanvasGroup(
				this._scene(),
				{
					guiId: this.props.object.uniqueId.toString(),
					expectedRevision: this.state.authoring!.revision,
					controlId: this.state.selectedControlId,
					assignment: { alpha: 1, interactable: true, blocksRaycasts: true, ignoreParentGroups: false },
				},
				{ editor: this.props.editor }
			)
		);
	}

	private async _applySelectedCanvasGroup(): Promise<void> {
		const assignment = this._selectedCanvasGroup();
		if (!this.state.authoring || !assignment) {
			return;
		}
		await this._mutate(() =>
			setGUICanvasGroup(
				this._scene(),
				{
					guiId: this.props.object.uniqueId.toString(),
					expectedRevision: this.state.authoring!.revision,
					controlId: assignment.controlId,
					assignment: {
						alpha: assignment.alpha,
						interactable: assignment.interactable,
						blocksRaycasts: assignment.blocksRaycasts,
						ignoreParentGroups: assignment.ignoreParentGroups,
					},
				},
				{ editor: this.props.editor }
			)
		);
	}

	private async _removeSelectedCanvasGroup(): Promise<void> {
		const assignment = this._selectedCanvasGroup();
		if (!this.state.authoring || !assignment) {
			return;
		}
		await this._mutate(() =>
			setGUICanvasGroup(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, controlId: assignment.controlId, assignment: null },
				{ editor: this.props.editor }
			)
		);
	}

	private async _toggleSelectedRaycastReceiver(): Promise<void> {
		if (!this.state.authoring || !this.state.selectedControlId) {
			return;
		}
		await this._mutate(() =>
			setGUIRaycastReceiver(
				this._scene(),
				{
					guiId: this.props.object.uniqueId.toString(),
					expectedRevision: this.state.authoring!.revision,
					controlId: this.state.selectedControlId,
					enabled: this._selectedRaycastReceiver() ? null : true,
				},
				{ editor: this.props.editor }
			)
		);
	}

	private _editUsageTracking(updates: Partial<IGUIAuthoringState["usageTracking"]>): void {
		if (this.state.authoring) {
			this.setState({ authoring: { ...this.state.authoring, usageTracking: { ...this.state.authoring.usageTracking, ...updates } } });
		}
	}

	private async _applyUsageTracking(): Promise<void> {
		if (!this.state.authoring) {
			return;
		}
		await this._mutate(() =>
			setGUIUsageTracking(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, settings: this.state.authoring!.usageTracking },
				{ editor: this.props.editor }
			)
		);
	}

	private _resetUsageTracking(): void {
		if (!this.state.authoring) {
			return;
		}
		try {
			resetGUIUsageTracking(this._scene(), { guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring.revision });
			this._refresh();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Could not reset GUI usage tracking." });
		}
	}

	private _editCanvas(updates: Partial<IGUIAuthoringState["canvas"]>): void {
		if (this.state.authoring) {
			this.setState({ authoring: { ...this.state.authoring, canvas: { ...this.state.authoring.canvas, ...updates } } });
		}
	}

	private _editSafeArea(updates: Partial<IGUIAuthoringState["canvas"]["safeArea"]>): void {
		if (this.state.authoring) {
			this.setState({
				authoring: { ...this.state.authoring, canvas: { ...this.state.authoring.canvas, safeArea: { ...this.state.authoring.canvas.safeArea, ...updates } } },
			});
		}
	}

	private async _mutate(action: () => Promise<unknown>): Promise<void> {
		const before = captureGUISnapshot(this.props.object);
		try {
			await action();
			const after = captureGUISnapshot(this.props.object);
			registerUndoRedo({
				undo: () => void restoreGUISnapshot(this.props.object, before, { editor: this.props.editor }),
				redo: () => void restoreGUISnapshot(this.props.object, after, { editor: this.props.editor }),
			});
			this._refresh();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "GUI authoring action failed." });
		}
	}

	private async _applyCanvas(): Promise<void> {
		if (!this.state.authoring) {
			return;
		}
		await this._mutate(() =>
			setGUICanvasSettings(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, canvas: this.state.authoring!.canvas },
				{ editor: this.props.editor }
			)
		);
	}

	private async _createControl(): Promise<void> {
		if (!this.state.authoring) {
			return;
		}
		await this._mutate(() =>
			createGUIControl(
				this._scene(),
				{
					guiId: this.props.object.uniqueId.toString(),
					expectedRevision: this.state.authoring!.revision,
					parentControlId: this.state.newParentControlId || null,
					type: this.state.newControlType,
					properties: { name: this.state.newControlName, width: "200px", height: "60px" },
				},
				{ editor: this.props.editor }
			)
		);
	}

	private async _updateControl(): Promise<void> {
		if (!this.state.authoring || !this.state.selectedControlId) {
			return;
		}
		try {
			const properties = JSON.parse(this.state.controlProperties) as IGUIControlProperties;
			await this._mutate(() =>
				updateGUIControl(
					this._scene(),
					{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, controlId: this.state.selectedControlId, properties },
					{ editor: this.props.editor }
				)
			);
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Control properties must be valid JSON." });
		}
	}

	private async _deleteControl(): Promise<void> {
		if (!this.state.authoring || !this.state.selectedControlId) {
			return;
		}
		await this._mutate(() =>
			deleteGUIControl(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, controlId: this.state.selectedControlId },
				{ editor: this.props.editor }
			)
		);
	}

	private async _applyFont(): Promise<void> {
		if (!this.state.authoring || !this.state.selectedControlId) {
			return;
		}
		const assetPaths = this.state.fontPaths
			.split(/\r?\n/)
			.map((path) => path.trim())
			.filter(Boolean);
		await this._mutate(() =>
			setGUIControlFont(
				this._scene(),
				{
					guiId: this.props.object.uniqueId.toString(),
					expectedRevision: this.state.authoring!.revision,
					controlId: this.state.selectedControlId,
					assignment: assetPaths.length
						? { controlId: this.state.selectedControlId, assetPaths, fontStyle: this.state.fontStyle, fontWeight: this.state.fontWeight }
						: null,
				},
				{ editor: this.props.editor }
			)
		);
	}

	private _selectedAtlasText(): IGUIAtlasTextAssignment | null {
		return this.state.authoring?.atlasTexts.find((entry) => entry.controlId === this.state.selectedControlId) ?? null;
	}

	private async _applyAtlasText(): Promise<void> {
		if (!this.state.authoring || !this.state.selectedControlId) {
			return;
		}
		try {
			const assignment = JSON.parse(this.state.atlasTextJson) as IGUIAtlasTextAssignment;
			await this._mutate(() =>
				setGUIAtlasText(
					this._scene(),
					{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, controlId: this.state.selectedControlId, assignment },
					{ editor: this.props.editor }
				)
			);
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Atlas text settings must be valid JSON." });
		}
	}

	private async _clearAtlasText(): Promise<void> {
		if (!this.state.authoring || !this.state.selectedControlId || !this._selectedAtlasText()) {
			return;
		}
		await this._mutate(() =>
			clearGUIAtlasText(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, controlId: this.state.selectedControlId },
				{ editor: this.props.editor }
			)
		);
	}

	private async _createBinding(): Promise<void> {
		if (!this.state.authoring) {
			return;
		}
		try {
			const binding = JSON.parse(this.state.bindingJson);
			await this._mutate(() =>
				createGUIEventBinding(
					this._scene(),
					{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, binding },
					{ editor: this.props.editor }
				)
			);
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Binding must be valid JSON." });
		}
	}

	private async _deleteBinding(bindingId: string): Promise<void> {
		if (!this.state.authoring) {
			return;
		}
		await this._mutate(() =>
			deleteGUIEventBinding(
				this._scene(),
				{ guiId: this.props.object.uniqueId.toString(), expectedRevision: this.state.authoring!.revision, bindingId },
				{ editor: this.props.editor }
			)
		);
	}

	private async _applyContent(): Promise<void> {
		try {
			const content = JSON.parse(this.state.content);
			await this._mutate(async () => setGUIContent(this._scene(), { guiId: this.props.object.uniqueId.toString(), content }, { editor: this.props.editor }));
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "GUI content must be valid JSON." });
		}
	}

	private async _saveAsset(): Promise<void> {
		try {
			await saveGUIAsset(this._scene(), { guiId: this.props.object.uniqueId.toString(), path: this.state.assetPath, overwrite: true }, { editor: this.props.editor });
			await this._locateAsset();
			this.setState({ error: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : "Could not save GUI asset." });
		}
	}

	private _scene(): Scene {
		const scene = this.props.object.getScene();
		if (!scene) {
			throw new Error("This GUI is not attached to a scene.");
		}
		return scene;
	}
}
