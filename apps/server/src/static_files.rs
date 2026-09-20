use std::{convert::Infallible, path::Path};

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use tower::{service_fn, ServiceExt};
use tower_http::services::{ServeDir, ServeFile};

/// Static responses have their own cache policy; API responses are untouched.
pub fn router(directory: &Path) -> Router {
    let index = ServeFile::new(directory.join("index.html"));
    let fallback = service_fn(move |request: Request<Body>| {
        let index = index.clone();
        async move {
            if is_navigation(&request) {
                Ok::<_, Infallible>(index.oneshot(request).await.unwrap().into_response())
            } else {
                Ok(StatusCode::NOT_FOUND.into_response())
            }
        }
    });
    Router::new()
        .fallback_service(ServeDir::new(directory).fallback(fallback))
        .layer(middleware::from_fn(cache_headers))
}

fn is_navigation(request: &Request<Body>) -> bool {
    let path = request.uri().path();
    // Asset/API namespaces must never fall through to the application document.
    let reserved = ["/assets", "/__generated__", "/api", "/mcp"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")));
    // Root public files are not routes. Nested route IDs may contain dots (BRK.B).
    let root_file = !path[1..].contains('/') && path.contains('.');
    matches!(*request.method(), Method::GET | Method::HEAD)
        && !reserved
        && !root_file
        && request
            .headers()
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(',')
                    .any(|mime| mime.split(';').next().unwrap_or_default().trim() == "text/html")
            })
}

fn is_hashed_asset(path: &str) -> bool {
    // Vite's default asset names end in -[hash:8].[ext]. Public files are unversioned.
    if !path.starts_with("/assets/") || path.ends_with(".html") || path.ends_with(".htm") {
        return false;
    }
    let Some((stem, _)) = path.rsplit_once('.') else {
        return false;
    };
    let bytes = stem.as_bytes();
    bytes.len() > 9
        && bytes[bytes.len() - 9] == b'-'
        && bytes[bytes.len() - 8..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

async fn cache_headers(request: Request<Body>, next: Next) -> Response {
    let hashed = is_hashed_asset(request.uri().path());
    let mut response = next.run(request).await;
    let reusable_asset = hashed
        && matches!(
            response.status(),
            StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::NOT_MODIFIED
        )
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| value.as_bytes().starts_with(b"text/html"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        if reusable_asset {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }
        .parse()
        .unwrap(),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use std::fs;
    use tempfile::TempDir;

    fn fixture() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("assets")).unwrap();
        fs::create_dir(dir.path().join("__generated__")).unwrap();
        for (name, body) in [
            ("index.html", "<!doctype html><html>version one</html>"),
            ("assets/main-Abc_12-3.js", "export const version = 1;"),
            ("assets/unversioned.js", "export {};"),
            ("splash.css", "body {}"),
            ("__generated__/addon-sandbox-runtime.js", "export {};"),
        ] {
            fs::write(dir.path().join(name), body).unwrap();
        }
        dir
    }

    async fn request(app: Router, uri: &str, accept: &str) -> Response {
        app.oneshot(
            Request::builder()
                .uri(uri)
                .header(header::ACCEPT, accept)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn html_and_unversioned_resources_revalidate() {
        let dir = fixture();
        for uri in ["/", "/index.html", "/dashboard", "/holdings/BRK.B"] {
            let response = request(router(dir.path()), uri, "text/html").await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert!(response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/html"));
        }
        for uri in [
            "/splash.css",
            "/assets/unversioned.js",
            "/__generated__/addon-sandbox-runtime.js",
        ] {
            let response = request(router(dir.path()), uri, "*/*").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        }
    }

    #[tokio::test]
    async fn only_existing_hashed_assets_are_immutable() {
        let dir = fixture();
        let response = request(router(dir.path()), "/assets/main-Abc_12-3.js", "*/*").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert!(response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("javascript"));
        for uri in [
            "/assets/missing-12345678.js",
            "/__generated__/missing.js",
            "/missing.js",
            "/api/v1/missing",
            "/mcp/missing",
        ] {
            for accept in ["*/*", "text/html"] {
                let response = request(router(dir.path()), uri, accept).await;
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
                let body = to_bytes(response.into_body(), 1024).await.unwrap();
                assert!(!String::from_utf8_lossy(&body).contains("version one"));
            }
        }
        assert_eq!(
            request(router(dir.path()), "/dashboard", "application/json")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn head_and_api_responses_keep_their_semantics() {
        let dir = fixture();
        let app = Router::new()
            .route("/api/v1/settings", axum::routing::get(|| async { "{}" }))
            .fallback_service(router(dir.path()))
            .layer(middleware::from_fn(crate::api::security_headers));
        let response = request(app.clone(), "/api/v1/settings", "application/json").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key(header::CACHE_CONTROL));
        for uri in ["/", "/dashboard"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::HEAD)
                        .uri(uri)
                        .header(header::ACCEPT, "text/html")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert!(response.headers().contains_key("content-security-policy"));
            assert!(to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty());
        }
    }

    #[tokio::test]
    async fn conditional_html_responses_revalidate_and_upgrades_serve_new_entry() {
        let dir = fixture();
        let app = router(dir.path());
        let response = request(app.clone(), "/dashboard", "text/html").await;
        let modified = response.headers()[header::LAST_MODIFIED].clone();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/dashboard")
                    .header(header::ACCEPT, "text/html")
                    .header(header::IF_MODIFIED_SINCE, modified.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");

        fs::write(
            dir.path().join("index.html"),
            "<!doctype html><html>version two</html>",
        )
        .unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
        // Windows `SetFileTime` needs write access; a read-only handle fails.
        fs::File::options()
            .write(true)
            .open(dir.path().join("index.html"))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future))
            .unwrap();
        fs::remove_file(dir.path().join("assets/main-Abc_12-3.js")).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/dashboard")
                    .header(header::ACCEPT, "text/html")
                    .header(header::IF_MODIFIED_SINCE, modified)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("version two"));
        // A running old tab still cannot import a deleted chunk. Do not hide it with HTML.
        assert_eq!(
            request(app, "/assets/main-Abc_12-3.js", "*/*")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
