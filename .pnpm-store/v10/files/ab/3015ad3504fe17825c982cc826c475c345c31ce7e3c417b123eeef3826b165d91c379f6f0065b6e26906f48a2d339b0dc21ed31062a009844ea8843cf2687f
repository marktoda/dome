'use strict';

var chunkQQ5K5TZE_cjs = require('../chunk-QQ5K5TZE.cjs');
var chunkB6TOBUS6_cjs = require('../chunk-B6TOBUS6.cjs');
var chunkP3Q73CAW_cjs = require('../chunk-P3Q73CAW.cjs');
var chunkU64IJDC5_cjs = require('../chunk-U64IJDC5.cjs');

// src/server/auth.ts
var _MastraAuthProvider_decorators, _init, _a;
_MastraAuthProvider_decorators = [chunkQQ5K5TZE_cjs.InstrumentClass({
  prefix: "auth",
  excludeMethods: ["__setTools", "__setLogger", "__setTelemetry", "#log"]
})];
exports.MastraAuthProvider = class MastraAuthProvider extends (_a = chunkP3Q73CAW_cjs.MastraBase) {
  constructor(options) {
    super({
      component: "AUTH",
      name: options?.name
    });
    if (options?.authorizeUser) {
      this.authorizeUser = options.authorizeUser.bind(this);
    }
  }
  registerOptions(opts) {
    if (opts?.authorizeUser) {
      this.authorizeUser = opts.authorizeUser.bind(this);
    }
  }
};
exports.MastraAuthProvider = /*@__PURE__*/(_ => {
  _init = chunkU64IJDC5_cjs.__decoratorStart(_a);
  exports.MastraAuthProvider = chunkU64IJDC5_cjs.__decorateElement(_init, 0, "MastraAuthProvider", _MastraAuthProvider_decorators, exports.MastraAuthProvider);
  chunkU64IJDC5_cjs.__runInitializers(_init, 1, exports.MastraAuthProvider);

  // src/server/index.ts
  return exports.MastraAuthProvider;
})();
// src/server/index.ts
function registerApiRoute(path, options) {
  if (path.startsWith("/api/")) {
    throw new chunkB6TOBUS6_cjs.MastraError({
      id: "MASTRA_SERVER_API_PATH_RESERVED",
      text: `Path must not start with "/api", it's reserved for internal API routes`,
      domain: "MASTRA_SERVER" /* MASTRA_SERVER */,
      category: "USER" /* USER */
    });
  }
  return {
    path,
    method: options.method,
    handler: options.handler,
    createHandler: options.createHandler,
    openapi: options.openapi,
    middleware: options.middleware
  };
}
function defineAuth(config) {
  return config;
}

exports.defineAuth = defineAuth;
exports.registerApiRoute = registerApiRoute;
