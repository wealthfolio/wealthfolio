import { loadGoalCoverImage } from "@/adapters";
import type { Goal } from "@/lib/types";
import type { Area } from "react-easy-crop";
import { useEffect, useState } from "react";

/** Cover image by convention: /goals/{goalType}.png */
function staticCoverImageSrc(goalType: string): string {
  return `/goals/${goalType}.png`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function mimeTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export interface CoverImageAspectPreset {
  id: "card" | "wide" | "tall";
  labelKey: string;
  /** width / height */
  ratio: number;
  outputWidth: number;
  outputHeight: number;
}

/**
 * Crop aspect ratios offered in the cover-image cropper. The goal card is
 * the only place this image renders today (`goal-card.tsx`, `h-[156px]`,
 * `object-cover`), but its width is responsive (1/2/3 grid columns), so no
 * single ratio is pixel-perfect everywhere — "Card" is tuned for the common
 * 2-3 column desktop width; "Wide"/"Tall" are offered as alternate framings.
 */
export const COVER_IMAGE_ASPECT_PRESETS: CoverImageAspectPreset[] = [
  {
    id: "card",
    labelKey: "goals:cover_image.aspect_card",
    ratio: 2.35,
    outputWidth: 940,
    outputHeight: 400,
  },
  {
    id: "wide",
    labelKey: "goals:cover_image.aspect_wide",
    ratio: 3,
    outputWidth: 960,
    outputHeight: 320,
  },
  {
    id: "tall",
    labelKey: "goals:cover_image.aspect_tall",
    ratio: 16 / 9,
    outputWidth: 960,
    outputHeight: 540,
  },
];

/**
 * Draws the cropped region (in source-image pixel coordinates, as reported
 * by react-easy-crop's `onCropComplete`) onto a canvas at the preset's fixed
 * output dimensions and re-encodes as PNG, returning a base64 payload ready
 * for `setGoalCoverImage`. What the cropper previews is exactly what gets
 * baked — no separate resize step.
 *
 * The crop window can extend beyond the image's natural bounds (the user
 * zoomed out below 1x to fit the whole motif in frame instead of cropping
 * it): the source read is clamped to the image and placed at the matching
 * scaled position in the output, so uncovered margins stay transparent
 * (PNG, not JPEG, to preserve that) rather than being stretched or filled.
 */
export async function bakeCroppedCoverImage(
  imageSrc: string,
  croppedAreaPixels: Area,
  preset: CoverImageAspectPreset,
): Promise<{ base64: string }> {
  const image = new Image();
  image.src = imageSrc;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Failed to load image for cropping."));
  });

  const canvas = document.createElement("canvas");
  canvas.width = preset.outputWidth;
  canvas.height = preset.outputHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get canvas context for image crop.");
  }

  const scaleX = preset.outputWidth / croppedAreaPixels.width;
  const scaleY = preset.outputHeight / croppedAreaPixels.height;
  const srcX = Math.max(0, croppedAreaPixels.x);
  const srcY = Math.max(0, croppedAreaPixels.y);
  const srcRight = Math.min(image.naturalWidth, croppedAreaPixels.x + croppedAreaPixels.width);
  const srcBottom = Math.min(image.naturalHeight, croppedAreaPixels.y + croppedAreaPixels.height);
  const srcWidth = srcRight - srcX;
  const srcHeight = srcBottom - srcY;

  if (srcWidth > 0 && srcHeight > 0) {
    ctx.drawImage(
      image,
      srcX,
      srcY,
      srcWidth,
      srcHeight,
      (srcX - croppedAreaPixels.x) * scaleX,
      (srcY - croppedAreaPixels.y) * scaleY,
      srcWidth * scaleX,
      srcHeight * scaleY,
    );
  }

  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1] ?? "";
  return { base64 };
}

/**
 * Resolves the `<img>` src for a goal card: the user's custom cover image if
 * set (loaded asynchronously as a blob URL), otherwise the static
 * per-goal-type stock image.
 */
export function useGoalCoverImageSrc(
  goal: Pick<Goal, "id" | "goalType" | "coverImagePath" | "updatedAt">,
) {
  const { coverImagePath, updatedAt } = goal;
  const [customUrl, setCustomUrl] = useState<string>();

  useEffect(() => {
    if (!coverImagePath) {
      setCustomUrl(undefined);
      return;
    }

    let cancelled = false;
    let objectUrl: string | undefined;
    setCustomUrl(undefined);

    void (async () => {
      try {
        const blob = await loadGoalCoverImage(goal.id, mimeTypeForPath(coverImagePath));
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setCustomUrl(objectUrl);
      } catch {
        // Fall back to the static stock image below.
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // `updatedAt` is included so replacing an image (same filename, since we
    // always write `{goalId}.png`) still triggers a re-fetch — otherwise the
    // blob URL from the previous upload would keep showing stale bytes.
  }, [goal.id, coverImagePath, updatedAt]);

  return customUrl ?? staticCoverImageSrc(goal.goalType);
}
