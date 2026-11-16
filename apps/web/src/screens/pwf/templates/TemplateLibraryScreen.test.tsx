import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeViolations, seriousViolations } from "../../../test/axe";
import { effectiveBody } from "../../adm/governance/test/fixtures";
import {
  ALL_PERMISSIONS,
  READ_ONLY,
  refusal,
  routeOf,
  serve,
  templateParams,
  text,
} from "../test/fixtures";
import {
  shippedEffective,
  templateCatalogue,
  templateEffective,
  templateVersion,
  uuid,
} from "./test/fixtures";
import { mountAs } from "./test/mount";
import TemplateLibraryScreen from "./TemplateLibraryScreen";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf("PWF-01");
const cite = (verification: "VERIFIED" | "UNVERIFIED") => [
  { document: "LAW_58_2024_QH15", verification },
];

interface Setup {
  permissions?: readonly string[];
  mode?: "FULL" | "READ_ONLY";
  catalogue?: unknown;
  versions?: Record<string, unknown[]>;
  effective?: Record<string, unknown>;
  projectTypes?: unknown[];
  usage?: unknown;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getGovernanceRuleCatalog: setup.catalogue ?? templateCatalogue(),
      listGovernanceRuleVersions: (input: Record<string, unknown>) => {
        const code = (input.query as { code: string }).code;
        return {
          items:
            (setup.versions ?? {
              PUBLIC_INVESTMENT: [
                templateVersion(2),
                templateVersion(1, {
                  status: "RETIRED",
                  phase: "ENDED",
                  effective_from: "2026-01-01",
                }),
              ],
              PUBLIC_REPAIR: [],
            })[code] ?? [],
        };
      },
      getEffectiveGovernanceRule: (input: Record<string, unknown>) => {
        const query = input.query as { code: string; rule_type: string };
        if (query.rule_type === "PROJECT_WORKFLOW_ASSIGNMENT") {
          return effectiveBody({
            rule_type: "PROJECT_WORKFLOW_ASSIGNMENT",
            code: "DEFAULT",
            version: 1,
            source: "RULE",
            rule_id: uuid(300),
            params: {
              lines: [
                {
                  code: "INV_CONSTRUCTION",
                  priority: 10,
                  template_code: "PUBLIC_INVESTMENT",
                  when: [
                    { field: "project_type", in: ["CONSTRUCTION", "ROADS"] },
                  ],
                },
              ],
            },
          });
        }
        return (
          (setup.effective ?? {
            PUBLIC_INVESTMENT: templateEffective(),
            PUBLIC_REPAIR: shippedEffective(),
          })[query.code] ?? refusal("GOVERNANCE_RULE_NOT_FOUND", 404)
        );
      },
      listProjectWorkflowTemplateUsage: setup.usage ?? {
        items: [{ template_code: "PUBLIC_INVESTMENT", active_projects: 7 }],
      },
    },
    {
      retireGovernanceRule: {
        resource_id: uuid(102),
        status: "RETIRED",
        resource_version: 3,
      },
    },
  );
  (h.client.readAll as ReturnType<typeof vi.fn>).mockImplementation(
    async (operation: string) =>
      operation === "searchMasterRecords" ? (setup.projectTypes ?? []) : [],
  );
  mountAs(<TemplateLibraryScreen route={route} />, h, {
    permissions: setup.permissions ?? ALL_PERMISSIONS,
    ...(setup.mode === undefined ? {} : { mode: setup.mode }),
    path: "/pwf/pwf-01",
  });
  return h;
};

const rowFor = async (code: string): Promise<HTMLElement> => {
  const cell = await waitFor(() =>
    within(screen.getByRole("table")).getByText(code),
  );
  return cell.closest("tr") as HTMLElement;
};

describe("PWF-01: the library, one row for each procedure", () => {
  it("says for each procedure its name, the kinds of project, the steps, the total time, the version in force, the projects using it and the last change", async () => {
    open({
      projectTypes: [
        {
          business_key: "CONSTRUCTION",
          label: "Xây dựng mới",
          status: "EFFECTIVE",
        },
      ],
    });
    const row = await rowFor("PUBLIC_INVESTMENT");
    expect(within(row).getByText("Mẫu bản 2")).toBeTruthy();
    // The kinds come from the template and from the mapping rule that sends projects to it.
    await waitFor(() =>
      expect(
        within(row).getByTestId("type-PUBLIC_INVESTMENT").textContent,
      ).toContain("Xây dựng mới"),
    );
    expect(
      within(row).getByTestId("type-PUBLIC_INVESTMENT").textContent,
    ).toContain("ROADS");
    expect(within(row).getByTestId("steps-PUBLIC_INVESTMENT").textContent).toBe(
      "2",
    );
    expect(within(row).getByTestId("days-PUBLIC_INVESTMENT").textContent).toBe(
      text("pwfx.lib.days", { days: 20 }),
    );
    expect(
      within(row).getByText(
        text("pwf.templates.lib.force.rule", { version: 2 }),
      ),
    ).toBeTruthy();
    expect(
      within(row).getByTestId("projects-PUBLIC_INVESTMENT").textContent,
    ).toBe("7");
    expect(
      within(row).getByTestId("last-PUBLIC_INVESTMENT").textContent,
    ).not.toBe("–");
  });

  it("names its columns", async () => {
    open();
    await rowFor("PUBLIC_INVESTMENT");
    const headers = within(screen.getByRole("table"))
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual([
      text("fix9.pwf01.col.template"),
      text("fix9.pwf01.col.type"),
      text("pwfx.lib.col.steps"),
      text("pwfx.lib.col.days"),
      text("pwfx.lib.col.state"),
      text("pwfx.lib.col.projects"),
      text("pwfx.lib.col.unverified"),
      text("pwfx.lib.col.last"),
      text("pwf.templates.col.actions.header"),
    ]);
  });

  it("counts the steps whose legal grounds nobody checked, and says nothing of a procedure whose grounds are all checked", async () => {
    const checked = templateParams({ name: "Đã đối chiếu" });
    const unchecked = templateParams({ name: "Chưa đối chiếu" });
    checked.tasks = checked.tasks.map((task) => ({
      ...task,
      legal_basis: cite("VERIFIED"),
    }));
    unchecked.tasks = unchecked.tasks.map((task, index) =>
      index === 0 ? { ...task, legal_basis: cite("UNVERIFIED") } : task,
    );
    open({
      effective: {
        PUBLIC_INVESTMENT: templateEffective({ params: checked }),
        PUBLIC_REPAIR: shippedEffective("PUBLIC_REPAIR", { params: unchecked }),
      },
    });
    const good = await rowFor("PUBLIC_INVESTMENT");
    const bad = await rowFor("PUBLIC_REPAIR");
    expect(within(good).getByText(text("fix9.pwf01.flag.none"))).toBeTruthy();
    expect(
      within(bad).getByText(text("pwfx.lib.unverified", { count: 1 })),
    ).toBeTruthy();
    expect(
      within(bad).getByText(text("pwf.common.unverified.label")),
    ).toBeTruthy();
  });

  it("shows the shipped template as the default, with no day and no usage count the server did not give", async () => {
    open();
    const repair = await rowFor("PUBLIC_REPAIR");
    expect(
      within(repair).getByText(text("pwf.templates.lib.force.default")),
    ).toBeTruthy();
    // The usage list has no line for it: the cell says 0 because the server answered; with no answer at all it says nothing.
    expect(
      within(repair).getByTestId("projects-PUBLIC_REPAIR").textContent,
    ).toBe("0");
    cleanup();
    open({ usage: refusal("INTERNAL_ERROR", 500) });
    const again = await rowFor("PUBLIC_REPAIR");
    expect(
      within(again).getByTestId("projects-PUBLIC_REPAIR").textContent,
    ).toBe("–");
  });

  it("opens, copies and retires: Open and Copy are links, Retire asks for a reason in the governance dialog", async () => {
    const h = open({
      versions: { PUBLIC_INVESTMENT: [templateVersion(2)], PUBLIC_REPAIR: [] },
    });
    await rowFor("PUBLIC_INVESTMENT");
    expect(
      screen.getByTestId("open-PUBLIC_INVESTMENT").getAttribute("href"),
    ).toBe("/pwf/pwf-02?code=PUBLIC_INVESTMENT");
    expect(
      screen.getByTestId("clone-PUBLIC_INVESTMENT").getAttribute("href"),
    ).toBe("/pwf/pwf-02?start=clone:PUBLIC_INVESTMENT");
    // A shipped template is not retired: there is no rule of the tenant to end.
    expect(screen.queryByTestId("retire-PUBLIC_REPAIR")).toBeNull();
    fireEvent.click(screen.getByTestId("retire-PUBLIC_INVESTMENT"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: text("gova1.move.retire") }),
    ).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Quy trình thay thế đã có" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: text("gova1.move.retire") }),
    );
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        "retireGovernanceRule",
        expect.objectContaining({ path: { ruleId: uuid(102) } }),
      ),
    );
    expect(await screen.findByTestId("receipt")).toBeTruthy();
  });

  it("is denied without the permission to read, and reads nothing", () => {
    const h = open({ permissions: [] });
    expect(screen.getByText(text("states.denied.title"))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("says so when the rule type has no code yet, and when the catalogue cannot be read", async () => {
    open({ catalogue: templateCatalogue({ codes: [] }) });
    expect(await screen.findByText(text("states.empty.title"))).toBeTruthy();
    cleanup();
    const h = serve({
      getGovernanceRuleCatalog: refusal("INTERNAL_ERROR", 500),
    });
    mountAs(<TemplateLibraryScreen route={route} />, h, {
      permissions: ALL_PERMISSIONS,
    });
    expect(await screen.findByText(text("states.error.title"))).toBeTruthy();
  });

  it("says that a template could not be read without hiding the others", async () => {
    const h = serve({
      getGovernanceRuleCatalog: templateCatalogue(),
      listGovernanceRuleVersions: (input: Record<string, unknown>) =>
        (input.query as { code: string }).code === "PUBLIC_REPAIR"
          ? refusal("INTERNAL_ERROR", 500)
          : { items: [templateVersion(2)] },
      getEffectiveGovernanceRule: templateEffective(),
      listProjectWorkflowTemplateUsage: { items: [] },
    });
    (h.client.readAll as ReturnType<typeof vi.fn>).mockImplementation(
      async () => [],
    );
    mountAs(<TemplateLibraryScreen route={route} />, h, {
      permissions: ALL_PERMISSIONS,
    });
    expect(await screen.findByTestId("rows-failed")).toBeTruthy();
    expect(await screen.findByText("Mẫu bản 2")).toBeTruthy();
  });
});

describe('PWF-01: "Tạo quy trình", the four ways to begin', () => {
  it("offers the shipped kinds, a copy, pasted rows and an empty procedure, each a link to the editor that writes nothing", async () => {
    const h = open();
    await rowFor("PUBLIC_INVESTMENT");
    expect(screen.queryByTestId("quick-start")).toBeNull();
    fireEvent.click(screen.getByTestId("new-template"));
    expect(screen.getByTestId("go-blank").getAttribute("href")).toBe(
      "/pwf/pwf-02?start=blank",
    );
    expect(screen.getByTestId("go-paste").getAttribute("href")).toBe(
      "/pwf/pwf-02?start=paste",
    );
    expect(screen.queryByTestId("go-builtin")).toBeNull();
    fireEvent.change(screen.getByTestId("start-builtin"), {
      target: { value: "PUBLIC_REPAIR" },
    });
    expect(screen.getByTestId("go-builtin").getAttribute("href")).toBe(
      "/pwf/pwf-02?start=builtin:PUBLIC_REPAIR",
    );
    fireEvent.change(screen.getByTestId("start-clone"), {
      target: { value: "PUBLIC_INVESTMENT" },
    });
    expect(screen.getByTestId("go-clone").getAttribute("href")).toBe(
      "/pwf/pwf-02?start=clone:PUBLIC_INVESTMENT",
    );
    expect(h.command).not.toHaveBeenCalled();
  });

  it("hides the quick start and the Copy links from a person who may only read, and when the session is read-only", async () => {
    open({ permissions: READ_ONLY });
    await rowFor("PUBLIC_INVESTMENT");
    expect(screen.queryByTestId("new-template")).toBeNull();
    expect(screen.queryByTestId("clone-PUBLIC_INVESTMENT")).toBeNull();
    expect(screen.getByTestId("open-PUBLIC_INVESTMENT")).toBeTruthy();
    cleanup();
    open({ mode: "READ_ONLY" });
    await rowFor("PUBLIC_INVESTMENT");
    expect(screen.queryByTestId("new-template")).toBeNull();
  });
});

describe("PWF-01: accessibility", () => {
  it("has no serious accessibility violation", async () => {
    open();
    await rowFor("PUBLIC_INVESTMENT");
    fireEvent.click(screen.getByTestId("new-template"));
    expect(describeViolations(await seriousViolations(document.body))).toEqual(
      [],
    );
  });
});
