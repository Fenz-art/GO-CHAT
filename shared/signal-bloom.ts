export type ConnectionSignalState = "connected" | "reconnecting" | "disconnected";

export type SignalSignature = {
  hue: number;
  accent: string;
  secondary: string;
  glyph: string;
};

function stableHash(value: string) {
  return Array.from(value.trim().toLowerCase()).reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 5381) >>> 0;
}

export function signalSignature(value: string): SignalSignature {
  const hash = stableHash(value || "go-chat");
  const hue = 252 + (hash % 62);
  const glyphs = ["✦", "◈", "✺", "◆", "✧", "◉"];
  return {
    hue,
    accent: `hsl(${hue} 91% 68%)`,
    secondary: `hsl(${(hue + 44) % 360} 82% 61%)`,
    glyph: glyphs[hash % glyphs.length] ?? "✦",
  };
}

export function connectionSignalCopy(state: ConnectionSignalState) {
  if (state === "connected") return { label: "Signal live", detail: "Realtime channel secured" };
  if (state === "reconnecting") return { label: "Rejoining signal", detail: "Messages will reconcile" };
  return { label: "Signal paused", detail: "Reconnecting automatically" };
}

export function receiptSignalState(state: string, read = false) {
  if (state === "failed") return "failed" as const;
  if (state === "pending") return "pending" as const;
  if (read || state === "read") return "read" as const;
  if (state === "delivered") return "delivered" as const;
  return "sent" as const;
}
