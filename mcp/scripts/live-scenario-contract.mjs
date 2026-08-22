import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function getExpectedMcpToolCount() {
	const manifest = JSON.parse(await readFile(join(here, "..", "manifest.json"), "utf8"));
	if (!Array.isArray(manifest.tools)) throw new Error("mcp/manifest.json does not contain a generated tools array.");
	return manifest.tools.length;
}
