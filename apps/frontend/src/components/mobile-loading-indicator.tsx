import { usePortfolioSyncOptional } from "@/context/portfolio-sync-context";

export function MobileLoadingIndicator() {
  const syncContext = usePortfolioSyncOptional();

  if (!syncContext || syncContext.status === "idle") {
    return null;
  }

  return (
    <div className="bg-primary/10 fixed inset-x-0 top-0 z-100 h-[3px] overflow-hidden">
      {/* Smooth indeterminate progress strip */}
      <div
        className="bg-primary h-full w-2/5 rounded-full"
        style={{
          animation: "indeterminate 1.4s ease-in-out infinite",
        }}
      />
      <style>{`
        @keyframes indeterminate {
          0% {
            transform: translateX(-100%);
          }
          50% {
            transform: translateX(150%);
          }
          100% {
            transform: translateX(400%);
          }
        }
      `}</style>
    </div>
  );
}
