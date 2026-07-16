import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import {
  Button,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from "@wealthfolio/ui";

import type { CategoryNode } from "./category-item";
import { ColorPicker } from "./color-picker";
import { IconPicker } from "./icon-picker";

export interface CategoryFormValues {
  name: string;
  color?: string;
  icon?: string | null;
}

const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6b7280",
];

interface CategoryFormProps {
  category?: CategoryNode;
  parentCategory?: CategoryNode;
  onSubmit: (values: CategoryFormValues) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

export function CategoryForm({
  category,
  parentCategory,
  onSubmit,
  onCancel,
  isLoading,
}: CategoryFormProps) {
  const { t } = useTranslation();
  const isEditing = !!category;

  const categorySchema = useMemo(
    () =>
      z.object({
        name: z.string().min(1, t("spending:category.nameRequired")),
        color: z.string().optional(),
        icon: z.string().nullable().optional(),
      }),
    [t],
  );

  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: category?.name ?? "",
      color: category?.color ?? parentCategory?.color ?? PRESET_COLORS[0],
      icon: category?.icon ?? parentCategory?.icon ?? null,
    },
  });

  const colorValue = form.watch("color");

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("common:name")}</FormLabel>
              <FormControl>
                <Input placeholder={t("spending:category.namePlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="icon"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:category.icon")}</FormLabel>
              <FormControl>
                <IconPicker
                  value={field.value ?? null}
                  onChange={(v) => field.onChange(v)}
                  accent={colorValue}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="color"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:category.color")}</FormLabel>
              <FormControl>
                <div className="flex flex-wrap items-center gap-2">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${
                        field.value?.toLowerCase() === color
                          ? "border-foreground ring-2 ring-offset-2"
                          : "border-transparent"
                      }`}
                      style={{ backgroundColor: color }}
                      onClick={() => field.onChange(color)}
                      aria-label={t("spending:category.useColor", { color })}
                    />
                  ))}
                  <ColorPicker
                    value={field.value}
                    onChange={(c) => field.onChange(c)}
                    presets={PRESET_COLORS}
                  />
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("common:cancel")}
          </Button>
          <Button type="submit" disabled={isLoading}>
            {isLoading
              ? t("spending:common.saving")
              : isEditing
                ? t("spending:common.saveChanges")
                : t("spending:category.create")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
