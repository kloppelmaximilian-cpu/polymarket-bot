# Strategies

## The common frame

A strategy does not output "BUY", and with one exception it does not output a
probability either. It outputs a **drift**: a tilt in units of the standard
deviation of the move still to come. The analytic pricer converts that to a
probability:

```
P(UP) = Phi(z + drift_sd)      where  z = ln(spot/strike) / sigma_total
```

This matters because "+0.5 sigma of momentum" means something completely
different with 240 seconds left than with 20, and different for BTC at
0.3%/5min than for DOGE at 1.5%. Routing every signal through the pricer makes
the time- and volatility-scaling automatic and consistent, and puts all nine
strategies on one comparable scale.

Each strategy is hard-capped at ±0.5 sigma. No five-minute signal deserves to
move a probability further than that on its own.

Every strategy can **abstain**, and most of them do most of the time. An
abstention is not a failure; it is the strategy saying its setup is not present.

---

## fair_value

The anchor. The analytic price of the digital given spot, strike, time remaining
and volatility, with zero drift. Every other strategy tilts away from this.

Confidence falls as basis and measurement noise come to dominate the remaining
diffusive move — which is what happens in the last seconds of a window, when a
naive implementation is most confident and most wrong.

The ensemble gives it a floor weight so it cannot be outvoted by a chorus of
weak signals.

## momentum

Short-horizon continuation, from 15/30/60-second returns each normalised by the
volatility scale it was drawn from.

Requires **two** conditions, not one:

- an efficient path (Kaufman efficiency ratio) — chop kills continuation
- confirming trade flow

An unsupported spike is a mean-reversion setup, not a momentum one, and the
strategy is explicitly scaled down when flow disagrees with price.

## mean_reversion

Fades fast, unsupported extensions. Fires only when all three hold:

- stretched (>1 sigma of 30-second move, or outside the Bollinger band)
- unsupported (flow imbalance below 0.25, or flow opposing the move)
- choppy (efficiency ratio below 0.35)

That conjunction is the microstructure signature of a liquidity air-pocket
rather than informed buying. Absent it, the strategy abstains.

## order_flow

Signed aggressor imbalance on the reference exchanges over 10/30/60 seconds.
The most direct observable of informed pressure and the shortest-horizon
predictor available.

Scaled up when the imbalance is *persistent* across all three horizons, and
when large trades are present. Abstains below five trades in 30 seconds — you
cannot read flow that is not there.

## breakout

Range escape with confirmation. Requires the price at a range extreme (>0.88 or
<0.12 of the window range), a range wide enough to be meaningful relative to
volatility, an efficient path, and flow that does not contradict the direction.

## volatility

Trades the market's volatility assumption rather than its direction. Inverting
the digital gives the volatility the market's own price implies; when that is
far from our realised-vol estimate, the *width* of the market's distribution is
wrong. An over-stated vol pushes every price toward 0.50, which underprices the
favourite.

Abstains when the two agree within ~20%, and when the price is too close to the
strike for implied vol to be identifiable.

## cross_exchange

Cross-venue dislocation. When one venue leads, the composite has not caught up
and the remaining convergence is a short, mechanical drift.

Requires at least three healthy venues. **Stands down** when dispersion is wide
relative to volatility — at that point the reference price is untrustworthy and
the strategy would be trading its own noise.

## microstructure

Reads the Polymarket book itself: depth imbalance, the microprice-vs-mid gap,
the change in imbalance, and prediction-market trade flow.

This is information about the counterparty, not about bitcoin, so it is
expressed as a tilt around the *market's* own de-vigged price rather than around
our fair value. Abstains on a book thinner than $50.

## mispricing

Direct model-versus-market disagreement. Inverting the market price yields the
strike the market is behaving as though it were trading against; when that
drifts far from the real strike, the market is stale — typically because a move
on the reference exchanges has not been repriced here yet.

Confidence is discounted when the model sits in a region where tiny price
changes swing the probability wildly.

## ml

A trained model as one more voice. It **abstains** when no artifact is loaded,
when the model was not calibrated, or when more than a quarter of its input
features are missing — a model extrapolating on median-imputed garbage is worse
than silence.

Its confidence is capped by the out-of-sample Brier skill recorded in its own
manifest, so a model that barely beat the base rate in validation cannot shout
down the analytic anchor in production.

---

## Regime detection

The meta-controller classifies the market before deciding whom to listen to.
Checks run from "something is wrong" to "this is ordinary", so a liquidity shock
is never mislabelled as a trend:

| Regime | Trigger |
|---|---|
| `UNSTABLE` | data quality below 0.5, or an unhealthy feed |
| `DIVERGENT` | cross-venue dispersion > 0.8 × window volatility |
| `LIQUIDITY_SHOCK` | book under the liquidity floor, or spread over 4 ticks |
| `ABNORMAL_VOL` | volatility > 2.8× its own slow baseline |
| `NEWS_LIKE` | jump component present with elevated volatility |
| `HIGH_VOL` / `LOW_VOL` | volatility outside 0.6–1.6× baseline |
| `TRENDING` / `RANGING` | efficiency ratio above 0.45 / below 0.22 |

`UNSTABLE` and `LIQUIDITY_SHOCK` silence every strategy. `ABNORMAL_VOL` and
`DIVERGENT` leave only the analytic anchor.

Detection is rule-based on purpose. With five-minute windows there is no time to
accumulate enough in-regime samples to fit something opaque, and an
unexplainable regime flip is an operational hazard.

### Per-regime preferences

| Regime | Preferred |
|---|---|
| `TRENDING` | fair_value, momentum, breakout, order_flow, cross_exchange |
| `RANGING` | fair_value, mean_reversion, microstructure, mispricing, volatility |
| `HIGH_VOL` | fair_value, order_flow, momentum, volatility |
| `LOW_VOL` | fair_value, mean_reversion, microstructure, mispricing |
| `NEWS_LIKE` | fair_value, order_flow, cross_exchange |

A strategy absent from a regime's list is not disabled — it is down-weighted to
0.45.

---

## The meta-model

Four independent factors multiply into each strategy's weight:

```
weight = configured_prior × regime_multiplier × recent_skill × current_confidence
```

Each is bounded, so none can run away. Signals are then fused in **log-odds**:

```
logit(p) = sum(w_i × logit(p_i)) / sum(w_i)
```

Averaging 0.95 and 0.55 in probability space gives 0.75 and throws away how
strong the first view was. Log-odds averaging respects the geometry of
probability and is invariant to which outcome we call "UP".

Three things come out besides the probability:

- **Uncertainty**, from the weighted dispersion of views, mapped into
  probability units through the logistic slope.
- **Agreement**, the weighted share of the majority direction.
- **Confidence**, the weighted mean confidence, reduced for disagreement and for
  a low effective number of independent sources.

### Adaptive weights

Each strategy's realised accuracy is tracked as an EWMA of its Brier score,
overall and per regime, and mapped onto a bounded multiplier around 1.0 —
shrunk toward 1.0 until there is real evidence.

The half-life is 200 trades by design. Fast adaptation on five-minute outcomes
is indistinguishable from fitting noise. Weights are persisted to
`models/strategy_performance.json` and every adjustment is logged.

---

## Adding one

```python
from pmbot.strategies.base import Strategy

class MyStrategy(Strategy):
    name = "my_strategy"
    requires = ("analytic_z", "some_feature")   # abstains if missing

    def _evaluate(self, fs, regime):
        value = fs.features["some_feature"]
        if abs(value) < 0.3:
            return self.abstain("signal too weak")
        return self.from_drift(
            fs,
            drift_sd=squash(value, 2.0) * 0.2,
            confidence=0.5 * fs.features["data_quality"],
            reason=f"my signal {value:+.2f}",
        )
```

Register it in `DEFAULT_STRATEGIES` and add it to `ENABLED_STRATEGIES`. An
exception inside `_evaluate` is caught, logged and converted to an abstention —
a broken strategy cannot stop the bot.

## Removing one

If a strategy shows no skill after a few hundred resolved windows, drop it from
`ENABLED_STRATEGIES`. `bot strategies` shows per-strategy Brier skill and
realised P&L side by side; a persistently negative skill with a meaningful
sample is grounds for removal, not for re-tuning.
