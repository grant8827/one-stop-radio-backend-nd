# OneStopRadio Mock Stream API Server

A Node.js mock server that simulates the C++ backend API for testing the React AudioStreamEncoder component.

## Features

- 🎵 Complete streaming encoder API simulation
- 📡 Real-time streaming statistics updates
- 🔄 Automatic listener count and bandwidth simulation
- 📊 Protocol-specific responses (Icecast2/SHOUTcast)
- ✅ CORS enabled for frontend development
- 🎛️ Metadata update support

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Server runs on http://localhost:8080
```

## API Endpoints

### Stream Management
- `GET /api/audio/stream/status` - Get current stream status
- `POST /api/audio/stream/connect` - Connect to streaming server
- `POST /api/audio/stream/disconnect` - Disconnect from server
- `POST /api/audio/stream/start` - Start live streaming
- `POST /api/audio/stream/stop` - Stop streaming
- `POST /api/audio/stream/metadata` - Update track metadata

### Utility
- `GET /api/health` - Server health check
- `GET /api/endpoints` - List all available endpoints

## Example Usage

### Connect to Server
```bash
curl -X POST http://localhost:8080/api/audio/stream/connect \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "icecast2",
    "serverHost": "localhost",
    "serverPort": 8000,
    "mountPoint": "/stream.mp3",
    "password": "hackme",
    "codec": "mp3",
    "bitrate": 128
  }'
```

### Start Streaming
```bash
curl -X POST http://localhost:8080/api/audio/stream/start
```

### Check Status
```bash
curl http://localhost:8080/api/audio/stream/status
```

## Response Format

All responses follow this format:
```json
{
  "success": true|false,
  "data": {},
  "error": "Error message if success=false"
}
```

## Stream States

- `disconnected` - Not connected to any server
- `connecting` - Attempting connection (simulated)
- `connected` - Connected but not streaming
- `streaming` - Live streaming active
- `error` - Connection or streaming error

## Development

The server automatically simulates realistic streaming behavior:
- Listener count changes over time
- Bandwidth usage simulation
- Peak level variations
- Connection time tracking

Perfect for testing the React AudioStreamEncoder component without needing a real streaming server.