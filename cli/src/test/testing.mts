import { LoadAssetContainerAsync, NullEngine, Scene } from "babylonjs";
import { createPortableTestingState, IPortableTestRunReport, normalizePortableTestingState, portableTestRunToJUnit, runPortableTestSuites } from "babylonjs-editor-tools";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";

export interface IHeadlessTestingOptions {
	scene?: string;
	modes: ("edit" | "play")[];
	categories?: string[];
	filter?: string;
	failFast?: boolean;
	report?: string;
	format: "json" | "junit";
}

function within(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function sceneFiles(projectDirectory: string, selected?: string): Promise<string[]> {
	const directory = join(projectDirectory, "public", "scene");
	if (selected) {
		const candidate = resolve(directory, selected.endsWith(".babylon") ? selected : `${selected}.babylon`);
		if (!within(directory, candidate) || extname(candidate).toLowerCase() !== ".babylon") {
			throw new Error("--scene must identify a .babylon file inside public/scene.");
		}
		return [candidate];
	}
	const entries = await readdir(directory, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".babylon"))
		.map((entry) => join(directory, entry.name))
		.sort();
}

function mergeReports(reports: IPortableTestRunReport[]): IPortableTestRunReport {
	const started = Math.min(...reports.map((report) => Date.parse(report.startedAt)));
	const finished = Math.max(...reports.map((report) => Date.parse(report.finishedAt)));
	const results = reports.flatMap((report) => report.results);
	const summary = {
		total: results.length,
		passed: results.filter((result) => result.status === "passed").length,
		failed: results.filter((result) => result.status === "failed").length,
		skipped: results.filter((result) => result.status === "skipped").length,
		canceled: results.filter((result) => result.status === "canceled").length,
		timedOut: results.filter((result) => result.status === "timed-out").length,
	};
	return {
		id: `headless-test-${Date.now()}`,
		sequence: 1,
		target: "headless",
		status: summary.failed ? "failed" : summary.timedOut ? "timed-out" : "passed",
		startedAt: new Date(started).toISOString(),
		finishedAt: new Date(finished).toISOString(),
		durationMs: finished - started,
		filters: reports[0]?.filters ?? {},
		summary,
		results,
		limitations: [
			...new Set([
				...reports.flatMap((report) => report.limitations),
				"Headless Play cases execute declarative steps/assertions against a NullEngine scene; they do not compile project scripts or provide browser DOM, audio, WebGPU, native plugins, or visual screenshots.",
			]),
		],
	};
}

function metrics(scene: Scene): any {
	const engine = scene.getEngine();
	return {
		frameRate: engine.getFps(),
		frameTimeMs: engine.getDeltaTime(),
		drawCalls: (engine as any)._drawCalls?.current ?? null,
		activeMeshes: scene.getActiveMeshes().length,
		totalVertices: scene.getTotalVertices(),
		meshes: scene.meshes.length,
		materials: scene.materials.length,
		textures: scene.textures.length,
		lights: scene.lights.length,
		cameras: scene.cameras.length,
		particleSystems: scene.particleSystems.length,
		gpuFrameTimeMs: null,
		gpuFrameTimeAverageMs: null,
	};
}

/** Runs exported-scene portable tests through Babylon NullEngine for CI and local command-line checks. */
export async function runHeadlessTesting(projectDirectory: string, options: IHeadlessTestingOptions): Promise<IPortableTestRunReport> {
	const root = resolve(projectDirectory);
	const files = await sceneFiles(root, options.scene);
	if (!files.length) {
		throw new Error("No exported .babylon scenes were found in public/scene.");
	}
	const reports: IPortableTestRunReport[] = [];
	for (const file of files) {
		const serialized = JSON.parse(await readFile(file, "utf8"));
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
			const container = await LoadAssetContainerAsync(dataUrl, scene, { pluginExtension: ".babylon" });
			container.addAllToScene();
			const rawState = scene.metadata?.babylonEditorTesting ?? serialized.metadata?.babylonEditorTesting ?? createPortableTestingState();
			const state = normalizePortableTestingState(rawState);
			for (const suite of state.suites) {
				suite.name = `${basename(file, ".babylon")} / ${suite.name}`;
			}
			const report = await runPortableTestSuites(
				scene as any,
				state,
				{ modes: options.modes, categories: options.categories, search: options.filter, failFast: options.failFast },
				{ target: "headless", supportedModes: options.modes, measureMetrics: (target) => metrics(target as Scene) }
			);
			reports.push(report);
			if (options.failFast && report.status !== "passed") {
				break;
			}
		} finally {
			scene.dispose();
			engine.dispose();
		}
	}
	const report = mergeReports(reports);
	if (options.report) {
		const output = resolve(root, options.report);
		if (!within(root, output)) {
			throw new Error("--report must stay inside the project directory.");
		}
		const expectedExtension = options.format === "junit" ? ".xml" : ".json";
		if (extname(output).toLowerCase() !== expectedExtension) {
			throw new Error(`--report must end in ${expectedExtension} for ${options.format} format.`);
		}
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, options.format === "junit" ? portableTestRunToJUnit(report) : `${JSON.stringify(report, null, "\t")}\n`, "utf8");
	}
	return report;
}
