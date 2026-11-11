import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { NAMESPACES } from "./locales";

type Translation = string | { [key: string]: Translation };

const english = import.meta.glob<Translation>("./locales/en/*.json", {
  eager: true,
  import: "default",
});
const russian = import.meta.glob<Translation>("./locales/ru/*.json", {
  eager: true,
  import: "default",
});

function flatten(value: Translation, prefix = ""): Map<string, string> {
  if (typeof value === "string") return new Map([[prefix, value]]);

  return new Map(
    Object.entries(value).flatMap(([key, nested]) => [
      ...flatten(nested, prefix ? `${prefix}.${key}` : key).entries(),
    ]),
  );
}

function byNamespace(files: Record<string, Translation>, language: string) {
  return new Map<string, string>(
    Object.entries(files).flatMap(([path, translation]) => {
      const namespace = path.replace(`./locales/${language}/`, "").replace(".json", "");
      return [...flatten(translation).entries()].map(
        ([key, value]) => [`${namespace}:${key}`, value] as const,
      );
    }),
  );
}

/** Every English and Russian string as `namespace:key` -> value, for whole-catalog sweeps. */
const englishStrings = byNamespace(english, "en");
const allStrings = byNamespace(russian, "ru");

function offenders(term: string, allowed: ReadonlySet<string> = new Set()) {
  return [...allStrings]
    .filter(([key, value]) => value.toLowerCase().includes(term) && !allowed.has(key))
    .map(([key, value]) => `${key} = ${value}`);
}

/** Named tags (`<strong>`) and the indexed tags of `<Trans>` (`<0>`, `<1>`). */
function tags(value: string) {
  return [...value.matchAll(/<\/?[A-Za-z0-9][^>]*>/g)].map((match) => match[0]).sort();
}

describe("Russian terminology", () => {
  it(`has a catalog for every namespace (${NAMESPACES.length})`, () => {
    expect(Object.keys(russian)).toHaveLength(NAMESPACES.length);
  });

  // Labels whose English value is exactly the term: the whole value is the house term.
  it.each([
    ["activity:form.label_asset", "Актив"], // Asset
    ["activity:field_symbol", "Тикер"], // Symbol
    ["dashboard:tabs.spending", "Расходы"], // Spending
    ["common:activity", "Операция"], // Activity
    ["activity:tab_income", "Доход"], // Income
    ["goals:detail.goal_fallback", "Цель"], // Goal
    ["allocation:donut.portfolio", "Портфель"], // Portfolio
    ["activity:field_price", "Цена"], // Price
    ["activity:field_amount", "Сумма"], // Amount
    ["activity:form.position", "Позиция"], // Position
    ["asset:table.quote", "Котировка"], // Quote
    ["ai:allocation.title", "Распределение"], // Allocation
    ["account:snapshot.header_cash", "Деньги"], // Cash
    ["activity:type_withdrawal", "Вывод средств"], // Withdrawal
    ["activity:type_fee", "Комиссия"], // Fee
    ["account:balance", "Баланс"], // Balance
    ["activity:type_dividend", "Дивиденд"], // Dividend
    ["asset:profile.valuation", "Оценка"], // Valuation
    ["asset:profile.kind.liability", "Обязательство"], // Liability
    ["account:performance", "Доходность"], // Performance
    ["activity:type_interest", "Проценты"], // Interest
    ["activity:table_quantity", "Количество"], // Quantity
    ["account:cost_basis", "Себестоимость"], // Cost Basis
    ["asset:loanPayments.loan", "Кредит"], // Loan
    ["account:investments", "Инвестиции"], // Investments
    ["dashboard:tabs.net_worth", "Чистый капитал"], // Net Worth
    ["performance:benchmark", "Бенчмарк"], // Benchmark
    ["activity:form.asset_type_bond", "Облигация"], // Bond
    ["asset:altContent.mortgage_suffix", "Ипотека"], // Mortgage
    ["holdings:sector", "Сектор"], // Sector
    ["allocation:worksheet.modeRebalance", "Ребалансировка"], // Rebalance
    ["dashboard:uncategorized", "Без категории"], // Uncategorized
    ["insights:insights.explorer.lens_risk", "Риск"], // Risk
    ["account:type_cryptocurrency", "Криптовалюта"], // Cryptocurrency
    ["account:volatility", "Волатильность"], // Volatility
    ["allocation:editor.industry", "Отрасль"], // Industry
    ["asset:detailCard.total_return", "Полная доходность"], // Total Return
    ["performance:annualized_return", "Годовая доходность"], // Annualized Return
    ["account:book_value", "Балансовая стоимость"], // Book Value
    ["holdings:debt", "Долг"], // Debt
    ["performance:money_weighted_return", "Доходность, взвешенная по деньгам"], // Money-Weighted Return
    ["performance:time_weighted_return", "Доходность, взвешенная по времени"], // Time-Weighted Return
    ["activity:subtype_return_of_capital", "Возврат капитала"], // Return of Capital
    ["asset:lots.unrealized_gain", "Нереализованная прибыль"], // Unrealized Gain
    ["income:ex_dividend_date", "Экс-дивидендная дата"], // Ex-Dividend Date
    ["holdings:sale_proceeds", "Выручка от продажи"], // Sale Proceeds
    ["asset:altContent.interest_rate", "Процентная ставка"], // Interest Rate
    ["connect:newAccounts.transactions", "Транзакции"], // Transactions
    ["holdings:holdings", "Позиции"], // Holdings
    ["activity:filter_account", "Счёт"], // Account (broker account)
  ])("uses the house term in %s", (key, expected) => {
    expect(allStrings.get(key)).toBe(expected);
  });

  // The user's sign-in account is «аккаунт»; a broker account stays «счёт».
  it("says аккаунт for the signed-in user's account", () => {
    expect(allStrings.get("auth:context.oidcErrors.forbidden")).toMatch(/аккаунт/i);
  });

  // «профиль» only where English says profile.
  it("says профиль where English says profile", () => {
    expect(allStrings.get("common:profiles.yourProfile")).toMatch(/профил/i);
  });

  // `avoid` are false friends, wrong in every context of the app.
  it.each([
    ["ассет", [] as string[]], // Asset
    ["спендинг", [] as string[]], // Spending
    ["трансфер", [] as string[]], // Transfer
    ["портфолио", [] as string[]], // Portfolio
    ["прайс", [] as string[]], // Price
    ["аллокация", [] as string[]], // Allocation
    ["контрибуция", [] as string[]], // Contribution
    ["кэш", [] as string[]], // Cash
    ["перформанс", [] as string[]], // Performance
    ["аджастмент", [] as string[]], // adjustment
    ["дроудаун", [] as string[]], // Drawdown
    ["бонд", [] as string[]], // Bond
    ["лосс", [] as string[]], // loss
    ["рефанд", [] as string[]], // Refund
    ["эквити", [] as string[]], // Equity
    ["индустрия", [] as string[]], // Industry
    ["принципал", [] as string[]], // Principal
    ["ролловер", [] as string[]], // rollover
    ["шортфолл", [] as string[]], // Shortfall
    ["сурплус", [] as string[]], // surplus
    ["бакет", [] as string[]], // bucket
    ["чекинг", [] as string[]], // Checking
    ["счета денег", [] as string[]], // Cash Account is «денежный счёт»
    ["счетов денег", [] as string[]],
    ["счёта денег", [] as string[]],
  ])("rejects %s", (term, allowed) => {
    expect(offenders(term, new Set(allowed))).toEqual([]);
  });

  it("uses Russian letters only", () => {
    const found = [...allStrings].filter(([, value]) => /[іїєґІЇЄҐ]/.test(value));
    expect(found.map(([key]) => key)).toEqual([]);
  });

  it("keeps every Trans tag from English", () => {
    expect(allStrings.size).toBeGreaterThan(0);
    for (const [key, source] of englishStrings) {
      expect(tags(allStrings.get(key) ?? ""), key).toEqual(tags(source));
    }
  });

  // `<Trans>` puts its components at `<0>`, `<1>`: the Terms and Privacy links, the email.
  it.each([
    ["auth:connect.terms", ["</0>", "</1>", "<0>", "<1>"]],
    ["auth:connect.otp.sentTo", ["</0>", "<0>"]],
    ["holdings:holdings_in_category", ["</1>", "<1>"]],
  ])("keeps the indexed tags of %s", (key, expected) => {
    expect(tags(allStrings.get(key) ?? "")).toEqual(expected);
  });

  // `other` is the fractional category ("1,5 года"): it takes the form of `few`, not of `many`.
  it("does not copy `many` into `other` where `few` differs", () => {
    const bad: string[] = [];
    for (const [key, other] of allStrings) {
      if (!key.endsWith("_other")) continue;
      const base = key.slice(0, -"_other".length);
      const few = allStrings.get(`${base}_few`);
      const many = allStrings.get(`${base}_many`);
      if (few !== undefined && many !== undefined && few !== many && other === many) {
        bad.push(`${key} = ${other}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // Only a lone Cash is «деньги»; Cash Balance is «денежный баланс», Cash Account «денежный счёт».
  it.each([
    ["баланс денег", /баланс\w* (ваших )?денег/iu],
    ["счёт денег", /сч[её]т\w* денег/iu],
  ])("rejects the compound %s", (_label, pattern) => {
    const found = [...allStrings].filter(([, value]) => pattern.test(value));
    expect(found.map(([key, value]) => `${key} = ${value}`)).toEqual([]);
  });

  // «счёт» loses the ё in the plural and keeps it in the singular ("1,5 счёта").
  it("spells the plural of счёт without ё", () => {
    const bad = /(?<![а-яё])счёт(ов|ам|ами|ах)(?![а-яё])|Все счёта/iu;
    const found = [...allStrings].filter(([, value]) => bad.test(value));
    expect(found.map(([key, value]) => `${key} = ${value}`)).toEqual([]);
  });

  it("writes ещё with ё", () => {
    const found = [...allStrings].filter(([, value]) => /(?<![а-яё])еще(?![а-яё])/iu.test(value));
    expect(found.map(([key, value]) => `${key} = ${value}`)).toEqual([]);
  });

  it("starts a sentence with a capital where English does", () => {
    const bad: string[] = [];
    for (const [key, source] of englishStrings) {
      // Country names are CLDR's, and CLDR writes some in lowercase («о-ва Кайман»).
      if (key.startsWith("taxonomies:categoryNames.regions.country_")) continue;
      const value = allStrings.get(key) ?? "";
      if (/^[A-Z]/.test(source) && /^[а-яё]/.test(value)) bad.push(`${key} = ${value}`);
    }
    expect(bad).toEqual([]);
  });

  // Country labels are the CLDR names of `Intl.DisplayNames`, as in every other locale.
  it.each([
    ["RU", "Россия"],
    ["US", "Соединенные Штаты"],
    ["KG", "Киргизия"],
    ["CF", "Центрально-Африканская Республика"],
    ["ZA", "Южно-Африканская Республика"],
    ["AE", "ОАЭ"],
    ["KR", "Республика Корея"],
    ["SY", "Сирия"],
    ["HK", "Гонконг (САР)"],
    ["KY", "о-ва Кайман"],
  ])("names the country %s as CLDR does", (code, name) => {
    expect(allStrings.get(`taxonomies:categoryNames.regions.country_${code}`)).toBe(name);
  });
  // dashboard-page.tsx joins prefix + age + suffix; the preposition lives in the prefix.
  it.each([61, 65])("assembles the goals verdict sentences at age %i", (age) => {
    const fill = (key: string) =>
      (allStrings.get(`goals:dashboard.verdict.${key}`) ?? "").replaceAll("{{age}}", String(age));
    const sentence = (prefix: string, suffix?: string) =>
      [fill(prefix), fill("age"), suffix ? fill(suffix) : ""].join(" ").trim();
    const gap = sentence("spending_gap_prefix", "spending_gap_suffix");
    const depleted = sentence("depleted_prefix", "depleted_suffix");
    const onTrack = sentence("on_track_prefix", "on_track_suffix");
    const notReachable = sentence("not_reachable_prefix", "not_reachable_suffix");
    expect(gap).toContain(`с возраста ${age}`);
    expect(depleted).toContain(`исчерпается в возрасте ${age}`);
    expect(onTrack).toContain(`на пенсию в возрасте ${age}`);
    expect(notReachable).toContain(`к возрасту ${age}`);
    for (const text of [gap, depleted, onTrack, notReachable]) {
      expect(text).not.toMatch(/(?<![а-яё])(с|в|к) в возрасте/);
      expect(text).not.toMatch(/лет по плану/);
    }
  });

  it("never stacks a preposition on «в возрасте» or ends a plan with «лет по плану»", () => {
    const found = [...allStrings].filter(([, value]) =>
      /(?<![а-яё])(с|в|к) в возрасте|лет по плану/u.test(value),
    );
    expect(found.map(([key, value]) => `${key} = ${value}`)).toEqual([]);
  });

  // The count of the plural key is the account total; the other counters must not be inflected.
  it("keeps every partialSyncing form identical and without an inflected counter", () => {
    const forms = ["one", "few", "many", "other"].map((c) =>
      allStrings.get(`connect:connections.partialSyncing_${c}`),
    );
    expect(new Set(forms).size).toBe(1);
    expect(forms[0]).toBe("Синхронизируется: {{syncing}} из {{total}} · Исключено: {{excluded}}");
  });

  it("reads «из …» after a number on the spending and loan cards", () => {
    for (const form of ["", "_one", "_few", "_many", "_other"]) {
      expect(allStrings.get(`settings:spending.module.stat_accounts_unit${form}`)).toMatch(
        /^из \{\{count\}\} /,
      );
    }
    expect(allStrings.get("asset:loanOverview.of_original")).toMatch(/^из \{\{amount\}\} /);
  });

  // Hints and descriptions address the user (imperative); buttons keep the infinitive.
  it("does not tell the user «Нажать» in a hint", () => {
    const found = [...allStrings].filter(
      ([, value]) => /(^|[^а-яё])Нажать(?![а-яё])/u.test(value) || value.includes("Нажать, чтобы"),
    );
    expect(found.map(([key, value]) => `${key} = ${value}`)).toEqual([]);
  });

  it.each([
    ["health:issues.quote_sync_error.message", /Проверьте тикеры/],
    ["health:issues.account_timezone_invalid.message", /Обновите его/],
  ])("tells the user what to do in the imperative in %s", (key, pattern) => {
    expect(allStrings.get(key)).toMatch(pattern);
  });

  // Instruction sentences in messages and descriptions are imperative, like hints. Buttons, menu
  // items and permission lists keep the infinitive and are not swept: a sentence counts only when
  // it ends with a full stop or is long, the English counterpart opens with a bare verb, and the
  // key is not a permission description.
  it("never writes an instruction sentence to the user in the infinitive", () => {
    const infinitive =
      /^(?!Эти(?![а-яё])|Пути(?![а-яё])|Есть(?![а-яё])|Часть(?![а-яё])|Области(?![а-яё]))[А-Яа-яё]{3,}(ать|ять|еть|ить|уть|оть|ыть|ться|ти|чь)(?![а-яё])/u;
    const notImperative =
      /^(The|A|An|This|These|Those|Your|You|No|Some|Each|Every|It|Its|There|We|Are|Is|Not|Unable|Failed|Nothing|Setup|Session|Stopping|Records|Cash|Return|Values|Account|When|If|Only|Higher|Volatility|Portion|Part|Pre|Money|Time|Price|Value|Capabilities|Mirostat|Property|Tracking|Looking|Split|Performance|Transfer)(?![A-Za-z])/;
    const permissionKey =
      /^(settings:agentAccess\.scope\.|settings:addonPermissions\.|ai:providerSettings\.)/;
    const found = [...allStrings].flatMap(([key, value]) => {
      if (permissionKey.test(key)) return [];
      const base = key.replace(/_(one|few|many|other)$/, "");
      const en = englishStrings.get(key) ?? englishStrings.get(`${base}_other`) ?? "";
      const englishImperative = en
        .split(/(?<=[.!?…])\s+/)
        .some((sentence) => /^[A-Z][a-z]+/.test(sentence) && !notImperative.test(sentence));
      const sentences = value.split(/(?<=[.!?…])\s+/);
      const bad = sentences.filter(
        (sentence) =>
          infinitive.test(sentence) &&
          !/\?\s*$/.test(sentence) &&
          (/[.…]$/.test(sentence.trim()) ||
            sentences.length > 1 ||
            sentence.split(/\s+/).length >= 7),
      );
      return englishImperative ? bad.map((sentence) => `${key}: ${sentence}`) : [];
    });
    expect(
      found.filter((line) => !INFINITIVE_CONTROLS.has(line.split(":").slice(0, 2).join(":"))),
    ).toEqual([]);
  });
});

/** Buttons, menu items, toggles and a tooltip that name an action: the infinitive is right there. */
const INFINITIVE_CONTROLS = new Set([
  "activity:operations.link_transfer",
  "activity:operations.convert_to_transfer",
  "activity:import.reviewToolbar.importAnywayTooltip",
  "ai:model.addModels",
  "allocation:worksheet.addAsDepositTo",
  "asset:historyCard.hide_activity_markers",
  "asset:historyCard.show_activity_markers",
  "common:load_more",
  "common:map_to",
  "common:component.track_assets_not_found",
  "goals:funding.use_max",
  "goals:risk_lab.montecarlo.run_10k",
  "goals:risk_lab.montecarlo.run_100k",
  "settings:market_data_page.reset_history_menu",
  "settings:spending.categories.merge.destination",
  "spending:transactions.linkTransfer",
  "spending:transactions.convertToTransfer",
  "spending:dashboard.viewAllToTag",
  "spending:dashboard.viewAllToTag_one",
  "spending:dashboard.viewAllToTag_few",
  "spending:dashboard.viewAllToTag_many",
  "spending:dashboard.viewAllToTag_other",
]);

const i18n = createInstance();
await i18n.init({
  lng: "ru",
  fallbackLng: false,
  interpolation: { escapeValue: false },
  ns: ["asset", "sync", "health"],
  resources: {
    ru: Object.fromEntries(
      Object.entries(russian).map(([path, catalog]) => [
        path.replace("./locales/ru/", "").replace(".json", ""),
        catalog,
      ]),
    ),
  },
});

describe("Russian plural output", () => {
  it.each([
    [1, "год", "месяц"],
    [2, "года", "месяца"],
    [5, "лет", "месяцев"],
    [11, "лет", "месяцев"],
    [21, "год", "месяц"],
    [22, "года", "месяца"],
    [25, "лет", "месяцев"],
    [111, "лет", "месяцев"],
    [1.5, "года", "месяца"],
  ])("renders the CLDR form of a %s-unit duration", (count, year, month) => {
    expect(i18n.t("asset:loanActions.duration_year", { count })).toBe(`${count} ${year}`);
    expect(i18n.t("asset:loanActions.duration_month", { count })).toBe(`${count} ${month}`);
  });

  it.each([
    [1, "день"],
    [2, "дня"],
    [5, "дней"],
    [21, "день"],
    [22, "дня"],
    [111, "дней"],
  ])("agrees the noun in sync:status.daysAgo for %s", (count, day) => {
    expect(i18n.t("sync:status.daysAgo", { count })).toContain(`${count} ${day}`);
  });

  // English `_one` of these families has no number ("Missing rate"), but Russian `one` is also 21 and 31.
  const countless = [...englishStrings.keys()].filter((key) => {
    if (!key.endsWith("_one")) return false;
    const other = englishStrings.get(`${key.slice(0, -4)}_other`);
    return other?.includes("{{count}}") && !englishStrings.get(key)!.includes("{{count}}");
  });

  it("finds the families whose English singular carries no count", () => {
    expect(countless).toContain("health:issues.data_unknown_performance_flow_source.title_one");
    expect(countless.length).toBeGreaterThanOrEqual(25);
  });

  it("keeps the count in every such `one` form", () => {
    const bad = countless.filter((key) => !allStrings.get(key)?.includes("{{count}}"));
    expect(bad).toEqual([]);
  });

  it.each([1, 21, 31, 101])("shows %s in the unknown-flow-source title", (count) => {
    const text = i18n.t("health:issues.data_unknown_performance_flow_source.title", { count });
    expect(text).toContain(String(count));
  });

  it.each([
    [21, "21"],
    [22, "22"],
    [25, "25"],
  ])("states the count %s in a countless-English family", (count, shown) => {
    expect(i18n.t("health:issues.data_unknown_performance_flow_source.title", { count })).toContain(
      shown,
    );
  });

  it("never leads with a bare count outside a plural family", () => {
    const bad = [...allStrings].filter(
      ([key, value]) =>
        !/_(zero|one|two|few|many|other)$/.test(key) && /^\{\{count\}\}\s+\p{L}/u.test(value),
    );
    expect(bad.map(([key, value]) => `${key} = ${value}`)).toEqual([]);
  });
});

describe("Russian words inserted into sentences", () => {
  it("keeps the embedded loan durations in a label form", () => {
    expect(i18n.t("asset:loanOverview.early_by", { duration: "2 года" })).toBe(
      "Опережение графика: 2 года",
    );
    expect(i18n.t("asset:loanOverview.term_left", { duration: "2 года" })).toBe("Осталось: 2 года");
  });

  it("agrees the loan term count while the elapsed duration stays fixed", () => {
    expect(i18n.t("asset:loanOverview.term_elapsed_years", { count: 5, elapsed: "2 года" })).toBe(
      "Прошло 2 года из срока в 5 лет.",
    );
    expect(i18n.t("asset:loanOverview.term_elapsed_years", { count: 21, elapsed: "2 года" })).toBe(
      "Прошло 2 года из срока в 21 год.",
    );
  });

  it.each([
    [
      "ai:createRule.draftedRule",
      'Черновик правила: всё совпадающее с "{{pattern}}" будет «{{category}}».',
    ],
    ["holdings:holdings_in_category", "Позиции в категории <1>{{category}}</1>"],
    [
      "activity:date_list.cash_negative_after",
      "Деньги впервые ушли в минус после операции «{{type}}».",
    ],
    ["activity:transfer_match.only_type_searched", "Ищутся только операции типа «{{type}}»."],
    [
      "spending:transactions.deleteConfirmSingle",
      "Удалить операцию «{{type}}» на сумму {{amount}}?",
    ],
    ["spending:whatChanged.headlineMoreSuffix", " больше, чем {{priorLabel}}."],
    [
      "ai:assetTaxonomy.loadedCategories_one",
      "Загружена {{count}} категория · таксономия: {{taxonomy}}",
    ],
  ])("keeps the inserted word in %s out of a case-governing position", (key, expected) => {
    expect(allStrings.get(key)).toBe(expected);
  });

  it("writes search placeholders in the imperative «Найдите…»", () => {
    const bad = [...allStrings].filter(
      ([key, value]) =>
        /search/i.test(key) &&
        /(\.\.\.|…)$/u.test(value) &&
        /^(Ищите|Найти)(?![а-яё])/u.test(value),
    );
    expect(bad.map(([key, value]) => `${key} = ${value}`)).toEqual([]);
  });

  // Every key below is used as a `placeholder=` in the app: a hint tells the user what to do, so it is
  // imperative («Выберите…», «Найдите…»), not the infinitive of a button. «Поиск…» is also fine.
  const placeholderKeys = [
    "activity:form.placeholder_select_currency",
    "activity:form.placeholder_select_subtype",
    "activity:import.parseSettings.selectDateFormat",
    "activity:import.parseSettings.selectDelimiter",
    "activity:import.parseSettings.selectSeparator",
    "ai:importCsv.selectTargetAccount",
    "allocation:worksheet.findAccount",
    "asset:assetForm.select_quote_mode",
    "asset:createSecurity.select_currency",
    "asset:createSecurity.select_exchange",
    "asset:createSecurity.select_type",
    "asset:detailsSheet.select_asset_to_link",
    "asset:detailsSheet.select_collectible_type",
    "asset:detailsSheet.select_liability_type",
    "asset:detailsSheet.select_metal",
    "asset:detailsSheet.select_property_type",
    "asset:detailsSheet.select_unit",
    "asset:detailsSheet.select_vehicle_type",
    "asset:editSheet.select_currency",
    "asset:editSheet.select_exchange",
    "asset:editSheet.select_frequency",
    "asset:editSheet.select_provider",
    "asset:editSheet.select_type",
    "asset:loanPayments.choose_loan",
    "asset:quickAdd.select_asset_to_link",
    "asset:quickAdd.select_currency",
    "asset:quickAdd.select_metal",
    "asset:quickAdd.select_type",
    "asset:quickAdd.select_unit",
    "common:component.select_type",
    "common:search_symbol",
    "holdings:select_currency",
    "settings:fx_select_data_source",
    "spending:cashForm.selectAccount",
    "spending:rules.selectActivityType",
    "spending:rules.selectMatchType",
    "activity:form.placeholder_select_account",
    // These reach `placeholder=` through a ternary, `??` or a shared variable.
    "ai:providerSettings.enterApiKey",
    "common:profiles.enterPassword",
    "activity:import.mapping.selectColumn",
    "activity:import.template.selectFormat",
    "settings:tz_select_placeholder",
    "ui:select.placeholder",
    "asset:mobileTable.search_placeholder",
  ];

  it.each(placeholderKeys)("writes the placeholder %s as an imperative", (key) => {
    const value = allStrings.get(key);
    expect(value, key).toBeDefined();
    expect(value).not.toMatch(/^(Выбрать|Искать|Найти|Ввести|Указать|Добавить|Задать)(?![а-яё])/u);
  });

  it.each([
    ["settings:tz_select_placeholder", "Выберите часовой пояс"],
    ["ui:select.placeholder", "Выберите вариант"],
  ])("writes the placeholder %s in the imperative", (key, expected) => {
    expect(allStrings.get(key)).toBe(expected);
  });

  it("names Russia in the region list", () => {
    expect(allStrings.get("settings:formattingRegion.options.russia")).toBe("Россия");
  });
});
