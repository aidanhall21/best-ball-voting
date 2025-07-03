#!/usr/bin/env python3
"""
Export Bradley–Terry ratings for every team present in versus_matches and
write them to a CSV file.

Usage:
    python scripts/export_team_ratings.py [DB_PATH] [OUTPUT_CSV]

Defaults:
    DB_PATH     = ./teams-2025-07-02-0843.db   (same default as the Node app)
    OUTPUT_CSV  = team_ratings.csv
"""
import sys
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

# -------------------------------------------------------------
# 0. Parse command-line arguments
# -------------------------------------------------------------
DB_PATH = sys.argv[1] if len(sys.argv) > 1 else "./teams-2025-07-03-0731.db"
OUTPUT_CSV = sys.argv[2] if len(sys.argv) > 2 else "team_ratings.csv"

if not Path(DB_PATH).exists():
    sys.exit(f"Database file not found: {DB_PATH}")

# -------------------------------------------------------------
# 1. Pull all teams (non-blank tournament)
# -------------------------------------------------------------
con = sqlite3.connect(DB_PATH)

teams_df = pd.read_sql(
    """
    SELECT id, tournament, username
    FROM   teams
    WHERE  tournament IS NOT NULL AND TRIM(tournament) <> ''
    """,
    con,
)

if teams_df.empty:
    sys.exit("No teams with non-empty tournament field found.")

# Map tournament → list of team_ids
tourn_groups = teams_df.groupby("tournament")

# -------------------------------------------------------------
# 2. Pull matches but keep only same-tournament outcomes
# -------------------------------------------------------------
matches_df = pd.read_sql(
    """
    SELECT vm.winner_id, vm.loser_id, tw.tournament AS tournament
    FROM   versus_matches vm
    JOIN   teams tw ON tw.id = vm.winner_id
    JOIN   teams tl ON tl.id = vm.loser_id
    WHERE  tw.tournament = tl.tournament
      AND  tw.tournament IS NOT NULL
      AND  TRIM(tw.tournament) <> ''
    """,
    con,
)

# Build ratings per tournament
results = []
for tournament, group in tourn_groups:
    team_ids = sorted(group["id"].tolist())
    idx = {tid: i for i, tid in enumerate(team_ids)}
    n = len(team_ids)

    # Extract matches for this tournament (may be empty)
    matches_t = matches_df[matches_df["tournament"] == tournament][
        ["winner_id", "loser_id"]
    ].itertuples(index=False, name=None)

    rows, labels = [], []

    for winner_id, loser_id in matches_t:
        if winner_id == loser_id:
            continue
        # Skip if somehow ids not in current list (data inconsistency)
        if winner_id not in idx or loser_id not in idx:
            continue
        x = np.zeros(n)
        x[idx[winner_id]] = 1
        x[idx[loser_id]] = -1
        rows.append(x); labels.append(1)  # observed win
        rows.append(-x); labels.append(0) # symmetric loss

    # ---- Dummy matches: one win + one loss vs baseline for every team ----
    for tid in team_ids:
        x = np.zeros(n)
        x[idx[tid]] = 1
        rows.append(x); labels.append(1)  # team beats baseline
        rows.append(-x); labels.append(0) # baseline beats team

    X = np.vstack(rows)
    y = np.asarray(labels)

    # If somehow all labels are the same (degenerate), skip (should not happen)
    if len(np.unique(y)) < 2:
        # Assign neutral rating 1 to all
        abilities = np.ones(n)
    else:
        model = LogisticRegression(
            penalty="l2",  # regularised to avoid infinite estimates
            C=10.0,
            fit_intercept=False,
            solver="lbfgs",
            max_iter=1000,
        )
        model.fit(X, y)
        coefs = model.coef_.flatten()
        abilities = np.exp(coefs)
        abilities /= abilities.mean()  # normalise within tournament

    for tid, ability in zip(team_ids, abilities):
        meta_row = teams_df.loc[teams_df.id == tid].iloc[0]
        results.append(
            {
                "team_id": tid,
                "tournament": tournament,
                "username": meta_row["username"],
                "rating": float(ability),
            }
        )

# -------------------------------------------------------------
# 3. Export combined CSV
# -------------------------------------------------------------
ratings_df = pd.DataFrame(results)
ratings_df = ratings_df.sort_values(["tournament", "rating"], ascending=[True, False])

ratings_df.to_csv(OUTPUT_CSV, index=False)
print(f"Exported {len(ratings_df)} team ratings → {OUTPUT_CSV}") 