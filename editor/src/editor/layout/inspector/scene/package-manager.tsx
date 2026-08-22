import { useEffect, useState } from "react";

import { Scene } from "babylonjs";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Checkbox } from "../../../../ui/shadcn/ui/checkbox";
import { Input } from "../../../../ui/shadcn/ui/input";

import {
	applyProjectPackagePlan,
	applyProjectPackageRegistryPlan,
	applyProjectPackageSampleImport,
	cancelProjectPackageOperation,
	getProjectPackageDependencyGraph,
	getProjectPackageDetails,
	getProjectPackageManager,
	getProjectPackageSampleDetails,
	getProjectPackageUpdates,
	listProjectPackageRegistries,
	listProjectPackageSamples,
	listProjectPackages,
	locateProjectPackageSample,
	planProjectPackageChanges,
	planProjectPackageRegistryChange,
	planProjectPackageSampleImport,
	searchProjectPackageRegistry,
	setProjectDevelopmentPackageTechnicalName,
} from "../../../../mcp/project/packages";

import { Editor } from "../../../main";
import { EditorInspectorSectionField } from "../fields/section";

type PackageManagerTab = "registry" | "installed" | "updates" | "dependencies" | "samples";
type PackageDependencyType = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
type PackageSourceType = "registry" | "git" | "local" | "tarball";

interface IPackageManagerInspectorProps {
	scene: Scene;
	editor: Editor;
}

interface IProjectPackageList {
	packageManager: string;
	name?: string;
	fingerprint: string;
	manifest: { path: string; sha256: string; bytes: number };
	directDependencies: { name: string; specification: string; dependencyType: PackageDependencyType }[];
	total: number;
	workspace: { root: string; relativePath: string | null; lockfileMutationRequiresOptIn: boolean } | null;
}

interface IProjectPackageManagerStatus {
	packageManager: string;
	available: boolean;
	version: string | null;
	fingerprint: string;
	workspace: { root: string; relativePath: string | null } | null;
	active: { id: string; kind: string; display: string; startedAt: string } | null;
	capabilities: { scriptsDisabledByDefault: boolean; workspaceRootOptIn: boolean };
}

interface IProjectPackageRegistry {
	id: string;
	name: string;
	scope: string | null;
	url: string;
	source: string;
	credential: { configured: boolean; available: boolean; environmentVariables: string[]; literalSecretPresent: boolean };
}

interface IProjectPackageRegistries {
	fingerprint: string;
	registries: IProjectPackageRegistry[];
	files: { path: string; bytes: number; sha256: string }[];
}

interface IRegistrySearchResult {
	name: string;
	version: string | null;
	description: string | null;
	score: number | null;
}

interface IProjectPackageUpdate {
	name: string;
	dependencyType: PackageDependencyType;
	requested: string;
	current: string | null;
	wanted: string | null;
	latest: string | null;
	wantedUpdateAvailable: boolean;
	latestUpdateAvailable: boolean;
	error: string | null;
}

interface IProjectPackageUpdates {
	fingerprint: string;
	updates: IProjectPackageUpdate[];
	availableCount: number;
}

interface IProjectPackageDependencyGraph {
	fingerprint: string;
	format: string;
	lockfile: { path: string; sha256: string | null } | null;
	nodes: { id: string; name: string; version: string | null; direct: boolean; dependencyTypes: PackageDependencyType[]; dependencies: Record<string, string> }[];
	edges: { from: string; to: string | null; name: string; requested: string; missing: boolean }[];
	warnings: string[];
	truncated: boolean;
	total: number;
}

interface IProjectPackageSample {
	id: string;
	packageName: string;
	packageVersion: string;
	displayName: string;
	description: string | null;
	publishedAt: string | null;
	sourcePath: string;
	imageCount: number;
	defaultTargetPath: string;
	defaultImportExists: boolean;
	fileCount: number;
	totalBytes: number;
	sourceSha256: string;
}

interface IProjectPackageSamples {
	fingerprint: string;
	samples: IProjectPackageSample[];
	errors: { packageName: string; error: string }[];
	offset: number;
	limit: number;
	count: number;
	total: number;
	hasMore: boolean;
	nextOffset: number | null;
	sortBy: "display-name" | "package-name" | "publish-date";
	sortDirection: "asc" | "desc";
}

interface IProjectPackagePlan {
	id: string;
	expiresAt: string;
	sourceFingerprint: string;
	changes: { operation: string; name: string; version: string | null; command: string }[];
	rollback: { packageJsonAndLockfiles: string; nodeModules: string };
}

interface IProjectPackageRegistryPlan {
	id: string;
	expiresAt: string;
	sourceFingerprint: string;
	action: string;
	scope: string | null;
	url: string | null;
	changed: boolean;
	resultSha256: string;
}

interface IProjectPackageSamplePlan {
	id: string;
	expiresAt: string;
	packageFingerprint: string;
	sample: IProjectPackageSample;
	targetPath: string;
	collision: string;
}

const dependencyTypes: PackageDependencyType[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const tabs: { id: PackageManagerTab; label: string }[] = [
	{ id: "registry", label: "Registry" },
	{ id: "installed", label: "Installed" },
	{ id: "updates", label: "Updates" },
	{ id: "dependencies", label: "Dependencies" },
	{ id: "samples", label: "Samples" },
];

function formatBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KiB`;
	}
	return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function shortHash(value: string | null | undefined): string {
	return value ? value.slice(0, 12) : "none";
}

export function PackageManagerInspector(props: IPackageManagerInspectorProps) {
	const [tab, setTab] = useState<PackageManagerTab>("registry");
	const [manager, setManager] = useState<IProjectPackageManagerStatus | null>(null);
	const [packages, setPackages] = useState<IProjectPackageList | null>(null);
	const [registries, setRegistries] = useState<IProjectPackageRegistries | null>(null);
	const [updates, setUpdates] = useState<IProjectPackageUpdates | null>(null);
	const [graph, setGraph] = useState<IProjectPackageDependencyGraph | null>(null);
	const [samples, setSamples] = useState<IProjectPackageSamples | null>(null);
	const [registryResults, setRegistryResults] = useState<IRegistrySearchResult[]>([]);
	const [packageDetails, setPackageDetails] = useState<any | null>(null);
	const [packagePlan, setPackagePlan] = useState<IProjectPackagePlan | null>(null);
	const [registryPlan, setRegistryPlan] = useState<IProjectPackageRegistryPlan | null>(null);
	const [samplePlan, setSamplePlan] = useState<IProjectPackageSamplePlan | null>(null);
	const [sampleDetails, setSampleDetails] = useState<any | null>(null);
	const [query, setQuery] = useState("");
	const [registryQuery, setRegistryQuery] = useState("");
	const [registryId, setRegistryId] = useState("");
	const [packageName, setPackageName] = useState("");
	const [packageVersion, setPackageVersion] = useState("");
	const [packageSourceType, setPackageSourceType] = useState<PackageSourceType>("registry");
	const [packageSource, setPackageSource] = useState("");
	const [packageSourceCommit, setPackageSourceCommit] = useState("");
	const [dependencyType, setDependencyType] = useState<PackageDependencyType>("dependencies");
	const [allowScripts, setAllowScripts] = useState(false);
	const [allowWorkspaceRoot, setAllowWorkspaceRoot] = useState(false);
	const [registryScope, setRegistryScope] = useState("");
	const [registryUrl, setRegistryUrl] = useState("https://registry.npmjs.org/");
	const [registryCredentialEnvironment, setRegistryCredentialEnvironment] = useState("");
	const [dependencyQuery, setDependencyQuery] = useState("");
	const [directOnly, setDirectOnly] = useState(false);
	const [sampleTarget, setSampleTarget] = useState("");
	const [sampleCollision, setSampleCollision] = useState<"fail" | "rename" | "replace">("fail");
	const [sampleSortBy, setSampleSortBy] = useState<"display-name" | "package-name" | "publish-date">("display-name");
	const [sampleSortDirection, setSampleSortDirection] = useState<"asc" | "desc">("asc");
	const [technicalName, setTechnicalName] = useState("");
	const [status, setStatus] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function refreshCore(): Promise<void> {
		const options = { editor: props.editor };
		const [nextManager, nextPackages, nextRegistries, nextGraph, nextSamples] = await Promise.all([
			getProjectPackageManager(props.scene, {}, options),
			listProjectPackages(props.scene, { limit: 500, query }, options),
			listProjectPackageRegistries(props.scene, { limit: 100 }, options),
			getProjectPackageDependencyGraph(props.scene, { limit: 500, directOnly, query: dependencyQuery }, options),
			listProjectPackageSamples(props.scene, { limit: 20, sortBy: sampleSortBy, sortDirection: sampleSortDirection }, options),
		]);
		setManager(nextManager as IProjectPackageManagerStatus);
		setPackages(nextPackages as IProjectPackageList);
		setRegistries(nextRegistries as IProjectPackageRegistries);
		setGraph(nextGraph as IProjectPackageDependencyGraph);
		setSamples(nextSamples as IProjectPackageSamples);
		setTechnicalName(String(nextPackages.name ?? ""));
		setStatus("Package state refreshed from exact manifest, lockfile, registry, dependency, and sample evidence.");
	}

	useEffect(() => {
		void refreshCore().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the project package manager."));
	}, []);

	async function run(action: () => Promise<void>): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Package Manager operation failed.");
		} finally {
			setBusy(false);
		}
	}

	function packageSourceData(): Record<string, unknown> {
		if (packageSourceType === "registry") {
			return { type: "registry" };
		}
		if (packageSourceType === "local") {
			return { type: "local", path: packageSource.trim() };
		}
		if (packageSourceType === "git") {
			return { type: "git", url: packageSource.trim(), ...(packageSourceCommit.trim() ? { commit: packageSourceCommit.trim() } : {}) };
		}
		return /^https?:\/\//i.test(packageSource.trim()) ? { type: "tarball", url: packageSource.trim() } : { type: "tarball", path: packageSource.trim() };
	}

	async function createPackagePlan(changes: Record<string, unknown>[]): Promise<void> {
		if (!packages) {
			throw new Error("Refresh the installed package state before planning a change.");
		}
		const plan = await planProjectPackageChanges(
			props.scene,
			{ expectedFingerprint: packages.fingerprint, changes, allowScripts, allowWorkspaceRoot },
			{ editor: props.editor }
		);
		setPackagePlan(plan as IProjectPackagePlan);
		setRegistryPlan(null);
		setSamplePlan(null);
		setStatus("Package change planned only. Review the exact commands below, then apply explicitly.");
	}

	async function planInstall(): Promise<void> {
		await createPackagePlan([
			{
				operation: "install",
				name: packageName.trim(),
				...(packageVersion.trim() ? { version: packageVersion.trim() } : {}),
				dependencyType,
				source: packageSourceData(),
			},
		]);
	}

	async function applyPackagePlan(): Promise<void> {
		if (!packagePlan) {
			return;
		}
		const result = await applyProjectPackagePlan(
			props.scene,
			{ planId: packagePlan.id, expectedFingerprint: packagePlan.sourceFingerprint, confirm: true },
			{ editor: props.editor }
		);
		setPackagePlan(null);
		setUpdates(null);
		setStatus(`Applied package plan ${String(result.plan?.id ?? packagePlan.id)} and verified its postconditions.`);
		await refreshCore();
	}

	async function searchRegistry(): Promise<void> {
		const result = await searchProjectPackageRegistry(props.scene, { query: registryQuery.trim(), limit: 50, ...(registryId ? { registryId } : {}) }, { editor: props.editor });
		setRegistryResults(result.packages as IRegistrySearchResult[]);
		setStatus(`Registry search returned ${String(result.count)} of ${String(result.total)} package(s).`);
	}

	async function inspectPackage(name: string, version?: string | null): Promise<void> {
		const details = await getProjectPackageDetails(
			props.scene,
			{ name, ...(version ? { version } : {}), limit: 50, ...(registryId ? { registryId } : {}) },
			{ editor: props.editor }
		);
		setPackageDetails(details);
		setStatus(`Loaded ${String(details.name)} version history without including unbounded README content.`);
	}

	async function createRegistryPlan(action: "upsert" | "remove"): Promise<void> {
		if (!registries) {
			throw new Error("Refresh configured registries before planning a change.");
		}
		const plan = await planProjectPackageRegistryChange(
			props.scene,
			{
				action,
				expectedFingerprint: registries.fingerprint,
				...(registryScope.trim() ? { scope: registryScope.trim() } : {}),
				...(action === "upsert" ? { url: registryUrl.trim() } : { removeCredential: true }),
				...(action === "upsert" && registryCredentialEnvironment.trim() ? { credentialEnvironmentVariable: registryCredentialEnvironment.trim() } : {}),
			},
			{ editor: props.editor }
		);
		setRegistryPlan(plan as IProjectPackageRegistryPlan);
		setPackagePlan(null);
		setSamplePlan(null);
		setStatus("Registry configuration change planned only. Review its exact scope, URL, and result hash before applying.");
	}

	async function applyRegistryPlan(): Promise<void> {
		if (!registryPlan) {
			return;
		}
		await applyProjectPackageRegistryPlan(
			props.scene,
			{ planId: registryPlan.id, expectedFingerprint: registryPlan.sourceFingerprint, confirm: true },
			{ editor: props.editor }
		);
		setRegistryPlan(null);
		setStatus("Applied the exact .npmrc registry plan and verified the resulting SHA-256.");
		await refreshCore();
	}

	async function refreshUpdates(): Promise<void> {
		const result = await getProjectPackageUpdates(props.scene, { limit: 50 }, { editor: props.editor });
		setUpdates(result as IProjectPackageUpdates);
		setStatus(`Checked ${String(result.count)} direct package(s); ${String(result.availableCount)} have wanted or latest updates.`);
	}

	async function planBulkUpdates(target: "wanted" | "latest"): Promise<void> {
		const selected =
			updates?.updates.filter((update) => (target === "wanted" ? update.wantedUpdateAvailable && update.wanted : update.latestUpdateAvailable && update.latest)) ?? [];
		if (!selected.length) {
			throw new Error(`No ${target} updates are available in the current result.`);
		}
		await createPackagePlan(
			selected.map((update) => ({
				operation: "update",
				name: update.name,
				version: target === "wanted" ? update.wanted : update.latest,
				dependencyType: update.dependencyType,
				source: { type: "registry" },
			}))
		);
	}

	async function refreshDependencies(): Promise<void> {
		const result = await getProjectPackageDependencyGraph(props.scene, { limit: 500, directOnly, query: dependencyQuery.trim() }, { editor: props.editor });
		setGraph(result as IProjectPackageDependencyGraph);
		setStatus(`Loaded ${String(result.count)} of ${String(result.total)} dependency node(s) from ${String(result.format)} evidence.`);
	}

	async function refreshSamples(offset = 0, append = false): Promise<void> {
		const result = await listProjectPackageSamples(props.scene, { offset, limit: 20, sortBy: sampleSortBy, sortDirection: sampleSortDirection }, { editor: props.editor });
		if (append && samples) {
			result.samples = [...samples.samples, ...result.samples];
			result.offset = 0;
			result.count = result.samples.length;
		}
		setSamples(result as IProjectPackageSamples);
		setStatus(`Discovered ${String(result.total)} bounded installed-package sample(s).`);
	}

	async function inspectSample(sample: IProjectPackageSample): Promise<void> {
		if (!samples) {
			throw new Error("Refresh Samples before opening details.");
		}
		const details = await getProjectPackageSampleDetails(
			props.scene,
			{
				sampleId: sample.id,
				expectedSourceSha256: sample.sourceSha256,
				expectedPackageFingerprint: samples.fingerprint,
				targetPath: sampleTarget.trim() || sample.defaultTargetPath,
			},
			{ editor: props.editor }
		);
		setSampleDetails(details);
		setStatus(`Loaded bounded Overview, Details, and ${String(details.images.length)} image card(s) for ${sample.displayName}.`);
	}

	async function locateSample(sample: IProjectPackageSample): Promise<void> {
		if (!samples) {
			throw new Error("Refresh Samples before locating an import.");
		}
		const result = await locateProjectPackageSample(
			props.scene,
			{
				sampleId: sample.id,
				expectedSourceSha256: sample.sourceSha256,
				expectedPackageFingerprint: samples.fingerprint,
				targetPath: sampleTarget.trim() || sample.defaultTargetPath,
			},
			{ editor: props.editor }
		);
		setStatus(`Located ${String(result.targetPath)} in the Assets Browser.`);
	}

	async function updateTechnicalName(): Promise<void> {
		if (!packages) {
			throw new Error("Refresh the package manifest before editing its technical name.");
		}
		const result = await setProjectDevelopmentPackageTechnicalName(
			props.scene,
			{
				technicalName: technicalName.trim(),
				expectedTechnicalName: packages.name ?? null,
				expectedFingerprint: packages.fingerprint,
				expectedManifestSha256: packages.manifest.sha256,
				confirm: true,
			},
			{ editor: props.editor }
		);
		setStatus(result.changed ? `Development package technical name changed to ${String(result.technicalName)}.` : "Technical name was already current.");
		await refreshCore();
	}

	async function createSamplePlan(sample: IProjectPackageSample): Promise<void> {
		const plan = await planProjectPackageSampleImport(
			props.scene,
			{
				sampleId: sample.id,
				expectedSourceSha256: sample.sourceSha256,
				expectedPackageFingerprint: samples?.fingerprint,
				collision: sampleCollision,
				...(sampleTarget.trim() ? { targetPath: sampleTarget.trim() } : {}),
			},
			{ editor: props.editor }
		);
		setSamplePlan(plan as IProjectPackageSamplePlan);
		setPackagePlan(null);
		setRegistryPlan(null);
		setStatus("Sample import planned only. Review the exact target and collision policy before applying.");
	}

	async function applySamplePlan(): Promise<void> {
		if (!samplePlan) {
			return;
		}
		await applyProjectPackageSampleImport(
			props.scene,
			{ planId: samplePlan.id, expectedSourceSha256: samplePlan.sample.sourceSha256, confirm: true },
			{ editor: props.editor }
		);
		setSamplePlan(null);
		setStatus("Imported the sample atomically and verified its complete source tree hash.");
		await refreshSamples();
	}

	function renderRegistry(): JSX.Element {
		return (
			<div className="flex flex-col gap-3">
				<div className="rounded border border-border p-2">
					<div className="mb-2 font-medium">Configured Registries</div>
					{registries?.registries.map((registry) => (
						<div key={registry.id} className="mb-1 rounded bg-input p-2">
							<div className="flex items-center justify-between gap-2">
								<span className="font-medium">{registry.scope ?? "Default"}</span>
								<span className="text-muted-foreground">{registry.source}</span>
							</div>
							<div className="truncate text-muted-foreground" title={registry.url}>
								{registry.url}
							</div>
							<div className={registry.credential.literalSecretPresent ? "text-red-400" : "text-muted-foreground"}>
								Credential: {registry.credential.available ? "available from environment" : registry.credential.configured ? "configured but unavailable" : "none"}
								{registry.credential.literalSecretPresent ? " · literal secret detected" : ""}
							</div>
						</div>
					))}
					<div className="mt-2 grid grid-cols-2 gap-2">
						<Input
							aria-label="Package registry scope"
							value={registryScope}
							onChange={(event) => setRegistryScope(event.currentTarget.value)}
							placeholder="@scope (blank = default)"
						/>
						<Input
							aria-label="Package registry URL"
							value={registryUrl}
							onChange={(event) => setRegistryUrl(event.currentTarget.value)}
							placeholder="https://registry.example/"
						/>
						<Input
							aria-label="Registry credential environment variable"
							value={registryCredentialEnvironment}
							onChange={(event) => setRegistryCredentialEnvironment(event.currentTarget.value)}
							placeholder="TOKEN_ENV (optional)"
						/>
						<div className="flex gap-2">
							<Button size="sm" disabled={busy || !registryUrl.trim()} onClick={() => void run(() => createRegistryPlan("upsert"))}>
								Plan Upsert
							</Button>
							<Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => createRegistryPlan("remove"))}>
								Plan Remove
							</Button>
						</div>
					</div>
				</div>

				<div className="rounded border border-border p-2">
					<div className="mb-2 font-medium">Discover Packages</div>
					<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
						<select
							aria-label="Package registry"
							className="h-8 rounded bg-input px-2"
							value={registryId}
							onChange={(event) => setRegistryId(event.currentTarget.value)}
						>
							<option value="">Automatic registry</option>
							{registries?.registries.map((registry) => (
								<option key={registry.id} value={registry.id}>
									{registry.name}
								</option>
							))}
						</select>
						<Input
							aria-label="Registry package search"
							value={registryQuery}
							onChange={(event) => setRegistryQuery(event.currentTarget.value)}
							placeholder="Search packages"
						/>
						<Button size="sm" disabled={busy || !registryQuery.trim()} onClick={() => void run(searchRegistry)}>
							Search
						</Button>
					</div>
					{registryResults.map((result) => (
						<div key={result.name} className="mt-2 flex items-start justify-between gap-2 rounded bg-input p-2">
							<div className="min-w-0">
								<div className="font-medium">
									{result.name} {result.version ? `· ${result.version}` : ""}
								</div>
								<div className="line-clamp-2 text-muted-foreground">{result.description ?? "No description"}</div>
							</div>
							<div className="flex shrink-0 gap-1">
								<Button size="sm" variant="secondary" onClick={() => void run(() => inspectPackage(result.name, result.version))}>
									Details
								</Button>
								<Button
									size="sm"
									disabled={!result.version}
									onClick={() => {
										setPackageName(result.name);
										setPackageVersion(result.version ?? "");
										setPackageSourceType("registry");
										setTab("installed");
									}}
								>
									Use
								</Button>
							</div>
						</div>
					))}
					{packageDetails && (
						<div className="mt-2 grid gap-2 md:grid-cols-2" data-testid="package-detail-cards">
							<div className="rounded border border-border p-2">
								<div className="font-medium">Overview</div>
								<div>
									{String(packageDetails.name)} · {String(packageDetails.selected?.version)}
								</div>
								<div className="text-muted-foreground">{String(packageDetails.description ?? "No description")}</div>
								<div className="mt-1 text-muted-foreground">
									Published {String(packageDetails.selected?.publishedAt ?? "unknown")} · modified {String(packageDetails.modifiedAt ?? "unknown")}
								</div>
							</div>
							<div className="rounded border border-border p-2">
								<div className="font-medium">Details</div>
								<div>License {String(packageDetails.license ?? "unspecified")}</div>
								<div className="truncate text-muted-foreground" title={String(packageDetails.repository ?? packageDetails.homepage ?? "")}>
									{String(packageDetails.repository ?? packageDetails.homepage ?? "No resource link")}
								</div>
								<div>{Object.keys(packageDetails.selected?.dependencies ?? {}).length} dependencies</div>
							</div>
							<div className="col-span-full flex flex-wrap gap-1 rounded border border-border p-2">
								{(packageDetails.versions as { version: string; deprecated: string | null }[]).slice(0, 20).map((version) => (
									<Button
										key={version.version}
										size="sm"
										variant="ghost"
										className="h-6 px-1"
										onClick={() => void run(() => inspectPackage(packageDetails.name, version.version))}
									>
										{version.version}
										{version.deprecated ? " ⚠" : ""}
									</Button>
								))}
								{packageDetails.hasMore && <span className="self-center text-muted-foreground">More versions available through paginated details.</span>}
							</div>
						</div>
					)}
				</div>
			</div>
		);
	}

	function renderInstalled(): JSX.Element {
		return (
			<div className="flex flex-col gap-3">
				<div className="rounded border border-border p-2" data-testid="development-package-technical-name">
					<div className="mb-2 font-medium">Development Package</div>
					<div className="flex gap-2">
						<Input
							aria-label="Development package technical name"
							value={technicalName}
							onChange={(event) => setTechnicalName(event.currentTarget.value)}
							placeholder="@scope/technical-name"
						/>
						<Button size="sm" disabled={busy || !technicalName.trim() || technicalName.trim() === packages?.name} onClick={() => void run(updateTechnicalName)}>
							Apply Name
						</Button>
					</div>
					<div className="mt-1 text-muted-foreground">Exact manifest {shortHash(packages?.manifest.sha256)} · changes only this development package manifest.</div>
				</div>

				<div className="rounded border border-border p-2">
					<div className="mb-2 font-medium">Plan Exact Install</div>
					<div className="grid grid-cols-2 gap-2">
						<Input aria-label="Package name" value={packageName} onChange={(event) => setPackageName(event.currentTarget.value)} placeholder="package-name" />
						<Input
							aria-label="Exact package version"
							value={packageVersion}
							onChange={(event) => setPackageVersion(event.currentTarget.value)}
							placeholder="exact semver for registry"
						/>
						<select
							aria-label="Package source type"
							className="h-8 rounded bg-input px-2"
							value={packageSourceType}
							onChange={(event) => setPackageSourceType(event.currentTarget.value as PackageSourceType)}
						>
							<option value="registry">Registry</option>
							<option value="git">Git URL</option>
							<option value="local">Local directory</option>
							<option value="tarball">Tarball path/URL</option>
						</select>
						<select
							aria-label="Package dependency type"
							className="h-8 rounded bg-input px-2"
							value={dependencyType}
							onChange={(event) => setDependencyType(event.currentTarget.value as PackageDependencyType)}
						>
							{dependencyTypes.map((type) => (
								<option key={type} value={type}>
									{type}
								</option>
							))}
						</select>
						{packageSourceType !== "registry" && (
							<Input
								aria-label="Package source"
								value={packageSource}
								onChange={(event) => setPackageSource(event.currentTarget.value)}
								placeholder="contained path or credential-free URL"
							/>
						)}
						{packageSourceType === "git" && (
							<Input
								aria-label="Git package commit"
								value={packageSourceCommit}
								onChange={(event) => setPackageSourceCommit(event.currentTarget.value)}
								placeholder="commit/tag (optional)"
							/>
						)}
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-3">
						<label className="flex items-center gap-2">
							<Checkbox checked={allowScripts} onCheckedChange={(checked) => setAllowScripts(checked === true)} />
							Allow lifecycle scripts
						</label>
						{manager?.capabilities.workspaceRootOptIn && (
							<label className="flex items-center gap-2">
								<Checkbox checked={allowWorkspaceRoot} onCheckedChange={(checked) => setAllowWorkspaceRoot(checked === true)} />
								Allow workspace lockfile mutation
							</label>
						)}
						<Button size="sm" disabled={busy || !packageName.trim()} onClick={() => void run(planInstall)}>
							Plan Install
						</Button>
					</div>
				</div>

				<div className="rounded border border-border p-2">
					<div className="mb-2 flex items-center gap-2">
						<Input
							aria-label="Installed package filter"
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							placeholder="Filter direct dependencies"
						/>
						<Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(refreshCore)}>
							Filter
						</Button>
					</div>
					{packages?.directDependencies.map((dependency) => (
						<div
							key={`${dependency.dependencyType}:${dependency.name}`}
							className="mb-1 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded bg-input p-2"
						>
							<div className="min-w-0">
								<div className="truncate font-medium">{dependency.name}</div>
								<div className="truncate text-muted-foreground">
									{dependency.specification} · {dependency.dependencyType}
								</div>
							</div>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									setTab("updates");
									void run(refreshUpdates);
								}}
							>
								Check Update
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="!text-red-400"
								disabled={busy}
								onClick={() => void run(() => createPackagePlan([{ operation: "remove", name: dependency.name, dependencyType: dependency.dependencyType }]))}
							>
								Plan Remove
							</Button>
						</div>
					))}
					{packages && (
						<div className="text-muted-foreground">
							Showing {packages.directDependencies.length} of {packages.total} direct package(s).
						</div>
					)}
				</div>
			</div>
		);
	}

	function renderUpdates(): JSX.Element {
		return (
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap gap-2">
					<Button size="sm" disabled={busy} onClick={() => void run(refreshUpdates)}>
						Check Registries
					</Button>
					<Button size="sm" variant="secondary" disabled={busy || !updates?.availableCount} onClick={() => void run(() => planBulkUpdates("wanted"))}>
						Plan All Wanted
					</Button>
					<Button size="sm" variant="secondary" disabled={busy || !updates?.availableCount} onClick={() => void run(() => planBulkUpdates("latest"))}>
						Plan All Latest
					</Button>
				</div>
				{updates?.updates.map((update) => (
					<div key={update.name} className="rounded bg-input p-2">
						<div className="font-medium">{update.name}</div>
						<div className="text-muted-foreground">
							requested {update.requested} · current {update.current ?? "missing"} · wanted {update.wanted ?? "n/a"} · latest {update.latest ?? "n/a"}
						</div>
						{update.error ? (
							<div className="text-red-400">{update.error}</div>
						) : (
							<div className="mt-1 flex gap-1">
								<Button
									size="sm"
									variant="ghost"
									disabled={!update.wanted || !update.wantedUpdateAvailable}
									onClick={() =>
										void run(() =>
											createPackagePlan([
												{
													operation: "update",
													name: update.name,
													version: update.wanted,
													dependencyType: update.dependencyType,
													source: { type: "registry" },
												},
											])
										)
									}
								>
									Plan Wanted
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={!update.latest || !update.latestUpdateAvailable}
									onClick={() =>
										void run(() =>
											createPackagePlan([
												{
													operation: "update",
													name: update.name,
													version: update.latest,
													dependencyType: update.dependencyType,
													source: { type: "registry" },
												},
											])
										)
									}
								>
									Plan Latest
								</Button>
							</div>
						)}
					</div>
				))}
				{!updates && <div className="text-muted-foreground">Update checks contact configured registries only when requested.</div>}
			</div>
		);
	}

	function renderDependencies(): JSX.Element {
		return (
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<Input
						aria-label="Dependency graph filter"
						value={dependencyQuery}
						onChange={(event) => setDependencyQuery(event.currentTarget.value)}
						placeholder="Filter graph nodes"
					/>
					<label className="flex shrink-0 items-center gap-2">
						<Checkbox checked={directOnly} onCheckedChange={(checked) => setDirectOnly(checked === true)} />
						Direct only
					</label>
					<Button size="sm" disabled={busy} onClick={() => void run(refreshDependencies)}>
						Refresh
					</Button>
				</div>
				<div className="rounded border border-border p-2 text-muted-foreground">
					Source: {graph?.format ?? "…"} · lock {shortHash(graph?.lockfile?.sha256)} · {graph?.total ?? 0} node(s) · {graph?.edges.length ?? 0} visible edge(s)
					{graph?.truncated ? " · truncated at safety limit" : ""}
				</div>
				{graph?.warnings.map((warning) => (
					<div key={warning} className="rounded bg-amber-950/40 p-2 text-amber-300">
						{warning}
					</div>
				))}
				{graph?.nodes.map((node) => (
					<div key={node.id} className="rounded bg-input p-2">
						<div className="flex justify-between gap-2">
							<span className="font-medium">{node.name}</span>
							<span>{node.version ?? "unresolved"}</span>
						</div>
						<div className="text-muted-foreground">
							{node.direct ? `direct · ${node.dependencyTypes.join(", ")}` : "transitive"} · {Object.keys(node.dependencies).length} child request(s)
						</div>
					</div>
				))}
			</div>
		);
	}

	function renderSamples(): JSX.Element {
		return (
			<div className="flex flex-col gap-2" data-testid="package-manager-samples-view">
				<div className="grid grid-cols-2 gap-2 lg:grid-cols-[minmax(0,1fr)_8rem_8rem_7rem_auto]">
					<Input
						aria-label="Package sample target"
						value={sampleTarget}
						onChange={(event) => setSampleTarget(event.currentTarget.value)}
						placeholder="assets/Samples/... (optional)"
					/>
					<select
						aria-label="Package sample collision policy"
						className="h-8 rounded bg-input px-2"
						value={sampleCollision}
						onChange={(event) => setSampleCollision(event.currentTarget.value as typeof sampleCollision)}
					>
						<option value="fail">Fail</option>
						<option value="rename">Rename</option>
						<option value="replace">Replace</option>
					</select>
					<select
						aria-label="Package sample sort field"
						className="h-8 rounded bg-input px-2"
						value={sampleSortBy}
						onChange={(event) => setSampleSortBy(event.currentTarget.value as typeof sampleSortBy)}
					>
						<option value="display-name">Sample Name</option>
						<option value="package-name">Package Name</option>
						<option value="publish-date">Publish Date</option>
					</select>
					<select
						aria-label="Package sample sort direction"
						className="h-8 rounded bg-input px-2"
						value={sampleSortDirection}
						onChange={(event) => setSampleSortDirection(event.currentTarget.value as typeof sampleSortDirection)}
					>
						<option value="asc">Ascending</option>
						<option value="desc">Descending</option>
					</select>
					<Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => refreshSamples())}>
						Refresh
					</Button>
				</div>
				{samples?.samples.map((sample) => (
					<div key={sample.id} className="flex items-start justify-between gap-2 rounded bg-input p-2">
						<div className="min-w-0">
							<div className="font-medium">{sample.displayName}</div>
							<div className="text-muted-foreground">
								{sample.packageName}@{sample.packageVersion} · {sample.fileCount} file(s) · {formatBytes(sample.totalBytes)} · {sample.imageCount} image(s)
							</div>
							<div className="line-clamp-2 text-muted-foreground">{sample.description ?? sample.sourcePath}</div>
							<div className="text-muted-foreground">
								Published {sample.publishedAt ? new Date(sample.publishedAt).toLocaleDateString() : "unknown"} ·{" "}
								{sample.defaultImportExists ? "imported" : "not imported"}
							</div>
						</div>
						<div className="flex shrink-0 flex-wrap gap-1">
							<Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => inspectSample(sample))}>
								Details
							</Button>
							<Button size="sm" variant="secondary" disabled={busy || !sample.defaultImportExists} onClick={() => void run(() => locateSample(sample))}>
								Locate
							</Button>
							<Button size="sm" disabled={busy} onClick={() => void run(() => createSamplePlan(sample))}>
								Plan Import
							</Button>
						</div>
					</div>
				))}
				{sampleDetails && (
					<div className="grid gap-2 md:grid-cols-2" data-testid="package-sample-detail-cards">
						{sampleDetails.cards.map((card: any) => (
							<div key={card.id} className="rounded border border-border p-2">
								<div className="font-medium">{String(card.title)}</div>
								{Object.entries(card.items).map(([key, value]) => (
									<div key={key} className="break-all text-muted-foreground">
										{key}: {String(value ?? "unknown")}
									</div>
								))}
							</div>
						))}
						{sampleDetails.images.map((image: any) => (
							<div key={image.sha256} className="rounded border border-border p-2">
								<img src={image.previewUrl} alt={image.alt ?? image.caption ?? image.path} className="mb-1 max-h-40 w-full rounded object-contain" />
								<div className="font-medium">{String(image.caption ?? image.path)}</div>
								<div className="text-muted-foreground">
									{String(image.format).toUpperCase()} · {String(image.width)}×{String(image.height)} · {formatBytes(image.bytes)} · {shortHash(image.sha256)}
								</div>
							</div>
						))}
					</div>
				)}
				{samples?.hasMore && samples.nextOffset !== null && (
					<Button
						data-testid="package-samples-view-more"
						size="sm"
						variant="secondary"
						disabled={busy}
						onClick={() => void run(() => refreshSamples(samples.nextOffset!, true))}
					>
						View More Samples
					</Button>
				)}
				{samples && !samples.samples.length && <div className="text-muted-foreground">No installed direct package declares Babylon/Zvibe samples.</div>}
				{samples?.errors.map((sampleError) => (
					<div key={sampleError.packageName} className="text-red-400">
						{sampleError.packageName}: {sampleError.error}
					</div>
				))}
			</div>
		);
	}

	function renderPlan(): JSX.Element | null {
		if (packagePlan) {
			return (
				<div className="rounded border border-amber-500/60 bg-amber-950/20 p-2">
					<div className="font-medium text-amber-300">Pending Package Plan · expires {new Date(packagePlan.expiresAt).toLocaleTimeString()}</div>
					{packagePlan.changes.map((change) => (
						<div key={`${change.operation}:${change.name}`} className="mt-1 rounded bg-black/20 p-1 font-mono">
							{change.command}
						</div>
					))}
					<div className="mt-1 text-muted-foreground">
						File rollback: {packagePlan.rollback.packageJsonAndLockfiles}. node_modules: {packagePlan.rollback.nodeModules}
					</div>
					<div className="mt-2 flex gap-2">
						<Button size="sm" disabled={busy} onClick={() => void run(applyPackagePlan)}>
							Apply Confirmed Plan
						</Button>
						<Button size="sm" variant="secondary" disabled={busy} onClick={() => setPackagePlan(null)}>
							Discard
						</Button>
					</div>
				</div>
			);
		}
		if (registryPlan) {
			return (
				<div className="rounded border border-amber-500/60 bg-amber-950/20 p-2">
					<div className="font-medium text-amber-300">
						Pending Registry Plan · {registryPlan.action} {registryPlan.scope ?? "default"}
					</div>
					<div className="text-muted-foreground">
						URL {registryPlan.url ?? "removed"} · result {shortHash(registryPlan.resultSha256)} · {registryPlan.changed ? "changes .npmrc" : "no byte change"}
					</div>
					<div className="mt-2 flex gap-2">
						<Button size="sm" disabled={busy || !registryPlan.changed} onClick={() => void run(applyRegistryPlan)}>
							Apply Confirmed Plan
						</Button>
						<Button size="sm" variant="secondary" onClick={() => setRegistryPlan(null)}>
							Discard
						</Button>
					</div>
				</div>
			);
		}
		if (samplePlan) {
			return (
				<div className="rounded border border-amber-500/60 bg-amber-950/20 p-2">
					<div className="font-medium text-amber-300">Pending Sample Import · {samplePlan.sample.displayName}</div>
					<div className="text-muted-foreground">
						Target {samplePlan.targetPath} · collision {samplePlan.collision} · source {shortHash(samplePlan.sample.sourceSha256)}
					</div>
					<div className="mt-2 flex gap-2">
						<Button size="sm" disabled={busy} onClick={() => void run(applySamplePlan)}>
							Apply Confirmed Import
						</Button>
						<Button size="sm" variant="secondary" onClick={() => setSamplePlan(null)}>
							Discard
						</Button>
					</div>
				</div>
			);
		}
		return null;
	}

	return (
		<EditorInspectorSectionField
			title="Package Manager"
			tooltip="Unity-style Registry, Installed, Updates, Dependencies, and Samples workflows with npm/Yarn/pnpm/Bun detection, exact expiring plans, bounded non-shell execution, credential redaction, postconditions, and rollback evidence."
		>
			<div className="flex flex-col gap-3 text-xs">
				<div className="flex items-center justify-between rounded bg-input p-2">
					<div>
						<div className="font-medium">
							{packages?.name ?? "Project"} · {manager?.packageManager ?? "…"} {manager?.version ?? ""}
						</div>
						<div className="text-muted-foreground">
							{manager?.available === false ? "manager unavailable" : "manager available"} · state {shortHash(packages?.fingerprint)}
							{manager?.workspace ? ` · workspace ${manager.workspace.relativePath ?? "."}` : ""}
						</div>
					</div>
					<div className="flex gap-1">
						{manager?.active && (
							<Button
								size="sm"
								variant="secondary"
								className="!text-red-400"
								onClick={() =>
									void cancelProjectPackageOperation(props.scene, { operationId: manager.active?.id }).then(() =>
										setStatus("Cancellation requested for the active package operation.")
									)
								}
							>
								Cancel
							</Button>
						)}
						<Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(refreshCore)}>
							Refresh
						</Button>
					</div>
				</div>

				<div className="flex flex-wrap gap-1">
					{tabs.map((candidate) => (
						<Button key={candidate.id} size="sm" variant={tab === candidate.id ? "default" : "secondary"} className="h-7 px-2" onClick={() => setTab(candidate.id)}>
							{candidate.label}
						</Button>
					))}
				</div>

				{tab === "registry" && renderRegistry()}
				{tab === "installed" && renderInstalled()}
				{tab === "updates" && renderUpdates()}
				{tab === "dependencies" && renderDependencies()}
				{tab === "samples" && renderSamples()}
				{renderPlan()}
				{busy && <div className="text-muted-foreground">Package Manager operation in progress…</div>}
				{status && <div className="rounded bg-emerald-950/30 p-2 text-emerald-300">{status}</div>}
				{error && <div className="rounded bg-red-950/30 p-2 text-red-400">{error}</div>}
			</div>
		</EditorInspectorSectionField>
	);
}
