import { Component, ErrorInfo, ReactNode } from "react";

/** Identifies a third-party panel while accepting its isolated React subtree. */
export interface IEditorExtensionErrorBoundaryProps {
	extensionId: string;
	children?: ReactNode;
}

interface IEditorExtensionErrorBoundaryState {
	error: string | null;
}

/** Prevents a faulty extension panel from taking down the editor layout around it. */
export class EditorExtensionErrorBoundary extends Component<IEditorExtensionErrorBoundaryProps, IEditorExtensionErrorBoundaryState> {
	public state: IEditorExtensionErrorBoundaryState = { error: null };

	public static getDerivedStateFromError(error: unknown): IEditorExtensionErrorBoundaryState {
		return { error: error instanceof Error ? error.message.slice(0, 1024) : "The extension panel failed to render." };
	}

	public componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error(`Editor extension panel "${this.props.extensionId}" crashed.`, error, info.componentStack);
	}

	public render(): ReactNode {
		if (this.state.error) {
			return <div className="m-2 rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">Extension panel failed: {this.state.error}</div>;
		}
		return this.props.children ?? null;
	}
}
