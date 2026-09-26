import { createHash } from "crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { axiosGet, axiosRequest, ensureDir, remove, writeFile, writeJSON, readdir } = vi.hoisted(() => ({
	axiosGet: vi.fn(),
	axiosRequest: vi.fn(),
	ensureDir: vi.fn(),
	remove: vi.fn(),
	writeFile: vi.fn(),
	writeJSON: vi.fn(),
	readdir: vi.fn(),
}));

vi.mock("electron", () => ({ ipcRenderer: { on: vi.fn() } }));
vi.mock("fs-extra", () => ({ ensureDir, remove, writeFile, writeJSON, readdir }));
vi.mock("axios", () => ({ default: Object.assign(axiosRequest, { get: axiosGet }) }));
vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("node-stream-zip", () => ({ default: { async: vi.fn() } }));
vi.mock("babylonjs", () => ({
	BaseTexture: class {},
	EnvironmentTextureTools: {},
	EXRCubeTexture: class {},
	HDRCubeTexture: class {},
	Observable: class {},
	Texture: class {},
	PBRMaterial: class {},
	Tools: { RandomId: () => "id" },
}));
vi.mock("../../../src/tools/tools", () => ({ UniqueNumber: { Get: () => 1 } }));
vi.mock("../../../src/editor/layout/preview/import/import", () => ({ configureImportedTexture: vi.fn() }));

import { PolyHavenProvider } from "../../../src/tools/marketplaces/polyhaven";
import { AmbientCGProvider } from "../../../src/tools/marketplaces/ambientcg";
import { pickMarketplaceDownloadOption } from "../../../src/tools/marketplaces/download-options";
import { getSafeMarketplaceFileName, resolveMarketplaceFilePath } from "../../../src/tools/marketplaces/provider";

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => storage.set(key, value),
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "Not Found" });
}

function md5(content: string): string {
	return createHash("md5").update(Buffer.from(content)).digest("hex");
}

function createEditor(): any {
	return {
		state: { projectPath: "/games/demo/project.bjseditor" },
		layout: {
			assets: { refresh: vi.fn() },
			console: { warn: vi.fn(), progress: vi.fn() },
		},
	};
}

const polyHavenModelFiles = {
	blend: { "1k": { blend: { url: "https://dl.polyhaven.org/barrel_1k.blend", md5: "a", size: 10 } } },
	gltf: {
		"1k": {
			gltf: {
				url: "https://dl.polyhaven.org/barrel_1k.gltf",
				md5: md5("gltf"),
				size: 4,
				include: {
					"barrel_1k.bin": { url: "https://dl.polyhaven.org/barrel_1k.bin", md5: md5("bin"), size: 3 },
					"textures/barrel_diff_1k.jpg": { url: "https://dl.polyhaven.org/barrel_diff_1k.jpg", md5: md5("diff"), size: 4 },
				},
			},
		},
		"2k": { gltf: { url: "https://dl.polyhaven.org/barrel_2k.gltf", md5: "b", size: 10, include: {} } },
	},
	fbx: { "1k": { fbx: { url: "https://dl.polyhaven.org/barrel_1k.fbx", md5: "c", size: 10 } } },
};

describe("tools/marketplaces", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		storage.clear();
	});

	describe("file safety helpers", () => {
		test("sanitizes remote asset names used as file names", () => {
			expect(getSafeMarketplaceFileName("Brick Wall 001")).toBe("Brick Wall 001");
			expect(getSafeMarketplaceFileName("../../evil")).toBe("____evil");
			expect(getSafeMarketplaceFileName("a/b\\c:d")).toBe("a_b_c_d");
			expect(getSafeMarketplaceFileName("..")).toBe("_");
			expect(getSafeMarketplaceFileName("  ")).toBe("asset");
		});

		test("keeps downloaded files inside the asset directory", () => {
			expect(resolveMarketplaceFilePath("/p/assets/polyhaven/barrel", "textures/diff.jpg")).toBe("/p/assets/polyhaven/barrel/textures/diff.jpg");
			expect(resolveMarketplaceFilePath("/p/assets/polyhaven/barrel/", "a/../b.bin")).toBe("/p/assets/polyhaven/barrel/b.bin");
			expect(() => resolveMarketplaceFilePath("/p/assets/polyhaven/barrel", "../../../src/scripts.ts")).toThrow(/outside of the asset directory/);
			expect(() => resolveMarketplaceFilePath("/p/assets/polyhaven/barrel", "..\\..\\x.js")).toThrow(/outside of the asset directory/);
			expect(() => resolveMarketplaceFilePath("/p/assets/polyhaven/barrel", "/etc/passwd")).toThrow(/absolute path/);
			expect(() => resolveMarketplaceFilePath("/p/assets/polyhaven/barrel", "C:/Windows/x.dll")).toThrow(/absolute path/);
			expect(() => resolveMarketplaceFilePath("/p/assets/polyhaven/barrel", ".")).toThrow(/outside of the asset directory/);
		});

		test("sanitizes the asset directory derived from a remote id", () => {
			const provider = new PolyHavenProvider();
			expect(provider.getAssetDir("../../escape", "/games/demo/project.bjseditor")).toBe("/games/demo/assets/polyhaven/____escape");
		});
	});

	describe("download option selection", () => {
		test("prefers glTF over authoring formats and matches resolution case-insensitively", () => {
			const options: any = {
				"1K": { blend: {}, fbx: {}, gltf: {} },
				"2K": { blend: {}, gltf: {} },
			};
			expect(pickMarketplaceDownloadOption(options)).toEqual({ quality: "1K", type: "gltf", importAs: "gltf" });
			expect(pickMarketplaceDownloadOption(options, "2k")).toEqual({ quality: "2K", type: "gltf", importAs: "gltf" });
			expect(pickMarketplaceDownloadOption(options, "16k")?.quality).toBe("1K");
		});

		test("imports HDR/EXR as environments, and texture sets before raw archives", () => {
			expect(pickMarketplaceDownloadOption({ "1k": { exr: {}, hdr: {} } } as any)).toEqual({ quality: "1k", type: "hdr", importAs: "env" });
			expect(pickMarketplaceDownloadOption({ "1k": { blend: {}, "PNG Textures": {}, "JPG Textures": {} } } as any)?.type).toBe("JPG Textures");
		});

		test("returns null when nothing is downloadable", () => {
			expect(pickMarketplaceDownloadOption({})).toBeNull();
			expect(pickMarketplaceDownloadOption({ "1k": {} } as any)).toBeNull();
		});
	});

	describe("Poly Haven", () => {
		test("searches by name and tag with 20-item pages", async () => {
			const assets: Record<string, any> = {};
			for (let i = 0; i < 25; i++) {
				assets[`crate_${i}`] = { name: `Crate ${i}`, tags: ["wood"], authors: { "Jane Doe": "All" }, polycount: 100 };
			}
			assets.rock = { name: "Rock", tags: ["stone"] };
			const fetchMock = vi.fn(async () => jsonResponse(assets));
			vi.stubGlobal("fetch", fetchMock);

			const provider = new PolyHavenProvider();
			const first = await provider.search("wood", undefined, { assetType: "models" });
			expect(fetchMock).toHaveBeenCalledWith("https://api.polyhaven.com/assets?t=models");
			expect(first.totalCount).toBe(25);
			expect(first.assets).toHaveLength(20);
			expect(first.nextPageToken).toBe("20");
			expect(first.assets[0]).toMatchObject({ id: "crate_0", author: "Jane Doe", thumbnailUrl: "https://cdn.polyhaven.com/asset_img/thumbs/crate_0.png" });

			const second = await provider.search("wood", first.nextPageToken);
			expect(second.assets).toHaveLength(5);
			expect(second.nextPageToken).toBeUndefined();

			expect((await provider.search("STONE")).assets.map((a) => a.id)).toEqual(["rock"]);
		});

		test("surfaces HTTP failures instead of JSON parse errors", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse({ error: "nope" }, 404))
			);
			await expect(new PolyHavenProvider().search("x")).rejects.toThrow(/Poly Haven request failed \(404/);
		});

		test("builds model download options and the full file list including glTF dependencies", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string) =>
					url.includes("/info/") ? jsonResponse({ name: "Barrel", authors: { Rico: "All" }, tags: ["prop"] }) : jsonResponse(polyHavenModelFiles)
				)
			);

			const provider = new PolyHavenProvider();
			const details = await provider.getAssetDetails("barrel");
			expect(details).toMatchObject({ id: "barrel", name: "Barrel", author: "Rico", license: "CC0" });
			expect(Object.keys(details.downloadOptions!)).toEqual(["1k", "2k"]);
			expect(Object.keys(details.downloadOptions!["1k"]).sort()).toEqual(["blend", "fbx", "gltf"]);

			const files = (provider as any).getFilesToDownload(details, "1k", "gltf");
			expect(files.map((f: any) => f.path)).toEqual(["barrel.gltf", "barrel_1k.bin", "textures/barrel_diff_1k.jpg"]);
		});

		test("groups texture maps into a single JPG texture set", async () => {
			const map = (name: string) => ({
				"1k": { jpg: { url: `https://dl.polyhaven.org/${name}.jpg`, md5: "x", size: 1 }, png: { url: `https://dl.polyhaven.org/${name}.png`, md5: "x", size: 1 } },
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string) =>
					url.includes("/info/")
						? jsonResponse({ name: "Rocky/Ground" })
						: jsonResponse({ Diffuse: map("rocky_diff_1k"), nor_gl: map("rocky_nor_gl_1k"), Rough: map("rocky_rough_1k") })
				)
			);

			const provider = new PolyHavenProvider();
			const details = await provider.getAssetDetails("rocky_ground");
			expect(pickMarketplaceDownloadOption(details.downloadOptions!)?.type).toBe("JPG Textures");

			const files = (provider as any).getFilesToDownload(details, "1k", "JPG Textures");
			// The "/" in the remote name must not create nested or escaping paths.
			expect(files.map((f: any) => f.path).sort()).toEqual(["Rocky_Ground_diffuse.jpg", "Rocky_Ground_nor_gl.jpg", "Rocky_Ground_rough.jpg"]);
		});

		test("downloads, verifies and writes every file of a glTF model into the project", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string) => (url.includes("/info/") ? jsonResponse({ name: "Barrel" }) : jsonResponse(polyHavenModelFiles)))
			);
			readdir.mockResolvedValue([]);
			axiosGet.mockRejectedValue(new Error("thumbnail offline"));
			const bodies: Record<string, string> = {
				"https://dl.polyhaven.org/barrel_1k.gltf": "gltf",
				"https://dl.polyhaven.org/barrel_1k.bin": "bin",
				"https://dl.polyhaven.org/barrel_diff_1k.jpg": "diff",
			};
			axiosRequest.mockImplementation(async (config: any) => ({ data: Buffer.from(bodies[config.url]) }));

			const provider = new PolyHavenProvider();
			const editor = createEditor();
			const details = await provider.getAssetDetails("barrel");
			await provider.downloadAndImport(details, editor, "1k", "gltf");

			expect(writeFile.mock.calls.map((call) => call[0])).toEqual([
				"/games/demo/assets/polyhaven/barrel/barrel.gltf",
				"/games/demo/assets/polyhaven/barrel/barrel_1k.bin",
				"/games/demo/assets/polyhaven/barrel/textures/barrel_diff_1k.jpg",
			]);
			expect(remove).not.toHaveBeenCalled();
			expect(editor.layout.console.warn).toHaveBeenCalledWith(expect.stringContaining("thumbnail offline"));
			expect(editor.layout.assets.refresh).toHaveBeenCalled();
		});

		test("rejects corrupted downloads and cleans up the partial asset", async () => {
			axiosGet.mockRejectedValue(new Error("offline"));
			axiosRequest.mockResolvedValue({ data: Buffer.from("truncated") });

			const provider = new PolyHavenProvider();
			const asset: any = {
				id: "barrel",
				name: "Barrel",
				thumbnailUrl: "",
				downloadOptions: { "1k": { gltf: { url: "https://dl.polyhaven.org/barrel_1k.gltf", md5: md5("gltf"), size: 4, include: {} } } },
			};

			await expect(provider.downloadAndImport(asset, createEditor(), "1k", "gltf")).rejects.toThrow(/corrupted/);
			expect(writeFile).not.toHaveBeenCalled();
			expect(remove).toHaveBeenCalledWith("/games/demo/assets/polyhaven/barrel");

			// The failed download must release its slot so the user can retry.
			axiosRequest.mockResolvedValue({ data: Buffer.from("gltf") });
			readdir.mockResolvedValue([]);
			await expect(provider.downloadAndImport(asset, createEditor(), "1k", "gltf")).resolves.toBeUndefined();
		});

		test("refuses remote include paths that escape the asset directory", async () => {
			axiosGet.mockRejectedValue(new Error("offline"));
			axiosRequest.mockResolvedValue({ data: Buffer.from("x") });

			const asset: any = {
				id: "barrel",
				name: "Barrel",
				thumbnailUrl: "",
				downloadOptions: {
					"1k": {
						gltf: { url: "https://dl.polyhaven.org/a.gltf", md5: "", size: 1, include: { "../../../src/scripts.ts": { url: "https://evil/x", md5: "", size: 1 } } },
					},
				},
			};

			await expect(new PolyHavenProvider().downloadAndImport(asset, createEditor(), "1k", "gltf")).rejects.toThrow(/outside of the asset directory/);
			expect(writeFile.mock.calls.map((call) => call[0])).toEqual(["/games/demo/assets/polyhaven/barrel/barrel.gltf"]);
		});

		test("requires an open project", async () => {
			const editor = createEditor();
			editor.state.projectPath = null;
			await expect(new PolyHavenProvider().downloadAndImport({ id: "a", name: "a", thumbnailUrl: "" }, editor, "1k", "gltf")).rejects.toThrow(/no project/);
		});
	});

	describe("ambientCG", () => {
		const asset = {
			id: "Metal032",
			data: {
				text: { title: "Metal 032", description: "Scratched metal" },
				preview_image_thumbnail: { uris: { "0": "https://acg/0.png", "256": "https://acg/256.png", "512": "https://acg/512.png" } },
				implementation_list_query: { parameters: [{ id: "attribute", choices: [{ value: "1K-JPG" }, { value: "2K-PNG" }] }] },
			},
		};

		function implementation(attribute: string): any {
			return {
				implementations: [
					{
						id: `Metal032_${attribute}_ZIP`,
						components: [
							{
								data: {
									"fetch.download": { download_query: { uri: `https://ambientcg.com/get?file=Metal032_${attribute}.zip` } },
									store: { bytes: 1234 },
									format: { extension: ".zip" },
								},
							},
						],
					},
				],
			};
		}

		test("maps search results and paginates by 100", async () => {
			axiosGet.mockResolvedValue({ data: { assets: [asset] } });
			const provider = new AmbientCGProvider();
			const result = await provider.search("metal", undefined, { type: "Material" });

			expect(axiosGet).toHaveBeenCalledWith("https://ambientcg.com/api/af/asset_list", { params: { q: "metal", offset: 0, type: "Material" } });
			expect(result.assets).toEqual([
				{ id: "Metal032", name: "Metal 032", thumbnailUrl: "https://acg/256.png", description: "Scratched metal", author: "ambientCG", license: "CC0" },
			]);
			expect(result.totalCount).toBe(1);
			expect(result.nextPageToken).toBeUndefined();
		});

		test("resolves quality/format download options and extracts zip archives", async () => {
			axiosGet.mockImplementation(async (url: string, config: any) =>
				url.endsWith("/asset_list") ? { data: { assets: [asset] } } : { data: implementation(config.params.attribute) }
			);

			const provider = new AmbientCGProvider();
			const details = await provider.getAssetDetails("Metal032");
			expect(details.downloadOptions).toEqual({
				"1K": { JPG: expect.objectContaining({ url: "https://ambientcg.com/get?file=Metal032_1K-JPG.zip", size: 1234, extension: ".zip" }) },
				"2K": { PNG: expect.objectContaining({ url: "https://ambientcg.com/get?file=Metal032_2K-PNG.zip" }) },
			});
			expect(pickMarketplaceDownloadOption(details.downloadOptions!, "2k")).toEqual({ quality: "2K", type: "PNG", importAs: "PNG" });

			const files = (provider as any).getFilesToDownload(details, "1K", "JPG");
			expect(files).toEqual([{ url: "https://ambientcg.com/get?file=Metal032_1K-JPG.zip", path: "Metal032_1K_JPG.zip", size: 1234, extract: true }]);
		});

		test("reports unknown assets", async () => {
			axiosGet.mockResolvedValue({ data: { assets: [] } });
			await expect(new AmbientCGProvider().getAssetDetails("Missing001")).rejects.toThrow("Asset not found: Missing001");
		});
	});
});
