require('dotenv').config();
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const TwitterStrategy = require('passport-twitter').Strategy;
const bcrypt = require('bcryptjs');
const { db } = require('./db');

// --- Local Strategy: email + password ---
passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) return done(err);
    if (!user) return done(null, false, { message: 'Incorrect email' });
    try {
      const match = await bcrypt.compare(password, user.password_hash || '');
      if (!match) return done(null, false, { message: 'Incorrect password' });
      return done(null, user);
    } catch (e) {
      return done(e);
    }
  });
}));

// --- Twitter Strategy ---
passport.use(new TwitterStrategy(
  {
    consumerKey: process.env.TWITTER_CONSUMER_KEY || 'CHANGE_ME',
    consumerSecret: process.env.TWITTER_CONSUMER_SECRET || 'CHANGE_ME',
    callbackURL: process.env.TWITTER_CALLBACK_URL || 'https://draftrpass.com/auth/twitter/callback',
    includeEmail: true
  },
  (token, tokenSecret, profile, done) => {
    const twitterId = profile.id;
    const twitterUsername = profile.username;
    const displayName = profile.displayName || profile.username || 'Twitter User';
    const email = Array.isArray(profile.emails) && profile.emails[0] ? profile.emails[0].value : null;

    db.get('SELECT * FROM users WHERE twitter_id = ?', [twitterId], (err, existing) => {
      if (err) return done(err);

      // --- Existing user ---
      if (existing) {
        if (!existing.email && email) {
          // back-fill email and username if we don't have them
          db.run('UPDATE users SET email = ?, twitter_username = ? WHERE id = ?', 
            [email, twitterUsername, existing.id], 
            (err) => {
              if (err) console.error('Error updating user:', err);
              existing.email = email;
              existing.twitter_username = twitterUsername;
              return done(null, existing);
            }
          );
        } else {
          return done(null, existing);
        }
      } else {
        // --- New user ---
        db.run(
          'INSERT INTO users (email, twitter_id, display_name, twitter_username) VALUES (?,?,?,?)',
          [email, twitterId, displayName, twitterUsername],
          function (insertErr) {
            if (insertErr) {
              // If insert failed due to unique email, try linking to existing user by email
              if (insertErr.message && insertErr.message.includes('UNIQUE constraint failed: users.email') && email) {
                db.get('SELECT * FROM users WHERE email = ?', [email], (selErr, existingEmailUser) => {
                  if (selErr) return done(selErr);
                  if (!existingEmailUser) return done(insertErr); // nothing we can do

                  // Link twitter fields to existing account if not already linked
                  db.run('UPDATE users SET twitter_id = ?, twitter_username = ? WHERE id = ?', [twitterId, twitterUsername, existingEmailUser.id], (updErr) => {
                    if (updErr) return done(updErr);
                    existingEmailUser.twitter_id = twitterId;
                    existingEmailUser.twitter_username = twitterUsername;
                    return done(null, existingEmailUser);
                  });
                });
              } else {
                return done(insertErr);
              }
            } else {
              db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (selErr, newUser) => {
                if (selErr) return done(selErr);
                return done(null, newUser);
              });
            }
          }
        );
      }
    });
  }
));

// --- Serialize / deserialize ---
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    done(err, user);
  });
});

module.exports = passport; 