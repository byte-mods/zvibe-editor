import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	ALEMBIC_MAX_CACHE_BYTES,
	ALEMBIC_MAX_SOURCE_BYTES,
	FBX_EXPORT_MAX_OUTPUT_BYTES,
	FBX_EXPORT_MAX_SOURCE_BYTES,
	FBX_EXPORT_MODEL,
	FBX_EXPORT_VERSION,
	IAlembicCacheManifest,
	IAlembicImporterSettings,
	IFbxExportEvidence,
	IFbxExportSettings,
	normalizeAlembicImporterSettings,
	normalizeFbxExportSettings,
	parseAlembicCache,
} from "babylonjs-editor-tools";

const MAX_BLENDER_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_BLENDER_LOG_BYTES = 64 * 1024;
const DEFAULT_BLENDER_TIMEOUT_MS = 5 * 60 * 1000;

async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) {
		throw new Error("Alembic settings contain a value that cannot be serialized.");
	}
	return encoded;
}

const BLENDER_EXPORT_SCRIPT = `import bpy
import sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) != 2:
    raise RuntimeError("Expected input and output paths after --")

bpy.ops.wm.open_mainfile(filepath=argv[0])
bpy.ops.export_scene.gltf(filepath=argv[1], export_format="GLB", export_apply=True)
`;

/** Runs inside Blender and emits only bounded JSON evidence after a successful binary FBX publication. */
const BLENDER_FBX_EXPORT_SCRIPT = String.raw`import bpy
import json
import os
import sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) != 3:
    raise RuntimeError("Expected GLB input, FBX output, and settings JSON paths after --")

input_path, output_path, settings_path = argv
with open(settings_path, "r", encoding="utf-8") as handle:
    settings = json.load(handle)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=input_path)

if not settings["includeCameras"]:
    for obj in list(bpy.data.objects):
        if obj.type == "CAMERA":
            bpy.data.objects.remove(obj, do_unlink=True)
if not settings["includeLights"]:
    for obj in list(bpy.data.objects):
        if obj.type == "LIGHT":
            bpy.data.objects.remove(obj, do_unlink=True)
if not settings["includeMaterials"]:
    for obj in bpy.data.objects:
        if obj.type == "MESH":
            obj.data.materials.clear()

object_types = {"EMPTY", "MESH", "ARMATURE"}
if settings["includeCameras"]:
    object_types.add("CAMERA")
if settings["includeLights"]:
    object_types.add("LIGHT")

objects = list(bpy.data.objects)
if not objects:
    raise RuntimeError("The GLB contains no exportable objects")

result = bpy.ops.export_scene.fbx(
    filepath=output_path,
    check_existing=False,
    use_selection=False,
    object_types=object_types,
    global_scale=settings["globalScale"],
    apply_unit_scale=True,
    apply_scale_options="FBX_SCALE_ALL",
    use_space_transform=True,
    bake_space_transform=settings["applyTransforms"],
    axis_forward=settings["axisForward"],
    axis_up=settings["axisUp"],
    use_mesh_modifiers=settings["applyModifiers"],
    use_mesh_modifiers_render=settings["applyModifiers"],
    mesh_smooth_type="OFF",
    use_tspace=settings["exportTangents"],
    use_armature_deform_only=settings["useArmatureDeformOnly"],
    add_leaf_bones=settings["addLeafBones"],
    primary_bone_axis="Y",
    secondary_bone_axis="X",
    use_custom_props=settings["exportCustomProperties"],
    path_mode="COPY" if settings["embedTextures"] else "AUTO",
    embed_textures=settings["embedTextures"],
    bake_anim=settings["includeAnimations"],
    bake_anim_use_all_bones=settings["includeAnimations"],
    bake_anim_use_nla_strips=settings["includeAnimations"],
    bake_anim_use_all_actions=settings["includeAnimations"],
    bake_anim_force_startend_keying=settings["includeAnimations"],
    bake_anim_step=settings["animationSamplingRate"],
    bake_anim_simplify_factor=settings["animationSimplification"],
)
if "FINISHED" not in result or not os.path.isfile(output_path) or os.path.getsize(output_path) < 27:
    raise RuntimeError("Blender FBX export did not produce a non-empty binary file")

statistics = {
    "objectCount": len(objects),
    "meshCount": sum(1 for obj in objects if obj.type == "MESH"),
    "armatureCount": sum(1 for obj in objects if obj.type == "ARMATURE"),
    "cameraCount": sum(1 for obj in objects if obj.type == "CAMERA"),
    "lightCount": sum(1 for obj in objects if obj.type == "LIGHT"),
    "materialCount": len(bpy.data.materials) if settings["includeMaterials"] else 0,
    "actionCount": len(bpy.data.actions) if settings["includeAnimations"] else 0,
}
print("ZVIBE_FBX_EXPORT " + json.dumps({"blenderVersion": bpy.app.version_string, "statistics": statistics}, sort_keys=True, separators=(",", ":")))
`;

const BLENDER_ALEMBIC_CACHE_SCRIPT = String.raw`import array
import bpy
import hashlib
import json
import math
import os
import struct
import sys
import zlib
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) != 3:
    raise RuntimeError("Expected Alembic input, ZVABC output, and settings JSON paths after --")

input_path, output_path, settings_path = argv
with open(settings_path, "r", encoding="utf-8") as handle:
    settings = json.load(handle)

MAX_OBJECTS = 4096
MAX_SAMPLES = 10000
MAX_FRAME_VERTICES = 10000000
MAX_FRAME_INDICES = 30000000
MAX_FRAME_BYTES = 512 * 1024 * 1024
MAX_CACHE_BYTES = 1024 * 1024 * 1024
FRAME_MAGIC = 0x5246565A
FRAME_VERSION = 1
FLAG_NORMALS = 1 << 0
FLAG_UVS = 1 << 1
FLAG_COLORS = 1 << 2
FLAG_WIDTHS = 1 << 3
FLAG_MATERIALS = 1 << 4
FLAG_ORTHOGRAPHIC = 1 << 5
KIND_CODES = {"mesh": 1, "points": 2, "curves": 3, "camera": 4}

def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()

def finite(value, label):
    value = float(value)
    if not math.isfinite(value):
        raise RuntimeError(label + " is not finite")
    return value

scale = finite(settings["scaleFactor"], "scaleFactor") * (100.0 if settings["convertUnits"] else 1.0)
left_handed = settings["handedness"] == "babylonLeftHanded"
reverse_faces = bool(left_handed) != bool(settings["flipFaces"])

def coordinate(value):
    if left_handed:
        return (finite(value.x * scale, "coordinate x"), finite(value.z * scale, "coordinate y"), finite(value.y * scale, "coordinate z"))
    return (finite(value.x * scale, "coordinate x"), finite(value.z * scale, "coordinate y"), finite(-value.y * scale, "coordinate z"))

def direction(value):
    if left_handed:
        return (finite(value.x, "direction x"), finite(value.z, "direction y"), finite(value.y, "direction z"))
    return (finite(value.x, "direction x"), finite(value.z, "direction y"), finite(-value.y, "direction z"))

def object_path(obj):
    names = []
    current = obj
    while current is not None:
        names.append(current.name)
        current = current.parent
    return "/".join(reversed(names))

def bounds_from_positions(positions):
    if not positions:
        return None
    xs = positions[0::3]
    ys = positions[1::3]
    zs = positions[2::3]
    return {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}

def merge_bounds(left, right):
    if left is None:
        return right
    if right is None:
        return left
    return {
        "min": [min(left["min"][axis], right["min"][axis]) for axis in range(3)],
        "max": [max(left["max"][axis], right["max"][axis]) for axis in range(3)],
    }

def floats(values):
    result = array.array("f", values)
    if sys.byteorder != "little":
        result.byteswap()
    return result.tobytes()

def uint32s(values):
    result = array.array("I", values)
    if result.itemsize != 4:
        raise RuntimeError("Blender Python unsigned integer arrays are not 32-bit")
    if sys.byteorder != "little":
        result.byteswap()
    return result.tobytes()

def uint16s(values):
    result = array.array("H", values)
    if result.itemsize != 2:
        raise RuntimeError("Blender Python unsigned short arrays are not 16-bit")
    if sys.byteorder != "little":
        result.byteswap()
    return result.tobytes()

def attribute_color(mesh, loop_index, vertex_index):
    attribute = getattr(mesh.color_attributes, "active_color", None) if hasattr(mesh, "color_attributes") else None
    if attribute is None or len(attribute.data) == 0:
        return None
    index = loop_index if attribute.domain == "CORNER" else vertex_index
    if index >= len(attribute.data):
        return None
    value = getattr(attribute.data[index], "color", None)
    if value is None:
        return None
    return tuple(finite(component, "vertex color") for component in value[:4])

def mesh_state(obj, depsgraph, as_points=False):
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
    try:
        if as_points:
            positions = []
            colors = []
            has_colors = False
            for vertex_index, vertex in enumerate(mesh.vertices):
                positions.extend(coordinate(evaluated.matrix_world @ vertex.co))
                color = attribute_color(mesh, vertex_index, vertex_index)
                if color is not None:
                    has_colors = True
                    colors.extend(color)
                else:
                    colors.extend((1.0, 1.0, 1.0, 1.0))
            return {
                "kind": "points",
                "positions": positions,
                "normals": None,
                "uvs": None,
                "colors": colors if has_colors else None,
                "widths": None,
                "indices": [],
                "material_indices": None,
                "segments": [],
            }
        mesh.calc_loop_triangles()
        uv_data = mesh.uv_layers.active.data if mesh.uv_layers.active else None
        normal_matrix = evaluated.matrix_world.to_3x3().inverted_safe().transposed()
        positions = []
        normals = []
        uvs = []
        colors = []
        indices = []
        materials = []
        has_uvs = uv_data is not None
        has_colors = False
        include_normals = settings["normals"] != "none"
        cursor = 0
        for triangle in mesh.loop_triangles:
            loops = list(triangle.loops)
            if reverse_faces:
                loops = [loops[0], loops[2], loops[1]]
            for loop_index in loops:
                loop = mesh.loops[loop_index]
                vertex_index = loop.vertex_index
                positions.extend(coordinate(evaluated.matrix_world @ mesh.vertices[vertex_index].co))
                if include_normals:
                    source_normal = loop.normal if settings["normals"] == "import" else mesh.vertices[vertex_index].normal
                    normals.extend(direction((normal_matrix @ source_normal).normalized()))
                if uv_data is not None:
                    uvs.extend((finite(uv_data[loop_index].uv.x, "uv x"), finite(uv_data[loop_index].uv.y, "uv y")))
                color = attribute_color(mesh, loop_index, vertex_index)
                if color is not None:
                    has_colors = True
                    colors.extend(color)
                else:
                    colors.extend((1.0, 1.0, 1.0, 1.0))
                indices.append(cursor)
                cursor += 1
            materials.append(max(0, min(65535, int(triangle.material_index))))
        return {
            "kind": "mesh",
            "positions": positions,
            "normals": normals if include_normals else None,
            "uvs": uvs if has_uvs else None,
            "colors": colors if has_colors else None,
            "widths": None,
            "indices": indices,
            "material_indices": materials if materials else None,
            "segments": [],
        }
    finally:
        evaluated.to_mesh_clear()

def curve_state(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    if obj.type == "CURVES":
        positions = []
        widths = []
        segments = []
        for curve in evaluated.data.curves:
            points = list(curve.points)
            if len(points) < 2:
                continue
            for point in points:
                positions.extend(coordinate(evaluated.matrix_world @ point.position))
                widths.append(max(0.01, finite(point.radius * scale * 2.0, "curve point width")))
            segments.append(len(points))
        return {
            "kind": "curves",
            "positions": positions,
            "normals": None,
            "uvs": None,
            "colors": None,
            "widths": widths if widths else None,
            "indices": [],
            "material_indices": None,
            "segments": segments,
        }
    mesh = None
    try:
        mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        positions = []
        segments = []
        if len(mesh.edges):
            for edge in mesh.edges:
                positions.extend(coordinate(evaluated.matrix_world @ mesh.vertices[edge.vertices[0]].co))
                positions.extend(coordinate(evaluated.matrix_world @ mesh.vertices[edge.vertices[1]].co))
                segments.append(2)
        else:
            for spline in getattr(evaluated.data, "splines", []):
                points = list(spline.bezier_points) if len(spline.bezier_points) else list(spline.points)
                if len(points) < 2:
                    continue
                for point in points:
                    positions.extend(coordinate(evaluated.matrix_world @ point.co.to_3d()))
                segments.append(len(points))
        return {
            "kind": "curves",
            "positions": positions,
            "normals": None,
            "uvs": None,
            "colors": None,
            "widths": None,
            "indices": [],
            "material_indices": None,
            "segments": segments,
        }
    finally:
        if mesh is not None:
            evaluated.to_mesh_clear()

def camera_state(obj):
    matrix = obj.matrix_world
    position = coordinate(matrix.translation)
    forward = Vector(direction(matrix.to_quaternion() @ Vector((0.0, 0.0, -1.0))))
    up = Vector(direction(matrix.to_quaternion() @ Vector((0.0, 1.0, 0.0))))
    target = tuple(position[axis] + forward[axis] * 100.0 for axis in range(3))
    camera = obj.data
    values = list(position) + list(target) + list(up) + [
        finite(camera.angle, "camera fov"),
        max(0.001, finite(camera.clip_start * scale, "camera near")),
        max(0.002, finite(camera.clip_end * scale, "camera far")),
        max(0.001, finite(camera.ortho_scale * scale * 0.5, "camera ortho size")),
        0.0,
        0.0,
        0.0,
    ]
    return values[:16], camera.type == "ORTHO"

def is_visible(obj):
    try:
        return bool(obj.visible_get()) and not bool(obj.hide_render)
    except Exception:
        return not bool(obj.hide_render)

def mesh_has_polygon_schema(obj):
    for modifier in obj.modifiers:
        if modifier.type == "MESH_SEQUENCE_CACHE" and "POLY" in getattr(modifier, "read_data", set()):
            return True
    return False

def encode_state(object_index, descriptor, state, visible):
    if descriptor["kind"] == "camera":
        camera, orthographic = camera_state(descriptor["object"])
        flags = FLAG_ORTHOGRAPHIC if orthographic else 0
        return struct.pack("<IBBHIIII16f", object_index, KIND_CODES["camera"], 1 if visible else 0, flags, 0, 0, 0, 0, *camera)
    positions = state["positions"]
    normals = state["normals"]
    uvs = state["uvs"]
    colors = state["colors"]
    widths = state["widths"]
    indices = state["indices"]
    materials = state["material_indices"]
    segments = state["segments"]
    vertex_count = len(positions) // 3
    index_count = len(indices)
    flags = 0
    if normals is not None:
        flags |= FLAG_NORMALS
    if uvs is not None:
        flags |= FLAG_UVS
    if colors is not None:
        flags |= FLAG_COLORS
    if widths is not None:
        flags |= FLAG_WIDTHS
    if materials is not None:
        flags |= FLAG_MATERIALS
    header = struct.pack("<IBBHIIII16f", object_index, KIND_CODES[state["kind"]], 1 if visible else 0, flags, vertex_count, index_count, len(segments), 0, *([0.0] * 16))
    payload = bytearray(header)
    payload.extend(floats(positions))
    if normals is not None:
        payload.extend(floats(normals))
    if uvs is not None:
        payload.extend(floats(uvs))
    if colors is not None:
        payload.extend(floats(colors))
    if widths is not None:
        payload.extend(floats(widths))
    payload.extend(uint32s(indices))
    if materials is not None:
        payload.extend(uint16s(materials))
    payload.extend(uint32s(segments))
    return bytes(payload)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.wm.alembic_import(filepath=input_path, set_frame_range=True, validate_meshes=True)
scene = bpy.context.scene
fps = finite(scene.render.fps / scene.render.fps_base, "scene fps")
source_start = scene.frame_start / fps
source_end = scene.frame_end / fps
start_time = source_start if settings["startTimeSeconds"] < 0 else max(source_start, settings["startTimeSeconds"])
end_time = source_end if settings["endTimeSeconds"] < 0 else min(source_end, settings["endTimeSeconds"])
if end_time < start_time:
    raise RuntimeError("Requested Alembic time range does not overlap the imported archive")
duration = end_time - start_time
requested_samples = 1 if duration <= 0 else int(math.floor(duration * settings["sampleRate"] + 1e-9)) + 1
sample_count = min(requested_samples, int(settings["maximumSamples"]))
if requested_samples > int(settings["maximumSamples"]):
    raise RuntimeError("Alembic time range requires %d samples, exceeding maximumSamples %d" % (requested_samples, settings["maximumSamples"]))
if sample_count < 1 or sample_count > MAX_SAMPLES:
    raise RuntimeError("Alembic sample count is outside the portable cache limit")
times = [start_time] if sample_count == 1 else [start_time + duration * index / (sample_count - 1) for index in range(sample_count)]

first_frame = times[0] * fps
scene.frame_set(int(math.floor(first_frame)), subframe=first_frame - math.floor(first_frame))
depsgraph = bpy.context.evaluated_depsgraph_get()
descriptors = []
for obj in sorted(scene.objects, key=object_path):
    kind = None
    if obj.type == "MESH" and settings["importMeshes"]:
        evaluated = obj.evaluated_get(depsgraph)
        temporary = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        try:
            kind = "mesh" if len(temporary.polygons) or mesh_has_polygon_schema(obj) else ("points" if settings["importPoints"] else None)
        finally:
            evaluated.to_mesh_clear()
    elif obj.type == "POINTCLOUD" and settings["importPoints"]:
        kind = "points"
    elif obj.type in ("CURVE", "CURVES") and settings["importCurves"]:
        kind = "curves"
    elif obj.type == "CAMERA" and settings["importCameras"]:
        kind = "camera"
    if kind is None:
        continue
    slots = []
    if kind == "mesh":
        slots = [(slot.material.name if slot.material else "FaceSet %d" % index) for index, slot in enumerate(obj.material_slots)]
    descriptors.append({
        "object": obj,
        "id": hashlib.sha256(object_path(obj).encode("utf-8")).hexdigest()[:24],
        "name": obj.name,
        "path": object_path(obj),
        "kind": kind,
        "materialSlots": slots,
        "maximumVertexCount": 0,
        "maximumIndexCount": 0,
        "bounds": None,
        "signatures": [],
    })
if not descriptors:
    raise RuntimeError("Alembic archive contains no enabled mesh, point, curve, or camera objects")
if len(descriptors) > MAX_OBJECTS:
    raise RuntimeError("Alembic archive exceeds the %d-object limit" % MAX_OBJECTS)

payload = bytearray()
frames = []
maximum_frame_vertices = 0
maximum_frame_indices = 0
raw_frame_bytes = 0
global_bounds = None
for frame_index, time_seconds in enumerate(times):
    exact_frame = time_seconds * fps
    scene.frame_set(int(math.floor(exact_frame)), subframe=exact_frame - math.floor(exact_frame))
    depsgraph = bpy.context.evaluated_depsgraph_get()
    raw = bytearray(struct.pack("<IHH", FRAME_MAGIC, FRAME_VERSION, len(descriptors)))
    frame_vertices = 0
    frame_indices = 0
    for object_index, descriptor in enumerate(descriptors):
        obj = descriptor["object"]
        if descriptor["kind"] == "camera":
            state = None
        elif descriptor["kind"] == "curves":
            state = curve_state(obj, depsgraph)
        elif descriptor["kind"] == "points":
            state = mesh_state(obj, depsgraph, True)
        else:
            state = mesh_state(obj, depsgraph, False)
        raw.extend(encode_state(object_index, descriptor, state, is_visible(obj)))
        if state is not None:
            vertex_count = len(state["positions"]) // 3
            index_count = len(state["indices"])
            frame_vertices += vertex_count
            frame_indices += index_count
            descriptor["maximumVertexCount"] = max(descriptor["maximumVertexCount"], vertex_count)
            descriptor["maximumIndexCount"] = max(descriptor["maximumIndexCount"], index_count)
            sample_bounds = bounds_from_positions(state["positions"])
            descriptor["bounds"] = merge_bounds(descriptor["bounds"], sample_bounds)
            global_bounds = merge_bounds(global_bounds, sample_bounds)
            topology_signature = "%d:%d:%s:%s" % (
                vertex_count,
                index_count,
                sha256_bytes(uint32s(state["indices"])),
                sha256_bytes(uint32s(state["segments"])),
            )
            descriptor["signatures"].append(topology_signature)
        else:
            descriptor["signatures"].append("camera")
    if frame_vertices > MAX_FRAME_VERTICES or frame_indices > MAX_FRAME_INDICES:
        raise RuntimeError("Alembic frame %d exceeds geometry limits" % frame_index)
    if len(raw) > MAX_FRAME_BYTES:
        raise RuntimeError("Alembic frame %d exceeds decoded byte limits" % frame_index)
    compressed = zlib.compress(bytes(raw), 6)
    if len(compressed) > MAX_FRAME_BYTES:
        raise RuntimeError("Alembic frame %d exceeds compressed byte limits" % frame_index)
    offset = len(payload)
    payload.extend(compressed)
    if len(payload) > MAX_CACHE_BYTES:
        raise RuntimeError("Alembic cache exceeds the portable byte limit")
    frames.append({
        "timeSeconds": time_seconds,
        "offset": offset,
        "compressedBytes": len(compressed),
        "rawBytes": len(raw),
        "sha256": sha256_bytes(compressed),
    })
    maximum_frame_vertices = max(maximum_frame_vertices, frame_vertices)
    maximum_frame_indices = max(maximum_frame_indices, frame_indices)
    raw_frame_bytes += len(raw)

objects = []
for descriptor in descriptors:
    topology = "stable" if len(set(descriptor["signatures"])) <= 1 else "variable"
    objects.append({
        "id": descriptor["id"],
        "name": descriptor["name"],
        "path": descriptor["path"],
        "kind": descriptor["kind"],
        "topology": topology,
        "materialSlots": descriptor["materialSlots"],
        "maximumVertexCount": descriptor["maximumVertexCount"],
        "maximumIndexCount": descriptor["maximumIndexCount"],
        "bounds": descriptor["bounds"],
    })

settings_json = json.dumps(settings, sort_keys=True, separators=(",", ":")).encode("utf-8")
source_size = os.path.getsize(input_path)
manifest = {
    "format": "zvibe-alembic-cache",
    "version": 1,
    "generator": {"name": "Zvibe Editor Blender Alembic Adapter", "version": 1, "blenderVersion": bpy.app.version_string},
    "source": {"name": os.path.basename(input_path), "bytes": source_size, "sha256": sha256_file(input_path)},
    "settings": settings,
    "settingsSha256": sha256_bytes(settings_json),
    "coordinateSystem": settings["handedness"],
    "fps": fps,
    "startTimeSeconds": start_time,
    "endTimeSeconds": end_time,
    "durationSeconds": end_time - start_time,
    "sampleCount": sample_count,
    "objects": objects,
    "frames": frames,
    "bounds": global_bounds,
    "statistics": {
        "meshCount": sum(1 for value in objects if value["kind"] == "mesh"),
        "pointCount": sum(1 for value in objects if value["kind"] == "points"),
        "curveCount": sum(1 for value in objects if value["kind"] == "curves"),
        "cameraCount": sum(1 for value in objects if value["kind"] == "camera"),
        "stableTopologyCount": sum(1 for value in objects if value["topology"] == "stable"),
        "variableTopologyCount": sum(1 for value in objects if value["topology"] == "variable"),
        "maximumFrameVertices": maximum_frame_vertices,
        "maximumFrameIndices": maximum_frame_indices,
        "compressedFrameBytes": len(payload),
        "rawFrameBytes": raw_frame_bytes,
    },
}
manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
header = b"ZVABC1\r\n" + struct.pack("<II", len(manifest_bytes), zlib.crc32(manifest_bytes) & 0xFFFFFFFF)
if len(header) + len(manifest_bytes) + len(payload) > MAX_CACHE_BYTES:
    raise RuntimeError("Alembic cache exceeds the portable byte limit after manifest encoding")
with open(output_path, "wb") as handle:
    handle.write(header)
    handle.write(manifest_bytes)
    handle.write(payload)
`;

export interface IBlenderConversionOptions {
	executable?: string;
	timeoutMs?: number;
}

export interface IBlenderConversionResult {
	content: Uint8Array;
	executable: string;
	outputBytes: number;
	stdout: string;
	stderr: string;
}

export interface IAlembicConversionOptions extends IBlenderConversionOptions {
	settings: IAlembicImporterSettings;
}

export interface IAlembicConversionResult extends IBlenderConversionResult {
	manifest: IAlembicCacheManifest;
}

/** Blender selection plus the normalized portable export profile. */
export interface IFbxConversionOptions extends IBlenderConversionOptions {
	settings?: Partial<IFbxExportSettings>;
}

/** Validated binary output paired with exact source/output/generator evidence. */
export interface IFbxConversionResult extends IBlenderConversionResult {
	evidence: IFbxExportEvidence;
}

function blenderCandidates(explicit?: string): string[] {
	const configured = explicit ?? process.env.BJS_EDITOR_BLENDER_EXECUTABLE ?? process.env.BLENDER_EXECUTABLE;
	const values = [
		configured,
		...(process.platform === "darwin" ? ["/Applications/Blender.app/Contents/MacOS/Blender"] : []),
		...(process.platform === "win32" ? ["C:/Program Files/Blender Foundation/Blender 4.5/blender.exe", "C:/Program Files/Blender Foundation/Blender 4.4/blender.exe"] : []),
		"blender",
	].filter((value): value is string => !!value?.trim());
	return [...new Set(values)];
}

async function executableCanBeAttempted(executable: string): Promise<boolean> {
	if (executable === "blender") {
		return true;
	}
	try {
		await access(executable, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function appendBounded(current: string, chunk: Buffer): string {
	if (Buffer.byteLength(current) >= MAX_BLENDER_LOG_BYTES) {
		return current;
	}
	return `${current}${chunk.toString("utf-8", 0, Math.max(0, MAX_BLENDER_LOG_BYTES - Buffer.byteLength(current)))}`;
}

async function runBlender(executable: string, scriptPath: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["--background", "--factory-startup", "--python", scriptPath, "--", ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => (stdout = appendBounded(stdout, chunk)));
		child.stderr.on("data", (chunk: Buffer) => (stderr = appendBounded(stderr, chunk)));
		child.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`Blender conversion exceeded the ${timeoutMs.toLocaleString()} ms timeout.`));
			} else if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new Error(`Blender exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.${stderr.trim() ? ` ${stderr.trim().slice(-2048)}` : ""}`));
			}
		});
	});
}

function validateGlb(content: Buffer): void {
	if (content.length < 20 || content.length > MAX_BLENDER_OUTPUT_BYTES) {
		throw new Error(`Blender produced an invalid or oversized GLB payload (${content.length.toLocaleString()} bytes).`);
	}
	if (content.readUInt32LE(0) !== 0x46546c67 || content.readUInt32LE(4) !== 2 || content.readUInt32LE(8) !== content.length) {
		throw new Error("Blender produced a malformed GLB v2 header.");
	}
}

/** Rejects ASCII, truncated, and unsupported binary FBX outputs before any caller can publish them. */
function validateFbx(content: Buffer): number {
	const magic = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
	if (content.length < 27 || content.length > FBX_EXPORT_MAX_OUTPUT_BYTES || !content.subarray(0, magic.length).equals(magic)) {
		throw new Error(`Blender produced an invalid, ASCII, or oversized binary FBX payload (${content.length.toLocaleString()} bytes).`);
	}
	const version = content.readUInt32LE(magic.length);
	if (version < 7000 || version > 8000) {
		throw new Error(`Blender produced unsupported FBX binary version ${version}.`);
	}
	return version;
}

/** Parses the one bounded evidence marker emitted after Blender finishes writing the FBX file. */
function parseFbxEvidence(stdout: string): Pick<IFbxExportEvidence, "blenderVersion" | "statistics"> {
	const marker = stdout
		.split(/\r?\n/)
		.reverse()
		.find((line) => line.startsWith("ZVIBE_FBX_EXPORT "));
	if (!marker) {
		throw new Error("Blender FBX export did not report its version and object statistics.");
	}
	let value: unknown;
	try {
		value = JSON.parse(marker.slice("ZVIBE_FBX_EXPORT ".length));
	} catch {
		throw new Error("Blender FBX export returned malformed evidence JSON.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Blender FBX export evidence must be an object.");
	}
	const record = value as Record<string, unknown>;
	const statistics = record.statistics;
	if (typeof record.blenderVersion !== "string" || !record.blenderVersion || !statistics || typeof statistics !== "object" || Array.isArray(statistics)) {
		throw new Error("Blender FBX export evidence is missing its version or statistics.");
	}
	const names = ["objectCount", "meshCount", "armatureCount", "cameraCount", "lightCount", "materialCount", "actionCount"] as const;
	const source = statistics as Record<string, unknown>;
	for (const name of names) {
		if (!Number.isSafeInteger(source[name]) || (source[name] as number) < 0 || (source[name] as number) > 10_000_000) {
			throw new Error(`Blender FBX export evidence contains an invalid ${name}.`);
		}
	}
	if ((source.objectCount as number) < 1) {
		throw new Error("Blender FBX export evidence contains no exported objects.");
	}
	return { blenderVersion: record.blenderVersion, statistics: Object.fromEntries(names.map((name) => [name, source[name]])) as unknown as IFbxExportEvidence["statistics"] };
}

/** Converts a real `.blend` file to a bounded GLB using an explicitly configured or installed Blender executable. */
export async function convertBlendFileToGlb(sourcePath: string, options: IBlenderConversionOptions = {}): Promise<IBlenderConversionResult> {
	const source = await stat(sourcePath);
	if (!source.isFile()) {
		throw new Error(`Blender conversion source is not a file: ${sourcePath}`);
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_BLENDER_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60 * 1000) {
		throw new Error("Blender conversion timeoutMs must be an integer from 1,000 through 900,000.");
	}
	const directory = await mkdtemp(join(tmpdir(), "zvibe-blender-"));
	const scriptPath = join(directory, "export_glb.py");
	const outputPath = join(directory, `${basename(sourcePath)}.glb`);
	await writeFile(scriptPath, BLENDER_EXPORT_SCRIPT, { encoding: "utf-8", mode: 0o600 });
	const failures: string[] = [];
	try {
		for (const executable of blenderCandidates(options.executable)) {
			if (!(await executableCanBeAttempted(executable))) {
				failures.push(`${executable}: not executable`);
				continue;
			}
			try {
				const logs = await runBlender(executable, scriptPath, [sourcePath, outputPath], timeoutMs);
				const content = await readFile(outputPath);
				validateGlb(content);
				return { content: new Uint8Array(content), executable, outputBytes: content.length, ...logs };
			} catch (error) {
				failures.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(
			`Modern Blender files require Blender for deterministic GLB conversion. Configure BJS_EDITOR_BLENDER_EXECUTABLE or install Blender, then retry. Attempts: ${failures.join(" | ") || "none"}`
		);
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Converts one bounded GLB into a validated binary FBX without invoking a shell or publishing partial output. */
export async function convertGlbFileToFbx(sourcePath: string, options: IFbxConversionOptions = {}): Promise<IFbxConversionResult> {
	const source = await stat(sourcePath);
	if (!source.isFile() || source.size < 20 || source.size > FBX_EXPORT_MAX_SOURCE_BYTES) {
		throw new Error(`FBX export source must be a GLB file from 20 through ${FBX_EXPORT_MAX_SOURCE_BYTES.toLocaleString()} bytes.`);
	}
	const sourceContent = await readFile(sourcePath);
	validateGlb(sourceContent);
	const settings = normalizeFbxExportSettings(options.settings);
	const timeoutMs = options.timeoutMs ?? DEFAULT_BLENDER_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60 * 1000) {
		throw new Error("Blender conversion timeoutMs must be an integer from 1,000 through 900,000.");
	}
	const directory = await mkdtemp(join(tmpdir(), "zvibe-fbx-export-"));
	const scriptPath = join(directory, "export_fbx.py");
	const settingsPath = join(directory, "settings.json");
	const outputPath = join(directory, `${basename(sourcePath, ".glb")}.fbx`);
	await writeFile(scriptPath, BLENDER_FBX_EXPORT_SCRIPT, { encoding: "utf-8", mode: 0o600 });
	await writeFile(settingsPath, JSON.stringify(settings), { encoding: "utf-8", mode: 0o600 });
	const failures: string[] = [];
	try {
		for (const executable of blenderCandidates(options.executable)) {
			if (!(await executableCanBeAttempted(executable))) {
				failures.push(`${executable}: not executable`);
				continue;
			}
			try {
				const logs = await runBlender(executable, scriptPath, [sourcePath, outputPath, settingsPath], timeoutMs);
				const content = await readFile(outputPath);
				const binaryVersion = validateFbx(content);
				const reported = parseFbxEvidence(logs.stdout);
				const evidence: IFbxExportEvidence = {
					model: FBX_EXPORT_MODEL,
					version: FBX_EXPORT_VERSION,
					generator: "Zvibe Editor Blender FBX Adapter",
					blenderVersion: reported.blenderVersion,
					source: { bytes: sourceContent.byteLength, sha256: createHash("sha256").update(sourceContent).digest("hex") },
					output: { bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"), binaryVersion },
					settings,
					statistics: reported.statistics,
				};
				return { content: new Uint8Array(content), executable, outputBytes: content.length, evidence, ...logs };
			} catch (error) {
				failures.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(
			`FBX export requires Blender with glTF import and FBX export support. Configure BJS_EDITOR_BLENDER_EXECUTABLE or install Blender, then retry. Attempts: ${failures.join(" | ") || "none"}`
		);
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Converts a real `.abc` archive into the bounded portable ZVABC runtime cache used by Web/Desktop players. */
export async function convertAlembicFileToCache(sourcePath: string, options: IAlembicConversionOptions): Promise<IAlembicConversionResult> {
	if (!sourcePath.toLowerCase().endsWith(".abc")) {
		throw new Error("Alembic conversion requires a .abc source file.");
	}
	const source = await stat(sourcePath);
	if (!source.isFile() || source.size < 1 || source.size > ALEMBIC_MAX_SOURCE_BYTES) {
		throw new Error(`Alembic source must be a non-empty file no larger than ${ALEMBIC_MAX_SOURCE_BYTES.toLocaleString()} bytes.`);
	}
	const settings = normalizeAlembicImporterSettings(options.settings);
	const expectedSourceSha256 = await fileSha256(sourcePath);
	const expectedSettingsSha256 = createHash("sha256").update(canonicalJson(settings)).digest("hex");
	const timeoutMs = options.timeoutMs ?? DEFAULT_BLENDER_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60 * 1000) {
		throw new Error("Blender conversion timeoutMs must be an integer from 1,000 through 900,000.");
	}
	const directory = await mkdtemp(join(tmpdir(), "zvibe-alembic-"));
	const scriptPath = join(directory, "export_zvabc.py");
	const settingsPath = join(directory, "settings.json");
	const outputPath = join(directory, `${basename(sourcePath)}.zvabc`);
	await writeFile(scriptPath, BLENDER_ALEMBIC_CACHE_SCRIPT, { encoding: "utf-8", mode: 0o600 });
	await writeFile(settingsPath, JSON.stringify(settings), { encoding: "utf-8", mode: 0o600 });
	const failures: string[] = [];
	try {
		for (const executable of blenderCandidates(options.executable)) {
			if (!(await executableCanBeAttempted(executable))) {
				failures.push(`${executable}: not executable`);
				continue;
			}
			try {
				const logs = await runBlender(executable, scriptPath, [sourcePath, outputPath, settingsPath], timeoutMs);
				let content: Buffer;
				try {
					content = await readFile(outputPath);
				} catch (error) {
					const diagnostics = `${logs.stderr.trim()}\n${logs.stdout.trim()}`.trim().slice(-4096);
					throw new Error(
						`Blender exited without producing the Alembic cache${diagnostics ? `: ${diagnostics}` : `: ${error instanceof Error ? error.message : String(error)}`}`
					);
				}
				if (content.length > ALEMBIC_MAX_CACHE_BYTES) {
					throw new Error(`Blender produced an oversized Alembic cache (${content.length.toLocaleString()} bytes).`);
				}
				const document = parseAlembicCache(new Uint8Array(content));
				if (
					document.manifest.source.name !== basename(sourcePath) ||
					document.manifest.source.bytes !== source.size ||
					document.manifest.source.sha256 !== expectedSourceSha256 ||
					document.manifest.settingsSha256 !== expectedSettingsSha256 ||
					JSON.stringify(document.manifest.settings) !== JSON.stringify(settings)
				) {
					throw new Error("Blender produced Alembic cache evidence that does not match the exact source bytes and normalized importer settings.");
				}
				return { content: new Uint8Array(content), manifest: document.manifest, executable, outputBytes: content.length, ...logs };
			} catch (error) {
				failures.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(
			`Alembic authoring requires Blender with Alembic import support. Configure BJS_EDITOR_BLENDER_EXECUTABLE or install Blender, then retry. Attempts: ${failures.join(" | ") || "none"}`
		);
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}
