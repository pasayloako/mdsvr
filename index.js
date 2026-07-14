const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';

// Create HTTP client
const client = axios.create({
    timeout: 30000,
    maxRedirects: 5
});

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: '*',
    maxAge: 3600
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: true, message: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ==================== Facebook Downloader ====================
class FacebookDownloader {
    constructor(client, url) {
        this.url = url.replace('web.facebook', 'www.facebook');
        this.client = client;
    }

    static getHeaders() {
        return {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Dnt': '1',
            'Dpr': '1.3125',
            'Priority': 'u=0, i',
            'Sec-Ch-Prefers-Color-Scheme': 'dark',
            'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'Sec-Ch-Ua-Full-Version-List': '"Chromium";v="124.0.6367.156", "Google Chrome";v="124.0.6367.156", "Not-A.Brand";v="99.0.0.0"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Model': '""',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Ch-Ua-Platform-Version': '"15.0.0"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Viewport-Width': '1463'
        };
    }

    async get(url) {
        return await this.client.get(url, {
            headers: FacebookDownloader.getHeaders(),
            maxRedirects: 5
        });
    }

    static getNestedValue(data, key) {
        if (typeof data !== 'object' || data === null) return null;
        if (data.hasOwnProperty(key)) return data[key];
        
        for (const value of Object.values(data)) {
            if (typeof value === 'object') {
                const result = FacebookDownloader.getNestedValue(value, key);
                if (result !== null) return result;
            }
        }
        return null;
    }

    static decodeEmbeddedUrl(value) {
        return value
            .replace(/\\\//g, '/')
            .replace(/\\u0025/g, '%')
            .replace(/\\u0026/g, '&')
            .replace(/\\u003d/g, '=')
            .replace(/\\u003D/g, '=')
            .replace(/\\u003f/g, '?')
            .replace(/\\u003F/g, '?')
            .replace(/\\u002f/g, '/')
            .replace(/\\u002F/g, '/')
            .replace(/&amp;/g, '&');
    }

    static collectEmbeddedMediaUrls(html) {
        const normalized = html.replace(/&quot;/g, '"');
        const fields = [
            'browser_native_hd_url',
            'browser_native_sd_url',
            'playable_url_quality_hd',
            'playable_url',
            'hd_src',
            'sd_src',
            'base_url'
        ];

        const urls = new Set();
        for (const field of fields) {
            const pattern = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, 'g');
            let match;
            while ((match = pattern.exec(normalized)) !== null) {
                const url = FacebookDownloader.decodeEmbeddedUrl(match[1]);
                const lower = url.toLowerCase();
                const looksLikeMedia = url.startsWith('http') &&
                    (lower.includes('.mp4') || lower.includes('video') || 
                     lower.includes('fbcdn') || lower.includes('fbsbx'));
                if (looksLikeMedia) urls.add(url);
            }
        }
        return Array.from(urls);
    }

    static collectCombinedMedia(data) {
        const fields = [
            'browser_native_hd_url',
            'browser_native_sd_url',
            'playable_url_quality_hd',
            'playable_url',
            'hd_src',
            'sd_src'
        ];
        const urls = new Set();
        for (const field of fields) {
            const value = FacebookDownloader.getNestedValue(data, field);
            if (value && typeof value === 'string') {
                const url = FacebookDownloader.decodeEmbeddedUrl(value);
                if (url) urls.add(url);
            }
        }
        return Array.from(urls);
    }

    async fetchJson() {
        let currentUrl = this.url;

        if (currentUrl.includes('fb.watch') || currentUrl.includes('/watch/?v')) {
            try {
                const response = await this.get(currentUrl);
                const responseUrl = response.request.res.responseUrl || response.request.responseURL;
                const urlPath = new URL(responseUrl).pathname;
                const segments = urlPath.split('/');
                const videoIndex = segments.indexOf('videos');
                
                if (videoIndex !== -1 && segments[videoIndex + 1]) {
                    currentUrl = `https://www.facebook.com/reel/${segments[videoIndex + 1]}`;
                } else {
                    throw new Error('Video not found');
                }
            } catch (error) {
                throw new Error('Video request failed');
            }
        }

        try {
            const response = await this.get(currentUrl);
            if (response.status !== 200) {
                throw new Error(`Failed to fetch page: ${response.status}`);
            }

            const html = response.data;
            const $ = cheerio.load(html);
            
            let preferredThumbnail = null;
            let browserNativeHdUrl = null;
            let jsonData = null;

            $('script[type="application/json"]').each((i, script) => {
                const scriptText = $(script).text().trim();
                
                if (scriptText.includes('preferred_thumbnail') && !jsonData) {
                    try {
                        const parsed = JSON.parse(scriptText);
                        preferredThumbnail = FacebookDownloader.getNestedValue(parsed, 'preferred_thumbnail');
                        browserNativeHdUrl = FacebookDownloader.getNestedValue(parsed, 'browser_native_hd_url');
                        jsonData = parsed;
                    } catch (e) {}
                }
            });

            let result = null;
            $('script[type="application/json"]').each((i, script) => {
                const scriptText = $(script).text().trim();
                const keywords = ['base_url', 'total_comment_count'];
                
                if (keywords.every(k => scriptText.includes(k))) {
                    try {
                        let parsed = JSON.parse(scriptText);
                        
                        let data = FacebookDownloader.getNestedValue(parsed, 'data');
                        let owner = FacebookDownloader.getNestedValue(parsed, 'owner_as_page') ||
                                   (data ? FacebookDownloader.getNestedValue(data, 'owner') : null);

                        if (data && !(data.title && data.title.text)) {
                            if (data.message && data.message.text) {
                                data.title = { text: data.message.text };
                            }
                        }

                        if (!browserNativeHdUrl) {
                            const representations = FacebookDownloader.getNestedValue(parsed, 'representations');
                            if (representations && Array.isArray(representations)) {
                                const deafMedia = {};
                                for (const rep of representations) {
                                    if (rep.mime_type && rep.mime_type.toLowerCase().includes('video')) {
                                        deafMedia.video_url = rep.base_url || 'N/A';
                                    } else if (rep.mime_type && rep.mime_type.toLowerCase().includes('audio')) {
                                        deafMedia.audio_url = rep.base_url || 'N/A';
                                    }
                                }
                                parsed.deaf_media = deafMedia;
                            }
                        }

                        parsed.data = data || {};
                        parsed.owner = owner || {};
                        parsed.platform = 'facebook';
                        parsed.preferred_thumbnail = preferredThumbnail || {};

                        result = parsed;
                    } catch (e) {}
                }
            });

            if (result) return result;

            const fallbackMedia = FacebookDownloader.collectEmbeddedMediaUrls(html);
            if (fallbackMedia.length > 0) {
                return { fallback_media: fallbackMedia, platform: 'facebook' };
            }

            throw new Error('Video not visible. Open it in Reels and share the link again.');
        } catch (error) {
            if (error.message.includes('Video')) throw error;
            throw new Error(`Request error: ${error.message}`);
        }
    }

    async getData() {
        try {
            const data = await this.fetchJson();
            const out = [];

            const combinedMedia = FacebookDownloader.collectCombinedMedia(data);
            const representations = FacebookDownloader.getNestedValue(data, 'representations');
            const preferredThumbnail = FacebookDownloader.getNestedValue(data, 'preferred_thumbnail');

            if (data.fallback_media && Array.isArray(data.fallback_media)) {
                for (const url of data.fallback_media) {
                    if (!out.includes(url)) out.push(url);
                }
            }

            for (const url of combinedMedia) {
                if (!out.includes(url)) out.push(url);
            }

            if (out.length === 0 && representations && Array.isArray(representations)) {
                let bestVideo = null;
                let bestAudio = null;
                let maxVideoBandwidth = 0;
                let maxAudioBandwidth = 0;

                for (const rep of representations) {
                    if (rep.mime_type && rep.mime_type.includes('video')) {
                        if ((rep.bandwidth || 0) > maxVideoBandwidth) {
                            maxVideoBandwidth = rep.bandwidth || 0;
                            bestVideo = rep;
                        }
                    } else if (rep.mime_type && rep.mime_type.includes('audio')) {
                        if ((rep.bandwidth || 0) > maxAudioBandwidth) {
                            maxAudioBandwidth = rep.bandwidth || 0;
                            bestAudio = rep;
                        }
                    }
                }

                if (bestVideo && bestVideo.base_url) out.push(bestVideo.base_url);
                if (bestAudio && bestAudio.base_url) out.push(`audio===${bestAudio.base_url}`);
            }

            if (preferredThumbnail && preferredThumbnail.image && preferredThumbnail.image.uri) {
                out.push(preferredThumbnail.image.uri);
            }

            return {
                data: out,
                total: out.length,
                platform: 'facebook'
            };
        } catch (error) {
            throw error;
        }
    }
}

// ==================== Routes ====================

// Home route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API route - supports both GET and POST
app.all('/api/', async (req, res) => {
    try {
        let url;
        
        // Get URL from POST body or GET query parameter
        if (req.method === 'POST') {
            url = req.body.url;
        } else {
            url = req.query.url;
        }

        if (!url) {
            return res.status(400).json({
                error: true,
                message: 'URL is required',
                error_message: 'URL is required'
            });
        }

        // Validate Facebook URL
        if (!url.includes('facebook.com') && !url.includes('fb.watch')) {
            return res.status(400).json({
                error: true,
                message: 'Please provide a valid Facebook URL',
                error_message: 'Unsupported URL'
            });
        }

        const fb = new FacebookDownloader(client, url);
        const result = await fb.getData();
        
        return res.json(result);
    } catch (error) {
        console.error('API Error:', error);
        return res.status(502).json({
            error: true,
            message: error.message || 'Failed to fetch content',
            error_message: error.message
        });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: true,
        message: 'Internal server error',
        error_message: err.message
    });
});

// Start server
app.listen(PORT, HOST, () => {
    console.log(`Media Saver API running on http://${HOST}:${PORT}`);
});

module.exports = app;
