import { Observable } from "@babylonjs/core/Misc/observable";

/**
 * Shared game state for Orb Rush. Scripts communicate through these observables instead of
 * looking each other up, so every behavior stays independent and reusable.
 */
export type GamePhase = "title" | "playing" | "won" | "lost";

export interface IPlayerImpact {
	/** Speed (cm/s) along the contact normal at the moment of impact. */
	strength: number;
	/** Whether the player was hit by a hazard (spinning sweeper). */
	hazard: boolean;
}

export const gameState = {
	phase: "title" as GamePhase,
};

export const gameEvents = {
	/** Raised when the phase changes (title → playing → won/lost → playing ...). */
	phaseChanged: new Observable<GamePhase>(),
	/** Raised when the player jumps. */
	jumped: new Observable<void>(),
	/** Raised when the player hits something hard enough to be heard. */
	playerImpact: new Observable<IPlayerImpact>(),
	/** Raised when the player falls off the arena and is respawned. */
	playerFell: new Observable<void>(),
	/** Raised by the game manager to reset every dynamic object before a new run. */
	resetRequested: new Observable<void>(),
};

export function setGamePhase(phase: GamePhase): void {
	if (gameState.phase === phase) {
		return;
	}

	gameState.phase = phase;
	gameEvents.phaseChanged.notifyObservers(phase);
}
