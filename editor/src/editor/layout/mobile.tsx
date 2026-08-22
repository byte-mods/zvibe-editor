import { Component, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { Scene } from "babylonjs";
import {
	configureInputActions,
	configureGrpcTransport,
	configureMobileSystemRuntime,
	IGrpcTransportConfiguration,
	IGrpcTransportRuntimeEvidence,
	configureTouchControls,
	IAdaptivePerformanceConfiguration,
	IAdaptivePerformanceRuntimeEvidence,
	IMobileSystemConfiguration,
	IMobileSystemRuntimeEvidence,
	ITouchControlDefinition,
	ITouchControlRect,
	ITouchControlsConfiguration,
} from "babylonjs-editor-tools";

import { showConfirm } from "../../ui/dialog";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { getMobileDeploymentConfiguration, setMobileDeploymentConfiguration } from "../../mcp/mobile/configuration";
import {
	getAdaptivePerformanceConfiguration,
	resetAdaptivePerformanceRuntime,
	setAdaptivePerformanceConfiguration,
	simulateAdaptivePerformanceState,
} from "../../mcp/mobile/adaptive-performance";
import { getGrpcTransportConfiguration, setGrpcTransportConfiguration } from "../../mcp/mobile/grpc";
import { getMobileSystemConfiguration, resetMobileSystemRuntime, setMobileSystemConfiguration, simulateMobileSystemState } from "../../mcp/mobile/system-runtime";
import { IMobileDeploymentConfiguration, MobileTarget } from "../../mcp/mobile/model";
import {
	cancelMobileJob,
	executeMobileWorkflowPlan,
	listMobileArtifacts,
	listMobileDevices,
	listMobileJobs,
	planMobileWorkflow,
	validateMobileTarget,
} from "../../mcp/mobile/workflow";
import {
	createTouchControl,
	deleteTouchControl,
	getTouchControlsConfiguration,
	setTouchControl,
	setTouchControlsConfiguration,
	validateTouchControls,
} from "../../mcp/mobile/touch-controls";
import { generatePlatformScaffold, getPlatformScaffold } from "../../mcp/project/platforms";

import { Editor } from "../main";

interface IEditorMobileProps {
	editor: Editor;
}

interface IEditorMobileState {
	target: MobileTarget;
	selectedControlId: string | null;
	artifactPath: string;
	deviceId: string;
	durationSeconds: number;
	busy: boolean;
	error: string | null;
	deviceError: string | null;
	targetStatus: any | null;
	scaffold: any | null;
	devices: any[];
	artifacts: any[];
	pendingPlan: any | null;
	dragRect: { id: string; rect: ITouchControlRect } | null;
}

interface IDragState {
	id: string;
	mode: "move" | "resize";
	startX: number;
	startY: number;
	startRect: ITouchControlRect;
	latest: ITouchControlRect;
	preview: DOMRect;
	onMove(event: PointerEvent): void;
	onUp(event: PointerEvent): void;
}

function Panel(props: { title: string; children: ReactNode; className?: string }): ReactNode {
	return (
		<section className={`rounded border border-border bg-background/60 p-3 ${props.className ?? ""}`}>
			<div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</div>
			<div className="flex flex-col gap-2">{props.children}</div>
		</section>
	);
}

function ToggleField(props: { label: string; checked: boolean; onCommit(value: boolean): void }): ReactNode {
	return (
		<label className="flex items-center justify-between gap-2 text-xs">
			<span>{props.label}</span>
			<input type="checkbox" checked={props.checked} onChange={(event) => props.onCommit(event.currentTarget.checked)} />
		</label>
	);
}

function TextField(props: { label: string; value: string; placeholder?: string; type?: string; onCommit(value: string): void }): ReactNode {
	return (
		<label className="grid grid-cols-[minmax(120px,1fr)_minmax(160px,2fr)] items-center gap-2 text-xs">
			<span>{props.label}</span>
			<Input
				key={props.value}
				type={props.type}
				className="h-8 font-mono text-[11px]"
				defaultValue={props.value}
				placeholder={props.placeholder}
				onBlur={(event) => {
					if (event.currentTarget.value !== props.value) {
						props.onCommit(event.currentTarget.value);
					}
				}}
			/>
		</label>
	);
}

function NumberField(props: { label: string; value: number; minimum: number; maximum: number; step?: number; onCommit(value: number): void }): ReactNode {
	return (
		<label className="grid grid-cols-[minmax(120px,1fr)_minmax(100px,160px)] items-center gap-2 text-xs">
			<span>{props.label}</span>
			<Input
				key={props.value}
				type="number"
				min={props.minimum}
				max={props.maximum}
				step={props.step ?? 0.01}
				className="h-8"
				defaultValue={props.value}
				onBlur={(event) => {
					const value = Number(event.currentTarget.value);
					if (Number.isFinite(value) && value !== props.value) {
						props.onCommit(value);
					}
				}}
			/>
		</label>
	);
}

function SelectField(props: { label: string; value: string; options: Array<{ value: string; label: string }>; onCommit(value: string): void }): ReactNode {
	return (
		<label className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,160px)] items-center gap-2 text-xs">
			<span>{props.label}</span>
			<select className="h-8 rounded border border-border bg-input px-2" value={props.value} onChange={(event) => props.onCommit(event.currentTarget.value)}>
				{props.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}

function percent(value: number): string {
	return `${Math.round(value * 1000) / 10}%`;
}

/** Unity-style Mobile input layout, native deployment, device, artifact, and job workspace. */
export class EditorMobile extends Component<IEditorMobileProps, IEditorMobileState> {
	private _mounted = false;
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;
	private _runtimeScene: Scene | null = null;
	private _drag: IDragState | null = null;
	private _hadActiveJob = false;

	public constructor(props: IEditorMobileProps) {
		super(props);
		this.state = {
			target: "android",
			selectedControlId: null,
			artifactPath: "",
			deviceId: "",
			durationSeconds: 30,
			busy: false,
			error: null,
			deviceError: null,
			targetStatus: null,
			scaffold: null,
			devices: [],
			artifacts: [],
			pendingPlan: null,
			dragRect: null,
		};
	}

	public componentDidMount(): void {
		this._mounted = true;
		this._syncViewportRuntime();
		void this._refreshExternal();
		this._refreshTimer = setInterval(() => {
			this._syncViewportRuntime();
			const scene = this._scene();
			const active = scene
				? (listMobileJobs(scene, { target: this.state.target, limit: 32 }) as any).jobs.some((job: any) => ["queued", "running", "canceling"].includes(job.status))
				: false;
			if (this._hadActiveJob && !active) {
				void this._refreshExternal();
			} else {
				this.forceUpdate();
			}
			this._hadActiveJob = active;
		}, 750);
	}

	public componentWillUnmount(): void {
		this._mounted = false;
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		this._refreshTimer = null;
		this._removeDragListeners();
	}

	public render(): ReactNode {
		const scene = this._scene();
		if (!scene) {
			return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Open a scene to configure Mobile.</div>;
		}
		let touch: ITouchControlsConfiguration;
		let touchValidation: ReturnType<typeof validateTouchControls>;
		let deployment: IMobileDeploymentConfiguration;
		let adaptive: { configuration: IAdaptivePerformanceConfiguration; runtime: IAdaptivePerformanceRuntimeEvidence };
		let mobileSystem: { configuration: IMobileSystemConfiguration; runtime: IMobileSystemRuntimeEvidence };
		let grpc: { configuration: IGrpcTransportConfiguration; runtime: IGrpcTransportRuntimeEvidence };
		try {
			touch = getTouchControlsConfiguration(scene);
			touchValidation = validateTouchControls(scene);
			deployment = getMobileDeploymentConfiguration(scene, { editor: this.props.editor });
			adaptive = getAdaptivePerformanceConfiguration(scene) as typeof adaptive;
			mobileSystem = getMobileSystemConfiguration(scene) as typeof mobileSystem;
			grpc = getGrpcTransportConfiguration(scene) as typeof grpc;
		} catch (error) {
			return <div className="p-3 text-sm text-destructive">{this._error(error)}</div>;
		}
		const selected = touch.controls.find((control) => control.id === this.state.selectedControlId) ?? touch.controls[0] ?? null;
		const jobs = listMobileJobs(scene, { target: this.state.target, limit: 12 }) as any;
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2">
					<span className="text-xs font-semibold">
						Mobile · Touch r{touch.revision} · Adaptive r{adaptive.configuration.revision} · System r{mobileSystem.configuration.revision} · gRPC r
						{grpc.configuration.revision} · Deployment r{deployment.revision}
					</span>
					<span className={`text-xs ${touchValidation.valid ? "text-emerald-400" : "text-destructive"}`}>
						{touchValidation.valid ? `${touch.controls.length} controls ready` : `${touchValidation.errors.length} touch validation errors`}
					</span>
					<span className="ml-auto text-[10px] text-muted-foreground">Android · iOS · Capacitor · native package/sign/device/store workflows</span>
				</div>
				{this.state.error && <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="min-h-0 flex-1 overflow-auto p-3">
					<div className="grid gap-3 2xl:grid-cols-[minmax(520px,1.2fr)_minmax(460px,1fr)]">
						<div className="flex min-w-0 flex-col gap-3">
							{this._renderTouchLayout(scene, touch, touchValidation, selected)}
							{selected && this._renderSelectedControl(scene, touch, selected)}
						</div>
						<div className="flex min-w-0 flex-col gap-3">
							{this._renderAdaptivePerformance(scene, adaptive.configuration, adaptive.runtime)}
							{this._renderMobileSystem(scene, mobileSystem.configuration, mobileSystem.runtime)}
							{this._renderGrpcTransport(grpc.configuration, grpc.runtime)}
							{this._renderDeployment(scene, deployment)}
							{this._renderWorkflow(scene, deployment, jobs)}
						</div>
					</div>
				</div>
			</div>
		);
	}

	private _renderAdaptivePerformance(scene: Scene, configuration: IAdaptivePerformanceConfiguration, runtime: IAdaptivePerformanceRuntimeEvidence): ReactNode {
		return (
			<Panel title="Adaptive Performance · Basic and Apple Thermal">
				<div className="grid gap-2 lg:grid-cols-2">
					<ToggleField label="Runtime enabled" checked={configuration.enabled} onCommit={(enabled) => this._patchAdaptive(configuration, { enabled })} />
					<SelectField
						label="Provider"
						value={configuration.provider}
						options={[
							{ value: "auto", label: "Auto (Apple then Basic)" },
							{ value: "basic", label: "Basic" },
							{ value: "apple", label: "Apple native" },
						]}
						onCommit={(provider) => this._patchAdaptive(configuration, { provider })}
					/>
					<SelectField
						label="Target platform"
						value={configuration.platform}
						options={["web", "electron", "android", "ios", "tvos", "visionos", "unknown"].map((value) => ({ value, label: value }))}
						onCommit={(platform) => this._patchAdaptive(configuration, { platform })}
					/>
					<NumberField
						label="Target frame rate"
						value={configuration.targetFrameRate}
						minimum={15}
						maximum={240}
						step={1}
						onCommit={(targetFrameRate) => this._patchAdaptive(configuration, { targetFrameRate })}
					/>
					<NumberField
						label="Sample frames"
						value={configuration.sampleFrames}
						minimum={2}
						maximum={240}
						step={1}
						onCommit={(sampleFrames) => this._patchAdaptive(configuration, { sampleFrames })}
					/>
					<NumberField
						label="Thermal action delay"
						value={configuration.thermalActionDelaySeconds}
						minimum={0}
						maximum={600}
						onCommit={(thermalActionDelaySeconds) => this._patchAdaptive(configuration, { thermalActionDelaySeconds })}
					/>
					<NumberField
						label="Performance delay"
						value={configuration.performanceActionDelaySeconds}
						minimum={0}
						maximum={600}
						onCommit={(performanceActionDelaySeconds) => this._patchAdaptive(configuration, { performanceActionDelaySeconds })}
					/>
				</div>
				<div className="rounded border border-border bg-muted/20 p-2 text-[10px]">
					<div>
						Provider: {runtime.activeProvider ?? "none"} · {runtime.providerSource} · {runtime.providerAvailable ? "available" : "fallback"}
					</div>
					<div>
						Thermal: {runtime.thermalState} · Bottleneck: {runtime.bottleneck} · Quality index: {Math.round(runtime.qualityIndex * 100)}%
					</div>
					<div>
						Frame average: {runtime.averageFrameTimeMs ?? "—"} ms · Samples: {runtime.windowSamples}/{configuration.sampleFrames} · Last: {runtime.lastDecision}
					</div>
				</div>
				<div className="grid gap-1 lg:grid-cols-2">
					{configuration.scalers.map((scaler) => {
						const evidence = runtime.scalers.find((candidate) => candidate.id === scaler.id);
						return (
							<div key={scaler.id} className="rounded border border-border p-2 text-[10px]">
								<ToggleField
									label={`${scaler.id} · level ${evidence?.level ?? 0}/${scaler.maximumLevel}`}
									checked={scaler.enabled}
									onCommit={(enabled) => this._patchAdaptive(configuration, { scalers: [{ id: scaler.id, enabled }] })}
								/>
								<div className="text-muted-foreground">
									{scaler.target} · {scaler.visualImpact} impact · scale {evidence?.scale ?? scaler.maximumScale}
								</div>
							</div>
						);
					})}
				</div>
				<div className="flex flex-wrap gap-2">
					{(["nominal", "fair", "serious", "critical"] as const).map((thermalState) => (
						<Button
							key={thermalState}
							size="sm"
							variant={thermalState === "serious" || thermalState === "critical" ? "destructive" : "secondary"}
							disabled={!configuration.enabled}
							onClick={() => this._simulateAdaptive(scene, configuration, thermalState)}
						>
							Simulate {thermalState}
						</Button>
					))}
					<Button size="sm" variant="outline" onClick={() => this._resetAdaptive(scene, configuration)}>
						Reset Evidence
					</Button>
				</div>
				{runtime.warnings.map((warning) => (
					<div key={warning} className="text-[10px] text-amber-400">
						{warning}
					</div>
				))}
				<div className="text-[10px] text-muted-foreground">
					Simulation is not hardware evidence. Apple thermal state requires the generated native provider bridge compiled into an iOS, tvOS, or visionOS host.
				</div>
			</Panel>
		);
	}

	private _renderMobileSystem(scene: Scene, configuration: IMobileSystemConfiguration, runtime: IMobileSystemRuntimeEvidence): ReactNode {
		return (
			<Panel title="Android Insets · iOS Thermal FPS">
				<div className="grid gap-2 lg:grid-cols-2">
					<SelectField
						label="Runtime platform"
						value={configuration.platform}
						options={["auto", "web", "electron", "android", "ios", "tvos", "visionos", "unknown"].map((value) => ({ value, label: value }))}
						onCommit={(platform) => this._patchMobileSystem(configuration, { platform })}
					/>
					<ToggleField
						label="Android policy enabled"
						checked={configuration.android.enabled}
						onCommit={(enabled) => this._patchMobileSystem(configuration, { android: { enabled } })}
					/>
					<ToggleField
						label="Decor fits system windows"
						checked={configuration.android.decorFitsSystemWindows}
						onCommit={(decorFitsSystemWindows) => this._patchMobileSystem(configuration, { android: { decorFitsSystemWindows } })}
					/>
					<SelectField
						label="System bars behavior"
						value={configuration.android.systemBarsBehavior}
						options={[
							{ value: "default", label: "Default" },
							{ value: "show-transient-bars-by-swipe", label: "Transient by swipe" },
						]}
						onCommit={(systemBarsBehavior) => this._patchMobileSystem(configuration, { android: { systemBarsBehavior } })}
					/>
					<ToggleField
						label="Adjust iOS FPS thermally"
						checked={configuration.iosThermalFrameRate.enabled}
						onCommit={(enabled) => this._patchMobileSystem(configuration, { iosThermalFrameRate: { enabled } })}
					/>
					<NumberField
						label="Serious thermal FPS"
						value={configuration.iosThermalFrameRate.seriousThermalStateFps}
						minimum={1}
						maximum={240}
						step={1}
						onCommit={(seriousThermalStateFps) => this._patchMobileSystem(configuration, { iosThermalFrameRate: { seriousThermalStateFps } })}
					/>
					<NumberField
						label="Critical thermal FPS"
						value={configuration.iosThermalFrameRate.criticalThermalStateFps}
						minimum={1}
						maximum={240}
						step={1}
						onCommit={(criticalThermalStateFps) => this._patchMobileSystem(configuration, { iosThermalFrameRate: { criticalThermalStateFps } })}
					/>
				</div>
				<div>
					<div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Requested visible Android insets</div>
					<div className="grid gap-1 lg:grid-cols-2">
						{["statusBars", "navigationBars", "ime", "displayCutout", "systemGestures", "mandatorySystemGestures", "tappableElement", "captionBar"].map((inset) => (
							<ToggleField
								key={inset}
								label={inset}
								checked={configuration.android.requestedVisibleWindowInsets.includes(inset as any)}
								onCommit={(enabled) => {
									const requestedVisibleWindowInsets = enabled
										? [...configuration.android.requestedVisibleWindowInsets, inset]
										: configuration.android.requestedVisibleWindowInsets.filter((entry) => entry !== inset);
									this._patchMobileSystem(configuration, { android: { requestedVisibleWindowInsets } });
								}}
							/>
						))}
					</div>
				</div>
				<div className="rounded border border-border bg-muted/20 p-2 text-[10px]">
					<div>
						Platform: {runtime.platform} · Android bridge: {runtime.androidBridgeAvailable ? "native" : runtime.windowInsetsSource}
					</div>
					<div>
						Insets L/T/R/B: {runtime.windowInsets.left}/{runtime.windowInsets.top}/{runtime.windowInsets.right}/{runtime.windowInsets.bottom} · visible{" "}
						{runtime.visibleWindowInsets.join(", ") || "unknown"}
					</div>
					<div>
						Thermal: {runtime.thermalState} ({runtime.thermalSource}) · FPS cap: {runtime.appliedTargetFrameRate ?? "uncapped"} · rendered/skipped{" "}
						{runtime.renderedFrames}/{runtime.skippedFrames}
					</div>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="secondary" onClick={() => this._simulateMobileSystem(scene, configuration, "serious")}>
						Simulate Serious / 30
					</Button>
					<Button size="sm" variant="destructive" onClick={() => this._simulateMobileSystem(scene, configuration, "critical")}>
						Simulate Critical / 15
					</Button>
					<Button size="sm" variant="secondary" onClick={() => this._simulateMobileInsets(scene, configuration)}>
						Simulate Insets
					</Button>
					<Button size="sm" variant="outline" onClick={() => this._resetMobileSystem(scene, configuration)}>
						Reset Evidence
					</Button>
				</div>
				{runtime.warnings.map((warning) => (
					<div key={warning} className="text-[10px] text-amber-400">
						{warning}
					</div>
				))}
				<div className="text-[10px] text-muted-foreground">
					Simulation is not hardware evidence. Native control requires the generated Capacitor bridge compiled and registered in the host.
				</div>
			</Panel>
		);
	}

	private _renderGrpcTransport(configuration: IGrpcTransportConfiguration, runtime: IGrpcTransportRuntimeEvidence): ReactNode {
		return (
			<Panel title="Portable gRPC-Web · Connect">
				<div className="grid gap-2 lg:grid-cols-2">
					<ToggleField label="Transport enabled" checked={configuration.enabled} onCommit={(enabled) => this._patchGrpc(configuration, { enabled })} />
					<SelectField
						label="Protocol"
						value={configuration.protocol}
						options={["grpc-web-binary", "grpc-web-text", "connect"].map((value) => ({ value, label: value }))}
						onCommit={(protocol) => this._patchGrpc(configuration, { protocol })}
					/>
					<TextField label="Endpoint" value={configuration.endpoint} onCommit={(endpoint) => this._patchGrpc(configuration, { endpoint })} />
					<SelectField
						label="Credentials"
						value={configuration.credentials}
						options={["omit", "same-origin", "include"].map((value) => ({ value, label: value }))}
						onCommit={(credentials) => this._patchGrpc(configuration, { credentials })}
					/>
					<NumberField
						label="Default deadline (ms)"
						value={configuration.defaultTimeoutMs}
						minimum={1}
						maximum={300000}
						step={1}
						onCommit={(defaultTimeoutMs) => this._patchGrpc(configuration, { defaultTimeoutMs })}
					/>
					<NumberField
						label="Max send bytes"
						value={configuration.maximumSendMessageBytes}
						minimum={1}
						maximum={67108864}
						step={1}
						onCommit={(maximumSendMessageBytes) => this._patchGrpc(configuration, { maximumSendMessageBytes })}
					/>
					<NumberField
						label="Max receive bytes"
						value={configuration.maximumReceiveMessageBytes}
						minimum={1}
						maximum={67108864}
						step={1}
						onCommit={(maximumReceiveMessageBytes) => this._patchGrpc(configuration, { maximumReceiveMessageBytes })}
					/>
				</div>
				<div className="rounded border border-border bg-muted/20 p-2 text-[10px]">
					Backend: {runtime.backend} · active {runtime.activeCalls} · retained calls {runtime.calls.length}/32
				</div>
				<div className="text-[10px] text-muted-foreground">
					Unary and server-streaming protobuf are available through MCP/runtime. Browser CORS applies; client/bidirectional streaming and unrestricted native HTTP/2 gRPC
					are explicit boundaries.
				</div>
			</Panel>
		);
	}

	private _scene(): Scene | null {
		return this.props.editor.layout.preview?.scene ?? null;
	}

	private _renderTouchLayout(
		scene: Scene,
		touch: ITouchControlsConfiguration,
		validation: ReturnType<typeof validateTouchControls>,
		selected: ITouchControlDefinition | null
	): ReactNode {
		return (
			<Panel title="On-screen Touch Layout">
				<div className="flex flex-wrap items-center gap-3">
					<ToggleField label="Runtime enabled" checked={touch.enabled} onCommit={(enabled) => this._patchTouch(touch, { enabled })} />
					<ToggleField label="Visible in editor viewport" checked={touch.visibleInEditor} onCommit={(visibleInEditor) => this._patchTouch(touch, { visibleInEditor })} />
					<ToggleField label="Respect safe area" checked={touch.respectSafeArea} onCommit={(respectSafeArea) => this._patchTouch(touch, { respectSafeArea })} />
					<NumberField label="Opacity" value={touch.opacity} minimum={0.05} maximum={1} step={0.05} onCommit={(opacity) => this._patchTouch(touch, { opacity })} />
				</div>
				<div
					data-touch-layout-preview
					className="relative mx-auto aspect-video w-full max-w-3xl overflow-hidden rounded-xl border-2 border-slate-500 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 shadow-inner"
				>
					<div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">Game viewport · drag controls · resize from lower-right handle</div>
					{touch.respectSafeArea && <div className="pointer-events-none absolute inset-[4%] rounded border border-dashed border-emerald-400/40" />}
					{touch.controls.map((control) => {
						const rect = this.state.dragRect?.id === control.id ? this.state.dragRect.rect : control.rect;
						const active = selected?.id === control.id;
						return (
							<button
								key={control.id}
								type="button"
								aria-label={`Select and move ${control.name}`}
								className={`absolute touch-none select-none border text-[10px] font-semibold text-white shadow ${control.type === "stick" ? "rounded-full" : "rounded-xl"} ${active ? "ring-2 ring-sky-400" : "border-white/60"}`}
								style={{
									left: percent(rect.x),
									top: percent(rect.y),
									width: percent(rect.width),
									height: percent(rect.height),
									background: control.backgroundColor,
									opacity: touch.opacity,
								}}
								onClick={() => this.setState({ selectedControlId: control.id })}
								onPointerDown={(event) => this._beginDrag(event, control, "move")}
							>
								{control.type === "button" ? control.label || control.name : <span className="text-white/60">●</span>}
								<span
									className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize rounded-tl bg-sky-400"
									onPointerDown={(event) => {
										event.stopPropagation();
										this._beginDrag(event, control, "resize");
									}}
								/>
							</button>
						);
					})}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" onClick={() => this._createControl(scene, touch, "button")}>
						Add Button
					</Button>
					<Button size="sm" variant="secondary" onClick={() => this._createControl(scene, touch, "stick")}>
						Add Stick
					</Button>
					<span className="self-center text-[10px] text-muted-foreground">
						Normalized anchors scale across mobile aspect ratios; safe-area padding is applied at runtime.
					</span>
				</div>
				{validation.errors.map((entry) => (
					<div key={`${entry.code}:${entry.message}`} className="text-[10px] text-destructive">
						{entry.code}: {entry.message}
					</div>
				))}
				{validation.warnings.map((entry) => (
					<div key={`${entry.code}:${entry.message}`} className="text-[10px] text-amber-400">
						{entry.code}: {entry.message}
					</div>
				))}
			</Panel>
		);
	}

	private _renderSelectedControl(scene: Scene, touch: ITouchControlsConfiguration, control: ITouchControlDefinition): ReactNode {
		return (
			<Panel title={`Selected Control · ${control.name}`}>
				<div className="grid gap-2 lg:grid-cols-2">
					<TextField label="Name" value={control.name} onCommit={(name) => this._patchControl(control.id, { name })} />
					<TextField label="Input Action path" value={control.controlPath} onCommit={(controlPath) => this._patchControl(control.id, { controlPath })} />
					<TextField label="Label" value={control.label} onCommit={(label) => this._patchControl(control.id, { label })} />
					<SelectField
						label="Type"
						value={control.type}
						options={[
							{ value: "button", label: "Button" },
							{ value: "stick", label: "Fixed-center stick" },
						]}
						onCommit={(type) => this._patchControl(control.id, { type })}
					/>
					{(["x", "y", "width", "height"] as const).map((key) => (
						<NumberField
							key={key}
							label={`Rect ${key}`}
							value={control.rect[key]}
							minimum={0}
							maximum={1}
							onCommit={(value) => this._patchControl(control.id, { rect: { [key]: value } })}
						/>
					))}
					<TextField
						label="Background"
						type="color"
						value={control.backgroundColor.slice(0, 7)}
						onCommit={(backgroundColor) => this._patchControl(control.id, { backgroundColor })}
					/>
					<TextField
						label="Pressed"
						type="color"
						value={control.pressedColor.slice(0, 7)}
						onCommit={(pressedColor) => this._patchControl(control.id, { pressedColor })}
					/>
					{control.type === "button" ? (
						<NumberField
							label="Button value"
							value={control.buttonValue}
							minimum={0.01}
							maximum={1}
							onCommit={(buttonValue) => this._patchControl(control.id, { buttonValue })}
						/>
					) : (
						<>
							<NumberField
								label="Stick deadzone"
								value={control.stickDeadzone}
								minimum={0}
								maximum={0.99}
								onCommit={(stickDeadzone) => this._patchControl(control.id, { stickDeadzone })}
							/>
							<SelectField
								label="Stick axis"
								value={control.stickAxis}
								options={[
									{ value: "both", label: "Both" },
									{ value: "horizontal", label: "Horizontal" },
									{ value: "vertical", label: "Vertical" },
								]}
								onCommit={(stickAxis) => this._patchControl(control.id, { stickAxis })}
							/>
						</>
					)}
				</div>
				<Button size="sm" variant="destructive" className="self-start" onClick={() => void this._deleteControl(scene, touch, control)}>
					Delete Control
				</Button>
			</Panel>
		);
	}

	private _renderDeployment(scene: Scene, deployment: IMobileDeploymentConfiguration): ReactNode {
		const target = this.state.target;
		const settings = deployment[target];
		return (
			<Panel title="Native Deployment Settings">
				<div className="flex gap-2">
					{(["android", "ios"] as const).map((candidate) => (
						<Button
							key={candidate}
							size="sm"
							variant={target === candidate ? "default" : "secondary"}
							onClick={() => this.setState({ target: candidate, pendingPlan: null }, () => void this._refreshExternal())}
						>
							{candidate === "android" ? "Android" : "iOS"}
						</Button>
					))}
					<Button size="sm" variant="outline" className="ml-auto" disabled={this.state.busy} onClick={() => void this._refreshExternal()}>
						Refresh Toolchain
					</Button>
				</div>
				<div className="grid gap-2 lg:grid-cols-2">
					<SelectField
						label="Variant"
						value={settings.variant}
						options={[
							{ value: "debug", label: "Debug" },
							{ value: "release", label: "Release" },
						]}
						onCommit={(variant) => this._patchDeployment(deployment, { [target]: { variant } })}
					/>
					<TextField
						label="Application id"
						value={settings.applicationId}
						onCommit={(applicationId) => this._patchDeployment(deployment, { [target]: { applicationId } })}
					/>
					{target === "android" ? this._renderAndroidSettings(deployment) : this._renderIosSettings(deployment)}
				</div>
				<div className="rounded border border-border bg-muted/20 p-2 text-[10px] text-muted-foreground">
					<div>
						Scaffold:{" "}
						{this.state.scaffold?.exists ? `revision ${this.state.scaffold.revision} · ${this.state.scaffold.integrity ? "verified" : "modified"}` : "not generated"}
					</div>
					<div>Native project: {this.state.targetStatus?.nativeProject?.exists ? this.state.targetStatus.nativeProject.path : "not synced"}</div>
					<div>
						Package ready: {this.state.targetStatus?.ready?.package ? "yes" : "no"} · Device tools: {this.state.targetStatus?.ready?.device ? "ready" : "unavailable"} ·
						Store: {this.state.targetStatus?.ready?.store ? "ready" : "unavailable"}
					</div>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="secondary" disabled={this.state.busy} onClick={() => void this._generateScaffold(scene)}>
						{this.state.scaffold?.exists ? "Update Scaffold" : "Generate Scaffold"}
					</Button>
					{this.state.scaffold?.exists && (
						<ToggleField
							label="Sync native project during platform build"
							checked={this.state.scaffold.manifest?.settings?.syncNativeProject === true}
							onCommit={(syncNativeProject) => void this._updateScaffold(scene, { syncNativeProject })}
						/>
					)}
					{this.state.target === "ios" && this.state.scaffold?.exists && (
						<TextField
							label="Minimum visionOS"
							value={this.state.scaffold.manifest?.settings?.targetMinimumVisionOSVersion ?? "2.0"}
							placeholder="2.0"
							onCommit={(targetMinimumVisionOSVersion) => void this._updateScaffold(scene, { targetMinimumVisionOSVersion })}
						/>
					)}
				</div>
				<div className="text-[10px] text-amber-400">
					Certificates, provisioning profiles, vendor SDKs, device access, store accounts, agreements, and review decisions remain external prerequisites.
				</div>
			</Panel>
		);
	}

	private _renderAndroidSettings(deployment: IMobileDeploymentConfiguration): ReactNode {
		const settings = deployment.android;
		return (
			<>
				<SelectField
					label="Package format"
					value={settings.format}
					options={[
						{ value: "apk", label: "APK" },
						{ value: "aab", label: "Android App Bundle" },
					]}
					onCommit={(format) => this._patchDeployment(deployment, { android: { format } })}
				/>
				<TextField
					label="Launch activity"
					value={settings.launchActivity}
					onCommit={(launchActivity) => this._patchDeployment(deployment, { android: { launchActivity } })}
				/>
				<TextField
					label="Gradle task override"
					value={settings.gradleTask ?? ""}
					placeholder="bundleRelease"
					onCommit={(gradleTask) => this._patchDeployment(deployment, { android: { gradleTask: gradleTask || null } })}
				/>
				<ToggleField
					label="Environment-only signing"
					checked={settings.signing.enabled}
					onCommit={(enabled) => this._patchDeployment(deployment, { android: { signing: { enabled } } })}
				/>
				<TextField
					label="Keystore path env"
					value={settings.signing.keystorePathEnvironment ?? ""}
					onCommit={(keystorePathEnvironment) =>
						this._patchDeployment(deployment, { android: { signing: { keystorePathEnvironment: keystorePathEnvironment || null } } })
					}
				/>
				<TextField
					label="Store password env"
					value={settings.signing.keystorePasswordEnvironment ?? ""}
					onCommit={(keystorePasswordEnvironment) =>
						this._patchDeployment(deployment, { android: { signing: { keystorePasswordEnvironment: keystorePasswordEnvironment || null } } })
					}
				/>
				<TextField
					label="Key alias env"
					value={settings.signing.keyAliasEnvironment ?? ""}
					onCommit={(keyAliasEnvironment) => this._patchDeployment(deployment, { android: { signing: { keyAliasEnvironment: keyAliasEnvironment || null } } })}
				/>
				<TextField
					label="Key password env"
					value={settings.signing.keyPasswordEnvironment ?? ""}
					onCommit={(keyPasswordEnvironment) => this._patchDeployment(deployment, { android: { signing: { keyPasswordEnvironment: keyPasswordEnvironment || null } } })}
				/>
				<TextField
					label="Play credential env"
					value={settings.store.credentialPathEnvironment ?? ""}
					onCommit={(credentialPathEnvironment) =>
						this._patchDeployment(deployment, { android: { store: { credentialPathEnvironment: credentialPathEnvironment || null } } })
					}
				/>
				<SelectField
					label="Play track"
					value={settings.store.track}
					options={["internal", "alpha", "beta", "production"].map((value) => ({ value, label: value }))}
					onCommit={(track) => this._patchDeployment(deployment, { android: { store: { track } } })}
				/>
				<SelectField
					label="Release status"
					value={settings.store.releaseStatus}
					options={[
						{ value: "draft", label: "Draft" },
						{ value: "completed", label: "Completed" },
					]}
					onCommit={(releaseStatus) => this._patchDeployment(deployment, { android: { store: { releaseStatus } } })}
				/>
			</>
		);
	}

	private _renderIosSettings(deployment: IMobileDeploymentConfiguration): ReactNode {
		const settings = deployment.ios;
		return (
			<>
				<TextField label="Workspace" value={settings.workspace} onCommit={(workspace) => this._patchDeployment(deployment, { ios: { workspace } })} />
				<TextField label="Scheme" value={settings.scheme} onCommit={(scheme) => this._patchDeployment(deployment, { ios: { scheme } })} />
				<TextField label="Archive path" value={settings.archivePath} onCommit={(archivePath) => this._patchDeployment(deployment, { ios: { archivePath } })} />
				<TextField
					label="Export directory"
					value={settings.exportDirectory}
					onCommit={(exportDirectory) => this._patchDeployment(deployment, { ios: { exportDirectory } })}
				/>
				<SelectField
					label="Export method"
					value={settings.exportMethod}
					options={[
						{ value: "development", label: "Development" },
						{ value: "ad-hoc", label: "Ad hoc" },
						{ value: "app-store-connect", label: "App Store Connect" },
					]}
					onCommit={(exportMethod) => this._patchDeployment(deployment, { ios: { exportMethod } })}
				/>
				<ToggleField
					label="Environment-only signing"
					checked={settings.signing.enabled}
					onCommit={(enabled) => this._patchDeployment(deployment, { ios: { signing: { enabled } } })}
				/>
				<TextField
					label="Team id env"
					value={settings.signing.teamIdEnvironment ?? ""}
					onCommit={(teamIdEnvironment) => this._patchDeployment(deployment, { ios: { signing: { teamIdEnvironment: teamIdEnvironment || null } } })}
				/>
				<TextField
					label="Identity env"
					value={settings.signing.identityEnvironment ?? ""}
					onCommit={(identityEnvironment) => this._patchDeployment(deployment, { ios: { signing: { identityEnvironment: identityEnvironment || null } } })}
				/>
				<TextField
					label="App Store API key env"
					value={settings.store.apiKeyPathEnvironment ?? ""}
					onCommit={(apiKeyPathEnvironment) => this._patchDeployment(deployment, { ios: { store: { apiKeyPathEnvironment: apiKeyPathEnvironment || null } } })}
				/>
				<ToggleField
					label="Submit for review"
					checked={settings.store.submitForReview}
					onCommit={(submitForReview) => this._patchDeployment(deployment, { ios: { store: { submitForReview } } })}
				/>
			</>
		);
	}

	private _renderWorkflow(scene: Scene, deployment: IMobileDeploymentConfiguration, jobs: any): ReactNode {
		return (
			<Panel title="Package, Device, Logs, and Store Jobs">
				<div className="grid gap-2 lg:grid-cols-2">
					<TextField
						label="Artifact path"
						value={this.state.artifactPath}
						placeholder=".zvibe/platforms/.../game.aab"
						onCommit={(artifactPath) => this.setState({ artifactPath })}
					/>
					<TextField
						label="Device id"
						value={this.state.deviceId}
						placeholder={this.state.target === "android" ? "emulator-5554" : "device UUID"}
						onCommit={(deviceId) => this.setState({ deviceId })}
					/>
					<NumberField
						label="Log duration (seconds)"
						value={this.state.durationSeconds}
						minimum={1}
						maximum={3600}
						step={1}
						onCommit={(durationSeconds) => this.setState({ durationSeconds })}
					/>
				</div>
				<div className="flex flex-wrap gap-2">
					{(["package", "install", "launch", "logs", "submit"] as const).map((operation) => (
						<Button
							key={operation}
							size="sm"
							variant={operation === "package" ? "default" : "secondary"}
							disabled={this.state.busy}
							onClick={() => void this._planWorkflow(scene, deployment, operation)}
						>
							Plan {operation}
						</Button>
					))}
				</div>
				{this.state.pendingPlan && (
					<div className="rounded border border-amber-400/40 bg-amber-400/10 p-2 text-[10px]">
						<div className="font-semibold text-amber-300">
							Exact plan ready · {this.state.pendingPlan.operation} {this.state.pendingPlan.target}
						</div>
						<div>
							Config r{this.state.pendingPlan.configurationRevision} · scaffold r{this.state.pendingPlan.scaffoldRevision} · expires{" "}
							{this.state.pendingPlan.expiresAt}
						</div>
						{this.state.pendingPlan.artifact && (
							<div className="break-all font-mono">
								{this.state.pendingPlan.artifact.path} · SHA-256 {this.state.pendingPlan.artifact.sha256}
							</div>
						)}
						<Button size="sm" className="mt-2" disabled={this.state.busy} onClick={() => void this._executePlan(scene)}>
							Review and Execute
						</Button>
					</div>
				)}
				<div className="grid gap-2 lg:grid-cols-2">
					<div>
						<div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Devices</div>
						{this.state.devices.map((device) => (
							<button
								type="button"
								key={device.id}
								className="mb-1 block w-full rounded border border-border p-2 text-left text-[10px] hover:bg-muted/30"
								onClick={() => this.setState({ deviceId: device.id })}
							>
								{device.name ?? device.id} · {device.state}
							</button>
						))}
						{this.state.deviceError && <div className="text-[10px] text-amber-400">{this.state.deviceError}</div>}
						{!this.state.devices.length && !this.state.deviceError && <div className="text-[10px] text-muted-foreground">No connected devices reported.</div>}
					</div>
					<div>
						<div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Artifacts</div>
						{this.state.artifacts.map((artifact) => (
							<button
								type="button"
								key={artifact.path}
								className="mb-1 block w-full rounded border border-border p-2 text-left text-[10px] hover:bg-muted/30"
								onClick={() => this.setState({ artifactPath: artifact.path })}
							>
								<span className="break-all font-mono">{artifact.path}</span> · {artifact.extension} · {artifact.sizeBytes} bytes
							</button>
						))}
						{!this.state.artifacts.length && <div className="text-[10px] text-muted-foreground">No native artifacts found.</div>}
					</div>
				</div>
				<div>
					<div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Recent Jobs</div>
					{jobs.jobs.map((job: any) => (
						<div key={job.id} className="mb-1 rounded border border-border p-2 text-[10px]">
							<div className="flex items-center gap-2">
								<span className="font-semibold">
									{job.operation} · {job.status}
								</span>
								<span className="ml-auto font-mono text-muted-foreground">{job.id}</span>
								{["queued", "running", "canceling"].includes(job.status) && (
									<Button size="sm" variant="destructive" className="h-6" onClick={() => void this._cancelJob(scene, job.id)}>
										Cancel
									</Button>
								)}
							</div>
							{job.error && <div className="text-destructive">{job.error}</div>}
							{job.outputTail && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-1">{job.outputTail}</pre>}
						</div>
					))}
					{!jobs.total && <div className="text-[10px] text-muted-foreground">No retained Mobile jobs.</div>}
				</div>
			</Panel>
		);
	}

	private _syncViewportRuntime(): void {
		const scene = this._scene();
		if (!scene || scene === this._runtimeScene) {
			return;
		}
		this._runtimeScene = scene;
		try {
			configureInputActions(scene as any);
			configureTouchControls(scene as any, { editor: true });
			configureMobileSystemRuntime(scene as any);
			configureGrpcTransport(scene as any);
		} catch (error) {
			this.setState({ error: this._error(error) });
		}
	}

	private _patchTouch(configuration: ITouchControlsConfiguration, changes: Record<string, unknown>): void {
		this._runSync(() => setTouchControlsConfiguration(this._scene()!, { expectedRevision: configuration.revision, changes }, { editor: this.props.editor }));
	}

	private _createControl(scene: Scene, configuration: ITouchControlsConfiguration, type: "button" | "stick"): void {
		this._runSync(() => {
			const result = createTouchControl(scene, { expectedRevision: configuration.revision, control: { type } }, { editor: this.props.editor });
			this.setState({ selectedControlId: result.control.id });
			return result;
		});
	}

	private _patchControl(id: string, changes: Record<string, unknown>): void {
		this._runSync(() => {
			const scene = this._scene()!;
			return setTouchControl(scene, { expectedRevision: getTouchControlsConfiguration(scene).revision, id, changes }, { editor: this.props.editor });
		});
	}

	private async _deleteControl(scene: Scene, configuration: ITouchControlsConfiguration, control: ITouchControlDefinition): Promise<void> {
		if (!(await showConfirm("Delete Touch Control?", `Delete “${control.name}” from the on-screen layout?`, { confirmText: "Delete" }))) {
			return;
		}
		this._runSync(() => deleteTouchControl(scene, { expectedRevision: configuration.revision, id: control.id, confirm: true }, { editor: this.props.editor }));
		this.setState({ selectedControlId: null });
	}

	private _patchDeployment(configuration: IMobileDeploymentConfiguration, changes: Record<string, unknown>): void {
		this._runSync(() => setMobileDeploymentConfiguration(this._scene()!, { expectedRevision: configuration.revision, changes }, { editor: this.props.editor }));
		this.setState({ pendingPlan: null });
		void this._refreshExternal();
	}

	private _patchAdaptive(configuration: IAdaptivePerformanceConfiguration, changes: Record<string, unknown>): void {
		this._runSync(() => setAdaptivePerformanceConfiguration(this._scene()!, { expectedRevision: configuration.revision, changes }, { editor: this.props.editor }));
	}

	private _simulateAdaptive(scene: Scene, configuration: IAdaptivePerformanceConfiguration, thermalState: "nominal" | "fair" | "serious" | "critical"): void {
		this._runSync(() =>
			simulateAdaptivePerformanceState(
				scene,
				{
					expectedRevision: configuration.revision,
					thermalState,
					temperatureLevel: thermalState === "critical" ? 1 : thermalState === "serious" ? 0.8 : thermalState === "fair" ? 0.5 : 0.1,
					frameTimeMs: 1000 / configuration.targetFrameRate,
					repeat: configuration.sampleFrames,
				},
				{ editor: this.props.editor }
			)
		);
	}

	private _resetAdaptive(scene: Scene, configuration: IAdaptivePerformanceConfiguration): void {
		this._runSync(() => resetAdaptivePerformanceRuntime(scene, { expectedRevision: configuration.revision }, { editor: this.props.editor }));
	}

	private _patchMobileSystem(configuration: IMobileSystemConfiguration, changes: Record<string, unknown>): void {
		this._runSync(() => setMobileSystemConfiguration(this._scene()!, { expectedRevision: configuration.revision, changes }, { editor: this.props.editor }));
	}

	private _simulateMobileSystem(scene: Scene, configuration: IMobileSystemConfiguration, thermalState: "serious" | "critical"): void {
		this._runSync(() => simulateMobileSystemState(scene, { expectedRevision: configuration.revision, thermalState }, { editor: this.props.editor }));
	}

	private _simulateMobileInsets(scene: Scene, configuration: IMobileSystemConfiguration): void {
		this._runSync(() =>
			simulateMobileSystemState(
				scene,
				{ expectedRevision: configuration.revision, windowInsets: { left: 0, top: 48, right: 0, bottom: 72 }, visibleWindowInsets: ["statusBars", "navigationBars"] },
				{ editor: this.props.editor }
			)
		);
	}

	private _resetMobileSystem(scene: Scene, configuration: IMobileSystemConfiguration): void {
		this._runSync(() => resetMobileSystemRuntime(scene, { expectedRevision: configuration.revision }, { editor: this.props.editor }));
	}

	private _patchGrpc(configuration: IGrpcTransportConfiguration, changes: Record<string, unknown>): void {
		this._runSync(() => setGrpcTransportConfiguration(this._scene()!, { expectedRevision: configuration.revision, changes }, { editor: this.props.editor }));
	}

	private _beginDrag(event: ReactPointerEvent<HTMLElement>, control: ITouchControlDefinition, mode: IDragState["mode"]): void {
		const previewElement = event.currentTarget.closest("[data-touch-layout-preview]");
		if (!(previewElement instanceof HTMLElement)) {
			return;
		}
		event.preventDefault();
		this.setState({ selectedControlId: control.id });
		this._removeDragListeners();
		const drag = {
			id: control.id,
			mode,
			startX: event.clientX,
			startY: event.clientY,
			startRect: structuredClone(control.rect),
			latest: structuredClone(control.rect),
			preview: previewElement.getBoundingClientRect(),
			onMove: (moveEvent: PointerEvent) => this._moveDrag(moveEvent),
			onUp: (_upEvent: PointerEvent) => this._finishDrag(),
		} satisfies IDragState;
		this._drag = drag;
		window.addEventListener("pointermove", drag.onMove);
		window.addEventListener("pointerup", drag.onUp, { once: true });
		window.addEventListener("pointercancel", drag.onUp, { once: true });
	}

	private _moveDrag(event: PointerEvent): void {
		const drag = this._drag;
		if (!drag) {
			return;
		}
		const dx = (event.clientX - drag.startX) / Math.max(1, drag.preview.width);
		const dy = (event.clientY - drag.startY) / Math.max(1, drag.preview.height);
		const rect = structuredClone(drag.startRect);
		if (drag.mode === "move") {
			rect.x = Math.max(0, Math.min(1 - rect.width, drag.startRect.x + dx));
			rect.y = Math.max(0, Math.min(1 - rect.height, drag.startRect.y + dy));
		} else {
			rect.width = Math.max(0.03, Math.min(1 - rect.x, drag.startRect.width + dx));
			rect.height = Math.max(0.03, Math.min(1 - rect.y, drag.startRect.height + dy));
		}
		for (const key of ["x", "y", "width", "height"] as const) {
			rect[key] = Number(rect[key].toFixed(4));
		}
		drag.latest = rect;
		this.setState({ dragRect: { id: drag.id, rect } });
	}

	private _finishDrag(): void {
		const drag = this._drag;
		this._removeDragListeners();
		this.setState({ dragRect: null });
		if (drag && JSON.stringify(drag.latest) !== JSON.stringify(drag.startRect)) {
			this._patchControl(drag.id, { rect: drag.latest });
		}
	}

	private _removeDragListeners(): void {
		if (!this._drag) {
			return;
		}
		window.removeEventListener("pointermove", this._drag.onMove);
		window.removeEventListener("pointerup", this._drag.onUp);
		window.removeEventListener("pointercancel", this._drag.onUp);
		this._drag = null;
	}

	private async _refreshExternal(force = false): Promise<void> {
		const scene = this._scene();
		if (!scene || (this.state.busy && !force)) {
			return;
		}
		this.setState({ busy: true, error: null });
		const target = this.state.target;
		const [status, scaffold, artifacts, devices] = await Promise.allSettled([
			validateMobileTarget(scene, { target }, { editor: this.props.editor }),
			getPlatformScaffold(scene, { target }, { editor: this.props.editor }),
			listMobileArtifacts(scene, { target, limit: 100 }, { editor: this.props.editor }),
			listMobileDevices(scene, { target, limit: 100 }),
		]);
		if (!this._mounted) {
			return;
		}
		this.setState({
			busy: false,
			targetStatus: status.status === "fulfilled" ? status.value : null,
			scaffold: scaffold.status === "fulfilled" ? scaffold.value : null,
			artifacts: artifacts.status === "fulfilled" ? (artifacts.value as any).artifacts : [],
			devices: devices.status === "fulfilled" ? (devices.value as any).devices : [],
			deviceError: devices.status === "rejected" ? this._error(devices.reason) : null,
			error:
				status.status === "rejected"
					? this._error(status.reason)
					: scaffold.status === "rejected"
						? this._error(scaffold.reason)
						: artifacts.status === "rejected"
							? this._error(artifacts.reason)
							: null,
		});
	}

	private async _generateScaffold(scene: Scene): Promise<void> {
		await this._runAsync(async () => {
			const current = await getPlatformScaffold(scene, { target: this.state.target }, { editor: this.props.editor });
			if (
				current.exists &&
				!(await showConfirm(`Update ${this.state.target} scaffold?`, "Replace only editor-owned generated files while retaining the current platform settings?", {
					confirmText: "Update Scaffold",
				}))
			) {
				return;
			}
			await generatePlatformScaffold(
				scene,
				{
					target: this.state.target,
					expectedRevision: current.revision,
					settings: current.manifest?.settings,
					overwrite: current.integrity === false,
					confirm: current.integrity === false,
				},
				{ editor: this.props.editor }
			);
			await this._refreshExternalAfterBusy();
		});
	}

	private async _updateScaffold(scene: Scene, changes: Record<string, unknown>): Promise<void> {
		await this._runAsync(async () => {
			const current = await getPlatformScaffold(scene, { target: this.state.target }, { editor: this.props.editor });
			await generatePlatformScaffold(
				scene,
				{ target: this.state.target, expectedRevision: current.revision, settings: { ...current.manifest.settings, ...changes } },
				{ editor: this.props.editor }
			);
			await this._refreshExternalAfterBusy();
		});
	}

	private async _planWorkflow(scene: Scene, deployment: IMobileDeploymentConfiguration, operation: "package" | "install" | "launch" | "logs" | "submit"): Promise<void> {
		await this._runAsync(async () => {
			const scaffold = await getPlatformScaffold(scene, { target: this.state.target }, { editor: this.props.editor });
			const data: Record<string, unknown> = { target: this.state.target, operation, expectedRevision: deployment.revision, expectedScaffoldRevision: scaffold.revision };
			if (operation === "install" || operation === "submit") {
				data.artifactPath = this.state.artifactPath;
			}
			if (operation === "install" || operation === "launch" || operation === "logs") {
				data.deviceId = this.state.deviceId;
			}
			if (operation === "logs") {
				data.durationSeconds = this.state.durationSeconds;
			}
			const pendingPlan = await planMobileWorkflow(scene, data, { editor: this.props.editor });
			this.setState({ pendingPlan });
		});
	}

	private async _executePlan(scene: Scene): Promise<void> {
		const plan = this.state.pendingPlan;
		if (
			!plan ||
			!(await showConfirm(`Execute ${plan.operation} for ${plan.target}?`, plan.warnings?.join(" ") ?? "Run the exact native-tool plan?", {
				confirmText: `Execute ${plan.operation}`,
			}))
		) {
			return;
		}
		await this._runAsync(async () => {
			const job = await executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, { editor: this.props.editor });
			this._hadActiveJob = true;
			this.setState({ pendingPlan: null });
			return job;
		});
	}

	private async _cancelJob(scene: Scene, jobId: string): Promise<void> {
		if (!(await showConfirm("Cancel Mobile job?", "Terminate the active native tool and retain its redacted output evidence?", { confirmText: "Cancel Job" }))) {
			return;
		}
		this._runSync(() => cancelMobileJob(scene, { jobId, confirm: true }));
	}

	private _runSync(operation: () => unknown): void {
		try {
			operation();
			this.setState({ error: null });
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: this._error(error) });
		}
	}

	private async _runAsync(operation: () => Promise<unknown>): Promise<void> {
		if (this.state.busy) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			await operation();
		} catch (error) {
			this.setState({ error: this._error(error) });
		} finally {
			if (this._mounted) {
				this.setState({ busy: false });
			}
		}
	}

	private async _refreshExternalAfterBusy(): Promise<void> {
		if (this._mounted) {
			this.setState({ busy: false });
		}
		await this._refreshExternal(true);
	}

	private _error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
