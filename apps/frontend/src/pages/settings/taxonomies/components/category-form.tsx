import { useEffect } from "react";
import { useForm } from "react-hook-form";
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
import { useI18n } from "@/i18n/i18n-provider";
import { toast } from "sonner";

const categoryFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  key: z.string().min(1, "Key is required"),
  color: z.string().min(1, "Color is required"),
  description: z.string().optional().nullable(),
});

type CategoryFormValues = z.infer<typeof categoryFormSchema>;

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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
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
  const isCreateMode = !category;
  const createMutation = useCreateCategory();
  const updateMutation = useUpdateCategory();
  const deleteMutation = useDeleteCategory();
  const { language } = useI18n();
  const isChinese = language === "zh-CN";

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
        toast.success("Category created successfully");
        onCreate?.();
      } else if (category) {
        await updateMutation.mutateAsync({
          ...category,
          name: values.name,
          key: values.key,
          color: values.color,
          description: values.description ?? null,
        });
        toast.success("Category updated successfully");
      }
    } catch {
      toast.error(isCreateMode ? "Failed to create category" : "Failed to update category");
    }
  };

  const handleDelete = async () => {
    if (!category) return;
    try {
      await deleteMutation.mutateAsync({
        taxonomyId,
        categoryId: category.id,
      });
      toast.success("Category deleted successfully");
      onDelete?.();
    } catch {
      toast.error("Failed to delete category");
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
            {isCreateMode ? "New Category" : category?.name}
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
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="Category name" />
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
                <FormLabel>Color</FormLabel>
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
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Optional description for this category"
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
                    {isCreateMode ? "Creating..." : "Saving..."}
                  </>
                ) : isCreateMode ? (
                  "Create Category"
                ) : (
                  "Save Changes"
                )}
              </Button>
              {!isCreateMode && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => form.reset()}
                  disabled={!form.formState.isDirty}
                >
                  Reset
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
                    <AlertDialogTitle>{isChinese ? "删除分类" : "Delete Category"}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {isChinese
                        ? `确定要删除“${category?.name}”吗？这会移除此分类下的所有资产分配。此操作无法撤销。`
                        : `Are you sure you want to delete "${category?.name}"? This will remove all asset assignments to this category. This action cannot be undone.`}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
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
