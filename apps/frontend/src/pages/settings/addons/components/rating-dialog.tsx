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
import { useI18n } from "@/i18n/i18n-provider";
import React from "react";
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
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
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
            {isChinese ? `为 ${addonName} 评分` : `Rate ${addonName}`}
          </DialogTitle>
          <DialogDescription className="text-sm">
            {isChinese
              ? "分享你对此插件的体验，帮助其他用户做选择。"
              : "Share your experience with this addon to help other users."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-8">
          {/* Star Rating */}
          <div className="flex flex-col items-center space-y-6">
            <span className="text-center text-sm font-medium">
              {isChinese ? "你会如何评价这个插件？" : "How would you rate this addon?"}
            </span>
            <StarRating rating={rating} interactive onRatingChange={setRating} size="lg" />
            {rating > 0 && (
              <span className="text-muted-foreground text-sm">
                {isChinese ? `${rating} / 5 星` : `${rating} out of 5 stars`}
              </span>
            )}
          </div>

          {/* Review Text */}
          <div className="space-y-2">
            <Textarea
              id="review"
              placeholder={
                isChinese ? "分享你对此插件的想法..." : "Share your thoughts about this addon..."
              }
              value={review}
              onChange={(e) => setReview(e.target.value)}
              rows={4}
              maxLength={500}
              disabled={isSubmittingRating}
              className="resize-none"
            />
            <div className="text-muted-foreground text-right text-xs">
              {isChinese ? `${review.length}/500 个字符` : `${review.length}/500 characters`}
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
            {isChinese ? "取消" : "Cancel"}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={rating === 0 || isSubmittingRating}
            className="w-full sm:w-auto"
          >
            {isSubmittingRating ? (
              <>
                <Icons.Loader className="mr-2 h-4 w-4 animate-spin" />
                {isChinese ? "提交中..." : "Submitting..."}
              </>
            ) : (
              isChinese ? "提交评分" : "Submit Rating"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
