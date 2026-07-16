import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icons,
  StarRating,
  Textarea,
} from "@wealthfolio/ui";
import React from "react";
import { useTranslation } from "react-i18next";
import { useAddonRatingMutation } from "../hooks/use-addon-rating-mutation";

interface RatingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addonId: string;
  addonName: string;
  onRatingSubmitted?: () => void;
}

export function RatingDialog({
  open,
  onOpenChange,
  addonId,
  addonName,
  onRatingSubmitted,
}: RatingDialogProps) {
  const { t } = useTranslation();
  const [rating, setRating] = React.useState<number>(0);
  const [review, setReview] = React.useState("");

  const { submitRatingAsync, isSubmittingRating } = useAddonRatingMutation();

  const handleSubmit = async () => {
    if (rating === 0) {
      return;
    }

    try {
      await submitRatingAsync({
        addonId,
        rating,
        review: review.trim() || undefined,
      });

      // Reset form
      setRating(0);
      setReview("");
      onOpenChange(false);
      onRatingSubmitted?.();
    } catch (error) {
      // Error handling is done in the mutation hook
      console.error("Failed to submit rating:", error);
    }
  };

  const handleClose = () => {
    if (!isSubmittingRating) {
      setRating(0);
      setReview("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="space-y-4 pt-4">
          <DialogTitle className="text-lg sm:text-xl">
            {t("settings:addon_rating_title", { name: addonName })}
          </DialogTitle>
          <DialogDescription className="text-sm">
            {t("settings:addon_rating_description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-8">
          {/* Star Rating */}
          <div className="flex flex-col items-center space-y-6">
            <span className="text-center text-sm font-medium">
              {t("settings:addon_rating_question")}
            </span>
            <StarRating rating={rating} interactive onRatingChange={setRating} size="lg" />
            {rating > 0 && (
              <span className="text-muted-foreground text-sm">
                {t("settings:addon_rating_stars", { rating })}
              </span>
            )}
          </div>

          {/* Review Text */}
          <div className="space-y-2">
            <Textarea
              id="review"
              placeholder={t("settings:addon_rating_placeholder")}
              value={review}
              onChange={(e) => setReview(e.target.value)}
              rows={4}
              maxLength={500}
              disabled={isSubmittingRating}
              className="resize-none"
            />
            <div className="text-muted-foreground text-right text-xs">
              {t("settings:addon_rating_characters", { count: review.length })}
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmittingRating}
            className="w-full sm:w-auto"
          >
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={rating === 0 || isSubmittingRating}
            className="w-full sm:w-auto"
          >
            {isSubmittingRating ? (
              <>
                <Icons.Loader className="mr-2 h-4 w-4 animate-spin" />
                {t("settings:addon_rating_submitting")}
              </>
            ) : (
              t("settings:addon_rating_submit")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
