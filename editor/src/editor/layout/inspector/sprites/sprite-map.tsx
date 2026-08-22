import { extname } from "path/posix";

import { Component, ReactNode } from "react";

import { toast } from "sonner";
import { VscJson } from "react-icons/vsc";
import { AiOutlineMinus, AiOutlinePlus } from "react-icons/ai";

import { Reorder } from "framer-motion";

import { Observer, Node, Tools } from "babylonjs";
import { IPhysics2DPolygonContour, ISpriteMapTile, ITilemapColliderSettings, TilemapColliderType } from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";

import { SpriteMapNode } from "../../../nodes/sprite-map";

import { onGizmoNodeChangedObservable } from "../../preview/gizmo/gizmo";

import { onRedoObservable, onUndoObservable, registerUndoRedo } from "../../../../tools/undoredo";
import { isSpriteMapNode } from "../../../../tools/guards/sprites";
import { onNodeModifiedObservable } from "../../../../tools/observables";
import { computeSpriteMapPreviews } from "../../../../tools/sprite/preview";
import {
	createAnimatedTile,
	createTilePalette,
	applyTilePaletteOperation,
	clearTileColliderGenerator,
	deleteAnimatedTile,
	deleteTilePalette,
	generateTileColliders,
	getTilePaintViewport,
	getTilePaintViewportSnapshot,
	getTileGridConfiguration,
	getTileColliderGenerator,
	getTileColliderGeneratorSnapshot,
	listAnimatedTiles,
	listTilePalettes,
	listGridBrushTypes,
	notifySpriteMapTileDataChanged,
	refreshTileColliders,
	restoreTileColliderGeneratorSnapshot,
	restoreTilePaintViewportSnapshot,
	setAnimatedTile,
	setSpriteMapRuleTiles,
	setTileColliderGenerator,
	setTilePaintViewport,
	setTileGridConfiguration,
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
	paletteEndPosition: { x: number; y: number };
	paletteMoveOffset: { x: number; y: number };
	gridBrushData: string;
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
			paletteEndPosition: { x: 0, y: 0 },
			paletteMoveOffset: { x: 1, y: 0 },
			gridBrushData: "{}",
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
	private _undoObserver: Observer<void> | null = null;
	private _redoObserver: Observer<void> | null = null;
	private _tileDataFingerprint: string = "";
	private _committedOptions: any = null;
	private _mounted: boolean = false;

	public async componentDidMount(): Promise<void> {
		this._mounted = true;
		this._gizmoObserver = onGizmoNodeChangedObservable.add((node) => {
			if (node === this.props.object) {
				this.props.editor.layout.inspector.forceUpdate();
			}
		});
		this._tileDataFingerprint = this._getTileDataFingerprint();
		this._committedOptions = this._captureOptions();
		const synchronizeUndoRedo = (): void => {
			const fingerprint = this._getTileDataFingerprint();
			if (fingerprint !== this._tileDataFingerprint) {
				this.props.object.updateFromOptions(this.props.object.spriteMap?.options ?? ({} as any));
				this._notifyTileMapChanged();
			}
			this._committedOptions = this._captureOptions();
		};
		this._undoObserver = onUndoObservable.add(synchronizeUndoRedo);
		this._redoObserver = onRedoObservable.add(synchronizeUndoRedo);

		this._computeSpritePreviewImages();
	}

	public componentWillUnmount(): void {
		this._mounted = false;
		if (this._gizmoObserver) {
			onGizmoNodeChangedObservable.remove(this._gizmoObserver);
		}
		if (this._undoObserver) {
			onUndoObservable.remove(this._undoObserver);
		}
		if (this._redoObserver) {
			onRedoObservable.remove(this._redoObserver);
		}
	}

	private async _computeSpritePreviewImages(): Promise<void> {
		try {
			await computeSpriteMapPreviews(this.props.object);
			if (this._mounted) {
				this.forceUpdate();
			}
		} catch (error) {
			console.warn("Could not generate Sprite Map frame previews.", error);
		}
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
							this._notifyTileMapChanged();
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
						onFinishChange={() => {
							this._handleOptionsUndoRedo();
							this._notifyTileMapChanged();
						}}
					/>
					<EditorInspectorVectorField
						noUndoRedo
						object={options}
						property="stageSize"
						label="Stage Size"
						step={1}
						onChange={() => this.props.object.updateFromOptions(options)}
						onFinishChange={() => {
							this._handleOptionsUndoRedo();
							this._notifyTileMapChanged();
						}}
					/>
					<EditorInspectorVectorField
						noUndoRedo
						object={options}
						property="outputSize"
						label="Output Size"
						step={1}
						onChange={() => this.props.object.updateFromOptions(options)}
						onFinishChange={() => {
							this._handleOptionsUndoRedo();
							this._notifyTileMapChanged();
						}}
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
						onFinishChange={() => {
							this._handleOptionsUndoRedo();
							this._notifyTileMapChanged();
						}}
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
									action: () => {
										this.props.object.updateFromOptions(options);
										this._notifyTileMapChanged();
									},
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
					onChange={() => this._updateSelectedTile()}
				/>
				<EditorInspectorVectorField
					object={this.state.selectedTile}
					property="repeatCount"
					label="Repeat Count"
					step={1}
					min={0}
					max={[this.props.object.spriteMap!.options.stageSize?.x ?? 0, this.props.object.spriteMap!.options.stageSize?.y ?? 0]}
					onChange={() => this._updateSelectedTile()}
				/>
				<EditorInspectorVectorField
					object={this.state.selectedTile}
					property="repeatOffset"
					label="Repeat Offset"
					step={1}
					min={0}
					max={[this.props.object.spriteMap!.options.stageSize?.x ?? 0, this.props.object.spriteMap!.options.stageSize?.y ?? 0]}
					onChange={() => this._updateSelectedTile()}
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
					onChange={() => this._updateSelectedTile()}
				/>

				{(options.layerCount ?? 1) > 1 && (
					<EditorInspectorNumberField
						object={this.state.selectedTile}
						property="layer"
						label="Layer"
						min={0}
						max={(options.layerCount ?? 1) - 1}
						step={1}
						onChange={() => {
							this.props.object.updateFromOptions(options);
							this._notifyTileMapChanged();
						}}
					/>
				)}
			</>
		);
	}

	private _getTilePaletteInspector(): ReactNode {
		const scene = this.props.object.getScene();
		const palettes = listTilePalettes(scene).palettes.filter((palette: any) => palette.mapNodeId === this.props.object.id) as any[];
		const viewport = getTilePaintViewport(scene);
		const grid = getTileGridConfiguration(scene, { mapNodeId: this.props.object.id }).grid;
		const gridBrushes = listGridBrushTypes().brushes as any[];
		const selectedFrame = (this.state.selectedTile as any)?.ruleSource ?? this.state.selectedTile?.tile ?? 0;
		return (
			<EditorInspectorSectionField
				title="Tile Palettes"
				tooltip="Versioned rectangular, isometric, and hexagonal palettes with map/palette edit targets, fill/picker/selection transforms, and project-script GridBrush extensions."
			>
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded bg-input p-2 text-xs">
						<span>Map layout</span>
						<select
							value={grid.layout}
							aria-label="Tile grid layout"
							onChange={(event) => this._setTileGridLayout(event.currentTarget.value)}
							className="rounded bg-background px-2 py-1"
						>
							<option value="rectangular">Rectangular</option>
							<option value="isometric">Isometric</option>
							<option value="hexagonal-point-top">Hexagonal · point top</option>
							<option value="hexagonal-flat-top">Hexagonal · flat top</option>
						</select>
					</div>
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
								<span className="font-medium">
									{palette.name} · r{palette.revision} · {palette.layout}
								</span>
								<div className="flex gap-1">
									<Button
										size="sm"
										variant={viewport.enabled && viewport.paletteId === palette.id ? "default" : "secondary"}
										className="h-6 px-2"
										onClick={() =>
											viewport.enabled && viewport.paletteId === palette.id
												? this._setTilePaintViewport({ enabled: false })
												: this._setTilePaintViewport({ enabled: true, mapNodeId: this.props.object.id, paletteId: palette.id })
										}
									>
										{viewport.enabled && viewport.paletteId === palette.id ? "Stop Viewport" : "Paint in Viewport"}
									</Button>
									<Button size="sm" variant="ghost" className="h-6 px-1 !text-red-400" onClick={() => this._deleteTilePalette(palette.id, palette.revision)}>
										Remove
									</Button>
								</div>
							</div>
							{viewport.enabled && viewport.paletteId === palette.id && (
								<div className="flex flex-col gap-1 rounded border border-primary/50 bg-background/60 p-2">
									<div className="text-[10px] text-muted-foreground">
										Viewport r{viewport.revision} · map r{viewport.mapRevision} · palette r{viewport.palette.revision}
									</div>
									<div className="flex flex-wrap gap-1">
										{(["paint", "erase", "fill", "pick", "select"] as const).map((mode) => (
											<Button
												key={mode}
												size="sm"
												variant={viewport.mode === mode ? "default" : "secondary"}
												className="h-6 px-2 capitalize"
												onClick={() => this._setTilePaintViewport({ mode })}
											>
												{mode}
											</Button>
										))}
										<Button
											size="sm"
											variant={viewport.target === "map" ? "default" : "secondary"}
											className="h-6 px-2"
											onClick={() => this._setTilePaintViewport({ target: "map" })}
										>
											Map Edit
										</Button>
										<Button
											size="sm"
											variant={viewport.target === "palette" ? "default" : "secondary"}
											className="h-6 px-2"
											onClick={() => this._setTilePaintViewport({ target: "palette" })}
										>
											Palette Edit
										</Button>
									</div>
									<div className="grid grid-cols-3 gap-1">
										<input
											type="number"
											min={0}
											max={(this.props.object.spriteMap?.options.layerCount ?? 1) - 1}
											value={viewport.layer}
											aria-label="Tile Paint viewport layer"
											title="Layer"
											onChange={(event) => this._setTilePaintViewport({ layer: Number(event.currentTarget.value) })}
											className="min-w-0 rounded bg-input px-1 py-1"
										/>
										<input
											type="number"
											min={1}
											max={32}
											value={viewport.brushSize[0]}
											aria-label="Tile Paint brush width"
											title="Brush width"
											onChange={(event) => this._setTilePaintViewport({ brushSize: [Number(event.currentTarget.value), viewport.brushSize[1]] })}
											className="min-w-0 rounded bg-input px-1 py-1"
										/>
										<input
											type="number"
											min={1}
											max={32}
											value={viewport.brushSize[1]}
											aria-label="Tile Paint brush height"
											title="Brush height"
											onChange={(event) => this._setTilePaintViewport({ brushSize: [viewport.brushSize[0], Number(event.currentTarget.value)] })}
											className="min-w-0 rounded bg-input px-1 py-1"
										/>
									</div>
									<div className="text-[10px] text-muted-foreground">
										Left-drag paints/erases; Fill and Pick click once; Select drags a region. Every change is one Undo/Redo transaction.
									</div>
								</div>
							)}
							<div className="flex flex-wrap gap-1">
								{palette.tileIndexes.map((index: number) => (
									<Button
										key={index}
										size="sm"
										variant={palette.activeTileIndex === index ? "default" : "secondary"}
										className="h-6 px-2"
										onClick={() => this._setPaletteTile(palette.id, palette.revision, index)}
									>
										{index}
									</Button>
								))}
								<Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => this._addPaletteTile(palette, selectedFrame)}>
									+ Frame {selectedFrame}
								</Button>
							</div>
							<div className="grid grid-cols-4 gap-1">
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
								<input
									type="number"
									value={this.state.paletteEndPosition.x}
									aria-label="Tile selection end x"
									onChange={(event) => this.setState({ paletteEndPosition: { ...this.state.paletteEndPosition, x: Number(event.currentTarget.value) } })}
									className="rounded bg-background px-2 py-1"
								/>
								<input
									type="number"
									value={this.state.paletteEndPosition.y}
									aria-label="Tile selection end y"
									onChange={(event) => this.setState({ paletteEndPosition: { ...this.state.paletteEndPosition, y: Number(event.currentTarget.value) } })}
									className="rounded bg-background px-2 py-1"
								/>
							</div>
							<div className="flex flex-wrap gap-1">
								{(["paint", "erase", "fill", "pick", "select", "custom"] as const).map((operation) => (
									<Button
										key={operation}
										size="sm"
										className="h-6 px-2 capitalize"
										variant="secondary"
										disabled={!viewport.enabled || viewport.paletteId !== palette.id}
										onClick={() => this._applyPaletteOperation(palette, operation)}
									>
										{operation}
									</Button>
								))}
								{(["rotate", "flip-x", "flip-y", "move"] as const).map((operation) => (
									<Button
										key={operation}
										size="sm"
										className="h-6 px-2 capitalize"
										variant="ghost"
										disabled={!viewport.selection || viewport.paletteId !== palette.id}
										onClick={() => this._applyPaletteOperation(palette, operation)}
									>
										{operation}
									</Button>
								))}
							</div>
							<div className="grid grid-cols-4 gap-1">
								<select
									value={palette.layout}
									aria-label="Tile Palette layout"
									onChange={(event) => this._setPaletteLayout(palette, event.currentTarget.value)}
									className="rounded bg-background px-2 py-1"
								>
									<option value="rectangular">Rectangular</option>
									<option value="isometric">Isometric</option>
									<option value="hexagonal-point-top">Hex point</option>
									<option value="hexagonal-flat-top">Hex flat</option>
								</select>
								<select
									value={palette.brush.type}
									aria-label="GridBrush type"
									onChange={(event) => this._setPaletteBrush(palette, event.currentTarget.value)}
									className="rounded bg-background px-2 py-1"
								>
									{gridBrushes.map((brush) => (
										<option key={brush.id} value={brush.id}>
											{brush.displayName}
										</option>
									))}
									{!gridBrushes.some((brush) => brush.id === palette.brush.type) && <option value={palette.brush.type}>{palette.brush.type} (not loaded)</option>}
								</select>
								<input
									value={this.state.gridBrushData}
									aria-label="GridBrush JSON data"
									onChange={(event) => this.setState({ gridBrushData: event.currentTarget.value })}
									className="rounded bg-background px-2 py-1"
								/>
								<div className="rounded bg-background px-2 py-1 text-[10px] text-muted-foreground">{palette.cells.length} palette cells</div>
							</div>
							<div className="grid grid-cols-[auto_1fr_1fr] items-center gap-1">
								<span className="text-[10px] text-muted-foreground">Move offset</span>
								<input
									type="number"
									value={this.state.paletteMoveOffset.x}
									aria-label="Tile selection move x"
									onChange={(event) => this.setState({ paletteMoveOffset: { ...this.state.paletteMoveOffset, x: Number(event.currentTarget.value) } })}
									className="rounded bg-background px-2 py-1"
								/>
								<input
									type="number"
									value={this.state.paletteMoveOffset.y}
									aria-label="Tile selection move y"
									onChange={(event) => this.setState({ paletteMoveOffset: { ...this.state.paletteMoveOffset, y: Number(event.currentTarget.value) } })}
									className="rounded bg-background px-2 py-1"
								/>
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

	private _setTileGridLayout(layout: string): void {
		const scene = this.props.object.getScene();
		const current = getTileGridConfiguration(scene, { mapNodeId: this.props.object.id }).grid;
		setTileGridConfiguration(scene, { mapNodeId: this.props.object.id, expectedRevision: current.revision, layout }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _setPaletteTile(paletteId: string, expectedRevision: number, activeTileIndex: number): void {
		setTilePalette(this.props.object.getScene(), { paletteId, expectedRevision, activeTileIndex }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _addPaletteTile(palette: any, tileIndex: number): void {
		setTilePalette(
			this.props.object.getScene(),
			{ paletteId: palette.id, expectedRevision: palette.revision, tileIndexes: [...new Set([...palette.tileIndexes, tileIndex])] },
			{ editor: this.props.editor }
		);
		this.forceUpdate();
	}

	private _setTilePaintViewport(data: Record<string, unknown>): void {
		try {
			const current = getTilePaintViewport(this.props.object.getScene());
			setTilePaintViewport(this.props.object.getScene(), { expectedRevision: current.revision, ...data }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	private _setPaletteBrush(palette: any, type: string): void {
		try {
			const definition = (listGridBrushTypes().brushes as any[]).find((candidate) => candidate.id === type);
			setTilePalette(
				this.props.object.getScene(),
				{ paletteId: palette.id, expectedRevision: palette.revision, brush: { type, dataVersion: definition?.dataVersion ?? 1, data: definition?.defaultData ?? {} } },
				{ editor: this.props.editor }
			);
			this.setState({ gridBrushData: JSON.stringify(definition?.defaultData ?? {}) });
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	private _setPaletteLayout(palette: any, layout: string): void {
		setTilePalette(this.props.object.getScene(), { paletteId: palette.id, expectedRevision: palette.revision, layout }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _applyPaletteOperation(palette: any, operation: "paint" | "erase" | "fill" | "pick" | "select" | "custom" | "rotate" | "flip-x" | "flip-y" | "move"): void {
		const scene = this.props.object.getScene();
		const current = getTilePaintViewport(scene);
		if (!current.enabled || current.paletteId !== palette.id) {
			return;
		}
		const before = getTilePaintViewportSnapshot(scene, { mapNodeId: this.props.object.id });
		try {
			applyTilePaletteOperation(
				scene,
				{
					expectedRevision: current.revision,
					expectedMapRevision: current.mapRevision,
					expectedPaletteRevision: current.palette.revision,
					operation,
					position: [this.state.palettePosition.x, this.state.palettePosition.y],
					endPosition: operation === "select" ? [this.state.paletteEndPosition.x, this.state.paletteEndPosition.y] : undefined,
					offset: operation === "move" ? [this.state.paletteMoveOffset.x, this.state.paletteMoveOffset.y] : undefined,
					brushType: operation === "custom" ? palette.brush.type : undefined,
					brushData: operation === "custom" ? JSON.parse(this.state.gridBrushData || "{}") : undefined,
				},
				{ editor: this.props.editor }
			);
			const after = getTilePaintViewportSnapshot(scene, { mapNodeId: this.props.object.id });
			if (JSON.stringify(before) !== JSON.stringify(after)) {
				registerUndoRedo({
					undo: () => restoreTilePaintViewportSnapshot(scene, before, { editor: this.props.editor }),
					redo: () => restoreTilePaintViewportSnapshot(scene, after, { editor: this.props.editor }),
				});
			}
			this.forceUpdate();
		} catch (error) {
			console.error(error);
		}
	}

	private _deleteTilePalette(paletteId: string, expectedRevision: number): void {
		deleteTilePalette(this.props.object.getScene(), { paletteId, expectedRevision }, { editor: this.props.editor });
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
		const materials = this.props.object.getScene().metadata?.babylonEditorPhysics2DMaterials ?? [];
		const frameType = selectedFrame === undefined ? "grid" : (generator?.tileColliderTypes?.[String(selectedFrame)] ?? "grid");
		const selectedShape = selectedFrame === undefined ? undefined : generator?.spriteShapes?.[String(selectedFrame)];
		return (
			<EditorInspectorSectionField
				title="Tilemap Collider 2D"
				tooltip="Unity-style Tilemap Collider 2D authoring with per-frame Grid/Sprite/None shapes, composite geometry, manual or synchronous generation, material, trigger, effector, and Layer Override controls."
			>
				<div className="flex flex-col gap-2 text-xs">
					{!generator ? (
						<div className="flex flex-col gap-2">
							<div className="text-muted-foreground">No Tilemap Collider 2D configuration.</div>
							<div className="flex flex-wrap gap-2">
								<Button size="sm" onClick={() => this._generateTileColliders(undefined, "merge")}>
									Create Composite
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._generateTileColliders(undefined, "none")}>
									Create Per Cell
								</Button>
								<Button size="sm" variant="secondary" disabled={selectedFrame === undefined} onClick={() => this._generateTileColliders(selectedFrame, "merge")}>
									Create Frame {selectedFrame ?? ""}
								</Button>
							</div>
						</div>
					) : (
						<>
							<div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded bg-input p-2">
								<span>Configuration revision</span>
								<span>{generator.revision}</span>
								<span>Geometry / map revision</span>
								<span>
									{generator.geometryRevision} / {generator.mapRevision}
								</span>
								<span>Generated colliders</span>
								<span>{generator.nodeIds.length}</span>
								<span>Pending tile changes</span>
								<span className={generator.hasTilemapChanges ? "text-yellow-400" : "text-emerald-400"}>{generator.pendingChangeCount}</span>
								<span>Last generation</span>
								<span>
									{generator.lastBuild.mode} · {generator.lastBuild.reusedColliderCount} reused / {generator.lastBuild.createdColliderCount} created
								</span>
								<span>Geometry evidence</span>
								<span>
									{generator.lastBuild.evidence.boxCount} box · {generator.lastBuild.evidence.polygonCount} polygon · {generator.lastBuild.evidence.edgeCount}{" "}
									edge
								</span>
								<span>Triangulation</span>
								<span>
									{generator.lastBuild.evidence.triangulation} · {generator.lastBuild.evidence.delaunayFlipCount ?? 0} flips
								</span>
							</div>

							<div className="grid grid-cols-2 gap-2">
								{this._tileColliderSelect("Composite Operation", generator.compositeOperation, ["none", "merge", "intersect", "difference", "flip"], (value) =>
									this._updateTileCollider({ compositeOperation: value })
								)}
								{this._tileColliderSelect("Geometry Type", generator.geometryType, ["polygons", "outlines"], (value) =>
									this._updateTileCollider({ geometryType: value })
								)}
								{this._tileColliderSelect("Generation Type", generator.generationType, ["synchronous", "manual"], (value) =>
									this._updateTileCollider({ generationType: value })
								)}
								{this._tileColliderBoolean("Use Delaunay Mesh", generator.useDelaunayMesh, (value) => this._updateTileCollider({ useDelaunayMesh: value }))}
							</div>

							<div className="grid grid-cols-2 gap-2">
								{this._tileColliderNumber("Max Tile Changes", generator.maxTileChangeCount, (value) => this._updateTileCollider({ maxTileChangeCount: value }), 1)}
								{this._tileColliderNumber("Extrusion Factor", generator.extrusionFactor, (value) => this._updateTileCollider({ extrusionFactor: value }), 0)}
								{this._tileColliderNumber("Vertex Distance", generator.vertexDistance, (value) => this._updateTileCollider({ vertexDistance: value }), 0.000001)}
								{this._tileColliderNumber("Offset Distance", generator.offsetDistance, (value) => this._updateTileCollider({ offsetDistance: value }), 0)}
								{this._tileColliderNumber("Offset X", generator.offset[0], (value) => this._updateTileCollider({ offset: [value, generator.offset[1]] }))}
								{this._tileColliderNumber("Offset Y", generator.offset[1], (value) => this._updateTileCollider({ offset: [generator.offset[0], value] }))}
								{this._tileColliderNumber("Edge Radius", generator.edgeRadius, (value) => this._updateTileCollider({ edgeRadius: value }), 0.001)}
								{this._tileColliderNumber("Collision Layer", generator.collisionLayer, (value) => this._updateTileCollider({ collisionLayer: value }), 0, 31)}
							</div>

							<div className="grid grid-cols-2 gap-2">
								<label className="flex flex-col gap-1">
									Physics Material
									<select
										value={generator.materialId ?? ""}
										onChange={(event) => this._updateTileCollider({ materialId: event.currentTarget.value || null })}
										className="rounded bg-input px-2 py-1"
									>
										<option value="">None</option>
										{materials.map((material: any) => (
											<option key={material.id} value={material.id}>
												{material.name}
											</option>
										))}
									</select>
								</label>
								<div className="grid grid-cols-2 gap-2">
									{this._tileColliderBoolean("Is Trigger", generator.isTrigger, (value) => this._updateTileCollider({ isTrigger: value }))}
									{this._tileColliderBoolean("Used By Effector", generator.usedByEffector, (value) => this._updateTileCollider({ usedByEffector: value }))}
								</div>
								{this._tileColliderNumber("Friction", generator.friction, (value) => this._updateTileCollider({ friction: value }), 0, 1)}
								{this._tileColliderNumber("Bounciness", generator.restitution, (value) => this._updateTileCollider({ restitution: value }), 0, 1)}
							</div>

							<div className="rounded border border-border p-2">
								<div className="mb-2 font-medium">Layer Overrides (32-bit masks)</div>
								<div className="grid grid-cols-2 gap-2">
									{this._tileColliderNumber(
										"Priority",
										generator.layerOverrides.priority,
										(value) => this._updateTileCollider({ layerOverrides: { ...generator.layerOverrides, priority: value } }),
										-128,
										127
									)}
									{["includeLayers", "excludeLayers", "forceSendLayers", "forceReceiveLayers", "contactCaptureLayers", "callbackLayers"].map((property) =>
										this._tileColliderNumber(
											property.replace(/([A-Z])/g, " $1"),
											generator.layerOverrides[property],
											(value) => this._updateTileCollider({ layerOverrides: { ...generator.layerOverrides, [property]: value } }),
											0,
											0xffffffff
										)
									)}
								</div>
							</div>

							<div className="rounded border border-border p-2">
								<div className="mb-2 font-medium">Selected Atlas Frame {selectedFrame ?? "—"}</div>
								<select
									disabled={selectedFrame === undefined}
									value={frameType}
									onChange={(event) => this._setTileColliderFrameType(selectedFrame!, event.currentTarget.value as TilemapColliderType)}
									className="w-full rounded bg-input px-2 py-1"
								>
									<option value="none">None</option>
									<option value="grid">Grid</option>
									<option value="sprite">Sprite Physics Shape</option>
								</select>
								{selectedFrame !== undefined && frameType === "sprite" && (
									<label className="mt-2 flex flex-col gap-1">
										Normalized compound contours JSON
										<textarea
											key={`${generator.revision}:${selectedFrame}`}
											defaultValue={JSON.stringify(selectedShape ?? this._defaultTileColliderSpriteShape(), null, 2)}
											onBlur={(event) => this._setTileColliderSpriteShape(selectedFrame, event.currentTarget.value)}
											className="h-40 rounded bg-input p-2 font-mono text-[10px]"
										/>
									</label>
								)}
							</div>

							<div className="flex flex-wrap gap-2">
								<Button size="sm" onClick={() => this._refreshTileColliders(false)}>
									Generate Geometry
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._refreshTileColliders(true)}>
									Force Full Rebuild
								</Button>
								<Button
									size="sm"
									variant="secondary"
									onClick={() => this._updateTileCollider({ tileIndexes: selectedFrame === undefined ? undefined : [selectedFrame] })}
									disabled={selectedFrame === undefined}
								>
									Filter Frame {selectedFrame ?? ""}
								</Button>
								<Button size="sm" variant="secondary" onClick={() => this._updateTileCollider({ tileIndexes: undefined, layer: undefined })}>
									All Tiles/Layers
								</Button>
								<Button size="sm" variant="ghost" className="!text-red-400" onClick={() => this._clearTileColliders()}>
									Clear
								</Button>
							</div>
						</>
					)}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _tileColliderSelect(label: string, value: string, values: string[], onChange: (value: string) => void): ReactNode {
		return (
			<label className="flex flex-col gap-1">
				{label}
				<select value={value} onChange={(event) => onChange(event.currentTarget.value)} className="rounded bg-input px-2 py-1">
					{values.map((candidate) => (
						<option key={candidate} value={candidate}>
							{candidate}
						</option>
					))}
				</select>
			</label>
		);
	}

	private _tileColliderBoolean(label: string, value: boolean, onChange: (value: boolean) => void): ReactNode {
		return (
			<label className="flex items-center justify-between gap-2 rounded bg-input px-2 py-1">
				<span>{label}</span>
				<input type="checkbox" checked={value} onChange={(event) => onChange(event.currentTarget.checked)} />
			</label>
		);
	}

	private _tileColliderNumber(label: string, value: number, onCommit: (value: number) => void, minimum?: number, maximum?: number): ReactNode {
		return (
			<label className="flex flex-col gap-1 capitalize">
				{label}
				<input
					key={`${label}:${value}`}
					type="number"
					defaultValue={value}
					min={minimum}
					max={maximum}
					onBlur={(event) => onCommit(Number(event.currentTarget.value))}
					onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
					className="rounded bg-input px-2 py-1"
				/>
			</label>
		);
	}

	private _defaultTileColliderSpriteShape(): IPhysics2DPolygonContour[] {
		return [
			{
				id: "outer",
				points: [
					[-0.5, -0.5],
					[0.5, -0.5],
					[0.5, 0.5],
					[-0.5, 0.5],
				],
				holes: [],
			},
		];
	}

	private _generateTileColliders(tileIndex: number | undefined, compositeOperation: ITilemapColliderSettings["compositeOperation"]): void {
		const scene = this.props.object.getScene();
		const options = { editor: this.props.editor };
		try {
			const before = getTileColliderGeneratorSnapshot(scene, { mapNodeId: this.props.object.id });
			const existing = getTileColliderGenerator(scene, { mapNodeId: this.props.object.id }).generator as any;
			generateTileColliders(
				scene,
				{ mapNodeId: this.props.object.id, expectedRevision: existing?.revision, compositeOperation, ...(tileIndex === undefined ? {} : { tileIndexes: [tileIndex] }) },
				options
			);
			const after = getTileColliderGeneratorSnapshot(scene, { mapNodeId: this.props.object.id });
			registerUndoRedo({ undo: () => restoreTileColliderGeneratorSnapshot(scene, before, options), redo: () => restoreTileColliderGeneratorSnapshot(scene, after, options) });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create Tilemap Collider 2D geometry.");
		}
	}

	private _updateTileCollider(update: Record<string, unknown>): void {
		const scene = this.props.object.getScene();
		const options = { editor: this.props.editor };
		try {
			const before = getTileColliderGeneratorSnapshot(scene, { mapNodeId: this.props.object.id });
			if (!before.generator) {
				throw new Error("Create a Tilemap Collider 2D configuration first.");
			}
			setTileColliderGenerator(scene, { mapNodeId: this.props.object.id, expectedRevision: before.generator.revision, update }, options);
			const after = getTileColliderGeneratorSnapshot(scene, { mapNodeId: this.props.object.id });
			registerUndoRedo({ undo: () => restoreTileColliderGeneratorSnapshot(scene, before, options), redo: () => restoreTileColliderGeneratorSnapshot(scene, after, options) });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update Tilemap Collider 2D settings.");
			this.forceUpdate();
		}
	}

	private _setTileColliderFrameType(tileIndex: number, type: TilemapColliderType): void {
		const generator = getTileColliderGenerator(this.props.object.getScene(), { mapNodeId: this.props.object.id }).generator as any;
		const tileColliderTypes = { ...generator.tileColliderTypes, [tileIndex]: type };
		const spriteShapes =
			type === "sprite" && !generator.spriteShapes[String(tileIndex)]
				? { ...generator.spriteShapes, [tileIndex]: this._defaultTileColliderSpriteShape() }
				: generator.spriteShapes;
		this._updateTileCollider({ tileColliderTypes, spriteShapes });
	}

	private _setTileColliderSpriteShape(tileIndex: number, value: string): void {
		try {
			const contours = JSON.parse(value) as IPhysics2DPolygonContour[];
			const generator = getTileColliderGenerator(this.props.object.getScene(), { mapNodeId: this.props.object.id }).generator as any;
			this._updateTileCollider({ spriteShapes: { ...generator.spriteShapes, [tileIndex]: contours } });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Sprite Physics Shape JSON is invalid.");
		}
	}

	private _clearTileColliders(): void {
		const scene = this.props.object.getScene();
		const options = { editor: this.props.editor };
		try {
			const before = getTileColliderGeneratorSnapshot(scene, { mapNodeId: this.props.object.id });
			if (!before.generator) {
				return;
			}
			clearTileColliderGenerator(scene, { mapNodeId: this.props.object.id, expectedRevision: before.generator.revision }, options);
			const after = getTileColliderGeneratorSnapshot(scene, { mapNodeId: this.props.object.id });
			registerUndoRedo({ undo: () => restoreTileColliderGeneratorSnapshot(scene, before, options), redo: () => restoreTileColliderGeneratorSnapshot(scene, after, options) });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not clear Tilemap Collider 2D geometry.");
		}
	}

	private _refreshTileColliders(forceFull: boolean): void {
		try {
			const generator = getTileColliderGenerator(this.props.object.getScene(), { mapNodeId: this.props.object.id }).generator as any;
			refreshTileColliders(this.props.object.getScene(), { mapNodeId: this.props.object.id, expectedRevision: generator.revision, forceFull }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not generate Tilemap Collider 2D geometry.");
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
		if (!tile) {
			return;
		}
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

	private _updateSelectedTile(): void {
		if (!this.state.selectedTile) {
			return;
		}
		this.props.object.updateTile(this.state.selectedTile);
		this._notifyTileMapChanged();
	}

	private _notifyTileMapChanged(): void {
		try {
			notifySpriteMapTileDataChanged(this.props.object.getScene(), { mapNodeId: this.props.object.id }, { editor: this.props.editor });
			this._tileDataFingerprint = this._getTileDataFingerprint();
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not synchronize Tilemap Collider 2D geometry.");
		}
	}

	private _getTileDataFingerprint(): string {
		const options = this.props.object.spriteMap?.options;
		return JSON.stringify({
			atlas: this.props.object.atlasJsonRelativePath,
			tiles: this.props.object.tiles,
			layerCount: options?.layerCount,
			stageSize: options?.stageSize ? [options.stageSize.x, options.stageSize.y] : null,
			outputSize: options?.outputSize ? [options.outputSize.x, options.outputSize.y] : null,
			colorMultiply: options?.colorMultiply ? [options.colorMultiply.x, options.colorMultiply.y, options.colorMultiply.z] : null,
		});
	}

	private _captureOptions(): any {
		const options = this.props.object.spriteMap?.options;
		return options
			? {
					layerCount: options.layerCount,
					stageSize: options.stageSize?.clone(),
					outputSize: options.outputSize?.clone(),
					colorMultiply: options.colorMultiply?.clone(),
				}
			: null;
	}

	private _handleOptionsUndoRedo(): void {
		const options = this.props.object.spriteMap?.options;
		if (!options) {
			return;
		}

		const oldOptions = this._committedOptions ?? this._captureOptions();
		const newOptions = this._captureOptions();
		if (JSON.stringify(oldOptions) === JSON.stringify(newOptions)) {
			return;
		}

		registerUndoRedo({
			undo: () => this.props.object.updateFromOptions(oldOptions),
			redo: () => this.props.object.updateFromOptions(newOptions),
		});
		this._committedOptions = newOptions;

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
			action: () => {
				this.props.object.updateFromOptions(this.props.object.spriteMap!.options);
				this._notifyTileMapChanged();
			},
		});

		this.setState({
			selectedTile: newTile,
		});
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
			action: () => {
				this.props.object.updateFromOptions(this.props.object.spriteMap!.options);
				this._notifyTileMapChanged();
			},
		});

		this.setState({
			selectedTile: tiles[0] ?? null,
		});
	}
}
