import { describe, expect, test } from "vitest";

import { parseUnityAssetMeta, parseUnityAvatarMaskAsset } from "../../src/assets/unity-asset-dependencies";

function maskBits(enabled: number[]): string {
	const bytes = Buffer.alloc(13 * 4);
	for (const index of enabled) {
		bytes.writeUInt32LE(1, index * 4);
	}
	return bytes.toString("hex");
}

describe("Unity asset dependency formats", () => {
	test("parses one exact meta GUID and AnimationClip fileID table", () => {
		const result = parseUnityAssetMeta(`fileFormatVersion: 2
guid: ABCDEFABCDEFABCDEFABCDEFABCDEFAB
ModelImporter:
  internalIDToNameTable:
  - first:
      74: 7400001
    second: Walk
  - first:
      74: 7400002
    second: Run
`);
		expect(result).toEqual({
			guid: "abcdefabcdefabcdefabcdefabcdefab",
			subAssets: [
				{ fileId: "7400001", name: "Walk" },
				{ fileId: "7400002", name: "Run" },
			],
		});
	});

	test("rejects missing, duplicate, zero, and conflicting Unity identities", () => {
		expect(() => parseUnityAssetMeta("fileFormatVersion: 2\n")).toThrow(/exactly one/i);
		expect(() => parseUnityAssetMeta(`guid: 00000000000000000000000000000000\n`)).toThrow(/non-zero/i);
		expect(() => parseUnityAssetMeta(`guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nguid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n`)).toThrow(/exactly one/i);
		expect(() =>
			parseUnityAssetMeta(`guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ModelImporter:
  internalIDToNameTable:
  - first: {74: 7400001}
    second: Walk
  - first: {74: 7400001}
    second: Run
`)
		).toThrow(/maps to both/i);
	});

	test("converts exact AvatarMask body bits and weighted transform paths", () => {
		const result = parseUnityAvatarMaskAsset(`%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!319 &31900000
AvatarMask:
  m_Name: Upper Body
  m_Mask: ${maskBits([0, 1, 2, 5, 6, 7, 8, 11])}
  m_Elements:
  - m_Path:
    m_Weight: 1
  - m_Path: Root/Spine
    m_Weight: 1
  - m_Path: Root/Leg
    m_Weight: 0
`);
		expect(result).toMatchObject({
			fileId: "31900000",
			name: "Upper Body",
			bodyParts: {
				root: true,
				body: true,
				head: true,
				leftArm: true,
				rightArm: true,
				leftHand: true,
				rightHand: true,
				leftLeg: false,
				rightLeg: false,
			},
			transformNames: ["Root/Spine"],
			disabledTransformNames: ["Root/Leg"],
		});
		expect(result.ignoredIkBodyParts).toContainEqual({ name: "LeftHandIK", active: true });
	});

	test("rejects malformed AvatarMask bodies and transform weights", () => {
		expect(() =>
			parseUnityAvatarMaskAsset(`%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!319 &31900000
AvatarMask:
  m_Name: Bad
  m_Mask: 01
  m_Elements: []
`)
		).toThrow(/13 little-endian/i);
		expect(() =>
			parseUnityAvatarMaskAsset(`%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!319 &31900000
AvatarMask:
  m_Name: Bad
  m_Mask: ${maskBits([])}
  m_Elements:
  - m_Path: Root
    m_Weight: 2
`)
		).toThrow(/0\.\.1 weight/i);
	});
});
