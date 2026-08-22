import { Component, ReactNode } from "react";

import { BaseTexture, Mesh, PBRMaterial } from "babylonjs";

import { getSubsurfaceMaskTexture } from "babylonjs-editor-tools";

import { Button } from "../../../../../ui/shadcn/ui/button";
import { Input } from "../../../../../ui/shadcn/ui/input";
import { Editor } from "../../../../main";
import {
	clearSubsurfaceMaterial,
	createDiffusionProfile,
	getSubsurfaceMaterial,
	listDiffusionProfileAssetsForInspector,
	setSubsurfaceMaterial,
	getSubsurfaceRuntimeState,
	setSubsurfaceRuntimeState,
} from "../../../../../mcp/materials/subsurface";
import { bakeSubsurfaceTransport, clearSubsurfaceTransport, getSubsurfaceTransport } from "../../../../../mcp/materials/subsurface-transport";
import { EditorInspectorSectionField } from "../../fields/section";
import { EditorInspectorTextureField } from "../../fields/texture";
import { EditorInspectorNumberField } from "../../fields/number";
import { EditorInspectorSwitchField } from "../../fields/switch";

interface IEditorSubsurfaceMaterialInspectorProps {
	editor: Editor;
	material: PBRMaterial;
}

interface IEditorSubsurfaceMaterialInspectorState {
	profiles: any[];
	selectedPath: string;
	mode: "subsurface-scattering" | "translucent";
	subsurfaceMask: number;
	transmissionEnabled: boolean;
	transmissionIntensity: number;
	thicknessMultiplier: number;
	transportMeshId: string;
	transportUvChannel: "uv0" | "uv2";
	transportResolution: number;
	transportSamples: number;
	transportMaxDistance: number;
	busy: boolean;
	error: string | null;
}

function meshesUsingMaterial(material: PBRMaterial): Mesh[] {
	return material
		.getScene()
		.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh)
		.filter((mesh) => mesh.material === material || Boolean((mesh.material as { subMaterials?: Array<unknown> } | null)?.subMaterials?.includes(material)))
		.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export class EditorSubsurfaceMaterialInspector extends Component<IEditorSubsurfaceMaterialInspectorProps, IEditorSubsurfaceMaterialInspectorState> {
	public constructor(props: IEditorSubsurfaceMaterialInspectorProps) {
		super(props);
		const current = getSubsurfaceMaterial(props.material.getScene(), { materialId: props.material.id });
		const transportMeshes = meshesUsingMaterial(props.material);
		this.state = {
			profiles: [],
			selectedPath: current.metadata?.profile.path ?? "",
			mode: current.metadata?.mode ?? "subsurface-scattering",
			subsurfaceMask: current.metadata?.subsurfaceMask ?? 1,
			transmissionEnabled: current.metadata?.transmissionEnabled ?? true,
			transmissionIntensity: current.metadata?.transmissionIntensity ?? 1,
			thicknessMultiplier: current.metadata?.thicknessMultiplier ?? 1,
			transportMeshId: transportMeshes[0]?.id ?? "",
			transportUvChannel: "uv0",
			transportResolution: 64,
			transportSamples: 8,
			transportMaxDistance: 1000,
			busy: false,
			error: null,
		};
	}

	public componentDidMount(): void {
		void this._reloadProfiles();
	}

	public componentDidUpdate(previous: IEditorSubsurfaceMaterialInspectorProps): void {
		if (previous.material !== this.props.material) {
			const current = getSubsurfaceMaterial(this.props.material.getScene(), { materialId: this.props.material.id });
			const transportMeshes = meshesUsingMaterial(this.props.material);
			this.setState({
				selectedPath: current.metadata?.profile.path ?? "",
				mode: current.metadata?.mode ?? "subsurface-scattering",
				subsurfaceMask: current.metadata?.subsurfaceMask ?? 1,
				transmissionEnabled: current.metadata?.transmissionEnabled ?? true,
				transmissionIntensity: current.metadata?.transmissionIntensity ?? 1,
				thicknessMultiplier: current.metadata?.thicknessMultiplier ?? 1,
				transportMeshId: transportMeshes[0]?.id ?? "",
			});
			void this._reloadProfiles();
		}
	}

	public render(): ReactNode {
		const current = getSubsurfaceMaterial(this.props.material.getScene(), { materialId: this.props.material.id });
		const runtime = current.runtime;
		const runtimeMaterial = runtime.materials.find((entry: any) => entry.materialId === this.props.material.id);
		const transportMeshes = meshesUsingMaterial(this.props.material);
		const transport = current.configured ? getSubsurfaceTransport(this.props.material.getScene(), { materialId: this.props.material.id }) : null;
		const selectedCache = transport?.caches.find((cache: any) => cache.meshId === this.state.transportMeshId) ?? null;
		const runtimeCache = runtime.transport.caches.find((cache: any) => cache.materialId === this.props.material.id && cache.meshId === this.state.transportMeshId) ?? null;
		return (
			<EditorInspectorSectionField
				title="Subsurface Scattering"
				tooltip="Unity-style diffusion profiles drive Babylon's real Burley screen-space pre-pass. The same exact asset/material/runtime lifecycle is available through MCP."
			>
				<div className="flex flex-col gap-2 text-xs">
					<div className={`rounded p-2 ${runtime.errors.length ? "bg-destructive/10 text-destructive" : current.configured ? "bg-success/10 text-success" : "bg-input"}`}>
						<div>{current.configured ? `Active · ${runtime.backend}` : "No diffusion profile assigned"}</div>
						{current.configured && (
							<>
								<div>
									{current.metadata.profile.name} · material rev {current.metadata.revision} · profile rev {current.metadata.profile.revision}
								</div>
								<div>
									{runtime.shaderLanguage} · {runtime.quality}/{runtime.sampleBudget} samples · {runtime.profileCount}/{runtime.profileCapacity} profiles ·
									pre-pass {runtime.prePassEnabled ? "enabled" : "disabled"}
								</div>
								<div>{runtime.postProcessReady ? "Renderer ready" : "Renderer compiling"} · screen-space Burley</div>
								<div>
									Mask target {runtime.maskTargetReady ? "ready" : "compiling"} · {runtime.maskTargetWidth}×{runtime.maskTargetHeight} · {runtime.maskMeshCount}{" "}
									meshes · red channel
								</div>
								{runtimeMaterial?.subsurfaceMaskTextureName && <div>Mask texture {runtimeMaterial.subsurfaceMaskTextureName}</div>}
								<div>
									Off-screen transport {runtime.transport.enabled ? (runtime.transport.ready ? "ready" : "needs attention") : "screen-space mode"} · caches{" "}
									{runtime.transport.activeCacheCount}/{runtime.transport.cacheCount} · {runtime.transport.backend}
								</div>
							</>
						)}
						{runtime.errors.map((error: string) => (
							<div key={error}>{error}</div>
						))}
					</div>

					<label className="flex flex-col gap-1">
						Diffusion Profile
						<select
							className="h-8 rounded border border-border bg-input px-2"
							value={this.state.selectedPath}
							onChange={(event) => this.setState({ selectedPath: event.currentTarget.value })}
						>
							<option value="">Select a profile…</option>
							{this.state.profiles.map((profile) => (
								<option key={profile.path} value={profile.path}>
									{profile.name} · rev {profile.assetRevision}
								</option>
							))}
						</select>
					</label>

					<label className="grid grid-cols-[1fr_150px] items-center gap-2">
						Material Mode
						<select
							className="h-8 rounded border border-border bg-input px-2"
							value={this.state.mode}
							onChange={(event) => this.setState({ mode: event.currentTarget.value as any })}
						>
							<option value="subsurface-scattering">Subsurface Scattering</option>
							<option value="translucent">Translucent Only</option>
						</select>
					</label>
					<label className="grid grid-cols-[1fr_120px] items-center gap-2">
						Subsurface Mask
						<Input
							type="number"
							min={0}
							max={1}
							step={0.01}
							value={this.state.subsurfaceMask}
							onChange={(event) => this.setState({ subsurfaceMask: Number(event.currentTarget.value) })}
						/>
					</label>
					<label className="flex items-center justify-between gap-2">
						Transmission
						<input type="checkbox" checked={this.state.transmissionEnabled} onChange={(event) => this.setState({ transmissionEnabled: event.currentTarget.checked })} />
					</label>
					<label className="grid grid-cols-[1fr_120px] items-center gap-2">
						Transmission Intensity
						<Input
							type="number"
							min={0}
							max={16}
							step={0.05}
							value={this.state.transmissionIntensity}
							onChange={(event) => this.setState({ transmissionIntensity: Number(event.currentTarget.value) })}
						/>
					</label>
					<label className="grid grid-cols-[1fr_120px] items-center gap-2">
						Thickness Multiplier
						<Input
							type="number"
							min={0}
							max={1000}
							step={0.05}
							value={this.state.thicknessMultiplier}
							onChange={(event) => this.setState({ thicknessMultiplier: Number(event.currentTarget.value) })}
						/>
					</label>

					<EditorInspectorTextureField
						scene={this.props.material.getScene()}
						object={this.props.material.subSurface}
						property="thicknessTexture"
						title="Thickness Texture"
					/>

					{current.configured && (
						<EditorInspectorTextureField
							scene={this.props.material.getScene()}
							object={{ texture: getSubsurfaceMaskTexture(this.props.material as any) }}
							property="texture"
							title="Subsurface Mask Texture (Red)"
							noUndoRedo
							hideLevel
							onChange={(texture) => void this._applyMaskTexture(texture)}
						/>
					)}

					{current.configured && (
						<div className="flex flex-col gap-2 rounded border border-border p-2">
							<div className="font-medium">Camera-independent Ray Transport</div>
							<label className="flex flex-col gap-1">
								Target Mesh
								<select
									className="h-8 rounded border border-border bg-input px-2"
									value={this.state.transportMeshId}
									onChange={(event) => this.setState({ transportMeshId: event.currentTarget.value })}
								>
									<option value="">Select a material mesh…</option>
									{transportMeshes.map((mesh) => (
										<option key={mesh.id} value={mesh.id}>
											{mesh.name} · {mesh.id}
										</option>
									))}
								</select>
							</label>
							<label className="grid grid-cols-[1fr_120px] items-center gap-2">
								UV Channel
								<select
									className="h-8 rounded border border-border bg-input px-2"
									value={this.state.transportUvChannel}
									onChange={(event) => this.setState({ transportUvChannel: event.currentTarget.value as "uv0" | "uv2" })}
								>
									<option value="uv0">UV0</option>
									<option value="uv2">UV2</option>
								</select>
							</label>
							<label className="grid grid-cols-[1fr_120px] items-center gap-2">
								Resolution
								<Input
									type="number"
									min={16}
									max={256}
									value={this.state.transportResolution}
									onChange={(event) => this.setState({ transportResolution: Number(event.currentTarget.value) })}
								/>
							</label>
							<label className="grid grid-cols-[1fr_120px] items-center gap-2">
								Ray Samples
								<Input
									type="number"
									min={1}
									max={64}
									value={this.state.transportSamples}
									onChange={(event) => this.setState({ transportSamples: Number(event.currentTarget.value) })}
								/>
							</label>
							<label className="grid grid-cols-[1fr_120px] items-center gap-2">
								Max Distance (cm)
								<Input
									type="number"
									min={0.001}
									max={1000000}
									value={this.state.transportMaxDistance}
									onChange={(event) => this.setState({ transportMaxDistance: Number(event.currentTarget.value) })}
								/>
							</label>
							{selectedCache && (
								<div className={`rounded p-2 ${runtimeCache?.stale ? "bg-amber-500/10 text-amber-400" : "bg-success/10 text-success"}`}>
									<div>
										Cache rev {selectedCache.revision} · {selectedCache.resolution}² · {selectedCache.sampleCount} samples · {selectedCache.rayCount} rays
									</div>
									<div>
										Hits {selectedCache.hitTexels}/{selectedCache.coveredTexels} texels · thickness {selectedCache.minimumThickness.toFixed(3)}–
										{selectedCache.maximumThickness.toFixed(3)} cm
									</div>
									{runtimeCache?.staleReasons.map((reason: string) => (
										<div key={reason}>{reason}</div>
									))}
								</div>
							)}
							<div className="flex flex-wrap gap-2">
								<Button size="sm" disabled={this.state.busy || !this.state.transportMeshId} onClick={() => void this._bakeTransport(selectedCache)}>
									{this.state.busy ? "Tracing…" : selectedCache ? "Re-bake Off-screen Transport" : "Bake Off-screen Transport"}
								</Button>
								{selectedCache && (
									<Button size="sm" variant="destructive" disabled={this.state.busy} onClick={() => void this._clearTransport(selectedCache)}>
										Clear Transport Cache
									</Button>
								)}
							</div>
							<div className="text-muted-foreground">
								Static CPU rays use off-screen mesh/light data and a portable GLSL/WGSL RGBM cache; signed changes require re-baking.
							</div>
						</div>
					)}

					{!current.configured && (
						<div className="rounded border border-border p-2">
							<div className="mb-1 font-medium">Advanced Refraction</div>
							<EditorInspectorSwitchField
								object={this.props.material.subSurface}
								property="isRefractionEnabled"
								label="Refraction"
								tooltip="Legacy Babylon PBR refraction remains available when no portable diffusion profile is assigned. Portable subsurface materials use transmission instead."
								onChange={() => this.forceUpdate()}
							/>
							{this.props.material.subSurface.isRefractionEnabled && (
								<>
									<EditorInspectorNumberField
										object={this.props.material.subSurface}
										property="refractionIntensity"
										label="Intensity"
										min={0}
										max={1}
										step={0.01}
									/>
									<EditorInspectorNumberField
										object={this.props.material.subSurface}
										property="indexOfRefraction"
										label="Index of Refraction"
										min={1}
										max={3}
										step={0.01}
									/>
								</>
							)}
						</div>
					)}

					<div className="flex flex-wrap gap-2">
						<Button size="sm" disabled={this.state.busy || !this.state.selectedPath} onClick={() => void this._apply()}>
							{this.state.busy ? "Applying…" : current.configured ? "Apply Exact Update" : "Assign Profile"}
						</Button>
						<Button size="sm" variant="secondary" disabled={this.state.busy} onClick={() => void this._createDefault()}>
							Create Skin Profile
						</Button>
						{current.configured && (
							<Button size="sm" variant="destructive" disabled={this.state.busy} onClick={() => void this._clear()}>
								Clear
							</Button>
						)}
					</div>
					{this.state.error && <div className="rounded bg-destructive/10 p-2 text-destructive">{this.state.error}</div>}
					<div className="text-muted-foreground">The optional mask texture uses its red channel and multiplies the scalar mask.</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _reloadProfiles(): Promise<void> {
		try {
			const profiles = await listDiffusionProfileAssetsForInspector();
			this.setState((state) => ({ profiles, selectedPath: state.selectedPath || profiles[0]?.path || "", error: null }));
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _apply(): Promise<void> {
		const profile = this.state.profiles.find((candidate) => candidate.path === this.state.selectedPath);
		if (!profile) {
			this.setState({ error: "Select a valid diffusion profile." });
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			const current = getSubsurfaceMaterial(this.props.material.getScene(), { materialId: this.props.material.id });
			await setSubsurfaceMaterial(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					expectedRevision: current.metadata?.revision ?? 0,
					profilePath: profile.path,
					expectedProfileRevision: profile.contentRevision,
					mode: this.state.mode,
					subsurfaceMask: this.state.subsurfaceMask,
					transmissionEnabled: this.state.transmissionEnabled,
					transmissionIntensity: this.state.transmissionIntensity,
					thicknessMultiplier: this.state.thicknessMultiplier,
					useThicknessTexture: Boolean(this.props.material.subSurface.thicknessTexture),
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _applyMaskTexture(texture: BaseTexture | null): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const current = getSubsurfaceMaterial(this.props.material.getScene(), { materialId: this.props.material.id });
			await setSubsurfaceMaterial(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					expectedRevision: current.metadata.revision,
					_subsurfaceMaskTexture: texture,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _bakeTransport(cache: any): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const transport = getSubsurfaceTransport(this.props.material.getScene(), { materialId: this.props.material.id });
			await bakeSubsurfaceTransport(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					meshId: this.state.transportMeshId,
					expectedRevision: transport.materialRevision,
					expectedCacheRevision: cache?.revision,
					uvChannel: this.state.transportUvChannel,
					resolution: this.state.transportResolution,
					sampleCount: this.state.transportSamples,
					maxDistance: this.state.transportMaxDistance,
				},
				{ editor: this.props.editor }
			);
			const { settings } = getSubsurfaceRuntimeState(this.props.material.getScene());
			if (settings.transportMode !== "baked-ray-traced") {
				setSubsurfaceRuntimeState(
					this.props.material.getScene(),
					{ expectedRevision: settings.revision, transportMode: "baked-ray-traced" },
					{ editor: this.props.editor }
				);
			}
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _clearTransport(cache: any): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const transport = getSubsurfaceTransport(this.props.material.getScene(), { materialId: this.props.material.id });
			await clearSubsurfaceTransport(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					meshId: this.state.transportMeshId,
					expectedRevision: transport.materialRevision,
					expectedCacheRevision: cache.revision,
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _createDefault(): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const safeName = this.props.material.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "Skin";
			const created = await createDiffusionProfile(
				this.props.material.getScene(),
				{ path: `assets/materials/${safeName}.diffusionprofile.json`, name: `${this.props.material.name} Skin` },
				{ editor: this.props.editor }
			);
			await this._reloadProfiles();
			this.setState({ selectedPath: created.path });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _clear(): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const current = getSubsurfaceMaterial(this.props.material.getScene(), { materialId: this.props.material.id });
			clearSubsurfaceMaterial(
				this.props.material.getScene(),
				{ materialId: this.props.material.id, expectedRevision: current.metadata.revision, confirm: true },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
