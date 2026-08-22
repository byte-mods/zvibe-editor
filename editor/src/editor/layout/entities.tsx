import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { getECSRuntime } from "babylonjs-editor-tools";

import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { showConfirm } from "../../ui/dialog";
import {
	bakeECS,
	controlECSRuntime,
	createECSComponentType,
	createECSSection,
	createECSSystem,
	deleteECSConfiguration,
	deleteECSTypeRegistrationPolicy,
	inspectECS,
	inspectECSSchedule,
	playbackECSRuntimeCommands,
	queryECSEntities,
	queryECSHierarchy,
	queryECSSystemsWindow,
	queueECSRuntimeCommand,
	replaceECSConfiguration,
	setECSHierarchyPreferences,
	setECSTypeRegistrationPolicy,
	stepECSRuntime,
} from "../../mcp/ecs/ecs";

import { Editor } from "../main";

interface IEditorEntitiesProps {
	editor: Editor;
}

interface IEditorEntitiesState {
	view: "overview" | "configuration" | "entities" | "systems" | "traces";
	query: string;
	includeValues: boolean;
	queryResult: any | null;
	hierarchySearch: string;
	hierarchyResult: any | null;
	systemSearch: string;
	systemResult: any | null;
	policyAssembly: string;
	policyTypeIds: string;
	policyDisableAutoRegistration: boolean;
	busy: boolean;
	error: string | null;
}

export class EditorEntities extends Component<IEditorEntitiesProps, IEditorEntitiesState> {
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;
	private _observedScene: object | null = null;

	public constructor(props: IEditorEntitiesProps) {
		super(props);
		this.state = {
			view: "overview",
			query: "",
			includeValues: true,
			queryResult: null,
			hierarchySearch: "",
			hierarchyResult: null,
			systemSearch: "",
			systemResult: null,
			policyAssembly: "game",
			policyTypeIds: "",
			policyDisableAutoRegistration: true,
			busy: false,
			error: null,
		};
	}

	public componentDidMount(): void {
		this._refreshTimer = setInterval(() => {
			const scene = this.props.editor.layout.preview?.scene ?? null;
			if (scene !== this._observedScene) {
				this._observedScene = scene;
				this.forceUpdate();
			} else if (scene && getECSRuntime(scene as any)?.status === "running") {
				this.forceUpdate();
			}
		}, 500);
	}

	public componentWillUnmount(): void {
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		this._refreshTimer = null;
		this._observedScene = null;
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene) {
			return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Open a scene to inspect Entities.</div>;
		}
		let inspection: any;
		try {
			inspection = inspectECS(scene);
		} catch (error) {
			return <div className="p-3 text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</div>;
		}
		const authored = Boolean(scene.metadata?.babylonEditorECS);
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2">
					<span className="text-xs font-semibold">Entities {inspection.runtime ? `· ${inspection.runtime.status}` : "· not baked"}</span>
					{!authored && (
						<Button size="sm" onClick={() => this._createAsset(inspection)}>
							Create ECS Asset
						</Button>
					)}
					{authored && (
						<Button size="sm" variant="destructive" onClick={() => this._deleteAsset(inspection)} disabled={this.state.busy}>
							Delete ECS Asset
						</Button>
					)}
					<Button size="sm" variant="secondary" onClick={() => this._bake(inspection)} disabled={this.state.busy}>
						Bake Incremental
					</Button>
					<Button size="sm" variant="outline" onClick={() => this._bake(inspection, "full")} disabled={this.state.busy}>
						Full Bake
					</Button>
					{inspection.runtime && (
						<>
							<Button size="sm" variant="outline" onClick={() => this._control(inspection, inspection.runtime.status === "running" ? "pause" : "start")}>
								{inspection.runtime.status === "running" ? "Pause" : "Start"}
							</Button>
							<Button size="sm" variant="outline" onClick={() => this._step(inspection)}>
								Step 1/60
							</Button>
						</>
					)}
				</div>
				<div className="flex gap-1 border-b border-border p-1">
					{(["overview", "configuration", "entities", "systems", "traces"] as const).map((view) => (
						<Button key={view} size="sm" variant={this.state.view === view ? "secondary" : "ghost"} className="h-7 capitalize" onClick={() => this.setState({ view })}>
							{view}
						</Button>
					))}
				</div>
				{this.state.error && <div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="min-h-0 flex-1 overflow-auto p-3 text-xs">{this._renderView(scene, inspection)}</div>
			</div>
		);
	}

	private _renderView(scene: any, inspection: any): ReactNode {
		if (this.state.view === "overview") {
			return (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{this._metric("Configuration revision", inspection.configuration.revision)}
					{this._metric("Entities", inspection.runtime?.entityCount ?? 0)}
					{this._metric("Active entities", inspection.runtime?.activeEntityCount ?? 0)}
					{this._metric("Generation", inspection.runtime?.generation ?? "—")}
					<div className="sm:col-span-2 lg:col-span-4 rounded border border-border p-3">
						<div className="font-semibold">Execution evidence</div>
						<div className="mt-1 text-muted-foreground">
							Portable typed-array kernels · {inspection.runtime?.lastExecutionBackend ?? "not executed"} · Worker support{" "}
							{inspection.runtime?.workerSupported ? "available" : "unavailable"}
						</div>
						<div className="mt-1 text-[10px] text-amber-400">Portable Burst-style layout; not Unity Burst LLVM/native compilation.</div>
					</div>
					{inspection.world?.sections?.map((section: any) => (
						<div key={section.id} className="rounded border border-border p-3">
							<div className="font-semibold">{section.name}</div>
							<div className="text-muted-foreground">
								{section.entityCount} entities · {section.chunkCount} chunks · {section.loaded ? "loaded" : "unloaded"}
							</div>
							{inspection.runtime && (
								<Button size="sm" variant="outline" className="mt-2 h-7" onClick={() => this._toggleSection(inspection, section.id, !section.loaded)}>
									{section.loaded ? "Unload" : "Load"}
								</Button>
							)}
						</div>
					))}
				</div>
			);
		}
		if (this.state.view === "configuration") {
			return (
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap gap-2">
						<Button size="sm" onClick={() => this._addComponentType(inspection)}>
							Add Component Type
						</Button>
						<Button size="sm" variant="secondary" onClick={() => this._addSection(inspection)}>
							Add Section
						</Button>
					</div>
					<div className="rounded border border-border p-3">
						<div className="font-semibold">World Settings</div>
						<pre className="mt-2 overflow-auto text-[10px] text-muted-foreground">{JSON.stringify(inspection.configuration.settings, null, 2)}</pre>
					</div>
					<div className="rounded border border-border p-3" data-testid="ecs-type-registration-policy">
						<div className="font-semibold">Assembly-wide Type Registration</div>
						<div className="mt-1 text-[10px] text-muted-foreground">
							Portable TypeManager-equivalent policy. This does not write C# assembly attributes or claim Unity TypeManager identity.
						</div>
						<div className="mt-2 grid gap-2 md:grid-cols-3">
							<Input
								value={this.state.policyAssembly}
								maxLength={128}
								placeholder="Assembly (game)"
								onChange={(event) => this.setState({ policyAssembly: event.currentTarget.value })}
							/>
							<Input
								value={this.state.policyTypeIds}
								maxLength={4096}
								placeholder="Explicit type ids: motion,stats"
								onChange={(event) => this.setState({ policyTypeIds: event.currentTarget.value })}
							/>
							<Button size="sm" onClick={() => this._setTypeRegistrationPolicy(inspection)}>
								Apply Policy
							</Button>
						</div>
						<label className="mt-2 flex items-center gap-2">
							<input
								type="checkbox"
								checked={this.state.policyDisableAutoRegistration}
								onChange={(event) => this.setState({ policyDisableAutoRegistration: event.currentTarget.checked })}
							/>{" "}
							Disable auto-registration for the entire assembly
						</label>
						<div className="mt-3 grid gap-2">
							{inspection.configuration.typeRegistrationPolicies.map((policy: any) => (
								<div key={policy.assembly} className="flex items-center justify-between rounded bg-muted/30 p-2">
									<span>
										{policy.assembly} · {policy.disableAutoRegistration ? "auto disabled" : "auto enabled"} · explicit{" "}
										{policy.registeredTypeIds.join(", ") || "none"}
									</span>
									<Button size="sm" variant="destructive" onClick={() => void this._deleteTypeRegistrationPolicy(inspection, policy.assembly)}>
										Remove
									</Button>
								</div>
							))}
						</div>
						<div className="mt-3 grid gap-1">
							{inspection.typeRegistration.map((type: any) => (
								<div key={type.typeId} className={type.registered ? "text-emerald-400" : "text-amber-400"}>
									{type.namespace}.{type.name} ({type.typeId}) · {type.assembly} · {type.registered ? "registered" : "excluded"} ({type.reason})
								</div>
							))}
						</div>
					</div>
					{inspection.configuration.componentTypes.map((component: any) => (
						<div key={component.id} className="rounded border border-border p-3">
							<div className="font-semibold">
								{component.name} <span className="text-muted-foreground">({component.id})</span>
							</div>
							<div className="text-[10px] text-muted-foreground">
								{component.namespace} · {component.assembly}
							</div>
							<div className="mt-2 grid gap-1">
								{component.fields.map((field: any) => (
									<div key={field.id} className="rounded bg-muted/30 px-2 py-1">
										{field.name} · {field.type} · default {JSON.stringify(field.defaultValue)}
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			);
		}
		if (this.state.view === "entities") {
			const entities = this.state.queryResult?.entities ?? [];
			const hierarchyEntities = this.state.hierarchyResult?.entities ?? [];
			return (
				<div className="flex flex-col gap-3">
					<div className="rounded border border-border p-3" data-testid="ecs-hierarchy-preferences">
						<div className="font-semibold">Hierarchy Preferences</div>
						<div className="mt-2 flex flex-wrap items-center gap-2">
							<label className="flex items-center gap-1">
								<input
									type="checkbox"
									checked={inspection.configuration.settings.showHiddenEntitiesInHierarchy}
									onChange={(event) => this._setHierarchyPreferences(inspection, { showHiddenEntitiesInHierarchy: event.currentTarget.checked })}
								/>{" "}
								Show hidden Entities in main Hierarchy
							</label>
							<select
								className="h-8 rounded border border-input bg-background px-2"
								value={inspection.configuration.settings.hierarchyWorldMode}
								onChange={(event) => this._setHierarchyPreferences(inspection, { hierarchyWorldMode: event.currentTarget.value })}
							>
								<option value="authoring">Authoring world</option>
								<option value="runtime">Runtime world</option>
								<option value="combined">Combined world</option>
							</select>
							<Input
								className="max-w-sm"
								value={this.state.hierarchySearch}
								maxLength={256}
								placeholder="Find entity, archetype, section, component..."
								onChange={(event) => this.setState({ hierarchySearch: event.currentTarget.value })}
							/>
							<Button size="sm" onClick={() => this._queryHierarchy(scene, inspection)}>
								Refresh Hierarchy
							</Button>
						</div>
						<div className="mt-2 text-muted-foreground">
							{this.state.hierarchyResult
								? `${this.state.hierarchyResult.total} hierarchy entities · ${this.state.hierarchyResult.world} world`
								: "Refresh for a bounded hierarchy page."}
						</div>
						<div className="mt-2 grid gap-1">
							{hierarchyEntities.map((entity: any) => (
								<div key={entity.entityId} className="rounded bg-muted/30 px-2 py-1" style={{ marginLeft: `${Math.min(entity.depth, 16) * 12}px` }}>
									{entity.name}{" "}
									<span className="text-muted-foreground">
										({entity.entityId}) · {entity.origin}
										{entity.hiddenInHierarchy ? " · hidden" : ""}
									</span>
								</div>
							))}
						</div>
					</div>
					<div className="font-semibold">Archetype Query</div>
					<div className="flex flex-wrap gap-2">
						<Input
							className="max-w-sm"
							value={this.state.query}
							placeholder="Required component ids: motion,stats"
							onChange={(event) => this.setState({ query: event.currentTarget.value })}
						/>
						<label className="flex items-center gap-1">
							<input type="checkbox" checked={this.state.includeValues} onChange={(event) => this.setState({ includeValues: event.currentTarget.checked })} /> Values
						</label>
						<Button size="sm" onClick={() => this._query(scene)}>
							Query
						</Button>
					</div>
					<div className="text-muted-foreground">{this.state.queryResult ? `${this.state.queryResult.total} matching entities` : "Run a bounded archetype query."}</div>
					{entities.map((entity: any) => (
						<div key={entity.entityId} className="rounded border border-border p-2">
							<div className="font-semibold">{entity.entityId}</div>
							<div className="text-muted-foreground">
								{entity.archetype} · {entity.sectionId} · {entity.componentIds.join(", ")}
							</div>
							{entity.values && <pre className="mt-2 overflow-auto text-[10px]">{JSON.stringify(entity.values, null, 2)}</pre>}
						</div>
					))}
				</div>
			);
		}
		const schedule = inspection.runtime ? inspectECSSchedule(scene) : null;
		if (this.state.view === "systems") {
			const systems = this.state.systemResult?.systems ?? inspection.configuration.systems;
			return (
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap gap-2" data-testid="ecs-systems-quick-search">
						<Button size="sm" className="w-fit" onClick={() => this._addSystem(inspection)}>
							Add System
						</Button>
						<Input
							className="max-w-xl"
							value={this.state.systemSearch}
							maxLength={256}
							placeholder="Quick search: namespace:Game phase:update enabled:true component:motion"
							onChange={(event) => this.setState({ systemSearch: event.currentTarget.value })}
						/>
						<Button size="sm" variant="secondary" onClick={() => this._querySystems(scene, inspection)}>
							Search
						</Button>
					</div>
					{this.state.systemResult && (
						<div className="text-muted-foreground">
							{this.state.systemResult.total} systems · namespaces {this.state.systemResult.availableNamespaces.join(", ") || "none"}
						</div>
					)}
					{systems.map((system: any) => (
						<div key={system.id} className="rounded border border-border p-3">
							<div className="font-semibold">
								{system.namespace}.{system.name}
							</div>
							<div className="text-muted-foreground">
								{system.phase} · order {system.order} · {system.enabled ? "enabled" : "disabled"}
							</div>
							<pre className="mt-2 overflow-auto text-[10px]">{JSON.stringify(system, null, 2)}</pre>
						</div>
					))}
					{schedule && <pre className="rounded border border-border p-3 text-[10px]">{JSON.stringify(schedule.schedule.phases, null, 2)}</pre>}
				</div>
			);
		}
		return (
			<div className="flex flex-col gap-2">
				{schedule?.traces?.length ? (
					[...schedule.traces].reverse().map((trace: any) => (
						<div key={trace.sequence} className="rounded border border-border p-2">
							Frame {trace.frame} · {trace.phase} batch {trace.batchIndex} · {trace.backend} · {trace.scalarWrites} scalar writes
							<div className="text-muted-foreground">{trace.systemIds.join(", ")}</div>
						</div>
					))
				) : (
					<div className="text-muted-foreground">No system traces yet.</div>
				)}
			</div>
		);
	}

	private _metric(label: string, value: string | number): ReactNode {
		return (
			<div className="rounded border border-border p-3">
				<div className="text-muted-foreground">{label}</div>
				<div className="mt-1 text-lg font-semibold">{value}</div>
			</div>
		);
	}

	private _run(action: () => unknown | Promise<unknown>): void {
		this.setState({ busy: true, error: null });
		void Promise.resolve()
			.then(action)
			.then(() => this.setState({ busy: false }))
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.setState({ busy: false, error: message });
				toast.error(message);
			});
	}

	private _createAsset(inspection: any): void {
		this._run(() =>
			replaceECSConfiguration(
				this.props.editor.layout.preview.scene,
				{ expectedRevision: inspection.configuration.revision, expectedFingerprint: inspection.fingerprint, configuration: inspection.configuration },
				{ editor: this.props.editor }
			)
		);
	}

	private async _deleteAsset(inspection: any): Promise<void> {
		if (
			!(await showConfirm("Delete ECS Asset?", "Delete this scene's ECS asset and dispose its runtime? Entity components must be removed first.", { confirmText: "Delete" }))
		) {
			return;
		}
		this._run(() =>
			deleteECSConfiguration(
				this.props.editor.layout.preview.scene,
				{ expectedRevision: inspection.configuration.revision, expectedFingerprint: inspection.fingerprint, confirm: true },
				{ editor: this.props.editor }
			)
		);
	}

	private _bake(inspection: any, mode: "full" | "incremental" = "incremental"): void {
		this._run(() =>
			bakeECS(
				this.props.editor.layout.preview.scene,
				{ expectedRevision: inspection.configuration.revision, expectedFingerprint: inspection.fingerprint, expectedGeneration: inspection.runtime?.generation, mode },
				{ editor: this.props.editor }
			)
		);
	}

	private _control(inspection: any, action: "start" | "pause"): void {
		this._run(() =>
			controlECSRuntime(
				this.props.editor.layout.preview.scene,
				{ expectedGeneration: inspection.runtime.generation, expectedStatus: inspection.runtime.status, action },
				{ editor: this.props.editor }
			)
		);
	}

	private _step(inspection: any): void {
		this._run(() =>
			stepECSRuntime(
				this.props.editor.layout.preview.scene,
				{ expectedGeneration: inspection.runtime.generation, expectedStatus: inspection.runtime.status, deltaSeconds: 1 / 60, useWorkers: true },
				{ editor: this.props.editor }
			)
		);
	}

	private _toggleSection(inspection: any, sectionId: string, loaded: boolean): void {
		this._run(() => {
			const scene = this.props.editor.layout.preview.scene;
			queueECSRuntimeCommand(
				scene,
				{ expectedGeneration: inspection.runtime.generation, command: { kind: "set-section-loaded", sectionId, loaded } },
				{ editor: this.props.editor }
			);
			playbackECSRuntimeCommands(scene, { expectedGeneration: inspection.runtime.generation }, { editor: this.props.editor });
		});
	}

	private _addComponentType(inspection: any): void {
		this._run(() =>
			createECSComponentType(
				this.props.editor.layout.preview.scene,
				{
					expectedRevision: inspection.configuration.revision,
					expectedFingerprint: inspection.fingerprint,
					component: { name: `Component ${inspection.configuration.componentTypes.length}`, fields: [{ id: "value", name: "Value", type: "f64", defaultValue: 0 }] },
				},
				{ editor: this.props.editor }
			)
		);
	}

	private _addSection(inspection: any): void {
		this._run(() =>
			createECSSection(
				this.props.editor.layout.preview.scene,
				{
					expectedRevision: inspection.configuration.revision,
					expectedFingerprint: inspection.fingerprint,
					section: { name: `Section ${inspection.configuration.sections.length}` },
				},
				{ editor: this.props.editor }
			)
		);
	}

	private _addSystem(inspection: any): void {
		this._run(() =>
			createECSSystem(
				this.props.editor.layout.preview.scene,
				{
					expectedRevision: inspection.configuration.revision,
					expectedFingerprint: inspection.fingerprint,
					system: { name: `System ${inspection.configuration.systems.length + 1}` },
				},
				{ editor: this.props.editor }
			)
		);
	}

	private _setHierarchyPreferences(inspection: any, changes: Record<string, unknown>): void {
		this._run(() => {
			setECSHierarchyPreferences(
				this.props.editor.layout.preview.scene,
				{ expectedRevision: inspection.configuration.revision, expectedFingerprint: inspection.fingerprint, ...changes },
				{ editor: this.props.editor }
			);
			this.setState({ hierarchyResult: null });
		});
	}

	private _queryHierarchy(scene: any, inspection: any): void {
		this._run(() => {
			const configuredWorld = inspection.configuration.settings.hierarchyWorldMode;
			const world = inspection.runtime ? configuredWorld : "authoring";
			this.setState({
				hierarchyResult: queryECSHierarchy(scene, {
					expectedRevision: inspection.configuration.revision,
					expectedFingerprint: inspection.fingerprint,
					...(world === "authoring" ? {} : { expectedGeneration: inspection.runtime.generation }),
					world,
					search: this.state.hierarchySearch,
					offset: 0,
					limit: 500,
				}),
			});
		});
	}

	private _querySystems(scene: any, inspection: any): void {
		this._run(() =>
			this.setState({
				systemResult: queryECSSystemsWindow(scene, {
					expectedRevision: inspection.configuration.revision,
					expectedFingerprint: inspection.fingerprint,
					search: this.state.systemSearch,
					offset: 0,
					limit: 256,
				}),
			})
		);
	}

	private _setTypeRegistrationPolicy(inspection: any): void {
		this._run(() => {
			const registeredTypeIds = this.state.policyTypeIds
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			setECSTypeRegistrationPolicy(
				this.props.editor.layout.preview.scene,
				{
					expectedRevision: inspection.configuration.revision,
					expectedFingerprint: inspection.fingerprint,
					policy: { assembly: this.state.policyAssembly.trim(), disableAutoRegistration: this.state.policyDisableAutoRegistration, registeredTypeIds },
				},
				{ editor: this.props.editor }
			);
		});
	}

	private async _deleteTypeRegistrationPolicy(inspection: any, assembly: string): Promise<void> {
		if (!(await showConfirm("Remove ECS registration policy?", `Restore automatic type registration for assembly "${assembly}"?`, { confirmText: "Remove" }))) {
			return;
		}
		this._run(() =>
			deleteECSTypeRegistrationPolicy(
				this.props.editor.layout.preview.scene,
				{ expectedRevision: inspection.configuration.revision, expectedFingerprint: inspection.fingerprint, assembly, confirm: true },
				{ editor: this.props.editor }
			)
		);
	}

	private _query(scene: any): void {
		this._run(() => {
			const all = this.state.query
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			this.setState({ queryResult: queryECSEntities(scene, { all, loadedOnly: false, includeValues: this.state.includeValues, offset: 0, limit: 200 }) });
		});
	}
}
