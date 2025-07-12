'use strict';

var chunk2KZFMI6P_cjs = require('./chunk-2KZFMI6P.cjs');

// src/server/handlers/utils.ts
function validateBody(body) {
  const errorResponse = Object.entries(body).reduce((acc, [key, value]) => {
    if (!value) {
      acc[key] = `Argument "${key}" is required`;
    }
    return acc;
  }, {});
  if (Object.keys(errorResponse).length > 0) {
    throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: Object.values(errorResponse)[0] });
  }
}

exports.validateBody = validateBody;
