export type VisibleInInspectorDecoratorObject = {
	label?: string;
	propertyKey: string;
	configuration: VisibleInInspectorDecoratorConfiguration;

	defaultValue?: any;
};

export type VisibleInInspectorDecoratorConfiguration = {
	type: string;
	description?: string;

	min?: number;
	max?: number;
	step?: number;

	asDegrees?: boolean;

	noClamp?: boolean;
	noColorPicker?: boolean;

	acceptCubes?: boolean;
	onlyCubes?: boolean;

	elementType?: string;
	minItems?: number;
	maxItems?: number;
	defaultItem?: unknown;
	styleType?: string;
	style?: Record<string, unknown>;
};

export const scriptValues = "values";

function defaultCollectionItem(type: string | undefined, authored: unknown): unknown {
	if (authored !== undefined) {
		return structuredClone(authored);
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
	if (type === "vector3") {
		return [0, 0, 0];
	}
	if (type === "color3") {
		return [1, 1, 1];
	}
	if (type === "color4") {
		return [1, 1, 1, 1];
	}
	if (type === "texture") {
		return null;
	}
	return "";
}

export function computeDefaultValuesForObject(script: any, output: VisibleInInspectorDecoratorObject[]): void {
	script[scriptValues] ??= {};

	const attachedScripts = script[scriptValues];
	const existingKeys = Object.keys(attachedScripts);

	// Clean non existing values
	existingKeys.forEach((key) => {
		const existingOutput = output.find((value) => value.propertyKey === key);
		if (!existingOutput) {
			return delete attachedScripts[key];
		}
	});

	output.forEach((value) => {
		switch (value.configuration.type) {
			case "boolean":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: attachedScripts[value.propertyKey]?.value ?? value.defaultValue ?? false,
				};
				break;

			case "number":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: attachedScripts[value.propertyKey]?.value ?? value.defaultValue ?? value.configuration.min ?? value.configuration.max ?? 0,
				};
				break;

			case "string":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: attachedScripts[value.propertyKey]?.value ?? value.defaultValue ?? "",
				};
				break;

			case "vector2":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: [
						attachedScripts[value.propertyKey]?.value[0] ?? value.defaultValue?.[0] ?? value.configuration.min ?? value.configuration.max ?? 0,
						attachedScripts[value.propertyKey]?.value[1] ?? value.defaultValue?.[1] ?? value.configuration.min ?? value.configuration.max ?? 0,
					],
				};
				break;

			case "vector3":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: [
						attachedScripts[value.propertyKey]?.value[0] ?? value.defaultValue?.[0] ?? value.configuration.min ?? value.configuration.max ?? 0,
						attachedScripts[value.propertyKey]?.value[1] ?? value.defaultValue?.[1] ?? value.configuration.min ?? value.configuration.max ?? 0,
						attachedScripts[value.propertyKey]?.value[2] ?? value.defaultValue?.[2] ?? value.configuration.min ?? value.configuration.max ?? 0,
					],
				};
				break;

			case "color3":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: [
						attachedScripts[value.propertyKey]?.value[0] ?? value.defaultValue?.[0] ?? 1,
						attachedScripts[value.propertyKey]?.value[1] ?? value.defaultValue?.[1] ?? 1,
						attachedScripts[value.propertyKey]?.value[2] ?? value.defaultValue?.[2] ?? 1,
					],
				};
				break;

			case "color4":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: [
						attachedScripts[value.propertyKey]?.value[0] ?? value.defaultValue?.[0] ?? 1,
						attachedScripts[value.propertyKey]?.value[1] ?? value.defaultValue?.[1] ?? 1,
						attachedScripts[value.propertyKey]?.value[2] ?? value.defaultValue?.[2] ?? 1,
						attachedScripts[value.propertyKey]?.value[3] ?? value.defaultValue?.[3] ?? 1,
					],
				};
				break;

			case "keymap":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: attachedScripts[value.propertyKey]?.value ?? value.defaultValue ?? 0,
				};
				break;

			case "entity":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: attachedScripts[value.propertyKey]?.value ?? null,
				};
				break;

			case "texture":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: attachedScripts[value.propertyKey]?.value ?? null,
				};
				break;

			case "asset":
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: attachedScripts[value.propertyKey]?.value ?? null,
				};
				break;

			case "array":
			case "list": {
				const maximum = Math.max(1, Math.min(256, value.configuration.maxItems ?? 64));
				const minimum = Math.max(0, Math.min(maximum, value.configuration.minItems ?? 0));
				const authored = Array.isArray(attachedScripts[value.propertyKey]?.value)
					? attachedScripts[value.propertyKey].value
					: Array.isArray(value.defaultValue)
						? value.defaultValue
						: [];
				const normalized = structuredClone(authored.slice(0, maximum));
				while (normalized.length < minimum) {
					normalized.push(defaultCollectionItem(value.configuration.elementType, value.configuration.defaultItem));
				}
				attachedScripts[value.propertyKey] = {
					type: value.configuration.type,
					description: value.configuration.description,
					value: normalized,
				};
				break;
			}
		}
	});
}
