//! MCP-only discovery and reviewed creation of activity category trees.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use wealthfolio_core::taxonomies::NewCategory;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

const ACTIVITY_SCOPE: &str = "activity";

#[derive(Deserialize)]
struct ListActivityTaxonomiesArgs {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareCategoryCreationArgs {
    taxonomy_id: String,
    name: String,
    key: String,
    parent_id: Option<String>,
    color: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    sort_order: Option<i32>,
}

#[derive(Deserialize)]
struct CommitCategoryCreationArgs {
    category: NewCategory,
}

fn parse_args<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, AgentToolError> {
    // Serde errors can echo user values; MCP persists error text in its audit log.
    serde_json::from_value(args)
        .map_err(|_| AgentToolError::InvalidInput("Invalid category tool arguments".to_string()))
}

fn validate_fields(category: &NewCategory) -> Result<(), AgentToolError> {
    if category.id.as_deref().is_none_or(|v| v.trim().is_empty())
        || category.taxonomy_id.trim().is_empty()
        || category.name.trim().is_empty()
        || category.key.trim().is_empty()
        || category
            .parent_id
            .as_deref()
            .is_some_and(|v| v.trim().is_empty())
    {
        return Err(AgentToolError::InvalidInput(
            "Category id, taxonomyId, name, key and supplied parentId must be nonblank".to_string(),
        ));
    }
    if category.parent_id.is_some() && category.parent_id == category.id {
        return Err(AgentToolError::InvalidInput(
            "A category cannot be its own parent".to_string(),
        ));
    }
    Ok(())
}

fn validate_taxonomy(
    env: &dyn AgentEnvironment,
    category: &NewCategory,
) -> Result<(), AgentToolError> {
    let entry = env
        .taxonomy_service()
        .get_taxonomy(&category.taxonomy_id)
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        .filter(|t| t.taxonomy.scope == ACTIVITY_SCOPE)
        .ok_or_else(|| {
            AgentToolError::InvalidInput("An existing activity taxonomy is required".to_string())
        })?;
    if category.parent_id.as_deref().is_some_and(|parent| {
        !entry
            .categories
            .iter()
            .any(|c| c.id == parent && c.taxonomy_id == category.taxonomy_id)
    }) {
        return Err(AgentToolError::InvalidInput(
            "Parent must exist in the same activity taxonomy".to_string(),
        ));
    }
    Ok(())
}

fn category_properties() -> Value {
    json!({
        "taxonomyId": { "type": "string", "minLength": 1, "description": "Activity taxonomy ID from list_activity_taxonomies." },
        "name": { "type": "string", "minLength": 1 },
        "key": { "type": "string", "minLength": 1, "description": "Choose a unique key within this taxonomy for rule/proposal lookup." },
        "parentId": { "type": ["string", "null"], "description": "Existing category ID in the same taxonomy, or null for a root." },
        "color": { "type": "string", "default": "#808080" },
        "description": { "type": ["string", "null"] },
        "icon": { "type": ["string", "null"] },
        "sortOrder": { "type": "integer", "minimum": i32::MIN, "maximum": i32::MAX, "default": 0 }
    })
}

pub struct ListActivityTaxonomies;

#[async_trait::async_trait]
impl AgentTool for ListActivityTaxonomies {
    fn name(&self) -> &'static str {
        "list_activity_taxonomies"
    }
    fn description(&self) -> &'static str {
        "List local activity taxonomies (income, expense and savings) with all category definitions, IDs, keys and parent IDs. Works before accounts or transactions exist. Use these IDs to prepare categories and subcategories. Returns taxonomies containing taxonomy metadata and categories; excludes asset taxonomies."
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ClassificationRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _args: &Value) -> Value {
        json!({})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let _: ListActivityTaxonomiesArgs = parse_args(args)?;
        let taxonomies = env
            .taxonomy_service()
            .get_taxonomies_with_categories()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
            .into_iter()
            .filter(|t| t.taxonomy.scope == ACTIVITY_SCOPE)
            .collect::<Vec<_>>();
        Ok(AgentToolResult {
            content: json!({ "taxonomies": taxonomies }),
        })
    }
}

pub struct PrepareCategoryCreation;

#[async_trait::async_trait]
impl AgentTool for PrepareCategoryCreation {
    fn name(&self) -> &'static str {
        "prepare_category_creation"
    }
    fn description(&self) -> &'static str {
        "Prepare a category or subcategory in an existing activity taxonomy. Select taxonomyId and optional parentId using list_activity_taxonomies. Choose a key unique within the taxonomy. Returns a category draft with a stable ID; saves nothing. Review the draft before calling commit_category_creation. Create parents first to build a category tree."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": category_properties(),
            "required": ["taxonomyId", "name", "key"]
        })
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
    fn sanitize_args_for_audit(&self, _args: &Value) -> Value {
        json!({ "category": "[redacted]" })
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PrepareCategoryCreationArgs = parse_args(args)?;
        let defaults = NewCategory::default();
        let category = NewCategory {
            id: Some(uuid::Uuid::new_v4().to_string()),
            taxonomy_id: args.taxonomy_id,
            name: args.name,
            key: args.key,
            parent_id: args.parent_id,
            color: args.color.unwrap_or(defaults.color),
            description: args.description,
            icon: args.icon,
            sort_order: args.sort_order.unwrap_or(defaults.sort_order),
        };
        validate_fields(&category)?;
        validate_taxonomy(env.as_ref(), &category)?;
        Ok(AgentToolResult {
            content: json!({ "draftStatus": "draft", "category": category }),
        })
    }
}

pub struct CommitCategoryCreation;

#[async_trait::async_trait]
impl AgentTool for CommitCategoryCreation {
    fn name(&self) -> &'static str {
        "commit_category_creation"
    }
    fn description(&self) -> &'static str {
        "Save a reviewed category draft from prepare_category_creation. Pass the returned category object, including its stable ID. This MUTATES data: call only after user review and confirmation. Revalidates the current activity taxonomy and parent, and returns the stored category. Replaying the same draft fails without overwriting or creating a second category. Saved IDs can be parentId for subcategories or categoryId in commit_transaction_categories."
    }
    fn input_schema(&self) -> Value {
        let mut properties = category_properties();
        properties["id"] = json!({ "type": "string", "minLength": 1, "description": "Stable ID from prepare_category_creation; retain it for retries." });
        json!({
            "type": "object",
            "properties": {
                "category": {
                    "type": "object",
                    "properties": properties,
                    "required": ["id", "taxonomyId", "name", "key", "color", "sortOrder"]
                }
            },
            "required": ["category"]
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
    fn sanitize_args_for_audit(&self, _args: &Value) -> Value {
        json!({ "category": "[redacted]" })
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: CommitCategoryCreationArgs = parse_args(args)?;
        validate_fields(&args.category)?;
        validate_taxonomy(env.as_ref(), &args.category)?;
        let created = env
            .taxonomy_service()
            .create_category(args.category)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        Ok(AgentToolResult {
            content: json!({ "created": created }),
        })
    }
}
