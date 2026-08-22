# Zvibe Editor Extension SDK

Zvibe Editor extensions are ordinary direct project dependencies with a strict `zvibeEditor` declaration in `package.json`. The editor inspects and fingerprints the declaration and package content before any extension code runs. A machine-local trust grant is bound to the exact package fingerprint and requested capabilities, so a package update or privilege change requires a new grant.

## Package manifest

The package must expose a CommonJS entry through `main` and declare API version 1. Contribution identifiers must start with the extension identifier.

```json
{
	"name": "my-zvibe-extension",
	"version": "1.0.0",
	"main": "dist/index.js",
	"zvibeEditor": {
		"apiVersion": 1,
		"id": "example.tools",
		"displayName": "Example Tools",
		"description": "Project-specific editor tools.",
		"capabilities": ["inspectors", "windows", "menus", "tests", "buildProfiles"],
		"contributes": {
			"inspectors": [{ "id": "example.tools.mesh", "title": "Example Mesh", "priority": 10 }],
			"windows": [{ "id": "example.tools.window", "title": "Example", "neighborId": "assets-browser" }],
			"menus": [{ "id": "example.tools.open", "path": "Extensions/Example Tools" }],
			"tests": [{ "id": "example.tools.smoke", "title": "Example smoke test" }],
			"buildProfileFooterActions": [
				{
					"id": "example.tools.verify-build",
					"title": "Verify Build Inputs",
					"description": "Runs project-specific checks for the selected profile.",
					"order": 100,
					"targets": ["web", "electron", "headless", "android", "ios"],
					"activeProfileOnly": false
				}
			]
		}
	}
}
```

Supported capabilities are `inspectors`, `windows`, `menus`, `tests`, `buildProfiles`, and `editor`. Contributions are declarative and are validated before activation. A contribution also requires its matching capability. Packages are discovered only from the active project's direct dependencies; transitive dependencies are not loaded as extensions.

## Lifecycle

The package entry exports `activate` and may export `deactivate`. The public types are available from `babylonjs-editor`.

```tsx
import type { IEditorExtensionContext } from "babylonjs-editor";

export async function activate(context: IEditorExtensionContext): Promise<() => void> {
	context.windows.register({ id: "example.tools.window", component: ExampleWindow });
	context.menus.register({ id: "example.tools.open", execute: () => context.windows.open("example.tools.window") });
	context.tests.register({ id: "example.tools.smoke", run: () => verifyExtensionState() });
	context.buildProfiles.registerFooterAction({
		id: "example.tools.verify-build",
		execute: async ({ configurationRevision, profile }) => verifyBuildInputs(configurationRevision, profile),
	});
	return () => disposeExtensionResources();
}

export function deactivate(): void {
	disposeExtensionResources();
}
```

The context exposes only granted capabilities. Registrations must match declarations in the manifest. The host tracks every registration and cleanup callback, isolates contributed React UI with an error boundary, bounds extension test and Build Profile action duration, and removes windows, menus, inspectors, tests, footer actions, and lifecycle resources when an extension is suspended, reloaded, updated, removed, or the project closes. Footer callbacks receive a frozen selected-profile snapshot and configuration revision; use the `activeProfileOnly` and `targets` declaration to constrain where the action appears. `getEditor()` requires the `editor` capability and grants the extension the existing public editor API; only grant it to code you trust.

## Install, enable, and trust

Use the Package Manager to install the dependency, then open Project Settings → Extensions. A valid package can be enabled only after its current content and capability fingerprint is trusted. Enabled package names persist in the project file; trust records remain local to the workstation. Package Manager changes suspend active extensions before dependency mutation and rediscover or reactivate them only after a successful exact-state reconciliation.

The bundled Fab and Quixel integrations implement this lifecycle while retaining their legacy entry points for older projects.

## External MCP workflow

Codex CLI and Claude Code can inspect and operate the same host through ten strict tools:

- `get_editor_extension_sdk` and `list_editor_extensions` inspect the SDK and installed state without executing extension code.
- `plan_editor_extension_change` creates a short-lived, no-write enable, disable, trust, untrust, install, update, or remove plan.
- `apply_editor_extension_plan` requires the exact plan, current fingerprint, and literal confirmation.
- `reload_editor_extension`, `open_editor_extension_window`, and `invoke_editor_extension_menu` reject stale content or undeclared ownership.
- `run_editor_extension_tests` runs only manifest-declared, registered tests under the bounded host runner.
- `list_build_profile_footer_actions` pages eligible declarations for an exact selected or active Build Profile without executing extension code.
- `invoke_build_profile_footer_action` requires confirmation, the exact Build Profiles configuration revision, and the extension fingerprint, then revalidates declaration, activation, registration, target, and active-profile eligibility before bounded execution.

`.mcp.json` configures the repository's project-scoped server for Claude Code. Codex CLI can use the built MCP server at `mcp/server/index.mjs`. Package installation remains owned by the Package Manager; the extension MCP surface does not provide an arbitrary file writer or module loader.

## Security boundary

An activated extension is trusted local code and can have the privileges of the Electron renderer and any explicitly granted editor API. The fingerprint and capability grant prevent silent activation after a content or privilege change; they are not an operating-system sandbox. Review extension source and provenance before granting trust.
