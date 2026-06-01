// Page-type substrate: parse and merge the small frontmatter schema language
// consumed by dome.markdown.lint-frontmatter.
//
// This is intentionally not a service and not a projection table. Bundle
// page-types are loaded at runtime-open; vault-local page-types are read by
// processors from ctx.snapshot so schema edits are candidate-bound.

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { err, ok, type Result } from "./types";

export type PageTypeFieldRule = "required" | "optional" | string;

export type PageTypeDeclaration = {
  readonly name: string;
  readonly frontmatterExtras: Readonly<Record<string, PageTypeFieldRule>>;
  readonly source: string;
};

export type PageTypeSchema = {
  readonly required: ReadonlySet<string>;
  readonly optional: ReadonlySet<string>;
};

export type PageTypeRegistry = {
  readonly types: ReadonlyMap<string, PageTypeSchema>;
  readonly enforceKnownTypes: boolean;
};

export type PageTypeParseError = {
  readonly kind: "page-types-invalid";
  readonly source: string;
  readonly message: string;
};

export type PageTypeMergeError = {
  readonly kind: "page-type-collision";
  readonly name: string;
  readonly firstSource: string;
  readonly secondSource: string;
};

const PageTypesFileSchema = z
  .object({
    defaults: z.array(z.string()).optional(),
    extensions: z
      .array(
        z
          .object({
            name: z.string().min(1),
            frontmatter_extras: z.record(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

type PageTypesFile = z.infer<typeof PageTypesFileSchema>;

export const DEFAULT_PAGE_TYPE_DECLARATIONS: ReadonlyArray<PageTypeDeclaration> =
  Object.freeze([
    pageTypeDeclaration("entity", "dome.default", {
      aliases: "optional",
      description: "optional",
      last_interaction: "optional",
      metadata: "optional",
      name: "optional",
      status: "optional",
    }),
    pageTypeDeclaration("concept", "dome.default", {
      description: "optional",
      metadata: "optional",
      name: "optional",
      status: "optional",
    }),
    pageTypeDeclaration("source", "dome.default", {
      author: "optional",
      description: "optional",
      external: "optional",
      metadata: "optional",
      name: "optional",
      published: "optional",
      url: "optional",
    }),
    pageTypeDeclaration("synthesis", "dome.default", {
      description: "optional",
      generated_from: "optional",
      metadata: "optional",
      name: "optional",
      processor: "optional",
      status: "optional",
    }),
  ]);

export const DEFAULT_PAGE_TYPE_REGISTRY: PageTypeRegistry =
  buildDefaultPageTypeRegistry();

export function parsePageTypesYaml(
  text: string,
  source: string,
): Result<ReadonlyArray<PageTypeDeclaration>, PageTypeParseError> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return err({
      kind: "page-types-invalid",
      source,
      message: `malformed YAML: ${describeError(e)}`,
    });
  }

  const parsed = PageTypesFileSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: "page-types-invalid",
      source,
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; "),
    });
  }

  return ok(pageTypeDeclarationsFromFile(parsed.data, source));
}

export function mergePageTypeDeclarations(
  declarations: ReadonlyArray<PageTypeDeclaration>,
  opts: { readonly enforceKnownTypes: boolean },
): Result<PageTypeRegistry, PageTypeMergeError> {
  const types = new Map<string, PageTypeSchema>();
  const sources = new Map<string, string>();
  for (const declaration of declarations) {
    const previous = sources.get(declaration.name);
    if (previous !== undefined) {
      return err({
        kind: "page-type-collision",
        name: declaration.name,
        firstSource: previous,
        secondSource: declaration.source,
      });
    }
    sources.set(declaration.name, declaration.source);
    types.set(declaration.name, schemaFromDeclaration(declaration));
  }

  return ok(
    Object.freeze({
      types,
      enforceKnownTypes: opts.enforceKnownTypes,
    }),
  );
}

export function extendPageTypeRegistry(
  base: PageTypeRegistry,
  declarations: ReadonlyArray<PageTypeDeclaration>,
  opts: { readonly enforceKnownTypes?: boolean } = {},
): Result<PageTypeRegistry, PageTypeMergeError> {
  const merged: PageTypeDeclaration[] = [];
  for (const [name, schema] of base.types) {
    merged.push({
      name,
      source: `base:${name}`,
      frontmatterExtras: Object.fromEntries([
        ...[...schema.required].map((field) => [field, "required"] as const),
        ...[...schema.optional].map((field) => [field, "optional"] as const),
      ]),
    });
  }
  merged.push(...declarations);
  return mergePageTypeDeclarations(merged, {
    enforceKnownTypes: opts.enforceKnownTypes ?? base.enforceKnownTypes,
  });
}

export function fieldIsRequired(rule: PageTypeFieldRule): boolean {
  return rule === "required";
}

export function pageTypeDeclaration(
  name: string,
  source: string,
  frontmatterExtras: Readonly<Record<string, PageTypeFieldRule>> = {},
): PageTypeDeclaration {
  return Object.freeze({
    name,
    source,
    frontmatterExtras,
  });
}

function pageTypeDeclarationsFromFile(
  file: PageTypesFile,
  source: string,
): ReadonlyArray<PageTypeDeclaration> {
  const declarations: PageTypeDeclaration[] = [];
  for (const extension of file.extensions ?? []) {
    declarations.push(
      pageTypeDeclaration(
        extension.name,
        source,
        extension.frontmatter_extras ?? {},
      ),
    );
  }
  return Object.freeze(declarations);
}

function schemaFromDeclaration(declaration: PageTypeDeclaration): PageTypeSchema {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [field, rule] of Object.entries(declaration.frontmatterExtras)) {
    if (fieldIsRequired(rule)) required.push(field);
    else optional.push(field);
  }
  return Object.freeze({
    required: new Set(required),
    optional: new Set(optional),
  });
}

function describeError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function buildDefaultPageTypeRegistry(): PageTypeRegistry {
  const result = mergePageTypeDeclarations(DEFAULT_PAGE_TYPE_DECLARATIONS, {
    enforceKnownTypes: false,
  });
  if (!result.ok) {
    throw new Error(`invalid built-in page types: ${result.error.name}`);
  }
  return result.value;
}
