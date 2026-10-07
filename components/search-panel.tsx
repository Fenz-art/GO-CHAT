"use client";

import React, { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, Command, MessageSquareText, Search, UserRound, X } from "lucide-react";
import { ConsoleSurfaceStyles } from "@/components/console-surface-styles";

type Result = { kind: "user" | "message"; username: string; body?: string; messageId?: string };

function Highlight({ value, query }: { value: string; query: string }) {
  const parts = value.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return <>{parts.map((part, index) => part.toLowerCase() === query.toLowerCase() ? <mark key={`${part}-${index}`} className="bg-[var(--signal-strong)] px-0.5 text-inherit">{part}</mark> : part)}</>;
}

export function SearchPanel({ open, onClose, onSelectUsername }: { open: boolean; onClose: () => void; onSelectUsername: (username: string) => void }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"users" | "messages">("users");
  const [results, setResults] = useState<Result[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const openerRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    onClose();
    window.setTimeout(() => openerRef.current?.focus(), 0);
  }, [onClose]);

  useEffect(() => { if (!open) return; openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; const handler = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") close(); }; const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0); window.addEventListener("keydown", handler); return () => { window.clearTimeout(focusTimer); window.removeEventListener("keydown", handler); }; }, [open, close]);
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setError(""); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      try { const requestQuery = type === "users" ? query.trim().replace(/^@/, "") : query.trim(); const response = await fetch(`/api/v1/search?q=${encodeURIComponent(requestQuery)}&type=${type}`, { signal: controller.signal }); const body = await response.json() as { items?: Result[]; message?: string }; if (!response.ok) throw new Error(body.message ?? "Search unavailable"); setResults(body.items ?? []); setActiveIndex(0); } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Search unavailable"); } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 260);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, type]);

  const selected = useMemo(() => results[activeIndex], [activeIndex, results]);
  const choose = (result: Result | undefined) => { if (!result) return; onSelectUsername(result.username); setQuery(""); setResults([]); close(); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0))); } if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(current - 1, 0)); } if (event.key === "Enter") { event.preventDefault(); choose(selected); } };

  if (!open) return null;
  return <div className="command-overlay find-console" role="dialog" aria-modal="true" aria-label="Find in Go Chat"><ConsoleSurfaceStyles /><motion.div className="command-surface" initial={{ opacity: 0, y: 14, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.22 }}><header className="command-surface__head"><span><Command className="size-4" aria-hidden="true" />GO CHAT / FIND</span><button type="button" onClick={close} aria-label="Close search"><X className="size-4" /></button></header><div className="command-surface__prompt"><Search className="size-5 text-[var(--signal-bright)]" aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder={type === "users" ? "Find a username" : "Search private history"} aria-label="Search Go Chat" /><span className="command-surface__key">ESC</span></div><div className="command-surface__scope"><div role="tablist" aria-label="Search scope"><button type="button" role="tab" aria-selected={type === "users"} onClick={() => setType("users")}>People</button><button type="button" role="tab" aria-selected={type === "messages"} onClick={() => setType("messages")}>Messages</button></div><span>↑↓ navigate <i /> Enter open</span></div><div className="command-surface__results">{loading && <p className="command-empty">Searching the selected scope…</p>}{!loading && query.trim().length < 2 && <div className="command-empty"><p>Find a direct line or revisit a private exchange.</p><span>People looks up a public username. Messages searches your durable history.</span></div>}{!loading && query.trim().length >= 2 && !error && results.length === 0 && <p className="command-empty">No matching {type === "users" ? "usernames" : "messages"}.</p>}{error && <p role="alert" className="command-empty text-[var(--warning)]">{error}</p>}{results.map((result, index) => <button key={`${result.kind}-${result.messageId ?? result.username}`} type="button" onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(result)} className={`command-result ${activeIndex === index ? "is-active" : ""}`}><span className="command-result__kind">{result.kind === "user" ? <UserRound className="size-4" /> : <MessageSquareText className="size-4" />}</span><span className="min-w-0 flex-1"><b>@<Highlight value={result.username} query={query} /></b>{result.kind === "message" && <small><Highlight value={result.body ?? ""} query={query} /></small>}</span><ArrowUpRight className="size-4 text-[var(--subtle)]" aria-hidden="true" /></button>)}</div></motion.div></div>;
}
