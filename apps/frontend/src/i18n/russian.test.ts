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

function tags(value: string) {
  return [...value.matchAll(/<\/?[A-Za-z][^>]*>/g)].map((match) => match[0]).sort();
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
    ["performance:section.risk", "Риск"], // Risk
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
    ["connect:newAccounts.transactions", "Транзакции"], // transactions (owner)
    ["holdings:holdings", "Позиции"], // Holdings
    ["activity:filter_account", "Счёт"], // Account (broker account)
  ])("uses the house term in %s", (key, expected) => {
    expect(allStrings.get(key)).toBe(expected);
  });

  // Owner decision: the user's sign-in account is «аккаунт» (a broker account stays «счёт»).
  it("says аккаунт for the signed-in user's account", () => {
    expect(allStrings.get("auth:context.oidcErrors.forbidden")).toMatch(/аккаунт/i);
  });

  // Owner decision: «профиль» only where English says profile.
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

  // Owner decision: only a lone Cash is «деньги»; Cash Balance is «денежный баланс», Cash Account «денежный счёт».
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
      const value = allStrings.get(key) ?? "";
      if (/^[A-Z]/.test(source) && /^[а-яё]/.test(value)) bad.push(`${key} = ${value}`);
    }
    expect(bad).toEqual([]);
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
});
