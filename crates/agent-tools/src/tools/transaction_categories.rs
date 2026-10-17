//! MCP-only discovery and reviewed creation of transaction categories.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use wealthfolio_core::taxonomies::{
    NewCategory, TaxonomyServiceTrait, TaxonomyWithCategories, TRANSACTION_CATEGORY_TAXONOMY_IDS,
};

use crate::{
    AgentEnvironment, AgentScope, AgentTool, AgentToolAccess, AgentToolError, AgentToolResult,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListTransactionCategoriesArgs {
    pub taxonomy_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareTransactionCategoryArgs {
    pub taxonomy_id: String,
    pub name: String,
    pub key: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionCategoryDraft {
    pub id: String,
    pub taxonomy_id: String,
    pub name: String,
    pub key: String,
    pub parent_id: Option<String>,
    pub color: String,
    pub description: Option<String>,
}

impl TransactionCategoryDraft {
    fn as_input(&self) -> PrepareTransactionCategoryArgs {
        PrepareTransactionCategoryArgs {
            taxonomy_id: self.taxonomy_id.clone(),
            name: self.name.clone(),
            key: self.key.clone(),
            parent_id: self.parent_id.clone(),
            color: Some(self.color.clone()),
            description: self.description.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitTransactionCategoryArgs {
    pub category: TransactionCategoryDraft,
}

fn parse_args<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, AgentToolError> {
    // MCP persists errors in its audit log. Serde errors can include private
    // values or unknown field names, so keep malformed-input errors data-free.
    serde_json::from_value(args).map_err(|_| {
        AgentToolError::InvalidInput(
            "Invalid category arguments; see the tool's input schema".into(),
        )
    })
}

fn validate_taxonomy_id(id: &str) -> Result<(), AgentToolError> {
    if !TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&id) {
        return Err(AgentToolError::InvalidInput(
            "taxonomyId must be spending_categories, income_sources or savings_categories".into(),
        ));
    }
    Ok(())
}

fn load_taxonomy(
    service: &dyn TaxonomyServiceTrait,
    id: &str,
) -> Result<TaxonomyWithCategories, AgentToolError> {
    validate_taxonomy_id(id)?;
    service
        .get_taxonomy(id)
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        .filter(|entry| entry.taxonomy.scope == "activity")
        .ok_or_else(|| AgentToolError::InvalidInput("Activity taxonomy not found".into()))
}

fn validate_category(
    service: &dyn TaxonomyServiceTrait,
    args: &PrepareTransactionCategoryArgs,
    id: Option<&str>,
) -> Result<(), AgentToolError> {
    let taxonomy = load_taxonomy(service, &args.taxonomy_id)?;
    if args.name.trim().is_empty() || args.name.chars().any(char::is_control) {
        return Err(AgentToolError::InvalidInput(
            "name must be nonempty text".into(),
        ));
    }
    // Keys are stable, taxonomy-scoped identifiers. Preserve Unicode and case,
    // as the native category editor does, rather than silently rewriting them.
    if args.key.is_empty()
        || args
            .key
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AgentToolError::InvalidInput(
            "key must be nonempty and contain no whitespace or control characters".into(),
        ));
    }
    if let Some(color) = args.color.as_deref() {
        if color.len() != 7
            || !color.starts_with('#')
            || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(AgentToolError::InvalidInput(
                "color must be a #RRGGBB hex color".into(),
            ));
        }
    }
    if taxonomy.categories.iter().any(|cat| cat.key == args.key) {
        return Err(AgentToolError::InvalidInput(
            "A category with this key already exists in the taxonomy".into(),
        ));
    }
    if let Some(id) = id {
        if Uuid::try_parse(id).is_err() {
            return Err(AgentToolError::InvalidInput(
                "category.id must be a UUID from prepare_transaction_category".into(),
            ));
        }
        if taxonomy.categories.iter().any(|cat| cat.id == id) {
            return Err(AgentToolError::InvalidInput(
                "A category with this ID already exists in the taxonomy".into(),
            ));
        }
    }
    if let Some(parent) = args.parent_id.as_deref() {
        if !taxonomy.categories.iter().any(|cat| cat.id == parent) {
            return Err(AgentToolError::InvalidInput(
                "parentId must identify an existing category in the selected taxonomy".into(),
            ));
        }
    }
    Ok(())
}

fn category_schema(with_id: bool) -> Value {
    let mut schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "taxonomyId": { "type": "string", "enum": TRANSACTION_CATEGORY_TAXONOMY_IDS },
            "name": { "type": "string", "minLength": 1, "description": "Display name of the new transaction category." },
            "key": { "type": "string", "minLength": 1, "description": "Stable key, unique within the selected taxonomy, with no whitespace or control characters. Preserve it when committing." },
            "parentId": { "type": ["string", "null"], "description": "Optional category ID from list_transaction_categories in the same taxonomy. Omit for a root category." },
            "color": { "type": ["string", "null"], "pattern": "^#[0-9a-fA-F]{6}$", "description": "Optional #RRGGBB color; defaults to #808080." },
            "description": { "type": ["string", "null"] }
        },
        "required": ["taxonomyId", "name", "key"]
    });
    if with_id {
        schema["properties"]["id"] = json!({ "type": "string", "format": "uuid", "description": "Category ID returned by prepare_transaction_category. Preserve it when committing so replay fails instead of creating another category." });
        schema["properties"]["color"]["type"] = json!("string");
        schema["properties"]["color"]["description"] =
            json!("Reviewed #RRGGBB color returned by prepare_transaction_category.");
        schema["required"]
            .as_array_mut()
            .expect("required is an array")
            .extend([json!("id"), json!("color")]);
    }
    schema
}

fn redact_category_args(args: &Value) -> Value {
    // Names, descriptions, keys and parent IDs may contain private user text.
    // Only keep the built-in taxonomy identifier, even for malformed calls.
    let category = args.get("category").unwrap_or(args);
    let mut redacted = json!({"category": "[redacted]"});
    if let Some(id) = category.get("taxonomyId").and_then(Value::as_str) {
        if TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&id) {
            redacted["taxonomyId"] = json!(id);
        }
    }
    redacted
}

fn redact_list_category_args(args: &Value) -> Value {
    let mut redacted = json!({});
    if let Some(id) = args.get("taxonomyId").and_then(Value::as_str) {
        if TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&id) {
            redacted["taxonomyId"] = json!(id);
        }
    }
    redacted
}

pub struct ListTransactionCategories;

#[async_trait::async_trait]
impl AgentTool for ListTransactionCategories {
    fn name(&self) -> &'static str {
        "list_transaction_categories"
    }

    fn description(&self) -> &'static str {
        "List transaction categories, including their IDs, stable keys, parents, colors and descriptions, for spending_categories, income_sources and savings_categories. Omit taxonomyId to return all three activity taxonomies. Works without accounts or transactions. Asset taxonomies are excluded. To add a category, call prepare_transaction_category, show the draft to the user, then call commit_transaction_category after confirmation."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object", "additionalProperties": false,
            "properties": { "taxonomyId": { "type": "string", "enum": TRANSACTION_CATEGORY_TAXONOMY_IDS } }
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ClassificationRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    fn sanitize_args_for_audit(&self, args: &Value) -> Value {
        redact_list_category_args(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: ListTransactionCategoriesArgs = parse_args(args)?;
        let service = env.taxonomy_service();
        let taxonomies = if let Some(id) = args.taxonomy_id {
            vec![load_taxonomy(service.as_ref(), &id)?]
        } else {
            service
                .get_taxonomies_with_categories()
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
                .into_iter()
                .filter(|entry| {
                    entry.taxonomy.scope == "activity"
                        && TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&entry.taxonomy.id.as_str())
                })
                .collect()
        };
        Ok(AgentToolResult {
            content: json!({"taxonomies": taxonomies}),
        })
    }
}

pub struct PrepareTransactionCategory;

#[async_trait::async_trait]
impl AgentTool for PrepareTransactionCategory {
    fn name(&self) -> &'static str {
        "prepare_transaction_category"
    }

    fn description(&self) -> &'static str {
        "Prepare a new transaction category WITHOUT saving it. Choose spending_categories, income_sources or savings_categories and a unique key; use list_transaction_categories for existing keys and optional parent IDs. Returns a category draft with an ID and defaults. Show the draft to the user and, after confirmation, pass its category object unchanged to commit_transaction_category. This creates categories only, never assignments or asset taxonomies."
    }

    fn input_schema(&self) -> Value {
        category_schema(false)
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[
            AgentScope::ClassificationRead,
            AgentScope::ClassificationSuggest,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &Value) -> Value {
        redact_category_args(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PrepareTransactionCategoryArgs = parse_args(args)?;
        validate_category(env.taxonomy_service().as_ref(), &args, None)?;
        let category = TransactionCategoryDraft {
            id: Uuid::now_v7().to_string(),
            taxonomy_id: args.taxonomy_id,
            name: args.name,
            key: args.key,
            parent_id: args.parent_id,
            color: args.color.unwrap_or_else(|| NewCategory::default().color),
            description: args.description,
        };
        Ok(AgentToolResult {
            content: json!({"category": category}),
        })
    }
}

pub struct CommitTransactionCategory;

#[async_trait::async_trait]
impl AgentTool for CommitTransactionCategory {
    fn name(&self) -> &'static str {
        "commit_transaction_category"
    }

    fn description(&self) -> &'static str {
        "Save one reviewed category draft from prepare_transaction_category. This MUTATES data — call only after the user has reviewed and confirmed the draft, passing the returned category object with its ID. Revalidates the taxonomy, unique key/ID and optional parent against current data. Returns the created category; duplicate keys and replayed IDs are rejected. Only spending_categories, income_sources and savings_categories are supported. Existing categories, assignments, activities and asset taxonomies are unchanged."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object", "additionalProperties": false,
            "properties": { "category": category_schema(true) }, "required": ["category"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[
            AgentScope::ClassificationRead,
            AgentScope::ClassificationSuggest,
            AgentScope::ClassificationWrite,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &Value) -> Value {
        redact_category_args(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: CommitTransactionCategoryArgs = parse_args(args)?;
        let draft = args.category;
        let service = env.taxonomy_service();
        validate_category(service.as_ref(), &draft.as_input(), Some(&draft.id))?;
        let created = service
            .create_category(NewCategory {
                id: Some(draft.id),
                taxonomy_id: draft.taxonomy_id,
                parent_id: draft.parent_id,
                name: draft.name,
                key: draft.key,
                color: draft.color,
                description: draft.description,
                sort_order: 999,
                ..Default::default()
            })
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        Ok(AgentToolResult {
            content: json!({"created": created}),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_audit_redacts_user_text_and_unknown_fields() {
        let args = json!({
            "taxonomyId": "spending_categories", "name": "Private legal matter",
            "key": "private_key", "description": "Confidential", "parentId": "private_parent",
            "unexpected": "private_extra"
        });
        let expected = json!({"taxonomyId": "spending_categories", "category": "[redacted]"});
        assert_eq!(
            PrepareTransactionCategory.sanitize_args_for_audit(&args),
            expected
        );
        assert_eq!(
            CommitTransactionCategory.sanitize_args_for_audit(&json!({"category": args})),
            expected
        );
        assert_eq!(
            ListTransactionCategories.sanitize_args_for_audit(&json!({
                "taxonomyId": "spending_categories", "unexpected": "private_value"
            })),
            json!({"taxonomyId": "spending_categories"})
        );
        assert_eq!(
            ListTransactionCategories.sanitize_args_for_audit(&json!({"taxonomyId": "private"})),
            json!({})
        );
    }

    #[test]
    fn draft_fields_match_the_commit_schema() {
        let draft = TransactionCategoryDraft {
            id: Uuid::now_v7().to_string(),
            taxonomy_id: "income_sources".into(),
            name: "Consulting".into(),
            key: "consulting_custom".into(),
            parent_id: None,
            color: "#808080".into(),
            description: None,
        };
        let value = serde_json::to_value(draft).unwrap();
        let schema = CommitTransactionCategory.input_schema();
        for key in value.as_object().unwrap().keys() {
            assert!(
                schema["properties"]["category"]["properties"]
                    .get(key)
                    .is_some(),
                "{key}"
            );
        }
        let _: CommitTransactionCategoryArgs =
            serde_json::from_value(json!({"category": value})).unwrap();
        assert!(CommitTransactionCategory
            .description()
            .contains("MUTATES data"));
    }
}
