# Architecture - How Astro Analytics Works

## System Overview

CSV or Parquet file is selected  
Browser parses locally using DuckDB-WASM (no server involved)  
Columns are auto-detected with user verification  
Raw data is normalized into standardized event records  

In this case data IS already clean. No normalization needed. But the system still has normalization code because it supports ANY game engine.

Map is selected and calibrated  
Game world coordinates are converted to pixel positions  
Events are grouped by player and indexed by timestamp  
Playback engine animates matches on canvas

---

## Core Architectural Decisions

### 1. In-Browser Parsing with DuckDB-WASM

Parse large CSV/Parquet files without a server.

### 2. Per-File Column Mapping with Auto-Detection

**Problem:** CSV columns vary between data sources if we want to scale this to different game engines.

Source A: `ts, player_id, event, x, y`  
Source B: `timestamp, user_id, action, pos_x, pos_y`

**Solution:** System auto-suggests based on common naming patterns. User reviews and corrects if needed.

---

## Using the App

### AI Tab

Get insights on your data using AI. Chat with the system to ask questions about events, patterns, and player activity.

### Data Tab

Upload a CSV or Parquet file, or load the included sample data.  
Map columns (system suggests, you confirm).  
Click "Process" to prepare the data.

### Rules Tab

**Layout:** Toggle which visualization layers appear on the canvas.
- Paths (blue lines showing player movement)
- Points (red dots showing individual events)
- Heatmap (density overlay)

**Event Rules:** Customize colors and icons for each event type.
- Position, Loot, BotKill, BotKilled, BotPosition, KilledByStorm, etc.
- Set render layer (path, point, or heatmap)
- Toggle on/off per event

**Event Type Filters:** Show/hide events by type after processing data.

**Map ID Filter:** Filter events by specific map after processing.

**Date Range:** Filter by start and end date.

**Session Filter:** Filter by specific match/session (multi-select).

### Maps Tab

Upload a map image or use presets (AmbroseValley, GrandRift, Lockdown).

**Reference Points:** Click on the map canvas to place calibration markers.

**Coordinate Transform:** Set calibration parameters.
- Origin X, Origin Y (where world 0,0 starts)
- Scale X, Scale Y (world units per image pixel)
- Invert X, Invert Y (flip axes if needed)
- Axis Map (X/Z, X/Y, or Y/Z pairing)

**Status:** Shows image dimensions and calibration state.

### Views Tab

Save named views of your analysis.  
Quick access to saved filter/map/layer combinations.

---

## Coordinate System Transformation

Game data uses world coordinates: `x = -301.45, z = -355.55`  
Map images are pixels: `4320 × 4320`

Need to convert one to the other.

### The Setup

Each map stores calibration data:

```
origin_x: -370          
origin_z: -473
scale: 900               
image_width: 4320       
image_height: 4320
```

### The Math

Two steps:

**Step 1:** Normalize world coords to 0-1 range

```
u = (world_x - origin_x) / scale
v = (world_z - origin_z) / scale
```

**Step 2:** Scale to image pixels

```
pixel_x = u * image_width
pixel_y = (1 - v) * image_height
```

(We flip Y because image coords start at top-left, game coords assume bottom-left.)

### Real Example (AmbroseValley)

World position: `(-301.45, -355.55)`  
Calibration: origin `(-370, -473)`, scale `900`, image `4320×4320`

```
u = (-301.45 - (-370)) / 900 = 0.0762
v = (-355.55 - (-473)) / 900 = 0.1305

pixel_x = 0.0762 × 4320 = 329
pixel_y = (1 - 0.1305) × 4320 = 3756
```

**Result:** Player renders at pixel `(329, 3756)` on the map.

---

## Normalization

Our game data is already clean. But this layer works for any engine—whether timestamps are milliseconds, Unix time, ISO dates, or something else. Clean data just confirms it's right. Messy data gets converted to standard format.