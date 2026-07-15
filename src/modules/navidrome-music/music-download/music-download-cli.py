#!/usr/bin/env python3
"""CLI wrapper for jukebox music download tools.

Usage:
    music-download-cli.py search <query-or-url>
    music-download-cli.py download <query-or-url>
    music-download-cli.py library
    music-download-cli.py delete <file_path>

Accepts either a YouTube URL (youtube.com/watch?v=..., youtu.be/..., youtube.com/shorts/...)
or a free-text search query. URLs are passed directly to yt-dlp; text queries use
ytsearch1: prefix.

Outputs JSON lines to stdout. Progress updates use {"type":"progress",...},
final results use {"type":"result",...}.
"""

import json
import os
import re
import sys
from pathlib import Path

# Import from nanobot-tools — use its venv which has yt-dlp, tinydb, etc.
NANOBOT_TOOLS = Path('/home/ubuntu/.nanobot/workspace/services/nanobot-tools')
sys.path.insert(0, str(NANOBOT_TOOLS))

# Ensure DOWNLOAD_PATH points to the ytdl folder
os.environ.setdefault('DOWNLOAD_PATH', '/path/navidrome/music/ytdl')

import yt_dlp  # noqa: E402  (after sys.path mutation)
from tools.jukebox import (  # noqa: E402
    _get_youtube_info,
    _is_single_song,
    _download_and_store_track,
    _search_library_by_metadata,
    _cleanup_missing_files,
    YT_DLP_BASE_OPTS,
    db,
    download_path,
)


# Match youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID
YOUTUBE_URL_RE = re.compile(
    r'^(https?://)?(www\.|m\.)?'
    r'(youtube\.com/(watch\?v=|shorts/|embed/)|youtu\.be/)[\w-]+',
    re.IGNORECASE,
)


def emit(obj):
    """Write a JSON line to stdout (flush immediately for subprocess consumption)."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def is_youtube_url(s: str) -> bool:
    """True if the string looks like a YouTube URL."""
    return bool(YOUTUBE_URL_RE.match((s or '').strip()))


def cmd_resolve(query: str):
    """Resolve a YouTube URL or text query to a video info dict.

    Returns (info, error_message) — info is None on failure and error_message
    is set to a human-readable string suitable for surfacing in the UI.
    """
    is_url = is_youtube_url(query)
    if is_url:
        with yt_dlp.YoutubeDL({**YT_DLP_BASE_OPTS, 'extract_flat': False}) as ydl:
            try:
                info = ydl.extract_info(query.strip(), download=False)
                if info:
                    return info, None
                return None, f'No data returned for URL: {query}'
            except Exception as e:
                return None, str(e)
    # Free-text query: delegate to jukebox's ytsearch1 wrapper
    info = _get_youtube_info(query)
    if not info:
        return None, f'No search results for: {query}'
    return info, None


def cmd_search(query):
    """Search YouTube (or fetch direct URL info) and return top result info."""
    emit({'type': 'progress', 'stage': 'searching', 'percent': 5})

    info, err = cmd_resolve(query)
    if not info:
        emit({'type': 'result', 'success': False, 'error': err or 'Resolution failed'})
        return

    is_song = _is_single_song(info)
    existing = _search_library_by_metadata(
        info.get('title', ''), info.get('uploader', '')
    ) if is_song else None

    data = {
        'title': info.get('title', ''),
        'uploader': info.get('uploader', ''),
        'duration': info.get('duration', 0),
        'durationFormatted': _fmt_duration(info.get('duration', 0)),
        'thumbnail': info.get('thumbnail', ''),
        'webpage_url': info.get('webpage_url', ''),
        'isSingleSong': is_song,
        'alreadyInLibrary': existing is not None,
    }
    if existing:
        data['existingTrack'] = {
            'title': existing.get('title', ''),
            'artist': existing.get('artist', ''),
            'filePath': existing.get('file_path', ''),
        }

    emit({'type': 'progress', 'stage': 'done', 'percent': 100})
    emit({'type': 'result', 'success': True, 'data': data})


def cmd_download(query):
    """Download a song with progress reporting. Accepts URL or text query."""
    emit({'type': 'progress', 'stage': 'searching', 'percent': 5})

    info, err = cmd_resolve(query)
    if not info:
        emit({'type': 'result', 'success': False, 'error': err or 'Resolution failed'})
        return

    emit({'type': 'progress', 'stage': 'validating', 'percent': 10})

    if not _is_single_song(info):
        emit({'type': 'result', 'success': False,
              'error': f"Blocked — appears to be a compilation/album, not a single song: {info.get('title', '')}"})
        return

    existing = _search_library_by_metadata(
        info.get('title', ''), info.get('uploader', '')
    )
    if existing:
        emit({'type': 'result', 'success': True,
              'data': {
                  'status': 'already_exists',
                  'title': existing.get('title', ''),
                  'artist': existing.get('artist', ''),
                  'filePath': existing.get('file_path', ''),
              }})
        return

    emit({'type': 'progress', 'stage': 'downloading', 'percent': 15, 'title': info.get('title', '')})

    try:
        result_text = _download_and_store_track(info, query)
    except Exception as e:
        error_msg = str(e)
        if 'Sign in to confirm you' in error_msg or 'not a bot' in error_msg:
            error_msg = 'YouTube requires authentication. Please configure Firefox cookies or try again later.'
        elif 'HTTP Error 403' in error_msg or '403: Forbidden' in error_msg:
            error_msg = 'YouTube access denied (possibly rate limiting or bot detection). Try again in a few minutes.'
        elif 'format is not available' in error_msg.lower():
            error_msg = 'YouTube refused to return audio formats for this video. Try a different video.'
        emit({'type': 'progress', 'stage': 'failed', 'percent': 0, 'title': info.get('title', '')})
        emit({'type': 'result', 'success': False, 'error': error_msg})
        return

    # Success — extract track data from the database
    filename = ''
    if 'File saved as:' in result_text:
        for line in result_text.split('\n'):
            if 'File saved as:' in line:
                filename = line.split('File saved as:')[1].strip()

    track = None
    if filename:
        from tools.jukebox import Track as TrackQuery
        matches = db.search(TrackQuery.file_path.test(lambda p: Path(p).name == filename or p == filename))
        if matches:
            track = matches[0]

    emit({'type': 'progress', 'stage': 'completed', 'percent': 100, 'title': info.get('title', '')})

    data = {
        'status': 'downloaded',
        'title': track.get('title', info.get('title', '')) if track else info.get('title', ''),
        'artist': track.get('artist', info.get('uploader', '')) if track else info.get('uploader', ''),
        'album': track.get('album', '') if track else '',
        'genre': track.get('genre', '') if track else '',
        'year': track.get('year', '') if track else '',
        'filePath': track.get('file_path', '') if track else '',
        'fileName': Path(track.get('file_path', filename)).name if track else filename,
        'duration': track.get('duration', info.get('duration', 0)) if track else info.get('duration', 0),
        'resultText': result_text,
    }
    emit({'type': 'result', 'success': True, 'data': data})


def cmd_library():
    """List all tracks in the TinyDB library."""
    _cleanup_missing_files()
    tracks = db.all()

    result = []
    for t in tracks:
        result.append({
            'title': t.get('title', ''),
            'artist': t.get('artist', ''),
            'album': t.get('album', ''),
            'genre': t.get('genre', ''),
            'year': t.get('year', ''),
            'duration': t.get('duration', 0),
            'durationFormatted': _fmt_duration(t.get('duration', 0)),
            'filePath': t.get('file_path', ''),
            'fileName': Path(t.get('file_path', '')).name,
            'downloadDate': t.get('download_date', ''),
            'youtubeUrl': t.get('youtube_url', ''),
        })

    emit({'type': 'result', 'success': True, 'data': result})


def cmd_delete(file_path):
    """Delete a track from library and disk."""
    from tools.jukebox import Track as TrackQuery

    abs_path = Path(file_path)
    if not abs_path.is_absolute():
        abs_path = download_path / file_path
    abs_path = abs_path.resolve()

    # Verify path is within download directory
    try:
        abs_path.relative_to(download_path.resolve())
    except ValueError:
        emit({'type': 'result', 'success': False, 'error': 'Path outside download directory'})
        return

    # Remove from database
    matches = db.search(TrackQuery.file_path == str(abs_path))
    if matches:
        db.remove(doc_ids=[matches[0].doc_id])

    # Delete file
    deleted = False
    if abs_path.exists():
        abs_path.unlink()
        deleted = True

    emit({'type': 'result', 'success': True, 'data': {'deleted': deleted, 'path': str(abs_path)}})


def _fmt_duration(seconds):
    """Format seconds as M:SS."""
    if not seconds:
        return '0:00'
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f'{m}:{s:02d}'


def main():
    if len(sys.argv) < 2:
        emit({'type': 'result', 'success': False, 'error': 'Usage: music-download-cli.py <command> [args]'})
        sys.exit(1)

    command = sys.argv[1].lower()

    if command == 'search':
        if len(sys.argv) < 3:
            emit({'type': 'result', 'success': False, 'error': 'Missing query argument'})
            sys.exit(1)
        cmd_search(' '.join(sys.argv[2:]))

    elif command == 'download':
        if len(sys.argv) < 3:
            emit({'type': 'result', 'success': False, 'error': 'Missing query argument'})
            sys.exit(1)
        cmd_download(' '.join(sys.argv[2:]))

    elif command == 'library':
        cmd_library()

    elif command == 'delete':
        if len(sys.argv) < 3:
            emit({'type': 'result', 'success': False, 'error': 'Missing file_path argument'})
            sys.exit(1)
        cmd_delete(sys.argv[2])

    else:
        emit({'type': 'result', 'success': False, 'error': f'Unknown command: {command}'})


if __name__ == '__main__':
    main()
