import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Quaternion, Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { KeyboardEventTypes } from "@babylonjs/core/Events/keyboardEvents";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { IPhysicsCollisionEvent, PhysicsEventType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsEngine } from "@babylonjs/core/Physics/v2/physicsEngine";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult";
import { Observer } from "@babylonjs/core/Misc/observable";

import { IScript, visibleAsNumber } from "babylonjs-editor-tools";

import { gameEvents, gameState } from "../game/state";

/**
 * Rolls the player orb with keyboard (WASD / arrows + Space) or touch (drag on the left half of the screen, tap to jump).
 * Movement is relative to the active camera and applied as physics forces so the orb interacts naturally with crates and hazards.
 */
export default class PlayerController implements IScript {
	@visibleAsNumber("Acceleration (cm/s²)", { min: 200, max: 5000 })
	private _acceleration: number = 1500;

	@visibleAsNumber("Max speed (cm/s)", { min: 200, max: 4000 })
	private _maxSpeed: number = 1100;

	@visibleAsNumber("Jump speed (cm/s)", { min: 100, max: 2000 })
	private _jumpSpeed: number = 620;

	@visibleAsNumber("Air control", { min: 0, max: 1 })
	private _airControl: number = 0.45;

	@visibleAsNumber("Respawn below (cm)", { min: -5000, max: 0 })
	private _killHeight: number = -600;

	private readonly _keys = new Set<string>();
	private readonly _touchMove = new Vector2(0, 0);
	private _touchStart: { id: number; x: number; y: number; time: number } | null = null;
	private _jumpRequested: boolean = false;
	private _groundedTimer: number = 0;
	private _lastImpactTime: number = 0;
	private _previousVelocity: Vector3 = Vector3.Zero();
	private _spawnPosition: Vector3 = Vector3.Zero();
	private _spawnRotation: Quaternion = Quaternion.Identity();
	private _teleportFrames: number = 0;
	private _body: PhysicsBody | null = null;
	private readonly _groundRay = new PhysicsRaycastResult();
	private readonly _moveDirection = Vector3.Zero();
	private _observers: Observer<any>[] = [];

	public constructor(public mesh: Mesh) {}

	public onStart(): void {
		const scene = this.mesh.getScene();

		this._spawnPosition = this.mesh.position.clone();
		this._spawnRotation = this.mesh.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(this.mesh.rotation);

		this._body = this.mesh.physicsBody ?? null;
		if (this._body) {
			this._body.setLinearDamping(0.25);
			this._body.setAngularDamping(1.2);
			this._body.setCollisionCallbackEnabled(true);
			this._observers.push(this._body.getCollisionObservable().add((event) => this._onCollision(event)));
		}

		this._observers.push(
			scene.onKeyboardObservable.add((info) => {
				const key = info.event.code;
				if (info.type === KeyboardEventTypes.KEYDOWN) {
					if (key === "Space" && !this._keys.has(key)) {
						this._jumpRequested = true;
					}
					this._keys.add(key);
				} else {
					this._keys.delete(key);
				}
			})
		);

		this._observers.push(
			scene.onPointerObservable.add((info) => {
				const event = info.event as PointerEvent;
				if (event.pointerType !== "touch") {
					return;
				}

				const width = scene.getEngine().getRenderWidth(true) / (window.devicePixelRatio || 1);
				if (info.type === PointerEventTypes.POINTERDOWN) {
					if (event.clientX < width * 0.5 && !this._touchStart) {
						this._touchStart = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
					} else if (event.clientX >= width * 0.5) {
						this._jumpRequested = true;
					}
				} else if (info.type === PointerEventTypes.POINTERMOVE && this._touchStart?.id === event.pointerId) {
					this._touchMove.set((event.clientX - this._touchStart.x) / 70, (this._touchStart.y - event.clientY) / 70);
					if (this._touchMove.length() > 1) {
						this._touchMove.normalize();
					}
				} else if (info.type === PointerEventTypes.POINTERUP && this._touchStart?.id === event.pointerId) {
					this._touchStart = null;
					this._touchMove.set(0, 0);
				}
			})
		);

		this._observers.push(gameEvents.resetRequested.add(() => this._respawn()));
		this._observers.push(scene.onBeforePhysicsObservable.add(() => this._applyMovement()));
	}

	public onUpdate(): void {
		const body = this._body;
		if (!body) {
			return;
		}

		const scene = this.mesh.getScene();
		const deltaSeconds = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
		this._groundedTimer = Math.max(0, this._groundedTimer - deltaSeconds);

		if (this._teleportFrames > 0 && --this._teleportFrames === 0) {
			// Velocity accumulated while pinned by the pre-step must not carry over into the respawn.
			body.disablePreStep = true;
			body.setLinearVelocity(Vector3.Zero());
			body.setAngularVelocity(Vector3.Zero());
		}

		const velocity = body.getLinearVelocity();
		this._previousVelocity.copyFrom(velocity);

		// Resting contacts stop producing collision-start events, so also probe straight down for ground under the orb.
		const physicsEngine = scene.getPhysicsEngine() as PhysicsEngine | null;
		if (physicsEngine?.raycastToRef) {
			const radius = this.mesh.getBoundingInfo().boundingSphere.radiusWorld;
			const from = this.mesh.absolutePosition;
			physicsEngine.raycastToRef(from, from.add(new Vector3(0, -(radius + 12), 0)), this._groundRay, { ignoreBody: body });
			if (this._groundRay.hasHit) {
				this._groundedTimer = Math.max(this._groundedTimer, 0.1);
			}
		}

		if (this.mesh.absolutePosition.y < this._killHeight) {
			gameEvents.playerFell.notifyObservers();
			this._respawn();
			return;
		}

		if (gameState.phase !== "playing") {
			this._jumpRequested = false;
			return;
		}

		// Movement is sampled per frame but applied per physics step (see _applyMovement), because a force only lasts one step.
		const input = this._readInput();
		this._moveDirection.setAll(0);
		if (input.lengthSquared() > 0) {
			const camera = scene.activeCamera;
			const forward = camera ? camera.getDirection(Vector3.Forward()) : Vector3.Forward();
			forward.y = 0;
			forward.normalize();
			const right = Vector3.Cross(Vector3.Up(), forward).normalize();
			this._moveDirection.copyFrom(forward.scale(input.y).addInPlace(right.scale(input.x)));
		}

		if (this._jumpRequested) {
			this._jumpRequested = false;
			if (this._groundedTimer > 0) {
				this._groundedTimer = 0;
				body.setLinearVelocity(new Vector3(velocity.x, this._jumpSpeed, velocity.z));
				gameEvents.jumped.notifyObservers();
			}
		}
	}

	public onStop(): void {
		this._observers.forEach((observer) => observer.remove());
		this._observers = [];
	}

	private _applyMovement(): void {
		const body = this._body;
		if (!body || gameState.phase !== "playing" || this._moveDirection.lengthSquared() === 0 || this._teleportFrames > 0) {
			return;
		}

		const velocity = body.getLinearVelocity();
		const direction = this._moveDirection.clone().normalize();
		const speedAlongDirection = velocity.x * direction.x + velocity.z * direction.z;
		if (speedAlongDirection < this._maxSpeed) {
			const control = this._groundedTimer > 0 ? 1 : this._airControl;
			const mass = body.getMassProperties().mass ?? 1;
			body.applyForce(this._moveDirection.scale(this._acceleration * mass * control), this.mesh.getAbsolutePosition());
		}
	}

	private _readInput(): Vector2 {
		const input = this._touchMove.clone();
		if (this._keys.has("KeyW") || this._keys.has("ArrowUp")) {
			input.y += 1;
		}
		if (this._keys.has("KeyS") || this._keys.has("ArrowDown")) {
			input.y -= 1;
		}
		if (this._keys.has("KeyD") || this._keys.has("ArrowRight")) {
			input.x += 1;
		}
		if (this._keys.has("KeyA") || this._keys.has("ArrowLeft")) {
			input.x -= 1;
		}
		return input.length() > 1 ? input.normalize() : input;
	}

	private _onCollision(event: IPhysicsCollisionEvent): void {
		const radius = this.mesh.getBoundingInfo().boundingSphere.radiusWorld;
		const other = event.collidedAgainst?.transformNode;
		const hazard = !!other?.name.startsWith("Sweeper");

		// A contact point in the lower part of the orb means we are standing on something we can jump from.
		if (event.point && event.point.y < this.mesh.absolutePosition.y - radius * 0.5) {
			this._groundedTimer = 0.15;
		}

		if (event.type !== PhysicsEventType.COLLISION_STARTED) {
			return;
		}

		const normal = event.normal ?? Vector3.Up();
		const strength = Math.abs(Vector3.Dot(this._previousVelocity, normal));
		const now = performance.now();

		if (hazard && this._body) {
			// Sweepers knock the orb away from the arm and slightly upwards.
			const away = this.mesh.absolutePosition.subtract(other!.getAbsolutePosition());
			away.y = 0;
			away.normalize().scaleInPlace(900).addInPlaceFromFloats(0, 350, 0);
			this._body.setLinearVelocity(away);
		}

		if ((strength > 220 || hazard) && now - this._lastImpactTime > 90) {
			this._lastImpactTime = now;
			gameEvents.playerImpact.notifyObservers({ strength: hazard ? Math.max(strength, 900) : strength, hazard });
		}
	}

	private _respawn(): void {
		const body = this._body;
		if (!body) {
			return;
		}

		body.disablePreStep = false;
		this.mesh.position.copyFrom(this._spawnPosition);
		this.mesh.rotationQuaternion = this._spawnRotation.clone();
		body.setLinearVelocity(Vector3.Zero());
		body.setAngularVelocity(Vector3.Zero());
		// Let the physics pre-step pick up the teleport before handing the transform back to the simulation.
		this._teleportFrames = 2;
	}
}
