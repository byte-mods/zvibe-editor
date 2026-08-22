import { Component, ReactNode } from "react";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";
import { getDiffusionProfile, setDiffusionProfile } from "../../../../mcp/materials/subsurface";
import { Editor } from "../../../main";
import type { FileInspectorObject } from "../file";

interface IEditorInspectorDiffusionProfileProps {
	object: FileInspectorObject;
	editor: Editor;
}

interface IEditorInspectorDiffusionProfileState {
	profile: any | null;
	busy: boolean;
	error: string | null;
}

export class EditorInspectorDiffusionProfileComponent extends Component<IEditorInspectorDiffusionProfileProps, IEditorInspectorDiffusionProfileState> {
	public state: IEditorInspectorDiffusionProfileState = { profile: null, busy: false, error: null };

	public componentDidMount(): void {
		void this._load();
	}

	public render(): ReactNode {
		const profile = this.state.profile;
		if (!profile) {
			return <div className={this.state.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{this.state.error ?? "Loading diffusion profile…"}</div>;
		}
		return (
			<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
				<div className="font-semibold">Diffusion Profile</div>
				<div className="text-xs text-muted-foreground">
					Unity-style portable asset · rev {profile.assetRevision} · {profile.contentRevision.slice(0, 12)}…
				</div>
				<label className="grid grid-cols-[1fr_150px] items-center gap-2">
					Name
					<Input value={profile.name} onChange={(event) => this._patch({ name: event.currentTarget.value })} />
				</label>
				{(["scatteringDistance", "transmissionTint"] as const).map((property) => (
					<div key={property} className="grid grid-cols-[1fr_repeat(3,70px)] items-center gap-1">
						<span>{property === "scatteringDistance" ? "Scattering Distance (mm)" : "Transmission Tint"}</span>
						{profile[property].map((value: number, index: number) => (
							<Input
								key={index}
								type="number"
								min={property === "scatteringDistance" ? 0.001 : 0}
								max={property === "scatteringDistance" ? 1000 : 1}
								step={0.01}
								value={value}
								onChange={(event) => this._patchTuple(property, index, Number(event.currentTarget.value))}
							/>
						))}
					</div>
				))}
				<div className="grid grid-cols-[1fr_repeat(2,90px)] items-center gap-1">
					<span>Thickness Remap (mm)</span>
					{profile.thicknessRemap.map((value: number, index: number) => (
						<Input
							key={index}
							type="number"
							min={0}
							max={10000}
							step={0.05}
							value={value}
							onChange={(event) => this._patchTuple("thicknessRemap", index, Number(event.currentTarget.value))}
						/>
					))}
				</div>
				<label className="grid grid-cols-[1fr_120px] items-center gap-2">
					World Scale
					<Input
						type="number"
						min={0.001}
						max={1000}
						step={0.01}
						value={profile.worldScale}
						onChange={(event) => this._patch({ worldScale: Number(event.currentTarget.value) })}
					/>
				</label>
				<label className="grid grid-cols-[1fr_120px] items-center gap-2">
					Index of Refraction
					<Input
						type="number"
						min={1}
						max={3}
						step={0.01}
						value={profile.indexOfRefraction}
						onChange={(event) => this._patch({ indexOfRefraction: Number(event.currentTarget.value) })}
					/>
				</label>
				<Button size="sm" disabled={this.state.busy} onClick={() => void this._save()}>
					{this.state.busy ? "Saving…" : `Save Revision ${profile.assetRevision + 1}`}
				</Button>
				{this.state.error && <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="text-xs text-muted-foreground">
					Assigned live materials refresh to this exact profile revision. Babylon executes Burley screen-space scattering and transmission.
				</div>
			</div>
		);
	}

	private _patch(patch: Record<string, unknown>): void {
		this.setState((state) => ({ profile: { ...state.profile, ...patch } }));
	}

	private _patchTuple(property: string, index: number, value: number): void {
		this.setState((state) => {
			const tuple = [...state.profile[property]];
			tuple[index] = value;
			return { profile: { ...state.profile, [property]: tuple } };
		});
	}

	private async _load(): Promise<void> {
		try {
			const profile = await getDiffusionProfile(this.props.editor.layout.preview.scene, { path: this.props.object.absolutePath });
			this.setState({ profile, error: null });
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _save(): Promise<void> {
		const profile = this.state.profile;
		this.setState({ busy: true, error: null });
		try {
			await setDiffusionProfile(
				this.props.editor.layout.preview.scene,
				{
					path: this.props.object.absolutePath,
					expectedRevision: profile.contentRevision,
					name: profile.name,
					scatteringDistance: profile.scatteringDistance,
					transmissionTint: profile.transmissionTint,
					thicknessRemap: profile.thicknessRemap,
					worldScale: profile.worldScale,
					indexOfRefraction: profile.indexOfRefraction,
				},
				{ editor: this.props.editor }
			);
			await this._load();
		} catch (error) {
			this.setState({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.setState({ busy: false });
		}
	}
}
