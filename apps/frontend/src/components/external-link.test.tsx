import { fireEvent, render, screen } from "@/test/render";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { ExternalLink, ExternalLinkProvider } from "@wealthfolio/ui/components/ui/external-link";
import { UrlCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingStep1 } from "@/pages/onboarding/onboarding-step1";
import { ImportHelpPopover } from "@/pages/activity/import/import-help";

const openUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/adapters", () => ({ openUrlInBrowser: openUrl }));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => ({ isMobile: false }) }));

function GridUrl({ url }: { url: string }) {
  const table = useReactTable({
    data: [{ url }],
    columns: [{ accessorKey: "url" }],
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <ExternalLinkProvider openUrl={openUrl}>
      <UrlCell
        cell={table.getRowModel().rows[0].getAllCells()[0]}
        tableMeta={{}}
        rowIndex={0}
        columnId="url"
        rowHeight="short"
        isEditing={false}
        isFocused={false}
        isSelected={false}
        isSearchMatch={false}
        isActiveSearchMatch={false}
        readOnly
      />
    </ExternalLinkProvider>
  );
}

beforeEach(() => openUrl.mockClear());

describe.each(["ltr", "rtl"] as const)("external navigation (%s)", (dir) => {
  it("opens onboarding tracking-mode documentation through the adapter", () => {
    render(
      <DirectionProvider direction={dir}>
        <OnboardingStep1 />
      </DirectionProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Learn more" }));
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(
      "https://wealthfolio.app/docs/concepts/tracking-modes/",
    );
  });

  it("opens CSV import documentation through the adapter", async () => {
    render(
      <DirectionProvider direction={dir}>
        <ImportHelpPopover />
      </DirectionProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    const link = await screen.findByRole("link");
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(
      "https://wealthfolio.app/docs/concepts/activity-types",
    );
  });

  it("opens a normalized grid URL through the host's adapter", () => {
    render(
      <DirectionProvider direction={dir}>
        <GridUrl url="example.com" />
      </DirectionProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "example.com" }));
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("http://example.com");
  });
});

it("keeps rejected grid URLs from reaching the host's adapter", () => {
  render(<GridUrl url="javascript:alert(1)" />);
  expect(fireEvent.click(screen.getByText("javascript:alert(1)"))).toBe(false);
  expect(openUrl).not.toHaveBeenCalled();
});

it("leaves standalone browser links to native anchor navigation", () => {
  render(
    <ExternalLink href="https://example.com" target="_blank">
      Website
    </ExternalLink>,
  );
  expect(fireEvent.click(screen.getByRole("link"))).toBe(true);
  expect(openUrl).not.toHaveBeenCalled();
});
