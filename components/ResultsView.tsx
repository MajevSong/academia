import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LibrarianResult, DataScientistResult, Paper, DownloadedDocument } from '../types';
import { extractTextFromPdf, fetchAbstractFromUrl } from '../services/geminiService';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import {
  FileText, Database, BookOpen, Copy, Check, ExternalLink, Info, X,
  ShieldCheck, Download, Sparkles, Network, Maximize2, Minimize2,
  ZoomIn, ZoomOut, RefreshCw, Camera, Move, Pause, Play, FileSpreadsheet,
  ArrowRight, Loader, File, Trash2, Unlock, RefreshCcw
} from 'lucide-react';

interface ResultsViewProps {
  librarianResult: LibrarianResult | null;
  dataResult: DataScientistResult | null;
  finalLatex: string | null;
  documents: DownloadedDocument[];
  setDocuments: React.Dispatch<React.SetStateAction<DownloadedDocument[]>>;
  onRegenerate: () => void;
  onGenerateReport: () => void;
  isRegenerating: boolean;
}

interface CitationButtonProps {
  paper: Paper;
  index: number;
  onClick: () => void;
}

// --- FORCE DIRECTED GRAPH TYPES & COMPONENT ---

interface GraphNode extends Paper {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  group: number; // For clustering
  isFixed: boolean; // Did user drag it?
  degree: number; // Number of connections
}

interface GraphLink {
  source: number;
  target: number;
  strength: number;
}

const COLORS = [
  '#6366f1', // Indigo
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#f43f5e', // Rose
];

const SCI_HUB_MIRRORS = [
  'https://sci-hub.se',
  'https://sci-hub.st',
  'https://sci-hub.ru'
];

const CitationGraph: React.FC<{ papers: Paper[] }> = ({ papers }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  // Viewport State
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 0.8 }); // Default zoom out slightly
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Physics State
  const draggingNodeRef = useRef<number | null>(null);
  const requestRef = useRef<number>();
  const isSimulationRunning = useRef(true);
  const [isPaused, setIsPaused] = useState(false);

  // --- 1. INITIALIZATION & CLUSTERING ---
  useEffect(() => {
    if (!papers || papers.length === 0) return;

    const width = 800;
    const height = 600;

    // Temporary Nodes for Link Calculation
    let tempNodes = papers.map((p, i) => ({
      ...p,
      id: i,
      group: 0,
      radius: 8,
      degree: 0,
    }));

    // Generate Links & Identify Clusters
    const newLinks: GraphLink[] = [];
    const adjList: number[][] = Array(tempNodes.length).fill(null).map(() => []);

    for (let i = 0; i < tempNodes.length; i++) {
      for (let j = i + 1; j < tempNodes.length; j++) {
        const p1 = tempNodes[i];
        const p2 = tempNodes[j];

        let connected = false;
        let strength = 0.0;

        // Author Overlap
        const authors1 = p1.authors.split(',').map(a => a.trim().split(' ').pop() || '');
        const authors2 = p2.authors.split(',').map(a => a.trim().split(' ').pop() || '');
        const hasSharedAuthor = authors1.some(a => a.length > 2 && authors2.includes(a));

        if (hasSharedAuthor) {
          connected = true;
          strength += 0.4;
        }

        // Semantic Similarity (Jaccard)
        const text1 = (p1.title + " " + p1.summary).toLowerCase();
        const text2 = (p2.title + " " + p2.summary).toLowerCase();
        const getTokens = (str: string) => new Set(str.split(/[^a-z0-9]+/).filter(w => w.length > 4));
        const set1 = getTokens(text1);
        const set2 = getTokens(text2);
        let intersection = 0;
        set1.forEach(w => { if (set2.has(w)) intersection++; });
        const union = new Set([...set1, ...set2]).size;
        const jaccard = union > 0 ? intersection / union : 0;

        if (jaccard > 0.08) {
          connected = true;
          strength += jaccard * 3;
        }

        if (connected) {
          newLinks.push({ source: i, target: j, strength: Math.min(strength, 1.0) });
          adjList[i].push(j);
          adjList[j].push(i);
          tempNodes[i].degree++;
          tempNodes[j].degree++;
        }
      }
    }

    // Assign Groups (BFS for Connected Components)
    let groupCount = 0;
    const visited = new Set<number>();

    tempNodes.forEach((node, idx) => {
      if (!visited.has(idx)) {
        const queue = [idx];
        visited.add(idx);
        while (queue.length > 0) {
          const curr = queue.shift()!;
          tempNodes[curr].group = groupCount;
          adjList[curr].forEach(neighbor => {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              queue.push(neighbor);
            }
          });
        }
        groupCount++;
      }
    });

    // Finalize Nodes with Positions based on Groups
    const finalNodes: GraphNode[] = tempNodes.map((n) => {
      const angle = (n.group / (groupCount || 1)) * 2 * Math.PI;
      const clusterRadius = 200;
      return {
        ...n,
        // Dynamic radius based on degree centrality (connections)
        radius: 10 + (n.degree * 2),
        x: width / 2 + Math.cos(angle) * clusterRadius + (Math.random() - 0.5) * 50,
        y: height / 2 + Math.sin(angle) * clusterRadius + (Math.random() - 0.5) * 50,
        vx: 0,
        vy: 0,
        color: COLORS[n.group % COLORS.length],
        isFixed: false
      };
    });

    setNodes(finalNodes);
    setLinks(newLinks);

    // Center the view initially
    setTransform({ x: 0, y: 0, k: 0.8 });

  }, [papers]);


  // --- 2. PHYSICS ENGINE ---
  const animate = useCallback(() => {
    if (!isSimulationRunning.current || isPaused) return;

    setNodes(prevNodes => {
      const updatedNodes = [...prevNodes];
      // Physics Constants
      const repulsion = 800; // Stronger separation
      const linkDistance = 100;
      const centerPull = 0.002;
      const clusterPull = 0.01;
      const damping = 0.85;

      const width = 800;
      const height = 600;

      // 1. Calculate Forces
      updatedNodes.forEach(node => {
        if (node.isFixed) return; // Don't move if dragged/fixed

        // A. Center Gravity (Weak global pull)
        node.vx += (width / 2 - node.x) * centerPull;
        node.vy += (height / 2 - node.y) * centerPull;

        // B. Cluster Gravity (Pull towards nodes of same group)
        // Find centroid of group
        let groupCx = 0, groupCy = 0, groupCount = 0;
        updatedNodes.forEach(other => {
          if (other.group === node.group) {
            groupCx += other.x;
            groupCy += other.y;
            groupCount++;
          }
        });
        if (groupCount > 0) {
          groupCx /= groupCount;
          groupCy /= groupCount;
          node.vx += (groupCx - node.x) * clusterPull;
          node.vy += (groupCy - node.y) * clusterPull;
        }

        // C. Repulsion (Node vs Node)
        updatedNodes.forEach(other => {
          if (node.id !== other.id) {
            const dx = node.x - other.x;
            const dy = node.y - other.y;
            let distSq = dx * dx + dy * dy;
            if (distSq === 0) distSq = 0.1; // prevent divide by zero
            const dist = Math.sqrt(distSq);

            // Standard repulsion
            if (dist < 400) {
              const force = repulsion / distSq;
              node.vx += (dx / dist) * force;
              node.vy += (dy / dist) * force;
            }

            // Hard Collision (Prevent Overlap)
            const minDist = node.radius + other.radius + 5;
            if (dist < minDist) {
              const overlap = minDist - dist;
              const dxNorm = dx / dist;
              const dyNorm = dy / dist;
              node.vx += dxNorm * overlap * 0.1;
              node.vy += dyNorm * overlap * 0.1;
            }
          }
        });
      });

      // D. Link Attraction
      links.forEach(link => {
        const source = updatedNodes[link.source];
        const target = updatedNodes[link.target];
        if (!source || !target) return;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        const force = (dist - linkDistance) * link.strength * 0.05;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (!source.isFixed) { source.vx += fx; source.vy += fy; }
        if (!target.isFixed) { target.vx -= fx; target.vy -= fy; }
      });

      // 2. Update Positions
      updatedNodes.forEach(node => {
        if (node.isFixed) return;

        node.vx *= damping;
        node.vy *= damping;
        node.x += node.vx;
        node.y += node.vy;
      });

      return updatedNodes;
    });

    requestRef.current = requestAnimationFrame(animate);
  }, [links, isPaused]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current!);
  }, [animate]);

  // --- 3. INTERACTION HANDLERS ---

  // Node Dragging
  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: number) => {
    e.stopPropagation();
    draggingNodeRef.current = nodeId;
    // Mark node as fixed so it stays where placed
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, isFixed: true, vx: 0, vy: 0 } : n));
  };

  // Canvas Pan & Node Drag Move
  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingNodeRef.current !== null) {
      // Dragging a Node
      const nodeId = draggingNodeRef.current;
      setNodes(prev => prev.map(n => {
        if (n.id === nodeId) {
          return {
            ...n,
            x: n.x + e.movementX / transform.k,
            y: n.y + e.movementY / transform.k
          };
        }
        return n;
      }));
    } else if (isDraggingCanvas) {
      // Panning the Canvas
      setTransform(prev => ({
        ...prev,
        x: prev.x + e.movementX,
        y: prev.y + e.movementY
      }));
    }
  };

  const handleMouseUp = () => {
    draggingNodeRef.current = null;
    setIsDraggingCanvas(false);
  };

  // Zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const scaleChange = e.deltaY * -0.001;
    const newScale = Math.min(Math.max(0.2, transform.k + scaleChange), 4);
    setTransform(prev => ({ ...prev, k: newScale }));
  };

  // Canvas Drag Start
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) { // Left click only
      setIsDraggingCanvas(true);
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  };

  // Toolbar Actions
  const handleZoomIn = () => setTransform(p => ({ ...p, k: Math.min(p.k * 1.2, 4) }));
  const handleZoomOut = () => setTransform(p => ({ ...p, k: Math.max(p.k / 1.2, 0.2) }));
  const handleReset = () => {
    setTransform({ x: 0, y: 0, k: 0.8 });
    setNodes(prev => prev.map(n => ({ ...n, isFixed: false })));
  };
  const toggleFullscreen = () => setIsFullscreen(!isFullscreen);
  const togglePause = () => setIsPaused(!isPaused);

  const handleSaveImage = () => {
    if (!containerRef.current) return;
    const svgElement = containerRef.current.querySelector('svg');
    if (!svgElement) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const data = (new XMLSerializer()).serializeToString(svgElement);
    const img = new Image();
    const svgBlob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      canvas.width = 1200;
      canvas.height = 900;
      if (ctx) {
        ctx.fillStyle = '#09090b'; // Background color
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, 1200, 900);

        const pngUrl = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = 'citation_network_map.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  // Determine which nodes should show labels
  // Show label if: Hovered, or Zoom > 1.2, or Node is "Important" (degree > 2)
  const shouldShowLabel = (node: GraphNode) => {
    if (hoveredNode?.id === node.id) return true;
    if (transform.k > 1.2) return true;
    if (node.degree > 1) return true; // Show labels for hubs by default
    return false;
  };


  return (
    <div
      ref={containerRef}
      className={`relative bg-zinc-950 overflow-hidden border border-zinc-800 transition-all duration-300 ${isFullscreen ? 'fixed inset-0 z-50 rounded-none' : 'w-full h-full rounded-lg'}`}
    >
      {/* Toolbar */}
      <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 bg-zinc-900/80 backdrop-blur p-2 rounded-lg border border-zinc-800 shadow-xl">
        <button onClick={handleZoomIn} className="p-2 hover:bg-zinc-700 rounded text-zinc-300" title="Zoom In"><ZoomIn className="w-4 h-4" /></button>
        <button onClick={handleZoomOut} className="p-2 hover:bg-zinc-700 rounded text-zinc-300" title="Zoom Out"><ZoomOut className="w-4 h-4" /></button>
        <button onClick={handleReset} className="p-2 hover:bg-zinc-700 rounded text-zinc-300" title="Reset View & Physics"><RefreshCw className="w-4 h-4" /></button>
        <div className="h-px bg-zinc-700 my-1"></div>
        <button onClick={togglePause} className={`p-2 hover:bg-zinc-700 rounded ${isPaused ? 'text-amber-500' : 'text-emerald-500'}`} title={isPaused ? "Resume Physics" : "Pause Physics"}>
          {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
        </button>
      </div>

      <div className="absolute top-4 right-4 z-10 flex gap-2">
        <button
          onClick={handleSaveImage}
          className="p-2 bg-zinc-900/80 backdrop-blur hover:bg-zinc-700 rounded-lg border border-zinc-800 text-zinc-300 shadow-xl flex items-center gap-2 text-xs font-bold"
        >
          <Camera className="w-4 h-4" /> Export Map
        </button>
        <button
          onClick={toggleFullscreen}
          className="p-2 bg-zinc-900/80 backdrop-blur hover:bg-zinc-700 rounded-lg border border-zinc-800 text-zinc-300 shadow-xl"
          title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 bg-zinc-900/80 backdrop-blur px-3 py-2 rounded-lg border border-zinc-800 pointer-events-none">
        <div className="flex items-center gap-2 mb-1">
          <Move className="w-3 h-3 text-zinc-400" />
          <span className="text-[10px] text-zinc-400">Pan: Drag Empty Space</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-zinc-500"></span>
          <span className="text-[10px] text-zinc-400">Drag nodes to fix position</span>
        </div>
      </div>

      <svg
        viewBox="0 0 800 600"
        className={`w-full h-full cursor-grab ${isDraggingCanvas ? 'cursor-grabbing' : ''}`}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Global Transform Group */}
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>

          {/* Links */}
          {links.map((link, i) => {
            const s = nodes[link.source];
            const t = nodes[link.target];
            if (!s || !t) return null;
            return (
              <line
                key={i}
                x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                stroke="#52525b"
                strokeWidth={1 + link.strength * 2}
                opacity={0.3}
              />
            )
          })}

          {/* Nodes */}
          {nodes.map((node) => (
            <g
              key={node.id}
              transform={`translate(${node.x},${node.y})`}
              onMouseEnter={() => setHoveredNode(node)}
              onMouseLeave={() => setHoveredNode(null)}
              onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
              className="cursor-pointer"
            >
              {/* Selection/Hover Halo */}
              {(hoveredNode?.id === node.id || node.isFixed) && (
                <circle
                  r={node.radius + 6}
                  fill={node.color}
                  opacity="0.3"
                  className="animate-pulse"
                />
              )}

              <circle
                r={node.radius}
                fill={node.color}
                stroke={node.isFixed ? "#fff" : "none"}
                strokeWidth={2}
                filter="url(#glow)"
              />

              {/* Index Label (Always Visible inside larger nodes) */}
              {node.radius > 12 && (
                <text
                  dy={4}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize={10}
                  fontWeight="bold"
                  className="pointer-events-none select-none"
                >
                  {node.id + 1}
                </text>
              )}

              {/* External Label (Conditional) */}
              {shouldShowLabel(node) && (
                <text
                  dy={-node.radius - 8}
                  textAnchor="middle"
                  fill={hoveredNode?.id === node.id ? "#fff" : node.color}
                  fontSize={14 / transform.k} // Dynamic font size based on zoom
                  fontWeight="bold"
                  className="pointer-events-none select-none drop-shadow-md bg-black"
                  style={{
                    textShadow: '0px 0px 4px rgba(0,0,0,0.9)',
                    opacity: hoveredNode?.id === node.id ? 1 : 0.8
                  }}
                >
                  {node.authors.split(',')[0].split(' ').pop()} ({node.year})
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>

      {/* Overlay Info Card */}
      {hoveredNode && !isDraggingCanvas && (
        <div className="absolute bottom-4 right-4 max-w-sm w-full bg-zinc-900/95 backdrop-blur border-l-4 border-l-current p-4 rounded-r-lg shadow-2xl animate-in slide-in-from-right-4 pointer-events-none" style={{ borderColor: hoveredNode.color }}>
          <h4 className="text-white font-bold text-sm mb-1">{hoveredNode.title}</h4>
          <div className="flex justify-between items-center text-xs text-zinc-400 mb-2">
            <span className="truncate max-w-[200px]">{hoveredNode.authors}</span>
            <span className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">{hoveredNode.year}</span>
          </div>
          <p className="text-[11px] text-zinc-500 line-clamp-3 leading-relaxed">
            {hoveredNode.summary}
          </p>
          <div className="mt-2 text-[10px] uppercase font-bold tracking-widest text-zinc-600 flex justify-between">
            <span>Cluster Group: {hoveredNode.group + 1}</span>
            <span>Connections: {hoveredNode.degree}</span>
          </div>
        </div>
      )}
    </div>
  );
};


const CitationButton: React.FC<CitationButtonProps> = ({ paper, index, onClick }) => (
  <button
    onClick={onClick}
    className="inline-flex items-center gap-0.5 mx-0.5 px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/40 hover:text-white transition-all cursor-pointer font-bold text-[10px] align-middle transform hover:scale-105"
    title={`View Reference: ${paper.title}`}
  >
    <Info className="w-3 h-3" />
    [{index + 1}]
  </button>
);

const ResultsView: React.FC<ResultsViewProps> = ({ librarianResult, dataResult, finalLatex, documents, setDocuments, onRegenerate, onGenerateReport, isRegenerating }) => {
  const [activeTab, setActiveTab] = useState<'paper' | 'gap' | 'sources' | 'data' | 'network'>('paper');
  const [copied, setCopied] = useState(false);
  const [gapCopied, setGapCopied] = useState(false);
  const [selectedCitation, setSelectedCitation] = useState<Paper | null>(null);
  const [fetchingAbstractId, setFetchingAbstractId] = useState<number | null>(null);

  // New State for Data Tab Management
  // Removed local 'documents' state, using props instead
  const [activeDataSubTab, setActiveDataSubTab] = useState<'charts' | 'docs'>('charts');
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const copyToClipboard = () => {
    if (finalLatex) {
      navigator.clipboard.writeText(finalLatex);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const copyGapToClipboard = () => {
    if (librarianResult?.researchGap) {
      navigator.clipboard.writeText(librarianResult.researchGap);
      setGapCopied(true);
      setTimeout(() => setGapCopied(false), 2000);
    }
  };

  const downloadReport = () => {
    if (!finalLatex) return;

    // Check format (LaTeX or Markdown) based on content
    const isLatex = finalLatex.includes('\\documentclass');
    const extension = isLatex ? 'tex' : 'md';
    const mimeType = isLatex ? 'application/x-latex' : 'text/markdown';

    const blob = new Blob([finalLatex], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `research_report.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadGapAnalysis = () => {
    if (!librarianResult?.researchGap) return;

    const blob = new Blob([librarianResult.researchGap], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'research_gap_analysis.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadSourcesAsCSV = () => {
    if (!librarianResult?.papers || librarianResult.papers.length === 0) return;

    // CSV Header
    const headers = ["Title", "Authors", "Year", "DOI", "URL", "Abstract"];

    // CSV Rows
    const rows = librarianResult.papers.map(p => {
      // Escape double quotes by doubling them (CSV standard) and wrap fields in quotes
      const safeTitle = `"${p.title.replace(/"/g, '""')}"`;
      const safeAuthors = `"${p.authors.replace(/"/g, '""')}"`;
      const safeSummary = `"${p.summary.replace(/"/g, '""')}"`;
      const safeDoi = `"${p.doi || ''}"`;
      const safeUrl = `"${p.url || ''}"`;

      return [safeTitle, safeAuthors, p.year, safeDoi, safeUrl, safeSummary].join(',');
    });

    const csvContent = "\uFEFF" + [headers.join(','), ...rows].join('\n'); // Add BOM for Excel compatibility

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'literature_sources.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- DOCUMENT DOWNLOAD LOGIC ---
  const handleDownloadPaper = async (paper: Paper, index: number) => {
    // 1. Check if already downloaded
    const existing = documents.find(d => d.paperId === index);
    if (existing) {
      setActiveTab('data');
      setActiveDataSubTab('docs');
      setSelectedDocId(existing.id);
      return;
    }

    setIsDownloading(true);
    setActiveTab('data');
    setActiveDataSubTab('docs');

    // Helper: Attempt to download from a specific URL
    const attemptDownload = async (targetUrl: string, isSciHub: boolean): Promise<DownloadedDocument | null> => {
      try {
        let response: Response;

        // A. FETCHING STRATEGY
        if (isSciHub || targetUrl.includes('sci-hub')) {
          // Sci-Hub Proxy Route
          const path = targetUrl.replace(/^https?:\/\/(www\.)?sci-hub\.[a-z]+(\/)?/, '');
          response = await fetch(`/api/scihub/${path}`);
        } else {
          // Standard URL - Try Direct first, then Generic Proxy
          try {
            const directCheck = await fetch(targetUrl, { method: 'HEAD' });
            if (directCheck.ok) {
              response = await fetch(targetUrl);
            } else {
              throw new Error("Direct fetch failed");
            }
          } catch (directError) {
            // Fallback to Proxy
            console.log(`Direct access to ${targetUrl} failed, trying proxy...`);
            response = await fetch(`/api/proxy?url=${encodeURIComponent(targetUrl)}`);
          }
        }

        if (!response || !response.ok) return null;

        const contentType = response.headers.get('content-type') || '';
        const docId = Math.random().toString(36).substring(7);

        // B. PROCESS RESPONSE (PDF vs HTML)
        if (contentType.includes('application/pdf') || contentType.includes('octet-stream')) {
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
          const extractedText = await extractTextFromPdf(blobUrl).catch(() => "");

          return {
            id: docId,
            paperId: index,
            title: paper.title,
            type: 'pdf',
            content: blobUrl,
            textContent: extractedText,
            originalUrl: targetUrl,
            timestamp: new Date().toLocaleTimeString()
          };
        }

        if (contentType.includes('text/html')) {
          // If we expected a PDF but got HTML (common with Sci-Hub or Publisher pages)
          // If this was a Sci-Hub attempt, try to scrape the PDF iframe
          const htmlText = await response.text();
          let finalHtml = htmlText;

          if (isSciHub || targetUrl.includes('sci-hub')) {
            const pdfSrcMatch = htmlText.match(/<iframe.*?src=["'](.*?)["']/i) || htmlText.match(/<embed.*?src=["'](.*?)["']/i);
            if (pdfSrcMatch && pdfSrcMatch[1]) {
              let pdfDirectUrl = pdfSrcMatch[1];
              if (pdfDirectUrl.startsWith('//')) pdfDirectUrl = 'https:' + pdfDirectUrl;
              if (!pdfDirectUrl.includes('sci-hub')) {
                const mirrorBase = SCI_HUB_MIRRORS[0];
                if (pdfDirectUrl.startsWith('/')) pdfDirectUrl = mirrorBase + pdfDirectUrl;
              }
              // Recursively try to download the scraped PDF link
              return attemptDownload(pdfDirectUrl, true);
            }
          }

          // If it's a regular Publisher HTML page, we still save it, but maybe prioritize Sci-Hub later?
          // For now, return the HTML doc.

          // INJECT BASE TAG TO FIX RELATIVE LINKS
          try {
            const urlObj = new URL(targetUrl);
            const baseTag = `<base href="${urlObj.origin}" target="_blank">`;
            // Try to inject after head, otherwise prepend to body or just at start
            if (finalHtml.includes('<head>')) {
              finalHtml = finalHtml.replace('<head>', `<head>${baseTag}`);
            } else {
              finalHtml = `${baseTag}${finalHtml}`;
            }
          } catch (e) {
            console.warn("Could not inject base tag", e);
          }

          // STRIP SCRIPTS TO PREVENT SANDBOX ERRORS
          finalHtml = finalHtml.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gm, "");

          return {
            id: docId,
            paperId: index,
            title: paper.title,
            type: 'html',
            content: finalHtml,
            textContent: htmlText.replace(/<[^>]*>?/gm, ' ').substring(0, 10000),
            originalUrl: targetUrl,
            timestamp: new Date().toLocaleTimeString()
          };
        }

        return null;

      } catch (e) {
        console.warn(`Attempt failed for ${targetUrl}:`, e);
        return null;
      }
    };

    try {
      let finalDoc: DownloadedDocument | null = null;

      // ATTEMPT 1: Verified Source URL (The Green Button Link)
      // We only skip this if it's a generic DOI link which we know needs Sci-Hub
      const isGenericDoi = paper.url && paper.url.includes('doi.org');

      if (paper.url && !isGenericDoi) {
        console.log("Attempt 1: Verified Source URL", paper.url);
        finalDoc = await attemptDownload(paper.url, false);
      }

      // ATTEMPT 2: Sci-Hub Fallback
      // If Attempt 1 failed OR returned HTML (when we might prefer a Real PDF), OR if Attempt 1 was skipped
      // Note: If Attempt 1 gave us HTML, we might still want to try Sci-Hub to see if we can get a PDF.
      // But for now, if Attempt 1 succeeded with HTML, we keep it, UNLESS the user explicitly wants PDF priority.
      // Let's assume if Attempt 1 returned NULL, we try Sci-Hub.

      if ((!finalDoc || finalDoc.type === 'html') && paper.doi) {
        console.log("Attempt 2: Sci-Hub Fallback");
        const sciHubUrl = `${SCI_HUB_MIRRORS[0]}/${paper.doi}`;
        const sciHubDoc = await attemptDownload(sciHubUrl, true);

        // If Sci-Hub gave us a PDF, definitely use that over any HTML we might have found
        if (sciHubDoc && sciHubDoc.type === 'pdf') {
          finalDoc = sciHubDoc;
        } else if (!finalDoc && sciHubDoc) {
          finalDoc = sciHubDoc; // Use Sci-Hub HTML if we had nothing else
        }
      }

      if (finalDoc) {
        setDocuments(prev => [...prev, finalDoc!]);
        setSelectedDocId(finalDoc.id);
      } else {
        // Ultimate Fallback: Just Link
        throw new Error("All download attempts failed");
      }

    } catch (error) {
      console.error("All strategies failed", error);
      const docId = Math.random().toString(36).substring(7);
      const newDoc: DownloadedDocument = {
        id: docId,
        paperId: index,
        title: paper.title,
        type: 'link',
        content: paper.url || "",
        originalUrl: paper.url || "",
        timestamp: new Date().toLocaleTimeString()
      };
      setDocuments(prev => [...prev, newDoc]);
      setSelectedDocId(docId);
    } finally {
      setIsDownloading(false);
    }
  };

  const removeDocument = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDocuments(prev => prev.filter(d => d.id !== id));
    if (selectedDocId === id) setSelectedDocId(null);
  };

  const handleFetchAbstract = async (paper: Paper, index: number) => {
    setFetchingAbstractId(index);
    try {
      const fullAbstract = await fetchAbstractFromUrl(paper.url, 'gemini'); // Default to gemini for speed
      if (fullAbstract && fullAbstract.length > 50) {
        if (librarianResult) {
          librarianResult.papers[index].summary = fullAbstract; // Mutate local result for immediate view
        }
      }
    } catch (e) {
      console.error("Failed to fetch abstract", e);
    } finally {
      setFetchingAbstractId(null);
    }
  };


  // Function to parse LaTeX and make \cite{refX} clickable (Also handles [Index] style for MD)
  const renderInteractiveText = (text: string) => {
    // 4. Handle Bibliography Anchors: [[REF:123]]
    // Logic: Identify lines starting with [[REF:123]] and wrap them in an ID'd element.
    const refParts = text.split(/(\[\[\s*REF:\d+\s*\]\])/g);
    if (refParts.length > 1) {
      return refParts.map((part, index) => {
        const match = part.match(/\[\[\s*REF:(\d+)\s*\]\]/);
        if (match) {
          const id = match[1];
          return (
            <span key={index} id={`ref-${id}`} className="font-bold text-indigo-400 select-none mr-2 scroll-mt-24">
              [{id}]
            </span>
          );
        }

        // Recursively process regular text for links and IDs
        return processTextContent(part, index);
      });
    }

    return processTextContent(text, 0);
  };

  const processTextContent = (text: string, baseIndex: number) => {
    // 1. Handle LaTeX style: \cite{refX}
    const latexParts = text.split(/(\\cite\{ref\d+\})/g);
    if (latexParts.length > 1) {
      return latexParts.map((part, index) => {
        const match = part.match(/\\cite\{ref(\d+)\}/);
        if (match && librarianResult) {
          const id = parseInt(match[1], 10);
          const paperIndex = id - 1; // FIX: 1-based ID from text -> 0-based Array Index
          const paper = librarianResult.papers[paperIndex];
          if (paper) {
            return <CitationButton key={`${baseIndex}-latex-${index}`} paper={paper} index={paperIndex} onClick={() => setSelectedCitation(paper)} />;
          }
        }
        return <span key={`${baseIndex}-latex-${index}`}>{part}</span>;
      });
    }

    // 2. Handle Citation Links: [ID: 1]
    const mdParts = text.split(/(\[\s*ID:\s*\d+\s*\])/g);

    return mdParts.map((part, index) => {
      const match = part.match(/\[\s*ID:\s*(\d+)\s*\]/);
      if (match) {
        const id = match[1];
        return (
          <button
            key={`${baseIndex}-md-${index}`}
            onClick={() => {
              const el = document.getElementById(`ref-${id}`);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className="inline-flex items-center mx-1 px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/20 cursor-pointer text-[10px] font-bold transition-colors"
          >
            [{id}]
          </button>
        );
      }

      // 3. Handle URLs within the text parts
      const urlParts = part.split(/((?:https?:\/\/[^\s]+)(?<![.,)\]]))/g);
      return (
        <span key={`${baseIndex}-url-${index}`}>
          {urlParts.map((subPart, subIndex) => {
            if (subPart.match(/^https?:\/\//)) {
              return (
                <a
                  key={subIndex}
                  href={subPart}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-400 hover:text-cyan-300 underline break-all"
                >
                  {subPart}
                </a>
              );
            }
            return subPart;
          })}
        </span>
      );
    });
  };

  const selectedDoc = documents.find(d => d.id === selectedDocId);

  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden backdrop-blur flex flex-col h-full relative">

      {/* Citation Detail Overlay */}
      {selectedCitation && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[80%]">
            <div className="flex justify-between items-start p-4 border-b border-zinc-800 bg-zinc-800/50">
              <div>
                <h3 className="font-serif font-bold text-white text-lg leading-tight">{selectedCitation.title}</h3>
                <p className="text-zinc-400 text-xs font-mono mt-1">{selectedCitation.authors} ({selectedCitation.year})</p>
              </div>
              <button onClick={() => setSelectedCitation(null)} className="text-zinc-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto">
              <h4 className="text-xs font-bold text-indigo-400 uppercase tracking-widest mb-2">Cited Context / Summary</h4>
              <p className="text-sm text-zinc-300 leading-relaxed bg-zinc-950/50 p-3 rounded border border-zinc-800/50">
                "{selectedCitation.summary}"
              </p>
              <div className="mt-4 pt-4 border-t border-zinc-800 flex justify-end">
                <a
                  href={selectedCitation.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 rounded transition-colors shadow-lg shadow-emerald-500/20"
                >
                  <ShieldCheck className="w-3 h-3" /> Verified Source
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 overflow-x-auto">
        <button
          onClick={() => setActiveTab('paper')}
          className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${activeTab === 'paper' ? 'bg-zinc-800/50 text-white border-b-2 border-indigo-500' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/20'
            }`}
        >
          <FileText className="w-4 h-4" /> Final Report
        </button>
        <button
          onClick={() => setActiveTab('gap')}
          className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${activeTab === 'gap' ? 'bg-zinc-800/50 text-white border-b-2 border-amber-500' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/20'
            }`}
        >
          <Sparkles className="w-4 h-4" /> Research Gap
        </button>
        <button
          onClick={() => setActiveTab('sources')}
          className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${activeTab === 'sources' ? 'bg-zinc-800/50 text-white border-b-2 border-purple-500' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/20'
            }`}
        >
          <BookOpen className="w-4 h-4" /> Sources
          {librarianResult?.papers.length ? <span className="text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded-full">{librarianResult.papers.length}</span> : null}
        </button>
        <button
          onClick={() => setActiveTab('data')}
          className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${activeTab === 'data' ? 'bg-zinc-800/50 text-white border-b-2 border-cyan-500' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/20'
            }`}
        >
          <Database className="w-4 h-4" /> Data & Docs
          {documents.length > 0 && <span className="text-[10px] bg-cyan-900 text-cyan-200 px-1.5 py-0.5 rounded-full">{documents.length}</span>}
        </button>
        <button
          onClick={() => setActiveTab('network')}
          className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${activeTab === 'network' ? 'bg-zinc-800/50 text-white border-b-2 border-pink-500' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/20'
            }`}
        >
          <Network className="w-4 h-4" /> Network
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-zinc-950">

        {/* Report / Paper View */}
        {activeTab === 'paper' && (
          <div className="relative">
            {finalLatex ? (
              <>
                <div className="absolute top-0 right-0 z-10 flex gap-2">
                  {/* REGENERATE BUTTON */}
                  {documents.length > 0 && (
                    <button
                      onClick={onRegenerate}
                      disabled={isRegenerating}
                      className="flex items-center gap-2 bg-gradient-to-r from-indigo-900 to-purple-900 hover:from-indigo-800 hover:to-purple-800 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-all border border-indigo-500/30 shadow-lg shadow-indigo-500/20"
                      title="Regenerate Report using FULL TEXT from Downloaded Docs"
                    >
                      <RefreshCcw className={`w-3 h-3 ${isRegenerating ? 'animate-spin' : ''}`} />
                      {isRegenerating ? 'Analyzing Full Text...' : 'Regenerate from Downloads'}
                    </button>
                  )}

                  <button
                    onClick={downloadReport}
                    className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-colors border border-zinc-700"
                    title="Download Report"
                  >
                    <Download className="w-3 h-3" />
                  </button>
                  <button
                    onClick={copyToClipboard}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-colors shadow-lg shadow-indigo-500/20"
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'COPIED' : 'COPY'}
                  </button>
                </div>
                <div className="font-mono text-xs md:text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed pr-2 pt-8">
                  {renderInteractiveText(finalLatex)}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 mt-20 space-y-4">
                <FileText className="w-16 h-16 text-zinc-700" />
                <div className="text-center">
                  <h3 className="text-xl font-bold text-zinc-300 mb-1">Final Report Generation</h3>
                  <p className="text-zinc-500 text-sm max-w-md mx-auto">
                    The Autonomous Agent has indexed the sources. You can now generate a detailed bibliographic report including summaries and APA citations.
                  </p>
                </div>

                <button
                  onClick={onGenerateReport}
                  disabled={isRegenerating || !librarianResult?.papers || librarianResult?.papers.length === 0}
                  className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white px-8 py-3 rounded-xl font-bold flex items-center gap-3 transition-all shadow-xl shadow-indigo-500/20 disabled:opacity-50 disabled:cursor-not-allowed transform hover:scale-105"
                >
                  {isRegenerating ? <Loader className="animate-spin w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
                  {isRegenerating ? 'Writing Detailed Report...' : 'Generate Final Report'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* GAP ANALYSIS VIEW */}
        {activeTab === 'gap' && (
          <div className="h-full relative">
            {librarianResult ? (
              <div className="space-y-4">
                {/* Action Buttons */}
                <div className="absolute top-0 right-0 z-10 flex gap-2">
                  <button
                    onClick={downloadGapAnalysis}
                    className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-colors border border-zinc-700 shadow-lg"
                    title="Download Gap Analysis"
                  >
                    <Download className="w-3 h-3" />
                  </button>
                  <button
                    onClick={copyGapToClipboard}
                    className="flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-colors shadow-lg shadow-amber-500/20"
                  >
                    {gapCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {gapCopied ? 'COPIED' : 'COPY'}
                  </button>
                </div>

                <div className="bg-gradient-to-br from-amber-900/20 to-orange-900/10 border border-amber-500/20 p-6 rounded-xl">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 bg-amber-500/20 rounded-lg text-amber-500">
                      <Sparkles className="w-6 h-6" />
                    </div>
                    <h3 className="text-xl font-bold text-white">Research Gap Analysis</h3>
                  </div>

                  <div className="text-zinc-200 leading-relaxed space-y-4 font-serif text-sm md:text-base pt-2">
                    {librarianResult.researchGap.split('\n').map((paragraph, idx) => (
                      <p key={idx}>{paragraph}</p>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 opacity-50 mt-20">
                <Sparkles className="w-12 h-12 mb-4" />
                <p>Gap Analysis requires Librarian completion...</p>
              </div>
            )}
          </div>
        )}

        {/* DATA & DOCS VIEW */}
        {activeTab === 'data' && (
          <div className="h-full flex flex-col md:flex-row gap-4">

            {/* Sidebar / Sub-navigation */}
            <div className="w-full md:w-64 flex flex-col gap-2 shrink-0 border-r border-zinc-800 pr-4">
              <button
                onClick={() => setActiveDataSubTab('charts')}
                className={`p-3 rounded-lg text-left text-xs font-bold flex items-center gap-2 transition-all ${activeDataSubTab === 'charts' ? 'bg-zinc-800 text-white border-l-2 border-cyan-500' : 'text-zinc-400 hover:bg-zinc-900'}`}
              >
                <BarChart size={14} /> Statistical Analysis
              </button>

              <div className="flex items-center gap-2 mt-4 mb-2 text-xs font-mono text-zinc-500 uppercase tracking-widest px-2">
                <span>Library ({documents.length})</span>
                {isDownloading && <Loader size={10} className="animate-spin text-cyan-500" />}
              </div>

              <div className="flex flex-col gap-2 overflow-y-auto max-h-[400px] custom-scrollbar">
                {documents.length === 0 ? (
                  <div className="text-[10px] text-zinc-600 italic px-2">
                    No documents downloaded yet. Go to 'Sources' and click 'Download Data'.
                  </div>
                ) : (
                  documents.map((doc) => (
                    <div
                      key={doc.id}
                      onClick={() => { setActiveDataSubTab('docs'); setSelectedDocId(doc.id); }}
                      className={`group p-2 rounded cursor-pointer border transition-all ${selectedDocId === doc.id && activeDataSubTab === 'docs' ? 'bg-cyan-900/20 border-cyan-500/50' : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'}`}
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex items-start gap-2">
                          <File size={14} className={doc.type === 'pdf' ? 'text-red-400 mt-0.5' : 'text-emerald-400 mt-0.5'} />
                          <div>
                            <div className={`text-xs font-medium line-clamp-2 ${selectedDocId === doc.id && activeDataSubTab === 'docs' ? 'text-cyan-100' : 'text-zinc-300'}`}>
                              {doc.title}
                            </div>
                            <div className="text-[10px] text-zinc-500 mt-1">{doc.timestamp}</div>
                            {doc.textContent && doc.textContent.length > 0 && (
                              <div className="text-[9px] text-emerald-500 flex items-center gap-1 mt-0.5">
                                <Check size={8} /> Text Extracted
                              </div>
                            )}
                          </div>
                        </div>
                        <button onClick={(e) => removeDocument(doc.id, e)} className="text-zinc-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 h-full min-h-[400px] bg-zinc-900/30 rounded-lg border border-zinc-800/50 relative overflow-hidden">

              {/* 1. CHART VIEW */}
              {activeDataSubTab === 'charts' && (
                dataResult ? (
                  <div className="flex flex-col h-full p-4">
                    <div className="flex-1 min-h-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={dataResult.chartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                          <XAxis dataKey="name" stroke="#71717a" fontSize={12} tickLine={false} />
                          <YAxis stroke="#71717a" fontSize={12} tickLine={false} label={{ value: dataResult.yAxisLabel, angle: -90, position: 'insideLeft', fill: '#71717a' }} />
                          <Tooltip
                            contentStyle={{ backgroundColor: '#18181b', borderColor: '#3f3f46', color: '#fff' }}
                            itemStyle={{ color: '#fff' }}
                          />
                          <Legend />
                          <Bar dataKey="value" fill="#06b6d4" radius={[4, 4, 0, 0]} name={dataResult.yAxisLabel} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-4 p-4 bg-zinc-900/80 rounded border border-zinc-800 text-sm text-zinc-300 h-32 overflow-y-auto">
                      <h4 className="text-cyan-400 font-bold mb-2 font-mono text-xs uppercase">Analysis</h4>
                      {dataResult.analysis}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-zinc-500 opacity-50">
                    <Database className="w-12 h-12 mb-4" />
                    <p>No statistical data generated.</p>
                  </div>
                )
              )}

              {/* 2. DOC VIEWER */}
              {activeDataSubTab === 'docs' && (
                selectedDoc ? (
                  <div className="h-full flex flex-col">
                    <div className="h-8 flex items-center justify-between px-3 bg-zinc-900 border-b border-zinc-800">
                      <span className="text-xs text-zinc-400 truncate max-w-[300px]">{selectedDoc.title}</span>
                      <a href={selectedDoc.originalUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300">
                        Open Original <ExternalLink size={10} />
                      </a>
                    </div>
                    <div className="flex-1 bg-white relative">
                      {selectedDoc.type === 'pdf' ? (
                        <iframe src={selectedDoc.content} className="w-full h-full border-none" title="PDF Viewer" />
                      ) : (
                        selectedDoc.type === 'html' ? (
                          <iframe srcDoc={selectedDoc.content} className="w-full h-full border-none" title="HTML Viewer" sandbox="allow-same-origin allow-scripts" />
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full bg-zinc-100 text-zinc-800 p-8 text-center">
                            <Info className="w-12 h-12 mb-4 text-zinc-400" />
                            <h3 className="font-bold mb-2">External Link Saved</h3>
                            <p className="text-sm mb-4">This document could not be embedded due to publisher security settings.</p>
                            <a href={selectedDoc.content} target="_blank" rel="noopener noreferrer" className="bg-indigo-600 text-white px-4 py-2 rounded text-sm hover:bg-indigo-700 transition-colors">
                              Open in New Tab
                            </a>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-zinc-500 opacity-50">
                    <File className="w-12 h-12 mb-4" />
                    <p>Select a document from the Library.</p>
                  </div>
                )
              )}

            </div>
          </div>
        )}

        {/* NETWORK VIEW */}
        {activeTab === 'network' && (
          <div className="h-full min-h-[500px]">
            {librarianResult && librarianResult.papers.length > 0 ? (
              <CitationGraph papers={librarianResult.papers} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 opacity-50 mt-20">
                <Network className="w-12 h-12 mb-4" />
                <p>Waiting for papers to generate network map...</p>
              </div>
            )}
          </div>
        )}

        {/* Sources View */}
        {activeTab === 'sources' && (
          <div className="space-y-4">
            {librarianResult ? (
              <>
                <div className="flex justify-between items-center mb-2">
                  <h4 className="text-zinc-400 font-mono text-xs uppercase tracking-widest">
                    Indexed Corpus ({librarianResult.papers.length})
                  </h4>

                  <button
                    onClick={downloadSourcesAsCSV}
                    className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-colors border border-zinc-700 shadow-lg"
                    title="Download all sources as CSV"
                  >
                    <FileSpreadsheet className="w-3 h-3 text-emerald-400" /> Download CSV
                  </button>
                </div>
                <div className="space-y-3">
                  {librarianResult.papers.length === 0 ? (
                    <div className="text-zinc-500 text-center py-8">
                      No verified public sources found for this topic. <br /> Try providing a local context file instead.
                    </div>
                  ) : (
                    librarianResult.papers.map((paper, idx) => (
                      <div key={idx} className="bg-zinc-900/30 p-4 rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors">
                        <h5 className="font-serif font-bold text-zinc-200 mb-1">
                          <span className="text-indigo-400 font-mono mr-2">[{idx + 1}]</span>
                          {paper.title}
                        </h5>
                        <p className="text-xs font-mono text-zinc-500 mb-2">{paper.authors} ({paper.year})</p>
                        <div className="relative group/abstract">
                          <p className={`text-sm text-zinc-400 mb-2 transition-all duration-300 ${paper.summary.length > 300 ? 'line-clamp-2 hover:line-clamp-none cursor-pointer bg-zinc-900/50 p-2 rounded hover:bg-zinc-800' : ''}`} title="Hover to expand">
                            {paper.summary}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-zinc-800/50">
                          <a
                            href={paper.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] bg-emerald-900/20 text-emerald-400 hover:text-white hover:bg-emerald-600 px-2 py-1 rounded border border-emerald-500/30 transition-colors cursor-pointer flex items-center gap-1.5"
                          >
                            <ShieldCheck size={12} /> Source
                            <ExternalLink size={10} className="opacity-70" />
                          </a>

                          {paper.doi && (
                            <span className="text-[10px] font-mono text-zinc-500 select-all border border-zinc-800 bg-zinc-950 px-2 py-1 rounded">
                              DOI: {paper.doi}
                            </span>
                          )}

                          <button
                            onClick={() => handleFetchAbstract(paper, idx)}
                            disabled={fetchingAbstractId === idx}
                            className="text-[10px] bg-amber-900/20 text-amber-500 hover:text-white hover:bg-amber-600 px-2 py-1 rounded border border-amber-500/30 transition-colors cursor-pointer flex items-center gap-1.5"
                            title="Scrape Full Abstract from URL"
                          >
                            {fetchingAbstractId === idx ? <Loader size={12} className="animate-spin" /> : <Sparkles size={12} />}
                            {fetchingAbstractId === idx ? 'Scraping...' : 'Fetch Abstract'}
                          </button>

                          {paper.doi && (
                            <a
                              href={`https://sci-hub.se/${paper.doi}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] bg-indigo-900/20 text-indigo-400 hover:text-white hover:bg-indigo-600 px-2 py-1 rounded border border-indigo-500/30 transition-colors cursor-pointer flex items-center gap-1.5"
                              title="Access PDF via Sci-Hub"
                            >
                              <Unlock size={12} /> Sci-Hub
                            </a>
                          )}

                          <div className="flex-1"></div>

                          <button
                            onClick={() => handleDownloadPaper(paper, idx)}
                            disabled={isDownloading}
                            className="text-[10px] flex items-center gap-1.5 bg-zinc-800 hover:bg-cyan-900/40 hover:text-cyan-400 text-zinc-400 px-3 py-1 rounded border border-zinc-700 transition-all group disabled:opacity-50"
                            title="Extract Data to Workspace"
                          >
                            {isDownloading ? <Loader size={12} className="animate-spin" /> : <Download size={12} className="group-hover:animate-bounce" />}
                            Download Data
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 opacity-50 mt-20">
                <BookOpen className="w-12 h-12 mb-4" />
                <p>Waiting for Librarian search...</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ResultsView;