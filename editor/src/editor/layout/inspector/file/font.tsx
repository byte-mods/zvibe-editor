import { basename } from "path/posix";

import { Divider } from "@blueprintjs/core";
import { BiFont } from "react-icons/bi";

import { IFontImporterArtifactStatus } from "../../../../mcp/assets/font-importer";
import { FileInspectorObject } from "../file";

export interface IEditorInspectorFontComponentProps {
	object: FileInspectorObject;
	artifact: IFontImporterArtifactStatus | null;
}

export function EditorInspectorFontComponent(props: IEditorInspectorFontComponentProps) {
	const result = props.artifact?.current ? props.artifact.result : null;
	const family = result?.family ?? `Preview-${basename(props.object.absolutePath).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
	const dynamicPath = result?.dynamicFontPath ?? props.object.absolutePath;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2 justify-center items-center text-xl font-bold">
				<BiFont size="24px" />
				{basename(props.object.absolutePath)}
			</div>
			<Divider />
			<div className="px-5 text-xs text-muted-foreground">{result ? `Imported ${result.renderMode.toUpperCase()} artifact` : "Original dynamic font preview"}</div>
			{(!result || result.renderMode === "dynamic") && (
				<>
					<style>{`@font-face { font-family: "${family}"; src: url("${dynamicPath.replace(/"/g, '\\"')}"); }`}</style>
					<div className="mx-5 rounded bg-input p-4 text-3xl break-words" style={{ fontFamily: `"${family}"` }}>
						ABC abc 0123 · The quick brown fox jumps over the lazy dog.
					</div>
				</>
			)}
			{result && result.renderMode !== "dynamic" && result.pages[0] && (
				<>
					<img className="mx-5 max-h-80 object-contain rounded bg-black/80 [image-rendering:auto]" src={result.pages[0].path} />
					<div className="px-5 text-xs text-muted-foreground">
						{result.glyphCount} glyphs · {result.pages.length} page(s) · {result.pages[0].width}×{result.pages[0].height}
					</div>
				</>
			)}
		</div>
	);
}
