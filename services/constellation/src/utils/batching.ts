/**
 * Slices an array into smaller batches of a specified size.
 *
 * @param arr The array to slice.
 * @param size The maximum size of each batch.
 * @returns An array of batches.
 */
export function sliceIntoBatches<T>(arr: T[], size: number): T[][] {
  if (!arr || arr.length === 0) {
    return [];
  }
  if (size <= 0) {
    // Or throw an error, depending on desired behavior for invalid size
    return [arr];
  }
  if (arr.length <= size) {
    return [arr];
  }
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}
