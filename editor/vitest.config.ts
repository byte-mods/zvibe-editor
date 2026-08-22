import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Node 26 exposes an unused experimental localStorage getter that warns once per worker; editor tests provide their own storage doubles where needed.
		execArgv: ["--no-experimental-webstorage"],
		include: ["./test/**/*.test.mts"],
		// Integration tests intentionally spawn real Git, platform-build, and compiler processes. Leave their own 30-second process guards reachable while limiting host contention.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		maxWorkers: "50%",
	},
});
