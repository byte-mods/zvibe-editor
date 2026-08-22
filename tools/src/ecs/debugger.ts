import { ECSSystemPhase, IECSConfiguration, IECSSystemDefinition, normalizeECSConfiguration } from "./model";

export const ECS_MAX_SYSTEM_QUICK_SEARCH_LENGTH = 256;
export const ECS_MAX_SYSTEM_QUICK_FILTER_VALUES = 32;

export interface IECSSystemQuickFilterOptions {
	search?: string;
	namespaces?: string[];
	phases?: ECSSystemPhase[];
	enabled?: boolean;
	reads?: string[];
	writes?: string[];
	components?: string[];
	offset?: number;
	limit?: number;
}

interface IParsedECSSystemQuickSearch {
	terms: string[];
	namespaces: string[];
	phases: ECSSystemPhase[];
	enabled: boolean | null;
	reads: string[];
	writes: string[];
	components: string[];
}

const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const namespacePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const phases: readonly ECSSystemPhase[] = ["fixed", "update", "late"];

function unique(values: readonly string[], maximum: number, label: string, pattern: RegExp): string[] {
	if (values.length > maximum) {
		throw new Error(`${label} accepts at most ${maximum} values.`);
	}
	const normalized = values.map((value) => value.trim()).filter(Boolean);
	for (const value of normalized) {
		if (!pattern.test(value)) {
			throw new Error(`${label} contains invalid value "${value}".`);
		}
	}
	return [...new Set(normalized)];
}

function valuesAfterColon(value: string): string[] {
	return value
		.slice(value.indexOf(":") + 1)
		.replace(/^"|"$/g, "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** Parses the bounded Systems-window quick-search language used by both UI and MCP. */
export function parseECSSystemQuickSearch(value = ""): IParsedECSSystemQuickSearch {
	if (typeof value !== "string" || value.length > ECS_MAX_SYSTEM_QUICK_SEARCH_LENGTH || /[\0\r\n]/.test(value)) {
		throw new Error(`ECS Systems quick search must contain at most ${ECS_MAX_SYSTEM_QUICK_SEARCH_LENGTH} single-line characters.`);
	}
	const result: IParsedECSSystemQuickSearch = { terms: [], namespaces: [], phases: [], enabled: null, reads: [], writes: [], components: [] };
	const tokens = value.match(/[^\s"]+:"[^"]*"|\S+/g) ?? [];
	if (tokens.length > 32) {
		throw new Error("ECS Systems quick search accepts at most 32 tokens.");
	}
	for (const token of tokens) {
		if (!token.includes(":")) {
			result.terms.push(token.toLowerCase());
			continue;
		}
		const key = token.slice(0, token.indexOf(":")).toLowerCase();
		const values = valuesAfterColon(token);
		switch (key) {
			case "namespace":
			case "ns":
				result.namespaces.push(...unique(values, ECS_MAX_SYSTEM_QUICK_FILTER_VALUES, "namespace filter", namespacePattern));
				break;
			case "phase":
				for (const phase of values) {
					if (!phases.includes(phase as ECSSystemPhase)) {
						throw new Error(`ECS Systems quick search phase "${phase}" must be fixed, update, or late.`);
					}
					result.phases.push(phase as ECSSystemPhase);
				}
				break;
			case "enabled":
				if (values.length !== 1 || !["true", "false"].includes(values[0])) {
					throw new Error("ECS Systems quick search enabled filter must be true or false.");
				}
				result.enabled = values[0] === "true";
				break;
			case "reads":
				result.reads.push(...unique(values, ECS_MAX_SYSTEM_QUICK_FILTER_VALUES, "reads filter", identifierPattern));
				break;
			case "writes":
				result.writes.push(...unique(values, ECS_MAX_SYSTEM_QUICK_FILTER_VALUES, "writes filter", identifierPattern));
				break;
			case "component":
			case "has":
				result.components.push(...unique(values, ECS_MAX_SYSTEM_QUICK_FILTER_VALUES, "component filter", identifierPattern));
				break;
			default:
				throw new Error(`Unknown ECS Systems quick-search filter "${key}". Use namespace, phase, enabled, reads, writes, or component.`);
		}
	}
	result.namespaces = [...new Set(result.namespaces)];
	result.phases = [...new Set(result.phases)];
	result.reads = [...new Set(result.reads)];
	result.writes = [...new Set(result.writes)];
	result.components = [...new Set(result.components)];
	return result;
}

function namespaceMatches(namespace: string, filters: readonly string[]): boolean {
	return !filters.length || filters.some((filter) => namespace === filter || namespace.startsWith(`${filter}.`));
}

function componentIds(system: IECSSystemDefinition): Set<string> {
	return new Set([
		...system.query.all,
		...system.query.any,
		...system.query.none,
		...system.reads.map((reference) => reference.componentId),
		...system.writes.map((reference) => reference.componentId),
	]);
}

/** Returns a deterministic bounded Systems debugger page with namespace and quick filters. */
export function queryECSSystems(configurationValue: IECSConfiguration, options: IECSSystemQuickFilterOptions = {}): Record<string, unknown> {
	const configuration = normalizeECSConfiguration(configurationValue);
	const parsed = parseECSSystemQuickSearch(options.search ?? "");
	const namespaces = unique([...(options.namespaces ?? []), ...parsed.namespaces], ECS_MAX_SYSTEM_QUICK_FILTER_VALUES, "namespace filters", namespacePattern);
	const explicitPhases = options.phases ?? [];
	if (explicitPhases.length > 3 || explicitPhases.some((phase) => !phases.includes(phase))) {
		throw new Error("ECS Systems phases must be a unique subset of fixed, update, and late.");
	}
	const selectedPhases = [...new Set([...explicitPhases, ...parsed.phases])];
	const reads = unique([...(options.reads ?? []), ...parsed.reads], ECS_MAX_SYSTEM_QUICK_FILTER_VALUES, "reads filters", identifierPattern);
	const writes = unique([...(options.writes ?? []), ...parsed.writes], ECS_MAX_SYSTEM_QUICK_FILTER_VALUES, "writes filters", identifierPattern);
	const components = unique([...(options.components ?? []), ...parsed.components], ECS_MAX_SYSTEM_QUICK_FILTER_VALUES, "component filters", identifierPattern);
	const enabled = options.enabled ?? parsed.enabled;
	const matches = configuration.systems.filter((system) => {
		const searchable = `${system.id} ${system.name} ${system.namespace}`.toLowerCase();
		const systemComponents = componentIds(system);
		return (
			parsed.terms.every((term) => searchable.includes(term)) &&
			namespaceMatches(system.namespace, namespaces) &&
			(!selectedPhases.length || selectedPhases.includes(system.phase)) &&
			(enabled === null || enabled === undefined || system.enabled === enabled) &&
			reads.every((componentId) => system.reads.some((reference) => reference.componentId === componentId)) &&
			writes.every((componentId) => system.writes.some((reference) => reference.componentId === componentId)) &&
			components.every((componentId) => systemComponents.has(componentId))
		);
	});
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = Math.min(256, Math.max(1, Math.floor(options.limit ?? 100)));
	const page = matches.slice(offset, offset + limit).map((system) => structuredClone(system));
	return {
		filters: { terms: parsed.terms, namespaces, phases: selectedPhases, enabled, reads, writes, components },
		availableNamespaces: [...new Set(configuration.systems.map((system) => system.namespace))].sort(),
		total: matches.length,
		offset,
		limit,
		returned: page.length,
		hasMore: offset + page.length < matches.length,
		systems: page,
	};
}
