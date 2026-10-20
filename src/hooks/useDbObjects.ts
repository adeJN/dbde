import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { useWorkspace } from "../store";
import type { ObjectKind, Session } from "../types";

/**
 * Objects of one kind in a database, cached on the session so the explorer and the
 * database object list share them. Loads only while `enabled` (a group is expanded or
 * a list is shown); clearing the cache (invalidateDatabase) reloads visible lists.
 */
export function useDbObjects(
  session: Session,
  database: string,
  kind: ObjectKind,
  enabled: boolean,
) {
  const cached = session.objects?.[database]?.[kind];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  async function load() {
    const version = ++request.current;
    setLoading(true);
    setError("");
    try {
      const items = await api.listObjects(session.id, database, kind);
      if (version !== request.current) return;
      const state = useWorkspace.getState();
      const current = state.sessions.find((s) => s.id === session.id);
      if (current)
        state.updateSession(session.id, {
          objects: {
            ...current.objects,
            [database]: { ...current.objects?.[database], [kind]: items },
          },
        });
    } catch (cause) {
      if (version === request.current) setError(String(cause));
    } finally {
      if (version === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!enabled || cached || loading || error) return;
    void load();
  }, [enabled, cached, loading, error]);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  return { objects: cached, loading, error, reload: load };
}
