import { describe, expect, it } from "vitest";
import { z } from "zod";
import { invalidTypeError, requiredError } from "./zod-errors";

const messages = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("zod error helpers", () => {
  it("answers only a missing value with the required message", () => {
    const schema = z.date({ error: requiredError("Pick a date.") });
    expect(messages(schema, undefined)).toEqual(["Pick a date."]);
    expect(messages(schema, null)).not.toContain("Pick a date.");
  });

  it("answers wrong-type input, including a missing coerced number", () => {
    const schema = z.coerce.number({ error: invalidTypeError("Enter a number.") });
    expect(messages(schema, "abc")).toEqual(["Enter a number."]);
    expect(messages(schema, undefined)).toEqual(["Enter a number."]);
  });

  it("leaves checks without their own message alone", () => {
    const schema = z.coerce.number({ error: invalidTypeError("Enter a number.") }).positive();
    const result = messages(schema, 0);
    expect(result).toHaveLength(1);
    expect(result).not.toContain("Enter a number.");
  });
});
