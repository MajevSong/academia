# 📚 Academia - AI-Powered Academic Research Assistant

A comprehensive literature review and research assistant powered by AI. Search academic papers, download PDFs, and generate structured literature reviews automatically.

![Academia Screenshot](https://img.shields.io/badge/Status-Active-success) ![License](https://img.shields.io/badge/License-MIT-blue)

## 🌟 Features

- **🔍 Smart Academic Search**: Search Semantic Scholar and Google Scholar with AI-optimized queries
- **📄 PDF Download & Viewer**: Download and view open-access PDFs directly in the app
- **🤖 AI Analysis**: Generate literature reviews, gap analyses, and research summaries
- **💾 Local Storage**: Save your research library with IndexedDB persistence
- **📊 Export Options**: Export to JSON, CSV, or generate formatted reports
- **🔄 Flexible AI Backend**: Use Gemini API (cloud) or Ollama (local)

## 🚀 Live Demo

**[https://academia-swart-nine.vercel.app](https://academia-swart-nine.vercel.app)**

## 🛠️ Installation

### Prerequisites

- Node.js 18+
- npm or yarn
- (Optional) [Ollama](https://ollama.ai) for local AI

### Setup

```bash
# Clone the repository
git clone https://github.com/MajevSong/academia.git
cd academia

# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Add your Gemini API key (optional if using Ollama)
# Edit .env and add: GEMINI_API_KEY=your_key_here

# Start development server
npm run dev
```

Visit `http://localhost:3000`

## ⚙️ Configuration

### AI Provider Options

| Provider | Description | Setup |
|----------|-------------|-------|
| **Gemini API** | Google's cloud AI | Get API key from [Google AI Studio](https://aistudio.google.com/) |
| **Ollama** | Local AI (privacy-focused) | Install [Ollama](https://ollama.ai) + download a model |

### Using Ollama (Local AI)

1. Install Ollama from [ollama.ai](https://ollama.ai)
2. Download a model: `ollama pull gemma2:9b`
3. For web access, enable CORS:

**Windows (CMD as Admin):**
```cmd
setx OLLAMA_ORIGINS "*"
```
Then restart Ollama.

**Windows (PowerShell - temporary):**
```powershell
$env:OLLAMA_ORIGINS="*"; ollama serve
```

**Mac/Linux:**
```bash
OLLAMA_ORIGINS=* ollama serve
```

## 📖 Usage

### 1. Start a Research Session

1. Enter your research topic (e.g., "machine learning in healthcare")
2. Select AI provider (Gemini or Ollama)
3. Select search source (Semantic Scholar recommended)
4. Set number of papers to find (10-100)
5. Click "Start Research"

### 2. Browse Results

- **Sources Tab**: View all found papers with abstracts
- **Data & Docs Tab**: View downloaded PDFs
- **Report Tab**: AI-generated literature review

### 3. Download Papers

- Click the download button on any paper with open access
- PDFs are displayed directly in the app
- All downloads are saved locally

### 4. Export Your Research

- **JSON**: Full library with all metadata
- **CSV**: Spreadsheet-compatible format
- **Report**: Formatted literature review document

## 🏗️ Tech Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: Vanilla CSS with modern design
- **AI**: Google Gemini API / Ollama
- **Search**: Semantic Scholar API, Google Scholar (scraped)
- **Storage**: IndexedDB (via idb library)
- **Deployment**: Vercel

## 📁 Project Structure

```
academia/
├── api/                  # Serverless API functions
│   └── proxy.js          # CORS proxy for PDF downloads
├── components/
│   └── ResultsView.tsx   # Main results component
├── services/
│   ├── geminiService.ts  # AI and search logic
│   └── storageService.ts # IndexedDB persistence
├── App.tsx               # Main application
├── vite.config.ts        # Vite config with proxy settings
└── README.md
```

## 🔧 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/api/proxy?url=...` | CORS proxy for PDFs/pages |
| `/api/semantic/...` | Semantic Scholar API proxy |
| `/api/scholar?q=...` | Google Scholar scraper |

## 🐛 Troubleshooting

### "Access to storage is not allowed"
- This is a browser storage warning, usually safe to ignore
- Try using an incognito window if issues persist

### Ollama CORS Error
- Make sure to set `OLLAMA_ORIGINS=*` environment variable
- Restart Ollama after setting the variable

### Rate Limiting (429 errors)
- Semantic Scholar has rate limits
- Wait 1-2 minutes before retrying
- The app automatically handles retries

### PDF Download Failed
- Some papers don't have open access PDFs
- Check if the paper has an "Open Access" badge
- Try the direct link to the publisher

## 📄 License

MIT License - feel free to use for personal and commercial projects.

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## 📧 Contact

- GitHub: [@MajevSong](https://github.com/MajevSong)

---

**Made with ❤️ for researchers worldwide**
