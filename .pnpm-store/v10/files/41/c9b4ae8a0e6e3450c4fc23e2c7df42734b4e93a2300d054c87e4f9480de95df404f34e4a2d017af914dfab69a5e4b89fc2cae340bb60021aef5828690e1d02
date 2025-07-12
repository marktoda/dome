import { validateBody } from './chunk-RSEO4XPX.js';
import { handleError } from './chunk-LF7P5PLR.js';
import { HTTPException } from './chunk-LCM566I4.js';
import { __export } from './chunk-MLKGABMK.js';
import { Readable } from 'stream';

// src/server/handlers/voice.ts
var voice_exports = {};
__export(voice_exports, {
  generateSpeechHandler: () => generateSpeechHandler,
  getListenerHandler: () => getListenerHandler,
  getSpeakersHandler: () => getSpeakersHandler,
  transcribeSpeechHandler: () => transcribeSpeechHandler
});
async function getSpeakersHandler({ mastra, agentId }) {
  try {
    if (!agentId) {
      throw new HTTPException(400, { message: "Agent ID is required" });
    }
    const agent = mastra.getAgent(agentId);
    if (!agent) {
      throw new HTTPException(404, { message: "Agent not found" });
    }
    const voice = await agent.getVoice();
    if (!voice) {
      throw new HTTPException(400, { message: "Agent does not have voice capabilities" });
    }
    const speakers = await voice.getSpeakers();
    return speakers;
  } catch (error) {
    return handleError(error, "Error getting speakers");
  }
}
async function generateSpeechHandler({
  mastra,
  agentId,
  body
}) {
  try {
    if (!agentId) {
      throw new HTTPException(400, { message: "Agent ID is required" });
    }
    validateBody({
      text: body?.text
    });
    const agent = mastra.getAgent(agentId);
    if (!agent) {
      throw new HTTPException(404, { message: "Agent not found" });
    }
    const voice = await agent.getVoice();
    if (!voice) {
      throw new HTTPException(400, { message: "Agent does not have voice capabilities" });
    }
    const audioStream = await voice.speak(body.text, { speaker: body.speakerId });
    if (!audioStream) {
      throw new HTTPException(500, { message: "Failed to generate speech" });
    }
    return audioStream;
  } catch (error) {
    return handleError(error, "Error generating speech");
  }
}
async function transcribeSpeechHandler({
  mastra,
  agentId,
  body
}) {
  try {
    if (!agentId) {
      throw new HTTPException(400, { message: "Agent ID is required" });
    }
    if (!body?.audioData) {
      throw new HTTPException(400, { message: "Audio data is required" });
    }
    const agent = mastra.getAgent(agentId);
    if (!agent) {
      throw new HTTPException(404, { message: "Agent not found" });
    }
    const voice = await agent.getVoice();
    if (!voice) {
      throw new HTTPException(400, { message: "Agent does not have voice capabilities" });
    }
    const audioStream = new Readable();
    audioStream.push(body.audioData);
    audioStream.push(null);
    const text = await voice.listen(audioStream, body.options);
    return { text };
  } catch (error) {
    return handleError(error, "Error transcribing speech");
  }
}
async function getListenerHandler({ mastra, agentId }) {
  try {
    if (!agentId) {
      throw new HTTPException(400, { message: "Agent ID is required" });
    }
    const agent = mastra.getAgent(agentId);
    if (!agent) {
      throw new HTTPException(404, { message: "Agent not found" });
    }
    const voice = await agent.getVoice();
    if (!voice) {
      throw new HTTPException(400, { message: "Agent does not have voice capabilities" });
    }
    const listeners = await voice.getListener();
    return listeners;
  } catch (error) {
    return handleError(error, "Error getting listeners");
  }
}

export { generateSpeechHandler, getListenerHandler, getSpeakersHandler, transcribeSpeechHandler, voice_exports };
