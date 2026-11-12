import { expect, it } from "vitest";
import { dashboardHtml } from "../../src/desktop/dashboard.js";

it("presents concise, truthful screen-access states with non-color cues", () => {
  const html = dashboardHtml();
  for (const text of [
    "Screen access",
    "Allows HostSpan to view and control this screen after OS approval.",
    "Waiting for screen approval",
    "Screen access is on",
    "Viewing this screen",
    "Controlling this screen",
    "Saved",
    "Current",
    "Session",
    "Restart HostSpan to apply the saved change.",
    "Technical details",
  ]) expect(html).toContain(text);
  expect(html).toContain("screen-dot");
  expect(html).toContain("border-left-width:3px");
  for (const oldText of [
    "SESSION OPEN",
    "IN USE",
    "Agent observing or controlling",
    "Screen access available",
    ">Computer use<",
  ]) expect(html).not.toContain(oldText);
});
