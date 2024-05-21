// Version 1.0.6
const express = require('express');
const path = require('path');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const https = require('https');
const http = require('http');
const geoip = require('geoip-lite');
const macaddress = require('node-macaddress');
const useragent = require('express-useragent');
const app = express();
const detectPort = require('detect-port');

const PORT = 8443; // Default HTTP port
const SSL_PORT = 8445; // Default HTTPS port

// Debugging mode flag
const debugMode = false; // Set to true to enable debugging, false to disable

// Enable or disable conversion flag
const enableConversion = true; // Set to true to enable conversion, false to disable

// Ensure logs directory exists
const logDirectory = path.join(__dirname, 'logs');
if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory);
}

const logFilePath = path.join(logDirectory, 'server.log');

// Clear logs on server start
fs.writeFileSync(logFilePath, '', 'utf-8');

const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

// Middleware to log requests and parse user-agent
app.use(useragent.express());

app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const location = geoip.lookup(ip);
    macaddress.one((err, mac) => {
        const userAgent = req.useragent;

        req.logDetails = {
            dateTime: new Date().toISOString(),
            ip,
            mac: mac || 'N/A',
            location,
            browser: userAgent.browser,
            os: userAgent.os,
            platform: userAgent.platform
        };

        next();
    });
});

// Ensure temp directory exists
const tempDirectory = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDirectory)) {
    fs.mkdirSync(tempDirectory);
}

// Serve static files from the root
app.use(express.static(path.join(__dirname, 'public')));

// Add security headers
app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Serve the index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/info', async (req, res) => {
    try {
        const url = req.query.url;
        if (!ytdl.validateURL(url)) {
            throw new Error('Invalid URL');
        }
        const info = await ytdl.getInfo(url);

        // Filter and deduplicate formats, only include mp4, exclude AV1
        let formats = ytdl.filterFormats(info.formats, format => (format.container === 'mp4' && format.codec !== 'av01'));

        const uniqueFormats = [];
        const seen = new Set();
        formats.forEach(format => {
            if (format.container && format.qualityLabel) {
                const key = `${format.qualityLabel}_${format.container}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    uniqueFormats.push({
                        itag: format.itag,
                        qualityLabel: `${format.container.toUpperCase()} (${format.qualityLabel})`,
                        container: format.container,
                        audioOnly: format.hasAudio && !format.hasVideo
                    });
                }
            }
        });

        // Sort formats by quality from highest to lowest
        uniqueFormats.sort((a, b) => {
            const qualityA = parseInt(a.qualityLabel.match(/\d+/), 10);
            const qualityB = parseInt(b.qualityLabel.match(/\d+/), 10);
            return qualityB - qualityA;
        });

        // Add mp3 options at the bottom
        const videoDuration = info.videoDetails.lengthSeconds;

        uniqueFormats.push({
            itag: 'mp3-320',
            qualityLabel: 'MP3 (320 kbps)',
            container: 'mp3',
            audioOnly: true
        });

        uniqueFormats.push({
            itag: 'mp3-128',
            qualityLabel: 'MP3 (128 kbps)',
            container: 'mp3',
            audioOnly: true
        });

        // Log the details
        const logDetails = req.logDetails;
        logStream.write(`DateTime: ${logDetails.dateTime}, IP: ${logDetails.ip}, MAC: ${logDetails.mac}, Location: ${JSON.stringify(logDetails.location)}, Browser: ${logDetails.browser}, OS: ${logDetails.os}, Platform: ${logDetails.platform}, Fetched URL: ${url}, Title: ${info.videoDetails.title}\n`);

        res.json({
            title: info.videoDetails.title,
            thumbnail: info.videoDetails.thumbnails[0].url,
            formats: uniqueFormats,
            videoUrl: url
        });
    } catch (error) {
        logStream.write(`Failed to fetch video info: ${error.message}\n`);
        res.json({ error: 'Invalid URL or failed to fetch video info. Please try again.' });
    }
});

app.get('/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const id = req.query.id;
    const interval = setInterval(() => {
        const progress = getConversionProgress(id);
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
        if (progress.percent === 100) {
            clearInterval(interval);
            res.end();
        }
    }, 1000);

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

let progressData = {};

function getConversionProgress(id) {
    return progressData[id] || { percent: 0 };
}

function setConversionProgress(id, percent) {
    progressData[id] = { percent };
}

// Download route with progress logging
app.get('/download', async (req, res) => {
    const url = req.query.url;
    const itag = req.query.itag;
    const id = `${Date.now()}`;
    const container = itag.startsWith('mp3') ? 'mp3' : 'mp4';
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9]/g, "_"); // Sanitize title for file name

    // Set initial progress
    setConversionProgress(id, 0);

    if (debugMode) {
        logStream.write(`Starting download for URL: ${url}, itag: ${itag}\n`);
    }

    if (itag.startsWith('mp3')) {
        // Download and convert to MP3
        const audioStream = ytdl(url, { quality: 'highestaudio' });
        const audioBitrate = itag === 'mp3-320' ? 320 : 128;
        const outputTempPath = path.join(tempDirectory, `${title}.${container}`);

        ffmpeg()
            .input(audioStream)
            .audioCodec('libmp3lame')
            .audioBitrate(audioBitrate)
            .output(outputTempPath)
            .on('start', (cmd) => {
                if (debugMode) {
                    logStream.write(`FFmpeg start command: ${cmd}\n`);
                }
            })
            .on('progress', (progress) => {
                if (progress.percent !== undefined) {
                    setConversionProgress(id, progress.percent);
                    if (debugMode) {
                        logStream.write(`FFmpeg progress: ${JSON.stringify(progress)}\n`);
                    }
                }
            })
            .on('stderr', (stderrLine) => {
                if (debugMode) {
                    logStream.write(`FFmpeg stderr: ${stderrLine}\n`);
                }
            })
            .on('error', (error) => {
                if (debugMode) {
                    logStream.write(`FFmpeg error: ${error.message}\n`);
                }
                if (!res.headersSent) {
                    res.status(500).send('Failed to download audio');
                }
            })
            .on('end', () => {
                if (debugMode) {
                    logStream.write(`Finished conversion for URL: ${url}\n`);
                }
                setConversionProgress(id, 100);
                if (debugMode) {
                    logStream.write('Download complete\n');
                }
                res.header('Content-Disposition', `attachment; filename="${title}.${container}"`);
                const readStream = fs.createReadStream(outputTempPath);
                readStream.pipe(res);
                readStream.on('end', () => {
                    fs.unlink(outputTempPath, (err) => {
                        if (err) {
                            logStream.write(`Error deleting temp file: ${err.message}\n`);
                        } else if (debugMode) {
                            logStream.write(`Deleted temp file: ${outputTempPath}\n`);
                        }
                    });
                });
            })
            .run();
    } else {
        // Temporary file paths for video and audio
        const videoTempPath = path.join(tempDirectory, `${title}_video.${container}`);
        const audioTempPath = path.join(tempDirectory, `${title}_audio.${container}`);
        const outputTempPath = path.join(tempDirectory, `${title}.${container}`);

        // Download video and audio streams
        const videoStream = ytdl(url, { filter: format => format.itag == itag && format.container === 'mp4' && format.codec !== 'av01' });
        const audioStream = ytdl(url, { filter: 'audioonly' });

        videoStream.on('progress', (chunkLength, downloaded, total) => {
            const percent = (downloaded / total) * 100;
            setConversionProgress(id, percent);
            if (debugMode) {
                logStream.write(`Converting Video: ${percent.toFixed(2)}%\n`);
            }
        });

        await Promise.all([
            new Promise((resolve, reject) => {
                const stream = videoStream.pipe(fs.createWriteStream(videoTempPath));
                stream.on('finish', resolve);
                stream.on('error', reject);
            }),
            new Promise((resolve, reject) => {
                const stream = audioStream.pipe(fs.createWriteStream(audioTempPath));
                stream.on('finish', resolve);
                stream.on('error', reject);
            })
        ]);

        // Conditionally perform the conversion if enableConversion is true
        if (enableConversion) {
            // Convert the video to MP4 using H.264 encoding and combine with audio
            ffmpeg()
                .input(videoTempPath)
                .videoCodec('libx264')
                .input(audioTempPath)
                .audioCodec('aac')
                .audioBitrate(320) // Set audio bitrate to 320 kbps
                .outputOptions([
                    '-preset ultrafast', // Change to fastest preset
                    '-movflags +faststart',
                    '-threads 2' // Utilize multiple threads for faster processing
                ])
                .output(outputTempPath)
                .on('start', (cmd) => {
                    if (debugMode) {
                        logStream.write(`FFmpeg start command: ${cmd}\n`);
                    }
                })
                .on('progress', (progress) => {
                    if (progress.percent !== undefined) {
                        setConversionProgress(id, progress.percent);
                        if (debugMode) {
                            logStream.write(`FFmpeg progress: ${JSON.stringify(progress)}\n`);
                        }
                    }
                })
                .on('stderr', (stderrLine) => {
                    if (debugMode) {
                        logStream.write(`FFmpeg stderr: ${stderrLine}\n`);
                    }
                })
                .on('error', (error) => {
                    if (debugMode) {
                        logStream.write(`FFmpeg error: ${error.message}\n`);
                    }
                    if (!res.headersSent) {
                        res.status(500).send('Failed to download video');
                    }
                })
                .on('end', () => {
                    if (debugMode) {
                        logStream.write(`Finished conversion for URL: ${url}\n`);
                    }
                    setConversionProgress(id, 100);
                    if (debugMode) {
                        logStream.write('Download complete\n');
                    }
                    res.header('Content-Disposition', `attachment; filename="${title}.${container}"`);
                    const readStream = fs.createReadStream(outputTempPath);
                    readStream.pipe(res);
                    readStream.on('end', () => {
                        // Delete the temporary files after streaming
                        [videoTempPath, audioTempPath, outputTempPath].forEach(filePath => {
                            fs.unlink(filePath, (err) => {
                                if (err) {
                                    logStream.write(`Error deleting temp file: ${err.message}\n`);
                                } else if (debugMode) {
                                    logStream.write(`Deleted temp file: ${filePath}\n`);
                                }
                            });
                        });
                    });
                })
                .run();
        } else {
            // If conversion is disabled, simply send the video file
            res.header('Content-Disposition', `attachment; filename="${title}.${container}"`);
            const readStream = fs.createReadStream(videoTempPath);
            readStream.pipe(res);
            readStream.on('end', () => {
                // Delete the temporary video file after streaming
                fs.unlink(videoTempPath, (err) => {
                    if (err) {
                        logStream.write(`Error deleting temp file: ${err.message}\n`);
                    } else if (debugMode) {
                        logStream.write(`Deleted temp file: ${videoTempPath}\n`);
                    }
                });
            });
        }
    }
});

// Create HTTP server
http.createServer(app).listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
});

// Load SSL certificates
const sslOptions = {
    key: fs.readFileSync('C:/Certbot/live/loader.pixeltv.xyz/privkey.pem'),
    cert: fs.readFileSync('C:/Certbot/live/loader.pixeltv.xyz/fullchain.pem')
};

// Create HTTPS server
https.createServer(sslOptions, app).listen(SSL_PORT, () => {
    console.log(`HTTPS server running on port ${SSL_PORT}`);
});
