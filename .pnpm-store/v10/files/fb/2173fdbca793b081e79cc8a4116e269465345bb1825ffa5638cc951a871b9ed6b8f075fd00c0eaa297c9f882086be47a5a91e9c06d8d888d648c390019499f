'use strict';

var chunkP3Q73CAW_cjs = require('./chunk-P3Q73CAW.cjs');
var promises = require('fs/promises');
var dotenv = require('dotenv');

var MastraBundler = class extends chunkP3Q73CAW_cjs.MastraBase {
  constructor({ name, component = "BUNDLER" }) {
    super({ component, name });
  }
  async loadEnvVars() {
    const envVars = /* @__PURE__ */ new Map();
    for (const file of await this.getEnvFiles()) {
      const content = await promises.readFile(file, "utf-8");
      const config = dotenv.parse(content);
      Object.entries(config).forEach(([key, value]) => {
        envVars.set(key, value);
      });
    }
    return envVars;
  }
};

exports.MastraBundler = MastraBundler;
