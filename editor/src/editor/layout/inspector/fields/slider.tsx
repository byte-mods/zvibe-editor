import { useEffect, useState } from "react";

import { MdOutlineInfo } from "react-icons/md";

import { Slider } from "../../../../ui/shadcn/ui/slider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../../ui/shadcn/ui/tooltip";

import { registerSimpleUndoRedo } from "../../../../tools/undoredo";
import { getInspectorPropertyValue } from "../../../../tools/property";

import { IEditorInspectorFieldProps } from "./field";
import { PrefabFieldOverrideActions, usePrefabFieldOverride } from "../prefab-property-overrides";

export interface IEditorInspectorSliderFieldProps extends IEditorInspectorFieldProps {
	min: number;
	max: number;
	step?: number;
	defaultValue?: number;
}

export function EditorInspectorSliderField(props: IEditorInspectorSliderFieldProps) {
	const prefab = usePrefabFieldOverride(props);
	const [value, setValue] = useState(0);
	const [oldValue, setOldValue] = useState(0);

	useEffect(() => {
		const v = getInspectorPropertyValue(props.object, props.property) ?? 0;
		setValue(v);
		setOldValue(v);
	}, [props.object, props.property, prefab.refreshVersion]);

	return (
		<div className={`flex gap-2 px-2 ${prefab.entry ? "border-l-2 border-blue-500 bg-blue-500/5" : ""}`}>
			{props.label && (
				<div className="flex items-center gap-2 text-ellipsis overflow-hidden whitespace-nowrap">
					<div className={prefab.entry ? "font-semibold text-blue-300" : ""}>{props.label}</div>

					{props.tooltip && (
						<TooltipProvider delayDuration={0}>
							<Tooltip>
								<TooltipTrigger>
									<MdOutlineInfo size={24} />
								</TooltipTrigger>
								<TooltipContent className="bg-background text-muted-foreground text-sm p-2">{props.tooltip}</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
				</div>
			)}
			<PrefabFieldOverrideActions {...prefab} />

			<Slider
				min={props.min}
				max={props.max}
				step={props.step ?? 0.01}
				value={[value]}
				className="flex-1 px-5 py-2"
				onDoubleClick={() => {
					if (props.defaultValue !== undefined) {
						props.object[props.property] = props.defaultValue;
						setValue(props.defaultValue);
						setOldValue(props.defaultValue);
						prefab.notifyChanged();
					}
				}}
				onValueChange={(result) => {
					const value = result[0];
					props.object[props.property] = value;
					setValue(value);
					prefab.notifyChanged();
				}}
				onValueCommit={(result) => {
					const value = result[0];
					props.object[props.property] = value;

					if (value !== oldValue) {
						registerSimpleUndoRedo({
							object: props.object,
							property: props.property,

							newValue: result,
							oldValue: oldValue,
						});

						setValue(value);
						setOldValue(value);
					}
				}}
			/>
		</div>
	);
}
