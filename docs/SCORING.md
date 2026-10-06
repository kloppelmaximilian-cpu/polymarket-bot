# Opportunity Score und Quality Gates

## Opportunity Score (0–100)

Code: `packages/scoring/src/score.ts`. Teil-Scores (je 0–100, höher = besser):

| Teil-Score | Grundlage | Gewicht |
| --- | --- | --- |
| Profit | Finance: annualisierte Rendite + Sharpe (nur HISTORICAL/PAPER mit ≥ 30 Trades); Business: Median-Gewinn, P(profitabel), Break-even (ESTIMATED/SIMULATED/PAPER) | 0.25 |
| Risk (= Sicherheit) | Max-Drawdown, Monte-Carlo-Verlustwahrscheinlichkeit, deklarierte Risikostufe; Business: Ruin-Wahrscheinlichkeit, Stressfall | 0.20 |
| Reliability | Walk-Forward-Stabilität, Ausführungsqualität, Daten-Uptime, PSR | 0.15 |
| Automation | Automatisierungsgrad | 0.10 |
| Scalability | Skalierbarkeit, Kapazität | 0.10 |
| Capital Efficiency | benötigtes Kapital | 0.10 |
| Time to Revenue | Tage bis zum ersten Umsatz | 0.10 |
| Context | wiederkehrender Umsatz, Wettbewerb, Abhängigkeiten, Datenverfügbarkeit, Ausführungsrisiko, Komplexität | 0.10 |

Berechnung:

1. Gewichteter Mittelwert der Teil-Scores **mit Daten** (fehlende = NO DATA, nicht 0).
2. **Nicht-kompensatorischer Risikomultiplikator** `× (0.5 + 0.5 · Risk/100)`:
   hoher Gewinn kann hohes Risiko nicht „zurückkaufen“.
3. **Deckel:**

| Bedingung | Deckel |
| --- | --- |
| kein Gewinnnachweis (Profit = NO DATA, z. B. nur DEMO) | 60 |
| Business-Schätzung mit < 50 % belegten Annahmen | 60 |
| ungetestet (HYPOTHETICAL) | 50 |
| Risikostufe EXTREME | 40 |
| negative Erwartung / FAILED wegen NEGATIVE_EV | 25 |
| FAILED | 15 |

Konfidenz: `HIGH` nur mit PAPER-Evidenz und ≥ 30 Trades; `MEDIUM` mit
HISTORICAL-Evidenz und ≥ 30 Trades oder belegter Business-Schätzung; sonst `LOW`.
Rangfolge: Score, dann Konfidenz, dann Evidenzstärke.

Gewichte sind unter **Settings** änderbar (auditiert).

## Automatische Ablehnung (→ FAILED)

Code: `rejectionReasons()` in `packages/experiments/src/gates.ts`. Finanz-Urteile
nur auf belastbarer Evidenz (HISTORICAL oder PAPER, ≥ 30 Trades) – **nie auf
DEMO-Daten**; Business-Urteile auf der Monte-Carlo-Schätzung.

| Grund | Regel |
| --- | --- |
| `NO_EDGE` | Brutto-Erwartung pro Trade ≤ 0 (schon vor Kosten kein Vorteil) |
| `HIGH_COST` | Finance: brutto positiv, netto negativ · Business: negative Bruttomarge |
| `NEGATIVE_EV` | Finance: Erwartung < 0 mit t-Statistik < −1 (Backtest oder Paper) · Business: Median-Gewinn < 0 und P(Gewinn) < 25 % |
| `HIGH_DRAWDOWN` | Drawdown > 1,5 × Drawdown-Limit (Backtest oder Paper) |
| `EXCESSIVE_RISK` | Monte Carlo: Verlustwahrscheinlichkeit bzw. 95-%-Drawdown zu hoch |
| `OVERFITTING` | Out-of-Sample-Sharpe bricht gegenüber In-Sample ein, oder Deflated Sharpe < 0,5 trotz Sharpe > 1 |
| `LOW_SCALABILITY` | geschätzte Kapazität unter `minCapacityUsd` (5 000 USD) |
| `UNRELIABLE_EXECUTION` | Anteil abgelehnter Paper-Orders > 30 % |
| `NO_DATA` | benötigte Daten dauerhaft nicht beschaffbar |
| `COMPLIANCE_BLOCKER` | ein Compliance-Punkt ist als BLOCKER markiert |

## Quality Gates gegen Glückssträhnen

Standardwerte, unter **Settings** änderbar (auditiert). Checks ohne Evidenz
gelten als „no evidence“ und blockieren, wenn sie Pflicht sind.

**Pre-Paper** (vor dem Paper-Test): kein Ablehnungsgrund; ein Backtest bzw.
eine Monte-Carlo-Schätzung ist gelaufen. Ein reiner DEMO-Backtest darf in den
Paper-Test – dort entsteht echte Evidenz –, behauptet aber keinen Gewinn.

**PROMISING** (Review alle 6 Stunden):

| Finance | Business |
| --- | --- |
| Backtest auf echten historischen Daten | P(profitabel nach 24 Monaten) ≥ 0,6 |
| ≥ 30 Out-of-Sample-Trades, OOS-Rendite > 0 | Median-Break-even ≤ 12 Monate |
| ≥ 60 % profitable Walk-Forward-Folds | Median-Gewinn im Stressfall (Conversion −30 %, Kosten +30 %) > 0 |
| Monte Carlo P(Verlust) ≤ 0,3 | P(Kapital aufgebraucht) ≤ 0,3 |
| profitabel bei 1,5 × Kosten | ≥ 90 simulierte Betriebstage |
| Max-Drawdown innerhalb des Limits | keine Risk-Limit-Verletzung |
| ≥ 14 Paper-Tage, ≥ 20 Paper-Trades, Paper-P&L ≥ 0 | (optional) LTV/CAC ≥ 3 |
| keine Risk-Limit-Verletzung im Paper-Test | |
| (optional) OOS-PSR ≥ 0,8, Deflated Sharpe ≥ 0,8, Parameterstabilität ≥ 0,5 | |

**READY_FOR_LIVE_REVIEW** (nur manuelle Prüfung, Live bleibt gesperrt):
alle PROMISING-Kriterien und jeder Compliance-Punkt geprüft und OK; Finance:
≥ 30 Paper-Tage, ≥ 50 Paper-Trades, t-Statistik ≥ 1,5, Paper-Rendite pro Trade
≥ 50 % des Backtests, Daten-Uptime ≥ 95 %, ≤ 10 % abgelehnte Orders;
Business: ≥ 50 % der Annahmen mit Quelle belegt, ≥ 180 simulierte Betriebstage.

Der **Strategy Lab** schlägt Varianten nur im Parameterraum des Moduls vor,
wählt auf dem Trainingsfenster, bewertet Out-of-Sample und zählt jeden Versuch
in die Deflated Sharpe Ratio ein. Eine Variante wird nur als `CANDIDATE`
gespeichert; ein Mensch befördert sie.
