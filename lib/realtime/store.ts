import { create } from "zustand";

export type ConnectionState = "connecting" | "connected" | "degraded" | "disconnected" | "reconnecting";

type RealtimeStore = { connectionState: ConnectionState; lastEventAt: number | null; setConnectionState: (state: ConnectionState) => void; recordEvent: () => void };

export const useRealtimeStore = create<RealtimeStore>((set) => ({
  connectionState: "disconnected",
  lastEventAt: null,
  setConnectionState: (connectionState) => set({ connectionState }),
  recordEvent: () => set({ lastEventAt: Date.now() }),
}));
