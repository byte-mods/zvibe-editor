import { extname, join, dirname } from "path/posix";

import { toast } from "sonner";
import { Component, DragEvent, ReactNode } from "react";

import { Editor } from "../../../main";

import { addGameObjectComponent, inspectGameObjectComponents, removeGameObjectComponent } from "../../../../mcp/components/components";

import { EditorInspectorSectionField } from "../fields/section";
import { PrefabFieldOverrideDecorator } from "../prefab-property-overrides";

import { InspectorScriptField } from "./field";

export interface IScriptInspectorComponent {
	object: any;
	editor: Editor;
}

export interface IScriptInspectorComponentState {
	dragOver: boolean;
	scriptFound: boolean;
}

export class ScriptInspectorComponent extends Component<IScriptInspectorComponent, IScriptInspectorComponentState> {
	public constructor(props: IScriptInspectorComponent) {
		super(props);

		this.state = {
			dragOver: false,
			scriptFound: true,
		};
	}

	public render(): ReactNode {
		return (
			<EditorInspectorSectionField title="Scripts">
				<PrefabFieldOverrideDecorator object={this.props.object} property="metadata.scripts">
					{this.props.object.metadata?.scripts?.map((script: any, index: number) => {
						const scriptId = script._id ?? `${script.key}:${index}`;

						return (
							<InspectorScriptField
								key={scriptId}
								script={script}
								scriptIndex={index}
								editor={this.props.editor}
								object={this.props.object}
								onRemove={() => this._handleRemoveScript(index)}
							/>
						);
					})}

					{this._getEmptyComponent()}
				</PrefabFieldOverrideDecorator>
			</EditorInspectorSectionField>
		);
	}

	private _handleRemoveScript(index: number): void {
		const script = this.props.object.metadata?.scripts?.[index];
		if (!script) {
			return;
		}
		try {
			const inspection = inspectGameObjectComponents(this.props.object.getScene(), { nodeId: this.props.object.id });
			const component = inspection.components.find((candidate: any) => candidate.type === "script" && candidate.data?.path === `src/${script.key}`);
			if (!component) {
				throw new Error(`The component row for script "${script.key}" was not found.`);
			}
			removeGameObjectComponent(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId: component.id },
				{ editor: this.props.editor }
			);
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _getEmptyComponent(): ReactNode {
		return (
			<div
				onDrop={(ev) => this._handleDropEmptyComponent(ev)}
				onDragLeave={() => this.setState({ dragOver: false })}
				onDragOver={(ev) => this._handleDragOverEmptyComponent(ev)}
				className={`flex flex-col justify-center items-center w-full h-[64px] rounded-lg border-[1px] border-secondary-foreground/35 border-dashed ${this.state.dragOver ? "bg-secondary-foreground/35" : ""} transition-all duration-300 ease-in-out`}
			>
				<div className="font-semibold text-muted-foreground">Drag'n'drop a script here</div>
			</div>
		);
	}

	private _handleDragOverEmptyComponent(ev: DragEvent<HTMLDivElement>): void {
		ev.preventDefault();
		ev.stopPropagation();

		this.setState({ dragOver: true });
	}

	private _handleDropEmptyComponent(ev: DragEvent<HTMLDivElement>): void {
		ev.preventDefault();
		ev.stopPropagation();

		this.setState({ dragOver: false });

		if (!this.props.editor.state.projectPath) {
			return;
		}

		const absolutePaths = JSON.parse(ev.dataTransfer.getData("assets")) as string[];
		if (!Array.isArray(absolutePaths)) {
			return;
		}

		const files = absolutePaths.filter((path) => {
			const extension = extname(path).toLowerCase();
			return extension === ".ts" || extension === ".tsx";
		});

		if (!files.length) {
			return;
		}

		const projectDir = dirname(this.props.editor.state.projectPath!);

		files.forEach((file) => {
			const relativePath = file.replace(join(projectDir, "/src/"), "").replace(/\\/g, "/");
			if (relativePath === file) {
				return;
			}

			if (this.props.object.metadata?.scripts?.find((script) => script.key === relativePath)) {
				return toast.warning(`Script '${relativePath}' is already attached to the object.`);
			}

			try {
				const inspection = inspectGameObjectComponents(this.props.object.getScene(), { nodeId: this.props.object.id });
				addGameObjectComponent(
					this.props.object.getScene(),
					{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, type: "script", path: `src/${relativePath}` },
					{ editor: this.props.editor }
				);
			} catch (error: any) {
				toast.error(error.message);
			}
		});

		this.forceUpdate();
	}
}
