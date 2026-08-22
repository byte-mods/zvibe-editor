import { describe, expect, test, vi } from "vitest";

import {
	createDefaultGrpcTransportConfiguration,
	decodeGrpcEnvelopes,
	encodeGrpcEnvelope,
	executeGrpcTransportCall,
	getGrpcTransportCapabilities,
	validateGrpcTransportConfiguration,
} from "../../src/loading/grpc-transport";

function concatenate(...values: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
	let offset = 0;
	for (const value of values) {
		result.set(value, offset);
		offset += value.byteLength;
	}
	return result;
}

function base64(value: Uint8Array): string {
	return btoa(String.fromCharCode(...value));
}

describe("loading/grpc-transport", () => {
	test("strictly validates portable endpoints, limits, protocols, and non-secret persisted metadata", () => {
		expect(validateGrpcTransportConfiguration(undefined)).toMatchObject({ version: 1, revision: 1, enabled: false, protocol: "grpc-web-binary" });
		expect(() => validateGrpcTransportConfiguration({ ...createDefaultGrpcTransportConfiguration(), endpoint: "http://example.com" })).toThrow("restricted to loopback");
		expect(() => validateGrpcTransportConfiguration({ ...createDefaultGrpcTransportConfiguration(), defaultMetadata: { authorization: "secret" } })).toThrow(
			"transiently per call"
		);
		expect(() => validateGrpcTransportConfiguration({ ...createDefaultGrpcTransportConfiguration(), protocol: "native-http2" })).toThrow("protocol is invalid");
		expect(getGrpcTransportCapabilities()).toMatchObject({ version: 1, callKinds: ["unary", "server-streaming"], protocols: ["grpc-web-binary", "grpc-web-text", "connect"] });
	});

	test("encodes/decodes unsigned big-endian envelopes and rejects truncation or oversized messages", () => {
		const encoded = encodeGrpcEnvelope(new Uint8Array([1, 2, 3]), 0x80);
		expect([...encoded]).toEqual([128, 0, 0, 0, 3, 1, 2, 3]);
		expect(decodeGrpcEnvelopes(encoded, 3)).toEqual([{ flag: 128, payload: new Uint8Array([1, 2, 3]) }]);
		expect(() => decodeGrpcEnvelopes(encoded, 2)).toThrow("receive limit");
		expect(() => decodeGrpcEnvelopes(encoded.slice(0, 7), 3)).toThrow("inside an envelope payload");
	});

	test("executes gRPC-Web unary framing with response trailers, deadlines, and transient metadata", async () => {
		const message = encodeGrpcEnvelope(new Uint8Array([8, 7, 6]));
		const trailer = encodeGrpcEnvelope(new TextEncoder().encode("grpc-status: 0\r\ngrpc-message: ok\r\nset-cookie: trailer-secret\r\n"), 0x80);
		const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer transient");
			expect(new Headers(init?.headers).get("grpc-timeout")).toBe("250m");
			const body = new Uint8Array(init?.body as ArrayBuffer);
			expect(decodeGrpcEnvelopes(body, 10)[0].payload).toEqual(new Uint8Array([1, 2]));
			return new Response(concatenate(message, trailer).buffer as ArrayBuffer, {
				status: 200,
				headers: { authorization: "response-secret", "content-type": "application/grpc-web+proto" },
			});
		});
		const response = await executeGrpcTransportCall(
			{ ...createDefaultGrpcTransportConfiguration(), enabled: true, defaultTimeoutMs: 250 },
			{ service: "zvibe.Game", method: "Load", payloadBase64: base64(new Uint8Array([1, 2])), metadata: { authorization: "Bearer transient" } },
			"unary",
			fetchImplementation as typeof fetch
		);
		expect(response).toMatchObject({ httpStatus: 200, grpcStatus: 0, grpcMessage: "ok", messagesBase64: [base64(new Uint8Array([8, 7, 6]))], requestBytes: 2 });
		expect(response.headers.authorization).toBe("[redacted]");
		expect(response.trailers["set-cookie"]).toBe("[redacted]");
	});

	test("decodes gRPC-Web text server streams and Connect unary payloads", async () => {
		const binary = concatenate(
			encodeGrpcEnvelope(new Uint8Array([1])),
			encodeGrpcEnvelope(new Uint8Array([2])),
			encodeGrpcEnvelope(new TextEncoder().encode("grpc-status: 0\r\n"), 0x80)
		);
		const textFetch = vi.fn(async () => new Response(base64(binary), { status: 200 }));
		const streamed = await executeGrpcTransportCall(
			{ ...createDefaultGrpcTransportConfiguration(), enabled: true, protocol: "grpc-web-text" },
			{ service: "zvibe.Game", method: "Watch", payloadBase64: "AA==" },
			"server-streaming",
			textFetch as typeof fetch
		);
		expect(streamed).toMatchObject({ grpcStatus: 0, messagesBase64: ["AQ==", "Ag=="] });

		const connectFetch = vi.fn(async () => new Response(new Uint8Array([9, 8]).buffer as ArrayBuffer, { status: 200 }));
		const unary = await executeGrpcTransportCall(
			{ ...createDefaultGrpcTransportConfiguration(), enabled: true, protocol: "connect" },
			{ service: "zvibe.Game", method: "Ping", payloadBase64: "AA==" },
			"unary",
			connectFetch as typeof fetch
		);
		expect(unary).toMatchObject({ grpcStatus: 0, messagesBase64: ["CQg="] });
	});
});
