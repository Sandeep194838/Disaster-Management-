'use strict';

/**
 * Server-Sent Events (SSE) broadcaster for real-time incident updates.
 * Clients connect to GET /api/events and receive named events.
 */

const express = require('express');
const router = express.Router();

/** @type {Map<string, { res: import('express').Response, userId?: string, role?: string }>} */
const clients = new Map();

let clientIdCounter = 0;

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} eventName - e.g. 'incident:created', 'incident:updated'
 * @param {object} data
 */
function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of clients.entries()) {
    try {
      client.res.write(payload);
    } catch (_err) {
      clients.delete(id);
    }
  }
}

function setupSSE() {
  router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const clientId = String(++clientIdCounter);
    clients.set(clientId, { res });

    // Send initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId, time: new Date().toISOString() })}\n\n`);

    // Keep-alive ping every 25s
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_err) {
        clearInterval(ping);
        clients.delete(clientId);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(ping);
      clients.delete(clientId);
    });
  });

  return router;
}

module.exports = { setupSSE, broadcast };

