import { useState } from "react";

import { AbstractMesh } from "babylonjs";

import { Editor } from "../../main";

import { NavMeshEditorListComponent } from "./components/list";
import { NavMeshEditorSearchComponent } from "./components/search";

import { NavMeshEditor } from "./editor";
import { INavMeshStaticMeshConfiguration } from "./types";
import { getNavMeshAreaColor } from "./debug";

export interface INavMeshEditorMeshesListProps {
	editor: Editor;
	navMeshEditor: NavMeshEditor;
}

export function NavMeshEditorMeshesList(props: INavMeshEditorMeshesListProps) {
	const [search, setSearch] = useState("");
	const areas = (props.navMeshEditor.configuration.areas ??= [{ id: 0, name: "Walkable", cost: 1 }]);

	function handleSetSurfaceArea(item: INavMeshStaticMeshConfiguration, area: number): void {
		item.area = area;
		props.navMeshEditor.configuration.surfaceAreaEncoding = undefined;
		props.navMeshEditor.updateNavMesh();
		props.navMeshEditor.forceUpdate();
	}

	return (
		<div className="flex flex-col gap-2 w-80 h-full p-2">
			<div className="flex justify-between items-center h-10">
				<div>Static meshes</div>

				<NavMeshEditorSearchComponent search={search} setSearch={setSearch} />
			</div>

			<NavMeshEditorListComponent<INavMeshStaticMeshConfiguration>
				search={search}
				scene={props.editor.layout.preview.scene}
				items={props.navMeshEditor.configuration.staticMeshes}
				onCreateItem={(mesh: AbstractMesh) => ({
					id: mesh.id,
					enabled: true,
					area: 0,
				})}
				renderItemEnd={(_mesh, item) => (
					<div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
						<div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getNavMeshAreaColor(item.area ?? 0).toHexString() }} />
						<select
							className="h-7 max-w-28 rounded border border-white/15 bg-black/50 px-1 text-xs"
							value={item.area ?? 0}
							aria-label={`NavMesh surface area for ${item.id}`}
							onChange={(event) => handleSetSurfaceArea(item, Number(event.target.value))}
						>
							{areas.map((area) => (
								<option key={area.id} value={area.id}>
									{area.name}
								</option>
							))}
						</select>
					</div>
				)}
				onItemsChange={(items, updateNavMesh) => {
					props.navMeshEditor.configuration.staticMeshes = items;

					if (updateNavMesh) {
						props.navMeshEditor.updateNavMesh();
					} else {
						props.navMeshEditor.forceUpdate();
					}
				}}
			/>
		</div>
	);
}
