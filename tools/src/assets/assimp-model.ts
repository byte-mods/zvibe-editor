export interface IAssimpModelSourceFile {
	name: string;
	content: Uint8Array;
}

export interface IAssimpModelConversion {
	content: Uint8Array;
	inputFileCount: number;
	inputBytes: number;
	outputBytes: number;
}

interface IAssimpFileList {
	AddFile(name: string, content: Uint8Array): void;
}

interface IAssimpResultFile {
	GetContent(): Uint8Array;
}

interface IAssimpConversionResult {
	IsSuccess(): boolean;
	FileCount(): number;
	GetErrorCode(): string;
	GetFile(index: number): IAssimpResultFile;
}

export interface IAssimpRuntime {
	FileList: new () => IAssimpFileList;
	ConvertFileList(files: IAssimpFileList, target: string): IAssimpConversionResult;
	ConvertFile(name: string, target: string, content: Uint8Array, exists: (name: string) => boolean, read: (name: string) => Uint8Array): IAssimpConversionResult;
}

const MAX_ASSIMP_INPUT_FILES = 512;
const MAX_ASSIMP_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_ASSIMP_OUTPUT_BYTES = 512 * 1024 * 1024;

function validateResult(result: IAssimpConversionResult, inputFileCount: number, inputBytes: number): IAssimpModelConversion {
	if (!result.IsSuccess() || result.FileCount() !== 1) {
		throw new Error(`Assimp GLB2 conversion failed (${result.GetErrorCode() || "unknown_error"}).`);
	}
	const output = new Uint8Array(result.GetFile(0).GetContent());
	if (output.byteLength < 20 || output.byteLength > MAX_ASSIMP_OUTPUT_BYTES) {
		throw new Error(`Assimp produced an invalid or oversized GLB2 payload (${output.byteLength} bytes).`);
	}
	const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
	if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== output.byteLength) {
		throw new Error("Assimp produced a malformed GLB2 header.");
	}
	return {
		content: output,
		inputFileCount,
		inputBytes,
		outputBytes: output.byteLength,
	};
}

function normalizedInputName(name: string): string {
	const normalized = name.replace(/\\/g, "/").replace(/^\.\/+/, "");
	if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/../")) {
		throw new Error(`Legacy model dependency path is not contained: ${name}`);
	}
	return normalized;
}

/** Converts one bounded, self-contained Assimp file set to a GLB v2 payload. */
export function convertAssimpModelToGlb(runtime: IAssimpRuntime, files: IAssimpModelSourceFile[]): IAssimpModelConversion {
	if (!files.length) {
		throw new Error("Legacy model conversion requires at least one source file.");
	}
	if (files.length > MAX_ASSIMP_INPUT_FILES) {
		throw new Error(`Legacy model conversion supports at most ${MAX_ASSIMP_INPUT_FILES} source and dependency files.`);
	}
	const normalizedNames = new Set<string>();
	let inputBytes = 0;
	const list = new runtime.FileList();
	for (const file of files) {
		const normalized = normalizedInputName(file.name);
		const key = normalized.toLowerCase();
		if (normalizedNames.has(key)) {
			throw new Error(`Legacy model dependency names must be unique ignoring case: ${normalized}`);
		}
		normalizedNames.add(key);
		inputBytes += file.content.byteLength;
		if (inputBytes > MAX_ASSIMP_INPUT_BYTES) {
			throw new Error(`Legacy model conversion input is limited to ${MAX_ASSIMP_INPUT_BYTES} bytes.`);
		}
		list.AddFile(normalized, file.content);
	}
	return validateResult(runtime.ConvertFileList(list, "glb2"), files.length, inputBytes);
}

/** Converts one model while Assimp requests only its actual dependency files through a bounded resolver. */
export function convertAssimpModelFileToGlb(
	runtime: IAssimpRuntime,
	mainFile: IAssimpModelSourceFile,
	resolveDependency: (name: string) => Uint8Array | null
): IAssimpModelConversion {
	const name = normalizedInputName(mainFile.name);
	const cache = new Map<string, Uint8Array>([[name, mainFile.content]]);
	let inputBytes = mainFile.content.byteLength;
	const resolve = (requestedName: string): Uint8Array | null => {
		const normalized = requestedName.replace(/\\/g, "/").replace(/^\.\/+/, "");
		if (!normalized || normalized.startsWith("/")) {
			return null;
		}
		const cached = cache.get(normalized);
		if (cached) {
			return cached;
		}
		if (cache.size >= MAX_ASSIMP_INPUT_FILES) {
			throw new Error(`Legacy model conversion supports at most ${MAX_ASSIMP_INPUT_FILES} source and dependency files.`);
		}
		const content = resolveDependency(normalized);
		if (!content) {
			return null;
		}
		inputBytes += content.byteLength;
		if (inputBytes > MAX_ASSIMP_INPUT_BYTES) {
			throw new Error(`Legacy model conversion input is limited to ${MAX_ASSIMP_INPUT_BYTES} bytes.`);
		}
		cache.set(normalized, content);
		return content;
	};
	const result = runtime.ConvertFile(
		name,
		"glb2",
		mainFile.content,
		(requestedName) => resolve(requestedName) !== null,
		(requestedName) => {
			const content = resolve(requestedName);
			if (!content) {
				throw new Error(`Legacy model dependency does not exist: ${requestedName}`);
			}
			return content;
		}
	);
	return validateResult(result, cache.size, inputBytes);
}
