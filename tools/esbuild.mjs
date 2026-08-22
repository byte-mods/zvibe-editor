import esbuild from "esbuild";

import { argv, exit } from "node:process";
import { readFile } from "node:fs/promises";

const replaceBabylonJsImports = {
	name: "replaceImportMetaDirname",
	setup(build) {
		build.onLoad({ filter: /.*/ }, async (args) => {
			const source = await readFile(args.path, "utf8");

			const transformedSource = source
				.replace(/"@babylonjs\/core\/.*"/g, '"babylonjs"')
				.replace(/"@babylonjs\/gui\/.*"/g, '"babylonjs-gui"')
				.replace(/"@babylonjs\/addons\/.*"/g, '"babylonjs-addons"');

			return {
				loader: "default",
				contents: transformedSource,
			};
		});
	},
};

const args = argv.slice(2);
const isWatch = args.includes("--watch");

const mainBuildOptions = {
	entryPoints: ["./src/index.ts"],
	bundle: true,
	platform: "node",
	target: "node20", // target version of Node.js
	format: "cjs", // output format as CommonJS
	outfile: "./build/index.node.js",
	treeShaking: false,
	loader: {
		".ts": "ts",
	},
	// Keep ONNX Runtime external so its ESM module URL remains intact. Its Wasm loader
	// resolves sibling payloads from import.meta.url in Electron and in downstream web bundlers.
	external: ["@litertjs/core", "babylonjs", "babylonjs-gui", "onnxruntime-web"],
	keepNames: true,
	minify: !isWatch,
	plugins: [replaceBabylonJsImports],
};

const serverBuildOptions = {
	entryPoints: ["./src/server/production-session-host.ts"],
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	outfile: "./build/server/production-session-host.mjs",
	treeShaking: true,
	loader: {
		".ts": "ts",
	},
	external: ["babylonjs", "babylonjs-gui"],
	keepNames: true,
	minify: !isWatch,
};

const developmentCoverageBuildOptions = {
	entryPoints: ["./src/build/development-coverage.ts"],
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	outfile: "./build/build/development-coverage.mjs",
	treeShaking: true,
	loader: {
		".ts": "ts",
	},
	external: ["typescript"],
	minify: !isWatch,
};

if (args.includes("--watch")) {
	Promise.all([esbuild.context(mainBuildOptions), esbuild.context(serverBuildOptions), esbuild.context(developmentCoverageBuildOptions)])
		.then(async (buildContexts) => {
			await Promise.all(buildContexts.map((buildContext) => buildContext.watch()));
			console.log("Watching...");
		})
		.catch((error) => {
			console.error(error);
			exit(1);
		});
} else {
	Promise.all([esbuild.build(mainBuildOptions), esbuild.build(serverBuildOptions), esbuild.build(developmentCoverageBuildOptions)]).catch((error) => {
		console.error(error);
		exit(1);
	});
}
