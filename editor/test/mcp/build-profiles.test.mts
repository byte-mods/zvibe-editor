import { describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";
import { mkdtemp, readFile, readJSON, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import {
	buildBuildProfile,
	createBuildProfile,
	generatePwaManifest,
	generatePwaServiceWorker,
	installPwaServiceWorkerRegistration,
	getBuildProfileEnvironment,
	listBuildProfiles,
	listBuildReports,
	recordBuildReport,
	setBuildProfile,
} from "../../src/mcp/project/export";

describe("mcp/build profiles", () => {
	test("persists structured target settings", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			const profile = createBuildProfile(scene, {
				name: "Desktop",
				target: "electron",
				settings: { productName: "Game", version: "1.0.0", mac: { category: "public.app-category.games" } },
			});
			expect(profile.settings).toEqual({ productName: "Game", version: "1.0.0", mac: { category: "public.app-category.games" } });
			expect(listBuildProfiles(scene).profiles[0].settings.productName).toBe("Game");
			expect(setBuildProfile(scene, { name: "Desktop", settings: { productName: "Updated" } }).settings.productName).toBe("Updated");
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("exposes persisted settings as explicit target-build environment variables", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			createBuildProfile(scene, { name: "Web", settings: { productName: "Nebula", version: "2.1.0", outputDirectory: "dist/web", web: { basePath: "/game" } } });
			const environment = getBuildProfileEnvironment(scene, { name: "Web" }, { editor: { state: { projectPath: "/project/game.bjseditor" } } } as any).environment;
			expect(environment).toMatchObject({
				BJS_EDITOR_BUILD_PROFILE: "Web",
				BJS_EDITOR_BUILD_TARGET: "web",
				BJS_EDITOR_BUILD_PROJECT_DIRECTORY: "/project",
				BJS_EDITOR_PRODUCT_NAME: "Nebula",
				BJS_EDITOR_PRODUCT_VERSION: "2.1.0",
				BJS_EDITOR_OUTPUT_DIRECTORY: "dist/web",
			});
			expect(JSON.parse(environment.BJS_EDITOR_BUILD_SETTINGS)).toEqual({ productName: "Nebula", version: "2.1.0", outputDirectory: "dist/web", web: { basePath: "/game" } });
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("exposes explicit Electron packaging settings to the target script", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			createBuildProfile(scene, {
				name: "Desktop",
				target: "electron",
				settings: { electronPlatform: "win32", electronArch: "arm64", electronAsar: false, electronIcon: "assets/icon.ico" },
			});
			const environment = getBuildProfileEnvironment(scene, { name: "Desktop" }, { editor: { state: { projectPath: "/project/game.bjseditor" } } } as any).environment;
			expect(environment).toMatchObject({
				BJS_EDITOR_ELECTRON_PLATFORM: "win32",
				BJS_EDITOR_ELECTRON_ARCH: "arm64",
				BJS_EDITOR_ELECTRON_ASAR: "false",
				BJS_EDITOR_ELECTRON_ICON: "assets/icon.ico",
			});
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("persists a headless target and exposes it to its build script", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			createBuildProfile(scene, { name: "Headless Validation", target: "headless", settings: { outputDirectory: "dist/server" } });
			expect(
				getBuildProfileEnvironment(scene, { name: "Headless Validation" }, { editor: { state: { projectPath: "/project/game.bjseditor" } } } as any).environment
			).toMatchObject({
				BJS_EDITOR_BUILD_TARGET: "headless",
				BJS_EDITOR_OUTPUT_DIRECTORY: "dist/server",
			});
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("persists Android and iOS project-script targets", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			createBuildProfile(scene, { name: "Android", target: "android", settings: { outputDirectory: "dist/android", applicationId: "com.example.game" } });
			createBuildProfile(scene, { name: "iOS", target: "ios", settings: { outputDirectory: "dist/ios", applicationId: "com.example.game" } });
			const options = { editor: { state: { projectPath: "/project/game.bjseditor" } } } as any;
			expect(getBuildProfileEnvironment(scene, { name: "Android" }, options).environment).toMatchObject({
				BJS_EDITOR_BUILD_TARGET: "android",
				BJS_EDITOR_OUTPUT_DIRECTORY: "dist/android",
			});
			expect(getBuildProfileEnvironment(scene, { name: "iOS" }, options).environment).toMatchObject({
				BJS_EDITOR_BUILD_TARGET: "ios",
				BJS_EDITOR_OUTPUT_DIRECTORY: "dist/ios",
			});
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("persists the newest 20 structured build reports", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			for (let index = 0; index < 21; index++)
				recordBuildReport(scene, {
					profile: `Web ${index}`,
					outcome: "exported",
					output: { fileCount: index, totalBytes: index * 100, extensions: { ".js": { files: 1, bytes: index * 100 } } },
				});
			const reports = listBuildReports(scene).reports;
			expect(reports).toHaveLength(20);
			expect(reports[0]).toMatchObject({ profile: "Web 20", outcome: "exported", output: { fileCount: 20, totalBytes: 2000 } });
			expect(reports[19].profile).toBe("Web 1");
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("generates a PWA manifest from a Web profile inside the project", async () => {
		const directory = await mkdtemp(join(tmpdir(), "babylon-pwa-"));
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			createBuildProfile(scene, {
				name: "Web PWA",
				settings: {
					productName: "Nebula",
					web: { basePath: "/game" },
					pwa: {
						name: "Nebula PWA",
						shortName: "Neb",
						startUrl: "/launch",
						display: "minimal-ui",
						manifestPath: "public/manifest.webmanifest",
						backgroundColor: "#654321",
						themeColor: "#123456",
					},
				},
			});
			const result = await generatePwaManifest(scene, { name: "Web PWA" }, { editor: { state: { projectPath: join(directory, "Game.bjseditor") } } } as any);
			expect(result).toMatchObject({
				path: "public/manifest.webmanifest",
				manifest: { name: "Nebula PWA", short_name: "Neb", start_url: "/launch", display: "minimal-ui", background_color: "#654321", theme_color: "#123456" },
			});
			expect(await readJSON(join(directory, "public/manifest.webmanifest"))).toMatchObject({ name: "Nebula PWA", display: "minimal-ui", background_color: "#654321" });
		} finally {
			scene.dispose();
			engine.dispose();
			await remove(directory);
		}
	});

	test("generates a cache-first PWA service worker with an offline fallback", async () => {
		const directory = await mkdtemp(join(tmpdir(), "babylon-pwa-worker-"));
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			createBuildProfile(scene, {
				name: "Web Offline",
				settings: {
					version: "2.0.0",
					pwa: { serviceWorkerPath: "public/worker.js", startUrl: "/game/", offlineFallbackUrl: "/offline.html", precacheUrls: ["/game/", "/offline.html"] },
				},
			});
			const result = await generatePwaServiceWorker(scene, { name: "Web Offline" }, { editor: { state: { projectPath: join(directory, "Game.bjseditor") } } } as any);
			expect(result).toMatchObject({
				path: "public/worker.js",
				cacheName: "babylon-editor-pwa-Web-Offline-2.0.0",
				precacheUrls: ["/game/", "/offline.html"],
				registration: 'navigator.serviceWorker.register("/worker.js");',
			});
			const source = await readFile(join(directory, "public/worker.js"), "utf8");
			expect(source).toContain('const OFFLINE_FALLBACK_URL = "/offline.html";');
			expect(source).toContain("cache.addAll(PRECACHE_URLS)");
		} finally {
			scene.dispose();
			engine.dispose();
			await remove(directory);
		}
	});

	test("installs an idempotent generated-worker registration into a root web index", async () => {
		const directory = await mkdtemp(join(tmpdir(), "babylon-pwa-register-"));
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			createBuildProfile(scene, { name: "Web Registration", settings: { pwa: { serviceWorkerPath: "public/sw.js" } } });
			await generatePwaServiceWorker(scene, { name: "Web Registration" }, { editor: { state: { projectPath: join(directory, "Game.bjseditor") } } } as any);
			await writeFile(join(directory, "index.html"), "<!doctype html><html><body><main></main></body></html>");
			const options = { editor: { state: { projectPath: join(directory, "Game.bjseditor") } } } as any;
			expect(await installPwaServiceWorkerRegistration(scene, { name: "Web Registration" }, options)).toMatchObject({
				path: "index.html",
				serviceWorkerUrl: "/sw.js",
				changed: true,
			});
			expect(await readFile(join(directory, "index.html"), "utf8")).toContain('navigator.serviceWorker.register("/sw.js")');
			expect(await installPwaServiceWorkerRegistration(scene, { name: "Web Registration" }, options)).toMatchObject({ changed: false });
		} finally {
			scene.dispose();
			engine.dispose();
			await remove(directory);
		}
	});

	test("records a failed target build validation in build-report history", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			createBuildProfile(scene, { name: "Broken Web" });
			await expect(buildBuildProfile(scene, { name: "Broken Web" }, { editor: { state: { projectPath: "/definitely-missing/project.bjseditor" } } } as any)).rejects.toThrow(
				"Build profile cannot run"
			);
			expect(listBuildReports(scene).reports[0]).toMatchObject({ profile: "Broken Web", target: "web", outcome: "failed" });
			expect(listBuildReports(scene).reports[0].error).toContain("package.json");
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});
});
