/** Portable profiler format shared by exported players, the editor, and MCP. */
export const PORTABLE_PROFILER_VERSION = 2 as const;

export type PortableProfilerModule = "cpu" | "gpu" | "rendering" | "memory" | "assets" | "scripts" | "physics" | "audio" | "2d";

export type PortableProfilerTarget = "editor-edit" | "editor-play" | "connected-player";

export type PortableProfilerCaptureStatus = "recording" | "completed" | "canceled" | "failed";

export type PortableProfilerMarkerCategory = "Scripts" | "Rendering" | "Physics" | "Animation" | "Assets" | "Audio" | "User";

export interface IPortableProfilerAvailability {
	available: boolean;
	precision: "exact" | "engine-counter" | "browser-counter" | "estimated" | "unavailable";
	reason: string | null;
}

export interface IPortableProfilerCpuMetrics {
	frameTimeMs: number;
	interFrameTimeMs: number | null;
	renderTimeMs: number | null;
	activeMeshesEvaluationTimeMs: number | null;
	renderTargetsTimeMs: number | null;
	animationsTimeMs: number | null;
	physicsTimeMs: number | null;
	particlesTimeMs: number | null;
	spritesTimeMs: number | null;
	cameraRenderTimeMs: number | null;
	scriptTimeMs: number;
	scriptCalls: number;
	scriptErrors: number;
}

export interface IPortableProfilerRenderingMetrics {
	drawCalls: number;
	batches: number;
	setPassCalls: number | null;
	activeMeshes: number;
	vertices: number;
	indices: number;
	triangles: number;
	materials: number;
	textures: number;
	lights: number;
	cameras: number;
	particleSystems: number;
	shaderCompilationTimeMs: number | null;
}

export interface IPortableProfilerMemoryMetrics {
	usedHeapBytes: number | null;
	totalHeapBytes: number | null;
	heapLimitBytes: number | null;
	estimatedGeometryBytes: number;
	estimatedTextureBytes: number;
	estimatedSceneBytes: number;
	sceneObjectCount: number;
	gcEvents: number | null;
	gcDurationMs: number | null;
}

export interface IPortableProfilerAssetMetrics {
	completedRequests: number;
	durationMs: number;
	transferBytes: number | null;
	decodedBodyBytes: number | null;
}

export interface IPortableProfilerAudioMetrics {
	soundCount: number;
	playingSoundCount: number;
}

export interface IPortableProfiler2DMetrics {
	atlasOwners: number;
	spriteManagers: number;
	spriteMaps: number;
	uniqueTextures: number;
	texturePixels: number;
	estimatedTextureBytes: number;
	definedRegions: number;
	usedRegions: number;
	definedRegionPixels: number;
	usedRegionPixels: number;
	spriteCount: number;
	visibleSpriteCount: number;
	tileCount: number;
	estimatedDrawCalls: number;
}

export interface IPortableProfiler2DRegion {
	id: string;
	name: string;
	x: number;
	y: number;
	width: number;
	height: number;
	rotated: boolean;
	used: boolean;
	usageCount: number;
}

export interface IPortableProfiler2DAtlas {
	id: string;
	name: string;
	kind: "sprite-manager" | "sprite-map";
	textureName: string | null;
	textureWidth: number;
	textureHeight: number;
	estimatedTextureBytes: number;
	regionCount: number;
	usedRegionCount: number;
	definedRegionPixels: number;
	usedRegionPixels: number;
	occupancyPercent: number;
	spriteCount: number;
	visibleSpriteCount: number;
	tileCount: number;
	estimatedDrawCalls: number;
	regions: IPortableProfiler2DRegion[];
	warnings: string[];
}

export interface IPortableProfiler2DSnapshot {
	capturedAt: string;
	metrics: IPortableProfiler2DMetrics;
	atlases: IPortableProfiler2DAtlas[];
	truncated: boolean;
	limitations: string[];
}

export interface IPortableProfilerFrame {
	index: number;
	capturedAt: string;
	elapsedMs: number;
	cpu: IPortableProfilerCpuMetrics | null;
	gpuFrameTimeMs: number | null;
	rendering: IPortableProfilerRenderingMetrics | null;
	memory: IPortableProfilerMemoryMetrics | null;
	assets: IPortableProfilerAssetMetrics | null;
	audio: IPortableProfilerAudioMetrics | null;
	twoD: IPortableProfiler2DMetrics | null;
}

export interface IPortableProfilerMarker {
	id: string;
	frameIndex: number;
	name: string;
	category: PortableProfilerMarkerCategory;
	startMs: number;
	durationMs: number;
	depth: number;
	parentId: string | null;
	thread: "main";
	objectId: string | null;
	objectName: string | null;
	scriptKey: string | null;
	lifecycle: "onStart" | "onUpdate" | "onStop" | null;
	error: string | null;
}

export interface IPortableProfilerAssetEvent {
	id: string;
	frameIndex: number;
	name: string;
	initiatorType: string;
	startMs: number;
	durationMs: number;
	transferBytes: number | null;
	encodedBodyBytes: number | null;
	decodedBodyBytes: number | null;
	protocol: string | null;
	availability: IPortableProfilerAvailability;
}

export interface IPortableProfilerMemorySnapshot {
	id: string;
	name: string;
	capturedAt: string;
	captureId: string | null;
	frameIndex: number | null;
	metrics: IPortableProfilerMemoryMetrics;
	counts: Record<string, number>;
	limitations: string[];
}

export interface IPortableProfilerNumericSummary {
	minimum: number;
	maximum: number;
	average: number;
	median: number;
	p95: number;
	latest: number;
	samples: number;
}

export interface IPortableProfilerMarkerSummary {
	key: string;
	name: string;
	category: PortableProfilerMarkerCategory;
	parentKey: string | null;
	depth: number;
	calls: number;
	totalMs: number;
	selfMs: number;
	averageMs: number;
	maximumMs: number;
	errors: number;
}

export interface IPortableProfilerCaptureSummary {
	frames: number;
	durationMs: number;
	metrics: Record<string, IPortableProfilerNumericSummary>;
	markers: IPortableProfilerMarkerSummary[];
	assetRequests: number;
	assetTransferBytes: number | null;
}

export interface IPortableProfilerCapture {
	version: typeof PORTABLE_PROFILER_VERSION;
	id: string;
	name: string;
	target: PortableProfilerTarget;
	status: PortableProfilerCaptureStatus;
	startedAt: string;
	finishedAt: string | null;
	failure: string | null;
	modules: PortableProfilerModule[];
	sampleEveryFrames: number;
	maximumFrames: number;
	maximumDurationMs: number;
	availability: Record<PortableProfilerModule, IPortableProfilerAvailability>;
	frames: IPortableProfilerFrame[];
	markers: IPortableProfilerMarker[];
	assetEvents: IPortableProfilerAssetEvent[];
	memorySnapshots: IPortableProfilerMemorySnapshot[];
	summary: IPortableProfilerCaptureSummary;
	limitations: string[];
}

export interface IPortableProfilerCaptureOptions {
	id?: string;
	name: string;
	target?: PortableProfilerTarget;
	modules?: PortableProfilerModule[];
	sampleEveryFrames?: number;
	maximumFrames?: number;
	maximumDurationMs?: number;
}

export interface IPortableProfilerState {
	version: typeof PORTABLE_PROFILER_VERSION;
	revision: number;
	maximumRetainedCaptures: number;
	maximumRetainedSnapshots: number;
	captures: IPortableProfilerCapture[];
	memorySnapshots: IPortableProfilerMemorySnapshot[];
}

export interface IPortableProfilerCaptureQuery {
	frameOffset?: number;
	frameLimit?: number;
	markerOffset?: number;
	markerLimit?: number;
	assetOffset?: number;
	assetLimit?: number;
	memorySnapshotOffset?: number;
	memorySnapshotLimit?: number;
	search?: string;
	category?: PortableProfilerMarkerCategory;
	view?: "timeline" | "hierarchy" | "inverted-hierarchy" | "raw-hierarchy";
}

export interface IPortableProfilerCaptureQueryResult {
	capture: Omit<IPortableProfilerCapture, "frames" | "markers" | "assetEvents" | "memorySnapshots">;
	frames: { total: number; offset: number; limit: number; entries: IPortableProfilerFrame[] };
	markers: { total: number; offset: number; limit: number; entries: IPortableProfilerMarker[] | IPortableProfilerMarkerSummary[] };
	assetEvents: { total: number; offset: number; limit: number; entries: IPortableProfilerAssetEvent[] };
	memorySnapshots: { total: number; offset: number; limit: number; entries: IPortableProfilerMemorySnapshot[] };
}

export interface IPortableProfilerMemoryComparison {
	baseline: { id: string; name: string; capturedAt: string };
	current: { id: string; name: string; capturedAt: string };
	metricDelta: Record<keyof IPortableProfilerMemoryMetrics, number | null>;
	countDelta: Record<string, number>;
	potentialGrowth: Array<{ key: string; delta: number; kind: "metric" | "count" }>;
	limitations: string[];
}

export interface IPortableProfilerSession {
	readonly capture: IPortableProfilerCapture;
	stop(status?: Exclude<PortableProfilerCaptureStatus, "recording">, failure?: string): IPortableProfilerCapture;
}

export interface IPortableProfilerCallbacks {
	onStopped?(capture: IPortableProfilerCapture): void;
}

export interface IPortableProfilerMarkerHandle {
	end(error?: unknown): void;
}
