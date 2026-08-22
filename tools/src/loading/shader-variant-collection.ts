import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Material } from "@babylonjs/core/Materials/material";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";

export const shaderVariantCollectionMetadataKey = "babylonEditorShaderVariantCollection";
export const shaderVariantCollectionLimits = {
	maximumVariants: 4_096,
	maximumPrewarmPerLoad: 512,
	maximumMeshesPerFrame: 2_048,
	maximumSubMeshesPerMesh: 1_024,
	maximumSubMeshesPerFrame: 4_096,
	maximumErrors: 64,
	compilationTimeoutMs: 15_000,
} as const;

export type ShaderVariantBackend = "null" | "webgl1" | "webgl2" | "webgpu" | "unknown";

export interface IShaderVariantRecord {
	id: string;
	materialId: string;
	materialClass: string;
	meshId: string;
	subMeshIndex: number;
	backend: ShaderVariantBackend;
	clipPlane: boolean;
	useInstances: boolean;
	effectKeyHash: string;
}

export interface IShaderVariantCollectionConfiguration {
	version: 1;
	revision: number;
	enabled: boolean;
	automaticTracing: boolean;
	automaticPrewarming: boolean;
	maximumVariants: number;
	maximumPrewarmPerLoad: number;
	variants: IShaderVariantRecord[];
}

export interface IShaderVariantCollectionRuntimeStatus {
	configurationRevision: number;
	active: boolean;
	tracing: boolean;
	prewarming: boolean;
	backend: ShaderVariantBackend;
	variantCount: number;
	tracedFrames: number;
	tracedVariants: number;
	droppedVariants: number;
	prewarmRuns: number;
	prewarmAttempted: number;
	prewarmed: number;
	prewarmSkipped: number;
	prewarmFailed: number;
	errors: string[];
	boundary: string;
}

export interface IShaderVariantCollectionValidationIssue {
	code: string;
	severity: "warning" | "error";
	variantId: string | null;
	message: string;
	action: "none" | "render-and-trace" | "remove-stale-variant" | "make-resource-ids-unique";
}

export interface IShaderVariantCollectionValidationResult {
	valid: boolean;
	configurationRevision: number;
	configurationFingerprint: string;
	backend: ShaderVariantBackend;
	variantCount: number;
	resolvableVariantCount: number;
	issues: IShaderVariantCollectionValidationIssue[];
	boundary: string;
}

const runtimeBoundary =
	"Portable Babylon material/effect tracing and forceCompilationAsync prewarming; this does not expose Unity GraphicsStateCollection, native render-pipeline-state identity, driver caches, or vendor PSO binaries.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}.`);
	}
}

function exactInteger(value: unknown, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return Number(value);
}

function boundedText(value: unknown, maximum: number, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain 1–${maximum} characters.`);
	}
	return value.trim();
}

function boundedOpaqueText(value: unknown, maximum: number, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain 1–${maximum} characters.`);
	}
	return value;
}

function portableHash(value: string): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193) >>> 0;
		second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
	}
	return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function increment(value: number): number {
	return value < Number.MAX_SAFE_INTEGER ? value + 1 : Number.MAX_SAFE_INTEGER;
}

function variantSignature(value: Omit<IShaderVariantRecord, "id">): string {
	return JSON.stringify([value.materialId, value.materialClass, value.meshId, value.subMeshIndex, value.backend, value.clipPlane, value.useInstances, value.effectKeyHash]);
}

function normalizeVariant(value: unknown, index: number): IShaderVariantRecord {
	if (!isRecord(value)) {
		throw new Error(`Shader variant ${index} must be an object.`);
	}
	assertKeys(value, ["id", "materialId", "materialClass", "meshId", "subMeshIndex", "backend", "clipPlane", "useInstances", "effectKeyHash"], `Shader variant ${index}`);
	const backend = value.backend;
	if (backend !== "null" && backend !== "webgl1" && backend !== "webgl2" && backend !== "webgpu" && backend !== "unknown") {
		throw new Error(`Shader variant ${index} backend is invalid.`);
	}
	if (typeof value.clipPlane !== "boolean" || typeof value.useInstances !== "boolean") {
		throw new Error(`Shader variant ${index} clipPlane and useInstances must be booleans.`);
	}
	const id = boundedText(value.id, 32, `Shader variant ${index} id`);
	const effectKeyHash = boundedText(value.effectKeyHash, 16, `Shader variant ${index} effectKeyHash`);
	if (!/^[a-f0-9]{16}(?:-[0-9]+)?$/.test(id) || !/^[a-f0-9]{16}$/.test(effectKeyHash)) {
		throw new Error(`Shader variant ${index} id or effectKeyHash is invalid.`);
	}
	return {
		id,
		materialId: boundedOpaqueText(value.materialId, 256, `Shader variant ${index} materialId`),
		materialClass: boundedOpaqueText(value.materialClass, 128, `Shader variant ${index} materialClass`),
		meshId: boundedOpaqueText(value.meshId, 256, `Shader variant ${index} meshId`),
		subMeshIndex: exactInteger(value.subMeshIndex, 0, 65_535, `Shader variant ${index} subMeshIndex`),
		backend,
		clipPlane: value.clipPlane,
		useInstances: value.useInstances,
		effectKeyHash,
	};
}

/** Returns a new disabled collection without mutating a scene. */
export function createDefaultShaderVariantCollectionConfiguration(): IShaderVariantCollectionConfiguration {
	return {
		version: 1,
		revision: 1,
		enabled: false,
		automaticTracing: true,
		automaticPrewarming: true,
		maximumVariants: 4_096,
		maximumPrewarmPerLoad: 256,
		variants: [],
	};
}

/** Strictly validates current-version portable shader-variant collection metadata. */
export function normalizeShaderVariantCollectionConfiguration(value: unknown): IShaderVariantCollectionConfiguration {
	if (value === undefined || value === null) {
		return createDefaultShaderVariantCollectionConfiguration();
	}
	if (!isRecord(value)) {
		throw new Error("Shader Variant Collection configuration must be an object.");
	}
	assertKeys(
		value,
		["version", "revision", "enabled", "automaticTracing", "automaticPrewarming", "maximumVariants", "maximumPrewarmPerLoad", "variants"],
		"Shader Variant Collection"
	);
	if (value.version !== 1) {
		throw new Error("Shader Variant Collection version must be 1.");
	}
	if (typeof value.enabled !== "boolean" || typeof value.automaticTracing !== "boolean" || typeof value.automaticPrewarming !== "boolean") {
		throw new Error("Shader Variant Collection enabled, automaticTracing, and automaticPrewarming must be booleans.");
	}
	const maximumVariants = exactInteger(value.maximumVariants, 1, shaderVariantCollectionLimits.maximumVariants, "Shader Variant Collection maximumVariants");
	const maximumPrewarmPerLoad = exactInteger(
		value.maximumPrewarmPerLoad,
		1,
		shaderVariantCollectionLimits.maximumPrewarmPerLoad,
		"Shader Variant Collection maximumPrewarmPerLoad"
	);
	if (!Array.isArray(value.variants) || value.variants.length > maximumVariants) {
		throw new Error(`Shader Variant Collection variants must be an array with at most ${maximumVariants} entries.`);
	}
	const variants = value.variants.map(normalizeVariant);
	const ids = new Set<string>();
	const signatures = new Set<string>();
	for (const variant of variants) {
		const signature = variantSignature(variant);
		if (ids.has(variant.id) || signatures.has(signature)) {
			throw new Error(`Shader Variant Collection contains duplicate variant ${variant.id}.`);
		}
		ids.add(variant.id);
		signatures.add(signature);
	}
	return {
		version: 1,
		revision: exactInteger(value.revision, 1, Number.MAX_SAFE_INTEGER, "Shader Variant Collection revision"),
		enabled: value.enabled,
		automaticTracing: value.automaticTracing,
		automaticPrewarming: value.automaticPrewarming,
		maximumVariants,
		maximumPrewarmPerLoad,
		variants,
	};
}

/** Reads strict current scene metadata without installing a runtime. */
export function getShaderVariantCollectionConfiguration(scene: Scene): IShaderVariantCollectionConfiguration {
	return normalizeShaderVariantCollectionConfiguration(scene.metadata?.[shaderVariantCollectionMetadataKey]);
}

/** Returns the exact deterministic lease fingerprint for one strict collection. */
export function getShaderVariantCollectionFingerprint(configuration: IShaderVariantCollectionConfiguration): string {
	return portableHash(JSON.stringify(normalizeShaderVariantCollectionConfiguration(configuration)));
}

function backendForScene(scene: Scene): ShaderVariantBackend {
	const engine = scene.getEngine() as any;
	if (
		engine?.constructor?.name === "NullEngine" ||
		engine?.getClassName?.() === "NullEngine" ||
		engine?.getRenderingCanvas?.() === undefined ||
		engine?.getRenderingCanvas?.() === null
	) {
		return "null";
	}
	if (engine?.isWebGPU === true) {
		return "webgpu";
	}
	return engine?.webGLVersion === 2 ? "webgl2" : engine?.webGLVersion === 1 ? "webgl1" : "unknown";
}

function hasClipPlane(scene: Scene): boolean {
	const source = scene as any;
	return Boolean(source.clipPlane || source.clipPlane2 || source.clipPlane3 || source.clipPlane4 || source.clipPlane5 || source.clipPlane6);
}

function hasInstances(mesh: AbstractMesh): boolean {
	const source = mesh as any;
	return source.hasInstances === true || source.hasThinInstances === true || Number(source.instances?.length ?? 0) > 0 || Number(source.thinInstanceCount ?? 0) > 0;
}

function findMaterial(scene: Scene, id: string): Material | null {
	const matches = scene.materials.filter((material) => material.id === id);
	return matches.length === 1 ? matches[0] : null;
}

function findMesh(scene: Scene, id: string): AbstractMesh | null {
	const matches = scene.meshes.filter((mesh) => mesh.id === id);
	return matches.length === 1 ? matches[0] : null;
}

/** Audits every retained record against the current scene without compiling or changing state. */
export function validateShaderVariantCollection(
	scene: Scene,
	configuration: IShaderVariantCollectionConfiguration = getShaderVariantCollectionConfiguration(scene)
): IShaderVariantCollectionValidationResult {
	const value = normalizeShaderVariantCollectionConfiguration(configuration);
	const issues: IShaderVariantCollectionValidationIssue[] = [];
	let resolvableVariantCount = 0;
	for (const variant of value.variants) {
		const materialMatches = scene.materials.filter((material) => material.id === variant.materialId);
		const meshMatches = scene.meshes.filter((mesh) => mesh.id === variant.meshId);
		if (materialMatches.length > 1 || meshMatches.length > 1) {
			issues.push({
				code: "SVC1001",
				severity: "error",
				variantId: variant.id,
				message: `Variant ${variant.id} has an ambiguous material or mesh id in the current scene.`,
				action: "make-resource-ids-unique",
			});
			continue;
		}
		const material = materialMatches[0];
		const mesh = meshMatches[0];
		const subMesh = mesh?.subMeshes[variant.subMeshIndex];
		if (!material || !mesh || !subMesh || subMesh.getMaterial()?.id !== material.id) {
			issues.push({
				code: "SVC1002",
				severity: "warning",
				variantId: variant.id,
				message: `Variant ${variant.id} no longer resolves to its exact material, mesh, and submesh assignment.`,
				action: "remove-stale-variant",
			});
			continue;
		}
		if (material.getClassName() !== variant.materialClass) {
			issues.push({
				code: "SVC1003",
				severity: "warning",
				variantId: variant.id,
				message: `Variant ${variant.id} material class changed from ${variant.materialClass} to ${material.getClassName()}.`,
				action: "render-and-trace",
			});
			continue;
		}
		resolvableVariantCount++;
		if (variant.backend !== backendForScene(scene)) {
			issues.push({
				code: "SVC1004",
				severity: "warning",
				variantId: variant.id,
				message: `Variant ${variant.id} was traced for ${variant.backend}; the current backend is ${backendForScene(scene)}.`,
				action: "render-and-trace",
			});
		}
	}
	return {
		valid: !issues.some((issue) => issue.severity === "error"),
		configurationRevision: value.revision,
		configurationFingerprint: getShaderVariantCollectionFingerprint(value),
		backend: backendForScene(scene),
		variantCount: value.variants.length,
		resolvableVariantCount,
		issues,
		boundary: runtimeBoundary,
	};
}

async function withCompilationTimeout(work: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Material compilation exceeded ${shaderVariantCollectionLimits.compilationTimeoutMs}ms.`)),
					shaderVariantCollectionLimits.compilationTimeoutMs
				);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

class ShaderVariantCollectionRuntime {
	private _observer: Observer<Scene> | null = null;
	private _disposeObserver: Observer<Scene> | null = null;
	private _disposed = false;
	private _prewarmPromise: Promise<IShaderVariantCollectionRuntimeStatus> | null = null;
	private _tracedFrames = 0;
	private _tracedVariants = 0;
	private _droppedVariants = 0;
	private _prewarmRuns = 0;
	private _prewarmAttempted = 0;
	private _prewarmed = 0;
	private _prewarmSkipped = 0;
	private _prewarmFailed = 0;
	private readonly _errors: string[] = [];
	private readonly _signatures: Set<string>;

	public constructor(
		private readonly _scene: Scene,
		private readonly _configuration: IShaderVariantCollectionConfiguration
	) {
		this._signatures = new Set(_configuration.variants.map(variantSignature));
		this._disposeObserver = _scene.onDisposeObservable.add(() => this.dispose());
	}

	public startTracing(): void {
		if (this._disposed || this._observer || !this._configuration.enabled) {
			return;
		}
		this._observer = this._scene.onAfterRenderObservable.add(() => this.traceFrame());
	}

	public stopTracing(): void {
		if (this._observer) {
			this._scene.onAfterRenderObservable.remove(this._observer);
			this._observer = null;
		}
	}

	public traceFrame(): number {
		if (this._disposed || !this._configuration.enabled || this._scene.isDisposed) {
			return 0;
		}
		this._tracedFrames = increment(this._tracedFrames);
		if (this._configuration.variants.length >= this._configuration.maximumVariants) {
			this._droppedVariants = increment(this._droppedVariants);
			return 0;
		}
		const activeMeshes = this._scene.getActiveMeshes();
		const maximum = Math.min(activeMeshes.length, shaderVariantCollectionLimits.maximumMeshesPerFrame);
		let added = 0;
		let inspectedSubMeshes = 0;
		for (let meshIndex = 0; meshIndex < maximum; meshIndex++) {
			const mesh = activeMeshes.data[meshIndex];
			if (!mesh) {
				continue;
			}
			const subMeshes = mesh.subMeshes ?? [];
			const maximumSubMeshes = Math.min(subMeshes.length, shaderVariantCollectionLimits.maximumSubMeshesPerMesh);
			for (let subMeshIndex = 0; subMeshIndex < maximumSubMeshes; subMeshIndex++) {
				if (inspectedSubMeshes++ >= shaderVariantCollectionLimits.maximumSubMeshesPerFrame) {
					return added;
				}
				const subMesh = subMeshes[subMeshIndex];
				const material = subMesh.getMaterial();
				const effect = subMesh.effect;
				const materialClass = material?.getClassName() ?? "";
				if (!material || !effect || !material.id.trim() || !mesh.id.trim() || !materialClass.trim()) {
					continue;
				}
				if (material.id.length > 256 || mesh.id.length > 256 || materialClass.length > 128) {
					this._droppedVariants = increment(this._droppedVariants);
					const message = "Shader trace skipped a material or mesh whose opaque id exceeds the portable collection limit.";
					if (!this._errors.includes(message)) {
						this._pushError(message);
					}
					continue;
				}
				const candidate: Omit<IShaderVariantRecord, "id"> = {
					materialId: material.id,
					materialClass,
					meshId: mesh.id,
					subMeshIndex,
					backend: backendForScene(this._scene),
					clipPlane: hasClipPlane(this._scene),
					useInstances: hasInstances(mesh),
					effectKeyHash: portableHash(effect.key || String(subMesh.materialDefines ?? "")),
				};
				const signature = variantSignature(candidate);
				if (this._signatures.has(signature)) {
					continue;
				}
				if (this._configuration.variants.length >= this._configuration.maximumVariants) {
					this._droppedVariants = increment(this._droppedVariants);
					return added;
				}
				if (this._configuration.revision >= Number.MAX_SAFE_INTEGER) {
					this._droppedVariants = increment(this._droppedVariants);
					if (!this._errors.includes("Shader Variant Collection revision reached Number.MAX_SAFE_INTEGER; new variants are not retained.")) {
						this._pushError("Shader Variant Collection revision reached Number.MAX_SAFE_INTEGER; new variants are not retained.");
					}
					continue;
				}
				let id = portableHash(signature);
				let collision = 1;
				while (this._configuration.variants.some((variant) => variant.id === id)) {
					id = `${portableHash(signature)}-${collision++}`;
				}
				this._configuration.variants.push({ id, ...candidate });
				this._signatures.add(signature);
				this._configuration.revision++;
				this._tracedVariants = increment(this._tracedVariants);
				added++;
			}
		}
		return added;
	}

	public async prewarm(): Promise<IShaderVariantCollectionRuntimeStatus> {
		if (this._prewarmPromise) {
			return this._prewarmPromise;
		}
		if (this._disposed || !this._configuration.enabled || this._scene.isDisposed) {
			return this.getStatus();
		}
		this._prewarmPromise = this._prewarmInternal();
		try {
			return await this._prewarmPromise;
		} finally {
			this._prewarmPromise = null;
		}
	}

	public getStatus(): IShaderVariantCollectionRuntimeStatus {
		return {
			configurationRevision: this._configuration.revision,
			active: !this._disposed && this._configuration.enabled,
			tracing: this._observer !== null,
			prewarming: this._prewarmPromise !== null,
			backend: backendForScene(this._scene),
			variantCount: this._configuration.variants.length,
			tracedFrames: this._tracedFrames,
			tracedVariants: this._tracedVariants,
			droppedVariants: this._droppedVariants,
			prewarmRuns: this._prewarmRuns,
			prewarmAttempted: this._prewarmAttempted,
			prewarmed: this._prewarmed,
			prewarmSkipped: this._prewarmSkipped,
			prewarmFailed: this._prewarmFailed,
			errors: [...this._errors],
			boundary: runtimeBoundary,
		};
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this.stopTracing();
		if (this._disposeObserver) {
			this._scene.onDisposeObservable.remove(this._disposeObserver);
			this._disposeObserver = null;
		}
	}

	private async _prewarmInternal(): Promise<IShaderVariantCollectionRuntimeStatus> {
		this._prewarmRuns = increment(this._prewarmRuns);
		const variants = this._configuration.variants.slice(0, this._configuration.maximumPrewarmPerLoad);
		for (let index = 0; index < variants.length && !this._disposed && !this._scene.isDisposed; index += 4) {
			await Promise.all(variants.slice(index, index + 4).map((variant) => this._compileVariant(variant)));
		}
		return this.getStatus();
	}

	private async _compileVariant(variant: IShaderVariantRecord): Promise<void> {
		this._prewarmAttempted = increment(this._prewarmAttempted);
		const material = findMaterial(this._scene, variant.materialId);
		const mesh = findMesh(this._scene, variant.meshId);
		const subMesh = mesh?.subMeshes?.[variant.subMeshIndex];
		if (!material || !mesh || !subMesh || subMesh.getMaterial()?.id !== material.id) {
			this._prewarmSkipped = increment(this._prewarmSkipped);
			return;
		}
		try {
			await withCompilationTimeout(material.forceCompilationAsync(mesh, { clipPlane: variant.clipPlane, useInstances: variant.useInstances }));
			this._prewarmed = increment(this._prewarmed);
		} catch (error) {
			this._prewarmFailed = increment(this._prewarmFailed);
			this._pushError(`Variant ${variant.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _pushError(message: string): void {
		if (this._errors.length >= shaderVariantCollectionLimits.maximumErrors) {
			this._errors.shift();
		}
		this._errors.push(message.slice(0, 2_048));
	}
}

const runtimes = new WeakMap<Scene, ShaderVariantCollectionRuntime>();

/** Installs one shared tracing/prewarming runtime and runs configured startup prewarming. */
export async function configureShaderVariantCollection(scene: Scene): Promise<IShaderVariantCollectionRuntimeStatus> {
	const hasAuthoredConfiguration = scene.metadata?.[shaderVariantCollectionMetadataKey] !== undefined;
	const configuration = getShaderVariantCollectionConfiguration(scene);
	if (hasAuthoredConfiguration) {
		scene.metadata[shaderVariantCollectionMetadataKey] = configuration;
	}
	runtimes.get(scene)?.dispose();
	const runtime = new ShaderVariantCollectionRuntime(scene, configuration);
	runtimes.set(scene, runtime);
	if (configuration.enabled && configuration.automaticTracing) {
		runtime.startTracing();
	}
	if (configuration.enabled && configuration.automaticPrewarming) {
		await runtime.prewarm();
	}
	return runtime.getStatus();
}

/** Captures the current rendered frame through the installed runtime. */
export function traceShaderVariantFrame(scene: Scene): IShaderVariantCollectionRuntimeStatus {
	const runtime = runtimes.get(scene);
	if (!runtime) {
		throw new Error("Shader Variant Collection runtime is not configured for this scene.");
	}
	runtime.traceFrame();
	return runtime.getStatus();
}

/** Prewarms the current bounded collection through Babylon's material compilation API. */
export async function prewarmShaderVariantCollection(scene: Scene): Promise<IShaderVariantCollectionRuntimeStatus> {
	const runtime = runtimes.get(scene);
	if (!runtime) {
		throw new Error("Shader Variant Collection runtime is not configured for this scene.");
	}
	return runtime.prewarm();
}

/** Reads actual runtime evidence without creating or changing a runtime. */
export function getShaderVariantCollectionRuntimeStatus(scene: Scene): IShaderVariantCollectionRuntimeStatus | null {
	return runtimes.get(scene)?.getStatus() ?? null;
}

/** Stops runtime observation and releases scene observers. */
export function disposeShaderVariantCollection(scene: Scene): void {
	runtimes.get(scene)?.dispose();
	runtimes.delete(scene);
}
