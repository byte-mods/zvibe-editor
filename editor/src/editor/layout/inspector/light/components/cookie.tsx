import { Component, ReactNode } from "react";
import { toast } from "sonner";

import { DirectionalLight, PointLight, SpotLight, Vector3 } from "babylonjs";
import { getLightCookieEvidence, getLightCookieMetadata, getLightCookieTexture, setLightCookie } from "babylonjs-editor-tools";

import { EditorInspectorNumberField } from "../../fields/number";
import { EditorInspectorSectionField } from "../../fields/section";
import { EditorInspectorSwitchField } from "../../fields/switch";
import { EditorInspectorTextureField } from "../../fields/texture";
import { EditorInspectorVectorField } from "../../fields/vector";

export interface IEditorLightCookieInspectorProps {
	light: DirectionalLight | PointLight | SpotLight;
}

export class EditorLightCookieInspector extends Component<IEditorLightCookieInspectorProps> {
	private _revision = -1;
	private _fields = {
		texture: null as any,
		enabled: true,
		intensity: 1,
		sizeX: 1000,
		sizeY: 1000,
		offsetX: 0,
		offsetY: 0,
		near: 0.000001,
		far: 1000,
		upDirection: Vector3.Up(),
	};

	public render(): ReactNode {
		const light = this.props.light;
		const evidence = getLightCookieEvidence(light as any);
		const metadata = getLightCookieMetadata(light as any);
		if ((metadata?.revision ?? 0) !== this._revision) {
			this._revision = metadata?.revision ?? 0;
			this._fields.texture = getLightCookieTexture(light as any);
			this._fields.enabled = metadata?.enabled ?? true;
			this._fields.intensity = metadata?.intensity ?? 1;
			this._fields.sizeX = metadata?.size[0] ?? 1000;
			this._fields.sizeY = metadata?.size[1] ?? 1000;
			this._fields.offsetX = metadata?.offset[0] ?? 0;
			this._fields.offsetY = metadata?.offset[1] ?? 0;
			this._fields.near = metadata?.near ?? 0.000001;
			this._fields.far = metadata?.far ?? 1000;
			this._fields.upDirection = Vector3.FromArray(metadata?.upDirection ?? [0, 1, 0]);
		}
		const isPoint = light instanceof PointLight;
		const isDirectional = light instanceof DirectionalLight;
		return (
			<EditorInspectorSectionField
				title="Light Cookie"
				tooltip="Unity-style colored cookie modulation. Spot cookies also use Babylon's native forward projection; directional tiled 2D and point cubemap cookies execute through the shared deferred renderer. Settings persist into exported scenes and have strict MCP parity."
			>
				<div className="flex flex-col gap-2">
					<div className="px-2 text-xs text-muted-foreground">
						{evidence
							? `${evidence.kind} · revision ${evidence.revision} · ${evidence.textureWidth}×${evidence.textureHeight} · ${evidence.textureReady ? "ready" : "loading"}`
							: `${isPoint ? "Point cubemap" : isDirectional ? "Directional tiled 2D" : "Spot projected 2D"} · unassigned`}
					</div>
					<EditorInspectorTextureField
						noUndoRedo
						object={this._fields}
						property="texture"
						title={isPoint ? "Cookie Cubemap" : "Cookie Texture"}
						acceptCubeTexture={isPoint}
						hideLevel
						onChange={(texture) => this._setTexture(texture)}
					/>
					{evidence && (
						<>
							<EditorInspectorSwitchField noUndoRedo label="Enabled" object={this._fields} property="enabled" onChange={() => this._apply()} />
							<EditorInspectorNumberField
								noUndoRedo
								label="Intensity"
								object={this._fields}
								property="intensity"
								min={0}
								max={1}
								step={0.01}
								onFinishChange={() => this._apply()}
							/>
							{isDirectional && (
								<>
									<EditorInspectorNumberField
										noUndoRedo
										label="Size X"
										object={this._fields}
										property="sizeX"
										min={0.0001}
										onFinishChange={() => this._apply()}
									/>
									<EditorInspectorNumberField
										noUndoRedo
										label="Size Y"
										object={this._fields}
										property="sizeY"
										min={0.0001}
										onFinishChange={() => this._apply()}
									/>
									<EditorInspectorNumberField noUndoRedo label="Offset X" object={this._fields} property="offsetX" onFinishChange={() => this._apply()} />
									<EditorInspectorNumberField noUndoRedo label="Offset Y" object={this._fields} property="offsetY" onFinishChange={() => this._apply()} />
								</>
							)}
							{!isPoint && (
								<EditorInspectorVectorField
									noUndoRedo
									label={<div className="w-14">Up</div>}
									object={this._fields}
									property="upDirection"
									onFinishChange={() => this._apply()}
								/>
							)}
							{light instanceof SpotLight && (
								<>
									<EditorInspectorNumberField noUndoRedo label="Near" object={this._fields} property="near" min={0.000001} onFinishChange={() => this._apply()} />
									<EditorInspectorNumberField noUndoRedo label="Far" object={this._fields} property="far" min={0.000002} onFinishChange={() => this._apply()} />
								</>
							)}
						</>
					)}
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _settings(): any {
		return {
			enabled: this._fields.enabled,
			intensity: this._fields.intensity,
			size: [this._fields.sizeX, this._fields.sizeY],
			offset: [this._fields.offsetX, this._fields.offsetY],
			near: this._fields.near,
			far: this._fields.far,
			upDirection: this._fields.upDirection.asArray(),
		};
	}

	private _setTexture(texture: any): void {
		try {
			setLightCookie(this.props.light as any, texture, this._settings());
			this._revision = -1;
			this.forceUpdate();
		} catch (error) {
			this._fields.texture = getLightCookieTexture(this.props.light as any);
			toast.error(error instanceof Error ? error.message : "Could not assign the light cookie.");
			this.forceUpdate();
		}
	}

	private _apply(): void {
		try {
			const texture = getLightCookieTexture(this.props.light as any);
			if (texture) {
				setLightCookie(this.props.light as any, texture, this._settings());
				this._revision = -1;
				this.forceUpdate();
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update the light cookie.");
		}
	}
}
