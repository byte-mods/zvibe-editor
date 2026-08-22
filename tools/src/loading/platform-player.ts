export const platformPlayerSettingsVersion = 1 as const;
export const platformPlayerRuntimeBackend = "zvibe-platform-player-v1" as const;

export const linuxPlayerVariants = ["desktop", "embedded"] as const;
export const linuxLtoModes = ["thin", "full"] as const;
export const linuxImeModes = ["disabled", "ibus", "fcitx5"] as const;

export type LinuxPlayerVariant = (typeof linuxPlayerVariants)[number];
export type LinuxLtoMode = (typeof linuxLtoModes)[number];
export type LinuxImeMode = (typeof linuxImeModes)[number];
export type PlatformPlayerHost = "darwin" | "linux" | "win32" | "unknown";

export interface ILinuxPlatformPlayerSettings {
	variant: LinuxPlayerVariant;
	lto: LinuxLtoMode;
	ime: LinuxImeMode;
}

export interface IMacosPlatformPlayerSettings {
	useDisplayLink: boolean;
	maximumQueuedFrames: number;
}

export interface IPlatformPlayerSettings {
	version: typeof platformPlayerSettingsVersion;
	linux: ILinuxPlatformPlayerSettings;
	macos: IMacosPlatformPlayerSettings;
}

export interface IPlatformPlayerBuildPlan {
	model: typeof platformPlayerRuntimeBackend;
	platform: PlatformPlayerHost;
	settings: IPlatformPlayerSettings;
	lto: {
		enabled: boolean;
		mode: LinuxLtoMode | null;
		compilerFlags: string[];
		linkerFlags: string[];
		scope: "project-native-dependencies" | "not-applicable";
	};
	ime: {
		enabled: boolean;
		mode: LinuxImeMode;
		environment: Record<string, string>;
	};
	framePacing: {
		requestedDisplayLink: boolean;
		maximumQueuedFrames: number;
		portableBackend: "chromium-request-animation-frame";
		nativeAdapterRequired: boolean;
		queueDepthEnforcement: "native-adapter-required";
	};
	warnings: string[];
	limitations: string[];
}

export interface IPlatformPlayerCompositionEvidence {
	sequence: number;
	type: "start" | "update" | "end";
	text: string;
	source: "native-event" | "editor-simulation";
	capturedAt: string;
}

export interface IPlatformPlayerFramePacingEvidence {
	sampleCount: number;
	minimumDeltaMs: number;
	maximumDeltaMs: number;
	averageDeltaMs: number;
	standardDeviationMs: number;
	p95DeltaMs: number;
	backend: "chromium-default" | "chromium-request-animation-frame" | "native-metal-display-link";
	requestedDisplayLink: boolean;
	nativeDisplayLinkAvailable: boolean;
	maximumQueuedFrames: number;
	queueDepthApplied: boolean;
	capturedAt: string;
}

export interface IPlatformPlayerRuntimeSnapshot {
	backend: typeof platformPlayerRuntimeBackend;
	revision: number;
	configured: boolean;
	host: PlatformPlayerHost;
	settings: IPlatformPlayerSettings;
	compositionEvents: IPlatformPlayerCompositionEvidence[];
	framePacing: IPlatformPlayerFramePacingEvidence | null;
	warnings: string[];
	limits: { maximumCompositionEvents: number; maximumCompositionTextLength: number; maximumFrameSamples: number };
}

export interface IPlatformPlayerRuntimeOptions {
	host?: PlatformPlayerHost;
	imeTarget?: EventTarget | null;
	requestAnimationFrame?: ((callback: FrameRequestCallback) => number) | null;
	cancelAnimationFrame?: ((handle: number) => void) | null;
	nativeDisplayLinkAvailable?: boolean;
}

const maximumCompositionEvents = 64;
const maximumCompositionTextLength = 1_024;
const maximumFrameSamples = 240;

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function assertKnownFields(source: Record<string, unknown>, fields: readonly string[], label: string): void {
	const unknown = Object.keys(source).filter((key) => !fields.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function selection<T extends string>(value: unknown, values: readonly T[], fallback: T, label: string): T {
	if (value === undefined) {
		return fallback;
	}
	if (!values.includes(value as T)) {
		throw new Error(`${label} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

/** Strictly normalizes the portable Linux/macOS player settings shared by profiles, packaging, runtime, and MCP. */
export function normalizePlatformPlayerSettings(value: unknown = {}): IPlatformPlayerSettings {
	const source = asRecord(value, "Platform player settings");
	assertKnownFields(source, ["version", "linux", "macos"], "Platform player settings");
	if (source.version !== undefined && source.version !== platformPlayerSettingsVersion) {
		throw new Error(`Platform player settings version must be ${platformPlayerSettingsVersion}.`);
	}
	const linux = source.linux === undefined ? {} : asRecord(source.linux, "Linux player settings");
	const macos = source.macos === undefined ? {} : asRecord(source.macos, "macOS player settings");
	assertKnownFields(linux, ["variant", "lto", "ime"], "Linux player settings");
	assertKnownFields(macos, ["useDisplayLink", "maximumQueuedFrames"], "macOS player settings");
	const variant = selection(linux.variant, linuxPlayerVariants, "desktop", "Linux variant");
	const lto = selection(linux.lto, linuxLtoModes, "thin", "Linux LTO mode");
	const ime = selection(linux.ime, linuxImeModes, "ibus", "Linux IME mode");
	if (variant === "embedded" && ime === "fcitx5") {
		throw new Error("Embedded Linux supports disabled or IBUS IME; FCITX5 is desktop-only.");
	}
	const useDisplayLink = macos.useDisplayLink === true;
	const maximumQueuedFrames = macos.maximumQueuedFrames ?? 2;
	if (!Number.isSafeInteger(maximumQueuedFrames) || Number(maximumQueuedFrames) < 1 || Number(maximumQueuedFrames) > 3) {
		throw new Error("macOS maximumQueuedFrames must be an integer from 1 through 3.");
	}
	return {
		version: platformPlayerSettingsVersion,
		linux: { variant, lto, ime },
		macos: { useDisplayLink, maximumQueuedFrames: Number(maximumQueuedFrames) },
	};
}

/** Returns the environment that must exist before Electron/Chromium initializes its Linux input-method backend. */
export function getLinuxImeEnvironment(value: unknown): Record<string, string> {
	const settings = normalizePlatformPlayerSettings(value);
	if (settings.linux.ime === "disabled") {
		return {};
	}
	const moduleName = settings.linux.ime === "ibus" ? "ibus" : "fcitx";
	return {
		GTK_IM_MODULE: moduleName,
		QT_IM_MODULE: moduleName,
		XMODIFIERS: `@im=${moduleName}`,
		SDL_IM_MODULE: moduleName,
	};
}

/** Builds an honest target plan; LTO is limited to project-owned native dependencies and never claims Electron/Unity binary rebuilding. */
export function getPlatformPlayerBuildPlan(value: unknown, platform: PlatformPlayerHost): IPlatformPlayerBuildPlan {
	const settings = normalizePlatformPlayerSettings(value);
	const linux = platform === "linux";
	const macos = platform === "darwin";
	const ltoFlag = settings.linux.lto === "thin" ? "-flto=thin" : "-flto=full";
	const warnings: string[] = [];
	if (linux && settings.linux.variant === "embedded") {
		warnings.push("Embedded Linux is represented by a bounded Electron/Linux target policy; board SDK, sysroot, and compositor integration remain external.");
	}
	if (macos && settings.macos.useDisplayLink) {
		warnings.push("Electron uses Chromium display-synchronized requestAnimationFrame unless a native Metal display-link adapter reports availability.");
	}
	return {
		model: platformPlayerRuntimeBackend,
		platform,
		settings,
		lto: {
			enabled: linux,
			mode: linux ? settings.linux.lto : null,
			compilerFlags: linux ? [ltoFlag] : [],
			linkerFlags: linux ? [ltoFlag] : [],
			scope: linux ? "project-native-dependencies" : "not-applicable",
		},
		ime: { enabled: linux && settings.linux.ime !== "disabled", mode: linux ? settings.linux.ime : "disabled", environment: linux ? getLinuxImeEnvironment(settings) : {} },
		framePacing: {
			requestedDisplayLink: macos && settings.macos.useDisplayLink,
			maximumQueuedFrames: settings.macos.maximumQueuedFrames,
			portableBackend: "chromium-request-animation-frame",
			nativeAdapterRequired: macos && settings.macos.useDisplayLink,
			queueDepthEnforcement: "native-adapter-required",
		},
		warnings,
		limitations: [
			"LTO flags apply only while rebuilding project-owned native dependencies; the prebuilt Electron/Chromium runtime is not relinked.",
			"IBUS/FCITX5 availability and desktop-session daemon state are host responsibilities.",
			"Native CAMetalDisplayLink requires a host adapter; portable Electron evidence uses Chromium requestAnimationFrame timing.",
		],
	};
}

function inferredHost(): PlatformPlayerHost {
	const platform = (globalThis as unknown as { process?: { platform?: string } }).process?.platform;
	return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "unknown";
}

function rounded(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

/** Bounded composition and display-synchronized frame evidence shared by packaged players and the editor bridge. */
export class PlatformPlayerRuntime {
	private readonly _host: PlatformPlayerHost;
	private readonly _settings: IPlatformPlayerSettings;
	private readonly _imeTarget: EventTarget | null;
	private readonly _requestAnimationFrame: ((callback: FrameRequestCallback) => number) | null;
	private readonly _cancelAnimationFrame: ((handle: number) => void) | null;
	private readonly _nativeDisplayLinkAvailable: boolean;
	private readonly _compositionEvents: IPlatformPlayerCompositionEvidence[] = [];
	private readonly _warnings: string[] = [];
	private _revision = 1;
	private _configured = false;
	private _sequence = 0;
	private _framePacing: IPlatformPlayerFramePacingEvidence | null = null;
	private _activeFrameHandle: number | null = null;
	private _activeFrameTimeout: ReturnType<typeof setTimeout> | null = null;
	private _activeFrameReject: ((error: Error) => void) | null = null;
	private readonly _compositionListener = (event: Event): void => {
		const composition = event as CompositionEvent;
		const type = event.type === "compositionstart" ? "start" : event.type === "compositionend" ? "end" : "update";
		this.recordComposition(type, composition.data ?? "", "native-event");
	};

	public constructor(value: unknown = {}, options: IPlatformPlayerRuntimeOptions = {}) {
		this._settings = normalizePlatformPlayerSettings(value);
		this._host = options.host ?? inferredHost();
		this._imeTarget = options.imeTarget === undefined ? (typeof document === "undefined" ? null : document) : options.imeTarget;
		this._requestAnimationFrame =
			options.requestAnimationFrame === undefined
				? typeof requestAnimationFrame === "function"
					? requestAnimationFrame.bind(globalThis)
					: null
				: options.requestAnimationFrame;
		this._cancelAnimationFrame =
			options.cancelAnimationFrame === undefined ? (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame.bind(globalThis) : null) : options.cancelAnimationFrame;
		const nativeAdapter = (globalThis as unknown as { zvibeMetalDisplayLink?: { available?: boolean } }).zvibeMetalDisplayLink;
		this._nativeDisplayLinkAvailable = options.nativeDisplayLinkAvailable ?? nativeAdapter?.available === true;
	}

	public start(): IPlatformPlayerRuntimeSnapshot {
		if (!this._configured) {
			for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
				this._imeTarget?.addEventListener(type, this._compositionListener);
			}
			this._configured = true;
			if (this._host === "darwin" && this._settings.macos.useDisplayLink && !this._nativeDisplayLinkAvailable) {
				this._warnings.push("Native Metal display-link adapter is unavailable; Chromium requestAnimationFrame remains display-synchronized.");
			}
			this._revision++;
		}
		return this.snapshot();
	}

	public recordComposition(type: IPlatformPlayerCompositionEvidence["type"], text: string, source: IPlatformPlayerCompositionEvidence["source"]): IPlatformPlayerRuntimeSnapshot {
		if (!this._configured) {
			throw new Error("Platform player runtime is not started.");
		}
		if (!(["start", "update", "end"] as const).includes(type) || typeof text !== "string" || text.length > maximumCompositionTextLength) {
			throw new Error(`Composition type/text is invalid; text is limited to ${maximumCompositionTextLength.toLocaleString()} characters.`);
		}
		this._compositionEvents.push({ sequence: ++this._sequence, type, text, source, capturedAt: new Date().toISOString() });
		this._compositionEvents.splice(0, Math.max(0, this._compositionEvents.length - maximumCompositionEvents));
		this._revision++;
		return this.snapshot();
	}

	public async sampleFramePacing(sampleCount: number): Promise<IPlatformPlayerRuntimeSnapshot> {
		if (!this._configured) {
			throw new Error("Platform player runtime is not started.");
		}
		if (!Number.isSafeInteger(sampleCount) || sampleCount < 2 || sampleCount > maximumFrameSamples) {
			throw new Error(`Frame sampleCount must be an integer from 2 through ${maximumFrameSamples}.`);
		}
		if (!this._requestAnimationFrame) {
			throw new Error("requestAnimationFrame is unavailable in this runtime.");
		}
		if (this._activeFrameHandle !== null) {
			throw new Error("Frame-pacing sampling is already active.");
		}
		const timestamps: number[] = [];
		await new Promise<void>((resolvePromise, rejectPromise) => {
			this._activeFrameReject = rejectPromise;
			this._activeFrameTimeout = setTimeout(() => {
				if (this._activeFrameHandle !== null) {
					this._cancelAnimationFrame?.(this._activeFrameHandle);
					this._activeFrameHandle = null;
				}
				this._activeFrameTimeout = null;
				this._activeFrameReject = null;
				rejectPromise(new Error("Frame-pacing sampling timed out after 10 seconds; keep the editor visible and try a smaller sampleCount."));
			}, 10_000);
			const capture = (timestamp: number): void => {
				timestamps.push(timestamp);
				if (timestamps.length >= sampleCount + 1) {
					this._activeFrameHandle = null;
					clearTimeout(this._activeFrameTimeout!);
					this._activeFrameTimeout = null;
					this._activeFrameReject = null;
					resolvePromise();
					return;
				}
				this._activeFrameHandle = this._requestAnimationFrame!(capture);
			};
			this._activeFrameHandle = this._requestAnimationFrame!(capture);
		});
		const deltas = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
		const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
		const variance = deltas.reduce((sum, value) => sum + (value - average) ** 2, 0) / deltas.length;
		const sorted = [...deltas].sort((left, right) => left - right);
		this._framePacing = {
			sampleCount: deltas.length,
			minimumDeltaMs: rounded(sorted[0]),
			maximumDeltaMs: rounded(sorted.at(-1)!),
			averageDeltaMs: rounded(average),
			standardDeviationMs: rounded(Math.sqrt(variance)),
			p95DeltaMs: rounded(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
			backend:
				this._host === "darwin" && this._settings.macos.useDisplayLink
					? this._nativeDisplayLinkAvailable
						? "native-metal-display-link"
						: "chromium-request-animation-frame"
					: "chromium-default",
			requestedDisplayLink: this._host === "darwin" && this._settings.macos.useDisplayLink,
			nativeDisplayLinkAvailable: this._nativeDisplayLinkAvailable,
			maximumQueuedFrames: this._settings.macos.maximumQueuedFrames,
			queueDepthApplied: this._host === "darwin" && this._settings.macos.useDisplayLink && this._nativeDisplayLinkAvailable,
			capturedAt: new Date().toISOString(),
		};
		this._revision++;
		return this.snapshot();
	}

	public reset(): IPlatformPlayerRuntimeSnapshot {
		this._compositionEvents.length = 0;
		this._framePacing = null;
		this._sequence = 0;
		this._revision++;
		return this.snapshot();
	}

	public snapshot(): IPlatformPlayerRuntimeSnapshot {
		return {
			backend: platformPlayerRuntimeBackend,
			revision: this._revision,
			configured: this._configured,
			host: this._host,
			settings: structuredClone(this._settings),
			compositionEvents: structuredClone(this._compositionEvents),
			framePacing: structuredClone(this._framePacing),
			warnings: [...this._warnings],
			limits: { maximumCompositionEvents, maximumCompositionTextLength, maximumFrameSamples },
		};
	}

	public dispose(): void {
		for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
			this._imeTarget?.removeEventListener(type, this._compositionListener);
		}
		if (this._activeFrameHandle !== null) {
			this._cancelAnimationFrame?.(this._activeFrameHandle);
			this._activeFrameHandle = null;
		}
		if (this._activeFrameTimeout !== null) {
			clearTimeout(this._activeFrameTimeout);
			this._activeFrameTimeout = null;
		}
		this._activeFrameReject?.(new Error("Platform player runtime was disposed while frame-pacing sampling was active."));
		this._activeFrameReject = null;
		this._configured = false;
		this._revision++;
	}
}
