export interface ISceneOwnershipReader {
	getOwner(object: object): string | null;
	getSettings(): { activeScene: string | null };
}

export interface ISceneSaveState {
	path: string;
	isActive: boolean;
	isLighting: boolean;
	isDirty: boolean;
}

/** Builds a stable ownership predicate; unclaimed newly authored objects fall back to the active scene only. */
export function createSceneSaveOwnershipPredicate(workspace: ISceneOwnershipReader, targetScenePath: string, onUnowned?: (object: object) => void): (object: object) => boolean {
	const activeScenePath = workspace.getSettings().activeScene;
	return (object) => {
		const owner = workspace.getOwner(object);
		if (owner) {
			return owner === targetScenePath;
		}
		if (targetScenePath === activeScenePath) {
			onUnowned?.(object);
			return true;
		}
		return false;
	};
}

/** Active and lighting content are always saved; any independently dirty inactive scene is added. */
export function getScenePathsToSave(states: ISceneSaveState[]): string[] {
	return states.filter((scene) => scene.isActive || scene.isLighting || scene.isDirty).map((scene) => scene.path);
}
