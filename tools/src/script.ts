export type AnimatorStateLifecyclePhase = "enter" | "update" | "exit";
export type AnimatorStateMachineLifecyclePhase = "machineEnter" | "machineExit";

/** Read-only Unity-style state lifecycle information supplied to behaviour scripts. */
export interface IAnimatorStateInfo {
	controllerId: string;
	controllerName: string;
	layerName: string | null;
	stateName: string;
	sourceStateName: string;
	machinePath: string[];
	subgraphId: string | null;
	phase: AnimatorStateLifecyclePhase;
	elapsedSeconds: number;
	normalizedTime: number;
	deltaSeconds: number;
	interrupted: boolean;
}

/** Read-only Unity-style state-machine boundary information supplied to behaviour scripts. */
export interface IAnimatorStateMachineInfo {
	controllerId: string;
	controllerName: string;
	layerName: string | null;
	machinePath: string[];
	phase: AnimatorStateMachineLifecyclePhase;
	interrupted: boolean;
}

/** Read-only Unity-style per-layer IK Pass information supplied after Animator sampling. */
export interface IAnimatorIKInfo {
	controllerId: string;
	controllerName: string;
	layerName: string;
	layerWeight: number;
	stateName: string;
	sourceStateName: string;
	machinePath: string[];
	subgraphId: string | null;
	elapsedSeconds: number;
	normalizedTime: number;
	deltaSeconds: number;
}

/**
 * Defines the interface that can be implemented by scripts attached to nodes in the editor.
 */
export interface IScript {
	/**
	 * Method called when the script starts. This method is called only once.
	 */
	onStart?(object: any): void;

	/**
	 * Method called on each frame.
	 */
	onUpdate?(object: any): void;

	/** Called when an Animator state carrying this behaviour starts evaluating. */
	onAnimatorStateEnter?(object: any, state: IAnimatorStateInfo): void;

	/** Called once per Animator update while a state carrying this behaviour is active. */
	onAnimatorStateUpdate?(object: any, state: IAnimatorStateInfo): void;

	/** Called when an Animator state carrying this behaviour stops evaluating. */
	onAnimatorStateExit?(object: any, state: IAnimatorStateInfo): void;

	/** Called when evaluation enters a root or nested Animator state-machine boundary. */
	onAnimatorStateMachineEnter?(object: any, machine: IAnimatorStateMachineInfo): void;

	/** Called when evaluation exits a root or nested Animator state-machine boundary. */
	onAnimatorStateMachineExit?(object: any, machine: IAnimatorStateMachineInfo): void;

	/** Called once per Animator update for every active layer whose IK Pass setting is enabled. */
	onAnimatorIK?(object: any, info: IAnimatorIKInfo): void;

	/**
	 * Method called on the script is stopped or the object is disposed.
	 */
	onStop?(object: any): void;
}
