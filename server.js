// Load environment variables from .env file
const fs = require('fs');
const path = require('path');

try {
    const envFile = path.join(__dirname, '.env');
    if (fs.existsSync(envFile)) {
        const envVars = fs.readFileSync(envFile, 'utf8');
        envVars.split('\n').forEach(line => {
            const [key, value] = line.split('=');
            if (key && value && !key.startsWith('#')) {
                process.env[key.trim()] = value.trim();
            }
        });
    }
} catch (err) {
    console.warn('Could not load .env file:', err.message);
}

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 5001;

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS configuration for frontend connections
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://127.0.0.1:3000', 
        'http://0.0.0.0:3000',
        'https://one-stop-radio-frontend-production.up.railway.app'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Real-time DJ session management
let djSessions = new Map(); // sessionId -> session data
let djConnections = new Map(); // sessionId -> Set of WebSocket connections

// DJ Session data structure
function createDJSession(sessionId, djId, sessionName) {
    return {
        id: sessionId,
        dj_id: djId,
        session_name: sessionName,
        started_at: new Date().toISOString(),
        is_live: false,
        is_recording: false,
        
        // Current tracks on decks
        deck_a: {
            track: null,
            playing: false,
            position: 0.0,
            volume: 0.8,
            eq: { low: 0.0, mid: 0.0, high: 0.0 },
            bpm: null,
            synced: false
        },
        deck_b: {
            track: null,
            playing: false,
            position: 0.0,
            volume: 0.8,
            eq: { low: 0.0, mid: 0.0, high: 0.0 },
            bpm: null,
            synced: false
        },
        
        // Mixer state
        mixer: {
            crossfader: 0.0,
            master_volume: 0.8,
            channel_a_volume: 0.8,
            channel_b_volume: 0.8,
            sync_enabled: false
        },
        
        // Real-time audio levels
        audio_levels: {
            master_left: 0.0,
            master_right: 0.0,
            channel_a_left: 0.0,
            channel_a_right: 0.0,
            channel_b_left: 0.0,
            channel_b_right: 0.0,
            updated_at: new Date().toISOString()
        },
        
        // Statistics
        stats: {
            current_listeners: 0,
            peak_listeners: 0,
            total_tracks_played: 0,
            session_duration: 0
        },
        
        updated_at: new Date().toISOString()
    };
}

// WebSocket connection manager for real-time DJ features
function broadcastToSession(sessionId, message) {
    const connections = djConnections.get(sessionId);
    if (connections) {
        const messageStr = JSON.stringify(message);
        connections.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(messageStr);
            }
        });
    }
}

function addConnectionToSession(sessionId, ws) {
    if (!djConnections.has(sessionId)) {
        djConnections.set(sessionId, new Set());
    }
    djConnections.get(sessionId).add(ws);
    
    console.log(`🎧 Client connected to DJ session ${sessionId}`);
}

function removeConnectionFromSession(sessionId, ws) {
    const connections = djConnections.get(sessionId);
    if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
            djConnections.delete(sessionId);
        }
    }
    
    console.log(`🎧 Client disconnected from DJ session ${sessionId}`);
}

// WebSocket server for real-time DJ communication
wss.on('connection', (ws, req) => {
    console.log('🔗 New WebSocket connection established');
    
    let sessionId = null;
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'join_session':
                    sessionId = message.session_id;
                    addConnectionToSession(sessionId, ws);
                    
                    // Send current session state
                    const session = djSessions.get(sessionId);
                    if (session) {
                        ws.send(JSON.stringify({
                            type: 'session_state',
                            data: session
                        }));
                    }
                    break;
                    
                case 'audio_levels':
                    if (sessionId) {
                        const session = djSessions.get(sessionId);
                        if (session) {
                            session.audio_levels = {
                                ...message.data,
                                updated_at: new Date().toISOString()
                            };
                            
                            // Broadcast audio levels to all connected clients
                            broadcastToSession(sessionId, {
                                type: 'audio_levels',
                                data: session.audio_levels
                            });
                        }
                    }
                    break;
                    
                case 'mixer_update':
                    if (sessionId) {
                        const session = djSessions.get(sessionId);
                        if (session) {
                            session.mixer = { ...session.mixer, ...message.data };
                            session.updated_at = new Date().toISOString();
                            
                            // Broadcast mixer update
                            broadcastToSession(sessionId, {
                                type: 'mixer_updated',
                                data: session.mixer
                            });
                        }
                    }
                    break;
                    
                case 'deck_update':
                    if (sessionId) {
                        const session = djSessions.get(sessionId);
                        if (session && message.deck) {
                            const deck = message.deck === 'A' ? 'deck_a' : 'deck_b';
                            session[deck] = { ...session[deck], ...message.data };
                            session.updated_at = new Date().toISOString();
                            
                            // Broadcast deck update
                            broadcastToSession(sessionId, {
                                type: 'deck_updated',
                                deck: message.deck,
                                data: session[deck]
                            });
                        }
                    }
                    break;
                    
                case 'heartbeat':
                    ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
                    break;
                    
                default:
                    console.log(`🔍 Unknown WebSocket message type: ${message.type}`);
            }
        } catch (error) {
            console.error('❌ WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        if (sessionId) {
            removeConnectionFromSession(sessionId, ws);
        }
        console.log('🔗 WebSocket connection closed');
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to OneStopRadio DJ WebSocket server'
    }));
});

// Audio system state for microphone and talkover
let audioSystemState = {
    microphone: {
        enabled: false,
        gain: 70.0,
        device_id: null,
        device_name: 'Default Microphone',
        sample_rate: 48000,
        channels: 1,
        latency: 0.0,
        peak_level: 0.0
    },
    talkover: {
        enabled: false,
        active: false,
        duck_level: 25.0,
        fade_time: 0.1,
        auto_enable: true,
        original_volume: null
    },
    master: {
        volume: 75.0,
        peak_left: 0.0,
        peak_right: 0.0
    },
    channels: {
        a: {
            playing: false,
            volume: 75.0,
            peak_left: 0.0,
            peak_right: 0.0
        },
        b: {
            playing: false,
            volume: 75.0,
            peak_left: 0.0,
            peak_right: 0.0
        }
    },
    backend_type: 'web_audio' // 'cpp_media_server' or 'web_audio'
};

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

// Simulate audio system statistics updates
function updateAudioStats() {
    // Simulate microphone levels if enabled
    if (audioSystemState.microphone.enabled) {
        audioSystemState.microphone.peak_level = Math.random() * 0.8 + 0.1; // 0.1-0.9
    } else {
        audioSystemState.microphone.peak_level = 0.0;
    }
    
    // Simulate channel levels if playing
    if (audioSystemState.channels.a.playing) {
        audioSystemState.channels.a.peak_left = Math.random() * 0.7 + 0.2; // 0.2-0.9
        audioSystemState.channels.a.peak_right = Math.random() * 0.7 + 0.2;
    } else {
        audioSystemState.channels.a.peak_left = 0.0;
        audioSystemState.channels.a.peak_right = 0.0;
    }
    
    if (audioSystemState.channels.b.playing) {
        audioSystemState.channels.b.peak_left = Math.random() * 0.7 + 0.2; // 0.2-0.9
        audioSystemState.channels.b.peak_right = Math.random() * 0.7 + 0.2;
    } else {
        audioSystemState.channels.b.peak_left = 0.0;
        audioSystemState.channels.b.peak_right = 0.0;
    }
    
    // Calculate master levels based on active channels and microphone
    let masterLeft = Math.max(
        audioSystemState.channels.a.peak_left * (audioSystemState.channels.a.volume / 100),
        audioSystemState.channels.b.peak_left * (audioSystemState.channels.b.volume / 100)
    );
    let masterRight = Math.max(
        audioSystemState.channels.a.peak_right * (audioSystemState.channels.a.volume / 100),
        audioSystemState.channels.b.peak_right * (audioSystemState.channels.b.volume / 100)
    );
    
    // Add microphone to master if enabled
    if (audioSystemState.microphone.enabled) {
        const micLevel = audioSystemState.microphone.peak_level * (audioSystemState.microphone.gain / 100);
        masterLeft = Math.max(masterLeft, micLevel);
        masterRight = Math.max(masterRight, micLevel);
    }
    
    // Apply talkover ducking if active
    if (audioSystemState.talkover.active) {
        const duckFactor = audioSystemState.talkover.duck_level / 100;
        masterLeft *= duckFactor;
        masterRight *= duckFactor;
    }
    
    audioSystemState.master.peak_left = masterLeft;
    audioSystemState.master.peak_right = masterRight;
}

// Start stats update intervals
setInterval(updateStreamStats, 2000);
setInterval(updateAudioStats, 100); // More frequent for audio levels

// Request logging middleware
app.use((req, res, next) => {
    console.log(`📡 ${req.method} ${req.path}`);
    next();
});

// Routes

// Get stream status
app.get('/api/audio/stream/status', (req, res) => {
    res.json({
        success: true,
        stats: streamState
    });
});

// Connect to stream server
app.post('/api/audio/stream/connect', (req, res) => {
    const config = req.body;
    
    // Validate required fields
    if (!config.serverHost || !config.serverPort || !config.password) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: serverHost, serverPort, password'
        });
    }
    
    // Store configuration
    streamState.config = config;
    streamState.status = 'connected';
    streamState.statusMessage = `Connected to ${config.serverHost}:${config.serverPort}`;
    streamState.startTime = Date.now();
    streamState.connectedTime = 0;
    streamState.bytesSent = 0;
    
    console.log(`✅ Connected to ${config.protocol} server: ${config.serverHost}:${config.serverPort}`);
    console.log(`🎵 Mount: ${config.mountPoint}, Codec: ${config.codec}, Bitrate: ${config.bitrate}kbps`);
    
    res.json({
        success: true,
        action: 'stream_connect',
        status: 'connected'
    });
});

// Disconnect from stream server
app.post('/api/audio/stream/disconnect', (req, res) => {
    streamState.status = 'disconnected';
    streamState.statusMessage = 'Disconnected';
    streamState.currentListeners = 0;
    streamState.bytesSent = 0;
    streamState.startTime = null;
    streamState.config = null;
    
    console.log('🔌 Disconnected from stream server');
    
    res.json({
        success: true,
        action: 'stream_disconnect',
        status: 'disconnected'
    });
});

// Start streaming
app.post('/api/audio/stream/start', (req, res) => {
    if (streamState.status === 'connected') {
        streamState.status = 'streaming';
        streamState.statusMessage = 'Streaming live';
        streamState.currentListeners = Math.floor(Math.random() * 20) + 5; // 5-25 initial listeners
        
        console.log('🔴 Started live streaming!');
        console.log(`📊 Initial listeners: ${streamState.currentListeners}`);
        
        res.json({
            success: true,
            action: 'streaming_start',
            status: 'streaming'
        });
    } else {
        res.status(400).json({
            success: false,
            action: 'streaming_start',
            error: 'Not connected to server'
        });
    }
});

// Stop streaming
app.post('/api/audio/stream/stop', (req, res) => {
    if (streamState.status === 'streaming') {
        streamState.status = 'connected';
        streamState.statusMessage = 'Streaming stopped, still connected';
        streamState.currentListeners = 0;
        
        console.log('⏹️ Stopped streaming');
        
        res.json({
            success: true,
            action: 'streaming_stop',
            status: 'connected'
        });
    } else {
        res.status(400).json({
            success: false,
            action: 'streaming_stop',
            error: 'Not currently streaming'
        });
    }
});

// Update metadata
app.post('/api/audio/stream/metadata', (req, res) => {
    const { artist, title } = req.body;
    
    streamState.currentTrack.artist = artist || 'Unknown Artist';
    streamState.currentTrack.title = title || 'Unknown Track';
    
    console.log(`🎵 Metadata updated: ${streamState.currentTrack.artist} - ${streamState.currentTrack.title}`);
    
    res.json({
        success: true,
        action: 'metadata_update',
        artist: streamState.currentTrack.artist,
        title: streamState.currentTrack.title
    });
});

// Audio System Endpoints
// ======================

// Get complete audio system status
app.get('/api/audio/system/status', (req, res) => {
    console.log('🎛️ Audio system status requested');
    
    res.json({
        success: true,
        audio_system: {
            microphone: audioSystemState.microphone,
            talkover: audioSystemState.talkover,
            master: audioSystemState.master,
            channels: audioSystemState.channels,
            backend_type: audioSystemState.backend_type,
            timestamp: new Date().toISOString()
        }
    });
});

// Microphone control endpoints
app.post('/api/audio/microphone/start', (req, res) => {
    const { gain = 70.0, device_id = null } = req.body;
    
    audioSystemState.microphone.enabled = true;
    audioSystemState.microphone.gain = Math.max(0, Math.min(100, gain));
    audioSystemState.microphone.device_id = device_id;
    
    // Auto-enable talkover if configured
    if (audioSystemState.talkover.auto_enable) {
        audioSystemState.talkover.enabled = true;
        audioSystemState.talkover.active = true;
        audioSystemState.talkover.original_volume = audioSystemState.master.volume;
        
        console.log('🎤 Microphone started - Auto-enabling talkover');
    }
    
    console.log(`🎤 Microphone started: Gain ${audioSystemState.microphone.gain}%`);
    
    res.json({
        success: true,
        action: 'microphone_start',
        microphone: audioSystemState.microphone,
        talkover_auto_enabled: audioSystemState.talkover.auto_enable
    });
});

app.post('/api/audio/microphone/stop', (req, res) => {
    audioSystemState.microphone.enabled = false;
    audioSystemState.microphone.peak_level = 0.0;
    
    // Disable talkover when microphone stops
    if (audioSystemState.talkover.enabled) {
        audioSystemState.talkover.enabled = false;
        audioSystemState.talkover.active = false;
        
        // Restore original volume if saved
        if (audioSystemState.talkover.original_volume !== null) {
            audioSystemState.master.volume = audioSystemState.talkover.original_volume;
            audioSystemState.talkover.original_volume = null;
        }
        
        console.log('🎤 Microphone stopped - Disabling talkover and restoring volume');
    }
    
    console.log('🎤 Microphone stopped');
    
    res.json({
        success: true,
        action: 'microphone_stop',
        microphone: audioSystemState.microphone,
        talkover_disabled: true
    });
});

app.post('/api/audio/microphone/gain', (req, res) => {
    const { gain } = req.body;
    
    if (typeof gain !== 'number' || gain < 0 || gain > 100) {
        return res.status(400).json({
            success: false,
            error: 'Gain must be a number between 0 and 100'
        });
    }
    
    audioSystemState.microphone.gain = gain;
    
    console.log(`🎤 Microphone gain set to ${gain}%`);
    
    res.json({
        success: true,
        action: 'microphone_gain_set',
        gain: audioSystemState.microphone.gain
    });
});

// Talkover control endpoints
app.post('/api/audio/talkover/enable', (req, res) => {
    const { duck_level = 25.0, fade_time = 0.1 } = req.body;
    
    if (!audioSystemState.microphone.enabled) {
        return res.status(400).json({
            success: false,
            error: 'Cannot enable talkover - microphone is not enabled',
            action: 'talkover_enable_failed'
        });
    }
    
    // Store original volume before ducking
    if (audioSystemState.talkover.original_volume === null) {
        audioSystemState.talkover.original_volume = audioSystemState.master.volume;
    }
    
    audioSystemState.talkover.enabled = true;
    audioSystemState.talkover.active = true;
    audioSystemState.talkover.duck_level = Math.max(0, Math.min(100, duck_level));
    audioSystemState.talkover.fade_time = Math.max(0.0, fade_time);
    
    console.log(`🎤 Talkover enabled - Ducking to ${audioSystemState.talkover.duck_level}%`);
    
    res.json({
        success: true,
        action: 'talkover_enabled',
        talkover: audioSystemState.talkover
    });
});

app.post('/api/audio/talkover/disable', (req, res) => {
    audioSystemState.talkover.enabled = false;
    audioSystemState.talkover.active = false;
    
    // Restore original volume if saved
    if (audioSystemState.talkover.original_volume !== null) {
        audioSystemState.master.volume = audioSystemState.talkover.original_volume;
        audioSystemState.talkover.original_volume = null;
        console.log(`🎤 Talkover disabled - Volume restored to ${audioSystemState.master.volume}%`);
    } else {
        console.log('🎤 Talkover disabled');
    }
    
    res.json({
        success: true,
        action: 'talkover_disabled',
        talkover: audioSystemState.talkover,
        master_volume: audioSystemState.master.volume
    });
});

// Channel control endpoints (for mixer integration)
app.post('/api/audio/channel/:channel/play', (req, res) => {
    const { channel } = req.params;
    
    if (!['a', 'b'].includes(channel)) {
        return res.status(400).json({
            success: false,
            error: 'Channel must be "a" or "b"'
        });
    }
    
    audioSystemState.channels[channel].playing = true;
    
    console.log(`▶️ Channel ${channel.toUpperCase()} started playing`);
    
    res.json({
        success: true,
        action: `channel_${channel}_play`,
        channel: audioSystemState.channels[channel]
    });
});

app.post('/api/audio/channel/:channel/stop', (req, res) => {
    const { channel } = req.params;
    
    if (!['a', 'b'].includes(channel)) {
        return res.status(400).json({
            success: false,
            error: 'Channel must be "a" or "b"'
        });
    }
    
    audioSystemState.channels[channel].playing = false;
    audioSystemState.channels[channel].peak_left = 0.0;
    audioSystemState.channels[channel].peak_right = 0.0;
    
    console.log(`⏹️ Channel ${channel.toUpperCase()} stopped`);
    
    res.json({
        success: true,
        action: `channel_${channel}_stop`,
        channel: audioSystemState.channels[channel]
    });
});

app.post('/api/audio/channel/:channel/volume', (req, res) => {
    const { channel } = req.params;
    const { volume } = req.body;
    
    if (!['a', 'b'].includes(channel)) {
        return res.status(400).json({
            success: false,
            error: 'Channel must be "a" or "b"'
        });
    }
    
    if (typeof volume !== 'number' || volume < 0 || volume > 100) {
        return res.status(400).json({
            success: false,
            error: 'Volume must be a number between 0 and 100'
        });
    }
    
    audioSystemState.channels[channel].volume = volume;
    
    console.log(`🔊 Channel ${channel.toUpperCase()} volume set to ${volume}%`);
    
    res.json({
        success: true,
        action: `channel_${channel}_volume_set`,
        channel: audioSystemState.channels[channel]
    });
});

// Master volume control
app.post('/api/audio/master/volume', (req, res) => {
    const { volume } = req.body;
    
    if (typeof volume !== 'number' || volume < 0 || volume > 100) {
        return res.status(400).json({
            success: false,
            error: 'Volume must be a number between 0 and 100'
        });
    }
    
    audioSystemState.master.volume = volume;
    
    // Update original volume for talkover if not currently ducking
    if (!audioSystemState.talkover.active) {
        audioSystemState.talkover.original_volume = volume;
    }
    
    console.log(`🔊 Master volume set to ${volume}%`);
    
    res.json({
        success: true,
        action: 'master_volume_set',
        master: audioSystemState.master
    });
});

// Audio levels endpoint (for real-time monitoring)
app.get('/api/audio/levels', (req, res) => {
    res.json({
        success: true,
        levels: {
            microphone: audioSystemState.microphone.peak_level * 100, // Convert to percentage
            master_left: audioSystemState.master.peak_left * 100,
            master_right: audioSystemState.master.peak_right * 100,
            channel_a_left: audioSystemState.channels.a.peak_left * 100,
            channel_a_right: audioSystemState.channels.a.peak_right * 100,
            channel_b_left: audioSystemState.channels.b.peak_left * 100,
            channel_b_right: audioSystemState.channels.b.peak_right * 100,
            timestamp: new Date().toISOString()
        }
    });
});

// Real-time DJ Session Management Endpoints
// ==========================================

// Create new DJ session
app.post('/api/dj/sessions', (req, res) => {
    const { session_name, dj_id = 'demo-dj', station_id = 'demo-station' } = req.body;
    
    if (!session_name) {
        return res.status(400).json({
            success: false,
            error: 'session_name is required'
        });
    }
    
    const sessionId = `dj_session_${Date.now()}`;
    const session = createDJSession(sessionId, dj_id, session_name);
    
    djSessions.set(sessionId, session);
    
    console.log(`🎧 Created DJ session: ${session_name} (${sessionId})`);
    
    res.json({
        success: true,
        action: 'session_created',
        session: session
    });
});

// Get DJ session by ID
app.get('/api/dj/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = djSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    res.json({
        success: true,
        session: session
    });
});

// Update DJ session settings
app.patch('/api/dj/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = djSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    // Update session properties
    Object.keys(req.body).forEach(key => {
        if (key in session) {
            session[key] = req.body[key];
        }
    });
    
    session.updated_at = new Date().toISOString();
    
    // Broadcast session update
    broadcastToSession(sessionId, {
        type: 'session_updated',
        data: session
    });
    
    console.log(`🎧 Updated DJ session ${sessionId}`);
    
    res.json({
        success: true,
        action: 'session_updated',
        session: session
    });
});

// End DJ session
app.delete('/api/dj/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = djSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    session.ended_at = new Date().toISOString();
    session.is_live = false;
    
    // Broadcast session ended
    broadcastToSession(sessionId, {
        type: 'session_ended',
        data: { session_id: sessionId, ended_at: session.ended_at }
    });
    
    // Clean up connections
    djConnections.delete(sessionId);
    djSessions.delete(sessionId);
    
    console.log(`🎧 Ended DJ session ${sessionId}`);
    
    res.json({
        success: true,
        action: 'session_ended',
        session_id: sessionId
    });
});

// Load track to deck
app.post('/api/dj/sessions/:sessionId/tracks/:deck', (req, res) => {
    const { sessionId, deck } = req.params;
    const { track_id, track_title, track_artist, track_duration, bpm } = req.body;
    
    if (!['A', 'B'].includes(deck)) {
        return res.status(400).json({
            success: false,
            error: 'Deck must be "A" or "B"'
        });
    }
    
    const session = djSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    const deckKey = deck === 'A' ? 'deck_a' : 'deck_b';
    
    // Stop current track if playing
    if (session[deckKey].playing) {
        session[deckKey].playing = false;
    }
    
    // Load new track
    session[deckKey].track = {
        id: track_id || `track_${Date.now()}`,
        title: track_title || 'Unknown Track',
        artist: track_artist || 'Unknown Artist',
        duration: track_duration || 0,
        loaded_at: new Date().toISOString()
    };
    
    session[deckKey].position = 0.0;
    session[deckKey].bpm = bpm || null;
    session.updated_at = new Date().toISOString();
    
    // Broadcast track loaded
    broadcastToSession(sessionId, {
        type: 'track_loaded',
        deck: deck,
        data: session[deckKey]
    });
    
    console.log(`🎵 Loaded "${track_title}" to deck ${deck} in session ${sessionId}`);
    
    res.json({
        success: true,
        action: 'track_loaded',
        deck: deck,
        track_data: session[deckKey]
    });
});

// Playback control (play, pause, cue, etc.)
app.post('/api/dj/sessions/:sessionId/playback/:deck', (req, res) => {
    const { sessionId, deck } = req.params;
    const { action, position, speed } = req.body;
    
    if (!['A', 'B'].includes(deck)) {
        return res.status(400).json({
            success: false,
            error: 'Deck must be "A" or "B"'
        });
    }
    
    const validActions = ['play', 'pause', 'stop', 'cue', 'sync'];
    if (!validActions.includes(action)) {
        return res.status(400).json({
            success: false,
            error: `Action must be one of: ${validActions.join(', ')}`
        });
    }
    
    const session = djSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    const deckKey = deck === 'A' ? 'deck_a' : 'deck_b';
    
    if (!session[deckKey].track) {
        return res.status(400).json({
            success: false,
            error: 'No track loaded on this deck'
        });
    }
    
    // Apply playback action
    switch (action) {
        case 'play':
            session[deckKey].playing = true;
            if (speed) session[deckKey].speed = speed;
            break;
        case 'pause':
            session[deckKey].playing = false;
            break;
        case 'stop':
            session[deckKey].playing = false;
            session[deckKey].position = 0.0;
            break;
        case 'cue':
            session[deckKey].playing = false;
            if (position !== undefined) session[deckKey].position = position;
            break;
        case 'sync':
            session[deckKey].synced = !session[deckKey].synced;
            break;
    }
    
    session.updated_at = new Date().toISOString();
    
    // Broadcast playback control
    broadcastToSession(sessionId, {
        type: 'playback_control',
        deck: deck,
        action: action,
        data: session[deckKey]
    });
    
    console.log(`🎵 ${action.toUpperCase()} on deck ${deck} in session ${sessionId}`);
    
    res.json({
        success: true,
        action: `playback_${action}`,
        deck: deck,
        deck_state: session[deckKey]
    });
});

// Mixer controls
app.post('/api/dj/sessions/:sessionId/mixer', (req, res) => {
    const { sessionId } = req.params;
    const session = djSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    // Update mixer controls
    Object.keys(req.body).forEach(key => {
        if (key in session.mixer) {
            session.mixer[key] = req.body[key];
        }
    });
    
    session.updated_at = new Date().toISOString();
    
    // Broadcast mixer update
    broadcastToSession(sessionId, {
        type: 'mixer_updated',
        data: session.mixer
    });
    
    console.log(`🎛️ Mixer updated in session ${sessionId}`);
    
    res.json({
        success: true,
        action: 'mixer_updated',
        mixer_state: session.mixer
    });
});

// Get current mixer state
app.get('/api/dj/sessions/:sessionId/mixer', (req, res) => {
    const { sessionId } = req.params;
    const session = djSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    res.json({
        success: true,
        mixer_state: session.mixer
    });
});

// Real-time statistics
app.get('/api/dj/sessions/:sessionId/stats', (req, res) => {
    const { sessionId } = req.params;
    const session = djSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    // Calculate uptime
    const startTime = new Date(session.started_at);
    const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
    
    const stats = {
        session_id: sessionId,
        current_time: new Date().toISOString(),
        is_live: session.is_live,
        uptime_seconds: uptime,
        deck_a_track: session.deck_a.track,
        deck_b_track: session.deck_b.track,
        mixer_state: session.mixer,
        audio_levels: session.audio_levels,
        performance: {
            current_listeners: session.stats.current_listeners,
            peak_listeners: session.stats.peak_listeners,
            total_tracks_played: session.stats.total_tracks_played
        }
    };
    
    res.json({
        success: true,
        stats: stats
    });
});

// Update audio levels (real-time from audio engine)
app.post('/api/dj/sessions/:sessionId/audio-levels', (req, res) => {
    const { sessionId } = req.params;
    const session = djSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    session.audio_levels = {
        ...req.body,
        updated_at: new Date().toISOString()
    };
    
    // Broadcast audio levels
    broadcastToSession(sessionId, {
        type: 'audio_levels',
        data: session.audio_levels
    });
    
    res.json({
        success: true,
        action: 'audio_levels_updated'
    });
});

// List all active DJ sessions
app.get('/api/dj/sessions', (req, res) => {
    const sessions = Array.from(djSessions.values());
    
    res.json({
        success: true,
        sessions: sessions,
        total_sessions: sessions.length,
        active_sessions: sessions.filter(s => s.is_live).length
    });
});

// BPM detection and beat matching
app.post('/api/dj/sessions/:sessionId/bpm/:deck', (req, res) => {
    const { sessionId, deck } = req.params;
    const { bpm, sync_enabled, beat_position } = req.body;
    
    if (!['A', 'B'].includes(deck)) {
        return res.status(400).json({
            success: false,
            error: 'Deck must be "A" or "B"'
        });
    }
    
    const session = djSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'DJ session not found'
        });
    }
    
    const deckKey = deck === 'A' ? 'deck_a' : 'deck_b';
    
    if (bpm) session[deckKey].bpm = bpm;
    if (sync_enabled !== undefined) session[deckKey].synced = sync_enabled;
    if (beat_position !== undefined) session[deckKey].beat_position = beat_position;
    
    session.updated_at = new Date().toISOString();
    
    // Broadcast BPM update
    broadcastToSession(sessionId, {
        type: 'bpm_updated',
        deck: deck,
        data: {
            bpm: session[deckKey].bpm,
            synced: session[deckKey].synced,
            beat_position: session[deckKey].beat_position
        }
    });
    
    console.log(`🎵 BPM updated for deck ${deck}: ${bpm} BPM`);
    
    res.json({
        success: true,
        action: 'bpm_updated',
        deck: deck,
        bpm_data: {
            bpm: session[deckKey].bpm,
            synced: session[deckKey].synced,
            beat_position: session[deckKey].beat_position
        }
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        service: 'OneStopRadio Mock Stream API',
        version: '1.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Video Streaming State Management
let videoState = {
    source: 'off', // 'camera', 'image', 'slideshow', 'off'
    camera: {
        enabled: false,
        device_id: null,
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        status: 'idle'
    },
    image: {
        current_path: null,
        uploaded_images: []
    },
    slideshow: {
        active: false,
        images: [],
        current_slide: 0,
        duration: 5,
        loop: true,
        transition: 'fade'
    },
    streaming: {
        platforms: {},
        custom_rtmp: {},
        is_live: false,
        start_time: null
    },
    overlay: {
        text: '',
        x: 50,
        y: 50,
        font: 'Arial',
        font_size: 24,
        visible: false
    },
    stats: {
        total_frames: 0,
        encoded_frames: 0,
        dropped_frames: 0,
        current_bitrate: 0,
        total_bytes: 0
    }
};

// Video streaming endpoints
// ========================

// Get video streaming status
app.get('/api/video/status', (req, res) => {
    console.log('📹 Video status requested');
    
    res.json({
        success: true,
        video_source: videoState.source,
        camera: videoState.camera,
        image: videoState.image,
        slideshow: videoState.slideshow,
        streaming: {
            is_live: videoState.streaming.is_live,
            platforms: Object.keys(videoState.streaming.platforms).filter(p => 
                videoState.streaming.platforms[p].streaming
            ),
            custom_rtmp: Object.keys(videoState.streaming.custom_rtmp).filter(p => 
                videoState.streaming.custom_rtmp[p].streaming
            ),
            uptime: videoState.streaming.start_time ? 
                Math.floor((Date.now() - videoState.streaming.start_time) / 1000) : 0
        },
        overlay: videoState.overlay,
        stats: {
            ...videoState.stats,
            uptime_seconds: videoState.streaming.start_time ? 
                Math.floor((Date.now() - videoState.streaming.start_time) / 1000) : 0
        }
    });
});

// Camera controls
app.post('/api/video/camera/on', (req, res) => {
    console.log('📷 Camera enabled');
    
    videoState.source = 'camera';
    videoState.camera.enabled = true;
    videoState.camera.status = 'active';
    
    res.json({
        success: true,
        action: 'camera_enabled',
        video_source: videoState.source,
        camera_status: videoState.camera.status
    });
});

app.post('/api/video/camera/off', (req, res) => {
    console.log('📷 Camera disabled');
    
    videoState.camera.enabled = false;
    videoState.camera.status = 'idle';
    if (videoState.source === 'camera') {
        videoState.source = 'off';
    }
    
    res.json({
        success: true,
        action: 'camera_disabled',
        video_source: videoState.source,
        camera_status: videoState.camera.status
    });
});

// Camera settings
app.post('/api/video/camera/settings', (req, res) => {
    const { device_id, width, height, fps } = req.body;
    
    if (device_id) videoState.camera.device_id = device_id;
    if (width && height) {
        videoState.camera.resolution.width = width;
        videoState.camera.resolution.height = height;
    }
    if (fps) videoState.camera.fps = fps;
    
    console.log(`📷 Camera settings updated: ${width}x${height}@${fps}fps, device: ${device_id}`);
    
    res.json({
        success: true,
        action: 'camera_settings_updated',
        settings: videoState.camera
    });
});

// Static image controls
app.post('/api/video/image', (req, res) => {
    const { image_path } = req.body;
    
    if (!image_path) {
        return res.status(400).json({
            success: false,
            error: 'image_path is required'
        });
    }
    
    videoState.source = 'image';
    videoState.image.current_path = image_path;
    
    console.log(`🖼️ Static image set: ${image_path}`);
    
    res.json({
        success: true,
        action: 'image_set',
        video_source: videoState.source,
        image_path: image_path
    });
});

// Slideshow controls
app.post('/api/video/slideshow/start', (req, res) => {
    const { images, duration, loop, transition } = req.body;
    
    if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'images array is required and must not be empty'
        });
    }
    
    videoState.source = 'slideshow';
    videoState.slideshow.active = true;
    videoState.slideshow.images = images;
    videoState.slideshow.current_slide = 0;
    videoState.slideshow.duration = duration || 5;
    videoState.slideshow.loop = loop !== false;
    videoState.slideshow.transition = transition || 'fade';
    
    console.log(`🎞️ Slideshow started: ${images.length} images, ${duration}s each`);
    
    res.json({
        success: true,
        action: 'slideshow_started',
        video_source: videoState.source,
        slideshow_config: videoState.slideshow
    });
});

app.post('/api/video/slideshow/stop', (req, res) => {
    console.log('🎞️ Slideshow stopped');
    
    videoState.slideshow.active = false;
    if (videoState.source === 'slideshow') {
        videoState.source = 'off';
    }
    
    res.json({
        success: true,
        action: 'slideshow_stopped',
        video_source: videoState.source
    });
});

app.post('/api/video/slideshow/next', (req, res) => {
    if (!videoState.slideshow.active) {
        return res.status(400).json({
            success: false,
            error: 'Slideshow is not active'
        });
    }
    
    videoState.slideshow.current_slide++;
    if (videoState.slideshow.current_slide >= videoState.slideshow.images.length) {
        if (videoState.slideshow.loop) {
            videoState.slideshow.current_slide = 0;
        } else {
            videoState.slideshow.current_slide = videoState.slideshow.images.length - 1;
        }
    }
    
    console.log(`🎞️ Next slide: ${videoState.slideshow.current_slide}`);
    
    res.json({
        success: true,
        action: 'next_slide',
        current_slide: videoState.slideshow.current_slide,
        total_slides: videoState.slideshow.images.length
    });
});

app.post('/api/video/slideshow/previous', (req, res) => {
    if (!videoState.slideshow.active) {
        return res.status(400).json({
            success: false,
            error: 'Slideshow is not active'
        });
    }
    
    videoState.slideshow.current_slide--;
    if (videoState.slideshow.current_slide < 0) {
        if (videoState.slideshow.loop) {
            videoState.slideshow.current_slide = videoState.slideshow.images.length - 1;
        } else {
            videoState.slideshow.current_slide = 0;
        }
    }
    
    console.log(`🎞️ Previous slide: ${videoState.slideshow.current_slide}`);
    
    res.json({
        success: true,
        action: 'previous_slide',
        current_slide: videoState.slideshow.current_slide,
        total_slides: videoState.slideshow.images.length
    });
});

// Social media streaming
app.post('/api/video/stream/:platform', (req, res) => {
    const { platform } = req.params;
    const { stream_key, title, description, rtmp_url } = req.body;
    
    if (!stream_key) {
        return res.status(400).json({
            success: false,
            error: 'stream_key is required'
        });
    }
    
    // Configure platform
    videoState.streaming.platforms[platform] = {
        configured: true,
        streaming: false,
        stream_key: stream_key,
        title: title || `OneStopRadio Live on ${platform}`,
        description: description || '',
        rtmp_url: rtmp_url || getPlatformRtmpUrl(platform),
        stats: {
            start_time: null,
            bytes_sent: 0,
            frames_sent: 0,
            current_bitrate: 0,
            viewers: 0
        }
    };
    
    console.log(`📡 Platform configured: ${platform}`);
    
    res.json({
        success: true,
        action: 'platform_configured',
        platform: platform,
        configuration: videoState.streaming.platforms[platform]
    });
});

// Custom RTMP streaming
app.post('/api/video/rtmp/add', (req, res) => {
    const { name, rtmp_url, stream_key } = req.body;
    
    if (!name || !rtmp_url || !stream_key) {
        return res.status(400).json({
            success: false,
            error: 'name, rtmp_url, and stream_key are required'
        });
    }
    
    const rtmp_id = `rtmp_${Date.now()}`;
    
    videoState.streaming.custom_rtmp[rtmp_id] = {
        name: name,
        rtmp_url: rtmp_url,
        stream_key: stream_key,
        configured: true,
        streaming: false,
        stats: {
            start_time: null,
            bytes_sent: 0,
            frames_sent: 0,
            current_bitrate: 0
        }
    };
    
    console.log(`🔗 Custom RTMP added: ${name} -> ${rtmp_url}`);
    
    res.json({
        success: true,
        action: 'rtmp_added',
        rtmp_id: rtmp_id,
        configuration: videoState.streaming.custom_rtmp[rtmp_id]
    });
});

app.delete('/api/video/rtmp/:rtmp_id', (req, res) => {
    const { rtmp_id } = req.params;
    
    if (!videoState.streaming.custom_rtmp[rtmp_id]) {
        return res.status(404).json({
            success: false,
            error: 'RTMP stream not found'
        });
    }
    
    delete videoState.streaming.custom_rtmp[rtmp_id];
    
    console.log(`🔗 Custom RTMP removed: ${rtmp_id}`);
    
    res.json({
        success: true,
        action: 'rtmp_removed',
        rtmp_id: rtmp_id
    });
});

// Start streaming
app.post('/api/video/stream/start', (req, res) => {
    const { platforms = [], rtmp_streams = [] } = req.body;
    
    if (platforms.length === 0 && rtmp_streams.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'At least one platform or RTMP stream must be specified'
        });
    }
    
    let started_platforms = [];
    let started_rtmp = [];
    
    // Start platform streaming
    platforms.forEach(platform => {
        if (videoState.streaming.platforms[platform] && videoState.streaming.platforms[platform].configured) {
            videoState.streaming.platforms[platform].streaming = true;
            videoState.streaming.platforms[platform].stats.start_time = Date.now();
            started_platforms.push(platform);
        }
    });
    
    // Start custom RTMP streaming
    rtmp_streams.forEach(rtmp_id => {
        if (videoState.streaming.custom_rtmp[rtmp_id] && videoState.streaming.custom_rtmp[rtmp_id].configured) {
            videoState.streaming.custom_rtmp[rtmp_id].streaming = true;
            videoState.streaming.custom_rtmp[rtmp_id].stats.start_time = Date.now();
            started_rtmp.push(rtmp_id);
        }
    });
    
    if (started_platforms.length > 0 || started_rtmp.length > 0) {
        videoState.streaming.is_live = true;
        videoState.streaming.start_time = Date.now();
        
        console.log(`🔴 Live streaming started: ${started_platforms.join(', ')} ${started_rtmp.length > 0 ? `+ ${started_rtmp.length} RTMP` : ''}`);
    }
    
    res.json({
        success: true,
        action: 'streaming_started',
        is_live: videoState.streaming.is_live,
        started_platforms: started_platforms,
        started_rtmp: started_rtmp,
        total_streams: started_platforms.length + started_rtmp.length
    });
});

// Stop streaming
app.post('/api/video/stream/stop', (req, res) => {
    const { platforms = [], rtmp_streams = [] } = req.body;
    
    if (platforms.length === 0 && rtmp_streams.length === 0) {
        // Stop all streaming
        Object.keys(videoState.streaming.platforms).forEach(platform => {
            videoState.streaming.platforms[platform].streaming = false;
        });
        
        Object.keys(videoState.streaming.custom_rtmp).forEach(rtmp_id => {
            videoState.streaming.custom_rtmp[rtmp_id].streaming = false;
        });
        
        videoState.streaming.is_live = false;
        
        console.log('🔴 All streaming stopped');
        
        res.json({
            success: true,
            action: 'all_streaming_stopped',
            is_live: videoState.streaming.is_live
        });
    } else {
        // Stop specific platforms/streams
        let stopped_platforms = [];
        let stopped_rtmp = [];
        
        platforms.forEach(platform => {
            if (videoState.streaming.platforms[platform]) {
                videoState.streaming.platforms[platform].streaming = false;
                stopped_platforms.push(platform);
            }
        });
        
        rtmp_streams.forEach(rtmp_id => {
            if (videoState.streaming.custom_rtmp[rtmp_id]) {
                videoState.streaming.custom_rtmp[rtmp_id].streaming = false;
                stopped_rtmp.push(rtmp_id);
            }
        });
        
        // Check if any streams are still active
        const active_platforms = Object.keys(videoState.streaming.platforms).some(p => 
            videoState.streaming.platforms[p].streaming
        );
        const active_rtmp = Object.keys(videoState.streaming.custom_rtmp).some(r => 
            videoState.streaming.custom_rtmp[r].streaming
        );
        
        if (!active_platforms && !active_rtmp) {
            videoState.streaming.is_live = false;
        }
        
        console.log(`🔴 Streaming stopped: ${stopped_platforms.join(', ')} ${stopped_rtmp.length > 0 ? `+ ${stopped_rtmp.length} RTMP` : ''}`);
        
        res.json({
            success: true,
            action: 'streaming_stopped',
            is_live: videoState.streaming.is_live,
            stopped_platforms: stopped_platforms,
            stopped_rtmp: stopped_rtmp
        });
    }
});

// Text overlay controls
app.post('/api/video/overlay/text', (req, res) => {
    const { text, x, y, font, font_size } = req.body;
    
    if (!text) {
        return res.status(400).json({
            success: false,
            error: 'text is required'
        });
    }
    
    videoState.overlay.text = text;
    videoState.overlay.x = x || 50;
    videoState.overlay.y = y || 50;
    videoState.overlay.font = font || 'Arial';
    videoState.overlay.font_size = font_size || 24;
    videoState.overlay.visible = true;
    
    console.log(`📝 Text overlay added: "${text}" at (${videoState.overlay.x}, ${videoState.overlay.y})`);
    
    res.json({
        success: true,
        action: 'overlay_added',
        overlay: videoState.overlay
    });
});

app.post('/api/video/overlay/clear', (req, res) => {
    console.log('📝 Text overlay cleared');
    
    videoState.overlay.text = '';
    videoState.overlay.visible = false;
    
    res.json({
        success: true,
        action: 'overlay_cleared',
        overlay: videoState.overlay
    });
});

// Video streaming statistics (with real-time simulation)
app.get('/api/video/stats', (req, res) => {
    // Simulate real-time statistics if streaming is active
    if (videoState.streaming.is_live) {
        const uptime = (Date.now() - videoState.streaming.start_time) / 1000;
        
        // Simulate realistic streaming stats
        videoState.stats.total_frames += Math.floor(Math.random() * 5) + 28; // ~30 FPS
        videoState.stats.encoded_frames = videoState.stats.total_frames - Math.floor(Math.random() * 3);
        videoState.stats.dropped_frames = videoState.stats.total_frames - videoState.stats.encoded_frames;
        videoState.stats.current_bitrate = 2400000 + (Math.random() - 0.5) * 200000; // ~2.5 Mbps ±100k
        videoState.stats.total_bytes += videoState.stats.current_bitrate / 8; // Convert bits to bytes per second
        
        // Update platform stats
        Object.keys(videoState.streaming.platforms).forEach(platform => {
            if (videoState.streaming.platforms[platform].streaming) {
                const stats = videoState.streaming.platforms[platform].stats;
                stats.bytes_sent += Math.floor(videoState.stats.current_bitrate / 8);
                stats.frames_sent = videoState.stats.encoded_frames;
                stats.current_bitrate = videoState.stats.current_bitrate;
                stats.viewers = Math.floor(Math.random() * 50) + 10; // Random viewer count
            }
        });
    }
    
    res.json({
        success: true,
        stats: videoState.stats,
        streaming: {
            is_live: videoState.streaming.is_live,
            uptime_seconds: videoState.streaming.start_time ? 
                Math.floor((Date.now() - videoState.streaming.start_time) / 1000) : 0,
            platform_stats: videoState.streaming.platforms,
            rtmp_stats: videoState.streaming.custom_rtmp
        }
    });
});

// Helper function to get platform RTMP URLs
function getPlatformRtmpUrl(platform) {
    const rtmpUrls = {
        youtube: 'rtmp://a.rtmp.youtube.com/live2',
        twitch: 'rtmp://live.twitch.tv/app',
        facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
        tiktok: 'rtmp://push.live.tiktok.com/live',
        instagram: 'rtmp://live-upload.instagram.com/rtmp'
    };
    
    return rtmpUrls[platform] || '';
}

// Station management endpoints (for Dashboard)
app.get('/api/v1/stations/me', (req, res) => {
    console.log('📊 Station info requested');
    
    res.json({
        id: 'demo-station',
        userId: 'demo-user',
        name: 'OneStopRadio Demo',
        description: 'Demo radio station for testing',
        genre: 'Electronic',
        logo: null,
        coverImage: null,
        socialLinks: {
            youtube: null,
            twitch: null,
            facebook: null,
            instagram: null,
            twitter: null
        },
        settings: {
            isPublic: true,
            allowChat: true,
            autoRecord: false,
            maxBitrate: 320
        },
        stats: {
            totalListeners: streamState.currentListeners,
            peakListeners: Math.max(streamState.currentListeners, 50),
            totalHours: Math.floor(Math.random() * 100) + 20,
            createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
            lastStream: streamState.startTime ? new Date(streamState.startTime) : null
        }
    });
});

app.get('/api/v1/streams/history', (req, res) => {
    console.log('📈 Stream history requested');
    
    const sessions = [
        {
            id: 'demo-1',
            stationId: 'demo-station',
            startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
            endTime: new Date(Date.now() - 1 * 60 * 60 * 1000),
            duration: 3600,
            peakListeners: 85,
            avgListeners: 67,
            recordingUrl: null,
            metadata: {
                title: 'Evening Mix Session',
                genre: 'Electronic',
                tracks: ['Track 1', 'Track 2', 'Track 3']
            }
        },
        {
            id: 'demo-2',
            stationId: 'demo-station',
            startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
            endTime: new Date(Date.now() - 22 * 60 * 60 * 1000),
            duration: 7200,
            peakListeners: 142,
            avgListeners: 89,
            recordingUrl: null,
            metadata: {
                title: 'Morning Show',
                genre: 'Talk',
                tracks: ['Morning Mix 1', 'Talk Segment', 'Music Block']
            }
        }
    ];
    
    res.json(sessions);
});

// List all available endpoints
app.get('/api/endpoints', (req, res) => {
    res.json({
        success: true,
        endpoints: [
            // General
            'GET /api/health - Health check',
            'GET /api/endpoints - This endpoint list',
            
            // Audio streaming
            'GET /api/audio/stream/status - Get audio stream status',
            'POST /api/audio/stream/connect - Connect to audio stream server',
            'POST /api/audio/stream/disconnect - Disconnect from audio stream server',
            'POST /api/audio/stream/start - Start audio streaming',
            'POST /api/audio/stream/stop - Stop audio streaming',
            'POST /api/audio/stream/metadata - Update track metadata',
            
            // Video streaming
            'GET /api/video/status - Get video streaming status',
            'GET /api/video/stats - Get video streaming statistics',
            
            // Video sources
            'POST /api/video/camera/on - Enable camera',
            'POST /api/video/camera/off - Disable camera',
            'POST /api/video/camera/settings - Update camera settings',
            'POST /api/video/image - Set static image source',
            'POST /api/video/slideshow/start - Start slideshow',
            'POST /api/video/slideshow/stop - Stop slideshow',
            'POST /api/video/slideshow/next - Next slide',
            'POST /api/video/slideshow/previous - Previous slide',
            
            // Social media streaming
            'POST /api/video/stream/:platform - Configure social media platform',
            'POST /api/video/stream/start - Start live streaming',
            'POST /api/video/stream/stop - Stop live streaming',
            
            // Custom RTMP
            'POST /api/video/rtmp/add - Add custom RTMP stream',
            'DELETE /api/video/rtmp/:rtmp_id - Remove custom RTMP stream',
            
            // Video overlay
            'POST /api/video/overlay/text - Add text overlay',
            'POST /api/video/overlay/clear - Clear text overlay'
        ],
        documentation: 'https://github.com/onestopradio/api-docs'
    });
});

// 404 handler - catch all unmatched routes
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        message: `${req.method} ${req.originalUrl} is not a valid endpoint`,
        availableEndpoints: '/api/endpoints'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Start server with WebSocket support
server.listen(port, () => {
    console.log('🎵 OneStopRadio Mock Stream API Server');
    console.log('=====================================');
    console.log(`🚀 Server running on http://localhost:${port}`);
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
    process.exit(0);
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