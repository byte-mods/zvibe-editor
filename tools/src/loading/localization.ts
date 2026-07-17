import { Scene } from "@babylonjs/core/scene";

export interface ILocalizationTable {
	name: string;
	fallbackLocale: string;
	entries: Record<string, Record<string, string>>;
}

export interface ILocalizationData {
	version: number;
	tables: ILocalizationTable[];
}

/**
 * Resolves strings authored in the editor's project localization tables.
 * It is attached to a loaded scene before scene scripts start, so game code can
 * resolve text without loading a separate project file at runtime.
 */
export class LocalizationManager {
	private _locale: string;
	private _tables = new Map<string, ILocalizationTable>();

	public constructor(data: ILocalizationData, locale = "en") {
		this._locale = locale;
		data.tables.forEach((table) => this._tables.set(table.name, table));
	}

	public get locale(): string {
		return this._locale;
	}

	public setLocale(locale: string): void {
		this._locale = locale;
	}

	public hasTable(name: string): boolean {
		return this._tables.has(name);
	}

	public resolve(tableName: string, key: string, locale = this._locale): string | undefined {
		const table = this._tables.get(tableName);
		return table?.entries[key]?.[locale] ?? table?.entries[key]?.[table.fallbackLocale];
	}

	public getTables(): ILocalizationTable[] {
		return Array.from(this._tables.values());
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		localization?: LocalizationManager;
	}
}

export function configureLocalization(scene: Scene): void {
	const data = scene.metadata?.babylonEditorLocalization as ILocalizationData | undefined;
	if (data?.tables) {
		scene.localization = new LocalizationManager(data);
	}
}
