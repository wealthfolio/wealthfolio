import { render, screen } from "@testing-library/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ProgressIndicator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@wealthfolio/ui";
import { describe, expect, it } from "vitest";

const useDesktopDialog = () => false;

describe("dialog overflow containment", () => {
  it("preserves popup attributes and preferred inline height on mobile", () => {
    render(
      <Dialog open useIsMobile={() => true}>
        <DialogContent data-testid="mobile-form" style={{ maxHeight: 500 }}>
          <DialogTitle>Mobile form</DialogTitle>
          <DialogDescription>Popup properties reach the mobile sheet</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const popup = screen.getByTestId("mobile-form");
    expect(popup).toBe(screen.getByRole("dialog"));
    // The preferred height is the part above the home indicator; the sheet runs on
    // under it to the screen's edge.
    expect(popup.style.maxHeight).toBe("calc(min(100%, 500px) + var(--sheet-safe-bottom, 0px))");
    expect(popup.style.bottom).toBe("calc(-1 * var(--sheet-safe-bottom, 0px))");
  });

  it("constrains dialog children and allows footer actions to wrap", () => {
    render(
      <Dialog open useIsMobile={useDesktopDialog}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Long dialog title</DialogTitle>
            <DialogDescription>Long dialog description</DialogDescription>
          </DialogHeader>
          <DialogFooter data-testid="dialog-footer">
            <div>
              <Button>First action</Button>
              <Button>Second action</Button>
              <Button>Third action</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog")).toHaveClass("[&>*]:min-w-0");
    expect(screen.getByTestId("dialog-footer")).toHaveClass(
      "max-sm:[&_button]:whitespace-normal",
      "max-sm:[&_button]:shrink",
      "sm:flex-wrap",
    );
  });

  it("constrains alert dialog children and allows footer actions to wrap", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Long alert title</AlertDialogTitle>
            <AlertDialogDescription>Long alert description</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter data-testid="alert-dialog-footer">
            <AlertDialogCancel>First action</AlertDialogCancel>
            <AlertDialogAction>Second action</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(screen.getByRole("alertdialog")).toHaveClass("[&>*]:min-w-0", "overflow-y-auto");
    expect(screen.getByTestId("alert-dialog-footer")).toHaveClass(
      "max-sm:[&_button]:whitespace-normal",
      "max-sm:[&_button]:shrink",
      "sm:flex-wrap",
    );
  });

  // globals.css restores max-w-* below 1024 px for these attributes only.
  it("marks side sheets for the max-width opt-out and leaves bottom sheets out", () => {
    const sideSheet = render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Side sheet</SheetTitle>
          <SheetDescription>Opens from the inline end by default</SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute("data-slot", "sheet-content");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "inline-end");
    sideSheet.unmount();

    render(
      <Dialog open useIsMobile={() => true}>
        <DialogContent>
          <DialogTitle>Mobile dialog</DialogTitle>
          <DialogDescription>Renders as a bottom sheet</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "bottom");
  });

  it("marks the progress dialog for the max-width opt-out", () => {
    render(<ProgressIndicator open title="Importing" />);

    expect(screen.getByRole("dialog")).toHaveAttribute("data-slot", "dialog-content");
  });
});
