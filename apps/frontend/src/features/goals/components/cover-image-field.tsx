import {
  bakeCroppedCoverImage,
  COVER_IMAGE_ASPECT_PRESETS,
  useGoalCoverImageSrc,
} from "@/features/goals/lib/cover-image";
import { useGoalMutations } from "@/features/goals/hooks/use-goals";
import type { Goal, GoalType } from "@/lib/types";
import { Button, Label } from "@wealthfolio/ui";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { useRef, useState } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type CoverImageFieldProps =
  | { mode: "edit"; goal: Goal }
  | {
      mode: "staged";
      value: string | null;
      onStagedChange: (base64: string | null) => void;
      goalType: GoalType;
    };

// Zoom can go below 1x (image smaller than the crop frame) so the whole
// motif can be kept in frame, with the uncovered margins baked transparent
// (see restrictPosition={false} below and bakeCroppedCoverImage).
const COVER_IMAGE_ZOOM_MIN = 0.25;
const COVER_IMAGE_ZOOM_MAX = 3;

export function CoverImageField(props: CoverImageFieldProps) {
  const { t } = useTranslation();
  const { setCoverImageMutation, removeCoverImageMutation } = useGoalMutations();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [pickedImageSrc, setPickedImageSrc] = useState<string | null>(null);
  const [presetIndex, setPresetIndex] = useState(0);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [isBaking, setIsBaking] = useState(false);

  // Hooks must run unconditionally: in "staged" mode there's no real Goal
  // yet, so build a minimal stand-in that resolves to the static fallback
  // image (coverImagePath is always undefined for it).
  const pseudoGoal =
    props.mode === "edit"
      ? props.goal
      : { id: "", goalType: props.goalType, coverImagePath: undefined, updatedAt: "" };
  const resolvedSrc = useGoalCoverImageSrc(pseudoGoal);

  const hasCustomImage =
    props.mode === "edit" ? Boolean(props.goal.coverImagePath) : Boolean(props.value);
  const displaySrc =
    props.mode === "staged" && props.value ? `data:image/png;base64,${props.value}` : resolvedSrc;

  const preset = COVER_IMAGE_ASPECT_PRESETS[presetIndex];

  const openCropper = (file: File) => {
    setPickedImageSrc(URL.createObjectURL(file));
    setPresetIndex(0);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
  };

  const closeCropper = () => {
    if (pickedImageSrc) URL.revokeObjectURL(pickedImageSrc);
    setPickedImageSrc(null);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) openCropper(file);
  };

  const handleCropSave = async () => {
    if (!pickedImageSrc || !croppedAreaPixels) return;
    setIsBaking(true);
    try {
      const { base64 } = await bakeCroppedCoverImage(pickedImageSrc, croppedAreaPixels, preset);
      if (props.mode === "edit") {
        setCoverImageMutation.mutate({
          goalId: props.goal.id,
          contentBase64: base64,
          fileExtension: "png",
        });
      } else {
        props.onStagedChange(base64);
      }
      closeCropper();
    } catch {
      toast.error(t("goals:cover_image.resize_failed"));
    } finally {
      setIsBaking(false);
    }
  };

  const handleRemove = () => {
    if (props.mode === "edit") {
      removeCoverImageMutation.mutate(props.goal.id);
    } else {
      props.onStagedChange(null);
    }
  };

  const isBusy =
    props.mode === "edit"
      ? setCoverImageMutation.isPending || removeCoverImageMutation.isPending
      : false;

  return (
    <div className="space-y-2">
      <Label>{t("goals:cover_image.label")}</Label>
      <div className="group relative h-32 w-full overflow-hidden rounded-xl border">
        <img src={displaySrc} alt="" className="h-full w-full object-cover" />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isBusy}
          className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition-opacity disabled:cursor-not-allowed group-hover:bg-black/40 group-hover:opacity-100"
        >
          {isBusy ? (
            <Icons.Spinner className="h-5 w-5 animate-spin" />
          ) : (
            <span className="flex flex-col items-center gap-1 text-xs font-medium">
              <Icons.Import className="h-5 w-5" />
              {t(hasCustomImage ? "goals:cover_image.change" : "goals:cover_image.upload")}
            </span>
          )}
        </button>
        {hasCustomImage && (
          <Button
            type="button"
            size="icon-xs"
            variant="destructive"
            className="absolute right-2 top-2"
            onClick={handleRemove}
            disabled={isBusy}
          >
            <Icons.Trash className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <input
        type="file"
        ref={fileInputRef}
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />

      <Dialog open={pickedImageSrc !== null} onOpenChange={(open) => !open && closeCropper()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("goals:cover_image.crop_title")}</DialogTitle>
          </DialogHeader>

          {pickedImageSrc && (
            <div className="space-y-4">
              <div
                className="relative h-64 w-full overflow-hidden rounded-lg"
                style={{
                  // Checkerboard so zoomed-out margins read as "transparent",
                  // matching what actually gets baked into the PNG.
                  backgroundImage:
                    "conic-gradient(#80808033 25%, transparent 0 50%, #80808033 0 75%, transparent 0)",
                  backgroundSize: "16px 16px",
                }}
              >
                <Cropper
                  image={pickedImageSrc}
                  crop={crop}
                  zoom={zoom}
                  aspect={preset.ratio}
                  minZoom={COVER_IMAGE_ZOOM_MIN}
                  maxZoom={COVER_IMAGE_ZOOM_MAX}
                  restrictPosition={false}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={(_area, pixels) => setCroppedAreaPixels(pixels)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="cover-image-aspect">{t("goals:cover_image.aspect_label")}</Label>
                <Select
                  value={preset.id}
                  onValueChange={(id) =>
                    setPresetIndex(COVER_IMAGE_ASPECT_PRESETS.findIndex((p) => p.id === id))
                  }
                >
                  <SelectTrigger id="cover-image-aspect">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COVER_IMAGE_ASPECT_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {t(p.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cover-image-zoom">{t("goals:cover_image.zoom_label")}</Label>
                <input
                  id="cover-image-zoom"
                  type="range"
                  min={COVER_IMAGE_ZOOM_MIN}
                  max={COVER_IMAGE_ZOOM_MAX}
                  step={0.01}
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeCropper}>
              {t("goals:cover_image.cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleCropSave}
              disabled={isBaking || !croppedAreaPixels}
            >
              {isBaking ? t("goals:cover_image.saving") : t("goals:cover_image.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
