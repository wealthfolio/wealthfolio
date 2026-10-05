import { useTranslation } from "react-i18next";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

/** Shared benefit overview for Connect sign-in and the unconnected dashboard. */
export function ConnectFeatures({ dashboard = false }: { dashboard?: boolean }) {
  const { t } = useTranslation();
  const features = [
    { key: dashboard ? "brokerageSync" : "brokerSync", icon: Icons.CloudSync2 },
    { key: "deviceSync", icon: Icons.Devices },
    { key: dashboard ? "householdView" : "household", icon: Icons.Users },
  ] as const;
  const prefix = dashboard ? "connect:emptyState.features" : "auth:connect.features";
  return (
    <div className="@container w-full">
      <ul className="@min-[756px]:grid-cols-3 grid grid-cols-1 gap-3">
        {features.map(({ key, icon: Icon }) => (
          <li
            key={key}
            className="border-connect-brand/15 from-connect-brand/8 via-card to-card space-y-3 rounded-xl border bg-gradient-to-br p-4"
          >
            <div className="flex items-center gap-3">
              <span className="bg-connect-brand/10 text-connect-brand flex size-8 shrink-0 items-center justify-center rounded-lg">
                <Icon className="size-4" aria-hidden />
              </span>
              <h3 className="min-w-0 text-sm font-semibold leading-5">
                {t(`${prefix}.${key}.title`)}
              </h3>
            </div>
            <p className="text-muted-foreground text-xs leading-5">
              {t(`${prefix}.${key}.description`)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
