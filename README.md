# Astro Analytics - README

User can upload game data (CSV / Parquet), pick a map, and see all events on it. He can play the match like a replay, move forward or back, and check any moment. He can filter by player or event type, and switch between paths, points, or heatmap. Everything runs in the browser only, with no upload or backend.

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Vanilla JavaScript (no framework) | Fast, no build step, runs in browser |
| Database | DuckDB-WASM | Parse CSV/Parquet files in browser (no server needed) |
| Rendering | Canvas 2D | Smooth playback at 60fps, handles 1M+ events |
| Animation | requestAnimationFrame | Browser native, smooth timeline scrubbing |
| Math | Custom calibration functions | Convert game coordinates to screen pixels |
| Styling | CSS (custom design tokens) | No framework, semantic colors |

**Key Decision:** Everything runs in the browser. No backend server. Files never leave your computer.

## Setup

### Prerequisites

- Python 3.6+
- Modern browser (Chrome, Firefox, Edge)
- The data files (CSV or Parquet format)

### Installation

```bash
# Clone or download the repo
cd astro-analytics

# Start the dev server
python serve.py

# Open browser
http://localhost:8080
```

Alternatively, run the `start.bat` script.

### Environment Variables

None required. Everything is configuration via the UI.

### File Structure

```
astro-analytics/
├── index.html              # App shell, all UI
├── app.js                  # Main controller
├── app.css                 # Styling
├── serve.py                # Dev server with COOP/COEP headers
│
├── modules/
│   ├── filters.js          # Hide/show events by type/player
│   ├── heatmap.js          # Density visualization
│   ├── renderer.js         # Canvas drawing
│   ├── playback.js         # Timeline animation
│   ├── calibration.js      # Game coords → pixel coords
│   ├── maps.js             # Map image management
│   ├── event-rules.js      # Color/icon rules per event type
│   ├── datasets.js         # Data storage & mapping
│   ├── etl.js              # File processing pipeline
│   └── assistant.js        # Voice commands (text parsing)
│
└── player_data/
    ├── February_10/        # Sample Parquet files
    ├── February_11/        # (79 files of game data)
    └── minimaps/           # Map images (4320×4320 px)
        ├── AmbroseValley.png
        ├── GrandRift.png
        └── Lockdown.jpg
```

## How to Use

### 1. Upload Data

**Data Tab → Upload**

- Select CSV or Parquet files
- System auto-reads column names

### 2. Map Columns

**Data Tab → Per-File Mapping**

Each file gets its own mapping:

- **Timestamp** ← which column has time?
- **Entity ID** ← which column has player ID?
- **Event Type** ← which column has event name?
- **X Coord, Y Coord** ← which columns have positions?

The reason column mapping is added is to support different game engines, not just one kind of output format for a specific system. Everything is auto-mapped, but the user needs to review and proceed.

### 3. Pick a Map

**Maps Tab**

3 maps are loaded and pre-configured, but users can also:

- Upload a map image (PNG/JPG)
- Enter calibration (scale, origin)
- Or use preset maps (AmbroseValley, GrandRift, Lockdown)

## Input Data Format

### CSV/Parquet Requirements

Must have columns for:

- **Timestamp** (milliseconds, seconds, or ISO date)
- **Entity ID** (player/bot ID)
- **Event Type** (what happened)
- **X Coordinate** (game world position)
- **Y Coordinate** (game world position)

Optional:

- Z Coordinate (elevation)
- Session/Match ID
- Map ID
- Entity Name

### Column Names Don't Matter

System auto-suggests mapping based on names like:

- `ts`, `time`, `timestamp` → timestamp
- `player_id`, `user_id`, `entity_id` → entity
- `x`, `pos_x`, `world_x` → x coordinate

If auto-guess is wrong, user can override.

## Processing Pipeline

```
Raw File (CSV/Parquet)
    ↓
DuckDB-WASM reads it
    ↓
User maps columns (which column = timestamp, etc)
    ↓
ETL transforms:
  - Parse timestamps (handles different formats)
  - Normalize event names (uppercase, decode bytes)
  - Validate coordinates (skip rows with null x/y)
  - Build indexes (find unique players, sessions, event types)
    ↓
Processed Dataset
  - Events with normalized schema
  - Player index (fast filtering)
  - Session index (match grouping)
    ↓
Map Selection
  - Pick AmbroseValley, GrandRift, or Lockdown
  - Load calibration (scale, origin)
    ↓
Pre-compute rendering:
  - Convert game coords to pixel coords
  - Group events by player (for path drawing)
  - Build heatmap density grid
    ↓
Playback
  - Animation loop advances timestamp
  - Only show events before current time
  - 60fps, smooth scrubbing
```

### Why Normalization?

Our data is clean — But the normalization layer supports any game engine that sends timestamps, events, and coordinates — whether as milliseconds, Unix time, ISO dates, or anything else. Same code works for Nakama, Unreal, custom servers, or mobile APIs.

## Future Ideas

- Export video of playback
- Real-time stream support
- Custom heatmap gradients
- AI-powered event detection
- Multi-map comparison
- Cloud save/share views
