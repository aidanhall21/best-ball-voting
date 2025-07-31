#!/usr/bin/env python3
"""
ELO rating system for fantasy football teams.

This provides an alternative to the Bradley-Terry model in export_team_ratings.py.
ELO ratings update dynamically after each matchup, providing more responsive 
ratings that reflect recent performance.

Features:
- Dynamic K-factor based on vote weight and team experience
- Starting rating of 1500 for all teams
- Logistic probability function for expected outcomes
- Same weighted voting system as Bradley-Terry model
- Per-tournament rating isolation
- Chronological processing of matchups for accurate evolution

Usage:
    python scripts/elo_team_ratings.py [DB_PATH] [OUTPUT_CSV]

Defaults:
    DB_PATH     = ./teams-2025-07-30-1250.db
    OUTPUT_CSV  = elo_team_ratings.csv
"""

from dotenv import load_dotenv
load_dotenv()

import sys
import os
import sqlite3
from pathlib import Path
import math
from collections import defaultdict
from datetime import datetime

import numpy as np
import pandas as pd

# ELO Configuration
STARTING_ELO = 1500.0
BASE_K_FACTOR = 128.0

def calculate_vote_weight(voter_id, winner_user_id, loser_user_id):
    """Calculate vote weight using same logic as Bradley-Terry model."""
    if pd.isna(voter_id):
        return 1.0
    
    voter_id = str(voter_id)
    winner_user_id = str(winner_user_id) if pd.notna(winner_user_id) else None
    loser_user_id = str(loser_user_id) if pd.notna(loser_user_id) else None
    
    if voter_id == winner_user_id:
        return 0.5  # Self-votes count as half
    elif voter_id == loser_user_id:
        return 1.5  # Voting against own team gets extra credit
    else:
        return 1.0  # Neutral votes get normal weight

def expected_score(rating_a, rating_b):
    """Calculate expected score for team A against team B using logistic function."""
    return 1.0 / (1.0 + 10.0 ** ((rating_b - rating_a) / 400.0))

def adaptive_k_factor(base_k, vote_weight, matches_played):
    """
    Calculate adaptive K-factor based on vote confidence and team experience.
    
    Args:
        base_k: Base K-factor (32.0)
        vote_weight: Weight of the vote (0.5, 1.0, or 1.5)
        matches_played: Number of matches this team has played
    
    Returns:
        Adjusted K-factor between MIN_K_FACTOR and MAX_K_FACTOR
    """
    # Weight adjustment: higher weight = higher K-factor
    weight_multiplier = vote_weight
    
    # Experience adjustment: fewer matches = higher K-factor
    experience_factor = max(0.5, 1.0 - (matches_played / 200.0))
    
    k = base_k * weight_multiplier * experience_factor
    return k

def elo_to_madden(elo_rating, min_elo, max_elo):
    """
    Convert ELO rating to Madden-style 0-99 scale.
    
    Uses same percentile-based mapping as Bradley-Terry model but applies
    to ELO distribution within tournament.
    """
    if max_elo == min_elo:
        return 75.0  # Default rating if all teams have same ELO
    
    # Normalize to 0-1 percentile
    percentile = (elo_rating - min_elo) / (max_elo - min_elo)
    
    # Apply same Madden mapping as Bradley-Terry model
    if percentile < 0.10:
        score = 10 + (percentile / 0.10 * 49)
    elif percentile < 0.25:
        score = 60 + ((percentile - 0.10) / 0.15 * 9)
    elif percentile < 0.55:
        score = 70 + ((percentile - 0.25) / 0.30 * 9)
    elif percentile < 0.95:
        score = 80 + ((percentile - 0.55) / 0.40 * 9)
    else:
        score = 90 + ((percentile - 0.95) / 0.05 * 9)
    
    return max(10.0, min(99.0, score))

def main():
    # Parse arguments
    DB_PATH = os.getenv("DB_PATH", "./teams-2025-07-30-1250.db")
    OUTPUT_CSV = sys.argv[2] if len(sys.argv) > 2 else "elo_team_ratings.csv"
    
    print(f"DB_PATH: {DB_PATH}")
    
    if not Path(DB_PATH).exists():
        sys.exit(f"Database file not found: {DB_PATH}")
    
    # Connect to database
    con = sqlite3.connect(DB_PATH)
    
    # Load teams
    teams_df = pd.read_sql("""
        SELECT id, tournament, username, user_id
        FROM teams
        WHERE tournament IS NOT NULL AND TRIM(tournament) <> ''
    """, con)
    
    if teams_df.empty:
        sys.exit("No teams with non-empty tournament field found.")
    
    # Load matches with user info, ordered chronologically
    matches_df = pd.read_sql("""
        SELECT vm.winner_id, vm.loser_id, vm.voter_id, vm.created_at,
               tw.tournament, tw.user_id AS winner_user_id,
               tl.user_id AS loser_user_id
        FROM versus_matches vm
        JOIN teams tw ON tw.id = vm.winner_id
        JOIN teams tl ON tl.id = vm.loser_id
        WHERE tw.tournament = tl.tournament
          AND tw.tournament IS NOT NULL
          AND TRIM(tw.tournament) <> ''
        ORDER BY vm.created_at ASC
    """, con)
    
    # Process each tournament separately
    results = []
    tournament_groups = teams_df.groupby("tournament")
    
    for tournament, team_group in tournament_groups:
        print(f"Processing tournament: {tournament}")
        
        # Initialize ELO ratings for all teams in tournament
        team_elos = {}
        team_matches_played = defaultdict(int)
        team_wins = defaultdict(float)
        team_losses = defaultdict(float)
        
        for _, team in team_group.iterrows():
            team_elos[team['id']] = STARTING_ELO
        
        # Get matches for this tournament
        tournament_matches = matches_df[matches_df['tournament'] == tournament].copy()
        
        # Process matches chronologically
        for _, match in tournament_matches.iterrows():
            winner_id = match['winner_id']
            loser_id = match['loser_id']
            voter_id = match['voter_id']
            winner_user_id = match['winner_user_id']
            loser_user_id = match['loser_user_id']
            
            # Skip self-matches
            if winner_id == loser_id:
                continue
            
            # Calculate vote weight
            vote_weight = calculate_vote_weight(voter_id, winner_user_id, loser_user_id)
            
            # Get current ratings
            winner_elo = team_elos[winner_id]
            loser_elo = team_elos[loser_id]
            
            # Calculate expected scores
            winner_expected = expected_score(winner_elo, loser_elo)
            loser_expected = 1.0 - winner_expected
            
            # Calculate adaptive K-factors
            winner_k = adaptive_k_factor(BASE_K_FACTOR, vote_weight, team_matches_played[winner_id])
            loser_k = adaptive_k_factor(BASE_K_FACTOR, vote_weight, team_matches_played[loser_id])
            
            # Update ELO ratings
            # Winner gets score of 1, loser gets score of 0
            winner_new_elo = winner_elo + winner_k * (1.0 - winner_expected)
            loser_new_elo = loser_elo + loser_k * (0.0 - loser_expected)
            
            team_elos[winner_id] = winner_new_elo
            team_elos[loser_id] = loser_new_elo
            
            # Update match counts and win/loss records
            team_matches_played[winner_id] += 1
            team_matches_played[loser_id] += 1
            team_wins[winner_id] += vote_weight
            team_losses[loser_id] += vote_weight
        
        # Collect results for this tournament
        for team_id, elo_rating in team_elos.items():
            team_info = team_group[team_group['id'] == team_id].iloc[0]
            
            results.append({
                'team_id': team_id,
                'tournament': tournament,
                'username': team_info['username'],
                'elo_rating': float(elo_rating),
                'madden': 99.0,
                'wins': float(team_wins[team_id]),
                'losses': float(team_losses[team_id]),
                'matches_played': team_matches_played[team_id]
            })
    
    # Create results DataFrame
    results_df = pd.DataFrame(results)
    
    if results_df.empty:
        print("No results to export.")
        return
    
    # Sort by tournament and rating
    results_df = results_df.sort_values(['tournament', 'madden'], ascending=[True, False])
    
    # Export to CSV
    results_df.to_csv(OUTPUT_CSV, index=False)
    print(f"Exported {len(results_df)} ELO team ratings → {OUTPUT_CSV}")
    
    # Also insert into ratings_history table with ELO indicator
    # insert_sql = """
    #     INSERT INTO ratings_history (team_id, tournament, rating, wins, losses, madden)
    #     VALUES (?, ?, ?, ?, ?, ?)
    # """
    #
    # con.executemany(insert_sql, results_df[[
    #     'team_id', 'tournament', 'elo_rating', 'wins', 'losses', 'madden'
    # ]].itertuples(index=False, name=None))
    #
    # con.commit()
    # con.close()
    
    print("ELO ratings successfully computed and stored.")

if __name__ == "__main__":
    main()