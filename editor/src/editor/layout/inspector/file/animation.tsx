import { basename } from "path/posix";

import { Divider } from "@blueprintjs/core";
import { useEffect, useState } from "react";
import { MdAnimation } from "react-icons/md";

import { IAnimationImporterArtifactStatus } from "../../../../mcp/assets/animation-importer";
import { FileInspectorObject } from "../file";

export interface IEditorAnimationClipTargetOption {
	key: string;
	label: string;
	binding: { kind: "node"; nodeId: string } | { kind: "morphTarget"; meshId: string; morphTargetName: string } | { kind: "sprite"; spriteName: string; managerName: string };
}

export interface IEditorInspectorAnimationComponentProps {
	object: FileInspectorObject;
	artifact: IAnimationImporterArtifactStatus | null;
	controllerImportPlan: any | null;
	animationGroups: string[];
	avatarMasks: Array<{ id: string; name: string }>;
	clipTargets: IEditorAnimationClipTargetOption[];
	onImportClip: (targetBindings: Array<Record<string, string>>, objectReferenceBindings: Array<Record<string, unknown>>, replaceExisting: boolean) => Promise<string>;
	onImportController: (
		motionBindings: Record<string, string>,
		avatarMaskBindings: Record<string, string>,
		behaviourBindings: Record<string, string>,
		targetNodeId: string | null,
		ignoreUnresolvedAvatarMasks: boolean,
		replaceExisting: boolean
	) => Promise<string>;
	onSelectControllerTarget: (targetNodeId: string | null) => Promise<void>;
}

export function EditorInspectorAnimationComponent(props: IEditorInspectorAnimationComponentProps) {
	const result = props.artifact?.current ? props.artifact.result : null;
	const controllerMotionBindings = props.controllerImportPlan?.motionBindings ?? result?.controllerMotionBindings ?? [];
	const controllerAvatarMaskBindings = props.controllerImportPlan?.avatarMaskBindings ?? result?.controllerAvatarMaskBindings ?? [];
	const controllerBehaviourBindings = props.controllerImportPlan?.behaviourBindings ?? result?.controllerBehaviourBindings ?? [];
	const controllerCompatibility = result?.sourceKind === "animator-controller" ? result.controllerCompatibility : null;
	const [motionBindings, setMotionBindings] = useState<Record<string, string>>({});
	const [avatarMaskBindings, setAvatarMaskBindings] = useState<Record<string, string>>({});
	const [behaviourBindings, setBehaviourBindings] = useState<Record<string, string>>({});
	const [clipBindings, setClipBindings] = useState<Record<string, string>>({});
	const [objectReferenceBindings, setObjectReferenceBindings] = useState<any[]>([]);
	const [ignoreMasks, setIgnoreMasks] = useState(false);
	const [replaceExisting, setReplaceExisting] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		setMotionBindings(Object.fromEntries(controllerMotionBindings.map((binding: any) => [binding.key, binding.suggestedMatch ?? ""])));
		setAvatarMaskBindings(Object.fromEntries(controllerAvatarMaskBindings.map((binding: any) => [binding.key, binding.suggestedMatch ?? ""])));
		setBehaviourBindings(Object.fromEntries(controllerBehaviourBindings.map((binding: any) => [binding.key, binding.suggestedMatch ?? ""])));
		setClipBindings(
			Object.fromEntries(
				[...new Set((result?.tracks ?? []).map((track) => track.target).filter((target): target is string => target !== null))].map((sourceTarget) => {
					const morphName = sourceTarget.includes("#blendShape:") ? sourceTarget.slice(sourceTarget.indexOf("#blendShape:") + "#blendShape:".length) : null;
					const leafName = sourceTarget.split("/").pop() ?? sourceTarget;
					const objectReference = (result?.objectReferenceCurves ?? []).find((curve) => curve.target === sourceTarget);
					const candidates = props.clipTargets.filter((option) =>
						morphName
							? option.binding.kind === "morphTarget" && option.binding.morphTargetName === morphName
							: objectReference?.attribute === "m_Sprite"
								? option.binding.kind === "sprite" && (option.label === sourceTarget || option.label.startsWith(`${leafName} ·`))
								: option.binding.kind === "node" && (option.label === sourceTarget || option.label.startsWith(`${leafName} ·`))
					);
					return [sourceTarget, candidates.length === 1 ? candidates[0].key : ""];
				})
			)
		);
		setObjectReferenceBindings(
			(result?.objectReferenceCurves ?? []).map((curve) => ({
				curveId: curve.id,
				propertyPath: curve.attribute === "m_Sprite" ? "cellIndex" : "",
				references: curve.references.map((reference, referenceIndex) => ({
					referenceKey: reference.key,
					value: reference.fileId === "0" ? { kind: "null" } : { kind: "number", value: referenceIndex },
				})),
			}))
		);
		setIgnoreMasks(false);
		setReplaceExisting(false);
	}, [
		result?.outputPath,
		props.controllerImportPlan?.fingerprint,
		props.animationGroups.join("\0"),
		props.avatarMasks.map((mask) => `${mask.id}:${mask.name}`).join("\0"),
		props.clipTargets.map((target) => target.key).join("\0"),
	]);
	useEffect(() => setMessage(null), [result?.outputPath]);
	const unresolvedMotion = controllerMotionBindings.some((binding: any) => !motionBindings[binding.key]);
	const unresolvedMasks = controllerAvatarMaskBindings.some((binding: any) => !avatarMaskBindings[binding.key]);
	const unresolvedBehaviours = controllerBehaviourBindings.some((binding: any) => !behaviourBindings[binding.key]);
	const clipSourceTargets = [...new Set((result?.tracks ?? []).map((track) => track.target).filter((target): target is string => target !== null))];
	const unresolvedClip = clipSourceTargets.some((sourceTarget) => !clipBindings[sourceTarget]);
	const unresolvedObjectReferences = objectReferenceBindings.some(
		(binding) =>
			!binding.propertyPath?.trim() ||
			binding.references?.some((reference: any) => {
				const value = reference.value;
				return (
					!value ||
					(value.kind === "number" && (typeof value.value !== "number" || !Number.isFinite(value.value))) ||
					(value.kind === "node" && !value.nodeId?.trim()) ||
					(value.kind === "material" && !value.materialId?.trim()) ||
					(value.kind === "texture" && !value.path?.trim())
				);
			})
	);
	const setObjectReferenceProperty = (curveIndex: number, propertyPath: string): void => {
		setObjectReferenceBindings(objectReferenceBindings.map((binding, index) => (index === curveIndex ? { ...binding, propertyPath } : binding)));
	};
	const setObjectReferenceValue = (curveIndex: number, referenceIndex: number, value: Record<string, unknown>): void => {
		setObjectReferenceBindings(
			objectReferenceBindings.map((binding, index) =>
				index === curveIndex
					? {
							...binding,
							references: binding.references.map((reference: any, candidateIndex: number) =>
								candidateIndex === referenceIndex ? { ...reference, value } : reference
							),
						}
					: binding
			)
		);
	};
	const importClip = async (): Promise<void> => {
		setBusy(true);
		setMessage(null);
		try {
			const bindings = clipSourceTargets.map((sourceTarget) => {
				const option = props.clipTargets.find((candidate) => candidate.key === clipBindings[sourceTarget])!;
				return { sourceTarget, ...option.binding };
			});
			setMessage(await props.onImportClip(bindings, objectReferenceBindings, replaceExisting));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	const importController = async (): Promise<void> => {
		setBusy(true);
		setMessage(null);
		try {
			setMessage(
				await props.onImportController(
					motionBindings,
					avatarMaskBindings,
					behaviourBindings,
					props.controllerImportPlan?.selectedScriptTarget?.id ?? null,
					ignoreMasks,
					replaceExisting
				)
			);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	const selectControllerTarget = async (targetNodeId: string): Promise<void> => {
		setBusy(true);
		setMessage(null);
		try {
			await props.onSelectControllerTarget(targetNodeId || null);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2 justify-center items-center text-xl font-bold">
				<MdAnimation size="24px" />
				{basename(props.object.absolutePath)}
			</div>
			<Divider />
			{!result && <div className="px-5 text-xs text-muted-foreground">Apply the Animation Importer to resample, compress, and validate this asset.</div>}
			{result && (
				<div className="mx-5 flex flex-col gap-2 rounded bg-input p-3 text-xs">
					<div className={result.valid ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>
						{result.valid ? "Valid imported animation" : "Animation importer reported errors"} · {result.sourceKind}
					</div>
					<div>
						{result.sourceFormat} → {result.outputFormat} · {result.roundTripSafe ? "lossless round trip" : "converted"}
					</div>
					<div>
						{result.clips.length} clip(s) · {result.tracks.length} track(s) · {result.sourceKeyCount.toLocaleString()} source →{" "}
						{result.sampledKeyCount.toLocaleString()} sampled → {result.outputKeyCount.toLocaleString()} output keys
					</div>
					<div>
						{result.settings.resampleCurves ? `Resampled at ${result.settings.resampleRate} FPS` : "Source curves preserved"} · {result.settings.compression} · position
						≤ {result.settings.positionErrorPercent}% · rotation ≤ {result.settings.rotationErrorDegrees}° · scale ≤ {result.settings.scaleErrorPercent}% · float ≤{" "}
						{result.settings.floatError}
					</div>
					{result.removedConstantScaleTrackCount > 0 && <div>Removed {result.removedConstantScaleTrackCount} exact default-scale track(s).</div>}
					{result.rootMotion && (
						<div className={result.rootMotion.resolved ? "text-green-400" : "text-red-400"}>
							Root motion: {result.rootMotion.requestedNode} · {result.rootMotion.resolved ? `${result.rootMotion.trackCount} track(s)` : "not resolved"}
						</div>
					)}
					{result.sourceKind === "unity-animation-clip" && (
						<div className="flex flex-col gap-2 border-t border-border pt-2">
							<div className="rounded border border-border p-2">
								<div className="font-semibold">Unity Clip Compatibility</div>
								<div>
									{result.activeStateCurveCount ?? 0} active-state · {result.compressedRotationCurveCount ?? 0} packed rotation ·{" "}
									{result.objectReferenceCurves?.length ?? 0} object-reference curve(s)
								</div>
							</div>
							<div className="font-semibold">Scene Target Bindings</div>
							{clipSourceTargets.map((sourceTarget) => {
								const morph = sourceTarget.includes("#blendShape:");
								const sprite = result.objectReferenceCurves?.some((curve) => curve.target === sourceTarget && curve.attribute === "m_Sprite");
								return (
									<label key={sourceTarget} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 rounded border border-border p-2">
										<span className="break-all">{sourceTarget}</span>
										<select
											className="h-8 rounded border border-border bg-background px-2"
											value={clipBindings[sourceTarget] ?? ""}
											onChange={(event) => setClipBindings({ ...clipBindings, [sourceTarget]: event.target.value })}
										>
											<option value="">Unresolved</option>
											{props.clipTargets
												.filter((option) =>
													morph ? option.binding.kind === "morphTarget" : sprite ? option.binding.kind === "sprite" : option.binding.kind === "node"
												)
												.map((option) => (
													<option key={option.key} value={option.key}>
														{option.label}
													</option>
												))}
										</select>
									</label>
								);
							})}
							{(result.objectReferenceCurves ?? []).length > 0 && <div className="font-semibold">Object Reference Bindings</div>}
							{(result.objectReferenceCurves ?? []).map((curve, curveIndex) => {
								const binding = objectReferenceBindings[curveIndex];
								return (
									<div key={curve.id} className="flex flex-col gap-2 rounded border border-border p-2">
										<div className="font-medium break-all">
											{curve.target || "Root"} · {curve.attribute}
										</div>
										<div className="text-muted-foreground">
											{curve.keys.length} key(s) · {curve.references.length} exact GUID/fileID/type reference(s)
										</div>
										<label className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
											<span>Destination property</span>
											<input
												className="h-8 rounded border border-border bg-background px-2"
												value={binding?.propertyPath ?? ""}
												onChange={(event) => setObjectReferenceProperty(curveIndex, event.target.value)}
												placeholder={curve.attribute === "m_Sprite" ? "cellIndex" : "metadata.reference"}
											/>
										</label>
										{curve.references.map((reference, referenceIndex) => {
											const value = binding?.references?.[referenceIndex]?.value ?? { kind: "null" };
											const textValue =
												value.kind === "node"
													? (value.nodeId ?? "")
													: value.kind === "material"
														? (value.materialId ?? "")
														: value.kind === "texture"
															? (value.path ?? "")
															: value.kind === "string"
																? (value.value ?? "")
																: "";
											return (
												<div key={reference.key} className="grid grid-cols-[minmax(0,1.2fr)_110px_minmax(0,1fr)] items-center gap-2">
													<span className="break-all text-muted-foreground">{reference.key}</span>
													<select
														className="h-8 rounded border border-border bg-background px-2"
														value={value.kind}
														onChange={(event) => {
															const kind = event.target.value;
															setObjectReferenceValue(
																curveIndex,
																referenceIndex,
																kind === "null"
																	? { kind }
																	: kind === "number"
																		? { kind, value: referenceIndex }
																		: kind === "boolean"
																			? { kind, value: false }
																			: kind === "node"
																				? { kind, nodeId: "" }
																				: kind === "material"
																					? { kind, materialId: "" }
																					: kind === "texture"
																						? { kind, path: "" }
																						: { kind, value: "" }
															);
														}}
													>
														{["null", "number", "boolean", "string", "node", "material", "texture"].map((kind) => (
															<option key={kind} value={kind}>
																{kind}
															</option>
														))}
													</select>
													{value.kind === "number" ? (
														<input
															className="h-8 rounded border border-border bg-background px-2"
															type="number"
															value={value.value}
															onChange={(event) =>
																setObjectReferenceValue(curveIndex, referenceIndex, { kind: "number", value: Number(event.target.value) })
															}
														/>
													) : value.kind === "boolean" ? (
														<input
															type="checkbox"
															checked={value.value}
															onChange={(event) =>
																setObjectReferenceValue(curveIndex, referenceIndex, { kind: "boolean", value: event.target.checked })
															}
														/>
													) : value.kind === "null" ? (
														<span className="text-muted-foreground">null</span>
													) : (
														<input
															className="h-8 rounded border border-border bg-background px-2"
															value={textValue}
															onChange={(event) =>
																setObjectReferenceValue(
																	curveIndex,
																	referenceIndex,
																	value.kind === "node"
																		? { kind: "node", nodeId: event.target.value }
																		: value.kind === "material"
																			? { kind: "material", materialId: event.target.value }
																			: value.kind === "texture"
																				? { kind: "texture", path: event.target.value }
																				: { kind: "string", value: event.target.value }
																)
															}
														/>
													)}
												</div>
											);
										})}
									</div>
								);
							})}
							<label className="flex items-center gap-2">
								<input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />
								Replace same-name AnimationGroup
							</label>
							<button
								className="h-8 rounded bg-primary px-3 text-primary-foreground disabled:opacity-50"
								disabled={busy || !result.valid || unresolvedClip || unresolvedObjectReferences || clipSourceTargets.length === 0}
								onClick={() => void importClip()}
							>
								{busy ? "Importing…" : "Import Clip Into Scene"}
							</button>
							{message && <div className="break-all text-cyan-300">{message}</div>}
						</div>
					)}
					{result.sourceKind === "animator-controller" && (
						<>
							<div>
								{result.controllerFormat ?? "babylon-json"} · {result.controllerLayerCount ?? 1} layer(s) · {result.controllerParameterCount ?? 0} parameter(s) ·{" "}
								{result.controllerStateCount} state(s) · {result.controllerTransitionCount} transition(s) · {result.controllerBlendTreeCount ?? 0} Blend Tree(s) ·{" "}
								{result.controllerBehaviourBindingCount ?? controllerBehaviourBindings.length} Unity behaviour binding(s)
							</div>
							{controllerCompatibility && (
								<div className="rounded border border-border p-2">
									<div className="font-semibold">Unity serialization compatibility</div>
									<div>
										YAML {controllerCompatibility.yamlVersion ?? "unversioned"} · {controllerCompatibility.stateSerializationProfile}
									</div>
									<div>
										{controllerCompatibility.serializedObjects
											.map(
												(entry: any) =>
													`${entry.typeName} v${entry.serializedVersions.length ? entry.serializedVersions.join("/") : "unversioned"} ×${entry.count}`
											)
											.join(" · ")}
									</div>
									{controllerCompatibility.fieldVariants.length > 0 && (
										<div className="text-muted-foreground">Fields: {controllerCompatibility.fieldVariants.join(", ")}</div>
									)}
								</div>
							)}
							{controllerBehaviourBindings.length > 0 && (
								<label className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 rounded border border-border p-2">
									<span>
										Animator Target
										<small className="block text-muted-foreground">Behaviours run only on scripts already attached to this node.</small>
									</span>
									<select
										className="h-8 rounded border border-border bg-background px-2"
										value={props.controllerImportPlan?.selectedScriptTarget?.id ?? ""}
										onChange={(event) => void selectControllerTarget(event.target.value)}
										disabled={busy}
									>
										<option value="">Select target</option>
										{(props.controllerImportPlan?.availableScriptTargets ?? []).map((target: any) => (
											<option key={target.id} value={target.id}>
												{target.name} · {target.attachedScriptKeys.length} script(s)
											</option>
										))}
									</select>
								</label>
							)}
							{controllerMotionBindings.map((binding: any) => (
								<label key={binding.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 rounded border border-border p-2">
									<span className="break-all">
										Motion · {binding.dependency?.path ?? binding.suggestedAnimationGroup}
										{binding.resolution && <small className="block text-muted-foreground">{binding.resolution}</small>}
										{binding.diagnostics?.map((diagnostic: string) => (
											<small key={diagnostic} className="block text-amber-300">
												{diagnostic}
											</small>
										))}
									</span>
									<select
										className="h-8 rounded border border-border bg-background px-2"
										value={motionBindings[binding.key] ?? ""}
										onChange={(event) => setMotionBindings({ ...motionBindings, [binding.key]: event.target.value })}
									>
										<option value="">Unresolved</option>
										{props.animationGroups.map((name) => (
											<option key={name} value={name}>
												{name}
											</option>
										))}
									</select>
								</label>
							))}
							{controllerAvatarMaskBindings.map((binding: any) => (
								<label key={binding.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 rounded border border-border p-2">
									<span className="break-all">
										Avatar Mask · {binding.dependency?.path ?? binding.suggestedAvatarMask}
										{binding.resolution && <small className="block text-muted-foreground">{binding.resolution}</small>}
										{binding.autoImport && <small className="block text-green-400">Auto-import for {binding.autoImport.avatarName}</small>}
										{binding.diagnostics?.map((diagnostic: string) => (
											<small key={diagnostic} className="block text-amber-300">
												{diagnostic}
											</small>
										))}
									</span>
									<select
										className="h-8 rounded border border-border bg-background px-2"
										value={avatarMaskBindings[binding.key] ?? ""}
										onChange={(event) => setAvatarMaskBindings({ ...avatarMaskBindings, [binding.key]: event.target.value })}
									>
										<option value="">Unresolved</option>
										{binding.autoImport && (
											<option value={binding.autoImport.maskId}>
												Import {binding.autoImport.name} for {binding.autoImport.avatarName}
											</option>
										)}
										{props.avatarMasks.map((mask) => (
											<option key={mask.id} value={mask.id}>
												{mask.name}
											</option>
										))}
									</select>
								</label>
							))}
							{controllerBehaviourBindings.map((binding: any) => (
								<label key={binding.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 rounded border border-border p-2">
									<span className="break-all">
										Behaviour · {binding.scriptClassHint || binding.behaviourName || binding.key}
										<small className="block text-muted-foreground">{binding.dependency?.path ?? `MonoBehaviour fileID ${binding.behaviourFileId}`}</small>
										{binding.resolution && <small className="block text-muted-foreground">{binding.resolution}</small>}
										{binding.usedBy?.map((owner: string) => (
											<small key={owner} className="block text-muted-foreground">
												Used by {owner}
											</small>
										))}
										{binding.diagnostics?.map((diagnostic: string) => (
											<small key={diagnostic} className="block text-amber-300">
												{diagnostic}
											</small>
										))}
									</span>
									<select
										className="h-8 rounded border border-border bg-background px-2"
										value={behaviourBindings[binding.key] ?? ""}
										onChange={(event) => setBehaviourBindings({ ...behaviourBindings, [binding.key]: event.target.value })}
									>
										<option value="">Unresolved</option>
										{(props.controllerImportPlan?.selectedScriptTarget?.attachedScriptKeys ?? []).map((key: string) => (
											<option key={key} value={key}>
												{key}
											</option>
										))}
									</select>
								</label>
							))}
							{result.controllerFormat === "unity-yaml" && (
								<div className="flex flex-col gap-2 border-t border-border pt-2">
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={ignoreMasks} onChange={(event) => setIgnoreMasks(event.target.checked)} />
										Ignore unresolved Avatar Masks
									</label>
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />
										Replace same-name controller
									</label>
									<button
										className="h-8 rounded bg-primary px-3 text-primary-foreground disabled:opacity-50"
										disabled={busy || !result.valid || unresolvedMotion || unresolvedBehaviours || (unresolvedMasks && !ignoreMasks)}
										onClick={() => void importController()}
									>
										{busy ? "Importing…" : "Import Controller Into Scene"}
									</button>
									{message && <div className="break-all text-cyan-300">{message}</div>}
								</div>
							)}
							{result.controllerUnsupportedFeatures?.map((feature) => (
								<div key={feature} className="text-amber-300 break-all">
									Unsupported: {feature}
								</div>
							))}
						</>
					)}
					{result.clips.map((clip) => (
						<div key={clip.name} className="rounded border border-border p-2">
							<div className="font-semibold">{clip.name}</div>
							<div>
								{clip.durationSeconds.toFixed(3)} s · frames {clip.from.toFixed(2)}–{clip.to.toFixed(2)} · {clip.loop ? "looping" : "not looping"} ·{" "}
								{clip.eventCount} event(s)
							</div>
							<div className="text-muted-foreground">
								{clip.sourceKeyCount} source → {clip.sampledKeyCount} sampled → {clip.outputKeyCount} output keys
							</div>
						</div>
					))}
					{result.errors.map((error) => (
						<div key={error} className="text-red-400 break-all">
							{error}
						</div>
					))}
					{result.warnings.map((warning) => (
						<div key={warning} className="text-amber-300 break-all">
							{warning}
						</div>
					))}
					{result.preservedFeatures.map((feature) => (
						<div key={`preserved:${feature}`} className="text-green-300 break-all">
							Preserved: {feature}
						</div>
					))}
					{result.approximatedFeatures.map((feature) => (
						<div key={`approximated:${feature}`} className="text-cyan-300 break-all">
							Converted: {feature}
						</div>
					))}
					{result.unsupportedFeatures.map((feature) => (
						<div key={`unsupported:${feature}`} className="text-amber-300 break-all">
							Unsupported: {feature}
						</div>
					))}
					{result.tracks.slice(0, 50).map((track, index) => (
						<div key={`${track.name}:${track.target ?? ""}:${index}`} className="rounded border border-border p-2 text-muted-foreground break-all">
							<div>
								{track.target ?? "UNBOUND"} · {track.property} · {track.sourceFramesPerSecond}→{track.outputFramesPerSecond} FPS · {track.sourceKeyCount} source →{" "}
								{track.sampledKeyCount} sampled → {track.outputKeyCount} output keys
							</div>
							<div>
								{track.compression.requested} → {track.compression.effective} · {track.compression.errorMetric}{" "}
								{track.compression.maximumObservedError.toPrecision(4)} / {track.compression.allowedError} max
								{track.compression.quantizationBits ? ` · ${track.compression.quantizationBits}-bit` : ""} · {track.compression.protectedKeyCount} protected
							</div>
						</div>
					))}
					{result.tracks.length > 50 && <div className="text-muted-foreground">…and {result.tracks.length - 50} more tracks</div>}
				</div>
			)}
		</div>
	);
}
