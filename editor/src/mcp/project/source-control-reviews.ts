import { createHash, randomUUID } from "crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { getProjectCollaborationStatus, resolveProjectCollaborationActor } from "./collaboration";

const configurationVersion = 1;
const maximumConfigurationBytes = 64 * 1024;
const maximumResponseBytes = 2 * 1024 * 1024;
const requestTimeoutMilliseconds = 15_000;
const operationGuardStaleMilliseconds = 10_000;

type ReviewProvider = "github" | "gitlab" | "bitbucket" | "azure";
type ReviewAuthenticationMode = "provider" | "pat" | "bearer";

interface IReviewProviderConfiguration {
	version: 1;
	enabled: boolean;
	provider: ReviewProvider;
	apiBaseUrl: string;
	repository: string;
	tokenEnvironmentVariable: string;
	authenticationMode: ReviewAuthenticationMode;
}

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

function metadataDirectory(root: string): string {
	return join(root, ".babylon-editor");
}

function configurationPath(root: string): string {
	return join(metadataDirectory(root), "source-control-review-provider.json");
}

function defaultConfiguration(): IReviewProviderConfiguration {
	return {
		version: configurationVersion,
		enabled: false,
		provider: "github",
		apiBaseUrl: "https://api.github.com/",
		repository: "",
		tokenEnvironmentVariable: "GITHUB_TOKEN",
		authenticationMode: "provider",
	};
}

function validateProvider(value: unknown): ReviewProvider {
	if (value !== "github" && value !== "gitlab" && value !== "bitbucket" && value !== "azure") {
		throw new Error("provider must be github, gitlab, bitbucket, or azure.");
	}
	return value;
}

function validateApiBaseUrl(value: unknown, provider: ReviewProvider): string {
	if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value)) {
		throw new Error("apiBaseUrl must be a valid credential-free URL of at most 2048 characters.");
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("apiBaseUrl must be a valid URL.");
	}
	const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("apiBaseUrl must use HTTPS; loopback HTTP is allowed only for local development and tests.");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("apiBaseUrl must not contain credentials, query parameters, or fragments.");
	}
	if (provider === "gitlab" && !url.pathname.endsWith("/api/v4") && !url.pathname.endsWith("/api/v4/")) {
		throw new Error("GitLab apiBaseUrl must end with /api/v4.");
	}
	if (provider === "bitbucket" && !url.pathname.endsWith("/2.0") && !url.pathname.endsWith("/2.0/")) {
		throw new Error("Bitbucket apiBaseUrl must end with /2.0.");
	}
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
	return url.toString();
}

function validateRepository(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 512 ||
		!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value) ||
		value.split("/").some((part) => part === "." || part === "..")
	) {
		throw new Error("repository must be a slash-separated owner/project path of at most 512 safe characters.");
	}
	return value;
}

function validateProviderRepository(value: unknown, provider: ReviewProvider): string {
	const repository = validateRepository(value);
	if (provider === "azure" && repository.split("/").length !== 3) {
		throw new Error("Azure DevOps repository must be organization/project/repository using exactly three safe path segments.");
	}
	return repository;
}

function validateAuthenticationMode(value: unknown, provider: ReviewProvider): ReviewAuthenticationMode {
	const mode = value ?? (provider === "azure" ? "pat" : "provider");
	if (mode !== "provider" && mode !== "pat" && mode !== "bearer") {
		throw new Error("authenticationMode must be provider, pat, or bearer.");
	}
	if (provider !== "azure" && mode !== "provider") {
		throw new Error("pat and bearer authenticationMode overrides are supported only by the Azure DevOps provider.");
	}
	return provider === "azure" && mode === "provider" ? "pat" : mode;
}

function validateEnvironmentVariable(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value)) {
		throw new Error("tokenEnvironmentVariable must be an uppercase environment-variable name of at most 128 characters.");
	}
	return value;
}

function validateConfiguration(value: any): IReviewProviderConfiguration {
	if (!value || value.version !== configurationVersion || typeof value.enabled !== "boolean") {
		throw new Error("Source-control review provider configuration has an unsupported or malformed schema.");
	}
	const provider = validateProvider(value.provider);
	return {
		version: configurationVersion,
		enabled: value.enabled,
		provider,
		apiBaseUrl: validateApiBaseUrl(value.apiBaseUrl, provider),
		repository: value.enabled
			? validateProviderRepository(value.repository, provider)
			: typeof value.repository === "string" && value.repository
				? validateProviderRepository(value.repository, provider)
				: "",
		tokenEnvironmentVariable: validateEnvironmentVariable(value.tokenEnvironmentVariable),
		authenticationMode: validateAuthenticationMode(value.authenticationMode, provider),
	};
}

async function requireContainedMetadataDirectory(root: string): Promise<string> {
	const directory = metadataDirectory(root);
	await mkdir(directory, { recursive: true });
	const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
	if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}/`)) {
		throw new Error("Source-control review configuration metadata must stay inside the active project.");
	}
	return realDirectory;
}

async function readConfiguration(root: string): Promise<IReviewProviderConfiguration> {
	const path = configurationPath(root);
	try {
		const details = await lstat(path);
		if (!details.isFile() || details.isSymbolicLink() || details.size > maximumConfigurationBytes) {
			throw new Error(`Source-control review provider configuration must be a regular non-symlink file of at most ${maximumConfigurationBytes} bytes.`);
		}
		await requireContainedMetadataDirectory(root);
		return validateConfiguration(JSON.parse(await readFile(path, "utf-8")));
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return defaultConfiguration();
		}
		if (error instanceof SyntaxError) {
			throw new Error("Source-control review provider configuration contains invalid JSON.");
		}
		throw error;
	}
}

async function writeConfiguration(root: string, configuration: IReviewProviderConfiguration): Promise<void> {
	await requireContainedMetadataDirectory(root);
	const path = configurationPath(root);
	const existing = await lstat(path).catch((error: any) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
	if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
		throw new Error("Source-control review provider configuration must not be a symlink or non-file entry.");
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(configuration, null, "\t")}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function withConfigurationGuard<T>(root: string, action: () => Promise<T>): Promise<T> {
	const directory = await requireContainedMetadataDirectory(root);
	const guardPath = join(directory, ".source-control-review-provider.operation");
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			handle = await open(guardPath, "wx", 0o600);
			await handle.writeFile(`${Date.now()}\n`, "utf-8");
			break;
		} catch (error: any) {
			await handle?.close().catch(() => undefined);
			handle = null;
			if (error?.code !== "EEXIST") {
				throw error;
			}
			const details = await stat(guardPath).catch(() => null);
			if (details && Date.now() - details.mtimeMs > operationGuardStaleMilliseconds) {
				await unlink(guardPath).catch(() => undefined);
			} else {
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
	}
	if (!handle) {
		throw new Error("Source-control review provider configuration is busy. Retry the operation.");
	}
	try {
		return await action();
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

async function requireAdmin(scene: Scene, data: any, options: IMCPActionOptions, action: string): Promise<void> {
	const status = await getProjectCollaborationStatus(scene, { collaborationToken: data.collaborationToken }, options);
	if (status.enforcementEnabled) {
		const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
		if (actor.role !== "admin") {
			throw new Error(`${action} requires the collaboration admin role.`);
		}
	}
}

function requireConfirmation(data: any, action: string): void {
	if (data.confirm !== true) {
		throw new Error(`confirm must be true to ${action}.`);
	}
}

function publicConfiguration(configuration: IReviewProviderConfiguration): any {
	return {
		...configuration,
		storage: ".babylon-editor/source-control-review-provider.json",
		tokenConfigured: Boolean(process.env[configuration.tokenEnvironmentVariable]),
	};
}

function requireEnabledConfiguration(configuration: IReviewProviderConfiguration): IReviewProviderConfiguration {
	if (!configuration.enabled) {
		throw new Error("Hosted source-control reviews are disabled. Configure and enable a provider first.");
	}
	return configuration;
}

function accessToken(configuration: IReviewProviderConfiguration): string {
	const token = process.env[configuration.tokenEnvironmentVariable];
	if (!token || token.length < 8 || token.length > 2048 || /[\s\0]/.test(token)) {
		throw new Error(`Environment variable ${configuration.tokenEnvironmentVariable} must contain a valid non-whitespace provider access token.`);
	}
	return token;
}

function providerUrl(configuration: IReviewProviderConfiguration, path: string, query?: Record<string, string>): URL {
	const url = new URL(path.replace(/^\//, ""), configuration.apiBaseUrl);
	const parameters = { ...(configuration.provider === "azure" ? { "api-version": "7.1" } : {}), ...(query ?? {}) };
	for (const [key, value] of Object.entries(parameters)) {
		url.searchParams.set(key, value);
	}
	return url;
}

function azureRepositoryParts(configuration: IReviewProviderConfiguration): { organization: string; project: string; repository: string } {
	const [organization, project, repository] = configuration.repository.split("/");
	if (!organization || !project || !repository) {
		throw new Error("Azure DevOps repository configuration is malformed; expected organization/project/repository.");
	}
	return { organization, project, repository };
}

function repositoryApiPath(configuration: IReviewProviderConfiguration): string {
	if (configuration.provider === "github") {
		return `repos/${configuration.repository}`;
	}
	if (configuration.provider === "gitlab") {
		return `projects/${encodeURIComponent(configuration.repository)}`;
	}
	if (configuration.provider === "bitbucket") {
		return `repositories/${configuration.repository}`;
	}
	const azure = azureRepositoryParts(configuration);
	return `${encodeURIComponent(azure.organization)}/${encodeURIComponent(azure.project)}/_apis/git/repositories/${encodeURIComponent(azure.repository)}`;
}

function reviewCollectionPath(configuration: IReviewProviderConfiguration): string {
	const noun = configuration.provider === "github" ? "pulls" : configuration.provider === "gitlab" ? "merge_requests" : "pullrequests";
	return `${repositoryApiPath(configuration)}/${noun}`;
}

function sanitizeProviderText(value: unknown, maximumLength: number): string {
	return String(value ?? "")
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/Basic\s+[^\s]+/gi, "Basic [redacted]")
		.replace(/private-token\s*[:=]\s*[^\s]+/gi, "private-token: [redacted]")
		.replace(/[\r\0]/g, "")
		.slice(0, maximumLength);
}

function sanitizeProviderError(value: unknown, token: string): string {
	return sanitizeProviderText(value, 512)
		.replaceAll(token, "[redacted]")
		.replace(/\b[A-Za-z0-9_+=/-]{24,}\b/g, "[redacted]");
}

async function readBoundedResponse(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(declared) && declared > maximumResponseBytes) {
		throw new Error(`Provider response exceeds the ${maximumResponseBytes}-byte limit.`);
	}
	if (!response.body) {
		return "";
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const next = await reader.read();
		if (next.done) {
			break;
		}
		total += next.value.byteLength;
		if (total > maximumResponseBytes) {
			await reader.cancel();
			throw new Error(`Provider response exceeds the ${maximumResponseBytes}-byte limit.`);
		}
		chunks.push(next.value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function providerRequest(configuration: IReviewProviderConfiguration, method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<any> {
	const token = accessToken(configuration);
	const headers: Record<string, string> = { Accept: "application/json" };
	if (configuration.provider === "github" || configuration.provider === "bitbucket") {
		headers.Authorization = `Bearer ${token}`;
		if (configuration.provider === "github") {
			headers["X-GitHub-Api-Version"] = "2022-11-28";
		}
	} else if (configuration.provider === "gitlab") {
		headers["PRIVATE-TOKEN"] = token;
	} else {
		headers.Authorization = configuration.authenticationMode === "bearer" ? `Bearer ${token}` : `Basic ${Buffer.from(`:${token}`, "utf-8").toString("base64")}`;
	}
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	let response: Response;
	try {
		response = await fetch(providerUrl(configuration, path, query), {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(requestTimeoutMilliseconds),
		});
	} catch (error) {
		throw new Error(`Unable to contact the configured ${configuration.provider} API: ${sanitizeProviderText(error instanceof Error ? error.message : error, 256)}`);
	}
	const text = await readBoundedResponse(response);
	let parsed: any = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`The configured ${configuration.provider} API returned malformed JSON.`);
		}
	}
	if (!response.ok) {
		const message = sanitizeProviderError(parsed?.message ?? parsed?.error_description ?? parsed?.error ?? `HTTP ${response.status}`, token);
		throw new Error(`${configuration.provider} review request failed (${response.status}): ${message}`);
	}
	return { data: parsed, headers: response.headers, status: response.status };
}

function validateReviewNumber(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
		throw new Error("number must be a positive review request number.");
	}
	return value as number;
}

function validateReviewState(value: unknown): "open" | "closed" | "all" {
	const state = value ?? "open";
	if (state !== "open" && state !== "closed" && state !== "all") {
		throw new Error("state must be open, closed, or all.");
	}
	return state;
}

function validateLimit(value: unknown): number {
	const limit = value ?? 20;
	if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) {
		throw new Error("limit must be an integer from 1 through 50.");
	}
	return limit as number;
}

function validateText(value: unknown, field: string, maximum: number, required: boolean): string {
	if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (required && !value.trim())) {
		throw new Error(`${field} must be ${required ? "a non-empty " : ""}text of at most ${maximum} characters without null bytes.`);
	}
	return value.trim();
}

function validateRef(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 255 ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
		value.includes("..") ||
		value.includes("@{") ||
		value.endsWith(".lock") ||
		value.endsWith("/")
	) {
		throw new Error(`${field} must be a safe branch/ref name of at most 255 characters.`);
	}
	return value;
}

function validateExpectedSha(value: unknown): string {
	if (typeof value !== "string" || !/^[a-fA-F0-9]{40,64}$/.test(value)) {
		throw new Error("expectedHeadSha must be the exact 40–64 character hexadecimal head SHA returned by review inspection.");
	}
	return value.toLowerCase();
}

function safeWebUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 2048) {
		return null;
	}
	try {
		const url = new URL(value);
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
}

function normalizeReview(configuration: IReviewProviderConfiguration, value: any, includeBody: boolean): any {
	if (configuration.provider === "github") {
		return {
			number: value.number,
			title: sanitizeProviderText(value.title, 512),
			...(includeBody ? { body: sanitizeProviderText(value.body, 65_536) } : {}),
			state: value.merged_at ? "merged" : value.state === "closed" ? "closed" : "open",
			draft: value.draft === true,
			author: sanitizeProviderText(value.user?.login, 128),
			head: { ref: sanitizeProviderText(value.head?.ref, 255), sha: sanitizeProviderText(value.head?.sha, 64) },
			base: { ref: sanitizeProviderText(value.base?.ref, 255), sha: sanitizeProviderText(value.base?.sha, 64) },
			mergeable: typeof value.mergeable === "boolean" ? value.mergeable : null,
			createdAt: sanitizeProviderText(value.created_at, 64),
			updatedAt: sanitizeProviderText(value.updated_at, 64),
			webUrl: safeWebUrl(value.html_url),
		};
	}
	if (configuration.provider === "bitbucket") {
		return {
			number: value.id,
			title: sanitizeProviderText(value.title, 512),
			...(includeBody ? { body: sanitizeProviderText(value.description, 65_536) } : {}),
			state: value.state === "MERGED" ? "merged" : value.state === "DECLINED" || value.state === "SUPERSEDED" ? "closed" : "open",
			draft: value.draft === true,
			author: sanitizeProviderText(value.author?.nickname ?? value.author?.display_name ?? value.author?.uuid, 128),
			head: { ref: sanitizeProviderText(value.source?.branch?.name, 255), sha: sanitizeProviderText(value.source?.commit?.hash, 64) },
			base: { ref: sanitizeProviderText(value.destination?.branch?.name, 255), sha: sanitizeProviderText(value.destination?.commit?.hash, 64) },
			mergeable: typeof value.merge_commit === "object" ? true : value.state === "OPEN" ? null : null,
			createdAt: sanitizeProviderText(value.created_on, 64),
			updatedAt: sanitizeProviderText(value.updated_on, 64),
			webUrl: safeWebUrl(value.links?.html?.href),
		};
	}
	if (configuration.provider === "azure") {
		const sourceRef = sanitizeProviderText(value.sourceRefName, 255).replace(/^refs\/heads\//, "");
		const targetRef = sanitizeProviderText(value.targetRefName, 255).replace(/^refs\/heads\//, "");
		return {
			number: value.pullRequestId,
			title: sanitizeProviderText(value.title, 512),
			...(includeBody ? { body: sanitizeProviderText(value.description, 65_536) } : {}),
			state: value.status === "completed" ? "merged" : value.status === "abandoned" ? "closed" : "open",
			draft: value.isDraft === true,
			author: sanitizeProviderText(value.createdBy?.displayName ?? value.createdBy?.uniqueName ?? value.createdBy?.id, 128),
			head: { ref: sourceRef, sha: sanitizeProviderText(value.lastMergeSourceCommit?.commitId, 64) },
			base: { ref: targetRef, sha: sanitizeProviderText(value.lastMergeTargetCommit?.commitId, 64) },
			mergeable: value.mergeStatus === "succeeded" ? true : value.mergeStatus === "conflicts" || value.mergeStatus === "failure" ? false : null,
			createdAt: sanitizeProviderText(value.creationDate, 64),
			updatedAt: sanitizeProviderText(value.closedDate ?? value.creationDate, 64),
			webUrl: safeWebUrl(value._links?.web?.href),
		};
	}
	return {
		number: value.iid,
		title: sanitizeProviderText(value.title, 512),
		...(includeBody ? { body: sanitizeProviderText(value.description, 65_536) } : {}),
		state: value.state === "merged" ? "merged" : value.state === "closed" ? "closed" : "open",
		draft: value.draft === true || value.work_in_progress === true,
		author: sanitizeProviderText(value.author?.username, 128),
		head: { ref: sanitizeProviderText(value.source_branch, 255), sha: sanitizeProviderText(value.sha ?? value.diff_refs?.head_sha, 64) },
		base: { ref: sanitizeProviderText(value.target_branch, 255), sha: sanitizeProviderText(value.diff_refs?.base_sha, 64) },
		mergeable: value.has_conflicts === true ? false : value.merge_status === "can_be_merged" ? true : null,
		createdAt: sanitizeProviderText(value.created_at, 64),
		updatedAt: sanitizeProviderText(value.updated_at, 64),
		webUrl: safeWebUrl(value.web_url),
	};
}

async function currentConfiguration(options: IMCPActionOptions): Promise<{ root: string; configuration: IReviewProviderConfiguration }> {
	const root = await realpath(projectDirectory(options));
	return { root, configuration: requireEnabledConfiguration(await readConfiguration(root)) };
}

/** Returns the persisted hosted-review provider configuration without access-token contents. */
export async function getProjectSourceControlReviewProvider(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	const root = await realpath(projectDirectory(options));
	return publicConfiguration(await readConfiguration(root));
}

/** Atomically configures environment-authenticated GitHub, GitLab, Bitbucket, or Azure DevOps review integration. */
export async function setProjectSourceControlReviewProvider(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireAdmin(scene, data, options, "Hosted review provider configuration");
	requireConfirmation(data, "change hosted review provider configuration");
	const root = await realpath(projectDirectory(options));
	const provider = validateProvider(data.provider ?? "github");
	const configuration = validateConfiguration({
		version: configurationVersion,
		enabled: data.enabled === true,
		provider,
		apiBaseUrl:
			data.apiBaseUrl ??
			(provider === "github"
				? "https://api.github.com/"
				: provider === "gitlab"
					? "https://gitlab.com/api/v4/"
					: provider === "bitbucket"
						? "https://api.bitbucket.org/2.0/"
						: "https://dev.azure.com/"),
		repository: data.repository ?? "",
		tokenEnvironmentVariable:
			data.tokenEnvironmentVariable ??
			(provider === "github" ? "GITHUB_TOKEN" : provider === "gitlab" ? "GITLAB_TOKEN" : provider === "bitbucket" ? "BITBUCKET_TOKEN" : "AZURE_DEVOPS_PAT"),
		authenticationMode: data.authenticationMode ?? (provider === "azure" ? "pat" : "provider"),
	});
	return withConfigurationGuard(root, async () => {
		await writeConfiguration(root, configuration);
		return publicConfiguration(configuration);
	});
}

/** Lists a bounded page of normalized pull or merge requests. */
export async function listProjectSourceControlReviews(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { configuration } = await currentConfiguration(options);
	const state = validateReviewState(data.state);
	const limit = validateLimit(data.limit);
	const providerState = configuration.provider === "gitlab" && state === "open" ? "opened" : configuration.provider === "bitbucket" ? state.toUpperCase() : state;
	const bitbucketStateQuery: Record<string, string> =
		state === "open" ? { state: "OPEN" } : state === "closed" ? { q: 'state="MERGED" OR state="DECLINED" OR state="SUPERSEDED"' } : {};
	const query: Record<string, string> =
		configuration.provider === "bitbucket"
			? { ...bitbucketStateQuery, pagelen: String(limit) }
			: configuration.provider === "azure"
				? { "searchCriteria.status": state === "open" ? "active" : "all", $top: String(state === "closed" ? 50 : limit) }
				: { state: providerState, per_page: String(limit) };
	const response = await providerRequest(configuration, "GET", reviewCollectionPath(configuration), query);
	const providerValues = configuration.provider === "bitbucket" ? response.data?.values : configuration.provider === "azure" ? response.data?.value : response.data;
	if (!Array.isArray(providerValues)) {
		throw new Error(`${configuration.provider} review list response is malformed.`);
	}
	const values =
		configuration.provider === "azure" && state === "closed"
			? providerValues.filter((review: any) => review.status === "completed" || review.status === "abandoned")
			: providerValues;
	const reviews = values.slice(0, limit).map((review: any) => normalizeReview(configuration, review, false));
	const hasMore =
		configuration.provider === "gitlab"
			? Boolean(response.headers.get("x-next-page"))
			: configuration.provider === "bitbucket"
				? typeof response.data?.next === "string"
				: configuration.provider === "azure"
					? Boolean(response.headers.get("x-ms-continuationtoken")) || values.length > limit
					: /rel="next"/.test(response.headers.get("link") ?? "");
	return { provider: configuration.provider, repository: configuration.repository, state, limit, count: reviews.length, hasMore, reviews };
}

/** Returns one normalized pull or merge request including bounded body text. */
export async function getProjectSourceControlReview(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { configuration } = await currentConfiguration(options);
	const number = validateReviewNumber(data.number);
	const response = await providerRequest(configuration, "GET", `${reviewCollectionPath(configuration)}/${number}`);
	return { provider: configuration.provider, repository: configuration.repository, review: normalizeReview(configuration, response.data, true) };
}

/** Creates a pull or merge request after explicit administrator confirmation. */
export async function createProjectSourceControlReview(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireAdmin(scene, data, options, "Hosted review creation");
	requireConfirmation(data, "create a hosted review request");
	const { configuration } = await currentConfiguration(options);
	const title = validateText(data.title, "title", 256, true);
	const body = validateText(data.body ?? "", "body", 65_536, false);
	const head = validateRef(data.head, "head");
	const base = validateRef(data.base, "base");
	let requestBody: any;
	if (configuration.provider === "github") {
		requestBody = { title, body, head, base, draft: data.draft === true };
	} else if (configuration.provider === "gitlab") {
		requestBody = { title: data.draft === true && !/^draft:/i.test(title) ? `Draft: ${title}` : title, description: body, source_branch: head, target_branch: base };
	} else if (configuration.provider === "bitbucket") {
		requestBody = {
			title: data.draft === true && !/^draft:/i.test(title) ? `Draft: ${title}` : title,
			description: body,
			source: { branch: { name: head } },
			destination: { branch: { name: base } },
			close_source_branch: false,
		};
	} else {
		requestBody = {
			title,
			description: body,
			sourceRefName: `refs/heads/${head}`,
			targetRefName: `refs/heads/${base}`,
			isDraft: data.draft === true,
		};
	}
	const response = await providerRequest(configuration, "POST", reviewCollectionPath(configuration), undefined, requestBody);
	return { created: true, provider: configuration.provider, repository: configuration.repository, review: normalizeReview(configuration, response.data, true) };
}

/** Submits an approval, request-changes review, or comment after explicit administrator confirmation. */
export async function submitProjectSourceControlReview(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireAdmin(scene, data, options, "Hosted review submission");
	requireConfirmation(data, "submit a hosted review decision or comment");
	const { configuration } = await currentConfiguration(options);
	const number = validateReviewNumber(data.number);
	const action = data.action;
	if (action !== "approve" && action !== "requestChanges" && action !== "comment") {
		throw new Error("action must be approve, requestChanges, or comment.");
	}
	const body = validateText(data.body ?? "", "body", 65_536, action !== "approve");
	if (configuration.provider === "github") {
		const event = action === "approve" ? "APPROVE" : action === "requestChanges" ? "REQUEST_CHANGES" : "COMMENT";
		const response = await providerRequest(configuration, "POST", `${repositoryApiPath(configuration)}/pulls/${number}/reviews`, undefined, { event, body });
		return { submitted: true, provider: configuration.provider, number, action, reviewId: response.data?.id ?? null, state: sanitizeProviderText(response.data?.state, 64) };
	}
	if (configuration.provider === "bitbucket") {
		const path = `${reviewCollectionPath(configuration)}/${number}`;
		if (action === "comment") {
			const response = await providerRequest(configuration, "POST", `${path}/comments`, undefined, { content: { raw: body } });
			return { submitted: true, provider: configuration.provider, number, action, noteId: response.data?.id ?? null };
		}
		let noteId: number | null = null;
		if (body) {
			const comment = await providerRequest(configuration, "POST", `${path}/comments`, undefined, { content: { raw: body } });
			noteId = Number.isInteger(comment.data?.id) ? comment.data.id : null;
		}
		const response = await providerRequest(configuration, "POST", `${path}/${action === "approve" ? "approve" : "request-changes"}`);
		return {
			submitted: true,
			provider: configuration.provider,
			number,
			action,
			noteId,
			approved: action === "approve" ? response.data?.approved === true : false,
			state: sanitizeProviderText(response.data?.state, 64),
			partialMutationPossible: Boolean(body),
		};
	}
	if (configuration.provider === "azure") {
		const path = `${reviewCollectionPath(configuration)}/${number}`;
		const createComment = async (): Promise<number | null> => {
			const response = await providerRequest(configuration, "POST", `${path}/threads`, undefined, {
				comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
				status: 1,
			});
			return Number.isInteger(response.data?.id) ? response.data.id : null;
		};
		if (action === "comment") {
			return { submitted: true, provider: configuration.provider, number, action, noteId: await createComment() };
		}
		const noteId = body ? await createComment() : null;
		const azure = azureRepositoryParts(configuration);
		const connection = await providerRequest(configuration, "GET", `${encodeURIComponent(azure.organization)}/_apis/connectionData`, {
			connectOptions: "1",
			lastChangeId: "-1",
			lastChangeId64: "-1",
		});
		const reviewerId = sanitizeProviderText(connection.data?.authenticatedUser?.id, 128);
		if (!/^[A-Fa-f0-9-]{36}$/.test(reviewerId)) {
			throw new Error("Azure DevOps did not return a valid authenticated reviewer identity.");
		}
		const response = await providerRequest(configuration, "PUT", `${path}/reviewers/${reviewerId}`, undefined, { vote: action === "approve" ? 10 : -10 });
		return {
			submitted: true,
			provider: configuration.provider,
			number,
			action,
			noteId,
			reviewId: reviewerId,
			approved: response.data?.vote === 10,
			state: response.data?.vote === -10 ? "rejected" : response.data?.vote === 10 ? "approved" : "unknown",
			partialMutationPossible: Boolean(body),
		};
	}
	if (action === "requestChanges") {
		throw new Error("GitLab does not expose a portable request-changes review action; submit a comment instead.");
	}
	if (action === "approve") {
		const response = await providerRequest(configuration, "POST", `${repositoryApiPath(configuration)}/merge_requests/${number}/approve`, undefined, {});
		return { submitted: true, provider: configuration.provider, number, action, approved: response.data?.approved === true };
	}
	const response = await providerRequest(configuration, "POST", `${repositoryApiPath(configuration)}/merge_requests/${number}/notes`, undefined, { body });
	return { submitted: true, provider: configuration.provider, number, action, noteId: response.data?.id ?? null };
}

/** Merges one pull or merge request only while its freshly inspected head SHA matches an explicit lease. */
export async function mergeProjectSourceControlReview(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireAdmin(scene, data, options, "Hosted review merge");
	requireConfirmation(data, "merge a hosted review request");
	const { configuration } = await currentConfiguration(options);
	const number = validateReviewNumber(data.number);
	const expectedHeadSha = validateExpectedSha(data.expectedHeadSha);
	const method = data.method ?? "merge";
	if (method !== "merge" && method !== "squash" && method !== "rebase") {
		throw new Error("method must be merge, squash, or rebase.");
	}
	const inspected = await providerRequest(configuration, "GET", `${reviewCollectionPath(configuration)}/${number}`);
	const review = normalizeReview(configuration, inspected.data, true);
	if (review.head.sha.toLowerCase() !== expectedHeadSha) {
		throw new Error("Hosted review head changed since inspection. Refresh the review and use its current expectedHeadSha.");
	}
	if (configuration.provider === "github") {
		const response = await providerRequest(configuration, "PUT", `${repositoryApiPath(configuration)}/pulls/${number}/merge`, undefined, {
			sha: expectedHeadSha,
			merge_method: method,
			...(data.commitTitle ? { commit_title: validateText(data.commitTitle, "commitTitle", 256, true) } : {}),
		});
		return {
			merged: response.data?.merged === true,
			provider: configuration.provider,
			number,
			method,
			headSha: expectedHeadSha,
			message: sanitizeProviderText(response.data?.message, 512),
		};
	}
	if (configuration.provider === "bitbucket") {
		if (method === "rebase") {
			throw new Error("Bitbucket Cloud pull requests do not expose a rebase merge strategy through this workflow.");
		}
		const response = await providerRequest(configuration, "POST", `${reviewCollectionPath(configuration)}/${number}/merge`, undefined, {
			type: "pullrequest",
			merge_strategy: method === "squash" ? "squash" : "merge_commit",
			close_source_branch: false,
			...(data.commitTitle ? { message: validateText(data.commitTitle, "commitTitle", 256, true) } : {}),
		});
		return {
			merged: response.data?.state === "MERGED",
			provider: configuration.provider,
			number,
			method,
			headSha: expectedHeadSha,
			review: normalizeReview(configuration, response.data, false),
		};
	}
	if (configuration.provider === "azure") {
		const response = await providerRequest(configuration, "PATCH", `${reviewCollectionPath(configuration)}/${number}`, undefined, {
			status: "completed",
			lastMergeSourceCommit: { commitId: expectedHeadSha },
			completionOptions: {
				mergeStrategy: method === "merge" ? "noFastForward" : method === "squash" ? "squash" : "rebase",
				deleteSourceBranch: false,
				bypassPolicy: false,
				...(data.commitTitle ? { mergeCommitMessage: validateText(data.commitTitle, "commitTitle", 256, true) } : {}),
			},
		});
		return {
			merged: response.data?.status === "completed",
			provider: configuration.provider,
			number,
			method,
			headSha: expectedHeadSha,
			review: normalizeReview(configuration, response.data, false),
		};
	}
	if (method === "rebase") {
		throw new Error("GitLab merge requests do not expose a portable rebase merge method through this workflow.");
	}
	const response = await providerRequest(configuration, "PUT", `${repositoryApiPath(configuration)}/merge_requests/${number}/merge`, undefined, {
		sha: expectedHeadSha,
		merge_when_pipeline_succeeds: false,
		squash: method === "squash",
		...(data.commitTitle ? { merge_commit_message: validateText(data.commitTitle, "commitTitle", 256, true) } : {}),
	});
	return {
		merged: response.data?.state === "merged",
		provider: configuration.provider,
		number,
		method,
		headSha: expectedHeadSha,
		review: normalizeReview(configuration, response.data, false),
	};
}

function validateNameList(value: unknown, field: string, maximumCount: number): string[] {
	if (!Array.isArray(value) || value.length > maximumCount) {
		throw new Error(`${field} must be an array containing at most ${maximumCount} names.`);
	}
	const names = value.map((entry) => {
		if (typeof entry !== "string" || !/^[A-Za-z0-9_.@+/{}-]{1,128}$/.test(entry) || /[\r\n\0]/.test(entry)) {
			throw new Error(`${field} entries must be 1–128 safe provider name characters.`);
		}
		return entry;
	});
	const unique = [...new Set(names)];
	if (unique.length !== names.length) {
		throw new Error(`${field} must not contain duplicate names.`);
	}
	return unique.sort((left, right) => left.localeCompare(right));
}

function reviewMetadata(configuration: IReviewProviderConfiguration, review: any): any {
	const normalized = normalizeReview(configuration, review, false);
	const reviewers =
		(configuration.provider === "github"
			? review.requested_reviewers?.map((entry: any) => entry.login)
			: configuration.provider === "gitlab"
				? review.reviewers?.map((entry: any) => entry.username)
				: configuration.provider === "bitbucket"
					? review.reviewers?.map((entry: any) => entry.uuid)
					: review.reviewers?.map((entry: any) => entry.id)) ?? [];
	const teams = configuration.provider === "github" ? (review.requested_teams?.map((entry: any) => entry.slug) ?? []) : [];
	const labels = (review.labels ?? []).map((entry: any) => (typeof entry === "string" ? entry : entry.name));
	const sanitized = {
		reviewers: reviewers
			.map((value: unknown) => sanitizeProviderText(value, 128))
			.filter(Boolean)
			.slice(0, 20)
			.sort(),
		teams: teams
			.map((value: unknown) => sanitizeProviderText(value, 128))
			.filter(Boolean)
			.slice(0, 20)
			.sort(),
		labels: labels
			.map((value: unknown) => sanitizeProviderText(value, 128))
			.filter(Boolean)
			.slice(0, 50)
			.sort(),
	};
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ provider: configuration.provider, repository: configuration.repository, number: normalized.number, headSha: normalized.head.sha, ...sanitized }))
		.digest("hex");
	return { provider: configuration.provider, repository: configuration.repository, number: normalized.number, headSha: normalized.head.sha, ...sanitized, fingerprint };
}

async function inspectReviewMetadata(configuration: IReviewProviderConfiguration, number: number): Promise<{ raw: any; metadata: any }> {
	const response = await providerRequest(configuration, "GET", `${reviewCollectionPath(configuration)}/${number}`);
	return { raw: response.data, metadata: reviewMetadata(configuration, response.data) };
}

/** Returns requested reviewers, teams, labels, head SHA, and an exact metadata fingerprint for one hosted review. */
export async function getProjectSourceControlReviewMetadata(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { configuration } = await currentConfiguration(options);
	return (await inspectReviewMetadata(configuration, validateReviewNumber(data.number))).metadata;
}

/** Replaces bounded review assignments/labels only while the inspected metadata fingerprint still matches. */
export async function setProjectSourceControlReviewMetadata(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireAdmin(scene, data, options, "Hosted review metadata mutation");
	requireConfirmation(data, "replace hosted review reviewers and labels");
	const { configuration } = await currentConfiguration(options);
	const number = validateReviewNumber(data.number);
	if (typeof data.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedFingerprint)) {
		throw new Error("expectedFingerprint must be the exact lowercase SHA-256 returned by review metadata inspection.");
	}
	const reviewers = validateNameList(data.reviewers ?? [], "reviewers", 20);
	const teams = validateNameList(data.teams ?? [], "teams", 20);
	const labels = validateNameList(data.labels ?? [], "labels", 50);
	const inspected = await inspectReviewMetadata(configuration, number);
	if (inspected.metadata.fingerprint !== data.expectedFingerprint) {
		throw new Error("Hosted review metadata or head changed since inspection. Refresh metadata before replacing reviewers or labels.");
	}
	if (configuration.provider === "github") {
		const addReviewers = reviewers.filter((name) => !inspected.metadata.reviewers.includes(name));
		const addTeams = teams.filter((name) => !inspected.metadata.teams.includes(name));
		const removeReviewers = inspected.metadata.reviewers.filter((name: string) => !reviewers.includes(name));
		const removeTeams = inspected.metadata.teams.filter((name: string) => !teams.includes(name));
		if (addReviewers.length || addTeams.length) {
			await providerRequest(configuration, "POST", `${repositoryApiPath(configuration)}/pulls/${number}/requested_reviewers`, undefined, {
				reviewers: addReviewers,
				team_reviewers: addTeams,
			});
		}
		if (removeReviewers.length || removeTeams.length) {
			await providerRequest(configuration, "DELETE", `${repositoryApiPath(configuration)}/pulls/${number}/requested_reviewers`, undefined, {
				reviewers: removeReviewers,
				team_reviewers: removeTeams,
			});
		}
		await providerRequest(configuration, "PUT", `${repositoryApiPath(configuration)}/issues/${number}/labels`, undefined, { labels });
	} else if (configuration.provider === "gitlab") {
		if (teams.length) {
			throw new Error("GitLab merge requests do not support team reviewer slugs; provide reviewers only.");
		}
		const reviewerIds: number[] = [];
		for (const username of reviewers) {
			const lookup = await providerRequest(configuration, "GET", "users", { username });
			const user = Array.isArray(lookup.data) ? lookup.data.find((candidate: any) => candidate.username === username) : null;
			if (!Number.isInteger(user?.id) || user.id < 1) {
				throw new Error(`GitLab reviewer username was not found: ${username}`);
			}
			reviewerIds.push(user.id);
		}
		await providerRequest(configuration, "PUT", `${repositoryApiPath(configuration)}/merge_requests/${number}`, undefined, {
			reviewer_ids: reviewerIds,
			labels: labels.join(","),
		});
	} else if (configuration.provider === "bitbucket") {
		if (teams.length || labels.length) {
			throw new Error("Bitbucket Cloud pull requests do not support team reviewer slugs or labels through this workflow.");
		}
		for (const reviewer of reviewers) {
			if (!/^\{[A-Fa-f0-9-]{36}\}$/.test(reviewer)) {
				throw new Error("Bitbucket reviewer identifiers must be exact {UUID} values returned by metadata inspection.");
			}
		}
		await providerRequest(configuration, "PUT", `${reviewCollectionPath(configuration)}/${number}`, undefined, { reviewers: reviewers.map((uuid) => ({ uuid })) });
	} else {
		if (teams.length) {
			throw new Error("Azure DevOps group identities are represented as reviewer IDs; provide all identities in reviewers and leave teams empty.");
		}
		for (const reviewer of reviewers) {
			if (!/^[A-Fa-f0-9-]{36}$/.test(reviewer)) {
				throw new Error("Azure DevOps reviewer identifiers must be exact GUID values returned by metadata inspection.");
			}
		}
		const path = `${reviewCollectionPath(configuration)}/${number}`;
		const addReviewers = reviewers.filter((id) => !inspected.metadata.reviewers.includes(id));
		const removeReviewers = inspected.metadata.reviewers.filter((id: string) => !reviewers.includes(id));
		for (const id of addReviewers) {
			await providerRequest(configuration, "PUT", `${path}/reviewers/${id}`, undefined, { vote: 0 });
		}
		for (const id of removeReviewers) {
			await providerRequest(configuration, "DELETE", `${path}/reviewers/${id}`);
		}
		const addLabels = labels.filter((name) => !inspected.metadata.labels.includes(name));
		const removeLabels = inspected.metadata.labels.filter((name: string) => !labels.includes(name));
		for (const name of addLabels) {
			await providerRequest(configuration, "POST", `${path}/labels`, undefined, { name });
		}
		for (const name of removeLabels) {
			const label = (inspected.raw.labels ?? []).find((candidate: any) => candidate.name === name);
			const labelId = sanitizeProviderText(label?.id, 128);
			if (!labelId || !/^[A-Za-z0-9-]{1,128}$/.test(labelId)) {
				throw new Error(`Azure DevOps label did not provide a removable ID: ${name}`);
			}
			await providerRequest(configuration, "DELETE", `${path}/labels/${encodeURIComponent(labelId)}`);
		}
	}
	const updated = await inspectReviewMetadata(configuration, number);
	return { updated: true, partialMutationPossible: configuration.provider === "github" || configuration.provider === "azure", metadata: updated.metadata };
}

function normalizedCheckSummary(checks: any[], runs: any[]): any {
	const states = [...checks, ...runs].map((entry) => entry.conclusion ?? entry.status ?? "unknown");
	return {
		total: states.length,
		pending: states.filter((state) => ["queued", "in_progress", "pending", "running", "created", "waiting_for_resource", "preparing"].includes(state)).length,
		succeeded: states.filter((state) => ["success", "passed"].includes(state)).length,
		failed: states.filter((state) => ["failure", "failed", "timed_out", "cancelled", "canceled", "action_required"].includes(state)).length,
	};
}

/** Lists bounded normalized checks plus rerunnable Actions runs or GitLab pipelines for one exact review head. */
export async function listProjectSourceControlReviewChecks(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { configuration } = await currentConfiguration(options);
	const number = validateReviewNumber(data.number);
	const detail = await getProjectSourceControlReview(scene, { number }, options);
	const headSha = detail.review.head.sha;
	if (!/^[a-fA-F0-9]{40,64}$/.test(headSha)) {
		throw new Error("Hosted review did not provide a valid head SHA for check inspection.");
	}
	if (configuration.provider === "github") {
		const [checksResponse, runsResponse] = await Promise.all([
			providerRequest(configuration, "GET", `${repositoryApiPath(configuration)}/commits/${headSha}/check-runs`, { per_page: "50" }),
			providerRequest(configuration, "GET", `${repositoryApiPath(configuration)}/actions/runs`, { head_sha: headSha, per_page: "50" }),
		]);
		const checks = (Array.isArray(checksResponse.data?.check_runs) ? checksResponse.data.check_runs : []).slice(0, 50).map((check: any) => ({
			id: check.id,
			name: sanitizeProviderText(check.name, 256),
			status: sanitizeProviderText(check.status, 64),
			conclusion: check.conclusion ? sanitizeProviderText(check.conclusion, 64) : null,
			startedAt: sanitizeProviderText(check.started_at, 64),
			completedAt: sanitizeProviderText(check.completed_at, 64),
			webUrl: safeWebUrl(check.html_url),
		}));
		const runs = (Array.isArray(runsResponse.data?.workflow_runs) ? runsResponse.data.workflow_runs : []).slice(0, 50).map((run: any) => ({
			id: run.id,
			name: sanitizeProviderText(run.name, 256),
			status: sanitizeProviderText(run.status, 64),
			conclusion: run.conclusion ? sanitizeProviderText(run.conclusion, 64) : null,
			attempt: Number.isInteger(run.run_attempt) ? run.run_attempt : null,
			headSha: sanitizeProviderText(run.head_sha, 64),
			createdAt: sanitizeProviderText(run.created_at, 64),
			updatedAt: sanitizeProviderText(run.updated_at, 64),
			webUrl: safeWebUrl(run.html_url),
		}));
		return { provider: configuration.provider, repository: configuration.repository, number, headSha, checks, runs, summary: normalizedCheckSummary(checks, runs) };
	}
	if (configuration.provider === "bitbucket") {
		const response = await providerRequest(configuration, "GET", `${reviewCollectionPath(configuration)}/${number}/statuses`, { pagelen: "50" });
		const checks = (Array.isArray(response.data?.values) ? response.data.values : []).slice(0, 50).map((status: any) => {
			const state = sanitizeProviderText(status.state, 64).toUpperCase();
			return {
				id: sanitizeProviderText(status.key, 128),
				name: sanitizeProviderText(status.name ?? status.key, 256),
				status: ["INPROGRESS", "PENDING"].includes(state) ? "in_progress" : "completed",
				conclusion: state === "SUCCESSFUL" ? "success" : state === "FAILED" ? "failure" : state === "STOPPED" ? "cancelled" : null,
				startedAt: sanitizeProviderText(status.created_on, 64),
				completedAt: sanitizeProviderText(status.updated_on, 64),
				webUrl: safeWebUrl(status.url),
			};
		});
		const runs: any[] = [];
		return {
			provider: configuration.provider,
			repository: configuration.repository,
			number,
			headSha,
			checks,
			runs,
			rerunSupported: false,
			rerunReason: "Bitbucket Cloud commit statuses do not expose a portable rerun endpoint.",
			summary: normalizedCheckSummary(checks, runs),
		};
	}
	if (configuration.provider === "azure") {
		const reviewResponse = await providerRequest(configuration, "GET", `${reviewCollectionPath(configuration)}/${number}`);
		const projectId = sanitizeProviderText(reviewResponse.data?.repository?.project?.id, 128);
		if (!/^[A-Fa-f0-9-]{36}$/.test(projectId)) {
			throw new Error("Azure DevOps review did not provide the project GUID required for policy inspection.");
		}
		const azure = azureRepositoryParts(configuration);
		const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${number}`;
		const [statusesResponse, policiesResponse] = await Promise.all([
			providerRequest(configuration, "GET", `${reviewCollectionPath(configuration)}/${number}/statuses`),
			providerRequest(configuration, "GET", `${encodeURIComponent(azure.organization)}/${encodeURIComponent(azure.project)}/_apis/policy/evaluations`, {
				artifactId,
				includeNotApplicable: "true",
				$top: "50",
				"api-version": "7.1-preview.1",
			}),
		]);
		const checks = (Array.isArray(statusesResponse.data?.value) ? statusesResponse.data.value : []).slice(0, 50).map((status: any) => {
			const state = sanitizeProviderText(status.state, 64);
			return {
				id: status.id,
				name: sanitizeProviderText(status.context?.name ?? status.description, 256),
				status: state === "pending" || state === "notSet" ? "in_progress" : "completed",
				conclusion: state === "succeeded" ? "success" : state === "failed" || state === "error" ? "failure" : state === "notApplicable" ? "skipped" : null,
				startedAt: sanitizeProviderText(status.creationDate, 64),
				completedAt: sanitizeProviderText(status.updatedDate, 64),
				webUrl: safeWebUrl(status.targetUrl),
			};
		});
		const runs = (Array.isArray(policiesResponse.data?.value) ? policiesResponse.data.value : []).slice(0, 50).map((policy: any) => {
			const status = sanitizeProviderText(policy.status, 64);
			return {
				id: sanitizeProviderText(policy.evaluationId, 64),
				name: sanitizeProviderText(policy.configuration?.type?.displayName ?? `Policy ${policy.evaluationId}`, 256),
				status: status === "queued" || status === "running" ? status : "completed",
				conclusion: status === "approved" ? "success" : status === "rejected" || status === "broken" ? "failure" : status === "notApplicable" ? "skipped" : null,
				headSha,
				createdAt: sanitizeProviderText(policy.startedDate, 64),
				updatedAt: sanitizeProviderText(policy.completedDate, 64),
				webUrl: null,
			};
		});
		return { provider: configuration.provider, repository: configuration.repository, number, headSha, checks, runs, summary: normalizedCheckSummary(checks, runs) };
	}
	const pipelinesResponse = await providerRequest(configuration, "GET", `${repositoryApiPath(configuration)}/merge_requests/${number}/pipelines`, { per_page: "20" });
	const runs = (Array.isArray(pipelinesResponse.data) ? pipelinesResponse.data : []).slice(0, 20).map((pipeline: any) => ({
		id: pipeline.id,
		name: `Pipeline #${pipeline.id}`,
		status: sanitizeProviderText(pipeline.status, 64),
		conclusion: ["success", "failed", "canceled", "skipped"].includes(pipeline.status) ? sanitizeProviderText(pipeline.status, 64) : null,
		headSha: sanitizeProviderText(pipeline.sha, 64),
		createdAt: sanitizeProviderText(pipeline.created_at, 64),
		updatedAt: sanitizeProviderText(pipeline.updated_at, 64),
		webUrl: safeWebUrl(pipeline.web_url),
	}));
	let checks: any[] = [];
	if (runs.length) {
		const jobsResponse = await providerRequest(configuration, "GET", `${repositoryApiPath(configuration)}/pipelines/${runs[0].id}/jobs`, { per_page: "100" });
		checks = (Array.isArray(jobsResponse.data) ? jobsResponse.data : []).slice(0, 100).map((job: any) => ({
			id: job.id,
			name: sanitizeProviderText(job.name, 256),
			status: sanitizeProviderText(job.status, 64),
			conclusion: ["success", "failed", "canceled", "skipped"].includes(job.status) ? sanitizeProviderText(job.status, 64) : null,
			startedAt: sanitizeProviderText(job.started_at, 64),
			completedAt: sanitizeProviderText(job.finished_at, 64),
			webUrl: safeWebUrl(job.web_url),
		}));
	}
	return { provider: configuration.provider, repository: configuration.repository, number, headSha, checks, runs, summary: normalizedCheckSummary(checks, runs) };
}

/** Reruns a verified GitHub Actions run or retries a GitLab pipeline belonging to the exact current review head. */
export async function rerunProjectSourceControlReviewChecks(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireAdmin(scene, data, options, "Hosted review check rerun");
	requireConfirmation(data, "rerun hosted review checks");
	const { configuration } = await currentConfiguration(options);
	const number = validateReviewNumber(data.number);
	const expectedHeadSha = validateExpectedSha(data.expectedHeadSha);
	const runId = data.runId;
	if (configuration.provider === "azure") {
		if (typeof runId !== "string" || !/^[A-Fa-f0-9-]{36}$/.test(runId)) {
			throw new Error("Azure DevOps runId must be the exact policy evaluation GUID returned by check inspection.");
		}
	} else if (!Number.isInteger(runId) || runId < 1 || runId > Number.MAX_SAFE_INTEGER) {
		throw new Error("runId must be a positive safe integer returned by check inspection.");
	}
	const mode = data.mode ?? "failed";
	if (mode !== "failed" && mode !== "all") {
		throw new Error("mode must be failed or all.");
	}
	if (configuration.provider === "bitbucket") {
		throw new Error("Bitbucket Cloud commit statuses do not expose a portable rerun endpoint.");
	}
	const inspected = await listProjectSourceControlReviewChecks(scene, { number }, options);
	if (inspected.headSha.toLowerCase() !== expectedHeadSha) {
		throw new Error("Hosted review head changed since check inspection. Refresh checks and use the current expectedHeadSha.");
	}
	const run = inspected.runs.find((candidate: any) => candidate.id === runId);
	if (!run || run.headSha.toLowerCase() !== expectedHeadSha) {
		throw new Error("runId is not a rerunnable run or pipeline for the exact current review head.");
	}
	if (configuration.provider === "github") {
		await providerRequest(
			configuration,
			"POST",
			`${repositoryApiPath(configuration)}/actions/runs/${runId}/${mode === "failed" ? "rerun-failed-jobs" : "rerun"}`,
			undefined,
			{}
		);
	} else if (configuration.provider === "azure") {
		const azure = azureRepositoryParts(configuration);
		await providerRequest(
			configuration,
			"PATCH",
			`${encodeURIComponent(azure.organization)}/${encodeURIComponent(azure.project)}/_apis/policy/evaluations/${runId}`,
			{ "api-version": "7.1-preview.1" },
			{ status: "queued" }
		);
	} else {
		if (mode === "all") {
			throw new Error("GitLab pipeline retry supports failed/canceled jobs only; use mode=failed.");
		}
		await providerRequest(configuration, "POST", `${repositoryApiPath(configuration)}/pipelines/${runId}/retry`, undefined, {});
	}
	return { accepted: true, provider: configuration.provider, repository: configuration.repository, number, headSha: expectedHeadSha, runId, mode };
}
