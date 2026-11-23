use serde::Serialize;
use wealthfolio_core::errors::PublicError;

#[derive(Debug, Serialize)]
pub enum CommandError {
    ServiceError(PublicError),
}

impl<E> From<E> for CommandError
where
    E: std::error::Error + 'static,
{
    fn from(error: E) -> Self {
        let public = (&error as &dyn std::error::Error)
            .downcast_ref::<wealthfolio_ai::AiError>()
            .map(wealthfolio_ai::AiError::public_error)
            .unwrap_or_else(|| PublicError::from_error(&error));
        CommandError::ServiceError(public)
    }
}

pub type CommandResult<T, E = CommandError> = Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_errors_serialize_only_public_content() {
        let private = "FAKE-KEY-2531 /private/portfolio.db SELECT account_balance";
        for error in [
            wealthfolio_core::Error::Secret(private.into()),
            wealthfolio_core::Error::Database(
                wealthfolio_core::errors::DatabaseError::QueryFailed(private.into()),
            ),
        ] {
            let json = serde_json::to_value(CommandError::from(error)).unwrap();
            assert_eq!(json["ServiceError"]["errorCode"], "internal_error");
            assert!(!json.to_string().contains("FAKE-KEY"));
            assert!(!json.to_string().contains("/private"));
            assert!(!json.to_string().contains("account_balance"));
        }
    }
}
