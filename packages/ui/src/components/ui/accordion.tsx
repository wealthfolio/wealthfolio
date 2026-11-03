import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";

import { cn } from "../../lib/utils";
import { Icons } from "./icons";

function Accordion(props: AccordionPrimitive.Root.Props) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

interface AccordionItemProps extends Omit<AccordionPrimitive.Item.Props, "className"> {
  className?: string;
}

function AccordionItem({ className, ...props }: AccordionItemProps) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn("border-b", className)} {...props} />;
}

interface AccordionTriggerProps extends Omit<AccordionPrimitive.Trigger.Props, "className"> {
  className?: string;
}

function AccordionTrigger({ className, children, ...props }: AccordionTriggerProps) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger flex flex-1 items-center justify-between gap-6 py-4 text-start font-medium transition-all hover:underline aria-disabled:pointer-events-none aria-disabled:opacity-50 [&[data-panel-open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        {children}
        <Icons.ChevronDown
          data-slot="accordion-trigger-icon"
          className="pointer-events-none h-4 w-4 shrink-0 transition-transform duration-200"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

interface AccordionContentProps extends Omit<AccordionPrimitive.Panel.Props, "className"> {
  className?: string;
}

function AccordionContent({ className, children, ...props }: AccordionContentProps) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="h-[var(--accordion-panel-height)] overflow-hidden text-sm transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0"
      {...props}
    >
      <div className={cn("pb-4 pt-0", className)}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
