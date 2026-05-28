import { describe, expect, test } from "bun:test";

import {
  isTransientProcessorError,
  transientProcessorError,
} from "../../src/core/processor-error";

describe("transientProcessorError", () => {
  test("creates a frozen nominal retryable error", () => {
    const error = transientProcessorError("temporary outage");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("temporary outage");
    expect(error.retryable).toBe(true);
    expect(Object.isFrozen(error)).toBe(true);
    expect(isTransientProcessorError(error)).toBe(true);
  });

  test("does not trust retryable-shaped plain errors", () => {
    const shaped = Object.assign(new Error("temporary outage"), {
      retryable: true,
    });

    expect(isTransientProcessorError(shaped)).toBe(false);
  });
});
