import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { IoAddSharp, IoCloseOutline } from "react-icons/io5";
import { FaArrowAltCircleRight, FaCopy } from "react-icons/fa";

import { Mesh, Skeleton } from "babylonjs";
import { HUMAN_BONE_DEFINITIONS, HUMANOID_BODY_PARTS } from "babylonjs-editor-tools";

import { showPrompt } from "../../../../ui/dialog";
import { Button } from "../../../../ui/shadcn/ui/button";

import { isSkeleton } from "../../../../tools/guards/nodes";
import { onSkeletonModifiedObservable } from "../../../../tools/observables";
import {
	createIKController,
	createLookAtConstraint,
	deleteIKController,
	deleteLookAtConstraint,
	listIKControllers,
	listLookAtConstraints,
	setIKController,
	setLookAtConstraint,
} from "../../../../mcp/rigging/ik";
import {
	createHumanoidAvatar,
	getHumanoidMusclePose,
	inspectHumanoidRetarget,
	listHumanoidAvatars,
	retargetHumanoidAnimation,
	setHumanoidAvatar,
	setHumanoidMuscleLimits,
	setHumanoidPosePreview,
	setHumanoidRetargetDebugVisualization,
	stopHumanoidPosePreview,
} from "../../../../mcp/rigging/humanoid-avatar";
import { createHumanoidAvatarMask, deleteHumanoidAvatarMask, listHumanoidAvatarMasks, setHumanoidAvatarMask } from "../../../../mcp/rigging/avatar-masks";
import { createRigConstraint, createRigLayer, deleteRigConstraint, deleteRigLayer, listRigLayers, setRigConstraint, setRigLayer } from "../../../../mcp/rigging/rig-layers";
import {
	captureMeshSkinWeightSnapshot,
	getMeshSkinWeights,
	mirrorMeshSkinWeights,
	optimizeMeshSkinWeights,
	paintMeshSkinWeights,
	restoreMeshSkinWeightSnapshot,
} from "../../../../mcp/rigging/skin-weights";
import { registerUndoRedo } from "../../../../tools/undoredo";

import { IEditorInspectorImplementationProps } from "../inspector";

import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorSectionField } from "../fields/section";
import { EditorRigConstraintGraph } from "./rig-constraint-graph";

interface IEditorSkeletonInspectorState {
	ikBoneName: string;
	ikMeshId: string;
	ikTargetNodeId: string;
	ikPoleTargetNodeId: string;
	lookAtBoneName: string;
	lookAtMeshId: string;
	lookAtTargetNodeId: string;
	muscleRole: string;
	retargetSourceAvatarId: string;
	retargetAnimationGroupName: string;
	retargetIncludeRootTranslation: boolean;
	retargetIncludeScale: boolean;
	retargetShowAxes: boolean;
	rigBoneName: string;
	rigSourceNodeId: string;
	rigSecondarySourceNodeId: string;
	rigTwistBoneNames: string;
	rigChainRootBoneName: string;
	rigChainTipBoneName: string;
	skinWeightMeshId: string;
	skinWeightBoneName: string;
	skinWeightValue: number;
	skinWeightMaximumInfluences: number;
	skinWeightMinimumWeight: number;
}

export class EditorSkeletonInspector extends Component<IEditorInspectorImplementationProps<Skeleton>, IEditorSkeletonInspectorState> {
	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: any): boolean {
		return isSkeleton(object);
	}

	public constructor(props: IEditorInspectorImplementationProps<Skeleton>) {
		super(props);
		this.state = {
			ikBoneName: "",
			ikMeshId: "",
			ikTargetNodeId: "",
			ikPoleTargetNodeId: "",
			lookAtBoneName: "",
			lookAtMeshId: "",
			lookAtTargetNodeId: "",
			muscleRole: "",
			retargetSourceAvatarId: "",
			retargetAnimationGroupName: "",
			retargetIncludeRootTranslation: true,
			retargetIncludeScale: false,
			retargetShowAxes: false,
			rigBoneName: "",
			rigSourceNodeId: "",
			rigSecondarySourceNodeId: "",
			rigTwistBoneNames: "",
			rigChainRootBoneName: "",
			rigChainTipBoneName: "",
			skinWeightMeshId: "",
			skinWeightBoneName: "",
			skinWeightValue: 1,
			skinWeightMaximumInfluences: 4,
			skinWeightMinimumWeight: 0.001,
		};
	}

	public render(): ReactNode {
		const scene = this.props.object.getScene();
		const ikControllers = listIKControllers(scene).controllers.filter((controller: any) => controller.skeletonId === this.props.object.id) as any[];
		const lookAtConstraints = listLookAtConstraints(scene).constraints.filter((constraint: any) => constraint.skeletonId === this.props.object.id) as any[];
		const rigLayers = listRigLayers(scene, { skeletonId: this.props.object.id }).layers as any[];
		const humanoidAvatars = listHumanoidAvatars(scene).avatars as any[];
		const avatar = humanoidAvatars.find((candidate: any) => candidate.skeletonId === this.props.object.id) as any;
		const avatarMasks = avatar ? (listHumanoidAvatarMasks(scene).masks.filter((mask: any) => mask.avatarId === avatar.id) as any[]) : [];
		const boundMeshes = scene.meshes.filter((mesh) => mesh.skeleton === this.props.object);
		const targetNodes = [...scene.transformNodes, ...scene.meshes].filter(
			(node, index, nodes) => node.id && nodes.findIndex((candidate) => candidate.id === node.id) === index
		);
		const ikBones = this.props.object.bones.filter((bone) => !!bone.getParent() && (bone.length > 0 || bone.children.length > 0));
		return (
			<>
				<EditorInspectorSectionField title="Skeleton">
					<EditorInspectorStringField
						label="Name"
						object={this.props.object}
						property="name"
						onChange={() => onSkeletonModifiedObservable.notifyObservers(this.props.object)}
					/>
					<EditorInspectorSwitchField label="Need Initial Skin Matrix" object={this.props.object} property="needInitialSkinMatrix" />
				</EditorInspectorSectionField>

				{boundMeshes.length > 0 && this._renderSkinWeightAuthoring(boundMeshes as Mesh[])}

				<EditorInspectorSectionField
					title="Rig / Avatar"
					tooltip="Unity-style Generic/Humanoid rig definition. Automatic and manual canonical bone mapping is persisted with the scene and used for animation retargeting."
				>
					{!avatar ? (
						<Button variant="secondary" className="w-full" onClick={() => this._createHumanoidAvatar()}>
							Create Humanoid Avatar
						</Button>
					) : (
						<div className="flex flex-col gap-2">
							<div className="grid grid-cols-[1fr_150px] items-center gap-2 text-xs">
								<span>Animation Type</span>
								<select
									className="h-8 rounded-md border border-input bg-background px-2"
									value={avatar.animationType}
									onChange={(event) => this._setHumanoidAvatar(avatar.id, { animationType: event.target.value })}
								>
									<option value="none">None</option>
									<option value="generic">Generic</option>
									<option value="humanoid">Humanoid</option>
								</select>
							</div>
							<div className={avatar.validation.valid ? "text-xs text-emerald-400" : "text-xs text-red-400"}>
								{avatar.validation.valid ? "Avatar valid" : "Avatar invalid"} · {avatar.validation.requiredMappedBoneCount}/{avatar.validation.requiredBoneCount}{" "}
								required · {avatar.validation.mappedBoneCount} total mapped · T-pose {avatar.validation.tPose.status}
							</div>
							<div className="flex gap-2">
								<Button size="sm" variant="outline" className="flex-1" onClick={() => this._setHumanoidAvatar(avatar.id, { autoMap: true })}>
									Auto Map
								</Button>
								<Button size="sm" variant="outline" className="flex-1" onClick={() => this._setHumanoidAvatar(avatar.id, { refreshRestPose: true })}>
									Capture Rest Pose
								</Button>
							</div>
							<div className="max-h-80 overflow-y-auto rounded-md border border-border p-2">
								{HUMAN_BONE_DEFINITIONS.map((definition) => (
									<label key={definition.role} className="grid grid-cols-[1fr_160px] items-center gap-2 py-1 text-xs" title={definition.role}>
										<span className={definition.required ? "font-medium" : "text-muted-foreground"}>
											{definition.label}
											{definition.required ? " *" : ""}
										</span>
										<select
											className="h-7 rounded-md border border-input bg-background px-1"
											value={avatar.mapping[definition.role] ?? ""}
											onChange={(event) => this._setHumanoidAvatar(avatar.id, { mapping: { [definition.role]: event.target.value || null } })}
										>
											<option value="">Not mapped</option>
											{this.props.object.bones.map((bone) => (
												<option key={bone.name} value={bone.name}>
													{bone.name}
												</option>
											))}
										</select>
									</label>
								))}
							</div>
							<div className="space-y-2 border-t border-border pt-2">
								<div className="flex items-center justify-between">
									<div>
										<div className="text-xs font-medium">Muscle Limits</div>
										<div className="text-xs text-muted-foreground">Clamp mapped local bone rotation deltas after animation evaluation.</div>
									</div>
									<label className="text-xs">
										<input
											type="checkbox"
											checked={avatar.muscleLimitsEnabled === true}
											onChange={(event) => this._setHumanoidMuscleLimits(avatar.id, { enabled: event.target.checked })}
										/>{" "}
										Enabled
									</label>
								</div>
								{this._renderMuscleLimitEditor(avatar)}
							</div>
							{avatar.animationType === "humanoid" && this._renderRetargetDebugger(avatar, humanoidAvatars)}
							<div className="space-y-2 border-t border-border pt-2">
								<div className="flex items-center justify-between">
									<div>
										<div className="text-xs font-medium">Avatar Masks</div>
										<div className="text-xs text-muted-foreground">Reusable humanoid body-part masks for Animator states and layers.</div>
									</div>
									<Button size="sm" variant="secondary" onClick={() => this._createAvatarMask(avatar.id)}>
										Add Mask
									</Button>
								</div>
								{avatarMasks.map((mask) => (
									<div key={mask.id} className="space-y-1 rounded-md border border-border p-2">
										<div className="flex items-center gap-2">
											<span className="min-w-0 flex-1 truncate text-xs font-medium">
												{mask.name} · {mask.targetCount} target(s)
											</span>
											<Button size="sm" variant="ghost" onClick={() => this._deleteAvatarMask(mask.id)}>
												Remove
											</Button>
										</div>
										<div className="grid grid-cols-3 gap-1">
											{HUMANOID_BODY_PARTS.map((part) => (
												<label key={part} className="text-xs">
													<input
														type="checkbox"
														checked={mask.bodyParts[part] === true}
														onChange={(event) => this._setAvatarMask(mask.id, { bodyParts: { [part]: event.target.checked } })}
													/>{" "}
													{part}
												</label>
											))}
										</div>
									</div>
								))}
								{avatarMasks.length === 0 && <div className="text-xs text-muted-foreground">No reusable Avatar Masks for this skeleton.</div>}
							</div>
							{avatar.validation.errors.map((message: string) => (
								<div key={message} className="text-xs text-red-400 break-all">
									{message}
								</div>
							))}
							{avatar.validation.warnings.map((message: string) => (
								<div key={message} className="text-xs text-amber-300 break-all">
									{message}
								</div>
							))}
						</div>
					)}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField
					title="Rig Constraints"
					tooltip="Persisted IK and look-at constraints. Create new constraints with the rigging MCP tools, then manage their lifecycle here."
				>
					{this._renderRigLayers(rigLayers, targetNodes)}
					{boundMeshes.length > 0 && ikBones.length > 0 && targetNodes.length > 0 && (
						<div className="grid grid-cols-4 gap-2">
							<select
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={this.state.ikMeshId || boundMeshes[0].id}
								onChange={(event) => this.setState({ ikMeshId: event.target.value })}
							>
								{boundMeshes.map((mesh) => (
									<option key={mesh.id} value={mesh.id}>
										{mesh.name}
									</option>
								))}
							</select>
							<select
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={this.state.ikPoleTargetNodeId}
								onChange={(event) => this.setState({ ikPoleTargetNodeId: event.target.value })}
							>
								<option value="">No pole target</option>
								{targetNodes.map((node) => (
									<option key={node.id} value={node.id}>
										{node.name}
									</option>
								))}
							</select>
							<select
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={this.state.ikBoneName || ikBones[0].name}
								onChange={(event) => this.setState({ ikBoneName: event.target.value })}
							>
								{ikBones.map((bone) => (
									<option key={bone.name} value={bone.name}>
										{bone.name}
									</option>
								))}
							</select>
							<select
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={this.state.ikTargetNodeId || targetNodes[0].id}
								onChange={(event) => this.setState({ ikTargetNodeId: event.target.value })}
							>
								{targetNodes.map((node) => (
									<option key={node.id} value={node.id}>
										{node.name}
									</option>
								))}
							</select>
							<Button
								size="sm"
								variant="secondary"
								className="col-span-4"
								onClick={() => this._createIKController(boundMeshes[0].id, ikBones[0].name, targetNodes[0].id)}
							>
								Add Two-Bone IK
							</Button>
						</div>
					)}
					{boundMeshes.length > 0 && this.props.object.bones.length > 0 && targetNodes.length > 0 && (
						<div className="grid grid-cols-3 gap-2">
							<select
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={this.state.lookAtMeshId || boundMeshes[0].id}
								onChange={(event) => this.setState({ lookAtMeshId: event.target.value })}
							>
								{boundMeshes.map((mesh) => (
									<option key={mesh.id} value={mesh.id}>
										{mesh.name}
									</option>
								))}
							</select>
							<select
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={this.state.lookAtBoneName || this.props.object.bones[0].name}
								onChange={(event) => this.setState({ lookAtBoneName: event.target.value })}
							>
								{this.props.object.bones.map((bone) => (
									<option key={bone.name} value={bone.name}>
										{bone.name}
									</option>
								))}
							</select>
							<select
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								value={this.state.lookAtTargetNodeId || targetNodes[0].id}
								onChange={(event) => this.setState({ lookAtTargetNodeId: event.target.value })}
							>
								{targetNodes.map((node) => (
									<option key={node.id} value={node.id}>
										{node.name}
									</option>
								))}
							</select>
							<Button
								size="sm"
								variant="secondary"
								className="col-span-3"
								onClick={() => this._createLookAtConstraint(boundMeshes[0].id, this.props.object.bones[0].name, targetNodes[0].id)}
							>
								Add Look-At Constraint
							</Button>
						</div>
					)}
					{ikControllers.map((controller) => (
						<div key={controller.id} className="flex items-center gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
							<span className="min-w-0 flex-1 truncate">
								IK · {controller.boneName} → {scene.getNodeById(controller.targetNodeId)?.name ?? controller.targetNodeId}
								{controller.poleTargetNodeId ? ` · pole ${scene.getNodeById(controller.poleTargetNodeId)?.name ?? controller.poleTargetNodeId}` : ""}
							</span>
							<Button
								size="sm"
								variant={controller.enabled === false ? "ghost" : "default"}
								onClick={() => this._setIKEnabled(controller, controller.enabled === false)}
							>
								{controller.enabled === false ? "Enable" : "Disable"}
							</Button>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteIK(controller.id)}>
								Remove
							</Button>
						</div>
					))}
					{lookAtConstraints.map((constraint) => (
						<div key={constraint.id} className="flex items-center gap-2 rounded-lg bg-muted-foreground/10 p-2 text-xs">
							<span className="min-w-0 flex-1 truncate">
								Look At · {constraint.boneName} → {scene.getNodeById(constraint.targetNodeId)?.name ?? constraint.targetNodeId}
							</span>
							<Button
								size="sm"
								variant={constraint.enabled === false ? "ghost" : "default"}
								onClick={() => this._setLookAtEnabled(constraint, constraint.enabled === false)}
							>
								{constraint.enabled === false ? "Enable" : "Disable"}
							</Button>
							<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteLookAt(constraint.id)}>
								Remove
							</Button>
						</div>
					))}
					{ikControllers.length + lookAtConstraints.length === 0 && (
						<div className="px-2 text-xs text-muted-foreground">No persisted rig constraints for this skeleton.</div>
					)}
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Animation Ranges">
					{this.props.object
						.getAnimationRanges()
						.filter((range) => range)
						.map((range, index) => (
							<div key={index} className="flex items-center gap-[10px]">
								<Button
									variant="ghost"
									className="justify-start w-1/2"
									onDoubleClick={async () => {
										const name = await showPrompt("Rename Animation Range", "Enter the new name for the animation range", range!.name);
										if (name) {
											range!.name = name;
											this.forceUpdate();
										}
									}}
									onClick={() => {
										this.props.object.getScene().stopAnimation(this.props.object);
										this.props.object?.beginAnimation(range!.name, true, 1.0);
									}}
								>
									{range!.name}
								</Button>

								<div className="flex items-center w-1/2">
									<EditorInspectorNumberField
										object={range}
										property="from"
										onChange={() => {
											this.props.editor.layout.preview.scene.stopAnimation(this.props.object);
											this.props.editor.layout.preview.scene.beginAnimation(this.props.object, range!.from, range!.from, true, 1.0);
										}}
									/>
									<EditorInspectorNumberField
										object={range}
										property="to"
										onChange={() => {
											this.props.editor.layout.preview.scene.stopAnimation(this.props.object);
											this.props.editor.layout.preview.scene.beginAnimation(this.props.object, range!.to, range!.to, true, 1.0);
										}}
									/>

									<Button
										variant="ghost"
										className="p-2"
										onClick={() => {
											try {
												navigator.clipboard.writeText(range!.name);
												toast.success("Animation range name copied to clipboard");
											} catch (e) {
												toast.error("Failed to copy animation range name");
											}
										}}
									>
										<FaCopy />
									</Button>

									<Button
										variant="secondary"
										className="p-2"
										onClick={() => {
											this.props.object.deleteAnimationRange(range!.name, false);
											this.forceUpdate();
										}}
									>
										<IoCloseOutline className="w-4 h-4" />
									</Button>
								</div>
							</div>
						))}

					<Button
						variant="secondary"
						className="flex items-center gap-[5px] w-full"
						onClick={async () => {
							const name = await showPrompt("Add Animation Range", "Enter the name of the new animation range");
							if (name) {
								this.props.object.createAnimationRange(name, 0, 100);
								this.forceUpdate();
							}
						}}
					>
						<IoAddSharp className="w-6 h-6" /> Add
					</Button>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Binded Meshes">
					{this.props.editor.layout.preview.scene.meshes
						.filter((mesh) => mesh.skeleton === this.props.object)
						.map((mesh) => (
							<div
								key={mesh.id}
								onClick={() => this.props.editor.layout.graph.setSelectedNode(mesh)}
								className={`
									flex justify-between items-center w-full bg-secondary/50 rounded-lg p-2
									hover:bg-secondary cursor-pointer
									transition-all duration-300 ease-in-out
								`}
							>
								<div className="flex flex-col">
									<div>{mesh.name}</div>
									<div className="text-xs opacity-50">{mesh.id}</div>
								</div>

								<FaArrowAltCircleRight className="w-6 h-6" />
							</div>
						))}
				</EditorInspectorSectionField>
			</>
		);
	}

	private _renderSkinWeightAuthoring(boundMeshes: Mesh[]): ReactNode {
		const mesh = boundMeshes.find((candidate) => candidate.id === this.state.skinWeightMeshId) ?? boundMeshes[0];
		const boneName = this.state.skinWeightBoneName || this.props.object.bones[0]?.name || "";
		let inspection: any;
		try {
			inspection = getMeshSkinWeights(mesh.getScene(), { nodeId: mesh.id, limit: 1 });
		} catch (error: any) {
			return (
				<EditorInspectorSectionField title="Skin Weights">
					<div className="text-xs text-red-400">{error.message}</div>
				</EditorInspectorSectionField>
			);
		}
		const selection = mesh.metadata?.babylonEditorMeshSelection;
		const selectedVertices: number[] = selection?.mode === "vertex" ? selection.indices : [];
		const report = inspection.report;
		return (
			<EditorInspectorSectionField
				title="Skin Weights"
				tooltip="Unity-style named-bone weight authoring over Babylon's main and extra influence buffers. Select mesh vertices in Mesh Modeling or use MCP spherical brushes."
			>
				<div className="space-y-2">
					<div className={report.valid ? "text-xs text-emerald-400" : "text-xs text-amber-300"}>
						{report.valid ? "Valid" : "Needs repair"} · {report.vertexCount} vertices · {report.boneCount} bones · max {report.maximumObservedInfluences}/
						{report.configuredInfluencers} influences
					</div>
					{!report.valid && (
						<div className="text-xs text-muted-foreground">
							{report.unweightedVertexCount} unweighted · {report.unnormalizedVertexCount} unnormalized · {report.invalidBoneReferenceCount} invalid bone refs ·{" "}
							{report.duplicateBoneInfluenceCount} duplicate influences
						</div>
					)}
					<div className="grid grid-cols-2 gap-2">
						<select
							className="h-8 rounded-md border border-input bg-background px-2 text-xs"
							value={mesh.id}
							onChange={(event) => this.setState({ skinWeightMeshId: event.target.value })}
						>
							{boundMeshes.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.name}
								</option>
							))}
						</select>
						<select
							className="h-8 rounded-md border border-input bg-background px-2 text-xs"
							value={boneName}
							onChange={(event) => this.setState({ skinWeightBoneName: event.target.value })}
						>
							{this.props.object.bones.map((bone) => (
								<option key={bone.name} value={bone.name}>
									{bone.name}
								</option>
							))}
						</select>
					</div>
					<label className="grid grid-cols-[54px_1fr_44px] items-center gap-2 text-xs">
						<span>Weight</span>
						<input
							type="range"
							min="0"
							max="1"
							step="0.01"
							value={this.state.skinWeightValue}
							onChange={(event) => this.setState({ skinWeightValue: Number(event.target.value) })}
						/>
						<span>{this.state.skinWeightValue.toFixed(2)}</span>
					</label>
					<div className="text-xs text-muted-foreground">
						{selectedVertices.length} selected vertex(s). Use Mesh Modeling → Vertex selection or Ctrl/Cmd+Shift in the viewport.
					</div>
					<div className="grid grid-cols-4 gap-1">
						<Button
							size="sm"
							variant="secondary"
							disabled={!selectedVertices.length}
							onClick={() => this._paintSelectedSkinWeights(mesh, boneName, selectedVertices, "replace")}
						>
							Replace
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!selectedVertices.length}
							onClick={() => this._paintSelectedSkinWeights(mesh, boneName, selectedVertices, "add")}
						>
							Add
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!selectedVertices.length}
							onClick={() => this._paintSelectedSkinWeights(mesh, boneName, selectedVertices, "subtract")}
						>
							Subtract
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!selectedVertices.length}
							onClick={() => this._paintSelectedSkinWeights(mesh, boneName, selectedVertices, "smooth")}
						>
							Smooth
						</Button>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<label className="grid grid-cols-[1fr_60px] items-center gap-1 text-xs">
							<span>Max influences</span>
							<input
								type="number"
								min="1"
								max="8"
								step="1"
								className="h-7 rounded border border-border bg-input px-1"
								value={this.state.skinWeightMaximumInfluences}
								onChange={(event) => this.setState({ skinWeightMaximumInfluences: Math.max(1, Math.min(8, Number(event.target.value))) })}
							/>
						</label>
						<label className="grid grid-cols-[1fr_70px] items-center gap-1 text-xs">
							<span>Prune ≤</span>
							<input
								type="number"
								min="0"
								max="0.5"
								step="0.001"
								className="h-7 rounded border border-border bg-input px-1"
								value={this.state.skinWeightMinimumWeight}
								onChange={(event) => this.setState({ skinWeightMinimumWeight: Math.max(0, Math.min(0.5, Number(event.target.value))) })}
							/>
						</label>
					</div>
					<div className="grid grid-cols-2 gap-1">
						<Button size="sm" variant="secondary" onClick={() => this._optimizeSkinWeights(mesh, selectedVertices)}>
							{selectedVertices.length ? "Optimize Selected" : "Optimize All"}
						</Button>
						<Button size="sm" variant="outline" onClick={() => this._mirrorSkinWeights(mesh, "negativeToPositive")}>
							Mirror −X → +X
						</Button>
						<Button size="sm" variant="outline" className="col-span-2" onClick={() => this._mirrorSkinWeights(mesh, "positiveToNegative")}>
							Mirror +X → −X
						</Button>
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _runSkinWeightEdit(mesh: Mesh, edit: () => void, success: string): void {
		const scene = mesh.getScene();
		const options = { editor: this.props.editor };
		try {
			const before = captureMeshSkinWeightSnapshot(scene, { nodeId: mesh.id });
			edit();
			const after = captureMeshSkinWeightSnapshot(scene, { nodeId: mesh.id });
			registerUndoRedo({
				undo: () => restoreMeshSkinWeightSnapshot(scene, before, options),
				redo: () => restoreMeshSkinWeightSnapshot(scene, after, options),
				action: () => this.forceUpdate(),
			});
			toast.success(success);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _paintSelectedSkinWeights(mesh: Mesh, boneName: string, vertexIndices: number[], mode: "replace" | "add" | "subtract" | "smooth"): void {
		this._runSkinWeightEdit(
			mesh,
			() => {
				const inspection = getMeshSkinWeights(mesh.getScene(), { nodeId: mesh.id, limit: 1 });
				paintMeshSkinWeights(
					mesh.getScene(),
					{
						nodeId: mesh.id,
						expectedFingerprint: inspection.fingerprint,
						boneName,
						vertexIndices,
						mode,
						weight: this.state.skinWeightValue,
						opacity: 1,
						maxInfluences: this.state.skinWeightMaximumInfluences,
						minimumWeight: this.state.skinWeightMinimumWeight,
					},
					{ editor: this.props.editor }
				);
			},
			`${mode[0].toUpperCase()}${mode.slice(1)} skin weights on ${vertexIndices.length} vertex(s)`
		);
	}

	private _optimizeSkinWeights(mesh: Mesh, vertexIndices: number[]): void {
		this._runSkinWeightEdit(
			mesh,
			() => {
				const inspection = getMeshSkinWeights(mesh.getScene(), { nodeId: mesh.id, limit: 1 });
				optimizeMeshSkinWeights(
					mesh.getScene(),
					{
						nodeId: mesh.id,
						expectedFingerprint: inspection.fingerprint,
						vertexIndices: vertexIndices.length ? vertexIndices : undefined,
						maxInfluences: this.state.skinWeightMaximumInfluences,
						minimumWeight: this.state.skinWeightMinimumWeight,
					},
					{ editor: this.props.editor }
				);
			},
			`Optimized skin weights on ${vertexIndices.length || "all"} vertices`
		);
	}

	private _mirrorSkinWeights(mesh: Mesh, direction: "negativeToPositive" | "positiveToNegative"): void {
		this._runSkinWeightEdit(
			mesh,
			() => {
				const inspection = getMeshSkinWeights(mesh.getScene(), { nodeId: mesh.id, limit: 1 });
				mirrorMeshSkinWeights(
					mesh.getScene(),
					{
						nodeId: mesh.id,
						expectedFingerprint: inspection.fingerprint,
						axis: "x",
						direction,
						tolerance: 0.001,
						maxInfluences: this.state.skinWeightMaximumInfluences,
						minimumWeight: this.state.skinWeightMinimumWeight,
					},
					{ editor: this.props.editor }
				);
			},
			"Mirrored skin weights"
		);
	}

	private _renderRigLayers(rigLayers: any[], targetNodes: any[]): ReactNode {
		const defaultBoneName = this.state.rigBoneName || this.props.object.bones[0]?.name || "";
		const defaultSourceNodeId = this.state.rigSourceNodeId || targetNodes[0]?.id || "";
		const defaultSecondarySourceNodeId = this.state.rigSecondarySourceNodeId || targetNodes.find((node) => node.id !== defaultSourceNodeId)?.id || "";
		const axisOptions = [
			{ label: "+X", value: "1,0,0" },
			{ label: "-X", value: "-1,0,0" },
			{ label: "+Y", value: "0,1,0" },
			{ label: "-Y", value: "0,-1,0" },
			{ label: "+Z", value: "0,0,1" },
			{ label: "-Z", value: "0,0,-1" },
		];
		const defaultChainTip = this.props.object.bones.find((bone) => bone.name === this.state.rigChainTipBoneName) ?? this.props.object.bones.find((bone) => !!bone.getParent());
		const defaultChainRootBoneName = this.state.rigChainRootBoneName || defaultChainTip?.getParent()?.name || "";
		const defaultChainTipBoneName = this.state.rigChainTipBoneName || defaultChainTip?.name || "";
		return (
			<div className="mb-2 space-y-2 border-b border-border pb-2">
				<div className="flex items-center justify-between">
					<div>
						<div className="text-xs font-medium">Animation Rig Layers</div>
						<div className="text-xs text-muted-foreground">Ordered weighted constraints evaluated after animation.</div>
					</div>
					<Button size="sm" variant="secondary" onClick={() => this._createRigLayer()}>
						Add Layer
					</Button>
				</div>
				{rigLayers.map((layer) => (
					<div key={layer.id} className="space-y-2 rounded-md border border-border p-2">
						<div className="grid grid-cols-[auto_1fr_58px_auto] items-center gap-1 text-xs">
							<input type="checkbox" checked={layer.enabled !== false} onChange={(event) => this._setRigLayer(layer.id, { enabled: event.target.checked })} />
							<input
								className="h-7 rounded border border-border bg-input px-1"
								defaultValue={layer.name}
								onBlur={(event) => event.target.value.trim() && event.target.value !== layer.name && this._setRigLayer(layer.id, { name: event.target.value })}
							/>
							<input
								type="number"
								min="-1000"
								max="1000"
								className="h-7 rounded border border-border bg-input px-1"
								value={layer.order}
								title="Evaluation order"
								onChange={(event) => this._setRigLayer(layer.id, { order: Number(event.target.value) })}
							/>
							<Button size="sm" variant="ghost" onClick={() => this._deleteRigLayer(layer.id)}>
								Remove
							</Button>
						</div>
						<label className="grid grid-cols-[48px_1fr_36px] items-center gap-1 text-xs">
							<span>Weight</span>
							<input
								type="range"
								min="0"
								max="1"
								step="0.01"
								value={layer.weight}
								onChange={(event) => this._setRigLayer(layer.id, { weight: Number(event.target.value) })}
							/>
							<span>{layer.weight.toFixed(2)}</span>
						</label>
						<EditorRigConstraintGraph editor={this.props.editor} scene={this.props.object.getScene()} layerId={layer.id} onChange={() => this.forceUpdate()} />
						{layer.constraints.map((constraint: any) => (
							<div key={constraint.id} className="space-y-1 rounded bg-muted-foreground/10 p-1 text-xs">
								<div className="flex items-center gap-1">
									<input
										type="checkbox"
										checked={constraint.enabled !== false}
										onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { enabled: event.target.checked })}
									/>
									<span className="min-w-0 flex-1 truncate">
										{constraint.name} · {constraint.type} · {constraint.valid ? "valid" : "missing/invalid reference"}
									</span>
									<input
										type="number"
										min="0"
										max="1"
										step="0.05"
										className="h-7 w-14 rounded border border-border bg-input px-1"
										value={constraint.weight}
										onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { weight: Number(event.target.value) })}
									/>
									<Button size="sm" variant="ghost" onClick={() => this._deleteRigConstraint(layer.id, constraint.id)}>
										Remove
									</Button>
								</div>
								{constraint.type === "chainIk" && (
									<div className="grid grid-cols-2 gap-1 border-t border-border/50 pt-1">
										<select
											className="h-7 rounded border border-border bg-input px-1"
											value={constraint.targetNodeId}
											onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { targetNodeId: event.target.value })}
											title="Target TransformNode"
										>
											{targetNodes.map((node) => (
												<option key={node.id} value={node.id}>
													{node.name}
												</option>
											))}
										</select>
										<div className="self-center text-muted-foreground">
											{constraint.chainBoneCount} bones · {constraint.targetReachable ? "reachable" : "extended"} · error{" "}
											{Number(constraint.tipError ?? 0).toFixed(2)} cm
										</div>
										<label className="grid grid-cols-[62px_1fr] items-center gap-1">
											<span>Iterations</span>
											<input
												type="number"
												min="1"
												max="64"
												className="h-7 rounded border border-border bg-input px-1"
												value={constraint.maxIterations}
												onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { maxIterations: Number(event.target.value) })}
											/>
										</label>
										<label className="grid grid-cols-[58px_1fr] items-center gap-1">
											<span>Tolerance</span>
											<input
												type="number"
												min="0.0001"
												max="100"
												step="0.01"
												className="h-7 rounded border border-border bg-input px-1"
												value={constraint.tolerance}
												onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { tolerance: Number(event.target.value) })}
											/>
										</label>
										<label className="grid grid-cols-[68px_1fr_32px] items-center gap-1">
											<span>Chain Rot.</span>
											<input
												type="range"
												min="0"
												max="1"
												step="0.01"
												value={constraint.chainRotationWeight}
												onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { chainRotationWeight: Number(event.target.value) })}
											/>
											<span>{constraint.chainRotationWeight.toFixed(2)}</span>
										</label>
										<label className="grid grid-cols-[58px_1fr_32px] items-center gap-1">
											<span>Tip Rot.</span>
											<input
												type="range"
												min="0"
												max="1"
												step="0.01"
												value={constraint.tipRotationWeight}
												onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { tipRotationWeight: Number(event.target.value) })}
											/>
											<span>{constraint.tipRotationWeight.toFixed(2)}</span>
										</label>
									</div>
								)}
								{constraint.type === "multiPosition" && (
									<div className="grid grid-cols-2 gap-1 border-t border-border/50 pt-1">
										<div className="self-center text-muted-foreground">
											{constraint.activeSourceCount}/{constraint.sourceCount} sources · error {Number(constraint.positionError ?? 0).toFixed(2)} cm
										</div>
										<label className="self-center">
											<input
												type="checkbox"
												checked={constraint.maintainOffset !== false}
												onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { maintainOffset: event.target.checked })}
											/>{" "}
											Maintain offset
										</label>
										<div className="col-span-2 flex gap-3">
											{["X", "Y", "Z"].map((axis, index) => (
												<label key={axis}>
													<input
														type="checkbox"
														checked={constraint.positionAxes[index]}
														onChange={(event) => {
															const positionAxes = [...constraint.positionAxes];
															positionAxes[index] = event.target.checked;
															this._setRigConstraint(layer.id, constraint.id, { positionAxes });
														}}
													/>{" "}
													{axis}
												</label>
											))}
										</div>
									</div>
								)}
								{constraint.type === "multiAim" && (
									<div className="grid grid-cols-3 gap-1 border-t border-border/50 pt-1">
										<div className="col-span-2 self-center text-muted-foreground">
											{constraint.activeSourceCount}/{constraint.sourceCount} sources · aim error {Number(constraint.aimErrorDegrees ?? 0).toFixed(2)}°
										</div>
										<label className="self-center">
											<input
												type="checkbox"
												checked={constraint.maintainOffset !== false}
												onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { maintainOffset: event.target.checked })}
											/>{" "}
											Offset
										</label>
										{[
											{ label: "Aim", property: "aimAxis" },
											{ label: "Up", property: "upAxis" },
											{ label: "World Up", property: "worldUpAxis" },
										].map((field) => (
											<label key={field.property} className="grid grid-cols-[auto_1fr] items-center gap-1">
												<span>{field.label}</span>
												<select
													className="h-7 rounded border border-border bg-input px-1"
													value={constraint[field.property].join(",")}
													onChange={(event) =>
														this._setRigConstraint(layer.id, constraint.id, { [field.property]: event.target.value.split(",").map(Number) })
													}
												>
													{axisOptions.map((option) => (
														<option key={option.value} value={option.value}>
															{option.label}
														</option>
													))}
												</select>
											</label>
										))}
									</div>
								)}
								{constraint.type === "fullBodyIk" && (
									<div className="space-y-1 border-t border-border/50 pt-1">
										<div className="text-muted-foreground">
											{constraint.reachedEffectorCount}/{constraint.activeEffectorCount} reached · avg {Number(constraint.averageError ?? 0).toFixed(2)} cm ·
											max {Number(constraint.maximumError ?? 0).toFixed(2)} cm
										</div>
										<div className="grid grid-cols-2 gap-1">
											<label className="grid grid-cols-[62px_1fr] items-center gap-1">
												<span>Iterations</span>
												<input
													type="number"
													min="1"
													max="64"
													className="h-7 rounded border border-border bg-input px-1"
													value={constraint.maxIterations}
													onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { maxIterations: Number(event.target.value) })}
												/>
											</label>
											<label className="grid grid-cols-[58px_1fr] items-center gap-1">
												<span>Tolerance</span>
												<input
													type="number"
													min="0.0001"
													max="100"
													step="0.01"
													className="h-7 rounded border border-border bg-input px-1"
													value={constraint.tolerance}
													onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { tolerance: Number(event.target.value) })}
												/>
											</label>
										</div>
										{constraint.effectors.map((effector: any, effectorIndex: number) => (
											<div key={effector.boneName} className="grid grid-cols-[1fr_50px_50px_auto] items-center gap-1 rounded border border-border/50 p-1">
												<span className="truncate">
													{effector.boneName} → {targetNodes.find((node) => node.id === effector.targetNodeId)?.name ?? effector.targetNodeId} ·{" "}
													{effector.valid ? `${Number(effector.error ?? 0).toFixed(2)} cm` : "invalid"}
												</span>
												<input
													type="number"
													min="0"
													max="1"
													step="0.05"
													value={effector.positionWeight}
													title="Position weight"
													className="h-7 rounded border border-border bg-input px-1"
													onChange={(event) =>
														this._setFullBodyIkEffector(layer.id, constraint, effectorIndex, {
															positionWeight: Number(event.target.value),
														})
													}
												/>
												<input
													type="number"
													min="0"
													max="1"
													step="0.05"
													value={effector.rotationWeight}
													title="Rotation weight"
													className="h-7 rounded border border-border bg-input px-1"
													onChange={(event) =>
														this._setFullBodyIkEffector(layer.id, constraint, effectorIndex, {
															rotationWeight: Number(event.target.value),
														})
													}
												/>
												<Button
													size="sm"
													variant="ghost"
													disabled={constraint.effectors.length <= 1}
													onClick={() => this._removeFullBodyIkEffector(layer.id, constraint, effectorIndex)}
												>
													Remove
												</Button>
											</div>
										))}
										<Button
											size="sm"
											variant="outline"
											className="w-full"
											disabled={
												!defaultBoneName ||
												!defaultSourceNodeId ||
												constraint.effectors.length >= 8 ||
												constraint.effectors.some((effector: any) => effector.boneName === defaultBoneName)
											}
											onClick={() => this._addFullBodyIkEffector(layer.id, constraint, defaultBoneName, defaultSourceNodeId)}
										>
											Add Selected Effector
										</Button>
									</div>
								)}
								{["overrideTransform", "dampedTransform", "blendTransform"].includes(constraint.type) && (
									<div className="space-y-1 border-t border-border/50 pt-1">
										<div className="text-muted-foreground">
											Position error {Number(constraint.positionError ?? 0).toFixed(2)} cm · rotation error{" "}
											{Number(constraint.rotationErrorDegrees ?? 0).toFixed(2)}°
										</div>
										<div className="grid grid-cols-2 gap-1">
											<label>
												<input
													type="checkbox"
													checked={constraint.maintainOffset !== false}
													onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { maintainOffset: event.target.checked })}
												/>{" "}
												Maintain offset
											</label>
											{constraint.type === "blendTransform" && (
												<label className="grid grid-cols-[36px_1fr_32px] items-center gap-1">
													<span>Blend</span>
													<input
														type="range"
														min="0"
														max="1"
														step="0.01"
														value={constraint.blend}
														onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { blend: Number(event.target.value) })}
													/>
													<span>{constraint.blend.toFixed(2)}</span>
												</label>
											)}
											{[
												{ label: "Position", property: "positionWeight", axes: "positionAxes" },
												{ label: "Rotation", property: "rotationWeight", axes: "rotationAxes" },
											].map((field) => (
												<div key={field.property} className="space-y-1 rounded border border-border/50 p-1">
													<label className="grid grid-cols-[52px_1fr_32px] items-center gap-1">
														<span>{field.label}</span>
														<input
															type="range"
															min="0"
															max="1"
															step="0.01"
															value={constraint[field.property]}
															onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { [field.property]: Number(event.target.value) })}
														/>
														<span>{constraint[field.property].toFixed(2)}</span>
													</label>
													<div className="flex gap-2">
														{["X", "Y", "Z"].map((axis, axisIndex) => (
															<label key={axis}>
																<input
																	type="checkbox"
																	checked={constraint[field.axes][axisIndex]}
																	onChange={(event) => {
																		const axes = [...constraint[field.axes]];
																		axes[axisIndex] = event.target.checked;
																		this._setRigConstraint(layer.id, constraint.id, { [field.axes]: axes });
																	}}
																/>{" "}
																{axis}
															</label>
														))}
													</div>
												</div>
											))}
										</div>
										{constraint.type === "dampedTransform" && (
											<div className="grid grid-cols-2 gap-1">
												{[
													{ label: "Position damp", property: "positionDamping" },
													{ label: "Rotation damp", property: "rotationDamping" },
												].map((field) => (
													<label key={field.property} className="grid grid-cols-[74px_1fr_32px] items-center gap-1">
														<span>{field.label}</span>
														<input
															type="range"
															min="0"
															max="1"
															step="0.01"
															value={constraint[field.property]}
															onChange={(event) => this._setRigConstraint(layer.id, constraint.id, { [field.property]: Number(event.target.value) })}
														/>
														<span>{constraint[field.property].toFixed(2)}</span>
													</label>
												))}
											</div>
										)}
									</div>
								)}
							</div>
						))}
						<div className="grid grid-cols-2 gap-1">
							<select
								className="h-8 rounded-md border border-input bg-background px-1 text-xs"
								value={defaultBoneName}
								onChange={(event) => this.setState({ rigBoneName: event.target.value })}
							>
								{this.props.object.bones.map((bone) => (
									<option key={bone.name} value={bone.name}>
										{bone.name}
									</option>
								))}
							</select>
							<select
								className="h-8 rounded-md border border-input bg-background px-1 text-xs"
								value={defaultSourceNodeId}
								onChange={(event) => this.setState({ rigSourceNodeId: event.target.value })}
							>
								{targetNodes.map((node) => (
									<option key={node.id} value={node.id}>
										{node.name}
									</option>
								))}
							</select>
							<Button
								size="sm"
								variant="outline"
								disabled={!defaultBoneName || !defaultSourceNodeId}
								onClick={() => this._createMultiParentConstraint(layer.id, defaultBoneName, defaultSourceNodeId)}
							>
								Add Multi-Parent
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!defaultBoneName || !defaultSourceNodeId}
								onClick={() => this._createMultiPositionConstraint(layer.id, defaultBoneName, defaultSourceNodeId)}
							>
								Add Multi-Position
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="col-span-2"
								disabled={!defaultBoneName || !defaultSourceNodeId}
								onClick={() => this._createMultiAimConstraint(layer.id, defaultBoneName, defaultSourceNodeId)}
							>
								Add Multi-Aim
							</Button>
							<select
								className="col-span-2 h-8 rounded-md border border-input bg-background px-1 text-xs"
								value={defaultSecondarySourceNodeId}
								onChange={(event) => this.setState({ rigSecondarySourceNodeId: event.target.value })}
								title="Secondary source for Blend Transform"
							>
								{targetNodes
									.filter((node) => node.id !== defaultSourceNodeId)
									.map((node) => (
										<option key={node.id} value={node.id}>
											Blend source B: {node.name}
										</option>
									))}
							</select>
							<Button
								size="sm"
								variant="outline"
								disabled={!defaultBoneName || !defaultSourceNodeId}
								onClick={() => this._createTransformConstraint(layer.id, "overrideTransform", defaultBoneName, defaultSourceNodeId)}
							>
								Add Override
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!defaultBoneName || !defaultSourceNodeId}
								onClick={() => this._createTransformConstraint(layer.id, "dampedTransform", defaultBoneName, defaultSourceNodeId)}
							>
								Add Damped
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="col-span-2"
								disabled={!defaultBoneName || !defaultSourceNodeId || !defaultSecondarySourceNodeId}
								onClick={() => this._createBlendTransformConstraint(layer.id, defaultBoneName, defaultSourceNodeId, defaultSecondarySourceNodeId)}
							>
								Add Blend Transform
							</Button>
							<input
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
								placeholder="Twist bones: BoneA, BoneB"
								value={this.state.rigTwistBoneNames}
								onChange={(event) => this.setState({ rigTwistBoneNames: event.target.value })}
							/>
							<Button
								size="sm"
								variant="outline"
								className="col-span-2"
								disabled={!defaultBoneName || !this.state.rigTwistBoneNames.trim()}
								onClick={() => this._createTwistConstraint(layer.id, defaultBoneName, this.state.rigTwistBoneNames)}
							>
								Add Twist Distribution
							</Button>
							<select
								className="h-8 rounded-md border border-input bg-background px-1 text-xs"
								value={defaultChainRootBoneName}
								onChange={(event) => this.setState({ rigChainRootBoneName: event.target.value })}
								title="Chain IK root bone"
							>
								{this.props.object.bones.map((bone) => (
									<option key={bone.name} value={bone.name}>
										Root: {bone.name}
									</option>
								))}
							</select>
							<select
								className="h-8 rounded-md border border-input bg-background px-1 text-xs"
								value={defaultChainTipBoneName}
								onChange={(event) => this.setState({ rigChainTipBoneName: event.target.value })}
								title="Chain IK tip bone"
							>
								{this.props.object.bones.map((bone) => (
									<option key={bone.name} value={bone.name}>
										Tip: {bone.name}
									</option>
								))}
							</select>
							<Button
								size="sm"
								variant="outline"
								className="col-span-2"
								disabled={!defaultChainRootBoneName || !defaultChainTipBoneName || !defaultSourceNodeId}
								onClick={() => this._createChainIkConstraint(layer.id, defaultChainRootBoneName, defaultChainTipBoneName, defaultSourceNodeId)}
							>
								Add Chain IK
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="col-span-2"
								disabled={!defaultChainRootBoneName || !defaultChainTipBoneName || !defaultSourceNodeId}
								onClick={() => this._createFullBodyIkConstraint(layer.id, defaultChainRootBoneName, defaultChainTipBoneName, defaultSourceNodeId)}
							>
								Add Full-Body IK
							</Button>
						</div>
					</div>
				))}
				{rigLayers.length === 0 && <div className="text-xs text-muted-foreground">No ordered Animation Rig layers for this skeleton.</div>}
			</div>
		);
	}

	private _renderRetargetDebugger(targetAvatar: any, allAvatars: any[]): ReactNode {
		const scene = this.props.object.getScene();
		const sourceAvatars = allAvatars.filter((avatar) => avatar.id !== targetAvatar.id && avatar.animationType === "humanoid");
		const sourceAvatarId = sourceAvatars.some((avatar) => avatar.id === this.state.retargetSourceAvatarId) ? this.state.retargetSourceAvatarId : (sourceAvatars[0]?.id ?? "");
		const animationGroupName = scene.animationGroups.some((group) => group.name === this.state.retargetAnimationGroupName)
			? this.state.retargetAnimationGroupName
			: (scene.animationGroups[0]?.name ?? "");
		if (!sourceAvatarId || !animationGroupName) {
			return (
				<div className="space-y-1 border-t border-border pt-2">
					<div className="text-xs font-medium">Retarget Debugger</div>
					<div className="text-xs text-muted-foreground">
						{sourceAvatars.length
							? "Create or import an AnimationGroup to inspect retarget coverage."
							: "Create another Humanoid Avatar to compare source and target rigs."}
					</div>
				</div>
			);
		}
		const analysis = inspectHumanoidRetarget(scene, {
			sourceAvatarId,
			targetAvatarId: targetAvatar.id,
			animationGroupName,
			includeRootTranslation: this.state.retargetIncludeRootTranslation,
			includeScale: this.state.retargetIncludeScale,
		});
		const overlayActive =
			analysis.visualization.active && analysis.visualization.sourceAvatarId === sourceAvatarId && analysis.visualization.targetAvatarId === targetAvatar.id;
		const visibleRoles = analysis.roles.filter((role: any) => role.sourceTrackCount > 0 || (role.required && role.status !== "ready"));
		return (
			<div className="space-y-2 border-t border-border pt-2">
				<div>
					<div className="text-xs font-medium">Retarget Debugger</div>
					<div className="text-xs text-muted-foreground">Dry-run track coverage and rest-pose corrections before baking an editable target clip.</div>
				</div>
				<div className="grid grid-cols-[90px_1fr] items-center gap-1 text-xs">
					<span>Source Avatar</span>
					<select
						className="h-8 rounded-md border border-input bg-background px-2"
						value={sourceAvatarId}
						onChange={(event) => this.setState({ retargetSourceAvatarId: event.target.value })}
					>
						{sourceAvatars.map((avatar) => (
							<option key={avatar.id} value={avatar.id}>
								{avatar.name}
							</option>
						))}
					</select>
					<span>Source Clip</span>
					<select
						className="h-8 rounded-md border border-input bg-background px-2"
						value={animationGroupName}
						onChange={(event) => this.setState({ retargetAnimationGroupName: event.target.value })}
					>
						{scene.animationGroups.map((group) => (
							<option key={group.name} value={group.name}>
								{group.name}
							</option>
						))}
					</select>
				</div>
				<div className="grid grid-cols-3 gap-1 text-xs">
					<label>
						<input
							type="checkbox"
							checked={this.state.retargetIncludeRootTranslation}
							onChange={(event) => this.setState({ retargetIncludeRootTranslation: event.target.checked })}
						/>{" "}
						Root motion
					</label>
					<label>
						<input type="checkbox" checked={this.state.retargetIncludeScale} onChange={(event) => this.setState({ retargetIncludeScale: event.target.checked })} />{" "}
						Scale
					</label>
					<label>
						<input type="checkbox" checked={this.state.retargetShowAxes} onChange={(event) => this.setState({ retargetShowAxes: event.target.checked })} /> Local axes
					</label>
				</div>
				<div className={analysis.canBake ? "rounded-md bg-emerald-500/10 p-2 text-xs text-emerald-300" : "rounded-md bg-red-500/10 p-2 text-xs text-red-300"}>
					{analysis.canBake ? "Ready to bake" : "Retarget blocked"} · {analysis.compatibleTrackCount}/{analysis.totalTrackCount} compatible tracks ·{" "}
					{analysis.rolesWithCompatibleTracks} driven roles · scale ×{analysis.humanScaleRatio.toFixed(3)}
				</div>
				<div className="grid grid-cols-2 gap-1">
					<Button
						size="sm"
						variant="outline"
						onClick={() => this._setRetargetVisualization(sourceAvatarId, targetAvatar.id, !overlayActive, this.state.retargetShowAxes)}
					>
						{overlayActive ? "Hide Skeletons" : "Show Skeletons"}
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={!analysis.canBake}
						onClick={() => this._bakeRetargetedAnimation(sourceAvatarId, targetAvatar.id, animationGroupName)}
					>
						Bake Retargeted Clip
					</Button>
				</div>
				<div className="max-h-48 overflow-y-auto rounded-md border border-border">
					{visibleRoles.map((role: any) => (
						<div
							key={role.role}
							className="grid grid-cols-[1fr_64px_64px] gap-1 border-b border-border px-2 py-1 text-xs last:border-b-0"
							title={role.skipReasons.join(" ")}
						>
							<div className="min-w-0">
								<div className="truncate font-medium">{role.label}</div>
								<div className="truncate text-muted-foreground">
									{role.sourceBoneName ?? "unmapped"} → {role.targetBoneName ?? "unmapped"}
								</div>
							</div>
							<div className="text-right text-muted-foreground">
								{role.compatibleTrackCount}/{role.sourceTrackCount} tracks
							</div>
							<div
								className={
									role.status === "ready"
										? "text-right text-emerald-400"
										: role.status === "noTracks"
											? "text-right text-muted-foreground"
											: "text-right text-amber-300"
								}
							>
								{role.status !== "ready" || role.correctionAngleDegrees === null ? role.status : `${role.correctionAngleDegrees.toFixed(1)}°`}
							</div>
						</div>
					))}
					{visibleRoles.length === 0 && <div className="p-2 text-xs text-muted-foreground">No mapped Humanoid tracks were found in this clip.</div>}
				</div>
				{[...analysis.errors, ...analysis.warnings].map((message: string) => (
					<div key={message} className="text-xs text-amber-300">
						{message}
					</div>
				))}
			</div>
		);
	}

	private _renderMuscleLimitEditor(avatar: any): ReactNode {
		const mappedRoles = HUMAN_BONE_DEFINITIONS.filter((definition) => avatar.mapping[definition.role]);
		if (!mappedRoles.length) {
			return <div className="text-xs text-muted-foreground">Map bones before authoring muscle limits.</div>;
		}
		const role = mappedRoles.some((definition) => definition.role === this.state.muscleRole) ? this.state.muscleRole : mappedRoles[0].role;
		const limit = avatar.muscleLimits?.[role] ?? { min: [-180, -180, -180], max: [180, 180, 180] };
		const pose = avatar.animationType === "humanoid" ? getHumanoidMusclePose(this.props.object.getScene(), { avatarId: avatar.id }) : null;
		const poseEntry = pose?.muscles.find((muscle: any) => muscle.role === role);
		const normalizedPose = (poseEntry?.normalized ?? [0, 0, 0]) as [number, number, number];
		return (
			<div className="space-y-2">
				<select
					className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
					value={role}
					onChange={(event) => this.setState({ muscleRole: event.target.value })}
				>
					{mappedRoles.map((definition) => (
						<option key={definition.role} value={definition.role}>
							{definition.label} · {avatar.mapping[definition.role]}
						</option>
					))}
				</select>
				<div className="grid grid-cols-[auto_repeat(3,1fr)] items-center gap-1 text-xs">
					<span>Min°</span>
					{limit.min.map((value: number, axis: number) => (
						<input
							key={`min:${axis}`}
							type="number"
							min="-180"
							max="180"
							className="h-7 rounded border border-border bg-input px-1"
							value={value}
							onChange={(event) => this._setMuscleAxis(avatar.id, role, "min", axis, Number(event.target.value), limit)}
						/>
					))}
					<span>Max°</span>
					{limit.max.map((value: number, axis: number) => (
						<input
							key={`max:${axis}`}
							type="number"
							min="-180"
							max="180"
							className="h-7 rounded border border-border bg-input px-1"
							value={value}
							onChange={(event) => this._setMuscleAxis(avatar.id, role, "max", axis, Number(event.target.value), limit)}
						/>
					))}
				</div>
				{avatar.animationType === "humanoid" ? (
					<div className="space-y-2 rounded-md border border-border p-2">
						<div className="flex items-start justify-between gap-2">
							<div>
								<div className="text-xs font-medium">Muscle Pose Preview</div>
								<div className="text-xs text-muted-foreground">Normalized -1…1 role-local pose. Temporary preview values are restored before scene save.</div>
							</div>
							<div className={pose?.active ? "text-xs text-emerald-400" : "text-xs text-muted-foreground"}>{pose?.active ? `${pose.preset} active` : "inactive"}</div>
						</div>
						<div className="grid grid-cols-3 gap-1">
							<Button size="sm" variant="outline" onClick={() => this._setPosePreset(avatar.id, "rest")}>
								Rest Pose
							</Button>
							<Button size="sm" variant="outline" onClick={() => this._setPosePreset(avatar.id, "tPose")}>
								Enforce T-Pose
							</Button>
							<Button size="sm" variant="outline" disabled={!pose?.active} onClick={() => this._stopPosePreview(avatar.id)}>
								Stop & Restore
							</Button>
						</div>
						{(["X", "Y", "Z"] as const).map((axisLabel, axis) => (
							<label key={axisLabel} className="grid grid-cols-[18px_1fr_86px] items-center gap-2 text-xs">
								<span>{axisLabel}</span>
								<input
									type="range"
									min="-1"
									max="1"
									step="0.01"
									value={normalizedPose[axis]}
									onChange={(event) => this._setMusclePreviewAxis(avatar.id, role, axis, Number(event.target.value), normalizedPose)}
								/>
								<span className={poseEntry?.withinLimits === false ? "text-right text-amber-300" : "text-right text-muted-foreground"}>
									{normalizedPose[axis].toFixed(2)} · {(poseEntry?.degrees[axis] ?? 0).toFixed(1)}°
								</span>
							</label>
						))}
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span>
								{pose?.activeMuscleCount ?? 0}/{pose?.mappedMuscleCount ?? mappedRoles.length} active · limits{" "}
								{poseEntry?.authoredLimits ? "authored" : "fallback ±180°"}
							</span>
							<Button size="sm" variant="ghost" onClick={() => this._setMusclePose(avatar.id, role, [0, 0, 0])}>
								Reset Selected
							</Button>
						</div>
						{pose?.warnings.map((message: string) => (
							<div key={message} className="text-xs text-amber-300">
								{message}
							</div>
						))}
					</div>
				) : (
					<div className="text-xs text-muted-foreground">Switch Animation Type to Humanoid to preview normalized muscle poses.</div>
				)}
			</div>
		);
	}

	private _createHumanoidAvatar(): void {
		try {
			createHumanoidAvatar(this.props.object.getScene(), { skeletonId: this.props.object.id, animationType: "humanoid", autoMap: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setHumanoidAvatar(avatarId: string, patch: Record<string, unknown>): void {
		try {
			setHumanoidAvatar(this.props.object.getScene(), { avatarId, ...patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setHumanoidMuscleLimits(avatarId: string, patch: Record<string, unknown>): void {
		try {
			setHumanoidMuscleLimits(this.props.object.getScene(), { avatarId, ...patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setMuscleAxis(avatarId: string, role: string, bound: "min" | "max", axis: number, value: number, current: any): void {
		if (!Number.isFinite(value)) {
			return;
		}
		const limit = { min: [...current.min], max: [...current.max] };
		limit[bound][axis] = value;
		this._setHumanoidMuscleLimits(avatarId, { limits: { [role]: limit } });
	}

	private _setPosePreset(avatarId: string, preset: "rest" | "tPose"): void {
		try {
			setHumanoidPosePreview(this.props.object.getScene(), { avatarId, preset, replace: true }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setMusclePose(avatarId: string, role: string, value: [number, number, number]): void {
		try {
			setHumanoidPosePreview(this.props.object.getScene(), { avatarId, preset: "muscles", pose: { [role]: value } }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setMusclePreviewAxis(avatarId: string, role: string, axis: number, value: number, current: [number, number, number]): void {
		if (!Number.isFinite(value)) {
			return;
		}
		const next = [...current] as [number, number, number];
		next[axis] = Math.min(1, Math.max(-1, value));
		this._setMusclePose(avatarId, role, next);
	}

	private _stopPosePreview(avatarId: string): void {
		try {
			stopHumanoidPosePreview(this.props.object.getScene(), { avatarId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setRetargetVisualization(sourceAvatarId: string, targetAvatarId: string, enabled: boolean, showAxes: boolean): void {
		try {
			setHumanoidRetargetDebugVisualization(this.props.object.getScene(), enabled ? { enabled: true, sourceAvatarId, targetAvatarId, showAxes } : { enabled: false }, {
				editor: this.props.editor,
			});
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _bakeRetargetedAnimation(sourceAvatarId: string, targetAvatarId: string, animationGroupName: string): Promise<void> {
		const outputName = await showPrompt("Bake Retargeted Animation", "Enter a name for the new editable AnimationGroup.", `${animationGroupName} Retargeted`);
		if (!outputName) {
			return;
		}
		try {
			const result = retargetHumanoidAnimation(
				this.props.object.getScene(),
				{
					sourceAvatarId,
					targetAvatarId,
					animationGroupName,
					outputName,
					includeRootTranslation: this.state.retargetIncludeRootTranslation,
					includeScale: this.state.retargetIncludeScale,
				},
				{ editor: this.props.editor }
			);
			toast.success(`Baked ${result.trackCount} retargeted track(s) to "${result.name}".`);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createAvatarMask(avatarId: string): void {
		try {
			createHumanoidAvatarMask(this.props.object.getScene(), { avatarId, name: `${this.props.object.name} Full Body` }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setAvatarMask(maskId: string, patch: Record<string, unknown>): void {
		try {
			setHumanoidAvatarMask(this.props.object.getScene(), { maskId, ...patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteAvatarMask(maskId: string): void {
		try {
			deleteHumanoidAvatarMask(this.props.object.getScene(), { maskId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createRigLayer(): void {
		try {
			createRigLayer(this.props.object.getScene(), { skeletonId: this.props.object.id, name: `${this.props.object.name} Rig` }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setRigLayer(layerId: string, patch: Record<string, unknown>): void {
		try {
			setRigLayer(this.props.object.getScene(), { layerId, ...patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteRigLayer(layerId: string): void {
		try {
			deleteRigLayer(this.props.object.getScene(), { layerId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createMultiParentConstraint(layerId: string, boneName: string, sourceNodeId: string): void {
		try {
			createRigConstraint(
				this.props.object.getScene(),
				{ layerId, type: "multiParent", name: `${boneName} Multi-Parent`, boneName, sources: [{ nodeId: sourceNodeId, weight: 1 }] },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createMultiPositionConstraint(layerId: string, boneName: string, sourceNodeId: string): void {
		try {
			createRigConstraint(
				this.props.object.getScene(),
				{
					layerId,
					type: "multiPosition",
					name: `${boneName} Multi-Position`,
					boneName,
					sources: [{ nodeId: sourceNodeId, weight: 1 }],
					maintainOffset: true,
					positionAxes: [true, true, true],
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createMultiAimConstraint(layerId: string, boneName: string, sourceNodeId: string): void {
		try {
			createRigConstraint(
				this.props.object.getScene(),
				{
					layerId,
					type: "multiAim",
					name: `${boneName} Multi-Aim`,
					boneName,
					sources: [{ nodeId: sourceNodeId, weight: 1 }],
					maintainOffset: true,
					aimAxis: [1, 0, 0],
					upAxis: [0, 1, 0],
					worldUpAxis: [0, 1, 0],
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createTransformConstraint(layerId: string, type: "overrideTransform" | "dampedTransform", boneName: string, sourceNodeId: string): void {
		try {
			createRigConstraint(
				this.props.object.getScene(),
				{
					layerId,
					type,
					name: `${boneName} ${type === "overrideTransform" ? "Override" : "Damped"}`,
					boneName,
					sourceNodeId,
					maintainOffset: true,
					positionWeight: 1,
					rotationWeight: 1,
					positionAxes: [true, true, true],
					rotationAxes: [true, true, true],
					positionDamping: 0.5,
					rotationDamping: 0.5,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createBlendTransformConstraint(layerId: string, boneName: string, sourceNodeIdA: string, sourceNodeIdB: string): void {
		try {
			createRigConstraint(
				this.props.object.getScene(),
				{
					layerId,
					type: "blendTransform",
					name: `${boneName} Blend`,
					boneName,
					sourceNodeIdA,
					sourceNodeIdB,
					maintainOffset: true,
					blend: 0.5,
					positionWeight: 1,
					rotationWeight: 1,
					positionAxes: [true, true, true],
					rotationAxes: [true, true, true],
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createTwistConstraint(layerId: string, sourceBoneName: string, twistBoneNames: string): void {
		const names = [
			...new Set(
				twistBoneNames
					.split(/[,\n;]/)
					.map((name) => name.trim())
					.filter(Boolean)
			),
		];
		try {
			createRigConstraint(
				this.props.object.getScene(),
				{
					layerId,
					type: "twist",
					name: `${sourceBoneName} Twist`,
					sourceBoneName,
					axis: [1, 0, 0],
					twistBones: names.map((boneName, index) => ({ boneName, weight: (index + 1) / names.length })),
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createChainIkConstraint(layerId: string, rootBoneName: string, tipBoneName: string, targetNodeId: string): void {
		try {
			createRigConstraint(
				this.props.object.getScene(),
				{
					layerId,
					type: "chainIk",
					name: `${rootBoneName} → ${tipBoneName} Chain IK`,
					rootBoneName,
					tipBoneName,
					targetNodeId,
					maxIterations: 15,
					tolerance: 0.01,
					chainRotationWeight: 1,
					tipRotationWeight: 0,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createFullBodyIkConstraint(layerId: string, rootBoneName: string, effectorBoneName: string, targetNodeId: string): void {
		try {
			createRigConstraint(
				this.props.object.getScene(),
				{
					layerId,
					type: "fullBodyIk",
					name: `${rootBoneName} Full-Body IK`,
					rootBoneName,
					maxIterations: 12,
					tolerance: 0.1,
					effectors: [{ boneName: effectorBoneName, targetNodeId, positionWeight: 1, rotationWeight: 0 }],
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _fullBodyIkEffectors(constraint: any): any[] {
		return constraint.effectors.map((effector: any) => ({
			boneName: effector.boneName,
			targetNodeId: effector.targetNodeId,
			positionWeight: effector.positionWeight,
			rotationWeight: effector.rotationWeight,
		}));
	}

	private _addFullBodyIkEffector(layerId: string, constraint: any, boneName: string, targetNodeId: string): void {
		this._setRigConstraint(layerId, constraint.id, {
			effectors: [...this._fullBodyIkEffectors(constraint), { boneName, targetNodeId, positionWeight: 1, rotationWeight: 0 }],
		});
	}

	private _setFullBodyIkEffector(layerId: string, constraint: any, index: number, patch: Record<string, unknown>): void {
		const effectors = this._fullBodyIkEffectors(constraint);
		effectors[index] = { ...effectors[index], ...patch };
		this._setRigConstraint(layerId, constraint.id, { effectors });
	}

	private _removeFullBodyIkEffector(layerId: string, constraint: any, index: number): void {
		const effectors = this._fullBodyIkEffectors(constraint);
		effectors.splice(index, 1);
		this._setRigConstraint(layerId, constraint.id, { effectors });
	}

	private _setRigConstraint(layerId: string, constraintId: string, patch: Record<string, unknown>): void {
		try {
			setRigConstraint(this.props.object.getScene(), { layerId, constraintId, ...patch }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteRigConstraint(layerId: string, constraintId: string): void {
		try {
			deleteRigConstraint(this.props.object.getScene(), { layerId, constraintId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createIKController(defaultMeshId: string, defaultBoneName: string, defaultTargetNodeId: string): void {
		try {
			createIKController(
				this.props.object.getScene(),
				{
					skeletonId: this.props.object.id,
					meshId: this.state.ikMeshId || defaultMeshId,
					boneName: this.state.ikBoneName || defaultBoneName,
					targetNodeId: this.state.ikTargetNodeId || defaultTargetNodeId,
					poleTargetNodeId: this.state.ikPoleTargetNodeId || undefined,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _createLookAtConstraint(defaultMeshId: string, defaultBoneName: string, defaultTargetNodeId: string): void {
		try {
			createLookAtConstraint(
				this.props.object.getScene(),
				{
					skeletonId: this.props.object.id,
					meshId: this.state.lookAtMeshId || defaultMeshId,
					boneName: this.state.lookAtBoneName || defaultBoneName,
					targetNodeId: this.state.lookAtTargetNodeId || defaultTargetNodeId,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setIKEnabled(controller: any, enabled: boolean): void {
		try {
			setIKController(this.props.object.getScene(), { id: controller.id, enabled }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteIK(id: string): void {
		try {
			deleteIKController(this.props.object.getScene(), { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _setLookAtEnabled(constraint: any, enabled: boolean): void {
		try {
			setLookAtConstraint(this.props.object.getScene(), { id: constraint.id, enabled }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _deleteLookAt(id: string): void {
		try {
			deleteLookAtConstraint(this.props.object.getScene(), { id }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}
}
