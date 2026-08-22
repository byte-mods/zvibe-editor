const assetRegistryParentPort = require("worker_threads").parentPort as import("worker_threads").MessagePort | null;

type AssetRegistryWorkerRequest = { id: number; absolutePath: string; projectRoot: string };
type AssetRegistryWorkerResponse = { id: number; analysis?: unknown; missing?: boolean; error?: string };

async function handleAssetRegistryWorkerRequest(request: AssetRegistryWorkerRequest, respond: (response: AssetRegistryWorkerResponse) => void): Promise<void> {
	try {
		const { analyzeAssetFile } = require("./registry") as typeof import("./registry");
		const analysis = await analyzeAssetFile(request.absolutePath, request.projectRoot);
		respond({ id: request.id, analysis });
	} catch (error) {
		respond(
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? { id: request.id, missing: true }
				: { id: request.id, error: error instanceof Error ? error.message : String(error) }
		);
	}
}

if (assetRegistryParentPort) {
	const assetRegistryMessagePort = assetRegistryParentPort;
	assetRegistryMessagePort.on(
		"message",
		(request: AssetRegistryWorkerRequest) => void handleAssetRegistryWorkerRequest(request, (response) => assetRegistryMessagePort.postMessage(response))
	);
} else {
	globalThis.addEventListener(
		"message",
		(event: MessageEvent<AssetRegistryWorkerRequest>) => void handleAssetRegistryWorkerRequest(event.data, (response) => globalThis.postMessage(response))
	);
}
