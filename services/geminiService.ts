import { GoogleGenAI, Type, Schema } from "@google/genai";
import { LibrarianResult, DataScientistResult, AnalysisResult, AIProvider, SearchProvider, OllamaConfig, Paper, SearchFilters, DownloadedDocument } from "../types";

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
  } catch (error) {
    console.error("PDF Parsing Error:", error);
    return ""; // Fallback to empty string on failure
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
const optimizeSearchQuery = async (topic: string, provider: AIProvider, ollamaConfig?: OllamaConfig, apiKey?: string): Promise<string> => {
  const prompt = `Task: Extract 3-5 distinct academic search keywords from: "${topic}".
  Output ONLY the keywords separated by spaces. No explanations. No bullets.
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

    let clean = keywords.replace(/["\n]/g, ' ').replace(/keywords?:?/i, '').trim();

    if (clean.length < 5 || clean.includes(topic)) {
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
        if (retryCount > 3) break;
        await delay(2000 * (retryCount + 1));
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
          const hasDoi = p.externalIds?.DOI;
          const hasTitle = p.title && p.title.length > 5;
          const hasAuthors = p.authors && p.authors.length > 0;
          return hasDoi && hasTitle && hasAuthors;
        })
        .map((p: any) => {
          const authorList = p.authors.map((a: any) => a.name).join(", ");
          const openAccessUrl = p.openAccessPdf?.url;
          const doiLink = `https://doi.org/${p.externalIds.DOI}`;
          const finalUrl = openAccessUrl || doiLink;

          return {
            title: p.title,
            authors: authorList,
            year: p.year ? p.year.toString() : "N/A",
            doi: p.externalIds.DOI,
            url: finalUrl,
            // Fallback chain: Abstract -> TLDR -> Placeholder
            summary: p.abstract || (p.tldr ? p.tldr.text : "No abstract available.")
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

  if (searchProvider === 'semantic_scholar') {
    const targetDepth = filters.scanDepth || 50;
    let aggregatedPapers: Paper[] = [];
    const seenTitles = new Set<string>();

    const aiQuery = await optimizeSearchQuery(topic, provider, ollamaConfig, apiKey);
    console.log(`Librarian Strategy 1 (AI): "${aiQuery}"`);
    const papers1 = await searchSemanticScholar(aiQuery, filters, targetDepth);
    papers1.forEach(p => { if (!seenTitles.has(p.title)) { seenTitles.add(p.title); aggregatedPapers.push(p); } });

    if (aggregatedPapers.length < targetDepth) {
      const basicQuery = extractKeywordsBasic(topic);
      const needed = targetDepth - aggregatedPapers.length;
      console.log(`Librarian Strategy 2 (Basic): "${basicQuery}" (Need ${needed} more)`);

      if (basicQuery !== aiQuery) {
        const papers2 = await searchSemanticScholar(basicQuery, filters, needed);
        papers2.forEach(p => { if (!seenTitles.has(p.title)) { seenTitles.add(p.title); aggregatedPapers.push(p); } });
      }
    }

    if (aggregatedPapers.length < targetDepth) {
      const words = topic.replace(/[^\w\s]/g, '').split(/\s+/).sort((a, b) => b.length - a.length);
      const broadQuery = words.slice(0, 3).join(' ');
      const needed = targetDepth - aggregatedPapers.length;

      const papers3 = await searchSemanticScholar(broadQuery, filters, needed);
      papers3.forEach(p => { if (!seenTitles.has(p.title)) { seenTitles.add(p.title); aggregatedPapers.push(p); } });
    }

    if (aggregatedPapers.length === 0) {
      return { papers: [], researchGap: `Unable to find papers for topic: "${topic}". Try simplifying the topic manually.` };
    }

    const finalPapers = aggregatedPapers.slice(0, targetDepth);

    // SKIP IMMEDIATE GAP ANALYSIS (User requested to defer this until Final Report)
    const gapAnalysis = "Gap analysis will be generated after Final Report.";

    return { papers: finalPapers, researchGap: gapAnalysis };
  }

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
export const fetchAbstractFromUrl = async (targetUrl: string, provider: AIProvider, ollamaConfig?: OllamaConfig, apiKey?: string): Promise<string> => {
  try {
    // 1. Fetch HTML via Proxy
    // We treat it as a generic proxy request
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error("Failed to fetch page content");

    const htmlText = await res.text();
    // Strip minimal tags to reduce token usage, but keep structure
    const cleanedHtml = htmlText.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gmi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gmi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .slice(0, 30000); // Limit context

    const prompt = `
    TASK: Extract the ACADEMIC ABSTRACT from the following web page content.
    RULES:
    1. Extract the text VERBATIM (Word-for-word).
    2. Do NOT summarize. Do NOT format.
    3. Return ONLY the abstract text.
    4. If no abstract is found, return "NO_ABSTRACT_FOUND".

    Web Content:
    ${cleanedHtml}
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
    return "";
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
  } catch (e) {
    console.error(e);
    finalReport = "# Literature Review Error\n\nUnable to generate report.";
  }
  return finalReport;
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

// --- NEW: DETAILED BIBLIOGRAPHIC REPORT ---
export const generateDetailedBibliographicReport = async (
  topic: string,
  papers: Paper[],
  documents: DownloadedDocument[],
  provider: AIProvider,
  ollamaConfig: OllamaConfig,
  apiKey?: string
): Promise<string> => {
  try {
    // 1. Prepare Data Context
    const paperContexts = papers.map((paper, index) => {
      // Try to find full text
      const doc = documents.find(d => d.title === paper.title || d.originalUrl === paper.url);
      const hasFullText = !!(doc && doc.textContent && doc.textContent.length > 500);
      const content = hasFullText ? doc!.textContent : paper.summary;

      return `
PAPER #${index + 1}:
Title: ${paper.title}
Authors: ${paper.authors}
Year: ${paper.year}
URL: ${paper.url}
Source Type: ${hasFullText ? "FULL TEXT PROVIDED" : "ABSTRACT ONLY"}
Content:
${(content || "").slice(0, 15000)} // Truncate very long texts to fit context window if needed
--------------------------------------------------
`;
    }).join('\n');

    const prompt = `
GÖREV: Aşağıdaki makaleleri ve kaynakları kullanarak "${topic}" konusu üzerine "Detaylı Literatür Taraması Raporu" oluştur.

TALİMATLAR:
1. Listede verilen HER BİR makale için ayrı ve detaylı bir özet yaz.
2. "FULL TEXT PROVIDED" (Tam Metin) olanlar için: Tam metni kullanarak çok detaylı, kapsamlı (en az 4-5 paragraf) bir özet çıkar. Asla kısaltma yapma.
3. "ABSTRACT ONLY" (Sadece Özet) olanlar için: Mevcut abstract metnini OLDUĞU GİBİ, KELİMESİ KELİMESİNE Türkçe'ye çevir. ASLA KENDİ CÜMLELERİNLE YENİDEN YAZMA (PARAPHRASE YAPMA). Kaynakta ne varsa birebir çevirisi raporda yer almalıdır. Ekleme veya çıkarma yapma.
4. ÖNEMLİ FORMAT KURALI: Her özetin en başında mutlaka çalışmanın yazarlarından bahset. 
   Örnek: "Yılmaz ve arkadaşları (2023) tarafından yapılan bu çalışmada..." veya "Smith (2022) bu araştırmasında..."

5. METİN İÇİ ATIF:
   Her makalenin özetinin sonuna, o makalenin Kaynakça listesindeki numarasına atıf ver.
   Format: [ID: {sıra_numarası}]
   Örnek: ...sonucuna varılmıştır. [ID: 1]

6. Her makale için şu formatı TİTİZLİKLE uygula:

## [Makale Başlığı]
[Yazarlara atıfla başlayan, ABSTRACT metninin tamamını içeren detaylı içerik...]

**Link**: [Çalışmanın orijinal URL adresini buraya https:// ile başlayacak şekilde yaz.]
**Kaynak No**: [ID: {sıra_numarası}]

7. Tüm makaleler bittikten sonra en sona şu başlığı ekle:
# Kaynakça
[Burada tüm kaynakları listele. HER KAYNAĞIN BAŞINA ÖZEL BİR ETİKET KOY.]

Format:
[[REF:{sıra_numarası}]] {Yazar Adları}. ({Yıl}). {Başlık}. {Yayın Yeri}. DOI:...

Örnek:
[[REF:1]] Yılmaz, A. (2023). Örnek Çalışma...
[[REF:2]] Smith, J. (2022). Sample Study...

Listelenen ${papers.length} makalenin HEPSİNİ işle.
DİL: TÜRKÇE.
    `;

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
export const generateResearchGapAnalysis = async (
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