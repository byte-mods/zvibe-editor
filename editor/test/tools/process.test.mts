import { describe, expect, it } from "vitest";

import { getFilePathArgument, getProjectRelaunchArguments } from "../../src/tools/process";

describe("project command-line arguments", () => {
	it("finds a packaged macOS project at argv[1]", () => {
		expect(getFilePathArgument(["/Applications/Zvibe Editor.app/Contents/MacOS/Zvibe Editor", "/projects/game/project.bjseditor"])).toBe("/projects/game/project.bjseditor");
	});

	it("skips the development application directory and Electron flags", () => {
		expect(getFilePathArgument(["Electron", "/repo/editor", "--inspect=8315", "/projects/game/project.bjseditor"])).toBe("/projects/game/project.bjseditor");
	});

	it("does not mistake an application directory or unrelated argument for a project", () => {
		expect(getFilePathArgument(["Electron", "/repo/editor", "--inspect=8315"])).toBeNull();
		expect(getFilePathArgument(null)).toBeNull();
	});

	it("replaces every stale project and restart argument with the exact current project", () => {
		expect(
			getProjectRelaunchArguments(
				[
					"Electron",
					"/repo/editor",
					"/projects/original/project.bjseditor",
					"--inspect=8315",
					"/projects/current/project.bjseditor",
					"--zvibe-platform-restart-plan=old",
				],
				"/projects/current/project.bjseditor",
				["--zvibe-platform-restart-"]
			)
		).toEqual(["/repo/editor", "--inspect=8315", "/projects/current/project.bjseditor"]);
	});
});
