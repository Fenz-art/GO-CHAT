import { describe, expect, it } from "vitest";
import WebSocket from "ws";

const primaryURL = process.env.GOCHAT_RUNTIME_URL ?? "http://localhost:3000";
const secondaryURL = process.env.GOCHAT_SECOND_RUNTIME_URL;
const integration = describe.skipIf(process.env.GOCHAT_CROSS_INSTANCE_INTEGRATION !== "1" || !secondaryURL);

type Identity = { username: string; userId: string };

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";")[0];
  if (!value) throw new Error("Expected Go Chat session cookie");
  return value;
}

async function bootstrap() {
  const response = await fetch(`${primaryURL}/api/v1/identity/bootstrap`, { method: "POST" });
  expect(response.status).toBe(201);
  return { cookie: cookieFrom(response), body: await response.json() as Identity };
}

async function lock(cookie: string, username: string) {
  const response = await fetch(`${primaryURL}/api/v1/onboarding/lock`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ username }) });
  expect(response.status).toBe(200);
}

async function openDirect(sender: { cookie: string; body: Identity }, recipient: { cookie: string; body: Identity }) {
  const requested = await fetch(`${primaryURL}/api/v1/sessions/discover`, { method: "POST", headers: { cookie: sender.cookie, "content-type": "application/json" }, body: JSON.stringify({ username: recipient.body.username }) });
  expect(requested.status).toBe(202);
  const pending = await requested.json() as { requestId: string };
  const accepted = await fetch(`${primaryURL}/api/v1/requests/${pending.requestId}`, { method: "POST", headers: { cookie: recipient.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }) });
  expect(accepted.status).toBe(200);
  return await accepted.json() as { sessionId: string };
}

integration("cross-instance realtime delivery", () => {
  it("delivers a message written on one instance to a recipient socket on another instance", async () => {
    const first = await bootstrap();
    const second = await bootstrap();
    await lock(first.cookie, first.body.username);
    await lock(second.cookie, second.body.username);
    const session = await openDirect(first, second);
    const socketURL = secondaryURL!.replace(/^http:\/\/localhost/, "ws://127.0.0.1").replace(/^https:\/\//, "wss://") + "/api/v1/realtime";
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const connection = new WebSocket(socketURL, { headers: { Cookie: second.cookie } });
      connection.once("open", () => resolve(connection));
      connection.once("error", reject);
    });
    try {
      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for cross-instance message")), 15_000);
        socket.on("message", (payload) => {
          const event = JSON.parse(payload.toString()) as Record<string, unknown>;
          if (event.type === "message.created" && event.sessionId === session.sessionId && (event.message as { body?: string } | undefined)?.body === "cross-instance delivery") {
            clearTimeout(timer);
            resolve(event);
          }
        });
      });
      const sent = await fetch(`${primaryURL}/api/v1/sessions/${session.sessionId}/messages`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "cross-instance delivery", clientOperationId: crypto.randomUUID(), kind: "text" }) });
      expect(sent.status).toBe(201);
      expect(await received).toMatchObject({ type: "message.created", sessionId: session.sessionId, message: { body: "cross-instance delivery", senderId: first.body.userId } });
    } finally {
      socket.close();
    }
  }, 45_000);
});
