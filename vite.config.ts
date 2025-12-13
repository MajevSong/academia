import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api/semantic': {
          target: 'https://api.semanticscholar.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/semantic/, ''),
        },
        // Generic Proxy for any PDF/Page
        '/api/proxy': {
          target: 'http://localhost:3000', // Self-referential dummy
          bypass: async (req, res) => {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
              res.statusCode = 400;
              res.end("Missing 'url' query parameter");
              return false;
            }

            try {
              console.log(`[GenericProxy] Fetching: ${targetUrl}`);

              try {
                const response = await fetch(targetUrl, {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Upgrade-Insecure-Requests': '1',
                  },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(15000) // Increase timeout to 15s
                });

                if (!response.ok) {
                  console.warn(`[API] Proxy received status: ${response.status}`);
                  res.statusCode = response.status;
                  const text = await response.text();
                  res.end(text);
                  return false;
                }

                // Forward content type
                const contentType = response.headers.get('content-type');
                if (contentType) res.setHeader('Content-Type', contentType);

                // Allow CORS for the helper
                res.setHeader('Access-Control-Allow-Origin', '*');

                // Forward Content-Disposition if present (for actual filenames)
                const contentDisposition = response.headers.get('content-disposition');
                if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

                const arrayBuffer = await response.arrayBuffer();
                res.end(Buffer.from(arrayBuffer));
              } catch (proxyError: any) {
                console.error(`[GenericProxy] Failed to fetch ${targetUrl}:`, proxyError.message);
                if (!res.headersSent) {
                  res.statusCode = 504; // Gateway Timeout
                  res.end(`Proxy Error: ${proxyError.message}`);
                }
                return false;
              }
            } catch (e) {
              console.error("[GenericProxy] Error", e);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: "Proxy Failed", details: e.message }));
              return false;
            }
          }
        },
        // GOOGLE SCHOLAR PROXY (Robust Local Scraper)
        '/api/scholar': {
          target: 'https://scholar.google.com',
          changeOrigin: true,
          bypass: async (req, res) => {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            const query = url.searchParams.get('q');
            const num = url.searchParams.get('num') || '10'; // Default 10, allow override

            if (!query) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "Missing query" }));
              return false;
            }

            // Mimic SerpApi structure
            const targetUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en&as_sdt=0,5&num=${num}`;
            console.log(`[ScholarProxy] Scraping: ${targetUrl}`);

            try {
              // Dynamic import to avoid build issues if not installed yet
              const cheerio = await import('cheerio');

              // Fetch with robust headers
              const fetchRes = await fetch(targetUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept': 'text/html,application/xhtml+xml,application/xml',
                  'Accept-Language': 'en-US,en;q=0.9',
                  'Cache-Control': 'no-cache',
                  'Pragma': 'no-cache',
                  'Referer': 'https://scholar.google.com/'
                }
              });

              if (fetchRes.status === 429) {
                console.error("[ScholarProxy] 429 Rate Limit - Google has blocked your IP temporarily.");
                res.statusCode = 429;
                res.end(JSON.stringify({ error: "Google Scholar Rate Limit (429). Try again later." }));
                return false;
              }

              const html = await fetchRes.text();
              const $ = cheerio.load(html);

              const organic_results = [];

              // Robust selector based on user feedback
              const results = $('#gs_res_ccl_mid > div[data-rp]');
              console.log(`[ScholarProxy] Found ${results.length} results via data-rp`);

              results.each((i, el) => {
                try {
                  const titleHtml = $(el).find('h3.gs_rt');
                  const titleLink = titleHtml.find('a');

                  const title = titleLink.length ? titleLink.text().trim() : titleHtml.text().trim();
                  const link = titleLink.attr('href') || '';

                  const snippet = $(el).find('.gs_rs').text().trim().replace(/\n/g, ' ');
                  const publicationInfo = $(el).find('.gs_a').text().trim().replace(/\u00A0/g, ' ');

                  // Parse Author/Year from publication info
                  // Format: Author - Venue, Year - Publisher
                  // e.g. "JL Harper - Population biology of plants., 1977 - cabdirect.org"
                  const yearMatch = publicationInfo.match(/\b(19|20)\d{2}\b/);
                  const year = yearMatch ? yearMatch[0] : '';

                  // Extract Citations
                  const footerLinks = $(el).find('.gs_fl a');
                  let cited_by_count = 0;
                  let cited_by_link = '';

                  footerLinks.each((_, linkEl) => {
                    const txt = $(linkEl).text();
                    if (txt.includes('Cited by')) {
                      cited_by_count = parseInt(txt.replace('Cited by ', '').trim()) || 0;
                      cited_by_link = $(linkEl).attr('href') || '';
                    }
                  });

                  // Extract Right-Side PDF/HTML Link (The "View It" link)
                  const pdfLinkEl = $(el).find('.gs_ggs .gs_or_ggsm a');
                  const pdfLink = pdfLinkEl.attr('href') || '';

                  if (title && title.length > 3) {
                    organic_results.push({
                      title,
                      link,
                      pdf_link: pdfLink, // New field for direct PDF
                      snippet,
                      publication_info: { summary: publicationInfo },
                      inline_links: {
                        cited_by: {
                          total: cited_by_count,
                          link: cited_by_link ? `https://scholar.google.com${cited_by_link}` : ''
                        }
                      },
                      // Helper fields for our app
                      authors: publicationInfo.split(' - ')[0] || "Unknown",
                      year: year
                    });
                  }
                } catch (parseErr) {
                  console.error("Error parsing row", parseErr);
                }
              });

              console.log(`[ScholarProxy] Successfully parsed ${organic_results.length} results.`);

              const responseData = {
                search_metadata: {
                  status: "Success",
                  google_scholar_url: targetUrl
                },
                organic_results
              };

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(responseData));
              return false;

            } catch (e) {
              console.error("[ScholarProxy] Critical Error", e);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
              return false;
            }
          }
        },

        '/api/scihub': {
          target: 'https://sci-hub.se',
          changeOrigin: true,
          bypass: async (req, res) => {
            if (req.url && req.url.startsWith('/api/scihub')) {
              const targetPath = req.url.replace(/^\/api\/scihub\//, '');
              let currentUrl = `https://sci-hub.se/${targetPath}`;

              // Robust Redirect Loop
              let attempts = 0;
              while (attempts < 5) {
                try {
                  console.log(`[SciHubProxy] Attempt ${attempts + 1}: ${currentUrl}`);
                  const response = await fetch(currentUrl, {
                    method: 'GET',
                    redirect: 'manual', // We handle it manually to debug
                    headers: {
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                  });

                  if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location');
                    if (location) {
                      // Handle relative or absolute redirects
                      currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).toString();
                      attempts++;
                      continue;
                    }
                  }

                  // If we are here, we have the final response (HTML or PDF)
                  const buffer = await response.arrayBuffer();
                  const buf = Buffer.from(buffer);

                  // Check content type
                  const contentType = response.headers.get('content-type') || '';

                  // IF IT'S HTML, TRY TO EXTRACT PDF URL
                  if (contentType.includes('text/html')) {
                    console.log("[SciHubProxy] Received HTML. Attempting API/PDF extraction...");
                    const htmlString = buf.toString();

                    // Regex to catch:
                    // <iframe src="..."
                    // <embed src="..."
                    // location.href='...'
                    // <div id="article"> <iframe src="..." ...

                    const srcMatch = htmlString.match(/(?:<iframe|<embed).*?src=["']([^'"]+\.pdf.*?)['"]/i) ||
                      htmlString.match(/location\.href\s*=\s*['"]([^'"]+\.pdf.*?)['"]/i) ||
                      htmlString.match(/<iframe.*?src=["']((?!http).+?)['"]/i); // Catch relative iframes that might be pdfs without .pdf extension? Less safe.

                    if (srcMatch && srcMatch[1]) {
                      let pdfUrl = srcMatch[1];

                      // Handle "src=" being just a path without domain
                      if (pdfUrl.startsWith('//')) {
                        pdfUrl = 'https:' + pdfUrl;
                      } else if (pdfUrl.startsWith('/')) {
                        const urlObj = new URL(currentUrl);
                        pdfUrl = `${urlObj.protocol}//${urlObj.host}${pdfUrl}`;
                      } else if (!pdfUrl.startsWith('http')) {
                        // Relative path without leading slash?
                        const urlObj = new URL(currentUrl);
                        const pathDir = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
                        pdfUrl = `${urlObj.protocol}//${urlObj.host}${pathDir}/${pdfUrl}`;
                      }

                      console.log(`[SciHubProxy] Found PDF URL in HTML: ${pdfUrl}`);
                      // Redirect to the actual PDF
                      currentUrl = pdfUrl;
                      attempts++;
                      continue; // Loop back to fetch the PDF
                    } else {
                      console.log("[SciHubProxy] Could not find PDF URL in HTML. Serving HTML.");
                    }
                  }

                  res.setHeader('Access-Control-Allow-Origin', '*');
                  res.setHeader('Content-Type', contentType);
                  res.setHeader('Content-Length', buf.length);
                  res.writeHead(response.status, response.statusText);
                  res.end(buf);
                  return false;

                } catch (e) {
                  console.error("[SciHubProxy] Failed:", e);
                  res.statusCode = 500;
                  res.end("Proxy Error");
                  return false;
                }
              }

              res.statusCode = 500;
              res.end("Too many redirects");
              return false;
            }
            return null;
          }
        }
      },
    },
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
