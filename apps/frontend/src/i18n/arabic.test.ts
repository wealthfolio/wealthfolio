import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

const files = import.meta.glob<Record<string, unknown>>("./locales/ar/*.json", {
  eager: true,
  import: "default",
});
const resources = Object.fromEntries(
  Object.entries(files).map(([path, catalog]) => [
    path.replace("./locales/ar/", "").replace(".json", ""),
    catalog,
  ]),
);
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: "ar",
    fallbackLng: false,
    resources: { ar: resources },
    interpolation: { escapeValue: false },
  });
});

describe("Arabic plural output", () => {
  it.each([
    [0, "لم يفشل تحديث أسعار أي أصل"],
    [1, "فشل تحديث سعر أصل واحد"],
    [2, "فشل تحديث أسعار أصلين"],
    [3, "فشل تحديث أسعار 3 أصول"],
    [10, "فشل تحديث أسعار 10 أصول"],
    [11, "فشل تحديث أسعار 11 أصلًا"],
    [99, "فشل تحديث أسعار 99 أصلًا"],
    [100, "فشل تحديث أسعار 100 أصل"],
    [101, "فشل تحديث أسعار 101 أصل"],
    [102, "فشل تحديث أسعار 102 أصل"],
    [103, "فشل تحديث أسعار 103 أصول"],
    [111, "فشل تحديث أسعار 111 أصلًا"],
  ])("renders the price-update notification for %s assets", (count, expected) => {
    expect(i18n.t("common:globalEvents.priceUpdateFailed", { count })).toBe(expected);
  });

  it.each([
    ["activity:datagrid.rows_selected", "تم تحديد صفين"],
    ["activity:transfer_match.within_days", "خلال يومين"],
    ["connect:activity.itemsNeedReview", "عنصران يحتاجان إلى مراجعتك"],
    ["health:issues.data_negative_account_balance.title", "حسابان كان رصيدهما سالبًا"],
    ["holdings:assets_need_valuations", "أصلان يحتاجان إلى تحديث تقييماتهما"],
    ["performance:comparison_notice.not_plotted_count", "عنصران محددان غير معروضين على المخطط"],
    ["spending:transactions.deleteConfirmMany", "هل تريد بالتأكيد حذف معاملتين؟"],
    ["sync:status.daysAgo", "منذ يومين"],
    ["goals:card.years_left", "سنتان متبقيتان"],
    ["goals:card.months_left", "شهران متبقيان"],
    ["activity:table.day_count", "نشاطان"],
  ])("uses the dual and the case required by %s", (key, expected) => {
    expect(i18n.t(key, { count: 2 })).toBe(expected);
  });

  it("keeps independent values when the main count is implicit", () => {
    expect(i18n.t("account:snapshot.summary", { count: 2, cash: "125 USD" })).toBe(
      "مركزان، 125 USD نقدًا",
    );
    expect(
      i18n.t("ai:assetTaxonomy.loadedCategoriesTotal", {
        count: 2,
        taxonomy: "القطاعات",
        total: 10,
      }),
    ).toBe("تم تحميل فئتين · نظام التصنيف: القطاعات · الإجمالي 10");
    expect(i18n.t("common:globalEvents.positions", { count: 2, accounts: 1 })).toBe(
      "مركزان (عدد الحسابات: 1)",
    );
  });

  it("keeps the affected-row count apart from the symbol count it follows", () => {
    // SymbolResolutionPanel joins the two messages; a verb in the second would
    // have to agree with the symbols, whose count it does not see.
    const header = (symbols: number, rows: number) =>
      i18n.t("activity:import.symbolPanel.unrecognized", { count: symbols }) +
      i18n.t("activity:import.symbolPanel.affectingRows", { count: rows });
    expect(header(1, 2)).toBe("1 رمز غير معروف · الصفوف المتأثرة: 2");
    expect(header(2, 2)).toBe("رمزان غير معروفين · الصفوف المتأثرة: 2");
  });

  it.each([1, 2, 3])("does not inflect an independent secondary count of %s", (total) => {
    expect(
      i18n.t("connect:connections.partialSyncing", {
        count: total,
        syncing: 1,
        total,
        excluded: 0,
      }),
    ).toBe(`الحسابات قيد المزامنة: 1 من ${total} · الحسابات المستبعدة: 0`);
    expect(
      i18n.t("settings:spending.module.headline_enabled", { count: total, tracked: 1, total }),
    ).toBe(`الحسابات النقدية المتتبعة: 1 من ${total}. أضف المعاملات عبر الاستيراد أو الإدخال اليدوي.`);
  });

  it.each([
    [1, "سنة واحدة", "شهر واحد"],
    [2, "سنتان", "شهران"],
    [3, "3 سنوات", "3 أشهر"],
    [11, "11 سنةً", "11 شهرًا"],
    [100, "100 سنة", "100 شهر"],
    [102, "102 سنة", "102 شهر"],
    [103, "103 سنوات", "103 أشهر"],
    [1.5, "1.5 سنة", "1.5 شهر"],
  ])("renders the CLDR form of a %s-unit duration", (count, year, month) => {
    expect(i18n.t("asset:loanActions.duration_year", { count })).toBe(year);
    expect(i18n.t("asset:loanActions.duration_month", { count })).toBe(month);
  });

  it("embeds durations only where they stay in the nominative", () => {
    // The fragments are nominative, so sentences place them as a subject or a
    // predicate, never after a preposition.
    expect(i18n.t("asset:loanOverview.early_by", { duration: "سنتان" })).toBe(
      "أبكر من الموعد الأصلي، والفارق سنتان تقريبًا",
    );
    expect(i18n.t("asset:loanOverview.term_left", { duration: "سنتان" })).toBe("المتبقي: سنتان");
    expect(i18n.t("asset:loanOverview.term_elapsed_years", { count: 2, elapsed: "شهران" })).toBe(
      "انقضى شهران من مدة قدرها سنتان.",
    );
    expect(i18n.t("asset:loanOverview.term_elapsed_years", { count: 5, elapsed: "سنتان" })).toBe(
      "انقضى سنتان من مدة قدرها 5 سنوات.",
    );
  });
});

describe("Arabic financial terminology", () => {
  it.each([
    ["activity:form.err_enter_cost_basis", "يرجى إدخال أساس التكلفة."],
    ["activity:form.err_cost_basis_number", "يجب أن يكون أساس التكلفة رقمًا."],
    ["asset:loanActions.recalculate_new_rate", "معدل الفائدة السنوي الجديد (%)"],
    ["asset:loanPayments.escrow", "مبلغ حساب الضمان لكل دفعة"],
    ["income:ex_dividend_date", "تاريخ تداول السهم دون أحقية الأرباح"],
    ["account:money_weighted_return", "العائد المرجح بالنقود"],
    ["performance:money_weighted_return", "العائد المرجح بالنقود"],
    ["performance:metric.money_weighted_return", "العائد المرجح بالنقود"],
    ["activity:type_dividend", "توزيعات الأرباح"],
    ["ai:income.dividends", "توزيعات الأرباح"],
    ["income:dividends", "توزيعات الأرباح"],
    ["activity:import.page.titleHoldings", "استيراد الحيازات"],
    ["common:nav.label_holdings", "عرض الحيازات"],
    ["common:component.add_holding", "إضافة حيازة"],
    ["holdings:instrument_types.FUTURE", "العقود المستقبلية"],
    ["activity:type_credit", "إضافة رصيد"],
    ["activity:subtype_return_of_capital", "رد رأس المال"],
    ["activity:form.type_return_of_capital", "رد رأس المال"],
    ["holdings:sale_proceeds", "حصيلة البيع"],
    ["insights:networth.breakdown_table.liabilities", "الالتزامات"],
    ["goals:risk_lab.scenarios.retire-earlier.label", "التقاعد مبكرًا بسنتين"],
  ])("uses the house term in %s", (key, expected) => {
    expect(i18n.t(key)).toBe(expected);
  });

  it.each(["fire", "traditional"])(
    "describes %s results as simulations, not typical outcomes",
    (mode) => {
      const message = i18n.t(`goals:risk_lab.results.simulation_tooltip_${mode}`, { percent: 90 });
      expect(message).toContain("نتائج مستمدة من المحاكاة، وليست احتمالات واقعية");
      expect(message).not.toContain("نتائج نموذجية");
      expect(message).toContain("90%");
    },
  );

  it.each([
    "performance:annualized_return",
    "performance:metric.annualized_return",
    "ai:performance.annualizedReturn",
    "account:metric.annualized_irr",
  ])("keeps annualized metrics explicit in %s", (key) => {
    expect(i18n.t(key)).toContain("على أساس سنوي");
  });

  it("keeps calendar-year returns distinct from annualized returns", () => {
    expect(i18n.t("performance:yearly_returns")).toBe("العوائد السنوية");
  });
});
