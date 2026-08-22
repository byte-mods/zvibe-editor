import { platform, arch } from "os";
import { autoUpdater } from "electron-updater";
import { basename, dirname, join, resolve } from "path/posix";
import { BrowserWindow, app, globalShortcut, ipcMain, nativeTheme, nativeImage } from "electron";
import { watch } from "chokidar";

import "dotenv/config";

import { getFilePathArgument, getProjectRelaunchArguments } from "./tools/process";

import { ISetupEditorMenuOptions, setupEditorMenu } from "./editor/menu";

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

const platformRestartTargets = new Set(["web", "electron", "headless", "android", "ios"]);
const platformRestartArgumentPrefix = "--zvibe-platform-restart-";
// Leave enough time for the renderer IPC result and the editor's HTTP MCP bridge response to reach external clients before the process exits.
const platformRestartExitGracePeriodMs = 2_000;

function commandLineValue(name: string): string | null {
	const prefix = `--${name}=`;
	const argument = process.argv.find((value) => value.startsWith(prefix));
	return argument ? argument.slice(prefix.length) : null;
}

function getPlatformRestartStartupEvidence(): Record<string, string> | null {
	const target = commandLineValue("zvibe-platform-restart-target");
	const planId = commandLineValue("zvibe-platform-restart-plan");
	const diagnosticFingerprint = commandLineValue("zvibe-platform-restart-fingerprint");
	const requestedAtValue = commandLineValue("zvibe-platform-restart-requested-at");
	const projectValue = commandLineValue("zvibe-platform-restart-project");
	if (
		!target ||
		!platformRestartTargets.has(target) ||
		!planId ||
		!/^[a-f0-9-]{36}$/.test(planId) ||
		!diagnosticFingerprint ||
		!/^[a-f0-9]{64}$/.test(diagnosticFingerprint) ||
		!requestedAtValue ||
		!projectValue
	) {
		return null;
	}
	try {
		return {
			target,
			planId,
			diagnosticFingerprint,
			requestedAt: decodeURIComponent(requestedAtValue),
			projectPath: decodeURIComponent(projectValue),
			restartedAt: new Date().toISOString(),
		};
	} catch {
		return null;
	}
}

const platformRestartStartupEvidence = getPlatformRestartStartupEvidence();

const isDevelopment = !app.isPackaged || process.env.ZVIBE_DEVELOPMENT === "true";

try {
	if (isDevelopment) {
		process.env.DEBUG ??= "true";
	}

	process.env.SKETCHFAB_CLIENT_ID ??= "XZVigLIpz1lqWCkAMRWWpZzKIEVaMEIcsBrgQWrD";

	if (process.env.DEBUG) {
		// Main-process relaunch helpers preserve their original argv and can race an explicit
		// app.relaunch request, reopening a stale project/restart lease. The scoped watcher
		// below refreshes compiled renderer assets; main-process changes use a deliberate
		// development restart so there is exactly one owner of relaunch arguments.
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

// Enable remote debugging of both the Editor and the edited Project. A configurable
// development port allows isolated verification without disturbing another open editor.
const configuredRemoteDebuggingPort = Number(process.env.ZVIBE_REMOTE_DEBUGGING_PORT ?? 8315);
const remoteDebuggingPort =
	Number.isInteger(configuredRemoteDebuggingPort) && configuredRemoteDebuggingPort >= 1 && configuredRemoteDebuggingPort <= 65535 ? configuredRemoteDebuggingPort : 8315;
app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebuggingPort));

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

	const filePath = platformRestartStartupEvidence?.projectPath ?? getFilePathArgument(process.argv);
	if (filePath) {
		await openProject(filePath);
	} else {
		await openDashboard();
	}

	if (!isDevelopment && process.env.ZVIBE_EDITOR_ENABLE_AUTO_UPDATE === "true") {
		// The branded 1.x application must never consume legacy Babylon Editor
		// update bundles. Enable this only when a Zvibe-compatible feed is deployed.
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
const defaultEditorMenuOptions: ISetupEditorMenuOptions = { enableExperimentalFeatures: false, openedTabs: [] };
const editorMenuOptions = new WeakMap<BrowserWindow, ISetupEditorMenuOptions>();

ipcMain.on("editor:setup-menu", (event, options: unknown) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	if (!window || !editorWindows.includes(window)) {
		return;
	}
	const nextOptions = options && typeof options === "object" && !Array.isArray(options) ? (options as ISetupEditorMenuOptions) : defaultEditorMenuOptions;
	editorMenuOptions.set(window, nextOptions);
	setupEditorMenu(nextOptions);
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
const editorProjectPaths = new WeakMap<BrowserWindow, string>();

ipcMain.handle("editor:restart-for-installed-platform", async (event, request: unknown) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	if (!window || !editorWindows.includes(window)) {
		throw new Error("Installed-platform restart requests are accepted only from an active project editor window.");
	}
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		throw new Error("Installed-platform restart request must be an object.");
	}
	const input = request as Record<string, unknown>;
	const allowedKeys = new Set(["target", "planId", "projectPath", "diagnosticFingerprint", "requestedAt"]);
	if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
		throw new Error("Installed-platform restart request contains unsupported fields.");
	}
	if (
		typeof input.target !== "string" ||
		!platformRestartTargets.has(input.target) ||
		typeof input.planId !== "string" ||
		!/^[a-f0-9-]{36}$/.test(input.planId) ||
		typeof input.projectPath !== "string" ||
		input.projectPath !== editorProjectPaths.get(window) ||
		typeof input.diagnosticFingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.diagnosticFingerprint) ||
		typeof input.requestedAt !== "string" ||
		!Number.isFinite(Date.parse(input.requestedAt))
	) {
		throw new Error("Installed-platform restart request failed target, plan, project, fingerprint, or timestamp validation.");
	}
	const relaunchArguments = getProjectRelaunchArguments(process.argv, input.projectPath, [platformRestartArgumentPrefix]);
	relaunchArguments.push(
		`--zvibe-platform-restart-target=${input.target}`,
		`--zvibe-platform-restart-plan=${input.planId}`,
		`--zvibe-platform-restart-fingerprint=${input.diagnosticFingerprint}`,
		`--zvibe-platform-restart-requested-at=${encodeURIComponent(input.requestedAt)}`,
		`--zvibe-platform-restart-project=${encodeURIComponent(input.projectPath)}`
	);
	app.relaunch({ args: relaunchArguments });
	setTimeout(() => {
		shouldAppQuit = true;
		app.exit(0);
	}, platformRestartExitGracePeriodMs);
	return { scheduled: true, target: input.target, planId: input.planId, projectPath: input.projectPath };
});

async function openProject(filePath: string): Promise<void> {
	filePath = resolve(filePath);
	if (openedProjects.includes(filePath)) {
		return;
	}

	openedProjects.push(filePath);

	notifyWindows("dashboard:opened-projects", openedProjects);

	setupEditorMenu(defaultEditorMenuOptions);

	const window = await createEditorWindow();
	editorMenuOptions.set(window, defaultEditorMenuOptions);
	editorProjectPaths.set(window, filePath);
	window.setTitle(`Zvibe Editor — ${basename(dirname(filePath))}`);

	window.on("focus", () => setupEditorMenu(editorMenuOptions.get(window) ?? defaultEditorMenuOptions));
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
		if (platformRestartStartupEvidence?.projectPath === filePath) {
			window.webContents.send("editor:platform-restart-evidence", platformRestartStartupEvidence);
		}

		window.webContents.on("did-finish-load", () => {
			window.webContents.send("editor:open", filePath);
			window.webContents.send("editor:path", join(app.getAppPath()));
			if (platformRestartStartupEvidence?.projectPath === filePath) {
				window.webContents.send("editor:platform-restart-evidence", platformRestartStartupEvidence);
			}
		});
	}
}

function notifyWindows(event: string, data: any) {
	BrowserWindow.getAllWindows().forEach((window) => {
		window.webContents.send(event, data);
	});
}
