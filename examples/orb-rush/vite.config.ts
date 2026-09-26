import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	server: {
		port: 3000,
	},
	resolve: {
		// Always bundle a single copy of Babylon.js, even when babylonjs-editor-tools is linked locally.
		dedupe: ["@babylonjs/core", "@babylonjs/gui", "@babylonjs/materials", "@babylonjs/addons", "@babylonjs/havok"],
	},
	optimizeDeps: {
		exclude: ["@babylonjs/havok"],
	},
	base: "./",
	build: {
		target: "esnext",
		outDir: process.env.BJS_EDITOR_OUTPUT_DIRECTORY ?? "dist",
		sourcemap: process.env.BJS_EDITOR_SOURCE_MAPS === "true",
		minify: process.env.BJS_EDITOR_MINIFY === "false" ? false : "esbuild",
	},
});
