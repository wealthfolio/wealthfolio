import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { SUPPORTED_LOCALES } from "@/i18n/locales";

interface LanguageSelectorProps {
  value?: string;
  onChange: (value: string) => void;
  className?: string;
}

export function LanguageSelector({ value, onChange, className }: LanguageSelectorProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger data-testid="language-select" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LOCALES.map((locale) => (
          <SelectItem
            data-testid={`language-option-${locale.code}`}
            key={locale.code}
            value={locale.code}
          >
            {locale.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
