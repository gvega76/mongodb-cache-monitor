# mongotop JSON Dashboard

A simple dashboard for visualizing MongoDB `mongotop` JSON output.

## Features
- Visualizes ops/sec, active sec/sec, and avg ms/op per namespace
- Drilldown charts for each namespace
- Responsive, modern UI (Chart.js)
- Works with newline-delimited mongotop JSON files

## Requirements
- Node.js (v14 or newer recommended)

## Usage
1. Place your mongotop JSON file in the project directory (e.g., `mongotop_output.json`).
2. Start the dashboard server:

   ```sh
   node mongotop-view.js --json-file sampleMongoTop.json --port 8100
   ```
   - Replace `mongotop_output.json` with your file if needed.
   - The `--port` option is optional (default: 8090).

3. Open your browser and go to:

   [http://localhost:8100](http://localhost:8100)

## Options
- `--json-file <path>`: Path to mongotop JSON file (required)
- `--port <number>`: Port for the dashboard (default: 8090)
- `--namespace-limit <n>`: Max namespaces per snapshot (default: 5, 0 = all)
- `--timezone <iana>`: Timezone for timestamps (default: America/New_York)
- `--meta-file <path>`: Path to collection size metadata (optional)
- `--span-gaps <bool>`: Connect missing datapoint gaps (default: true)

## Example
```sh
node mongotop-view.js --json-file mongotop_output.json --port 8100
```

## How to generate a mongotop JSON file

You can generate a compatible mongotop JSON file with a command like:

```sh
mongotop --json --rowcount=48 600 --uri="mongodb://user:password@primaryhost:port" > mongotop_output.json
```
- `--json`: Output in JSON format
- `--rowcount=48`: Number of snapshots to capture
- `600`: Interval in seconds between snapshots (here, 600s = 10min)
- `--uri=...`: Your MongoDB connection string
- Output is redirected to `mongotop_output.json`

You can then use this file with the dashboard as described above.

## Sample Images
![Dashboard](images/image1.png)
![Graphs](images/image2.png)

## License
MIT
