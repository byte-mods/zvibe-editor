import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	server: {
		port: 3000,
	},
	optimizeDeps: {
		exclude: ["@babylonjs/havok"],
	},
	build: {
		target: "esnext",
		outDir: process.env.BJS_EDITOR_OUTPUT_DIRECTORY ?? "dist",
		sourcemap: process.env.BJS_EDITOR_SOURCE_MAPS === "true",
		minify: process.env.BJS_EDITOR_MINIFY === "false" ? false : "esbuild",
	},
});
