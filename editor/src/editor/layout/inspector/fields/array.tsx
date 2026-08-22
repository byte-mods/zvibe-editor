import { CSSProperties, ReactNode, useEffect, useState } from "react";

import { IVisibleInInspectorCollectionStyle, VisibleInInspectorCollectionElementType } from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { getInspectorPropertyValue, setInspectorEffectivePropertyValue } from "../../../../tools/property";
import { registerSimpleUndoRedo } from "../../../../tools/undoredo";

import { IEditorInspectorFieldProps, matchesInspectorSearch } from "./field";
import { getInspectorCollectionStyle } from "./collection-style";

export interface IEditorInspectorArrayFieldProps extends IEditorInspectorFieldProps {
	elementType: VisibleInInspectorCollectionElementType;
	collectionKind: "array" | "list";
	minItems?: number;
	maxItems?: number;
	defaultItem?: unknown;
	styleType?: string;
	style?: IVisibleInInspectorCollectionStyle;
	onChange?: (value: unknown[], oldValue: unknown[]) => void;
}

interface IStructuredCollectionItemEditorProps {
	index: number;
	value: unknown;
	onCommit: (value: unknown) => void;
}

function StructuredCollectionItemEditor(props: IStructuredCollectionItemEditorProps): ReactNode {
	const serialized = JSON.stringify(props.value, null, 2) ?? "null";
	const [draft, setDraft] = useState(serialized);
	const [valid, setValid] = useState(true);
	useEffect(() => {
		setDraft(serialized);
		setValid(true);
	}, [serialized]);
	return (
		<textarea
			aria-label={`Item ${props.index}`}
			aria-invalid={!valid}
			className={`min-h-16 flex-1 rounded border bg-input p-2 font-mono text-xs ${valid ? "border-transparent" : "border-destructive"}`}
			value={draft}
			onChange={(event) => {
				const next = event.currentTarget.value;
				setDraft(next);
				try {
					props.onCommit(JSON.parse(next));
					setValid(true);
				} catch {
					setValid(false);
				}
			}}
		/>
	);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function defaultValue(type: VisibleInInspectorCollectionElementType, authored: unknown): unknown {
	if (authored !== undefined) {
		return clone(authored);
	}
	if (type === "boolean") {
		return false;
	}
	if (type === "number" || type === "keymap") {
		return 0;
	}
	if (type === "vector2") {
		return [0, 0];
	}
	if (type === "vector3" || type === "color3") {
		return type === "color3" ? [1, 1, 1] : [0, 0, 0];
	}
	if (type === "color4") {
		return [1, 1, 1, 1];
	}
	if (type === "texture") {
		return null;
	}
	return "";
}

/** Renders a bounded, reorderable typed list/array with DataTypeStyleMapper-compatible visual treatment. */
export function EditorInspectorArrayField(props: IEditorInspectorArrayFieldProps): ReactNode {
	const read = (): unknown[] => {
		const value = getInspectorPropertyValue(props.object, props.property);
		return Array.isArray(value) ? clone(value) : [];
	};
	const [items, setItems] = useState<unknown[]>(read);
	const maximum = Math.max(1, Math.min(256, props.maxItems ?? 64));
	const minimum = Math.max(0, Math.min(maximum, props.minItems ?? 0));
	const style = getInspectorCollectionStyle(props.elementType, props.styleType, props.style);

	useEffect(() => setItems(read()), [props.object, props.property]);

	const publish = (next: unknown[]): void => {
		const oldValue = read();
		const normalized = clone(next.slice(0, maximum));
		setInspectorEffectivePropertyValue(props.object, props.property, normalized);
		setItems(normalized);
		props.onChange?.(normalized, oldValue);
		if (!props.noUndoRedo) {
			registerSimpleUndoRedo({ object: props.object, property: props.property, oldValue, newValue: normalized });
		}
	};
	const replace = (index: number, value: unknown): void => publish(items.map((item, itemIndex) => (itemIndex === index ? value : item)));
	const move = (index: number, delta: number): void => {
		const destination = index + delta;
		if (destination < 0 || destination >= items.length) {
			return;
		}
		const next = clone(items);
		[next[index], next[destination]] = [next[destination], next[index]];
		publish(next);
	};
	const rowStyle: CSSProperties = { borderLeftColor: style.accentColor };
	const density = style.density === "compact" ? "p-1" : style.density === "comfortable" ? "p-3" : "p-2";
	const variant = style.variant === "cards" ? "rounded bg-muted-foreground/10" : style.variant === "outlined" ? "rounded border border-border" : "";

	const editor = (item: unknown, index: number): ReactNode => {
		if (props.elementType === "boolean") {
			return <input aria-label={`Item ${index}`} type="checkbox" checked={item === true} onChange={(event) => replace(index, event.currentTarget.checked)} />;
		}
		if (props.elementType === "number" || props.elementType === "keymap") {
			return (
				<Input
					aria-label={`Item ${index}`}
					type="number"
					value={typeof item === "number" ? item : 0}
					onChange={(event) => replace(index, Number(event.currentTarget.value))}
				/>
			);
		}
		if (["string", "entity", "asset"].includes(props.elementType)) {
			return (
				<Input
					aria-label={`Item ${index}`}
					value={typeof item === "string" || typeof item === "number" ? String(item) : ""}
					onChange={(event) => replace(index, event.currentTarget.value)}
				/>
			);
		}
		const componentCounts: Partial<Record<VisibleInInspectorCollectionElementType, number>> = { vector2: 2, vector3: 3, color3: 3, color4: 4 };
		const componentCount = componentCounts[props.elementType];
		if (componentCount) {
			const components = Array.isArray(item) ? item : [];
			return (
				<div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${componentCount}, minmax(0, 1fr))` }}>
					{Array.from({ length: componentCount }, (_, componentIndex) => (
						<Input
							key={componentIndex}
							aria-label={`Item ${index} component ${componentIndex}`}
							type="number"
							step="any"
							value={typeof components[componentIndex] === "number" ? components[componentIndex] : 0}
							onChange={(event) => {
								const next = Array.from({ length: componentCount }, (_, currentIndex) =>
									currentIndex === componentIndex
										? Number(event.currentTarget.value)
										: typeof components[currentIndex] === "number"
											? components[currentIndex]
											: 0
								);
								replace(index, next);
							}}
						/>
					))}
				</div>
			);
		}
		return <StructuredCollectionItemEditor index={index} value={item} onCommit={(value) => replace(index, value)} />;
	};
	if (!matchesInspectorSearch(props.label, props.property, props.tooltip)) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2 px-2" data-collection-kind={props.collectionKind} data-style-type={style.styleType}>
			<div className="flex items-center justify-between border-l-4 pl-2" style={rowStyle}>
				<div className="min-w-0 truncate">
					<span className="mr-2" aria-hidden="true">
						{style.icon}
					</span>
					{props.label ?? props.property} ({items.length})
				</div>
				<Button size="sm" disabled={items.length >= maximum} onClick={() => publish([...items, defaultValue(props.elementType, props.defaultItem)])}>
					Add
				</Button>
			</div>
			{items.length === 0 && <div className="rounded border border-dashed p-3 text-center text-muted-foreground">Empty {props.collectionKind}</div>}
			{items.map((item, index) => (
				<div
					key={index}
					className={`flex items-center gap-2 border-l-4 ${density} ${variant} ${style.striped && index % 2 ? "bg-muted-foreground/5" : ""}`}
					style={rowStyle}
				>
					{style.showIndices && <div className="w-8 shrink-0 text-right text-muted-foreground">{index}</div>}
					<div className="min-w-0 flex-1">{editor(item, index)}</div>
					<div className="flex shrink-0 gap-1">
						<Button size="sm" variant="secondary" disabled={index === 0} onClick={() => move(index, -1)}>
							↑
						</Button>
						<Button size="sm" variant="secondary" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
							↓
						</Button>
						<Button size="sm" variant="destructive" disabled={items.length <= minimum} onClick={() => publish(items.filter((_, itemIndex) => itemIndex !== index))}>
							×
						</Button>
					</div>
				</div>
			))}
		</div>
	);
}
