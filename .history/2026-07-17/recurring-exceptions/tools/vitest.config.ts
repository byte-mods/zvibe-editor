import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Node 26 exposes an unused experimental localStorage getter that warns once per worker; runtime tests provide their own storage doubles where needed.
		execArgv: ["--no-experimental-webstorage"],
		include: ["./test/**/*.test.ts"],
	},
});
