import { dirname, join } from "path";

import filenamify from "filenamify";
import { useState } from "react";
import { toast } from "sonner";

import { Node } from "babylonjs";
import { FbxExportAxis, getDefaultFbxExportSettings, IFbxExportSettings } from "babylonjs-editor-tools";

import { showConfirm, showDialog } from "../../../ui/dialog";
import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { Label } from "../../../ui/shadcn/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../ui/shadcn/ui/select";
import { Switch } from "../../../ui/shadcn/ui/switch";

import { saveSingleFileDialog } from "../../../tools/dialog";
import { projectConfiguration } from "../../../project/configuration";
import { applyFbxExport, inspectFbxExport, roundTripFbxExport } from "../../../mcp/assets/fbx-export";

import { Editor } from "../../main";

export interface IFbxExportUiRequest {
	path: string;
	settings: IFbxExportSettings;
	rootNodeIds?: string[];
	includeDescendants?: boolean;
	roundTrip: boolean;
	name?: string;
}

export interface IFbxExportDialogContentProps {
	editor: Editor;
	node?: Node;
	defaultPath: string;
	onClose: () => void;
}

const axes: FbxExportAxis[] = ["X", "-X", "Y", "-Y", "Z", "-Z"];

/** Executes the same exact inspect/confirm/apply owner used by external MCP clients. */
export async function executeFbxExport(editor: Editor, request: IFbxExportUiRequest): Promise<any | null> {
	const scene = editor.layout.preview.scene;
	const data = {
		path: request.path,
		settings: request.settings,
		rootNodeIds: request.rootNodeIds,
		includeDescendants: request.includeDescendants,
	};
	const plan = await inspectFbxExport(scene, data);
	if (plan.exists && !plan.current) {
		const confirmed = await showConfirm(
			"Replace FBX asset?",
			<span>
				The destination <b>{plan.path}</b> already exists or has stale export evidence. Its previous bytes will be replaced only after Blender finishes successfully.
			</span>,
			{ confirmText: "Replace" }
		);
		if (!confirmed) {
			return null;
		}
	}
	const mutation = { ...data, expectedFingerprint: plan.fingerprint, confirm: true, name: request.name };
	return request.roundTrip ? roundTripFbxExport(scene, mutation, { editor }) : applyFbxExport(scene, mutation, { editor });
}

function ToggleField(props: { id: string; label: string; checked: boolean; disabled?: boolean; onCheckedChange: (checked: boolean) => void }): React.ReactNode {
	return (
		<div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
			<Label htmlFor={props.id}>{props.label}</Label>
			<Switch id={props.id} data-testid={props.id} checked={props.checked} disabled={props.disabled} onCheckedChange={props.onCheckedChange} />
		</div>
	);
}

function NumberField(props: { id: string; label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }): React.ReactNode {
	return (
		<div className="grid grid-cols-[1fr_170px] items-center gap-4">
			<Label htmlFor={props.id}>{props.label}</Label>
			<Input
				id={props.id}
				data-testid={props.id}
				type="number"
				min={props.min}
				max={props.max}
				step={props.step}
				value={props.value}
				onChange={(event) => props.onChange(Number(event.target.value || "0"))}
			/>
		</div>
	);
}

export function FbxExportDialogContent(props: IFbxExportDialogContentProps): React.ReactNode {
	const [path, setPath] = useState(props.defaultPath);
	const [settings, setSettings] = useState<IFbxExportSettings>(() => getDefaultFbxExportSettings());
	const [includeDescendants, setIncludeDescendants] = useState(true);
	const [roundTrip, setRoundTrip] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const setSetting = <K extends keyof IFbxExportSettings>(key: K, value: IFbxExportSettings[K]): void => {
		setSettings((current) => ({ ...current, [key]: value }));
	};

	const browse = (): void => {
		const selected = saveSingleFileDialog({
			title: props.node ? "Export Selection as FBX" : "Export Scene as FBX",
			defaultPath: path,
			filters: [{ name: "FBX Files", extensions: ["fbx"] }],
		});
		if (selected) {
			setPath(selected);
		}
	};

	const execute = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			const result = await executeFbxExport(props.editor, {
				path,
				settings,
				rootNodeIds: props.node ? [props.node.id] : undefined,
				includeDescendants: props.node ? includeDescendants : undefined,
				roundTrip,
				name: roundTrip ? `${props.node?.name ?? "Scene"} FBX Round Trip` : undefined,
			});
			if (!result) {
				return;
			}
			const message = roundTrip ? `FBX exported and reimported successfully to ${result.export.path}.` : `FBX exported successfully to ${result.path}.`;
			props.editor.layout.console.log(message);
			toast.success(message);
			props.onClose();
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			setError(message);
			props.editor.layout.console.error(`FBX export failed: ${message}`);
			toast.error("FBX export failed", { description: message });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex max-h-[75vh] w-[760px] max-w-[85vw] flex-col gap-4 overflow-y-auto pt-3 text-foreground">
			<p className="text-sm text-muted-foreground">
				Exports the live Babylon {props.node ? "selection" : "scene"} through a deterministic GLB snapshot and Blender&apos;s binary FBX exporter. Blender must be installed
				or configured with BJS_EDITOR_BLENDER_EXECUTABLE.
			</p>

			<div className="grid grid-cols-[1fr_auto] gap-2">
				<Input data-testid="fbx-destination" value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} aria-label="FBX destination" />
				<Button data-testid="fbx-browse" variant="outline" disabled={busy} onClick={browse}>
					Browse…
				</Button>
			</div>

			<div className="grid grid-cols-2 gap-3">
				<NumberField
					id="fbx-global-scale"
					label="Global scale"
					value={settings.globalScale}
					min={0.0001}
					max={100000}
					step={0.01}
					onChange={(value) => setSetting("globalScale", value)}
				/>
				<div className="grid grid-cols-[1fr_170px] items-center gap-4">
					<Label>Forward axis</Label>
					<Select value={settings.axisForward} onValueChange={(value) => setSetting("axisForward", value as FbxExportAxis)}>
						<SelectTrigger data-testid="fbx-axis-forward">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{axes.map((axis) => (
								<SelectItem key={axis} value={axis}>
									{axis}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<NumberField
					id="fbx-animation-sampling"
					label="Animation sampling"
					value={settings.animationSamplingRate}
					min={0.01}
					max={100}
					step={0.01}
					onChange={(value) => setSetting("animationSamplingRate", value)}
				/>
				<div className="grid grid-cols-[1fr_170px] items-center gap-4">
					<Label>Up axis</Label>
					<Select value={settings.axisUp} onValueChange={(value) => setSetting("axisUp", value as FbxExportAxis)}>
						<SelectTrigger data-testid="fbx-axis-up">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{axes.map((axis) => (
								<SelectItem key={axis} value={axis}>
									{axis}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<NumberField
					id="fbx-animation-simplification"
					label="Animation simplification"
					value={settings.animationSimplification}
					min={0}
					max={100}
					step={0.1}
					onChange={(value) => setSetting("animationSimplification", value)}
				/>
			</div>

			<div className="grid grid-cols-2 gap-2">
				{props.node && <ToggleField id="fbx-include-descendants" label="Include descendants" checked={includeDescendants} onCheckedChange={setIncludeDescendants} />}
				<ToggleField
					id="fbx-apply-transforms"
					label="Apply transforms"
					checked={settings.applyTransforms}
					onCheckedChange={(value) => setSetting("applyTransforms", value)}
				/>
				<ToggleField id="fbx-apply-modifiers" label="Apply modifiers" checked={settings.applyModifiers} onCheckedChange={(value) => setSetting("applyModifiers", value)} />
				<ToggleField
					id="fbx-include-materials"
					label="Include materials"
					checked={settings.includeMaterials}
					onCheckedChange={(value) => setSettings((current) => ({ ...current, includeMaterials: value, embedTextures: value ? current.embedTextures : false }))}
				/>
				<ToggleField
					id="fbx-embed-textures"
					label="Embed textures"
					checked={settings.embedTextures}
					disabled={!settings.includeMaterials}
					onCheckedChange={(value) => setSetting("embedTextures", value)}
				/>
				<ToggleField
					id="fbx-include-animations"
					label="Include animations"
					checked={settings.includeAnimations}
					onCheckedChange={(value) => setSetting("includeAnimations", value)}
				/>
				<ToggleField id="fbx-include-cameras" label="Include cameras" checked={settings.includeCameras} onCheckedChange={(value) => setSetting("includeCameras", value)} />
				<ToggleField id="fbx-include-lights" label="Include lights" checked={settings.includeLights} onCheckedChange={(value) => setSetting("includeLights", value)} />
				<ToggleField id="fbx-export-tangents" label="Export tangents" checked={settings.exportTangents} onCheckedChange={(value) => setSetting("exportTangents", value)} />
				<ToggleField
					id="fbx-custom-properties"
					label="Custom properties"
					checked={settings.exportCustomProperties}
					onCheckedChange={(value) => setSetting("exportCustomProperties", value)}
				/>
				<ToggleField id="fbx-leaf-bones" label="Add leaf bones" checked={settings.addLeafBones} onCheckedChange={(value) => setSetting("addLeafBones", value)} />
				<ToggleField
					id="fbx-deform-bones"
					label="Only deform bones"
					checked={settings.useArmatureDeformOnly}
					onCheckedChange={(value) => setSetting("useArmatureDeformOnly", value)}
				/>
				<ToggleField id="fbx-round-trip" label="Reimport and instantiate" checked={roundTrip} onCheckedChange={setRoundTrip} />
			</div>

			{error && (
				<div data-testid="fbx-error" className="rounded-md border border-red-500/60 bg-red-500/10 p-3 text-sm text-red-300">
					{error}
				</div>
			)}

			<div className="flex justify-end gap-2 border-t border-border pt-4">
				<Button variant="outline" disabled={busy} onClick={props.onClose}>
					Cancel
				</Button>
				<Button data-testid="fbx-export" disabled={busy || !path.trim()} onClick={() => void execute()}>
					{busy ? "Exporting…" : roundTrip ? "Export & Reimport" : "Export FBX"}
				</Button>
			</div>
		</div>
	);
}

/** Opens the permanent FBX settings workflow for a scene or one selected graph node. */
export function showFbxExportDialog(editor: Editor, node?: Node): void {
	if (!projectConfiguration.path) {
		toast.error("No project is currently open.");
		return;
	}
	const fileName = `${filenamify(node?.name || "scene") || "scene"}.fbx`;
	const defaultPath = join(dirname(projectConfiguration.path), "assets", fileName);
	let dialog: ReturnType<typeof showDialog>;
	dialog = showDialog(
		node ? "Export Selection as FBX" : "Export Scene as FBX",
		<FbxExportDialogContent editor={editor} node={node} defaultPath={defaultPath} onClose={() => dialog.close()} />,
		true
	);
}
