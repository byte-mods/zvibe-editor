import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { createDevelopmentBuildCoveragePlugin } from "babylonjs-editor-tools/build/development-coverage";

export default defineConfig({
	plugins: [createDevelopmentBuildCoveragePlugin(), tailwindcss()],
	base: "./",
	server: {
		port: 3000,
	},
	optimizeDeps: {
		exclude: ["@babylonjs/havok"],
	},
	build: {
		target: "esnext",
		outDir: process.env.BJS_EDITOR_BUILD_TARGET === "web" ? (process.env.BJS_EDITOR_OUTPUT_DIRECTORY ?? "dist") : "dist",
		sourcemap: process.env.BJS_EDITOR_SOURCE_MAPS === "true",
		minify: process.env.BJS_EDITOR_MINIFY === "false" ? false : "esbuild",
	},
});
