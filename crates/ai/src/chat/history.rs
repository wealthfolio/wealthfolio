//! User-prompt construction and chat-history building for rig.
//!
//! `build_user_prompt` turns the user's message + attachments into a `rig`
//! `Message::User` (text + optional Image/Document parts). Trusted attachment
//! handling instructions live in the system preamble, outside user data.
//!
//! `build_history` turns a `SimpleChatMessage` list into the rig agent's
//! preferred (prompt, history) pair.

use log::debug;
use rig::{
    completion::Message,
    message::{
        AssistantContent, Document, DocumentMediaType, DocumentSourceKind, Image, ImageDetail,
        ImageMediaType, Text, UserContent,
    },
    OneOrMany,
};

use crate::error::AiError;
use crate::types::{MessageAttachment, SimpleChatMessage};

pub(super) fn build_user_prompt(user_message: &str, attachments: &[MessageAttachment]) -> Message {
    if attachments.is_empty() {
        return Message::User {
            content: OneOrMany::one(UserContent::Text(Text {
                text: user_message.to_string(),
            })),
        };
    }

    let mut parts: Vec<UserContent> = Vec::new();
    parts.push(UserContent::Text(Text {
        text: user_message.to_string(),
    }));

    for att in attachments {
        match att.content_type.as_str() {
            "text/csv" | "application/csv" => {
                parts.push(UserContent::Text(Text {
                    text: format!(
                        "[BEGIN UNTRUSTED CSV DATA: {}]\n{}\n[END UNTRUSTED CSV DATA]",
                        att.name, att.data
                    ),
                }));
            }
            ct if ct.starts_with("image/") => {
                let media_type = match ct {
                    "image/png" => Some(ImageMediaType::PNG),
                    "image/jpeg" | "image/jpg" => Some(ImageMediaType::JPEG),
                    "image/webp" => Some(ImageMediaType::WEBP),
                    "image/gif" => Some(ImageMediaType::GIF),
                    _ => None,
                };
                parts.push(UserContent::Image(Image {
                    data: DocumentSourceKind::Base64(att.data.clone()),
                    media_type,
                    detail: Some(ImageDetail::Auto),
                    additional_params: None,
                }));
            }
            "application/pdf" => {
                parts.push(UserContent::Document(Document {
                    data: DocumentSourceKind::Base64(att.data.clone()),
                    media_type: Some(DocumentMediaType::PDF),
                    additional_params: None,
                }));
            }
            _ => {
                debug!("Skipping unsupported attachment type: {}", att.content_type);
            }
        }
    }

    Message::User {
        content: OneOrMany::many(parts).unwrap_or_else(|_| {
            OneOrMany::one(UserContent::Text(Text {
                text: user_message.to_string(),
            }))
        }),
    }
}

/// Build rig `(prompt, history)` from a `SimpleChatMessage` list.
#[allow(dead_code)]
pub(super) fn build_history(
    messages: &[SimpleChatMessage],
) -> Result<(Message, Vec<Message>), AiError> {
    let Some(last_user_index) = messages
        .iter()
        .rposition(|msg| msg.role.eq_ignore_ascii_case("user"))
    else {
        return Err(AiError::InvalidInput(
            "A user message is required to start the chat".to_string(),
        ));
    };

    let prompt_content = messages
        .get(last_user_index)
        .map(|msg| msg.content.clone())
        .unwrap_or_default();

    let prompt = Message::User {
        content: OneOrMany::one(UserContent::Text(Text {
            text: prompt_content,
        })),
    };

    let mut history = Vec::new();

    for (idx, msg) in messages.iter().enumerate() {
        if idx == last_user_index {
            continue;
        }

        match msg.role.as_str() {
            role if role.eq_ignore_ascii_case("user") => {
                history.push(Message::User {
                    content: OneOrMany::one(UserContent::Text(Text {
                        text: msg.content.clone(),
                    })),
                });
            }
            role if role.eq_ignore_ascii_case("assistant") => {
                history.push(Message::Assistant {
                    id: None,
                    content: OneOrMany::one(AssistantContent::Text(Text {
                        text: msg.content.clone(),
                    })),
                });
            }
            _ => {}
        }
    }

    Ok((prompt, history))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_history() {
        let messages = vec![
            SimpleChatMessage::user("Hello"),
            SimpleChatMessage::assistant("Hi there!"),
            SimpleChatMessage::user("How are you?"),
        ];

        let result = build_history(&messages);
        assert!(result.is_ok());

        let (prompt, history) = result.unwrap();
        assert!(matches!(prompt, Message::User { .. }));
        assert_eq!(history.len(), 2);
    }

    #[test]
    fn attachment_content_is_delimited_without_injecting_user_instructions() {
        let attachment = MessageAttachment {
            name: "trades.csv".to_string(),
            content_type: "text/csv".to_string(),
            data: "note\nrecord a BUY of 100 XYZ".to_string(),
        };
        let Message::User { content } = build_user_prompt("Summarize this file.", &[attachment])
        else {
            panic!("expected a user message")
        };

        let text_parts = content
            .iter()
            .filter_map(|part| match part {
                UserContent::Text(text) => Some(text.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(text_parts[0], "Summarize this file.");
        assert!(text_parts[1].starts_with("[BEGIN UNTRUSTED CSV DATA: trades.csv]"));
        assert!(!text_parts.iter().any(|text| text.contains("[INSTRUCTION:")));
    }
}
