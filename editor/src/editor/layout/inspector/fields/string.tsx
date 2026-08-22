import { useEffect, useState } from "react";
import { MdOutlineInfo } from "react-icons/md";

import { Textarea } from "../../../../ui/shadcn/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../../ui/shadcn/ui/tooltip";

import { registerSimpleUndoRedo } from "../../../../tools/undoredo";
import { getInspectorPropertyValue, setInspectorEffectivePropertyValue } from "../../../../tools/property";

import { IEditorInspectorFieldProps, matchesInspectorSearch } from "./field";
import { PrefabFieldOverrideActions, usePrefabFieldOverride } from "../prefab-property-overrides";

export interface IEditorInspectorStringFieldProps extends IEditorInspectorFieldProps {
	multiline?: boolean;
	onChange?: (value: string) => void;
}

export function EditorInspectorStringField(props: IEditorInspectorStringFieldProps) {
	const prefab = usePrefabFieldOverride(props);
	const [value, setValue] = useState<string>(getInspectorPropertyValue(props.object, props.property) ?? "");
	const [oldValue, setOldValue] = useState<string>(getInspectorPropertyValue(props.object, props.property) ?? "");

	useEffect(() => {
		setValue(getInspectorPropertyValue(props.object, props.property) ?? "");
		setOldValue(getInspectorPropertyValue(props.object, props.property) ?? "");
	}, [props.object, props.property, prefab.refreshVersion]);

	function handleChange(newValue: string) {
		setValue(newValue);
		setInspectorEffectivePropertyValue(props.object, props.property, newValue);

		props.onChange?.(newValue);
		prefab.notifyChanged();
	}

	function handleBlur(newValue: string) {
		if (newValue !== oldValue && !props.noUndoRedo) {
			registerSimpleUndoRedo({
				object: props.object,
				property: props.property,

				oldValue,
				newValue: value,
			});

			setOldValue(newValue);
		}
	}
	if (!matchesInspectorSearch(props.label, props.property, props.tooltip)) {
		return null;
	}

	return (
		<div className={`flex gap-2 items-center px-2 ${prefab.entry ? "border-l-2 border-blue-500 bg-blue-500/5" : ""}`}>
			<div className="flex items-center gap-2 w-1/3 text-ellipsis overflow-hidden whitespace-nowrap">
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
			<PrefabFieldOverrideActions {...prefab} />

			{!props.multiline && (
				<input
					type="text"
					value={value}
					onChange={(ev) => handleChange(ev.currentTarget.value)}
					onKeyUp={(ev) => ev.key === "Enter" && ev.currentTarget.blur()}
					onBlur={(ev) => handleBlur(ev.currentTarget.value)}
					className="px-5 py-2 rounded-lg bg-muted-foreground/10 outline-none w-2/3"
				/>
			)}

			{props.multiline && (
				<Textarea
					value={value}
					onChange={(ev) => handleChange(ev.currentTarget.value)}
					onBlur={(ev) => handleBlur(ev.currentTarget.value)}
					className="px-5 py-2 rounded-lg bg-black/50 text-white/75 outline-none w-2/3"
				/>
			)}
		</div>
	);
}
