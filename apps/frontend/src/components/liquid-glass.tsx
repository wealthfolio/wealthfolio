import type React from "react";
import { useRef, type ReactNode } from "react";

interface LiquidGlassProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  variant?: "button" | "card" | "panel" | "floating";
  intensity?: "subtle" | "medium" | "strong";
}

export function LiquidGlass({
  children,
  className = "",
  style,
  variant = "card",
  intensity = "medium",
}: LiquidGlassProps) {
  const elementRef = useRef<HTMLDivElement>(null);

  const getVariantClasses = () => {
    const baseClasses = "liquid-glass relative overflow-hidden";

    switch (variant) {
      case "button":
        return `${baseClasses} px-6 py-3 rounded-2xl cursor-pointer select-none`;
      case "card":
        return `${baseClasses} p-6 rounded-3xl`;
      case "panel":
        return `${baseClasses} p-8 rounded-2xl`;
      case "floating":
        return `${baseClasses} p-2 rounded-full shadow-2xl`;
      default:
        return baseClasses;
    }
  };

  const getIntensityClasses = () => {
    switch (intensity) {
      case "subtle":
        return "backdrop-blur-sm bg-white/5 border-white/10";
      case "strong":
        return "backdrop-blur-3xl bg-white/20 border-white/30";
      default:
        return "backdrop-blur-xl bg-white/10 border-white/20";
    }
  };

  return (
    <div
      ref={elementRef}
      className={` ${getVariantClasses()} ${getIntensityClasses()} ${className} `}
      style={{ ...style }}
    >
      <div className="relative z-10">{children}</div>
      <div className="pointer-events-none absolute inset-0 z-5 bg-gradient-to-br from-white/10 via-transparent to-transparent" />
    </div>
  );
}
