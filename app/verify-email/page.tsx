"use client";

import { useEffect, useState } from "react";
import { Check, Mail } from "lucide-react";

export default function VerifyEmailPage() {
  const [status, setStatus] = useState<"loading" | "verified" | "error">("loading");
  const [message, setMessage] = useState("Checking this one-time verification link…");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("error");
      setMessage("This verification link is missing or invalid.");
      return;
    }
    window.history.replaceState(null, "", "/verify-email/");
    void fetch("/api/v1/account/email/verification/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).then(async (response) => {
      const result = await response.json() as { message?: string; verified?: boolean };
      if (!response.ok || !result.verified) throw new Error(result.message ?? "This verification link is invalid or expired.");
      setStatus("verified");
      setMessage("Your recovery email is verified. You can now request a password reset.");
    }).catch((cause: unknown) => {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "Could not verify this email address.");
    });
  }, []);

  return <main className="grid min-h-screen place-items-center bg-[var(--void)] p-4 text-[var(--foreground)]">
    <section className="w-full max-w-md space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
      <span className="grid size-10 place-items-center rounded-xl bg-[var(--signal-soft)] text-[var(--signal-bright)]">{status === "verified" ? <Check className="size-5" /> : <Mail className="size-5" />}</span>
      <div><p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--muted)]">Account recovery</p><h1 className="mt-1 text-xl font-semibold">{status === "verified" ? "Email verified" : status === "error" ? "Verification unavailable" : "Verifying email"}</h1></div>
      <p role={status === "error" ? "alert" : "status"} className="text-sm leading-6 text-[var(--muted)]">{message}</p>
      <a href="/" className="inline-flex rounded-xl bg-[var(--signal)] px-4 py-2.5 text-sm font-semibold text-white">Return to Go Chat</a>
    </section>
  </main>;
}
