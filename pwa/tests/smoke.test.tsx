import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import App from "../src/App";

afterEach(cleanup);

describe("App", () => {
  test("renders the Dome heading", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Dome" })).toBeDefined();
  });
});
