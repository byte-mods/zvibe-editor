import { EditorProjectServicesSettings } from "../dialogs/edit-project/services";
import { Editor } from "../main";

export interface IEditorProjectServicesProps {
	editor: Editor;
}

/** Permanent hosted-services authoring, local-emulation, readiness, and deployment workspace. */
export function EditorProjectServices(props: IEditorProjectServicesProps): JSX.Element {
	return (
		<div className="h-full overflow-auto bg-background p-3 text-foreground" data-project-services-panel>
			<EditorProjectServicesSettings editor={props.editor} />
		</div>
	);
}
