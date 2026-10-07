"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCheck, FileSearch, LockKeyhole, Mic, Search, ShieldCheck, Signal, UserRoundCheck } from "lucide-react";

const scenes = [
  { id: "identity", label: "Identity", title: "Start under a name you control.", body: "Create a discoverable username without an email, contact book, or public profile.", icon: UserRoundCheck },
  { id: "delivery", label: "Delivery", title: "See the state of what you send.", body: "A private message resolves through actual sent, delivered, and read states—not decorative receipts.", icon: CheckCheck },
  { id: "memory", label: "Search", title: "Return to the exact signal later.", body: "Search durable history by keyword or date, then move through real result pages.", icon: FileSearch },
  { id: "safety", label: "Control", title: "Keep an exit within reach.", body: "Mute, archive, report, or block from the conversation when you need to take control.", icon: ShieldCheck },
] as const;

type SceneId = (typeof scenes)[number]["id"];

function IdentityScene() {
  return <div className="product-proof-scene"><div className="product-proof-scene__eyebrow"><LockKeyhole className="size-3.5" />ANONYMOUS IDENTITY</div><motion.div className="product-proof-input" initial={{ width: "62%" }} animate={{ width: "100%" }} transition={{ duration: 0.5 }}><span>@ your-username</span><motion.i className="product-proof-cursor" animate={{ opacity: [0, 1, 0] }} transition={{ duration: 1.1, repeat: Infinity }} /></motion.div><motion.div className="product-proof-confirm" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.28 }}><span><UserRoundCheck className="mr-1 inline size-3.5" />Discoverable by choice</span><span>Locked once</span></motion.div></div>;
}

function DeliveryScene() {
  const states = ["Sent", "Delivered", "Read"];
  return <div className="product-proof-scene"><div className="product-proof-scene__eyebrow"><Signal className="size-3.5" />REAL-TIME DELIVERY</div><motion.div className="product-proof-message" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.35 }}>Outbound message</motion.div><div className="product-proof-receipts">{states.map((state, index) => <motion.div key={state} className="product-proof-receipt" initial={{ opacity: 0.32, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.22 + index * 0.18 }}><span><CheckCheck className="size-3.5" /></span><small>{state}</small>{index < states.length - 1 && <motion.i initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 0.34 + index * 0.18 }} />}</motion.div>)}</div></div>;
}

function MemoryScene() {
  return <div className="product-proof-scene"><div className="product-proof-scene__eyebrow"><Search className="size-3.5" />DURABLE HISTORY</div><div className="product-proof-search"><Search className="size-3.5" /><span>search a private conversation</span></div><motion.div className="product-proof-result" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}><i /><span><b>Match in message history</b><small>Keyword and date bounds</small></span><FileSearch className="size-4" /></motion.div><motion.div className="product-proof-pagination" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.46 }}><span>01—25</span><span>Next result page</span></motion.div></div>;
}

function SafetyScene() {
  return <div className="product-proof-scene"><div className="product-proof-scene__eyebrow"><ShieldCheck className="size-3.5" />CONVERSATION CONTROLS</div><motion.div className="product-proof-controls" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.42 }}><span>Pause this direct line</span><div className="product-proof-controls__actions"><motion.button type="button" whileTap={{ scale: 0.97 }}>Mute</motion.button><motion.button type="button" whileTap={{ scale: 0.97 }}>Archive</motion.button><motion.button type="button" whileTap={{ scale: 0.97 }} className="is-danger">Block</motion.button></div></motion.div><p>Actions stay visible, deliberate, and tied to the conversation you are in.</p></div>;
}

function SceneCanvas({ scene }: { scene: SceneId }) {
  if (scene === "identity") return <IdentityScene />;
  if (scene === "delivery") return <DeliveryScene />;
  if (scene === "memory") return <MemoryScene />;
  return <SafetyScene />;
}

export function GoChatFeatureScenes() {
  const [active, setActive] = useState<SceneId>("identity");
  const reduced = useReducedMotion();
  const current = scenes.find((scene) => scene.id === active) ?? scenes[0];
  return <section className="product-proofs" aria-labelledby="feature-scenes-title">
    <div className="product-proofs__head"><div><p className="console-eyebrow">CAPABILITY VIEWS / REAL PRODUCT BEHAVIOR</p><h2 id="feature-scenes-title">Every promise has a visible state.</h2></div><p>Guided product specimens explain real Go Chat behavior. They do not represent people, conversation history, or activity in the live product.</p></div>
    <div className="product-proof-frame"><div className="product-proof-tabs" role="tablist" aria-label="Go Chat feature demonstrations">{scenes.map((scene, index) => { const Icon = scene.icon; return <button key={scene.id} type="button" role="tab" id={`feature-tab-${scene.id}`} aria-selected={active === scene.id} aria-controls={`feature-panel-${scene.id}`} onClick={() => setActive(scene.id)} className={active === scene.id ? "is-active" : ""}><span className="product-proof-tabs__num">0{index + 1}</span><span><b><Icon className="mr-1 inline size-3.5" aria-hidden="true" />{scene.label}</b><small>{scene.title}</small></span></button>; })}</div><div id={`feature-panel-${active}`} role="tabpanel" aria-labelledby={`feature-tab-${active}`} className="product-proof-stage"><AnimatePresence mode="wait" initial={false}><motion.div key={active} className="product-proof-stage__canvas" initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }} transition={{ duration: reduced ? 0.01 : 0.28 }}><SceneCanvas scene={active} /></motion.div></AnimatePresence><div className="product-proof-stage__footer"><span>{current.label}</span><p>{current.body}</p></div></div></div>
  </section>;
}
