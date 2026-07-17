import { afterEach, describe, expect, test, vi } from "vitest";

import { installDynamicImportedFont, loadImportedFontAsset } from "../../src/loading/fonts";

describe("font runtime importer", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("resolves portable manifests and atlas pages relative to the build root", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith(".bjsfont.json")) {
				return { ok: true, json: async () => ({ renderMode: "msdf", family: "GameFont", manifestPath: "assets/game.font.json", dynamicFontPath: null }) };
			}
			return {
				ok: true,
				json: async () => ({
					version: 1,
					renderMode: "msdf",
					family: "GameFont",
					fontSize: 48,
					padding: 4,
					distanceRange: 6,
					lineHeight: 52,
					base: 40,
					ascender: 40,
					descender: -12,
					pages: ["game.font-0.png", "game.font-1.png"],
					characters: [],
					kernings: [],
					missingCodepoints: [],
					dynamicFontPath: null,
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(loadImportedFontAsset("/scene/", "assets/game.ttf")).resolves.toMatchObject({
			renderMode: "msdf",
			family: "GameFont",
			manifestUrl: "/scene/assets/game.font.json",
			pageUrls: ["/scene/assets/game.font-0.png", "/scene/assets/game.font-1.png"],
			dynamicFontUrl: null,
		});
		expect(fetchMock).toHaveBeenNthCalledWith(1, "/scene/assets/game.ttf.bjsfont.json");
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/scene/assets/game.font.json");
	});

	test("installs dynamic font assets through FontFace", async () => {
		const add = vi.fn();
		const load = vi.fn(async () => undefined);
		const FontFaceMock = vi.fn(function (this: { load: typeof load }, _family: string, _source: string) {
			this.load = load;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({
				ok: true,
				json: async () =>
					url.endsWith(".bjsfont.json")
						? { renderMode: "dynamic", family: "GameFont", manifestPath: "assets/game.font.json", dynamicFontPath: "assets/game.ttf" }
						: {
								version: 1,
								renderMode: "dynamic",
								family: "GameFont",
								fontSize: 48,
								padding: 4,
								distanceRange: 4,
								lineHeight: 48,
								base: 48,
								ascender: 48,
								descender: 0,
								pages: [],
								characters: [],
								kernings: [],
								missingCodepoints: [],
								dynamicFontPath: "game.ttf",
							},
			}))
		);
		vi.stubGlobal("FontFace", FontFaceMock);
		vi.stubGlobal("document", { fonts: { add } });
		await expect(installDynamicImportedFont("/scene/", "assets/game.ttf")).resolves.toBe("GameFont");
		expect(FontFaceMock).toHaveBeenCalledWith("GameFont", 'url("/scene/assets/game.ttf")');
		expect(load).toHaveBeenCalledOnce();
		expect(add).toHaveBeenCalledOnce();
	});
});
