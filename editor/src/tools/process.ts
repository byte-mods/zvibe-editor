import { platform } from "os";
import { exec, execSync } from "child_process";

import { EditorProjectPackageManager } from "../project/typings";

import { execNodePty } from "./node-pty";

/**
 * Get the file path argument from the command line arguments.
 * @param argv The command line arguments.
 * @returns The file path argument or null if none was found.
 */
export function getFilePathArgument(argv?: string[] | null): string | null {
	if (!argv) {
		return null;
	}

	// Development Electron argv contains the editor application directory before
	// the project path, whereas a packaged app receives the project at argv[1].
	// Locate the actual project file instead of relying on one platform index.
	return argv.slice(1).find((value) => !value.startsWith("--") && value.toLowerCase().endsWith(".bjseditor")) ?? null;
}

/** Builds relaunch arguments for one exact project, replacing any stale project arguments from the original application launch. */
export function getProjectRelaunchArguments(argv: string[], projectPath: string, excludedArgumentPrefixes: readonly string[] = []): string[] {
	return [
		...argv.slice(1).filter((argument) => !argument.toLowerCase().endsWith(".bjseditor") && !excludedArgumentPrefixes.some((prefix) => argument.startsWith(prefix))),
		projectPath,
	];
}

let envPathComputed = false;

/**
 * Executes the given command asynchronously using `child_process`
 * @param command defines the command to execute.
 */
export function executeAsync(command: string): Promise<void> {
	if (!envPathComputed) {
		try {
			switch (platform()) {
				case "darwin":
					const path = execSync("/usr/libexec/path_helper -s", {
						encoding: "utf8",
					});

					const match = path.match(/PATH="([^"]+)"/);
					if (match) {
						process.env.PATH = match[1];
					}
					break;
			}
		} catch (e) {
			console.error("Failed to execute /usr/bin/env to get the environment variables:", e);
		} finally {
			envPathComputed = true;
		}
	}

	return new Promise<void>((resolve, reject) => {
		exec(command, (error, stdout, stderr) => {
			if (error) {
				console.error(command, stderr);
				reject(error);
			} else {
				console.log(command, stdout);
				resolve();
			}
		});
	});
}

export let nodeJSAvailable: boolean = false;
export let packageManagerAvailable: boolean = false;
export let visualStudioCodeAvailable: boolean = false;

/**
 * Checks wether or not Node.js is available on the system.
 * Updates the `nodeJSAvailable` variable that can be imported from this file.
 */
export async function checkNodeJSAvailable(): Promise<void> {
	try {
		const p = await execNodePty("node --version");
		const code = await p.wait();

		if (code === 0) {
			nodeJSAvailable = true;
		}
	} catch (e) {
		// Catch silently.
	}
}

/**
 * Checks wether or not Visual Studio Code is available on the system.
 * Updates the `visualStudioCodeAvailable` variable that can be imported from this file.
 */
export async function checkVisualStudioCodeAvailable(): Promise<void> {
	try {
		const p = await execNodePty("code --version");
		const code = await p.wait();

		if (code === 0) {
			visualStudioCodeAvailable = true;
		}
	} catch (e) {
		// Catch silently.
	}
}

/**
 * Checks wether or not the used package manager (yarn, npm, etc.) is available on the system.
 * Updates the `packageManagerAvailable` variable that can be imported from this file.
 * @param packageManager The package manager to check for availability.
 */
export async function checkPackageManagerAvailable(packageManager: EditorProjectPackageManager): Promise<void> {
	if (packageManagerAvailable) {
		return;
	}

	if (await isPackageManagerAvailable(packageManager)) {
		packageManagerAvailable = true;
	}
}

/**
 * Returns wether or not the given package manager is available on the system.
 * @param packageManager The package manager to check for availability.
 */
export async function isPackageManagerAvailable(packageManager: EditorProjectPackageManager): Promise<boolean> {
	try {
		let command = "";
		switch (packageManager) {
			case "npm":
				command = "npm -v";
				break;
			case "pnpm":
				command = "pnpm -v";
				break;
			case "bun":
				command = "bun -v";
				break;
			default:
				command = "yarn -v";
				break;
		}

		const p = await execNodePty(command);
		const code = await p.wait();

		return code === 0;
	} catch (e) {
		return false;
	}
}
