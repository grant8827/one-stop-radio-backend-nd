const http = require('http');
const url = require('url');

// Mock stream server state
let streamState = {
    status: 'disconnected', // disconnected, connecting, connected, streaming, error
    statusMessage: 'Not connected',
    connectedTime: 0,
    bytesSent: 0,
    currentBitrate: 0.0,
    peakLevelLeft: 0.0,
    peakLevelRight: 0.0,
    currentListeners: 0,
    reconnectCount: 0,
    startTime: null,
    config: null,
    currentTrack: {
        artist: 'Unknown Artist',
        title: 'Unknown Track'
    }
};

// Helper function to create CORS-enabled JSON response
function jsonResponse(res, data, statusCode = 200) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data, null, 2));
}

// Handle OPTIONS requests (CORS preflight)
function handleOptions(res) {
    res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
}

// Parse request body
function parseBody(req, callback) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    req.on('end', () => {
        try {
            const data = body ? JSON.parse(body) : {};
            callback(null, data);
        } catch (err) {
            callback(err, null);
        }
    });
}

// Simulate streaming statistics updates
function updateStreamStats() {
    if (streamState.status === 'streaming') {
        streamState.bytesSent += Math.floor(Math.random() * 2048) + 1024; // 1-3KB per update
        streamState.currentBitrate = 128 + Math.random() * 10 - 5; // 123-133 kbps
        streamState.peakLevelLeft = Math.random() * 0.4 + 0.3; // 0.3-0.7
        streamState.peakLevelRight = Math.random() * 0.4 + 0.3; // 0.3-0.7
        
        // Simulate listener changes
        if (Math.random() > 0.8) {
            streamState.currentListeners += Math.floor(Math.random() * 3) - 1;
            if (streamState.currentListeners < 0) streamState.currentListeners = 0;
            if (streamState.currentListeners > 100) streamState.currentListeners = 100;
        }
        
        // Update connected time
        if (streamState.startTime) {
            streamState.connectedTime = Date.now() - streamState.startTime;
        }
    }
}

// Start stats update interval
setInterval(updateStreamStats, 2000);

// Request handler
function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;
    const method = req.method;

    console.log(`📡 ${method} ${path}`);

    // Handle CORS preflight
    if (method === 'OPTIONS') {
        return handleOptions(res);
    }

    // Route handling
    switch (path) {
        case '/api/health':
            if (method === 'GET') {
                return jsonResponse(res, {
                    success: true,
                    service: 'OneStopRadio Mock Stream API',
                    version: '1.0.0',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString()
                });
            }
            break;

        case '/api/audio/stream/status':
            if (method === 'GET') {
                return jsonResponse(res, {
                    success: true,
                    stats: streamState
                });
            }
            break;

        case '/api/audio/stream/connect':
            if (method === 'POST') {
                parseBody(req, (err, body) => {
                    if (err) {
                        return jsonResponse(res, { success: false, error: 'Invalid JSON' }, 400);
                    }
                    
                    // Validate required fields
                    if (!body.serverHost || !body.serverPort || !body.password) {
                        return jsonResponse(res, {
                            success: false,
                            error: 'Missing required fields: serverHost, serverPort, password'
                        }, 400);
                    }
                    
                    // Store configuration
                    streamState.config = body;
                    streamState.status = 'connected';
                    streamState.statusMessage = `Connected to ${body.serverHost}:${body.serverPort}`;
                    streamState.startTime = Date.now();
                    streamState.connectedTime = 0;
                    streamState.bytesSent = 0;
                    
                    console.log(`✅ Connected to ${body.protocol} server: ${body.serverHost}:${body.serverPort}`);
                    console.log(`🎵 Mount: ${body.mountPoint}, Codec: ${body.codec}, Bitrate: ${body.bitrate}kbps`);
                    
                    return jsonResponse(res, {
                        success: true,
                        action: 'stream_connect',
                        status: 'connected'
                    });
                });
                return;
            }
            break;

        case '/api/audio/stream/disconnect':
            if (method === 'POST') {
                streamState.status = 'disconnected';
                streamState.statusMessage = 'Disconnected';
                streamState.currentListeners = 0;
                streamState.bytesSent = 0;
                streamState.startTime = null;
                streamState.config = null;
                
                console.log('🔌 Disconnected from stream server');
                
                return jsonResponse(res, {
                    success: true,
                    action: 'stream_disconnect',
                    status: 'disconnected'
                });
            }
            break;

        case '/api/audio/stream/start':
            if (method === 'POST') {
                if (streamState.status === 'connected') {
                    streamState.status = 'streaming';
                    streamState.statusMessage = 'Streaming live';
                    streamState.currentListeners = Math.floor(Math.random() * 20) + 5; // 5-25 initial listeners
                    
                    console.log('🔴 Started live streaming!');
                    console.log(`📊 Initial listeners: ${streamState.currentListeners}`);
                    
                    return jsonResponse(res, {
                        success: true,
                        action: 'streaming_start',
                        status: 'streaming'
                    });
                } else {
                    return jsonResponse(res, {
                        success: false,
                        action: 'streaming_start',
                        error: 'Not connected to server'
                    }, 400);
                }
            }
            break;

        case '/api/audio/stream/stop':
            if (method === 'POST') {
                if (streamState.status === 'streaming') {
                    streamState.status = 'connected';
                    streamState.statusMessage = 'Streaming stopped, still connected';
                    streamState.currentListeners = 0;
                    
                    console.log('⏹️ Stopped streaming');
                    
                    return jsonResponse(res, {
                        success: true,
                        action: 'streaming_stop',
                        status: 'connected'
                    });
                } else {
                    return jsonResponse(res, {
                        success: false,
                        action: 'streaming_stop',
                        error: 'Not currently streaming'
                    }, 400);
                }
            }
            break;

        case '/api/audio/stream/metadata':
            if (method === 'POST') {
                parseBody(req, (err, body) => {
                    if (err) {
                        return jsonResponse(res, { success: false, error: 'Invalid JSON' }, 400);
                    }
                    
                    streamState.currentTrack.artist = body.artist || 'Unknown Artist';
                    streamState.currentTrack.title = body.title || 'Unknown Track';
                    
                    console.log(`🎵 Metadata updated: ${streamState.currentTrack.artist} - ${streamState.currentTrack.title}`);
                    
                    return jsonResponse(res, {
                        success: true,
                        action: 'metadata_update',
                        artist: streamState.currentTrack.artist,
                        title: streamState.currentTrack.title
                    });
                });
                return;
            }
            break;

        case '/api/endpoints':
            if (method === 'GET') {
                return jsonResponse(res, {
                    success: true,
                    endpoints: [
                        'GET /api/health - Health check',
                        'GET /api/endpoints - This endpoint list',
                        'GET /api/audio/stream/status - Get stream status',
                        'POST /api/audio/stream/connect - Connect to stream server',
                        'POST /api/audio/stream/disconnect - Disconnect from stream server',
                        'POST /api/audio/stream/start - Start streaming',
                        'POST /api/audio/stream/stop - Stop streaming',
                        'POST /api/audio/stream/metadata - Update track metadata'
                    ],
                    documentation: 'Built-in Node.js HTTP server - no Express needed'
                });
            }
            break;

        default:
            return jsonResponse(res, {
                success: false,
                error: 'Endpoint not found',
                message: `${method} ${path} is not a valid endpoint`,
                availableEndpoints: '/api/endpoints'
            }, 404);
    }

    // Method not allowed
    jsonResponse(res, {
        success: false,
        error: `Method ${method} not allowed for ${path}`
    }, 405);
}

// Create and start server
const server = http.createServer(handleRequest);
const port = process.env.PORT || 8080;

server.listen(port, () => {
    console.log('🎵 OneStopRadio Mock Stream API Server');
    console.log('=====================================');
    console.log(`🚀 Server running on http://localhost:${port}`);
    console.log('📦 Built with Node.js built-in HTTP server (no Express needed)');
    console.log('');
    console.log('📡 Available endpoints:');
    console.log(`  GET  http://localhost:${port}/api/health`);
    console.log(`  GET  http://localhost:${port}/api/endpoints`);
    console.log(`  GET  http://localhost:${port}/api/audio/stream/status`);
    console.log(`  POST http://localhost:${port}/api/audio/stream/connect`);
    console.log(`  POST http://localhost:${port}/api/audio/stream/disconnect`);
    console.log(`  POST http://localhost:${port}/api/audio/stream/start`);
    console.log(`  POST http://localhost:${port}/api/audio/stream/stop`);
    console.log(`  POST http://localhost:${port}/api/audio/stream/metadata`);
    console.log('');
    console.log('✅ Ready for React AudioStreamEncoder connections!');
    console.log('🔄 Simulating realistic streaming behavior...');
    console.log('');
    console.log('Press Ctrl+C to stop server');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down OneStopRadio Mock API Server...');
    server.close(() => {
        console.log('✅ Server stopped gracefully');
        process.exit(0);
    });
});

// Error handling
server.on('error', (err) => {
    console.error('❌ Server error:', err);
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Try a different port:`);
        console.error(`PORT=8081 node simple-server.js`);
    }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
    process.exit(1);
});