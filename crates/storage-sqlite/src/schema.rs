// @generated automatically by Diesel CLI.

diesel::table! {
    accounts (id) {
        id -> Text,
        name -> Text,
        account_type -> Text,
        group -> Nullable<Text>,
        currency -> Text,
        is_default -> Bool,
        is_active -> Bool,
        created_at -> Timestamp,
        updated_at -> Timestamp,
        platform_id -> Nullable<Text>,
        account_number -> Nullable<Text>,
        meta -> Nullable<Text>,
        provider -> Nullable<Text>,
        provider_account_id -> Nullable<Text>,
        is_archived -> Bool,
        tracking_mode -> Text,
    }
}

diesel::table! {
    activities (id) {
        id -> Text,
        account_id -> Text,
        asset_id -> Nullable<Text>,
        activity_type -> Text,
        activity_type_override -> Nullable<Text>,
        source_type -> Nullable<Text>,
        subtype -> Nullable<Text>,
        status -> Text,
        activity_date -> Text,
        settlement_date -> Nullable<Text>,
        quantity -> Nullable<Text>,
        unit_price -> Nullable<Text>,
        amount -> Nullable<Text>,
        fee -> Nullable<Text>,
        tax -> Nullable<Text>,
        currency -> Text,
        fx_rate -> Nullable<Text>,
        notes -> Nullable<Text>,
        metadata -> Nullable<Text>,
        source_system -> Nullable<Text>,
        source_record_id -> Nullable<Text>,
        source_group_id -> Nullable<Text>,
        idempotency_key -> Nullable<Text>,
        import_run_id -> Nullable<Text>,
        is_user_modified -> Integer,
        needs_review -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    import_account_templates (id) {
        id -> Text,
        account_id -> Text,
        context_kind -> Text,
        source_system -> Text,
        template_id -> Text,
        created_at -> Timestamp,
        updated_at -> Timestamp,
    }
}

diesel::table! {
    import_templates (id) {
        id -> Text,
        name -> Text,
        scope -> Text,
        kind -> Text,
        source_system -> Text,
        config_version -> Integer,
        config -> Text,
        created_at -> Timestamp,
        updated_at -> Timestamp,
    }
}

diesel::table! {
    ai_messages (id) {
        id -> Text,
        thread_id -> Text,
        role -> Text,
        content_json -> Text,
        created_at -> Text,
    }
}

diesel::table! {
    ai_thread_tags (id) {
        id -> Text,
        thread_id -> Text,
        tag -> Text,
        created_at -> Text,
    }
}

diesel::table! {
    ai_threads (id) {
        id -> Text,
        title -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
        config_snapshot -> Nullable<Text>,
        is_pinned -> Integer,
    }
}

diesel::table! {
    app_settings (setting_key) {
        setting_key -> Text,
        setting_value -> Text,
    }
}

diesel::table! {
    asset_taxonomy_assignments (id) {
        id -> Text,
        asset_id -> Text,
        taxonomy_id -> Text,
        category_id -> Text,
        weight -> Integer,
        source -> Text,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    assets (id) {
        id -> Text,
        kind -> Text,
        name -> Nullable<Text>,
        display_code -> Nullable<Text>,
        notes -> Nullable<Text>,
        metadata -> Nullable<Text>,
        is_active -> Integer,
        quote_mode -> Text,
        quote_ccy -> Text,
        instrument_type -> Nullable<Text>,
        instrument_symbol -> Nullable<Text>,
        instrument_exchange_mic -> Nullable<Text>,
        instrument_key -> Nullable<Text>,
        provider_config -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    brokers_sync_state (account_id, provider) {
        account_id -> Text,
        provider -> Text,
        checkpoint_json -> Nullable<Text>,
        last_attempted_at -> Nullable<Text>,
        last_successful_at -> Nullable<Text>,
        last_error -> Nullable<Text>,
        last_run_id -> Nullable<Text>,
        sync_status -> Text,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    contribution_limits (id) {
        id -> Text,
        group_name -> Text,
        contribution_year -> Integer,
        limit_amount -> Double,
        account_ids -> Nullable<Text>,
        created_at -> Timestamp,
        updated_at -> Timestamp,
        start_date -> Nullable<Timestamp>,
        end_date -> Nullable<Timestamp>,
    }
}

diesel::table! {
    market_data_custom_providers (id) {
        id -> Text,
        code -> Text,
        name -> Text,
        description -> Text,
        enabled -> Bool,
        priority -> Integer,
        config -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    daily_account_valuation (id) {
        id -> Text,
        account_id -> Text,
        valuation_date -> Date,
        account_currency -> Text,
        base_currency -> Text,
        fx_rate_to_base -> Text,
        cash_balance -> Text,
        investment_market_value -> Text,
        total_value -> Text,
        cost_basis -> Text,
        net_contribution -> Text,
        cash_balance_base -> Text,
        investment_market_value_base -> Text,
        total_value_base -> Text,
        cost_basis_base -> Text,
        net_contribution_base -> Text,
        external_inflow_base -> Text,
        external_outflow_base -> Text,
        external_flow_source -> Text,
        performance_eligible_value_base -> Text,
        value_status -> Text,
        basis_status -> Text,
        calculated_at -> Text,
    }
}

diesel::table! {
    goals (id) {
        id -> Text,
        title -> Text,
        description -> Nullable<Text>,
        target_amount -> Double,
        goal_type -> Text,
        status_lifecycle -> Text,
        status_health -> Text,
        priority -> Integer,
        cover_image_key -> Nullable<Text>,
        currency -> Nullable<Text>,
        start_date -> Nullable<Text>,
        target_date -> Nullable<Text>,
        summary_current_value -> Nullable<Double>,
        summary_progress -> Nullable<Double>,
        projected_completion_date -> Nullable<Text>,
        projected_value_at_target_date -> Nullable<Double>,
        created_at -> Text,
        updated_at -> Text,
        summary_target_amount -> Nullable<Double>,
    }
}

diesel::table! {
    goal_plans (goal_id) {
        goal_id -> Text,
        plan_kind -> Text,
        planner_mode -> Nullable<Text>,
        settings_json -> Text,
        summary_json -> Text,
        version -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    goals_allocation (id) {
        id -> Text,
        goal_id -> Text,
        account_id -> Text,
        share_percent -> Double,
        tax_bucket -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    health_issue_dismissals (issue_id) {
        issue_id -> Text,
        dismissed_at -> Text,
        data_hash -> Text,
    }
}

diesel::table! {
    holdings_snapshots (id) {
        id -> Text,
        account_id -> Text,
        snapshot_date -> Date,
        currency -> Text,
        positions -> Text,
        cash_balances -> Text,
        cost_basis -> Text,
        net_contribution -> Text,
        calculated_at -> Text,
        net_contribution_base -> Text,
        cash_total_account_currency -> Text,
        cash_total_base_currency -> Text,
        source -> Text,
    }
}

diesel::table! {
    import_runs (id) {
        id -> Text,
        account_id -> Text,
        source_system -> Text,
        run_type -> Text,
        mode -> Text,
        status -> Text,
        started_at -> Text,
        finished_at -> Nullable<Text>,
        review_mode -> Text,
        applied_at -> Nullable<Text>,
        checkpoint_in -> Nullable<Text>,
        checkpoint_out -> Nullable<Text>,
        summary -> Nullable<Text>,
        warnings -> Nullable<Text>,
        error -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    lot_disposals (id) {
        id -> Text,
        lot_id -> Text,
        account_id -> Text,
        asset_id -> Text,
        disposal_activity_id -> Text,
        disposal_date -> Text,
        quantity -> Text,
        proceeds -> Text,
        cost_basis -> Text,
        realized_pnl -> Text,
        proceeds_base -> Text,
        cost_basis_base -> Text,
        realized_pnl_base -> Text,
        currency -> Text,
        base_currency -> Text,
        fx_rate_to_base -> Text,
        cost_basis_method -> Text,
        created_at -> Text,
    }
}

diesel::table! {
    lots (id) {
        id -> Text,
        account_id -> Text,
        asset_id -> Text,
        open_date -> Text,
        open_activity_id -> Nullable<Text>,
        original_quantity -> Text,
        cost_per_unit -> Text,
        original_cost_basis -> Text,
        remaining_cost_basis -> Text,
        original_cost_basis_base -> Text,
        remaining_cost_basis_base -> Text,
        fee_allocated -> Text,
        fee_allocated_base -> Text,
        tax_allocated -> Text,
        tax_allocated_base -> Text,
        currency -> Text,
        base_currency -> Text,
        fx_rate_to_base -> Text,
        cost_basis_method -> Text,
        remaining_quantity -> Text,
        split_ratio -> Text,
        is_closed -> Integer,
        close_date -> Nullable<Text>,
        close_activity_id -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    snapshot_positions (id) {
        id -> Integer,
        snapshot_id -> Text,
        asset_id -> Text,
        quantity -> Text,
        average_cost -> Text,
        total_cost_basis -> Text,
        currency -> Text,
        inception_date -> Text,
        is_alternative -> Integer,
        contract_multiplier -> Text,
        created_at -> Text,
        last_updated -> Text,
    }
}

diesel::table! {
    market_data_providers (id) {
        id -> Text,
        name -> Text,
        description -> Text,
        url -> Nullable<Text>,
        priority -> Integer,
        enabled -> Bool,
        logo_filename -> Nullable<Text>,
        last_synced_at -> Nullable<Text>,
        last_sync_status -> Nullable<Text>,
        last_sync_error -> Nullable<Text>,
        provider_type -> Text,
        config -> Nullable<Text>,
    }
}

diesel::table! {
    platforms (id) {
        id -> Text,
        name -> Nullable<Text>,
        url -> Text,
        external_id -> Nullable<Text>,
        kind -> Text,
        website_url -> Nullable<Text>,
        logo_url -> Nullable<Text>,
    }
}

diesel::table! {
    quote_sync_state (asset_id) {
        asset_id -> Text,
        position_closed_date -> Nullable<Text>,
        last_synced_at -> Nullable<Text>,
        data_source -> Text,
        sync_priority -> Integer,
        error_count -> Integer,
        last_error -> Nullable<Text>,
        profile_enriched_at -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    quotes (id) {
        id -> Text,
        asset_id -> Text,
        day -> Text,
        source -> Text,
        open -> Nullable<Text>,
        high -> Nullable<Text>,
        low -> Nullable<Text>,
        close -> Text,
        adjclose -> Nullable<Text>,
        volume -> Nullable<Text>,
        currency -> Text,
        notes -> Nullable<Text>,
        created_at -> Text,
        timestamp -> Text,
    }
}

diesel::table! {
    sync_applied_events (event_id) {
        event_id -> Text,
        seq -> BigInt,
        entity -> Text,
        entity_id -> Text,
        applied_at -> Text,
    }
}

diesel::table! {
    sync_cursor (id) {
        id -> Integer,
        cursor -> BigInt,
        updated_at -> Text,
    }
}

diesel::table! {
    sync_device_config (device_id) {
        device_id -> Text,
        key_version -> Nullable<Integer>,
        trust_state -> Text,
        last_bootstrap_at -> Nullable<Text>,
        min_snapshot_created_at -> Nullable<Text>,
    }
}

diesel::table! {
    sync_engine_state (id) {
        id -> Integer,
        lock_version -> BigInt,
        last_push_at -> Nullable<Text>,
        last_pull_at -> Nullable<Text>,
        last_error -> Nullable<Text>,
        consecutive_failures -> Integer,
        next_retry_at -> Nullable<Text>,
        last_cycle_status -> Nullable<Text>,
        last_cycle_duration_ms -> Nullable<BigInt>,
    }
}

diesel::table! {
    sync_entity_metadata (entity, entity_id) {
        entity -> Text,
        entity_id -> Text,
        last_event_id -> Text,
        last_client_timestamp -> Text,
        last_op -> Text,
        last_seq -> BigInt,
    }
}

diesel::table! {
    sync_outbox (event_id) {
        event_id -> Text,
        entity -> Text,
        entity_id -> Text,
        op -> Text,
        client_timestamp -> Text,
        payload -> Text,
        payload_key_version -> Integer,
        sent -> Integer,
        status -> Text,
        retry_count -> Integer,
        next_retry_at -> Nullable<Text>,
        last_error -> Nullable<Text>,
        last_error_code -> Nullable<Text>,
        device_id -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    sync_table_state (table_name) {
        table_name -> Text,
        enabled -> Integer,
        last_snapshot_restore_at -> Nullable<Text>,
        last_incremental_apply_at -> Nullable<Text>,
    }
}

diesel::table! {
    taxonomies (id) {
        id -> Text,
        name -> Text,
        color -> Text,
        description -> Nullable<Text>,
        is_system -> Integer,
        is_single_select -> Integer,
        sort_order -> Integer,
        created_at -> Text,
        updated_at -> Text,
        scope -> Text,
    }
}

diesel::table! {
    taxonomy_categories (id, taxonomy_id) {
        id -> Text,
        taxonomy_id -> Text,
        parent_id -> Nullable<Text>,
        name -> Text,
        key -> Text,
        color -> Text,
        description -> Nullable<Text>,
        sort_order -> Integer,
        created_at -> Text,
        updated_at -> Text,
        icon -> Nullable<Text>,
    }
}

diesel::table! {
    activity_taxonomy_assignments (id) {
        id -> Text,
        activity_id -> Text,
        taxonomy_id -> Text,
        category_id -> Text,
        weight -> Integer,
        source -> Text,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    spending_activity_events (activity_id) {
        activity_id -> Text,
        event_id -> Text,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    spending_activity_splits (id) {
        id -> Text,
        activity_id -> Text,
        taxonomy_id -> Text,
        category_id -> Text,
        amount -> Text,
        note -> Nullable<Text>,
        sort_order -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    spending_event_types (id) {
        id -> Text,
        key -> Nullable<Text>,
        name -> Text,
        color -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    spending_events (id) {
        id -> Text,
        name -> Text,
        description -> Nullable<Text>,
        event_type_id -> Text,
        start_date -> Text,
        end_date -> Text,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    spending_categorization_rules (id) {
        id -> Text,
        name -> Text,
        pattern -> Text,
        match_type -> Text,
        taxonomy_id -> Nullable<Text>,
        category_id -> Nullable<Text>,
        activity_type -> Nullable<Text>,
        priority -> Integer,
        is_global -> Integer,
        account_id -> Nullable<Text>,
        preset_id -> Nullable<Text>,
        preset_rule_key -> Nullable<Text>,
        preset_version -> Nullable<Text>,
        preset_modified -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    spending_preset_rule_deletions (preset_id, preset_rule_key) {
        preset_id -> Text,
        preset_rule_key -> Text,
        rule_id -> Text,
        deleted_at -> Text,
    }
}

diesel::table! {
    budget_groups (id) {
        id -> Text,
        name -> Text,
        key -> Text,
        color -> Nullable<Text>,
        icon -> Nullable<Text>,
        sort_order -> Integer,
        is_system -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    budget_group_assignments (id) {
        id -> Text,
        group_id -> Text,
        taxonomy_id -> Text,
        category_id -> Text,
        is_system -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    budget_targets (id) {
        id -> Text,
        period_key -> Text,
        target_type -> Text,
        taxonomy_id -> Nullable<Text>,
        category_id -> Nullable<Text>,
        group_id -> Nullable<Text>,
        amount -> Text,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    budget_rollover_settings (id) {
        id -> Text,
        target_type -> Text,
        taxonomy_id -> Nullable<Text>,
        category_id -> Nullable<Text>,
        group_id -> Nullable<Text>,
        enabled -> Integer,
        start_month -> Text,
        starting_balance -> Text,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    portfolios (id) {
        id -> Text,
        name -> Text,
        description -> Nullable<Text>,
        sort_order -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    portfolio_accounts (id) {
        id -> Text,
        portfolio_id -> Text,
        account_id -> Text,
        sort_order -> Integer,
        created_at -> Text,
    }
}

diesel::joinable!(portfolio_accounts -> portfolios (portfolio_id));
diesel::joinable!(portfolio_accounts -> accounts (account_id));

diesel::table! {
    allocation_targets (id) {
        id -> Text,
        name -> Text,
        scope_type -> Text,
        scope_id -> Nullable<Text>,
        taxonomy_id -> Text,
        trigger_type -> Text,
        drift_band_bps -> Integer,
        band_type -> Text,
        relative_factor_bps -> Integer,
        rebalance_goal -> Text,
        min_trade_amount -> Text,
        whole_shares_only -> Integer,
        allow_sells -> Integer,
        created_at -> Text,
        updated_at -> Text,
        archived_at -> Nullable<Text>,
        max_turnover_bps -> Nullable<Integer>,
    }
}

diesel::table! {
    allocation_target_weights (id) {
        id -> Text,
        target_id -> Text,
        taxonomy_id -> Text,
        category_id -> Text,
        target_bps -> Integer,
        is_locked -> Integer,
        is_required -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    addon_storage (addon_id, key) {
        addon_id -> Text,
        key -> Text,
        value -> Text,
    }
}

diesel::table! {
    personal_access_tokens (id) {
        id -> Text,
        name -> Text,
        token_prefix -> Text,
        token_hash -> Text,
        scopes_json -> Text,
        expires_at -> Nullable<Text>,
        last_used_at -> Nullable<Text>,
        revoked_at -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    mcp_audit_log (id) {
        id -> Text,
        session_id -> Text,
        actor_kind -> Text,
        actor_fingerprint -> Text,
        tool -> Text,
        scopes_json -> Text,
        args_summary -> Nullable<Text>,
        outcome -> Text,
        error_message -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::joinable!(allocation_target_weights -> allocation_targets (target_id));

diesel::table! {
    allocation_target_constraints (id) {
        id -> Text,
        target_id -> Text,
        subject_type -> Text,
        subject_id -> Text,
        action -> Text,
        effect -> Text,
        reason -> Nullable<Text>,
        metadata_json -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::joinable!(allocation_target_constraints -> allocation_targets (target_id));

diesel::joinable!(accounts -> platforms (platform_id));
diesel::joinable!(activities -> accounts (account_id));
diesel::joinable!(activities -> assets (asset_id));
diesel::joinable!(activities -> import_runs (import_run_id));
diesel::joinable!(ai_messages -> ai_threads (thread_id));
diesel::joinable!(ai_thread_tags -> ai_threads (thread_id));
diesel::joinable!(asset_taxonomy_assignments -> assets (asset_id));
diesel::joinable!(brokers_sync_state -> accounts (account_id));
diesel::joinable!(brokers_sync_state -> import_runs (last_run_id));
diesel::joinable!(goals_allocation -> accounts (account_id));
diesel::joinable!(goal_plans -> goals (goal_id));
diesel::joinable!(goals_allocation -> goals (goal_id));
diesel::joinable!(import_runs -> accounts (account_id));
diesel::joinable!(lots -> accounts (account_id));
diesel::joinable!(lots -> assets (asset_id));
diesel::joinable!(quotes -> assets (asset_id));
diesel::joinable!(snapshot_positions -> holdings_snapshots (snapshot_id));
diesel::joinable!(snapshot_positions -> assets (asset_id));
diesel::joinable!(lot_disposals -> lots (lot_id));
diesel::joinable!(lot_disposals -> accounts (account_id));
diesel::joinable!(lot_disposals -> assets (asset_id));
diesel::joinable!(lot_disposals -> activities (disposal_activity_id));
diesel::joinable!(taxonomy_categories -> taxonomies (taxonomy_id));
diesel::joinable!(activity_taxonomy_assignments -> activities (activity_id));
diesel::joinable!(activity_taxonomy_assignments -> taxonomies (taxonomy_id));
diesel::joinable!(spending_activity_events -> activities (activity_id));
diesel::joinable!(spending_activity_events -> spending_events (event_id));
diesel::joinable!(spending_activity_splits -> activities (activity_id));
diesel::joinable!(spending_activity_splits -> taxonomies (taxonomy_id));
diesel::joinable!(spending_events -> spending_event_types (event_type_id));
diesel::joinable!(spending_categorization_rules -> accounts (account_id));
diesel::joinable!(spending_categorization_rules -> taxonomies (taxonomy_id));
diesel::joinable!(budget_group_assignments -> budget_groups (group_id));
diesel::joinable!(budget_group_assignments -> taxonomies (taxonomy_id));
diesel::joinable!(budget_targets -> budget_groups (group_id));
diesel::joinable!(budget_targets -> taxonomies (taxonomy_id));
diesel::joinable!(budget_rollover_settings -> budget_groups (group_id));
diesel::joinable!(budget_rollover_settings -> taxonomies (taxonomy_id));

diesel::joinable!(import_account_templates -> import_templates (template_id));

diesel::allow_tables_to_appear_in_same_query!(
    import_account_templates,
    accounts,
    portfolios,
    portfolio_accounts,
    activities,
    ai_messages,
    ai_thread_tags,
    ai_threads,
    app_settings,
    asset_taxonomy_assignments,
    assets,
    brokers_sync_state,
    contribution_limits,
    market_data_custom_providers,
    daily_account_valuation,
    goal_plans,
    goals,
    goals_allocation,
    health_issue_dismissals,
    holdings_snapshots,
    import_templates,
    import_runs,
    lot_disposals,
    lots,
    market_data_providers,
    platforms,
    quote_sync_state,
    quotes,
    snapshot_positions,
    sync_applied_events,
    sync_cursor,
    sync_device_config,
    sync_engine_state,
    sync_entity_metadata,
    sync_outbox,
    sync_table_state,
    taxonomies,
    taxonomy_categories,
    activity_taxonomy_assignments,
    spending_activity_events,
    spending_activity_splits,
    spending_event_types,
    spending_events,
    spending_categorization_rules,
    spending_preset_rule_deletions,
    budget_groups,
    budget_group_assignments,
    budget_targets,
    budget_rollover_settings,
    allocation_targets,
    allocation_target_weights,
    personal_access_tokens,
    mcp_audit_log,
    allocation_target_constraints,
);
