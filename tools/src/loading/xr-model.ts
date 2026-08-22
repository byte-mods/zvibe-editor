/**
 * Canonical persisted XR authoring model shared by editor actions, exported games,
 * target validation, simulation, and MCP. Keeping migration here prevents each
 * consumer from interpreting legacy feature strings differently.
 */

/** Current persisted XR authoring format. */
export const XR_CONFIGURATION_VERSION = 2 as const;

/** Native session features that can be requested through WebXR's XRSessionInit. */
export const XR_SESSION_FEATURES = [
	"anchors",
	"bounded-floor",
	"depth-sensing",
	"dom-overlay",
	"hand-tracking",
	"hit-test",
	"layers",
	"light-estimation",
	"local",
	"local-floor",
	"plane-detection",
	"unbounded",
] as const;

export type XRSessionFeature = (typeof XR_SESSION_FEATURES)[number];
export type XRSessionMode = "immersive-vr" | "immersive-ar";
export type XRReferenceSpaceType = "local" | "local-floor" | "bounded-floor" | "unbounded";
export type XRHandednessPreference = "any" | "left" | "right";
export type XRInteractionMode = "select" | "grab" | "teleport";

export interface IXRSessionConfiguration {
	mode: XRSessionMode;
	referenceSpaceType: XRReferenceSpaceType;
	initializeOnStartup: boolean;
	showEnterExitUI: boolean;
	requiredFeatures: XRSessionFeature[];
	optionalFeatures: XRSessionFeature[];
}

export interface IXROriginConfiguration {
	originNodeId: string | null;
	cameraId: string | null;
	floorMeshIds: string[];
	worldScale: number;
}

export interface IXRInteractionConfiguration {
	pointerSelection: boolean;
	nearInteraction: boolean;
	handTracking: boolean;
	gazeMode: boolean;
	preferredHandedness: XRHandednessPreference;
	maxPointerDistance: number;
	gazeSelectionTimeMs: number;
}

export interface IXRLocomotionConfiguration {
	teleportation: boolean;
	continuousMove: boolean;
	continuousTurn: boolean;
	movementSpeed: number;
	rotationSpeed: number;
	rotationAngleDegrees: number;
	snapPointsOnly: boolean;
	snapPoints: [number, number, number][];
	snapRadius: number;
}

export interface IXRSimulatedPose {
	position: [number, number, number];
	rotation: [number, number, number];
}

export interface IXRSimulatedController extends IXRSimulatedPose {
	enabled: boolean;
}

export interface IXRSimulationConfiguration {
	enabled: boolean;
	environmentMeshIds: string[];
	headset: IXRSimulatedPose;
	leftController: IXRSimulatedController;
	rightController: IXRSimulatedController;
	maxRayDistance: number;
}

export interface IXRInteractableDefinition {
	id: string;
	name: string;
	meshId: string;
	enabled: boolean;
	modes: XRInteractionMode[];
	interactionLayers: string[];
	rotateWithController: boolean;
	dragSmoothing: number;
	hapticAmplitude: number;
	hapticDurationMs: number;
}

export interface IEditorXRConfiguration {
	version: typeof XR_CONFIGURATION_VERSION;
	revision: number;
	enabled: boolean;
	session: IXRSessionConfiguration;
	origin: IXROriginConfiguration;
	interaction: IXRInteractionConfiguration;
	locomotion: IXRLocomotionConfiguration;
	simulation: IXRSimulationConfiguration;
	interactables: IXRInteractableDefinition[];
	maxTraceEvents: number;
}

export interface IXRConfigurationMigrationResult {
	configuration: IEditorXRConfiguration;
	migrated: boolean;
	sourceVersion: number;
}

export interface IXRMetadataHost {
	metadata?: Record<string, unknown> | null;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sessionModes: readonly XRSessionMode[] = ["immersive-vr", "immersive-ar"];
const referenceSpaceTypes: readonly XRReferenceSpaceType[] = ["local", "local-floor", "bounded-floor", "unbounded"];
const handednessPreferences: readonly XRHandednessPreference[] = ["any", "left", "right"];
const interactionModes: readonly XRInteractionMode[] = ["select", "grab", "teleport"];

/** Narrows untrusted scene metadata without accepting arrays as configuration objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps callers from mutating persisted metadata through shared object references. */
function clone<T>(value: T): T {
	return structuredClone(value);
}

/** Applies defaults only to absent fields; malformed authored numbers must fail loudly. */
function finiteNumber(value: unknown, fallback: number, label: string): number {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number.`);
	}
	return value;
}

/** Distinguishes an omitted Boolean from a wrong-typed persisted value. */
function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean.`);
	}
	return value;
}

/** Reads one authored string while preserving strict version-2 type failures. */
function stringValue(value: unknown, fallback: string, label: string): string {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "string") {
		throw new Error(`${label} must be a string.`);
	}
	return value;
}

/** Restricts persisted discriminants before downstream runtime switches consume them. */
function enumValue<T extends string>(value: unknown, fallback: T, values: readonly T[], label: string): T {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${label} is unsupported.`);
	}
	return value as T;
}

/** Copies string arrays so normalization never aliases user-provided metadata. */
function stringArray(value: unknown, fallback: string[], label: string): string[] {
	if (value === undefined) {
		return clone(fallback);
	}
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be an array of strings.`);
	}
	return value.slice();
}

/** Enforces fixed three-component positions/rotations at the metadata boundary. */
function tuple3(value: unknown, fallback: [number, number, number], label: string): [number, number, number] {
	if (value === undefined) {
		return [...fallback];
	}
	if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
		throw new Error(`${label} must contain exactly three finite numbers.`);
	}
	return [value[0], value[1], value[2]];
}

/** Treats an absent nested block as defaults while rejecting malformed present blocks. */
function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value;
}

/** Creates independent simulator poses so controller/head defaults cannot alias. */
function defaultPose(position: [number, number, number]): IXRSimulatedPose {
	return { position, rotation: [0, 0, 0] };
}

/** Returns a complete authored configuration whose defaults are safe for seated/room-scale VR. */
export function createDefaultXRConfiguration(): IEditorXRConfiguration {
	return {
		version: XR_CONFIGURATION_VERSION,
		revision: 1,
		enabled: false,
		session: {
			mode: "immersive-vr",
			referenceSpaceType: "local-floor",
			initializeOnStartup: true,
			showEnterExitUI: true,
			requiredFeatures: [],
			optionalFeatures: [],
		},
		// Editor scenes use centimetres, while WebXR poses are expressed in metres.
		origin: { originNodeId: null, cameraId: null, floorMeshIds: [], worldScale: 100 },
		interaction: {
			pointerSelection: true,
			nearInteraction: true,
			handTracking: true,
			gazeMode: false,
			preferredHandedness: "any",
			maxPointerDistance: 100,
			gazeSelectionTimeMs: 3000,
		},
		locomotion: {
			teleportation: true,
			continuousMove: false,
			continuousTurn: false,
			movementSpeed: 1,
			rotationSpeed: 1,
			rotationAngleDegrees: 22.5,
			snapPointsOnly: false,
			snapPoints: [],
			snapRadius: 0.8,
		},
		simulation: {
			enabled: false,
			environmentMeshIds: [],
			headset: defaultPose([0, 1.7, 0]),
			leftController: { ...defaultPose([-0.25, 1.35, 0.35]), enabled: true },
			rightController: { ...defaultPose([0.25, 1.35, 0.35]), enabled: true },
			maxRayDistance: 100,
		},
		interactables: [],
		maxTraceEvents: 256,
	};
}

/** Normalizes session startup and native XRSessionInit feature intent as one block. */
function normalizeSession(value: unknown, fallback: IXRSessionConfiguration): IXRSessionConfiguration {
	const source = objectValue(value, "XR session");
	return {
		mode: enumValue(source.mode, fallback.mode, sessionModes, "XR session mode"),
		referenceSpaceType: enumValue(source.referenceSpaceType, fallback.referenceSpaceType, referenceSpaceTypes, "XR reference space"),
		initializeOnStartup: booleanValue(source.initializeOnStartup, fallback.initializeOnStartup, "XR initializeOnStartup"),
		showEnterExitUI: booleanValue(source.showEnterExitUI, fallback.showEnterExitUI, "XR showEnterExitUI"),
		requiredFeatures: stringArray(source.requiredFeatures, fallback.requiredFeatures, "XR requiredFeatures") as XRSessionFeature[],
		optionalFeatures: stringArray(source.optionalFeatures, fallback.optionalFeatures, "XR optionalFeatures") as XRSessionFeature[],
	};
}

/** Normalizes tracking-origin ownership independently from interaction settings. */
function normalizeOrigin(value: unknown, fallback: IXROriginConfiguration): IXROriginConfiguration {
	const source = objectValue(value, "XR origin");
	const originNodeId = source.originNodeId === undefined ? fallback.originNodeId : source.originNodeId;
	const cameraId = source.cameraId === undefined ? fallback.cameraId : source.cameraId;
	if (originNodeId !== null && typeof originNodeId !== "string") {
		throw new Error("XR origin originNodeId must be a string or null.");
	}
	if (cameraId !== null && typeof cameraId !== "string") {
		throw new Error("XR origin cameraId must be a string or null.");
	}
	return {
		originNodeId,
		cameraId,
		floorMeshIds: stringArray(source.floorMeshIds, fallback.floorMeshIds, "XR floorMeshIds"),
		worldScale: finiteNumber(source.worldScale, fallback.worldScale, "XR worldScale"),
	};
}

/** Normalizes portable pointer, near, hand, and gaze authoring controls. */
function normalizeInteraction(value: unknown, fallback: IXRInteractionConfiguration): IXRInteractionConfiguration {
	const source = objectValue(value, "XR interaction");
	return {
		pointerSelection: booleanValue(source.pointerSelection, fallback.pointerSelection, "XR pointerSelection"),
		nearInteraction: booleanValue(source.nearInteraction, fallback.nearInteraction, "XR nearInteraction"),
		handTracking: booleanValue(source.handTracking, fallback.handTracking, "XR handTracking"),
		gazeMode: booleanValue(source.gazeMode, fallback.gazeMode, "XR gazeMode"),
		preferredHandedness: enumValue(source.preferredHandedness, fallback.preferredHandedness, handednessPreferences, "XR preferredHandedness"),
		maxPointerDistance: finiteNumber(source.maxPointerDistance, fallback.maxPointerDistance, "XR maxPointerDistance"),
		gazeSelectionTimeMs: finiteNumber(source.gazeSelectionTimeMs, fallback.gazeSelectionTimeMs, "XR gazeSelectionTimeMs"),
	};
}

/** Normalizes teleport and controller-movement values before Babylon receives them. */
function normalizeLocomotion(value: unknown, fallback: IXRLocomotionConfiguration): IXRLocomotionConfiguration {
	const source = objectValue(value, "XR locomotion");
	const snapPointSource = source.snapPoints === undefined ? fallback.snapPoints : source.snapPoints;
	if (!Array.isArray(snapPointSource)) {
		throw new Error("XR snapPoints must be an array.");
	}
	return {
		teleportation: booleanValue(source.teleportation, fallback.teleportation, "XR teleportation"),
		continuousMove: booleanValue(source.continuousMove, fallback.continuousMove, "XR continuousMove"),
		continuousTurn: booleanValue(source.continuousTurn, fallback.continuousTurn, "XR continuousTurn"),
		movementSpeed: finiteNumber(source.movementSpeed, fallback.movementSpeed, "XR movementSpeed"),
		rotationSpeed: finiteNumber(source.rotationSpeed, fallback.rotationSpeed, "XR rotationSpeed"),
		rotationAngleDegrees: finiteNumber(source.rotationAngleDegrees, fallback.rotationAngleDegrees, "XR rotationAngleDegrees"),
		snapPointsOnly: booleanValue(source.snapPointsOnly, fallback.snapPointsOnly, "XR snapPointsOnly"),
		snapPoints: snapPointSource.map((point, index) => tuple3(point, [0, 0, 0], `XR snapPoints[${index}]`)),
		snapRadius: finiteNumber(source.snapRadius, fallback.snapRadius, "XR snapRadius"),
	};
}

/** Normalizes one simulator pose without admitting partial or non-finite tuples. */
function normalizePose(value: unknown, fallback: IXRSimulatedPose, label: string): IXRSimulatedPose {
	const source = objectValue(value, label);
	return {
		position: tuple3(source.position, fallback.position, `${label} position`),
		rotation: tuple3(source.rotation, fallback.rotation, `${label} rotation`),
	};
}

/** Extends pose normalization with explicit simulated-device availability. */
function normalizeController(value: unknown, fallback: IXRSimulatedController, label: string): IXRSimulatedController {
	const source = objectValue(value, label);
	return {
		...normalizePose(source, fallback, label),
		enabled: booleanValue(source.enabled, fallback.enabled, `${label} enabled`),
	};
}

/** Normalizes persistent simulator defaults; button state remains transient runtime data. */
function normalizeSimulation(value: unknown, fallback: IXRSimulationConfiguration): IXRSimulationConfiguration {
	const source = objectValue(value, "XR simulation");
	return {
		enabled: booleanValue(source.enabled, fallback.enabled, "XR simulation enabled"),
		environmentMeshIds: stringArray(source.environmentMeshIds, fallback.environmentMeshIds, "XR simulation environmentMeshIds"),
		headset: normalizePose(source.headset, fallback.headset, "XR simulated headset"),
		leftController: normalizeController(source.leftController, fallback.leftController, "XR simulated left controller"),
		rightController: normalizeController(source.rightController, fallback.rightController, "XR simulated right controller"),
		maxRayDistance: finiteNumber(source.maxRayDistance, fallback.maxRayDistance, "XR simulation maxRayDistance"),
	};
}

/** Converts one untrusted interactable record before cross-record validation runs. */
function normalizeInteractable(value: unknown, index: number): IXRInteractableDefinition {
	const source = objectValue(value, `XR interactables[${index}]`);
	return {
		id: stringValue(source.id, "", `XR interactables[${index}].id`),
		name: stringValue(source.name, "", `XR interactables[${index}].name`),
		meshId: stringValue(source.meshId, "", `XR interactables[${index}].meshId`),
		enabled: booleanValue(source.enabled, true, `XR interactables[${index}].enabled`),
		modes: stringArray(source.modes, ["select"], `XR interactables[${index}].modes`) as XRInteractionMode[],
		interactionLayers: stringArray(source.interactionLayers, ["default"], `XR interactables[${index}].interactionLayers`),
		rotateWithController: booleanValue(source.rotateWithController, true, `XR interactables[${index}].rotateWithController`),
		dragSmoothing: finiteNumber(source.dragSmoothing, 0.2, `XR interactables[${index}].dragSmoothing`),
		hapticAmplitude: finiteNumber(source.hapticAmplitude, 0, `XR interactables[${index}].hapticAmplitude`),
		hapticDurationMs: finiteNumber(source.hapticDurationMs, 0, `XR interactables[${index}].hapticDurationMs`),
	};
}

/** Separates legacy editor teleportation from native WebXR session features during migration. */
function migrateLegacy(source: Record<string, unknown>, fallback: IEditorXRConfiguration): IEditorXRConfiguration {
	const legacyFeatures = stringArray(source.features, [], "Legacy XR features");
	const nativeFeatures = legacyFeatures.filter((feature): feature is XRSessionFeature => (XR_SESSION_FEATURES as readonly string[]).includes(feature));
	const referenceSpaceType = enumValue(source.referenceSpaceType, fallback.session.referenceSpaceType, referenceSpaceTypes, "Legacy XR reference space");
	return {
		...fallback,
		enabled: booleanValue(source.enabled, fallback.enabled, "Legacy XR enabled"),
		session: { ...fallback.session, referenceSpaceType, optionalFeatures: nativeFeatures },
		origin: { ...fallback.origin, floorMeshIds: stringArray(source.floorMeshIds, [], "Legacy XR floorMeshIds") },
		interaction: { ...fallback.interaction, handTracking: nativeFeatures.includes("hand-tracking") },
		locomotion: { ...fallback.locomotion, teleportation: legacyFeatures.includes("teleportation") },
	};
}

/** Deterministically migrates legacy metadata and rejects malformed version-2 values. */
export function normalizeXRConfiguration(value: unknown): IXRConfigurationMigrationResult {
	const fallback = createDefaultXRConfiguration();
	if (value === undefined || value === null) {
		return { configuration: fallback, migrated: false, sourceVersion: XR_CONFIGURATION_VERSION };
	}
	if (!isRecord(value)) {
		throw new Error("XR configuration must be an object.");
	}

	if (value.version !== undefined && (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1)) {
		throw new Error("XR version must be a positive integer when provided.");
	}
	const sourceVersion = typeof value.version === "number" ? value.version : 1;
	if (sourceVersion > XR_CONFIGURATION_VERSION) {
		throw new Error(`XR configuration version ${sourceVersion} is newer than supported version ${XR_CONFIGURATION_VERSION}.`);
	}
	if (sourceVersion !== XR_CONFIGURATION_VERSION) {
		const configuration = migrateLegacy(value, fallback);
		validateXRConfiguration(configuration);
		return { configuration, migrated: true, sourceVersion };
	}

	const interactableSource = value.interactables === undefined ? fallback.interactables : value.interactables;
	if (!Array.isArray(interactableSource)) {
		throw new Error("XR interactables must be an array.");
	}
	const revision = value.revision === undefined ? fallback.revision : value.revision;
	if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
		throw new Error("XR revision must be a positive safe integer.");
	}
	const configuration: IEditorXRConfiguration = {
		version: XR_CONFIGURATION_VERSION,
		revision: revision as number,
		enabled: booleanValue(value.enabled, fallback.enabled, "XR enabled"),
		session: normalizeSession(value.session, fallback.session),
		origin: normalizeOrigin(value.origin, fallback.origin),
		interaction: normalizeInteraction(value.interaction, fallback.interaction),
		locomotion: normalizeLocomotion(value.locomotion, fallback.locomotion),
		simulation: normalizeSimulation(value.simulation, fallback.simulation),
		interactables: interactableSource.map(normalizeInteractable),
		maxTraceEvents: finiteNumber(value.maxTraceEvents, fallback.maxTraceEvents, "XR maxTraceEvents"),
	};
	validateXRConfiguration(configuration);
	return { configuration, migrated: false, sourceVersion };
}

/** Applies one consistent size, identity, and duplicate policy to all authored id lists. */
function assertUniqueBoundedStrings(values: string[], label: string, limit: number, pattern: RegExp = identifierPattern): void {
	if (values.length > limit) {
		throw new Error(`${label} supports at most ${limit} entries.`);
	}
	if (new Set(values).size !== values.length) {
		throw new Error(`${label} entries must be unique.`);
	}
	for (const value of values) {
		if (!pattern.test(value)) {
			throw new Error(`${label} contains an invalid value: ${value || "<empty>"}.`);
		}
	}
}

/** Bounds values before they can cause extreme render, haptic, or simulation behavior. */
function assertRange(value: number, min: number, max: number, label: string): void {
	if (!Number.isFinite(value) || value < min || value > max) {
		throw new Error(`${label} must be between ${min} and ${max}.`);
	}
}

/** Validates simulator coordinates separately from authored scene-unit conversion. */
function validatePose(value: IXRSimulatedPose, label: string): void {
	value.position.forEach((entry, index) => assertRange(entry, -100_000, 100_000, `${label} position[${index}]`));
	value.rotation.forEach((entry, index) => assertRange(entry, -3600, 3600, `${label} rotation[${index}]`));
}

/** Validates all persisted bounds and cross-field rules before authoring or runtime use. */
export function validateXRConfiguration(configuration: IEditorXRConfiguration): void {
	if (configuration.version !== XR_CONFIGURATION_VERSION) {
		throw new Error(`Unsupported XR configuration version: ${configuration.version}.`);
	}
	if (!Number.isSafeInteger(configuration.revision) || configuration.revision < 1) {
		throw new Error("XR revision must be a positive safe integer.");
	}
	assertUniqueBoundedStrings(configuration.session.requiredFeatures, "XR requiredFeatures", XR_SESSION_FEATURES.length);
	assertUniqueBoundedStrings(configuration.session.optionalFeatures, "XR optionalFeatures", XR_SESSION_FEATURES.length);
	for (const feature of [...configuration.session.requiredFeatures, ...configuration.session.optionalFeatures]) {
		if (!(XR_SESSION_FEATURES as readonly string[]).includes(feature)) {
			throw new Error(`Unsupported WebXR session feature: ${feature}.`);
		}
	}
	const overlap = configuration.session.requiredFeatures.find((feature) => configuration.session.optionalFeatures.includes(feature));
	if (overlap) {
		throw new Error(`WebXR feature ${overlap} cannot be both required and optional.`);
	}
	assertUniqueBoundedStrings(configuration.origin.floorMeshIds, "XR floorMeshIds", 128);
	if (configuration.origin.originNodeId !== null && !identifierPattern.test(configuration.origin.originNodeId)) {
		throw new Error("XR originNodeId is invalid.");
	}
	if (configuration.origin.cameraId !== null && !identifierPattern.test(configuration.origin.cameraId)) {
		throw new Error("XR cameraId is invalid.");
	}
	assertRange(configuration.origin.worldScale, 0.001, 1000, "XR worldScale");
	assertRange(configuration.interaction.maxPointerDistance, 0.01, 10_000, "XR maxPointerDistance");
	assertRange(configuration.interaction.gazeSelectionTimeMs, 100, 60_000, "XR gazeSelectionTimeMs");
	assertRange(configuration.locomotion.movementSpeed, 0.01, 100, "XR movementSpeed");
	assertRange(configuration.locomotion.rotationSpeed, 0.01, 20, "XR rotationSpeed");
	assertRange(configuration.locomotion.rotationAngleDegrees, 1, 180, "XR rotationAngleDegrees");
	assertRange(configuration.locomotion.snapRadius, 0.01, 100, "XR snapRadius");
	if (configuration.locomotion.snapPoints.length > 256) {
		throw new Error("XR locomotion supports at most 256 snap points.");
	}
	configuration.locomotion.snapPoints.forEach((point, index) => validatePose({ position: point, rotation: [0, 0, 0] }, `XR snap point ${index}`));
	assertUniqueBoundedStrings(configuration.simulation.environmentMeshIds, "XR simulation environmentMeshIds", 128);
	validatePose(configuration.simulation.headset, "XR simulated headset");
	validatePose(configuration.simulation.leftController, "XR simulated left controller");
	validatePose(configuration.simulation.rightController, "XR simulated right controller");
	assertRange(configuration.simulation.maxRayDistance, 0.01, 10_000, "XR simulation maxRayDistance");
	if (configuration.interactables.length > 512) {
		throw new Error("XR supports at most 512 interactables.");
	}
	const ids = new Set<string>();
	const meshIds = new Set<string>();
	for (const interactable of configuration.interactables) {
		if (!identifierPattern.test(interactable.id)) {
			throw new Error(`XR interactable id is invalid: ${interactable.id || "<empty>"}.`);
		}
		if (ids.has(interactable.id)) {
			throw new Error(`XR interactable id is duplicated: ${interactable.id}.`);
		}
		ids.add(interactable.id);
		if (!interactable.name.trim() || interactable.name.length > 128) {
			throw new Error(`XR interactable ${interactable.id} name must contain 1-128 characters.`);
		}
		if (!identifierPattern.test(interactable.meshId)) {
			throw new Error(`XR interactable ${interactable.id} meshId is invalid.`);
		}
		if (meshIds.has(interactable.meshId)) {
			throw new Error(`Mesh ${interactable.meshId} has more than one XR interactable.`);
		}
		meshIds.add(interactable.meshId);
		assertUniqueBoundedStrings(interactable.modes, `XR interactable ${interactable.id} modes`, interactionModes.length);
		if (interactable.modes.some((mode) => !interactionModes.includes(mode))) {
			throw new Error(`XR interactable ${interactable.id} contains an unsupported mode.`);
		}
		if (!interactable.modes.length) {
			throw new Error(`XR interactable ${interactable.id} must enable at least one interaction mode.`);
		}
		assertUniqueBoundedStrings(interactable.interactionLayers, `XR interactable ${interactable.id} interactionLayers`, 16);
		assertRange(interactable.dragSmoothing, 0, 1, `XR interactable ${interactable.id} dragSmoothing`);
		assertRange(interactable.hapticAmplitude, 0, 1, `XR interactable ${interactable.id} hapticAmplitude`);
		assertRange(interactable.hapticDurationMs, 0, 5000, `XR interactable ${interactable.id} hapticDurationMs`);
	}
	if (!Number.isInteger(configuration.maxTraceEvents)) {
		throw new Error("XR maxTraceEvents must be an integer.");
	}
	assertRange(configuration.maxTraceEvents, 16, 4096, "XR maxTraceEvents");
}

/** Reads, migrates, validates, and optionally persists the canonical scene configuration. */
export function getSceneXRConfiguration(scene: IXRMetadataHost, persist = true): IEditorXRConfiguration {
	const metadata = isRecord(scene.metadata) ? scene.metadata : {};
	const result = normalizeXRConfiguration(metadata.babylonEditorXR);
	if (persist) {
		scene.metadata = metadata;
		metadata.babylonEditorXR = clone(result.configuration);
	}
	return clone(result.configuration);
}

/** Replaces scene XR metadata only after the complete candidate validates. */
export function setSceneXRConfiguration(scene: IXRMetadataHost, configuration: IEditorXRConfiguration): IEditorXRConfiguration {
	validateXRConfiguration(configuration);
	const metadata = isRecord(scene.metadata) ? scene.metadata : {};
	scene.metadata = metadata;
	metadata.babylonEditorXR = clone(configuration);
	return clone(configuration);
}
