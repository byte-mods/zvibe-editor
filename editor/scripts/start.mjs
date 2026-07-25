import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const electronVersion = require("electron/package.json").version;
const editorPackage = require("../package.json");

const editorDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

async function getDevelopmentExecutable() {
	if (process.platform !== "darwin") {
		return electronExecutable;
	}

	const sourceBundle = dirname(dirname(dirname(electronExecutable)));
	const cacheDirectory = join(editorDirectory, "..", "node_modules", ".cache", "zvibe-editor", `${electronVersion}-${editorPackage.version}`);
	const brandedBundle = join(cacheDirectory, "Zvibe Editor.app");
	const brandedExecutable = join(brandedBundle, "Contents", "MacOS", "Zvibe Editor");

	try {
		require("node:fs").accessSync(brandedExecutable);
		return brandedExecutable;
	} catch {
		// The branded bundle is created once for each Electron/editor version.
	}

	await mkdir(cacheDirectory, { recursive: true });
	const temporaryBundle = join(cacheDirectory, `Zvibe Editor.app.tmp-${process.pid}`);
	await rm(temporaryBundle, { recursive: true, force: true });

	// APFS clone-copy keeps the 250+ MB Electron framework cheap while preserving the upstream installation.
	execFileSync("cp", ["-cR", sourceBundle, temporaryBundle], { stdio: "inherit" });

	const temporaryExecutable = join(temporaryBundle, "Contents", "MacOS", "Electron");
	const renamedExecutable = join(temporaryBundle, "Contents", "MacOS", "Zvibe Editor");
	await rename(temporaryExecutable, renamedExecutable);

	const plistPath = join(temporaryBundle, "Contents", "Info.plist");
	const plistBuddy = "/usr/libexec/PlistBuddy";
	for (const [key, value] of [
		["CFBundleDisplayName", "Zvibe Editor"],
		["CFBundleName", "Zvibe Editor"],
		["CFBundleExecutable", "Zvibe Editor"],
		["CFBundleIdentifier", "com.zvibe.editor.development"],
		["CFBundleIconFile", "zvibe_icon.icns"],
	]) {
		execFileSync(plistBuddy, ["-c", `Set :${key} ${value}`, plistPath]);
	}

	await copyFile(join(editorDirectory, "icons", "zvibe_icon.icns"), join(temporaryBundle, "Contents", "Resources", "zvibe_icon.icns"));
	execFileSync("codesign", ["--force", "--deep", "--sign", "-", temporaryBundle], { stdio: "inherit" });

	await rm(brandedBundle, { recursive: true, force: true });
	await rename(temporaryBundle, brandedBundle);
	return brandedExecutable;
}

const executable = await getDevelopmentExecutable();
const child = spawn(executable, [editorDirectory, ...process.argv.slice(2)], {
	cwd: editorDirectory,
	env: {
		...process.env,
		ZVIBE_DEVELOPMENT: "true",
	},
	stdio: "inherit",
});

child.once("error", (error) => {
	console.error(`Failed to start Zvibe Editor: ${error.message}`);
	process.exitCode = 1;
});

child.once("exit", (code) => {
	process.exitCode = code ?? 0;
});
