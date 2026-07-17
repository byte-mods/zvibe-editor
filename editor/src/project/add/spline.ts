import { Mesh, MeshBuilder, Node, Vector3 } from "babylonjs";

import { Editor } from "../../editor/main";

import { configureAddedMesh } from "./configure";

/** Adds an editable tube mesh backed by persisted spline control points. */
export function addSplineMesh(editor: Editor, parent?: Node): Mesh {
	const points = [new Vector3(-100, 0, 0), new Vector3(0, 0, 0), new Vector3(100, 0, 0)];
	const spline = MeshBuilder.CreateTube("New Spline", { path: points, radius: 10, tessellation: 8, cap: Mesh.CAP_ALL, updatable: true }, editor.layout.preview.scene);
	spline.metadata = {
		type: "Spline",
		points: points.map((point) => point.asArray()),
		radius: 10,
		tessellation: 8,
		closed: false,
	};

	return configureAddedMesh(editor, spline, parent) as Mesh;
}
