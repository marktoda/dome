// sqlite/parse-enum: narrow a string column into a closed enum, throwing on
// corruption. The label names the store+column so the error pinpoints the row
// source. Used by the row mappers in ledger/outbox/projections.
export function parseEnum<T extends string>(
  value: string,
  allowed: ReadonlyArray<T>,
  label: string,
): T {
  if ((allowed as ReadonlyArray<string>).includes(value)) return value as T;
  throw new Error(`${label}: unknown value '${value}'`);
}
