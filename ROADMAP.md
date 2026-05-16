# Wealthfolio Roadmap

## Vision

To help individuals build their wealth by providing a safe, privacy-focused and
easy-to-use tool to track their investments and goals.

## Strategy

1. Build a polished application that focuses on the essentials
2. Underdo the competition by offering a simpler, more focused alternative
3. Fight feature creep and resist creating a bloated app
4. Avoid complexity at all costs
5. Provide clear insights on how your portfolio is performing against your goals

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
- [x] Multiple market data providers (Yahoo Finance, Alpha Vantage, MarketData)
- [x] Stock split handling
- [x] Enhanced portfolio history calculation
- [x] Cross-platform builds (Windows, macOS, Linux)
- [x] Advanced CSV import with field mapping
- [x] Addons system for extending functionality

### Phase 3: Multi-Platform (Current - v3.0)

- [x] Self-hosted web app with Docker support
- [x] REST API server (Axum)
- [x] Mobile app (iOS/Android via Tauri)
- [x] Wealthfolio Connect: Device sync with end-to-end encryption (E2EE)
- [x] Wealthfolio Connect: broker data sync service

**Wealthfolio Connect** is an optional paid subscription to sustain development:

### Phase 4: Wealth Tracking

- [x] Liabilities and debt tracking
- [x] Alternative assets (real estate, vehicles, collectibles)
- [x] Options trading support
- [ ] Track short positions

### Phase 5: Smart Tools

- [x] AI assistant addon (local LLMs via Ollama/LM Studio, or BYOK for
      OpenAI/Anthropic)
- [ ] Portfolio analysis: sector allocation, concentration risk, dividend yield
- [ ] Monte Carlo projection for portfolio outcomes
- [x] Retirement/FIRE planner with withdrawal strategies

### Phase 6: Ecosystem

- [ ] Addons catalog/marketplace for community addons

### Phase 5: Budgeting and Spend Tracking

- [ ] Budgeting and Sprend tracking Module

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
