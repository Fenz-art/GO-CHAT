import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const baseURL = "http://127.0.0.1:3000";
const cdpPort = 9334;
const outputDir = "/tmp/gochat-onboarding-loop-repro";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJSON(path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  return { response, body };
}

function cookieFrom(response) {
  const token = response.headers.get("set-cookie")?.split(";")[0];
  if (!token) throw new Error("Anonymous bootstrap did not return a session cookie");
  const [name, value] = token.split("=");
  return { name, value, header: token };
}

async function createCandidate(label) {
  const boot = await fetchJSON("/api/v1/identity/bootstrap", {
    method: "POST",
    headers: { "X-GoChat-Integration-Client": `onboarding-loop-${label}-${Date.now()}` },
  });
  return { ...boot.body, cookie: cookieFrom(boot.response) };
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
  const candidate = await createCandidate("interactive");
  const chrome = spawn("/usr/bin/chromium", [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${outputDir}/chromium-profile`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ], { stdio: "ignore" });

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
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextID++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const inspect = (expression) => call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    await call("Page.enable");
    await call("Network.enable");
    await call("Network.setCookie", { name: candidate.cookie.name, value: candidate.cookie.value, url: `${baseURL}/`, path: "/", httpOnly: true, sameSite: "Lax", secure: false });
    await call("Page.navigate", { url: `${baseURL}/onboarding/?loop-repro=${Date.now()}` });
    await sleep(1500);

    let beforeLock;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      beforeLock = await inspect(`({ url: location.pathname, text: document.body.innerText, button: [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Review lock'))?.disabled })`);
      if (beforeLock.result.value?.button === false) break;
      await sleep(250);
    }
    if (beforeLock.result.value?.button !== false) throw new Error("Username availability did not become ready for the active anonymous identity");
    const review = await inspect(`[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Review lock'))?.click()`);
    await sleep(150);
    const confirm = await inspect(`[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Lock username'))?.click()`);
    await sleep(6500);

    const afterLock = await inspect(`Promise.all([fetch('/api/v1/onboarding/resume', { credentials: 'same-origin' }).then(async (response) => ({ status: response.status, body: await response.json() })), Promise.resolve({ url: location.pathname, text: document.body.innerText })]).then(([resume, page]) => ({ resume, page }))`);
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(`${outputDir}/interactive-lock.png`, Buffer.from(screenshot.data, "base64"));

    const result = {
      candidateUsername: candidate.username,
      beforeLock: beforeLock.result.value,
      reviewTriggered: review.result.value,
      lockTriggered: confirm.result.value,
      afterLock: afterLock.result.value,
      screenshot: `${outputDir}/interactive-lock.png`,
    };
    await writeFile(`${outputDir}/result.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    socket.close();
  } finally {
    chrome.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
