// sqlite/row-codec: one deep home for "raw SQLite row -> frozen domain row".
//
// Every store used to hand-write a `rowToXxx` mapper that re-threaded the same
// steps — rename snake_case columns, brand ids, narrow enums, parse JSON
// columns against a schema, freeze the result. This module concentrates that
// vocabulary behind one interface so a new column or a new store is a
// declaration, not another copy of the glue.
//
// Types flow declare-and-verify: the caller keeps its authored `Domain` row
// type and its `Raw` row type, and `define<Domain>(...)` is checked field-by-
// field against `Domain` (a missing field, an extra field, or a reader that
// produces the wrong type is a compile error). Because the column-name helpers
// are keyed `keyof Raw`, a renamed column breaks the build too.

import type { z } from "zod";

import { parseEnum } from "./parse-enum";
import { parseJsonColumn } from "./row-json";

/** Context handed to every reader at map time. Carries the table name so enum
 *  / JSON readers can build the same precise `<table>.<column>` error labels the
 *  hand-written mappers used. */
export type ReaderCtx = { readonly table: string };

/** Reads one domain field out of a raw row. Row-level by design: the
 *  single-column helpers are sugar over this, and `custom` uses it directly for
 *  composite or bespoke fields. */
export type ColumnReader<Raw, V> = (row: Raw, ctx: ReaderCtx) => V;

/** A `Raw`-bound set of reader constructors plus `define`. Binding `Raw` once
 *  is what makes the column-name arguments infer and type-check against the
 *  real row shape. */
export type RowCodec<Raw> = {
  /** Copy a column through unchanged (including SQL NULL). */
  col<K extends keyof Raw>(name: K): ColumnReader<Raw, Raw[K]>;
  /** Transform a non-null column (brand an id, wrap an oid). */
  brand<K extends keyof Raw, V>(
    name: K,
    fn: (value: Raw[K]) => V,
  ): ColumnReader<Raw, V>;
  /** Transform a nullable column, mapping SQL NULL straight to `null`. */
  nullableBrand<K extends keyof Raw, V>(
    name: K,
    fn: (value: NonNullable<Raw[K]>) => V,
  ): ColumnReader<Raw, V | null>;
  /** Narrow a string column to a closed enum, throwing on corruption. */
  enumCol<K extends keyof Raw, T extends string>(
    name: K,
    allowed: ReadonlyArray<T>,
  ): ColumnReader<Raw, T>;
  /** Parse + validate a JSON column against a Zod schema, then freeze it. */
  jsonCol<K extends keyof Raw, S extends z.ZodType>(
    name: K,
    schema: S,
  ): ColumnReader<Raw, z.output<S>>;
  /** Escape hatch: build a field from the whole row (composite / bespoke). */
  custom<V>(fn: (row: Raw, ctx: ReaderCtx) => V): ColumnReader<Raw, V>;
  /** Assemble readers into a frozen `(row: Raw) => Domain` mapper. */
  define<Domain>(map: {
    readonly [K in keyof Domain]: ColumnReader<Raw, Domain[K]>;
  }): (row: Raw) => Domain;
};

export function rowCodec<Raw>(table: string): RowCodec<Raw> {
  const ctx: ReaderCtx = { table };
  const label = (name: PropertyKey): string => `${table}.${String(name)}`;

  return {
    col<K extends keyof Raw>(name: K): ColumnReader<Raw, Raw[K]> {
      return (row) => row[name];
    },

    brand<K extends keyof Raw, V>(
      name: K,
      fn: (value: Raw[K]) => V,
    ): ColumnReader<Raw, V> {
      return (row) => fn(row[name]);
    },

    nullableBrand<K extends keyof Raw, V>(
      name: K,
      fn: (value: NonNullable<Raw[K]>) => V,
    ): ColumnReader<Raw, V | null> {
      return (row) => {
        const value = row[name];
        return value === null || value === undefined
          ? null
          : fn(value as NonNullable<Raw[K]>);
      };
    },

    enumCol<K extends keyof Raw, T extends string>(
      name: K,
      allowed: ReadonlyArray<T>,
    ): ColumnReader<Raw, T> {
      return (row) => parseEnum(row[name] as string, allowed, label(name));
    },

    jsonCol<K extends keyof Raw, S extends z.ZodType>(
      name: K,
      schema: S,
    ): ColumnReader<Raw, z.output<S>> {
      return (row) => {
        const value = parseJsonColumn(row[name] as string, label(name), schema);
        // freeze is runtime-only; the cast restores the schema's output type
        // (Object.freeze widens to Readonly<...>). Matches the hand-mappers,
        // which froze the same JSON columns in place.
        return Object.freeze(value) as z.output<S>;
      };
    },

    custom<V>(fn: (row: Raw, c: ReaderCtx) => V): ColumnReader<Raw, V> {
      return fn;
    },

    define<Domain>(map: {
      readonly [K in keyof Domain]: ColumnReader<Raw, Domain[K]>;
    }): (row: Raw) => Domain {
      const entries = Object.entries(map) as Array<
        [keyof Domain, ColumnReader<Raw, Domain[keyof Domain]>]
      >;
      return (row: Raw): Domain => {
        const out = {} as { -readonly [K in keyof Domain]: Domain[K] };
        for (const [key, reader] of entries) {
          out[key] = reader(row, ctx) as Domain[typeof key];
        }
        return Object.freeze(out);
      };
    },
  };
}
