import { lstat, readFile, realpath } from "fs/promises";
import { join } from "path";

import { satisfies, valid, validRange, maxSatisfying, gt, diff, rcompare } from "semver";
import { parse as parseYaml } from "yaml";

import { IMCPActionOptions } from "../../action";
import { getProjectPackageContext, packageSha256 } from "./context";
import { getProjectPackageRegistryMetadata } from "./registry";
import { validateProjectPackageName } from "./process";
import { IProjectPackageContext, IProjectPackageFileEvidence, ProjectPackageDependencyType } from "./types";
import { projectPathContains } from "../project-store";

const maximumDependencyNodes = 20_000;
const maximumDependencyEdges = 50_000;
const maximumLockfileBytes = 32 * 1024 * 1024;
const dependencyTypes: ProjectPackageDependencyType[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

interface IProjectPackageDependencyNode {
	id: string;
	name: string;
	version: string | null;
	path: string;
	source: "lockfile" | "node_modules";
	integrity: string | null;
	direct: boolean;
	dependencyTypes: ProjectPackageDependencyType[];
	dependencies: Record<string, string>;
}

interface IProjectPackageDependencyEdge {
	from: string;
	to: string | null;
	name: string;
	requested: string;
	missing: boolean;
}

interface IProjectPackageDependencyGraph {
	format: IProjectPackageFileEvidence["format"] | "node_modules" | "manifest-only";
	lockfile: IProjectPackageFileEvidence | null;
	nodes: IProjectPackageDependencyNode[];
	edges: IProjectPackageDependencyEdge[];
	warnings: string[];
	truncated: boolean;
}

interface IParsedLockNode {
	id: string;
	name: string;
	version: string | null;
	path: string;
	integrity: string | null;
	dependencies: Record<string, string>;
}

function pagination(data: any, maximumLimit = 500): { offset: number; limit: number } {
	const offset = data?.offset ?? 0;
	const limit = data?.limit ?? Math.min(100, maximumLimit);
	if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
		throw new Error("offset must be an integer from 0 through 1000000.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > maximumLimit) {
		throw new Error(`limit must be an integer from 1 through ${maximumLimit}.`);
	}
	return { offset, limit };
}

function dependencyRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter((entry): entry is [string, string] => typeof entry[1] === "string" || (Boolean(entry[1]) && typeof entry[1] === "object"))
			.slice(0, 10_000)
			.map(([name, specification]) => [
				name,
				typeof specification === "string" ? specification : String((specification as any).version ?? (specification as any).specifier ?? ""),
			])
	);
}

function nameFromPackagePath(path: string): string | null {
	const segments = path.replace(/\\/g, "/").split("/");
	const index = segments.lastIndexOf("node_modules");
	if (index < 0 || !segments[index + 1]) {
		return null;
	}
	return segments[index + 1].startsWith("@") && segments[index + 2] ? `${segments[index + 1]}/${segments[index + 2]}` : segments[index + 1];
}

function parentPackagePath(path: string): string | null {
	const normalized = path.replace(/\\/g, "/");
	const index = normalized.lastIndexOf("/node_modules/");
	if (index >= 0) {
		return normalized.slice(0, index);
	}
	return normalized.startsWith("node_modules/") ? "" : null;
}

function resolvePackageLockDependency(nodesByPath: Map<string, IParsedLockNode>, fromPath: string, dependencyName: string): IParsedLockNode | null {
	let current: string | null = fromPath;
	while (current !== null) {
		const candidate = `${current ? `${current}/` : ""}node_modules/${dependencyName}`;
		const found = nodesByPath.get(candidate);
		if (found) {
			return found;
		}
		current = parentPackagePath(current);
	}
	return nodesByPath.get(`node_modules/${dependencyName}`) ?? null;
}

function parsePackageLock(bytes: Buffer): { nodes: IParsedLockNode[]; resolve: (from: IParsedLockNode | null, name: string, requested: string) => IParsedLockNode | null } {
	let lock: any;
	try {
		lock = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("npm lockfile is malformed JSON.");
	}
	const nodes: IParsedLockNode[] = [];
	const nodesByPath = new Map<string, IParsedLockNode>();
	if (lock?.packages && typeof lock.packages === "object") {
		for (const [path, raw] of Object.entries<any>(lock.packages)) {
			if (!path || !raw || typeof raw !== "object") {
				continue;
			}
			const name = typeof raw.name === "string" ? raw.name : nameFromPackagePath(path);
			if (!name) {
				continue;
			}
			const node: IParsedLockNode = {
				id: `npm:${path}`,
				name,
				version: typeof raw.version === "string" ? raw.version : null,
				path,
				integrity: typeof raw.integrity === "string" ? raw.integrity : null,
				dependencies: dependencyRecord({ ...(raw.dependencies ?? {}), ...(raw.optionalDependencies ?? {}) }),
			};
			nodes.push(node);
			nodesByPath.set(path, node);
			if (nodes.length >= maximumDependencyNodes) {
				break;
			}
		}
		return { nodes, resolve: (from, name) => resolvePackageLockDependency(nodesByPath, from?.path ?? "", name) };
	}
	function visit(name: string, raw: any, path: string): void {
		if (nodes.length >= maximumDependencyNodes || !raw || typeof raw !== "object") {
			return;
		}
		const node: IParsedLockNode = {
			id: `npm-v1:${path}`,
			name,
			version: typeof raw.version === "string" ? raw.version : null,
			path,
			integrity: typeof raw.integrity === "string" ? raw.integrity : null,
			dependencies: dependencyRecord(raw.requires),
		};
		nodes.push(node);
		nodesByPath.set(path, node);
		for (const [childName, child] of Object.entries<any>(raw.dependencies ?? {})) {
			visit(childName, child, `${path}/node_modules/${childName}`);
		}
	}
	for (const [name, raw] of Object.entries<any>(lock?.dependencies ?? {})) {
		visit(name, raw, `node_modules/${name}`);
	}
	return { nodes, resolve: (from, name) => resolvePackageLockDependency(nodesByPath, from?.path ?? "", name) };
}

function parseYarnSelector(selector: string): { name: string; requested: string } | null {
	const value = selector.trim().replace(/^"|"$/g, "");
	const separator = value.startsWith("@") ? value.indexOf("@", value.indexOf("/") + 1) : value.indexOf("@");
	if (separator <= 0) {
		return null;
	}
	return { name: value.slice(0, separator), requested: value.slice(separator + 1) };
}

function parseYarnLock(bytes: Buffer): { nodes: IParsedLockNode[]; resolve: (from: IParsedLockNode | null, name: string, requested: string) => IParsedLockNode | null } {
	const nodes: (IParsedLockNode & { selectors: string[] })[] = [];
	let current: (IParsedLockNode & { selectors: string[] }) | null = null;
	let dependencyBlock = false;
	for (const sourceLine of bytes.toString("utf8").split(/\r?\n/)) {
		if (sourceLine && !/^\s/.test(sourceLine) && sourceLine.endsWith(":")) {
			const selectors = sourceLine
				.slice(0, -1)
				.split(/,\s*/)
				.map((value) => value.trim().replace(/^"|"$/g, ""));
			const parsed = selectors.map(parseYarnSelector).find((value) => value !== null);
			current = parsed
				? { id: `yarn:${nodes.length}:${parsed.name}`, name: parsed.name, version: null, path: `yarn:${nodes.length}`, integrity: null, dependencies: {}, selectors }
				: null;
			if (current) {
				nodes.push(current);
			}
			dependencyBlock = false;
			if (nodes.length >= maximumDependencyNodes) {
				break;
			}
			continue;
		}
		if (!current) {
			continue;
		}
		const trimmed = sourceLine.trim();
		if (trimmed.startsWith("version ")) {
			current.version = trimmed.slice("version ".length).trim().replace(/^"|"$/g, "");
		} else if (trimmed.startsWith("integrity ")) {
			current.integrity = trimmed.slice("integrity ".length).trim();
		} else if (trimmed === "dependencies:" || trimmed === "optionalDependencies:") {
			dependencyBlock = true;
		} else if (/^\s{4}\S/.test(sourceLine) && dependencyBlock) {
			const match = /^\s{4}("[^"]+"|\S+)\s+(.*)$/.exec(sourceLine);
			if (match) {
				current.dependencies[match[1].replace(/^"|"$/g, "")] = match[2].trim().replace(/^"|"$/g, "");
			}
		} else if (/^\s{2}\S/.test(sourceLine)) {
			dependencyBlock = false;
		}
	}
	const bySelector = new Map<string, IParsedLockNode>();
	const byName = new Map<string, IParsedLockNode[]>();
	for (const node of nodes) {
		node.selectors.forEach((selector) => bySelector.set(selector, node));
		const list = byName.get(node.name) ?? [];
		list.push(node);
		byName.set(node.name, list);
	}
	return {
		nodes,
		resolve: (_from, name, requested) => {
			const exact = bySelector.get(`${name}@${requested}`);
			if (exact) {
				return exact;
			}
			const candidates = byName.get(name) ?? [];
			const matching = validRange(requested) ? candidates.filter((candidate) => candidate.version && satisfies(candidate.version, requested)) : candidates;
			return (
				matching.sort((left, right) => (left.version && right.version && valid(left.version) && valid(right.version) ? rcompare(left.version, right.version) : 0))[0] ??
				null
			);
		},
	};
}

function packageKey(value: string): { name: string; version: string } | null {
	const normalized = value.replace(/^\//, "").replace(/\(.+$/, "");
	const separator = normalized.lastIndexOf("@");
	if (separator <= 0) {
		return null;
	}
	const name = normalized.slice(0, separator);
	const version = normalized.slice(separator + 1);
	return name && version && !version.startsWith("file:") && !version.startsWith("link:") ? { name, version } : null;
}

function parsePnpmLock(bytes: Buffer): { nodes: IParsedLockNode[]; resolve: (from: IParsedLockNode | null, name: string, requested: string) => IParsedLockNode | null } {
	let lock: any;
	try {
		lock = parseYaml(bytes.toString("utf8"));
	} catch {
		throw new Error("pnpm lockfile is malformed YAML.");
	}
	const packageEntries = { ...(lock?.packages ?? {}), ...(lock?.snapshots ?? {}) };
	const byKey = new Map<string, IParsedLockNode>();
	const byName = new Map<string, IParsedLockNode[]>();
	for (const [key, raw] of Object.entries<any>(packageEntries)) {
		const parsed = packageKey(key);
		if (!parsed || byKey.has(`${parsed.name}@${parsed.version}`)) {
			continue;
		}
		const node: IParsedLockNode = {
			id: `pnpm:${key}`,
			name: parsed.name,
			version: parsed.version,
			path: key,
			integrity: typeof raw?.resolution?.integrity === "string" ? raw.resolution.integrity : null,
			dependencies: dependencyRecord({ ...(raw?.dependencies ?? {}), ...(raw?.optionalDependencies ?? {}) }),
		};
		byKey.set(`${node.name}@${node.version}`, node);
		const list = byName.get(node.name) ?? [];
		list.push(node);
		byName.set(node.name, list);
		if (byKey.size >= maximumDependencyNodes) {
			break;
		}
	}
	return {
		nodes: [...byKey.values()],
		resolve: (_from, name, requested) => {
			const normalized = String(requested).replace(/^npm:/, "").replace(/\(.+$/, "");
			return (
				byKey.get(`${name}@${normalized}`) ??
				byName.get(name)?.find((candidate) => candidate.version && validRange(normalized) && satisfies(candidate.version, normalized)) ??
				null
			);
		},
	};
}

function parseBunLock(bytes: Buffer): { nodes: IParsedLockNode[]; resolve: (from: IParsedLockNode | null, name: string, requested: string) => IParsedLockNode | null } {
	let lock: any;
	try {
		lock = parseYaml(bytes.toString("utf8"));
	} catch {
		throw new Error("Bun text lockfile is malformed JSONC/YAML.");
	}
	const nodes: IParsedLockNode[] = [];
	const byName = new Map<string, IParsedLockNode[]>();
	for (const [key, raw] of Object.entries<any>(lock?.packages ?? {})) {
		const descriptor = Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : key;
		const parsed = packageKey(descriptor);
		if (!parsed) {
			continue;
		}
		const node: IParsedLockNode = {
			id: `bun:${key}`,
			name: parsed.name,
			version: parsed.version,
			path: key,
			integrity: Array.isArray(raw) && typeof raw[3] === "string" ? raw[3] : null,
			dependencies: dependencyRecord(Array.isArray(raw) ? raw[2] : raw?.dependencies),
		};
		nodes.push(node);
		const list = byName.get(node.name) ?? [];
		list.push(node);
		byName.set(node.name, list);
		if (nodes.length >= maximumDependencyNodes) {
			break;
		}
	}
	return {
		nodes,
		resolve: (_from, name, requested) => {
			const candidates = byName.get(name) ?? [];
			return (
				candidates.find((candidate) => candidate.version === requested) ??
				candidates.find((candidate) => candidate.version && validRange(requested) && satisfies(candidate.version, requested)) ??
				null
			);
		},
	};
}

function directManifestDependencies(context: IProjectPackageContext): { name: string; requested: string; dependencyType: ProjectPackageDependencyType }[] {
	return dependencyTypes.flatMap((dependencyType) => Object.entries(context.manifest[dependencyType] ?? {}).map(([name, requested]) => ({ name, requested, dependencyType })));
}

async function readLockfile(evidence: IProjectPackageFileEvidence): Promise<Buffer> {
	const fileStat = await lstat(evidence.path);
	if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
		throw new Error("Authoritative package lockfile must remain a regular file and cannot be a symbolic link.");
	}
	if (fileStat.size > maximumLockfileBytes) {
		throw new Error(`Authoritative package lockfile exceeds the ${maximumLockfileBytes}-byte safety limit.`);
	}
	const bytes = await readFile(evidence.path);
	if (packageSha256(bytes) !== evidence.sha256) {
		throw new Error("Authoritative package lockfile changed during inspection; retry the request.");
	}
	return bytes;
}

function authoritativeLockfile(context: IProjectPackageContext): IProjectPackageFileEvidence | null {
	const authoritative = context.lockfiles.filter((lockfile) => lockfile.authoritative);
	if (context.packageManager === "npm") {
		return authoritative.find((lockfile) => lockfile.format === "npm-shrinkwrap") ?? authoritative.find((lockfile) => lockfile.format === "package-lock") ?? null;
	}
	if (context.packageManager === "bun") {
		return authoritative.find((lockfile) => lockfile.format === "bun-text") ?? authoritative.find((lockfile) => lockfile.format === "bun-binary") ?? null;
	}
	return authoritative[0] ?? null;
}

async function installedDirectNode(context: IProjectPackageContext, name: string): Promise<IParsedLockNode | null> {
	const allowedRoot = context.workspaceRoot ?? context.projectRoot;
	const candidate = join(allowedRoot, "node_modules", ...name.split("/"));
	let resolvedPackageRoot: string;
	try {
		resolvedPackageRoot = await realpath(candidate);
	} catch {
		return null;
	}
	if (!projectPathContains(allowedRoot, resolvedPackageRoot)) {
		return null;
	}
	const manifestPath = join(resolvedPackageRoot, "package.json");
	const manifestStat = await lstat(manifestPath);
	if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024) {
		return null;
	}
	let manifest: any;
	try {
		manifest = JSON.parse((await readFile(manifestPath)).toString("utf8"));
	} catch {
		return null;
	}
	return {
		id: `installed:${name}`,
		name,
		version: typeof manifest.version === "string" ? manifest.version : null,
		path: `node_modules/${name}`,
		integrity: null,
		dependencies: dependencyRecord(manifest.dependencies),
	};
}

export async function readProjectPackageDependencyGraph(context: IProjectPackageContext): Promise<IProjectPackageDependencyGraph> {
	const lockfile = authoritativeLockfile(context);
	const warnings: string[] = [];
	let parsed: ReturnType<typeof parsePackageLock> | null = null;
	let format: IProjectPackageDependencyGraph["format"] = "manifest-only";
	if (lockfile?.format === "bun-binary") {
		warnings.push("bun.lockb is binary evidence only; migrate with Bun 1.2+ to bun.lock for a resolved dependency graph.");
	} else if (lockfile) {
		const bytes = await readLockfile(lockfile);
		if (lockfile.format === "package-lock" || lockfile.format === "npm-shrinkwrap") {
			parsed = parsePackageLock(bytes);
		} else if (lockfile.format === "yarn") {
			parsed = parseYarnLock(bytes);
		} else if (lockfile.format === "pnpm") {
			parsed = parsePnpmLock(bytes);
		} else if (lockfile.format === "bun-text") {
			parsed = parseBunLock(bytes);
		}
		format = lockfile.format;
	}
	const direct = directManifestDependencies(context);
	if (!parsed) {
		const installed = (await Promise.all(direct.map((dependency) => installedDirectNode(context, dependency.name)))).filter((node): node is IParsedLockNode => node !== null);
		if (installed.length) {
			const byName = new Map(installed.map((node) => [node.name, node]));
			parsed = { nodes: installed, resolve: (_from, name) => byName.get(name) ?? null };
			format = "node_modules";
		} else {
			parsed = { nodes: [], resolve: () => null };
			warnings.push("No readable authoritative lockfile or contained installed dependency tree was found; only manifest dependencies are available.");
		}
	}
	const directByName = new Map<string, ProjectPackageDependencyType[]>();
	for (const dependency of direct) {
		const types = directByName.get(dependency.name) ?? [];
		if (!types.includes(dependency.dependencyType)) {
			types.push(dependency.dependencyType);
		}
		directByName.set(dependency.name, types);
	}
	const nodes = parsed.nodes.slice(0, maximumDependencyNodes).map((node) => ({
		...node,
		source: format === "node_modules" ? ("node_modules" as const) : ("lockfile" as const),
		direct: directByName.has(node.name),
		dependencyTypes: directByName.get(node.name) ?? [],
	}));
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const edges: IProjectPackageDependencyEdge[] = [];
	for (const dependency of direct) {
		const target = parsed.resolve(null, dependency.name, dependency.requested);
		edges.push({ from: "root", to: target?.id ?? null, name: dependency.name, requested: dependency.requested, missing: !target });
	}
	for (const source of parsed.nodes) {
		if (!nodeById.has(source.id)) {
			continue;
		}
		for (const [name, requested] of Object.entries(source.dependencies)) {
			const target = parsed.resolve(source, name, requested);
			edges.push({ from: source.id, to: target?.id ?? null, name, requested, missing: !target });
			if (edges.length >= maximumDependencyEdges) {
				break;
			}
		}
		if (edges.length >= maximumDependencyEdges) {
			break;
		}
	}
	return {
		format,
		lockfile,
		nodes,
		edges,
		warnings,
		truncated: parsed.nodes.length > maximumDependencyNodes || edges.length >= maximumDependencyEdges,
	};
}

/** Returns paginated direct/resolved/transitive dependency and exact lockfile evidence. */
export async function getProjectPackageDependencyGraph(_scene: unknown, data: any, options: IMCPActionOptions): Promise<any> {
	const { offset, limit } = pagination(data);
	const context = await getProjectPackageContext(options);
	const graph = await readProjectPackageDependencyGraph(context);
	const query = typeof data?.query === "string" ? data.query.trim().toLowerCase() : "";
	if (query.length > 214) {
		throw new Error("query must be at most 214 characters.");
	}
	const candidates = graph.nodes.filter((node) => (data?.directOnly === true ? node.direct : true) && (!query || node.name.toLowerCase().includes(query)));
	const page = candidates.slice(offset, offset + limit);
	const pageIds = new Set(page.map((node) => node.id));
	return {
		fingerprint: context.fingerprint,
		packageManager: context.packageManager,
		format: graph.format,
		lockfile: graph.lockfile,
		nodes: page,
		edges: graph.edges.filter((edge) => (edge.from === "root" ? !edge.to || pageIds.has(edge.to) : pageIds.has(edge.from))),
		warnings: graph.warnings,
		truncated: graph.truncated,
		offset,
		limit,
		count: page.length,
		total: candidates.length,
		hasMore: offset + page.length < candidates.length,
		nextOffset: offset + page.length < candidates.length ? offset + page.length : null,
	};
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, callback: (value: T) => Promise<U>): Promise<U[]> {
	const results = new Array<U>(values.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, async () => {
			while (next < values.length) {
				const index = next++;
				results[index] = await callback(values[index]);
			}
		})
	);
	return results;
}

/** Resolves wanted/latest update availability against registry metadata without mutating package state. */
export async function getProjectPackageUpdates(_scene: unknown, data: any, options: IMCPActionOptions): Promise<any> {
	const { offset, limit } = pagination(data, 50);
	const context = await getProjectPackageContext(options);
	const graph = await readProjectPackageDependencyGraph(context);
	const direct = directManifestDependencies(context);
	const requestedNames = data?.names === undefined ? null : data.names;
	if (requestedNames !== null && (!Array.isArray(requestedNames) || requestedNames.length < 1 || requestedNames.length > 100)) {
		throw new Error("names must contain 1–100 package names when provided.");
	}
	const nameFilter = requestedNames ? new Set(requestedNames.map(validateProjectPackageName)) : null;
	const candidates = direct.filter((dependency) => !nameFilter || nameFilter.has(dependency.name));
	const page = candidates.slice(offset, offset + limit);
	const currentByName = new Map<string, string>();
	for (const node of graph.nodes) {
		if (node.direct && node.version && !currentByName.has(node.name)) {
			currentByName.set(node.name, node.version);
		}
	}
	const includePrerelease = data?.includePrerelease === true;
	const timeoutMs = data?.timeoutMs ?? 20_000;
	const updates = await mapWithConcurrency(page, 4, async (dependency) => {
		const current = currentByName.get(dependency.name) ?? null;
		try {
			const { metadata, registry } = await getProjectPackageRegistryMetadata(context, dependency.name, timeoutMs);
			const versions = Object.keys(metadata?.versions ?? {}).filter((version) => valid(version));
			const range = validRange(dependency.requested, { includePrerelease });
			const wanted = range ? maxSatisfying(versions, range, { includePrerelease }) : null;
			const latest = typeof metadata?.["dist-tags"]?.latest === "string" ? metadata["dist-tags"].latest : null;
			return {
				name: dependency.name,
				dependencyType: dependency.dependencyType,
				requested: dependency.requested,
				current,
				wanted,
				latest,
				wantedUpdateAvailable: Boolean(current && wanted && valid(current) && gt(wanted, current)),
				latestUpdateAvailable: Boolean(current && latest && valid(current) && valid(latest) && gt(latest, current)),
				wantedChange: current && wanted && valid(current) && valid(wanted) && current !== wanted ? diff(current, wanted) : null,
				latestChange: current && latest && valid(current) && valid(latest) && current !== latest ? diff(current, latest) : null,
				registry,
				rangeSupported: range !== null,
				error: null,
			};
		} catch (error) {
			return {
				name: dependency.name,
				dependencyType: dependency.dependencyType,
				requested: dependency.requested,
				current,
				wanted: null,
				latest: null,
				wantedUpdateAvailable: false,
				latestUpdateAvailable: false,
				wantedChange: null,
				latestChange: null,
				registry: null,
				rangeSupported: validRange(dependency.requested) !== null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
	return {
		fingerprint: context.fingerprint,
		packageManager: context.packageManager,
		updates,
		offset,
		limit,
		count: updates.length,
		total: candidates.length,
		hasMore: offset + updates.length < candidates.length,
		nextOffset: offset + updates.length < candidates.length ? offset + updates.length : null,
		availableCount: updates.filter((update) => update.wantedUpdateAvailable || update.latestUpdateAvailable).length,
	};
}
