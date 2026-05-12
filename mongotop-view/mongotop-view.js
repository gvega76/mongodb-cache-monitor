#!/usr/bin/env node

/**
 * MongoDB mongotop JSON Viewer
 * Loads newline-delimited mongotop output and serves a lightweight dashboard.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_PORT = 8090;
const MS_TO_MINUTES = 60000;
const DEFAULT_TIMEZONE = 'America/New_York';
const TIMEZONE_ALIASES = {
    est: 'America/New_York',
    edt: 'America/New_York',
    pst: 'America/Los_Angeles',
    pdt: 'America/Los_Angeles',
    cst: 'America/Chicago',
    cdt: 'America/Chicago',
    mst: 'America/Denver',
    mdt: 'America/Denver',
    utc: 'UTC',
    gmt: 'Etc/UTC'
};

/** @typedef {{time:number,count:number}} MetricPair */
/**
 * @typedef {Object} NamespaceMetric
 * @property {string} namespace
 * @property {string} db
 * @property {string} collection
 * @property {{time:number,count:number}} total
 * @property {{time:number,count:number}} read
 * @property {{time:number,count:number}} write
 */

/**
 * @typedef {Object} Snapshot
 * @property {string} id
 * @property {string} timestamp
 * @property {NamespaceMetric[]} metrics
 * @property {{
 *   totalNamespaces:number,
 *   totalTime:number,
 *   totalCount:number,
 *   readTime:number,
 *   writeTime:number,
 *   readCount:number,
 *   writeCount:number,
 *   busiest:NamespaceMetric[]
 * }} summary
 */

let snapshots = /** @type {Snapshot[]} */ ([]);
let namespaceRollup = [];
let sourceFile = '';
let namespaceLimit = 5;
let serverInstance;
let displayTimeZone = DEFAULT_TIMEZONE;
let collectionMetadata = new Map();
let metaSourceFile = '';
let spanGapsEnabled = true;
let configuredIntervalSeconds = null;
let inferredIntervalSeconds = null;

const DASHBOARD_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>mongotop JSON Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .header {
            background: linear-gradient(135deg, #00b4d8 0%, #0077b6 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
        }
        .stat-card {
            background: white;
            padding: 15px;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .stat-card h3 {
            margin: 0;
            font-size: 0.9em;
            color: #6c757d;
        }
        .stat-card p {
            margin: 5px 0 0;
            font-size: 1.6em;
            font-weight: bold;
            color: #0077b6;
        }
        .charts {
            display: flex;
            flex-direction: column;
            gap: 20px;
            margin-bottom: 20px;
        }
        .chart-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            min-height: 420px;
        }
        .chart-card canvas,
        .chart-card img {
            width: 100%;
            height: 360px;
            max-height: 360px;
            min-height: 240px;
            object-fit: contain;
            display: block;
        }

        /* Fix for drilldown charts: prevent dynamic height growth */
        .charts .chart-card {
            max-height: 440px;
            min-height: 320px;
            overflow: hidden;
        }
        .table-card {
            background: white;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            overflow: hidden;
        }
        .table-controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
            padding: 12px 15px;
            background: #f8f9fa;
            border-bottom: 1px solid #e9ecef;
        }
        .playback-buttons {
            display: flex;
            gap: 8px;
        }
        .playback-buttons button {
            padding: 6px 10px;
            border: 1px solid #ced4da;
            background: white;
            border-radius: 6px;
            cursor: pointer;
            min-width: 42px;
        }
        .playback-buttons button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #playbackStatus {
            font-size: 0.9em;
            color: #495057;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 10px 12px;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
        }
        th {
            background: #f8f9fa;
            font-size: 0.9em;
            color: #495057;
        }
        tr:hover {
            background: #f1f3f5;
        }
        .ns-cell {
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .selected-row {
            background: #e7f5ff;
        }
        .notes-card {
            background: #e9f7ff;
            border-left: 4px solid #0077b6;
            padding: 12px 14px;
            border-radius: 8px;
            margin: 16px 0;
            color: #1f2933;
            font-size: 0.92em;
            line-height: 1.45;
        }
        .timestamp {
            color: rgba(255, 255, 255, 0.8);
            font-size: 0.9em;
        }
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 999px;
            font-size: 0.85em;
        }
        @media (max-width: 768px) {
            .header {
                align-items: flex-start;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
            <h1 style="margin: 0;">mongotop JSON Dashboard</h1>
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                <span id="snapshotCount" class="badge">Snapshots: 0</span>
                <span id="fileInfo" class="badge">Loading file info...</span>
            </div>
        </div>
        <div class="timestamp" id="lastUpdated">Last snapshot: --</div>
    </div>

    <div class="stats">
        <div class="stat-card">
            <h3>Total Namespaces</h3>
            <p id="totalNamespaces">0</p>
        </div>
        <div class="stat-card">
            <h3>Total Ops/sec</h3>
            <p id="totalOpsPerSec">0</p>
        </div>
        <div class="stat-card">
            <h3>Total Active sec/sec</h3>
            <p id="totalActivePerSec">0</p>
        </div>
        <div class="stat-card">
            <h3>Hottest Namespace (Active / Ops)</h3>
            <p id="hottestNamespace" style="font-size: 1em; line-height: 1.3;">--</p>
        </div>
    </div>

    <div class="notes-card" title="mongotop time is accumulated operation execution time for the interval; it is not wall-clock elapsed time and not CPU time.">
        <strong>Metric semantics:</strong> mongotop time is accumulated operation time during the interval. It is not wall-clock elapsed time and not CPU time. Values above 1 in <strong>Active sec/sec</strong> are expected when operations overlap.
    </div>

    <div class="table-card">
        <div class="table-controls">
            <div class="playback-buttons">
                <button id="btnFirst" title="First snapshot">⏮</button>
                <button id="btnPrev" title="Previous snapshot">◀</button>
                <button id="btnPlay" title="Play">▶</button>
                <button id="btnNext" title="Next snapshot">▶</button>
                <button id="btnLast" title="Last snapshot">⏭</button>
            </div>
            <span id="playbackStatus">Snapshot: -- / --</span>
        </div>
        <table>
            <thead>
                <tr>
                    <th>Namespace</th>
                    <th>Ops/sec (R/W)</th>
                    <th>Active sec/sec</th>
                    <th>Avg ms/op</th>
                    <th>Total Count</th>
                    <th>Total ms</th>
                    <th>Read/Write Mix (Ops %)</th>
                </tr>
            </thead>
            <tbody id="namespaceTableBody">
                <tr><td colspan="7">No data loaded</td></tr>
            </tbody>
        </table>
    </div>

    <div class="table-card" id="sizeTableCard" style="margin-top: 20px; display: none;">
        <div class="table-controls">
            <span id="sizeTableTitle">Collection Size Details</span>
            <span id="sizeMetaDescriptor" style="font-size: 0.85em; color: #6c757d;">Metadata not loaded</span>
        </div>
        <table>
            <thead>
                <tr>
                    <th>Namespace</th>
                    <th>Data Size (GB)</th>
                    <th>Storage Size (GB)</th>
                    <th>Total Index Size (GB)</th>
                </tr>
            </thead>
            <tbody id="namespaceSizeTableBody">
                <tr><td colspan="4">No metadata available</td></tr>
            </tbody>
        </table>
    </div>

    <div class="charts" style="margin-top: 25px;">
        <div class="chart-card">
            <h3>Global Ops/sec and Active sec/sec</h3>
            <canvas id="totalTimeChart"></canvas>
        </div>
        <div class="chart-card">
            <h3>Top Namespaces Ops/sec over Time</h3>
            <canvas id="topNamespacesChart"></canvas>
        </div>
        <div class="chart-card">
            <h3>Top Namespaces Active sec/sec over Time</h3>
            <canvas id="topNamespacesReadChart"></canvas>
        </div>
        <div class="chart-card">
            <h3>Top Namespaces Avg ms/op over Time</h3>
            <canvas id="topNamespacesWriteChart"></canvas>
        </div>
    </div>

    <div class="charts" style="margin-top: 25px;">
        <div class="chart-card">
            <h3>Namespace Drilldown: Ops/sec (Total / Read / Write)</h3>
            <div id="drilldownNamespaceLabel" style="font-size: 0.9em; color: #495057; margin-bottom: 8px;">Select a namespace from the table.</div>
            <canvas id="namespaceOpsDrilldownChart"></canvas>
        </div>
        <div class="chart-card">
            <h3>Namespace Drilldown: Active sec/sec (Total / Read / Write)</h3>
            <canvas id="namespaceActiveDrilldownChart"></canvas>
        </div>
        <div class="chart-card">
            <h3>Namespace Drilldown: Avg ms/op (Total / Read / Write)</h3>
            <canvas id="namespaceAvgMsDrilldownChart"></canvas>
        </div>
    </div>

    <div class="table-card" style="margin-top: 20px;">
        <div class="table-controls">
            <span id="intervalDetailTitle">Interval Detail</span>
            <span id="intervalDetailHint" style="font-size: 0.85em; color: #6c757d;">Select a namespace and snapshot</span>
        </div>
        <table>
            <thead>
                <tr>
                    <th>Field</th>
                    <th>Value</th>
                </tr>
            </thead>
            <tbody id="intervalDetailBody">
                <tr><td colspan="2">No namespace selected</td></tr>
            </tbody>
        </table>
    </div>

    <script>
        const namespaceTableBody = document.getElementById('namespaceTableBody');
        const totalNamespacesEl = document.getElementById('totalNamespaces');
        const totalOpsPerSecEl = document.getElementById('totalOpsPerSec');
        const totalActivePerSecEl = document.getElementById('totalActivePerSec');
        const hottestNamespaceEl = document.getElementById('hottestNamespace');
        const lastUpdatedEl = document.getElementById('lastUpdated');
        const snapshotCountEl = document.getElementById('snapshotCount');
        const fileInfoEl = document.getElementById('fileInfo');
        const btnFirst = document.getElementById('btnFirst');
        const btnPrev = document.getElementById('btnPrev');
        const btnPlay = document.getElementById('btnPlay');
        const btnNext = document.getElementById('btnNext');
        const btnLast = document.getElementById('btnLast');
        const playbackStatusEl = document.getElementById('playbackStatus');
        const sizeTableBody = document.getElementById('namespaceSizeTableBody');
        const sizeTableTitleEl = document.getElementById('sizeTableTitle');
        const sizeMetaDescriptorEl = document.getElementById('sizeMetaDescriptor');
        const sizeTableCard = document.getElementById('sizeTableCard');
        const drilldownNamespaceLabelEl = document.getElementById('drilldownNamespaceLabel');
        const intervalDetailTitleEl = document.getElementById('intervalDetailTitle');
        const intervalDetailHintEl = document.getElementById('intervalDetailHint');
        const intervalDetailBodyEl = document.getElementById('intervalDetailBody');

        let totalTimeChart;
        let topNamespacesChart;
        let topNamespacesReadChart;
        let topNamespacesWriteChart;
        let namespaceOpsDrilldownChart;
        let namespaceActiveDrilldownChart;
        let namespaceAvgMsDrilldownChart;
        let chartsFrozen = false;
        let snapshotsCache = [];
        let namespaceLimitSetting = 0;
        let timeZoneSetting = '${DEFAULT_TIMEZONE}';
        let spanGapsSetting = true;
        let intervalSecondsSetting = null;
        let selectedNamespace = null;
        let playbackIndex = 0;
        let playbackTimer = null;
        let isPlaying = false;
        const PLAY_INTERVAL = 2000;
        const namespacePalette = [
            { border: '#ef476f', background: 'rgba(239, 71, 111, 0.18)' },
            { border: '#ffd166', background: 'rgba(255, 209, 102, 0.18)' },
            { border: '#06d6a0', background: 'rgba(6, 214, 160, 0.18)' },
            { border: '#118ab2', background: 'rgba(17, 138, 178, 0.18)' },
            { border: '#073b4c', background: 'rgba(7, 59, 76, 0.18)' },
            { border: '#8338ec', background: 'rgba(131, 56, 236, 0.18)' },
            { border: '#ff006e', background: 'rgba(255, 0, 110, 0.18)' },
            { border: '#fb5607', background: 'rgba(251, 86, 7, 0.18)' },
            { border: '#43aa8b', background: 'rgba(67, 170, 139, 0.18)' },
            { border: '#577590', background: 'rgba(87, 117, 144, 0.18)' }
        ];
        const MAX_POINTS = 160;

        function buildIndexSample(length, maxPoints) {
            if (length <= maxPoints) {
                const idx = [];
                for (let i = 0; i < length; i += 1) {
                    idx.push(i);
                }
                return idx;
            }
            const step = Math.ceil(length / maxPoints);
            const result = [];
            for (let i = 0; i < length; i += step) {
                result.push(i);
            }
            if (result[result.length - 1] !== length - 1) {
                result.push(length - 1);
            }
            return result;
        }

        function selectByIndices(list, indices) {
            return indices.map(function(i) { return list[i]; });
        }

        function buildLogScale(values) {
            const positives = values.filter(function(v) { return typeof v === 'number' && v > 0; });
            if (!positives.length) {
                return {
                    type: 'logarithmic',
                    beginAtZero: false,
                    ticks: {
                        callback: function(value) {
                            return Number(value).toLocaleString();
                        }
                    }
                };
            }

            const minVal = Math.min.apply(null, positives);
            const maxVal = Math.max.apply(null, positives);
            const min = Math.max(minVal * 0.8, 1e-6);
            const max = maxVal * 1.2;

            return {
                type: 'logarithmic',
                beginAtZero: false,
                min,
                max,
                ticks: {
                    callback: function(value) {
                        return Number(value).toLocaleString();
                    }
                }
            };
        }

        async function fetchJson(path) {
            const response = await fetch(path);
            if (!response.ok) {
                throw new Error('Request failed: ' + response.status);
            }
            return response.json();
        }

        function formatCount(value) {
            return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
        }

        function formatMinutes(value) {
            return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        }

        function formatRate(value) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '—';
            }
            return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        }

        function formatNullableNumber(value, maxFractionDigits) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '—';
            }
            return value.toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: maxFractionDigits
            });
        }

        function formatSizeValue(value) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '—';
            }
            const absValue = Math.abs(value);
            let fractionDigits;
            if (absValue >= 1000) {
                fractionDigits = 0;
            } else if (absValue >= 100) {
                fractionDigits = 1;
            } else if (absValue >= 1) {
                fractionDigits = 2;
            } else {
                fractionDigits = 4;
            }
            return value.toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: fractionDigits
            });
        }

        function formatWithTimeZone(timestamp, options) {
            if (!timestamp) {
                return '--';
            }
            const date = new Date(timestamp);
            if (Number.isNaN(date.getTime())) {
                return '--';
            }
            try {
                const formatOptions = Object.assign({ timeZone: timeZoneSetting }, options || {});
                return new Intl.DateTimeFormat(undefined, formatOptions).format(date);
            } catch (error) {
                return date.toLocaleString();
            }
        }

        function formatDateTime(timestamp) {
            return formatWithTimeZone(timestamp, {
                year: 'numeric',
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        }

        function formatTime(timestamp) {
            return formatWithTimeZone(timestamp, {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        }

        function calculateAverageInterval(allSnapshots) {
            if (!Array.isArray(allSnapshots) || allSnapshots.length < 2) {
                return null;
            }
            let totalMinutes = 0;
            let samples = 0;

            for (let i = 1; i < allSnapshots.length; i += 1) {
                const prev = new Date(allSnapshots[i - 1].timestamp).getTime();
                const current = new Date(allSnapshots[i].timestamp).getTime();
                if (!Number.isFinite(prev) || !Number.isFinite(current) || current <= prev) {
                    continue;
                }
                totalMinutes += (current - prev) / 60000;
                samples += 1;
            }

            if (samples === 0) {
                return null;
            }

            return totalMinutes / samples;
        }

        function calculateSpanHours(allSnapshots) {
            if (!Array.isArray(allSnapshots) || allSnapshots.length < 2) {
                return null;
            }
            const first = new Date(allSnapshots[0].timestamp).getTime();
            const last = new Date(allSnapshots[allSnapshots.length - 1].timestamp).getTime();
            if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) {
                return null;
            }
            return (last - first) / 3600000;
        }

        function formatDurationBetween(startTimestamp, endTimestamp) {
            const startMs = new Date(startTimestamp).getTime();
            const endMs = new Date(endTimestamp).getTime();
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
                return '--';
            }
            let remainingSeconds = Math.floor((endMs - startMs) / 1000);
            const days = Math.floor(remainingSeconds / 86400);
            remainingSeconds -= days * 86400;
            const hours = Math.floor(remainingSeconds / 3600);
            remainingSeconds -= hours * 3600;
            const minutes = Math.floor(remainingSeconds / 60);
            const seconds = remainingSeconds - (minutes * 60);

            const parts = [];
            if (days > 0) {
                parts.push(days + 'd');
            }
            if (hours > 0 || days > 0) {
                parts.push(hours + 'h');
            }
            if (minutes > 0 || hours > 0 || days > 0) {
                parts.push(minutes + 'm');
            }
            parts.push(seconds + 's');
            return parts.join(' ');
        }

        function renderSummary(snapshot, allSnapshots) {
            if (!snapshot) {
                totalNamespacesEl.textContent = '0';
                totalOpsPerSecEl.textContent = '0';
                totalActivePerSecEl.textContent = '0';
                hottestNamespaceEl.textContent = '--';
                lastUpdatedEl.textContent = 'First snapshot (' + timeZoneSetting + '): -- | Last snapshot (' + timeZoneSetting + '): -- | Span: --';
                snapshotCountEl.textContent = 'Snapshots: 0';
                return;
            }

            const summary = snapshot.summary;
            const summaryDerived = summary.derived || {};
            totalNamespacesEl.textContent = formatCount(summary.totalNamespaces);
            totalOpsPerSecEl.textContent = formatRate(summaryDerived.opsPerSec);
            totalActivePerSecEl.textContent = formatRate(summaryDerived.activeSecPerSec);

            const hottest = (snapshot.metrics || []).slice().sort((a, b) => {
                const aActive = typeof a.derived?.activeSecPerSec === 'number' ? a.derived.activeSecPerSec : -Infinity;
                const bActive = typeof b.derived?.activeSecPerSec === 'number' ? b.derived.activeSecPerSec : -Infinity;
                if (bActive !== aActive) {
                    return bActive - aActive;
                }
                const aOps = typeof a.derived?.opsPerSec === 'number' ? a.derived.opsPerSec : -Infinity;
                const bOps = typeof b.derived?.opsPerSec === 'number' ? b.derived.opsPerSec : -Infinity;
                return bOps - aOps;
            })[0] || null;

            if (hottest) {
                hottestNamespaceEl.textContent = hottest.namespace + ' (' +
                    formatRate(hottest.derived?.activeSecPerSec) + ' / ' +
                    formatRate(hottest.derived?.opsPerSec) + ')';
                hottestNamespaceEl.title = hottest.namespace;
            } else {
                hottestNamespaceEl.textContent = '--';
                hottestNamespaceEl.title = '';
            }

            const firstSnapshot = allSnapshots && allSnapshots.length ? allSnapshots[0] : null;
            const lastSnapshot = allSnapshots && allSnapshots.length ? allSnapshots[allSnapshots.length - 1] : null;
            const firstText = firstSnapshot ? formatDateTime(firstSnapshot.timestamp) : '--';
            const lastText = lastSnapshot ? formatDateTime(lastSnapshot.timestamp) : '--';
            const spanHours = calculateSpanHours(allSnapshots);
            const spanText = (firstSnapshot && lastSnapshot)
                ? formatDurationBetween(firstSnapshot.timestamp, lastSnapshot.timestamp)
                : '--';
            const spanHoursText = (typeof spanHours === 'number' && Number.isFinite(spanHours))
                ? spanHours.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + 'h'
                : '--';
            lastUpdatedEl.textContent =
                'First snapshot (' + timeZoneSetting + '): ' + firstText +
                ' | Last snapshot (' + timeZoneSetting + '): ' + lastText +
                ' | Span: ' + spanText + ' (' + spanHoursText + ')';
            // Only show count and span, not interval
            let spanSuffix = '';
            if (spanHours !== null) {
                spanSuffix = ', span ' + spanHours.toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2
                }) + ' hours';
            }
            snapshotCountEl.textContent = 'Snapshots: ' + formatCount(allSnapshots.length) + spanSuffix;
        }

        function renderTable(snapshot, tableLimit) {
            if (!snapshot || !snapshot.metrics.length) {
                namespaceTableBody.innerHTML = '<tr><td colspan="7">No namespace metrics available</td></tr>';
                return;
            }

            const sourceMetrics = (snapshot.metrics || []).slice().sort((a, b) => {
                const aActive = typeof a.derived?.activeSecPerSec === 'number' ? a.derived.activeSecPerSec : -Infinity;
                const bActive = typeof b.derived?.activeSecPerSec === 'number' ? b.derived.activeSecPerSec : -Infinity;
                if (bActive !== aActive) {
                    return bActive - aActive;
                }
                const aOps = typeof a.derived?.opsPerSec === 'number' ? a.derived.opsPerSec : -Infinity;
                const bOps = typeof b.derived?.opsPerSec === 'number' ? b.derived.opsPerSec : -Infinity;
                return bOps - aOps;
            });
            const limit = tableLimit > 0 ? Math.min(sourceMetrics.length, tableLimit) : sourceMetrics.length;

            const rows = sourceMetrics
                .slice(0, limit)
                .map(metric => {
                    const totalCount = Number(metric.total?.count ?? 0);
                    const readCount = Number(metric.read?.count ?? 0);
                    const writeCount = Number(metric.write?.count ?? 0);
                    const readPct = totalCount > 0 ? (readCount / totalCount) * 100 : null;
                    const writePct = totalCount > 0 ? (writeCount / totalCount) * 100 : null;

                    return (
                        '<tr data-namespace="' + metric.namespace + '"' + (selectedNamespace === metric.namespace ? ' class="selected-row"' : '') + '>' +
                            '<td class="ns-cell" title="' + metric.namespace + '">' + metric.namespace + '</td>' +
                            '<td>' +
                                formatRate(metric.derived?.opsPerSec) +
                                ' (' + formatRate(metric.derived?.readOpsPerSec) + ' / ' + formatRate(metric.derived?.writeOpsPerSec) + ')' +
                            '</td>' +
                            '<td>' + formatRate(metric.derived?.activeSecPerSec) + '</td>' +
                            '<td>' + formatNullableNumber(metric.derived?.avgMsPerOp, 2) + '</td>' +
                            '<td>' + formatCount(totalCount) + '</td>' +
                            '<td>' + formatCount(Number(metric.total?.ms ?? 0)) + '</td>' +
                            '<td>' + formatNullableNumber(readPct, 1) + '% / ' + formatNullableNumber(writePct, 1) + '%</td>' +
                        '</tr>'
                    );
                })
                .join('');

            namespaceTableBody.innerHTML = rows;
            const rowNodes = namespaceTableBody.querySelectorAll('tr[data-namespace]');
            rowNodes.forEach(function(row) {
                row.addEventListener('click', function() {
                    selectedNamespace = row.getAttribute('data-namespace');
                    renderTable(snapshot, tableLimit);
                    renderNamespaceDrilldown(selectedNamespace);
                    renderIntervalDetail(selectedNamespace, snapshot);
                });
            });
        }

        function ensureDrilldownChart(chartRef, ctx, labelSuffix) {
            if (chartRef) {
                return chartRef;
            }
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        tooltip: {
                            callbacks: {
                                label: function(ctxObj) {
                                    const value = (ctxObj.parsed && typeof ctxObj.parsed.y === 'number')
                                        ? ctxObj.parsed.y.toLocaleString(undefined, { maximumFractionDigits: 2 })
                                        : '0';
                                    return ctxObj.dataset.label + ': ' + value + labelSuffix;
                                }
                            }
                        },
                        zoom: false
                    },
                    pan: { enabled: false }
                }
            });
        }

        function buildDrilldownSeries(namespace, mapper, options) {
            const labels = snapshotsCache.map(function(snap) { return snap.timestamp; });
            const labelIndices = buildIndexSample(labels.length, MAX_POINTS);
            const sampledLabels = selectByIndices(labels, labelIndices).map(formatTime);
            const points = snapshotsCache.map(function(snap) {
                const metric = (snap.metrics || []).find(function(item) { return item.namespace === namespace; });
                if (!metric) {
                    return null;
                }
                return mapper(metric);
            });
            const sampledPoints = selectByIndices(points, labelIndices).map(function(point) {
                if (!point) {
                    return point;
                }
                return {
                    total: point.total,
                    read: point.read,
                    write: point.write
                };
            });

            const mapField = function(field) {
                return sampledPoints.map(function(point) {
                    if (!point || typeof point[field] !== 'number' || point[field] <= 0) {
                        return null;
                    }
                    return point[field];
                });
            };

            const total = mapField('total');
            const read = mapField('read');
            const write = mapField('write');

            return {
                labels: sampledLabels,
                datasets: [
                    {
                        label: 'Total',
                        data: total,
                        borderColor: '#0077b6',
                        backgroundColor: 'rgba(0, 119, 182, 0.15)',
                        pointRadius: 2,
                        tension: 0.2,
                        spanGaps: options.spanGaps
                    },
                    {
                        label: 'Read',
                        data: read,
                        borderColor: '#06d6a0',
                        backgroundColor: 'rgba(6, 214, 160, 0.15)',
                        pointRadius: 2,
                        tension: 0.2,
                        spanGaps: options.spanGaps
                    },
                    {
                        label: 'Write',
                        data: write,
                        borderColor: '#ef476f',
                        backgroundColor: 'rgba(239, 71, 111, 0.15)',
                        pointRadius: 2,
                        tension: 0.2,
                        spanGaps: options.spanGaps
                    }
                ],
                yValues: total.concat(read, write)
            };
        }

        function renderNamespaceDrilldown(namespace) {
            const opsCtx = document.getElementById('namespaceOpsDrilldownChart').getContext('2d');
            const activeCtx = document.getElementById('namespaceActiveDrilldownChart').getContext('2d');
            const avgCtx = document.getElementById('namespaceAvgMsDrilldownChart').getContext('2d');
            namespaceOpsDrilldownChart = ensureDrilldownChart(namespaceOpsDrilldownChart, opsCtx, '');
            namespaceActiveDrilldownChart = ensureDrilldownChart(namespaceActiveDrilldownChart, activeCtx, '');
            namespaceAvgMsDrilldownChart = ensureDrilldownChart(namespaceAvgMsDrilldownChart, avgCtx, ' ms/op');

            if (!namespace) {
                drilldownNamespaceLabelEl.textContent = 'Select a namespace from the table.';
                [namespaceOpsDrilldownChart, namespaceActiveDrilldownChart, namespaceAvgMsDrilldownChart].forEach(function(chart) {
                    chart.data.labels = [];
                    chart.data.datasets = [];
                    chart.update('none');
                });
                return;
            }

            drilldownNamespaceLabelEl.textContent = 'Namespace: ' + namespace;
            drilldownNamespaceLabelEl.title = namespace;

            const opsSeries = buildDrilldownSeries(namespace, function(metric) {
                return {
                    total: metric.derived?.opsPerSec,
                    read: metric.derived?.readOpsPerSec,
                    write: metric.derived?.writeOpsPerSec
                };
            }, { spanGaps: spanGapsSetting });

            const activeSeries = buildDrilldownSeries(namespace, function(metric) {
                return {
                    total: metric.derived?.activeSecPerSec,
                    read: metric.derived?.readActiveSecPerSec,
                    write: metric.derived?.writeActiveSecPerSec
                };
            }, { spanGaps: spanGapsSetting });

            const avgSeries = buildDrilldownSeries(namespace, function(metric) {
                const enoughTotal = Number(metric.total?.count ?? 0) >= 10;
                const enoughRead = Number(metric.read?.count ?? 0) >= 10;
                const enoughWrite = Number(metric.write?.count ?? 0) >= 10;
                return {
                    total: enoughTotal ? metric.derived?.avgMsPerOp : null,
                    read: enoughRead ? metric.derived?.readAvgMsPerOp : null,
                    write: enoughWrite ? metric.derived?.writeAvgMsPerOp : null
                };
            }, { spanGaps: spanGapsSetting });

            const updateDrilldownChart = function(chart, series) {
                chart.data.labels = series.labels;
                chart.data.datasets = series.datasets;
                chart.options.scales = {
                    y: buildLogScale(series.yValues),
                    x: {
                        ticks: {
                            autoSkip: true,
                            maxRotation: 0,
                            minRotation: 0,
                            maxTicksLimit: 48
                        }
                    }
                };
                chart.update('none');
            };

            updateDrilldownChart(namespaceOpsDrilldownChart, opsSeries);
            updateDrilldownChart(namespaceActiveDrilldownChart, activeSeries);
            updateDrilldownChart(namespaceAvgMsDrilldownChart, avgSeries);
        }

        function renderIntervalDetail(namespace, snapshot) {
            if (!namespace || !snapshot) {
                intervalDetailTitleEl.textContent = 'Interval Detail';
                intervalDetailHintEl.textContent = 'Select a namespace and snapshot';
                intervalDetailBodyEl.innerHTML = '<tr><td colspan="2">No namespace selected</td></tr>';
                return;
            }

            const metric = (snapshot.metrics || []).find(function(item) { return item.namespace === namespace; });
            intervalDetailTitleEl.textContent = 'Interval Detail: ' + namespace;
            intervalDetailHintEl.textContent = formatDateTime(snapshot.timestamp);

            if (!metric) {
                intervalDetailBodyEl.innerHTML = '<tr><td colspan="2">No data for this namespace at selected snapshot</td></tr>';
                return;
            }

            const rows = [
                ['total.time (ms)', formatCount(metric.total?.ms ?? 0)],
                ['total.count', formatCount(metric.total?.count ?? 0)],
                ['read.time (ms)', formatCount(metric.read?.ms ?? 0)],
                ['read.count', formatCount(metric.read?.count ?? 0)],
                ['write.time (ms)', formatCount(metric.write?.ms ?? 0)],
                ['write.count', formatCount(metric.write?.count ?? 0)],
                ['ops_per_sec', formatRate(metric.derived?.opsPerSec)],
                ['read_ops_per_sec', formatRate(metric.derived?.readOpsPerSec)],
                ['write_ops_per_sec', formatRate(metric.derived?.writeOpsPerSec)],
                ['active_sec_per_sec', formatRate(metric.derived?.activeSecPerSec)],
                ['read_active_sec_per_sec', formatRate(metric.derived?.readActiveSecPerSec)],
                ['write_active_sec_per_sec', formatRate(metric.derived?.writeActiveSecPerSec)],
                ['avg_ms_per_op', formatNullableNumber(metric.derived?.avgMsPerOp, 2)],
                ['read_avg_ms_per_op', formatNullableNumber(metric.derived?.readAvgMsPerOp, 2)],
                ['write_avg_ms_per_op', formatNullableNumber(metric.derived?.writeAvgMsPerOp, 2)]
            ];

            intervalDetailBodyEl.innerHTML = rows.map(function(row) {
                return '<tr><td>' + row[0] + '</td><td>' + row[1] + '</td></tr>';
            }).join('');
        }

        function renderSizeTable(sizeSummary) {
            if (sizeTableCard) {
                sizeTableCard.style.display = 'none';
            }
            if (sizeMetaDescriptorEl) {
                sizeMetaDescriptorEl.textContent = sizeSummary ? 'Metadata loaded' : 'Metadata not loaded';
            }

            if (!sizeSummary || !Array.isArray(sizeSummary.namespaces) || !sizeSummary.namespaces.length) {
                if (sizeTableTitleEl) {
                    sizeTableTitleEl.textContent = 'Collection Size Details';
                }
                if (sizeTableBody) {
                    sizeTableBody.innerHTML = '<tr><td colspan="4">No metadata available</td></tr>';
                }
                return;
            }

            const { limit, namespaces } = sizeSummary;
            const titleSuffix = limit > 0 ? ('Top ' + limit) : 'All namespaces';
            if (sizeTableTitleEl) {
                sizeTableTitleEl.textContent = 'Collection Size Details (' + titleSuffix + ')';
            }

            if (!sizeTableBody) {
                return;
            }

            if (sizeTableCard) {
                sizeTableCard.style.display = 'block';
            }

            const filtered = namespaces.filter(entry => !entry.namespace.startsWith('local.'));

            let totalData = 0;
            let totalStorage = 0;
            let totalIndex = 0;

            const rows = filtered.map(entry => {
                const dataSize = typeof entry.dataSize === 'number' ? entry.dataSize : null;
                const storageSize = typeof entry.storageSize === 'number' ? entry.storageSize : null;
                const indexSize = typeof entry.indexSize === 'number' ? entry.indexSize : null;

                if (dataSize !== null) {
                    totalData += dataSize;
                }
                if (storageSize !== null) {
                    totalStorage += storageSize;
                }
                if (indexSize !== null) {
                    totalIndex += indexSize;
                }

                return (
                    '<tr>' +
                        '<td>' + entry.namespace + '</td>' +
                        '<td>' + formatSizeValue(entry.dataSize) + '</td>' +
                        '<td>' + formatSizeValue(entry.storageSize) + '</td>' +
                        '<td>' + formatSizeValue(entry.indexSize) + '</td>' +
                    '</tr>'
                );
            }).join('');

            const totalRow = (
                '<tr>' +
                    '<th>Total</th>' +
                    '<th>' + formatSizeValue(totalData) + '</th>' +
                    '<th>' + formatSizeValue(totalStorage) + '</th>' +
                    '<th>' + formatSizeValue(totalIndex) + '</th>' +
                '</tr>'
            );

            if (!filtered.length) {
                sizeTableBody.innerHTML = '<tr><td colspan="4">No metadata available</td></tr>';
                return;
            }

            sizeTableBody.innerHTML = rows + totalRow;
        }

        function updatePlaybackStatus() {
            if (!snapshotsCache.length) {
                playbackStatusEl.textContent = 'Snapshot: -- / --';
                btnFirst.disabled = true;
                btnPrev.disabled = true;
                btnPlay.disabled = true;
                btnNext.disabled = true;
                btnLast.disabled = true;
                btnPlay.textContent = '▶';
                return;
            }

            playbackStatusEl.textContent = 'Snapshot: ' + (playbackIndex + 1) + ' / ' + snapshotsCache.length;
            btnFirst.disabled = playbackIndex === 0;
            btnPrev.disabled = playbackIndex === 0;
            btnNext.disabled = playbackIndex >= snapshotsCache.length - 1;
            btnLast.disabled = playbackIndex >= snapshotsCache.length - 1;
            btnPlay.disabled = snapshotsCache.length <= 1;
            btnPlay.textContent = isPlaying ? '⏸' : '▶';
        }

        function stopPlayback() {
            if (playbackTimer) {
                clearInterval(playbackTimer);
                playbackTimer = null;
            }
            isPlaying = false;
            updatePlaybackStatus();
        }

        function startPlayback() {
            if (isPlaying || snapshotsCache.length <= 1) {
                return;
            }
            isPlaying = true;
            updatePlaybackStatus();
            playbackTimer = setInterval(() => {
                if (playbackIndex >= snapshotsCache.length - 1) {
                    stopPlayback();
                    return;
                }
                showSnapshot(playbackIndex + 1);
            }, PLAY_INTERVAL);
        }

        function showSnapshot(index) {
            if (!snapshotsCache.length) {
                renderNamespaceDrilldown(null);
                renderIntervalDetail(null, null);
                return;
            }
            const clampedIndex = Math.max(0, Math.min(index, snapshotsCache.length - 1));
            playbackIndex = clampedIndex;
            const snapshot = snapshotsCache[playbackIndex];
            const snapshotNamespaces = new Set((snapshot.metrics || []).map(function(metric) { return metric.namespace; }));
            if (!selectedNamespace || !snapshotNamespaces.has(selectedNamespace)) {
                const candidate = (snapshot.metrics || []).slice().sort(function(a, b) {
                    const aActive = typeof a.derived?.activeSecPerSec === 'number' ? a.derived.activeSecPerSec : -Infinity;
                    const bActive = typeof b.derived?.activeSecPerSec === 'number' ? b.derived.activeSecPerSec : -Infinity;
                    if (bActive !== aActive) {
                        return bActive - aActive;
                    }
                    const aOps = typeof a.derived?.opsPerSec === 'number' ? a.derived.opsPerSec : -Infinity;
                    const bOps = typeof b.derived?.opsPerSec === 'number' ? b.derived.opsPerSec : -Infinity;
                    return bOps - aOps;
                })[0];
                selectedNamespace = candidate ? candidate.namespace : null;
            }
            renderSummary(snapshot, snapshotsCache);
            const tableLimit = namespaceLimitSetting > 0 ? namespaceLimitSetting : 0;
            renderTable(snapshot, tableLimit);
            renderNamespaceDrilldown(selectedNamespace);
            renderIntervalDetail(selectedNamespace, snapshot);
            updatePlaybackStatus();
        }

        function ensureCharts(ctxTotal, ctxTop, ctxRead, ctxWrite) {
            const buildOptions = function(maxFractionDigits) {
                return {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        tooltip: {
                            callbacks: {
                                label: function(ctx) {
                                    return ctx.dataset.label + ': ' + ((ctx.parsed && typeof ctx.parsed.y === 'number')
                                        ? ctx.parsed.y.toLocaleString(undefined, { maximumFractionDigits })
                                        : '0');
                                }
                            }
                        },
                        zoom: false
                    },
                    pan: { enabled: false }
                };
            };

            if (!totalTimeChart) {
                totalTimeChart = new Chart(ctxTotal, {
                    type: 'line',
                    data: { labels: [], datasets: [] },
                    options: buildOptions(2)
                });
            }
            if (!topNamespacesChart) {
                topNamespacesChart = new Chart(ctxTop, {
                    type: 'line',
                    data: { labels: [], datasets: [] },
                    options: buildOptions(2)
                });
            }
            if (ctxRead && !topNamespacesReadChart) {
                topNamespacesReadChart = new Chart(ctxRead, {
                    type: 'line',
                    data: { labels: [], datasets: [] },
                    options: buildOptions(2)
                });
            }
            if (ctxWrite && !topNamespacesWriteChart) {
                topNamespacesWriteChart = new Chart(ctxWrite, {
                    type: 'line',
                    data: { labels: [], datasets: [] },
                    options: buildOptions(2)
                });
            }
        }

        function freezeChart(chartInstance, canvasId) {
            if (!chartInstance || !chartInstance.canvas) {
                return;
            }
            const canvas = chartInstance.canvas;
            const img = document.createElement('img');
            img.src = chartInstance.toBase64Image();
            img.alt = canvas.getAttribute('data-alt') || (canvasId + ' snapshot');
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'contain';
            if (canvas.parentNode) {
                canvas.parentNode.replaceChild(img, canvas);
            }
            chartInstance.destroy();
        }

        function renderCharts(allSnapshots) {
            if (chartsFrozen) {
                return;
            }
            const ctxTotal = document.getElementById('totalTimeChart').getContext('2d');
            const ctxTop = document.getElementById('topNamespacesChart').getContext('2d');
            const ctxRead = document.getElementById('topNamespacesReadChart').getContext('2d');
            const ctxWrite = document.getElementById('topNamespacesWriteChart').getContext('2d');
            ctxTotal.canvas.style.height = '360px';
            ctxTop.canvas.style.height = '360px';
            ctxRead.canvas.style.height = '360px';
            ctxWrite.canvas.style.height = '360px';
            ensureCharts(ctxTotal, ctxTop, ctxRead, ctxWrite);

            const labels = allSnapshots.map(function(snap) { return snap.timestamp; });
            const labelIndices = buildIndexSample(labels.length, MAX_POINTS);
            const sampledTimestamps = selectByIndices(labels, labelIndices);
            const sampledLabels = sampledTimestamps.map(formatTime);

            let maxTicksLimit = sampledLabels.length;
            if (sampledTimestamps.length > 1) {
                const firstTs = new Date(sampledTimestamps[0]).getTime();
                const lastTs = new Date(sampledTimestamps[sampledTimestamps.length - 1]).getTime();
                if (Number.isFinite(firstTs) && Number.isFinite(lastTs) && lastTs > firstTs) {
                    const hours = (lastTs - firstTs) / 3600000;
                    maxTicksLimit = Math.max(2, Math.ceil(hours) + 1);
                }
            }
            maxTicksLimit = Math.min(maxTicksLimit, sampledLabels.length, 48);
            const hourTickCallback = function(value, index) {
                return sampledLabels[index] || value;
            };

            const globalOpsSeries = selectByIndices(allSnapshots.map(function(snap) {
                const value = snap.summary?.derived?.opsPerSec;
                return (typeof value === 'number' && value > 0) ? value : null;
            }), labelIndices);
            const globalActiveSeries = selectByIndices(allSnapshots.map(function(snap) {
                const value = snap.summary?.derived?.activeSecPerSec;
                return (typeof value === 'number' && value > 0) ? value : null;
            }), labelIndices);

            totalTimeChart.data.labels = sampledLabels;
            totalTimeChart.data.datasets = [
                {
                    label: 'Total Ops/sec',
                    data: globalOpsSeries,
                    borderColor: '#0077b6',
                    backgroundColor: 'rgba(0, 119, 182, 0.15)',
                    fill: false,
                    pointRadius: 2,
                    tension: 0.2,
                    spanGaps: true
                },
                {
                    label: 'Total Active sec/sec',
                    data: globalActiveSeries,
                    borderColor: '#ef476f',
                    backgroundColor: 'rgba(239, 71, 111, 0.15)',
                    fill: false,
                    pointRadius: 2,
                    tension: 0.2,
                    spanGaps: true
                }
            ];

            totalTimeChart.options.scales = {
                y: buildLogScale(globalOpsSeries.concat(globalActiveSeries)),
                x: {
                    ticks: {
                        autoSkip: true,
                        callback: hourTickCallback,
                        maxRotation: 0,
                        minRotation: 0,
                        maxTicksLimit
                    }
                }
            };
            totalTimeChart.update('none');

            const namespaceHistory = new Map();
            allSnapshots.forEach(function(snap, snapIndex) {
                (snap.metrics || []).forEach(function(metric) {
                    if (!namespaceHistory.has(metric.namespace)) {
                        namespaceHistory.set(metric.namespace, {
                            namespace: metric.namespace,
                            ops: new Array(allSnapshots.length).fill(null),
                            active: new Array(allSnapshots.length).fill(null),
                            avgMs: new Array(allSnapshots.length).fill(null)
                        });
                    }
                    const entry = namespaceHistory.get(metric.namespace);
                    const opsValue = metric.derived?.opsPerSec;
                    const activeValue = metric.derived?.activeSecPerSec;
                    const avgMsValue = metric.derived?.avgMsPerOp;
                    entry.ops[snapIndex] = (typeof opsValue === 'number' && opsValue > 0) ? opsValue : null;
                    entry.active[snapIndex] = (typeof activeValue === 'number' && activeValue > 0) ? activeValue : null;
                    const hasEnoughOps = Number(metric.total?.count ?? 0) >= 10;
                    entry.avgMs[snapIndex] = hasEnoughOps && typeof avgMsValue === 'number' && avgMsValue > 0
                        ? avgMsValue
                        : null;
                });
            });

            const chartNamespaceLimit = namespaceLimitSetting > 0
                ? Math.max(1, namespaceLimitSetting)
                : namespacePalette.length;

            const selectedNamespaces = Array.from(namespaceHistory.values())
                .map(function(entry) {
                    const activeSum = entry.active.reduce(function(sum, value) { return sum + (value || 0); }, 0);
                    const opsSum = entry.ops.reduce(function(sum, value) { return sum + (value || 0); }, 0);
                    return Object.assign({}, entry, { activeSum, opsSum });
                })
                .filter(function(entry) { return entry.activeSum > 0 || entry.opsSum > 0; })
                .sort(function(a, b) {
                    if (b.activeSum !== a.activeSum) {
                        return b.activeSum - a.activeSum;
                    }
                    return b.opsSum - a.opsSum;
                })
                .slice(0, chartNamespaceLimit);

            const sampledNamespaceLabels = sampledLabels;

            const applyChartData = function(chartInstance, key) {
                chartInstance.data.labels = sampledNamespaceLabels;
                const yValues = [];
                chartInstance.data.datasets = selectedNamespaces.map(function(entry, index) {
                    const colors = namespacePalette[index % namespacePalette.length];
                    const sampledSeries = selectByIndices(entry[key], labelIndices);
                    sampledSeries.forEach(function(v) {
                        if (typeof v === 'number' && v > 0) {
                            yValues.push(v);
                        }
                    });
                    return {
                        label: entry.namespace,
                        data: sampledSeries,
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                        pointRadius: 2,
                        tension: 0.2,
                        spanGaps: spanGapsSetting
                    };
                });
                chartInstance.options.scales = {
                    y: buildLogScale(yValues),
                    x: {
                        ticks: {
                            autoSkip: true,
                            callback: hourTickCallback,
                            maxRotation: 0,
                            minRotation: 0,
                            maxTicksLimit
                        }
                    }
                };
                chartInstance.update('none');
            };

            applyChartData(topNamespacesChart, 'ops');
            applyChartData(topNamespacesReadChart, 'active');
            applyChartData(topNamespacesWriteChart, 'avgMs');

            const freezeTotal = totalTimeChart;
            const freezeTop = topNamespacesChart;
            const freezeRead = topNamespacesReadChart;
            const freezeWrite = topNamespacesWriteChart;
            requestAnimationFrame(function() {
                freezeChart(freezeTotal, 'totalTimeChart');
                freezeChart(freezeTop, 'topNamespacesChart');
                freezeChart(freezeRead, 'topNamespacesReadChart');
                freezeChart(freezeWrite, 'topNamespacesWriteChart');
                totalTimeChart = null;
                topNamespacesChart = null;
                topNamespacesReadChart = null;
                topNamespacesWriteChart = null;
                chartsFrozen = true;
            });
        }

        async function loadDashboard() {
            try {
                const sizeSummaryPromise = fetchJson('/api/top-namespace-sizes').catch(() => null);
                const [snapshotsData, info, sizeSummary] = await Promise.all([
                    fetchJson('/api/snapshots'),
                    fetchJson('/api/info'),
                    sizeSummaryPromise
                ]);

                snapshotsCache = snapshotsData || [];
                namespaceLimitSetting = info && typeof info.namespaceLimit === 'number'
                    ? info.namespaceLimit
                    : namespaceLimitSetting;
                timeZoneSetting = info && typeof info.timeZone === 'string'
                    ? info.timeZone
                    : timeZoneSetting;
                spanGapsSetting = info && typeof info.spanGaps === 'boolean'
                    ? info.spanGaps
                    : spanGapsSetting;
                intervalSecondsSetting = null;
                chartsFrozen = false;
                renderCharts(snapshotsCache);
                renderSizeTable(sizeSummary);

                if (snapshotsCache.length > 0) {
                    showSnapshot(snapshotsCache.length - 1);
                } else {
                    renderSummary(null, []);
                    renderTable(null, 0);
                    renderNamespaceDrilldown(null);
                    renderIntervalDetail(null, null);
                }

                const details = [];
                const limitDescription = namespaceLimitSetting > 0 ? ('Top ' + namespaceLimitSetting + ' namespaces') : 'All namespaces';
                details.push(limitDescription);
                // No interval or interval source shown
                details.push('Gaps: ' + (spanGapsSetting ? 'connected' : 'broken'));
                if (timeZoneSetting) {
                    details.push('TZ: ' + timeZoneSetting);
                }
                fileInfoEl.textContent = details.join(' • ');
                updatePlaybackStatus();
            } catch (error) {
                console.error('Dashboard refresh failed:', error);
            }
        }

        btnFirst.addEventListener('click', () => {
            stopPlayback();
            showSnapshot(0);
        });
        btnPrev.addEventListener('click', () => {
            stopPlayback();
            showSnapshot(playbackIndex - 1);
        });
        btnPlay.addEventListener('click', () => {
            if (isPlaying) {
                stopPlayback();
            } else {
                startPlayback();
            }
        });
        btnNext.addEventListener('click', () => {
            stopPlayback();
            showSnapshot(playbackIndex + 1);
        });
        btnLast.addEventListener('click', () => {
            stopPlayback();
            showSnapshot(snapshotsCache.length - 1);
        });

        loadDashboard();
    </script>
</body>
</html>`;

function normalizeNamespace(namespace) {
    const segments = namespace.split('.');
    const db = segments.shift() || '';
    const collection = segments.join('.') || '';
    return { namespace, db, collection };
}

function parseNumericField(value) {
    if (value === null || value === undefined) {
        return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function safeDivide(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
        return null;
    }
    return numerator / denominator;
}

function deriveMetrics(totalMs, totalCount, readMs, readCount, writeMs, writeCount, intervalSeconds) {
    const totalActiveSeconds = Number(totalMs || 0) / 1000;
    const readActiveSeconds = Number(readMs || 0) / 1000;
    const writeActiveSeconds = Number(writeMs || 0) / 1000;

    return {
        opsPerSec: safeDivide(totalCount, intervalSeconds),
        readOpsPerSec: safeDivide(readCount, intervalSeconds),
        writeOpsPerSec: safeDivide(writeCount, intervalSeconds),
        activeSecPerSec: safeDivide(totalActiveSeconds, intervalSeconds),
        readActiveSecPerSec: safeDivide(readActiveSeconds, intervalSeconds),
        writeActiveSecPerSec: safeDivide(writeActiveSeconds, intervalSeconds),
        avgMsPerOp: safeDivide(totalMs, totalCount),
        readAvgMsPerOp: safeDivide(readMs, readCount),
        writeAvgMsPerOp: safeDivide(writeMs, writeCount),
        totalActiveSeconds,
        readActiveSeconds,
        writeActiveSeconds
    };
}

function resolveTimestamp(raw, fallbackIndex) {
    const parsedMillis = raw && raw.time ? new Date(raw.time).getTime() : NaN;
    if (Number.isFinite(parsedMillis)) {
        return new Date(parsedMillis).toISOString();
    }
    // Keep deterministic ordering for malformed/missing timestamps.
    return new Date(Date.now() + fallbackIndex).toISOString();
}

function inferIntervalSecondsFromRawSnapshots(rawSnapshots) {
    if (!Array.isArray(rawSnapshots) || rawSnapshots.length < 2) {
        return null;
    }

    const deltas = [];
    for (let i = 1; i < rawSnapshots.length; i += 1) {
        const prevMs = new Date(rawSnapshots[i - 1].time).getTime();
        const currentMs = new Date(rawSnapshots[i].time).getTime();
        if (!Number.isFinite(prevMs) || !Number.isFinite(currentMs) || currentMs <= prevMs) {
            continue;
        }
        deltas.push((currentMs - prevMs) / 1000);
    }

    if (!deltas.length) {
        return null;
    }

    deltas.sort((a, b) => a - b);
    const middle = Math.floor(deltas.length / 2);
    const median = deltas.length % 2 === 0
        ? (deltas[middle - 1] + deltas[middle]) / 2
        : deltas[middle];
    if (!Number.isFinite(median) || median <= 0) {
        return null;
    }
    return Math.max(1, Math.round(median));
}

function normalizeSnapshot(raw, index, intervalSeconds) {
    const timestamp = resolveTimestamp(raw, index);
    const entries = Object.entries(raw.totals || {});

    const rawMetrics = entries.map(([namespace, metric]) => {
        const { namespace: ns, db, collection } = normalizeNamespace(namespace);
        const totalMs = Number(metric.total?.time ?? 0);
        const readMs = Number(metric.read?.time ?? 0);
        const writeMs = Number(metric.write?.time ?? 0);
        const totalCount = Number(metric.total?.count ?? 0);
        const readCount = Number(metric.read?.count ?? 0);
        const writeCount = Number(metric.write?.count ?? 0);
        const derived = deriveMetrics(totalMs, totalCount, readMs, readCount, writeMs, writeCount, intervalSeconds);
        return {
            namespace: ns,
            db,
            collection,
            intervalSeconds,
            total: {
                time: totalMs / MS_TO_MINUTES,
                count: totalCount,
                ms: totalMs,
                activeSeconds: derived.totalActiveSeconds
            },
            read: {
                time: readMs / MS_TO_MINUTES,
                count: readCount,
                ms: readMs,
                activeSeconds: derived.readActiveSeconds
            },
            write: {
                time: writeMs / MS_TO_MINUTES,
                count: writeCount,
                ms: writeMs,
                activeSeconds: derived.writeActiveSeconds
            },
            derived
        };
    }).filter(item => item.total.time > 0 || item.total.count > 0 || item.read.time > 0 || item.write.time > 0);

    const sortedMetrics = rawMetrics.slice().sort((a, b) => b.total.time - a.total.time);
    const metricsLimit = namespaceLimit > 0 ? namespaceLimit : sortedMetrics.length;
    const tableLimit = namespaceLimit > 0 ? Math.min(sortedMetrics.length, namespaceLimit * 3) : sortedMetrics.length;
    const limitedMetrics = sortedMetrics.slice(0, metricsLimit);

    const totalTime = rawMetrics.reduce((sum, item) => sum + item.total.time, 0);
    const totalMs = rawMetrics.reduce((sum, item) => sum + item.total.ms, 0);
    const totalCount = rawMetrics.reduce((sum, item) => sum + item.total.count, 0);
    const readTime = rawMetrics.reduce((sum, item) => sum + item.read.time, 0);
    const readMs = rawMetrics.reduce((sum, item) => sum + item.read.ms, 0);
    const writeTime = rawMetrics.reduce((sum, item) => sum + item.write.time, 0);
    const writeMs = rawMetrics.reduce((sum, item) => sum + item.write.ms, 0);
    const readCount = rawMetrics.reduce((sum, item) => sum + item.read.count, 0);
    const writeCount = rawMetrics.reduce((sum, item) => sum + item.write.count, 0);
    const summaryDerived = deriveMetrics(totalMs, totalCount, readMs, readCount, writeMs, writeCount, intervalSeconds);

    const busiest = sortedMetrics.slice(0, tableLimit);

    return {
        id: `${timestamp}-${index}`,
        timestamp,
        metrics: limitedMetrics,
        summary: {
            intervalSeconds,
            totalNamespaces: rawMetrics.length,
            totalTime,
            totalMs,
            totalCount,
            readTime,
            readMs,
            writeTime,
            writeMs,
            readCount,
            writeCount,
            derived: summaryDerived,
            busiest
        }
    };
}

function getEffectiveIntervalSeconds() {
    return Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0
        ? configuredIntervalSeconds
        : inferredIntervalSeconds;
}

function buildNormalizedRecords() {
    return snapshots.flatMap(snapshot => {
        const intervalSeconds = snapshot?.summary?.intervalSeconds || getEffectiveIntervalSeconds() || null;
        return (snapshot.metrics || []).map(metric => ({
            timestamp: snapshot.timestamp,
            namespace: metric.namespace,
            interval_seconds: intervalSeconds,
            total_ms: metric.total.ms,
            total_count: metric.total.count,
            read_ms: metric.read.ms,
            read_count: metric.read.count,
            write_ms: metric.write.ms,
            write_count: metric.write.count,
            ops_per_sec: metric.derived.opsPerSec,
            read_ops_per_sec: metric.derived.readOpsPerSec,
            write_ops_per_sec: metric.derived.writeOpsPerSec,
            active_sec_per_sec: metric.derived.activeSecPerSec,
            read_active_sec_per_sec: metric.derived.readActiveSecPerSec,
            write_active_sec_per_sec: metric.derived.writeActiveSecPerSec,
            avg_ms_per_op: metric.derived.avgMsPerOp,
            read_avg_ms_per_op: metric.derived.readAvgMsPerOp,
            write_avg_ms_per_op: metric.derived.writeAvgMsPerOp
        }));
    });
}

function rebuildNamespaceRollup() {
    const rollup = new Map();
    snapshots.forEach(snapshot => {
        snapshot.metrics.forEach(metric => {
            if (!rollup.has(metric.namespace)) {
                rollup.set(metric.namespace, {
                    namespace: metric.namespace,
                    db: metric.db,
                    collection: metric.collection,
                    totalTime: 0,
                    totalCount: 0,
                    readTime: 0,
                    writeTime: 0,
                    readCount: 0,
                    writeCount: 0
                });
            }
            const entry = rollup.get(metric.namespace);
            entry.totalTime += metric.total.time;
            entry.totalCount += metric.total.count;
            entry.readTime += metric.read.time;
            entry.writeTime += metric.write.time;
            entry.readCount += metric.read.count;
            entry.writeCount += metric.write.count;
        });
    });

    namespaceRollup = Array.from(rollup.values()).sort((a, b) => b.totalTime - a.totalTime);
}

function buildNamespaceSizeSummary(limitOverride) {
    const defaultLimit = namespaceLimit > 0 ? namespaceLimit : namespaceRollup.length;
    let effectiveLimit = defaultLimit;

    if (Number.isFinite(limitOverride)) {
        if (limitOverride > 0) {
            effectiveLimit = limitOverride;
        } else if (limitOverride === 0) {
            effectiveLimit = namespaceRollup.length;
        }
    }

    if (effectiveLimit <= 0 || effectiveLimit > namespaceRollup.length) {
        effectiveLimit = namespaceRollup.length;
    }

    const selected = namespaceRollup.slice(0, effectiveLimit);
    return selected.map(entry => {
        const meta = collectionMetadata.get(entry.namespace);
        return {
            namespace: entry.namespace,
            db: entry.db,
            collection: entry.collection,
            dataSize: meta ? meta.dataSize : null,
            storageSize: meta ? meta.storageSize : null,
            indexSize: meta ? meta.indexSize : null
        };
    });
}

function loadCollectionMetadata(filePath) {
    try {
        const rawContent = fs.readFileSync(filePath, 'utf8');
        const lines = rawContent.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const metadataMap = new Map();

        lines.forEach((line, index) => {
            try {
                const parsed = JSON.parse(line);
                if (parsed && parsed.level === 'collection' && parsed.db && parsed.name) {
                    const namespace = `${parsed.db}.${parsed.name}`;
                    metadataMap.set(namespace, {
                        namespace,
                        db: parsed.db,
                        collection: parsed.name,
                        dataSize: parseNumericField(parsed.size ?? parsed.dataSize),
                        storageSize: parseNumericField(parsed.storageSize),
                        indexSize: parseNumericField(parsed.totalIndexSize ?? parsed.indexSize)
                    });
                }
            } catch (error) {
                if (error instanceof SyntaxError) {
                    console.warn(`Skipping invalid metadata JSON line ${index + 1}: ${error.message}`);
                }
            }
        });

        collectionMetadata = metadataMap;
        metaSourceFile = filePath;
        console.log(`Loaded metadata for ${collectionMetadata.size} collections from ${filePath}`);
    } catch (error) {
        console.warn(`Failed to load metadata file "${filePath}": ${error.message}`);
        collectionMetadata = new Map();
        metaSourceFile = '';
    }
}

function loadSnapshotsFromFile(filePath) {
    try {
        const rawContent = fs.readFileSync(filePath, 'utf8');
        const lines = rawContent.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const parsedRawSnapshots = [];

        lines.forEach((line, index) => {
            try {
                const parsed = JSON.parse(line);
                if (parsed && parsed.totals) {
                    parsedRawSnapshots.push(parsed);
                }
            } catch (error) {
                console.warn(`Skipping invalid JSON line ${index + 1}: ${error.message}`);
            }
        });

        parsedRawSnapshots.sort((a, b) => {
            const left = new Date(resolveTimestamp(a, 0)).getTime();
            const right = new Date(resolveTimestamp(b, 0)).getTime();
            return left - right;
        });

        inferredIntervalSeconds = inferIntervalSecondsFromRawSnapshots(parsedRawSnapshots);
        const effectiveIntervalSeconds = getEffectiveIntervalSeconds();

        const parsedSnapshots = parsedRawSnapshots.map((rawSnapshot, index) =>
            normalizeSnapshot(rawSnapshot, index, effectiveIntervalSeconds)
        );

        snapshots = parsedSnapshots;
        rebuildNamespaceRollup();

        console.log(`Loaded ${snapshots.length} snapshots from ${filePath}`);
        if (effectiveIntervalSeconds) {
            const source = Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0
                ? 'override'
                : 'inferred';
            console.log(`Using polling interval of ${effectiveIntervalSeconds} seconds (${source})`);
        } else {
            console.log('Polling interval unavailable; derived rate metrics may be null.');
        }
    } catch (error) {
        console.error('Failed to load JSON file:', error.message);
        snapshots = [];
        namespaceRollup = [];
        inferredIntervalSeconds = null;
    }
}

function startServer(port) {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === '/api/snapshots') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(snapshots));
            return;
        }

        if (url.pathname === '/api/snapshot/latest') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(snapshots[snapshots.length - 1] || null));
            return;
        }

        if (url.pathname === '/api/namespaces') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(namespaceRollup));
            return;
        }

        if (url.pathname === '/api/top-namespace-sizes') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                limit: namespaceLimit,
                namespaces: buildNamespaceSizeSummary()
            }));
            return;
        }

        if (url.pathname === '/api/normalized') {
            const intervalSeconds = getEffectiveIntervalSeconds();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                snapshotCount: snapshots.length,
                intervalSeconds,
                intervalSource: Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0
                    ? 'override'
                    : (Number.isFinite(inferredIntervalSeconds) && inferredIntervalSeconds > 0 ? 'inferred' : 'unknown'),
                records: buildNormalizedRecords()
            }));
            return;
        }

        if (url.pathname === '/api/info') {
            const intervalSeconds = getEffectiveIntervalSeconds();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                snapshotCount: snapshots.length,
                namespaceLimit,
                timeZone: displayTimeZone,
                spanGaps: spanGapsEnabled,
                intervalSeconds,
                intervalSource: Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0
                    ? 'override'
                    : (Number.isFinite(inferredIntervalSeconds) && inferredIntervalSeconds > 0 ? 'inferred' : 'unknown')
            }));
            return;
        }

        if (url.pathname === '/' || url.pathname === '/dashboard') {
            res.writeHead(200, {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(DASHBOARD_HTML);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    server.listen(port, () => {
        console.log(`mongotop dashboard available at http://localhost:${port}`);
    });

    return server;
}

function printUsage() {
    console.log(`
Usage: node mongotop-view.js --json-file <path> [options]

Options:
  --json-file <path>    Path to newline-delimited mongotop JSON file (required)
  --port <number>       Dashboard port (default: ${DEFAULT_PORT})
    --interval-seconds <n> Polling interval in seconds (optional, overrides inference)
  --namespace-limit <n>  Max namespaces per snapshot (default: 5, 0 = all)
  --timezone <iana>      IANA timezone for displayed timestamps (default: ${DEFAULT_TIMEZONE})
  --meta-file <path>     Path to mongmeta-capture output JSON file for collection sizes (optional)
  --span-gaps <bool>     Connect missing datapoint gaps in charts (default: true)
  --help                Show this help message

Example:
    node mongotop-view.js --json-file sampleMongoTop.json --port 9090

Note: mongmeta-capture script can be downloaded from here  https://github.com/derekjgrove/mongmeta-capture
`);
}

function parseBooleanOptionValue(input, optionName) {
    const normalized = String(input).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
        return false;
    }
    console.warn(`Invalid value for ${optionName}; expected true or false but received "${input}". Using default.`);
    return null;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        port: DEFAULT_PORT,
        jsonFile: '',
        intervalSeconds: null,
        namespaceLimit: 5,
        timeZone: null,
        metaFile: '',
        spanGaps: true
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        switch (arg) {
            case '--json-file':
                options.jsonFile = args[i + 1];
                i += 1;
                break;
            case '--port':
                options.port = Number(args[i + 1]) || DEFAULT_PORT;
                i += 1;
                break;
            case '--interval-seconds': {
                const value = Number(args[i + 1]);
                if (Number.isFinite(value) && value > 0) {
                    options.intervalSeconds = Math.floor(value);
                } else {
                    console.warn('Invalid --interval-seconds value; expected a positive number. Ignoring override.');
                }
                i += 1;
                break;
            }
            case '--namespace-limit':
                options.namespaceLimit = Number(args[i + 1]);
                i += 1;
                break;
            case '--timezone':
                options.timeZone = args[i + 1] || null;
                i += 1;
                break;
            case '--meta-file':
                options.metaFile = args[i + 1] || '';
                i += 1;
                break;
            case '--span-gaps': {
                const next = args[i + 1];
                if (typeof next === 'undefined' || next.startsWith('--')) {
                    console.warn('Missing value for --span-gaps; expected true or false. Using default.');
                } else {
                    const parsed = parseBooleanOptionValue(next, '--span-gaps');
                    if (parsed !== null) {
                        options.spanGaps = parsed;
                    }
                    i += 1;
                }
                break;
            }
            case '--help':
                printUsage();
                process.exit(0);
                break;
            default:
                console.warn(`Unknown option: ${arg}`);
                printUsage();
                process.exit(1);
        }
    }

    if (!options.jsonFile) {
        console.error('Missing required --json-file option');
        printUsage();
        process.exit(1);
    }

    return options;
}

function resolveTimeZone(candidate) {
    if (!candidate) {
        return DEFAULT_TIMEZONE;
    }
    let zone = String(candidate).trim();
    if (!zone) {
        return DEFAULT_TIMEZONE;
    }
    const alias = TIMEZONE_ALIASES[zone.toLowerCase()];
    if (alias) {
        zone = alias;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
        return zone;
    } catch (error) {
        console.warn(`Invalid timezone "${candidate}" provided; falling back to ${DEFAULT_TIMEZONE}`);
        return DEFAULT_TIMEZONE;
    }
}

function main() {
    const options = parseArgs();
    sourceFile = path.resolve(options.jsonFile);
    configuredIntervalSeconds = Number.isFinite(options.intervalSeconds) && options.intervalSeconds > 0
        ? options.intervalSeconds
        : null;
    if (!Number.isFinite(options.namespaceLimit) || options.namespaceLimit < 0) {
        console.warn('Invalid namespace limit provided; defaulting to 5');
        namespaceLimit = 5;
    } else {
        namespaceLimit = Math.floor(options.namespaceLimit);
    }

    spanGapsEnabled = Boolean(options.spanGaps);

    if (!fs.existsSync(sourceFile)) {
        console.error(`JSON file not found: ${sourceFile}`);
        process.exit(1);
    }

    displayTimeZone = resolveTimeZone(options.timeZone);

    if (options.metaFile) {
        const resolvedMeta = path.resolve(options.metaFile);
        if (fs.existsSync(resolvedMeta)) {
            loadCollectionMetadata(resolvedMeta);
        } else {
            console.warn(`Metadata file not found: ${resolvedMeta}`);
            collectionMetadata = new Map();
            metaSourceFile = '';
        }
    } else {
        collectionMetadata = new Map();
        metaSourceFile = '';
    }

    loadSnapshotsFromFile(sourceFile);

    serverInstance = startServer(options.port);

    process.on('SIGINT', () => {
        console.log('\nStopping mongotop viewer...');
        if (serverInstance) {
            serverInstance.close(() => {
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    loadSnapshotsFromFile,
    normalizeSnapshot,
    rebuildNamespaceRollup,
    loadCollectionMetadata,
    buildNamespaceSizeSummary,
    inferIntervalSecondsFromRawSnapshots,
    buildNormalizedRecords,
    deriveMetrics
};
