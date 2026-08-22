import { ComponentType } from "react";

import type { Editor } from "../editor/main";
import type { IEditorInspectorImplementationProps } from "../editor/layout/inspector/inspector";

/** Version negotiated between an installed extension manifest and the editor host. */
export const editorExtensionApiVersion = 1 as const;

/** Capabilities are opt-in so trust can be granted against an exact privilege set. */
export const editorExtensionCapabilities = ["inspectors", "windows", "menus", "tests", "buildProfiles", "editor"] as const;
export type EditorExtensionCapability = (typeof editorExtensionCapabilities)[number];

/** Declares a custom inspector before executable extension code is loaded. */
export interface IEditorExtensionInspectorContribution {
	id: string;
	title: string;
	priority: number;
}

/** Declares a dockable editor window and its preferred initial placement. */
export interface IEditorExtensionWindowContribution {
	id: string;
	title: string;
	neighborId?: "inspector" | "assets-browser";
}

/** Declares a command path that can be represented in the native application menu. */
export interface IEditorExtensionMenuContribution {
	id: string;
	path: string;
}

/** Declares an editor-only test exposed by the extension test runner. */
export interface IEditorExtensionTestContribution {
	id: string;
	title: string;
}

/** Build targets available to declarative Build Profiles footer actions. */
export type EditorExtensionBuildTarget = "web" | "electron" | "headless" | "android" | "ios";

/** Declares one custom action rendered in the selected Build Profile footer. */
export interface IEditorExtensionBuildProfileFooterContribution {
	id: string;
	title: string;
	description?: string;
	order: number;
	targets: EditorExtensionBuildTarget[];
	activeProfileOnly: boolean;
}

/** Complete declarative contribution set covered by the manifest fingerprint. */
export interface IEditorExtensionContributions {
	inspectors: IEditorExtensionInspectorContribution[];
	windows: IEditorExtensionWindowContribution[];
	menus: IEditorExtensionMenuContribution[];
	tests: IEditorExtensionTestContribution[];
	buildProfileFooterActions: IEditorExtensionBuildProfileFooterContribution[];
}

/** Strict package metadata read without executing third-party extension code. */
export interface IEditorExtensionManifest {
	apiVersion: typeof editorExtensionApiVersion;
	id: string;
	displayName: string;
	description?: string;
	capabilities: EditorExtensionCapability[];
	contributes: IEditorExtensionContributions;
}

/** Immutable inspection result used to make trust and activation decisions. */
export interface IInstalledEditorExtension {
	packageName: string;
	packageVersion: string;
	packageRoot: string;
	packageJsonPath: string;
	entryPath: string;
	packageJsonSha256: string;
	entrySha256: string;
	contentSha256: string;
	contentFileCount: number;
	contentBytes: number;
	packageManagerFingerprint: string;
	fingerprint: string;
	manifest: IEditorExtensionManifest;
}

/** Non-fatal package discovery failure associated with its dependency name. */
export interface IEditorExtensionDiscoveryIssue {
	packageName: string;
	message: string;
}

/** Batch discovery result keeps valid extensions usable while surfacing invalid packages. */
export interface IEditorExtensionDiscoveryResult {
	extensions: IInstalledEditorExtension[];
	issues: IEditorExtensionDiscoveryIssue[];
}

/** Machine-local grant bound to one exact package fingerprint and capability set. */
export interface IEditorExtensionTrustRecord {
	packageName: string;
	extensionId: string;
	fingerprint: string;
	capabilities: EditorExtensionCapability[];
	trustedAt: string;
}

/** Minimal storage contract keeps the trust subsystem testable outside a browser renderer. */
export interface IEditorExtensionTrustStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** Cleanup callbacks may release synchronous or asynchronous editor resources. */
export type EditorExtensionDispose = () => void | Promise<void>;

/** Runtime implementation registered for a manifest-declared inspector contribution. */
export interface IEditorExtensionInspectorRegistration {
	id: string;
	isSupported: (object: unknown) => boolean;
	component: ComponentType<IEditorInspectorImplementationProps<unknown>>;
	priority?: number;
}

/** Runtime implementation registered for a manifest-declared dockable window. */
export interface IEditorExtensionWindowRegistration {
	id: string;
	component: ComponentType;
}

/** Runtime implementation registered for a manifest-declared menu contribution. */
export interface IEditorExtensionMenuRegistration {
	id: string;
	execute: () => void | Promise<void>;
}

/** Runtime implementation registered for a manifest-declared editor-only test. */
export interface IEditorExtensionTestRegistration {
	id: string;
	run: (signal: AbortSignal) => void | Promise<void>;
}

/** Immutable selected-profile context supplied to footer actions. */
export interface IEditorExtensionBuildProfileActionContext {
	configurationRevision: number;
	isActive: boolean;
	profile: Readonly<{
		id: string;
		name: string;
		target: EditorExtensionBuildTarget;
		enabled: boolean;
		options: Readonly<Record<string, boolean>>;
		settings: Readonly<Record<string, unknown>>;
	}>;
}

/** Runtime callback registered for a manifest-declared Build Profile footer action. */
export interface IEditorExtensionBuildProfileFooterRegistration {
	id: string;
	execute: (context: IEditorExtensionBuildProfileActionContext) => void | Promise<void>;
}

/** Serializable footer descriptor safe for the normal editor UI and MCP clients. */
export interface IEditorExtensionBuildProfileFooterDescriptor extends IEditorExtensionBuildProfileFooterContribution {
	packageName: string;
	extensionFingerprint: string;
}

/** Serializable menu data safe to send from the renderer to Electron's main process. */
export interface IEditorExtensionMenuDescriptor {
	id: string;
	path: string;
}

/** Stable lifecycle states exposed to settings UI and automation. */
export type EditorExtensionRuntimeState = "inactive" | "activating" | "active" | "error";

/** Public lifecycle snapshot intentionally excludes executable module and cleanup references. */
export interface IEditorExtensionRuntimeStatus {
	packageName: string;
	packageVersion: string;
	extensionId: string;
	fingerprint: string;
	state: EditorExtensionRuntimeState;
	error?: string;
}

/** Terminal states emitted by the bounded editor-only test runner. */
export type EditorExtensionTestState = "passed" | "failed" | "timed-out";

/** One bounded editor-only test outcome. */
export interface IEditorExtensionTestResult {
	packageName: string;
	id: string;
	title: string;
	state: EditorExtensionTestState;
	durationMs: number;
	error?: string;
}

/** Capability-gated API passed to extension code during activation. */
export interface IEditorExtensionContext {
	readonly manifest: IEditorExtensionManifest;
	readonly capabilities: ReadonlySet<EditorExtensionCapability>;
	inspectors: { register(registration: IEditorExtensionInspectorRegistration): EditorExtensionDispose };
	windows: { register(registration: IEditorExtensionWindowRegistration): EditorExtensionDispose; open(id: string): void; close(id: string): void };
	menus: { register(registration: IEditorExtensionMenuRegistration): EditorExtensionDispose };
	tests: { register(registration: IEditorExtensionTestRegistration): EditorExtensionDispose };
	buildProfiles: { registerFooterAction(registration: IEditorExtensionBuildProfileFooterRegistration): EditorExtensionDispose };
	getEditor(): Editor;
}

/** CommonJS extension module shape accepted by the lifecycle host. */
export interface IEditorExtensionModule {
	activate(context: IEditorExtensionContext): void | EditorExtensionDispose | Promise<void | EditorExtensionDispose>;
	deactivate?: EditorExtensionDispose;
}
