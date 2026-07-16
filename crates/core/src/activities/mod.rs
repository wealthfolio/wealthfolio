//! Activities module - domain models, services, and traits.

mod activities_constants;
mod activities_errors;
mod activities_model;
mod activities_service;
mod activities_traits;
mod compiler;
mod csv_parser;
mod idempotency;
mod import_run_model;
mod transfer_pairs;

#[cfg(test)]
mod activities_service_tests;

#[cfg(test)]
mod activities_model_tests;

pub use activities_constants::*;
pub use activities_errors::ActivityError;
pub use activities_model::import_type;
pub use activities_model::{
    into_field_mapping_values, normalize_context_kind_value, parse_decimal_string_tolerant,
    Activity, ActivityBulkIdentifierMapping, ActivityBulkMutationError,
    ActivityBulkMutationRequest, ActivityBulkMutationResult, ActivityDetails, ActivityImport,
    ActivitySearchResponse, ActivitySearchResponseMeta, ActivityStatus, ActivityType,
    ActivityUpdate, ActivityUpsert, AssetResolutionInput, BrokerActivityProfileConfig,
    BrokerProfileScope, BrokerSyncProfileData, BulkUpsertResult, FieldMappingValue,
    ImportActivitiesResult, ImportActivitiesSummary, ImportAssetCandidate, ImportAssetPreviewItem,
    ImportAssetPreviewStatus, ImportMapping, ImportMappingData, ImportTemplate, ImportTemplateData,
    ImportTemplateScope, IncomeData, InternalTransferPairRequest, InternalTransferPairResponse,
    NewActivity, PrepareActivitiesResult, SaveBrokerSyncProfileRulesRequest, Sort, TemplateKind,
    TransferMatchCandidate, TransferMatchCandidateRequest,
};
pub use activities_service::ActivityService;
pub use activities_traits::{ActivityRepositoryTrait, ActivityServiceTrait};
pub use compiler::{ActivityCompiler, DefaultActivityCompiler};
pub use csv_parser::{parse_csv, ParseConfig, ParseError, ParsedCsvResult};
pub use idempotency::{
    compute_activity_idempotency_key, compute_idempotency_key, generate_manual_idempotency_key,
};
pub use import_run_model::{
    ImportRun, ImportRunMode, ImportRunRepositoryTrait, ImportRunStatus, ImportRunSummary,
    ImportRunType, ReviewMode,
};
pub use transfer_pairs::{
    is_same_account_cash_fx_conversion, InvalidTransferGroup, TransferPair, TransferPairResolution,
};
