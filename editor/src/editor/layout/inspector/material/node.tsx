import { readJSON } from "fs-extra";
import { ipcRenderer } from "electron";
import { dirname, join } from "path/posix";

import { Component, ReactNode } from "react";

import { Grid } from "react-loader-spinner";

import { toast } from "sonner";

import { AbstractMesh, NodeMaterial, Observer, InputBlock, NodeMaterialBlockConnectionPointTypes } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";
import { showConfirm } from "../../../../ui/dialog";

import { normalizedGlob } from "../../../../tools/fs";
import { sortAlphabetically } from "../../../../tools/tools";
import { isNodeMaterial } from "../../../../tools/guards/material";

import { getProjectAssetsRootUrl, projectConfiguration } from "../../../../project/configuration";
import { Editor } from "../../../main";

import {
	addNodeMaterialCustomBlock,
	deleteNodeMaterialCustomBlock,
	listNodeMaterialCustomBlocks,
	stripNodeMaterialUnusedBlocks,
	validateNodeMaterialGraph,
} from "../../../../mcp/materials/materials";
import {
	connectNodeMaterialBlocks,
	disconnectNodeMaterialBlocks,
	getNodeMaterialCodeGraph,
	inspectNodeMaterialOptimization,
	optimizeNodeMaterialGraph,
} from "../../../../mcp/materials/node-material-code";
import {
	applyShaderGraphTemplate,
	createShaderGraphFromTemplate,
	getShaderGraphExtensions,
	listShaderGraphTemplates,
	shaderGraphTemplateCatalogRevision,
} from "../../../../mcp/materials/shader-graph";

import { EditorInspectorColorField } from "../fields/color";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorVectorField } from "../fields/vector";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSliderField } from "../fields/slider";
import { EditorInspectorSectionField } from "../fields/section";

import { EditorMaterialInspectorUtilsComponent } from "./components/utils";
import { EditorInspectorTextureField } from "../fields/texture";
import { IEditorInspectorImplementationProps } from "../inspector";

export interface IEditorNodeMaterialInspectorProps {
	mesh?: AbstractMesh;
	material: NodeMaterial;
	editor: Editor;
}

export interface IEditorNodeMaterialInspectorState {
	searchingToEdit: boolean;
	validating: boolean;
	stripping: boolean;
	optimizing: boolean;
	graphSource: string;
	graphTarget: string;
	customBlockName: string;
	customBlockFunctionName: string;
	customBlockCode: string;
	customBlockInputs: string;
	customBlockOutputs: string;
	customBlockTarget: "Vertex" | "Fragment" | "VertexAndFragment";
	templateQuery: string;
	templateCategory: "" | "Surface" | "Rendering" | "Procedural";
	templateBusyId: string | null;
}

/** Top-level Inspector adapter used when a Node Material asset is selected directly. */
export class EditorNodeMaterialRootInspector extends Component<IEditorInspectorImplementationProps<NodeMaterial>> {
	public static IsSupported(object: unknown): boolean {
		return isNodeMaterial(object);
	}

	public render(): ReactNode {
		return <EditorNodeMaterialInspector material={this.props.object} editor={this.props.editor} />;
	}
}

interface INodeMaterialCodeGraphPort {
	name: string;
	typeName: string;
	connected?: boolean;
}

interface INodeMaterialCodeGraphNode {
	id: number;
	name: string;
	className: string;
	reachable: boolean;
	custom: boolean;
	inputs: INodeMaterialCodeGraphPort[];
	outputs: INodeMaterialCodeGraphPort[];
}

interface INodeMaterialCodeGraphEdge {
	id: string;
	sourceBlockId: number;
	sourceBlockName: string;
	sourceOutput: string;
	targetBlockId: number;
	targetBlockName: string;
	targetInput: string;
}

interface INodeMaterialCodeGraph {
	fingerprint: string;
	nodes: INodeMaterialCodeGraphNode[];
	edges: INodeMaterialCodeGraphEdge[];
	edgeCount: number;
	reachableBlockCount: number;
}

export class EditorNodeMaterialInspector extends Component<IEditorNodeMaterialInspectorProps, IEditorNodeMaterialInspectorState> {
	private _buildObserver: Observer<NodeMaterial> | null = null;

	public constructor(props: IEditorNodeMaterialInspectorProps) {
		super(props);

		this.state = {
			searchingToEdit: false,
			validating: false,
			stripping: false,
			optimizing: false,
			graphSource: "",
			graphTarget: "",
			customBlockName: "",
			customBlockFunctionName: "",
			customBlockCode: "",
			customBlockInputs: "value:Float",
			customBlockOutputs: "result:Float",
			customBlockTarget: "Fragment",
			templateQuery: "",
			templateCategory: "",
			templateBusyId: null,
		};
	}

	public render(): ReactNode {
		const scene = this.props.material.getScene();
		if (!scene || !scene.materials.includes(this.props.material)) {
			return <div className="p-3 text-sm text-muted-foreground">This Node Material is no longer part of the scene.</div>;
		}
		return (
			<>
				<EditorInspectorSectionField title="Material" label={this.props.material.getClassName()}>
					<EditorInspectorStringField label="Name" object={this.props.material} property="name" />
					<EditorInspectorSwitchField label="Back Face Culling" object={this.props.material} property="backFaceCulling" />

					<EditorMaterialInspectorUtilsComponent mesh={this.props.mesh} material={this.props.material} />

					<div className="flex gap-2 w-full">
						<Button variant="default" disabled={this.state.searchingToEdit} className="flex gap-2 items-center flex-1" onClick={() => this._openNodeMaterialEditor()}>
							{this.state.searchingToEdit && (
								<div className="dark:invert">
									<Grid width={14} height={14} color="#ffffff" />
								</div>
							)}
							Edit...
						</Button>
						<Button variant="secondary" disabled={this.state.validating} className="flex-1" onClick={() => this._validateGraph()}>
							{this.state.validating ? "Validating..." : "Validate"}
						</Button>
						<Button variant="secondary" disabled={this.state.stripping} className="flex-1" onClick={() => this._stripUnusedBlocks()}>
							{this.state.stripping ? "Stripping..." : "Strip Unused"}
						</Button>
					</div>
				</EditorInspectorSectionField>
				{this._getShaderGraph65()}
				{this._getTextureBlocks()}
				{this._getCodeGraph()}
				{this._getCustomBlockAuthoring()}
				{this._getEditableBlocks()}
			</>
		);
	}

	private _getShaderGraph65(): ReactNode {
		const catalog = listShaderGraphTemplates(this.props.material.getScene(), {
			query: this.state.templateQuery,
			category: this.state.templateCategory || undefined,
			limit: 50,
		}) as any;
		const extensions = getShaderGraphExtensions(this.props.material.getScene(), { materialId: this.props.material.id }) as any;
		return (
			<EditorInspectorSectionField
				title="Shader Graph 6.5"
				tooltip="Search and create portable Node Material templates, or replace this graph under an exact revision. Unity Shader Graph/HLSL/SRP serialization is not claimed."
			>
				<div data-testid="shader-graph-65-status" className="space-y-2">
					<div className="grid grid-cols-[minmax(0,1fr)_140px] gap-2">
						<input
							className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
							value={this.state.templateQuery}
							onChange={(event) => this.setState({ templateQuery: event.currentTarget.value })}
							placeholder="Search templates (decal, fullscreen, surface...)"
						/>
						<select
							aria-label="Filter Shader Graph template category"
							className="h-9 rounded-md border border-input bg-background px-2 text-xs"
							value={this.state.templateCategory}
							onChange={(event) => this.setState({ templateCategory: event.currentTarget.value as IEditorNodeMaterialInspectorState["templateCategory"] })}
						>
							<option value="">All categories</option>
							<option value="Surface">Surface</option>
							<option value="Rendering">Rendering</option>
							<option value="Procedural">Procedural</option>
						</select>
					</div>
					<div className="max-h-52 space-y-2 overflow-auto">
						{catalog.templates.map((template: any) => (
							<div key={template.id} className="rounded-md border border-border bg-muted/40 p-2">
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0">
										<div className="truncate text-sm font-medium">{template.name}</div>
										<div className="text-[10px] text-muted-foreground">
											{template.category} · {template.target}
										</div>
									</div>
									<div className="flex shrink-0 gap-1">
										<Button
											size="sm"
											variant="secondary"
											disabled={this.state.templateBusyId !== null}
											onClick={() => void this._createShaderGraphTemplate(template.id)}
										>
											Create
										</Button>
										<Button
											size="sm"
											variant="default"
											disabled={this.state.templateBusyId !== null}
											onClick={() => void this._applyShaderGraphTemplate(template.id)}
										>
											Apply
										</Button>
									</div>
								</div>
								<div className="mt-1 text-xs text-muted-foreground">{template.description}</div>
							</div>
						))}
					</div>
					<div className="text-xs text-muted-foreground">
						Template {extensions.template?.id ?? "custom"} · {extensions.switches.length} Switch node{extensions.switches.length === 1 ? "" : "s"} ·{" "}
						{extensions.reflectedFunctions.length} reflected function{extensions.reflectedFunctions.length === 1 ? "" : "s"}
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _createShaderGraphTemplate(templateId: string): Promise<void> {
		this.setState({ templateBusyId: templateId });
		try {
			const result = await createShaderGraphFromTemplate(
				this.props.material.getScene(),
				{ templateId, expectedCatalogRevision: shaderGraphTemplateCatalogRevision, folder: "assets" },
				{ editor: this.props.editor }
			);
			toast.success(`Created ${String(result.name)} at ${String(result.path)}.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not create the Shader Graph template.");
		} finally {
			this.setState({ templateBusyId: null });
		}
	}

	private async _applyShaderGraphTemplate(templateId: string): Promise<void> {
		const confirmed = await showConfirm("Replace this Shader Graph?", "This replaces the complete graph while retaining its material id and mesh assignments.");
		if (!confirmed) {
			return;
		}
		this.setState({ templateBusyId: templateId });
		try {
			const extensions = getShaderGraphExtensions(this.props.material.getScene(), { materialId: this.props.material.id }) as any;
			await applyShaderGraphTemplate(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					templateId,
					expectedCatalogRevision: shaderGraphTemplateCatalogRevision,
					expectedGraphRevision: extensions.graphRevision,
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			toast.success("Shader Graph template applied.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not apply the Shader Graph template.");
		} finally {
			this.setState({ templateBusyId: null });
		}
	}

	private _getCodeGraph(): ReactNode {
		const graph = getNodeMaterialCodeGraph(this.props.material.getScene(), {
			materialId: this.props.material.id,
			limit: 256,
		}) as unknown as INodeMaterialCodeGraph;
		const depths = new Map<number, number>(graph.nodes.map((node) => [node.id, 0]));
		for (let pass = 0; pass < graph.nodes.length; pass++) {
			let changed = false;
			for (const edge of graph.edges) {
				const depth = Math.min(graph.nodes.length - 1, (depths.get(edge.sourceBlockId) ?? 0) + 1);
				if (depth > (depths.get(edge.targetBlockId) ?? 0)) {
					depths.set(edge.targetBlockId, depth);
					changed = true;
				}
			}
			if (!changed) {
				break;
			}
		}
		const rows = new Map<number, number>();
		const positions = new Map<number, { x: number; y: number }>();
		for (const node of graph.nodes) {
			const depth = depths.get(node.id) ?? 0;
			const row = rows.get(depth) ?? 0;
			rows.set(depth, row + 1);
			positions.set(node.id, { x: 16 + depth * 178, y: 16 + row * 116 });
		}
		const width = Math.max(360, 32 + (Math.max(0, ...depths.values()) + 1) * 178);
		const height = Math.max(148, 32 + Math.max(1, ...rows.values()) * 116);
		const sourcePorts = graph.nodes.flatMap((node) =>
			node.outputs.map((port) => ({ value: `${node.id}|${port.name}`, label: `${node.name}.${port.name} (${port.typeName})` }))
		);
		const targetPorts = graph.nodes.flatMap((node) => node.inputs.map((port) => ({ value: `${node.id}|${port.name}`, label: `${node.name}.${port.name} (${port.typeName})` })));

		return (
			<EditorInspectorSectionField title="Custom Shader Code Graph" tooltip="Inspect and wire the connected Node Material code graph without leaving the Inspector.">
				<div className="text-xs text-muted-foreground">
					{graph.nodes.length} blocks · {graph.edgeCount} connections · {graph.reachableBlockCount} compiled-path blocks
				</div>
				<div className="max-h-96 overflow-auto rounded-md border border-border bg-background/60">
					<div className="relative" style={{ width, height }}>
						<svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-label="Shader graph connections">
							{graph.edges.map((edge) => {
								const source = positions.get(edge.sourceBlockId);
								const target = positions.get(edge.targetBlockId);
								if (!source || !target) {
									return null;
								}
								const x1 = source.x + 146;
								const y1 = source.y + 51;
								const x2 = target.x;
								const y2 = target.y + 51;
								return (
									<path key={edge.id} d={`M ${x1} ${y1} C ${x1 + 36} ${y1}, ${x2 - 36} ${y2}, ${x2} ${y2}`} fill="none" stroke="rgb(34 197 94)" strokeWidth="2" />
								);
							})}
						</svg>
						{graph.nodes.map((node) => {
							const position = positions.get(node.id)!;
							return (
								<div
									key={node.id}
									className={`absolute w-36 rounded-md border shadow-sm ${node.custom ? "border-purple-500 bg-purple-950/40" : "border-border bg-card"} ${node.reachable ? "opacity-100" : "opacity-55"}`}
									style={{ left: position.x, top: position.y }}
									title={`${node.className} #${node.id}${node.reachable ? "" : " (unreachable)"}`}
								>
									<div className="truncate border-b border-border px-2 py-1 text-xs font-medium">{node.name}</div>
									<div className="grid grid-cols-2 gap-1 px-2 py-1 font-mono text-[10px]">
										<div>
											{node.inputs.map((port) => (
												<div key={port.name} className="truncate">
													● {port.name}
												</div>
											))}
										</div>
										<div className="text-right text-green-500">
											{node.outputs.map((port) => (
												<div key={port.name} className="truncate">
													{port.name} ●
												</div>
											))}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
				<div className="grid grid-cols-2 gap-2">
					<select
						className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
						value={this.state.graphSource}
						onChange={(event) => this.setState({ graphSource: event.currentTarget.value })}
					>
						<option value="">Source output...</option>
						{sourcePorts.map((port) => (
							<option key={port.value} value={port.value}>
								{port.label}
							</option>
						))}
					</select>
					<select
						className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
						value={this.state.graphTarget}
						onChange={(event) => this.setState({ graphTarget: event.currentTarget.value })}
					>
						<option value="">Target input...</option>
						{targetPorts.map((port) => (
							<option key={port.value} value={port.value}>
								{port.label}
							</option>
						))}
					</select>
				</div>
				<Button variant="secondary" disabled={!this.state.graphSource || !this.state.graphTarget} onClick={() => this._connectGraphPorts()}>
					Connect Ports
				</Button>
				{graph.edges.length > 0 && (
					<div className="max-h-36 space-y-1 overflow-auto">
						{graph.edges.map((edge) => (
							<div key={edge.id} className="flex items-center gap-2 rounded bg-muted px-2 py-1 text-[10px]">
								<span className="min-w-0 flex-1 truncate">
									{edge.sourceBlockName}.{edge.sourceOutput} → {edge.targetBlockName}.{edge.targetInput}
								</span>
								<Button size="sm" variant="ghost" onClick={() => this._disconnectGraphEdge(edge)}>
									Disconnect
								</Button>
							</div>
						))}
					</div>
				)}
				<Button variant="default" disabled={this.state.optimizing} onClick={() => void this._optimizeGraph()}>
					{this.state.optimizing ? "Inspecting..." : "Inspect & Optimize Connected Code"}
				</Button>
			</EditorInspectorSectionField>
		);
	}

	private _parseGraphPort(value: string): { blockId: number; port: string } {
		const separator = value.indexOf("|");
		const blockId = Number(value.slice(0, separator));
		const port = value.slice(separator + 1);
		if (separator < 1 || !Number.isInteger(blockId) || !port) {
			throw new Error("Select a valid shader graph port.");
		}
		return { blockId, port };
	}

	private _connectGraphPorts(): void {
		try {
			const source = this._parseGraphPort(this.state.graphSource);
			const target = this._parseGraphPort(this.state.graphTarget);
			connectNodeMaterialBlocks(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					sourceBlockId: source.blockId,
					sourceOutput: source.port,
					targetBlockId: target.blockId,
					targetInput: target.port,
					replace: false,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
			toast.success("Shader graph ports connected.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not connect shader graph ports.");
		}
	}

	private _disconnectGraphEdge(edge: INodeMaterialCodeGraphEdge): void {
		try {
			disconnectNodeMaterialBlocks(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					sourceBlockId: edge.sourceBlockId,
					sourceOutput: edge.sourceOutput,
					targetBlockId: edge.targetBlockId,
					targetInput: edge.targetInput,
				},
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not disconnect the shader graph edge.");
		}
	}

	private async _optimizeGraph(): Promise<void> {
		this.setState({ optimizing: true });
		try {
			const plan = inspectNodeMaterialOptimization(this.props.material.getScene(), { materialId: this.props.material.id }) as any;
			if (!plan.after.valid) {
				throw new Error(plan.after.errors.join("\n") || "The optimized shader graph did not compile.");
			}
			if (!plan.actionCount) {
				toast.success("The connected shader graph is already optimized.");
				return;
			}
			const confirmed = await showConfirm(
				"Optimize connected shader code?",
				`${plan.actionCount} exact change${plan.actionCount === 1 ? "" : "s"}; ${plan.before.blockCount} → ${plan.after.blockCount} blocks. This replaces the active material only after the optimized clone compiles.`
			);
			if (!confirmed) {
				return;
			}
			optimizeNodeMaterialGraph(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					expectedFingerprint: plan.fingerprint,
					confirm: true,
				},
				{ editor: this.props.editor }
			);
			toast.success(`Shader graph optimized with ${plan.actionCount} verified change${plan.actionCount === 1 ? "" : "s"}.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not optimize the shader graph.");
		} finally {
			this.setState({ optimizing: false });
		}
	}

	public componentDidMount(): void {
		this._buildObserver = this.props.material.onBuildObservable.add(() => {
			this.forceUpdate();
		});
	}

	public componentWillUnmount(): void {
		this.props.material.onBuildObservable.remove(this._buildObserver);
	}

	private async _openNodeMaterialEditor(): Promise<void> {
		// TODO: Unfortunately we need to search for the material file in the project so it will be
		// edited for the NME. Try to keep the material file somewhere to avoid searching for it each time.
		this.setState({
			searchingToEdit: true,
		});

		const projectPath = dirname(projectConfiguration.path!);
		const materialFiles = await normalizedGlob(join(projectPath, "assets/**/*.material"), {
			nodir: true,
		});

		for (const filePath of materialFiles) {
			try {
				const data = await readJSON(filePath as string, {
					encoding: "utf-8",
				});

				if (data.customType === "BABYLON.NodeMaterial" && data.uniqueId === this.props.material.uniqueId) {
					ipcRenderer.send("window:open", "build/src/editor/windows/nme", {
						filePath,
						rootUrl: getProjectAssetsRootUrl() ?? undefined,
					});

					break;
				}
			} catch (e) {
				// Catch silently
			}
		}

		this.setState({
			searchingToEdit: false,
		});
	}

	private _validateGraph(): void {
		this.setState({ validating: true });
		try {
			const result = validateNodeMaterialGraph(this.props.material.getScene(), { materialId: this.props.material.id });
			if (result.valid) {
				toast.success(`Node Material valid${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : ""}.`);
			} else {
				toast.error(result.errors.join("\n"));
			}
		} finally {
			this.setState({ validating: false });
		}
	}

	private _stripUnusedBlocks(): void {
		this.setState({ stripping: true });
		try {
			const result = stripNodeMaterialUnusedBlocks(this.props.material.getScene(), { materialId: this.props.material.id }, {
				editor: { layout: { inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined } } },
			} as any);
			this.forceUpdate();
			toast.success(
				result.removed.length ? `Removed ${result.removed.length} unused graph block${result.removed.length === 1 ? "" : "s"}.` : "No unused graph blocks found."
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not strip unused graph blocks.");
		} finally {
			this.setState({ stripping: false });
		}
	}

	private _getCustomBlockAuthoring(): ReactNode {
		const blocks = listNodeMaterialCustomBlocks(this.props.material.getScene(), { materialId: this.props.material.id }).blocks;
		return (
			<EditorInspectorSectionField
				title="Custom Shader Blocks"
				tooltip="Add trusted GLSL CustomBlocks to this Node Material. Wire their inputs and outputs in the Node Material Editor after creation."
			>
				{blocks.map((block: any) => (
					<div key={block.name} className="flex items-center justify-between gap-2 rounded-md bg-muted p-2 text-sm">
						<div className="min-w-0">
							<div className="truncate font-medium">{block.name}</div>
							<div className="truncate text-xs text-muted-foreground">
								{block.target} · {block.functionName}
							</div>
						</div>
						<Button size="sm" variant="ghost" className="hover:bg-destructive" onClick={() => this._deleteCustomBlock(block.name)}>
							Remove
						</Button>
					</div>
				))}
				<label className="flex flex-col gap-1 text-sm">
					Name
					<input
						className="h-9 rounded-md border border-input bg-background px-3"
						value={this.state.customBlockName}
						onChange={(event) => this.setState({ customBlockName: event.currentTarget.value })}
						placeholder="doubleValue"
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					Function Signature
					<input
						className="h-9 rounded-md border border-input bg-background px-3 font-mono text-xs"
						value={this.state.customBlockFunctionName}
						onChange={(event) => this.setState({ customBlockFunctionName: event.currentTarget.value })}
						placeholder="void doubleValue(float value, out float result)"
					/>
				</label>
				<div className="grid grid-cols-2 gap-2">
					<label className="flex flex-col gap-1 text-sm">
						Inputs (name:type)
						<input
							className="h-9 rounded-md border border-input bg-background px-3 font-mono text-xs"
							value={this.state.customBlockInputs}
							onChange={(event) => this.setState({ customBlockInputs: event.currentTarget.value })}
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						Outputs (name:type)
						<input
							className="h-9 rounded-md border border-input bg-background px-3 font-mono text-xs"
							value={this.state.customBlockOutputs}
							onChange={(event) => this.setState({ customBlockOutputs: event.currentTarget.value })}
						/>
					</label>
				</div>
				<select
					className="h-9 rounded-md border border-input bg-background px-3 text-sm"
					value={this.state.customBlockTarget}
					onChange={(event) => this.setState({ customBlockTarget: event.currentTarget.value as IEditorNodeMaterialInspectorState["customBlockTarget"] })}
				>
					<option value="Fragment">Fragment</option>
					<option value="Vertex">Vertex</option>
					<option value="VertexAndFragment">Vertex and Fragment</option>
				</select>
				<label className="flex flex-col gap-1 text-sm">
					GLSL Function
					<textarea
						className="min-h-28 rounded-md border border-input bg-background p-2 font-mono text-xs"
						value={this.state.customBlockCode}
						onChange={(event) => this.setState({ customBlockCode: event.currentTarget.value })}
						placeholder="void doubleValue(float value, out float result) { result = value * 2.0; }"
					/>
				</label>
				<Button variant="secondary" className="w-full" onClick={() => this._addCustomBlock()}>
					Add Custom Block
				</Button>
			</EditorInspectorSectionField>
		);
	}

	private _parseCustomBlockParameters(value: string): Array<{ name: string; type: string }> {
		return value
			.split(",")
			.map((parameter) => parameter.trim())
			.filter(Boolean)
			.map((parameter) => {
				const [name, type, ...extra] = parameter.split(":").map((part) => part.trim());
				if (!name || !type || extra.length) {
					throw new Error('Parameters use comma-separated "name:type" entries.');
				}
				return { name, type };
			});
	}

	private _addCustomBlock(): void {
		try {
			addNodeMaterialCustomBlock(
				this.props.material.getScene(),
				{
					materialId: this.props.material.id,
					name: this.state.customBlockName,
					functionName: this.state.customBlockFunctionName,
					code: this.state.customBlockCode,
					inputs: this._parseCustomBlockParameters(this.state.customBlockInputs),
					outputs: this._parseCustomBlockParameters(this.state.customBlockOutputs),
					target: this.state.customBlockTarget,
				},
				{ editor: { layout: { inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined } } } } as any
			);
			this.setState({ customBlockName: "", customBlockFunctionName: "", customBlockCode: "" });
			toast.success("Custom shader block added. Wire it in the Node Material Editor.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not add the custom shader block.");
		}
	}

	private _deleteCustomBlock(name: string): void {
		try {
			deleteNodeMaterialCustomBlock(this.props.material.getScene(), { materialId: this.props.material.id, name }, {
				editor: { layout: { inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined } } },
			} as any);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not remove the custom shader block.");
		}
	}

	private _getTextureBlocks(): ReactNode[] {
		const result: ReactNode[] = [];

		const textureBlocks = this.props.material.getAllTextureBlocks();

		if (textureBlocks.length > 0) {
			result.push(
				<EditorInspectorSectionField key="textures" title="Textures">
					{textureBlocks.map((block) => (
						<EditorInspectorTextureField
							scene={this.props.material.getScene()}
							key={block.name}
							object={block}
							property="texture"
							title={block.name}
							hideLevel
							hideSize
						/>
					))}
				</EditorInspectorSectionField>
			);
		}

		return result;
	}

	private _getEditableBlocks(): ReactNode[] {
		const result: ReactNode[] = [];

		const uniforms = this.props.material.getInputBlocks().filter((b) => b.visibleInInspector);
		if (!uniforms.length) {
			return result;
		}

		// Build groups
		const groupsDictionary: Record<string, InputBlock[]> = {};
		uniforms.forEach((uniform) => {
			const group = uniform.groupInInspector ?? "";

			if (!groupsDictionary[group]) {
				groupsDictionary[group] = [];
			}

			groupsDictionary[group].push(uniform);
		});

		const keys = sortAlphabetically(Object.keys(groupsDictionary));

		return keys.map((key) => {
			const group = groupsDictionary[key];
			const blackboard = (this.props.material.metadata?.babylonEditorShaderBlackboard ?? []) as any[];

			return (
				<EditorInspectorSectionField key={key} title={key || "No Group"}>
					{group?.map((uniform) => {
						const uniformKey = `${uniform.uniqueId}:${uniform.name}`;
						const parameter = blackboard.find((candidate) => candidate.inputName === uniform.name);
						if (parameter?.connectorEnabled === false) {
							return (
								<div key={uniformKey} className="flex items-center justify-between gap-2 px-2 py-1 text-sm" title={parameter.description}>
									<span>{parameter.label ?? uniform.name}</span>
									<span className="rounded bg-muted px-2 py-1 font-mono text-xs">Static · {JSON.stringify(parameter.staticValue ?? uniform.value)}</span>
								</div>
							);
						}
						switch (uniform.type) {
							case NodeMaterialBlockConnectionPointTypes.Float:
							case NodeMaterialBlockConnectionPointTypes.Int:
								if (parameter?.floatMode === "enum") {
									return (
										<label key={uniformKey} className="flex items-center justify-between gap-2 px-2 text-sm">
											<span title={parameter.description}>{parameter.label ?? uniform.name}</span>
											<select
												className="h-9 min-w-32 rounded-md border border-input bg-background px-2"
												value={uniform.value}
												onChange={(event) => {
													uniform.value = Number(event.currentTarget.value);
													this.forceUpdate();
												}}
											>
												{parameter.enumOptions?.map((option: any) => (
													<option key={`${option.label}:${option.value}`} value={option.value}>
														{option.label}
													</option>
												))}
											</select>
										</label>
									);
								}
								if (parameter?.floatMode === "slider" && Number.isFinite(parameter.min) && Number.isFinite(parameter.max)) {
									return (
										<EditorInspectorSliderField
											key={uniformKey}
											object={uniform}
											property="value"
											label={parameter.label ?? uniform.name}
											min={parameter.min}
											max={parameter.max}
											defaultValue={parameter.defaultValue}
											tooltip={parameter.description ?? uniform.comments}
										/>
									);
								}
								return (
									<EditorInspectorNumberField
										key={uniformKey}
										object={uniform}
										property="value"
										label={parameter?.label ?? uniform.name}
										min={uniform.min}
										max={uniform.max}
										step={uniform.type === NodeMaterialBlockConnectionPointTypes.Int || parameter?.floatMode === "integer" ? 1 : 0.01}
										tooltip={parameter?.description ?? uniform.comments}
									/>
								);

							case NodeMaterialBlockConnectionPointTypes.Vector2:
							case NodeMaterialBlockConnectionPointTypes.Vector3:
							case NodeMaterialBlockConnectionPointTypes.Vector4:
								return <EditorInspectorVectorField key={uniformKey} object={uniform} property="value" label={uniform.name} tooltip={uniform.comments} />;

							case NodeMaterialBlockConnectionPointTypes.Color3:
							case NodeMaterialBlockConnectionPointTypes.Color4:
								return <EditorInspectorColorField key={uniformKey} object={uniform} property="value" label={uniform.name} tooltip={uniform.comments} />;

							default:
								return null;
						}
					})}
				</EditorInspectorSectionField>
			);
		});
	}
}
