"use client";

import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion, useReducedMotion } from "framer-motion";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import Lenis from "lenis";
import { Activity, Radio } from "lucide-react";
import { ConnectionSignalState, connectionSignalCopy, signalSignature } from "@/shared/signal-bloom";

gsap.registerPlugin(useGSAP);

export function SignalBloomMotion({ children }: { children: React.ReactNode }) {
  const shouldReduce = useReducedMotion();
  return <MotionConfig reducedMotion={shouldReduce ? "always" : "user"} transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}>{children}</MotionConfig>;
}

function useDocumentReducedMotion() {
  const operatingSystemPreference = useReducedMotion();
  const [applicationPreference, setApplicationPreference] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setApplicationPreference(root.dataset.reducedMotion === "true");
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-reduced-motion"] });
    return () => observer.disconnect();
  }, []);
  return Boolean(operatingSystemPreference || applicationPreference);
}

export function SmoothRelayStream({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useDocumentReducedMotion();
  useEffect(() => {
    const wrapper = ref.current;
    const content = wrapper?.firstElementChild as HTMLElement | null;
    if (!wrapper || !content || reduceMotion) return;
    const lenis = new Lenis({ wrapper, content, autoRaf: true, smoothWheel: true, syncTouch: false, lerp: 0.13, wheelMultiplier: 0.86 });
    return () => lenis.destroy();
  }, [reduceMotion]);
  return <div ref={ref} className="flex-1 overflow-y-auto overscroll-contain">{children}</div>;
}

export function SignalSignature({ value, size = "md", label }: { value: string; size?: "sm" | "md" | "lg"; label?: string }) {
  const signature = signalSignature(value);
  const sizeClass = size === "sm" ? "size-8 text-xs" : size === "lg" ? "size-14 text-xl" : "size-10 text-sm";
  return <span aria-label={label ?? `${value} signal signature`} className={`signal-signature ${sizeClass}`} style={{ "--signature": signature.accent, "--signature-secondary": signature.secondary } as React.CSSProperties}><span aria-hidden="true">{signature.glyph}</span></span>;
}

export function SignalHorizon({ state }: { state: ConnectionSignalState }) {
  const copy = connectionSignalCopy(state);
  const tone = state === "connected" ? "live" : state === "reconnecting" ? "recovering" : "paused";
  return <div className={`signal-horizon signal-horizon--${tone}`} role="status" aria-label={`${copy.label}. ${copy.detail}`}>
    <motion.span className="signal-horizon__core" animate={state === "connected" ? { opacity: [0.6, 1, 0.6] } : { opacity: 1 }} transition={{ duration: 2.4, repeat: state === "connected" ? Infinity : 0, ease: "easeInOut" }} />
    <span className="signal-horizon__copy"><Radio className="size-3" aria-hidden="true" />{copy.label}</span>
  </div>;
}

export function BloomField({ state }: { state: ConnectionSignalState }) {
  const ref = useRef<HTMLDivElement>(null);
  const shouldReduce = useReducedMotion();
  useGSAP(() => {
    if (shouldReduce || !ref.current) return;
    const intensity = state === "connected" ? 1 : state === "reconnecting" ? 0.62 : 0.35;
    gsap.to(ref.current, { "--bloom-opacity": intensity, duration: 0.6, ease: "power3.out" });
  }, { scope: ref, dependencies: [state, shouldReduce], revertOnUpdate: true });

  useEffect(() => {
    if (shouldReduce && ref.current) ref.current.style.setProperty("--bloom-opacity", "0.3");
  }, [shouldReduce]);

  return <div ref={ref} className="bloom-field" aria-hidden="true"><span className="bloom-field__orb bloom-field__orb--one" /><span className="bloom-field__orb bloom-field__orb--two" /><span className="bloom-field__grain" /></div>;
}

export function SignalStatusPill({ state }: { state: ConnectionSignalState }) {
  const copy = connectionSignalCopy(state);
  return <motion.div className={`signal-status signal-status--${state}`} layout="position" initial={false} aria-label={copy.detail}><Activity className="size-3" aria-hidden="true" /><span>{copy.label}</span></motion.div>;
}
