"""Central configuration.

Every operationally meaningful parameter lives here and is overridable through
environment variables (or a ``.env`` file).  Nothing that affects trading
behaviour is hard-coded elsewhere in the code base.

Safety invariant: ``TRADING_MODE`` defaults to ``paper``.  Live trading requires
*both* ``TRADING_MODE=live`` *and* ``LIVE_CONFIRMATION=true``, plus credentials.
"""

from __future__ import annotations

import json
from enum import Enum
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class TradingMode(str, Enum):
    PAPER = "paper"
    LIVE = "live"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ------------------------------------------------------------------ mode
    trading_mode: TradingMode = Field(
        default=TradingMode.PAPER,
        description="paper | live.  Live additionally requires live_confirmation.",
    )
    live_confirmation: bool = Field(
        default=False,
        description="Second safety switch. Live orders are impossible without it.",
    )
    dry_run_live: bool = Field(
        default=False,
        description="In live mode, build+validate orders but never POST them.",
    )

    # ------------------------------------------------------------- endpoints
    gamma_base_url: str = "https://gamma-api.polymarket.com"
    clob_base_url: str = "https://clob.polymarket.com"
    data_api_base_url: str = "https://data-api.polymarket.com"
    clob_ws_market_url: str = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
    clob_ws_user_url: str = "wss://ws-subscriptions-clob.polymarket.com/ws/user"
    polygon_chain_id: int = 137

    # ----------------------------------------------------------- credentials
    polymarket_private_key: SecretStr | None = None
    polymarket_api_key: SecretStr | None = None
    polymarket_api_secret: SecretStr | None = None
    polymarket_api_passphrase: SecretStr | None = None
    polymarket_funder: str | None = Field(
        default=None, description="Proxy wallet address holding the USDC."
    )
    polymarket_signature_type: int = Field(
        default=2, description="0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE"
    )

    # --------------------------------------------------------------- markets
    assets: list[str] = Field(
        default_factory=lambda: ["BTC", "ETH", "SOL", "XRP", "DOGE"],
        description="Assets to hunt for 5-minute up/down markets.",
    )
    series_slug_templates: list[str] = Field(
        default_factory=lambda: [
            "{asset_lower}-up-or-down-5m",
            "{asset_lower}-updown-5m",
        ],
        description="Gamma series slugs probed per asset (first hit wins).",
    )
    market_window_seconds: int = 300
    discovery_interval_seconds: float = 20.0
    discovery_lookahead_seconds: int = Field(
        default=900,
        description="Also track markets whose window starts within this horizon.",
    )
    max_tracked_markets: int = 40

    # ------------------------------------------------------- market quality
    max_spread: float = Field(default=0.03, description="Max |ask-bid| in probability.")
    min_liquidity_usd: float = Field(
        default=200.0, description="Min resting notional within the usable band."
    )
    min_top_of_book_shares: float = 5.0
    max_slippage: float = Field(
        default=0.02, description="Max tolerated price impact for the intended size."
    )
    min_seconds_remaining: float = Field(
        default=20.0, description="Never open a position with less time left."
    )
    max_seconds_remaining: float = Field(
        default=270.0,
        description="Skip the very start of the window (strike not yet stable).",
    )
    stale_book_seconds: float = 5.0

    # -------------------------------------------------------------- signals
    min_edge: float = Field(
        default=0.025,
        description="Minimum net edge (after fees/spread/slippage) in probability.",
    )
    min_confidence: float = Field(default=0.55, description="Min model confidence 0..1.")
    min_model_agreement: float = Field(
        default=0.5, description="Min fraction of strategies agreeing on direction."
    )
    edge_uncertainty_multiple: float = Field(
        default=1.0,
        description="Required edge also has to exceed k * model std-error.",
    )
    probability_floor: float = 0.02
    probability_cap: float = 0.98
    max_plausible_edge: float = Field(
        default=0.12,
        description=(
            "Net edges above this are treated as model error, not opportunity: "
            "a huge disagreement with a liquid market is usually our bug."
        ),
    )
    market_anchor_weight: float = Field(
        default=0.35,
        description=(
            "Weight on our model vs the market's own price in the final "
            "probability. The market is a well-informed prior; betting the raw "
            "model against it is how a model with real average skill still "
            "loses money. Fit with `fit_anchor_weight` once data exists."
        ),
    )
    adaptive_anchor: bool = Field(
        default=True,
        description="Let measured relative skill move the anchor weight.",
    )
    anchor_weight_uncertainty: float = Field(
        default=0.10,
        description=(
            "Standard error of MARKET_ANCHOR_WEIGHT itself. This is the only "
            "extra uncertainty the market anchor adds; charging the whole "
            "disagreement would double-count the shrinkage and stop all trading."
        ),
    )

    # ------------------------------------------------------------- exchanges
    exchanges: list[str] = Field(
        default_factory=lambda: ["binance", "coinbase", "kraken", "okx", "bybit"]
    )
    min_healthy_exchanges: int = Field(
        default=2, description="Below this, the composite price is not trusted."
    )
    feed_stale_seconds: float = 3.0
    feed_divergence_bps: float = Field(
        default=25.0, description="Cross-exchange divergence that flags a problem."
    )
    ws_reconnect_base_delay: float = 1.0
    ws_reconnect_max_delay: float = 30.0
    ws_ping_interval: float = 10.0

    # ---------------------------------------------------------------- oracle
    resolution_oracle: Literal["chainlink", "composite"] = Field(
        default="composite",
        description=(
            "Markets resolve on the Chainlink data stream. 'composite' uses the "
            "CEX composite as a proxy and adds basis uncertainty to the model."
        ),
    )
    chainlink_streams_url: str | None = None
    chainlink_api_key: SecretStr | None = None
    chainlink_api_secret: SecretStr | None = None
    oracle_basis_bps: float = Field(
        default=2.0,
        description="Assumed std-dev of proxy-vs-oracle basis, in bps of price.",
    )

    # ------------------------------------------------------------------ fees
    # fee = shares * fee_rate * p * (1-p); takers only, makers rebate.
    default_taker_fee_rate: float = 0.07
    default_maker_fee_rate: float = 0.0
    maker_rebate_rate: float = Field(
        default=0.0,
        description="Conservatively 0: rebates are pool-shared and not guaranteed.",
    )

    # ------------------------------------------------------------------ risk
    bankroll: float = Field(default=1000.0, description="Paper starting bankroll USDC.")
    max_stake_per_trade: float = 25.0
    max_stake_fraction: float = Field(
        default=0.02, description="Cap as a fraction of current bankroll."
    )
    kelly_fraction: float = Field(default=0.25, description="Fractional Kelly.")
    max_portfolio_exposure: float = 200.0
    max_simultaneous_positions: int = 6
    max_positions_per_asset: int = 2
    max_positions_per_market: int = 1
    max_asset_exposure: float = 100.0
    max_correlated_exposure: float = Field(
        default=150.0, description="Crypto is one correlation bucket."
    )
    max_daily_loss: float = 100.0
    max_session_loss: float = 150.0
    max_consecutive_losses: int = 8
    max_drawdown: float = Field(default=0.25, description="Fraction of peak equity.")
    risk_pause_seconds: float = 300.0
    min_order_notional: float = 1.0

    # --------------------------------------------------------------- sizing
    sizing_method: Literal["kelly", "fixed", "edge_proportional"] = "kelly"

    # ------------------------------------------------------------ execution
    execution_style: Literal["taker", "maker_then_taker", "maker"] = "maker_then_taker"
    maker_wait_seconds: float = Field(
        default=20.0, description="How long a passive order rests before escalation."
    )
    order_timeout_seconds: float = 30.0
    max_order_retries: int = 2
    allow_partial_fills: bool = True
    paper_latency_ms: float = Field(
        default=250.0, description="Simulated round-trip latency for paper fills."
    )
    paper_maker_fill_ratio: float = Field(
        default=0.45,
        description="Probability a resting paper order gets filled when touched.",
    )
    paper_queue_model: Literal["optimistic", "realistic"] = "realistic"

    # -------------------------------------------------------------- strategy
    enabled_strategies: list[str] = Field(
        default_factory=lambda: [
            "fair_value",
            "momentum",
            "mean_reversion",
            "order_flow",
            "breakout",
            "volatility",
            "cross_exchange",
            "microstructure",
            "ml",
        ]
    )
    strategy_weight_halflife: float = Field(
        default=200.0, description="Trades; adaptive weighting half-life."
    )
    adaptive_weights: bool = True
    min_strategy_weight: float = 0.2
    max_strategy_weight: float = 2.0

    # --------------------------------------------------------------- models
    model_dir: Path = REPO_ROOT / "models"
    model_name: str = "ensemble_v1"
    calibration_method: Literal["isotonic", "platt", "none"] = "isotonic"
    ml_enabled: bool = True
    ml_blend_weight: float = Field(
        default=0.5, description="Weight of ML vs analytic fair value when available."
    )
    min_calibration_samples: int = 500

    # ------------------------------------------------------------- database
    database_url: str = f"sqlite:///{REPO_ROOT / 'data' / 'pmbot.db'}"
    db_flush_interval_seconds: float = 2.0
    db_batch_size: int = 200
    snapshot_interval_seconds: float = Field(
        default=1.0, description="Orderbook/feature snapshot cadence for training data."
    )
    record_training_data: bool = True

    # -------------------------------------------------------------- logging
    log_level: str = "INFO"
    log_dir: Path = REPO_ROOT / "logs"
    log_json: bool = True

    # --------------------------------------------------------------- alerts
    telegram_enabled: bool = False
    telegram_bot_token: SecretStr | None = None
    telegram_chat_id: str | None = None

    # ------------------------------------------------------------ dashboard
    dashboard_refresh_hz: float = 2.0

    # ---------------------------------------------------------- reproducible
    random_seed: int = 42

    # ----------------------------------------------------------- validators
    @field_validator("assets", "exchanges", "enabled_strategies", "series_slug_templates", mode="before")
    @classmethod
    def _split_csv(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                return json.loads(v)
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @field_validator("assets")
    @classmethod
    def _upper_assets(cls, v: list[str]) -> list[str]:
        return [a.strip().upper() for a in v]

    @model_validator(mode="after")
    def _check_live_safety(self) -> Settings:
        if self.trading_mode is TradingMode.LIVE and not self.live_confirmation:
            raise ValueError(
                "TRADING_MODE=live requires LIVE_CONFIRMATION=true. "
                "Refusing to start in an ambiguous live configuration."
            )
        if self.min_seconds_remaining >= self.max_seconds_remaining:
            raise ValueError("min_seconds_remaining must be < max_seconds_remaining")
        if not 0.0 < self.kelly_fraction <= 1.0:
            raise ValueError("kelly_fraction must be in (0, 1]")
        return self

    # ------------------------------------------------------------- helpers
    @property
    def is_live(self) -> bool:
        return self.trading_mode is TradingMode.LIVE and self.live_confirmation

    @property
    def sqlite_path(self) -> Path | None:
        if self.database_url.startswith("sqlite:///"):
            return Path(self.database_url[len("sqlite:///") :])
        return None

    def has_live_credentials(self) -> bool:
        return self.polymarket_private_key is not None

    def redacted_dict(self) -> dict[str, Any]:
        """Config snapshot safe for logs, audit records and backtest manifests."""
        out: dict[str, Any] = {}
        for name, value in self.model_dump().items():
            field = type(self).model_fields.get(name)
            annotation = getattr(field, "annotation", None) if field else None
            if isinstance(value, SecretStr) or (
                annotation is not None and "SecretStr" in str(annotation)
            ):
                out[name] = "***" if value is not None else None
            elif isinstance(value, Path):
                out[name] = str(value)
            elif isinstance(value, Enum):
                out[name] = value.value
            else:
                out[name] = value
        return out


_settings: Settings | None = None


def get_settings(reload: bool = False, **overrides: Any) -> Settings:
    """Process-wide settings singleton (``reload=True`` for tests)."""
    global _settings
    if _settings is None or reload or overrides:
        _settings = Settings(**overrides)
    return _settings


def reset_settings() -> None:
    global _settings
    _settings = None
