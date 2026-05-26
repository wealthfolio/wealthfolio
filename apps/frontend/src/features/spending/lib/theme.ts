export type Palette = {
  key: string;
  label: string;
  hsl: string;
  deep: string;
  mid: string;
};

export const FOREST_THEME: Palette = {
  key: "forest",
  label: "Forest",
  hsl: "hsl(155 32% 26%)",
  deep: "#2A573F",
  mid: "#71A290",
};

export const themeBg = (p: Palette, alpha: number): string => p.hsl.replace(")", ` / ${alpha})`);
