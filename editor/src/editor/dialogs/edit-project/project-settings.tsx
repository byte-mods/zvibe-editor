import { ReactNode, useState } from "react";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { Label } from "../../../ui/shadcn/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../ui/shadcn/ui/select";
import { Separator } from "../../../ui/shadcn/ui/separator";
import { Switch } from "../../../ui/shadcn/ui/switch";

import { EditorProjectBuildTarget, IEditorProjectSettings } from "../../../project/typings";
import { resolveProjectSettingsForTarget } from "../../../project/settings";
import { checkImportAcceleratorConnection } from "../../../mcp/assets/import-accelerator";
import { Editor } from "../../main";

function row(label: string, control: ReactNode, description?: string): ReactNode {
	return (
		<div className="grid grid-cols-[minmax(180px,1fr)_minmax(240px,2fr)] gap-3 items-center">
			<div>
				<Label>{label}</Label>
				{description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
			</div>
			{control}
		</div>
	);
}

function section(title: string, children: ReactNode): ReactNode {
	return (
		<section className="flex flex-col gap-3">
			<h3 className="text-lg font-medium">{title}</h3>
			{children}
		</section>
	);
}

export interface IEditorProjectSettingsComponentProps {
	editor: Editor;
	page: "player" | "assetPipeline" | "playMode";
}

export function EditorProjectSettingsComponent({ editor, page }: IEditorProjectSettingsComponentProps): ReactNode {
	const settings = editor.state.projectSettings;
	const [acceleratorConnection, setAcceleratorConnection] = useState<{ checking: boolean; message: string }>({ checking: false, message: "Not checked" });
	const patch = <K extends keyof IEditorProjectSettings>(key: K, value: IEditorProjectSettings[K]): void => editor.setState({ projectSettings: { ...settings, [key]: value } });
	const patchGroup = <K extends "identity" | "display" | "rendering" | "runtime" | "assetPipeline" | "playMode">(
		group: K,
		key: keyof IEditorProjectSettings[K],
		value: unknown
	): void => patch(group, { ...settings[group], [key]: value });
	const patchAccelerator = (key: keyof IEditorProjectSettings["assetPipeline"]["accelerator"], value: unknown): void =>
		patchGroup("assetPipeline", "accelerator", { ...settings.assetPipeline.accelerator, [key]: value });
	const checkAccelerator = async (): Promise<void> => {
		setAcceleratorConnection({ checking: true, message: "Checking…" });
		const result = await checkImportAcceleratorConnection(settings.assetPipeline.accelerator);
		setAcceleratorConnection({ checking: false, message: result.connected ? `Connected in ${result.latencyMilliseconds} ms` : `Failed: ${result.error}` });
	};

	if (page === "assetPipeline") {
		return (
			<div className="flex flex-col gap-5">
				{section(
					"Asset Pipeline",
					<>
						{row(
							"Auto Refresh",
							<Switch checked={settings.assetPipeline.autoRefresh} onCheckedChange={(value) => patchGroup("assetPipeline", "autoRefresh", value)} />
						)}
						{row(
							"Refresh on focus",
							<Switch checked={settings.assetPipeline.autoRefreshOnFocus} onCheckedChange={(value) => patchGroup("assetPipeline", "autoRefreshOnFocus", value)} />
						)}
						{row(
							"Directory monitoring",
							<Switch checked={settings.assetPipeline.directoryMonitoring} onCheckedChange={(value) => patchGroup("assetPipeline", "directoryMonitoring", value)} />,
							"Uses the existing asset watcher and Auto Reimport pipeline."
						)}
						{row(
							"Import workers",
							<Input
								type="number"
								min={1}
								max={32}
								value={settings.assetPipeline.importWorkerCount}
								onChange={(event) => patchGroup("assetPipeline", "importWorkerCount", Number(event.target.value))}
							/>
						)}
						{row(
							"Asset serialization",
							<Select value={settings.assetPipeline.serializationMode} onValueChange={(value) => patchGroup("assetPipeline", "serializationMode", value)}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="forceText">Force Text</SelectItem>
									<SelectItem value="mixed">Mixed</SelectItem>
									<SelectItem value="forceBinary">Force Binary</SelectItem>
								</SelectContent>
							</Select>,
							"Authored JSON remains interoperable; this records the serialization policy for compatible export and cache pipelines."
						)}
						{row(
							"Reduce VCS noise",
							<Switch
								checked={settings.assetPipeline.reduceVersionControlNoise}
								disabled={settings.assetPipeline.serializationMode === "forceBinary"}
								onCheckedChange={(value) => patchGroup("assetPipeline", "reduceVersionControlNoise", value)}
							/>
						)}
					</>
				)}
				<Separator />
				{section(
					"Import Accelerator",
					<>
						{row(
							"Enabled",
							<Switch checked={settings.assetPipeline.accelerator.enabled} onCheckedChange={(value) => patchAccelerator("enabled", value)} />,
							"New projects default to disabled. Upgraded projects preserve an explicit enabled cache-server policy."
						)}
						{row("Endpoint", <Input value={settings.assetPipeline.accelerator.endpoint} onChange={(event) => patchAccelerator("endpoint", event.target.value)} />)}
						{row(
							"Namespace",
							<Input value={settings.assetPipeline.accelerator.namespacePrefix} onChange={(event) => patchAccelerator("namespacePrefix", event.target.value)} />,
							"Separates project or team result keys on a shared service."
						)}
						{row(
							"Download results",
							<Switch checked={settings.assetPipeline.accelerator.downloadEnabled} onCheckedChange={(value) => patchAccelerator("downloadEnabled", value)} />
						)}
						{row(
							"Upload results",
							<Switch checked={settings.assetPipeline.accelerator.uploadEnabled} onCheckedChange={(value) => patchAccelerator("uploadEnabled", value)} />
						)}
						{row(
							"Authentication environment",
							<Input
								placeholder="ZVIBE_ACCELERATOR_TOKEN"
								value={settings.assetPipeline.accelerator.authenticationEnvironmentVariable}
								onChange={(event) => patchAccelerator("authenticationEnvironmentVariable", event.target.value)}
							/>,
							"Only the variable name is stored; its bearer token never enters project files or diagnostics."
						)}
						{row(
							"Content validation",
							<Select value={settings.assetPipeline.accelerator.contentValidation} onValueChange={(value) => patchAccelerator("contentValidation", value)}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="disabled">Local SHA-256 only</SelectItem>
									<SelectItem value="uploadOnly">Require upload attestation</SelectItem>
									<SelectItem value="enabled">Validate available attestations</SelectItem>
									<SelectItem value="required">Require all attestations</SelectItem>
								</SelectContent>
							</Select>
						)}
						{row(
							"Download batch size",
							<Input
								type="number"
								min={1}
								max={32}
								value={settings.assetPipeline.accelerator.downloadBatchSize}
								onChange={(event) => patchAccelerator("downloadBatchSize", Number(event.target.value))}
							/>
						)}
						{row(
							"Request timeout (ms)",
							<Input
								type="number"
								min={1000}
								max={300000}
								value={settings.assetPipeline.accelerator.requestTimeoutMilliseconds}
								onChange={(event) => patchAccelerator("requestTimeoutMilliseconds", Number(event.target.value))}
							/>
						)}
						{row(
							"Maximum result (MiB)",
							<Input
								type="number"
								min={1}
								max={2048}
								value={Math.round(settings.assetPipeline.accelerator.maximumResultSizeBytes / 1_048_576)}
								onChange={(event) => patchAccelerator("maximumResultSizeBytes", Number(event.target.value) * 1_048_576)}
							/>
						)}
						{row(
							"Connection",
							<div className="flex items-center gap-3">
								<Button type="button" variant="outline" disabled={acceleratorConnection.checking} onClick={() => void checkAccelerator()}>
									Check Connection
								</Button>
								<span className="text-xs text-muted-foreground">{acceleratorConnection.message}</span>
							</div>
						)}
					</>
				)}
			</div>
		);
	}

	if (page === "playMode") {
		return (
			<div className="flex flex-col gap-5">
				{section(
					"Play Mode",
					<>
						{row("Reload scene", <Switch checked={settings.playMode.reloadScene} onCheckedChange={(value) => patchGroup("playMode", "reloadScene", value)} />)}
						{row("Reload scripts", <Switch checked={settings.playMode.reloadScripts} onCheckedChange={(value) => patchGroup("playMode", "reloadScripts", value)} />)}
						{row("Mute audio", <Switch checked={settings.playMode.muteAudio} onCheckedChange={(value) => patchGroup("playMode", "muteAudio", value)} />)}
						{row(
							"Maximize on Play",
							<Switch checked={settings.playMode.maximizeOnPlay} onCheckedChange={(value) => patchGroup("playMode", "maximizeOnPlay", value)} />
						)}
						{row(
							"Default behavior",
							<Select
								value={settings.defaultBehaviorMode}
								onValueChange={(value) => patch("defaultBehaviorMode", value as IEditorProjectSettings["defaultBehaviorMode"])}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="3d">3D</SelectItem>
									<SelectItem value="2d">2D</SelectItem>
								</SelectContent>
							</Select>
						)}
					</>
				)}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			{section(
				"Identity",
				<>
					{row("Company Name", <Input value={settings.identity.companyName} onChange={(event) => patchGroup("identity", "companyName", event.target.value)} />)}
					{row("Product Name", <Input value={settings.identity.productName} onChange={(event) => patchGroup("identity", "productName", event.target.value)} />)}
					{row("Version", <Input value={settings.identity.version} onChange={(event) => patchGroup("identity", "version", event.target.value)} />)}
					{row("Application ID", <Input value={settings.identity.applicationId} onChange={(event) => patchGroup("identity", "applicationId", event.target.value)} />)}
				</>
			)}
			<Separator />
			{section(
				"Display",
				<>
					{row(
						"Default Width",
						<Input
							type="number"
							min={1}
							max={16384}
							value={settings.display.defaultWidth}
							onChange={(event) => patchGroup("display", "defaultWidth", Number(event.target.value))}
						/>
					)}
					{row(
						"Default Height",
						<Input
							type="number"
							min={1}
							max={16384}
							value={settings.display.defaultHeight}
							onChange={(event) => patchGroup("display", "defaultHeight", Number(event.target.value))}
						/>
					)}
					{row(
						"Fullscreen Mode",
						<Select value={settings.display.fullscreenMode} onValueChange={(value) => patchGroup("display", "fullscreenMode", value)}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="windowed">Windowed</SelectItem>
								<SelectItem value="borderless">Borderless</SelectItem>
								<SelectItem value="fullscreen">Fullscreen</SelectItem>
							</SelectContent>
						</Select>
					)}
					{row("Resizable Window", <Switch checked={settings.display.resizableWindow} onCheckedChange={(value) => patchGroup("display", "resizableWindow", value)} />)}
					{row("Run In Background", <Switch checked={settings.display.runInBackground} onCheckedChange={(value) => patchGroup("display", "runInBackground", value)} />)}
					{row("High DPI", <Switch checked={settings.display.allowHighDpi} onCheckedChange={(value) => patchGroup("display", "allowHighDpi", value)} />)}
				</>
			)}
			<Separator />
			{section(
				"Rendering and Runtime",
				<>
					{row(
						"Color Space",
						<Select value={settings.rendering.colorSpace} onValueChange={(value) => patchGroup("rendering", "colorSpace", value)}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="linear">Linear</SelectItem>
								<SelectItem value="gamma">Gamma</SelectItem>
							</SelectContent>
						</Select>
					)}
					{row(
						"Graphics Backend",
						<Select value={settings.rendering.renderingBackend} onValueChange={(value) => patchGroup("rendering", "renderingBackend", value)}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">Automatic</SelectItem>
								<SelectItem value="webgl2">WebGL 2</SelectItem>
								<SelectItem value="webgpu">WebGPU</SelectItem>
							</SelectContent>
						</Select>,
						"Generated players consume the selected backend at startup."
					)}
					{row(
						"Target Frame Rate",
						<Input
							type="number"
							min={-1}
							max={1000}
							value={settings.rendering.targetFrameRate}
							onChange={(event) => patchGroup("rendering", "targetFrameRate", Number(event.target.value))}
						/>
					)}
					{row(
						"Maximum DPR",
						<Input
							type="number"
							min={0.25}
							max={8}
							step={0.25}
							value={settings.rendering.maximumDevicePixelRatio}
							onChange={(event) => patchGroup("rendering", "maximumDevicePixelRatio", Number(event.target.value))}
						/>
					)}
					{row("Data Caching", <Switch checked={settings.runtime.dataCaching} onCheckedChange={(value) => patchGroup("runtime", "dataCaching", value)} />)}
					{row(
						"Deterministic Lockstep",
						<Switch checked={settings.runtime.deterministicLockstep} onCheckedChange={(value) => patchGroup("runtime", "deterministicLockstep", value)} />
					)}
					{row(
						"Lockstep Max Steps",
						<Input
							type="number"
							min={1}
							max={64}
							value={settings.runtime.lockstepMaxSteps}
							onChange={(event) => patchGroup("runtime", "lockstepMaxSteps", Number(event.target.value))}
						/>
					)}
				</>
			)}
			<Separator />
			<EditorPlatformOverrides editor={editor} />
		</div>
	);
}

function EditorPlatformOverrides({ editor }: { editor: Editor }): ReactNode {
	const settings = editor.state.projectSettings;
	const [target, setTarget] = useState<EditorProjectBuildTarget>("web");
	const resolved = resolveProjectSettingsForTarget(settings, target);
	const patch = (group: "display" | "rendering" | "runtime", key: string, value: unknown): void => {
		const current = settings.platformOverrides[target] ?? {};
		editor.setState({
			projectSettings: {
				...settings,
				platformOverrides: { ...settings.platformOverrides, [target]: { ...current, [group]: { ...resolved[group], ...(current[group] ?? {}), [key]: value } } },
			},
		});
	};
	return section(
		"Platform Overrides",
		<>
			{row(
				"Target",
				<Select value={target} onValueChange={(value) => setTarget(value as EditorProjectBuildTarget)}>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{["web", "electron", "headless", "android", "ios"].map((value) => (
							<SelectItem key={value} value={value}>
								{value}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			{row(
				"Override Width",
				<Input type="number" min={1} max={16384} value={resolved.display.defaultWidth} onChange={(event) => patch("display", "defaultWidth", Number(event.target.value))} />
			)}
			{row(
				"Override Height",
				<Input
					type="number"
					min={1}
					max={16384}
					value={resolved.display.defaultHeight}
					onChange={(event) => patch("display", "defaultHeight", Number(event.target.value))}
				/>
			)}
			{row(
				"Override Frame Rate",
				<Input
					type="number"
					min={-1}
					max={1000}
					value={resolved.rendering.targetFrameRate}
					onChange={(event) => patch("rendering", "targetFrameRate", Number(event.target.value))}
				/>
			)}
			{row("Run In Background", <Switch checked={resolved.display.runInBackground} onCheckedChange={(value) => patch("display", "runInBackground", value)} />)}
			<Button
				type="button"
				variant="outline"
				onClick={() =>
					editor.setState({
						projectSettings: { ...settings, platformOverrides: Object.fromEntries(Object.entries(settings.platformOverrides).filter(([key]) => key !== target)) },
					})
				}
			>
				Clear {target} override
			</Button>
		</>
	);
}
