export interface ISceneLocalConfiguration {
	rendering: unknown[];
	animations: unknown[];
	clusteredLightIds: string[];
}

/** Preserves non-lighting scene globals while replacing independently authored camera/animation data. */
export function mergeSceneSaveConfiguration(retained: any, liveGlobal: any, local: ISceneLocalConfiguration, isLightingScene: boolean): any {
	const retainedConfiguration = retained && typeof retained === "object" && !Array.isArray(retained) ? structuredClone(retained) : {};
	const globalConfiguration = isLightingScene ? liveGlobal : retainedConfiguration;
	return {
		...retainedConfiguration,
		...globalConfiguration,
		rendering: local.rendering,
		animations: local.animations,
		clusteredLight: {
			...(globalConfiguration.clusteredLight ?? {}),
			lights: local.clusteredLightIds,
		},
	};
}
