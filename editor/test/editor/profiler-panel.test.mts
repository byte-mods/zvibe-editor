import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { EditorProfiler } from "../../src/editor/layout/profiler";
import { captureProfilerSnapshot, getProfilerState } from "../../src/mcp/profiling/runner";

describe("EditorProfiler", () => {
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = { layout: { preview: { scene }, inspector: { forceUpdate: vi.fn() }, profiler: { forceUpdate: vi.fn() } } };
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("renders remote collection and the complete confirmed retained-evidence lifecycle", async () => {
		const state = getProfilerState(scene);
		await captureProfilerSnapshot(scene, { expectedRevision: state.revision, name: "Panel memory" }, { editor });

		class MemoryProfiler extends EditorProfiler {
			public constructor(props: any) {
				super(props);
				this.state = { ...this.state, view: "memory" };
			}
		}

		const markup = renderToStaticMarkup(createElement(MemoryProfiler, { editor }));
		expect(markup).toContain("Capture Snapshot");
		expect(markup).toContain("Panel memory");
		expect(markup).toContain("Delete");
		expect(markup).toContain("Clear All");
	});

	test("renders real-time 2D atlas occupancy", () => {
		(scene as any).spriteManagers = [
			{
				name: "UI Atlas",
				texture: { name: "ui.png", getSize: () => ({ width: 64, height: 64 }) },
				cellWidth: 32,
				cellHeight: 32,
				sprites: [{ cellIndex: 0, isVisible: true }],
				dispose: () => undefined,
			},
		];
		class TwoDProfiler extends EditorProfiler {
			public constructor(props: any) {
				super(props);
				this.state = { ...this.state, view: "2d-atlas" };
			}
		}

		const markup = renderToStaticMarkup(createElement(TwoDProfiler, { editor }));
		expect(markup).toContain('data-profiler-view="2d-atlas"');
		expect(markup).toContain("UI Atlas");
		expect(markup).toContain("texture atlas usage");
		expect(markup).toContain("1/4 regions used");
	});
});
