import { ReactNode, useState } from "react";

import { toast } from "sonner";

import { TransformNode } from "babylonjs";
import { IPhysics2DBodyConfiguration, IPhysics2DColliderConfiguration, IPhysics2DPoint, normalizePhysics2DBodyConfiguration } from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { Editor } from "../../../main";

import {
	generatePhysics2DPolygonCollider,
	getPhysics2DSettings,
	getPhysics2DPolygonCollider,
	listPhysics2DMaterials,
	removePhysics2DBody,
	setPhysics2DBody,
	setPhysics2DPolygonCollider,
} from "../../../../mcp/physics2d/physics2d";

import { EditorInspectorSectionField } from "../fields/section";

import { runPhysics2DBodyAsyncTransaction, runPhysics2DBodyTransaction } from "./physics2d-body-transaction";

export interface IPhysics2DBodyInspectorProps {
	node: TransformNode;
	editor: Editor;
	onChanged?: () => void;
}

interface INumberOptions {
	min: number;
	max: number;
	step: number;
	integer?: boolean;
	disabled?: boolean;
}

const MaxCoordinate = 1_000_000;
const MaxMask = 0xffffffff;

/** Parses the compact x,y; x,y authoring form without accepting truncated or non-finite vertices. */
function parsePoints(value: string, minimum: number): IPhysics2DPoint[] | null {
	const pairs = value
		.split(";")
		.map((pair) => pair.trim())
		.filter(Boolean)
		.map((pair) => pair.split(",").map((component) => Number(component.trim())));
	if (pairs.length < minimum || pairs.length > 512 || pairs.some((point) => point.length !== 2 || !point.every(Number.isFinite))) {
		return null;
	}
	return pairs as IPhysics2DPoint[];
}

/** Produces bounded rectangular convex pieces for every Edge segment; runtime adds rounded contact radius. */
function edgeParts(points: IPhysics2DPoint[], radius: number): IPhysics2DPoint[][] | null {
	const parts: IPhysics2DPoint[][] = [];
	for (let index = 0; index < points.length - 1; index++) {
		const first = points[index];
		const second = points[index + 1];
		const dx = second[0] - first[0];
		const dy = second[1] - first[1];
		const length = Math.hypot(dx, dy);
		if (length <= 0.000001) {
			return null;
		}
		const normal: IPhysics2DPoint = [(-dy * radius) / length, (dx * radius) / length];
		parts.push([
			[first[0] + normal[0], first[1] + normal[1]],
			[second[0] + normal[0], second[1] + normal[1]],
			[second[0] - normal[0], second[1] - normal[1]],
			[first[0] - normal[0], first[1] - normal[1]],
		]);
	}
	return parts;
}

/** Keeps validation errors consistent across every numeric body and collider field. */
function numberValue(value: string, label: string, options: INumberOptions): number | null {
	const candidate = Number(value);
	if (!Number.isFinite(candidate) || candidate < options.min || candidate > options.max || (options.integer && !Number.isSafeInteger(candidate))) {
		toast.error(`${label} must be ${options.integer ? "an integer " : ""}from ${options.min} to ${options.max}.`);
		return null;
	}
	return candidate;
}

/** Renders one commit-on-blur number so a drag/key sequence becomes one exact metadata transaction. */
function renderNumber(key: string, label: string, value: number, options: INumberOptions, onCommit: (value: number) => void): ReactNode {
	return (
		<label className="flex items-center justify-between gap-2 px-2 text-sm">
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
					const candidate = numberValue(event.currentTarget.value, label, options);
					if (candidate !== null && !Object.is(candidate, value)) {
						onCommit(candidate);
					}
				}}
				aria-label={`2D body ${label}`}
			/>
		</label>
	);
}

/** Complete Unity-style Rigidbody 2D and Collider 2D authoring for meshes and plain TransformNodes. */
export function Physics2DBodyInspector(props: IPhysics2DBodyInspectorProps): ReactNode {
	const [imagePath, setImagePath] = useState("");
	const scene = props.node.getScene();
	const rawBodies = scene.metadata?.babylonEditorPhysics2D;
	const source = Array.isArray(rawBodies) ? rawBodies.find((candidate: any) => candidate?.nodeId === props.node.id) : undefined;
	const validation = source === undefined ? null : normalizePhysics2DBodyConfiguration(source);
	const body = validation?.ok ? validation.value : null;
	const listedMaterials = listPhysics2DMaterials(scene).materials;
	const materials = Array.isArray(listedMaterials) ? listedMaterials : [];
	const worlds = getPhysics2DSettings(scene).worlds;
	const values = body as unknown as Record<string, unknown> | null;

	const mutate = (action: () => unknown): void => {
		try {
			runPhysics2DBodyTransaction(scene, props.editor, action, props.onChanged);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update the Physics 2D body.");
		}
	};
	const update = (patch: Record<string, unknown>): void => {
		if (!body) {
			mutate(() => setPhysics2DBody(scene, { nodeId: props.node.id, collider: { shape: "box", size: [100, 100] }, ...patch }, { editor: props.editor }));
			return;
		}
		if (!Object.entries(patch).every(([property, value]) => Object.is(values?.[property], value))) {
			mutate(() => setPhysics2DBody(scene, { nodeId: props.node.id, expectedRevision: body.revision, ...patch }, { editor: props.editor }));
		}
	};
	const updateCollider = (patch: Partial<IPhysics2DColliderConfiguration>): void => {
		if (body) {
			update({ collider: { ...body.collider, ...patch } });
		}
	};
	const updatePoint = (property: "velocity" | "centerOfMass" | "gravity", current: IPhysics2DPoint, index: 0 | 1, value: number): void => {
		const next: IPhysics2DPoint = [...current];
		next[index] = value;
		update({ [property]: next });
	};
	const updateColliderPoint = (index: 0 | 1, value: number): void => {
		if (body) {
			const offset: IPhysics2DPoint = [...body.collider.offset];
			offset[index] = value;
			updateCollider({ offset });
		}
	};
	const changeShape = (shape: IPhysics2DColliderConfiguration["shape"]): void => {
		if (!body) {
			return;
		}
		const common = { offset: body.collider.offset, density: body.collider.density };
		if (shape === "circle") {
			update({ collider: { shape, radius: body.collider.shape === "circle" ? body.collider.radius : 50, ...common } });
		} else if (shape === "box" || shape === "capsule") {
			const size = body.collider.shape === "box" || body.collider.shape === "capsule" ? body.collider.size : [100, 100];
			update({ collider: { shape, size, ...(shape === "capsule" ? { direction: "vertical" } : {}), ...common } });
		} else if (shape === "polygon") {
			const points =
				body.collider.points?.length && body.collider.points.length >= 3
					? body.collider.points
					: ([
							[-50, -50],
							[50, -50],
							[50, 50],
							[-50, 50],
						] as IPhysics2DPoint[]);
			update({ collider: { shape, points, ...common } });
		} else {
			const points =
				body.collider.points?.length && body.collider.points.length >= 2
					? body.collider.points
					: ([
							[-50, 0],
							[50, 0],
						] as IPhysics2DPoint[]);
			const edgeRadius = body.collider.edgeRadius && body.collider.edgeRadius > 0 ? body.collider.edgeRadius : 1;
			update({ collider: { shape, points, parts: edgeParts(points, edgeRadius), edgeRadius, ...common } });
		}
	};
	const commitPoints = (value: string, shape: "polygon" | "edge"): void => {
		if (!body) {
			return;
		}
		const points = parsePoints(value, shape === "polygon" ? 3 : 2);
		if (!points) {
			toast.error(`${shape === "polygon" ? "Polygon" : "Edge"} points require ${shape === "polygon" ? "3" : "2"}-512 finite x,y pairs.`);
			return;
		}
		if (JSON.stringify(points) === JSON.stringify(body.collider.points)) {
			return;
		}
		if (shape === "edge") {
			const parts = edgeParts(points, body.collider.edgeRadius ?? 1);
			if (!parts) {
				toast.error("Edge points must be distinct consecutive positions.");
				return;
			}
			updateCollider({ points, parts });
		} else {
			update({ collider: { shape: "polygon", points, offset: body.collider.offset, density: body.collider.density } });
		}
	};
	const commitContours = (value: string): void => {
		if (!body || body.collider.shape !== "polygon") {
			return;
		}
		try {
			const contours = JSON.parse(value);
			if (JSON.stringify(contours) === JSON.stringify(body.collider.contours)) {
				return;
			}
			mutate(() => {
				const current = getPhysics2DPolygonCollider(scene, { nodeId: props.node.id });
				return setPhysics2DPolygonCollider(scene, { nodeId: props.node.id, expectedRevision: current.revision, contours }, { editor: props.editor });
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update polygon contours.");
		}
	};
	const generatePolygon = async (outline: "convex" | "concave" | "compound"): Promise<void> => {
		try {
			await runPhysics2DBodyAsyncTransaction(
				scene,
				props.editor,
				() => generatePhysics2DPolygonCollider(scene, { nodeId: props.node.id, imagePath: imagePath.trim(), outline }, { editor: props.editor }),
				props.onChanged
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not generate the polygon collider.");
		}
	};

	return (
		<EditorInspectorSectionField
			title="Rigidbody 2D + Collider 2D"
			tooltip="Complete world/plane-aware body authoring in centimeters: motion/mass state, five collider families, drawing, contacts, constraints, continuous collision, and per-body layer overrides."
		>
			{rawBodies !== undefined && !Array.isArray(rawBodies) ? (
				<div className="rounded border border-destructive p-2 text-xs text-destructive">Invalid persisted body collection: expected an array.</div>
			) : source !== undefined && validation && !validation.ok ? (
				<div className="rounded border border-destructive p-2 text-xs text-destructive">Invalid persisted body: {validation.error}</div>
			) : !body ? (
				<Button variant="secondary" className="w-full" onClick={() => update({})}>
					Add Rigidbody 2D
				</Button>
			) : (
				<>
					<div className="grid grid-cols-2 gap-2">
						<label className="flex flex-col gap-1 text-xs">
							<span>Physics World</span>
							<select
								className="h-9 rounded-md border border-input bg-background px-2 text-sm"
								value={body.worldId}
								onChange={(event) => update({ worldId: event.target.value })}
							>
								{worlds.map((world: any) => (
									<option key={world.id} value={world.id}>
										{world.name}
									</option>
								))}
							</select>
						</label>
						{renderSelect("Body Type", body.bodyType, ["dynamic", "kinematic", "static"], (bodyType) => update({ bodyType }))}
						{renderSelect("Collision Detection", body.collisionDetection, ["discrete", "continuous"], (collisionDetection) => update({ collisionDetection }))}
						{renderToggle("Enabled", body.enabled, () => update({ enabled: !body.enabled }))}
						{renderToggle("Is Trigger", body.isTrigger, () => update({ isTrigger: !body.isTrigger }))}
						{renderToggle("Used by Effector", body.usedByEffector, () => update({ usedByEffector: !body.usedByEffector }))}
						{renderToggle("World Drawing", body.worldDrawing, () => update({ worldDrawing: !body.worldDrawing }))}
					</div>

					<div className="mt-2 border-t border-border pt-2 text-xs font-semibold">Collider</div>
					{renderSelect("Shape", body.collider.shape, ["box", "circle", "capsule", "polygon", "edge"], (shape) => changeShape(shape as any))}
					{renderToggle("Shape World Drawing", body.collider.worldDrawing, () => updateCollider({ worldDrawing: !body.collider.worldDrawing }))}
					<div className="grid grid-cols-2 gap-2">
						{renderNumber(`${body.revision}-offset-x`, "Offset X (cm)", body.collider.offset[0], { min: -MaxCoordinate, max: MaxCoordinate, step: 1 }, (value) =>
							updateColliderPoint(0, value)
						)}
						{renderNumber(`${body.revision}-offset-y`, "Offset Y (cm)", body.collider.offset[1], { min: -MaxCoordinate, max: MaxCoordinate, step: 1 }, (value) =>
							updateColliderPoint(1, value)
						)}
					</div>
					{renderNumber(`${body.revision}-density`, "Density", body.collider.density, { min: 0.000000001, max: 1000, step: 0.001 }, (density) =>
						updateCollider({ density })
					)}
					{renderColliderFields(body, updateCollider, commitPoints, commitContours)}
					{body.collider.shape === "polygon" && (
						<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
							<Input
								value={imagePath}
								onChange={(event) => setImagePath(event.currentTarget.value)}
								placeholder="assets/sprite.png"
								aria-label="Polygon collider source image"
							/>
							<div className="flex gap-1">
								{(["convex", "concave", "compound"] as const).map((outline) => (
									<Button key={outline} size="sm" variant="secondary" disabled={!imagePath.trim()} onClick={() => void generatePolygon(outline)}>
										{outline === "compound" ? "Holes + Islands" : outline}
									</Button>
								))}
							</div>
						</div>
					)}

					<div className="mt-2 border-t border-border pt-2 text-xs font-semibold">Motion</div>
					{renderPointFields("Velocity (cm/s)", "velocity", body.velocity, body.revision, { min: -MaxCoordinate, max: MaxCoordinate, step: 1 }, (index, value) =>
						updatePoint("velocity", body.velocity, index, value)
					)}
					{renderNumber(
						`${body.revision}-angular-velocity`,
						"Angular Velocity (rad/s)",
						body.angularVelocity,
						{ min: -100000, max: 100000, step: 0.1 },
						(angularVelocity) => update({ angularVelocity })
					)}
					{renderPointFields("Gravity (cm/s²)", "gravity", body.gravity, body.revision, { min: -MaxCoordinate, max: MaxCoordinate, step: 1 }, (index, value) =>
						updatePoint("gravity", body.gravity, index, value)
					)}
					{renderNumber(`${body.revision}-gravity-scale`, "Gravity Scale", body.gravityScale, { min: -100, max: 100, step: 0.1 }, (gravityScale) =>
						update({ gravityScale })
					)}
					{renderNumber(`${body.revision}-linear-damping`, "Linear Damping", body.linearDamping, { min: 0, max: 0.999, step: 0.01 }, (linearDamping) =>
						update({ linearDamping })
					)}
					{renderNumber(`${body.revision}-angular-damping`, "Angular Damping", body.angularDamping, { min: 0, max: 0.999, step: 0.01 }, (angularDamping) =>
						update({ angularDamping })
					)}

					<div className="mt-2 border-t border-border pt-2 text-xs font-semibold">Mass Properties</div>
					<div className="grid grid-cols-3 gap-2">
						{renderToggle("Auto Mass", body.useAutoMass, () => update({ useAutoMass: !body.useAutoMass }))}
						{renderToggle("Auto Inertia", body.useAutoInertia, () => update({ useAutoInertia: !body.useAutoInertia }))}
						{renderToggle("Auto Center", body.useAutoCenterOfMass, () => update({ useAutoCenterOfMass: !body.useAutoCenterOfMass }))}
					</div>
					{renderNumber(`${body.revision}-mass`, "Mass", body.mass, { min: 0.001, max: 1e9, step: 0.1, disabled: body.useAutoMass }, (mass) => update({ mass }))}
					{renderNumber(`${body.revision}-inertia`, "Inertia", body.inertia, { min: 0.001, max: 1e12, step: 0.1, disabled: body.useAutoInertia }, (inertia) =>
						update({ inertia })
					)}
					{renderPointFields(
						"Center of Mass (cm)",
						"center",
						body.centerOfMass,
						body.revision,
						{ min: -MaxCoordinate, max: MaxCoordinate, step: 1, disabled: body.useAutoCenterOfMass },
						(index, value) => updatePoint("centerOfMass", body.centerOfMass, index, value)
					)}

					<div className="mt-2 border-t border-border pt-2 text-xs font-semibold">Constraints</div>
					<div className="grid grid-cols-3 gap-2">
						{renderToggle("Freeze X", body.freezePositionX, () => update({ freezePositionX: !body.freezePositionX }))}
						{renderToggle("Freeze Y", body.freezePositionY, () => update({ freezePositionY: !body.freezePositionY }))}
						{renderToggle("Freeze Rotation", body.freezeRotation, () => update({ freezeRotation: !body.freezeRotation }))}
					</div>

					<div className="mt-2 border-t border-border pt-2 text-xs font-semibold">Material + Layers</div>
					<label className="flex flex-col gap-1 text-xs">
						<span>Physics Material 2D</span>
						<select
							className="h-9 rounded-md border border-input bg-background px-2 text-sm"
							value={body.materialId ?? ""}
							onChange={(event) => update({ materialId: event.target.value || null })}
						>
							<option value="">No material</option>
							{materials.map((material: any) => (
								<option key={material.id} value={material.id}>
									{material.name}
								</option>
							))}
						</select>
					</label>
					{renderOptionalContact(
						"Friction Override",
						body.friction,
						0,
						() => update({ friction: body.friction === undefined ? 0 : null }),
						(friction) => update({ friction }),
						body.revision
					)}
					{renderOptionalContact(
						"Restitution Override",
						body.restitution,
						0,
						() => update({ restitution: body.restitution === undefined ? 0 : null }),
						(restitution) => update({ restitution }),
						body.revision
					)}
					{renderNumber(`${body.revision}-collision-layer`, "Collision Layer", body.collisionLayer, { min: 0, max: 31, step: 1, integer: true }, (collisionLayer) =>
						update({ collisionLayer })
					)}
					{renderNumber(
						`${body.revision}-override-priority`,
						"Override Priority",
						body.layerOverrides.priority,
						{ min: -128, max: 127, step: 1, integer: true },
						(priority) => update({ layerOverrides: { ...body.layerOverrides, priority } })
					)}
					{renderLayerMasks(body, (layerOverrides) => update({ layerOverrides }))}

					<div className="text-xs text-muted-foreground">
						Contract v{body.version} · revision {body.revision}
					</div>
					<Button
						variant="ghost"
						className="w-full hover:bg-destructive"
						onClick={() => mutate(() => removePhysics2DBody(scene, { nodeId: props.node.id, expectedRevision: body.revision }, { editor: props.editor }))}
					>
						Remove Rigidbody 2D
					</Button>
				</>
			)}
		</EditorInspectorSectionField>
	);
}

/** Renders a compact closed enum selector with a visible label. */
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

/** Uses explicit labeled buttons so every boolean remains keyboard reachable and visually inspectable. */
function renderToggle(label: string, value: boolean, onClick: () => void): ReactNode {
	return (
		<Button size="sm" variant={value ? "default" : "secondary"} onClick={onClick}>
			{label}: {value ? "On" : "Off"}
		</Button>
	);
}

/** Renders two independently committed components while preserving the untouched coordinate. */
function renderPointFields(
	label: string,
	key: string,
	value: IPhysics2DPoint,
	revision: number,
	options: INumberOptions,
	onCommit: (index: 0 | 1, value: number) => void
): ReactNode {
	return (
		<div className="grid grid-cols-2 gap-2">
			{renderNumber(`${revision}-${key}-x`, `${label} X`, value[0], options, (next) => onCommit(0, next))}
			{renderNumber(`${revision}-${key}-y`, `${label} Y`, value[1], options, (next) => onCommit(1, next))}
		</div>
	);
}

/** Selects and edits every shape-specific collider property without leaking fields across shape families. */
function renderColliderFields(
	body: IPhysics2DBodyConfiguration,
	update: (patch: Partial<IPhysics2DColliderConfiguration>) => void,
	commitPoints: (value: string, shape: "polygon" | "edge") => void,
	commitContours: (value: string) => void
): ReactNode {
	const collider = body.collider;
	if (collider.shape === "circle") {
		return renderNumber(`${body.revision}-radius`, "Radius (cm)", collider.radius!, { min: 0.001, max: MaxCoordinate, step: 1 }, (radius) => update({ radius }));
	}
	if (collider.shape === "box" || collider.shape === "capsule") {
		return (
			<>
				<div className="grid grid-cols-2 gap-2">
					{renderNumber(`${body.revision}-size-x`, "Width (cm)", collider.size![0], { min: 0.001, max: MaxCoordinate, step: 1 }, (value) =>
						update({ size: [value, collider.size![1]] })
					)}
					{renderNumber(`${body.revision}-size-y`, "Height (cm)", collider.size![1], { min: 0.001, max: MaxCoordinate, step: 1 }, (value) =>
						update({ size: [collider.size![0], value] })
					)}
				</div>
				{collider.shape === "capsule" &&
					renderSelect("Capsule Direction", collider.direction!, ["horizontal", "vertical"], (direction) => update({ direction: direction as any }))}
			</>
		);
	}
	if (collider.shape === "polygon") {
		return (
			<>
				<label className="flex flex-col gap-1 text-xs">
					<span>Polygon Points (x,y; x,y)</span>
					<textarea
						key={`${body.revision}-polygon-points`}
						className="min-h-20 rounded-md border border-input bg-background p-2 font-mono text-xs"
						defaultValue={collider.points!.map((point) => point.join(",")).join("; ")}
						onBlur={(event) => commitPoints(event.currentTarget.value, "polygon")}
					/>
				</label>
				<label className="flex flex-col gap-1 text-xs">
					<span>Compound Contours JSON</span>
					<textarea
						key={`${body.revision}-polygon-contours`}
						className="min-h-28 rounded-md border border-input bg-background p-2 font-mono text-xs"
						defaultValue={JSON.stringify(collider.contours ?? [{ id: `body-${body.nodeId}-outer-1`, points: collider.points, holes: [] }], null, 2)}
						onBlur={(event) => commitContours(event.currentTarget.value)}
					/>
				</label>
			</>
		);
	}
	return (
		<>
			{renderNumber(`${body.revision}-edge-radius`, "Edge Radius (cm)", collider.edgeRadius!, { min: 0.000001, max: MaxCoordinate, step: 0.1 }, (edgeRadius) => {
				const parts = edgeParts(collider.points!, edgeRadius);
				if (parts) {
					update({ edgeRadius, parts });
				}
			})}
			<label className="flex flex-col gap-1 text-xs">
				<span>Edge Points (x,y; x,y)</span>
				<textarea
					key={`${body.revision}-edge-points`}
					className="min-h-20 rounded-md border border-input bg-background p-2 font-mono text-xs"
					defaultValue={collider.points!.map((point) => point.join(",")).join("; ")}
					onBlur={(event) => commitPoints(event.currentTarget.value, "edge")}
				/>
			</label>
		</>
	);
}

/** Allows material-derived contact values or explicit per-body overrides, including exact clearing. */
function renderOptionalContact(label: string, value: number | undefined, fallback: number, onToggle: () => void, onCommit: (value: number) => void, revision: number): ReactNode {
	return (
		<div className="grid grid-cols-2 gap-2">
			{renderToggle(label, value !== undefined, onToggle)}
			{renderNumber(`${revision}-${label}`, label, value ?? fallback, { min: 0, max: 1, step: 0.01, disabled: value === undefined }, onCommit)}
		</div>
	);
}

/** Exposes all six unsigned layer masks while preserving the remaining override fields on each edit. */
function renderLayerMasks(body: IPhysics2DBodyConfiguration, onCommit: (value: IPhysics2DBodyConfiguration["layerOverrides"]) => void): ReactNode {
	const fields = [
		["includeLayers", "Include Layers"],
		["excludeLayers", "Exclude Layers"],
		["forceSendLayers", "Force Send Layers"],
		["forceReceiveLayers", "Force Receive Layers"],
		["callbackLayers", "Callback Layers"],
		["contactCaptureLayers", "Contact Capture Layers"],
	] as const;
	return (
		<div className="grid grid-cols-2 gap-2">
			{fields.map(([property, label]) =>
				renderNumber(`${body.revision}-${property}`, label, body.layerOverrides[property], { min: 0, max: MaxMask, step: 1, integer: true }, (value) =>
					onCommit({ ...body.layerOverrides, [property]: value })
				)
			)}
		</div>
	);
}
