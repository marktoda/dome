import { describe, test, expect } from "bun:test";
import { DOCTOR_FLAGS, DoctorFlag } from "../../src/cli/doctor-flag";

describe("DoctorFlag enum", () => {
  test("9 flags", () => { expect(DOCTOR_FLAGS.length).toBe(9); });
  test("RebuildIndex is --rebuild-index", () => {
    expect(DoctorFlag.RebuildIndex).toBe("--rebuild-index");
  });
});
