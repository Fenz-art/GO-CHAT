import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const baseURL = "http://127.0.0.1:3000";
const cdpPort = 9335;
const outputDir = "/tmp/gochat-workspace-visual-repro";
const viewport = process.env.GOCHAT_WORKSPACE_VIEWPORT === "mobile" ? { width: 390, height: 844, mobile: true } : process.env.GOCHAT_WORKSPACE_VIEWPORT === "reported-desktop" ? { width: 1920, height: 1062, mobile: false } : { width: 1440, height: 920, mobile: false };
const realtimeAssertion = process.env.GOCHAT_REALTIME_ASSERT === "1";
const queuedAttachmentAssertion = process.env.GOCHAT_SEND_QUEUE_ASSERT === "1";
const queuedAttachmentEnterAssertion = process.env.GOCHAT_QUEUE_ENTER_ASSERT === "1";
const queuedAttachmentButtonOnlyAssertion = process.env.GOCHAT_QUEUE_BUTTON_ONLY_ASSERT === "1";
const enterSendAssertion = process.env.GOCHAT_ENTER_SEND_ASSERT === "1";
const sharedItemsAssertion = process.env.GOCHAT_SHARED_ITEMS_ASSERT === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  return { response, body };
}

async function requestRetry(path, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request(path, options);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(1_000 * (attempt + 1));
    }
  }
  throw lastError;
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie")?.split(";")[0];
  if (!header) throw new Error("Expected anonymous session cookie");
  const [name, value] = header.split("=");
  return { name, value, header };
}

async function identity(label) {
  const boot = await request("/api/v1/identity/bootstrap", { method: "POST", headers: { "X-GoChat-Integration-Client": `workspace-visual-${label}-${Date.now()}` } });
  const cookie = cookieFrom(boot.response);
  await request("/api/v1/onboarding/lock", { method: "POST", headers: { cookie: cookie.header, "content-type": "application/json" }, body: JSON.stringify({ username: boot.body.username }) });
  return { ...boot.body, cookie };
}

async function waitForCDP() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const target = (await response.json()).find((item) => item.type === "page");
      if (target) return target.webSocketDebuggerUrl;
    } catch {
      // Chromium is still starting.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for isolated Chromium DevTools");
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const [sender, recipient] = await Promise.all([identity("sender"), identity("recipient")]);
  const opened = await request("/api/v1/sessions/discover", { method: "POST", headers: { cookie: sender.cookie.header, "content-type": "application/json" }, body: JSON.stringify({ username: recipient.username }) });
  await request(`/api/v1/requests/${opened.body.requestId}`, { method: "POST", headers: { cookie: recipient.cookie.header, "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }) });
  const session = await request("/api/v1/sessions/discover", { method: "POST", headers: { cookie: sender.cookie.header, "content-type": "application/json" }, body: JSON.stringify({ username: recipient.username }) });
  if (queuedAttachmentButtonOnlyAssertion) await request("/api/v1/settings", { method: "PATCH", headers: { cookie: sender.cookie.header, "content-type": "application/json" }, body: JSON.stringify({ sendOnEnter: false }) });
  if (sharedItemsAssertion) {
    await requestRetry(`/api/v1/sessions/${session.body.id}/media`, { method: "POST", headers: { cookie: sender.cookie.header, "content-type": "text/plain", "x-file-name": encodeURIComponent("shared-visual-proof.txt"), "x-client-operation-id": crypto.randomUUID() }, body: "shared browser document" });
    await request(`/api/v1/sessions/${session.body.id}/messages`, { method: "POST", headers: { cookie: sender.cookie.header, "content-type": "application/json" }, body: JSON.stringify({ body: "https://example.com/go-chat-shared-proof", clientOperationId: crypto.randomUUID(), kind: "text" }) });
  }
  if (!realtimeAssertion && !queuedAttachmentAssertion && !queuedAttachmentEnterAssertion && !queuedAttachmentButtonOnlyAssertion && !enterSendAssertion && !sharedItemsAssertion) {
    await request(`/api/v1/sessions/${session.body.id}/messages`, { method: "POST", headers: { cookie: sender.cookie.header, "content-type": "application/json" }, body: JSON.stringify({ body: "A focused message should not fill the entire conversation row.", clientOperationId: crypto.randomUUID(), kind: "text" }) });
    await request(`/api/v1/sessions/${session.body.id}/messages`, { method: "POST", headers: { cookie: recipient.cookie.header, "content-type": "application/json" }, body: JSON.stringify({ body: "The direct line remains live and readable.", clientOperationId: crypto.randomUUID(), kind: "text" }) });
  }
  const browserIdentity = realtimeAssertion ? recipient : sender;
  const peerUsername = realtimeAssertion ? sender.username : recipient.username;

  const chrome = spawn("/usr/bin/chromium", ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${outputDir}/chromium-profile`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  try {
    const wsURL = await waitForCDP();
    const socket = new (await import("/home/ubuntu/go-chat/node_modules/ws/wrapper.mjs")).default(wsURL);
    let nextID = 1;
    const pending = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = nextID++; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const inspect = (expression) => call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    await call("Page.enable");
    await call("Network.enable");
    await call("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
    await call("Network.setCookie", { name: browserIdentity.cookie.name, value: browserIdentity.cookie.value, url: `${baseURL}/`, path: "/", httpOnly: true, sameSite: "Lax", secure: false });
    await call("Page.navigate", { url: `${baseURL}/?workspace-visual=${Date.now()}` });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const openedSession = await inspect(`(() => { const button = [...document.querySelectorAll('.chat-index__item')].find((item) => item.textContent?.includes('@${peerUsername}')); if (!button) return false; button.click(); return true; })()`);
      if (openedSession.result.value) break;
      await sleep(300);
    }
    if (realtimeAssertion) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = await inspect("Boolean(document.querySelector('.conversation-stage')) && performance.getEntriesByType('navigation').length === 1");
        if (ready.result.value) break;
        await sleep(300);
      }
      await request(`/api/v1/sessions/${session.body.id}/messages`, { method: "POST", headers: { cookie: sender.cookie.header, "content-type": "application/json" }, body: JSON.stringify({ body: "Realtime arrival without browser refresh.", clientOperationId: crypto.randomUUID(), kind: "text" }) });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const arrived = await inspect("document.body.innerText.includes('Realtime arrival without browser refresh.')");
        if (arrived.result.value) break;
        await sleep(300);
      }
    }
    if (queuedAttachmentAssertion || queuedAttachmentEnterAssertion || queuedAttachmentButtonOnlyAssertion) {
      await inspect(`(() => { const input = document.querySelector('input[type="file"]'); if (!input) return false; const data = new DataTransfer(); data.items.add(new File(['queued-by-send-button'], 'send-control.txt', { type: 'text/plain' })); Object.defineProperty(input, 'files', { configurable: true, value: data.files }); input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const queued = await inspect("document.body.innerText.includes('send-control.txt') && document.body.innerText.includes('1 attachment ready to send')");
        if (queued.result.value) break;
        await sleep(250);
      }
      const queuedBeforeSend = await inspect("document.body.innerText.includes('send-control.txt') && !document.querySelector('.conversation-stage__field')?.innerText.includes('send-control.txt')");
      if (!queuedBeforeSend.result.value) throw new Error("Selected file did not remain in the composer queue before Send");
      if (queuedAttachmentEnterAssertion || queuedAttachmentButtonOnlyAssertion) {
        const focused = await inspect(`(() => { const input = document.querySelector('input[aria-label^="Message "]'); if (!input) return false; input.focus(); return document.activeElement === input; })()`);
        if (!focused.result.value) throw new Error("Could not focus the queued-selection input for Enter verification");
        await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      } else {
        await inspect("document.querySelector('[aria-label=\"Send message and attachments\"]')?.click()");
      }
      if (queuedAttachmentButtonOnlyAssertion) {
        await sleep(1200);
        const deliveredWithEnterDisabled = await inspect("document.querySelector('.conversation-stage__field')?.innerText.includes('send-control.txt')");
        if (deliveredWithEnterDisabled.result.value) throw new Error("Enter delivered a queued selection despite the saved button-only preference");
        await inspect("document.querySelector('[aria-label=\"Send message and attachments\"]')?.click()");
      }
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const delivered = await inspect("document.querySelector('.conversation-stage__field')?.innerText.includes('send-control.txt')");
        if (delivered.result.value) break;
        await sleep(500);
      }
    }
    if (sharedItemsAssertion) {
      await inspect("document.querySelector('[aria-label=\"Conversation details\"]')?.click()");
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const open = await inspect("document.body.innerText.includes('Shared items')");
        if (open.result.value) break;
        await sleep(250);
      }
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const mediaSettled = await inspect("!document.body.innerText.includes('Loading shared media…')");
        if (mediaSettled.result.value) break;
        await sleep(300);
      }
      await inspect("[...document.querySelectorAll('[role=\"tab\"]')].find((tab) => tab.textContent?.trim() === 'documents')?.click()");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const loaded = await inspect("document.querySelector('.peer-context__shared')?.getAttribute('data-shared-count') === '1'");
        if (loaded.result.value) break;
        await sleep(300);
      }
      const sharedReady = await inspect("document.querySelector('.peer-context__shared')?.getAttribute('data-shared-count') === '1' && document.querySelector('[role=\"tab\"][aria-selected=\"true\"]')?.textContent?.trim() === 'documents'");
      if (!sharedReady.result.value) {
        const authProbe = await inspect("fetch('/api/v1/onboarding/resume').then(async (response) => ({ status: response.status, body: await response.text() }))");
        const cookieProbe = await inspect("document.cookie");
        const contextProbe = await inspect("document.querySelector('.peer-context')?.innerText || document.body.innerText.slice(-1800)");
        const tabProbe = await inspect("[...document.querySelectorAll('[role=\\\"tab\\\"]')].map((tab) => ({ text: tab.textContent, selected: tab.getAttribute('aria-selected') }))");
        const directSharedProbe = await inspect(`fetch('/api/v1/sessions/${session.body.id}/shared?category=documents&limit=18&offset=0').then(async (response) => ({ status: response.status, body: await response.text() }))`);
        const resourceProbe = await inspect("performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/shared')).slice(-8)");
        throw new Error(`Shared document did not render in the peer context; auth=${JSON.stringify(authProbe.result.value)} cookie=${JSON.stringify(cookieProbe.result.value)} tabs=${JSON.stringify(tabProbe.result.value)} direct=${JSON.stringify(directSharedProbe.result.value)} resources=${JSON.stringify(resourceProbe.result.value)} context=${JSON.stringify(contextProbe.result.value)}`);
      }
    }
    if (enterSendAssertion) {
	      const focused = await inspect(`(() => { const input = document.querySelector('input[aria-label^="Message "]'); if (!input) return false; input.focus(); return document.activeElement === input; })()`);
	      if (!focused.result.value) throw new Error("Could not focus the live message input for Enter-send verification");
	      await call("Input.insertText", { text: "Sent with the Enter key." });
	      for (let attempt = 0; attempt < 20; attempt += 1) {
	        const enabled = await inspect("!document.querySelector('[aria-label=\"Send message and attachments\"]')?.disabled");
	        if (enabled.result.value) break;
	        await sleep(150);
	      }
	      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
	      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const delivered = await inspect("document.querySelector('.conversation-stage__field')?.innerText.includes('Sent with the Enter key.')");
        if (delivered.result.value) break;
        await sleep(300);
      }
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ready = await inspect(realtimeAssertion ? `document.body.innerText.includes('@${peerUsername}') && document.body.innerText.includes('Realtime arrival without browser refresh.') && document.body.innerText.includes('MESSAGE RAIL')` : (queuedAttachmentAssertion || queuedAttachmentEnterAssertion || queuedAttachmentButtonOnlyAssertion) ? `document.body.innerText.includes('@${peerUsername}') && document.querySelector('.conversation-stage__field')?.innerText.includes('send-control.txt') && document.body.innerText.includes('MESSAGE RAIL')` : enterSendAssertion ? `document.body.innerText.includes('@${peerUsername}') && document.querySelector('.conversation-stage__field')?.innerText.includes('Sent with the Enter key.') && document.body.innerText.includes('MESSAGE RAIL')` : `document.body.innerText.includes('@${peerUsername}') && document.body.innerText.includes('A focused message should not fill the entire conversation row.') && document.body.innerText.includes('MESSAGE RAIL')`);
      if (ready.result.value) break;
      await sleep(300);
    }
    const page = await inspect(`(() => { const rect = (selector) => { const node = document.querySelector(selector); if (!node) return null; const box = node.getBoundingClientRect(); return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) }; }; return { url: location.pathname, navigationEntries: performance.getEntriesByType('navigation').length, viewport: { width: innerWidth, height: innerHeight }, hasStage: Boolean(document.querySelector('.conversation-stage')), hasComposer: Boolean(document.querySelector('.message-rail')), receivedRealtimeMessage: document.body.innerText.includes('Realtime arrival without browser refresh.'), deliveredQueuedAttachment: document.querySelector('.conversation-stage__field')?.innerText.includes('send-control.txt'), deliveredEnterMessage: document.querySelector('.conversation-stage__field')?.innerText.includes('Sent with the Enter key.'), outgoingWidth: document.querySelector('.message-row--outgoing > div')?.getBoundingClientRect().width, frame: rect('.workspace-console__frame'), workspace: rect('.chat-workspace'), stage: rect('.conversation-stage'), field: rect('.conversation-stage__field'), composer: rect('.message-rail') }; })()`);
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const screenshotPath = `${outputDir}/${viewport.mobile ? "mobile" : "desktop"}-workspace.png`;
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    const result = { sender: sender.username, recipient: recipient.username, sessionId: session.body.id, realtimeAssertion, queuedAttachmentAssertion, queuedAttachmentEnterAssertion, queuedAttachmentButtonOnlyAssertion, enterSendAssertion, sharedItemsAssertion, page: page.result.value, screenshot: screenshotPath };
    await writeFile(`${outputDir}/result.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    socket.close();
  } finally {
    chrome.kill("SIGTERM");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
