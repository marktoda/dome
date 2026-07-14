// product-host/home-upgrade-version: the one monotonic product-version rule.

import { gt, valid } from "semver";

export function isHomeUpgradeVersionAdvance(current: string, candidate: string): boolean {
  return isStrictSemVer(current) && isStrictSemVer(candidate) && gt(candidate, current);
}

function isStrictSemVer(value: string): boolean {
  return value === value.trim() && !value.startsWith("v") && valid(value) !== null;
}
