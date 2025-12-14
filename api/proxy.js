export default async function handler(req, res) {
    const { url } = req.query;

    if (!url) {
        res.status(400).send("Missing 'url' query parameter");
        return;
    }

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/pdf',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0'
            },
            redirect: 'follow'
        });

        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const buffer = await response.arrayBuffer();

        // LOG for debugging (shorten URL for readability)
        console.log(`[Proxy-v2] Status: ${response.status} (${typeof response.status}) | Size: ${buffer.byteLength} | URL: ${url.substring(0, 50)}`);

        // BLOCK 202 LOOP
        if (response.status == 202) {
            console.log(`[Proxy-v2] BLOCKED 202!`);
            res.status(429).send("Resource Processing (Blocked by Proxy)");
            return;
        }

        // CRITICAL: Handle Binary (PDF) vs Text (HTML) differently
        if (contentType.includes('application/pdf') || contentType.includes('octet-stream')) {
            // BINARY: Return as-is (PDF)
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Length', buffer.byteLength);
            res.status(response.status).send(Buffer.from(buffer));
        } else {
            // TEXT (HTML): Decode, strip ads, return
            const decoder = new TextDecoder('utf-8');
            let htmlText = decoder.decode(buffer);

            // Strip Google Ads, Analytics, and GTM
            htmlText = htmlText.replace(/<script\b[^>]*src="[^"]*(googleads|googletagmanager|google-analytics)[^"]*"[^>]*>[\s\S]*?<\/script>/gmi, "");
            htmlText = htmlText.replace(/<script\b[^>]*>[\s\S]*?(gtag|GoogleAnalyticsObject)[\s\S]*?<\/script>/gmi, "");

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.status(response.status).send(htmlText);
        }
    } catch (e) {
        console.error("Proxy Error:", e);
        res.status(500).send("Proxy Error");
    }
}
