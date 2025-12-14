import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LibrarianResult, DataScientistResult, Paper, DownloadedDocument } from '../types';
import { extractTextFromPdf, fetchAbstractFromUrl, getDefaultReportPrompt } from '../services/geminiService';
import { storageService } from '../services/storageService';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import {
  FileText, Database, BookOpen, Copy, Check, ExternalLink, Info, X,
  ShieldCheck, Download, Sparkles, Network, Maximize2, Minimize2,
  ZoomIn, ZoomOut, RefreshCw, Camera, Move, Pause, Play, FileSpreadsheet,
  ArrowRight, Loader, File, Trash2, Unlock, RefreshCcw, Edit3, MessageSquare
} from 'lucide-react';

// GLOBAL STATE TO PERSIST ACROSS HMR (Prevents loops on code save)
// This must be outside the component to survive re-renders and HMR updates
const globalVisitedUrls = new Set<string>();
let isGlobalLoopRunning = false;

// CIRCUIT BREAKER: Stop calling Semantic Reader if it persistently fails (202)
let semanticReaderFailCount = 0;
const SEMANTIC_READER_FAIL_THRESHOLD = 3; // Trip after 3 consecutive 202s
let isSemanticReaderDisabled = false;

// SAFE STORAGE WRAPPER (Prevents "Access to storage not allowed" errors)
const safeStorage = {
  getItem: (key: string) => {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  },
  setItem: (key: string, value: string) => {
    try { sessionStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }
};

interface ResultsViewProps {
  librarianResult: LibrarianResult | null;
  dataResult: DataScientistResult | null;
  finalLatex: string | null;
  documents: DownloadedDocument[];
  setDocuments: React.Dispatch<React.SetStateAction<DownloadedDocument[]>>;
  onRegenerate: () => void;
  onGenerateReport: () => void;
  isRegenerating: boolean;
  // AI Context
  apiKey: string;
  provider: string; // 'gemini' | 'ollama'
  ollamaConfig?: { model: string; baseUrl: string };
  addLog: (agent: string, message: string, type: 'info' | 'success' | 'warning' | 'error' | 'working') => void;
  onGenerateGapAnalysis: (customPrompt?: string) => void;
}

interface CitationButtonProps {
  paper: Paper;
  index: number;
  ollamaConfig?: { model: string; baseUrl: string };
  addLog: (agent: string, message: string, type: 'info' | 'success' | 'warning' | 'error' | 'working') => void;
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

const ResultsView: React.FC<ResultsViewProps> = ({
  librarianResult,
  dataResult,
  finalLatex,
  documents,
  setDocuments,
  onRegenerate,
  onGenerateReport,
  onGenerateGapAnalysis,
  isRegenerating,
  apiKey,
  provider,
  ollamaConfig,
  addLog
}) => {
  // --- PERSISTENCE: Load Documents ---
  useEffect(() => {
    storageService.getAllDocuments().then(docs => {
      if (docs && docs.length > 0) {
        console.log(`[Storage] Loaded ${docs.length} documents.`);
        setDocuments(prev => {
          // Merge: only add if not already in state
          const existingIds = new Set(prev.map(d => d.id));
          const newDocs = docs.filter(d => !existingIds.has(d.id));
          return [...prev, ...newDocs];
        });
      }
    });
  }, []);

  const [activeTab, setActiveTab] = useState<'paper' | 'gap' | 'sources' | 'data' | 'network'>('paper');
  const [copied, setCopied] = useState(false);
  const [gapCopied, setGapCopied] = useState(false);
  const [selectedCitation, setSelectedCitation] = useState<Paper | null>(null);
  const [fetchingAbstractId, setFetchingAbstractId] = useState<number | null>(null);
  const [enhancedSummaries, setEnhancedSummaries] = useState<{ [key: number]: string }>({});

  // PROMPT EDITOR STATE
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [promptText, setPromptText] = useState('');

  // GAP PROMPT STATE
  const [showGapPromptModal, setShowGapPromptModal] = useState(false);
  const [gapPromptText, setGapPromptText] = useState(`
  Analyze the provided academic papers on the topic and identify critical research gaps.
  
  Your Output must be in Markdown format with the following structure:
  ## Research Gaps in Current Literature
  [Analyze 3-5 major gaps where information is missing, inconsistent, or outdated]
  
  ## Proposed Future Research Directions
  [Suggest specific research questions or methodologies to address these gaps]
  
  ## Methodology Limitations
  [Identify common limitations in the reviewed studies]
  `.trim());

  const openPromptModal = () => {
    if (!librarianResult?.papers) return;
    // We use a placeholder for topic since it's not passed, user can edit it.
    const defaultP = getDefaultReportPrompt("RESEARCH TOPIC", librarianResult.papers.length);
    setPromptText(defaultP);
    setShowPromptModal(true);
  };

  // SAFE AUTOMATIC FETCHER
  useEffect(() => {
    return; // OTOMATİK VERİ ÇEKME DEVRE DIŞI BIRAKILDI (Kullanıcı İsteği - Hafıza/Döngü Sorunu)

    if (!librarianResult?.papers || librarianResult.papers.length === 0) return;
    if (isGlobalLoopRunning) return; // Prevent double-firing

    let isMounted = true;
    const papers = librarianResult.papers;

    const fetchSequence = async () => {
      isGlobalLoopRunning = true;
      let fetchCount = 0;
      let consecutiveErrors = 0; // Kill switch for network disconnects
      const MAX_AUTO_FETCH = 50;
      const DELAY_MS = 5000;

      // PERSISTENCE: Try to load, but fallback to memory if blocked
      let visitedSet = new Set<string>(); // Local working set

      // 1. Merge global memory (HMR survival)
      globalVisitedUrls.forEach(url => visitedSet.add(url));

      // 2. Merge session storage (Reload survival)
      try {
        const stored = safeStorage.getItem('processed_paper_ids');
        if (stored) {
          const storedList = JSON.parse(stored);
          storedList.forEach((url: string) => visitedSet.add(url));
          storedList.forEach((url: string) => globalVisitedUrls.add(url)); // Sync back to global
        }
      } catch (e) {
        console.warn("SessionStorage blocked. Using in-memory tracking only.");
      }

      console.log(`[Auto-Fetch] Starting... (Processed so far: ${visitedSet.size})`);

      for (let i = 0; i < papers.length; i++) {
        if (!isMounted) break;
        if (fetchCount >= MAX_AUTO_FETCH) break;

        // KILL SWITCH: If 3 in a row fail (likely network down or banned), STOP.
        if (consecutiveErrors >= 3) {
          console.error("[Auto-Fetch] Too many consecutive errors. Aborting sequence.");
          break;
        }

        const paper = papers[i];
        const uniqueKey = paper.url || paper.title;

        // CRITICAL SAFETY CHECK (Persistent)
        if (visitedSet.has(uniqueKey) || globalVisitedUrls.has(uniqueKey)) {
          // Check if we actually have text for it in the UI, if not, maybe we skip?
          // The user wants "stop loops", so we strictly respect the visited flag.
          continue;
        }

        // SMART CHECK
        const currentText = paper.summary || "";
        const isSuspiciousAndNeedsFetch =
          currentText.length < 500 ||
          currentText.trim().endsWith("...") ||
          currentText.trim().endsWith("…") ||
          currentText.toUpperCase().startsWith("TLDR") ||
          currentText.includes("No abstract available");

        if (enhancedSummaries[i] || (!isSuspiciousAndNeedsFetch)) {
          visitedSet.add(uniqueKey);
          globalVisitedUrls.add(uniqueKey);
          // Try to save to storage (Safe Logic)
          try {
            safeStorage.setItem('processed_paper_ids', JSON.stringify(Array.from(visitedSet)));
          } catch (e) { /* Ignore storage errors */ }
          continue;
        }

        // FOUND ONE TO FETCH - Mark it immediately
        visitedSet.add(uniqueKey);
        globalVisitedUrls.add(uniqueKey);

        // Try to save to storage (Safe Logic)
        try {
          safeStorage.setItem('processed_paper_ids', JSON.stringify(Array.from(visitedSet)));
        } catch (e) { /* Ignore storage errors */ }

        setFetchingAbstractId(i);
        fetchCount++;

        console.log(`[Auto-Fetch] Processing ${i + 1}/${papers.length}: ${paper.title.substring(0, 30)}...`);

        try {
          // Attempt Fetch
          let fullAbstract = await fetchAbstractFromUrl(
            paper.url,
            provider as any,
            provider === 'ollama' ? ollamaConfig : undefined,
            apiKey
          );

          // Fallback logic for Semantic Reader
          if ((!fullAbstract || fullAbstract === "NO_ABSTRACT_FOUND" || fullAbstract.length < 100) && paper.semanticReaderLink) {
            const idMatch = paper.semanticReaderLink.match(/reader\/([a-f0-9]+)/);
            if (idMatch && idMatch[1]) {
              const fallbackUrl = `https://www.semanticscholar.org/paper/${idMatch[1]}`;
              console.log("[Auto-Fetch] Trying Semantic Reader Fallback...");
              await new Promise(r => setTimeout(r, 2000));
              fullAbstract = await fetchAbstractFromUrl(
                fallbackUrl,
                provider as any,
                provider === 'ollama' ? ollamaConfig : undefined,
                apiKey
              );
            }
          }

          if (isMounted) {
            if (!fullAbstract || fullAbstract === "NO_ABSTRACT_FOUND") {
              console.log(`[Auto-Fetch] Abstract not found for ${i}, using fallback summary.`);
              fullAbstract = paper.summary || "Abstract not available.";
            } else {
              // Success! Reset consecutive errors
              consecutiveErrors = 0;
            }
            setEnhancedSummaries(prev => ({ ...prev, [i]: fullAbstract! }));
          }

        } catch (e) {
          console.error("Auto-fetch error", e);
          consecutiveErrors++; // Result: +1 error

          if (isMounted) {
            setEnhancedSummaries(prev => ({ ...prev, [i]: paper.summary || "Fetch failed." }));
          }
          console.log("[Auto-Fetch] Backing off...");
          await new Promise(r => setTimeout(r, 5000));
        }

        if (i < papers.length - 1) {
          await new Promise(r => setTimeout(r, DELAY_MS));
        }
      }

      if (isMounted) {
        setFetchingAbstractId(null);
        // Loop finished.
        // We intentionally do NOT reset isGlobalLoopRunning here immediately to prevent HMR restart?
        // Actually, we must allow restart if the user starts a NEW search.
        // ideally isGlobalLoopRunning should be tied to 'librarianResult' ID, but for now:
        isGlobalLoopRunning = false;
      }
    };

    // DISABLED: Auto-fetch was causing infinite request loops after search completion
    // fetchSequence();
    console.log("[Auto-Fetch] DISABLED to prevent infinite loops. User must manually trigger abstract fetch if needed.");

    return () => { isMounted = false; };
  }, [librarianResult, apiKey, provider]);

  // New State for Data Tab Management
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [activeDataSubTab, setActiveDataSubTab] = useState<'charts' | 'docs'>('charts');
  const [selectedPaperIndices, setSelectedPaperIndices] = useState<Set<number>>(new Set());
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
    URL.revokeObjectURL(url);
  };

  // --- DOCUMENT DOWNLOAD LOGIC ---

  // GLOBAL REQUEST LIMITER - Prevents ANY repeated requests
  const globalFetchedUrls = React.useRef<Set<string>>(new Set());
  const globalRequestCount = React.useRef<number>(0);
  const MAX_REQUESTS_PER_DOWNLOAD = 10; // Hard limit

  const handleDownloadPaper = async (paper: Paper, index: number) => {
    // PREVENT CONCURRENT DOWNLOADS / DOUBLE CLICKS
    if (isDownloading) {
      console.warn("Download already in progress. Ignoring request.");
      return;
    }
    setIsDownloading(true);

    // RESET GLOBAL TRACKER for new download attempt
    globalFetchedUrls.current.clear();
    globalRequestCount.current = 0;

    setSelectedDocId(null);

    // IMMEDIATE FEEDBACK: Switch to Data tab so user sees the "Fetching..." state
    setActiveTab('data');
    setActiveDataSubTab('docs');

    addLog('LIBRARIAN', `Attempting to download: ${paper.title}`, 'working');

    // Helper: Attempt to download from a specific URL
    // @ts-ignore
    const attemptDownload = async (url: string, depth = 0, requirePdf = false, visitedUrls = new Set<string>()): Promise<DownloadedDocument | null> => {

      // GLOBAL LIMIT CHECK - HARD STOP
      globalRequestCount.current++;
      if (globalRequestCount.current > MAX_REQUESTS_PER_DOWNLOAD) {
        console.error(`[Download] HARD LIMIT: Max ${MAX_REQUESTS_PER_DOWNLOAD} requests exceeded. Stopping.`);
        return null;
      }

      // GLOBAL URL CHECK - Only fetch each URL ONCE per download session
      const urlKey = url.split('?')[0].split('#')[0]; // Normalize
      if (globalFetchedUrls.current.has(urlKey)) {
        console.warn(`[Download] BLOCKED: Already fetched ${urlKey}`);
        return null;
      }
      globalFetchedUrls.current.add(urlKey);

      // PROXY: aggressive normalization
      const normalizeUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').split('#')[0].split('?')[0];
      const normUrl = normalizeUrl(url);

      // 0. LOOP PROTECTION
      if (visitedUrls.has(normUrl)) {
        console.warn(`[Download] Loop prevented. Already visited: ${normUrl} (Raw: ${url})`);
        return null;
      }
      visitedUrls.add(normUrl);
      // Track original too
      visitedUrls.add(url);

      // 1. GLOBALLY BLOCKED CHECK
      try {
        if (await storageService.isBlocked(url)) return null;
      } catch (e) { }

      const targetUrl = url;
      if (depth > 2) {
        console.warn(`[Download] Max depth exceeded for: ${targetUrl}`);
        return null;
      }

      let response = null;
      let timeoutId: any = null;

      try {
        const controller = new AbortController();
        // TIMEOUT: 5 Seconds Hard Limit (User Request)
        timeoutId = setTimeout(() => controller.abort(), 5000);

        console.log(`[Download] Fetching (Depth ${depth}): ${targetUrl}`);
        if (targetUrl.startsWith('/api/proxy')) {
          response = await fetch(targetUrl, { signal: controller.signal });
        } else {
          response = await fetch(`/api/proxy?url=${encodeURIComponent(targetUrl)}`, { signal: controller.signal });
        }
      } catch (e) {
        console.warn(`Fetch failed for ${targetUrl}`, e);
        return null;
      } finally {
        clearTimeout(timeoutId);
      }

      // Basic null check before status checks
      if (!response) return null;

      // Anti-Loop / Anti-Captcha: If status is 202 (Accepted) or 403/429 disguised, abort.
      if (response.status === 429) {
        console.warn(`[Download] Rate Limit (429) at ${targetUrl}`);
        try {
          await storageService.blockUrl(targetUrl, `Status ${response.status}`);
        } catch (e) { }
        return null;
      }

      if (response.status === 202) {
        console.warn(`[Download] Source Processing (202) at ${targetUrl}. Skipping.`);

        // CIRCUIT BREAKER: Track consecutive 202s for Semantic Reader
        if (targetUrl.includes('semanticscholar.org')) {
          semanticReaderFailCount++;
          console.log(`[SemanticReader] Fail count: ${semanticReaderFailCount}/${SEMANTIC_READER_FAIL_THRESHOLD}`);
          if (semanticReaderFailCount >= SEMANTIC_READER_FAIL_THRESHOLD) {
            isSemanticReaderDisabled = true;
            console.error("[SemanticReader] Circuit Breaker TRIPPED! Disabling for this session.");
            // Auto-reset after 2 minutes
            setTimeout(() => {
              isSemanticReaderDisabled = false;
              semanticReaderFailCount = 0;
              console.log("[SemanticReader] Circuit Breaker RESET.");
            }, 120000);
          }
        }

        // Do NOT block permanently, just skip for now.
        return null;
      }

      // READ BLOB IMMEDIATELY to sniff content type (Fixes mislabeled PDFs)
      const blob = await response.blob();
      let contentType = response.headers.get('content-type') || '';
      const docId = Math.random().toString(36).substring(7);

      // MAGIC BYTE CHECK (Sniff real type)
      let headerString = "";
      try {
        const headerBuffer = await blob.slice(0, 5).arrayBuffer();
        headerString = new TextDecoder().decode(headerBuffer);
        if (headerString.includes('%PDF')) {
          console.log(`[Download] Detected PDF Magic Bytes (overriding ${contentType})`);
          contentType = 'application/pdf';
        }
      } catch (e) { console.warn("Magic byte check failed", e); }

      // B. PROCESS RESPONSE (PDF vs HTML)
      if (contentType.includes('application/pdf') || contentType.includes('octet-stream')) {
        console.log(`[Download] Blob received. Size: ${blob.size}, Type: ${blob.type} (Treated as PDF)`);

        // CHECK SIZE: Reject empty/tiny files (captchas/errors)
        if (blob.size < 1000) {
          console.warn(`[Download] Rejected tiny file (${blob.size} bytes) from ${targetUrl}`);
          return null;
          const blobUrl = URL.createObjectURL(blob);
          console.log(`[Download] BlobURL created: ${blobUrl}`);

          let isValidPdf = true;
          // VALIDATE PDF MAGIC BYTES (headerString already read)
          if (!headerString.includes('%PDF')) {
            console.warn(`[Download] Missing PDF Header: ${headerString}`);
            if (blob.size < 10240) {
              isValidPdf = false;
              try { await storageService.blockUrl(targetUrl, "Invalid PDF Header"); } catch (e) { }
              return null;
            } else {
              console.log("Allowing large file despite missing header.");
            }
          }

          let extractedText = "";
          if (isValidPdf) {
            try {
              console.log("[Download] Attempting client-side text extraction...");
              extractedText = await extractTextFromPdf(blobUrl);
              console.log(`[Download] Extraction success. Text length: ${extractedText.length}`);
            } catch (e: any) {
              const errorMsg = e.message || String(e); // Safer error string
              console.warn("[Download] Extraction failed:", errorMsg);

              if (errorMsg.includes('PDF_CORRUPT') || errorMsg.includes('Bad FCHECK') || errorMsg.includes('FormatError') || errorMsg.includes('Invalid stream')) {
                console.warn("PDF Validation Failed (Corrupt):", e);
                try {
                  await storageService.blockUrl(targetUrl, "Corrupt PDF Data");
                } catch (err) { /* ignore storage error */ }
                return null; // Reject corrupt PDF
              }
              console.warn("Text extraction failed but PDF might be viewable:", e);
            }
          } else {
            // Should be unreachable due to return null above, but safe fallback
            return null;
          }

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

      }

      if (contentType.includes('text/html')) {
        // STRICT CHECK: If we require PDF, reject HTML immediately
        // EXCEPTION: Allow Semantic Scholar Reader pages to be parsed for deep links
        const isSemanticReader = targetUrl.includes('semanticscholar.org');
        if (requirePdf && !isSemanticReader) {
          console.warn(`[Download] Expected PDF but got HTML from ${targetUrl}. Aborting.`);
          return null;
        }

        // TIMEOUT: User requested max 5 seconds for download attempts
        // We enforce this strictly to prevent hanging processes

        const htmlText = await blob.text();

        // SCRAPE FOR HIDDEN PDF LINKS (User Requested Feature)
        // Look for meta tags first (standard academic metadata), then heuristic links
        if (depth < 2) { // Allow recursion up to depth 2 (Reader -> Intermediate -> PDF)
          console.log("Checking for deep links in HTML...");
          const readerMatch =
            htmlText.match(/<meta\s+name="citation_pdf_url"\s+content="([^"]*)"/i) ||
            htmlText.match(/content="([^"]*)"\s+name="citation_pdf_url"/i) ||
            htmlText.match(/href="([^"]*\/reader\/[^"]*)"/i) ||
            htmlText.match(/href="([^"]*)"[^>]*class="[^"]*(?:cl-paper-action__reader-link)[^"]*"/i) ||
            htmlText.match(/aria-label="Semantic Reader"[^>]*href="([^"]*)"/i);

          if (readerMatch && readerMatch[1]) {
            let deepLink = readerMatch[1];
            // Decode HTML entities if needed (simple check)
            deepLink = deepLink.replace(/&amp;/g, '&');

            if (deepLink.startsWith('/')) {
              // Resolve relative path
              try {
                const urlObj = new URL(targetUrl);
                deepLink = `${urlObj.origin}${deepLink}`;
              } catch (e: any) { }
            }

            // LOOP PROTECTION: Check Visited
            if (visitedUrls.has(deepLink) || visitedUrls.has(deepLink + '/') || visitedUrls.has(deepLink.replace(/\/$/, ''))) {
              console.warn("Loop detected, skipping deep link:", deepLink);
              // Stop recursion
            } else if (deepLink !== targetUrl && !deepLink.includes(targetUrl) && !targetUrl.includes(deepLink)) { // KEEP existing heuristic
              console.log("Found Deep PDF Link in HTML, recursing:", deepLink);
              const deepDoc = await attemptDownload(deepLink, depth + 1, false, visitedUrls); // Pass Visited Set (RECURSION)
              if (deepDoc) return deepDoc;
            }
          }
        }

        let finalHtml = htmlText;
        // ... (rest of HTML logic)

        // INJECT BASE TAG TO FIX RELATIVE LINKS
        try {
          const urlObj = new URL(targetUrl);
          const baseTag = `<base href="${urlObj.origin}" target="_blank">`;
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


    };



    try {
      // SIMPLE DOWNLOAD: Get the openAccessPdf URL from JSON and fetch it ONCE
      const oaUrl = (paper.openAccessPdf && typeof paper.openAccessPdf === 'object')
        ? (paper.openAccessPdf as any).url
        : (paper.openAccessPdf as string | null);

      if (!oaUrl) {
        alert("Bu kaynağın açık erişim PDF linki yok.");
        addLog('LIBRARIAN', `No openAccessPdf URL for '${paper.title}'`, 'warning');
        setIsDownloading(false);
        setActiveTab('sources');
        return;
      }

      console.log(`[Download] Fetching PDF directly from: ${oaUrl}`);

      // SINGLE REQUEST - No recursion, no fallbacks
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      try {
        const response = await fetch(`/api/proxy?url=${encodeURIComponent(oaUrl)}`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const blob = await response.blob();

        // Check if it's actually a PDF
        const headerBuffer = await blob.slice(0, 5).arrayBuffer();
        const headerString = new TextDecoder().decode(headerBuffer);
        const isPdf = headerString.includes('%PDF') || blob.type.includes('pdf');

        if (!isPdf || blob.size < 1000) {
          throw new Error("Response is not a valid PDF");
        }

        const blobUrl = URL.createObjectURL(blob);
        const docId = Math.random().toString(36).substring(7);

        const finalDoc = {
          id: docId,
          paperId: index,
          title: paper.title,
          type: 'pdf' as const,
          content: blobUrl,
          textContent: '',
          originalUrl: oaUrl,
          timestamp: new Date().toLocaleTimeString()
        };

        // Save and display
        storageService.saveDocument(finalDoc).catch(e => console.error("Failed to persist doc:", e));
        setDocuments(prev => [...prev, finalDoc]);
        setSelectedDocId(finalDoc.id);
        addLog('LIBRARIAN', `Download complete: ${paper.title}`, 'success');
        setIsDownloading(false);

      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        console.error("[Download] Fetch failed:", fetchError);
        alert(`İndirme başarısız: ${fetchError.message}`);
        addLog('LIBRARIAN', `Download failed for '${paper.title}': ${fetchError.message}`, 'error');
        setIsDownloading(false);
        setActiveTab('sources');
      }

    } catch (error) {
      console.error("Download error:", error);
      setIsDownloading(false);
    }
  };

  // --- DOCUMENT BATCH MANAGEMENT ---
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(new Set());

  const handleToggleDocumentSelection = (id: string) => {
    setSelectedDocumentIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAllDocuments = () => {
    if (selectedDocumentIds.size === documents.length) {
      setSelectedDocumentIds(new Set());
    } else {
      setSelectedDocumentIds(new Set(documents.map(d => d.id)));
    }
  };

  const handleBatchDeleteDocuments = async () => {
    if (selectedDocumentIds.size === 0) return;

    // User requested NO confirmation ("saçma sapan uyarı verme")
    const idsToDelete = Array.from(selectedDocumentIds);

    // Persist Delete
    await Promise.all(idsToDelete.map((id: string) => storageService.deleteDocument(id)));

    // Update State
    setDocuments(prev => prev.filter(d => !selectedDocumentIds.has(d.id)));
    if (selectedDocId && selectedDocumentIds.has(selectedDocId)) {
      setSelectedDocId(null);
    }
    setSelectedDocumentIds(new Set());
  };

  const removeDocument = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // User requested NO confirmation

    // Persist Delete
    await storageService.deleteDocument(id);

    // Update State
    setDocuments(prev => prev.filter(d => d.id !== id));
    if (selectedDocId === id) setSelectedDocId(null);
  };

  const handleFetchAbstract = async (paper: Paper, index: number) => {
    setFetchingAbstractId(index);
    try {
      // SMART STRATEGY: 
      // 1. Try Original Source URL (User Request)
      // 2. If blocked/failed, try Semantic Scholar Detail Page (Fallback)
      console.log(`Attempting exact source scrape: ${paper.url}`);
      let fullAbstract = await fetchAbstractFromUrl(
        paper.url,
        provider as any,
        provider === 'ollama' ? ollamaConfig : undefined,
        apiKey
      );

      // FALLBACK: If original source failed (e.g. 403, or PDF link, or Paywall), try Semantic Scholar
      if (!fullAbstract || fullAbstract === "NO_ABSTRACT_FOUND" || fullAbstract.length < 100) {
        if (paper.semanticReaderLink) {
          console.log("Source scrape failed/insufficient. Trying Semantic Scholar Fallback...");
          const idMatch = paper.semanticReaderLink.match(/reader\/([a-f0-9]+)/);
          if (idMatch && idMatch[1]) {
            const fallbackUrl = `https://www.semanticscholar.org/paper/${idMatch[1]}`;
            const fallbackAbstract = await fetchAbstractFromUrl(
              fallbackUrl,
              provider as any,
              provider === 'ollama' ? ollamaConfig : undefined,
              apiKey
            );
            if (fallbackAbstract && fallbackAbstract.length > 100 && fallbackAbstract !== "NO_ABSTRACT_FOUND") {
              fullAbstract = fallbackAbstract;
            }
          }
        }
      }

      if (fullAbstract && fullAbstract.length > 50 && fullAbstract !== "NO_ABSTRACT_FOUND") {
        setEnhancedSummaries(prev => ({ ...prev, [index]: fullAbstract! }));
        if (librarianResult) {
          // Mutate local object reference for immediate UI consistency
          librarianResult.papers[index].summary = fullAbstract!;

          // PERSISTENCE: Save the updated abstract to IndexedDB immediately
          // This ensures separate storage of the refined abstract as requested
          storageService.savePapers(librarianResult.papers)
            .then(() => console.log(`[Persistence] Updated abstract for paper ${index} saved.`))
            .catch(e => console.warn("[Persistence] Failed to save updated abstract", e));
        }
      }
    } catch (e) {
      console.error("Failed to fetch abstract", e);
    } finally {
      setFetchingAbstractId(null);
    }
  };


  // 5. Improved Custom Markdown Parser (Line-based)
  const renderMarkdownLine = (line: string, index: number) => {
    // A. Headers
    if (line.startsWith('# ')) {
      return <h1 key={index} className="text-3xl font-bold text-white mt-8 mb-4 border-b border-zinc-700 pb-2">{processInlineMarkdown(line.substring(2))}</h1>;
    }
    if (line.startsWith('## ')) {
      return <h2 key={index} className="text-2xl font-bold text-indigo-400 mt-6 mb-3">{processInlineMarkdown(line.substring(3))}</h2>;
    }
    if (line.startsWith('### ')) {
      return <h3 key={index} className="text-xl font-bold text-emerald-400 mt-4 mb-2">{processInlineMarkdown(line.substring(4))}</h3>;
    }

    // B. Blockquotes / Alerts
    if (line.startsWith('> ')) {
      // Check for alert types [!NOTE], [!IMPORTANT], etc.
      const content = line.substring(2);
      if (content.startsWith('[!')) {
        // Render nothing for the tag line itself, or handle it if we tracked state. 
        // For simplicity, just render it as a bold alert.
        return <div key={index} className="bg-zinc-800/50 border-l-4 border-amber-500 p-3 my-2 text-zinc-300 italic">{processInlineMarkdown(content)}</div>;
      }
      return <blockquote key={index} className="border-l-4 border-zinc-600 pl-4 py-1 my-2 text-zinc-400 italic bg-zinc-900/30 rounded-r">{processInlineMarkdown(content)}</blockquote>;
    }

    // C. Lists
    if (line.startsWith('* ') || line.startsWith('- ')) {
      return (
        <div key={index} className="flex gap-2 ml-4 my-1">
          <span className="text-zinc-500 select-none">•</span>
          <span className="text-zinc-300">{processInlineMarkdown(line.substring(2))}</span>
        </div>
      );
    }

    // D. Metadata lines (Authors/DOI) - heuristic
    if (line.trim().startsWith('**Authors:**') || line.trim().startsWith('**DOI/URL:**')) {
      return <p key={index} className="text-zinc-400 text-sm mb-1 ml-1">{processInlineMarkdown(line)}</p>;
    }

    // E. Empty lines
    if (!line.trim()) {
      return <div key={index} className="h-2"></div>;
    }

    // F. Standard Paragraph
    return <p key={index} className="mb-2 text-zinc-300 leading-7">{processInlineMarkdown(line)}</p>;
  };

  const processInlineMarkdown = (text: string): React.ReactNode => {
    // 1. Split by Bold: **Text**
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      const boldMatch = part.match(/\*\*([^*]+)\*\*/);
      if (boldMatch) {
        return <strong key={i} className="font-bold text-white">{boldMatch[1]}</strong>;
      }
      // 2. Process Citations/Links inside non-bold text
      return processLinksAndCitations(part, i);
    });
  };

  const processLinksAndCitations = (text: string, baseKey: any) => {
    // Complex splitting for [REF], \cite, and URLs.
    // To keep it clean, we'll do a simple chained split or regex replacer approach is hard in React.
    // Let's stick to the previous cascading split method but simplified.

    // Recursion structure: Text -> Split Cites -> Split URLs -> Return Fragment

    // 1. Cites: [[REF:123]]
    const refParts = text.split(/(\[\[\s*REF:\d+\s*\]\])/g);
    return refParts.map((part, j) => {
      const refMatch = part.match(/\[\[\s*REF:(\d+)\s*\]\]/);
      if (refMatch) {
        const id = refMatch[1];
        return <sup key={`${baseKey}-ref-${j}`} id={`ref-${id}`} className="font-bold text-indigo-400 select-none ml-0.5 cursor-pointer hover:text-indigo-300">[{id}]</sup>;
      }

      // 2. URLs
      const urlParts = part.split(/((?:https?:\/\/[^\s]+)(?<![.,)\]]))/g);
      return urlParts.map((subPart, k) => {
        if (subPart.match(/^https?:\/\//)) {
          return <a key={`${baseKey}-url-${j}-${k}`} href={subPart} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 underline break-all">{subPart}</a>;
        }
        return subPart;
      });
    });
  };

  // Replaces the old renderInteractiveText
  const renderInteractiveText = (text: string) => {
    // Split by newlines and render
    const lines = text.split('\n');
    return (
      <div className="space-y-1">
        {lines.map((line, idx) => renderMarkdownLine(line, idx))}
      </div>
    );
  };

  const selectedDoc = documents.find(d => d.id === selectedDocId);

  // --- BATCH MANAGEMENT LOGIC ---
  const handleToggleSelection = (index: number) => {
    setSelectedPaperIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const handleSelectAll = () => {
    if (!librarianResult) return;
    if (selectedPaperIndices.size === librarianResult.papers.length) {
      setSelectedPaperIndices(new Set());
    } else {
      const allIndices = new Set(librarianResult.papers.map((_, i) => i));
      setSelectedPaperIndices(allIndices);
    }
  };

  const handleBatchDelete = async () => {
    if (!librarianResult || selectedPaperIndices.size === 0) {
      console.log("[Delete] Aborted: No papers selected or no librarianResult");
      return;
    }

    // User requested NO confirmation (removed confirm dialog as per previous requests)
    console.log(`[Delete] Processing ${selectedPaperIndices.size} papers for deletion...`);

    const indicesToDelete: number[] = (Array.from(selectedPaperIndices) as number[]).sort((a: number, b: number) => b - a); // Descending to splice safely
    const urlsToDelete: string[] = [];

    // Identify URLs and remove from array in place (descending order to avoid index shift)
    indicesToDelete.forEach(idx => {
      const p = librarianResult.papers[idx];
      if (p?.url) urlsToDelete.push(p.url);
      // Mutate the array directly (this is allowed since it's a reference)
      librarianResult.papers.splice(idx, 1);
    });

    console.log("[Delete] Removed papers:", urlsToDelete);

    // Also delete from DB for persistence
    await storageService.deletePapers(urlsToDelete).catch(e => console.warn("[Delete] DB delete failed:", e));

    // Clear selection and force re-render
    setSelectedPaperIndices(new Set());

    // Force re-render by updating a state that affects the UI
    // Since librarianResult.papers was mutated, we need to trigger React to re-render
    // This is a hack but works: set enhanced summaries to trigger state update
    setEnhancedSummaries(prev => ({ ...prev }));

    console.log("[Delete] Complete. Remaining papers:", librarianResult.papers.length);
  };

  const handleExportLibrary = () => {
    if (!librarianResult) return;
    const jsonString = JSON.stringify(librarianResult.papers, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `my_research_library_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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
                <div className="font-serif text-sm md:text-base text-zinc-300 leading-relaxed pr-2 pt-8">
                  {/* SPLIT RENDERER: Analysis vs Full Text */}
                  {(() => {
                    const parts = finalLatex.split(/\[FULL TEXT SOURCE\]/);
                    const analysisText = parts[0];
                    const fullText = parts.length > 1 ? parts.slice(1).join('[FULL TEXT SOURCE]') : null;

                    return (
                      <>
                        {/* 1. Main Analysis Section (Clean, Readable) */}
                        <div className="prose prose-invert max-w-none mb-12">
                          {renderInteractiveText(analysisText)}
                        </div>

                        {/* 2. Full Text Appendix (Styled & Collapsible-ish look) */}
                        {fullText && (
                          <div className="mt-8 border-t-2 border-dashed border-zinc-700 pt-8">
                            <h3 className="text-xl font-bold text-emerald-400 mb-6 flex items-center gap-2">
                              <Database className="w-5 h-5" /> FULL TEXT SOURCE DATA
                            </h3>
                            <div className="bg-zinc-900/50 p-6 rounded-xl border border-zinc-800 font-mono text-xs md:text-sm text-zinc-400 overflow-x-auto">
                              {/* Custom Renderer for Pages */}
                              {fullText.split(/--- Page (\d+) ---/).map((segment, i) => {
                                // Split creates: [text, pageNum, text, pageNum...]
                                // If i is odd, it's a page number. If i is even, it's content.
                                if (i === 0) return <span key={i}>{segment}</span>; // Pre-text
                                if (i % 2 !== 0) {
                                  // This is a page number
                                  return (
                                    <div key={i} className="my-6 flex items-center gap-4">
                                      <div className="h-px bg-zinc-700 flex-1"></div>
                                      <span className="text-emerald-500 font-bold bg-zinc-900 px-3 py-1 rounded border border-zinc-700">
                                        PAGE {segment}
                                      </span>
                                      <div className="h-px bg-zinc-700 flex-1"></div>
                                    </div>
                                  );
                                }
                                return <span key={i} className="whitespace-pre-wrap">{segment}</span>;
                              })}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
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
                  onClick={openPromptModal}
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
            {librarianResult && librarianResult.researchGap ? (
              <div className="space-y-4">
                {/* Action Buttons */}
                <div className="absolute top-0 right-0 z-10 flex gap-2">
                  <button
                    onClick={() => setShowGapPromptModal(true)}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-colors shadow-lg"
                    title="Regenerate Gap Analysis with New Prompt"
                  >
                    <RefreshCw className="w-3 h-3" /> Regenerate
                  </button>
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
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 mt-20 space-y-4">
                <Sparkles className="w-16 h-16 text-zinc-700 mb-2" />
                <div className="text-center">
                  <h3 className="text-xl font-bold text-zinc-300 mb-1">Research Gap Analysis</h3>
                  <p className="text-zinc-500 text-sm max-w-md mx-auto mb-6">
                    Identify missing variables, methodological limitations, and future research directions based on the indexed literature.
                  </p>

                  {finalLatex ? (
                    <button
                      onClick={() => setShowGapPromptModal(true)}
                      disabled={isRegenerating}
                      className="bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white px-8 py-3 rounded-xl font-bold flex items-center gap-3 transition-all shadow-xl shadow-amber-500/20 transform hover:scale-105"
                    >
                      {isRegenerating ? <Loader className="animate-spin w-5 h-5" /> : <Network className="w-5 h-5" />}
                      {isRegenerating ? 'Analyzing Gaps...' : 'Generate Gap Analysis'}
                    </button>
                  ) : (
                    <div className="bg-zinc-900/50 border border-zinc-800 p-4 rounded text-xs text-zinc-400">
                      ⚠ Please generate the Final Report first to unlock Gap Analysis.
                    </div>
                  )}
                </div>
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

              <div className="flex flex-col gap-2 mt-4 mb-2 px-2">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={documents.length > 0 && selectedDocumentIds.size === documents.length}
                      onChange={handleSelectAllDocuments}
                      className="w-3 h-3 rounded border-zinc-700 bg-zinc-900/50 text-cyan-500 focus:ring-cyan-500/50 cursor-pointer accent-cyan-500"
                    />
                    <span className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Library ({documents.length})</span>
                  </div>
                  {selectedDocumentIds.size > 0 && (
                    <button
                      onClick={handleBatchDeleteDocuments}
                      className="text-[10px] text-red-500 hover:text-red-400 bg-red-900/20 hover:bg-red-900/40 px-2 py-0.5 rounded border border-red-900/30 transition-colors"
                    >
                      Delete ({selectedDocumentIds.size})
                    </button>
                  )}
                </div>
                {isDownloading && <div className="text-[10px] text-cyan-500 flex items-center gap-1"><Loader size={10} className="animate-spin" /> Downloading...</div>}
              </div>

              <div className="flex flex-col gap-2 overflow-y-auto max-h-[400px] custom-scrollbar">
                {documents.length === 0 ? (
                  <div className="text-[10px] text-zinc-600 italic px-2">
                    {isDownloading ? (
                      <span className="text-cyan-500 flex items-center gap-2">
                        Accessing Source...
                      </span>
                    ) : (
                      "No documents downloaded yet. Go to 'Sources' and click 'Download Data'."
                    )}
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
                          <input
                            type="checkbox"
                            checked={selectedDocumentIds.has(doc.id)}
                            onClick={(e) => { e.stopPropagation(); handleToggleDocumentSelection(doc.id); }}
                            onChange={() => { }} // Controlled by onClick to stop prop
                            className="mt-0.5 w-3 h-3 rounded border-zinc-700 bg-zinc-900/50 text-cyan-500 focus:ring-cyan-500/50 cursor-pointer accent-cyan-500"
                          />
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
                        <div className="relative w-full h-full">
                          <iframe src={selectedDoc.content} className="w-full h-full border-none" title="PDF Viewer" />
                          <a
                            href={selectedDoc.content}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="absolute top-4 right-4 bg-zinc-900/80 text-white p-2 rounded-full hover:bg-emerald-600 transition-colors shadow-lg backdrop-blur-sm z-10"
                            title="Open in New Tab (If blocked)"
                          >
                            <ExternalLink size={20} />
                          </a>
                        </div>
                      ) : (
                        selectedDoc.type === 'html' ? (
                          <iframe srcDoc={selectedDoc.content} className="w-full h-full border-none" title="HTML Viewer" />
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full bg-zinc-900 text-zinc-300 p-8 text-center border border-zinc-800 rounded mx-4 my-4">
                            <ShieldCheck className="w-16 h-16 mb-4 text-emerald-500" />
                            <h3 className="font-bold text-xl mb-2 text-white">Publisher Security Active</h3>
                            <p className="text-sm text-zinc-400 mb-6 max-w-md">
                              This document cannot be embedded directly due to security settings. However, you can access the full PDF safely via the verified source link below.
                            </p>
                            <a
                              href={selectedDoc.content}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3 rounded-lg font-bold text-sm transition-all flex items-center gap-2 shadow-lg shadow-emerald-900/20 hover:scale-105"
                            >
                              <ExternalLink size={18} />
                              Open Verified Source (PDF)
                            </a>
                            <div className="mt-8 p-3 bg-zinc-950/50 rounded text-xs text-zinc-500 font-mono break-all max-w-xs">
                              {selectedDoc.content}
                            </div>
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
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-4">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        title="Select All"
                        checked={librarianResult.papers.length > 0 && selectedPaperIndices.size === librarianResult.papers.length}
                        onChange={handleSelectAll}
                        className="w-4 h-4 rounded border-zinc-700 bg-zinc-900/50 text-indigo-500 focus:ring-indigo-500/50 cursor-pointer accent-indigo-500"
                      />
                      <h4 className="text-zinc-400 font-mono text-xs uppercase tracking-widest">
                        Library ({librarianResult.papers.length})
                      </h4>
                    </div>
                    {selectedPaperIndices.size > 0 && (
                      <button
                        onClick={handleBatchDelete}
                        className="flex items-center gap-1.5 bg-red-900/20 hover:bg-red-900/40 text-red-500 px-3 py-1 rounded text-xs font-bold transition-colors border border-red-900/30"
                      >
                        <Trash2 size={12} /> Delete Selected ({selectedPaperIndices.size})
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleExportLibrary}
                      className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-colors border border-zinc-700 shadow-lg"
                    >
                      <Download size={12} className="text-cyan-400" /> Export JSON
                    </button>
                    <button
                      onClick={downloadSourcesAsCSV}
                      className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-colors border border-zinc-700 shadow-lg"
                      title="Download all sources as CSV"
                    >
                      <FileSpreadsheet className="w-3 h-3 text-emerald-400" /> Download CSV
                    </button>
                  </div>
                </div>
                <div className="space-y-3">
                  {librarianResult.papers.length === 0 ? (
                    <div className="text-zinc-500 text-center py-8">
                      No verified public sources found for this topic. <br /> Try providing a local context file instead.
                    </div>
                  ) : (
                    librarianResult.papers.map((paper, idx) => (
                      <div key={idx} className="bg-zinc-900/30 p-4 rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors">
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={selectedPaperIndices.has(idx)}
                            onChange={() => handleToggleSelection(idx)}
                            className="mt-1.5 w-4 h-4 rounded border-zinc-700 bg-zinc-900/50 text-indigo-500 focus:ring-indigo-500/50 cursor-pointer accent-indigo-500"
                          />
                          <h5 className="font-serif font-bold text-zinc-200 mb-1 flex-1">
                            <span className="text-indigo-400 font-mono mr-2">[{idx + 1}]</span>
                            {paper.title}
                          </h5>
                        </div>
                        <p className="text-xs font-mono text-zinc-500 mb-2">{paper.authors} ({paper.year})</p>
                        <div className="relative group/abstract">
                          <p className={`text-sm text-zinc-400 mb-2 transition-all duration-300 ${(paper.summary || "").length > 300 || (enhancedSummaries[idx] || "").length > 300 ? 'line-clamp-2 hover:line-clamp-none cursor-pointer bg-zinc-900/50 p-2 rounded hover:bg-zinc-800' : ''}`} title="Hover to expand">
                            {enhancedSummaries[idx] || paper.summary}
                            {fetchingAbstractId === idx && !enhancedSummaries[idx] && (
                              <span className="ml-2 inline-flex items-center text-xs text-emerald-500 animate-pulse">
                                <Loader size={10} className="animate-spin mr-1" /> Expanding...
                              </span>
                            )}
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

                          <button
                            onClick={() => handleFetchAbstract(paper, idx)}
                            disabled={fetchingAbstractId === idx}
                            className="text-[10px] bg-indigo-900/20 text-indigo-400 hover:text-white hover:bg-indigo-600 px-2 py-1 rounded border border-indigo-500/30 transition-colors cursor-pointer flex items-center gap-1.5"
                            title="Refetch Abstract using AI Proxy"
                          >
                            <RefreshCw size={12} className={fetchingAbstractId === idx ? "animate-spin" : ""} />
                            {fetchingAbstractId === idx ? "Fetching..." : "Fetch Abstract"}
                          </button>

                          {paper.doi && (
                            <span className="text-[10px] font-mono text-zinc-500 select-all border border-zinc-800 bg-zinc-950 px-2 py-1 rounded">
                              DOI: {paper.doi}
                            </span>
                          )}


                          <div className="flex-1"></div>

                          <button
                            onClick={() => handleDownloadPaper(paper, idx)}
                            disabled={isDownloading}
                            className="text-[10px] flex items-center gap-1.5 bg-zinc-800 hover:bg-cyan-900/40 hover:text-cyan-400 text-zinc-400 px-3 py-1 rounded border border-zinc-700 transition-all group disabled:opacity-50"
                            title="Download & View in Data Tab"
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

      {/* PROMPT EDITOR MODAL */}
      {showPromptModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">

          <div className="bg-zinc-900 border border-indigo-500/30 rounded-xl shadow-2xl max-w-4xl w-full p-6 ring-1 ring-indigo-500/20 max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-500/20 rounded-lg text-indigo-400">
                  <Edit3 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Customize Final Report Prompt</h3>
                  <p className="text-zinc-400 text-xs">Edit the instructions sent to the AI Writer. You have full control.</p>
                </div>
              </div>
              <button
                onClick={() => setShowPromptModal(false)}
                className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 min-h-[400px] mb-6 relative group">
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                className="w-full h-full bg-zinc-950/50 border border-zinc-700/50 rounded-lg p-4 font-mono text-sm text-zinc-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 outline-none resize-none leading-relaxed selection:bg-indigo-500/30"
                placeholder="Enter prompt instructions here..."
              />
              <div className="absolute top-2 right-2 text-[10px] text-zinc-600 font-mono bg-zinc-900 border border-zinc-800 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Editable AI Instructions
              </div>
            </div>

            <div className="flex justify-between items-center bg-zinc-950/50 p-3 rounded-lg border border-zinc-800/50">
              <div className="text-xs text-zinc-500 max-w-md">
                <span className="text-amber-500 font-bold">Important:</span> Any text you write here will be sent directly to the AI model.
                Keep the "Abstract Verbatim" rules if you want to avoid translation.
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowPromptModal(false)}
                  className="px-4 py-2 text-sm font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (!librarianResult?.papers) return;
                    // MERGE & SEND
                    // MERGE & SEND: Prioritize Full Text from Downloaded Documents
                    const mergedPapers = librarianResult.papers.map((p, i) => {
                      // Attempt to find matching downloaded document
                      const matchingDoc = documents.find(d =>
                        d.title === p.title ||
                        d.originalUrl === p.url ||
                        (p.openAccessPdf && typeof p.openAccessPdf === 'object' && d.originalUrl === p.openAccessPdf.url)
                      );

                      const hasFullText = matchingDoc && matchingDoc.textContent && matchingDoc.textContent.length > 200;

                      return {
                        ...p,
                        summary: hasFullText
                          ? `[FULL TEXT SOURCE] ${matchingDoc!.textContent!.substring(0, 15000)}...` // Use full text (truncated safety)
                          : (enhancedSummaries[i] || p.summary)
                      };
                    });
                    onGenerateReport(mergedPapers, promptText);
                    setShowPromptModal(false);
                  }}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-lg font-bold flex items-center gap-2 shadow-lg shadow-indigo-500/20 transition-all transform hover:scale-105"
                >
                  <Sparkles className="w-4 h-4" />
                  GENERATE REPORT NOW
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* GAP PROMPT MODAL */}
      {showGapPromptModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-zinc-900 border border-amber-500/30 rounded-xl shadow-2xl max-w-2xl w-full p-6 ring-1 ring-amber-500/20 max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-500" /> Customize Gap Analysis
              </h3>
              <button
                onClick={() => setShowGapPromptModal(false)}
                className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 min-h-[300px] mb-6 flex flex-col">
              <p className="text-sm text-zinc-400 mb-2">
                Define the instructions for the AI to identify research gaps.
              </p>

              <textarea
                value={gapPromptText}
                onChange={(e) => setGapPromptText(e.target.value)}
                className="w-full h-full bg-zinc-950/50 border border-zinc-700/50 rounded-lg p-4 font-mono text-sm text-zinc-300 focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50 outline-none resize-none leading-relaxed"
              />
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-zinc-800">
              <button
                onClick={() => setShowGapPromptModal(false)}
                className="px-4 py-2 hover:bg-zinc-800 rounded text-zinc-400 text-sm font-bold"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowGapPromptModal(false);
                  onGenerateGapAnalysis(gapPromptText);
                }}
                className="px-6 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded text-sm font-bold shadow-lg shadow-amber-500/20 flex items-center gap-2"
              >
                <Sparkles className="w-4 h-4" /> Run Analysis
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ResultsView;