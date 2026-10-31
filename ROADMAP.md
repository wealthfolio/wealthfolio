# Wealthfolio Roadmap

## Vision

To help individuals build their wealth by providing a safe, privacy-focused and
easy-to-use tool to track their investments, net worth, spending and goals.

## Strategy

1. Build a polished application that does the essentials well
2. Simple by default: advanced features are opt-in and stay out of the way
3. Go deeper on what people already track before adding new areas
4. Fight feature creep: every feature has to earn its place
5. Provide clear insights on how your wealth is tracking against your goals

## What We Believe In

1. **Your Privacy**: Your money info stays on your computer. You retain complete
   control over your financial information.
2. **Easy to Use**: Anyone can track their investments with our simple design.
3. **No Lock-in**: Free or pay once to support. Wealthfolio Connect as optional
   paid subscription to sync broker data and devices.
4. **Extensible**: Through the addons system and catalog, users can easily
   enhance functionality.
5. **Beautiful and Focused**: We believe in crafting an app that's visually
   appealing yet doesn't distract from its core purpose.

## Roadmap

### Phase 1: Foundation (Completed)

- [x] Track investments across multiple accounts
- [x] Local-first data storage (SQLite)
- [x] Simple, intuitive design
- [x] Multi-currency support with exchange rates
- [x] Performance analytics and historical tracking

### Phase 2: Core Features (Completed)

- [x] Data export (CSV, SQLite, JSON)
- [x] Multiple market data providers (Yahoo Finance, Alpha Vantage,
      MarketData.app, Finnhub, Börse Frankfurt, AMFI, Metal Price API)
- [x] Stock split handling
- [x] Enhanced portfolio history calculation
- [x] Cross-platform builds (Windows, macOS, Linux)
- [x] Advanced CSV import with field mapping
- [x] Addons system for extending functionality

### Phase 3: Multi-Platform (Completed)

- [x] Self-hosted web app with Docker support
- [x] REST API server (Axum)
- [x] Mobile apps (iOS and Android via Tauri)
- [x] Wealthfolio Connect: Device sync with end-to-end encryption (E2EE)
- [x] Wealthfolio Connect: broker data sync service
- [x] Wealthfolio Connect: encrypted cloud backups

### Phase 4: Investment and Wealth Tracking (Completed)

- [x] Liabilities and debt tracking
- [x] Loans and mortgages with amortization schedules
- [x] Alternative assets (real estate, vehicles, collectibles)
- [x] Options trading support
- [x] Track short positions (stocks, ETFs and options)
- [x] Cost basis methods per account (FIFO, weighted average, LIFO, HIFO)

### Phase 5: Smart Tools (Completed)

- [x] AI assistant (local models via Ollama or an OpenAI-compatible server such
      as LM Studio, or your own key for OpenAI, Anthropic, Google Gemini, Groq
      or OpenRouter)
- [x] Save-up goals simulation
- [x] Retirement/FIRE simulator

### Phase 6: Ecosystem (Completed)

- [x] Addons catalog/marketplace for community addons
- [x] Custom Market Data providers

### Phase 7: Budgeting and Spend Tracking (Completed)

- [x] Budgeting and spend tracking (categories, rules, budgets, events and
      insights)

### Phase 8: Platform Expansion (Completed)

- [x] MCP server for AI agents (AI Agent Access)
- [x] Create and manage multiple portfolios
- [x] Portfolio Allocation and Rebalancing
- [x] Android Mobile app
- [x] SSO in self-hosted version (OpenID Connect)
- [x] Separate profiles with app lock
- [x] Optional database encryption and password-protected backups
- [x] 11 languages, including right-to-left Arabic

### Up Next

- [ ] CLI for agents
- [ ] Margin accounts
- [ ] Cross-account cost basis (ACB) and specific-lot selection

### Always Doing

- Keeping the app safe and up-to-date
- Performance improvements based on user feedback
- Security audits and privacy enhancements

---

We're building Wealthfolio to be a great alternative to online investment
trackers. Our plan might change based on what users tell us they want, but we'll
always focus on keeping your data private and helping you manage your money
better.

Ideas and feedback welcome - open an issue or join our
[Discord](https://discord.gg/WDMCY6aPWK).
