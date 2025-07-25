#!/usr/bin/env python3

import sqlite3
import os
import math

# Database path - same as used in db.js
DB_PATH = os.environ.get('DB_PATH', './teams-2025-07-24-1427.db')

def connect_db():
    """Connect to the SQLite database"""
    return sqlite3.connect(DB_PATH)

def analyze_team_strategy(team_id, cursor):
    """
    Analyze a team's draft strategy based on player positions and pick order
    Returns a dict with strategy flags
    """
    # Get players for this team ordered by pick
    cursor.execute("""
        SELECT position, pick 
        FROM players 
        WHERE team_id = ? 
        ORDER BY pick ASC
    """, (team_id,))
    
    players = cursor.fetchall()
    
    if not players:
        return {
            'elite_te': 0,
            'zero_rb': 0,
            'elite_qb': 0,
            'high_t': 0,
            'hero_rb': 0
        }
    
    # Initialize strategy flags
    strategies = {
        'elite_te': 0,
        'zero_rb': 0,
        'elite_qb': 0,
        'high_t': 0,
        'hero_rb': 0
    }
    
    # Count positions by rounds
    positions_by_round = {}
    rb_picks = []
    
    for position, pick in players:
        round_num = math.ceil(pick / 12)
        if round_num not in positions_by_round:
            positions_by_round[round_num] = []
        positions_by_round[round_num].append(position)
        
        if position == 'RB':
            rb_picks.append(round_num)
    
    # Get first N rounds for analysis
    first_2_rounds = []
    first_4_rounds = []
    first_5_rounds = []
    first_6_rounds = []

    print(team_id)
    print(positions_by_round)
    
    for round_num in sorted(positions_by_round.keys()):
        if round_num <= 2:
            first_2_rounds.extend(positions_by_round[round_num])
        if round_num <= 4:
            first_4_rounds.extend(positions_by_round[round_num])
        if round_num <= 5:
            first_5_rounds.extend(positions_by_round[round_num])
        if round_num <= 6:
            first_6_rounds.extend(positions_by_round[round_num])
    
    # Elite TE: at least 1 TE within first 4 rounds
    if 'TE' in first_4_rounds:
        strategies['elite_te'] = 1
    
    # Elite QB: at least 1 QB within first 4 rounds
    if 'QB' in first_4_rounds:
        strategies['elite_qb'] = 1
    
    # High T: 3+ RBs through first 5 rounds
    rb_count_first_5 = first_5_rounds.count('RB')
    if rb_count_first_5 >= 3:
        strategies['high_t'] = 1
    
    # Zero RB: 0 RBs through 6 rounds
    print(first_6_rounds)
    rb_count_first_6 = first_6_rounds.count('RB')
    if rb_count_first_6 == 0:
        strategies['zero_rb'] = 1
    
    # Hero RB: 1 RB in first two rounds and no RB2 until R7 (at earliest)
    rb_count_first_2 = first_2_rounds.count('RB')
    if rb_count_first_2 == 1 and len(rb_picks) >= 1:
        # Check if second RB comes in round 7 or later
        if len(rb_picks) == 1:
            # Only one RB total - still qualifies as hero RB
            strategies['hero_rb'] = 1
        elif len(rb_picks) >= 2:
            # Check if second RB is in round 7+
            second_rb_pick = sorted(rb_picks)[1]
            if second_rb_pick >= 7:
                strategies['hero_rb'] = 1
    
    return strategies

def update_team_strategies():
    """Main function to update all team strategies"""
    conn = connect_db()
    cursor = conn.cursor()
    
    try:
        # Get all team IDs
        cursor.execute("SELECT id FROM teams")
        team_ids = cursor.fetchall()
        
        print(f"Analyzing {len(team_ids)} teams...")
        
        updated_count = 0
        
        for (team_id,) in team_ids:
            # Analyze this team's strategy
            strategies = analyze_team_strategy(team_id, cursor)
            
            # Update the team's strategy columns
            cursor.execute("""
                UPDATE teams 
                SET elite_te = ?, zero_rb = ?, elite_qb = ?, high_t = ?, hero_rb = ?
                WHERE id = ?
            """, (
                strategies['elite_te'],
                strategies['zero_rb'], 
                strategies['elite_qb'],
                strategies['high_t'],
                strategies['hero_rb'],
                team_id
            ))
            
            updated_count += 1
            
            if updated_count % 100 == 0:
                print(f"Updated {updated_count} teams...")
        
        # Commit all changes
        conn.commit()
        print(f"Successfully updated {updated_count} teams!")
        
        # Show summary statistics
        cursor.execute("""
            SELECT 
                SUM(elite_te) as elite_te_count,
                SUM(zero_rb) as zero_rb_count,
                SUM(elite_qb) as elite_qb_count,
                SUM(high_t) as high_t_count,
                SUM(hero_rb) as hero_rb_count,
                COUNT(*) as total_teams
            FROM teams
        """)
        
        stats = cursor.fetchone()
        print("\nStrategy Summary:")
        print(f"Elite TE: {stats[0]} teams ({stats[0]/stats[5]*100:.1f}%)")
        print(f"Zero RB: {stats[1]} teams ({stats[1]/stats[5]*100:.1f}%)")
        print(f"Elite QB: {stats[2]} teams ({stats[2]/stats[5]*100:.1f}%)")
        print(f"High T: {stats[3]} teams ({stats[3]/stats[5]*100:.1f}%)")
        print(f"Hero RB: {stats[4]} teams ({stats[4]/stats[5]*100:.1f}%)")
        print(f"Total teams: {stats[5]}")
        
    except Exception as e:
        print(f"Error: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    update_team_strategies() 