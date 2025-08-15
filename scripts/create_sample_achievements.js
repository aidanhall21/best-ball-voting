const { db } = require('../db.js');

// Sample achievements to create
const sampleAchievements = [
  {
    id: 'first_upload',
    name: 'First Upload',
    description: 'Uploaded your first team to Draft or Pass',
    image_path: '/public/achievements/first_upload.png',
    category: 'upload',
    sort_order: 1
  },
  {
    id: 'early_adopter',
    name: 'Early Adopter',
    description: 'One of the first users to join Draft or Pass',
    image_path: '/public/achievements/early_adopter.png',
    category: 'special',
    sort_order: 10
  },
  {
    id: 'tournament_winner',
    name: 'Tournament Champion',
    description: 'Won a Draft or Pass tournament',
    image_path: '/public/achievements/tournament_winner.png',
    category: 'tournament',
    sort_order: 100
  },
  {
    id: 'prolific_uploader',
    name: 'Prolific Uploader',
    description: 'Uploaded 10 or more teams',
    image_path: '/public/achievements/prolific_uploader.png',
    category: 'upload',
    sort_order: 5
  },
  {
    id: 'voting_champion',
    name: 'Voting Champion',
    description: 'Cast 100+ votes on other teams',
    image_path: '/public/achievements/voting_champion.png',
    category: 'voting',
    sort_order: 20
  }
];

console.log('Creating sample achievements...');

// Insert each achievement
const insertPromises = sampleAchievements.map(achievement => {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT OR IGNORE INTO achievements (id, name, description, image_path, category, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    db.run(sql, [
      achievement.id,
      achievement.name,
      achievement.description,
      achievement.image_path,
      achievement.category,
      achievement.sort_order
    ], function(err) {
      if (err) {
        console.error(`Error creating achievement ${achievement.id}:`, err);
        reject(err);
      } else {
        console.log(`✓ Created achievement: ${achievement.name}`);
        resolve();
      }
    });
  });
});

Promise.all(insertPromises)
  .then(() => {
    console.log('\n✅ All sample achievements created successfully!');
    console.log('\nYou can now:');
    console.log('1. Visit /achievements-admin.html to manage achievements');
    console.log('2. Award achievements to users');
    console.log('3. View achievements on user profiles');
    console.log('\nNote: You may want to add your own achievement images to public/achievements/');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Error creating achievements:', err);
    process.exit(1);
  });
