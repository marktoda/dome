import { readFile } from 'fs/promises';
import { builtinModules } from 'module';
import { join } from 'path';
import { pathToFileURL } from 'url';

// src/validator/custom-resolver.ts
var cache = /* @__PURE__ */ new Map();
function isBuiltinModule(specifier) {
  return builtinModules.includes(specifier) || specifier.startsWith("node:") || builtinModules.includes(specifier.replace(/^node:/, ""));
}
function isRelativePath(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || /^[a-zA-Z]:\\/.test(specifier);
}
async function getParentPath(specifier, url) {
  if (!cache.size) {
    const moduleResolveMap = JSON.parse(
      // cwd refers to the output/build directory
      await readFile(join(process.cwd(), "module-resolve-map.json"), "utf-8")
    );
    for (const [id, rest] of Object.entries(moduleResolveMap)) {
      cache.set(pathToFileURL(id).toString(), rest);
    }
  }
  const importers = cache.get(url);
  if (!importers || !importers[specifier]) {
    return null;
  }
  const specifierParent = importers[specifier];
  return pathToFileURL(specifierParent).toString();
}
async function resolve(specifier, context, nextResolve) {
  if (isBuiltinModule(specifier)) {
    return nextResolve(specifier, context);
  }
  if (isRelativePath(specifier)) {
    return nextResolve(specifier, context);
  }
  if (context.parentURL) {
    const parentPath = await getParentPath(specifier, context.parentURL);
    if (parentPath) {
      return nextResolve(specifier, {
        ...context,
        parentURL: parentPath
      });
    }
  }
  return nextResolve(specifier, context);
}

export { resolve };
