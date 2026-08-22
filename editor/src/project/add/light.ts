import { DirectionalLight, HemisphericLight, Node, PointLight, RectAreaLight, SpotLight, Tools, Vector3 } from "babylonjs";
import { setAreaLightProperties } from "babylonjs-editor-tools";

import { UniqueNumber } from "../../tools/tools";
import { isClusteredLightContainer } from "../../tools/guards/nodes";

import { Editor } from "../../editor/main";

export function addPointLight(editor: Editor, parent?: Node) {
	const light = new PointLight("New Point Light", Vector3.Zero(), editor.layout.preview.scene);
	light.position.set(100, 100, 100);
	light.id = Tools.RandomId();
	light.uniqueId = UniqueNumber.Get();

	if (parent && isClusteredLightContainer(parent)) {
		parent.addLight(light);
	} else {
		light.parent = parent ?? null;
	}

	editor.layout.graph.refresh().then(() => {
		editor.layout.graph.setSelectedNode(light);
	});

	editor.layout.inspector.setEditedObject(light);
	editor.layout.preview.gizmo.setAttachedObject(light);

	return light;
}

export function addDirectionalLight(editor: Editor, parent?: Node) {
	const light = new DirectionalLight("New Directional Light", new Vector3(-1, -2, -1), editor.layout.preview.scene);
	light.position.set(100, 200, 100);
	light.id = Tools.RandomId();
	light.uniqueId = UniqueNumber.Get();
	light.parent = parent ?? null;

	editor.layout.graph.refresh().then(() => {
		editor.layout.graph.setSelectedNode(light);
	});

	editor.layout.inspector.setEditedObject(light);
	editor.layout.preview.gizmo.setAttachedObject(light);

	return light;
}

export function addSpotLight(editor: Editor, parent?: Node) {
	const light = new SpotLight("New Spot Light", new Vector3(100, 100, 100), new Vector3(-1, -2, -1), Math.PI * 0.5, Math.PI, editor.layout.preview.scene);
	light.id = Tools.RandomId();
	light.uniqueId = UniqueNumber.Get();

	if (parent && isClusteredLightContainer(parent)) {
		parent.addLight(light);
	} else {
		light.parent = parent ?? null;
	}

	editor.layout.graph.refresh().then(() => {
		editor.layout.graph.setSelectedNode(light);
	});

	editor.layout.inspector.setEditedObject(light);
	editor.layout.preview.gizmo.setAttachedObject(light);

	return light;
}

export function addHemisphericLight(editor: Editor, parent?: Node) {
	const light = new HemisphericLight("New Hemispheric Light", new Vector3(-1, -2, -1), editor.layout.preview.scene);
	light.id = Tools.RandomId();
	light.uniqueId = UniqueNumber.Get();
	light.parent = parent ?? null;

	editor.layout.graph.refresh().then(() => {
		editor.layout.graph.setSelectedNode(light);
	});

	editor.layout.inspector.setEditedObject(light);
	editor.layout.preview.gizmo.setAttachedObject(light);

	return light;
}

function addAreaLight(editor: Editor, shape: "rectangle" | "disc", parent?: Node): RectAreaLight {
	const light = new RectAreaLight(shape === "disc" ? "New Disc Area Light" : "New Rectangle Area Light", new Vector3(100, 200, 100), 200, 100, editor.layout.preview.scene);
	setAreaLightProperties(light as any, {
		shape,
		width: 200,
		height: 100,
		radius: 75,
		direction: [0, -1, 0],
		upDirection: [0, 0, 1],
		revision: 1,
	});
	light.id = Tools.RandomId();
	light.uniqueId = UniqueNumber.Get();
	light.range = 1000;
	light.parent = parent && !isClusteredLightContainer(parent) ? parent : null;

	editor.layout.graph.refresh().then(() => {
		editor.layout.graph.setSelectedNode(light);
	});
	editor.layout.inspector.setEditedObject(light);
	editor.layout.preview.gizmo.setAttachedObject(light);
	return light;
}

export function addRectangleAreaLight(editor: Editor, parent?: Node): RectAreaLight {
	return addAreaLight(editor, "rectangle", parent);
}

export function addDiscAreaLight(editor: Editor, parent?: Node): RectAreaLight {
	return addAreaLight(editor, "disc", parent);
}
