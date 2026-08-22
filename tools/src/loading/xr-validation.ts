import { getSceneXRConfiguration, IEditorXRConfiguration, IXRMetadataHost, XRSessionMode } from "./xr-model";

export type XRValidationSeverity = "error" | "warning" | "info";
export type XRValidationTarget = "authoring" | "web" | "electron-web";

export interface IXRValidationIssue {
	code: string;
	severity: XRValidationSeverity;
	path: string;
	message: string;
}

export interface IXRCapabilityEvidence {
	target: XRValidationTarget;
	secureContext: boolean | null;
	webXRApi: boolean | null;
	sessionMode: XRSessionMode;
	sessionSupported: boolean | null;
	portableRuntime: "webxr";
	nativeProviderBoundary: string[];
}

export interface IXRTargetValidationReport {
	configurationVersion: number;
	configurationRevision: number;
	target: XRValidationTarget;
	valid: boolean;
	errors: IXRValidationIssue[];
	warnings: IXRValidationIssue[];
	info: IXRValidationIssue[];
	capabilities: IXRCapabilityEvidence;
}

export interface IXRCapabilityProbe {
	secureContext: boolean | null;
	webXRApi: boolean;
	isSessionSupported(mode: XRSessionMode): Promise<boolean>;
}

export interface IValidateXRTargetOptions {
	target?: XRValidationTarget;
	requireEnabled?: boolean;
	checkCurrentDevice?: boolean;
	capabilityProbe?: IXRCapabilityProbe;
}

interface IXRSceneNodeReference {
	parent: IXRSceneNodeReference | null;
}

/** The validator intentionally accepts both Babylon ESM and UMD Scene builds used by this monorepo. */
export interface IXRValidationScene extends IXRMetadataHost {
	getCameraById(id: string): IXRSceneNodeReference | null;
	getTransformNodeById(id: string): IXRSceneNodeReference | null;
	getMeshById(id: string): IXRSceneNodeReference | null;
}

const arOnlyFeatures = new Set(["anchors", "depth-sensing", "hit-test", "light-estimation", "plane-detection"]);

/** Uses the ambient browser only when requested, keeping build validation deterministic in Node/Electron main-process tests. */
function ambientCapabilityProbe(): IXRCapabilityProbe {
	const globalValue = globalThis as typeof globalThis & { isSecureContext?: boolean; navigator?: Navigator };
	const xr = globalValue.navigator?.xr;
	return {
		secureContext: typeof globalValue.isSecureContext === "boolean" ? globalValue.isSecureContext : null,
		webXRApi: Boolean(xr),
		isSessionSupported: async (mode) => (xr ? xr.isSessionSupported(mode) : false),
	};
}

/** Emits one stable validation record so UI, builds, tests, and MCP share issue codes. */
function issue(issues: IXRValidationIssue[], severity: XRValidationSeverity, code: string, path: string, message: string): void {
	issues.push({ code, severity, path, message });
}

/** Validates references and cross-field intent that the metadata shape validator cannot resolve without a Scene. */
function validateSceneReferences(scene: IXRValidationScene, configuration: IEditorXRConfiguration, issues: IXRValidationIssue[]): void {
	const originNode = configuration.origin.originNodeId
		? (scene.getTransformNodeById(configuration.origin.originNodeId) ?? scene.getMeshById(configuration.origin.originNodeId))
		: null;
	if (configuration.origin.originNodeId && !originNode) {
		issue(issues, "error", "XR_ORIGIN_NODE_MISSING", "origin.originNodeId", `XR origin node was not found: ${configuration.origin.originNodeId}.`);
	}
	if (configuration.origin.cameraId && !scene.getCameraById(configuration.origin.cameraId)) {
		issue(issues, "error", "XR_CAMERA_MISSING", "origin.cameraId", `XR origin camera was not found: ${configuration.origin.cameraId}.`);
	}
	const camera = configuration.origin.cameraId ? scene.getCameraById(configuration.origin.cameraId) : null;
	if (originNode && camera) {
		let parent = camera.parent;
		while (parent && parent !== originNode) {
			parent = parent.parent;
		}
		if (parent !== originNode) {
			issue(issues, "warning", "XR_CAMERA_OUTSIDE_ORIGIN", "origin", "The configured XR camera is not parented beneath the configured XR origin node.");
		}
	}
	for (const meshId of configuration.origin.floorMeshIds) {
		if (!scene.getMeshById(meshId)) {
			issue(issues, "error", "XR_FLOOR_MESH_MISSING", "origin.floorMeshIds", `XR floor mesh was not found: ${meshId}.`);
		}
	}
	for (const meshId of configuration.simulation.environmentMeshIds) {
		if (!scene.getMeshById(meshId)) {
			issue(issues, "error", "XR_SIMULATION_ENVIRONMENT_MISSING", "simulation.environmentMeshIds", `XR simulation environment mesh was not found: ${meshId}.`);
		}
	}
	for (const interactable of configuration.interactables) {
		if (!scene.getMeshById(interactable.meshId)) {
			issue(issues, "error", "XR_INTERACTABLE_MESH_MISSING", `interactables.${interactable.id}.meshId`, `XR interactable mesh was not found: ${interactable.meshId}.`);
		}
	}
}

/** Validates portable WebXR semantics independently from current headset/browser availability. */
function validatePortableSemantics(configuration: IEditorXRConfiguration, issues: IXRValidationIssue[]): void {
	if (configuration.session.mode === "immersive-vr") {
		for (const feature of [...configuration.session.requiredFeatures, ...configuration.session.optionalFeatures].filter((entry) => arOnlyFeatures.has(entry))) {
			issue(issues, "warning", "XR_AR_FEATURE_IN_VR", "session", `Feature ${feature} is normally provided by immersive AR runtimes, not immersive VR runtimes.`);
		}
	}
	if (configuration.session.mode === "immersive-ar" && (configuration.locomotion.continuousMove || configuration.locomotion.continuousTurn)) {
		issue(issues, "warning", "XR_AR_ARTIFICIAL_LOCOMOTION", "locomotion", "Continuous movement or turning in immersive AR can conflict with physical device tracking.");
	}
	if (
		configuration.interaction.handTracking &&
		!configuration.session.requiredFeatures.includes("hand-tracking") &&
		!configuration.session.optionalFeatures.includes("hand-tracking")
	) {
		issue(
			issues,
			"warning",
			"XR_HAND_TRACKING_NOT_REQUESTED",
			"interaction.handTracking",
			"Hand interaction is enabled but hand-tracking is not requested as a session feature."
		);
	}
	if (
		configuration.locomotion.teleportation &&
		!configuration.origin.floorMeshIds.length &&
		!configuration.interactables.some((entry) => entry.enabled && entry.modes.includes("teleport"))
	) {
		issue(issues, "warning", "XR_TELEPORT_DESTINATION_EMPTY", "locomotion.teleportation", "Teleportation is enabled but no floor mesh or teleport interactable is authored.");
	}
	if (configuration.session.referenceSpaceType === "bounded-floor" && !configuration.session.requiredFeatures.includes("bounded-floor")) {
		issue(
			issues,
			"warning",
			"XR_BOUNDED_FLOOR_NOT_REQUIRED",
			"session.requiredFeatures",
			"The bounded-floor reference space should also be a required session feature for deterministic room-boundary startup."
		);
	}
}

/** Validates an authored scene for portable WebXR export and optionally probes the current browser/device. */
export async function validateXRTarget(scene: IXRValidationScene, options: IValidateXRTargetOptions = {}): Promise<IXRTargetValidationReport> {
	const target = options.target ?? "authoring";
	const configuration = getSceneXRConfiguration(scene);
	const issues: IXRValidationIssue[] = [];
	if ((options.requireEnabled ?? true) && !configuration.enabled) {
		issue(issues, "error", "XR_DISABLED", "enabled", "XR must be enabled for this target.");
	}
	validateSceneReferences(scene, configuration, issues);
	validatePortableSemantics(configuration, issues);

	let secureContext: boolean | null = null;
	let webXRApi: boolean | null = null;
	let sessionSupported: boolean | null = null;
	if (options.checkCurrentDevice) {
		const probe = options.capabilityProbe ?? ambientCapabilityProbe();
		secureContext = probe.secureContext;
		webXRApi = probe.webXRApi;
		if (secureContext === false) {
			issue(issues, "error", "XR_INSECURE_CONTEXT", "capabilities.secureContext", "WebXR requires a secure context (HTTPS or an eligible local origin).");
		}
		if (!webXRApi) {
			issue(issues, "error", "XR_API_UNAVAILABLE", "capabilities.webXRApi", "The current browser does not expose navigator.xr.");
		} else {
			try {
				sessionSupported = await probe.isSessionSupported(configuration.session.mode);
				if (!sessionSupported) {
					issue(issues, "error", "XR_SESSION_UNSUPPORTED", "capabilities.sessionSupported", `The current device does not support ${configuration.session.mode}.`);
				}
			} catch (error) {
				issue(
					issues,
					"error",
					"XR_CAPABILITY_PROBE_FAILED",
					"capabilities.sessionSupported",
					`XR session support could not be probed: ${error instanceof Error ? error.message : String(error)}.`
				);
			}
		}
	}
	issue(
		issues,
		"info",
		"XR_NATIVE_PROVIDER_BOUNDARY",
		"capabilities.nativeProviderBoundary",
		"Native OpenXR, visionOS, ARCore, and ARKit packaging require external platform/provider integrations; this runtime target is portable WebXR."
	);

	const errors = issues.filter((entry) => entry.severity === "error");
	return {
		configurationVersion: configuration.version,
		configurationRevision: configuration.revision,
		target,
		valid: errors.length === 0,
		errors,
		warnings: issues.filter((entry) => entry.severity === "warning"),
		info: issues.filter((entry) => entry.severity === "info"),
		capabilities: {
			target,
			secureContext,
			webXRApi,
			sessionMode: configuration.session.mode,
			sessionSupported,
			portableRuntime: "webxr",
			nativeProviderBoundary: ["native-openxr", "visionos", "arcore", "arkit"],
		},
	};
}
