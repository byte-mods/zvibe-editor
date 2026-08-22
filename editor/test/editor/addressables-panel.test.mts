import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { AddressablesInspector } from "../../src/editor/layout/inspector/scene/addressables";

describe("AddressablesInspector", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("renders profiles, update restrictions, content builds, deployments, reports, and runtime cache controls", () => {
		const editor = { layout: { assets: { refresh: () => undefined } } } as any;
		const markup = renderToStaticMarkup(createElement(AddressablesInspector, { scene, editor }));
		expect(markup).toContain("Profiles &amp; Runtime Settings");
		expect(markup).toContain("Prevent Updates");
		expect(markup).toContain("Update Previous");
		expect(markup).toContain("Content Builds &amp; Reports");
		expect(markup).toContain("Extract Shared TypeTrees");
		expect(markup).toContain("Analyze TypeTrees");
		expect(markup).toContain("HTTP PUT");
		expect(markup).toContain("S3-compatible");
		expect(markup).toContain("Publish Pointer Last");
		expect(markup).toContain("Runtime Catalog &amp; Cache");
		expect(markup).toContain("Download All");
	});
});
