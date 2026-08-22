import { basename } from "path/posix";

import { Divider } from "@blueprintjs/core";
import { BiSolidVideos } from "react-icons/bi";
import {
	IVideoImporterPlatformOverride,
	IVideoImporterPlatformOverrides,
	IVideoImportResult,
	normalizeVideoImporterPlatformOverrides,
	serializeVideoImporterPlatformOverrides,
} from "babylonjs-editor-tools";

import { FileInspectorObject } from "../file";

export interface IEditorInspectorVideoComponentProps {
	object: FileInspectorObject;
	importedPath?: string | null;
	importedCurrent?: boolean;
	result?: IVideoImportResult | null;
	settings?: Record<string, unknown> | null;
	onPlatformOverridesChange?: (value: string) => void;
}

function parsedOverrides(value: unknown): IVideoImporterPlatformOverrides {
	try {
		return normalizeVideoImporterPlatformOverrides(value);
	} catch {
		return {};
	}
}

export function EditorInspectorVideoComponent(props: IEditorInspectorVideoComponentProps) {
	const source = props.importedCurrent && props.importedPath ? props.importedPath : props.object.absolutePath;
	const overrides = parsedOverrides(props.settings?.platformOverrides);
	const updateOverride = (platform: "web" | "desktop", patch: Partial<IVideoImporterPlatformOverride>): void => {
		const current = overrides[platform] ?? { enabled: false };
		props.onPlatformOverridesChange?.(serializeVideoImporterPlatformOverrides({ ...overrides, [platform]: { ...current, ...patch } }));
	};
	const removeOverride = (platform: "web" | "desktop"): void => {
		const next = { ...overrides };
		delete next[platform];
		props.onPlatformOverridesChange?.(serializeVideoImporterPlatformOverrides(next));
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2 justify-center items-center text-xl font-bold">
				<BiSolidVideos size="24px" />
				{basename(props.object.absolutePath)}
			</div>
			<Divider />
			<div className="px-5 text-xs text-muted-foreground">{props.importedCurrent ? "Imported preview artifact" : "Original source preview"}</div>
			<video key={source} controls className="w-full max-h-80 px-5" src={source} />
			{props.result && (
				<div className="mx-5 grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-border p-2 text-xs">
					<span className="text-muted-foreground">Output</span>
					<span>
						{props.result.output.videoCodec} · {props.result.output.width}×{props.result.output.height} · {props.result.output.frameRate.toFixed(2)} fps
					</span>
					<span className="text-muted-foreground">Color</span>
					<span>
						{props.result.output.colorSpace ?? "unknown"} / {props.result.output.colorPrimaries ?? "unknown primaries"} /{" "}
						{props.result.output.colorTransfer ?? "unknown transfer"} / {props.result.output.colorRange ?? "unknown range"}
					</span>
					<span className="text-muted-foreground">Encoder</span>
					<span>{props.result.encoder ? `${props.result.encoder.ffmpegName}${props.result.encoder.hardware ? " (hardware)" : " (software)"}` : "preserved source"}</span>
					<span className="text-muted-foreground">Target policy</span>
					<span
						className={
							props.result.compatibility.status === "unsupported"
								? "text-red-400"
								: props.result.compatibility.status === "conditional"
									? "text-amber-400"
									: "text-emerald-400"
						}
					>
						{props.result.platform} · {props.result.compatibility.status}
					</span>
					<span className="col-span-2 text-muted-foreground">{props.result.compatibility.recommendation}</span>
				</div>
			)}
			{props.settings && props.onPlatformOverridesChange && (
				<div className="mx-5 flex flex-col gap-2 rounded-lg bg-secondary p-3 text-sm dark:bg-secondary/35">
					<div className="font-semibold">Platform Video Settings</div>
					<div className="text-xs text-muted-foreground">Web and Desktop builds inherit Default values unless an exact override is enabled.</div>
					{(["web", "desktop"] as const).map((platform) => {
						const value = overrides[platform] ?? { enabled: false };
						return (
							<div key={platform} className="flex flex-col gap-2 rounded border border-border p-2">
								<div className="flex items-center justify-between">
									<span className="font-medium capitalize">{platform}</span>
									<label className="flex items-center gap-2 text-xs">
										Override
										<input type="checkbox" checked={value.enabled} onChange={(event) => updateOverride(platform, { enabled: event.target.checked })} />
									</label>
								</div>
								{value.enabled && (
									<>
										{(
											[
												["Container", "transcode", ["preserve", "webm", "mp4"]],
												["Codec", "videoCodec", ["auto", "h264", "h265", "vp8", "vp9"]],
												["Encoder", "encoder", ["auto", "software", "videotoolbox", "nvenc", "qsv", "amf"]],
												["Color", "colorDefinition", ["preserve", "rec709"]],
											] as const
										).map(([label, key, values]) => (
											<label key={key} className="grid grid-cols-[1fr_150px] items-center gap-2">
												<span>{label}</span>
												<select
													className="h-8 rounded border border-border bg-input px-2"
													value={String(value[key] ?? props.settings?.[key] ?? values[0])}
													onChange={(event) => updateOverride(platform, { [key]: event.target.value })}
												>
													{values.map((entry) => (
														<option key={entry}>{entry}</option>
													))}
												</select>
											</label>
										))}
										{(["maxWidth", "maxHeight"] as const).map((key) => (
											<label key={key} className="grid grid-cols-[1fr_150px] items-center gap-2">
												<span>{key === "maxWidth" ? "Max Width" : "Max Height"}</span>
												<input
													type="number"
													min={64}
													max={8192}
													step={2}
													className="h-8 rounded border border-border bg-input px-2"
													value={Number(value[key] ?? props.settings?.[key] ?? (key === "maxWidth" ? 1920 : 1080))}
													onChange={(event) => updateOverride(platform, { [key]: Number(event.target.value) })}
												/>
											</label>
										))}
										<label className="grid grid-cols-[1fr_150px] items-center gap-2">
											<span>Quality</span>
											<input
												type="number"
												min={0}
												max={1}
												step={0.01}
												className="h-8 rounded border border-border bg-input px-2"
												value={Number(value.quality ?? props.settings?.quality ?? 0.8)}
												onChange={(event) => updateOverride(platform, { quality: Number(event.target.value) })}
											/>
										</label>
										<label className="flex items-center justify-between">
											<span>Include Audio</span>
											<input
												type="checkbox"
												checked={value.includeAudio ?? props.settings?.includeAudio === true}
												onChange={(event) => updateOverride(platform, { includeAudio: event.target.checked })}
											/>
										</label>
									</>
								)}
								<button type="button" className="self-end text-xs text-red-400" onClick={() => removeOverride(platform)}>
									Remove override
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
