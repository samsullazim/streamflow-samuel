const { google } = require('googleapis');
const { encrypt, decrypt } = require('../utils/encryption');
const User = require('../models/User');
const Stream = require('../models/Stream');
const YoutubeChannel = require('../models/YoutubeChannel');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const loggedAlreadyHasBroadcast = new Set();

async function ytRequest(method, url, accessToken, { params = {}, data = null, headers = {} } = {}) {
  const response = await axios({
    method,
    url,
    params,
    data,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      ...headers
    },
    timeout: 60000,
    decompress: false,
    validateStatus: () => true
  });
  if (response.status < 200 || response.status >= 300) {
    const detail = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    throw new Error(`YouTube API ${method.toUpperCase()} ${url} failed ${response.status}: ${detail}`);
  }
  return response.data;
}

async function getValidAccessToken(user, selectedChannel) {
  let accessToken = decrypt(selectedChannel.access_token);
  if (!accessToken) throw new Error('No access token');

  try {
    await ytRequest('get', 'https://youtube.googleapis.com/youtube/v3/channels', accessToken, {
      params: { part: 'id', mine: 'true' }
    });
    return accessToken;
  } catch (err) {
    if (!err.message.includes('401') && !err.message.includes('UNAUTHENTICATED')) throw err;

    console.log('[YouTubeService] Access token expired, refreshing...');
    const clientSecret = decrypt(user.youtube_client_secret);
    const refreshToken = decrypt(selectedChannel.refresh_token);
    if (!refreshToken) throw new Error('No refresh token available — reconnect YouTube');

    const refreshResponse = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: user.youtube_client_id,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Accept-Encoding': 'identity'
      },
      timeout: 30000,
      decompress: false,
      validateStatus: () => true
    });

    if (refreshResponse.status < 200 || refreshResponse.status >= 300) {
      throw new Error(`Token refresh failed ${refreshResponse.status}: ${JSON.stringify(refreshResponse.data)}`);
    }

    accessToken = refreshResponse.data.access_token;
    await YoutubeChannel.update(selectedChannel.id, {
      access_token: encrypt(accessToken)
    });

    if (refreshResponse.data.refresh_token) {
      await YoutubeChannel.update(selectedChannel.id, {
        refresh_token: encrypt(refreshResponse.data.refresh_token)
      });
    }

    console.log('[YouTubeService] Access token refreshed successfully');
    return accessToken;
  }
}

function getYouTubeOAuth2Client(clientId, clientSecret, redirectUri) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function omitUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

async function syncBroadcastMonetization(accessToken, broadcastId, enabled) {
  const broadcastData = await ytRequest('get', 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts', accessToken, {
    params: { part: 'id,snippet,contentDetails,status,monetizationDetails', id: broadcastId }
  });

  const currentBroadcast = broadcastData.items?.[0];
  if (!currentBroadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  const currentSnippet = currentBroadcast.snippet || {};
  const currentContentDetails = currentBroadcast.contentDetails || {};
  const currentStatus = currentBroadcast.status || {};
  const currentMonitorStream = currentContentDetails.monitorStream || {};
  const monitorStream = omitUndefined({
    enableMonitorStream: currentMonitorStream.enableMonitorStream,
    broadcastStreamDelayMs:
      currentMonitorStream.enableMonitorStream !== undefined
        ? currentMonitorStream.broadcastStreamDelayMs ?? 0
        : undefined
  });

  const requestBody = {
    id: broadcastId,
    snippet: omitUndefined({
      title: currentSnippet.title,
      description: currentSnippet.description || '',
      scheduledStartTime: currentSnippet.scheduledStartTime,
      scheduledEndTime: currentSnippet.scheduledEndTime
    }),
    contentDetails: omitUndefined({
      boundStreamId: currentContentDetails.boundStreamId,
      enableAutoStart: currentContentDetails.enableAutoStart,
      enableAutoStop: currentContentDetails.enableAutoStop,
      enableClosedCaptions: currentContentDetails.enableClosedCaptions,
      enableContentEncryption: currentContentDetails.enableContentEncryption,
      enableDvr: currentContentDetails.enableDvr,
      enableEmbed: currentContentDetails.enableEmbed,
      latencyPreference: currentContentDetails.latencyPreference,
      projection: currentContentDetails.projection,
      recordFromStart: currentContentDetails.recordFromStart,
      startWithSlate: currentContentDetails.startWithSlate,
      monitorStream: Object.keys(monitorStream).length > 0 ? monitorStream : undefined
    }),
    status: omitUndefined({
      privacyStatus: currentStatus.privacyStatus,
      selfDeclaredMadeForKids: currentStatus.selfDeclaredMadeForKids
    }),
    monetizationDetails: enabled
      ? {
          adsMonetizationStatus: 'ON',
          cuepointSchedule: {
            enabled: true,
            ytOptimizedCuepointConfig: 'MEDIUM'
          }
        }
      : {
          adsMonetizationStatus: 'OFF'
        }
  };

  await ytRequest('put', 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts', accessToken, {
    params: { part: 'id,snippet,contentDetails,status,monetizationDetails' },
    data: requestBody,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function createYouTubeBroadcast(streamId, baseUrl) {
  const stream = await Stream.findById(streamId);
  if (!stream) {
    throw new Error('Stream not found');
  }

  if (!stream.is_youtube_api) {
    return { success: true, message: 'Not a YouTube API stream' };
  }

  if (stream.youtube_broadcast_id && stream.rtmp_url && stream.stream_key) {
    if (!loggedAlreadyHasBroadcast.has(streamId)) {
      console.log(`[YouTubeService] Stream ${streamId} already has YouTube broadcast, skipping creation`);
      loggedAlreadyHasBroadcast.add(streamId);
    }
    return { 
      success: true, 
      rtmpUrl: stream.rtmp_url, 
      streamKey: stream.stream_key,
      broadcastId: stream.youtube_broadcast_id,
      streamId: stream.youtube_stream_id
    };
  }

  const user = await User.findById(stream.user_id);
  if (!user || !user.youtube_client_id || !user.youtube_client_secret) {
    throw new Error('YouTube API credentials not configured');
  }

  const selectedChannel = await YoutubeChannel.findById(stream.youtube_channel_id);
  if (!selectedChannel || !selectedChannel.access_token || !selectedChannel.refresh_token) {
    throw new Error('YouTube channel not found or not connected');
  }

  const clientSecret = decrypt(user.youtube_client_secret);
  const accessToken = await getValidAccessToken(user, selectedChannel);
  const refreshToken = decrypt(selectedChannel.refresh_token);

  if (!clientSecret || !accessToken) {
    throw new Error('Failed to decrypt YouTube credentials');
  }

  const redirectUri = `${baseUrl}/auth/youtube/callback`;
  const oauth2Client = getYouTubeOAuth2Client(user.youtube_client_id, clientSecret, redirectUri);
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await YoutubeChannel.update(selectedChannel.id, {
        access_token: encrypt(tokens.access_token)
      });
    }
    if (tokens.refresh_token) {
      await YoutubeChannel.update(selectedChannel.id, {
        refresh_token: encrypt(tokens.refresh_token)
      });
    }
  });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const tagsArray = stream.youtube_tags ? stream.youtube_tags.split(',').map(t => t.trim()).filter(t => t) : [];

  const broadcastSnippet = {
    title: stream.title,
    description: stream.youtube_description || '',
    scheduledStartTime: new Date().toISOString()
  };

  console.log(`[YouTubeService] Creating YouTube broadcast for stream ${streamId}`);

  let broadcastResponse;
  const broadcastData = {
    snippet: broadcastSnippet,
    contentDetails: {
      enableAutoStart: true,
      enableAutoStop: true,
      monitorStream: {
        enableMonitorStream: false
      }
    },
    status: {
      privacyStatus: stream.youtube_privacy || 'unlisted',
      selfDeclaredMadeForKids: false
    }
  };

  broadcastResponse = await ytRequest('post', 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts', accessToken, {
    params: { part: 'snippet,contentDetails,status' },
    data: broadcastData,
    headers: { 'Content-Type': 'application/json' }
  });

  const broadcast = broadcastResponse;
  console.log(`[YouTubeService] Created broadcast: ${broadcast.id}`);

  if (stream.youtube_monetization) {
    try {
      await syncBroadcastMonetization(accessToken, broadcast.id, true);
      console.log(`[YouTubeService] Enabled monetization for broadcast ${broadcast.id}`);
    } catch (monetizationError) {
      console.warn(`[YouTubeService] Failed to enable monetization for broadcast ${broadcast.id}. Continuing without monetization. Error: ${monetizationError.message}`);
      await Stream.update(streamId, { youtube_monetization: false });
    }
  }

  if (tagsArray.length > 0 || stream.youtube_category) {
    try {
      const videoResponse = await ytRequest('get', 'https://youtube.googleapis.com/youtube/v3/videos', accessToken, {
        params: { part: 'snippet', id: broadcast.id }
      });

      if (videoResponse.items && videoResponse.items.length > 0) {
        const currentSnippet = videoResponse.items[0].snippet;
        await ytRequest('put', 'https://youtube.googleapis.com/youtube/v3/videos', accessToken, {
          params: { part: 'snippet' },
          data: {
            id: broadcast.id,
            snippet: {
              title: stream.title,
              description: stream.youtube_description || '',
              categoryId: stream.youtube_category || '22',
              tags: tagsArray.length > 0 ? tagsArray : currentSnippet.tags,
              defaultLanguage: currentSnippet.defaultLanguage,
              defaultAudioLanguage: currentSnippet.defaultAudioLanguage
            }
          },
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (updateError) {
      console.log('[YouTubeService] Note: Could not update video metadata:', updateError.message);
    }
  }

  if (stream.youtube_thumbnail) {
    try {
      const projectRoot = path.resolve(__dirname, '..');
      const thumbnailPath = path.join(projectRoot, 'public', stream.youtube_thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        const form = new FormData();
        form.append('media', fs.createReadStream(thumbnailPath));
        await ytRequest('post', 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set', accessToken, {
          params: { videoId: broadcast.id },
          data: form,
          headers: form.getHeaders()
        });
        console.log(`[YouTubeService] Uploaded thumbnail for broadcast ${broadcast.id}`);
      }
    } catch (thumbError) {
      console.log('[YouTubeService] Note: Could not upload thumbnail:', thumbError.message);
    }
  }

  const liveStream = await ytRequest('post', 'https://youtube.googleapis.com/youtube/v3/liveStreams', accessToken, {
    params: { part: 'snippet,cdn,contentDetails,status' },
    data: {
      snippet: {
        title: `${stream.title} - Stream`
      },
      cdn: {
        frameRate: '30fps',
        ingestionType: 'rtmp',
        resolution: '1080p'
      },
      contentDetails: {
        isReusable: false
      }
    },
    headers: { 'Content-Type': 'application/json' }
  });
  console.log(`[YouTubeService] Created live stream: ${liveStream.id}`);

  await ytRequest('post', 'https://youtube.googleapis.com/youtube/v3/liveBroadcasts/bind', accessToken, {
    params: { part: 'id,contentDetails', id: broadcast.id, streamId: liveStream.id },
    data: {},
    headers: { 'Content-Type': 'application/json' }
  });

  const rtmpUrl = liveStream.cdn.ingestionInfo.ingestionAddress;
  const streamKey = liveStream.cdn.ingestionInfo.streamName;

  await Stream.update(streamId, {
    youtube_broadcast_id: broadcast.id,
    youtube_stream_id: liveStream.id,
    rtmp_url: rtmpUrl,
    stream_key: streamKey
  });

  console.log(`[YouTubeService] YouTube broadcast created successfully for stream ${streamId}`);

  return {
    success: true,
    broadcastId: broadcast.id,
    streamId: liveStream.id,
    rtmpUrl: rtmpUrl,
    streamKey: streamKey
  };
}

async function deleteYouTubeBroadcast(streamId) {
  try {
    loggedAlreadyHasBroadcast.delete(streamId);
    
    const stream = await Stream.findById(streamId);
    if (!stream || !stream.is_youtube_api || !stream.youtube_broadcast_id) {
      return { success: true, message: 'No YouTube broadcast to clean up' };
    }

    await Stream.update(streamId, {
      rtmp_url: '',
      stream_key: ''
    });

    console.log(`[YouTubeService] Cleared RTMP credentials for stream ${streamId} (broadcast ID kept for YouTube Studio access)`);

    return { success: true };
  } catch (error) {
    console.error('[YouTubeService] Error clearing YouTube broadcast data:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  createYouTubeBroadcast,
  deleteYouTubeBroadcast,
  getYouTubeOAuth2Client,
  syncBroadcastMonetization,
  getValidAccessToken,
  ytRequest
};
