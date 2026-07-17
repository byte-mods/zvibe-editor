import { dirname } from "path/posix";

import { GizmoCoordinatesMode, Scene } from "babylonjs";

import { execNodePty } from "../tools/node-pty";

import { IMCPActionOptions } from "./action";

const editorTabs = ["graph", "preview", "assets-browser", "console", "terminal", "inspector", "animations", "marketplace"] as const;

export function getGizmoSettings(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	const preview = options.editor.layout.preview;
	return {
		activeGizmo: preview.state.activeGizmo,
		snap: preview.gizmo.getSnapPreferences(),
		coordinateMode: preview.gizmo.getCoordinatesModeString().toLowerCase(),
	};
}

export function setGizmoSettings(_scene: Scene, data: any, options: IMCPActionOptions): any {
	const preview = options.editor.layout.preview;
	if (data.activeGizmo !== undefined) {
		preview.setActiveGizmo(data.activeGizmo);
	}
	if (data.snap !== undefined) {
		preview.updateGizmoSnapPreferences({ ...preview.gizmo.getSnapPreferences(), ...data.snap });
	}
	if (data.coordinateMode !== undefined) {
		preview.gizmo.setCoordinatesMode(data.coordinateMode === "world" ? GizmoCoordinatesMode.World : GizmoCoordinatesMode.Local);
	}
	return getGizmoSettings(_scene, data, options);
}

export function listEditorTabs(): any {
	return { tabs: editorTabs };
}

export function selectEditorTab(_scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!editorTabs.includes(data.tab)) {
		throw new Error(`Unknown editor tab: ${data.tab}`);
	}
	options.editor.layout.selectTab(data.tab);
	return { selectedTab: data.tab };
}

export function writeEditorConsole(_scene: Scene, data: any, options: IMCPActionOptions): any {
	const level = data.level ?? "log";
	options.editor.layout.console[level](data.message);
	options.editor.layout.selectTab("console");
	return { written: true, level };
}

export function clearEditorConsole(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	options.editor.layout.console.clear();
	return { cleared: true };
}

export async function runEditorTerminalCommand(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}

	const output: string[] = [];
	const terminal = await execNodePty(data.command, { cwd: dirname(options.editor.state.projectPath) });
	const observer = terminal.onGetDataObservable.add((chunk) => {
		if (output.join("").length < 65536) {
			output.push(chunk);
		}
	});
	const exitCode = await terminal.wait();
	terminal.onGetDataObservable.remove(observer);

	options.editor.layout.selectTab("terminal");
	return { exitCode, output: output.join("").slice(0, 65536), truncated: output.join("").length > 65536 };
}
