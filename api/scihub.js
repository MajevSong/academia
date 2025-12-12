export default async function handler(req, res) {
    // Extract the path after /api/scihub/
    // In Vercel, req.query usually contains the path parameters if configured, 
    // but for a simple rewriting, we might need to parse the URL or use a query parameter.
    // Let's assume the client sends the path as a query param or we handle the wildcard in vercel.json
    // Strategy: Client sends /api/scihub?path=... OR we rely on rewriting.
    // Simplified for Vercel: We'll accept a 'path' query param or just simple forwarding.

    // NOTE: parsing the raw URL in Vercel functions to simulate the complex "rewrite" 
    // logic from Vite might be tricky.
    // Let's check how the proxy was used: `/api/scihub/${targetPath}`
    // We will configure vercel.json to map `/api/scihub/(.*)` to `api/scihub.js?path=$1`

    const { path } = req.query;
    const targetPath = path || '';
    let currentUrl = `https://sci-hub.se/${targetPath}`;

    let attempts = 0;

    try {
        while (attempts < 5) {
            console.log(`[SciHubProxy] Attempt ${attempts + 1}: ${currentUrl}`);

            const response = await fetch(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (location) {
                    currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).toString();
                    attempts++;
                    continue;
                }
            }

            const buffer = await response.arrayBuffer();
            const buf = Buffer.from(buffer);
            const contentType = response.headers.get('content-type') || '';

            if (contentType.includes('text/html')) {
                const htmlString = buf.toString();
                // Regex logic ported from vite.config.ts
                const srcMatch = htmlString.match(/(?:<iframe|<embed).*?src=["']([^'"]+\.pdf.*?)['"]/i) ||
                    htmlString.match(/location\.href\s*=\s*['"]([^'"]+\.pdf.*?)['"]/i) ||
                    htmlString.match(/<iframe.*?src=["']((?!http).+?)['"]/i);

                if (srcMatch && srcMatch[1]) {
                    let pdfUrl = srcMatch[1];
                    if (pdfUrl.startsWith('//')) {
                        pdfUrl = 'https:' + pdfUrl;
                    } else if (pdfUrl.startsWith('/')) {
                        const urlObj = new URL(currentUrl);
                        pdfUrl = `${urlObj.protocol}//${urlObj.host}${pdfUrl}`;
                    } else if (!pdfUrl.startsWith('http')) {
                        const urlObj = new URL(currentUrl);
                        const pathDir = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
                        pdfUrl = `${urlObj.protocol}//${urlObj.host}${pathDir}/${pdfUrl}`;
                    }
                    currentUrl = pdfUrl;
                    attempts++;
                    continue;
                }
            }

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', contentType);
            res.status(response.status).send(buf);
            return;
        }

        res.status(500).send("Too many redirects");

    } catch (e) {
        console.error("[SciHubProxy] Failed:", e);
        res.status(500).send("Proxy Error");
    }
}
