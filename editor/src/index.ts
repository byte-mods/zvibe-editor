import { platform, arch } from "os";
import { autoUpdater } from "electron-updater";
import { basename, dirname, join } from "path/posix";
import { BrowserWindow, app, globalShortcut, ipcMain, nativeTheme, nativeImage } from "electron";
import { watch } from "chokidar";

import "dotenv/config";

import { getFilePathArgument } from "./tools/process";

import { setupEditorMenu } from "./editor/menu";

import { setupDashboardMenu } from "./dashboard/menu";
import { createDashboardWindow } from "./dashboard/window";

import { createEditorWindow, editorWindows } from "./editor/window";

import "./electron/node-pty";
import "./electron/events/shell";
import "./electron/events/dialog";
import "./electron/events/editor";
import "./electron/events/window";
import "./electron/assimp/assimpjs";
import "./electron/events/export";
import "./electron/protocol";
import "./electron/oauth";

app.setName("Zvibe Editor");
process.title = "Zvibe Editor";

const isDevelopment = !app.isPackaged || process.env.ZVIBE_DEVELOPMENT === "true";

try {
	if (isDevelopment) {
		process.env.DEBUG ??= "true";
	}

	process.env.SKETCHFAB_CLIENT_ID ??= "XZVigLIpz1lqWCkAMRWWpZzKIEVaMEIcsBrgQWrD";

	if (process.env.DEBUG) {
		// Electron 39 no longer tolerates the legacy reloader's broad BrowserView traversal. Keep its main-process relaunch support and reload renderer windows without touching DevTools.
		require("electron-reloader")(module, { watchRenderer: false, ignore: [] });
		setupDevelopmentRendererReloader();
	}
} catch (_) {
	/* Catch silently */
}

/** Reloads only application renderers after compiled development assets settle, avoiding the legacy reloader's removed BrowserView path. */
function setupDevelopmentRendererReloader(): void {
	const watcher = watch([join(app.getAppPath(), "build/src"), join(app.getAppPath(), "build/index.css"), join(app.getAppPath(), "index.html")], {
		ignoreInitial: true,
		awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
	});
	let reloadTimeout: ReturnType<typeof setTimeout> | null = null;

	watcher.on("all", (_, changedPath) => {
		if (changedPath.endsWith(".map")) {
			return;
		}
		if (reloadTimeout) {
			clearTimeout(reloadTimeout);
		}
		reloadTimeout = setTimeout(() => {
			reloadTimeout = null;
			BrowserWindow.getAllWindows().forEach((window) => {
				if (!window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.getURL().startsWith("devtools://")) {
					window.webContents.reloadIgnoringCache();
				}
			});
		}, 150);
	});

	app.once("before-quit", () => {
		if (reloadTimeout) {
			clearTimeout(reloadTimeout);
		}
		void watcher.close();
	});
}

// Enable remote debugging of both the Editor and the edited Project.
app.commandLine.appendSwitch("remote-debugging-port", "8315");

// Force dedicated GPU on systems with dual graphics cards (typically laptops).
app.commandLine.appendSwitch("force_high_performance_gpu");

app.addListener("ready", async () => {
	nativeTheme.themeSource = "system";

	if (process.platform === "darwin") {
		app.dock?.setIcon(nativeImage.createFromPath(join(app.getAppPath(), "assets/zvibe_icon.png")));
	}

	globalShortcut.register("CommandOrControl+ALT+I", () => {
		BrowserWindow.getFocusedWindow()?.webContents.openDevTools({
			mode: "right",
		});
	});

	const filePath = getFilePathArgument(process.argv);
	if (filePath) {
		await openProject(filePath);
	} else {
		await openDashboard();
	}

	if (!isDevelopment) {
		autoUpdater.checkForUpdatesAndNotify();
	}

	try {
		fetch("https://editor.babylonjs.com/api/hooks/launch", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				content: `${platform()} ${arch()}`,
			}),
		});
	} catch (error) {
		// Catch silently, as this is not critical for the app to function.
	}
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		openDashboard();
	}
});

app.on("second-instance", async () => {
	if (platform() === "darwin") {
		const window = await openDashboard();
		console.log(window); // TODO: setup new window (aka new project).
	}
});

let shouldAppQuit = false;

ipcMain.on("app:quit", () => {
	for (const window of editorWindows.slice()) {
		window.close();

		if (editorWindows.includes(window)) {
			return;
		}
	}

	if (!editorWindows.length) {
		shouldAppQuit = true;
		app.quit();
	}
});

let dashboardWindow: BrowserWindow | null = null;
let menuOptions = { enableExperimentalFeatures: false, openedTabs: [] };

ipcMain.on("editor:setup-menu", (_, options) => {
	menuOptions = options;
	setupEditorMenu(options);
});

async function openDashboard(): Promise<void> {
	if (!dashboardWindow) {
		setupDashboardMenu();

		dashboardWindow = await createDashboardWindow();
		dashboardWindow.setTitle("Zvibe Editor");

		dashboardWindow.on("focus", () => setupDashboardMenu());
		dashboardWindow.on("closed", () => (dashboardWindow = null));
	}

	dashboardWindow.show();
	dashboardWindow.focus();
}

function closeDashboard(): void {
	if (dashboardWindow) {
		dashboardWindow.close();
		dashboardWindow = null;
	}
}

ipcMain.on("dashboard:open-project", (_, file: string, shouldCloseDashboard?: boolean) => {
	openProject(file);
	dashboardWindow?.minimize();

	if (shouldCloseDashboard) {
		closeDashboard();
	}
});

ipcMain.on("dashboard:update-projects", () => {
	dashboardWindow?.webContents.send("dashboard:update-projects");
});

const openedProjects: string[] = [];

async function openProject(filePath: string): Promise<void> {
	if (openedProjects.includes(filePath)) {
		return;
	}

	openedProjects.push(filePath);

	notifyWindows("dashboard:opened-projects", openedProjects);

	setupEditorMenu(menuOptions);

	const window = await createEditorWindow();
	window.setTitle(`Zvibe Editor — ${basename(dirname(filePath))}`);

	window.on("focus", () => setupEditorMenu(menuOptions));
	window.once("closed", () => {
		openedProjects.splice(openedProjects.indexOf(filePath), 1);
		notifyWindows("dashboard:opened-projects", openedProjects);

		if (openedProjects.length === 0 && !shouldAppQuit) {
			openDashboard();
		}
	});

	if (filePath) {
		window.maximize();
	}

	if (filePath) {
		window.webContents.send("editor:open", filePath);
		window.webContents.send("editor:path", join(app.getAppPath()));

		window.webContents.on("did-finish-load", () => {
			window.webContents.send("editor:open", filePath);
			window.webContents.send("editor:path", join(app.getAppPath()));
		});
	}
}

function notifyWindows(event: string, data: any) {
	BrowserWindow.getAllWindows().forEach((window) => {
		window.webContents.send(event, data);
	});
}
