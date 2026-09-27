import onnxProtoModule from "onnx-proto";

/**
 * The runtime `onnx` protobuf namespace from the CommonJS "onnx-proto" package. A default import works in Node's ESM
 * loader (used by the CLI) and in bundlers, whereas a named import only works in bundlers.
 */
export const onnxProto = onnxProtoModule.onnx;
