// Packs this repository's builds of babylonjs-editor-tools and babylonjs-editor-cli into "editor/packages", which the
// editor ships (electron-builder "extraFiles") and copies into every new project. New projects then install the fork's
// runtime and CLI from those tarballs instead of the upstream packages of the same name on npm, which lack this
// editor's features. Run after building tools and cli.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const outputDirectory = join(root, "editor/packages");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, cwd) {
	return execFileSync(npm, args, { cwd, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "inherit"] });
}

/**
 * Packs one workspace from a staging copy of exactly the files `npm pack` would publish, so its manifest can be adapted
 * without touching the workspace.
 */
async function pack(workspace, adaptManifest) {
	const directory = join(root, workspace);
	const [dryRun] = JSON.parse(run(["pack", "--dry-run", "--json", "--ignore-scripts"], directory));
	const staging = await mkdtemp(join(tmpdir(), `zvibe-pack-${workspace}-`));

	try {
		for (const file of dryRun.files) {
			await mkdir(dirname(join(staging, file.path)), { recursive: true });
			await cp(join(directory, file.path), join(staging, file.path));
		}

		// Identifies this exact build: the upstream npm packages share names and version numbers with this fork, so the
		// editor recognizes its own installed runtime by this stamp rather than by version.
		const build = createHash("sha256");
		for (const file of [...dryRun.files].sort((left, right) => left.path.localeCompare(right.path))) {
			if (file.path !== "package.json") {
				build
					.update(file.path)
					.update("\0")
					.update(await readFile(join(staging, file.path)))
					.update("\0");
			}
		}

		const manifest = JSON.parse(await readFile(join(staging, "package.json"), "utf8"));
		adaptManifest(manifest);
		delete manifest.scripts;
		delete manifest.devDependencies;
		// Include the final manifest so dependency changes alone also produce a new build.
		build.update("package.json\0").update(JSON.stringify(manifest));
		manifest.zvibeEditorBuild = build.digest("hex");
		await writeFile(join(staging, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

		const [packed] = JSON.parse(run(["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory], staging));
		// Name each build uniquely: projects vendor the file, and package managers cache "file:" tarballs by path.
		const file = `${manifest.name}-${manifest.version}-${manifest.zvibeEditorBuild.slice(0, 12)}.tgz`;
		await rename(join(outputDirectory, packed.filename), join(outputDirectory, file));
		console.log(`Packed ${manifest.name}@${manifest.version} (${(packed.size / 1024 / 1024).toFixed(1)} MB) -> editor/packages/${file}`);
		return { name: manifest.name, version: manifest.version, file, build: manifest.zvibeEditorBuild, integrity: packed.integrity };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const tools = await pack("tools", () => {});
const cli = await pack("cli", (manifest) => {
	// The project provides the runtime (its own vendored tarball). As a regular dependency pinned to a version that also
	// exists upstream, package managers would install the upstream runtime again underneath the CLI.
	delete manifest.dependencies["babylonjs-editor-tools"];
	manifest.peerDependencies = { ...manifest.peerDependencies, "babylonjs-editor-tools": tools.version };
});

await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify({ version: 1, packages: { tools, cli } }, null, "\t")}\n`);
