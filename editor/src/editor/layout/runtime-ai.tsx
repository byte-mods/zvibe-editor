import { Component, ReactNode, useMemo, useState } from "react";
import type { Observer } from "babylonjs";
import type { IRuntimeAiModelGraph } from "babylonjs-editor-tools";

import {
	createRuntimeAiSession,
	disposeRuntimeAiSession,
	getRuntimeAiChangedObservable,
	IRuntimeAiModelInspection,
	IRuntimeAiSessionSnapshot,
	inspectRuntimeAiModel,
	listRuntimeAiSessions,
	resetRuntimeAiRuntime,
	runRuntimeAiInference,
} from "../../mcp/ai/runtime-inference";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import { Editor } from "../main";

interface IEditorRuntimeAiProps {
	editor: Editor;
}

interface IEditorRuntimeAiState {
	modelPath: string;
	inspection: IRuntimeAiModelInspection | null;
	sessions: IRuntimeAiSessionSnapshot[];
	selectedSessionId: string | null;
	inputsJson: string;
	outputNames: string;
	timeoutMilliseconds: number;
	maximumOutputValues: number;
	result: any | null;
	busy: boolean;
	error: string | null;
}

function defaultInputValue(type: string): number | boolean | string {
	return type === "bool" ? false : type === "string" || type === "int64" || type === "uint64" ? "0" : 0;
}

function defaultInputs(inspection: IRuntimeAiModelInspection): string {
	return JSON.stringify(
		Object.fromEntries(
			inspection.description.inputs.map((input) => {
				const dims = input.shape.map((dimension) => (typeof dimension === "number" && dimension >= 0 ? dimension : 1));
				const count = dims.reduce((product, dimension) => product * dimension, 1);
				return [input.name, { type: input.type, dims, data: Array.from({ length: Math.min(count, 1_000_000) }, () => defaultInputValue(input.type ?? "float32")) }];
			})
		),
		null,
		2
	);
}

function RuntimeAiGraph({ graph }: { graph: IRuntimeAiModelGraph }): ReactNode {
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(0);
	const pageSize = 64;
	const layout = useMemo(() => {
		const producers = new Map<string, number>();
		graph.nodes.forEach((node, index) => node.outputs.forEach((output) => output && producers.set(output, index)));
		const depths: number[] = [];
		let edges = 0;
		let unresolvedDependencies = 0;
		graph.nodes.forEach((node, index) => {
			const dependencies = new Set(node.inputs.map((input) => producers.get(input)).filter((value): value is number => value !== undefined && value !== index));
			edges += dependencies.size;
			const resolved = [...dependencies].filter((value) => value < index);
			unresolvedDependencies += dependencies.size - resolved.length;
			depths[index] = resolved.length ? Math.max(...resolved.map((value) => depths[value] ?? 0)) + 1 : 0;
		});
		return { producers, depths, edges, unresolvedDependencies };
	}, [graph]);
	const normalizedQuery = query.trim().toLowerCase();
	const filtered = graph.nodes
		.map((node, index) => ({ node, index }))
		.filter(({ node }) =>
			!normalizedQuery ? true : [node.name, node.operator, node.domain, ...node.inputs, ...node.outputs].some((value) => value.toLowerCase().includes(normalizedQuery))
		);
	const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
	const currentPage = Math.min(page, pageCount - 1);
	const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
	const layers = new Map<number, typeof visible>();
	visible.forEach((value) => {
		const depth = layout.depths[value.index] ?? 0;
		layers.set(depth, [...(layers.get(depth) ?? []), value]);
	});
	return (
		<section className="mb-3 grid gap-2 rounded border border-border p-3" data-runtime-ai-graph data-runtime-ai-graph-format={graph.format}>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<div className="font-semibold">Model Graph · {graph.name}</div>
				<div className="text-muted-foreground">
					{graph.nodes.length} operator(s) · {layout.edges} dependency edge(s) · {graph.initializers} initializer(s) · {graph.producer}
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					data-runtime-ai-graph-search
					className="h-8 min-w-56 flex-1"
					value={query}
					placeholder="Filter operators, domains, tensors, or node names"
					onChange={(event) => {
						setQuery(event.currentTarget.value);
						setPage(0);
					}}
				/>
				<span className="text-muted-foreground">
					{filtered.length} match(es) · page {currentPage + 1}/{pageCount}
				</span>
				<Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(Math.max(0, currentPage - 1))}>
					Previous
				</Button>
				<Button size="sm" variant="outline" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}>
					Next
				</Button>
			</div>
			<div className="overflow-x-auto rounded bg-input p-2">
				<div className="flex min-w-max items-stretch gap-2">
					<div className="w-44 shrink-0 rounded border border-sky-500/50 bg-sky-500/10 p-2">
						<div className="font-semibold text-sky-300">Inputs</div>
						{graph.inputs.map((value) => (
							<div key={value} className="break-all font-mono text-[10px]">
								{value}
							</div>
						))}
					</div>
					{[...layers.entries()]
						.sort(([left], [right]) => left - right)
						.map(([depth, values]) => (
							<div key={depth} className="w-60 shrink-0 rounded border border-border/70 p-2" data-runtime-ai-graph-layer={depth}>
								<div className="mb-2 text-center text-[10px] font-semibold uppercase text-muted-foreground">Dependency layer {depth + 1}</div>
								<div className="grid gap-2">
									{values.map(({ node, index }) => {
										const dependencies = [
											...new Set(
												node.inputs
													.map((input) => layout.producers.get(input))
													.filter((value): value is number => value !== undefined && value !== index)
													.map((value) => graph.nodes[value]?.name || graph.nodes[value]?.operator || `node ${value + 1}`)
											),
										];
										return (
											<div key={node.id} className="rounded border border-border bg-background p-2" data-runtime-ai-graph-node={node.operator}>
												<div className="truncate font-semibold" title={node.operator}>
													{node.operator}
												</div>
												<div className="truncate text-[10px] text-muted-foreground" title={node.domain}>
													{node.domain}
												</div>
												{dependencies.length > 0 && <div className="mt-1 break-all text-[9px] text-violet-300">from {dependencies.join(", ")}</div>}
												<div className="mt-1 break-all font-mono text-[9px]">in: {node.inputs.join(", ") || "none"}</div>
												<div className="break-all font-mono text-[9px] text-primary">out: {node.outputs.join(", ") || "none"}</div>
											</div>
										);
									})}
								</div>
							</div>
						))}
					<div className="flex items-center gap-2">
						<div className="w-44 shrink-0 rounded border border-emerald-500/50 bg-emerald-500/10 p-2">
							<div className="font-semibold text-emerald-300">Outputs</div>
							{graph.outputs.map((value) => (
								<div key={value} className="break-all font-mono text-[10px]">
									{value}
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
			{layout.unresolvedDependencies > 0 && (
				<div className="text-amber-400">
					{layout.unresolvedDependencies} dependency edge(s) point forward or participate in a cycle; those nodes remain visible without a fabricated linear ordering.
				</div>
			)}
			{!visible.length && <div className="text-muted-foreground">No graph operators match the current filter.</div>}
			{graph.warnings.map((warning) => (
				<div key={warning} className="text-amber-400">
					{warning}
				</div>
			))}
		</section>
	);
}

export class EditorRuntimeAi extends Component<IEditorRuntimeAiProps, IEditorRuntimeAiState> {
	private _observer: Observer<void> | null = null;

	public state: IEditorRuntimeAiState = {
		modelPath: "",
		inspection: null,
		sessions: [],
		selectedSessionId: null,
		inputsJson: "{}",
		outputNames: "",
		timeoutMilliseconds: 30_000,
		maximumOutputValues: 4096,
		result: null,
		busy: false,
		error: null,
	};

	public componentDidMount(): void {
		this._observer = getRuntimeAiChangedObservable(this.props.editor).add(() => this._refreshSessions());
		this._refreshSessions();
	}

	public componentWillUnmount(): void {
		this._observer?.remove();
		this._observer = null;
	}

	/** Opens a project ONNX, LiteRT, or PyTorch Export asset from the File Inspector. */
	public openModel(modelPath: string): void {
		this.setState({ modelPath, inspection: null, result: null, error: null }, () => void this._inspect());
	}

	public render(): ReactNode {
		const selected = this.state.sessions.find((session) => session.id === this.state.selectedSessionId) ?? null;
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-runtime-ai-state={this.state.busy ? "busy" : this.state.error ? "error" : "ready"}>
				<div className="flex flex-wrap items-end gap-2 border-b border-border bg-input p-2">
					<label className="grid min-w-64 flex-1 gap-1 text-xs">
						<span className="text-muted-foreground">Project AI model</span>
						<Input
							data-runtime-ai-model-path
							value={this.state.modelPath}
							placeholder="assets/models/model.onnx, model.tflite, or model.pt2"
							onChange={(event) => this.setState({ modelPath: event.currentTarget.value })}
						/>
					</label>
					<Button data-runtime-ai-inspect size="sm" disabled={this.state.busy || !this.state.modelPath.trim()} onClick={() => void this._inspect()}>
						Inspect & Compile
					</Button>
					<Button data-runtime-ai-create size="sm" variant="outline" disabled={this.state.busy || !this.state.inspection} onClick={() => void this._create()}>
						Create Session
					</Button>
					<Button size="sm" variant="destructive" disabled={this.state.busy || !this.state.sessions.length} onClick={() => void this._reset()}>
						Reset Runtime
					</Button>
				</div>
				{this.state.error && <div className="border-b border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="grid min-h-0 flex-1 grid-cols-[minmax(230px,30%)_1fr]">
					<div className="overflow-auto border-r border-border p-2 text-xs">
						<div className="mb-2 font-semibold">Compiled sessions ({this.state.sessions.length}/4)</div>
						{!this.state.sessions.length && <div className="text-muted-foreground">Inspect a model, then create a retained inference session.</div>}
						{this.state.sessions.map((session) => (
							<button
								key={session.id}
								data-runtime-ai-session={session.id}
								className={`mb-2 w-full rounded border p-2 text-left ${session.id === selected?.id ? "border-primary bg-secondary" : "border-border"}`}
								onClick={() => this._selectSession(session)}
							>
								<div className="font-semibold">{session.id}</div>
								<div className="break-all text-muted-foreground">{session.modelPath}</div>
								<div>
									{session.description.modelFormat} · {session.description.backend} · rev {session.revision} · {session.runCount} run(s)
									{session.busy ? " · running" : ""}
								</div>
							</button>
						))}
					</div>
					<div className="min-h-0 overflow-auto p-3 text-xs">
						{this.state.inspection && (
							<section className="mb-3 rounded border border-border p-3" data-runtime-ai-inspection>
								<div className="font-semibold">{this.state.inspection.modelPath}</div>
								<div className="text-muted-foreground">
									{this.state.inspection.description.modelFormat} · {this.state.inspection.description.runtimeEngine} ·{" "}
									{this.state.inspection.description.backend} · {(this.state.inspection.modelBytes / 1024).toFixed(1)} KiB · SHA-256{" "}
									{this.state.inspection.modelSha256.slice(0, 16)}…
								</div>
								<div className="mt-2">
									Inputs: {this.state.inspection.description.inputs.map((input) => `${input.name} ${input.type}[${input.shape.join(", ")}]`).join("; ") || "none"}
								</div>
								<div>
									Outputs:{" "}
									{this.state.inspection.description.outputs.map((output) => `${output.name} ${output.type}[${output.shape.join(", ")}]`).join("; ") || "none"}
								</div>
								<div>
									Graph: {this.state.inspection.description.graph.nodes.length} operator(s) · External weights:{" "}
									{this.state.inspection.description.externalDataFiles.length}
									{this.state.inspection.description.conversion ? ` · PT2 ${this.state.inspection.description.conversion.schemaVersion} → ONNX` : ""}
								</div>
							</section>
						)}
						{this.state.inspection && <RuntimeAiGraph graph={this.state.inspection.description.graph} />}
						{selected ? (
							<section className="grid gap-2">
								<div className="flex items-center gap-2">
									<span className="font-semibold">Run {selected.id}</span>
									<Button data-runtime-ai-run size="sm" disabled={this.state.busy || selected.busy} onClick={() => void this._run()}>
										Run Inference
									</Button>
									<Button
										data-runtime-ai-dispose
										size="sm"
										variant="destructive"
										disabled={this.state.busy || selected.busy}
										onClick={() => void this._dispose()}
									>
										Dispose
									</Button>
								</div>
								<label className="grid gap-1">
									<span>Exact tensor feeds (JSON)</span>
									<textarea
										data-runtime-ai-inputs
										className="min-h-48 rounded border border-border bg-input p-2 font-mono"
										value={this.state.inputsJson}
										onChange={(event) => this.setState({ inputsJson: event.currentTarget.value })}
									/>
								</label>
								<div className="grid grid-cols-3 gap-2">
									<label className="grid gap-1">
										Output names (comma separated)
										<Input value={this.state.outputNames} onChange={(event) => this.setState({ outputNames: event.currentTarget.value })} />
									</label>
									<label className="grid gap-1">
										Timeout (ms)
										<Input
											type="number"
											min={1}
											max={300000}
											value={this.state.timeoutMilliseconds}
											onChange={(event) => this.setState({ timeoutMilliseconds: Number(event.currentTarget.value) })}
										/>
									</label>
									<label className="grid gap-1">
										Preview values
										<Input
											type="number"
											min={1}
											max={100000}
											value={this.state.maximumOutputValues}
											onChange={(event) => this.setState({ maximumOutputValues: Number(event.currentTarget.value) })}
										/>
									</label>
								</div>
							</section>
						) : (
							<div className="text-muted-foreground">Select a compiled session to edit exact tensor feeds and run inference.</div>
						)}
						{this.state.result && (
							<pre data-runtime-ai-result className="mt-3 max-h-96 overflow-auto rounded border border-border bg-input p-3 text-[11px]">
								{JSON.stringify(this.state.result, null, 2)}
							</pre>
						)}
					</div>
				</div>
			</div>
		);
	}

	private _actionOptions(): { editor: Editor } {
		return { editor: this.props.editor };
	}

	private _scene(): any {
		return this.props.editor.layout.preview.scene;
	}

	private _refreshSessions(): void {
		const result = listRuntimeAiSessions(this._scene(), { offset: 0, limit: 100 }, this._actionOptions());
		const selectedSessionId = result.sessions.some((session: IRuntimeAiSessionSnapshot) => session.id === this.state.selectedSessionId)
			? this.state.selectedSessionId
			: (result.sessions[0]?.id ?? null);
		this.setState({ sessions: result.sessions, selectedSessionId });
	}

	private _selectSession(session: IRuntimeAiSessionSnapshot): void {
		this.setState({
			selectedSessionId: session.id,
			inspection: {
				modelPath: session.modelPath,
				modelSha256: session.modelSha256,
				modelBytes: session.modelBytes,
				importer: { kind: "aiModel", settings: session.description.options, includeInBuild: true },
				description: session.description,
			},
			inputsJson: defaultInputs({
				modelPath: session.modelPath,
				modelSha256: session.modelSha256,
				modelBytes: session.modelBytes,
				importer: { kind: "aiModel", settings: session.description.options, includeInBuild: true },
				description: session.description,
			}),
			outputNames: "",
			result: null,
			error: null,
		});
	}

	private async _inspect(): Promise<void> {
		this.setState({ busy: true, error: null, result: null });
		try {
			const inspection = await inspectRuntimeAiModel(this._scene(), { modelPath: this.state.modelPath }, this._actionOptions());
			this.setState({ inspection, inputsJson: defaultInputs(inspection), outputNames: "" });
		} catch (error) {
			this.setState({ inspection: null, error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _create(): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			const session = await createRuntimeAiSession(
				this._scene(),
				{ modelPath: this.state.modelPath, expectedModelSha256: this.state.inspection?.modelSha256 },
				this._actionOptions()
			);
			this._selectSession(session);
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _run(): Promise<void> {
		const session = this.state.sessions.find((candidate) => candidate.id === this.state.selectedSessionId);
		if (!session) {
			return;
		}
		this.setState({ busy: true, error: null, result: null });
		try {
			const inputs = JSON.parse(this.state.inputsJson);
			const outputNames = this.state.outputNames
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			const result = await runRuntimeAiInference(
				this._scene(),
				{
					id: session.id,
					expectedRevision: session.revision,
					inputs,
					outputNames: outputNames.length ? outputNames : undefined,
					timeoutMilliseconds: this.state.timeoutMilliseconds,
					maximumOutputValues: this.state.maximumOutputValues,
				},
				this._actionOptions()
			);
			this.setState({ result });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _dispose(): Promise<void> {
		const session = this.state.sessions.find((candidate) => candidate.id === this.state.selectedSessionId);
		if (!session) {
			return;
		}
		this.setState({ busy: true, error: null });
		try {
			await disposeRuntimeAiSession(this._scene(), { id: session.id, expectedRevision: session.revision, confirm: true }, this._actionOptions());
			this.setState({ result: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private async _reset(): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			await resetRuntimeAiRuntime(this._scene(), { confirm: true }, this._actionOptions());
			this.setState({ result: null, selectedSessionId: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
