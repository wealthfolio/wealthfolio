import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@wealthfolio/ui/components/ui/tooltip";

interface HelpTooltipProps {
  content: React.ReactNode;
}

export function HelpTooltip({ content }: HelpTooltipProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger delay={300} className="ml-2 cursor-help">
          <Icons.Info className="text-muted-foreground h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent>
          <div className="max-w-xs">{content}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
