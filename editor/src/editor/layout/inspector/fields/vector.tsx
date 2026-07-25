import { useState } from "react";
import { MdOutlineInfo } from "react-icons/md";

import { IVector4Like } from "babylonjs";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../../ui/shadcn/ui/tooltip";

import { IEditorInspectorFieldProps } from "./field";
import { EditorInspectorNumberField } from "./number";
import { PrefabFieldOverrideActions, usePrefabFieldOverride } from "../prefab-property-overrides";

export interface IEditorInspectorVectorFieldProps extends IEditorInspectorFieldProps {
	step?: number;
	asDegrees?: boolean;

	grayLabel?: boolean;

	min?: number | number[];
	max?: number | number[];

	onChange?: () => void;
	onFinishChange?: () => void;
}

export function EditorInspectorVectorField(props: IEditorInspectorVectorFieldProps) {
	const prefab = usePrefabFieldOverride(props);
	const value = props.object[props.property] as IVector4Like;

	const [pointerOver, setPointerOver] = useState(false);

	return (
		<div
			className={`flex gap-2 items-center px-2 ${prefab.entry ? "border-l-2 border-blue-500 bg-blue-500/5" : ""}`}
			onMouseOver={() => setPointerOver(true)}
			onMouseLeave={() => setPointerOver(false)}
		>
			<div
				className={`
                    w-32
                    ${props.grayLabel && !pointerOver ? "text-muted" : ""}
                    transition-all duration-300 ease-in-out
                `}
			>
				<div className="flex gap-2 items-center">
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
			</div>
			<PrefabFieldOverrideActions {...prefab} />

			<div className="flex">
				<EditorInspectorNumberField
					object={props.object}
					property={`${props.property}.x`}
					prefabOverride={false}
					noUndoRedo={props.noUndoRedo}
					asDegrees={props.asDegrees}
					step={props.step}
					min={props.min?.[0] ?? props.min}
					max={props.max?.[0] ?? props.max}
					onChange={() => {
						props.onChange?.();
						prefab.notifyChanged();
					}}
					onFinishChange={() => props.onFinishChange?.()}
				/>

				<EditorInspectorNumberField
					object={props.object}
					property={`${props.property}.y`}
					prefabOverride={false}
					noUndoRedo={props.noUndoRedo}
					asDegrees={props.asDegrees}
					step={props.step}
					min={props.min?.[1] ?? props.min}
					max={props.max?.[1] ?? props.max}
					onChange={() => {
						props.onChange?.();
						prefab.notifyChanged();
					}}
					onFinishChange={() => props.onFinishChange?.()}
				/>

				{(value.z !== undefined || value.w !== undefined) && (
					<EditorInspectorNumberField
						object={props.object}
						property={`${props.property}.z`}
						prefabOverride={false}
						noUndoRedo={props.noUndoRedo}
						asDegrees={props.asDegrees}
						step={props.step}
						min={props.min?.[2] ?? props.min}
						max={props.max?.[2] ?? props.max}
						onChange={() => {
							props.onChange?.();
							prefab.notifyChanged();
						}}
						onFinishChange={() => props.onFinishChange?.()}
					/>
				)}

				{value.w !== undefined && (
					<EditorInspectorNumberField
						object={props.object}
						property={`${props.property}.w`}
						prefabOverride={false}
						noUndoRedo={props.noUndoRedo}
						asDegrees={props.asDegrees}
						step={props.step}
						min={props.min?.[3] ?? props.min}
						max={props.max?.[3] ?? props.max}
						onChange={() => {
							props.onChange?.();
							prefab.notifyChanged();
						}}
						onFinishChange={() => props.onFinishChange?.()}
					/>
				)}
			</div>
		</div>
	);
}
