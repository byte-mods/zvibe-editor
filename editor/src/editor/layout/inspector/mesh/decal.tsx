import { Component, ReactNode } from "react";

import { IoIosWarning } from "react-icons/io";

import { Mesh, MeshBuilder, Vector3 } from "babylonjs";

import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSectionField } from "../fields/section";
import { EditorInspectorSwitchField } from "../fields/switch";
import { listRenderingLayers } from "../../../../mcp/rendering/renderer-lists";

export interface IMeshDecalInspectorProps {
	object: Mesh;
}

export interface IMeshDecalInspectorState {
	meshExists: boolean;
	projectionValid: boolean;
}

export class MeshDecalInspector extends Component<IMeshDecalInspectorProps, IMeshDecalInspectorState> {
	public constructor(props: IMeshDecalInspectorProps) {
		super(props);

		this.state = {
			meshExists: true,
			projectionValid: this.props.object.getTotalVertices() > 0 && this.props.object.getTotalIndices() > 0,
		};
	}

	public render(): ReactNode {
		if (!this.props.object.metadata?.decal) {
			return null;
		}

		const proxy = this._getProxy(() => this._handleUpdateCurrentDecalMesh());
		const volumeProjector = this.props.object.metadata.decal.projectionMode === "screen-space-volume";
		const channelProxy = this._getChannelProxy(() => this._handleUpdateCurrentDecalMesh());
		const layers = volumeProjector ? (listRenderingLayers(this.props.object.getScene()).layers as { id: string; name: string; bit: number }[]) : [];
		const decalLayerMask = Number.isInteger(this.props.object.metadata.decal.decalLayerMask) ? this.props.object.metadata.decal.decalLayerMask >>> 0 : 0xffffffff;

		return (
			<EditorInspectorSectionField title="Decal">
				<div className="text-xs text-muted-foreground">
					{volumeProjector ? "Screen-space Volume Projector · deferred world-position reconstruction" : "Projected Geometry · deferred G-buffer compatible"} · revision{" "}
					{Number.isInteger(this.props.object.metadata.decal.revision) ? this.props.object.metadata.decal.revision : 1}
				</div>
				<EditorInspectorNumberField object={proxy} property="sizeX" step={1} label="Width" />
				<EditorInspectorNumberField object={proxy} property="sizeY" step={1} label="Height" />
				<EditorInspectorNumberField object={proxy} property="sizeZ" step={1} label="Depth" />
				{volumeProjector ? (
					<>
						<EditorInspectorNumberField object={proxy} property="edgeFade" min={0} max={1} step={0.01} label="Edge Fade" />
						<div className="grid grid-cols-2 gap-x-3">
							<EditorInspectorSwitchField object={channelProxy} property="albedo" label="Albedo" onChange={() => this.forceUpdate()} />
							<EditorInspectorSwitchField object={channelProxy} property="normal" label="Normal" onChange={() => this.forceUpdate()} />
							<EditorInspectorSwitchField object={channelProxy} property="metallic" label="Metallic / Smoothness" onChange={() => this.forceUpdate()} />
							<EditorInspectorSwitchField object={channelProxy} property="ambientOcclusion" label="Ambient Occlusion" onChange={() => this.forceUpdate()} />
							<EditorInspectorSwitchField object={channelProxy} property="emissive" label="Emissive" onChange={() => this.forceUpdate()} />
						</div>
						{channelProxy.normal && <EditorInspectorNumberField object={proxy} property="normalStrength" min={0} max={2} step={0.01} label="Normal Strength" />}
						{channelProxy.metallic && (
							<>
								<EditorInspectorNumberField object={proxy} property="metallic" min={0} max={1} step={0.01} label="Metallic" />
								<EditorInspectorNumberField object={proxy} property="smoothness" min={0} max={1} step={0.01} label="Smoothness" />
							</>
						)}
						{channelProxy.ambientOcclusion && (
							<EditorInspectorNumberField object={proxy} property="ambientOcclusion" min={0} max={1} step={0.01} label="Ambient Occlusion" />
						)}
						{channelProxy.emissive && (
							<EditorInspectorNumberField object={proxy} property="emissiveIntensity" min={0} max={16} step={0.05} label="Emissive Intensity" />
						)}
						<label className="flex flex-col gap-1 px-2 text-xs">
							Decal Layer Mask
							<input
								key={`decal-layer-${decalLayerMask}`}
								type="number"
								min={0}
								max={4294967295}
								defaultValue={decalLayerMask}
								onBlur={(event) =>
									Number(event.currentTarget.value) !== decalLayerMask && Reflect.set(proxy as object, "decalLayerMask", Number(event.currentTarget.value) >>> 0)
								}
								className="h-8 w-full rounded-md border border-input bg-background px-2"
							/>
						</label>
						<div className="flex flex-wrap gap-3 px-2">
							{layers.map((layer) => {
								const bit = 2 ** layer.bit;
								return (
									<label key={layer.id} className="text-xs">
										<input
											type="checkbox"
											checked={(decalLayerMask & bit) !== 0}
											onChange={(event) =>
												Reflect.set(
													proxy as object,
													"decalLayerMask",
													event.currentTarget.checked ? (decalLayerMask | bit) >>> 0 : (decalLayerMask & ~bit) >>> 0
												)
											}
										/>{" "}
										{layer.name} ({layer.bit})
									</label>
								);
							})}
							{!layers.length && (
								<span className="text-xs text-muted-foreground">Create named Rendering Layers in the Scene Inspector, or edit the mask directly.</span>
							)}
						</div>
						<div className="text-xs text-muted-foreground">
							Ordered by Alpha Index · overlaps target native Rendering Layers · R=metallic, A=smoothness, AO=red · up to 8 active projectors per camera
						</div>
					</>
				) : (
					<EditorInspectorNumberField asDegrees object={proxy} property="angle" step={0.1} label="Angle" />
				)}

				{!this.state.meshExists && (
					<div className="flex justify-center items-center gap-2">
						<IoIosWarning size="24px" />

						<div className="text-yellow-500">Source mesh not found.</div>
					</div>
				)}
				{!this.state.projectionValid && (
					<div className="flex justify-center items-center gap-2">
						<IoIosWarning size="24px" />
						<div className="text-yellow-500">Projection volume does not intersect the source mesh. Previous geometry was preserved.</div>
					</div>
				)}
			</EditorInspectorSectionField>
		);
	}

	public componentDidMount(): void {
		if (this.props.object.metadata?.decal && this.props.object.metadata.decal.projectionMode !== "screen-space-volume") {
			const scene = this.props.object.getScene();
			const mesh = scene.getMeshById(this.props.object.metadata.decal.meshId);

			if (!mesh) {
				this.setState({ meshExists: false });
			}
		}
	}

	private _handleUpdateCurrentDecalMesh(): boolean {
		const configuration = this.props.object.metadata.decal;
		if (configuration.projectionMode === "screen-space-volume") {
			if (![configuration.sizeX, configuration.sizeY, configuration.sizeZ].every((value) => Number.isFinite(value) && value > 0)) {
				this.setState({ projectionValid: false });
				return false;
			}
			this.props.object.scaling.set(configuration.sizeX, configuration.sizeY, configuration.sizeZ);
			this.props.object.computeWorldMatrix(true);
			this.setState({ projectionValid: true });
			return true;
		}
		const scene = this.props.object.getScene();
		const mesh = scene.getMeshById(this.props.object.metadata.decal.meshId);
		if (!mesh) {
			return false;
		}

		const decal = MeshBuilder.CreateDecal("decal", mesh, {
			localMode: true,
			angle: configuration.angle,
			size: new Vector3(configuration.sizeX, configuration.sizeY, configuration.sizeZ),
			position: Vector3.FromArray(configuration.position),
			normal: configuration.normal ? Vector3.FromArray(configuration.normal) : undefined,
		});
		if (!decal.geometry || decal.getTotalVertices() === 0 || decal.getTotalIndices() === 0) {
			decal.dispose(false, false);
			this.setState({ projectionValid: false });
			return false;
		}

		this.props.object.geometry?.releaseForMesh(this.props.object);
		decal.geometry?.applyToMesh(this.props.object);
		decal.dispose(false, false);
		this.setState({ projectionValid: true });
		return true;
	}

	private _getProxy<T>(onChange: () => boolean): T {
		const defaults: Record<PropertyKey, unknown> = { normalStrength: 1, metallic: 0, smoothness: 0.5, ambientOcclusion: 1, emissiveIntensity: 1, decalLayerMask: 0xffffffff };
		return new Proxy(this.props.object.metadata.decal, {
			get(target, prop) {
				return target[prop] ?? defaults[prop];
			},
			set(obj, prop, value) {
				const previousValue = obj[prop];
				const previousVersion = obj.version;
				const previousRevision = obj.revision;
				obj[prop] = value;
				obj.version = obj.projectionMode === "screen-space-volume" ? 3 : 1;
				obj.revision = (Number.isInteger(obj.revision) && obj.revision > 0 ? obj.revision : 1) + 1;
				if (!onChange()) {
					obj[prop] = previousValue;
					obj.version = previousVersion;
					obj.revision = previousRevision;
				}
				return true;
			},
		});
	}

	private _getChannelProxy(onChange: () => boolean): Record<string, boolean> {
		const configuration = this.props.object.metadata.decal;
		const defaults = { albedo: true, normal: false, metallic: false, ambientOcclusion: false, emissive: false };
		return new Proxy(configuration.channels ?? defaults, {
			get(target, prop) {
				return target[prop] ?? defaults[prop];
			},
			set: (target, prop, value) => {
				const previousChannels = { ...(configuration.channels ?? defaults) };
				const previousVersion = configuration.version;
				const previousRevision = configuration.revision;
				const nextChannels = { ...previousChannels, [prop]: Boolean(value) };
				if (!Object.values(nextChannels).some(Boolean)) {
					return true;
				}
				configuration.channels = nextChannels;
				configuration.version = 3;
				configuration.revision = (Number.isInteger(configuration.revision) && configuration.revision > 0 ? configuration.revision : 1) + 1;
				if (!onChange()) {
					configuration.channels = previousChannels;
					configuration.version = previousVersion;
					configuration.revision = previousRevision;
				}
				target[prop] = Boolean(value);
				return true;
			},
		});
	}
}
