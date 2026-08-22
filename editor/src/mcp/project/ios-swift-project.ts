import { join } from "path/posix";

import { pathExists, readFile } from "fs-extra";

export const IOS_SWIFT_PROJECT_VERSION = 1 as const;
export const iosSwiftProjectFiles = [
	"SwiftProject/ZvibeGame.xcodeproj/project.pbxproj",
	"SwiftProject/ZvibeGame.xcodeproj/xcshareddata/xcschemes/ZvibeGame.xcscheme",
	"SwiftProject/ZvibeGame/ZvibeGameApp.swift",
	"SwiftProject/ZvibeGame/GameWebView.swift",
	"SwiftProject/ZvibeGame/Info.plist",
] as const;

export interface IIosSwiftProjectSettings {
	deploymentTarget: string;
	deviceFamily: string;
	orientation: string;
}

function xml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function plistOrientations(orientation: string): string {
	const values =
		orientation === "portrait"
			? ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown"]
			: orientation === "landscape"
				? ["UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"]
				: ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"];
	return values.map((value) => `\t\t<string>${value}</string>`).join("\n");
}

function targetDeviceFamily(value: string): string {
	return value === "iphone" ? "1" : value === "ipad" ? "2" : "1,2";
}

function swiftApplicationSource(): string {
	return `import SwiftUI

@main
struct ZvibeGameApp: App {
    var body: some Scene {
        WindowGroup {
            GameWebView()
                .ignoresSafeArea()
        }
    }
}
`;
}

function swiftWebViewSource(): string {
	return `import SwiftUI
import WebKit

struct GameWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isOpaque = false
        view.backgroundColor = .black
        guard let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web") else {
            assertionFailure("The generated Web payload is missing Web/index.html.")
            return view
        }
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {}
}
`;
}

function infoPlist(settings: IIosSwiftProjectSettings, productName: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>${xml(productName)}</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UILaunchScreen</key>
	<dict/>
	<key>UISupportedInterfaceOrientations</key>
	<array>
${plistOrientations(settings.orientation)}
	</array>
</dict>
</plist>
`;
}

function xcodeProject(settings: IIosSwiftProjectSettings, applicationId: string): string {
	const family = targetDeviceFamily(settings.deviceFamily);
	return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {};
	objectVersion = 56;
	objects = {

/* Begin PBXBuildFile section */
		100000000000000000000001 /* ZvibeGameApp.swift in Sources */ = {isa = PBXBuildFile; fileRef = 200000000000000000000001 /* ZvibeGameApp.swift */; };
		100000000000000000000002 /* GameWebView.swift in Sources */ = {isa = PBXBuildFile; fileRef = 200000000000000000000002 /* GameWebView.swift */; };
		100000000000000000000003 /* Web in Resources */ = {isa = PBXBuildFile; fileRef = 200000000000000000000003 /* Web */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		200000000000000000000001 /* ZvibeGameApp.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ZvibeGameApp.swift; sourceTree = "<group>"; };
		200000000000000000000002 /* GameWebView.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = GameWebView.swift; sourceTree = "<group>"; };
		200000000000000000000003 /* Web */ = {isa = PBXFileReference; lastKnownFileType = folder; path = Web; sourceTree = "<group>"; };
		200000000000000000000004 /* ZvibeGame.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ZvibeGame.app; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		300000000000000000000001 /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		400000000000000000000001 = {isa = PBXGroup; children = (400000000000000000000002 /* ZvibeGame */, 400000000000000000000003 /* Products */); sourceTree = "<group>"; };
		400000000000000000000002 /* ZvibeGame */ = {isa = PBXGroup; children = (200000000000000000000001 /* ZvibeGameApp.swift */, 200000000000000000000002 /* GameWebView.swift */, 200000000000000000000003 /* Web */); path = ZvibeGame; sourceTree = "<group>"; };
		400000000000000000000003 /* Products */ = {isa = PBXGroup; children = (200000000000000000000004 /* ZvibeGame.app */); name = Products; sourceTree = "<group>"; };
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		500000000000000000000001 /* ZvibeGame */ = {isa = PBXNativeTarget; buildConfigurationList = 900000000000000000000002 /* Build configuration list for PBXNativeTarget "ZvibeGame" */; buildPhases = (700000000000000000000001 /* Sources */, 300000000000000000000001 /* Frameworks */, 700000000000000000000002 /* Resources */); buildRules = (); dependencies = (); name = ZvibeGame; productName = ZvibeGame; productReference = 200000000000000000000004 /* ZvibeGame.app */; productType = "com.apple.product-type.application"; };
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		600000000000000000000001 /* Project object */ = {isa = PBXProject; attributes = { BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 1600; LastUpgradeCheck = 1600; TargetAttributes = { 500000000000000000000001 = { CreatedOnToolsVersion = 16.0; }; }; }; buildConfigurationList = 900000000000000000000001 /* Build configuration list for PBXProject "ZvibeGame" */; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = 400000000000000000000001; productRefGroup = 400000000000000000000003 /* Products */; projectDirPath = ""; projectRoot = ""; targets = (500000000000000000000001 /* ZvibeGame */); };
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		700000000000000000000002 /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (100000000000000000000003 /* Web in Resources */); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		700000000000000000000001 /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (100000000000000000000001 /* ZvibeGameApp.swift in Sources */, 100000000000000000000002 /* GameWebView.swift in Sources */); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		800000000000000000000001 /* Debug */ = {isa = XCBuildConfiguration; buildSettings = { CLANG_ENABLE_MODULES = YES; IPHONEOS_DEPLOYMENT_TARGET = ${settings.deploymentTarget}; SDKROOT = iphoneos; SWIFT_VERSION = 5.0; }; name = Debug; };
		800000000000000000000002 /* Release */ = {isa = XCBuildConfiguration; buildSettings = { CLANG_ENABLE_MODULES = YES; IPHONEOS_DEPLOYMENT_TARGET = ${settings.deploymentTarget}; SDKROOT = iphoneos; SWIFT_VERSION = 5.0; }; name = Release; };
		800000000000000000000003 /* Debug */ = {isa = XCBuildConfiguration; buildSettings = { CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = ZvibeGame/Info.plist; IPHONEOS_DEPLOYMENT_TARGET = ${settings.deploymentTarget}; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = "${applicationId}"; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_EMIT_LOC_STRINGS = YES; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "${family}"; }; name = Debug; };
		800000000000000000000004 /* Release */ = {isa = XCBuildConfiguration; buildSettings = { CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = ZvibeGame/Info.plist; IPHONEOS_DEPLOYMENT_TARGET = ${settings.deploymentTarget}; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = "${applicationId}"; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_COMPILATION_MODE = wholemodule; SWIFT_EMIT_LOC_STRINGS = YES; SWIFT_OPTIMIZATION_LEVEL = "-O"; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "${family}"; }; name = Release; };
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		900000000000000000000001 /* Build configuration list for PBXProject "ZvibeGame" */ = {isa = XCConfigurationList; buildConfigurations = (800000000000000000000001 /* Debug */, 800000000000000000000002 /* Release */); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		900000000000000000000002 /* Build configuration list for PBXNativeTarget "ZvibeGame" */ = {isa = XCConfigurationList; buildConfigurations = (800000000000000000000003 /* Debug */, 800000000000000000000004 /* Release */); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
/* End XCConfigurationList section */
	};
	rootObject = 600000000000000000000001 /* Project object */;
}
`;
}

function sharedScheme(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
   <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
      <BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="500000000000000000000001" BuildableName="ZvibeGame.app" BlueprintName="ZvibeGame" ReferencedContainer="container:ZvibeGame.xcodeproj"/></BuildActionEntry></BuildActionEntries>
   </BuildAction>
   <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="500000000000000000000001" BuildableName="ZvibeGame.app" BlueprintName="ZvibeGame" ReferencedContainer="container:ZvibeGame.xcodeproj"/></BuildableProductRunnable></LaunchAction>
   <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="500000000000000000000001" BuildableName="ZvibeGame.app" BlueprintName="ZvibeGame" ReferencedContainer="container:ZvibeGame.xcodeproj"/></BuildableProductRunnable></ProfileAction>
   <AnalyzeAction buildConfiguration="Debug"/>
   <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`;
}

/** Produces deterministic, editor-owned SwiftUI/Xcode sources; the Web folder is filled by the generated build script. */
export function createIosSwiftProjectFiles(settings: IIosSwiftProjectSettings, applicationId: string, productName: string): Map<string, string> {
	return new Map([
		[iosSwiftProjectFiles[0], xcodeProject(settings, applicationId)],
		[iosSwiftProjectFiles[1], sharedScheme()],
		[iosSwiftProjectFiles[2], swiftApplicationSource()],
		[iosSwiftProjectFiles[3], swiftWebViewSource()],
		[iosSwiftProjectFiles[4], infoPlist(settings, productName)],
	]);
}

/** Validates structure and markers in one generated Swift project without modifying or launching Xcode. */
export async function validateIosSwiftProject(directory: string): Promise<Record<string, unknown>> {
	const checks = await Promise.all(
		iosSwiftProjectFiles.map(async (path) => {
			const absolutePath = join(directory, path);
			const exists = await pathExists(absolutePath);
			const source = exists ? await readFile(absolutePath, "utf8") : "";
			const marker = path.endsWith("project.pbxproj")
				? "PBXNativeTarget"
				: path.endsWith(".xcscheme")
					? "BuildableReference"
					: path.endsWith("ZvibeGameApp.swift")
						? "@main"
						: path.endsWith("GameWebView.swift")
							? "WKWebView"
							: "CFBundleIdentifier";
			return { path, exists, marker, markerPresent: source.includes(marker), bytes: Buffer.byteLength(source) };
		})
	);
	return {
		version: IOS_SWIFT_PROJECT_VERSION,
		projectPath: "SwiftProject/ZvibeGame.xcodeproj",
		scheme: "ZvibeGame",
		checks,
		valid: checks.every((check) => check.exists && check.markerPresent && check.bytes > 0),
	};
}

/** Describes the deliberately experimental Swift-first boundary without claiming vendor packaging or signing. */
export function getIosProjectGenerationCapabilities(): Record<string, unknown> {
	return {
		version: IOS_SWIFT_PROJECT_VERSION,
		projectTypes: [
			{ id: "capacitor", status: "supported", minimumIosVersion: "15.0", nativeSync: true },
			{ id: "swift", status: "experimental", minimumIosVersion: "16.0", nativeSync: false, hostUi: "SwiftUI", webRuntime: "WKWebView" },
		],
		swiftProject: {
			projectPath: "SwiftProject/ZvibeGame.xcodeproj",
			scheme: "ZvibeGame",
			editorOwnedFiles: [...iosSwiftProjectFiles],
			webPayloadDirectory: "SwiftProject/ZvibeGame/Web",
		},
		externalRequirements: ["macOS", "Xcode", "Apple signing identity and provisioning for devices or distribution"],
		limitations: [
			"Experimental and not intended as a production-stability guarantee.",
			"Unity as a Library, full-screen native video, and visionOS windowed mode are not generated.",
		],
	};
}
