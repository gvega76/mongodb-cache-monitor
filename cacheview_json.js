// MongoDB Cache Monitor - JSON Output with Dynamic Collection Discovery
// This script generates pure JSON output and automatically detects new collections

// Configuration - JSON output only
// If config is already defined (via --eval), merge with defaults instead of overwriting
var defaultConfig = {
    reportTime: 600, // seconds (10 minutes)
    outputFormat: "json", // JSON only
    showIndexes: true,
    minSizeThreshold: 0, // MB - only show collections larger than this
    outputFile: "cache_data.json", // Output file name
    appendMode: false, // If true, appends to file; if false, overwrites
    includeTimestamp: true,
    refreshCollectionsEvery: 10, // Refresh collection list every N iterations (set to 1 for every iteration, or higher for large deployments)
    maxCollections: 20, // Maximum number of collections to output (sorted by cached size, -1 for all)
    debug: false // Set to true to enable debug output to stderr
};

// Merge existing config (if any) with defaults
if (typeof config === 'undefined') {
    var config = defaultConfig;
} else {
    // Merge user config with defaults (user config takes precedence)
    for (var key in defaultConfig) {
        if (defaultConfig.hasOwnProperty(key) && !config.hasOwnProperty(key)) {
            config[key] = defaultConfig[key];
        }
    }
}

// Function to output debug messages to stderr (won't interfere with JSON on stdout)
function debugLog(message) {
    if (config.debug) {
        // In MongoDB shell, we can't easily write to stderr, so we'll skip debug output
        // to ensure clean JSON. Debug info is included in the JSON metadata instead.
    }
}

// MongoDB connection and data collection
db = db.getSiblingDB("admin");

var collectionInfos = [];
var lastCollectionRefresh = 0;

// Function to discover all collections across databases
function discoverCollections() {
    debugLog("Discovering collections...");
    
    var dbInfos = db.adminCommand({listDatabases:1, nameOnly: true});
    var dbNames = [];

    for(var d = 0; d < dbInfos.databases.length; d++) {
        var dbName = dbInfos.databases[d];
        if (dbName.name === "local" || dbName.name === "config" || dbName.name === "admin") {
            continue;
        }
        dbNames.push(dbName.name);
    }

    var newCollectionInfos = [];

    // Build a lookup map for existing collections to preserve stats across refreshes
    var existingMap = {};
    for(var e = 0; e < collectionInfos.length; e++) {
        existingMap[collectionInfos[e].fullName] = collectionInfos[e];
    }

    // Discover collections (lightweight: only list databases and collections, no getIndexes)
    for(var d = 0; d < dbNames.length; d++) {
        var collectionsInfo = db.getSiblingDB(dbNames[d]).getCollectionInfos();
        
        for(var c = 0; c < collectionsInfo.length; c++) {
            var collectionInfo = collectionsInfo[c];

            // Only include regular collections (skip views, timeseries, system.*)
            if (collectionInfo.type !== 'collection' || collectionInfo.name.startsWith('system.')) {
                continue;
            }
            
            var fullName = dbNames[d] + "." + collectionInfo.name;
            var existingInfo = existingMap[fullName] || null;
            
            newCollectionInfos.push({
                db: dbNames[d],
                coll: collectionInfo.name,
                fullName: fullName,
                inCache: existingInfo ? existingInfo.inCache : 0,
                cacheRead: existingInfo ? existingInfo.cacheRead : 0,
                cacheWrite: existingInfo ? existingInfo.cacheWrite : 0,
                pagesUsed: existingInfo ? existingInfo.pagesUsed : 0,
                indexesInfo: existingInfo ? existingInfo.indexesInfo : [],
                isNew: !existingInfo
            });
        }
    }
    
    // Check for new collections
    var newCollectionCount = 0;
    var removedCollectionCount = 0;
    var newCollectionNames = [];
    var removedCollectionNames = [];
    
    for(var n = 0; n < newCollectionInfos.length; n++) {
        if(newCollectionInfos[n].isNew) {
            newCollectionCount++;
            newCollectionNames.push(newCollectionInfos[n].fullName);
            debugLog("New collection discovered: " + newCollectionInfos[n].fullName);
        }
    }
    
    // Check for removed collections
    for(var o = 0; o < collectionInfos.length; o++) {
        var found = false;
        for(var n = 0; n < newCollectionInfos.length; n++) {
            if(collectionInfos[o].fullName === newCollectionInfos[n].fullName) {
                found = true;
                break;
            }
        }
        if(!found) {
            removedCollectionCount++;
            removedCollectionNames.push(collectionInfos[o].fullName);
            debugLog("Collection removed: " + collectionInfos[o].fullName);
        }
    }
    
    collectionInfos = newCollectionInfos;
    
    debugLog("Collection discovery complete: " + collectionInfos.length + " total (" + 
             newCollectionCount + " new, " + removedCollectionCount + " removed)");
    
    return {
        totalCollections: collectionInfos.length,
        newCollections: newCollectionCount,
        removedCollections: removedCollectionCount,
        databases: dbNames.length,
        newCollectionNames: newCollectionNames,
        removedCollectionNames: removedCollectionNames
    };
}

// Function to write JSON data to output (stdout only, no comments)
function writeJsonOutput(data) {
    print(JSON.stringify(data));
}

// Initial collection discovery
var discoveryStats = discoverCollections();

// Main monitoring loop
var iterationCount = 0;
var maxIterations = config.maxIterations || -1; // -1 means infinite

while(maxIterations === -1 || iterationCount < maxIterations) {
    var iterationStartTime = new Date();
    var timestamp = iterationStartTime.toISOString();
    
    // Periodically refresh collection list to detect new collections
    var shouldRefreshCollections = (iterationCount % config.refreshCollectionsEvery === 0) && iterationCount > 0;
    if(shouldRefreshCollections) {
        var refreshStartTime = new Date();
        try {
            discoveryStats = discoverCollections();
            lastCollectionRefresh = iterationCount;
            var refreshDuration = (new Date() - refreshStartTime) / 1000;
            debugLog("Collection refresh completed in " + refreshDuration + " seconds");
        } catch (refreshError) {
            debugLog("Collection refresh failed: " + refreshError.toString());
            // Continue with existing collection list
        }
    }
    
    var outputData = {
        timestamp: timestamp,
        iteration: iterationCount + 1,
        config: {
            reportTime: config.reportTime,
            showIndexes: config.showIndexes,
            minSizeThreshold: config.minSizeThreshold,
            refreshCollectionsEvery: config.refreshCollectionsEvery,
            maxCollections: config.maxCollections,
            debug: config.debug
        },
        metadata: {
            totalDatabases: discoveryStats.databases,
            totalCollectionsDiscovered: collectionInfos.length,
            lastCollectionRefresh: lastCollectionRefresh,
            newCollectionsThisRefresh: shouldRefreshCollections ? discoveryStats.newCollections : 0,
            removedCollectionsThisRefresh: shouldRefreshCollections ? discoveryStats.removedCollections : 0,
            newCollectionNames: shouldRefreshCollections ? discoveryStats.newCollectionNames : [],
            removedCollectionNames: shouldRefreshCollections ? discoveryStats.removedCollectionNames : [],
            monitoringStarted: timestamp,
            dataSource: "MongoDB Cache Monitor - Dynamic Discovery",
            iterationStartTime: timestamp
        },
        collections: [],
        summary: {}
    };
    
    var processedCollections = [];
    var totalSize = 0;
    var totalCached = 0;
    var totalReadRate = 0;
    var totalWriteRate = 0;

    for(var c = 0; c < collectionInfos.length; c++) {
        var collInfo = collectionInfos[c];
        var currentDb = db.getSiblingDB(collInfo.db);
        var mb = 1024 * 1024;
        
        try {
            var collStats = currentDb.getCollection(collInfo.coll).stats({scale: mb, indexDetails: true});
            
            // Skip if stats returned an error (e.g. views, unsupported collection types)
            if(collStats.hasOwnProperty("codeName") || !collStats["wiredTiger"] || !collStats["wiredTiger"]["cache"]) {
                continue;
            }

            var inCache = Math.floor(collStats["wiredTiger"]["cache"]["bytes currently in the cache"] / mb);
            var cacheRead = Math.floor(collStats["wiredTiger"]["cache"]["bytes read into cache"] / mb);
            var cacheWrite = Math.floor(collStats["wiredTiger"]["cache"]["bytes written from cache"] / mb);
            var pagesUsed = Math.floor(collStats["wiredTiger"]["cache"]["pages requested from the cache"]);
            var collSize = collStats["size"] + collStats['totalIndexSize'];
            
            // Compute deltas (rates per second)
            var sizeDelta = Math.floor((inCache - collInfo.inCache) / config.reportTime);
            var readDiff = Math.floor((cacheRead - collInfo.cacheRead) / config.reportTime);
            var writeDiff = Math.floor((cacheWrite - collInfo.cacheWrite) / config.reportTime);
            var pageUseDiff = Math.floor((pagesUsed - collInfo.pagesUsed) / config.reportTime);

            if(collSize >= config.minSizeThreshold) {
                var cachePercent = collSize > 0 ? Math.floor((inCache / collSize) * 100) : 0;
                
                var collectionData = {
                    db: collInfo.db,
                    collection: collInfo.coll,
                    fullName: collInfo.fullName,
                    size: collSize,
                    cached: inCache,
                    cachePercent: cachePercent,
                    sizeDelta: sizeDelta,
                    readRate: readDiff,
                    writeRate: writeDiff,
                    pagesUsed: pagesUsed,
                    pagesDelta: pageUseDiff,
                    isNewCollection: collInfo.isNew || false,
                    statistics: {
                        storageSize: collStats["storageSize"] || 0,
                        count: collStats["count"] || 0,
                        avgObjSize: collStats["avgObjSize"] || 0,
                        totalIndexSize: collStats["totalIndexSize"] || 0,
                        indexCount: collStats["nindexes"] || 0
                    },
                    indexes: []
                };

                // Accumulate totals
                totalSize += collSize;
                totalCached += inCache;
                totalReadRate += readDiff;
                totalWriteRate += writeDiff;

                // Process indexes if enabled
                // Build index info directly from collStats.indexDetails (no separate getIndexes call needed)
                if (config.showIndexes && collStats.indexDetails) {
                    // Build a lookup of previous index stats for delta computation
                    var prevIndexMap = {};
                    for(var pi = 0; pi < collInfo.indexesInfo.length; pi++) {
                        prevIndexMap[collInfo.indexesInfo[pi].name] = collInfo.indexesInfo[pi];
                    }

                    var newIndexesInfo = [];
                    for(var nameIndex in collStats.indexDetails) {
                        if (!collStats.indexDetails.hasOwnProperty(nameIndex)) continue;
                        var indexStats = collStats.indexDetails[nameIndex];
                        if (!indexStats || !indexStats["cache"]) continue;

                        var indexInCache = Math.floor(indexStats["cache"]["bytes currently in the cache"] / mb);
                        var indexCacheRead = Math.floor(indexStats["cache"]["bytes read into cache"] / mb);
                        var indexCacheWrite = Math.floor(indexStats["cache"]["bytes written from cache"] / mb);
                        var indexPagesUsed = Math.floor(indexStats["cache"]["pages requested from the cache"]);
                        var indexSize = (collStats.indexSizes && collStats.indexSizes[nameIndex]) ? collStats.indexSizes[nameIndex] : 0;

                        var prevIndex = prevIndexMap[nameIndex];
                        var indexSizeDiff = prevIndex ? Math.floor((indexInCache - prevIndex.inCache) / config.reportTime) : 0;
                        var indexReadDiff = prevIndex ? Math.floor((indexCacheRead - prevIndex.cacheRead) / config.reportTime) : 0;
                        var indexWriteDiff = prevIndex ? Math.floor((indexCacheWrite - prevIndex.cacheWrite) / config.reportTime) : 0;
                        var indexPageUseDiff = prevIndex ? Math.floor((indexPagesUsed - prevIndex.pagesUsed) / config.reportTime) : 0;

                        // Store for next iteration
                        newIndexesInfo.push({
                            name: nameIndex,
                            inCache: indexInCache,
                            cacheRead: indexCacheRead,
                            cacheWrite: indexCacheWrite,
                            pagesUsed: indexPagesUsed
                        });

                        if(indexSize > 0) {
                            var indexCachePercent = Math.floor((indexInCache / indexSize) * 100);
                            
                            collectionData.indexes.push({
                                name: nameIndex,
                                size: indexSize,
                                cached: indexInCache,
                                cachePercent: indexCachePercent,
                                sizeDelta: indexSizeDiff,
                                readRate: indexReadDiff,
                                writeRate: indexWriteDiff,
                                pagesUsed: indexPagesUsed,
                                pagesDelta: indexPageUseDiff,
                                statistics: {
                                    accesses: indexStats["cache"]["pages requested from the cache"] || 0,
                                    bytesReadIntoCache: indexStats["cache"]["bytes read into cache"] || 0,
                                    bytesWrittenFromCache: indexStats["cache"]["bytes written from cache"] || 0
                                }
                            });
                        }
                    }

                    // Update stored index info for this collection
                    collectionInfos[c].indexesInfo = newIndexesInfo;
                }

                processedCollections.push(collectionData);
            }

            // Update collection stats and clear the "new" flag
            collectionInfos[c].inCache = inCache;
            collectionInfos[c].cacheRead = cacheRead;
            collectionInfos[c].cacheWrite = cacheWrite;
            collectionInfos[c].pagesUsed = pagesUsed;
            collectionInfos[c].isNew = false;
            
        } catch(e) {
            // Log error in JSON format but continue processing
            var errorData = {
                db: collInfo.db,
                collection: collInfo.coll,
                fullName: collInfo.fullName,
                error: e.toString(),
                timestamp: timestamp
            };
            
            if (!outputData.errors) {
                outputData.errors = [];
            }
            outputData.errors.push(errorData);
            continue;
        }
    }

    // Sort collections by cached size (descending) and limit if maxCollections is set
    if (config.maxCollections > 0) {
        processedCollections.sort(function(a, b) {
            return b.cached - a.cached; // Sort by cached size descending
        });
        
        // Limit to top N collections
        var limitedCollections = processedCollections.slice(0, config.maxCollections);
        outputData.collections = limitedCollections;
        
        debugLog("Limited output to top " + config.maxCollections + " collections by cached size");
    } else {
        // Include all collections if maxCollections is -1 or 0
        outputData.collections = processedCollections;
    }

    // Calculate summary statistics
    var avgCachePercent = totalSize > 0 ? Math.floor((totalCached / totalSize) * 100) : 0;
    
    outputData.summary = {
        totalCollections: processedCollections.length, // Total collections processed
        outputCollections: outputData.collections.length, // Collections actually included in output
        totalSize: totalSize,
        totalCached: totalCached,
        avgCachePercent: avgCachePercent,
        totalDatabases: discoveryStats.databases,
        totalReadRate: totalReadRate,
        totalWriteRate: totalWriteRate,
        collectionDiscovery: {
            totalDiscovered: collectionInfos.length,
            lastRefreshIteration: lastCollectionRefresh,
            refreshInterval: config.refreshCollectionsEvery,
            newCollectionsFound: shouldRefreshCollections ? discoveryStats.newCollections : 0,
            collectionsRemoved: shouldRefreshCollections ? discoveryStats.removedCollections : 0,
            newCollectionNames: shouldRefreshCollections ? discoveryStats.newCollectionNames : [],
            removedCollectionNames: shouldRefreshCollections ? discoveryStats.removedCollectionNames : []
        },
        performance: {
            cacheMissRatio: totalSize > 0 ? Math.floor(((totalSize - totalCached) / totalSize) * 100) : 0,
            cacheHitRatio: avgCachePercent,
            memoryEfficiency: totalCached > 0 ? Math.floor((totalReadRate / totalCached) * 100) : 0
        },
        indexSummary: {
            totalIndexes: outputData.collections.reduce(function(sum, coll) { return sum + coll.indexes.length; }, 0),
            cachedIndexes: outputData.collections.reduce(function(sum, coll) { 
                return sum + coll.indexes.filter(function(idx) { return idx.cached > 0; }).length; 
            }, 0)
        }
    };

    // Add system information (single serverStatus call to avoid redundant round-trips)
    var srvStatus = db.serverStatus();
    var cacheConfig = srvStatus.wiredTiger.cache['maximum bytes configured'];
    // Handle MongoDB Long object
    if (typeof cacheConfig === 'object' && cacheConfig.hasOwnProperty('low')) {
        if (cacheConfig.high === 0) {
            cacheConfig = cacheConfig.low >= 0 ? cacheConfig.low : (Math.pow(2, 32) + cacheConfig.low);
        } else {
            cacheConfig = cacheConfig.high * Math.pow(2, 32) + (cacheConfig.low >= 0 ? cacheConfig.low : (Math.pow(2, 32) + cacheConfig.low));
        }
    }

    outputData.system = {
        mongoVersion: db.version(),
        hostInfo: db.hostInfo().system,
        serverStatus: {
            connections: srvStatus.connections,
            memory: srvStatus.mem,
            bytes_currently_in_cache: srvStatus.wiredTiger.cache['bytes currently in the cache'],
            bytes_allocated_for_updates: srvStatus.wiredTiger.cache['bytes allocated for updates'],
            uptime: srvStatus.uptime
        },
        wiredTigerCache: cacheConfig
    };

    // Add iteration timing information
    var iterationEndTime = new Date();
    var iterationDuration = (iterationEndTime - iterationStartTime) / 1000; // seconds
    outputData.metadata.iterationDuration = iterationDuration;
    outputData.metadata.iterationEndTime = iterationEndTime.toISOString();

    // Output the JSON data (clean JSON only, no comments)
    writeJsonOutput(outputData);

    iterationCount++;
    
    // Exit if this is a single run (maxIterations = 1)
    if (maxIterations === 1) {
        break;
    }
    
    // Sleep for the specified time (in milliseconds)
    sleep(config.reportTime * 1000);
}

/*
MongoDB Cache Monitor - Dynamic Collection Discovery (JSON Output)

Produces clean JSON output suitable for data-bridge processing.

Configuration Options (override via --eval "var config = {...};"):
- reportTime: Interval between data collections in seconds (default: 600 = 10 minutes)
- showIndexes: Include detailed index statistics (default: true)
- minSizeThreshold: Minimum collection size to include in MB (default: 0)
- maxIterations: Number of iterations to run (default: -1 = infinite)
- refreshCollectionsEvery: Refresh collection list every N iterations (default: 10)
- maxCollections: Top N collections by cached size to output (default: 20, -1 for all)
- debug: Include debug info in JSON metadata (default: false)

Usage Examples:
1. Single snapshot:
   mongosh --quiet "connection-string" --eval "var config = {maxIterations: 1};" cacheview_json.js

2. Limited iterations for testing:
   mongosh --quiet "connection-string" --eval "var config = {maxIterations: 5, reportTime: 10};" cacheview_json.js

3. Monitor with frequent collection discovery:
   mongosh --quiet "connection-string" --eval "var config = {refreshCollectionsEvery: 1};" cacheview_json.js

4. Top 10 collections by cached size:
   mongosh --quiet "connection-string" --eval "var config = {maxCollections: 10};" cacheview_json.js

5. All collections (disable limiting):
   mongosh --quiet "connection-string" --eval "var config = {maxCollections: -1};" cacheview_json.js

6. Pipe to data-bridge:
   mongosh --quiet "connection-string" cacheview_json.js | node data-bridge.js

7. File watching with data-bridge:
   mongosh --quiet "connection-string" cacheview_json.js > cache_output.json &
   node data-bridge.js --watch-file cache_output.json --port 8080

8. Custom settings for production:
   mongosh --quiet "connection-string" --eval "var config = {reportTime: 300, refreshCollectionsEvery: 5, minSizeThreshold: 50, maxCollections: 25};" cacheview_json.js
*/