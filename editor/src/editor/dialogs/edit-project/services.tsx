import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ProjectServiceCategory, projectServiceCategories } from "babylonjs-editor-tools";

import { Badge } from "../../../ui/shadcn/ui/badge";
import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { Label } from "../../../ui/shadcn/ui/label";
import { Textarea } from "../../../ui/shadcn/ui/textarea";
import { Editor } from "../../main";
import {
	deleteProjectServiceEnvironment,
	getProjectServicesConfiguration,
	setActiveProjectServiceEnvironment,
	setProjectServiceCategory,
	setProjectServiceEnvironment,
	setProjectServiceResources,
	validateProjectServicesReadiness,
} from "../../../mcp/project/services/configuration";
import { deployProjectServices, listProjectServicesDeploymentReports, planProjectServicesDeployment } from "../../../mcp/project/services/deployment";
import {
	getProjectServicesEmulatorEvents,
	getProjectServicesEmulatorStatus,
	resetProjectServicesEmulator,
	startProjectServicesEmulator,
	stopProjectServicesEmulator,
} from "../../../mcp/project/services/emulator";
import { IProjectServicesControlConfiguration } from "../../../mcp/project/services/types";

const serviceLabels: Record<ProjectServiceCategory, string> = {
	auth: "Authentication",
	cloudSave: "Cloud Save",
	analytics: "Analytics",
	iap: "In-App Purchases",
	ads: "Ads",
	matchmaking: "Matchmaking",
	leaderboards: "Leaderboards",
	remoteConfig: "Remote Config",
	contentDelivery: "Cloud Content Delivery",
	cloudFunctions: "Cloud Functions",
};

export interface IEditorProjectServicesSettingsProps {
	editor: Editor;
}

/** Project Settings dashboard backed by the exact same actions published through MCP. */
export function EditorProjectServicesSettings(props: IEditorProjectServicesSettingsProps): JSX.Element {
	const [configuration, setConfiguration] = useState<IProjectServicesControlConfiguration | null>(null);
	const [selectedEnvironmentId, setSelectedEnvironmentId] = useState("");
	const [resourcesText, setResourcesText] = useState("");
	const [newEnvironmentId, setNewEnvironmentId] = useState("");
	const [newEnvironmentName, setNewEnvironmentName] = useState("");
	const [readiness, setReadiness] = useState<any>(null);
	const [emulator, setEmulator] = useState<any>({ running: false });
	const [emulatorEvents, setEmulatorEvents] = useState<any[]>([]);
	const [deploymentPlan, setDeploymentPlan] = useState<any>(null);
	const [reports, setReports] = useState<any[]>([]);
	const [dryRun, setDryRun] = useState(true);
	const [reconcile, setReconcile] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmation, setConfirmation] = useState<{ message: string; action: () => Promise<void> } | null>(null);
	const [sceneProbe, setSceneProbe] = useState(0);

	const scene = props.editor.layout.preview?.scene;
	const projectPath = props.editor.state.projectPath;
	const selectedEnvironment = configuration?.environments.find((environment) => environment.id === selectedEnvironmentId) ?? configuration?.environments[0] ?? null;

	function acceptConfiguration(next: IProjectServicesControlConfiguration): void {
		setConfiguration(next);
		setSelectedEnvironmentId((current) => (next.environments.some((environment) => environment.id === current) ? current : next.activeEnvironmentId));
		setDeploymentPlan(null);
		props.editor.layout.inspector?.forceUpdate?.();
	}

	async function refresh(): Promise<void> {
		if (!scene) {
			return;
		}
		const next = getProjectServicesConfiguration(scene, {});
		const environmentId = next.environments.some((environment) => environment.id === selectedEnvironmentId) ? selectedEnvironmentId : next.activeEnvironmentId;
		setConfiguration(next);
		setSelectedEnvironmentId(environmentId);
		setEmulator(getProjectServicesEmulatorStatus(scene));
		setReports(listProjectServicesDeploymentReports(scene));
		setReadiness(await validateProjectServicesReadiness(scene, { environmentId }, { editor: props.editor }));
	}

	async function run(operation: () => Promise<void>): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await operation();
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : "Project services operation failed.";
			setError(message);
			toast.error(message);
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		if (projectPath && scene) {
			void run(refresh);
		}
	}, [projectPath, scene]);

	useEffect(() => {
		if (scene && projectPath) {
			return;
		}
		const timeout = window.setTimeout(() => setSceneProbe((value) => value + 1), 50);
		return () => window.clearTimeout(timeout);
	}, [projectPath, scene, sceneProbe]);

	useEffect(() => {
		if (selectedEnvironment && scene) {
			setResourcesText(JSON.stringify(selectedEnvironment.resources, null, 2));
			void run(async () => setReadiness(await validateProjectServicesReadiness(scene, { environmentId: selectedEnvironment.id }, { editor: props.editor })));
		}
	}, [selectedEnvironmentId, configuration?.revision]);

	if (!scene || !projectPath) {
		return <div className="py-8 text-center text-sm text-muted-foreground">Waiting for the project and scene preview…</div>;
	}

	if (!configuration || !selectedEnvironment) {
		return <div className="py-8 text-center text-sm text-muted-foreground">{error ?? "Loading project services…"}</div>;
	}

	async function setCategory(category: ProjectServiceCategory, settings: any): Promise<void> {
		acceptConfiguration(setProjectServiceCategory(scene, { expectedRevision: configuration!.revision, environmentId: selectedEnvironment!.id, category, settings }));
	}

	return (
		<div className="mt-3 flex flex-col gap-4" data-project-services-workspace data-project-services-state={busy ? "busy" : error ? "error" : "ready"}>
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="text-lg font-medium">Project Services</div>
					<p className="text-xs text-muted-foreground">
						Provider-neutral environments, resources, local testing, and review-first deployment. Secrets stay in named environment variables and are never saved in the
						project.
					</p>
				</div>
				<Button data-project-services-refresh size="sm" variant="secondary" disabled={busy} onClick={() => void run(refresh)}>
					Refresh
				</Button>
			</div>
			{error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
			{confirmation && (
				<div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-xs">
					<div>{confirmation.message}</div>
					<div className="mt-2 flex gap-2">
						<Button
							data-project-services-confirm
							size="sm"
							variant="destructive"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									await confirmation.action();
									setConfirmation(null);
								})
							}
						>
							Confirm
						</Button>
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>
							Cancel
						</Button>
					</div>
				</div>
			)}

			<div className="rounded border border-border p-3">
				<div className="mb-2 flex items-center gap-2">
					<Label htmlFor="service-environment">Environment</Label>
					<Badge variant="outline">revision {configuration.revision}</Badge>
					{selectedEnvironment.id === configuration.activeEnvironmentId && <Badge>Runtime active</Badge>}
				</div>
				<div className="grid grid-cols-[1fr_auto_auto] gap-2">
					<select
						id="service-environment"
						className="h-9 rounded-md border border-input bg-background px-2 text-sm"
						value={selectedEnvironment.id}
						onChange={(event) => setSelectedEnvironmentId(event.target.value)}
					>
						{configuration.environments.map((environment) => (
							<option key={environment.id} value={environment.id}>
								{environment.name} ({environment.kind})
							</option>
						))}
					</select>
					<Button
						variant="secondary"
						disabled={busy || selectedEnvironment.id === configuration.activeEnvironmentId}
						onClick={() =>
							void run(async () =>
								acceptConfiguration(setActiveProjectServiceEnvironment(scene, { expectedRevision: configuration.revision, id: selectedEnvironment.id }))
							)
						}
					>
						Use at runtime
					</Button>
					<Button
						variant="destructive"
						disabled={busy || selectedEnvironment.id === configuration.activeEnvironmentId || configuration.environments.length === 1}
						onClick={() =>
							setConfirmation({
								message: `Delete local service environment ${selectedEnvironment.name}? This does not delete provider resources.`,
								action: async () =>
									acceptConfiguration(
										deleteProjectServiceEnvironment(scene, { expectedRevision: configuration.revision, id: selectedEnvironment.id, confirm: true })
									),
							})
						}
					>
						Delete
					</Button>
				</div>
				<div className="mt-2 grid grid-cols-[1fr_1fr_auto] gap-2">
					<Input placeholder="new-environment" value={newEnvironmentId} onChange={(event) => setNewEnvironmentId(event.target.value)} />
					<Input placeholder="Environment name" value={newEnvironmentName} onChange={(event) => setNewEnvironmentName(event.target.value)} />
					<Button
						variant="outline"
						disabled={busy || !newEnvironmentId || !newEnvironmentName}
						onClick={() =>
							void run(async () => {
								const next = setProjectServiceEnvironment(scene, {
									expectedRevision: configuration.revision,
									id: newEnvironmentId,
									name: newEnvironmentName,
									kind: "development",
								});
								acceptConfiguration(next);
								setSelectedEnvironmentId(newEnvironmentId);
								setNewEnvironmentId("");
								setNewEnvironmentName("");
							})
						}
					>
						Add
					</Button>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-3">
				{projectServiceCategories.map((category) => {
					const settings = selectedEnvironment.services[category];
					return (
						<div
							key={`${selectedEnvironment.id}-${configuration.revision}-${category}`}
							className="rounded border border-border p-3"
							data-project-services-category={category}
						>
							<div className="mb-2 flex items-center justify-between gap-2">
								<div className="font-medium">{serviceLabels[category]}</div>
								<label className="flex items-center gap-2 text-xs">
									<input
										type="checkbox"
										checked={settings.enabled}
										disabled={busy}
										onChange={(event) => void run(async () => setCategory(category, { ...settings, enabled: event.target.checked }))}
									/>
									Enabled
								</label>
							</div>
							<div className="space-y-2">
								<Input
									aria-label={`${serviceLabels[category]} provider`}
									defaultValue={settings.provider}
									placeholder="local, rest, firebase, playfab…"
									onBlur={(event) =>
										settings.provider !== event.target.value && void run(async () => setCategory(category, { ...settings, provider: event.target.value }))
									}
								/>
								<Input
									aria-label={`${serviceLabels[category]} endpoint`}
									defaultValue={settings.endpoint}
									placeholder="https://service.example or loopback HTTP"
									onBlur={(event) =>
										settings.endpoint !== event.target.value && void run(async () => setCategory(category, { ...settings, endpoint: event.target.value }))
									}
								/>
								<Input
									aria-label={`${serviceLabels[category]} options`}
									defaultValue={JSON.stringify(settings.options)}
									placeholder='{"projectId":"public-id"}'
									onBlur={(event) =>
										JSON.stringify(settings.options) !== event.target.value &&
										void run(async () => setCategory(category, { ...settings, options: JSON.parse(event.target.value) }))
									}
								/>
							</div>
						</div>
					);
				})}
			</div>

			<div className="rounded border border-border p-3">
				<div className="mb-2 flex items-center justify-between">
					<div>
						<div className="font-medium">Resource catalogs</div>
						<div className="text-xs text-muted-foreground">
							Analytics schemas, IAP products, ads, matchmaking queues, Leaderboards, Remote Config, content buckets/releases/badges, and Cloud Functions.
						</div>
					</div>
					<Button
						data-project-services-apply-resources
						size="sm"
						disabled={busy}
						onClick={() =>
							void run(async () =>
								acceptConfiguration(
									setProjectServiceResources(scene, {
										expectedRevision: configuration.revision,
										environmentId: selectedEnvironment.id,
										resources: JSON.parse(resourcesText),
									})
								)
							)
						}
					>
						Apply catalogs
					</Button>
				</div>
				<Textarea
					data-project-services-resources-json
					className="min-h-56 font-mono text-xs"
					value={resourcesText}
					onChange={(event) => setResourcesText(event.target.value)}
					spellCheck={false}
				/>
			</div>

			<div className="grid grid-cols-2 gap-3">
				<div className="rounded border border-border p-3">
					<div className="mb-2 flex items-center justify-between">
						<div className="font-medium">Local services emulator</div>
						<Badge variant={emulator.running ? "default" : "secondary"}>{emulator.running ? `127.0.0.1:${emulator.port}` : "Stopped"}</Badge>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							data-project-services-start-emulator
							size="sm"
							disabled={busy || emulator.running}
							onClick={() =>
								void run(async () =>
									setEmulator(
										await startProjectServicesEmulator(
											scene,
											{ expectedRevision: configuration.revision, environmentId: selectedEnvironment.id, port: 0 },
											{ editor: props.editor }
										)
									)
								)
							}
						>
							Start
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={busy || !emulator.running}
							onClick={() =>
								void run(async () => {
									await stopProjectServicesEmulator(scene);
									setEmulator({ running: false });
								})
							}
						>
							Stop
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={busy || !emulator.running}
							onClick={() =>
								void run(async () => {
									let next = configuration;
									for (const category of projectServiceCategories.filter((entry) => selectedEnvironment.services[entry].enabled)) {
										next = setProjectServiceCategory(scene, {
											expectedRevision: next.revision,
											environmentId: selectedEnvironment.id,
											category,
											settings: {
												...next.environments.find((entry) => entry.id === selectedEnvironment.id)!.services[category],
												provider: "local",
												endpoint: emulator.endpoint,
											},
										});
									}
									acceptConfiguration(next);
								})
							}
						>
							Route enabled services here
						</Button>
						<Button
							size="sm"
							variant="destructive"
							disabled={busy || !emulator.running}
							onClick={() =>
								setConfirmation({
									message:
										"Permanently reset all local emulator players, saves, events, purchases, ad impressions, tickets, leaderboard scores, function executions, and sessions?",
									action: async () => setEmulator((await resetProjectServicesEmulator(scene, { confirm: true })).status),
								})
							}
						>
							Reset data
						</Button>
					</div>
					{emulator.running && <div className="mt-2 break-all font-mono text-xs text-muted-foreground">{emulator.endpoint}</div>}
					{emulator.counts && (
						<div className="mt-2 text-xs text-muted-foreground">
							Players {emulator.counts.players} · Saves {emulator.counts.cloudSaveItems} · Analytics {emulator.counts.analyticsEvents} · Purchases{" "}
							{emulator.counts.purchases} · Tickets {emulator.counts.matchTickets}· Scores {emulator.counts.leaderboardScores ?? 0} · Functions{" "}
							{emulator.counts.functionExecutions ?? 0}
						</div>
					)}
					<Button
						className="mt-2"
						size="sm"
						variant="ghost"
						disabled={!emulator.running}
						onClick={() => setEmulatorEvents(getProjectServicesEmulatorEvents(scene, { limit: 20 }).events)}
					>
						Inspect latest events
					</Button>
					{emulatorEvents.slice(-5).map((event) => (
						<div key={event.sequence} className="mt-1 font-mono text-[10px] text-muted-foreground">
							#{event.sequence} {event.category}/{event.action} {event.playerId ?? "public"}
						</div>
					))}
				</div>

				<div className="rounded border border-border p-3">
					<div className="mb-2 flex items-center justify-between">
						<div className="font-medium">Readiness</div>
						<Badge variant={readiness?.readiness?.deployment ? "default" : "secondary"}>{readiness?.readiness?.deployment ? "Deployable" : "Needs setup"}</Badge>
					</div>
					{readiness?.findings?.length === 0 && <div className="text-xs text-emerald-500">No findings.</div>}
					{readiness?.findings?.map((finding: any, index: number) => (
						<div key={`${finding.code}-${index}`} className={finding.severity === "error" ? "mb-1 text-xs text-destructive" : "mb-1 text-xs text-muted-foreground"}>
							{finding.severity}: {finding.message}
						</div>
					))}
				</div>
			</div>

			<div className="rounded border border-border p-3">
				<div className="font-medium">Deployment</div>
				<div className="mt-2 grid grid-cols-2 gap-2">
					<Input
						key={`${selectedEnvironment.id}-${configuration.revision}-script`}
						defaultValue={selectedEnvironment.deployment.script}
						placeholder="services:deploy"
						onBlur={(event) =>
							selectedEnvironment.deployment.script !== event.target.value &&
							void run(async () =>
								acceptConfiguration(
									setProjectServiceEnvironment(scene, {
										expectedRevision: configuration.revision,
										id: selectedEnvironment.id,
										deployment: { ...selectedEnvironment.deployment, script: event.target.value },
									})
								)
							)
						}
					/>
					<Input
						key={`${selectedEnvironment.id}-${configuration.revision}-credentials`}
						defaultValue={selectedEnvironment.deployment.credentialEnvironmentVariables.join(",")}
						placeholder="SERVICE_TOKEN,SERVICE_PROJECT_ID"
						onBlur={(event) => {
							const variables = event.target.value
								.split(",")
								.map((entry) => entry.trim())
								.filter(Boolean);
							if (JSON.stringify(variables) === JSON.stringify(selectedEnvironment.deployment.credentialEnvironmentVariables)) {
								return;
							}
							void run(async () =>
								acceptConfiguration(
									setProjectServiceEnvironment(scene, {
										expectedRevision: configuration.revision,
										id: selectedEnvironment.id,
										deployment: { ...selectedEnvironment.deployment, credentialEnvironmentVariables: variables },
									})
								)
							);
						}}
					/>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
					<label className="flex items-center gap-1">
						<input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
						Dry run
					</label>
					<label className="flex items-center gap-1">
						<input type="checkbox" checked={reconcile} onChange={(event) => setReconcile(event.target.checked)} />
						Reconcile
					</label>
					<Button
						data-project-services-plan-deployment
						size="sm"
						variant="secondary"
						disabled={busy}
						onClick={() =>
							void run(async () =>
								setDeploymentPlan(
									await planProjectServicesDeployment(
										scene,
										{ expectedRevision: configuration.revision, environmentId: selectedEnvironment.id, dryRun, reconcile },
										{ editor: props.editor }
									)
								)
							)
						}
					>
						Plan
					</Button>
					<Button
						data-project-services-execute-deployment
						size="sm"
						disabled={busy || !deploymentPlan?.valid}
						onClick={() =>
							setConfirmation({
								message: `Execute the reviewed project script? ${deploymentPlan.command}`,
								action: async () => {
									const report = await deployProjectServices(
										scene,
										{ planId: deploymentPlan.id, expectedFingerprint: deploymentPlan.fingerprint, confirm: true },
										{ editor: props.editor }
									);
									toast[report.status === "succeeded" ? "success" : "error"](`Services deployment ${report.status}`);
									setDeploymentPlan(null);
									setReports(listProjectServicesDeploymentReports(scene));
								},
							})
						}
					>
						Execute plan
					</Button>
				</div>
				{deploymentPlan && (
					<div className="mt-2 rounded bg-secondary/50 p-2 font-mono text-[10px]" data-project-services-deployment-plan>
						{deploymentPlan.valid ? "VALID" : "BLOCKED"} · {deploymentPlan.command}
						<br />
						fingerprint {deploymentPlan.fingerprint}
					</div>
				)}
				{reports.slice(0, 5).map((report) => (
					<div key={report.id} className="mt-2 flex justify-between rounded border border-border p-2 text-xs" data-project-services-report={report.id}>
						<span>
							{report.environmentId} · {report.dryRun ? "dry run" : "apply"}
						</span>
						<span>
							{report.status} · {report.durationMs} ms
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
