import { basename } from "path/posix";

import { Divider } from "@blueprintjs/core";
import { BiSolidVideos } from "react-icons/bi";

import { FileInspectorObject } from "../file";

export interface IEditorInspectorVideoComponentProps {
	object: FileInspectorObject;
	importedPath?: string | null;
	importedCurrent?: boolean;
}

export function EditorInspectorVideoComponent(props: IEditorInspectorVideoComponentProps) {
	const source = props.importedCurrent && props.importedPath ? props.importedPath : props.object.absolutePath;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2 justify-center items-center text-xl font-bold">
				<BiSolidVideos size="24px" />
				{basename(props.object.absolutePath)}
			</div>
			<Divider />
			<div className="px-5 text-xs text-muted-foreground">{props.importedCurrent ? "Imported preview artifact" : "Original source preview"}</div>
			<video key={source} controls className="w-full max-h-80 px-5" src={source} />
		</div>
	);
}
