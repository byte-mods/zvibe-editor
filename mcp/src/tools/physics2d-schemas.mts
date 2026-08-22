import { z } from "zod";

const MaxCoordinate = 1_000_000;
const MaxForce = 1_000_000_000_000;
const MaxVelocity = 100_000;

const finite = z.number().finite();
const coordinate = finite.min(-MaxCoordinate).max(MaxCoordinate);
const positiveCoordinate = finite.min(0.001).max(MaxCoordinate);
const unit = finite.min(0).max(1);
const unsignedMask = finite.int().min(0).max(0xffffffff);
const identity = z.string().trim().min(1).max(256);
export const physics2DRevision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const physics2DCreateOrUpdateRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const physics2DVector = z.array(coordinate).length(2);

const colliderCommon = {
	offset: physics2DVector.optional().describe("Collider-local [x, y] offset in centimeters."),
	density: finite.min(0.000000001).max(1000).optional(),
	worldDrawing: z.boolean().optional(),
};
const polygonPoint = physics2DVector;
const polygonRing = z.object({ id: identity, points: z.array(polygonPoint).min(3).max(128) }).strict();
export const physics2DPolygonContour = z.object({ id: identity, points: z.array(polygonPoint).min(3).max(128), holes: z.array(polygonRing).max(16) }).strict();

export const physics2DCollider = z.discriminatedUnion("shape", [
	z.object({ shape: z.literal("box"), size: z.array(positiveCoordinate).length(2), ...colliderCommon }).strict(),
	z.object({ shape: z.literal("circle"), radius: positiveCoordinate, ...colliderCommon }).strict(),
	z
		.object({
			shape: z.literal("capsule"),
			size: z.array(positiveCoordinate).length(2),
			direction: z.enum(["horizontal", "vertical"]).optional(),
			...colliderCommon,
		})
		.strict(),
	z
		.object({
			shape: z.literal("polygon"),
			points: z.array(polygonPoint).min(3).max(512).describe("Simple consistently wound local outline. Use the compound-polygon tool for holes or islands."),
			edgeRadius: finite.min(0).max(MaxCoordinate).optional(),
			...colliderCommon,
		})
		.strict(),
	z
		.object({
			shape: z.literal("edge"),
			points: z.array(polygonPoint).min(2).max(512).describe("Ordered local polyline points; the editor derives bounded convex segment parts."),
			edgeRadius: positiveCoordinate,
			...colliderCommon,
		})
		.strict(),
]);

const layerOverrides = z
	.object({
		priority: z.number().int().min(-128).max(127).optional(),
		includeLayers: unsignedMask.optional(),
		excludeLayers: unsignedMask.optional(),
		forceSendLayers: unsignedMask.optional(),
		forceReceiveLayers: unsignedMask.optional(),
		callbackLayers: unsignedMask.optional(),
		contactCaptureLayers: unsignedMask.optional(),
	})
	.strict();

export const setPhysics2DBodySchema = z
	.object({
		nodeId: identity,
		worldId: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
			.optional(),
		worldDrawing: z.boolean().optional(),
		expectedRevision: physics2DCreateOrUpdateRevision.describe("Pass 0 to prove the body is absent, or the exact current revision to update it."),
		enabled: z.boolean().optional(),
		bodyType: z.enum(["dynamic", "kinematic", "static"]).optional(),
		collider: physics2DCollider.optional(),
		velocity: physics2DVector.optional(),
		angularVelocity: finite.min(-MaxVelocity).max(MaxVelocity).optional(),
		mass: finite.min(0.001).max(1_000_000_000).optional(),
		useAutoMass: z.boolean().optional(),
		inertia: finite.min(0.001).max(MaxForce).optional(),
		useAutoInertia: z.boolean().optional(),
		centerOfMass: physics2DVector.optional(),
		useAutoCenterOfMass: z.boolean().optional(),
		gravity: physics2DVector.optional(),
		gravityScale: finite.min(-100).max(100).optional(),
		linearDamping: finite.min(0).max(0.999).optional(),
		angularDamping: finite.min(0).max(0.999).optional(),
		freezePositionX: z.boolean().optional(),
		freezePositionY: z.boolean().optional(),
		freezeRotation: z.boolean().optional(),
		collisionDetection: z.enum(["discrete", "continuous"]).optional(),
		isTrigger: z.boolean().optional(),
		usedByEffector: z.boolean().optional(),
		collisionLayer: z.number().int().min(0).max(31).optional(),
		layerOverrides: layerOverrides.optional(),
		materialId: identity.nullable().optional(),
		friction: unit.nullable().optional(),
		restitution: unit.nullable().optional(),
	})
	.strict();

export const setPhysics2DSettingsSchema = z
	.object({
		expectedRevision: physics2DRevision,
		velocityIterations: z.number().int().min(1).max(16).optional(),
		positionIterations: z.number().int().min(1).max(16).optional(),
		solverIterations: z.number().int().min(1).max(16).optional().describe("Deprecated compatibility alias that sets both split controls."),
		maximumWorlds: z.number().int().min(1).max(8).optional(),
		globalTransformReadMode: z.enum(["authoring", "runtime"]).optional(),
		renderingAvailableInRelease: z.boolean().optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (
			value.velocityIterations === undefined &&
			value.positionIterations === undefined &&
			value.solverIterations === undefined &&
			value.maximumWorlds === undefined &&
			value.globalTransformReadMode === undefined &&
			value.renderingAvailableInRelease === undefined
		) {
			context.addIssue({ code: "custom", message: "Provide at least one Physics 2D settings field." });
		}
	});

const physics2DWorldId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const physics2DPlane = z
	.object({
		mode: z.enum(["xy", "xz", "yz", "custom"]),
		origin: z.array(coordinate).length(3),
		xAxis: z.array(finite.min(-1).max(1)).length(3),
		yAxis: z.array(finite.min(-1).max(1)).length(3),
	})
	.strict()
	.superRefine((value, context) => {
		const xLength = Math.hypot(...value.xAxis);
		const yLength = Math.hypot(...value.yAxis);
		const dot = value.xAxis[0] * value.yAxis[0] + value.xAxis[1] * value.yAxis[1] + value.xAxis[2] * value.yAxis[2];
		if (Math.abs(xLength - 1) > 0.001 || Math.abs(yLength - 1) > 0.001 || Math.abs(dot) > 0.001) {
			context.addIssue({ code: "custom", message: "Physics 2D transform-plane axes must be normalized and orthogonal." });
		}
	});
const physics2DWorldFields = {
	name: z.string().trim().min(1).max(128).optional(),
	enabled: z.boolean().optional(),
	worldDrawing: z.boolean().optional(),
	alwaysDraw: z.boolean().optional(),
	velocityIterations: z.number().int().min(1).max(16).optional(),
	positionIterations: z.number().int().min(1).max(16).optional(),
	transformPlane: physics2DPlane.optional(),
	transformWriteMode: z.enum(["direct", "interpolate", "tween"]).optional(),
	tweenDurationSeconds: finite.min(0).max(10).optional(),
	syncInterpolation: z.boolean().optional(),
	contactFilterMode: z.enum(["layers", "all", "none"]).optional(),
	debugCameraIds: z.array(identity).max(16).optional(),
};
export const createPhysics2DWorldSchema = z.object({ id: physics2DWorldId, expectedRevision: physics2DRevision, ...physics2DWorldFields }).strict();
export const setPhysics2DWorldSchema = z
	.object({ id: physics2DWorldId, expectedRevision: physics2DRevision, ...physics2DWorldFields })
	.strict()
	.superRefine((value, context) => {
		if (Object.keys(value).every((key) => key === "id" || key === "expectedRevision")) {
			context.addIssue({ code: "custom", message: "Provide at least one Physics 2D world field." });
		}
	});
export const deletePhysics2DWorldSchema = z.object({ id: physics2DWorldId, expectedRevision: physics2DRevision }).strict();
export const getPhysics2DDebugRenderingSchema = z
	.object({
		cameraIds: z.array(identity).max(16).optional(),
		releaseBuild: z.boolean().optional(),
		cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
		limit: z.number().int().min(1).max(256).optional(),
		customElements: z
			.array(z.object({ id: z.string().trim().min(1).max(128), worldId: physics2DWorldId, points: z.array(physics2DVector).min(2).max(128) }).strict())
			.max(256)
			.optional(),
	})
	.strict();

export const createPhysics2DMaterialSchema = z
	.object({ id: identity.optional(), name: z.string().trim().min(1).max(256), friction: unit.optional(), restitution: unit.optional() })
	.strict();
export const setPhysics2DMaterialSchema = z
	.object({ id: identity, expectedRevision: physics2DRevision, name: z.string().trim().min(1).max(256).optional(), friction: unit.optional(), restitution: unit.optional() })
	.strict()
	.superRefine((value, context) => {
		if (value.name === undefined && value.friction === undefined && value.restitution === undefined) {
			context.addIssue({ code: "custom", message: "Provide a material field to update." });
		}
	});
export const deletePhysics2DResourceSchema = z.object({ id: identity, expectedRevision: physics2DRevision }).strict();

const jointCommonCreate = {
	id: identity.optional(),
	firstNodeId: identity,
	secondNodeId: identity.optional().describe("Omit to connect to the fixed world; Target joints always omit it."),
	enabled: z.boolean().optional(),
	enableCollision: z.boolean().optional(),
	worldDrawing: z.boolean().optional(),
	breakAction: z.enum(["ignore", "callback-only", "disable", "destroy"]).optional(),
	breakForce: finite.min(0).max(MaxForce).optional(),
	breakTorque: finite.min(0).max(MaxForce).optional(),
};
const jointCommonUpdate = {
	id: identity,
	expectedRevision: physics2DRevision,
	firstNodeId: identity.optional(),
	secondNodeId: identity.nullable().optional(),
	enabled: z.boolean().optional(),
	enableCollision: z.boolean().optional(),
	worldDrawing: z.boolean().optional(),
	breakAction: z.enum(["ignore", "callback-only", "disable", "destroy"]).optional(),
	breakForce: finite.min(0).max(MaxForce).nullable().optional(),
	breakTorque: finite.min(0).max(MaxForce).nullable().optional(),
};
const jointFamilyFields: Record<string, string[]> = {
	distance: ["distance", "maxDistanceOnly"],
	fixed: ["referenceAngle", "frequency", "dampingRatio"],
	friction: ["maxForce", "maxTorque"],
	hinge: ["referenceAngle", "useLimits", "minAngle", "maxAngle", "useMotor", "motorSpeed", "maxMotorTorque"],
	relative: ["linearOffset", "angularOffset", "maxForce", "maxTorque", "correctionScale"],
	slider: ["angle", "referenceAngle", "useLimits", "lowerTranslation", "upperTranslation", "useMotor", "motorSpeed", "maxMotorForce"],
	spring: ["distance", "frequency", "dampingRatio"],
	target: ["target", "maxForce", "frequency", "dampingRatio"],
	wheel: ["angle", "frequency", "dampingRatio", "useMotor", "motorSpeed", "maxMotorTorque"],
};
const anchoredJointFields = ["anchor", "firstAnchor", "secondAnchor", "autoConfigureConnectedAnchor"];
const jointSpecificFields = {
	anchor: physics2DVector.optional().describe("Create-only world-space anchor convenience value."),
	firstAnchor: physics2DVector.optional(),
	secondAnchor: physics2DVector.optional(),
	autoConfigureConnectedAnchor: z.boolean().optional(),
	distance: finite
		.min(0)
		.max(MaxCoordinate * 2)
		.optional(),
	maxDistanceOnly: z.boolean().optional(),
	referenceAngle: finite.min(-MaxVelocity).max(MaxVelocity).optional(),
	frequency: finite.min(0).max(10_000).optional(),
	dampingRatio: unit.optional(),
	maxForce: finite.min(0).max(MaxForce).optional(),
	maxTorque: finite.min(0).max(MaxForce).optional(),
	useLimits: z.boolean().optional(),
	minAngle: finite.min(-MaxVelocity).max(MaxVelocity).optional(),
	maxAngle: finite.min(-MaxVelocity).max(MaxVelocity).optional(),
	useMotor: z.boolean().optional(),
	motorSpeed: finite.min(-MaxVelocity).max(MaxVelocity).optional(),
	maxMotorTorque: finite.min(0).max(MaxForce).optional(),
	linearOffset: physics2DVector.optional(),
	angularOffset: finite.min(-MaxVelocity).max(MaxVelocity).optional(),
	correctionScale: unit.optional(),
	angle: finite.min(-MaxVelocity).max(MaxVelocity).optional(),
	lowerTranslation: finite
		.min(-MaxCoordinate * 2)
		.max(MaxCoordinate * 2)
		.optional(),
	upperTranslation: finite
		.min(-MaxCoordinate * 2)
		.max(MaxCoordinate * 2)
		.optional(),
	maxMotorForce: finite.min(0).max(MaxForce).optional(),
	target: physics2DVector.optional(),
};

function validateJointFields(value: Record<string, unknown>, common: string[], context: z.RefinementCtx): void {
	const type = value.type as string;
	const allowed = new Set([...common, ...jointFamilyFields[type], ...(!["relative", "target"].includes(type) ? anchoredJointFields : [])]);
	const invalid = Object.keys(value).find((key) => !allowed.has(key));
	if (invalid) {
		context.addIssue({ code: "custom", path: [invalid], message: `${invalid} is not valid for a ${type} Joint 2D.` });
	}
	if (type === "target" && value.secondNodeId !== undefined) {
		context.addIssue({ code: "custom", path: ["secondNodeId"], message: "Target Joint 2D always connects to the fixed world." });
	}
	if (value.minAngle !== undefined && value.maxAngle !== undefined && (value.minAngle as number) > (value.maxAngle as number)) {
		context.addIssue({ code: "custom", path: ["maxAngle"], message: "maxAngle must be at least minAngle." });
	}
	if (value.lowerTranslation !== undefined && value.upperTranslation !== undefined && (value.lowerTranslation as number) > (value.upperTranslation as number)) {
		context.addIssue({ code: "custom", path: ["upperTranslation"], message: "upperTranslation must be at least lowerTranslation." });
	}
}

const jointTypes = z.enum(["distance", "fixed", "friction", "hinge", "relative", "slider", "spring", "target", "wheel"]);
export const createPhysics2DJointSchema = z
	.object({ type: jointTypes, ...jointCommonCreate, ...jointSpecificFields })
	.strict()
	.superRefine((value, context) => validateJointFields(value, ["type", ...Object.keys(jointCommonCreate)], context));
export const setPhysics2DJointSchema = z
	.object({ type: jointTypes, ...jointCommonUpdate, ...jointSpecificFields, anchor: z.never().optional() })
	.strict()
	.superRefine((value, context) => {
		validateJointFields(value, ["type", ...Object.keys(jointCommonUpdate)], context);
		if (Object.keys(value).every((key) => ["id", "expectedRevision", "type"].includes(key))) {
			context.addIssue({ code: "custom", message: "Provide a joint field to update." });
		}
	});

const effectorCommonCreate = {
	id: identity.optional(),
	nodeId: identity,
	enabled: z.boolean().optional(),
	useColliderMask: z.boolean().optional(),
	colliderMask: unsignedMask.optional(),
};
const effectorCommonUpdate = {
	id: identity,
	expectedRevision: physics2DRevision,
	nodeId: identity.optional(),
	enabled: z.boolean().optional(),
	useColliderMask: z.boolean().optional(),
	colliderMask: unsignedMask.optional(),
};
const effectorFields = {
	radius: positiveCoordinate.optional(),
	force: finite.min(-1_000_000_000).max(1_000_000_000).optional(),
	falloff: finite.min(0).max(1000).optional(),
	forceMagnitude: finite.min(-1_000_000_000).max(1_000_000_000).optional(),
	forceVariation: finite.min(0).max(1_000_000_000).optional(),
	linearDrag: finite.min(0).max(1_000_000).optional(),
	angularDrag: finite.min(0).max(1_000_000).optional(),
	distanceScale: finite.min(0.000001).max(1_000_000).optional(),
	forceSource: z.enum(["collider", "rigidbody"]).optional(),
	forceTarget: z.enum(["collider", "rigidbody"]).optional(),
	forceMode: z.enum(["constant", "inverse-linear", "inverse-squared"]).optional(),
	useGlobalAngle: z.boolean().optional(),
	forceAngle: finite.min(-360_000).max(360_000).optional(),
	surfaceThickness: positiveCoordinate.optional(),
	speed: finite.min(-1_000_000_000).max(1_000_000_000).optional(),
	speedVariation: finite.min(-1_000_000_000).max(1_000_000_000).optional(),
	forceScale: unit.optional(),
	useContactForce: z.boolean().optional(),
	useFriction: z.boolean().optional(),
	useBounce: z.boolean().optional(),
	platformAngle: finite.min(-360_000).max(360_000).optional(),
	rotationalOffset: finite.min(-360_000).max(360_000).optional(),
	useOneWay: z.boolean().optional(),
	useOneWayGrouping: z.boolean().optional(),
	surfaceArc: finite.min(0).max(360).optional(),
	useSideFriction: z.boolean().optional(),
	useSideBounce: z.boolean().optional(),
	sideArc: finite.min(0).max(180).optional(),
	surfaceLevel: coordinate.optional(),
	density: finite.min(0).max(1_000_000).optional(),
	flowAngle: finite.min(-360_000).max(360_000).optional(),
	flowMagnitude: finite.min(-1_000_000_000).max(1_000_000_000).optional(),
	flowVariation: finite.min(-1_000_000_000).max(1_000_000_000).optional(),
};
const effectorFamilyFields: Record<string, string[]> = {
	point: ["radius", "force", "falloff", "forceMagnitude", "forceVariation", "distanceScale", "linearDrag", "angularDrag", "forceSource", "forceTarget", "forceMode"],
	area: ["radius", "force", "falloff", "forceMagnitude", "forceVariation", "linearDrag", "angularDrag", "forceTarget", "useGlobalAngle", "forceAngle"],
	surface: ["radius", "force", "falloff", "surfaceThickness", "speed", "speedVariation", "forceScale", "useContactForce", "useFriction", "useBounce"],
	platform: ["platformAngle", "rotationalOffset", "useOneWay", "useOneWayGrouping", "surfaceArc", "useSideFriction", "useSideBounce", "sideArc"],
	buoyancy: ["surfaceLevel", "density", "linearDrag", "angularDrag", "flowAngle", "flowMagnitude", "flowVariation"],
};
function validateEffectorFields(value: Record<string, unknown>, common: string[], context: z.RefinementCtx): void {
	const type = value.type as string;
	const allowed = new Set([...common, ...effectorFamilyFields[type]]);
	const invalid = Object.keys(value).find((key) => !allowed.has(key));
	if (invalid) {
		context.addIssue({ code: "custom", path: [invalid], message: `${invalid} is not valid for a ${type} Effector 2D.` });
	}
}
const effectorTypes = z.enum(["point", "area", "surface", "platform", "buoyancy"]);
export const createPhysics2DEffectorSchema = z
	.object({ type: effectorTypes, ...effectorCommonCreate, ...effectorFields })
	.strict()
	.superRefine((value, context) => validateEffectorFields(value, ["type", ...Object.keys(effectorCommonCreate)], context));
export const setPhysics2DEffectorSchema = z
	.object({ type: effectorTypes, ...effectorCommonUpdate, ...effectorFields })
	.strict()
	.superRefine((value, context) => {
		validateEffectorFields(value, ["type", ...Object.keys(effectorCommonUpdate)], context);
		if (Object.keys(value).every((key) => ["id", "expectedRevision", "type"].includes(key))) {
			context.addIssue({ code: "custom", message: "Provide an effector field to update." });
		}
	});

export const applyPhysics2DForceSchema = z
	.object({
		nodeId: identity,
		expectedRevision: physics2DRevision,
		value: z.array(finite.min(-MaxForce).max(MaxForce)).length(2),
		mode: z.enum(["force", "impulse"]).optional(),
		worldPoint: physics2DVector.optional(),
	})
	.strict();
export const applyPhysics2DTorqueSchema = z
	.object({ nodeId: identity, expectedRevision: physics2DRevision, value: finite.min(-MaxForce).max(MaxForce), mode: z.enum(["force", "impulse"]).optional() })
	.strict();
export const setPhysics2DRuntimeVelocitySchema = z
	.object({
		nodeId: identity,
		expectedRevision: physics2DRevision,
		velocity: z.array(finite.min(-MaxVelocity).max(MaxVelocity)).length(2).optional(),
		angularVelocity: finite.min(-MaxVelocity).max(MaxVelocity).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.velocity === undefined && value.angularVelocity === undefined) {
			context.addIssue({ code: "custom", message: "Provide velocity, angularVelocity, or both." });
		}
	});
