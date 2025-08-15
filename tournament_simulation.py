#!/usr/bin/env python3
"""
Tournament Odds Simulation

Calculates championship odds for each team in a tournament bracket based on ELO ratings.
Uses Monte Carlo simulation to estimate the probability of each team winning the entire tournament.

Features:
- Loads team ELO ratings from playoff_teams.csv
- Loads bracket structure from playoff_matchups.csv  
- ELO-based matchup probability calculations
- Monte Carlo simulation with configurable iterations
- Championship odds and detailed statistics output
- Regional analysis and round-by-round probabilities

Usage:
    python tournament_simulation.py [--simulations 10000] [--verbose]

Requires:
    - playoff_teams.csv: team_id, username, elo
    - playoff_matchups.csv: tournament bracket structure
"""

import pandas as pd
import numpy as np
import random
import math
from collections import defaultdict, Counter
import argparse
import sys
from pathlib import Path

class TournamentSimulator:
    def __init__(self, teams_file='playoff_teams.csv', matchups_file='playoff_matchups.csv'):
        """Initialize the tournament simulator with team and matchup data."""
        self.teams_df = pd.read_csv(teams_file)
        self.matchups_df = pd.read_csv(matchups_file)
        
        # Default K-factor for ELO updates (matches your BASE_K_FACTOR)
        self.k_factor = 128
        
        # Create team lookup for quick access
        self.teams = {}
        for _, team in self.teams_df.iterrows():
            self.teams[team['team_id']] = {
                'id': team['team_id'],
                'username': team['username'],
                'elo': float(team['elo']) if pd.notna(team['elo']) else 1500.0
            }
        
        print(f"Loaded {len(self.teams)} teams and {len(self.matchups_df)} matchups")
        
        # Build bracket structure
        self.build_bracket_structure()
        
        # Initialize statistics tracking
        self.reset_stats()
    
    def build_bracket_structure(self):
        """Build the tournament bracket structure from matchup data."""
        # Group matchups by round
        self.rounds = {}
        for _, matchup in self.matchups_df.iterrows():
            round_num = matchup['round_number']
            if round_num not in self.rounds:
                self.rounds[round_num] = []
            self.rounds[round_num].append(matchup)
        
        # Sort each round by bracket position
        for round_num in self.rounds:
            self.rounds[round_num] = sorted(self.rounds[round_num], 
                                          key=lambda x: x['bracket_position'])
        
        self.max_round = max(self.rounds.keys())
        print(f"Tournament has {self.max_round} rounds")
        
        # Print round structure
        for round_num in sorted(self.rounds.keys()):
            round_matchups = len(self.rounds[round_num])
            print(f"  Round {round_num}: {round_matchups} matchups")
    
    def reset_stats(self):
        """Reset all statistics tracking."""
        self.championship_wins = Counter()
        self.round_reaches = defaultdict(Counter)  # round_num -> {username: count}
        self.teams_alive = defaultdict(Counter)     # round_num -> {username: times_alive_at_start}
        self.regional_performance = defaultdict(Counter)
        self.upset_tracker = []
        self.series_stats = []  # Track detailed series information
        self.elo_changes = defaultdict(list)  # Track ELO changes throughout tournament
        self.simulations_run = 0
        
        # Store original ELO ratings to reset between simulations
        self.original_elos = {}
        for team_id, team_data in self.teams.items():
            self.original_elos[team_id] = team_data['elo']
    
    def elo_win_probability(self, elo_a, elo_b):
        """
        Calculate the probability that team A beats team B based on ELO ratings.
        Uses the logistic function: P(A beats B) = 1 / (1 + 10^((elo_b - elo_a)/400))
        """
        return 1.0 / (1.0 + math.pow(10, (elo_b - elo_a) / 400.0))
    
    def simulate_game(self, team1_elo, team2_elo):
        """
        Simulate a single game between two teams based on their current ELO ratings.
        Returns True if team1 wins, False if team2 wins.
        """
        prob_team1_wins = self.elo_win_probability(team1_elo, team2_elo)
        return random.random() < prob_team1_wins
    
    def calculate_expected_score(self, rating_a, rating_b):
        """
        Calculate expected score using the same logic as your index.js.
        This matches the calculateExpectedScore function.
        """
        return 1.0 / (1.0 + math.pow(10, (rating_b - rating_a) / 400.0))
    
    def calculate_adaptive_k_factor(self, base_k, vote_weight, matches_played):
        """
        Calculate adaptive K-factor using the same logic as your index.js.
        This matches the calculateAdaptiveKFactor function.
        """
        # Weight multiplier based on vote weight (same as your system)
        weight_multiplier = vote_weight
        
        # Experience factor - newer teams get higher K-factor
        experience_factor = max(0.5, 1.0 - (matches_played / 200.0))
        
        return base_k * weight_multiplier * experience_factor

    def update_elo_ratings(self, winner_elo, loser_elo, vote_weight=1.0, winner_matches=0, loser_matches=0):
        """
        Update ELO ratings after a single game using your system's logic.
        This matches the calculateNewEloRatings function from index.js.
        Returns (new_winner_elo, new_loser_elo)
        """
        # Calculate expected scores (same as your index.js)
        winner_expected = self.calculate_expected_score(winner_elo, loser_elo)
        loser_expected = 1.0 - winner_expected
        
        # Calculate adaptive K-factors (same as your index.js)
        winner_k = self.calculate_adaptive_k_factor(self.k_factor, vote_weight, winner_matches)
        loser_k = self.calculate_adaptive_k_factor(self.k_factor, vote_weight, loser_matches)
        
        # Update ELO ratings (winner gets 1, loser gets 0)
        winner_new_elo = winner_elo + winner_k * (1.0 - winner_expected)
        loser_new_elo = loser_elo + loser_k * (0.0 - loser_expected)
        
        # Round the final ELO values (same as your index.js)
        return round(winner_new_elo), round(loser_new_elo)

    def simulate_matchup(self, team1_id, team2_id, hot_simulation=True):
        """
        Simulate a matchup between two teams.
        If hot_simulation=True, simulates individual games with ELO updates.
        If hot_simulation=False, uses the original single-game simulation.
        Returns (winner_id, is_upset, series_details)
        """
        if team1_id not in self.teams or team2_id not in self.teams:
            # Handle missing teams (byes, etc.)
            if team1_id in self.teams:
                return team1_id, False, None
            elif team2_id in self.teams:
                return team2_id, False, None
            else:
                return None, False, None
        
        # Get initial ELO ratings
        initial_team1_elo = self.teams[team1_id]['elo']
        initial_team2_elo = self.teams[team2_id]['elo']
        
        if not hot_simulation:
            # Original simulation logic
            prob_team1_wins = self.elo_win_probability(initial_team1_elo, initial_team2_elo)
            team1_wins_series = random.random() < prob_team1_wins
            
            if team1_wins_series:
                winner_id = team1_id
                upset = initial_team1_elo < initial_team2_elo
            else:
                winner_id = team2_id
                upset = initial_team2_elo < initial_team1_elo
            
            return winner_id, upset, None
        
        # Hot simulation: Best-of-7 series (first to 4 wins)
        team1_wins = 0
        team2_wins = 0
        current_team1_elo = initial_team1_elo
        current_team2_elo = initial_team2_elo
        
        # Track games played for adaptive K-factor (start with some base experience)
        team1_games_played = 10  # Assume some baseline experience
        team2_games_played = 10
        
        game_results = []
        
        while team1_wins < 4 and team2_wins < 4:
            # Simulate individual game
            team1_wins_game = self.simulate_game(current_team1_elo, current_team2_elo)
            
            if team1_wins_game:
                team1_wins += 1
                # Update ELO ratings after the game (team1 wins)
                current_team1_elo, current_team2_elo = self.update_elo_ratings(
                    winner_elo=current_team1_elo, 
                    loser_elo=current_team2_elo,
                    vote_weight=1.0,  # Each game counts as 1 vote
                    winner_matches=team1_games_played,
                    loser_matches=team2_games_played
                )
            else:
                team2_wins += 1
                # Update ELO ratings after the game (team2 wins)
                current_team2_elo, current_team1_elo = self.update_elo_ratings(
                    winner_elo=current_team2_elo, 
                    loser_elo=current_team1_elo,
                    vote_weight=1.0,  # Each game counts as 1 vote
                    winner_matches=team2_games_played,
                    loser_matches=team1_games_played
                )
            
            # Increment games played for both teams
            team1_games_played += 1
            team2_games_played += 1
            
            game_results.append({
                'game_num': len(game_results) + 1,
                'team1_wins_game': team1_wins_game,
                'team1_elo_after': current_team1_elo,
                'team2_elo_after': current_team2_elo,
                'series_score': f"{team1_wins}-{team2_wins}"
            })
        
        # Determine series winner
        if team1_wins == 4:
            winner_id = team1_id
            upset = initial_team1_elo < initial_team2_elo
        else:
            winner_id = team2_id
            upset = initial_team2_elo < initial_team1_elo
        
        # Update the teams' ELO ratings in our teams dict for this simulation
        self.teams[team1_id]['elo'] = current_team1_elo
        self.teams[team2_id]['elo'] = current_team2_elo
        
        series_details = {
            'initial_team1_elo': initial_team1_elo,
            'initial_team2_elo': initial_team2_elo,
            'final_team1_elo': current_team1_elo,
            'final_team2_elo': current_team2_elo,
            'team1_wins': team1_wins,
            'team2_wins': team2_wins,
            'games_played': len(game_results),
            'game_results': game_results
        }
        
        return winner_id, upset, series_details
    
    def reset_team_elos(self):
        """Reset all team ELO ratings to their original values."""
        for team_id in self.teams:
            self.teams[team_id]['elo'] = self.original_elos[team_id]

    def simulate_tournament(self, hot_simulation=True):
        """
        Simulate a complete tournament and return the champion.
        Returns (champion_id, detailed_results)
        """
        # Reset ELO ratings to original values for this simulation
        self.reset_team_elos()
        
        # Track results for this simulation - map matchup_id to winner_id
        matchup_winners = {}
        upsets_this_sim = []
        series_details_this_sim = []
        
        # Simulate each round in order
        for round_num in sorted(self.rounds.keys()):
            for matchup in self.rounds[round_num]:
                matchup_id = matchup['id']
                
                if round_num == 1:
                    # First round - use teams from CSV
                    team1_id = matchup['team1_id']
                    team2_id = matchup['team2_id']
                else:
                    # Later rounds - get winners from parent matchups
                    # Find the two matchups that feed into this one
                    parent_matchups = []
                    for prev_round_num in range(1, round_num):
                        for prev_matchup in self.rounds[prev_round_num]:
                            if prev_matchup['parent_matchup_id'] == matchup_id:
                                parent_matchups.append((prev_matchup['id'], prev_matchup['parent_position']))
                    
                    # Sort by parent position to get team1 and team2
                    parent_matchups.sort(key=lambda x: x[1])
                    
                    if len(parent_matchups) >= 2:
                        team1_id = matchup_winners.get(parent_matchups[0][0])
                        team2_id = matchup_winners.get(parent_matchups[1][0])
                    elif len(parent_matchups) == 1:
                        # Only one parent (bye situation)
                        team1_id = matchup_winners.get(parent_matchups[0][0])
                        team2_id = None
                    else:
                        # No parents found, skip this matchup
                        continue
                
                # Simulate the matchup
                winner_id, is_upset, series_details = self.simulate_matchup(
                    team1_id, team2_id, hot_simulation=hot_simulation
                )
                
                if winner_id:
                    matchup_winners[matchup_id] = winner_id
                    
                    # Track series details if available
                    if series_details:
                        series_details['round'] = round_num
                        series_details['matchup_id'] = matchup_id
                        series_details['team1_id'] = team1_id
                        series_details['team2_id'] = team2_id
                        series_details['team1_username'] = self.teams[team1_id]['username']
                        series_details['team2_username'] = self.teams[team2_id]['username']
                        series_details['winner_id'] = winner_id
                        series_details_this_sim.append(series_details)
                    
                    # Track upsets
                    if is_upset and team1_id and team2_id:
                        loser_id = team1_id if winner_id == team2_id else team2_id
                        upset_info = {
                            'round': round_num,
                            'winner': self.teams[winner_id]['username'],
                            'loser': self.teams[loser_id]['username']
                        }
                        
                        if series_details:
                            # Use initial ELO ratings for upset determination
                            upset_info['winner_initial_elo'] = series_details['initial_team1_elo'] if winner_id == team1_id else series_details['initial_team2_elo']
                            upset_info['loser_initial_elo'] = series_details['initial_team2_elo'] if winner_id == team1_id else series_details['initial_team1_elo']
                            upset_info['winner_final_elo'] = series_details['final_team1_elo'] if winner_id == team1_id else series_details['final_team2_elo']
                            upset_info['loser_final_elo'] = series_details['final_team2_elo'] if winner_id == team1_id else series_details['final_team1_elo']
                        else:
                            # Fallback to current ELO ratings
                            upset_info['winner_initial_elo'] = self.original_elos[winner_id]
                            upset_info['loser_initial_elo'] = self.original_elos[loser_id]
                            upset_info['winner_final_elo'] = self.teams[winner_id]['elo']
                            upset_info['loser_final_elo'] = self.teams[loser_id]['elo']
                        
                        upsets_this_sim.append(upset_info)
        
        # Find the champion (winner of the final round)
        final_round_matchups = [m for m in self.rounds[self.max_round]]
        champion_id = None
        if final_round_matchups:
            final_matchup_id = final_round_matchups[0]['id']
            champion_id = matchup_winners.get(final_matchup_id)
        
        return champion_id, matchup_winners, upsets_this_sim, series_details_this_sim
    
    def run_simulation(self, num_simulations=10000, verbose=False, hot_simulation=True):
        """
        Run multiple tournament simulations and collect statistics.
        """
        sim_type = "hot (game-by-game)" if hot_simulation else "cold (single matchup)"
        print(f"Running {num_simulations:,} {sim_type} tournament simulations...")
        
        self.reset_stats()
        
        for sim in range(num_simulations):
            if verbose and (sim + 1) % 1000 == 0:
                print(f"  Completed {sim + 1:,} simulations...")
            
            champion_id, matchup_winners, upsets, series_details = self.simulate_tournament(
                hot_simulation=hot_simulation
            )
            
            if champion_id:
                # Track championship by team_id instead of username
                self.championship_wins[champion_id] += 1
                
                # Track which teams are "alive" at the start of each round
                # and which teams advance to the next round
                teams_alive_this_sim = set()
                
                # All teams start alive in round 1
                for matchup in self.rounds[1]:
                    if matchup['team1_id'] in self.teams:
                        self.teams_alive[1][matchup['team1_id']] += 1
                        teams_alive_this_sim.add(matchup['team1_id'])
                    if matchup['team2_id'] in self.teams:
                        self.teams_alive[1][matchup['team2_id']] += 1
                        teams_alive_this_sim.add(matchup['team2_id'])
                
                # Track advancement through subsequent rounds
                for round_num in sorted(self.rounds.keys()):
                    teams_advancing = set()
                    
                    for matchup in self.rounds[round_num]:
                        winner_id = matchup_winners.get(matchup['id'])
                        if winner_id and winner_id in self.teams:
                            self.round_reaches[round_num][winner_id] += 1
                            teams_advancing.add(winner_id)
                    
                    # Teams advancing become alive in the next round
                    if round_num < self.max_round:
                        for team_id in teams_advancing:
                            if team_id in self.teams:
                                self.teams_alive[round_num + 1][team_id] += 1
                
                # Track upsets and series details
                self.upset_tracker.extend(upsets)
                self.series_stats.extend(series_details)
        
        self.simulations_run = num_simulations
        print(f"Simulation complete!")
    
    def get_championship_odds(self, top_n=20):
        """Get championship odds for all teams, sorted by probability."""
        if self.simulations_run == 0:
            return []
        
        odds = []
        for team_id, wins in self.championship_wins.items():
            probability = wins / self.simulations_run
            team_data = self.teams[team_id]
            odds.append({
                'team_id': team_id,
                'username': team_data['username'],
                'championships': wins,
                'probability': probability,
                'odds': f"1 in {int(1/probability):.0f}" if probability > 0 else "No wins"
            })
        
        # Sort by probability (highest first)
        odds.sort(key=lambda x: x['probability'], reverse=True)
        
        return odds[:top_n] if top_n else odds
    
    def get_round_advancement_odds(self, round_num, top_n=20):
        """Get odds for teams to reach a specific round."""
        if self.simulations_run == 0 or round_num not in self.round_reaches:
            return []
        
        odds = []
        for team_id, reaches in self.round_reaches[round_num].items():
            probability = reaches / self.simulations_run
            team_data = self.teams[team_id]
            odds.append({
                'team_id': team_id,
                'username': team_data['username'],
                'round_reaches': reaches,
                'probability': probability
            })
        
        # Sort by probability (highest first)  
        odds.sort(key=lambda x: x['probability'], reverse=True)
        
        return odds[:top_n] if top_n else odds
    
    def get_upset_analysis(self):
        """Analyze upset frequency and patterns."""
        if not self.upset_tracker:
            return {}
        
        total_upsets = len(self.upset_tracker)
        upsets_by_round = Counter([upset['round'] for upset in self.upset_tracker])
        
        # Calculate average ELO difference in upsets
        # Use initial ELO if available, otherwise use final ELO
        elo_diffs = []
        for upset in self.upset_tracker:
            if 'loser_initial_elo' in upset and 'winner_initial_elo' in upset:
                elo_diff = upset['loser_initial_elo'] - upset['winner_initial_elo']
            else:
                # Fallback for old format
                elo_diff = upset.get('loser_elo', 0) - upset.get('winner_elo', 0)
            elo_diffs.append(elo_diff)
        
        avg_elo_diff = sum(elo_diffs) / len(elo_diffs) if elo_diffs else 0
        
        return {
            'total_upsets': total_upsets,
            'upsets_per_simulation': total_upsets / self.simulations_run,
            'upsets_by_round': dict(upsets_by_round),
            'average_elo_difference': avg_elo_diff,
            'biggest_upset': max(elo_diffs) if elo_diffs else 0
        }
    
    def get_series_analysis(self):
        """Analyze series statistics from hot simulations."""
        if not self.series_stats:
            return {}
        
        # Analyze series lengths
        series_lengths = [s['games_played'] for s in self.series_stats]
        series_length_dist = Counter(series_lengths)
        
        # Analyze ELO changes during series
        elo_swings = []
        for series in self.series_stats:
            team1_swing = abs(series['final_team1_elo'] - series['initial_team1_elo'])
            team2_swing = abs(series['final_team2_elo'] - series['initial_team2_elo'])
            elo_swings.extend([team1_swing, team2_swing])
        
        # Analyze comeback frequency (team that was losing 0-3 wins series)
        comebacks = 0
        for series in self.series_stats:
            if series['games_played'] == 7:
                # Check if either team won 4-3 (potential comeback)
                if (series['team1_wins'] == 4 and series['team2_wins'] == 3) or \
                   (series['team2_wins'] == 4 and series['team1_wins'] == 3):
                    # This could be a comeback, but we'd need game-by-game data to be sure
                    # For now, just count 7-game series as potential comebacks
                    comebacks += 1
        
        return {
            'total_series': len(self.series_stats),
            'avg_series_length': sum(series_lengths) / len(series_lengths) if series_lengths else 0,
            'series_length_distribution': dict(series_length_dist),
            'avg_elo_swing': sum(elo_swings) / len(elo_swings) if elo_swings else 0,
            'max_elo_swing': max(elo_swings) if elo_swings else 0,
            'seven_game_series': series_length_dist.get(7, 0),
            'sweeps': series_length_dist.get(4, 0),
            'potential_comebacks': comebacks
        }
    
    def print_results(self, show_top_n=20):
        """Print comprehensive simulation results."""
        print(f"\n{'='*80}")
        print(f"TOURNAMENT SIMULATION RESULTS ({self.simulations_run:,} simulations)")
        print(f"{'='*80}")
        
        # Championship odds
        print(f"\nCHAMPIONSHIP ODDS (Top {show_top_n}):")
        print(f"{'Rank':<4} {'Username':<20} {'Team ID':<40} {'Wins':<8} {'Probability':<12} {'Odds'}")
        print("-" * 100)
        
        championship_odds = self.get_championship_odds(show_top_n)
        for i, result in enumerate(championship_odds, 1):
            print(f"{i:<4} {result['username']:<20} {result['team_id']:<40} {result['championships']:<8} "
                  f"{result['probability']:.3%} {result['odds']}")
        
        # Round advancement odds for key rounds
        key_rounds = [2, 4, 6, self.max_round] if self.max_round >= 6 else [2, self.max_round]
        round_names = {2: "Round of 64", 4: "Sweet 16", 6: "Final Four", 8: "Championship"}
        
        for round_num in key_rounds:
            if round_num in self.round_reaches:
                print(f"\n{round_names.get(round_num, f'Round {round_num}')} ODDS (Top 10):")
                print(f"{'Username':<20} {'Team ID':<40} {'Reaches':<8} {'Probability'}")
                print("-" * 80)
                
                round_odds = self.get_round_advancement_odds(round_num, 10)
                for result in round_odds:
                    print(f"{result['username']:<20} {result['team_id']:<40} {result['round_reaches']:<8} "
                          f"{result['probability']:.3%}")
        
        # Series analysis (for hot simulations)
        series_stats = self.get_series_analysis()
        if series_stats:
            print(f"\nSERIES ANALYSIS (Hot Simulation):")
            print(f"  Total series played: {series_stats['total_series']:,}")
            print(f"  Average series length: {series_stats['avg_series_length']:.2f} games")
            print(f"  Sweeps (4-0): {series_stats['sweeps']:,}")
            print(f"  Seven-game series: {series_stats['seven_game_series']:,}")
            print(f"  Average ELO swing per team: {series_stats['avg_elo_swing']:.1f}")
            print(f"  Maximum ELO swing: {series_stats['max_elo_swing']:.1f}")
            
            print(f"\n  Series length distribution:")
            for length, count in sorted(series_stats['series_length_distribution'].items()):
                percentage = (count / series_stats['total_series']) * 100
                print(f"    {length} games: {count:,} ({percentage:.1f}%)")
        
        # Team statistics summary
        print(f"\nTOURNAMENT SUMMARY:")
        total_teams = len(self.teams)
        teams_with_championship_chance = len(self.championship_wins)
        print(f"  Total teams: {total_teams}")
        print(f"  Teams that won at least one championship: {teams_with_championship_chance}")
        print(f"  Competitive balance: {teams_with_championship_chance/total_teams:.1%} of teams have a chance")
    
    def export_results_to_csv(self, filename='tournament_odds.csv'):
        """Export championship odds to a CSV file."""
        championship_odds = self.get_championship_odds(top_n=None)  # Get all teams
        
        # Create dataframe with all team data
        results_data = []
        for team_id, team_data in self.teams.items():
            username = team_data['username']
            elo = self.original_elos[team_id]  # Use original ELO rating
            
            # Find championship stats
            champ_stats = next((odds for odds in championship_odds if odds['team_id'] == team_id), None)
            championships = champ_stats['championships'] if champ_stats else 0
            champ_probability = champ_stats['probability'] if champ_stats else 0.0
            
            # Get round advancement probabilities
            round_probs = {}
            for round_num in sorted(self.rounds.keys()):
                reaches = self.round_reaches[round_num].get(team_id, 0)
                round_probs[f'round_{round_num}_prob'] = reaches / self.simulations_run if self.simulations_run > 0 else 0.0
            
            row = {
                'team_id': team_id,
                'username': username,
                'elo': elo,
                'championships': championships,
                'championship_probability': champ_probability,
                **round_probs
            }
            results_data.append(row)
        
        # Sort by championship probability (highest first)
        results_data.sort(key=lambda x: x['championship_probability'], reverse=True)
        
        # Create and save DataFrame
        df = pd.DataFrame(results_data)
        df.to_csv(filename, index=False)
        print(f"\nResults exported to {filename}")
        return df


def main():
    parser = argparse.ArgumentParser(description='Tournament Championship Odds Simulation')
    parser.add_argument('--simulations', '-s', type=int, default=10000,
                       help='Number of simulations to run (default: 10000)')
    parser.add_argument('--verbose', '-v', action='store_true',
                       help='Show progress during simulation')
    parser.add_argument('--teams-file', default='playoff_teams.csv',
                       help='CSV file containing team data (default: playoff_teams.csv)')
    parser.add_argument('--matchups-file', default='playoff_matchups.csv', 
                       help='CSV file containing matchup data (default: playoff_matchups.csv)')
    parser.add_argument('--top-n', type=int, default=20,
                       help='Number of top teams to show in results (default: 20)')
    parser.add_argument('--export-csv', type=str, metavar='FILENAME',
                       help='Export detailed results to CSV file')
    parser.add_argument('--cold', action='store_true',
                       help='Use cold simulation (single matchup outcome) instead of hot simulation (game-by-game)')
    parser.add_argument('--k-factor', type=int, default=128,
                       help='ELO K-factor for rating updates in hot simulation (default: 128, matches your BASE_K_FACTOR)')
    
    args = parser.parse_args()
    
    # Check if files exist
    if not Path(args.teams_file).exists():
        print(f"Error: Teams file '{args.teams_file}' not found")
        sys.exit(1)
    
    if not Path(args.matchups_file).exists():
        print(f"Error: Matchups file '{args.matchups_file}' not found")
        sys.exit(1)
    
    # Initialize and run simulation
    try:
        simulator = TournamentSimulator(args.teams_file, args.matchups_file)
        
        # Set K-factor if using hot simulation
        if not args.cold:
            # We need to pass the K-factor to the simulation somehow
            # For now, let's modify the update_elo_ratings method to use a configurable K-factor
            simulator.k_factor = args.k_factor

        print(f"Using K-factor: {simulator.k_factor}")
        
        # Run simulation (hot by default, cold if --cold flag is used)
        hot_simulation = not args.cold
        simulator.run_simulation(args.simulations, args.verbose, hot_simulation)
        simulator.print_results(args.top_n)
        
        # Export to CSV if requested
        if args.export_csv:
            simulator.export_results_to_csv(args.export_csv)
        
    except Exception as e:
        print(f"Error during simulation: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
