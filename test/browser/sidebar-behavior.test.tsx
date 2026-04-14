/* oxlint-disable */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const renderSidebar = () =>
  render(
    <SidebarProvider>
      <Sidebar collapsible="offcanvas">
        <SidebarContent>
          <div>sidebar body</div>
        </SidebarContent>
      </Sidebar>
      <main>
        <SidebarTrigger />
        <span>main content</span>
      </main>
    </SidebarProvider>,
  );

const getSidebarEl = () =>
  document.querySelector<HTMLElement>('[data-slot="sidebar"]');

const clearSidebarCookie = () => {
  document.cookie = "sidebar_state=; path=/; max-age=0";
};

beforeEach(() => {
  window.resizeTo(1280, 800);
  clearSidebarCookie();
});

afterEach(() => {
  clearSidebarCookie();
});

describe("SidebarProvider", () => {
  it("starts expanded on desktop", async () => {
    renderSidebar();
    await expect
      .element(page.getByRole("button", { name: "Toggle Sidebar" }))
      .toBeInTheDocument();
    expect(getSidebarEl()).toHaveAttribute("data-state", "expanded");
  });

  it("toggles via the trigger and writes the sidebar_state cookie", async () => {
    renderSidebar();

    await userEvent.click(page.getByRole("button", { name: "Toggle Sidebar" }));

    const sidebar = getSidebarEl();
    expect(sidebar).toHaveAttribute("data-state", "collapsed");
    expect(document.cookie).toContain("sidebar_state=false");

    await userEvent.click(page.getByRole("button", { name: "Toggle Sidebar" }));

    expect(getSidebarEl()).toHaveAttribute("data-state", "expanded");
    expect(document.cookie).toContain("sidebar_state=true");
  });

  it("toggles with the Ctrl+B / Cmd+B shortcut", async () => {
    renderSidebar();

    await userEvent.keyboard("{Control>}b{/Control}");
    expect(getSidebarEl()).toHaveAttribute("data-state", "collapsed");

    await userEvent.keyboard("{Meta>}b{/Meta}");
    expect(getSidebarEl()).toHaveAttribute("data-state", "expanded");
  });
});
