import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExchangeRate } from "@/lib/types";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

interface RateCellProps {
  rate: ExchangeRate;
  onUpdate: (updatedRate: ExchangeRate) => void;
}

export function RateCell({ rate, onUpdate }: RateCellProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editedRate, setEditedRate] = useState(rate.rate.toString());
  const isManual = rate.source === "MANUAL";

  const handleEdit = () => {
    if (!isManual) {
      toast({
        title: t("settings:fx_cannot_edit_title"),
        description: t("settings:fx_cannot_edit_desc"),
        variant: "destructive",
      });
      return;
    }
    setIsEditing(true);
    setEditedRate(rate.rate.toString());
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedRate(rate.rate.toString());
  };

  const handleSubmit = () => {
    const newRate = parseFloat(editedRate);
    if (isNaN(newRate) || newRate <= 0) {
      toast({
        title: t("settings:fx_invalid_title"),
        description: t("settings:fx_invalid_desc"),
        variant: "destructive",
      });
      return;
    }
    const updatedRate = { ...rate, rate: newRate };
    onUpdate(updatedRate);
    setIsEditing(false);
  };

  return (
    <div className="flex items-center space-x-2">
      <div className="w-24">
        {isManual && isEditing ? (
          <Input
            value={editedRate}
            onChange={(e) => setEditedRate(e.target.value)}
            className="w-full"
          />
        ) : (
          <span>{rate.rate ? Number(rate.rate).toFixed(4) : "-"}</span>
        )}
      </div>
      {isManual && (
        <div className="flex space-x-1">
          {isEditing ? (
            <>
              <Button variant="outline" size="icon" onClick={handleCancelEdit}>
                <Icons.Close className="h-4 w-4" />
              </Button>
              <Button size="icon" onClick={handleSubmit}>
                <Icons.Check className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button variant="outline" size="icon" onClick={handleEdit}>
              <Icons.Pencil className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
