import { ParticleSystem, GPUParticleSystem, Tools, AbstractMesh, Texture } from "babylonjs";

import { UniqueNumber } from "../../tools/tools";

import { Editor } from "../../editor/main";

const defaultParticleTextureDataUrl =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";

function createDefaultParticleTexture(editor: Editor): Texture {
	const texture = new Texture(defaultParticleTextureDataUrl, editor.layout.preview.scene, true, false, Texture.NEAREST_SAMPLINGMODE);
	texture.name = "Default Particle Texture";
	return texture;
}

export function addParticleSystem(editor: Editor, emitter: AbstractMesh) {
	const particleSystem = new ParticleSystem("New Particle System", 1_000, editor.layout.preview.scene);
	particleSystem.id = Tools.RandomId();
	particleSystem.uniqueId = UniqueNumber.Get();
	particleSystem.emitter = emitter;
	particleSystem.preventAutoStart = true;
	particleSystem.particleTexture = createDefaultParticleTexture(editor);

	particleSystem.emitRate = 100;
	particleSystem.minSize = 1;
	particleSystem.maxSize = 100;

	particleSystem.direction1.set(-100, -100, -100);
	particleSystem.direction2.set(100, 100, 100);

	particleSystem.minEmitBox.set(-100, -100, -100);
	particleSystem.maxEmitBox.set(100, 100, 100);

	editor.layout.graph.refresh().then(() => {
		editor.layout.graph.setSelectedNode(particleSystem);
	});

	editor.layout.inspector.setEditedObject(particleSystem);
	editor.layout.preview.gizmo.setAttachedObject(particleSystem.emitter);
	return particleSystem;
}

export function addGPUParticleSystem(editor: Editor, emitter: AbstractMesh) {
	const particleSystem = new GPUParticleSystem(
		"New GPU Particle System",
		{
			capacity: 100_000,
		},
		editor.layout.preview.scene
	);
	particleSystem.id = Tools.RandomId();
	particleSystem.uniqueId = UniqueNumber.Get();
	particleSystem.emitter = emitter;
	particleSystem.preventAutoStart = true;
	particleSystem.particleTexture = createDefaultParticleTexture(editor);

	particleSystem.emitRate = 1000;
	particleSystem.minSize = 1;
	particleSystem.maxSize = 100;

	particleSystem.direction1.set(-100, -100, -100);
	particleSystem.direction2.set(100, 100, 100);

	particleSystem.minEmitBox.set(-100, -100, -100);
	particleSystem.maxEmitBox.set(100, 100, 100);

	editor.layout.graph.refresh().then(() => {
		editor.layout.graph.setSelectedNode(particleSystem);
	});

	editor.layout.inspector.setEditedObject(particleSystem);
	editor.layout.preview.gizmo.setAttachedObject(particleSystem.emitter);
	return particleSystem;
}
