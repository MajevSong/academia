export enum AgentStatus {
  IDLE = 'IDLE',
  WORKING = 'WORKING',
  COMPLETED = 'COMPLETED',
  WAITING = 'WAITING',
  ERROR = 'ERROR'
}

export enum AppState {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  AWAITING_INPUT = 'AWAITING_INPUT',
  LIBRARIAN = 'LIBRARIAN',
  DATA_SCIENTIST = 'DATA_SCIENTIST',
  GHOSTWRITER = 'GHOSTWRITER',
  REVIEWER = 'REVIEWER',
  // New State for Lit Review Mode
  LIT_REVIEW_WRITER = 'LIT_REVIEW_WRITER', 
  FINISHED = 'FINISHED'
}

export type ResearchScope = 'full_paper' | 'lit_review';
export type AIProvider = 'gemini' | 'ollama';
export type SearchProvider = 'google' | 'semantic_scholar';

export interface SearchFilters {
  minYear?: string;
  maxYear?: string;
  scanDepth?: number; // Number of papers to fetch
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
}

export interface Paper {
  title: string;
  authors: string;
  year: string;
  doi: string;
  url: string;
  summary: string;
}

export interface DownloadedDocument {
  id: string;
  paperId: number;
  title: string;
  type: 'pdf' | 'html' | 'link';
  content: string; // Blob URL or HTML string
  textContent?: string; // Extracted raw text for AI Analysis
  originalUrl: string;
  timestamp: string;
}

export interface LibrarianResult {
  papers: Paper[];
  researchGap: string;
}

export interface DataPoint {
  name: string;
  value: number;
  category?: string;
}

export interface DataScientistResult {
  chartData: DataPoint[];
  analysis: string;
  xAxisLabel: string;
  yAxisLabel: string;
}

export interface AnalysisResult {
  isSufficient: boolean;
  missingCriteria: string[];
  feedback: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  agent: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export interface CognitoState {
  topic: string;
  logs: LogEntry[];
  librarianResult: LibrarianResult | null;
  dataResult: DataScientistResult | null;
  latexDraft: string | null;
  finalLatex: string | null;
  currentStep: AppState;
  isProcessing: boolean;
}