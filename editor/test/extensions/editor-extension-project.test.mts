import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { afterEach, describe, expect, test } from "vitest";

import type { Editor } from "../../src/editor/main";
import { EditorExtensionHost } from "../../src/extensions/host";
import {
	disposeProjectEditorExtensions,
	normalizeProjectEditorExtensions,
	projectEditorExtensionPackageNames,
	resumeProjectEditorExtensions,
	setProjectEditorExtensionEnabled,
	suspendProjectEditorExtensions,
	syncProjectEditorExtensions,
} from "../../src/extensions/project";
import { trustEditorExtension } from "../../src/extensions/trust";
import type { IEditorExtensionTrustStorage, IInstalledEditorExtension } from "../../src/extensions/types";
import { getProjectPackageContext } from "../../src/mcp/project/package-manager/context";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

function hostFactory(editor: Editor, reinspect: (packageName: string) => Promise<IInstalledEditorExtension | null>, values: IEditorExtensionTrustStorage): EditorExtensionHost {
	return new EditorExtensionHost({
		editor,
		trustStorage: values,
		reinspect,
		registerInspector: () => () => undefined,
		openWindow: () => undefined,
		closeWindow: () => undefined,
		selectWindow: () => undefined,
		updateMenus: () => undefined,
	});
}

async function project(): Promise<{ editor: Editor; projectRoot: string }> {
	const projectRoot = await mkdtemp(join(tmpdir(), "zvibe-extension-project-"));
	roots.push(projectRoot);
	const packageRoot = join(projectRoot, "node_modules", "example-extension");
	const transitiveRoot = join(projectRoot, "node_modules", "transitive-extension");
	await mkdir(packageRoot, { recursive: true });
	await mkdir(transitiveRoot, { recursive: true });
	await writeFile(join(projectRoot, "package.json"), JSON.stringify({ name: "game", version: "1.0.0", dependencies: { "example-extension": "1.0.0" } }));
	await writeFile(join(packageRoot, "index.js"), "exports.activate = () => undefined;\n");
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "example-extension",
			version: "1.0.0",
			main: "index.js",
			zvibeEditor: { apiVersion: 1, id: "com.example.extension", displayName: "Example", capabilities: [], contributes: {} },
		})
	);
	await writeFile(join(transitiveRoot, "index.js"), "exports.activate = () => undefined;\n");
	await writeFile(
		join(transitiveRoot, "package.json"),
		JSON.stringify({
			name: "transitive-extension",
			version: "1.0.0",
			main: "index.js",
			zvibeEditor: { apiVersion: 1, id: "com.example.transitive", displayName: "Transitive", capabilities: [], contributes: {} },
		})
	);
	const state = {
		projectPath: join(projectRoot, "game.bjseditor"),
		packageManager: "npm",
		editorExtensions: [{ packageName: "example-extension", enabled: true }],
		plugins: [],
	};
	const editor = {
		state,
		extensionHost: null,
		setState(update: Record<string, unknown>, callback?: () => void): void {
			Object.assign(state, update);
			callback?.();
		},
		setExtensionMenus(): void {},
	} as unknown as Editor;
	return { editor, projectRoot };
}

describe("project editor extensions", () => {
	test("normalizes shared enablement without preserving malformed, duplicate, or excessive records", () => {
		expect(
			normalizeProjectEditorExtensions([
				{ packageName: "z-extension", enabled: false },
				{ packageName: "a-extension", enabled: true },
				{ packageName: "a-extension", enabled: false },
				{ packageName: "../escape", enabled: true },
				{ packageName: "extra", enabled: true, trust: true },
			])
		).toEqual([
			{ packageName: "a-extension", enabled: true },
			{ packageName: "z-extension", enabled: false },
		]);
		expect(normalizeProjectEditorExtensions(Array.from({ length: 129 }, (_, index) => ({ packageName: `extension-${index}`, enabled: true })))).toEqual([]);
	});

	test("discovers direct dependencies only and requires exact local trust before activation", async () => {
		const { editor } = await project();
		const values = storage();
		const context = await getProjectPackageContext({ editor });
		expect(projectEditorExtensionPackageNames(context)).toEqual(["example-extension"]);
		const beforeTrust = await syncProjectEditorExtensions(editor, { trustStorage: values, context, hostFactory });
		expect(beforeTrust.extensions).toHaveLength(1);
		expect(beforeTrust.extensions[0]).toMatchObject({ enabled: true, trusted: false, runtime: null });
		expect(beforeTrust.issues).toContainEqual(expect.objectContaining({ packageName: "example-extension", stage: "trust" }));
		trustEditorExtension(values, beforeTrust.extensions[0].extension, beforeTrust.extensions[0].extension.manifest.capabilities);
		const active = await syncProjectEditorExtensions(editor, { trustStorage: values });
		expect(active.extensions[0]).toMatchObject({ enabled: true, trusted: true, runtime: { state: "active" } });
		expect(active.extensions.some((view) => view.extension.packageName === "transitive-extension")).toBe(false);
		await suspendProjectEditorExtensions(editor, ["example-extension"]);
		const suspended = await syncProjectEditorExtensions(editor, { trustStorage: values });
		expect(suspended.extensions[0]).toMatchObject({ runtime: { state: "inactive" } });
		expect(suspended.issues).toContainEqual(expect.objectContaining({ packageName: "example-extension", message: expect.stringContaining("suspended") }));
		const resumed = await resumeProjectEditorExtensions(editor, ["example-extension"], { trustStorage: values });
		expect(resumed.extensions[0]).toMatchObject({ runtime: { state: "active" } });
		await disposeProjectEditorExtensions(editor);
	});

	test("unloads changed content, invalidates trust, and persists explicit disablement", async () => {
		const { editor, projectRoot } = await project();
		const values = storage();
		const discovered = await syncProjectEditorExtensions(editor, { trustStorage: values, hostFactory });
		trustEditorExtension(values, discovered.extensions[0].extension, discovered.extensions[0].extension.manifest.capabilities);
		await syncProjectEditorExtensions(editor, { trustStorage: values });
		await writeFile(join(projectRoot, "node_modules", "example-extension", "helper.js"), "module.exports = 2;\n");
		const changed = await syncProjectEditorExtensions(editor, { trustStorage: values });
		expect(changed.extensions[0]).toMatchObject({ trusted: false, runtime: { state: "inactive" } });
		expect(changed.issues).toContainEqual(expect.objectContaining({ stage: "trust" }));
		const disabled = await setProjectEditorExtensionEnabled(editor, "example-extension", false, { trustStorage: values });
		expect(disabled.configured).toEqual([{ packageName: "example-extension", enabled: false }]);
		expect(editor.state.editorExtensions).toEqual([{ packageName: "example-extension", enabled: false }]);
		await disposeProjectEditorExtensions(editor);
	});
});
