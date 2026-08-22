import { ipcRenderer } from "electron";
import { ReactNode } from "react";
import { TbWaveSine } from "react-icons/tb";

import { ContextMenuItem } from "../../../../ui/shadcn/ui/context-menu";

import { AssetsBrowserItem } from "./item";

export class AssetBrowserAudioGeneratorItem extends AssetsBrowserItem {
	protected getIcon(): ReactNode {
		return <TbWaveSine size="64px" className="text-cyan-400" />;
	}

	protected getContextMenuContent(): ReactNode {
		return <ContextMenuItem onClick={() => this._open()}>Open Audio Generator</ContextMenuItem>;
	}

	protected onDoubleClick(): void {
		this._open();
	}

	private _open(): void {
		ipcRenderer.send("window:open", "build/src/editor/windows/audio-generator", {
			filePath: this.props.absolutePath,
			projectPath: this.props.editor.state.projectPath,
		});
	}
}
