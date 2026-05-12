import { useState } from "react";
import {
  createAustraliaCgtAddonStore,
  emptyAustraliaCgtAddonData,
  type AustraliaCgtAddonData,
} from "../lib/tax-data";

export function useAustraliaCgtTaxData() {
  const [taxDataStore] = useState(() => createAustraliaCgtAddonStore());
  const [taxData, setTaxData] = useState<AustraliaCgtAddonData>(() => taxDataStore.load());

  const saveTaxData = (nextData: AustraliaCgtAddonData) => {
    setTaxData(nextData);
    taxDataStore.save(nextData);
  };

  const clearTaxData = () => {
    const nextData = emptyAustraliaCgtAddonData();
    taxDataStore.clear();
    setTaxData(nextData);
  };

  return {
    taxData,
    saveTaxData,
    clearTaxData,
  };
}
