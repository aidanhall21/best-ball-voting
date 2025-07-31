const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Database path - adjust if needed
const DB_PATH = process.env.DB_PATH || "../teams-2025-07-31-1529.db";
console.log('DB_PATH', DB_PATH);

// Connect to database
const db = new sqlite3.Database(DB_PATH);

// Query to find duplicate players (where team_id, position, pick combination is not unique)
const query = `
  SELECT 
    p.team_id,
    p.position,
    p.name,
    p.pick,
    p.team,
    p.stack,
    p.picked_at,
    p.appearance,
    t.username,
    COUNT(*) OVER (PARTITION BY p.team_id, p.position, p.pick) as duplicate_count
  FROM players p
  LEFT JOIN teams t ON p.team_id = t.id
  WHERE (p.team_id, p.position, p.pick) IN (
    SELECT team_id, position, pick
    FROM players
    GROUP BY team_id, position, pick
    HAVING COUNT(*) > 1
  )
  ORDER BY p.team_id, p.position, p.pick, p.name
`;

// Function to escape CSV values
function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const stringValue = String(value);
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

// Function to convert array of objects to CSV
function arrayToCsv(data) {
  if (data.length === 0) return '';
  
  const headers = Object.keys(data[0]);
  const csvRows = [];
  
  // Add header row
  csvRows.push(headers.map(header => escapeCsvValue(header)).join(','));
  
  // Add data rows
  data.forEach(row => {
    const values = headers.map(header => escapeCsvValue(row[header]));
    csvRows.push(values.join(','));
  });
  
  return csvRows.join('\n');
}

// Main execution
db.all(query, [], (err, rows) => {
  if (err) {
    console.error('Error executing query:', err);
    db.close();
    return;
  }
  
  if (rows.length === 0) {
    console.log('No duplicate players found! All player entries have unique team_id + position + pick combinations.');
    db.close();
    return;
  }
  
  // Convert to CSV
  const csvContent = arrayToCsv(rows);
  
  // Generate filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const filename = `duplicate_players_${timestamp}.csv`;
  
  // Write to file
  fs.writeFileSync(filename, csvContent);
  
  console.log(`CSV file created: ${filename}`);
  console.log(`Total duplicate player entries found: ${rows.length}`);
  console.log(`Columns: team_id, position, name, pick, team, stack, picked_at, appearance, username, duplicate_count`);
  
  // Show some sample data
  console.log('\nSample data (first 5 rows):');
  console.log('team_id, position, name, pick, team, duplicate_count');
  rows.slice(0, 5).forEach(row => {
    console.log(`${row.team_id}, ${row.position}, ${row.name}, ${row.pick}, ${row.team}, ${row.duplicate_count}`);
  });
  
  if (rows.length > 5) {
    console.log(`... and ${rows.length - 5} more rows`);
  }
  
  db.close();
}); 