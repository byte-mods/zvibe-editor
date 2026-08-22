#!/usr/bin/env node
/** Physical Chromium-input smoke check for the currently served game. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectEditorUi } from "./electron-ui-harness.mjs";

const port = Number(process.env.BJS_GAME_CDP_PORT ?? 8316);
const gameUrl = process.env.BJS_GAME_URL ?? "http://localhost:3000/";
const chromeCandidates =
	process.platform === "darwin"
		? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
		: process.platform === "win32"
			? [join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"), join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe")]
			: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const chromeExecutable = process.env.BJS_GAME_CHROME_PATH ?? chromeCandidates.find(existsSync);
if (!chromeExecutable) throw new Error("Chrome or Chromium is required for the physical gameplay check. Set BJS_GAME_CHROME_PATH to its executable.");

const profilePath = await mkdtemp(join(tmpdir(), "zvibe-gameplay-check-"));
const chrome = spawn(
	chromeExecutable,
	[
		"--headless=new",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profilePath}`,
		"--no-first-run",
		"--disable-background-networking",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--enable-unsafe-swiftshader",
		"--use-angle=swiftshader-webgl",
		gameUrl,
	],
	{ stdio: "ignore" }
);

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
	try {
		const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
		if (targets.some((target) => target.type === "page" && target.url?.startsWith(gameUrl) && target.title === "Neon Apex: Wanted")) break;
	} catch {
		// Chrome is still starting.
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
}

let ui;
try {
	ui = await connectEditorUi("canvas", port, `document.title === "Neon Apex: Wanted" && location.href.startsWith(${JSON.stringify(gameUrl)})`);
} catch (error) {
	chrome.kill("SIGTERM");
	await rm(profilePath, { recursive: true, force: true });
	throw error;
}
try {
	ui.runtimeErrors.length = 0;
	ui.consoleEntries.length = 0;
	const canvas = await ui.elementRect("canvas");
	if (!canvas?.visible) throw new Error("The live game canvas is not visible.");
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	const gasFound = await ui.evaluate(
		`(() => { const button=[...document.querySelectorAll("button")].find((entry)=>entry.textContent?.trim()==="GAS"); if(!button)return false; button.setAttribute("data-gameplay-gas",""); return true; })()`
	);
	if (!gasFound) throw new Error("The live GAS control is missing.");
	const gas = await ui.elementRect("[data-gameplay-gas]");
	if (!gas?.visible) throw new Error("The live GAS control is not visible.");
	await ui.send("Input.dispatchMouseEvent", { type: "mousePressed", x: gas.x, y: gas.y, button: "left", clickCount: 1 });
	await new Promise((resolve) => setTimeout(resolve, 4_000));
	const evidence = await ui.evaluate(`(() => {
		const body = document.body.innerText;
		const speed = Number(body.match(/(\\d+) KM \\/ H/)?.[1] ?? -1);
		const lap = body.match(/LAP\\s*\\d+\\/\\d+/)?.[0].replace(/\\s+/g, " ") ?? null;
		const position = body.match(/POS\\s*\\d+\\/\\d+/)?.[0].replace(/\\s+/g, " ") ?? null;
		const time = body.match(/TIME\\s*\\d+:\\d+\\.\\d+/)?.[0].replace(/\\s+/g, " ") ?? null;
		return { speed, lap, position, time, title: document.title, visibleCanvas: [...document.querySelectorAll("canvas")].some((canvas) => { const rect=canvas.getBoundingClientRect(); return rect.width > 300 && rect.height > 150; }) };
	})()`);
	await ui.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: gas.x, y: gas.y, button: "left", clickCount: 1 });
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (!evidence.visibleCanvas || evidence.speed <= 0 || !evidence.lap || !evidence.position || !evidence.time) {
		throw new Error(`Gameplay did not respond to physical throttle input: ${JSON.stringify(evidence)}`);
	}
	await ui.clickText("CAM", "button");
	await ui.clickText("REAR", "button");
	await ui.clickText("RESET", "button");
	await new Promise((resolve) => setTimeout(resolve, 500));
	const resetSpeed = await ui.evaluate(`Number(document.body.innerText.match(/(\\d+) KM \\/ H/)?.[1] ?? -1)`);
	if (resetSpeed < 0 || resetSpeed > 5) throw new Error(`RESET did not return the car to a stopped state: ${resetSpeed} KM/H.`);
	if (ui.runtimeErrors.length) throw new Error(`Unexpected renderer errors during gameplay: ${JSON.stringify(ui.runtimeErrors)}`);
	console.log(
		`[gameplay-manual] PASS — physical GAS hold reached ${evidence.speed} KM/H; ${evidence.lap}, ${evidence.position}, ${evidence.time}; CAM, REAR, and RESET controls responded; reset speed ${resetSpeed} KM/H; live canvas and HUD remained visible.`
	);
} finally {
	ui.socket.close();
	chrome.kill("SIGTERM");
	await rm(profilePath, { recursive: true, force: true });
}
