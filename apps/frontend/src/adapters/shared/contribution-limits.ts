// Contribution Limits Commands
import type {
  ContributionLimit,
  ContributionLimitDetails,
  NewContributionLimit,
  DepositsCalculation,
} from "@/lib/types";

import { invoke } from "./platform";

export const getContributionLimit = async (): Promise<ContributionLimit[]> => {
  return invoke<ContributionLimit[]>("get_contribution_limits");
};

export const createContributionLimit = async (
  newLimit: NewContributionLimit,
): Promise<ContributionLimit> => {
  return invoke<ContributionLimit>("create_contribution_limit", { newLimit });
};

export const updateContributionLimit = async (
  id: string,
  updatedLimit: NewContributionLimit,
): Promise<ContributionLimit> => {
  return invoke<ContributionLimit>("update_contribution_limit", { id, updatedLimit });
};

export const deleteContributionLimit = async (id: string): Promise<void> => {
  return invoke<void>("delete_contribution_limit", { id });
};

export const calculateDepositsForLimit = async (limitId: string): Promise<DepositsCalculation> => {
  return invoke<DepositsCalculation>("calculate_deposits_for_contribution_limit", { limitId });
};

export const getContributionLimitDetails = async (
  limitId: string,
): Promise<ContributionLimitDetails> => {
  return invoke<ContributionLimitDetails>("get_contribution_limit_details", { limitId });
};

export const setContributionActivityExcluded = async (
  limitId: string,
  activityId: string,
  excluded: boolean,
): Promise<void> => {
  return invoke<void>("set_contribution_activity_excluded", { limitId, activityId, excluded });
};
