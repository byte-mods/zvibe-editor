import { afterAll, describe, expect, test, vi } from "vitest";
import { SerializationHelper } from "@babylonjs/core/Misc/decorators.serialization";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

import { registerTextureParser } from "../../src/loading/texture";

const originalTextureParser = SerializationHelper._TextureParser;

afterAll(() => {
	SerializationHelper._TextureParser = originalTextureParser;
});

describe("runtime texture parser registration", () => {
	test("recovers with Texture.Parse when another lifecycle cleared Babylon's parser", () => {
		const parse = vi.spyOn(Texture, "Parse").mockReturnValue(null);
		SerializationHelper._TextureParser = undefined as any;

		registerTextureParser();

		expect(typeof SerializationHelper._TextureParser).toBe("function");
		expect(SerializationHelper._TextureParser({ name: "assets/runtime.png" }, { loadingTexturesQuality: "high" } as any, "/scene/")).toBeNull();
		expect(parse).toHaveBeenCalledOnce();
	});
});
