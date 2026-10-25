#!/usr/bin/env python3
"""Merge the Sky Heist Verse modules into one paste-ready UEFN file.

All .verse files of a UEFN project folder share one module, so the five
files in Verse/ can live in a single file: the `using` lines are collected
once at the top and every definition is copied unchanged. A complete build
guide (island settings, map plan, device list, wiring) is prepended as Verse
line comments, so the one file carries everything that can be carried in a
text file.

Usage:
    python3 build_single_file.py [<verse-dir> [<output-file>]]

Defaults: ../Verse and ../UEFN_IMPORT/sky_heist_complete.verse
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
ORDER = ["heist_rules.verse", "heist_save.verse", "heist_player.verse", "heist_hud.verse", "main_game.verse"]

GUIDE = r"""
==========================================================================
 BANK IT! - SKY HEIST | Komplettdatei fuer UEFN (Verse + Bauanleitung)
==========================================================================
 Erzeugt aus fortnite-island/Verse/*.verse mit tools/build_single_file.py.
 Verse-API statisch geprueft gegen den Digest von Fortnite 42.40
 (tools/verse_static_check.py, 0 Befunde). NICHT in UEFN kompiliert:
 UEFN war in der Erstellungsumgebung nicht verfuegbar.

 WAS DIESE DATEI ENTHAELT - UND WAS NICHT
 - Die komplette Spiellogik als ein Verse-Device: "sky_heist_game".
 - Sie kann KEINE Inseln, Gebaeude oder Devices erzeugen. UEFN kann eine
   Map nicht aus einer Textdatei einfuegen. Welt und Devices baust du
   einmal von Hand nach SCHRITT 3 bis 5 unten. Danach steuert diese Datei
   das komplette Spiel.
 - Nutze ENTWEDER diese eine Datei ODER die 5 Einzeldateien aus Verse/,
   niemals beides im selben Projekt (sonst doppelte Definitionen).

--------------------------------------------------------------------------
 SCHRITT 1 - Datei einfuegen und bauen
--------------------------------------------------------------------------
 1. UEFN -> New Project -> leere Insel.
 2. Menue Verse -> Verse Explorer -> Rechtsklick auf den Projektordner
    -> Create New Verse File -> Name: sky_heist_complete
 3. Den GESAMTEN Inhalt dieser Datei hineinkopieren, speichern.
 4. Verse -> Build Verse Code (Strg+Umschalt+B).
 5. Im Content Browser (Projektordner) das Device "sky_heist_game" in die
    Welt ziehen (Position egal, z. B. unter dem Hub).
 Bei Compiler-Fehlern: Meldung kopieren und melden; siehe
 design/testing_plan.md Abschnitt 4.

--------------------------------------------------------------------------
 SCHRITT 2 - Insel-Einstellungen (Island Settings)
--------------------------------------------------------------------------
 Max. Spieler 16 | Teams 4 | Partys zusammenhalten an
 Spawn-Ort: Player Spawn Pads | Join in Progress: Spawn
 Respawn an, 3 s | Items bei Eliminierung: loeschen | mit Spitzhacke starten
 Bauen aus | Friendly Fire aus | Zeitlimit/Siegbedingung aus | Runden 1
 (Optionsnamen koennen je nach UEFN-Version leicht abweichen.)

--------------------------------------------------------------------------
 SCHRITT 3 - Map bauen ("Cloud Quarter", Draufsicht, nicht massstaeblich)
--------------------------------------------------------------------------
                           N
                 +-------------------+
                 | RED BASE (Team 1) |
                 | Spawn x4          |
                 | [Bank]  [Vault]   |
                 +---------+---------+
     Islet NW  o-----------|   Bruecke  |-----------o  Islet NE
              \            |            |            /
  +-------------+   +------+------------+------+   +-------------+
  | GOLD BASE 4 |---|        MEGA VAULT        |---| BLUE BASE 2 |
W | [Vault]     |   |   Tore (4 Barrieren)     |   |     [Vault] | E
  | [Bank]      |   |   Jackpot *  Wachen x3   |   |      [Bank] |
  | Spawn x4    |   |   Beacon                 |   |    Spawn x4 |
  +-------------+   +------+------------+------+   +-------------+
              /            |            |            \
     Islet SW  o-----------+------------+-----------o  Islet SE
                 +---------+---------+
                 | [Vault]  [Bank]   |
                 | Spawn x4          |
                 | GREEN (Team 3)    |
                 +-------------------+
                           S
          darunter: Abgrund (-40 m) mit Damage Volume
 HUB "Hideout": eigene Plattform ~120 m westlich, 30 m hoeher.

 Masse (1 Kachel = 5,12 m):
 Hub 6x6 Kacheln | Basis 5x5 | Loot-Insel 3x3 | Mega Vault 8x8
 Bruecken 1 Kachel breit, 6-8 lang, eine Seite ohne Gelaender
 Basis-Spawn -> eigene Bank-Zone 10-15 m | -> erster Safe 6-10 m
 Basis -> Mega Vault ~60 m | Basis -> Nachbarbasis ~85 m
 Ost-/Westbasis 4 m hoeher. Teamfarben Rot/Blau/Gruen/Gold.
 Nur Fortnite-Galerien/Prefabs aus UEFN verwenden, keine externen Assets.

--------------------------------------------------------------------------
 SCHRITT 4 - Devices platzieren und einstellen (~144)
--------------------------------------------------------------------------
 PRO BASIS (4x):
  - Mutator Zone "Bank" (~6x6x4 m, sichtbar in Teamfarbe) vor dem Tresor
  - Button "Vault" am Tresor dahinter: Interaktionszeit 4 s, Text
    "Rob vault", Ausloesungen unbegrenzt
  - Teleporter "Rundenstart" in der Basis: KEIN Ziel, keine Gruppe,
    Rift unsichtbar oder unter dem Boden
  - 4x Player Spawner: Spieler-Team = Teamnummer der Basis, unsichtbar
  - Billboard ueber dem Tresor, VFX Spawner (Burst, Start aus) an der
    Bank-Zone, Audio Player (Alarm, 3D) am Tresor
  - 2x Button "Safe" 6-10 m vom Spawn, 4x Collectible Object
 LOOT-INSELN (4x): je 2x Button "Safe" + 6x Collectible Object
 MEGA VAULT: 4x Barrier (Tore, Start aktiv), 1x Button "Jackpot"
  (5 s, "Crack the JACKPOT"), 3x Guard Spawner (Spawn bei Start aus,
  anheuern aus, 1-2 Wachen), 8x Collectible Object, 1x Beacon
 HUB: 8x Player Spawner (ohne Team), 1x Teleporter (ohne Ziel),
  Billboard (Ergebnis), Mutator Zone ueber dem Hub ohne Waffenschaden
 GLOBAL: 2x HUD Message (0 = Toasts unten Mitte 3 s, 1 = Banner oben
  4 s), 3x Item Granter (Stufe 0/1/2; beim Vergeben Inventar leeren;
  Knockback-Items MUESSEN Schaden machen), 1x Player Marker (fuer alle,
  Minimap), optional Score Manager, Audio Player (Pickup, Bank, Steal,
  Event, Heat-Musik, Sieg), Analytics (first_bank, round_complete,
  second_round, contract_complete, level_up),
  Damage Volume im Abgrund (>= 200 Schaden)
 EINSTELLUNGEN:
  - Safe-Buttons: Interaktionszeit 3 s, Text "Crack safe", unbegrenzt
  - Collectibles: "verbraucht, wenn eingesammelt von: alle Spieler",
    automatisches Respawnen AUS (der Code respawnt alle 30 s)
  - Keine weiteren Player Spawner auf der Insel ausser Hub und Basen

--------------------------------------------------------------------------
 SCHRITT 5 - sky_heist_game im Details-Panel verdrahten
--------------------------------------------------------------------------
 PFLICHT (sonst startet keine Runde; das Log nennt, was fehlt):
  Bases            4 Eintraege, Reihenfolge = Team 1..4 (RED, BLUE,
                   GREEN, GOLD). Pro Eintrag:
                     BankZone, VaultButton, RoundStartTeleporter,
                     BaseSpawners (4), optional VaultBillboards,
                     BankEffects, VaultAlarms
  HubSpawners      die 8 Hub-Spawner
  HubTeleporters   der Hub-Teleporter (Index 0)
 EMPFOHLEN:
  LootOrbs (alle 48 Collectibles), Safes (alle 16 Safe-Buttons),
  VaultGuards (3), VaultGates (4 Barrieren), JackpotButtons (1),
  BountyMarkers (1), StarterLoadouts (Index 0 = Level 1-2,
  1 = Level 3-9, 2 = ab Level 10), Announcers (0 = Toasts, 1 = Banner)
 OPTIONAL:
  TeamNames, BankScoreManagers, PickupSounds, BankSounds, StealSounds,
  EventSounds, HeatMusic, VictorySounds, ResultBillboards,
  FirstBankAnalytics, RoundCompleteAnalytics, SecondRoundAnalytics,
  ContractCompleteAnalytics, LevelUpAnalytics
 ZEITWERTE (Standard schon gesetzt): IntermissionSeconds 15,
  RoundSeconds 240, HeatSeconds 45, ResultsSeconds 8, LootWaveSeconds 30,
  FirstEventDelaySeconds 40, EventIntervalSeconds 50,
  EventDurationSeconds 25, VaultRobCooldownSeconds 20,
  KnockoutCreditSeconds 8, MinPlayersToStart 1, SoloGuardThreshold 2

--------------------------------------------------------------------------
 SCHRITT 6 - Erster Test
--------------------------------------------------------------------------
 1. Launch Session allein: Hub -> Countdown 15 s -> Basis -> Safe knacken
    -> in die eigene Bank-Zone laufen -> "BANKED +..." erscheint.
 2. Mit 2. Person: Gegner mit Beute von der Insel stossen -> "+X STOLEN".
    Klappt das nicht, macht das Knockback-Item keinen Schaden: anderes Item.
 3. Gegnerischen Tresor 4 s halten -> Raub, Alarm, 20 s Sperre.
 4. Runde inkl. Heat (letzte 45 s, Jackpot) durchspielen, verlassen,
    neu beitreten -> Level bleibt erhalten.
 Alle 20 Editor-Tests: design/testing_plan.md

==========================================================================
 AB HIER: VERSE-CODE (nicht veraendern, ausser du weisst was du tust)
==========================================================================
"""


def comment_block(text):
    lines = []
    for line in text.strip("\n").split("\n"):
        lines.append(("# " + line).rstrip())
    return lines


def build(verse_dir, out_path):
    usings, sections = [], []
    for name in ORDER:
        with open(os.path.join(verse_dir, name), encoding="utf-8") as handle:
            lines = handle.read().split("\n")
        body = []
        for line in lines:
            if line.startswith("using {"):
                if line.strip() not in usings:
                    usings.append(line.strip())
                continue
            body.append(line.rstrip())
        while body and not body[0].strip():
            body.pop(0)
        while body and not body[-1].strip():
            body.pop()
        banner = ["", "#" * 74, f"# Modul: {name}", "#" * 74, ""]
        sections.append(banner + body)
    out = comment_block(GUIDE) + [""] + usings
    for section in sections:
        out.extend(section)
    text = "\n".join(out) + "\n"
    # collapse runs of more than two blank lines
    while "\n\n\n\n" in text:
        text = text.replace("\n\n\n\n", "\n\n\n")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return text


def main():
    verse_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(PROJECT, "Verse")
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(PROJECT, "UEFN_IMPORT", "sky_heist_complete.verse")
    text = build(verse_dir, out_path)
    print(f"wrote {out_path}: {text.count(chr(10))} lines")


if __name__ == "__main__":
    main()
