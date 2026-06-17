import { useCallback, useState } from "react";

const KEY = "dome.token";

export function useToken(): { token: string | null; setToken: (t: string) => void; clear: () => void } {
  const [token, setTokenState] = useState<string | null>(() => localStorage.getItem(KEY));
  const setToken = useCallback((t: string) => { localStorage.setItem(KEY, t); setTokenState(t); }, []);
  const clear = useCallback(() => { localStorage.removeItem(KEY); setTokenState(null); }, []);
  return { token, setToken, clear };
}
