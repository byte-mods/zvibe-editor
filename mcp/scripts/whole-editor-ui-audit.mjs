#!/usr/bin/env node
/**
 * Physical Electron smoke/stress audit for every permanent Zvibe Editor workspace.
 *
 * This intentionally uses Chromium input events instead of calling React handlers.
 * Family-specific live scenarios perform the destructive authoring lifecycles; this
 * gate proves that every permanent surface can be reached, rendered, scrolled, and
 * initialized against the currently open project without renderer failures.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { connectEditorUi, waitForUi } from "./electron-ui-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
let profilerActiveByAudit = false;
let profilerBaselineIds = new Set();
let ecsCreatedByAudit = false;
let debugPlayStartedByAudit = false;
let hostStartedByAudit = false;
let adaptiveEnabledByAudit = false;
let runtimeAiBaselineIds = new Set();
let runtimeModelPath = null;

child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	for (let newline; (newline = stdout.indexOf("\n")) >= 0; ) {
		const line = stdout.slice(0, newline).trim();
		stdout = stdout.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function sameStringSet(actual, expected) {
	return actual.length === expected.length && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function rpc(method, params, timeoutMs = 120_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	if (response.error || result?.isError) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	const text = result?.content?.find((entry) => entry.type === "text")?.text;
	return text ? JSON.parse(text) : result;
}

async function listTools() {
	const result = [];
	let cursor;
	do {
		const response = await rpc("tools/list", cursor ? { cursor } : {});
		if (response.error) throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
		result.push(...(response.result?.tools ?? []));
		cursor = response.result?.nextCursor;
	} while (cursor);
	return result;
}

async function findRuntimeModel(projectPath) {
	const projectDirectory = dirname(projectPath);
	const jobsDirectory = join(projectDirectory, ".bjseditor", "ml-training", "jobs");
	try {
		const entries = await readdir(jobsDirectory, { recursive: true });
		const entry = entries.find((path) => /\.(onnx|tflite|pt2)$/i.test(path));
		return entry ? relative(projectDirectory, join(jobsDirectory, entry)).replaceAll("\\", "/") : null;
	} catch {
		return null;
	}
}

const expectedTabs = [
	{ id: "graph", name: "Graph" },
	{ id: "preview", name: "Preview" },
	{ id: "assets-browser", name: "Assets Browser" },
	{ id: "animations", name: "Animations" },
	{ id: "console", name: "Console" },
	{ id: "profiler", name: "Profiler" },
	{ id: "entities", name: "Entities" },
	{ id: "lighting-search", name: "Lighting Search" },
	{ id: "script-debugger", name: "Script Debugger" },
	{ id: "project-auditor", name: "Project Auditor" },
	{ id: "runtime-ai", name: "Runtime AI" },
	{ id: "ml-training", name: "ML Training" },
	{ id: "generative-assets", name: "Generative Assets" },
	{ id: "services", name: "Services" },
	{ id: "occlusion-culling", name: "Occlusion Culling" },
	{ id: "networking", name: "Networking" },
	{ id: "mobile", name: "Mobile" },
	{ id: "console-server", name: "Console & Server" },
	{ id: "terminal", name: "Terminal" },
	{ id: "marketplace", name: "Marketplace" },
	{ id: "inspector", name: "Inspector" },
];

function selectedPanelExpression(name) {
	return `(() => {
		const button = [...document.querySelectorAll(".flexlayout__tab_button")].find((entry) => entry.textContent?.trim() === ${JSON.stringify(name)});
		if (!button) return null;
		const path = button.getAttribute("data-layout-path") ?? "";
		const panelPath = path.replace("/tb", "/t");
		const panel = [...document.querySelectorAll(".flexlayout__tab")].find((entry) => entry.getAttribute("data-layout-path") === panelPath);
		if (!panel) return { selected: button.classList.contains("flexlayout__tab_button--selected"), panel: false };
		panel.setAttribute("data-whole-editor-selected", ${JSON.stringify(name)});
		const rect = panel.getBoundingClientRect();
		return {
			selected: button.classList.contains("flexlayout__tab_button--selected"),
			panel: true,
			width: rect.width,
			height: rect.height,
			text: (panel.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 1_500),
			canvasCount: panel.querySelectorAll("canvas").length,
			inputCount: panel.querySelectorAll("input,textarea,select").length,
			buttonCount: panel.querySelectorAll("button,[role=button]").length,
			errorBoundary: (panel.innerText ?? "").includes("Error rendering component"),
		};
	})()`;
}

function panelSelector(name) {
	return `[data-whole-editor-selected=${JSON.stringify(name)}]`;
}

async function replaceText(selector, value) {
	// Clear through the native setter so React receives the same input event as
	// the real control, then exercise non-empty entry through Chromium text input.
	await ui.setValue(selector, "");
	await ui.click(selector);
	if (value) await ui.send("Input.insertText", { text: value });
	await waitForUi(
		() => ui.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`),
		(current) => current === value,
		`${selector} value ${JSON.stringify(value)}`
	);
}

async function typeTerminalCommand(command) {
	assert(/^[a-z0-9 ]+$/.test(command), "Terminal audit commands are restricted to lower-case letters, digits, and spaces.");
	for (const character of command) {
		const letter = /[a-z]/.test(character);
		const digit = /[0-9]/.test(character);
		const virtualKeyCode = letter ? character.toUpperCase().charCodeAt(0) : digit ? character.charCodeAt(0) : 32;
		const code = letter ? `Key${character.toUpperCase()}` : digit ? `Digit${character}` : "Space";
		await ui.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: character,
			code,
			windowsVirtualKeyCode: virtualKeyCode,
			nativeVirtualKeyCode: virtualKeyCode,
			text: character,
			unmodifiedText: character,
		});
		await ui.send("Input.dispatchKeyEvent", { type: "keyUp", key: character, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
	}
	await ui.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
		nativeVirtualKeyCode: 13,
		text: "\r",
		unmodifiedText: "\r",
	});
	await ui.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

async function clickWithinText(name, text, candidateSelector = "button,[role=button]") {
	console.log(`[whole-editor-ui-audit] action ${name} → ${text}`);
	const selector = panelSelector(name);
	const findExpression = (scroll) => `(() => {
		const panel=document.querySelector(${JSON.stringify(selector)});
		const expected=${JSON.stringify(text.toLowerCase())};
		const element=[...(panel?.querySelectorAll(${JSON.stringify(candidateSelector)})??[])].find((entry)=>entry.textContent?.trim().toLowerCase()===expected);
		if(!element)return null;
		${scroll ? 'element.scrollIntoView({block:"center",inline:"center"});' : ""}
		const rect=element.getBoundingClientRect();
		const x=rect.left+rect.width/2;
		const y=rect.top+rect.height/2;
		const hit=x>=0&&x<innerWidth&&y>=0&&y<innerHeight?document.elementFromPoint(x,y):null;
		return {x,y,width:rect.width,height:rect.height,visible:rect.width>0&&rect.height>0&&(hit===element||element.contains(hit)),disabled:Boolean(element.disabled)};
	})()`;
	assert(await ui.evaluate(findExpression(true)), `${name} action was not found: ${text}`);
	for (let attempt = 0; attempt < 5; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 75));
		const rect = await ui.evaluate(findExpression(false));
		if (rect?.visible && !rect.disabled) {
			await ui.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			await ui.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			return;
		}
		await ui.evaluate(findExpression(true));
	}
	throw new Error(`${name} action remained hidden or disabled: ${text}`);
}

async function clickWithinSectionText(name, sectionTitle, text) {
	console.log(`[whole-editor-ui-audit] action ${name} → ${sectionTitle} / ${text}`);
	const findExpression = (scroll) => `(() => {
		const panel=document.querySelector(${JSON.stringify(panelSelector(name))});
		const title=${JSON.stringify(sectionTitle.toLowerCase())};
		const expected=${JSON.stringify(text.toLowerCase())};
		const section=[...(panel?.querySelectorAll("section")??[])].find((entry)=>entry.firstElementChild?.textContent?.trim().toLowerCase()===title);
		const element=[...(section?.querySelectorAll("button,[role=button]")??[])].find((entry)=>entry.textContent?.trim().toLowerCase()===expected);
		if(!element)return null;
		${scroll ? 'element.scrollIntoView({block:"center",inline:"center"});' : ""}
		const rect=element.getBoundingClientRect();
		const x=rect.left+rect.width/2;
		const y=rect.top+rect.height/2;
		const hit=x>=0&&x<innerWidth&&y>=0&&y<innerHeight?document.elementFromPoint(x,y):null;
		return {x,y,width:rect.width,height:rect.height,visible:rect.width>0&&rect.height>0&&(hit===element||element.contains(hit)),disabled:Boolean(element.disabled)};
	})()`;
	assert(await ui.evaluate(findExpression(true)), `${name} section action was not found: ${sectionTitle} / ${text}`);
	for (let attempt = 0; attempt < 5; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 75));
		const rect = await ui.evaluate(findExpression(false));
		if (rect?.visible && !rect.disabled) {
			await ui.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			await ui.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			return;
		}
		await ui.evaluate(findExpression(true));
	}
	throw new Error(`${name} section action remained hidden or disabled: ${sectionTitle} / ${text}`);
}

async function clickWithinSectionCheckbox(name, sectionTitle, label) {
	console.log(`[whole-editor-ui-audit] action ${name} → ${sectionTitle} / ${label}`);
	const findExpression = (scroll) => `(() => {
		const panel=document.querySelector(${JSON.stringify(panelSelector(name))});
		const title=${JSON.stringify(sectionTitle.toLowerCase())};
		const expected=${JSON.stringify(label.toLowerCase())};
		const section=[...(panel?.querySelectorAll("section")??[])].find((entry)=>entry.firstElementChild?.textContent?.trim().toLowerCase()===title);
		const owner=[...(section?.querySelectorAll("label")??[])].find((entry)=>entry.textContent?.trim().toLowerCase()===expected);
		const element=owner?.querySelector('input[type="checkbox"]');
		if(!element)return null;
		${scroll ? 'element.scrollIntoView({block:"center",inline:"center"});' : ""}
		const rect=element.getBoundingClientRect();
		const x=rect.left+rect.width/2;
		const y=rect.top+rect.height/2;
		const hit=x>=0&&x<innerWidth&&y>=0&&y<innerHeight?document.elementFromPoint(x,y):null;
		return {x,y,width:rect.width,height:rect.height,visible:rect.width>0&&rect.height>0&&(hit===element||element.contains(hit)),disabled:Boolean(element.disabled)};
	})()`;
	assert(await ui.evaluate(findExpression(true)), `${name} section checkbox was not found: ${sectionTitle} / ${label}`);
	for (let attempt = 0; attempt < 5; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 75));
		const rect = await ui.evaluate(findExpression(false));
		if (rect?.visible && !rect.disabled) {
			await ui.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			await ui.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			return;
		}
		await ui.evaluate(findExpression(true));
	}
	throw new Error(`${name} section checkbox remained hidden or disabled: ${sectionTitle} / ${label}`);
}

async function waitWithinTextEnabled(name, text, timeoutMs = 45_000) {
	const selector = panelSelector(name);
	await waitForUi(
		() =>
			ui.evaluate(`(() => {
				const panel=document.querySelector(${JSON.stringify(selector)});
				const expected=${JSON.stringify(text.toLowerCase())};
				const element=[...(panel?.querySelectorAll("button,[role=button]")??[])].find((entry)=>entry.textContent?.trim().toLowerCase()===expected);
				if(!element)return false;
				const rect=element.getBoundingClientRect();
				return !element.disabled&&rect.width>0&&rect.height>0;
			})()`),
		Boolean,
		`${name} enabled action ${text}`,
		timeoutMs
	);
}

async function selectPermanentTab(tab) {
	const target = await ui.evaluate(`(() => {
		const button=[...document.querySelectorAll(".flexlayout__tab_button")].find((entry)=>entry.textContent?.trim()===${JSON.stringify(tab.name)});
		if(!button)return null;
		const rect=button.getBoundingClientRect();
		const x=rect.left+rect.width/2;
		const y=rect.top+rect.height/2;
		const hit=x>=0&&x<innerWidth&&y>=0&&y<innerHeight?document.elementFromPoint(x,y):null;
		const tabset=button.closest(".flexlayout__tabset");
		return {visible:rect.width>0&&rect.height>0&&(hit===button||button.contains(hit)),tabsetPath:tabset?.getAttribute("data-layout-path")??null};
	})()`);
	assert(target, `Permanent tab button is missing: ${tab.name}`);
	if (target.visible) await ui.clickText(tab.name, ".flexlayout__tab_button");
	else {
		assert(target.tabsetPath, `Hidden ${tab.name} tab has no owning tabset.`);
		await ui.click(`[data-layout-path=${JSON.stringify(`${target.tabsetPath}/button/overflow`)}]`);
		await waitForUi(() => ui.evaluate("Boolean(document.querySelector('.flexlayout__popup_menu'))"), Boolean, `${tab.name} overflow menu`);
		await ui.clickText(tab.name, ".flexlayout__popup_menu_item");
	}
}

async function exerciseSafeTab(tab) {
	const panel = panelSelector(tab.name);
	switch (tab.id) {
		case "graph": {
			const search = `${panel} input[placeholder="Search..."]`;
			await replaceText(search, "rigging");
			await replaceText(search, "");
			break;
		}
		case "preview": {
			const rect = await ui.elementRect(`${panel} canvas`);
			assert(rect?.visible, "Preview canvas is not physically reachable.");
			await ui.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x - 8, y: rect.y - 5 });
			await ui.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x - 8, y: rect.y - 5, button: "left", buttons: 1, clickCount: 1 });
			await ui.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + 8, y: rect.y + 5, button: "left", buttons: 1 });
			await ui.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + 8, y: rect.y + 5, button: "left", buttons: 0, clickCount: 1 });
			await ui.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x, y: rect.y, deltaY: 24, deltaX: 0 });
			break;
		}
		case "assets-browser": {
			const search = `${panel} input[placeholder="Search"]`;
			await replaceText(search, "rigging");
			await replaceText(search, "");
			const refresh = `${panel} button[title="Refresh"]`;
			if (await ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(refresh)}))`)) await ui.click(refresh);
			break;
		}
		case "animations":
			for (const name of ["Behavior Trees", "Timeline", "Animation Window", "2D Animation", "Animator", "Visual Scripting", "Compute Graph", "Timeline"]) {
				await clickWithinText(tab.name, name);
				await new Promise((resolve) => setTimeout(resolve, 200));
				const state = await ui.evaluate(selectedPanelExpression(tab.name));
				assert(!state.errorBoundary, `${name} rendered an Animations error boundary.`);
			}
			break;
		case "console": {
			const marker = `ZVIBE_UI_CONSOLE_${Date.now().toString(36)}`;
			await call("write_editor_console", { message: marker, level: "log" });
			await waitForUi(
				() => ui.evaluate(`document.querySelector(${JSON.stringify(panel)})?.innerText ?? ""`),
				(text) => text.includes(marker),
				"physical Console marker"
			);
			await clickWithinText(tab.name, "Clear");
			await waitForUi(
				() => ui.evaluate(`document.querySelector(${JSON.stringify(panel)})?.innerText ?? ""`),
				(text) => !text.includes(marker),
				"physical Console clear"
			);
			break;
		}
		case "profiler": {
			for (const view of ["hierarchy", "inverted hierarchy", "raw hierarchy", "memory", "assets", "2d atlas", "timeline"]) await clickWithinText(tab.name, view);
			const baseline = await call("get_profiler_state");
			assert(!baseline.active, "Profiler already has an active capture; refusing to disturb it.");
			profilerBaselineIds = new Set(baseline.captures.map((capture) => capture.id));
			const targetSelector = `${panel} select`;
			const originalTarget = await ui.evaluate(`document.querySelector(${JSON.stringify(targetSelector)})?.value`);
			await ui.setValue(targetSelector, "editor-edit");
			await clickWithinText(tab.name, "Record");
			profilerActiveByAudit = true;
			await waitForUi(
				() => ui.evaluate(selectedPanelExpression(tab.name)),
				(state) => state?.text.includes("Stop") && state.text.includes("Cancel"),
				"Profiler recording state"
			);
			await waitForUi(
				() =>
					ui.evaluate(
						`(() => { const panel=document.querySelector(${JSON.stringify(panel)}); const stop=[...(panel?.querySelectorAll("button")??[])].find((entry)=>entry.textContent?.trim()==="Stop"); const record=[...(panel?.querySelectorAll("button")??[])].find((entry)=>entry.textContent?.trim()==="Record"); return {stopEnabled:Boolean(stop&&!stop.disabled&&stop.getBoundingClientRect().width>0),autoStopped:Boolean(record&&!record.disabled&&record.getBoundingClientRect().width>0)}; })()`
					),
				(state) => state.stopEnabled || state.autoStopped,
				"Profiler start mutation completion"
			);
			await new Promise((resolve) => setTimeout(resolve, 800));
			const canStop = await ui.evaluate(
				`(() => { const panel=document.querySelector(${JSON.stringify(panel)}); const stop=[...(panel?.querySelectorAll("button")??[])].find((entry)=>entry.textContent?.trim()==="Stop"); return Boolean(stop&&!stop.disabled&&stop.getBoundingClientRect().width>0); })()`
			);
			if (canStop) await clickWithinText(tab.name, "Stop");
			profilerActiveByAudit = false;
			await waitForUi(
				() => call("get_profiler_state"),
				(state) => !state.active && state.captures.some((capture) => !profilerBaselineIds.has(capture.id) && capture.frameCount > 0),
				"retained physical Profiler capture"
			);
			await clickWithinText(tab.name, "Delete");
			await waitForUi(() => ui.evaluate("Boolean(document.querySelector('[role=alertdialog]'))"), Boolean, "Profiler delete confirmation");
			await ui.clickText("Delete", "[role=alertdialog] button");
			await waitForUi(
				() => call("get_profiler_state"),
				(state) => state.captures.every((capture) => profilerBaselineIds.has(capture.id)),
				"Profiler capture cleanup"
			);
			await ui.setValue(targetSelector, originalTarget);
			break;
		}
		case "entities": {
			for (const view of ["Configuration", "Entities", "Systems", "Traces", "Overview"]) await clickWithinText(tab.name, view);
			const baseline = await call("inspect_ecs");
			if (!baseline.authored) {
				await clickWithinText(tab.name, "Create ECS Asset");
				ecsCreatedByAudit = true;
				await waitForUi(
					() => call("inspect_ecs"),
					(state) => state.authored,
					"physical ECS asset creation"
				);
				await clickWithinText(tab.name, "Full Bake");
				let inspection = await waitForUi(
					() => call("inspect_ecs"),
					(state) => Boolean(state.runtime),
					"physical ECS full bake",
					120_000
				);
				if (inspection.runtime.status !== "running") {
					await clickWithinText(tab.name, "Start");
					inspection = await waitForUi(
						() => call("inspect_ecs"),
						(state) => state.runtime?.status === "running",
						"physical ECS runtime start"
					);
				}
				await clickWithinText(tab.name, "Pause");
				await waitForUi(
					() => call("inspect_ecs"),
					(state) => state.runtime?.status === "paused",
					"physical ECS runtime pause"
				);
				await clickWithinText(tab.name, "Step 1/60");
				await clickWithinText(tab.name, "Delete ECS Asset");
				await waitForUi(() => ui.evaluate("Boolean(document.querySelector('[role=alertdialog]'))"), Boolean, "ECS delete confirmation");
				await ui.clickText("Delete", "[role=alertdialog] button");
				await waitForUi(
					() => call("inspect_ecs"),
					(state) => !state.authored,
					"physical ECS asset cleanup"
				);
				ecsCreatedByAudit = false;
			}
			break;
		}
		case "lighting-search": {
			const search = `${panel} input[placeholder="Search names, types, and lighting properties"]`;
			await replaceText(search, "camera");
			await clickWithinText(tab.name, "Search");
			await waitForUi(
				() => ui.evaluate(`document.querySelector(${JSON.stringify(`${panel} [data-testid="lighting-search-workspace"]`)})?.getAttribute("data-provider")`),
				Boolean,
				"Lighting Search query completion"
			);
			for (const query of ["All Mesh Renderers", "All Lights"]) await clickWithinText(tab.name, query, "button");
			await replaceText(search, "");
			break;
		}
		case "script-debugger": {
			for (const view of ["Coverage", "Templates", "Debugger"]) await clickWithinText(tab.name, view);
			let capabilities = await call("get_script_debugger_capabilities");
			if (capabilities.debuggingEnabled) {
				await waitWithinTextEnabled(tab.name, "Disable Debug Play", 120_000);
				await clickWithinText(tab.name, "Disable Debug Play");
				await waitWithinTextEnabled(tab.name, "Start Debug Play", 120_000);
				if (capabilities.play.playing) await call("set_preview_play_mode", { action: "stop" });
				capabilities = await call("get_script_debugger_capabilities");
			}
			if (!capabilities.play.playing) {
				await clickWithinText(tab.name, "Start Debug Play");
				debugPlayStartedByAudit = true;
				await waitForUi(
					() => ui.evaluate(selectedPanelExpression(tab.name)),
					(state) => state?.text.includes("Disable Debug Play") && state.text.includes("Pause Scripts"),
					"physical Debug Play start",
					120_000
				);
				await waitWithinTextEnabled(tab.name, "Pause Scripts", 120_000);
				await clickWithinText(tab.name, "Pause Scripts");
				await waitForUi(
					() => ui.evaluate(selectedPanelExpression(tab.name)),
					(state) => state?.text.includes("Resume Scripts"),
					"physical script pause"
				);
				await waitWithinTextEnabled(tab.name, "Step 1/60");
				await clickWithinText(tab.name, "Step 1/60");
				await waitWithinTextEnabled(tab.name, "Coverage Off");
				await clickWithinText(tab.name, "Coverage Off");
				await waitForUi(
					() => ui.evaluate(selectedPanelExpression(tab.name)),
					(state) => state?.text.includes("Coverage On"),
					"physical source coverage enable"
				);
				await waitWithinTextEnabled(tab.name, "Coverage On");
				await clickWithinText(tab.name, "Coverage On");
				await waitWithinTextEnabled(tab.name, "Resume Scripts");
				await clickWithinText(tab.name, "Resume Scripts");
				await waitWithinTextEnabled(tab.name, "Disable Debug Play", 120_000);
				await clickWithinText(tab.name, "Disable Debug Play");
				await waitWithinTextEnabled(tab.name, "Start Debug Play", 120_000);
				await call("set_preview_play_mode", { action: "stop" });
				debugPlayStartedByAudit = false;
			}
			break;
		}
		case "project-auditor": {
			await clickWithinText(tab.name, "Run Project Audit");
			const auditStatus = await waitForUi(
				() => ui.evaluate(`document.querySelector(${JSON.stringify(`${panel} [data-project-auditor-status]`)})?.getAttribute("data-project-auditor-status")`),
				(value) => ["completed", "failed", "cancelled"].includes(value),
				"physical Project Auditor completion",
				120_000
			);
			assert(auditStatus === "completed", `Project Auditor ended in ${auditStatus}.`);
			for (const category of ["serialization", "obsolete-api", "particle-texture-readability", "atlas-waste", "all"]) {
				await clickWithinText(tab.name, category, "button");
			}
			break;
		}
		case "runtime-ai": {
			const input = `${panel} [data-runtime-ai-model-path]`;
			await replaceText(input, "assets/__zvibe_ui_missing_model__.onnx");
			await ui.click(`${panel} [data-runtime-ai-inspect]`);
			await waitForUi(
				() => ui.evaluate(`document.querySelector(${JSON.stringify(`${panel} [data-runtime-ai-state]`)})?.getAttribute("data-runtime-ai-state")`),
				(state) => state === "error",
				"Runtime AI invalid-path diagnosis"
			);
			if (runtimeModelPath) {
				const baseline = await call("list_runtime_ai_sessions");
				runtimeAiBaselineIds = new Set(baseline.sessions.map((session) => session.id));
				await replaceText(input, runtimeModelPath);
				await ui.click(`${panel} [data-runtime-ai-inspect]`);
				await waitForUi(
					() => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${panel} [data-runtime-ai-inspection]`)}))`),
					Boolean,
					"Runtime AI valid model recovery",
					120_000
				);
				await ui.click(`${panel} [data-runtime-ai-create]`);
				await waitForUi(
					() => call("list_runtime_ai_sessions"),
					(state) => state.sessions.some((session) => !runtimeAiBaselineIds.has(session.id)),
					"physical Runtime AI session creation"
				);
				await ui.click(`${panel} [data-runtime-ai-dispose]`);
				await waitForUi(
					() => call("list_runtime_ai_sessions"),
					(state) => state.sessions.every((session) => runtimeAiBaselineIds.has(session.id)),
					"physical Runtime AI session disposal"
				);
			}
			break;
		}
		case "ml-training":
			for (const value of ["dataset", "trainers", "results", "authoring"]) await ui.click(`${panel} [data-ml-training-tab=${JSON.stringify(value)}]`);
			await ui.click(`${panel} [data-ml-training-refresh]`);
			break;
		case "generative-assets":
			for (const value of ["providers", "results", "generate"]) await ui.click(`${panel} [data-generative-tab=${JSON.stringify(value)}]`);
			await ui.click(`${panel} [data-generative-refresh]`);
			break;
		case "services":
			await ui.click(`${panel} [data-project-services-refresh]`);
			await waitForUi(
				() => ui.evaluate(`document.querySelector(${JSON.stringify(`${panel} [data-project-services-workspace]`)})?.getAttribute("data-project-services-state")`),
				(state) => state === "ready",
				"Services refresh"
			);
			break;
		case "occlusion-culling":
			for (const value of ["bake", "visualization", "object"]) await ui.click(`${panel} [data-occlusion-tab=${JSON.stringify(value)}]`);
			break;
		case "networking": {
			const baseline = await call("get_gameplay_session_host_status");
			if (!baseline.listening) {
				await clickWithinText(tab.name, "Start Loopback Host");
				hostStartedByAudit = true;
				await waitForUi(
					() => call("get_gameplay_session_host_status"),
					(state) => state.listening,
					"physical loopback host start"
				);
				await clickWithinText(tab.name, "Stop Host");
				await waitForUi(() => ui.evaluate("Boolean(document.querySelector('[role=alertdialog]'))"), Boolean, "gameplay host stop confirmation");
				await ui.clickText("Stop Host", "[role=alertdialog] button");
				await waitForUi(
					() => call("get_gameplay_session_host_status"),
					(state) => !state.listening,
					"physical loopback host stop"
				);
				hostStartedByAudit = false;
			}
			break;
		}
		case "mobile":
			await clickWithinText(tab.name, "iOS");
			await clickWithinText(tab.name, "Android");
			await waitForUi(
				() =>
					ui.evaluate(
						`(() => { const panel=document.querySelector(${JSON.stringify(panel)}); const button=[...(panel?.querySelectorAll("button")??[])].find((entry)=>entry.textContent?.trim()==="Refresh Toolchain"); return Boolean(button && !button.disabled); })()`
					),
				Boolean,
				"Mobile toolchain refresh availability"
			);
			await clickWithinText(tab.name, "Refresh Toolchain");
			if (!(await call("get_adaptive_performance_configuration")).configuration.enabled) {
				await clickWithinSectionCheckbox(tab.name, "Adaptive Performance · Basic and Apple Thermal", "Runtime enabled");
				adaptiveEnabledByAudit = true;
				await waitForUi(
					() => call("get_adaptive_performance_configuration"),
					(state) => state.configuration.enabled,
					"physical adaptive runtime enable"
				);
			}
			await clickWithinSectionText(tab.name, "Adaptive Performance · Basic and Apple Thermal", "Simulate serious");
			await waitForUi(
				() => call("get_adaptive_performance_runtime"),
				(state) => state.runtime.thermalState === "serious",
				"physical adaptive thermal simulation"
			);
			await clickWithinSectionText(tab.name, "Adaptive Performance · Basic and Apple Thermal", "Reset Evidence");
			await waitForUi(
				() => call("get_adaptive_performance_runtime"),
				(state) => state.runtime.thermalState === "unknown" && state.runtime.temperatureLevel === null && state.runtime.thermalWarning === false,
				"physical adaptive thermal reset"
			);
			await clickWithinSectionText(tab.name, "Android Insets · iOS Thermal FPS", "Simulate Serious / 30");
			await waitForUi(
				() => call("get_mobile_system_runtime"),
				(state) => state.runtime.thermalState === "serious" && state.runtime.appliedTargetFrameRate === 30,
				"physical mobile thermal simulation"
			);
			await clickWithinSectionText(tab.name, "Android Insets · iOS Thermal FPS", "Simulate Insets");
			await waitForUi(
				() => call("get_mobile_system_runtime"),
				(state) => state.runtime.windowInsets.top === 48 && state.runtime.windowInsets.bottom === 72,
				"physical mobile inset simulation"
			);
			await clickWithinSectionText(tab.name, "Android Insets · iOS Thermal FPS", "Reset Evidence");
			await waitForUi(
				() => call("get_mobile_system_runtime"),
				(state) => state.runtime.thermalState === "unknown" && state.runtime.windowInsets.top === 0 && state.runtime.windowInsets.bottom === 0,
				"physical mobile-system evidence reset"
			);
			if (adaptiveEnabledByAudit) {
				const undo = await call("undo_editor");
				assert(undo.undone, "Adaptive Performance enable did not register an undo snapshot.");
				await waitForUi(
					() => call("get_adaptive_performance_configuration"),
					(state) => !state.configuration.enabled,
					"adaptive configuration restoration"
				);
				adaptiveEnabledByAudit = false;
			}
			break;
		case "console-server":
			await clickWithinText(tab.name, "Validate Exact Target");
			await waitForUi(
				() => ui.evaluate(selectedPanelExpression(tab.name)),
				(state) => state?.text.includes("Profile:") && state.text.includes("Scaffold:"),
				"physical Console & Server validation",
				120_000
			);
			break;
		case "terminal": {
			await ui.click(`${panel} .xterm-screen`);
			const marker = `zvibeuiterminal${Date.now().toString(36)}`;
			await typeTerminalCommand(`echo ${marker}`);
			await waitForUi(
				() => ui.evaluate(`document.querySelector(${JSON.stringify(`${panel} .xterm-accessibility-tree`)})?.innerText ?? ""`),
				(text) => text.includes(marker),
				"physical terminal command",
				30_000
			);
			break;
		}
		case "marketplace": {
			const search = `${panel} input[placeholder="Search marketplace..."]`;
			await replaceText(search, "wood material");
			await ui.pressKey("Enter", "Enter");
			await new Promise((resolve) => setTimeout(resolve, 400));
			await replaceText(search, "");
			break;
		}
		case "inspector": {
			const search = `${panel} input[placeholder="Search..."]`;
			await replaceText(search, "terrain");
			await clickWithinText(tab.name, "Decal");
			await clickWithinText(tab.name, "Entity");
			await replaceText(search, "");
			break;
		}
	}
}

let ui = null;
try {
	await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "whole-editor-ui-audit", version: "1.0.0" } });
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	assert(status.ready, "The Editor MCP bridge is not ready.");
	runtimeModelPath = await findRuntimeModel(status.projectPath);
	profilerBaselineIds = new Set((await call("get_profiler_state")).captures.map((capture) => capture.id));
	runtimeAiBaselineIds = new Set((await call("list_runtime_ai_sessions")).sessions.map((session) => session.id));

	const tools = await listTools();
	const selectTool = tools.find((entry) => entry.name === "select_editor_tab");
	assert(selectTool, "select_editor_tab is missing from the external MCP catalog.");
	const enumValues = selectTool.inputSchema?.properties?.tab?.enum ?? [];
	assert(
		sameStringSet(
			enumValues,
			expectedTabs.map((entry) => entry.id)
		),
		`select_editor_tab enum mismatch: ${JSON.stringify(enumValues)}`
	);
	const listed = await call("list_editor_tabs");
	assert(
		sameStringSet(
			listed.tabs,
			expectedTabs.map((entry) => entry.id)
		),
		`list_editor_tabs mismatch: ${JSON.stringify(listed.tabs)}`
	);

	ui = await connectEditorUi(".flexlayout__tab_button");
	const results = [];
	for (const tab of expectedTabs) {
		console.log(`[whole-editor-ui-audit] selecting ${tab.name}`);
		await selectPermanentTab(tab);
		const state = await waitForUi(
			() => ui.evaluate(selectedPanelExpression(tab.name)),
			(value) => value?.selected && value.panel && value.width > 0 && value.height > 0,
			`${tab.name} panel selection`
		);
		await new Promise((resolve) => setTimeout(resolve, ["Profiler", "Entities", "Lighting Search"].includes(tab.name) ? 1_500 : 400));
		const settled = await ui.evaluate(selectedPanelExpression(tab.name));
		assert(!settled.errorBoundary, `${tab.name} rendered an error boundary.`);
		assert(settled.text.length > 0 || settled.canvasCount > 0, `${tab.name} rendered no meaningful UI content.`);

		const rect = await ui.elementRect(`[data-whole-editor-selected=${JSON.stringify(tab.name)}]`);
		if (rect?.visible) {
			await ui.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
			await ui.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x, y: rect.y, deltaY: 700, deltaX: 0 });
			await ui.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x, y: rect.y, deltaY: -700, deltaX: 0 });
		}

		if (tab.id === "profiler") assert(!settled.text.includes("Open a scene to profile it."), "Profiler did not recover after the Preview scene became available.");
		if (tab.id === "entities") assert(!settled.text.includes("Open a scene to inspect Entities."), "Entities did not recover after the Preview scene became available.");
		if (tab.id === "lighting-search") assert(!settled.text.includes("Loading lighting-search data"), "Lighting Search did not complete its initial scene synchronization.");
		console.log(`[whole-editor-ui-audit] exercising ${tab.name}`);
		await exerciseSafeTab(tab);
		results.push({ id: tab.id, text: settled.text.slice(0, 160), canvases: settled.canvasCount, inputs: settled.inputCount, buttons: settled.buttonCount });
	}

	await new Promise((resolve) => setTimeout(resolve, 500));
	assert(ui.runtimeErrors.length === 0, `Renderer errors were captured: ${JSON.stringify(ui.runtimeErrors)}`);
	console.log(
		JSON.stringify(
			{ status: "PASS", toolCount: tools.length, tabCount: results.length, projectPath: status.projectPath, activeScenePath: status.activeScenePath, results },
			null,
			2
		)
	);
} catch (error) {
	console.error(`[whole-editor-ui-audit] FAIL — ${error.message}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		let profiler = await call("get_profiler_state");
		if (profilerActiveByAudit && profiler.active) {
			await call("stop_profiler_capture", { expectedRevision: profiler.revision, id: profiler.active.id, cancel: true, confirm: true });
			profiler = await call("get_profiler_state");
		}
		for (const capture of profiler.captures.filter((entry) => !profilerBaselineIds.has(entry.id))) {
			await call("delete_profiler_capture", { expectedRevision: profiler.revision, id: capture.id, confirm: true });
			profiler = await call("get_profiler_state");
		}
		if (ecsCreatedByAudit) {
			const ecs = await call("inspect_ecs");
			if (ecs.authored) {
				await call("delete_ecs_configuration", { expectedRevision: ecs.configuration.revision, expectedFingerprint: ecs.fingerprint, confirm: true });
			}
		}
		if (debugPlayStartedByAudit) {
			await call("prepare_script_debugger", { enabled: false });
			await call("set_preview_play_mode", { action: "stop" });
		}
		if (hostStartedByAudit) {
			const pendingHostConfirmation = await ui.evaluate(
				`[...document.querySelectorAll('[role=alertdialog]')].some((entry) => entry.innerText?.includes('Stop Gameplay Session Host?'))`
			);
			if (pendingHostConfirmation) await ui.clickText("Stop Host", "[role=alertdialog] button");
			const host = await call("get_gameplay_session_host_status");
			if (host.listening) await call("stop_gameplay_session_host", { confirm: true });
		}
		if (adaptiveEnabledByAudit) await call("undo_editor");
		let sessions = await call("list_runtime_ai_sessions");
		for (const session of sessions.sessions.filter((entry) => !runtimeAiBaselineIds.has(entry.id))) {
			await call("dispose_runtime_ai_session", { id: session.id, expectedRevision: session.revision, confirm: true });
			sessions = await call("list_runtime_ai_sessions");
		}
	} catch (cleanupError) {
		console.error(`[whole-editor-ui-audit] cleanup failed — ${cleanupError.message}`);
		process.exitCode = 1;
	}
	ui?.socket.close();
	child.kill("SIGTERM");
}
