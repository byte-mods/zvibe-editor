import { ReactNode } from "react";
import { toast } from "sonner";

import {
	ICinematicDocument,
	ICinematicMarker,
	ICinematicPropertyKey,
	TCinematicClip,
	TCinematicJsonValue,
	TCinematicKeyLane,
	TCinematicPropertyKey,
	TCinematicPropertyValue,
	TCinematicTrack,
	setCinematicSettings,
	updateCinematicClip,
	updateCinematicKey,
	updateCinematicMarker,
	updateCinematicRecorderProfile,
	updateCinematicTrack,
} from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";

export type ICinematicDocumentSelection =
	| { kind: "track"; trackId: string }
	| { kind: "clip"; trackId: string; itemId: string }
	| { kind: "key"; trackId: string; itemId: string; lane: TCinematicKeyLane }
	| { kind: "marker"; trackId: string; itemId: string }
	| { kind: "profile"; trackId: ""; itemId: string };

export interface ICinematicDocumentInspectorProps {
	document: ICinematicDocument;
	selection: ICinematicDocumentSelection | null;
	commit: (action: (current: ICinematicDocument) => ICinematicDocument) => void;
	onSelection: (selection: ICinematicDocumentSelection | null) => void;
}

const inputClass = "h-8 w-full rounded border border-input bg-background px-2 text-xs outline-none focus:border-primary";

function Field(props: { label: string; children: ReactNode }): ReactNode {
	return (
		<label className="grid gap-1 text-[11px] text-muted-foreground">
			<span>{props.label}</span>
			{props.children}
		</label>
	);
}

function TextField(props: { label: string; value: string; onChange: (value: string) => void }): ReactNode {
	return (
		<Field label={props.label}>
			<input className={inputClass} defaultValue={props.value} onBlur={(event) => event.currentTarget.value !== props.value && props.onChange(event.currentTarget.value)} />
		</Field>
	);
}

function NumberField(props: { label: string; value: number; minimum?: number; maximum?: number; step?: number; onChange: (value: number) => void }): ReactNode {
	return (
		<Field label={props.label}>
			<input
				className={inputClass}
				type="number"
				defaultValue={props.value}
				min={props.minimum}
				max={props.maximum}
				step={props.step ?? 1}
				onBlur={(event) => Number(event.currentTarget.value) !== props.value && props.onChange(Number(event.currentTarget.value))}
			/>
		</Field>
	);
}

function BooleanField(props: { label: string; value: boolean; onChange: (value: boolean) => void }): ReactNode {
	return (
		<label className="flex items-center justify-between gap-3 rounded border border-border px-2 py-1.5 text-xs">
			<span>{props.label}</span>
			<input type="checkbox" checked={props.value} onChange={(event) => props.onChange(event.currentTarget.checked)} />
		</label>
	);
}

function SelectField(props: { label: string; value: string; values: readonly string[]; onChange: (value: string) => void }): ReactNode {
	return (
		<Field label={props.label}>
			<select className={inputClass} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
				{props.values.map((value) => (
					<option key={value} value={value}>
						{value}
					</option>
				))}
			</select>
		</Field>
	);
}

function JsonField(props: { label: string; value: unknown; onChange: (value: unknown) => void }): ReactNode {
	return (
		<Field label={props.label}>
			<textarea
				className="min-h-20 w-full resize-y rounded border border-input bg-background p-2 font-mono text-[11px] outline-none focus:border-primary"
				defaultValue={JSON.stringify(props.value, null, 2)}
				onBlur={(event) => {
					try {
						props.onChange(JSON.parse(event.currentTarget.value));
					} catch (exception) {
						toast.error(exception instanceof Error ? exception.message : String(exception));
					}
				}}
			/>
		</Field>
	);
}

function trackFor(document: ICinematicDocument, trackId: string): TCinematicTrack | null {
	return document.tracks.find((candidate) => candidate.id === trackId) ?? null;
}

function keyFor(track: TCinematicTrack, selection: Extract<ICinematicDocumentSelection, { kind: "key" }>): TCinematicPropertyKey | null {
	if (selection.lane === "property" && track.type === "property") {
		return track.keys.find((key) => key.id === selection.itemId) ?? null;
	}
	if (selection.lane === "weight" && track.type === "animation") {
		return track.weightKeys.find((key) => key.id === selection.itemId) ?? null;
	}
	if (selection.lane === "volume" && track.type === "audio") {
		return track.volumeKeys.find((key) => key.id === selection.itemId) ?? null;
	}
	return null;
}

function DocumentSettings(props: ICinematicDocumentInspectorProps): ReactNode {
	const change = (changes: Parameters<typeof setCinematicSettings>[2]): void => props.commit((current) => setCinematicSettings(current, current.revision, changes));
	return (
		<div className="grid gap-3">
			<h3 className="text-sm font-semibold">Timeline Settings</h3>
			<TextField label="Name" value={props.document.name} onChange={(name) => change({ name })} />
			<NumberField
				label="Timeline FPS"
				value={props.document.framesPerSecond}
				minimum={1}
				maximum={240}
				step={0.01}
				onChange={(framesPerSecond) => change({ framesPerSecond })}
			/>
			<NumberField
				label="Output FPS"
				value={props.document.outputFramesPerSecond}
				minimum={1}
				maximum={240}
				step={0.01}
				onChange={(outputFramesPerSecond) => change({ outputFramesPerSecond })}
			/>
			<SelectField
				label="Duration Mode"
				value={props.document.durationMode}
				values={["automatic", "fixed"]}
				onChange={(durationMode) => change({ durationMode: durationMode as ICinematicDocument["durationMode"] })}
			/>
			{props.document.durationMode === "fixed" && (
				<NumberField label="Duration Frames" value={props.document.durationFrames} minimum={0} onChange={(durationFrames) => change({ durationFrames })} />
			)}
			<SelectField
				label="Wrap Mode"
				value={props.document.wrapMode}
				values={["once", "loop", "hold"]}
				onChange={(wrapMode) => change({ wrapMode: wrapMode as ICinematicDocument["wrapMode"] })}
			/>
			<div className="rounded border border-border p-2 text-[11px] text-muted-foreground">
				Version {props.document.version} · Revision {props.document.revision}
				<br />
				{props.document.tracks.length} tracks · {props.document.recorderProfiles.length} capture profiles
			</div>
		</div>
	);
}

function TrackInspector(props: ICinematicDocumentInspectorProps & { track: TCinematicTrack }): ReactNode {
	const { track } = props;
	const change = (changes: Record<string, unknown>): void => props.commit((current) => updateCinematicTrack(current, current.revision, track.id, changes));
	const groups = props.document.tracks.filter((candidate) => candidate.type === "group" && candidate.id !== track.id);
	return (
		<div className="grid gap-3">
			<div>
				<h3 className="text-sm font-semibold">{track.name}</h3>
				<div className="text-[10px] uppercase text-muted-foreground">
					{track.type} track · {track.id}
				</div>
			</div>
			<TextField label="Name" value={track.name} onChange={(name) => change({ name })} />
			<TextField label="Color (#RRGGBB)" value={track.color} onChange={(color) => change({ color })} />
			<Field label="Parent Group">
				<select className={inputClass} value={track.parentId ?? ""} onChange={(event) => change({ parentId: event.currentTarget.value || null })}>
					<option value="">Root</option>
					{groups.map((group) => (
						<option key={group.id} value={group.id}>
							{group.name}
						</option>
					))}
				</select>
			</Field>
			<BooleanField label="Muted" value={track.muted} onChange={(muted) => change({ muted })} />
			<BooleanField label="Solo" value={track.solo} onChange={(solo) => change({ solo })} />
			<BooleanField label="Locked" value={track.locked} onChange={(locked) => change({ locked })} />
			{track.type === "group" && <BooleanField label="Collapsed" value={track.collapsed} onChange={(collapsed) => change({ collapsed })} />}
			{track.type === "property" && (
				<>
					<SelectField
						label="Target Type"
						value={track.targetType}
						values={["node", "renderingPipeline"]}
						onChange={(targetType) => change({ targetType, targetId: targetType === "node" ? (track.targetId ?? "node") : null })}
					/>
					{track.targetType === "node" && <TextField label="Target Node ID" value={track.targetId ?? ""} onChange={(targetId) => change({ targetId })} />}
					<TextField label="Property Path" value={track.propertyPath} onChange={(propertyPath) => change({ propertyPath })} />
				</>
			)}
		</div>
	);
}

function ClipInspector(props: ICinematicDocumentInspectorProps & { track: TCinematicTrack; clip: TCinematicClip }): ReactNode {
	const { clip, track } = props;
	const change = (changes: Record<string, unknown>): void => props.commit((current) => updateCinematicClip(current, current.revision, track.id, clip.id, changes));
	return (
		<div className="grid gap-3">
			<div>
				<h3 className="text-sm font-semibold">{clip.name}</h3>
				<div className="text-[10px] uppercase text-muted-foreground">
					{clip.type} clip · {clip.id}
				</div>
			</div>
			<TextField label="Name" value={clip.name} onChange={(name) => change({ name })} />
			<div className="grid grid-cols-2 gap-2">
				<NumberField label="Start Frame" value={clip.startFrame} minimum={0} step={0.01} onChange={(startFrame) => change({ startFrame })} />
				<NumberField label="Duration" value={clip.durationFrames} minimum={0.000001} step={0.01} onChange={(durationFrames) => change({ durationFrames })} />
			</div>
			<div className="grid grid-cols-2 gap-2">
				<NumberField label="Clip In" value={clip.clipInFrame} minimum={0} step={0.01} onChange={(clipInFrame) => change({ clipInFrame })} />
				<NumberField label="Time Scale" value={clip.timeScale} step={0.01} onChange={(timeScale) => change({ timeScale })} />
			</div>
			<div className="grid grid-cols-2 gap-2">
				<NumberField label="Blend In" value={clip.blendInFrames} minimum={0} step={0.01} onChange={(blendInFrames) => change({ blendInFrames })} />
				<NumberField label="Blend Out" value={clip.blendOutFrames} minimum={0} step={0.01} onChange={(blendOutFrames) => change({ blendOutFrames })} />
			</div>
			<BooleanField label="Enabled" value={clip.enabled} onChange={(enabled) => change({ enabled })} />
			<div className="grid grid-cols-2 gap-2">
				<SelectField label="Ease In" value={clip.easeIn} values={["linear", "easeIn", "easeOut", "easeInOut"]} onChange={(easeIn) => change({ easeIn })} />
				<SelectField label="Ease Out" value={clip.easeOut} values={["linear", "easeIn", "easeOut", "easeInOut"]} onChange={(easeOut) => change({ easeOut })} />
			</div>
			<div className="grid grid-cols-2 gap-2">
				<SelectField
					label="Pre Extrapolation"
					value={clip.preExtrapolation}
					values={["none", "hold", "loop", "pingPong", "continue"]}
					onChange={(preExtrapolation) => change({ preExtrapolation })}
				/>
				<SelectField
					label="Post Extrapolation"
					value={clip.postExtrapolation}
					values={["none", "hold", "loop", "pingPong", "continue"]}
					onChange={(postExtrapolation) => change({ postExtrapolation })}
				/>
			</div>
			{clip.type === "animation" && (
				<>
					<TextField label="Animation Group ID/Name" value={clip.animationGroupId} onChange={(animationGroupId) => change({ animationGroupId })} />
					<div className="grid grid-cols-2 gap-2">
						<NumberField label="Source Start" value={clip.sourceStartFrame} minimum={0} step={0.01} onChange={(sourceStartFrame) => change({ sourceStartFrame })} />
						<NumberField label="Source End" value={clip.sourceEndFrame} minimum={0} step={0.01} onChange={(sourceEndFrame) => change({ sourceEndFrame })} />
					</div>
					<NumberField label="Loop Count" value={clip.loopCount} minimum={0} onChange={(loopCount) => change({ loopCount })} />
				</>
			)}
			{clip.type === "audio" && (
				<>
					<TextField label="Sound Node ID" value={clip.soundId} onChange={(soundId) => change({ soundId })} />
					<NumberField label="Volume" value={clip.volume} minimum={0} maximum={8} step={0.01} onChange={(volume) => change({ volume })} />
					<BooleanField label="Loop Sound" value={clip.loop} onChange={(loop) => change({ loop })} />
				</>
			)}
			{clip.type === "video" && (
				<>
					<TextField label="Video Player ID" value={clip.videoPlayerId} onChange={(videoPlayerId) => change({ videoPlayerId })} />
					<NumberField label="Volume Multiplier" value={clip.volume} minimum={0} maximum={1} step={0.01} onChange={(volume) => change({ volume })} />
					<BooleanField label="Loop Video" value={clip.loop} onChange={(loop) => change({ loop })} />
					<BooleanField label="Mute Video Audio" value={clip.muteAudio} onChange={(muteAudio) => change({ muteAudio })} />
				</>
			)}
			{clip.type === "activation" && (
				<>
					<TextField label="Node ID" value={clip.nodeId} onChange={(nodeId) => change({ nodeId })} />
					<BooleanField label="Active" value={clip.active} onChange={(active) => change({ active })} />
				</>
			)}
			{clip.type === "camera" && (
				<>
					<TextField label="Camera ID" value={clip.cameraId} onChange={(cameraId) => change({ cameraId })} />
					<SelectField label="Blend Mode" value={clip.blendMode} values={["cut", "crossFade"]} onChange={(blendMode) => change({ blendMode })} />
				</>
			)}
			{clip.type === "control" && (
				<>
					<SelectField
						label="Target Type"
						value={clip.targetType}
						values={["particleSystem", "cinematic"]}
						onChange={(targetType) => change({ targetType, targetId: targetType === "cinematic" ? "assets/child.cinematic" : "ParticleSystem" })}
					/>
					<TextField label="Target ID / Asset Path" value={clip.targetId} onChange={(targetId) => change({ targetId })} />
					<SelectField label="Action" value={clip.action} values={["play", "stop"]} onChange={(action) => change({ action })} />
				</>
			)}
			{clip.type === "recorder" && (
				<Field label="Recorder Profile">
					<select className={inputClass} value={clip.profileId} onChange={(event) => change({ profileId: event.currentTarget.value })}>
						{props.document.recorderProfiles.map((profile) => (
							<option key={profile.id} value={profile.id}>
								{profile.name}
							</option>
						))}
					</select>
				</Field>
			)}
		</div>
	);
}

function KeyInspector(
	props: ICinematicDocumentInspectorProps & { track: TCinematicTrack; selection: Extract<ICinematicDocumentSelection, { kind: "key" }>; value: TCinematicPropertyKey }
): ReactNode {
	const { value, selection } = props;
	const change = (next: TCinematicPropertyKey): void =>
		props.commit((current) => updateCinematicKey(current, current.revision, selection.trackId, selection.lane, value.id, next));
	const common = (frame: number): TCinematicPropertyKey => ({ ...value, frame });
	return (
		<div className="grid gap-3">
			<div>
				<h3 className="text-sm font-semibold">{value.type === "cut" ? "Property Cut" : "Property Key"}</h3>
				<div className="text-[10px] text-muted-foreground">
					{selection.lane} lane · {value.id}
				</div>
			</div>
			<NumberField label="Frame" value={value.frame} minimum={0} step={0.01} onChange={(frame) => change(common(frame))} />
			{value.type === "cut" ? (
				<>
					<JsonField
						label="Incoming Value"
						value={value.incomingValue}
						onChange={(incomingValue) => change({ ...value, incomingValue: incomingValue as TCinematicPropertyValue })}
					/>
					<JsonField
						label="Outgoing Value"
						value={value.outgoingValue}
						onChange={(outgoingValue) => change({ ...value, outgoingValue: outgoingValue as TCinematicPropertyValue })}
					/>
				</>
			) : (
				<RegularKeyFields value={value} onChange={change} />
			)}
		</div>
	);
}

function RegularKeyFields(props: { value: ICinematicPropertyKey; onChange: (value: ICinematicPropertyKey) => void }): ReactNode {
	return (
		<>
			<JsonField label="Value" value={props.value.value} onChange={(value) => props.onChange({ ...props.value, value: value as TCinematicPropertyValue })} />
			<SelectField
				label="Interpolation"
				value={props.value.interpolation}
				values={["linear", "step", "cubic"]}
				onChange={(interpolation) => props.onChange({ ...props.value, interpolation: interpolation as ICinematicPropertyKey["interpolation"] })}
			/>
			{props.value.interpolation === "cubic" && (
				<>
					<JsonField
						label="In Tangent (null = auto)"
						value={props.value.inTangent ?? null}
						onChange={(inTangent) =>
							props.onChange({ ...props.value, ...(inTangent === null ? { inTangent: undefined } : { inTangent: inTangent as TCinematicPropertyValue }) })
						}
					/>
					<JsonField
						label="Out Tangent (null = auto)"
						value={props.value.outTangent ?? null}
						onChange={(outTangent) =>
							props.onChange({ ...props.value, ...(outTangent === null ? { outTangent: undefined } : { outTangent: outTangent as TCinematicPropertyValue }) })
						}
					/>
				</>
			)}
		</>
	);
}

function MarkerInspector(props: ICinematicDocumentInspectorProps & { track: TCinematicTrack; value: ICinematicMarker }): ReactNode {
	const { value, track } = props;
	const change = (next: ICinematicMarker): void => props.commit((current) => updateCinematicMarker(current, current.revision, track.id, value.id, next));
	return (
		<div className="grid gap-3">
			<div>
				<h3 className="text-sm font-semibold">{value.name}</h3>
				<div className="text-[10px] uppercase text-muted-foreground">
					{value.type} marker · {value.id}
				</div>
			</div>
			<TextField label="Name" value={value.name} onChange={(name) => change({ ...value, name })} />
			<NumberField label="Frame" value={value.frame} minimum={0} step={0.01} onChange={(frame) => change({ ...value, frame })} />
			<SelectField label="Type" value={value.type} values={["signal", "event"]} onChange={(type) => change({ ...value, type: type as ICinematicMarker["type"] })} />
			<BooleanField label="Emit Once Per Play" value={value.emitOnce} onChange={(emitOnce) => change({ ...value, emitOnce })} />
			<BooleanField label="Retroactive On Seek" value={value.retroactive} onChange={(retroactive) => change({ ...value, retroactive })} />
			<JsonField label="Payload" value={value.payload} onChange={(payload) => change({ ...value, payload: payload as TCinematicJsonValue })} />
		</div>
	);
}

function ProfileInspector(props: ICinematicDocumentInspectorProps & { profileId: string }): ReactNode {
	const profile = props.document.recorderProfiles.find((candidate) => candidate.id === props.profileId);
	if (!profile) {
		return <DocumentSettings {...props} />;
	}
	const change = (changes: Parameters<typeof updateCinematicRecorderProfile>[3]): void =>
		props.commit((current) => updateCinematicRecorderProfile(current, current.revision, profile.id, changes));
	return (
		<div className="grid gap-3">
			<div>
				<h3 className="text-sm font-semibold">{profile.name}</h3>
				<div className="text-[10px] uppercase text-muted-foreground">capture profile · {profile.id}</div>
			</div>
			<TextField label="Name" value={profile.name} onChange={(name) => change({ name })} />
			<SelectField
				label="Format"
				value={profile.format}
				values={["webm", "mp4", "png", "jpeg", "webp"]}
				onChange={(format) => change({ format: format as typeof profile.format })}
			/>
			<div className="grid grid-cols-2 gap-2">
				<NumberField label="Width" value={profile.width} minimum={16} maximum={8192} onChange={(width) => change({ width })} />
				<NumberField label="Height" value={profile.height} minimum={16} maximum={8192} onChange={(height) => change({ height })} />
			</div>
			<NumberField label="Output FPS" value={profile.framesPerSecond} minimum={1} maximum={240} step={0.01} onChange={(framesPerSecond) => change({ framesPerSecond })} />
			<NumberField label="Quality" value={profile.quality} minimum={0} maximum={1} step={0.01} onChange={(quality) => change({ quality })} />
			<BooleanField label="Include Audio" value={profile.includeAudio} onChange={(includeAudio) => change({ includeAudio })} />
			{profile.includeAudio && (
				<div className="rounded border bg-secondary/40 p-2 text-xs text-muted-foreground">
					{profile.format === "webm" || profile.format === "mp4"
						? `Offline 48 kHz stereo master-bus capture · ${profile.format === "webm" ? "Opus" : "AAC"}`
						: "Audio muxing is available only for WebM and MP4 profiles."}
				</div>
			)}
		</div>
	);
}

export function CinematicDocumentInspector(props: ICinematicDocumentInspectorProps): ReactNode {
	let content: ReactNode = <DocumentSettings {...props} />;
	const selection = props.selection;
	if (selection?.kind === "profile") {
		content = <ProfileInspector {...props} profileId={selection.itemId} />;
	} else if (selection) {
		const track = trackFor(props.document, selection.trackId);
		if (track && selection.kind === "track") {
			content = <TrackInspector {...props} track={track} />;
		} else if (track && selection.kind === "clip" && "clips" in track) {
			const clip = track.clips.find((candidate) => candidate.id === selection.itemId);
			if (clip) {
				content = <ClipInspector {...props} track={track} clip={clip} />;
			}
		} else if (track && selection.kind === "key") {
			const value = keyFor(track, selection);
			if (value) {
				content = <KeyInspector {...props} track={track} selection={selection} value={value} />;
			}
		} else if (track?.type === "signal" && selection.kind === "marker") {
			const marker = track.markers.find((candidate) => candidate.id === selection.itemId);
			if (marker) {
				content = <MarkerInspector {...props} track={track} value={marker} />;
			}
		}
	}
	return (
		<aside className="w-80 shrink-0 overflow-y-auto border-l bg-secondary/20 p-3">
			{content}
			{props.document.recorderProfiles.length > 0 && (
				<div className="mt-6 border-t pt-3">
					<div className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">Capture Profiles</div>
					<div className="grid gap-1">
						{props.document.recorderProfiles.map((profile) => (
							<Button
								key={profile.id}
								size="sm"
								variant={props.selection?.kind === "profile" && props.selection.itemId === profile.id ? "default" : "ghost"}
								className="justify-start"
								onClick={() => props.onSelection({ kind: "profile", trackId: "", itemId: profile.id })}
							>
								{profile.name}
							</Button>
						))}
					</div>
				</div>
			)}
		</aside>
	);
}
