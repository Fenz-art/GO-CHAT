"use client";

import { useCallback, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowLeft, CheckCheck, LockKeyhole, Signal } from "lucide-react";
import { AnonymousIdentity, OnboardingCard } from "@/components/onboarding-card";
import { SignalConsoleStyles } from "@/components/signal-console-styles";
import { GoChatShell } from "@/components/go-chat-shell";
import { goChatRoutes } from "@/shared/onboarding-routing";
import { completeWorkspaceHandoff } from "@/shared/workspace-handoff";

gsap.registerPlugin(useGSAP);

export function GoChatOnboarding() {
  const root = useRef<HTMLElement>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const complete = useCallback((_identity: AnonymousIdentity) => {
    completeWorkspaceHandoff(window.history);
    setWorkspaceReady(true);
  }, []);

  useGSAP(() => {
    gsap.fromTo("[data-onboarding-reveal]", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.56, stagger: 0.07, ease: "power3.out" });
  }, { scope: root });

  if (workspaceReady) return <GoChatShell />;

  return <main ref={root} className="signal-console-marketing console-onboarding-page">
    <SignalConsoleStyles />
    <div className="signal-console-page">
      <header className="console-navbar" data-onboarding-reveal>
        <a href={goChatRoutes.home} className="console-brand" aria-label="Return to Go Chat home"><span className="console-brand__mark"><Signal className="size-3.5" aria-hidden="true" /></span><span>GO <b className="console-brand__slash">/</b> CHAT</span></a>
        <a href={goChatRoutes.home} className="console-onboarding-back"><ArrowLeft className="size-3.5" aria-hidden="true" />Back to overview</a>
      </header>

      <section className="console-onboarding-shell" aria-labelledby="identity-onboarding-title">
        <aside className="console-onboarding-brief" data-onboarding-reveal>
          <p className="console-eyebrow">IDENTITY / SETUP</p>
          <h1 id="identity-onboarding-title">Set up the name behind your direct line.</h1>
          <p>This is a private setup flow, separate from the product overview. Choose a username, check that it is available, and lock it when it is right for you.</p>
          <div className="console-onboarding-rules" aria-label="Identity setup details">
            <span><i><CheckCheck className="size-3.5" /></i><b>No email is required</b><small>Start with an anonymous browser identity.</small></span>
            <span><i><LockKeyhole className="size-3.5" /></i><b>Discovery is intentional</b><small>Only someone with your username can open a direct line.</small></span>
            <span><i><Signal className="size-3.5" /></i><b>You can resume safely</b><small>Your checkpoint remains available in this browser until it is complete.</small></span>
          </div>
        </aside>
        <motion.div className="console-onboarding-workbench" data-onboarding-reveal initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}><div className="console-onboarding-workbench__top"><span>PRIVATE IDENTITY</span><span>01 / 01</span></div><OnboardingCard onComplete={complete} /></motion.div>
      </section>
    </div>
  </main>;
}
