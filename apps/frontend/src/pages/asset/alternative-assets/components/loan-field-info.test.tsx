import { render, screen } from "@/test/render";
import { expect, it } from "vitest";
import { LoanFieldInfo } from "./loan-field-info";

it("names the info button after its field", () => {
  render(<LoanFieldInfo label="Paid from">Help</LoanFieldInfo>);
  expect(screen.getByRole("button", { name: "More info about Paid from" })).toBeInTheDocument();
});
