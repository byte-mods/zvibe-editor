import { readJSON } from "fs-extra";
import { ipcRenderer } from "electron";
import { dirname, join } from "path/posix";

import { Component, ReactNode } from "react";

import { Grid } from "react-loader-spinner";

import { toast } from "sonner";

import { AbstractMesh, NodeMaterial, Observer, InputBlock, NodeMaterialBlockConnectionPointTypes } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";

import { normalizedGlob } from "../../../../tools/fs";
import { sortAlphabetically } from "../../../../tools/tools";

import { getProjectAssetsRootUrl, projectConfiguration } from "../../../../project/configuration";

import {
	addNodeMaterialCustomBlock,
	deleteNodeMaterialCustomBlock,
	listNodeMaterialCustomBlocks,
	stripNodeMaterialUnusedBlocks,
	validateNodeMaterialGraph,
} from "../../../../mcp/materials/materials";

import { EditorInspectorColorField } from "../fields/color";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorVectorField } from "../fields/vector";
import { EditorInspectorNumberField } from "../fields/number";
import { EditorInspectorSectionField } from "../fields/section";

import { EditorMaterialInspectorUtilsComponent } from "./components/utils";
import { EditorInspectorTextureField } from "../fields/texture";

export interface IEditorNodeMaterialInspectorProps {
	mesh?: AbstractMesh;
	material: NodeMaterial;
}

export interface IEditorNodeMaterialInspectorState {
	searchingToEdit: boolean;
	validating: boolean;
	stripping: boolean;
	customBlockName: string;
	customBlockFunctionName: string;
	customBlockCode: string;
	customBlockInputs: string;
	customBlockOutputs: string;
	customBlockTarget: "Vertex" | "Fragment" | "VertexAndFragment";
}

export class EditorNodeMaterialInspector extends Component<IEditorNodeMaterialInspectorProps, IEditorNodeMaterialInspectorState> {
	private _buildObserver: Observer<NodeMaterial> | null = null;

	public constructor(props: IEditorNodeMaterialInspectorProps) {
		super(props);

		this.state = {
			searchingToEdit: false,
			validating: false,
			stripping: false,
			customBlockName: "",
			customBlockFunctionName: "",
			customBlockCode: "",
			customBlockInputs: "value:Float",
			customBlockOutputs: "result:Float",
			customBlockTarget: "Fragment",
		};
	}

	public render(): ReactNode {
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
				{this._getTextureBlocks()}
				{this._getCustomBlockAuthoring()}
				{this._getEditableBlocks()}
			</>
		);
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
			if (result.valid)
				toast.success(`Node Material valid${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : ""}.`);
			else toast.error(result.errors.join("\n"));
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
				if (!name || !type || extra.length) throw new Error('Parameters use comma-separated "name:type" entries.');
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

			return (
				<EditorInspectorSectionField key={key} title={key || "No Group"}>
					{group?.map((uniform) => {
						switch (uniform.type) {
							case NodeMaterialBlockConnectionPointTypes.Float:
							case NodeMaterialBlockConnectionPointTypes.Int:
								return (
									<EditorInspectorNumberField
										object={uniform}
										property="value"
										label={uniform.name}
										min={uniform.min}
										max={uniform.max}
										step={uniform.type === NodeMaterialBlockConnectionPointTypes.Int ? 1 : 0.01}
										tooltip={uniform.comments}
									/>
								);

							case NodeMaterialBlockConnectionPointTypes.Vector2:
							case NodeMaterialBlockConnectionPointTypes.Vector3:
							case NodeMaterialBlockConnectionPointTypes.Vector4:
								return <EditorInspectorVectorField object={uniform} property="value" label={uniform.name} tooltip={uniform.comments} />;

							case NodeMaterialBlockConnectionPointTypes.Color3:
							case NodeMaterialBlockConnectionPointTypes.Color4:
								return <EditorInspectorColorField object={uniform} property="value" label={uniform.name} tooltip={uniform.comments} />;

							default:
								return null;
						}
					})}
				</EditorInspectorSectionField>
			);
		});
	}
}
