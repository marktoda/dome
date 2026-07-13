// product-host/home-readiness: the exact public pairing document that proves
// supervised Dome Home startup. Lifecycle callers share this parser so a
// transport success can never be mistaken for product readiness.

export async function isHomePairingReadiness(response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  try {
    const value = await response.json() as {
      readonly schema?: unknown;
      readonly available?: unknown;
      readonly paired?: unknown;
    };
    return value.schema === "dome.device.pairing/v1" &&
      value.available === true && typeof value.paired === "boolean";
  } catch {
    return false;
  }
}
