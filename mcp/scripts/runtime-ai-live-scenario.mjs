#!/usr/bin/env node
/** Real stdio/Electron lifecycle for bounded ONNX, LiteRT, and PyTorch Export inspection and inference. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { getExpectedMcpToolCount } from "./live-scenario-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;

child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	let newline;
	while ((newline = stdout.indexOf("\n")) >= 0) {
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

function rpc(method, params, timeoutMs = 90_000) {
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

async function call(name, args = {}, expectError = false) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

async function listTools() {
	const tools = [];
	let cursor;
	do {
		const response = await rpc("tools/list", cursor ? { cursor } : {});
		if (response.error) throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
		tools.push(...(response.result?.tools ?? []));
		cursor = response.result?.nextCursor;
	} while (cursor);
	return tools;
}

const requiredTools = [
	"get_runtime_ai_capabilities",
	"inspect_runtime_ai_model",
	"create_runtime_ai_session",
	"list_runtime_ai_sessions",
	"get_runtime_ai_session",
	"run_runtime_ai_inference",
	"dispose_runtime_ai_session",
	"reset_runtime_ai_runtime",
];
const supportTools = ["get_editor_status", "refresh_asset_registry_paths", "get_asset_importer", "validate_asset_importer_settings", "set_asset_importer_settings", "delete_asset"];
const identityModelBase64 =
	"CAgSCVp2aWJlVGVzdDpjCicKBWlucHV0EgZvdXRwdXQaDElkZW50aXR5Tm9kZSIISWRlbnRpdHkSDUlkZW50aXR5R3JhcGhaEwoFaW5wdXQSCgoICAESBAoCCAFiFAoGb3V0cHV0EgoKCAgBEgQKAggBQgIQDQ==";
const liteRtModelBase64 =
	"HAAAAFRGTDMUACAAHAAYABQAEAAMAAAACAAEABQAAAAcAAAAHAAAAHQAAAAgAQAAMAEAAHQCAAADAAAAAAAAAAIAAAA0AAAABAAAANz///8FAAAABAAAABMAAABDT05WRVJTSU9OX01FVEFEQVRBAAgADAAIAAQACAAAAAQAAAAEAAAAEwAAAG1pbl9ydW50aW1lX3ZlcnNpb24ABgAAAKgAAACgAAAAmAAAAJAAAABwAAAABAAAAJ7///8EAAAAVAAAAAwAAAAIAA4ACAAEAAgAAAAQAAAAJAAAAAAABgAIAAQABgAAAAQAAAAAAAAAAAAKABAADAAIAAQACgAAAAMAAAACAAAABAAAAAYAAAAyLjE2LjEAAAAABgAIAAQABgAAAAQAAAAQAAAAMS41LjAAAAAAAAAAAAAAAIz+//+Q/v//lP7//5j+//8PAAAATUxJUiBDb252ZXJ0ZWQuAAEAAAAUAAAAAAAOABgAFAAQAAwACAAEAA4AAAAUAAAAHAAAAFwAAABgAAAAaAAAAAQAAABtYWluAAAAAAEAAAAUAAAAAAAOABQAAAAQAAwACwAEAA4AAAAQAAAAAAAACwwAAAAQAAAAGP///wEAAAACAAAAAgAAAAAAAAABAAAAAQAAAAIAAAACAAAAAAAAAAEAAAADAAAAhAAAADwAAAAEAAAAnv///wAAAAEQAAAAEAAAAAMAAAAYAAAAbP///wgAAABJZGVudGl0eQAAAAABAAAABwAAANL///8AAAABEAAAABAAAAACAAAAEAAAAKD///8BAAAAeQAAAAEAAAAHAAAAAAAWABgAFAAAABAADAAIAAAAAAAAAAcAFgAAAAAAAAEQAAAAEAAAAAEAAAAQAAAA5P///wEAAAB4AAAAAQAAAAEAAAABAAAACAAAAAQABAAEAAAA";
const pytorchExportModelBase64 =
	"UEsDBAAACAgAAAAAAAAAAAAAAAAAAAAAAAAxADEAYXJpdGhtZXRpYy9kYXRhL3dlaWdodHMvbW9kZWxfd2VpZ2h0c19jb25maWcuanNvbkZCLQBaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlp7ImNvbmZpZyI6IHt9fVBLBwhu8Iq3DgAAAA4AAABQSwMEAAAICAAAAAAAAAAAAAAAAAAAAAAAADUADwBhcml0aG1ldGljL2RhdGEvY29uc3RhbnRzL21vZGVsX2NvbnN0YW50c19jb25maWcuanNvbkZCCwBaWlpaWlpaWlpaWnsiY29uZmlnIjoge319UEsHCG7wircOAAAADgAAAFBLAwQAAAgIAAAAAAAAAAAAAAAAAAAAAAAAHAAoAGFyaXRobWV0aWMvbW9kZWxzL21vZGVsLmpzb25GQiQAWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaeyJncmFwaF9tb2R1bGUiOiB7ImdyYXBoIjogeyJpbnB1dHMiOiBbeyJhc190ZW5zb3IiOiB7Im5hbWUiOiAieCJ9fSwgeyJhc190ZW5zb3IiOiB7Im5hbWUiOiAieSJ9fV0sICJvdXRwdXRzIjogW3siYXNfdGVuc29yIjogeyJuYW1lIjogInJlbHUifX1dLCAibm9kZXMiOiBbeyJ0YXJnZXQiOiAidG9yY2gub3BzLmF0ZW4uYWRkLlRlbnNvciIsICJpbnB1dHMiOiBbeyJuYW1lIjogInNlbGYiLCAiYXJnIjogeyJhc190ZW5zb3IiOiB7Im5hbWUiOiAieCJ9fSwgImtpbmQiOiAxfSwgeyJuYW1lIjogIm90aGVyIiwgImFyZyI6IHsiYXNfdGVuc29yIjogeyJuYW1lIjogInkifX0sICJraW5kIjogMX1dLCAib3V0cHV0cyI6IFt7ImFzX3RlbnNvciI6IHsibmFtZSI6ICJhZGQifX1dLCAibWV0YWRhdGEiOiB7InN0YWNrX3RyYWNlIjogIkZpbGUgXCI8c3RkaW4+XCIsIGxpbmUgOCwgaW4gZm9yd2FyZCIsICJubl9tb2R1bGVfc3RhY2siOiAiTF9fc2VsZl9fLCxfX21haW5fXy5Bcml0aG1ldGljIiwgInRvcmNoX2ZuIjogImFkZF8xO21ldGhvZF9kZXNjcmlwdG9yLmFkZCJ9LCAiaXNfaG9wX3NpbmdsZV90ZW5zb3JfcmV0dXJuIjogbnVsbH0sIHsidGFyZ2V0IjogInRvcmNoLm9wcy5hdGVuLm11bC5UZW5zb3IiLCAiaW5wdXRzIjogW3sibmFtZSI6ICJzZWxmIiwgImFyZyI6IHsiYXNfdGVuc29yIjogeyJuYW1lIjogImFkZCJ9fSwgImtpbmQiOiAxfSwgeyJuYW1lIjogIm90aGVyIiwgImFyZyI6IHsiYXNfZmxvYXQiOiAyLjB9LCAia2luZCI6IDF9XSwgIm91dHB1dHMiOiBbeyJhc190ZW5zb3IiOiB7Im5hbWUiOiAibXVsIn19XSwgIm1ldGFkYXRhIjogeyJzdGFja190cmFjZSI6ICJGaWxlIFwiPHN0ZGluPlwiLCBsaW5lIDgsIGluIGZvcndhcmQiLCAibm5fbW9kdWxlX3N0YWNrIjogIkxfX3NlbGZfXywsX19tYWluX18uQXJpdGhtZXRpYyIsICJ0b3JjaF9mbiI6ICJtdWxfMTttZXRob2RfZGVzY3JpcHRvci5tdWwifSwgImlzX2hvcF9zaW5nbGVfdGVuc29yX3JldHVybiI6IG51bGx9LCB7InRhcmdldCI6ICJ0b3JjaC5vcHMuYXRlbi5yZWx1LmRlZmF1bHQiLCAiaW5wdXRzIjogW3sibmFtZSI6ICJzZWxmIiwgImFyZyI6IHsiYXNfdGVuc29yIjogeyJuYW1lIjogIm11bCJ9fSwgImtpbmQiOiAxfV0sICJvdXRwdXRzIjogW3siYXNfdGVuc29yIjogeyJuYW1lIjogInJlbHUifX1dLCAibWV0YWRhdGEiOiB7InN0YWNrX3RyYWNlIjogIkZpbGUgXCI8c3RkaW4+XCIsIGxpbmUgOCwgaW4gZm9yd2FyZCIsICJubl9tb2R1bGVfc3RhY2siOiAiTF9fc2VsZl9fLCxfX21haW5fXy5Bcml0aG1ldGljIiwgInRvcmNoX2ZuIjogInJlbHVfMTtidWlsdGluX2Z1bmN0aW9uX29yX21ldGhvZC5yZWx1In0sICJpc19ob3Bfc2luZ2xlX3RlbnNvcl9yZXR1cm4iOiBudWxsfV0sICJ0ZW5zb3JfdmFsdWVzIjogeyJ4IjogeyJkdHlwZSI6IDcsICJzaXplcyI6IFt7ImFzX2ludCI6IDJ9LCB7ImFzX2ludCI6IDN9XSwgInJlcXVpcmVzX2dyYWQiOiBmYWxzZSwgImRldmljZSI6IHsidHlwZSI6ICJjcHUiLCAiaW5kZXgiOiBudWxsfSwgInN0cmlkZXMiOiBbeyJhc19pbnQiOiAzfSwgeyJhc19pbnQiOiAxfV0sICJzdG9yYWdlX29mZnNldCI6IHsiYXNfaW50IjogMH0sICJsYXlvdXQiOiA3fSwgInkiOiB7ImR0eXBlIjogNywgInNpemVzIjogW3siYXNfaW50IjogMn0sIHsiYXNfaW50IjogM31dLCAicmVxdWlyZXNfZ3JhZCI6IGZhbHNlLCAiZGV2aWNlIjogeyJ0eXBlIjogImNwdSIsICJpbmRleCI6IG51bGx9LCAic3RyaWRlcyI6IFt7ImFzX2ludCI6IDN9LCB7ImFzX2ludCI6IDF9XSwgInN0b3JhZ2Vfb2Zmc2V0IjogeyJhc19pbnQiOiAwfSwgImxheW91dCI6IDd9LCAiYWRkIjogeyJkdHlwZSI6IDcsICJzaXplcyI6IFt7ImFzX2ludCI6IDJ9LCB7ImFzX2ludCI6IDN9XSwgInJlcXVpcmVzX2dyYWQiOiBmYWxzZSwgImRldmljZSI6IHsidHlwZSI6ICJjcHUiLCAiaW5kZXgiOiBudWxsfSwgInN0cmlkZXMiOiBbeyJhc19pbnQiOiAzfSwgeyJhc19pbnQiOiAxfV0sICJzdG9yYWdlX29mZnNldCI6IHsiYXNfaW50IjogMH0sICJsYXlvdXQiOiA3fSwgIm11bCI6IHsiZHR5cGUiOiA3LCAic2l6ZXMiOiBbeyJhc19pbnQiOiAyfSwgeyJhc19pbnQiOiAzfV0sICJyZXF1aXJlc19ncmFkIjogZmFsc2UsICJkZXZpY2UiOiB7InR5cGUiOiAiY3B1IiwgImluZGV4IjogbnVsbH0sICJzdHJpZGVzIjogW3siYXNfaW50IjogM30sIHsiYXNfaW50IjogMX1dLCAic3RvcmFnZV9vZmZzZXQiOiB7ImFzX2ludCI6IDB9LCAibGF5b3V0IjogN30sICJyZWx1IjogeyJkdHlwZSI6IDcsICJzaXplcyI6IFt7ImFzX2ludCI6IDJ9LCB7ImFzX2ludCI6IDN9XSwgInJlcXVpcmVzX2dyYWQiOiBmYWxzZSwgImRldmljZSI6IHsidHlwZSI6ICJjcHUiLCAiaW5kZXgiOiBudWxsfSwgInN0cmlkZXMiOiBbeyJhc19pbnQiOiAzfSwgeyJhc19pbnQiOiAxfV0sICJzdG9yYWdlX29mZnNldCI6IHsiYXNfaW50IjogMH0sICJsYXlvdXQiOiA3fX0sICJzeW1faW50X3ZhbHVlcyI6IHt9LCAic3ltX2Jvb2xfdmFsdWVzIjoge30sICJpc19zaW5nbGVfdGVuc29yX3JldHVybiI6IGZhbHNlLCAiY3VzdG9tX29ial92YWx1ZXMiOiB7fSwgInN5bV9mbG9hdF92YWx1ZXMiOiB7fX0sICJzaWduYXR1cmUiOiB7ImlucHV0X3NwZWNzIjogW3sidXNlcl9pbnB1dCI6IHsiYXJnIjogeyJhc190ZW5zb3IiOiB7Im5hbWUiOiAieCJ9fX19LCB7InVzZXJfaW5wdXQiOiB7ImFyZyI6IHsiYXNfdGVuc29yIjogeyJuYW1lIjogInkifX19fV0sICJvdXRwdXRfc3BlY3MiOiBbeyJ1c2VyX291dHB1dCI6IHsiYXJnIjogeyJhc190ZW5zb3IiOiB7Im5hbWUiOiAicmVsdSJ9fX19XX0sICJtb2R1bGVfY2FsbF9ncmFwaCI6IFt7ImZxbiI6ICIiLCAic2lnbmF0dXJlIjogeyJpbnB1dHMiOiBbXSwgIm91dHB1dHMiOiBbXSwgImluX3NwZWMiOiAiWzEsIHtcInR5cGVcIjogXCJidWlsdGlucy50dXBsZVwiLCBcImNvbnRleHRcIjogXCJudWxsXCIsIFwiY2hpbGRyZW5fc3BlY1wiOiBbe1widHlwZVwiOiBcImJ1aWx0aW5zLnR1cGxlXCIsIFwiY29udGV4dFwiOiBcIm51bGxcIiwgXCJjaGlsZHJlbl9zcGVjXCI6IFt7XCJ0eXBlXCI6IG51bGwsIFwiY29udGV4dFwiOiBudWxsLCBcImNoaWxkcmVuX3NwZWNcIjogW119LCB7XCJ0eXBlXCI6IG51bGwsIFwiY29udGV4dFwiOiBudWxsLCBcImNoaWxkcmVuX3NwZWNcIjogW119XX0sIHtcInR5cGVcIjogXCJidWlsdGlucy5kaWN0XCIsIFwiY29udGV4dFwiOiBcIltdXCIsIFwiY2hpbGRyZW5fc3BlY1wiOiBbXX1dfV0iLCAib3V0X3NwZWMiOiAiWzEsIHtcInR5cGVcIjogbnVsbCwgXCJjb250ZXh0XCI6IG51bGwsIFwiY2hpbGRyZW5fc3BlY1wiOiBbXX1dIiwgImZvcndhcmRfYXJnX25hbWVzIjogWyJ4IiwgInkiXX19XSwgIm1ldGFkYXRhIjoge30sICJ0cmVlc3BlY19uYW1lZHR1cGxlX2ZpZWxkcyI6IHt9fSwgIm9wc2V0X3ZlcnNpb24iOiB7ImF0ZW4iOiAxMH0sICJyYW5nZV9jb25zdHJhaW50cyI6IHt9LCAic2NoZW1hX3ZlcnNpb24iOiB7Im1ham9yIjogOCwgIm1pbm9yIjogMTV9LCAidmVyaWZpZXJzIjogWyJUUkFJTklORyJdLCAidG9yY2hfdmVyc2lvbiI6ICIyLjEwLjAiLCAiZ3VhcmRzX2NvZGUiOiBbXX1QSwcIXqEVByoOAAAqDgAAUEsDBAAACAgAAAAAAAAAAAAAAAAAAAAAAAAmAEIAYXJpdGhtZXRpYy9kYXRhL3NhbXBsZV9pbnB1dHMvbW9kZWwucHRGQj4AWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpQSwMEAAAICAAAAAAAAAAAAAAAAAAAAAAAABAAEgBhcmNoaXZlL2RhdGEucGtsRkIOAFpaWlpaWlpaWlpaWlpagAJjdG9yY2guX3V0aWxzCl9yZWJ1aWxkX3RlbnNvcl92MgpxACgoWAcAAABzdG9yYWdlcQFjdG9yY2gKRmxvYXRTdG9yYWdlCnECWAEAAAAwcQNYAwAAAGNwdXEESwZ0cQVRSwBLAksDhnEGSwNLAYZxB4ljY29sbGVjdGlvbnMKT3JkZXJlZERpY3QKcQgpUnEJdHEKUnELaAAoKGgBaAJYAQAAADFxDGgESwZ0cQ1RSwBLAksDhnEOSwNLAYZxD4loCClScRB0cRFScRKGcRN9cRSGcRUuUEsHCFTR6UHYAAAA2AAAAFBLAwQAAAgIAAAAAAAAAAAAAAAAAAAAAAAAFwAjAGFyY2hpdmUvLmZvcm1hdF92ZXJzaW9uRkIfAFpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWloxUEsHCLfv3IMBAAAAAQAAAFBLAwQAAAgIAAAAAAAAAAAAAAAAAAAAAAAAGgA3AGFyY2hpdmUvLnN0b3JhZ2VfYWxpZ25tZW50RkIzAFpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWjY0UEsHCD93cekCAAAAAgAAAFBLAwQAAAgIAAAAAAAAAAAAAAAAAAAAAAAAEQA/AGFyY2hpdmUvYnl0ZW9yZGVyRkI7AFpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpabGl0dGxlUEsHCIU94xkGAAAABgAAAFBLAwQAAAgIAAAAAAAAAAAAAAAAAAAAAAAADgA+AGFyY2hpdmUvZGF0YS8wRkI6AFpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlopGp++Ke0vP9Smjj4oSVw/ecu/v4a21D5QSwcIwecVTBgAAAAYAAAAUEsDBAAACAgAAAAAAAAAAAAAAAAAAAAAAAAOACwAYXJjaGl2ZS9kYXRhLzFGQigAWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWgov+75BQqK+uSiwv80Z7742woY/e53LvlBLBwgcukPkGAAAABgAAABQSwMEAAAICAAAAAAAAAAAAAAAAAAAAAAAAA8AKwBhcmNoaXZlL3ZlcnNpb25GQicAWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaMwpQSwcI0Z5nVQIAAAACAAAAUEsDBAAACAgAAAAAAAAAAAAAAAAAAAAAAAAeADIAYXJjaGl2ZS8uZGF0YS9zZXJpYWxpemF0aW9uX2lkRkIuAFpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlowMDA3OTQyMTQxNTIyNzI4NDI5MDA2MTQ4OTU1NTM4NzA3OTA5MDI2UEsHCGqGXakoAAAAKAAAAFBLAQIAAAAACAgAAAAAAABU0elB2AAAANgAAAAQAAAAAAAAAAAAAAAAAAAAAABhcmNoaXZlL2RhdGEucGtsUEsBAgAAAAAICAAAAAAAALfv3IMBAAAAAQAAABcAAAAAAAAAAAAAAAAAKAEAAGFyY2hpdmUvLmZvcm1hdF92ZXJzaW9uUEsBAgAAAAAICAAAAAAAAD93cekCAAAAAgAAABoAAAAAAAAAAAAAAAAAkQEAAGFyY2hpdmUvLnN0b3JhZ2VfYWxpZ25tZW50UEsBAgAAAAAICAAAAAAAAIU94xkGAAAABgAAABEAAAAAAAAAAAAAAAAAEgIAAGFyY2hpdmUvYnl0ZW9yZGVyUEsBAgAAAAAICAAAAAAAAMHnFUwYAAAAGAAAAA4AAAAAAAAAAAAAAAAAlgIAAGFyY2hpdmUvZGF0YS8wUEsBAgAAAAAICAAAAAAAABy6Q+QYAAAAGAAAAA4AAAAAAAAAAAAAAAAAKAMAAGFyY2hpdmUvZGF0YS8xUEsBAgAAAAAICAAAAAAAANGeZ1UCAAAAAgAAAA8AAAAAAAAAAAAAAAAAqAMAAGFyY2hpdmUvdmVyc2lvblBLAQIAAAAACAgAAAAAAABqhl2pKAAAACgAAAAeAAAAAAAAAAAAAAAAABIEAABhcmNoaXZlLy5kYXRhL3NlcmlhbGl6YXRpb25faWRQSwYGLAAAAAAAAAAeAy0AAAAAAAAAAAAIAAAAAAAAAAgAAAAAAAAACwIAAAAAAAC4BAAAAAAAAFBLBgcAAAAAwwYAAAAAAAABAAAAUEsFBgAAAAAIAAgACwIAALgEAAAAAFBLBwjW9L75JQcAACUHAABQSwMEAAAICAAAAAAAAAAAAAAAAAAAAAAAABkAFABhcml0aG1ldGljL2FyY2hpdmVfZm9ybWF0RkIQAFpaWlpaWlpaWlpaWlpaWlpwdDJQSwcIMFw0KAMAAAADAAAAUEsDBAAACAgAAAAAAAAAAAAAAAAAAAAAAAAaADUAYXJpdGhtZXRpYy9hcmNoaXZlX3ZlcnNpb25GQjEAWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWjBQSwcIId/b9AEAAAABAAAAUEsDBAAACAgAAAAAAAAAAAAAAAAAAAAAAAAYADkAYXJpdGhtZXRpYy8uZGF0YS92ZXJzaW9uRkI1AFpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaNgpQSwcIlGoQKAIAAAACAAAAUEsDBAAACAgAAAAAAAAAAAAAAAAAAAAAAAAUADwAYXJpdGhtZXRpYy9ieXRlb3JkZXJGQjgAWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpsaXR0bGVQSwcIhT3jGQYAAAAGAAAAUEsDBAAACAgAAAAAAAAAAAAAAAAAAAAAAAAhACsAYXJpdGhtZXRpYy8uZGF0YS9zZXJpYWxpemF0aW9uX2lkRkInAFpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWjE1Njk3MzkxNTU5MDAzNjYxODIwMDA0ODQ0NzMyNjU2MzE0ODkyOTVQSwcI5XlANCgAAAAoAAAAUEsBAgAAAAAICAAAAAAAAG7wircOAAAADgAAADEAAAAAAAAAAAAAAAAAAAAAAGFyaXRobWV0aWMvZGF0YS93ZWlnaHRzL21vZGVsX3dlaWdodHNfY29uZmlnLmpzb25QSwECAAAAAAgIAAAAAAAAbvCKtw4AAAAOAAAANQAAAAAAAAAAAAAAAACeAAAAYXJpdGhtZXRpYy9kYXRhL2NvbnN0YW50cy9tb2RlbF9jb25zdGFudHNfY29uZmlnLmpzb25QSwECAAAAAAgIAAAAAAAAXqEVByoOAAAqDgAAHAAAAAAAAAAAAAAAAAAeAQAAYXJpdGhtZXRpYy9tb2RlbHMvbW9kZWwuanNvblBLAQIAAAAACAgAAAAAAADW9L75JQcAACUHAAAmAAAAAAAAAAAAAAAAALoPAABhcml0aG1ldGljL2RhdGEvc2FtcGxlX2lucHV0cy9tb2RlbC5wdFBLAQIAAAAACAgAAAAAAAAwXDQoAwAAAAMAAAAZAAAAAAAAAAAAAAAAAHUXAABhcml0aG1ldGljL2FyY2hpdmVfZm9ybWF0UEsBAgAAAAAICAAAAAAAACHf2/QBAAAAAQAAABoAAAAAAAAAAAAAAAAA0xcAAGFyaXRobWV0aWMvYXJjaGl2ZV92ZXJzaW9uUEsBAgAAAAAICAAAAAAAAJRqECgCAAAAAgAAABgAAAAAAAAAAAAAAAAAURgAAGFyaXRobWV0aWMvLmRhdGEvdmVyc2lvblBLAQIAAAAACAgAAAAAAACFPeMZBgAAAAYAAAAUAAAAAAAAAAAAAAAAANIYAABhcml0aG1ldGljL2J5dGVvcmRlclBLAQIAAAAACAgAAAAAAADleUA0KAAAACgAAAAhAAAAAAAAAAAAAAAAAFYZAABhcml0aG1ldGljLy5kYXRhL3NlcmlhbGl6YXRpb25faWRQSwYGLAAAAAAAAAAeAy0AAAAAAAAAAAAJAAAAAAAAAAkAAAAAAAAAxgIAAAAAAAD4GQAAAAAAAFBLBgcAAAAAvhwAAAAAAAABAAAAUEsFBgAAAAAJAAkAxgIAAPgZAAAAAA==";
const suffix = `${Date.now()}-${process.pid}`;
const retainFixtures = process.env.RUNTIME_AI_LIVE_RETAIN_FIXTURES === "1";
const models = [
	{ key: "onnx", path: `assets/.mcp-runtime-ai-${suffix}.onnx`, bytes: Buffer.from(identityModelBase64, "base64"), format: "onnx" },
	{ key: "litert", path: `assets/.mcp-runtime-ai-${suffix}.tflite`, bytes: Buffer.from(liteRtModelBase64, "base64"), format: "litert" },
	{ key: "pytorchExport", path: `assets/.mcp-runtime-ai-${suffix}.pt2`, bytes: Buffer.from(pytorchExportModelBase64, "base64"), format: "pytorchExport" },
];
let projectDirectory;
let completed = false;
const sessions = new Map();
const registered = new Set();

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runtime-ai-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	const expectedToolCount = await getExpectedMcpToolCount();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} MCP tools, received ${tools.length}.`);
	for (const name of [...requiredTools, ...supportTools]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing from real stdio discovery.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable editor project is required for the Runtime AI live scenario.");
	projectDirectory = dirname(status.projectPath);
	await mkdir(join(projectDirectory, "assets"), { recursive: true });
	for (const model of models) await writeFile(join(projectDirectory, model.path), model.bytes);
	await call("refresh_asset_registry_paths", { paths: models.map((model) => model.path) });
	models.forEach((model) => registered.add(model.path));

	const capabilities = await call("get_runtime_ai_capabilities");
	if (!capabilities.features?.wasm || !capabilities.features?.liteRt || !capabilities.features?.exportedPyTorch || capabilities.maximumRetainedSessions !== 4) {
		throw new Error(`Runtime AI capabilities are incomplete: ${JSON.stringify(capabilities)}`);
	}
	for (const model of models) {
		const defaultImporter = await call("get_asset_importer", { path: model.path });
		if (defaultImporter.importer?.kind !== "aiModel" || defaultImporter.importer?.settings?.includeInBuild !== true) {
			throw new Error(`${model.format} importer inference failed: ${JSON.stringify(defaultImporter)}`);
		}
	}
	await call("validate_asset_importer_settings", { path: models[0].path, settings: { wasmNumThreads: 0 } }, true);
	await call("set_asset_importer_settings", {
		paths: models.map((model) => model.path),
		settings: { backend: "wasm", wasmNumThreads: 2, graphOptimizationLevel: "basic", maximumTensorElements: 1024 },
	});
	const importer = await call("get_asset_importer", { path: models[1].path });
	if (importer.importer?.settings?.backend !== "wasm" || importer.importer?.settings?.wasmNumThreads !== 2) {
		throw new Error(`Wasm importer settings did not persist: ${JSON.stringify(importer)}`);
	}

	const inspections = new Map();
	for (const model of models) {
		const inspection = await call("inspect_runtime_ai_model", { modelPath: model.path });
		if (
			inspection.description?.backend !== "wasm" ||
			inspection.description?.modelFormat !== model.format ||
			!inspection.description?.inputs?.length ||
			!inspection.description?.outputs?.length
		) {
			throw new Error(`${model.format} inspection is incomplete: ${JSON.stringify(inspection)}`);
		}
		if (model.format === "litert" && inspection.description?.runtimeEngine !== "litertjs") throw new Error(`LiteRT did not use litertjs: ${JSON.stringify(inspection)}`);
		if (model.format === "pytorchExport" && inspection.description?.conversion?.schemaVersion !== "8.15")
			throw new Error(`PT2 conversion evidence is missing: ${JSON.stringify(inspection)}`);
		inspections.set(model.key, inspection);
	}
	await call("create_runtime_ai_session", { modelPath: models[0].path, expectedModelSha256: "0".repeat(64) }, true);
	for (const model of models) {
		const session = await call("create_runtime_ai_session", { modelPath: model.path, expectedModelSha256: inspections.get(model.key).modelSha256 });
		if (session.revision !== 1 || session.description?.backend !== "wasm") throw new Error(`${model.format} session creation failed: ${JSON.stringify(session)}`);
		sessions.set(model.key, session);
	}

	const listed = await call("list_runtime_ai_sessions", { offset: 1, limit: 1 });
	if (listed.total !== 3 || listed.sessions?.length !== 1 || listed.nextOffset !== 2) throw new Error(`Runtime AI pagination failed: ${JSON.stringify(listed)}`);
	const onnxSession = sessions.get("onnx");
	const opened = await call("get_runtime_ai_session", { id: onnxSession.id });
	if (opened.revision !== 1 || opened.busy) throw new Error(`Runtime AI session read failed: ${JSON.stringify(opened)}`);

	await call(
		"run_runtime_ai_inference",
		{ id: onnxSession.id, expectedRevision: 1, inputs: { input: { type: "float32", dims: [2], data: [1] } }, outputNames: ["output"] },
		true
	);
	const afterFailure = await call("get_runtime_ai_session", { id: onnxSession.id });
	if (afterFailure.revision !== 2 || !afterFailure.lastError?.includes("dimensions require 2")) {
		throw new Error(`Failed inference did not advance and diagnose the session: ${JSON.stringify(afterFailure)}`);
	}
	await call("run_runtime_ai_inference", { id: onnxSession.id, expectedRevision: 1, inputs: { input: { type: "float32", dims: [1], data: [9] } } }, true);
	const onnxInference = await call("run_runtime_ai_inference", {
		id: onnxSession.id,
		expectedRevision: 2,
		inputs: { input: { type: "float32", dims: [1], data: [42.25] } },
		outputNames: ["output"],
		timeoutMilliseconds: 5000,
		maximumOutputValues: 1,
	});
	if (onnxInference.session?.revision !== 3 || onnxInference.outputs?.output?.data?.[0] !== 42.25 || onnxInference.outputs?.output?.truncated !== false) {
		throw new Error(`ONNX inference output is incorrect: ${JSON.stringify(onnxInference)}`);
	}

	const liteRtSession = sessions.get("litert");
	const liteRtInputs = Object.fromEntries(
		liteRtSession.description.inputs.map((input) => {
			const dims = input.shape.map(Number);
			return [input.name, { type: input.type, dims, data: Array(dims.reduce((total, value) => total * value, 1)).fill(2) }];
		})
	);
	const liteRtInference = await call("run_runtime_ai_inference", { id: liteRtSession.id, expectedRevision: 1, inputs: liteRtInputs, timeoutMilliseconds: 30_000 });
	const liteRtValues = Object.values(liteRtInference.outputs)[0]?.data;
	if (liteRtInference.session?.revision !== 2 || !liteRtValues?.length || liteRtValues.some((value) => value !== 4)) {
		throw new Error(`LiteRT inference output is incorrect: ${JSON.stringify(liteRtInference)}`);
	}

	const pt2Session = sessions.get("pytorchExport");
	const pt2Inference = await call("run_runtime_ai_inference", {
		id: pt2Session.id,
		expectedRevision: 1,
		inputs: {
			x: { type: "float32", dims: [2, 3], data: [-2, 1, 3, 4, -5, 6] },
			y: { type: "float32", dims: [2, 3], data: [1, 2, -4, 1, 6, -8] },
		},
		outputNames: ["relu"],
	});
	if (JSON.stringify(pt2Inference.outputs?.relu?.data) !== JSON.stringify([0, 6, 0, 10, 2, 0])) {
		throw new Error(`PyTorch Export inference output is incorrect: ${JSON.stringify(pt2Inference)}`);
	}

	await call("dispose_runtime_ai_session", { id: onnxSession.id, expectedRevision: 2, confirm: true }, true);
	for (const [key, session] of sessions) {
		const current = await call("get_runtime_ai_session", { id: session.id });
		await call("dispose_runtime_ai_session", { id: session.id, expectedRevision: current.revision, confirm: true });
		sessions.delete(key);
	}
	const reset = await call("reset_runtime_ai_runtime", { confirm: true });
	if (!reset.reset || reset.disposedSessions !== 0) throw new Error(`Runtime AI empty reset failed: ${JSON.stringify(reset)}`);

	if (!retainFixtures) {
		for (const model of models) {
			await call("delete_asset", { path: model.path, confirm: true });
			registered.delete(model.path);
		}
	}
	completed = true;
	console.log(
		`[runtime-ai-live] PASS — 8/8 tools, strict schemas/annotations, ONNX + real LiteRT + real PyTorch Export import/graph/session/inference, exact outputs, SHA/revision guards, failed-run evidence, pagination, disposal, reset, and ${retainFixtures ? "runtime cleanup" : "cleanup"} verified.`
	);
	if (retainFixtures) {
		console.log(`[runtime-ai-live] Retained UI fixtures: ${models.map((model) => model.path).join(", ")}`);
	}
} catch (error) {
	console.error(`[runtime-ai-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	for (const [key, session] of sessions) {
		try {
			const current = await call("get_runtime_ai_session", { id: session.id });
			await call("dispose_runtime_ai_session", { id: session.id, expectedRevision: current.revision, confirm: true });
			sessions.delete(key);
		} catch (cleanupError) {
			console.error(`[runtime-ai-live] session cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			process.exitCode = 1;
		}
	}
	if (!(retainFixtures && completed)) {
		for (const path of registered) {
			try {
				await call("delete_asset", { path, confirm: true });
				registered.delete(path);
			} catch (cleanupError) {
				console.error(`[runtime-ai-live] asset cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
				process.exitCode = 1;
			}
		}
	}
	if (projectDirectory && !(retainFixtures && completed)) {
		try {
			for (const model of models) {
				await rm(join(projectDirectory, model.path), { force: true });
				await rm(`${join(projectDirectory, model.path)}.bjsmeta.json`, { force: true });
			}
		} catch (cleanupError) {
			console.error(`[runtime-ai-live] file cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			process.exitCode = 1;
		}
	}
	child.stdin.end();
	setTimeout(() => child.kill("SIGTERM"), 1000).unref();
}
