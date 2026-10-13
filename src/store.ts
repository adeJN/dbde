import { create } from "zustand";
import type { QueryTab, Session } from "./types";
interface Workspace {
  sessions: Session[];
  tabs: QueryTab[];
  activeTab: string;
  addSession: (session: Session) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  removeSession: (id: string) => void;
  addTab: (
    connectionId: string,
    query?: string,
    name?: string,
    database?: string,
  ) => void;
  updateTab: (id: string, patch: Partial<QueryTab>) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
}
export const useWorkspace = create<Workspace>((set) => ({
  sessions: [],
  tabs: [],
  activeTab: "",
  addSession: (session) => set((s) => ({ sessions: [...s.sessions, session] })),
  updateSession: (id, patch) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    })),
  removeSession: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.connectionId !== id);
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        tabs,
        activeTab: tabs.some((t) => t.id === s.activeTab)
          ? s.activeTab
          : (tabs.at(-1)?.id ?? ""),
      };
    }),
  addTab: (
    connectionId,
    query = "-- Write a query, make a discovery.\nSELECT 1 AS hello;",
    name = "Untitled query",
    database?: string,
  ) =>
    set((s) => {
      const id = crypto.randomUUID();
      return {
        tabs: [
          ...s.tabs,
          { id, name, connectionId, database, query, running: false },
        ],
        activeTab: id,
      };
    }),
  updateTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    })),
  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        activeTab: s.activeTab === id ? (tabs.at(-1)?.id ?? "") : s.activeTab,
      };
    }),
  setActive: (activeTab) => set({ activeTab }),
}));
