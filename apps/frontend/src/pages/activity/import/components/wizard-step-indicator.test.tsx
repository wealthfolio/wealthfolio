import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WizardStepIndicator, type WizardStep } from "./wizard-step-indicator";

const steps: WizardStep[] = [
  { id: "upload", label: "Upload" },
  { id: "mapping", label: "Mapping" },
  { id: "assets", label: "Review Assets" },
  { id: "review", label: "Review Activities" },
  { id: "confirm", label: "Import" },
];

describe("WizardStepIndicator layout", () => {
  // jsdom verifies the responsive contract, not painted browser geometry.
  it("keeps the full stepper circles from shrinking", () => {
    const { container } = render(<WizardStepIndicator steps={steps} currentStep="mapping" />);
    const circles = container.querySelectorAll('[class~="h-10"][class~="rounded-full"]');
    expect(circles).toHaveLength(5);
    circles.forEach((circle) => expect(circle).toHaveClass("shrink-0"));
  });

  it("uses the existing compact rail until there is room for all desktop labels", () => {
    const { container } = render(<WizardStepIndicator steps={steps} currentStep="mapping" />);
    const root = container.firstElementChild!;
    expect(root.children[0]).toHaveClass("xl:hidden");
    expect(root.children[1]).toHaveClass("hidden", "xl:flex");
    expect(root.children[1]).not.toHaveClass("md:flex");
    expect(root.children[0]).toHaveTextContent("Mapping");
    expect(root.children[0].querySelectorAll('[class~="h-9"]')).toHaveLength(5);
  });

  it("preserves completed steps and the current title after navigation", () => {
    const { container, rerender } = render(
      <WizardStepIndicator steps={steps} currentStep="mapping" />,
    );
    rerender(<WizardStepIndicator steps={steps} currentStep="review" />);
    const compact = container.firstElementChild!.children[0];
    expect(compact).toHaveTextContent("Review Activities");
    expect(compact.querySelectorAll('[class~="h-9"] svg')).toHaveLength(3);
    expect(screen.getAllByText("Import")).toHaveLength(1);
  });
});
