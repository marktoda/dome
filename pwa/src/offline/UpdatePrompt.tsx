import { useRegisterSW } from "virtual:pwa-register/react";

type RegistrationHook = (options?: {
  readonly onRegisterError?: (error: unknown) => void;
}) => {
  readonly offlineReady: readonly [boolean, (ready: boolean) => void];
  readonly needRefresh: readonly [boolean, (needed: boolean) => void];
  readonly updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
};

/**
 * The only browser-update UI. GenerateSW stays in prompt mode, so a waiting
 * release can never replace an active capture or conversation on its own.
 */
export function UpdatePrompt({
  useRegistration = useRegisterSW as RegistrationHook,
}: {
  readonly useRegistration?: RegistrationHook;
} = {}): React.ReactElement | null {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegistration({ onRegisterError: () => {} });

  if (!offlineReady && !needRefresh) return null;
  const dismiss = (): void => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };
  return (
    <aside className="pwa-prompt" role="status" aria-live="polite">
      <span>{needRefresh ? "A Dome update is ready." : "Dome is ready for offline capture."}</span>
      {needRefresh ? (
        <button type="button" onClick={() => { void updateServiceWorker(true); }}>Update now</button>
      ) : null}
      <button type="button" aria-label="dismiss notification" onClick={dismiss}>Later</button>
    </aside>
  );
}
