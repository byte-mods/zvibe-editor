import { dirname, relative } from "path/posix";

import { DragEvent, MouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Scene as CoreScene } from "@babylonjs/core/scene";

import {
	CinematicScenePlayer,
	ICinematicDocument,
	TCinematicKeyLane,
	TCinematicPropertyKey,
	TCinematicTrack,
	createCinematicClip,
	createCinematicKey,
	createCinematicMarker,
	createCinematicRecorderProfile,
	createCinematicTrack,
	cinematicDocumentLimits,
	deleteCinematicClip,
	deleteCinematicKey,
	deleteCinematicMarker,
	deleteCinematicRecorderProfile,
	deleteCinematicTrack,
	forkCinematicDocument,
	getCinematicFingerprint,
	moveCinematicTrack,
	updateCinematicClip,
	updateCinematicKey,
	updateCinematicMarker,
	updateCinematicTrack,
} from "babylonjs-editor-tools";

import { Editor } from "../../../main";
import { saveSingleFileDialog } from "../../../../tools/dialog";
import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import { showConfirm } from "../../../../ui/dialog";

import { createCinematicDocumentFile, saveCinematicDocument } from "../serialization/document";
import { CinematicFileCaptureSink, createEditorMp4Transcoder, ensureCinematicCaptureExtension } from "./capture";
import { renderCinematicOfflineAudio } from "./audio-capture";
import {
	createDefaultCinematicClip,
	createDefaultCinematicCut,
	createDefaultCinematicKey,
	createDefaultCinematicMarker,
	createDefaultCinematicTrack,
	createDefaultRecorderProfile,
} from "./defaults";
import { CinematicDocumentInspector, ICinematicDocumentSelection } from "./inspector";
import { CinematicDocumentRecorder } from "./recorder";

export interface ICinematicDocumentEditorProps {
	editor: Editor;
	absolutePath: string;
	document: ICinematicDocument;
	fingerprint: string;
}

const trackTypes: TCinematicTrack["type"][] = ["group", "property", "animation", "audio", "video", "activation", "camera", "signal", "control", "recorder"];

function keysForTrack(track: TCinematicTrack): { lane: TCinematicKeyLane; keys: TCinematicPropertyKey[] } | null {
	if (track.type === "property") {
		return { lane: "property", keys: track.keys };
	}
	if (track.type === "animation") {
		return { lane: "weight", keys: track.weightKeys };
	}
	if (track.type === "audio") {
		return { lane: "volume", keys: track.volumeKeys };
	}
	return null;
}

function hierarchyDepth(document: ICinematicDocument, track: TCinematicTrack): number {
	let depth = 0;
	let parentId = track.parentId;
	while (parentId !== null && depth < document.tracks.length) {
		const parent = document.tracks.find((candidate) => candidate.id === parentId);
		if (!parent) {
			break;
		}
		++depth;
		parentId = parent.parentId;
	}
	return depth;
}

function hiddenByCollapsedGroup(document: ICinematicDocument, track: TCinematicTrack): boolean {
	let parentId = track.parentId;
	while (parentId !== null) {
		const parent = document.tracks.find((candidate) => candidate.id === parentId);
		if (!parent) {
			return false;
		}
		if (parent.type === "group" && parent.collapsed) {
			return true;
		}
		parentId = parent.parentId;
	}
	return false;
}

interface ICinematicDragOrigin {
	clientX: number;
}

export function CinematicDocumentEditor(props: ICinematicDocumentEditorProps): ReactNode {
	const [document, setDocument] = useState(() => structuredClone(props.document));
	const [persistedRevision, setPersistedRevision] = useState(props.document.revision);
	const [persistedFingerprint, setPersistedFingerprint] = useState(props.fingerprint);
	const [past, setPast] = useState<ICinematicDocument[]>([]);
	const [future, setFuture] = useState<ICinematicDocument[]>([]);
	const [selection, setSelection] = useState<ICinematicDocumentSelection | null>(null);
	const [currentFrame, setCurrentFrame] = useState(0);
	const [zoom, setZoom] = useState(4);
	const [playing, setPlaying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [captureProgress, setCaptureProgress] = useState<number | null>(null);
	const player = useRef<CinematicScenePlayer | null>(null);
	const animationFrame = useRef<number | null>(null);
	const previousTime = useRef<number | null>(null);
	const dragOrigin = useRef<ICinematicDragOrigin | null>(null);
	const captureAbort = useRef<AbortController | null>(null);

	const dirty = getCinematicFingerprint(document) !== persistedFingerprint;
	const displayDuration = Math.max(document.durationFrames, document.framesPerSecond * 5, 1);
	const timelineWidth = Math.min(200_000, Math.max(800, displayDuration * zoom));
	const pixelsPerFrame = timelineWidth / displayDuration;
	const visibleTracks = useMemo(() => document.tracks.filter((track) => !hiddenByCollapsedGroup(document, track)), [document]);

	const stopPreview = useCallback((): void => {
		if (animationFrame.current !== null) {
			cancelAnimationFrame(animationFrame.current);
			animationFrame.current = null;
		}
		previousTime.current = null;
		player.current?.dispose();
		player.current = null;
		setPlaying(false);
	}, []);

	useEffect(() => stopPreview, [stopPreview]);

	const ensurePlayer = useCallback((): CinematicScenePlayer => {
		player.current ??= new CinematicScenePlayer(document, props.editor.layout.preview.scene as unknown as CoreScene, {
			onSignal: (occurrence) => toast.info(`Signal: ${occurrence.marker.name}`),
			onEvent: (occurrence) => toast.info(`Timeline event: ${occurrence.marker.name}`),
			onControl: (sample, entering) => entering && sample.targetType === "cinematic" && toast.info(`Nested cinematic: ${sample.targetId}`),
			onRecorder: (sample, entering) => entering && toast.info(`Recorder profile: ${sample.profileId}`),
		});
		return player.current;
	}, [document, props.editor]);

	const previewFrame = useCallback(
		(frame: number): void => {
			const bounded = Math.min(document.durationFrames, Math.max(0, frame));
			setCurrentFrame(bounded);
			if (!document.durationFrames) {
				return;
			}
			try {
				ensurePlayer().seek(bounded);
				setError(null);
			} catch (exception) {
				setError(exception instanceof Error ? exception.message : String(exception));
			}
		},
		[document.durationFrames, ensurePlayer]
	);

	const commit = useCallback(
		(action: (current: ICinematicDocument) => ICinematicDocument): void => {
			stopPreview();
			try {
				const next = action(document);
				setPast((values) => [...values.slice(-99), document]);
				setFuture([]);
				setDocument(next);
				setCurrentFrame((frame) => Math.min(frame, next.durationFrames));
				setError(null);
			} catch (exception) {
				setError(exception instanceof Error ? exception.message : String(exception));
			}
		},
		[document, stopPreview]
	);

	const undo = useCallback((): void => {
		const previous = past[past.length - 1];
		if (!previous) {
			return;
		}
		stopPreview();
		setPast(past.slice(0, -1));
		setFuture([document, ...future].slice(0, 100));
		setDocument(previous);
		setCurrentFrame((frame) => Math.min(frame, previous.durationFrames));
	}, [document, future, past, stopPreview]);

	const redo = useCallback((): void => {
		const next = future[0];
		if (!next) {
			return;
		}
		stopPreview();
		setPast([...past, document].slice(-100));
		setFuture(future.slice(1));
		setDocument(next);
		setCurrentFrame((frame) => Math.min(frame, next.durationFrames));
	}, [document, future, past, stopPreview]);

	const identitySeed = useCallback(
		(absolutePath: string): string => {
			const projectDirectory = props.editor.state.projectPath ? dirname(props.editor.state.projectPath) : dirname(props.absolutePath);
			return relative(projectDirectory, absolutePath).replace(/\\/g, "/");
		},
		[props.absolutePath, props.editor.state.projectPath]
	);

	const save = useCallback(async (): Promise<void> => {
		stopPreview();
		try {
			const saved = await saveCinematicDocument(
				props.absolutePath,
				document,
				{ expectedRevision: persistedRevision, expectedFingerprint: persistedFingerprint },
				{ identitySeed: identitySeed(props.absolutePath) }
			);
			setDocument(saved.document);
			setPersistedRevision(saved.document.revision);
			setPersistedFingerprint(saved.fingerprint);
			setPast([]);
			setFuture([]);
			setError(null);
			toast.success("Cinematic document saved.");
		} catch (exception) {
			setError(exception instanceof Error ? exception.message : String(exception));
		}
	}, [document, identitySeed, persistedFingerprint, persistedRevision, props.absolutePath, stopPreview]);

	const saveAs = useCallback(async (): Promise<void> => {
		stopPreview();
		const destination = saveSingleFileDialog({ title: "Save Cinematic File", filters: [{ name: "Cinematic Files", extensions: ["cinematic"] }] });
		if (!destination) {
			return;
		}
		try {
			const seed = identitySeed(destination);
			await createCinematicDocumentFile(destination, forkCinematicDocument(document, seed), { identitySeed: seed });
			toast.success("Cinematic copy saved with new asset identity.");
		} catch (exception) {
			setError(exception instanceof Error ? exception.message : String(exception));
		}
	}, [document, identitySeed, stopPreview]);

	const tick = useCallback(
		(time: number): void => {
			const active = player.current;
			if (!active) {
				return;
			}
			const previous = previousTime.current ?? time;
			previousTime.current = time;
			try {
				const result = active.advance((time - previous) / 1000);
				setCurrentFrame(result.frame);
				if (result.completed) {
					stopPreview();
					return;
				}
				animationFrame.current = requestAnimationFrame(tick);
			} catch (exception) {
				setError(exception instanceof Error ? exception.message : String(exception));
				stopPreview();
			}
		},
		[stopPreview]
	);

	const play = useCallback((): void => {
		if (playing || !document.durationFrames) {
			return;
		}
		try {
			const active = ensurePlayer();
			active.seek(currentFrame >= document.durationFrames ? 0 : currentFrame);
			active.play();
			setPlaying(true);
			previousTime.current = null;
			animationFrame.current = requestAnimationFrame(tick);
		} catch (exception) {
			setError(exception instanceof Error ? exception.message : String(exception));
			stopPreview();
		}
	}, [currentFrame, document.durationFrames, ensurePlayer, playing, stopPreview, tick]);

	const addTrack = useCallback(
		(type: TCinematicTrack["type"]): void => {
			const value = createDefaultCinematicTrack(document, props.editor.layout.preview.scene, type);
			commit((current) => createCinematicTrack(current, current.revision, value));
			setSelection({ kind: "track", trackId: value.id });
		},
		[commit, document, props.editor]
	);

	const selectedTrack = selection ? (document.tracks.find((track) => track.id === selection.trackId) ?? null) : null;
	const selectedRecorderClip =
		selection?.kind === "clip" && selectedTrack?.type === "recorder" ? (selectedTrack.clips.find((clip) => clip.id === selection.itemId) ?? null) : null;
	const selectedProfileId = selection?.kind === "profile" ? selection.itemId : selectedRecorderClip?.profileId;
	const selectedProfile = (selectedProfileId ? document.recorderProfiles.find((profile) => profile.id === selectedProfileId) : null) ?? document.recorderProfiles[0] ?? null;

	const addItem = useCallback((): void => {
		if (!selectedTrack) {
			return;
		}
		if (selectedTrack.type === "signal") {
			const marker = createDefaultCinematicMarker(currentFrame);
			commit((current) => createCinematicMarker(current, current.revision, selectedTrack.id, marker));
			setSelection({ kind: "marker", trackId: selectedTrack.id, itemId: marker.id });
			return;
		}
		if (["property", "animation", "audio"].includes(selectedTrack.type)) {
			const value = createDefaultCinematicKey(selectedTrack, currentFrame);
			commit((current) => createCinematicKey(current, current.revision, selectedTrack.id, value.lane, value.key));
			setSelection({ kind: "key", trackId: selectedTrack.id, itemId: value.key.id, lane: value.lane });
			return;
		}
		if (selectedTrack.type !== "group") {
			try {
				const startFrame = document.durationMode === "fixed" ? Math.min(currentFrame, Math.max(0, document.durationFrames - 1)) : currentFrame;
				const clip = createDefaultCinematicClip(document, props.editor.layout.preview.scene, selectedTrack, startFrame);
				commit((current) => createCinematicClip(current, current.revision, selectedTrack.id, clip));
				setSelection({ kind: "clip", trackId: selectedTrack.id, itemId: clip.id });
			} catch (exception) {
				setError(exception instanceof Error ? exception.message : String(exception));
			}
		}
	}, [commit, currentFrame, document, props.editor, selectedTrack]);

	const addCut = useCallback((): void => {
		if (!selectedTrack || !["property", "animation", "audio"].includes(selectedTrack.type)) {
			return;
		}
		try {
			const value = createDefaultCinematicCut(selectedTrack, currentFrame);
			commit((current) => createCinematicKey(current, current.revision, selectedTrack.id, value.lane, value.key));
			setSelection({ kind: "key", trackId: selectedTrack.id, itemId: value.key.id, lane: value.lane });
		} catch (exception) {
			setError(exception instanceof Error ? exception.message : String(exception));
		}
	}, [commit, currentFrame, selectedTrack]);

	const deleteSelection = useCallback(async (): Promise<void> => {
		if (!selection) {
			return;
		}
		if (!(await showConfirm("Delete Timeline Item?", `Delete the selected ${selection.kind}? This can be undone until the document is closed.`, { confirmText: "Delete" }))) {
			return;
		}
		commit((current) => {
			switch (selection.kind) {
				case "track":
					return deleteCinematicTrack(current, current.revision, selection.trackId, true);
				case "clip":
					return deleteCinematicClip(current, current.revision, selection.trackId, selection.itemId);
				case "key":
					return deleteCinematicKey(current, current.revision, selection.trackId, selection.lane, selection.itemId);
				case "marker":
					return deleteCinematicMarker(current, current.revision, selection.trackId, selection.itemId);
				case "profile":
					return deleteCinematicRecorderProfile(current, current.revision, selection.itemId);
			}
		});
		setSelection(null);
	}, [commit, selection]);

	const seekFromLane = useCallback(
		(event: MouseEvent<HTMLDivElement>): void => {
			const bounds = event.currentTarget.getBoundingClientRect();
			previewFrame(Math.round((event.clientX - bounds.left) / pixelsPerFrame));
		},
		[pixelsPerFrame, previewFrame]
	);

	const beginDrag = useCallback((event: DragEvent<HTMLElement>): void => {
		event.stopPropagation();
		event.dataTransfer.effectAllowed = "move";
		dragOrigin.current = { clientX: event.clientX };
	}, []);

	const dragDeltaFrames = useCallback(
		(event: DragEvent<HTMLElement>): number | null => {
			event.stopPropagation();
			const origin = dragOrigin.current;
			dragOrigin.current = null;
			if (!origin || event.clientX <= 0) {
				return null;
			}
			return Math.round((event.clientX - origin.clientX) / pixelsPerFrame);
		},
		[pixelsPerFrame]
	);

	const boundedFrame = useCallback(
		(frame: number, reservedFrames = 0): number => {
			const maximum =
				document.durationMode === "fixed" ? Math.max(0, document.durationFrames - reservedFrames) : cinematicDocumentLimits.maximumDurationFrames - reservedFrames;
			return Math.min(maximum, Math.max(0, frame));
		},
		[document.durationFrames, document.durationMode]
	);

	const capture = useCallback(async (): Promise<void> => {
		if (!selectedProfile) {
			setError("Create a capture profile before recording this Timeline.");
			return;
		}
		if (captureAbort.current) {
			captureAbort.current.abort(new Error("Cinematic capture was cancelled by the user."));
			return;
		}
		const destination = saveSingleFileDialog({
			title: `Capture ${selectedProfile.name}`,
			defaultPath: `${document.name}.${selectedProfile.format}`,
			filters: [{ name: `${selectedProfile.format.toUpperCase()} Capture`, extensions: [selectedProfile.format] }],
		});
		if (!destination) {
			return;
		}
		stopPreview();
		const preview = props.editor.layout.preview;
		const canvas = preview.canvas;
		if (!canvas) {
			setError("The scene preview canvas is unavailable for capture.");
			return;
		}
		const controller = new AbortController();
		captureAbort.current = controller;
		const previous = {
			renderScene: preview.renderScene,
			renderEvenInBackground: preview.engine.renderEvenInBackground,
			constantDelta: preview.scene.useConstantAnimationDeltaTime,
			width: canvas.width,
			height: canvas.height,
			axis: preview.axis.enabled,
			icons: preview.icons.enabled,
		};
		try {
			setCaptureProgress(0);
			setError(null);
			preview.setRenderScene(false);
			preview.engine.renderEvenInBackground = true;
			preview.scene.useConstantAnimationDeltaTime = true;
			preview.axis.stop();
			preview.icons.stop();
			preview.engine.setSize(selectedProfile.width, selectedProfile.height);
			const recorder = new CinematicDocumentRecorder(document, preview.scene as unknown as CoreScene);
			const sink = new CinematicFileCaptureSink({
				canvas,
				destination: ensureCinematicCaptureExtension(destination, selectedProfile.format),
				transcodeToMp4: createEditorMp4Transcoder(props.editor),
				renderAudio: (plan) => renderCinematicOfflineAudio(document, preview.scene as unknown as CoreScene, plan),
			});
			const result = await recorder.record(selectedProfile.id, sink, {
				range: selectedRecorderClip
					? { startFrame: selectedRecorderClip.startFrame, endFrame: selectedRecorderClip.startFrame + selectedRecorderClip.durationFrames }
					: undefined,
				signal: controller.signal,
				onRenderFrame: () => preview.scene.render(),
				onProgress: (completed, total) => setCaptureProgress((completed / total) * 100),
			});
			toast.success(`Captured ${result.plan.frameCount} frames${result.output.audio ? " with offline master audio" : ""} to ${result.output.destination}`);
		} catch (exception) {
			setError(exception instanceof Error ? exception.message : String(exception));
		} finally {
			preview.engine.setSize(previous.width, previous.height);
			preview.engine.renderEvenInBackground = previous.renderEvenInBackground;
			preview.scene.useConstantAnimationDeltaTime = previous.constantDelta;
			preview.setRenderScene(previous.renderScene);
			if (previous.axis) {
				preview.axis.start();
			}
			if (previous.icons) {
				preview.icons.start();
			}
			captureAbort.current = null;
			setCaptureProgress(null);
		}
	}, [document, props.editor, selectedProfile, selectedRecorderClip, stopPreview]);

	const ticks = useMemo(() => {
		const step = Math.max(1, document.framesPerSecond);
		return Array.from({ length: Math.min(200, Math.floor(displayDuration / step) + 1) }, (_value, index) => index * step);
	}, [displayDuration, document.framesPerSecond]);

	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b bg-secondary/60 px-3">
				<Button size="sm" onClick={() => void save()} disabled={!dirty}>
					Save
				</Button>
				<Button size="sm" variant="secondary" onClick={() => void saveAs()}>
					Save As
				</Button>
				<div className="mx-1 h-6 w-px bg-border" />
				<Button size="sm" variant="secondary" disabled={!past.length} onClick={undo}>
					Undo
				</Button>
				<Button size="sm" variant="secondary" disabled={!future.length} onClick={redo}>
					Redo
				</Button>
				<div className="mx-1 h-6 w-px bg-border" />
				<Button size="sm" variant={playing ? "destructive" : "default"} onClick={playing ? stopPreview : play}>
					{playing ? "Stop" : "Play"}
				</Button>
				<Button size="sm" variant="secondary" onClick={stopPreview}>
					Reset Preview
				</Button>
				<Button size="sm" variant={captureProgress === null ? "secondary" : "destructive"} onClick={() => void capture()}>
					{captureProgress === null ? "Capture" : `Cancel Capture ${Math.round(captureProgress)}%`}
				</Button>
				<Button size="sm" variant="secondary" onClick={() => previewFrame(Math.max(0, currentFrame - 1))}>
					-1
				</Button>
				<Input
					className="h-8 w-24"
					type="number"
					min={0}
					max={document.durationFrames}
					value={currentFrame}
					onChange={(event) => previewFrame(Number(event.currentTarget.value))}
				/>
				<Button size="sm" variant="secondary" onClick={() => previewFrame(Math.min(document.durationFrames, currentFrame + 1))}>
					+1
				</Button>
				<div className="ml-auto flex items-center gap-2 text-xs">
					<span>{document.name}</span>
					<span className="rounded bg-muted px-2 py-1 font-mono">r{document.revision}</span>
					{dirty && <span className="text-amber-400">Unsaved</span>}
				</div>
			</div>

			<div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs">
				<Button size="sm" variant="secondary" className="h-7" onClick={() => setSelection(null)}>
					Settings
				</Button>
				<div className="h-5 w-px bg-border" />
				<span className="font-semibold">Add Track</span>
				{trackTypes.map((type) => (
					<Button key={type} size="sm" variant="ghost" className="h-7 px-2 capitalize" onClick={() => addTrack(type)}>
						{type}
					</Button>
				))}
				<div className="ml-auto flex items-center gap-2">
					<Button size="sm" variant="secondary" className="h-7" disabled={!selectedTrack || selectedTrack.type === "group"} onClick={addItem}>
						Add Item @ {currentFrame}
					</Button>
					<Button
						size="sm"
						variant="secondary"
						className="h-7"
						disabled={!selectedTrack || !["property", "animation", "audio"].includes(selectedTrack.type)}
						onClick={addCut}
					>
						Add Cut @ {currentFrame}
					</Button>
					<Button size="sm" variant="destructive" className="h-7" disabled={!selection} onClick={() => void deleteSelection()}>
						Delete
					</Button>
					<Button
						size="sm"
						variant="secondary"
						className="h-7"
						onClick={() => {
							const profile = createDefaultRecorderProfile();
							commit((current) => createCinematicRecorderProfile(current, current.revision, profile));
							setSelection({ kind: "profile", trackId: "", itemId: profile.id });
						}}
					>
						Add Capture Profile
					</Button>
					<span>Zoom</span>
					<input type="range" min={0.25} max={20} step={0.25} value={zoom} onChange={(event) => setZoom(Number(event.currentTarget.value))} />
				</div>
			</div>

			{error && <div className="shrink-0 border-b border-red-800 bg-red-950/70 px-3 py-2 text-xs text-red-200">{error}</div>}

			<div className="flex min-h-0 flex-1">
				<div className="min-w-0 flex-1 overflow-auto">
					<div style={{ width: 320 + timelineWidth }}>
						<div className="sticky top-0 z-20 flex h-8 border-b bg-secondary">
							<div className="sticky left-0 z-30 flex w-80 shrink-0 items-center border-r bg-secondary px-3 text-xs font-semibold">Tracks</div>
							<div className="relative h-8" style={{ width: timelineWidth }} onClick={seekFromLane}>
								{ticks.map((frame) => (
									<div
										key={frame}
										className="absolute bottom-0 top-0 border-l border-border/70 text-[9px] text-muted-foreground"
										style={{ left: frame * pixelsPerFrame }}
									>
										<span className="ml-1">{frame}</span>
									</div>
								))}
								<div className="absolute bottom-0 top-0 z-20 w-px bg-red-500" style={{ left: currentFrame * pixelsPerFrame }} />
							</div>
						</div>

						{visibleTracks.map((track) => {
							const index = document.tracks.indexOf(track);
							const selected = selection?.trackId === track.id;
							const keyLane = keysForTrack(track);
							const clips = "clips" in track ? track.clips : [];
							const markers = track.type === "signal" ? track.markers : [];
							return (
								<div key={track.id} className={`flex h-12 border-b ${selected ? "bg-primary/10" : "odd:bg-muted/10"}`}>
									<div
										className="sticky left-0 z-10 flex w-80 shrink-0 items-center gap-1 border-r bg-background px-2"
										onClick={() => setSelection({ kind: "track", trackId: track.id })}
									>
										<div className="h-7 w-1 rounded" style={{ backgroundColor: track.color, marginLeft: hierarchyDepth(document, track) * 12 }} />
										<div className="min-w-0 flex-1 truncate text-xs">
											<span className="font-semibold">{track.name}</span>
											<span className="ml-2 text-[10px] uppercase text-muted-foreground">{track.type}</span>
										</div>
										<Button
											size="sm"
											variant={track.muted ? "default" : "ghost"}
											className="h-6 w-6 p-0"
											onClick={(event) => {
												event.stopPropagation();
												commit((current) => updateCinematicTrack(current, current.revision, track.id, { muted: !track.muted }));
											}}
										>
											M
										</Button>
										<Button
											size="sm"
											variant={track.solo ? "default" : "ghost"}
											className="h-6 w-6 p-0"
											onClick={(event) => {
												event.stopPropagation();
												commit((current) => updateCinematicTrack(current, current.revision, track.id, { solo: !track.solo }));
											}}
										>
											S
										</Button>
										<Button
											size="sm"
											variant={track.locked ? "default" : "ghost"}
											className="h-6 w-6 p-0"
											onClick={(event) => {
												event.stopPropagation();
												commit((current) => updateCinematicTrack(current, current.revision, track.id, { locked: !track.locked }));
											}}
										>
											L
										</Button>
										<Button
											size="sm"
											variant="ghost"
											className="h-6 w-6 p-0"
											disabled={index === 0 || track.locked}
											onClick={(event) => {
												event.stopPropagation();
												commit((current) => moveCinematicTrack(current, current.revision, track.id, index - 1, track.parentId));
											}}
										>
											↑
										</Button>
										<Button
											size="sm"
											variant="ghost"
											className="h-6 w-6 p-0"
											disabled={index === document.tracks.length - 1 || track.locked}
											onClick={(event) => {
												event.stopPropagation();
												commit((current) => moveCinematicTrack(current, current.revision, track.id, index + 1, track.parentId));
											}}
										>
											↓
										</Button>
									</div>
									<div className={`relative h-12 ${track.muted ? "opacity-35" : ""}`} style={{ width: timelineWidth }} onClick={seekFromLane}>
										{clips.map((clip) => (
											<button
												key={clip.id}
												draggable={!track.locked}
												className="absolute top-2 h-8 overflow-hidden rounded border border-white/20 px-2 text-left text-[10px] text-white shadow"
												style={{
													left: clip.startFrame * pixelsPerFrame,
													width: Math.max(8, clip.durationFrames * pixelsPerFrame),
													backgroundColor: track.color,
												}}
												onClick={(event) => {
													event.stopPropagation();
													setSelection({ kind: "clip", trackId: track.id, itemId: clip.id });
												}}
												onDragStart={beginDrag}
												onDragEnd={(event) => {
													const delta = dragDeltaFrames(event);
													if (delta !== null && delta !== 0) {
														commit((current) =>
															updateCinematicClip(current, current.revision, track.id, clip.id, {
																startFrame: boundedFrame(clip.startFrame + delta, clip.durationFrames),
															})
														);
													}
												}}
												title={`${clip.name} · ${clip.startFrame}–${clip.startFrame + clip.durationFrames}`}
											>
												{clip.name}
												<span
													draggable={!track.locked}
													className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize border-l border-white/40 bg-black/15"
													onClick={(event) => event.stopPropagation()}
													onDragStart={beginDrag}
													onDragEnd={(event) => {
														const delta = dragDeltaFrames(event);
														if (delta !== null && delta !== 0) {
															const maximum =
																document.durationMode === "fixed"
																	? Math.max(1, document.durationFrames - clip.startFrame)
																	: cinematicDocumentLimits.maximumDurationFrames - clip.startFrame;
															commit((current) =>
																updateCinematicClip(current, current.revision, track.id, clip.id, {
																	durationFrames: Math.min(maximum, Math.max(1, clip.durationFrames + delta)),
																})
															);
														}
													}}
												/>
											</button>
										))}
										{keyLane?.keys.map((key) => (
											<button
												key={key.id}
												draggable={!track.locked}
												className="absolute top-4 h-4 w-4 -translate-x-2 rotate-45 border border-white bg-sky-500"
												style={{ left: key.frame * pixelsPerFrame }}
												onClick={(event) => {
													event.stopPropagation();
													setSelection({ kind: "key", trackId: track.id, itemId: key.id, lane: keyLane.lane });
												}}
												onDragStart={beginDrag}
												onDragEnd={(event) => {
													const delta = dragDeltaFrames(event);
													if (delta !== null && delta !== 0) {
														commit((current) =>
															updateCinematicKey(current, current.revision, track.id, keyLane.lane, key.id, {
																...key,
																frame: boundedFrame(key.frame + delta),
															})
														);
													}
												}}
												title={`${key.type} @ ${key.frame}`}
											/>
										))}
										{markers.map((marker) => (
											<button
												key={marker.id}
												draggable={!track.locked}
												className="absolute top-1 h-10 w-3 -translate-x-1.5 bg-amber-400 [clip-path:polygon(50%_0,100%_20%,70%_100%,30%_100%,0_20%)]"
												style={{ left: marker.frame * pixelsPerFrame }}
												onClick={(event) => {
													event.stopPropagation();
													setSelection({ kind: "marker", trackId: track.id, itemId: marker.id });
												}}
												onDragStart={beginDrag}
												onDragEnd={(event) => {
													const delta = dragDeltaFrames(event);
													if (delta !== null && delta !== 0) {
														commit((current) =>
															updateCinematicMarker(current, current.revision, track.id, marker.id, {
																...marker,
																frame: boundedFrame(marker.frame + delta),
															})
														);
													}
												}}
												title={`${marker.name} @ ${marker.frame}`}
											/>
										))}
										<div className="absolute bottom-0 top-0 z-10 w-px bg-red-500/80" style={{ left: currentFrame * pixelsPerFrame }} />
									</div>
								</div>
							);
						})}
						{!document.tracks.length && (
							<div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Add a track to begin authoring this Timeline.</div>
						)}
					</div>
				</div>

				<CinematicDocumentInspector
					key={`${document.revision}:${selection?.kind}:${selection && "itemId" in selection ? selection.itemId : selection?.trackId}`}
					document={document}
					selection={selection}
					commit={commit}
					onSelection={setSelection}
				/>
			</div>
		</div>
	);
}
