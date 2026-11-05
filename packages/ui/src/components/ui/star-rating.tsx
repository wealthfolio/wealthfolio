import { useNumberFormatting } from "../formatting-provider";
import React from "react";
import { Icons } from "./icons";
import { cn } from "../../lib/utils";

interface StarRatingProps {
  rating: number;
  maxRating?: number;
  size?: "sm" | "md" | "lg";
  interactive?: boolean;
  onRatingChange?: (rating: number) => void;
  className?: string;
}

export function StarRating({
  rating,
  maxRating = 5,
  size = "md",
  interactive = false,
  onRatingChange,
  className,
}: StarRatingProps) {
  const [hoveredRating, setHoveredRating] = React.useState<number | null>(null);

  const sizeClasses = {
    sm: "h-3 w-3",
    md: "h-4 w-4",
    lg: "h-5 w-5",
  };

  const getStarFillPercentage = (starIndex: number) => {
    const effectiveRating = hoveredRating ?? rating;
    if (effectiveRating >= starIndex + 1) return 100;
    if (effectiveRating > starIndex) return (effectiveRating - starIndex) * 100;
    return 0;
  };

  const handleStarClick = (starIndex: number) => {
    if (interactive && onRatingChange) {
      onRatingChange(starIndex + 1);
    }
  };

  const handleStarHover = (starIndex: number) => {
    if (interactive) {
      setHoveredRating(starIndex + 1);
    }
  };

  const handleMouseLeave = () => {
    if (interactive) {
      setHoveredRating(null);
    }
  };

  return (
    <div className={cn("flex items-center gap-0.5", className)} onMouseLeave={handleMouseLeave}>
      {Array.from({ length: maxRating }, (_, index) => {
        const fillPercentage = getStarFillPercentage(index);
        const isFullStar = fillPercentage === 100;
        const isPartialStar = fillPercentage > 0 && fillPercentage < 100;

        return (
          <div
            key={index}
            className={cn("relative", interactive && "cursor-pointer transition-transform hover:scale-110")}
            onClick={() => handleStarClick(index)}
            onMouseEnter={() => handleStarHover(index)}
          >
            {/* Background star (empty) */}
            <Icons.Star className={cn(sizeClasses[size], "text-muted-foreground/30")} fill="currentColor" />

            {/* Foreground star (filled) */}
            {(isFullStar || isPartialStar) && (
              <div className="absolute inset-0 overflow-hidden" style={{ width: `${fillPercentage}%` }}>
                <Icons.Star
                  className={cn(sizeClasses[size], hoveredRating ? "text-warning" : "text-warning")}
                  fill="currentColor"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface StarRatingDisplayProps {
  rating: number;
  reviewCount?: number;
  size?: "sm" | "md" | "lg";
  showText?: boolean;
  className?: string;
}

export function StarRatingDisplay({
  rating,
  reviewCount,
  size = "md",
  showText = true,
  className,
}: StarRatingDisplayProps) {
  const numbers = useNumberFormatting();
  const textSizes = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-base",
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <StarRating rating={rating} size={size} />
      {showText && (
        <div className={cn("flex items-center gap-1", textSizes[size])}>
          <span className="font-medium">
            {numbers.formatDecimal(rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          </span>
          {reviewCount !== undefined && (
            <span className="text-muted-foreground">
              ({numbers.formatDecimal(reviewCount)} {reviewCount === 1 ? "review" : "reviews"})
            </span>
          )}
        </div>
      )}
    </div>
  );
}
