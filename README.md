# MongoDB Cache Monitor

Real-time MongoDB WiredTiger cache monitoring with a web dashboard. Zero external dependencies -- uses only Node.js built-in modules and Chart.js via CDN.

## Important: Replica Set / Standalone Only

This tool is designed for **replica set** and **standalone** MongoDB deployments. It uses the `db.collection.stats()` command to collect WiredTiger cache metrics, which behaves differently on sharded clusters

- **Dashboard charts** reflect totals from the connected node, not per-shard breakdowns.


## Files

| File | Description |
|------|-------------|
| `cacheview_json.js` | mongosh script that collects cache stats and outputs clean JSON |
| `data-bridge.js` | Node.js HTTP server that serves the dashboard and provides REST APIs |
| `dashboard.html` | Single-page web dashboard (charts, tables, history playback) |
| `config.json` | Configuration for monitoring, display, filtering, and dashboard |
| `mongotop-view/README.md` | Documentation for the mongotop view and usage details |
| `exports/` | Directory for CSV exports |

## Requirements

- **mongosh** (MongoDB Shell) -- for running the data capture script
- **Node.js >= 14** -- for the web dashboard server
- **MongoDB user roles**: `backup`, `readAnyDatabase`, `clusterMonitor`

## Usage

### Option 1: Live monitoring (data-bridge spawns mongosh)

```bash
node data-bridge.js --mongo "mongodb+srv://user:pass@cluster.mongodb.net/admin"
```

### Option 2: Pipe mongosh output into data-bridge

```bash
mongosh --quiet "mongodb+srv://user:pass@cluster.mongodb.net/admin" cacheview_json.js \
  | node data-bridge.js
```

### Option 3: Write to file and watch

```bash
# Terminal 1 -- capture data to file
mongosh --quiet "connection-string" cacheview_json.js > cache_output.json

# Terminal 2 -- serve dashboard watching the file
node data-bridge.js --watch-file cache_output.json
```

### Option 4: Load a previously captured JSON file

```bash
node data-bridge.js --json-file cacheview_json_output.json
```

Then open **http://localhost:8080** in your browser.

### Single snapshot (no loop)

```bash
mongosh --quiet "connection-string" --eval "var config = {maxIterations: 1};" cacheview_json.js
```

## cacheview_json.js Configuration

Pass config overrides via `--eval` before the script:

```bash
mongosh --quiet "connection-string" \
  --eval "var config = {reportTime: 30, maxCollections: 10, maxIterations: 5};" \
  cacheview_json.js
```

| Option | Default | Description |
|--------|---------|-------------|
| `reportTime` | 600 | Seconds between iterations (10 minutes) |
| `maxIterations` | -1 | Number of iterations (-1 = infinite) |
| `maxCollections` | 20 | Top N collections by cached size (-1 = all) |
| `showIndexes` | true | Include index cache stats |
| `minSizeThreshold` | 0 | Minimum collection size in MB |
| `refreshCollectionsEvery` | 10 | Re-discover collections every N iterations |
| `debug` | false | Include debug info in JSON metadata |

## data-bridge.js Options

```
node data-bridge.js [options]

  --port <number>        Dashboard port (default: 8080)
  --mongo <connection>   MongoDB connection string (spawns mongosh)
  --json-file <path>     Load data from a JSON file
  --watch-file <path>    Watch a JSON file for changes and auto-reload
  --export-csv           Export current data to CSV and exit
  --config <file>        Config file path (default: ./config.json)
  --help                 Show help
```

## Sample Images

![Summary](images/image1.png)
![Dashboard](images/image2.png)
![Collections](images/image3.png)


## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard HTML |
| `GET /api/data` | Latest snapshot (collections, summary, system) |
| `GET /api/history` | Historical data points (up to 100) |
| `GET /api/config` | Current configuration |
| `GET /api/system` | System info (MongoDB version, host, connections, cache) |


## Mongotop

See [mongotop-view README](mongotop-view/README.md)

## Third-Party Notices

This project uses Chart.js via CDN in [dashboard.html](dashboard.html) and [mongotop-view/mongotop-view.js](mongotop-view/mongotop-view.js).

- Chart.js: https://www.chartjs.org/
- License: MIT License
- Copyright: Chart.js Contributors

## License

MIT
