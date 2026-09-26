import { join } from "path/posix";

import { HavokPlugin, Scene, Vector3 } from "babylonjs";

import HavokPhysics from "@babylonjs/havok";

let isInitialized = false;

/**
 * Initializes the Havok physics engine for being used in the Editor with Babylon.js.
 * @param appPath defines the absolute path to the Editor application.
 */
export async function initializeHavok(appPath: string) {
	if (isInitialized) {
		return;
	}

	isInitialized = true;

	const havok = await HavokPhysics({
		environment: "NODE",
		locateFile: (url) => {
			const nodeModules = process.env.DEBUG ? "../node_modules" : "node_modules";

			return join(appPath, nodeModules, "@babylonjs/havok/lib/umd", url);
		},
	});

	globalThis.HK = havok;
}

/**
 * Editor scenes are authored in centimeters, so gravity is -981 cm/s² and Havok's default speed limit
 * (200 units/s, which assumes meters) is scaled to 20,000 cm/s. Exported templates use the same values.
 */
export const EditorPhysicsGravity = -981;
export const EditorPhysicsMaxLinearVelocity = 20_000;
export const EditorPhysicsMaxAngularVelocity = 100;

/**
 * Enables Havok physics on the given scene with the editor's centimeter gravity and speed limits.
 * @param scene defines the scene to enable physics on.
 */
export function enableEditorPhysics(scene: Scene): HavokPlugin {
	const plugin = new HavokPlugin();
	scene.enablePhysics(new Vector3(0, EditorPhysicsGravity, 0), plugin);
	plugin.setVelocityLimits(EditorPhysicsMaxLinearVelocity, EditorPhysicsMaxAngularVelocity);
	return plugin;
}
