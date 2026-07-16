import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { AnimatePresence, motion } from "motion/react";
import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface QuoteImportFormProps {
  file: File | null;
  isValidating: boolean;
  error: string | null;
  onFileSelect: (file: File | null) => void;
  onValidate: () => void;
}

export function QuoteImportForm({
  file,
  isValidating,
  error,
  onFileSelect,
  onValidate,
}: QuoteImportFormProps) {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] || null;
    onFileSelect(selectedFile);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const droppedFile = event.dataTransfer.files?.[0];
    if (droppedFile?.type === "text/csv") {
      onFileSelect(droppedFile);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleBrowseClick = () => {
    if (!file && !isValidating) {
      fileInputRef.current?.click();
    }
  };

  const handleRemoveFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFileSelect(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Determine the border and background colors based on state
  const getBorderClasses = () => {
    if (isDragging) {
      return "border-primary bg-primary/5";
    }

    if (file) {
      if (isValidating) {
        return "border-blue-500 bg-blue-50 dark:bg-blue-900/10";
      }
      if (error) {
        return "border-red-500 bg-red-50 dark:bg-red-900/10";
      }
      return "border-green-500 bg-green-50 dark:bg-green-900/10";
    }

    return "border-border bg-background/50 hover:bg-background/80 hover:border-muted-foreground/50";
  };

  // Animation variants for icon containers
  const iconContainerVariants = {
    initial: {
      scale: 0.8,
      opacity: 0,
      rotate: -10,
    },
    animate: {
      scale: 1,
      opacity: 1,
      rotate: 0,
      transition: {
        type: "spring" as const,
        stiffness: 260,
        damping: 20,
        duration: 0.5,
      },
    },
    exit: {
      scale: 0.8,
      opacity: 0,
      rotate: 10,
      transition: { duration: 0.3 },
    },
  };

  // Animation variants for icons
  const iconVariants = {
    initial: { scale: 0.6, opacity: 0 },
    animate: {
      scale: 1,
      opacity: 1,
      transition: {
        delay: 0.1,
        type: "spring" as const,
        stiffness: 300,
      },
    },
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {/* File Drop Zone */}
        <div
          className={`group relative flex h-full flex-col justify-center rounded-lg border border-dashed p-4 transition-colors ${getBorderClasses()} ${!file && !isValidating ? "cursor-pointer" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleBrowseClick}
        >
          {file && !isValidating && (
            <div
              className="bg-background/90 dark:bg-background/95 pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-90"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex flex-col items-center gap-3">
                <Button
                  size="sm"
                  onClick={handleRemoveFile}
                  className="flex items-center gap-1.5 px-3"
                >
                  <Icons.Trash className="h-4 w-4" />
                  <span>{t("settings:market_data_page.remove_file")}</span>
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col items-center justify-center space-y-2">
            <AnimatePresence mode="wait">
              {isValidating ? (
                <motion.div
                  key="loading"
                  variants={iconContainerVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 shadow-sm dark:bg-blue-900/20"
                >
                  <motion.div variants={iconVariants} initial="initial" animate="animate">
                    <Icons.Spinner className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" />
                  </motion.div>
                </motion.div>
              ) : file && error ? (
                <motion.div
                  key="error"
                  variants={iconContainerVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 shadow-sm dark:bg-red-900/20"
                >
                  <motion.div variants={iconVariants} initial="initial" animate="animate">
                    <Icons.AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
                  </motion.div>
                </motion.div>
              ) : file ? (
                <motion.div
                  key="file"
                  variants={iconContainerVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 shadow-sm dark:bg-green-900/20"
                >
                  <motion.div variants={iconVariants} initial="initial" animate="animate">
                    <Icons.CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </motion.div>
                </motion.div>
              ) : (
                <motion.div
                  key="upload"
                  variants={iconContainerVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="bg-muted flex h-10 w-10 items-center justify-center rounded-full shadow-sm"
                >
                  <motion.div variants={iconVariants} initial="initial" animate="animate">
                    <Icons.Import className="text-muted-foreground h-5 w-5" />
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-0.5 text-center">
              <AnimatePresence mode="wait">
                {isValidating ? (
                  <motion.p
                    key="loading-text"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.2 }}
                    className="text-xs font-medium"
                  >
                    {t("settings:market_data_page.processing_file")}
                  </motion.p>
                ) : file && error ? (
                  <motion.div
                    key="error-info"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-0"
                  >
                    <p className="font-medium text-red-600 dark:text-red-400">{file.name}</p>
                    <p className="text-xs text-red-500 dark:text-red-400">
                      {(file.size / 1024).toFixed(2)} KB
                    </p>
                  </motion.div>
                ) : file ? (
                  <motion.div
                    key="file-info"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-0"
                  >
                    <p className="text-xs font-medium">{file.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {(file.size / 1024).toFixed(2)} KB
                    </p>
                  </motion.div>
                ) : (
                  <motion.div
                    key="upload-text"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.2 }}
                  >
                    <p className="text-xs font-medium">
                      <span className="text-primary">
                        {t("settings:market_data_page.click_to_upload")}
                      </span>{" "}
                      {t("settings:market_data_page.or_drop")}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("settings:market_data_page.csv_only")}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Hidden File Input */}
        <Input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Error Display */}
        {error && (
          <Alert variant="destructive">
            <Icons.AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-xs">
            {t("settings:market_data_page.overwrite_hint")}
          </p>

          <Button onClick={onValidate} disabled={!file || isValidating}>
            {isValidating
              ? t("settings:market_data_page.validating")
              : t("settings:market_data_page.validate_file")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
