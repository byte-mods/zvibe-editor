import { extname } from "path/posix";

import { writeFile } from "fs-extra";

import { ReactNode } from "react";
import { SiConvertio } from "react-icons/si";
import { MdOutlineHdrOn } from "react-icons/md";

import { toast } from "sonner";

import { EnvironmentTextureTools, EXRCubeTexture, HDRCubeTexture } from "babylonjs";

import { SpinnerUIComponent } from "../../../../ui/spinner";
import { ContextMenuItem } from "../../../../ui/shadcn/ui/context-menu";

import { getOrApplyTextureImporterArtifact } from "../../../../mcp/assets/texture-importer";

import { openEnvViewer } from "../viewers/env-viewer";

import { AssetsBrowserItem } from "./item";

const convertingFiles: string[] = [];

export class AssetBrowserHDRItem extends AssetsBrowserItem {
	/**
	 * @override
	 */
	protected getContextMenuContent(): ReactNode {
		return (
			<>
				<ContextMenuItem onClick={() => openEnvViewer(this.props.absolutePath)}>Preview Environment</ContextMenuItem>
				<ContextMenuItem className="flex items-center gap-2" onClick={() => this._handleConvertToEnv()}>
					<SiConvertio className="w-5 h-5" /> Convert to .env
				</ContextMenuItem>
			</>
		);
	}

	/**
	 * @override
	 */
	protected getIcon(): ReactNode {
		const index = convertingFiles.indexOf(this.props.absolutePath);
		if (index !== -1) {
			return <SpinnerUIComponent width="64px" />;
		}

		return <MdOutlineHdrOn size="64px" />;
	}

	private async _handleConvertToEnv(): Promise<void> {
		const selectedFiles = this.props.editor.layout.assets.state.selectedKeys;
		await Promise.all(
			selectedFiles.map(async (file) => {
				if (convertingFiles.includes(file)) {
					return;
				}

				convertingFiles.push(file);
				this.props.onRefresh();

				try {
					const imported = await getOrApplyTextureImporterArtifact(file);
					const source = imported.result?.outputPath ?? file;
					const hdr =
						extname(source).toLowerCase() === ".exr"
							? new EXRCubeTexture(source, this.props.editor.layout.preview.scene, 512, false, true, false, false)
							: new HDRCubeTexture(source, this.props.editor.layout.preview.scene, 512, false, true, false, false);

					hdr.onLoadObservable.addOnce(async () => {
						try {
							const envBuffer = await EnvironmentTextureTools.CreateEnvTextureAsync(hdr, {
								imageQuality: 1,
							});

							await writeFile(`${file}.env`, Buffer.from(envBuffer));
							toast.success(`Converted ${extname(file).slice(1).toUpperCase()} environment to .env.`);
						} catch (error) {
							toast.error(`Environment conversion failed: ${error instanceof Error ? error.message : String(error)}`);
						} finally {
							hdr.dispose();
							this._finishConversion(file);
						}
					});
				} catch (error) {
					toast.error(`Environment import failed: ${error instanceof Error ? error.message : String(error)}`);
					this._finishConversion(file);
				}
			})
		);
	}

	private _finishConversion(file: string): void {
		const index = convertingFiles.indexOf(file);
		if (index !== -1) {
			convertingFiles.splice(index, 1);
		}
		this.props.onRefresh();
	}
}
