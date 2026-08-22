import { dirname, relative } from "path/posix";
import { useState } from "react";
import { Grid } from "react-loader-spinner";
import { toast } from "sonner";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";

import { wait } from "../../../tools/tools";

import { Editor } from "../../main";
import { listNavCrowds, setNavCrowd } from "../../../mcp/navmesh/navmesh";
import { projectConfiguration } from "../../../project/configuration";

import { EditorInspectorNumberField } from "../inspector/fields/number";
import { EditorInspectorSectionField } from "../inspector/fields/section";

import { NavMeshEditor } from "./editor";
import { getNavMeshAreaColor } from "./debug";

export interface INavMeshEditorInspectorProps {
	editor: Editor;
	navMeshEditor: NavMeshEditor;
}

export function NavMeshEditorInspector(props: INavMeshEditorInspectorProps) {
	const parameters = props.navMeshEditor.configuration.navMeshParameters;
	const areas = (props.navMeshEditor.configuration.areas ??= [{ id: 0, name: "Walkable", cost: 1 }]);
	const scene = props.editor.layout.preview.scene;
	const navMeshPath = projectConfiguration.path ? relative(dirname(projectConfiguration.path), props.navMeshEditor.absolutePath) : props.navMeshEditor.absolutePath;
	const crowd = listNavCrowds(scene).crowds.find((configuration: any) => configuration.navMeshPath === navMeshPath) ?? {
		navMeshPath,
		maxAgents: 64,
		maxAgentRadius: parameters.walkableRadius || 50,
		timeStep: 1 / 60,
		maxSubStepCount: 10,
		queryExtent: [100, 200, 100],
	};

	const [building, setBuilding] = useState(false);
	const [, setAreaVersion] = useState(0);

	async function handleRebuildNavMesh() {
		setBuilding(true);

		await wait(0);
		await props.navMeshEditor.updateNavMesh();

		setBuilding(false);
	}

	function updateArea(index: number, property: "name" | "cost", value: string): void {
		if (property === "name") {
			if (!value.trim()) {
				return;
			}
			areas[index].name = value.trim();
		} else {
			const cost = Number(value);
			if (!(cost > 0) || !Number.isFinite(cost) || cost > 1000) {
				return;
			}
			areas[index].cost = cost;
		}
		setAreaVersion((version) => version + 1);
	}

	function addArea(): void {
		const usedIds = new Set(areas.map((area) => area.id));
		const id = Array.from({ length: 64 }, (_, candidate) => candidate).find((candidate) => !usedIds.has(candidate));
		if (id === undefined) {
			return;
		}
		areas.push({ id, name: `Area ${id}`, cost: 1 });
		setAreaVersion((version) => version + 1);
	}

	function removeArea(index: number): void {
		const areaId = areas[index].id;
		if (
			areaId === 0 ||
			props.navMeshEditor.configuration.staticMeshes.some((surface) => (surface.area ?? 0) === areaId) ||
			props.navMeshEditor.configuration.offMeshLinks?.some((link) => link.area === areaId)
		) {
			return;
		}
		areas.splice(index, 1);
		setAreaVersion((version) => version + 1);
	}

	function updateCrowd(property: "maxAgents" | "maxAgentRadius" | "timeStep" | "maxSubStepCount", value: string): void {
		const number = Number(value);
		if (!Number.isFinite(number) || number <= 0 || ((property === "maxAgents" || property === "maxSubStepCount") && !Number.isInteger(number))) {
			return;
		}
		setNavCrowd(
			scene,
			{
				...crowd,
				[property]: number,
				filters: crowd.filters ?? [{ index: 0, areaCosts: Object.fromEntries(areas.map((area) => [String(area.id), area.cost])) }],
			},
			{ editor: props.editor }
		)
			.then(() => setAreaVersion((version) => version + 1))
			.catch((error: Error) => toast.error(error.message));
	}

	return (
		<div className="flex flex-col gap-2 w-80 h-full p-2">
			<div className="flex justify-center items-center">Inspector</div>

			<EditorInspectorSectionField title="Parameters">
				<EditorInspectorNumberField object={parameters} property="cs" label="Cell Size" min={10} step={0.1} />
				<EditorInspectorNumberField object={parameters} property="ch" label="Cell Height" min={0.1} step={0.1} />

				<EditorInspectorNumberField object={parameters} property="walkableHeight" label="Walkable Height" min={0.1} step={0.1} />
				<EditorInspectorNumberField object={parameters} property="walkableRadius" label="Walkable Radius" min={0.1} step={0.1} />
				<EditorInspectorNumberField object={parameters} property="walkableSlopeAngle" label="Walkable Slope Angle" min={0.1} max={90} step={0.1} />
				<EditorInspectorNumberField object={parameters} property="walkableClimb" label="Walkable Climb" min={0.1} step={0.1} />

				<Button className="flex items-center gap-2" disabled={building} onClick={handleRebuildNavMesh}>
					{building && <Grid width={16} height={16} color="gray" />}
					Rebuild NavMesh
				</Button>
			</EditorInspectorSectionField>

			<EditorInspectorSectionField title="Detour Crowd" tooltip="Native crowd capacity and fixed-step simulation shared by editor preview, exported games, and MCP.">
				<div className="grid grid-cols-2 gap-1 px-2 pb-2">
					<Input
						defaultValue={String(crowd.maxAgents ?? 64)}
						type="number"
						min="1"
						step="1"
						aria-label="Crowd maximum agents"
						onBlur={(event) => updateCrowd("maxAgents", event.target.value)}
					/>
					<Input
						defaultValue={String(crowd.maxAgentRadius ?? 50)}
						type="number"
						min="0.001"
						step="any"
						aria-label="Crowd maximum agent radius"
						onBlur={(event) => updateCrowd("maxAgentRadius", event.target.value)}
					/>
					<Input
						defaultValue={String(crowd.timeStep ?? 1 / 60)}
						type="number"
						min="0.001"
						max="1"
						step="any"
						aria-label="Crowd fixed timestep"
						onBlur={(event) => updateCrowd("timeStep", event.target.value)}
					/>
					<Input
						defaultValue={String(crowd.maxSubStepCount ?? 10)}
						type="number"
						min="1"
						max="100"
						step="1"
						aria-label="Crowd maximum substeps"
						onBlur={(event) => updateCrowd("maxSubStepCount", event.target.value)}
					/>
				</div>
			</EditorInspectorSectionField>

			<EditorInspectorSectionField
				title="Traversal Areas"
				tooltip="Named Detour areas and per-area path costs. Area 0 is the default walkable surface; off-mesh links can reference these IDs."
			>
				<div className="space-y-1 px-2 pb-2">
					{areas.map((area, index) => (
						<div key={area.id} className="grid grid-cols-[2rem_minmax(0,1fr)_4rem_auto] items-center gap-1">
							<div className="flex items-center gap-1 text-xs text-muted-foreground">
								<div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getNavMeshAreaColor(area.id).toHexString() }} />
								{area.id}
							</div>
							<input
								className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
								defaultValue={area.name}
								aria-label={`NavMesh area ${area.id} name`}
								onBlur={(event) => updateArea(index, "name", event.target.value)}
							/>
							<input
								className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
								type="number"
								min="0.001"
								max="1000"
								step="0.1"
								defaultValue={area.cost}
								aria-label={`NavMesh area ${area.id} cost`}
								onBlur={(event) => updateArea(index, "cost", event.target.value)}
							/>
							<Button
								size="sm"
								variant="ghost"
								disabled={
									area.id === 0 ||
									props.navMeshEditor.configuration.staticMeshes.some((surface) => (surface.area ?? 0) === area.id) ||
									props.navMeshEditor.configuration.offMeshLinks?.some((link) => link.area === area.id)
								}
								onClick={() => removeArea(index)}
							>
								×
							</Button>
						</div>
					))}
					<Button size="sm" variant="secondary" disabled={areas.length >= 64} onClick={addArea}>
						Add Area
					</Button>
				</div>
			</EditorInspectorSectionField>
		</div>
	);
}
