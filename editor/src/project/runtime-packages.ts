import { join } from "path";
import { fileURLToPath } from "url";
import { copyFile, ensureDir, pathExists, readdir, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";

/**
 * One of this editor's own builds of babylonjs-editor-tools / babylonjs-editor-cli, packed by
 * scripts/pack-runtime-packages.mjs and shipped next to the editor. The upstream npm packages share these names and
 * version numbers but lack this editor's features, so projects install these tarballs instead of the registry versions.
 */
export interface IEditorRuntimePackage {
	name: string;
	version: string;
	/** Tarball file name, unique per build. */
	file: string;
	/** Content hash stamped into the packed package.json as "zvibeEditorBuild". */
	build: string;
}

export interface IEditorRuntimePackages {
	tools: IEditorRuntimePackage;
	cli: IEditorRuntimePackage;
}

/** Project-relative directory holding the vendored tarballs, committed with the project so any machine can install it. */
export const projectRuntimePackagesDirectory = ".zvibe/packages";

/**
 * Returns the directory holding the editor's runtime package tarballs, next to the editor like the project templates.
 * @param pageUrl defines the URL of the editor or dashboard page (its index.html lives in the application path).
 */
export function getEditorRuntimePackagesDirectory(pageUrl: string): string {
	return fileURLToPath(new URL(process.env.DEBUG ? "packages/" : "../../packages/", pageUrl));
}

function isRuntimePackage(value: any): value is IEditorRuntimePackage {
	return (
		typeof value?.name === "string" &&
		typeof value.version === "string" &&
		typeof value.file === "string" &&
		/^[\w.@-]+\.tgz$/.test(value.file) &&
		typeof value.build === "string" &&
		/^[a-f0-9]{64}$/.test(value.build)
	);
}

/**
 * Reads the manifest of the runtime packages shipped with the editor.
 * @param packagesDirectory defines the absolute path of the editor's packages directory.
 * @returns the packages, or null when this editor build does not ship them (they are packed by the repository build).
 */
export async function readEditorRuntimePackages(packagesDirectory: string): Promise<IEditorRuntimePackages | null> {
	const manifestPath = join(packagesDirectory, "manifest.json");
	if (!(await pathExists(manifestPath))) {
		return null;
	}
	const manifest = await readJSON(manifestPath);
	const tools = manifest?.packages?.tools;
	const cli = manifest?.packages?.cli;
	if (manifest?.version !== 1 || !isRuntimePackage(tools) || !isRuntimePackage(cli) || tools.name !== "babylonjs-editor-tools" || cli.name !== "babylonjs-editor-cli") {
		throw new Error(`Invalid editor runtime packages manifest: ${manifestPath}`);
	}
	return { tools, cli };
}

/**
 * Returns the package.json dependency specifier of a vendored runtime package.
 * @param runtimePackage defines the vendored package.
 */
export function getRuntimePackageSpecifier(runtimePackage: IEditorRuntimePackage): string {
	return `file:./${projectRuntimePackagesDirectory}/${runtimePackage.file}`;
}

/**
 * Copies the editor's runtime package tarballs into the project and removes older vendored builds of the same packages.
 * @param projectDirectory defines the absolute path of the project.
 * @param packagesDirectory defines the absolute path of the editor's packages directory.
 * @param packages defines the packages to vendor.
 */
export async function vendorEditorRuntimePackages(projectDirectory: string, packagesDirectory: string, packages: IEditorRuntimePackages): Promise<void> {
	const destination = join(projectDirectory, projectRuntimePackagesDirectory);
	await ensureDir(destination);

	const entries = [packages.tools, packages.cli];
	for (const file of await readdir(destination)) {
		const stale = entries.some((entry) => file !== entry.file && file.startsWith(`${entry.name}-`) && file.endsWith(".tgz"));
		if (stale) {
			await remove(join(destination, file));
		}
	}
	for (const entry of entries) {
		await copyFile(join(packagesDirectory, entry.file), join(destination, entry.file));
	}
}

/**
 * Points the project's package.json at the vendored tarballs (keeping each package in the dependency section it is
 * declared in) and drops yarn.lock entries of the previous versions so the next install resolves the tarballs.
 * @param projectDirectory defines the absolute path of the project.
 * @param packages defines the vendored packages.
 */
export async function useVendoredEditorRuntimePackages(projectDirectory: string, packages: IEditorRuntimePackages): Promise<void> {
	const packageJsonPath = join(projectDirectory, "package.json");
	const packageJson = await readJSON(packageJsonPath);
	for (const [entry, defaultField] of [
		[packages.tools, "dependencies"],
		[packages.cli, "devDependencies"],
	] as const) {
		const field =
			packageJson.dependencies?.[entry.name] !== undefined ? "dependencies" : packageJson.devDependencies?.[entry.name] !== undefined ? "devDependencies" : defaultField;
		packageJson[field] = { ...packageJson[field], [entry.name]: getRuntimePackageSpecifier(entry) };
	}
	await writeJSON(packageJsonPath, packageJson, { spaces: "\t", encoding: "utf-8" });

	const lockfilePath = join(projectDirectory, "yarn.lock");
	if (await pathExists(lockfilePath)) {
		const lockfile = await readFile(lockfilePath, "utf-8");
		const names = [packages.tools.name, packages.cli.name];
		const blocks = lockfile.split(/\n\n/);
		const retained = blocks.filter((block) => {
			const header = block.split("\n").find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(" "));
			return (
				!header ||
				!names.some((name) =>
					header
						.replace(/"/g, "")
						.split(/,\s*/)
						.some((pattern) => pattern.startsWith(`${name}@`))
				)
			);
		});
		if (retained.length !== blocks.length) {
			await writeFile(lockfilePath, retained.join("\n\n"), "utf-8");
		}
	}
}

/**
 * Returns whether the exact given build of a runtime package is installed for the project, searching parent
 * node_modules folders for monorepos where it is hoisted. A registry package with the same version does not match.
 * @param projectDirectory defines the absolute path of the project.
 * @param runtimePackage defines the expected package build.
 */
export async function isEditorRuntimePackageInstalled(projectDirectory: string, runtimePackage: IEditorRuntimePackage): Promise<boolean> {
	const segments = projectDirectory.replace(/\\/g, "/").split("/");
	while (segments.length > 0) {
		const manifestPath = join(segments.join("/") || "/", "node_modules", runtimePackage.name, "package.json");
		if (await pathExists(manifestPath)) {
			try {
				return (await readJSON(manifestPath)).zvibeEditorBuild === runtimePackage.build;
			} catch {
				return false;
			}
		}
		segments.pop();
	}
	return false;
}
