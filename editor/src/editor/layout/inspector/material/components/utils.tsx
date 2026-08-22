import { writeJSON } from "fs-extra";
import { join, dirname } from "path/posix";

import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { Material, AbstractMesh } from "babylonjs";

import { saveSingleFileDialog } from "../../../../../tools/dialog";
import { onRedoObservable, registerUndoRedo } from "../../../../../tools/undoredo";

import { showConfirm } from "../../../../../ui/dialog";

import { Button } from "../../../../../ui/shadcn/ui/button";
import { projectConfiguration } from "../../../../../project/configuration";
import {
	applyMaterialPreset,
	clearMaterialVariantOverrides,
	createMaterialPreset,
	getMaterialVariant,
	listMaterialPresets,
	rebaseMaterialVariant,
} from "../../../../../mcp/materials/materials";

export interface IEditorMaterialInspectorUtilsComponentProps {
	mesh?: AbstractMesh;
	material: Material;
}

export class EditorMaterialInspectorUtilsComponent extends Component<IEditorMaterialInspectorUtilsComponentProps> {
	public render(): ReactNode {
		const presets = listMaterialPresets(this.props.material.getScene()).presets.filter((preset: any) => preset.className === this.props.material.getClassName());
		const variant = this.props.material.metadata?.babylonEditorMaterialVariant;
		let variantDetails: any = null;
		let variantError: string | null = null;
		if (variant?.baseMaterialId) {
			try {
				variantDetails = getMaterialVariant(this.props.material.getScene(), { materialId: this.props.material.id });
			} catch (error: any) {
				variantError = error.message;
			}
		}
		return (
			<div className="space-y-2">
				<div className="flex gap-2 items-center w-full">
					<Button variant="secondary" className="w-full" onClick={() => this._handleExport()}>
						Export...
					</Button>

					{this.props.mesh && (
						<Button variant="secondary" className="w-full hover:bg-destructive" onClick={() => this._handleRemove()}>
							Remove
						</Button>
					)}
				</div>
				<div className="flex gap-2">
					<Button variant="secondary" className="flex-1" onClick={() => this._handleSavePreset()}>
						Save Preset...
					</Button>
					<select
						className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
						defaultValue=""
						onChange={(event) => event.target.value && this._handleApplyPreset(event.target.value)}
					>
						<option value="">Apply Preset...</option>
						{presets.map((preset: any) => (
							<option key={preset.name} value={preset.name}>
								{preset.name}
							</option>
						))}
					</select>
				</div>
				{variant?.baseMaterialId && (
					<div className="space-y-2 rounded-md border border-border p-2 text-xs">
						<div className="font-medium">Material Variant Inheritance</div>
						{variantDetails ? (
							<>
								<div className="text-muted-foreground break-all">{variantDetails.chain.map((entry: any) => entry.name).join(" → ")}</div>
								<div className="grid grid-cols-2 gap-1">
									<span>Depth</span>
									<span>{variantDetails.chainDepth}</span>
									<span>Overrides</span>
									<span>{variantDetails.overridePaths.length}</span>
									<span>Base changes</span>
									<span>{variantDetails.inheritedChangedPaths.length}</span>
									<span>Conflicts</span>
									<span className={variantDetails.conflicts.length ? "text-destructive" : ""}>{variantDetails.conflicts.length}</span>
								</div>
								{variantDetails.overridePaths.length > 0 && (
									<div className="text-muted-foreground break-all">Overrides: {variantDetails.overridePaths.join(", ")}</div>
								)}
								{variantDetails.conflicts.length > 0 && (
									<div className="text-destructive break-all">Resolve: {variantDetails.conflicts.map((conflict: any) => conflict.path).join(", ")}</div>
								)}
								<div className="flex gap-2">
									<Button variant="secondary" className="flex-1" onClick={() => void this._handleRebaseVariant("abort")}>
										Rebase
									</Button>
									{variantDetails.overridePaths.length > 0 && (
										<Button variant="secondary" className="flex-1" onClick={() => void this._handleClearVariantOverride()}>
											Clear Override...
										</Button>
									)}
								</div>
								{variantDetails.conflicts.length > 0 && (
									<div className="flex gap-2">
										<Button variant="secondary" className="flex-1" onClick={() => void this._handleRebaseVariant("useBase")}>
											Use Base
										</Button>
										<Button variant="secondary" className="flex-1" onClick={() => void this._handleRebaseVariant("keepVariant")}>
											Keep Variant
										</Button>
									</div>
								)}
							</>
						) : (
							<div className="text-destructive">{variantError}</div>
						)}
					</div>
				)}
			</div>
		);
	}

	private _handleSavePreset(): void {
		// eslint-disable-next-line no-alert -- Electron's material inspector uses a synchronous name prompt for this compact action.
		const name = window.prompt("Material preset name:");
		if (!name?.trim()) {
			return;
		}
		try {
			createMaterialPreset(this.props.material.getScene(), { materialId: this.props.material.id, name: name.trim() });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private _handleApplyPreset(name: string): void {
		try {
			applyMaterialPreset(this.props.material.getScene(), { materialId: this.props.material.id, name });
			this.forceUpdate();
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _handleRebaseVariant(conflictPolicy: "abort" | "useBase" | "keepVariant"): Promise<void> {
		try {
			const details = getMaterialVariant(this.props.material.getScene(), { materialId: this.props.material.id });
			await rebaseMaterialVariant(this.props.material.getScene(), {
				materialId: this.props.material.id,
				expectedFingerprint: details.fingerprint,
				recursive: true,
				conflictPolicy,
			});
			this.forceUpdate();
			toast.success("Material variant rebased from its base.");
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _handleClearVariantOverride(): Promise<void> {
		try {
			const details = getMaterialVariant(this.props.material.getScene(), { materialId: this.props.material.id });
			// eslint-disable-next-line no-alert -- The exact path list is short and the existing inspector action pattern is synchronous.
			const path = window.prompt(`Exact override path to clear:\n${details.overridePaths.join("\n")}`);
			if (!path?.trim()) {
				return;
			}
			await clearMaterialVariantOverrides(this.props.material.getScene(), { materialId: this.props.material.id, paths: [path.trim()] });
			this.forceUpdate();
			toast.success(`Material override "${path.trim()}" cleared.`);
		} catch (error: any) {
			toast.error(error.message);
		}
	}

	private async _handleRemove(): Promise<void> {
		const confirm = await showConfirm("Remove Material", "Are you sure you want to remove this material?");
		if (!confirm) {
			return;
		}

		const mesh = this.props.mesh!;
		const material = this.props.material;

		registerUndoRedo({
			executeRedo: true,
			undo: () => (mesh.material = material),
			redo: () => (mesh.material = null),
		});

		onRedoObservable.notifyObservers();
	}

	private async _handleExport(): Promise<void> {
		const data = this.props.material.serialize();

		const destination = saveSingleFileDialog({
			title: "Export Material",
			filters: [{ name: "Material File", extensions: ["material"] }],
			defaultPath: join(dirname(projectConfiguration.path!), "assets"),
		});

		if (!destination) {
			return;
		}

		await writeJSON(destination, data, { spaces: 4 });

		toast.success("Material exported successfully!");
	}
}
