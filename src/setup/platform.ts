export type SetupHost = Readonly<{
  platform: string;
  architecture: string;
  libc: "glibc" | "other" | null;
}>;

/** The native publication kernel is intentionally narrow and explicit. */
export function setupHostIsSupported(host: SetupHost): boolean {
  return host.platform === "darwin" ||
    (host.platform === "linux" && host.libc === "glibc");
}

export function currentSetupHost(): SetupHost {
  const platform = process.platform;
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return Object.freeze({
    platform,
    architecture: process.arch,
    libc: platform === "linux"
      ? report?.header?.glibcVersionRuntime === undefined ? "other" : "glibc"
      : null,
  });
}

export function assertSupportedSetupHost(host: SetupHost = currentSetupHost()): void {
  if (setupHostIsSupported(host)) return;
  throw new Error(
    `setup publication supports macOS and glibc Linux; observed ${host.platform}/${host.architecture}` +
    (host.platform === "linux" ? ` (${host.libc ?? "unknown libc"})` : ""),
  );
}
