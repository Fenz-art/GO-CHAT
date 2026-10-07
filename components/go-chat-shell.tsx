"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AnonymousIdentity } from "@/components/onboarding-card";
import { GoChatLanding } from "@/components/go-chat-landing";
import { ConversationPanel, ConversationSession } from "@/components/conversation-panel";
import { SearchPanel } from "@/components/search-panel";
import { SettingsPanel } from "@/components/settings-panel";
import { AccountAccessPanel } from "@/components/account-access-panel";
import { SignalBloomMotion, SignalHorizon, SignalSignature, SignalStatusPill, SmoothRelayStream } from "@/components/signal-bloom-motion";
import { sessionExitSummary, SessionExitKind } from "@/shared/session-exit";
import { completedIdentityFromResume, OnboardingResumeState } from "@/shared/identity-resume";
import { shouldOpenWorkspaceOrientation, workspaceOrientationKey } from "@/shared/workspace-orientation";
import { WorkspaceOrientation } from "@/components/workspace-orientation";
import { WorkspaceConsoleStyles } from "@/components/workspace-console-styles";
import { ArrowUpRight, CircleHelp, Compass, LockKeyhole, LogOut, MessageCircleMore, Plus, Search, Settings2, ShieldCheck, Signal, Sparkles, UserRound, X } from "lucide-react";

type RealtimeMessage = { sessionId: string; message: { id: string; body: string; senderId: string; state: string; createdAt: string; clientOperationId?: string } };
type RealtimeRead = { sessionId: string; messageId: string; readBy: string };
type PrivacyOverview = { privacyCheckupCompleted: boolean; presenceVisibility: "everyone" | "direct_contacts" | "nobody"; notificationPreview: "full" | "sender" | "none"; quietHoursEnabled: boolean; notifications: boolean };
type AccountSummary = { id: string; username: string; email: string; emailVerified: boolean; linkedIdentity: string };
type IncomingRequest = { id: string; fromUserId: string; username: string; status: "pending"; createdAt: string };
const privacyDefaults: PrivacyOverview = { privacyCheckupCompleted: false, presenceVisibility: "everyone", notificationPreview: "sender", quietHoursEnabled: false, notifications: true };

const orbit = [
  { label: "Chats", icon: MessageCircleMore },
  { label: "Discover", icon: Compass },
] as const;

function relativeTime(value?: string) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1_440)}d`;
}

export function GoChatShell() {
  const [connectionState, setConnectionState] = useState<"connected" | "reconnecting" | "disconnected">("disconnected");
  const [identity, setIdentity] = useState<AnonymousIdentity | null>(null);
  const [identityRestored, setIdentityRestored] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<ConversationSession | null>(null);
  const [sessions, setSessions] = useState<Array<ConversationSession & { lastActivity?: string }>>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [incomingRequests, setIncomingRequests] = useState<IncomingRequest[]>([]);
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const [realtimeMessage, setRealtimeMessage] = useState<RealtimeMessage | null>(null);
  const [realtimeRead, setRealtimeRead] = useState<RealtimeRead | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchUsername, setSearchUsername] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountMode, setAccountMode] = useState<"login" | "create" | null>(null);
  const [privacy, setPrivacy] = useState<PrivacyOverview>(privacyDefaults);
  const [chatFilter, setChatFilter] = useState("");
  const [mobileChatsOpen, setMobileChatsOpen] = useState(false);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [exitIntent, setExitIntent] = useState<SessionExitKind | null>(null);
  const [exitBusy, setExitBusy] = useState(false);
  const [exitNotice, setExitNotice] = useState("");
  const [orientationOpen, setOrientationOpen] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<number | undefined>(undefined);
  const identityMenuOpenerRef = useRef<HTMLElement | null>(null);
  const identityMenuCloseRef = useRef<HTMLButtonElement | null>(null);
  const exitDialogOpenerRef = useRef<HTMLElement | null>(null);
  const exitDialogCancelRef = useRef<HTMLButtonElement | null>(null);

  const loadSessions = useCallback(async () => {
    if (!identity) return;
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const response = await fetch("/api/v1/sessions");
      if (!response.ok) throw new Error("Could not load private conversations");
      const items = await response.json() as Array<{ id: string; username: string; lastActivity?: string; lastActivityAt?: string; retentionPolicy?: "keep" | "24h" | "7d" | "30d"; localLocked?: boolean }>;
      const nextSessions = items.map((item) => ({ id: item.id, username: item.username, lastActivity: item.lastActivity ?? item.lastActivityAt, retentionPolicy: item.retentionPolicy, localLocked: item.localLocked }));
      setSessions(nextSessions);
      setSelectedSession((current) => {
        if (!current) return current;
        const refreshed = nextSessions.find((item) => item.id === current.id);
        return refreshed ? { ...current, username: refreshed.username, retentionPolicy: refreshed.retentionPolicy, localLocked: refreshed.localLocked } : current;
      });
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : "Could not load private conversations");
    } finally {
      setSessionsLoading(false);
    }
  }, [identity]);

  const loadIncomingRequests = useCallback(async () => {
    if (!identity) return;
    try {
      const response = await fetch("/api/v1/requests");
      if (!response.ok) throw new Error("Could not load private-line requests");
      const result = await response.json() as { items?: IncomingRequest[] };
      setIncomingRequests(result.items ?? []);
    } catch {
      setIncomingRequests([]);
    }
  }, [identity]);

  useEffect(() => { activeSessionRef.current = activeSessionId; }, [activeSessionId]);
	  useEffect(() => {
	    let active = true;
	    void fetch("/api/v1/onboarding/resume").then(async (response) => response.ok ? await response.json() as OnboardingResumeState : null).then((state) => {
	      if (!active) return;
	      const resumedIdentity = completedIdentityFromResume(state);
	      if (resumedIdentity) setIdentity(resumedIdentity);
	    }).catch(() => undefined).finally(() => { if (active) setIdentityRestored(true); });
	    return () => { active = false; };
	  }, []);
	  useEffect(() => {
	    if (!identity) { setOrientationOpen(false); return; }
	    setOrientationOpen(shouldOpenWorkspaceOrientation(window.localStorage.getItem(workspaceOrientationKey(identity.userId))));
	  }, [identity]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { void loadIncomingRequests(); }, [loadIncomingRequests]);
  useEffect(() => {
    if (!identity) return;
    void fetch("/api/v1/settings").then(async (response) => response.ok ? response.json() as Promise<PrivacyOverview> : null).then((settings) => { if (settings) setPrivacy(settings); }).catch(() => undefined);
  }, [identity]);
  useEffect(() => {
    if (!identity) { setAccount(null); return; }
    void fetch("/api/v1/account").then(async (response) => response.ok ? response.json() as Promise<AccountSummary> : null).then(setAccount).catch(() => setAccount(null));
  }, [identity]);
  useEffect(() => {
    if (!accountMenuOpen) return;
    identityMenuOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => identityMenuCloseRef.current?.focus(), 0);
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setAccountMenuOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKeyDown); window.requestAnimationFrame(() => identityMenuOpenerRef.current?.focus()); };
  }, [accountMenuOpen]);
  useEffect(() => {
    if (!exitIntent) return;
    exitDialogOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => exitDialogCancelRef.current?.focus(), 0);
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !exitBusy) setExitIntent(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKeyDown); window.requestAnimationFrame(() => exitDialogOpenerRef.current?.focus()); };
  }, [exitBusy, exitIntent]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    const connect = () => {
      if (!active) return;
      setConnectionState("reconnecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/realtime`);
      socketRef.current = socket;
      socket.onopen = () => active && setConnectionState("connected");
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as { type?: string; sessionId?: string; messageId?: string; readBy?: string; message?: RealtimeMessage["message"] };
          if (event.type === "connection.ready") {
            setConnectionState("connected");
            void loadIncomingRequests();
            void loadSessions();
            return;
          }
          if (event.type === "session.revoked") {
            setAccount(null);
            setIdentity(null);
            setActiveSessionId(null);
            setSelectedSession(null);
            setSessions([]);
            return;
          }
          if (event.type === "message.created" && event.sessionId && event.message) { setRealtimeMessage({ sessionId: event.sessionId, message: event.message }); void loadSessions(); return; }
          if (event.type === "message.read" && event.sessionId && event.messageId && event.readBy) { setRealtimeRead({ sessionId: event.sessionId, messageId: event.messageId, readBy: event.readBy }); return; }
          if (event.type === "request.created" || event.type === "request.resolved") { void loadIncomingRequests(); void loadSessions(); return; }
          if ((event.type === "typing.start" || event.type === "typing.stop") && event.sessionId === activeSessionRef.current) {
            if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
            setPeerTyping(event.type === "typing.start");
            if (event.type === "typing.start") typingTimeoutRef.current = window.setTimeout(() => setPeerTyping(false), 3500);
          }
        } catch { /* Malformed realtime events cannot affect the visual state. */ }
      };
      socket.onclose = () => { if (active) { setConnectionState("disconnected"); retry = window.setTimeout(connect, 2500); } };
      socket.onerror = () => active && setConnectionState("disconnected");
    };
    if (identity) connect();
    else setConnectionState("disconnected");
    return () => { active = false; if (retry) window.clearTimeout(retry); if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current); socket?.close(); };
  }, [identity, loadIncomingRequests, loadSessions]);

  const handleOnboardingComplete = useCallback((nextIdentity: AnonymousIdentity) => setIdentity(nextIdentity), []);
  const handleSessionChange = useCallback((sessionId: string | null, session?: ConversationSession) => {
    setActiveSessionId(sessionId);
    setPeerTyping(false);
    setSelectedSession((current) => sessionId ? session ?? (current?.id === sessionId ? current : current) : null);
    if (sessionId) void loadSessions();
  }, [loadSessions]);
  const emitTyping = useCallback((type: "typing.start" | "typing.stop") => {
    if (!activeSessionRef.current || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type, sessionId: activeSessionRef.current }));
  }, []);
  const openSearchResult = useCallback((username: string) => {
    setSelectedSession(null);
    setSearchUsername(username);
    setSearchOpen(false);
  }, []);
  const openSession = useCallback((session: ConversationSession) => {
    setSearchUsername("");
    setSelectedSession(session);
    setActiveSessionId(session.id);
    setMobileChatsOpen(false);
  }, []);
  const resolveIncomingRequest = useCallback(async (request: IncomingRequest, action: "accept" | "decline" | "block") => {
    setRequestBusyId(request.id);
    try {
      const response = await fetch(`/api/v1/requests/${request.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const result = await response.json() as { sessionId?: string; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Could not update this private-line request.");
      setIncomingRequests((current) => current.filter((item) => item.id !== request.id));
      if (action === "accept" && result.sessionId) {
        openSession({ id: result.sessionId, username: request.username });
        void loadSessions();
      }
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : "Could not update this private-line request.");
    } finally {
      setRequestBusyId(null);
    }
  }, [loadSessions, openSession]);
  const requestExit = useCallback((kind: SessionExitKind) => {
    setAccountMenuOpen(false);
    setExitIntent(kind);
  }, []);
  const dismissOrientation = useCallback(() => {
    if (identity) window.localStorage.setItem(workspaceOrientationKey(identity.userId), "dismissed");
    setOrientationOpen(false);
  }, [identity]);
  const replayOrientation = useCallback(() => setOrientationOpen(true), []);
  const openDiscoverFromOrientation = useCallback(() => {
    dismissOrientation();
    setSearchOpen(true);
  }, [dismissOrientation]);
  const confirmExit = useCallback(async () => {
    if (!exitIntent || !identity) return;
    setExitBusy(true);
    const response = await fetch(exitIntent === "account" ? "/api/v1/account/logout" : "/api/v1/identity/logout", { method: "POST" }).catch(() => null);
    setExitBusy(false);
    if (!response?.ok) { setExitNotice("Could not end this session. Try again in a moment."); return; }
    const summary = sessionExitSummary(exitIntent, identity.username);
    setExitIntent(null);
    if (exitIntent === "account") {
      setAccount(null);
      setExitNotice(`${summary.title}. ${summary.detail}`);
      return;
    }
    socketRef.current?.close();
    setActiveSessionId(null);
    setSelectedSession(null);
    setSessions([]);
    setSearchUsername("");
    setIdentity(null);
  }, [exitIntent, identity]);
  const visibleSessions = sessions.filter((session) => session.username.toLowerCase().includes(chatFilter.trim().toLowerCase()));

  if (!identityRestored) return <SignalBloomMotion><main className="min-h-screen bg-[#050505] text-[var(--foreground)]"><div className="mx-auto flex min-h-screen w-[min(100%-28px,1400px)] items-center justify-center"><p className="font-mono text-xs font-bold tracking-[0.16em] text-[var(--signal-bright)]">RESTORING PRIVATE IDENTITY</p></div></main></SignalBloomMotion>;
  if (!identity) return <SignalBloomMotion><GoChatLanding onSignIn={() => setAccountMode("login")} /><AccountAccessPanel open={accountMode === "login"} mode="login" onClose={() => setAccountMode(null)} onAuthenticated={handleOnboardingComplete} /></SignalBloomMotion>;

  return <SignalBloomMotion>
    <main className="signal-bloom-shell workspace-console text-[var(--foreground)]">
      <WorkspaceConsoleStyles />
      <div className="workspace-console__page">
        <header className="workspace-console__navbar">
          <div className="workspace-console__brand"><span className="workspace-console__brand-mark"><Signal className="size-3.5" aria-hidden="true" /></span><span>GO <b>/</b> CHAT</span></div>
          <div className="workspace-console__navbar-actions"><span className="workspace-console__status"><i aria-hidden="true" />One-to-one private messaging</span><SignalStatusPill state={connectionState} /><button type="button" onClick={() => setAccountMenuOpen(true)} className="workspace-console__identity" aria-label="Open identity and account menu"><span>@{identity.username}</span><UserRound className="size-3.5" aria-hidden="true" /></button></div>
        </header>
      <div className="signal-bloom-frame workspace-console__frame">
        <aside className="signal-orbit" aria-label="Go Chat primary navigation">
          <div className="signal-orbit__thread" aria-hidden="true" />
          <div className="relative z-10 flex justify-center p-4 md:pt-6">
            {identity ? <SignalSignature value={identity.username} size="md" label={`${identity.username} identity signature`} /> : <div className="grid size-11 place-items-center rounded-[18px] bg-[var(--signal)] text-white shadow-[0_0_36px_rgba(141,123,255,.42)]"><Signal className="size-5" aria-hidden="true" /></div>}
          </div>
          <nav className="relative z-10 flex flex-1 items-center justify-around gap-2 px-3 py-2 md:flex-col md:justify-start md:gap-3 md:py-7" aria-label="Primary navigation">
            {orbit.map(({ label, icon: Icon }) => <button key={label} type="button" data-active={label === "Chats" && !searchOpen} onClick={() => { if (label === "Discover") { setSearchOpen(true); return; } setSearchOpen(false); setMobileChatsOpen(true); }} className="orbit-button size-11 md:size-12" aria-label={label} aria-current={label === "Chats" && !searchOpen ? "page" : undefined}><Icon className="size-[18px]" aria-hidden="true" /><span className="sr-only">{label}</span></button>)}
            <button type="button" onClick={replayOrientation} className="orbit-button size-11 md:size-12" aria-label="Replay workspace guide"><CircleHelp className="size-[18px]" aria-hidden="true" /><span className="sr-only">Replay workspace guide</span></button>
          </nav>
          <div className="relative z-10 hidden justify-center p-4 md:flex"><button type="button" onClick={() => setAccountMenuOpen(true)} className="orbit-button size-12" aria-label="Open identity and account menu"><UserRound className="size-[18px]" aria-hidden="true" /></button></div>
        </aside>

        <section className="relay-stream chat-index hidden h-full min-h-0 flex-col md:flex" aria-label="Chats">
          <header className="chat-index__header">
            <div><p className="chat-index__eyebrow">DIRECT LINES / {sessions.length}</p><h1>Private conversations</h1><p>Only lines you have opened.</p></div>
            <button type="button" onClick={() => setSearchOpen(true)} className="chat-index__new" aria-label="Open a private line"><Plus className="size-4" aria-hidden="true" /><span>Open line</span></button>
          </header>
	          <div className="chat-index__filter"><Search className="size-4" aria-hidden="true" /><input value={chatFilter} onChange={(event) => setChatFilter(event.target.value)} placeholder="Search your chats" aria-label="Search your chats" /></div>
	          {incomingRequests.length > 0 && <div className="chat-index__requests" aria-label="Incoming private-line requests"><div className="chat-index__requests-label"><span>INCOMING REQUESTS</span><b>{incomingRequests.length}</b></div>{incomingRequests.map((request) => <article key={request.id} className="chat-index__request"><SignalSignature value={request.username} size="sm" /><div><b>@{request.username}</b><span>Asked to open a private line</span></div><div className="chat-index__request-actions"><button type="button" onClick={() => void resolveIncomingRequest(request, "accept")} disabled={requestBusyId === request.id}>Accept</button><button type="button" onClick={() => void resolveIncomingRequest(request, "decline")} disabled={requestBusyId === request.id}>Decline</button><button type="button" onClick={() => void resolveIncomingRequest(request, "block")} disabled={requestBusyId === request.id} aria-label={`Block ${request.username}`}>Block</button></div></article>)}</div>}
	          <SmoothRelayStream><div className="chat-index__list">
            {sessionsLoading && <div className="space-y-2 px-2" aria-label="Loading conversations"><div className="h-16 animate-pulse rounded-2xl bg-white/5" /><div className="h-16 animate-pulse rounded-2xl bg-white/5" /></div>}
            {!sessionsLoading && sessionsError && <div className="glass-panel mx-2 rounded-2xl p-4 text-sm text-[var(--muted)]"><p>{sessionsError}</p><button type="button" onClick={() => void loadSessions()} className="mt-3 text-xs font-bold text-[var(--signal-bright)]">Try again</button></div>}
            {!sessionsLoading && !sessionsError && sessions.length === 0 && <div className="chat-index__empty"><span><Sparkles className="size-5" aria-hidden="true" /></span><h2>No chats yet</h2><p>Start a private chat with a username when you are ready.</p><button type="button" onClick={() => setSearchOpen(true)}>Start a chat <ArrowUpRight className="size-4" /></button></div>}
            {!sessionsLoading && !sessionsError && sessions.length > 0 && <div className="chat-index__list-label"><span>OPENED LINES</span><span>{visibleSessions.length} shown</span></div>}
            {!sessionsLoading && !sessionsError && sessions.length > 0 && visibleSessions.length === 0 && <p className="chat-index__no-results">No chat matches “{chatFilter}”.</p>}
            {!sessionsLoading && visibleSessions.map((session) => <motion.button key={session.id} type="button" layout="position" onClick={() => openSession(session)} className={`chat-index__item ${activeSessionId === session.id ? "is-active" : ""} ${session.localLocked ? "is-protected" : ""}`} aria-current={activeSessionId === session.id ? "page" : undefined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
              <SignalSignature value={session.username} size="sm" />
              <span className="min-w-0 flex-1"><span className="chat-index__item-head"><span>@{session.username}</span><time>{relativeTime(session.lastActivity)}</time></span><span className="chat-index__item-state">{session.localLocked ? <><LockKeyhole className="size-3" aria-hidden="true" />Protected on this device</> : session.retentionPolicy && session.retentionPolicy !== "keep" ? `New messages: ${session.retentionPolicy}` : "Private line"}</span></span>
              <span className="chat-index__selected" aria-hidden="true" />
            </motion.button>)}
          </div></SmoothRelayStream>
          {identity && <div className="chat-index__account"><button type="button" onClick={() => setAccountMenuOpen(true)} aria-label="Open identity and account menu"><SignalSignature value={identity.username} size="sm" /><span><b>@{identity.username}</b><small>{account ? `Account @${account.username}` : "Identity and privacy"}</small></span><Settings2 className="ml-auto size-4" aria-hidden="true" /></button>{!account && <button type="button" onClick={() => setAccountMode("create")} className="chat-index__secure">Add a password to this identity <ArrowUpRight className="size-3.5" /></button>}</div>}
        </section>

        <section className="private-field chat-workspace h-full min-h-0" aria-label="Private chat workspace">
          <header className="chat-workspace__mobile-head md:hidden">
            <div className="flex min-w-0 items-center gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-xl border border-[var(--border)] bg-white/[0.035] text-[var(--signal-bright)]"><Signal className="size-4" aria-hidden="true" /></div><div className="min-w-0"><p>Private chat</p><b>{selectedSession ? `@${selectedSession.username}` : "Choose a chat"}</b></div></div>
            <div className="flex items-center gap-2"><div className="hidden sm:block"><SignalHorizon state={connectionState} /></div><div className="sm:hidden"><SignalStatusPill state={connectionState} /></div><button type="button" onClick={() => setSettingsOpen(true)} className="orbit-button size-9 md:hidden" aria-label="Open settings"><Settings2 className="size-4" aria-hidden="true" /></button></div>
          </header>
          <motion.button type="button" onClick={() => setSettingsOpen(true)} className="workspace-privacy-checkup relative z-10 mx-3 mt-3 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-2xl border border-[var(--signal)]/35 bg-[var(--signal-soft)]/35 px-4 py-3 text-left shadow-[0_10px_30px_rgba(0,0,0,.12)] transition hover:border-[var(--signal)]/70 sm:mx-5 sm:w-[calc(100%-2.5rem)]" whileTap={{ scale: 0.985 }} aria-label="Open Privacy Checkup in settings"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--signal)] text-white"><ShieldCheck className="size-4" aria-hidden="true" /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">Privacy Checkup</span><span className={`rounded-full px-2 py-0.5 text-[0.62rem] font-bold ${privacy.privacyCheckupCompleted ? "bg-[var(--success)]/15 text-[var(--success)]" : "bg-[var(--warning)]/15 text-[var(--warning)]"}`}>{privacy.privacyCheckupCompleted ? "Reviewed" : "Review recommended"}</span></span><span className="mt-1 block truncate text-xs text-[var(--muted)]">Presence: {privacy.presenceVisibility === "direct_contacts" ? "Direct contacts" : privacy.presenceVisibility === "nobody" ? "Hidden" : "Anyone"} · Alerts: {!privacy.notifications ? "Off" : privacy.quietHoursEnabled ? "Quiet hours" : privacy.notificationPreview === "none" ? "No preview" : "On"}</span></span><ArrowUpRight className="size-4 shrink-0 text-[var(--signal-bright)]" aria-hidden="true" /></motion.button>
          <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3 sm:px-5 sm:py-5">
            <AnimatePresence mode="wait"><motion.div key="conversation" className="min-h-0 flex-1" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.26 }}><ConversationPanel userId={identity.userId} discoveryUsername={searchUsername} requestedSession={selectedSession} peerTyping={peerTyping} realtimeMessage={realtimeMessage} realtimeRead={realtimeRead} connectionState={connectionState} onSessionChange={handleSessionChange} onTyping={emitTyping} /></motion.div></AnimatePresence>
          </div>
        </section>
      </div>
      <WorkspaceOrientation open={orientationOpen} onDismiss={dismissOrientation} onOpenDiscover={openDiscoverFromOrientation} />
      <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} onSelectUsername={openSearchResult} />
	      <AnimatePresence>{mobileChatsOpen && <motion.aside className="mobile-chat-picker md:hidden" role="dialog" aria-modal="true" aria-label="Your chats" initial={{ opacity: 0, y: 26 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 26 }} transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}><div className="mobile-chat-picker__head"><div><p>Chats</p><h2>Private conversations</h2></div><button type="button" onClick={() => setMobileChatsOpen(false)} aria-label="Close chats"><span aria-hidden="true">×</span></button></div><div className="chat-index__filter"><Search className="size-4" aria-hidden="true" /><input value={chatFilter} onChange={(event) => setChatFilter(event.target.value)} placeholder="Search your chats" aria-label="Search your chats" autoFocus /></div>{incomingRequests.length > 0 && <div className="chat-index__requests" aria-label="Incoming private-line requests">{incomingRequests.map((request) => <article key={request.id} className="chat-index__request"><SignalSignature value={request.username} size="sm" /><div><b>@{request.username}</b><span>Asked to open a private line</span></div><div className="chat-index__request-actions"><button type="button" onClick={() => void resolveIncomingRequest(request, "accept")} disabled={requestBusyId === request.id}>Accept</button><button type="button" onClick={() => void resolveIncomingRequest(request, "decline")} disabled={requestBusyId === request.id}>Decline</button><button type="button" onClick={() => void resolveIncomingRequest(request, "block")} disabled={requestBusyId === request.id} aria-label={`Block ${request.username}`}>Block</button></div></article>)}</div>}<div className="mobile-chat-picker__list">{visibleSessions.map((session) => <button type="button" key={session.id} onClick={() => openSession(session)} className={`chat-index__item ${activeSessionId === session.id ? "is-active" : ""} ${session.localLocked ? "is-protected" : ""}`}><SignalSignature value={session.username} size="sm" /><span className="min-w-0 flex-1"><span className="chat-index__item-head"><span>@{session.username}</span><time>{relativeTime(session.lastActivity)}</time></span><span className="chat-index__item-state">{session.localLocked ? <><LockKeyhole className="size-3" aria-hidden="true" />Protected on this device</> : "Private chat"}</span></span></button>)}{!sessionsLoading && visibleSessions.length === 0 && <p className="chat-index__no-results">{sessions.length ? "No chat matches your search." : "No chats yet. Use Discover to start one."}</p>}</div></motion.aside>}</AnimatePresence>
      <AnimatePresence>{accountMenuOpen && identity && <motion.div className="identity-sheet-wrap" role="dialog" aria-modal="true" aria-label="Identity and account" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><button type="button" className="identity-sheet-wrap__backdrop" onClick={() => setAccountMenuOpen(false)} aria-label="Close identity and account menu" /><motion.aside className="identity-sheet" initial={{ opacity: 0, y: 12, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.985 }} transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}><header><div><p>IDENTITY</p><h2>@{identity.username}</h2></div><button ref={identityMenuCloseRef} type="button" onClick={() => setAccountMenuOpen(false)} aria-label="Close identity and account menu"><X className="size-4" /></button></header><div className="identity-sheet__signature"><SignalSignature value={identity.username} size="lg" /><div><b>Anonymous identity</b><span>Active on this browser</span></div></div><div className="identity-sheet__actions"><button type="button" onClick={() => { setAccountMenuOpen(false); setSettingsOpen(true); }}><Settings2 className="size-4" /><span><b>Preferences and privacy</b><small>Profile, notifications, privacy, and storage</small></span></button>{account ? <button type="button" onClick={() => requestExit("account")}><LogOut className="size-4" /><span><b>Sign out of account</b><small>@{account.username} ends; this identity stays active</small></span></button> : <button type="button" onClick={() => { setAccountMenuOpen(false); setAccountMode("create"); }}><ShieldCheck className="size-4" /><span><b>Add account continuity</b><small>Create a password for this identity</small></span></button>}<button type="button" onClick={() => requestExit("identity")} className="identity-sheet__danger"><LogOut className="size-4" /><span><b>Sign out of this identity</b><small>Closes this browser session; it does not delete data</small></span></button></div></motion.aside></motion.div>}</AnimatePresence>
      <AnimatePresence>{exitIntent && identity && <motion.div className="identity-sheet-wrap" role="dialog" aria-modal="true" aria-label="Confirm sign out" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><button type="button" className="identity-sheet-wrap__backdrop" onClick={() => !exitBusy && setExitIntent(null)} aria-label="Cancel sign out" /><motion.section className="identity-exit-dialog" initial={{ opacity: 0, y: 12, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.985 }} transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}><span className="identity-exit-dialog__mark"><LogOut className="size-4" /></span><p>SESSION EXIT</p><h2>{exitIntent === "account" ? "Sign out of your account?" : "Sign out of this identity?"}</h2><div className="identity-exit-dialog__copy">{exitIntent === "account" ? <>Your anonymous identity, direct chats, and browser workspace remain open. Account-only continuity controls will be unavailable until you sign in again.</> : <>This closes the anonymous session on this browser and returns to the entry surface. It does not delete your chats, identity, or files.</>}</div><div className="identity-exit-dialog__actions"><button ref={exitDialogCancelRef} type="button" onClick={() => setExitIntent(null)} disabled={exitBusy}>Cancel</button><button type="button" onClick={() => void confirmExit()} disabled={exitBusy} className="is-danger">{exitBusy ? "Signing out…" : "Sign out"}</button></div></motion.section></motion.div>}</AnimatePresence>
      <AnimatePresence>{exitNotice && <motion.div className="session-exit-notice" role="status" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}><span><ShieldCheck className="size-4" /></span><p>{exitNotice}</p><button type="button" onClick={() => setExitNotice("")} aria-label="Dismiss session notice"><X className="size-4" /></button></motion.div>}</AnimatePresence>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} account={account} onCurrentSessionRevoked={() => { socketRef.current?.close(); setSettingsOpen(false); setAccount(null); setIdentity(null); setSelectedSession(null); setActiveSessionId(null); setSessions([]); }} />
      <AccountAccessPanel open={accountMode === "create"} mode="create" onClose={() => setAccountMode(null)} onAuthenticated={handleOnboardingComplete} />
      </div>
    </main>
  </SignalBloomMotion>;
}
