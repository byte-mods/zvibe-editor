import { Component, ReactNode } from "react";

import { toast } from "sonner";

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/shadcn/ui/alert-dialog";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";

import {
	createVfxGraphFromTemplate,
	listVfxGraphTemplates,
	vfxGraphTemplateCategories,
	vfxGraphTemplateCatalogRevision,
	VfxGraphTemplateCategory,
} from "../../mcp/particles/vfx-templates";

import { Editor } from "../main";

export interface IVfxTemplateBrowserProps {
	editor: Editor;
	open: boolean;
	folder: string;
	onClose: () => void;
	onCreated: (path: string) => void;
}

interface IVfxTemplateBrowserState {
	query: string;
	category: "" | VfxGraphTemplateCategory;
	selectedId: string;
	name: string;
	busy: boolean;
}

/** Searchable and filterable portable VFX Graph asset-creation window. */
export class VfxTemplateBrowser extends Component<IVfxTemplateBrowserProps, IVfxTemplateBrowserState> {
	public constructor(props: IVfxTemplateBrowserProps) {
		super(props);
		this.state = { query: "", category: "", selectedId: "starter-sprite", name: "Starter Sprite", busy: false };
	}

	public componentDidUpdate(previousProps: IVfxTemplateBrowserProps): void {
		if (this.props.open && !previousProps.open) {
			this.setState({ query: "", category: "", selectedId: "starter-sprite", name: "Starter Sprite", busy: false });
		}
	}

	public render(): ReactNode {
		// Catalog search is scene-independent and can render while FlexLayout is
		// still mounting the Preview panel during project startup.
		const catalog = listVfxGraphTemplates(null, {
			query: this.state.query,
			category: this.state.category || undefined,
			limit: 50,
		}) as any;
		const selected = catalog.templates.find((template: any) => template.id === this.state.selectedId) ?? null;
		return (
			<AlertDialog open={this.props.open}>
				<AlertDialogContent data-testid="vfx-template-browser" className="flex max-h-[88vh] w-[820px] max-w-[95vw] flex-col">
					<AlertDialogHeader>
						<AlertDialogTitle>New VFX Graph from Template</AlertDialogTitle>
						<div className="text-xs text-muted-foreground">
							Creates a portable Babylon Node Particle asset. Unity VFX Graph package/API and GPU batch identity are not claimed.
						</div>
					</AlertDialogHeader>
					<div className="grid grid-cols-[minmax(0,1fr)_200px] gap-2">
						<Input
							aria-label="Search VFX templates"
							placeholder="Search templates (smoke, rain, sparks...)"
							value={this.state.query}
							onChange={(event) => this.setState({ query: event.currentTarget.value })}
						/>
						<select
							aria-label="Filter VFX template category"
							className="h-10 rounded-md border border-input bg-background px-3 text-sm"
							value={this.state.category}
							onChange={(event) => this.setState({ category: event.currentTarget.value as "" | VfxGraphTemplateCategory })}
						>
							<option value="">All categories</option>
							{vfxGraphTemplateCategories.map((category) => (
								<option key={category} value={category}>
									{category}
								</option>
							))}
						</select>
					</div>
					<div className="min-h-0 flex-1 space-y-2 overflow-auto rounded-md border border-border p-2">
						{catalog.templates.map((template: any) => (
							<button
								key={template.id}
								type="button"
								className={`w-full rounded-md border p-3 text-left transition-colors ${
									this.state.selectedId === template.id ? "border-blue-500 bg-blue-500/10" : "border-border bg-muted/30 hover:bg-muted/60"
								}`}
								onClick={() => this.setState({ selectedId: template.id, name: template.name })}
							>
								<div className="flex items-center justify-between gap-3">
									<span className="font-medium">{template.name}</span>
									<span className="text-[10px] uppercase text-muted-foreground">{template.category}</span>
								</div>
								<div className="mt-1 text-xs text-muted-foreground">{template.description}</div>
								<div className="mt-2 text-[10px] text-muted-foreground">{template.tags.join(" · ")}</div>
							</button>
						))}
						{catalog.templates.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No templates match this search and filter.</div>}
					</div>
					<div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2">
						<label htmlFor="vfx-template-name" className="text-sm text-muted-foreground">
							Asset name
						</label>
						<Input id="vfx-template-name" value={this.state.name} onChange={(event) => this.setState({ name: event.currentTarget.value })} />
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={this.state.busy} onClick={this.props.onClose}>
							Cancel
						</AlertDialogCancel>
						<Button disabled={this.state.busy || !selected || !this.state.name.trim()} onClick={() => void this._create()}>
							{this.state.busy ? "Creating..." : "Create VFX Graph"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		);
	}

	private async _create(): Promise<void> {
		this.setState({ busy: true });
		try {
			const scene = this.props.editor.layout.preview?.scene;
			if (!scene) {
				throw new Error("The scene Preview is still initializing. Try creating the VFX Graph again in a moment.");
			}
			const result = (await createVfxGraphFromTemplate(
				scene,
				{
					templateId: this.state.selectedId,
					expectedCatalogRevision: vfxGraphTemplateCatalogRevision,
					name: this.state.name,
					folder: this.props.folder,
				},
				{ editor: this.props.editor }
			)) as any;
			toast.success(`Created ${String(result.path)}.`);
			this.props.onCreated(String(result.path));
			this.props.onClose();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			this.setState({ busy: false });
		}
	}
}
