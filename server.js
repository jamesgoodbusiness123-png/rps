const express = require('express');
const path = require('path');

const app = express();

// Pterodactyl automatically sets PORT environment variable
// Fallback to 3000 for local testing
const PORT = process.env.PORT || 20044;

console.log('🚀 Starting server...');
console.log('📍 Port:', PORT);
console.log('🌐 Environment:', process.env.NODE_ENV || 'development');

// Serve static files
app.use(express.static(path.join(__dirname)));

// Main route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        port: PORT,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Catch-all route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
    console.error('❌ Error:', err);
    res.status(500).send('Internal Server Error');
});

// Start server on all interfaces (0.0.0.0) so Pterodactyl can access it
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('✅ Server successfully started!');
    console.log(`🌐 Listening on: http://0.0.0.0:${PORT}`);
    console.log(`📡 Ready to accept connections`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('⚠️  SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
