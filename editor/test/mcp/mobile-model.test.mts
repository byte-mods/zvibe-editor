import { describe, expect, test } from "vitest";

import {
	createDefaultMobileDeploymentConfiguration,
	normalizeMobileDeploymentConfiguration,
	validateMobileDeploymentConfiguration,
	validateMobileRelativePath,
} from "../../src/mcp/mobile/model";

describe("mcp/mobile deployment model", () => {
	test("normalizes target settings without persisting credential values", () => {
		const configuration = normalizeMobileDeploymentConfiguration(
			{
				revision: 4,
				android: {
					format: "apk",
					variant: "debug",
					signing: {
						enabled: true,
						keystorePathEnvironment: "ANDROID_KEYSTORE",
						keystorePasswordEnvironment: "ANDROID_STORE_PASSWORD",
						keyAliasEnvironment: "ANDROID_ALIAS",
						keyPasswordEnvironment: "ANDROID_KEY_PASSWORD",
					},
				},
				ios: { exportMethod: "development", signing: { enabled: true, teamIdEnvironment: "APPLE_TEAM", identityEnvironment: "APPLE_IDENTITY" } },
			},
			"com.example.game"
		);
		validateMobileDeploymentConfiguration(configuration);
		expect(configuration).toMatchObject({
			version: 1,
			revision: 4,
			android: { format: "apk", variant: "debug", applicationId: "com.example.game", signing: { keystorePathEnvironment: "ANDROID_KEYSTORE" } },
			ios: { exportMethod: "development", applicationId: "com.example.game", signing: { teamIdEnvironment: "APPLE_TEAM" } },
		});
		expect(JSON.stringify(configuration)).not.toContain("secret");
	});

	test("requires every environment reference needed by enabled signing", () => {
		const configuration = createDefaultMobileDeploymentConfiguration();
		configuration.android.signing = { enabled: true, keystorePathEnvironment: "ANDROID_KEYSTORE" };
		expect(() => validateMobileDeploymentConfiguration(configuration)).toThrow("keystorePasswordEnvironment");
		configuration.android.signing.enabled = false;
		configuration.ios.signing = { enabled: true, teamIdEnvironment: "bad-name", identityEnvironment: "APPLE_IDENTITY" };
		expect(() => validateMobileDeploymentConfiguration(configuration)).toThrow("environment variable");
	});

	test("rejects traversal, absolute output, malformed identifiers, and executable injection", () => {
		for (const value of ["../outside", "/tmp/out", "C:/outside", "."]) {
			expect(() => validateMobileRelativePath(value, "artifact")).toThrow("project-relative");
		}
		const configuration = createDefaultMobileDeploymentConfiguration();
		configuration.android.applicationId = "bad application";
		expect(() => validateMobileDeploymentConfiguration(configuration)).toThrow("applicationId");
		configuration.android.applicationId = "com.zvibe.game";
		configuration.android.gradleTask = "assembleRelease;rm";
		expect(() => validateMobileDeploymentConfiguration(configuration)).toThrow("gradleTask");
	});
});
