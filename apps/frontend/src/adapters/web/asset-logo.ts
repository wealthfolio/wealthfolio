// Custom asset logo overrides - web adapter.
// The image is served directly by the backend at a stable URL, so no
// client-side caching/decoding step is needed the way Tauri requires.

const logoPath = (assetId: string): string => `/api/v1/assets/${encodeURIComponent(assetId)}/logo`;

export const getAssetLogoUrl = async (
  asset: { id: string; customLogoFilename?: string | null } | undefined,
): Promise<string | null> => {
  if (!asset?.customLogoFilename) return null;
  return logoPath(asset.id);
};

/**
 * Fetches the logo bytes and returns a self-contained `data:` URL rather
 * than the relative path `getAssetLogoUrl` returns — needed by callers
 * (e.g. sandboxed addon iframes) that can't rely on sharing the app's own
 * origin for a plain relative fetch.
 */
export const getAssetLogoDataUrl = async (assetId: string): Promise<string | null> => {
  const res = await fetch(logoPath(assetId), { credentials: "same-origin" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch logo (${res.status})`);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read logo blob"));
    reader.readAsDataURL(blob);
  });
};

export const uploadAssetLogo = async (assetId: string, file?: File): Promise<boolean> => {
  if (!file) throw new Error("A file is required to upload a logo");
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(logoPath(assetId), {
    method: "POST",
    body: formData,
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`Failed to upload logo (${res.status})`);
  }
  return true;
};

export const removeAssetLogo = async (assetId: string): Promise<void> => {
  const res = await fetch(logoPath(assetId), {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`Failed to remove logo (${res.status})`);
  }
};
