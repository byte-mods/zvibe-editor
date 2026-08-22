/** Physical Chromium DevTools input helpers for rebuilt Zvibe Editor lifecycle gates. */
export async function waitForUi(read, predicate, label, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

export async function connectEditorUi(
	requiredSelector,
	port = Number(process.env.BJS_EDITOR_CDP_PORT ?? 8315),
	pagePredicate = 'Boolean(document.body && (document.title.includes("Zvibe Editor") || (location.protocol === "file:" && location.pathname.endsWith("/editor/index.html"))))'
) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	for (const target of targets.filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		let requestId = 1;
		const requests = new Map();
		const runtimeErrors = [];
		const consoleEntries = [];
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined && requests.has(message.id)) {
				requests.get(message.id)(message);
				requests.delete(message.id);
			} else if (message.method === "Runtime.exceptionThrown") {
				runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text);
			} else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
				const entry = message.params.entry;
				const location = entry.url ? ` — ${entry.url}${entry.lineNumber ? `:${entry.lineNumber}` : ""}` : "";
				runtimeErrors.push(`${entry.text}${location}`);
			} else if (message.method === "Runtime.consoleAPICalled") {
				const entry = `${message.params?.type ?? "log"}: ${message.params.args?.map((argument) => argument.value ?? argument.description).join(" ")}`;
				consoleEntries.push(entry);
				if (message.params?.type === "error") runtimeErrors.push(entry);
			}
		});
		const send = (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = requestId++;
				const timer = setTimeout(() => reject(new Error(`Timed out waiting for CDP ${method}.`)), 20_000);
				requests.set(id, (message) => {
					clearTimeout(timer);
					if (message.error) reject(new Error(`CDP ${method} failed: ${JSON.stringify(message.error)}`));
					else resolve(message.result);
				});
				socket.send(JSON.stringify({ id, method, params }));
			});
		const evaluate = async (expression) => {
			const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(`CDP evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
			return result.result.value;
		};
		if (await evaluate(pagePredicate)) {
			await waitForUi(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(requiredSelector)}))`), Boolean, `editor selector ${requiredSelector}`);
			await send("Runtime.enable");
			await send("Log.enable");
			const elementRect = async (selector) => {
				await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:"center",inline:"center"})`);
				await new Promise((resolve) => setTimeout(resolve, 50));
				return evaluate(
					`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)return null; const r=element.getBoundingClientRect(); const x=r.left+r.width/2; const y=r.top+r.height/2; const hit=document.elementFromPoint(x,y); return {x,y,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&(hit===element||element.contains(hit)),disabled:Boolean(element.disabled)}; })()`
				);
			};
			const click = async (selector, button = "left") => {
				const rect = await elementRect(selector);
				if (!rect?.visible || rect.disabled) throw new Error(`UI selector is missing, hidden, or disabled: ${selector}`);
				await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button, clickCount: 1 });
				await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button, clickCount: 1 });
			};
			const clickText = async (text, selector = "button,[role=menuitem],.flexlayout__tab_button", button = "left") => {
				const marker = `data-codex-ui-target-${Date.now().toString(36)}`;
				const found = await evaluate(
					`(() => { const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})]; const element=candidates.find((entry)=>entry.textContent?.trim()===${JSON.stringify(text)} && entry.getBoundingClientRect().width>0 && entry.getBoundingClientRect().height>0); if(!element)return false; element.setAttribute(${JSON.stringify(marker)},""); return true; })()`
				);
				if (!found) throw new Error(`Visible UI text was not found: ${text}`);
				try {
					await click(`[${marker}]`, button);
				} finally {
					await evaluate(`document.querySelector(${JSON.stringify(`[${marker}]`)})?.removeAttribute(${JSON.stringify(marker)})`);
				}
			};
			const setValue = async (selector, value) =>
				evaluate(
					`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)throw new Error("Missing UI selector"); const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,${JSON.stringify(String(value))}); element.dispatchEvent(new Event(element instanceof HTMLSelectElement?"change":"input",{bubbles:true})); return element.value; })()`
				);
			const pressKey = async (key, code = key) => {
				await send("Input.dispatchKeyEvent", { type: "keyDown", key, code });
				await send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
			};
			return { socket, send, evaluate, elementRect, click, clickText, setValue, pressKey, runtimeErrors, consoleEntries };
		}
		socket.close();
	}
	throw new Error(`No matching page containing ${requiredSelector} was found on CDP port ${port}.`);
}
