import { Scene } from "@babylonjs/core/scene";

export interface IAddressableAsset {
	path: string;
	sizeBytes: number;
	hash: string;
	labels?: string[];
}

export interface IAddressableGroup {
	id: string;
	name: string;
	remoteUrl?: string;
	assets: IAddressableAsset[];
}

export interface IAddressableCatalog {
	version: number;
	generatedAt: string;
	groups: IAddressableGroup[];
}

function assetUrl(rootUrl: string, group: IAddressableGroup, asset: IAddressableAsset): string {
	const base = group.remoteUrl ?? rootUrl;
	return `${base.replace(/\/$/, "")}/${asset.path.replace(/^\//, "")}`;
}

/** Resolves and downloads files assigned to editor addressable groups. */
export class AddressableCatalog {
	public constructor(
		private _rootUrl: string,
		private _catalog: IAddressableCatalog
	) {}

	public getGroups(): IAddressableGroup[] {
		return this._catalog.groups;
	}

	public getAsset(groupName: string, assetPath: string): IAddressableAsset | undefined {
		return this._catalog.groups.find((group) => group.name === groupName || group.id === groupName)?.assets.find((asset) => asset.path === assetPath);
	}

	public getAssetUrl(groupName: string, assetPath: string): string | undefined {
		const group = this._catalog.groups.find((candidate) => candidate.name === groupName || candidate.id === groupName);
		const asset = group?.assets.find((candidate) => candidate.path === assetPath);
		return group && asset ? assetUrl(this._rootUrl, group, asset) : undefined;
	}

	/** Returns assets carrying all (default) or any requested labels across catalog groups. */
	public getAssetsByLabels(labels: string[], match: "all" | "any" = "all"): { group: IAddressableGroup; asset: IAddressableAsset }[] {
		const requested = [...new Set(labels.filter((label) => label.trim()))];
		if (!requested.length) return [];
		return this._catalog.groups.flatMap((group) =>
			group.assets
				.filter((asset) => (match === "all" ? requested.every((label) => asset.labels?.includes(label)) : requested.some((label) => asset.labels?.includes(label))))
				.map((asset) => ({ group, asset }))
		);
	}

	public async loadArrayBuffer(groupName: string, assetPath: string, verifyHash = true): Promise<ArrayBuffer> {
		const asset = this.getAsset(groupName, assetPath);
		const url = this.getAssetUrl(groupName, assetPath);
		if (!asset || !url) throw new Error(`Addressable asset "${assetPath}" was not found in group "${groupName}".`);
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Failed to load addressable asset "${assetPath}": ${response.status} ${response.statusText}`);
		const bytes = await response.arrayBuffer();
		if (verifyHash && globalThis.crypto?.subtle) {
			const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
			const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
			if (hash !== asset.hash) throw new Error(`Addressable asset "${assetPath}" failed SHA-256 verification.`);
		}
		return bytes;
	}

	public async loadText(groupName: string, assetPath: string, verifyHash = true): Promise<string> {
		return new TextDecoder().decode(await this.loadArrayBuffer(groupName, assetPath, verifyHash));
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		addressables?: AddressableCatalog;
	}
}

export function configureAddressables(scene: Scene, rootUrl: string): void {
	const catalog = scene.metadata?.babylonEditorAddressables as IAddressableCatalog | undefined;
	if (catalog?.groups) scene.addressables = new AddressableCatalog(rootUrl, catalog);
}
