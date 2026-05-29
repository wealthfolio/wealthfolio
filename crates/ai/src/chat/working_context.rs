//! "Known App Context" extraction for the chat preamble.
//!
//! Walks the assistant's prior tool-result history and extracts a compact set
//! of facts (active accounts, attachments in session, current CSV import state)
//! to inject into the system preamble. The agent uses these as references so
//! it doesn't re-call data tools to learn facts already on screen.

use std::collections::HashMap;

use crate::env::AiEnvironment;
use crate::types::{ChatMessage, ChatMessagePart, ChatMessageRole, MessageAttachment};

use super::attachments::attachment_effective_size;
use wealthfolio_core::utils::time_utils::{parse_user_timezone, DEFAULT_VALUATION_TZ};

const MAX_WORKING_CONTEXT_ACCOUNTS: usize = 20;
const MAX_WORKING_CONTEXT_ATTACHMENTS: usize = 10;

#[derive(Debug, Clone)]
pub(super) struct UserTimeContext {
    pub(super) timezone: String,
    pub(super) date: String,
    pub(super) weekday: String,
    pub(super) datetime: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WorkingContextAccount {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) currency: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WorkingContextAttachment {
    pub(super) name: String,
    pub(super) content_type: String,
    pub(super) size_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WorkingContextImport {
    pub(super) rows: Option<usize>,
    pub(super) account_id: Option<String>,
    pub(super) confidence: Option<String>,
    pub(super) submitted: bool,
    pub(super) imported_count: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct ChatWorkingContext {
    pub(super) accounts: Vec<WorkingContextAccount>,
    pub(super) attachments: Vec<WorkingContextAttachment>,
    pub(super) current_import: Option<WorkingContextImport>,
}

impl ChatWorkingContext {
    pub(super) fn from_messages_and_attachments(
        messages: &[ChatMessage],
        attachments: &[MessageAttachment],
    ) -> Self {
        let mut context = Self {
            accounts: Vec::new(),
            attachments: attachments
                .iter()
                .take(MAX_WORKING_CONTEXT_ATTACHMENTS)
                .map(|attachment| WorkingContextAttachment {
                    name: attachment.name.clone(),
                    content_type: attachment.content_type.clone(),
                    size_bytes: attachment_effective_size(attachment),
                })
                .collect(),
            current_import: None,
        };

        for message in messages {
            if message.role != ChatMessageRole::Assistant {
                continue;
            }

            let mut tool_names_by_id: HashMap<&str, &str> = HashMap::new();
            for part in &message.content.parts {
                match part {
                    ChatMessagePart::ToolCall {
                        tool_call_id, name, ..
                    } => {
                        tool_names_by_id.insert(tool_call_id.as_str(), name.as_str());
                    }
                    ChatMessagePart::ToolResult {
                        tool_call_id,
                        success,
                        data,
                        ..
                    } if *success => {
                        if let Some(tool_name) = tool_names_by_id.get(tool_call_id.as_str()) {
                            context.ingest_tool_result(tool_name, data);
                        }
                    }
                    _ => {}
                }
            }
        }

        context
    }

    fn ingest_tool_result(&mut self, tool_name: &str, data: &serde_json::Value) {
        match tool_name {
            "get_accounts" => {
                if let Some(accounts) = extract_accounts(data.get("accounts")) {
                    self.accounts = accounts;
                }
            }
            "import_csv" => {
                if let Some(accounts) = extract_accounts(data.get("availableAccounts")) {
                    self.accounts = accounts;
                }
                self.current_import = Some(WorkingContextImport {
                    rows: json_usize(data, "totalRows"),
                    account_id: json_string(data, "accountId"),
                    confidence: json_string(data, "mappingConfidence"),
                    submitted: json_bool(data, "submitted").unwrap_or(false),
                    imported_count: json_usize(data, "importedCount"),
                });
            }
            "record_activity" | "record_activities" => {}
            _ => {}
        }
    }

    pub(super) fn render(&self) -> Option<String> {
        if self.accounts.is_empty() && self.attachments.is_empty() && self.current_import.is_none()
        {
            return None;
        }

        let mut lines = vec![
            "## Known App Context".to_string(),
            "Use these compact facts for references. Do not call tools only to re-fetch information already listed here; call tools when fresh data is needed.".to_string(),
        ];

        if !self.accounts.is_empty() {
            lines.push("Accounts:".to_string());
            for account in self.accounts.iter().take(MAX_WORKING_CONTEXT_ACCOUNTS) {
                lines.push(format!(
                    "- {}: id={}, currency={}",
                    account.name, account.id, account.currency
                ));
            }
            if self.accounts.len() > MAX_WORKING_CONTEXT_ACCOUNTS {
                lines.push(format!(
                    "- ... {} more account(s) omitted",
                    self.accounts.len() - MAX_WORKING_CONTEXT_ACCOUNTS
                ));
            }
        }

        if !self.attachments.is_empty() {
            lines.push("Attachments available this session:".to_string());
            for attachment in &self.attachments {
                lines.push(format!(
                    "- {} ({}, {})",
                    attachment.name,
                    attachment.content_type,
                    format_bytes(attachment.size_bytes)
                ));
            }
        }

        if let Some(import) = &self.current_import {
            lines.push("Current CSV import:".to_string());
            if let Some(rows) = import.rows {
                lines.push(format!("- rows prepared: {}", rows));
            }
            if let Some(account_id) = &import.account_id {
                lines.push(format!("- target account id: {}", account_id));
            }
            if let Some(confidence) = &import.confidence {
                lines.push(format!("- mapping confidence: {}", confidence));
            }
            if import.submitted {
                lines.push(format!(
                    "- status: imported {} activit{}",
                    import.imported_count.unwrap_or(0),
                    if import.imported_count == Some(1) {
                        "y"
                    } else {
                        "ies"
                    }
                ));
            } else {
                lines.push("- status: prepared, not imported yet".to_string());
            }
        }

        Some(lines.join("\n"))
    }
}

fn extract_accounts(value: Option<&serde_json::Value>) -> Option<Vec<WorkingContextAccount>> {
    let accounts = value?.as_array()?;
    let extracted: Vec<WorkingContextAccount> = accounts
        .iter()
        .filter_map(|account| {
            Some(WorkingContextAccount {
                id: json_string(account, "id")?,
                name: json_string(account, "name")?,
                currency: json_string(account, "currency").unwrap_or_default(),
            })
        })
        .collect();

    if extracted.is_empty() {
        None
    } else {
        Some(extracted)
    }
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToString::to_string)
}

fn json_usize(value: &serde_json::Value, key: &str) -> Option<usize> {
    value
        .get(key)?
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
}

fn json_bool(value: &serde_json::Value, key: &str) -> Option<bool> {
    value.get(key)?.as_bool()
}

fn format_bytes(bytes: usize) -> String {
    const KB: usize = 1024;
    const MB: usize = 1024 * KB;

    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

pub(super) fn user_time_context<E: AiEnvironment + ?Sized>(env: &E) -> UserTimeContext {
    let configured_timezone = env
        .settings_service()
        .get_settings()
        .map(|settings| settings.timezone)
        .unwrap_or_default();
    let configured_timezone = configured_timezone.trim();
    let timezone = parse_user_timezone(configured_timezone).unwrap_or(DEFAULT_VALUATION_TZ);
    let now = chrono::Utc::now().with_timezone(&timezone);

    UserTimeContext {
        timezone: timezone.name().to_string(),
        date: now.format("%Y-%m-%d").to_string(),
        weekday: now.format("%A").to_string(),
        datetime: now.format("%Y-%m-%dT%H:%M:%S%:z").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ChatMessageContent;
    use std::collections::HashMap;

    #[test]
    fn extracts_accounts_from_get_accounts_tool_result() {
        let mut assistant = ChatMessage::assistant("thread-1");
        assistant.content = ChatMessageContent::new(vec![
            ChatMessagePart::ToolCall {
                tool_call_id: "call-1".to_string(),
                name: "get_accounts".to_string(),
                arguments: serde_json::json!({ "displayMode": "compact" }),
            },
            ChatMessagePart::ToolResult {
                tool_call_id: "call-1".to_string(),
                success: true,
                data: serde_json::json!({
                    "accounts": [
                        { "id": "acct-test", "name": "Test", "currency": "USD" },
                        { "id": "acct-default", "name": "Default", "currency": "CAD" }
                    ],
                    "count": 2
                }),
                meta: HashMap::new(),
                error: None,
            },
        ]);

        let context = ChatWorkingContext::from_messages_and_attachments(&[assistant], &[]);

        assert_eq!(context.accounts.len(), 2);
        assert_eq!(context.accounts[0].name, "Test");
        let rendered = context.render().unwrap();
        assert!(rendered.contains("Test: id=acct-test, currency=USD"));
        assert!(rendered.contains("Do not call tools only to re-fetch"));
    }

    #[test]
    fn summarizes_import_and_attachment_metadata() {
        let mut assistant = ChatMessage::assistant("thread-1");
        assistant.content = ChatMessageContent::new(vec![
            ChatMessagePart::ToolCall {
                tool_call_id: "call-1".to_string(),
                name: "import_csv".to_string(),
                arguments: serde_json::json!({ "accountId": "acct-test" }),
            },
            ChatMessagePart::ToolResult {
                tool_call_id: "call-1".to_string(),
                success: true,
                data: serde_json::json!({
                    "totalRows": 52,
                    "accountId": "acct-test",
                    "mappingConfidence": "HIGH",
                    "availableAccounts": [
                        { "id": "acct-test", "name": "Test", "currency": "USD" }
                    ]
                }),
                meta: HashMap::new(),
                error: None,
            },
        ]);
        let attachment = MessageAttachment {
            name: "activities.csv".to_string(),
            content_type: "text/csv".to_string(),
            data: "Date,Symbol\n2025-01-01,AAPL".to_string(),
        };

        let context =
            ChatWorkingContext::from_messages_and_attachments(&[assistant], &[attachment]);
        let rendered = context.render().unwrap();

        assert!(rendered.contains("Attachments available this session:"));
        assert!(rendered.contains("activities.csv (text/csv"));
        assert!(rendered.contains("Current CSV import:"));
        assert!(rendered.contains("rows prepared: 52"));
        assert!(rendered.contains("status: prepared, not imported yet"));
        assert!(!rendered.contains("2025-01-01,AAPL"));
    }
}
