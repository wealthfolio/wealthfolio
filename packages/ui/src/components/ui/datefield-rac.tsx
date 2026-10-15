import {
  composeRenderProps,
  DateFieldProps,
  DateField as DateFieldRac,
  DateInputProps as DateInputPropsRac,
  DateInput as DateInputRac,
  DateSegmentProps,
  DateSegment as DateSegmentRac,
  DateValue as DateValueRac,
  TimeFieldProps,
  TimeField as TimeFieldRac,
  TimeValue as TimeValueRac,
} from "react-aria-components";

import { cn } from "../../lib/utils";

function DateField<T extends DateValueRac>({ className, children, ...props }: DateFieldProps<T>) {
  return (
    <DateFieldRac className={composeRenderProps(className, (className) => cn(className))} {...props}>
      {children}
    </DateFieldRac>
  );
}

function TimeField<T extends TimeValueRac>({ className, children, ...props }: TimeFieldProps<T>) {
  return (
    <TimeFieldRac className={composeRenderProps(className, (className) => cn(className))} {...props}>
      {children}
    </TimeFieldRac>
  );
}

function DateSegment({ className, ...props }: DateSegmentProps) {
  return (
    <DateSegmentRac
      className={composeRenderProps(className, (className) =>
        cn(
          "text-foreground data-focused:bg-primary data-focused:text-primary-foreground data-focused:data-placeholder:text-primary-foreground data-invalid:data-focused:bg-destructive data-invalid:data-focused:text-destructive-foreground data-invalid:data-focused:data-placeholder:text-destructive-foreground data-invalid:data-placeholder:text-destructive data-invalid:text-destructive data-placeholder:text-muted-foreground/70 data-[type=literal]:text-muted-foreground/70 outline-hidden data-disabled:cursor-not-allowed data-disabled:opacity-50 inline rounded p-0.5 caret-transparent data-[type=literal]:px-0",
          className,
        ),
      )}
      {...props}
    />
  );
}

const dateInputStyle =
  "relative inline-flex h-input-height w-full items-center overflow-hidden whitespace-nowrap rounded-md border border-input bg-input-bg dark:bg-input/30 px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none data-focus-within:outline-solid data-focus-within:outline-2 data-focus-within:outline-offset-2 data-focus-within:outline-ring data-focus-within:has-aria-invalid:outline-destructive data-focus-within:has-aria-invalid:border-destructive";

interface DateInputProps extends DateInputPropsRac {
  className?: string;
  unstyled?: boolean;
}

function DateInput({ className, unstyled = false, ...props }: Omit<DateInputProps, "children">) {
  return (
    <DateInputRac
      className={composeRenderProps(className, (className) => cn(!unstyled && dateInputStyle, className))}
      {...props}
    >
      {(segment) => <DateSegment segment={segment} className="px-2 py-1 ring-0" />}
    </DateInputRac>
  );
}

export { DateField, DateInput, DateSegment, TimeField, dateInputStyle };
export type { DateInputProps };
