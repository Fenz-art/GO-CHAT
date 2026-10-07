"use client";

import { useRef } from "react";
import { motion } from "framer-motion";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowDownRight, CheckCheck, LockKeyhole, MessageCircleMore, Signal } from "lucide-react";
import { GoChatFeatureScenes } from "@/components/go-chat-feature-scenes";
import { SignalConsoleStyles } from "@/components/signal-console-styles";
import { goChatRoutes } from "@/shared/onboarding-routing";

gsap.registerPlugin(useGSAP);

const principles = [
  { number: "01", title: "Choose a private name", detail: "Start with a discoverable username, without an email requirement or public profile." },
  { number: "02", title: "Open one direct line", detail: "Use the name a person shares with you to begin a real one-to-one session." },
  { number: "03", title: "Keep control close", detail: "Delivery, search, media, voice, and safety controls remain tied to the line you are in." },
] as const;

export function GoChatLanding({ onSignIn }: { onSignIn: () => void }) {
  const root = useRef<HTMLElement>(null);
  useGSAP(() => {
    const sequence = gsap.timeline({ defaults: { ease: "power3.out" } });
    sequence.fromTo("[data-landing-intro]", { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.62, stagger: 0.08 })
      .fromTo("[data-landing-line]", { scaleX: 0 }, { scaleX: 1, duration: 0.7, transformOrigin: "left center", stagger: 0.06 }, "-=0.3");
  }, { scope: root });

  return <main ref={root} className="signal-console-marketing">
    <SignalConsoleStyles />
    <div className="signal-console-page">
      <header className="console-navbar" data-landing-intro>
        <a href="#top" className="console-brand" aria-label="Go Chat home"><span className="console-brand__mark"><Signal className="size-3.5" aria-hidden="true" /></span><span>GO <b className="console-brand__slash">/</b> CHAT</span></a>
        <div className="console-navbar__details"><span className="console-navbar__status"><i aria-hidden="true" />One-to-one private messaging</span><button type="button" onClick={onSignIn} className="console-navbar__action">Sign in</button><a href={goChatRoutes.onboarding} className="console-navbar__action">Create identity</a></div>
      </header>

      <section id="top" className="console-hero" aria-labelledby="landing-title">
        <div className="console-hero__copy">
          <p className="console-eyebrow" data-landing-intro>PRIVATE / DIRECT / REAL-TIME</p>
          <h1 id="landing-title" data-landing-intro>The conversation is yours.<br /><span>Keep it that way.</span></h1>
          <p className="console-hero__lede" data-landing-intro>Go Chat is a private, anonymous way to open a direct line with someone—without a public profile, a social feed, or an audience around the message.</p>
          <div className="console-hero__actions" data-landing-intro><a href={goChatRoutes.onboarding} className="console-button">Create a private identity <ArrowDownRight className="size-4" aria-hidden="true" /></a><button type="button" onClick={onSignIn} className="text-sm font-semibold text-[var(--foreground)] underline decoration-red-400/60 underline-offset-4">Sign in</button><span className="console-hero__caption">Anonymous to begin. Secure account optional.</span></div>
          <div className="console-hero__facts" data-landing-intro><span>Username-controlled discovery</span><span>Durable message history</span><span>Safety controls in context</span></div>
        </div>
        <div className="console-hero__art" aria-label="Abstract Go Chat signal illustration">
          <div className="console-spectrum" data-landing-line aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <div className="console-hero__window" data-landing-intro><div className="console-window__bar"><span>PRIVATE LINE / READY</span><span>GO CHAT</span></div><div className="console-window__body"><p>Identity</p><div className="console-window__identity"><i aria-hidden="true" /><span>Your username, your direct line.</span></div><div className="console-window__result"><span>Discovery stays intentional.</span><b>CREATE IDENTITY</b></div></div></div>
        </div>
      </section>

      <section className="console-statement" aria-labelledby="product-statement"><h2 id="product-statement" data-landing-intro>Every feature begins with a direct line.</h2><p data-landing-intro>Go Chat keeps identity, delivery, search, media, voice, and safety in the same private context: the conversation you chose to enter.</p></section>

      <section className="console-steps" aria-labelledby="how-it-works"><div className="console-section-label"><span id="how-it-works">HOW A PRIVATE LINE WORKS</span><span>01—03</span></div><div className="console-step-grid">{principles.map(({ number, title, detail }) => <motion.article key={number} className="console-step" data-landing-intro whileHover={{ y: -4 }} transition={{ duration: 0.18 }}><span className="console-step__number">{number}</span><h3>{title}</h3><p>{detail}</p></motion.article>)}</div></section>

      <GoChatFeatureScenes />

      <footer className="console-footer" data-landing-intro><span>GO CHAT / PRIVATE CONVERSATION</span><span>Built around direct lines, not public profiles.</span></footer>
    </div>
  </main>;
}
