import { ILocalizationPseudoLocale } from "./localization-model";

export type LocalizationSmartValue = null | boolean | number | string | LocalizationSmartValue[] | { [key: string]: LocalizationSmartValue };

function select(value: LocalizationSmartValue, selector: string): LocalizationSmartValue {
	const parts = selector.trim().split(".");
	let current: LocalizationSmartValue = value;
	for (const part of parts) {
		if (!/^[A-Za-z_$][\w$]*$|^\d+$/.test(part)) {
			throw new Error(`Smart String selector is invalid: ${selector}`);
		}
		if (Array.isArray(current) && /^\d+$/.test(part)) {
			current = current[Number(part)];
		} else if (current && typeof current === "object" && !Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, part)) {
			current = current[part];
		} else {
			throw new Error(`Smart String selector was not found: ${selector}`);
		}
	}
	return current;
}

function optionText(options: string[], index: number, value: LocalizationSmartValue): string {
	return (options[Math.min(index, options.length - 1)] ?? "").replace(/\{\}|#/g, String(value ?? ""));
}

function formatPlaceholder(content: string, argumentsValue: LocalizationSmartValue, locale: string): string {
	const firstColon = content.indexOf(":");
	const selector = firstColon < 0 ? content : content.slice(0, firstColon);
	const value = select(argumentsValue, selector || "0");
	if (firstColon < 0) {
		return String(value ?? "");
	}
	const format = content.slice(firstColon + 1);
	const secondColon = format.indexOf(":");
	const formatter = (secondColon < 0 ? format : format.slice(0, secondColon)).trim();
	const payload = secondColon < 0 ? "" : format.slice(secondColon + 1);
	if (formatter === "plural" || formatter === "p") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error("Plural formatter requires a finite number.");
		}
		const options = payload.split("|");
		if (options.length < 2 || options.length > 6) {
			throw new Error("Plural formatter requires 2-6 forms.");
		}
		const category = new Intl.PluralRules(locale).select(value);
		const named = new Map(
			options
				.filter((entry) => entry.includes("="))
				.map((entry): [string, string] => {
					const separator = entry.indexOf("=", entry.startsWith("=") ? 1 : 0);
					return [entry.slice(0, separator), entry.slice(separator + 1)];
				})
		);
		if (named.size) {
			return (named.get(`=${value}`) ?? named.get(category) ?? named.get("other") ?? "").replace(/\{\}|#/g, String(value));
		}
		if (options.length === 2) {
			return optionText(options, category === "one" ? 0 : 1, value);
		}
		const order = ["zero", "one", "two", "few", "many", "other"];
		return optionText(options, Math.min(order.indexOf(category), options.length - 1), value);
	}
	const choose = formatter.match(/^(?:choose|c)\(([^)]*)\)$/);
	if (choose) {
		const matches = choose[1].split("|");
		const options = payload.split("|");
		const index = matches.findIndex((candidate) => candidate.trim() === String(value));
		return optionText(options, index < 0 ? matches.length : index, value);
	}
	if (formatter === "number" || /^number\([A-Z]{3}\)$/.test(formatter)) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error("Number formatter requires a finite number.");
		}
		const currency = formatter.match(/^number\(([A-Z]{3})\)$/)?.[1];
		return new Intl.NumberFormat(locale, currency ? { style: "currency", currency } : undefined).format(value);
	}
	if (formatter === "date" || formatter === "time") {
		const date = new Date(typeof value === "number" || typeof value === "string" ? value : "");
		if (!Number.isFinite(date.getTime())) {
			throw new Error(`${formatter} formatter requires an ISO string or epoch number.`);
		}
		return formatter === "date" ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date) : new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(date);
	}
	if (formatter === "list") {
		if (!Array.isArray(value)) {
			throw new Error("List formatter requires an array.");
		}
		return new Intl.ListFormat(locale).format(value.map((entry) => String(entry ?? "")));
	}
	throw new Error(`Smart String formatter is unsupported: ${formatter}`);
}

/** Validates Smart String selectors and formatter syntax without requiring runtime argument values. */
export function validateLocalizationStringTemplate(template: string): void {
	if (template.length > 32_768) {
		throw new Error("Smart String template exceeds 32,768 characters.");
	}
	let placeholders = 0;
	for (let index = 0; index < template.length; index++) {
		if (template[index] === "}") {
			throw new Error("Smart String contains an unmatched closing brace.");
		}
		if (template[index] !== "{") {
			continue;
		}
		let depth = 1;
		let end = index + 1;
		for (; end < template.length && depth; end++) {
			if (template[end] === "{") {
				depth++;
			} else if (template[end] === "}") {
				depth--;
			}
		}
		end--;
		if (depth) {
			throw new Error("Smart String contains an unmatched opening brace.");
		}
		const content = template.slice(index + 1, end);
		if (!content) {
			index = end;
			continue;
		}
		if (++placeholders > 256) {
			throw new Error("Smart String supports at most 256 placeholders.");
		}
		const firstColon = content.indexOf(":");
		const selector = (firstColon < 0 ? content : content.slice(0, firstColon)).trim() || "0";
		if (!selector.split(".").every((part) => /^[A-Za-z_$][\w$]*$|^\d+$/.test(part))) {
			throw new Error(`Smart String selector is invalid: ${selector}`);
		}
		if (firstColon >= 0) {
			const format = content.slice(firstColon + 1);
			const secondColon = format.indexOf(":");
			const formatter = (secondColon < 0 ? format : format.slice(0, secondColon)).trim();
			const payload = secondColon < 0 ? "" : format.slice(secondColon + 1);
			if (formatter === "plural" || formatter === "p") {
				const options = payload.split("|");
				if (options.length < 2 || options.length > 6) {
					throw new Error("Plural formatter requires 2-6 forms.");
				}
			} else {
				const choose = formatter.match(/^(?:choose|c)\(([^)]*)\)$/);
				if (choose) {
					const matches = choose[1].split("|");
					const options = payload.split("|");
					if (matches.some((match) => !match.trim()) || matches.length > 16 || options.length !== matches.length + 1) {
						throw new Error("Choose formatter requires 1-16 matches and exactly one fallback form.");
					}
				} else if (!(["number", "date", "time", "list"] as string[]).includes(formatter) && !/^number\([A-Z]{3}\)$/.test(formatter)) {
					throw new Error(`Smart String formatter is unsupported: ${formatter}`);
				}
			}
		}
		index = end;
	}
}

/** Formats bounded data-only Smart Strings without reflection or executable selectors. */
export function formatLocalizationString(template: string, argumentsValue: LocalizationSmartValue, locale: string): string {
	if (template.length > 32_768) {
		throw new Error("Smart String template exceeds 32,768 characters.");
	}
	let result = "";
	let placeholders = 0;
	for (let index = 0; index < template.length; index++) {
		if (template[index] === "}") {
			throw new Error("Smart String contains an unmatched closing brace.");
		}
		if (template[index] !== "{") {
			result += template[index];
			continue;
		}
		let depth = 1;
		let end = index + 1;
		for (; end < template.length && depth; end++) {
			if (template[end] === "{") {
				depth++;
			} else if (template[end] === "}") {
				depth--;
			}
		}
		end--;
		if (end < 0) {
			throw new Error("Smart String contains an unmatched opening brace.");
		}
		if (depth) {
			throw new Error("Smart String contains an unmatched opening brace.");
		}
		const content = template.slice(index + 1, end);
		if (!content) {
			result += "{}";
			index = end;
			continue;
		}
		if (++placeholders > 256) {
			throw new Error("Smart String supports at most 256 placeholders.");
		}
		result += formatPlaceholder(content, argumentsValue, locale);
		index = end;
	}
	return result;
}

const accents: Record<string, string> = { a: "à", e: "ë", i: "ï", o: "ô", u: "ü", A: "À", E: "Ë", I: "Ï", O: "Ô", U: "Ü" };

/** Applies deterministic expansion/accent/mirroring while preserving Smart String placeholders. */
export function pseudoLocalizeString(value: string, settings: ILocalizationPseudoLocale): string {
	const parts = value.split(/(\{[^{}]*\})/g);
	const transformed = parts
		.map((part) => (part.startsWith("{") ? part : settings.accent ? part.replace(/[aeiouAEIOU]/g, (character) => accents[character] ?? character) : part))
		.join("");
	const expansion = Math.ceil((Array.from(value).length * settings.expansionPercent) / 100);
	const expanded = `${transformed}${"~".repeat(expansion)}`;
	const wrapped = settings.wrap ? `[${expanded}]` : expanded;
	return settings.mirror ? `\u202e${wrapped}\u202c` : wrapped;
}
