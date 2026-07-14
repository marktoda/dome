// product-host/home-upgrade-version: the one monotonic product-version rule.

import { semver } from "bun";

export function isHomeUpgradeVersionAdvance(current: string, candidate: string): boolean {
  return semver.satisfies(current, current) &&
    semver.satisfies(candidate, candidate) &&
    semver.order(candidate, current) === 1;
}
