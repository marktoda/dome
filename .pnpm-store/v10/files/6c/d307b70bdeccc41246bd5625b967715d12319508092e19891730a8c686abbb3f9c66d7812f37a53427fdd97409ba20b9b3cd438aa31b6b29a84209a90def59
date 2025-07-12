// src/commands/dev/telemetry-resolver.ts
async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@opentelemetry")) {
    return nextResolve(specifier, context);
  }
  if (!context.parentURL?.endsWith("instrumentation.mjs")) {
    return nextResolve(specifier, context);
  }
  return nextResolve(specifier, {
    ...context,
    parentURL: import.meta.url
  });
}

export { resolve };
