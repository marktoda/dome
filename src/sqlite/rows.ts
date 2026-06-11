/** Map raw rows through a pure mapper and freeze the result — the standard
 *  read-accessor tail across the stores. */
export function mapRows<Raw, T>(
  rows: ReadonlyArray<Raw>,
  mapper: (row: Raw) => T,
): ReadonlyArray<T> {
  return Object.freeze(rows.map(mapper));
}
