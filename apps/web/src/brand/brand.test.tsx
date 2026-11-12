import { PUBLIC_EDITION_MANIFEST } from "@machvon/kernel/src/edition.ts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EditionProvider } from "../editions/EditionContext";
import type { WebEditionBundle } from "../editions/edition";
import { PUBLIC_BUNDLE } from "../editions/edition";
import { faviconHref } from "../editions/brand";
import en from "../i18n/en.json";
import { translator } from "../i18n";
import vi from "../i18n/vi.json";
import { BrandMark } from "./BrandMark";
import { MARK_PALETTES, paletteOf } from "./palettes";

afterEach(() => {
  cleanup();
  act(() => translator.setLocale("vi"));
});

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
    // The public edition shows no code name: the label is the one the manifest holds, in the language of the screen.
    expect(logo.getAttribute("aria-label")).toBe("Biểu tượng Hệ thống quản lý đầu tư công");
    expect(logo.getAttribute("aria-label")).toBe(PUBLIC_EDITION_MANIFEST.brand.logoAlt.vi);
    expect(logo.getAttribute("aria-label")).not.toMatch(/Mạch Vốn|MACHVON/i);
    cleanup();
    act(() => translator.setLocale("en"));
    render(<BrandMark size={56} labelled />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      PUBLIC_EDITION_MANIFEST.brand.logoAlt.en,
    );
    cleanup();
    act(() => translator.setLocale("vi"));
    render(<BrandMark size={56} labelled />);
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

  it("says the brand of the public manifest in the catalogue: the logo label and the tagline of the sign-in screens, in both languages", () => {
    const labelOf = (catalogue: Record<string, string>, product: string): string =>
      (catalogue["logo.mark.alt"] ?? "").replace("{product}", product);
    expect(labelOf(vi, PUBLIC_EDITION_MANIFEST.productName.vi)).toBe(
      PUBLIC_EDITION_MANIFEST.brand.logoAlt.vi,
    );
    expect(labelOf(en, PUBLIC_EDITION_MANIFEST.productName.en)).toBe(
      PUBLIC_EDITION_MANIFEST.brand.logoAlt.en,
    );
    expect(vi["logo.tagline.public"]).toBe(PUBLIC_EDITION_MANIFEST.brand.tagline.vi);
    expect(en["logo.tagline.public"]).toBe(PUBLIC_EDITION_MANIFEST.brand.tagline.en);
    expect(vi["shell.brand.name.text"]).toBe(PUBLIC_EDITION_MANIFEST.productName.vi);
    expect(en["shell.brand.name.text"]).toBe(PUBLIC_EDITION_MANIFEST.productName.en);
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
