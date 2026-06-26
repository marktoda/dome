import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TokenGate } from "../src/auth/TokenGate";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("TokenGate", () => {
  test("prompts for a token when none stored, then renders children with it", () => {
    render(<TokenGate>{(t) => <div>connected:{t}</div>}</TokenGate>);
    expect(screen.getByRole("button", { name: /connect/i })).toBeDefined();
    fireEvent.change(screen.getByLabelText(/token/i), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(screen.getByText("connected:secret")).toBeDefined();
    expect(localStorage.getItem("dome.token")).toBe("secret");
  });

  test("renders children immediately when a token is already stored", () => {
    localStorage.setItem("dome.token", "pre");
    render(<TokenGate>{(t) => <div>connected:{t}</div>}</TokenGate>);
    expect(screen.getByText("connected:pre")).toBeDefined();
  });
});
