import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import english from "@/i18n/locales/en/taxonomies.json";
import arabic from "@/i18n/locales/ar/taxonomies.json";
import german from "@/i18n/locales/de/taxonomies.json";
import spanish from "@/i18n/locales/es/taxonomies.json";
import korean from "@/i18n/locales/ko/taxonomies.json";
import french from "@/i18n/locales/fr/taxonomies.json";
import italian from "@/i18n/locales/it/taxonomies.json";
import japanese from "@/i18n/locales/ja/taxonomies.json";
import portuguese from "@/i18n/locales/pt/taxonomies.json";
import { getCategoryLabel } from "./taxonomy-labels";

const i18n = createInstance();
const englishNames: Record<string, Record<string, string>> = english.categoryNames;
beforeAll(async () => {
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: { taxonomies: english },
      pt: { taxonomies: portuguese },
      ja: { taxonomies: japanese },
      it: { taxonomies: italian },
      fr: { taxonomies: french },
      ar: { taxonomies: arabic },
      de: { taxonomies: german },
      es: { taxonomies: spanish },
      ko: { taxonomies: korean },
    },
  });
});

// Financial meanings, not unrelated dictionary senses:
// CDs: https://centralbank.ae/ar/news-and-publications/news-and-insights/press-release/reduction-of-interest-rates-on-certificate-of-deposit/
// Warrant: https://bafin.de/DE/Verbraucher/GeldanlageWertpapiere/Grundregeln_der_Geldanlage/Grundregeln_der_Geldanlage_node.html
// Right: https://live.deutsche-boerse.com/wissen/wertpapiere/aktien/bezugsrechte
// Stocks: https://www.cnmv.es/portal/Inversor/Renta-Variable?lang=es
// Drug retail: https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7796&mi=2462
// Arabic warrants/rights: https://legislation.uaecma.gov.ae/ar/الأذونات-المغطاة
// https://www.dfm.ae/ar/investing/services/rights-issue-subscription
// French warrants/rights: https://www.amf-france.org/fr/espace-epargnants/comprendre-les-produits-financiers/produits-complexes/warrants
// https://www.amf-france.org/fr/espace-epargnants/savoir-bien-investir/etre-un-actionnaire-individuel/bien-comprendre-les-droits-preferentiels-de-souscription
// Italian warrants/rights: https://www.borsaitaliana.it/borsa/glossario/warrant.html
// https://www.borsaitaliana.it/borsa/glossario/diritto-di-opzione.html
// Japanese rights: https://www.jpx.co.jp/equities/products/subscription/outline/
// Korean warrants: https://open.krx.co.kr/contents/OPN/01/01030401/OPN01030401.jsp
// Spanish warrants/rights: https://www.cnmv.es/portal/gPage?id=SolISIN&lang=es
// Brazilian Portuguese warrants: https://www.b3.com.br/pt_br/produtos-e-servicos/negociacao/renda-variavel/bonus-de-subscricao.htm
// Fiat backing: https://www.dnb.nl/en/payments/cryptos-and-supervision-what-you-need-to-know/what-is-a-stablecoin/
// Power: https://www.cre.fr/electricite/marche-de-gros-de-lelectricite/presentation.html
// Secondaries: https://www.blackrock.com/institutions/en-us/investment-capabilities/strategies/secondaries
describe("financial taxonomy terminology", () => {
  it.each([
    [
      "ar",
      "instrument_type",
      "MONEY_MARKET_DEBT",
      "T-Bills / CDs / Commercial Paper",
      "أذونات الخزانة / شهادات الإيداع / الأوراق التجارية",
    ],
    [
      "de",
      "instrument_type",
      "EQUITY_WARRANT_RIGHT",
      "Warrant / Right",
      "Optionsschein / Bezugsrecht",
    ],
    ["es", "instrument_type", "EQUITY_SECURITY", "Stocks", "Acciones"],
    ["ko", "industries_gics", "30101010", "Drug Retail", "의약품 소매"],
    ["ar", "instrument_type", "EQUITY_WARRANT_RIGHT", "Warrant / Right", "أذونات / حقوق اكتتاب"],
    [
      "fr",
      "instrument_type",
      "EQUITY_WARRANT_RIGHT",
      "Warrant / Right",
      "Warrant / Droit de souscription",
    ],
    [
      "it",
      "instrument_type",
      "EQUITY_WARRANT_RIGHT",
      "Warrant / Right",
      "Warrant / Diritto di opzione",
    ],
    ["ja", "instrument_type", "EQUITY_WARRANT_RIGHT", "Warrant / Right", "ワラント / ライツ"],
    ["ko", "instrument_type", "EQUITY_WARRANT_RIGHT", "Warrant / Right", "워런트 / 신주인수권"],
    [
      "es",
      "instrument_type",
      "EQUITY_WARRANT_RIGHT",
      "Warrant / Right",
      "Warrant / Derecho de suscripción",
    ],
    [
      "pt",
      "instrument_type",
      "EQUITY_WARRANT_RIGHT",
      "Warrant / Right",
      "Bônus de subscrição / Direito de subscrição",
    ],
    ["ar", "asset_classes", "DA_STABLECOIN_FIAT", "Fiat-Backed", "مدعومة بالعملات الورقية"],
    ["it", "asset_classes", "DA_STABLECOIN_FIAT", "Fiat-Backed", "Garantite da valuta fiat"],
    ["pt", "asset_classes", "DA_STABLECOIN_FIAT", "Fiat-Backed", "Lastreadas em moeda fiduciária"],
    ["fr", "asset_classes", "COMM_ENERGY_POWER", "Power", "Électricité"],
    ["es", "asset_classes", "COMM_ENERGY_POWER", "Power", "Electricidad"],
    ["pt", "asset_classes", "COMM_ENERGY_POWER", "Power", "Eletricidade"],
    ["ar", "asset_classes", "COMM_ENERGY_POWER", "Power", "الكهرباء"],
    ["ja", "asset_classes", "COMM_ENERGY_POWER", "Power", "電力"],
    ["ko", "asset_classes", "COMM_ENERGY_POWER", "Power", "전력"],
    [
      "ar",
      "asset_classes",
      "EQUITY_PRIVATE_SECONDARIES",
      "Secondaries",
      "استثمارات السوق الثانوية",
    ],
  ] as const)(
    "uses the financial meaning in %s for %s/%s",
    async (locale, taxonomyId, id, seedName, label) => {
      expect(englishNames[taxonomyId][id]).toBe(seedName);
      await i18n.changeLanguage(locale);
      expect(getCategoryLabel(i18n.t, taxonomyId, id, seedName)).toBe(label);
      expect(getCategoryLabel(i18n.t, taxonomyId, id, `My ${seedName}`)).toBe(`My ${seedName}`);
      expect(getCategoryLabel(i18n.t, taxonomyId, "custom", seedName)).toBe(seedName);
      expect(getCategoryLabel(i18n.t, "custom", id, seedName)).toBe(seedName);
      await i18n.changeLanguage("en");
      expect(getCategoryLabel(i18n.t, taxonomyId, id, seedName)).toBe(seedName);
    },
  );
});
