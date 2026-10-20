import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import {
  HISTORY_ENABLED_KEY,
  historyEnabled,
  mergeHistory,
  readHistory,
  type HistoryEntry,
} from "../lib/query-history";
import {
  QUERY_FAVORITES_MIGRATED_KEY,
  migrateQueryFavorites,
  readSavedQueries,
  type SavedQuery,
} from "../lib/saved-queries";
import { readSnippets, type Snippet } from "../lib/snippets";
import type { TabFavorite } from "../lib/tab-actions";

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
/** Stored items plus local ones saved before the first load finished. */
function withLocal<T extends { id: string }>(loaded: T[], local: T[]) {
  const ids = new Set(loaded.map((item) => item.id));
  return [...loaded, ...local.filter((item) => !ids.has(item.id))];
}
/** Runs an API call, turning a synchronous throw into a rejected promise. */
const call = <T>(fn: () => Promise<T> | T) =>
  Promise.resolve().then(fn) as Promise<T>;

/**
 * Query history, saved queries and user snippets for one window. Writes go to the
 * shared store item by item (never whole lists), and changes from other windows
 * arrive as library events, so concurrent windows never overwrite each other.
 */
export function useQueryLibrary(
  onError: (message: string) => void,
  favorites: TabFavorite[],
) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [historyOn, setHistoryOnState] = useState(() =>
    historyEnabled(storage()),
  );
  const report = useRef(onError);
  report.current = onError;
  const favoriteList = useRef(favorites);
  favoriteList.current = favorites;
  const fail = useCallback(
    (cause: unknown) => report.current(String(cause)),
    [],
  );

  // The first load keeps anything this window recorded or saved while it ran;
  // later reloads (after changes elsewhere) replace the list.
  const reloadHistory = useCallback(
    (initial = false) =>
      call(() => api.listHistory())
        .then((list) => {
          const loaded = readHistory(list);
          setHistory((old) =>
            initial ? old.reduce(mergeHistory, loaded) : loaded,
          );
        })
        .catch(fail),
    [fail],
  );
  const reloadQueries = useCallback(
    (initial = false) =>
      call(() => api.listLibrary("saved_queries")).then((list) => {
        const loaded = readSavedQueries(list);
        setSavedQueries((old) => (initial ? withLocal(loaded, old) : loaded));
        return loaded;
      }),
    [],
  );
  const reloadSnippets = useCallback(
    (initial = false) =>
      call(() => api.listLibrary("snippets"))
        .then((list) => {
          const loaded = readSnippets(list);
          setSnippets((old) => (initial ? withLocal(loaded, old) : loaded));
        })
        .catch(fail),
    [fail],
  );

  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void reloadHistory(true);
    void reloadSnippets(true);
    void reloadQueries(true)
      .then(async (queries) => {
        const store = storage();
        if (stopped || store?.getItem(QUERY_FAVORITES_MIGRATED_KEY)) return;
        const migrated = migrateQueryFavorites(
          favoriteList.current,
          queries,
          Date.now(),
        );
        if (migrated.length) {
          await call(() => api.saveLibraryItems("saved_queries", migrated));
          if (!stopped) setSavedQueries((old) => [...old, ...migrated]);
        }
        store?.setItem(QUERY_FAVORITES_MIGRATED_KEY, "1");
      })
      .catch(fail);
    void call(() =>
      api.onLibraryChange((change) => {
        if (change.kind === "history") {
          if (change.op === "append") {
            const [entry] = readHistory([change.entry]);
            if (entry) setHistory((old) => mergeHistory(old, entry));
          } else void reloadHistory();
        } else if (change.kind === "saved_queries")
          void reloadQueries().catch(fail);
        else void reloadSnippets();
      }),
    )
      .then((stop) => {
        if (stopped) stop?.();
        else unlisten = stop ?? undefined;
      })
      .catch(() => {
        /* Without events, other windows' changes show on the next load. */
      });
    const sync = (event: StorageEvent) => {
      if (event.key === HISTORY_ENABLED_KEY)
        setHistoryOnState(event.newValue !== "false");
    };
    window.addEventListener("storage", sync);
    return () => {
      stopped = true;
      unlisten?.();
      window.removeEventListener("storage", sync);
    };
  }, [fail, reloadHistory, reloadQueries, reloadSnippets]);

  const setHistoryOn = useCallback((on: boolean) => {
    setHistoryOnState(on);
    try {
      storage()?.setItem(HISTORY_ENABLED_KEY, String(on));
    } catch {
      /* The setting lasts for this session. */
    }
  }, []);

  const recordHistory = useCallback(
    (entry: HistoryEntry) => {
      // Read the shared setting at record time so every window respects a change.
      if (!historyEnabled(storage())) return;
      setHistory((old) => mergeHistory(old, entry));
      void call(() => api.appendHistory(entry)).catch(fail);
    },
    [fail],
  );
  const deleteHistory = useCallback(
    (ids: string[]) => {
      setHistory((old) => old.filter((entry) => !ids.includes(entry.id)));
      return call(() => api.deleteHistory(ids)).catch((cause) => {
        fail(cause);
        void reloadHistory();
      });
    },
    [fail, reloadHistory],
  );
  const clearHistory = useCallback(() => {
    setHistory([]);
    return call(() => api.clearHistory()).catch((cause) => {
      fail(cause);
      void reloadHistory();
    });
  }, [fail, reloadHistory]);

  const saveQueries = useCallback(
    async (items: SavedQuery[]) => {
      setSavedQueries((old) => {
        const next = [...old];
        for (const item of items) {
          const index = next.findIndex((query) => query.id === item.id);
          if (index >= 0) next[index] = item;
          else next.push(item);
        }
        return next;
      });
      try {
        await call(() => api.saveLibraryItems("saved_queries", items));
      } catch (cause) {
        void reloadQueries().catch(fail);
        throw cause;
      }
    },
    [fail, reloadQueries],
  );
  const deleteQueries = useCallback(
    async (ids: string[]) => {
      setSavedQueries((old) => old.filter((query) => !ids.includes(query.id)));
      try {
        await call(() => api.deleteLibraryItems("saved_queries", ids));
      } catch (cause) {
        void reloadQueries().catch(fail);
        throw cause;
      }
    },
    [fail, reloadQueries],
  );
  const saveSnippet = useCallback(
    async (snippet: Snippet) => {
      const stored = { ...snippet, builtin: undefined };
      setSnippets((old) =>
        old.some((item) => item.id === stored.id)
          ? old.map((item) => (item.id === stored.id ? stored : item))
          : [...old, stored],
      );
      try {
        await call(() => api.saveLibraryItems("snippets", [stored]));
      } catch (cause) {
        void reloadSnippets();
        throw cause;
      }
    },
    [reloadSnippets],
  );
  const deleteSnippet = useCallback(
    async (id: string) => {
      setSnippets((old) => old.filter((item) => item.id !== id));
      try {
        await call(() => api.deleteLibraryItems("snippets", [id]));
      } catch (cause) {
        void reloadSnippets();
        throw cause;
      }
    },
    [reloadSnippets],
  );

  return {
    history,
    historyOn,
    setHistoryOn,
    recordHistory,
    deleteHistory,
    clearHistory,
    savedQueries,
    saveQueries,
    deleteQueries,
    snippets,
    saveSnippet,
    deleteSnippet,
  };
}
