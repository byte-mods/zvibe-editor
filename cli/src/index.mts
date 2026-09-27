import dotEnv from "dotenv";
import { Command } from "commander";

import packageJson from "../package.json" with { type: "json" };

import { s3 } from "./s3/s3.mjs";
import { pack } from "./pack/pack.mjs";
import { runHeadlessTesting } from "./test/testing.mjs";

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

program
	.command("test")
	.description("Runs bounded portable tests from exported .babylon scenes through Babylon NullEngine for CI/headless validation.")
	.argument("[projectDir]", "The root directory of the project to test", process.cwd())
	.option("--scene <name>", "Run one exported scene name/path inside public/scene.")
	.option("--modes <modes>", "Comma-separated edit and/or play modes.", "edit,play")
	.option("--categories <categories>", "Comma-separated category filter.")
	.option("--filter <text>", "Case/suite name or category substring filter.")
	.option("--fail-fast", "Stop after the first failing scene/case.", false)
	.option("--report <path>", "Write a project-relative JSON or JUnit XML report.")
	.option("--format <format>", "Report format: json or junit.", "json")
	.action(
		async (
			projectDir: string,
			options: { scene?: string; modes: string; categories?: string; filter?: string; failFast: boolean; report?: string; format: string }
		): Promise<void> => {
			const modes = [...new Set(options.modes.split(",").map((value) => value.trim()))];
			if (!modes.length || modes.some((mode) => mode !== "edit" && mode !== "play")) {
				program.error("--modes must contain edit and/or play.");
			}
			if (options.format !== "json" && options.format !== "junit") {
				program.error("--format must be json or junit.");
			}
			const format = options.format as "json" | "junit";
			const report = await runHeadlessTesting(projectDir, {
				scene: options.scene,
				modes: modes as ("edit" | "play")[],
				categories: options.categories
					? options.categories
							.split(",")
							.map((value) => value.trim())
							.filter(Boolean)
					: undefined,
				filter: options.filter,
				failFast: options.failFast,
				report: options.report,
				format,
			});
			console.log(
				`Testing ${report.status}: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed, ${report.summary.timedOut} timed out.${options.report ? ` Report: ${options.report}` : ""}`
			);
			if (report.status !== "passed") {
				process.exitCode = 1;
			}
		}
	);

// No top-level await: the command line is also bundled as CommonJS (see esbuild.mjs).
program.parseAsync().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
