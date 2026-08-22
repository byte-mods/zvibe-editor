import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assimpFactory from "assimpjs";
import { afterEach, expect, test } from "vitest";

import { convertGlbFileToFbx } from "../src/blender/converter.mjs";

const directories: string[] = [];
const executable = process.env.BJS_EDITOR_BLENDER_EXECUTABLE ?? "/Applications/Blender.app/Contents/MacOS/Blender";

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.once("error", reject);
		child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr.slice(-2048)}`))));
	});
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => remove(directory)));
});

test.runIf(process.env.FBX_LIVE_TEST === "1" && existsSync(executable))("round-trips animated Blender GLB through binary FBX and Assimp", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zvibe-fbx-live-"));
	directories.push(directory);
	const glbPath = join(directory, "source.glb");
	const expression = `import bpy; bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False); bpy.ops.mesh.primitive_cube_add(); cube=bpy.context.object; cube.name='Animated Cube'; material=bpy.data.materials.new('Round Trip Material'); material.diffuse_color=(0.1,0.4,0.8,1.0); cube.data.materials.append(material); cube.keyframe_insert(data_path='location',frame=1); cube.location=(3,2,1); cube.keyframe_insert(data_path='location',frame=24); bpy.ops.object.camera_add(location=(6,-8,5)); bpy.context.object.name='Round Trip Camera'; bpy.ops.object.light_add(type='POINT',location=(1,-2,4)); bpy.context.object.name='Round Trip Light'; bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glbPath)},export_format='GLB',export_animations=True,export_cameras=True,export_lights=True)`;
	await run(executable, ["--background", "--factory-startup", "--python-expr", expression]);

	const converted = await convertGlbFileToFbx(glbPath, { executable, timeoutMs: 30_000 });
	expect(converted.evidence).toMatchObject({
		model: "zvibe-fbx-export-v1",
		statistics: { meshCount: 1, cameraCount: 1, lightCount: 1, actionCount: 1 },
	});
	expect(converted.evidence.statistics.materialCount).toBeGreaterThanOrEqual(1);
	const fbxPath = join(directory, "round-trip.fbx");
	await writeFile(fbxPath, converted.content);

	const assimp = await assimpFactory();
	const files = new assimp.FileList();
	files.AddFile("round-trip.fbx", new Uint8Array(await readFile(fbxPath)));
	const imported = assimp.ConvertFileList(files, "glb2");
	expect(imported.IsSuccess()).toBe(true);
	expect(imported.FileCount()).toBe(1);
	const glb = Buffer.from(imported.GetFile(0).GetContent());
	expect(glb.readUInt32LE(0)).toBe(0x46546c67);
	expect(glb.readUInt32LE(4)).toBe(2);
});
