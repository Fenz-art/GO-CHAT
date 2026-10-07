"use client";

import { FormEvent, useEffect, useState } from "react";
import { KeyRound, LockKeyhole } from "lucide-react";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const resetToken = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(resetToken);
    if (resetToken) window.history.replaceState(null, "", "/reset-password/");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!token) {
      setError("This password reset link is missing or invalid.");
      return;
    }
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/v1/account/password/reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const result = await response.json() as { message?: string; reset?: boolean };
      if (!response.ok || !result.reset) throw new Error(result.message ?? "This password reset link is invalid or expired.");
      setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset your password.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="grid min-h-screen place-items-center bg-[var(--void)] p-4 text-[var(--foreground)]">
    <section className="w-full max-w-md space-y-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
      <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[var(--signal-soft)] text-[var(--signal-bright)]"><KeyRound className="size-5" /></span><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--muted)]">Account recovery</p><h1 className="text-xl font-semibold">{complete ? "Password updated" : "Choose a new password"}</h1></div></div>
      {complete ? <div role="status" className="space-y-3 text-sm leading-6 text-[var(--muted)]"><p>Your password has been changed and all account sessions have been signed out.</p><a href="/" className="inline-flex rounded-xl bg-[var(--signal)] px-4 py-2.5 font-semibold text-white">Return to Go Chat</a></div> : <form onSubmit={submit} className="space-y-4">
        <p className="text-sm leading-6 text-[var(--muted)]">Choose a password between 12 and 128 characters. The one-time link expires after 30 minutes.</p>
        <label className="block text-xs font-semibold">New password<span className="mt-1 flex items-center gap-2 rounded-xl border border-[var(--border)] px-3"><LockKeyhole className="size-4 text-[var(--muted)]" /><input required minLength={12} maxLength={128} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" /></span></label>
        <label className="block text-xs font-semibold">Confirm password<span className="mt-1 flex items-center gap-2 rounded-xl border border-[var(--border)] px-3"><LockKeyhole className="size-4 text-[var(--muted)]" /><input required minLength={12} maxLength={128} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" /></span></label>
        {error && <p role="alert" className="text-xs leading-5 text-[var(--warning)]">{error}</p>}
        <button type="submit" disabled={busy} className="w-full rounded-xl bg-[var(--signal)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Updating password…" : "Reset password"}</button>
      </form>}
    </section>
  </main>;
}
