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

async function connectRealtime(baseURL: string, cookie: string) {
  const socketURL = baseURL.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/api/v1/realtime";
  return await new Promise<WebSocket>((resolve, reject) => {
    const connection = new WebSocket(socketURL, { headers: { Cookie: cookie } });
    connection.once("open", () => resolve(connection));
    connection.once("error", reject);
  });
}

function waitForEvent(socket: WebSocket, matches: (event: Record<string, unknown>) => boolean, description: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${description}`));
    }, 15_000);
    const onMessage = (payload: WebSocket.RawData) => {
      const event = JSON.parse(payload.toString()) as Record<string, unknown>;
      if (!matches(event)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(event);
    };
    socket.on("message", onMessage);
  });
}

integration("cross-instance realtime delivery", () => {
  it("delivers a message written on one instance to a recipient socket on another instance", async () => {
    const first = await bootstrap();
    const second = await bootstrap();
    await lock(first.cookie, first.body.username);
    await lock(second.cookie, second.body.username);
    const session = await openDirect(first, second);
    const socket = await connectRealtime(secondaryURL!, second.cookie);
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

  it("delivers created and resolved private-line request events across instances", async () => {
    const sender = await bootstrap();
    const recipient = await bootstrap();
    await lock(sender.cookie, sender.body.username);
    await lock(recipient.cookie, recipient.body.username);
    const senderSocket = await connectRealtime(primaryURL, sender.cookie);
    const recipientSocket = await connectRealtime(secondaryURL!, recipient.cookie);
    try {
      const createdEvent = waitForEvent(
        recipientSocket,
        (event) => event.type === "request.created",
        "cross-instance private-line request",
      );
      const created = await fetch(`${primaryURL}/api/v1/sessions/discover`, {
        method: "POST",
        headers: { cookie: sender.cookie, "content-type": "application/json" },
        body: JSON.stringify({ username: recipient.body.username }),
      });
      expect(created.status).toBe(202);
      const pending = await created.json() as { requestId: string };
      expect(await createdEvent).toMatchObject({ type: "request.created", requestId: pending.requestId });

      const resolvedEvent = waitForEvent(
        senderSocket,
        (event) => event.type === "request.resolved" && event.requestId === pending.requestId,
        "cross-instance private-line request resolution",
      );
      const accepted = await fetch(`${secondaryURL}/api/v1/requests/${pending.requestId}`, {
        method: "POST",
        headers: { cookie: recipient.cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "accept" }),
      });
      expect(accepted.status).toBe(200);
      const decision = await accepted.json() as { sessionId: string };
      expect(await resolvedEvent).toMatchObject({
        type: "request.resolved",
        requestId: pending.requestId,
        status: "accepted",
        sessionId: decision.sessionId,
      });
    } finally {
      senderSocket.close();
      recipientSocket.close();
    }
  }, 45_000);
});
