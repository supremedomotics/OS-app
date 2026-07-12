import { useEffect, useState } from "react";

/**
 * Fetch-on-mount + manual refresh — the app's shared pattern for "load this, swap it in when
 * ready" data. A failed fetch degrades to `null` rather than surfacing, so callers show an
 * empty/loading state instead of an error for a transient blip.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    load()
      .then((v) => live && setValue(v))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return [value, () => setN((x) => x + 1)];
}
