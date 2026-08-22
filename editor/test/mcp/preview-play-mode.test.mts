import { describe, expect, test, vi } from "vitest";

import { setPreviewPlayMode } from "../../src/mcp/editor";

describe("preview Play MCP lifecycle", () => {
	test("waits for the React stop-state commit before acknowledging external clients", async () => {
		const play = {
			state: { playing: true, preparingPlay: false, loading: false },
			stop: vi.fn((onStopped: () => void) => {
				setTimeout(() => {
					play.state.playing = false;
					onStopped();
				}, 0);
			}),
		};
		let settled = false;
		const result = setPreviewPlayMode({} as any, { action: "stop" }, { editor: { layout: { preview: { play } } } } as any).then((value) => {
			settled = true;
			return value;
		});

		expect(settled).toBe(false);
		await expect(result).resolves.toMatchObject({ action: "stop", playing: false, preparing: false, loading: false });
		expect(play.stop).toHaveBeenCalledOnce();
	});
});
