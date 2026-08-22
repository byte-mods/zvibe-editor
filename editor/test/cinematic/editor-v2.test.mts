import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";

import {
	createCinematicClip,
	createCinematicDocument,
	createCinematicKey,
	createCinematicMarker,
	createCinematicRecorderProfile,
	createCinematicTrack,
} from "babylonjs-editor-tools";

import {
	createDefaultCinematicClip,
	createDefaultCinematicCut,
	createDefaultCinematicKey,
	createDefaultCinematicMarker,
	createDefaultCinematicTrack,
	createDefaultRecorderProfile,
} from "../../src/editor/layout/cinematic/v2/defaults";
import { CinematicDocumentEditor } from "../../src/editor/layout/cinematic/v2/editor";
import { CinematicDocumentInspector } from "../../src/editor/layout/cinematic/v2/inspector";

const resources: { scene: Scene; engine: NullEngine }[] = [];

function scene(): Scene {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	resources.push({ scene, engine });
	const target = new TransformNode("Hero", scene);
	target.id = "hero";
	const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
	camera.id = "camera";
	scene.activeCamera = camera;
	return scene;
}

afterEach(() => {
	for (const resource of resources.splice(0)) {
		resource.scene.dispose();
		resource.engine.dispose();
	}
});

describe("version-2 cinematic Timeline editor", () => {
	test("renders complete track authoring, transport, settings, and inspector surfaces", () => {
		const previewScene = scene();
		let document = createCinematicDocument("AAA Timeline", "aaa-timeline");
		const profile = createDefaultRecorderProfile();
		document = createCinematicRecorderProfile(document, document.revision, profile);
		for (const type of ["group", "property", "animation", "audio", "activation", "camera", "signal", "control", "recorder"] as const) {
			const track = createDefaultCinematicTrack(document, previewScene, type);
			document = createCinematicTrack(document, document.revision, track);
			if (["property", "animation", "audio"].includes(type)) {
				const value = createDefaultCinematicKey(track, 0);
				document = createCinematicKey(document, document.revision, track.id, value.lane, value.key);
			} else if (type === "signal") {
				const marker = createDefaultCinematicMarker(0);
				document = createCinematicMarker(document, document.revision, track.id, marker);
			} else if (!["group"].includes(type)) {
				const clip = createDefaultCinematicClip(document, previewScene, track, 0);
				document = createCinematicClip(document, document.revision, track.id, clip);
			}
		}
		const editor = { layout: { preview: { scene: previewScene } }, state: { projectPath: null } } as any;
		const markup = renderToStaticMarkup(createElement(CinematicDocumentEditor, { editor, absolutePath: "/tmp/aaa.cinematic", document, fingerprint: "initial" }));
		expect(markup).toContain("AAA Timeline");
		expect(markup).toContain("Reset Preview");
		expect(markup).toContain("Capture");
		expect(markup).toContain("Settings");
		expect(markup).toContain("Add Cut @ 0");
		expect(markup).toContain("Add Capture Profile");
		expect(markup).toContain('draggable="true"');
		for (const type of ["group", "property", "animation", "audio", "activation", "camera", "signal", "control", "recorder"]) {
			expect(markup).toContain(`${type[0].toUpperCase()}${type.slice(1)} Track`);
		}
		expect(markup).toContain("Timeline Settings");
		expect(markup).toContain("Capture Profiles");
	});

	test("renders type-specific clip, key, marker, and capture-profile inspectors", () => {
		const previewScene = scene();
		let document = createCinematicDocument("Inspect", "inspect");
		const property = createDefaultCinematicTrack(document, previewScene, "property");
		document = createCinematicTrack(document, document.revision, property);
		const key = createDefaultCinematicKey(property, 3);
		document = createCinematicKey(document, document.revision, property.id, key.lane, key.key);
		const cut = createDefaultCinematicCut(property, 5);
		document = createCinematicKey(document, document.revision, property.id, cut.lane, cut.key);
		const signal = createDefaultCinematicTrack(document, previewScene, "signal");
		document = createCinematicTrack(document, document.revision, signal);
		const marker = createDefaultCinematicMarker(4);
		document = createCinematicMarker(document, document.revision, signal.id, marker);
		const camera = createDefaultCinematicTrack(document, previewScene, "camera");
		document = createCinematicTrack(document, document.revision, camera);
		const clip = createDefaultCinematicClip(document, previewScene, camera, 0);
		document = createCinematicClip(document, document.revision, camera.id, clip);
		const profile = createDefaultRecorderProfile();
		document = createCinematicRecorderProfile(document, document.revision, profile);
		const base = { document, commit: () => undefined, onSelection: () => undefined };

		expect(
			renderToStaticMarkup(createElement(CinematicDocumentInspector, { ...base, selection: { kind: "key", trackId: property.id, itemId: key.key.id, lane: key.lane } }))
		).toContain("Interpolation");
		expect(
			renderToStaticMarkup(createElement(CinematicDocumentInspector, { ...base, selection: { kind: "key", trackId: property.id, itemId: cut.key.id, lane: cut.lane } }))
		).toContain("Property Cut");
		expect(renderToStaticMarkup(createElement(CinematicDocumentInspector, { ...base, selection: { kind: "marker", trackId: signal.id, itemId: marker.id } }))).toContain(
			"Retroactive On Seek"
		);
		expect(renderToStaticMarkup(createElement(CinematicDocumentInspector, { ...base, selection: { kind: "clip", trackId: camera.id, itemId: clip.id } }))).toContain(
			"Blend Mode"
		);
		expect(renderToStaticMarkup(createElement(CinematicDocumentInspector, { ...base, selection: { kind: "profile", trackId: "", itemId: profile.id } }))).toContain(
			"Include Audio"
		);
	});

	test("hides descendants of collapsed groups while preserving the group row", () => {
		const previewScene = scene();
		let document = createCinematicDocument("Hierarchy", "hierarchy");
		const group = { ...createDefaultCinematicTrack(document, previewScene, "group"), name: "Collapsed Parent", collapsed: true };
		document = createCinematicTrack(document, document.revision, group);
		const child = { ...createDefaultCinematicTrack(document, previewScene, "property"), name: "Hidden Child", parentId: group.id };
		document = createCinematicTrack(document, document.revision, child);
		const editor = { layout: { preview: { scene: previewScene } }, state: { projectPath: null } } as any;
		const markup = renderToStaticMarkup(createElement(CinematicDocumentEditor, { editor, absolutePath: "/tmp/hierarchy.cinematic", document, fingerprint: "initial" }));

		expect(markup).toContain("Collapsed Parent");
		expect(markup).not.toContain("Hidden Child");
	});
});
