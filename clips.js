'use strict';
window.exhibitClips = (() => {
  function parseTimecode(text) {
    const parts = text.trim().split(':');
    if (parts.length > 3 || !parts.every((part, index) =>
      (index === parts.length - 1 ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/).test(part))) return NaN;
    const values = parts.map(Number);
    if (values.slice(1).some(value => value >= 60)) return NaN;
    return values.reduce((seconds, value) => seconds * 60 + value, 0);
  }

  function formatTimecode(seconds) {
    const milliseconds = Math.round(seconds * 1000);
    const minutes = Math.floor(milliseconds / 60000);
    const remainder = (milliseconds % 60000) / 1000;
    const value = remainder < 10 ? '0' + remainder : String(remainder);
    return minutes + ':' + value;
  }

  function playbackTiles(videos, order) {
    const entries = videos.flatMap(video => {
      const title = video.caption || video.name;
      const full = { id: video.id, video, title, thumbnail: video.thumbnail, align: video.captionAlign };
      const clips = (video.clips || []).map(clip => ({
        id: clip.id, video, clip, thumbnail: clip.thumbnail || video.thumbnail,
        title: clip.caption || title + ' · ' + formatTimecode(clip.start) + '–' + formatTimecode(clip.end),
      }));
      const first = clips[0];
      const combined = first && {
        id: sequenceId(video), video, clip: first.clip, sequence: true, thumbnail: first.thumbnail,
        title: video.sequenceCaption || title + ' · カット版',
      };
      const selections = video.clipMode === 'combined' ? [] : clips;
      if (combined && (video.clipMode === 'combined' || video.clipMode === 'both')) selections.push(combined);
      return video.showFull === false ? selections : [full, ...selections];
    });
    const positions = new Map(order.map((id, index) => [id, index]));
    return entries.sort((a, b) => (positions.get(a.id) ?? order.length) - (positions.get(b.id) ?? order.length));
  }

  const sequenceId = video => video.id + ':cuts';
  const sequenceDuration = clips => clips.reduce((length, clip) => length + clip.end - clip.start, 0);

  function sequencePosition(clips, active, sourceTime) {
    let offset = 0;
    for (const clip of clips) {
      if (clip.id === active?.id) return offset + Math.min(clip.end, Math.max(clip.start, sourceTime)) - clip.start;
      offset += clip.end - clip.start;
    }
    return 0;
  }

  function sequenceSeek(clips, position) {
    let offset = 0;
    for (const [index, clip] of clips.entries()) {
      const length = clip.end - clip.start;
      if (position < offset + length || index === clips.length - 1) {
        return { clip, time: clip.start + Math.min(length, Math.max(0, position - offset)) };
      }
      offset += length;
    }
  }
  return { parseTimecode, formatTimecode, playbackTiles, sequenceId, sequenceDuration, sequencePosition, sequenceSeek };
})();
