import { useState } from "react";
import { useToken } from "./useToken";

export function TokenGate({ children }: { children: (token: string) => React.ReactNode }): React.ReactElement {
  const { token, setToken } = useToken();
  const [draft, setDraft] = useState("");
  if (token !== null) return <>{children(token)}</>;
  return (
    <main className="gate">
      <div className="seed" aria-hidden="true" />
      <h1>Dome</h1>
      <p className="lede">Paste your access key to connect to your brain. It stays on this device.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (draft.trim().length > 0) setToken(draft.trim()); }}>
        <input
          aria-label="Access token"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          placeholder="••••••••••••"
        />
        <button type="submit">Connect</button>
      </form>
      <p className="fine">treated like a password · never shown again</p>
    </main>
  );
}
