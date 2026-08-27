use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Valid source kinds.
pub const VALID_SOURCE_KINDS: &[&str] = &["latest", "historical"];
/// Valid source formats.
pub const VALID_SOURCE_FORMATS: &[&str] = &["json", "html", "html_table", "csv"];
/// Valid HTTP methods.
pub const VALID_HTTP_METHODS: &[&str] = &["GET", "POST"];

/// HTTP method for custom provider requests.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    #[default]
    Get,
    Post,
}

impl HttpMethod {
    /// Convert to uppercase string for use in reqwest.
    pub fn as_str(&self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
        }
    }
}

/// Fully expanded request data shared by custom-provider testing and runtime fetching.
pub(crate) struct PreparedCustomProviderRequest {
    pub(crate) url: String,
    method: HttpMethod,
    headers: reqwest::header::HeaderMap,
    body: Option<String>,
}

impl PreparedCustomProviderRequest {
    pub(crate) fn request_builder(&self, client: &reqwest::Client) -> reqwest::RequestBuilder {
        match self.method {
            HttpMethod::Post => {
                let builder = client.post(&self.url).headers(self.headers.clone());
                match &self.body {
                    Some(body) => builder.body(body.clone()),
                    None => builder,
                }
            }
            HttpMethod::Get => client.get(&self.url).headers(self.headers.clone()),
        }
    }
}

/// Cached regex for formatted date templates: `{DATE:...}`, `{FROM:...}`,
/// `{TO:...}`, `{TODAY:...}`.
pub static DATE_TEMPLATE_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"\{(DATE|FROM|TO|TODAY):([^}]+)\}").unwrap());

/// Maximum HTTP response body size (10 MB).
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

/// Browser-like user agent used by custom provider test and runtime requests.
pub const CUSTOM_PROVIDER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Context for expanding template variables in URLs and paths.
pub struct TemplateContext<'a> {
    pub symbol: &'a str,
    pub currency: &'a str,
    pub isin: Option<&'a str>,
    pub mic: Option<&'a str>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
}

#[derive(Debug, Error)]
#[error("Invalid date format '{format}' in {{{variable}:{format}}}")]
pub struct TemplateExpansionError {
    variable: String,
    format: String,
}

fn has_unsupported_date_directive(variable: &str, format: &str) -> bool {
    // DATE historically accepted every valid Chrono directive because it is
    // formatted from a full DateTime<Utc>. Keep that compatibility while the
    // date-only placeholders remain limited to directives they can represent.
    if variable == "DATE" {
        return false;
    }

    let mut chars = format.chars();
    while let Some(character) = chars.next() {
        if character == '%' && !matches!(chars.next(), Some('Y' | 'm' | 'd')) {
            return true;
        }
    }
    false
}

#[derive(Debug)]
pub(crate) enum PrepareRequestError<E> {
    Template(TemplateExpansionError),
    Header(E),
}

/// Expand template variables in a string (URL or path).
///
/// Supported variables: `{SYMBOL}`, `{currency}`, `{CURRENCY}`, `{TODAY}`,
/// `{FROM}`, `{TO}`, `{ISIN}`, `{MIC}`, `{DATE:format}`,
/// `{FROM:format}`, `{TO:format}`, `{TODAY:format}`. `DATE` accepts any
/// valid Chrono directive; the date-only variables support `%Y`, `%m`, and
/// `%d`.
pub fn expand_template(
    template: &str,
    ctx: &TemplateContext<'_>,
) -> Result<String, TemplateExpansionError> {
    for captures in DATE_TEMPLATE_RE.captures_iter(template) {
        let variable = &captures[1];
        let format = &captures[2];
        if has_unsupported_date_directive(variable, format)
            || chrono::format::StrftimeItems::new(format)
                .any(|item| matches!(item, chrono::format::Item::Error))
        {
            return Err(TemplateExpansionError {
                variable: variable.to_string(),
                format: format.to_string(),
            });
        }
    }

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let mut out = template
        .replace("{SYMBOL}", ctx.symbol)
        .replace("{currency}", &ctx.currency.to_lowercase())
        .replace("{CURRENCY}", &ctx.currency.to_uppercase())
        .replace("{TODAY}", &today)
        .replace("{FROM}", ctx.from.unwrap_or(&today))
        .replace("{TO}", ctx.to.unwrap_or(&today));

    if out.contains("{ISIN}") {
        out = out.replace("{ISIN}", ctx.isin.unwrap_or(ctx.symbol));
    }
    if out.contains("{MIC}") {
        out = out.replace("{MIC}", ctx.mic.unwrap_or(""));
    }
    // Formatted date templates:
    //   {DATE:format}                 - current instant (all valid Chrono directives)
    //   {FROM/TO/TODAY:format}        - the corresponding date, reformatted
    if out.contains("{DATE:")
        || out.contains("{FROM:")
        || out.contains("{TO:")
        || out.contains("{TODAY:")
    {
        out = DATE_TEMPLATE_RE
            .replace_all(&out, |caps: &regex::Captures| {
                let var = &caps[1]; // DATE, FROM, TO, or TODAY
                let format = &caps[2];
                // DATE uses the current instant directly so time components work.
                if var == "DATE" {
                    return chrono::Utc::now().format(format).to_string();
                }
                let date_str = match var {
                    "FROM" => ctx.from.unwrap_or(&today),
                    "TO" => ctx.to.unwrap_or(&today),
                    _ => &today, // TODAY
                };
                // Parse the ISO date and reformat; fall back to the raw string.
                match chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                    Ok(parsed) => parsed.format(format).to_string(),
                    Err(_) => date_str.to_string(),
                }
            })
            .to_string();
    }
    Ok(out)
}

/// Validate that a URL parses and uses an http(s) scheme.
///
/// The user is the author of their provider URLs, so we don't restrict which
/// hosts they can target (self-hosted providers on private networks are
/// supported). Only rejects malformed URLs and non-HTTP(S) schemes.
pub fn validate_url(raw: &str) -> Result<(), anyhow::Error> {
    let parsed =
        url::Url::parse(raw).map_err(|e| anyhow::anyhow!("Invalid URL '{}': {}", raw, e))?;

    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(anyhow::anyhow!(
                "Unsupported URL scheme '{}' (only http/https allowed)",
                other
            ))
        }
    }

    if parsed.host().is_none() {
        return Err(anyhow::anyhow!("URL '{}' has no host", raw));
    }

    Ok(())
}

/// Build default browser-like headers for custom provider HTTP requests.
pub fn build_browser_like_headers(format: &str, url: &str) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    let default_accept = match format {
        "json" => "application/json, text/plain, */*",
        "csv" => "text/csv, text/plain, */*",
        _ => {
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
        }
    };
    for (name, value) in [
        ("accept", default_accept),
        ("accept-language", "en-US,en;q=0.9"),
        ("sec-fetch-dest", "empty"),
        ("sec-fetch-mode", "cors"),
        ("sec-fetch-site", "same-origin"),
        (
            "sec-ch-ua",
            "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
        ),
        ("sec-ch-ua-mobile", "?0"),
        ("sec-ch-ua-platform", "\"macOS\""),
        ("upgrade-insecure-requests", "1"),
    ] {
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            headers.insert(n, v);
        }
    }

    if let Ok(parsed) = reqwest::Url::parse(url) {
        let origin = parsed.origin().ascii_serialization();
        if origin != "null" {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("{origin}/")) {
                headers.insert(reqwest::header::REFERER, v);
            }
        }
    }

    headers
}

/// Expand templates and prepare a custom-provider HTTP request.
///
/// User headers override defaults. POST requests receive a JSON content type only
/// when the user did not configure one explicitly.
pub(crate) fn prepare_custom_provider_request<E>(
    method: &HttpMethod,
    format: &str,
    url_template: &str,
    headers_json: Option<&str>,
    body_template: Option<&str>,
    ctx: &TemplateContext<'_>,
    resolve_header_value: impl Fn(&str) -> Result<String, E>,
) -> Result<PreparedCustomProviderRequest, PrepareRequestError<E>> {
    let url = expand_template(url_template, ctx).map_err(PrepareRequestError::Template)?;
    let mut headers = build_browser_like_headers(format, &url);

    if matches!(method, HttpMethod::Post) {
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
    }

    if let Some(headers_json) = headers_json {
        if let Ok(map) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(headers_json)
        {
            for (key, value) in map {
                if let Some(value) = value.as_str() {
                    let resolved =
                        resolve_header_value(value).map_err(PrepareRequestError::Header)?;
                    if let (Ok(name), Ok(value)) = (
                        reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                        reqwest::header::HeaderValue::from_str(&resolved),
                    ) {
                        headers.insert(name, value);
                    }
                }
            }
        }
    }

    Ok(PreparedCustomProviderRequest {
        url,
        method: method.clone(),
        headers,
        body: body_template
            .map(|body| expand_template(body, ctx))
            .transpose()
            .map_err(PrepareRequestError::Template)?,
    })
}

/// Extract a numeric value from HTML using a CSS selector.
///
/// Shared between `custom_provider::service` (test_source) and
/// `quotes::custom_scraper_provider` (runtime quote fetching).
pub fn extract_html_value(body: &str, selector: &str, locale: Option<&str>) -> Option<f64> {
    let document = scraper::Html::parse_document(body);
    let sel = scraper::Selector::parse(selector).ok()?;
    let element = document.select(&sel).next()?;
    let text: String = element.text().collect::<String>();
    crate::custom_provider::service::parse_number_string(text.trim(), locale)
}

/// A custom provider source definition (latest or historical).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderSource {
    pub id: String,
    pub provider_id: String,
    /// "latest" or "historical"
    pub kind: String,
    /// "json", "html", "html_table", or "csv"
    pub format: String,
    pub url: String,
    /// JSONPath expression, CSS selector, or "table_idx:col_idx"
    pub price_path: String,
    pub date_path: Option<String>,
    pub date_format: Option<String>,
    pub currency_path: Option<String>,
    pub factor: Option<f64>,
    pub invert: Option<bool>,
    pub locale: Option<String>,
    /// JSON object string of extra HTTP headers
    pub headers: Option<String>,
    /// HTTP method: "GET" or "POST"
    #[serde(default)]
    pub method: HttpMethod,
    /// Request body for POST requests (JSON string)
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub open_path: Option<String>,
    pub high_path: Option<String>,
    pub low_path: Option<String>,
    pub volume_path: Option<String>,
    pub default_price: Option<f64>,
    pub date_timezone: Option<String>,
}

/// A custom provider with its source definitions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderWithSources {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub priority: i32,
    pub sources: Vec<CustomProviderSource>,
}

/// Payload for creating a new custom provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCustomProvider {
    /// Unique code (lowercase alphanumeric + hyphens), used as provider_id
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub sources: Vec<NewCustomProviderSource>,
}

/// Payload for updating a custom provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCustomProvider {
    pub name: Option<String>,
    pub description: Option<String>,
    pub enabled: Option<bool>,
    pub priority: Option<i32>,
    pub sources: Option<Vec<NewCustomProviderSource>>,
}

/// Source definition within a create/update payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCustomProviderSource {
    /// "latest" or "historical"
    pub kind: String,
    /// "json", "html", "html_table", or "csv"
    pub format: String,
    pub url: String,
    pub price_path: String,
    pub date_path: Option<String>,
    pub date_format: Option<String>,
    pub currency_path: Option<String>,
    pub factor: Option<f64>,
    pub invert: Option<bool>,
    pub locale: Option<String>,
    pub headers: Option<String>,
    /// HTTP method: "GET" or "POST"
    #[serde(default)]
    pub method: HttpMethod,
    /// Request body for POST requests (JSON string)
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub open_path: Option<String>,
    pub high_path: Option<String>,
    pub low_path: Option<String>,
    pub volume_path: Option<String>,
    pub default_price: Option<f64>,
    pub date_timezone: Option<String>,
}

/// Request to test a source configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSourceRequest {
    pub format: String,
    pub url: String,
    pub price_path: String,
    pub date_path: Option<String>,
    pub date_format: Option<String>,
    pub currency_path: Option<String>,
    pub factor: Option<f64>,
    pub invert: Option<bool>,
    pub locale: Option<String>,
    pub headers: Option<String>,
    /// HTTP method: "GET" or "POST"
    #[serde(default)]
    pub method: HttpMethod,
    /// Request body for POST requests (JSON string)
    #[serde(default)]
    pub body: Option<String>,
    /// Symbol to substitute in template variables
    pub symbol: String,
    /// ISIN to substitute in template variables.
    #[serde(default)]
    pub isin: Option<String>,
    /// MIC to substitute in template variables.
    #[serde(default)]
    pub mic: Option<String>,
    /// Currency for {currency}/{CURRENCY} placeholders (defaults to "usd")
    pub currency: Option<String>,
    /// Start date for {FROM} placeholders while testing historical sources.
    pub from: Option<String>,
    /// End date for {TO} placeholders while testing historical sources.
    pub to: Option<String>,
    #[serde(default)]
    pub open_path: Option<String>,
    pub high_path: Option<String>,
    pub low_path: Option<String>,
    pub volume_path: Option<String>,
    pub default_price: Option<f64>,
    pub date_timezone: Option<String>,
}

/// A numeric element detected in an HTML page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedHtmlElement {
    /// CSS selector that targets this element.
    pub selector: String,
    /// Parsed numeric value.
    pub value: f64,
    /// Raw text content of the element.
    pub text: String,
    /// Nearby label/context (e.g. "Official Close").
    pub label: String,
    /// Outer HTML snippet of the parent element for context preview.
    pub html_context: String,
}

/// A column detected in an HTML table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedColumn {
    pub index: usize,
    pub header: String,
    /// Auto-detected role: "close", "date", "high", "low", "volume", "open", or null
    pub role: Option<String>,
}

/// An HTML table detected on a page with column metadata and sample rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedHtmlTable {
    pub index: usize,
    pub columns: Vec<DetectedColumn>,
    pub row_count: usize,
    pub sample_rows: Vec<Vec<String>>,
}

/// Result of testing a source configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TestSourceResult {
    pub success: bool,
    pub status_code: Option<u16>,
    pub price: Option<f64>,
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub volume: Option<f64>,
    pub currency: Option<String>,
    pub date: Option<String>,
    pub error: Option<String>,
    pub raw_response: Option<String>,
    /// Detected numeric elements (HTML only).
    pub detected_elements: Option<Vec<DetectedHtmlElement>>,
    /// Detected HTML tables (html_table format).
    pub detected_tables: Option<Vec<DetectedHtmlTable>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(from: Option<&'a str>, to: Option<&'a str>) -> TemplateContext<'a> {
        TemplateContext {
            symbol: "AAPL",
            currency: "usd",
            isin: None,
            mic: None,
            from,
            to,
        }
    }

    #[test]
    fn http_method_default_and_as_str() {
        assert_eq!(HttpMethod::default(), HttpMethod::Get);
        assert_eq!(HttpMethod::Get.as_str(), "GET");
        assert_eq!(HttpMethod::Post.as_str(), "POST");
    }

    #[test]
    fn http_method_serde_is_uppercase() {
        assert_eq!(
            serde_json::to_string(&HttpMethod::Post).unwrap(),
            "\"POST\""
        );
        let m: HttpMethod = serde_json::from_str("\"GET\"").unwrap();
        assert_eq!(m, HttpMethod::Get);
    }

    #[test]
    fn expands_basic_placeholders() {
        let c = ctx(Some("2024-01-01"), Some("2024-12-31"));
        let out = expand_template(
            "https://x.test/{SYMBOL}?ccy={currency}&CCY={CURRENCY}&from={FROM}&to={TO}",
            &c,
        )
        .unwrap();
        assert_eq!(
            out,
            "https://x.test/AAPL?ccy=usd&CCY=USD&from=2024-01-01&to=2024-12-31"
        );
    }

    #[test]
    fn from_to_fall_back_to_today_when_absent() {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let out = expand_template("{FROM}..{TO}", &ctx(None, None)).unwrap();
        assert_eq!(out, format!("{today}..{today}"));
    }

    #[test]
    fn expands_formatted_from_and_to() {
        let c = ctx(Some("2024-01-02"), Some("2024-03-04"));
        let out = expand_template("{FROM:%Y%m%d}-{TO:%d/%m/%Y}", &c).unwrap();
        assert_eq!(out, "20240102-04/03/2024");
    }

    #[test]
    fn formatted_date_falls_back_on_unparseable_input() {
        // A non-ISO {FROM} value can't be reparsed, so the raw string is kept.
        let c = ctx(Some("not-a-date"), None);
        let out = expand_template("{FROM:%Y}", &c).unwrap();
        assert_eq!(out, "not-a-date");
    }

    #[test]
    fn today_formatted_uses_current_date() {
        let expected = chrono::Utc::now().format("%Y/%m/%d").to_string();
        let out = expand_template("{TODAY:%Y/%m/%d}", &ctx(None, None)).unwrap();
        assert_eq!(out, expected);
    }

    #[test]
    fn plain_today_not_clobbered_by_formatted_variant() {
        // `{TODAY}` and `{TODAY:...}` must both expand independently.
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let year = chrono::Utc::now().format("%Y").to_string();
        let out = expand_template("{TODAY} / {TODAY:%Y}", &ctx(None, None)).unwrap();
        assert_eq!(out, format!("{today} / {year}"));
    }

    #[test]
    fn expands_post_body_json() {
        // POST bodies go through the same expander as URLs.
        let c = ctx(Some("2024-01-01"), Some("2024-06-30"));
        let body = r#"{"symbol":"{SYMBOL}","from":"{FROM}","to":"{TO:%Y%m%d}"}"#;
        let out = expand_template(body, &c).unwrap();
        assert_eq!(
            out,
            r#"{"symbol":"AAPL","from":"2024-01-01","to":"20240630"}"#
        );
    }

    #[test]
    fn rejects_invalid_formatted_date_without_panicking() {
        let error = expand_template("https://example.test/{FROM:%Q}", &ctx(None, None))
            .expect_err("invalid chrono directives should be rejected");
        assert!(error.to_string().contains("%Q"));

        let prepared = prepare_custom_provider_request(
            &HttpMethod::Post,
            "json",
            "https://example.test/quotes",
            None,
            Some(r#"{"from":"{FROM:%Q}"}"#),
            &ctx(None, None),
            |value| Ok::<_, ()>(value.to_string()),
        );
        assert!(prepared.is_err());
    }

    #[test]
    fn rejects_unsupported_formatted_date_directive() {
        let error = expand_template("https://example.test/{FROM:%H}", &ctx(None, None))
            .expect_err("time directives should be rejected");
        assert!(error.to_string().contains("%H"));
    }

    #[test]
    fn preserves_valid_legacy_date_directives() {
        let out = expand_template("{DATE:%H}|{DATE:%j}|{DATE:%%}", &ctx(None, None)).unwrap();
        let parts: Vec<_> = out.split('|').collect();

        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 2);
        assert!(parts[0].chars().all(|character| character.is_ascii_digit()));
        assert_eq!(parts[1].len(), 3);
        assert!(parts[1].chars().all(|character| character.is_ascii_digit()));
        assert_eq!(parts[2], "%");
    }

    #[test]
    fn prepares_post_with_expanded_identity_body_and_default_content_type() {
        let context = TemplateContext {
            symbol: "AAPL",
            currency: "usd",
            isin: Some("US0378331005"),
            mic: Some("XNAS"),
            from: Some("2024-01-01"),
            to: Some("2024-06-30"),
        };
        let prepared = prepare_custom_provider_request(
            &HttpMethod::Post,
            "json",
            "https://example.test/quotes",
            None,
            Some(r#"{"symbol":"{SYMBOL}","isin":"{ISIN}","mic":"{MIC}","currency":"{CURRENCY}","from":"{FROM}","to":"{TO}"}"#),
            &context,
            |value| Ok::<_, ()>(value.to_string()),
        )
        .unwrap();
        let request = prepared
            .request_builder(&reqwest::Client::new())
            .build()
            .unwrap();

        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .unwrap(),
            "application/json"
        );
        assert_eq!(
            request.body().and_then(|body| body.as_bytes()),
            Some(
                br#"{"symbol":"AAPL","isin":"US0378331005","mic":"XNAS","currency":"USD","from":"2024-01-01","to":"2024-06-30"}"#
                    .as_slice()
            )
        );
    }

    #[test]
    fn prepared_request_preserves_explicit_content_type_for_post_and_get() {
        let headers = Some(r#"{"Content-Type":"application/vnd.test+json"}"#);
        for method in [HttpMethod::Post, HttpMethod::Get] {
            let prepared = prepare_custom_provider_request(
                &method,
                "json",
                "https://example.test/quotes/{SYMBOL}",
                headers,
                None,
                &ctx(None, None),
                |value| Ok::<_, ()>(value.to_string()),
            )
            .unwrap();
            let request = prepared
                .request_builder(&reqwest::Client::new())
                .build()
                .unwrap();

            assert_eq!(
                request
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .unwrap(),
                "application/vnd.test+json"
            );
        }
    }
}
