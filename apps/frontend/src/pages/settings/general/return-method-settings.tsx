import {
  ReturnMethodToggle,
  returnViewExplainer,
  returnViewName,
} from "@/components/return-percent";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@wealthfolio/ui/components/ui/item";
import { useTranslation } from "react-i18next";

/** The return method shown on the Dashboard, accounts, Performance and the assistant. */
export function ReturnMethodSettings() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("settings:return_method_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Item className="flex-wrap p-0">
          <ItemContent>
            <ItemTitle>{t("settings:return_method_label")}</ItemTitle>
            <ItemDescription className="line-clamp-none space-y-1">
              <span className="block">
                <span className="text-foreground font-medium">{returnViewName("twr", t)}</span>
                {": "}
                {returnViewExplainer("twr", t)}
              </span>
              <span className="block">
                <span className="text-foreground font-medium">
                  {returnViewName("moneyWeighted", t)}
                </span>
                {": "}
                {returnViewExplainer("moneyWeighted", t)}
              </span>
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <ReturnMethodToggle />
          </ItemActions>
        </Item>
      </CardContent>
    </Card>
  );
}
