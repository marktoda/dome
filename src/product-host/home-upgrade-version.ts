// product-host/home-upgrade-version: the one monotonic product-version rule.

import { gt, valid } from "semver";

export function isHomeUpgradeVersionAdvance(current: string, candidate: string): boolean {
  return valid(current) === current && valid(candidate) === candidate && gt(candidate, current);
}
