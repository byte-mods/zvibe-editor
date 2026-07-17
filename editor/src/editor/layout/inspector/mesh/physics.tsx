import { shell } from "electron";

import { Component, ReactNode } from "react";

import { Divider } from "@blueprintjs/core";

import { AbstractMesh, PhysicsAggregate, PhysicsShape, PhysicsShapeType, PhysicsMotionType, PhysicsMassProperties, Mesh } from "babylonjs";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { getPhysicsShapeForMesh } from "../../../../tools/physics/shape";
import { isInstancedMesh, isMesh } from "../../../../tools/guards/nodes";

import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSectionField } from "../fields/section";
import { EditorInspectorListField, IEditorInspectorListFieldItem } from "../fields/list";
import { Button } from "../../../../ui/shadcn/ui/button";

import { setMeshPhysics } from "../../../../mcp/meshes/meshes";
import { getPhysicsCollisionLayers, IPhysicsCollisionLayer } from "../../../../mcp/scene/scene";
import { createDefaultVehicleWheels, createVehicle, deleteVehicle, listVehicles, setVehicle, setVehicleWheels } from "../../../../mcp/physics/vehicles";
import { listInputActionMaps } from "../../../../mcp/input/input";
import { Editor } from "../../../main";

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
				<EditorInspectorSwitchField object={o} property="hasPhysicsBody" label="Enabled" noUndoRedo onChange={() => this._handleHasPhysicsAggregateChange()} />

				{this.props.mesh.physicsAggregate && this._getPhysicsInspector(this.props.mesh.physicsAggregate)}
				{this.props.mesh.physicsAggregate && this._getVehicleControllerInspector()}
			</EditorInspectorSectionField>
		);
	}

	private _getVehicleControllerInspector(): ReactNode {
		const scene = this.props.mesh.getScene();
		const vehicle = listVehicles(scene).vehicles.find((candidate: any) => candidate.chassisNodeId === this.props.mesh.id);
		const inputMaps = listInputActionMaps(scene).maps;
		const settings = vehicle
			? {
					enabled: vehicle.enabled,
					actionMapName: vehicle.actionMapName ?? "",
					maxEngineForce: vehicle.maxEngineForce,
					maxBrakeForce: vehicle.maxBrakeForce,
					maxSpeed: vehicle.maxSpeed,
					maxSteerAngle: vehicle.maxSteerAngle,
					wheelBase: vehicle.wheelBase,
					lateralGrip: vehicle.lateralGrip,
				}
			: null;
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
							<span>
								{vehicle.wheels?.length ?? 0} wheels · {Object.values(vehicle.wheelStates ?? {}).filter((state: any) => state.grounded).length} grounded
							</span>
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
							items={[{ text: "None (script/MCP)", value: "" }, ...inputMaps.map((map: any) => ({ text: map.name, value: map.name }))]}
							onChange={(value) => setVehicle(scene, { id: vehicle.id, actionMapName: value || null }, { editor: this.props.editor })}
						/>
						<EditorInspectorNumberField
							noUndoRedo
							object={settings}
							property="maxEngineForce"
							label="Engine Force"
							min={0}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, maxEngineForce: value }, { editor: this.props.editor })}
						/>
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
							label="Lateral Grip"
							min={0}
							onFinishChange={(value) => setVehicle(scene, { id: vehicle.id, lateralGrip: value }, { editor: this.props.editor })}
						/>
					</>
				)}
			</>
		);
	}

	private _handleHasPhysicsAggregateChange(): void {
		const aggregate = this.props.mesh.physicsAggregate;

		registerUndoRedo({
			executeRedo: true,
			undo: () => {
				this.props.mesh.physicsAggregate = aggregate;
				this.props.mesh.physicsBody = aggregate?.body ?? null;
			},
			redo: () => {
				if (aggregate) {
					this.props.mesh.physicsBody = null;
					this.props.mesh.physicsAggregate = null;

					if (this.props.mesh.metadata.physicsAggregate) {
						delete this.props.mesh.metadata.physicsAggregate;
					}
				} else {
					const aggregate = new PhysicsAggregate(this.props.mesh, getPhysicsShapeForMesh(this.props.mesh), {
						mass: 1,
					});
					aggregate.body.disableSync = true;

					this.props.mesh.physicsAggregate = aggregate;
				}
			},
		});

		this.forceUpdate();
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
