import sharp from "sharp";
import { pathExists, writeFile } from "fs-extra";
import { basename, dirname, extname, join, relative } from "path/posix";

import { toast } from "sonner";
import { ReactNode } from "react";

import { AiFillPicture } from "react-icons/ai";

import { ISize } from "babylonjs";

import { IoResizeSharp } from "react-icons/io5";

import { getPowerOfTwoUntil } from "../../../../tools/maths/scalar";
import { findAvailableFilename } from "../../../../tools/fs";

import { projectConfiguration } from "../../../../project/configuration";
import { convertImageAsset } from "../../../../mcp/assets/assets";

import { SpinnerUIComponent } from "../../../../ui/spinner";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "../../../../ui/shadcn/ui/context-menu";

import { AssetsBrowserItem } from "./item";

export class AssetBrowserImageItem extends AssetsBrowserItem {
	private _availableResizes: ISize[] = [];
	private _size = { width: 0, height: 0 } as ISize;
	private _isMounted: boolean = false;

	private _thumbnailError: boolean = false;
	private _thumbnailPath: string | null = null;

	/**
	 * @override
	 */
	protected getContextMenuContent(): ReactNode {
		return (
			<>
				{this._availableResizes.length > 0 && (
					<ContextMenuSub>
						<ContextMenuSubTrigger className="flex items-center gap-2">
							<IoResizeSharp className="w-5 h-5" /> Resize
						</ContextMenuSubTrigger>
						<ContextMenuSubContent>
							<ContextMenuItem disabled>
								Current: {this._size.width}x{this._size.height}
							</ContextMenuItem>
							<ContextMenuSeparator />
							{this._availableResizes.map((size) => (
								<ContextMenuItem key={`${size.width}x${size.height}`} onClick={() => this._handleResize(size.width, size.height)}>
									{size.width}x{size.height}
								</ContextMenuItem>
							))}
						</ContextMenuSubContent>
					</ContextMenuSub>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => this._handleConvertToBitmap()}>Convert to RGBA Bitmap</ContextMenuItem>
			</>
		);
	}

	/**
	 * @override
	 */
	protected getIcon(): ReactNode {
		if (this._thumbnailPath) {
			return <img alt="" src={this._thumbnailPath} className="w-[120px] aspect-square object-contain" />;
		}

		if (this._thumbnailError) {
			return <AiFillPicture size="64px" />;
		}

		return <SpinnerUIComponent width="64px" />;
	}

	/**
	 * @override
	 */
	public async componentDidMount(): Promise<void> {
		this._isMounted = true;
		await super.componentDidMount();
		await this._updateThumbnail();
		await this._updateAvailableSizes();
	}

	/**
	 * @override
	 */
	public componentWillUnmount(): void {
		this._isMounted = false;
		if (this._thumbnailPath) {
			URL.revokeObjectURL(this._thumbnailPath);
		}
	}

	private async _updateThumbnail(): Promise<void> {
		try {
			if (!(await pathExists(this.props.absolutePath))) {
				return this._markThumbnailUnavailable();
			}

			const buffer = (await sharp(this.props.absolutePath).resize(256, 256).toBuffer()) as Buffer<ArrayBuffer>;
			this._thumbnailPath = URL.createObjectURL(new Blob([buffer]));
			this._thumbnailError = false;
		} catch {
			// Files can be corrupt or merely use an image extension. Keep the asset usable without leaking an unhandled Sharp rejection.
			return this._markThumbnailUnavailable();
		}

		if (this._isMounted) {
			this.forceUpdate();
		}
	}

	private async _updateAvailableSizes(): Promise<void> {
		if (this._thumbnailError) {
			return;
		}

		try {
			const metadata = await sharp(this.props.absolutePath).metadata();
			if (metadata.width && metadata.height) {
				this._size.width = metadata.width;
				this._size.height = metadata.height;

				let width = metadata.width * 0.5;
				let height = metadata.height * 0.5;

				while (width > 8 && height > 8) {
					this._availableResizes.push({
						width: getPowerOfTwoUntil(width),
						height: getPowerOfTwoUntil(height),
					});

					width *= 0.5;
					height *= 0.5;
				}

				if (this._isMounted) {
					this.forceUpdate();
				}
			}
		} catch {
			// The file can change between thumbnail decode and metadata inspection; use the same stable fallback in that race.
			this._markThumbnailUnavailable();
		}
	}

	/** Resets decode-derived state so an invalid image renders as a generic asset instead of rejecting its React lifecycle promise. */
	private _markThumbnailUnavailable(): void {
		if (this._thumbnailPath) {
			URL.revokeObjectURL(this._thumbnailPath);
		}
		this._thumbnailPath = null;
		this._thumbnailError = true;
		this._availableResizes = [];
		this._size = { width: 0, height: 0 };
		if (this._isMounted) {
			this.forceUpdate();
		}
	}

	private async _handleResize(width: number, height: number): Promise<void> {
		const selectedFiles = this.props.editor.layout.assets.state.selectedKeys;
		let resizedCount = 0;
		let failedCount = 0;

		await Promise.all(
			selectedFiles.map(async (file) => {
				try {
					const availableResizes: ISize[] = [];
					const metadata = await sharp(file).metadata();

					if (metadata.width && metadata.height) {
						let width = metadata.width * 0.5;
						let height = metadata.height * 0.5;

						while (width > 8 && height > 8) {
							availableResizes.push({
								width: getPowerOfTwoUntil(width),
								height: getPowerOfTwoUntil(height),
							});

							width *= 0.5;
							height *= 0.5;
						}
					}

					const foundSize = availableResizes.find((size) => {
						return size.width === width && size.height === height;
					});

					if (!foundSize) {
						return;
					}

					const buffer = await sharp(file).resize(width, height).toBuffer();
					await writeFile(file, buffer);
					resizedCount += 1;
				} catch {
					// A bad file in a multi-selection must not leak a rejected event-handler promise or prevent valid files from resizing.
					failedCount += 1;
				}
			})
		);

		if (resizedCount) {
			this.props.editor.layout.assets.forceUpdate();
			toast.success(`${resizedCount} image${resizedCount === 1 ? "" : "s"} resized successfully.`);
		}
		if (failedCount) {
			toast.error(`${failedCount} image${failedCount === 1 ? "" : "s"} could not be decoded and ${failedCount === 1 ? "was" : "were"} skipped.`);
		}
	}

	private async _handleConvertToBitmap(): Promise<void> {
		if (!projectConfiguration.path) {
			toast.error("Open a project before converting image assets.");
			return;
		}
		const projectDirectory = dirname(projectConfiguration.path);
		const selectedFiles = this.props.editor.layout.assets.state.selectedKeys.filter((path) =>
			[".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff"].includes(extname(path).toLowerCase())
		);
		const files = selectedFiles.length ? selectedFiles : [this.props.absolutePath];
		try {
			for (const sourcePath of files) {
				const filename = await findAvailableFilename(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}-bitmap`, ".rgba");
				const outputPath = join(dirname(sourcePath), filename);
				await convertImageAsset(
					this.props.editor.layout.preview.scene,
					{ sourcePath: relative(projectDirectory, sourcePath), outputPath: relative(projectDirectory, outputPath), format: "bitmap" },
					{ editor: this.props.editor }
				);
			}
			toast.success(`Converted ${files.length} image${files.length === 1 ? "" : "s"} to RGBA bitmap assets.`);
		} catch (error: any) {
			toast.error(`Image conversion failed: ${error.message}`);
		}
	}
}
