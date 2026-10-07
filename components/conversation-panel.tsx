"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { VoiceNoteRecorder } from "@/components/voice-note-recorder";
import { SignalSignature } from "@/components/signal-bloom-motion";
import { ConversationStageStyles } from "@/components/conversation-stage-styles";
import { applyReadReceipt, filterMessageHistory, mergeRealtimeMessage } from "@/shared/chat-state";
import { receiptSignalState } from "@/shared/signal-bloom";
import { messageDayKey, startsMessageDay, startsPeerMessageGroup } from "@/shared/conversation-presentation";
import { expiryLabel, expiryState } from "@/shared/retention-presentation";
import { Archive, ArrowUp, AtSign, Bell, BellOff, Check, CheckCheck, ChevronLeft, ChevronRight, Clock3, Download, FileText, Flag, Image as ImageIcon, Link2, Loader2, LockKeyhole, MessageCircleMore, MoreHorizontal, PanelRightOpen, Paperclip, Pencil, Radio, RefreshCw, RotateCcw, Search, ShieldBan, Trash2, X } from "lucide-react";

type Message = {
  id: string;
  body: string;
  senderId: string;
  state: string;
  createdAt: string;
  cursor?: number;
  clientOperationId?: string;
  editedAt?: string;
  deletedAt?: string;
  read?: boolean;
  kind?: string;
  mediaUrl?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  expiresAt?: string;
};

type UploadItem = { id: string; name: string; progress: number; state: "uploading" | "complete" | "failed"; error?: string; file?: File };
type QueuedAttachment = { id: string; name: string; kind: "voice" | "file"; file: File };
type SharedCategory = "media" | "documents" | "links";
type SharedItem = { id: string; body: string; createdAt: string; kind: SharedCategory | "link"; mediaUrl?: string; fileName?: string; mimeType?: string; byteSize?: number };

function formatBytes(value?: number) {
  if (!value || value < 1) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export type ConversationSession = { id: string; username: string; retentionPolicy?: "keep" | "24h" | "7d" | "30d"; localLocked?: boolean };

function HighlightMessage({ value, query }: { value: string; query: string }) {
  if (!query.trim()) return <>{value}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return <>{value.split(new RegExp(`(${escaped})`, "ig")).map((part, index) => part.toLowerCase() === query.toLowerCase() ? <mark key={`${part}-${index}`} className="rounded bg-[var(--plasma)]/70 px-0.5 text-[var(--void)]">{part}</mark> : part)}</>;
}

function messageTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function messageDayLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

export function ConversationPanel({ userId, discoveryUsername, requestedSession, peerTyping, realtimeMessage, realtimeRead, connectionState, onSessionChange, onTyping }: { userId: string; discoveryUsername: string; requestedSession?: ConversationSession | null; peerTyping: boolean; realtimeMessage: { sessionId: string; message: Message } | null; realtimeRead: { sessionId: string; messageId: string; readBy: string } | null; connectionState: "connected" | "reconnecting" | "disconnected"; onSessionChange: (sessionId: string | null, session?: ConversationSession) => void; onTyping: (type: "typing.start" | "typing.stop") => void }) {
  const [username, setUsername] = useState("");
  const [session, setSession] = useState<ConversationSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<{ id: string; username: string } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [searchLensOpen, setSearchLensOpen] = useState(false);
  const [inSessionQuery, setInSessionQuery] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [serverSearchResults, setServerSearchResults] = useState<Message[] | null>(null);
  const [searchPage, setSearchPage] = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const searchPageSize = 25;
  const typingTimerRef = useRef<number | undefined>(undefined);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [queuedAttachments, setQueuedAttachments] = useState<QueuedAttachment[]>([]);
  const [sendingSelection, setSendingSelection] = useState(false);
	  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
	  const [mediaAutoDownload, setMediaAutoDownload] = useState<"always" | "manual" | "never">("manual");
	  const [sendOnEnter, setSendOnEnter] = useState(true);
	  const [revealedMedia, setRevealedMedia] = useState<Set<string>>(() => new Set());
  const [peerContextOpen, setPeerContextOpen] = useState(false);
  const [sharedCategory, setSharedCategory] = useState<SharedCategory>("media");
  const [sharedItems, setSharedItems] = useState<SharedItem[]>([]);
  const [sharedPage, setSharedPage] = useState(0);
  const [sharedHasMore, setSharedHasMore] = useState(false);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [sharedError, setSharedError] = useState("");
  const [localLockPassword, setLocalLockPassword] = useState("");
  const [lockBusy, setLockBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const archiveLensOpenerRef = useRef<HTMLElement | null>(null);
  const peerContextOpenerRef = useRef<HTMLElement | null>(null);
  const sharedRequestRef = useRef(0);

  useEffect(() => { const saved = window.localStorage.getItem("gochat.draft"); if (saved) setBody(saved); }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
	  useEffect(() => { void fetch("/api/v1/settings").then(async (response) => response.ok ? response.json() as Promise<{ mediaAutoDownload?: "always" | "manual" | "never"; sendOnEnter?: boolean }> : null).then((settings) => { if (settings?.mediaAutoDownload) setMediaAutoDownload(settings.mediaAutoDownload); if (typeof settings?.sendOnEnter === "boolean") setSendOnEnter(settings.sendOnEnter); }).catch(() => undefined); }, []);
  useEffect(() => { if (body) window.localStorage.setItem("gochat.draft", body); else window.localStorage.removeItem("gochat.draft"); }, [body]);
  useEffect(() => { if (!realtimeMessage || realtimeMessage.sessionId !== session?.id) return; setMessages((current) => mergeRealtimeMessage(current, realtimeMessage.message)); }, [realtimeMessage, session?.id]);
  useEffect(() => { if (!realtimeRead || realtimeRead.sessionId !== session?.id) return; setMessages((current) => applyReadReceipt(current, realtimeRead.messageId)); }, [realtimeRead, session?.id]);
  useEffect(() => () => { if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current); }, []);
  useEffect(() => {
    if (!searchLensOpen) return;
    archiveLensOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="Search messages by keyword"]')?.focus(), 0);
    return () => { window.clearTimeout(timer); window.requestAnimationFrame(() => archiveLensOpenerRef.current?.focus()); };
  }, [searchLensOpen]);
  useEffect(() => {
    if (!peerContextOpen) return;
    peerContextOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => document.querySelector<HTMLButtonElement>('[aria-label="Close peer context"]')?.focus(), 0);
    const handler = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setPeerContextOpen(false); };
    window.addEventListener("keydown", handler);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", handler); window.requestAnimationFrame(() => peerContextOpenerRef.current?.focus()); };
  }, [peerContextOpen]);
  const loadSharedItems = useCallback(async (category: SharedCategory, page: number) => {
    if (!session) return;
    const requestId = ++sharedRequestRef.current;
    setSharedLoading(true);
    setSharedError("");
    const params = new URLSearchParams({ category, limit: "18", offset: String(page * 18) });
    try {
      const response = await fetch(`/api/v1/sessions/${session.id}/shared?${params.toString()}`);
      if (!response.ok) throw new Error("Could not load shared items");
      const result = await response.json() as { items?: SharedItem[]; hasMore?: boolean };
      if (requestId !== sharedRequestRef.current) return;
      setSharedItems(result.items ?? []);
      setSharedHasMore(Boolean(result.hasMore));
    } catch (cause) {
      if (requestId === sharedRequestRef.current) { setSharedItems([]); setSharedHasMore(false); setSharedError(cause instanceof Error ? cause.message : "Could not load shared items"); }
    } finally {
      if (requestId === sharedRequestRef.current) setSharedLoading(false);
    }
  }, [session?.id]);
  useEffect(() => {
    if (!peerContextOpen || !session) { sharedRequestRef.current += 1; setSharedLoading(false); return; }
    void loadSharedItems(sharedCategory, sharedPage);
  }, [peerContextOpen, session?.id, loadSharedItems]);

  useEffect(() => {
    if (!session || (!inSessionQuery.trim() && !fromDate && !toDate)) { setServerSearchResults(null); setSearchHasMore(false); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(searchPageSize), offset: String(searchPage * searchPageSize) });
    if (inSessionQuery.trim()) params.set("q", inSessionQuery.trim());
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    void fetch(`/api/v1/sessions/${session.id}/search?${params.toString()}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Search failed");
      const result = await response.json() as { items: Message[]; hasMore: boolean };
      setServerSearchResults(result.items);
      setSearchHasMore(result.hasMore);
    }).catch(() => { if (!controller.signal.aborted) { setServerSearchResults([]); setSearchHasMore(false); } });
    return () => controller.abort();
  }, [fromDate, inSessionQuery, searchPage, session?.id, toDate]);

  useEffect(() => { setSearchPage(0); }, [fromDate, inSessionQuery, session?.id, toDate]);
  useEffect(() => { if (!discoveryUsername) return; setUsername(discoveryUsername); setPendingRequest(null); setSession(null); setMessages([]); onSessionChange(null); }, [discoveryUsername, onSessionChange]);

  const recordReadReceipt = useCallback(async (sessionId: string, messageId: string) => { await fetch(`/api/v1/sessions/${sessionId}/messages/${messageId}/read`, { method: "POST" }); }, []);
  const loadMessages = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/v1/sessions/${sessionId}/messages`);
    if (!response.ok) throw new Error("Could not load messages");
    const result = await response.json() as { items: Message[] };
    const newestFirst = result.items;
    setMessages(newestFirst.reverse());
    const unread = newestFirst.filter((item) => item.senderId !== userId && item.state !== "deleted");
    void Promise.all(unread.map((item) => recordReadReceipt(sessionId, item.id))).catch(() => undefined);
  }, [recordReadReceipt, userId]);

  useEffect(() => { if (session && !session.localLocked && connectionState === "connected") void loadMessages(session.id); }, [connectionState, loadMessages, session?.id, session?.localLocked]);
  useEffect(() => {
    if (!requestedSession) return;
    if (requestedSession.id === session?.id) {
      if (requestedSession.localLocked !== session.localLocked || requestedSession.retentionPolicy !== session.retentionPolicy) setSession((current) => current ? { ...current, localLocked: requestedSession.localLocked, retentionPolicy: requestedSession.retentionPolicy } : current);
      return;
    }
    setError("");
    setUsername(requestedSession.username);
    setPendingRequest(null);
    setMessages([]);
    setQueuedAttachments([]);
    setServerSearchResults(null);
    setSession(requestedSession);
    onSessionChange(requestedSession.id, requestedSession);
    void fetch(`/api/v1/sessions/${requestedSession.id}/notifications`).then(async (response) => { if (response.ok) setNotificationsEnabled((await response.json() as { notificationsEnabled: boolean }).notificationsEnabled); });
    if (!requestedSession.localLocked) void loadMessages(requestedSession.id).catch(() => setError("Could not load this private conversation."));
  }, [loadMessages, onSessionChange, requestedSession, session?.id]);

  async function discover() {
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/v1/sessions/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });
      const result = await response.json() as ConversationSession & { requestId?: string; status?: string; username?: string; message?: string };
      if (response.status === 202 && result.requestId && result.status === "pending") {
        setPendingRequest({ id: result.requestId, username: result.username ?? username.trim().replace(/^@/, "") });
        return;
      }
      if (!response.ok) throw new Error(result.message ?? "That username is not available.");
      setSession(result);
      onSessionChange(result.id, result);
      const notifications = await fetch(`/api/v1/sessions/${result.id}/notifications`);
      if (notifications.ok) setNotificationsEnabled((await notifications.json() as { notificationsEnabled: boolean }).notificationsEnabled);
      await loadMessages(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this chat."); } finally { setLoading(false); }
  }

  const deliver = useCallback(async (messageBody: string, clientOperationId = crypto.randomUUID(), retry = false) => {
    if (!session) return;
    setError("");
    const optimistic: Message = { id: clientOperationId, body: messageBody, senderId: userId, clientOperationId, state: "pending", createdAt: new Date().toISOString() };
    if (retry) setMessages((current) => current.map((item) => item.id === clientOperationId ? { ...item, state: "pending" } : item)); else setMessages((current) => [...current, optimistic]);
    const response = await fetch(`/api/v1/sessions/${session.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: messageBody, clientOperationId, kind: "text" }) });
    if (!response.ok) { setMessages((current) => current.map((item) => item.id === clientOperationId ? { ...item, state: "failed" } : item)); setError("Message could not be sent. Retry when connected."); return; }
    const message = await response.json() as Message;
    setMessages((current) => current.map((item) => item.id === clientOperationId ? message : item));
  }, [session, userId]);

  function queueAttachment(file: File, kind: QueuedAttachment["kind"], id = crypto.randomUUID()) {
    setError("");
    setQueuedAttachments((current) => current.some((item) => item.id === id) ? current : [...current, { id, name: file.name, kind, file }]);
  }

  function removeQueuedAttachment(id: string) {
    setQueuedAttachments((current) => current.filter((item) => item.id !== id));
  }

	  async function send() {
    const trimmed = body.trim();
    const attachments = queuedAttachments;
    if ((!trimmed && attachments.length === 0) || !session || sendingSelection) return;
    setSendingSelection(true);
    setError("");
    if (trimmed) {
      setBody("");
      onTyping("typing.stop");
      await deliver(trimmed);
    }
    setQueuedAttachments([]);
    const failed: QueuedAttachment[] = [];
    for (const attachment of attachments) {
      try {
        await uploadMedia(attachment.file, attachment.id);
      } catch {
        failed.push(attachment);
      }
    }
    if (failed.length) {
      setQueuedAttachments((current) => [...failed, ...current]);
      setError(failed.length === 1 ? "Attachment was not sent. It remains queued for Send." : "Some attachments were not sent. They remain queued for Send.");
    }
	    setSendingSelection(false);
	  }

	  useEffect(() => {
	    const submitQueuedSelection = (event: KeyboardEvent) => {
	      if (event.key !== "Enter" || event.shiftKey || event.isComposing || sendingSelection) return;
	      const target = event.target;
	      if (!(target instanceof HTMLInputElement) || target.getAttribute("aria-label") !== `Message ${session?.username ?? ""}`) return;
	      if (!sendOnEnter) {
	        event.preventDefault();
	        return;
	      }
	      if (queuedAttachments.length === 0) return;
	      event.preventDefault();
	      void send();
	    };
	    document.addEventListener("keydown", submitQueuedSelection, true);
	    return () => document.removeEventListener("keydown", submitQueuedSelection, true);
	  }, [body, queuedAttachments.length, sendOnEnter, sendingSelection, session?.id, session?.username]);

	  function uploadMedia(file: File, existingId?: string) {
    if (!session) return Promise.reject(new Error("No active conversation"));
    const uploadId = existingId ?? crypto.randomUUID();
    setUploads((current) => current.some((item) => item.id === uploadId) ? current.map((item) => item.id === uploadId ? { ...item, progress: 0, state: "uploading", error: undefined, file } : item) : [...current, { id: uploadId, name: file.name, progress: 0, state: "uploading", file }]);
    return new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
	      request.open("POST", `/api/v1/sessions/${session.id}/media`);
	      request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
	      request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
	      request.setRequestHeader("X-Client-Operation-Id", uploadId);
      request.upload.onprogress = (event) => { if (event.lengthComputable) setUploads((current) => current.map((item) => item.id === uploadId ? { ...item, progress: Math.round((event.loaded / event.total) * 100) } : item)); };
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          const message = JSON.parse(request.responseText) as Message;
          setMessages((current) => mergeRealtimeMessage(current, message));
          setUploads((current) => current.filter((item) => item.id !== uploadId));
          resolve();
          return;
        }
        setUploads((current) => current.map((item) => item.id === uploadId ? { ...item, state: "failed", error: "Upload failed" } : item));
        reject(new Error("Upload failed"));
      };
      request.onerror = () => {
        setUploads((current) => current.map((item) => item.id === uploadId ? { ...item, state: "failed", error: "Network error" } : item));
        reject(new Error("Network error"));
      };
      request.send(file);
    });
  }

  function mediaPreview(message: Message) {
    if (!message.mediaUrl) return null;
    const canLoad = mediaAutoDownload === "always" || revealedMedia.has(message.id);
    if (!canLoad && mediaAutoDownload === "never") return <a href={message.mediaUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-current/20 px-3 py-2 text-xs font-semibold underline"><FileText className="size-4" />Open attachment in a new tab</a>;
    if (!canLoad) return <button type="button" onClick={() => setRevealedMedia((current) => new Set(current).add(message.id))} className="inline-flex items-center gap-2 rounded-xl border border-current/20 px-3 py-2 text-xs font-semibold"><FileText className="size-4" />Load private preview</button>;
    if (message.mimeType?.startsWith("image/")) return <img src={message.mediaUrl} alt={message.fileName ?? "Shared image"} className="max-h-64 max-w-full rounded-xl object-cover" />;
    if (message.mimeType?.startsWith("video/")) return <video src={message.mediaUrl} controls className="max-h-64 max-w-full rounded-xl" />;
    if (message.mimeType?.startsWith("audio/")) return <audio src={message.mediaUrl} controls className="max-w-full" />;
    return <a href={message.mediaUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline"><FileText className="size-4" />{message.fileName ?? "Open attachment"}</a>;
  }

  async function saveEdit(message: Message) {
    if (!session || !editBody.trim()) return;
    const response = await fetch(`/api/v1/sessions/${session.id}/messages/${message.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: editBody.trim() }) });
    if (!response.ok) { setError("Could not update that message."); return; }
    const updated = await response.json() as Message;
    setMessages((current) => current.map((item) => item.id === message.id ? updated : item));
    setEditingMessageId(null);
    setEditBody("");
  }

  async function removeMessage(message: Message) {
    if (!session || !window.confirm("Delete this message for everyone in this conversation?")) return;
    const response = await fetch(`/api/v1/sessions/${session.id}/messages/${message.id}`, { method: "DELETE" });
    if (!response.ok) { setError("Could not delete that message."); return; }
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, body: "", state: "deleted", deletedAt: new Date().toISOString() } : item));
  }

  async function control(action: "mute" | "archive" | "block" | "report" | "notifications", notificationValue?: boolean) {
    if (!session) return;
    const options: RequestInit = { method: "POST", headers: { "content-type": "application/json" } };
    if (action === "mute") options.body = JSON.stringify({ durationMinutes: 60 });
    if (action === "notifications") options.body = JSON.stringify({ enabled: notificationValue ?? !notificationsEnabled });
    if (action === "report") { const reason = window.prompt("Briefly describe why you are reporting this conversation."); if (!reason) return; options.body = JSON.stringify({ reason }); }
    if (action === "archive" && !window.confirm("Archive this conversation? You can rediscover this peer later.")) return;
    if (action === "block" && !window.confirm("Block this peer? This will archive the conversation and prevent future discovery.")) return;
    const response = await fetch(`/api/v1/sessions/${session.id}/${action}`, options);
    const result = await response.json() as { message?: string };
    if (!response.ok) { setError(result.message ?? `Could not ${action} this conversation.`); return; }
    if (action === "mute") { setError("Notifications are muted for the next hour."); return; }
    if (action === "report") { setError("Your report has been submitted."); return; }
    if (action === "notifications") { setNotificationsEnabled(notificationValue ?? !notificationsEnabled); setError(notificationValue ?? !notificationsEnabled ? "Conversation notifications enabled." : "Conversation notifications disabled."); return; }
    onTyping("typing.stop");
    onSessionChange(null);
    setMessages([]);
    setSession(null);
  }

  async function updateRetention(policy: "keep" | "24h" | "7d" | "30d") {
    if (!session) return;
    const response = await fetch(`/api/v1/sessions/${session.id}/retention`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy }) });
    const result = await response.json() as { policy?: "keep" | "24h" | "7d" | "30d"; message?: string };
    if (!response.ok || !result.policy) { setError(result.message ?? "Could not update retention."); return; }
    const next = { ...session, retentionPolicy: result.policy };
    setSession(next);
    onSessionChange(next.id, next);
    setError(policy === "keep" ? "New messages will be kept until you delete them." : `New messages will expire after ${policy}. Existing messages are unchanged.`);
  }

  async function changeLocalLock(action: "lock" | "unlock") {
    if (!session || !localLockPassword) return;
    setLockBusy(true);
    const response = await fetch(`/api/v1/sessions/${session.id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: localLockPassword }) });
    const result = await response.json() as { localLocked?: boolean; message?: string };
    setLockBusy(false);
    if (!response.ok || typeof result.localLocked !== "boolean") { setError(result.message ?? "Password confirmation failed."); return; }
    const next = { ...session, localLocked: result.localLocked };
    setSession(next);
    onSessionChange(next.id, next);
    setLocalLockPassword("");
    if (!result.localLocked) void loadMessages(next.id).catch(() => setError("Could not restore this private conversation."));
  }

  if (!session) {
    if (pendingRequest) return <motion.section className="direct-stage direct-stage--pending" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} aria-label="Private-line request pending"><div className="direct-stage__intro"><div className="direct-stage__signal"><span /><span /><span /></div><p>PRIVATE-LINE REQUEST</p><h2>Request sent to @{pendingRequest.username}.</h2><div>They control whether this direct line opens. You will not see a conversation or delivery state unless they accept.</div></div><div className="direct-stage__pending-card"><span><MessageCircleMore className="size-4" /></span><div><b>Waiting for a response</b><p>Requests can be accepted, declined, or blocked by the recipient.</p></div></div><button type="button" className="direct-stage__secondary" onClick={() => { setPendingRequest(null); setUsername(""); }}>Request another line</button><div className="direct-stage__facts"><span><Radio className="size-3.5" />{connectionState === "connected" ? "Signal live" : connectionState === "reconnecting" ? "Rejoining signal" : "Signal paused"}</span><span><LockKeyhole className="size-3.5" />Recipient controls access</span></div>{error && <p className="direct-stage__error" role="alert">{error}</p>}</motion.section>;
    return <motion.section className="direct-stage" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} aria-label="Start a private conversation"><div className="direct-stage__intro"><div className="direct-stage__signal"><span /><span /><span /></div><p>DIRECT MESSAGES</p><h2>A private line begins with a handle.</h2><div>Send a one-to-one request when you know the person’s Go Chat username. They decide whether a direct line opens. There are no recommendations, public profiles, or group spaces in this flow.</div></div><form className="direct-stage__command" onSubmit={(event) => { event.preventDefault(); void discover(); }}><label><span>TO</span><AtSign className="size-4" /><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="username" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--subtle)]" aria-label="Username" /></label><button disabled={!username.trim() || loading} type="submit">{loading ? <Loader2 className="size-4 animate-spin" aria-label="Sending private-line request" /> : <>Request line <ArrowUp className="size-4" /></>}</button></form><div className="direct-stage__facts"><span><Radio className="size-3.5" />{connectionState === "connected" ? "Signal live" : connectionState === "reconnecting" ? "Rejoining signal" : "Signal paused"}</span><span><MessageCircleMore className="size-3.5" />One-to-one only</span><span><LockKeyhole className="size-3.5" />Recipient controls access</span></div>{error && <p className="direct-stage__error" role="alert">{error}</p>}</motion.section>;
  }

  if (session.localLocked) {
    return <motion.section key="protected-chat" className="conversation-stage glass-panel flex h-full min-h-[520px] items-center justify-center rounded-[28px] p-6" initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }} aria-label="Protected private chat"><motion.div className="w-full max-w-sm rounded-3xl border border-[var(--signal)]/30 bg-[var(--signal-soft)]/35 p-6 text-center" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, delay: 0.04 }}><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-[var(--signal)] text-white"><LockKeyhole className="size-5" /></span><p className="mt-4 text-[0.62rem] font-bold uppercase tracking-[0.18em] text-[var(--signal)]">Protected on this device</p><h2 className="mt-2 text-xl font-semibold">Unlock this chat to view it.</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Confirm your account password to reveal its title, messages, and attachments on this browser. This is an access control, not encryption.</p><label className="mt-5 block text-left text-xs font-semibold">Account password<input type="password" value={localLockPassword} onChange={(event) => setLocalLockPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void changeLocalLock("unlock"); } }} autoComplete="current-password" className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--foreground)]" /></label><button type="button" onClick={() => void changeLocalLock("unlock")} disabled={!localLockPassword || lockBusy} className="mt-3 w-full rounded-xl bg-[var(--signal)] px-3 py-2.5 text-sm font-bold text-white transition-transform duration-150 active:scale-[0.97] disabled:opacity-50">{lockBusy ? "Confirming…" : "Unlock chat"}</button>{error && <p role="alert" className="mt-3 text-xs text-[var(--warning)]">{error}</p>}</motion.div></motion.section>;
  }

  const archiveLensActive = searchLensOpen || Boolean(inSessionQuery || fromDate || toDate);
  const visibleMessages = serverSearchResults ?? filterMessageHistory(messages, inSessionQuery, fromDate, toDate);
  const retentionSummary = session.retentionPolicy && session.retentionPolicy !== "keep" ? `New messages expire after ${session.retentionPolicy}` : "New messages are kept until deleted";
  const activeUpload = uploads.find((item) => item.state !== "complete");
  const composerState = sendingSelection ? "Sending selection" : activeUpload?.state === "failed" ? "Upload needs attention" : activeUpload ? `Uploading ${activeUpload.name}` : queuedAttachments.length ? `${queuedAttachments.length} attachment${queuedAttachments.length === 1 ? "" : "s"} ready to send` : connectionState !== "connected" ? connectionState === "reconnecting" ? "Rejoining delivery" : "Delivery paused" : peerTyping ? `@${session.username} is typing` : body.trim() ? "Draft stored on this device" : "Ready for a private message";

  return <motion.section key="open-chat" className="conversation-stage workspace-conversation-stage glass-panel relative flex h-full min-h-[520px] flex-col overflow-hidden rounded-[28px]" initial={{ opacity: 0, scale: 0.99 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }} data-connection={connectionState} aria-label={`Private chat with ${session.username}`}><ConversationStageStyles />
    <header className="conversation-stage__header conversation-command-header flex items-center justify-between border-b border-[var(--border)] px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3"><SignalSignature value={session.username} size="sm" /><div className="min-w-0"><p className="conversation-stage__eyebrow">DIRECT / ONE-TO-ONE</p><h2 className="truncate text-sm font-semibold">@{session.username}</h2><span className="conversation-stage__state"><i data-state={connectionState} />{connectionState === "connected" ? "Live delivery" : connectionState === "reconnecting" ? "Reconnecting" : "Delivery paused"}</span></div></div>
      <div className="flex items-center gap-1"><button type="button" onClick={() => setSearchLensOpen((open) => !open)} className={`orbit-button size-9 rounded-xl ${archiveLensActive ? "!border-[var(--signal-strong)] !bg-[var(--signal-soft)] !text-[var(--signal-bright)]" : ""}`} aria-pressed={archiveLensActive} aria-label="Search messages"><Search className="size-4" aria-hidden="true" /></button><button type="button" onClick={() => setPeerContextOpen(true)} className="orbit-button size-9 rounded-xl" aria-label="Conversation details"><PanelRightOpen className="size-4" aria-hidden="true" /></button><details className="conversation-command-menu relative"><summary className="orbit-button size-9 cursor-pointer list-none rounded-xl" aria-label="More conversation actions"><MoreHorizontal className="size-4" aria-hidden="true" /></summary><div className="glass-panel absolute right-0 z-20 mt-2 w-48 rounded-2xl p-1.5 text-sm shadow-2xl"><button type="button" onClick={() => void control("notifications")} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/5">{notificationsEnabled ? <Bell className="size-4" /> : <BellOff className="size-4" />}{notificationsEnabled ? "Mute alerts" : "Enable alerts"}</button><button type="button" onClick={() => void control("mute")} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/5"><BellOff className="size-4" />Mute for one hour</button><button type="button" onClick={() => void control("archive")} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/5"><Archive className="size-4" />Archive chat</button><button type="button" onClick={() => void control("report")} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/5"><Flag className="size-4" />Report</button><button type="button" onClick={() => void control("block")} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[var(--danger)] hover:bg-[var(--danger)]/10"><ShieldBan className="size-4" />Block user</button></div></details><button type="button" onClick={() => void loadMessages(session.id)} className="orbit-button size-9 rounded-xl" aria-label="Refresh messages"><RefreshCw className="size-4" aria-hidden="true" /></button></div>
    </header>
    <AnimatePresence initial={false}>{connectionState !== "connected" && <motion.div className="conversation-recovery" role="status" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}><span className="conversation-recovery__dot" aria-hidden="true" />{connectionState === "reconnecting" ? "Reconnecting. Your draft stays on this device." : "Connection paused. Messages will send when the connection returns."}</motion.div>}</AnimatePresence>
    <div className="conversation-policy-strip flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-black/10 px-4 py-2.5 sm:px-5"><div className="line-policy-capsule"><div><p className="text-[0.6rem] font-bold uppercase tracking-[0.16em] text-[var(--subtle)]">Line policy</p><span>{retentionSummary}</span></div><div className="mt-1 flex flex-wrap gap-1">{(["keep", "24h", "7d", "30d"] as const).map((policy) => <button type="button" key={policy} onClick={() => void updateRetention(policy)} className={`rounded-lg border px-2 py-1 text-[0.65rem] font-semibold ${session.retentionPolicy === policy || (!session.retentionPolicy && policy === "keep") ? "border-[var(--signal)] bg-[var(--signal-soft)] text-[var(--signal-bright)]" : "border-[var(--border)] text-[var(--muted)]"}`}>{policy === "keep" ? "Keep" : policy}</button>)}</div></div><details className="relative"><summary className="cursor-pointer list-none rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--muted)]"><span className="inline-flex items-center gap-1.5"><LockKeyhole className="size-3.5" />Lock on this device</span></summary><div className="glass-panel absolute right-0 z-20 mt-2 w-64 rounded-2xl p-3 text-xs shadow-2xl"><p className="font-semibold">Hide this chat on this device</p><p className="mt-1 leading-5 text-[var(--muted)]">Your account password is required now and again to unlock it. This is an access control, not encryption.</p><input type="password" value={localLockPassword} onChange={(event) => setLocalLockPassword(event.target.value)} autoComplete="current-password" placeholder="Account password" className="mt-3 w-full rounded-lg border border-[var(--border)] bg-black/10 px-2 py-2 text-sm outline-none" /><button type="button" onClick={() => void changeLocalLock("lock")} disabled={!localLockPassword || lockBusy} className="mt-2 w-full rounded-lg bg-[var(--signal)] px-2 py-2 text-xs font-bold text-white disabled:opacity-50">{lockBusy ? "Confirming…" : "Lock this chat"}</button></div></details></div>

    <AnimatePresence>{peerContextOpen && <motion.aside className="peer-context" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.2 }} aria-label={`Session ledger for ${session.username}`}><div className="peer-context__head"><span>SESSION LEDGER</span><button type="button" onClick={() => setPeerContextOpen(false)} aria-label="Close peer context"><X className="size-4" /></button></div><div className="peer-context__identity"><SignalSignature value={session.username} size="lg" /><div><h3>@{session.username}</h3><p>Direct private session</p></div></div><div className="peer-context__fact"><span>Discoverable identifier</span><b>@{session.username}</b></div><div className="peer-context__fact"><span>New-message retention</span><b>{session.retentionPolicy && session.retentionPolicy !== "keep" ? session.retentionPolicy : "Keep"}</b></div><section className="peer-context__shared" aria-labelledby="shared-items-title" data-shared-count={sharedItems.length} data-shared-loading={sharedLoading ? "true" : "false"}><div className="flex items-center justify-between gap-3"><h4 id="shared-items-title" className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-[var(--subtle)]">Shared items</h4><span className="text-[0.65rem] text-[var(--muted)]">This line only</span></div><div className="mt-2 grid grid-cols-3 gap-1 rounded-xl border border-[var(--border)] bg-black/10 p-1" role="tablist" aria-label="Shared items categories">{(["media", "documents", "links"] as const).map((category) => <button key={category} type="button" role="tab" aria-selected={sharedCategory === category} onClick={() => { setSharedCategory(category); setSharedPage(0); void loadSharedItems(category, 0); }} className={`rounded-lg px-2 py-1.5 text-[0.65rem] font-semibold capitalize ${sharedCategory === category ? "bg-[var(--signal-soft)] text-[var(--signal-bright)]" : "text-[var(--muted)]"}`}>{category === "media" ? "Media" : category}</button>)}</div>{sharedLoading && sharedItems.length === 0 ? <p className="mt-3 text-xs text-[var(--muted)]" role="status">Loading shared {sharedCategory}…</p> : sharedError && sharedItems.length === 0 ? <p className="mt-3 text-xs text-[var(--warning)]" role="alert">{sharedError}</p> : sharedItems.length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs leading-5 text-[var(--muted)]">No {sharedCategory} shared in this conversation yet.</p> : <div className="mt-3 space-y-2">{sharedItems.map((item) => item.kind === "link" ? <div key={item.id} className="rounded-xl border border-[var(--border)] bg-black/10 p-2.5"><div className="flex items-start gap-2"><Link2 className="mt-0.5 size-4 shrink-0 text-[var(--signal-bright)]" /><p className="min-w-0 break-words text-xs leading-5 text-[var(--foreground)]">{item.body}</p></div><p className="mt-1 text-[0.65rem] text-[var(--muted)]">{messageTime(item.createdAt)}</p></div> : <a key={item.id} href={item.mediaUrl} target="_blank" rel="noreferrer" className="group flex items-center gap-2 rounded-xl border border-[var(--border)] bg-black/10 p-2.5 transition hover:border-[var(--signal-strong)]"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--signal-soft)] text-[var(--signal-bright)]">{item.mimeType?.startsWith("image/") ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}</span><span className="min-w-0 flex-1"><b className="block truncate text-xs text-[var(--foreground)]">{item.fileName ?? "Shared file"}</b><span className="block text-[0.65rem] text-[var(--muted)]">{item.mimeType ?? "File"}{formatBytes(item.byteSize) ? ` · ${formatBytes(item.byteSize)}` : ""}</span></span><Download className="size-3.5 shrink-0 text-[var(--muted)] group-hover:text-[var(--signal-bright)]" /></a>)}</div>}<div className="mt-2 flex justify-end gap-1"><button type="button" disabled={sharedPage === 0 || sharedLoading} onClick={() => { const page = Math.max(0, sharedPage - 1); setSharedPage(page); void loadSharedItems(sharedCategory, page); }} className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] disabled:opacity-35" aria-label="Previous shared items"><ChevronLeft className="size-3.5" /></button><button type="button" disabled={!sharedHasMore || sharedLoading} onClick={() => { const page = sharedPage + 1; setSharedPage(page); void loadSharedItems(sharedCategory, page); }} className="rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] disabled:opacity-35" aria-label="Next shared items"><ChevronRight className="size-3.5" /></button></div></section><div className="peer-context__actions"><button type="button" onClick={() => void control("notifications")}><Bell className="size-4" />{notificationsEnabled ? "Mute alerts" : "Enable alerts"}</button><button type="button" onClick={() => void control("archive")}><Archive className="size-4" />Archive conversation</button><button type="button" onClick={() => void control("report")}><Flag className="size-4" />Report this peer</button><button type="button" onClick={() => void control("block")} className="is-danger"><ShieldBan className="size-4" />Block peer</button></div><p className="peer-context__note">This ledger only shows facts available to this direct line. Go Chat does not expose public profiles, friend graphs, shared groups, or activity.</p></motion.aside>}</AnimatePresence>

    <AnimatePresence initial={false}>{archiveLensActive && <motion.div className="archive-lens border-b border-[var(--border)] bg-[var(--signal-soft)]/40 px-4 py-3 sm:px-5" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }}><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-lg bg-[var(--signal)] text-white"><Search className="size-3.5" /></span><span><span className="block text-[0.61rem] font-bold uppercase tracking-[0.18em] text-[var(--signal-bright)]">Search messages</span><span className="text-xs text-[var(--muted)]">Find messages in this chat</span></span></div><button type="button" onClick={() => { setSearchLensOpen(false); setInSessionQuery(""); setFromDate(""); setToDate(""); }} className="orbit-button size-8 rounded-lg" aria-label="Close and clear search"><X className="size-4" /></button></div><div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]"><label className="flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-black/10 px-3"><Search className="size-3.5 text-[var(--muted)]" /><input value={inSessionQuery} onChange={(event) => setInSessionQuery(event.target.value)} placeholder="Search this chat" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--subtle)]" aria-label="Search messages by keyword" /></label><label className="flex items-center gap-2 text-xs text-[var(--muted)]">From <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-black/10 px-2 text-xs text-[var(--foreground)]" aria-label="Search messages from date" /></label><label className="flex items-center gap-2 text-xs text-[var(--muted)]">To <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="h-10 rounded-xl border border-[var(--border)] bg-black/10 px-2 text-xs text-[var(--foreground)]" aria-label="Search messages to date" /></label></div>{serverSearchResults && <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--muted)]"><span>{serverSearchResults.length ? `Showing ${searchPage * searchPageSize + 1}–${searchPage * searchPageSize + serverSearchResults.length} · Page ${searchPage + 1}` : "No matching messages"}</span><span className="flex gap-1"><button type="button" disabled={searchPage === 0} onClick={() => setSearchPage((page) => Math.max(0, page - 1))} className="rounded-lg border border-[var(--border)] px-2 py-1.5 font-bold disabled:opacity-35">Previous</button><button type="button" disabled={!searchHasMore} onClick={() => setSearchPage((page) => page + 1)} className="rounded-lg border border-[var(--border)] px-2 py-1.5 font-bold disabled:opacity-35">Next</button></span></div>}</motion.div>}</AnimatePresence>

    <div className="conversation-stage__field conversation-message-field flex-1 overflow-y-auto px-4 py-5 sm:px-6" aria-live="polite">
      {visibleMessages.length === 0 ? <div className="message-field-empty">{messages.length === 0 ? <><SignalSignature value={session.username} size="lg" /><p>DIRECT LINE OPEN</p><h3>@{session.username}</h3><div>This conversation is ready. Start with a message, voice note, or shared file when you are ready.</div></> : <><span className="message-field-empty__mark"><Search className="size-5" /></span><p>SEARCH LENS</p><h3>No matching messages</h3><div>Change the keyword or date range to return to the live conversation history.</div></>}</div> : visibleMessages.map((message, index) => {
        const own = message.senderId === userId;
        const previous = visibleMessages[index - 1];
        const startsDay = startsMessageDay(message, previous);
        const startsPeerGroup = startsPeerMessageGroup(message, previous, userId);
        const editing = editingMessageId === message.id;
        const deleted = message.state === "deleted" || Boolean(message.deletedAt);
		const expiry = !deleted && message.expiresAt ? expiryState(message.expiresAt, now) : "none";
		const expires = message.expiresAt && expiry !== "none" ? expiryLabel(message.expiresAt, now) : "";
        const receipt = receiptSignalState(message.state, message.read);
        const receiptLabel = receipt === "pending" ? "Sending" : receipt === "failed" ? "Not sent" : receipt === "read" ? "Read" : receipt === "delivered" ? "Delivered" : "Sent";
        return <div key={message.id}>{startsDay && <div className="message-day-divider"><span>{messageDayLabel(message.createdAt)}</span></div>}{startsPeerGroup && <button type="button" onClick={() => setPeerContextOpen(true)} className="peer-message-group" aria-label={`Open details for ${session.username}`}><SignalSignature value={session.username} size="sm" /><span>@{session.username}</span><time>{messageTime(message.createdAt)}</time></button>}<motion.article layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} data-message-state={message.state} data-expiry={expiry} className={`group message-row ${own ? "message-row--outgoing justify-end" : "message-row--incoming justify-start"} ${startsPeerGroup ? "is-group-start" : ""}`}>
          <div className={`max-w-[86%] rounded-[20px] border px-4 py-3 text-sm leading-6 shadow-[0_10px_28px_rgba(0,0,0,.12)] sm:max-w-[74%] ${own ? "border-[var(--signal-strong)] bg-[linear-gradient(135deg,rgba(141,123,255,.95),rgba(110,87,225,.88))] text-white" : "border-[var(--border)] bg-[var(--surface-float)] text-[var(--foreground)]"}`}>
            {editing ? <div className="flex gap-2"><input value={editBody} onChange={(event) => setEditBody(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/25 bg-black/10 px-2 py-1 text-sm outline-none" aria-label="Edited message" autoFocus /><button onClick={() => void saveEdit(message)} className="rounded-lg bg-white/20 px-2 text-xs font-bold" type="button">Save</button><button onClick={() => { setEditingMessageId(null); setEditBody(""); }} className="rounded-lg px-1" type="button" aria-label="Cancel edit"><X className="size-4" /></button></div> : deleted ? <span className="italic opacity-75">This message was deleted</span> : message.kind === "media" ? <div className="space-y-2">{mediaPreview(message)}<span className="block text-xs opacity-75">{message.fileName}</span></div> : <p><HighlightMessage value={message.body} query={inSessionQuery} /></p>}
	            <div className={`mt-2 flex items-center gap-2 text-[0.65rem] ${own ? "text-white/72" : "text-[var(--muted)]"}`}><span>{messageTime(message.createdAt)}</span>{!deleted && message.editedAt && <span>edited</span>}{expires && <span className={`message-expiry message-expiry--${expiry}`} aria-label={expiry === "near" ? `${expires}; this message will expire within one hour` : expires}>{expires}</span>}{own && <motion.span className={`receipt-trace receipt-trace--${receipt}`} initial={false} animate={{ opacity: 1, scale: 1 }}><span className="inline-flex items-center gap-1">{receipt === "pending" ? <Clock3 className="size-3" /> : receipt === "sent" ? <Check className="size-3" /> : <CheckCheck className="size-3" />}{receiptLabel}</span>{receipt === "failed" && <button type="button" onClick={() => void deliver(message.body, message.clientOperationId ?? message.id, true)} className="inline-flex items-center gap-1 font-bold underline"><RotateCcw className="size-3" />Retry</button>}{!editing && <span className="message-action-shelf"><button type="button" onClick={() => { setEditingMessageId(message.id); setEditBody(message.body); }} aria-label="Edit message"><Pencil className="size-3" /><span>Edit</span></button><button type="button" onClick={() => void removeMessage(message)} aria-label="Delete message"><Trash2 className="size-3" /><span>Delete</span></button></span>}</motion.span>}</div>
          </div>
        </motion.article></div>;
      })}
      <AnimatePresence>{peerTyping && <motion.div className="typing-current mt-2 inline-flex items-center gap-2 rounded-full border border-[var(--signal-strong)] bg-[var(--signal-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--signal-bright)]" role="status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}><span className="flex gap-1" aria-hidden="true"><i className="size-1 animate-pulse rounded-full bg-current" /><i className="size-1 animate-pulse rounded-full bg-current [animation-delay:120ms]" /><i className="size-1 animate-pulse rounded-full bg-current [animation-delay:240ms]" /></span>@{session.username} is typing</motion.div>}</AnimatePresence>
    </div>

    {error && <p role="alert" className="mx-4 mb-1 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs font-medium text-[var(--warning)]">{error}</p>}
    <AnimatePresence>{uploads.some((item) => item.state !== "complete") && <motion.div className="mx-4 mb-2 space-y-2 sm:mx-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>{uploads.filter((item) => item.state !== "complete").map((item) => <div key={item.id} className="transfer-current"><div className="flex items-center gap-2 px-3 py-2 text-xs"><Loader2 className={`size-3 ${item.state === "uploading" ? "animate-spin text-[var(--plasma)]" : "text-[var(--danger)]"}`} /><span className="min-w-0 flex-1 truncate text-[var(--muted)]">{item.name}</span><span className="font-bold text-[var(--foreground)]">{item.state === "failed" ? item.error : `${item.progress}%`}</span>{item.state === "failed" && item.file && <button type="button" onClick={() => { queueAttachment(item.file!, item.file!.type.startsWith("audio/") ? "voice" : "file", item.id); setUploads((current) => current.filter((currentItem) => currentItem.id !== item.id)); }} className="font-bold text-[var(--signal-bright)]">Queue for Send</button>}</div><div className="transfer-current__bar" style={{ width: `${item.progress}%` }} /></div>)}</motion.div>}</AnimatePresence>

	    <motion.form className="conversation-composer message-rail signal-magnetic-dock m-3 rounded-2xl p-2 sm:m-4" data-state={sendingSelection ? "sending" : activeUpload?.state ?? (queuedAttachments.length ? "queued" : connectionState === "connected" ? body.trim() ? "draft" : peerTyping ? "peer-typing" : "ready" : connectionState)} layout onSubmit={(event) => { event.preventDefault(); void send(); }}><div className="conversation-composer__rail"><span>MESSAGE RAIL</span><span className="composer-rail__state" role="status">{composerState}</span></div>{queuedAttachments.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5 px-1" aria-label="Attachments ready to send">{queuedAttachments.map((attachment) => <span key={attachment.id} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[var(--signal-strong)] bg-[var(--signal-soft)] px-2 py-1 text-[0.68rem] text-[var(--foreground)]"><span className="font-semibold">{attachment.kind === "voice" ? "Voice" : "File"}</span><span className="max-w-32 truncate">{attachment.name}</span><button type="button" onClick={() => removeQueuedAttachment(attachment.id)} aria-label={`Remove ${attachment.name} from Send`} className="ml-0.5 text-[var(--muted)] hover:text-[var(--foreground)]"><X className="size-3" /></button></span>)}</div>}<div className="conversation-composer__input"><VoiceNoteRecorder onRecord={(file) => queueAttachment(file, "voice")} /><label className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl border border-[var(--border)] text-[var(--muted)] transition hover:border-[var(--signal-strong)] hover:text-[var(--signal-bright)]" aria-label="Attach a file"><Paperclip className="size-4" /><input type="file" className="sr-only" accept="image/png,image/jpeg,image/gif,image/webp,video/webm,video/mp4,audio/webm,audio/ogg,audio/wav,audio/mp4,application/pdf,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) queueAttachment(file, "file"); event.target.value = ""; }} /></label><input value={body} onChange={(event) => { const next = event.target.value; setBody(next); if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current); if (session) { onTyping(next.trim() ? "typing.start" : "typing.stop"); if (next.trim()) typingTimerRef.current = window.setTimeout(() => onTyping("typing.stop"), 2200); } }} onBlur={() => { if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current); onTyping("typing.stop"); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.shiftKey || event.nativeEvent.isComposing || queuedAttachments.length > 0 || sendingSelection)) event.preventDefault(); }} placeholder={`Message @${session.username}`} className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-[var(--subtle)]" aria-label={`Message ${session.username}`} /><motion.button whileTap={{ scale: 0.95 }} disabled={(!body.trim() && queuedAttachments.length === 0) || sendingSelection} type="submit" aria-label="Send message and attachments" className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--signal)] text-white shadow-[0_0_20px_rgba(141,123,255,.32)] transition hover:bg-[var(--signal-bright)] hover:text-[var(--void)] disabled:opacity-40"><ArrowUp className="size-4" /></motion.button></div><div className="conversation-composer__meta"><span>{sendOnEnter ? "Press Enter to send the queued selection" : "Use Send to deliver this selection"}</span><span>{retentionSummary}</span></div></motion.form>
  </motion.section>;
}
