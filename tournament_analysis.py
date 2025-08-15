#!/usr/bin/env python3
"""
Tournament Analysis and Visualization

Analyzes the tournament simulation results and creates visualizations.
Reads from the tournament_championship_odds.csv file created by tournament_simulation.py

Features:
- Championship odds comparison
- ELO rating vs tournament success correlation
- Round-by-round advancement analysis
- User performance summary (for users with multiple teams)

Usage:
    python tournament_analysis.py [--csv-file tournament_championship_odds.csv]
"""

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from collections import defaultdict
import argparse
from pathlib import Path

def load_tournament_data(csv_file='tournament_championship_odds.csv'):
    """Load tournament simulation results from CSV."""
    if not Path(csv_file).exists():
        raise FileNotFoundError(f"Results file '{csv_file}' not found. Run tournament_simulation.py first.")
    
    df = pd.read_csv(csv_file)
    print(f"Loaded {len(df)} teams from {csv_file}")
    return df

def analyze_elo_vs_success(df):
    """Analyze correlation between ELO rating and tournament success."""
    print("\n" + "="*60)
    print("ELO RATING vs TOURNAMENT SUCCESS ANALYSIS")
    print("="*60)
    
    # Calculate correlations
    elo_champ_corr = df['elo'].corr(df['championship_probability'])
    elo_final4_corr = df['elo'].corr(df['round_6_prob'])
    
    print(f"ELO vs Championship Probability Correlation: {elo_champ_corr:.3f}")
    print(f"ELO vs Final Four Probability Correlation: {elo_final4_corr:.3f}")
    
    # ELO distribution analysis
    elo_ranges = [(0, 1600), (1600, 1700), (1700, 1750), (1750, 1800), (1800, 2000)]
    
    print(f"\nChampionship odds by ELO range:")
    print(f"{'ELO Range':<15} {'Teams':<6} {'Avg Champ %':<12} {'Total Champ %':<15}")
    print("-" * 55)
    
    for min_elo, max_elo in elo_ranges:
        range_teams = df[(df['elo'] >= min_elo) & (df['elo'] < max_elo)]
        if len(range_teams) > 0:
            avg_champ_prob = range_teams['championship_probability'].mean() * 100
            total_champ_prob = range_teams['championship_probability'].sum() * 100
            range_name = f"{min_elo}-{max_elo}" if max_elo < 2000 else f"{min_elo}+"
            print(f"{range_name:<15} {len(range_teams):<6} {avg_champ_prob:<12.3f} {total_champ_prob:<15.1f}")

def analyze_user_performance(df):
    """Analyze performance for users with multiple teams."""
    print("\n" + "="*60)
    print("USER PERFORMANCE ANALYSIS (Multiple Teams)")
    print("="*60)
    
    # Group by username
    user_stats = df.groupby('username').agg({
        'team_id': 'count',
        'elo': ['mean', 'max', 'min'],
        'championship_probability': 'sum',
        'round_6_prob': 'sum',  # Final Four
        'round_4_prob': 'sum'   # Sweet 16
    }).round(4)
    
    # Flatten column names
    user_stats.columns = [
        'team_count', 'avg_elo', 'max_elo', 'min_elo',
        'total_champ_prob', 'total_final4_prob', 'total_sweet16_prob'
    ]
    
    # Filter users with multiple teams
    multi_team_users = user_stats[user_stats['team_count'] > 1].copy()
    multi_team_users = multi_team_users.sort_values('total_champ_prob', ascending=False)
    
    print(f"Users with multiple teams: {len(multi_team_users)}")
    print(f"\nTop users by total championship probability:")
    print(f"{'Username':<20} {'Teams':<6} {'Total Champ %':<14} {'Avg ELO':<10}")
    print("-" * 60)
    
    for username, stats in multi_team_users.head(15).iterrows():
        champ_pct = stats['total_champ_prob'] * 100
        avg_elo = stats['avg_elo']
        team_count = int(stats['team_count'])
        print(f"{username:<20} {team_count:<6} {champ_pct:<14.2f} {avg_elo:<10.0f}")

def analyze_round_advancement(df):
    """Analyze round-by-round advancement probabilities."""
    print("\n" + "="*60)
    print("ROUND ADVANCEMENT ANALYSIS")
    print("="*60)
    
    round_cols = [col for col in df.columns if col.startswith('round_') and col.endswith('_prob')]
    round_numbers = sorted([int(col.split('_')[1]) for col in round_cols])
    
    print("Average advancement probability by round:")
    print(f"{'Round':<8} {'Round Name':<15} {'Avg %':<10} {'Top Team %':<12}")
    print("-" * 50)
    
    round_names = {
        1: "Round of 256",
        2: "Round of 128", 
        3: "Round of 64",
        4: "Round of 32",
        5: "Sweet 16",
        6: "Elite 8",
        7: "Final Four",
        8: "Championship"
    }
    
    for round_num in round_numbers:
        col_name = f'round_{round_num}_prob'
        avg_prob = df[col_name].mean() * 100
        max_prob = df[col_name].max() * 100
        round_name = round_names.get(round_num, f"Round {round_num}")
        print(f"{round_num:<8} {round_name:<15} {avg_prob:<10.2f} {max_prob:<12.1f}")

def create_visualizations(df, save_plots=True):
    """Create visualization plots."""
    print("\n" + "="*60)
    print("CREATING VISUALIZATIONS")
    print("="*60)
    
    # Set up the plotting style
    plt.style.use('default')
    sns.set_palette("husl")
    
    # Figure 1: ELO vs Championship Probability
    fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(15, 12))
    
    # Scatter plot: ELO vs Championship Probability
    scatter = ax1.scatter(df['elo'], df['championship_probability'] * 100, 
                         alpha=0.6, s=30)
    ax1.set_xlabel('ELO Rating')
    ax1.set_ylabel('Championship Probability (%)')
    ax1.set_title('ELO Rating vs Championship Probability')
    ax1.grid(True, alpha=0.3)
    
    # Add trend line
    z = np.polyfit(df['elo'], df['championship_probability'] * 100, 1)
    p = np.poly1d(z)
    ax1.plot(df['elo'], p(df['elo']), "r--", alpha=0.8, linewidth=2)
    
    # Top 20 teams bar chart
    top_20 = df.nlargest(20, 'championship_probability')
    bars = ax2.bar(range(len(top_20)), top_20['championship_probability'] * 100)
    ax2.set_xlabel('Team Rank')
    ax2.set_ylabel('Championship Probability (%)')
    ax2.set_title('Top 20 Teams - Championship Odds')
    ax2.set_xticks(range(0, len(top_20), 2))
    ax2.set_xticklabels(range(1, len(top_20)+1, 2))
    
    # ELO distribution histogram
    ax3.hist(df['elo'], bins=30, alpha=0.7, edgecolor='black')
    ax3.set_xlabel('ELO Rating')
    ax3.set_ylabel('Number of Teams')
    ax3.set_title('ELO Rating Distribution')
    ax3.grid(True, alpha=0.3)
    
    # Round advancement probabilities for top teams
    round_cols = [col for col in df.columns if col.startswith('round_') and col.endswith('_prob')]
    round_numbers = sorted([int(col.split('_')[1]) for col in round_cols])
    
    top_5_teams = df.nlargest(5, 'championship_probability')
    
    for i, (_, team) in enumerate(top_5_teams.iterrows()):
        round_probs = [team[f'round_{r}_prob'] * 100 for r in round_numbers]
        ax4.plot(round_numbers, round_probs, marker='o', linewidth=2, 
                label=f"{team['username'][:12]}... (ELO: {team['elo']:.0f})")
    
    ax4.set_xlabel('Tournament Round')
    ax4.set_ylabel('Advancement Probability (%)')
    ax4.set_title('Round Advancement - Top 5 Teams')
    ax4.legend(fontsize=8)
    ax4.grid(True, alpha=0.3)
    ax4.set_xticks(round_numbers)
    
    plt.tight_layout()
    
    if save_plots:
        plt.savefig('tournament_analysis.png', dpi=300, bbox_inches='tight')
        print("Visualization saved as tournament_analysis.png")
    
    plt.show()

def print_key_insights(df):
    """Print key insights from the analysis."""
    print("\n" + "="*60)
    print("KEY INSIGHTS")
    print("="*60)
    
    top_team = df.loc[df['championship_probability'].idxmax()]
    highest_elo = df.loc[df['elo'].idxmax()]
    biggest_upset_potential = df.loc[(df['elo'] < 1650) & (df['championship_probability'] > 0)]['championship_probability'].max()
    
    print(f"🏆 Championship Favorite: {top_team['username']} ({top_team['championship_probability']*100:.2f}% chance)")
    print(f"⭐ Highest ELO: {highest_elo['username']} ({highest_elo['elo']:.1f} ELO)")
    print(f"📊 Total teams with championship chance: {len(df[df['championship_probability'] > 0])}")
    print(f"🎯 Average championship probability: {df['championship_probability'].mean()*100:.3f}%")
    print(f"🔥 Biggest dark horse potential: {biggest_upset_potential*100:.3f}% (ELO < 1650)")
    
    # ELO gaps
    elo_range = df['elo'].max() - df['elo'].min()
    print(f"📈 ELO range: {df['elo'].min():.1f} - {df['elo'].max():.1f} ({elo_range:.1f} point spread)")
    
    # Competition level
    top_10_share = df.nlargest(10, 'championship_probability')['championship_probability'].sum()
    print(f"🏅 Top 10 teams control: {top_10_share*100:.1f}% of championship probability")

def main():
    parser = argparse.ArgumentParser(description='Tournament Analysis and Visualization')
    parser.add_argument('--csv-file', default='tournament_championship_odds.csv',
                       help='CSV file with tournament results (default: tournament_championship_odds.csv)')
    parser.add_argument('--no-plots', action='store_true',
                       help='Skip creating visualization plots')
    
    args = parser.parse_args()
    
    try:
        # Load data
        df = load_tournament_data(args.csv_file)
        
        # Run analyses
        analyze_elo_vs_success(df)
        analyze_user_performance(df)
        analyze_round_advancement(df)
        print_key_insights(df)
        
        # Create visualizations
        if not args.no_plots:
            create_visualizations(df)
        
    except Exception as e:
        print(f"Error during analysis: {e}")
        return 1
    
    return 0

if __name__ == "__main__":
    exit(main())
