#!/usr/bin/env python3
"""Build the market-analysis tables from Epic's public Fortnite Data API snapshots.

Input: a checkout of https://github.com/Chawewo/fortniteDiscoveryTracker, whose
GitHub Action archives Epic's public API (https://api.fortnite.com/ecosystem/v1)
every 15 minutes into monthly CSVs. Epic itself only keeps 7 days of history,
so that archive is the only reproducible source for a multi-week view.

Usage:
    python3 build_market_dataset.py <tracker-checkout>/data <output-dir>

Outputs (all CSV, UTF-8):
    island_metrics_top1000.csv  top 1,000 islands by average daily unique players
    genre_summary.csv           per-genre medians over every island with fresh data
    tag_demand.csv              supply/demand per Epic tag on the latest day
    launch_outcomes.csv         how new maps fared in their first 144 hours
    summary.json                headline numbers quoted in fortnite_market_analysis.md

Standard library only. Nothing here calls the network.
"""
import csv
import collections
import glob
import json
import os
import statistics
import sys

FRESH_SINCE = "2026-10-10"   # an island needs a daily row on/after this date
DAILY_ROWS = 7               # average over each island's latest N daily rows
TOP_N = 1000
SOURCE = "Epic Fortnite Data API via Chawewo/fortniteDiscoveryTracker archive"


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def read_csvs(pattern):
    rows = []
    for path in sorted(glob.glob(pattern)):
        with open(path, encoding="utf-8", newline="") as handle:
            rows.extend(csv.DictReader(handle))
    return rows


def mean(values):
    values = [v for v in values if v is not None]
    return statistics.mean(values) if values else None


def median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def load_titles(lookup_path, islands_rows):
    titles = {}
    for row in islands_rows:  # maps first seen by the tracker (released since 25 Sep 2026)
        titles[row["code"]] = dict(title=row["title"], creator=row["creator"],
                                   title_source="tracker islands/ catalog", confidence="high")
    if os.path.exists(lookup_path):
        with open(lookup_path, encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                titles[row["code"]] = dict(title=row["title"], creator=row["creator"],
                                           title_source=row["title_source"], confidence=row["confidence"])
    return titles


def ranking_stats(rankings):
    hours = sorted({row["hour"] for row in rankings})
    last_week = set(hours[-168:])
    stats = collections.defaultdict(lambda: dict(best=None, top10=0, ranked=0, genres=collections.Counter()))
    for row in rankings:
        if row["hour"] not in last_week:
            continue
        rank = int(row["rank"])
        entry = stats[row["code"]]
        entry["ranked"] += 1
        entry["genres"][row["genre"]] += 1
        if rank <= 10:
            entry["top10"] += 1
        entry["best"] = rank if entry["best"] is None else min(entry["best"], rank)
    return stats, hours


def build_islands(daily_rows, rank_stats, titles):
    by_code = collections.defaultdict(dict)
    for row in daily_rows:
        by_code[row["code"]][row["date"]] = row
    islands = []
    for code, days in by_code.items():
        dates = sorted(days)[-DAILY_ROWS:]
        if dates[-1] < FRESH_SINCE:
            continue
        rows = [days[d] for d in dates]
        unique = [number(r["unique_players"]) for r in rows]
        if not any(u is not None for u in unique):
            continue
        rank = rank_stats.get(code)
        title = titles.get(code, {})
        peak = [number(r["peak_ccu"]) for r in rows]
        islands.append(dict(
            code=code,
            title=title.get("title", ""),
            creator=title.get("creator", ""),
            title_source=title.get("title_source", ""),
            primary_genre=rank["genres"].most_common(1)[0][0] if rank and rank["genres"] else "",
            avg_daily_unique_players=round(mean(unique)),
            max_daily_peak_ccu=int(max(p for p in peak if p is not None)) if any(p is not None for p in peak) else "",
            avg_minutes_per_player=round(mean(number(r["avg_minutes"]) for r in rows) or 0, 1) or "",
            d1_retention=round(mean(number(r["d1"]) for r in rows), 3) if mean(number(r["d1"]) for r in rows) is not None else "",
            d7_retention=round(mean(number(r["d7"]) for r in rows), 3) if mean(number(r["d7"]) for r in rows) is not None else "",
            avg_daily_plays=round(mean(number(r["plays"]) for r in rows) or 0),
            best_genre_rank_7d=rank["best"] if rank else "",
            hours_in_genre_top10_7d=rank["top10"] if rank else 0,
            days_of_data=len(rows),
            first_day=dates[0],
            last_day=dates[-1],
        ))
    islands.sort(key=lambda i: -i["avg_daily_unique_players"])
    for index, island in enumerate(islands, start=1):
        island["rank_by_players"] = index
    return islands


def genre_summary(islands):
    groups = collections.defaultdict(list)
    for island in islands:
        if island["primary_genre"]:
            groups[island["primary_genre"]].append(island)
    rows = []
    for genre, members in sorted(groups.items()):
        def col(key):
            return [i[key] for i in members if i[key] != ""]
        top = max(members, key=lambda i: i["avg_daily_unique_players"])
        rows.append(dict(
            genre=genre,
            islands=len(members),
            sum_avg_daily_unique_players=sum(i["avg_daily_unique_players"] for i in members),
            median_avg_daily_unique_players=round(median(col("avg_daily_unique_players"))),
            median_minutes_per_player=round(median(col("avg_minutes_per_player")) or 0, 1),
            median_d1=round(median(col("d1_retention")) or 0, 3),
            median_d7=round(median(col("d7_retention")) or 0, 3),
            top_island_code=top["code"],
            top_island_title=top["title"],
        ))
    rows.sort(key=lambda r: -r["sum_avg_daily_unique_players"])
    return rows


def tag_demand(keyword_rows):
    tags = [r for r in keyword_rows if r["kind"] == "tag" and r["term"]]
    latest = max(r["date"] for r in tags)
    rows = []
    for r in tags:
        if r["date"] != latest:
            continue
        islands, ranked, players = int(r["islands"]), int(r["ranked"]), int(r["unique_players"])
        rows.append(dict(date=latest, tag=r["term"], islands=islands, new_last_7d=int(r["new_7d"]),
                         ranked_islands=ranked, unique_players_on_ranked=players,
                         players_per_ranked_island=round(players / ranked) if ranked else "",
                         players_per_island=round(players / islands, 1) if islands else ""))
    rows.sort(key=lambda r: -r["unique_players_on_ranked"])
    return rows, latest


def launch_outcomes(launch_rows):
    final = [r for r in launch_rows if r["stage"] == "144"]
    peaks = [number(r["peak_ccu"]) or 0.0 for r in final]
    buckets = [(0, 4), (5, 49), (50, 99), (100, 999), (1000, 9999), (10000, None)]
    rows = []
    for low, high in buckets:
        count = sum(1 for p in peaks if p >= low and (high is None or p <= high))
        rows.append(dict(peak_ccu_bucket=f"{low}-{high if high is not None else 'max'}", launches=count,
                         share=round(count / len(peaks), 4) if peaks else 0))
    return rows, len(final)


def write_csv(path, rows):
    if not rows:
        return
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main():
    data_dir, out_dir = sys.argv[1], sys.argv[2]
    lookup = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "datasets", "title_lookup.csv")
    os.makedirs(out_dir, exist_ok=True)

    daily = read_csvs(os.path.join(data_dir, "daily", "*.csv"))
    rankings = read_csvs(os.path.join(data_dir, "rankings", "*.csv"))
    new_islands = read_csvs(os.path.join(data_dir, "islands", "*.csv"))
    keywords = read_csvs(os.path.join(data_dir, "keywords", "*.csv"))
    launches = read_csvs(os.path.join(data_dir, "launches", "*.csv"))

    titles = load_titles(lookup, new_islands)
    rank_stats, hours = ranking_stats(rankings)
    islands = build_islands(daily, rank_stats, titles)
    for island in islands:
        island["data_source"] = SOURCE
        island["confidence"] = "measured (Epic API); title " + (titles.get(island["code"], {}).get("confidence", "unknown"))

    write_csv(os.path.join(out_dir, "island_metrics_top1000.csv"), islands[:TOP_N])
    genres = genre_summary(islands)
    write_csv(os.path.join(out_dir, "genre_summary.csv"), genres)
    tags, tag_day = tag_demand(keywords)
    write_csv(os.path.join(out_dir, "tag_demand.csv"), tags)
    launch_rows, launch_count = launch_outcomes(launches)
    write_csv(os.path.join(out_dir, "launch_outcomes.csv"), launch_rows)

    summary = dict(
        islands_with_fresh_daily_data=len(islands),
        islands_in_genre_rankings=len({r["code"] for r in rankings}),
        daily_rows=len(daily),
        daily_date_range=[min(r["date"] for r in daily), max(r["date"] for r in daily)],
        ranking_hours=len(hours),
        ranking_range=[hours[0], hours[-1]],
        new_islands_catalogued=len(new_islands),
        top1000_with_title=sum(1 for i in islands[:TOP_N] if i["title"]),
        top100_with_title=sum(1 for i in islands[:100] if i["title"]),
        tag_day=tag_day,
        launches_final_144h=launch_count,
    )
    with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
