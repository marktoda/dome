import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { ok, err, type Result, type ToolError } from "../types";

/**
 * Semver regex — keep simple. Full semver (prerelease, build metadata) is
 * documented in the spec as informational in v0.5; this schema validates the
 * 3-number form. Tighter parsing arrives with `manifest.yaml deps:`
 * resolution in v0.5.1+.
 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

export const ManifestSchema = z.object({
  name: z.string().min(1, { message: "name is required" }),
  version: z.string().regex(SEMVER_RE, { message: "version must be semver (MAJOR.MINOR.PATCH)" }),
  description: z.string().optional(),
  deps: z.array(z.string()).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Parse a manifest.yaml text into a validated Manifest. The `sourcePath` is
 * the bundle directory or filename for error messages; tests pass empty.
 *
 * Returns `Result<Manifest, ToolError>` rather than throwing. The error kind
 * is `bundle-load-failure` per the substrate's bundle-loader error taxonomy
 * (docs/wiki/specs/sdk-surface.md §"Bundle-loader error taxonomy"); the
 * `detail` discriminator is `manifest-invalid` for parse + Zod failures.
 */
export function parseManifest(yamlText: string, sourcePath = ""): Result<Manifest, ToolError> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return err({
      kind: "bundle-load-failure",
      detail: "manifest-invalid",
      message: `${sourcePath ? `${sourcePath}: ` : ""}YAML parse error: ${String(e)}`,
    });
  }
  const r = ManifestSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    const message = first
      ? `${sourcePath ? `${sourcePath}: ` : ""}${first.message}${
          first.path.length > 0 ? ` (at ${first.path.join(".")})` : ""
        }`
      : `${sourcePath ? `${sourcePath}: ` : ""}${r.error.message}`;
    return err({ kind: "bundle-load-failure", detail: "manifest-invalid", message });
  }
  return ok(r.data);
}
