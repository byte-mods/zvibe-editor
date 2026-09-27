import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tmpdir } from "os";
import { join } from "path";
import { ensureDir, mkdtemp, pathExists, readdir, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";

import {
	IEditorRuntimePackages,
	isEditorRuntimePackageInstalled,
	readEditorRuntimePackages,
	useVendoredEditorRuntimePackages,
	vendorEditorRuntimePackages,
} from "../../src/project/runtime-packages";

const toolsBuild = "a".repeat(64);
const cliBuild = "b".repeat(64);

const packages: IEditorRuntimePackages = {
	tools: { name: "babylonjs-editor-tools", version: "5.4.3-alpha.1", file: "babylonjs-editor-tools-5.4.3-alpha.1-aaaaaaaaaaaa.tgz", build: toolsBuild },
	cli: { name: "babylonjs-editor-cli", version: "5.4.3-alpha.1", file: "babylonjs-editor-cli-5.4.3-alpha.1-bbbbbbbbbbbb.tgz", build: cliBuild },
};

describe("project/runtime-packages", () => {
	let root: string;
	let packagesDirectory: string;
	let project: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "zvibe-runtime-packages-"));
		packagesDirectory = join(root, "editor/packages");
		project = join(root, "workspace/game");
		await ensureDir(packagesDirectory);
		await ensureDir(project);
		await writeJSON(join(packagesDirectory, "manifest.json"), { version: 1, packages });
		await writeFile(join(packagesDirectory, packages.tools.file), "tools tarball");
		await writeFile(join(packagesDirectory, packages.cli.file), "cli tarball");
	});

	afterEach(async () => {
		await remove(root);
	});

	test("reads the packages shipped with the editor, or null when this build ships none", async () => {
		expect(await readEditorRuntimePackages(packagesDirectory)).toEqual(packages);
		expect(await readEditorRuntimePackages(join(root, "missing"))).toBeNull();

		await writeJSON(join(packagesDirectory, "manifest.json"), { version: 1, packages: { ...packages, tools: { ...packages.tools, file: "../escape.tgz" } } });
		await expect(readEditorRuntimePackages(packagesDirectory)).rejects.toThrow("Invalid editor runtime packages manifest");
	});

	test("points a new project at the vendored tarballs instead of the upstream registry packages", async () => {
		await writeJSON(join(project, "package.json"), {
			dependencies: { "@babylonjs/core": "9.12.1", "babylonjs-editor-tools": "latest" },
			devDependencies: { "babylonjs-editor-cli": "latest", vite: "7.3.5" },
		});
		await writeFile(
			join(project, "yarn.lock"),
			[
				"# yarn lockfile v1",
				'"@babylonjs/core@9.12.1":\n  version "9.12.1"',
				'babylonjs-editor-tools@latest:\n  version "5.0.0"\n  resolved "https://registry.yarnpkg.com/babylonjs-editor-tools/-/babylonjs-editor-tools-5.0.0.tgz"',
				'"babylonjs-editor-cli@5.4.3-alpha.1", babylonjs-editor-cli@latest:\n  version "5.4.3-alpha.1"',
				'vite@7.3.5:\n  version "7.3.5"',
			].join("\n\n")
		);
		// A stale build of the same package from a previous editor version.
		await ensureDir(join(project, ".zvibe/packages"));
		await writeFile(join(project, ".zvibe/packages/babylonjs-editor-tools-5.4.2-cccccccccccc.tgz"), "old");

		await vendorEditorRuntimePackages(project, packagesDirectory, packages);
		await useVendoredEditorRuntimePackages(project, packages);

		expect((await readdir(join(project, ".zvibe/packages"))).sort()).toEqual([packages.cli.file, packages.tools.file]);
		expect(await readFile(join(project, ".zvibe/packages", packages.tools.file), "utf-8")).toBe("tools tarball");
		const packageJson = await readJSON(join(project, "package.json"));
		expect(packageJson.dependencies).toEqual({ "@babylonjs/core": "9.12.1", "babylonjs-editor-tools": `file:./.zvibe/packages/${packages.tools.file}` });
		expect(packageJson.devDependencies).toEqual({ "babylonjs-editor-cli": `file:./.zvibe/packages/${packages.cli.file}`, vite: "7.3.5" });

		const lockfile = await readFile(join(project, "yarn.lock"), "utf-8");
		expect(lockfile).toContain('"@babylonjs/core@9.12.1"');
		expect(lockfile).toContain("vite@7.3.5");
		expect(lockfile).not.toContain("babylonjs-editor-tools@");
		expect(lockfile).not.toContain("babylonjs-editor-cli@");
	});

	test("recognizes only the exact vendored build as installed, including when hoisted to a parent folder", async () => {
		const installed = join(root, "workspace/node_modules/babylonjs-editor-tools/package.json");
		expect(await isEditorRuntimePackageInstalled(project, packages.tools)).toBe(false);

		// The upstream registry package shares the name and version but carries no build stamp.
		await ensureDir(join(root, "workspace/node_modules/babylonjs-editor-tools"));
		await writeJSON(installed, { name: "babylonjs-editor-tools", version: "5.4.3-alpha.1" });
		expect(await isEditorRuntimePackageInstalled(project, packages.tools)).toBe(false);

		await writeJSON(installed, { name: "babylonjs-editor-tools", version: "5.4.3-alpha.1", zvibeEditorBuild: toolsBuild });
		expect(await isEditorRuntimePackageInstalled(project, packages.tools)).toBe(true);
		expect(await pathExists(join(project, "node_modules"))).toBe(false);
	});
});
