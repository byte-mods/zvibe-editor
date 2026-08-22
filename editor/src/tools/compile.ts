import { readFile } from "fs-extra";
import { createHash } from "crypto";
import { realpath } from "fs/promises";
import { dirname, join } from "path/posix";

import { build, BuildOptions, Plugin } from "esbuild";

import { getProjectAssetsRootUrl, projectConfiguration } from "../project/configuration";

import { ensureTemporaryDirectoryExists } from "./project";
import { instrumentTypeScriptSource } from "./script-instrumentation";
import { analyzeSerializationSource, formatSerializationDiagnostic } from "./serialization-diagnostics";

import type { IScriptSourceManifest, IScriptSourcePoint } from "babylonjs-editor-tools";

export async function compileScriptFromAssets(absolutePath: string) {
	const temporaryDirectory = await ensureTemporaryDirectoryExists(projectConfiguration.path!);

	const relativePath = absolutePath.replace(getProjectAssetsRootUrl()!, "").replace("/", "_");
	const outfile = join(temporaryDirectory, "scripts", relativePath.replace(".js", ".cjs"));

	await compileScript({
		outfile,
		entryPoints: [absolutePath],
	});

	return outfile;
}

export interface ICompilePlayScriptOptions {
	entryPoints: string[];
	outfile: string;
	onTransformSource?: (path: string) => void;
	instrumentProjectSources?: boolean;
}

export interface ICompileScriptResult {
	sourceManifest: IScriptSourceManifest | null;
}

export async function compileScript(options: ICompilePlayScriptOptions): Promise<ICompileScriptResult | undefined> {
	if (!projectConfiguration.path) {
		return;
	}

	const projectDir = dirname(projectConfiguration.path);
	// esbuild canonicalizes symlinked paths (notably /var -> /private/var on macOS), so compare against the same canonical project root.
	const canonicalProjectDir = (await realpath(projectDir)).replace(/\\/g, "/");
	const projectSourceRoot = join(canonicalProjectDir, "src/");
	const instrumentedSources = new Map<string, { contents: string; points: IScriptSourcePoint[] }>();

	const replaceImports = {
		name: "replaceImports",
		setup: (build) => {
			build.onLoad({ filter: /.*/ }, async (args) => {
				const source = await readFile(args.path, "utf8");
				const normalizedPath = args.path.replace(/\\/g, "/");
				const isProjectTypeScript = normalizedPath.startsWith(projectSourceRoot) && /\.(?:ts|tsx)$/.test(normalizedPath) && !normalizedPath.endsWith(".d.ts");
				if (isProjectTypeScript) {
					const serializationErrors = analyzeSerializationSource(source, normalizedPath).filter((diagnostic) => diagnostic.category === "error");
					if (serializationErrors.length) {
						throw new Error(`Serialization diagnostics failed before script emission:\n${serializationErrors.map(formatSerializationDiagnostic).join("\n")}`);
					}
				}
				const canInstrument = options.instrumentProjectSources === true && isProjectTypeScript && normalizedPath !== join(canonicalProjectDir, "src/scripts.ts");
				const relativePath = canInstrument ? `src/${normalizedPath.slice(projectSourceRoot.length)}` : null;
				const instrumented = relativePath ? instrumentTypeScriptSource(source, relativePath) : null;
				if (relativePath && instrumented) {
					instrumentedSources.set(relativePath, instrumented);
				}

				const transformedSource = (instrumented?.contents ?? source)
					.replace(/"@babylonjs\/core\/?.*"/g, '"babylonjs"')
					.replace(/"@babylonjs\/gui\/?.*"/g, '"babylonjs-gui"')
					.replace(/"@babylonjs\/loaders\/?.*"/g, '"babylonjs-loaders"')
					.replace(/"@babylonjs\/materials\/?.*"/g, '"babylonjs-materials"')
					.replace(/"@babylonjs\/post-processes\/?.*"/g, '"babylonjs-post-process"')
					.replace(/"@babylonjs\/procedural-textures\/?.*"/g, '"babylonjs-procedural-textures"')
					.replace(/"@babylonjs\/addons\/?.*"/g, '"babylonjs-addons"')
					.replace(/import\.meta\.dirname/g, "__dirname")
					.replace(/import\("/g, 'require("');

				options.onTransformSource?.(args.path);

				return {
					loader: "default",
					contents: transformedSource,
				};
			});
		},
	} as Plugin;

	// This is a typical configuration for esbuild to bundle the scripts of the current project.
	// All scripts are referenced in the "src/scripts.ts" file.
	// We enable sourcemaps to help debugging the code directly in vscode or other editors.
	// Some libraries are set external:
	// - sharp: in case it is used in the project, sharp must always be external as it requries native bindings.
	// - electron: this is the Electron library, it is never required the scripts, electron injects it at runtime.
	// - babylonjs-*: it is **IMPORTANT HERE** that all the babylonjs dependencies are set external. The editor overrides module loading in order to always return the editor's version of the library.

	const buildOptions = {
		entryPoints: options.entryPoints,
		bundle: true,
		platform: "node",
		target: "node20",
		format: "cjs",

		// IMPORTANT: force .cjs extension as the editor will use "require".
		// When type is set to "module" in package.json, the output will be esm.
		// Let "require" create a wrapper by naming the file extension ".cjs".
		outfile: options.outfile,

		treeShaking: true,
		sourcemap: true,
		loader: {
			".ts": "ts",
			".tsx": "tsx",
			".node": "file",
		},
		external: [
			"sharp",
			"electron",

			// The editor public API. Kept external so the editor's runtime module override (see
			// editor/src/editor/overrides.ts) returns the running editor's own exports — this is what
			// lets "agentdata" automation scripts do `import { UniqueNumber } from "babylonjs-editor"`.
			"babylonjs-editor",

			"babylonjs",
			"babylonjs-gui",
			"babylonjs-loaders",
			"babylonjs-materials",
			"babylonjs-post-process",
			"babylonjs-procedural-textures",
			"babylonjs-addons",

			"@recast-navigation/core",
			"@recast-navigation/generators",

			// IMPORTANT: Don't make babylonjs-editor-tools external. It has to be bundled
			// so that one loaded in the editor is not altered by the one used by the play script.
			// "babylonjs-editor-tools",
		],
		keepNames: true,
		plugins: [replaceImports],
		supported: {
			decorators: true,
		},
		tsconfig: join(projectDir, "tsconfig.json"),
	} as BuildOptions;

	await build(buildOptions);

	if (!options.instrumentProjectSources) {
		return { sourceManifest: null };
	}
	const sources = [...instrumentedSources.entries()].sort(([left], [right]) => left.localeCompare(right));
	const points = sources.flatMap(([, value]) => value.points);
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(sources.map(([path, value]) => ({ path, contents: value.contents, points: value.points }))))
		.digest("hex");
	return { sourceManifest: { version: 1, fingerprint, points } };
}
