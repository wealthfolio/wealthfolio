import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogTrigger,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  Input,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@wealthfolio/ui";

/** Custom p-0 composition matching application forms, with no backend or saved data. */
export function OverlaySafeAreaFixture() {
  const params = new URLSearchParams(location.search);
  const kind = params.get("safeArea");
  const contentSized = params.has("contentSized");
  const rowCount = contentSized ? Number(params.get("rows") ?? 0) : 30;
  const [advanced, setAdvanced] = useState(false);
  const [open, setOpen] = useState(false);
  const content = (
    <>
      <header className="shrink-0 border-b p-6">
        {kind === "dialog" ? (
          <DialogTitle>Safe area form</DialogTitle>
        ) : (
          <SheetTitle>Safe area form</SheetTitle>
        )}
        {kind === "dialog" ? (
          <DialogDescription>Synthetic form</DialogDescription>
        ) : (
          <SheetDescription>Synthetic form</SheetDescription>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Input aria-label="Asset name" placeholder="Test asset" />
        <p role="status">{advanced ? "Next step" : "First step"}</p>
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>Nested dialog</DialogTrigger>
          <DialogContent>
            <DialogTitle>Nested form</DialogTitle>
            <DialogDescription>Independent safe viewport</DialogDescription>
            <Input aria-label="Nested name" />
          </DialogContent>
        </Dialog>
        {Array.from({ length: rowCount }, (_, i) => (
          <p key={i}>Synthetic row {i + 1}</p>
        ))}
      </div>
      <div data-testid="custom-footer" className="shrink-0 border-t p-4">
        <Button className="w-full" onClick={() => setAdvanced(true)}>
          Continue
        </Button>
      </div>
    </>
  );
  const layout = `flex flex-col gap-0 overflow-hidden p-0 ${contentSized ? "" : "h-[90vh] [--overlay-max-height:90dvh]"}`;
  return (
    <main className="p-6">
      <h1>Overlay safe areas</h1>
      {kind === "dialog" ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>Open form</DialogTrigger>
          <DialogContent className={params.has("legacyHeight") ? `${layout} max-h-[50vh]` : layout}>
            {content}
          </DialogContent>
        </Dialog>
      ) : kind === "alert" ? (
        <AlertDialog>
          <AlertDialogTrigger render={<Button />}>Open form</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Safe area alert</AlertDialogTitle>
            <AlertDialogDescription>Synthetic alert</AlertDialogDescription>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger render={<Button />}>Open form</SheetTrigger>
          <SheetContent
            side={kind === "right" ? "right" : kind === "inline-end" ? "inline-end" : "bottom"}
            className={`${layout} w-full sm:max-w-lg`}
          >
            {content}
          </SheetContent>
        </Sheet>
      )}
    </main>
  );
}
