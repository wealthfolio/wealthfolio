import { describe, expect, it } from "vitest";
import {
  applyNavigation,
  coldStart,
  describeTransition,
  getBackTarget,
  stepsBackToTabRoot,
  topScreen,
  type NavigationAction,
  type StackConfig,
  type StackIntent,
  type StackState,
} from "./stack-model";

const config: StackConfig = {
  tabs: [
    { id: "holdings", rootPath: "/holdings" },
    { id: "settings", rootPath: "/settings" },
  ],
  topLevelPaths: ["/", "/dashboard", "/insights", "/holdings", "/activities", "/settings"],
};

let keyCounter = 0;
function at(path: string, state: unknown = null) {
  const [pathname, search = ""] = path.split("?");
  keyCounter += 1;
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash: "",
    state,
    key: `k${keyCounter}`,
  };
}

function go(
  state: StackState,
  action: NavigationAction,
  location: ReturnType<typeof at>,
  intent?: StackIntent,
  index?: number,
) {
  return applyNavigation(state, { action, location, intent, index }, config);
}

/** Browser back: history returns to the entry one before the current one. */
function historyBack(state: StackState) {
  const [key] = Object.entries(state.entries).find(([, e]) => e.index === state.index - 1) ?? [];
  if (!key) throw new Error("no previous entry");
  const screen = Object.values(state.stacks)
    .flat()
    .find((s) => s.id === state.entries[key].screenId);
  const location = screen?.location ?? at("/dashboard");
  return go(state, "POP", { ...location, key });
}

const paths = (state: StackState, tab = "holdings") =>
  (state.stacks[tab] ?? []).map((s) => s.location.pathname + s.location.search);

describe("cold start", () => {
  it("opens a tab on its root screen", () => {
    const state = coldStart(config, at("/holdings"));
    expect(state.activeTab).toBe("holdings");
    expect(paths(state)).toEqual(["/holdings"]);
    expect(getBackTarget(state)).toBeNull();
  });

  it("puts the tab's root under a deeper screen opened directly", () => {
    const state = coldStart(config, at("/holdings/AMD"));
    expect(paths(state)).toEqual(["/holdings", "/holdings/AMD"]);
    // Nothing in history leads back to the root, so back replaces the entry.
    expect(getBackTarget(state)).toMatchObject({
      screen: { location: { pathname: "/holdings" } },
      viaHistory: false,
    });
  });

  it("opens each parent page under a nested page opened directly", () => {
    const state = coldStart(config, at("/settings/spending/rules?view=all"));
    expect(paths(state, "settings")).toEqual([
      "/settings",
      "/settings/spending",
      "/settings/spending/rules?view=all",
    ]);
    expect(getBackTarget(state)).toMatchObject({
      screen: { location: { pathname: "/settings/spending" } },
    });
  });

  it("leaves pages outside the stacks alone", () => {
    const state = coldStart(config, at("/dashboard"));
    expect(state.activeTab).toBeNull();
    expect(topScreen(state)).toBeNull();
  });
});

describe("push and pop within a tab", () => {
  const start = () => coldStart(config, at("/holdings"));

  it("pushes a detail screen and keeps the list under it", () => {
    const before = start();
    const after = go(before, "PUSH", at("/holdings/AMD", { holding: "AMD" }));
    expect(paths(after)).toEqual(["/holdings", "/holdings/AMD"]);
    expect(after.stacks.holdings[0].id).toBe(before.stacks.holdings[0].id);
    expect(topScreen(after)?.location.state).toEqual({ holding: "AMD" });
    expect(describeTransition(before, after)).toMatchObject({ kind: "push" });
    expect(getBackTarget(after)).toMatchObject({ viaHistory: true });
  });

  it("pops back to the same list screen on history back", () => {
    const list = start();
    const detail = go(list, "PUSH", at("/holdings/AMD"));
    const back = historyBack(detail);
    expect(paths(back)).toEqual(["/holdings"]);
    expect(back.stacks.holdings[0].id).toBe(list.stacks.holdings[0].id);
    expect(describeTransition(detail, back)).toMatchObject({
      kind: "pop",
      exiting: [{ location: { pathname: "/holdings/AMD" } }],
    });
  });

  it("keeps the screen when the page replaces its own URL", () => {
    const detail = go(start(), "PUSH", at("/holdings/AMD"));
    const replaced = go(detail, "REPLACE", at("/holdings/AMD?tab=history"));
    expect(topScreen(replaced)?.id).toBe(topScreen(detail)?.id);
    expect(paths(replaced)).toEqual(["/holdings", "/holdings/AMD?tab=history"]);
    expect(describeTransition(detail, replaced)).toBeNull();
    expect(getBackTarget(replaced)).toMatchObject({ viaHistory: true });
  });

  it("stacks pages opened from a screen even outside the tab's paths", () => {
    const detail = go(start(), "PUSH", at("/holdings/AMD"));
    const imported = go(detail, "PUSH", at("/import"));
    expect(paths(imported)).toEqual(["/holdings", "/holdings/AMD", "/import"]);
  });

  it("returns to the first screen when the tab's root path is opened", () => {
    const list = start();
    const deep = go(go(list, "PUSH", at("/holdings/AMD")), "PUSH", at("/import"));
    const root = go(deep, "PUSH", at("/holdings"));
    expect(paths(root)).toEqual(["/holdings"]);
    expect(root.stacks.holdings[0].id).toBe(list.stacks.holdings[0].id);
    expect(describeTransition(deep, root)).toMatchObject({ kind: "pop" });
  });

  it("drops forward entries when pushing after going back", () => {
    const detail = go(start(), "PUSH", at("/holdings/AMD"));
    const back = historyBack(detail);
    const other = go(back, "PUSH", at("/holdings/META"));
    expect(paths(other)).toEqual(["/holdings", "/holdings/META"]);
    expect(Object.values(other.entries).filter((e) => e.index === 1)).toHaveLength(1);
  });

  it("opens a popped screen again when history goes forward to it", () => {
    const detail = go(start(), "PUSH", at("/holdings/AMD"));
    const detailKey = detail.currentKey;
    const back = historyBack(detail);
    const forward = go(back, "POP", { ...at("/holdings/AMD"), key: detailKey });
    expect(paths(forward)).toEqual(["/holdings", "/holdings/AMD"]);
    expect(forward.index).toBe(1);
    expect(getBackTarget(forward)).toMatchObject({ viaHistory: true });
  });
});

describe("leaving and returning to a tab", () => {
  const onDetail = () => go(coldStart(config, at("/holdings")), "PUSH", at("/holdings/AMD"));

  it("keeps the tab's stack while a top-level page is shown", () => {
    const away = go(onDetail(), "PUSH", at("/dashboard"));
    expect(away.activeTab).toBeNull();
    expect(paths(away)).toEqual(["/holdings", "/holdings/AMD"]);
    expect(describeTransition(onDetail(), away)).toBeNull();
  });

  it("shows the tab as it was left when switching back to it", () => {
    const detail = onDetail();
    const away = go(detail, "PUSH", at("/dashboard"));
    const backInTab = go(away, "PUSH", at("/holdings/AMD"), { type: "openTab", tab: "holdings" });
    expect(backInTab.activeTab).toBe("holdings");
    expect(topScreen(backInTab)?.id).toBe(topScreen(detail)?.id);
    // The list is not the previous history entry any more (the dashboard is),
    // so back must replace the entry instead of going back in history.
    expect(getBackTarget(backInTab)).toMatchObject({
      screen: { location: { pathname: "/holdings" } },
      viaHistory: false,
    });
  });

  it("pops to the target screen when back replaces the entry", () => {
    const away = go(onDetail(), "PUSH", at("/dashboard"));
    const backInTab = go(away, "PUSH", at("/holdings/AMD"), { type: "openTab", tab: "holdings" });
    const target = getBackTarget(backInTab);
    if (!target) throw new Error("expected a back target");
    const popped = go(backInTab, "REPLACE", at("/holdings"), {
      type: "popTo",
      screenId: target.screen.id,
    });
    expect(paths(popped)).toEqual(["/holdings"]);
    expect(topScreen(popped)?.id).toBe(target.screen.id);
    expect(describeTransition(backInTab, popped)).toMatchObject({ kind: "pop" });
  });

  it("returns to the tab's screen when history goes back to it", () => {
    const detail = onDetail();
    const away = go(detail, "PUSH", at("/dashboard"));
    const back = historyBack(away);
    expect(back.activeTab).toBe("holdings");
    expect(topScreen(back)?.id).toBe(topScreen(detail)?.id);
  });

  it("does not stack a tab's detail opened from outside the tab", () => {
    const state = go(coldStart(config, at("/dashboard")), "PUSH", at("/holdings/AMD"));
    expect(state.activeTab).toBeNull();
  });

  it("starts over on an entry it has never seen", () => {
    const state = go(onDetail(), "POP", at("/holdings/META"));
    expect(paths(state)).toEqual(["/holdings", "/holdings/META"]);
    expect(state.index).toBe(0);
  });

  it("closes the screen it goes back from when history leaves the tab", () => {
    const away = go(onDetail(), "PUSH", at("/dashboard"));
    const backInTab = go(away, "PUSH", at("/holdings/AMD"), { type: "openTab", tab: "holdings" });
    const back = historyBack(backInTab);
    expect(back.activeTab).toBeNull();
    expect(paths(back)).toEqual(["/holdings"]);
  });

  it("never closes a tab's first screen", () => {
    const list = go(coldStart(config, at("/dashboard")), "PUSH", at("/holdings"));
    const back = historyBack(list);
    expect(back.activeTab).toBeNull();
    expect(back.stacks.holdings.map((s) => s.id)).toEqual(list.stacks.holdings.map((s) => s.id));
  });

  it("drops a screen that redirects to a page outside the tab", () => {
    const performance = go(onDetail(), "PUSH", at("/performance"));
    expect(paths(performance)).toEqual(["/holdings", "/holdings/AMD", "/performance"]);
    const redirected = go(performance, "REPLACE", at("/insights?tab=performance"));
    expect(redirected.activeTab).toBeNull();
    expect(paths(redirected)).toEqual(["/holdings", "/holdings/AMD"]);
    const reopened = go(redirected, "PUSH", at("/holdings/AMD"), {
      type: "openTab",
      tab: "holdings",
    });
    expect(topScreen(reopened)?.location.pathname).toBe("/holdings/AMD");
  });
});

describe("two stacked tabs", () => {
  const holdingsDetail = () => go(coldStart(config, at("/holdings")), "PUSH", at("/holdings/AMD"));

  it("keeps each tab's stack when switching between them", () => {
    const amd = holdingsDetail();
    const settingsRoot = go(amd, "PUSH", at("/settings"));
    expect(settingsRoot.activeTab).toBe("settings");
    const general = go(settingsRoot, "PUSH", at("/settings/general"));
    expect(paths(general, "settings")).toEqual(["/settings", "/settings/general"]);

    const backToHoldings = go(general, "PUSH", at("/holdings/AMD"), {
      type: "openTab",
      tab: "holdings",
    });
    expect(backToHoldings.activeTab).toBe("holdings");
    expect(topScreen(backToHoldings)?.id).toBe(topScreen(amd)?.id);

    const backToSettings = go(backToHoldings, "PUSH", at("/settings/general"), {
      type: "openTab",
      tab: "settings",
    });
    expect(backToSettings.activeTab).toBe("settings");
    expect(topScreen(backToSettings)?.id).toBe(topScreen(general)?.id);
    expect(describeTransition(backToHoldings, backToSettings)).toBeNull();
  });

  it("stacks a settings page opened from a Holdings screen on Holdings", () => {
    const accounts = go(holdingsDetail(), "PUSH", at("/settings/accounts"));
    expect(accounts.activeTab).toBe("holdings");
    expect(paths(accounts)).toEqual(["/holdings", "/holdings/AMD", "/settings/accounts"]);
    expect(accounts.stacks.settings).toBeUndefined();
  });

  it("goes back within Settings from a nested page", () => {
    const root = coldStart(config, at("/settings"));
    const spending = go(root, "PUSH", at("/settings/spending"));
    const rules = go(spending, "PUSH", at("/settings/spending/rules"));
    const back = historyBack(rules);
    expect(paths(back, "settings")).toEqual(["/settings", "/settings/spending"]);
    expect(topScreen(back)?.id).toBe(topScreen(spending)?.id);
  });

  it("opens a closed screen again under the pages above it in its path", () => {
    const root = coldStart(config, at("/settings"));
    const spending = go(root, "PUSH", at("/settings/spending"), undefined, 1);
    const rulesAt = at("/settings/spending/rules");
    const rules = go(spending, "PUSH", rulesAt, undefined, 2);
    // Back to the tab's first screen by a new entry, then history back to Rules.
    const reselected = go(rules, "PUSH", at("/settings"), undefined, 3);
    expect(paths(reselected, "settings")).toEqual(["/settings"]);
    const back = go(reselected, "POP", rulesAt, undefined, 2);
    expect(paths(back, "settings")).toEqual([
      "/settings",
      "/settings/spending",
      "/settings/spending/rules",
    ]);
    expect(getBackTarget(back)?.screen.location.pathname).toBe("/settings/spending");
  });

  it("counts the history steps back to the tab's first screen", () => {
    const root = coldStart(config, at("/settings"));
    const spending = go(root, "PUSH", at("/settings/spending"), undefined, 1);
    const rules = go(spending, "PUSH", at("/settings/spending/rules"), undefined, 2);
    expect(stepsBackToTabRoot(rules, "settings")).toBe(2);
    expect(stepsBackToTabRoot(root, "settings")).toBeNull();
  });

  it("does not count back through another tab's entries", () => {
    const root = coldStart(config, at("/settings"));
    const spending = go(root, "PUSH", at("/settings/spending"), undefined, 1);
    const holdings = go(spending, "PUSH", at("/holdings"), undefined, 2);
    const back = go(
      holdings,
      "PUSH",
      at("/settings/spending"),
      { type: "openTab", tab: "settings" },
      3,
    );
    expect(paths(back, "settings")).toEqual(["/settings", "/settings/spending"]);
    expect(stepsBackToTabRoot(back, "settings")).toBeNull();
  });

  it("returns to the page underneath when a page redirects up to it", () => {
    const root = coldStart(config, at("/settings"));
    const spending = go(root, "PUSH", at("/settings/spending"));
    const setup = go(spending, "PUSH", at("/settings/spending/setup"));
    const redirected = go(setup, "REPLACE", at("/settings/spending"));
    expect(paths(redirected, "settings")).toEqual(["/settings", "/settings/spending"]);
    expect(topScreen(redirected)?.id).toBe(topScreen(spending)?.id);
  });

  it("returns to the parent page when a link straight to a page redirects up to it", () => {
    const setup = coldStart(config, at("/settings/spending/setup"));
    const redirected = go(setup, "REPLACE", at("/settings/spending"), undefined, 0);
    expect(paths(redirected, "settings")).toEqual(["/settings", "/settings/spending"]);
    expect(getBackTarget(redirected)?.screen.location.pathname).toBe("/settings");
  });
});

describe("history positions from the browser", () => {
  it("follows history when two navigations landed in one render", () => {
    const list = coldStart(config, at("/holdings"));
    // Two taps pushed entries 1 and 2; only the second was rendered.
    const detail = go(list, "PUSH", at("/holdings/AMD"), undefined, 2);
    expect(paths(detail)).toEqual(["/holdings", "/holdings/AMD"]);
    // Entry 1 was never seen, so back goes through history and the stack follows.
    expect(getBackTarget(detail)).toMatchObject({ viaHistory: true });
    const missed = go(detail, "POP", at("/holdings/AMD"), undefined, 1);
    expect(paths(missed)).toEqual(["/holdings", "/holdings/AMD"]);
    expect(missed.stacks.holdings[0].id).toBe(list.stacks.holdings[0].id);
    expect(getBackTarget(missed)).toMatchObject({ viaHistory: true });
    const back = historyBack(missed);
    expect(paths(back)).toEqual(["/holdings"]);
    expect(back.stacks.holdings[0].id).toBe(list.stacks.holdings[0].id);
  });

  it("goes back through history after a reload deep in the tab", () => {
    const reloaded = coldStart(config, at("/holdings/AMD"), undefined, 5);
    expect(getBackTarget(reloaded)).toMatchObject({ viaHistory: true });
    const back = go(reloaded, "POP", at("/holdings"), undefined, 4);
    expect(paths(back)).toEqual(["/holdings"]);
    expect(back.stacks.holdings[0].id).toBe(reloaded.stacks.holdings[0].id);
    expect(describeTransition(reloaded, back)).toMatchObject({ kind: "pop" });
    expect(back.index).toBe(4);
  });

  it("closes the reloaded screen when history goes back to another page", () => {
    const reloaded = coldStart(config, at("/holdings/AMD"), undefined, 5);
    const back = go(reloaded, "POP", at("/dashboard"), undefined, 4);
    expect(back.activeTab).toBeNull();
    expect(paths(back)).toEqual(["/holdings"]);
  });

  it("replaces the entry when the tab was opened on the app's first entry", () => {
    const first = coldStart(config, at("/holdings/AMD"), undefined, 0);
    expect(getBackTarget(first)).toMatchObject({ viaHistory: false });
  });
});

describe("every destination as a tab", () => {
  const appConfig: StackConfig = {
    tabs: [
      { id: "dashboard", rootPath: "/dashboard", aliases: ["/"] },
      { id: "holdings", rootPath: "/holdings" },
      { id: "settings", rootPath: "/settings" },
    ],
    topLevelPaths: ["/", "/dashboard", "/holdings", "/settings", "/addons/budget"],
    homeTab: "dashboard",
  };
  const appGo = (state: StackState, location: ReturnType<typeof at>, intent?: StackIntent) =>
    applyNavigation(state, { action: "PUSH", location, intent }, appConfig);

  it("opens a page outside every tab on top of the home tab", () => {
    const account = coldStart(appConfig, at("/accounts/123"));
    expect(account.activeTab).toBe("dashboard");
    expect(paths(account, "dashboard")).toEqual(["/dashboard", "/accounts/123"]);
    expect(getBackTarget(account)?.screen.location.pathname).toBe("/dashboard");
  });

  it("shows the home tab's first screen at its alias", () => {
    const home = coldStart(appConfig, at("/"));
    expect(home.activeTab).toBe("dashboard");
    expect(paths(home, "dashboard")).toEqual(["/"]);
  });

  it("leaves add-on pages outside the tabs", () => {
    expect(coldStart(appConfig, at("/addons/budget")).activeTab).toBeNull();
  });

  it("stacks a page opened from the home tab on it", () => {
    const home = coldStart(appConfig, at("/dashboard"));
    const account = appGo(home, at("/accounts/123"));
    expect(paths(account, "dashboard")).toEqual(["/dashboard", "/accounts/123"]);
  });

  it("orders tabs by when they were last shown", () => {
    const home = coldStart(appConfig, at("/dashboard"));
    const holdings = appGo(home, at("/holdings"));
    const settings = appGo(holdings, at("/settings"));
    const back = appGo(settings, at("/dashboard"), { type: "openTab", tab: "dashboard" });
    expect(back.recentTabs).toEqual(["dashboard", "settings", "holdings"]);
  });

  it("keeps the tab it switched away from when the switch replaces the entry", () => {
    const home = coldStart(appConfig, at("/dashboard"));
    const account = appGo(home, at("/accounts/123"));
    const holdings = applyNavigation(
      account,
      {
        action: "REPLACE",
        location: at("/holdings"),
        intent: { type: "openTab", tab: "holdings" },
      },
      appConfig,
    );
    expect(holdings.activeTab).toBe("holdings");
    expect(paths(holdings, "dashboard")).toEqual(["/dashboard", "/accounts/123"]);
  });
});
