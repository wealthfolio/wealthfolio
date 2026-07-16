import { useAuth } from "@/context/auth-context";
import {
  ApplicationShell,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
} from "@wealthfolio/ui";
import { FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

export function LoginPage() {
  const { t } = useTranslation();
  const { login, loginLoading, loginError, clearError, requiresPassword, oidcEnabled } = useAuth();
  const [password, setPassword] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password.trim()) {
      return;
    }
    try {
      await login(password);
      setPassword("");
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  return (
    <ApplicationShell className="fixed inset-0 flex items-center justify-center p-6">
      <div className="w-full max-w-md -translate-y-[5vh]">
        <Card className="w-full border-none bg-transparent shadow-none">
          <CardHeader className="space-y-4 text-center">
            <div className="flex justify-center">
              <img
                src="/logo-vantage.png"
                alt={t("auth:login.logoAlt")}
                className="h-16 w-16 sm:h-20 sm:w-20"
              />
            </div>
            <div className="space-y-2">
              <CardTitle>Wealthfolio</CardTitle>
              <CardDescription>{t("auth:login.description")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {requiresPassword ? (
                <form className="space-y-8" onSubmit={handleSubmit}>
                  <div className="space-y-2">
                    <Input
                      data-testid="login-password-input"
                      id="password"
                      type="password"
                      value={password}
                      autoComplete="current-password"
                      onChange={(event) => {
                        if (loginError) {
                          clearError();
                        }
                        setPassword(event.target.value);
                      }}
                      disabled={loginLoading}
                      required
                      placeholder={t("auth:login.passwordPlaceholder")}
                      className="h-12 rounded-full shadow-none"
                    />
                    {loginError ? (
                      <p className="text-destructive text-sm" role="alert">
                        {loginError}
                      </p>
                    ) : null}
                  </div>

                  <Button
                    data-testid="login-submit-button"
                    type="submit"
                    className="w-full"
                    disabled={loginLoading}
                  >
                    {loginLoading ? t("auth:login.signingIn") : t("auth:login.signIn")}
                  </Button>
                </form>
              ) : null}

              {requiresPassword && oidcEnabled ? (
                <div className="flex items-center gap-3">
                  <span className="bg-border h-px flex-1" />
                  <span className="text-muted-foreground text-xs">{t("auth:login.or")}</span>
                  <span className="bg-border h-px flex-1" />
                </div>
              ) : null}

              {oidcEnabled ? (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant={requiresPassword ? "outline" : "default"}
                    className="w-full"
                    onClick={() => {
                      window.location.href = "/api/v1/auth/oidc/login";
                    }}
                  >
                    {t("auth:login.signInWithSso")}
                  </Button>
                  {!requiresPassword && loginError ? (
                    <p className="text-destructive text-center text-sm" role="alert">
                      {loginError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className="text-muted-foreground flex flex-col gap-2 text-center text-xs"></CardFooter>
        </Card>
      </div>
    </ApplicationShell>
  );
}
