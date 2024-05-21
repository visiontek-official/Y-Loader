// Version 1.1.0
document.getElementById('fetch-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const url = document.getElementById('url').value;
    fetchVideoInfo(url);
});

document.getElementById('paste-button').addEventListener('click', function () {
    navigator.clipboard.readText().then(text => {
        document.getElementById('url').value = text;
    });
});

function fetchVideoInfo(url) {
    const loader = document.getElementById('loader');
    const statusText = document.getElementById('status-text');
    loader.style.display = 'block';
    statusText.textContent = 'Fetching video info...';

    fetch(`/info?url=${encodeURIComponent(url)}`)
        .then(response => response.json())
        .then(data => {
            loader.style.display = 'none';
            statusText.textContent = '';
            if (data.error) {
                document.getElementById('error-message').textContent = data.error;
                return;
            }
            document.getElementById('video-info').classList.remove('hidden');
            document.getElementById('thumbnail').src = data.thumbnail;
            document.getElementById('title').textContent = data.title;
            populateFormatOptions(data.formats);
        })
        .catch(error => {
            console.error('Error fetching video info:', error);
            loader.style.display = 'none';
            statusText.textContent = '';
        });
}

function populateFormatOptions(formats) {
    const formatSelect = document.getElementById('format-select');
    formatSelect.innerHTML = '';
    formats.forEach(format => {
        const option = document.createElement('option');
        option.value = format.itag;
        option.textContent = format.qualityLabel;
        formatSelect.appendChild(option);
    });
    document.getElementById('format-options').classList.remove('hidden');
}

document.getElementById('download-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const url = document.getElementById('url').value;
    const itag = document.getElementById('format-select').value;
    const id = Date.now();
    document.getElementById('fetch-form').classList.add('disabled');
    document.getElementById('download-form').classList.add('disabled');
    downloadVideo(url, itag, id);
});

function downloadVideo(url, itag, id) {
    const loader = document.getElementById('loader');
    const statusText = document.getElementById('status-text');
    loader.style.display = 'block';
    statusText.textContent = 'Converting Video...';

    const eventSource = new EventSource(`/progress?id=${id}`);

    eventSource.onmessage = function (event) {
        const progress = JSON.parse(event.data);
        if (progress.percent === 100) {
            statusText.textContent = 'Download Complete!';
            eventSource.close();
            setTimeout(() => {
                window.location.href = '/';
            }, 2000);
        }
    };

    eventSource.onerror = function () {
        eventSource.close();
    };

    fetch(`/download?url=${encodeURIComponent(url)}&itag=${itag}&id=${id}`)
        .then(response => response.blob())
        .then(blob => {
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = downloadUrl;
            const title = document.getElementById('title').textContent.replace(/[^a-zA-Z0-9]/g, "_");
            a.download = `${title}.${itag.startsWith('mp3') ? 'mp3' : 'mp4'}`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(downloadUrl);
            loader.style.display = 'none';
            statusText.textContent = '';
            document.getElementById('fetch-form').classList.remove('disabled');
            document.getElementById('download-form').classList.remove('disabled');
        })
        .catch(error => {
            console.error('Download failed:', error);
            loader.style.display = 'none';
            statusText.textContent = '';
            document.getElementById('fetch-form').classList.remove('disabled');
            document.getElementById('download-form').classList.remove('disabled');
        });
}
