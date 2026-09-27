import { argv, exit } from "node:process";
import { readFile } from "node:fs/promises";

import esbuild from "esbuild";

const args = argv.slice(2);
const isWatch = args.includes("--watch");

const replaceImportMetaDirname = {
	name: "replaceImportMetaDirname",
	setup(build) {
		build.onLoad({ filter: /.*/ }, async (args) => {
			const source = await readFile(args.path, "utf8");

			const transformedSource = source
				.replace(/import.meta.dirname/g, "__dirname")
				.replace(/import.meta.filename/g, "__filename")
				.replace(/workers\/md5.mjs/g, "workers/md5.js");

			return {
				loader: "default",
				contents: transformedSource,
			};
		});
	},
};

const mainBuildOptions = {
	entryPoints: ["./src/export.mts"],
	bundle: true,
	platform: "node",
	target: "node20", // target version of Node.js
	format: "cjs", // output format as CommonJS
	outfile: "./build/index.node.js",
	// FFmpeg/FFprobe packages resolve their binary paths relative to their own install location.
	external: ["assimpjs", "assimpjs/*", "msdfgen-wasm", "msdfgen-wasm/*", "ffmpeg-static", "@ffprobe-installer/ffprobe"],
	treeShaking: false,
	loader: {
		".mts": "ts",
	},
	keepNames: true,
	minify: !isWatch,
	plugins: [replaceImportMetaDirname],
};

/**
 * The command line entry point run by `bin/babylonjs-editor-cli.js` (and so by `yarn generate` in projects). Node cannot
 * run the unbundled tsc output: it mixes the CommonJS "babylonjs" build with babylonjs-editor-tools, whose ESM build uses
 * "@babylonjs/core" instead. Bundling as CommonJS resolves the tools package through its "require" build, which shares the
 * same "babylonjs" instance, and inlines the ESM-only dependencies (chalk, ora, ...).
 */
const replaceCliImportMeta = {
	name: "replaceCliImportMeta",
	setup(build) {
		build.onLoad({ filter: /\.mts$/ }, async (args) => {
			const source = await readFile(args.path, "utf8");
			// Workers stay standalone ESM files next to the tsc output ("build/src/tools/workers/*.mjs").
			const dirname = args.path.replace(/\\/g, "/").endsWith("/src/tools/worker.mts") ? 'require("node:path").join(__dirname, "src/tools")' : "__dirname";

			return {
				loader: "ts",
				contents: source.replace(/import.meta.dirname/g, dirname).replace(/import.meta.filename/g, "__filename"),
			};
		});
	},
};

const cliBuildOptions = {
	entryPoints: ["./src/index.mts"],
	bundle: true,
	platform: "node",
	target: "node20",
	format: "cjs",
	outfile: "./build/cli.node.cjs",
	// Native/wasm packages and the Babylon.js builds are loaded from the installed dependencies at runtime.
	external: [
		"assimpjs",
		"assimpjs/*",
		"msdfgen-wasm",
		"msdfgen-wasm/*",
		"sharp",
		"babylonjs",
		"babylonjs-loaders",
		"babylonjs-editor-tools",
		"ffmpeg-static",
		"@ffprobe-installer/ffprobe",
	],
	keepNames: true,
	minify: !isWatch,
	plugins: [replaceCliImportMeta],
};

if (args.includes("--watch")) {
	Promise.all([esbuild.context(mainBuildOptions), esbuild.context(cliBuildOptions)])
		.then(async (buildContexts) => {
			await Promise.all(buildContexts.map((buildContext) => buildContext.watch()));
			console.log("Watching...");
		})
		.catch((error) => {
			console.error(error);
			exit(1);
		});
} else {
	Promise.all([esbuild.build(mainBuildOptions), esbuild.build(cliBuildOptions)]).catch((error) => {
		console.error(error);
		exit(1);
	});
}
