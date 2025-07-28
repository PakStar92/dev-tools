// Direct CDN URL Video Downloader - No File Storage
// Returns direct download URLs by parsing HTML forms and APIs

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URLSearchParams } = require('url');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Configuration
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = 30000;

// Service configurations with their form parsing methods
const SERVICES = {
    savefrom: {
        url: 'https://savefrom.net',
        method: 'parseFormSubmission',
        formSelector: '#sf_form',
        inputName: 'sf_url'
    },
    savetube: {
        url: 'https://savetube.me',
        method: 'parseAjaxAPI',
        apiEndpoint: '/api/convert',
        formData: { format: 'mp4' }
    },
    y2mate: {
        url: 'https://www.y2mate.com',
        method: 'parseMultiStep',
        analyzeEndpoint: '/mates/analyze/ajax',
        convertEndpoint: '/mates/convert'
    },
    loader: {
        url: 'https://loader.to',
        method: 'parseDirectAPI',
        apiEndpoint: '/api/button',
        convertEndpoint: '/api/convert'
    },
    ytmp3: {
        url: 'https://ytmp3.cc',
        method: 'parseFormSubmission',
        formSelector: '#convert-form',
        inputName: 'url'
    }
};

class DirectVideoDownloader {
    constructor() {
        this.axios = axios.create({
            timeout: TIMEOUT,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            }
        });
    }

    // Extract video ID from URL
    getVideoId(url) {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
            /youtube\.com\/v\/([^&\n?#]+)/,
            /(?:instagram\.com\/p\/|instagram\.com\/reel\/)([^\/\?]+)/,
            /(?:tiktok\.com\/@[^\/]+\/video\/|vm\.tiktok\.com\/)([^\/\?]+)/
        ];
        
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    // Parse SaveFrom.net HTML form
    async parseSaveFromNet(videoUrl) {
        try {
            console.log('[SaveFrom] Parsing form for:', videoUrl);
            
            // Step 1: Get the main page to extract form data
            const mainPage = await this.axios.get(SERVICES.savefrom.url);
            const $ = cheerio.load(mainPage.data);
            
            // Extract form data
            const form = $(SERVICES.savefrom.formSelector);
            const action = form.attr('action') || '/process';
            const method = form.attr('method') || 'POST';
            
            // Get all hidden form fields
            const formData = new URLSearchParams();
            form.find('input[type="hidden"]').each((i, el) => {
                const name = $(el).attr('name');
                const value = $(el).attr('value');
                if (name && value) {
                    formData.append(name, value);
                }
            });
            
            // Add the video URL
            formData.append(SERVICES.savefrom.inputName, videoUrl);
            
            // Step 2: Submit form to get download page
            const submitResponse = await this.axios.post(
                SERVICES.savefrom.url + action,
                formData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': SERVICES.savefrom.url,
                        'Origin': SERVICES.savefrom.url
                    }
                }
            );
            
            // Step 3: Parse download links from response
            const downloadPage = cheerio.load(submitResponse.data);
            const downloads = [];
            
            // Look for direct download links
            downloadPage('.download-link, a[href*="googlevideo.com"], a[href*="fbcdn.net"], a[href*="cdninstagram.com"]').each((i, element) => {
                const $el = downloadPage(element);
                const href = $el.attr('href');
                
                if (href && (href.includes('googlevideo.com') || href.includes('fbcdn.net') || href.includes('cdninstagram.com'))) {
                    const quality = $el.text().match(/(\d+p|\d+x\d+|HD|SD)/i)?.[0] || 'Unknown';
                    const format = href.match(/mime=video%2F(\w+)|\.(\w+)/)?.[1] || 'mp4';
                    
                    downloads.push({
                        directUrl: href,
                        quality: quality,
                        format: format,
                        service: 'savefrom',
                        type: 'video'
                    });
                }
            });
            
            // Look for JavaScript variables containing URLs
            const scriptText = downloadPage('script').text();
            const urlMatches = scriptText.match(/https:\/\/[^"']+(?:googlevideo\.com|fbcdn\.net|cdninstagram\.com)[^"']*/g);
            if (urlMatches) {
                urlMatches.forEach(url => {
                    if (!downloads.find(d => d.directUrl === url)) {
                        downloads.push({
                            directUrl: url,
                            quality: 'Auto',
                            format: 'mp4',
                            service: 'savefrom',
                            type: 'video'
                        });
                    }
                });
            }
            
            return downloads;
            
        } catch (error) {
            console.error('[SaveFrom] Error:', error.message);
            return [];
        }
    }

    // Parse Y2Mate multi-step process
    async parseY2Mate(videoUrl) {
        try {
            console.log('[Y2Mate] Multi-step parsing for:', videoUrl);
            
            const videoId = this.getVideoId(videoUrl);
            if (!videoId) throw new Error('Could not extract video ID');
            
            // Step 1: Analyze video
            const analyzeData = new URLSearchParams({
                url: videoUrl,
                q_auto: '0',
                ajax: '1'
            });
            
            const analyzeResponse = await this.axios.post(
                SERVICES.y2mate.url + SERVICES.y2mate.analyzeEndpoint,
                analyzeData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': `${SERVICES.y2mate.url}/youtube/${videoId}`,
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                }
            );
            
            if (analyzeResponse.data.status !== 'ok') {
                throw new Error('Y2Mate analysis failed');
            }
            
            // Step 2: Parse conversion options
            const $ = cheerio.load(analyzeResponse.data.result);
            const downloads = [];
            
            // Extract conversion options
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
                        videoId: videoId,
                        needsConversion: true
                    });
                }
            });
            
            // Step 3: Convert each option to get direct URLs
            const directDownloads = [];
            for (const download of downloads.slice(0, 3)) { // Limit to 3 to avoid spam
                try {
                    const convertData = new URLSearchParams({
                        vid: download.videoId,
                        k: download.k,
                        ftype: download.format,
                        fquality: download.fquality,
                        token: '',
                        timeExpire: '',
                        client: 'y2mate'
                    });
                    
                    const convertResponse = await this.axios.post(
                        SERVICES.y2mate.url + SERVICES.y2mate.convertEndpoint,
                        convertData,
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'X-Requested-With': 'XMLHttpRequest'
                            }
                        }
                    );
                    
                    if (convertResponse.data.status === 'ok') {
                        const $result = cheerio.load(convertResponse.data.result);
                        const directUrl = $result('a[href*="download"]').first().attr('href');
                        
                        if (directUrl) {
                            directDownloads.push({
                                directUrl: directUrl,
                                quality: download.quality,
                                format: download.format,
                                service: 'y2mate',
                                type: download.format === 'mp3' ? 'audio' : 'video'
                            });
                        }
                    }
                } catch (convertError) {
                    console.warn('[Y2Mate] Convert error for', download.quality, ':', convertError.message);
                }
            }
            
            return directDownloads;
            
        } catch (error) {
            console.error('[Y2Mate] Error:', error.message);
            return [];
        }
    }

    // Parse Loader.to API
    async parseLoaderTo(videoUrl) {
        try {
            console.log('[Loader.to] API parsing for:', videoUrl);
            
            // Step 1: Get conversion options
            const apiResponse = await this.axios.get(
                `${SERVICES.loader.url}${SERVICES.loader.apiEndpoint}/?url=${encodeURIComponent(videoUrl)}`,
                {
                    headers: {
                        'Referer': SERVICES.loader.url,
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                }
            );
            
            const $ = cheerio.load(apiResponse.data);
            const downloads = [];
            
            // Look for conversion buttons
            $('.convert-btn, .download-btn').each((i, element) => {
                const $btn = $(element);
                const format = $btn.attr('data-format') || 'mp4';
                const quality = $btn.attr('data-quality') || 'auto';
                const convertUrl = $btn.attr('data-convert-url');
                
                if (convertUrl) {
                    downloads.push({
                        convertUrl: convertUrl,
                        quality: quality,
                        format: format,
                        service: 'loader.to',
                        needsConversion: true
                    });
                }
            });
            
            // Step 2: Convert each option to get direct URLs
            const directDownloads = [];
            for (const download of downloads.slice(0, 2)) { // Limit requests
                try {
                    const convertResponse = await this.axios.get(download.convertUrl, {
                        headers: {
                            'Referer': SERVICES.loader.url,
                            'X-Requested-With': 'XMLHttpRequest'
                        }
                    });
                    
                    // Parse direct download URL from response
                    if (typeof convertResponse.data === 'object' && convertResponse.data.url) {
                        directDownloads.push({
                            directUrl: convertResponse.data.url,
                            quality: download.quality,
                            format: download.format,
                            service: 'loader.to',
                            type: download.format === 'mp3' ? 'audio' : 'video'
                        });
                    } else {
                        // Parse HTML response
                        const $convert = cheerio.load(convertResponse.data);
                        const directUrl = $convert('a[href*="download"], a[download]').first().attr('href');
                        
                        if (directUrl && directUrl.startsWith('http')) {
                            directDownloads.push({
                                directUrl: directUrl,
                                quality: download.quality,
                                format: download.format,
                                service: 'loader.to',
                                type: download.format === 'mp3' ? 'audio' : 'video'
                            });
                        }
                    }
                } catch (convertError) {
                    console.warn('[Loader.to] Convert error:', convertError.message);
                }
            }
            
            return directDownloads;
            
        } catch (error) {
            console.error('[Loader.to] Error:', error.message);
            return [];
        }
    }

    // Parse SaveTube.me AJAX API
    async parseSaveTube(videoUrl) {
        try {
            console.log('[SaveTube] AJAX parsing for:', videoUrl);
            
            // Step 1: Submit URL for processing
            const formData = new URLSearchParams({
                url: videoUrl,
                format: 'mp4',
                quality: 'auto'
            });
            
            const response = await this.axios.post(
                SERVICES.savetube.url + SERVICES.savetube.apiEndpoint,
                formData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': SERVICES.savetube.url,
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                }
            );
            
            const downloads = [];
            
            // Handle JSON response
            if (typeof response.data === 'object') {
                if (response.data.status === 'success' && response.data.downloads) {
                    response.data.downloads.forEach(item => {
                        if (item.url && item.url.startsWith('http')) {
                            downloads.push({
                                directUrl: item.url,
                                quality: item.quality || 'auto',
                                format: item.format || 'mp4',
                                service: 'savetube',
                                type: item.type || 'video'
                            });
                        }
                    });
                }
            } else {
                // Handle HTML response
                const $ = cheerio.load(response.data);
                $('.download-option, .download-link').each((i, element) => {
                    const $el = $(element);
                    const href = $el.find('a').attr('href') || $el.attr('href');
                    
                    if (href && href.startsWith('http')) {
                        const quality = $el.find('.quality').text() || 'auto';
                        const format = $el.find('.format').text() || 'mp4';
                        
                        downloads.push({
                            directUrl: href,
                            quality: quality,
                            format: format.toLowerCase(),
                            service: 'savetube',
                            type: format === 'mp3' ? 'audio' : 'video'
                        });
                    }
                });
            }
            
            return downloads;
            
        } catch (error) {
            console.error('[SaveTube] Error:', error.message);
            return [];
        }
    }

    // Main function to get all direct URLs
    async getAllDirectUrls(videoUrl) {
        console.log('[DirectDownloader] Processing:', videoUrl);
        
        const results = await Promise.allSettled([
            this.parseSaveFromNet(videoUrl),
            this.parseY2Mate(videoUrl),
            this.parseLoaderTo(videoUrl),
            this.parseSaveTube(videoUrl)
        ]);
        
        const allDownloads = [];
        const services = [];
        
        results.forEach((result, index) => {
            const serviceName = ['savefrom', 'y2mate', 'loader.to', 'savetube'][index];
            
            if (result.status === 'fulfilled' && result.value.length > 0) {
                allDownloads.push(...result.value);
                services.push(serviceName);
                console.log(`[${serviceName}] Found ${result.value.length} direct URLs`);
            } else if (result.status === 'rejected') {
                console.error(`[${serviceName}] Failed:`, result.reason.message);
            }
        });
        
        // Remove duplicates and sort by quality
        const uniqueDownloads = this.removeDuplicates(allDownloads);
        const sortedDownloads = this.sortByQuality(uniqueDownloads);
        
        return {
            success: sortedDownloads.length > 0,
            downloads: sortedDownloads,
            services: services,
            total: sortedDownloads.length
        };
    }

    removeDuplicates(downloads) {
        const seen = new Set();
        return downloads.filter(download => {
            const key = `${download.directUrl}-${download.quality}-${download.format}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    sortByQuality(downloads) {
        const qualityOrder = {
            '1080p': 5, '720p': 4, '480p': 3, '360p': 2, 'auto': 1, 'unknown': 0
        };
        
        return downloads.sort((a, b) => {
            const aQuality = qualityOrder[a.quality.toLowerCase()] || 0;
            const bQuality = qualityOrder[b.quality.toLowerCase()] || 0;
            return bQuality - aQuality;
        });
    }
}

// API Routes
const downloader = new DirectVideoDownloader();

app.get('/api/dl', async (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({ 
                success: false, 
                error: 'URL parameter is required' 
            });
        }

        console.log('[API] Getting direct URLs for:', url);
        const result = await downloader.getAllDirectUrls(url);
        
        res.json(result);
    } catch (error) {
        console.error('[API] Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        message: 'Direct Video URL Extractor',
        services: Object.keys(SERVICES),
        note: 'Returns direct CDN URLs without file storage'
    });
});

// Web interface
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>🎯 Direct Video URL Extractor</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f0f2f5; }
        .container { background: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; text-align: center; margin-bottom: 10px; }
        .subtitle { text-align: center; color: #666; margin-bottom: 30px; }
        .input-group { display: flex; gap: 10px; margin-bottom: 20px; }
        input[type="url"] { flex: 1; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 16px; }
        button { padding: 12px 24px; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; }
        button:hover { background: #0056b3; }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        .url-item { background: #f8f9fa; padding: 20px; margin: 10px 0; border-radius: 8px; border-left: 4px solid #007bff; }
        .url-header { display: flex; justify-content: between; align-items: center; margin-bottom: 10px; }
        .url-title { font-weight: bold; color: #333; }
        .url-meta { color: #666; font-size: 0.9em; }
        .direct-url { background: #e9ecef; padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-all; margin: 10px 0; }
        .copy-btn { background: #28a745; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-left: 10px; }
        .copy-btn:hover { background: #1e7e34; }
        .loading { text-align: center; margin: 20px 0; color: #007bff; }
        .error { color: #dc3545; background: #f8d7da; padding: 15px; border-radius: 6px; }
        .success { color: #155724; background: #d4edda; padding: 15px; border-radius: 6px; }
        .note { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 6px; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 Direct Video URL Extractor</h1>
        <p class="subtitle">Get direct CDN download URLs without storing files</p>
        
        <div class="note">
            <strong>💡 How it works:</strong> This tool parses HTML forms from video download services and returns direct CDN URLs (googlevideo.com, fbcdn.net, etc.) that you can use directly for downloading or streaming.
        </div>
        
        <div class="input-group">
            <input type="url" id="videoUrl" placeholder="Enter video URL (YouTube, Instagram, TikTok, etc.)" />
            <button onclick="getDirectUrls()" id="extractBtn">🎯 Extract URLs</button>
        </div>
    </div>
    
    <div id="results"></div>

    <script>
        async function getDirectUrls() {
            const url = document.getElementById('videoUrl').value;
            const resultsDiv = document.getElementById('results');
            const extractBtn = document.getElementById('extractBtn');
            
            if (!url) {
                alert('Please enter a valid URL');
                return;
            }
            
            extractBtn.disabled = true;
            extractBtn.textContent = '🔄 Extracting...';
            
            resultsDiv.innerHTML = '<div class="container"><div class="loading">🔍 Parsing HTML forms and extracting direct URLs...</div></div>';
            
            try {
                const response = await fetch('/api/direct-urls?url=' + encodeURIComponent(url));
                const data = await response.json();
                
                if (data.success && data.downloads.length > 0) {
                    let html = \`<div class="container">
                        <h3>✅ Direct URLs Found (\${data.total} options)</h3>
                        <div class="success">🎉 Extracted from: \${data.services.join(', ')}</div>
                    </div>\`;
                    
                    data.downloads.forEach((item, index) => {
                        html += \`
                            <div class="container">
                                <div class="url-item">
                                    <div class="url-header">
                                        <div class="url-title">\${item.quality} - \${item.format.toUpperCase()} (\${item.type})</div>
                                        <div class="url-meta">📡 \${item.service}</div>
                                    </div>
                                    <div class="direct-url">\${item.directUrl}</div>
                                    <button class="copy-btn" onclick="copyToClipboard('\${item.directUrl}', this)">📋 Copy URL</button>
                                    <a href="\${item.directUrl}" target="_blank" class="copy-btn" style="text-decoration: none; background: #17a2b8;">🔗 Open Direct</a>
                                </div>
                            </div>
                        \`;
                    });
                    
                    resultsDiv.innerHTML = html;
                } else {
                    resultsDiv.innerHTML = '<div class="container"><div class="error">❌ No direct URLs found. The video might be private, unavailable, or the services are temporarily down.</div></div>';
                }
            } catch (error) {
                resultsDiv.innerHTML = '<div class="container"><div class="error">❌ Error: ' + error.message + '</div></div>';
            } finally {
                extractBtn.disabled = false;
                extractBtn.textContent = '🎯 Extract URLs';
            }
        }
        
        async function copyToClipboard(text, button) {
            try {
                await navigator.clipboard.writeText(text);
                const originalText = button.textContent;
                button.textContent = '✅ Copied!';
                button.style.background = '#28a745';
                setTimeout(() => {
                    button.textContent = originalText;
                    button.style.background = '';
                }, 2000);
            } catch (err) {
                alert('Copy failed. Please copy manually.');
            }
        }

        document.getElementById('videoUrl').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                getDirectUrls();
            }
        });
    </script>
</body>
</html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🎯 Direct Video URL Extractor running on port ${PORT}`);
    console.log(`🌐 Web interface: http://localhost:${PORT}`);
    console.log(`📡 API endpoint: http://localhost:${PORT}/api/direct-urls`);
    console.log('💡 Returns direct CDN URLs without file storage');
});

module.exports = app;
