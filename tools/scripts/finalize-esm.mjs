// Makes the tsc ESM output loadable by Node's ESM loader, not only by bundlers.
//
// The sources use extension-less imports ("./loading/loader", "@babylonjs/core/Meshes/mesh"), which bundlers resolve
// but Node's ESM loader rejects. That broke every Node consumer of the "import" entry point, including the CLI
// (`babylonjs-editor-cli pack`, `yarn generate` in user projects). This rewrites each relative specifier and each deep
// import into a package without an "exports" map to the exact file it resolves to, which bundlers accept unchanged.

import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = join(root, "build/src");
const require = createRequire(join(root, "package.json"));

// Static `import … from "x"`, `export … from "x"`, side-effect `import "x"` and dynamic `import("x")` at statement level.
const specifierPattern = /(^\s*(?:import|export)\b[^;"'`]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\2/gm;

const packageRoots = new Map();

function isFile(path) {
	return existsSync(path) && statSync(path).isFile();
}

function resolveFileSpecifier(base, specifier) {
	if (/\.(m?js|cjs|json|wasm)$/.test(specifier)) {
		return specifier;
	}
	if (isFile(`${base}.js`)) {
		return `${specifier}.js`;
	}
	if (isFile(join(base, "index.js"))) {
		return `${specifier}/index.js`;
	}
	return null;
}

function packageRoot(name) {
	if (!packageRoots.has(name)) {
		let result = null;
		try {
			const manifestPath = require.resolve(`${name}/package.json`);
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			// Packages with an "exports" map resolve their own subpaths; only rewrite the ones without one.
			result = manifest.exports ? null : dirname(manifestPath);
		} catch {
			result = null;
		}
		packageRoots.set(name, result);
	}
	return packageRoots.get(name);
}

function rewriteSpecifier(file, specifier) {
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		const rewritten = resolveFileSpecifier(resolve(dirname(file), specifier), specifier);
		if (!rewritten) {
			throw new Error(`Cannot resolve relative import "${specifier}" in ${file}.`);
		}
		return rewritten;
	}

	const parts = specifier.split("/");
	const nameLength = specifier.startsWith("@") ? 2 : 1;
	if (parts.length <= nameLength || specifier.startsWith("node:")) {
		return specifier;
	}
	const name = parts.slice(0, nameLength).join("/");
	const directory = packageRoot(name);
	if (!directory) {
		return specifier;
	}
	const subpath = parts.slice(nameLength).join("/");
	const rewritten = resolveFileSpecifier(join(directory, subpath), subpath);
	return rewritten ? `${name}/${rewritten}` : specifier;
}

async function* javascriptFiles(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			yield* javascriptFiles(path);
		} else if (entry.name.endsWith(".js")) {
			yield path;
		}
	}
}

let rewrittenFiles = 0;
for await (const file of javascriptFiles(outputDirectory)) {
	const source = await readFile(file, "utf8");
	const output = source.replace(specifierPattern, (match, prefix, quote, specifier) => `${prefix}${quote}${rewriteSpecifier(file, specifier)}${quote}`);
	if (output !== source) {
		await writeFile(file, output);
		rewrittenFiles++;
	}
}

console.log(`[finalize-esm] Added explicit file extensions to imports in ${rewrittenFiles} files.`);
