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

describe("FeedRow subtitle", () => {
  it("shows the subtitle under the title and includes it in the accessible name", () => {
    render(<ul><FeedRow {...props} subtitle="≈ 18.2°S 131.6°E · 7,652 ha · since 14 Oct" onSelect={() => {}} /></ul>);
    expect(screen.getByText("≈ 18.2°S 131.6°E · 7,652 ha · since 14 Oct").className).toBe("disaster-subtitle");
    expect(screen.getByRole("button", { name: "Wildfire: Wildfire in Australia, ≈ 18.2°S 131.6°E · 7,652 ha · since 14 Oct, low" })).toBeTruthy();
  });

  it("renders no subtitle line when there is none", () => {
    const { container } = render(<ul><FeedRow {...props} subtitle={null} onSelect={() => {}} /></ul>);
    expect(container.querySelector(".disaster-subtitle")).toBeNull();
  });
});
