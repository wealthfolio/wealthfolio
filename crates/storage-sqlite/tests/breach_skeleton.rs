//! Tenant-isolation breach test harness — SKELETON (Phase 0).
//!
//! This is the single most important safety net for the multitenant fork. Per
//! `WEALTHFOLIO_FORK_PLAN.md` §7.5 and §2.6, every tenant-scoped table must have a
//! breach case proving tenant A cannot read tenant B's rows. The harness compiles
//! today (Phase 0) and is populated table-by-table starting in Phase 2 once the
//! tenant model + RLS substrate exists.
//!
//! Contract (implemented in Phase 2, per table):
//!   1. fresh DB, migrations applied
//!   2. insert a row owned by tenant A and a row owned by tenant B
//!   3. set the request tenant context to tenant A
//!   4. call every read path for the table
//!   5. assert zero rows from tenant B are ever returned
//!   6. (guard) attempt a raw-SQL bypass; assert it also returns no cross-tenant rows
//!
//! A table is not "ported" (Phase 3) until its breach case exists and passes here.
//! See the `add-tenant-table` skill for the per-table checklist.
//!
//! Phase 0 status: skeleton only. The `tenant_id` column, RLS policies, and the
//! `app.tenant_id` session variable do not exist yet — they land in Phase 2. This
//! file establishes the harness shape and a trivial green case so CI tracks it.

#[cfg(test)]
mod breach_harness {
    // NOTE: real cases are gated behind the Phase 2 tenant model. They are written
    // as #[ignore] today so the harness compiles and runs green without a tenant
    // schema, and can be un-ignored table-by-table as Phase 2/3 progress.

    /// Placeholder proving the harness is wired into `cargo test`. Replaced by the
    /// first real breach case in Phase 2 (accounts_cannot_leak_across_tenants).
    #[test]
    fn breach_harness_is_wired() {
        // When Phase 2 lands, this module gains:
        //   - async fn test_pool() -> (TempDir, Arc<DbPool>)  // fresh PG, migrations
        //   - async fn insert_tenant(pool, name) -> Uuid
        //   - async fn set_tenant(pool, tenant_id)            // SET LOCAL app.tenant_id
        //   - per-table #[tokio::test] cases following the contract above
        assert!(true, "breach harness skeleton in place");
    }

    /// Template for the per-table breach case. Un-ignore and specialize in Phase 2/3.
    #[cfg(ignore)]
    #[tokio::test]
    async fn TEMPLATE_table_cannot_leak_across_tenants() {
        // let pool = test_pool().await;
        // let tenant_a = insert_tenant(&pool, "A").await;
        // let tenant_b = insert_tenant(&pool, "B").await;
        // insert_<entity>(&pool, tenant_a, "row-A").await;
        // insert_<entity>(&pool, tenant_b, "row-B").await;
        //
        // set_tenant(&pool, tenant_a).await;
        // let rows = list_<entity>(&pool).await;
        // assert_eq!(rows.len(), 1);
        // assert_eq!(rows[0].name, "row-A");  // B's row never appears
        //
        // // Guard: no BYPASSRLS path leaks either
        // let raw = raw_query(&pool, "SELECT * FROM <table>").await;
        // assert!(raw.iter().all(|r| r.tenant_id == tenant_a));
        unimplemented!("populated in Phase 2/3 per the add-tenant-table skill")
    }
}
