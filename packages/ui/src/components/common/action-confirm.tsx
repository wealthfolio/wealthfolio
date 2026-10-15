import { ReactElement, ReactNode, useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "../ui/button";
import { Icons } from "../ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface ActionConfirmProps {
  confirmMessage: string | ReactNode;
  confirmTitle: string;
  handleCancel?: () => void;
  handleConfirm: () => void;
  isPending: boolean;
  button?: ReactElement;
  confirmButtonText?: string;
  confirmButtonVariant?: ButtonProps["variant"];
  cancelButtonText?: string;
  pendingText?: string;
  side?: "top" | "right" | "bottom" | "left";
}

export const ActionConfirm = ({
  confirmMessage,
  confirmTitle,
  handleCancel,
  handleConfirm,
  button,
  isPending,
  confirmButtonText = "Confirm",
  confirmButtonVariant = "destructive",
  cancelButtonText = "Cancel",
  pendingText = "In progress...",
  side,
}: ActionConfirmProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const wasConfirming = useRef(false);

  // Close popover when action completes (isPending goes from true to false)
  useEffect(() => {
    if (wasConfirming.current && !isPending) {
      setIsOpen(false);
    }
    wasConfirming.current = isPending;
  }, [isPending]);

  return (
    <Popover open={isOpen} onOpenChange={(open) => setIsOpen(open)}>
      <PopoverTrigger
        render={
          button || (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <Icons.AlertCircle className="h-3.5 w-3.5" />
            </Button>
          )
        }
      />
      <PopoverContent className="w-80" align="end" side={side}>
        <div className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium leading-none">{confirmTitle}</h4>
            <p className="text-muted-foreground text-sm">{confirmMessage}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsOpen(false);
                handleCancel?.();
              }}
            >
              {cancelButtonText}
            </Button>
            <Button variant={confirmButtonVariant} size="sm" disabled={isPending} onClick={handleConfirm}>
              {isPending ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {pendingText}
                </>
              ) : (
                confirmButtonText
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
