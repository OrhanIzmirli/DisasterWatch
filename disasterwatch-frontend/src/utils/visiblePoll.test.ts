// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { pollWhileVisible } from "./visiblePoll";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

describe("pollWhileVisible", () => {
  it("polls while visible, pauses in a hidden tab and catches up once when it is shown again", () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 30_000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(fn).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    vi.advanceTimersByTime(10 * 60_000);
    expect(fn).toHaveBeenCalledTimes(2); // no requests from a background tab

    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not run at start in a tab that opens hidden", () => {
    setVisibility("hidden");
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 30_000);
    expect(fn).not.toHaveBeenCalled();
    stop();
  });
});
