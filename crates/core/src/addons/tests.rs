use crate::addons::models::*;
use crate::addons::network::{AddonNetworkAuth, AddonNetworkRequest};
use crate::addons::service::*;
use std::io::Write;
use zip::write::SimpleFileOptions;

fn build_test_addon_zip(entries: &[(&str, &str)]) -> Vec<u8> {
    build_test_addon_zip_owned(
        entries
            .iter()
            .map(|(name, content)| (name.to_string(), content.as_bytes().to_vec()))
            .collect(),
    )
}

fn build_test_addon_zip_owned(entries: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options = SimpleFileOptions::default();

        for (name, content) in entries {
            zip.start_file(&name, options)
                .expect("failed to start zip file");
            zip.write_all(&content).expect("failed to write zip file");
        }

        zip.finish().expect("failed to finish zip");
    }

    cursor.into_inner()
}

#[test]
fn test_archive_path_matches_manifest_main_requires_component_boundary() {
    assert!(archive_path_matches_manifest_main("addon.js", "addon.js"));
    assert!(archive_path_matches_manifest_main(
        "package/dist/addon.js",
        "dist/addon.js"
    ));
    assert!(!archive_path_matches_manifest_main(
        "package/dist/not-addon.js",
        "addon.js"
    ));
    assert!(!archive_path_matches_manifest_main("addon.js", ""));
}

#[test]
fn test_update_permission_escalation_requires_reinstall_approval() {
    let previous = AddonManifest {
        id: "test-addon".to_string(),
        name: "Test Addon".to_string(),
        version: "1.0.0".to_string(),
        description: None,
        author: None,
        sdk_version: None,
        main: Some("addon.js".to_string()),
        enabled: Some(true),
        permissions: Some(vec![AddonPermission {
            category: "ui".to_string(),
            purpose: "User interface".to_string(),
            functions: vec![FunctionPermission {
                name: "router.add".to_string(),
                is_declared: true,
                is_detected: false,
                detected_at: None,
            }],
        }]),
        homepage: None,
        repository: None,
        license: None,
        min_wealthfolio_version: None,
        contributes: None,
        keywords: None,
        icon: None,
        network: None,
        host_dependencies: None,
        installed_at: None,
        updated_at: None,
        source: None,
        size: None,
    };
    let mut next = previous.clone();
    next.version = "1.1.0".to_string();
    next.permissions.as_mut().unwrap().push(AddonPermission {
        category: "secrets".to_string(),
        purpose: "Secrets".to_string(),
        functions: vec![FunctionPermission {
            name: "use".to_string(),
            is_declared: true,
            is_detected: false,
            detected_at: None,
        }],
    });

    let result = AddonService::ensure_update_does_not_add_permissions(Some(&previous), &next);

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("secrets.use"));
}

#[test]
fn test_update_adding_baseline_ui_permission_is_not_escalation() {
    let previous = AddonManifest {
        id: "test-addon".to_string(),
        name: "Test Addon".to_string(),
        version: "1.0.0".to_string(),
        description: None,
        author: None,
        sdk_version: None,
        main: Some("addon.js".to_string()),
        enabled: Some(true),
        permissions: None,
        homepage: None,
        repository: None,
        license: None,
        min_wealthfolio_version: None,
        contributes: None,
        keywords: None,
        icon: None,
        network: None,
        host_dependencies: None,
        installed_at: None,
        updated_at: None,
        source: None,
        size: None,
    };
    let mut next = previous.clone();
    next.version = "1.1.0".to_string();
    // Legacy baseline declarations (ui/query) must never count as an escalation.
    next.permissions = Some(vec![
        AddonPermission {
            category: "ui".to_string(),
            purpose: "User interface".to_string(),
            functions: vec![
                FunctionPermission {
                    name: "sidebar.addItem".to_string(),
                    is_declared: true,
                    is_detected: false,
                    detected_at: None,
                },
                FunctionPermission {
                    name: "router.add".to_string(),
                    is_declared: true,
                    is_detected: false,
                    detected_at: None,
                },
            ],
        },
        AddonPermission {
            category: "query".to_string(),
            purpose: "Query cache".to_string(),
            functions: vec![FunctionPermission {
                name: "invalidateQueries".to_string(),
                is_declared: true,
                is_detected: false,
                detected_at: None,
            }],
        },
    ]);

    let result = AddonService::ensure_update_does_not_add_permissions(Some(&previous), &next);

    assert!(result.is_ok());
}

#[test]
fn test_detect_addon_permissions_hello_world() {
    // Test with actual hello world addon content
    let hello_world_content = r#"
import { type AddonContext } from '@wealthfolio/addon-sdk';
import React from 'react';
import { AlertsIcon } from './icons';

export default function enable(ctx: AddonContext) {
  console.log('🚀 Hello World addon is being enabled!');

  const addedItems: Array<{ remove: () => void }> = [];

  const sidebarItem = ctx.sidebar.addItem({
    id: 'hello-world',
    label: 'Hello World',
    icon: <AlertsIcon className="h-5 w-5" />,
    route: '/addon/hello-world',
    order: 100
  });
  addedItems.push(sidebarItem);

  ctx.router.add({
    path: '/addon/hello-world',
    component: React.lazy(() => Promise.resolve({ default: HelloWorldWrapper }))
  });

  ctx.onDisable(() => {
    console.log('🛑 Hello World addon is being disabled');
    addedItems.forEach(item => {
      item.remove();
    });
  });
}
        "#;

    let addon_files = vec![AddonFile {
        name: "addon.tsx".to_string(),
        content: hello_world_content.to_string(),
        is_main: true,
    }];

    let detected_permissions = detect_addon_permissions(&addon_files);

    println!(
        "Hello World detected permissions: {:#?}",
        detected_permissions
    );

    // Should detect UI functions
    let ui_permission = detected_permissions.iter().find(|p| p.category == "ui");
    assert!(
        ui_permission.is_some(),
        "UI permissions should be detected in hello world addon"
    );

    let ui_permission = ui_permission.unwrap();
    let ui_functions: Vec<&str> = ui_permission
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    println!("UI functions detected: {:?}", ui_functions);
    assert!(
        ui_functions.contains(&"sidebar.addItem"),
        "sidebar.addItem should be detected in hello world"
    );
    assert!(
        ui_functions.contains(&"router.add"),
        "router.add should be detected in hello world"
    );
    assert!(
        ui_functions.contains(&"onDisable"),
        "onDisable should be detected in hello world"
    );

    // Should NOT detect portfolio or market-data functions
    let portfolio_permission = detected_permissions
        .iter()
        .find(|p| p.category == "portfolio");
    assert!(
        portfolio_permission.is_none(),
        "Portfolio permissions should NOT be detected in hello world addon"
    );

    let market_permission = detected_permissions
        .iter()
        .find(|p| p.category == "market-data");
    assert!(
        market_permission.is_none(),
        "Market-data permissions should NOT be detected in hello world addon"
    );
}

#[test]
fn test_detect_addon_permissions() {
    // Create test addon files that use various functions
    let addon_files = vec![
        AddonFile {
            name: "addon.js".to_string(),
            content: r#"
                ctx.sidebar.addItem({ id: 'test' });
                ctx.router.add({ path: '/test' });
                ctx.onDisable(() => { console.log('disabled'); });
                ctx.api.portfolio.getHoldings();
                ctx.api.portfolio.getHolding();
            "#
            .to_string(),
            is_main: true,
        },
        AddonFile {
            name: "helper.js".to_string(),
            content: r#"
                function helper() {
                    return ctx.api.market.searchTicker('AAPL');
                }
            "#
            .to_string(),
            is_main: false,
        },
    ];

    let detected_permissions = detect_addon_permissions(&addon_files);

    println!("Detected permissions: {:#?}", detected_permissions);

    // Should detect UI functions
    let ui_permission = detected_permissions.iter().find(|p| p.category == "ui");
    assert!(ui_permission.is_some(), "UI permissions should be detected");

    let ui_permission = ui_permission.unwrap();
    let ui_functions: Vec<&str> = ui_permission
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert!(
        ui_functions.contains(&"sidebar.addItem"),
        "sidebar.addItem should be detected"
    );
    assert!(
        ui_functions.contains(&"router.add"),
        "router.add should be detected"
    );
    assert!(
        ui_functions.contains(&"onDisable"),
        "onDisable should be detected"
    );

    // Should detect portfolio functions
    let portfolio_permission = detected_permissions
        .iter()
        .find(|p| p.category == "portfolio");
    assert!(
        portfolio_permission.is_some(),
        "Portfolio permissions should be detected"
    );

    let portfolio_permission = portfolio_permission.unwrap();
    let portfolio_functions: Vec<&str> = portfolio_permission
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert!(
        portfolio_functions.contains(&"getHoldings"),
        "getHoldings should be detected"
    );
    assert!(
        portfolio_functions.contains(&"getHolding"),
        "getHolding should be detected"
    );

    // Should detect market-data functions
    let market_permission = detected_permissions
        .iter()
        .find(|p| p.category == "market-data");
    assert!(
        market_permission.is_some(),
        "Market data permissions should be detected"
    );

    let market_permission = market_permission.unwrap();
    let market_functions: Vec<&str> = market_permission
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert!(
        market_functions.contains(&"searchTicker"),
        "searchTicker should be detected"
    );
}

#[test]
fn test_detect_addon_permissions_assets_and_market_data_sdk_categories() {
    let addon_files = vec![AddonFile {
        name: "addon.js".to_string(),
        content: r#"
            export default function enable(ctx) {
                ctx.api.assets.getProfile('asset-1');
                ctx.api.market.fetchDividends('AAPL');
            }
        "#
        .to_string(),
        is_main: true,
    }];

    let detected_permissions = detect_addon_permissions(&addon_files);

    let assets_permission = detected_permissions
        .iter()
        .find(|p| p.category == "assets")
        .expect("assets permissions should be detected");
    let assets_functions: Vec<&str> = assets_permission
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert!(
        assets_functions.contains(&"getProfile"),
        "getProfile should be detected under assets"
    );

    let market_permission = detected_permissions
        .iter()
        .find(|p| p.category == "market-data")
        .expect("market-data permissions should be detected");
    let market_functions: Vec<&str> = market_permission
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert!(
        market_functions.contains(&"fetchDividends"),
        "fetchDividends should be detected under market-data"
    );
    assert!(
        !market_functions.contains(&"getProfile"),
        "getProfile should not be detected under market-data"
    );
}

#[test]
fn test_addon_manifest_to_installed() {
    let manifest = AddonManifest {
        id: "test-addon".to_string(),
        name: "Test Addon".to_string(),
        version: "1.0.0".to_string(),
        description: Some("A test addon".to_string()),
        author: Some("Test Author".to_string()),
        sdk_version: Some("1.0.0".to_string()),
        main: Some("addon.js".to_string()),
        enabled: None,
        permissions: None,
        homepage: None,
        repository: None,
        license: None,
        min_wealthfolio_version: None,
        contributes: None,
        keywords: None,
        icon: None,
        network: None,
        host_dependencies: None,
        installed_at: None,
        updated_at: None,
        source: None,
        size: None,
    };

    let installed = manifest.to_installed(true).unwrap();
    assert!(installed.is_enabled());
    assert!(installed.installed_at.is_some());
    assert_eq!(installed.source, Some("local".to_string()));
}

#[test]
fn test_addon_manifest_get_main() {
    let manifest = AddonManifest {
        id: "test-addon".to_string(),
        name: "Test Addon".to_string(),
        version: "1.0.0".to_string(),
        description: None,
        author: None,
        sdk_version: None,
        main: Some("addon.js".to_string()),
        enabled: None,
        permissions: None,
        homepage: None,
        repository: None,
        license: None,
        min_wealthfolio_version: None,
        contributes: None,
        keywords: None,
        icon: None,
        network: None,
        host_dependencies: None,
        installed_at: None,
        updated_at: None,
        source: None,
        size: None,
    };

    assert_eq!(manifest.get_main().unwrap(), "addon.js");

    let manifest_no_main = AddonManifest {
        id: "test-addon".to_string(),
        name: "Test Addon".to_string(),
        version: "1.0.0".to_string(),
        description: None,
        author: None,
        sdk_version: None,
        main: None,
        enabled: None,
        permissions: None,
        homepage: None,
        repository: None,
        license: None,
        min_wealthfolio_version: None,
        contributes: None,
        keywords: None,
        icon: None,
        network: None,
        host_dependencies: None,
        installed_at: None,
        updated_at: None,
        source: None,
        size: None,
    };

    assert!(manifest_no_main.get_main().is_err());
}

#[test]
fn test_function_permission_helpers() {
    let permission = AddonPermission {
        category: "ui".to_string(),
        purpose: "User interface access".to_string(),
        functions: vec![
            FunctionPermission {
                name: "sidebar.addItem".to_string(),
                is_declared: true,
                is_detected: true,
                detected_at: Some("2023-01-01T00:00:00Z".to_string()),
            },
            FunctionPermission {
                name: "router.add".to_string(),
                is_declared: false,
                is_detected: true,
                detected_at: Some("2023-01-01T00:00:00Z".to_string()),
            },
            FunctionPermission {
                name: "showNotification".to_string(),
                is_declared: true,
                is_detected: false,
                detected_at: None,
            },
        ],
    };

    let declared = get_declared_functions(&permission);
    assert_eq!(declared.len(), 2);
    assert!(declared.contains(&"sidebar.addItem".to_string()));
    assert!(declared.contains(&"showNotification".to_string()));

    let detected = get_detected_functions(&permission);
    assert_eq!(detected.len(), 2);
    assert!(detected.contains(&"sidebar.addItem".to_string()));
    assert!(detected.contains(&"router.add".to_string()));

    let undeclared_detected = get_undeclared_detected_functions(&permission);
    assert_eq!(undeclared_detected.len(), 1);
    assert!(undeclared_detected.contains(&"router.add".to_string()));

    assert!(has_undeclared_detected_functions(&permission));
}

#[test]
fn test_permission_merging_during_installation() {
    // Create a mock addon with declared permissions
    let declared_permissions = vec![
        AddonPermission {
            category: "ui".to_string(),
            purpose: "User interface access".to_string(),
            functions: vec![
                FunctionPermission {
                    name: "showNotification".to_string(),
                    is_declared: true,
                    is_detected: false,
                    detected_at: None,
                },
                FunctionPermission {
                    name: "sidebar.addItem".to_string(),
                    is_declared: true,
                    is_detected: false,
                    detected_at: None,
                },
            ],
        },
        AddonPermission {
            category: "portfolio".to_string(),
            purpose: "Portfolio data access".to_string(),
            functions: vec![FunctionPermission {
                name: "getHoldings".to_string(),
                is_declared: true,
                is_detected: false,
                detected_at: None,
            }],
        },
    ];

    // Create addon files that use some declared and some undeclared functions
    let addon_files = vec![AddonFile {
        name: "addon.tsx".to_string(),
        content: r#"
                // Use declared functions
                ctx.sidebar.addItem({ id: 'test' });
                ctx.api.portfolio.getHoldings();

                // Use undeclared function
                ctx.router.add({ path: '/test' });
                ctx.onDisable(() => {});
            "#
        .to_string(),
        is_main: true,
    }];

    // Detect permissions
    let detected_permissions = detect_addon_permissions(&addon_files);

    // Simulate the merging logic from install_addon_zip
    let mut merged_permissions = Vec::new();

    // First, add all declared permissions with their original flags preserved
    for perm in &declared_permissions {
        let mut cloned_functions = Vec::new();
        for func in &perm.functions {
            cloned_functions.push(FunctionPermission {
                name: func.name.clone(),
                is_declared: func.is_declared,
                is_detected: func.is_detected,
                detected_at: func.detected_at.clone(),
            });
        }

        merged_permissions.push(AddonPermission {
            category: perm.category.clone(),
            functions: cloned_functions,
            purpose: perm.purpose.clone(),
        });
    }

    // Then, add detected permissions and merge with declared ones
    for detected_perm in detected_permissions {
        if let Some(existing) = merged_permissions
            .iter_mut()
            .find(|p| p.category == detected_perm.category)
        {
            for detected_func in &detected_perm.functions {
                if let Some(existing_func) = existing
                    .functions
                    .iter_mut()
                    .find(|f| f.name == detected_func.name)
                {
                    // Mark existing declared function as also detected
                    existing_func.is_detected = true;
                    existing_func.detected_at = detected_func.detected_at.clone();
                } else {
                    // Add new detected function (not declared)
                    existing.functions.push(detected_func.clone());
                }
            }
        } else {
            // Add as detected-only permission category
            merged_permissions.push(detected_perm);
        }
    }

    // Verify the merging results
    let ui_permission = merged_permissions
        .iter()
        .find(|p| p.category == "ui")
        .unwrap();

    // Check declared function that was also detected
    let sidebar_func = ui_permission
        .functions
        .iter()
        .find(|f| f.name == "sidebar.addItem")
        .unwrap();
    assert!(
        sidebar_func.is_declared,
        "sidebar.addItem should be marked as declared"
    );
    assert!(
        sidebar_func.is_detected,
        "sidebar.addItem should be marked as detected"
    );
    assert!(
        sidebar_func.detected_at.is_some(),
        "sidebar.addItem should have detected_at timestamp"
    );

    // Check declared function that was NOT detected
    let notification_func = ui_permission
        .functions
        .iter()
        .find(|f| f.name == "showNotification")
        .unwrap();
    assert!(
        notification_func.is_declared,
        "showNotification should be marked as declared"
    );
    assert!(
        !notification_func.is_detected,
        "showNotification should NOT be marked as detected"
    );
    assert!(
        notification_func.detected_at.is_none(),
        "showNotification should not have detected_at timestamp"
    );

    // Check undeclared function that was detected
    let router_func = ui_permission
        .functions
        .iter()
        .find(|f| f.name == "router.add");
    assert!(
        router_func.is_some(),
        "router.add should be present as detected function"
    );
    let router_func = router_func.unwrap();
    assert!(
        !router_func.is_declared,
        "router.add should NOT be marked as declared"
    );
    assert!(
        router_func.is_detected,
        "router.add should be marked as detected"
    );
    assert!(
        router_func.detected_at.is_some(),
        "router.add should have detected_at timestamp"
    );

    // Check portfolio permission
    let portfolio_permission = merged_permissions
        .iter()
        .find(|p| p.category == "portfolio")
        .unwrap();
    let holdings_func = portfolio_permission
        .functions
        .iter()
        .find(|f| f.name == "getHoldings")
        .unwrap();
    assert!(
        holdings_func.is_declared,
        "getHoldings should be marked as declared"
    );
    assert!(
        holdings_func.is_detected,
        "getHoldings should be marked as detected"
    );
    assert!(
        holdings_func.detected_at.is_some(),
        "getHoldings should have detected_at timestamp"
    );
}

#[test]
fn test_function_permission_serialization() {
    // Test that FunctionPermission serializes correctly to camelCase
    let permission = FunctionPermission {
        name: "testFunction".to_string(),
        is_declared: true,
        is_detected: true,
        detected_at: Some("2023-01-01T00:00:00Z".to_string()),
    };

    let serialized = serde_json::to_string(&permission).unwrap();
    println!("Serialized FunctionPermission: {}", serialized);

    // Should contain camelCase fields
    assert!(serialized.contains("isDeclared"));
    assert!(serialized.contains("isDetected"));
    assert!(serialized.contains("detectedAt"));
    assert!(!serialized.contains("is_declared"));
    assert!(!serialized.contains("is_detected"));
    assert!(!serialized.contains("detected_at"));

    // Test deserialization
    let deserialized: FunctionPermission = serde_json::from_str(&serialized).unwrap();
    assert_eq!(deserialized.name, "testFunction");
    assert!(deserialized.is_declared);
    assert!(deserialized.is_detected);
    assert_eq!(
        deserialized.detected_at,
        Some("2023-01-01T00:00:00Z".to_string())
    );
}

#[test]
fn test_parse_manifest_json_metadata_service() {
    // Test the service function parse_manifest_json_metadata
    let manifest_json = r#"
    {
        "id": "test-addon",
        "name": "Test Addon",
        "version": "1.0.0",
        "description": "A test addon for testing",
        "author": "Test Author",
        "main": "addon.js",
        "permissions": [
            {
                "category": "ui",
                "purpose": "User interface access",
                "functions": ["showNotification", "openModal"]
            }
        ]
    }
    "#;

    let result = parse_manifest_json_metadata(manifest_json);
    assert!(result.is_ok(), "Failed to parse valid manifest JSON");

    let manifest = result.unwrap();
    assert_eq!(manifest.id, "test-addon");
    assert_eq!(manifest.name, "Test Addon");
    assert_eq!(manifest.version, "1.0.0");
    assert_eq!(
        manifest.description,
        Some("A test addon for testing".to_string())
    );
    assert_eq!(manifest.author, Some("Test Author".to_string()));
    assert_eq!(manifest.main, Some("addon.js".to_string()));

    // Check permissions were parsed correctly
    assert!(manifest.permissions.is_some());
    let permissions = manifest.permissions.unwrap();
    assert_eq!(permissions.len(), 1);
    assert_eq!(permissions[0].category, "ui");
    assert_eq!(permissions[0].purpose, "User interface access");
    assert_eq!(permissions[0].functions.len(), 2);
    assert_eq!(permissions[0].functions[0].name, "showNotification");
    assert!(permissions[0].functions[0].is_declared);
    assert!(!permissions[0].functions[0].is_detected);
}

#[test]
fn test_parse_manifest_json_metadata_service_preserves_host_dependencies() {
    let manifest_json = r#"
    {
        "id": "host-deps-addon",
        "name": "Host Deps Addon",
        "version": "1.0.0",
        "main": "dist/addon.js",
        "hostDependencies": {
            "react": "^19.2.0",
            "react-dom": "^19.2.0",
            "@wealthfolio/ui": "^3.6.0"
        }
    }
    "#;

    let manifest = parse_manifest_json_metadata(manifest_json).unwrap();
    let host_dependencies = manifest.host_dependencies.unwrap();

    assert_eq!(
        host_dependencies.get("react").map(String::as_str),
        Some("^19.2.0")
    );
    assert_eq!(
        host_dependencies.get("react-dom").map(String::as_str),
        Some("^19.2.0")
    );
    assert_eq!(
        host_dependencies.get("@wealthfolio/ui").map(String::as_str),
        Some("^3.6.0")
    );
}

#[test]
fn test_parse_manifest_contributes_routes_and_links_round_trip() {
    let manifest_json = r#"
    {
        "id": "routes-addon",
        "name": "Routes Addon",
        "version": "1.0.0",
        "main": "dist/addon.js",
        "contributes": {
            "routes": [
                { "id": "main" },
                { "id": "report", "path": "reports/:year" }
            ],
            "links": {
                "sidebar": [
                    {
                        "id": "main-nav",
                        "route": "main",
                        "label": "Routes Addon",
                        "icon": "wallet",
                        "order": 150
                    },
                    { "route": "report", "label": "Report" }
                ],
                "asset/actions": [
                    { "route": "report", "label": "Open Report" }
                ]
            }
        }
    }
    "#;

    let parsed = parse_manifest_json_metadata(manifest_json).expect("manifest should parse");

    // Simulate the install rewrite path (`write_manifest` serializes the parsed
    // manifest), then re-parse to prove the field survives round-trip.
    let serialized = serde_json::to_string(&parsed).expect("manifest should serialize");
    let reparsed = parse_manifest_json_metadata(&serialized).expect("manifest should re-parse");

    let contributes = reparsed
        .contributes
        .expect("contributes should survive round-trip");
    assert_eq!(contributes.routes.len(), 2);

    let main_route = &contributes.routes[0];
    assert_eq!(main_route.id, "main");
    assert_eq!(main_route.path, None);

    let report_route = &contributes.routes[1];
    assert_eq!(report_route.id, "report");
    assert_eq!(report_route.path.as_deref(), Some("reports/:year"));

    let sidebar = contributes
        .links
        .get("sidebar")
        .expect("sidebar links should survive round-trip");
    assert_eq!(sidebar.len(), 2);
    assert_eq!(sidebar[0].id.as_deref(), Some("main-nav"));
    assert_eq!(sidebar[0].route, "main");
    assert_eq!(sidebar[0].label, "Routes Addon");
    assert_eq!(sidebar[0].icon.as_deref(), Some("wallet"));
    assert_eq!(sidebar[0].order, Some(150));
    assert_eq!(sidebar[1].id, None);
    assert_eq!(sidebar[1].route, "report");
    assert_eq!(sidebar[1].label, "Report");
    assert_eq!(sidebar[1].icon, None);
    assert_eq!(sidebar[1].order, None);

    // Unknown slot keys are future host surfaces: they must parse fine and
    // survive the install rewrite untouched.
    let asset_actions = contributes
        .links
        .get("asset/actions")
        .expect("unknown slot should survive round-trip");
    assert_eq!(asset_actions.len(), 1);
    assert_eq!(asset_actions[0].route, "report");
    assert_eq!(asset_actions[0].label, "Open Report");

    // A manifest with no `contributes` stays None (and does not emit the key).
    let without =
        parse_manifest_json_metadata(r#"{"id":"a","name":"A","version":"1.0.0","main":"a.js"}"#)
            .expect("manifest should parse");
    assert!(without.contributes.is_none());
    let serialized_without = serde_json::to_string(&without).expect("should serialize");
    assert!(!serialized_without.contains("contributes"));
}

#[test]
fn test_parse_manifest_contributes_rejects_missing_required_fields() {
    // Route missing `id`.
    let manifest_json = r#"
    {
        "id": "routes-addon",
        "name": "Routes Addon",
        "version": "1.0.0",
        "main": "dist/addon.js",
        "contributes": { "routes": [ { "path": "reports" } ] }
    }
    "#;
    let err = parse_manifest_json_metadata(manifest_json)
        .expect_err("route missing 'id' should be rejected");
    assert!(
        err.contains("contributes"),
        "error should mention contributes, got: {err}"
    );

    // Link missing `label`.
    let manifest_json = r#"
    {
        "id": "routes-addon",
        "name": "Routes Addon",
        "version": "1.0.0",
        "main": "dist/addon.js",
        "contributes": {
            "routes": [ { "id": "main" } ],
            "links": { "sidebar": [ { "route": "main" } ] }
        }
    }
    "#;
    let err = parse_manifest_json_metadata(manifest_json)
        .expect_err("link missing 'label' should be rejected");
    assert!(
        err.contains("contributes"),
        "error should mention contributes, got: {err}"
    );
}

#[test]
fn test_parse_manifest_contributes_rejects_bad_route_ref() {
    let manifest_json = r#"
    {
        "id": "routes-addon",
        "name": "Routes Addon",
        "version": "1.0.0",
        "main": "dist/addon.js",
        "contributes": {
            "routes": [ { "id": "main" } ],
            "links": { "sidebar": [ { "route": "missing", "label": "Ghost" } ] }
        }
    }
    "#;

    let err = parse_manifest_json_metadata(manifest_json)
        .expect_err("link referencing an undeclared route should be rejected");
    assert!(
        err.contains("missing"),
        "error should name the bad route ref, got: {err}"
    );
}

#[test]
fn test_parse_manifest_contributes_rejects_duplicate_route_ids() {
    let manifest_json = r#"
    {
        "id": "routes-addon",
        "name": "Routes Addon",
        "version": "1.0.0",
        "main": "dist/addon.js",
        "contributes": {
            "routes": [
                { "id": "main" },
                { "id": "main", "path": "other" }
            ]
        }
    }
    "#;

    let err = parse_manifest_json_metadata(manifest_json)
        .expect_err("duplicate route ids should be rejected");
    assert!(
        err.contains("duplicate route id 'main'"),
        "error should name the duplicate route id, got: {err}"
    );
}

#[test]
fn test_parse_manifest_contributes_rejects_unsafe_route_paths() {
    for path in [
        "/absolute",
        "../settings",
        "reports//monthly",
        "reports?view=all",
        "reports#summary",
        "%2e%2e/settings",
        "reports\\monthly",
        " reports",
    ] {
        let manifest = serde_json::json!({
            "id": "routes-addon",
            "name": "Routes Addon",
            "version": "1.0.0",
            "main": "dist/addon.js",
            "contributes": { "routes": [{ "id": "main", "path": path }] }
        });

        let err = parse_manifest_json_metadata(&manifest.to_string())
            .expect_err("unsafe contributed route path should be rejected");
        assert!(
            err.contains("contributes.routes path"),
            "error should identify the unsafe route path '{path}', got: {err}"
        );
    }
}

#[test]
fn test_parse_manifest_contributes_rejects_duplicate_effective_route_paths() {
    let manifest_json = r#"
    {
        "id": "routes-addon",
        "name": "Routes Addon",
        "version": "1.0.0",
        "main": "dist/addon.js",
        "contributes": {
            "routes": [
                { "id": "main" },
                { "id": "alternate-main", "path": "" }
            ]
        }
    }
    "#;

    let err = parse_manifest_json_metadata(manifest_json)
        .expect_err("duplicate effective route paths should be rejected");
    assert!(
        err.contains("duplicate route path"),
        "error should identify the duplicate route path, got: {err}"
    );
}

#[test]
fn test_version_meets_minimum_semantics() {
    assert!(version_meets_minimum("3.6.1", "3.6.0"));
    assert!(version_meets_minimum("3.6.1", "3.6.1"));
    assert!(version_meets_minimum("3.7.0", "3.6.9"));
    assert!(version_meets_minimum("4.0.0", "3.9.9"));
    assert!(!version_meets_minimum("3.6.0", "3.6.1"));
    assert!(!version_meets_minimum("3.5.9", "3.6.0"));
    assert!(!version_meets_minimum("2.0.0", "3.0.0"));
    // Pre-release / build suffixes are ignored for comparison.
    assert!(version_meets_minimum("3.6.1-beta.1", "3.6.1"));
    // Missing patch component defaults to 0.
    assert!(version_meets_minimum("3.6", "3.6.0"));
    // Multi-digit components compare numerically, not lexically.
    assert!(!version_meets_minimum("3.6.1", "3.6.10"));
    assert!(version_meets_minimum("3.6.10", "3.6.9"));
    // Malformed versions fail closed — they never satisfy the check. Anything
    // else would silently compare against 0.0.0 and disable the gate.
    assert!(!version_meets_minimum("3.6.1", "v4.0.0"));
    assert!(!version_meets_minimum("3.6.1", "4.0.x"));
    assert!(!version_meets_minimum("3.6.1", "4,0,0"));
    assert!(!version_meets_minimum("3.6.1", ""));
    assert!(!version_meets_minimum("garbage", "3.6.0"));
}

#[test]
fn test_extract_addon_zip_rejects_parent_traversal_path() {
    let zip_data = build_test_addon_zip(&[
        (
            "manifest.json",
            r#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"dist/addon.js"}"#,
        ),
        ("dist/addon.js", "console.log('ok');"),
        ("../evil.js", "console.log('bad');"),
    ]);

    let err = match extract_addon_zip_internal(zip_data) {
        Ok(_) => panic!("zip should be rejected"),
        Err(err) => err,
    };
    assert!(err.contains("Unsafe addon archive path"));
}

#[test]
fn test_extract_addon_zip_rejects_nested_parent_traversal_path() {
    let zip_data = build_test_addon_zip(&[
        (
            "manifest.json",
            r#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"dist/addon.js"}"#,
        ),
        ("dist/addon.js", "console.log('ok');"),
        ("dist/../../evil.js", "console.log('bad');"),
    ]);

    let err = match extract_addon_zip_internal(zip_data) {
        Ok(_) => panic!("zip should be rejected"),
        Err(err) => err,
    };
    assert!(err.contains("Unsafe addon archive path"));
}

#[test]
fn test_extract_addon_zip_rejects_absolute_path() {
    let zip_data = build_test_addon_zip(&[
        (
            "manifest.json",
            r#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"dist/addon.js"}"#,
        ),
        ("dist/addon.js", "console.log('ok');"),
        ("/tmp/evil.js", "console.log('bad');"),
    ]);

    let err = match extract_addon_zip_internal(zip_data) {
        Ok(_) => panic!("zip should be rejected"),
        Err(err) => err,
    };
    assert!(err.contains("Unsafe addon archive path"));
}

#[test]
fn test_extract_addon_zip_rejects_windows_drive_path() {
    let zip_data = build_test_addon_zip(&[
        (
            "manifest.json",
            r#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"dist/addon.js"}"#,
        ),
        ("dist/addon.js", "console.log('ok');"),
        ("C:/evil.js", "console.log('bad');"),
    ]);

    let err = match extract_addon_zip_internal(zip_data) {
        Ok(_) => panic!("zip should be rejected"),
        Err(err) => err,
    };
    assert!(err.contains("Unsafe addon archive path"));
}

#[test]
fn test_extract_addon_zip_accepts_valid_nested_paths() {
    let zip_data = build_test_addon_zip(&[
        (
            "manifest.json",
            r#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"dist/addon.js"}"#,
        ),
        ("dist/addon.js", "console.log('ok');"),
        ("dist/helpers/util.js", "export const value = 1;"),
    ]);

    let extracted = extract_addon_zip_internal(zip_data).expect("zip should extract");
    assert_eq!(extracted.metadata.id, "test-addon");
    assert!(
        extracted
            .files
            .iter()
            .any(|file| file.name == "dist/addon.js" && file.is_main),
        "main file should be preserved"
    );
    assert!(
        extracted
            .files
            .iter()
            .any(|file| file.name == "dist/helpers/util.js"),
        "nested helper file should be preserved"
    );
}

#[test]
fn test_validate_addon_id_rejects_traversal_and_reserved_names() {
    for addon_id in [
        "",
        ".",
        "..",
        "...",
        "../evil",
        "evil/path",
        "evil\\path",
        "Staging",
        "staging",
        "-starts-with-dash",
    ] {
        assert!(
            validate_addon_id(addon_id).is_err(),
            "addon id '{addon_id}' should be rejected"
        );
    }

    for addon_id in ["a", "test-addon", "addon_1", "addon.name"] {
        assert!(
            validate_addon_id(addon_id).is_ok(),
            "addon id '{addon_id}' should be accepted"
        );
    }
}

#[test]
fn test_parse_manifest_rejects_invalid_addon_id() {
    let err = parse_manifest_json_metadata(
        r#"{"id":"../../evil","name":"Evil","version":"1.0.0","main":"addon.js"}"#,
    )
    .expect_err("manifest id traversal should be rejected");

    assert!(err.contains("Invalid addon id"));
}

#[test]
fn test_extract_addon_zip_rejects_too_many_entries() {
    let mut entries = vec![
        (
            "manifest.json".to_string(),
            br#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"addon.js"}"#
                .to_vec(),
        ),
        ("addon.js".to_string(), b"console.log('ok');".to_vec()),
    ];
    for i in 0..256 {
        entries.push((format!("helpers/{i}.js"), b"export {};".to_vec()));
    }

    let err = match extract_addon_zip_internal(build_test_addon_zip_owned(entries)) {
        Ok(_) => panic!("zip with too many entries should be rejected"),
        Err(err) => err,
    };

    assert!(err.contains("too many entries"));
}

#[test]
fn test_extract_addon_zip_rejects_large_file() {
    let large_content = vec![b'a'; 5 * 1024 * 1024 + 1];
    let zip_data = build_test_addon_zip_owned(vec![
        (
            "manifest.json".to_string(),
            br#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"addon.js"}"#
                .to_vec(),
        ),
        ("addon.js".to_string(), large_content),
    ]);

    let err = match extract_addon_zip_internal(zip_data) {
        Ok(_) => panic!("zip with an oversized file should be rejected"),
        Err(err) => err,
    };

    assert!(err.contains("too large"));
}

#[test]
fn test_extract_addon_zip_skips_large_source_map() {
    let large_source_map = vec![b'a'; 5 * 1024 * 1024 + 1];
    let zip_data = build_test_addon_zip_owned(vec![
        (
            "manifest.json".to_string(),
            br#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"dist/addon.js"}"#
                .to_vec(),
        ),
        (
            "dist/addon.js".to_string(),
            b"export default function enable() {}".to_vec(),
        ),
        ("dist/addon.js.map".to_string(), large_source_map),
    ]);

    let extracted = extract_addon_zip_internal(zip_data)
        .expect("zip with an oversized source map should still extract");

    assert!(
        extracted
            .files
            .iter()
            .any(|file| file.name == "dist/addon.js"),
        "runtime JS should be preserved"
    );
    assert!(
        extracted
            .files
            .iter()
            .all(|file| !file.name.ends_with(".map")),
        "source maps should not be installed as runtime files"
    );
}

#[cfg(test)]
mod service_tests {
    use super::*;
    use crate::addons::addon_traits::AddonServiceTrait;
    use crate::addons::storage_repository::InMemoryAddonStorageRepository;
    use std::env;
    use std::sync::Arc;

    /// Build an `AddonService` for tests with a test-only in-memory storage
    /// repository (no DB required).
    fn test_addon_service(addons_root: impl Into<std::path::PathBuf>) -> AddonService {
        AddonService::new(
            addons_root,
            "test-instance",
            Arc::new(InMemoryAddonStorageRepository::default()),
        )
    }

    #[test]
    fn test_ensure_addons_directory_service() {
        // Test the service function ensure_addons_directory
        let temp_dir = env::temp_dir().join("wealthfolio_test_addons");
        let app_data_path = temp_dir.to_str().unwrap();

        // Clean up any existing test directory
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let result = ensure_addons_directory(app_data_path);
        assert!(result.is_ok(), "Failed to ensure addons directory");

        let addons_dir = result.unwrap();
        assert!(addons_dir.exists(), "Addons directory should exist");
        assert!(addons_dir.is_dir(), "Addons path should be a directory");
        assert_eq!(addons_dir.file_name().unwrap(), "addons");

        // Clean up
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_get_addon_path_service() {
        // Test the service function get_addon_path
        let temp_dir = env::temp_dir().join("wealthfolio_test_addon_path");
        let app_data_path = temp_dir.to_str().unwrap();

        // Clean up any existing test directory
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let result = get_addon_path(app_data_path, "test-addon");
        assert!(result.is_ok(), "Failed to get addon path");

        let addon_path = result.unwrap();
        assert_eq!(addon_path.file_name().unwrap(), "test-addon");

        // Verify the parent directory is the addons directory
        let parent = addon_path.parent().unwrap();
        assert_eq!(parent.file_name().unwrap(), "addons");

        // Clean up
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_addon_service_load_manifest() {
        // Test that AddonService can load an installed addo
        let temp_dir = env::temp_dir().join("wealthfolio_test_manifest_service");
        let app_data_path = temp_dir.to_str().unwrap();

        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let service = test_addon_service(app_data_path);

        // Create addon directory structure manually
        let addon_dir = temp_dir.join("addons").join("addon");
        std::fs::create_dir_all(&addon_dir).expect("Failed to create addon dir");

        let manifest_json = r#"{
            "id": "addon",
            "name": "Addon",
            "version": "1.0.0",
            "main": "addon.js",
            "permissions": [
                {
                    "category": "api",
                    "purpose": "Network calls",
                    "functions": ["fetch"]
                }
            ]
        }"#;

        std::fs::write(addon_dir.join("manifest.json"), manifest_json)
            .expect("Failed to write manifest");
        std::fs::write(addon_dir.join("addon.js"), "console.log('test')")
            .expect("Failed to write js");

        let installed = service
            .list_installed_addons()
            .expect("Failed to list installed addons");
        assert_eq!(installed.len(), 1, "AddonService should load the manifest");

        let permissions = installed[0].metadata.permissions.as_ref().unwrap();
        assert_eq!(permissions.len(), 1);
        assert_eq!(permissions[0].functions[0].name, "fetch");
        assert!(permissions[0].functions[0].is_declared);

        // Clean up
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_list_installed_addons_skips_and_cleans_replacement_artifacts() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_artifact_skip");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let service = test_addon_service(&temp_dir);
        let addons_dir = temp_dir.join("addons");
        let addon_dir = addons_dir.join("artifact-addon");
        let backup_dir = addons_dir.join(".artifact-addon.backup-test");
        let temp_install_dir = addons_dir.join(".artifact-addon.tmp-test");
        std::fs::create_dir_all(&addon_dir).expect("addon dir should be created");
        std::fs::create_dir_all(&backup_dir).expect("backup dir should be created");
        std::fs::create_dir_all(&temp_install_dir).expect("tmp dir should be created");

        let manifest_json = r#"{
            "id": "artifact-addon",
            "name": "Artifact Addon",
            "version": "1.0.0",
            "main": "addon.js",
            "enabled": true
        }"#;
        for dir in [&addon_dir, &backup_dir, &temp_install_dir] {
            std::fs::write(dir.join("manifest.json"), manifest_json)
                .expect("manifest should be written");
            std::fs::write(dir.join("addon.js"), "console.log('ok');")
                .expect("addon should be written");
        }

        let installed = service
            .list_installed_addons()
            .expect("installed addons should list");

        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].metadata.id, "artifact-addon");
        assert!(
            !backup_dir.exists(),
            "stale backup should be cleaned when canonical addon exists"
        );
        assert!(
            !temp_install_dir.exists(),
            "stale temp install dir should be cleaned when canonical addon exists"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_list_installed_addons_restores_backup_after_interrupted_replacement() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_artifact_restore");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let service = test_addon_service(&temp_dir);
        let addons_dir = temp_dir.join("addons");
        let addon_dir = addons_dir.join("recover-addon");
        let backup_dir = addons_dir.join(".recover-addon.backup-test");
        let temp_install_dir = addons_dir.join(".recover-addon.tmp-test");
        std::fs::create_dir_all(&backup_dir).expect("backup dir should be created");
        std::fs::create_dir_all(&temp_install_dir).expect("tmp dir should be created");

        let manifest_json = r#"{
            "id": "recover-addon",
            "name": "Recover Addon",
            "version": "1.0.0",
            "main": "addon.js",
            "enabled": true
        }"#;
        for dir in [&backup_dir, &temp_install_dir] {
            std::fs::write(dir.join("manifest.json"), manifest_json)
                .expect("manifest should be written");
            std::fs::write(dir.join("addon.js"), "console.log('ok');")
                .expect("addon should be written");
        }

        let installed = service
            .list_installed_addons()
            .expect("installed addons should recover backup");

        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].metadata.id, "recover-addon");
        assert!(
            addon_dir.exists(),
            "backup should be restored to canonical path"
        );
        assert!(!backup_dir.exists(), "restored backup dir should be gone");
        assert!(
            !temp_install_dir.exists(),
            "stale temp install dir should be cleaned after restore"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_legacy_manifest_id_addon_can_load_toggle_and_uninstall() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_legacy_addon_id");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let service = test_addon_service(&temp_dir);
        let addon_dir = temp_dir.join("addons").join("LegacyAddon");
        std::fs::create_dir_all(&addon_dir).expect("addon dir should be created");
        std::fs::write(
            addon_dir.join("manifest.json"),
            r#"{
                "id": "LegacyAddon",
                "name": "Legacy Addon",
                "version": "1.0.0",
                "main": "addon.js",
                "enabled": true
            }"#,
        )
        .expect("manifest should be written");
        std::fs::write(
            addon_dir.join("addon.js"),
            "export default function enable() {}",
        )
        .expect("addon should be written");

        let loaded = service
            .load_addon_for_runtime("LegacyAddon")
            .expect("legacy installed addon should load by manifest id");
        assert_eq!(loaded.metadata.id, "LegacyAddon");

        service
            .toggle_addon("LegacyAddon", false)
            .expect("legacy installed addon should toggle");
        let manifest: AddonManifest = serde_json::from_str(
            &std::fs::read_to_string(addon_dir.join("manifest.json"))
                .expect("manifest should still be readable"),
        )
        .expect("manifest should parse");
        assert_eq!(manifest.enabled, Some(false));

        service
            .uninstall_addon("LegacyAddon")
            .await
            .expect("legacy installed addon should uninstall");
        assert!(
            !addon_dir.exists(),
            "legacy addon directory should be removed"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_install_addon_zip_rejects_unsafe_paths_without_writing_files() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_addon_zip_traversal");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let zip_data = build_test_addon_zip(&[
            (
                "manifest.json",
                r#"{"id":"test-addon","name":"Test Addon","version":"1.0.0","main":"dist/addon.js"}"#,
            ),
            ("dist/addon.js", "console.log('ok');"),
            ("../evil.js", "console.log('bad');"),
        ]);

        let service = test_addon_service(&temp_dir);
        let result = service.install_addon_zip(zip_data, true, vec![]).await;
        let addon_dir = temp_dir.join("addons").join("test-addon");

        assert!(result.is_err(), "unsafe zip install should fail");
        assert!(
            result
                .err()
                .unwrap_or_default()
                .contains("Unsafe addon archive path"),
            "install should fail with unsafe path error"
        );
        assert!(
            !addon_dir.exists(),
            "addon directory should not be populated on failed install"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_install_addon_zip_rejects_malicious_manifest_id() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_addon_id_traversal");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let zip_data = build_test_addon_zip(&[
            (
                "manifest.json",
                r#"{"id":"../../evil","name":"Evil","version":"1.0.0","main":"addon.js"}"#,
            ),
            ("addon.js", "console.log('bad');"),
        ]);

        let service = test_addon_service(&temp_dir);
        let result = service.install_addon_zip(zip_data, true, vec![]).await;

        assert!(result.is_err(), "malicious manifest id should fail install");
        assert!(
            !temp_dir.join("evil").exists(),
            "install must not write outside the addon root"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_install_addon_zip_rejects_too_new_min_wealthfolio_version() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_min_version_reject");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let zip_data = build_test_addon_zip(&[
            (
                "manifest.json",
                r#"{
                    "id":"future-addon",
                    "name":"Future Addon",
                    "version":"1.0.0",
                    "main":"addon.js",
                    "minWealthfolioVersion":"999.0.0"
                }"#,
            ),
            ("addon.js", "console.log('ok');"),
        ]);

        let service = test_addon_service(&temp_dir);
        let result = service.install_addon_zip(zip_data, true, vec![]).await;
        let addon_dir = temp_dir.join("addons").join("future-addon");

        assert!(
            result.is_err(),
            "install should be rejected when host is older than minWealthfolioVersion"
        );
        assert!(
            result.unwrap_err().contains("requires Wealthfolio"),
            "error should explain the version requirement"
        );
        assert!(
            !addon_dir.exists(),
            "addon directory should not be created on rejected install"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_install_addon_zip_rejects_malformed_min_wealthfolio_version() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_min_version_malformed");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        // "v4.0.0" used to parse as 0.0.0, silently disabling the version gate
        // and letting the addon install on an incompatible host.
        let zip_data = build_test_addon_zip(&[
            (
                "manifest.json",
                r#"{
                    "id":"typo-addon",
                    "name":"Typo Addon",
                    "version":"1.0.0",
                    "main":"addon.js",
                    "minWealthfolioVersion":"v999.0.0"
                }"#,
            ),
            ("addon.js", "console.log('ok');"),
        ]);

        let service = test_addon_service(&temp_dir);
        let result = service.install_addon_zip(zip_data, true, vec![]).await;

        assert!(
            result.is_err(),
            "install should be rejected when minWealthfolioVersion is malformed"
        );
        assert!(
            result
                .unwrap_err()
                .contains("Invalid 'minWealthfolioVersion'"),
            "error should point at the malformed manifest value"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_install_addon_zip_accepts_satisfied_min_wealthfolio_version() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_min_version_accept");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let zip_data = build_test_addon_zip(&[
            (
                "manifest.json",
                r#"{
                    "id":"compatible-addon",
                    "name":"Compatible Addon",
                    "version":"1.0.0",
                    "main":"addon.js",
                    "minWealthfolioVersion":"1.0.0"
                }"#,
            ),
            ("addon.js", "console.log('ok');"),
        ]);

        let service = test_addon_service(&temp_dir);
        let result = service.install_addon_zip(zip_data, true, vec![]).await;

        assert!(
            result.is_ok(),
            "install should succeed when host satisfies minWealthfolioVersion: {:?}",
            result.err()
        );
        assert!(
            temp_dir.join("addons").join("compatible-addon").exists(),
            "addon directory should be created on accepted install"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_toggle_addon_enable_rejects_too_new_min_wealthfolio_version() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_min_version_toggle");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let service = test_addon_service(&temp_dir);
        let addon_dir = temp_dir.join("addons").join("future-toggle-addon");
        std::fs::create_dir_all(&addon_dir).expect("addon dir should be created");
        std::fs::write(
            addon_dir.join("manifest.json"),
            r#"{
                "id":"future-toggle-addon",
                "name":"Future Toggle Addon",
                "version":"1.0.0",
                "main":"addon.js",
                "enabled":false,
                "minWealthfolioVersion":"999.0.0"
            }"#,
        )
        .expect("manifest should be written");
        std::fs::write(addon_dir.join("addon.js"), "console.log('ok');")
            .expect("addon should be written");

        // Enabling a too-new addon is rejected...
        let enable = service.toggle_addon("future-toggle-addon", true);
        assert!(
            enable.is_err(),
            "enabling should be rejected for too-new minWealthfolioVersion"
        );
        assert!(enable.unwrap_err().contains("requires Wealthfolio"));

        // ...but disabling is always allowed.
        assert!(
            service.toggle_addon("future-toggle-addon", false).is_ok(),
            "disabling should never be blocked by minWealthfolioVersion"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_install_addon_zip_persists_only_approved_network_hosts() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_addon_network_approvals");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let zip_data = build_test_addon_zip(&[
            (
                "manifest.json",
                r#"{
                    "id":"network-addon",
                    "name":"Network Addon",
                    "version":"1.0.0",
                    "main":"addon.js",
                    "network": {
                        "allowedHosts": ["api.example.com", "quotes.example.com"]
                    }
                }"#,
            ),
            ("addon.js", "console.log('ok');"),
        ]);

        let service = test_addon_service(&temp_dir);
        let manifest = service
            .install_addon_zip(
                zip_data,
                true,
                vec![
                    "api.example.com".to_string(),
                    "unrequested.example.com".to_string(),
                ],
            )
            .await
            .expect("network addon should install");

        let network = manifest
            .network
            .expect("network policy should be preserved");
        assert_eq!(network.allowed_hosts.len(), 2);
        assert_eq!(network.approved_hosts, vec!["api.example.com".to_string()]);

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_update_addon_network_approvals_persists_only_allowed_hosts() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_update_addon_network_approvals");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let zip_data = build_test_addon_zip(&[
            (
                "manifest.json",
                r#"{
                    "id":"network-addon",
                    "name":"Network Addon",
                    "version":"1.0.0",
                    "main":"addon.js",
                    "network": {
                        "allowedHosts": ["api.example.com", "quotes.example.com"]
                    }
                }"#,
            ),
            ("addon.js", "console.log('ok');"),
        ]);

        let service = test_addon_service(&temp_dir);
        service
            .install_addon_zip(zip_data, true, vec![])
            .await
            .expect("network addon should install");

        let manifest = service
            .update_addon_network_approvals(
                "network-addon",
                vec![
                    "QUOTES.EXAMPLE.COM.".to_string(),
                    "api.example.com".to_string(),
                    "unrequested.example.com".to_string(),
                ],
            )
            .expect("network approvals should update");

        let network = manifest
            .network
            .expect("network policy should be preserved");
        assert_eq!(
            network.approved_hosts,
            vec![
                "api.example.com".to_string(),
                "quotes.example.com".to_string(),
            ]
        );

        let installed = service
            .list_installed_addons()
            .expect("installed addons should list");
        let persisted_network = installed[0]
            .metadata
            .network
            .as_ref()
            .expect("persisted network policy should exist");
        assert_eq!(persisted_network.approved_hosts, network.approved_hosts);

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_network_auth_requires_secrets_use_permission() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_network_auth_permission");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let addon_dir = temp_dir.join("addons").join("network-addon");
        std::fs::create_dir_all(&addon_dir).expect("addon dir should be created");
        std::fs::write(
            addon_dir.join("manifest.json"),
            r#"{
                "id":"network-addon",
                "name":"Network Addon",
                "version":"1.0.0",
                "main":"addon.js",
                "enabled": true,
                "permissions": [
                    {
                        "category":"network",
                        "purpose":"Network access",
                        "functions":[{"name":"request","isDeclared":true,"isDetected":false}]
                    }
                ],
                "network": {
                    "allowedHosts": ["api.example.com"],
                    "approvedHosts": ["api.example.com"]
                }
            }"#,
        )
        .expect("manifest should be written");
        std::fs::write(addon_dir.join("addon.js"), "console.log('ok');")
            .expect("addon should be written");

        let service = test_addon_service(&temp_dir);
        let result = service
            .addon_network_request(
                "network-addon",
                AddonNetworkRequest {
                    url: "https://api.example.com/v1".to_string(),
                    method: Some("GET".to_string()),
                    headers: None,
                    body: None,
                    auth: Some(AddonNetworkAuth {
                        auth_type: "bearer".to_string(),
                        secret_key: "api-token".to_string(),
                    }),
                    injected_authorization: Some("Bearer secret-token".to_string()),
                },
            )
            .await;

        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("not allowed to use network auth"));

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_network_auth_rejects_detected_only_secrets_use_permission() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_detected_only_network_auth");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let addon_dir = temp_dir.join("addons").join("network-addon");
        std::fs::create_dir_all(&addon_dir).expect("addon dir should be created");
        std::fs::write(
            addon_dir.join("manifest.json"),
            r#"{
                "id":"network-addon",
                "name":"Network Addon",
                "version":"1.0.0",
                "main":"addon.js",
                "enabled": true,
                "permissions": [
                    {
                        "category":"network",
                        "purpose":"Network access",
                        "functions":[{"name":"request","isDeclared":true,"isDetected":false}]
                    },
                    {
                        "category":"secrets",
                        "purpose":"Secrets access",
                        "functions":[{"name":"use","isDeclared":false,"isDetected":true}]
                    }
                ],
                "network": {
                    "allowedHosts": ["api.example.com"],
                    "approvedHosts": ["api.example.com"]
                }
            }"#,
        )
        .expect("manifest should be written");
        std::fs::write(addon_dir.join("addon.js"), "console.log('ok');")
            .expect("addon should be written");

        let service = test_addon_service(&temp_dir);
        let result = service
            .addon_network_request(
                "network-addon",
                AddonNetworkRequest {
                    url: "https://api.example.com/v1".to_string(),
                    method: Some("GET".to_string()),
                    headers: None,
                    body: None,
                    auth: Some(AddonNetworkAuth {
                        auth_type: "bearer".to_string(),
                        secret_key: "api-token".to_string(),
                    }),
                    injected_authorization: Some("Bearer secret-token".to_string()),
                },
            )
            .await;

        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("not allowed to use network auth"));

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_install_and_runtime_load_allow_binary_assets() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_binary_addon_asset");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let zip_data = build_test_addon_zip_owned(vec![
            (
                "manifest.json".to_string(),
                br#"{"id":"binary-addon","name":"Binary Addon","version":"1.0.0","main":"addon.js"}"#
                    .to_vec(),
            ),
            (
                "addon.js".to_string(),
                b"export default function enable() {}".to_vec(),
            ),
            ("assets/icon.bin".to_string(), vec![0, 159, 146, 150]),
        ]);

        let service = test_addon_service(&temp_dir);
        service
            .install_addon_zip(zip_data, true, vec![])
            .await
            .expect("binary asset addon should install");

        let loaded = service
            .load_addon_for_runtime("binary-addon")
            .expect("runtime load should skip binary assets and keep JS");

        assert!(
            loaded
                .files
                .iter()
                .any(|file| file.name == "addon.js" && file.is_main),
            "main JS file should still be available at runtime"
        );
        assert!(
            temp_dir
                .join("addons")
                .join("binary-addon")
                .join("assets")
                .join("icon.bin")
                .exists(),
            "binary asset should be written to disk"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_install_from_staging_rejects_manifest_id_mismatch() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_staging_id_mismatch");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let zip_data = build_test_addon_zip(&[
            (
                "manifest.json",
                r#"{"id":"actual-addon","name":"Actual","version":"1.0.0","main":"addon.js"}"#,
            ),
            ("addon.js", "console.log('ok');"),
        ]);

        save_addon_to_staging("requested-addon", &temp_dir, &zip_data)
            .expect("staging should save requested id");

        let service = test_addon_service(&temp_dir);
        let result = service
            .install_addon_from_staging("requested-addon", true, vec![])
            .await;

        assert!(result.is_err(), "staging id mismatch should fail");
        assert!(
            !temp_dir
                .join("addons")
                .join("staging")
                .join("requested-addon.zip")
                .exists(),
            "mismatched staged zip should be removed"
        );
        assert!(
            !temp_dir.join("addons").join("actual-addon").exists(),
            "mismatched addon should not be installed"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_addon_storage_set_get_delete_roundtrip() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_addon_storage_roundtrip");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let service = test_addon_service(&temp_dir);

        assert_eq!(
            service
                .get_addon_storage_item("storage-addon", "prefs")
                .await
                .expect("get on empty storage should succeed"),
            None
        );

        service
            .set_addon_storage_item("storage-addon", "prefs", "{\"theme\":\"dark\"}")
            .await
            .expect("set should succeed");
        assert_eq!(
            service
                .get_addon_storage_item("storage-addon", "prefs")
                .await
                .expect("get should succeed")
                .as_deref(),
            Some("{\"theme\":\"dark\"}")
        );

        service
            .set_addon_storage_item("storage-addon", "prefs", "v2")
            .await
            .expect("overwrite should succeed");
        assert_eq!(
            service
                .get_addon_storage_item("storage-addon", "prefs")
                .await
                .expect("get should succeed")
                .as_deref(),
            Some("v2")
        );

        service
            .set_addon_storage_item("storage-addon", "other", "x")
            .await
            .expect("set should succeed");
        assert_eq!(
            service
                .get_addon_storage_item("another-addon", "prefs")
                .await
                .expect("get for other addon should succeed"),
            None,
            "storage must be namespaced per addon"
        );

        service
            .delete_addon_storage_item("storage-addon", "prefs")
            .await
            .expect("delete should succeed");
        assert_eq!(
            service
                .get_addon_storage_item("storage-addon", "prefs")
                .await
                .expect("get should succeed"),
            None
        );

        service
            .clear_addon_storage("storage-addon")
            .await
            .expect("clear should succeed");
        assert_eq!(
            service
                .get_addon_storage_item("storage-addon", "other")
                .await
                .expect("get should succeed"),
            None
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_addon_storage_rejects_invalid_ids_and_keys() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_addon_storage_validation");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let service = test_addon_service(&temp_dir);

        assert!(
            service
                .set_addon_storage_item("../escape", "key", "value")
                .await
                .is_err(),
            "path-traversal addon ids must be rejected"
        );
        assert!(
            service
                .set_addon_storage_item("addon", "", "value")
                .await
                .is_err(),
            "empty keys must be rejected"
        );
        assert!(
            service
                .set_addon_storage_item("addon", &"k".repeat(200), "value")
                .await
                .is_err(),
            "oversized keys must be rejected"
        );
        assert!(
            service
                .set_addon_storage_item("addon", "key", &"v".repeat(2 * 1024 * 1024))
                .await
                .is_err(),
            "oversized value must be rejected"
        );
        // Keys must stay within the sync-safe charset so they can never produce
        // an entity id the sync server rejects.
        for bad_key in ["my key", "a/b", "café", "emoji😀"] {
            assert!(
                service
                    .set_addon_storage_item("addon", bad_key, "value")
                    .await
                    .is_err(),
                "key with disallowed characters must be rejected: {bad_key:?}"
            );
        }
        // The full sync-safe charset (letters, digits, `_ . : -`) is accepted.
        assert!(
            service
                .set_addon_storage_item("addon", "swing.prefs_v2:section-1", "value")
                .await
                .is_ok(),
            "keys within the allowed charset must be accepted"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_addon_storage_value_bounded_by_serialized_sync_payload() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_addon_storage_payload_cap");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }
        let service = test_addon_service(&temp_dir);

        // A comfortably-sized value serializes well under the cap and is accepted.
        assert!(
            service
                .set_addon_storage_item("addon", "ok", &"a".repeat(240_000))
                .await
                .is_ok(),
            "a value under the sync payload cap must be accepted"
        );

        // A plain value over the cap is rejected with an actionable message.
        let err = service
            .set_addon_storage_item("addon", "big", &"a".repeat(260_000))
            .await
            .expect_err("value over the sync payload cap must be rejected");
        assert!(err.contains("too large"), "unexpected error: {err}");

        // Escaping matters: 200k raw bytes of `"` is under a naive raw-byte cap,
        // but JSON-escapes to ~400k chars in the serialized payload — the exact
        // plaintext that gets encrypted and pushed — so it must be rejected.
        assert!(
            service
                .set_addon_storage_item("addon", "escaped", &"\"".repeat(200_000))
                .await
                .is_err(),
            "a value whose JSON-escaped form exceeds the cap must be rejected"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[tokio::test]
    async fn test_addon_storage_survives_reinstall_and_removed_on_uninstall() {
        let temp_dir = env::temp_dir().join("wealthfolio_test_addon_storage_lifecycle");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).ok();
        }

        let service = test_addon_service(&temp_dir);

        let manifest =
            r#"{"id":"lifecycle-addon","name":"Lifecycle","version":"1.0.0","main":"addon.js"}"#;
        let zip_data =
            build_test_addon_zip(&[("manifest.json", manifest), ("addon.js", "console.log(1);")]);

        service
            .install_addon_zip(zip_data.clone(), true, vec![])
            .await
            .expect("install should succeed");

        service
            .set_addon_storage_item("lifecycle-addon", "prefs", "keep-me")
            .await
            .expect("set should succeed");
        assert!(
            !temp_dir
                .join("addons")
                .join("lifecycle-addon")
                .join(".storage")
                .exists(),
            "storage must not live inside the addon directory"
        );

        // Reinstall (what an update does: the addon dir is replaced).
        service
            .install_addon_zip(zip_data, true, vec![])
            .await
            .expect("reinstall should succeed");
        assert_eq!(
            service
                .get_addon_storage_item("lifecycle-addon", "prefs")
                .await
                .expect("get should succeed")
                .as_deref(),
            Some("keep-me"),
            "storage must survive addon reinstall/update"
        );

        service
            .uninstall_addon("lifecycle-addon")
            .await
            .expect("uninstall should succeed");
        assert_eq!(
            service
                .get_addon_storage_item("lifecycle-addon", "prefs")
                .await
                .expect("get should succeed"),
            None,
            "uninstall must clear addon storage"
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
