import { describe, expect, it } from "vitest";

import WebSocket from "ws";

const baseURL = process.env.GOCHAT_RUNTIME_URL ?? "http://localhost:3000";
const integration = describe.skipIf(process.env.GOCHAT_INTEGRATION !== "1");
const accountContinuityLimiter = `account-continuity-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const retentionLockLimiter = `retention-lock-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const identityLogoutLimiter = `identity-logout-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

type Bootstrap = { username: string; userId: string };
type Session = { id: string };
type Message = { id: string; body: string; editedAt?: string; state: string; read?: boolean };

const realtimeURL = baseURL.replace(/^http:\/\/localhost/, "ws://127.0.0.1").replace(/^https:\/\//, "wss://") + "/api/v1/realtime";

function connectRealtime(cookie: string, origin?: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(realtimeURL, { headers: { Cookie: cookie }, origin });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForRealtimeEvent(socket: WebSocket, predicate: (event: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket event")), 15_000);
    socket.on("message", (payload) => {
      const event = JSON.parse(payload.toString()) as Record<string, unknown>;
      if (predicate(event)) {
        clearTimeout(timer);
        resolve(event);
      }
    });
  });
}

function cookieFrom(response: Response) {
	const value = response.headers.get("set-cookie")?.split(";")[0];
	if (!value) throw new Error("Expected Go Chat session cookie");
	return value;
}

function accountCookieFrom(response: Response) {
	const match = response.headers.get("set-cookie")?.match(/gochat_account=[^;]+/);
	if (!match) throw new Error("Expected Go Chat account cookie");
	return match[0];
}

async function bootstrap(integrationClient?: string) {
  const response = await fetch(`${baseURL}/api/v1/identity/bootstrap`, { method: "POST", headers: integrationClient ? { "X-GoChat-Integration-Client": integrationClient } : undefined });
  expect(response.status).toBe(201);
  return { body: await response.json() as Bootstrap, cookie: cookieFrom(response) };
}

async function lock(cookie: string, username: string) {
  const response = await fetch(`${baseURL}/api/v1/onboarding/lock`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ username }) });
  expect(response.status).toBe(200);
}

async function openDirect(sender: { cookie: string; body: Bootstrap }, recipient: { cookie: string; body: Bootstrap }) {
  const requested = await fetch(`${baseURL}/api/v1/sessions/discover`, { method: "POST", headers: { cookie: sender.cookie, "content-type": "application/json" }, body: JSON.stringify({ username: `@${recipient.body.username}` }) });
  expect(requested.status).toBe(202);
  const pending = await requested.json() as { requestId: string; status: string };
  expect(pending).toMatchObject({ requestId: expect.any(String), status: "pending" });
  const accepted = await fetch(`${baseURL}/api/v1/requests/${pending.requestId}`, { method: "POST", headers: { cookie: recipient.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }) });
  expect(accepted.status).toBe(200);
  const resolved = await accepted.json() as { sessionId: string };
  return { id: resolved.sessionId };
}

integration("session discovery integration", () => {
  it("reuses a direct session and rejects a non-participant", async () => {
		const first = await bootstrap();
		const second = await bootstrap();
		const outsider = await bootstrap();
		await lock(first.cookie, first.body.username);
		await lock(second.cookie, second.body.username);
		const resumedFirst = await fetch(`${baseURL}/api/v1/onboarding/resume`, { headers: { cookie: first.cookie } });
		expect(resumedFirst.status).toBe(200);
		expect(await resumedFirst.json()).toMatchObject({ completed: true, username: first.body.username, userId: first.body.userId });

		const requested = await fetch(`${baseURL}/api/v1/sessions/discover`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ username: second.body.username }) });
    expect(requested.status).toBe(202);
    const pending = await requested.json() as { requestId: string; status: string };
    expect(pending).toMatchObject({ requestId: expect.any(String), status: "pending" });
    const beforeAcceptance = await fetch(`${baseURL}/api/v1/sessions`, { headers: { cookie: first.cookie } });
    expect(await beforeAcceptance.json()).toEqual([]);
    const incoming = await fetch(`${baseURL}/api/v1/requests`, { headers: { cookie: second.cookie } });
    expect(await incoming.json()).toMatchObject({ items: [expect.objectContaining({ id: pending.requestId, username: first.body.username, status: "pending" })] });
    const accepted = await fetch(`${baseURL}/api/v1/requests/${pending.requestId}`, { method: "POST", headers: { cookie: second.cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }) });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as { sessionId: string };
    const firstSession: Session = { id: acceptedBody.sessionId };
    const reopened = await fetch(`${baseURL}/api/v1/sessions/discover`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ username: second.body.username }) });
    expect(reopened.status).toBe(200);
    expect((await reopened.json() as Session).id).toBe(firstSession.id);

		const protectedResponse = await fetch(`${baseURL}/api/v1/sessions/${firstSession.id}/messages`, { headers: { cookie: outsider.cookie } });
		expect(protectedResponse.status).toBe(403);
	}, 20_000);

	it("permits only participants to edit, acknowledge, and delete their own messages", async () => {
		const first = await bootstrap();
		const second = await bootstrap();
		const outsider = await bootstrap();
		await lock(first.cookie, first.body.username);
		await lock(second.cookie, second.body.username);

		const session = await openDirect(first, second);

		const sent = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "Original message", clientOperationId: crypto.randomUUID(), kind: "text" }) });
		expect(sent.status).toBe(201);
		const message = await sent.json() as Message;

		const outsiderEdit = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages/${message.id}`, { method: "PATCH", headers: { cookie: outsider.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "Attempted edit" }) });
		expect(outsiderEdit.status).toBe(403);

		const edited = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages/${message.id}`, { method: "PATCH", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "Edited message" }) });
		expect(edited.status).toBe(200);
		expect(await edited.json()).toMatchObject({ id: message.id, body: "Edited message" });

		const recipientMessages = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { headers: { cookie: second.cookie } });
		expect(recipientMessages.status).toBe(200);
		const delivered = await recipientMessages.json() as { items: Message[] };
		expect(delivered.items.find((item) => item.id === message.id)).toMatchObject({ state: "delivered" });

		const receipt = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages/${message.id}/read`, { method: "POST", headers: { cookie: second.cookie } });
		expect(receipt.status).toBe(200);

		const refreshed = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { headers: { cookie: first.cookie } });
		expect(refreshed.status).toBe(200);
		const listed = await refreshed.json() as { items: Message[] };
		expect(listed.items.find((item) => item.id === message.id)).toMatchObject({ body: "Edited message", state: "read", read: true });

		const deleted = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages/${message.id}`, { method: "DELETE", headers: { cookie: first.cookie } });
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ id: message.id, state: "deleted" });
	}, 30_000);

	it("applies private conversation controls and prevents new discovery after a block", async () => {
		const first = await bootstrap();
		const second = await bootstrap();
		await lock(first.cookie, first.body.username);
		await lock(second.cookie, second.body.username);

		const session = await openDirect(first, second);

		const muted = await fetch(`${baseURL}/api/v1/sessions/${session.id}/mute`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ durationMinutes: 60 }) });
		expect(muted.status).toBe(200);
		expect(await muted.json()).toMatchObject({ sessionId: session.id, muted: true, durationMinutes: 60 });

		const notificationsDisabled = await fetch(`${baseURL}/api/v1/sessions/${session.id}/notifications`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
		expect(notificationsDisabled.status).toBe(200);
		expect(await notificationsDisabled.json()).toMatchObject({ sessionId: session.id, notificationsEnabled: false });
		const notificationsRead = await fetch(`${baseURL}/api/v1/sessions/${session.id}/notifications`, { headers: { cookie: first.cookie } });
		expect(notificationsRead.status).toBe(200);
		expect(await notificationsRead.json()).toMatchObject({ sessionId: session.id, notificationsEnabled: false });

		const reported = await fetch(`${baseURL}/api/v1/sessions/${session.id}/report`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ reason: "Unwanted contact" }) });
		expect(reported.status).toBe(201);

		const blocked = await fetch(`${baseURL}/api/v1/sessions/${session.id}/block`, { method: "POST", headers: { cookie: first.cookie } });
		expect(blocked.status).toBe(200);
		expect(await blocked.json()).toMatchObject({ sessionId: session.id, blocked: true });

		const reverseDiscovery = await fetch(`${baseURL}/api/v1/sessions/discover`, { method: "POST", headers: { cookie: second.cookie, "content-type": "application/json" }, body: JSON.stringify({ username: first.body.username }) });
		expect(reverseDiscovery.status).toBe(403);
	}, 30_000);

	it("searches discoverable peers and the caller's own conversation messages", async () => {
		const first = await bootstrap();
		const second = await bootstrap();
		await lock(first.cookie, first.body.username);
		await lock(second.cookie, second.body.username);

		const userSearch = await fetch(`${baseURL}/api/v1/search?q=${encodeURIComponent(`@${first.body.username}`)}&type=users`, { headers: { cookie: second.cookie } });
		expect(userSearch.status).toBe(200);
		expect(await userSearch.json()).toMatchObject({ items: [{ kind: "user", username: first.body.username }] });

		const session = await openDirect(first, second);
		const sent = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "constellation search proof", clientOperationId: crypto.randomUUID(), kind: "text" }) });
		expect(sent.status).toBe(201);

		const messageSearch = await fetch(`${baseURL}/api/v1/search?q=constellation&type=messages`, { headers: { cookie: second.cookie } });
		expect(messageSearch.status).toBe(200);
				expect(await messageSearch.json()).toMatchObject({ items: [{ kind: "message", username: first.body.username, body: "constellation search proof" }] });
				const today = new Date().toISOString().slice(0, 10);
				const sessionSearch = await fetch(`${baseURL}/api/v1/sessions/${session.id}/search?q=constellation&from=${today}&to=${today}`, { headers: { cookie: second.cookie } });
				expect(sessionSearch.status).toBe(200);
				expect(await sessionSearch.json()).toMatchObject({ items: [{ body: "constellation search proof", sessionId: session.id }] });
				const secondSent = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "constellation pagination proof", clientOperationId: crypto.randomUUID(), kind: "text" }) });
				expect(secondSent.status).toBe(201);
				const firstPage = await fetch(`${baseURL}/api/v1/sessions/${session.id}/search?q=constellation&limit=1&offset=0`, { headers: { cookie: second.cookie } });
				expect(await firstPage.json()).toMatchObject({ items: [{ body: "constellation pagination proof" }], hasMore: true, offset: 0, limit: 1 });
				const nextPage = await fetch(`${baseURL}/api/v1/sessions/${session.id}/search?q=constellation&limit=1&offset=1`, { headers: { cookie: second.cookie } });
				expect(await nextPage.json()).toMatchObject({ items: [{ body: "constellation search proof" }], offset: 1, limit: 1 });
				const terminalPage = await fetch(`${baseURL}/api/v1/sessions/${session.id}/search?q=constellation&limit=1&offset=2`, { headers: { cookie: second.cookie } });
				expect(await terminalPage.json()).toMatchObject({ items: [], hasMore: false, offset: 2, limit: 1 });
			}, 30_000);

		it("uploads a media attachment once and fans it out to an open recipient", async () => {
			const first = await bootstrap();
			const second = await bootstrap();
			await lock(first.cookie, first.body.username);
			await lock(second.cookie, second.body.username);
			const session = await openDirect(first, second);
			const recipientSocket = await connectRealtime(second.cookie);
			const operation = crypto.randomUUID();
			const mediaEvent = waitForRealtimeEvent(recipientSocket, (event) => event.type === "message.created" && event.sessionId === session.id && (event.message as { kind?: string; fileName?: string } | undefined)?.kind === "media" && (event.message as { fileName?: string } | undefined)?.fileName === "media-check.txt");
			const uploaded = await fetch(`${baseURL}/api/v1/sessions/${session.id}/media`, { method: "POST", headers: { cookie: first.cookie, "content-type": "text/plain", "x-file-name": encodeURIComponent("media-check.txt"), "x-client-operation-id": operation }, body: "go-chat-media-check" });
			const uploadedBody = await uploaded.text();
			expect(uploaded.status, uploadedBody).toBe(201);
			const uploadedMessage = JSON.parse(uploadedBody) as { id: string; kind: string; fileName: string; mimeType: string; mediaUrl: string };
			expect(uploadedMessage).toMatchObject({ kind: "media", fileName: "media-check.txt", mimeType: "text/plain" });
			expect(await mediaEvent).toMatchObject({ type: "message.created", sessionId: session.id, message: { id: uploadedMessage.id, kind: "media", fileName: "media-check.txt" } });
			expect(uploadedMessage.mediaUrl).toContain("X-Amz-Signature");
			const downloaded = await fetch(uploadedMessage.mediaUrl);
			expect(downloaded.status).toBe(200);
			expect(await downloaded.text()).toBe("go-chat-media-check");
			const retried = await fetch(`${baseURL}/api/v1/sessions/${session.id}/media`, { method: "POST", headers: { cookie: first.cookie, "content-type": "text/plain", "x-file-name": encodeURIComponent("media-check.txt"), "x-client-operation-id": operation }, body: "go-chat-media-check" });
			expect(retried.status).toBe(201);
			expect(await retried.json()).toMatchObject({ id: uploadedMessage.id });
			recipientSocket.close();
			}, 60_000);

		it("rejects mismatched and unrecognized media before object persistence", async () => {
			const first = await bootstrap();
			const second = await bootstrap();
			await lock(first.cookie, first.body.username);
			await lock(second.cookie, second.body.username);
			const session = await openDirect(first, second);
			const mismatched = await fetch(`${baseURL}/api/v1/sessions/${session.id}/media`, { method: "POST", headers: { cookie: first.cookie, "content-type": "image/png", "x-file-name": "not-an-image.png" }, body: "plain text does not match a PNG" });
			expect(mismatched.status).toBe(415);
			expect(await mismatched.json()).toMatchObject({ code: "unsupported_media" });
			const unrecognized = await fetch(`${baseURL}/api/v1/sessions/${session.id}/media`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/octet-stream", "x-file-name": "unknown.bin" }, body: "MZ\u0090\u0000" });
			expect(unrecognized.status).toBe(415);
			expect(await unrecognized.json()).toMatchObject({ code: "unsupported_media" });
		}, 30_000);

			it("lists shared media, documents, and links only for direct-session participants", async () => {
				const first = await bootstrap();
				const second = await bootstrap();
				const outsider = await bootstrap();
				await lock(first.cookie, first.body.username);
				await lock(second.cookie, second.body.username);
				const session = await openDirect(first, second);
				const uploaded = await fetch(`${baseURL}/api/v1/sessions/${session.id}/media`, { method: "POST", headers: { cookie: first.cookie, "content-type": "text/plain", "x-file-name": encodeURIComponent("shared-proof.txt"), "x-client-operation-id": crypto.randomUUID() }, body: "shared document proof" });
				expect(uploaded.status, await uploaded.clone().text()).toBe(201);
				const sent = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { method: "POST", headers: { cookie: second.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "https://example.com/shared-proof", clientOperationId: crypto.randomUUID(), kind: "text" }) });
				expect(sent.status).toBe(201);
				const documents = await fetch(`${baseURL}/api/v1/sessions/${session.id}/shared?category=documents`, { headers: { cookie: second.cookie } });
				expect(documents.status).toBe(200);
				expect(await documents.json()).toMatchObject({ category: "documents", items: [expect.objectContaining({ fileName: "shared-proof.txt", mimeType: "text/plain", mediaUrl: expect.stringContaining("X-Amz-Signature") })] });
				const links = await fetch(`${baseURL}/api/v1/sessions/${session.id}/shared?category=links`, { headers: { cookie: first.cookie } });
				expect(links.status).toBe(200);
				expect(await links.json()).toMatchObject({ category: "links", items: [expect.objectContaining({ kind: "link", body: "https://example.com/shared-proof" })] });
				const denied = await fetch(`${baseURL}/api/v1/sessions/${session.id}/shared?category=media`, { headers: { cookie: outsider.cookie } });
				expect(denied.status).toBe(403);
			}, 60_000);

			it("rejects a cross-origin WebSocket upgrade", async () => {
			const identity = await bootstrap();
			await expect(connectRealtime(identity.cookie, "https://untrusted.example")).rejects.toBeTruthy();
		}, 20_000);

		it("allocates distinct durable cursors for concurrent messages", async () => {
			const first = await bootstrap();
			const second = await bootstrap();
			await lock(first.cookie, first.body.username);
			await lock(second.cookie, second.body.username);
			const session = await openDirect(first, second);
			const [left, right] = await Promise.all(["left cursor", "right cursor"].map((body) => fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ body, clientOperationId: crypto.randomUUID(), kind: "text" }) })));
		expect(left.status, await left.clone().text()).toBe(201);
		expect(right.status, await right.clone().text()).toBe(201);
			const [leftMessage, rightMessage] = await Promise.all([left.json() as Promise<{ cursor: number }>, right.json() as Promise<{ cursor: number }>]);
			expect(leftMessage.cursor).not.toBe(rightMessage.cursor);
		}, 30_000);

		it("reads and updates privacy and interaction settings", async () => {
			const first = await bootstrap();
			const initial = await fetch(`${baseURL}/api/v1/settings`, { headers: { cookie: first.cookie } });
			expect(initial.status).toBe(200);
			expect(await initial.json()).toMatchObject({ theme: "system", sendOnEnter: true, readReceipts: true });
			const usage = await fetch(`${baseURL}/api/v1/storage/usage`, { headers: { cookie: first.cookie } });
			expect(usage.status).toBe(200);
			expect(await usage.json()).toMatchObject({ usedBytes: 0, fileCount: 0, maxBytes: 524288000 });
			const updated = await fetch(`${baseURL}/api/v1/settings`, { method: "PATCH", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ theme: "dark", reducedMotion: true, sendOnEnter: false, presenceVisibility: "nobody", readReceipts: false, notifications: false }) });
			expect(updated.status).toBe(200);
			expect(await updated.json()).toMatchObject({ theme: "dark", reducedMotion: true, sendOnEnter: false, presenceVisibility: "nobody", readReceipts: false, notifications: false });
			}, 30_000);

			it("fans out typing indicators and read receipts over authenticated WebSockets", async () => {
				const first = await bootstrap();
				const second = await bootstrap();
				await lock(first.cookie, first.body.username);
				await lock(second.cookie, second.body.username);
				const session = await openDirect(first, second);
				const socketURL = baseURL.replace(/^http:\/\/localhost/, "ws://127.0.0.1").replace(/^https:\/\//, "wss://") + "/api/v1/realtime";
				const connect = (cookie: string) => new Promise<WebSocket>((resolve, reject) => { const socket = new WebSocket(socketURL, { headers: { Cookie: cookie } }); socket.once("open", () => resolve(socket)); socket.once("error", reject); });
				const [firstSocket, secondSocket] = await Promise.all([connect(first.cookie), connect(second.cookie)]);
				const waitFor = (socket: WebSocket, predicate: (event: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket event")), 15_000); socket.on("message", (payload) => { const event = JSON.parse(payload.toString()) as Record<string, unknown>; if (predicate(event)) { clearTimeout(timer); resolve(event); } }); });
				try {
					const typingEvent = waitFor(secondSocket, (event) => event.type === "typing.start" && event.sessionId === session.id);
					const typingInterval = setInterval(() => firstSocket.send(JSON.stringify({ type: "typing.start", sessionId: session.id })), 500);
					firstSocket.send(JSON.stringify({ type: "typing.start", sessionId: session.id }));
					expect(await typingEvent).toMatchObject({ type: "typing.start", sessionId: session.id, senderId: first.body.userId });
					clearInterval(typingInterval);
					const incomingMessage = waitFor(secondSocket, (event) => event.type === "message.created" && event.sessionId === session.id && (event.message as { body?: string } | undefined)?.body === "receipt over websocket");
					const sent = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "receipt over websocket", clientOperationId: crypto.randomUUID(), kind: "text" }) });
					expect(sent.status).toBe(201);
					const message = await sent.json() as Message;
					expect(await incomingMessage).toMatchObject({ type: "message.created", sessionId: session.id, message: { id: message.id, body: "receipt over websocket", senderId: first.body.userId } });
					const readEvent = waitFor(firstSocket, (event) => event.type === "message.read" && event.messageId === message.id);
					const receipt = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages/${message.id}/read`, { method: "POST", headers: { cookie: second.cookie } });
					expect(receipt.status).toBe(200);
					expect(await readEvent).toMatchObject({ type: "message.read", sessionId: session.id, messageId: message.id, readBy: second.body.userId });
				} finally { firstSocket.close(); secondSocket.close(); }
			}, 30_000);

		it("reads and updates anonymous profile status and protects avatar uploads", async () => {
			const first = await bootstrap();
				const initial = await fetch(`${baseURL}/api/v1/profile`, { headers: { cookie: first.cookie } });
				expect(initial.status).toBe(200);
				expect(await initial.json()).toMatchObject({ username: first.body.username, statusMessage: "", avatarUrl: "" });
				const updated = await fetch(`${baseURL}/api/v1/profile`, { method: "PATCH", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ statusMessage: "Available for a private chat" }) });
				expect(updated.status).toBe(200);
				expect(await updated.json()).toMatchObject({ statusMessage: "Available for a private chat" });
				const invalidAvatar = await fetch(`${baseURL}/api/v1/profile/avatar`, { method: "POST", headers: { cookie: first.cookie, "content-type": "text/plain" }, body: "not-an-image" });
				expect(invalidAvatar.status).toBe(415);
				const removed = await fetch(`${baseURL}/api/v1/profile/avatar`, { method: "DELETE", headers: { cookie: first.cookie } });
				expect(removed.status).toBe(200);
			expect(await removed.json()).toMatchObject({ avatarUrl: "" });
		}, 20_000);

		it("applies privacy policy controls and exposes a bounded data-rights center", async () => {
			const first = await bootstrap();
			const initial = await fetch(`${baseURL}/api/v1/settings`, { headers: { cookie: first.cookie } });
			expect(initial.status).toBe(200);
			expect(await initial.json()).toMatchObject({ avatarVisibility: "direct_contacts", statusVisibility: "direct_contacts", notificationPreview: "sender", mediaAutoDownload: "manual", linkPreviewsEnabled: false, privacyCheckupCompleted: false });

			const updated = await fetch(`${baseURL}/api/v1/settings`, { method: "PATCH", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ presenceVisibility: "direct_contacts", avatarVisibility: "nobody", statusVisibility: "direct_contacts", notificationPreview: "none", notificationSound: false, quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "08:00", mediaAutoDownload: "never", linkPreviewsEnabled: false, privacyCheckupComplete: true }) });
			expect(updated.status).toBe(200);
			expect(await updated.json()).toMatchObject({ presenceVisibility: "direct_contacts", avatarVisibility: "nobody", statusVisibility: "direct_contacts", notificationPreview: "none", notificationSound: false, quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "08:00", mediaAutoDownload: "never", linkPreviewsEnabled: false, privacyCheckupCompleted: true });

			const exportResponse = await fetch(`${baseURL}/api/v1/data/export`, { headers: { cookie: first.cookie } });
			expect(exportResponse.status).toBe(200);
			expect(exportResponse.headers.get("content-disposition")).toContain("go-chat-data-export.json");
			expect(await exportResponse.json()).toMatchObject({ messages: [], media: [], notice: expect.stringContaining("never includes signed file URLs") });

			const unconfirmed = await fetch(`${baseURL}/api/v1/data/deletion-requests`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ confirm: "delete" }) });
			expect(unconfirmed.status).toBe(400);
			const submitted = await fetch(`${baseURL}/api/v1/data/deletion-requests`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ confirm: "DELETE MY DATA" }) });
			expect(submitted.status).toBe(201);
			expect(await submitted.json()).toMatchObject({ kind: "deletion", status: "submitted", referenceCode: expect.stringMatching(/^DATA-/) });
			const history = await fetch(`${baseURL}/api/v1/data/deletion-requests`, { headers: { cookie: first.cookie } });
			expect(history.status).toBe(200);
			expect(await history.json()).toMatchObject({ items: [expect.objectContaining({ kind: "deletion", status: "submitted" })] });
		}, 30_000);

		it("applies per-session retention and requires an account-password recheck for a local chat lock", async () => {
			const first = await bootstrap();
			const second = await bootstrap();
			await lock(first.cookie, first.body.username);
			await lock(second.cookie, second.body.username);
			const session = await openDirect(first, second);
			const retention = await fetch(`${baseURL}/api/v1/sessions/${session.id}/retention`, { method: "PATCH", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ policy: "24h" }) });
			expect(retention.status).toBe(200);
			expect(await retention.json()).toMatchObject({ policy: "24h" });
			const sent = await fetch(`${baseURL}/api/v1/sessions/${session.id}/messages`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "retention lifecycle proof", clientOperationId: crypto.randomUUID(), kind: "text" }) });
			expect(sent.status).toBe(201);
			expect(await sent.json()).toMatchObject({ body: "retention lifecycle proof", expiresAt: expect.any(String) });

			const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
			const username = `lock${suffix}`;
			const created = await fetch(`${baseURL}/api/v1/account`, { method: "POST", headers: { cookie: first.cookie, "content-type": "application/json", "X-GoChat-Integration-Client": retentionLockLimiter }, body: JSON.stringify({ username, email: `${username}@example.test`, password: "release-c-password" }) });
			expect(created.status).toBe(201);
			const linkedBrowserCookie = cookieFrom(created);
			const linkedAccountCookie = accountCookieFrom(created);
			const linkedCookies = `${linkedBrowserCookie}; ${linkedAccountCookie}`;
			const locked = await fetch(`${baseURL}/api/v1/sessions/${session.id}/lock`, { method: "POST", headers: { cookie: linkedCookies, "content-type": "application/json" }, body: JSON.stringify({ password: "release-c-password" }) });
			expect(locked.status).toBe(200);
			expect(await locked.json()).toMatchObject({ sessionId: session.id, localLocked: true });
			const listed = await fetch(`${baseURL}/api/v1/sessions`, { headers: { cookie: linkedBrowserCookie } });
			expect(listed.status).toBe(200);
			expect(await listed.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: session.id, retentionPolicy: "24h", localLocked: true })]));
			const rejectedUnlock = await fetch(`${baseURL}/api/v1/sessions/${session.id}/unlock`, { method: "POST", headers: { cookie: linkedCookies, "content-type": "application/json" }, body: JSON.stringify({ password: "not-the-account-password" }) });
			expect(rejectedUnlock.status).toBe(401);
			const unlocked = await fetch(`${baseURL}/api/v1/sessions/${session.id}/unlock`, { method: "POST", headers: { cookie: linkedCookies, "content-type": "application/json" }, body: JSON.stringify({ password: "release-c-password" }) });
			expect(unlocked.status).toBe(200);
			expect(await unlocked.json()).toMatchObject({ sessionId: session.id, localLocked: false });
		}, 45_000);

		it("preserves the linked anonymous identity through account creation, sign-out, and password sign-in", async () => {
			const anonymous = await bootstrap();
			await lock(anonymous.cookie, anonymous.body.username);
			const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
			const username = `account${suffix}`;
			const email = `${username}@example.test`;
			const password = "release-a-password";
			const created = await fetch(`${baseURL}/api/v1/account`, { method: "POST", headers: { cookie: anonymous.cookie, "content-type": "application/json", "X-GoChat-Integration-Client": accountContinuityLimiter }, body: JSON.stringify({ username, email, password }) });
			expect(created.status).toBe(201);
			expect(await created.clone().json()).toMatchObject({ username, email, linkedIdentity: anonymous.body.userId });
			const createdAccountCookie = accountCookieFrom(created);

			const current = await fetch(`${baseURL}/api/v1/account`, { headers: { cookie: createdAccountCookie } });
			expect(current.status).toBe(200);
			expect(await current.json()).toMatchObject({ username, linkedIdentity: anonymous.body.userId });
			const sessions = await fetch(`${baseURL}/api/v1/account/sessions`, { headers: { cookie: createdAccountCookie } });
			expect(sessions.status).toBe(200);
			expect(await sessions.json()).toMatchObject({ items: [expect.objectContaining({ id: expect.any(String) })] });

			const signedOut = await fetch(`${baseURL}/api/v1/account/logout`, { method: "POST", headers: { cookie: createdAccountCookie } });
			expect(signedOut.status).toBe(200);
			expect(await signedOut.json()).toEqual({ signedOut: true, anonymousIdentityPreserved: true });

			const signedIn = await fetch(`${baseURL}/api/v1/account/login`, { method: "POST", headers: { "content-type": "application/json", "X-GoChat-Integration-Client": accountContinuityLimiter }, body: JSON.stringify({ identifier: email, password }) });
			expect(signedIn.status).toBe(200);
			const signedInAccountCookie = accountCookieFrom(signedIn);
			const resumed = await fetch(`${baseURL}/api/v1/account`, { headers: { cookie: signedInAccountCookie } });
			expect(resumed.status).toBe(200);
			expect(await resumed.json()).toMatchObject({ username, linkedIdentity: anonymous.body.userId });
		}, 30_000);

		it("revokes one account session and its linked browser identity without affecting another session", async () => {
			const anonymous = await bootstrap(accountContinuityLimiter);
			await lock(anonymous.cookie, anonymous.body.username);
			const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
			const username = `revoke${suffix}`;
			const email = `${username}@example.test`;
			const password = "session-revocation-password";
			const created = await fetch(`${baseURL}/api/v1/account`, { method: "POST", headers: { cookie: anonymous.cookie, "content-type": "application/json", "X-GoChat-Integration-Client": accountContinuityLimiter }, body: JSON.stringify({ username, email, password }) });
			expect(created.status).toBe(201);
			const firstBrowserCookie = cookieFrom(created);
			const firstAccountCookie = accountCookieFrom(created);
			const firstSessionsResponse = await fetch(`${baseURL}/api/v1/account/sessions`, { headers: { cookie: firstAccountCookie } });
			const firstSessions = await firstSessionsResponse.json() as { items: Array<{ id: string }> };
			expect(firstSessions.items).toHaveLength(1);

			const secondLogin = await fetch(`${baseURL}/api/v1/account/login`, { method: "POST", headers: { "content-type": "application/json", "X-GoChat-Integration-Client": accountContinuityLimiter }, body: JSON.stringify({ identifier: email, password }) });
			expect(secondLogin.status).toBe(200);
			const secondAccountCookie = accountCookieFrom(secondLogin);
			const secondBrowserCookie = cookieFrom(secondLogin);
			const active = await fetch(`${baseURL}/api/v1/account/sessions`, { headers: { cookie: secondAccountCookie } });
			const activeSessions = await active.json() as { items: Array<{ id: string; isCurrent: boolean }> };
			expect(activeSessions.items).toHaveLength(2);
			expect(activeSessions.items.filter((session) => session.isCurrent)).toHaveLength(1);

			const oldSession = activeSessions.items.find((session) => !session.isCurrent)!;
			const revoked = await fetch(`${baseURL}/api/v1/account/sessions/${oldSession.id}`, { method: "DELETE", headers: { cookie: secondAccountCookie } });
			expect(revoked.status).toBe(200);
			expect(await revoked.json()).toMatchObject({ revoked: true, currentSession: false });
			const oldIdentity = await fetch(`${baseURL}/api/v1/onboarding/resume`, { headers: { cookie: firstBrowserCookie } });
			expect(oldIdentity.status).toBe(401);
			const currentIdentity = await fetch(`${baseURL}/api/v1/onboarding/resume`, { headers: { cookie: secondBrowserCookie } });
			expect(currentIdentity.status).toBe(200);
		}, 30_000);

		it("revokes both browser-backed sessions when the anonymous identity is signed out", async () => {
			const anonymous = await bootstrap(identityLogoutLimiter);
			await lock(anonymous.cookie, anonymous.body.username);
			const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
			const username = `logout${suffix}`;
			const created = await fetch(`${baseURL}/api/v1/account`, { method: "POST", headers: { cookie: anonymous.cookie, "content-type": "application/json", "X-GoChat-Integration-Client": identityLogoutLimiter }, body: JSON.stringify({ username, email: `${username}@example.test`, password: "identity-logout-password" }) });
			expect(created.status).toBe(201);
			const browserCookie = cookieFrom(created);
			const accountCookie = accountCookieFrom(created);

			const signedOut = await fetch(`${baseURL}/api/v1/identity/logout`, { method: "POST", headers: { cookie: `${browserCookie}; ${accountCookie}` } });
			expect(signedOut.status).toBe(200);
			expect(await signedOut.json()).toEqual({ signedOut: "identity", accountSessionCleared: true, dataDeleted: false });

			const identityAfterExit = await fetch(`${baseURL}/api/v1/onboarding/resume`, { headers: { cookie: browserCookie } });
			expect(identityAfterExit.status).toBe(401);
			const accountAfterExit = await fetch(`${baseURL}/api/v1/account`, { headers: { cookie: accountCookie } });
			expect(accountAfterExit.status).toBe(401);
		}, 30_000);
		});
