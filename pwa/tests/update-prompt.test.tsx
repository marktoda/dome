import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { UpdatePrompt } from "../src/offline/UpdatePrompt";

afterEach(cleanup);

function registration(input: { offline?: boolean; refresh?: boolean } = {}) {
  const setOffline = mock(() => {});
  const setRefresh = mock(() => {});
  const update = mock(async () => {});
  return {
    hook: () => ({
      offlineReady: [input.offline === true, setOffline] as const,
      needRefresh: [input.refresh === true, setRefresh] as const,
      updateServiceWorker: update,
    }),
    setOffline,
    setRefresh,
    update,
  };
}

describe("UpdatePrompt", () => {
  test("stays absent when the current shell is settled", () => {
    const fake = registration();
    const view = render(<UpdatePrompt useRegistration={fake.hook} />);
    expect(view.container.textContent).toBe("");
  });

  test("announces offline readiness without forcing a reload", () => {
    const fake = registration({ offline: true });
    render(<UpdatePrompt useRegistration={fake.hook} />);
    expect(screen.getByRole("status").textContent).toContain("ready for offline capture");
    expect(fake.update).not.toHaveBeenCalled();
  });

  test("activates a waiting worker only after the explicit update action", () => {
    const fake = registration({ refresh: true });
    render(<UpdatePrompt useRegistration={fake.hook} />);
    expect(fake.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(fake.update).toHaveBeenCalledWith(true);
  });
});
