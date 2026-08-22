import { request } from "node:http";

const configuredEditorPort = Number(process.env.BABYLONJS_EDITOR_MCP_PORT ?? 3712);
const editorPort = Number.isInteger(configuredEditorPort) && configuredEditorPort >= 1 && configuredEditorPort <= 65535 ? configuredEditorPort : 3712;
const editorUrl = `http://127.0.0.1:${editorPort}`;
let collaborationSessionToken: string | null = null;

interface IEditorHttpResponse {
	body: string;
	statusCode: number;
}

/**
 * Sends an editor request without Undici's five-minute response-header timeout.
 * Export and native build tools intentionally remain synchronous so an MCP call
 * reports the exact completed result, and legitimate project builds can exceed
 * that transport default. The invoking MCP client remains responsible for
 * cancellation by closing the stdio server process.
 */
function postToEditor(endpoint: string, body: string): Promise<IEditorHttpResponse> {
	return new Promise((resolve, reject) => {
		const editorRequest = request(
			`${editorUrl}/${endpoint}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(response) => {
				let responseBody = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => (responseBody += chunk));
				response.on("end", () => resolve({ body: responseBody, statusCode: response.statusCode ?? 500 }));
				response.on("error", reject);
			}
		);
		editorRequest.on("error", reject);
		editorRequest.end(body);
	});
}

export interface IGetFromEditorData {
	endpoint: string;
	[index: string]: any;
}

export interface IEditorResult {
	/**
	 * The parsed JSON response body returned by the editor handler (the tool's `data`),
	 * or `undefined` when the request failed before a body could be parsed.
	 */
	json: any;
	/**
	 * Pretty-printed JSON string of the response body, ready to be returned as text content.
	 */
	text: string;
	/**
	 * `true` when the HTTP status is not ok (editor handler threw) or when the fetch itself failed.
	 */
	isError: boolean;
}

export async function notifyAndGetResultFromEditor(endpoint: string, data?: any): Promise<IEditorResult> {
	let json: any;
	let text: string;
	let isError = false;

	try {
		const body = data
			? JSON.stringify({
					...data,
					...(collaborationSessionToken ? { collaborationToken: collaborationSessionToken } : {}),
					endpoint,
				} satisfies IGetFromEditorData)
			: JSON.stringify({ ...(collaborationSessionToken ? { collaborationToken: collaborationSessionToken } : {}), endpoint } satisfies IGetFromEditorData);
		const response = await postToEditor(endpoint, body);
		const ok = response.statusCode >= 200 && response.statusCode < 300;

		json = JSON.parse(response.body);
		if (ok && endpoint === "join_project_collaboration_session" && typeof json?.session?.token === "string") {
			collaborationSessionToken = json.session.token;
		}
		if (ok && endpoint === "leave_project_collaboration_session") {
			collaborationSessionToken = null;
		}
		text = JSON.stringify(json, null, "\t");
		isError = !ok;
	} catch (e) {
		isError = true;
		text = e.message;
	}

	return {
		json,
		text,
		isError,
	};
}
