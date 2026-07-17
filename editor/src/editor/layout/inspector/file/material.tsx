import { basename } from "path/posix";

import { Divider } from "@blueprintjs/core";
import { BiPalette } from "react-icons/bi";

import { IMaterialImporterArtifactStatus } from "../../../../mcp/assets/material-importer";
import { FileInspectorObject } from "../file";

export interface IEditorInspectorMaterialComponentProps {
	object: FileInspectorObject;
	artifact: IMaterialImporterArtifactStatus | null;
}

export function EditorInspectorMaterialComponent(props: IEditorInspectorMaterialComponentProps) {
	const result = props.artifact?.current ? props.artifact.result : null;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2 justify-center items-center text-xl font-bold">
				<BiPalette size="24px" />
				{basename(props.object.absolutePath)}
			</div>
			<Divider />
			{!result && <div className="px-5 text-xs text-muted-foreground">Apply the Material Importer to validate textures and compile Node Material graphs.</div>}
			{result && (
				<div className="mx-5 flex flex-col gap-2 rounded bg-input p-3 text-xs">
					<div className={result.valid ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>
						{result.valid ? "Valid imported material" : "Material importer reported errors"} · {result.sourceKind}
					</div>
					<div>
						{result.textureReferences.length} texture reference(s) · {result.missingTextures.length} missing · {result.extractedTextures.length} extracted
					</div>
					<div>
						Node compile:{" "}
						{result.compile.attempted
							? result.compile.valid
								? `passed · ${result.compile.statistics?.compiledShaderCharacters ?? 0} shader characters`
								: "failed"
							: "not applicable"}
					</div>
					{result.errors.map((error) => (
						<div key={error} className="text-red-400 break-all">
							{error}
						</div>
					))}
					{result.warnings.map((warning) => (
						<div key={warning} className="text-amber-300 break-all">
							{warning}
						</div>
					))}
					{result.textureReferences.map((reference) => (
						<div key={`${reference.kind}:${reference.value}`} className={reference.exists === false ? "text-red-400 break-all" : "text-muted-foreground break-all"}>
							{reference.kind.toUpperCase()} · {reference.resolvedPath ?? reference.value}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
