import { describe, expect, test } from "vitest";

import { readJSON } from "fs-extra";
import { join } from "path/posix";

describe("editor/script-debugger-panel", () => {
	test("ships a persistent normal-layout Script Debugger workspace", async () => {
		const layout = await readJSON(join(import.meta.dirname, "../../src/editor/layout.json"));
		const tabs: any[] = [];
		const visit = (node: any): void => {
			if (node?.type === "tab") {
				tabs.push(node);
			}
			node?.children?.forEach(visit);
		};
		visit(layout.layout);
		expect(tabs).toContainEqual(
			expect.objectContaining({ id: "script-debugger", name: "Script Debugger", component: "script-debugger", enableClose: false, enableRenderOnDemand: false })
		);
	});
});
