import { Scene } from "babylonjs";
import {
	applyCustomRenderPassGraph,
	captureRenderGraphConformanceRun,
	inspectRenderGraphConformance,
	recordRenderGraphConformanceRun,
	renderGraphConformanceMetadataKey,
	validateRenderGraphConformanceManifest,
} from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import { listCustomRenderPasses } from "./custom-passes";

function state(scene: Scene): ReturnType<typeof validateRenderGraphConformanceManifest> {
	scene.metadata ??= {};
	const value = validateRenderGraphConformanceManifest(scene.metadata[renderGraphConformanceMetadataKey]);
	if (value) {
		scene.metadata[renderGraphConformanceMetadataKey] = value;
	}
	return value;
}

/** Reads static target requirements and exact persisted live runs without certifying an unexecuted backend. */
export function getRenderGraphConformance(scene: Scene): any {
	const passes = listCustomRenderPasses(scene).passes;
	const inspection = inspectRenderGraphConformance(scene as any, passes);
	const manifest = state(scene);
	const current = manifest?.graphSignature === inspection.graphSignature;
	return {
		...inspection,
		revision: manifest?.revision ?? null,
		manifestGraphSignature: manifest?.graphSignature ?? null,
		current: Boolean(current),
		runs: {
			webgl2: manifest?.runs.webgl2
				? { ...structuredClone(manifest.runs.webgl2), current: Boolean(current && manifest.runs.webgl2.graphSignature === inspection.graphSignature) }
				: null,
			webgpu: manifest?.runs.webgpu
				? { ...structuredClone(manifest.runs.webgpu), current: Boolean(current && manifest.runs.webgpu.graphSignature === inspection.graphSignature) }
				: null,
		},
		coverage: {
			webgl2: current && manifest?.runs.webgl2?.passed ? "passed" : current && manifest?.runs.webgl2 ? "failed" : "notRun",
			webgpu: current && manifest?.runs.webgpu?.passed ? "passed" : current && manifest?.runs.webgpu ? "failed" : "notRun",
			portable: Boolean(current && manifest?.runs.webgl2?.passed && manifest?.runs.webgpu?.passed),
		},
	};
}

/** Rebuilds and submits bounded real frames on the current backend, then persists exact readiness evidence. */
export async function runRenderGraphConformance(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!scene.activeCamera) {
		throw new Error("No active camera is available for render-graph conformance.");
	}
	const previous = state(scene);
	const expectedRevision = data.expectedRevision ?? null;
	if (expectedRevision !== (previous?.revision ?? null)) {
		throw new Error(`Render-graph conformance revision is stale. Expected ${previous?.revision ?? "null"}.`);
	}
	const frameCount = data.frameCount ?? 4;
	if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 8) {
		throw new Error("Render-graph conformance frameCount must be an integer from 1 through 8.");
	}
	const passes = listCustomRenderPasses(scene).passes;
	let runtimeError: string | null = null;
	try {
		applyCustomRenderPassGraph(scene as any, scene.activeCamera as any, passes, getProjectAssetsRootUrl() ?? "");
		options.editor.layout.preview?.setRenderScene?.(true);
		for (let frame = 0; frame < frameCount; frame++) {
			scene.render();
			await new Promise<void>((resolve) => setTimeout(resolve, 16));
		}
	} catch (error) {
		runtimeError = error instanceof Error ? error.message : String(error);
	}
	const run = captureRenderGraphConformanceRun(scene as any, scene.activeCamera as any, passes, frameCount, runtimeError);
	recordRenderGraphConformanceRun(scene as any, run);
	options.editor.layout.inspector.forceUpdate();
	return getRenderGraphConformance(scene);
}

/** Clears the exact persisted conformance revision without changing the authored graph or its runtime. */
export function clearRenderGraphConformance(scene: Scene, data: any, options: IMCPActionOptions): any {
	const manifest = state(scene);
	if (!manifest) {
		throw new Error("No render-graph conformance evidence is stored.");
	}
	if (data.revision !== manifest.revision) {
		throw new Error(`Render-graph conformance revision is stale. Expected ${manifest.revision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Clearing render-graph conformance evidence requires confirm: true.");
	}
	delete scene.metadata[renderGraphConformanceMetadataKey];
	options.editor.layout.inspector.forceUpdate();
	return { cleared: true, revision: manifest.revision, graphSignature: manifest.graphSignature };
}
