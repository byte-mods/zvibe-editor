const editorUrl = "http://localhost:3712";
let collaborationSessionToken: string | null = null;

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
		const response = await fetch(`${editorUrl}/${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: data
				? JSON.stringify({
						...data,
						...(collaborationSessionToken ? { collaborationToken: collaborationSessionToken } : {}),
						endpoint,
					} satisfies IGetFromEditorData)
				: JSON.stringify({ ...(collaborationSessionToken ? { collaborationToken: collaborationSessionToken } : {}), endpoint } satisfies IGetFromEditorData),
		});

		json = await response.json();
		if (response.ok && endpoint === "join_project_collaboration_session" && typeof json?.session?.token === "string") {
			collaborationSessionToken = json.session.token;
		}
		if (response.ok && endpoint === "leave_project_collaboration_session") {
			collaborationSessionToken = null;
		}
		text = JSON.stringify(json, null, "\t");
		isError = !response.ok;
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
