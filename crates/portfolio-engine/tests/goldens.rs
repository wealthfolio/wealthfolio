//! Kernel golden runner (architecture §5): every scenario that is not
//! shell-level runs through the five stages and lands in `goldens/kernel/`
//! as a reviewed insta snapshot. Regenerate with `INSTA_UPDATE=always`.

mod support;

use support::*;

fn goldens_dir() -> std::path::PathBuf {
    fixtures_dir().join("goldens/kernel")
}

#[test]
fn kernel_goldens() {
    let mut count = 0;
    for scenario in load_all_scenarios() {
        if scenario.markers.iter().any(|m| m == "S") || !scenario_selected(&scenario.id) {
            continue;
        }
        count += 1;
        let pipeline = Pipeline::from_scenario(&scenario);
        let body = capture_body(&pipeline, &all_windows(&scenario));
        let output = serde_json::json!({
            "scenario": scenario.id,
            "as_of": scenario.policy.as_of.to_string(),
            "base_currency": scenario.policy.base_currency,
            "baseline": body,
        });
        insta::with_settings!({
            snapshot_path => goldens_dir(),
            prepend_module_to_snapshot => false,
            omit_expression => true,
        }, {
            insta::assert_yaml_snapshot!(scenario.id.clone(), output);
        });
    }
    assert!(count > 0, "no scenarios matched");
}
