import { Component, ReactNode } from "react";
import { Divider } from "@blueprintjs/core";

import { RectAreaLight, Vector3 } from "babylonjs";
import { getAreaLightEvidence, getAreaLightMetadata, setAreaLightProperties } from "babylonjs-editor-tools";

import { isRectAreaLight } from "../../../../tools/guards/nodes";
import { onNodeModifiedObservable } from "../../../../tools/observables";

import { IEditorInspectorImplementationProps } from "../inspector";
import { LightRenderingLayersInspector } from "../rendering-layers";
import { EditorInspectorColorField } from "../fields/color";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSectionField } from "../fields/section";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorVectorField } from "../fields/vector";
import { ScriptInspectorComponent } from "../script/script";
import { CustomMetadataInspector } from "../metadata/custom-metadata";
import { EditorLightPBRInspector } from "./components/pbr";

export class EditorAreaLightInspector extends Component<IEditorInspectorImplementationProps<RectAreaLight>> {
	public static IsSupported(object: unknown): boolean {
		return isRectAreaLight(object);
	}

	private _updated(options: Parameters<typeof setAreaLightProperties>[1]): void {
		setAreaLightProperties(this.props.object as any, options);
		onNodeModifiedObservable.notifyObservers(this.props.object);
		this.forceUpdate();
	}

	public render(): ReactNode {
		const light = this.props.object;
		const metadata = getAreaLightMetadata(light as any);
		const evidence = getAreaLightEvidence(light as any);
		const dimensions = { width: metadata.width, height: metadata.height, radius: metadata.radius };
		const orientation = {
			direction: Vector3.FromArray(metadata.direction),
			upDirection: Vector3.FromArray(metadata.upDirection),
		};
		return (
			<>
				<EditorInspectorSectionField title="Common">
					<div className="flex justify-between items-center px-2 py-2">
						<div className="w-1/2">Type</div>
						<div className="text-white/50 w-full">{metadata.shape === "disc" ? "Disc Area Light" : "Rectangle Area Light"}</div>
					</div>
					<EditorInspectorStringField label="Name" object={light} property="name" onChange={() => this._updated({})} />
				</EditorInspectorSectionField>

				<LightRenderingLayersInspector editor={this.props.editor} light={light} onUpdate={() => this.forceUpdate()} />

				<EditorInspectorSectionField title="Transforms">
					<EditorInspectorVectorField label={<div className="w-14">Position</div>} object={light} property="position" onChange={() => this._updated({})} />
					<EditorInspectorVectorField
						label={<div className="w-14">Direction</div>}
						object={orientation}
						property="direction"
						onChange={() => this._updated({ direction: orientation.direction.asArray() as [number, number, number] })}
					/>
					<EditorInspectorVectorField
						label={<div className="w-14">Up</div>}
						object={orientation}
						property="upDirection"
						onChange={() => this._updated({ upDirection: orientation.upDirection.asArray() as [number, number, number] })}
					/>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Area Light">
					<div className="flex items-center gap-2 px-2 py-1">
						<div className="w-32">Shape</div>
						<select
							aria-label="Area light shape"
							className="bg-input rounded px-2 py-1 w-full"
							value={metadata.shape}
							onChange={(event) => this._updated({ shape: event.currentTarget.value as "rectangle" | "disc" })}
						>
							<option value="rectangle">Rectangle</option>
							<option value="disc">Disc</option>
						</select>
					</div>
					{metadata.shape === "rectangle" ? (
						<>
							<EditorInspectorNumberField
								label="Width"
								object={dimensions}
								property="width"
								min={0.0001}
								onChange={() => this._updated({ width: dimensions.width })}
							/>
							<EditorInspectorNumberField
								label="Height"
								object={dimensions}
								property="height"
								min={0.0001}
								onChange={() => this._updated({ height: dimensions.height })}
							/>
						</>
					) : (
						<EditorInspectorNumberField
							label="Radius"
							object={dimensions}
							property="radius"
							min={0.0001}
							onChange={() => this._updated({ radius: dimensions.radius })}
						/>
					)}
					<Divider />
					<EditorInspectorColorField label={<div className="w-14">Diffuse</div>} object={light} property="diffuse" onChange={() => this._updated({})} />
					<EditorInspectorColorField label={<div className="w-14">Specular</div>} object={light} property="specular" onChange={() => this._updated({})} />
					<EditorInspectorNumberField label="Intensity" object={light} property="intensity" min={0} onChange={() => this._updated({})} />
					<EditorInspectorNumberField label="Range" object={light} property="range" min={0.0001} onChange={() => this._updated({})} />
					<Divider />
					<EditorLightPBRInspector object={light} />
					<div className="px-2 py-2 text-xs text-muted-foreground">
						One-sided · revision {metadata.revision} · {evidence.deferredModel} · realtime shadows unsupported; baked GI and SH probes use deterministic soft samples.
					</div>
				</EditorInspectorSectionField>

				<ScriptInspectorComponent editor={this.props.editor} object={light} />
				<CustomMetadataInspector object={light} />
			</>
		);
	}
}
