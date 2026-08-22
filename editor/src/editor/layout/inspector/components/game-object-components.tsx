import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { Node } from "babylonjs";
import {
	IECSComponentTypeDefinition,
	IECSFieldDefinition,
	getECSFieldArity,
	getSceneECSConfiguration,
	listLight2DProviderTypes,
	listShadowShape2DProviderTypes,
} from "babylonjs-editor-tools";

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
	addType: "data" | "script" | "physics3d" | "network" | "entity" | "light2d" | "shadowcaster2d";
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
				tooltip="Unity-style ordered component lifecycle. Transform is required; scripts, physics, 2D lights, and 2D shadow providers use their real runtime systems."
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
				{component.type === "network" && component.data && this._getNetworkAuthoring(component)}
				{component.type === "entity" && component.data && this._getEntityAuthoring(component)}
				{component.type === "light2d" && component.data && this._getLight2DAuthoring(component)}
				{component.type === "shadowcaster2d" && component.data && this._getShadowCaster2DAuthoring(component)}

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

	private _getNetworkAuthoring(component: any): ReactNode {
		return (
			<div className="flex flex-col gap-2 rounded border border-border/70 p-2">
				<label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
					Network id
					<Input
						key={component.data.networkId}
						className="h-7 font-mono text-[10px]"
						defaultValue={component.data.networkId}
						maxLength={128}
						onBlur={(event) => {
							const networkId = event.currentTarget.value.trim();
							if (networkId && networkId !== component.data.networkId) {
								this._updateNetwork(component.id, { networkId });
							}
						}}
					/>
				</label>
				<label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
					Authority
					<select
						className="h-7 rounded border border-input bg-background px-2"
						value={component.data.authority}
						onChange={(event) => this._updateNetwork(component.id, { authority: event.currentTarget.value })}
					>
						<option value="server">Server authoritative</option>
						<option value="owner">Owner authoritative</option>
					</select>
				</label>
				<label className="flex items-center justify-between gap-2 text-[10px]">
					Sync transform
					<input
						type="checkbox"
						checked={component.data.syncTransform}
						onChange={(event) => this._updateNetwork(component.id, { syncTransform: event.currentTarget.checked })}
					/>
				</label>
				<label className="flex items-center justify-between gap-2 text-[10px]">
					Sync animation groups
					<input
						type="checkbox"
						checked={component.data.syncAnimation}
						onChange={(event) => this._updateNetwork(component.id, { syncAnimation: event.currentTarget.checked })}
					/>
				</label>
				<label className="flex items-center justify-between gap-2 text-[10px]">
					Interpolate remote transforms
					<input
						type="checkbox"
						checked={component.data.interpolate}
						onChange={(event) => this._updateNetwork(component.id, { interpolate: event.currentTarget.checked })}
					/>
				</label>
				<label className="grid grid-cols-[1fr_100px] items-center gap-2 text-[10px] text-muted-foreground">
					Send rate (Hz)
					<Input
						key={component.data.sendRateHz}
						type="number"
						min={1}
						max={120}
						defaultValue={component.data.sendRateHz}
						className="h-7"
						onBlur={(event) => {
							const sendRateHz = Number(event.currentTarget.value);
							if (Number.isFinite(sendRateHz) && sendRateHz !== component.data.sendRateHz) {
								this._updateNetwork(component.id, { sendRateHz });
							}
						}}
					/>
				</label>
			</div>
		);
	}

	private _updateNetwork(componentId: string, changes: Record<string, unknown>): void {
		this._run(() => {
			const inspection = this._inspect();
			const component = inspection.components.find((entry: any) => entry.id === componentId && entry.type === "network");
			if (!component) {
				throw new Error("Network Replication component changed or was removed. Re-inspect the node.");
			}
			setGameObjectComponent(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId, data: { ...component.data, ...changes } },
				{ editor: this.props.editor }
			);
		});
	}

	private _getLight2DAuthoring(component: any): ReactNode {
		const customProviders = listLight2DProviderTypes().filter((provider) => !provider.builtIn);
		return (
			<div className="flex flex-col gap-2 rounded border border-border/70 p-2">
				<label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
					Light type
					<select
						className="h-7 rounded border border-input bg-background px-2"
						value={component.data.lightType}
						onChange={(event) => {
							const lightType = event.currentTarget.value;
							this._updateLighting2D(component.id, {
								lightType,
								providerId: lightType === "provider" ? (customProviders[0]?.id ?? "project.light2d") : `builtin.${lightType}`,
								providerVersion: lightType === "provider" ? (customProviders[0]?.dataVersion ?? 1) : 1,
								providerData: lightType === "provider" ? (customProviders[0]?.defaultData ?? {}) : {},
							});
						}}
					>
						<option value="global">Global</option>
						<option value="point">Point</option>
						<option value="freeform">Freeform</option>
						<option value="sprite">Sprite bounds</option>
						<option value="provider">Custom provider</option>
					</select>
				</label>
				{component.data.lightType === "provider" && (
					<>
						<label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
							Provider
							<select
								className="h-7 min-w-40 rounded border border-input bg-background px-2"
								value={component.data.providerId}
								onChange={(event) => {
									const provider = customProviders.find((entry) => entry.id === event.currentTarget.value);
									if (provider) {
										this._updateLighting2D(component.id, {
											providerId: provider.id,
											providerVersion: provider.dataVersion,
											providerData: provider.defaultData,
										});
									}
								}}
							>
								{!customProviders.length && <option value={component.data.providerId}>No project provider registered</option>}
								{customProviders.map((provider) => (
									<option key={provider.id} value={provider.id}>
										{provider.displayName} · v{provider.dataVersion}
									</option>
								))}
							</select>
						</label>
						{this._getLightingJsonField(component, "Provider data", "providerData")}
					</>
				)}
				<label className="grid grid-cols-[1fr_2fr] items-center gap-2 text-[10px] text-muted-foreground">
					RGBA
					<Input
						className="h-7 font-mono text-[10px]"
						defaultValue={component.data.color.join(", ")}
						onBlur={(event) => this._updateNumberArray(component.id, "color", event.currentTarget.value, 4)}
					/>
				</label>
				{this._getLightingNumberField(component, "Intensity", "intensity", 0, 64, 0.05)}
				{component.data.lightType === "point" && (
					<>
						{this._getLightingNumberField(component, "Inner radius", "innerRadius", 0, 1000000, 1)}
						{this._getLightingNumberField(component, "Outer radius", "outerRadius", 0.001, 1000000, 1)}
						{this._getLightingNumberField(component, "Inner angle", "innerAngleDegrees", 0, 360, 1)}
						{this._getLightingNumberField(component, "Outer angle", "outerAngleDegrees", 0.001, 360, 1)}
					</>
				)}
				{component.data.lightType === "freeform" && this._getLightingJsonField(component, "Shape path [[x,y], ...]", "shapePath")}
				{this._getLightingNumberField(component, "Falloff", "falloffIntensity", 0, 1, 0.05)}
				{this._getLightingNumberField(component, "Light order", "lightOrder", -32000, 32000, 1)}
				<label className="flex items-center justify-between gap-2 text-[10px]">
					Cast shadows
					<input
						type="checkbox"
						checked={component.data.shadowsEnabled}
						onChange={(event) => this._updateLighting2D(component.id, { shadowsEnabled: event.currentTarget.checked })}
					/>
				</label>
				{component.data.shadowsEnabled && this._getLightingNumberField(component, "Shadow intensity", "shadowIntensity", 0, 1, 0.05)}
				{this._getSortingLayersField(component)}
			</div>
		);
	}

	private _getShadowCaster2DAuthoring(component: any): ReactNode {
		const customProviders = listShadowShape2DProviderTypes().filter((provider) => !provider.builtIn);
		return (
			<div className="flex flex-col gap-2 rounded border border-border/70 p-2">
				<label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
					Shape source
					<select
						className="h-7 rounded border border-input bg-background px-2"
						value={component.data.sourceType}
						onChange={(event) => {
							const sourceType = event.currentTarget.value;
							this._updateLighting2D(component.id, {
								sourceType,
								providerId: sourceType === "provider" ? (customProviders[0]?.id ?? "project.shadow2d") : `builtin.${sourceType}`,
								providerVersion: sourceType === "provider" ? (customProviders[0]?.dataVersion ?? 1) : 1,
								providerData: sourceType === "provider" ? (customProviders[0]?.defaultData ?? {}) : {},
							});
						}}
					>
						<option value="shape-editor">Shape editor</option>
						<option value="node-bounds">Node bounds</option>
						<option value="provider">Custom provider</option>
					</select>
				</label>
				{component.data.sourceType === "provider" && (
					<>
						<label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
							Provider
							<select
								className="h-7 min-w-40 rounded border border-input bg-background px-2"
								value={component.data.providerId}
								onChange={(event) => {
									const provider = customProviders.find((entry) => entry.id === event.currentTarget.value);
									if (provider) {
										this._updateLighting2D(component.id, {
											providerId: provider.id,
											providerVersion: provider.dataVersion,
											providerData: provider.defaultData,
										});
									}
								}}
							>
								{!customProviders.length && <option value={component.data.providerId}>No project provider registered</option>}
								{customProviders.map((provider) => (
									<option key={provider.id} value={provider.id}>
										{provider.displayName} · v{provider.dataVersion}
									</option>
								))}
							</select>
						</label>
						{this._getLightingJsonField(component, "Provider data", "providerData")}
					</>
				)}
				{component.data.sourceType === "shape-editor" && this._getLightingJsonField(component, "Shape path [[x,y], ...]", "shapePath")}
				<label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
					Casting
					<select
						className="h-7 rounded border border-input bg-background px-2"
						value={component.data.castingOption}
						onChange={(event) => this._updateLighting2D(component.id, { castingOption: event.currentTarget.value })}
					>
						<option value="cast-shadow">Cast shadow</option>
						<option value="self-shadow">Self shadow only</option>
						<option value="cast-and-self-shadow">Cast and self shadow</option>
						<option value="no-shadow">No shadow</option>
					</select>
				</label>
				{this._getLightingNumberField(component, "Priority", "priority", -32000, 32000, 1)}
				{this._getSortingLayersField(component)}
			</div>
		);
	}

	private _getLightingNumberField(component: any, label: string, field: string, minimum: number, maximum: number, step: number): ReactNode {
		return (
			<label className="grid grid-cols-[1fr_100px] items-center gap-2 text-[10px] text-muted-foreground">
				{label}
				<Input
					key={`${component.id}-${field}-${component.data[field]}`}
					type="number"
					min={minimum}
					max={maximum}
					step={step}
					defaultValue={component.data[field]}
					className="h-7"
					onBlur={(event) => {
						const value = Number(event.currentTarget.value);
						if (Number.isFinite(value) && value !== component.data[field]) {
							this._updateLighting2D(component.id, { [field]: value });
						}
					}}
				/>
			</label>
		);
	}

	private _getLightingJsonField(component: any, label: string, field: string): ReactNode {
		return (
			<label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
				{label}
				<Textarea
					key={`${component.id}-${field}-${JSON.stringify(component.data[field])}`}
					className="min-h-16 font-mono text-[10px]"
					defaultValue={JSON.stringify(component.data[field], null, 2)}
					onBlur={(event) => this._updateLightingJson(component.id, field, event.currentTarget.value)}
				/>
			</label>
		);
	}

	private _getSortingLayersField(component: any): ReactNode {
		return (
			<label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
				Target sorting-layer ids (empty means all)
				<Input
					className="h-7 font-mono text-[10px]"
					defaultValue={(component.data.targetSortingLayerIds ?? []).join(", ")}
					onBlur={(event) =>
						this._updateLighting2D(component.id, {
							targetSortingLayerIds: event.currentTarget.value
								.split(",")
								.map((entry) => entry.trim())
								.filter(Boolean),
						})
					}
				/>
			</label>
		);
	}

	private _updateNumberArray(componentId: string, field: string, text: string, length: number): void {
		const values = text.split(",").map((entry) => Number(entry.trim()));
		if (values.length !== length || values.some((entry) => !Number.isFinite(entry))) {
			toast.error(`${field} requires ${length} finite numeric values.`);
			return;
		}
		this._updateLighting2D(componentId, { [field]: values });
	}

	private _updateLightingJson(componentId: string, field: string, text: string): void {
		try {
			this._updateLighting2D(componentId, { [field]: JSON.parse(text) });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _updateLighting2D(componentId: string, changes: Record<string, unknown>): void {
		this._run(() => {
			const inspection = this._inspect();
			const component = inspection.components.find((entry: any) => entry.id === componentId && (entry.type === "light2d" || entry.type === "shadowcaster2d"));
			if (!component) {
				throw new Error("The 2D lighting component changed or was removed. Re-inspect the node.");
			}
			setGameObjectComponent(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId, data: { ...component.data, ...changes } },
				{ editor: this.props.editor }
			);
		});
	}

	private _getEntityAuthoring(component: any): ReactNode {
		const configuration = getSceneECSConfiguration(this.props.object.getScene(), false);
		const authoredComponents = component.data.components ?? {};
		return (
			<div className="flex flex-col gap-2 rounded border border-border/70 p-2">
				<label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
					Archetype label
					<Input
						className="h-7"
						defaultValue={component.data.archetype}
						maxLength={120}
						onBlur={(event) =>
							event.currentTarget.value !== component.data.archetype && this._updateEntity(component.id, (data) => (data.archetype = event.currentTarget.value))
						}
					/>
				</label>
				<label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
					Streaming section
					<select
						className="h-7 rounded border border-input bg-background px-2"
						value={component.data.sectionId}
						onChange={(event) => this._updateEntity(component.id, (data) => (data.sectionId = event.currentTarget.value))}
					>
						{configuration.sections.map((section) => (
							<option key={section.id} value={section.id}>
								{section.name}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-2 text-[10px]">
					<input
						type="checkbox"
						checked={component.data.bakingEnabled !== false}
						onChange={(event) => this._updateEntity(component.id, (data) => (data.bakingEnabled = event.currentTarget.checked))}
					/>{" "}
					Include in bake
				</label>
				<label className="flex items-center gap-2 text-[10px]" data-testid="ecs-hidden-entity-authoring">
					<input
						type="checkbox"
						checked={component.data.hiddenInHierarchy === true}
						onChange={(event) => this._updateEntity(component.id, (data) => (data.hiddenInHierarchy = event.currentTarget.checked))}
					/>{" "}
					Hidden in Hierarchy
				</label>
				{configuration.componentTypes
					.filter((definition) => !definition.builtIn)
					.map((definition) => this._getEntityComponentFields(component, definition, authoredComponents[definition.id]))}
				<div className="flex flex-col gap-1">
					<div className="text-[10px] font-semibold">Legacy numeric values</div>
					<Textarea
						className="min-h-14 font-mono text-[10px]"
						defaultValue={JSON.stringify(component.data.values ?? {}, null, 2)}
						onBlur={(event) => this._updateEntity(component.id, (data) => (data.values = JSON.parse(event.currentTarget.value)))}
					/>
				</div>
			</div>
		);
	}

	private _getEntityComponentFields(component: any, definition: IECSComponentTypeDefinition, values: Record<string, unknown> | undefined): ReactNode {
		return (
			<div key={definition.id} className="rounded border border-border bg-background/50 p-2">
				<div className="flex items-center justify-between gap-2">
					<div className="text-[10px] font-semibold">
						{definition.name} <span className="text-muted-foreground">({definition.id})</span>
					</div>
					<Button
						size="sm"
						variant={values ? "ghost" : "secondary"}
						className="h-6 px-2 text-[10px]"
						onClick={() => this._toggleEntityComponent(component.id, definition, !values)}
					>
						{values ? "Remove" : "Add"}
					</Button>
				</div>
				{values && (
					<div className="mt-2 grid gap-2">
						{definition.fields.map((field) => this._getEntityField(component.id, definition.id, field, values[field.id] ?? field.defaultValue))}
					</div>
				)}
			</div>
		);
	}

	private _getEntityField(componentId: string, schemaId: string, field: IECSFieldDefinition, value: unknown): ReactNode {
		if (field.type === "bool") {
			return (
				<label key={field.id} className="flex items-center justify-between gap-2 text-[10px]">
					<span>{field.name}</span>
					<input type="checkbox" checked={Boolean(value)} onChange={(event) => this._setEntityField(componentId, schemaId, field, event.currentTarget.checked)} />
				</label>
			);
		}
		const arity = getECSFieldArity(field.type);
		const formatted = Array.isArray(value) ? value.join(", ") : String(value);
		return (
			<label key={field.id} className="grid grid-cols-[minmax(70px,1fr)_2fr] items-center gap-2 text-[10px]">
				<span>
					{field.name} <span className="text-muted-foreground">{field.type}</span>
				</span>
				<Input
					className="h-7 font-mono text-[10px]"
					defaultValue={formatted}
					onBlur={(event) => {
						const entries = event.currentTarget.value.split(",").map((entry) => Number(entry.trim()));
						if (entries.length !== arity || entries.some((entry) => !Number.isFinite(entry))) {
							toast.error(`${field.name} requires ${arity} finite numeric value${arity === 1 ? "" : "s"}.`);
							return;
						}
						this._setEntityField(componentId, schemaId, field, arity === 1 ? entries[0] : entries);
					}}
				/>
			</label>
		);
	}

	private _updateEntity(componentId: string, update: (data: any) => void): void {
		this._run(() => {
			const inspection = this._inspect();
			const component = inspection.components.find((entry: any) => entry.id === componentId && entry.type === "entity");
			if (!component) {
				throw new Error("Entity component changed or was removed. Re-inspect the node.");
			}
			const data = structuredClone(component.data);
			update(data);
			setGameObjectComponent(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedFingerprint: inspection.fingerprint, componentId, data },
				{ editor: this.props.editor }
			);
		});
	}

	private _toggleEntityComponent(componentId: string, definition: IECSComponentTypeDefinition, add: boolean): void {
		this._updateEntity(componentId, (data) => {
			data.components ??= {};
			if (add) {
				data.components[definition.id] = Object.fromEntries(definition.fields.map((field) => [field.id, structuredClone(field.defaultValue)]));
			} else {
				delete data.components[definition.id];
			}
		});
	}

	private _setEntityField(componentId: string, schemaId: string, field: IECSFieldDefinition, value: unknown): void {
		this._updateEntity(componentId, (data) => {
			if (!data.components?.[schemaId]) {
				throw new Error(`ECS component "${schemaId}" is no longer authored on this entity.`);
			}
			data.components[schemaId][field.id] = value;
		});
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
					data: this.state.addType === "entity" ? { sectionId: "main" } : undefined,
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
