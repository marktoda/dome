export const PRODUCT_FIXTURE_CLEANUP_TIMEOUT_MS = 5_000;

export type CloseableProductFixture = Readonly<{ close: () => Promise<void> }>;

export type ProductFixtureCleanupDeps = Readonly<{
  removeRoot: (root: string) => Promise<void>;
  timeoutMs?: number;
}>;

/**
 * Release live owners before deleting any fixture root. If a close fails or
 * stalls, ownership is intentionally leaked to the OS temp directory and no
 * root is removed underneath the still-running work.
 */
export async function cleanupOwnedProductFixtures(
  hosts: CloseableProductFixture[],
  roots: string[],
  deps: ProductFixtureCleanupDeps,
): Promise<void> {
  const ownedHosts = hosts.splice(0);
  const ownedRoots = roots.splice(0);
  const failures: string[] = [];

  for (const [index, host] of ownedHosts.entries()) {
    try {
      await promiseWithin(
        host.close(),
        deps.timeoutMs ?? PRODUCT_FIXTURE_CLEANUP_TIMEOUT_MS,
        `host ${index + 1} close`,
      );
    } catch (error) {
      failures.push(publicError(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `product fixture cleanup retained ${ownedRoots.length} root(s) after `
        + `${failures.length} host close failure(s): ${failures.join("; ")}`,
    );
  }
  await Promise.all(ownedRoots.map((root) => deps.removeRoot(root)));
}

export async function closeTrackedProductFixture(
  host: CloseableProductFixture,
  hosts: CloseableProductFixture[],
  timeoutMs: number = PRODUCT_FIXTURE_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  await promiseWithin(host.close(), timeoutMs, "tracked host close");
  const index = hosts.indexOf(host);
  if (index >= 0) hosts.splice(index, 1);
}

export async function promiseWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
  operation: string,
): Promise<T> {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new RangeError("fixture timeout must be a positive integer");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${operation} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
