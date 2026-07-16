import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  Input,
  Button,
  Icons,
  Textarea,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@wealthfolio/ui";
import type { TaxonomyCategory } from "@/lib/types";
import { useCreateCategory, useUpdateCategory, useDeleteCategory } from "@/hooks/use-taxonomies";
import { toast } from "sonner";

interface CategoryFormValues {
  name: string;
  key: string;
  color: string;
  description?: string | null;
}

interface CategoryFormProps {
  category?: TaxonomyCategory;
  taxonomyId: string;
  taxonomyColor?: string;
  isSystem?: boolean;
  onClose: () => void;
  onCreate?: () => void;
  onDelete?: () => void;
}

function generateKey(name: string): string {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  // Names without any Latin letters or digits (e.g. Chinese, Japanese, Arabic)
  // slugify to an empty string; fall back so the hidden key field doesn't fail
  // validation and silently block category creation.
  return key || `cat_${Date.now()}`;
}

export function CategoryForm({
  category,
  taxonomyId,
  taxonomyColor,
  isSystem,
  onClose,
  onCreate,
  onDelete,
}: CategoryFormProps) {
  const { t } = useTranslation();
  const isCreateMode = !category;
  const createMutation = useCreateCategory();
  const updateMutation = useUpdateCategory();
  const deleteMutation = useDeleteCategory();

  const categoryFormSchema = useMemo(
    () =>
      z.object({
        name: z.string().min(1, t("settings:tax_name_required")),
        key: z.string().min(1, t("settings:tax_key_required")),
        color: z.string().min(1, t("settings:tax_color_required")),
        description: z.string().optional().nullable(),
      }),
    [t],
  );

  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: {
      name: category?.name ?? "",
      key: category?.key ?? "",
      color: category?.color ?? taxonomyColor ?? "#808080",
      description: category?.description ?? "",
    },
  });

  // Reset form when category changes
  useEffect(() => {
    form.reset({
      name: category?.name ?? "",
      key: category?.key ?? "",
      color: category?.color ?? taxonomyColor ?? "#808080",
      description: category?.description ?? "",
    });
  }, [category, taxonomyColor, form]);

  // Auto-generate key from name in create mode
  const watchName = form.watch("name");
  useEffect(() => {
    if (isCreateMode && watchName) {
      form.setValue("key", generateKey(watchName), { shouldDirty: true });
    }
  }, [isCreateMode, watchName, form]);

  const onSubmit = async (values: CategoryFormValues) => {
    try {
      if (isCreateMode) {
        await createMutation.mutateAsync({
          taxonomyId,
          parentId: null, // One level only
          name: values.name,
          key: values.key,
          color: values.color,
          description: values.description ?? null,
          sortOrder: 0,
        });
        toast.success(t("settings:tax_category_created"));
        onCreate?.();
      } else if (category) {
        await updateMutation.mutateAsync({
          ...category,
          name: values.name,
          key: values.key,
          color: values.color,
          description: values.description ?? null,
        });
        toast.success(t("settings:tax_category_updated"));
      }
    } catch {
      toast.error(
        isCreateMode
          ? t("settings:tax_category_create_error")
          : t("settings:tax_category_update_error"),
      );
    }
  };

  const handleDelete = async () => {
    if (!category) return;
    try {
      await deleteMutation.mutateAsync({
        taxonomyId,
        categoryId: category.id,
      });
      toast.success(t("settings:tax_category_deleted"));
      onDelete?.();
    } catch {
      toast.error(t("settings:tax_category_delete_error"));
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const currentColor = form.watch("color");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className="h-4 w-4 shrink-0 rounded-full"
            style={{ backgroundColor: currentColor }}
          />
          <h3 className="text-lg font-semibold">
            {isCreateMode ? t("settings:tax_new_category") : category?.name}
          </h3>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <Icons.Close className="h-4 w-4" />
        </Button>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("common:name")}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder={t("settings:tax_category_name_placeholder")} />
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
                <FormLabel>{t("settings:tax_color")}</FormLabel>
                <FormControl>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={field.value}
                      onChange={field.onChange}
                      className="h-9 w-12 cursor-pointer rounded border p-1"
                    />
                    <Input {...field} className="flex-1 font-mono" placeholder="#808080" />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("common:description")}</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    placeholder={t("settings:tax_description_placeholder")}
                    rows={3}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex items-center justify-between pt-4">
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={isPending || (!isCreateMode && !form.formState.isDirty)}
              >
                {isPending ? (
                  <>
                    <Icons.Loader className="mr-2 h-4 w-4 animate-spin" />
                    {isCreateMode ? t("settings:tax_creating") : t("settings:tax_saving")}
                  </>
                ) : isCreateMode ? (
                  t("settings:tax_create_category")
                ) : (
                  t("settings:tax_save_changes")
                )}
              </Button>
              {!isCreateMode && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => form.reset()}
                  disabled={!form.formState.isDirty}
                >
                  {t("common:reset")}
                </Button>
              )}
            </div>

            {/* Delete button for non-system taxonomies */}
            {!isCreateMode && !isSystem && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? (
                      <Icons.Loader className="h-4 w-4 animate-spin" />
                    ) : (
                      <Icons.Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("settings:tax_delete_category")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings:tax_delete_confirm_desc", { name: category?.name })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {t("common:delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </form>
      </Form>
    </div>
  );
}
