import { ReactNode, useState } from "react";
import { toast } from "sonner";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { Label } from "../../../ui/shadcn/ui/label";
import { Switch } from "../../../ui/shadcn/ui/switch";

import { clearShaderVariants, getShaderVariants, prewarmShaderVariants, setShaderVariants, traceShaderVariants } from "../../../mcp/rendering/shader-variants";
import { Editor } from "../../main";

function row(label: string, control: ReactNode, description?: string): ReactNode {
	return (
		<div className="grid grid-cols-[minmax(180px,1fr)_minmax(240px,2fr)] items-center gap-3">
			<div>
				<Label>{label}</Label>
				{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
			</div>
			{control}
		</div>
	);
}

export function EditorGraphicsSettings({ editor }: { editor: Editor }): ReactNode {
	const [, setVersion] = useState(0);
	const [busy, setBusy] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const scene = editor.layout.preview.scene;
	const value = getShaderVariants(scene);
	const configuration = value.configuration;
	const lease = { expectedRevision: configuration.revision, expectedFingerprint: value.fingerprint };
	const refresh = (): void => setVersion((version) => version + 1);
	const run = async (action: () => Promise<any>, success: string): Promise<void> => {
		setBusy(true);
		try {
			await action();
			toast.success(success);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
			refresh();
		}
	};
	const set = (patch: Record<string, unknown>): Promise<void> => run(() => setShaderVariants(scene, { ...lease, ...patch }, { editor }), "Graphics settings updated");

	return (
		<div className="flex flex-col gap-5" data-testid="shader-variant-graphics-settings">
			<section className="flex flex-col gap-3">
				<div>
					<h3 className="text-lg font-medium">Automatic Shader Tracing and Prewarming</h3>
					<p className="text-xs text-muted-foreground">
						Captures portable Babylon material/effect variants from rendered frames and recompiles retained variants during scene loading. This does not store native
						GPU PSOs or vendor driver caches.
					</p>
					<p className="text-xs text-muted-foreground">Graphics changes apply immediately and are available through editor Undo/Redo.</p>
				</div>
				{row("Enabled", <Switch checked={configuration.enabled} disabled={busy} onCheckedChange={(enabled) => void set({ enabled })} />)}
				{row(
					"Automatic tracing",
					<Switch
						checked={configuration.automaticTracing}
						disabled={busy || !configuration.enabled}
						onCheckedChange={(automaticTracing) => void set({ automaticTracing })}
					/>,
					"Records unique ready variants after rendered editor/game frames."
				)}
				{row(
					"Automatic prewarming",
					<Switch
						checked={configuration.automaticPrewarming}
						disabled={busy || !configuration.enabled}
						onCheckedChange={(automaticPrewarming) => void set({ automaticPrewarming })}
					/>,
					"Runs bounded Babylon material compilation when the scene loads."
				)}
				{row(
					"Maximum retained variants",
					<Input
						key={`maximum-variants-${configuration.revision}`}
						type="number"
						min={1}
						max={4096}
						disabled={busy}
						defaultValue={configuration.maximumVariants}
						onBlur={(event) => {
							const maximumVariants = Number(event.target.value);
							if (maximumVariants !== configuration.maximumVariants) {
								void set({ maximumVariants });
							}
						}}
					/>
				)}
				{row(
					"Maximum startup prewarm",
					<Input
						key={`maximum-prewarm-${configuration.revision}`}
						type="number"
						min={1}
						max={512}
						disabled={busy}
						defaultValue={configuration.maximumPrewarmPerLoad}
						onBlur={(event) => {
							const maximumPrewarmPerLoad = Number(event.target.value);
							if (maximumPrewarmPerLoad !== configuration.maximumPrewarmPerLoad) {
								void set({ maximumPrewarmPerLoad });
							}
						}}
					/>
				)}
			</section>

			<section className="flex flex-col gap-3 rounded-md border border-input p-3">
				<div className="flex flex-wrap items-center gap-2">
					<Button
						disabled={busy || !configuration.enabled}
						onClick={() => void run(() => traceShaderVariants(scene, lease, { editor }), "Current shader variants traced")}
					>
						Trace Current Frame
					</Button>
					<Button
						variant="outline"
						disabled={busy || !configuration.enabled}
						onClick={() => void run(() => prewarmShaderVariants(scene, lease), "Shader variants prewarmed")}
					>
						Prewarm Now
					</Button>
					<Button
						variant="destructive"
						disabled={busy || configuration.variants.length === 0}
						onClick={() => {
							if (!confirmClear) {
								setConfirmClear(true);
								return;
							}
							setConfirmClear(false);
							void run(() => clearShaderVariants(scene, { ...lease, confirm: true }, { editor }), "Shader Variant Collection cleared");
						}}
					>
						{confirmClear ? "Confirm Clear" : "Clear Collection"}
					</Button>
					{confirmClear && (
						<Button variant="ghost" disabled={busy} onClick={() => setConfirmClear(false)}>
							Cancel Clear
						</Button>
					)}
				</div>
				<div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground md:grid-cols-4">
					<span>Revision: {configuration.revision}</span>
					<span>Variants: {configuration.variants.length}</span>
					<span>Resolvable: {value.validation.resolvableVariantCount}</span>
					<span>Backend: {value.validation.backend}</span>
					<span>Traced frames: {value.runtime?.tracedFrames ?? 0}</span>
					<span>Prewarmed: {value.runtime?.prewarmed ?? 0}</span>
					<span>Skipped: {value.runtime?.prewarmSkipped ?? 0}</span>
					<span>Failed: {value.runtime?.prewarmFailed ?? 0}</span>
				</div>
				{value.validation.issues.length > 0 && (
					<div className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
						{value.validation.issues.map((issue: any) => (
							<div key={`${issue.code}-${issue.variantId}`}>
								{issue.code}: {issue.message}
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
