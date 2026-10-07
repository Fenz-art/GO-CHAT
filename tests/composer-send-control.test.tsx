import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "@/components/conversation-panel";

vi.mock("@/components/voice-note-recorder", () => ({
  VoiceNoteRecorder: ({ onRecord }: { onRecord: (file: File) => void }) => <button type="button" onClick={() => onRecord(new File(["voice"], "sample-voice.webm", { type: "audio/webm" }))}>Queue sample voice</button>,
}));

vi.mock("@/components/conversation-stage-styles", () => ({ ConversationStageStyles: () => null }));
vi.mock("@/components/signal-bloom-motion", () => ({ SignalSignature: () => <span aria-hidden="true" /> }));

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function mockSuccessfulMediaUploads() {
	const uploads: Array<{ headers: Record<string, string>; body: Document | XMLHttpRequestBodyInit | null }> = [];
	class SuccessfulXMLHttpRequest {
		status = 201;
		responseText = "";
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		upload = { onprogress: null as ((event: ProgressEvent<EventTarget>) => void) | null };
		private headers: Record<string, string> = {};
		open() {}
		setRequestHeader(name: string, value: string) { this.headers[name] = value; }
		send(body: Document | XMLHttpRequestBodyInit | null) {
			uploads.push({ headers: this.headers, body });
			const file = body instanceof File ? body : null;
			this.responseText = JSON.stringify({ id: `media-${uploads.length}`, sessionId: "session-1", senderId: "current-user", clientOperationId: this.headers["X-Client-Operation-Id"], cursor: uploads.length, kind: "media", body: "", state: "sent", createdAt: new Date().toISOString(), fileName: file?.name, mimeType: file?.type, byteSize: file?.size, mediaUrl: "https://media.test/upload" });
			queueMicrotask(() => this.onload?.());
		}
	}
	vi.stubGlobal("XMLHttpRequest", SuccessfulXMLHttpRequest);
	return uploads;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function renderComposer(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(<ConversationPanel userId="current-user" discoveryUsername="" requestedSession={{ id: "session-1", username: "peer-handle" }} peerTyping={false} realtimeMessage={null} realtimeRead={null} connectionState="connected" onSessionChange={vi.fn()} onTyping={vi.fn()} />);
}

describe("ConversationPanel composer controls", () => {
	it("sends a plain-text draft when Enter is pressed and retains the visible Send control", async () => {
		const fetchMock = vi.fn((path: string, options?: RequestInit) => {
			if (path.includes("/messages") && options?.method === "POST") return Promise.resolve(json({ id: "sent-message", body: "Send with Enter", senderId: "current-user", state: "sent", createdAt: new Date().toISOString() }));
			if (path.includes("/messages")) return Promise.resolve(json({ items: [] }));
			return Promise.resolve(json({ notificationsEnabled: true }));
		});
    renderComposer(fetchMock);

    const input = await screen.findByRole("textbox", { name: "Message peer-handle" });
    const send = screen.getByRole("button", { name: "Send message and attachments" });
    expect(send).toBeDisabled();

		fireEvent.change(input, { target: { value: "Send with Enter" } });
		fireEvent.submit(input.closest("form")!);

		await waitFor(() => expect(fetchMock.mock.calls.some(([path, options]) => String(path).includes("/messages") && (options as RequestInit | undefined)?.method === "POST")).toBe(true));
		expect(send).toBeDisabled();
  });

	it("commits a queued voice and file selection when Enter is enabled", async () => {
		const uploads = mockSuccessfulMediaUploads();
		const fetchMock = vi.fn((path: string, options?: RequestInit) => {
			if (path.includes("/messages") && options?.method === "POST") return Promise.resolve(json({ id: "queued-selection-message", body: "Send the selection with Enter", senderId: "current-user", state: "sent", createdAt: new Date().toISOString() }));
			return Promise.resolve(json(path.includes("/messages") ? { items: [] } : { notificationsEnabled: true }));
		});
    const { container } = renderComposer(fetchMock);

    await screen.findByRole("textbox", { name: "Message peer-handle" });
    fireEvent.click(screen.getByRole("button", { name: "Queue sample voice" }));
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [new File(["document"], "notes.txt", { type: "text/plain" })] } });

		await waitFor(() => expect(screen.getByLabelText("Attachments ready to send")).toBeInTheDocument());
		expect(screen.getByText("sample-voice.webm")).toBeInTheDocument();
		expect(screen.getByText("notes.txt")).toBeInTheDocument();
		const input = screen.getByRole("textbox", { name: "Message peer-handle" });
		fireEvent.change(input, { target: { value: "Send the selection with Enter" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(fetchMock.mock.calls.some(([path, options]) => String(path).includes("/messages") && (options as RequestInit | undefined)?.method === "POST")).toBe(true));
		expect(uploads).toHaveLength(2);
		expect(uploads.map((upload) => upload.headers["X-File-Name"])).toEqual(["sample-voice.webm", "notes.txt"]);
		expect(screen.getByRole("button", { name: "Send message and attachments" })).toBeDisabled();
	});

	it("keeps failed uploads queued, shows the server error, and retries with the same operation id", async () => {
		const operationIds: string[] = [];
		let attempts = 0;
		class RetryXMLHttpRequest {
			status = 0;
			responseText = "";
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			ontimeout: (() => void) | null = null;
			timeout = 0;
			upload = { onprogress: null as ((event: ProgressEvent<EventTarget>) => void) | null };
			private headers: Record<string, string> = {};
			open() {}
			setRequestHeader(name: string, value: string) { this.headers[name] = value; }
			send(body: Document | XMLHttpRequestBodyInit | null) {
				attempts++;
				operationIds.push(this.headers["X-Client-Operation-Id"]);
				if (attempts === 1) {
					this.status = 415;
					this.responseText = JSON.stringify({ code: "unsupported_media", message: "Upload a supported file whose content matches its type" });
				} else {
					const file = body instanceof File ? body : null;
					this.status = 201;
					this.responseText = JSON.stringify({ id: "media-retried", sessionId: "session-1", senderId: "current-user", clientOperationId: this.headers["X-Client-Operation-Id"], cursor: 1, kind: "media", body: "", state: "sent", createdAt: new Date().toISOString(), fileName: file?.name, mimeType: file?.type, byteSize: file?.size, mediaUrl: "https://media.test/upload" });
				}
				queueMicrotask(() => this.onload?.());
			}
		}
		vi.stubGlobal("XMLHttpRequest", RetryXMLHttpRequest);
		const fetchMock = vi.fn((path: string) => Promise.resolve(json(path.includes("/messages") ? { items: [] } : { notificationsEnabled: true })));
		renderComposer(fetchMock);

		await screen.findByRole("textbox", { name: "Message peer-handle" });
		fireEvent.click(screen.getByRole("button", { name: "Queue sample voice" }));
		fireEvent.click(screen.getByRole("button", { name: "Send message and attachments" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Upload failed (HTTP 415): Upload a supported file whose content matches its type");
		expect(screen.getByLabelText("Attachments ready to send")).toHaveTextContent("sample-voice.webm");
		fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
		await waitFor(() => expect(screen.queryByLabelText("Attachments ready to send")).not.toBeInTheDocument());
		expect(attempts).toBe(2);
		expect(operationIds[1]).toBe(operationIds[0]);
	});

	it("honors a saved disabled Enter preference while retaining the visible Send button", async () => {
		const uploads = mockSuccessfulMediaUploads();
		const fetchMock = vi.fn((path: string, options?: RequestInit) => {
			if (path === "/api/v1/settings") return Promise.resolve(json({ sendOnEnter: false, mediaAutoDownload: "manual" }));
			if (path.includes("/messages") && options?.method === "POST") return Promise.resolve(json({ id: "button-message", body: "Button only", senderId: "current-user", state: "sent", createdAt: new Date().toISOString() }));
			if (path.includes("/messages")) return Promise.resolve(json({ items: [] }));
			return Promise.resolve(json({ notificationsEnabled: true }));
		});
		renderComposer(fetchMock);
		const input = await screen.findByRole("textbox", { name: "Message peer-handle" });
		await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === "/api/v1/settings")).toBe(true));
		fireEvent.change(input, { target: { value: "Button only" } });
		fireEvent.click(screen.getByRole("button", { name: "Queue sample voice" }));
		fireEvent.keyDown(input, { key: "Enter" });
		expect(fetchMock.mock.calls.some(([, options]) => (options as RequestInit | undefined)?.method === "POST")).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Send message and attachments" }));
		await waitFor(() => expect(fetchMock.mock.calls.some(([path, options]) => String(path).includes("/messages") && (options as RequestInit | undefined)?.method === "POST")).toBe(true));
		expect(uploads).toHaveLength(1);
	});

	it("emits typing start while drafting and stops on blur", async () => {
		const onTyping = vi.fn();
		const fetchMock = vi.fn((path: string) => Promise.resolve(json(path.includes("/messages") ? { items: [] } : { notificationsEnabled: true })));
		vi.stubGlobal("fetch", fetchMock);
		render(<ConversationPanel userId="current-user" discoveryUsername="" requestedSession={{ id: "session-1", username: "peer-handle" }} peerTyping={false} realtimeMessage={null} realtimeRead={null} connectionState="connected" onSessionChange={vi.fn()} onTyping={onTyping} />);
		const input = await screen.findByRole("textbox", { name: "Message peer-handle" });
		fireEvent.change(input, { target: { value: "typing now" } });
		expect(onTyping).toHaveBeenCalledWith("typing.start");
		fireEvent.blur(input);
		expect(onTyping).toHaveBeenLastCalledWith("typing.stop");
	});

	it("loads shared media categories from the active private session", async () => {
		const fetchMock = vi.fn((path: string) => {
			if (path.includes("/shared?")) return Promise.resolve(json({ items: [{ id: "asset-1", body: "", createdAt: new Date().toISOString(), kind: "media", fileName: "shared-image.png", mimeType: "image/png", byteSize: 2048, mediaUrl: "https://media.test/shared-image" }], hasMore: false }));
			if (path.includes("/messages")) return Promise.resolve(json({ items: [] }));
			return Promise.resolve(json({ notificationsEnabled: true }));
		});
		renderComposer(fetchMock);
		await screen.findByRole("textbox", { name: "Message peer-handle" });
		fireEvent.click(screen.getByRole("button", { name: "Conversation details" }));
		await waitFor(() => expect(screen.getByText("shared-image.png")).toBeInTheDocument());
		expect(screen.getByRole("tab", { name: "Media" })).toHaveAttribute("aria-selected", "true");
		fireEvent.click(screen.getByRole("tab", { name: "documents" }));
		await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes("category=documents"))).toBe(true));
	});
});
