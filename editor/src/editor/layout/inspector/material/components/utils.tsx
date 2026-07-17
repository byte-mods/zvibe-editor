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
import { applyMaterialPreset, createMaterialPreset, listMaterialPresets, rebaseMaterialVariant } from "../../../../../mcp/materials/materials";

export interface IEditorMaterialInspectorUtilsComponentProps {
	mesh?: AbstractMesh;
	material: Material;
}

export class EditorMaterialInspectorUtilsComponent extends Component<IEditorMaterialInspectorUtilsComponentProps> {
	public render(): ReactNode {
		const presets = listMaterialPresets(this.props.material.getScene()).presets.filter((preset: any) => preset.className === this.props.material.getClassName());
		const variant = this.props.material.metadata?.babylonEditorMaterialVariant;
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
					<Button variant="secondary" className="w-full" onClick={() => void this._handleRebaseVariant()}>
						Rebase Variant from Base
					</Button>
				)}
			</div>
		);
	}

	private _handleSavePreset(): void {
		const name = window.prompt("Material preset name:");
		if (!name?.trim()) return;
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

	private async _handleRebaseVariant(): Promise<void> {
		try {
			await rebaseMaterialVariant(this.props.material.getScene(), { materialId: this.props.material.id });
			this.forceUpdate();
			toast.success("Material variant rebased from its base.");
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
