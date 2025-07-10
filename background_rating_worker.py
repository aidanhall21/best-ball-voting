#!/usr/bin/env python3
"""
Background worker that runs team rating exports every 6 hours
"""
import time
import subprocess
import sys
import os
import logging
from datetime import datetime, timedelta

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def run_rating_export():
    """Run the team rating export script"""
    try:
        logger.info("Starting team rating export...")
        
        # Run the export script
        result = subprocess.run([
            sys.executable, 
            'scripts/export_team_ratings.py'
        ], capture_output=True, text=True, check=True)
        
        logger.info("Team rating export completed successfully")
        logger.info(f"Output: {result.stdout}")
        
        if result.stderr:
            logger.warning(f"Warnings: {result.stderr}")
            
    except subprocess.CalledProcessError as e:
        logger.error(f"Team rating export failed with exit code {e.returncode}")
        logger.error(f"Error output: {e.stderr}")
        logger.error(f"Standard output: {e.stdout}")
    except Exception as e:
        logger.error(f"Unexpected error during team rating export: {e}")

def update_health_status():
    """Write health status for monitoring"""
    try:
        health_file = os.path.join(os.getenv('SESSION_DIR', '.'), 'worker_health.txt')
        with open(health_file, 'w') as f:
            f.write(f"last_run: {datetime.now().isoformat()}\n")
            f.write(f"status: healthy\n")
        logger.info(f"Updated health status file: {health_file}")
    except Exception as e:
        logger.error(f"Failed to update health status: {e}")

def main():
    """Main worker loop"""
    logger.info("Background rating worker started")
    
    # Get sleep duration from environment (default 6 hours)
    sleep_hours = int(os.getenv('SLEEP_HOURS', '6'))
    sleep_duration = sleep_hours * 60 * 60
    
    logger.info(f"Worker will run team rating export every {sleep_hours} hours")
    logger.info(f"Environment check - DB_PATH: {os.getenv('DB_PATH', 'NOT SET')}")
    logger.info(f"Environment check - BASE_URL: {os.getenv('BASE_URL', 'NOT SET')}")
    
    # Run immediately on startup
    logger.info("Running initial team rating export...")
    run_rating_export()
    update_health_status()
    
    # Then run every N hours
    while True:
        try:
            next_run = datetime.now() + timedelta(seconds=sleep_duration)
            logger.info(f"Sleeping for {sleep_duration} seconds ({sleep_hours} hours)...")
            logger.info(f"Next run scheduled for: {next_run.strftime('%Y-%m-%d %H:%M:%S UTC')}")
            
            time.sleep(sleep_duration)
            
            logger.info("Waking up to run team rating export...")
            run_rating_export()
            update_health_status()
            
        except KeyboardInterrupt:
            logger.info("Received interrupt signal, shutting down worker...")
            break
        except Exception as e:
            logger.error(f"Unexpected error in main loop: {e}")
            logger.info("Continuing after error...")
            time.sleep(60)  # Wait 1 minute before trying again

if __name__ == "__main__":
    main() 