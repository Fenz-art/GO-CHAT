"use client";

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Check, Compass, MessageCircleMore, ShieldCheck, X } from "lucide-react";

type WorkspaceOrientationProps = {
  open: boolean;
  onDismiss: () => void;
  onOpenDiscover: () => void;
};

const steps = [
  { eyebrow: "START A DIRECT LINE", title: "Find the person you want to reach.", copy: "Use Discover when you have a username to enter. Go Chat does not add people, groups, or suggestions for you.", icon: Compass, action: "Open Discover" },
  { eyebrow: "YOUR CHAT FIELD", title: "A direct line stays focused.", copy: "Once a chat exists, messages, delivery, media, search, retention, and safety controls stay connected to that one conversation.", icon: MessageCircleMore, action: "Continue" },
  { eyebrow: "CONTROL IN CONTEXT", title: "Keep privacy close to the chat.", copy: "Open your identity menu whenever you need preferences, privacy review, account continuity, or a session exit. This guide never changes those settings.", icon: ShieldCheck, action: "Finish" },
] as const;

export function WorkspaceOrientation({ open, onDismiss, onOpenDiscover }: WorkspaceOrientationProps) {
  const [step, setStep] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKeyDown); };
  }, [onDismiss, open]);

  const current = steps[step];
  const Icon = current.icon;
  const isLast = step === steps.length - 1;

  const continueGuide = () => {
    if (step === 0) { onOpenDiscover(); return; }
    if (isLast) { onDismiss(); return; }
    setStep((currentStep) => currentStep + 1);
  };

  return <AnimatePresence>{open && <motion.div className="workspace-orientation-wrap" role="dialog" aria-modal="true" aria-labelledby="workspace-orientation-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <button type="button" className="workspace-orientation-wrap__backdrop" aria-label="Skip workspace guide" onClick={onDismiss} />
    <motion.section className="workspace-orientation" initial={{ opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 14, scale: 0.985 }} transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}>
      <header><span>GO CHAT / QUICK ORIENTATION</span><button ref={closeRef} type="button" onClick={onDismiss} aria-label="Skip workspace guide"><X className="size-4" /></button></header>
      <div className="workspace-orientation__body"><span className="workspace-orientation__mark"><Icon className="size-5" aria-hidden="true" /></span><p className="console-eyebrow">{current.eyebrow} · {String(step + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</p><h2 id="workspace-orientation-title">{current.title}</h2><p>{current.copy}</p></div>
      <footer><button type="button" onClick={onDismiss} className="workspace-orientation__skip">Skip guide</button><button type="button" onClick={continueGuide} className="workspace-orientation__continue">{current.action}{isLast && <Check className="size-4" aria-hidden="true" />}{!isLast && <ArrowRight className="size-4" aria-hidden="true" />}</button></footer>
    </motion.section>
  </motion.div>}</AnimatePresence>;
}
