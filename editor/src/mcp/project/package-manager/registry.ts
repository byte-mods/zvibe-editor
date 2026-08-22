import { randomUUID } from "crypto";
import { lstat, readFile, rename, unlink, writeFile } from "fs/promises";
import { isIP } from "net";
import { join } from "path";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../../action";
import { getProjectPackageContext, packageSha256 } from "./context";
import { validateProjectPackageName, validateProjectPackageVersion } from "./process";
import { IProjectPackageContext } from "./types";

const defaultRegistryUrl = "https://registry.npmjs.org/";
const maximumRegistryConfigurationBytes = 256 * 1024;
const maximumRegistryResponseBytes = 32 * 1024 * 1024;
const maximumRegistryVersions = 10_000;
const registryPlanLifetimeMs = 15 * 60 * 1_000;

interface IRegistryConfigurationFile {
	path: string;
	bytes: Buffer;
	sha256: string;
}

interface IRegistryCredential {
	token: string | null;
	environmentVariables: string[];
	literalSecretPresent: boolean;
	configured: boolean;
}

interface IProjectPackageRegistryInternal {
	id: string;
	name: string;
	scope: string | null;
	url: string;
	source: "default" | ".npmrc";
	credential: IRegistryCredential;
}

interface IProjectPackageRegistryConfiguration {
	fingerprint: string;
	files: IRegistryConfigurationFile[];
	registries: IProjectPackageRegistryInternal[];
}

interface IVariableResolution {
	value: string;
	environmentVariables: string[];
	complete: boolean;
}

interface IProjectPackageRegistryPlan {
	id: string;
	createdAt: string;
	expiresAt: string;
	sourceFingerprint: string;
	action: "upsert" | "remove";
	scope: string | null;
	url: string | null;
	credentialEnvironmentVariable: string | null | undefined;
	removeCredential: boolean;
	resultBytes: Buffer;
	resultSha256: string;
	changed: boolean;
}

const registryPlans = new WeakMap<Scene, Map<string, IProjectPackageRegistryPlan>>();

function validatePagination(data: any, maximumLimit = 50): { offset: number; limit: number } {
	const offset = data?.offset ?? 0;
	const limit = data?.limit ?? Math.min(20, maximumLimit);
	if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
		throw new Error("offset must be an integer from 0 through 1000000.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > maximumLimit) {
		throw new Error(`limit must be an integer from 1 through ${maximumLimit}.`);
	}
	return { offset, limit };
}

function resolveVariables(value: string): IVariableResolution {
	const environmentVariables: string[] = [];
	let complete = true;
	const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		environmentVariables.push(name);
		const replacement = process.env[name];
		if (replacement === undefined) {
			complete = false;
			return "";
		}
		return replacement;
	});
	return { value: resolved, environmentVariables: [...new Set(environmentVariables)].sort(), complete };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost")) {
		return true;
	}
	if (isIP(normalized) === 4) {
		return normalized.startsWith("127.");
	}
	return normalized === "::1";
}

export function validateProjectPackageRegistryUrl(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 2_048) {
		throw new Error("Registry URL must be a non-empty URL of at most 2048 characters.");
	}
	const resolved = resolveVariables(unquote(value));
	if (!resolved.complete) {
		throw new Error(`Registry URL references unavailable environment variable(s): ${resolved.environmentVariables.join(", ")}.`);
	}
	let url: URL;
	try {
		url = new URL(resolved.value);
	} catch {
		throw new Error("Registry URL must be an absolute HTTPS URL, or HTTP on loopback for local development.");
	}
	if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))) {
		throw new Error("Registry URL must be credential-free HTTPS, or credential-free HTTP on loopback for local development.");
	}
	url.search = "";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
	return url.toString();
}

function validateScope(value: string): string {
	if (!/^@[a-z0-9][a-z0-9._-]*$/i.test(value) || value.length > 214) {
		throw new Error(`Invalid package registry scope "${value}".`);
	}
	return value.toLowerCase();
}

async function readOptionalConfigurationFile(context: IProjectPackageContext, name: string): Promise<IRegistryConfigurationFile | null> {
	const path = join(context.projectRoot, name);
	let fileStat;
	try {
		fileStat = await lstat(path);
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return null;
		}
		throw error;
	}
	if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
		throw new Error(`${name} must be a regular project-root file and cannot be a symbolic link.`);
	}
	if (fileStat.size > maximumRegistryConfigurationBytes) {
		throw new Error(`${name} exceeds the ${maximumRegistryConfigurationBytes}-byte safety limit.`);
	}
	const bytes = await readFile(path);
	return { path: name, bytes, sha256: packageSha256(bytes) };
}

function authTargetFromKey(key: string): string | null {
	const suffixes = [":_authToken", ":_auth", ":username", ":_password"];
	const suffix = suffixes.find((candidate) => key.endsWith(candidate));
	if (!suffix || !key.startsWith("//")) {
		return null;
	}
	const target = key.slice(0, -suffix.length);
	try {
		const parsed = new URL(validateProjectPackageRegistryUrl(`https:${target}`));
		return `//${parsed.host}${parsed.pathname}`;
	} catch {
		return null;
	}
}

function credentialForRegistry(registryUrl: string, authEntries: { target: string | null; raw: string; token: boolean }[]): IRegistryCredential {
	const parsedRegistryUrl = new URL(registryUrl);
	const registryTarget = `//${parsedRegistryUrl.host}${parsedRegistryUrl.pathname}`;
	const applicable = authEntries
		.filter((entry) => entry.target === null || registryTarget.startsWith(entry.target))
		.sort((left, right) => (right.target?.length ?? 0) - (left.target?.length ?? 0));
	const environmentVariables = new Set<string>();
	let literalSecretPresent = false;
	let token: string | null = null;
	for (const entry of applicable) {
		const resolved = resolveVariables(unquote(entry.raw));
		resolved.environmentVariables.forEach((name) => environmentVariables.add(name));
		if (!resolved.environmentVariables.length && entry.raw.trim()) {
			literalSecretPresent = true;
		}
		if (entry.token && resolved.complete && resolved.value && token === null) {
			token = resolved.value;
		}
	}
	return { token, environmentVariables: [...environmentVariables].sort(), literalSecretPresent, configured: applicable.length > 0 };
}

function publicRegistry(registry: IProjectPackageRegistryInternal): any {
	return {
		id: registry.id,
		name: registry.name,
		scope: registry.scope,
		url: registry.url,
		source: registry.source,
		credential: {
			configured: registry.credential.configured,
			available: registry.credential.token !== null,
			environmentVariables: registry.credential.environmentVariables,
			literalSecretPresent: registry.credential.literalSecretPresent,
		},
	};
}

async function registryConfiguration(context: IProjectPackageContext): Promise<IProjectPackageRegistryConfiguration> {
	const files = (
		await Promise.all([
			readOptionalConfigurationFile(context, ".npmrc"),
			readOptionalConfigurationFile(context, ".yarnrc.yml"),
			readOptionalConfigurationFile(context, "bunfig.toml"),
		])
	).filter((value): value is IRegistryConfigurationFile => value !== null);
	const npmrc = files.find((file) => file.path === ".npmrc");
	let defaultUrl = defaultRegistryUrl;
	let defaultSource: IProjectPackageRegistryInternal["source"] = "default";
	const scoped = new Map<string, string>();
	const authEntries: { target: string | null; raw: string; token: boolean }[] = [];
	if (npmrc) {
		for (const sourceLine of npmrc.bytes.toString("utf8").split(/\r?\n/)) {
			const line = sourceLine.trim();
			if (!line || line.startsWith("#") || line.startsWith(";")) {
				continue;
			}
			const separator = line.indexOf("=");
			if (separator < 1) {
				continue;
			}
			const key = line.slice(0, separator).trim();
			const raw = line.slice(separator + 1).trim();
			if (key === "registry") {
				defaultUrl = validateProjectPackageRegistryUrl(raw);
				defaultSource = ".npmrc";
				continue;
			}
			const scopeMatch = /^(@[^:]+):registry$/.exec(key);
			if (scopeMatch) {
				scoped.set(validateScope(scopeMatch[1]), validateProjectPackageRegistryUrl(raw));
				continue;
			}
			if (key === "_authToken") {
				authEntries.push({ target: null, raw, token: true });
				continue;
			}
			const target = authTargetFromKey(key);
			if (target) {
				authEntries.push({ target, raw, token: key.endsWith(":_authToken") });
			}
		}
	}
	const definitions = [
		{ scope: null, url: defaultUrl, source: defaultSource, name: "Default registry" },
		...[...scoped.entries()].map(([scope, url]) => ({ scope, url, source: ".npmrc" as const, name: `${scope} registry` })),
	];
	const registries = definitions.map((definition) => ({
		...definition,
		id: packageSha256(`${definition.scope ?? "default"}\n${definition.url}`).slice(0, 24),
		credential: credentialForRegistry(definition.url, authEntries),
	}));
	const fingerprint = packageSha256(JSON.stringify({ context: context.fingerprint, files: files.map((file) => ({ path: file.path, sha256: file.sha256 })) }));
	return { fingerprint, files, registries };
}

function chooseRegistry(configuration: IProjectPackageRegistryConfiguration, registryId: unknown, packageName?: string): IProjectPackageRegistryInternal {
	if (registryId !== undefined) {
		if (typeof registryId !== "string" || !/^[a-f0-9]{24}$/.test(registryId)) {
			throw new Error("registryId must be a 24-character registry id returned by list_project_package_registries.");
		}
		const selected = configuration.registries.find((registry) => registry.id === registryId);
		if (!selected) {
			throw new Error(`Unknown project package registry id "${registryId}".`);
		}
		return selected;
	}
	const scope = packageName?.startsWith("@") ? packageName.slice(0, packageName.indexOf("/")) : null;
	return configuration.registries.find((registry) => registry.scope === scope) ?? configuration.registries.find((registry) => registry.scope === null)!;
}

async function readResponseBytes(response: Response): Promise<Buffer> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximumRegistryResponseBytes) {
		throw new Error(`Registry response exceeds the ${maximumRegistryResponseBytes}-byte safety limit.`);
	}
	if (!response.body) {
		return Buffer.alloc(0);
	}
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) {
			break;
		}
		bytes += result.value.byteLength;
		if (bytes > maximumRegistryResponseBytes) {
			await reader.cancel();
			throw new Error(`Registry response exceeds the ${maximumRegistryResponseBytes}-byte safety limit.`);
		}
		chunks.push(Buffer.from(result.value));
	}
	return Buffer.concat(chunks);
}

async function registryRequest(registry: IProjectPackageRegistryInternal, relativePath: string, timeoutMs: number, accept = "application/json"): Promise<any> {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
		throw new Error("Registry timeoutMs must be an integer from 1000 through 60000.");
	}
	const registryOrigin = new URL(registry.url).origin;
	let url = new URL(relativePath.replace(/^\//, ""), registry.url);
	for (let redirects = 0; redirects <= 3; redirects++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		timeout.unref?.();
		let response: Response;
		try {
			const headers: Record<string, string> = { accept, "user-agent": "Zvibe-Editor/1.0.0" };
			if (registry.credential.token && url.origin === registryOrigin) {
				headers.authorization = `Bearer ${registry.credential.token}`;
			}
			response = await fetch(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
		} catch (error) {
			throw new Error(
				`Package registry request failed: ${error instanceof Error && error.name === "AbortError" ? "request timed out" : error instanceof Error ? error.message : String(error)}.`
			);
		} finally {
			clearTimeout(timeout);
		}
		if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
			if (redirects === 3) {
				throw new Error("Package registry request exceeded three redirects.");
			}
			url = new URL(response.headers.get("location")!, url);
			validateProjectPackageRegistryUrl(`${url.origin}${url.pathname}`);
			continue;
		}
		const bytes = await readResponseBytes(response);
		if (!response.ok) {
			throw new Error(`Package registry returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`);
		}
		try {
			return JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new Error("Package registry returned malformed JSON.");
		}
	}
	throw new Error("Package registry request failed.");
}

/** Lists configured default/scoped registries without returning credential values. */
export async function listProjectPackageRegistries(_scene: unknown, data: any, options: IMCPActionOptions): Promise<any> {
	const { offset, limit } = validatePagination(data, 100);
	const context = await getProjectPackageContext(options);
	const configuration = await registryConfiguration(context);
	const page = configuration.registries.slice(offset, offset + limit);
	return {
		fingerprint: configuration.fingerprint,
		files: configuration.files.map((file) => ({ path: file.path, bytes: file.bytes.byteLength, sha256: file.sha256 })),
		registries: page.map(publicRegistry),
		offset,
		limit,
		count: page.length,
		total: configuration.registries.length,
		hasMore: offset + page.length < configuration.registries.length,
		nextOffset: offset + page.length < configuration.registries.length ? offset + page.length : null,
	};
}

/** Searches one configured registry with bounded pagination and credential-safe responses. */
export async function searchProjectPackageRegistry(_scene: unknown, data: any, options: IMCPActionOptions): Promise<any> {
	const { offset, limit } = validatePagination(data, 50);
	if (typeof data?.query !== "string" || !data.query.trim() || data.query.length > 200) {
		throw new Error("query must be 1–200 characters.");
	}
	const context = await getProjectPackageContext(options);
	const configuration = await registryConfiguration(context);
	const registry = chooseRegistry(configuration, data.registryId);
	const search = new URLSearchParams({ text: data.query.trim(), size: String(limit), from: String(offset) });
	const response = await registryRequest(registry, `-/v1/search?${search.toString()}`, data.timeoutMs ?? 15_000);
	const objects = Array.isArray(response?.objects) ? response.objects : [];
	const packages = objects.slice(0, limit).map((entry: any) => {
		const value = entry?.package && typeof entry.package === "object" ? entry.package : {};
		return {
			name: typeof value.name === "string" ? value.name : "",
			version: typeof value.version === "string" ? value.version : null,
			description: typeof value.description === "string" ? value.description.slice(0, 1_024) : null,
			keywords: Array.isArray(value.keywords) ? value.keywords.filter((keyword: unknown): keyword is string => typeof keyword === "string").slice(0, 32) : [],
			date: typeof value.date === "string" ? value.date : null,
			publisher: typeof value.publisher?.username === "string" ? value.publisher.username : null,
			links:
				value.links && typeof value.links === "object"
					? { npm: typeof value.links.npm === "string" ? value.links.npm : null, homepage: typeof value.links.homepage === "string" ? value.links.homepage : null }
					: null,
			score: typeof entry?.score?.final === "number" ? entry.score.final : null,
		};
	});
	const total = Number.isFinite(response?.total) ? Math.max(0, Math.floor(response.total)) : offset + packages.length;
	return {
		registry: publicRegistry(registry),
		query: data.query.trim(),
		packages,
		offset,
		limit,
		count: packages.length,
		total,
		hasMore: offset + packages.length < total,
		nextOffset: offset + packages.length < total ? offset + packages.length : null,
	};
}

function boundedStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter((entry): entry is [string, string] => typeof entry[1] === "string")
			.slice(0, 500)
	);
}

export async function getProjectPackageRegistryMetadata(context: IProjectPackageContext, name: string, timeoutMs = 20_000): Promise<{ metadata: any; registry: any }> {
	const packageName = validateProjectPackageName(name);
	const configuration = await registryConfiguration(context);
	const registry = chooseRegistry(configuration, undefined, packageName);
	const metadata = await registryRequest(registry, encodeURIComponent(packageName), timeoutMs, "application/vnd.npm.install-v1+json, application/json;q=0.8");
	return { metadata, registry: publicRegistry(registry) };
}

function packageRepository(value: unknown): string | null {
	if (typeof value === "string") {
		return value.slice(0, 2_048);
	}
	if (value && typeof value === "object" && typeof (value as any).url === "string") {
		return (value as any).url.slice(0, 2_048);
	}
	return null;
}

/** Gets package metadata, a selected release, and paginated version history from one configured registry. */
export async function getProjectPackageDetails(_scene: unknown, data: any, options: IMCPActionOptions): Promise<any> {
	const name = validateProjectPackageName(data?.name);
	const requestedVersion = validateProjectPackageVersion(data?.version);
	const { offset, limit } = validatePagination(data, 100);
	const context = await getProjectPackageContext(options);
	const configuration = await registryConfiguration(context);
	const registry = chooseRegistry(configuration, data.registryId, name);
	const metadata = await registryRequest(registry, encodeURIComponent(name), data.timeoutMs ?? 20_000);
	if (!metadata || typeof metadata !== "object" || typeof metadata.name !== "string") {
		throw new Error("Package registry metadata is missing the package name.");
	}
	const versionMap = metadata.versions && typeof metadata.versions === "object" && !Array.isArray(metadata.versions) ? metadata.versions : {};
	const allVersions = Object.keys(versionMap);
	if (allVersions.length > maximumRegistryVersions) {
		throw new Error(`Package metadata exceeds the ${maximumRegistryVersions}-version safety limit.`);
	}
	allVersions.sort((left, right) => {
		const leftTime = typeof metadata.time?.[left] === "string" ? Date.parse(metadata.time[left]) : Number.NaN;
		const rightTime = typeof metadata.time?.[right] === "string" ? Date.parse(metadata.time[right]) : Number.NaN;
		return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime ? rightTime - leftTime : right.localeCompare(left, undefined, { numeric: true });
	});
	const selectedVersion = requestedVersion ?? (typeof metadata["dist-tags"]?.latest === "string" ? metadata["dist-tags"].latest : allVersions[0]);
	const selected = selectedVersion ? versionMap[selectedVersion] : undefined;
	if (!selected || typeof selected !== "object") {
		throw new Error(`Package "${name}" does not publish version/tag "${requestedVersion ?? "latest"}".`);
	}
	const versionPage = allVersions.slice(offset, offset + limit).map((version) => {
		const value = versionMap[version];
		return {
			version,
			publishedAt: typeof metadata.time?.[version] === "string" ? metadata.time[version] : null,
			deprecated: typeof value?.deprecated === "string" ? value.deprecated.slice(0, 1_024) : null,
			engines: boundedStringRecord(value?.engines),
			dependencyCount: Object.keys(value?.dependencies ?? {}).length,
		};
	});
	return {
		registry: publicRegistry(registry),
		name: metadata.name,
		description: typeof metadata.description === "string" ? metadata.description.slice(0, 2_048) : null,
		license: typeof metadata.license === "string" ? metadata.license : typeof metadata.license?.type === "string" ? metadata.license.type : null,
		homepage: typeof metadata.homepage === "string" ? metadata.homepage.slice(0, 2_048) : null,
		repository: packageRepository(metadata.repository),
		distTags: boundedStringRecord(metadata["dist-tags"]),
		createdAt: typeof metadata.time?.created === "string" ? metadata.time.created : null,
		modifiedAt: typeof metadata.time?.modified === "string" ? metadata.time.modified : null,
		selected: {
			version: selectedVersion,
			publishedAt: typeof metadata.time?.[selectedVersion!] === "string" ? metadata.time[selectedVersion!] : null,
			deprecated: typeof selected.deprecated === "string" ? selected.deprecated.slice(0, 1_024) : null,
			engines: boundedStringRecord(selected.engines),
			dependencies: boundedStringRecord(selected.dependencies),
			devDependencies: boundedStringRecord(selected.devDependencies),
			peerDependencies: boundedStringRecord(selected.peerDependencies),
			optionalDependencies: boundedStringRecord(selected.optionalDependencies),
			integrity: typeof selected.dist?.integrity === "string" ? selected.dist.integrity.slice(0, 1_024) : null,
			tarball: typeof selected.dist?.tarball === "string" ? selected.dist.tarball.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[redacted]@").slice(0, 2_048) : null,
		},
		versions: versionPage,
		offset,
		limit,
		count: versionPage.length,
		total: allVersions.length,
		hasMore: offset + versionPage.length < allVersions.length,
		nextOffset: offset + versionPage.length < allVersions.length ? offset + versionPage.length : null,
		readmeIncluded: false,
	};
}

function registryPlanMap(scene: Scene): Map<string, IProjectPackageRegistryPlan> {
	let plans = registryPlans.get(scene);
	if (!plans) {
		plans = new Map();
		registryPlans.set(scene, plans);
	}
	const now = Date.now();
	for (const [id, plan] of plans) {
		if (Date.parse(plan.expiresAt) <= now) {
			plans.delete(id);
		}
	}
	while (plans.size >= 20) {
		plans.delete(plans.keys().next().value!);
	}
	return plans;
}

function registryLineKey(scope: string | null): string {
	return scope ? `${scope}:registry` : "registry";
}

function registryCredentialKey(url: string): string {
	const parsed = new URL(url);
	return `//${parsed.host}${parsed.pathname}:_authToken`;
}

function validateCredentialEnvironmentVariable(value: unknown): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null) {
		return null;
	}
	if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
		throw new Error("credentialEnvironmentVariable must be null or a valid environment-variable name of at most 128 characters.");
	}
	return value;
}

function registryPlanPublic(plan: IProjectPackageRegistryPlan): any {
	return {
		id: plan.id,
		createdAt: plan.createdAt,
		expiresAt: plan.expiresAt,
		sourceFingerprint: plan.sourceFingerprint,
		action: plan.action,
		scope: plan.scope,
		url: plan.url,
		credentialEnvironmentVariable: plan.credentialEnvironmentVariable,
		removeCredential: plan.removeCredential,
		resultSha256: plan.resultSha256,
		resultBytes: plan.resultBytes.byteLength,
		changed: plan.changed,
		writes: [".npmrc"],
	};
}

function updateRegistryConfiguration(
	source: Buffer,
	action: "upsert" | "remove",
	scope: string | null,
	url: string | null,
	credentialEnvironmentVariable: string | null | undefined,
	removeCredential: boolean
): Buffer {
	const registryKey = registryLineKey(scope);
	const existingLines = source.toString("utf8").split(/\r?\n/);
	const retained: string[] = [];
	let previousRegistryUrl: string | null = null;
	for (const line of existingLines) {
		const separator = line.indexOf("=");
		const key = separator >= 0 ? line.slice(0, separator).trim() : "";
		if (key === registryKey) {
			if (separator >= 0) {
				try {
					previousRegistryUrl = validateProjectPackageRegistryUrl(line.slice(separator + 1).trim());
				} catch {
					previousRegistryUrl = null;
				}
			}
			continue;
		}
		retained.push(line);
	}
	const credentialUrls = [previousRegistryUrl, url].filter((value): value is string => value !== null);
	const credentialKeys = new Set(credentialUrls.map(registryCredentialKey));
	const filtered = retained.filter((line) => {
		const separator = line.indexOf("=");
		const key = separator >= 0 ? line.slice(0, separator).trim() : "";
		return !credentialKeys.has(key) || (credentialEnvironmentVariable === undefined && !removeCredential);
	});
	while (filtered.length && !filtered[filtered.length - 1].trim()) {
		filtered.pop();
	}
	if (action === "upsert") {
		filtered.push(`${registryKey}=${url}`);
		if (credentialEnvironmentVariable) {
			filtered.push(`${registryCredentialKey(url!)}=\${${credentialEnvironmentVariable}}`);
		}
	}
	return Buffer.from(`${filtered.join("\n")}\n`, "utf8");
}

/** Creates an expiring, non-mutating plan for one project-root .npmrc registry change. */
export async function planProjectPackageRegistryChange(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data?.action !== "upsert" && data?.action !== "remove") {
		throw new Error('action must be "upsert" or "remove".');
	}
	const context = await getProjectPackageContext(options);
	const configuration = await registryConfiguration(context);
	if (data.expectedFingerprint !== undefined && data.expectedFingerprint !== configuration.fingerprint) {
		throw new Error(`Registry configuration changed since inspection; expected ${String(data.expectedFingerprint)} but found ${configuration.fingerprint}.`);
	}
	const scope = data.scope === undefined || data.scope === null || data.scope === "" ? null : validateScope(data.scope);
	const url = data.action === "upsert" ? validateProjectPackageRegistryUrl(data.url) : null;
	const credentialEnvironmentVariable = validateCredentialEnvironmentVariable(data.credentialEnvironmentVariable);
	const removeCredential = data.removeCredential === true || credentialEnvironmentVariable === null;
	if (data.action === "remove" && credentialEnvironmentVariable !== undefined && credentialEnvironmentVariable !== null) {
		throw new Error("credentialEnvironmentVariable can name a credential only for an upsert plan; use removeCredential for removal.");
	}
	const source = configuration.files.find((file) => file.path === ".npmrc")?.bytes ?? Buffer.alloc(0);
	const resultBytes = updateRegistryConfiguration(source, data.action, scope, url, credentialEnvironmentVariable, removeCredential);
	if (resultBytes.byteLength > maximumRegistryConfigurationBytes) {
		throw new Error(`Planned .npmrc exceeds the ${maximumRegistryConfigurationBytes}-byte safety limit.`);
	}
	const now = Date.now();
	const plan: IProjectPackageRegistryPlan = {
		id: randomUUID(),
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + registryPlanLifetimeMs).toISOString(),
		sourceFingerprint: configuration.fingerprint,
		action: data.action,
		scope,
		url,
		credentialEnvironmentVariable,
		removeCredential,
		resultBytes,
		resultSha256: packageSha256(resultBytes),
		changed: !resultBytes.equals(source),
	};
	registryPlanMap(scene).set(plan.id, plan);
	return registryPlanPublic(plan);
}

async function writeRegistryConfigurationAtomically(context: IProjectPackageContext, plan: IProjectPackageRegistryPlan): Promise<void> {
	const target = join(context.projectRoot, ".npmrc");
	const temporary = join(context.projectRoot, `.npmrc.zvibe-${plan.id}.tmp`);
	const backup = join(context.projectRoot, `.npmrc.zvibe-${plan.id}.bak`);
	let targetExists = false;
	let mode = 0o600;
	try {
		const targetStat = await lstat(target);
		if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
			throw new Error(".npmrc must be a regular project-root file and cannot be a symbolic link.");
		}
		targetExists = true;
		mode = targetStat.mode & 0o777;
	} catch (error: any) {
		if (error?.code !== "ENOENT") {
			throw error;
		}
	}
	await writeFile(temporary, plan.resultBytes, { flag: "wx", mode });
	let backedUp = false;
	try {
		if (targetExists) {
			await rename(target, backup);
			backedUp = true;
		}
		await rename(temporary, target);
		if (backedUp) {
			await unlink(backup);
		}
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		if (backedUp) {
			await rename(backup, target).catch(() => undefined);
		}
		throw error;
	}
}

/** Applies one exact, unexpired registry plan after confirmation and stale-state validation. */
export async function applyProjectPackageRegistryPlan(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data?.confirm !== true) {
		throw new Error("confirm must be true to apply a project package registry plan.");
	}
	if (typeof data?.planId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.planId)) {
		throw new Error("planId must be a registry plan UUID returned by plan_project_package_registry_change.");
	}
	const plans = registryPlanMap(scene);
	const plan = plans.get(data.planId);
	if (!plan) {
		throw new Error(`Registry plan "${data.planId}" is missing or expired; create a fresh plan.`);
	}
	if (data.expectedFingerprint !== plan.sourceFingerprint) {
		throw new Error(`expectedFingerprint must exactly match the registry plan source fingerprint ${plan.sourceFingerprint}.`);
	}
	const context = await getProjectPackageContext(options);
	const configuration = await registryConfiguration(context);
	if (configuration.fingerprint !== plan.sourceFingerprint) {
		throw new Error(`Registry configuration changed after planning; expected ${plan.sourceFingerprint} but found ${configuration.fingerprint}.`);
	}
	await writeRegistryConfigurationAtomically(context, plan);
	const appliedContext = await getProjectPackageContext(options);
	const appliedConfiguration = await registryConfiguration(appliedContext);
	const appliedFile = appliedConfiguration.files.find((file) => file.path === ".npmrc");
	if (!appliedFile || appliedFile.sha256 !== plan.resultSha256) {
		throw new Error("Registry configuration postcondition failed: .npmrc does not match the planned SHA-256.");
	}
	plans.delete(plan.id);
	return {
		applied: true,
		plan: registryPlanPublic(plan),
		fingerprint: appliedConfiguration.fingerprint,
		files: appliedConfiguration.files.map((file) => ({ path: file.path, bytes: file.bytes.byteLength, sha256: file.sha256 })),
		registries: appliedConfiguration.registries.map(publicRegistry),
	};
}
