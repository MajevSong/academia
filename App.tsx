import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BookOpen, BarChart2, Feather, Search, Play, Cpu, AlertTriangle, Plus, FileText, X, Globe, Lock, MessageSquare, Upload, Image as ImageIcon, Loader, Trash2, FileType, Settings, Server, Cloud, GraduationCap, Calendar, Filter, Layers, Sparkles } from 'lucide-react';
import {
  AppState, AgentStatus, LogEntry, LibrarianResult, DataScientistResult, ResearchScope, AIProvider, SearchProvider, DownloadedDocument
} from './types';
import * as GeminiService from './services/geminiService';
import AgentCard from './components/AgentCard';
import LogConsole from './components/LogConsole';
import ResultsView from './components/ResultsView';
import ApiKeyModal from './components/ApiKeyModal';

const App: React.FC = () => {
  // State
  const [topic, setTopic] = useState('');
  const [userContext, setUserContext] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isRefining, setIsRefining] = useState(false);

  // API Key State
  const [apiKey, setApiKey] = useState<string>('');
  const [showKeyModal, setShowKeyModal] = useState(false);

  // Missing Info State
  const [missingCriteria, setMissingCriteria] = useState<string[]>([]);
  const [userClarification, setUserClarification] = useState('');

  // Changed to Arrays for Multiple Files
  const [clarificationFiles, setClarificationFiles] = useState<File[]>([]);
  const [clarificationImages, setClarificationImages] = useState<File[]>([]);

  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);

  // Research Parameters
  const [researchMode, setResearchMode] = useState<'web' | 'local'>('web');
  const [researchScope, setResearchScope] = useState<ResearchScope>('full_paper');

  // AI Provider & Search Settings
  const [aiProvider, setAiProvider] = useState<AIProvider>('ollama');
  const [searchProvider, setSearchProvider] = useState<SearchProvider>('google');

  // Search Filters
  const [minYear, setMinYear] = useState('');
  const [maxYear, setMaxYear] = useState('');
  const [scanDepth, setScanDepth] = useState<number>(50); // Default to 50 for deep scan

  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3');
  const [showSettings, setShowSettings] = useState(false);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clarificationFileRef = useRef<HTMLInputElement>(null);
  const clarificationImageRef = useRef<HTMLInputElement>(null);

  // Results Data
  const [librarianRes, setLibrarianRes] = useState<LibrarianResult | null>(null);
  const [dataRes, setDataRes] = useState<DataScientistResult | null>(null);
  const [latexDraft, setLatexDraft] = useState<string | null>(null);
  const [finalLatex, setFinalLatex] = useState<string | null>(null);

  // Lifted Documents State (For Deep Analysis)
  const [documents, setDocuments] = useState<DownloadedDocument[]>([]);
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Helper to add logs
  const addLog = useCallback((agent: string, message: string, type: LogEntry['type'] = 'info') => {
    const newLog: LogEntry = {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      agent,
      message,
      type
    };
    setLogs(prev => [...prev, newLog]);
  }, []);

  // Initialize API Key from LocalStorage
  useEffect(() => {
    const storedKey = localStorage.getItem('GEMINI_API_KEY');
    if (storedKey) setApiKey(storedKey);
  }, []);

  const handleSaveApiKey = (key: string) => {
    localStorage.setItem('GEMINI_API_KEY', key);
    setApiKey(key);
    setShowKeyModal(false);
    addLog('SYSTEM', 'Gemini API Key saved securely.', 'success');
  };

  const handleCancelApiKey = () => {
    setShowKeyModal(false);
    setAiProvider('ollama'); // Revert to Ollama
    addLog('SYSTEM', 'Reverted to Ollama provider.', 'info');
  };

  // File Upload Handler (Main Context)
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    event.target.value = '';
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === 'string') {
        setUserContext(text);
        setFileName(file.name);
        addLog('SYSTEM', `File attached: ${file.name}`, 'success');
        setResearchMode('local');
      }
    };
    reader.onerror = () => {
      addLog('SYSTEM', `Failed to read file: ${file.name}`, 'error');
    };
    reader.readAsText(file);
  };

  const clearFile = () => {
    setUserContext('');
    setFileName(null);
    setResearchMode('web');
    addLog('SYSTEM', 'Attached file removed. Switched to Web Mode.', 'info');
  };

  const getOllamaConfig = () => ({ baseUrl: ollamaUrl, model: ollamaModel });
  const getSearchFilters = () => ({ minYear, maxYear, scanDepth });

  // Handle Provider switching logic
  const handleAiProviderChange = (provider: AIProvider) => {
    if (provider === 'gemini' && !apiKey) {
      setShowKeyModal(true);
    }
    setAiProvider(provider);

    // If switching to Ollama and mode is Web, force Semantic Scholar because Ollama can't Google Search
    if (provider === 'ollama' && researchMode === 'web') {
      setSearchProvider('semantic_scholar');
    }
  };

  const handleRefineTopic = async () => {
    if (!topic.trim()) return;
    setIsRefining(true);
    addLog('SYSTEM', 'Refining research topic for academic precision...', 'working');
    try {
      const refined = await GeminiService.refineResearchTopic(topic, aiProvider, getOllamaConfig(), apiKey);
      setTopic(refined);
      addLog('SYSTEM', 'Topic refined successfully.', 'success');
    } catch (e) {
      addLog('SYSTEM', 'Failed to refine topic.', 'error');
    } finally {
      setIsRefining(false);
    }
  };

  // REGENERATE ANALYSIS HANDLER
  const handleRegenerateAnalysis = async () => {
    if (!librarianRes) return;
    if (documents.length === 0) {
      alert("No documents downloaded yet. Please download some papers in 'Sources' tab first.");
      return;
    }

    setIsRegenerating(true);
    addLog('WRITER', `Initializing Deep Analysis with ${documents.length} downloaded texts...`, 'working');

    try {
      const { report, gap } = await GeminiService.generateDeepLiteratureAnalysis(
        topic,
        librarianRes,
        documents,
        aiProvider,
        getOllamaConfig()
      );

      // Update State
      setFinalLatex(report);
      setLibrarianRes(prev => prev ? { ...prev, researchGap: gap } : null);

      addLog('WRITER', 'Deep Literature Analysis & Gap Report Regenerated.', 'success');
    } catch (e) {
      console.error(e);
      addLog('WRITER', 'Failed to regenerate report from downloads.', 'error');
    } finally {
      setIsRegenerating(false);
    }
  };

  // DETAILED REPORT GENERATION (MANUAL TRIGGER)
  const handleGenerateDetailedReport = async () => {
    if (!librarianRes || !librarianRes.papers) return;

    setIsRegenerating(true);
    addLog('WRITER', 'Generating Detailed Bibliographic Report from sources...', 'working');

    try {
      const result = await GeminiService.generateDetailedBibliographicReport(
        topic,
        librarianRes.papers,
        documents,
        aiProvider,
        getOllamaConfig()
      );
      setFinalLatex(result);
      addLog('WRITER', 'Detailed Report Generated.', 'success');

      // 2. Generate Research Gap (Post-Report)
      addLog('WRITER', 'Identifying Research Gaps from comprehensive analysis...', 'working');
      const gapAnalysis = await GeminiService.generateResearchGapAnalysis(
        topic,
        librarianRes.papers,
        documents,
        aiProvider,
        getOllamaConfig()
      );

      setLibrarianRes(prev => prev ? { ...prev, researchGap: gapAnalysis } : null);
      addLog('WRITER', 'Research Gap Analysis updated.', 'success');

    } catch (e) {
      console.error(e);
      addLog('WRITER', 'Failed to generate report or gap analysis.', 'error');
    } finally {
      setIsRegenerating(false);
    }
  };

  // Main Orchestrator Effect
  useEffect(() => {
    let isMounted = true;

    const runOrchestra = async () => {
      if (!isMounted) return;

      try {
        // Step 1: Analyze Requirements
        if (appState === AppState.ANALYZING) {
          if (researchScope === 'lit_review') {
            addLog('SYSTEM', 'Literature Review Mode: Skipping strict requirement analysis.', 'info');
            setAppState(AppState.LIBRARIAN);
            return;
          }

          addLog('SYSTEM', `Architect Agent analyzing input (${aiProvider.toUpperCase()})...`, 'info');
          const fullInput = `${topic}\n\n${userContext}`;
          const analysis = await GeminiService.analyzeRequirements(fullInput, aiProvider, getOllamaConfig(), apiKey);

          if (!isMounted) return;

          if (analysis.isSufficient) {
            addLog('SYSTEM', 'Input requirements met. Proceeding to Librarian.', 'success');
            setAppState(AppState.LIBRARIAN);
          } else {
            addLog('SYSTEM', 'Insufficient data detected. Requesting user input.', 'warning');
            setMissingCriteria(analysis.missingCriteria);
            setAppState(AppState.AWAITING_INPUT);
          }
        }

        // Step 2: Librarian
        else if (appState === AppState.LIBRARIAN) {
          const providerName = searchProvider === 'semantic_scholar' ? 'SEMANTIC SCHOLAR' : (researchMode === 'local' ? 'LOCAL' : 'GOOGLE');
          addLog('SYSTEM', `Initializing Librarian Protocol via ${providerName}...`, 'info');

          if (searchProvider === 'semantic_scholar') {
            addLog('LIBRARIAN', `Deep Scan Protocol Activated: Target ${scanDepth} papers...`, 'working');
          }

          const fullContext = `${topic}\n\n${userContext}`;
          const result = await GeminiService.runLibrarianAgent(topic, fullContext, researchMode, aiProvider, searchProvider, getSearchFilters(), getOllamaConfig(), apiKey);
          if (!isMounted) return;

          setLibrarianRes(result);
          if (result.papers.length > 0) {
            addLog('LIBRARIAN', `Indexed ${result.papers.length} verified references.`, 'success');
          } else {
            addLog('LIBRARIAN', 'No sources found.', 'warning');
          }

          if (researchScope === 'lit_review') {
            setAppState(AppState.LIT_REVIEW_WRITER);
          } else {
            setAppState(AppState.DATA_SCIENTIST);
          }
        }

        // Step 3 (Branch A): Literature Review Writer
        else if (appState === AppState.LIT_REVIEW_WRITER && librarianRes) {
          addLog('SYSTEM', 'Literature Search Complete. Waiting for user to generate report.', 'info');
          // SKIP AUTOMATIC GENERATION - User wants manual trigger
          // await new Promise(resolve => setTimeout(resolve, 1500));
          // const result = await GeminiService.generateLiteratureReviewReport(topic, librarianRes, aiProvider, getOllamaConfig());
          // setFinalLatex(result); 

          setAppState(AppState.FINISHED);
        }

        // Step 3 (Branch B): Data Scientist (Full Paper Only)
        else if (appState === AppState.DATA_SCIENTIST && librarianRes) {
          addLog('SYSTEM', 'Initializing Data Science Protocol...', 'info');
          await new Promise(resolve => setTimeout(resolve, 1500));

          const fullContext = `${topic}\n\n${userContext}`;
          const result = await GeminiService.runDataScientistAgent(topic, librarianRes.researchGap, fullContext, aiProvider, getOllamaConfig(), apiKey);
          if (!isMounted) return;

          setDataRes(result);
          addLog('DATA', `Visualized provided results (${result.chartData.length} points).`, 'success');
          setAppState(AppState.GHOSTWRITER);
        }

        // Step 4: Ghostwriter (Full Paper Only)
        else if (appState === AppState.GHOSTWRITER && librarianRes && dataRes) {
          addLog('SYSTEM', 'Initializing Ghostwriter Protocol...', 'info');
          await new Promise(resolve => setTimeout(resolve, 1500));

          const fullContext = `${topic}\n\n${userContext}`;
          const result = await GeminiService.runGhostwriterAgent(topic, librarianRes, dataRes, fullContext, researchMode, aiProvider, getOllamaConfig(), apiKey);
          if (!isMounted) return;

          setLatexDraft(result);
          addLog('WRITER', 'Draft generated.', 'success');
          setAppState(AppState.REVIEWER);
        }

        // Step 5: Reviewer (Full Paper Only)
        else if (appState === AppState.REVIEWER && latexDraft) {
          addLog('SYSTEM', 'Initializing Editor Protocol...', 'info');
          await new Promise(resolve => setTimeout(resolve, 1500));

          const result = await GeminiService.runReviewerAgent(latexDraft, aiProvider, getOllamaConfig(), apiKey);
          if (!isMounted) return;

          setFinalLatex(result);
          addLog('REVIEWER', 'Final Edit complete.', 'success');
          setAppState(AppState.FINISHED);
        }
      } catch (err) {
        if (!isMounted) return;
        console.error(err);
        const errorMsg = err instanceof Error ? err.message : 'Unknown error occurred';
        setError(errorMsg);
        addLog('SYSTEM', `Critical Failure: ${errorMsg}`, 'error');
        setAppState(AppState.IDLE);
      }
    };

    runOrchestra();

    return () => { isMounted = false; };
  }, [appState, topic, userContext, librarianRes, dataRes, latexDraft, addLog, researchMode, researchScope, aiProvider, searchProvider, ollamaUrl, ollamaModel, minYear, maxYear, scanDepth, apiKey]);

  const handleStart = () => {
    if (!topic.trim()) return;

    // Check Config
    if (aiProvider === 'gemini' && !apiKey) {
      setShowKeyModal(true);
      return;
    }

    if (aiProvider === 'ollama' && (!ollamaUrl || !ollamaModel)) {
      setError("Please check Ollama configuration settings.");
      return;
    }

    if (researchMode === 'local' && !userContext.trim()) {
      setError("Local Mode requires an attached file or context.");
      return;
    }

    setLogs([]);
    setLibrarianRes(null);
    setDataRes(null);
    setFinalLatex(null);
    setDocuments([]); // Reset documents on new run
    setError(null);
    setMissingCriteria([]);
    setUserClarification('');
    setClarificationFiles([]);
    setClarificationImages([]);

    let providerLabel = 'Standard Google';
    if (searchProvider === 'semantic_scholar') providerLabel = 'Semantic Scholar';
    if (searchProvider === 'google_scholar') providerLabel = 'Google Scholar';

    addLog('SYSTEM', `Boot sequence initiated (${aiProvider.toUpperCase()}) for: "${topic}"`, 'info');
    if (researchMode === 'web') {
      addLog('SYSTEM', `Search Provider: ${providerLabel}`, 'info');
    }

    // Suggestion for Ollama + Semantic Scholar
    if (aiProvider === 'ollama' && researchMode === 'web' && searchProvider === 'semantic_scholar') {
      addLog('SYSTEM', 'OPTIMIZATION: Using Semantic Scholar API with Ollama for accurate RAG.', 'success');
    }

    if (researchMode === 'local') {
      addLog('SYSTEM', 'MODE: LOCAL ONLY. External search disabled.', 'warning');
    }

    if (userContext.trim()) {
      addLog('SYSTEM', `User context loaded (${userContext.length} chars).`, 'info');
    }

    setAppState(AppState.ANALYZING);
  };

  // ... (File Handler Logic Remains Same) ...
  const handleClarificationFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files);
      setClarificationFiles(prev => [...prev, ...newFiles]);
      e.target.value = '';
    }
  };

  const removeClarificationFile = (index: number) => {
    setClarificationFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleClarificationImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files);
      setClarificationImages(prev => [...prev, ...newFiles]);
      e.target.value = '';
    }
  };

  const removeClarificationImage = (index: number) => {
    setClarificationImages(prev => prev.filter((_, i) => i !== index));
  };

  const submitClarification = async () => {
    if (!userClarification.trim() && clarificationFiles.length === 0 && clarificationImages.length === 0) return;

    let appendedContext = `\n\n[USER CLARIFICATION ON RESULTS]:\n${userClarification}`;
    setIsAnalyzingImage(true);

    try {
      if (clarificationFiles.length > 0) {
        addLog('SYSTEM', `Processing ${clarificationFiles.length} attached data files...`, 'info');
        for (const file of clarificationFiles) {
          try {
            const text = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (e) => resolve(e.target?.result as string);
              reader.onerror = reject;
              reader.readAsText(file);
            });
            appendedContext += `\n\n[ATTACHED DATA FILE: ${file.name}]:\n${text}`;
            addLog('SYSTEM', `Read file: ${file.name}`, 'success');
          } catch (e) {
            console.error(e);
            addLog('SYSTEM', `Failed to read file: ${file.name}`, 'error');
          }
        }
      }

      if (clarificationImages.length > 0) {
        addLog('SYSTEM', `Analyzing ${clarificationImages.length} attached graphs/images...`, 'info');
        for (const img of clarificationImages) {
          try {
            addLog('SYSTEM', `Vision AI scanning: ${img.name}...`, 'working');
            const base64Data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                const base64 = result.split(',')[1];
                resolve(base64);
              };
              reader.onerror = reject;
              reader.readAsDataURL(img);
            });

            const imageAnalysis = await GeminiService.extractDataFromGraph(base64Data, img.type, aiProvider, getOllamaConfig(), apiKey);
            appendedContext += `\n\n[GRAPH ANALYSIS (${img.name})]:\n${imageAnalysis}`;
            addLog('SYSTEM', `Analysis complete for: ${img.name}`, 'success');
          } catch (e) {
            console.error(e);
            addLog('SYSTEM', `Failed to analyze image: ${img.name}`, 'error');
          }
        }
      }

    } catch (err) {
      console.error(err);
      addLog('SYSTEM', 'Error processing attached files.', 'error');
    } finally {
      setIsAnalyzingImage(false);
    }

    setUserContext(prev => prev + appendedContext);
    addLog('SYSTEM', 'Clarification received. Resuming workflow...', 'success');
    setMissingCriteria([]);
    setAppState(AppState.LIBRARIAN);
  };

  const getAgentStatus = (targetState: AppState): AgentStatus => {
    if (appState === AppState.FINISHED) return AgentStatus.COMPLETED;
    if (error) return AgentStatus.ERROR;

    if (researchScope === 'lit_review') {
      if (targetState === AppState.DATA_SCIENTIST || targetState === AppState.REVIEWER) return AgentStatus.IDLE;
      if (targetState === AppState.GHOSTWRITER) {
        if (appState === AppState.LIT_REVIEW_WRITER) return AgentStatus.WORKING;
        if (appState === AppState.FINISHED) return AgentStatus.COMPLETED;
        return AgentStatus.WAITING;
      }
    }

    const order = [AppState.IDLE, AppState.ANALYZING, AppState.AWAITING_INPUT, AppState.LIBRARIAN, AppState.DATA_SCIENTIST, AppState.GHOSTWRITER, AppState.REVIEWER, AppState.FINISHED];
    const currentIndex = order.indexOf(appState);
    const targetIndex = order.indexOf(targetState);

    if (appState === targetState) return AgentStatus.WORKING;
    if (currentIndex > targetIndex) return AgentStatus.COMPLETED;
    return AgentStatus.WAITING;
  };

  const isBlurring = appState === AppState.AWAITING_INPUT;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-indigo-500/30 relative">
      <ApiKeyModal
        isOpen={showKeyModal}
        onSave={handleSaveApiKey}
        onCancel={handleCancelApiKey}
      />

      {/* Settings Modal/Panel */}
      {showSettings && (
        <div className="absolute top-16 right-6 z-50 bg-zinc-900 border border-zinc-700 rounded-xl p-4 shadow-2xl w-80 animate-in fade-in slide-in-from-top-2">
          <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
            <Settings className="w-4 h-4" /> System Configuration
          </h3>

          <div className="space-y-4">
            {/* AI Provider */}
            <div className="space-y-2">
              <label className="text-xs text-zinc-400 font-mono uppercase">AI Brain</label>
              <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800">
                <button
                  onClick={() => handleAiProviderChange('gemini')}
                  className={`flex-1 py-1.5 text-xs font-bold rounded flex items-center justify-center gap-2 transition-all ${aiProvider === 'gemini' ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  <Cloud className="w-3 h-3" /> Gemini
                </button>
                <button
                  onClick={() => handleAiProviderChange('ollama')}
                  className={`flex-1 py-1.5 text-xs font-bold rounded flex items-center justify-center gap-2 transition-all ${aiProvider === 'ollama' ? 'bg-orange-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  <Server className="w-3 h-3" /> Ollama
                </button>
              </div>
            </div>

            {/* Search Provider */}
            <div className="space-y-2 mb-4">
              <label className="text-xs text-zinc-400 font-mono uppercase">Search Provider</label>
              <select
                className="w-full bg-slate-800 border-none rounded p-2 text-white outline-none focus:border-cyan-500"
                value={searchProvider}
                onChange={(e) => setSearchProvider(e.target.value as SearchProvider)}
              >
                <option value="semantic_scholar">Semantic Scholar (Recommended)</option>
                <option value="google_scholar">Google Scholar (Experimental)</option>
                <option value="google">Standard Google Search</option>
              </select>

              {aiProvider === 'ollama' && searchProvider === 'google' && (
                <div className="text-[10px] text-orange-400 mt-1">
                  * Ollama cannot use Standard Google Search. Please use Semantic Scholar or Google Scholar with Proxy.
                </div>
              )}
            </div>

            {/* Search Filters (Scholars) */}
            {(searchProvider === 'semantic_scholar' || searchProvider === 'google_scholar') && (
              <div className="space-y-2 bg-zinc-950/50 p-2 rounded border border-zinc-800/50">
                <label className="text-xs text-cyan-400 font-mono uppercase flex items-center gap-1">
                  <Filter className="w-3 h-3" /> Academic Filters
                </label>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <input
                      type="number"
                      value={minYear}
                      onChange={(e) => setMinYear(e.target.value)}
                      placeholder="Start Year"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
                    />
                  </div>
                  <div className="flex-1">
                    <input
                      type="number"
                      value={maxYear}
                      onChange={(e) => setMaxYear(e.target.value)}
                      placeholder="End Year"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>

                {/* SCAN DEPTH */}
                <div className="pt-2 border-t border-zinc-800 mt-2">
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Scan Depth</span>
                    <span className="text-cyan-400 font-bold">{scanDepth} Papers</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="500"
                    step="10"
                    value={scanDepth}
                    onChange={(e) => setScanDepth(parseInt(e.target.value))}
                    className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                  />
                </div>
              </div>
            )}

            {aiProvider === 'ollama' && (
              <>
                <div className="h-px bg-zinc-800 my-2"></div>
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400 font-mono uppercase">Ollama Model</label>
                  <input
                    type="text"
                    value={ollamaModel}
                    onChange={(e) => setOllamaModel(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-white focus:border-orange-500 outline-none"
                    placeholder="llama3, mistral, etc."
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400 font-mono uppercase">Base URL</label>
                  <input
                    type="text"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-white focus:border-orange-500 outline-none"
                    placeholder="http://localhost:11434"
                  />
                </div>
                <div className="text-[10px] text-zinc-500 bg-zinc-950/50 p-2 rounded border border-zinc-800/50">
                  <strong>Note:</strong> Start Ollama with <code>OLLAMA_ORIGINS="*"</code> to allow browser requests.
                </div>
              </>
            )}

            <button
              onClick={() => setShowSettings(false)}
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs py-2 rounded transition-colors"
            >
              Close Settings
            </button>
          </div>
        </div>
      )}

      {/* CLARIFICATION MODAL (Same as before) */}
      {appState === AppState.AWAITING_INPUT && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
          {/* ... (Modal content unchanged for brevity, but needed in full file) ... */}
          <div className="bg-zinc-900 border border-amber-500/30 rounded-xl shadow-2xl max-w-2xl w-full p-6 ring-1 ring-amber-500/20 max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="flex items-start gap-4 mb-4">
              <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20 text-amber-500">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white mb-1">Missing Research Data</h2>
                <p className="text-zinc-400 text-sm">The Architect Agent needs specific results to proceed.</p>
              </div>
            </div>

            <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 mb-6">
              <p className="text-zinc-300 text-sm font-medium mb-3">Requirements:</p>
              <ul className="space-y-2">
                {missingCriteria.map((criterion, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm text-amber-400/90 font-mono">
                    <span className="mt-1">•</span> {criterion}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Option 1: Describe Manually</label>
                <textarea
                  value={userClarification}
                  onChange={(e) => setUserClarification(e.target.value)}
                  placeholder="e.g. Our proposed method achieved 96.5% accuracy..."
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-amber-500/50 outline-none h-24 resize-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Option 2: Attach Data Files</label>
                  <input
                    type="file"
                    ref={clarificationFileRef}
                    onChange={handleClarificationFileSelect}
                    accept=".txt,.csv,.json,.md"
                    className="hidden"
                    multiple
                  />
                  <button
                    onClick={() => clarificationFileRef.current?.click()}
                    className="w-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 py-2 px-3 rounded flex items-center justify-center gap-2 text-sm transition-colors"
                  >
                    <Upload className="w-4 h-4" />
                    Add Files (.txt/.csv)
                  </button>
                  {clarificationFiles.length > 0 && (
                    <div className="flex flex-col gap-1.5 mt-2 bg-zinc-950/50 p-2 rounded border border-zinc-800">
                      {clarificationFiles.map((file, idx) => (
                        <div key={idx} className="flex justify-between items-center text-xs">
                          <div className="flex items-center gap-2 text-emerald-400 truncate">
                            <FileText className="w-3 h-3" />
                            <span className="truncate max-w-[150px]">{file.name}</span>
                          </div>
                          <button onClick={() => removeClarificationFile(idx)} className="text-zinc-600 hover:text-red-400">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Option 3: Attach Graphs</label>
                  <input
                    type="file"
                    ref={clarificationImageRef}
                    onChange={handleClarificationImageSelect}
                    accept="image/png, image/jpeg, image/webp"
                    className="hidden"
                    multiple
                  />
                  <button
                    onClick={() => clarificationImageRef.current?.click()}
                    className="w-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 py-2 px-3 rounded flex items-center justify-center gap-2 text-sm transition-colors"
                  >
                    <ImageIcon className="w-4 h-4" />
                    Add Graphs
                  </button>
                  {clarificationImages.length > 0 && (
                    <div className="flex flex-col gap-1.5 mt-2 bg-zinc-950/50 p-2 rounded border border-zinc-800">
                      {clarificationImages.map((file, idx) => (
                        <div key={idx} className="flex justify-between items-center text-xs">
                          <div className="flex items-center gap-2 text-purple-400 truncate">
                            <ImageIcon className="w-3 h-3" />
                            <span className="truncate max-w-[150px]">{file.name}</span>
                          </div>
                          <button onClick={() => removeClarificationImage(idx)} className="text-zinc-600 hover:text-red-400">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end mt-6">
              <button
                onClick={submitClarification}
                disabled={isAnalyzingImage || (!userClarification && clarificationFiles.length === 0 && clarificationImages.length === 0)}
                className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg font-bold transition-colors flex items-center gap-2"
              >
                {isAnalyzingImage ? <Loader className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
                {isAnalyzingImage ? `Analyzing (${clarificationImages.length} images)...` : 'Submit & Continue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        className="hidden"
        accept=".txt,.md,.tex,.bib,.json,.csv"
      />

      {/* Header */}
      <header className={`border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-40 transition-all ${isBlurring ? 'blur-sm grayscale' : ''}`}>
        <div className="w-full px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded flex items-center justify-center shadow-lg transition-colors ${aiProvider === 'gemini' ? 'bg-indigo-600 shadow-indigo-500/20' : 'bg-orange-600 shadow-orange-500/20'}`}>
              <Cpu className="text-white w-5 h-5" />
            </div>
            <h1 className="font-bold text-xl tracking-tight text-white">COGNITO <span className="text-zinc-500 font-normal">Architect</span></h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-xs font-mono text-zinc-500 flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${appState === AppState.AWAITING_INPUT ? 'bg-amber-500 animate-ping' : 'bg-emerald-500 animate-pulse'}`}></div>
              {aiProvider === 'ollama' ? `OLLAMA: ${ollamaModel}` : 'SYSTEM ONLINE'}
            </div>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2 rounded-lg transition-colors ${showSettings ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-white hover:bg-zinc-800/50'}`}
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className={`flex-1 w-full px-6 py-8 flex flex-col gap-8 transition-all duration-500 ${isBlurring ? 'blur-sm opacity-50 pointer-events-none' : ''}`}>

        {/* Input Section */}
        <section className="relative group">
          <div className={`absolute -inset-0.5 bg-gradient-to-r rounded-xl blur opacity-20 group-hover:opacity-40 transition duration-1000 ${aiProvider === 'gemini' ? 'from-indigo-500 to-purple-600' : 'from-orange-500 to-red-600'}`}></div>
          <div className="relative bg-zinc-900 rounded-xl p-4 shadow-xl border border-zinc-800">
            <div className="flex flex-col gap-4">

              {/* Controls Row */}
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center px-1 gap-4">

                {/* Research Scope Toggle */}
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-zinc-500 uppercase tracking-widest hidden md:block">Scope:</span>
                  <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800">
                    <button
                      onClick={() => setResearchScope('full_paper')}
                      className={`px-4 py-1.5 rounded text-xs font-bold flex items-center gap-2 transition-all ${researchScope === 'full_paper' ? (aiProvider === 'gemini' ? 'bg-indigo-600' : 'bg-orange-600') + ' text-white shadow-lg' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      <FileText className="w-3 h-3" /> Full Paper
                    </button>
                    <button
                      onClick={() => setResearchScope('lit_review')}
                      className={`px-4 py-1.5 rounded text-xs font-bold flex items-center gap-2 transition-all ${researchScope === 'lit_review' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      <FileType className="w-3 h-3" /> Lit Review Only
                    </button>
                  </div>
                </div>

                {/* Mode Toggle */}
                <div className="flex items-center gap-2 bg-zinc-950 rounded-lg p-1 border border-zinc-800">
                  <button
                    onClick={() => setResearchMode('web')}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${researchMode === 'web'
                      ? (aiProvider === 'gemini' ? 'bg-indigo-600' : 'bg-orange-600') + ' text-white shadow-lg'
                      : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                  >
                    <Globe className="w-3 h-3" />
                    Web Search
                  </button>
                  <button
                    onClick={() => setResearchMode('local')}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${researchMode === 'local'
                      ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                      : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                  >
                    <Lock className="w-3 h-3" />
                    Local Context
                  </button>
                </div>
              </div>

              {/* Topic Input Row */}
              <div className="flex items-center gap-4">
                <div className="bg-zinc-800 p-2 rounded text-zinc-400">
                  <Search className="w-5 h-5" />
                </div>
                <div className="flex-1 relative">
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder={researchScope === 'lit_review' ? "Enter topic for Literature Review (e.g., 'Impact of AI on Healthcare')..." : "Enter Research Topic, Abstract, or Hypothesis..."}
                    className="w-full bg-transparent border-none outline-none text-white font-medium placeholder-zinc-500 text-lg pr-10"
                    disabled={appState !== AppState.IDLE && appState !== AppState.FINISHED}
                  />
                  {topic.trim() && (
                    <button
                      onClick={handleRefineTopic}
                      disabled={isRefining || appState !== AppState.IDLE && appState !== AppState.FINISHED}
                      className="absolute right-0 top-1/2 -translate-y-1/2 p-1.5 text-zinc-400 hover:text-amber-400 bg-zinc-800/50 hover:bg-zinc-800 rounded-md transition-all"
                      title="Refine Topic to Academic Standard"
                    >
                      {isRefining ? <Loader className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    </button>
                  )}
                </div>

                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={appState !== AppState.IDLE && appState !== AppState.FINISHED}
                  className={`bg-zinc-800 hover:bg-zinc-700 hover:text-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed p-2 rounded text-zinc-400 transition-colors h-fit flex items-center justify-center border border-zinc-700/50 ${!fileName && researchMode === 'local' ? 'animate-pulse ring-1 ring-emerald-500' : ''}`}
                  title="Attach text file (.txt, .md, .tex, .json) as context"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              {/* Attached File Indicator */}
              {fileName && (
                <div className="flex items-center gap-2 ml-[52px] -mt-2">
                  <div className="flex items-center gap-2 text-xs text-indigo-300 bg-indigo-500/10 px-3 py-1.5 rounded-md border border-indigo-500/20">
                    <FileText className="w-3 h-3" />
                    <span className="max-w-[200px] truncate">{fileName}</span>
                    <button
                      onClick={clearFile}
                      className="ml-2 text-indigo-400 hover:text-white transition-colors"
                      disabled={appState !== AppState.IDLE && appState !== AppState.FINISHED}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <span className="text-xs text-zinc-500 italic">Content loaded into context</span>
                </div>
              )}
              {!fileName && researchMode === 'local' && (
                <div className="ml-[52px] -mt-2 text-xs text-emerald-500 font-bold">
                  * Please attach a file for Local Mode
                </div>
              )}

              <div className="h-px bg-zinc-800 w-full"></div>

              {/* Action Bar */}
              <div className="flex justify-end pt-2">
                <button
                  onClick={handleStart}
                  disabled={appState !== AppState.IDLE && appState !== AppState.FINISHED}
                  className={`disabled:bg-zinc-800 disabled:text-zinc-600 text-white px-8 py-3 rounded-lg font-bold transition-all flex items-center gap-2 shadow-lg ${researchScope === 'lit_review' ? 'bg-purple-600 hover:bg-purple-500 shadow-purple-500/20' : (aiProvider === 'gemini' ? 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-500/20' : 'bg-orange-600 hover:bg-orange-500 shadow-orange-500/20')}`}
                >
                  {appState === AppState.IDLE || appState === AppState.FINISHED ? <Play className="w-4 h-4" /> : <Cpu className="w-4 h-4 animate-spin" />}
                  {appState === AppState.IDLE || appState === AppState.FINISHED ? (researchScope === 'lit_review' ? 'START REVIEW' : 'INITIALIZE RESEARCH') : 'PROCESSING'}
                </button>
              </div>

            </div>
          </div>
        </section>

        {/* Error Banner */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        )}

        {/* Agents Grid */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <AgentCard
            name="Librarian"
            role={researchMode === 'local' ? 'Internal Scanner' : 'RAG Specialist'}
            description={researchMode === 'local' ? 'Scans provided files for references.' : 'Scans external databases for literature.'}
            status={getAgentStatus(AppState.LIBRARIAN)}
            icon={<BookOpen className="w-5 h-5" />}
          />
          <AgentCard
            name="Data Scientist"
            role="Python Sandbox"
            description="Generates synthetic datasets and performs statistical analysis."
            status={getAgentStatus(AppState.DATA_SCIENTIST)}
            icon={<BarChart2 className="w-5 h-5" />}
          />
          <AgentCard
            name={researchScope === 'lit_review' ? 'Review Specialist' : 'Ghostwriter'}
            role={researchScope === 'lit_review' ? 'Synthesis Engine' : 'Expert Author'}
            description={researchScope === 'lit_review' ? 'Synthesizes sources into a thematic review report.' : 'Drafts long-form, human-like content using unique phrasing.'}
            status={getAgentStatus(AppState.GHOSTWRITER)}
            icon={<Feather className="w-5 h-5" />}
          />
          <AgentCard
            name="Chief Editor"
            role="Final Polish"
            description="Expands the draft and ensures a natural, fluent academic tone."
            status={getAgentStatus(AppState.REVIEWER)}
            icon={<Search className="w-5 h-5" />}
          />
        </section>

        {/* Main Workspace */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full flex-1 min-h-[500px]">
          {/* Logs */}
          <div className="lg:col-span-1 h-full">
            <LogConsole logs={logs} />
          </div>

          {/* Results */}
          <div className="lg:col-span-2 h-full">
            <ResultsView
              librarianResult={librarianRes}
              dataResult={dataRes}
              finalLatex={finalLatex}
              documents={documents}
              setDocuments={setDocuments}
              onRegenerate={handleRegenerateAnalysis}
              onGenerateReport={handleGenerateDetailedReport}
              isRegenerating={isRegenerating}
              apiKey={apiKey}
              provider={aiProvider}
              ollamaConfig={{ baseUrl: ollamaUrl, model: ollamaModel }}
            />
          </div>
        </div>

      </main>

      <footer className="border-t border-zinc-900 py-6 text-center text-zinc-600 text-xs font-mono">
        <p>COGNITO SYSTEM v1.0.5 // AUTONOMOUS ACADEMIC ORCHESTRA</p>
        <p className="mt-1 opacity-50">Results are AI-generated simulations for demonstration purposes.</p>
      </footer>
    </div>
  );
};

export default App;