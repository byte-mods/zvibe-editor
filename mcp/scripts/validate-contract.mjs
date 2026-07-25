#!/usr/bin/env node
/**
 * Real stdio validation of the published MCP tool contract.
 *
 * This is the executable form of the gate the parity/contract docs describe.
 * It launches the bundled server over real stdio, performs a real MCP
 * handshake, pages through the complete tool list, and asserts the contract
 * invariants that clients depend on:
 *
 *   1. Tool count matches the expected baseline (guards silent loss/dupes).
 *   2. Every tool has a non-empty description.
 *   3. Every tool input schema is closed-world (`additionalProperties: false`),
 *      so unknown arguments cannot be silently ignored.
 *   4. Every tool publishes all four boolean safety annotations.
 *   5. No tool is BOTH read-only and destructive.
 *   6. A real call carrying an unknown field is rejected with MCP `-32602`
 *      before the editor is contacted. The SDK surfaces validation failures as
 *      an MCP tool error (`isError: true`) rather than a JSON-RPC top-level
 *      error, so both encodings are accepted.
 *
 * Usage:
 *   yarn workspace babylonjs-editor-mcp-server validate
 *   node scripts/validate-contract.mjs --expect-tools 841
 *
 * Exits non-zero with a precise reason on any violation.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server", "index.mjs");

const argv = process.argv.slice(2);
const expectIndex = argv.indexOf("--expect-tools");
const EXPECTED_TOOLS = expectIndex >= 0 ? Number(argv[expectIndex + 1]) : 841;
const REQUIRED_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

if (!existsSync(SERVER)) {
	console.error(`[validate-contract] bundled server missing at ${SERVER}\n` + `Run: yarn workspace babylonjs-editor-mcp-server bundle`);
	process.exit(2);
}

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdoutBuffer = "";
let stderrText = "";

child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk.toString();
	let newline;
	while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
		const line = stdoutBuffer.slice(0, newline).trim();
		stdoutBuffer = stdoutBuffer.slice(newline + 1);
		if (!line) {
			continue;
		}
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => {
	stderrText += chunk.toString();
});

let nextId = 1;
function rpc(method, params, timeoutMs = 60000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

const failures = [];
let toolCount = 0;

try {
	const init = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "validate-contract", version: "1.0.0" },
	});
	if (init.error) {
		throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
	}
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	let tools = [];
	let cursor;
	do {
		const page = await rpc("tools/list", cursor ? { cursor } : {});
		if (page.error) {
			throw new Error(`tools/list failed: ${JSON.stringify(page.error)}`);
		}
		tools = tools.concat(page.result.tools ?? []);
		cursor = page.result.nextCursor;
	} while (cursor);
	toolCount = tools.length;

	if (Number.isFinite(EXPECTED_TOOLS) && tools.length !== EXPECTED_TOOLS) {
		failures.push(`expected ${EXPECTED_TOOLS} tools, discovered ${tools.length}`);
	}

	const duplicates = tools.map((tool) => tool.name).filter((name, index, all) => all.indexOf(name) !== index);
	if (duplicates.length) {
		failures.push(`duplicate tool names: ${[...new Set(duplicates)].slice(0, 5).join(", ")}`);
	}

	const undescribed = tools.filter((tool) => !tool.description?.trim());
	if (undescribed.length) {
		failures.push(
			`${undescribed.length} tools without a description (e.g. ${undescribed
				.slice(0, 5)
				.map((t) => t.name)
				.join(", ")})`
		);
	}

	const openSchemas = tools.filter((tool) => tool.inputSchema?.type !== "object" || tool.inputSchema.additionalProperties !== false);
	if (openSchemas.length) {
		failures.push(
			`${openSchemas.length} tools with non-closed input schemas (e.g. ${openSchemas
				.slice(0, 5)
				.map((t) => t.name)
				.join(", ")})`
		);
	}

	const incompleteHints = tools.filter((tool) => REQUIRED_HINTS.some((hint) => typeof tool.annotations?.[hint] !== "boolean"));
	if (incompleteHints.length) {
		failures.push(
			`${incompleteHints.length} tools missing safety annotations (e.g. ${incompleteHints
				.slice(0, 5)
				.map((t) => t.name)
				.join(", ")})`
		);
	}

	const contradictory = tools.filter((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === true);
	if (contradictory.length) {
		failures.push(
			`${contradictory.length} tools marked both read-only and destructive (e.g. ${contradictory
				.slice(0, 5)
				.map((t) => t.name)
				.join(", ")})`
		);
	}

	// Unknown-field rejection must happen before the editor is contacted, so a
	// read-only tool is a safe probe even with no editor running.
	const probe = tools.find((tool) => tool.name === "list_scenes") ?? tools.find((tool) => tool.annotations?.readOnlyHint === true);
	if (!probe) {
		failures.push("no read-only tool available to probe unknown-field rejection");
	} else {
		const response = await rpc("tools/call", { name: probe.name, arguments: { __unknown_contract_probe__: 1 } });
		const encoded = JSON.stringify(response);
		const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602") && /nrecognized/i.test(encoded));
		if (!rejected) {
			failures.push(`${probe.name} did not reject an unknown field with -32602`);
		}
	}

	const psdTool = tools.find((tool) => tool.name === "inspect_psd_layer_extraction");
	if (!psdTool) {
		failures.push("inspect_psd_layer_extraction is missing");
	} else {
		const invalidPsdCalls = [
			{
				label: "style-run bindings without authored mode",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", styleRunFontBindings: [{ fontIndex: 0, fontPath: "assets/probe.ttf" }] }],
				},
			},
			{
				label: "replacement text with authored mode",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, text: "replacement", fontPath: "assets/probe.ttf", useAuthoredStyleRuns: true }],
				},
			},
			{
				label: "duplicate authored FontSet bindings",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [
						{
							layerIndex: 0,
							fontPath: "assets/probe.ttf",
							useAuthoredStyleRuns: true,
							styleRunFontBindings: [
								{ fontIndex: 0, fontPath: "assets/probe.ttf" },
								{ fontIndex: 0, fontPath: "assets/probe.ttf" },
							],
						},
					],
				},
			},
			{
				label: "unknown authored FontSet binding field",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [
						{
							layerIndex: 0,
							fontPath: "assets/probe.ttf",
							useAuthoredStyleRuns: true,
							styleRunFontBindings: [{ fontIndex: 0, fontPath: "assets/probe.ttf", unknown: true }],
						},
					],
				},
			},
			{
				label: "invalid complex-text shaping direction",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "auto" } }],
				},
			},
			{
				label: "invalid complex-text shaping script",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "rtl", script: "Arabic" } }],
				},
			},
			{
				label: "non-Boolean bidirectional shaping option",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "ltr", bidirectional: "yes" } }],
				},
			},
			{
				label: "non-Boolean cross-style shaping option",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", useAuthoredStyleRuns: true, shaping: { direction: "rtl", joinAcrossStyleRuns: "yes" } }],
				},
			},
			{
				label: "cross-style shaping without authored mode",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "rtl", joinAcrossStyleRuns: true } }],
				},
			},
			{
				label: "non-Boolean authored text warp option",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", applyAuthoredWarp: "yes" }],
				},
			},
			{
				label: "duplicate complex-text shaping features",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [
						{
							layerIndex: 0,
							fontPath: "assets/probe.ttf",
							shaping: {
								direction: "rtl",
								features: [
									{ tag: "rlig", value: 1 },
									{ tag: "rlig", value: 0 },
								],
							},
						},
					],
				},
			},
			{
				label: "unknown complex-text shaping field",
				arguments: {
					path: "assets/schema-probe.psd",
					textRenders: [{ layerIndex: 0, fontPath: "assets/probe.ttf", shaping: { direction: "rtl", guessBidi: true } }],
				},
			},
		];
		for (const invalid of invalidPsdCalls) {
			const response = await rpc("tools/call", { name: psdTool.name, arguments: invalid.arguments });
			const encoded = JSON.stringify(response);
			const rejected = response.error?.code === -32602 || (response.result?.isError === true && encoded.includes("-32602"));
			if (!rejected) {
				failures.push(`inspect_psd_layer_extraction accepted ${invalid.label}`);
			}
		}
	}
} catch (error) {
	failures.push(`exception: ${error.message}`);
} finally {
	child.kill();
}

console.log(`[validate-contract] tools discovered: ${toolCount}`);
if (stderrText.trim()) {
	console.log(`[validate-contract] server stderr: ${stderrText.trim().split("\n").slice(-2).join(" | ")}`);
}

if (failures.length) {
	console.error("[validate-contract] FAIL");
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log("[validate-contract] PASS — count, descriptions, closed schemas, annotations, and unknown-field rejection all verified.");
