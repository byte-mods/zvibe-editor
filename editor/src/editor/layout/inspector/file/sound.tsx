import { basename } from "path/posix";

import { Divider } from "@blueprintjs/core";
import { BiSolidSpeaker } from "react-icons/bi";

import { FileInspectorObject } from "../file";

export interface IEditorInspectorSoundComponentProps {
	object: FileInspectorObject;
	importedPath?: string | null;
	importedCurrent?: boolean;
}

export function EditorInspectorSoundComponent(props: IEditorInspectorSoundComponentProps) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2 justify-center items-center text-xl font-bold">
				<BiSolidSpeaker size="24px" />
				{basename(props.object.absolutePath)}
			</div>

			<Divider />

			<div className="px-5 text-xs text-muted-foreground">{props.importedCurrent ? "Imported preview artifact" : "Original source preview"}</div>
			<audio key={props.importedCurrent ? props.importedPath : props.object.absolutePath} controls className="w-full px-5">
				<source src={props.importedCurrent && props.importedPath ? props.importedPath : props.object.absolutePath} />
			</audio>
		</div>
	);
}
