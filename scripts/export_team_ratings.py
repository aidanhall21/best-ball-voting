#!/usr/bin/env python3
"""
Export Bradley–Terry ratings for every team present in versus_matches and
write them to a CSV file.

Features sophisticated weighted voting system:
- voter_id matches winner_id: 0.5 weight (self-votes count as half)
- voter_id matches loser_id: 1.5 weight (voting against own team gets extra credit)
- voter_id matches neither: 1.0 weight (neutral votes get normal weight)
- voter_id is null: 1.0 weight (treated as neutral)

Usage:
    python scripts/export_team_ratings.py [DB_PATH] [OUTPUT_CSV]

Defaults:
    DB_PATH     = ./teams-2025-07-02-0843.db   (same default as the Node app)
    OUTPUT_CSV  = team_ratings.csv
"""
from dotenv import load_dotenv
load_dotenv()  # Load .env file into environment variables

import sys
import os
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from scipy.sparse import coo_matrix

# -------------------- Salary scaling params --------------------
# (Deprecated) Salary scaling params – kept for backward compatibility but
# no longer used now that we output Madden-style 0-99 ratings.
# -------------------------------------------------------------------------
ALPHA = 0.3  # still used to regularise logistic regression scaling
TARGET_MEAN_SALARY = 0  # unused
MIN_SALARY = 0          # unused
MAX_SALARY = 0          # unused
SD_MULTIPLIER = 0       # unused
# -------------------------------------------------------------
# 0. Parse command-line arguments
# -------------------------------------------------------------
DB_PATH = os.getenv("DB_PATH", "./teams-2025-07-10-1426.db")
# OUTPUT_CSV = sys.argv[2] if len(sys.argv) > 2 else "team_ratings.csv"
print(f"DB_PATH: {DB_PATH}")

if not Path(DB_PATH).exists():
    sys.exit(f"Database file not found: {DB_PATH}")

# -------------------------------------------------------------
# 1. Pull all teams (non-blank tournament)
# -------------------------------------------------------------
con = sqlite3.connect(DB_PATH)

teams_df = pd.read_sql(
    """
    SELECT id, tournament, username, user_id
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
    SELECT vm.winner_id, vm.loser_id, vm.voter_id, tw.tournament AS tournament,
           tw.user_id AS winner_user_id
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
    matches_t_df = matches_df[matches_df["tournament"] == tournament]  # dataframe subset
    
    # ---- Detect vote types and calculate weights ----
    matches_t_df = matches_t_df.copy()
    
    # Get loser user_id for comparison
    team_user_map = teams_df.set_index("id")["user_id"].to_dict()
    matches_t_df["loser_user_id"] = matches_t_df["loser_id"].map(team_user_map)
    
    def calculate_weight(row):
        voter_id = row["voter_id"]
        winner_user_id = row["winner_user_id"]
        loser_user_id = row["loser_user_id"]
        
        # Handle null voter_id as neutral vote
        if pd.isna(voter_id):
            return 1.0
            
        # Convert to same type for comparison
        voter_id = str(voter_id)
        winner_user_id = str(winner_user_id) if pd.notna(winner_user_id) else None
        loser_user_id = str(loser_user_id) if pd.notna(loser_user_id) else None
        
        if voter_id == winner_user_id:
            return 0.5  # Winner voting for themselves - half weight
        elif voter_id == loser_user_id:
            return 1.5  # Loser voting against themselves - extra weight
        else:
            return 1.0  # Neutral vote - normal weight
    
    matches_t_df["weight"] = matches_t_df.apply(calculate_weight, axis=1)
    
    # ---- Aggregate weighted win/loss counts for each team ----
    win_counts = {}
    loss_counts = {}
    for _, row in matches_t_df.iterrows():
        winner_id = row["winner_id"]
        loser_id = row["loser_id"]
        weight = row["weight"]
        
        win_counts[winner_id] = win_counts.get(winner_id, 0) + weight
        loss_counts[loser_id] = loss_counts.get(loser_id, 0) + weight

    # ---- Build sparse design matrix instead of dense to save memory ----
    row_ind, col_ind, data_vals, labels, weights_list = [], [], [], [], []
    row_counter = 0

    for _, row in matches_t_df.iterrows():
        winner_id = row["winner_id"]
        loser_id = row["loser_id"]
        weight = row["weight"]

        if winner_id == loser_id:
            continue
        if winner_id not in idx or loser_id not in idx:
            continue

        # Winner beats loser (label 1)
        row_ind.extend([row_counter, row_counter])
        col_ind.extend([idx[winner_id], idx[loser_id]])
        data_vals.extend([1, -1])
        labels.append(1)
        weights_list.append(weight)
        row_counter += 1

        # Symmetric example (loser beats winner)
        row_ind.extend([row_counter, row_counter])
        col_ind.extend([idx[winner_id], idx[loser_id]])
        data_vals.extend([-1, 1])
        labels.append(0)
        weights_list.append(weight)
        row_counter += 1

    # ---- Dummy matches: one win + one loss vs baseline for every team ----
    for tid in team_ids:
        # Team beats baseline (only +1 coefficient)
        row_ind.append(row_counter)
        col_ind.append(idx[tid])
        data_vals.append(1)
        labels.append(1)
        weights_list.append(1.0)
        row_counter += 1

        # Baseline beats team (only -1 coefficient)
        row_ind.append(row_counter)
        col_ind.append(idx[tid])
        data_vals.append(-1)
        labels.append(0)
        weights_list.append(1.0)
        row_counter += 1

    # Construct CSR sparse matrix for efficient math operations
    X = coo_matrix((data_vals, (row_ind, col_ind)), shape=(row_counter, n)).tocsr()
    y = np.asarray(labels)
    sample_weights = np.asarray(weights_list)

    # If somehow all labels are the same (degenerate), skip (should not happen)
    if len(np.unique(y)) < 2:
        # Assign neutral rating 1 to all
        abilities = np.ones(n)
    else:
        model = LogisticRegression(
            penalty="l2",  # regularised to avoid infinite estimates
            C=10.0,
            fit_intercept=False,
            solver="liblinear",  # supports sparse CSR input
            max_iter=1000,
        )
        model.fit(X, y, sample_weight=sample_weights)
        coefs = model.coef_.flatten()
        abilities = np.exp(coefs)
        abilities /= abilities.mean()  # normalise within tournament

    # ------------------------------------------------------------------
    #  Collect per-team ability scores (will convert to 0-99 ratings later)
    # ------------------------------------------------------------------
    for tid, ability in zip(team_ids, abilities):
        meta_row = teams_df.loc[teams_df.id == tid].iloc[0]
        results.append(
            {
                "team_id": tid,
                "tournament": tournament,
                "username": meta_row["username"],
                "ability": float(ability),  # raw Bradley–Terry ability
                "wins": float(win_counts.get(tid, 0)),
                "losses": float(loss_counts.get(tid, 0)),
            }
        )
    # ------------------------------------------------------------------

# -------------------------------------------------------------
# 3. Export combined CSV and update database
# -------------------------------------------------------------
ratings_df = pd.DataFrame(results)

# -------------------------------------------------------------
#  Map abilities → Madden-style 0-99 ratings
#  Target distribution (by percentile):
#    0-10%   → 0-59
#   10-25%   → 60-69
#   25-55%   → 70-79
#   55-95%   → 80-89
#   95-100%  → 90-99
# -------------------------------------------------------------

def pct_to_madden(p: float) -> float:
    """Convert a percentile (0-1) to a 10-99 Madden-style rating with decimals."""
    if p < 0.10:
        score = 10 + (p / 0.10 * 49)  # 0-10 percentile
    elif p < 0.25:
        score = 60 + ((p - 0.10) / 0.15 * 9)  # 10-25 percentile
    elif p < 0.55:
        score = 70 + ((p - 0.25) / 0.30 * 9)  # 25-55 percentile
    elif p < 0.95:
        score = 80 + ((p - 0.55) / 0.40 * 9)  # 55-95 percentile
    else:
        score = 90 + ((p - 0.95) / 0.05 * 9)  # 95-100 percentile
    return max(10.0, min(99.0, score))

# Percentile rank of each team’s ability across *all* tournaments
ratings_df["percentile"] = ratings_df["ability"].rank(pct=True, method="average")

# Apply mapping to obtain final integer rating
ratings_df["madden"] = ratings_df["percentile"].apply(pct_to_madden)

# Rename ability to rating for DB consistency (keep raw Bradley-Terry score)
ratings_df = ratings_df.rename(columns={"ability": "rating"})

# Drop helper columns before export/insert
ratings_df = ratings_df.drop(columns=["percentile"])

# Sort for consistency (highest rating first within tournament)
ratings_df = ratings_df.sort_values(["tournament", "madden"], ascending=[True, False])

# --- Write CSV for offline inspection ---
#ratings_df.to_csv(OUTPUT_CSV, index=False)
#print(f"Exported {len(ratings_df)} team ratings → {OUTPUT_CSV}")

# --- Append snapshot into ratings_history table ---

# Bulk insert snapshot rows; each run adds a new record per team
insert_sql = (
    "INSERT INTO ratings_history (team_id, tournament, rating, wins, losses, madden) "
    "VALUES (?, ?, ?, ?, ?, ?)"
)

con.executemany(
    insert_sql,
    ratings_df[[
        "team_id",
        "tournament",
        "rating",
        "wins",
        "losses",
        "madden",
    ]].itertuples(index=False, name=None),
)

con.commit()

# -------------------------------------------------------------
# 4. Invalidate cached leaderboard files so fresh ratings appear
# -------------------------------------------------------------
session_dir = os.getenv("SESSION_DIR") or (os.path.dirname(DB_PATH) if DB_PATH else ".")
deleted_files = 0
for pattern in ("leaderboard_*.json.gz", "leaderboard_users_*.json.gz"):
    for f in Path(session_dir).glob(pattern):
        try:
            f.unlink()
            print(f"Deleted stale cache file: {f}")
            deleted_files += 1
        except Exception as e:
            print(f"Failed to delete {f}: {e}")

# Clear in-memory cache in the Node.js process if any files were deleted
if deleted_files > 0:
    try:
        import urllib.request
        import urllib.parse
        import json
        
        # Try to notify the web app to clear its in-memory cache
        base_url = os.getenv("BASE_URL", "http://localhost:3000")
        internal_secret = os.getenv("INTERNAL_SECRET", "change_this_internal_secret")
        

        
        # Send secret in header instead of body for better reliability
        req = urllib.request.Request(
            f"{base_url}/internal/clear-cache",
            data=b"",  # Empty body
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": internal_secret
            },
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=5) as response:
            result = json.loads(response.read().decode("utf-8"))
            print(f"✓ Cleared in-memory cache: {result}")
            
    except Exception as e:
        # Don't fail the whole script if cache clearing fails
        print(f"Warning: Failed to clear in-memory cache: {e}")
        print("This is not critical - the web app will rebuild cache on next request")

# ------------------------------------------------------------- 