import { afterEach, describe, expect, test, vi } from "vitest";

import { EditorExtensionHost, IEditorExtensionHostAdapter } from "../../src/extensions/host";
import { trustEditorExtension } from "../../src/extensions/trust";
import {
	IEditorExtensionContext,
	IEditorExtensionManifest,
	IEditorExtensionMenuDescriptor,
	IEditorExtensionModule,
	IEditorExtensionTrustStorage,
	IInstalledEditorExtension,
} from "../../src/extensions/types";

function storage(): IEditorExtensionTrustStorage & { value: string | null } {
	return {
		value: null,
		getItem(): string | null {
			return this.value;
		},
		setItem(_key: string, value: string): void {
			this.value = value;
		},
	};
}

function installed(
	packageName = "example-extension",
	id = "com.example.tools",
	fingerprint = "a".repeat(64),
	manifestOverrides: Partial<IEditorExtensionManifest> = {}
): IInstalledEditorExtension {
	const manifest: IEditorExtensionManifest = {
		apiVersion: 1,
		id,
		displayName: "Example",
		capabilities: ["inspectors", "windows", "menus", "tests"],
		contributes: {
			inspectors: [{ id: `${id}.inspector`, title: "Inspector", priority: 10 }],
			windows: [{ id: `${id}.window`, title: "Window", neighborId: "inspector" }],
			menus: [{ id: `${id}.menu`, path: `${id}/Open` }],
			tests: [{ id: `${id}.test`, title: "Smoke" }],
			buildProfileFooterActions: [],
		},
		...manifestOverrides,
	};
	return {
		packageName,
		packageVersion: "1.0.0",
		packageRoot: `/packages/${packageName}`,
		packageJsonPath: `/packages/${packageName}/package.json`,
		entryPath: `/packages/${packageName}/index.js`,
		packageJsonSha256: "b".repeat(64),
		entrySha256: "c".repeat(64),
		contentSha256: "d".repeat(64),
		contentFileCount: 2,
		contentBytes: 200,
		packageManagerFingerprint: "e".repeat(64),
		fingerprint,
		manifest,
	};
}

function completeModule(id: string, events: string[] = []): IEditorExtensionModule {
	return {
		activate(context): () => void {
			context.inspectors.register({ id: `${id}.inspector`, isSupported: () => true, component: () => null });
			context.windows.register({ id: `${id}.window`, component: () => null });
			context.menus.register({
				id: `${id}.menu`,
				execute: () => {
					events.push("menu");
				},
			});
			context.tests.register({
				id: `${id}.test`,
				run: () => {
					events.push("test");
				},
			});
			return () => events.push("activate-cleanup");
		},
		deactivate(): void {
			events.push("deactivate");
		},
	};
}

function harness(
	extension: IInstalledEditorExtension,
	moduleSource: IEditorExtensionModule | ((events: string[]) => IEditorExtensionModule)
): {
	host: EditorExtensionHost;
	adapter: IEditorExtensionHostAdapter;
	values: ReturnType<typeof storage>;
	events: string[];
	menus: IEditorExtensionMenuDescriptor[];
	setInspected(value: IInstalledEditorExtension | null): void;
} {
	const values = storage();
	const events: string[] = [];
	const menus: IEditorExtensionMenuDescriptor[] = [];
	const module = typeof moduleSource === "function" ? moduleSource(events) : moduleSource;
	let inspected: IInstalledEditorExtension | null = extension;
	const adapter: IEditorExtensionHostAdapter = {
		editor: {} as IEditorExtensionHostAdapter["editor"],
		trustStorage: values,
		reinspect: async () => inspected,
		registerInspector: (registration) => {
			events.push(`inspector:${registration.id}`);
			return () => events.push(`inspector-dispose:${registration.id}`);
		},
		openWindow: (contribution) => events.push(`window-open:${contribution.id}`),
		closeWindow: (id) => events.push(`window-close:${id}`),
		selectWindow: (id) => events.push(`window-select:${id}`),
		updateMenus: (descriptors) => {
			menus.splice(0, menus.length, ...descriptors);
		},
		loadModule: () => module,
	};
	return { host: new EditorExtensionHost(adapter), adapter, values, events, menus, setInspected: (value) => (inspected = value) };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("EditorExtensionHost", () => {
	test("activates exact trusted contributions and owns menu, window, test, and cleanup lifecycle", async () => {
		const extension = installed();
		const setup = harness(extension, (events) => completeModule(extension.manifest.id, events));
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		expect(await setup.host.activate(extension)).toMatchObject({ packageName: "example-extension", state: "active" });
		expect(setup.menus).toEqual([{ id: "com.example.tools.menu", path: "com.example.tools/Open" }]);
		setup.host.openWindow("com.example.tools.window");
		await setup.host.invokeMenu("com.example.tools.menu");
		expect(await setup.host.runTests()).toMatchObject([{ id: "com.example.tools.test", state: "passed" }]);
		expect(await setup.host.dispose("example-extension")).toMatchObject({ state: "inactive" });
		expect(setup.events).toEqual([
			"inspector:com.example.tools.inspector",
			"window-open:com.example.tools.window",
			"window-select:com.example.tools.window",
			"menu",
			"test",
			"window-close:com.example.tools.window",
			"inspector-dispose:com.example.tools.inspector",
			"activate-cleanup",
			"deactivate",
		]);
		expect(setup.menus).toEqual([]);
	});

	test("filters and invokes immutable Build Profile footer actions through their declared lifecycle", async () => {
		const extension = installed("profile-extension", "com.example.profile", "9".repeat(64), {
			capabilities: ["buildProfiles"],
			contributes: {
				inspectors: [],
				windows: [],
				menus: [],
				tests: [],
				buildProfileFooterActions: [
					{ id: "com.example.profile.audit", title: "Audit iOS", description: "Inspect the selected iOS profile.", order: 10, targets: ["ios"], activeProfileOnly: true },
				],
			},
		});
		let received: unknown;
		const setup = harness(extension, {
			activate(context): void {
				context.buildProfiles.registerFooterAction({ id: "com.example.profile.audit", execute: (value) => (received = value) });
			},
		});
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		await setup.host.activate(extension);
		const inactiveContext = {
			configurationRevision: 3,
			isActive: false,
			profile: { id: "ios", name: "iOS", target: "ios" as const, enabled: true, options: {}, settings: {} },
		};
		expect(setup.host.listBuildProfileFooterActions(inactiveContext)).toEqual([]);
		const activeContext = { ...inactiveContext, isActive: true };
		expect(setup.host.listBuildProfileFooterActions(activeContext)).toMatchObject([{ id: "com.example.profile.audit", packageName: "profile-extension" }]);
		await setup.host.invokeBuildProfileFooterAction("com.example.profile.audit", activeContext);
		expect(received).toMatchObject({ configurationRevision: 3, isActive: true, profile: { id: "ios", target: "ios" } });
		expect(Object.isFrozen(received)).toBe(true);
		expect(Object.isFrozen((received as { profile: object }).profile)).toBe(true);
		await setup.host.dispose(extension.packageName);
		await expect(setup.host.invokeBuildProfileFooterAction("com.example.profile.audit", activeContext)).rejects.toThrow("not registered and active");
	});

	test("rejects missing trust and changed content before loading executable code", async () => {
		const extension = installed();
		const setup = harness(extension, (events) => completeModule(extension.manifest.id, events));
		const loadSpy = vi.spyOn(setup.adapter, "loadModule");
		await expect(setup.host.activate(extension)).rejects.toThrow("not trusted");
		expect(loadSpy).not.toHaveBeenCalled();
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		setup.setInspected({ ...extension, fingerprint: "f".repeat(64) });
		await expect(setup.host.activate(extension)).rejects.toThrow("changed after discovery");
		expect(loadSpy).not.toHaveBeenCalled();
	});

	test("rolls back partial activation when declarations are missing or undeclared", async () => {
		const extension = installed();
		let capturedContext: IEditorExtensionContext | null = null;
		const setup = harness(extension, {
			activate(context): void {
				capturedContext = context;
				context.inspectors.register({ id: "com.example.tools.inspector", isSupported: () => true, component: () => null });
			},
			deactivate(): void {
				setup.events.push("deactivate");
			},
		});
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		await expect(setup.host.activate(extension)).rejects.toThrow("did not register declared");
		expect(setup.host.list()).toMatchObject([{ state: "error" }]);
		expect(setup.events).toContain("inspector-dispose:com.example.tools.inspector");
		expect(() => capturedContext!.menus.register({ id: "com.example.tools.not-declared", execute: () => undefined })).toThrow("is not active");
	});

	test("does not count an immediately disposed declaration as registered", async () => {
		const extension = installed();
		const setup = harness(extension, {
			activate(context): void {
				void context.inspectors.register({ id: "com.example.tools.inspector", isSupported: () => true, component: () => null })();
				context.windows.register({ id: "com.example.tools.window", component: () => null });
				context.menus.register({ id: "com.example.tools.menu", execute: () => undefined });
				context.tests.register({ id: "com.example.tools.test", run: () => undefined });
			},
		});
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		await expect(setup.host.activate(extension)).rejects.toThrow("com.example.tools.inspector");
	});

	test("serializes overlapping lifecycle operations", async () => {
		const extension = installed();
		let release: (() => void) | undefined;
		const setup = harness(extension, {
			async activate(context): Promise<void> {
				context.inspectors.register({ id: "com.example.tools.inspector", isSupported: () => true, component: () => null });
				context.windows.register({ id: "com.example.tools.window", component: () => null });
				context.menus.register({ id: "com.example.tools.menu", execute: () => undefined });
				context.tests.register({ id: "com.example.tools.test", run: () => undefined });
				await new Promise<void>((resolve) => (release = resolve));
			},
		});
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		const activation = setup.host.activate(extension);
		const disposal = setup.host.dispose(extension.packageName);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		release!();
		await expect(activation).resolves.toMatchObject({ state: "active" });
		await expect(disposal).resolves.toMatchObject({ state: "inactive" });
	});

	test("freezes security metadata and revokes context access after disposal", async () => {
		const extension = installed();
		let capturedContext: IEditorExtensionContext | null = null;
		const setup = harness(extension, {
			activate(context): void {
				capturedContext = context;
				context.inspectors.register({ id: "com.example.tools.inspector", isSupported: () => true, component: () => null });
				context.windows.register({ id: "com.example.tools.window", component: () => null });
				context.menus.register({ id: "com.example.tools.menu", execute: () => undefined });
				context.tests.register({ id: "com.example.tools.test", run: () => undefined });
			},
		});
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		await setup.host.activate(extension);
		expect(Object.isFrozen(capturedContext!.manifest)).toBe(true);
		expect(Object.isFrozen(capturedContext!.manifest.capabilities)).toBe(true);
		expect(() => capturedContext!.manifest.capabilities.push("editor")).toThrow();
		expect(() => capturedContext!.getEditor()).toThrow('did not declare capability "editor"');
		await setup.host.dispose(extension.packageName);
		expect(() => capturedContext!.getEditor()).toThrow("is not active");
	});

	test("bounds a hung activation and records an error state", async () => {
		vi.useFakeTimers();
		const extension = installed("hung-extension", "com.example.hung", "2".repeat(64), {
			capabilities: [],
			contributes: { inspectors: [], windows: [], menus: [], tests: [], buildProfileFooterActions: [] },
		});
		const setup = harness(extension, { activate: async () => new Promise<void>(() => undefined) });
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		const activation = setup.host.activate(extension);
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(activation).rejects.toThrow("activation timed out");
		expect(setup.host.list()).toMatchObject([{ packageName: "hung-extension", state: "error" }]);
	});

	test("runs tests sequentially and reports failures and timeouts without aborting the batch", async () => {
		const extension = installed("test-extension", "com.example.tests", "1".repeat(64), {
			capabilities: ["tests"],
			contributes: {
				inspectors: [],
				windows: [],
				menus: [],
				buildProfileFooterActions: [],
				tests: [
					{ id: "com.example.tests.a", title: "Pass" },
					{ id: "com.example.tests.b", title: "Fail" },
					{ id: "com.example.tests.c", title: "Timeout" },
				],
			},
		});
		const order: string[] = [];
		const setup = harness(extension, {
			activate(context): void {
				context.tests.register({
					id: "com.example.tests.a",
					run: () => {
						order.push("a");
					},
				});
				context.tests.register({
					id: "com.example.tests.b",
					run: () => {
						order.push("b");
						throw new Error("expected failure");
					},
				});
				context.tests.register({ id: "com.example.tests.c", run: async (signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())) });
			},
		});
		trustEditorExtension(setup.values, extension, extension.manifest.capabilities);
		await setup.host.activate(extension);
		const results = await setup.host.runTests({ timeoutMs: 5 });
		expect(results.map((result) => result.state)).toEqual(["passed", "failed", "timed-out"]);
		expect(results[1].error).toContain("expected failure");
		expect(order).toEqual(["a", "b"]);
	});
});
