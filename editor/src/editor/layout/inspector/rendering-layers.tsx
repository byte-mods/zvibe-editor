import { ReactNode } from "react";

import { toast } from "sonner";

import { AbstractMesh, Camera, Light } from "babylonjs";

import { Editor } from "../../main";
import { listRenderingLayers, setLightRenderingLayers, setNodeRenderingLayers } from "../../../mcp/rendering/renderer-lists";

import { EditorInspectorSectionField } from "./fields/section";

interface INodeRenderingLayersInspectorProps {
	editor: Editor;
	node: AbstractMesh | Camera;
	showMeshOrder?: boolean;
	onUpdate?: () => void;
}

interface ILightRenderingLayersInspectorProps {
	editor: Editor;
	light: Light;
	onUpdate?: () => void;
}

function reportError(error: unknown): void {
	toast.error(error instanceof Error ? error.message : String(error));
}

function layerBit(bit: number): number {
	return 2 ** bit;
}

/** Native Babylon rendering-layer controls shared by every supported mesh and game camera Inspector. */
export function NodeRenderingLayersInspector(props: INodeRenderingLayersInspectorProps): ReactNode {
	const layers = listRenderingLayers(props.node.getScene()).layers as { id: string; name: string; bit: number }[];
	const mask = props.node.layerMask >>> 0;
	const mesh = props.showMeshOrder ? (props.node as AbstractMesh) : null;
	const update = (changes: Record<string, unknown>): void => {
		try {
			setNodeRenderingLayers(props.node.getScene(), { nodeId: props.node.id, mask, ...changes }, { editor: props.editor });
			props.onUpdate?.();
		} catch (error) {
			reportError(error);
		}
	};

	return (
		<EditorInspectorSectionField
			title="Rendering Layers"
			tooltip="Native Babylon camera culling mask. Meshes also expose the native rendering group and transparent alpha order consumed by renderer lists."
		>
			<div className={`grid gap-2 px-2 ${mesh ? "grid-cols-3" : "grid-cols-1"}`}>
				<label className="flex flex-col gap-1 text-xs">
					Mask
					<input
						key={`mask-${mask}`}
						type="number"
						min={0}
						max={4294967295}
						defaultValue={mask}
						onBlur={(event) => Number(event.currentTarget.value) !== mask && update({ mask: Number(event.currentTarget.value) })}
						className="h-8 w-full rounded-md border border-input bg-background px-2"
					/>
				</label>
				{mesh && (
					<>
						<label className="flex flex-col gap-1 text-xs">
							Group
							<input
								type="number"
								min={0}
								max={3}
								value={mesh.renderingGroupId}
								onChange={(event) => update({ renderingGroupId: Number(event.currentTarget.value) })}
								className="h-8 w-full rounded-md border border-input bg-background px-2"
							/>
						</label>
						<label className="flex flex-col gap-1 text-xs">
							Alpha Index
							<input
								type="number"
								value={mesh.alphaIndex}
								onChange={(event) => update({ alphaIndex: Number(event.currentTarget.value) })}
								className="h-8 w-full rounded-md border border-input bg-background px-2"
							/>
						</label>
					</>
				)}
			</div>
			<div className="flex flex-wrap gap-3 px-2 pb-2">
				{layers.map((layer) => {
					const bit = layerBit(layer.bit);
					return (
						<label key={layer.id} className="text-xs">
							<input
								type="checkbox"
								checked={(mask & bit) !== 0}
								onChange={(event) => update({ mask: event.currentTarget.checked ? (mask | bit) >>> 0 : (mask & ~bit) >>> 0 })}
							/>{" "}
							{layer.name} ({layer.bit})
						</label>
					);
				})}
				{!layers.length && <span className="text-xs text-muted-foreground">Create named layers in the Scene Inspector, or use the numeric mask directly.</span>}
			</div>
		</EditorInspectorSectionField>
	);
}

/** Native Babylon include/exclude rendering-layer controls shared by every supported light Inspector. */
export function LightRenderingLayersInspector(props: ILightRenderingLayersInspectorProps): ReactNode {
	const layers = listRenderingLayers(props.light.getScene()).layers as { id: string; name: string; bit: number }[];
	const includeMask = props.light.includeOnlyWithLayerMask >>> 0;
	const excludeMask = props.light.excludeWithLayerMask >>> 0;
	const update = (nextIncludeMask: number, nextExcludeMask: number): void => {
		try {
			setLightRenderingLayers(
				props.light.getScene(),
				{ nodeId: props.light.id, includeMask: nextIncludeMask >>> 0, excludeMask: nextExcludeMask >>> 0 },
				{ editor: props.editor }
			);
			props.onUpdate?.();
		} catch (error) {
			reportError(error);
		}
	};

	return (
		<EditorInspectorSectionField
			title="Rendering Layers"
			tooltip="Native Babylon light include/exclude masks. Include zero affects every mesh; exclude always wins, and the two masks cannot overlap."
		>
			<div className="grid grid-cols-2 gap-2 px-2">
				<label className="flex flex-col gap-1 text-xs">
					Include Mask
					<input
						key={`include-${includeMask}`}
						type="number"
						min={0}
						max={4294967295}
						defaultValue={includeMask}
						onBlur={(event) => Number(event.currentTarget.value) !== includeMask && update(Number(event.currentTarget.value), excludeMask)}
						className="h-8 w-full rounded-md border border-input bg-background px-2"
					/>
				</label>
				<label className="flex flex-col gap-1 text-xs">
					Exclude Mask
					<input
						key={`exclude-${excludeMask}`}
						type="number"
						min={0}
						max={4294967295}
						defaultValue={excludeMask}
						onBlur={(event) => Number(event.currentTarget.value) !== excludeMask && update(includeMask, Number(event.currentTarget.value))}
						className="h-8 w-full rounded-md border border-input bg-background px-2"
					/>
				</label>
			</div>
			<div className="grid grid-cols-2 gap-x-4 gap-y-1 px-2 pb-2 text-xs">
				<div className="font-medium">Include</div>
				<div className="font-medium">Exclude</div>
				{layers.map((layer) => {
					const bit = layerBit(layer.bit);
					return (
						<div key={layer.id} className="col-span-2 grid grid-cols-2 gap-4">
							<label>
								<input
									type="checkbox"
									checked={(includeMask & bit) !== 0}
									onChange={(event) => update(event.currentTarget.checked ? (includeMask | bit) >>> 0 : (includeMask & ~bit) >>> 0, (excludeMask & ~bit) >>> 0)}
								/>{" "}
								{layer.name}
							</label>
							<label>
								<input
									type="checkbox"
									checked={(excludeMask & bit) !== 0}
									onChange={(event) => update((includeMask & ~bit) >>> 0, event.currentTarget.checked ? (excludeMask | bit) >>> 0 : (excludeMask & ~bit) >>> 0)}
								/>{" "}
								{layer.name}
							</label>
						</div>
					);
				})}
				{!layers.length && <span className="col-span-2 text-muted-foreground">Create named layers in the Scene Inspector, or use the numeric masks directly.</span>}
			</div>
		</EditorInspectorSectionField>
	);
}
