import { readJSON } from "fs-extra";
import { ipcRenderer } from "electron";
import { dirname, join } from "path/posix";

import { Grid } from "react-loader-spinner";
import { Component, ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "../../../../ui/shadcn/ui/button";

import { NodeParticleSystemSetMesh } from "../../../nodes/node-particle-system";

import { getProjectAssetsRootUrl, projectConfiguration } from "../../../../project/configuration";

import { normalizedGlob } from "../../../../tools/fs";
import { onNodeModifiedObservable } from "../../../../tools/observables";
import { isNodeParticleSystemSetMesh } from "../../../../tools/guards/particles";

import { EditorTransformNodeInspector } from "../transform";

import { ScriptInspectorComponent } from "../script/script";

import { IEditorInspectorImplementationProps } from "../inspector";

import { EditorInspectorVectorField } from "../fields/vector";
import { EditorInspectorStringField } from "../fields/string";
import { EditorInspectorSwitchField } from "../fields/switch";
import { EditorInspectorSectionField } from "../fields/section";
import {
	connectNodeParticleBlocks,
	disconnectNodeParticleBlocks,
	getNodeParticleCodeGraph,
	setNodeParticleBlockInput,
	validateNodeParticleCodeGraph,
} from "../../../../mcp/particles/node-particle-code";
import { getNodeParticleBatchRelease, setNodeParticleBatchRelease } from "../../../../mcp/particles/batch-release";

interface IVfxGraphPort {
	name: string;
	typeName: string;
	connected: boolean;
	value?: unknown;
}

interface IVfxGraphNode {
	id: number;
	name: string;
	className: string;
	reachable: boolean;
	isSystem: boolean;
	inputs: IVfxGraphPort[];
	outputs: IVfxGraphPort[];
}

interface IVfxGraphEdge {
	id: string;
	sourceBlockId: number;
	sourceBlockName: string;
	sourceOutput: string;
	targetBlockId: number;
	targetBlockName: string;
	targetInput: string;
}

interface IVfxGraph {
	nodes: IVfxGraphNode[];
	edges: IVfxGraphEdge[];
	edgeCount: number;
	reachableBlockCount: number;
	systemBlockCount: number;
}

export interface IEditorNodeParticleSystemSetMeshInspectorState {
	searchingToEdit: boolean;
	graphBusy: boolean;
	graphSource: string;
	graphTarget: string;
	graphInput: string;
	graphValue: string;
	releaseBusy: boolean;
}

export class EditorNodeParticleSystemSetMeshInspector extends Component<
	IEditorInspectorImplementationProps<NodeParticleSystemSetMesh>,
	IEditorNodeParticleSystemSetMeshInspectorState
> {
	/**
	 * Returns whether or not the given object is supported by this inspector.
	 * @param object defines the object to check.
	 * @returns true if the object is supported by this inspector.
	 */
	public static IsSupported(object: unknown): boolean {
		return isNodeParticleSystemSetMesh(object);
	}

	public constructor(props: IEditorInspectorImplementationProps<NodeParticleSystemSetMesh>) {
		super(props);

		this.state = {
			searchingToEdit: false,
			graphBusy: false,
			graphSource: "",
			graphTarget: "",
			graphInput: "",
			graphValue: "",
			releaseBusy: false,
		};
	}

	public render(): ReactNode {
		const batchRelease = getNodeParticleBatchRelease(this.props.object.getScene(), { nodeId: this.props.object.id }) as any;
		return (
			<>
				<EditorInspectorSectionField title="Common">
					<EditorInspectorStringField
						label="Name"
						object={this.props.object}
						property="name"
						onChange={() => onNodeModifiedObservable.notifyObservers(this.props.object)}
					/>
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Transforms">
					<EditorInspectorVectorField label={<div className="w-14">Position</div>} object={this.props.object} property="position" />
					{EditorTransformNodeInspector.GetRotationInspector(this.props.object)}
					<EditorInspectorVectorField label={<div className="w-14">Scaling</div>} object={this.props.object} property="scaling" />
				</EditorInspectorSectionField>

				<EditorInspectorSectionField title="Particle System Set">
					<Button
						variant="default"
						disabled={this.state.searchingToEdit}
						className="flex gap-2 items-center w-full"
						onClick={() => this._openNodeParticleSystemSetEditor()}
					>
						{this.state.searchingToEdit && (
							<div className="dark:invert">
								<Grid width={14} height={14} color="#ffffff" />
							</div>
						)}
						Edit...
					</Button>
					<EditorInspectorSwitchField
						noUndoRedo
						label="Release Batch On Disable"
						tooltip="Dispose the live Babylon particle-system batch when this VFX node is disabled, then rebuild it from the retained graph when re-enabled."
						object={{ releaseOnDisable: batchRelease.policyEnabled }}
						property="releaseOnDisable"
						disabled={this.state.releaseBusy}
						onChange={(enabled) => void this._setBatchRelease(enabled)}
					/>
					<div data-testid="vfx-batch-release-status" className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
						State: {batchRelease.state} · Batch:{" "}
						{batchRelease.batchPresent ? `${batchRelease.systemCount} system${batchRelease.systemCount === 1 ? "" : "s"}` : "released"} · Releases:{" "}
						{batchRelease.releaseCount} · Rebuilds: {batchRelease.rebuildCount}
						{batchRelease.lastError && <div className="mt-1 text-red-400">{batchRelease.lastError}</div>}
					</div>
				</EditorInspectorSectionField>

				{this._getVisualGraph()}

				<ScriptInspectorComponent editor={this.props.editor} object={this.props.object} />
			</>
		);
	}

	private async _setBatchRelease(enabled: boolean): Promise<void> {
		this.setState({ releaseBusy: true });
		try {
			const inspected = getNodeParticleBatchRelease(this.props.object.getScene(), { nodeId: this.props.object.id }) as any;
			await setNodeParticleBatchRelease(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, expectedRevision: inspected.revision, releaseOnDisable: enabled },
				{ editor: this.props.editor }
			);
			toast.success(enabled ? "VFX batch release on disable enabled." : "VFX batch retention restored.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ releaseBusy: false });
		}
	}

	private _getVisualGraph(): ReactNode {
		const graph = getNodeParticleCodeGraph(this.props.object.getScene(), { nodeId: this.props.object.id, limit: 256 }) as unknown as IVfxGraph;
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
		const valuePorts = graph.nodes.flatMap((node) =>
			node.inputs
				.filter((port) => !port.connected && !["Particle", "System", "Texture"].includes(port.typeName))
				.map((port) => ({ value: `${node.id}|${port.name}`, label: `${node.name}.${port.name} (${port.typeName})`, current: port.value }))
		);
		return (
			<EditorInspectorSectionField title="Visual VFX Graph" tooltip="Inspect and author the typed Node Particle graph directly in the normal Inspector.">
				<div className="text-xs text-muted-foreground">
					{graph.nodes.length} blocks · {graph.edgeCount} connections · {graph.systemBlockCount} systems · {graph.reachableBlockCount} reachable
				</div>
				<div className="max-h-96 overflow-auto rounded-md border border-border bg-background/60">
					<div className="relative" style={{ width, height }}>
						<svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-label="VFX graph connections">
							{graph.edges.map((edge) => {
								const source = positions.get(edge.sourceBlockId);
								const target = positions.get(edge.targetBlockId);
								if (!source || !target) {
									return null;
								}
								return (
									<path
										key={edge.id}
										d={`M ${source.x + 146} ${source.y + 51} C ${source.x + 182} ${source.y + 51}, ${target.x - 36} ${target.y + 51}, ${target.x} ${target.y + 51}`}
										fill="none"
										stroke="rgb(34 197 94)"
										strokeWidth="2"
									/>
								);
							})}
						</svg>
						{graph.nodes.map((node) => {
							const position = positions.get(node.id)!;
							const special = node.isSystem
								? "border-blue-500 bg-blue-950/40"
								: /Trigger|Teleport/.test(node.className)
									? "border-orange-500 bg-orange-950/40"
									: "border-border bg-card";
							return (
								<div
									key={node.id}
									className={`absolute w-36 rounded-md border shadow-sm ${special} ${node.reachable ? "opacity-100" : "opacity-55"}`}
									style={{ left: position.x, top: position.y }}
									title={`${node.className} #${node.id}`}
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
				<Button variant="secondary" disabled={this.state.graphBusy || !this.state.graphSource || !this.state.graphTarget} onClick={() => void this._connectGraphPorts()}>
					Connect Ports
				</Button>
				{graph.edges.length > 0 && (
					<div className="max-h-36 space-y-1 overflow-auto">
						{graph.edges.map((edge) => (
							<div key={edge.id} className="flex items-center gap-2 rounded bg-muted px-2 py-1 text-[10px]">
								<span className="min-w-0 flex-1 truncate">
									{edge.sourceBlockName}.{edge.sourceOutput} → {edge.targetBlockName}.{edge.targetInput}
								</span>
								<Button size="sm" variant="ghost" disabled={this.state.graphBusy} onClick={() => void this._disconnectGraphEdge(edge)}>
									Disconnect
								</Button>
							</div>
						))}
					</div>
				)}
				<div className="grid grid-cols-2 gap-2">
					<select
						className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
						value={this.state.graphInput}
						onChange={(event) => {
							const selected = valuePorts.find((port) => port.value === event.currentTarget.value);
							this.setState({ graphInput: event.currentTarget.value, graphValue: selected ? (JSON.stringify(selected.current) ?? "null") : "" });
						}}
					>
						<option value="">Embedded input...</option>
						{valuePorts.map((port) => (
							<option key={port.value} value={port.value}>
								{port.label}
							</option>
						))}
					</select>
					<input
						className="h-9 min-w-0 rounded-md border border-input bg-background px-2 font-mono text-xs"
						value={this.state.graphValue}
						onChange={(event) => this.setState({ graphValue: event.currentTarget.value })}
						placeholder="JSON value"
					/>
				</div>
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" disabled={this.state.graphBusy || !this.state.graphInput} onClick={() => void this._setGraphInput()}>
						Apply Input
					</Button>
					<Button variant="default" className="flex-1" disabled={this.state.graphBusy} onClick={() => void this._validateGraph()}>
						{this.state.graphBusy ? "Building..." : "Validate Graph"}
					</Button>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private _parseGraphPort(value: string): { blockId: number; port: string } {
		const separator = value.indexOf("|");
		const blockId = Number(value.slice(0, separator));
		const port = value.slice(separator + 1);
		if (separator < 1 || !Number.isInteger(blockId) || !port) {
			throw new Error("Select a valid VFX graph port.");
		}
		return { blockId, port };
	}

	private async _connectGraphPorts(): Promise<void> {
		this.setState({ graphBusy: true });
		try {
			const source = this._parseGraphPort(this.state.graphSource);
			const target = this._parseGraphPort(this.state.graphTarget);
			await connectNodeParticleBlocks(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, sourceBlockId: source.blockId, sourceOutput: source.port, targetBlockId: target.blockId, targetInput: target.port },
				{ editor: this.props.editor }
			);
			toast.success("VFX graph ports connected.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not connect VFX graph ports.");
		} finally {
			this.setState({ graphBusy: false });
		}
	}

	private async _disconnectGraphEdge(edge: IVfxGraphEdge): Promise<void> {
		this.setState({ graphBusy: true });
		try {
			await disconnectNodeParticleBlocks(
				this.props.object.getScene(),
				{
					nodeId: this.props.object.id,
					sourceBlockId: edge.sourceBlockId,
					sourceOutput: edge.sourceOutput,
					targetBlockId: edge.targetBlockId,
					targetInput: edge.targetInput,
				},
				{ editor: this.props.editor }
			);
			toast.success("VFX graph edge disconnected.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not disconnect the VFX graph edge.");
		} finally {
			this.setState({ graphBusy: false });
		}
	}

	private async _setGraphInput(): Promise<void> {
		this.setState({ graphBusy: true });
		try {
			const input = this._parseGraphPort(this.state.graphInput);
			await setNodeParticleBlockInput(
				this.props.object.getScene(),
				{ nodeId: this.props.object.id, blockId: input.blockId, input: input.port, value: JSON.parse(this.state.graphValue) },
				{ editor: this.props.editor }
			);
			toast.success("VFX graph input updated.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not update the VFX graph input.");
		} finally {
			this.setState({ graphBusy: false });
		}
	}

	private async _validateGraph(): Promise<void> {
		this.setState({ graphBusy: true });
		try {
			const result = (await validateNodeParticleCodeGraph(this.props.object.getScene(), { nodeId: this.props.object.id })) as any;
			if (!result.valid) {
				toast.error(result.errors.join("\n"));
			} else {
				toast.success(`VFX graph is valid${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : ""}.`);
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not validate the VFX graph.");
		} finally {
			this.setState({ graphBusy: false });
		}
	}

	private async _openNodeParticleSystemSetEditor(): Promise<void> {
		if (!this.props.object.nodeParticleSystemSet?.id) {
			return;
		}

		// TODO: Unfortunately we need to search for the material file in the project so it will be
		// edited for the NME. Try to keep the material file somewhere to avoid searching for it each time.
		this.setState({
			searchingToEdit: true,
		});

		const projectPath = dirname(projectConfiguration.path!);
		const nodeParticleSystemSetFiles = await normalizedGlob(join(projectPath, "assets/**/*.npss"), {
			nodir: true,
		});

		for (const filePath of nodeParticleSystemSetFiles) {
			try {
				const data = await readJSON(filePath as string, {
					encoding: "utf-8",
				});

				if (data.customType === "BABYLON.NodeParticleSystemSet" && data.id === this.props.object.nodeParticleSystemSet!.id) {
					ipcRenderer.send("window:open", "build/src/editor/windows/npe", {
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
}
