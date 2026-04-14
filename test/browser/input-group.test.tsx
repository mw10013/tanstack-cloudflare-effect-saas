/* oxlint-disable */
import { Search } from "lucide-react";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";

describe("InputGroupAddon", () => {
  it("focuses the sibling input when the addon area is clicked", async () => {
    render(
      <InputGroup>
        <InputGroupAddon data-testid="search-addon">
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput aria-label="Search users" />
      </InputGroup>,
    );

    const input = page.getByLabelText("Search users");
    await expect.element(input).toBeInTheDocument();

    await userEvent.click(page.getByTestId("search-addon"));

    await expect.element(input).toHaveFocus();
  });

  it("does not swallow clicks on buttons inside the addon", async () => {
    let clicked = 0;
    render(
      <InputGroup>
        <InputGroupAddon>
          <button type="button" onClick={() => (clicked += 1)}>
            clear
          </button>
        </InputGroupAddon>
        <InputGroupInput aria-label="Filter" />
      </InputGroup>,
    );

    await userEvent.click(page.getByRole("button", { name: "clear" }));
    expect(clicked).toBe(1);
    await expect.element(page.getByLabelText("Filter")).not.toHaveFocus();
  });
});
