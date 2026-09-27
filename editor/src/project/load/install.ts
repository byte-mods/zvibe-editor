import { execNodePty } from "../../tools/node-pty";

import { EditorProjectPackageManager } from "../typings";

/**
 * Install the dependencies of the project located at the given working directory.
 * @param packageManager defines the package manager to use for installation.
 * @param cwd defines absolute path to the working directory where to install the dependencies.
 */
export async function installDependencies(packageManager: EditorProjectPackageManager, cwd: string) {
	let command = "";
	switch (packageManager) {
		case "npm":
			command = "npm i";
			break;
		case "pnpm":
			command = "pnpm i";
			break;
		case "bun":
			command = "bun i";
			break;
		default:
			command = "yarn";
			break;
	}

	const p = await execNodePty(command, { cwd });
	return p.wait();
}

/**
 * Installs the given babylonjs-editor-tools package.
 * @param packageManager defines the package manager to use for installation.
 * @param cwd defines absolute path to the working directory where to install the dependencies.
 * @param specifier defines what to install: the editor's vendored tarball ("file:./.zvibe/packages/…") or a registry version.
 */
export async function installBabylonJSEditorTools(packageManager: EditorProjectPackageManager, cwd: string, specifier: string) {
	let command = "";
	switch (packageManager) {
		case "npm":
			command = `npm install --save babylonjs-editor-tools@${specifier}`;
			break;
		case "pnpm":
			command = `pnpm add babylonjs-editor-tools@${specifier}`;
			break;
		case "bun":
			command = `bun add babylonjs-editor-tools@${specifier}`;
			break;
		default:
			command = `yarn add babylonjs-editor-tools@${specifier}`;
			break;
	}

	const p = await execNodePty(command, { cwd });
	return p.wait();
}

/**
 * Installs the given babylonjs-editor-cli package as a development dependency.
 * @param packageManager defines the package manager to use for installation.
 * @param cwd defines absolute path to the working directory where to install the dependencies.
 * @param specifier defines what to install: the editor's vendored tarball ("file:./.zvibe/packages/…") or a registry version.
 */
export async function installBabylonJSEditorCLI(packageManager: EditorProjectPackageManager, cwd: string, specifier: string) {
	let command = "";
	switch (packageManager) {
		case "npm":
			command = `npm install --save-dev babylonjs-editor-cli@${specifier}`;
			break;
		case "pnpm":
			command = `pnpm add -D babylonjs-editor-cli@${specifier}`;
			break;
		case "bun":
			command = `bun add --dev babylonjs-editor-cli@${specifier}`;
			break;
		default:
			command = `yarn add -D babylonjs-editor-cli@${specifier}`;
			break;
	}

	const p = await execNodePty(command, { cwd });
	return p.wait();
}
