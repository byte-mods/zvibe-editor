import { dirname, join } from "path/posix";
import { pathExists, readJSON } from "fs-extra";

import { Scene } from "babylonjs";

import { execNodePty } from "../../tools/node-pty";

import { IMCPActionOptions } from "../action";

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const packageVersion = /^[a-z0-9*+._~^<>=| -]+$/i;

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) throw new Error("No project is currently open.");
	return dirname(options.editor.state.projectPath);
}

/** Lists direct project dependencies as understood by the configured package manager. */
export async function listProjectPackages(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	const directory = projectDirectory(options);
	const packagePath = join(directory, "package.json");
	if (!(await pathExists(packagePath))) throw new Error("package.json is missing from the project root.");
	const packageJson = await readJSON(packagePath);
	return {
		packageManager: options.editor.state.packageManager ?? "yarn",
		name: packageJson.name,
		dependencies: packageJson.dependencies ?? {},
		devDependencies: packageJson.devDependencies ?? {},
	};
}

/** Produces the non-shell-interpolated package-manager command for a validated package operation. */
export function projectPackageCommand(manager: string, operation: "install" | "remove" | "update", name: string, version?: string): string {
	const specification = version ? `${name}@${version}` : name;
	if (operation === "remove") return manager === "npm" ? `npm uninstall ${name}` : `${manager} remove ${name}`;
	if (operation === "update") {
		if (manager === "npm") return version ? `npm install ${specification}` : `npm update ${name}`;
		return manager === "yarn" ? `yarn upgrade ${specification}` : `bun update ${specification}`;
	}
	return manager === "npm" ? `npm install ${specification}` : `${manager} add ${specification}`;
}

/** Installs, removes, or updates one dependency using the active project's configured package manager. */
export async function modifyProjectPackage(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!packageName.test(data.name)) throw new Error("Package name must be a normal npm package identifier.");
	if (data.version !== undefined && !packageVersion.test(data.version)) throw new Error("Package version contains unsupported shell characters.");
	const manager = options.editor.state.packageManager ?? "yarn";
	if (!["yarn", "npm", "bun"].includes(manager)) throw new Error(`Unsupported package manager "${manager}".`);
	if (!["install", "remove", "update"].includes(data.operation)) throw new Error('Package operation must be "install", "remove", or "update".');
	const command = projectPackageCommand(manager, data.operation, data.name, data.version);
	const process = await execNodePty(command, { cwd: projectDirectory(options) });
	const exitCode = await process.wait();
	if (exitCode !== 0) throw new Error(`Package-manager command failed with code ${exitCode}: ${command}`);
	return { operation: data.operation, name: data.name, version: data.version, packageManager: manager, command, ...(await listProjectPackages(scene, data, options)) };
}
