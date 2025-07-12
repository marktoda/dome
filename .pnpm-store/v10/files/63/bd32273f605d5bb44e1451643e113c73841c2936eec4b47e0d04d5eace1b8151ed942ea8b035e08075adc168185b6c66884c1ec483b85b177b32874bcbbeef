'use strict';

var babel = require('@babel/core');
var fs = require('fs');
var path = require('path');
var typescriptPaths = require('typescript-paths');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var babel__namespace = /*#__PURE__*/_interopNamespace(babel);
var fs__default = /*#__PURE__*/_interopDefault(fs);
var path__default = /*#__PURE__*/_interopDefault(path);

// src/build/plugins/remove-deployer.ts
function removeDeployer() {
  const t = babel__namespace.default.types;
  return {
    name: "remove-deployer",
    visitor: {
      NewExpression(path2, state) {
        const varDeclaratorPath = path2.findParent((path3) => t.isVariableDeclarator(path3.node));
        if (!varDeclaratorPath) {
          return;
        }
        const parentNode = path2.parentPath.node;
        if (!t.isVariableDeclarator(parentNode) || !t.isIdentifier(parentNode.id) || parentNode.id.name !== "mastra") {
          return;
        }
        if (!state.hasReplaced) {
          state.hasReplaced = true;
          const newMastraObj = t.cloneNode(path2.node);
          if (t.isObjectExpression(newMastraObj.arguments[0]) && newMastraObj.arguments[0].properties?.[0]) {
            const deployer = newMastraObj.arguments[0].properties.find(
              (prop) => t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.key.name === "deployer"
            );
            if (!deployer) {
              return;
            }
            newMastraObj.arguments[0].properties = newMastraObj.arguments[0].properties.filter(
              (prop) => prop !== deployer
            );
            if (t.isObjectProperty(deployer) && t.isIdentifier(deployer.value)) {
              const deployerBinding = state.file.scope.getBinding(deployer.value.name);
              if (deployerBinding) {
                deployerBinding?.path?.parentPath?.remove();
              }
            }
            path2.replaceWith(newMastraObj);
          }
        }
      }
    }
  };
}

// src/build/plugins/remove-deployer.ts
function removeDeployer2(mastraEntry) {
  return {
    name: "remove-deployer",
    transform(code, id) {
      if (id !== mastraEntry) {
        return;
      }
      return new Promise((resolve, reject) => {
        babel__namespace.transform(
          code,
          {
            babelrc: false,
            configFile: false,
            filename: id,
            plugins: [removeDeployer]
          },
          (err, result) => {
            if (err) {
              return reject(err);
            }
            resolve({
              code: result.code,
              map: result.map
            });
          }
        );
      });
    }
  };
}
var PLUGIN_NAME = "tsconfig-paths";
function tsConfigPaths({ tsConfigPath, respectCoreModule } = {}) {
  let handler;
  return {
    name: PLUGIN_NAME,
    buildStart() {
      handler = typescriptPaths.createHandler({
        log: () => {
        },
        tsConfigPath,
        respectCoreModule,
        falllback: (moduleName) => fs__default.default.existsSync(moduleName)
      });
      return;
    },
    async resolveId(request, importer, options) {
      if (!importer || request.startsWith("\0")) {
        return null;
      }
      const moduleName = handler?.(request, path.normalize(importer));
      if (!moduleName) {
        return this.resolve(request, importer, { skipSelf: true, ...options });
      }
      if (!path__default.default.extname(moduleName)) {
        return this.resolve(moduleName, importer, { skipSelf: true, ...options });
      }
      return moduleName;
    }
  };
}

exports.removeDeployer = removeDeployer2;
exports.tsConfigPaths = tsConfigPaths;
