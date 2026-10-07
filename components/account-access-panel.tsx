"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, LockKeyhole, Mail, UserRound, X } from "lucide-react";
import type { AnonymousIdentity } from "@/components/onboarding-card";

type Mode = "login" | "create";

export function AccountAccessPanel({ open, mode, onClose, onAuthenticated }: { open: boolean; mode: Mode; onClose: () => void; onAuthenticated: (identity: AnonymousIdentity) => void }) {
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [forgotPassword, setForgotPassword] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  const create = mode === "create";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (forgotPassword) {
        const response = await fetch("/api/v1/account/password/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
        const body = await response.json() as { message?: string };
        if (!response.ok) throw new Error(body.message ?? "Could not request password reset");
        setNotice(body.message ?? "If a verified account uses that email, password reset instructions will be sent.");
        return;
      }
      const endpoint = create ? "/api/v1/account" : "/api/v1/account/login";
      const payload = create ? { username, email, password } : { identifier, password };
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? "Could not secure your account");
      const resume = await fetch("/api/v1/onboarding/resume");
      const identity = await resume.json() as { userId?: string; username?: string; candidateUsername?: string; completed?: boolean };
      if (!resume.ok || !identity.completed || !identity.userId) throw new Error("Your account was created, but the private identity could not be resumed");
      window.localStorage.setItem("gochat.identity.userId", identity.userId);
      onAuthenticated({ userId: identity.userId, username: identity.username ?? identity.candidateUsername ?? "" });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue");
    } finally {
      setBusy(false);
    }
  }

  return <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="account-access-title">
    <button type="button" className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={close} aria-label="Close account access" />
    <section className="relative w-full max-w-md overflow-hidden border border-white/15 bg-[#0b0b0d] shadow-[0_32px_90px_rgba(0,0,0,.6)]">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-3"><span className="grid size-9 place-items-center border border-red-400/40 bg-red-500/10 text-red-300"><KeyRound className="size-4" /></span><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-red-300">Account / secure line</p><h2 id="account-access-title" className="mt-0.5 text-base font-semibold text-white">{create ? "Keep this identity" : "Return to your line"}</h2></div></div>
        <button ref={closeRef} type="button" onClick={close} className="grid size-9 place-items-center border border-white/10 text-zinc-400 transition hover:border-white/30 hover:text-white" aria-label="Close account access"><X className="size-4" /></button>
      </div>
      <form onSubmit={submit} className="space-y-4 p-5">
        <p className="text-sm leading-6 text-zinc-400">{create ? "Attach a private account to the anonymous identity already in this browser. Your direct conversations and profile stay where they are." : forgotPassword ? "Enter the verified recovery email linked to your account. If it matches, we will send a one-time reset link." : "Sign in with the account username or email you previously linked to your private identity."}</p>
        {create ? <><Field label="Account username" icon={<UserRound className="size-4" />} value={username} onChange={setUsername} autoComplete="username" placeholder="quiet-signal" /><Field label="Recovery email" icon={<Mail className="size-4" />} value={email} onChange={setEmail} autoComplete="email" type="email" placeholder="you@example.com" /></> : forgotPassword ? <Field label="Recovery email" icon={<Mail className="size-4" />} value={email} onChange={setEmail} autoComplete="email" type="email" placeholder="you@example.com" /> : <Field label="Username or email" icon={<UserRound className="size-4" />} value={identifier} onChange={setIdentifier} autoComplete="username" placeholder="Your account username" />}
        {!create && !forgotPassword && <Field label="Password" icon={<LockKeyhole className="size-4" />} value={password} onChange={setPassword} autoComplete="current-password" type="password" placeholder="Your password" />}
        {notice && <p role="status" className="border-l-2 border-emerald-400 bg-emerald-400/10 px-3 py-2 text-xs leading-5 text-emerald-100">{notice}</p>}
        {error && <p role="alert" className="border-l-2 border-red-400 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-100">{error}</p>}
        <button type="submit" disabled={busy} className="flex w-full items-center justify-between bg-red-500 px-4 py-3 text-sm font-bold text-black transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-60"><span>{busy ? "Securing your line…" : create ? "Create secure account" : forgotPassword ? "Send reset link" : "Sign in to Go Chat"}</span><span aria-hidden="true">↗</span></button>
        {!create && <button type="button" onClick={() => { setForgotPassword((current) => !current); setError(""); setNotice(""); }} className="text-xs font-semibold text-zinc-300 underline underline-offset-4">{forgotPassword ? "Back to sign in" : "Forgot password?"}</button>}
        {!forgotPassword && <p className="text-[11px] leading-5 text-zinc-500">Passwords are hashed before storage. Account access does not create a public profile or expose your direct conversations.</p>}
      </form>
    </section>
  </div>;
}

function Field({ label, icon, value, onChange, type = "text", autoComplete, placeholder }: { label: string; icon: React.ReactNode; value: string; onChange: (value: string) => void; type?: string; autoComplete: string; placeholder: string }) {
  return <label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">{label}</span><span className="flex items-center gap-2 border border-white/12 bg-white/[0.025] px-3 text-zinc-500 focus-within:border-red-300/70 focus-within:text-red-200"><span aria-hidden="true">{icon}</span><input required type={type} autoComplete={autoComplete} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-11 min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-zinc-600" /></span></label>;
}
