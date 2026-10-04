use axum::{Json, http::StatusCode, response::IntoResponse};
use legible_protocol::{ApiError, ApiErrorDetails};

pub(super) struct ApiFailure {
    status: StatusCode,
    body: ApiError,
}

impl ApiFailure {
    pub(super) fn new(status: StatusCode, code: &str, message: &str) -> Self {
        Self {
            status,
            body: ApiError {
                error: ApiErrorDetails {
                    code: code.into(),
                    message: message.into(),
                    details: None,
                },
            },
        }
    }
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json(self.body)).into_response()
    }
}
