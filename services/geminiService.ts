import { GoogleGenAI, Type, Schema } from "@google/genai";
import { LibrarianResult, DataScientistResult, AnalysisResult, AIProvider, SearchProvider, OllamaConfig, Paper, SearchFilters, DownloadedDocument } from "../types";

let isSemanticScholarRateLimited = false;

// Initialize Gemini Client
const getAIClient = (apiKey?: string) => {
  const key = apiKey || process.env.API_KEY;
  if (!key) throw new Error("API Key Missing");
  return new GoogleGenAI({ apiKey: key });
};

// --- CONSTANTS ---

// User-defined Structured Prompt for Turkish Analysis (APA 7 Edition Enforced)
const TURKISH_ANALYSIS_PROMPT = `
Seçtiğim makaleleri (kaç adet olursa olsun, 50, 100 vs.) TOPLU OLARAK ve EKSİKSİZ analiz et.
Asla "ve diğerleri" veya "vb." diyerek listeyi yarıda kesme. Tüm veriyi işle.

**FORMAT KURALLARI (APA 7):**
1. Tüm metin içi atıfları APA 7 formatında yap. Örnek: (Yazar, 2023) veya Yazar (2023)...
2. Dil: Akademik Türkçe, edilgen çatı, nesnel üslup.
3. Başlıklar: Aşağıdaki yapıyı KESİNLİKLE koru.

--- RAPOR YAPISI ---

1. Makalelerin Ortak Amacı ve Problemi
Tüm makalelerin çözmeye çalıştığı ana problemi 4–6 cümlede özetle.
Ortak temayı, araştırma odağını ve genel yaklaşımı belirt.

2. Tematik Sentez ve Yöntemler (Gruplandırma)
Makaleleri yöntemlerine veya ele aldıkları temalara göre GRUPLAYARAK (Clustering) analiz et.
Her grup için açıklayıcı bir alt başlık kullan (Örn: "Derin Öğrenme Tabanlı Yaklaşımlar").
Bu bölümde grupların genel yaklaşımını anlat.

3. Gruplara Göre Temel Bulgular (Thematic Synthesis Findings)
Bu bölüm KRİTİKTİR. Bölüm 2'de belirlediğin HER BİR GRUP için temel bulguları maddeler halinde (bullet points) listele.
Format şu şekilde olmalı:

* **[Grup Adı 1] Bulguları:**
  * [Bulgu 1...]
  * [Bulgu 2...]
* **[Grup Adı 2] Bulguları:**
  * [Bulgu 1...]
  * [Bulgu 2...]

4. Sınırlılıklar ve Eksik Noktalar
Makalelerin yöntemsel ve kavramsal eksiklerini toplu olarak listele:
– test edilmeyen koşullar
– veri/örneklem sınırlılıkları
– varsayımlar
– metodolojik zayıflıklar

5. Literatürdeki Boşluklar (GAP Analizi)
SAĞLANAN TÜM MAKALELERİ dikkate alarak genel araştırma boşluklarını çıkar:
3–8 maddelik net bir GAP listesi oluştur.

6. Gelecek Araştırma Fırsatları
Tespit edilen boşluklara göre genel ama uygulanabilir öneriler üret.

7. Kaynakça (APA 7 FORMATINDA - EKSİKSİZ LİSTE)
BU BÖLÜM ÇOK KRİTİK.
Context içerisinde sana verilen makale sayısı kaç ise (Örn: 100), bu listede TAM OLARAK O KADAR SAYIDA referans olmalıdır.
Her referans için mutlaka DOI numarasını ekle (https://doi.org/...).
Asla "..." veya "ve diğerleri" kullanma.
Liste Alfabetik olmalı.
Format:
Soyadı, A. A., & Soyadı, B. B. (Yıl). Makale başlığı. *Dergi Adı*, Cilt(Sayı), Sayfa Aralığı. https://doi.org/...
`;

// --- Helper Functions ---

const extractJson = (text: string): string => {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) return match[1].trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1);
  }
  return text.trim();
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const chunkArray = <T>(array: T[], size: number): T[][] => {
  const chunked: T[][] = [];
  let index = 0;
  while (index < array.length) {
    chunked.push(array.slice(index, size + index));
    index += size;
  }
  return chunked;
};

// Robust Keyword Extractor (JavaScript fallback)
const extractKeywordsBasic = (text: string): string => {
  const stopWords = new Set([
    'what', 'how', 'does', 'do', 'the', 'a', 'an', 'in', 'on', 'of', 'for', 'to', 'from', 'with', 'by',
    'actually', 'capture', 'based', 'is', 'are', 'between', 'among', 'analysis', 'study', 'investigation',
    'review', 'overview', 'components', 'information', 'about', 'regarding', 'using', 'via', 'effect', 'impact'
  ]);

  const words = text.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .split(/\s+/)
    .filter(w => !stopWords.has(w) && w.length > 2);

  return [...new Set(words)].join(' ');
};

// PDF Text Extractor using PDF.js
export const extractTextFromPdf = async (blobUrl: string): Promise<string> => {
  try {
    // @ts-ignore
    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) throw new Error("PDF.js not loaded");

    const loadingTask = pdfjsLib.getDocument(blobUrl);
    const pdf = await loadingTask.promise;
    let fullText = "";

    // Limit pages to avoid browser crash on huge books (first 20 pages is usually enough for analysis)
    const maxPages = Math.min(pdf.numPages, 20);

    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      fullText += `\n--- Page ${i} ---\n${pageText}`;
    }
    return fullText;
  } catch (error: any) {
    console.error("PDF Parsing Error:", error);
    // Propagate critical errors to allow fallback logic triggers
    if (error?.message?.includes('Bad encoding') || error?.name === 'FormatError') {
      throw new Error(`PDF_CORRUPT: ${error.message}`);
    }
    return ""; // For minor errors, just return empty text
  }
};


// Generic Ollama Fetcher
const callOllama = async (config: OllamaConfig, prompt: string, jsonMode: boolean = false, images?: string[]) => {
  try {
    const payload: any = {
      model: config.model,
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.2,
        // Request higher context window for local models if hardware supports it.
        num_ctx: 65536 // Increased context for larger reports
      }
    };

    if (jsonMode) payload.format = 'json';
    if (images) payload.images = images;

    const response = await fetch(`${config.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Ollama API Error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.response;
  } catch (error) {
    console.error("Ollama Connection Failed:", error);
    throw error;
  }
};

// --- NEW SERVICE: Refine Research Topic ---
export const refineResearchTopic = async (topic: string, provider: AIProvider, ollamaConfig?: OllamaConfig, apiKey?: string): Promise<string> => {
  const prompt = `Act as a Senior Research Mentor. Refine the following raw topic input into a precise, academic research title or systematic review question. 
  Input: "${topic}"
  
  Output ONLY the refined topic string. No explanations.`;

  try {
    if (provider === 'ollama' && ollamaConfig) {
      return (await callOllama(ollamaConfig, prompt)).trim();
    } else {
      const ai = getAIClient(apiKey);
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
      });
      return (response.text || topic).trim().replace(/^"|"$/g, '');
    }
  } catch (e) {
    console.error("Refine topic failed", e);
    return topic;
  }
};

// --- QUERY OPTIMIZER ---
// Helper to sanitize AI output - remove non-Latin characters (fixes Ollama Chinese text bug)
const sanitizeSearchQuery = (text: string): string => {
  // Remove non-ASCII/Latin characters (Chinese, Arabic, etc.) that some models inject
  let clean = text.replace(/[^\x00-\x7F\u00C0-\u024F]/g, ' ');
  // Remove extra explanatory text patterns
  clean = clean.replace(/keywords?:?/gi, '')
    .replace(/search terms?:?/gi, '')
    .replace(/output:?/gi, '')
    .replace(/example:?/gi, '')
    .replace(/\([^)]*\)/g, '') // Remove parenthetical notes
    .replace(/["'`:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean;
};

const optimizeSearchQuery = async (topic: string, provider: AIProvider, ollamaConfig?: OllamaConfig, apiKey?: string): Promise<string> => {
  const prompt = `Task: Extract 3-5 distinct academic search keywords from: "${topic}".
  Output ONLY the keywords separated by spaces. No explanations. No bullets. English only.
  Example: "Impact of AI on cancer" -> "artificial intelligence cancer oncology diagnosis"`;

  try {
    let keywords = "";
    if (provider === 'ollama' && ollamaConfig) {
      keywords = (await callOllama(ollamaConfig, prompt)).trim();
    } else {
      const ai = getAIClient(apiKey);
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
      });
      keywords = (response.text || topic).trim();
    }

    // CRITICAL: Sanitize output to remove non-Latin characters (Ollama Chinese text bug fix)
    let clean = sanitizeSearchQuery(keywords);
    console.log(`[Query Optimizer] Raw: "${keywords.substring(0, 100)}..." -> Clean: "${clean}"`);

    // Validate: must have at least some real words
    if (clean.length < 5 || clean.split(' ').filter(w => w.length > 2).length < 2) {
      console.warn("[Query Optimizer] AI output invalid, using basic extraction.");
      return extractKeywordsBasic(topic);
    }
    return clean;
  } catch (e) {
    console.warn("Query optimization failed, using basic extraction.", e);
    return extractKeywordsBasic(topic);
  }
};

// --- REAL ACADEMIC SEARCH (Semantic Scholar) ---

const searchSemanticScholar = async (query: string, filters?: SearchFilters, maxLimit: number = 10): Promise<Paper[]> => {
  console.log(`[SemanticScholar API] Starting search for: "${query}" (maxLimit: ${maxLimit})`);

  // CIRCUIT BREAKER: Check global rate limit status
  if (isSemanticScholarRateLimited) {
    console.warn("[SemanticScholar API] Skipping search - Global Circuit Breaker Active");
    return []; // Return empty to allow fallbacks (e.g. Scraper) to take over
  }

  let allPapers: Paper[] = [];
  try {
    // Added openAccessPdf to fields to prioritize direct PDF links, added tldr for better summaries
    const fields = "title,authors,year,abstract,tldr,url,externalIds,venue,openAccessPdf";
    // Reduced batch size to 40 to avoid Proxy Timeouts on large JSON responses
    const batchSize = 40;

    let offset = 0;
    let hasMore = true;
    let retryCount = 0;

    // Hard cap for safety (Allow up to 500)
    const hardLimit = Math.min(maxLimit, 500);

    while (allPapers.length < hardLimit && hasMore) {
      const remaining = hardLimit - allPapers.length;
      const currentLimit = Math.min(batchSize, remaining + 10);

      let queryParams = `query=${encodeURIComponent(query)}&offset=${offset}&limit=${currentLimit}&fields=${fields}`;

      if (filters) {
        if (filters.minYear && filters.maxYear) {
          queryParams += `&year=${filters.minYear}-${filters.maxYear}`;
        } else if (filters.minYear) {
          queryParams += `&year=${filters.minYear}-`;
        } else if (filters.maxYear) {
          queryParams += `&year=${filters.maxYear}`;
        }
      }

      // Use local Vite proxy to avoid CORS and storage issues
      const proxyUrl = `/api/semantic/graph/v1/paper/search?${queryParams}`;

      let response: Response | null = null;
      let lastError = null;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

        const res = await fetch(proxyUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.ok || res.status === 429) {
          response = res;
        }
      } catch (e) {
        console.warn(`Local proxy request failed: ${proxyUrl}`, e);
        lastError = e;
      }

      if (!response) {
        if (retryCount > 2) break;
        await delay(1000);
        retryCount++;
        continue;
      }

      if (response.status === 429) {
        if (retryCount > 2) { // Allow 3 retries before giving up on this search
          console.warn("Semantic Scholar Rate Limit: Max retries reached for this search.");
          // IMPORTANT: Don't set global circuit breaker here - let other strategies try
          // Only return what we have so far for THIS search
          if (allPapers.length > 0) return allPapers;

          // Set a SHORT circuit breaker (15s) to allow next strategy to work
          isSemanticScholarRateLimited = true;
          setTimeout(() => { isSemanticScholarRateLimited = false; }, 15000);
          return [];
        }

        // Exponential backoff: 3s, 6s, 9s
        const waitTime = 3000 * (retryCount + 1);
        console.warn(`Rate limit hit. Waiting ${waitTime}ms... (retry ${retryCount + 1}/3)`);
        await delay(waitTime);
        retryCount++;
        continue;
      }

      if (!response.ok) break;

      const data = await response.json();

      if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
        hasMore = false;
        break;
      }

      if (data.total && offset + data.data.length >= data.total) {
        hasMore = false;
      }

      const mappedBatch = data.data
        .filter((p: any) => {
          // QUALITY FILTER: Require title, authors, AND abstract
          const hasTitle = p.title && p.title.length > 5;
          const hasAuthors = p.authors && p.authors.length > 0;
          const hasAbstract = p.abstract && p.abstract.length > 50; // Must have real abstract
          return hasTitle && hasAuthors && hasAbstract;
        })
        .map((p: any) => {
          const authorList = p.authors.map((a: any) => a.name).join(", ");
          const openAccessUrl = p.openAccessPdf?.url;
          const doiLink = p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : null;
          // Prefer official URL or DOI for the "Source" link (Landing Page)
          const landingPageUrl = p.url || doiLink || openAccessUrl;
          const semanticReaderLink = p.paperId ? `https://www.semanticscholar.org/reader/${p.paperId}` : null;

          return {
            title: p.title,
            authors: authorList,
            year: p.year ? p.year.toString() : "N/A",
            doi: p.externalIds?.DOI || null,
            url: landingPageUrl,
            openAccessPdf: openAccessUrl, // Explicitly store the direct PDF link for value-add downloads
            semanticReaderLink: semanticReaderLink,
            // ABSTRACT: Use as-is from API, no modification
            summary: p.abstract || "No abstract available."
          };
        });

      allPapers = [...allPapers, ...mappedBatch];
      offset += data.data.length;

      // Increased delay to respect rate limits (avoid 429)
      if (allPapers.length < hardLimit && hasMore) await delay(2000);
    }

    return allPapers;

  } catch (error) {
    console.error("Semantic Scholar Search Error:", error);
    return allPapers.length > 0 ? allPapers : [];
  }
};


// --- FALLBACK SCRAPER (JSON Extraction from SSR HTML) ---
// Semantic Scholar is fully JavaScript-rendered, so DOM selectors don't work.
// Instead, we look for embedded JSON data in script tags.
const searchSemanticScholarHtmlFallback = async (query: string): Promise<Paper[]> => {
  console.log("[HTML Fallback Scraper] Activated for:", query);
  const targetUrl = `https://www.semanticscholar.org/search?q=${encodeURIComponent(query)}&sort=relevance`;
  const papers: Paper[] = [];

  try {
    // 1. Fetch HTML via Proxy
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
    console.log("[HTML Fallback Scraper] Fetching via proxy:", proxyUrl);
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`Scraper fetch failed: ${res.status}`);
    const htmlText = await res.text();
    console.log(`[HTML Fallback Scraper] Received HTML: ${htmlText.length} chars`);

    // 2. Try to extract JSON data from script tags (SSR hydration data)
    // Look for patterns like __NEXT_DATA__, __PRELOADED_STATE__, or inline JSON

    // Strategy A: Look for __NEXT_DATA__ (Next.js apps)
    const nextDataMatch = htmlText.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        console.log("[HTML Fallback Scraper] Found __NEXT_DATA__:", Object.keys(nextData));
        // Navigate to the papers array - structure depends on Semantic Scholar's implementation
        const pageProps = nextData?.props?.pageProps;
        if (pageProps?.papers || pageProps?.results) {
          const papersData = pageProps.papers || pageProps.results;
          papersData.forEach((p: any) => {
            papers.push({
              title: p.title || "Untitled",
              authors: p.authors?.map((a: any) => a.name).join(", ") || "Unknown",
              year: p.year?.toString() || "N/A",
              doi: p.externalIds?.DOI || null,
              url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
              openAccessPdf: p.openAccessPdf?.url || null,
              summary: p.abstract || p.tldr?.text || "No abstract available.",
              semanticReaderLink: p.paperId ? `https://www.semanticscholar.org/reader/${p.paperId}` : null
            });
          });
        }
      } catch (e) {
        console.warn("[HTML Fallback Scraper] Failed to parse __NEXT_DATA__:", e);
      }
    }

    // Strategy B: Look for inline JSON with paper data (common pattern)
    if (papers.length === 0) {
      // Look for JSON blobs containing paper titles
      const jsonPatterns = [
        /"title":"([^"]+)".*?"authors":\s*\[(.*?)\].*?"year":(\d+)/g,
        /"paperId":"([^"]+)".*?"title":"([^"]+)"/g
      ];

      // Try to find paper JSON objects
      const paperObjectPattern = /\{"paperId":"[a-f0-9]+","title":"[^"]+"/g;
      const matches = htmlText.match(paperObjectPattern);
      if (matches && matches.length > 0) {
        console.log(`[HTML Fallback Scraper] Found ${matches.length} potential paper JSON objects`);
        // This is a last resort - try to extract minimal data
        matches.slice(0, 20).forEach(match => {
          try {
            // Find the full object by looking for closing brace
            const startIdx = htmlText.indexOf(match);
            let braceCount = 0;
            let endIdx = startIdx;
            for (let i = startIdx; i < htmlText.length && i < startIdx + 5000; i++) {
              if (htmlText[i] === '{') braceCount++;
              if (htmlText[i] === '}') braceCount--;
              if (braceCount === 0) { endIdx = i + 1; break; }
            }
            const jsonStr = htmlText.substring(startIdx, endIdx);
            const obj = JSON.parse(jsonStr);
            if (obj.title) {
              papers.push({
                title: obj.title,
                authors: obj.authors?.map((a: any) => a.name || a).join(", ") || "Unknown",
                year: obj.year?.toString() || "N/A",
                doi: obj.externalIds?.DOI || null,
                url: `https://www.semanticscholar.org/paper/${obj.paperId || ''}`,
                openAccessPdf: obj.openAccessPdf?.url || null,
                summary: obj.abstract || obj.tldr?.text || "No abstract available.",
                semanticReaderLink: obj.paperId ? `https://www.semanticscholar.org/reader/${obj.paperId}` : null
              });
            }
          } catch (e) { /* Skip malformed objects */ }
        });
      }
    }

    // Strategy C: Regex fallback for embedded meta tags (last resort)
    if (papers.length === 0) {
      console.warn("[HTML Fallback Scraper] JSON extraction failed. Semantic Scholar may have changed their page structure.");
      // Check for captcha
      if (htmlText.toLowerCase().includes("captcha") || htmlText.toLowerCase().includes("verify") || htmlText.includes("429")) {
        throw new Error("SEMANTIC_SCHOLAR_CAPTCHA");
      }
    }

    console.log(`[HTML Fallback Scraper] Extracted ${papers.length} papers.`);
    return papers;

  } catch (e) {
    console.error("HTML Fallback failed:", e);
    return [];
  }
};

// --- Vision Assistant ---
export const extractDataFromGraph = async (
  base64Image: string,
  mimeType: string,
  provider: AIProvider = 'gemini',
  ollamaConfig?: OllamaConfig,
  apiKey?: string
): Promise<string> => {
  const promptText = "Analyze this image/graph strictly as a Data Scientist. Extract data points, axes, and trends.";
  try {
    if (provider === 'ollama' && ollamaConfig) {
      return await callOllama(ollamaConfig, promptText, false, [base64Image]);
    } else {
      const ai = getAIClient(apiKey);
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: { parts: [{ inlineData: { mimeType, data: base64Image } }, { text: promptText }] }
      });
      return response.text || "No data extracted.";
    }
  } catch (error) { return "Error processing image."; }
};

// --- Architect Agent ---
export const analyzeRequirements = async (text: string, provider: AIProvider, ollamaConfig?: OllamaConfig, apiKey?: string): Promise<AnalysisResult> => {
  const prompt = `Role: Academic Editor. Analyze user input for research COMPLETENESS (Quantitative data, Metrics, Methodology). Input: "${text.substring(0, 2000)}". Output JSON: { "isSufficient": boolean, "missingCriteria": string[], "feedback": string }`;
  try {
    let resultText = "";
    if (provider === 'ollama' && ollamaConfig) {
      resultText = await callOllama(ollamaConfig, prompt + " RETURN JSON ONLY.", true);
    } else {
      const ai = getAIClient(apiKey);
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      resultText = response.text || "";
    }
    return JSON.parse(extractJson(resultText)) as AnalysisResult;
  } catch (error) {
    return { isSufficient: true, missingCriteria: [], feedback: "Bypassed analysis." };
  }
};

// --- GOOGLE SCHOLAR SEARCH (Scraper via Proxy) ---
const searchGoogleScholar = async (query: string, maxLimit: number = 10): Promise<Paper[]> => {
  try {
    const res = await fetch(`/api/scholar?q=${encodeURIComponent(query)}&num=${maxLimit}`);
    if (!res.ok) throw new Error(res.statusText);
    const json = await res.json();
    return (json.organic_results || []).map((p: any) => ({
      ...p,
      url: p.pdf_link || p.link || "",
      summary: p.summary || p.snippet || "No summary available."
    }));
  } catch (e) {
    console.error("Google Scholar Scrape Failed:", e);
    return [];
  }
};

// --- Librarian Agent ---

const librarianLocalSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    papers: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { title: { type: Type.STRING }, authors: { type: Type.STRING }, year: { type: Type.STRING }, doi: { type: Type.STRING }, url: { type: Type.STRING }, summary: { type: Type.STRING } } } },
    researchGap: { type: Type.STRING },
  },
};

export const runLibrarianAgent = async (
  topic: string,
  userContext: string,
  mode: 'web' | 'local',
  provider: AIProvider = 'gemini',
  searchProvider: SearchProvider = 'google',
  filters: SearchFilters = {},
  ollamaConfig?: OllamaConfig,
  apiKey?: string
): Promise<LibrarianResult> => {

  if (mode === 'local') {
    const prompt = `Role: Academic Analyst. 
      Task: Analyze the provided local context files.
      Topic: "${topic}"
      Part 1: Extract any Papers/References mentioned in the text (JSON).
      Part 2: Perform the following analysis:
      ${TURKISH_ANALYSIS_PROMPT}

      Context: "${userContext.substring(0, 50000)}". 
      Output JSON with structure: { "papers": [...], "researchGap": "THE_FULL_TURKISH_ANALYSIS_TEXT_HERE" }`;

    try {
      let resultText = "";
      if (provider === 'ollama' && ollamaConfig) {
        resultText = await callOllama(ollamaConfig, prompt, true);
      } else {
        const ai = getAIClient(apiKey);
        const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { responseMimeType: "application/json", responseSchema: librarianLocalSchema } });
        resultText = response.text || "";
      }
      return JSON.parse(extractJson(resultText)) as LibrarianResult;
    } catch (e) { return { papers: [], researchGap: "Local analysis failed." }; }
  }

  // SEMANTIC SCHOLAR STRATEGY (Default for Academic / Ollama)
  // We prefer Semantic Scholar for all academic queries unless explicitly Google
  // CRITICAL: When using Ollama, we MUST use Semantic Scholar because the legacy Google Search
  // (line 643+) uses Gemini API which doesn't work with Ollama.
  const useSemantic = searchProvider === 'semantic_scholar' || searchProvider === 'semantic' || provider === 'ollama';

  console.log(`[Librarian] Search Strategy Decision: provider=${provider}, searchProvider=${searchProvider}, useSemantic=${useSemantic}`);

  if (useSemantic) {
    const targetDepth = filters.scanDepth || 50;
    let aggregatedPapers: Paper[] = [];
    const seenTitles = new Set<string>();

    // AGGRESSIVE SEARCH: Keep trying different queries until we hit target
    const queryStrategies: string[] = [];

    // Strategy 1: AI-optimized query
    const aiQuery = await optimizeSearchQuery(topic, provider, ollamaConfig, apiKey);
    queryStrategies.push(aiQuery);

    // Strategy 2: Basic keywords
    const basicQuery = extractKeywordsBasic(topic);
    if (basicQuery !== aiQuery) queryStrategies.push(basicQuery);

    // Strategy 3: Broad query (top 3 longest words)
    const words = topic.replace(/[^\w\s]/g, '').split(/\s+/).sort((a, b) => b.length - a.length);
    const broadQuery = words.slice(0, 3).join(' ');
    if (broadQuery !== aiQuery && broadQuery !== basicQuery) queryStrategies.push(broadQuery);

    // Strategy 4: Single longest word (very broad)
    if (words[0] && words[0].length > 4) {
      const singleWord = words[0];
      if (!queryStrategies.includes(singleWord)) queryStrategies.push(singleWord);
    }

    // Strategy 5: Topic as-is
    if (!queryStrategies.includes(topic)) queryStrategies.push(topic);

    console.log(`[Librarian] Search strategies: ${queryStrategies.length} queries to try for ${targetDepth} papers`);

    // Execute each strategy until we reach target
    for (let i = 0; i < queryStrategies.length && aggregatedPapers.length < targetDepth; i++) {
      const query = queryStrategies[i];
      const needed = targetDepth - aggregatedPapers.length;

      // IMPORTANT: Reset circuit breaker before each new strategy
      // This allows fresh strategies to try even if previous one hit rate limits
      isSemanticScholarRateLimited = false;

      console.log(`[Librarian] Strategy ${i + 1}/${queryStrategies.length}: "${query}" (Need ${needed} more, Have ${aggregatedPapers.length})`);

      const papers = await searchSemanticScholar(query, filters, needed + 20); // Request extra to account for filtering
      let added = 0;
      papers.forEach(p => {
        if (!seenTitles.has(p.title.toLowerCase())) {
          seenTitles.add(p.title.toLowerCase());
          aggregatedPapers.push(p);
          added++;
        }
      });
      console.log(`[Librarian] Strategy ${i + 1} added ${added} unique papers (Total: ${aggregatedPapers.length})`);

      // Longer delay between strategies to allow rate limits to cool down
      if (aggregatedPapers.length < targetDepth && i < queryStrategies.length - 1) {
        console.log(`[Librarian] Waiting 5s before next strategy...`);
        await delay(5000);
      }
    }

    // If still not enough, try Google Scholar
    if (aggregatedPapers.length < targetDepth) {
      console.warn(`[Librarian] Semantic Scholar gave ${aggregatedPapers.length}/${targetDepth}. Trying Google Scholar...`);
      const needed = targetDepth - aggregatedPapers.length;
      const googlePapers = await searchGoogleScholar(topic, needed);
      googlePapers.forEach(p => {
        if (!seenTitles.has(p.title.toLowerCase())) {
          seenTitles.add(p.title.toLowerCase());
          aggregatedPapers.push(p);
        }
      });
      console.log(`[Librarian] After Google Scholar: ${aggregatedPapers.length} total`);
    }

    const finalPapers = aggregatedPapers.slice(0, targetDepth);
    console.log(`[Librarian] Final result: ${finalPapers.length}/${targetDepth} papers`);
    const gapAnalysis = "Gap analysis will be generated after Final Report.";
    return { papers: finalPapers, researchGap: gapAnalysis };
  }

  // GOOGLE SCHOLAR STRATEGY (NEW)
  if (searchProvider === 'google_scholar') {
    const aiQuery = await optimizeSearchQuery(topic, provider, ollamaConfig, apiKey);
    console.log(`Google Scholar Search for: "${aiQuery}"`);

    const papers = await searchGoogleScholar(aiQuery, filters.scanDepth || 20);

    if (papers.length === 0) {
      // Fallback to basic keywords if AI query fails
      const basicQuery = extractKeywordsBasic(topic);
      if (basicQuery !== aiQuery) {
        const fallbackPapers = await searchGoogleScholar(basicQuery, 20);
        if (fallbackPapers.length > 0) return { papers: fallbackPapers, researchGap: "Gap analysis will be generated after Final Report." };
      }
      return { papers: [], researchGap: "Google Scholar returned no results (or blocked)." };
    }

    return { papers, researchGap: "Gap analysis will be generated after Final Report." };
  }

  // STANDARD GOOGLE SEARCH (Legacy/Fallback)
  const prompt = `Role: Librarian. Find 6 academic sources for: "${topic}". Use Google Search. Return JSON.`;
  try {
    const ai = getAIClient(apiKey);
    const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { tools: [{ googleSearch: {} }] } });
    const result = JSON.parse(extractJson(response.text || ""));
    return result.papers ? result : { papers: [], researchGap: "No sources." };
  } catch (e) { return { papers: [], researchGap: "Google search failed." }; }
};

// --- Data Scientist Agent ---
export const runDataScientistAgent = async (topic: string, gap: string, userContext: string, provider: AIProvider, ollamaConfig?: OllamaConfig, apiKey?: string): Promise<DataScientistResult> => {
  const dataScientistSchema: Schema = { type: Type.OBJECT, properties: { chartData: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, value: { type: Type.NUMBER } } } }, analysis: { type: Type.STRING }, xAxisLabel: { type: Type.STRING }, yAxisLabel: { type: Type.STRING } } };
  const prompt = `Role: Data Scientist. Visualize data from context for "${topic}". Context: "${userContext.substring(0, 4000)}". Output JSON.`;
  try {
    let txt = "";
    if (provider === 'ollama' && ollamaConfig) txt = await callOllama(ollamaConfig, prompt + " JSON ONLY", true);
    else { const ai = getAIClient(apiKey); const r = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { responseMimeType: "application/json", responseSchema: dataScientistSchema } }); txt = r.text || ""; }
    return JSON.parse(extractJson(txt)) as DataScientistResult;
  } catch (e) { throw e; }
};

// --- Abstract Scraper (On-Demand) ---
const fetchedUrlsCache = new Map<string, number>();

export const fetchAbstractFromUrl = async (targetUrl: string, provider: AIProvider, ollamaConfig?: OllamaConfig, apiKey?: string): Promise<string> => {
  // CIRCUIT BREAKER: Prevent Infinite Loops
  const now = Date.now();
  if (fetchedUrlsCache.has(targetUrl)) {
    const lastFetch = fetchedUrlsCache.get(targetUrl)!;
    if (now - lastFetch < 30000) { // Block requests to same URL within 30 seconds
      console.warn(`[Circuit Breaker] Blocked frequent request to: ${targetUrl}`);
      return "NO_ABSTRACT_FOUND"; // Return safe fallback to stop processing
    }
  }
  fetchedUrlsCache.set(targetUrl, now);

  try {
    console.log(`[Debug] START Fetching abstract for: ${targetUrl}`);
    // 1. Fetch HTML via Proxy
    // We treat it as a generic proxy request
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl);

    console.log(`[Debug] Status: ${res.status} | OK: ${res.ok}`);

    // CRITICAL: Handle 202 "Processing" status immediately - this causes infinite loops
    if (res.status === 202) {
      console.warn(`[Abstract Fetch] Semantic Scholar returned 202 (Processing). Aborting to prevent loop.`);
      return "NO_ABSTRACT_FOUND";
    }

    if (!res.ok) {
      console.log(`[Debug] Fetch failed logic triggered.`);
    }

    let htmlText = "";
    try {
      htmlText = await res.text();
      console.log(`[Debug] HTML Content Length: ${htmlText.length}`);
      console.log(`[Debug] Contains 'Abstract' keyword: ${htmlText.includes('Abstract')}`);
      console.log(`[Debug] Contains 'TLDR' keyword: ${htmlText.includes('TLDR')}`);
    } catch (e) {
      console.warn("Failed to read text:", e);
    }

    // CHECK FOR CLOUDFLARE / AKAMAI / BOT BLOCKS including 202 (processing state)
    const isBlocked = htmlText.includes("Please contact our support team") ||
      htmlText.includes("Reference number:") ||
      htmlText.includes("Cloudflare Ray ID") ||
      htmlText.includes("challenge-container") || // New: Cloudflare turnstile/challenge
      htmlText.includes("JavaScript is disabled") || // New: JS challenge
      htmlText.includes("verify that you're not a robot") ||
      res.status === 202 || res.status === 403 || res.status === 504 || res.status === 401 || res.status === 429;

    if (isBlocked) {
      console.warn(`[Abstract Fetch] Blocked by Publisher Security (Status: ${res.status}). Pattern detected.`);
      // We can try Google Cache if we haven't already, or just stop.
      // For now, let's try the cache fallback logic if it exists below, otherwise return.
      console.log("Publisher Security Block Detected. Attempting Google Cache Fallback...");
      try {
        const cacheUrl = `http://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(targetUrl)}`;
        // Use the same proxy to fetch the cache
        const cacheResponse = await fetch(`/api/proxy?url=${encodeURIComponent(cacheUrl)}`);
        if (cacheResponse.ok) {
          const cacheText = await cacheResponse.text();
          // Only use cache if it looks like real content
          if (cacheText.length > 2000 && !cacheText.includes("404. That’s an error")) {
            htmlText = cacheText;
            console.log("Google Cache Hit!");
          } else {
            return "NO_ABSTRACT_FOUND"; // Abort
          }
        } else {
          return "NO_ABSTRACT_FOUND"; // Abort
        }
      } catch (e) {
        console.warn("Cache fallback failed", e);
        return "NO_ABSTRACT_FOUND";
      }
    } else if (!res.ok) {
      // throw new Error(`Failed to fetch content (Status: ${res.status})`);
      console.warn(`Fetch failed with status ${res.status}`);
      return "NO_ABSTRACT_FOUND";
    }

    // 1. Attempt to extract JSON-LD (Rich Metadata)
    let jsonLdData = "";
    const jsonLdCheck = htmlText.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gmi);
    console.log(`[Debug] Checking JSON-LD... Found: ${!!jsonLdCheck}`);
    if (jsonLdCheck) {
      jsonLdData = jsonLdCheck.map(script => script.replace(/<[^>]+>/g, '')).join("\n\n");
      // Check if JSON-LD itself contains the description/abstract directly
      const abstractMatch = jsonLdData.match(/"(description|abstract)"\s*:\s*"([^"]+)"/i);
      if (abstractMatch && abstractMatch[2].length > 100) {
        console.log("Found abstract in JSON-LD!");
        return abstractMatch[2];
      }
    }

    // 2. META TAG SCRAPING (High Reliability)
    // Often the abstract is in the meta description
    console.log(`[Debug] Checking Meta Tags... Found match: ${!!htmlText.match(/<meta\s+(?:name|property)=["'](?:description|og:description|twitter:description)["']\s+content=["']([^"']+)["']/i)}`);
    const metaRegex = /<meta\s+(?:name|property)=["'](?:description|og:description|twitter:description)["']\s+content=["']([^"']+)["']/i;
    const metaMatch = htmlText.match(metaRegex);
    if (metaMatch && metaMatch[1] && metaMatch[1].length > 100) {
      console.log("Found abstract in Meta Tags!");
      return metaMatch[1];
    }

    // 3. HYDRATION DATA / RAW JSON SCRAPING (Brute Force)
    // Many React apps (Semantic Scholar) hide data in window.__INITIAL_STATE__
    // We look for any JSON key "abstract": "..."
    console.log(`[Debug] Checking Raw JSON... Found match: ${!!htmlText.match(/"abstract"\s*:\s*"((?:[^"\\]|\\.)*)"/i)}`);
    const rawJsonRegex = /"abstract"\s*:\s*"((?:[^"\\]|\\.)*)"/i;
    const rawMatch = htmlText.match(rawJsonRegex);
    if (rawMatch && rawMatch[1]) {
      // Unescape the JSON string
      let rawAbstract = rawMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\/g, '');
      if (rawAbstract.length > 100 && !rawAbstract.includes("NO_ABSTRACT")) {
        console.log("Found abstract in Raw JSON/Hydration script!");
        return rawAbstract;
      }
    }

    // 4. Targeted HTML Scraping (User Requested: "tldr-abstract-replacement")
    // We try to find the specific class and extract text without AI to save resources.
    const specificClasses = ["tldr-abstract-replacement", "paper-detail-page__abstract", "abstract-text"];

    for (const className of specificClasses) {
      // Enhanced regex to catch the class content more aggressively (multi-line, attributes)
      // Matches: <div ... class="...tldr-s..." ... > ...CONTENT... </div>
      const regex = new RegExp(`<div[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`, "i");
      const match = htmlText.match(regex);
      if (match && match[1]) {
        // Clean tags but keep text
        const rawText = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

        // If we found a substantial amount of text, TRUST IT.
        if (rawText.length > 50 && !rawText.toLowerCase().includes("tldr")) {
          console.log(`Matched abstract via class: ${className}`);
          return rawText; // Direct return, skip AI
        }
      }
    }

    // Strip purely technical tags to reduce token usage, BUT keep structure
    const cleanedHtml = htmlText
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gmi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gmi, "")
      .replace(/<!--[\s\S]*?-->/g, "") // Remove comments
      .slice(0, 20000); // 20k chars is enough for header/abstract

    const prompt = `
    ROLE: HTML Content Extractor.
    TASK: Extract the text content of the academic paper abstract from the provided HTML.

    CRITICAL INSTRUCTION:
    - Look for "tldr-abstract-replacement" or "abstract" class/id.
    - EXTRACT THE TEXT CONTENT INSIDE IT.
    - Do NOT evaluate if it is "visible" or "dynamic". Just extract the text.
    - Do NOT output "NO_ABSTRACT_FOUND" if you see the "tldr-abstract-replacement" tag.
    - Ignore "TLDR" summaries. We need the FULL Abstract.
    - **NEVER OUTPUT CODE**. Do NOT write a Python script or Regex. Output ONLY the extracted text.

    INPUT HTML (Truncated):
    ${cleanedHtml}

    OUTPUT:
    - Just the plain text of the abstract.
    - If absolutely nothing found, return "NO_ABSTRACT_FOUND".
    `;

    let abstract = "";
    if (provider === 'ollama' && ollamaConfig) {
      abstract = await callOllama(ollamaConfig, prompt);
    } else {
      const ai = getAIClient(apiKey);
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
      });
      abstract = response.text || "";
    }

    return abstract.trim();
  } catch (e) {
    console.error("Abstract scraping failed:", e);
    return "NO_ABSTRACT_FOUND";
  }
};

// --- Writer Agents ---
export const runGhostwriterAgent = async (topic: string, lib: LibrarianResult, data: DataScientistResult, ctx: string, mode: any, prov: AIProvider, cfg?: OllamaConfig, apiKey?: string): Promise<string> => {
  const prompt = `Write Academic Paper (LaTeX). Topic: ${topic}. Gap: ${lib.researchGap}. Analysis: ${data.analysis}. Cite: ${lib.papers.slice(0, 20).map(p => p.title).join(", ")}.`;
  try {
    if (prov === 'ollama' && cfg) return await callOllama(cfg, prompt);
    const ai = getAIClient(apiKey);
    const r = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt }); return r.text || "";
  } catch (e) { return "% Error"; }
};

export const runReviewerAgent = async (draft: string, prov: AIProvider, cfg?: OllamaConfig, apiKey?: string): Promise<string> => {
  const prompt = `Edit and Polish LaTeX. Return only LaTeX. Draft: ${draft.substring(0, 10000)}`;
  try {
    if (prov === 'ollama' && cfg) return await callOllama(cfg, prompt);
    const ai = getAIClient(apiKey);
    const r = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt }); return r.text || "";
  } catch (e) { return "% Error"; }
};

// REFACTORED: Generate Literature Review Report (Using Single-Pass Holistic Analysis)
export const generateLiteratureReviewReport = async (topic: string, lib: LibrarianResult, prov: AIProvider, cfg?: OllamaConfig, apiKey?: string): Promise<string> => {
  const papersContext = lib.papers.map((p, i) => `[ID:${i + 1}] Title: ${p.title}\nAuthors: ${p.authors} (${p.year})\nAbstract: ${p.summary}\nDOI: ${p.doi}`).join("\n\n");
  const fullPrompt = `Role: Senior Academic Writer. Topic: ${topic}\n${TURKISH_ANALYSIS_PROMPT}\nAbstracts to Analyze:\n${papersContext}`;
  let finalReport = "";
  try {
    if (prov === 'ollama' && cfg) {
      finalReport = await callOllama(cfg, fullPrompt);
    } else {
      const ai = getAIClient(apiKey);
      const r = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: fullPrompt });
      finalReport = r.text || "Report generation failed.";
    }
  } catch (e) { console.error(e); finalReport = "Error generating report."; }
  return finalReport;
};

// NEW: Standalone Research Gap Analysis (User Triggered)
export const generateResearchGapAnalysis = async (
  topic: string,
  papers: Paper[],
  customPrompt: string | null,
  provider: AIProvider,
  ollamaConfig?: OllamaConfig,
  apiKey?: string
): Promise<string> => {
  const papersContext = papers.map((p, i) => `[ID:${i + 1}] Title: ${p.title}\nAuthors: ${p.authors} (${p.year})\nSummary: ${p.summary}`).join("\n\n");

  const defaultPrompt = `
  Analyze the provided academic papers on the topic "${topic}" and identify critical research gaps.
  
  Your Output must be in Markdown format with the following structure:
  ## Research Gaps in Current Literature
  [Analyze 3-5 major gaps where information is missing, inconsistent, or outdated]
  
  ## Proposed Future Research Directions
  [Suggest specific research questions or methodologies to address these gaps]
  
  ## Methodology Limitations
  [Identify common limitations in the reviewed studies]
  `;

  const finalPrompt = `Role: Academic Researcher.\n${customPrompt || defaultPrompt}\n\nExisting Literature:\n${papersContext}`;

  try {
    if (provider === 'ollama' && ollamaConfig) {
      return await callOllama(ollamaConfig, finalPrompt);
    } else {
      const ai = getAIClient(apiKey);
      const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: finalPrompt });
      return response.text || "Gap analysis failed.";
    }
  } catch (e) {
    console.error("Gap analysis failed:", e);
    return "Error generating gap analysis.";
  }
};

// --- NEW FUNCTION: Deep Literature Analysis (Using Full Text) ---
export const generateDeepLiteratureAnalysis = async (
  topic: string,
  lib: LibrarianResult,
  documents: DownloadedDocument[],
  prov: AIProvider,
  cfg?: OllamaConfig,
  apiKey?: string
): Promise<{ report: string, gap: string }> => {

  // Construct Context with priority to Full Text
  let fullTextCount = 0;

  const papersContext = lib.papers.map((p, i) => {
    // Check if we have a matching downloaded doc with extracted text
    const doc = documents.find(d => d.paperId === i && d.textContent && d.textContent.length > 100);

    if (doc) {
      fullTextCount++;
      return `\n\n=== SOURCE ${i + 1} (FULL TEXT AVAILABLE) ===\nTitle: ${p.title}\nAuthors: ${p.authors} (${p.year})\nDOI: ${p.doi}\n\n[FULL TEXT CONTENT START]\n${doc.textContent?.substring(0, 30000)}...\n[FULL TEXT CONTENT END]\n`;
    } else {
      return `\n\n=== SOURCE ${i + 1} (ABSTRACT ONLY) ===\nTitle: ${p.title}\nAuthors: ${p.authors} (${p.year})\nDOI: ${p.doi}\nAbstract: ${p.summary}\n`;
    }
  }).join("\n");

  const prompt = `Role: Senior Academic Researcher & Author.
  Task: Regenerate the Literature Review and Research Gap Analysis based on NEW EVIDENCE.
  
  Topic: ${topic}
  
  You have been provided with ${lib.papers.length} sources.
  CRITICALLY: ${fullTextCount} of these sources have FULL TEXT available. 
  
  INSTRUCTIONS:
  1. For sources with FULL TEXT: You MUST provide a much deeper, detailed synthesis. Extract specific methodology details, quantitative results, and limitations from the full text that wouldn't be in an abstract.
  2. For sources with ABSTRACT ONLY: Summarize based on available info.
  3. Combine ALL sources into a coherent narrative.
  
  OUTPUT FORMAT (JSON):
  {
    "report": "MARKDOWN STRING containing the full Literature Review (Introduction, Thematic Analysis, Detailed Findings, Conclusion, Bibliography). Follow APA 7.",
    "gap": "MARKDOWN STRING containing the specific Research Gap Analysis (The 3-8 missing points in the field)."
  }

  ${TURKISH_ANALYSIS_PROMPT}
  
  DATA SOURCES:
  ${papersContext}
  `;

  const deepSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      report: { type: Type.STRING },
      gap: { type: Type.STRING }
    }
  };

  try {
    let resultText = "";
    if (prov === 'ollama' && cfg) {
      resultText = await callOllama(cfg, prompt + " RETURN JSON ONLY", true);
    } else {
      const ai = getAIClient(apiKey);
      const r = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json", responseSchema: deepSchema }
      });
      resultText = r.text || "";
    }

    const parsed = JSON.parse(extractJson(resultText));
    return { report: parsed.report, gap: parsed.gap };

  } catch (e) {
    console.error("Deep analysis failed", e);
    throw new Error("Failed to generate deep analysis from downloaded texts.");
  }
};

// --- HELPER: DEFAULT PROMPT GENERATOR (APA CITATION ENGINE) ---
export const getDefaultReportPrompt = (topic: string, paperCount: number) => `
You are an academic processing and citation engine.

CRITICAL RULES (ABSOLUTE - VIOLATION IS FAILURE):
1. ABSTRACT PRESERVATION: Use the abstracts EXACTLY as they appear in the data.
   - Do NOT paraphrase, rewrite, summarize, or alter wording in any way.
   - Preserve original sentence order and content.
   - If abstract is English, keep it English. If Turkish, keep Turkish.

2. SENTENCE-LEVEL APA CITATIONS:
   - Append an APA 7 in-text citation to the END of EVERY sentence.
   - Format: (AuthorLastName, Year) or (Author1 & Author2, Year) or (FirstAuthor et al., Year)

3. OUTPUT FORMAT:
   - Create a clean academic report compiling the provided abstracts.
   - For each source, create a section with the paper title as heading.
   - Copy the abstract text VERBATIM, adding citations after each sentence.

4. REFERENCES SECTION:
   - Generate APA 7 formatted reference list at the end.
   - Include all sources cited in the text.
   - Sort alphabetically by first author's last name.

CONSTRAINTS (DO NOT VIOLATE):
- Do NOT invent or infer content.
- Do NOT add external knowledge.
- Do NOT translate or modify the abstract text.
- If metadata is missing, state what is missing.

OUTPUT LANGUAGE: Same as input abstracts (preserve original language).

OUTPUT STRUCTURE:
# Literature Review: ${topic}

## [Paper Title 1]
[Verbatim abstract with (Author, Year) after each sentence]

## [Paper Title 2]
[Verbatim abstract with (Author, Year) after each sentence]

...

# References
[APA 7 formatted reference list]

PROCESS ALL ${paperCount} SOURCES PROVIDED.
`;

// --- NEW: DETAILED BIBLIOGRAPHIC REPORT ---
export const generateDetailedBibliographicReport = async (
  topic: string,
  papers: Paper[],
  documents: DownloadedDocument[],
  provider: AIProvider,
  ollamaConfig: OllamaConfig,
  apiKey?: string,
  customPrompt?: string // NEW ARGUMENT
): Promise<string> => {
  try {
    // 1. Prepare Data Context - EXPLICIT FORMATTING FOR VERBATIM COPY
    const paperContexts = papers.map((paper, index) => {
      // Try to find full text
      const doc = documents.find(d => d.title === paper.title || d.originalUrl === paper.url);
      const hasFullText = !!(doc && doc.textContent && doc.textContent.length > 500);
      const abstractText = paper.summary || "";
      const fullText = hasFullText ? doc!.textContent : null;

      return `
================================================================================
SOURCE #${index + 1}
================================================================================
TITLE: ${paper.title}
AUTHORS: ${paper.authors}
YEAR: ${paper.year}
DOI: ${paper.doi || "N/A"}
URL: ${paper.url}
--------------------------------------------------------------------------------
*** ABSTRACT TEXT (COPY THIS VERBATIM - DO NOT PARAPHRASE OR TRANSLATE) ***
"""
${abstractText.slice(0, 8000)}
"""
--------------------------------------------------------------------------------
${hasFullText ? `[FULL TEXT AVAILABLE - ${fullText!.length} chars]
${fullText!.slice(0, 12000)}` : "[NO FULL TEXT - USE ABSTRACT ABOVE]"}
================================================================================
`;
    }).join('\n');

    // USE CUSTOM PROMPT IF PROVIDED, ELSE DEFAULT
    const prompt = customPrompt || getDefaultReportPrompt(topic, papers.length);

    // 2. Call AI
    if (provider === 'gemini') {
      const ai = getAIClient(apiKey);
      const response = await ai.models.generateContent({
        model: "gemini-1.5-pro",
        contents: prompt + "\n\nDATA:\n" + paperContexts
      });
      return response.text || "";
    } else {
      // Ollama
      const response = await fetch(`${ollamaConfig.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaConfig.model,
          prompt: `${prompt}\n\nDATA:\n${paperContexts}`,
          stream: false,
          options: {
            num_ctx: 32768 // Request large context window
          }
        })
      });
      if (!response.ok) throw new Error("Ollama generation failed");
      const data = await response.json();
      return data.response;
    }

  } catch (error) {
    console.error("Detailed Report Generation Failed:", error);
    return "Error generating detailed report. Please check logs.";
  }
};

// --- NEW: DEDICATED GAP ANALYSIS ---
// REMOVED LEGACY FUNCTION
const _legacy_generateResearchGapAnalysis = async (
  topic: string,
  papers: Paper[],
  documents: DownloadedDocument[],
  provider: AIProvider,
  ollamaConfig: OllamaConfig,
  apiKey?: string
): Promise<string> => {
  try {
    const paperContexts = papers.map((paper, index) => {
      // Prioritize full text
      const doc = documents.find(d => d.title === paper.title || d.originalUrl === paper.url);
      const hasFullText = !!(doc && doc.textContent && doc.textContent.length > 500);
      const content = hasFullText ? doc!.textContent : paper.summary;

      return `
SOURCE #${index + 1}:
Title: ${paper.title}
Year: ${paper.year}
Content:
${(content || "").slice(0, 10000)} // Truncate slightly
--------------------------------------------------
`;
    }).join('\n');

    const prompt = `
GÖREV: "${topic}" konusu için sağlanan kaynaklara dayanarak kritik bir "Araştırma Boşluğu (Research Gap) Analizi" yap.

TALİMATLAR:
1. Sağlanan kaynakları sentezleyerek mevcut literatürde EKSİK olan noktaları tespit et.
2. Odaklanılacak noktalar:
   - Çalışmalardaki ortak metodolojik zayıflıklar.
   - İncelenmemiş değişkenler veya popülasyonlar.
   - Çözümlenmesi gereken çelişkili bulgular.
   - Uzun vadeli (boylamsal) veya deneysel veri eksikliği.
   
3. ÇIKTI FORMATI:
   3-8 maddelik, Markdown formatında yapılandırılmış net bir "Araştırma Boşlukları" listesi oluştur.
   Her madde için, bu boşluğun neden var olduğunu sağlanan kaynaklara atıfta bulunarak açıkla.
   
   Örnek:
   ### 1. Gerçek Zamanlı İşleme Eksikliği
   İncelenen çalışmaların çoğu (Kaynak 1, 3, 5) sadece çevrimdışı analizlere odaklanmıştır...

   ### 2. Sınırlı Örneklem Grupları
   ...

DİL: TÜRKÇE (Akademik üslup).
    `;

    if (provider === 'gemini') {
      const ai = getAIClient(apiKey);
      const response = await ai.models.generateContent({
        model: "gemini-1.5-pro",
        contents: prompt + "\n\nSOURCES:\n" + paperContexts
      });
      return response.text || "Gap Analysis Failed.";
    } else {
      const response = await fetch(`${ollamaConfig.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaConfig.model,
          prompt: `${prompt}\n\nSOURCES:\n${paperContexts}`,
          stream: false,
          options: { num_ctx: 32768 }
        })
      });
      if (!response.ok) throw new Error("Ollama generation failed");
      const data = await response.json();
      return data.response;
    }

  } catch (error) {
    console.error("Gap Analysis Failed:", error);
    return "Error generating gap analysis.";
  }
};

// --- NEW: SIMPLE REPORT (Use existing abstracts) ---
export const generateSimpleReport = (
  topic: string,
  papers: Paper[],
): string => {
  const date = new Date().toLocaleDateString();

  let report = `# Literature Review: ${topic}\n\n`;
  report += `**Generated Date:** ${date}\n\n`;
  report += `> [!NOTE]\n> This report is a compilation of the identified sources.\n\n`;

  // 1. Body
  papers.forEach((paper, index) => {
    report += `## ${index + 1}. ${paper.title}\n\n`;
    report += `**Authors:** ${paper.authors} (${paper.year})\n`;
    report += `**DOI/URL:** ${paper.doi || paper.url}\n\n`;

    // Clean up summary if it's "Abstract not available"
    let content = paper.summary;
    if (!content || content.includes("No abstract available")) {
      content = "Abstract not available for this source.";
    }

    report += `${content}\n\n`;
  });

  // 2. References
  report += `# References\n\n`;

  // Sort by author name for APA style
  const sortedPapers = [...papers].sort((a, b) => {
    const authorA = a.authors ? a.authors.toLowerCase() : "";
    const authorB = b.authors ? b.authors.toLowerCase() : "";
    return authorA.localeCompare(authorB);
  });

  sortedPapers.forEach((p) => {
    report += `* ${p.authors} (${p.year}). *${p.title}*. Retrieved from ${p.doi ? 'https://doi.org/' + p.doi : p.url}\n`;
  });

  return report;
};