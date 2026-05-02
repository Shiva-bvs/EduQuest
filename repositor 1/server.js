require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
const port = 3000;
const JWT_SECRET = 'eduquest_super_secret_key_123'; // In a real app, use environment variables

// Enable CORS so our frontend can make requests to this backend
app.use(cors());
app.use(express.json());

// MySQL connection configuration
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'eduquest_db'
});

db.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }
    console.log('Connected to MySQL database!');
});

// Middleware to verify JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token == null) return res.status(401).json({ error: 'Unauthorized' });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden' });
        req.user = user;
        next();
    });
}

// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================

// Register a new user
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Check if user exists
        db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (results.length > 0) return res.status(400).json({ error: 'Email already in use' });

            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Insert user
            db.query('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', 
                [name, email, hashedPassword], 
                (err, result) => {
                    if (err) return res.status(500).json({ error: 'Failed to create user' });
                    
                    // Create token
                    const token = jwt.sign({ id: result.insertId, name: name }, JWT_SECRET);
                    res.status(201).json({ token, user: { id: result.insertId, name, email } });
                }
            );
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Login user
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (results.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const user = results[0];
        
        // Compare password
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

        // Generate token
        const token = jwt.sign({ id: user.id, name: user.name }, JWT_SECRET);
        res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    });
});

// ==========================================
// PROGRESS ENDPOINTS
// ==========================================

// Get user progress (which resources they completed completely, i.e., 30 days)
app.get('/api/progress', authenticateToken, (req, res) => {
    db.query('SELECT resource_id FROM user_progress WHERE user_id = ? AND is_completed = TRUE', [req.user.id], (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        const completedIds = results.map(row => row.resource_id);
        res.json({ completed: completedIds });
    });
});

// Get progress/streak for a specific resource
app.get('/api/progress/:resourceId', authenticateToken, (req, res) => {
    const resourceId = req.params.resourceId;
    db.query('SELECT current_streak, last_played_date, is_completed FROM user_progress WHERE user_id = ? AND resource_id = ?', 
        [req.user.id, resourceId], (err, results) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (results.length === 0) {
                return res.json({ current_streak: 1, last_played_date: null, is_completed: false });
            }
            res.json(results[0]);
    });
});

// Save progress (update streak)
app.post('/api/progress/:resourceId', authenticateToken, (req, res) => {
    const resourceId = req.params.resourceId;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    db.query('SELECT * FROM user_progress WHERE user_id = ? AND resource_id = ?', [req.user.id, resourceId], (err, results) => {
        if (err) return res.status(500).json({ error: 'Failed to check progress' });

        if (results.length === 0) {
            // First time playing
            db.query('INSERT INTO user_progress (user_id, resource_id, current_streak, last_played_date) VALUES (?, ?, 1, ?)', 
                [req.user.id, resourceId, today], (err) => {
                    if (err) return res.status(500).json({ error: 'Failed to save progress' });
                    res.json({ success: true, streak: 1, is_completed: false });
                });
        } else {
            const progress = results[0];
            if (progress.is_completed) return res.json({ success: true, streak: 30, is_completed: true });

            const lastPlayedStr = progress.last_played_date ? new Date(progress.last_played_date).toISOString().split('T')[0] : null;
            
            if (lastPlayedStr === today) {
                // Already played today
                return res.json({ success: true, streak: progress.current_streak, is_completed: progress.is_completed, message: 'Already played today' });
            }

            // Check if played yesterday
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];

            let newStreak = 1;
            if (lastPlayedStr === yesterdayStr) {
                newStreak = progress.current_streak + 1;
            }

            const isCompleted = newStreak >= 30;

            db.query('UPDATE user_progress SET current_streak = ?, last_played_date = ?, is_completed = ? WHERE id = ?',
                [newStreak, today, isCompleted, progress.id], (err) => {
                    if (err) return res.status(500).json({ error: 'Failed to update progress' });
                    res.json({ success: true, streak: newStreak, is_completed: isCompleted });
                });
        }
    });
});

// ==========================================
// EXISTING RESOURCE ENDPOINTS
// ==========================================

app.get('/api/resources', (req, res) => {
    db.query('SELECT * FROM resources', (err, results) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch resources' });
        res.json(results);
    });
});

app.get('/api/resources/:id', (req, res) => {
    db.query('SELECT * FROM resources WHERE id = ?', [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch resource' });
        if (results.length === 0) return res.status(404).json({ error: 'Resource not found' });
        res.json(results[0]);
    });
});

app.get('/api/quizzes/:resourceId', (req, res) => {
    db.query('SELECT * FROM quizzes WHERE resource_id = ?', [req.params.resourceId], (err, results) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch quiz' });
        if (results.length === 0) return res.status(404).json({ error: 'Quiz not found' });
        res.json(results[0]);
    });
});

// ==========================================
// GEMINI AI ENDPOINTS
// ==========================================

app.get('/api/gemini/quiz', async (req, res) => {
    try {
        const topic = req.query.topic || 'General Knowledge';
        const level = parseInt(req.query.level) || 1; // 1 to 30

        // Using gemini-1.5-flash for fast responses
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `Generate a HIGHLY UNIQUE, creative, and completely random multiple choice question about ${topic}. 
The user is on Day ${level} out of 30 of their learning streak. 
As the level approaches 30, the question must become significantly harder, more obscure, and highly technical. 
Current Difficulty Level: ${level}/30.
Do not use common or basic examples. Make it interesting! 
Random Seed: ${Math.random()}

Return ONLY a valid JSON object in the following format:
{
  "question": "The question text",
  "option_a": "First option",
  "option_b": "Second option",
  "option_c": "Third option",
  "correct_option": "A" (or "B" or "C")
}
Do not include markdown blocks or any other text outside the JSON.`;

        const result = await model.generateContent(prompt);
        let text = result.response.text();
        
        // Clean up markdown if AI included it
        text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        
        const quizData = JSON.parse(text);
        res.json(quizData);
    } catch (error) {
        console.error('Gemini Quiz Error:', error);
        res.status(500).json({ error: 'Failed to generate quiz' });
    }
});

app.post('/api/gemini/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `You are a helpful, enthusiastic, and knowledgeable AI tutor for the 'EduQuest' educational platform.
Keep your answers brief, friendly, and engaging. Do not use more than 2-3 short sentences.
The user says: "${message}"`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        
        res.json({ response: text });
    } catch (error) {
        console.error('Gemini Chat Error:', error);
        res.status(500).json({ error: 'Failed to generate chat response' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
