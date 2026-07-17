import { extname } from "path/posix";

import { Component, ReactNode } from "react";

import { VscJson } from "react-icons/vsc";
import { AiOutlineMinus, AiOutlinePlus } from "react-icons/ai";

import { Reorder } from "framer-motion";

import { Observer, Node, Tools } from "babylonjs";
import { ISpriteMapTile } from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";

import { SpriteMapNode } from "../../../nodes/sprite-map";

import { onGizmoNodeChangedObservable } from "../../preview/gizmo/gizmo";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { isSpriteMapNode } from "../../../../tools/guards/sprites";
import { onNodeModifiedObservable } from "../../../../tools/observables";
import { computeSpriteMapPreviews } from "../../../../tools/sprite/preview";
import {
	createAnimatedTile,
	createTilePalette,
	clearTileColliderGenerator,
	deleteAnimatedTile,
	deleteTilePalette,
	generateTileColliders,
	refreshTileColliders,
	getTileColliderGenerator,
	listAnimatedTiles,
	listTilePalettes,
	paintTilePalette,
	setAnimatedTile,
	setSpriteMapRuleTiles,
	setTilePalette,
} from "../../../../mcp/sprites/sprites";

import { EditorInspectorListField } from "../fields/list";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorVectorField } from "../fields/vector";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSectionField } from "../fields/section";

import { ScriptInspectorComponent } from "../script/script";

import { EditorTransformNodeInspector } from "../transform";
import { IEditorInspectorImplementationProps } from "../inspector";

export interface IEditorSpriteMapNodeInspectorState {
	dragOver: boolean;
	selectedTile: ISpriteMapTile | null;
	paletteName: string;
	palettePosition: { x: number; y: number };
	animatedTileName: string;
	animatedTileFrames: string;
	animatedTileDuration: number;
}

export class EditorSpriteMapNodeInspector extends Component<IEditorInspectorImplementationProps<SpriteMapNode>, IEditorSpriteMapNodeInspectorState> {
	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: unknown): boolean {
		return isSpriteMapNode(object);
	}

	public constructor(props: IEditorInspectorImplementationProps<SpriteMapNode>) {
		super(props);

		this.state = {
			dragOver: false,
			selectedTile: props.object.tiles?.[0] ?? null,
			paletteName: "Palette",
			palettePosition: { x: 0, y: 0 },
			animatedTileName: "Animated Tile",
			animatedTileFrames: "0, 1",
			animatedTileDuration: 120,
		};
	}

	public render(): ReactNode {
		return (
			<>
				<EditorInspectorSectionField title="Common">
					<EditorInspectorStringField
						label="Name"
						object={this.props.object}
						property="name"
						onChange={() => onNodeModifiedObservable.notifyObservers(this.props.object)}
					/>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Transforms">
					<EditorInspectorVectorField label={<div className="w-14">Position</div>} object={this.props.object} property="position" />
					{EditorTransformNodeInspector.GetRotationInspector(this.props.object)}
				</EditorInspectorSectionField>

				<ScriptInspectorComponent editor={this.props.editor} object={this.props.object} />

				{this.props.object.spriteMap ? this._getOptionsInspector() : this._getAtlasJsonDraggableZone()}
				{this.props.object.spriteMap ? this._getTilePaletteInspector() : null}
				{this.props.object.spriteMap ? this._getAnimatedTilesInspector() : null}
				{this.props.object.spriteMap ? this._getTileColliderInspector() : null}
				{this.props.object.spriteMap ? this._getRuleTileInspector() : null}
			</>
		);
	}

	private _gizmoObserver: Observer<Node> | null = null;

	public async componentDidMount(): Promise<void> {
		this._gizmoObserver = onGizmoNodeChangedObservable.add((node) => {
			if (node === this.props.object) {
				this.props.editor.layout.inspector.forceUpdate();
			}
		});

		this._computeSpritePreviewImages();
	}

	public componentWillUnmount(): void {
		if (this._gizmoObserver) {
			onGizmoNodeChangedObservable.remove(this._gizmoObserver);
		}
	}

	private async _computeSpritePreviewImages(): Promise<void> {
		await computeSpriteMapPreviews(this.props.object);
		this.forceUpdate();
	}

	private _getAtlasJsonDraggableZone(): ReactNode {
		return (
			<EditorInspectorSectionField title="Sprite Map">
				<div
					onDragOver={(ev) => {
						ev.preventDefault();
						this.setState({
							dragOver: true,
						});
					}}
					onDragLeave={(ev) => {
						ev.preventDefault();
						this.setState({
							dragOver: false,
						});
					}}
					onDrop={async (ev) => {
						ev.preventDefault();
						this.setState({
							dragOver: false,
						});

						const path = JSON.parse(ev.dataTransfer.getData("assets"))[0];
						const extension = extname(path).toLowerCase();
						if (extension === ".json") {
							await this.props.object.buildFromAbsolutePath(path);
							await this._computeSpritePreviewImages();
							this.forceUpdate();
						}
					}}
					className={`
						flex flex-col gap-4 justify-center items-center p-2 rounded-lg
						border-[1px] border-secondary-foreground/35 border-dashed
						${this.state.dragOver ? "bg-muted-foreground/75 dark:bg-muted-foreground/20" : ""}
						transition-all duration-300 ease-in-out
					`}
				>
					<VscJson size="64px" className="opacity-50" />
					<div className="flex flex-col items-center">
						<div>No Atlas JSON file assigned yet.</div>
						<div className="font-semibold text-muted-foreground">Drag'n'drop an Atlas JSON file here.</div>
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _tilesBeforePan: ISpriteMapTile[] | null = null;

	private _getOptionsInspector(): ReactNode {
		const options = this.props.object.spriteMap!.options;

		return (
			<>
				<EditorInspectorSectionField title="Sprite Map Options">
					<EditorInspectorNumberField
						noUndoRedo
						object={options}
						property="layerCount"
						label="Layer Count"
						min={1}
						max={8}
						step={1}
						onChange={() => this.props.object.updateFromOptions(options)}
						onFinishChange={() => this._handleOptionsUndoRedo()}
					/>
					<EditorInspectorVectorField
						noUndoRedo
						object={options}
						property="stageSize"
						label="Stage Size"
						step={1}
						onChange={() => this.props.object.updateFromOptions(options)}
						onFinishChange={() => this._handleOptionsUndoRedo()}
					/>
					<EditorInspectorVectorField
						noUndoRedo
						object={options}
						property="outputSize"
						label="Output Size"
						step={1}
						onChange={() => this.props.object.updateFromOptions(options)}
						onFinishChange={() => this._handleOptionsUndoRedo()}
					/>
					<EditorInspectorVectorField
						noUndoRedo
						object={options}
						property="colorMultiply"
						label="Color Multiply"
						step={1}
						min={0}
						max={1}
						onChange={() => this.props.object.updateFromOptions(options)}
						onFinishChange={() => this._handleOptionsUndoRedo()}
					/>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Tiles">
					<div className="flex justify-between items-center">
						<div className="p-2 font-bold">Tile Sets</div>

						<div className="flex gap-2">
							<Button variant="ghost" disabled={this.state.selectedTile === null} className="p-0.5 w-6 h-6" onClick={() => this._handleRemoveTile()}>
								<AiOutlineMinus className="w-4 h-4" />
							</Button>

							<Button variant="ghost" className="p-0.5 w-6 h-6" onClick={() => this._handleAddTile()}>
								<AiOutlinePlus className="w-4 h-4" />
							</Button>
						</div>
					</div>

					<Reorder.Group
						axis="y"
						onPanStart={() => {
							this._tilesBeforePan = this.props.object.tiles.slice();
						}}
						onPanEnd={() => {
							if (this._tilesBeforePan) {
								const oldTiles = this._tilesBeforePan;
								const newTiles = this.props.object.tiles.slice();

								registerUndoRedo({
									executeRedo: true,
									undo: () => (this.props.object.tiles = oldTiles),
									redo: () => (this.props.object.tiles = newTiles),
									action: () => this.props.object.updateFromOptions(options),
								});

								this._tilesBeforePan = null;

								this.forceUpdate();
							}
						}}
						onReorder={(items) => {
							this.props.object.tiles = items;
							this.props.object.updateFromOptions(options);
							this.forceUpdate();
						}}
						values={this.props.object.tiles}
						className="flex flex-col rounded-lg bg-black/50 text-white/75 h-96"
					>
						{this.props.object.tiles.map((tile) => (
							<Reorder.Item key={`${tile.name}`} value={tile} id={`${tile.name}`}>
								<div
									onClick={() => this.setState({ selectedTile: tile })}
									className={`p-2 hover:bg-muted/35 ${this.state.selectedTile === tile ? "bg-muted" : ""} transition-all duration-300 ease-in-out`}
								>
									{tile.name}
								</div>
							</Reorder.Item>
						))}
					</Reorder.Group>

					{this._getTileInspector()}
				</EditorInspectorSectionField>
			</>
		);
	}

	private _getTileInspector(): ReactNode {
		if (!this.state.selectedTile) {
			return null;
		}

		const options = this.props.object.spriteMap!.options;

		return (
			<>
				<EditorInspectorStringField object={this.state.selectedTile} property="name" label="Name" onChange={() => this.forceUpdate()} />
				<EditorInspectorVectorField
					object={this.state.selectedTile}
					property="position"
					label="Position"
					step={1}
					min={0}
					max={[this.props.object.spriteMap!.options.stageSize?.x ?? 0, this.props.object.spriteMap!.options.stageSize?.y ?? 0]}
					onChange={() => this.props.object.updateTile(this.state.selectedTile!)}
				/>
				<EditorInspectorVectorField
					object={this.state.selectedTile}
					property="repeatCount"
					label="Repeat Count"
					step={1}
					min={0}
					max={[this.props.object.spriteMap!.options.stageSize?.x ?? 0, this.props.object.spriteMap!.options.stageSize?.y ?? 0]}
					onChange={() => this.props.object.updateTile(this.state.selectedTile!)}
				/>
				<EditorInspectorVectorField
					object={this.state.selectedTile}
					property="repeatOffset"
					label="Repeat Offset"
					step={1}
					min={0}
					max={[this.props.object.spriteMap!.options.stageSize?.x ?? 0, this.props.object.spriteMap!.options.stageSize?.y ?? 0]}
					onChange={() => this.props.object.updateTile(this.state.selectedTile!)}
				/>

				<EditorInspectorListField
					search
					object={this.state.selectedTile}
					property="tile"
					label="Tile"
					items={this.props.object.atlasJson!.frames.map((f, index) => ({
						text: f.filename,
						value: index,
						icon: (
							<div className="flex justify-center items-center w-[24px] h-[24px] bg-secondary rounded-sm">
								<img src={f["_preview"]} className="w-full h-full object-contain" />
							</div>
						),
					}))}
					onChange={() => this.props.object.updateTile(this.state.selectedTile!)}
				/>

				{(options.layerCount ?? 1) > 1 && (
					<EditorInspectorNumberField
						object={this.state.selectedTile}
						property="layer"
						label="Layer"
						min={0}
						max={(options.layerCount ?? 1) - 1}
						step={1}
						onChange={() => this.props.object.updateFromOptions(options)}
					/>
				)}
			</>
		);
	}

	private _getTilePaletteInspector(): ReactNode {
		const palettes = listTilePalettes(this.props.object.getScene()).palettes.filter((palette: any) => palette.mapNodeId === this.props.object.id) as any[];
		const selectedFrame = (this.state.selectedTile as any)?.ruleSource ?? this.state.selectedTile?.tile ?? 0;
		return (
			<EditorInspectorSectionField
				title="Tile Palettes"
				tooltip="Reusable tile brushes with persisted rectangular paint/erase operations. The same palette assets are available through MCP."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
						<input
							value={this.state.paletteName}
							aria-label="Tile palette name"
							onChange={(event) => this.setState({ paletteName: event.currentTarget.value })}
							className="rounded bg-input px-2 py-1 text-sm"
						/>
						<Button size="sm" disabled={!this.state.paletteName.trim()} onClick={() => this._createTilePalette(selectedFrame)}>
							Create from Frame {selectedFrame}
						</Button>
					</div>
					{palettes.map((palette) => (
						<div key={palette.id} className="flex flex-col gap-2 rounded-lg bg-input p-2 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="font-medium">{palette.name}</span>
								<Button size="sm" variant="ghost" className="h-6 px-1 !text-red-400" onClick={() => this._deleteTilePalette(palette.id)}>
									Remove
								</Button>
							</div>
							<div className="flex flex-wrap gap-1">
								{palette.tileIndexes.map((index: number) => (
									<Button
										key={index}
										size="sm"
										variant={palette.activeTileIndex === index ? "default" : "secondary"}
										className="h-6 px-2"
										onClick={() => this._setPaletteTile(palette.id, index)}
									>
										{index}
									</Button>
								))}
								<Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => this._addPaletteTile(palette, selectedFrame)}>
									+ Frame {selectedFrame}
								</Button>
							</div>
							<div className="grid grid-cols-[1fr_1fr_auto_auto] gap-1">
								<input
									type="number"
									value={this.state.palettePosition.x}
									aria-label="Tile palette grid x"
									onChange={(event) => this.setState({ palettePosition: { ...this.state.palettePosition, x: Number(event.currentTarget.value) } })}
									className="rounded bg-background px-2 py-1"
								/>
								<input
									type="number"
									value={this.state.palettePosition.y}
									aria-label="Tile palette grid y"
									onChange={(event) => this.setState({ palettePosition: { ...this.state.palettePosition, y: Number(event.currentTarget.value) } })}
									className="rounded bg-background px-2 py-1"
								/>
								<Button size="sm" onClick={() => this._paintPalette(palette.id, "paint")}>
									Paint
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._paintPalette(palette.id, "erase")}>
									Erase
								</Button>
							</div>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createTilePalette(tileIndex: number): void {
		try {
			createTilePalette(
				this.props.object.getScene(),
				{ mapNodeId: this.props.object.id, name: this.state.paletteName.trim(), tileIndexes: [tileIndex] },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	private _setPaletteTile(paletteId: string, activeTileIndex: number): void {
		setTilePalette(this.props.object.getScene(), { paletteId, activeTileIndex }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _addPaletteTile(palette: any, tileIndex: number): void {
		setTilePalette(this.props.object.getScene(), { paletteId: palette.id, tileIndexes: [...new Set([...palette.tileIndexes, tileIndex])] }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _paintPalette(paletteId: string, mode: "paint" | "erase"): void {
		try {
			paintTilePalette(
				this.props.object.getScene(),
				{ paletteId, position: [this.state.palettePosition.x, this.state.palettePosition.y], mode },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	private _deleteTilePalette(paletteId: string): void {
		deleteTilePalette(this.props.object.getScene(), { paletteId }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _getAnimatedTilesInspector(): ReactNode {
		const animations = listAnimatedTiles(this.props.object.getScene(), { mapNodeId: this.props.object.id }).animations as any[];
		const selectedTile = this.state.selectedTile;
		return (
			<EditorInspectorSectionField
				title="Animated Tiles"
				tooltip="Cycles selected Sprite Map cells through atlas frames in the editor and generated game. Frame duration is in milliseconds."
			>
				<div className="flex flex-col gap-2">
					<input
						value={this.state.animatedTileName}
						aria-label="Animated tile name"
						onChange={(event) => this.setState({ animatedTileName: event.currentTarget.value })}
						className="rounded bg-input px-2 py-1 text-sm"
					/>
					<div className="grid grid-cols-[minmax(0,1fr)_5rem_auto] gap-2">
						<input
							value={this.state.animatedTileFrames}
							aria-label="Animated tile frames"
							onChange={(event) => this.setState({ animatedTileFrames: event.currentTarget.value })}
							placeholder="0, 1, 2"
							className="rounded bg-input px-2 py-1 text-sm"
						/>
						<input
							type="number"
							min={1}
							value={this.state.animatedTileDuration}
							aria-label="Animated tile duration"
							onChange={(event) => this.setState({ animatedTileDuration: Number(event.currentTarget.value) })}
							className="rounded bg-input px-2 py-1 text-sm"
						/>
						<Button size="sm" disabled={!selectedTile || !this.state.animatedTileName.trim()} onClick={() => this._createAnimatedTile()}>
							Create
						</Button>
					</div>
					{animations.map((animation) => (
						<div key={animation.id} className="flex items-center justify-between gap-2 rounded-lg bg-input p-2 text-xs">
							<span className="truncate">
								{animation.name}: [{animation.frames.join(", ")}] · {animation.frameDuration}ms
							</span>
							<div className="flex gap-1">
								<Button
									size="sm"
									variant={animation.enabled ? "default" : "secondary"}
									className="h-6 px-2"
									onClick={() => this._setAnimatedTile(animation.id, { enabled: !animation.enabled })}
								>
									{animation.enabled ? "On" : "Off"}
								</Button>
								<Button
									size="sm"
									variant={animation.loop ? "default" : "secondary"}
									className="h-6 px-2"
									onClick={() => this._setAnimatedTile(animation.id, { loop: !animation.loop })}
								>
									Loop
								</Button>
								<Button size="sm" variant="ghost" className="h-6 px-1 !text-red-400" onClick={() => this._deleteAnimatedTile(animation.id)}>
									Remove
								</Button>
							</div>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createAnimatedTile(): void {
		try {
			const frames = this.state.animatedTileFrames
				.split(",")
				.map((value) => Number(value.trim()))
				.filter(Number.isFinite);
			createAnimatedTile(
				this.props.object.getScene(),
				{
					mapNodeId: this.props.object.id,
					name: this.state.animatedTileName.trim(),
					tileIds: [this.state.selectedTile!.id],
					frames,
					frameDuration: this.state.animatedTileDuration,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	private _setAnimatedTile(id: string, update: any): void {
		setAnimatedTile(this.props.object.getScene(), { mapNodeId: this.props.object.id, id, ...update }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _deleteAnimatedTile(id: string): void {
		deleteAnimatedTile(this.props.object.getScene(), { mapNodeId: this.props.object.id, id }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _getTileColliderInspector(): ReactNode {
		const generator = getTileColliderGenerator(this.props.object.getScene(), { mapNodeId: this.props.object.id }).generator as any;
		const selectedFrame = (this.state.selectedTile as any)?.ruleSource ?? this.state.selectedTile?.tile;
		return (
			<EditorInspectorSectionField
				title="Tile Colliders"
				tooltip="Generate static 2D physics box bodies for painted Sprite Map cells. Composite mode merges adjacent cells into rectangles to reduce solver bodies."
			>
				<div className="flex flex-col gap-2 text-xs">
					<div>{generator ? `${generator.nodeIds.length} generated static collider${generator.nodeIds.length === 1 ? "" : "s"}` : "No generated tile colliders."}</div>
					<div className="flex gap-2">
						<Button size="sm" disabled={selectedFrame === undefined} onClick={() => this._generateTileColliders(selectedFrame, true)}>
							Generate Frame {selectedFrame ?? ""}
						</Button>
						<Button size="sm" variant="secondary" onClick={() => this._generateTileColliders(undefined, true)}>
							Generate Composite
						</Button>
						<Button size="sm" variant="secondary" onClick={() => this._generateTileColliders(undefined, false)}>
							Per Cell
						</Button>
						<Button size="sm" variant="secondary" disabled={!generator} onClick={() => this._refreshTileColliders()}>
							Refresh
						</Button>
						<Button size="sm" variant="ghost" className="!text-red-400" disabled={!generator} onClick={() => this._clearTileColliders()}>
							Clear
						</Button>
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _generateTileColliders(tileIndex: number | undefined, merge: boolean): void {
		try {
			generateTileColliders(
				this.props.object.getScene(),
				{ mapNodeId: this.props.object.id, merge, ...(tileIndex === undefined ? {} : { tileIndexes: [tileIndex] }) },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	private _clearTileColliders(): void {
		clearTileColliderGenerator(this.props.object.getScene(), { mapNodeId: this.props.object.id }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _refreshTileColliders(): void {
		try {
			refreshTileColliders(this.props.object.getScene(), { mapNodeId: this.props.object.id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	private _getRuleTileInspector(): ReactNode {
		const rules = this.props.object.metadata?.babylonEditorRuleTiles ?? [];
		const directions = ["north", "northEast", "east", "southEast", "south", "southWest", "west", "northWest"];
		return (
			<EditorInspectorSectionField
				title="Rule Tiles"
				tooltip="Author deterministic eight-neighbor atlas-frame rules and weighted output variants. The same persisted configuration is available through MCP."
			>
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2">
						<div className="text-xs text-muted-foreground">
							{rules.length} persisted rule{rules.length === 1 ? "" : "s"}
						</div>
						<Button size="sm" variant="secondary" disabled={!this.state.selectedTile} onClick={() => this._createBasicRuleTile()}>
							Add Rule from Selected Tile
						</Button>
					</div>
					{rules.map((rule: any, ruleIndex: number) => (
						<div key={`${ruleIndex}-${rule.sourceTile}`} className="flex flex-col gap-2 rounded-lg bg-input p-2">
							<div className="grid grid-cols-2 gap-2">
								<label className="flex flex-col gap-1 text-xs">
									Source Frame
									<input
										type="number"
										value={rule.sourceTile}
										onChange={(event) => this._updateRuleTile(ruleIndex, { sourceTile: Number(event.currentTarget.value) })}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									Output Frame
									<input
										type="number"
										value={rule.outputTile ?? ""}
										onChange={(event) => this._updateRuleTile(ruleIndex, { outputTile: Number(event.currentTarget.value) })}
										className="rounded bg-background px-2 py-1"
									/>
								</label>
							</div>
							<div className="grid grid-cols-2 gap-2">
								{directions.map((direction) => (
									<label key={direction} className="flex items-center justify-between gap-2 text-xs capitalize">
										{direction.replace(/([A-Z])/g, " $1")}
										<select
											value={rule.neighbors?.[direction] ?? "any"}
											onChange={(event) => this._updateRuleTile(ruleIndex, { neighbors: { ...rule.neighbors, [direction]: event.currentTarget.value } })}
											className="rounded bg-background px-1 py-1"
										>
											<option value="any">Any</option>
											<option value="same">Same</option>
											<option value="different">Different</option>
										</select>
									</label>
								))}
							</div>
							<div className="flex flex-col gap-1">
								<div className="flex items-center justify-between text-xs">
									<span>Weighted Variants</span>
									<Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => this._addRuleVariant(ruleIndex)}>
										Add Variant
									</Button>
								</div>
								{(rule.variants ?? []).map((variant: any, variantIndex: number) => (
									<div key={variantIndex} className="grid grid-cols-[1fr_1fr_auto] gap-2">
										<input
											type="number"
											aria-label={`Rule ${ruleIndex + 1} variant ${variantIndex + 1} frame`}
											value={variant.tile}
											onChange={(event) => this._updateRuleVariant(ruleIndex, variantIndex, { tile: Number(event.currentTarget.value) })}
											className="rounded bg-background px-2 py-1"
										/>
										<input
											type="number"
											min={0.001}
											step={0.1}
											aria-label={`Rule ${ruleIndex + 1} variant ${variantIndex + 1} weight`}
											value={variant.weight}
											onChange={(event) => this._updateRuleVariant(ruleIndex, variantIndex, { weight: Number(event.currentTarget.value) })}
											className="rounded bg-background px-2 py-1"
										/>
										<Button size="sm" variant="ghost" className="h-7 px-2 !text-red-400" onClick={() => this._removeRuleVariant(ruleIndex, variantIndex)}>
											Remove
										</Button>
									</div>
								))}
							</div>
							<Button size="sm" variant="ghost" className="self-end h-7 px-2 !text-red-400" onClick={() => this._removeRuleTile(ruleIndex)}>
								Remove Rule
							</Button>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _createBasicRuleTile(): void {
		const tile = this.state.selectedTile as any;
		if (!tile) return;
		const sourceTile = tile.ruleSource ?? tile.tile;
		const existing = this.props.object.metadata?.babylonEditorRuleTiles ?? [];
		this._setRuleTiles([...existing.filter((rule: any) => rule.sourceTile !== sourceTile), { sourceTile, outputTile: sourceTile, neighbors: {} }]);
	}

	private _updateRuleTile(ruleIndex: number, update: Record<string, any>): void {
		const rules = this.props.object.metadata?.babylonEditorRuleTiles ?? [];
		this._setRuleTiles(rules.map((rule: any, index: number) => (index === ruleIndex ? { ...rule, ...update } : rule)));
	}

	private _removeRuleTile(ruleIndex: number): void {
		const rules = this.props.object.metadata?.babylonEditorRuleTiles ?? [];
		this._setRuleTiles(rules.filter((_rule: any, index: number) => index !== ruleIndex));
	}

	private _addRuleVariant(ruleIndex: number): void {
		const rules = this.props.object.metadata?.babylonEditorRuleTiles ?? [];
		const rule = rules[ruleIndex];
		this._updateRuleTile(ruleIndex, { variants: [...(rule.variants ?? []), { tile: rule.outputTile ?? rule.sourceTile, weight: 1 }] });
	}

	private _updateRuleVariant(ruleIndex: number, variantIndex: number, update: Record<string, any>): void {
		const rules = this.props.object.metadata?.babylonEditorRuleTiles ?? [];
		const rule = rules[ruleIndex];
		this._updateRuleTile(ruleIndex, { variants: (rule.variants ?? []).map((variant: any, index: number) => (index === variantIndex ? { ...variant, ...update } : variant)) });
	}

	private _removeRuleVariant(ruleIndex: number, variantIndex: number): void {
		const rules = this.props.object.metadata?.babylonEditorRuleTiles ?? [];
		const rule = rules[ruleIndex];
		this._updateRuleTile(ruleIndex, { variants: (rule.variants ?? []).filter((_variant: any, index: number) => index !== variantIndex) });
	}

	private _setRuleTiles(rules: any[]): void {
		setSpriteMapRuleTiles(this.props.object.getScene(), { mapNodeId: this.props.object.id, rules }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _handleOptionsUndoRedo(): void {
		const options = this.props.object.spriteMap?.options;
		if (!options) {
			return;
		}

		const oldOptions = {
			layerCount: options.layerCount,
			stageSize: options.stageSize?.clone(),
			outputSize: options.outputSize?.clone(),
			colorMultiply: options.colorMultiply?.clone(),
		};

		const newOptions = {
			layerCount: options.layerCount,
			stageSize: options.stageSize?.clone(),
			outputSize: options.outputSize?.clone(),
			colorMultiply: options.colorMultiply?.clone(),
		};

		registerUndoRedo({
			executeRedo: true,
			undo: () => this.props.object.updateFromOptions(oldOptions),
			redo: () => this.props.object.updateFromOptions(newOptions),
		});

		this.forceUpdate();
	}

	private _handleAddTile(): void {
		const newTile: ISpriteMapTile = {
			id: Tools.RandomId(),
			name: `Tile ${this.props.object.tiles.length + 1}`,
			layer: 0,
			position: { x: 0, y: 0 },
			repeatCount: { x: 0, y: 0 },
			repeatOffset: { x: 0, y: 0 },
			tile: 1,
		};

		registerUndoRedo({
			executeRedo: true,
			undo: () => this.props.object.tiles.pop(),
			redo: () => this.props.object.tiles.push(newTile),
			action: () => this.props.object.updateFromOptions(this.props.object.spriteMap!.options),
		});

		this.setState({
			selectedTile: newTile,
		});

		this.props.object.updateFromOptions(this.props.object.spriteMap!.options);
	}

	private _handleRemoveTile(): void {
		const tiles = this.props.object.tiles;
		const selectedTile = this.state.selectedTile;

		if (!selectedTile || tiles.length < 2) {
			return;
		}

		const index = tiles.indexOf(selectedTile);
		if (index === -1) {
			return;
		}

		registerUndoRedo({
			executeRedo: true,
			undo: () => tiles.splice(index, 0, selectedTile),
			redo: () => tiles.splice(index, 1),
			action: () => this.props.object.updateFromOptions(this.props.object.spriteMap!.options),
		});

		this.setState({
			selectedTile: tiles[0] ?? null,
		});
	}
}
