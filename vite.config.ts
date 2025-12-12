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
              const response = await fetch(targetUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                redirect: 'follow'
              });

              // Pipe response
              const buffer = await response.arrayBuffer();
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
              res.end(Buffer.from(buffer));
              return false;
            } catch (e) {
              console.error("[GenericProxy] Error:", e);
              res.statusCode = 500;
              res.end("Proxy Error");
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
