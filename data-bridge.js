#!/usr/bin/env node

/**
 * MongoDB Cache Monitor Data Bridge
 * This script acts as a bridge between the MongoDB shell script and the web dashboard
 * It can serve the dashboard and provide real-time data updates
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// Configuration
const CONFIG_FILE = './config.json';
let config = {};

// Load configuration
function loadConfig() {
    try {
        const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
        config = JSON.parse(configData);
        console.log('Configuration loaded successfully');
    } catch (error) {
        console.error('Error loading configuration:', error.message);
        console.log('Using default configuration');
        config = {
            dashboard: { port: 8080, autoRefresh: true },
            monitoring: { reportTime: 60 }
        };
    }
}

// Latest data storage
let latestData = {
    timestamp: new Date().toISOString(),
    collections: [],
    summary: {},
    system: {},
    metadata: {}
};

// Store system information separately for easy access
let systemInfo = {
    mongoVersion: '',
    hostInfo: {},
    serverStatus: {},
    lastUpdated: ''
};

// Store historical data for trends
const historicalData = [];
const MAX_HISTORY = 100;

// Serve static files and API endpoints
function createServer() {
    const server = http.createServer((req, res) => {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        
        // API endpoints
        if (url.pathname === '/api/data') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(latestData));
            return;
        }
        
        if (url.pathname === '/api/history') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(historicalData));
            return;
        }
        
        if (url.pathname === '/api/config') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
            return;
        }

        if (url.pathname === '/api/system') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(systemInfo));
            return;
        }

        // Serve dashboard HTML file
        if (url.pathname === '/' || url.pathname === '/dashboard') {
            try {
                const dashboardPath = path.join(__dirname, 'dashboard.html');
                const dashboardContent = fs.readFileSync(dashboardPath, 'utf8');
                
                // Add cache-busting timestamp
                const timestamp = Date.now();
                
                // Inject real data endpoint
                const modifiedContent = dashboardContent.replace(
                    'generateSampleData()',
                    'fetchRealData()'
                ).replace(
                    '</body>',
                    `
                    <script>
                        console.log('Dashboard loaded at: ${new Date().toISOString()}');
                        
                        // Real data fetching
                        async function fetchRealData() {
                            try {
                                const response = await fetch('/api/data');
                                const data = await response.json();
                                return data.collections || [];
                            } catch (error) {
                                console.error('Error fetching real data:', error);
                                return generateSampleData(); // Fallback to sample data
                            }
                        }
                        
                        // Fetch historical data for trend chart
                        async function fetchHistoricalData() {
                            try {
                                const response = await fetch('/api/history');
                                const history = await response.json();
                                return history || [];
                            } catch (error) {
                                console.error('Error fetching historical data:', error);
                                return [];
                            }
                        }
                        
                        // Update efficiency trend chart with historical data
                        async function updateEfficiencyTrendChartFromHistory() {
                            try {
                                const history = await fetchHistoricalData();
                                
                                if (history.length > 0) {
                                    efficiencyTrendData = history.map(item => ({
                                        time: new Date(item.timestamp).toLocaleTimeString(),
                                        value: item.summary.avgCachePercent || 0,
                                        totalSize: item.summary.totalSize || 0,
                                        totalCached: item.summary.totalCached || 0
                                    }));
                                    
                                    efficiencyTrendChart.data.labels = efficiencyTrendData.map(d => d.time);
                                    efficiencyTrendChart.data.datasets[0].data = efficiencyTrendData.map(d => d.value);
                                    
                                    // Update subtitle with latest totals
                                    if (efficiencyTrendData.length > 0) {
                                        const latest = efficiencyTrendData[efficiencyTrendData.length - 1];
                                        const subtitleText = \`Total Size: \${latest.totalSize.toLocaleString()} MB | Cached: \${latest.totalCached.toLocaleString()} MB (includes data + indexes)\`;
                                        efficiencyTrendChart.options.plugins.subtitle.text = subtitleText;
                                    }
                                    
                                    efficiencyTrendChart.update();
                                }
                            } catch (error) {
                                console.error('Error updating trend chart:', error);
                            }
                        }
                        
                        // Update the original updateDashboard function to use real data
                        const originalUpdateDashboard = updateDashboard;
                        updateDashboard = async function() {
                            if (isPaused || historyMode) return;
                            
                            try {
                                const response = await fetch('/api/data');
                                const serverData = await response.json();
                                
                                if (serverData.collections) {
                                    collectionsData = serverData.collections;
                                    updateStatsOverview(collectionsData);
                                    updateCacheByDbChart(collectionsData);
                                    
                                    // Update trend chart with current server data
                                    if (serverData.summary) {
                                        // Get system data for wiredTigerCache
                                        const systemResponse = await fetch('/api/system');
                                        const systemData = await systemResponse.json();
                                        
                                        updateEfficiencyTrendChart(
                                            serverData.summary.avgCachePercent || 0,
                                            serverData.summary.totalSize || 0,
                                            serverData.summary.totalCached || 0,
                                            systemData.wiredTigerCache || 0
                                        );
                                    } else {
                                        // Fallback to historical data if no current summary
                                        await updateEfficiencyTrendChartFromHistory();
                                    }
                                    
                                    updateCollectionsTable(collectionsData);
                                    updateDbFilter(collectionsData);
                                }
                                
                                // Update system information
                                if (typeof updateSystemInfo === 'function') {
                                    await updateSystemInfo();
                                }
                                
                                document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date(serverData.timestamp).toLocaleTimeString();
                            } catch (error) {
                                console.error('Error updating dashboard:', error);
                                // Fallback to original function with sample data
                                originalUpdateDashboard();
                            }
                        };
                    </script>
                    </body>`
                );
                
                res.writeHead(200, { 
                    'Content-Type': 'text/html',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                });
                res.end(modifiedContent);
            } catch (error) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Dashboard not found. Make sure dashboard.html exists.');
            }
            return;
        }

        // 404 for other paths
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    return server;
}

// Streaming JSON parser state (handles data arriving in arbitrary chunks)
let streamBuffer = '';
let braceDepth = 0;
let inString = false;
let escaped = false;

// Process a complete JSON snapshot
function handleSnapshot(data) {
    latestData = data;

    // Extract and store system information
    if (data.system) {
        systemInfo = {
            mongoVersion: data.system.mongoVersion || '',
            hostInfo: data.system.hostInfo || {},
            serverStatus: data.system.serverStatus || {},
            wiredTigerCache: data.system.wiredTigerCache || 0,
            lastUpdated: data.timestamp || new Date().toISOString()
        };
    }

    // Add to historical data
    const historyEntry = {
        timestamp: data.timestamp || new Date().toISOString(),
        summary: data.summary,
        collections: data.collections ? data.collections.slice(0, 10) : [],
        system: data.system ? {
            mongoVersion: data.system.mongoVersion,
            connections: data.system.serverStatus?.connections?.current || 0,
            memory: data.system.serverStatus?.memory?.resident || 0,
            uptime: data.system.serverStatus?.uptime || 0,
            wiredTigerCache: data.system.wiredTigerCache || 0
        } : {}
    };

    const lastEntry = historicalData[historicalData.length - 1];
    if (!lastEntry || lastEntry.timestamp !== historyEntry.timestamp) {
        historicalData.push(historyEntry);
        if (historicalData.length > MAX_HISTORY) {
            historicalData.shift();
        }
    }

    console.log(`Data updated: ${data.collections.length} collections, ${data.summary.avgCachePercent}% avg cache (${historicalData.length} history points)`);
    if (data.system?.hostInfo?.hostname) {
        console.log(`System: ${data.system.hostInfo.hostname} - MongoDB ${data.system.mongoVersion}`);
    }
}

// Process streaming data from stdin or child process stdout.
// Data arrives in arbitrary chunks; we track brace depth to find
// complete top-level JSON objects.
function processMongoData(chunk) {
    for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];

        if (escaped) {
            escaped = false;
            if (braceDepth > 0) streamBuffer += ch;
            continue;
        }

        if (ch === '\\' && inString) {
            escaped = true;
            if (braceDepth > 0) streamBuffer += ch;
            continue;
        }

        if (ch === '"' && !escaped) {
            inString = !inString;
            if (braceDepth > 0) streamBuffer += ch;
            continue;
        }

        if (inString) {
            if (braceDepth > 0) streamBuffer += ch;
            continue;
        }

        // Outside a string
        if (ch === '{') {
            braceDepth++;
            streamBuffer += ch;
        } else if (ch === '}') {
            if (braceDepth > 0) {
                streamBuffer += ch;
                braceDepth--;
                if (braceDepth === 0) {
                    // Complete JSON object
                    try {
                        const data = JSON.parse(streamBuffer);
                        if (data.collections && data.summary) {
                            handleSnapshot(data);
                        }
                    } catch (parseError) {
                        console.error('Error parsing JSON object:', parseError.message);
                        console.log('Buffer start:', streamBuffer.substring(0, 200) + '...');
                    }
                    streamBuffer = '';
                    inString = false;
                    escaped = false;
                }
            }
        } else {
            if (braceDepth > 0) streamBuffer += ch;
        }
    }
}

// Load data from JSON file
function loadFromJsonFile(filePath) {
    try {
        console.log(`Loading data from JSON file: ${filePath}`);
        const jsonData = fs.readFileSync(filePath, 'utf8');
        
        // Clear any existing historical data (including sample data)
        historicalData.length = 0;
        
        // Parse JSON objects from the file
        const dataObjects = [];
        
        // Try to split by lines and look for complete JSON objects
        // This handles both single JSON objects and multiple JSON objects in the file
        const lines = jsonData.trim().split('\n');
        let currentJsonString = '';
        let braceCount = 0;
        let inString = false;
        let escaped = false;
        
        for (const line of lines) {
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                currentJsonString += char;
                
                if (escaped) {
                    escaped = false;
                    continue;
                }
                
                if (char === '\\') {
                    escaped = true;
                    continue;
                }
                
                if (char === '"') {
                    inString = !inString;
                    continue;
                }
                
                if (inString) {
                    continue;
                }
                
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    
                    // Complete JSON object found
                    if (braceCount === 0 && currentJsonString.trim().length > 0) {
                        try {
                            const data = JSON.parse(currentJsonString.trim());
                            if (data.collections && data.summary) {
                                dataObjects.push(data);
                                console.log(`Found valid data object with ${data.collections.length} collections`);
                            }
                        } catch (parseError) {
                            console.log(`Skipping invalid JSON object: ${parseError.message}`);
                        }
                        
                        currentJsonString = '';
                        braceCount = 0;
                    }
                }
            }
            
            currentJsonString += '\n';
        }
        
        if (dataObjects.length === 0) {
            console.error('No valid JSON objects with collections and summary found in file');
            return;
        }
        
        console.log(`Found ${dataObjects.length} data snapshots in JSON file`);
        
        // Process all data objects chronologically
        dataObjects.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        // Set the latest data to the most recent snapshot
        latestData = dataObjects[dataObjects.length - 1];
        
        // Extract and store system information from latest data
        if (latestData.system) {
            systemInfo = {
                mongoVersion: latestData.system.mongoVersion || '',
                hostInfo: latestData.system.hostInfo || {},
                serverStatus: latestData.system.serverStatus || {},
                wiredTigerCache: latestData.system.wiredTigerCache || 0,
                lastUpdated: latestData.timestamp || new Date().toISOString()
            };
        }
        
        // Build historical data from all snapshots
        for (const data of dataObjects) {
            const historyEntry = {
                timestamp: data.timestamp || new Date().toISOString(),
                summary: data.summary,
                collections: data.collections ? data.collections.slice(0, 10) : [], // Store top 10 collections
                system: data.system ? {
                    mongoVersion: data.system.mongoVersion,
                    connections: data.system.serverStatus?.connections?.current || 0,
                    memory: data.system.serverStatus?.memory?.resident || 0,
                    uptime: data.system.serverStatus?.uptime || 0,
                    wiredTigerCache: data.system.wiredTigerCache || 0
                } : {}
            };
            
            historicalData.push(historyEntry);
        }
        
        // Keep only last MAX_HISTORY entries
        if (historicalData.length > MAX_HISTORY) {
            historicalData.splice(0, historicalData.length - MAX_HISTORY);
        }
        
        console.log(`JSON file loaded successfully: ${latestData.collections.length} collections, ${latestData.summary.avgCachePercent}% avg cache, ${historicalData.length} historical points`);
        if (latestData.system?.hostInfo?.hostname) {
            console.log(`System: ${latestData.system.hostInfo.hostname} - MongoDB ${latestData.system.mongoVersion}`);
        }
        
    } catch (error) {
        console.error('Error loading JSON file:', error.message);
    }
}

// Start monitoring (example with mongosh)
function startMonitoring(connectionString) {
    console.log('Starting MongoDB monitoring...');

    // Reset stream parser state for a fresh process
    streamBuffer = '';
    braceDepth = 0;
    inString = false;
    escaped = false;
    
    const mongoProcess = spawn('mongosh', [
        '--quiet',
        connectionString || 'mongodb://localhost:27017',
        'cacheview_json.js'
    ], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    mongoProcess.stdout.on('data', (data) => {
        processMongoData(data.toString());
    });

    mongoProcess.stderr.on('data', (data) => {
        console.error('MongoDB Error:', data.toString());
    });

    mongoProcess.on('close', (code) => {
        console.log(`MongoDB monitoring process exited with code ${code}`);
        if (code !== 0) {
            console.log('Restarting monitoring in 30 seconds...');
            setTimeout(() => startMonitoring(connectionString), 30000);
        }
    });

    return mongoProcess;
}

// Export data to CSV
function exportToCSV() {
    if (!latestData.collections || latestData.collections.length === 0) {
        console.log('No data available for export');
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `mongodb-cache-export-${timestamp}.csv`;
    
    const headers = [
        'Database', 'Collection', 'Size (MB)', 'Cached (MB)', 'Cache %',
        'Read Rate (MB/s)', 'Write Rate (MB/s)', 'Pages Used', 'Timestamp'
    ];
    
    const rows = latestData.collections.map(coll => [
        coll.db,
        coll.collection,
        coll.size,
        coll.cached,
        coll.cachePercent,
        coll.readRate,
        coll.writeRate,
        coll.pagesUsed,
        latestData.timestamp
    ]);
    
    const csvContent = [headers, ...rows].map(row => row.join(',')).join('\n');
    
    try {
        fs.writeFileSync(filename, csvContent);
        console.log(`Data exported to ${filename}`);
    } catch (error) {
        console.error('Error exporting CSV:', error.message);
    }
}

// Command line interface
function printUsage() {
    console.log(`
MongoDB Cache Monitor Data Bridge

Usage:
  node data-bridge.js [options]

Options:
  --port <number>          Dashboard port (default: 8080)
  --mongo <connection>     MongoDB connection string
  --json-file <path>       Load data from JSON file (cacheview_json.js output)
  --watch-file <path>      Watch JSON file for changes and auto-reload
  --export-csv            Export current data to CSV and exit
  --config <file>         Configuration file path (default: ./config.json)
  --help                  Show this help message

Examples:
  node data-bridge.js
  node data-bridge.js --port 3000
  node data-bridge.js --mongo "mongodb://user:pass@localhost:27017/admin"
  node data-bridge.js --json-file cacheview_json_output.json
  node data-bridge.js --watch-file cache_data.json --port 8080
  node data-bridge.js --export-csv
    `);
}

// Main function
function main() {
    const args = process.argv.slice(2);
    let port = 8080;
    let mongoConnection = "";
    let jsonFile = "";
    let watchFile = "";
    let exportOnly = false;
    let configFile = CONFIG_FILE;

    // Parse command line arguments
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--port':
                port = parseInt(args[++i]) || 8080;
                break;
            case '--mongo':
                mongoConnection = args[++i];
                break;
            case '--json-file':
                jsonFile = args[++i];
                break;
            case '--watch-file':
                watchFile = args[++i];
                break;
            case '--export-csv':
                exportOnly = true;
                break;
            case '--config':
                configFile = args[++i];
                break;
            case '--help':
                printUsage();
                return;
            default:
                console.log(`Unknown option: ${args[i]}`);
                printUsage();
                return;
        }
    }

    // Load configuration
    loadConfig();

    // Override port from config if not provided via command line
    if (config.dashboard && config.dashboard.port && port === 8080) {
        port = config.dashboard.port;
    }

    if (exportOnly) {
        // Just export and exit
        console.log('Export mode - loading latest data...');
        exportToCSV();
        return;
    }

    // Load initial data from JSON file if provided
    if (jsonFile) {
        loadFromJsonFile(jsonFile);
    }

    // Create and start server
    const server = createServer();
    
    server.listen(port, () => {
        console.log(`MongoDB Cache Monitor Dashboard running at http://localhost:${port}`);
        console.log('Available endpoints:');
        console.log(`  http://localhost:${port}/           - Dashboard`);
        console.log(`  http://localhost:${port}/api/data   - Current data`);
        console.log(`  http://localhost:${port}/api/history - Historical data`);
        console.log(`  http://localhost:${port}/api/config - Configuration`);
        console.log(`  http://localhost:${port}/api/system - System information`);
    });

    // Set up file watching if requested
    if (watchFile) {
        console.log(`Watching file: ${watchFile}`);
        
        // Clear any sample data since we're using real data
        historicalData.length = 0;
        
        // Load initial data
        if (fs.existsSync(watchFile)) {
            loadFromJsonFile(watchFile);
        }
        
        // Watch for file changes
        fs.watchFile(watchFile, (curr, prev) => {
            console.log(`File ${watchFile} changed, reloading...`);
            loadFromJsonFile(watchFile);
        });
    }

    // Start MongoDB monitoring if connection string provided
    if (mongoConnection) {
        startMonitoring(mongoConnection);
    } else if (!jsonFile && !watchFile) {
        // Check if stdin is a pipe (data being piped in)
        if (!process.stdin.isTTY) {
            console.log('Reading data from stdin (pipe detected)...');
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (chunk) => {
                processMongoData(chunk);
            });
            process.stdin.on('end', () => {
                console.log('Stdin stream ended. Dashboard remains available with last received data.');
            });
            process.stdin.resume();
        } else {
            console.log('\nTo start monitoring, run one of:');
            console.log('  mongosh --quiet "your-connection-string" cacheview_json.js | node data-bridge.js');
            console.log('  node data-bridge.js --mongo "your-connection-string"');
            console.log('  node data-bridge.js --json-file your-data.json');
            console.log('  node data-bridge.js --watch-file your-data.json');
        }
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nShutting down gracefully...');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
}

// Export functions for testing
module.exports = {
    loadConfig,
    processMongoData,
    exportToCSV
};

// Run if called directly
if (require.main === module) {
    main();
}