const { app, BrowserWindow } = require("electron");

app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("disable-gpu-sandbox");

const page = process.env.ZVIBE_CONFORMANCE_PAGE;
const target = process.env.ZVIBE_CONFORMANCE_TARGET ?? "unknown";
const timeoutMs = Number(process.env.ZVIBE_CONFORMANCE_TIMEOUT_MS ?? 90_000);

async function finish(code, result, details) {
	process.stdout.write(`${JSON.stringify({ target, result, details })}\n`);
	app.exit(code);
}

app.whenReady().then(async () => {
	if (!page) {
		await finish(1, "failed", "ZVIBE_CONFORMANCE_PAGE is required.");
		return;
	}
	const window = new BrowserWindow({
		show: false,
		width: 128,
		height: 128,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	let rendererError = null;
	window.webContents.on("console-message", (event) => {
		process.stderr.write(`[renderer:${event.level}] ${event.message}\n`);
	});
	window.webContents.on("render-process-gone", (_event, details) => {
		rendererError = `Renderer process exited: ${details.reason} (${details.exitCode}).`;
	});
	window.webContents.on("did-fail-load", (_event, code, description) => {
		rendererError = `Page load failed: ${code} ${description}.`;
	});
	await window.loadFile(page);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !rendererError) {
		const state = await window.webContents.executeJavaScript(`({ result: document.body.dataset.result, details: document.body.dataset.details })`, true);
		if (state.result && state.result !== "running") {
			await finish(state.result === "passed" ? 0 : state.result === "unavailable" ? 2 : 1, state.result, state.details ?? null);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	await finish(1, "failed", rendererError ?? `Timed out after ${timeoutMs} ms.`);
});

app.on("window-all-closed", () => app.quit());
