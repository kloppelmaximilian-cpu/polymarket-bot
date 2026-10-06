"""Database schema.

SQLite by default (zero setup, good enough for a single bot instance), but the
DDL is deliberately plain SQL with no SQLite-specific types beyond the flexible
affinity, so the same statements run on PostgreSQL and DuckDB with only the
autoincrement idiom changed.  All timestamps are epoch seconds (REAL, UTC) --
never local time, never a string format that needs parsing.

Everything the bot decides is recorded, because the whole point of the audit
trail is to answer, weeks later, *why* a specific trade happened.
"""

from __future__ import annotations

SCHEMA_VERSION = 1

TABLES: dict[str, str] = {
    "schema_meta": """
        CREATE TABLE IF NOT EXISTS schema_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """,
    "markets": """
        CREATE TABLE IF NOT EXISTS markets (
            market_id         TEXT PRIMARY KEY,
            condition_id      TEXT NOT NULL,
            question_id       TEXT,
            slug              TEXT,
            asset             TEXT NOT NULL,
            title             TEXT,
            series_slug       TEXT,
            window_start      REAL NOT NULL,
            window_end        REAL NOT NULL,
            up_token_id       TEXT NOT NULL,
            down_token_id     TEXT NOT NULL,
            tick_size         REAL,
            min_order_size    REAL,
            neg_risk          INTEGER,
            taker_fee_rate    REAL,
            maker_fee_rate    REAL,
            fee_type          TEXT,
            resolution_source TEXT,
            discovered_at     REAL NOT NULL,
            resolved_outcome  TEXT,
            resolved_at       REAL,
            strike_price      REAL,
            settle_price      REAL
        )
    """,
    "market_states": """
        CREATE TABLE IF NOT EXISTS market_states (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            ts            REAL NOT NULL,
            market_id     TEXT NOT NULL,
            active        INTEGER,
            closed        INTEGER,
            accepting     INTEGER,
            liquidity     REAL,
            volume        REAL,
            best_bid      REAL,
            best_ask      REAL,
            last_trade    REAL
        )
    """,
    "book_snapshots": """
        CREATE TABLE IF NOT EXISTS book_snapshots (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ts           REAL NOT NULL,
            market_id    TEXT NOT NULL,
            token_id     TEXT NOT NULL,
            outcome      TEXT,
            best_bid     REAL,
            best_ask     REAL,
            bid_size     REAL,
            ask_size     REAL,
            mid          REAL,
            spread       REAL,
            microprice   REAL,
            imbalance    REAL,
            depth_bid    REAL,
            depth_ask    REAL,
            liquidity    REAL,
            levels       INTEGER,
            book_age     REAL
        )
    """,
    "public_trades": """
        CREATE TABLE IF NOT EXISTS public_trades (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        REAL NOT NULL,
            market_id TEXT,
            token_id  TEXT NOT NULL,
            price     REAL NOT NULL,
            size      REAL NOT NULL,
            side      TEXT
        )
    """,
    "features": """
        CREATE TABLE IF NOT EXISTS features (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            ts            REAL NOT NULL,
            market_id     TEXT NOT NULL,
            asset         TEXT NOT NULL,
            window_start  REAL,
            window_end    REAL,
            spot          REAL,
            strike        REAL,
            data_quality  REAL,
            payload       TEXT NOT NULL
        )
    """,
    "predictions": """
        CREATE TABLE IF NOT EXISTS predictions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts              REAL NOT NULL,
            market_id       TEXT NOT NULL,
            asset           TEXT NOT NULL,
            probability_up  REAL NOT NULL,
            confidence      REAL,
            uncertainty     REAL,
            regime          TEXT,
            analytic_up     REAL,
            ml_up           REAL,
            implied_up      REAL,
            calibrated      INTEGER,
            model_version   TEXT,
            decision        TEXT
        )
    """,
    "signals": """
        CREATE TABLE IF NOT EXISTS signals (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            ts             REAL NOT NULL,
            market_id      TEXT NOT NULL,
            strategy       TEXT NOT NULL,
            probability_up REAL,
            confidence     REAL,
            abstain        INTEGER,
            reason         TEXT
        )
    """,
    "opportunities": """
        CREATE TABLE IF NOT EXISTS opportunities (
            opportunity_id   TEXT PRIMARY KEY,
            ts               REAL NOT NULL,
            market_id        TEXT NOT NULL,
            asset            TEXT NOT NULL,
            outcome          TEXT NOT NULL,
            decision         TEXT NOT NULL,
            entry_price      REAL,
            model_probability REAL,
            market_probability REAL,
            gross_edge       REAL,
            fee_cost         REAL,
            slippage_cost    REAL,
            net_edge         REAL,
            required_edge    REAL,
            size_shares      REAL,
            notional         REAL,
            expected_value   REAL,
            score            REAL,
            confidence       REAL,
            regime           TEXT,
            seconds_remaining REAL,
            reasons          TEXT,
            blockers         TEXT,
            book_state       TEXT,
            risk_state       TEXT
        )
    """,
    "orders": """
        CREATE TABLE IF NOT EXISTS orders (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts              REAL NOT NULL,
            client_id       TEXT NOT NULL,
            order_id        TEXT,
            opportunity_id  TEXT,
            market_id       TEXT NOT NULL,
            token_id        TEXT NOT NULL,
            asset           TEXT,
            outcome         TEXT,
            side            TEXT NOT NULL,
            kind            TEXT,
            post_only       INTEGER,
            price           REAL NOT NULL,
            size            REAL NOT NULL,
            state           TEXT NOT NULL,
            filled_size     REAL,
            avg_price       REAL,
            fees            REAL,
            error           TEXT,
            mode            TEXT,
            finalised_at    REAL
        )
    """,
    "fills": """
        CREATE TABLE IF NOT EXISTS fills (
            fill_id    TEXT PRIMARY KEY,
            ts         REAL NOT NULL,
            order_id   TEXT,
            client_id  TEXT,
            market_id  TEXT,
            token_id   TEXT NOT NULL,
            side       TEXT NOT NULL,
            price      REAL NOT NULL,
            size       REAL NOT NULL,
            fee        REAL,
            is_maker   INTEGER
        )
    """,
    "positions": """
        CREATE TABLE IF NOT EXISTS positions (
            position_id       TEXT PRIMARY KEY,
            market_id         TEXT NOT NULL,
            condition_id      TEXT,
            asset             TEXT NOT NULL,
            outcome           TEXT NOT NULL,
            token_id          TEXT NOT NULL,
            size              REAL NOT NULL,
            avg_price         REAL NOT NULL,
            fees_paid         REAL,
            opened_at         REAL NOT NULL,
            window_end        REAL,
            opportunity_id    TEXT,
            strategy          TEXT,
            regime            TEXT,
            entry_edge        REAL,
            entry_confidence  REAL,
            entry_model_prob  REAL,
            entry_market_prob REAL,
            closed_at         REAL,
            exit_price        REAL,
            realized_pnl      REAL,
            resolution        TEXT
        )
    """,
    "pnl_snapshots": """
        CREATE TABLE IF NOT EXISTS pnl_snapshots (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts              REAL NOT NULL,
            bankroll        REAL,
            equity          REAL,
            peak_equity     REAL,
            open_exposure   REAL,
            realized_pnl    REAL,
            unrealized_pnl  REAL,
            daily_pnl       REAL,
            open_positions  INTEGER,
            drawdown        REAL,
            trades          INTEGER,
            win_rate        REAL
        )
    """,
    "strategy_performance": """
        CREATE TABLE IF NOT EXISTS strategy_performance (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ts           REAL NOT NULL,
            strategy     TEXT NOT NULL,
            regime       TEXT,
            n            INTEGER,
            ewma_brier   REAL,
            skill        REAL,
            wins         INTEGER,
            losses       INTEGER,
            weight       REAL,
            pnl          REAL
        )
    """,
    "model_performance": """
        CREATE TABLE IF NOT EXISTS model_performance (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            ts            REAL NOT NULL,
            model_version TEXT,
            n             INTEGER,
            brier         REAL,
            brier_skill   REAL,
            log_loss      REAL,
            ece           REAL,
            auc           REAL,
            payload       TEXT
        )
    """,
    "risk_events": """
        CREATE TABLE IF NOT EXISTS risk_events (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        REAL NOT NULL,
            kind      TEXT NOT NULL,
            severity  TEXT,
            message   TEXT,
            detail    TEXT
        )
    """,
    "feed_health": """
        CREATE TABLE IF NOT EXISTS feed_health (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            ts               REAL NOT NULL,
            feed             TEXT NOT NULL,
            status           TEXT,
            latency_ms       REAL,
            messages_per_sec REAL,
            reconnects       INTEGER,
            errors           INTEGER,
            clock_drift_ms   REAL,
            score            REAL,
            detail           TEXT
        )
    """,
    "errors": """
        CREATE TABLE IF NOT EXISTS errors (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        REAL NOT NULL,
            component TEXT NOT NULL,
            kind      TEXT,
            message   TEXT,
            detail    TEXT
        )
    """,
    "audit_events": """
        CREATE TABLE IF NOT EXISTS audit_events (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        REAL NOT NULL,
            kind      TEXT NOT NULL,
            market_id TEXT,
            payload   TEXT NOT NULL
        )
    """,
    "backtest_runs": """
        CREATE TABLE IF NOT EXISTS backtest_runs (
            run_id      TEXT PRIMARY KEY,
            ts          REAL NOT NULL,
            label       TEXT,
            config      TEXT,
            seed        INTEGER,
            code_commit TEXT,
            dataset     TEXT,
            metrics     TEXT
        )
    """,
}

INDEXES: list[str] = [
    "CREATE INDEX IF NOT EXISTS idx_markets_window ON markets(window_end)",
    "CREATE INDEX IF NOT EXISTS idx_markets_asset ON markets(asset, window_start)",
    "CREATE INDEX IF NOT EXISTS idx_book_market_ts ON book_snapshots(market_id, ts)",
    "CREATE INDEX IF NOT EXISTS idx_features_market_ts ON features(market_id, ts)",
    "CREATE INDEX IF NOT EXISTS idx_features_ts ON features(ts)",
    "CREATE INDEX IF NOT EXISTS idx_predictions_market_ts ON predictions(market_id, ts)",
    "CREATE INDEX IF NOT EXISTS idx_signals_market_ts ON signals(market_id, ts)",
    "CREATE INDEX IF NOT EXISTS idx_opportunities_ts ON opportunities(ts)",
    "CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts)",
    "CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id)",
    "CREATE INDEX IF NOT EXISTS idx_fills_ts ON fills(ts)",
    "CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed_at)",
    "CREATE INDEX IF NOT EXISTS idx_pnl_ts ON pnl_snapshots(ts)",
    "CREATE INDEX IF NOT EXISTS idx_trades_token_ts ON public_trades(token_id, ts)",
    "CREATE INDEX IF NOT EXISTS idx_feed_health_ts ON feed_health(ts)",
    "CREATE INDEX IF NOT EXISTS idx_risk_events_ts ON risk_events(ts)",
]

#: Tables whose primary key is supplied by us, so a re-insert should replace.
UPSERT_TABLES = {"markets", "positions", "opportunities", "fills", "backtest_runs", "schema_meta"}
