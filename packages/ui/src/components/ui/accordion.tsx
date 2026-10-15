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
          "flex flex-1 items-center justify-between py-4 font-medium transition-all hover:underline [&[data-panel-open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        {children}
        <Icons.ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
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
      className="data-ending-style:h-0 data-starting-style:h-0 h-[var(--accordion-panel-height)] overflow-hidden text-sm transition-[height] duration-200 ease-out"
      {...props}
    >
      <div className={cn("pb-4 pt-0", className)}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
