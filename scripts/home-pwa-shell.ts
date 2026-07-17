// Pure shared parser for the generated PWA entry asset used by both portable
// artifact rehearsal and the installed N-1→N gate.

const HASHED_PWA_ASSET = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/;

/** Return the first generated /assets entry, requiring one exact Vite hash. */
export function parsePwaShellHashedAssetPath(shellBody: string): string {
  const assetPath = shellBody.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  if (assetPath === undefined || !HASHED_PWA_ASSET.test(assetPath)) {
    throw new Error("PWA shell did not reference a hashed asset");
  }
  return assetPath;
}
