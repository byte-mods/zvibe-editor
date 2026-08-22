import { describe, expect, test } from "vitest";

import { Observable, Texture } from "babylonjs";

import { waitForImportedTextureReady } from "../../../src/editor/layout/preview/import/import";

function createTextureDouble(): {
	texture: Texture;
	setReady: () => void;
	fail: (message: string) => void;
} {
	let ready = false;
	const onLoadObservable = new Observable<Texture>();
	const onErrorObservable = new Observable<Partial<{ message: string; exception: any }>>();
	const texture = {
		name: "assets/fixture.png",
		isReady: () => ready,
		onLoadObservable,
		getInternalTexture: () => ({ onErrorObservable }),
	} as unknown as Texture;
	return {
		texture,
		setReady: () => {
			ready = true;
			onLoadObservable.notifyObservers(texture);
		},
		fail: (message: string) => onErrorObservable.notifyObservers({ message }),
	};
}

describe("imported texture readiness", () => {
	test("waits for the texture load observable before resolving", async () => {
		const fixture = createTextureDouble();
		const pending = waitForImportedTextureReady(fixture.texture, 100);
		fixture.setReady();
		await expect(pending).resolves.toBeUndefined();
	});

	test("propagates the texture loader error instead of leaving a delayed renderer exception", async () => {
		const fixture = createTextureDouble();
		const pending = waitForImportedTextureReady(fixture.texture, 100);
		fixture.fail("fixture load failed");
		await expect(pending).rejects.toThrow("fixture load failed");
	});
});
