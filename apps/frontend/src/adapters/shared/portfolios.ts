import type { NewPortfolio, PortfolioWithAccounts } from "@/lib/types";
import { invoke, logger } from "./platform";

export const getPortfolios = async (): Promise<PortfolioWithAccounts[]> => {
  try {
    return await invoke<PortfolioWithAccounts[]>("get_portfolios");
  } catch (error) {
    logger.error("Error fetching portfolios.");
    throw error;
  }
};

export const createPortfolio = async (portfolio: NewPortfolio): Promise<PortfolioWithAccounts> => {
  try {
    return await invoke<PortfolioWithAccounts>("create_portfolio", { portfolio });
  } catch (error) {
    logger.error("Error creating portfolio.");
    throw error;
  }
};

export const updatePortfolioEntry = async (
  portfolio: PortfolioWithAccounts,
): Promise<PortfolioWithAccounts> => {
  try {
    return await invoke<PortfolioWithAccounts>("update_portfolio_entry", { portfolio });
  } catch (error) {
    logger.error("Error updating portfolio.");
    throw error;
  }
};

export const deletePortfolio = async (portfolioId: string): Promise<void> => {
  try {
    await invoke<void>("delete_portfolio_entry", { portfolioId });
  } catch (error) {
    logger.error("Error deleting portfolio.");
    throw error;
  }
};
