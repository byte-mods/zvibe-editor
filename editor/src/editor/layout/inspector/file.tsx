import { basename, dirname, extname, join, relative } from "path/posix";

import { Component, ReactNode } from "react";
import { getDefaultAssetImporterConfiguration, IAssetImporterConfiguration, listAssetImporterDefinitions, validateAssetImporterConfiguration } from "babylonjs-editor-tools";

import { EditorInspectorSoundComponent } from "./file/sound";
import { EditorInspectorVideoComponent } from "./file/video";
import { EditorInspectorFontComponent } from "./file/font";
import { EditorInspectorMaterialComponent } from "./file/material";
import { EditorInspectorModelComponent } from "./file/model";
import { EditorInspectorAnimationComponent } from "./file/animation";
import { EditorInspectorImageComponent } from "./file/image";
import { EditorInspectorMarkdownComponent } from "./file/markdown";

import { IEditorInspectorImplementationProps } from "./inspector";
import { Button } from "../../../ui/shadcn/ui/button";
import {
	getIndexedAssetDependencies,
	getIndexedAssetRecord,
	inspectAssetImportState,
	readAssetMetadata,
	refreshAssetRegistryPaths,
	writeAssetMetadata,
} from "../../../mcp/assets/registry";
import { projectConfiguration } from "../../../project/configuration";
import { showPrompt } from "../../../ui/dialog";
import { openAssetDependencyGraph } from "../assets-browser/dependency-graph";
import { applyAudioImporterArtifact, getAudioImporterArtifactStatus, IAudioImporterArtifactStatus } from "../../../mcp/assets/audio-importer";
import { applyVideoImporterArtifact, getVideoImporterArtifactStatus, IVideoImporterArtifactStatus } from "../../../mcp/assets/video-importer";
import { applyFontImporterArtifact, getFontImporterArtifactStatus, IFontImporterArtifactStatus } from "../../../mcp/assets/font-importer";
import { applyMaterialImporterArtifact, getMaterialImporterArtifactStatus, IMaterialImporterArtifactStatus } from "../../../mcp/assets/material-importer";
import { applyModelImporterArtifact, getModelImporterArtifactStatus, IModelImporterArtifactStatus } from "../../../mcp/assets/model-importer";
import { applyAnimationImporterArtifact, getAnimationImporterArtifactStatus, IAnimationImporterArtifactStatus } from "../../../mcp/assets/animation-importer";
import { applyTextureImporterArtifact, getTextureImporterArtifactStatus, ITextureImporterArtifactStatus } from "../../../mcp/assets/texture-importer";

export class FileInspectorObject {
	public readonly isFileInspectorObject = true;

	public constructor(public readonly absolutePath: string) {}
}

export class EditorFileInspector extends Component<IEditorInspectorImplementationProps<FileInspectorObject>> {
	private _extension: string;
	public state: {
		dependencyData: {
			guid: string;
			type: string;
			dependencies: string[];
			missingDependencies: string[];
			referencedBy: string[];
			dependencyScanKind: string;
			dependencyScanStatus: string;
			dependencyScanMessage?: string;
			dependencyScanDeferred: boolean;
			containerEntries: Array<{ path: string; sizeBytes: number; type: string; scannable: boolean }>;
			containerDependencies: Array<{ sourcePath: string; targetPath: string; missing: boolean; external: boolean }>;
			containerEntryCount: number;
			containerDependencyCount: number;
			containerMissingDependencyCount: number;
		} | null;
		assetData: {
			tags: string[];
			favorite: boolean;
			importState: { status: string; checkedAt?: string; error?: { message: string } };
			importer: IAssetImporterConfiguration;
		} | null;
		importerDraft: Record<string, boolean | number | string> | null;
		importerMessage: string | null;
		textureArtifact: ITextureImporterArtifactStatus | null;
		audioArtifact: IAudioImporterArtifactStatus | null;
		videoArtifact: IVideoImporterArtifactStatus | null;
		fontArtifact: IFontImporterArtifactStatus | null;
		materialArtifact: IMaterialImporterArtifactStatus | null;
		modelArtifact: IModelImporterArtifactStatus | null;
		animationArtifact: IAnimationImporterArtifactStatus | null;
		error: string | null;
		loading: boolean;
	} = {
		dependencyData: null,
		assetData: null,
		importerDraft: null,
		importerMessage: null,
		textureArtifact: null,
		audioArtifact: null,
		videoArtifact: null,
		fontArtifact: null,
		materialArtifact: null,
		modelArtifact: null,
		animationArtifact: null,
		error: null,
		loading: true,
	};

	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: any): object is FileInspectorObject {
		return object?.isFileInspectorObject;
	}

	public constructor(props: IEditorInspectorImplementationProps<FileInspectorObject>) {
		super(props);

		this._extension = extname(props.object.absolutePath).toLowerCase();
	}

	public componentDidMount(): void {
		void this._loadDependencies();
	}

	public render(): ReactNode {
		return (
			<div className="flex flex-col gap-3">
				{this._getSpecializedInspector()}
				{this._getAssetMetadataInspector()}
				{this._getImporterInspector()}
				{this._getDependencyInspector()}
			</div>
		);
	}

	private _getImporterInspector(): ReactNode {
		const importer = this.state.assetData?.importer;
		const draft = this.state.importerDraft;
		if (!importer || !draft) {
			return null;
		}
		const definition = listAssetImporterDefinitions().find((candidate) => candidate.kind === importer.kind)!;
		return (
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="font-semibold">{definition.label}</div>
				<div className="text-xs text-muted-foreground">
					Version {importer.version} · {definition.extensions.length ? `.${definition.extensions.join(", .")}` : "custom extensions"}
				</div>
				{definition.fields
					.filter((field) => field.key !== "animationClips" && field.key !== "materialRemaps" && field.key !== "generatedLods")
					.map((field) => (
						<label key={field.key} className="grid grid-cols-[1fr_140px] gap-2 items-center" title={field.description}>
							<span>{field.label}</span>
							{field.type === "boolean" ? (
								<input type="checkbox" checked={draft[field.key] === true} onChange={(event) => this._setImporterDraftValue(field.key, event.target.checked)} />
							) : field.type === "enum" ? (
								<select
									className="h-8 rounded border border-border bg-input px-2"
									value={String(draft[field.key])}
									onChange={(event) => this._setImporterDraftValue(field.key, event.target.value)}
								>
									{field.values?.map((value) => (
										<option key={value} value={value}>
											{value}
										</option>
									))}
								</select>
							) : field.key === "exposedTransforms" ? (
								<textarea
									className="min-h-20 rounded border border-border bg-input px-2 py-1 font-mono text-xs"
									value={String(draft[field.key])}
									placeholder={"Armature/Hips/RightHand\nArmature/Hips/Head/WeaponSocket"}
									onChange={(event) => this._setImporterDraftValue(field.key, event.target.value)}
								/>
							) : (
								<input
									type={field.type === "number" ? "number" : "text"}
									className="h-8 rounded border border-border bg-input px-2"
									value={String(draft[field.key])}
									min={field.minimum}
									max={field.maximum}
									step={field.step}
									onChange={(event) => this._setImporterDraftValue(field.key, field.type === "number" ? Number(event.target.value) : event.target.value)}
								/>
							)}
						</label>
					))}
				{this.state.importerMessage && <div className="text-xs text-muted-foreground break-all">{this.state.importerMessage}</div>}
				<div className="flex gap-2">
					<Button variant="outline" className="h-7 px-2" onClick={() => this._resetImporterDefaults()}>
						Reset Defaults
					</Button>
					<Button className="h-7 px-2" onClick={() => void this._applyImporterSettings()}>
						Apply Importer
					</Button>
				</div>
			</div>
		);
	}

	private _getAssetMetadataInspector(): ReactNode {
		const data = this.state.assetData;
		return (
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Asset Organization & Import</div>
					<Button variant="outline" className="h-7 px-2" disabled={this.state.loading} onClick={() => void this._refreshImportState()}>
						Check Source
					</Button>
				</div>
				{data && (
					<>
						<div>
							Import status:{" "}
							<span className={["stale", "missing", "error"].includes(data.importState.status) ? "text-red-400" : "text-muted-foreground"}>
								{data.importState.status}
							</span>
						</div>
						{data.importState.checkedAt && <div className="text-xs text-muted-foreground">Checked: {data.importState.checkedAt}</div>}
						{data.importState.error && <div className="text-xs text-red-400 break-all">{data.importState.error.message}</div>}
						<div className="text-xs break-all">Tags: {data.tags.length ? data.tags.join(", ") : "None"}</div>
						<div className="flex gap-2 flex-wrap">
							<Button variant="outline" className="h-7 px-2" onClick={() => void this._toggleFavorite()}>
								{data.favorite ? "★ Favorite" : "☆ Add Favorite"}
							</Button>
							<Button variant="outline" className="h-7 px-2" onClick={() => void this._editTags()}>
								Edit Tags
							</Button>
						</div>
					</>
				)}
			</div>
		);
	}

	private _getSpecializedInspector(): ReactNode {
		switch (this._extension) {
			case ".png":
			case ".webp":
			case ".jpg":
			case ".bmp":
			case ".jpeg":
			case ".gif":
			case ".tif":
			case ".tiff":
			case ".svg":
				return (
					<EditorInspectorImageComponent
						object={this.props.object}
						importedPath={this.state.textureArtifact?.artifactPath}
						importedCurrent={this.state.textureArtifact?.current}
						result={this.state.textureArtifact?.result}
					/>
				);

			case ".md":
				return <EditorInspectorMarkdownComponent object={this.props.object} />;

			case ".mp3":
			case ".wav":
			case ".wave":
			case ".ogg":
			case ".flac":
			case ".m4a":
				return (
					<EditorInspectorSoundComponent
						object={this.props.object}
						importedPath={this.state.audioArtifact?.artifactPath}
						importedCurrent={this.state.audioArtifact?.current}
					/>
				);

			case ".mp4":
			case ".webm":
			case ".ogv":
			case ".mov":
				return (
					<EditorInspectorVideoComponent
						object={this.props.object}
						importedPath={this.state.videoArtifact?.artifactPath}
						importedCurrent={this.state.videoArtifact?.current}
					/>
				);

			case ".ttf":
			case ".otf":
			case ".woff":
			case ".woff2":
				return <EditorInspectorFontComponent object={this.props.object} artifact={this.state.fontArtifact} />;

			case ".material":
			case ".mtl":
				return <EditorInspectorMaterialComponent object={this.props.object} artifact={this.state.materialArtifact} />;

			case ".glb":
			case ".gltf":
			case ".babylon":
			case ".fbx":
			case ".obj":
			case ".stl":
			case ".dae":
			case ".3ds":
				return (
					<EditorInspectorModelComponent
						artifact={this.state.modelArtifact}
						settings={this.state.importerDraft}
						onAnimationClipsChange={(value) => this._setImporterDraftValue("animationClips", value)}
						onMaterialRemapsChange={(value) => this._setImporterDraftValue("materialRemaps", value)}
						onAuthoredLodsChange={(value) => this._setImporterDraftValue("authoredLods", value)}
						onGeneratedLodsChange={(value) => this._setImporterDraftValue("generatedLods", value)}
						onPlatformOverridesChange={(value) => this._setImporterDraftValue("platformOverrides", value)}
						onExtractMaterials={() => this._extractModelMaterials()}
						onExtractTextures={() => this._extractModelTextures()}
					/>
				);

			case ".animation":
			case ".animations":
			case ".animator":
			case ".controller":
				return (
					<EditorInspectorAnimationComponent
						object={this.props.object}
						artifact={this.state.animationArtifact}
						animationGroups={this.props.editor.layout.preview.scene.animationGroups.map((group) => group.name).sort()}
						avatarMasks={((this.props.editor.layout.preview.scene.metadata?.babylonEditorHumanoidAvatarMasks ?? []) as Array<{ id: string; name: string }>).map(
							(mask) => ({ id: mask.id, name: mask.name })
						)}
						onImportController={(motionBindings, avatarMaskBindings, ignoreUnresolvedAvatarMasks, replaceExisting) =>
							this._importAnimatorController(motionBindings, avatarMaskBindings, ignoreUnresolvedAvatarMasks, replaceExisting)
						}
					/>
				);

			default:
				return <div className="text-lg font-semibold break-all">{basename(this.props.object.absolutePath)}</div>;
		}
	}

	private async _extractModelMaterials(): Promise<string> {
		const root = dirname(projectConfiguration.path!);
		const defaultFolder = relative(root, join(dirname(this.props.object.absolutePath), "Materials")).replace(/\\/g, "/");
		const destinationFolder = await showPrompt("Extract Model Materials", "Project-relative destination folder", defaultFolder);
		if (destinationFolder === null) {
			return "Material extraction cancelled.";
		}
		const { extractModelMaterials, inspectModelMaterialExtraction } = await import("../../../mcp/assets/assets");
		const plan = await inspectModelMaterialExtraction(this.props.editor.layout.preview.scene, {
			path: this.props.object.absolutePath,
			destinationFolder,
		});
		if (plan.conflictCount) {
			throw new Error(`${plan.conflictCount} destination material asset(s) conflict. Choose another folder; existing files are never overwritten.`);
		}
		const result = await extractModelMaterials(
			this.props.editor.layout.preview.scene,
			{
				path: this.props.object.absolutePath,
				destinationFolder,
				expectedFingerprint: plan.fingerprint,
				confirm: true,
			},
			{ editor: this.props.editor }
		);
		await this._loadDependencies();
		this.props.editor.layout.assets.refresh();
		return `Extracted ${result.created.length} and reused ${result.reused.length} editable material asset(s); ${result.remaps.length} exact remap(s) persisted.`;
	}

	private async _extractModelTextures(): Promise<string> {
		const root = dirname(projectConfiguration.path!);
		const defaultFolder = relative(root, join(dirname(this.props.object.absolutePath), "Textures")).replace(/\\/g, "/");
		const destinationFolder = await showPrompt("Extract Model Textures", "Project-relative destination folder", defaultFolder);
		if (destinationFolder === null) {
			return "Texture extraction cancelled.";
		}
		const { extractModelTextures, inspectModelTextureExtraction } = await import("../../../mcp/assets/assets");
		const plan = await inspectModelTextureExtraction(this.props.editor.layout.preview.scene, { path: this.props.object.absolutePath, destinationFolder });
		if (plan.conflictCount) {
			throw new Error(`${plan.conflictCount} destination texture asset(s) conflict. Choose another folder; existing textures are never overwritten.`);
		}
		const result = await extractModelTextures(
			this.props.editor.layout.preview.scene,
			{ path: this.props.object.absolutePath, destinationFolder, expectedFingerprint: plan.fingerprint, confirm: true },
			{ editor: this.props.editor }
		);
		await this._loadDependencies();
		this.props.editor.layout.assets.refresh();
		return `Extracted ${result.created.length} and reused ${result.reused.length} texture asset(s); rewrote ${result.rewrittenMaterials.length} material(s).`;
	}

	private async _importAnimatorController(
		motionBindings: Record<string, string>,
		avatarMaskBindings: Record<string, string>,
		ignoreUnresolvedAvatarMasks: boolean,
		replaceExisting: boolean
	): Promise<string> {
		const artifact = this.state.animationArtifact;
		if (!artifact?.current || !artifact.result) {
			throw new Error("Apply the current Animation Importer artifact first.");
		}
		const { importAnimatorControllerAsset } = await import("../../../mcp/assets/assets");
		const result = await importAnimatorControllerAsset(
			this.props.editor.layout.preview.scene,
			{
				path: this.props.object.absolutePath,
				expectedFingerprint: artifact.fingerprint,
				motionBindings,
				avatarMaskBindings,
				ignoreUnresolvedAvatarMasks,
				replaceExisting,
				confirm: true,
			},
			{ editor: this.props.editor }
		);
		return `${result.replaced ? "Replaced" : "Imported"} Animator controller "${result.controller.name}" with ${Object.keys(result.motionBindings).length} Motion binding(s).`;
	}

	private _getDependencyInspector(): ReactNode {
		const data = this.state.dependencyData;
		return (
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Asset Dependencies</div>
					<div className="flex gap-1">
						<Button variant="outline" className="h-7 px-2" onClick={() => openAssetDependencyGraph(this.props.editor, this.props.object.absolutePath)}>
							Graph
						</Button>
						<Button variant="outline" className="h-7 px-2" disabled={this.state.loading} onClick={() => void this._refreshDependencies()}>
							{this.state.loading ? "Indexing…" : "Refresh"}
						</Button>
					</div>
				</div>
				{this.state.error && <div className="text-red-400 break-all">{this.state.error}</div>}
				{data && (
					<>
						<div className="text-xs text-muted-foreground break-all">GUID: {data.guid}</div>
						<div className="text-xs text-muted-foreground">
							Type: {data.type} · Scan: {data.dependencyScanKind} ({data.dependencyScanStatus})
						</div>
						{data.dependencyScanMessage && (
							<div className={data.dependencyScanStatus === "malformed" ? "text-xs text-red-400" : "text-xs text-amber-300"}>{data.dependencyScanMessage}</div>
						)}
						{this._getPathList("Dependencies", data.dependencies, false)}
						{this._getPathList("Missing References", data.missingDependencies, true)}
						{this._getPathList("Referenced By", data.referencedBy, false)}
						{data.containerEntryCount > 0 && (
							<div className="flex flex-col gap-1 border-t border-border pt-2">
								<div className="font-medium">
									Archive Contents ({data.containerEntryCount}) · {data.containerDependencyCount} references · {data.containerMissingDependencyCount} missing
								</div>
								{data.containerEntries.slice(0, 50).map((entry) => (
									<div key={entry.path} className="text-xs break-all text-cyan-300">
										{entry.path} · {entry.type} · {entry.sizeBytes.toLocaleString()} bytes
									</div>
								))}
								{data.containerEntryCount > 50 && <div className="text-xs text-muted-foreground">…and {data.containerEntryCount - 50} more members</div>}
								{data.containerDependencies
									.filter((dependency) => dependency.missing)
									.slice(0, 50)
									.map((dependency) => (
										<div key={`${dependency.sourcePath}\0${dependency.targetPath}`} className="text-xs break-all text-red-400">
											{dependency.sourcePath} → {dependency.targetPath} {dependency.external ? "(project)" : "(inside archive)"}
										</div>
									))}
							</div>
						)}
					</>
				)}
			</div>
		);
	}

	private _getPathList(title: string, paths: string[], missing: boolean): ReactNode {
		return (
			<div className="flex flex-col gap-1">
				<div className="font-medium">
					{title} ({paths.length})
				</div>
				{paths.length === 0 && <div className="text-xs text-muted-foreground">None</div>}
				{paths.slice(0, 50).map((path) => (
					<button
						key={path}
						disabled={missing}
						className={`text-left text-xs break-all ${missing ? "text-red-400 cursor-default" : "text-blue-400 hover:underline"}`}
						onClick={() => this.props.editor.layout.inspector.setEditedObject(new FileInspectorObject(join(dirname(projectConfiguration.path!), path)))}
					>
						{path}
					</button>
				))}
				{paths.length > 50 && <div className="text-xs text-muted-foreground">…and {paths.length - 50} more</div>}
			</div>
		);
	}

	private async _loadDependencies(): Promise<void> {
		this.setState({ loading: true, error: null });
		try {
			const [dependencyData, assetData] = await Promise.all([
				getIndexedAssetDependencies(this.props.object.absolutePath),
				getIndexedAssetRecord(this.props.object.absolutePath),
			]);
			const textureArtifact =
				assetData.importer.kind === "texture" && [".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff", ".svg"].includes(this._extension)
					? await getTextureImporterArtifactStatus(this.props.object.absolutePath)
					: null;
			const audioArtifact = assetData.importer.kind === "audio" ? await getAudioImporterArtifactStatus(this.props.object.absolutePath) : null;
			const videoArtifact = assetData.importer.kind === "video" ? await getVideoImporterArtifactStatus(this.props.object.absolutePath) : null;
			const fontArtifact = assetData.importer.kind === "font" ? await getFontImporterArtifactStatus(this.props.object.absolutePath) : null;
			const materialArtifact = assetData.importer.kind === "material" ? await getMaterialImporterArtifactStatus(this.props.object.absolutePath) : null;
			const modelArtifact = assetData.importer.kind === "model" ? await getModelImporterArtifactStatus(this.props.object.absolutePath) : null;
			const animationArtifact = assetData.importer.kind === "animation" ? await getAnimationImporterArtifactStatus(this.props.object.absolutePath) : null;
			this.setState({
				dependencyData,
				assetData,
				importerDraft: { ...assetData.importer.settings },
				importerMessage: null,
				textureArtifact,
				audioArtifact,
				videoArtifact,
				fontArtifact,
				materialArtifact,
				modelArtifact,
				animationArtifact,
				loading: false,
			});
		} catch (error) {
			this.setState({
				dependencyData: null,
				assetData: null,
				importerDraft: null,
				textureArtifact: null,
				audioArtifact: null,
				videoArtifact: null,
				fontArtifact: null,
				materialArtifact: null,
				modelArtifact: null,
				animationArtifact: null,
				error: error instanceof Error ? error.message : String(error),
				loading: false,
			});
		}
	}

	private _setImporterDraftValue(key: string, value: boolean | number | string): void {
		this.setState({ importerDraft: { ...this.state.importerDraft!, [key]: value }, importerMessage: null });
	}

	private _resetImporterDefaults(): void {
		const importer = getDefaultAssetImporterConfiguration(this.props.object.absolutePath);
		this.setState({ importerDraft: { ...importer.settings }, importerMessage: "Defaults loaded. Apply to persist them." });
	}

	private async _applyImporterSettings(): Promise<void> {
		try {
			const metadata = await readAssetMetadata(this.props.object.absolutePath);
			metadata.importer = validateAssetImporterConfiguration(this.props.object.absolutePath, { ...metadata.importer, settings: this.state.importerDraft }).configuration;
			await writeAssetMetadata(this.props.object.absolutePath, metadata);
			await refreshAssetRegistryPaths([this.props.object.absolutePath]);
			let importerMessage = "Importer settings saved. Build cache will refresh for this asset.";
			if (metadata.importer.kind === "texture" && [".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff", ".svg"].includes(this._extension)) {
				const planned = await getTextureImporterArtifactStatus(this.props.object.absolutePath);
				const applied = await applyTextureImporterArtifact(this.props.object.absolutePath, planned.fingerprint);
				importerMessage = `Texture importer applied: ${applied.result?.output.width ?? "?"}×${applied.result?.output.height ?? "?"} ${applied.result?.output.format ?? "unknown"}, ${applied.result?.effectiveColorSpace ?? "unknown"}, ${applied.result?.mipmaps.length ?? 0} mip level(s).`;
			} else if (metadata.importer.kind === "audio") {
				const planned = await getAudioImporterArtifactStatus(this.props.object.absolutePath);
				const applied = await applyAudioImporterArtifact(this.props.object.absolutePath, planned.fingerprint, this.props.editor);
				importerMessage = `Audio importer applied: ${applied.result?.output.codec ?? "unknown codec"}, ${applied.result?.output.sampleRate ?? "unknown"} Hz, ${applied.result?.output.channels ?? "unknown"} channel(s).`;
			} else if (metadata.importer.kind === "video") {
				const planned = await getVideoImporterArtifactStatus(this.props.object.absolutePath);
				const applied = await applyVideoImporterArtifact(this.props.object.absolutePath, planned.fingerprint, this.props.editor);
				importerMessage = `Video importer applied: ${applied.result?.output.videoCodec ?? "unknown codec"}, ${applied.result?.output.width ?? "?"}×${applied.result?.output.height ?? "?"}.`;
			} else if (metadata.importer.kind === "font") {
				const planned = await getFontImporterArtifactStatus(this.props.object.absolutePath);
				const applied = await applyFontImporterArtifact(this.props.object.absolutePath, planned.fingerprint);
				importerMessage = `Font importer applied: ${applied.result?.renderMode ?? "unknown mode"}, ${applied.result?.glyphCount ?? 0} glyph(s), ${applied.result?.pages.length ?? 0} page(s).`;
			} else if (metadata.importer.kind === "material") {
				const planned = await getMaterialImporterArtifactStatus(this.props.object.absolutePath);
				const applied = await applyMaterialImporterArtifact(this.props.object.absolutePath, planned.fingerprint);
				importerMessage = `Material importer applied: ${applied.result?.valid ? "valid" : "errors"}, ${applied.result?.textureReferences.length ?? 0} texture reference(s), ${applied.result?.extractedTextures.length ?? 0} extracted.`;
			} else if (metadata.importer.kind === "model") {
				const planned = await getModelImporterArtifactStatus(this.props.object.absolutePath);
				const applied = await applyModelImporterArtifact(this.props.object.absolutePath, planned.fingerprint);
				importerMessage = `Model importer applied: ${applied.result?.valid ? "valid" : applied.result?.supported ? "errors" : "legacy format unsupported headlessly"}, ${applied.result?.meshCount ?? 0} mesh(es), ${applied.result?.triangleCount ?? 0} triangle(s).`;
			} else if (metadata.importer.kind === "animation") {
				const planned = await getAnimationImporterArtifactStatus(this.props.object.absolutePath);
				const applied = await applyAnimationImporterArtifact(this.props.object.absolutePath, planned.fingerprint);
				importerMessage = `Animation importer applied: ${applied.result?.valid ? "valid" : "errors"}, ${applied.result?.clips.length ?? 0} clip(s), ${applied.result?.tracks.length ?? 0} track(s), ${applied.result?.outputKeyCount ?? 0} output key(s).`;
			}
			await this._loadDependencies();
			this.setState({ importerMessage });
			this.props.editor.layout.assets.refresh();
		} catch (error) {
			this.setState({ importerMessage: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _toggleFavorite(): Promise<void> {
		const metadata = await readAssetMetadata(this.props.object.absolutePath);
		await writeAssetMetadata(this.props.object.absolutePath, { ...metadata, favorite: !metadata.favorite });
		await refreshAssetRegistryPaths([this.props.object.absolutePath]);
		await this._loadDependencies();
		this.props.editor.layout.assets.refresh();
	}

	private async _editTags(): Promise<void> {
		const metadata = await readAssetMetadata(this.props.object.absolutePath);
		const value = await showPrompt("Asset Tags", "Enter comma-separated project tags. Tags are separate from labels.", metadata.tags.join(", "));
		if (value === null) {
			return;
		}
		await writeAssetMetadata(this.props.object.absolutePath, {
			...metadata,
			tags: value
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
		});
		await refreshAssetRegistryPaths([this.props.object.absolutePath]);
		await this._loadDependencies();
		this.props.editor.layout.assets.refresh();
	}

	private async _refreshImportState(): Promise<void> {
		this.setState({ loading: true, error: null });
		try {
			const metadata = await readAssetMetadata(this.props.object.absolutePath);
			metadata.importState = await inspectAssetImportState(metadata);
			await writeAssetMetadata(this.props.object.absolutePath, metadata);
			await refreshAssetRegistryPaths([this.props.object.absolutePath]);
			await this._loadDependencies();
			this.props.editor.layout.assets.refresh();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error), loading: false });
		}
	}

	private async _refreshDependencies(): Promise<void> {
		this.setState({ loading: true, error: null });
		try {
			await refreshAssetRegistryPaths([this.props.object.absolutePath]);
			await this._loadDependencies();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error), loading: false });
		}
	}
}
