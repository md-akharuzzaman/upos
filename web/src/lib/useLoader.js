import { useCallback, useEffect, useState } from 'react';

/**
 * Loads data with `fetcher` (a stable, memoised function returning a promise),
 * re-runs when it changes or when reload() is called, and signs the user out on 401.
 */
export function useLoader(fetcher, onAuthError, initial) {
  const [state, setState] = useState({ data: initial, error: '' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    fetcher().then(
      (data) => alive && setState({ data, error: '' }),
      (err) => {
        if (!alive) return;
        if (err.status === 401) onAuthError?.();
        setState((s) => ({ ...s, error: err.message }));
      },
    );
    return () => {
      alive = false;
    };
  }, [fetcher, onAuthError, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return [state.data, reload, state.error];
}
