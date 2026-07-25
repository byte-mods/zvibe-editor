import dotEnv from "dotenv";
import { Command } from "commander";

import packageJson from "../package.json" with { type: "json" };

import { s3 } from "./s3/s3.mjs";
import { pack } from "./pack/pack.mjs";

dotEnv.config();

const program = new Command();

program
	.version(packageJson.version)
	.name("Babylon.js Editor CLI")
	.description("Babylon.js Editor CLI is a command line interface to help you package your scenes made using the Babylon.js Editor")
	.option("-h, --help", "display help for command");

program
	.command("pack")
	.description("Packs the project located in the specified directory. Current directory is used by default.")
	.argument("[projectDir]", "The root directory of the project to package", process.cwd())
	.option("--merge-geometries", "Optimize the loading process of geometries by merging them into a single file.", false)
	.option("--merge-decals", "Try to optimize draw calls count by merging decals which share the same material into a single mesh and geometry.", false)
	.option("--model-platform <platform>", "Resolve Default, Web, or Desktop model importer overrides.", "default")
	.option("--asset-platform <platform>", "Resolve Default, Web, or Desktop texture and model importer overrides.")
	.action((projectDir: string, options: { mergeGeometries: boolean; mergeDecals: boolean; modelPlatform: string; assetPlatform?: string }) => {
		if (!new Set(["default", "web", "desktop"]).has(options.modelPlatform)) {
			program.error("--model-platform must be default, web, or desktop.");
		}
		if (options.assetPlatform !== undefined && !new Set(["default", "web", "desktop"]).has(options.assetPlatform)) {
			program.error("--asset-platform must be default, web, or desktop.");
		}
		pack(projectDir, {
			...options,
			modelPlatform: options.modelPlatform as "default" | "web" | "desktop",
			assetPlatform: (options.assetPlatform ?? options.modelPlatform) as "default" | "web" | "desktop",
			optimize: true,
		});
	});

program
	.command("s3")
	.description("Packs and deploys the project located in the specified directory into a S3 bucket. Current directory is used by default.")
	.argument("[projectDir]", "The root directory of the project to package and deploy into a S3 bucket.", process.cwd())
	.option("--merge-geometries", "Optimize the loading process of geometries by merging them into a single file.", false)
	.option("--merge-decals", "Try to optimize draw calls count by merging decals which share the same material into a single mesh and geometry.", false)
	.action((projectDir: string, options: { mergeGeometries: boolean; mergeDecals: boolean }) => {
		s3(projectDir, {
			...options,
			optimize: true,
		});
	});

program.parse();
