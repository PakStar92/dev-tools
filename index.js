// Multi-Site Video Downloader using HTML Parsing
// Supports YouTube, Instagram, TikTok, Facebook, etc.

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Configuration
const DOWNLOAD_FOLDER = './downloads';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Ensure download folder exists
if (!fs.existsSync(DOWNLOAD_FOLDER)) {
    fs.mkdirSync(DOWNLOAD_FOLDER, { recursive: true });
}

// Video downloader services
const SERVICES = {
    savefrom: 'https://savefrom.net',
    savetube: 'https://savetube.me',
    y2mate: 'https://www.y2mate.com',
    ssyoutube: 'https://ssyoutube.com',
    keepvid: 'https://keepvid.pro'
};

// Utility functions
function cleanUrl(url) {
    // Remove tracking parameters and normalize URL
    try {
        const urlObj = new URL(url);
        // Remove common tracking parameters
        const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid'];
        paramsToRemove.forEach(param => urlObj.searchParams.delete(param));
        return urlObj.toString();
    } catch (e) {
        return url;
    }
}

function generateFilename(title, ext = 'mp4') {
    // Clean title for filename
    const clean = title.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
    const short = clean.substring(0, 100); // Limit length
    return `${short}_${Date.now()}.${ext}`;
}

function getVideoId(url) {
    // Extract YouTube video ID from various URL formats
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /youtube\.com\/v\/([^&\n?#]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// Service parsers
class VideoDownloaderService {
    constructor() {
        this.axios = axios.create({
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 30000,
            maxRedirects: 5
        });
    }

    async parseSaveFrom(videoUrl) {
        try {
            console.log('[SaveFrom] Parsing:', videoUrl);
            const response = await this.axios.get(`${SERVICES.savefrom}/process`, {
                params: { url: videoUrl }
            });

            const $ = cheerio.load(response.data);
            const downloads = [];

            // Parse download links
            $('.download-link, .link-download, a[href*="download"]').each((i, element) => {
                const $el = $(element);
                const downloadUrl = $el.attr('href');
                const quality = $el.find('.quality, .resolution').text().trim() || 
                              $el.text().match(/(\d+p|\d+x\d+|HD|SD)/i)?.[0] || 'Unknown';
                const format = $el.text().match(/(mp4|webm|mp3|m4a)/i)?.[0] || 'mp4';

                if (downloadUrl && downloadUrl.startsWith('http')) {
                    downloads.push({
                        url: downloadUrl,
                        quality: quality,
                        format: format.toLowerCase(),
                        service: 'savefrom'
                    });
                }
            });

            // Also check for direct video sources
            $('video source, video').each((i, element) => {
                const src = $(element).attr('src');
                if (src && src.startsWith('http')) {
                    downloads.push({
                        url: src,
                        quality: 'Direct',
                        format: 'mp4',
                        service: 'savefrom'
                    });
                }
            });

            return { success: true, downloads, service: 'savefrom' };
        } catch (error) {
            console.error('[SaveFrom] Error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async parseSaveTube(videoUrl) {
        try {
            console.log('[SaveTube] Parsing:', videoUrl);
            
            // SaveTube often requires POST request
            const formData = new URLSearchParams();
            formData.append('url', videoUrl);
            
            const response = await this.axios.post(`${SERVICES.savetube}/download`, formData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': SERVICES.savetube
                }
            });

            const $ = cheerio.load(response.data);
            const downloads = [];

            // Parse download options
            $('.download-item, .download-option, .quality-item').each((i, element) => {
                const $el = $(element);
                const downloadUrl = $el.find('a').attr('href') || $el.attr('href');
                const quality = $el.find('.quality, .resolution').text().trim() || 
                              $el.text().match(/(\d+p|\d+x\d+|HD|SD)/i)?.[0] || 'Unknown';
                const format = $el.text().match(/(mp4|webm|mp3|m4a)/i)?.[0] || 'mp4';

                if (downloadUrl && downloadUrl.startsWith('http')) {
                    downloads.push({
                        url: downloadUrl,
                        quality: quality,
                        format: format.toLowerCase(),
                        service: 'savetube'
                    });
                }
            });

            return { success: true, downloads, service: 'savetube' };
        } catch (error) {
            console.error('[SaveTube] Error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async parseY2Mate(videoUrl) {
        try {
            console.log('[Y2Mate] Parsing:', videoUrl);
            
            // Y2Mate has a multi-step process
            const analyzeResponse = await this.axios.post(`${SERVICES.y2mate}/mates/analyze/ajax`, {
                url: videoUrl,
                q_auto: 0,
                ajax: 1
            }, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': `${SERVICES.y2mate}/youtube/${getVideoId(videoUrl)}`
                }
            });

            if (analyzeResponse.data.status !== 'ok') {
                throw new Error('Y2Mate analysis failed');
            }

            const $ = cheerio.load(analyzeResponse.data.result);
            const downloads = [];

            // Parse video and audio options
            $('.download-items tr').each((i, element) => {
                const $row = $(element);
                const quality = $row.find('.text-left').first().text().trim();
                const format = $row.find('.text-center').first().text().trim();
                const downloadBtn = $row.find('.download-btn');
                
                if (downloadBtn.length > 0) {
                    const k = downloadBtn.attr('data-ftype');
                    const fquality = downloadBtn.attr('data-fquality');
                    
                    downloads.push({
                        k: k,
                        quality: quality,
                        format: format.toLowerCase(),
                        fquality: fquality,
                        service: 'y2mate',
                        needsConversion: true
                    });
                }
            });

            return { success: true, downloads, service: 'y2mate', videoId: getVideoId(videoUrl) };
        } catch (error) {
            console.error('[Y2Mate] Error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async convertY2Mate(videoId, k, ftype, fquality) {
        try {
            const convertResponse = await this.axios.post(`${SERVICES.y2mate}/mates/convert`, {
                vid: videoId,
                k: k,
                ftype: ftype,
                fquality: fquality,
                token: '',
                timeExpire: '',
                client: 'y2mate'
            });

            if (convertResponse.data.status === 'ok') {
                const $ = cheerio.load(convertResponse.data.result);
                const downloadUrl = $('a[href*="download"]').attr('href');
                return downloadUrl;
            }
            return null;
        } catch (error) {
            console.error('[Y2Mate Convert] Error:', error.message);
            return null;
        }
    }

    async getAllDownloadOptions(videoUrl) {
        const cleanedUrl = cleanUrl(videoUrl);
        const results = [];

        // Try all services in parallel
        const promises = [
            this.parseSaveFrom(cleanedUrl),
            this.parseSaveTube(cleanedUrl),
            this.parseY2Mate(cleanedUrl)
        ];

        const responses = await Promise.allSettled(promises);
        
        responses.forEach((response, index) => {
            if (response.status === 'fulfilled' && response.value.success) {
                results.push(response.value);
            }
        });

        // Combine and deduplicate results
        const allDownloads = [];
        results.forEach(result => {
            if (result.downloads) {
                allDownloads.push(...result.downloads);
            }
        });

        // Remove duplicates based on URL
        const uniqueDownloads = allDownloads.filter((download, index, self) => 
            index === self.findIndex(d => d.url === download.url)
        );

        return {
            success: uniqueDownloads.length > 0,
            downloads: uniqueDownloads,
            services: results.map(r => r.service)
        };
    }

    async downloadFile(downloadUrl, filename) {
        try {
            console.log('[Download] Starting:', filename);
            
            const response = await this.axios({
                method: 'GET',
                url: downloadUrl,
                responseType: 'stream',
                headers: {
                    'Referer': 'https://www.youtube.com/',
                    'User-Agent': USER_AGENT
                }
            });

            const filePath = path.join(DOWNLOAD_FOLDER, filename);
            await pipeline(response.data, fs.createWriteStream(filePath));
            
            console.log('[Download] Completed:', filename);
            return { success: true, filePath, filename };
        } catch (error) {
            console.error('[Download] Error:', error.message);
            return { success: false, error: error.message };
        }
    }
}

// API Routes
const downloaderService = new VideoDownloaderService();

app.get('/api/analyze', async (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        console.log('[API] Analyzing:', url);
        const result = await downloaderService.getAllDownloadOptions(url);
        
        res.json(result);
    } catch (error) {
        console.error('[API] Analyze error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/download', async (req, res) => {
    try {
        const { downloadUrl, title, format = 'mp4' } = req.body;
        
        if (!downloadUrl) {
            return res.status(400).json({ error: 'downloadUrl is required' });
        }

        const filename = generateFilename(title || 'video', format);
        console.log('[API] Downloading:', filename);
        
        const result = await downloaderService.downloadFile(downloadUrl, filename);
        
        if (result.success) {
            res.json({
                success: true,
                filename: result.filename,
                downloadPath: `/downloads/${result.filename}`
            });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('[API] Download error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve downloaded files
app.get('/downloads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOAD_FOLDER, filename);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        services: Object.keys(SERVICES),
        downloadFolder: DOWNLOAD_FOLDER
    });
});

// Basic HTML interface
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Multi-Site Video Downloader</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        .container { background: #f5f5f5; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        input[type="url"] { width: 70%; padding: 10px; margin-right: 10px; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; }
        button:hover { background: #0056b3; }
        .downloads { margin-top: 20px; }
        .download-item { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #007bff; }
        .loading { text-align: center; margin: 20px 0; }
        .error { color: red; }
        .success { color: green; }
    </style>
</head>
<body>
    <h1>🎥 Multi-Site Video Downloader</h1>
    <p>Download videos from YouTube, Instagram, TikTok, Facebook and more!</p>
    
    <div class="container">
        <input type="url" id="videoUrl" placeholder="Enter video URL (YouTube, Instagram, TikTok, etc.)" />
        <button onclick="analyzeVideo()">Analyze Video</button>
    </div>
    
    <div id="results"></div>

    <script>
        async function analyzeVideo() {
            const url = document.getElementById('videoUrl').value;
            const resultsDiv = document.getElementById('results');
            
            if (!url) {
                alert('Please enter a valid URL');
                return;
            }
            
            resultsDiv.innerHTML = '<div class="loading">🔍 Analyzing video...</div>';
            
            try {
                const response = await fetch(\`/api/analyze?url=\${encodeURIComponent(url)}\`);
                const data = await response.json();
                
                if (data.success && data.downloads.length > 0) {
                    let html = '<div class="container"><h3>✅ Available Downloads:</h3>';
                    
                    data.downloads.forEach((download, index) => {
                        html += \`
                            <div class="download-item">
                                <strong>\${download.quality} - \${download.format.toUpperCase()}</strong>
                                <small> (via \${download.service})</small><br>
                                <button onclick="downloadFile('\${download.url}', 'video_\${index}', '\${download.format}')">
                                    📥 Download
                                </button>
                            </div>
                        \`;
                    });
                    
                    html += '</div>';
                    resultsDiv.innerHTML = html;
                } else {
                    resultsDiv.innerHTML = '<div class="error">❌ No downloads found. Try a different URL or service.</div>';
                }
            } catch (error) {
                resultsDiv.innerHTML = \`<div class="error">❌ Error: \${error.message}</div>\`;
            }
        }
        
        async function downloadFile(downloadUrl, title, format) {
            try {
                const response = await fetch('/api/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ downloadUrl, title, format })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    // Create download link
                    const a = document.createElement('a');
                    a.href = data.downloadPath;
                    a.download = data.filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                } else {
                    alert('Download failed: ' + data.error);
                }
            } catch (error) {
                alert('Download error: ' + error.message);
            }
        }
    </script>
</body>
</html>
    `);
});

// Cleanup old files (every hour)
setInterval(() => {
    try {
        const files = fs.readdirSync(DOWNLOAD_FOLDER);
        const now = Date.now();
        const maxAge = 2 * 60 * 60 * 1000; // 2 hours
        
        files.forEach(file => {
            const filePath = path.join(DOWNLOAD_FOLDER, file);
            const stats = fs.statSync(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                fs.unlinkSync(filePath);
                console.log('[Cleanup] Removed old file:', file);
            }
        });
    } catch (error) {
        console.error('[Cleanup] Error:', error.message);
    }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Multi-Site Video Downloader running on port ${PORT}`);
    console.log(`📁 Downloads folder: ${DOWNLOAD_FOLDER}`);
    console.log(`🌐 Web interface: http://localhost:${PORT}`);
});

module.exports = app;
