import type { z } from "zod";

// Messages for a schema's `error` option that answer only one kind of issue,
// as zod 3's `required_error` and `invalid_type_error` did. Other issues keep
// their own messages: a plain string `error` would also replace the default
// message of checks that have none, such as a bare `.positive()`.

/** Message for a missing (undefined) value. */
export const requiredError = (message: string) => (issue: z.core.$ZodRawIssue) =>
  issue.input === undefined ? message : undefined;

/**
 * Message for a value of the wrong type, such as text in a number field. A
 * coerced number gets NaN for a missing value, so it shows this message too.
 */
export const invalidTypeError = (message: string) => (issue: z.core.$ZodRawIssue) =>
  issue.code === "invalid_type" ? message : undefined;
