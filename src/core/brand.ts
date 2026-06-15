// Single source for the branded-string idiom. A branded type is a string the
// compiler treats nominally via a phantom `__brand` tag; `brand()` is the one
// sanctioned cast site (a future tightening can validate inside it).
export type Brand<Base, Name extends string> = Base & { readonly __brand: Name };
export function brand<T extends Brand<string, string>>(s: string): T {
  return s as T;
}
