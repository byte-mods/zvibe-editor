import { afterEach, describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";

import { LocalizationManager, normalizeLocalizationData, validateLocalizationStringTemplate } from "../../src/loading/localization";

describe("localization runtime", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("migrates legacy tables and resolves regional, authored, and table fallbacks", () => {
		const data = normalizeLocalizationData({
			version: 1,
			tables: [{ name: "UI", fallbackLocale: "en", entries: { play: { en: "Play", fr: "Jouer" } } }],
			locales: [
				{ id: "en", fallbackLocales: [] },
				{ id: "fr", fallbackLocales: ["en"] },
				{ id: "fr-CA", fallbackLocales: ["fr"] },
			],
		});
		const manager = new LocalizationManager(data, "fr-CA");
		expect(data).toMatchObject({ version: 2, revision: 0, defaultLocale: "en", assetTables: [] });
		expect(manager.resolveString("UI", "play")).toMatchObject({ value: "Jouer", requestedLocale: "fr-CA", resolvedLocale: "fr", direction: "ltr" });
		const changed = vi.fn();
		manager.onLocaleChangedObservable.add(changed);
		const updated = structuredClone(data);
		updated.tables[0].entries.play.fr = "Jouer maintenant";
		manager.updateData(updated, "/project/");
		expect(manager.resolve("UI", "play")).toBe("Jouer maintenant");
		expect(changed.mock.calls[0][0]).toBe("fr-CA");
		expect(() =>
			normalizeLocalizationData({
				locales: [
					{ id: "en", fallbackLocales: ["fr"] },
					{ id: "fr", fallbackLocales: ["en"] },
				],
			})
		).toThrow(/fallback cycle/);
	});

	test("formats bounded Smart Strings and applies locale-aware plural and pseudo rules", () => {
		const manager = new LocalizationManager(
			normalizeLocalizationData({
				defaultLocale: "en",
				locales: [
					{ id: "en", fallbackLocales: [] },
					{ id: "ar", direction: "rtl", fallbackLocales: ["en"] },
					{ id: "qps-Ploc", fallbackLocales: ["en"], pseudo: { expansionPercent: 20, accent: true, wrap: true, mirror: false } },
				],
				tables: [
					{
						name: "UI",
						fallbackLocale: "en",
						smartEntries: ["items"],
						entries: { items: { en: "{count} {count:plural:item|items}" } },
					},
				],
			})
		);
		expect(manager.resolve("UI", "items", "en", { count: 1 })).toBe("1 item");
		expect(manager.resolve("UI", "items", "en", { count: 3 })).toBe("3 items");
		expect(
			new LocalizationManager(
				normalizeLocalizationData({
					locales: [{ id: "en" }],
					tables: [{ name: "UI", fallbackLocale: "en", smartEntries: ["apples"], entries: { apples: { en: "I have {count:plural:1 apple|{} apples}" } } }],
				})
			).resolve("UI", "apples", "en", { count: 4 })
		).toBe("I have 4 apples");
		expect(
			new LocalizationManager(
				normalizeLocalizationData({
					locales: [{ id: "en" }],
					tables: [{ name: "UI", fallbackLocale: "en", smartEntries: ["exact"], entries: { exact: { en: "{count:plural:=0=none|one=single|other=many}" } } }],
				})
			).resolve("UI", "exact", "en", { count: 0 })
		).toBe("none");
		expect(manager.resolveString("UI", "items", "ar", { count: 2 })).toMatchObject({ direction: "rtl", resolvedLocale: "en" });
		expect(manager.resolve("UI", "items", "qps-Ploc", { count: 2 })).toMatch(/^\[2 ïtëms~+\]$/);
		expect(() => validateLocalizationStringTemplate("{count:plural:one|# other}")).not.toThrow();
		expect(() => validateLocalizationStringTemplate("{price:number(usd)}")).toThrow(/unsupported/);
		expect(() => validateLocalizationStringTemplate("{mode:choose(edit|play):Edit|Play}")).toThrow(/fallback/);
	});

	test("loads local and Addressable asset variants and clears locale cache on switch", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
		vi.stubGlobal("fetch", fetchMock);
		const manager = new LocalizationManager(
			normalizeLocalizationData({
				defaultLocale: "en",
				locales: [
					{ id: "en", fallbackLocales: [] },
					{ id: "fr", fallbackLocales: ["en"] },
				],
				assetTables: [
					{
						name: "Art",
						fallbackLocale: "en",
						preload: true,
						entries: {
							logo: { en: { path: "assets/logo.png", type: "texture" }, fr: { path: "assets/logo-fr.png", type: "texture" } },
							speech: { en: { path: "assets/speech.ogg", type: "audio", addressableGroup: "Voice", address: "speech-en" } },
						},
					},
				],
			})
		);
		manager.attachScene(scene);
		const addressable = vi.fn(async () => new Uint8Array([9, 8]).buffer);
		scene.addressables = { loadArrayBuffer: addressable } as never;
		expect((await manager.loadAsset("Art", "logo")).bytes.byteLength).toBe(3);
		expect((await manager.loadAsset("Art", "logo")).bytes.byteLength).toBe(3);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect((await manager.loadAsset("Art", "speech")).bytes.byteLength).toBe(2);
		expect(addressable).toHaveBeenCalledWith("Voice", "speech-en");
		manager.setLocale("fr");
		expect((await manager.preload()).assetCount).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		scene.dispose();
		engine.dispose();
	});
});
