/**
 * Visual Memory Graph Explorer
 * Interactive D3.js-based visualization of memory facts and relationships
 */

export const graphExplorerHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Memory Graph Explorer - OpenClaw Hybrid Memory</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            overflow: hidden;
        }

        #container {
            display: flex;
            height: 100vh;
        }

        #sidebar {
            width: 300px;
            background: #1e293b;
            padding: 20px;
            overflow-y: auto;
            border-right: 1px solid #334155;
        }

        #graph-container {
            flex: 1;
            position: relative;
        }

        h1 {
            font-size: 20px;
            margin-bottom: 20px;
            color: #60a5fa;
        }

        .control-group {
            margin-bottom: 20px;
        }

        .control-group label {
            display: block;
            margin-bottom: 8px;
            font-size: 14px;
            font-weight: 500;
        }

        select, input[type="range"], input[type="text"] {
            width: 100%;
            padding: 8px;
            background: #334155;
            border: 1px solid #475569;
            border-radius: 4px;
            color: #e2e8f0;
            font-size: 14px;
        }

        input[type="range"] {
            padding: 0;
        }

        .filter-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 8px;
        }

        .chip {
            padding: 4px 12px;
            background: #475569;
            border-radius: 12px;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s;
        }

        .chip.active {
            background: #60a5fa;
        }

        .chip:hover {
            background: #64748b;
        }

        .chip.active:hover {
            background: #3b82f6;
        }

        #stats {
            margin-top: 20px;
            padding: 16px;
            background: #334155;
            border-radius: 8px;
            font-size: 13px;
        }

        #stats div {
            margin: 8px 0;
        }

        .node {
            cursor: pointer;
            stroke: #1e293b;
            stroke-width: 2px;
        }

        .node.selected {
            stroke: #fbbf24;
            stroke-width: 3px;
        }

        .link {
            stroke-opacity: 0.6;
            fill: none;
        }

        .node-label {
            font-size: 10px;
            fill: #e2e8f0;
            pointer-events: none;
            text-anchor: middle;
        }

        .tooltip {
            position: absolute;
            padding: 12px;
            background: #1e293b;
            border: 1px solid #60a5fa;
            border-radius: 8px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
            max-width: 300px;
            font-size: 12px;
            z-index: 1000;
        }

        .tooltip.show {
            opacity: 1;
        }

        .tooltip h3 {
            margin-bottom: 8px;
            color: #60a5fa;
            font-size: 14px;
        }

        .tooltip .text {
            margin: 8px 0;
            line-height: 1.4;
        }

        .tooltip .meta {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid #334155;
            font-size: 11px;
            color: #94a3b8;
        }

        #controls {
            position: absolute;
            top: 20px;
            right: 20px;
            background: #1e293b;
            padding: 16px;
            border-radius: 8px;
            border: 1px solid #334155;
        }

        button {
            padding: 8px 16px;
            background: #3b82f6;
            border: none;
            border-radius: 4px;
            color: white;
            cursor: pointer;
            font-size: 14px;
            margin: 4px;
            transition: background 0.2s;
        }

        button:hover {
            background: #2563eb;
        }

        button:active {
            background: #1d4ed8;
        }

        .legend {
            position: absolute;
            bottom: 20px;
            right: 20px;
            background: #1e293b;
            padding: 16px;
            border-radius: 8px;
            border: 1px solid #334155;
            font-size: 12px;
        }

        .legend-item {
            display: flex;
            align-items: center;
            margin: 8px 0;
        }

        .legend-color {
            width: 20px;
            height: 20px;
            border-radius: 4px;
            margin-right: 10px;
        }
    </style>
</head>
<body>
    <div id="container">
        <div id="sidebar">
            <h1>🧠 Memory Graph</h1>

            <div class="control-group">
                <label>Search Facts</label>
                <input type="text" id="search" placeholder="Search by text, entity, or tags...">
            </div>

            <div class="control-group">
                <label>Category Filter</label>
                <div class="filter-chips" id="category-filter"></div>
            </div>

            <div class="control-group">
                <label>Decay Class Filter</label>
                <div class="filter-chips" id="decay-filter"></div>
            </div>

            <div class="control-group">
                <label>Min Importance: <span id="importance-value">0.0</span></label>
                <input type="range" id="importance" min="0" max="1" step="0.1" value="0">
            </div>

            <div class="control-group">
                <label>Min Confidence: <span id="confidence-value">0.0</span></label>
                <input type="range" id="confidence" min="0" max="1" step="0.1" value="0">
            </div>

            <div id="stats">
                <div><strong>Statistics</strong></div>
                <div>Total Facts: <span id="total-facts">0</span></div>
                <div>Visible Nodes: <span id="visible-nodes">0</span></div>
                <div>Total Links: <span id="total-links">0</span></div>
                <div>Selected: <span id="selected-node">None</span></div>
            </div>
        </div>

        <div id="graph-container">
            <svg id="graph"></svg>
            <div id="controls">
                <button onclick="resetZoom()">Reset View</button>
                <button onclick="refreshData()">Refresh Data</button>
                <button onclick="exportGraph()">Export PNG</button>
            </div>
            <div class="legend">
                <div><strong>Categories</strong></div>
                <div class="legend-item">
                    <div class="legend-color" style="background: #60a5fa;"></div>
                    <span>Preference</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color" style="background: #34d399;"></div>
                    <span>Decision</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color" style="background: #fbbf24;"></div>
                    <span>Entity</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color" style="background: #f87171;"></div>
                    <span>Fact</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color" style="background: #a78bfa;"></div>
                    <span>Other</span>
                </div>
            </div>
        </div>
    </div>

    <div class="tooltip" id="tooltip"></div>

    <script>
        // Configuration
        const width = window.innerWidth - 300;
        const height = window.innerHeight;
        const categoryColors = {
            preference: '#60a5fa',
            decision: '#34d399',
            entity: '#fbbf24',
            fact: '#f87171',
            other: '#a78bfa'
        };

        // State
        let allData = { nodes: [], edges: [] };
        let filteredData = { nodes: [], edges: [] };
        let selectedNode = null;
        let simulation = null;

        // SVG setup
        const svg = d3.select('#graph')
            .attr('width', width)
            .attr('height', height);

        const g = svg.append('g');

        // Zoom behavior
        const zoom = d3.zoom()
            .scaleExtent([0.1, 4])
            .on('zoom', (event) => {
                g.attr('transform', event.transform);
            });

        svg.call(zoom);

        // Initialize
        async function init() {
            await loadData();
            setupFilters();
            updateVisualization();
        }

        async function loadData() {
            try {
                // Use relative path to GraphQL endpoint
                const response = await fetch('/graphql', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: \`
                            query GetGraph {
                                graph {
                                    nodes { id label category importance confidence decayClass }
                                    edges { source target linkType weight }
                                }
                                stats {
                                    totalFacts
                                    factsByCategory { category count }
                                }
                            }
                        \`
                    })
                });

                const result = await response.json();
                if (result.data) {
                    allData = result.data.graph;
                    updateStats(result.data.stats);
                }
            } catch (error) {
                console.error('Failed to load graph data:', error);
            }
        }

        function setupFilters() {
            const categories = [...new Set(allData.nodes.map(n => n.category))];
            const decayClasses = [...new Set(allData.nodes.map(n => n.decayClass))];

            // Category filters
            const categoryFilter = d3.select('#category-filter');
            categoryFilter.selectAll('.chip')
                .data(categories)
                .join('div')
                .attr('class', 'chip active')
                .text(d => d)
                .on('click', function(event, d) {
                    d3.select(this).classed('active', !d3.select(this).classed('active'));
                    applyFilters();
                });

            // Decay class filters
            const decayFilter = d3.select('#decay-filter');
            decayFilter.selectAll('.chip')
                .data(decayClasses)
                .join('div')
                .attr('class', 'chip active')
                .text(d => d)
                .on('click', function(event, d) {
                    d3.select(this).classed('active', !d3.select(this).classed('active'));
                    applyFilters();
                });

            // Range sliders
            d3.select('#importance').on('input', function() {
                d3.select('#importance-value').text(this.value);
                applyFilters();
            });

            d3.select('#confidence').on('input', function() {
                d3.select('#confidence-value').text(this.value);
                applyFilters();
            });

            // Search
            d3.select('#search').on('input', applyFilters);
        }

        function applyFilters() {
            const activeCategories = Array.from(document.querySelectorAll('#category-filter .chip.active'))
                .map(el => el.textContent);
            const activeDecayClasses = Array.from(document.querySelectorAll('#decay-filter .chip.active'))
                .map(el => el.textContent);
            const minImportance = +document.getElementById('importance').value;
            const minConfidence = +document.getElementById('confidence').value;
            const searchText = document.getElementById('search').value.toLowerCase();

            filteredData.nodes = allData.nodes.filter(node => {
                if (!activeCategories.includes(node.category)) return false;
                if (!activeDecayClasses.includes(node.decayClass)) return false;
                if (node.importance < minImportance) return false;
                if (node.confidence < minConfidence) return false;
                if (searchText && !node.label.toLowerCase().includes(searchText)) return false;
                return true;
            });

            const nodeIds = new Set(filteredData.nodes.map(n => n.id));
            filteredData.edges = allData.edges.filter(edge =>
                nodeIds.has(edge.source) && nodeIds.has(edge.target)
            );

            updateVisualization();
        }

        function updateVisualization() {
            // Clear existing
            g.selectAll('*').remove();

            if (filteredData.nodes.length === 0) return;

            // Create force simulation
            simulation = d3.forceSimulation(filteredData.nodes)
                .force('link', d3.forceLink(filteredData.edges)
                    .id(d => d.id)
                    .distance(100))
                .force('charge', d3.forceManyBody().strength(-300))
                .force('center', d3.forceCenter(width / 2, height / 2))
                .force('collision', d3.forceCollide().radius(30));

            // Links
            const link = g.append('g')
                .selectAll('line')
                .data(filteredData.edges)
                .join('line')
                .attr('class', 'link')
                .attr('stroke', '#475569')
                .attr('stroke-width', d => Math.sqrt(d.weight || 1) * 2);

            // Nodes
            const node = g.append('g')
                .selectAll('circle')
                .data(filteredData.nodes)
                .join('circle')
                .attr('class', 'node')
                .attr('r', d => 5 + d.importance * 15)
                .attr('fill', d => categoryColors[d.category] || categoryColors.other)
                .call(d3.drag()
                    .on('start', dragstarted)
                    .on('drag', dragged)
                    .on('end', dragended))
                .on('click', (event, d) => selectNode(d))
                .on('mouseover', (event, d) => showTooltip(event, d))
                .on('mouseout', hideTooltip);

            // Labels
            const label = g.append('g')
                .selectAll('text')
                .data(filteredData.nodes)
                .join('text')
                .attr('class', 'node-label')
                .text(d => d.label.substring(0, 20))
                .attr('dy', -20);

            // Update positions
            simulation.on('tick', () => {
                link
                    .attr('x1', d => d.source.x)
                    .attr('y1', d => d.source.y)
                    .attr('x2', d => d.target.x)
                    .attr('y2', d => d.target.y);

                node
                    .attr('cx', d => d.x)
                    .attr('cy', d => d.y);

                label
                    .attr('x', d => d.x)
                    .attr('y', d => d.y);
            });

            // Update stats
            d3.select('#visible-nodes').text(filteredData.nodes.length);
            d3.select('#total-links').text(filteredData.edges.length);
        }

        function dragstarted(event, d) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }

        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }

        function dragended(event, d) {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }

        function selectNode(node) {
            selectedNode = node;
            d3.selectAll('.node').classed('selected', false);
            d3.selectAll('.node').filter(d => d.id === node.id).classed('selected', true);
            d3.select('#selected-node').text(\`\${node.category}: \${node.label.substring(0, 30)}\`);
        }

        function showTooltip(event, node) {
            const tooltip = d3.select('#tooltip');
            tooltip.html(\`
                <h3>\${node.category.toUpperCase()}</h3>
                <div class="text">\${node.label}</div>
                <div class="meta">
                    Importance: \${node.importance.toFixed(2)} |
                    Confidence: \${node.confidence.toFixed(2)} |
                    Decay: \${node.decayClass}
                </div>
            \`)
            .style('left', (event.pageX + 10) + 'px')
            .style('top', (event.pageY - 10) + 'px')
            .classed('show', true);
        }

        function hideTooltip() {
            d3.select('#tooltip').classed('show', false);
        }

        function updateStats(stats) {
            d3.select('#total-facts').text(stats.totalFacts);
        }

        function resetZoom() {
            svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
        }

        async function refreshData() {
            await loadData();
            applyFilters();
        }

        function exportGraph() {
            // TODO: Implement PNG export
            alert('Export functionality coming soon!');
        }

        // Initialize on load
        init();
    </script>
</body>
</html>
`;
