import { ipcRenderer } from "electron";
import { readJSON, writeJSON } from "fs-extra";

import { toast } from "sonner";

import { Component, ReactNode } from "react";

import { NullEngine, Scene } from "babylonjs";
import { AdvancedDynamicTexture } from "babylonjs-gui";
import { applyGUIAuthoringRuntime, createDefaultGUIAuthoringState, getGUIAuthoringState } from "babylonjs-editor-tools";

import { ToolbarComponent } from "../../../ui/toolbar";

import { Toaster } from "../../../ui/shadcn/ui/sonner";

import { waitNextAnimationFrame } from "../../../tools/tools";
import { installEditorGUIFontFamily, loadEditorGUIFontAsset } from "../../../tools/gui/authoring";
import { projectConfiguration } from "../../../project/configuration";
import { configureEditorLocalization } from "../../../mcp/localization/localization";

const { GUIEditor } = require("babylonjs-gui-editor");

export interface INodeMaterialEditorWindowProps {
	filePath: string;
	projectPath: string;
}

export default class NodeMaterialEditorWindow extends Component<INodeMaterialEditorWindowProps> {
	private _divRef: HTMLDivElement | null = null;

	private _gui: AdvancedDynamicTexture | null = null;
	private _authoring = createDefaultGUIAuthoringState();

	public constructor(props: INodeMaterialEditorWindowProps) {
		super(props);
	}

	public render(): ReactNode {
		return (
			<>
				<div className="flex flex-col w-screen h-screen">
					<ToolbarComponent>
						<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
							<div className="flex items-center gap-1 font-semibold text-lg select-none">
								GUI Editor
								<div className="text-sm font-thin">(...{this.props.filePath.substring(this.props.filePath.length - 30)})</div>
							</div>
						</div>
					</ToolbarComponent>

					<div ref={(r) => (this._divRef = r)} className="w-full h-full overflow-hidden" />
				</div>

				<Toaster />
			</>
		);
	}

	public async componentDidMount(): Promise<void> {
		if (!this._divRef) {
			return;
		}

		// Force dark theme here as Node Material Editor doesn't support light theme
		if (!document.body.classList.contains("dark")) {
			document.body.classList.add("dark");
		}

		const data = await readJSON(this.props.filePath);
		this._authoring = data.zvibeGUIAuthoring ?? createDefaultGUIAuthoringState();

		const engine = new NullEngine();
		const scene = new Scene(engine);
		projectConfiguration.path = this.props.projectPath;
		await configureEditorLocalization(scene);

		switch (data.guiType) {
			case "fullscreen":
			case "worldSpace":
				// World-space PanelRenderer assets use a fullscreen authoring preview here; their real mesh attachment is restored by scene/runtime loaders.
				this._gui = AdvancedDynamicTexture.CreateFullscreenUI(data.name, true, scene);
				break;
		}

		if (!this._gui) {
			return;
		}

		this._gui.parseSerializedObject(data.content, false);
		this._gui.uniqueId = data.uniqueId;
		this._gui.metadata = { ...(this._gui.metadata ?? {}), zvibeGUIAuthoring: this._authoring };
		this._authoring = getGUIAuthoringState(this._gui);
		await applyGUIAuthoringRuntime(this._gui, this._authoring, {
			rootUrl: "",
			scene,
			loadFontFamily: installEditorGUIFontFamily,
			loadFontAsset: loadEditorGUIFontAsset,
		});

		GUIEditor.Show({
			hostElement: this._divRef,
			liveGuiTexture: this._gui,
			customSave: {
				label: "Save",
				action: () => this._save(),
			},
		});

		await waitNextAnimationFrame();

		GUIEditor["_CurrentState"].workbench.guiSize = {
			width: data.content.width,
			height: data.content.height,
		};

		ipcRenderer.on("save", () => this._save());
		ipcRenderer.on("editor:close-window", () => this.close());
	}

	public close(): void {
		ipcRenderer.send("window:close");
	}

	private async _save(): Promise<void> {
		if (!this._gui) {
			return;
		}
		if (this._authoring?.retainedDocument) {
			toast.error(`This GUI hierarchy is owned by ${this._authoring.retainedDocument.uxmlPath}. Edit its UXML/USS sources or detach retained authoring first.`);
			return;
		}

		const globalState = GUIEditor["_CurrentState"];
		globalState.workbench.removeEditorTransformation();

		const size = globalState.workbench.guiSize;
		this._gui.scaleTo(size.width, size.height);

		const data = this._gui.serialize();
		data.uniqueId = this._gui.uniqueId;
		data.content = this._gui.serializeContent();
		data.zvibeGUIAuthoring = getGUIAuthoringState(this._gui);
		data.guiType = data.zvibeGUIAuthoring.toolkit.panelRenderer.renderMode === "worldSpace" ? "worldSpace" : "fullscreen";
		data.base64String = globalState.guiTexture.getContext().canvas.toDataURL("image/png");

		await writeJSON(this.props.filePath, data, { spaces: 4 });

		toast.success("GUI saved");

		ipcRenderer.send("editor:asset-updated", "gui", data);
	}
}
