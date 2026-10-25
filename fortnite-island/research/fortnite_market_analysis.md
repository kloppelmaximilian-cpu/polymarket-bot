# Fortnite-Creator-Inseln: Markt- und Konkurrenzanalyse

**Stand der Daten:** 19.09.2026 – 24.10.2026 · **Analyse erstellt:** 25.10.2026
**Datendateien:** [`datasets/island_metrics_top1000.csv`](datasets/island_metrics_top1000.csv), [`datasets/genre_summary.csv`](datasets/genre_summary.csv), [`datasets/tag_demand.csv`](datasets/tag_demand.csv), [`datasets/launch_outcomes.csv`](datasets/launch_outcomes.csv), [`datasets/title_lookup.csv`](datasets/title_lookup.csv), [`datasets/sources.csv`](datasets/sources.csv)
**Reproduzierbar mit:** [`scripts/build_market_dataset.py`](scripts/build_market_dataset.py)

Kennzeichnung im ganzen Dokument:

- **[F] Fakt:** direkt aus Epics offizieller Fortnite-Data-API gemessen oder aus einer offiziellen Quelle.
- **[S] Schätzung:** abgeleitet oder von Dritten gemessen, Größenordnung plausibel, aber nicht exakt.
- **[V] Vermutung:** Interpretation oder Design-Hypothese, die erst ein Test bestätigen kann.

---

## 1. Kernaussagen

1. **[F]** Gemessen an täglichen Unique Players sind **Übungs- und PvP-Inseln** am größten: Box Fight, Zone Wars, Piece Control, 1v1. Unter den Top 100 sind 58 Inseln aus den Genres „shooter“ und „battle-royale“. Diese Spieler bleiben aber kurz (Ø 24–27 Min.) und kommen mittelmäßig wieder (D7 ≈ 0,18).
2. **[F]** Bei **Spielzeit und Wiederkehr** führen mit großem Abstand die **Simulation-/Tycoon-Inseln mit Steal-/Grow-Mechanik** („Brainrot“-Welle): Die Top 10 des Genres kommen auf Ø **80 Minuten pro Spieler**, **D1 = 0,47** und **D7 = 0,36**. Einzelne Inseln erreichen bis zu 157 Minuten und D7 = 0,59.
3. **[F]** **Party-/Minispiele** erreichen fast die Reichweite der Tycoons (Top 10: Ø 146.000 tägliche Spieler, Tycoons: 152.000). Sie halten Spieler aber nur halb so gut (**D1 = 0,24, D7 = 0,11**). Der Party-Trend 2026 heißt **„PILLARS“** (veröffentlicht am 04.04.2026, heute Platz 2 nach Spielern) und ist bereits geklont: Super Pillars, Pillars Duo, Infinite Pillars und weitere.
4. **[F]** Von den 1.000 größten Inseln erreichen nur **58** zugleich ≥ 40 Minuten pro Spieler und D1 ≥ 0,35. Fast alle davon sind Social/Roleplay (26) oder Tycoon (20). **Nur eine einzige ist ein Partyspiel.**
5. **[F]** Bei der Nachfrage pro Insel sind die Tags **„duo“ (398 Spieler/Insel), „2v2“ (380), „tycoon“ (351), „simulator“ (336) und „party game“ (208)** unterversorgt. „practice“, „pvp“, „1v1“ und „free for all“ sind mit 59.000 bis 70.000 Inseln dagegen massiv überlaufen.
6. **[F]** Die Startrealität ist hart: Von 12.103 neuen Inseln, deren erste 144 Stunden gemessen wurden, erreichten **49 % nie mehr als 4 gleichzeitige Spieler**, nur **9,3 % 100–999** und **0,8 % mehr als 1.000**.
7. **[V] Abgeleitete Marktlücke:** Ein **sofort verständliches Rundenspiel für Gruppen** mit der **Dauerprogression und dem sozialen Stehlen und Verteidigen** der Tycoons. Es soll die Reichweite der Partyspiele mit der Retention der Tycoons verbinden, ohne die überlaufenen Kategorien „Pillars-Klon“ oder „Brainrot-Klon“ zu bedienen. Daraus entsteht das Konzept in [`../design/game_concept.md`](../design/game_concept.md).

---

## 2. Methodik und tatsächlicher Umfang

### 2.1 Was tatsächlich untersucht wurde

| Umfang | Anzahl | Art der Daten |
|---|---:|---|
| Inseln mit offiziellen Tageskennzahlen (Unique Players, Peak-CCU, Minuten, Plays, D1/D7) | **6.633** | [F] Epic-API, je Insel die letzten bis zu 7 Tageswerte (Daten bis 23.10.2026) |
| Inseln in den stündlichen Genre-Top-50 (13 Genres, 772 Stunden) | **5.107** | [F] Epic-API, 21.09.–24.10.2026 |
| In der Top-1.000-Tabelle erfasste Inseln | **1.000** | [F] Kennzahlen für alle 1.000 |
| … davon mit ermitteltem Titel und Creator | **198** (Top 100: 46) | 155 aus dem Katalog der seit 25.09. neu erschienenen Inseln, 43 per Websuche nach Inselcode |
| Qualitative Detailanalyse (Spielschleife, Social, Fortschritt) | **≈ 45** | [S] Beschreibungen der Tracker-Seiten und Genre-Wissen |
| Neue Inseln mit vollständigem 144-Stunden-Verlauf | **12.103** | [F] Epic-API |
| Öffentliche Inseln insgesamt (Katalog, 25.09.2026) | ≈ 288.880 | [F] laut Messung der API-Dokumentation (S2) |

**Ehrliche Einordnung:** Das Ziel waren 1.000 Inseln. **Quantitativ ist es erreicht:** 6.633 Inseln mit offiziellen Kennzahlen, 1.000 davon in der Tabelle. **Qualitativ ist es nicht erreicht:** Spielschleife, Social- und Fortschrittssysteme habe ich für etwa 45 Inseln aus öffentlich zugänglichen Beschreibungen erhoben. Für die übrigen 955 fehlen Titel und Beschreibung, weil:

- die Netzwerkrichtlinie dieser Arbeitsumgebung `api.fortnite.com`, `fortnite.gg`, `fortnite.com` und `dev.epicgames.com` blockiert hat. Das Abrufen einzelner Inselseiten war daher nicht möglich. Titel kamen nur über Suchergebnisse (eine Suche pro Inselcode).
- Epics API keine Discover-Platzierungen, keine Update-Historie und keine Einnahmen liefert.

Es wurden **keine Datensätze, Spielerzahlen, Einnahmen oder Quellen erfunden.** Wo ein Titel unbekannt ist, steht das so in der Tabelle.

### 2.2 Datenquelle der Kennzahlen

Alle Kennzahlen stammen aus **Epics öffentlicher Fortnite-Data-API** (`https://api.fortnite.com/ecosystem/v1`, ohne Login, v1.1.0). Epic speichert dort nur 7 Tage. Deshalb habe ich das öffentliche Archiv [Chawewo/fortniteDiscoveryTracker](https://github.com/Chawewo/fortniteDiscoveryTracker) ausgewertet (Commit vom 24.10.2026, 23:30 UTC), das die API alle 15 Minuten speichert. Die Werte sind Epics eigene, das Archiv speichert nur Momentaufnahmen.

Grenzen der Quelle **[F]**:

- Tageswerte gibt es nur für Inseln, die der Tracker verfolgt (Genre-Top-200 und Neuerscheinungen). Die Stichprobe ist also **zugunsten erfolgreicher Inseln verzerrt**. Für Mediane über „alle Inseln“ taugt sie nicht, für Vergleiche zwischen Top-Inseln sehr gut.
- Buckets mit weniger als 5 Spielern liefert Epic als `null`.
- „Genre“ ist Epics Ranking-Genre (13 Kategorien), nicht die freie Selbstbeschreibung des Creators.
- Peak-CCU auf Tagesbasis ist die Tagesspitze. Allzeit-Peaks von Tracker-Seiten weichen davon ab und wurden **nicht** verwendet.

### 2.3 Kennzahlen-Definitionen

- **Ø tägl. Unique Players:** Mittelwert der letzten bis zu 7 verfügbaren Tageswerte.
- **Ø Min./Spieler:** Epics `averageMinutesPerPlayer` (Tageswert, gemittelt).
- **D1/D7:** Epics Retention-Werte (Anteil der Spieler, die am Tag 1 bzw. 7 wiederkommen), gemittelt.
- **Bester Genre-Rang (7 T.):** bester stündlicher Rang im Epic-Genre-Ranking der letzten 168 Stunden.

---

## 3. Top 50 nach täglichen Unique Players

Die vollständige Liste mit 1.000 Inseln und weiteren Spalten (Plays, Stunden in den Genre-Top-10, Datenzeitraum, Quelle, Vertrauen) steht in [`datasets/island_metrics_top1000.csv`](datasets/island_metrics_top1000.csv).

| # | Code | Titel (Creator) | Genre (Epic-Ranking) | Ø tägl. Unique Players | Ø Min./Spieler | D1 | D7 | Bester Genre-Rang (7 T.) |
|---|---|---|---|---:|---:|---:|---:|---:|
| 1 | 2515-6266-7600 | BOX PVP (hive) | battle-royale | 796.609 | 20.2 | 0.27 | 0.167 | 1 |
| 2 | 7786-0958-2481 | PILLARS (hive) | party-mini-games | 686.600 | 38.3 | 0.339 | 0.207 | 1 |
| 3 | 0148-0322-5437 | Piece Control 2v2 🎯 (bullseye) | shooter | 585.187 | 21.9 | 0.317 | 0.2 | 1 |
| 4 | 3729-0643-9775 | TILTED ZONE WARS ⭐ (AM) (prettyboy) | battle-royale | 545.861 | 27.7 | 0.237 | 0.141 | 1 |
| 5 | 3225-0366-8885 | STEAL THE BRAINROT (ferins) | simulation-tycoon | 538.314 | 57.9 | 0.564 | 0.483 | 1 |
| 6 | 8298-6891-9930 | Piece Control 1v1 🎯 (bullseye) | battle-royale | 518.558 | 16.9 | 0.296 | 0.187 | 4 |
| 7 | 3305-1551-7747 | GO GOATED! Zone Wars | battle-royale | 491.751 | 29.4 | 0.283 | 0.166 | 1 |
| 8 | 6155-1398-4059 | 1v1 With Every Gun | shooter | 428.243 | 37.1 | 0.333 | 0.2 | 1 |
| 9 | 7835-3901-1999 | 1v1 Build Fight [Rezon] (heavyblue) | battle-royale | 352.003 | 24.6 | 0.43 | 0.311 | 1 |
| 10 | 8064-7152-2934 | _(Titel nicht ermittelt)_ | battle-royale | 349.216 | 25.0 | 0.246 | 0.127 | 5 |
| 11 | 8765-4125-9209 | 1v1v1 Reload (chhetz) | shooter | 334.152 | 27.2 | 0.291 | 0.156 | 2 |
| 12 | 4590-4493-7113 | The Pit: Free For All | shooter | 329.698 | 29.6 | 0.273 | 0.144 | 2 |
| 13 | 1832-0431-4852 | 1v1 Build Fights! [4.6.4] (raider464) | battle-royale | 319.968 | 23.6 | 0.397 | 0.273 | 3 |
| 14 | 2898-7886-8847 | CRAZY RED VS BLUE 🔴🔵 (rvb) | shooter | 272.110 | 29.6 | 0.264 | 0.127 | 3 |
| 15 | 8234-1352-6956 | MEGA RED VS BLUE (rvb) | shooter | 258.802 | 37.2 | 0.337 | 0.187 | 3 |
| 16 | 7875-7934-3852 | GO UP FOR BRAINROTS (ferins) | simulation-tycoon | 251.935 | 114.5 | 0.564 | 0.507 | 1 |
| 17 | 7441-9489-4182 | the Last STORM 🌀 - 2v2 (3dh) | shooter | 245.796 | 30.5 | 0.387 | 0.257 | 1 |
| 18 | 6898-9449-5160 | Steal An Egg (gargantuaa) | simulation-tycoon | 244.508 | 65.2 | 0.466 | 0.207 | 1 |
| 19 | 4540-2792-0054 | SUPER PILLARS (noble6) | party-mini-games | 217.587 | 36.3 | 0.314 | 0.193 | 2 |
| 20 | 2713-8007-6156 | PILLARS DUO (frozenarctic) | party-mini-games | 208.454 | 33.6 | 0.277 | 0.147 | 2 |
| 21 | 9784-3946-5466 | Bodycam FPS (bodycamreissad) | shooter | 199.115 | 12.6 | 0.067 | 0.023 | 15 |
| 22 | 6570-5231-1418 | SPEED 2V2 REALISTICS - FINEST REALISTIC (finest) | battle-royale | 195.940 | 25.2 | 0.249 | 0.161 | 7 |
| 23 | 7048-8422-2298 | Bed Wars | strategy | 178.407 | 40.9 | 0.3 | 0.166 | 1 |
| 24 | 6366-6217-9042 | _(Titel nicht ermittelt)_ | shooter | 170.095 | 20.8 | 0.224 | 0.129 | 8 |
| 25 | 7288-9515-0748 | SCALE (denni) | horror | 166.983 | 43.9 | 0.212 | 0.33 | 1 |
| 26 | 7865-8305-9184 | Star Wars Droid Tycoon (foad) | simulation-tycoon | 165.120 | 122.2 | 0.664 | 0.576 | 1 |
| 27 | 5253-8468-3364 | Murder Mystery | horror | 158.012 | 47.9 | 0.339 | 0.251 | 1 |
| 28 | 6562-8953-6567 | _(Titel nicht ermittelt)_ | battle-royale | 144.938 | 22.7 | 0.257 | 0.161 | 9 |
| 29 | 2424-4344-7824 | MECHANICS TRAINING V5 🎯 (raider464) | shooter | 137.630 | 27.8 | 0.477 | 0.346 | 8 |
| 30 | 6980-2761-9936 | Fight The Brainrot (neverty7) | simulation-tycoon | 132.139 | 90.3 | 0.681 | 0.591 | 1 |
| 31 | 1032-8514-3619 | _(Titel nicht ermittelt)_ | shooter | 126.823 | 25.0 | 0.187 | 0.07 | 9 |
| 32 | 2198-3887-7937 | _(Titel nicht ermittelt)_ | shooter | 125.926 | 23.3 | 0.326 | 0.179 | 8 |
| 33 | 9279-9186-3094 | Trick, Treat, Die! (tomjank) | horror | 125.660 | 20.2 | 0.097 | 0.0 | 3 |
| 34 | 4220-9404-7987 | Sprite Garden (epic) | roleplaying-social | 123.658 | 12.2 | 0.149 | 0.09 | 2 |
| 35 | 2522-4269-4932 | SCREAM AND RUN [HORROR] (imthetruth) | horror | 119.972 | 19.8 | 0.134 | 0.046 | 3 |
| 36 | 8835-4983-3982 | ABYSS (ouch) | horror | 113.355 | 20.0 | 0.058 | 0.0 | 2 |
| 37 | 5075-1953-0397 | _(Titel nicht ermittelt)_ | battle-royale | 112.219 | 22.6 | 0.306 | 0.18 | 9 |
| 38 | 4859-7673-2109 | _(Titel nicht ermittelt)_ | battle-royale | 109.952 | 24.2 | 0.3 | 0.141 | 9 |
| 39 | 7950-6306-4857 | _(Titel nicht ermittelt)_ | battle-royale | 99.969 | 20.9 | 0.291 | 0.177 | 11 |
| 40 | 2786-2114-8349 | _(Titel nicht ermittelt)_ | shooter | 95.306 | 30.6 | 0.25 | 0.099 | 11 |
| 41 | 3181-8882-6695 | _(Titel nicht ermittelt)_ | shooter | 94.100 | 30.3 | 0.29 | 0.17 | 9 |
| 42 | 6568-3461-2958 | _(Titel nicht ermittelt)_ | battle-royale | 89.966 | 24.3 | 0.259 | 0.149 | 9 |
| 43 | 0017-2877-1308 | GROW THE BRAINROT (takuman_kamikz) | simulation-tycoon | 80.100 | 156.9 | 0.671 | 0.589 | 1 |
| 44 | 3537-4087-0888 | _(Titel nicht ermittelt)_ | battle-royale | 77.851 | 23.0 | 0.253 | 0.146 | 10 |
| 45 | 4366-9611-6988 | Only Up Fortnite! 🌄 (army) | deathrun-platformer | 77.463 | 22.9 | 0.269 | 0.139 | 1 |
| 46 | 1187-8591-3945 | Oogghi's FFA (OG MOVEMENT) (🎃 UPDATE) (oogghi) | shooter | 69.207 | 23.2 | 0.329 | 0.184 | 16 |
| 47 | 8189-6786-4181 | _(Titel nicht ermittelt)_ | battle-royale | 68.534 | 31.1 | 0.309 | 0.174 | 10 |
| 48 | 8402-3642-6726 | _(Titel nicht ermittelt)_ | shooter | 67.631 | 26.8 | 0.376 | 0.237 | 11 |
| 49 | 8532-9413-6963 | _(Titel nicht ermittelt)_ | party-mini-games | 66.428 | 29.6 | 0.161 | 0.057 | 5 |
| 50 | 9909-6421-7669 | CASH CITY (johnnyblueprint) | roleplaying-social | 62.404 | 44.0 | 0.294 | 0.136 | 1 |

Hinweise zur Tabelle: Titel stammen aus [`datasets/title_lookup.csv`](datasets/title_lookup.csv) (mit URL und Vertrauen) oder aus dem Neuerscheinungs-Katalog des Archivs. Bei Titeln aus Redaktionslisten ist der Creator nicht bestätigt (Vertrauen „medium“).

---

## 4. Genre-Vergleich

Basis: alle 6.633 Inseln mit aktuellen Tageswerten, die im Genre-Ranking auftauchen ([`datasets/genre_summary.csv`](datasets/genre_summary.csv)). Zusätzlich die Mittelwerte der jeweils 10 größten Inseln des Genres:

| Genre | Inseln | Σ Ø tägl. Spieler | Median Min./Spieler | Median D1 | Median D7 | **Top 10: Ø Min.** | **Top 10: D1** | **Top 10: D7** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| battle-royale (v. a. Übungs-PvP) | 87 | 5,20 Mio. | 25,2 | 0,257 | 0,146 | 23,8 | 0,297 | 0,187 |
| shooter | 87 | 5,03 Mio. | 27,8 | 0,290 | 0,141 | 27,4 | 0,297 | 0,177 |
| party-mini-games | 100 | 2,01 Mio. | 27,2 | 0,195 | 0,071 | 30,3 | 0,235 | 0,108 |
| simulation-tycoon | 107 | 1,87 Mio. | 38,7 | 0,198 | 0,059 | **80,3** | **0,473** | **0,361** |
| horror | 144 | 1,31 Mio. | 23,6 | 0,091 | 0,015 | 27,6 | 0,156 | 0,086 |
| roleplaying-social | 91 | 0,62 Mio. | 42,5 | 0,313 | 0,165 | 46,7 | 0,312 | 0,187 |
| deathrun-platformer | 141 | 0,56 Mio. | 25,5 | 0,117 | 0,028 | – | – | – |
| strategy | 199 | 0,36 Mio. | 28,1 | 0,054 | 0,010 | 35,1 | 0,261 | 0,129 |
| sports-racing | 108 | 0,30 Mio. | 24,1 | 0,143 | 0,034 | – | – | – |
| adventure-rpg | 115 | 0,22 Mio. | 28,2 | 0,146 | 0,030 | – | – | – |
| survival | 143 | 0,20 Mio. | 24,8 | 0,122 | 0,027 | – | – | – |
| roguelike | 87 | 0,20 Mio. | 38,6 | 0,179 | 0,070 | 46,0 | 0,218 | 0,112 |
| music-rhythm | 231 | 0,11 Mio. | 12,3 | 0,040 | 0,003 | – | – | – |

**Beobachtungen:**

- **[F]** Über die Top 1.000 korrelieren Spielzeit pro Spieler und D1-Retention mit r = 0,57, D1 und D7 mit r = 0,86. Wer am ersten Tag hält, hält meist auch nach einer Woche.
- **[F]** Im Tycoon-Genre ist der Abstand zwischen Spitze und Mittelfeld am größten: Median D7 0,059, Top-10-D7 0,361. Das Genre belohnt sehr gute Umsetzungen und bestraft mittelmäßige.
- **[F]** Bei Horror sind Einmal-Erlebnisse („Trick, Treat, Die!“, „ABYSS“) groß, aber mit D7 ≈ 0. **Wiederspielbare** soziale Horror-Formate wie „Murder Mystery“ (47,9 Min., D7 0,25) halten deutlich besser.
- **[V]** Hohe Retention entsteht dort, wo ein **sichtbarer, persistenter Besitz wächst** (Tycoon) oder wo **Menschen miteinander interagieren** (Social, Murder Mystery). Reine Übungs- und Party-Runden ohne Meta-Fortschritt bekommen viele Klicks, werden aber seltener zur Gewohnheit.

---

## 5. Angebot und Nachfrage nach Tags (24.10.2026)

Epic vergibt eine feste Liste von 152 Tags. Daten in [`datasets/tag_demand.csv`](datasets/tag_demand.csv). „Spieler pro Insel“ setzt die Spieler auf gerankten Inseln mit dem Tag ins Verhältnis zu allen Inseln mit dem Tag. Das ist ein grober Indikator dafür, wie überlaufen eine Kategorie ist.

| Tag | Inseln gesamt | Neu (7 T.) | Davon gerankt | Unique Players (gerankt) | Spieler pro Insel |
|---|---:|---:|---:|---:|---:|
| duo | 3.529 | 25 | 62 | 1.404.958 | **398** |
| 2v2 | 5.808 | 65 | 47 | 2.205.074 | **380** |
| tycoon | 7.164 | 194 | 274 | 2.512.166 | **351** |
| simulator | 6.786 | 199 | 285 | 2.282.405 | **336** |
| survival horror | 4.202 | 142 | 207 | 1.307.977 | 311 |
| party game | 14.809 | 237 | 417 | 3.074.841 | **208** |
| practice | 59.460 | 391 | 283 | 9.786.333 | 165 |
| pvp | 66.317 | 550 | 350 | 8.932.671 | 135 |
| 1v1 | 63.631 | 586 | 204 | 4.172.676 | 66 |
| free for all | 70.281 | 557 | 327 | 3.358.559 | 48 |
| building | 35.187 | 262 | 89 | 1.420.805 | 40 |

**[V] Folgerung:** Kooperative Formate für zwei bis vier Spieler („duo“, „2v2“) und Tycoon/Simulator sind gemessen an der Nachfrage unterversorgt. Klassische FFA-/1v1-/Bau-PvP-Inseln konkurrieren mit zehntausenden Kopien.

---

## 6. Startrealität neuer Inseln (Launch-Daten)

12.103 Inseln, die zwischen dem 25.09. und dem 18.10.2026 neu erschienen sind, jeweils über ihre ersten 144 Stunden ([`datasets/launch_outcomes.csv`](datasets/launch_outcomes.csv)):

| Höchste gleichzeitige Spielerzahl in den ersten 144 h | Anteil |
|---|---:|
| 0–4 | **49,1 %** |
| 5–49 | 32,7 % |
| 50–99 | 8,1 % |
| 100–999 | 9,3 % |
| 1.000–9.999 | 0,5 % |
| ≥ 10.000 | 0,3 % |

**[F]** Knapp jede zehnte neue Insel kommt über 100 gleichzeitige Spieler. **[V]** Für dieses Projekt ist „100+ CCU in Woche 1“ deshalb ein realistisches erstes Ziel. Alles darüber hängt von Klickrate, Retention und Wachstum über Freunde ab und lässt sich **nicht garantieren**.

---

## 7. Qualitative Analyse der erfolgreichen Spielprinzipien

Für jede Insel aus der Top-50-Tabelle mit bekanntem Titel habe ich die öffentlich beschriebene Spielweise ausgewertet. Die Beschreibungen stammen aus den Tracker-Seiten (S3) und sind **[S]**. Die Kennzahlen sind **[F]**. Ich fasse hier Archetypen zusammen statt jede Insel einzeln zu beschreiben.

### 7.1 Übungs- und PvP-Inseln (Box Fight, Zone Wars, Piece Control, 1v1, Realistics)
Beispiele: BOX PVP, TILTED ZONE WARS, Piece Control 1v1/2v2, 1v1 Build Fight [Rezon], 1v1v1 Reload, MECHANICS TRAINING V5.

- **Spielschleife [S]:** sofort spawnen, kämpfen, sofort respawnen. Sehr kurze Runden von 30 bis 90 Sekunden.
- **Fortschritt [S]:** Statistiken, gespeichertes Gold und Elims (1v1v1 Reload), ELO-Ranglisten (SPEED 2V2 REALISTICS), Saison-Bestenlisten (Piece Control).
- **Social [S]:** Duos und 2v2 sind stark (Piece Control 2v2 auf Platz 3), Lobbys mit 12 bis 16 Spielern.
- **Wiederkehr [V]:** Übung für den Battle Royale. Die Insel ist Werkzeug, kein Spiel um seiner selbst willen.
- **Einstieg [S]:** null Sekunden Tutorial. Der erste Kampf beginnt in Sekunden.
- **Updates [S]:** sehr häufig. BOX PVP steht bei Version 304, Piece Control 2v2 bei 638.
- **Für uns relevant:** Einstieg ohne Wartezeit und Respawn in Sekunden sind Pflicht. Das Genre selbst ist überlaufen (Tags „pvp“ und „1v1“ mit 60.000+ Inseln).

### 7.2 Pillars-Welle (Party / Last-Standing)
Beispiele: PILLARS (686.600/Tag, 38,3 Min.), SUPER PILLARS, PILLARS DUO, INFINITE PILLARS, SNIPER PILLARS.

- **Spielschleife [S]:** 12 Spieler auf Säulen, alle 6 Sekunden ein zufälliges Item, der letzte Überlebende gewinnt.
- **Warum es wirkt [V]:** In 5 Sekunden verstanden, jede Runde läuft durch das Zufalls-Item anders, viele Chaos- und Clip-Momente (Abstürze, Comebacks).
- **Schwäche [F]:** D7 ≈ 0,15–0,21. Ein Meta-Fortschritt ist kaum erkennbar.
- **Updates [S]:** saisonale Inhalte (Halloween-Update bei SUPER PILLARS im Oktober 2026).
- **Für uns relevant:** Zufallsereignisse, kurze Runden, Knockback-Chaos und Clip-Momente übernehmen. **Keinen** weiteren Pillars-Klon bauen.

### 7.3 Steal-/Grow-Tycoons („Brainrot“-Welle)
Beispiele: STEAL THE BRAINROT (538.314/Tag, D7 0,48), GO UP FOR BRAINROTS (114,5 Min.), Steal An Egg, Fight The Brainrot (D1 0,68), GROW THE BRAINROT (156,9 Min.), Star Wars Droid Tycoon (122 Min., D7 0,58).

- **Spielschleife [S]:** Einheiten kaufen oder sammeln, die Einkommen erzeugen, dann ausbauen, „Rebirth“ für Multiplikatoren. Bei den Steal-Varianten lassen sich Einheiten aus fremden Basen stehlen, die eigene Basis muss man verteidigen.
- **Herkunft [S]:** Übernahme von Roblox-Trends („Steal a Brainrot“, „Grow a Garden“, S13).
- **Fortschritt [S]:** dauerhaft gespeichert, sichtbar wachsende Basis, Rebirth-Stufen.
- **Social [S]:** Stehlen und Verteidigen erzeugt Rivalität und Gesprächsstoff. Maximal etwa 5 Spieler pro Server (GO UP FOR BRAINROTS).
- **Monetarisierung [S]:** In-Island-Käufe, z. B. VIP-, Starter- und Companion-Packs bei Star Wars Droid Tycoon (fortnite.gg-Itemseiten).
- **Für uns relevant:** Persistenter Fortschritt plus Stehlen und Verteidigen sind der stärkste Retention-Hebel im Datensatz. Zu vermeiden sind passive Idle-Mechaniken ohne Gameplay und Dauerschleifen, die Spieler nur festhalten sollen.

### 7.4 Soziale Deduktion und Horror
Beispiele: Murder Mystery (47,9 Min., D7 0,25), SCALE (43,9 Min., D7 0,33), Trick Treat Die!, SCREAM AND RUN, ABYSS.

- **Spielschleife [S]:** Rollen, Verfolgungsjagd, Rätsel.
- **Wiederkehr [V]:** Nur die rollenbasierten, wiederholbaren Formate halten Spieler. Story-Horror ist ein Einmal-Erlebnis (D7 ≈ 0).

### 7.5 Social Hangouts und Roleplay
Beispiele: MIC UP PROXIMITY CHAT (58,6 Min., D1 0,38), CASH CITY (44 Min.), LYADOLL PARTY (64,3 Min., D1 0,48), Melaad Party Royale (76,9 Min.).

- **Spielschleife [S]:** Proximity-Voice-Chat, Rollen wie Polizei und Verbrecher, Lobbys mit bis zu 40 Spielern.
- **Für uns relevant:** Soziale Interaktion verlängert Sessions stark. Proximity-Chat ist eine Insel-Einstellung und lässt sich optional auch für unser Konzept testen.

### 7.6 Roguelike-Koop
Beispiele: BACKROOMS [ROGUELIKE] (43,7 Min.), THE BANK HEIST [ROGUELIKE] (55,7 Min., D1 0,34), ESCAPE [ROGUELIKE NEW].

- **Spielschleife [S]:** Räume säubern, Upgrades kaufen, Fortschritt bleibt erhalten, für 1 bis 4 Spieler.
- **Für uns relevant:** Koop mit zufälligen Upgrades und Meta-Fortschritt bringt hohe Sitzungsdauer, die Reichweite ist aber klein (Genre-Summe nur 0,2 Mio./Tag).

### 7.7 Team-Strategie (Bed Wars)
Beispiele: Bed Wars (178.407/Tag, 40,9 Min., D1 0,30), Lucky Block Bedwars.

- **Spielschleife [S]:** eigene Basis verteidigen, Ressourcen sammeln, fremde Basen angreifen.
- **Für uns relevant:** Die Kombination aus „eigene Basis verteidigen und fremde angreifen“ trägt auch ohne Tycoon-Persistenz rund 41 Minuten.

---

## 8. Wirtschaftlicher Erfolg: was belegbar ist und was nicht

| Aussage | Status | Quelle |
|---|---|---|
| Epic hat seit 2023 insgesamt mehr als 1 Mrd. US-$ an Insel-Creator ausgezahlt (verkündet auf der Unreal Fest im Juni 2026). | [F] Ökosystem-Summe | S6 |
| Die Auszahlung erfolgt über einen Engagement-Pool, verteilt nach Engagement der Spieler. Gewichte und Raten veröffentlicht Epic nicht pro Insel. | [F] Modell / [S] Raten | S6, S8 |
| Creator-Inseln hatten im Mai 2026 rund 47 % der Fortnite-Spielzeit. | [S] Drittquelle | S7 |
| Einzelne Inseln verkaufen In-Island-Items, z. B. VIP-, Starter- und Companion-Packs bei Star Wars Droid Tycoon und Reroll-Tokens bei Sidekick Masters. | [F] Angebote existieren | S3 |
| Einnahmen einzelner Inseln | **nicht öffentlich**. Schätzungen Dritter (z. B. „10.000–50.000 $/Monat für Top-Inseln“) sind nicht überprüfbar und werden hier **nicht** als Fakt verwendet. | S8 |

**Folgerung:** Für keine einzelne Insel lässt sich belastbar sagen, ob sie profitabel ist. Belegbar ist nur: Engagement (Spielzeit, Retention, Spieleranzahl) ist laut Epic die Grundlage der Auszahlung **und** das Hauptsignal für die Sichtbarkeit in Discover (S4, S5). Deshalb optimiert dieses Projekt auf ehrliches Engagement, nicht auf Monetarisierungstricks.

---

## 9. Wie Discover Inseln bewertet (offizielle Signale)

Laut Epic-Dokumentation „How Discover works“ (S4, über Suchergebnis-Auszug) und älteren Fortnite-News (S5):

- **[F]** Das **Engagement der Spieler** ist das Hauptsignal: durchschnittliche Spielzeit, Retention und „Quality play-through rate“.
- **[F]** Die Systeme bewerten laufend nach Engagement, Retention, sozialen Signalen und Ähnlichkeit. Schwache Inseln bekommen weniger algorithmische Verbreitung, bleiben aber suchbar.
- **[F]** **Inseln, die bereits veröffentlichten Spielen stark ähneln, werden abgewertet.** Ebenso Keyword-Stuffing und irreführende Titel.
- **[F]** Discover-Reihen nutzen unter anderem Spielerzahl, **Anteil der Spieler in Partys** und die **Wiederkehrrate**.
- **[S]** Eine Creator-Analyse aus 2026 nennt zusätzlich gleichzeitige Spieler und Absprungrate. Die Gewichte sind nicht öffentlich.

**Konsequenz für das Design:** Originalität ist auch algorithmisch Pflicht, wegen der Ähnlichkeitsabwertung. Party-Play und Wiederkehr sind explizite Signale. Titel und Beschreibung müssen ehrlich sein.

---

## 10. Abgeleitete Designprinzipien

| # | Prinzip | Beleg |
|---|---|---|
| P1 | **Null Wartezeit:** spawnen und innerhalb von Sekunden handeln, Einstieg in laufende Runden. | Übungs-PvP-Inseln dominieren die Reichweite (§ 7.1). |
| P2 | **In 5 Sekunden verständliches Ziel** mit Zufall pro Runde. | PILLARS (§ 7.2) |
| P3 | **Persistenter, sichtbarer Fortschritt**, der jede Runde wächst. | Tycoons: D7 0,36 gegenüber 0,11 bei Party (§ 4) |
| P4 | **Stehlen und Verteidigen** als soziale Reibung, aber fair (Abklingzeiten, kein Totalverlust des Fortschritts). | Steal-Tycoons, Bed Wars (§ 7.3, § 7.7) |
| P5 | **Für Duos und Teams gebaut**, aber allein spielbar. | Tags „duo“/„2v2“ unterversorgt (§ 5); Discover wertet Party-Anteil (§ 9). |
| P6 | **Clip-Momente:** Chaos, Comeback in letzter Sekunde, sichtbare Belohnung. | Pillars-Welle, Social-Formate |
| P7 | **Originalität:** kein Klon von Pillars oder Brainrot. | Discover wertet Ähnlichkeit ab (§ 9). |
| P8 | **Häufige kleine Updates und saisonale Inhalte.** | Top-Inseln stehen bei Version 100 bis 600 (§ 7.1, § 7.2). |
| P9 | **Realistische Ziele:** 100+ CCU in der Startwoche sind bereits Top-10 % der Neuerscheinungen. | § 6 |

---

## 11. Offene Grenzen dieser Analyse

- Für 802 der Top-1.000-Inseln sind keine Titel ermittelt. Grund: Die Netzwerkrichtlinie blockiert fortnite.gg, fortnite.com und die Epic-API, und Epics Kennzahlen-API liefert keine Titel für ältere Inseln. Mit freigeschaltetem Netzwerkzugriff auf `api.fortnite.com` würde `GET /islands/{code}` die Titel liefern (siehe README).
- Discover-Platzierungen, Klickraten (CTR) und Einnahmen sind öffentlich nicht verfügbar.
- Die Tageswerte sind zugunsten erfolgreicher Inseln verzerrt (§ 2.2).
- Die qualitative Analyse beruht auf öffentlichen Beschreibungen, nicht auf eigenem Anspielen. In dieser Umgebung ist kein Fortnite-Client verfügbar.
