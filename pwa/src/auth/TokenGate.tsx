import { useState } from "react";
import { useToken } from "./useToken";

export function TokenGate({ children }: { children: (token: string) => React.ReactNode }): React.ReactElement {
  const { token, setToken } = useToken();
  const [draft, setDraft] = useState("");
  if (token !== null) return <>{children(token)}</>;
  return (
    <main className="gate">
      <h1>Dome</h1>
      <form
        onSubmit={(e) => { e.preventDefault(); if (draft.trim().length > 0) setToken(draft.trim()); }}
      >
        <label htmlFor="token">Access token</label>
        <input id="token" type="password" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" />
        <button type="submit">Connect</button>
      </form>
    </main>
  );
}
