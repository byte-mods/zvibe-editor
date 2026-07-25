import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { Node } from "babylonjs";

import { Editor } from "../../../main";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import { Textarea } from "../../../../ui/shadcn/ui/textarea";

import {
	addGameObjectComponent,
	copyGameObjectComponent,
	inspectGameObjectComponents,
	listGameObjectComponentTypes,
	moveGameObjectComponent,
	pasteGameObjectComponent,
	removeGameObjectComponent,
	resetGameObjectComponent,
	setGameObjectComponent,
} from "../../../../mcp/components/components";

import { EditorInspectorSectionField } from "../fields/section";
import { PrefabFieldOverrideDecorator } from "../prefab-property-overrides";

export interface IGameObjectComponentsInspectorProps {
	object: Node;
	editor: Editor;
}

interface IGameObjectComponentsInspectorState {
	addType: "data" | "script" | "physics3d";
	addName: string;
	addScriptPath: string;
}

export class GameObjectComponentsInspector extends Component<IGameObjectComponentsInspectorProps, IGameObjectComponentsInspectorState> {
	public constructor(props: IGameObjectComponentsInspectorProps) {
		super(props);
		this.state = { addType: "data", addName: "Data Component", addScriptPath: "src/" };
	}

	public render(): ReactNode {
		let inspection: any;
		let types: any[];
		try {
			inspection = inspectGameObjectComponents(this.props.object.getScene(), { nodeId: this.props.object.id });
			types = listGameObjectComponentTypes(this.props.object.getScene(), { nodeId: this.props.object.id }).types.filter((type: any) => type.type !== "transform");
		} catch (error: any) {
			return (
				<EditorInspectorSectionField title="Component Stack">
					<div className="px-2 py-2 text-xs text-destructive">{error.message}</div>
				</EditorInspectorSectionField>
			);
		}

		return (
			<EditorInspectorSectionField
				title="Component Stack"
				tooltip="Unity-style ordered component lifecycle. Transform is required; scripts and physics are adapters over their existing real runtime systems."
			>
				<PrefabFieldOverrideDecorator object={this.props.object} property="metadata.babylonEditorComponentStack">
					<div className="flex flex-col gap-2 px-1">
						{inspection.components.map((component: any) => this._getComponentCard(component, inspection))}
						<div className="flex flex-col gap-2 rounded-md border border-border p-2">
							<div className="text-xs font-semibold">Add Component</div>
							<select
								value={this.state.addType}
								onChange={(event) => this.setState({ addType: event.currentTarget.value as IGameObjectComponentsInspectorState["addType"] })}
								className="h-8 rounded-md border border-input bg-background px-2 text-xs"
							>
								{types.map((type: any) => (
									<option key={type.type} value={type.type} disabled={!type.canAdd}>
										{type.label}
										{type.canAdd ? "" : " (already present or unsupported)"}
									</option>
								))}
							</select>
							{this.state.addType === "data" && (
								<Input
									value={this.state.addName}
									maxLength={80}
									onChange={(event) => this.setState({ addName: event.currentTarget.value })}
									placeholder="Component name"
								/>
							)}
							{this.state.addType === "script" && (
								<Input
									value={this.state.addScriptPath}
									onChange={(event) => this.setState({ addScriptPath: event.currentTarget.value })}
									placeholder="src/components/player.ts"
								/>
							)}
							<Button
								size="sm"
								variant="secondary"
								onClick={() => this._addComponent(inspection)}
								disabled={!types.find((type: any) => type.type === this.state.addType)?.canAdd}
							>
								Add Component
							</Button>
							{inspection.clipboard && inspection.clipboard.type !== "transform" && (
								<Button size="sm" variant="outline" onClick={() => this._pasteNew(inspection)}>
									Paste Component As New
								</Button>
							)}
						</div>
					</div>
				</PrefabFieldOverrideDecorator>
			</EditorInspectorSectionField>
		);
	}

	private _getComponentCard(component: any, inspection: any): ReactNode {
		const lastOrder = inspection.components.length - 1;
		const clipboardMatches = inspection.clipboard?.type === component.type;
		return (
			<div key={component.id} className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<div className="truncate text-xs font-semibold">{component.label}</div>
						<div className="text-[10px] text-muted-foreground">
							#{component.order} · {component.type}
						</div>
					</div>
					{component.canToggle && (
						<label className="flex items-center gap-1 text-[10px]">
							<input
								type="checkbox"
								checked={component.enabled}
								onChange={(event) => this._setComponent(inspection, component.id, { enabled: event.currentTarget.checked })}
							/>
							Enabled
						</label>
					)}
				</div>

				{component.type === "data" && (
					<>
						<Input
							defaultValue={component.data.name}
							maxLength={80}
							onBlur={(event) => {
								if (event.currentTarget.value !== component.data.name) {
									this._setComponent(this._inspect(), component.id, { name: event.currentTarget.value });
								}
							}}
						/>
						<Textarea
							defaultValue={JSON.stringify(component.data.values, null, 2)}
							className="min-h-20 font-mono text-[10px]"
							onBlur={(event) => this._setJsonValues(component, event.currentTarget.value)}
						/>
					</>
				)}
				{component.type === "script" && component.data && (
					<div className="flex flex-col gap-1 text-[10px] text-muted-foreground">
						<div className="truncate">{component.data.path}</div>
						<label className="flex items-center gap-2">
							<span>Execution order</span>
							<Input
								type="number"
								min={-32000}
								max={32000}
								defaultValue={component.data.executionOrder}
								className="h-7"
								onBlur={(event) => {
									const executionOrder = Number(event.currentTarget.value);
									if (executionOrder !== component.data.executionOrder) {
										this._setComponent(this._inspect(), component.id, { script: { executionOrder } });
									}
								}}
							/>
						</label>
					</div>
				)}
				{component.type === "physics3d" && component.data && (
					<div className="text-[10px] text-muted-foreground">
						Mass {component.data.massProperties?.mass ?? 0} · Shape {component.data.shape?.type} · Motion {component.data.body?.motionType}
					</div>
				)}

				<div className="flex flex-wrap gap-1">
					{component.order > 1 && (
						<Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => this._moveComponent(inspection, component.id, component.order - 1)}>
							↑
						</Button>
					)}
					{component.order > 0 && component.order < lastOrder && (
						<Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => this._moveComponent(inspection, component.id, component.order + 1)}>
							↓
						</Button>
					)}
					<Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => this._resetComponent(inspection, component.id)}>
						Reset
					</Button>
					<Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => this._copyComponent(inspection, component.id)}>
						Copy
					</Button>
					{clipboardMatches && (
						<Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => this._pasteValues(inspection, component.id)}>
							Paste Values
						</Button>
					)}
					{component.removable && (
						<Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-destructive" onClick={() => this._removeComponent(inspection, component)}>
							Remove
						</Button>
					)}
				</div>
			</div>
		);
	}

	private _inspect(): any {
		return inspectGameObjectComponents(this.props.object.getScene(), { nodeId: this.props.object.id });
	}

	private _run(action: () => void): void {
		try {
			action();
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _addComponent(inspection: any): void {
		this._run(() => {
			addGameObjectComponent(
				this.props.object.getScene(),
				{
					nodeId: this.props.object.id,
					expectedFingerprint: inspection.fingerprint,
					type: this.state.addType,
					name: this.state.addType === "data" ? this.state.addName : undefined,
					path: this.state.addType === "script" ? this.state.addScriptPath : undefined,
				},
				{ editor: this.props.editor }
			);
		});
	}

	private _setComponent(inspection: any, componentId: string, values: any): void {
		this._run(() =>
			setGameObjectComponent(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId, ...values },
				{ editor: this.props.editor }
			)
		);
	}

	private _setJsonValues(component: any, text: string): void {
		this._run(() => {
			const values = JSON.parse(text);
			this._setComponent(this._inspect(), component.id, { values });
		});
	}

	private _moveComponent(inspection: any, componentId: string, targetOrder: number): void {
		this._run(() =>
			moveGameObjectComponent(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId, targetOrder },
				{ editor: this.props.editor }
			)
		);
	}

	private _removeComponent(inspection: any, component: any): void {
		this._run(() =>
			removeGameObjectComponent(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId: component.id, cascade: component.dependentIds.length > 0 },
				{ editor: this.props.editor }
			)
		);
	}

	private _resetComponent(inspection: any, componentId: string): void {
		this._run(() =>
			resetGameObjectComponent(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId },
				{ editor: this.props.editor }
			)
		);
	}

	private _copyComponent(inspection: any, componentId: string): void {
		this._run(() => copyGameObjectComponent(this.props.object.getScene(), { nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId }));
	}

	private _pasteValues(inspection: any, componentId: string): void {
		this._run(() => {
			if (!inspection.clipboard) {
				throw new Error("The component clipboard is empty.");
			}
			pasteGameObjectComponent(
				this.props.object.getScene(),
				{
					nodeId: this.props.object.id,
					expectedFingerprint: inspection.fingerprint,
					expectedClipboardFingerprint: inspection.clipboard.fingerprint,
					mode: "values",
					componentId,
				},
				{ editor: this.props.editor }
			);
		});
	}

	private _pasteNew(inspection: any): void {
		this._run(() => {
			if (!inspection.clipboard) {
				throw new Error("The component clipboard is empty.");
			}
			pasteGameObjectComponent(
				this.props.object.getScene(),
				{
					nodeId: this.props.object.id,
					expectedFingerprint: inspection.fingerprint,
					expectedClipboardFingerprint: inspection.clipboard.fingerprint,
					mode: "new",
				},
				{ editor: this.props.editor }
			);
		});
	}
}
