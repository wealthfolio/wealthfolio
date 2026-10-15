import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Icons } from "../ui/icons";

interface AlertFeedbackProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  variant?: "success" | "error" | "warning";
}

export function AlertFeedback({ title, children, variant = "error", className, ...props }: AlertFeedbackProps) {
  const getIcon = () => {
    switch (variant) {
      case "success":
        return <Icons.CheckCircle className="size-4" />;
      case "warning":
        return <Icons.AlertTriangle className="size-4" />;
      case "error":
        return <Icons.AlertCircle className="size-4" />;
      default:
        return <Icons.AlertCircle className="size-4" />;
    }
  };

  return (
    <Alert variant={variant} className={className} {...props}>
      {getIcon()}
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
