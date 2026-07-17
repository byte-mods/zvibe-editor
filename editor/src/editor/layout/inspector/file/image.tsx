import { basename } from "path/posix";

import { useState } from "react";
import { AiFillPicture } from "react-icons/ai";

import { Divider } from "@blueprintjs/core";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../../ui/shadcn/ui/table";

import { FileInspectorObject } from "../file";
import { ITextureImportResult } from "babylonjs-editor-tools";

export interface IEditorInspectorImageComponentProps {
	object: FileInspectorObject;
	importedPath?: string | null;
	importedCurrent?: boolean;
	result?: ITextureImportResult | null;
}

export function EditorInspectorImageComponent(props: IEditorInspectorImageComponentProps) {
	const [width, setWidth] = useState(0);
	const [height, setHeight] = useState(0);
	const source = props.importedCurrent && props.importedPath ? props.importedPath : props.object.absolutePath;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2 justify-center items-center text-xl font-bold">
				<AiFillPicture size="24px" />
				{basename(props.object.absolutePath)}
			</div>

			<Divider />
			<div className="px-5 text-xs text-muted-foreground">{props.importedCurrent ? "Imported preview artifact" : "Original source preview"}</div>

			<div className="w-full aspect-square p-5 rounded-lg bg-secondary dark:bg-secondary/35">
				<img
					key={source}
					alt=""
					draggable={false}
					src={source}
					className="w-full aspect-square object-contain"
					onLoad={(ev) => {
						setWidth(ev.currentTarget.naturalWidth);
						setHeight(ev.currentTarget.naturalHeight);
					}}
				/>
			</div>

			<div className="bg-secondary dark:bg-secondary/35 p-5 rounded-lg">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Property</TableHead>
							<TableHead>Value</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						<TableRow>
							<TableCell className="font-medium">Width</TableCell>
							<TableCell>{width}px</TableCell>
						</TableRow>
						<TableRow>
							<TableCell className="font-medium">Height</TableCell>
							<TableCell>{height}px</TableCell>
						</TableRow>
						{props.result && (
							<>
								<TableRow>
									<TableCell className="font-medium">Texture Type</TableCell>
									<TableCell>{props.result.settings.textureType}</TableCell>
								</TableRow>
								<TableRow>
									<TableCell className="font-medium">Sampling</TableCell>
									<TableCell>{props.result.effectiveColorSpace}</TableCell>
								</TableRow>
								<TableRow>
									<TableCell className="font-medium">Output</TableCell>
									<TableCell>
										{props.result.output.format.toUpperCase()} · {props.result.output.channels} channel(s)
									</TableCell>
								</TableRow>
								<TableRow>
									<TableCell className="font-medium">Mip levels</TableCell>
									<TableCell>{props.result.mipmaps.length}</TableCell>
								</TableRow>
								<TableRow>
									<TableCell className="font-medium">CPU Readable</TableCell>
									<TableCell>{props.result.readableBitmapPath ? "RGBA8 generated" : "No"}</TableCell>
								</TableRow>
							</>
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
