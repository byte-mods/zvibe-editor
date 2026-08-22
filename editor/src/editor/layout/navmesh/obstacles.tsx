import { useState } from "react";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";

import { Editor } from "../../main";

import { NavMeshEditorListComponent } from "./components/list";
import { NavMeshEditorSearchComponent } from "./components/search";

import { NavMeshEditor } from "./editor";
import { INavMeshObstacleConfiguration } from "./types";

export interface INavMeshEditorObstaclesProps {
	editor: Editor;
	navMeshEditor: NavMeshEditor;
}

export function NavMeshEditorObstacles(props: INavMeshEditorObstaclesProps) {
	const [search, setSearch] = useState("");
	const [, setVersion] = useState(0);

	function updateObstacle(obstacle: INavMeshObstacleConfiguration, property: keyof INavMeshObstacleConfiguration, value: unknown): void {
		if (typeof value === "number" && !Number.isFinite(value)) {
			return;
		}
		(obstacle as any)[property] = value;
		props.navMeshEditor.createDebugObstacles();
		setVersion((version) => version + 1);
	}

	return (
		<div className="flex flex-col gap-2 w-80 h-full p-2">
			<div className="flex justify-between items-center h-10">
				<div>Obstacle meshes</div>
				<NavMeshEditorSearchComponent search={search} setSearch={setSearch} />
			</div>

			<NavMeshEditorListComponent<INavMeshObstacleConfiguration>
				search={search}
				scene={props.editor.layout.preview.scene}
				items={props.navMeshEditor.configuration.obstacleMeshes}
				onCreateItem={(mesh) => ({
					id: mesh.id,
					enabled: true,
					type: "box",
					carving: true,
					dynamic: true,
					carveOnlyStationary: true,
					moveThreshold: 10,
					timeToStationary: 0.5,
					updateInterval: 0.1,
				})}
				onItemsChange={(items) => {
					props.navMeshEditor.configuration.obstacleMeshes = items;
					props.navMeshEditor.createDebugObstacles();
				}}
				renderItemEnd={(_mesh, obstacle) => (
					<select
						className="h-7 rounded border border-input bg-background px-1 text-xs"
						value={obstacle.type}
						onChange={(event) => updateObstacle(obstacle, "type", event.target.value as "box" | "cylinder")}
					>
						<option value="box">Box</option>
						<option value="cylinder">Cylinder</option>
					</select>
				)}
			/>

			<div className="max-h-64 space-y-2 overflow-y-auto">
				{props.navMeshEditor.configuration.obstacleMeshes.map((obstacle) => (
					<div key={obstacle.id} className="space-y-1 rounded-md border border-border p-2">
						<div className="truncate text-xs text-muted-foreground">{props.editor.layout.preview.scene.getNodeById(obstacle.id)?.name ?? obstacle.id}</div>
						<div className="grid grid-cols-3 gap-1">
							<Input
								defaultValue={String(obstacle.moveThreshold ?? 10)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Obstacle move threshold"
								onBlur={(event) => updateObstacle(obstacle, "moveThreshold", Number(event.target.value))}
							/>
							<Input
								defaultValue={String(obstacle.timeToStationary ?? 0.5)}
								type="number"
								min="0"
								step="any"
								aria-label="Obstacle stationary delay"
								onBlur={(event) => updateObstacle(obstacle, "timeToStationary", Number(event.target.value))}
							/>
							<Input
								defaultValue={String(obstacle.updateInterval ?? 0.1)}
								type="number"
								min="0.001"
								step="any"
								aria-label="Obstacle sample interval"
								onBlur={(event) => updateObstacle(obstacle, "updateInterval", Number(event.target.value))}
							/>
						</div>
						<div className="grid grid-cols-3 gap-1">
							<Button
								size="sm"
								variant={obstacle.carving === false ? "ghost" : "secondary"}
								onClick={() => updateObstacle(obstacle, "carving", obstacle.carving === false)}
							>
								Carve
							</Button>
							<Button
								size="sm"
								variant={obstacle.dynamic === false ? "ghost" : "secondary"}
								onClick={() => updateObstacle(obstacle, "dynamic", obstacle.dynamic === false)}
							>
								Dynamic
							</Button>
							<Button
								size="sm"
								variant={obstacle.carveOnlyStationary === false ? "ghost" : "secondary"}
								onClick={() => updateObstacle(obstacle, "carveOnlyStationary", obstacle.carveOnlyStationary === false)}
							>
								Stationary
							</Button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
