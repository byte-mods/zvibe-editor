import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { Textarea } from "../../../ui/shadcn/ui/textarea";
import {
	applyPsdSpriteSkinRig,
	createSpriteSkin,
	createSpriteSkinAnimationClip,
	getSpriteSkin,
	inspectPsdSpriteSkinRig,
	IPsdSpriteSkinRigPlan,
	listSpriteSkins,
	replaceSpriteSkinBones,
} from "../../../mcp/sprites/sprite-skinning";

import { Editor } from "../../main";

export interface IEditorSpriteSkinningPanelProps {
	editor: Editor;
}

interface IEditorSpriteSkinningPanelState {
	selectedNodeId: string;
	name: string;
	sourcePath: string;
	documentWidthPixels: number;
	documentHeightPixels: number;
	pixelsPerUnit: number;
	columns: number;
	rows: number;
	psdPath: string;
	psdTexturePath: string;
	psdPlan: IPsdSpriteSkinRigPlan | null;
	bonesJson: string;
	clipName: string;
}

/** Focused Unity-style 2D Animation workspace backed by real Babylon meshes, skeletons, weights, and AnimationGroups. */
export class EditorSpriteSkinningPanel extends Component<IEditorSpriteSkinningPanelProps, IEditorSpriteSkinningPanelState> {
	public constructor(props: IEditorSpriteSkinningPanelProps) {
		super(props);
		const scene = props.editor.layout.preview.scene;
		const first = listSpriteSkins(scene).spriteSkins[0];
		this.state = {
			selectedNodeId: first?.node.id ?? "",
			name: "Sprite Skin",
			sourcePath: "",
			documentWidthPixels: 512,
			documentHeightPixels: 512,
			pixelsPerUnit: 100,
			columns: 16,
			rows: 16,
			psdPath: "",
			psdTexturePath: "",
			psdPlan: null,
			bonesJson: first ? JSON.stringify(first.definition.bones, null, 2) : "[]",
			clipName: "Sprite Clip",
		};
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const skins = listSpriteSkins(scene).spriteSkins;
		const selected = skins.find((candidate: any) => candidate.node.id === this.state.selectedNodeId) ?? null;
		return (
			<div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background p-3 text-sm">
				<div className="mb-3 flex flex-wrap items-center gap-2 border-b border-input pb-3">
					<div className="mr-2 text-base font-semibold">2D Animation</div>
					<select
						className="h-8 min-w-52 rounded border border-border bg-background px-2 text-xs"
						value={selected?.node.id ?? ""}
						onChange={(event) => this._selectSkin(event.target.value)}
					>
						<option value="">Select a sprite skin…</option>
						{skins.map((skin: any) => (
							<option key={skin.node.id} value={skin.node.id}>
								{skin.node.name}
							</option>
						))}
					</select>
					{selected && (
						<>
							<Button size="sm" variant="outline" onClick={() => this._openWeightPainter(selected)}>
								Open Bone Painter
							</Button>
							<span className="text-xs text-muted-foreground">
								{selected.skeleton.boneCount} bones · {selected.vertexCount} vertices · rev {selected.definition.revision}
							</span>
						</>
					)}
				</div>

				<div className="grid gap-3 xl:grid-cols-2">
					<section className="rounded border border-border p-3">
						<div className="mb-2 font-semibold">Create Weighted Sprite</div>
						<div className="grid grid-cols-2 gap-2">
							<Input
								value={this.state.name}
								onChange={(event) => this.setState({ name: event.target.value })}
								placeholder="Sprite skin name"
								aria-label="Sprite skin name"
							/>
							<Input
								value={this.state.sourcePath}
								onChange={(event) => this.setState({ sourcePath: event.target.value })}
								placeholder="Optional project PNG path"
								aria-label="Sprite texture path"
							/>
							{this._numberInput("Width px", "documentWidthPixels", 1)}
							{this._numberInput("Height px", "documentHeightPixels", 1)}
							{this._numberInput("Pixels/unit", "pixelsPerUnit", 0.01)}
							{this._numberInput("Grid columns", "columns", 1)}
							{this._numberInput("Grid rows", "rows", 1)}
						</div>
						<Button className="mt-3" size="sm" onClick={() => this._createSkin()}>
							Create Sprite Skin
						</Button>
					</section>

					<section className="rounded border border-border p-3">
						<div className="mb-2 font-semibold">PSD → Bone Rig</div>
						<div className="space-y-2">
							<Input
								value={this.state.psdPath}
								onChange={(event) => this.setState({ psdPath: event.target.value, psdPlan: null })}
								placeholder="Project-relative .psd/.psb path"
							/>
							<Input
								value={this.state.psdTexturePath}
								onChange={(event) => this.setState({ psdTexturePath: event.target.value })}
								placeholder="Optional extracted/merged PNG path"
							/>
							<div className="flex gap-2">
								<Button size="sm" variant="outline" onClick={() => void this._inspectPsd()}>
									Inspect Layers
								</Button>
								<Button size="sm" disabled={!this.state.psdPlan} onClick={() => void this._applyPsd()}>
									Build Exact Rig
								</Button>
							</div>
							{this.state.psdPlan && (
								<div className="rounded bg-secondary/40 p-2 text-xs">
									{this.state.psdPlan.bones.length} bones from {this.state.psdPlan.layers.filter((layer) => layer.included).length} layers ·{" "}
									{this.state.psdPlan.documentWidthPixels}×{this.state.psdPlan.documentHeightPixels}px
									{this.state.psdPlan.warnings.map((warning) => (
										<div key={warning} className="text-amber-300">
											{warning}
										</div>
									))}
								</div>
							)}
						</div>
					</section>

					<section className="rounded border border-border p-3">
						<div className="mb-2 font-semibold">Bone Hierarchy</div>
						<Textarea
							className="min-h-64 font-mono text-xs"
							value={this.state.bonesJson}
							onChange={(event) => this.setState({ bonesJson: event.target.value })}
							placeholder='[{ "id": "root", "name": "Root", "parentId": null, "position": [0, 0], "rotationDegrees": 90, "length": 100 }]'
						/>
						<div className="mt-2 flex items-center gap-2">
							<Button size="sm" disabled={!selected} onClick={() => this._replaceBones(selected)}>
								Apply Hierarchy + Auto Weights
							</Button>
							<span className="text-xs text-muted-foreground">Exact revision/fingerprint lease; regenerates the bind pose and normalized weights.</span>
						</div>
					</section>

					<section className="rounded border border-border p-3">
						<div className="mb-2 font-semibold">2D Clip Timeline</div>
						<Input value={this.state.clipName} onChange={(event) => this.setState({ clipName: event.target.value })} placeholder="Clip name" />
						<div className="mt-2 flex flex-wrap gap-2">
							<Button size="sm" disabled={!selected} onClick={() => this._createPoseClip(selected)}>
								Create Rotation Pose Clip
							</Button>
							{selected?.animationGroups.map((name: string) => (
								<Button key={name} size="sm" variant="outline" onClick={() => this.props.editor.layout.animations.openAnimationWindow(name)}>
									Open {name}
								</Button>
							))}
						</div>
						<p className="mt-2 text-xs text-muted-foreground">
							Clips are ordinary AnimationGroups, so Dope Sheet, curves, tangents, recording, events, Animator, save/export, and runtime debugging remain available.
						</p>
					</section>
				</div>
			</div>
		);
	}

	private _numberInput(label: string, key: "documentWidthPixels" | "documentHeightPixels" | "pixelsPerUnit" | "columns" | "rows", minimum: number): ReactNode {
		return (
			<label className="flex items-center gap-2 text-xs">
				<span className="w-20 text-muted-foreground">{label}</span>
				<Input type="number" min={minimum} value={String(this.state[key])} onChange={(event) => this.setState({ [key]: Number(event.target.value) } as any)} />
			</label>
		);
	}

	private _selectSkin(nodeId: string): void {
		const scene = this.props.editor.layout.preview.scene;
		const selected = nodeId ? getSpriteSkin(scene, { nodeId }) : null;
		this.setState({ selectedNodeId: nodeId, bonesJson: selected ? JSON.stringify(selected.definition.bones, null, 2) : "[]" });
	}

	private _createSkin(): void {
		try {
			const result = createSpriteSkin(
				this.props.editor.layout.preview.scene,
				{
					name: this.state.name,
					sourcePath: this.state.sourcePath.trim() || undefined,
					documentWidthPixels: this.state.documentWidthPixels,
					documentHeightPixels: this.state.documentHeightPixels,
					pixelsPerUnit: this.state.pixelsPerUnit,
					columns: this.state.columns,
					rows: this.state.rows,
				},
				{ editor: this.props.editor }
			);
			this.setState({ selectedNodeId: result.node.id, bonesJson: JSON.stringify(result.definition.bones, null, 2) });
			toast.success(`Created weighted sprite skin ${result.node.name}.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _inspectPsd(): Promise<void> {
		try {
			const plan = await inspectPsdSpriteSkinRig(this.props.editor.layout.preview.scene, {
				sourcePath: this.state.psdPath,
				pixelsPerUnit: this.state.pixelsPerUnit,
				columns: this.state.columns,
				rows: this.state.rows,
			});
			this.setState({ psdPlan: plan });
			toast.success(`Planned ${plan.bones.length} PSD sprite bones.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _applyPsd(): Promise<void> {
		try {
			const plan = this.state.psdPlan!;
			const result = await applyPsdSpriteSkinRig(
				this.props.editor.layout.preview.scene,
				{
					sourcePath: this.state.psdPath,
					texturePath: this.state.psdTexturePath.trim() || undefined,
					name: this.state.name,
					pixelsPerUnit: this.state.pixelsPerUnit,
					columns: this.state.columns,
					rows: this.state.rows,
					expectedFingerprint: plan.fingerprint,
				},
				{ editor: this.props.editor }
			);
			this.setState({ selectedNodeId: result.node.id, bonesJson: JSON.stringify(result.definition.bones, null, 2), psdPlan: null });
			toast.success(`Built PSD sprite rig ${result.node.name}.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _replaceBones(selected: any): void {
		try {
			const result = replaceSpriteSkinBones(
				this.props.editor.layout.preview.scene,
				{ nodeId: selected.node.id, expectedRevision: selected.definition.revision, expectedFingerprint: selected.fingerprint, bones: JSON.parse(this.state.bonesJson) },
				{ editor: this.props.editor }
			);
			this.setState({ bonesJson: JSON.stringify(result.definition.bones, null, 2) });
			toast.success(`Applied ${result.definition.bones.length} bones and regenerated weights.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _openWeightPainter(selected: any): void {
		const mesh = this.props.editor.layout.preview.scene.getMeshById(selected.node.id);
		if (mesh?.skeleton) {
			this.props.editor.layout.graph.setSelectedNode(mesh);
			this.props.editor.layout.inspector.setEditedObject(mesh.skeleton);
			toast.info("Skin Weights is ready in the Skeleton Inspector. Paint, smooth, mirror, or optimize the selected sprite mesh.");
		}
	}

	private _createPoseClip(selected: any): void {
		try {
			const root = selected.definition.bones[0];
			const result = createSpriteSkinAnimationClip(
				this.props.editor.layout.preview.scene,
				{
					nodeId: selected.node.id,
					expectedRevision: selected.definition.revision,
					expectedFingerprint: selected.fingerprint,
					name: this.state.clipName,
					framesPerSecond: 60,
					tracks: [
						{
							boneName: root.name,
							property: "rotation",
							keys: [
								{ frame: 0, value: -5 },
								{ frame: 15, value: 5 },
								{ frame: 30, value: -5 },
							],
						},
					],
				},
				{ editor: this.props.editor }
			);
			toast.success(`Created ${result.name} and opened its 2D bone timeline.`);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}
}
