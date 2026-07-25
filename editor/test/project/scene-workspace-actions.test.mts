import { describe, expect, test, vi } from "vitest";

import { runSceneWorkspaceOperation } from "../../src/project/scene-workspace-actions";

describe("project scene workspace command lane", () => {
	test("serializes concurrent UI and MCP lifecycle operations", async () => {
		const editor = {} as any;
		const events: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
		const first = runSceneWorkspaceOperation(editor, async () => {
			events.push("first:start");
			await firstGate;
			events.push("first:end");
			return 1;
		});
		const secondOperation = vi.fn(async () => {
			events.push("second:start");
			return 2;
		});
		const second = runSceneWorkspaceOperation(editor, secondOperation);

		await Promise.resolve();
		expect(events).toEqual(["first:start"]);
		expect(secondOperation).not.toHaveBeenCalled();
		releaseFirst();
		expect(await Promise.all([first, second])).toEqual([1, 2]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});
});
