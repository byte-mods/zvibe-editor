import { basename } from "path/posix";

import { Divider } from "@blueprintjs/core";
import { useEffect, useState } from "react";
import { MdAnimation } from "react-icons/md";

import { IAnimationImporterArtifactStatus } from "../../../../mcp/assets/animation-importer";
import { FileInspectorObject } from "../file";

export interface IEditorInspectorAnimationComponentProps {
	object: FileInspectorObject;
	artifact: IAnimationImporterArtifactStatus | null;
	animationGroups: string[];
	avatarMasks: Array<{ id: string; name: string }>;
	onImportController: (
		motionBindings: Record<string, string>,
		avatarMaskBindings: Record<string, string>,
		ignoreUnresolvedAvatarMasks: boolean,
		replaceExisting: boolean
	) => Promise<string>;
}

export function EditorInspectorAnimationComponent(props: IEditorInspectorAnimationComponentProps) {
	const result = props.artifact?.current ? props.artifact.result : null;
	const [motionBindings, setMotionBindings] = useState<Record<string, string>>({});
	const [avatarMaskBindings, setAvatarMaskBindings] = useState<Record<string, string>>({});
	const [ignoreMasks, setIgnoreMasks] = useState(false);
	const [replaceExisting, setReplaceExisting] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		setMotionBindings(
			Object.fromEntries(
				(result?.controllerMotionBindings ?? []).map((binding) => [
					binding.key,
					props.animationGroups.find((name) => name === binding.suggestedAnimationGroup || name.toLowerCase() === binding.suggestedAnimationGroup.toLowerCase()) ?? "",
				])
			)
		);
		setAvatarMaskBindings(
			Object.fromEntries(
				(result?.controllerAvatarMaskBindings ?? []).map((binding) => [
					binding.key,
					props.avatarMasks.find((mask) => mask.name === binding.suggestedAvatarMask || mask.name.toLowerCase() === binding.suggestedAvatarMask.toLowerCase())?.id ?? "",
				])
			)
		);
		setMessage(null);
	}, [result?.outputPath, props.animationGroups.join("\0"), props.avatarMasks.map((mask) => `${mask.id}:${mask.name}`).join("\0")]);
	const unresolvedMotion = (result?.controllerMotionBindings ?? []).some((binding) => !motionBindings[binding.key]);
	const unresolvedMasks = (result?.controllerAvatarMaskBindings ?? []).some((binding) => !avatarMaskBindings[binding.key]);
	const importController = async (): Promise<void> => {
		setBusy(true);
		setMessage(null);
		try {
			setMessage(await props.onImportController(motionBindings, avatarMaskBindings, ignoreMasks, replaceExisting));
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
						{result.clips.length} clip(s) · {result.tracks.length} track(s) · {result.sourceKeyCount.toLocaleString()} source →{" "}
						{result.sampledKeyCount.toLocaleString()} sampled → {result.outputKeyCount.toLocaleString()} output keys
					</div>
					{result.rootMotion && (
						<div className={result.rootMotion.resolved ? "text-green-400" : "text-red-400"}>
							Root motion: {result.rootMotion.requestedNode} · {result.rootMotion.resolved ? `${result.rootMotion.trackCount} track(s)` : "not resolved"}
						</div>
					)}
					{result.sourceKind === "animator-controller" && (
						<>
							<div>
								{result.controllerFormat ?? "babylon-json"} · {result.controllerLayerCount ?? 1} layer(s) · {result.controllerParameterCount ?? 0} parameter(s) ·{" "}
								{result.controllerStateCount} state(s) · {result.controllerTransitionCount} transition(s) · {result.controllerBlendTreeCount ?? 0} Blend Tree(s)
							</div>
							{result.controllerMotionBindings?.map((binding) => (
								<label key={binding.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 rounded border border-border p-2">
									<span className="break-all">Motion · {binding.suggestedAnimationGroup}</span>
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
							{result.controllerAvatarMaskBindings?.map((binding) => (
								<label key={binding.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 rounded border border-border p-2">
									<span className="break-all">Avatar Mask · {binding.suggestedAvatarMask}</span>
									<select
										className="h-8 rounded border border-border bg-background px-2"
										value={avatarMaskBindings[binding.key] ?? ""}
										onChange={(event) => setAvatarMaskBindings({ ...avatarMaskBindings, [binding.key]: event.target.value })}
									>
										<option value="">Unresolved</option>
										{props.avatarMasks.map((mask) => (
											<option key={mask.id} value={mask.id}>
												{mask.name}
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
										disabled={busy || !result.valid || unresolvedMotion || (unresolvedMasks && !ignoreMasks)}
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
								{clip.durationSeconds.toFixed(3)} s · frames {clip.from.toFixed(2)}–{clip.to.toFixed(2)} · {clip.loop ? "looping" : "not looping"}
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
					{result.tracks.slice(0, 50).map((track, index) => (
						<div key={`${track.name}:${track.target ?? ""}:${index}`} className="text-muted-foreground break-all">
							{track.target ?? "UNBOUND"} · {track.property} · {track.sourceFramesPerSecond}→{track.outputFramesPerSecond} FPS · {track.sourceKeyCount} source →{" "}
							{track.sampledKeyCount} sampled → {track.outputKeyCount} output keys
						</div>
					))}
					{result.tracks.length > 50 && <div className="text-muted-foreground">…and {result.tracks.length - 50} more tracks</div>}
				</div>
			)}
		</div>
	);
}
