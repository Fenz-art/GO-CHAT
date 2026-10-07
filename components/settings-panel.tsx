"use client";

import React, { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Download, Moon, Settings2, ShieldCheck, Sun, UserRound, X } from "lucide-react";
import { avatarCropGeometry } from "@/shared/avatar-crop";
import { ConsoleSurfaceStyles } from "@/components/console-surface-styles";

type Settings = {
  theme: "system" | "light" | "dark";
  reducedMotion: boolean;
  sendOnEnter: boolean;
  presenceVisibility: Visibility;
  readReceipts: boolean;
  notifications: boolean;
  avatarVisibility: Visibility;
  statusVisibility: Visibility;
  notificationPreview: "full" | "sender" | "none";
  notificationSound: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  mediaAutoDownload: "always" | "manual" | "never";
  linkPreviewsEnabled: boolean;
  privacyCheckupCompleted: boolean;
};

type StorageUsage = { usedBytes: number; fileCount: number; maxBytes: number };
type Profile = { userId: string; username: string; statusMessage: string; avatarUrl: string };
type Visibility = "everyone" | "direct_contacts" | "nobody";
type DataRightsRequest = { id: string; kind: string; status: string; referenceCode: string; confirmedAt: string; createdAt: string; updatedAt: string; note?: string };
type AccountSummary = { username: string; email: string; emailVerified: boolean };
type AccountSession = { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; isCurrent: boolean };

const defaults: Settings = { theme: "system", reducedMotion: false, sendOnEnter: true, presenceVisibility: "everyone", readReceipts: true, notifications: true, avatarVisibility: "direct_contacts", statusVisibility: "direct_contacts", notificationPreview: "sender", notificationSound: true, quietHoursEnabled: false, quietHoursStart: "22:00", quietHoursEnd: "08:00", mediaAutoDownload: "manual", linkPreviewsEnabled: false, privacyCheckupCompleted: false };

export function SettingsPanel({ open, onClose, account = null, onCurrentSessionRevoked }: { open: boolean; onClose: () => void; account?: AccountSummary | null; onCurrentSessionRevoked?: () => void }) {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropPreviewUrl, setCropPreviewUrl] = useState("");
  const [cropZoom, setCropZoom] = useState(1);
  const [cropOffsetX, setCropOffsetX] = useState(0);
  const [cropOffsetY, setCropOffsetY] = useState(0);
  const [cropBusy, setCropBusy] = useState(false);
  const [dataRequests, setDataRequests] = useState<DataRightsRequest[]>([]);
  const [deletionConfirm, setDeletionConfirm] = useState("");
  const [dataActionBusy, setDataActionBusy] = useState(false);
  const [dataActionError, setDataActionError] = useState("");
  const [accountSessions, setAccountSessions] = useState<AccountSession[]>([]);
  const [accountSessionsError, setAccountSessionsError] = useState("");
  const [accountSessionBusy, setAccountSessionBusy] = useState("");
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [accountNotice, setAccountNotice] = useState("");
  const openerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    onClose();
    window.setTimeout(() => openerRef.current?.focus(), 0);
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    setLoading(true);
    void Promise.all([fetch("/api/v1/settings"), fetch("/api/v1/storage/usage"), fetch("/api/v1/profile"), fetch("/api/v1/data/deletion-requests")])
      .then(async ([settingsResponse, usageResponse, profileResponse, dataRequestsResponse]) => {
        if (!settingsResponse.ok || !usageResponse.ok || !profileResponse.ok || !dataRequestsResponse.ok) throw new Error("Could not load preferences");
        const [next, nextUsage, nextProfile, nextDataRequests] = await Promise.all([
          settingsResponse.json() as Promise<Settings>,
          usageResponse.json() as Promise<StorageUsage>,
          profileResponse.json() as Promise<Profile>,
          dataRequestsResponse.json() as Promise<{ items: DataRightsRequest[] }>,
        ]);
        setSettings(next);
        setUsage(nextUsage);
        setProfile(nextProfile);
        setDataRequests(nextDataRequests.items);
        applyPreferences(next);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open || !account) {
      setAccountSessions([]);
      setAccountSessionsError("");
      return;
    }
    let active = true;
    void fetch("/api/v1/account/sessions")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load active account sessions");
        return await response.json() as { items: AccountSession[] };
      })
      .then((result) => { if (active) setAccountSessions(result.items); })
      .catch((error: unknown) => { if (active) setAccountSessionsError(error instanceof Error ? error.message : "Could not load active account sessions"); });
    return () => { active = false; };
  }, [open, account]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  function applyPreferences(next: Settings) {
    document.documentElement.classList.toggle("theme-light", next.theme === "light");
    document.documentElement.classList.toggle("theme-dark", next.theme === "dark");
    document.documentElement.dataset.reducedMotion = next.reducedMotion ? "true" : "false";
  }

  async function saveStatus() {
    if (!profile) return;
    const response = await fetch("/api/v1/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ statusMessage: profile.statusMessage }) });
    if (response.ok) { setProfile(await response.json() as Profile); flashProfileSaved(); }
  }

  function flashProfileSaved() { setProfileSaved(true); window.setTimeout(() => setProfileSaved(false), 1600); }

  function chooseAvatar(file: File) {
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) return;
    setCropFile(file);
    setCropPreviewUrl(URL.createObjectURL(file));
    setCropZoom(1);
    setCropOffsetX(0);
    setCropOffsetY(0);
  }

  async function cropAvatar(file: File, zoom: number, offsetX: number, offsetY: number) {
    const bitmap = await createImageBitmap(file);
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    const geometry = avatarCropGeometry(bitmap.width, bitmap.height, size, zoom, offsetX, offsetY);
    context.drawImage(bitmap, geometry.x, geometry.y, geometry.width, geometry.height);
    bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Crop failed")), "image/jpeg", 0.9));
    return new File([blob], "avatar.jpg", { type: "image/jpeg" });
  }

  async function uploadAvatar(file: File) {
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) return;
    const response = await fetch("/api/v1/profile/avatar", { method: "POST", headers: { "Content-Type": file.type }, body: file });
    if (response.ok) { setProfile(await response.json() as Profile); flashProfileSaved(); }
  }

  async function confirmAvatarCrop() {
    if (!cropFile) return;
    setCropBusy(true);
    try { await uploadAvatar(await cropAvatar(cropFile, cropZoom, cropOffsetX, cropOffsetY)); cancelAvatarCrop(); } finally { setCropBusy(false); }
  }

  function cancelAvatarCrop() {
    if (cropPreviewUrl) URL.revokeObjectURL(cropPreviewUrl);
    setCropFile(null);
    setCropPreviewUrl("");
  }

  async function removeAvatar() {
    const response = await fetch("/api/v1/profile/avatar", { method: "DELETE" });
    if (response.ok) { setProfile(await response.json() as Profile); flashProfileSaved(); }
  }

  async function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    applyPreferences(next);
    setSaved(false);
    const response = await fetch("/api/v1/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: value }) });
    if (response.ok) { setSaved(true); window.setTimeout(() => setSaved(false), 1600); }
  }

  async function downloadData() {
    setDataActionError("");
    setDataActionBusy(true);
    try {
      const response = await fetch("/api/v1/data/export");
      if (!response.ok) throw new Error("Could not prepare your export");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "go-chat-data-export.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch { setDataActionError("Your export could not be prepared. Try again in a moment."); } finally { setDataActionBusy(false); }
  }

  async function submitDeletionRequest() {
    if (deletionConfirm !== "DELETE MY DATA") return;
    setDataActionError("");
    setDataActionBusy(true);
    try {
      const response = await fetch("/api/v1/data/deletion-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: deletionConfirm }) });
      const body = await response.json() as DataRightsRequest | { message?: string };
      if (!response.ok) throw new Error("message" in body ? body.message : "Could not submit the request");
      setDataRequests((current) => [body as DataRightsRequest, ...current]);
      setDeletionConfirm("");
    } catch (error) { setDataActionError(error instanceof Error ? error.message : "Could not submit the request"); } finally { setDataActionBusy(false); }
  }

  async function revokeAccountSession(session: AccountSession) {
    setAccountSessionBusy(session.id);
    setAccountSessionsError("");
    try {
      const response = await fetch(`/api/v1/account/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      const result = await response.json() as { currentSession?: boolean; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Could not revoke this session");
      setAccountSessions((current) => current.filter((item) => item.id !== session.id));
      if (result.currentSession) onCurrentSessionRevoked?.();
    } catch (error) {
      setAccountSessionsError(error instanceof Error ? error.message : "Could not revoke this session");
    } finally {
      setAccountSessionBusy("");
    }
  }

  async function sendVerificationEmail() {
    setVerificationBusy(true);
    setAccountNotice("");
    try {
      const response = await fetch("/api/v1/account/email/verification", { method: "POST" });
      const result = await response.json() as { message?: string; verified?: boolean };
      if (!response.ok) throw new Error(result.message ?? "Could not send a verification email");
      setAccountNotice(result.verified ? "This recovery email is already verified." : "Verification email sent. Check your inbox.");
    } catch (error) {
      setAccountNotice(error instanceof Error ? error.message : "Could not send a verification email");
    } finally {
      setVerificationBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="settings-console fixed inset-0 z-30 flex justify-end" role="dialog" aria-modal="true" aria-label="Settings">
      <ConsoleSurfaceStyles />
      <button type="button" className="absolute inset-0 cursor-default" onClick={close} aria-label="Close settings by clicking outside" />
      <aside className="settings-console__sheet relative h-full w-full max-w-md overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <header className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-[var(--signal-soft)] text-[var(--signal)]"><Settings2 className="size-5" /></div>
            <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Preferences</p><h2 className="mt-1 text-xl font-semibold">Settings</h2></div>
          </div>
          <button ref={closeButtonRef} type="button" onClick={close} aria-label="Close settings" className="grid size-9 place-items-center rounded-xl border border-[var(--border)]"><X className="size-4" /></button>
        </header>
        {loading ? <p className="mt-8 text-sm text-[var(--muted)]">Loading your preferences…</p> : <div className="mt-8 space-y-7">
          {profile && <section className="space-y-3">
            <div className="flex items-center gap-2"><UserRound className="size-4 text-[var(--signal)]" /><h3 className="text-sm font-semibold">Your profile</h3></div>
            <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-3">
              <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-2xl bg-[var(--signal-soft)] text-[var(--signal)]">{profile.avatarUrl ? <img src={profile.avatarUrl} alt="Your avatar" className="size-full object-cover" /> : <UserRound className="size-6" />}</div>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold"><Camera className="size-3.5" />Upload avatar<input type="file" accept="image/*" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) chooseAvatar(file); event.target.value = ""; }} /></label>
              {profile.avatarUrl && <button type="button" onClick={() => void removeAvatar()} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--warning)]"><X className="size-3.5" />Remove avatar</button>}
            </div>
            {cropFile && <div className="space-y-3 rounded-2xl border border-[var(--signal)]/30 bg-[var(--signal-soft)] p-3">
              <p className="text-xs font-semibold">Crop your avatar</p>
              <div className="mx-auto aspect-square size-48 overflow-hidden rounded-2xl border-4 border-white bg-[var(--canvas)] shadow-inner"><img src={cropPreviewUrl} alt="Square avatar crop preview" className="size-full object-cover" style={{ transform: `translate(${cropOffsetX / 2}px, ${cropOffsetY / 2}px) scale(${cropZoom})` }} /></div>
              <Range label="Zoom" min="1" max="2.5" step="0.05" value={cropZoom} onChange={setCropZoom} ariaLabel="Avatar crop zoom" />
              <Range label="Horizontal position" min="-128" max="128" step="1" value={cropOffsetX} onChange={setCropOffsetX} ariaLabel="Avatar crop horizontal position" />
              <Range label="Vertical position" min="-128" max="128" step="1" value={cropOffsetY} onChange={setCropOffsetY} ariaLabel="Avatar crop vertical position" />
              <div className="flex gap-2"><button type="button" onClick={cancelAvatarCrop} className="flex-1 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold">Cancel</button><button type="button" onClick={() => void confirmAvatarCrop()} disabled={cropBusy} className="flex-1 rounded-xl bg-[var(--signal)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{cropBusy ? "Cropping…" : "Use this crop"}</button></div>
            </div>}
            <label className="block text-xs font-medium text-[var(--muted)]">Status message<textarea value={profile.statusMessage} maxLength={140} onChange={(event) => setProfile({ ...profile, statusMessage: event.target.value })} placeholder="What are you up to?" className="mt-1 min-h-20 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--canvas)] px-3 py-2 text-sm text-[var(--foreground)]" /><span className="mt-1 block text-right text-[10px]">{profile.statusMessage.length}/140</span></label>
            <button type="button" onClick={() => void saveStatus()} className="rounded-xl bg-[var(--signal)] px-3 py-2 text-xs font-semibold text-white">Save profile</button>
            {profileSaved && <p role="status" className="text-xs font-semibold text-[var(--success)]">Profile saved</p>}
          </section>}
          {account && <section className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-4">
            <div><h3 className="text-sm font-semibold">Account security</h3><p className="mt-1 text-xs text-[var(--muted)]">@{account.username} · {account.email}</p></div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className={account.emailVerified ? "text-[var(--success)]" : "text-[var(--warning)]"}>{account.emailVerified ? "Recovery email verified" : "Recovery email not verified"}</span>{!account.emailVerified && <button type="button" onClick={() => void sendVerificationEmail()} disabled={verificationBusy} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 font-semibold disabled:opacity-50">{verificationBusy ? "Sending…" : "Send verification email"}</button>}</div>
            {accountNotice && <p role="status" className="text-xs text-[var(--muted)]">{accountNotice}</p>}
            <div className="space-y-2 border-t border-[var(--border)] pt-3"><h4 className="text-xs font-semibold">Active account sessions</h4><p className="text-[11px] leading-5 text-[var(--muted)]">Revoke account access for a browser. Its linked identity is also signed out when available.</p>
              {accountSessionsError && <p role="alert" className="text-xs text-[var(--warning)]">{accountSessionsError}</p>}
              {accountSessions.map((session) => <div key={session.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3"><span className="min-w-0"><span className="block text-xs font-semibold">{session.isCurrent ? "This browser" : "Other browser"}</span><span className="mt-1 block text-[10px] text-[var(--muted)]">Last active {new Date(session.lastSeenAt).toLocaleString()}</span></span><button type="button" onClick={() => void revokeAccountSession(session)} disabled={accountSessionBusy === session.id} className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--warning)] disabled:opacity-50">{accountSessionBusy === session.id ? "Revoking…" : "Revoke"}</button></div>)}
              {!accountSessionsError && accountSessions.length === 0 && <p className="text-xs text-[var(--muted)]">No active account sessions found.</p>}
            </div>
          </section>}
          <section><h3 className="text-sm font-semibold">Appearance</h3><div className="mt-3 grid grid-cols-3 gap-2">{(["system", "light", "dark"] as const).map((theme) => <button type="button" key={theme} onClick={() => void update("theme", theme)} className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm capitalize ${settings.theme === theme ? "border-[var(--signal)] bg-[var(--signal-soft)] text-[var(--signal)]" : "border-[var(--border)]"}`}>{theme === "light" ? <Sun className="size-4" /> : theme === "dark" ? <Moon className="size-4" /> : <Settings2 className="size-4" />}{theme}</button>)}</div></section>
          <section className="space-y-3"><h3 className="text-sm font-semibold">Conversation behavior</h3><Toggle label="Send messages on Enter" checked={settings.sendOnEnter} onChange={(value) => void update("sendOnEnter", value)} /><Toggle label="Show read receipts" checked={settings.readReceipts} onChange={(value) => void update("readReceipts", value)} /></section>
          <section className="space-y-3 rounded-2xl border border-[var(--signal)]/30 bg-[var(--signal-soft)]/35 p-4"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--signal)]" /><div><h3 className="text-sm font-semibold">Privacy checkup</h3><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Review exactly what your direct contacts can see, how alerts appear, and when shared media loads. These controls affect your private Go Chat identity, not a public profile.</p></div></div><button type="button" onClick={() => void update("privacyCheckupCompleted", true)} disabled={settings.privacyCheckupCompleted} className="rounded-xl border border-[var(--signal)] px-3 py-2 text-xs font-semibold text-[var(--signal)] disabled:cursor-default disabled:border-[var(--border)] disabled:text-[var(--muted)]">{settings.privacyCheckupCompleted ? "Review recorded" : "Mark review complete"}</button></section>
          <section className="space-y-4"><div><h3 className="text-sm font-semibold">Privacy boundaries</h3><p className="mt-1 text-xs leading-5 text-[var(--muted)]">“Direct contacts” means someone with an accepted private Go Chat session. Go Chat never creates a public profile, friend graph, or activity feed.</p></div><ChoiceField label="Online presence" value={settings.presenceVisibility} choices={visibilityChoices} onChange={(value) => void update("presenceVisibility", value as Visibility)} /><ChoiceField label="Avatar visibility" value={settings.avatarVisibility} choices={visibilityChoices} onChange={(value) => void update("avatarVisibility", value as Visibility)} /><ChoiceField label="Status visibility" value={settings.statusVisibility} choices={visibilityChoices} onChange={(value) => void update("statusVisibility", value as Visibility)} /></section>
          <section className="space-y-4"><div><h3 className="text-sm font-semibold">Notifications</h3><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Device permission remains authoritative. These controls decide what Go Chat requests from the browser when alerts are available.</p></div><Toggle label="Notifications enabled" checked={settings.notifications} onChange={(value) => void update("notifications", value)} /><ChoiceField label="Lock-screen preview" value={settings.notificationPreview} choices={previewChoices} onChange={(value) => void update("notificationPreview", value as Settings["notificationPreview"])} /><Toggle label="Play notification sound" checked={settings.notificationSound} onChange={(value) => void update("notificationSound", value)} /><div className="rounded-xl border border-[var(--border)] p-3"><Toggle label="Quiet hours" checked={settings.quietHoursEnabled} onChange={(value) => void update("quietHoursEnabled", value)} /><p className="mt-2 text-xs leading-5 text-[var(--muted)]">When enabled, Go Chat suppresses browser alert requests between these local times. Existing browser/device rules still apply.</p><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs text-[var(--muted)]">Start<input type="time" value={settings.quietHoursStart} onChange={(event) => void update("quietHoursStart", event.target.value)} className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--canvas)] px-2 py-1.5 text-sm text-[var(--foreground)]" /></label><label className="text-xs text-[var(--muted)]">End<input type="time" value={settings.quietHoursEnd} onChange={(event) => void update("quietHoursEnd", event.target.value)} className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--canvas)] px-2 py-1.5 text-sm text-[var(--foreground)]" /></label></div></div></section>
          <section className="space-y-4"><div><h3 className="text-sm font-semibold">Media and links</h3><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Shared files use expiring private URLs. Go Chat does not fetch rich external link previews, so disabled remains the protective default.</p></div><ChoiceField label="Attachment loading" value={settings.mediaAutoDownload} choices={mediaChoices} onChange={(value) => void update("mediaAutoDownload", value as Settings["mediaAutoDownload"])} /><Toggle label="Enable external link previews when available" checked={settings.linkPreviewsEnabled} onChange={(value) => void update("linkPreviewsEnabled", value)} /></section>
          <section className="space-y-3"><h3 className="text-sm font-semibold">Accessibility</h3><Toggle label="Reduce motion" checked={settings.reducedMotion} onChange={(value) => void update("reducedMotion", value)} /></section>
          {usage && <section className="space-y-3"><h3 className="text-sm font-semibold">Storage</h3><div className="flex items-center justify-between text-xs text-[var(--muted)]"><span>{usage.fileCount} shared file{usage.fileCount === 1 ? "" : "s"}</span><span>{formatBytes(usage.usedBytes)} of {formatBytes(usage.maxBytes)}</span></div><div className="h-2 overflow-hidden rounded-full bg-[var(--signal-soft)]"><div className="h-full rounded-full bg-[var(--signal)]" style={{ width: `${Math.min(100, (usage.usedBytes / usage.maxBytes) * 100)}%` }} /></div></section>}
          <section className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-4"><div className="flex items-start gap-3"><Download className="mt-0.5 size-4 shrink-0 text-[var(--signal)]" /><div><h3 className="text-sm font-semibold">Your data</h3><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Export includes messages you authored and opaque references for files you uploaded. It excludes signed links, passwords, browser sessions, and another person’s private profile details.</p></div></div><button type="button" onClick={() => void downloadData()} disabled={dataActionBusy} className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold disabled:opacity-50">{dataActionBusy ? "Preparing export…" : "Download data export"}</button><div className="border-t border-[var(--border)] pt-3"><p className="text-xs font-semibold text-[var(--warning)]">Request deletion</p><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Submitting does not erase your data immediately. It creates a tracked request with a reference code; the irreversible processing lifecycle is shown below.</p><label className="mt-3 block text-xs text-[var(--muted)]">Type <b className="text-[var(--foreground)]">DELETE MY DATA</b> to confirm<input value={deletionConfirm} onChange={(event) => setDeletionConfirm(event.target.value)} className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--foreground)]" /></label><button type="button" onClick={() => void submitDeletionRequest()} disabled={deletionConfirm !== "DELETE MY DATA" || dataActionBusy} className="mt-2 rounded-xl border border-[var(--warning)]/50 px-3 py-2 text-xs font-semibold text-[var(--warning)] disabled:opacity-50">Submit deletion request</button></div>{dataActionError && <p role="alert" className="text-xs text-[var(--warning)]">{dataActionError}</p>}{dataRequests.length > 0 && <div className="space-y-2 border-t border-[var(--border)] pt-3"><p className="text-xs font-semibold">Request history</p>{dataRequests.map((request) => <div key={request.id} className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs"><div className="flex justify-between gap-3"><span className="font-semibold capitalize">{request.kind}</span><span className="text-[var(--signal)]">{request.status}</span></div><p className="mt-1 text-[var(--muted)]">Reference {request.referenceCode} · submitted {new Date(request.createdAt).toLocaleDateString()}</p>{request.note && <p className="mt-1 text-[var(--muted)]">{request.note}</p>}</div>)}</div>}</section>
          {saved && <p role="status" className="flex items-center gap-2 text-xs font-semibold text-[var(--success)]"><Check className="size-3" />Saved</p>}
        </div>}
      </aside>
    </div>
  );
}

function Range({ label, min, max, step, value, onChange, ariaLabel }: { label: string; min: string; max: string; step: string; value: number; onChange: (value: number) => void; ariaLabel: string }) {
  return <label className="block text-xs text-[var(--muted)]">{label}<input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="mt-2 w-full accent-[var(--signal)]" aria-label={ariaLabel} /></label>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex cursor-pointer items-center justify-between rounded-xl border border-[var(--border)] px-3 py-3 text-sm"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[var(--signal)]" /></label>;
}

const visibilityChoices = [{ value: "everyone", label: "Everyone", note: "Visible to anyone who can discover your username." }, { value: "direct_contacts", label: "Direct contacts", note: "Visible only inside accepted one-to-one sessions." }, { value: "nobody", label: "Nobody", note: "Hidden from other people." }];
const previewChoices = [{ value: "full", label: "Full", note: "Sender and message text may appear in an alert." }, { value: "sender", label: "Sender only", note: "Shows who wrote without message text." }, { value: "none", label: "None", note: "Shows only a generic Go Chat alert." }];
const mediaChoices = [{ value: "always", label: "Always", note: "Load previews in a conversation." }, { value: "manual", label: "Manual", note: "Ask before loading an attachment preview." }, { value: "never", label: "Never", note: "Keep previews off; open individual files only when needed." }];

function ChoiceField({ label, value, choices, onChange }: { label: string; value: string; choices: { value: string; label: string; note: string }[]; onChange: (value: string) => void }) {
  return <fieldset><legend className="text-xs font-semibold">{label}</legend><div className="mt-2 grid gap-2">{choices.map((choice) => <button type="button" key={choice.value} onClick={() => onChange(choice.value)} className={`rounded-xl border p-3 text-left ${value === choice.value ? "border-[var(--signal)] bg-[var(--signal-soft)]" : "border-[var(--border)]"}`}><span className={`block text-xs font-semibold ${value === choice.value ? "text-[var(--signal)]" : ""}`}>{choice.label}</span><span className="mt-1 block text-xs leading-5 text-[var(--muted)]">{choice.note}</span></button>)}</div></fieldset>;
}

function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
