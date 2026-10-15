// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FeedRow from "./FeedRow";

afterEach(cleanup);

const props = {
  typeLabel: "Wildfire",
  typeClass: "tag-wildfire",
  title: "Wildfire in Australia",
  meta: "Wildfires · 2 days ago",
  severityLabel: "● LOW",
  severityClass: "severity-low",
};

describe("FeedRow keyboard interaction", () => {
  it("is a list item holding a real button with an accessible name", () => {
    render(<ul><FeedRow {...props} onSelect={() => {}} /></ul>);
    const row = screen.getByRole("button", { name: "Wildfire: Wildfire in Australia, low" });
    expect(row.tagName).toBe("BUTTON");
    expect(row.closest("li")).not.toBeNull();
    expect(row.tabIndex).toBe(0);
    expect(screen.getByRole("listitem")).toBeTruthy();
  });

  it("Tab focuses the row; Enter and Space select it and hand back the element", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ul><FeedRow {...props} onSelect={onSelect} /></ul>);
    const row = screen.getByRole("button");
    await user.tab();
    expect(document.activeElement).toBe(row);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls[0][0]).toBe(row);
  });

  it("other keys do nothing", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ul><FeedRow {...props} onSelect={onSelect} /></ul>);
    await user.tab();
    await user.keyboard("a{ArrowDown}{Escape}");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a mouse click selects as well", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ul><FeedRow {...props} onSelect={onSelect} /></ul>);
    await user.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
