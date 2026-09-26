import { Scene } from "@babylonjs/core/scene";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { KeyboardEventTypes } from "@babylonjs/core/Events/keyboardEvents";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { PhysicsEventType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { Observer } from "@babylonjs/core/Misc/observable";
import "@babylonjs/core/Particles/particleSystemComponent";

import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";
import { Control } from "@babylonjs/gui/2D/controls/control";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";

import { IScript, SoundNode, soundFromScene, visibleAsNumber } from "babylonjs-editor-tools";

import { GamePhase, gameEvents, gameState, setGamePhase } from "../game/state";

interface IResettable {
	mesh: AbstractMesh;
	position: Vector3;
	rotation: Quaternion;
	/** Physics settings captured at start so a crate's body can be rebuilt cleanly on restart. */
	physics?: { mass: number; friction: number; restitution: number };
	collisionObserver?: Observer<any> | null;
}

const bestTimeKey = "orb-rush-best-time";

/**
 * Orb Rush rules: collect every gem before the timer runs out. Owns the HUD, music, sound effects, and restarts.
 * Attached to the scene so it runs once regardless of how many gems and crates the level contains.
 */
export default class GameManager implements IScript {
	@visibleAsNumber("Time limit (s)", { min: 10, max: 600 })
	private _timeLimit: number = 100;

	@visibleAsNumber("Fall penalty (s)", { min: 0, max: 60 })
	private _fallPenalty: number = 5;

	@visibleAsNumber("Pickup radius (cm)", { min: 20, max: 400 })
	private _pickupRadius: number = 115;

	@soundFromScene("Music")
	private _music: SoundNode;
	@soundFromScene("SFX Pickup")
	private _pickupSound: SoundNode;
	@soundFromScene("SFX Jump")
	private _jumpSound: SoundNode;
	@soundFromScene("SFX Impact")
	private _impactSound: SoundNode;
	@soundFromScene("SFX Crate")
	private _crateSound: SoundNode;
	@soundFromScene("SFX Bump")
	private _bumpSound: SoundNode;
	@soundFromScene("SFX Tick")
	private _tickSound: SoundNode;
	@soundFromScene("SFX Start")
	private _startSound: SoundNode;
	@soundFromScene("SFX Win")
	private _winSound: SoundNode;
	@soundFromScene("SFX Lose")
	private _loseSound: SoundNode;

	private _player: AbstractMesh | null = null;
	private _gems: IResettable[] = [];
	private _crates: IResettable[] = [];
	private _collected = new Set<AbstractMesh>();
	private _timeLeft: number = 0;
	private _elapsed: number = 0;
	private _lastTickSecond: number = -1;
	private _lastCrateSound: number = 0;
	private _bestTime: number | null = null;
	private _burst: ParticleSystem | null = null;
	private _observers: Observer<any>[] = [];

	private _hud!: AdvancedDynamicTexture;
	private _gemText!: TextBlock;
	private _timeText!: TextBlock;
	private _panel!: Rectangle;
	private _titleText!: TextBlock;
	private _subtitleText!: TextBlock;
	private _promptText!: TextBlock;

	public constructor(public scene: Scene) {}

	public onStart(): void {
		this._player = this.scene.getMeshByName("Player");
		this._gems = this._collect((mesh) => mesh.name.startsWith("Gem"));
		this._crates = this._collect((mesh) => mesh.name.startsWith("Crate") && !!mesh.physicsBody);
		this._bestTime = this._readBestTime();

		this._createHud();
		this._createBurst();
		this._listenToCrates();

		this._observers.push(
			gameEvents.jumped.add(() => this._play(this._jumpSound, 0.55)),
			gameEvents.playerImpact.add((impact) => {
				if (impact.hazard) {
					this._play(this._bumpSound, 0.9);
				} else {
					this._play(this._impactSound, Math.min(1, impact.strength / 1300), 0.9 + Math.random() * 0.2);
				}
			}),
			gameEvents.playerFell.add(() => {
				this._play(this._bumpSound, 0.7, 0.6);
				if (gameState.phase === "playing") {
					this._timeLeft = Math.max(0, this._timeLeft - this._fallPenalty);
					this._flash(`-${this._fallPenalty}s`);
				}
			}),
			this.scene.onKeyboardObservable.add((info) => {
				if (info.type !== KeyboardEventTypes.KEYDOWN) {
					return;
				}
				if (info.event.code === "Enter" || (info.event.code === "Space" && gameState.phase !== "playing")) {
					this._startIfIdle();
				} else if (info.event.code === "KeyR" && gameState.phase === "playing") {
					this._startRun();
				}
			}),
			this.scene.onPointerObservable.add((info) => {
				if (info.type === PointerEventTypes.POINTERTAP) {
					this._startIfIdle();
				}
			})
		);

		setGamePhase("title");
		this._showPanel(
			"ORB RUSH",
			`Collect all ${this._gems.length} gems before time runs out.\nWASD / Arrows to roll · Space to jump · Drag or Q/E to look`,
			"Press ENTER or tap to start"
		);
	}

	public onUpdate(): void {
		const deltaSeconds = Math.min(this.scene.getEngine().getDeltaTime() / 1000, 0.05);
		this._elapsed += deltaSeconds;

		// Gems spin and bob so they read as pickups from a distance.
		this._gems.forEach((gem, index) => {
			if (this._collected.has(gem.mesh)) {
				return;
			}
			gem.mesh.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), this._elapsed * 2 + index).multiply(gem.rotation);
			gem.mesh.position.y = gem.position.y + Math.sin(this._elapsed * 3 + index) * 12;
		});

		if (gameState.phase !== "playing" || !this._player) {
			return;
		}

		this._timeLeft = Math.max(0, this._timeLeft - deltaSeconds);

		const playerPosition = this._player.getAbsolutePosition();
		for (const gem of this._gems) {
			if (!this._collected.has(gem.mesh) && Vector3.Distance(playerPosition, gem.mesh.getAbsolutePosition()) < this._pickupRadius) {
				this._collectGem(gem.mesh);
			}
		}

		const second = Math.ceil(this._timeLeft);
		if (second <= 10 && second !== this._lastTickSecond && this._timeLeft > 0) {
			this._lastTickSecond = second;
			this._play(this._tickSound, 0.6, second <= 3 ? 1.3 : 1);
		}

		if (this._collected.size === this._gems.length) {
			this._finish(true);
		} else if (this._timeLeft <= 0) {
			this._finish(false);
		}

		this._updateHud();
	}

	public onStop(): void {
		this._observers.forEach((observer) => observer.remove());
		this._observers = [];
		this._crates.forEach((crate) => crate.collisionObserver?.remove());
		this._hud?.dispose();
		this._burst?.dispose();
	}

	private _collect(predicate: (mesh: AbstractMesh) => boolean): IResettable[] {
		return this.scene.meshes.filter(predicate).map((mesh) => {
			const body = mesh.physicsBody;
			const material = body?.shape?.material;
			return {
				mesh,
				position: mesh.position.clone(),
				rotation: mesh.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(mesh.rotation),
				physics: body ? { mass: body.getMassProperties().mass ?? 1, friction: material?.friction ?? 0.5, restitution: material?.restitution ?? 0 } : undefined,
			};
		});
	}

	private _startIfIdle(): void {
		if (gameState.phase !== "playing") {
			this._startRun();
		}
	}

	private _startRun(): void {
		// Audio can only start after a user gesture; starting a run is always one.
		if (this._music && !this._music.isPlaying()) {
			this._music.play({ loop: true, volume: 0.35 });
		}
		this._play(this._startSound, 0.7);

		this._collected.clear();
		this._gems.forEach((gem) => gem.mesh.setEnabled(true));
		this._crates.forEach((crate) => this._resetCrate(crate));
		gameEvents.resetRequested.notifyObservers();

		this._timeLeft = this._timeLimit;
		this._lastTickSecond = -1;
		this._panel.isVisible = false;
		setGamePhase("playing");
		this._updateHud();
	}

	private _collectGem(gem: AbstractMesh): void {
		this._collected.add(gem);
		gem.setEnabled(false);
		this._play(this._pickupSound, 0.8, 1 + this._collected.size * 0.03);

		if (this._burst) {
			this._burst.emitter = gem.getAbsolutePosition().clone();
			this._burst.manualEmitCount = 40;
			this._burst.start();
		}
	}

	private _finish(won: boolean): void {
		setGamePhase(won ? "won" : "lost");
		this._updateHud();

		if (won) {
			const time = this._timeLimit - this._timeLeft;
			const isBest = this._bestTime === null || time < this._bestTime;
			if (isBest) {
				this._bestTime = time;
				this._writeBestTime(time);
			}
			this._play(this._winSound, 0.9);
			this._showPanel(
				"YOU WIN!",
				`All gems in ${this._formatTime(time)}${isBest ? " — new best!" : `\nBest: ${this._formatTime(this._bestTime!)}`}`,
				"Press ENTER or tap to play again"
			);
		} else {
			this._play(this._loseSound, 0.9);
			this._showPanel("TIME UP", `You collected ${this._collected.size} of ${this._gems.length} gems.`, "Press ENTER or tap to try again");
		}
	}

	/**
	 * Restores a crate to its start pose with a freshly created physics body. Teleporting a live dynamic body inside a
	 * stack keeps stale contacts and velocities, which can launch crates; rebuilding the body starts it at rest.
	 */
	private _resetCrate(crate: IResettable): void {
		if (!crate.physics) {
			return;
		}

		crate.collisionObserver?.remove();
		const body = crate.mesh.physicsBody;
		const shape = body?.shape;
		body?.dispose();
		shape?.dispose();

		crate.mesh.position.copyFrom(crate.position);
		crate.mesh.rotationQuaternion = crate.rotation.clone();
		crate.mesh.computeWorldMatrix(true);

		new PhysicsAggregate(crate.mesh, PhysicsShapeType.BOX, crate.physics, this.scene);
		this._watchCrate(crate);
	}

	private _listenToCrates(): void {
		this._crates.forEach((crate) => this._watchCrate(crate));
	}

	/** Plays a positional impact sound when a crate hits something hard enough. */
	private _watchCrate(crate: IResettable): void {
		const body = crate.mesh.physicsBody;
		if (!body) {
			return;
		}

		body.setCollisionCallbackEnabled(true);
		crate.collisionObserver = body.getCollisionObservable().add((event) => {
			if (event.type !== PhysicsEventType.COLLISION_STARTED || gameState.phase !== "playing") {
				return;
			}
			const speed = body.getLinearVelocity().length();
			const now = performance.now();
			if (speed > 250 && now - this._lastCrateSound > 70 && this._crateSound) {
				this._lastCrateSound = now;
				this._crateSound.position.copyFrom(crate.mesh.getAbsolutePosition());
				this._play(this._crateSound, Math.min(1, speed / 1000), 0.8 + Math.random() * 0.3);
			}
		});
	}

	private _play(sound: SoundNode | undefined, volume: number, playbackRate: number = 1): void {
		if (!sound?.sound) {
			return;
		}
		sound.playbackRate = playbackRate;
		sound.play({ volume });
	}

	private _createBurst(): void {
		const texture = new DynamicTexture("gem-spark", 64, this.scene, false);
		const context = texture.getContext();
		const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
		gradient.addColorStop(0, "rgba(255,255,255,1)");
		gradient.addColorStop(0.4, "rgba(255,220,120,0.9)");
		gradient.addColorStop(1, "rgba(255,160,0,0)");
		context.fillStyle = gradient;
		context.fillRect(0, 0, 64, 64);
		texture.hasAlpha = true;
		texture.update();

		const burst = new ParticleSystem("gem-burst", 200, this.scene);
		burst.particleTexture = texture;
		burst.createSphereEmitter(20);
		burst.minSize = 12;
		burst.maxSize = 30;
		burst.minLifeTime = 0.3;
		burst.maxLifeTime = 0.7;
		burst.minEmitPower = 250;
		burst.maxEmitPower = 600;
		burst.gravity = new Vector3(0, -900, 0);
		burst.color1 = new Color4(1, 0.9, 0.4, 1);
		burst.color2 = new Color4(1, 0.6, 0.1, 1);
		burst.colorDead = new Color4(1, 0.3, 0, 0);
		burst.blendMode = ParticleSystem.BLENDMODE_ADD;
		burst.emitRate = 0;
		burst.targetStopDuration = 0;
		this._burst = burst;
	}

	private _createHud(): void {
		this._hud = AdvancedDynamicTexture.CreateFullscreenUI("HUD", true, this.scene);
		this._hud.idealHeight = 900;

		const text = (value: string, size: number, color: string = "white"): TextBlock => {
			const block = new TextBlock(undefined, value);
			block.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
			block.fontSize = size;
			block.fontWeight = "700";
			block.color = color;
			block.outlineWidth = 4;
			block.outlineColor = "#0b1026";
			block.resizeToFit = true;
			return block;
		};

		this._gemText = text("", 34, "#ffd35c");
		this._gemText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		this._gemText.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		this._gemText.left = "28px";
		this._gemText.top = "20px";
		this._hud.addControl(this._gemText);

		this._timeText = text("", 34);
		this._timeText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		this._timeText.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		this._timeText.left = "-28px";
		this._timeText.top = "20px";
		this._hud.addControl(this._timeText);

		this._panel = new Rectangle("panel");
		this._panel.width = "760px";
		this._panel.height = "330px";
		this._panel.cornerRadius = 24;
		this._panel.thickness = 0;
		this._panel.background = "#0b1026cc";
		this._hud.addControl(this._panel);

		const stack = new StackPanel();
		stack.spacing = 14;
		this._panel.addControl(stack);

		this._titleText = text("", 72, "#7df9ff");
		this._subtitleText = text("", 26, "#e8ecff");
		this._subtitleText.textWrapping = true;
		this._subtitleText.lineSpacing = "6px";
		this._promptText = text("", 28, "#ffd35c");
		[this._titleText, this._subtitleText, this._promptText].forEach((control) => stack.addControl(control));

		this._updateHud();
	}

	private _showPanel(title: string, subtitle: string, prompt: string): void {
		this._titleText.text = title;
		this._subtitleText.text = subtitle;
		this._promptText.text = prompt;
		this._panel.isVisible = true;
	}

	private _flash(message: string): void {
		const block = new TextBlock(undefined, message);
		block.fontSize = 48;
		block.fontWeight = "700";
		block.color = "#ff6b6b";
		block.outlineWidth = 4;
		block.outlineColor = "#0b1026";
		block.top = "-120px";
		this._hud.addControl(block);
		setTimeout(() => block.dispose(), 900);
	}

	private _updateHud(): void {
		const phase: GamePhase = gameState.phase;
		this._gemText.text = `◆ ${this._collected.size} / ${this._gems.length}`;
		this._timeText.text = phase === "title" ? (this._bestTime !== null ? `Best ${this._formatTime(this._bestTime)}` : "") : `⏱ ${this._formatTime(this._timeLeft)}`;
		this._timeText.color = phase === "playing" && this._timeLeft <= 10 ? "#ff6b6b" : "white";
	}

	private _formatTime(seconds: number): string {
		const clamped = Math.max(0, seconds);
		const minutes = Math.floor(clamped / 60);
		const rest = clamped - minutes * 60;
		return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
	}

	private _readBestTime(): number | null {
		try {
			const value = Number(localStorage.getItem(bestTimeKey));
			return Number.isFinite(value) && value > 0 ? value : null;
		} catch {
			return null;
		}
	}

	private _writeBestTime(value: number): void {
		try {
			localStorage.setItem(bestTimeKey, String(value));
		} catch {
			// Storage can be unavailable (private mode, embedded iframes); the best time then lasts for the session only.
		}
	}
}
