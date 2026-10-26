# Spending MCP access

This implements the access plan on top of merged #2251. Spending accounting
remains owned by the native services. Transfer returns, net savings and savings
budget targets are separate core decisions; this change does not resolve #2257
or #1288.

## Permissions and compatibility

| Scope            | Label             | Allows                                                                                                           |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `spending:read`  | View spending     | Opted-in cash transactions, effective allocations, configuration, reports, insights, events and budget snapshots |
| `spending:write` | Organize spending | Categories, assignments, splits, rules, presets, event definitions and tags                                      |
| `budget:write`   | Manage budgets    | Default/monthly targets, buffers, groups, category-group mappings, copying, rollovers and group reset            |

Both write scopes depend on `spending:read`; they are independent of each other.
`classification:*` continues to mean asset classification. General activity
reads and financial edits retain Activities permissions. Spending-only tokens
cannot search investment activities or edit financial amounts. Enabling the
module and enrolling accounts remain native setup actions.

Persisted tokens retain their exact grant arrays and credentials. Existing
integrations need explicit Spending grants; the settings UI can edit permissions
without replacing a credential. Authentication checks grants on every request,
including an existing MCP session. Clients caching tool lists may need to
refresh or reconnect. Expired credentials remain expired.

New all-domain read-only tokens visibly include Spending reads. Spending view,
organization and budget presets are separate. No preset silently adds either
Spending write to an existing token.

## Tools and workflows

All discovery/preparation tools below require `spending:read`. Their commits
require `spending:write` as well, except budget commits, which require
`budget:write` instead.

- Context and transactions: `get_spending_context`,
  `search_spending_transactions`. Effective account enrollment, availability,
  exclusions, timezone and currency are explicit. Search is bounded/paginated,
  uses native transaction units, and returns canonical effective allocations,
  raw split lines and a hidden-single-assignment diagnostic.
- Calculations: `get_spending_report`, `get_spending_insight`, `get_budget`,
  `get_event_spending_summaries`. They call the composed native services
  directly. There is no MCP calculator or HTTP loopback.
- Categories: `list_transaction_categories`, `prepare_transaction_category`,
  `commit_transaction_category`, `prepare_transaction_category_change`,
  `commit_transaction_category_change`. Only the three built-in activity
  taxonomies are reachable. Changes preserve identity and validate keys,
  same-taxonomy parents, cycles and deletion references.
- Categorization: existing context/proposal/assignment tools now use Spending
  grants. Compatible rule/history/AI suggestions stay within each transaction's
  native cashflow taxonomy. Manual commits retain all-or-nothing semantics.
- Rules: `list_categorization_rules`, existing reviewed rule creation,
  `prepare_categorization_rule_change`, `commit_categorization_rule_change`,
  `preview_categorization_rules`, `rerun_categorization_rules`.
- Presets: `list_categorization_presets`, `prepare_categorization_preset`,
  `commit_categorization_preset`. Import upgrades native unmodified rules and
  preserves edits/deletion tracking; removal retains edited rules. Saving or
  importing a rule never implicitly reruns history.
- Allocations: `prepare_spending_splits`, `commit_spending_splits`,
  `prepare_spending_allocation_clear`, `commit_spending_allocation_clear`.
  Proposals show replaced state, exact decimal lines, total/remaining and
  receipt interpretation notes. They reuse native validation. No OCR/upload
  subsystem.
- Events: `list_spending_events`, `prepare_spending_event`,
  `commit_spending_event`, `prepare_spending_event_tag`,
  `commit_spending_event_tag`. Discovery includes event types. Tags can refer to
  purchases outside event dates as native behavior allows. Reviewed deletion
  discloses affected tag count.
- Budgets: `prepare_budget_change`, `commit_budget_change` support one explicit
  native operation at a time: set/remove target or buffer, copy targets with
  overwrite choice, create/edit/reorder/delete groups with reassignment,
  category-group assignment, set/remove rollover, and reset group defaults.
  Snapshot configuration is checked again in the existing writer transaction.
- Import metadata: `prepare_spending_import_metadata` resolves
  taxonomy-qualified category/subcategory keys and event names/IDs against saved
  financial rows. Unknown/ambiguous inputs require review; no implicit
  category/event creation. Use the returned eligible assignment batch and
  separate reviewed event changes with their existing commits. A row with an
  unresolved mapping is not silently half-applied. Financial import returns
  actual saved IDs by original source index, including deduplicated existing
  rows. Retry metadata against those IDs; never reimport successful financial
  rows to retry categorization.

General `search_activities` also exposes `query` for existing notes/ticker/name
matching, retaining `symbol` as a compatibility alias. Use one argument.

## Split safety and financial edits

The shared native/SQLite category writer protects split rows. Ordinary manual
batches containing a protected split row fail atomically; previews identify
protected rows so a caller can explicitly submit the eligible subset. Replacing
splits with one category requires explicit replacement intent and the exact
current split snapshot. Clearing and assignment insertion use one existing
transaction/outbox path. Automatic rule reruns preserve manual assignments and
splits inside that transaction, skip unchanged allocations, and report matched,
eligible, changed, protected, existing, incompatible and no-target counts. Rerun
preview is advisory; execution re-evaluates current state.

Legacy rows containing both splits and a single assignment retain native
splits-win behavior. No repair migration rewrites historical data. Category
reference checks include split references; only untouched automatic budget-group
links are removable during a valid category deletion. User-edited seeded links,
children, rules, assignments, targets, rollovers and other configuration remain
blockers. Default-group reset does not recreate a deleted category.

The financial writer's split invalidation policy remains unchanged. Native
financial edit forms/grid and MCP updates now preview removed-split counts and
whether existing category assignments are retained and may apply after removal.
This stays accurate when a type/account change also changes the effective
cashflow taxonomy; core does not duplicate Spending's economic classifier. A
transient fingerprint binds the current transaction/allocation state. Both
single and bulk writers recompute the actual removal effects and reject stale
state or unreviewed effects atomically. Derived amounts are not fingerprints:
native asset resolution keeps ownership of multipliers and trade totals. The
fingerprint discloses no category names or amounts, so this review needs no
extra Spending grant. Native confirmation is shared through a profile-scoped,
in-memory dialog; cancellation/profile unmount performs no mutation. Each save
uses one batched review request. Records without splits capture current state
without resolving replacement symbols or deriving trade amounts. A split cash
row changing account/type with a new symbol also previews the writer's existing
removal rule without resolving that symbol. Independent non-destructive previews
may overlap. A second destructive confirmation cannot overwrite the open dialog;
no review queue or automatic retry is introduced.

Non-interactive broker/import/sync callers omit this review field and retain
their existing atomic invalidation behavior. There is no confirmation gate,
version table, migration, new lock, worker, retry queue or persisted draft.

## Calculation semantics

Default budget targets apply to **every** month without an explicit monthly
override, including past months. Editing defaults can change historical rollover
results. Removing a monthly override restores the current default, or zero when
none exists. Both changes use the same budget permission.

Agent/addon budget snapshots are pure reads. Missing system groups are resolved
in memory using stable native IDs/default definitions. Insight shares that
resolver; this deliberately fixes missing-system-group grouping while keeping
unaffected financial totals unchanged. Native `get_budget` still seeds defaults
at its existing point in the lifecycle.

Reports use snapshot-date FX at each report window end; transaction lists keep
native units unless the native surface explicitly converts them. Native totals
still omit unavailable conversions rather than mixing units. Additive
`calculationQuality` reports `missingFxTransactions` and sorted
`missingFxCurrencies`, counted from the existing conversion attempts. Insight
includes separate current/prior coverage. Budget coverage includes historical
months needed for rollover. Zero missing FX is not a claim about source-data
completeness or accounting correctness. No additional FX/provider request is
introduced to collect these counts.

## Addons

MCP scopes and addon grants are distinct. Exact per-function guards remain in
force; previously installed grants do not expand.

| Addon functions                                         | Permission category |
| ------------------------------------------------------- | ------------------- |
| `getContext`, `getBudget`, `getEvents`, `getEventTypes` | medium `spending`   |
| `assignCategory`, `unassignCategory`, `setEvent`        | high `activities`   |
| `upsertBudgetTarget`                                    | high `budgets`      |

The bridge and iframe allowlist call existing native adapters. Category writes
keep native manual provenance and split protections. Budget target writes use
explicit period keys. Both runtimes expose the pure budget snapshot/context
commands; existing native calls retain their behavior.

## Architecture impact

Changes are in the owning Spending/core services and existing SQLite writer,
transactions, outbox, events, per-request PAT authorization and tool catalog.
Both Tauri and Axum compose the same services; frontend commands are wired
through shared adapters and each runtime registration/map/route.

Observable changes: explicit category-versus-split protection; eligible-only
rule reruns and accurate counts; safe category deletion; native category
create/update/move parent-cycle validation and collision prevention for new or
changed keys (unchanged legacy duplicates permit cosmetic edits);
missing-default Insight group resolution; reviewed financial-edit consequences;
additive pure APIs and calculation coverage. Financial import now returns
persisted row identities without changing UUID generation, deduplication or sync
identity. Saved assistant category/rule cards unwrap persisted result envelopes
and retain applied state.

Provider settings, network resolution policy, synchronous/background ownership,
SQLite/local-first storage, secrets, financial accounting and non-interactive
financial invalidation stay unchanged. Mutation errors propagate; no automatic
retry is added. Audit summaries omit drafts, notes, patterns, receipts, names
and amounts for the new Spending workflows. MCP authorization permits a
mutation; it cannot prove a human reviewed a preview. Clients must present the
review. Strict date formats apply to new reviewed MCP event proposals. Native
event range validation retains its existing parsed-bound comparison, with a
sortable-string fallback when either bound cannot be parsed. Existing native
event-update parsing behavior is unchanged. Date validation errors do not echo
the input.

## Related reports and limits

| Reports               | Coverage                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2288 / #1259         | Shared split protection, compatible proposals, explicit replacement/clear, exact split workflow, protected rule reruns                                                                                     |
| #1987 / #2040 / #2213 | Category discovery/create/edit/delete, atomic validation and reference protection                                                                                                                          |
| #2247                 | Existing credential permission editing, adapted to independent Spending grants                                                                                                                             |
| #1749 / #2269         | Addon effective scope/budgets/events and explicitly granted metadata/target writes                                                                                                                         |
| #2042                 | Discoverable text-query alias                                                                                                                                                                              |
| #2201                 | Applied/reopened category and rule cards; regression fails before the fix                                                                                                                                  |
| #1272 / #1411         | MCP import mapping and recoverable metadata stage; broader native CSV UI requests remain open                                                                                                              |
| #1615                 | Investigated run/message IDs, request-local Tauri channel/web stream and reasoning parser. No reproduction of Ollama gemma4:26b interleaving; **fix not verified**. No speculative provider/stream rewrite |
| #2257 / #1288         | Separate core accounting and savings-target decisions; not fixed or gated by MCP access                                                                                                                    |
| #1692                 | Future recurring-commitment model; separate domain extension                                                                                                                                               |

## Validation status

Completed implementation validation (including focused checks after review
fixes):

- Rust unit suites: core 2,010; Spending 183; SQLite 476; agent tools 148.
- SQLite category-reference/restart tests 7; two-device sync replay tests 15.
- Server MCP/auth/native-service integration tests 35; desktop MCP/router tests
  12; MCP crate tests 15.
- AI output parity 51 plus schema snapshots 20; the existing live Ollama test
  remains ignored because it requires Ollama and `WF_TEST_OLLAMA_MODEL`.
- Frontend 499 tests across 58 affected feature/adapter/addon suites with four
  workers; `pnpm check`; all 11 locales/20 namespaces; web and Tauri frontend
  builds. An unchanged MCP setup-card test failed in the initial unconstrained
  parallel run, then passed isolated and in the complete bounded-worker rerun.
- Permission-edit browser tests in desktop LTR/mobile RTL, and financial-edit
  split-review/cancel/apply browser tests in desktop LTR/mobile RTL. Synthetic
  data and separate test ports/profile; the user's running app was untouched.
- Addon sandbox: 10 Chromium/WebKit tests passed. Five Firefox cases could not
  launch the bundled browser: macOS sandbox extension errors, SWGL framebuffer
  failure and launch timeout. Firefox remains unverified in this environment; no
  browser security setting or project configuration was changed to bypass it.
- `cargo fmt --all -- --check`; Clippy for all affected crates and both runtime
  packages with all targets/features and warnings denied; ordinary `cargo check`
  for `wealthfolio-app` and `wealthfolio-server`; final whitespace/diff review.

Regression evidence includes fail-before/pass-after split protection, category
reference deletion, persisted assistant-card tests, and the reviewed asset-swap
failure found by Claude. The asset regression passes through MCP, native single
and native bulk updates. Review follow-up reran core/tool unit suites and all 53
activity repository tests; native no-split symbol previews stay off providers.
Batch/concurrent non-destructive review behavior and both runtime command maps
are covered. Three further fail-before/pass-after regressions verify legacy
category cosmetic edits, split cash-to-new-symbol trade saves, and native legacy
event creation with strict, redacted MCP proposal validation. Native bulk
financial errors remain atomic. Review scope does not include mobile SDK builds
or a live Ollama reproduction.

Cross-review completed in three Claude rounds; final verdict: **approve**, with
no blocking findings. Commit `36a9149a3` fixes the asset-multiplier regression
and batch/concurrent review concerns. Commit `eb7b4d37f` fixes the three
verified compatibility findings (legacy category keys, split-to-new-symbol
trades and native legacy event creation) with fail-before/pass-after tests. The
final review's claim that parsed-time comparison differs from baseline was
rejected: `d26177173` and `origin/main` already use that same parsed comparison
and fallback. Documentation now spells it out, and a direct service test
protects date-error redaction. No open review disagreements require a product
decision.

Do not treat the report-coverage table as a claim that every original issue is
fully reproduced or closed. No production data migration or issue auto-closure
is part of this change.

## Frontend CI follow-up

The first CI run exposed gaps in the original focused validation: an extracted
scope selector retained a status tint rejected by the per-file design ratchet,
Traditional Chinese lacked the English catalog's singular split-review key, and
the desktop account/FX form fixture omitted the required split-review provider.
Both translation-contract tests and all 13 FX cases were reproduced failing
locally before the correction.

The selector now uses the theme's success surface/foreground/border tokens. The
Traditional Chinese catalog includes both plural keys. The FX fixture mounts the
real provider around the component that owns the mutation hook and mocks only
its native review read; it also checks that review runs before the financial
save. The production provider requirement and financial behavior are unchanged.

Validation after correction: both complete frontend shards pass (2,037 and 2,216
tests; 470 files total), the 118-test focused regression set passes, and the
design ratchet, `pnpm check`, all-locale translation checks and both frontend
builds pass. The original CI revision also passed Rust, iOS/Android compilation,
Docker and frontend browser checks; the correction changes no Rust code.

## Verified review corrections

Reviewed budget-group patches preserve omitted fields through prepare/commit;
explicit null still clears color or icon. Native category creation chooses an
unused key within its taxonomy, so names such as Food and repeated Misc
subcategories remain available without weakening the writer's uniqueness check.
Shared split reads (native, addon and MCP) and MCP effective allocation amounts
serialize as exact decimal strings, allowing callers to reuse the returned split
snapshot without floating-point rounding or looser conflict checks. Existing
numeric inputs remain accepted; frontend/addon contracts already allow strings.

Cancellation in the main desktop and mobile activity forms leaves the form open
without an error toast or error state. Converting a linked transfer to external
uses the transient `ActivityUpdate.unlinkTransferPairId` (the counterpart ID).
Both legs are reviewed before any mutation. Core expands the edit into the
existing bulk writer; SQLite validates the pair and both review proofs, writes
the edit, clears only the financially invalidated allocations, unlinks both legs
and queues their final states in one existing transaction. Failure rolls back
every write and outbox append. The untouched leg retains its amounts, date,
notes, status, review flag and allocations. Standalone unlink and
non-interactive callers keep their existing behavior.

Stored splits from an earlier cashflow taxonomy stay visible in transaction
rows. The split sheet explains these allocations and offers explicit clearing or
reviewed replacement with a category in the current taxonomy. No background
cleanup changes financial classification or historical allocations. The two
unused assignment service helpers were removed, and addon `getContext()` docs
match its actual enabled/account/exclusion response.

**Architecture impact:** the external-transfer editor replaces two independent
writes with one existing atomic bulk transaction and emits the existing domain
event only after success. Final-state sync projections reuse the existing raw
activity/user-overlay policy. No new endpoint, persisted field, migration,
queue, worker, retry or lock is introduced. Provider/network settings, account
enrollment, permissions, core accounting and secret handling are unchanged.
Regression tests cover cancellation before writes, stale counterpart rollback,
final outbox payloads, counterpart preservation, exact decimal replacement,
patch omission/null behavior, duplicate display names and old-taxonomy repair.
Cross-device replay of this specific combined edit is not separately simulated.

Correction validation: both full frontend shards pass (4,261 tests, 471 files).
38 server integration tests, 184 Spending unit tests, 71 AI parity/schema
checks, both MCP host/transport suites, `pnpm check`, translation parity, the
design ratchet, both frontend builds, affected-crate Clippy with all
targets/features and warnings denied, and both Rust runtime compilation checks
pass. The six real browser regressions pass in desktop LTR and mobile RTL,
covering both financial editors and old-taxonomy split repair.

The follow-up Claude review approved the correction batch and identified one
minor neutral-row display issue. A new regression reproduced retained lines from
the previously opened transaction. The sheet now resets that state and hides
category-edit controls when the current transaction has no taxonomy; the notice
describes the inactive allocations without suggesting unsupported actions. The
existing kept-screen editing regression remains covered.

### Transfer provenance and addon boundary corrections

Externalization now sends only the edited leg through financial preparation and
projection. The counterpart is reviewed against its unchanged database state,
then written only by the existing unlink helper inside the same transaction. Its
raw type, effective override, lifecycle, financial fields and allocations remain
intact. A stale counterpart proof rejects the entire edit before writes; missing
proofs, duplicate edited legs, simultaneous counterpart edits and paired deletes
are rejected. Both native single and bulk callers receive both final rows. An
unchanged broker counterpart produces no user-patch outbox entry.

Ordinary linked edits also preserve source classification: the mirrored update
uses the effective type, and the shared writer preserves both raw type and
override when that effective type is unchanged. Explicit broker reclassification
and reset still follow the existing source-aware policy. This also preserves
legacy manual overrides without normalizing their raw type or deleting splits.

Addon `activities.update` and both `saveMany` signatures project update payloads
onto the public SDK fields, preserving the legacy `notes` alias. Native review
and unlink controls and unknown batch controls are not forwarded. Explicit
`activities.unlinkTransfer` retains its separate function grant. The addon API
reference and SDK release notes document exact decimal split strings and the
change from 3.11.0 numeric output.

**Architecture impact:** these corrections reuse the existing SQLite writer
transaction, review fingerprint, unlink helper, events and outbox policy. They
introduce no migration, persisted state, queue, worker, retry, synchronization
primitive or network dependency. Provider settings, user-edit precedence and
core accounting rules remain unchanged. The classification preservation applies
to shared financial writes; the addon projection applies at the host boundary.

Regression coverage includes 96 native HTTP combinations of edited/counterpart
manual or broker provenance, both transfer directions, three split-presence
states, unlink or ordinary edits, and single or bulk saves. Assertions compare
all counterpart database fields, allocations, stale-review rollback and broker
patch absence. Additional negative tests cover malformed paired requests; addon
tests cover each grant and payload signature, public-field compatibility,
unknown controls and input immutability. These tests reproduced the reported
loss and scope bypass before the fixes. Cross-device replay of the combined edit
remains covered only indirectly by the existing writer/outbox tests.

The cross-review also identified the Spending row's reimbursement action as a
financial edit that skipped review. It now uses the same transient split-review
provider as the forms and grid, forwards the reviewed proof, and treats cancel
as a neutral result. Tests reproduce the bypass before the fix and cover
approval, cancellation without a write or toast, and review failure without a
write. This adds no endpoint, state persistence or change to accounting rules.
