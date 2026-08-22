const { app, BrowserWindow } = require("electron");
const { join, dirname } = require("node:path");
const { pathToFileURL } = require("node:url");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");

const modelBase64 =
	"HAAAAFRGTDMUACAAHAAYABQAEAAMAAAACAAEABQAAAAcAAAAHAAAAHQAAAAgAQAAMAEAAHQCAAADAAAAAAAAAAIAAAA0AAAABAAAANz///8FAAAABAAAABMAAABDT05WRVJTSU9OX01FVEFEQVRBAAgADAAIAAQACAAAAAQAAAAEAAAAEwAAAG1pbl9ydW50aW1lX3ZlcnNpb24ABgAAAKgAAACgAAAAmAAAAJAAAABwAAAABAAAAJ7///8EAAAAVAAAAAwAAAAIAA4ACAAEAAgAAAAQAAAAJAAAAAAABgAIAAQABgAAAAQAAAAAAAAAAAAKABAADAAIAAQACgAAAAMAAAACAAAABAAAAAYAAAAyLjE2LjEAAAAABgAIAAQABgAAAAQAAAAQAAAAMS41LjAAAAAAAAAAAAAAAIz+//+Q/v//lP7//5j+//8PAAAATUxJUiBDb252ZXJ0ZWQuAAEAAAAUAAAAAAAOABgAFAAQAAwACAAEAA4AAAAUAAAAHAAAAFwAAABgAAAAaAAAAAQAAABtYWluAAAAAAEAAAAUAAAAAAAOABQAAAAQAAwACwAEAA4AAAAQAAAAAAAACwwAAAAQAAAAGP///wEAAAACAAAAAgAAAAAAAAABAAAAAQAAAAIAAAACAAAAAAAAAAEAAAADAAAAhAAAADwAAAAEAAAAnv///wAAAAEQAAAAEAAAAAMAAAAYAAAAbP///wgAAABJZGVudGl0eQAAAAABAAAABwAAANL///8AAAABEAAAABAAAAACAAAAEAAAAKD///8BAAAAeQAAAAEAAAAHAAAAAAAWABgAFAAAABAADAAIAAAAAAAAAAcAFgAAAAAAAAEQAAAAEAAAAAEAAAAQAAAA5P///wEAAAB4AAAAAQAAAAEAAAABAAAACAAAAAQABAAEAAAA";

async function main() {
	await app.whenReady();
	const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
	const directory = mkdtempSync(join(tmpdir(), "zvibe-litert-build-"));
	try {
		await window.loadFile(join(__dirname, "litert-electron.html"));
		const sceneRoot = join(directory, "scene");
		const modelPath = join(sceneRoot, "assets", "identity.tflite");
		const wasmSource = join(dirname(require.resolve("@litertjs/core/package.json")), "wasm");
		const wasmOutput = join(sceneRoot, "runtime-ai", "litert");
		mkdirSync(dirname(modelPath), { recursive: true });
		cpSync(wasmSource, wasmOutput, { recursive: true });
		const modelBytes = Buffer.from(modelBase64, "base64");
		writeFileSync(modelPath, modelBytes);
		const runtimeFiles = readdirSync(wasmOutput).map((name) => {
			const path = join(wasmOutput, name);
			return { path: `runtime-ai/litert/${name}`, bytes: statSync(path).size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
		});
		const modelSha256 = createHash("sha256").update(modelBytes).digest("hex");
		writeFileSync(
			`${modelPath}.bjsai.json`,
			JSON.stringify({
				version: 3,
				format: "litert",
				modelBytes: modelBytes.length,
				modelSha256,
				externalData: [],
				liteRtWasmPath: "runtime-ai/litert/",
				liteRtWasmRelativePath: "../runtime-ai/litert/",
				runtimeFiles,
				fingerprint: modelSha256,
			})
		);
		const result = await window.webContents.executeJavaScript(`(async () => {
		const { RuntimeAiSession } = require("babylonjs-editor-tools");
		const session = await RuntimeAiSession.CreateFromBuildAsset(${JSON.stringify(pathToFileURL(modelPath).href)}, { backend: "wasm", wasmNumThreads: 1 });
		try {
			const inputs = Object.fromEntries(session.description.inputs.map((input) => {
				const dims = input.shape.map((value) => Number(value));
				const count = dims.reduce((total, value) => total * value, 1);
				return [input.name, { type: input.type, dims, data: Array(count).fill(2) }];
			}));
			return { description: session.description, result: await session.run(inputs, undefined, 30000) };
		} finally {
			await session.dispose();
		}
	})()`);
		if (result.description.modelFormat !== "litert" || result.description.runtimeEngine !== "litertjs" || result.description.graph.nodes.length < 1) {
			throw new Error(`Unexpected LiteRT description: ${JSON.stringify(result.description)}`);
		}
		if (!Object.keys(result.result.outputs).length) throw new Error("LiteRT returned no outputs.");
		console.log(JSON.stringify(result));
	} finally {
		window.destroy();
		rmSync(directory, { recursive: true, force: true });
		await app.quit();
	}
}

main().catch(async (error) => {
	console.error(error);
	app.exitCode = 1;
	await app.quit();
});
