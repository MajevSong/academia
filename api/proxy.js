export default async function handler(req, res) {
    const { url } = req.query;

    if (!url) {
        res.status(400).send("Missing 'url' query parameter");
        return;
    }

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            redirect: 'follow'
        });

        const buffer = await response.arrayBuffer();

        // Set CORS and Content-Type
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');

        res.status(response.status).send(Buffer.from(buffer));
    } catch (e) {
        console.error("Proxy Error:", e);
        res.status(500).send("Proxy Error");
    }
}
