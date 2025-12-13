
export default async function handler(request, response) {
    const { q } = request.query;

    if (!q) {
        return response.status(400).json({ error: "Missing query parameter 'q'" });
    }

    const targetUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}&hl=en&as_sdt=0,5`;

    try {
        const fetchResponse = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://scholar.google.com/'
            }
        });

        if (!fetchResponse.ok) {
            // If 429 or 403, we are blocked
            return response.status(fetchResponse.status).json({ error: "Google Scholar blocked the request (CAPTCHA/Rate Limit)" });
        }

        const html = await fetchResponse.text();

        // Simple Regex Parsing for Scholar Results
        // 1. Result Block: <div class="gs_r gs_or gs_scl">
        // 2. Title: <h3 class="gs_rt"><a href="...">...</a></h3>
        // 3. Snippet/Summary: <div class="gs_rs">...</div>
        // 4. Footer/Authors: <div class="gs_a">...</div>

        // Note: Regex parsing HTML is fragile, but sufficient for this "optimization" without external deps like cheerio

        const papers = [];
        const entryRegex = /<div class="gs_r gs_or gs_scl"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
        const matches = html.match(entryRegex) || [];

        for (const block of matches) {
            try {
                // Title & Link
                const titleMatch = block.match(/<h3 class="gs_rt">.*?<a href="([^"]+)".*?>(.*?)<\/a>.*?<\/h3>/);
                let title = "Unknown Title";
                let url = "";
                if (titleMatch) {
                    url = titleMatch[1];
                    title = titleMatch[2].replace(/<[^>]+>/g, "").replace(/\[PDF\]/g, "").trim();
                } else {
                    // Sometimes it's a citation or book without link?
                    const plainTitleMatch = block.match(/<h3 class="gs_rt">.*?>(.*?)<\/h3>/);
                    if (plainTitleMatch) title = plainTitleMatch[1].replace(/<[^>]+>/g, "").trim();
                }

                // Authors / Year / Venue
                const metaMatch = block.match(/<div class="gs_a">([\s\S]*?)<\/div>/);
                let authors = "Unknown Authors";
                let year = "N/A";
                if (metaMatch) {
                    const metaText = metaMatch[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
                    // Format: Author - Venue, Year - Publisher
                    const parts = metaText.split(" - ");
                    authors = parts[0] || authors;
                    // Try to find year (4 digits) in the remaining parts
                    const yearMatch = metaText.match(/\b(19|20)\d{2}\b/);
                    if (yearMatch) year = yearMatch[0];
                }

                // Snippet
                const snippetMatch = block.match(/<div class="gs_rs">([\s\S]*?)<\/div>/);
                let summary = "No summary available.";
                if (snippetMatch) {
                    summary = snippetMatch[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
                }

                // DOI (Scholar doesn't give clean DOIs, we have to guess or skip)
                const doi = "";

                if (title.length > 5) {
                    papers.push({
                        title,
                        authors,
                        year,
                        doi, // Empty for now, generic scraper limitation
                        url,
                        summary
                    });
                }
            } catch (e) { console.error("Parse error for block", e); }
        }

        if (papers.length === 0) {
            // If html contains "CAPTCHA" or "robot", it's a block
            if (html.includes("robot") || html.includes("captcha") || html.includes("unusual traffic")) {
                return response.status(429).json({ error: "Google Scholar CAPTCHA detected" });
            }
        }

        return response.status(200).json({ data: papers });

    } catch (error) {
        return response.status(500).json({ error: error.message });
    }
}
