#!/usr/bin/env node
/** Positive live lifecycle for all previously uncovered Rigging MCP tools. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	let newline;
	while ((newline = stdout.indexOf("\n")) >= 0) {
		const line = stdout.slice(0, newline).trim();
		stdout = stdout.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function rpc(method, params, timeoutMs = 180_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	if (response.error || result?.isError === true) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	return content ? JSON.parse(content) : result;
}

const required = [
	"set_mesh_skin_weights",
	"optimize_mesh_skin_weights",
	"mirror_mesh_skin_weights",
	"create_humanoid_avatar_mask",
	"set_humanoid_avatar_mask",
	"delete_humanoid_avatar_mask",
	"set_humanoid_muscle_limits",
	"get_humanoid_muscle_pose",
	"set_humanoid_pose_preview",
	"stop_humanoid_pose_preview",
	"get_humanoid_avatar",
	"create_humanoid_avatar",
	"set_humanoid_avatar",
	"validate_humanoid_avatar",
	"retarget_humanoid_animation",
	"inspect_humanoid_retarget",
	"set_humanoid_retarget_debug_visualization",
	"delete_humanoid_avatar",
	"set_animation_rig_profile",
	"clear_animation_rig_profile",
	"inspect_rig_to_skeleton_bake",
	"bake_rig_to_skeleton_animation",
	"inspect_rig_to_constraint_bake",
	"bake_rig_to_constraint_animation",
	"inspect_two_bone_ik_constraint_bake",
	"bake_two_bone_ik_constraint_animation",
	"create_rig_layer",
	"set_rig_layer",
	"delete_rig_layer",
	"create_rig_constraint",
	"set_rig_constraint",
	"delete_rig_constraint",
	"get_rig_constraint_graph",
	"set_rig_constraint_graph_layout",
	"bake_sprite_ik_animation",
	"create_sprite_ik_rig",
	"create_sprite_ik_controller",
	"set_sprite_ik_controller",
	"delete_sprite_ik_controller",
	"create_look_at_constraint",
	"set_look_at_constraint",
	"delete_look_at_constraint",
	"get_skeleton_bones",
	"create_ik_controller",
	"set_ik_controller",
	"delete_ik_controller",
];
const suffix = `${Date.now()}-${process.pid}`;
const sourceAvatarId = `mcp-source-avatar-${suffix}`;
const targetAvatarId = `mcp-target-avatar-${suffix}`;
const maskId = `mcp-avatar-mask-${suffix}`;
const layerId = `mcp-rig-layer-${suffix}`;
const constraintId = `mcp-rig-constraint-${suffix}`;
const ikId = `mcp-ik-${suffix}`;
const lookId = `mcp-look-${suffix}`;
const spriteId = `mcp-sprite-ik-${suffix}`;
const spriteManualId = `mcp-sprite-manual-${suffix}`;
const sourceGroup = `MCP Humanoid Source ${suffix}`;
const rigSourceGroup = `MCP Rig Source ${suffix}`;
const constraintSourceGroup = `MCP Constraint Source ${suffix}`;
const ikSourceGroup = `MCP IK Source ${suffix}`;
const retargetOutput = `MCP Retarget Output ${suffix}`;
const rigBakeOutput = `MCP Rig Bake ${suffix}`;
const constraintBakeOutput = `MCP Constraint Bake ${suffix}`;
const ikBakeOutput = `MCP IK Bake ${suffix}`;
const spriteBakeOutput = `MCP Sprite IK Bake ${suffix}`;
const setupScriptName = `rigging-completion-setup-${suffix}.js`;
const cleanupScriptName = `rigging-completion-cleanup-${suffix}.js`;
const animationNames = [sourceGroup, rigSourceGroup, constraintSourceGroup, ikSourceGroup, retargetOutput, rigBakeOutput, constraintBakeOutput, ikBakeOutput, spriteBakeOutput];
let fixture;
let spriteRig;

async function cleanup() {
	await call("set_humanoid_retarget_debug_visualization", { enabled: false }).catch(() => undefined);
	await call("stop_humanoid_pose_preview", { avatarId: sourceAvatarId }).catch(() => undefined);
	for (const id of [spriteManualId, spriteId]) await call("delete_sprite_ik_controller", { id }).catch(() => undefined);
	await call("delete_look_at_constraint", { id: lookId }).catch(() => undefined);
	await call("delete_ik_controller", { id: ikId }).catch(() => undefined);
	await call("delete_rig_constraint", { layerId, constraintId }).catch(() => undefined);
	await call("delete_rig_layer", { layerId }).catch(() => undefined);
	await call("delete_humanoid_avatar_mask", { maskId, force: true }).catch(() => undefined);
	for (const avatarId of [sourceAvatarId, targetAvatarId]) await call("delete_humanoid_avatar", { avatarId }).catch(() => undefined);
	for (const name of animationNames) await call("delete_animation_group", { name }).catch(() => undefined);
	if (fixture || spriteRig) {
		const cleanupSource = `
export function main(editor) {
	const scene = editor.layout.preview.scene;
	for (const node of [...scene.meshes, ...scene.transformNodes]) if (node.name.includes(${JSON.stringify(suffix)})) node.dispose(false, true);
	for (const skeleton of [...scene.skeletons]) if (skeleton.name.includes(${JSON.stringify(suffix)})) skeleton.dispose();
	for (const group of [...scene.animationGroups]) if (group.name.includes(${JSON.stringify(suffix)})) group.dispose();
	return "rigging resources disposed";
}`;
		await call("run_agent_script", { name: cleanupScriptName, content: cleanupSource }).catch(() => undefined);
	}
	for (const assetPath of [
		`agentdata/${setupScriptName}`,
		`agentdata/${cleanupScriptName}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs.map")}`,
		`.bjseditor/agent-scripts/${cleanupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${cleanupScriptName.replace(/\.js$/, ".cjs.map")}`,
	]) {
		await call("delete_asset", { path: assetPath, confirm: true }).catch(() => undefined);
	}
	await call("set_animation_rig_profile", { enabled: false }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rigging-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Rigging completion testing.");

	const setupSource = `
import { Animation, AnimationGroup, Bone, Matrix, Mesh, MeshBuilder, Quaternion, Skeleton, TransformNode, Vector3, VertexData } from "babylonjs";
function matrix(x, y, z) { return Matrix.Compose(Vector3.One(), Quaternion.Identity(), new Vector3(x, y, z)); }
function makeSkeleton(scene, prefix, scale) {
	const skeleton = new Skeleton(prefix + " Skeleton ${suffix}", prefix.toLowerCase() + "-skeleton-${suffix}", scene);
	const hips = new Bone(prefix + "Hips", skeleton, null, matrix(0, 0, 0), matrix(0, 0, 0));
	const spine = new Bone(prefix + "Spine", skeleton, hips, matrix(0, scale, 0), matrix(0, scale, 0));
	new Bone(prefix + "Head", skeleton, spine, matrix(0, scale, 0), matrix(0, scale, 0));
	const lua = new Bone(prefix + "LeftUpperArm", skeleton, spine, matrix(scale, 0, 0), matrix(scale, 0, 0));
	const lla = new Bone(prefix + "LeftLowerArm", skeleton, lua, matrix(scale, 0, 0), matrix(scale, 0, 0));
	new Bone(prefix + "LeftHand", skeleton, lla, matrix(scale, 0, 0), matrix(scale, 0, 0));
	const rua = new Bone(prefix + "RightUpperArm", skeleton, spine, matrix(-scale, 0, 0), matrix(-scale, 0, 0));
	const rla = new Bone(prefix + "RightLowerArm", skeleton, rua, matrix(-scale, 0, 0), matrix(-scale, 0, 0));
	new Bone(prefix + "RightHand", skeleton, rla, matrix(-scale, 0, 0), matrix(-scale, 0, 0));
	const lul = new Bone(prefix + "LeftUpperLeg", skeleton, hips, matrix(scale * 0.25, -scale, 0), matrix(scale * 0.25, -scale, 0));
	const lll = new Bone(prefix + "LeftLowerLeg", skeleton, lul, matrix(0, -scale, 0), matrix(0, -scale, 0));
	new Bone(prefix + "LeftFoot", skeleton, lll, matrix(0, -scale, scale * 0.25), matrix(0, -scale, scale * 0.25));
	const rul = new Bone(prefix + "RightUpperLeg", skeleton, hips, matrix(-scale * 0.25, -scale, 0), matrix(-scale * 0.25, -scale, 0));
	const rll = new Bone(prefix + "RightLowerLeg", skeleton, rul, matrix(0, -scale, 0), matrix(0, -scale, 0));
	new Bone(prefix + "RightFoot", skeleton, rll, matrix(0, -scale, scale * 0.25), matrix(0, -scale, scale * 0.25));
	lua.length = scale; lla.length = scale;
	return skeleton;
}
function addAnimation(group, name, property, type, target, first, last) {
	const animation = new Animation(name, property, 30, type, Animation.ANIMATIONLOOPMODE_CONSTANT);
	animation.setKeys([{ frame: 0, value: first }, { frame: 30, value: last }]);
	group.addTargetedAnimation(animation, target);
}
export function main(editor) {
	const scene = editor.layout.preview.scene;
	const sourceSkeleton = makeSkeleton(scene, "Source", 100);
	const targetSkeleton = makeSkeleton(scene, "Target", 120);
	const sourceMesh = new Mesh("MCP Source Skinned Mesh ${suffix}", scene);
	const data = new VertexData();
	data.positions = [-50,0,0, 50,0,0, -50,100,0, 50,100,0];
	data.indices = [0,1,2, 1,3,2];
	data.normals = [0,0,1, 0,0,1, 0,0,1, 0,0,1];
	data.matricesIndices = new Array(16).fill(0);
	data.matricesWeights = [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0];
	data.applyToMesh(sourceMesh, true);
	sourceMesh.skeleton = sourceSkeleton;
	sourceMesh.numBoneInfluencers = 4;
	sourceMesh.position.copyFromFloats(0, 0, 0);
	const targetMesh = MeshBuilder.CreateBox("MCP Target Skinned Mesh ${suffix}", { size: 100 }, scene);
	targetMesh.skeleton = targetSkeleton;
	targetMesh.position.copyFromFloats(-250, 100, 0);
	const ikSkeleton = new Skeleton("MCP IK Skeleton ${suffix}", "ik-skeleton-${suffix}", scene);
	const ikUpper = new Bone("IKUpper", ikSkeleton, null, Matrix.Identity(), Matrix.Identity());
	const ikLower = new Bone("IKLower", ikSkeleton, ikUpper, matrix(0, 100, 0), matrix(0, 100, 0));
	new Bone("IKHand", ikSkeleton, ikLower, matrix(0, 100, 0), matrix(0, 100, 0));
	ikUpper.length = 100; ikLower.length = 100;
	const ikMesh = MeshBuilder.CreateBox("MCP IK Mesh ${suffix}", { size: 20 }, scene);
	ikMesh.skeleton = ikSkeleton;
	const control = new TransformNode("MCP Rig Control ${suffix}", scene);
	control.position.copyFromFloats(0, 100, 0);
	const ikTarget = new TransformNode("MCP IK Target ${suffix}", scene);
	ikTarget.position.copyFromFloats(100, 150, 0);
	const pole = new TransformNode("MCP IK Pole ${suffix}", scene);
	pole.position.copyFromFloats(0, 100, 150);
	const lookTarget = new TransformNode("MCP Look Target ${suffix}", scene);
	lookTarget.position.copyFromFloats(0, 300, 300);
	const source = new AnimationGroup(${JSON.stringify(sourceGroup)}, scene);
	addAnimation(source, "Hips Motion", "position", Animation.ANIMATIONTYPE_VECTOR3, sourceSkeleton.bones.find(b => b.name === "SourceHips"), Vector3.Zero(), new Vector3(20,0,0));
	addAnimation(source, "Arm Motion", "rotationQuaternion", Animation.ANIMATIONTYPE_QUATERNION, sourceSkeleton.bones.find(b => b.name === "SourceLeftUpperArm"), Quaternion.Identity(), Quaternion.RotationAxis(Vector3.Up(), 0.25));
	const rigSource = new AnimationGroup(${JSON.stringify(rigSourceGroup)}, scene);
	addAnimation(rigSource, "Control Motion", "position", Animation.ANIMATIONTYPE_VECTOR3, control, new Vector3(0,100,0), new Vector3(30,120,0));
	const constraintSource = new AnimationGroup(${JSON.stringify(constraintSourceGroup)}, scene);
	addAnimation(constraintSource, "Driven Hips", "position", Animation.ANIMATIONTYPE_VECTOR3, sourceSkeleton.bones.find(b => b.name === "SourceHips"), Vector3.Zero(), new Vector3(25,10,0));
	const ikSource = new AnimationGroup(${JSON.stringify(ikSourceGroup)}, scene);
	addAnimation(ikSource, "Upper Arm FK", "rotationQuaternion", Animation.ANIMATIONTYPE_QUATERNION, sourceSkeleton.bones.find(b => b.name === "SourceLeftUpperArm"), Quaternion.Identity(), Quaternion.RotationAxis(Vector3.Forward(), 0.2));
	addAnimation(ikSource, "Lower Arm FK", "rotationQuaternion", Animation.ANIMATIONTYPE_QUATERNION, sourceSkeleton.bones.find(b => b.name === "SourceLeftLowerArm"), Quaternion.Identity(), Quaternion.RotationAxis(Vector3.Forward(), -0.35));
	return JSON.stringify({ sourceSkeletonId: sourceSkeleton.id, targetSkeletonId: targetSkeleton.id, ikSkeletonId: ikSkeleton.id, sourceMeshId: sourceMesh.id, targetMeshId: targetMesh.id, ikMeshId: ikMesh.id, controlId: control.id, ikTargetId: ikTarget.id, poleId: pole.id, lookTargetId: lookTarget.id });
}`;
	const setup = await call("run_agent_script", { name: setupScriptName, content: setupSource });
	fixture = JSON.parse(setup.result);

	let weights = await call("get_mesh_skin_weights", { nodeId: fixture.sourceMeshId, limit: 8 });
	weights = await call("set_mesh_skin_weights", {
		nodeId: fixture.sourceMeshId,
		expectedFingerprint: weights.fingerprint,
		vertices: [
			{
				vertexIndex: 0,
				influences: [
					{ boneName: "SourceLeftUpperArm", weight: 0.75 },
					{ boneName: "SourceHips", weight: 0.25 },
				],
			},
		],
		maxInfluences: 4,
	});
	weights = await call("optimize_mesh_skin_weights", { nodeId: fixture.sourceMeshId, expectedFingerprint: weights.fingerprint, maxInfluences: 4, minimumWeight: 0.001 });
	await call("mirror_mesh_skin_weights", {
		nodeId: fixture.sourceMeshId,
		expectedFingerprint: weights.fingerprint,
		axis: "x",
		direction: "negativeToPositive",
		tolerance: 0.001,
	});

	const sourceAvatar = await call("create_humanoid_avatar", { id: sourceAvatarId, name: `MCP Source Avatar ${suffix}`, skeletonId: fixture.sourceSkeletonId, autoMap: true });
	const targetAvatar = await call("create_humanoid_avatar", { id: targetAvatarId, name: `MCP Target Avatar ${suffix}`, skeletonId: fixture.targetSkeletonId, autoMap: true });
	if (!sourceAvatar.validation?.valid || !targetAvatar.validation?.valid) throw new Error("Humanoid auto-mapping did not create valid source and target Avatars.");
	await call("get_humanoid_avatar", { avatarId: sourceAvatarId });
	await call("set_humanoid_avatar", { avatarId: sourceAvatarId, name: `MCP Source Avatar Updated ${suffix}`, autoMap: true, refreshRestPose: true });
	const validation = await call("validate_humanoid_avatar", { avatarId: sourceAvatarId });
	if (!validation.valid) throw new Error("Humanoid Avatar validation failed.");
	await call("set_humanoid_muscle_limits", { avatarId: sourceAvatarId, enabled: true, limits: { leftUpperArm: { min: [-45, -30, -20], max: [45, 30, 20] } } });
	await call("set_humanoid_pose_preview", { avatarId: sourceAvatarId, preset: "muscles", pose: { leftUpperArm: [0.25, -0.25, 0.1] }, replace: true });
	const pose = await call("get_humanoid_muscle_pose", { avatarId: sourceAvatarId });
	if (!pose.muscles?.length) throw new Error("Humanoid muscle pose evidence is missing.");
	await call("stop_humanoid_pose_preview", { avatarId: sourceAvatarId });
	const mask = await call("create_humanoid_avatar_mask", {
		id: maskId,
		name: `MCP Upper Body ${suffix}`,
		avatarId: sourceAvatarId,
		bodyParts: { body: true, head: true, leftArm: true, rightArm: true },
	});
	await call("set_humanoid_avatar_mask", { maskId: mask.id, name: `MCP Upper Body Updated ${suffix}`, bodyParts: { leftHand: true }, transformNames: ["SourceSpine"] });
	await call("delete_humanoid_avatar_mask", { maskId: mask.id });

	const retargetPlan = await call("inspect_humanoid_retarget", { sourceAvatarId, targetAvatarId, animationGroupName: sourceGroup, includeRootTranslation: true });
	if (!retargetPlan.canBake) throw new Error(`Humanoid retarget inspection blocked: ${JSON.stringify(retargetPlan.errors)}`);
	await call("retarget_humanoid_animation", { sourceAvatarId, targetAvatarId, animationGroupName: sourceGroup, outputName: retargetOutput, includeRootTranslation: true });
	await call("set_humanoid_retarget_debug_visualization", { enabled: true, sourceAvatarId, targetAvatarId, showAxes: true });
	await call("set_humanoid_retarget_debug_visualization", { enabled: false });

	await call("set_animation_rig_profile", { enabled: true, sampleCapacity: 16, sampleEveryNEvaluations: 1 });
	await call("clear_animation_rig_profile");
	const layer = await call("create_rig_layer", { id: layerId, name: `MCP Rig Layer ${suffix}`, skeletonId: fixture.sourceSkeletonId, order: 5, weight: 1, enabled: true });
	await call("set_rig_layer", { layerId: layer.id, name: `MCP Rig Layer Updated ${suffix}`, order: 4, weight: 1, enabled: true });
	const constraint = await call("create_rig_constraint", {
		layerId: layer.id,
		id: constraintId,
		name: `MCP Multi Position ${suffix}`,
		type: "multiPosition",
		boneName: "SourceHips",
		sources: [{ nodeId: fixture.controlId, weight: 1 }],
		maintainOffset: false,
	});
	await call("set_rig_constraint", { layerId: layer.id, constraintId: constraint.id, weight: 1, enabled: true, maintainOffset: false });
	let graph = await call("get_rig_constraint_graph", { layerId: layer.id });
	await call("set_rig_constraint_graph_layout", { layerId: layer.id, expectedFingerprint: graph.fingerprint, autoLayout: true });

	const rigPlan = await call("inspect_rig_to_skeleton_bake", {
		skeletonId: fixture.sourceSkeletonId,
		sourceAnimationGroupName: rigSourceGroup,
		layerIds: [layer.id],
		sampleRate: 10,
	});
	if (!rigPlan.canBake) throw new Error(`Rig-to-skeleton inspection blocked: ${JSON.stringify(rigPlan.errors)}`);
	await call("bake_rig_to_skeleton_animation", {
		skeletonId: fixture.sourceSkeletonId,
		sourceAnimationGroupName: rigSourceGroup,
		layerIds: [layer.id],
		sampleRate: 10,
		outputName: rigBakeOutput,
		expectedFingerprint: rigPlan.fingerprint,
	});
	const constraintRequest = {
		skeletonId: fixture.sourceSkeletonId,
		sourceAnimationGroupName: constraintSourceGroup,
		layerIds: [layer.id],
		constraintRefs: [{ layerId: layer.id, constraintId: constraint.id }],
		sampleRate: 10,
	};
	const constraintPlan = await call("inspect_rig_to_constraint_bake", constraintRequest);
	if (!constraintPlan.canBake) throw new Error(`Rig-to-constraint inspection blocked: ${JSON.stringify(constraintPlan.errors)}`);
	await call("bake_rig_to_constraint_animation", { ...constraintRequest, outputName: constraintBakeOutput, expectedFingerprint: constraintPlan.fingerprint });

	const bones = await call("get_skeleton_bones", { skeletonId: fixture.sourceSkeletonId });
	if (!bones.bones?.some((bone) => bone.name === "SourceLeftLowerArm")) throw new Error("Skeleton bone hierarchy evidence is incomplete.");
	await call("create_ik_controller", {
		id: ikId,
		skeletonId: fixture.ikSkeletonId,
		boneName: "IKLower",
		meshId: fixture.ikMeshId,
		targetNodeId: fixture.ikTargetId,
		poleTargetNodeId: fixture.poleId,
		maxAngle: Math.PI,
		slerpAmount: 1,
		targetPositionWeight: 1,
		targetRotationWeight: 0,
		hintWeight: 1,
		enabled: true,
	});
	await call("set_ik_controller", { id: ikId, poleAngle: 0.1, hintWeight: 1, targetPositionWeight: 1, targetRotationWeight: 0, enabled: true });
	await call("delete_animation_group", { name: ikSourceGroup });
	const ikSourceSetup = `
import { Animation, AnimationGroup, Quaternion, Space, Vector3 } from "babylonjs";
export function main(editor) {
	const scene = editor.layout.preview.scene;
	const skeleton = scene.skeletons.find(candidate => candidate.id === ${JSON.stringify(fixture.ikSkeletonId)});
	const root = skeleton.bones.find(bone => bone.name === "IKUpper");
	const mid = skeleton.bones.find(bone => bone.name === "IKLower");
	const firstRoot = root.getRotationQuaternion(Space.LOCAL).clone();
	const firstMid = mid.getRotationQuaternion(Space.LOCAL).clone();
	const lastRoot = firstRoot.clone();
	const lastMid = firstMid.clone();
	root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
	mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
	const group = new AnimationGroup(${JSON.stringify(ikSourceGroup)}, scene);
	const rootAnimation = new Animation("Upper Arm FK", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
	rootAnimation.setKeys([{ frame: 0, value: firstRoot }, { frame: 30, value: lastRoot }]);
	group.addTargetedAnimation(rootAnimation, root);
	const midAnimation = new Animation("Lower Arm FK", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
	midAnimation.setKeys([{ frame: 0, value: firstMid }, { frame: 30, value: lastMid }]);
	group.addTargetedAnimation(midAnimation, mid);
	return "IK source captured from live native solver";
}`;
	await call("run_agent_script", { name: setupScriptName, content: ikSourceSetup });
	const ikRequest = { skeletonId: fixture.ikSkeletonId, sourceAnimationGroupName: ikSourceGroup, ikControllerIds: [ikId], sampleRate: 10 };
	const ikPlan = await call("inspect_two_bone_ik_constraint_bake", ikRequest);
	if (!ikPlan.canBake) throw new Error(`Two-Bone IK inspection blocked: ${JSON.stringify(ikPlan.errors)}`);
	await call("bake_two_bone_ik_constraint_animation", { ...ikRequest, outputName: ikBakeOutput, expectedFingerprint: ikPlan.fingerprint });
	await call("create_look_at_constraint", {
		id: lookId,
		skeletonId: fixture.sourceSkeletonId,
		boneName: "SourceHead",
		meshId: fixture.sourceMeshId,
		targetNodeId: fixture.lookTargetId,
		minYaw: -1,
		maxYaw: 1,
		minPitch: -0.5,
		maxPitch: 0.5,
		slerpAmount: 0.5,
		enabled: true,
	});
	await call("set_look_at_constraint", { id: lookId, slerpAmount: 0.75, adjustYaw: 0.1, enabled: true });
	await call("delete_look_at_constraint", { id: lookId });
	await call("delete_ik_controller", { id: ikId });

	spriteRig = await call("create_sprite_ik_rig", {
		id: spriteId,
		name: `MCP Sprite Rig ${suffix}`,
		firstLength: 100,
		secondLength: 80,
		position: [300, 100, 0],
		targetPosition: [430, 160, 0],
		bendDirection: "counterClockwise",
		enabled: true,
	});
	await call("set_sprite_ik_controller", { id: spriteId, bendDirection: "clockwise", enabled: true });
	await call("bake_sprite_ik_animation", {
		id: spriteId,
		name: spriteBakeOutput,
		framesPerSecond: 30,
		poses: [
			{ frame: 0, targetPosition: [430, 160, 0] },
			{ frame: 30, targetPosition: [400, 200, 0] },
		],
	});
	await call("delete_sprite_ik_controller", { id: spriteId });
	await call("create_sprite_ik_controller", {
		id: spriteManualId,
		rootNodeId: spriteRig.rootNodeId,
		jointNodeId: spriteRig.jointNodeId,
		tipNodeId: spriteRig.tipNodeId,
		targetNodeId: spriteRig.targetNodeId,
		bendDirection: "counterClockwise",
		enabled: true,
	});
	await call("set_sprite_ik_controller", { id: spriteManualId, bendDirection: "clockwise", enabled: false });
	await call("delete_sprite_ik_controller", { id: spriteManualId });

	await call("delete_rig_constraint", { layerId: layer.id, constraintId: constraint.id });
	await call("delete_rig_layer", { layerId: layer.id });
	await call("delete_humanoid_avatar", { avatarId: sourceAvatarId });
	await call("delete_humanoid_avatar", { avatarId: targetAvatarId });
	await cleanup();
	console.log(
		`[rigging-completion-live] PASS — ${required.length}/${required.length} previously uncovered tools, Humanoid/skin/rig/IK/Sprite IK baking, graph layout, and MCP-only cleanup verified.`
	);
} catch (error) {
	await cleanup().catch(() => undefined);
	console.error(`[rigging-completion-live] FAIL — ${error.stack ?? error.message}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}
