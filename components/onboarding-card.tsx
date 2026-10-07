"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, CircleAlert, LockKeyhole } from "lucide-react";
import { completedIdentityFromResume, OnboardingResumeState } from "@/shared/identity-resume";
import { workspaceOrientationKey } from "@/shared/workspace-orientation";

type Step = "idle" | "candidate" | "confirm" | "complete";
export type AnonymousIdentity = { username: string; userId: string };

function clearStaleCheckpoint() {
  window.localStorage.removeItem("gochat.onboarding.username");
  window.localStorage.removeItem("gochat.identity.userId");
}

export function OnboardingCard({ onComplete }: { onComplete: (identity: AnonymousIdentity) => void }) {
  const [step, setStep] = useState<Step>("idle");
  const [username, setUsername] = useState("");
  const [availability, setAvailability] = useState<"unknown" | "checking" | "available" | "taken">("unknown");
  const [error, setError] = useState("");
  const [locking, setLocking] = useState(false);
  const canCheck = useMemo(() => /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(username.trim()), [username]);

	useEffect(() => {
		let active = true;
		void fetch("/api/v1/onboarding/resume", { cache: "no-store" }).then(async (res) => {
			if (res.status === 401) {
				clearStaleCheckpoint();
				if (active) {
					setUsername("");
					setStep("idle");
					setError("");
				}
        return null;
      }
			if (!res.ok) {
				clearStaleCheckpoint();
				if (active) {
					setUsername("");
					setStep("idle");
					setError("We could not restore an existing identity. Reload to try again.");
				}
				return null;
			}
			return await res.json() as OnboardingResumeState;
		}).then((state) => {
			if (!active || !state) return;
			if (state.userId) window.localStorage.setItem("gochat.identity.userId", state.userId);
			const completedIdentity = completedIdentityFromResume(state);
			if (completedIdentity) { setStep("complete"); onComplete(completedIdentity); return; }
			if (state.candidateUsername) { setUsername(state.candidateUsername); setStep("candidate"); window.localStorage.setItem("gochat.onboarding.username", state.candidateUsername); return; }
			clearStaleCheckpoint();
			setUsername("");
			setStep("idle");
	    }).catch(() => {
			clearStaleCheckpoint();
	      if (active) {
				setUsername("");
				setStep("idle");
				setError("We could not restore an existing identity. Reload to try again.");
			}
	    });
    return () => { active = false; };
  }, [onComplete]);

  useEffect(() => {
    if (!canCheck) { setAvailability("unknown"); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setAvailability("checking");
      try {
        const res = await fetch(`/api/v1/identity/username/availability?username=${encodeURIComponent(username)}`, { signal: controller.signal });
        const body = await res.json() as { available?: boolean };
        setAvailability(body.available ? "available" : "taken");
      } catch { if (!controller.signal.aborted) setAvailability("unknown"); }
    }, 260);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [canCheck, username]);

  async function begin() {
    setError("");
    try {
      const res = await fetch("/api/v1/identity/bootstrap", { method: "POST" });
      if (!res.ok) throw new Error("Could not start identity");
		const body = await res.json() as { username: string; userId: string };
		setUsername(body.username); window.localStorage.setItem("gochat.onboarding.username", body.username); window.localStorage.setItem("gochat.identity.userId", body.userId); setStep("candidate");
    } catch { setError("We could not start your anonymous identity. Please try again."); }
  }

  async function lock() {
    if (locking) return;
    setLocking(true);
    setError("");
    try {
      const res = await fetch("/api/v1/onboarding/lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
		const body = await res.json().catch(() => ({})) as { locked?: boolean; onboardingStep?: string; username?: string; userId?: string; message?: string };
      if (res.status === 401) {
        window.localStorage.removeItem("gochat.onboarding.username");
        window.localStorage.removeItem("gochat.identity.userId");
        setUsername("");
        setStep("idle");
        setError("Your anonymous session expired before the name could be locked. Start a new identity to continue.");
        return;
      }
      if (!res.ok) throw new Error(body.message ?? "That username is no longer available.");
		if (body.locked !== true || body.onboardingStep !== "complete" || !body.userId || !body.username) throw new Error("The name lock did not finish. Please try again.");
		const completedIdentity = { userId: body.userId, username: body.username };
		window.localStorage.setItem("gochat.identity.userId", completedIdentity.userId);
		window.localStorage.setItem(workspaceOrientationKey(completedIdentity.userId), "pending");
			window.localStorage.setItem("gochat.onboarded", "true"); window.localStorage.removeItem("gochat.onboarding.username"); setStep("complete"); onComplete(completedIdentity);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not lock username."); setStep("candidate"); }
    finally { setLocking(false); }
  }

  if (step === "complete") return <div className="identity-command"><div className="identity-command__bar"><span>IDENTITY / COMPLETE</span><span>READY</span></div><div className="identity-command__complete"><p className="console-eyebrow"><Check className="mr-1 inline size-3.5" />IDENTITY LOCKED</p><h3>Your private line is ready.</h3><p>You can now discover a person by the username they choose to share with you.</p></div></div>;
  if (step === "idle") return <div className="identity-command"><div className="identity-command__bar"><span>IDENTITY / 01</span><span>GO CHAT</span></div><div className="identity-command__main"><p className="console-eyebrow">START HERE</p><h3>Choose a name people can find.</h3><p>We create a starting username, let you edit it, and lock it once. No email or public profile is required.</p>{error && <p className="mt-3 text-xs font-medium text-[var(--warning)]" role="alert"><CircleAlert className="mr-1 inline size-3.5" />{error}</p>}<button onClick={begin} type="button" className="identity-command__button">Create identity <ArrowRight className="size-3.5" /></button></div></div>;

  return <div className="identity-command"><div className="identity-command__bar"><span>IDENTITY / CHECKPOINT</span><span>{availability === "available" ? "AVAILABLE" : "EDIT"}</span></div><div className="identity-command__main"><p className="console-eyebrow">MAKE IT YOURS</p><h3>Set the name for your direct line.</h3><label className="identity-command__field-label" htmlFor="username">Username</label><div className="identity-command__field"><span>@</span><input id="username" value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} aria-describedby="username-help" /></div><p id="username-help" className="identity-command__help">3–32 characters. Letters, numbers, hyphens, and underscores.</p><div className="identity-command__status">{availability === "checking" && <span>Checking availability…</span>}{availability === "available" && <span className="is-good">Available for your identity</span>}{availability === "taken" && <span className="is-warn">That name is already in use</span>}{error && <span className="is-warn"><CircleAlert className="size-3.5" />{error}</span>}</div><button onClick={() => setStep("confirm")} disabled={availability !== "available" || locking} type="button" className="identity-command__button">Review lock <ArrowRight className="size-3.5" /></button>{step === "confirm" && <div className="identity-command__confirm"><p>Lock “{username}” once?</p><small>This makes the name discoverable. It cannot be changed through this onboarding flow later.</small><div className="identity-command__choice-row"><button onClick={() => setStep("candidate")} disabled={locking} type="button" className="identity-command__secondary">Not yet</button><button onClick={lock} disabled={locking} type="button" className="identity-command__button !mt-0">{locking ? "Locking name…" : <>Lock username <LockKeyhole className="size-3.5" /></>}</button></div></div>}</div></div>;
}
