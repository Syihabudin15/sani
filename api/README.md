# Syrel Analysis API

The API uses TypeScript and Fastify. News is aggregated from the public RSS
feeds provided by CoinDesk and Cointelegraph; no CoinMarketCap API key or paid
subscription is required.

Prisma ORM 7 is configured for MySQL/MariaDB using the MariaDB driver adapter.
The RBAC schema contains users, roles, permissions, role-permission assignments,
hashed opaque sessions, and persisted market signals. Passwords are Argon2id
hashes; session tokens are stored as SHA-256 hashes and sent to the browser
only in HTTP-only cookies.

```text
src/
  config/
    env.ts
  modules/
    news/
      news.mapper.ts
      news.route.ts
      news.service.ts
      news.types.ts
    signals/
      signals.plugin.ts
      signals.route.ts
      signals.service.ts
    smartmoney/
      smartmoney.plugin.ts
      smartmoney.route.ts
      smartmoney.service.ts
    auth/
    roles/
    users/
  plugins/
    auth.plugin.ts
    prisma.plugin.ts
prisma/
  schema.prisma
  seed.ts
  app.ts
  server.ts
```

## Local development

1. Copy `.env.example` to `.env`. Set `DATABASE_URL` to your MySQL credentials,
   plus a unique `INITIAL_ADMIN_USERNAME` and a strong
   `INITIAL_ADMIN_PASSWORD` (at least 12 characters). Never commit `.env`.
   Create the database first if it does not exist:

   ```sql
   CREATE DATABASE syrel_analysis
     CHARACTER SET utf8mb4
     COLLATE utf8mb4_unicode_ci;
   ```

   No CoinMarketCap API key is required.
2. Install API dependencies and start the development server from this folder:

   ```powershell
   pnpm install
   pnpm run db:migrate -- --name init
   pnpm db:seed
   pnpm dev
   ```

   `db:migrate` creates and applies the migration; `db:seed` creates the
   Administrator role, the permission catalog, and the initial admin account.
   Seed is safe to repeat and does not reset an existing admin password.
   MySQL must be running, and the database user must be allowed to create
   tables and the shadow database used by Prisma Migrate.
3. In another terminal, start the UI:

   ```powershell
   cd ..\ui
   pnpm dev
   ```

The Vite development server proxies `/api` requests to `http://127.0.0.1:3001`.
The news endpoint is `GET /api/news`; the UI refreshes it every five minutes.
Feed attribution links to the original publisher. Feed availability and
content are subject to each publisher's RSS terms and service.

## Accumulation and distribution signals

The API scans every Binance Spot pair quoted in USDT. Short signals use 1-hour
candles and Swing signals use 4-hour candles. A signal is detected when the
net taker-buy/sell imbalance over the last three closed candles is at least
15% of base-asset volume and quote volume is at least 1.5 times the recent
baseline. Scans run every 15 minutes by default; set
`SIGNALS_SCAN_INTERVAL_MINUTES` (1-720) to change the interval.

Active signals are stored in `trade_signals` and remain visible while they
continue meeting the validation thresholds. A signal is marked invalidated
when a successful scan confirms that it no longer meets those thresholds; a
failed or incomplete market-data request does not invalidate it. If the flow
changes direction, the old signal is invalidated and a new one is recorded.
The UI shows the signed net flow in base coins and estimated USDT, flow ratios,
duration, and the flow amount as a percentage of total, max, and circulating
supply when available. Supply estimates are sourced from CoinPaprika and
refreshed hourly. If CoinPaprika omits circulating supply, it is estimated
from market capitalization divided by quoted price.

These are exchange taker-flow estimates, not wallet/on-chain accumulation,
investor holdings, or trading recommendations. Binance and CoinPaprika public
endpoints are rate-limited and may not provide complete coverage for every
asset. The routes are `GET /api/signals/accumulation?style=SHORT` and
`GET /api/signals/distribution?style=SWING`; each requires its matching
`akumulasi:view` or `distribusi:view` permission.

## SmartMoney large trades

SmartMoney monitors Binance Spot USDT aggregate trades with a notional value
of at least $100,000 USDT. It scans every active Spot USDT pair every 15 minutes
by default; configure `SMARTMONEY_SCAN_INTERVAL_MINUTES` (1-720) to change the
interval. Trades are deduplicated by symbol and Binance aggregate-trade ID and
stored in `smart_money_trades` for seven days. The API summarizes taker-buy and
taker-sell volume and serves up to 500 latest rows through
`GET /api/smartmoney/trades`; the UI requests up to 200 rows and refreshes
every minute. Access requires `smartmoney:view`.

The public aggregate-trade feed does not identify a trader, wallet, or whether
the trader is profitable. “SmartMoney” is a monitoring label for large
exchange transactions only, not verified institutional or whale activity.
This initial version does not scan on-chain wallets. To add on-chain tracking,
provide a public wallet watchlist for the desired Bitcoin, Ethereum, and/or
Solana networks; wallet addresses cannot be inferred reliably from free public
market data.

Apply the database migration after updating the code:

```powershell
pnpm run db:deploy
```

## Dashboard overview

`GET /api/dashboard/overview` returns active accumulation/distribution counts,
the latest active signals, and 24-hour large-trade totals and latest trades.
Sections are queried and returned only when the authenticated role has the
corresponding `akumulasi:view`, `distribusi:view`, or `smartmoney:view`
permission. The dashboard route requires `dashboard:view`; its UI refreshes
the summary every minute.

After updating the code, apply the new migration before starting the API:

```powershell
pnpm run db:deploy
```

Authentication endpoints are `POST /api/auth/login`, `GET /api/auth/me`, and
`POST /api/auth/logout`. Access is checked on the API for each request using
`<menu>:<action>` permissions, for example `berita:view` and
`data-pengguna:update`. The role-management UI only controls permissions from
the seeded catalog. The system Administrator role is protected from editing or
deletion; system administrator accounts cannot be disabled, deleted, or moved
to another role, and only a system administrator can assign that role.

Cookies use `SameSite=Lax`, `HttpOnly`, and the `/api` path. `Secure` is enabled
when `NODE_ENV=production`. Set `SESSION_TTL_HOURS` (1-720) to configure the
normal session lifetime; the optional “Ingat saya” login lasts up to 30 days.

## Production

Build and run the compiled server:

```powershell
pnpm build
pnpm start
```

Apply committed migrations in production with `pnpm db:deploy`. Use
`pnpm db:studio` to inspect data during development. For an existing MySQL
schema, introspect it with `pnpm exec prisma db pull` before creating migrations.
Set `NODE_ENV=production` behind HTTPS so session cookies are marked Secure.

Configure the web server or reverse proxy to forward `/api/*` to this server on
the same origin as the UI.
