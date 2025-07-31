const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Debug logging function with emojis
function debug(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    if (data) {
        console.log('📊 Data:', JSON.stringify(data, null, 2));
    }
}

app.use(express.json());

// Database configuration with debug logging
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Debug database connection events
pool.on('connect', () => {
    debug('🔌 New client connected to the database');
});

pool.on('error', (err) => {
    debug('❌ Database pool error:', err);
});

// Initialize database
async function initializeDatabase() {
    debug('🔄 Starting database initialization');
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS registrations (
                id SERIAL PRIMARY KEY,
                roblox_username VARCHAR(255) NOT NULL,
                discord_username VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Add reason column if it doesn't exist
        await pool.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 
                    FROM information_schema.columns 
                    WHERE table_name = 'registrations' 
                    AND column_name = 'reason'
                ) THEN
                    ALTER TABLE registrations ADD COLUMN reason TEXT;
                END IF;
            END $$;
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS generatedkeys (
                id SERIAL PRIMARY KEY,
                registration_id INTEGER REFERENCES registrations(id),
                serial VARCHAR(255) NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        debug('✅ Database tables verified successfully');
        
        // Test the connection
        const testResult = await pool.query('SELECT NOW()');
        debug('✅ Database connection test successful', { timestamp: testResult.rows[0].now });
    } catch (error) {
        debug('❌ Database initialization error:', error);
        throw error;
    }
}

// Validate Roblox username
async function validateRobloxUser(username) {
    try {
        // Basic validation for Roblox username
        // Roblox usernames must be between 3 and 20 characters
        // and can only contain letters, numbers, and underscores
        const robloxUsernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
        return robloxUsernameRegex.test(username);
    } catch (error) {
        debug('❌ Error validating Roblox user:', error);
        return false;
    }
}

// Validate Discord username
async function validateDiscordUser(username) {
    try {
        // Discord username format: username (2-32 characters)
        // Can contain letters, numbers, underscores, and dots
        const discordUsernameRegex = /^[a-zA-Z0-9_.]{2,32}$/;
        return discordUsernameRegex.test(username);
    } catch (error) {
        debug('❌ Error validating Discord user:', error);
        return false;
    }
}

// API endpoints
app.post('/api/validate-users', async (req, res) => {
    debug('🔍 Received user validation request', req.body);
    try {
        const { robloxUsername, discordUsername, reason } = req.body;
        
        if (!robloxUsername || !discordUsername || !reason) {
            debug('⚠️ Missing required fields in request');
            return res.status(400).json({ 
                error: 'Missing required fields',
                details: {
                    roblox: !robloxUsername,
                    discord: !discordUsername,
                    reason: !reason
                }
            });
        }

        const [robloxValid, discordValid] = await Promise.all([
            validateRobloxUser(robloxUsername),
            validateDiscordUser(discordUsername)
        ]);

        if (!robloxValid || !discordValid) {
            debug('⚠️ Invalid usernames', { robloxValid, discordValid });
            return res.status(400).json({
                error: 'Invalid usernames',
                details: {
                    roblox: !robloxValid,
                    discord: !discordValid
                }
            });
        }

        // Save the registration information
        const registrationResult = await pool.query(
            'INSERT INTO registrations (roblox_username, discord_username, reason) VALUES ($1, $2, $3) RETURNING *',
            [robloxUsername, discordUsername, reason]
        );
        
        debug('✅ Registration saved successfully', { 
            registration: registrationResult.rows[0]
        });

        res.json({ 
            success: true, 
            data: registrationResult.rows[0],
            validation: {
                roblox: true,
                discord: true
            }
        });
    } catch (error) {
        debug('❌ Error processing registration:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    debug('🏥 Health check requested');
    try {
        const result = await pool.query('SELECT NOW()');
        debug('✅ Health check successful', { timestamp: result.rows[0].now });
        res.json({ 
            status: 'ok',
            database: 'connected',
            timestamp: result.rows[0].now
        });
    } catch (error) {
        debug('❌ Health check failed:', error);
        res.status(500).json({ 
            status: 'error',
            database: 'disconnected',
            error: error.message
        });
    }
});

// Check if serial key exists
app.post('/api/check-serial', async (req, res) => {
    debug('🔍 Received serial key check request', req.body);
    try {
        const { serial } = req.body;
        
        if (!serial) {
            debug('⚠️ Missing serial key in request');
            return res.status(400).json({ error: 'Serial key is required' });
        }

        // Check if serial key exists in database
        const result = await pool.query(
            'SELECT EXISTS(SELECT 1 FROM generatedkeys WHERE serial = $1)',
            [serial]
        );
        
        debug('✅ Serial key check completed', { exists: result.rows[0].exists });
        res.json({ exists: result.rows[0].exists });
    } catch (error) {
        debug('❌ Error checking serial key:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Save serial key
app.post('/api/save-serial', async (req, res) => {
    debug('💾 Received serial key save request', req.body);
    try {
        const { serial } = req.body;
        
        if (!serial) {
            debug('⚠️ Missing serial key in request');
            return res.status(400).json({ error: 'Serial key is required' });
        }

        // Save the serial key
        const result = await pool.query(
            'INSERT INTO generatedkeys (serial) VALUES ($1) RETURNING *',
            [serial]
        );
        
        debug('✅ Serial key saved successfully', result.rows[0]);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        debug('❌ Error saving serial key:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Validate serial key for download
app.post('/api/validate-download', async (req, res) => {
    debug('🔍 Received download validation request', req.body);
    try {
        const { serial } = req.body;
        
        if (!serial) {
            debug('⚠️ Missing serial key in request');
            return res.status(400).json({ error: 'Serial key is required' });
        }

        // Check if serial key exists in database
        const result = await pool.query(
            'SELECT EXISTS(SELECT 1 FROM generatedkeys WHERE serial = $1)',
            [serial]
        );
        
        debug('✅ Download validation completed', { valid: result.rows[0].exists });
        res.json({ valid: result.rows[0].exists });
    } catch (error) {
        debug('❌ Error validating download:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Generate and save serial key after payment
app.post('/api/generate-serial', async (req, res) => {
    debug('🔑 Received serial key generation request', req.body);
    try {
        const { robloxUsername } = req.body;
        
        if (!robloxUsername) {
            debug('⚠️ Missing Roblox username in request');
            return res.status(400).json({ error: 'Roblox username is required' });
        }

        // Start a transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check if registration exists
            const registrationResult = await client.query(
                'SELECT * FROM registrations WHERE roblox_username = $1 FOR UPDATE',
                [robloxUsername]
            );

            if (registrationResult.rows.length === 0) {
                debug('⚠️ Registration not found');
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Registration not found' });
            }

            const registrationId = registrationResult.rows[0].id;

            // Check if a serial key already exists for this registration
            const existingKeyResult = await client.query(
                'SELECT * FROM generatedkeys WHERE registration_id = $1',
                [registrationId]
            );

            if (existingKeyResult.rows.length > 0) {
                debug('⚠️ Serial key already exists for this registration');
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    error: 'Serial key already generated for this registration',
                    serialKey: existingKeyResult.rows[0].serial
                });
            }

            // Generate a serial key
            const serialKey = 'scriptxserial_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

            // Save the serial key with registration_id
            const keyResult = await client.query(
                'INSERT INTO generatedkeys (registration_id, serial) VALUES ($1, $2) RETURNING *',
                [registrationId, serialKey]
            );
            
            await client.query('COMMIT');
            
            debug('✅ Serial key generated and saved successfully', { 
                registrationId,
                serialKey: keyResult.rows[0]
            });

            res.json({ 
                success: true, 
                serialKey: keyResult.rows[0].serial
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        debug('❌ Error generating serial key:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
async function startServer() {
    debug('🚀 Starting server initialization');
    try {
        await initializeDatabase();
        app.listen(port, () => {
            debug(`✅ Server running on port ${port}`);
        });
    } catch (error) {
        debug('❌ Server startup error:', error);
        process.exit(1);
    }
}

startServer(); 
