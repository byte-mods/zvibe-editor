import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { AbstractMesh } from "babylonjs";
import { TerrainMaterial } from "babylonjs-materials";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Editor } from "../../../main";
import { paintTerrainLayer } from "../../../../mcp/materials/materials";

import { EditorInspectorColorField } from "../fields/color";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorTextureField } from "../fields/texture";
import { EditorInspectorSectionField } from "../fields/section";

import { EditorMaterialInspectorUtilsComponent } from "./components/utils";

export interface IEditorTerrainMaterialInspectorProps {
	mesh?: AbstractMesh;
	material: TerrainMaterial;
	editor: Editor;
}

export interface IEditorTerrainMaterialInspectorState {
	outputPath: string;
	centerU: number;
	centerV: number;
	radius: number;
	strength: number;
	layer: number;
	processing: boolean;
}

/** Inspector for Babylon's three-way splat-map terrain material. */
export class EditorTerrainMaterialInspector extends Component<IEditorTerrainMaterialInspectorProps, IEditorTerrainMaterialInspectorState> {
	public constructor(props: IEditorTerrainMaterialInspectorProps) {
		super(props);
		const paint = props.material.metadata?.babylonEditorTerrainSplatMap;
		this.state = {
			outputPath:
				paint?.path ??
				`assets/${
					props.material.name
						.replace(/[^a-z0-9]+/gi, "-")
						.replace(/^-|-$/g, "")
						.toLowerCase() || "terrain"
				}-splat.png`,
			centerU: paint?.lastBrush?.center?.[0] ?? 0.5,
			centerV: paint?.lastBrush?.center?.[1] ?? 0.5,
			radius: paint?.lastBrush?.radius ?? 0.15,
			strength: paint?.lastBrush?.strength ?? 1,
			layer: paint?.lastBrush?.layer ?? 0,
			processing: false,
		};
	}

	public render(): ReactNode {
		return (
			<>
				<EditorInspectorSectionField title="Material" label={this.props.material.getClassName()}>
					<EditorInspectorStringField label="Name" object={this.props.material} property="name" />
					<EditorInspectorSwitchField label="Back Face Culling" object={this.props.material} property="backFaceCulling" />
					<EditorMaterialInspectorUtilsComponent mesh={this.props.mesh} material={this.props.material} />
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Terrain Layers">
					<EditorInspectorTextureField hideLevel object={this.props.material} title="Mix Texture (RGB Splat Map)" property="mixTexture" />
					<EditorInspectorTextureField hideLevel object={this.props.material} title="Diffuse Layer 1 (Red)" property="diffuseTexture1" />
					<EditorInspectorTextureField hideLevel object={this.props.material} title="Diffuse Layer 2 (Green)" property="diffuseTexture2" />
					<EditorInspectorTextureField hideLevel object={this.props.material} title="Diffuse Layer 3 (Blue)" property="diffuseTexture3" />
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Paint Splat Map"
					isProcessing={this.state.processing}
					tooltip="Paints the RGB mix texture: layer 1 is red, layer 2 is green, and layer 3 is blue."
				>
					<div className="flex gap-2 items-center px-2">
						<div className="w-1/3">Output PNG</div>
						<input
							className="px-5 py-2 rounded-lg bg-muted-foreground/10 outline-none w-2/3"
							value={this.state.outputPath}
							onChange={(event) => this.setState({ outputPath: event.currentTarget.value })}
						/>
					</div>
					<div className="grid grid-cols-2 gap-2 px-2">
						{this._numberInput("U", "centerU", 0, 1, 0.01)}
						{this._numberInput("V", "centerV", 0, 1, 0.01)}
						{this._numberInput("Radius", "radius", 0.001, 1, 0.01)}
						{this._numberInput("Strength", "strength", 0, 1, 0.01)}
					</div>
					<div className="flex gap-2 px-2">
						{[0, 1, 2].map((layer) => (
							<Button
								key={layer}
								size="sm"
								variant={this.state.layer === layer ? "default" : "secondary"}
								className="flex-1"
								onClick={() => this.setState({ layer })}
							>
								Layer {layer + 1}
							</Button>
						))}
					</div>
					<Button disabled={this.state.processing || !this.state.outputPath} onClick={() => this._paintSplatMap()}>
						Paint Brush
					</Button>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Normal Maps">
					<EditorInspectorTextureField hideLevel object={this.props.material} title="Normal Layer 1" property="bumpTexture1" />
					<EditorInspectorTextureField hideLevel object={this.props.material} title="Normal Layer 2" property="bumpTexture2" />
					<EditorInspectorTextureField hideLevel object={this.props.material} title="Normal Layer 3" property="bumpTexture3" />
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Lighting">
					<EditorInspectorColorField label="Diffuse" object={this.props.material} property="diffuseColor" />
					<EditorInspectorColorField label="Specular" object={this.props.material} property="specularColor" />
					<EditorInspectorNumberField label="Specular Power" object={this.props.material} property="specularPower" min={0} step={1} />
					<EditorInspectorSwitchField label="Disable Lighting" object={this.props.material} property="disableLighting" />
				</EditorInspectorSectionField>
			</>
		);
	}

	private _numberInput(label: string, property: "centerU" | "centerV" | "radius" | "strength", min: number, max: number, step: number): ReactNode {
		return (
			<label className="flex gap-2 items-center">
				<span className="w-1/3 text-sm">{label}</span>
				<input
					className="px-3 py-2 rounded-lg bg-muted-foreground/10 outline-none w-2/3"
					type="number"
					min={min}
					max={max}
					step={step}
					value={this.state[property]}
					onChange={(event) =>
						this.setState({ [property]: Math.min(max, Math.max(min, Number(event.currentTarget.value) || 0)) } as Pick<
							IEditorTerrainMaterialInspectorState,
							typeof property
						>)
					}
				/>
			</label>
		);
	}

	private async _paintSplatMap(): Promise<void> {
		this.setState({ processing: true });
		try {
			const result = await paintTerrainLayer(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					outputPath: this.state.outputPath,
					center: [this.state.centerU, this.state.centerV],
					radius: this.state.radius,
					strength: this.state.strength,
					layer: this.state.layer,
				},
				{ editor: this.props.editor }
			);
			toast.success(`Painted ${result.changedPixels} splat-map pixels.`);
		} catch (error: any) {
			toast.error(`Failed to paint terrain layer: ${error.message}`);
		} finally {
			this.setState({ processing: false });
		}
	}
}
