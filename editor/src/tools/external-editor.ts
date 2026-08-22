import { execNodePty } from "./node-pty";

/**
 * Launches a configured external editor with one absolute project path.
 * Commands are deliberately restricted to a single executable name/path so project
 * preferences cannot inject arbitrary shell fragments into the editor terminal.
 */
export async function openInExternalEditor(command: string, absolutePath: string): Promise<number> {
	const executable = command.trim();
	if (!executable) {
		throw new Error("Configure an external editor command before opening files.");
	}
	if (/[\r\n;&|`$<>"']/.test(executable)) {
		throw new Error("External editor command must be a single executable name or path without shell operators.");
	}
	if (/[\r\n"']/.test(absolutePath)) {
		throw new Error("The requested path contains unsupported characters.");
	}

	const process = await execNodePty(`"${executable}" "${absolutePath}"`);
	return process.wait();
}
