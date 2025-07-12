'use strict';

var chunk2KZFMI6P_cjs = require('./chunk-2KZFMI6P.cjs');

// src/server/handlers/error.ts
function handleError(error, defaultMessage) {
  const apiError = error;
  const apiErrorStatus = apiError.status || apiError.details?.status || 500;
  throw new chunk2KZFMI6P_cjs.HTTPException(apiErrorStatus, {
    message: apiError.message || defaultMessage,
    stack: apiError.stack,
    cause: apiError.cause
  });
}

exports.handleError = handleError;
