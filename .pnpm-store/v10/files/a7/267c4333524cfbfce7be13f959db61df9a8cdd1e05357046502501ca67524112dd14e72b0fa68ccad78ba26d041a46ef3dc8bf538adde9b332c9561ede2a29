'use strict';

var promises = require('fs/promises');
var module$1 = require('module');
var path = require('path');
var url = require('url');

// src/validator/custom-resolver.ts
var cache = /* @__PURE__ */ new Map();
function isBuiltinModule(specifier) {
  return module$1.builtinModules.includes(specifier) || specifier.startsWith("node:") || module$1.builtinModules.includes(specifier.replace(/^node:/, ""));
}
function isRelativePath(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || /^[a-zA-Z]:\\/.test(specifier);
}
async function getParentPath(specifier, url$1) {
  if (!cache.size) {
    const moduleResolveMap = JSON.parse(
      // cwd refers to the output/build directory
      await promises.readFile(path.join(process.cwd(), "module-resolve-map.json"), "utf-8")
    );
    for (const [id, rest] of Object.entries(moduleResolveMap)) {
      cache.set(url.pathToFileURL(id).toString(), rest);
    }
  }
  const importers = cache.get(url$1);
  if (!importers || !importers[specifier]) {
    return null;
  }
  const specifierParent = importers[specifier];
  return url.pathToFileURL(specifierParent).toString();
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

exports.resolve = resolve;
