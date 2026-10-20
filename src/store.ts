import { create } from "zustand";
import type { QueryTab, Session } from "./types";
import { connectionKey } from "./lib/connections";
interface Workspace {
  singleTab: boolean;
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
  openDatabaseTab: (connectionId: string, database: string) => void;
  closeTab: (id: string) => void;
  closeTabs: (ids: string[]) => void;
  reorderTab: (id: string, targetId: string, after?: boolean) => void;
  setActive: (id: string) => void;
}
export const useWorkspace = create<Workspace>((set) => ({
  singleTab: false,
  sessions: [],
  tabs: [],
  activeTab: "",
  addSession: (session) =>
    set((s) => {
      if (
        s.sessions.some(
          (existing) =>
            existing.id === session.id ||
            connectionKey(existing.config) === connectionKey(session.config),
        )
      )
        return s;
      return { sessions: [...s.sessions, session] };
    }),
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
      if (s.singleTab) return s;
      const id = crypto.randomUUID();
      const timeoutSecs = s.sessions.find(
        (session) => session.id === connectionId,
      )?.config.options?.query_timeout_secs;
      return {
        tabs: [
          ...s.tabs,
          {
            id,
            name,
            connectionId,
            database,
            query,
            running: false,
            ...(timeoutSecs != null ? { timeoutSecs } : {}),
          },
        ],
        activeTab: id,
      };
    }),
  openDatabaseTab: (connectionId, database) =>
    set((s) => {
      if (s.singleTab) return s;
      const existing = s.tabs.find(
        (t) =>
          t.kind === "database" &&
          t.connectionId === connectionId &&
          t.database === database,
      );
      if (existing) return { activeTab: existing.id };
      const id = crypto.randomUUID();
      const tab: QueryTab = {
        id,
        kind: "database",
        name: database,
        connectionId,
        database,
        query: "",
        running: false,
      };
      return { tabs: [...s.tabs, tab], activeTab: id };
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
  closeTabs: (ids) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => !ids.includes(t.id));
      const activeIndex = s.tabs.findIndex((t) => t.id === s.activeTab);
      const neighbor =
        s.tabs
          .slice(0, activeIndex)
          .reverse()
          .find((t) => !ids.includes(t.id)) ?? tabs[0];
      return {
        tabs,
        activeTab: tabs.some((t) => t.id === s.activeTab)
          ? s.activeTab
          : (neighbor?.id ?? ""),
      };
    }),
  reorderTab: (id, beforeId, after = false) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || id === beforeId || !s.tabs.some((t) => t.id === beforeId))
        return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      tabs.splice(
        tabs.findIndex((t) => t.id === beforeId) + (after ? 1 : 0),
        0,
        tab,
      );
      return { tabs };
    }),
}));
