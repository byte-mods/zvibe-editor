import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const vector = z.array(z.number()).length(3);
const physicsNodeId = z.string().trim().min(1).max(256);
const hybridIdentifier = z.string().trim().min(1).max(128);
const hybridAxis = z
	.array(z.number().min(-1).max(1))
	.length(3)
	.refine((axis) => Math.hypot(axis[0], axis[1], axis[2]) >= 0.999 && Math.hypot(axis[0], axis[1], axis[2]) <= 1.001, "Axis must be normalized.");
const hybridGearFields = {
	name: z.string().trim().min(1).max(128).optional(),
	enabled: z.boolean().optional(),
	bodyANodeId: physicsNodeId.optional(),
	bodyBNodeId: physicsNodeId.optional(),
	axisA: hybridAxis.optional(),
	axisB: hybridAxis.optional(),
	ratio: z
		.number()
		.min(-100)
		.max(100)
		.refine((value) => Math.abs(value) >= 0.01, "ratio magnitude must be at least 0.01.")
		.optional(),
	targetVelocity: z.number().min(-1000).max(1000).optional(),
	maximumImpulse: z.number().min(0.000001).max(1_000_000).optional(),
};
const exactContentRevision = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe("Exact lowercase SHA-256 content revision returned by a physics contact history read/list/save operation.");
const physicsContactEventType = z.enum(["COLLISION_STARTED", "COLLISION_CONTINUED", "COLLISION_FINISHED"]);
const physicsForceVectorCategory = z.enum([
	"gravity-force",
	"net-force",
	"linear-velocity",
	"angular-velocity",
	"contact-normal",
	"contact-impulse",
	"constraint-axis",
	"constraint-separation",
]);
const physicsForceVectorCategories = z
	.array(physicsForceVectorCategory)
	.min(1)
	.max(8)
	.superRefine((categories, context) => {
		if (new Set(categories).size !== categories.length) {
			context.addIssue({ code: "custom", message: "categories must not contain duplicates." });
		}
	});
const physicsForceBodyNodeId = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => value === value.trim(), "Body node ids must not contain leading or trailing whitespace.");
const physicsForceBodyNodeIds = z
	.array(physicsForceBodyNodeId)
	.max(64)
	.superRefine((ids, context) => {
		if (new Set(ids).size !== ids.length) {
			context.addIssue({ code: "custom", message: "bodyNodeIds must not contain duplicates." });
		}
	});
const physicsForceVisualizationQuery = z
	.object({
		categories: physicsForceVectorCategories.optional().describe("Optional inclusive category filter over the currently displayed bounded snapshot."),
		bodyNodeIds: physicsForceBodyNodeIds.optional().describe("Optional filter matching either body side by stable node id."),
		offset: z.number().int().min(0).max(1_000_000).optional().describe("Zero-based filtered result offset; defaults to 0."),
		limit: z.number().int().min(1).max(100).optional().describe("Maximum detached vectors returned; defaults to 50."),
	})
	.strict();
const physicsForceVisualizationUpdate = z
	.object({
		expectedRevision: z.number().int().min(1).describe("Exact visualization revision returned by the latest get/set operation."),
		enabled: z.boolean().optional().describe("Attach or detach the temporary Play/Edit viewport visualization."),
		clear: z.boolean().optional().describe("Clear derived samples and rebuild the current overlay without advancing physics."),
		categories: physicsForceVectorCategories.optional().describe("One through eight unique categories to collect and draw."),
		bodyNodeIds: physicsForceBodyNodeIds.optional().describe("Zero through 64 stable body node ids; an empty array includes all bodies."),
		maximumVectors: z.number().int().min(1).max(512).optional().describe("Hard cap applied before rendering and query pagination."),
		refreshIntervalMs: z.number().int().min(16).max(2000).optional().describe("Viewport rebuild cadence in milliseconds."),
		forceScale: z.number().min(0.0001).max(1000).optional().describe("Viewport scale for gravity and derived net-force vectors."),
		impulseScale: z.number().min(0.0001).max(10_000).optional().describe("Viewport scale for captured contact impulses."),
		velocityScale: z.number().min(0.0001).max(1000).optional().describe("Viewport scale for linear velocity."),
		angularVelocityScale: z.number().min(0.0001).max(10_000).optional().describe("Viewport scale for angular velocity."),
		directionScale: z.number().min(1).max(10_000).optional().describe("Viewport scale for unit contact normals and authored constraint axes."),
		separationScale: z.number().min(0.0001).max(1000).optional().describe("Viewport scale for live constraint separation."),
		pointSize: z.number().min(1).max(1000).optional().describe("Maximum arrowhead length in editor centimeters."),
	})
	.strict()
	.superRefine((value, context) => {
		if (Object.keys(value).every((key) => key === "expectedRevision")) {
			context.addIssue({ code: "custom", message: "Provide enabled, clear, or at least one visualization setting to update." });
		}
	});
const physicsContactHistoryFilter = z
	.object({
		types: z.array(physicsContactEventType).max(3).optional().describe("Inclusive event-type filter; omit for all three event types."),
		bodyNodeIds: z.array(z.string().trim().min(1).max(256)).max(64).optional().describe("Match either recorded body side by stable node id."),
		fromMs: z.number().min(0).max(86_400_000).optional().describe("Inclusive elapsed-time lower bound in milliseconds."),
		toMs: z.number().min(0).max(86_400_000).optional().describe("Inclusive elapsed-time upper bound in milliseconds."),
		minimumImpulse: z.number().nullable().optional().describe("Inclusive impulse lower bound; events without an impulse are excluded when supplied."),
		maximumImpulse: z.number().nullable().optional().describe("Inclusive impulse upper bound; events without an impulse are excluded when supplied."),
	})
	.strict()
	.superRefine((filter, context) => {
		if (filter.types && new Set(filter.types).size !== filter.types.length) {
			context.addIssue({ code: "custom", path: ["types"], message: "types must not contain duplicates." });
		}
		if (filter.bodyNodeIds && new Set(filter.bodyNodeIds).size !== filter.bodyNodeIds.length) {
			context.addIssue({ code: "custom", path: ["bodyNodeIds"], message: "bodyNodeIds must not contain duplicates." });
		}
		if (filter.fromMs !== undefined && filter.toMs !== undefined && filter.fromMs > filter.toMs) {
			context.addIssue({ code: "custom", path: ["toMs"], message: "toMs must be at or after fromMs." });
		}
		if (
			filter.minimumImpulse !== null &&
			filter.minimumImpulse !== undefined &&
			filter.maximumImpulse !== null &&
			filter.maximumImpulse !== undefined &&
			filter.minimumImpulse > filter.maximumImpulse
		) {
			context.addIssue({ code: "custom", path: ["maximumImpulse"], message: "maximumImpulse must be at or above minimumImpulse." });
		}
	});
const physicsContactHistoryReplayControl = z
	.object({
		command: z.enum(["play", "pause", "seek", "step", "configure", "stop"]),
		sessionId: z.string().min(1).max(256),
		expectedSessionRevision: z.number().int().min(1),
		cursorMs: z.number().min(0).max(86_400_000).optional(),
		eventDelta: z
			.number()
			.int()
			.min(-100)
			.max(100)
			.refine((value) => value !== 0, "eventDelta must not be zero.")
			.optional(),
		playbackRate: z.number().min(0.1).max(10).optional(),
		trailMs: z.number().min(0).max(60_000).optional(),
		normalScale: z.number().min(1).max(10_000).optional(),
		pointSize: z.number().min(1).max(1_000).optional(),
		loop: z.boolean().optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const settings = [value.playbackRate, value.trailMs, value.normalScale, value.pointSize, value.loop];
		if (value.command === "seek" && value.cursorMs === undefined) {
			context.addIssue({ code: "custom", path: ["cursorMs"], message: "seek requires cursorMs." });
		}
		if (value.command === "configure" && settings.every((setting) => setting === undefined)) {
			context.addIssue({ code: "custom", path: ["command"], message: "configure requires at least one replay setting." });
		}
		if (value.command !== "seek" && value.cursorMs !== undefined) {
			context.addIssue({ code: "custom", path: ["cursorMs"], message: "cursorMs is only valid for seek." });
		}
		if (value.command !== "step" && value.eventDelta !== undefined) {
			context.addIssue({ code: "custom", path: ["eventDelta"], message: "eventDelta is only valid for step." });
		}
		if (value.command !== "configure" && settings.some((setting) => setting !== undefined)) {
			context.addIssue({ code: "custom", path: ["command"], message: "Replay settings are only valid for configure." });
		}
	});
const vehicleFrictionCurve = z
	.object({
		extremumSlip: z.number().min(0.001).max(10).describe("Slip at peak tire force."),
		extremumValue: z.number().min(0).max(10).describe("Peak force multiplier before stiffness."),
		asymptoteSlip: z.number().min(0.001).max(20).describe("Slip where the sustained high-slip force begins; must exceed extremumSlip."),
		asymptoteValue: z.number().min(0).max(10).describe("Sustained high-slip force multiplier before stiffness."),
		stiffness: z.number().min(0).max(10).describe("Multiplier for extremumValue and asymptoteValue; zero disables this tire direction."),
	})
	.strict()
	.superRefine((curve, context) => {
		if (curve.asymptoteSlip - curve.extremumSlip < 0.001) {
			context.addIssue({ code: "custom", path: ["asymptoteSlip"], message: "asymptoteSlip must be at least 0.001 greater than extremumSlip." });
		}
	});
const vehicleEngineTorqueKey = z
	.object({
		rpm: z.number().min(0).max(30000).describe("Engine speed for this absolute torque sample."),
		torque: z.number().min(0).max(5000).describe("Engine torque at this key in N·m."),
	})
	.strict();
const vehicleDrivetrain = z
	.object({
		engineTorqueCurve: z.array(vehicleEngineTorqueKey).min(2).max(16).describe("Strictly increasing RPM keys spanning idleRpm through redlineRpm."),
		idleRpm: z.number().min(100).max(5000).describe("Minimum running engine speed."),
		redlineRpm: z.number().min(200).max(30000).describe("Maximum engine speed; must be at least 100 RPM above idle."),
		engineInertia: z.number().min(0.01).max(100).describe("Engine rotational inertia used for free-rev response."),
		engineBrakingTorque: z.number().min(0).max(5000).describe("N·m opposing wheel rotation at closed throttle."),
		forwardGearRatios: z.array(z.number().min(0.1).max(20)).min(1).max(12).describe("Strictly decreasing positive forward gear ratios."),
		reverseGearRatio: z.number().min(0.1).max(20).describe("Positive reverse ratio; runtime applies the reverse sign."),
		finalDriveRatio: z.number().min(0.1).max(20).describe("Final reduction applied after the selected gear."),
		transmissionEfficiency: z.number().min(0).max(1).describe("Fraction of engine torque delivered through the transmission."),
		automatic: z.boolean().describe("Whether throttle direction and RPM thresholds select gears automatically."),
		downshiftRpm: z.number().min(100).max(30000).describe("Automatic downshift threshold, at or above idleRpm."),
		upshiftRpm: z.number().min(200).max(30000).describe("Automatic upshift threshold, at least 100 RPM above downshiftRpm and no higher than redlineRpm."),
		shiftDuration: z.number().min(0).max(5).describe("Seconds with the clutch disengaged while a shift is pending."),
		clutchEngagementRate: z.number().min(0.1).max(100).describe("Clutch engagement fraction per second outside a shift."),
		differentialType: z.enum(["open", "limited-slip", "locked"]).describe("Driven-wheel torque distribution policy."),
		limitedSlipBias: z.number().min(1).max(10).describe("Maximum relative limited-slip torque bias toward the higher-traction driven wheel."),
		differentialLockStrength: z.number().min(0).max(1000).describe("Locked-differential coupling torque in N·m per RPM of wheel-speed error."),
	})
	.strict()
	.superRefine((drivetrain, context) => {
		if (drivetrain.redlineRpm - drivetrain.idleRpm < 100) {
			context.addIssue({ code: "custom", path: ["redlineRpm"], message: "redlineRpm must be at least 100 greater than idleRpm." });
		}
		if (drivetrain.downshiftRpm < drivetrain.idleRpm) {
			context.addIssue({ code: "custom", path: ["downshiftRpm"], message: "downshiftRpm must be at or above idleRpm." });
		}
		if (drivetrain.upshiftRpm - drivetrain.downshiftRpm < 100 || drivetrain.upshiftRpm > drivetrain.redlineRpm) {
			context.addIssue({ code: "custom", path: ["upshiftRpm"], message: "upshiftRpm must be at least 100 above downshiftRpm and no higher than redlineRpm." });
		}
		for (let index = 1; index < drivetrain.engineTorqueCurve.length; index++) {
			if (drivetrain.engineTorqueCurve[index].rpm <= drivetrain.engineTorqueCurve[index - 1].rpm) {
				context.addIssue({ code: "custom", path: ["engineTorqueCurve", index, "rpm"], message: "Engine torque curve RPM keys must be strictly increasing." });
			}
		}
		if (drivetrain.engineTorqueCurve[0].rpm > drivetrain.idleRpm || drivetrain.engineTorqueCurve.at(-1)!.rpm < drivetrain.redlineRpm) {
			context.addIssue({ code: "custom", path: ["engineTorqueCurve"], message: "engineTorqueCurve must span idleRpm through redlineRpm." });
		}
		for (let index = 1; index < drivetrain.forwardGearRatios.length; index++) {
			if (drivetrain.forwardGearRatios[index] >= drivetrain.forwardGearRatios[index - 1]) {
				context.addIssue({ code: "custom", path: ["forwardGearRatios", index], message: "Forward gear ratios must be strictly decreasing." });
			}
		}
	});
const vehicleWheel = z
	.object({
		id: z.string().min(1).max(128),
		name: z.string().min(1).max(128).optional(),
		connectionPoint: vector.describe("Wheel suspension mount in chassis-local centimeters."),
		radius: z.number().positive().max(1000),
		mass: z.number().min(0.1).max(10000).optional().describe("Unsprung wheel mass used by the transient rotation solver; defaults to 20."),
		dampingRate: z.number().min(0).max(100).optional().describe("Angular damping per second; defaults to 0.25."),
		suspensionRestLength: z.number().positive().max(2000),
		maxTravel: z.number().min(0).max(1000),
		springStrength: z.number().min(0).max(1000000),
		damping: z.number().min(0).max(100000),
		steering: z.boolean().optional(),
		driven: z.boolean().optional(),
		brake: z.boolean().optional(),
		antiRollGroup: z.string().trim().min(1).max(64).nullable().optional().describe("Optional axle/group name. Every non-null group must occur on exactly two wheels."),
		forwardFriction: vehicleFrictionCurve.optional().describe("Optional per-wheel rolling-direction override; otherwise inherits the vehicle curve."),
		sidewaysFriction: vehicleFrictionCurve.optional().describe("Optional per-wheel lateral-direction override; otherwise inherits the vehicle curve."),
	})
	.strict();

export function registerPhysicsTools(server: McpServer): void {
	server.registerTool(
		"get_hybrid_physics_capabilities",
		{
			title: "Get hybrid physics capabilities",
			description:
				"Read the bounded Unity 6.5-style portable direct/iterative solver boundary, supported stiff-joint rows, gear limits, no-work fast path, shared editor/export runtime, and Chain & Gears sample capability without advancing physics.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_hybrid_physics_capabilities", {})
	);
	server.registerTool(
		"get_hybrid_physics_solver",
		{
			title: "Get hybrid physics solver",
			description: "Read the exact solver revision/settings, bounded gear couplings, owned Chain & Gears samples, and current runtime evidence without advancing physics.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_hybrid_physics_solver", {})
	);
	server.registerTool(
		"set_hybrid_physics_solver",
		{
			title: "Set hybrid physics solver",
			description:
				"Patch bounded globally-coupled direct-solver settings under the exact current revision. Babylon/Havok continues to own the ordinary iterative contact and joint pass; Undo/Redo shares the normal Inspector owner.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().min(1),
					enabled: z.boolean().optional(),
					positionErrorBias: z.number().min(0).max(1).optional(),
					regularization: z.number().min(0.000000001).max(0.1).optional(),
					maximumImpulse: z.number().min(0.000001).max(1_000_000).optional(),
					maximumRows: z.number().int().min(1).max(256).optional(),
				})
				.strict()
				.refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"), "Provide at least one setting."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_hybrid_physics_solver", args)
	);
	server.registerTool(
		"reset_hybrid_physics_solver",
		{
			title: "Reset hybrid physics solver",
			description:
				"Remove persisted hybrid solver settings under the exact current revision after every gear coupling and owned sample is gone, restoring bounded migration defaults on later reads. Requires confirmation and supports Undo/Redo.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(1), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_hybrid_physics_solver", args)
	);
	server.registerTool(
		"get_hybrid_physics_runtime",
		{
			title: "Get hybrid physics runtime",
			description:
				"Read processed/skipped frame counts, direct/gear row counts, truncation, residual reduction, solve duration, and the exact automatic skip reason without advancing or changing physics.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_hybrid_physics_runtime", {})
	);
	server.registerTool(
		"solve_hybrid_physics_now",
		{
			title: "Solve hybrid physics now",
			description:
				"Run one bounded supplemental direct velocity solve at an exact configuration revision without stepping Babylon/Havok, collision detection, scripts, cloth, or Physics 2D. Intended for paused deterministic verification.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(1), deltaSeconds: z.number().min(0.001).max(0.1).optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("solve_hybrid_physics_now", args)
	);
	server.registerTool(
		"create_hybrid_physics_gear_coupling",
		{
			title: "Create hybrid physics gear coupling",
			description: "Create one bounded exact-revision angular gear row between two existing physics meshes for the global direct solve.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().min(1),
					id: hybridIdentifier.optional(),
					name: hybridGearFields.name,
					enabled: hybridGearFields.enabled,
					bodyANodeId: physicsNodeId,
					bodyBNodeId: physicsNodeId,
					axisA: hybridGearFields.axisA,
					axisB: hybridGearFields.axisB,
					ratio: hybridGearFields.ratio,
					targetVelocity: hybridGearFields.targetVelocity,
					maximumImpulse: hybridGearFields.maximumImpulse,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_hybrid_physics_gear_coupling", args)
	);
	server.registerTool(
		"set_hybrid_physics_gear_coupling",
		{
			title: "Set hybrid physics gear coupling",
			description:
				"Patch one bounded gear row under the exact current solver revision, including bodies, local normalized axes, ratio, motor target, enablement, and impulse cap.",
			inputSchema: z
				.object({ expectedRevision: z.number().int().min(1), id: hybridIdentifier, ...hybridGearFields })
				.strict()
				.refine((value) => Object.keys(value).some((key) => key !== "expectedRevision" && key !== "id"), "Provide at least one coupling field."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_hybrid_physics_gear_coupling", args)
	);
	server.registerTool(
		"delete_hybrid_physics_gear_coupling",
		{
			title: "Delete hybrid physics gear coupling",
			description: "Delete one exact-revision gear row after explicit confirmation; ordinary bodies and native constraints are preserved.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(1), id: hybridIdentifier, confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_hybrid_physics_gear_coupling", args)
	);
	server.registerTool(
		"set_physics_constraint_solver",
		{
			title: "Set physics constraint solver",
			description:
				"Choose native iterative-only or supplemental direct solving for one exact-revision ball, distance, hinge, or lock constraint. Direct rows remain coupled to Babylon/Havok collisions.",
			inputSchema: z.object({ id: hybridIdentifier, expectedRevision: z.number().int().min(1), solverMode: z.enum(["iterative", "direct"]) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics_constraint_solver", args)
	);
	server.registerTool(
		"create_chain_gears_physics_sample",
		{
			title: "Create Chain and Gears physics sample",
			description:
				"Create one bounded editor-owned Chain & Gears sample with 12–32 dynamic links, two hinged gears, direct stiff-link rows, a global gear coupling, native iterative contacts, explicit ownership, and rollback on failure.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().min(1),
					id: hybridIdentifier.optional(),
					name: z.string().trim().min(1).max(128).optional(),
					position: vector.optional(),
					linkCount: z.number().int().min(12).max(32).optional(),
					gearRatio: z.number().min(0.1).max(10).optional(),
					driveVelocity: z.number().min(-20).max(20).optional(),
					maximumGearImpulse: z.number().min(1).max(1_000_000).optional(),
					showFrames: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_chain_gears_physics_sample", args)
	);
	server.registerTool(
		"delete_chain_gears_physics_sample",
		{
			title: "Delete Chain and Gears physics sample",
			description: "Delete only the exact owned sample nodes, constraints, gear coupling, and unused materials after explicit confirmation and dual revision checks.",
			inputSchema: z
				.object({
					id: hybridIdentifier,
					expectedRevision: z.number().int().min(1),
					expectedConfigurationRevision: z.number().int().min(1),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_chain_gears_physics_sample", args)
	);
	server.registerTool(
		"list_physics_constraints",
		{
			title: "List physics constraints",
			description: "List persisted native Havok constraints and whether each is active in the live scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics_constraints", {})
	);
	server.registerTool(
		"validate_physics_scene",
		{
			title: "Validate physics scene",
			description:
				"Validate active physics setup before play/export: physics engine availability, dynamic body mass, expensive dynamic mesh shapes, serialized constraint node/body references, self-constraints, and inactive saved constraints. Does not alter the scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("validate_physics_scene", {})
	);
	server.registerTool(
		"get_physics_simulation_state",
		{
			title: "Get physics simulation state",
			description:
				"Read live 3D physics body motion type, mass, shape, pose, available velocities, serialized constraint activity, and validation diagnostics. Does not advance or alter simulation.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_simulation_state", {})
	);
	server.registerTool(
		"get_physics_simulation_control",
		{
			title: "Get physics simulation control",
			description:
				"Read the active Edit/Play target plus shared attached-script, cloth, Physics 2D, and optional Havok pause state. Returns per-solver registrations, automatic/manual fixed-step totals, script lifecycle calls, 2D contacts/triggers, exact deltas, and the last phase-specific bounded failure without advancing simulation.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_simulation_control", {})
	);
	server.registerTool(
		"set_physics_simulation_paused",
		{
			title: "Pause or resume game simulation",
			description:
				"Atomically pause or resume attached TypeScript lifecycle delivery, shared cloth, shared Physics 2D, and optional Havok while rendering continues. Preflights every exact Play-bundle bridge and rolls solver pause state back on failure. Automatically targets ready Play; otherwise Edit.",
			inputSchema: z.object({ paused: z.boolean() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics_simulation_paused", args)
	);
	server.registerTool(
		"step_physics_simulation",
		{
			title: "Step paused game simulation",
			description:
				"Advance the paused Edit/Play target by 1–120 exact fixed frames in scripts → cloth → Physics 2D → optional Havok order. Each shared solver suppresses automatic render delivery and reports registrations, work, contacts, deltas, counters, and failures; per-solver state rolls back on its own failure, clocks restore, and the whole-game result names completed phases.",
			inputSchema: z.object({ steps: z.number().int().min(1).max(120).optional(), deltaSeconds: z.number().min(0.001).max(0.1).optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("step_physics_simulation", args)
	);
	server.registerTool(
		"get_physics_force_visualization",
		{
			title: "Get physics force visualization",
			description:
				"Read the owner-stable Play/Edit physics debug-vector settings plus a bounded filtered page of gravity, derived net force, linear/angular velocity, captured contact normal/impulse, and authored constraint-axis/live-separation evidence. Returns exact units, provenance, sampling/render counts, truncation, limitations, and explicit proof that physics was not advanced and bodies were not mutated.",
			inputSchema: physicsForceVisualizationQuery,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_physics_force_visualization", args)
	);
	server.registerTool(
		"set_physics_force_visualization",
		{
			title: "Set physics force visualization",
			description:
				"Apply one exact-revision bounded Play/Edit physics debug-vector configuration and atomically attach, rebuild, clear, or detach its single temporary viewport line system. The overlay is non-pickable, hidden from the graph, never serialized, never advances physics, and never calls body force, impulse, or velocity setters. Net force remains explicitly derived from completed velocity samples; unavailable original applied forces and constraint reactions are never fabricated.",
			inputSchema: physicsForceVisualizationUpdate,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics_force_visualization", args)
	);
	server.registerTool(
		"get_physics_contact_visualization",
		{
			title: "Get physics contact visualization",
			description: "Read transient viewport contact-overlay settings and the current overlay count.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_contact_visualization", {})
	);
	server.registerTool(
		"set_physics_contact_visualization",
		{
			title: "Set physics contact visualization",
			description:
				"Enable/configure transient non-pickable viewport crosses and normal vectors for newly captured Havok contacts. Debug meshes are hidden from the graph and never serialized.",
			inputSchema: z.object({
				enabled: z.boolean().optional(),
				normalScale: z.number().min(1).max(10000).optional(),
				pointSize: z.number().min(1).max(1000).optional(),
				lifetimeMs: z.number().min(50).max(60000).optional(),
				clear: z.boolean().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics_contact_visualization", args)
	);
	server.registerTool(
		"start_physics_contact_capture",
		{
			title: "Start physics contact capture",
			description:
				"Start a bounded live Havok contact capture for current physics bodies. Captures contact point, normal, impulse, penetration distance, event type, and node identities.",
			inputSchema: z.object({
				maxEvents: z.number().int().min(1).max(1000).optional(),
				includeContinued: z.boolean().optional().describe("Include per-step COLLISION_CONTINUED events; defaults false to reduce noise."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("start_physics_contact_capture", args)
	);
	server.registerTool(
		"get_physics_contact_capture",
		{
			title: "Get physics contact capture",
			description: "Read the active bounded contact capture, including dropped-event count and serialized collision contacts.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_contact_capture", {})
	);
	server.registerTool(
		"clear_physics_contact_capture",
		{
			title: "Clear physics contact capture",
			description: "Clear captured contact events and dropped-event count without stopping the active session.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("clear_physics_contact_capture", {})
	);
	server.registerTool(
		"stop_physics_contact_capture",
		{
			title: "Stop physics contact capture",
			description: "Stop contact capture, restore every body’s previous callback-enabled state, and return the final bounded event snapshot.",
			inputSchema: z.object({}),
		},
		async (): Promise<CallToolResult> => callTextTool("stop_physics_contact_capture", {})
	);
	server.registerTool(
		"save_physics_contact_history",
		{
			title: "Save physics contact history",
			description:
				"Snapshot the active bounded Play/Edit contact capture into a strict project `.physicscontacts.json` asset without stopping capture. New assets must omit expectedRevision; replacement requires the exact SHA-256 revision and increments the asset revision atomically.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-contained `.physicscontacts.json` destination."),
					name: z.string().trim().min(1).max(128).optional(),
					expectedRevision: exactContentRevision.optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_physics_contact_history", args)
	);
	server.registerTool(
		"list_physics_contact_histories",
		{
			title: "List physics contact histories",
			description:
				"Page at most 512 validated project `.physicscontacts.json` assets with exact revisions and bounded summaries. Malformed assets are reported separately and no physics state is advanced or changed.",
			inputSchema: z
				.object({
					search: z.string().trim().min(1).max(128).optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_physics_contact_histories", args)
	);
	server.registerTool(
		"get_physics_contact_history",
		{
			title: "Get physics contact history",
			description:
				"Read one validated immutable contact-history revision through inclusive event/body/time/impulse filters and bounded pagination. Returns detached recorded evidence only; it does not run physics or invoke collision callbacks.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024),
					filter: physicsContactHistoryFilter.optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(1000).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_physics_contact_history", args)
	);
	server.registerTool(
		"delete_physics_contact_history",
		{
			title: "Delete physics contact history",
			description:
				"Delete one exact SHA-256 contact-history revision and its registry sidecar after confirm=true. A replay using that asset is stopped and its transient overlays are removed before deletion.",
			inputSchema: z.object({ path: z.string().min(1).max(1024), expectedRevision: exactContentRevision, confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_physics_contact_history", args)
	);
	server.registerTool(
		"start_physics_contact_history_replay",
		{
			title: "Start physics contact history replay",
			description:
				"Start one exact-revision filtered Play/Edit history replay with a bounded transient contact trail. Replay moves only its cursor and debug overlays: it never advances Havok, mutates bodies, or re-executes collision callbacks; stop live capture first.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024),
					expectedRevision: exactContentRevision,
					filter: physicsContactHistoryFilter.optional(),
					cursorMs: z.number().min(0).max(86_400_000).optional(),
					playing: z.boolean().optional(),
					loop: z.boolean().optional(),
					playbackRate: z.number().min(0.1).max(10).optional(),
					trailMs: z.number().min(0).max(60_000).optional(),
					normalScale: z.number().min(1).max(10_000).optional(),
					pointSize: z.number().min(1).max(1_000).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_physics_contact_history_replay", args)
	);
	server.registerTool(
		"get_physics_contact_history_replay",
		{
			title: "Get physics contact history replay",
			description:
				"Read the owner-stable replay session, exact asset/session revisions, filtered summary, cursor, selected event, and overlay evidence. Explicitly reports that physics was not advanced and callbacks were not re-executed.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_contact_history_replay", {})
	);
	server.registerTool(
		"control_physics_contact_history_replay",
		{
			title: "Control physics contact history replay",
			description:
				"Under the exact session id/revision lease, play, pause, seek, step by recorded event, configure, or stop the transient replay. Commands only update replay time and debug overlays; they never step physics or invoke recorded collision callbacks.",
			inputSchema: physicsContactHistoryReplayControl,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("control_physics_contact_history_replay", args)
	);
	server.registerTool(
		"list_vehicles",
		{
			title: "List arcade vehicles",
			description:
				"List persisted arcade-vehicle chassis controllers, engine/gearing/clutch/differential authoring, forward/sideways tire curves, anti-roll settings, current engine/gear/output and per-wheel contact/slip/grip/force/RPM/torque evidence, and active preview input overrides.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_vehicles", {})
	);
	server.registerTool(
		"create_vehicle",
		{
			title: "Create arcade vehicle",
			description:
				"Create a persisted raycast-wheel vehicle on a dynamic Havok chassis. New vehicles receive a bounded torque-curve engine, automatic/manual gearbox, clutch, final drive, limited-slip differential, separate Unity-style forward/sideways tire curves, wheel rotation, and front/rear anti-roll pairs. Optional Input Actions drive preview and exported games.",
			inputSchema: z.object({
				id: z.string().optional(),
				name: z.string().min(1).max(128).optional(),
				chassisNodeId: z.string(),
				enabled: z.boolean().optional(),
				maxEngineForce: z.number().min(0).max(1000000).optional().describe("Legacy direct drive force used only by saved vehicles without drivetrain authoring."),
				maxBrakeForce: z.number().min(0).max(1000000).optional(),
				maxSpeed: z.number().positive().max(100000).optional(),
				maxSteerAngle: z
					.number()
					.min(0)
					.max(Math.PI / 2)
					.optional(),
				wheelBase: z.number().positive().max(10000).optional(),
				lateralGrip: z.number().min(0).max(1000).optional(),
				forwardFriction: vehicleFrictionCurve.optional().describe("Default rolling-direction tire curve inherited by wheels."),
				sidewaysFriction: vehicleFrictionCurve.optional().describe("Default lateral-direction tire curve inherited by wheels."),
				antiRollStiffness: z.number().min(0).max(1000000).optional().describe("Anti-roll force per centimeter of paired-wheel compression difference; defaults to 2000."),
				maxAntiRollForce: z.number().min(0).max(1000000).optional().describe("Absolute anti-roll force cap applied at either wheel mount; defaults to 100000."),
				actionMapName: z.string().min(1).nullable().optional(),
				accelerateActionName: z.string().min(1).optional(),
				reverseActionName: z.string().min(1).optional(),
				leftActionName: z.string().min(1).optional(),
				rightActionName: z.string().min(1).optional(),
				brakeActionName: z.string().min(1).optional(),
				shiftUpActionName: z.string().min(1).optional().describe("Manual-transmission Input Action name; defaults to Shift Up."),
				shiftDownActionName: z.string().min(1).optional().describe("Manual-transmission Input Action name; defaults to Shift Down."),
				drivetrain: vehicleDrivetrain.optional().describe("Optional complete drivetrain; omitted creates the bounded road-car default."),
				wheels: z.array(vehicleWheel).min(2).max(16).optional().describe("Optional wheel setup; omitted creates a four-wheel default in editor centimeters."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_vehicle", args)
	);
	server.registerTool(
		"set_vehicle",
		{
			title: "Set arcade vehicle",
			description:
				"Atomically update persisted vehicle drivetrain, handling, default forward/sideways tire curves, anti-roll settings, enabled state, or input-action configuration. A drivetrain update must provide the complete nested object; invalid updates leave the working vehicle unchanged.",
			inputSchema: z.object({
				id: z.string(),
				enabled: z.boolean().optional(),
				maxEngineForce: z.number().min(0).max(1000000).optional().describe("Legacy direct drive force for vehicles without drivetrain metadata."),
				maxBrakeForce: z.number().min(0).max(1000000).optional(),
				maxSpeed: z.number().positive().max(100000).optional(),
				maxSteerAngle: z
					.number()
					.min(0)
					.max(Math.PI / 2)
					.optional(),
				wheelBase: z.number().positive().max(10000).optional(),
				lateralGrip: z.number().min(0).max(1000).optional(),
				forwardFriction: vehicleFrictionCurve.optional(),
				sidewaysFriction: vehicleFrictionCurve.optional(),
				antiRollStiffness: z.number().min(0).max(1000000).optional().describe("Anti-roll force per centimeter of paired-wheel compression difference."),
				maxAntiRollForce: z.number().min(0).max(1000000).optional().describe("Absolute anti-roll force cap applied at either wheel mount."),
				actionMapName: z.string().min(1).nullable().optional(),
				accelerateActionName: z.string().min(1).optional(),
				reverseActionName: z.string().min(1).optional(),
				leftActionName: z.string().min(1).optional(),
				rightActionName: z.string().min(1).optional(),
				brakeActionName: z.string().min(1).optional(),
				shiftUpActionName: z.string().min(1).optional(),
				shiftDownActionName: z.string().min(1).optional(),
				drivetrain: vehicleDrivetrain.optional().describe("Complete replacement drivetrain; relation validation is atomic."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_vehicle", args)
	);
	server.registerTool(
		"delete_vehicle",
		{
			title: "Delete arcade vehicle",
			description: "Delete one persisted arcade-vehicle controller without removing its chassis mesh or physics body.",
			inputSchema: z.object({ id: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_vehicle", args)
	);
	server.registerTool(
		"set_vehicle_wheels",
		{
			title: "Set vehicle wheels",
			description:
				"Atomically replace the complete 2–16 wheel raycast-suspension setup. Each wheel authors mount/radius/mass/damping, suspension, steering/drive/brake roles, optional per-wheel forward/sideways tire curves, and an optional exact two-wheel anti-roll group.",
			inputSchema: z.object({ id: z.string(), wheels: z.array(vehicleWheel).min(2).max(16) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_vehicle_wheels", args)
	);
	server.registerTool(
		"set_vehicle_input",
		{
			title: "Set live vehicle input",
			description:
				"Set transient throttle (-1 to 1), steering (-1 to 1), brake (0 to 1), or one manual gear command for an active editor vehicle preview. shiftUp/shiftDown are consumed as pulses; gear selects reverse (-1), neutral (0), or a forward gear. Input is not saved.",
			inputSchema: z.object({
				id: z.string(),
				throttle: z.number().min(-1).max(1).optional(),
				steering: z.number().min(-1).max(1).optional(),
				brake: z.number().min(0).max(1).optional(),
				shiftUp: z.boolean().optional(),
				shiftDown: z.boolean().optional(),
				gear: z.number().int().min(-1).max(12).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_vehicle_input", args)
	);
	server.registerTool(
		"create_physics_constraint",
		{
			title: "Create physics constraint",
			description: "Create a persisted native Havok joint between two meshes that already have enabled physics bodies. Pivots and axes are in each body’s local space.",
			inputSchema: z
				.object({
					id: z.string().optional(),
					type: z.enum(["ball", "distance", "hinge", "slider", "lock", "prismatic"]),
					parentNodeId: z.string(),
					childNodeId: z.string(),
					pivotA: vector.optional(),
					pivotB: vector.optional(),
					axisA: vector.optional(),
					axisB: vector.optional(),
					perpAxisA: vector.optional(),
					perpAxisB: vector.optional(),
					maxDistance: z.number().nonnegative().optional(),
					collision: z.boolean().optional(),
					solverMode: z.enum(["iterative", "direct"]).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics_constraint", args)
	);
	server.registerTool(
		"delete_physics_constraint",
		{ title: "Delete physics constraint", description: "Dispose and remove a persisted Havok constraint.", inputSchema: z.object({ id: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_physics_constraint", args)
	);
}
