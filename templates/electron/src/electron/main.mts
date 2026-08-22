import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { app, BrowserWindow, protocol } from "electron";
import { AssetStreamingRuntime, getAssetStreamingBuildPlan, normalizeAssetStreamingSettings, type IAssetStreamingBuildPlan } from "babylonjs-editor-tools/loading/asset-streaming";
import { getLinuxImeEnvironment, normalizePlatformPlayerSettings } from "babylonjs-editor-tools/loading/platform-player";

import { getAssetStreamingContentType, inferAssetStreamingPriority, openAssetStreamingFileRange, parseAssetStreamingByteRange, resolvePackagedAsset } from "./asset-streaming.mjs";

protocol.registerSchemesAsPrivileged([
	{
		scheme: "zvibe-asset",
		privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
	},
]);

// Force dedicated GPU on systems with dual graphics cards (typically laptops).
app.commandLine.appendSwitch("force_high_performance_gpu");

const isDev = process.env.DEV !== undefined;
const packageMetadata = (() => {
	try {
		return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
	} catch {
		return {};
	}
})();
const readJsonMetadata = (jsonKey: string, legacyKey: string): unknown => {
	try {
		return packageMetadata[jsonKey] ? JSON.parse(packageMetadata[jsonKey]) : (packageMetadata[legacyKey] ?? {});
	} catch {
		return {};
	}
};
const platformPlayerSettings = normalizePlatformPlayerSettings(readJsonMetadata("zvibePlatformPlayerSettingsJson", "zvibePlatformPlayerSettings"));
const assetStreamingSettings = normalizeAssetStreamingSettings(readJsonMetadata("zvibeAssetStreamingSettingsJson", "zvibeAssetStreamingSettings"));
const assetStreamingPlan = getAssetStreamingBuildPlan(assetStreamingSettings, process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
const assetStreamingRuntime = new AssetStreamingRuntime(assetStreamingSettings, assetStreamingPlan.platform);

if (process.platform === "linux") {
	Object.assign(process.env, getLinuxImeEnvironment(platformPlayerSettings));
}

async function installAssetStreamingProtocol(plan: IAssetStreamingBuildPlan): Promise<void> {
	if (!plan.enabled) {
		return;
	}
	const assetRoot = await realpath(join(app.getAppPath(), "dist"));
	await protocol.handle("zvibe-asset", async (request) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed.", { status: 405, headers: { Allow: "GET, HEAD" } });
		}
		try {
			const asset = await resolvePackagedAsset(assetRoot, request.url);
			const requestedRange = request.headers.get("range");
			const range = parseAssetStreamingByteRange(requestedRange, asset.sizeBytes);
			if (!range) {
				return new Response("Requested byte range is not satisfiable.", { status: 416, headers: { "Content-Range": `bytes */${asset.sizeBytes}` } });
			}
			const status = requestedRange ? 206 : 200;
			const headers: Record<string, string> = {
				"Accept-Ranges": "bytes",
				"Access-Control-Allow-Origin": "*",
				"Content-Length": String(range.length),
				"Content-Type": getAssetStreamingContentType(asset.relativePath),
				"X-Content-Type-Options": "nosniff",
				"X-Zvibe-Asset-Streaming": plan.backend,
			};
			if (status === 206) {
				headers["Content-Range"] = `bytes ${range.start}-${range.end}/${asset.sizeBytes}`;
			}
			if (request.method === "HEAD") {
				return new Response(null, { status, headers });
			}
			const queued = assetStreamingRuntime.enqueue(
				{
					key: asset.relativePath,
					url: request.url,
					priority: inferAssetStreamingPriority(asset.relativePath, request.headers.get("x-zvibe-asset-priority")),
					expectedSizeBytes: range.length,
					signal: request.signal,
				},
				async (_streamRequest, signal) => ({
					stream: openAssetStreamingFileRange(asset.absolutePath, range, assetStreamingSettings.windows.chunkSizeBytes, signal),
					sizeBytes: range.length,
					contentType: headers["Content-Type"],
					status,
					headers,
				})
			);
			const response = await queued.response;
			return new Response(response.stream, {
				status: response.status ?? status,
				headers: { ...(response.headers ?? headers), "X-Zvibe-Asset-Request-Id": response.requestId },
			});
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
			const status = code === "ENOENT" ? 404 : error instanceof Error && error.message.includes("inside the packaged application") ? 403 : 400;
			console.error("Packaged asset request failed:", error instanceof Error ? error.message : error);
			return new Response(status === 404 ? "Packaged asset was not found." : "Packaged asset request was rejected.", { status });
		}
	});
}

app.whenReady().then(async () => {
	await installAssetStreamingProtocol(assetStreamingPlan);
	const window = new BrowserWindow({
		show: true,
		frame: false,
		closable: true,
		minimizable: true,
		maximizable: true,
		transparent: false,
		titleBarStyle: "hidden",
		width: 1280,
		height: 800,
		webPreferences: {
			nodeIntegration: false,
			nodeIntegrationInWorker: false,
			javascript: true,
			contextIsolation: !isDev,
		},
	});

	if (isDev) {
		await window.loadURL("http://localhost:3000");
	} else {
		await window.loadFile(join(app.getAppPath(), "dist/index.html"), {
			query: {
				zvibePlatformPlayerSettings: JSON.stringify(platformPlayerSettings),
				zvibeAssetStreamingSettings: JSON.stringify(assetStreamingSettings),
				zvibeAssetStreamingPlan: JSON.stringify(assetStreamingPlan),
			},
		});
	}
});

app.on("window-all-closed", () => {
	assetStreamingRuntime.dispose();
	app.quit();
});
