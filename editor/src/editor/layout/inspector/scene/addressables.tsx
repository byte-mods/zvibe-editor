import { useEffect, useMemo, useState } from "react";

import { Scene } from "babylonjs";

import { IAddressableDeploymentTarget, IAddressableProfile, IAddressableProjectConfiguration } from "babylonjs-editor-tools";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Checkbox } from "../../../../ui/shadcn/ui/checkbox";
import { Input } from "../../../../ui/shadcn/ui/input";

import {
	analyzeAddressableTypeTrees,
	assignAddressableAsset,
	buildAddressableContentAction,
	checkAddressableCatalogUpdates,
	clearAddressableCache,
	createAddressableGroup,
	createAddressableProfile,
	deleteAddressableDeploymentTarget,
	deleteAddressableGroup,
	deleteAddressableProfile,
	deployAddressableContentAction,
	downloadAddressableDependencies,
	getAddressableRuntimeStatus,
	listAddressableBuildReports,
	listAddressableDeploymentReceiptsAction,
	listAddressableGroups,
	reloadAddressableRuntime,
	setAddressableDeploymentTarget,
	setAddressableGroup,
	setAddressableProfile,
	setAddressableSettings,
	updateAddressableCatalog,
	verifyAddressableDeploymentAction,
} from "../../../../mcp/addressables/addressables";

import { Editor } from "../../../main";
import { EditorInspectorSectionField } from "../fields/section";

interface IAddressablesInspectorProps {
	scene: Scene;
	editor: Editor;
}

interface IAddressableReportSummary {
	buildId: string;
	catalogHash: string;
	buildType: "full" | "update";
	reportPath: string;
	statePath?: string;
	assetCount: number;
	emittedContentBytes: number;
	staticRedirectCount: number;
	typeTreeSchemaCount: number;
	portableBundleCount: number;
	typeTreeSavedBytes: number;
}

interface IAddressableTypeTreeAnalysis {
	analysisMode: "authored-settings" | "what-if-enabled";
	summary?: {
		schemaCount: number;
		bundleCount: number;
		structuredAssetCount: number;
		savedBytes: number;
	};
}

const defaultProfileDraft: IAddressableProfile = {
	id: "",
	name: "Production",
	localBuildPath: "AddressableBuilds/{profile}/local",
	localLoadPath: "./",
	remoteBuildPath: "AddressableBuilds/{profile}/remote",
	remoteLoadPath: "http://127.0.0.1:8080/addressables",
};

function formatBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KiB`;
	}
	return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function AddressablesInspector(props: IAddressablesInspectorProps) {
	const [configuration, setConfiguration] = useState<IAddressableProjectConfiguration | null>(null);
	const [profileDraft, setProfileDraft] = useState<IAddressableProfile>(defaultProfileDraft);
	const [groupName, setGroupName] = useState("Content");
	const [groupId, setGroupId] = useState("");
	const [groupDelivery, setGroupDelivery] = useState<"local" | "remote">("local");
	const [groupRestriction, setGroupRestriction] = useState<"static" | "dynamic">("static");
	const [groupBundleMode, setGroupBundleMode] = useState<"pack-together" | "pack-separately">("pack-separately");
	const [groupBuildPath, setGroupBuildPath] = useState("");
	const [groupLoadPath, setGroupLoadPath] = useState("");
	const [assetPath, setAssetPath] = useState("");
	const [assetAddress, setAssetAddress] = useState("");
	const [assetLabels, setAssetLabels] = useState("");
	const [buildType, setBuildType] = useState<"full" | "update">("full");
	const [outputPath, setOutputPath] = useState("AddressableBuilds/Production/latest");
	const [previousStatePath, setPreviousStatePath] = useState("");
	const [reports, setReports] = useState<IAddressableReportSummary[]>([]);
	const [selectedReportPath, setSelectedReportPath] = useState("");
	const [lastReport, setLastReport] = useState<IAddressableReportSummary | null>(null);
	const [targetProvider, setTargetProvider] = useState<"filesystem" | "http" | "s3">("filesystem");
	const [targetId, setTargetId] = useState("local-cdn");
	const [targetName, setTargetName] = useState("Local CDN");
	const [targetDestination, setTargetDestination] = useState("AddressableDeployments/local");
	const [targetBaseUrl, setTargetBaseUrl] = useState("http://127.0.0.1:8080/addressables");
	const [targetBucket, setTargetBucket] = useState("babylonjs-editor");
	const [targetRegion, setTargetRegion] = useState("us-east-1");
	const [targetEndpoint, setTargetEndpoint] = useState("");
	const [targetKeyPrefix, setTargetKeyPrefix] = useState("addressables");
	const [targetAccessEnvironment, setTargetAccessEnvironment] = useState("AWS_ACCESS_KEY_ID");
	const [targetSecretEnvironment, setTargetSecretEnvironment] = useState("AWS_SECRET_ACCESS_KEY");
	const [targetSessionEnvironment, setTargetSessionEnvironment] = useState("");
	const [targetAuthorizationEnvironment, setTargetAuthorizationEnvironment] = useState("");
	const [publishConfirmation, setPublishConfirmation] = useState("");
	const [runtimeStatus, setRuntimeStatus] = useState<Record<string, unknown> | null>(null);
	const [typeTreeAnalysis, setTypeTreeAnalysis] = useState<IAddressableTypeTreeAnalysis | null>(null);
	const [deploymentStatus, setDeploymentStatus] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const selectedGroup = useMemo(() => (groupId ? configuration?.groups.find((group) => group.id === groupId) : undefined), [configuration, groupId]);
	const selectedReport = useMemo(() => reports.find((report) => report.reportPath === selectedReportPath) ?? lastReport ?? reports[0], [reports, selectedReportPath, lastReport]);

	function loadTargetDraft(target?: IAddressableDeploymentTarget): void {
		if (!target) {
			setTargetId("");
			setTargetName("New CDN");
			setTargetProvider("filesystem");
			return;
		}
		setTargetId(target.id);
		setTargetName(target.name);
		setTargetProvider(target.provider);
		setTargetBaseUrl(target.publicBaseUrl);
		if (target.provider === "filesystem") {
			setTargetDestination(target.destinationPath);
		} else if (target.provider === "http") {
			setTargetDestination(target.baseUrl);
			setTargetAuthorizationEnvironment(target.authorizationEnvironment ?? "");
		} else {
			setTargetBucket(target.bucket);
			setTargetRegion(target.region);
			setTargetEndpoint(target.endpoint ?? "");
			setTargetKeyPrefix(target.keyPrefix);
			setTargetAccessEnvironment(target.accessKeyIdEnvironment);
			setTargetSecretEnvironment(target.secretAccessKeyEnvironment);
			setTargetSessionEnvironment(target.sessionTokenEnvironment ?? "");
		}
	}

	async function refresh(): Promise<void> {
		const [nextConfiguration, reportResult, receiptResult] = await Promise.all([
			listAddressableGroups(),
			listAddressableBuildReports(),
			listAddressableDeploymentReceiptsAction(),
		]);
		setConfiguration(nextConfiguration);
		setReports(reportResult.reports as IAddressableReportSummary[]);
		setDeploymentStatus(`${(receiptResult as { receipts: unknown[] }).receipts.length} verified deployment receipt(s)`);
		const activeProfile = nextConfiguration.profiles.find((candidate) => candidate.id === nextConfiguration.activeProfileId) ?? nextConfiguration.profiles[0];
		if (activeProfile) {
			setProfileDraft(activeProfile);
		}
		const nextGroup = nextConfiguration.groups.find((candidate) => candidate.id === groupId) ?? nextConfiguration.groups[0];
		if (nextGroup) {
			setGroupId(nextGroup.id);
			setGroupName(nextGroup.name);
			setGroupDelivery(nextGroup.delivery);
			setGroupRestriction(nextGroup.updateRestriction);
			setGroupBundleMode(nextGroup.bundleMode);
			setGroupBuildPath(nextGroup.buildPath ?? "");
			setGroupLoadPath(nextGroup.loadPath ?? "");
		}
		loadTargetDraft(
			nextConfiguration.deploymentTargets.find((candidate) => candidate.id === nextConfiguration.activeDeploymentTargetId) ?? nextConfiguration.deploymentTargets[0]
		);
		setError(null);
	}

	useEffect(() => {
		void refresh().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load Addressables."));
	}, []);

	async function run(action: () => Promise<void>): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Addressables operation failed.");
		} finally {
			setBusy(false);
		}
	}

	async function saveSettings(changes: Parameters<typeof setAddressableSettings>[1]): Promise<void> {
		if (!configuration) {
			return;
		}
		const result = await setAddressableSettings(props.scene, { ...changes, expectedRevision: configuration.revision }, { editor: props.editor });
		setConfiguration(result);
		const activeProfile = result.profiles.find((candidate) => candidate.id === result.activeProfileId);
		if (activeProfile) {
			setProfileDraft(activeProfile);
		}
	}

	async function createProfile(): Promise<void> {
		if (!configuration) {
			return;
		}
		const result = await createAddressableProfile(props.scene, { ...profileDraft, id: undefined, expectedRevision: configuration.revision }, { editor: props.editor });
		const created = result.profiles[result.profiles.length - 1];
		const activated = await setAddressableSettings(props.scene, { expectedRevision: result.revision, activeProfileId: created.id }, { editor: props.editor });
		setConfiguration(activated);
		setProfileDraft(created);
	}

	async function saveProfile(): Promise<void> {
		if (!configuration || !profileDraft.id) {
			return;
		}
		setConfiguration(await setAddressableProfile(props.scene, { ...profileDraft, expectedRevision: configuration.revision }, { editor: props.editor }));
	}

	async function deleteProfile(): Promise<void> {
		if (!configuration || !profileDraft.id) {
			return;
		}
		const result = await deleteAddressableProfile(props.scene, { id: profileDraft.id, expectedRevision: configuration.revision }, { editor: props.editor });
		setConfiguration(result);
		setProfileDraft(result.profiles.find((candidate) => candidate.id === result.activeProfileId) ?? result.profiles[0]);
	}

	async function createGroup(): Promise<void> {
		if (!configuration) {
			return;
		}
		const result = await createAddressableGroup(
			props.scene,
			{
				expectedRevision: configuration.revision,
				name: groupName.trim(),
				delivery: groupDelivery,
				updateRestriction: groupDelivery === "local" ? "static" : groupRestriction,
				bundleMode: groupBundleMode,
				buildPath: groupBuildPath.trim() || undefined,
				loadPath: groupLoadPath.trim() || undefined,
			},
			{ editor: props.editor }
		);
		setConfiguration(result);
		setGroupId(result.groups[result.groups.length - 1].id);
	}

	async function saveGroup(): Promise<void> {
		if (!configuration || !selectedGroup) {
			return;
		}
		setConfiguration(
			await setAddressableGroup(
				props.scene,
				{
					id: selectedGroup.id,
					expectedRevision: configuration.revision,
					name: groupName.trim(),
					delivery: groupDelivery,
					updateRestriction: groupDelivery === "local" ? "static" : groupRestriction,
					bundleMode: groupBundleMode,
					buildPath: groupBuildPath.trim() || undefined,
					loadPath: groupLoadPath.trim() || undefined,
					clearBuildPath: !groupBuildPath.trim(),
					clearLoadPath: !groupLoadPath.trim(),
				},
				{ editor: props.editor }
			)
		);
	}

	async function deleteGroup(): Promise<void> {
		if (!configuration || !selectedGroup) {
			return;
		}
		const result = await deleteAddressableGroup(props.scene, { id: selectedGroup.id, expectedRevision: configuration.revision }, { editor: props.editor });
		setConfiguration(result);
		setGroupId(result.groups[0]?.id ?? "");
	}

	async function assignAsset(): Promise<void> {
		if (!configuration || !selectedGroup) {
			return;
		}
		const result = await assignAddressableAsset(
			props.scene,
			{
				id: selectedGroup.id,
				expectedRevision: configuration.revision,
				assetPath: assetPath.trim(),
				address: assetAddress.trim() || undefined,
				labels: assetLabels
					.split(",")
					.map((label) => label.trim())
					.filter(Boolean),
			},
			{ editor: props.editor }
		);
		setConfiguration(result);
		setAssetPath("");
		setAssetAddress("");
		setAssetLabels("");
	}

	function makeTarget(): IAddressableDeploymentTarget {
		if (targetProvider === "filesystem") {
			return { id: targetId, name: targetName, provider: "filesystem", destinationPath: targetDestination, publicBaseUrl: targetBaseUrl };
		}
		if (targetProvider === "http") {
			return {
				id: targetId,
				name: targetName,
				provider: "http",
				baseUrl: targetDestination,
				publicBaseUrl: targetBaseUrl,
				authorizationEnvironment: targetAuthorizationEnvironment || undefined,
			};
		}
		return {
			id: targetId,
			name: targetName,
			provider: "s3",
			bucket: targetBucket,
			region: targetRegion,
			endpoint: targetEndpoint || undefined,
			keyPrefix: targetKeyPrefix,
			publicBaseUrl: targetBaseUrl,
			accessKeyIdEnvironment: targetAccessEnvironment,
			secretAccessKeyEnvironment: targetSecretEnvironment,
			sessionTokenEnvironment: targetSessionEnvironment || undefined,
		};
	}

	async function saveTarget(): Promise<void> {
		if (!configuration) {
			return;
		}
		const result = await setAddressableDeploymentTarget(
			props.scene,
			{ expectedRevision: configuration.revision, target: makeTarget(), makeActive: true },
			{ editor: props.editor }
		);
		setConfiguration(result);
		loadTargetDraft(result.deploymentTargets.find((candidate) => candidate.id === result.activeDeploymentTargetId));
	}

	async function deleteTarget(): Promise<void> {
		if (!configuration || !targetId) {
			return;
		}
		const result = await deleteAddressableDeploymentTarget(props.scene, { expectedRevision: configuration.revision, id: targetId }, { editor: props.editor });
		setConfiguration(result);
		loadTargetDraft(result.deploymentTargets.find((candidate) => candidate.id === result.activeDeploymentTargetId) ?? result.deploymentTargets[0]);
	}

	async function build(): Promise<void> {
		if (!configuration) {
			return;
		}
		const result = (await buildAddressableContentAction(
			props.scene,
			{
				expectedRevision: configuration.revision,
				buildType,
				outputPath: outputPath.trim() || undefined,
				previousStatePath: buildType === "update" ? previousStatePath.trim() : undefined,
			},
			{ editor: props.editor }
		)) as IAddressableReportSummary;
		setLastReport(result);
		setSelectedReportPath(result.reportPath);
		if (result.statePath) {
			setPreviousStatePath(result.statePath);
		}
		await refresh();
	}

	async function analyzeTypeTrees(): Promise<void> {
		setTypeTreeAnalysis((await analyzeAddressableTypeTrees(props.scene, { limit: 1 })) as IAddressableTypeTreeAnalysis);
	}

	async function deploy(): Promise<void> {
		if (!selectedReport || publishConfirmation !== "PUBLISH") {
			return;
		}
		const result = await deployAddressableContentAction(props.scene, {
			reportPath: selectedReport.reportPath,
			targetId,
			expectedCatalogHash: selectedReport.catalogHash,
			confirmPublish: true,
		});
		setDeploymentStatus(`Published ${(result as { buildId: string }).buildId}; pointer verified last.`);
		setPublishConfirmation("");
	}

	async function verifyDeployment(): Promise<void> {
		if (!selectedReport) {
			return;
		}
		const result = await verifyAddressableDeploymentAction(props.scene, {
			targetId,
			expectedBuildId: selectedReport.buildId,
			expectedCatalogHash: selectedReport.catalogHash,
		});
		setDeploymentStatus(`Verified ${(result as { pointerUrl: string }).pointerUrl}`);
	}

	async function reloadRuntime(): Promise<void> {
		if (!configuration) {
			return;
		}
		setRuntimeStatus((await reloadAddressableRuntime(props.scene, { expectedRevision: configuration.revision })) as Record<string, unknown>);
	}

	async function runtimeAction(action: () => Promise<object> | object): Promise<void> {
		await action();
		setRuntimeStatus(getAddressableRuntimeStatus(props.scene) as Record<string, unknown>);
	}

	return (
		<EditorInspectorSectionField
			title="Addressables"
			tooltip="Profiles, portable shared TypeTrees, bundle modes, local/remote groups, incremental builds, pointer-last deployment, reports, remote catalogs, and bounded runtime cache."
		>
			<div className="flex flex-col gap-3 text-xs">
				<div className="flex items-center justify-between rounded bg-input p-2">
					<span>
						Version {configuration?.version ?? "…"} · revision {configuration?.revision ?? "…"}
					</span>
					<Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(refresh)}>
						Refresh
					</Button>
				</div>

				<div className="rounded border border-border p-2">
					<div className="mb-2 font-medium">Profiles & Runtime Settings</div>
					<div className="grid grid-cols-2 gap-2">
						<select
							aria-label="Active Addressables profile"
							className="h-8 rounded bg-input px-2"
							value={configuration?.activeProfileId ?? ""}
							onChange={(event) => void run(() => saveSettings({ expectedRevision: configuration?.revision ?? 0, activeProfileId: event.currentTarget.value }))}
						>
							{configuration?.profiles.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.name}
								</option>
							))}
						</select>
						<Input
							aria-label="Addressables profile name"
							value={profileDraft.name}
							onChange={(event) => setProfileDraft({ ...profileDraft, name: event.currentTarget.value })}
						/>
						<Input
							aria-label="Local Addressables build path"
							value={profileDraft.localBuildPath}
							onChange={(event) => setProfileDraft({ ...profileDraft, localBuildPath: event.currentTarget.value })}
						/>
						<Input
							aria-label="Local Addressables load path"
							value={profileDraft.localLoadPath}
							onChange={(event) => setProfileDraft({ ...profileDraft, localLoadPath: event.currentTarget.value })}
						/>
						<Input
							aria-label="Remote Addressables build path"
							value={profileDraft.remoteBuildPath}
							onChange={(event) => setProfileDraft({ ...profileDraft, remoteBuildPath: event.currentTarget.value })}
						/>
						<Input
							aria-label="Remote Addressables load path"
							value={profileDraft.remoteLoadPath}
							onChange={(event) => setProfileDraft({ ...profileDraft, remoteLoadPath: event.currentTarget.value })}
						/>
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<Button size="sm" disabled={busy || !profileDraft.name.trim()} onClick={() => void run(createProfile)}>
							Create Profile
						</Button>
						<Button size="sm" variant="secondary" disabled={busy || !profileDraft.id} onClick={() => void run(saveProfile)}>
							Save Active Profile
						</Button>
						<Button size="sm" variant="destructive" disabled={busy || !profileDraft.id || configuration?.profiles.length === 1} onClick={() => void run(deleteProfile)}>
							Delete Profile
						</Button>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={configuration?.settings.remoteCatalog ?? false}
								onCheckedChange={(checked) => void run(() => saveSettings({ expectedRevision: configuration?.revision ?? 0, remoteCatalog: Boolean(checked) }))}
							/>
							Remote Catalog
						</label>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={configuration?.settings.verifyHashes ?? true}
								onCheckedChange={(checked) => void run(() => saveSettings({ expectedRevision: configuration?.revision ?? 0, verifyHashes: Boolean(checked) }))}
							/>
							Verify SHA-256
						</label>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={configuration?.settings.extractTypeTrees ?? false}
								onCheckedChange={(checked) => void run(() => saveSettings({ expectedRevision: configuration?.revision ?? 0, extractTypeTrees: Boolean(checked) }))}
							/>
							Extract Shared TypeTrees
						</label>
						<Button size="sm" variant="secondary" disabled={busy || !configuration} onClick={() => void run(analyzeTypeTrees)}>
							Analyze TypeTrees
						</Button>
					</div>
					{typeTreeAnalysis?.summary && (
						<div className="mt-2 text-muted-foreground">
							{typeTreeAnalysis.analysisMode === "what-if-enabled" ? "What-if extraction" : "Current extraction"}: {typeTreeAnalysis.summary.structuredAssetCount}{" "}
							structured assets · {typeTreeAnalysis.summary.schemaCount} shared schemas · {typeTreeAnalysis.summary.bundleCount} portable bundles ·{" "}
							{formatBytes(typeTreeAnalysis.summary.savedBytes)} saved
						</div>
					)}
				</div>

				<div className="rounded border border-border p-2">
					<div className="mb-2 font-medium">Groups & Addresses</div>
					<div className="grid grid-cols-3 gap-2">
						<select
							aria-label="Addressables group"
							className="h-8 rounded bg-input px-2"
							value={selectedGroup?.id ?? ""}
							onChange={(event) => {
								const next = configuration?.groups.find((candidate) => candidate.id === event.currentTarget.value);
								if (next) {
									setGroupId(next.id);
									setGroupName(next.name);
									setGroupDelivery(next.delivery);
									setGroupRestriction(next.updateRestriction);
									setGroupBundleMode(next.bundleMode);
									setGroupBuildPath(next.buildPath ?? "");
									setGroupLoadPath(next.loadPath ?? "");
								} else {
									setGroupId("");
								}
							}}
						>
							<option value="">New group</option>
							{configuration?.groups.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.name}
								</option>
							))}
						</select>
						<Input aria-label="Addressables group name" value={groupName} onChange={(event) => setGroupName(event.currentTarget.value)} />
						<select
							aria-label="Addressables group delivery"
							className="h-8 rounded bg-input px-2"
							value={groupDelivery}
							onChange={(event) => {
								const value = event.currentTarget.value as "local" | "remote";
								setGroupDelivery(value);
								if (value === "local") {
									setGroupRestriction("static");
								}
							}}
						>
							<option value="local">Local</option>
							<option value="remote">Remote</option>
						</select>
						<select
							aria-label="Addressables update restriction"
							className="h-8 rounded bg-input px-2"
							disabled={groupDelivery === "local"}
							value={groupDelivery === "local" ? "static" : groupRestriction}
							onChange={(event) => setGroupRestriction(event.currentTarget.value as "static" | "dynamic")}
						>
							<option value="static">Prevent Updates</option>
							<option value="dynamic">Can Change Post Release</option>
						</select>
						<select
							aria-label="Addressables bundle mode"
							className="h-8 rounded bg-input px-2"
							value={groupBundleMode}
							onChange={(event) => setGroupBundleMode(event.currentTarget.value as "pack-together" | "pack-separately")}
						>
							<option value="pack-separately">Pack Separately</option>
							<option value="pack-together">Pack Together</option>
						</select>
						<Input
							aria-label="Addressables group build path"
							placeholder="Profile default build path"
							value={groupBuildPath}
							onChange={(event) => setGroupBuildPath(event.currentTarget.value)}
						/>
						<Input
							aria-label="Addressables group load path"
							placeholder="Profile default load path"
							value={groupLoadPath}
							onChange={(event) => setGroupLoadPath(event.currentTarget.value)}
						/>
						<Button size="sm" disabled={busy || !groupName.trim()} onClick={() => void run(createGroup)}>
							Create Group
						</Button>
						<div className="flex gap-2">
							<Button size="sm" variant="secondary" disabled={!selectedGroup || busy} onClick={() => void run(saveGroup)}>
								Apply
							</Button>
							<Button size="sm" variant="destructive" disabled={!selectedGroup || busy} onClick={() => void run(deleteGroup)}>
								Delete
							</Button>
						</div>
					</div>
					<div className="mt-2 grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
						<Input aria-label="Addressable source path" placeholder="assets/hero.glb" value={assetPath} onChange={(event) => setAssetPath(event.currentTarget.value)} />
						<Input
							aria-label="Addressable runtime address"
							placeholder="characters/hero"
							value={assetAddress}
							onChange={(event) => setAssetAddress(event.currentTarget.value)}
						/>
						<Input
							aria-label="Addressable labels"
							placeholder="character, featured"
							value={assetLabels}
							onChange={(event) => setAssetLabels(event.currentTarget.value)}
						/>
						<Button size="sm" disabled={!selectedGroup || !assetPath.trim() || busy} onClick={() => void run(assignAsset)}>
							Assign
						</Button>
					</div>
					<div className="mt-2 max-h-32 overflow-auto text-muted-foreground">
						{selectedGroup?.assets.map((asset) => (
							<div key={asset.address}>
								{asset.address} ← {asset.path} {asset.labels.length ? `· ${asset.labels.join(", ")}` : ""}
							</div>
						))}
					</div>
				</div>

				<div className="rounded border border-border p-2">
					<div className="mb-2 font-medium">Content Builds & Reports</div>
					<div className="grid grid-cols-[8rem_1fr_1fr_auto] gap-2">
						<select
							aria-label="Addressables build type"
							className="h-8 rounded bg-input px-2"
							value={buildType}
							onChange={(event) => setBuildType(event.currentTarget.value as "full" | "update")}
						>
							<option value="full">Full Build</option>
							<option value="update">Update Previous</option>
						</select>
						<Input aria-label="Addressables build output" value={outputPath} onChange={(event) => setOutputPath(event.currentTarget.value)} />
						<Input
							aria-label="Previous Addressables content state"
							disabled={buildType === "full"}
							placeholder="...state.json"
							value={previousStatePath}
							onChange={(event) => setPreviousStatePath(event.currentTarget.value)}
						/>
						<Button size="sm" disabled={busy || !configuration || (buildType === "update" && !previousStatePath.trim())} onClick={() => void run(build)}>
							Build
						</Button>
					</div>
					<select
						aria-label="Addressables build report"
						className="mt-2 h-8 w-full rounded bg-input px-2"
						value={selectedReport?.reportPath ?? ""}
						onChange={(event) => setSelectedReportPath(event.currentTarget.value)}
					>
						<option value="">No build report</option>
						{reports.map((report) => (
							<option key={report.reportPath} value={report.reportPath}>
								{report.buildType} · {report.buildId} · {report.assetCount} assets
							</option>
						))}
					</select>
					{selectedReport && (
						<div className="mt-2 text-muted-foreground">
							{selectedReport.buildId} · {selectedReport.assetCount} assets · {formatBytes(selectedReport.emittedContentBytes)} emitted ·{" "}
							{selectedReport.staticRedirectCount} static redirects · {selectedReport.typeTreeSchemaCount ?? 0} shared schemas ·{" "}
							{selectedReport.portableBundleCount ?? 0} portable bundles · {formatBytes(selectedReport.typeTreeSavedBytes ?? 0)} saved
						</div>
					)}
				</div>

				<div className="rounded border border-border p-2">
					<div className="mb-2 font-medium">Remote Deployment</div>
					<div className="grid grid-cols-3 gap-2">
						<select
							aria-label="Addressables deployment target"
							className="h-8 rounded bg-input px-2"
							value={configuration?.deploymentTargets.some((candidate) => candidate.id === targetId) ? targetId : ""}
							onChange={(event) => loadTargetDraft(configuration?.deploymentTargets.find((candidate) => candidate.id === event.currentTarget.value))}
						>
							<option value="">New target</option>
							{configuration?.deploymentTargets.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.name}
								</option>
							))}
						</select>
						<select
							aria-label="Addressables deployment provider"
							className="h-8 rounded bg-input px-2"
							value={targetProvider}
							onChange={(event) => setTargetProvider(event.currentTarget.value as "filesystem" | "http" | "s3")}
						>
							<option value="filesystem">Filesystem</option>
							<option value="http">HTTP PUT</option>
							<option value="s3">S3-compatible</option>
						</select>
						<Input aria-label="Addressables deployment id" value={targetId} onChange={(event) => setTargetId(event.currentTarget.value)} />
						<Input aria-label="Addressables deployment name" value={targetName} onChange={(event) => setTargetName(event.currentTarget.value)} />
						<Input
							aria-label="Addressables upload destination"
							placeholder={targetProvider === "http" ? "https://upload.example" : "AddressableDeployments/local"}
							value={targetDestination}
							onChange={(event) => setTargetDestination(event.currentTarget.value)}
						/>
						<Input aria-label="Addressables public base URL" value={targetBaseUrl} onChange={(event) => setTargetBaseUrl(event.currentTarget.value)} />
						{targetProvider === "http" && (
							<Input
								aria-label="Addressables authorization environment"
								placeholder="CDN_TOKEN"
								value={targetAuthorizationEnvironment}
								onChange={(event) => setTargetAuthorizationEnvironment(event.currentTarget.value)}
							/>
						)}
						{targetProvider === "s3" && (
							<>
								<Input aria-label="Addressables S3 bucket" value={targetBucket} onChange={(event) => setTargetBucket(event.currentTarget.value)} />
								<Input aria-label="Addressables S3 region" value={targetRegion} onChange={(event) => setTargetRegion(event.currentTarget.value)} />
								<Input aria-label="Addressables S3 endpoint" value={targetEndpoint} onChange={(event) => setTargetEndpoint(event.currentTarget.value)} />
								<Input aria-label="Addressables S3 key prefix" value={targetKeyPrefix} onChange={(event) => setTargetKeyPrefix(event.currentTarget.value)} />
								<Input
									aria-label="Addressables S3 access-key environment"
									value={targetAccessEnvironment}
									onChange={(event) => setTargetAccessEnvironment(event.currentTarget.value)}
								/>
								<Input
									aria-label="Addressables S3 secret environment"
									value={targetSecretEnvironment}
									onChange={(event) => setTargetSecretEnvironment(event.currentTarget.value)}
								/>
								<Input
									aria-label="Addressables S3 session-token environment"
									placeholder="Optional"
									value={targetSessionEnvironment}
									onChange={(event) => setTargetSessionEnvironment(event.currentTarget.value)}
								/>
							</>
						)}
					</div>
					<div className="mt-2 flex flex-wrap gap-2">
						<Button size="sm" disabled={busy || !configuration} onClick={() => void run(saveTarget)}>
							Save & Activate Target
						</Button>
						<Button
							size="sm"
							variant="destructive"
							disabled={busy || !configuration?.deploymentTargets.some((candidate) => candidate.id === targetId)}
							onClick={() => void run(deleteTarget)}
						>
							Delete Target
						</Button>
						<Input
							className="w-28"
							aria-label="Addressables publish confirmation"
							placeholder="PUBLISH"
							value={publishConfirmation}
							onChange={(event) => setPublishConfirmation(event.currentTarget.value)}
						/>
						<Button
							size="sm"
							disabled={
								busy || !selectedReport || !configuration?.deploymentTargets.some((candidate) => candidate.id === targetId) || publishConfirmation !== "PUBLISH"
							}
							onClick={() => void run(deploy)}
						>
							Publish Pointer Last
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={busy || !selectedReport || !configuration?.deploymentTargets.some((candidate) => candidate.id === targetId)}
							onClick={() => void run(verifyDeployment)}
						>
							Verify
						</Button>
					</div>
					<div className="mt-2 text-muted-foreground">{deploymentStatus}</div>
				</div>

				<div className="rounded border border-border p-2">
					<div className="mb-2 font-medium">Runtime Catalog & Cache</div>
					<div className="flex flex-wrap gap-2">
						<Button size="sm" onClick={() => void run(reloadRuntime)}>
							Reload
						</Button>
						<Button size="sm" variant="secondary" onClick={() => void run(() => runtimeAction(() => checkAddressableCatalogUpdates(props.scene)))}>
							Check Update
						</Button>
						<Button size="sm" variant="secondary" onClick={() => void run(() => runtimeAction(() => updateAddressableCatalog(props.scene)))}>
							Apply Update
						</Button>
						<Button size="sm" variant="secondary" onClick={() => void run(() => runtimeAction(() => downloadAddressableDependencies(props.scene, {})))}>
							Download All
						</Button>
						<Button size="sm" variant="destructive" onClick={() => void run(() => runtimeAction(() => clearAddressableCache(props.scene, {})))}>
							Clear Cache
						</Button>
					</div>
					{runtimeStatus && (
						<pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">{JSON.stringify(runtimeStatus, null, 2)}</pre>
					)}
				</div>

				{error && <div className="rounded bg-red-950/40 p-2 text-red-300">{error}</div>}
			</div>
		</EditorInspectorSectionField>
	);
}
