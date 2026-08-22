import { shell } from "electron";

import { Component, ReactNode } from "react";
import { toast } from "sonner";

import { Divider } from "@blueprintjs/core";

import { AbstractMesh, PhysicsAggregate, PhysicsShape, PhysicsShapeType, PhysicsMotionType, PhysicsMassProperties, Mesh } from "babylonjs";
import { createDefaultVehicleDrivetrain } from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { isInstancedMesh, isMesh } from "../../../../tools/guards/nodes";

import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSectionField } from "../fields/section";
import { EditorInspectorListField, IEditorInspectorListFieldItem } from "../fields/list";
import { PrefabFieldOverrideDecorator } from "../prefab-property-overrides";
import { Button } from "../../../../ui/shadcn/ui/button";

import { setMeshPhysics } from "../../../../mcp/meshes/meshes";
import { addGameObjectComponent, inspectGameObjectComponents, removeGameObjectComponent } from "../../../../mcp/components/components";
import { getPhysicsCollisionLayers, IPhysicsCollisionLayer } from "../../../../mcp/scene/scene";
import {
	createDefaultVehicleFrictionCurve,
	createDefaultVehicleWheels,
	createVehicle,
	deleteVehicle,
	listVehicles,
	setVehicle,
	setVehicleWheels,
} from "../../../../mcp/physics/vehicles";
import { listInputActionMaps } from "../../../../mcp/input/input";
import { Editor } from "../../../main";

// Radix Select reserves the empty string for clearing, so the UI needs a non-empty persisted-null sentinel.
const noVehicleInputMapValueBase = "__zvibe_no_vehicle_input_map__";

export interface IEditorMeshPhysicsInspectorProps {
	mesh: AbstractMesh;
	editor: Editor;
}

export class EditorMeshPhysicsInspector extends Component<IEditorMeshPhysicsInspectorProps> {
	public render(): ReactNode {
		const o = {
			hasPhysicsBody: (this.props.mesh.physicsBody ?? null) !== null,
		};

		return (
			<EditorInspectorSectionField
				title="Physics"
				tooltip={
					<div>
						Configure physics using Havok. Can be used also for{" "}
						<b
							className="underline underline-offset-2"
							onClick={() => shell.openExternal("https://doc.babylonjs.com/features/featuresDeepDive/physics/characterController")}
						>
							advanced collisions
						</b>
						.
					</div>
				}
			>
				<PrefabFieldOverrideDecorator object={this.props.mesh} property="metadata.physicsAggregate">
					<EditorInspectorSwitchField
						object={o}
						property="hasPhysicsBody"
						prefabOverride={false}
						label="Enabled"
						noUndoRedo
						onChange={() => this._handleHasPhysicsAggregateChange()}
					/>

					{this.props.mesh.physicsAggregate && this._getPhysicsInspector(this.props.mesh.physicsAggregate)}
					{this.props.mesh.physicsAggregate && this._getVehicleControllerInspector()}
				</PrefabFieldOverrideDecorator>
			</EditorInspectorSectionField>
		);
	}

	/** Renders canonical vehicle actions so Inspector edits share validation and transient evidence with MCP. */
	private _getVehicleControllerInspector(): ReactNode {
		const scene = this.props.mesh.getScene();
		const vehicle = listVehicles(scene).vehicles.find((candidate: any) => candidate.chassisNodeId === this.props.mesh.id);
		const inputMaps = listInputActionMaps(scene).maps;
		let noVehicleInputMapValue = noVehicleInputMapValueBase;
		while (inputMaps.some((map: any) => map.name === noVehicleInputMapValue)) {
			noVehicleInputMapValue += "_";
		}
		const antiRollGroups = new Set(
			(vehicle?.wheels ?? []).map((wheel: any) => wheel.antiRollGroup).filter((group: unknown): group is string => typeof group === "string" && !!group)
		).size;
		const maximumLiveAntiRollForce = Math.max(0, ...Object.values(vehicle?.wheelStates ?? {}).map((state: any) => Math.abs(state.antiRollForce ?? 0)));
		const maximumForwardSlip = Math.max(0, ...Object.values(vehicle?.wheelStates ?? {}).map((state: any) => Math.abs(state.forwardSlip ?? 0)));
		const maximumSidewaysSlip = Math.max(0, ...Object.values(vehicle?.wheelStates ?? {}).map((state: any) => Math.abs(state.sidewaysSlip ?? 0)));
		const maximumWheelTorque = Math.max(0, ...Object.values(vehicle?.wheelStates ?? {}).map((state: any) => Math.abs(state.totalTorque ?? 0)));
		const drivetrainState = vehicle?.drivetrainState;
		const gearLabel = drivetrainState?.currentGear === -1 ? "R" : drivetrainState?.currentGear === 0 ? "N" : (drivetrainState?.currentGear ?? "-");
		const settings = vehicle
			? {
					enabled: vehicle.enabled,
					actionMapName: vehicle.actionMapName ?? noVehicleInputMapValue,
					maxEngineForce: vehicle.maxEngineForce,
					maxBrakeForce: vehicle.maxBrakeForce,
					maxSpeed: vehicle.maxSpeed,
					maxSteerAngle: vehicle.maxSteerAngle,
					wheelBase: vehicle.wheelBase,
					lateralGrip: vehicle.lateralGrip,
					forwardFriction: structuredClone(vehicle.forwardFriction ?? createDefaultVehicleFrictionCurve()),
					sidewaysFriction: structuredClone(vehicle.sidewaysFriction ?? createDefaultVehicleFrictionCurve()),
					antiRollStiffness: vehicle.antiRollStiffness ?? 0,
					maxAntiRollForce: vehicle.maxAntiRollForce ?? 100000,
					drivetrain: structuredClone(vehicle.drivetrain ?? createDefaultVehicleDrivetrain()),
				}
			: null;
		/** Persists a detached complete object because drivetrain relation validation is intentionally atomic. */
		const persistDrivetrain = (): void => {
			if (vehicle && settings) {
				setVehicle(scene, { id: vehicle.id, drivetrain: structuredClone(settings.drivetrain) }, { editor: this.props.editor });
			}
		};
		return (
			<>
				<Divider />
				<div className="flex items-center justify-between gap-2 px-2 text-xs">
					<span>{vehicle ? `Arcade vehicle: ${vehicle.name}` : "No arcade vehicle controller"}</span>
					{vehicle ? (
						<Button
							size="sm"
							variant="ghost"
							className="h-6 px-2 text-destructive"
							onClick={() => {
								deleteVehicle(scene, { id: vehicle.id }, { editor: this.props.editor });
								this.forceUpdate();
							}}
						>
							Remove Vehicle
						</Button>
					) : (
						<Button
							size="sm"
							variant="secondary"
							className="h-6 px-2"
							onClick={() => {
								createVehicle(scene, { name: `${this.props.mesh.name} Vehicle`, chassisNodeId: this.props.mesh.id }, { editor: this.props.editor });
								this.forceUpdate();
							}}
						>
							Add Vehicle Controller
						</Button>
					)}
				</div>
				{vehicle && settings && (
					<>
						<div className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
							<div>
								<div>
									{vehicle.wheels?.length ?? 0} wheels · {Object.values(vehicle.wheelStates ?? {}).filter((state: any) => state.grounded).length} grounded · F/S
									slip {maximumForwardSlip.toFixed(2)}/{maximumSidewaysSlip.toFixed(2)} · {antiRollGroups} anti-roll axle{antiRollGroups === 1 ? "" : "s"} ·{" "}
									{maximumLiveAntiRollForce.toFixed(0)} anti-roll force
								</div>
								{vehicle.drivetrain && (
									<div>
										{(drivetrainState?.engineRpm ?? vehicle.drivetrain.idleRpm).toFixed(0)} RPM · Gear {gearLabel} ·{" "}
										{((drivetrainState?.clutch ?? 0) * 100).toFixed(0)}% clutch · {Math.abs(drivetrainState?.outputTorque ?? 0).toFixed(0)} N·m output ·{" "}
										{maximumWheelTorque.toFixed(0)} N·m max wheel
									</div>
								)}
							</div>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 px-2"
								onClick={() => setVehicleWheels(scene, { id: vehicle.id, wheels: createDefaultVehicleWheels() }, { editor: this.props.editor })}
							>
								Reset 4 Wheels
							</Button>
						</div>
						<EditorInspectorSwitchField
							noUndoRedo
							object={settings}
							property="enabled"
							label="Vehicle Enabled"
							onChange={() => setVehicle(scene, { id: vehicle.id, enabled: settings.enabled }, { editor: this.props.editor })}
						/>
						<EditorInspectorListField
							noUndoRedo
							object={settings}
							property="actionMapName"
							label="Input Map"
							items={[{ text: "None (script/MCP)", value: noVehicleInputMapValue }, ...inputMaps.map((map: any) => ({ text: map.name, value: map.name }))]}
							onChange={(value) =>
								setVehicle(scene, { id: vehicle.id, actionMapName: value === noVehicleInputMapValue ? null : value }, { editor: this.props.editor })
							}
						/>
						{!vehicle.drivetrain && (
							<EditorInspectorNumberField
								noUndoRedo
								object={settings}
								property="maxEngineForce"
								label="Legacy Engine Force"
								min={0}
								onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, maxEngineForce: value }, { editor: this.props.editor })}
							/>
						)}
						<EditorInspectorNumberField
							noUndoRedo
							object={settings}
							property="maxBrakeForce"
							label="Brake Force"
							min={0}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, maxBrakeForce: value }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings}
							property="maxSpeed"
							label="Max Speed"
							min={1}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, maxSpeed: value }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings}
							property="maxSteerAngle"
							label="Max Steer (rad)"
							min={0}
							max={Math.PI / 2}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, maxSteerAngle: value }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings}
							property="wheelBase"
							label="Wheel Base"
							min={1}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, wheelBase: value }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings}
							property="lateralGrip"
							label="Legacy Lateral Grip"
							min={0}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, lateralGrip: value }, { editor: this.props.editor })}
						/>
						{!vehicle.drivetrain ? (
							<div className="flex items-center justify-between gap-2 px-2 py-1 text-xs">
								<span className="text-muted-foreground">Legacy direct-force vehicle; upgrade to author engine RPM, gears, clutch, and differential.</span>
								<Button
									size="sm"
									variant="secondary"
									className="h-6 px-2"
									onClick={() => setVehicle(scene, { id: vehicle.id, drivetrain: createDefaultVehicleDrivetrain() }, { editor: this.props.editor })}
								>
									Upgrade Drivetrain
								</Button>
							</div>
						) : (
							<>
								<div className="px-2 pt-1 text-xs font-medium">Engine & Transmission</div>
								<EditorInspectorSwitchField noUndoRedo object={settings.drivetrain} property="automatic" label="Automatic" onChange={persistDrivetrain} />
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="idleRpm"
									label="Idle RPM"
									min={Math.max(100, settings.drivetrain.engineTorqueCurve[0].rpm)}
									max={Math.min(5000, settings.drivetrain.redlineRpm - 100, settings.drivetrain.downshiftRpm)}
									step={10}
									onFinishChange={persistDrivetrain}
								/>
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="redlineRpm"
									label="Redline RPM"
									min={Math.max(settings.drivetrain.idleRpm + 100, settings.drivetrain.upshiftRpm)}
									max={Math.min(30000, settings.drivetrain.engineTorqueCurve.at(-1)?.rpm ?? 30000)}
									step={10}
									onFinishChange={persistDrivetrain}
								/>
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="engineInertia"
									label="Engine Inertia"
									min={0.01}
									max={100}
									onFinishChange={persistDrivetrain}
								/>
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="engineBrakingTorque"
									label="Engine Brake (N·m)"
									min={0}
									max={5000}
									onFinishChange={persistDrivetrain}
								/>
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="shiftDuration"
									label="Shift Duration (s)"
									min={0}
									max={5}
									onFinishChange={persistDrivetrain}
								/>
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="clutchEngagementRate"
									label="Clutch Rate"
									min={0.1}
									max={100}
									onFinishChange={persistDrivetrain}
								/>
								{settings.drivetrain.automatic && (
									<>
										<EditorInspectorNumberField
											noUndoRedo
											object={settings.drivetrain}
											property="downshiftRpm"
											label="Downshift RPM"
											min={settings.drivetrain.idleRpm}
											max={settings.drivetrain.upshiftRpm - 100}
											step={10}
											onFinishChange={persistDrivetrain}
										/>
										<EditorInspectorNumberField
											noUndoRedo
											object={settings.drivetrain}
											property="upshiftRpm"
											label="Upshift RPM"
											min={settings.drivetrain.downshiftRpm + 100}
											max={settings.drivetrain.redlineRpm}
											step={10}
											onFinishChange={persistDrivetrain}
										/>
									</>
								)}
								<div className="px-2 pt-1 text-xs font-medium">Engine Torque Curve</div>
								{settings.drivetrain.engineTorqueCurve.map((key: any, index: number) => (
									<div key={`engine-torque-${index}`}>
										<EditorInspectorNumberField
											noUndoRedo
											object={key}
											property="rpm"
											label={`Key ${index + 1} RPM`}
											min={
												index === 0
													? 0
													: Math.max(
															settings.drivetrain.engineTorqueCurve[index - 1].rpm + 1,
															index === settings.drivetrain.engineTorqueCurve.length - 1 ? settings.drivetrain.redlineRpm : 0
														)
											}
											max={
												index === 0
													? Math.min(settings.drivetrain.idleRpm, settings.drivetrain.engineTorqueCurve[index + 1].rpm - 1)
													: index === settings.drivetrain.engineTorqueCurve.length - 1
														? 30000
														: settings.drivetrain.engineTorqueCurve[index + 1].rpm - 1
											}
											step={10}
											onFinishChange={persistDrivetrain}
										/>
										<EditorInspectorNumberField
											noUndoRedo
											object={key}
											property="torque"
											label={`Key ${index + 1} Torque`}
											min={0}
											max={5000}
											onFinishChange={persistDrivetrain}
										/>
									</div>
								))}
								<div className="flex justify-end gap-2 px-2 py-1">
									<Button
										size="sm"
										variant="ghost"
										className="h-6 px-2"
										disabled={settings.drivetrain.engineTorqueCurve.length <= 2}
										onClick={() => {
											settings.drivetrain.engineTorqueCurve.splice(settings.drivetrain.engineTorqueCurve.length - 2, 1);
											persistDrivetrain();
										}}
									>
										Remove Peak Key
									</Button>
									<Button
										size="sm"
										variant="secondary"
										className="h-6 px-2"
										disabled={
											settings.drivetrain.engineTorqueCurve.length >= 16 ||
											settings.drivetrain.engineTorqueCurve.at(-1).rpm - settings.drivetrain.engineTorqueCurve.at(-2).rpm < 2
										}
										onClick={() => {
											const last = settings.drivetrain.engineTorqueCurve.at(-1);
											const previous = settings.drivetrain.engineTorqueCurve.at(-2);
											settings.drivetrain.engineTorqueCurve.splice(-1, 0, {
												rpm: Math.floor((previous.rpm + last.rpm) / 2),
												torque: (previous.torque + last.torque) / 2,
											});
											persistDrivetrain();
										}}
									>
										Add Torque Key
									</Button>
								</div>
								<div className="px-2 pt-1 text-xs font-medium">Gearbox</div>
								{settings.drivetrain.forwardGearRatios.map((ratio: number, index: number) => {
									const value = { ratio };
									return (
										<EditorInspectorNumberField
											key={`gear-ratio-${index}`}
											noUndoRedo
											object={value}
											property="ratio"
											label={`Gear ${index + 1} Ratio`}
											min={settings.drivetrain.forwardGearRatios[index + 1] + 0.001 || 0.1}
											max={settings.drivetrain.forwardGearRatios[index - 1] - 0.001 || 20}
											onFinishChange={(nextRatio) => {
												settings.drivetrain.forwardGearRatios[index] = nextRatio;
												persistDrivetrain();
											}}
										/>
									);
								})}
								<div className="flex justify-end gap-2 px-2 py-1">
									<Button
										size="sm"
										variant="ghost"
										className="h-6 px-2"
										disabled={settings.drivetrain.forwardGearRatios.length <= 1}
										onClick={() => {
											settings.drivetrain.forwardGearRatios.pop();
											persistDrivetrain();
										}}
									>
										Remove Gear
									</Button>
									<Button
										size="sm"
										variant="secondary"
										className="h-6 px-2"
										disabled={settings.drivetrain.forwardGearRatios.length >= 12 || settings.drivetrain.forwardGearRatios.at(-1) <= 0.1}
										onClick={() => {
											settings.drivetrain.forwardGearRatios.push(Math.max(0.1, settings.drivetrain.forwardGearRatios.at(-1) * 0.8));
											persistDrivetrain();
										}}
									>
										Add Gear
									</Button>
								</div>
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="reverseGearRatio"
									label="Reverse Ratio"
									min={0.1}
									max={20}
									onFinishChange={persistDrivetrain}
								/>
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="finalDriveRatio"
									label="Final Drive"
									min={0.1}
									max={20}
									onFinishChange={persistDrivetrain}
								/>
								<EditorInspectorNumberField
									noUndoRedo
									object={settings.drivetrain}
									property="transmissionEfficiency"
									label="Efficiency"
									min={0}
									max={1}
									onFinishChange={persistDrivetrain}
								/>
								<div className="px-2 pt-1 text-xs font-medium">Differential</div>
								<EditorInspectorListField
									noUndoRedo
									object={settings.drivetrain}
									property="differentialType"
									label="Type"
									items={[
										{ text: "Open", value: "open" },
										{ text: "Limited Slip", value: "limited-slip" },
										{ text: "Locked", value: "locked" },
									]}
									onChange={persistDrivetrain}
								/>
								{settings.drivetrain.differentialType === "limited-slip" && (
									<EditorInspectorNumberField
										noUndoRedo
										object={settings.drivetrain}
										property="limitedSlipBias"
										label="Torque Bias"
										min={1}
										max={10}
										onFinishChange={persistDrivetrain}
									/>
								)}
								{settings.drivetrain.differentialType === "locked" && (
									<EditorInspectorNumberField
										noUndoRedo
										object={settings.drivetrain}
										property="differentialLockStrength"
										label="Lock N·m/RPM"
										min={0}
										max={1000}
										onFinishChange={persistDrivetrain}
									/>
								)}
							</>
						)}
						<div className="px-2 pt-1 text-xs font-medium">Forward Tire Friction</div>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.forwardFriction}
							property="extremumSlip"
							label="Peak Slip"
							min={0.001}
							max={Math.min(10, settings.forwardFriction.asymptoteSlip - 0.001)}
							onFinishChange={() => setVehicle(scene, { id: vehicle.id, forwardFriction: structuredClone(settings.forwardFriction) }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.forwardFriction}
							property="extremumValue"
							label="Peak Grip"
							min={0}
							max={10}
							onFinishChange={() => setVehicle(scene, { id: vehicle.id, forwardFriction: structuredClone(settings.forwardFriction) }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.forwardFriction}
							property="asymptoteSlip"
							label="Slide Slip"
							min={Math.max(0.001, settings.forwardFriction.extremumSlip + 0.001)}
							max={20}
							onFinishChange={() => setVehicle(scene, { id: vehicle.id, forwardFriction: structuredClone(settings.forwardFriction) }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.forwardFriction}
							property="asymptoteValue"
							label="Slide Grip"
							min={0}
							max={10}
							onFinishChange={() => setVehicle(scene, { id: vehicle.id, forwardFriction: structuredClone(settings.forwardFriction) }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.forwardFriction}
							property="stiffness"
							label="Stiffness"
							min={0}
							max={10}
							onFinishChange={() => setVehicle(scene, { id: vehicle.id, forwardFriction: structuredClone(settings.forwardFriction) }, { editor: this.props.editor })}
						/>
						<div className="px-2 pt-1 text-xs font-medium">Sideways Tire Friction</div>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.sidewaysFriction}
							property="extremumSlip"
							label="Peak Slip"
							min={0.001}
							max={Math.min(10, settings.sidewaysFriction.asymptoteSlip - 0.001)}
							onFinishChange={() =>
								setVehicle(scene, { id: vehicle.id, sidewaysFriction: structuredClone(settings.sidewaysFriction) }, { editor: this.props.editor })
							}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.sidewaysFriction}
							property="extremumValue"
							label="Peak Grip"
							min={0}
							max={10}
							onFinishChange={() =>
								setVehicle(scene, { id: vehicle.id, sidewaysFriction: structuredClone(settings.sidewaysFriction) }, { editor: this.props.editor })
							}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.sidewaysFriction}
							property="asymptoteSlip"
							label="Slide Slip"
							min={Math.max(0.001, settings.sidewaysFriction.extremumSlip + 0.001)}
							max={20}
							onFinishChange={() =>
								setVehicle(scene, { id: vehicle.id, sidewaysFriction: structuredClone(settings.sidewaysFriction) }, { editor: this.props.editor })
							}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.sidewaysFriction}
							property="asymptoteValue"
							label="Slide Grip"
							min={0}
							max={10}
							onFinishChange={() =>
								setVehicle(scene, { id: vehicle.id, sidewaysFriction: structuredClone(settings.sidewaysFriction) }, { editor: this.props.editor })
							}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings.sidewaysFriction}
							property="stiffness"
							label="Stiffness"
							min={0}
							max={10}
							onFinishChange={() =>
								setVehicle(scene, { id: vehicle.id, sidewaysFriction: structuredClone(settings.sidewaysFriction) }, { editor: this.props.editor })
							}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings}
							property="antiRollStiffness"
							label="Anti-roll Stiffness"
							min={0}
							max={1000000}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, antiRollStiffness: value }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings}
							property="maxAntiRollForce"
							label="Anti-roll Force Cap"
							min={0}
							max={1000000}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, maxAntiRollForce: value }, { editor: this.props.editor })}
						/>
					</>
				)}
			</>
		);
	}

	private _handleHasPhysicsAggregateChange(): void {
		try {
			const inspection = inspectGameObjectComponents(this.props.mesh.getScene(), { nodeId: this.props.mesh.id });
			const physics = inspection.components.find((component: any) => component.type === "physics3d");
			if (physics) {
				removeGameObjectComponent(
					this.props.mesh.getScene(),
					{ nodeId: this.props.mesh.id, expectedFingerprint: inspection.fingerprint, componentId: physics.id },
					{ editor: this.props.editor }
				);
			} else {
				addGameObjectComponent(
					this.props.mesh.getScene(),
					{ nodeId: this.props.mesh.id, expectedFingerprint: inspection.fingerprint, type: "physics3d" },
					{ editor: this.props.editor }
				);
			}
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getPhysicsInspector(aggregate: PhysicsAggregate): ReactNode {
		const material = aggregate.shape.material;
		const massProperties = aggregate.body.getMassProperties();

		const setMassProperties = (properties: Partial<PhysicsMassProperties>) => {
			aggregate.body.setMassProperties({
				...aggregate.body.getMassProperties(),
				...properties,
			});
		};

		return (
			<>
				<Divider />

				{this._getShapeTypeInspector(aggregate)}
				{this._getBodyMotionTypeInspeector(aggregate)}

				<Divider />

				{aggregate.body.getMotionType() !== PhysicsMotionType.STATIC && (
					<EditorInspectorNumberField
						noUndoRedo
						object={massProperties}
						property="mass"
						label="Mass"
						min={0}
						onFinishChange={(value, oldValue) => {
							registerUndoRedo({
								executeRedo: true,
								undo: () => setMassProperties({ mass: oldValue }),
								redo: () => setMassProperties({ mass: value }),
							});

							this.forceUpdate();
						}}
					/>
				)}

				<EditorInspectorNumberField object={material} property="friction" label="Friction" min={0} max={1} />
				<EditorInspectorNumberField object={material} property="restitution" label="Restitution" min={0} max={1} />
				{this._getCollisionFilterInspector(aggregate)}
			</>
		);
	}

	private _getCollisionFilterInspector(aggregate: PhysicsAggregate): ReactNode {
		const layers = getPhysicsCollisionLayers(this.props.mesh.getScene()).layers as IPhysicsCollisionLayer[];
		const filter = {
			collisionGroup: aggregate.shape.filterMembershipMask ?? 1,
			collisionMask: aggregate.shape.filterCollideMask ?? 0xffffffff,
			collisionLayer: this.props.mesh.metadata?.babylonEditorPhysicsCollisionLayer ?? "",
		};
		const setFilter = (group: number, mask: number): void => {
			setMeshPhysics(this.props.mesh.getScene(), { nodeId: this.props.mesh.id, collisionGroup: group, collisionMask: mask }, { editor: this.props.editor });
		};
		return (
			<>
				<Divider />
				{filter.collisionLayer && !layers.some((layer) => layer.name === filter.collisionLayer) && (
					<div className="px-2 text-xs text-destructive">Assigned layer no longer exists. Choose a layer or use custom masks.</div>
				)}
				<EditorInspectorListField
					noUndoRedo
					object={filter}
					property="collisionLayer"
					label="Collision Layer"
					items={layers.map((layer) => ({ text: layer.name, value: layer.name }))}
					onChange={(value) => setMeshPhysics(this.props.mesh.getScene(), { nodeId: this.props.mesh.id, collisionLayer: value }, { editor: this.props.editor })}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={filter}
					property="collisionGroup"
					label="Collision Group"
					min={0}
					step={1}
					onFinishChange={(value, oldValue) =>
						registerUndoRedo({ executeRedo: true, undo: () => setFilter(oldValue, filter.collisionMask), redo: () => setFilter(value, filter.collisionMask) })
					}
				/>
				<EditorInspectorNumberField
					noUndoRedo
					object={filter}
					property="collisionMask"
					label="Collision Mask"
					min={0}
					step={1}
					onFinishChange={(value, oldValue) =>
						registerUndoRedo({ executeRedo: true, undo: () => setFilter(filter.collisionGroup, oldValue), redo: () => setFilter(filter.collisionGroup, value) })
					}
				/>
			</>
		);
	}

	private _getShapeTypeInspector(aggregate: PhysicsAggregate): ReactNode {
		const o = {
			type: aggregate.shape.type,
		};

		const items: IEditorInspectorListFieldItem[] = [
			{ text: "Box", value: PhysicsShapeType.BOX },
			{ text: "Sphere", value: PhysicsShapeType.SPHERE },
			{ text: "Capsule", value: PhysicsShapeType.CAPSULE },
			{ text: "Cylinder", value: PhysicsShapeType.CYLINDER },
			{ text: "Mesh", value: PhysicsShapeType.MESH },
		];

		const configureShape = (value: PhysicsShapeType) => {
			let mesh: Mesh | undefined = undefined;
			if (isInstancedMesh(this.props.mesh)) {
				mesh = this.props.mesh.sourceMesh;
			} else if (isMesh(this.props.mesh)) {
				mesh = this.props.mesh;
			}

			aggregate.shape = new PhysicsShape(
				{
					type: value,
					parameters: {
						mesh: value === PhysicsShapeType.MESH ? mesh : undefined,
					},
				},
				this.props.mesh.getScene()
			);

			aggregate.body.disableSync = true;
		};

		return (
			<EditorInspectorListField
				noUndoRedo
				object={o}
				property="type"
				label="Shape Type"
				items={items}
				onChange={(value, oldValue) => {
					registerUndoRedo({
						executeRedo: true,
						undo: () => configureShape(oldValue),
						redo: () => configureShape(value),
					});
				}}
			/>
		);
	}

	private _getBodyMotionTypeInspeector(aggregate: PhysicsAggregate): ReactNode {
		const o = {
			type: aggregate.body.getMotionType(),
		};

		const configureMotionType = (value: PhysicsMotionType) => {
			aggregate.body.setMotionType(value);
			aggregate.body.disableSync = true;
		};

		return (
			<EditorInspectorListField
				noUndoRedo
				object={o}
				property="type"
				label="Shape Type"
				items={[
					{ text: "Static", value: PhysicsMotionType.STATIC },
					{ text: "Dynamic", value: PhysicsMotionType.DYNAMIC },
					{ text: "Animated", value: PhysicsMotionType.ANIMATED },
				]}
				onChange={(value, oldValue) => {
					registerUndoRedo({
						executeRedo: true,
						undo: () => configureMotionType(oldValue),
						redo: () => configureMotionType(value),
					});

					this.forceUpdate();
				}}
			/>
		);
	}
}
