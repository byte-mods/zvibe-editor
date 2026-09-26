import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";

import { IScript, visibleAsNumber } from "babylonjs-editor-tools";

/**
 * Rotates an animated (kinematic) physics body around the world Y axis.
 * Uses `setTargetTransform` so Havok derives a velocity for the body and pushes dynamic objects correctly.
 */
export default class Spinner implements IScript {
	@visibleAsNumber("Speed (rad/s)", { min: -6, max: 6 })
	private _speed: number = 1.1;

	private _angle: number = 0;
	private _baseRotation: Quaternion = Quaternion.Identity();
	private _observer: Observer<Scene> | null = null;

	public constructor(public mesh: Mesh) {}

	public onStart(): void {
		this._baseRotation = this.mesh.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(this.mesh.rotation);
		// Drive the kinematic body once per physics step so its velocity (and the push it gives) is correct with sub-stepping.
		this._observer = this.mesh.getScene().onBeforePhysicsObservable.add((scene) => this._step(scene));
	}

	public onStop(): void {
		this._observer?.remove();
		this._observer = null;
	}

	private _step(scene: Scene): void {
		const physics = scene.getPhysicsEngine();
		const subStep = physics?.getSubTimeStep?.() ?? 0;
		const deltaSeconds = subStep > 0 ? subStep / 1000 : Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
		this._angle += this._speed * deltaSeconds;

		const rotation = Quaternion.RotationAxis(Vector3.Up(), this._angle).multiply(this._baseRotation);
		const body = this.mesh.physicsBody;
		if (body) {
			body.setTargetTransform(this.mesh.absolutePosition, rotation);
		} else {
			this.mesh.rotationQuaternion = rotation;
		}
	}
}
