import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { KeyboardEventTypes } from "@babylonjs/core/Events/keyboardEvents";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { Observer } from "@babylonjs/core/Misc/observable";

import { IScript, nodeFromScene, visibleAsNumber } from "babylonjs-editor-tools";

/**
 * Third-person chase camera. Orbit with mouse drag, Q/E, or by dragging on the right half of a touch screen.
 * Replaces the camera's built-in free-fly inputs so movement keys only drive the player.
 */
export default class FollowCamera implements IScript {
	@nodeFromScene("Player")
	private _target: TransformNode;

	@visibleAsNumber("Distance (cm)", { min: 200, max: 3000 })
	private _distance: number = 850;

	@visibleAsNumber("Height (cm)", { min: 0, max: 2000 })
	private _height: number = 430;

	@visibleAsNumber("Follow sharpness", { min: 0.5, max: 20 })
	private _sharpness: number = 6;

	@visibleAsNumber("Arena limit (cm)", { min: 0, max: 100000 })
	private _arenaLimit: number = 2120;

	private _yaw: number = 0;
	private _drag: { id: number; x: number } | null = null;
	private readonly _keys = new Set<string>();
	private _observers: Observer<any>[] = [];

	public constructor(public camera: TargetCamera) {}

	public onStart(): void {
		const scene = this.camera.getScene();

		// The template attaches camera controls after loading; clearing the inputs keeps WASD/arrows for the player.
		(this.camera as any).inputs?.clear();
		scene.activeCamera = this.camera;

		if (this._target) {
			// Start behind the player, looking the same way the authored camera looked.
			const toCamera = this.camera.position.subtract(this._target.getAbsolutePosition());
			this._yaw = Math.atan2(toCamera.x, toCamera.z);
		}

		this._observers.push(
			scene.onPointerObservable.add((info) => {
				const event = info.event as PointerEvent;
				const width = scene.getEngine().getRenderWidth(true) / (window.devicePixelRatio || 1);
				if (info.type === PointerEventTypes.POINTERDOWN && (event.pointerType === "mouse" || event.clientX >= width * 0.5)) {
					this._drag = { id: event.pointerId, x: event.clientX };
				} else if (info.type === PointerEventTypes.POINTERMOVE && this._drag?.id === event.pointerId) {
					this._yaw -= (event.clientX - this._drag.x) * 0.006;
					this._drag.x = event.clientX;
				} else if (info.type === PointerEventTypes.POINTERUP && this._drag?.id === event.pointerId) {
					this._drag = null;
				}
			})
		);

		this._observers.push(
			scene.onKeyboardObservable.add((info) => {
				if (info.type === KeyboardEventTypes.KEYDOWN) {
					this._keys.add(info.event.code);
				} else {
					this._keys.delete(info.event.code);
				}
			})
		);
	}

	public onUpdate(): void {
		if (!this._target) {
			return;
		}

		const deltaSeconds = Math.min(this.camera.getScene().getEngine().getDeltaTime() / 1000, 0.05);
		if (this._keys.has("KeyQ")) {
			this._yaw += 2.2 * deltaSeconds;
		}
		if (this._keys.has("KeyE")) {
			this._yaw -= 2.2 * deltaSeconds;
		}

		const target = this._target.getAbsolutePosition();
		const desired = new Vector3(target.x + Math.sin(this._yaw) * this._distance, target.y + this._height, target.z + Math.cos(this._yaw) * this._distance);
		// Keep the camera inside the arena walls so they never block the view of the orb.
		desired.x = Scalar.Clamp(desired.x, -this._arenaLimit, this._arenaLimit);
		desired.z = Scalar.Clamp(desired.z, -this._arenaLimit, this._arenaLimit);

		const blend = 1 - Math.exp(-this._sharpness * deltaSeconds);
		this.camera.position = Vector3.Lerp(this.camera.position, desired, blend);
		this.camera.position.y = Math.max(this.camera.position.y, Scalar.Lerp(target.y, desired.y, 0.5));
		this.camera.setTarget(target.add(new Vector3(0, 60, 0)));
	}

	public onStop(): void {
		this._observers.forEach((observer) => observer.remove());
		this._observers = [];
	}
}
