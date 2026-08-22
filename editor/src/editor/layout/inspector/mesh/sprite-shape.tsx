import { Component, ReactNode } from "react";

import { toast } from "sonner";
import { AiOutlineMinus, AiOutlinePlus } from "react-icons/ai";

import { Mesh, Tools } from "babylonjs";
import { ISpriteShapeAngleRange, ISpriteShapeDefinition, ISpriteShapeProfile } from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { registerUndoRedo } from "../../../../tools/undoredo";
import {
	createSpriteShapeProfile,
	deleteSpriteShapeProfile,
	getSpriteShape,
	getSpriteShapeProfile,
	getSpriteShapeProfileSnapshot,
	getSpriteShapeSnapshot,
	listSpriteShapeProfiles,
	restoreSpriteShapeProfileSnapshot,
	restoreSpriteShapeSnapshot,
	setSpriteShape,
	setSpriteShapeProfile,
} from "../../../../mcp/sprites/sprite-shapes";

import { EditorInspectorListField } from "../fields/list";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSectionField } from "../fields/section";
import { EditorInspectorSwitchField } from "../fields/switch";
import { IEditorInspectorImplementationProps } from "../inspector";

interface ISpriteShapeInspectorState {
	definition: ISpriteShapeDefinition;
	profile: ISpriteShapeProfile;
	profiles: Array<{ id: string; name: string; revision: number; shapeCount: number }>;
	generated: Record<string, unknown> | null;
}

interface ISpriteShapeReadback {
	definition: ISpriteShapeDefinition;
	profile: ISpriteShapeProfile;
	generated: Record<string, unknown> | null;
}

function colorToHex(color: [number, number, number, number]): string {
	return `#${color
		.slice(0, 3)
		.map((value) =>
			Math.round(value * 255)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

function hexToColor(value: string, alpha: number): [number, number, number, number] {
	return [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255, alpha];
}

export class SpriteShapeInspector extends Component<IEditorInspectorImplementationProps<Mesh>, ISpriteShapeInspectorState> {
	public constructor(props: IEditorInspectorImplementationProps<Mesh>) {
		super(props);
		this.state = this._readState();
	}

	public componentDidUpdate(previous: IEditorInspectorImplementationProps<Mesh>): void {
		if (previous.object !== this.props.object) {
			this.setState(this._readState());
		}
	}

	public render(): ReactNode {
		const { definition, profile, generated } = this.state;
		return (
			<>
				<EditorInspectorSectionField title="Sprite Shape Controller" tooltip="Unity-style editable 2D spline geometry. Yellow scene handles move control points directly.">
					<EditorInspectorListField
						label="Profile"
						object={definition}
						property="profileId"
						items={this.state.profiles.map((entry) => ({ key: entry.id, text: `${entry.name} (r${entry.revision})`, value: entry.id }))}
						noUndoRedo
						onChange={(profileId) => this._updateDefinition({ profileId })}
					/>
					<EditorInspectorSwitchField
						label="Closed"
						object={definition}
						property="closed"
						noUndoRedo
						onChange={(closed) => this._updateDefinition({ closed, ...(!closed ? { collider: { ...definition.collider, type: "edge" } } : {}) })}
					/>
					<EditorInspectorNumberField
						label="Spline Detail"
						object={definition}
						property="detail"
						min={1}
						max={32}
						step={1}
						noUndoRedo
						onFinishChange={() => this._updateDefinition({ detail: definition.detail })}
					/>
					<EditorInspectorNumberField
						label="Fill Offset"
						object={definition}
						property="fillOffset"
						step={1}
						noUndoRedo
						onFinishChange={() => this._updateDefinition({ fillOffset: definition.fillOffset })}
					/>
					<EditorInspectorSwitchField
						label="Adaptive UV"
						object={definition}
						property="adaptiveUV"
						noUndoRedo
						onChange={(adaptiveUV) => this._updateDefinition({ adaptiveUV })}
					/>
					<EditorInspectorSwitchField
						label="Stretch UV"
						object={definition}
						property="stretchUV"
						noUndoRedo
						onChange={(stretchUV) => this._updateDefinition({ stretchUV })}
					/>
					<EditorInspectorSwitchField
						label="World-space UV"
						object={definition}
						property="worldSpaceUV"
						noUndoRedo
						onChange={(worldSpaceUV) => this._updateDefinition({ worldSpaceUV })}
					/>
					<EditorInspectorSwitchField
						label="Optimize Geometry"
						object={definition}
						property="geometryOptimization"
						noUndoRedo
						onChange={(geometryOptimization) => this._updateDefinition({ geometryOptimization })}
					/>
					<EditorInspectorSwitchField
						label="Generate Tangents"
						object={definition}
						property="enableTangents"
						noUndoRedo
						onChange={(enableTangents) => this._updateDefinition({ enableTangents })}
					/>
					<div className="grid grid-cols-2 gap-1 px-2 py-2 text-xs text-muted-foreground">
						<div>Revision</div>
						<div>{definition.revision}</div>
						<div>Vertices / indices</div>
						<div>
							{String(generated?.vertexCount ?? 0)} / {String(generated?.indexCount ?? 0)}
						</div>
						<div>Edge quads / fill triangles</div>
						<div>
							{String(generated?.edgeQuadCount ?? 0)} / {String(generated?.fillTriangleCount ?? 0)}
						</div>
						<div>Generated collider parts</div>
						<div>{String(generated?.colliderPartCount ?? 0)}</div>
					</div>
				</EditorInspectorSectionField>

				{this._renderControlPoints()}
				{this._renderCollider()}
				{this._renderProfile(profile)}
				{this._renderProfileLibrary()}
			</>
		);
	}

	private _readState(): ISpriteShapeInspectorState {
		const scene = this.props.object.getScene();
		const readback = getSpriteShape(scene, { nodeId: this.props.object.id }) as unknown as ISpriteShapeReadback;
		const profiles = (listSpriteShapeProfiles(scene) as { profiles: { items: ISpriteShapeInspectorState["profiles"] } }).profiles.items;
		return { definition: readback.definition, profile: readback.profile, generated: readback.generated, profiles };
	}

	private _reload(): void {
		this.setState(this._readState());
	}

	private _updateDefinition(update: Partial<ISpriteShapeDefinition>): void {
		const scene = this.props.object.getScene();
		const options = { editor: this.props.editor };
		try {
			const before = getSpriteShapeSnapshot(this.props.object);
			const readback = setSpriteShape(
				scene,
				{ nodeId: this.props.object.id, expectedRevision: before.definition.revision, update },
				options
			) as unknown as ISpriteShapeReadback;
			const after = getSpriteShapeSnapshot(this.props.object);
			registerUndoRedo({
				undo: () => {
					restoreSpriteShapeSnapshot(scene, before, options);
				},
				redo: () => {
					restoreSpriteShapeSnapshot(scene, after, options);
				},
			});
			this.setState({ ...this.state, definition: readback.definition, profile: readback.profile, generated: readback.generated });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update the Sprite Shape.");
			this._reload();
		}
	}

	private _updateProfile(update: Partial<ISpriteShapeProfile>): void {
		const scene = this.props.object.getScene();
		const options = { editor: this.props.editor };
		try {
			const before = getSpriteShapeProfileSnapshot(scene, { profileId: this.state.profile.id });
			const profile = setSpriteShapeProfile(scene, { profileId: before.profile.id, expectedRevision: before.profile.revision, update }, options);
			const after = getSpriteShapeProfileSnapshot(scene, { profileId: profile.id });
			registerUndoRedo({
				undo: () => {
					restoreSpriteShapeProfileSnapshot(scene, before, options);
				},
				redo: () => {
					restoreSpriteShapeProfileSnapshot(scene, after, options);
				},
			});
			this._reload();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update the Sprite Shape profile.");
			this._reload();
		}
	}

	private _renderControlPoints(): ReactNode {
		const definition = this.state.definition;
		return (
			<EditorInspectorSectionField
				title={`Spline Control Points (${definition.points.length})`}
				tooltip="Drag yellow handles in the Scene view or edit exact local coordinates and Bezier tangents here."
			>
				<div className="flex flex-col gap-2 px-2 pb-2">
					{definition.points.map((point, index) => (
						<div key={point.id} className="rounded border border-border p-2">
							<div className="mb-1 flex items-center justify-between text-xs font-medium">
								<span>
									Point {index + 1} · {point.id}
								</span>
								<div className="flex gap-1">
									<Button
										variant="secondary"
										size="icon"
										className="h-7 w-7"
										onClick={() => this._insertControlPoint(index)}
										title="Insert control point after this point"
									>
										<AiOutlinePlus />
									</Button>
									<Button
										variant="secondary"
										size="icon"
										className="h-7 w-7"
										disabled={definition.points.length <= (definition.closed ? 3 : 2)}
										onClick={() => this._removeControlPoint(index)}
										title="Remove control point"
									>
										<AiOutlineMinus />
									</Button>
								</div>
							</div>
							<div className="grid grid-cols-2 gap-1">
								{this._numberInput("X", point.position[0], (value) => this._setPoint(index, { position: [value, point.position[1]] }))}
								{this._numberInput("Y", point.position[1], (value) => this._setPoint(index, { position: [point.position[0], value] }))}
								{this._numberInput("Left X", point.leftTangent[0], (value) => this._setPoint(index, { leftTangent: [value, point.leftTangent[1]] }))}
								{this._numberInput("Left Y", point.leftTangent[1], (value) => this._setPoint(index, { leftTangent: [point.leftTangent[0], value] }))}
								{this._numberInput("Right X", point.rightTangent[0], (value) => this._setPoint(index, { rightTangent: [value, point.rightTangent[1]] }))}
								{this._numberInput("Right Y", point.rightTangent[1], (value) => this._setPoint(index, { rightTangent: [point.rightTangent[0], value] }))}
								{this._numberInput("Height", point.height, (value) => this._setPoint(index, { height: value }), 0.001)}
								<select
									value={point.tangentMode}
									onChange={(event) => this._setPoint(index, { tangentMode: event.currentTarget.value as typeof point.tangentMode })}
									className="h-9 rounded border border-input bg-background px-2 text-xs"
								>
									<option value="linear">Linear</option>
									<option value="continuous">Continuous</option>
									<option value="broken">Broken</option>
								</select>
							</div>
							<label className="mt-2 flex items-center gap-2 text-xs">
								<input type="checkbox" checked={point.corner} onChange={(event) => this._setPoint(index, { corner: event.currentTarget.checked })} /> Corner
							</label>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _renderCollider(): ReactNode {
		const definition = this.state.definition;
		const collider = definition.collider;
		return (
			<EditorInspectorSectionField title="Generated 2D Collider">
				<EditorInspectorSwitchField
					label="Enabled"
					object={collider}
					property="enabled"
					noUndoRedo
					onChange={(enabled) => this._updateDefinition({ collider: { ...collider, enabled } })}
				/>
				<EditorInspectorListField
					label="Shape"
					object={collider}
					property="type"
					items={(definition.closed ? ["polygon", "edge"] : ["edge"]).map((value) => ({ text: value === "polygon" ? "Polygon" : "Edge", value }))}
					noUndoRedo
					onChange={(type) => this._updateDefinition({ collider: { ...collider, type } })}
				/>
				<EditorInspectorNumberField
					label="Detail"
					object={collider}
					property="detail"
					min={1}
					max={8}
					step={1}
					noUndoRedo
					onFinishChange={() => this._updateDefinition({ collider })}
				/>
				<EditorInspectorNumberField label="Offset" object={collider} property="offset" step={1} noUndoRedo onFinishChange={() => this._updateDefinition({ collider })} />
				{collider.type === "edge" && (
					<EditorInspectorNumberField
						label="Edge Radius"
						object={collider}
						property="edgeRadius"
						min={0.001}
						step={1}
						noUndoRedo
						onFinishChange={() => this._updateDefinition({ collider })}
					/>
				)}
				<EditorInspectorSwitchField
					label="Optimize"
					object={collider}
					property="optimize"
					noUndoRedo
					onChange={(optimize) => this._updateDefinition({ collider: { ...collider, optimize } })}
				/>
				<EditorInspectorSwitchField
					label="Is Trigger"
					object={collider}
					property="isTrigger"
					noUndoRedo
					onChange={(isTrigger) => this._updateDefinition({ collider: { ...collider, isTrigger } })}
				/>
				<EditorInspectorNumberField
					label="Friction"
					object={collider}
					property="friction"
					min={0}
					max={1}
					step={0.01}
					noUndoRedo
					onFinishChange={() => this._updateDefinition({ collider })}
				/>
				<EditorInspectorNumberField
					label="Restitution"
					object={collider}
					property="restitution"
					min={0}
					max={1}
					step={0.01}
					noUndoRedo
					onFinishChange={() => this._updateDefinition({ collider })}
				/>
			</EditorInspectorSectionField>
		);
	}

	private _renderProfile(profile: ISpriteShapeProfile): ReactNode {
		return (
			<EditorInspectorSectionField
				title={`Sprite Shape Profile · r${profile.revision}`}
				tooltip="This reusable profile is shared; edits rebuild every Sprite Shape that references it."
			>
				{this._textInput("Name", profile.name, (name) => this._updateProfile({ name }))}
				{this._textInput("Edge Texture", profile.edgeTexturePath ?? "", (value) => this._updateProfile({ edgeTexturePath: value || null }))}
				{this._textInput("Fill Texture", profile.fillTexturePath ?? "", (value) => this._updateProfile({ fillTexturePath: value || null }))}
				<div className="grid grid-cols-2 gap-2 px-2 py-1 text-xs">
					<label className="flex items-center justify-between gap-2">
						Edge Color{" "}
						<input
							type="color"
							defaultValue={colorToHex(profile.edgeColor)}
							onBlur={(event) => this._updateProfile({ edgeColor: hexToColor(event.currentTarget.value, profile.edgeColor[3]) })}
						/>
					</label>
					<label className="flex items-center justify-between gap-2">
						Fill Color{" "}
						<input
							type="color"
							defaultValue={colorToHex(profile.fillColor)}
							onBlur={(event) => this._updateProfile({ fillColor: hexToColor(event.currentTarget.value, profile.fillColor[3]) })}
						/>
					</label>
				</div>
				<EditorInspectorNumberField
					label="Pixels Per Unit"
					object={profile}
					property="pixelsPerUnit"
					min={0.001}
					step={1}
					noUndoRedo
					onFinishChange={() => this._updateProfile({ pixelsPerUnit: profile.pixelsPerUnit })}
				/>
				<EditorInspectorSwitchField
					label="Use Sprite Borders"
					object={profile}
					property="useSpriteBorders"
					noUndoRedo
					onChange={(useSpriteBorders) => this._updateProfile({ useSpriteBorders })}
				/>
				<div className="flex items-center justify-between px-2 py-2 text-xs font-medium">
					<span>Angle Ranges ({profile.angleRanges.length})</span>
					<Button variant="secondary" size="sm" onClick={() => this._addAngleRange()} disabled={profile.angleRanges.length >= 16}>
						<AiOutlinePlus className="mr-1" /> Add Range
					</Button>
				</div>
				<div className="flex flex-col gap-2 px-2 pb-2">{profile.angleRanges.map((range, index) => this._renderAngleRange(range, index))}</div>
			</EditorInspectorSectionField>
		);
	}

	private _renderAngleRange(range: ISpriteShapeAngleRange, index: number): ReactNode {
		return (
			<div key={range.id} className="rounded border border-border p-2">
				<div className="mb-1 flex items-center justify-between text-xs font-medium">
					<span>
						{range.name} · {range.id}
					</span>
					<Button variant="secondary" size="icon" className="h-7 w-7" onClick={() => this._removeAngleRange(index)}>
						<AiOutlineMinus />
					</Button>
				</div>
				<div className="grid grid-cols-2 gap-1">
					{this._textInput("Name", range.name, (name) => this._setAngleRange(index, { name }), true)}
					{this._numberInput("Order", range.order, (order) => this._setAngleRange(index, { order }), -1000)}
					{this._numberInput("Min °", range.minimumDegrees, (minimumDegrees) => this._setAngleRange(index, { minimumDegrees }), -180)}
					{this._numberInput("Max °", range.maximumDegrees, (maximumDegrees) => this._setAngleRange(index, { maximumDegrees }), -180)}
				</div>
				{this._textInput("Texture", range.texturePath ?? "", (texturePath) => this._setAngleRange(index, { texturePath: texturePath || null }), true)}
				<label className="mt-1 flex items-center justify-between text-xs">
					Color{" "}
					<input
						type="color"
						defaultValue={colorToHex(range.color)}
						onBlur={(event) => this._setAngleRange(index, { color: hexToColor(event.currentTarget.value, range.color[3]) })}
					/>
				</label>
			</div>
		);
	}

	private _renderProfileLibrary(): ReactNode {
		return (
			<EditorInspectorSectionField title="Profile Library">
				<div className="flex flex-col gap-2 px-2 pb-2">
					<Button variant="secondary" onClick={() => this._createProfile()}>
						<AiOutlinePlus className="mr-1" /> Create And Assign Profile
					</Button>
					{this.state.profiles.map((profile) => (
						<div key={profile.id} className="flex items-center justify-between rounded border border-border p-2 text-xs">
							<span>
								{profile.name} · r{profile.revision} · {profile.shapeCount} shape(s)
							</span>
							<Button
								variant="secondary"
								size="icon"
								className="h-7 w-7"
								disabled={profile.shapeCount > 0}
								onClick={() => this._deleteProfile(profile)}
								title={profile.shapeCount ? "Retarget every shape before deleting this profile" : "Delete unused profile"}
							>
								<AiOutlineMinus />
							</Button>
						</div>
					))}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _setPoint(index: number, update: Partial<ISpriteShapeDefinition["points"][number]>): void {
		const points = this.state.definition.points.map((point, candidate) => (candidate === index ? { ...point, ...update } : point));
		this._updateDefinition({ points });
	}

	private _insertControlPoint(index: number): void {
		const points = [...this.state.definition.points];
		const current = points[index];
		const next = points[index + 1] ?? (this.state.definition.closed ? points[0] : null);
		const position: [number, number] = next
			? [(current.position[0] + next.position[0]) / 2, (current.position[1] + next.position[1]) / 2]
			: [current.position[0] + 100, current.position[1]];
		points.splice(index + 1, 0, { id: Tools.RandomId(), position, leftTangent: [0, 0], rightTangent: [0, 0], tangentMode: "linear", height: current.height, corner: true });
		this._updateDefinition({ points });
	}

	private _removeControlPoint(index: number): void {
		this._updateDefinition({ points: this.state.definition.points.filter((_point, candidate) => candidate !== index) });
	}

	private _addAngleRange(): void {
		const angleRanges = [
			...this.state.profile.angleRanges,
			{
				id: Tools.RandomId(),
				name: `Angle Range ${this.state.profile.angleRanges.length + 1}`,
				minimumDegrees: -45,
				maximumDegrees: 45,
				order: this.state.profile.angleRanges.length,
				texturePath: null,
				color: [...this.state.profile.edgeColor] as [number, number, number, number],
			},
		];
		this._updateProfile({ angleRanges });
	}

	private _setAngleRange(index: number, update: Partial<ISpriteShapeAngleRange>): void {
		this._updateProfile({ angleRanges: this.state.profile.angleRanges.map((range, candidate) => (candidate === index ? { ...range, ...update } : range)) });
	}

	private _removeAngleRange(index: number): void {
		this._updateProfile({ angleRanges: this.state.profile.angleRanges.filter((_range, candidate) => candidate !== index) });
	}

	private _createProfile(): void {
		const scene = this.props.object.getScene();
		const options = { editor: this.props.editor };
		try {
			let suffix = this.state.profiles.length + 1;
			while (this.state.profiles.some((profile) => profile.name === `Sprite Shape Profile ${suffix}`)) {
				suffix++;
			}
			const profile = createSpriteShapeProfile(scene, { name: `Sprite Shape Profile ${suffix}` }, options);
			const before = getSpriteShapeSnapshot(this.props.object);
			setSpriteShape(scene, { nodeId: this.props.object.id, expectedRevision: before.definition.revision, update: { profileId: profile.id } }, options);
			const after = getSpriteShapeSnapshot(this.props.object);
			registerUndoRedo({
				undo: () => {
					restoreSpriteShapeSnapshot(scene, before, options);
					const current = getSpriteShapeProfile(scene, { profileId: profile.id });
					deleteSpriteShapeProfile(scene, { profileId: current.id, expectedRevision: current.revision }, options);
				},
				redo: () => {
					createSpriteShapeProfile(scene, profile as unknown as Record<string, unknown>, options);
					restoreSpriteShapeSnapshot(scene, after, options);
				},
			});
			this._reload();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create a Sprite Shape profile.");
			this._reload();
		}
	}

	private _deleteProfile(profile: { id: string; name: string; revision: number; shapeCount: number }): void {
		const scene = this.props.object.getScene();
		const options = { editor: this.props.editor };
		try {
			const snapshot = getSpriteShapeProfile(scene, { profileId: profile.id });
			deleteSpriteShapeProfile(scene, { profileId: profile.id, expectedRevision: profile.revision }, options);
			registerUndoRedo({
				undo: () => {
					createSpriteShapeProfile(scene, snapshot as unknown as Record<string, unknown>, options);
				},
				redo: () => {
					const current = getSpriteShapeProfile(scene, { profileId: profile.id });
					deleteSpriteShapeProfile(scene, { profileId: current.id, expectedRevision: current.revision }, options);
				},
			});
			this._reload();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not delete the Sprite Shape profile.");
			this._reload();
		}
	}

	private _numberInput(label: string, value: number, onCommit: (value: number) => void, minimum = -100_000_000): ReactNode {
		return (
			<label className="flex items-center gap-1 text-xs">
				<span className="w-14 text-muted-foreground">{label}</span>
				<Input
					type="number"
					defaultValue={value}
					min={minimum}
					step="any"
					className="h-8"
					onBlur={(event) => {
						const next = Number(event.currentTarget.value);
						if (Number.isFinite(next) && next !== value) {
							onCommit(next);
						}
					}}
				/>
			</label>
		);
	}

	private _textInput(label: string, value: string, onCommit: (value: string) => void, compact = false): ReactNode {
		return (
			<label className={`flex items-center gap-2 text-xs ${compact ? "" : "px-2 py-1"}`}>
				<span className={compact ? "w-14 text-muted-foreground" : "w-1/3"}>{label}</span>
				<Input
					defaultValue={value}
					className="h-8 flex-1"
					onKeyUp={(event) => event.key === "Enter" && event.currentTarget.blur()}
					onBlur={(event) => event.currentTarget.value !== value && onCommit(event.currentTarget.value)}
				/>
			</label>
		);
	}
}
