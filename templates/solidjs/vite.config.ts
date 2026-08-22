import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
	plugins: [solidPlugin(), tailwindcss()],
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
