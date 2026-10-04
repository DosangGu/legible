use std::fmt;

use axum::http::{HeaderMap, HeaderValue, Method, Uri, header};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use subtle::ConstantTimeEq;

const COOKIE_NAME: &str = "legible_session";
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// Per-instance browser credentials. Neither secret is persisted or included in Debug output.
pub struct BrowserAccess {
    bootstrap: String,
    cookie: String,
}

impl BrowserAccess {
    pub fn new() -> Result<Self, getrandom::Error> {
        Ok(Self {
            bootstrap: secret()?,
            cookie: secret()?,
        })
    }

    /// Only hand this to an explicit connection flow, never logs or embedded WebView code.
    pub fn bootstrap_token(&self) -> &str {
        &self.bootstrap
    }

    pub(super) fn accepts_bootstrap(&self, token: &str) -> bool {
        same_secret(token, &self.bootstrap)
    }

    pub(super) fn set_cookie(&self) -> HeaderValue {
        let mut value = HeaderValue::from_str(&format!(
            "{COOKIE_NAME}={}; HttpOnly; SameSite=Strict; Path=/api",
            self.cookie
        ))
        .expect("base64url credentials are valid header values");
        value.set_sensitive(true);

        value
    }

    pub(super) fn authenticated(&self, headers: &HeaderMap) -> bool {
        session_cookie(headers).is_some_and(|cookie| same_secret(cookie, &self.cookie))
    }
}

impl fmt::Debug for BrowserAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrowserAccess")
            .finish_non_exhaustive()
    }
}

pub(super) fn local_request(headers: &HeaderMap, method: &Method, uri: &Uri) -> bool {
    let Some(host) = single_header(headers, header::HOST) else {
        return false;
    };

    if !local_host(host) || !valid_target(uri, host) {
        return false;
    }

    valid_origin(headers, method, host)
}

fn valid_target(uri: &Uri, host: &str) -> bool {
    // Also reject conflicting absolute-form request targets used by HTTP proxies.
    if uri
        .authority()
        .is_some_and(|authority| !authority.as_str().eq_ignore_ascii_case(host))
        || uri.scheme_str().is_some_and(|scheme| scheme != "http")
    {
        return false;
    }

    true
}

fn valid_origin(headers: &HeaderMap, method: &Method, host: &str) -> bool {
    if headers.contains_key(header::ORIGIN) {
        return single_header(headers, header::ORIGIN)
            .is_some_and(|origin| origin.eq_ignore_ascii_case(&format!("http://{host}")));
    }

    matches!(*method, Method::GET | Method::HEAD) && !websocket_upgrade(headers)
}

fn websocket_upgrade(headers: &HeaderMap) -> bool {
    for value in headers.get_all(header::UPGRADE) {
        let Ok(value) = value.to_str() else {
            continue;
        };

        if value
            .split(',')
            .any(|protocol| protocol.trim().eq_ignore_ascii_case("websocket"))
        {
            return true;
        }
    }

    false
}

fn local_host(value: &str) -> bool {
    let value = value.to_ascii_lowercase();

    LOOPBACK_HOSTS
        .iter()
        .any(|host| value == *host || host_with_port(&value, host))
}

fn host_with_port(value: &str, host: &str) -> bool {
    let Some(port) = value
        .strip_prefix(host)
        .and_then(|suffix| suffix.strip_prefix(':'))
    else {
        return false;
    };

    !port.is_empty()
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok()
}

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    let mut cookie = None;

    for value in headers.get_all(header::COOKIE) {
        let value = value.to_str().ok()?;

        for part in value.split(';').map(str::trim) {
            let Some((name, value)) = part.split_once('=') else {
                continue;
            };

            if name != COOKIE_NAME {
                continue;
            }

            if cookie.is_some() {
                return None;
            }

            cookie = Some(value);
        }
    }

    cookie
}

pub(super) fn single_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;

    if values.next().is_some() {
        return None;
    }

    Some(value)
}

fn secret() -> Result<String, getrandom::Error> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes)?;

    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn same_secret(value: &str, expected: &str) -> bool {
    bool::from(value.as_bytes().ct_eq(expected.as_bytes()))
}
