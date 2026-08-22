import { ReactNode } from "react";

import { toast } from "sonner";

import { AbstractMesh } from "babylonjs";
import { Physics2DEffectorType, physics2DEffectorTypes } from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { Editor } from "../../../main";

import { createPhysics2DEffector, deletePhysics2DEffector, listPhysics2D, listPhysics2DEffectors, setPhysics2DEffector } from "../../../../mcp/physics2d/physics2d";

import { EditorInspectorSectionField } from "../fields/section";

import { runPhysics2DEffectorTransaction } from "./physics2d-effector-transaction";

export interface IPhysics2DEffectorInspectorProps {
	mesh: AbstractMesh;
	editor: Editor;
	onChanged?: () => void;
}

interface INumberField {
	property: string;
	label: string;
	min: number;
	max: number;
	step: number;
}

const labels: Record<Physics2DEffectorType, string> = {
	point: "Point",
	area: "Area",
	surface: "Surface",
	platform: "Platform",
	buoyancy: "Buoyancy",
};

const numberFields: Record<Physics2DEffectorType, INumberField[]> = {
	point: [
		{ property: "forceMagnitude", label: "Force Magnitude", min: -1e9, max: 1e9, step: 1 },
		{ property: "forceVariation", label: "Force Variation", min: 0, max: 1e9, step: 1 },
		{ property: "distanceScale", label: "Distance Scale", min: 0.000001, max: 1e6, step: 0.1 },
		{ property: "linearDrag", label: "Linear Drag", min: 0, max: 1e6, step: 0.1 },
		{ property: "angularDrag", label: "Angular Drag", min: 0, max: 1e6, step: 0.1 },
		{ property: "radius", label: "Legacy Radius (cm)", min: 0.001, max: 1e6, step: 1 },
		{ property: "force", label: "Legacy Force", min: -1e9, max: 1e9, step: 1 },
		{ property: "falloff", label: "Legacy Falloff", min: 0, max: 1000, step: 0.1 },
	],
	area: [
		{ property: "forceMagnitude", label: "Force Magnitude", min: -1e9, max: 1e9, step: 1 },
		{ property: "forceVariation", label: "Force Variation", min: 0, max: 1e9, step: 1 },
		{ property: "forceAngle", label: "Force Angle (deg)", min: -360000, max: 360000, step: 1 },
		{ property: "linearDrag", label: "Linear Drag", min: 0, max: 1e6, step: 0.1 },
		{ property: "angularDrag", label: "Angular Drag", min: 0, max: 1e6, step: 0.1 },
		{ property: "radius", label: "Legacy Radius (cm)", min: 0.001, max: 1e6, step: 1 },
		{ property: "force", label: "Legacy Force", min: -1e9, max: 1e9, step: 1 },
		{ property: "falloff", label: "Legacy Falloff", min: 0, max: 1000, step: 0.1 },
	],
	surface: [
		{ property: "speed", label: "Speed (cm/s)", min: -1e9, max: 1e9, step: 1 },
		{ property: "speedVariation", label: "Speed Variation", min: -1e9, max: 1e9, step: 1 },
		{ property: "forceScale", label: "Force Scale", min: 0, max: 1, step: 0.01 },
		{ property: "surfaceThickness", label: "Legacy Thickness (cm)", min: 0.001, max: 1e6, step: 1 },
		{ property: "radius", label: "Legacy Radius (cm)", min: 0.001, max: 1e6, step: 1 },
		{ property: "force", label: "Legacy Force", min: -1e9, max: 1e9, step: 1 },
		{ property: "falloff", label: "Legacy Falloff", min: 0, max: 1000, step: 0.1 },
	],
	platform: [
		{ property: "rotationalOffset", label: "Rotational Offset (deg)", min: -360000, max: 360000, step: 1 },
		{ property: "surfaceArc", label: "Surface Arc (deg)", min: 0, max: 360, step: 1 },
		{ property: "sideArc", label: "Side Arc (deg)", min: 0, max: 180, step: 1 },
		{ property: "platformAngle", label: "Legacy World Angle (deg)", min: -360000, max: 360000, step: 1 },
	],
	buoyancy: [
		{ property: "surfaceLevel", label: "Surface Level (cm)", min: -1e6, max: 1e6, step: 1 },
		{ property: "density", label: "Density", min: 0, max: 1e6, step: 0.1 },
		{ property: "linearDrag", label: "Linear Drag", min: 0, max: 1e6, step: 0.1 },
		{ property: "angularDrag", label: "Angular Drag", min: 0, max: 1e6, step: 0.1 },
		{ property: "flowAngle", label: "Flow Angle (deg)", min: -360000, max: 360000, step: 1 },
		{ property: "flowMagnitude", label: "Flow Magnitude", min: -1e9, max: 1e9, step: 1 },
		{ property: "flowVariation", label: "Flow Variation", min: -1e9, max: 1e9, step: 1 },
	],
};

const booleanFields: Record<Physics2DEffectorType, { property: string; label: string }[]> = {
	point: [],
	area: [{ property: "useGlobalAngle", label: "Use Global Angle" }],
	surface: [
		{ property: "useContactForce", label: "Use Contact Force" },
		{ property: "useFriction", label: "Use Friction" },
		{ property: "useBounce", label: "Use Bounce" },
	],
	platform: [
		{ property: "useOneWay", label: "Use One Way" },
		{ property: "useOneWayGrouping", label: "Use One Way Grouping" },
		{ property: "useSideFriction", label: "Use Side Friction" },
		{ property: "useSideBounce", label: "Use Side Bounce" },
	],
	buoyancy: [],
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Could not update the Physics 2D Effector.";
}

export function Physics2DEffectorInspector(props: IPhysics2DEffectorInspectorProps): ReactNode {
	const scene = props.mesh.getScene();
	const body = listPhysics2D(scene).bodies.find((candidate: any) => candidate.nodeId === props.mesh.id);
	const effector = listPhysics2DEffectors(scene).effectors.find((candidate) => candidate.nodeId === props.mesh.id);
	const values = effector as unknown as Record<string, unknown>;

	const mutate = (action: () => unknown): void => {
		try {
			runPhysics2DEffectorTransaction(scene, props.editor, action, props.onChanged);
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};
	const create = (type: Physics2DEffectorType): void => {
		mutate(() => createPhysics2DEffector(scene, { nodeId: props.mesh.id, type }, { editor: props.editor }));
	};
	const update = (patch: Record<string, unknown>): void => {
		if (effector && !Object.entries(patch).every(([property, value]) => Object.is(values[property], value))) {
			mutate(() => setPhysics2DEffector(scene, { id: effector.id, expectedRevision: effector.revision, ...patch }, { editor: props.editor }));
		}
	};
	const updateNumber = (field: INumberField, value: string): void => {
		const number = Number(value);
		if (!Number.isFinite(number) || number < field.min || number > field.max) {
			toast.error(`${field.label} must be between ${field.min} and ${field.max}.`);
			return;
		}
		update({ [field.property]: number });
	};
	const staticRequired = (type: Physics2DEffectorType): boolean => type === "platform" || type === "buoyancy";

	return (
		<EditorInspectorSectionField
			title="2D Effector"
			tooltip="Unity-style Point, Area, Surface, Platform, and Buoyancy behavior. Current effectors use the owner Collider 2D marked Used by Effector; legacy radial fields remain editable for migrated scenes."
		>
			{!effector ? (
				<div className="grid grid-cols-2 gap-2">
					{physics2DEffectorTypes.map((type) => (
						<Button key={type} size="sm" variant="secondary" disabled={staticRequired(type) && body?.bodyType !== "static"} onClick={() => create(type)}>
							Add {labels[type]}
						</Button>
					))}
					{body?.bodyType !== "static" && <div className="col-span-2 text-xs text-muted-foreground">Platform and Buoyancy require a static 2D body.</div>}
				</div>
			) : (
				<>
					<div className="grid grid-cols-2 gap-2">
						<select
							className="h-9 rounded-md border border-input bg-background px-3 text-sm"
							value={effector.type}
							onChange={(event) => update({ type: event.target.value })}
						>
							{physics2DEffectorTypes.map((type) => (
								<option key={type} value={type} disabled={staticRequired(type) && body?.bodyType !== "static"}>
									{labels[type]}
								</option>
							))}
						</select>
						<Button variant={effector.enabled ? "default" : "secondary"} onClick={() => update({ enabled: !effector.enabled })}>
							{effector.enabled ? "Enabled" : "Disabled"}
						</Button>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Button variant={effector.useColliderMask ? "default" : "secondary"} onClick={() => update({ useColliderMask: !effector.useColliderMask })}>
							{effector.useColliderMask ? "Collider Mask On" : "Collider Mask Off"}
						</Button>
						<Input
							key={`${effector.id}-${effector.revision}-mask`}
							type="number"
							min="0"
							max="4294967295"
							step="1"
							defaultValue={String(effector.colliderMask)}
							disabled={!effector.useColliderMask}
							onBlur={(event) => {
								const colliderMask = Number(event.currentTarget.value);
								if (Number.isSafeInteger(colliderMask) && colliderMask >= 0 && colliderMask <= 0xffffffff) {
									update({ colliderMask });
								} else {
									toast.error("Collider Mask must be an unsigned 32-bit integer.");
								}
							}}
							aria-label="2D effector collider mask"
						/>
					</div>
					{body && !body.usedByEffector && (
						<div className="rounded border border-amber-500/50 p-2 text-xs text-amber-300">
							Enable Used by Effector on the owner 2D body for collider-backed behavior.
						</div>
					)}
					{numberFields[effector.type].map((field) => (
						<label key={field.property} className="flex items-center justify-between gap-2 px-2 text-sm">
							<span>{field.label}</span>
							<Input
								key={`${effector.id}-${effector.revision}-${field.property}`}
								className="w-28"
								type="number"
								min={field.min}
								max={field.max}
								step={field.step}
								defaultValue={String(values[field.property])}
								onBlur={(event) => updateNumber(field, event.currentTarget.value)}
								aria-label={`2D effector ${field.label}`}
							/>
						</label>
					))}
					{effector.type === "point" && (
						<div className="grid grid-cols-2 gap-2">
							{renderSelect("Force Source", effector.forceSource, ["collider", "rigidbody"], (forceSource) => update({ forceSource }))}
							{renderSelect("Force Target", effector.forceTarget, ["collider", "rigidbody"], (forceTarget) => update({ forceTarget }))}
							{renderSelect("Force Mode", effector.forceMode, ["constant", "inverse-linear", "inverse-squared"], (forceMode) => update({ forceMode }))}
						</div>
					)}
					{effector.type === "area" && renderSelect("Force Target", effector.forceTarget, ["collider", "rigidbody"], (forceTarget) => update({ forceTarget }))}
					<div className="grid grid-cols-2 gap-2">
						{booleanFields[effector.type].map((field) => (
							<Button
								key={field.property}
								size="sm"
								variant={values[field.property] ? "default" : "secondary"}
								onClick={() => update({ [field.property]: !values[field.property] })}
							>
								{field.label}: {values[field.property] ? "On" : "Off"}
							</Button>
						))}
					</div>
					{effector.type === "platform" && effector.usesLegacyWorldAngle && (
						<div className="text-xs text-muted-foreground">
							Legacy world-angle mode is active. Editing Rotational Offset upgrades this effector to the local collider frame.
						</div>
					)}
					<div className="text-xs text-muted-foreground">
						Contract v{effector.version} · revision {effector.revision}
					</div>
					<Button
						variant="ghost"
						className="w-full hover:bg-destructive"
						onClick={() => mutate(() => deletePhysics2DEffector(scene, { id: effector.id, expectedRevision: effector.revision }, { editor: props.editor }))}
					>
						Remove Effector
					</Button>
				</>
			)}
		</EditorInspectorSectionField>
	);
}

function renderSelect(label: string, value: string, options: string[], onChange: (value: string) => void): ReactNode {
	return (
		<label className="flex flex-col gap-1 text-xs">
			<span>{label}</span>
			<select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>
				{options.map((option) => (
					<option key={option} value={option}>
						{option.replaceAll("-", " ")}
					</option>
				))}
			</select>
		</label>
	);
}
