import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const baseURL = "https://gochat-bfbjkqgc.manus.space";
const cdpPort = 9335;
const outputDir = "/tmp/gochat-published-onboarding-loop-repro";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCDP() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const target = (await response.json()).find((item) => item.type === "page");
      if (target) return target.webSocketDebuggerUrl;
    } catch {
      // Chromium is starting.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for isolated Chromium DevTools");
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const chrome = spawn("/usr/bin/chromium", [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${outputDir}/chromium-profile-${Date.now()}`,
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
    await call("Page.navigate", { url: `${baseURL}/onboarding/?published-loop=${Date.now()}` });
    await sleep(1200);
    const bootstrap = await inspect(`fetch('/api/v1/identity/bootstrap', { method: 'POST', headers: { 'X-GoChat-Integration-Client': 'published-onboarding-loop-' + Date.now() }, credentials: 'same-origin' }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
    if (bootstrap.result.value?.status !== 201) throw new Error(`Production bootstrap failed: ${JSON.stringify(bootstrap.result.value)}`);

    await call("Page.navigate", { url: `${baseURL}/onboarding/?published-loop=${Date.now()}` });
    let checkpoint;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      checkpoint = await inspect(`({ url: location.pathname, text: document.body.innerText, reviewDisabled: [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Review lock'))?.disabled })`);
      if (checkpoint.result.value?.reviewDisabled === false) break;
      await sleep(250);
    }
    if (checkpoint.result.value?.reviewDisabled !== false) throw new Error(`Production username was not available: ${JSON.stringify(checkpoint.result.value)}`);

    await inspect(`[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Review lock'))?.click()`);
    await sleep(120);
    await inspect(`[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Lock username'))?.click()`);
    await sleep(7000);

    const finalState = await inspect(`Promise.all([fetch('/api/v1/onboarding/resume', { credentials: 'same-origin' }).then(async (response) => ({ status: response.status, body: await response.json() })), Promise.resolve({ url: location.pathname, text: document.body.innerText })]).then(([resume, page]) => ({ resume, page }))`);
    const cookies = await call("Network.getAllCookies");
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(`${outputDir}/published-lock.png`, Buffer.from(screenshot.data, "base64"));
    const result = { bootstrap: bootstrap.result.value, checkpoint: checkpoint.result.value, finalState: finalState.result.value, cookies: cookies.cookies, screenshot: `${outputDir}/published-lock.png` };
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
