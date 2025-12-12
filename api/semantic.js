export default async function handler(req, res) {
    const { query } = req;
    const targetUrl = 'https://api.semanticscholar.org/graph/v1/paper/search';

    // Construct query string from req.query
    const queryString = new URLSearchParams(query).toString();
    const fullUrl = `${targetUrl}?${queryString}`;

    try {
        const response = await fetch(fullUrl, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            },
        });

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch from Semantic Scholar" });
    }
}
