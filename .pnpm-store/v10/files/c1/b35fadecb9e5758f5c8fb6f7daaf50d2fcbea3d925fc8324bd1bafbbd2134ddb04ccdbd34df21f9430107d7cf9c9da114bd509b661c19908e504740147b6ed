import { InstrumentClass } from './chunk-TC2SCOTE.js';
import { MastraBase } from './chunk-5IEKR756.js';
import { __decoratorStart, __decorateElement, __runInitializers } from './chunk-WQNOATKB.js';

// src/tts/index.ts
var _MastraTTS_decorators, _init, _a;
_MastraTTS_decorators = [InstrumentClass({
  prefix: "tts",
  excludeMethods: ["__setTools", "__setLogger", "__setTelemetry", "#log"]
})];
var MastraTTS = class extends (_a = MastraBase) {
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
MastraTTS = /*@__PURE__*/(_ => {
  _init = __decoratorStart(_a);
  MastraTTS = __decorateElement(_init, 0, "MastraTTS", _MastraTTS_decorators, MastraTTS);
  __runInitializers(_init, 1, MastraTTS);
  return MastraTTS;
})();

export { MastraTTS };
