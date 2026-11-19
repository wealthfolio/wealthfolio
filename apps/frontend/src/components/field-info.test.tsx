import { render, screen } from "@/test/render";
import { expect, it } from "vitest";
import { FieldInfo } from "./field-info";

it("names the info button after its field", () => {
  render(<FieldInfo label="Paid from">Help</FieldInfo>);
  expect(screen.getByRole("button", { name: "More info about Paid from" })).toBeInTheDocument();
});
