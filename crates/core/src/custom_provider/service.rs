use std::fmt::Write;
use std::sync::Arc;

use log::info;

use crate::errors::{Result, ValidationError};
use crate::secrets::SecretStore;

use super::model::*;
use super::store::CustomProviderRepository;

/// Reserved codes that cannot be used for custom providers.
const RESERVED_CODES: &[&str] = &[
    "yahoo",
    "alpha_vantage",
    "marketdata_app",
    "metal_price_api",
    "finnhub",
    "openfigi",
    "us_treasury_calc",
    "boerse_frankfurt",
    "custom_scraper",
    "manual",
    "broker",
];

pub struct CustomProviderService {
    repo: Arc<dyn CustomProviderRepository>,
    secret_store: Arc<dyn SecretStore>,
}

impl CustomProviderService {
    pub fn new(
        repo: Arc<dyn CustomProviderRepository>,
        secret_store: Arc<dyn SecretStore>,
    ) -> Self {
        Self { repo, secret_store }
    }

    /// List all custom providers with their sources.
    pub fn get_all(&self) -> Result<Vec<CustomProviderWithSources>> {
        self.repo.get_all()
    }

    /// Create a new custom provider.
    pub async fn create(&self, payload: NewCustomProvider) -> Result<CustomProviderWithSources> {
        let code = payload.code.trim().to_lowercase();
        if code.is_empty() {
            return Err(ValidationError::InvalidInput("Code cannot be empty".into()).into());
        }
        if !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(ValidationError::InvalidInput(
                "Code must contain only lowercase letters, numbers, and hyphens".into(),
            )
            .into());
        }
        if RESERVED_CODES.contains(&code.as_str()) {
            return Err(
                ValidationError::InvalidInput(format!("Code '{}' is reserved", code)).into(),
            );
        }

        for src in &payload.sources {
            validate_source_kind_format(&src.kind, &src.format)?;
        }

        let normalized = NewCustomProvider {
            code,
            name: payload.name,
            description: payload.description,
            priority: payload.priority,
            sources: payload.sources,
        };

        let created = self.repo.create(&normalized).await?;
        info!("Created custom provider: {}", created.id);
        Ok(created)
    }

    /// Update an existing custom provider.
    pub async fn update(
        &self,
        provider_id: &str,
        payload: UpdateCustomProvider,
    ) -> Result<CustomProviderWithSources> {
        if let Some(sources) = &payload.sources {
            for src in sources {
                validate_source_kind_format(&src.kind, &src.format)?;
            }
        }

        let updated = self.repo.update(provider_id, &payload).await?;
        info!("Updated custom provider: {}", provider_id);
        Ok(updated)
    }

    /// Delete a custom provider. Fails if it is not a user-created provider or assets reference it.
    pub async fn delete(&self, provider_id: &str) -> Result<()> {
        // Only allow deleting providers that actually belong to the user
        let exists = self
            .repo
            .get_all()?
            .into_iter()
            .any(|p| p.id == provider_id);
        if !exists {
            return Err(ValidationError::InvalidInput(format!(
                "Provider '{}' not found or is not a custom provider.",
                provider_id
            ))
            .into());
        }
        let asset_count = self.repo.get_asset_count_for_provider(provider_id)?;
        if asset_count > 0 {
            return Err(ValidationError::InvalidInput(format!(
                "Cannot delete '{}': {} asset(s) still use it as preferred provider. \
                 Change their preferred provider first, then try again.",
                provider_id, asset_count
            ))
            .into());
        }
        self.repo.delete(provider_id).await?;
        info!("Deleted custom provider: {}", provider_id);
        Ok(())
    }

    /// Test a source configuration by fetching and extracting a price.
    pub async fn test_source(&self, payload: TestSourceRequest) -> Result<TestSourceResult> {
        let currency = payload.currency.as_deref().unwrap_or("usd");
        let tctx = TemplateContext {
            symbol: &payload.symbol,
            currency,
            isin: None,
            mic: None,
            from: payload.from.as_deref(),
            to: payload.to.as_deref(),
        };
        let url = expand_template(&payload.url, &tctx);

        validate_url(&url).map_err(|e| crate::Error::Unexpected(e.to_string()))?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(CUSTOM_PROVIDER_USER_AGENT)
            .build()
            .map_err(|e| crate::Error::Unexpected(format!("HTTP client error: {}", e)))?;

        // Default browser-like headers. Many data APIs sit behind bot-protection
        // (Akamai/Cloudflare) that serves placebo responses to clients lacking the
        // typical browser header set. User-supplied headers below override these.
        let mut headers = build_browser_like_headers(&payload.format, &url);

        if let Some(headers_json) = &payload.headers {
            if let Ok(map) =
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(headers_json)
            {
                for (k, v) in map {
                    if let Some(val_str) = v.as_str() {
                        let resolved = if let Some(key) = val_str.strip_prefix("__SECRET__") {
                            self.secret_store
                                .get_secret(key)
                                .ok()
                                .flatten()
                                .ok_or_else(|| {
                                    crate::Error::Unexpected(format!("Secret '{}' not found", key))
                                })?
                        } else {
                            val_str.to_string()
                        };
                        if let (Ok(name), Ok(value)) = (
                            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                            reqwest::header::HeaderValue::from_str(&resolved),
                        ) {
                            headers.insert(name, value);
                        }
                    }
                }
            }
        }

        let response = match client.get(&url).headers(headers).send().await {
            Ok(resp) => resp,
            Err(e) => {
                return Ok(TestSourceResult {
                    success: false,
                    price: None,
                    currency: None,
                    date: None,
                    error: Some(format!("HTTP request failed: {}", e)),
                    raw_response: None,
                    detected_elements: None,
                    detected_tables: None,
                    ..Default::default()
                });
            }
        };

        let status = response.status();
        if let Some(len) = response.content_length() {
            if len > MAX_RESPONSE_BYTES as u64 {
                return Ok(TestSourceResult {
                    success: false,
                    status_code: Some(status.as_u16()),
                    price: None,
                    currency: None,
                    date: None,
                    error: Some(format!(
                        "Response body too large ({} bytes, max {})",
                        len, MAX_RESPONSE_BYTES
                    )),
                    raw_response: None,
                    detected_elements: None,
                    detected_tables: None,
                    ..Default::default()
                });
            }
        }
        let body_bytes = match response.bytes().await {
            Ok(b) => b,
            Err(e) => {
                return Ok(TestSourceResult {
                    success: false,
                    status_code: Some(status.as_u16()),
                    price: None,
                    currency: None,
                    date: None,
                    error: Some(format!("Failed to read response body: {}", e)),
                    raw_response: None,
                    detected_elements: None,
                    detected_tables: None,
                    ..Default::default()
                });
            }
        };
        if body_bytes.len() > MAX_RESPONSE_BYTES {
            return Ok(TestSourceResult {
                success: false,
                status_code: Some(status.as_u16()),
                price: None,
                currency: None,
                date: None,
                error: Some(format!(
                    "Response body too large ({} bytes, max {})",
                    body_bytes.len(),
                    MAX_RESPONSE_BYTES
                )),
                raw_response: None,
                detected_elements: None,
                detected_tables: None,
                ..Default::default()
            });
        }
        let body = String::from_utf8_lossy(&body_bytes).to_string();

        if !status.is_success() {
            return Ok(TestSourceResult {
                success: false,
                status_code: Some(status.as_u16()),
                price: None,
                currency: None,
                date: None,
                error: Some(format!("HTTP {}: {}", status, &body[..body.len().min(500)])),
                raw_response: Some(body),
                detected_elements: None,
                detected_tables: None,
                ..Default::default()
            });
        }

        let expand_path = |p: &str| -> String { expand_template(p, &tctx) };

        match payload.format.as_str() {
            "json" => {
                let price_path = expand_path(&payload.price_path);
                let price = extract_json_value(&body, &price_path);
                let currency = payload
                    .currency_path
                    .as_ref()
                    .map(|cp| expand_path(cp))
                    .and_then(|cp| extract_json_string(&body, &cp));
                let date = payload
                    .date_path
                    .as_ref()
                    .map(|dp| expand_path(dp))
                    .and_then(|dp| extract_json_string(&body, &dp));
                let open = payload
                    .open_path
                    .as_ref()
                    .map(|op| expand_path(op))
                    .and_then(|op| extract_json_value(&body, &op))
                    .map(|v| apply_test_factor_invert(v, &payload));
                let high = payload
                    .high_path
                    .as_ref()
                    .map(|hp| expand_path(hp))
                    .and_then(|hp| extract_json_value(&body, &hp))
                    .map(|v| apply_test_factor_invert(v, &payload));
                let low = payload
                    .low_path
                    .as_ref()
                    .map(|lp| expand_path(lp))
                    .and_then(|lp| extract_json_value(&body, &lp))
                    .map(|v| apply_test_factor_invert(v, &payload));
                let volume = payload
                    .volume_path
                    .as_ref()
                    .map(|vp| expand_path(vp))
                    .and_then(|vp| extract_json_value(&body, &vp));

                match price {
                    Some(p) => {
                        let p = apply_test_factor_invert(p, &payload);
                        Ok(TestSourceResult {
                            success: true,
                            status_code: Some(status.as_u16()),
                            price: Some(p),
                            open,
                            high,
                            low,
                            volume,
                            currency,
                            date,
                            error: None,
                            raw_response: Some(body),
                            detected_elements: None,
                            detected_tables: None,
                        })
                    }
                    None => Ok(TestSourceResult {
                        success: false,
                        status_code: Some(status.as_u16()),
                        price: None,
                        currency: None,
                        date: None,
                        error: Some(format!(
                            "Could not extract price using path '{}'",
                            price_path
                        )),
                        raw_response: Some(body),
                        detected_elements: None,
                        detected_tables: None,
                        ..Default::default()
                    }),
                }
            }
            "html" => {
                let detected = detect_html_elements(&body, payload.locale.as_deref());
                let price =
                    extract_html_value(&body, &payload.price_path, payload.locale.as_deref());
                let high = payload
                    .high_path
                    .as_ref()
                    .and_then(|p| extract_html_value(&body, p, payload.locale.as_deref()))
                    .map(|v| apply_test_factor_invert(v, &payload));
                let low = payload
                    .low_path
                    .as_ref()
                    .and_then(|p| extract_html_value(&body, p, payload.locale.as_deref()))
                    .map(|v| apply_test_factor_invert(v, &payload));
                let volume = payload
                    .volume_path
                    .as_ref()
                    .and_then(|p| extract_html_value(&body, p, payload.locale.as_deref()));
                match price {
                    Some(p) => {
                        let p = apply_test_factor_invert(p, &payload);
                        Ok(TestSourceResult {
                            success: true,
                            status_code: Some(status.as_u16()),
                            price: Some(p),
                            high,
                            low,
                            volume,
                            currency: None,
                            date: None,
                            error: None,
                            raw_response: None,
                            detected_elements: Some(detected),
                            detected_tables: None,
                            ..Default::default()
                        })
                    }
                    None => Ok(TestSourceResult {
                        success: false,
                        status_code: Some(status.as_u16()),
                        price: None,
                        currency: None,
                        date: None,
                        error: Some(format!(
                            "Could not extract price using CSS selector '{}'",
                            payload.price_path
                        )),
                        raw_response: None,
                        detected_elements: Some(detected),
                        detected_tables: None,
                        ..Default::default()
                    }),
                }
            }
            "html_table" => {
                let tables = detect_html_tables(&body);
                let price = if !payload.price_path.is_empty() {
                    extract_table_value(&body, &payload.price_path, payload.locale.as_deref())
                } else {
                    None
                };
                let date = payload
                    .date_path
                    .as_ref()
                    .filter(|dp| !dp.is_empty())
                    .and_then(|dp| extract_table_string(&body, dp));
                let open = payload
                    .open_path
                    .as_ref()
                    .filter(|p| !p.is_empty())
                    .and_then(|p| extract_table_value(&body, p, payload.locale.as_deref()))
                    .map(|v| apply_test_factor_invert(v, &payload));
                let high = payload
                    .high_path
                    .as_ref()
                    .filter(|p| !p.is_empty())
                    .and_then(|p| extract_table_value(&body, p, payload.locale.as_deref()))
                    .map(|v| apply_test_factor_invert(v, &payload));
                let low = payload
                    .low_path
                    .as_ref()
                    .filter(|p| !p.is_empty())
                    .and_then(|p| extract_table_value(&body, p, payload.locale.as_deref()))
                    .map(|v| apply_test_factor_invert(v, &payload));
                let volume = payload
                    .volume_path
                    .as_ref()
                    .filter(|p| !p.is_empty())
                    .and_then(|p| extract_table_value(&body, p, payload.locale.as_deref()));

                match price {
                    Some(p) => {
                        let p = apply_test_factor_invert(p, &payload);
                        Ok(TestSourceResult {
                            success: true,
                            status_code: Some(status.as_u16()),
                            price: Some(p),
                            open,
                            high,
                            low,
                            volume,
                            currency: None,
                            date,
                            error: None,
                            raw_response: None,
                            detected_elements: None,
                            detected_tables: Some(tables),
                        })
                    }
                    None => Ok(TestSourceResult {
                        success: !tables.is_empty(),
                        status_code: Some(status.as_u16()),
                        price: None,
                        currency: None,
                        date: None,
                        error: if tables.is_empty() {
                            Some("No HTML tables found on page".to_string())
                        } else {
                            None
                        },
                        raw_response: None,
                        detected_elements: None,
                        detected_tables: Some(tables),
                        ..Default::default()
                    }),
                }
            }
            "csv" => match parse_csv_test(&body, &payload.price_path, payload.locale.as_deref()) {
                Some(p) => {
                    let p = apply_test_factor_invert(p, &payload);
                    let date = payload
                        .date_path
                        .as_ref()
                        .filter(|dp| !dp.is_empty())
                        .and_then(|dp| extract_csv_string(&body, dp));
                    let open = payload
                        .open_path
                        .as_ref()
                        .filter(|p| !p.is_empty())
                        .and_then(|p| parse_csv_test(&body, p, payload.locale.as_deref()))
                        .map(|v| apply_test_factor_invert(v, &payload));
                    let high = payload
                        .high_path
                        .as_ref()
                        .filter(|p| !p.is_empty())
                        .and_then(|p| parse_csv_test(&body, p, payload.locale.as_deref()))
                        .map(|v| apply_test_factor_invert(v, &payload));
                    let low = payload
                        .low_path
                        .as_ref()
                        .filter(|p| !p.is_empty())
                        .and_then(|p| parse_csv_test(&body, p, payload.locale.as_deref()))
                        .map(|v| apply_test_factor_invert(v, &payload));
                    let volume = payload
                        .volume_path
                        .as_ref()
                        .filter(|p| !p.is_empty())
                        .and_then(|p| parse_csv_test(&body, p, payload.locale.as_deref()));
                    Ok(TestSourceResult {
                        success: true,
                        status_code: Some(status.as_u16()),
                        price: Some(p),
                        open,
                        high,
                        low,
                        volume,
                        currency: None,
                        date,
                        error: None,
                        raw_response: Some(body),
                        detected_elements: None,
                        detected_tables: None,
                    })
                }
                None => Ok(TestSourceResult {
                    success: false,
                    status_code: Some(status.as_u16()),
                    price: None,
                    currency: None,
                    date: None,
                    error: Some(format!(
                        "Could not extract price from CSV using column '{}'",
                        payload.price_path
                    )),
                    raw_response: Some(body),
                    detected_elements: None,
                    detected_tables: None,
                    ..Default::default()
                }),
            },
            _ => Ok(TestSourceResult {
                success: false,
                status_code: Some(status.as_u16()),
                price: None,
                currency: None,
                date: None,
                error: Some(format!("Unsupported format: {}", payload.format)),
                raw_response: None,
                detected_elements: None,
                detected_tables: None,
                ..Default::default()
            }),
        }
    }
}

/// Validate that a source's `kind` and `format` are recognized values.
fn validate_source_kind_format(kind: &str, format: &str) -> crate::errors::Result<()> {
    if !VALID_SOURCE_KINDS.contains(&kind) {
        return Err(ValidationError::InvalidInput(format!(
            "Invalid source kind '{}'. Must be one of: {}",
            kind,
            VALID_SOURCE_KINDS.join(", ")
        ))
        .into());
    }
    if !VALID_SOURCE_FORMATS.contains(&format) {
        return Err(ValidationError::InvalidInput(format!(
            "Invalid source format '{}'. Must be one of: {}",
            format,
            VALID_SOURCE_FORMATS.join(", ")
        ))
        .into());
    }
    Ok(())
}

fn apply_test_factor_invert(mut value: f64, payload: &TestSourceRequest) -> f64 {
    if let Some(factor) = payload.factor {
        value *= factor;
    }
    if payload.invert == Some(true) && value != 0.0 {
        value = 1.0 / value;
    }
    value
}

/// Extract a numeric value from JSON using a JSONPath expression.
fn extract_json_value(body: &str, path: &str) -> Option<f64> {
    use jsonpath_rust::JsonPathQuery;
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let result = json.path(path).ok()?;
    // path() returns a Value::Array of matches
    let first = match &result {
        serde_json::Value::Array(arr) => arr.first()?,
        other => other,
    };
    match first {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => parse_number_string(s, None),
        _ => None,
    }
}

/// Extract a string value from JSON using a JSONPath expression.
fn extract_json_string(body: &str, path: &str) -> Option<String> {
    use jsonpath_rust::JsonPathQuery;
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let result = json.path(path).ok()?;
    let first = match &result {
        serde_json::Value::Array(arr) => arr.first()?,
        other => other,
    };
    match first {
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

// extract_html_value is shared via super::model::extract_html_value

/// Detect all numeric elements in an HTML page, returning structured data with
/// CSS selectors, values, labels, and HTML context snippets.
fn detect_html_elements(body: &str, locale: Option<&str>) -> Vec<DetectedHtmlElement> {
    use scraper::node::Node;

    let document = scraper::Html::parse_document(body);
    let mut results = Vec::new();
    let mut seen_selectors = std::collections::HashSet::new();

    let skip_tags: &[&str] = &[
        "script", "style", "meta", "link", "noscript", "head", "title",
    ];

    // Select all elements and check their direct text children for numbers
    let all = match scraper::Selector::parse("*") {
        Ok(s) => s,
        Err(_) => return results,
    };

    for element_ref in document.select(&all) {
        if results.len() >= 50 {
            break;
        }

        let tag = element_ref.value().name();
        if skip_tags.contains(&tag) {
            continue;
        }

        // Collect only direct text children (not descendant text)
        let mut direct_text = String::new();
        for child in element_ref.children() {
            if let Node::Text(t) = child.value() {
                direct_text.push_str(t);
            }
        }
        let trimmed = direct_text.trim();
        if trimmed.is_empty() || trimmed.len() > 30 {
            continue;
        }

        let value = match parse_number_string(trimmed, locale) {
            Some(v) => v,
            None => continue,
        };

        let selector = build_css_selector(element_ref);
        if seen_selectors.contains(&selector) {
            continue;
        }
        seen_selectors.insert(selector.clone());

        let label = find_context_label(element_ref);
        let html_context = extract_html_context(element_ref);

        results.push(DetectedHtmlElement {
            selector,
            value,
            text: trimmed.to_string(),
            label,
            html_context,
        });
    }

    results
}

/// Build a CSS selector for an element using id, classes, and parent context.
fn build_css_selector(el: scraper::ElementRef) -> String {
    let tag = el.value().name().to_string();

    if let Some(id) = el.value().id() {
        return format!("#{}", css_escape_ident(id));
    }

    let classes: Vec<&str> = el
        .value()
        .classes()
        .filter(|c| c.len() > 1)
        .take(3)
        .collect();
    let self_part = if !classes.is_empty() {
        format!(
            "{}.{}",
            tag,
            classes
                .iter()
                .map(|c| css_escape_ident(c))
                .collect::<Vec<_>>()
                .join(".")
        )
    } else {
        tag.clone()
    };

    // Check parent for more specific selector
    if let Some(parent_node) = el.parent() {
        if let Some(parent_ref) = scraper::ElementRef::wrap(parent_node) {
            let parent_tag = parent_ref.value().name();
            if parent_tag != "body" && parent_tag != "html" {
                if let Some(pid) = parent_ref.value().id() {
                    return format!("#{} > {}", css_escape_ident(pid), self_part);
                }

                let parent_classes: Vec<&str> = parent_ref
                    .value()
                    .classes()
                    .filter(|c| c.len() > 1)
                    .take(2)
                    .collect();
                if !parent_classes.is_empty() {
                    return format!(
                        "{}.{} > {}",
                        parent_tag,
                        parent_classes
                            .iter()
                            .map(|c| css_escape_ident(c))
                            .collect::<Vec<_>>()
                            .join("."),
                        self_part
                    );
                }

                return format!("{} > {}", parent_tag, self_part);
            }
        }
    }

    self_part
}

/// Find nearby text that describes what a numeric element represents.
fn find_context_label(el: scraper::ElementRef) -> String {
    use scraper::node::Node;

    // 1. Previous sibling element's text
    let mut prev = el.prev_sibling();
    while let Some(node) = prev {
        if let Some(elem) = scraper::ElementRef::wrap(node) {
            let text: String = elem.text().collect::<String>();
            let trimmed = text.trim();
            if !trimmed.is_empty()
                && trimmed.len() < 40
                && !trimmed.chars().next().is_some_and(|c| c.is_ascii_digit())
            {
                return trimmed.to_string();
            }
            break;
        }
        // Skip text nodes between elements
        if let Node::Text(t) = node.value() {
            let t = t.trim();
            if !t.is_empty()
                && t.len() < 40
                && !t.chars().next().is_some_and(|c| c.is_ascii_digit())
            {
                return t.to_string();
            }
        }
        prev = node.prev_sibling();
    }

    // 2. Table context: row header
    let in_td = el.value().name() == "td"
        || el
            .parent()
            .and_then(scraper::ElementRef::wrap)
            .is_some_and(|p| p.value().name() == "td");
    if in_td {
        // Walk up to find the <tr>
        let mut node = el.parent();
        while let Some(n) = node {
            if let Some(elem) = scraper::ElementRef::wrap(n) {
                if elem.value().name() == "tr" {
                    // Get first cell text (skip if it's the element itself)
                    if let Ok(th_sel) = scraper::Selector::parse("th, td:first-child") {
                        if let Some(first_cell) = elem.select(&th_sel).next() {
                            if first_cell.id() != el.id() {
                                let text: String = first_cell.text().collect::<String>();
                                let trimmed = text.trim();
                                if !trimmed.is_empty() && trimmed.len() < 40 {
                                    return trimmed.to_string();
                                }
                            }
                        }
                    }
                    break;
                }
            }
            node = n.parent();
        }
    }

    // 3. Parent's first non-numeric child text
    if let Some(parent_node) = el.parent() {
        for child in parent_node.children() {
            if child.id() == el.id() {
                continue;
            }
            if let Some(child_el) = scraper::ElementRef::wrap(child) {
                let text: String = child_el.text().collect::<String>();
                let trimmed = text.trim();
                if !trimmed.is_empty()
                    && trimmed.len() < 40
                    && !trimmed.chars().next().is_some_and(|c| c.is_ascii_digit())
                {
                    return trimmed.to_string();
                }
            }
            break;
        }
    }

    String::new()
}

/// Extract a HTML snippet around the element for context preview.
/// Walks up to the grandparent to show enough DOM structure for users
/// to understand the right selector.
fn extract_html_context(el: scraper::ElementRef) -> String {
    let skip = |name: &str| name == "body" || name == "html";

    // Try grandparent first for broader context
    if let Some(parent_node) = el.parent() {
        if let Some(parent_ref) = scraper::ElementRef::wrap(parent_node) {
            if !skip(parent_ref.value().name()) {
                if let Some(gp_node) = parent_ref.parent() {
                    if let Some(gp_ref) = scraper::ElementRef::wrap(gp_node) {
                        if !skip(gp_ref.value().name()) {
                            let html = gp_ref.html();
                            return truncate_str(&html, 500);
                        }
                    }
                }
                // Grandparent is body/html — use parent
                return truncate_str(&parent_ref.html(), 500);
            }
        }
    }
    // Fall back to element's own HTML
    truncate_str(&el.html(), 500)
}

/// Truncate a string at a character boundary, appending "..." if truncated.
fn truncate_str(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    // Walk backward from max_bytes to find a char boundary
    let end = s.floor_char_boundary(max_bytes);
    format!("{}...", &s[..end])
}

/// Escape a CSS identifier (class name, id) for use in selectors.
fn css_escape_ident(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            if i == 0 && c.is_ascii_digit() {
                result.push('\\');
            }
            result.push(c);
        } else if c.is_ascii() {
            result.push('\\');
            result.push(c);
        } else {
            // Non-ASCII: use CSS hex escape (e.g. \1f600 )
            write!(result, "\\{:x} ", c as u32).ok();
        }
    }
    result
}

/// Parse a number string, handling locale-specific formatting.
///
/// Strips currency symbols, whitespace, and normalizes decimal separators.
///
/// **Ambiguity note:** When no `locale` is set, the string `"1,234"` is treated as having
/// a thousands separator (English convention), producing `1234.0`. Users who need European
/// formatting (where comma is the decimal separator) should configure a locale on the
/// provider source (e.g. `"de"`, `"fr"`, `"es"`, `"it"`).
pub fn parse_number_string(s: &str, locale: Option<&str>) -> Option<f64> {
    let cleaned = s.trim();
    if cleaned.is_empty() {
        return None;
    }

    // Strip currency symbols and whitespace
    let stripped: String = cleaned
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '$' | '€' | '£' | '¥' | '₹' | '₽' | '₿' | '%' | '+' | '\u{00a0}'
            ) && !c.is_whitespace()
        })
        .collect();

    if stripped.is_empty() || !stripped.starts_with(|c: char| c.is_ascii_digit() || c == '-') {
        return None;
    }

    let normalized = match locale {
        Some(l)
            if l.starts_with("de")
                || l.starts_with("fr")
                || l.starts_with("es")
                || l.starts_with("it") =>
        {
            // European: 1.234,56 → 1234.56
            stripped.replace('.', "").replace(',', ".")
        }
        Some(l)
            if l.starts_with("en")
                || l.starts_with("ja")
                || l.starts_with("ko")
                || l.starts_with("zh")
                || l == "C" =>
        {
            // Locales where comma is thousands separator and dot is decimal.
            // Drop commas, keep dots. "4,832" → 4832, "1,234.56" → 1234.56.
            stripped.replace(',', "")
        }
        _ => {
            // Auto-detect European format: comma followed by 1, 2, or 4-8 digits
            // at end (e.g. "1.234,56" or "0,12345678" for crypto/FX). Exactly 3
            // trailing digits is ambiguous with US thousands ("4,832") and is
            // overwhelmingly the thousands case for English-language financial
            // sources — handled by the else-if arm below as a thousands strip.
            let has_european_comma = stripped.rfind(',').is_some_and(|pos| {
                let after = stripped.len() - pos - 1;
                stripped[pos + 1..].chars().all(|c| c.is_ascii_digit())
                    && (after == 1 || after == 2 || (4..=8).contains(&after))
            });
            let has_trailing_dot = stripped.rfind('.').is_some_and(|pos| {
                let after = stripped.len() - pos - 1;
                (1..=8).contains(&after) && stripped[pos + 1..].chars().all(|c| c.is_ascii_digit())
            });

            if has_european_comma && !has_trailing_dot {
                stripped.replace('.', "").replace(',', ".")
            } else if stripped.contains(',') && !stripped.contains('.') {
                // Check if comma is a thousands separator (exactly 3 digits after last comma)
                let last_comma = stripped.rfind(',').unwrap();
                let digits_after = stripped.len() - last_comma - 1;
                if digits_after == 3
                    && stripped[last_comma + 1..]
                        .chars()
                        .all(|c| c.is_ascii_digit())
                {
                    stripped.replace(',', "")
                } else {
                    stripped.replace(',', ".")
                }
            } else {
                stripped.replace(',', "")
            }
        }
    };

    let numeric: String = normalized
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();

    numeric.parse::<f64>().ok()
}

// ─── HTML table detection ────────────────────────────────────────────────────

/// Role keywords for auto-detecting column purpose from header text.
const CLOSE_KEYWORDS: &[&str] = &[
    "close", "price", "last", "schluss", "clôture", "chiusura", "kurs", "precio",
];
const DATE_KEYWORDS: &[&str] = &["date", "datum", "fecha", "data", "tag"];
const HIGH_KEYWORDS: &[&str] = &["high", "hoch", "max", "alto", "máximo"];
const LOW_KEYWORDS: &[&str] = &["low", "tief", "min", "bajo", "basso", "mínimo"];
const VOLUME_KEYWORDS: &[&str] = &["volume", "vol", "volumen"];
const OPEN_KEYWORDS: &[&str] = &["open", "apertura", "ouverture", "eröffnung"];

fn detect_column_role(header: &str) -> Option<String> {
    let lower = header.to_lowercase();
    if DATE_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return Some("date".to_string());
    }
    if CLOSE_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return Some("close".to_string());
    }
    if HIGH_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return Some("high".to_string());
    }
    if LOW_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return Some("low".to_string());
    }
    if VOLUME_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return Some("volume".to_string());
    }
    if OPEN_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return Some("open".to_string());
    }
    None
}

/// Detect HTML tables on a page, extracting column metadata and sample rows.
/// Extract text from a cell, tolerant of pages that include multiple viewport
/// variants of the same content (e.g. desktop + mobile `<span>`s in a single
/// `<td>`). When the cell has direct child elements with text, returns the
/// first non-empty one. Falls back to the cell's full text for simple cells.
fn extract_cell_text(el: scraper::ElementRef<'_>) -> String {
    for child in el.children() {
        if let Some(child_el) = scraper::ElementRef::wrap(child) {
            let text = child_el.text().collect::<String>().trim().to_string();
            if !text.is_empty() {
                return text;
            }
        }
    }
    el.text().collect::<String>().trim().to_string()
}

fn detect_html_tables(body: &str) -> Vec<DetectedHtmlTable> {
    let document = scraper::Html::parse_document(body);
    let table_sel = match scraper::Selector::parse("table") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let tr_sel = scraper::Selector::parse("tr").unwrap();
    let th_sel = scraper::Selector::parse("th").unwrap();
    let td_sel = scraper::Selector::parse("td").unwrap();

    let mut tables = Vec::new();
    for (table_idx, table_el) in document.select(&table_sel).take(10).enumerate() {
        // Extract headers: try <thead><tr><th> first, then first <tr> cells
        let mut headers: Vec<String> = Vec::new();
        if let Ok(thead_sel) = scraper::Selector::parse("thead th") {
            headers = table_el.select(&thead_sel).map(extract_cell_text).collect();
        }

        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut body_start = 0;

        for (row_idx, tr) in table_el.select(&tr_sel).enumerate() {
            let cells: Vec<String> = tr.select(&td_sel).map(extract_cell_text).collect();

            if cells.is_empty() {
                // This row has no <td>s — might be a header row with <th>s
                if headers.is_empty() {
                    headers = tr.select(&th_sel).map(extract_cell_text).collect();
                }
                continue;
            }

            // If no headers found yet, use first data row as headers
            if headers.is_empty() && row_idx == 0 {
                headers = cells;
                body_start = 1;
                continue;
            }

            if rows.len() < 5 {
                rows.push(cells.clone());
            }
        }

        // Skip tables with fewer than 2 columns or 1 row
        if headers.len() < 2 && rows.is_empty() {
            continue;
        }

        let row_count = table_el
            .select(&tr_sel)
            .count()
            .saturating_sub(body_start + 1);

        let columns: Vec<DetectedColumn> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| DetectedColumn {
                index: i,
                header: h.clone(),
                role: detect_column_role(h),
            })
            .collect();

        tables.push(DetectedHtmlTable {
            index: table_idx,
            columns,
            row_count: row_count.max(rows.len()),
            sample_rows: rows,
        });
    }

    tables
}

/// Parse a "table_idx:col_idx" path.
fn parse_table_path(path: &str) -> Option<(usize, usize)> {
    let parts: Vec<&str> = path.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?))
}

/// Return the data rows of the Nth `<table>` in the document, skipping the
/// header row in the same way `detect_html_tables` does (so column indices
/// reported in the preview match the cells extracted here):
/// - if the table has any `<thead><th>` cells, all `<td>` rows are data rows;
/// - else if the first `<tr>` is `<th>`-only, it's the header and `<td>` rows
///   that follow are data;
/// - else the very first `<td>` row is treated as the header row.
fn extract_table_data_rows(body: &str, table_idx: usize) -> Option<Vec<Vec<String>>> {
    let document = scraper::Html::parse_document(body);
    let table_sel = scraper::Selector::parse("table").ok()?;
    let table_el = document.select(&table_sel).nth(table_idx)?;

    let tr_sel = scraper::Selector::parse("tr").ok()?;
    let th_sel = scraper::Selector::parse("th").ok()?;
    let td_sel = scraper::Selector::parse("td").ok()?;
    let thead_sel = scraper::Selector::parse("thead th").ok()?;

    let mut headers_seen = table_el.select(&thead_sel).next().is_some();
    let mut rows: Vec<Vec<String>> = Vec::new();

    for (row_idx, tr) in table_el.select(&tr_sel).enumerate() {
        let cells: Vec<String> = tr.select(&td_sel).map(extract_cell_text).collect();
        if cells.is_empty() {
            // <th>-only row counts as a header row
            if !headers_seen && tr.select(&th_sel).next().is_some() {
                headers_seen = true;
            }
            continue;
        }
        if !headers_seen && row_idx == 0 {
            // First <tr> has <td>s but no <th>/<thead> exists — it's the header row
            headers_seen = true;
            continue;
        }
        rows.push(cells);
    }

    Some(rows)
}

/// Extract a single numeric value from an HTML table using "table_idx:col_idx" path.
fn extract_table_value(body: &str, path: &str, locale: Option<&str>) -> Option<f64> {
    let (table_idx, col_idx) = parse_table_path(path)?;
    let rows = extract_table_data_rows(body, table_idx)?;
    let cell = rows.first()?.get(col_idx)?;
    parse_number_string(cell, locale)
}

/// Extract a raw cell string (e.g. a date) from an HTML table using "table:col".
fn extract_table_string(body: &str, path: &str) -> Option<String> {
    let (table_idx, col_idx) = parse_table_path(path)?;
    let rows = extract_table_data_rows(body, table_idx)?;
    let s = rows.first()?.get(col_idx)?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ─── CSV parsing ─────────────────────────────────────────────────────────────

/// Extract a price from CSV data for test_source. Uses last row.
fn parse_csv_test(body: &str, price_col: &str, locale: Option<&str>) -> Option<f64> {
    let records = parse_csv_records(body)?;
    if records.is_empty() {
        return None;
    }
    let (headers, data_rows) = (&records[0], &records[1..]);
    let last_row = data_rows.last()?;

    let col_idx = resolve_csv_column(headers, price_col)?;
    let val = last_row.get(col_idx)?;
    parse_number_string(val, locale)
}

/// Extract a raw string cell (e.g. a date) from CSV for test_source. Uses last row.
fn extract_csv_string(body: &str, col: &str) -> Option<String> {
    let records = parse_csv_records(body)?;
    if records.is_empty() {
        return None;
    }
    let (headers, data_rows) = (&records[0], &records[1..]);
    let last_row = data_rows.last()?;
    let col_idx = resolve_csv_column(headers, col)?;
    let val = last_row.get(col_idx)?.trim().to_string();
    if val.is_empty() {
        None
    } else {
        Some(val)
    }
}

/// Parse CSV body into rows, auto-detecting delimiter (; vs ,).
pub fn parse_csv_records(body: &str) -> Option<Vec<Vec<String>>> {
    // Try comma first
    let records = try_csv_parse(body, b',');
    if let Some(ref rows) = records {
        if rows.first().is_some_and(|r| r.len() > 1) {
            return records;
        }
    }
    // Fall back to semicolon
    try_csv_parse(body, b';')
}

fn try_csv_parse(body: &str, delimiter: u8) -> Option<Vec<Vec<String>>> {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(body.as_bytes());

    let rows: Vec<Vec<String>> = rdr
        .records()
        .filter_map(|r| r.ok())
        .map(|r| r.iter().map(|f| f.to_string()).collect())
        .collect();

    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

/// Resolve a column identifier (name or 0-based index) to a column index.
pub fn resolve_csv_column(headers: &[String], col: &str) -> Option<usize> {
    // Try as index first
    if let Ok(idx) = col.parse::<usize>() {
        return if idx < headers.len() { Some(idx) } else { None };
    }
    // Try as header name (case-insensitive)
    let col_lower = col.to_lowercase();
    headers
        .iter()
        .position(|h| h.trim().to_lowercase() == col_lower)
}

/// Detect the HTML lang attribute as a locale fallback.
pub fn detect_html_locale(body: &str) -> Option<String> {
    let document = scraper::Html::parse_document(body);
    let sel = scraper::Selector::parse("html").ok()?;
    let el = document.select(&sel).next()?;
    let lang = el.value().attr("lang")?;
    Some(lang[..2.min(lang.len())].to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_values_from_unicode_keys() {
        let body = r#"[{"净值日期":"2026-07-11","单位净值":1.4018}]"#;

        assert_eq!(
            extract_json_value(body, r#"$[*]["单位净值"]"#),
            Some(1.4018)
        );
        assert_eq!(
            extract_json_string(body, r#"$[*]["净值日期"]"#),
            Some("2026-07-11".to_string())
        );
    }

    // Header row uses <td> (no <thead>/<th>) — like ariva.de's historical
    // prices table. The first <td> row is the headers, not data.
    const TD_HEADER_TABLE: &str = r#"<html><body><table>
        <tr><td>Datum</td><td>Erster</td><td>Hoch</td><td>Tief</td><td>Schluss</td><td>Volumen</td></tr>
        <tr><td>04.05.26</td><td>781,68 €</td><td>794,70 €</td><td>781,68 €</td><td>794,70 €</td><td>1.589 €</td></tr>
        <tr><td>30.04.26</td><td>805,57 €</td><td>805,57 €</td><td>798,89 €</td><td>798,89 €</td><td>0 €</td></tr>
    </table></body></html>"#;

    #[test]
    fn extract_table_value_skips_td_header_row() {
        // Column 4 ("Schluss") of the first data row is "794,70 €" → 794.70.
        // Before the fix this returned None because the header row "Schluss"
        // was being parsed as a number.
        assert_eq!(
            extract_table_value(TD_HEADER_TABLE, "0:4", Some("de-DE")),
            Some(794.70)
        );
    }

    #[test]
    fn extract_table_string_skips_td_header_row() {
        // Column 0 of the first data row is "04.05.26", not the "Datum" header.
        assert_eq!(
            extract_table_string(TD_HEADER_TABLE, "0:0"),
            Some("04.05.26".to_string())
        );
    }

    #[test]
    fn extract_table_value_with_thead_does_not_skip_data() {
        // When proper <thead><th> is used, all <td> rows are data rows.
        let body = r#"<html><body><table>
            <thead><tr><th>Date</th><th>Close</th></tr></thead>
            <tbody>
                <tr><td>2026-05-04</td><td>123.45</td></tr>
                <tr><td>2026-05-03</td><td>120.00</td></tr>
            </tbody>
        </table></body></html>"#;
        assert_eq!(
            extract_table_value(body, "0:1", Some("en-US")),
            Some(123.45)
        );
        assert_eq!(
            extract_table_string(body, "0:0"),
            Some("2026-05-04".to_string())
        );
    }

    #[test]
    fn extract_table_value_with_th_only_header_row() {
        // <th> header row outside <thead> still counts as headers.
        let body = r#"<html><body><table>
            <tr><th>Date</th><th>Close</th></tr>
            <tr><td>2026-05-04</td><td>123.45</td></tr>
        </table></body></html>"#;
        assert_eq!(
            extract_table_value(body, "0:1", Some("en-US")),
            Some(123.45)
        );
    }
}
