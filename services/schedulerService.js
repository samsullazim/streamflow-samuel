const Stream = require('../models/Stream');

const scheduledTerminations = new Map();
const randomStartOffsets = new Map();
const SCHEDULE_CHECK_INTERVAL = 15000;
const DURATION_CHECK_INTERVAL = 30000;

let streamingService = null;
let initialized = false;
let scheduleIntervalId = null;
let durationIntervalId = null;

function init(streamingServiceInstance) {
  if (initialized) {
    return;
  }

  streamingService = streamingServiceInstance;
  streamingService.setSchedulerService(module.exports);
  initialized = true;

  scheduleIntervalId = setInterval(checkScheduledStreams, SCHEDULE_CHECK_INTERVAL);
  durationIntervalId = setInterval(checkStreamDurations, DURATION_CHECK_INTERVAL);

  checkScheduledStreams();
  checkStreamDurations();
}

async function checkScheduledStreams() {
  try {
    if (!streamingService) {
      return;
    }

    const now = new Date();
    const streams = await Stream.findScheduledInRange(null, now);

    for (const stream of streams) {
      if (streamingService.isStreamActive(stream.id) || streamingService.isStreamStarting(stream.id)) {
        continue;
      }

      const currentStream = await Stream.findById(stream.id);
      if (!currentStream || currentStream.status !== 'scheduled') {
        continue;
      }

      // Random start offset: if stream has random_start_max > 0,
      // generate a random delay (0 to random_start_max minutes) once,
      // and wait until schedule_time + delay before starting.
      if (currentStream.random_start_max && currentStream.random_start_max > 0) {
        if (!randomStartOffsets.has(stream.id)) {
          const offsetMs = Math.floor(Math.random() * (currentStream.random_start_max * 60 * 1000));
          randomStartOffsets.set(stream.id, { offsetMs, calculatedAt: Date.now() });
          const offsetMin = (offsetMs / 60000).toFixed(1);
          console.log(`[Scheduler] Stream ${stream.id}: random start offset = ${offsetMin} min (max ${currentStream.random_start_max} min)`);
        }

        const { offsetMs } = randomStartOffsets.get(stream.id);
        const scheduleTime = new Date(currentStream.schedule_time).getTime();
        const actualStartTime = scheduleTime + offsetMs;

        if (Date.now() < actualStartTime) {
          continue; // Not time yet, wait for next check
        }

        // Time to start — clean up the offset entry
        randomStartOffsets.delete(stream.id);
      }

      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      const result = await streamingService.startStream(stream.id, false, baseUrl);

      if (!result.success) {
        console.error(`[Scheduler] Failed to start stream ${stream.id}: ${result.error}`);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking scheduled streams:', error);
  }
}

async function checkStreamDurations() {
  try {
    if (!streamingService) {
      return;
    }

    const liveStreams = await Stream.findAll(null, 'live');

    for (const stream of liveStreams) {
      if (!stream.end_time) {
        continue;
      }

      // Random duration extension: if stream has random_duration_max > 0
      // and hasn't been extended yet, add a random extension to end_time once.
      if (stream.random_duration_max && stream.random_duration_max > 0) {
        const extensionKey = `duration_extended_${stream.id}`;
        if (!randomStartOffsets.has(extensionKey)) {
          const extensionMs = Math.floor(Math.random() * (stream.random_duration_max * 60 * 1000));
          randomStartOffsets.set(extensionKey, { offsetMs: extensionMs, calculatedAt: Date.now() });

          const currentEnd = new Date(stream.end_time);
          const newEnd = new Date(currentEnd.getTime() + extensionMs);
          const extMin = (extensionMs / 60000).toFixed(1);
          console.log(`[Scheduler] Stream ${stream.id}: random duration extension = +${extMin} min (max ${stream.random_duration_max} min). New end_time: ${newEnd.toISOString()}`);

          await Stream.update(stream.id, { end_time: newEnd.toISOString() });
          stream.end_time = newEnd.toISOString();
        }
      }

      const endTime = new Date(stream.end_time);
      const now = new Date();
      const timeUntilEnd = endTime.getTime() - now.getTime();

      if (timeUntilEnd <= 0) {
        scheduledTerminations.delete(stream.id);

        try {
          await streamingService.stopStream(stream.id);
        } catch (e) {
          await Stream.updateStatus(stream.id, 'offline', stream.user_id);
        }
      } else if (timeUntilEnd <= 60000 && !scheduledTerminations.has(stream.id)) {
        scheduleStreamTermination(stream.id, timeUntilEnd / 60000, stream.user_id);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking stream durations:', error);
  }
}

function scheduleStreamTermination(streamId, durationMinutes, userId = null) {
  if (!streamingService) {
    return;
  }

  if (typeof durationMinutes !== 'number' || Number.isNaN(durationMinutes) || durationMinutes < 0) {
    return;
  }

  if (scheduledTerminations.has(streamId)) {
    const existing = scheduledTerminations.get(streamId);
    if (existing.timeoutId) {
      clearTimeout(existing.timeoutId);
    }
  }

  const durationMs = Math.max(0, durationMinutes * 60 * 1000);
  const targetEndTime = Date.now() + durationMs;

  const timeoutId = setTimeout(async () => {
    try {
      const stream = await Stream.findById(streamId);
      if (!stream || stream.status !== 'live') {
        scheduledTerminations.delete(streamId);
        return;
      }

      await streamingService.stopStream(streamId);
      scheduledTerminations.delete(streamId);
    } catch (error) {
      scheduledTerminations.delete(streamId);
    }
  }, durationMs);

  scheduledTerminations.set(streamId, {
    timeoutId,
    targetEndTime,
    userId
  });
}

function cancelStreamTermination(streamId) {
  if (scheduledTerminations.has(streamId)) {
    const scheduled = scheduledTerminations.get(streamId);
    if (scheduled.timeoutId) {
      clearTimeout(scheduled.timeoutId);
    }
    scheduledTerminations.delete(streamId);
    return true;
  }
  return false;
}

function getScheduledTermination(streamId) {
  const scheduled = scheduledTerminations.get(streamId);
  if (!scheduled) return null;

  return {
    streamId,
    targetEndTime: scheduled.targetEndTime,
    remainingMs: scheduled.targetEndTime ? scheduled.targetEndTime - Date.now() : null
  };
}

function handleStreamStopped(streamId) {
  // Clean up random duration extension flag
  randomStartOffsets.delete(`duration_extended_${streamId}`);
  return cancelStreamTermination(streamId);
}

function shutdown() {
  if (scheduleIntervalId) {
    clearInterval(scheduleIntervalId);
  }
  if (durationIntervalId) {
    clearInterval(durationIntervalId);
  }

  for (const [streamId, scheduled] of scheduledTerminations) {
    if (scheduled.timeoutId) {
      clearTimeout(scheduled.timeoutId);
    }
  }
  scheduledTerminations.clear();
  randomStartOffsets.clear();
}

module.exports = {
  init,
  scheduleStreamTermination,
  cancelStreamTermination,
  getScheduledTermination,
  handleStreamStopped,
  checkScheduledStreams,
  checkStreamDurations,
  shutdown
};
