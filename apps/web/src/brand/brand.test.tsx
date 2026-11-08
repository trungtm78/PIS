import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EditionProvider } from "../editions/EditionContext";
import type { WebEditionBundle } from "../editions/edition";
import { PUBLIC_BUNDLE } from "../editions/edition";
import { faviconHref } from "../editions/brand";
import { BrandMark } from "./BrandMark";
import { MARK_PALETTES, paletteOf } from "./palettes";

afterEach(() => cleanup());

const ENTERPRISE = {
  manifest: { ...PUBLIC_BUNDLE.manifest, edition: "enterprise" },
} as unknown as WebEditionBundle;

describe("the mark of the brand", () => {
  it("has two palettes that share one shape and differ in colour, and the public one is the default for an unknown edition", () => {
    expect(MARK_PALETTES.public.mark.accent).not.toBe(
      MARK_PALETTES.enterprise.mark.accent,
    );
    expect(paletteOf("enterprise")).toBe(MARK_PALETTES.enterprise);
    expect(paletteOf("anything")).toBe(MARK_PALETTES.public);
  });

  it("draws the public mark with its accessible name when labelled, and the enterprise mark in its own colours", () => {
    render(<BrandMark size={56} labelled />);
    const logo = screen.getByRole("img");
    expect(logo.getAttribute("aria-label")).toContain("Mạch Vốn");
    expect(logo.innerHTML).toContain(MARK_PALETTES.public.mark.accent);
    cleanup();
    render(
      <EditionProvider edition={ENTERPRISE}>
        <BrandMark size={34} />
      </EditionProvider>,
    );
    const hidden = document.querySelector("svg") as SVGElement;
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
    expect(hidden.getAttribute("data-edition")).toBe("enterprise");
    expect(hidden.innerHTML).toContain(MARK_PALETTES.enterprise.mark.accent);
  });

  it("links the public favicon to the icon file the PWA generator writes, drawn in the same colours as the tab icon", () => {
    const html = readFileSync(
      join(__dirname, "..", "..", "index.html"),
      "utf8",
    );
    expect(html).toContain(
      'rel="icon" type="image/svg+xml" href="/icons/icon.svg"',
    );
    expect(
      decodeURIComponent(faviconHref("public", MARK_PALETTES.public.tile)),
    ).toContain(MARK_PALETTES.public.mark.barMid);
  });
});
