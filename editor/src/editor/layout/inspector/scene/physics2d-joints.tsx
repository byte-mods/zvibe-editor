import { ReactNode, useState } from "react";

import { Scene } from "babylonjs";
import { IPhysics2DJointConfiguration, IPhysics2DPoint, physics2DJointTypes, Physics2DJointType } from "babylonjs-editor-tools";

import { toast } from "sonner";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { Editor } from "../../../main";

import {
	createPhysics2DJoint,
	createPhysics2DWorld,
	deletePhysics2DWorld,
	deletePhysics2DJoint,
	getPhysics2DSettings,
	listPhysics2D,
	listPhysics2DJoints,
	setPhysics2DJoint,
	setPhysics2DSettings,
	setPhysics2DWorld,
} from "../../../../mcp/physics2d/physics2d";

import { EditorInspectorSectionField } from "../fields/section";
import { runPhysics2DJointTransaction } from "./physics2d-joint-transaction";

export interface IPhysics2DSceneInspectorProps {
	scene: Scene;
	editor: Editor;
	onChanged: () => void;
}

interface INumberOptions {
	min: number;
	max: number;
	step: number;
	integer?: boolean;
	disabled?: boolean;
}

interface IJointRenderContext {
	joint: IPhysics2DJointConfiguration;
	update: (patch: Record<string, unknown>) => void;
}

const MaxCoordinate = 1_000_000;
const MaxForce = 1_000_000_000_000;
const RadiansToDegrees = 180 / Math.PI;
const DegreesToRadians = Math.PI / 180;

/** Compares scalar and structured joint fields without generating no-op revisions or Undo entries. */
function valuesMatch(current: unknown, requested: unknown): boolean {
	if (requested === null && current === undefined) {
		return true;
	}
	return Object.is(current, requested) || JSON.stringify(current) === JSON.stringify(requested);
}

/** Parses one bounded numeric Inspector commit and reports validation without throwing out of React. */
function parseNumber(value: string, label: string, options: INumberOptions): number | null {
	const candidate = Number(value);
	if (!Number.isFinite(candidate) || candidate < options.min || candidate > options.max || (options.integer && !Number.isSafeInteger(candidate))) {
		toast.error(`${label} must be ${options.integer ? "an integer " : ""}from ${options.min} to ${options.max}.`);
		return null;
	}
	return candidate;
}

/** Renders a commit-on-blur number so one typing sequence produces one exact joint transaction. */
function renderNumber(key: string, label: string, value: number, options: INumberOptions, onCommit: (value: number) => void): ReactNode {
	return (
		<label className="flex items-center justify-between gap-2 text-xs">
			<span>{label}</span>
			<Input
				key={key}
				className="w-32"
				type="number"
				min={options.min}
				max={options.max}
				step={options.step}
				defaultValue={String(value)}
				disabled={options.disabled}
				onBlur={(event) => {
					const candidate = parseNumber(event.currentTarget.value, label, options);
					if (candidate !== null && !Object.is(candidate, value)) {
						onCommit(candidate);
					}
				}}
				aria-label={`2D joint ${label}`}
			/>
		</label>
	);
}

/** Renders an explicit boolean control that remains keyboard reachable. */
function renderToggle(label: string, value: boolean, onClick: () => void, disabled = false): ReactNode {
	return (
		<Button size="sm" variant={value ? "default" : "secondary"} disabled={disabled} onClick={onClick}>
			{label}: {value ? "On" : "Off"}
		</Button>
	);
}

/** Renders an X/Y pair with one transaction per committed component. */
function renderPoint(label: string, property: string, value: IPhysics2DPoint, revision: number, update: (patch: Record<string, unknown>) => void, disabled = false): ReactNode {
	const set = (index: 0 | 1, component: number): void => {
		const point: IPhysics2DPoint = [...value];
		point[index] = component;
		update({ [property]: point });
	};
	return (
		<div className="grid grid-cols-2 gap-2">
			{renderNumber(`${revision}-${property}-x`, `${label} X (cm)`, value[0], { min: -MaxCoordinate, max: MaxCoordinate, step: 1, disabled }, (component) =>
				set(0, component)
			)}
			{renderNumber(`${revision}-${property}-y`, `${label} Y (cm)`, value[1], { min: -MaxCoordinate, max: MaxCoordinate, step: 1, disabled }, (component) =>
				set(1, component)
			)}
		</div>
	);
}

/** Presents optional break thresholds without persisting JSON-incompatible Infinity. */
function renderOptionalThreshold(
	label: string,
	property: "breakForce" | "breakTorque",
	value: number | undefined,
	revision: number,
	update: (patch: Record<string, unknown>) => void
): ReactNode {
	const enabled = value !== undefined;
	return (
		<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
			{renderToggle(label, enabled, () => update({ [property]: enabled ? null : 0 }))}
			{renderNumber(`${revision}-${property}`, `${label} Threshold`, value ?? 0, { min: 0, max: MaxForce, step: 1, disabled: !enabled }, (candidate) =>
				update({ [property]: candidate })
			)}
		</div>
	);
}

/** Renders the shared local/connected anchors for all anchored joint families. */
function renderAnchors(context: IJointRenderContext): ReactNode {
	const joint = context.joint as IPhysics2DJointConfiguration & {
		firstAnchor: IPhysics2DPoint;
		secondAnchor: IPhysics2DPoint;
		autoConfigureConnectedAnchor: boolean;
	};
	return (
		<>
			<div className="grid grid-cols-2 gap-2">
				{renderToggle("Auto Connected Anchor", joint.autoConfigureConnectedAnchor, () =>
					context.update({ autoConfigureConnectedAnchor: !joint.autoConfigureConnectedAnchor })
				)}
			</div>
			{renderPoint("Anchor", "firstAnchor", joint.firstAnchor, joint.revision, context.update)}
			{renderPoint("Connected Anchor", "secondAnchor", joint.secondAnchor, joint.revision, context.update, joint.autoConfigureConnectedAnchor)}
		</>
	);
}

/** Renders every type-specific Unity Joint2D property using the shared canonical contract. */
function renderJointSpecific(context: IJointRenderContext): ReactNode {
	const joint = context.joint;
	const update = context.update;
	const radians = (property: string, label: string, value: number, disabled = false): ReactNode =>
		renderNumber(`${joint.revision}-${property}`, label, value * RadiansToDegrees, { min: -5_000_000, max: 5_000_000, step: 1, disabled }, (degrees) =>
			update({ [property]: degrees * DegreesToRadians })
		);
	if (joint.type === "distance") {
		return (
			<>
				{renderAnchors(context)}
				{renderNumber(`${joint.revision}-distance`, "Distance (cm)", joint.distance, { min: 0, max: MaxCoordinate * 2, step: 1 }, (distance) => update({ distance }))}
				{renderToggle("Max Distance Only", joint.maxDistanceOnly, () => update({ maxDistanceOnly: !joint.maxDistanceOnly }))}
			</>
		);
	}
	if (joint.type === "fixed") {
		return (
			<>
				{renderAnchors(context)}
				{radians("referenceAngle", "Reference Angle (°)", joint.referenceAngle)}
				{renderNumber(`${joint.revision}-frequency`, "Frequency (Hz)", joint.frequency, { min: 0, max: 10_000, step: 0.1 }, (frequency) => update({ frequency }))}
				{renderNumber(`${joint.revision}-dampingRatio`, "Damping Ratio", joint.dampingRatio, { min: 0, max: 1, step: 0.01 }, (dampingRatio) => update({ dampingRatio }))}
			</>
		);
	}
	if (joint.type === "friction") {
		return (
			<>
				{renderAnchors(context)}
				{renderNumber(`${joint.revision}-maxForce`, "Maximum Force", joint.maxForce, { min: 0, max: MaxForce, step: 1 }, (maxForce) => update({ maxForce }))}
				{renderNumber(`${joint.revision}-maxTorque`, "Maximum Torque", joint.maxTorque, { min: 0, max: MaxForce, step: 1 }, (maxTorque) => update({ maxTorque }))}
			</>
		);
	}
	if (joint.type === "hinge") {
		return (
			<>
				{renderAnchors(context)}
				{radians("referenceAngle", "Reference Angle (°)", joint.referenceAngle)}
				<div className="grid grid-cols-2 gap-2">{renderToggle("Use Limits", joint.useLimits, () => update({ useLimits: !joint.useLimits }))}</div>
				<div className="grid grid-cols-2 gap-2">
					{radians("minAngle", "Minimum Angle (°)", joint.minAngle, !joint.useLimits)}
					{radians("maxAngle", "Maximum Angle (°)", joint.maxAngle, !joint.useLimits)}
				</div>
				<div className="grid grid-cols-2 gap-2">{renderToggle("Use Motor", joint.useMotor, () => update({ useMotor: !joint.useMotor }))}</div>
				{radians("motorSpeed", "Motor Speed (°/s)", joint.motorSpeed, !joint.useMotor)}
				{renderNumber(
					`${joint.revision}-maxMotorTorque`,
					"Maximum Motor Torque",
					joint.maxMotorTorque,
					{ min: 0, max: MaxForce, step: 1, disabled: !joint.useMotor },
					(maxMotorTorque) => update({ maxMotorTorque })
				)}
			</>
		);
	}
	if (joint.type === "relative") {
		return (
			<>
				{renderPoint("Linear Offset", "linearOffset", joint.linearOffset, joint.revision, update)}
				{radians("angularOffset", "Angular Offset (°)", joint.angularOffset)}
				{renderNumber(`${joint.revision}-maxForce`, "Maximum Force", joint.maxForce, { min: 0, max: MaxForce, step: 1 }, (maxForce) => update({ maxForce }))}
				{renderNumber(`${joint.revision}-maxTorque`, "Maximum Torque", joint.maxTorque, { min: 0, max: MaxForce, step: 1 }, (maxTorque) => update({ maxTorque }))}
				{renderNumber(`${joint.revision}-correctionScale`, "Correction Scale", joint.correctionScale, { min: 0, max: 1, step: 0.01 }, (correctionScale) =>
					update({ correctionScale })
				)}
			</>
		);
	}
	if (joint.type === "slider") {
		return (
			<>
				{renderAnchors(context)}
				{radians("angle", "Axis Angle (°)", joint.angle)}
				{radians("referenceAngle", "Reference Angle (°)", joint.referenceAngle)}
				<div className="grid grid-cols-2 gap-2">{renderToggle("Use Limits", joint.useLimits, () => update({ useLimits: !joint.useLimits }))}</div>
				<div className="grid grid-cols-2 gap-2">
					{renderNumber(
						`${joint.revision}-lowerTranslation`,
						"Lower Translation (cm)",
						joint.lowerTranslation,
						{ min: -MaxCoordinate * 2, max: MaxCoordinate * 2, step: 1, disabled: !joint.useLimits },
						(lowerTranslation) => update({ lowerTranslation })
					)}
					{renderNumber(
						`${joint.revision}-upperTranslation`,
						"Upper Translation (cm)",
						joint.upperTranslation,
						{ min: -MaxCoordinate * 2, max: MaxCoordinate * 2, step: 1, disabled: !joint.useLimits },
						(upperTranslation) => update({ upperTranslation })
					)}
				</div>
				<div className="grid grid-cols-2 gap-2">{renderToggle("Use Motor", joint.useMotor, () => update({ useMotor: !joint.useMotor }))}</div>
				{renderNumber(
					`${joint.revision}-motorSpeed`,
					"Motor Speed (cm/s)",
					joint.motorSpeed,
					{ min: -100_000, max: 100_000, step: 1, disabled: !joint.useMotor },
					(motorSpeed) => update({ motorSpeed })
				)}
				{renderNumber(
					`${joint.revision}-maxMotorForce`,
					"Maximum Motor Force",
					joint.maxMotorForce,
					{ min: 0, max: MaxForce, step: 1, disabled: !joint.useMotor },
					(maxMotorForce) => update({ maxMotorForce })
				)}
			</>
		);
	}
	if (joint.type === "spring") {
		return (
			<>
				{renderAnchors(context)}
				{renderNumber(`${joint.revision}-distance`, "Distance (cm)", joint.distance, { min: 0, max: MaxCoordinate * 2, step: 1 }, (distance) => update({ distance }))}
				{renderNumber(`${joint.revision}-frequency`, "Frequency (Hz)", joint.frequency, { min: 0, max: 10_000, step: 0.1 }, (frequency) => update({ frequency }))}
				{renderNumber(`${joint.revision}-dampingRatio`, "Damping Ratio", joint.dampingRatio, { min: 0, max: 1, step: 0.01 }, (dampingRatio) => update({ dampingRatio }))}
			</>
		);
	}
	if (joint.type === "target") {
		return (
			<>
				{renderPoint("Target", "target", joint.target, joint.revision, update)}
				{renderNumber(`${joint.revision}-maxForce`, "Maximum Force", joint.maxForce, { min: 0, max: MaxForce, step: 1 }, (maxForce) => update({ maxForce }))}
				{renderNumber(`${joint.revision}-frequency`, "Frequency (Hz)", joint.frequency, { min: 0, max: 10_000, step: 0.1 }, (frequency) => update({ frequency }))}
				{renderNumber(`${joint.revision}-dampingRatio`, "Damping Ratio", joint.dampingRatio, { min: 0, max: 1, step: 0.01 }, (dampingRatio) => update({ dampingRatio }))}
			</>
		);
	}
	return (
		<>
			{renderAnchors(context)}
			{radians("angle", "Suspension Angle (°)", joint.angle)}
			{renderNumber(`${joint.revision}-frequency`, "Frequency (Hz)", joint.frequency, { min: 0, max: 10_000, step: 0.1 }, (frequency) => update({ frequency }))}
			{renderNumber(`${joint.revision}-dampingRatio`, "Damping Ratio", joint.dampingRatio, { min: 0, max: 1, step: 0.01 }, (dampingRatio) => update({ dampingRatio }))}
			<div className="grid grid-cols-2 gap-2">{renderToggle("Use Motor", joint.useMotor, () => update({ useMotor: !joint.useMotor }))}</div>
			{radians("motorSpeed", "Motor Speed (°/s)", joint.motorSpeed, !joint.useMotor)}
			{renderNumber(
				`${joint.revision}-maxMotorTorque`,
				"Maximum Motor Torque",
				joint.maxMotorTorque,
				{ min: 0, max: MaxForce, step: 1, disabled: !joint.useMotor },
				(maxMotorTorque) => update({ maxMotorTorque })
			)}
		</>
	);
}

/** Complete Scene-level Physics2D settings and all nine Unity-style Joint2D authoring families. */
export function Physics2DSceneInspector(props: IPhysics2DSceneInspectorProps): ReactNode {
	const [jointType, setJointType] = useState<Physics2DJointType>("distance");
	const [selectedFirstNodeId, setSelectedFirstNodeId] = useState("");
	const [selectedSecondNodeId, setSelectedSecondNodeId] = useState<string | null>(null);
	const [newWorldId, setNewWorldId] = useState("");
	let bodies: any[] = [];
	let joints: IPhysics2DJointConfiguration[] = [];
	let settings: any = null;
	let error: string | null = null;
	try {
		bodies = listPhysics2D(props.scene).bodies;
		joints = listPhysics2DJoints(props.scene).joints;
		settings = getPhysics2DSettings(props.scene);
	} catch (exception) {
		error = exception instanceof Error ? exception.message : "Physics 2D metadata could not be read.";
	}
	const bodyName = (nodeId: string | undefined): string => (nodeId ? (props.scene.getNodeById(nodeId)?.name ?? nodeId) : "World");
	const firstNodeId = bodies.some((body) => body.nodeId === selectedFirstNodeId) ? selectedFirstNodeId : (bodies[0]?.nodeId ?? "");
	const automaticSecond = bodies.find((body) => body.nodeId !== firstNodeId)?.nodeId ?? "";
	const secondNodeId = selectedSecondNodeId === null ? automaticSecond : selectedSecondNodeId === firstNodeId ? "" : selectedSecondNodeId;

	const mutate = (action: () => unknown): void => {
		try {
			runPhysics2DJointTransaction(props.scene, props.editor, action, props.onChanged);
		} catch (exception) {
			toast.error(exception instanceof Error ? exception.message : "Could not update the Physics 2D joint.");
		}
	};
	const updateJoint = (joint: IPhysics2DJointConfiguration, patch: Record<string, unknown>): void => {
		const values = joint as unknown as Record<string, unknown>;
		if (Object.entries(patch).every(([property, value]) => valuesMatch(values[property], value))) {
			return;
		}
		mutate(() => setPhysics2DJoint(props.scene, { id: joint.id, expectedRevision: joint.revision, ...patch }, { editor: props.editor }));
	};
	const createJoint = (): void => {
		if (!firstNodeId) {
			toast.error("Add at least one authored Physics 2D body before creating a joint.");
			return;
		}
		mutate(() =>
			createPhysics2DJoint(props.scene, { type: jointType, firstNodeId, ...(jointType !== "target" && secondNodeId ? { secondNodeId } : {}) }, { editor: props.editor })
		);
	};
	const updateSettings = (property: "velocityIterations" | "positionIterations", value: string): void => {
		if (!settings) {
			return;
		}
		const candidate = parseNumber(value, property === "velocityIterations" ? "Velocity Iterations" : "Position Iterations", { min: 1, max: 16, step: 1, integer: true });
		if (candidate === null || candidate === settings[property]) {
			return;
		}
		try {
			setPhysics2DSettings(props.scene, { expectedRevision: settings.revision, [property]: candidate }, { editor: props.editor });
			props.onChanged();
		} catch (exception) {
			toast.error(exception instanceof Error ? exception.message : "Could not update Physics 2D settings.");
		}
	};
	const updateGlobalSettings = (patch: Record<string, unknown>): void => {
		try {
			setPhysics2DSettings(props.scene, { expectedRevision: settings.revision, ...patch }, { editor: props.editor });
			props.onChanged();
		} catch (exception) {
			toast.error(exception instanceof Error ? exception.message : "Could not update Physics 2D settings.");
		}
	};
	const updateWorld = (id: string, patch: Record<string, unknown>): void => {
		try {
			setPhysics2DWorld(props.scene, { id, expectedRevision: settings.revision, ...patch }, { editor: props.editor });
			props.onChanged();
		} catch (exception) {
			toast.error(exception instanceof Error ? exception.message : "Could not update the Physics 2D world.");
		}
	};
	const createWorld = (): void => {
		const id = newWorldId.trim();
		if (!id) {
			return;
		}
		try {
			createPhysics2DWorld(props.scene, { id, name: id, expectedRevision: settings.revision }, { editor: props.editor });
			setNewWorldId("");
			props.onChanged();
		} catch (exception) {
			toast.error(exception instanceof Error ? exception.message : "Could not create the Physics 2D world.");
		}
	};
	const deleteWorld = (id: string): void => {
		try {
			deletePhysics2DWorld(props.scene, { id, expectedRevision: settings.revision }, { editor: props.editor });
			props.onChanged();
		} catch (exception) {
			toast.error(exception instanceof Error ? exception.message : "Could not delete the Physics 2D world.");
		}
	};

	if (error) {
		return (
			<EditorInspectorSectionField title="2D Physics">
				<div className="rounded border border-destructive p-2 text-xs text-destructive">{error}</div>
			</EditorInspectorSectionField>
		);
	}

	return (
		<>
			<EditorInspectorSectionField
				title="2D Physics Settings"
				tooltip="Bounded per-world solvers, transform planes/read/write policies, contact filtering, drawing, and camera-scoped debug rendering."
			>
				<div data-testid="physics2d-world-settings" className="space-y-2">
					<div className="grid grid-cols-2 gap-2">
						{renderNumber(
							`${settings.revision}-velocityIterations`,
							"Velocity Iterations",
							settings.velocityIterations,
							{ min: 1, max: 16, step: 1, integer: true },
							(value) => updateSettings("velocityIterations", String(value))
						)}
						{renderNumber(
							`${settings.revision}-positionIterations`,
							"Position Iterations",
							settings.positionIterations,
							{ min: 1, max: 16, step: 1, integer: true },
							(value) => updateSettings("positionIterations", String(value))
						)}
					</div>
					<div className="grid grid-cols-3 gap-2">
						{renderNumber(
							`${settings.revision}-maximumWorlds`,
							"Maximum Worlds",
							settings.maximumWorlds,
							{ min: settings.worlds.length, max: 8, step: 1, integer: true },
							(maximumWorlds) => updateGlobalSettings({ maximumWorlds })
						)}
						<label className="flex flex-col gap-1 text-xs">
							<span>Transform Read</span>
							<select
								className="h-9 rounded-md border border-input bg-background px-2 text-sm"
								value={settings.globalTransformReadMode}
								onChange={(event) => updateGlobalSettings({ globalTransformReadMode: event.target.value })}
							>
								<option value="authoring">Authoring</option>
								<option value="runtime">Runtime</option>
							</select>
						</label>
						{renderToggle("Release Debug", settings.renderingAvailableInRelease, () =>
							updateGlobalSettings({ renderingAvailableInRelease: !settings.renderingAvailableInRelease })
						)}
					</div>
					<div className="flex gap-2">
						<input
							className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
							value={newWorldId}
							onChange={(event) => setNewWorldId(event.target.value)}
							placeholder="world-id"
							aria-label="New Physics 2D world id"
						/>
						<Button variant="secondary" disabled={!newWorldId.trim() || settings.worlds.length >= settings.maximumWorlds} onClick={createWorld}>
							Add World
						</Button>
					</div>
					{settings.worlds.map((world: any) => (
						<div key={world.id} data-testid={`physics2d-world-${world.id}`} className="space-y-2 rounded border border-border p-2">
							<div className="flex items-center justify-between gap-2">
								<input
									className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 text-sm"
									defaultValue={world.name}
									onBlur={(event) =>
										event.currentTarget.value.trim() &&
										event.currentTarget.value.trim() !== world.name &&
										updateWorld(world.id, { name: event.currentTarget.value.trim() })
									}
									aria-label={`${world.id} world name`}
								/>
								{world.id !== "default" && (
									<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => deleteWorld(world.id)}>
										Delete
									</Button>
								)}
							</div>
							<div className="grid grid-cols-4 gap-2">
								{renderToggle("Enabled", world.enabled, () => updateWorld(world.id, { enabled: !world.enabled }))}
								{renderToggle("World Drawing", world.worldDrawing, () => updateWorld(world.id, { worldDrawing: !world.worldDrawing }))}
								{renderToggle("Always Draw", world.alwaysDraw, () => updateWorld(world.id, { alwaysDraw: !world.alwaysDraw }))}
								{renderToggle("Sync Interpolation", world.syncInterpolation, () => updateWorld(world.id, { syncInterpolation: !world.syncInterpolation }))}
							</div>
							<div className="grid grid-cols-3 gap-2">
								<label className="flex flex-col gap-1 text-xs">
									<span>Plane</span>
									<select
										className="h-9 rounded-md border border-input bg-background px-2"
										value={world.transformPlane.mode}
										onChange={(event) => {
											const mode = event.target.value;
											const axes =
												mode === "xz"
													? { xAxis: [1, 0, 0], yAxis: [0, 0, 1] }
													: mode === "yz"
														? { xAxis: [0, 1, 0], yAxis: [0, 0, 1] }
														: { xAxis: [1, 0, 0], yAxis: [0, 1, 0] };
											updateWorld(world.id, { transformPlane: { mode, origin: world.transformPlane.origin, ...axes } });
										}}
									>
										<option value="xy">XY</option>
										<option value="xz">XZ</option>
										<option value="yz">YZ</option>
										<option value="custom">Custom</option>
									</select>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									<span>Transform Write</span>
									<select
										className="h-9 rounded-md border border-input bg-background px-2"
										value={world.transformWriteMode}
										onChange={(event) => updateWorld(world.id, { transformWriteMode: event.target.value })}
									>
										<option value="direct">Direct</option>
										<option value="interpolate">Interpolate</option>
										<option value="tween">Tween</option>
									</select>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									<span>Contact Filter</span>
									<select
										className="h-9 rounded-md border border-input bg-background px-2"
										value={world.contactFilterMode}
										onChange={(event) => updateWorld(world.id, { contactFilterMode: event.target.value })}
									>
										<option value="layers">Layers</option>
										<option value="all">All</option>
										<option value="none">None</option>
									</select>
								</label>
							</div>
							<div className="grid grid-cols-3 gap-2">
								{renderNumber(
									`${settings.revision}-${world.id}-velocity`,
									"Velocity Iterations",
									world.velocityIterations,
									{ min: 1, max: 16, step: 1, integer: true },
									(velocityIterations) => updateWorld(world.id, { velocityIterations })
								)}
								{renderNumber(
									`${settings.revision}-${world.id}-position`,
									"Position Iterations",
									world.positionIterations,
									{ min: 1, max: 16, step: 1, integer: true },
									(positionIterations) => updateWorld(world.id, { positionIterations })
								)}
								{renderNumber(
									`${settings.revision}-${world.id}-tween`,
									"Tween Seconds",
									world.tweenDurationSeconds,
									{ min: 0, max: 10, step: 0.01 },
									(tweenDurationSeconds) => updateWorld(world.id, { tweenDurationSeconds })
								)}
							</div>
							<textarea
								className="min-h-16 w-full rounded border border-input bg-background p-2 font-mono text-xs"
								defaultValue={JSON.stringify(world.transformPlane)}
								onBlur={(event) => {
									try {
										const value = JSON.parse(event.currentTarget.value);
										if (JSON.stringify(value) !== JSON.stringify(world.transformPlane)) {
											updateWorld(world.id, { transformPlane: value });
										}
									} catch {
										toast.error("Transform plane must be valid JSON.");
									}
								}}
								aria-label={`${world.id} transform plane JSON`}
							/>
							<input
								className="h-8 w-full rounded border border-input bg-background px-2 text-xs"
								defaultValue={world.debugCameraIds.join(", ")}
								onBlur={(event) => {
									const debugCameraIds = event.currentTarget.value
										.split(",")
										.map((value) => value.trim())
										.filter(Boolean);
									if (JSON.stringify(debugCameraIds) !== JSON.stringify(world.debugCameraIds)) {
										updateWorld(world.id, { debugCameraIds });
									}
								}}
								placeholder="Debug camera ids (empty = all)"
								aria-label={`${world.id} debug camera ids`}
							/>
						</div>
					))}
				</div>
				<div className="px-2 text-xs text-muted-foreground">
					Contract v{settings.version} · revision {settings.revision} · {settings.worlds.length}/{settings.maximumWorlds} worlds
				</div>
			</EditorInspectorSectionField>

			<EditorInspectorSectionField
				title="2D Joints"
				tooltip="Author Distance, Fixed, Friction, Hinge, Relative, Slider, Spring, Target, and Wheel joints between bodies or the fixed world."
			>
				{bodies.length === 0 ? (
					<div className="px-2 text-sm text-muted-foreground">Add a Rigidbody 2D to a scene node before creating a joint.</div>
				) : (
					<div className="space-y-2 rounded border border-border p-2">
						<div className="grid grid-cols-3 gap-2">
							<label className="flex flex-col gap-1 text-xs">
								<span>Joint Type</span>
								<select
									className="h-9 rounded-md border border-input bg-background px-2 text-sm"
									value={jointType}
									onChange={(event) => setJointType(event.target.value as Physics2DJointType)}
								>
									{physics2DJointTypes.map((type) => (
										<option key={type} value={type}>
											{type}
										</option>
									))}
								</select>
							</label>
							<label className="flex flex-col gap-1 text-xs">
								<span>Body</span>
								<select
									className="h-9 rounded-md border border-input bg-background px-2 text-sm"
									value={firstNodeId}
									onChange={(event) => setSelectedFirstNodeId(event.target.value)}
								>
									{bodies.map((body) => (
										<option key={body.nodeId} value={body.nodeId}>
											{bodyName(body.nodeId)}
										</option>
									))}
								</select>
							</label>
							<label className="flex flex-col gap-1 text-xs">
								<span>Connected Body</span>
								<select
									className="h-9 rounded-md border border-input bg-background px-2 text-sm"
									value={jointType === "target" ? "" : secondNodeId}
									disabled={jointType === "target"}
									onChange={(event) => setSelectedSecondNodeId(event.target.value)}
								>
									<option value="">World</option>
									{bodies
										.filter((body) => body.nodeId !== firstNodeId)
										.map((body) => (
											<option key={body.nodeId} value={body.nodeId}>
												{bodyName(body.nodeId)}
											</option>
										))}
								</select>
							</label>
						</div>
						<Button className="w-full" variant="secondary" onClick={createJoint}>
							Add {jointType[0].toUpperCase() + jointType.slice(1)} Joint 2D
						</Button>
					</div>
				)}

				{joints.map((joint) => {
					const update = (patch: Record<string, unknown>): void => updateJoint(joint, patch);
					return (
						<div key={`${joint.id}-${joint.revision}`} className="space-y-2 rounded-lg bg-muted-foreground/10 p-2">
							<div className="flex items-center justify-between gap-2">
								<div className="min-w-0 text-xs">
									<div className="font-medium capitalize">{joint.type} Joint 2D</div>
									<div className="truncate text-muted-foreground">
										{bodyName(joint.firstNodeId)} → {bodyName(joint.secondNodeId)} · revision {joint.revision}
									</div>
								</div>
								<Button
									size="sm"
									variant="ghost"
									className="hover:bg-destructive"
									onClick={() => mutate(() => deletePhysics2DJoint(props.scene, { id: joint.id, expectedRevision: joint.revision }, { editor: props.editor }))}
								>
									Remove
								</Button>
							</div>
							<div className="grid grid-cols-2 gap-2">
								{renderToggle("Enabled", joint.enabled, () => update({ enabled: !joint.enabled }))}
								{renderToggle("Connected Collision", joint.enableCollision, () => update({ enableCollision: !joint.enableCollision }))}
								{renderToggle("World Drawing", joint.worldDrawing, () => update({ worldDrawing: !joint.worldDrawing }))}
							</div>
							<div className="grid grid-cols-2 gap-2">
								<label className="flex flex-col gap-1 text-xs">
									<span>Body</span>
									<select
										className="h-9 rounded-md border border-input bg-background px-2 text-sm"
										value={joint.firstNodeId}
										onChange={(event) =>
											update({ firstNodeId: event.target.value, ...(event.target.value === joint.secondNodeId ? { secondNodeId: null } : {}) })
										}
									>
										{bodies.map((body) => (
											<option key={body.nodeId} value={body.nodeId}>
												{bodyName(body.nodeId)}
											</option>
										))}
									</select>
								</label>
								<label className="flex flex-col gap-1 text-xs">
									<span>Connected Body</span>
									<select
										className="h-9 rounded-md border border-input bg-background px-2 text-sm"
										value={joint.secondNodeId ?? ""}
										disabled={joint.type === "target"}
										onChange={(event) => update({ secondNodeId: event.target.value || null })}
									>
										<option value="">World</option>
										{bodies
											.filter((body) => body.nodeId !== joint.firstNodeId)
											.map((body) => (
												<option key={body.nodeId} value={body.nodeId}>
													{bodyName(body.nodeId)}
												</option>
											))}
									</select>
								</label>
							</div>
							<label className="flex flex-col gap-1 text-xs">
								<span>Break Action</span>
								<select
									className="h-9 rounded-md border border-input bg-background px-2 text-sm"
									value={joint.breakAction}
									onChange={(event) => update({ breakAction: event.target.value })}
								>
									{["ignore", "callback-only", "disable", "destroy"].map((action) => (
										<option key={action} value={action}>
											{action}
										</option>
									))}
								</select>
							</label>
							{renderOptionalThreshold("Break Force", "breakForce", joint.breakForce, joint.revision, update)}
							{renderOptionalThreshold("Break Torque", "breakTorque", joint.breakTorque, joint.revision, update)}
							{renderJointSpecific({ joint, update })}
						</div>
					);
				})}
			</EditorInspectorSectionField>
		</>
	);
}
