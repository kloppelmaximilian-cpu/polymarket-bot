# Spielkonzept: Konzeptvergleich und Auswahl

Grundlage: [`../research/fortnite_market_analysis.md`](../research/fortnite_market_analysis.md), Stand der Daten 24.10.2026.

## 1. Ausgangslage in einem Satz

Partyspiele holen sich Reichweite (PILLARS: 686.600 Spieler am Tag), Steal-/Grow-Tycoons holen sich Treue (Top-10-D7 0,36 gegenüber 0,11 bei Party). Kaum ein Spiel vereint beides: Unter den 58 Top-1.000-Inseln mit hoher Spielzeit **und** hoher Retention ist nur ein einziges Partyspiel.

## 2. Sechs Konzeptideen

| | Konzept | Kernidee in einem Satz | Datenbezug |
|---|---|---|---|
| **A** | **BANK IT! – Sky Heist** | Teams sammeln auf schwebenden Inseln Beute in einen begrenzten Beutel, sichern sie im eigenen Tresor und schlagen Gegner von der Insel, um ihnen den halben Beutel abzunehmen. Runden dauern 4 Minuten, der Fortschritt bleibt dauerhaft erhalten. | Steal-Mechanik der Tycoons + Kurzrunden und Chaos der Pillars-Welle + unterversorgte Duo-/Team-Tags |
| B | Pillar Tycoon | Zwischen Last-Standing-Runden baut jeder seine eigene Säule mit Fallen und Upgrades aus. | Pillars + Tycoon |
| C | Rift Runners | Koop-Roguelike für 1–4 Spieler: Räume säubern, Perks ziehen, Meta-Upgrades. | Roguelike-Sessions mit 44–56 Minuten |
| D | Mimic Manor | Asymmetrisches Verstecken: Mimics verwandeln sich in Requisiten, Jäger suchen sie. | Murder Mystery, D7 0,25 |
| E | Garden Guardians | Grow-Tycoon: Kreaturen-Garten anbauen, nachts schützen, andere Gärten bestehlen. | Grow-/Steal-Brainrot, Sprite Garden |
| F | Gravity Gauntlet | Hindernis-Rennen gegen viele Gegner mit schrumpfendem Kurs und zufälligen Modifikatoren. | Deathrun/Only Up |

## 3. Bewertung

Skala 1–10 je Kriterium. Die Gewichte summieren sich auf 100 %. Gesamtwert = Σ (Punkte × Gewicht) / 10, also maximal 100.

| Kriterium | Gewicht | A | B | C | D | E | F |
|---|---:|---:|---:|---:|---:|---:|---:|
| Neue Spieler anziehen (Trendnähe, Thumbnail-Wirkung) | 10 % | 8 | 8 | 6 | 7 | 8 | 7 |
| Verständlich in 30–60 s | 10 % | 8 | 7 | 7 | 6 | 8 | 9 |
| Langfristiger Wiederspielwert | 12 % | 8 | 8 | 7 | 7 | 9 | 5 |
| Erwartbare Sitzungsdauer | 10 % | 8 | 7 | 8 | 7 | 9 | 5 |
| Gruppen und Freunde | 9 % | 9 | 7 | 8 | 9 | 6 | 7 |
| Spaß allein | 8 % | 7 | 6 | 9 | 3 | 8 | 7 |
| Controller / alle Plattformen | 5 % | 8 | 8 | 7 | 7 | 8 | 7 |
| Update-Möglichkeiten | 7 % | 9 | 8 | 8 | 7 | 8 | 7 |
| Unverwechselbarkeit | 8 % | 7 | 5 | 6 | 5 | 3 | 5 |
| Technische Umsetzbarkeit in UEFN | 9 % | 8 | 6 | 5 | 7 | 6 | 8 |
| Performance / Stabilität | 5 % | 8 | 7 | 7 | 8 | 7 | 8 |
| Organische Verbreitung (Clips) | 7 % | 9 | 8 | 5 | 8 | 6 | 7 |
| **Gesamt (von 100)** | | **80,7** | 70,8 | 69,2 | 67,2 | 72,7 | 67,4 |

### Begründung der wichtigsten Unterschiede

- **A gewinnt bei Gruppen, Clips und Updates.** Stehlen, Verteidigen und Ausrauben erzeugt pro Runde mehrere soziale Momente mit klarem Gewinner und Verlierer. Neue Events, Maps und Saisons lassen sich modular ergänzen (siehe `gameplay_systems.md`). Die Kernlogik hängt nur an Standard-Devices (Button, Mutator Zone, Collectible, Guard Spawner, Teleporter) plus Verse. Das ist gut umsetzbar und gut prüfbar.
- **E hat den höchsten Retention-Anschein**, liegt aber am nächsten an der überfüllten Brainrot-Welle. Das heißt Unverwechselbarkeit 3 und Abwertung durch die Ähnlichkeitsprüfung in Discover (Marktanalyse § 9). Idle-Wachstum braucht zudem viel Content und ein Wirtschaftssystem, damit es nicht in eine Grind-Schleife kippt.
- **B klingt stark**, die individuelle Säulen-Geometrie pro Spieler ist in UEFN aber aufwendig (Prop-Spawning, Platzierung, Speicherbudget), und das Konzept liegt nah an PILLARS.
- **C** macht allein am meisten Spaß, braucht aber den meisten handgebauten Inhalt (Räume, Gegner-Balance) und hat wenig Clip-Potenzial.
- **D** lebt von vielen Mitspielern und ist allein kaum spielbar (3/10).
- **F** ist sofort verständlich, hat aber geringe Langzeitbindung (Deathrun-Median D7 0,028).

**Entscheidung: Konzept A, „BANK IT! – Sky Heist“.**

## 4. Das gewählte Konzept

### 4.1 Pitch

> **Schnapp dir Beute. Bring sie in deinen Tresor. Oder klau sie den anderen.**
> Vier Teams, eine Himmelsstadt, vier Minuten. Was du trägst, kann dir jeder abnehmen. Was im Tresor liegt, ist fast sicher.

### 4.2 Alleinstellungsmerkmal (USP)

**„Bank-or-Risk“:** Jede Sekunde mit vollem Beutel ist eine Entscheidung. Jetzt sichern und den Combo-Bonus verschenken, oder weiter sammeln und riskieren, dass dich jemand von der Insel schubst und die Hälfte kassiert? In keiner der analysierten Top-Inseln wird diese Spannung in Runden von wenigen Minuten erzeugt:

- Tycoons haben Stehlen, aber ohne Kampf und Zeitdruck.
- Pillars hat Kampf und Chaos, aber keinen Besitz, um den es geht.
- Bed Wars hat Basen, aber keinen tragbaren Einsatz.

### 4.3 Sofort verständlich (erste 30–60 Sekunden)

1. Der Spieler spawnt im Hub. Spätestens nach 15 Sekunden startet der nächste Heist. Läuft gerade eine Runde, spawnt er direkt an der Teambasis.
2. Ein Banner zeigt **„Grab glowing LOOT and hold to crack SAFES!“**. Neben dem Spawn stehen ein Safe (3 s halten = +5) und mehrere Loot-Orbs.
3. Ab 5 Beute erscheint **„Run to your team's VAULT ZONE to bank your bag!“**. Die Tresor-Zone liegt 10 bis 15 Meter vom Spawn entfernt.
4. Beim ersten Einzahlen erscheint **„BANKED +6“**. Das HUD zählt Team-Tresor und XP hoch. **Erfolgserlebnis nach etwa 20 bis 40 Sekunden.**
5. Danach kommt der Hinweis: „Careful: enemies can rob your vault and steal your bag.“ Damit kennt der Spieler die zweite Ebene des Spiels.

Es gibt kein Tutorial-Menü und keinen Pflicht-Dialog. Alle drei Hinweise sind kontextabhängig und erscheinen nur, bis der Spieler zum ersten Mal einzahlt. Danach ist das Tutorial dauerhaft abgeschlossen (persistent gespeichert).

### 4.4 Clip-Momente

| Moment | Warum er clipbar ist |
|---|---|
| **Last-Second-Bank in der Heat-Phase:** Mit dem Jackpot (25 Beute) und markiert über die Brücke, Gegner hinterher, Einzahlung 1 Sekunde vor Schluss mit doppeltem Wert. | Klarer Spannungsbogen in unter 15 Sekunden und ein großes Ergebnis auf dem Bildschirm. |
| **Sky-Yoink:** Gegner mit vollem Beutel per Knockback von der Insel schubsen, „+15 STOLEN“ erscheint. | Physischer Humor plus sichtbarer Gewinn. |
| **Vault Heist:** Während das gegnerische Team kämpft, den Tresor ausräumen. Alarm, Banner „YOUR VAULT WAS ROBBED!“. | Reaktionsmomente in Gruppen und Streams. |
| **Hot Potato Bounty:** Die Markierung springt auf den, der den Markierten erwischt hat. | Wechselnde Jäger-Gejagter-Rollen. |

### 4.5 Zielgruppe und Spielerzahl

- **Zielgruppe:** Fortnite-Spieler ab 10 Jahren (Inhalt ohne Gewalt jenseits von Fortnite-Standardwaffen, Altersfreigabe laut Epic-Fragebogen), Freundesgruppen von 2 bis 4 Spielern, Solo-Spieler, die Fortschritt mögen.
- **Spieler pro Server:** empfohlen **16** (4 Teams à 4). Spielbar ab 1 Spieler (Solo-Wachen), gut ab 4.
- **Modus:** Teams (4) mit Party-Zusammenhalt. Spätere Modi: Duos-Variante, Event-Maps (siehe Update-Plan).

### 4.6 Warum es fair bleibt (keine Manipulation)

- Belohnungen gibt es nur für echte Spielhandlungen: Einzahlen, Stehlen, Ausrauben, Safes knacken, Sieg. Wer AFK steht, bekommt **0 XP** (`RoundXP` zahlt den Teilnahmebonus nur bei Aktivität).
- Es gibt keine Fortnite-XP-, V-Bucks- oder Echtgeld-Versprechen. Alle Belohnungen sind inselinterne Level, Titel, Beutelgröße und Start-Ausrüstung.
- Daily Contracts verfallen ohne Strafe. Es gibt keine Streak-Verluste und keine künstliche Knappheit.
- Der Tresor-Raub hat eine Abklingzeit (20 s) und nimmt höchstens 15 % beziehungsweise 30 Beute. Der eigene Fortschritt (XP, Level) lässt sich nie stehlen, nur die Beute der laufenden Runde.

### 4.7 Annahmen (dokumentiert)

| Annahme | Begründung | Wird geprüft durch |
|---|---|---|
| Die Insel nutzt 4 Teams, und Fortnite hält Partys zusammen. | Party-Anteil ist ein Discover-Signal; die Tags „duo“ und „2v2“ sind unterversorgt. | Insel-Einstellungen, Playtest |
| Knockback-Items verursachen Schaden und lösen damit `DamagedEvent` aus. | Nötig, damit Abstürze dem Angreifer gutgeschrieben werden. | Editor-Test T-07 (testing_plan.md) |
| Rundenlänge 4 Minuten plus 15 s Pause | Kürzer als eine BR-Runde und ähnlich wie Pillars-Runden. Mehrere Runden pro Session sollen Ø 30+ Minuten ergeben. | Kennzahl Ø Minuten / Spieler |
| Level 10 nach etwa 16–30 Runden, Level 50 als Langzeitziel (51.940 XP) | Sichtbarer früher Fortschritt ohne Grind-Wand, langfristiges Ziel für Stammspieler. | D7-Retention, Playtest-Interviews |
