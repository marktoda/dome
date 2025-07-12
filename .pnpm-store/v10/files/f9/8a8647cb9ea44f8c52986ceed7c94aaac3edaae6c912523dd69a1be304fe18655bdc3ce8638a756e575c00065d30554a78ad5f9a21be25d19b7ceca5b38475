'use strict';

var chunkQQ5K5TZE_cjs = require('./chunk-QQ5K5TZE.cjs');
var chunkP3Q73CAW_cjs = require('./chunk-P3Q73CAW.cjs');
var chunkU64IJDC5_cjs = require('./chunk-U64IJDC5.cjs');

// src/tts/index.ts
var _MastraTTS_decorators, _init, _a;
_MastraTTS_decorators = [chunkQQ5K5TZE_cjs.InstrumentClass({
  prefix: "tts",
  excludeMethods: ["__setTools", "__setLogger", "__setTelemetry", "#log"]
})];
exports.MastraTTS = class MastraTTS extends (_a = chunkP3Q73CAW_cjs.MastraBase) {
  model;
  constructor({
    model
  }) {
    super({
      component: "TTS"
    });
    this.model = model;
  }
  traced(method, methodName) {
    return this.telemetry?.traceMethod(method, {
      spanName: `${this.model.name}-tts.${methodName}`,
      attributes: {
        "tts.type": `${this.model.name}`
      }
    }) ?? method;
  }
};
exports.MastraTTS = /*@__PURE__*/(_ => {
  _init = chunkU64IJDC5_cjs.__decoratorStart(_a);
  exports.MastraTTS = chunkU64IJDC5_cjs.__decorateElement(_init, 0, "MastraTTS", _MastraTTS_decorators, exports.MastraTTS);
  chunkU64IJDC5_cjs.__runInitializers(_init, 1, exports.MastraTTS);
  return exports.MastraTTS;
})();
