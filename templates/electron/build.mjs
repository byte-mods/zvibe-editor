import path from "path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import Builder from "electron-builder";
import { getAssetStreamingBuildPlan, normalizeAssetStreamingSettings } from "babylonjs-editor-tools/loading/asset-streaming";
import { getPlatformPlayerBuildPlan, normalizePlatformPlayerSettings } from "babylonjs-editor-tools/loading/platform-player";

const targetPlatform = process.env.BJS_EDITOR_ELECTRON_PLATFORM ?? (process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux");
const targetArchitecture = process.env.BJS_EDITOR_ELECTRON_ARCH ?? process.arch;
const outputDirectory = process.env.BJS_EDITOR_OUTPUT_DIRECTORY ?? "electron-packages";
const productName = process.env.BJS_EDITOR_PRODUCT_NAME ?? "Zvibe Electron Game";
const applicationId = process.env.BJS_EDITOR_APPLICATION_ID ?? "com.zvibe.editor.electron.template.app";
const icon = process.env.BJS_EDITOR_ELECTRON_ICON;
const compression = process.env.BJS_EDITOR_COMPRESSION === "none" ? "store" : "normal";
const platformPlayerSettings = normalizePlatformPlayerSettings(JSON.parse(process.env.BJS_EDITOR_PLATFORM_PLAYER_SETTINGS ?? "{}"));
const platformPlayerPlan = getPlatformPlayerBuildPlan(platformPlayerSettings, targetPlatform);
const assetStreamingSettings = normalizeAssetStreamingSettings(JSON.parse(process.env.BJS_EDITOR_ASSET_STREAMING_SETTINGS ?? "{}"));
const assetStreamingPlan = getAssetStreamingBuildPlan(assetStreamingSettings, targetPlatform);

const appendFlag = (name, flags) => {
	if (!flags.length) return;
	process.env[name] = [process.env[name], ...flags].filter(Boolean).join(" ");
};

if (platformPlayerPlan.lto.enabled) {
	appendFlag("CFLAGS", platformPlayerPlan.lto.compilerFlags);
	appendFlag("CXXFLAGS", platformPlayerPlan.lto.compilerFlags);
	appendFlag("LDFLAGS", platformPlayerPlan.lto.linkerFlags);
}

if (process.env.BJS_EDITOR_SIGNING_IDENTITY) process.env.CSC_NAME = process.env.BJS_EDITOR_SIGNING_IDENTITY;
if (process.env.BJS_EDITOR_SIGNING_CERTIFICATE) process.env.CSC_LINK = process.env.BJS_EDITOR_SIGNING_CERTIFICATE;
if (process.env.BJS_EDITOR_SIGNING_PASSWORD) process.env.CSC_KEY_PASSWORD = process.env.BJS_EDITOR_SIGNING_PASSWORD;

const build = () => {
	return Builder.build({
		x64: targetArchitecture === "x64",
		arm64: targetArchitecture === "arm64",
		mac: targetPlatform === "darwin" ? ["default"] : undefined,
		win: targetPlatform === "win32" ? ["default"] : undefined,
		linux: targetPlatform === "linux" ? ["default"] : undefined,
		config: {
			win: {
				target: "nsis",
				artifactName: "${productName}-${version}-${arch}.${ext}",
				...(icon ? { icon } : {}),
			},
			mac: {
				hardenedRuntime: true,
				appId: applicationId,
				notarize: false,
				identity: process.env.BJS_EDITOR_SIGNING_IDENTITY ?? null,
				...(icon ? { icon } : {}),
			},
			linux: {
				...(icon ? { icon } : {}),
			},
			appId: applicationId,
			productName,
			extraMetadata: {
				...(process.env.BJS_EDITOR_PRODUCT_VERSION ? { version: process.env.BJS_EDITOR_PRODUCT_VERSION } : {}),
				// electron-builder normalizes nested `version` keys in object metadata to strings.
				// Preserve the shared version-1 schema exactly as a bounded JSON payload.
				zvibePlatformPlayerSettingsJson: JSON.stringify(platformPlayerSettings),
				zvibePlatformPlayerPlanJson: JSON.stringify(platformPlayerPlan),
				zvibeAssetStreamingSettingsJson: JSON.stringify(assetStreamingSettings),
				zvibeAssetStreamingPlanJson: JSON.stringify(assetStreamingPlan),
			},
			directories: {
				output: outputDirectory,
			},
			nsis: {
				oneClick: true,
				allowElevation: true,
			},
			asar: process.env.BJS_EDITOR_ELECTRON_ASAR !== "false",
			...(process.env.BJS_EDITOR_ELECTRON_ASAR !== "false" && assetStreamingPlan.enabled ? { asarUnpack: ["dist/scene/**"] } : {}),
			npmRebuild: true,
			compression,
			files: ["dist/**"],
		},
	});
};

// Remove old build
await rm(path.resolve(import.meta.dirname, outputDirectory), {
	force: true,
	recursive: true,
});

await build();
await mkdir(path.resolve(import.meta.dirname, outputDirectory), { recursive: true });
await writeFile(path.resolve(import.meta.dirname, outputDirectory, "zvibe-platform-player-build-plan.json"), `${JSON.stringify(platformPlayerPlan, null, 2)}\n`);
await writeFile(path.resolve(import.meta.dirname, outputDirectory, "zvibe-asset-streaming-build-plan.json"), `${JSON.stringify(assetStreamingPlan, null, 2)}\n`);
