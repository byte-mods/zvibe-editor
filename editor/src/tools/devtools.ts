/**
 * Returns whether development tools should open automatically for newly-created windows.
 *
 * Development mode enables several editor behaviors and is always active for unpackaged builds,
 * so opening DevTools must use a separate explicit switch. This also avoids Electron DevTools
 * protocol diagnostics being emitted for every dashboard, editor, and auxiliary window.
 */
export function shouldAutoOpenDevTools(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment.DEBUG === "true" && environment.AUTO_OPEN_DEVTOOLS === "true";
}
