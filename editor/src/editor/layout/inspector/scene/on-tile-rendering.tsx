import { Component, ReactNode } from "react";

import { Scene } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import {
	applyOnTile,
	createOnTileExtension,
	deleteOnTileExtension,
	getOnTileRendering,
	listOnTileProviders,
	setOnTileExtension,
	setOnTileRendering,
	validateOnTile,
} from "../../../../mcp/rendering/on-tile";
import { Editor } from "../../../main";
import { EditorInspectorSectionField } from "../fields/section";

interface IEditorOnTileRenderingInspectorProps {
	editor: Editor;
	scene: Scene;
}

interface IEditorOnTileRenderingInspectorState {
	busy: boolean;
	error: string | null;
	providerId: string;
}

/** Authors and proves the portable Tile-Only policy through the same backend exposed to MCP. */
export class EditorOnTileRenderingInspector extends Component<IEditorOnTileRenderingInspectorProps, IEditorOnTileRenderingInspectorState> {
	public constructor(props: IEditorOnTileRenderingInspectorProps) {
		super(props);
		this.state = { busy: false, error: null, providerId: "builtin-color-scale" };
	}

	public render(): ReactNode {
		const snapshot = getOnTileRendering(this.props.scene);
		const configuration = snapshot.configuration;
		const validation = validateOnTile(this.props.scene);
		const runtime = snapshot.runtime;
		const providers = listOnTileProviders().providers as Array<{
			id: string;
			displayName: string;
			builtIn: boolean;
			parameters: Record<string, { defaultValue: number; minimum: number; maximum: number }>;
		}>;
		return (
			<EditorInspectorSectionField
				title="On-Tile Rendering"
				tooltip="Opt-in validation, reversible runtime suppression, one fused portable color composite, and trusted-code extension instances. Native tile-memory residency is never inferred."
			>
				<div className="flex flex-col gap-2 text-xs" data-testid="on-tile-rendering-inspector">
					<div className={`rounded p-2 ${runtime.active && !runtime.error ? "bg-success/10 text-success" : "bg-input"}`} data-testid="on-tile-runtime-evidence">
						<div>
							{runtime.active ? "Active" : "Inactive"} · {runtime.backend} · composite {runtime.portableCompositePassCount}
						</div>
						<div>
							frames {runtime.frameCount} · suppressed graph {runtime.suppressedCustomPassIds.length} · camera effects {runtime.suppressedCameraPostProcesses.length}
						</div>
						<div>Native tile-memory/bandwidth evidence: unavailable</div>
					</div>
					<label className="flex items-center justify-between gap-2">
						Enabled
						<input
							type="checkbox"
							checked={configuration.enabled}
							disabled={this.state.busy}
							onChange={(event) => void this._setPolicy({ enabled: event.currentTarget.checked })}
						/>
					</label>
					<label className="flex items-center justify-between gap-2">
						Tile-Only Mode
						<input
							type="checkbox"
							checked={configuration.tileOnlyMode}
							disabled={this.state.busy}
							onChange={(event) => void this._setPolicy({ tileOnlyMode: event.currentTarget.checked })}
						/>
					</label>
					<label className="flex items-center justify-between gap-2">
						Fused post-processing
						<input
							type="checkbox"
							checked={configuration.postProcessing.enabled}
							disabled={this.state.busy}
							onChange={(event) => void this._setPostProcess("enabled", event.currentTarget.checked)}
						/>
					</label>
					<label className="grid grid-cols-[1fr_170px] items-center gap-2">
						Validation
						<select
							className="h-8 rounded border border-border bg-input px-2"
							value={configuration.validationMode}
							disabled={this.state.busy}
							onChange={(event) => void this._setPolicy({ validationMode: event.currentTarget.value })}
						>
							<option value="off">Off</option>
							<option value="warn">Warn only</option>
							<option value="enforce">Warn + suppress</option>
						</select>
					</label>
					<div className="grid grid-cols-2 gap-2" data-testid="on-tile-post-processing">
						{(
							[
								["exposure", -16, 16, 0.1],
								["contrast", 0, 4, 0.05],
								["saturation", 0, 4, 0.05],
								["vignette", 0, 1, 0.05],
								["vignetteSmoothness", 0.01, 1, 0.05],
							] as const
						).map(([key, min, max, step]) => (
							<label key={key}>
								{key}
								<Input
									type="number"
									min={min}
									max={max}
									step={step}
									defaultValue={configuration.postProcessing[key]}
									disabled={this.state.busy}
									onBlur={(event) => void this._setPostProcess(key, Number(event.currentTarget.value))}
								/>
							</label>
						))}
					</div>
					<div className="space-y-1 rounded border border-border p-2" data-testid="on-tile-validation">
						<div className="font-medium">Eligibility · {validation.compatible ? "compatible" : validation.valid ? "suppressible" : "blocked"}</div>
						{validation.issues.slice(0, 8).map((issue: any) => (
							<div key={`${issue.code}:${issue.featureId}`} className={issue.severity === "error" ? "text-destructive" : "text-warning"}>
								{issue.code} · {issue.message}
							</div>
						))}
						{!validation.issues.length && <div className="text-muted-foreground">No incompatible active features.</div>}
					</div>
					<div className="space-y-2" data-testid="on-tile-extensions">
						<div className="flex gap-2">
							<select
								className="h-8 flex-1 rounded border border-border bg-input px-2"
								value={this.state.providerId}
								onChange={(event) => this.setState({ providerId: event.currentTarget.value })}
							>
								{providers.map((provider) => (
									<option key={provider.id} value={provider.id}>
										{provider.displayName} {provider.builtIn ? "(built-in)" : "(project)"}
									</option>
								))}
							</select>
							<Button size="sm" variant="secondary" disabled={this.state.busy || !this.state.providerId} onClick={() => void this._addExtension()}>
								Add Extension
							</Button>
						</div>
						{configuration.extensions.map((extension: any) => {
							const provider = providers.find((candidate) => candidate.id === extension.providerId);
							return (
								<div key={extension.id} className="space-y-2 rounded bg-input p-2">
									<div className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={extension.enabled}
											onChange={(event) => void this._setExtension(extension, { enabled: event.currentTarget.checked })}
										/>
										<span className="min-w-0 flex-1 truncate">
											{extension.name} · {extension.providerId}
										</span>
										<Input
											className="w-20"
											type="number"
											defaultValue={extension.order}
											onBlur={(event) => void this._setExtension(extension, { order: Number(event.currentTarget.value) })}
										/>
										<Button size="sm" variant="ghost" onClick={() => void this._deleteExtension(extension)}>
											Remove
										</Button>
									</div>
									{provider && Object.entries(provider.parameters).length > 0 && (
										<div className="grid grid-cols-2 gap-2">
											{Object.entries(provider.parameters).map(([name, parameter]) => (
												<label key={name}>
													{name}
													<Input
														type="number"
														min={parameter.minimum}
														max={parameter.maximum}
														defaultValue={extension.settings[name] ?? parameter.defaultValue}
														onBlur={(event) =>
															void this._setExtension(extension, { settings: { ...extension.settings, [name]: Number(event.currentTarget.value) } })
														}
													/>
												</label>
											))}
										</div>
									)}
								</div>
							);
						})}
					</div>
					<Button size="sm" disabled={this.state.busy || !validation.valid} onClick={() => void this._apply()} data-testid="on-tile-apply">
						{this.state.busy ? "Working…" : "Validate + Apply"}
					</Button>
					{this.state.error && <div className="rounded bg-destructive/10 p-2 text-destructive">{this.state.error}</div>}
					<div className="text-muted-foreground">
						Enforce mode suppresses incompatible runtime features without deleting their authored definitions. Disabling Tile-Only restores them.
					</div>
				</div>
			</EditorInspectorSectionField>
		);
	}

	private async _run(operation: () => void): Promise<void> {
		this.setState({ busy: true, error: null });
		try {
			operation();
			this.forceUpdate();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}

	private _lease(): { expectedRevision: number; expectedFingerprint: string } {
		const state = getOnTileRendering(this.props.scene);
		return { expectedRevision: state.configuration.revision, expectedFingerprint: state.fingerprint };
	}

	private async _setPolicy(patch: Record<string, unknown>): Promise<void> {
		await this._run(() => setOnTileRendering(this.props.scene, { ...this._lease(), ...patch }, { editor: this.props.editor }));
	}

	private async _setPostProcess(key: string, value: number | boolean): Promise<void> {
		const state = getOnTileRendering(this.props.scene);
		await this._setPolicy({ postProcessing: { ...state.configuration.postProcessing, [key]: value } });
	}

	private async _addExtension(): Promise<void> {
		const state = getOnTileRendering(this.props.scene);
		await this._run(() =>
			createOnTileExtension(
				this.props.scene,
				{ ...this._lease(), providerId: this.state.providerId, name: `On-Tile Extension ${state.configuration.extensions.length + 1}`, settings: {} },
				{ editor: this.props.editor }
			)
		);
	}

	private async _setExtension(extension: any, patch: Record<string, unknown>): Promise<void> {
		await this._run(() => setOnTileExtension(this.props.scene, { ...this._lease(), id: extension.id, ...patch }, { editor: this.props.editor }));
	}

	private async _deleteExtension(extension: any): Promise<void> {
		await this._run(() => deleteOnTileExtension(this.props.scene, { ...this._lease(), id: extension.id, confirm: true }, { editor: this.props.editor }));
	}

	private async _apply(): Promise<void> {
		await this._run(() => applyOnTile(this.props.scene, this._lease(), { editor: this.props.editor }));
	}
}
