import { ReactNode, useState } from "react";
import {
	IModelAnimationClipDefinition,
	IModelAuthoredLodGroupDefinition,
	IModelLodDefinition,
	IModelMaterialRemapDefinition,
	IModelImporterPlatformOverride,
	IModelImporterPlatformOverrides,
	ModelImporterOverridePlatform,
	normalizeModelAnimationClipDefinitions,
	normalizeModelAuthoredLodGroups,
	normalizeModelLodDefinitions,
	normalizeModelMaterialRemaps,
	normalizeModelImporterPlatformOverrides,
	normalizeModelImporterSettings,
	serializeModelAnimationClipDefinitions,
	serializeModelAuthoredLodGroups,
	serializeModelLodDefinitions,
	serializeModelMaterialRemaps,
	serializeModelImporterPlatformOverrides,
	suggestModelAuthoredLodGroups,
} from "babylonjs-editor-tools";

import { IModelImporterArtifactStatus } from "../../../../mcp/assets/model-importer";
import { Button } from "../../../../ui/shadcn/ui/button";

export interface IEditorInspectorModelComponentProps {
	artifact: IModelImporterArtifactStatus | null;
	settings: Record<string, boolean | number | string> | null;
	onAnimationClipsChange: (value: string) => void;
	onMaterialRemapsChange: (value: string) => void;
	onAuthoredLodsChange: (value: string) => void;
	onGeneratedLodsChange: (value: string) => void;
	onPlatformOverridesChange: (value: string) => void;
	onExtractMaterials: () => Promise<string>;
	onExtractTextures: () => Promise<string>;
}

function metric(label: string, value: string | number): ReactNode {
	return (
		<div className="flex justify-between gap-3">
			<span className="text-muted-foreground">{label}</span>
			<span>{typeof value === "number" ? value.toLocaleString() : value}</span>
		</div>
	);
}

function parseDefinitions(value: unknown): { definitions: IModelAnimationClipDefinition[]; error: string | null } {
	try {
		return { definitions: normalizeModelAnimationClipDefinitions(value), error: null };
	} catch (error) {
		return { definitions: [], error: error instanceof Error ? error.message : String(error) };
	}
}

function parseMaterialRemaps(value: unknown): { definitions: IModelMaterialRemapDefinition[]; error: string | null } {
	try {
		return { definitions: normalizeModelMaterialRemaps(value), error: null };
	} catch (error) {
		return { definitions: [], error: error instanceof Error ? error.message : String(error) };
	}
}

function parseGeneratedLods(value: unknown): { definitions: IModelLodDefinition[]; error: string | null } {
	try {
		return { definitions: normalizeModelLodDefinitions(value), error: null };
	} catch (error) {
		return { definitions: [], error: error instanceof Error ? error.message : String(error) };
	}
}

function parseAuthoredLods(value: unknown): { definitions: IModelAuthoredLodGroupDefinition[]; error: string | null } {
	try {
		return { definitions: normalizeModelAuthoredLodGroups(value), error: null };
	} catch (error) {
		return { definitions: [], error: error instanceof Error ? error.message : String(error) };
	}
}

function parsePlatformOverrides(value: unknown): { overrides: IModelImporterPlatformOverrides; error: string | null } {
	try {
		return { overrides: normalizeModelImporterPlatformOverrides(value), error: null };
	} catch (error) {
		return { overrides: {}, error: error instanceof Error ? error.message : String(error) };
	}
}

export function EditorInspectorModelComponent({
	artifact,
	settings,
	onAnimationClipsChange,
	onMaterialRemapsChange,
	onAuthoredLodsChange,
	onGeneratedLodsChange,
	onPlatformOverridesChange,
	onExtractMaterials,
	onExtractTextures,
}: IEditorInspectorModelComponentProps): ReactNode {
	const [extractingMaterials, setExtractingMaterials] = useState(false);
	const [materialExtractionMessage, setMaterialExtractionMessage] = useState<string | null>(null);
	const [extractingTextures, setExtractingTextures] = useState(false);
	const [textureExtractionMessage, setTextureExtractionMessage] = useState<string | null>(null);
	const result = artifact?.result;
	const parsed = parseDefinitions(settings?.animationClips);
	const parsedRemaps = parseMaterialRemaps(settings?.materialRemaps);
	const parsedAuthoredLods = parseAuthoredLods(settings?.authoredLods);
	const parsedLods = parseGeneratedLods(settings?.generatedLods);
	const parsedPlatformOverrides = parsePlatformOverrides(settings?.platformOverrides);
	// Parsed fallbacks keep malformed legacy JSON visible as an inline error instead of crashing the complete Inspector render.
	const baseSettings = normalizeModelImporterSettings({
		...(settings ?? {}),
		animationClips: parsed.definitions,
		materialRemaps: parsedRemaps.definitions,
		authoredLods: parsedAuthoredLods.definitions,
		generatedLods: parsedLods.definitions,
		platformOverrides: parsedPlatformOverrides.overrides,
	});
	const sourceGroups = result?.sourceAnimationGroups ?? [];
	const sourceMaterials = result?.sourceMaterials ?? [];
	const meshNames = [...new Set((result?.meshes ?? []).map((mesh) => mesh.name))].sort((a, b) => a.localeCompare(b));
	const suggestedAuthoredLods = suggestModelAuthoredLodGroups(meshNames);
	const updateMaterialRemaps = (definitions: IModelMaterialRemapDefinition[]): void => onMaterialRemapsChange(serializeModelMaterialRemaps(definitions));
	const updateMaterialRemap = (index: number, patch: Partial<IModelMaterialRemapDefinition>): void =>
		updateMaterialRemaps(parsedRemaps.definitions.map((definition, definitionIndex) => (definitionIndex === index ? { ...definition, ...patch } : definition)));
	const commitMaterialRemapInput = (index: number, patch: Partial<IModelMaterialRemapDefinition>, input: HTMLInputElement): void => {
		try {
			updateMaterialRemap(index, patch);
			input.setCustomValidity("");
		} catch (error) {
			input.setCustomValidity(error instanceof Error ? error.message : String(error));
			input.reportValidity();
		}
	};
	const addMaterialRemap = (): void => {
		const source = sourceMaterials.find((material) => !parsedRemaps.definitions.some((definition) => definition.sourceMaterial === material.name));
		updateMaterialRemaps([
			...parsedRemaps.definitions,
			{ sourceMaterial: source?.name ?? `Source Material ${parsedRemaps.definitions.length + 1}`, materialPath: "assets/replacement.material" },
		]);
	};
	const updateAuthoredLods = (definitions: IModelAuthoredLodGroupDefinition[]): void => onAuthoredLodsChange(serializeModelAuthoredLodGroups(definitions));
	const assignedAuthoredMeshes = new Set(parsedAuthoredLods.definitions.flatMap((group) => [group.sourceMesh, ...group.levels.map((level) => level.mesh)]));
	const availableAuthoredMeshes = (current?: string): string[] => meshNames.filter((name) => name === current || !assignedAuthoredMeshes.has(name));
	const addAuthoredLodGroup = (): void => {
		const available = availableAuthoredMeshes();
		if (available.length >= 2) {
			updateAuthoredLods([...parsedAuthoredLods.definitions, { sourceMesh: available[0], levels: [{ mesh: available[1], distance: 500 }] }]);
		}
	};
	const updateAuthoredLodGroup = (index: number, definition: IModelAuthoredLodGroupDefinition): void =>
		updateAuthoredLods(parsedAuthoredLods.definitions.map((group, groupIndex) => (groupIndex === index ? definition : group)));
	const commitAuthoredLodGroup = (index: number, definition: IModelAuthoredLodGroupDefinition, input: HTMLInputElement | HTMLSelectElement): void => {
		try {
			updateAuthoredLodGroup(index, definition);
			input.setCustomValidity("");
		} catch (error) {
			input.setCustomValidity(error instanceof Error ? error.message : String(error));
			input.reportValidity();
		}
	};
	const addAuthoredLodLevel = (groupIndex: number): void => {
		const group = parsedAuthoredLods.definitions[groupIndex];
		const mesh = availableAuthoredMeshes()[0];
		if (group && mesh && group.levels.length < 8) {
			updateAuthoredLodGroup(groupIndex, {
				...group,
				levels: [...group.levels, { mesh, distance: (group.levels.at(-1)?.distance ?? 0) + 500 }],
			});
		}
	};
	const updateGeneratedLods = (definitions: IModelLodDefinition[]): void => onGeneratedLodsChange(serializeModelLodDefinitions(definitions));
	const commitGeneratedLodInput = (index: number, patch: Partial<IModelLodDefinition>, input: HTMLInputElement): void => {
		try {
			updateGeneratedLods(parsedLods.definitions.map((definition, definitionIndex) => (definitionIndex === index ? { ...definition, ...patch } : definition)));
			input.setCustomValidity("");
		} catch (error) {
			input.setCustomValidity(error instanceof Error ? error.message : String(error));
			input.reportValidity();
		}
	};
	const addGeneratedLod = (): void => {
		const previous = parsedLods.definitions.at(-1);
		updateGeneratedLods([
			...parsedLods.definitions,
			{ quality: previous ? Math.max(0.01, Number((previous.quality * 0.5).toFixed(3))) : 0.5, distance: previous ? previous.distance + 500 : 500 },
		]);
	};
	const updateDefinitions = (definitions: IModelAnimationClipDefinition[]): void => onAnimationClipsChange(serializeModelAnimationClipDefinitions(definitions));
	const updateDefinition = (index: number, patch: Partial<IModelAnimationClipDefinition>): void =>
		updateDefinitions(parsed.definitions.map((definition, definitionIndex) => (definitionIndex === index ? { ...definition, ...patch } : definition)));
	const addDefinition = (): void => {
		const source = sourceGroups[0];
		const index = parsed.definitions.length + 1;
		updateDefinitions([
			...parsed.definitions,
			{
				name: source ? `${source.name} Clip ${index}` : `Clip ${index}`,
				sourceAnimationGroup: source?.name ?? "",
				from: source?.from ?? 0,
				to: source?.to ?? 1,
				loopTime: false,
				loopPose: false,
				rootMotionNode: "",
				rootMotionPosition: "none",
				rootMotionRotationY: false,
				targetMask: [],
			},
		]);
	};
	const overrideFromBase = (): IModelImporterPlatformOverride => ({
		enabled: true,
		scaleFactor: baseSettings.scaleFactor,
		convertUnits: baseSettings.convertUnits,
		importMaterials: baseSettings.importMaterials,
		generatedLods: structuredClone(baseSettings.generatedLods),
		importTextures: baseSettings.importTextures,
		importAnimations: baseSettings.importAnimations,
		animationType: baseSettings.animationType,
		optimizeGameObjects: baseSettings.optimizeGameObjects,
		generateColliders: baseSettings.generateColliders,
		meshCompression: baseSettings.meshCompression,
		optimizeMesh: baseSettings.optimizeMesh,
		weldVertices: baseSettings.weldVertices,
		normals: baseSettings.normals,
		tangents: baseSettings.tangents,
	});
	const updatePlatformOverrides = (overrides: IModelImporterPlatformOverrides): void => onPlatformOverridesChange(serializeModelImporterPlatformOverrides(overrides));
	const updatePlatformOverride = (platform: ModelImporterOverridePlatform, patch: Partial<IModelImporterPlatformOverride>): void => {
		const current = parsedPlatformOverrides.overrides[platform] ?? overrideFromBase();
		updatePlatformOverrides({ ...parsedPlatformOverrides.overrides, [platform]: { ...current, ...patch } });
	};
	const removePlatformOverride = (platform: ModelImporterOverridePlatform): void => {
		const overrides = { ...parsedPlatformOverrides.overrides };
		delete overrides[platform];
		updatePlatformOverrides(overrides);
	};
	const updatePlatformLods = (platform: ModelImporterOverridePlatform, generatedLods: IModelLodDefinition[]): void =>
		updatePlatformOverride(platform, { generatedLods: normalizeModelLodDefinitions(generatedLods) });
	const commitPlatformValue = (platform: ModelImporterOverridePlatform, patch: Partial<IModelImporterPlatformOverride>, input: HTMLInputElement): void => {
		try {
			updatePlatformOverride(platform, patch);
			input.setCustomValidity("");
		} catch (error) {
			input.setCustomValidity(error instanceof Error ? error.message : String(error));
			input.reportValidity();
		}
	};
	const commitPlatformLods = (platform: ModelImporterOverridePlatform, generatedLods: IModelLodDefinition[], input: HTMLInputElement): void => {
		try {
			updatePlatformLods(platform, generatedLods);
			input.setCustomValidity("");
		} catch (error) {
			input.setCustomValidity(error instanceof Error ? error.message : String(error));
			input.reportValidity();
		}
	};
	const renderPlatformOverride = (platform: ModelImporterOverridePlatform): ReactNode => {
		const override = parsedPlatformOverrides.overrides[platform];
		const effective = override ?? { ...overrideFromBase(), enabled: false };
		const disabled = !override?.enabled;
		const label = platform === "web" ? "Web" : "Desktop / Electron";
		const platformLods = effective.generatedLods ?? baseSettings.generatedLods;
		return (
			<div className="flex flex-col gap-2 rounded border border-border p-2">
				<div className="flex items-center justify-between gap-2">
					<label className="flex items-center gap-2 font-medium">
						<input type="checkbox" checked={override?.enabled === true} onChange={(event) => updatePlatformOverride(platform, { enabled: event.target.checked })} />
						{label} Override
					</label>
					<Button variant="ghost" className="h-7 px-2" disabled={!override} onClick={() => removePlatformOverride(platform)}>
						Reset
					</Button>
				</div>
				<div className="grid grid-cols-[1fr_150px] items-center gap-2 text-xs">
					<span>Scale Factor</span>
					<input
						type="number"
						className="h-8 rounded border border-border bg-input px-2"
						disabled={disabled}
						min={0.0001}
						max={100000}
						step={0.01}
						defaultValue={effective.scaleFactor ?? baseSettings.scaleFactor}
						onBlur={(event) => commitPlatformValue(platform, { scaleFactor: Number(event.target.value) }, event.currentTarget)}
					/>
					<span>Convert Units</span>
					<input
						type="checkbox"
						disabled={disabled}
						checked={effective.convertUnits ?? baseSettings.convertUnits}
						onChange={(event) => updatePlatformOverride(platform, { convertUnits: event.target.checked })}
					/>
					<span>Import Materials</span>
					<input
						type="checkbox"
						disabled={disabled}
						checked={effective.importMaterials ?? baseSettings.importMaterials}
						onChange={(event) => updatePlatformOverride(platform, { importMaterials: event.target.checked })}
					/>
					<span>Import Textures</span>
					<input
						type="checkbox"
						disabled={disabled}
						checked={effective.importTextures ?? baseSettings.importTextures}
						onChange={(event) => updatePlatformOverride(platform, { importTextures: event.target.checked })}
					/>
					<span>Import Animations</span>
					<input
						type="checkbox"
						disabled={disabled}
						checked={effective.importAnimations ?? baseSettings.importAnimations}
						onChange={(event) => updatePlatformOverride(platform, { importAnimations: event.target.checked })}
					/>
					<span>Animation Type</span>
					<select
						className="h-8 rounded border border-border bg-input px-2"
						disabled={disabled}
						value={effective.animationType ?? baseSettings.animationType}
						onChange={(event) => updatePlatformOverride(platform, { animationType: event.target.value as IModelImporterPlatformOverride["animationType"] })}
					>
						<option value="none">None</option>
						<option value="generic">Generic</option>
						<option value="humanoid">Humanoid</option>
					</select>
					<span>Optimize Game Objects</span>
					<input
						type="checkbox"
						disabled={disabled}
						checked={effective.optimizeGameObjects ?? baseSettings.optimizeGameObjects}
						onChange={(event) => updatePlatformOverride(platform, { optimizeGameObjects: event.target.checked })}
					/>
					<span>Generate Colliders</span>
					<input
						type="checkbox"
						disabled={disabled}
						checked={effective.generateColliders ?? baseSettings.generateColliders}
						onChange={(event) => updatePlatformOverride(platform, { generateColliders: event.target.checked })}
					/>
					<span>Mesh Compression</span>
					<select
						className="h-8 rounded border border-border bg-input px-2"
						disabled={disabled}
						value={effective.meshCompression ?? baseSettings.meshCompression}
						onChange={(event) => updatePlatformOverride(platform, { meshCompression: event.target.value as IModelImporterPlatformOverride["meshCompression"] })}
					>
						<option value="none">None</option>
						<option value="low">Low</option>
						<option value="medium">Medium</option>
						<option value="high">High</option>
					</select>
					<span>Optimize Mesh</span>
					<input
						type="checkbox"
						disabled={disabled}
						checked={effective.optimizeMesh ?? baseSettings.optimizeMesh}
						onChange={(event) => updatePlatformOverride(platform, { optimizeMesh: event.target.checked })}
					/>
					<span>Weld Vertices</span>
					<input
						type="checkbox"
						disabled={disabled}
						checked={effective.weldVertices ?? baseSettings.weldVertices}
						onChange={(event) => updatePlatformOverride(platform, { weldVertices: event.target.checked })}
					/>
					<span>Normals</span>
					<select
						className="h-8 rounded border border-border bg-input px-2"
						disabled={disabled}
						value={effective.normals ?? baseSettings.normals}
						onChange={(event) => updatePlatformOverride(platform, { normals: event.target.value as IModelImporterPlatformOverride["normals"] })}
					>
						<option value="import">Import</option>
						<option value="calculate">Calculate</option>
						<option value="none">None</option>
					</select>
					<span>Tangents</span>
					<select
						className="h-8 rounded border border-border bg-input px-2"
						disabled={disabled}
						value={effective.tangents ?? baseSettings.tangents}
						onChange={(event) => updatePlatformOverride(platform, { tangents: event.target.value as IModelImporterPlatformOverride["tangents"] })}
					>
						<option value="import">Import</option>
						<option value="calculate">Calculate</option>
						<option value="none">None</option>
					</select>
				</div>
				<div className="flex items-center justify-between gap-2 text-xs">
					<span>Target LODs ({platformLods.length})</span>
					<Button
						variant="outline"
						className="h-7 px-2"
						disabled={disabled || platformLods.length >= 8 || (platformLods.at(-1)?.quality ?? 1) <= 0.01}
						onClick={() => {
							const levels = platformLods;
							const previous = levels.at(-1);
							updatePlatformLods(platform, [
								...levels,
								{ quality: previous ? Math.max(0.01, Number((previous.quality * 0.5).toFixed(3))) : 0.5, distance: previous ? previous.distance + 500 : 500 },
							]);
						}}
					>
						Add LOD
					</Button>
				</div>
				{platformLods.map((level, index) => (
					<div key={`${platform}:${index}`} className="grid grid-cols-[45px_1fr_1fr_auto] items-center gap-2 text-xs">
						<span>LOD {index + 1}</span>
						<input
							type="number"
							className="h-8 rounded border border-border bg-input px-2"
							disabled={disabled}
							min={0.01}
							max={0.99}
							step={0.01}
							defaultValue={level.quality}
							onBlur={(event) =>
								commitPlatformLods(
									platform,
									platformLods.map((item, itemIndex) => (itemIndex === index ? { ...item, quality: Number(event.target.value) } : item)),
									event.currentTarget
								)
							}
						/>
						<input
							type="number"
							className="h-8 rounded border border-border bg-input px-2"
							disabled={disabled}
							min={1}
							defaultValue={level.distance}
							onBlur={(event) =>
								commitPlatformLods(
									platform,
									platformLods.map((item, itemIndex) => (itemIndex === index ? { ...item, distance: Number(event.target.value) } : item)),
									event.currentTarget
								)
							}
						/>
						<Button
							variant="ghost"
							className="h-7 px-2 !text-red-400"
							disabled={disabled}
							onClick={() =>
								updatePlatformLods(
									platform,
									platformLods.filter((_item, itemIndex) => itemIndex !== index)
								)
							}
						>
							Remove
						</Button>
					</div>
				))}
			</div>
		);
	};
	return (
		<>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="font-semibold">Platform Model Settings</div>
				<div className="text-xs text-muted-foreground">
					Web build profiles execute Web overrides; Electron profiles execute Desktop overrides. Disabled or reset targets inherit the Default Model Importer settings
					below.
				</div>
				{parsedPlatformOverrides.error && <div className="text-xs text-red-400 break-all">{parsedPlatformOverrides.error}</div>}
				{!parsedPlatformOverrides.error && renderPlatformOverride("web")}
				{!parsedPlatformOverrides.error && renderPlatformOverride("desktop")}
			</div>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Artist-authored Model LODs</div>
					<div className="flex gap-2">
						<Button
							variant="outline"
							className="h-7 px-2"
							disabled={!!parsedAuthoredLods.error || !suggestedAuthoredLods.length}
							onClick={() => updateAuthoredLods(suggestedAuthoredLods)}
						>
							Detect _LOD#
						</Button>
						<Button
							variant="outline"
							className="h-7 px-2"
							disabled={!!parsedAuthoredLods.error || parsedAuthoredLods.definitions.length >= 128 || availableAuthoredMeshes().length < 2}
							onClick={addAuthoredLodGroup}
						>
							Add Group
						</Button>
					</div>
				</div>
				<div className="text-xs text-muted-foreground">
					Assign existing imported meshes as exact LOD0/LOD1/... geometry. Every mesh can appear once; distances use editor centimeters. Detection recognizes conventional
					Name_LOD0, Name_LOD1, and later suffixes without changing the source asset.
				</div>
				{result && result.meshCount > meshNames.length && (
					<div className="text-xs text-amber-300">
						Mesh discovery is limited to the first {meshNames.length.toLocaleString()} reported meshes; configure larger models through exact MCP names.
					</div>
				)}
				{parsedAuthoredLods.error && <div className="text-xs text-red-400 break-all">{parsedAuthoredLods.error}</div>}
				{!parsedAuthoredLods.error && !parsedAuthoredLods.definitions.length && (
					<div className="text-xs text-muted-foreground">
						{meshNames.length ? "No artist-authored groups configured." : "Apply the Model Importer once to discover exact mesh names."}
					</div>
				)}
				{parsedAuthoredLods.definitions.map((group, groupIndex) => (
					<div key={`${group.sourceMesh}:${groupIndex}`} className="flex flex-col gap-2 rounded border border-border p-2">
						<div className="flex items-center gap-2">
							<span className="w-12 font-medium">LOD0</span>
							<select
								className="h-8 min-w-0 flex-1 rounded border border-border bg-input px-2 text-xs"
								value={group.sourceMesh}
								onChange={(event) => commitAuthoredLodGroup(groupIndex, { ...group, sourceMesh: event.target.value }, event.currentTarget)}
							>
								{availableAuthoredMeshes(group.sourceMesh).map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
							<Button
								variant="outline"
								className="h-7 px-2"
								disabled={group.levels.length >= 8 || !availableAuthoredMeshes().length}
								onClick={() => addAuthoredLodLevel(groupIndex)}
							>
								Add Level
							</Button>
							<Button
								variant="ghost"
								className="h-7 px-2 !text-red-400"
								onClick={() => updateAuthoredLods(parsedAuthoredLods.definitions.filter((_candidate, index) => index !== groupIndex))}
							>
								Remove Group
							</Button>
						</div>
						{group.levels.map((level, levelIndex) => (
							<div key={`${level.mesh}:${levelIndex}`} className="grid grid-cols-[48px_1fr_150px_auto] items-center gap-2 text-xs">
								<span>LOD{levelIndex + 1}</span>
								<select
									className="h-8 min-w-0 rounded border border-border bg-input px-2"
									value={level.mesh}
									onChange={(event) =>
										commitAuthoredLodGroup(
											groupIndex,
											{ ...group, levels: group.levels.map((item, index) => (index === levelIndex ? { ...item, mesh: event.target.value } : item)) },
											event.currentTarget
										)
									}
								>
									{availableAuthoredMeshes(level.mesh).map((name) => (
										<option key={name} value={name}>
											{name}
										</option>
									))}
								</select>
								<label className="flex items-center gap-2">
									Distance
									<input
										type="number"
										className="h-8 min-w-0 flex-1 rounded border border-border bg-input px-2"
										min={1}
										max={1_000_000_000}
										defaultValue={level.distance}
										onBlur={(event) =>
											commitAuthoredLodGroup(
												groupIndex,
												{
													...group,
													levels: group.levels.map((item, index) =>
														index === levelIndex ? { ...item, distance: Number(event.currentTarget.value) } : item
													),
												},
												event.currentTarget
											)
										}
									/>
								</label>
								<Button
									variant="ghost"
									className="h-7 px-2 !text-red-400"
									onClick={() => {
										const levels = group.levels.filter((_candidate, index) => index !== levelIndex);
										if (levels.length) {
											updateAuthoredLodGroup(groupIndex, { ...group, levels });
										} else {
											updateAuthoredLods(parsedAuthoredLods.definitions.filter((_candidate, index) => index !== groupIndex));
										}
									}}
								>
									Remove
								</Button>
							</div>
						))}
					</div>
				))}
				{result?.authoredLods?.map((group) => (
					<div key={group.sourceMesh} className="rounded border border-border p-2 text-xs">
						<div className="font-medium">
							{group.sourceMesh} · {group.sourceTriangleCount.toLocaleString()} source triangles
						</div>
						{group.levels.map((level) => (
							<div key={level.level} className="text-muted-foreground">
								LOD {level.level}: {level.mesh} · {level.triangleCount.toLocaleString()} triangles · {level.vertexCount.toLocaleString()} vertices ·{" "}
								{level.distance.toLocaleString()} cm · {level.deformationMode}
							</div>
						))}
					</div>
				))}
			</div>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Generated Model LODs</div>
					<Button variant="outline" className="h-7 px-2" disabled={!!parsedLods.error || parsedLods.definitions.length >= 8} onClick={addGeneratedLod}>
						Add LOD
					</Button>
				</div>
				<div className="text-xs text-muted-foreground">
					Generate deterministic quadratic-error LOD meshes for static, skinned, and morph-target geometry. Exact source-vertex provenance preserves bone weights, morph
					deltas, animation bindings, tangents, colors, and every UV stream. Distances use editor centimeters; quality must decrease as distance increases.
				</div>
				{parsedLods.error && <div className="text-xs text-red-400 break-all">{parsedLods.error}</div>}
				{!parsedLods.error && parsedLods.definitions.length === 0 && (
					<div className="text-xs text-muted-foreground">No generated levels; authored source LODs remain unchanged.</div>
				)}
				{parsedLods.definitions.map((definition, index) => (
					<div key={`${definition.distance}:${index}`} className="grid grid-cols-[70px_1fr_1fr_auto] items-center gap-2 rounded border border-border p-2">
						<div className="font-medium">LOD {index + 1}</div>
						<label className="flex items-center gap-2 text-xs">
							Quality
							<input
								type="number"
								className="h-8 w-full rounded border border-border bg-input px-2"
								min={0.01}
								max={0.99}
								step={0.01}
								defaultValue={definition.quality}
								onBlur={(event) => commitGeneratedLodInput(index, { quality: Number(event.currentTarget.value) }, event.currentTarget)}
							/>
						</label>
						<label className="flex items-center gap-2 text-xs">
							Distance
							<input
								type="number"
								className="h-8 w-full rounded border border-border bg-input px-2"
								min={1}
								max={1_000_000_000}
								step={1}
								defaultValue={definition.distance}
								onBlur={(event) => commitGeneratedLodInput(index, { distance: Number(event.currentTarget.value) }, event.currentTarget)}
							/>
						</label>
						<Button
							variant="ghost"
							className="h-7 px-2 !text-red-400"
							onClick={() => updateGeneratedLods(parsedLods.definitions.filter((_candidate, definitionIndex) => definitionIndex !== index))}
						>
							Remove
						</Button>
					</div>
				))}
				{result?.generatedLods?.map((mesh) => {
					const skinInfluenceStreamCount = mesh.skinInfluenceStreams?.length ?? 0;
					const morphTargetCount = mesh.morphTargetCount ?? 0;
					return (
						<div key={mesh.sourceMesh} className="rounded border border-border p-2 text-xs">
							<div className="font-medium">
								{mesh.sourceMesh} · {mesh.sourceTriangleCount.toLocaleString()} source triangles · {mesh.deformationMode ?? "static (legacy evidence)"}
							</div>
							{(skinInfluenceStreamCount > 0 || morphTargetCount > 0) && (
								<div className="text-muted-foreground">
									{skinInfluenceStreamCount > 0 ? `${skinInfluenceStreamCount} skin stream(s)` : "no skin streams"} · {morphTargetCount} morph target(s)
								</div>
							)}
							{mesh.levels?.map((level) => {
								const provenanceVertexCount = level.provenanceVertexCount ?? level.vertexCount;
								const preservedVertexStreamCount = level.preservedVertexStreams?.length ?? 0;
								return (
									<div key={level.level} className="text-muted-foreground">
										LOD {level.level}: {level.triangleCount.toLocaleString()} triangles · {(level.reduction * 100).toFixed(1)}% reduction ·{" "}
										{level.distance.toLocaleString()} cm · {provenanceVertexCount.toLocaleString()} mapped vertices · {preservedVertexStreamCount} preserved
										stream(s)
										{level.skinInfluenceStreamsPreserved ? " · skin preserved" : ""}
										{level.morphTargetCount
											? ` · ${level.morphTargetCount} morph target(s) · ${level.morphAnimationTrackCount ?? 0} morph animation track(s)`
											: ""}
									</div>
								);
							})}
						</div>
					);
				})}
			</div>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Extract Embedded Textures</div>
					<Button
						variant="outline"
						className="h-7 px-2"
						disabled={extractingTextures}
						onClick={async () => {
							setExtractingTextures(true);
							try {
								setTextureExtractionMessage(await onExtractTextures());
							} catch (error) {
								setTextureExtractionMessage(error instanceof Error ? error.message : String(error));
							} finally {
								setExtractingTextures(false);
							}
						}}
					>
						{extractingTextures ? "Extracting…" : "Extract Textures"}
					</Button>
				</div>
				<div className="text-xs text-muted-foreground">
					After extracting materials, publish embedded PNG/JPEG payloads as editable texture assets and rewrite those materials to project paths.
				</div>
				{textureExtractionMessage && <div className="text-xs break-all">{textureExtractionMessage}</div>}
			</div>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Extract Embedded Materials</div>
					<Button
						variant="outline"
						className="h-7 px-2"
						disabled={extractingMaterials}
						onClick={async () => {
							setExtractingMaterials(true);
							try {
								setMaterialExtractionMessage(await onExtractMaterials());
							} catch (error) {
								setMaterialExtractionMessage(error instanceof Error ? error.message : String(error));
							} finally {
								setExtractingMaterials(false);
							}
						}}
					>
						{extractingMaterials ? "Extracting…" : "Extract Materials"}
					</Button>
				</div>
				<div className="text-xs text-muted-foreground">
					Create editable project .material assets, reuse only byte-equivalent destinations, and wire exact remaps back to this model. Existing files are never
					overwritten.
				</div>
				{materialExtractionMessage && <div className="text-xs break-all">{materialExtractionMessage}</div>}
			</div>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="font-semibold">Automatic Material Search</div>
				<div className="text-xs text-muted-foreground">
					Configure Material Naming and Material Search in the Model Importer below. Explicit remaps always win; equally ranked matches are reported instead of guessed.
				</div>
				{result?.materialSearch ? (
					<>
						{metric("Naming", result.materialSearch.naming)}
						{metric("Search scope", result.materialSearch.search)}
						{metric("Materials searched", result.materialSearch.searchedMaterialCount)}
						{result.materialSearch.matches.map((match) => (
							<div key={match.sourceMaterial} className="rounded border border-border p-2 text-xs">
								<div className="font-medium">
									{match.sourceMaterial} → {match.candidateName}
								</div>
								<div className={match.ambiguous ? "text-amber-300" : match.matched ? "text-green-400" : "text-muted-foreground"}>
									{match.ambiguous
										? `Ambiguous: ${match.candidates.join(", ")}`
										: match.materialPath
											? `Matched ${match.materialPath}`
											: "No matching project material"}
								</div>
							</div>
						))}
					</>
				) : (
					<div className="text-xs text-muted-foreground">Apply the Model Importer to calculate search evidence.</div>
				)}
			</div>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Model Material Remaps</div>
					<Button variant="outline" className="h-7 px-2" disabled={!!parsedRemaps.error || parsedRemaps.definitions.length >= 128} onClick={addMaterialRemap}>
						Add Remap
					</Button>
				</div>
				<div className="text-xs text-muted-foreground">
					Replace exact imported material names with contained project .material assets. Apply once to discover source names and usage counts.
				</div>
				{parsedRemaps.error && <div className="text-xs text-red-400 break-all">{parsedRemaps.error}</div>}
				{!parsedRemaps.error && parsedRemaps.definitions.length === 0 && (
					<div className="text-xs text-muted-foreground">
						No remaps. {sourceMaterials.length ? `${sourceMaterials.length} imported material name(s) available.` : "Apply once to inspect source materials."}
					</div>
				)}
				{parsedRemaps.definitions.map((definition, index) => {
					const evidence = sourceMaterials.find((material) => material.name === definition.sourceMaterial);
					const execution = result?.materialRemaps.find((remap) => remap.sourceMaterial === definition.sourceMaterial);
					return (
						<div key={`${definition.sourceMaterial}:${index}`} className="flex flex-col gap-2 rounded border border-border p-2">
							<div className="grid grid-cols-[1fr_170px] items-center gap-2">
								<span>Source Material</span>
								{sourceMaterials.length ? (
									<select
										className="h-8 rounded border border-border bg-input px-2"
										value={definition.sourceMaterial}
										onChange={(event) => updateMaterialRemap(index, { sourceMaterial: event.target.value })}
									>
										{!sourceMaterials.some((material) => material.name === definition.sourceMaterial) && (
											<option value={definition.sourceMaterial}>{definition.sourceMaterial}</option>
										)}
										{sourceMaterials.map((material) => (
											<option
												key={material.name}
												value={material.name}
												disabled={parsedRemaps.definitions.some(
													(candidate, candidateIndex) => candidateIndex !== index && candidate.sourceMaterial === material.name
												)}
											>
												{material.name}
											</option>
										))}
									</select>
								) : (
									<input
										className="h-8 rounded border border-border bg-input px-2"
										defaultValue={definition.sourceMaterial}
										onBlur={(event) =>
											event.target.value.trim() && commitMaterialRemapInput(index, { sourceMaterial: event.target.value.trim() }, event.currentTarget)
										}
									/>
								)}
								<span>Project Material</span>
								<input
									className="h-8 rounded border border-border bg-input px-2 font-mono text-xs"
									defaultValue={definition.materialPath}
									placeholder="assets/hero-body.material"
									onBlur={(event) =>
										event.target.value.trim() && commitMaterialRemapInput(index, { materialPath: event.target.value.trim() }, event.currentTarget)
									}
								/>
							</div>
							{evidence && (
								<div className="text-xs text-muted-foreground">
									{evidence.materialObjectCount} material object(s) · {evidence.meshReferenceCount} mesh/submesh reference(s) · {evidence.textureCount} texture(s)
								</div>
							)}
							{execution && (
								<div className={execution.matched ? "text-xs text-emerald-400" : "text-xs text-amber-300"}>
									{execution.matched ? `Remapped to ${execution.replacementMaterialName ?? definition.materialPath}` : "Remap is unresolved"}
								</div>
							)}
							<Button
								variant="ghost"
								className="h-7 self-end px-2 !text-red-400"
								onClick={() => updateMaterialRemaps(parsedRemaps.definitions.filter((_candidate, definitionIndex) => definitionIndex !== index))}
							>
								Remove Remap
							</Button>
						</div>
					);
				})}
			</div>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="flex items-center justify-between gap-2">
					<div className="font-semibold">Model Animation Clips</div>
					<Button variant="outline" className="h-7 px-2" disabled={!!parsed.error || (!sourceGroups.length && !parsed.definitions.length)} onClick={addDefinition}>
						Add Clip
					</Button>
				</div>
				<div className="text-xs text-muted-foreground">
					Split imported AnimationGroups into independently named, zero-based clips. Apply the Model Importer to refresh source ranges and preview output.
				</div>
				{parsed.error && <div className="text-xs text-red-400 break-all">{parsed.error}</div>}
				{!parsed.error && parsed.definitions.length === 0 && (
					<div className="text-xs text-muted-foreground">
						No custom clips. {sourceGroups.length ? `${sourceGroups.length} source group(s) will be kept unchanged.` : "Apply once to inspect source animation groups."}
					</div>
				)}
				{parsed.definitions.map((definition, index) => {
					const selectedSource = sourceGroups.find((group) => group.name === definition.sourceAnimationGroup);
					return (
						<div key={`${definition.name}:${index}`} className="flex flex-col gap-2 rounded border border-border p-2">
							<div className="grid grid-cols-[1fr_130px] items-center gap-2">
								<span>Name</span>
								<input
									className="h-8 rounded border border-border bg-input px-2"
									value={definition.name}
									onChange={(event) => event.target.value.trim() && updateDefinition(index, { name: event.target.value })}
								/>
								<span>Source Group</span>
								{sourceGroups.length ? (
									<select
										className="h-8 rounded border border-border bg-input px-2"
										value={definition.sourceAnimationGroup}
										onChange={(event) => {
											const source = sourceGroups.find((group) => group.name === event.target.value);
											updateDefinition(index, {
												sourceAnimationGroup: event.target.value,
												...(source ? { from: source.from, to: source.to } : {}),
											});
										}}
									>
										{!sourceGroups.some((group) => group.name === definition.sourceAnimationGroup) && (
											<option value={definition.sourceAnimationGroup}>{definition.sourceAnimationGroup || "Missing source"}</option>
										)}
										{sourceGroups.map((group) => (
											<option key={group.name} value={group.name}>
												{group.name}
											</option>
										))}
									</select>
								) : (
									<input
										className="h-8 rounded border border-border bg-input px-2"
										value={definition.sourceAnimationGroup}
										onChange={(event) => event.target.value.trim() && updateDefinition(index, { sourceAnimationGroup: event.target.value })}
									/>
								)}
								<span>Frame Range</span>
								<div className="grid grid-cols-2 gap-1">
									<input
										type="number"
										className="h-8 rounded border border-border bg-input px-2"
										value={definition.from}
										onChange={(event) => {
											const value = Number(event.target.value);
											if (Number.isFinite(value) && value < definition.to) {
												updateDefinition(index, { from: value });
											}
										}}
									/>
									<input
										type="number"
										className="h-8 rounded border border-border bg-input px-2"
										value={definition.to}
										onChange={(event) => {
											const value = Number(event.target.value);
											if (Number.isFinite(value) && value > definition.from) {
												updateDefinition(index, { to: value });
											}
										}}
									/>
								</div>
								<span>Loop Time / Pose</span>
								<div className="flex items-center gap-3">
									<label className="flex items-center gap-1">
										<input
											type="checkbox"
											checked={definition.loopTime}
											onChange={(event) => updateDefinition(index, { loopTime: event.target.checked, ...(!event.target.checked ? { loopPose: false } : {}) })}
										/>
										Time
									</label>
									<label className="flex items-center gap-1">
										<input
											type="checkbox"
											disabled={!definition.loopTime}
											checked={definition.loopPose}
											onChange={(event) => updateDefinition(index, { loopPose: event.target.checked })}
										/>
										Pose
									</label>
								</div>
								<span>Root Motion Node</span>
								<input
									className="h-8 rounded border border-border bg-input px-2"
									value={definition.rootMotionNode}
									placeholder="Hips or Root"
									onChange={(event) =>
										updateDefinition(index, {
											rootMotionNode: event.target.value,
											...(!event.target.value.trim() ? { rootMotionPosition: "none", rootMotionRotationY: false } : {}),
										})
									}
								/>
								<span>Root Position</span>
								<select
									className="h-8 rounded border border-border bg-input px-2"
									value={definition.rootMotionPosition}
									onChange={(event) => updateDefinition(index, { rootMotionPosition: event.target.value as IModelAnimationClipDefinition["rootMotionPosition"] })}
								>
									<option value="none">None</option>
									<option value="xz">XZ</option>
									<option value="xyz">XYZ</option>
								</select>
								<span>Root Rotation Y</span>
								<input
									type="checkbox"
									checked={definition.rootMotionRotationY}
									onChange={(event) => updateDefinition(index, { rootMotionRotationY: event.target.checked })}
								/>
								<span>Target Mask</span>
								<textarea
									className="min-h-16 rounded border border-border bg-input px-2 py-1 font-mono text-xs"
									value={definition.targetMask.join("\n")}
									placeholder="Optional target names, one per line"
									onChange={(event) =>
										updateDefinition(index, {
											targetMask: event.target.value
												.split(/\r?\n|,/)
												.map((value) => value.trim())
												.filter(Boolean),
										})
									}
								/>
							</div>
							{selectedSource && (
								<div className="text-xs text-muted-foreground">
									Source {selectedSource.from}–{selectedSource.to} · {selectedSource.framePerSecond} FPS · {selectedSource.trackCount} track(s) ·{" "}
									{selectedSource.targets.length} target(s)
								</div>
							)}
							<Button
								variant="ghost"
								className="h-7 self-end px-2 !text-red-400"
								onClick={() => updateDefinitions(parsed.definitions.filter((_candidate, definitionIndex) => definitionIndex !== index))}
							>
								Remove Clip
							</Button>
						</div>
					);
				})}
			</div>
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="font-semibold">Model Import Result</div>
				{!artifact ? (
					<div className="text-xs text-muted-foreground">Loading model importer evidence…</div>
				) : !result ? (
					<div className="text-xs text-muted-foreground">No processed artifact yet. Apply the Model Importer to generate one.</div>
				) : (
					<>
						<div className={result.valid && artifact.current ? "text-emerald-400" : "text-amber-300"}>
							{result.valid
								? artifact.current
									? "Current and valid"
									: "Valid artifact is stale"
								: result.supported
									? "Import failed validation"
									: "Legacy editor conversion only"}
						</div>
						<div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
							{metric("Build platform", result.platform)}
							{metric("Platform override", result.platformOverrideApplied ? "applied" : "inherited Default")}
							{metric("Format", result.sourceFormat.toUpperCase())}
							{metric("Source size", `${result.sourceBytes.toLocaleString()} bytes`)}
							{metric("Unit scale", result.unitScale)}
							{metric("Embedded resources", result.embeddedResourceCount)}
							{metric("Tracked dependencies", result.dependencyPaths?.length ?? 0)}
							{metric("Conversion", result.legacyConversion ? "Assimp → GLB2" : "Native Babylon loader")}
							{result.legacyConversion && metric("Conversion inputs", result.legacyConversion.inputFileCount)}
							{result.legacyConversion && metric("Converted GLB", `${result.legacyConversion.outputBytes.toLocaleString()} bytes`)}
							{metric("Meshes", result.meshCount)}
							{metric("Vertices", result.vertexCount)}
							{metric("Triangles", result.triangleCount)}
							{metric("Materials", result.materialCount)}
							{metric("Source material names", result.sourceMaterials.length)}
							{metric("Remapped material objects", result.remappedMaterialCount)}
							{metric("Remapped meshes", result.remappedMeshCount)}
							{metric("Unresolved remaps", result.missingMaterialRemapCount)}
							{metric("Authored LOD groups", result.authoredLodSourceMeshCount ?? 0)}
							{metric("Authored LOD meshes", result.authoredLodMeshCount ?? 0)}
							{metric("LOD source meshes", result.lodSourceMeshCount)}
							{metric("Generated LOD meshes", result.generatedLodMeshCount)}
							{metric("Skipped LOD meshes", result.skippedLodMeshCount)}
							{metric("Textures", result.textureCount)}
							{metric("Animation groups", result.animationGroupCount)}
							{metric("Source animation groups", result.sourceAnimationGroups.length)}
							{metric("Custom animation clips", result.animationClips.length)}
							{metric("Skeletons", result.skeletonCount)}
							{metric("Rig type", result.rig.animationType)}
							{metric("Rig bones", result.rig.boneCount)}
							{result.rig.validation && metric("Humanoid required", `${result.rig.validation.requiredMappedBoneCount}/${result.rig.validation.requiredBoneCount}`)}
							{result.rig.validation && metric("T-pose", result.rig.validation.tPose.status)}
							{metric("Optimize Game Object", result.rigOptimization.enabled ? "enabled" : "disabled")}
							{metric("Rig transform candidates", result.rigOptimization.candidateTransformCount)}
							{metric("Transforms optimized out", result.rigOptimization.optimizedTransformCount)}
							{metric("Transforms exposed", result.rigOptimization.exposedTransformCount)}
							{metric("Animation tracks retargeted", result.rigOptimization.retargetedAnimationTrackCount)}
							{metric("Colliders", result.colliderCount)}
							{metric("Welded", result.weldedMeshCount)}
							{metric("Index optimized", result.optimizedMeshCount)}
							{metric("Quantized", result.quantizedMeshCount)}
							{metric("Normals calculated", result.calculatedNormalMeshCount)}
							{metric("Tangents calculated", result.calculatedTangentMeshCount)}
						</div>
						{result.errors.map((message) => (
							<div key={`error:${message}`} className="text-xs text-red-400 break-all">
								{message}
							</div>
						))}
						{result.warnings.map((message) => (
							<div key={`warning:${message}`} className="text-xs text-amber-300 break-all">
								{message}
							</div>
						))}
						{result.rig.validation && (
							<div className="flex flex-col gap-1 border-t border-border pt-2">
								<div className="font-medium">
									Humanoid Avatar · {result.rig.validation.valid ? "valid" : "needs configuration"} · {result.rig.validation.mappedBoneCount} mapped
								</div>
								{result.rig.validation.missingRequired.length > 0 && (
									<div className="text-xs text-red-400">Missing required: {result.rig.validation.missingRequired.join(", ")}</div>
								)}
							</div>
						)}
						{result.rigOptimization.enabled && (
							<div className="flex flex-col gap-1 border-t border-border pt-2">
								<div className="font-medium">Optimized Character Hierarchy</div>
								<div className="text-xs text-muted-foreground">
									{result.rigOptimization.optimizedTransformCount} skeleton-only Transform(s) removed · {result.rigOptimization.exposedTransformCount} scriptable
									proxy Transform(s) retained
								</div>
								{result.rigOptimization.resolvedExposedTransforms.length > 0 && (
									<div className="text-xs break-all">Exposed: {result.rigOptimization.resolvedExposedTransforms.join(", ")}</div>
								)}
								{result.rigOptimization.automaticallyExposedTransforms.length > 0 && (
									<div className="text-xs text-amber-300 break-all">
										Attachment parents retained automatically: {result.rigOptimization.automaticallyExposedTransforms.join(", ")}
									</div>
								)}
								{result.rigOptimization.missingExposedTransforms.length > 0 && (
									<div className="text-xs text-red-400 break-all">Missing requested transforms: {result.rigOptimization.missingExposedTransforms.join(", ")}</div>
								)}
							</div>
						)}
						{result.sourceAnimationGroups.length > 0 && (
							<div className="flex flex-col gap-1 border-t border-border pt-2">
								<div className="font-medium">Source Animation Groups ({result.sourceAnimationGroups.length})</div>
								{result.sourceAnimationGroups.map((group) => (
									<div key={group.name} className="text-xs break-all">
										{group.name} · frames {group.from}–{group.to} · {group.framePerSecond} FPS · {group.trackCount} track(s) · {group.keyCount} key(s)
									</div>
								))}
							</div>
						)}
						{result.animationClips.length > 0 && (
							<div className="flex flex-col gap-1 border-t border-border pt-2">
								<div className="font-medium">Generated Clips ({result.animationClips.length})</div>
								{result.animationClips.map((clip) => (
									<div key={clip.name} className="rounded border border-border p-2 text-xs">
										<div className="font-medium">
											{clip.name} · {clip.durationSeconds.toFixed(3)} s · {clip.loopTime ? "looping" : "one shot"}
											{clip.loopPose ? " · loop pose" : ""}
										</div>
										<div className="text-muted-foreground">
											{clip.sourceAnimationGroup} frames {clip.sourceFrom}–{clip.sourceTo} → 0–{clip.to} · {clip.trackCount} track(s) · {clip.keyCount} key(s)
										</div>
										{clip.rootMotion && (
											<div className={clip.rootMotion.resolved ? "text-emerald-400" : "text-red-400"}>
												Root motion {clip.rootMotion.requestedNode}: position {clip.rootMotion.positionMode}, rotation Y{" "}
												{clip.rootMotion.rotationY ? "enabled" : "disabled"} · {clip.rootMotion.resolved ? "resolved" : "missing tracks"}
											</div>
										)}
									</div>
								))}
							</div>
						)}
						{result.meshes.length > 0 && (
							<div className="flex flex-col gap-1 border-t border-border pt-2">
								<div className="font-medium">Geometry ({result.meshes.length})</div>
								{result.meshes.slice(0, 50).map((mesh, index) => (
									<div key={`${mesh.name}:${index}`} className="text-xs break-all">
										{mesh.name} · {mesh.vertexCount.toLocaleString()} vertices · {mesh.triangleCount.toLocaleString()} triangles
										{mesh.skinned ? " · skinned" : ""}
										{mesh.morphTargetCount ? ` · ${mesh.morphTargetCount} morph target(s)` : ""}
										{mesh.collider ? " · collider" : ""}
									</div>
								))}
								{result.meshes.length > 50 && <div className="text-xs text-muted-foreground">…and {result.meshes.length - 50} more meshes</div>}
							</div>
						)}
					</>
				)}
			</div>
		</>
	);
}
