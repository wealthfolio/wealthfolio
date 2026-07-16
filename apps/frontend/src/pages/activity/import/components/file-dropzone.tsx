import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface FileDropzoneProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  isLoading?: boolean;
  accept?: string;
  isValid?: boolean;
  error?: string | null;
}

export const FileDropzone = ({
  file,
  onFileChange,
  isLoading = false,
  accept = "*",
  isValid = true,
  error = null,
}: FileDropzoneProps) => {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFileChange(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileChange(e.target.files[0]);
    }
  };

  const handleClick = () => {
    if (!file && !isLoading) {
      fileInputRef.current?.click();
    }
  };

  const handleRemoveFile = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering the parent div's click handler
    onFileChange(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Determine the border and background colors based on state
  // Use same styling as AccountSelector - icons show status colors, not background
  const getBorderClasses = () => {
    if (isDragging) {
      return "border-primary bg-primary/5";
    }

    if (file && isValid && !error && !isLoading) {
      return "border-border bg-background";
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
        type: "spring",
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
  } as const;

  // Animation variants for icons
  const iconVariants = {
    initial: { scale: 0.6, opacity: 0 },
    animate: {
      scale: 1,
      opacity: 1,
      transition: {
        delay: 0.1,
        type: "spring",
        stiffness: 300,
      },
    },
  } as const;

  // Use solid border when file is valid
  const useSolidBorder = file && isValid && !error && !isLoading;

  return (
    <div
      className={`group relative flex h-full flex-col justify-center rounded-lg border p-4 transition-colors ${useSolidBorder ? "" : "border-dashed"} ${getBorderClasses()} ${!file && !isLoading ? "cursor-pointer" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        className="hidden"
        accept={accept}
        disabled={isLoading}
      />

      {file && !isLoading && (
        <div
          className="bg-background/90 dark:bg-background/95 pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-90"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex flex-col items-center gap-3">
            <Button size="sm" onClick={handleRemoveFile} className="flex items-center gap-1.5 px-3">
              <Icons.Trash className="h-4 w-4" />
              <span>{t("activity:import.upload.removeFile")}</span>
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col items-center justify-center space-y-2">
        <AnimatePresence mode="wait">
          {isLoading ? (
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
          ) : file && (!isValid || error) ? (
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
                {isValid ? (
                  <Icons.CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
                ) : (
                  <Icons.FileText className="h-5 w-5 text-green-600 dark:text-green-400" />
                )}
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
            {isLoading ? (
              <motion.p
                key="loading-text"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.2 }}
                className="text-xs font-medium"
              >
                {t("activity:import.upload.processingFile")}
              </motion.p>
            ) : file && (!isValid || error) ? (
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
                <p className="text-muted-foreground text-xs">{(file.size / 1024).toFixed(2)} KB</p>
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
                  <span className="text-primary">{t("activity:import.upload.clickToUpload")}</span>{" "}
                  {t("activity:import.upload.orDrop")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("activity:import.upload.csvOnly")}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
